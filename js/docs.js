/*
 * Docs view: a readable reference page for a parsed DBML model.
 * The same builder renders the in-app Docs tab and the exported HTML page.
 */
(function (root) {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
  const safeColor = (c, d) => (c && COLOR_RE.test(c) ? c : d);
  const HEADER = '#2F5D8A';
  const GROUP = '#7F8FA6';
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function readable(hex) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
    const n = parseInt(full, 16);
    if (Number.isNaN(n)) return '#fff';
    return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 170 ? '#1F2933' : '#FFFFFF';
  }

  // ------------------------------------------------------------ indexing
  function index(model) {
    const tables = new Map(model.tables.map((t) => [t.key, t]));
    const ids = new Map();
    const used = new Set();
    const slug = (prefix, key) => {
      const base = `${prefix}-${key.replace(/[^A-Za-z0-9_-]+/g, '_')}`;
      let id = base, i = 2;
      while (used.has(id)) id = `${base}-${i++}`;
      used.add(id);
      return id;
    };
    for (const t of model.tables) ids.set(`t:${t.key}`, slug('table', t.key));
    for (const e of model.enums) ids.set(`e:${e.key}`, slug('enum', e.key));
    for (const g of model.groups) ids.set(`g:${g.name}`, slug('group', g.name));

    const groupOf = new Map();
    for (const g of model.groups) for (const k of g.tables) if (!groupOf.has(k)) groupOf.set(k, g);

    const enumUsers = new Map(model.enums.map((e) => [e.key, []]));
    for (const t of model.tables) for (const c of t.columns) if (c.enum && enumUsers.has(c.enum)) enumUsers.get(c.enum).push({ t, c });

    // out: this table references another; in: another references this; other: many-to-many
    const rel = new Map(model.tables.map((t) => [t.key, { out: [], in: [], other: [] }]));
    for (const r of model.refs) {
      const [a, b] = r.endpoints;
      const push = (list, self, other, kind) => rel.get(self.table)[list].push({ r, self, other, kind });
      if (a.relation === '*' && b.relation === '1') {
        push('out', a, b, 'many-to-one');
        if (a.table !== b.table) push('in', b, a, 'one-to-many');
      } else if (a.relation === '1' && b.relation === '*') {
        push('out', b, a, 'many-to-one');
        if (a.table !== b.table) push('in', a, b, 'one-to-many');
      } else if (r.op === '-') {
        push('out', a, b, 'one-to-one');
        if (a.table !== b.table) push('in', b, a, 'one-to-one');
      } else {
        push('other', a, b, 'many-to-many');
        if (a.table !== b.table) push('other', b, a, 'many-to-many');
      }
    }

    // column -> the columns it points at
    const fk = new Map();
    for (const [key, rr] of rel) {
      for (const x of rr.out) {
        x.self.columns.forEach((c, i) => {
          const k = `${key}\u0000${c}`;
          if (!fk.has(k)) fk.set(k, []);
          fk.get(k).push({ table: x.other.table, column: x.other.columns[i] });
        });
      }
    }
    return { tables, ids, groupOf, enumUsers, rel, fk, hasRefs: model.refs.length > 0 };
  }

  const tLink = (ix, key, label) => `<a href="#${ix.ids.get(`t:${key}`)}" data-table="${esc(key)}">${esc(label || key)}</a>`;
  const cols = (ep) => (ep.columns.length > 1 ? `(${ep.columns.join(', ')})` : ep.columns[0]);

  // ------------------------------------------------------- mini diagram
  function miniSVG(model, ix, key) {
    const r = ix.rel.get(key);
    if (!r) return '';
    const side = new Map(); // neighbour -> { pos: 'L'|'R', self, other }
    const put = (x, pos) => {
      if (x.other.table === key || side.has(x.other.table)) return;
      side.set(x.other.table, { pos, selfRel: x.self.relation, otherRel: x.other.relation });
    };
    r.in.forEach((x) => put(x, 'L'));
    r.out.forEach((x) => put(x, 'R'));
    r.other.forEach((x) => {
      const nl = [...side.values()].filter((v) => v.pos === 'L').length;
      const nr = side.size - nl;
      put(x, nl <= nr ? 'L' : 'R');
    });
    if (!side.size) return '';
    const MAX = 7;
    const L = [...side].filter(([, v]) => v.pos === 'L');
    const R = [...side].filter(([, v]) => v.pos === 'R');
    const BW = 80, BH = 24, GAP = 9, W = 330, PAD = 4;
    const rows = Math.max(Math.min(L.length, MAX) + (L.length > MAX ? 1 : 0), Math.min(R.length, MAX) + (R.length > MAX ? 1 : 0), 1);
    const H = PAD * 2 + rows * BH + (rows - 1) * GAP;
    const cx = (W - BW) / 2, cy = H / 2;
    const short = (s) => (s.length > 11 ? `${s.slice(0, 10)}…` : s);
    const t = ix.tables.get(key);
    const color = safeColor(t.color, HEADER);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(key)} and its related tables" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="10.5">`;
    const mark = (x, y, dir, rel) => (rel === '*'
      ? `M${x + dir * 9},${y} L${x},${y - 5} M${x + dir * 9},${y} L${x},${y} M${x + dir * 9},${y} L${x},${y + 5}`
      : `M${x + dir * 6},${y - 4} L${x + dir * 6},${y + 4}`);

    const column = (list, x, edgeX, centerEdge, dirOut, dirIn) => {
      const shown = list.slice(0, MAX);
      const n = shown.length + (list.length > MAX ? 1 : 0);
      const top = cy - (n * BH + (n - 1) * GAP) / 2;
      shown.forEach(([k, v], i) => {
        const y = top + i * (BH + GAP);
        const my = y + BH / 2;
        const nt = ix.tables.get(k);
        const c = safeColor(nt && nt.color, HEADER);
        const mid = (edgeX + centerEdge) / 2;
        svg += `<path d="M${edgeX},${my} C${mid},${my} ${mid},${cy} ${centerEdge},${cy}" fill="none" style="stroke: var(--m-line, #9AA7B8)" stroke-width="1.2"/>`;
        svg += `<path d="${mark(edgeX, my, dirOut, v.otherRel)} ${mark(centerEdge, cy, dirIn, v.selfRel)}" fill="none" style="stroke: var(--m-line, #9AA7B8)" stroke-width="1.2"/>`;
        svg += `<a href="#${ix.ids.get(`t:${k}`)}" data-table="${esc(k)}"><title>${esc(k)}</title>`;
        svg += `<rect x="${x}" y="${y}" width="${BW}" height="${BH}" rx="5" style="fill: var(--m-box, #FFFFFF); stroke: var(--m-box-line, #D3DCE6)"/>`;
        svg += `<rect x="${x}" y="${y}" width="4" height="${BH}" rx="2" fill="${c}"/>`;
        svg += `<text x="${x + 10}" y="${my}" dominant-baseline="central" style="fill: var(--m-text, #1F2933)">${esc(short(k))}</text></a>`;
      });
      if (list.length > MAX) {
        const y = top + MAX * (BH + GAP) + BH / 2;
        svg += `<text x="${x + BW / 2}" y="${y}" text-anchor="middle" dominant-baseline="central" style="fill: var(--m-muted, #6B7785)">+${list.length - MAX} more</text>`;
      }
    };
    column(L, PAD, PAD + BW, cx, 1, -1);
    column(R, W - PAD - BW, W - PAD - BW, cx + BW, -1, 1);
    svg += `<rect x="${cx}" y="${cy - BH / 2}" width="${BW}" height="${BH}" rx="5" fill="${color}"/>`;
    svg += `<text x="${cx + BW / 2}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-weight="600" fill="${readable(color)}">${esc(short(key))}</text>`;
    return `${svg}</svg>`;
  }

  // ------------------------------------------------------------ sections
  function relItem(ix, x, arrow) {
    const del = x.r.onDelete ? ` · on delete ${esc(x.r.onDelete)}` : '';
    const upd = x.r.onUpdate ? ` · on update ${esc(x.r.onUpdate)}` : '';
    return `<li>${tLink(ix, x.other.table)}<span class="d-rel"><code>${esc(cols(x.self))}</code> ${arrow} <code>${esc(cols(x.other))}</code></span><span class="d-card">${x.kind}${del}${upd}</span></li>`;
  }

  function tableSection(t, ix, opts) {
    const q = opts.query;
    const id = ix.ids.get(`t:${t.key}`);
    const g = ix.groupOf.get(t.key);
    const color = safeColor(t.color, HEADER);
    const hasDefault = t.columns.some((c) => c.default != null);
    const hasNote = t.columns.some((c) => c.note);
    let h = `<section class="d-table" id="${id}" data-key="${esc(t.key)}">`;
    h += `<header class="d-head"><span class="d-swatch" style="background:${color}"></span><h2>${esc(t.name)}</h2>`;
    if (t.schema) h += `<span class="d-chip">${esc(t.schema)}</span>`;
    if (t.alias) h += `<span class="d-chip">alias ${esc(t.alias)}</span>`;
    if (g && g.name !== t.schema) h += `<a class="d-chip d-group" href="#${ix.ids.get(`g:${g.name}`)}" data-group="${esc(g.name)}" style="--c:${safeColor(g.color, GROUP)}">${esc(g.name)}</a>`;
    h += '<span class="d-spacer"></span>';
    if (!opts.export) {
      h += `<button class="d-act" data-show="${esc(t.key)}" title="Open this table in the diagram">Show in diagram</button>`;
      h += `<button class="d-act" data-copy="${esc(t.key)}" title="Copy a link straight to this table">Copy link</button>`;
    }
    h += '</header>';
    if (t.note) h += `<p class="d-note">${esc(t.note)}</p>`;

    const rr = ix.rel.get(t.key);
    const nRel = rr.out.length + rr.in.length + rr.other.length;
    h += `<div class="d-body${ix.hasRefs ? '' : ' no-side'}"><div class="d-main">`;
    h += '<div class="d-scroll"><table class="d-grid"><thead><tr><th>Column</th><th>Type</th><th>Key</th><th>Nullable</th>';
    if (hasDefault) h += '<th>Default</th>';
    if (hasNote) h += '<th>Note</th>';
    h += '</tr></thead><tbody>';
    for (const c of t.columns) {
      const keys = [];
      if (c.pk) keys.push('<span class="b b-pk">PK</span>');
      for (const tg of ix.fk.get(`${t.key}\u0000${c.name}`) || []) {
        keys.push(`<span class="b b-fk">FK</span> → ${tLink(ix, tg.table)}.<code>${esc(tg.column)}</code>`);
      }
      if (c.unique) keys.push('<span class="b">unique</span>');
      if (c.increment) keys.push('<span class="b">auto-increment</span>');
      const type = c.enum
        ? `<a href="#${ix.ids.get(`e:${c.enum}`)}" data-enum="${esc(c.enum)}"><code>${esc(c.type)}</code></a>`
        : `<code>${esc(c.type)}</code>`;
      const hit = q && c.name.toLowerCase().includes(q);
      h += `<tr${hit ? ' class="hit"' : ''}><td class="d-cname">${esc(c.name)}</td><td>${type}</td><td class="d-keys">${keys.join('<br>')}</td><td>${c.pk || c.notNull ? 'No' : 'Yes'}</td>`;
      if (hasDefault) h += `<td>${c.default != null ? `<code>${esc(c.default)}</code>` : ''}</td>`;
      if (hasNote) h += `<td class="d-cnote">${c.note ? esc(c.note) : ''}</td>`;
      h += '</tr>';
    }
    if (!t.columns.length) h += '<tr><td colspan="4" class="d-empty">No columns.</td></tr>';
    h += '</tbody></table></div>';

    if (t.indexes.length) {
      const idxNote = t.indexes.some((i) => i.note);
      h += '<h3>Indexes</h3><div class="d-scroll"><table class="d-grid"><thead><tr><th>Columns</th><th>Kind</th><th>Name</th>';
      if (idxNote) h += '<th>Note</th>';
      h += '</tr></thead><tbody>';
      for (const i of t.indexes) {
        const kind = [i.pk ? 'primary key' : i.unique ? 'unique' : 'index', i.type].filter(Boolean).join(' · ');
        h += `<tr><td><code>${esc(i.columns.join(', '))}</code></td><td>${esc(kind)}</td><td>${i.name ? esc(i.name) : ''}</td>${idxNote ? `<td>${i.note ? esc(i.note) : ''}</td>` : ''}</tr>`;
      }
      h += '</tbody></table></div>';
    }
    h += '</div>';

    if (ix.hasRefs) {
      h += '<aside class="d-side">';
      if (nRel) {
        h += `<div class="d-mini" data-mini="${esc(t.key)}">${opts.export ? miniSVG(opts.model, ix, t.key) : ''}</div>`;
        if (rr.out.length) h += `<h4>References</h4><ul class="d-rels">${rr.out.map((x) => relItem(ix, x, '→')).join('')}</ul>`;
        if (rr.in.length) h += `<h4>Referenced by</h4><ul class="d-rels">${rr.in.map((x) => relItem(ix, x, '←')).join('')}</ul>`;
        if (rr.other.length) h += `<h4>Many-to-many</h4><ul class="d-rels">${rr.other.map((x) => relItem(ix, x, '↔')).join('')}</ul>`;
      } else {
        h += '<p class="d-muted">No relationships.</p>';
      }
      h += '</aside>';
    }
    h += '</div></section>';
    return h;
  }

  function enumSection(e, ix) {
    const users = ix.enumUsers.get(e.key) || [];
    const hasNote = e.values.some((v) => v.note);
    let h = `<section class="d-enum" id="${ix.ids.get(`e:${e.key}`)}"><header class="d-head"><span class="d-swatch enum">E</span><h2>${esc(e.key)}</h2><span class="d-chip">enum</span></header>`;
    h += `<div class="d-scroll"><table class="d-grid d-narrow"><thead><tr><th>Value</th>${hasNote ? '<th>Note</th>' : ''}</tr></thead><tbody>`;
    for (const v of e.values) h += `<tr><td><code>${esc(v.name)}</code></td>${hasNote ? `<td>${v.note ? esc(v.note) : ''}</td>` : ''}</tr>`;
    h += '</tbody></table></div>';
    if (users.length) {
      h += `<p class="d-used">Used by ${users.map(({ t, c }) => `${tLink(ix, t.key)}.<code>${esc(c.name)}</code>`).join(', ')}</p>`;
    }
    return `${h}</section>`;
  }

  function overview(model, ix) {
    const p = model.project;
    const ncols = model.tables.reduce((a, t) => a + t.columns.length, 0);
    let h = '<section class="d-overview" id="overview">';
    h += `<h1>${esc(p && p.name ? p.name : 'Schema')}</h1>`;
    if (p && p.settings && p.settings.database_type) h += `<p class="d-muted">Database: ${esc(p.settings.database_type)}</p>`;
    if (p && p.note) h += `<p class="d-note">${esc(p.note)}</p>`;
    const stats = [plural(model.tables.length, 'table'), plural(ncols, 'column'), plural(model.refs.length, 'relationship')];
    if (model.enums.length) stats.push(plural(model.enums.length, 'enum'));
    if (model.groups.length) stats.push(plural(model.groups.length, 'group'));
    h += `<div class="d-stats">${stats.map((s) => `<span>${s}</span>`).join('')}</div>`;

    if (model.groups.length) {
      h += '<h3>Groups</h3><div class="d-groups">';
      for (const g of model.groups) {
        h += `<div class="d-gcard" id="${ix.ids.get(`g:${g.name}`)}" style="--c:${safeColor(g.color, GROUP)}"><div class="d-gname">${esc(g.name)} <span class="d-muted">${plural(g.tables.length, 'table')}</span></div>`;
        if (g.note) h += `<p class="d-note">${esc(g.note)}</p>`;
        h += `<div class="d-glinks">${g.tables.map((k) => tLink(ix, k)).join('')}</div></div>`;
      }
      h += '</div>';
    }

    const anyNote = model.tables.some((t) => t.note);
    h += `<h3>Tables</h3><div class="d-scroll"><table class="d-grid d-index"><thead><tr><th>Table</th><th>Columns</th>${model.groups.length ? '<th>Group</th>' : ''}${anyNote ? '<th>Note</th>' : ''}</tr></thead><tbody>`;
    for (const t of model.tables) {
      const g = ix.groupOf.get(t.key);
      const note = t.note ? t.note.split('\n')[0] : '';
      h += `<tr><td>${tLink(ix, t.key)}</td><td>${t.columns.length}</td>${model.groups.length ? `<td>${g ? esc(g.name) : ''}</td>` : ''}${anyNote ? `<td class="d-cnote">${esc(note)}</td>` : ''}</tr>`;
    }
    h += '</tbody></table></div>';

    if (model.notes && model.notes.length) {
      h += '<h3>Notes</h3>';
      for (const n of model.notes) h += `<div class="d-sticky">${n.name ? `<b>${esc(n.name)}</b>` : ''}<p class="d-note">${esc(n.text)}</p></div>`;
    }
    return `${h}</section>`;
  }

  function build(model, ix, opts = {}) {
    const q = (opts.query || '').trim().toLowerCase();
    const o = { ...opts, query: q, model };
    let tables = model.tables;
    let enums = model.enums;
    let h = '';
    if (q) {
      tables = tables.filter((t) => t.key.toLowerCase().includes(q) || (t.alias || '').toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase().includes(q)));
      enums = enums.filter((e) => e.key.toLowerCase().includes(q) || e.values.some((v) => v.name.toLowerCase().includes(q)));
      h += `<div class="d-filter">${plural(tables.length, 'table')}${enums.length ? ` and ${plural(enums.length, 'enum')}` : ''} match “${esc(opts.query.trim())}”. <button class="d-act" data-clear-filter>Clear filter</button></div>`;
    } else {
      h += overview(model, ix);
    }
    if (!model.tables.length) h += '<p class="d-muted">There are no tables yet. Add a <code>Table</code> to your DBML.</p>';
    for (const t of tables) h += tableSection(t, ix, o);
    if (enums.length) {
      h += '<h2 class="d-part">Enums</h2>';
      for (const e of enums) h += enumSection(e, ix);
    }
    return h;
  }

  // --------------------------------------------------------------- styles
  const CSS = `
.erd-docs { --ink: #1F2933; --muted: #6B7785; --line: #E1E6EC; --soft: #F5F7FA; --accent: #2F80ED;
  color: var(--ink); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
  max-width: 1120px; margin: 0 auto; padding: 28px 32px 80px; }
.erd-docs a { color: var(--accent); text-decoration: none; }
.erd-docs a:hover { text-decoration: underline; }
.erd-docs code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.erd-docs h1 { font-size: 30px; line-height: 1.15; margin: 0 0 8px; letter-spacing: -.01em; }
.erd-docs h2 { font-size: 20px; margin: 0; }
.erd-docs h3 { font-size: 14px; margin: 22px 0 8px; }
.erd-docs h4 { font-size: 12.5px; margin: 14px 0 6px; color: var(--muted); font-weight: 600; }
.erd-docs .d-muted { color: var(--muted); margin: 0; }
.erd-docs .d-note { white-space: pre-wrap; margin: 8px 0 0; max-width: 72ch; }
.erd-docs .d-stats { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 6px; }
.erd-docs .d-stats span { background: var(--soft); border: 1px solid var(--line); border-radius: 999px; padding: 3px 12px; font-size: 13px; }
.erd-docs .d-groups { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.erd-docs .d-gcard { border: 1px solid var(--line); border-left: 4px solid var(--c); border-radius: 0; padding: 10px 12px; scroll-margin-top: 16px; }
.erd-docs .d-gname { font-weight: 600; }
.erd-docs .d-glinks { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; }
.erd-docs .d-sticky { background: var(--sticky-bg, #FFF9E6); border: 1px solid var(--sticky-line, #F3E3B5); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
.erd-docs .d-overview { padding-bottom: 18px; border-bottom: 1px solid var(--line); }
.erd-docs .d-part { margin: 40px 0 0; font-size: 13px; color: var(--muted); text-transform: none; }
.erd-docs .d-filter { display: flex; align-items: center; gap: 12px; color: var(--muted); padding: 4px 0 10px; border-bottom: 1px solid var(--line); }
.erd-docs section.d-table, .erd-docs section.d-enum { padding: 26px 0; border-bottom: 1px solid var(--line); scroll-margin-top: 8px; }
.erd-docs section.flash { animation: d-flash 1.2s ease-out; }
@keyframes d-flash { from { background: var(--flash, #EAF2FE); } to { background: transparent; } }
.erd-docs .d-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.erd-docs .d-swatch { width: 12px; height: 12px; border-radius: 3px; flex: none; }
.erd-docs .d-swatch.enum { width: auto; height: auto; color: var(--enum, #8E44AD); font-weight: 700; font-size: 13px; }
.erd-docs .d-chip { font-size: 12px; background: var(--soft); border: 1px solid var(--line); border-radius: 999px; padding: 1px 9px; color: var(--muted); }
.erd-docs .d-chip.d-group { color: var(--ink); border-color: var(--c); background: color-mix(in srgb, var(--c) 10%, var(--chip-mix, #fff)); }
.erd-docs .d-spacer { flex: 1; }
.erd-docs .d-act { font: inherit; font-size: 12.5px; background: var(--act-bg, #fff); color: var(--ink); border: 1px solid var(--line); border-radius: 7px; padding: 4px 10px; cursor: pointer; }
.erd-docs .d-act:hover { border-color: var(--line-strong, #C5CFDA); background: var(--act-hover, #F8FAFC); }
.erd-docs .d-body { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 28px; margin-top: 14px; }
.erd-docs .d-body.no-side { grid-template-columns: minmax(0, 1fr); }
.erd-docs .d-scroll { overflow-x: auto; }
.erd-docs table.d-grid { width: 100%; border-collapse: collapse; font-size: 13px; }
.erd-docs table.d-narrow { width: auto; min-width: 260px; }
.erd-docs .d-grid th { text-align: left; font-weight: 600; color: var(--muted); font-size: 12px; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
.erd-docs .d-grid td { padding: 7px 12px 7px 0; border-bottom: 1px solid var(--row-line, #EEF1F4); vertical-align: top; }
.erd-docs .d-grid tr.hit td { background: var(--hit-bg, #FFF6D6); }
.erd-docs .d-cname { font-weight: 600; white-space: nowrap; }
.erd-docs .d-keys { white-space: nowrap; }
.erd-docs .d-cnote { color: var(--muted); min-width: 160px; }
.erd-docs .d-empty { color: var(--muted); font-style: italic; }
.erd-docs .b { display: inline-block; font-size: 11px; font-weight: 600; border-radius: 4px; padding: 0 5px; background: var(--soft); border: 1px solid var(--line); color: var(--muted); }
.erd-docs .b-pk { background: var(--pk-bg, #FDF3D6); border-color: var(--pk-line, #EBD48E); color: var(--pk-text, #8A6A0B); }
.erd-docs .b-fk { background: var(--fk-bg, #E7F0FD); border-color: var(--fk-line, #B9D3FA); color: var(--fk-text, #1B5FC1); }
.erd-docs .d-side { min-width: 0; }
.erd-docs .d-mini { min-height: 40px; background: var(--soft); border: 1px solid var(--line); border-radius: 8px; padding: 6px; }
.erd-docs .d-mini svg { display: block; }
.erd-docs .d-mini a text { text-decoration: none; }
.erd-docs .d-rels { list-style: none; margin: 0; padding: 0; font-size: 13px; }
.erd-docs .d-rels li { padding: 5px 0; border-bottom: 1px solid var(--row-line, #EEF1F4); display: flex; flex-wrap: wrap; gap: 2px 8px; }
.erd-docs .d-rel { color: var(--muted); }
.erd-docs .d-card { color: var(--muted); font-size: 12px; width: 100%; }
.erd-docs .d-used { margin: 10px 0 0; color: var(--muted); }
@media (max-width: 860px) {
  .erd-docs { padding: 20px 16px 60px; }
  .erd-docs .d-body { grid-template-columns: minmax(0, 1fr); }
}
@media print {
  .erd-docs .d-act { display: none; }
  .erd-docs section.d-table, .erd-docs section.d-enum { break-inside: avoid; }
}`;

  const EXPORT_CSS = `
* { box-sizing: border-box; }
body { margin: 0; background: #fff; }
.x-wrap { display: grid; grid-template-columns: 240px minmax(0, 1fr); min-height: 100vh; }
.x-toc { position: sticky; top: 0; align-self: start; height: 100vh; overflow-y: auto; padding: 24px 16px; border-right: 1px solid #E1E6EC;
  background: #FAFBFC; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.x-toc b { display: block; margin: 14px 0 4px; font-size: 11.5px; color: #6B7785; }
.x-toc a { display: block; color: #1F2933; text-decoration: none; padding: 2px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.x-toc a:hover { color: #2F80ED; }
.x-foot { color: #6B7785; font-size: 12px; margin-top: 32px; }
@media (max-width: 760px) { .x-wrap { grid-template-columns: minmax(0, 1fr); } .x-toc { position: static; max-height: none; border-right: 0; border-bottom: 1px solid #E1E6EC; } }
@media print { .x-wrap { display: block; } .x-toc { display: none; } }`;

  // ------------------------------------------------------------- public
  let current = null;
  let observer = null;

  function render(container, model, opts = {}) {
    const ix = index(model);
    current = { model, ix };
    if (!document.getElementById('erd-docs-css')) {
      const st = document.createElement('style');
      st.id = 'erd-docs-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    container.innerHTML = build(model, ix, opts);
    if (observer) observer.disconnect();
    const minis = container.querySelectorAll('[data-mini]');
    const fill = (el) => { el.innerHTML = miniSVG(model, ix, el.getAttribute('data-mini')); };
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          fill(en.target);
          observer.unobserve(en.target);
        }
      }, { root: opts.scrollRoot || null, rootMargin: '400px 0px' });
      minis.forEach((m) => observer.observe(m));
    } else minis.forEach(fill);
  }

  function sectionFor(kind, key) {
    if (!current) return null;
    const id = current.ix.ids.get(`${kind}:${key}`);
    return id ? document.getElementById(id) : null;
  }

  function exportHTML(model, opts = {}) {
    const ix = index(model);
    const title = (model.project && model.project.name) || opts.title || 'Schema';
    const date = opts.date || new Date().toISOString().slice(0, 10);
    let toc = '<a href="#overview"><strong>Overview</strong></a>';
    if (model.groups.length) toc += `<b>Groups</b>${model.groups.map((g) => `<a href="#${ix.ids.get(`g:${g.name}`)}">${esc(g.name)}</a>`).join('')}`;
    toc += `<b>Tables</b>${model.tables.map((t) => `<a href="#${ix.ids.get(`t:${t.key}`)}">${esc(t.key)}</a>`).join('')}`;
    if (model.enums.length) toc += `<b>Enums</b>${model.enums.map((e) => `<a href="#${ix.ids.get(`e:${e.key}`)}">${esc(e.key)}</a>`).join('')}`;
    const body = build(model, ix, { export: true });
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — schema documentation</title>
<style>${CSS}
${EXPORT_CSS}</style>
</head>
<body>
<div class="x-wrap">
<nav class="x-toc" aria-label="Contents">${toc}</nav>
<main class="erd-docs">${body}
<p class="x-foot">Generated on ${esc(date)} with ERDLoom.</p>
</main>
</div>
</body>
</html>
`;
  }

  root.DBMLDocs = { render, exportHTML, sectionFor, miniSVG: (m, key) => miniSVG(m, index(m), key) };
})(typeof self !== 'undefined' ? self : this);
