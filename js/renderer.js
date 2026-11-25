/*
 * SVG diagram renderer with drag, pan, zoom, hover highlighting, tooltips and export.
 */
(function (root) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const M = { headerH: 38, rowH: 28, padX: 12, iconW: 20, gap: 28, minW: 190, radius: 8 };
  const C = {
    header: '#2F5D8A', body: '#FFFFFF', alt: '#F7F9FB', border: '#D3DCE6', sep: '#EDF1F5',
    name: '#1F2933', type: '#6B7785', enumType: '#8E44AD', pk: '#D4A017', fk: '#2F80ED',
    ref: '#8E9BAE', note: '#9AA5B1',
  };

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function text(parent, x, y, str, attrs) {
    const t = el('text', Object.assign({ x, y, 'dominant-baseline': 'central', 'font-family': FONT }, attrs), parent);
    t.textContent = str;
    return t;
  }

  let ctx2d;
  function textW(s, font) {
    ctx2d = ctx2d || document.createElement('canvas').getContext('2d');
    ctx2d.font = font;
    return ctx2d.measureText(s).width;
  }

  function readable(hex) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
    const n = parseInt(full, 16);
    if (Number.isNaN(n)) return '#fff';
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? '#1F2933' : '#FFFFFF';
  }

  function tableTitle(t) { return t.schema && t.schema !== 'public' ? `${t.schema}.${t.name}` : t.name; }

  // Rows shown for a table: every column, or only key columns in compact mode.
  function displayRows(t, compact) {
    if (!compact) return { rows: t.columns, hidden: 0 };
    const rows = t.columns.filter((c) => c.pk || c.fk);
    return { rows, hidden: t.columns.length - rows.length };
  }

  function measureTables(model, compact) {
    const sizes = {};
    for (const t of model.tables) {
      let w = textW(tableTitle(t), `600 14px ${FONT}`) + M.padX * 2 + (t.note ? 22 : 0);
      for (const c of t.columns) {
        w = Math.max(w, M.padX + M.iconW + textW(c.name, `${c.pk ? 600 : 400} 13px ${FONT}`) + (c.note ? 12 : 0) +
          M.gap + textW(c.type, `12px ${MONO}`) + M.padX);
      }
      const { rows, hidden } = displayRows(t, compact);
      sizes[t.key] = { w: Math.ceil(Math.max(M.minW, w)), h: M.headerH + Math.max(1, rows.length + (hidden ? 1 : 0)) * M.rowH };
    }
    return sizes;
  }

  function roundedPath(pts, r) {
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i - 1], c = pts[i], n = pts[i + 1];
      const d1 = Math.hypot(c.x - p.x, c.y - p.y), d2 = Math.hypot(n.x - c.x, n.y - c.y);
      const rr = Math.min(r, d1 / 2, d2 / 2);
      if (rr < 0.5) { d += ` L${c.x},${c.y}`; continue; }
      const a = { x: c.x + ((p.x - c.x) / d1) * rr, y: c.y + ((p.y - c.y) / d1) * rr };
      const b = { x: c.x + ((n.x - c.x) / d2) * rr, y: c.y + ((n.y - c.y) / d2) * rr };
      d += ` L${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`;
    }
    const last = pts[pts.length - 1];
    return d + ` L${last.x},${last.y}`;
  }

  function marker(x, y, dir, relation) {
    if (relation === '*') {
      const tip = x + dir * 13;
      return `M${tip},${y} L${x},${y - 7} M${tip},${y} L${x},${y} M${tip},${y} L${x},${y + 7}`;
    }
    const bx = x + dir * 9;
    return `M${bx},${y - 6} L${bx},${y + 6}`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  class Diagram {
    constructor(container, opts) {
      this.container = container;
      this.opts = opts || {};
      this.model = null;
      this.positions = {};
      this.view = { x: 40, y: 40, k: 1 };
      this.selected = null;
      this.visible = null;      // Set of table keys to draw, or null for all
      this.keysOnly = false;    // compact rows on demand
      this.compact = false;     // effective compact state (keysOnly or zoomed out)
      this.compactBelow = 0.5;  // zoom level under which tables collapse to key columns
      this.grid = 22;           // snap size, matches the dotted background

      this.svg = el('svg', { class: 'diagram', xmlns: NS }, container);
      const defs = el('defs', null, this.svg);
      const f = el('filter', { id: 'dbml-shadow', x: '-10%', y: '-10%', width: '120%', height: '130%' }, defs);
      el('feDropShadow', { dx: 0, dy: 2, stdDeviation: 3, 'flood-color': '#1F2933', 'flood-opacity': 0.12 }, f);
      this.viewport = el('g', { class: 'viewport' }, this.svg);
      this.gGroups = el('g', { class: 'groups' }, this.viewport);
      this.gRefs = el('g', { class: 'refs' }, this.viewport);
      this.gTables = el('g', { class: 'tables' }, this.viewport);

      this.tip = document.createElement('div');
      this.tip.className = 'tooltip';
      container.appendChild(this.tip);

      this.mini = document.createElement('div');
      this.mini.className = 'minimap';
      this.mini.setAttribute('aria-label', 'Minimap — click or drag to move the view');
      this.miniSvg = el('svg', { width: '100%', height: '100%' }, this.mini);
      container.appendChild(this.mini);
      this.bindMinimap();

      this.bind();
      this.applyView();
    }

    // ------------------------------------------------------------ rendering
    setModel(model, positions) {
      this.model = model;
      this.positions = positions;
      this.tables = new Map(model.tables.map((t) => [t.key, t]));
      this.enums = new Map(model.enums.map((e) => [e.key, e]));
      if (this.selected && !this.tables.has(this.selected)) this.selected = null;
      if (this.visible) this.visible = new Set([...this.visible].filter((k) => this.tables.has(k)));
      this.draw();
    }

    isVisible(key) { return !this.visible || this.visible.has(key); }
    visibleTables() { return this.model ? this.model.tables.filter((t) => this.isVisible(t.key)) : []; }

    setVisible(keys) {
      this.visible = keys ? new Set(keys) : null;
      if (this.selected && !this.isVisible(this.selected)) this.selected = null;
      if (this.model) this.draw();
    }
    setKeysOnly(on) { this.keysOnly = !!on; if (this.model) this.draw(); }

    draw() {
      if (!this.model) return;
      this.compact = this.keysOnly || this.view.k < this.compactBelow;
      this.sizes = measureTables(this.model, this.compact);
      this.gTables.textContent = '';
      this.tableEls = new Map();
      for (const t of this.visibleTables()) this.drawTable(t);
      this.drawRefs();
      this.drawGroups();
      this.refreshHighlight();
      this.drawMinimap();
      if (this.opts.onDraw) this.opts.onDraw();
    }

    drawTable(t) {
      const p = this.positions[t.key], s = this.sizes[t.key];
      const g = el('g', { class: 'table', 'data-key': t.key, transform: `translate(${p.x},${p.y})` }, this.gTables);
      this.tableEls.set(t.key, g);
      const color = t.color || C.header;

      el('rect', { x: 0, y: 0, width: s.w, height: s.h, rx: M.radius, fill: C.body, filter: 'url(#dbml-shadow)' }, g);
      const head = el('g', { class: 'table-header' }, g);
      el('path', {
        d: `M0,${M.headerH} V${M.radius} Q0,0 ${M.radius},0 H${s.w - M.radius} Q${s.w},0 ${s.w},${M.radius} V${M.headerH} Z`,
        fill: color,
      }, head);
      const fg = readable(color);
      text(head, M.padX, M.headerH / 2, tableTitle(t), { fill: fg, 'font-size': 14, 'font-weight': 600 });
      if (t.note) {
        const ix = s.w - M.padX - 7;
        const ng = el('g', { class: 'note-icon', 'data-note': 'table' }, head);
        el('circle', { cx: ix, cy: M.headerH / 2, r: 7, fill: 'none', stroke: fg, 'stroke-opacity': 0.8, 'stroke-width': 1.3 }, ng);
        text(ng, ix, M.headerH / 2 + 0.5, 'i', { fill: fg, 'font-size': 10, 'font-weight': 700, 'text-anchor': 'middle', 'font-family': 'Georgia, serif' });
      }

      const shown = displayRows(t, this.compact);
      const rows = shown.rows.slice();
      if (shown.hidden) rows.push({ more: shown.hidden });
      if (!rows.length) rows.push(null);
      rows.forEach((c, i) => {
        const y = M.headerH + i * M.rowH;
        const last = i === rows.length - 1;
        const row = el('g', { class: 'row', 'data-col': c && c.name ? c.name : '', transform: `translate(0,${y})` }, g);
        const bg = i % 2 ? C.alt : C.body;
        if (last) {
          el('path', {
            class: 'row-bg', fill: bg,
            d: `M0,0 H${s.w} V${M.rowH - M.radius} Q${s.w},${M.rowH} ${s.w - M.radius},${M.rowH} H${M.radius} Q0,${M.rowH} 0,${M.rowH - M.radius} Z`,
          }, row);
        } else {
          el('rect', { class: 'row-bg', x: 0, y: 0, width: s.w, height: M.rowH, fill: bg }, row);
        }
        if (i > 0) el('line', { x1: 0, x2: s.w, y1: 0, y2: 0, stroke: C.sep }, row);
        const cy = M.rowH / 2;
        if (!c || c.more) {
          const label = !c ? 'no columns' : `+ ${c.more} more column${c.more === 1 ? '' : 's'}`;
          text(row, M.padX, cy, label, { fill: C.note, 'font-size': 12, 'font-style': 'italic' });
          return;
        }
        const ix = M.padX + 5;
        if (c.pk) {
          el('circle', { cx: ix - 1, cy, r: 3.4, fill: 'none', stroke: C.pk, 'stroke-width': 1.8 }, row);
          el('path', { d: `M${ix + 2.4},${cy} H${ix + 9} M${ix + 7},${cy} V${cy + 3} M${ix + 9},${cy} V${cy + 2.6}`, stroke: C.pk, 'stroke-width': 1.8, fill: 'none', 'stroke-linecap': 'round' }, row);
        } else if (c.fk) {
          el('path', { d: `M${ix - 4},${cy} H${ix + 6} M${ix + 2.5},${cy - 3.5} L${ix + 6},${cy} L${ix + 2.5},${cy + 3.5}`, stroke: C.fk, 'stroke-width': 1.7, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, row);
        }
        const nx = M.padX + M.iconW;
        const nameEl = text(row, nx, cy, c.name, { fill: C.name, 'font-size': 13, 'font-weight': c.pk ? 600 : 400 });
        if (c.note) {
          const w = textW(c.name, `${c.pk ? 600 : 400} 13px ${FONT}`);
          el('circle', { cx: nx + w + 6, cy: cy - 4, r: 2.2, fill: C.note }, row);
        }
        nameEl.setAttribute('class', 'col-name');
        text(row, s.w - M.padX, cy, c.type, {
          fill: c.enum ? C.enumType : C.type, 'font-size': 12, 'font-family': MONO, 'text-anchor': 'end',
        });
      });

      el('rect', { x: 0.5, y: 0.5, width: s.w - 1, height: s.h - 1, rx: M.radius, fill: 'none', stroke: C.border, class: 'table-outline' }, g);
    }

    anchor(key, columns) {
      const t = this.tables.get(key), p = this.positions[key], s = this.sizes[key];
      const rows = displayRows(t, this.compact).rows;
      const idx = columns.map((c) => rows.findIndex((x) => x.name === c)).filter((i) => i >= 0);
      const mean = idx.length ? idx.reduce((a, b) => a + b, 0) / idx.length : -0.9;
      return { left: p.x, right: p.x + s.w, y: p.y + M.headerH + mean * M.rowH + M.rowH / 2 };
    }

    // Pick an x for the vertical segment between x0 and x1 that doesn't cross a table.
    lane(x0, x1, y0, y1) {
      const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
      const blocked = (x) => this.visibleTables().some((t) => {
        const p = this.positions[t.key], s = this.sizes[t.key];
        return x > p.x - 8 && x < p.x + s.w + 8 && hi > p.y && lo < p.y + s.h;
      });
      const mid = (x0 + x1) / 2;
      const candidates = [mid];
      for (let d = 16; d < (x1 - x0) / 2 - 20; d += 16) candidates.push(mid - d, mid + d);
      return candidates.find((x) => !blocked(x)) ?? mid;
    }

    drawRefs() {
      this.gRefs.textContent = '';
      // spread multiple lines that leave the same side of the same row
      for (const r of this.model.refs) {
        const [ea, eb] = r.endpoints;
        if (!this.isVisible(ea.table) || !this.isVisible(eb.table)) continue;
        const a = this.anchor(ea.table, ea.columns), b = this.anchor(eb.table, eb.columns);
        const self = ea.table === eb.table;
        const out = 26;
        let pts, da, db, xa, xb;
        if (!self && a.right + out * 2 <= b.left) {
          xa = a.right; xb = b.left; da = 1; db = -1;
          const mx = this.lane(xa, xb, a.y, b.y);
          pts = [{ x: xa, y: a.y }, { x: mx, y: a.y }, { x: mx, y: b.y }, { x: xb, y: b.y }];
        } else if (!self && b.right + out * 2 <= a.left) {
          xa = a.left; xb = b.right; da = -1; db = 1;
          const mx = this.lane(xb, xa, a.y, b.y);
          pts = [{ x: xa, y: a.y }, { x: mx, y: a.y }, { x: mx, y: b.y }, { x: xb, y: b.y }];
        } else {
          // overlapping horizontally (or self reference): loop around the nearer side
          const useRight = self || Math.abs(a.right - b.right) <= Math.abs(a.left - b.left) || a.right > b.left;
          if (useRight) {
            xa = a.right; xb = b.right; da = db = 1;
            const x = Math.max(xa, xb) + out * 1.4;
            pts = [{ x: xa, y: a.y }, { x, y: a.y }, { x, y: b.y }, { x: xb, y: b.y }];
          } else {
            xa = a.left; xb = b.left; da = db = -1;
            const x = Math.min(xa, xb) - out * 1.4;
            pts = [{ x: xa, y: a.y }, { x, y: a.y }, { x, y: b.y }, { x: xb, y: b.y }];
          }
        }
        const d = roundedPath(pts, 10);
        const color = r.color || C.ref;
        const g = el('g', { class: 'ref', 'data-ref': r.id }, this.gRefs);
        el('path', { class: 'ref-hit', d, fill: 'none', stroke: 'transparent', 'stroke-width': 12 }, g);
        el('path', { class: 'ref-line', d, fill: 'none', stroke: color, 'stroke-width': 1.6 }, g);
        el('path', { class: 'ref-line', d: marker(xa, a.y, da, ea.relation) + ' ' + marker(xb, b.y, db, eb.relation), fill: 'none', stroke: color, 'stroke-width': 1.6, 'stroke-linecap': 'round' }, g);
      }
    }

    drawGroups() {
      this.gGroups.textContent = '';
      for (const grp of this.model.groups) {
        const ks = grp.tables.filter((k) => this.positions[k] && this.isVisible(k));
        if (!ks.length) continue;
        const pad = 22, top = 30;
        const x0 = Math.min(...ks.map((k) => this.positions[k].x)) - pad;
        const y0 = Math.min(...ks.map((k) => this.positions[k].y)) - pad - top;
        const x1 = Math.max(...ks.map((k) => this.positions[k].x + this.sizes[k].w)) + pad;
        const y1 = Math.max(...ks.map((k) => this.positions[k].y + this.sizes[k].h)) + pad;
        const color = grp.color || '#7F8FA6';
        const g = el('g', { class: 'group' }, this.gGroups);
        el('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 14, fill: color, 'fill-opacity': 0.07, stroke: color, 'stroke-opacity': 0.45, 'stroke-dasharray': '6 4' }, g);
        text(g, x0 + 16, y0 + 18, grp.name, { fill: color, 'font-size': 13, 'font-weight': 600 });
      }
    }

    // --------------------------------------------------------- highlighting
    refreshHighlight(hoverTable, hoverRef, hoverCol) {
      const svg = this.svg;
      svg.querySelectorAll('.active').forEach((n) => n.classList.remove('active'));
      svg.querySelectorAll('.row.hl').forEach((n) => n.classList.remove('hl'));
      const focusTable = hoverTable || this.selected;
      if (!this.model || (!focusTable && hoverRef == null)) { svg.classList.remove('focus'); return; }
      svg.classList.add('focus');
      const refs = [];
      if (hoverRef != null) refs.push(this.model.refs[hoverRef]);
      else if (hoverCol) {
        const ft = this.tables.get(focusTable);
        const col = ft && ft.columns.find((c) => c.name === hoverCol);
        (col ? col.refs : []).forEach((id) => refs.push(this.model.refs[id]));
        const fe = this.tableEls.get(focusTable);
        if (fe) fe.classList.add('active');
      } else {
        this.model.refs.forEach((r) => { if (r.endpoints.some((e) => e.table === focusTable)) refs.push(r); });
        const fe = this.tableEls.get(focusTable);
        if (fe) fe.classList.add('active');
      }
      for (const r of refs) {
        const g = this.gRefs.querySelector(`[data-ref="${r.id}"]`);
        if (g) g.classList.add('active');
        for (const e of r.endpoints) {
          const tg = this.tableEls.get(e.table);
          if (!tg) continue;
          tg.classList.add('active');
          if (hoverCol || hoverRef != null) {
            for (const c of e.columns) {
              const row = tg.querySelector(`.row[data-col="${CSS.escape(c)}"]`);
              if (row) row.classList.add('hl');
            }
          }
        }
      }
    }

    // -------------------------------------------------------------- tooltip
    showTip(html, ev) {
      this.tip.innerHTML = html;
      this.tip.style.display = 'block';
      const r = this.container.getBoundingClientRect();
      let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
      const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
      if (x + tw > r.width - 8) x = ev.clientX - r.left - tw - 14;
      if (y + th > r.height - 8) y = ev.clientY - r.top - th - 14;
      this.tip.style.left = `${Math.max(4, x)}px`;
      this.tip.style.top = `${Math.max(4, y)}px`;
    }
    hideTip() { this.tip.style.display = 'none'; }

    columnTip(t, c) {
      const flags = [];
      if (c.pk) flags.push('primary key');
      if (c.fk) flags.push('foreign key');
      if (c.unique) flags.push('unique');
      if (c.notNull) flags.push('not null');
      if (c.increment) flags.push('increment');
      let h = `<div class="tt-title">${esc(tableTitle(t))}.<b>${esc(c.name)}</b></div><div class="tt-type">${esc(c.type)}</div>`;
      if (flags.length) h += `<div class="tt-flags">${flags.map((f) => `<span>${f}</span>`).join('')}</div>`;
      if (c.default != null) h += `<div class="tt-row">default <code>${esc(c.default)}</code></div>`;
      if (c.note) h += `<div class="tt-note">${esc(c.note)}</div>`;
      if (c.enum) {
        const e = this.enums.get(c.enum);
        h += `<div class="tt-row">enum values</div><ul class="tt-enum">${e.values.map((v) => `<li>${esc(v.name)}${v.note ? ` <i>— ${esc(v.note)}</i>` : ''}</li>`).join('')}</ul>`;
      }
      for (const id of c.refs) h += `<div class="tt-ref">${esc(this.refText(this.model.refs[id]))}</div>`;
      return h;
    }
    refText(r) {
      const side = (e) => `${e.table}.${e.columns.length > 1 ? `(${e.columns.join(', ')})` : e.columns[0]}`;
      const [a, b] = r.endpoints;
      let s = `${side(a)} ${r.op} ${side(b)}`;
      if (r.onDelete) s += `  · on delete ${r.onDelete}`;
      if (r.onUpdate) s += `  · on update ${r.onUpdate}`;
      return s;
    }

    // --------------------------------------------------------- interaction
    bind() {
      const svg = this.svg;
      let drag = null;

      svg.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        const tg = ev.target.closest('.table');
        if (tg) {
          const key = tg.getAttribute('data-key');
          const p = this.positions[key];
          drag = { type: 'table', key, sx: ev.clientX, sy: ev.clientY, ox: p.x, oy: p.y, moved: false, el: tg };
          this.gTables.appendChild(tg); // bring to front
        } else {
          drag = { type: 'pan', sx: ev.clientX, sy: ev.clientY, ox: this.view.x, oy: this.view.y, moved: false };
          svg.classList.add('panning');
        }
        svg.setPointerCapture(ev.pointerId);
        this.hideTip();
      });

      svg.addEventListener('pointermove', (ev) => {
        if (drag) {
          const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
          if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
          if (!drag.moved) return;
          if (drag.type === 'table') {
            const p = this.positions[drag.key];
            const g = ev.altKey ? 1 : this.grid; // hold Alt/Option to place freely
            p.x = Math.round((drag.ox + dx / this.view.k) / g) * g;
            p.y = Math.round((drag.oy + dy / this.view.k) / g) * g;
            drag.el.setAttribute('transform', `translate(${p.x},${p.y})`);
            this.drawRefs();
            this.drawGroups();
            this.drawMinimap();
            this.refreshHighlight(drag.key);
          } else {
            this.view.x = drag.ox + dx;
            this.view.y = drag.oy + dy;
            this.applyView();
          }
          return;
        }
        this.hover(ev);
      });

      const end = (ev) => {
        if (!drag) return;
        svg.classList.remove('panning');
        if (drag.type === 'table') {
          if (drag.moved) { if (this.opts.onPositionsChange) this.opts.onPositionsChange(this.positions); }
          else {
            this.selected = this.selected === drag.key ? null : drag.key;
            this.refreshHighlight();
            if (this.opts.onSelect) this.opts.onSelect(this.selected ? this.tables.get(this.selected) : null, ev);
          }
        } else if (!drag.moved && this.selected) {
          this.selected = null;
          this.refreshHighlight();
          if (this.opts.onSelect) this.opts.onSelect(null, ev);
        }
        drag = null;
      };
      svg.addEventListener('pointerup', end);
      svg.addEventListener('pointercancel', end);
      svg.addEventListener('pointerleave', () => { if (!drag) { this.hideTip(); this.refreshHighlight(); } });

      svg.addEventListener('dblclick', (ev) => {
        const tg = ev.target.closest('.table');
        if (tg && this.opts.onOpen) {
          const t = this.tables.get(tg.getAttribute('data-key'));
          const row = ev.target.closest('.row');
          const col = row && t.columns.find((c) => c.name === row.getAttribute('data-col'));
          this.opts.onOpen(t, col);
        }
      });

      svg.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const r = svg.getBoundingClientRect();
        if (ev.ctrlKey || ev.metaKey) {
          this.zoomAt(Math.exp(-ev.deltaY * 0.01), ev.clientX - r.left, ev.clientY - r.top);
        } else {
          this.view.x -= ev.deltaX;
          this.view.y -= ev.deltaY;
          this.applyView();
        }
      }, { passive: false });
    }

    hover(ev) {
      if (!this.model) return;
      const refEl = ev.target.closest('.ref');
      if (refEl) {
        const r = this.model.refs[+refEl.getAttribute('data-ref')];
        this.refreshHighlight(null, r.id);
        this.showTip(`<div class="tt-ref">${esc(this.refText(r))}</div>`, ev);
        return;
      }
      const tg = ev.target.closest('.table');
      if (!tg) { this.hideTip(); this.refreshHighlight(); return; }
      const t = this.tables.get(tg.getAttribute('data-key'));
      const row = ev.target.closest('.row');
      const col = row && t.columns.find((c) => c.name === row.getAttribute('data-col'));
      if (col) {
        this.refreshHighlight(t.key, null, col.name);
        this.showTip(this.columnTip(t, col), ev);
      } else {
        this.refreshHighlight(t.key);
        if (ev.target.closest('.table-header') && (t.note || t.alias)) {
          let h = `<div class="tt-title"><b>${esc(tableTitle(t))}</b>${t.alias ? ` <span class="tt-type">as ${esc(t.alias)}</span>` : ''}</div>`;
          if (t.note) h += `<div class="tt-note">${esc(t.note)}</div>`;
          this.showTip(h, ev);
        } else this.hideTip();
      }
    }

    applyView() {
      const { x, y, k } = this.view;
      this.viewport.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
      this.container.style.backgroundPosition = `${x}px ${y}px`;
      this.container.style.backgroundSize = `${22 * k}px ${22 * k}px`;
      if (this.opts.onZoom) this.opts.onZoom(k);
      if (this.model && (this.keysOnly || k < this.compactBelow) !== this.compact) this.draw();
      else this.drawMinimap();
    }

    zoomTo(k) {
      const r = this.svg.getBoundingClientRect();
      this.zoomAt(k / this.view.k, r.width / 2, r.height / 2);
    }

    select(key) {
      this.selected = key;
      this.refreshHighlight();
    }

    // ------------------------------------------------------------- minimap
    worldBounds() {
      const ts = this.visibleTables();
      if (!ts.length) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const t of ts) {
        const p = this.positions[t.key], s = this.sizes[t.key];
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x + s.w); y1 = Math.max(y1, p.y + s.h);
      }
      return { x0, y0, x1, y1 };
    }

    drawMinimap() {
      const svg = this.miniSvg;
      svg.textContent = '';
      const b = this.model && this.worldBounds();
      this.mini.classList.toggle('empty', !b);
      if (!b) return;
      const r = this.svg.getBoundingClientRect();
      const { x, y, k } = this.view;
      const vw = { x0: -x / k, y0: -y / k, x1: (r.width - x) / k, y1: (r.height - y) / k };
      // Frame the tables; the viewport rectangle is clipped by the minimap's edges.
      const pad = 60;
      const X0 = b.x0 - pad, Y0 = b.y0 - pad, X1 = b.x1 + pad, Y1 = b.y1 + pad;
      const W = this.mini.clientWidth || 168, H = this.mini.clientHeight || 112;
      const sc = Math.min(W / (X1 - X0), H / (Y1 - Y0));
      const ox = (W - (X1 - X0) * sc) / 2, oy = (H - (Y1 - Y0) * sc) / 2;
      this.miniMap = { X0, Y0, sc, ox, oy };
      const tx = (v) => ox + (v - X0) * sc, ty = (v) => oy + (v - Y0) * sc;
      for (const t of this.visibleTables()) {
        const p = this.positions[t.key], s = this.sizes[t.key];
        el('rect', {
          x: tx(p.x), y: ty(p.y), width: Math.max(2, s.w * sc), height: Math.max(2, s.h * sc), rx: 1.5,
          fill: t.color || C.header, 'fill-opacity': t.key === this.selected ? 0.9 : 0.45,
        }, svg);
      }
      el('rect', {
        class: 'mini-view', x: tx(vw.x0), y: ty(vw.y0), width: (vw.x1 - vw.x0) * sc, height: (vw.y1 - vw.y0) * sc,
        fill: 'rgba(47,128,237,.08)', stroke: '#2F80ED', 'stroke-width': 1.2, rx: 2,
      }, svg);
    }

    bindMinimap() {
      let down = false;
      const move = (ev) => {
        const m = this.miniMap;
        if (!m) return;
        const rr = this.mini.getBoundingClientRect();
        const wx = m.X0 + (ev.clientX - rr.left - m.ox) / m.sc;
        const wy = m.Y0 + (ev.clientY - rr.top - m.oy) / m.sc;
        const r = this.svg.getBoundingClientRect();
        this.view.x = r.width / 2 - wx * this.view.k;
        this.view.y = r.height / 2 - wy * this.view.k;
        this.applyView();
      };
      this.mini.addEventListener('pointerdown', (ev) => { down = true; this.mini.setPointerCapture(ev.pointerId); move(ev); });
      this.mini.addEventListener('pointermove', (ev) => { if (down) move(ev); });
      this.mini.addEventListener('pointerup', () => { down = false; });
      this.mini.addEventListener('wheel', (ev) => ev.stopPropagation(), { passive: true });
    }

    zoomAt(factor, cx, cy) {
      const k = Math.min(3, Math.max(0.1, this.view.k * factor));
      const f = k / this.view.k;
      this.view.x = cx - (cx - this.view.x) * f;
      this.view.y = cy - (cy - this.view.y) * f;
      this.view.k = k;
      this.applyView();
    }
    zoomBy(factor) {
      const r = this.svg.getBoundingClientRect();
      this.zoomAt(factor, r.width / 2, r.height / 2);
    }

    fit() {
      if (!this.model || !this.visibleTables().length) return;
      const bb = this.viewport.getBBox();
      const r = this.svg.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const pad = 48;
      // keep the right edge clear of the minimap when there is room for it
      const reserve = !this.mini.classList.contains('empty') && r.width > 700 ? 170 : 0;
      const k = Math.min(1.1, (r.width - pad * 2 - reserve) / bb.width, (r.height - pad * 2) / bb.height);
      this.view.k = Math.max(0.1, k);
      this.view.x = (r.width - reserve - bb.width * this.view.k) / 2 - bb.x * this.view.k;
      this.view.y = (r.height - bb.height * this.view.k) / 2 - bb.y * this.view.k;
      this.applyView();
    }

    focusTable(key) {
      const p = this.positions[key], s = this.sizes[key];
      if (!p || !s || !this.isVisible(key)) return;
      const r = this.svg.getBoundingClientRect();
      this.view.x = r.width / 2 - (p.x + s.w / 2) * this.view.k;
      this.view.y = r.height / 2 - (p.y + s.h / 2) * this.view.k;
      this.selected = key;
      this.applyView();
      this.refreshHighlight();
    }

    // -------------------------------------------------------------- export
    toSVG() {
      const bb = this.viewport.getBBox();
      const pad = 32;
      const vb = [bb.x - pad, bb.y - pad, bb.width + pad * 2, bb.height + pad * 2].map((n) => Math.round(n));
      const clone = this.svg.cloneNode(true);
      clone.removeAttribute('class');
      clone.setAttribute('xmlns', NS);
      clone.setAttribute('viewBox', vb.join(' '));
      clone.setAttribute('width', vb[2]);
      clone.setAttribute('height', vb[3]);
      clone.querySelector('.viewport').removeAttribute('transform');
      clone.querySelectorAll('.ref-hit').forEach((n) => n.remove());
      clone.querySelectorAll('.active,.hl').forEach((n) => n.classList.remove('active', 'hl'));
      const bg = el('rect', { x: vb[0], y: vb[1], width: vb[2], height: vb[3], fill: '#FFFFFF' });
      clone.insertBefore(bg, clone.querySelector('.viewport'));
      return { svg: new XMLSerializer().serializeToString(clone), width: vb[2], height: vb[3] };
    }

    toPNG(scale = 2) {
      const { svg, width, height } = this.toSVG();
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = width * scale;
          c.height = height * scale;
          const g = c.getContext('2d');
          g.scale(scale, scale);
          g.drawImage(img, 0, 0);
          c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png');
        };
        img.onerror = () => reject(new Error('PNG export failed'));
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      });
    }
  }

  root.DBMLDiagram = { Diagram, measureTables };
})(typeof self !== 'undefined' ? self : this);
