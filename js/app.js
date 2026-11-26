(function () {
  'use strict';

  const KEY = (k) => `erdloom:${k}`;
  const store = {
    get(k) { try { return localStorage.getItem(KEY(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(KEY(k), v); } catch (e) { /* storage unavailable */ } },
    json(k, fallback) { try { return JSON.parse(this.get(k)) ?? fallback; } catch (e) { return fallback; } },
  };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const MOD = isMac ? '⌘' : 'Ctrl+';
  $('#kbd-k').textContent = `${MOD}K`;

  const status = $('#status');
  const errorBar = $('#error');
  const zoomLabel = $('#zoom-level');
  const split = $('#split');
  const filterInput = $('#filter');
  const outlineEl = $('#outline');
  const viewbar = $('#viewbar');

  // ------------------------------------------------------------------ state
  let positions = store.json('positions', {});
  let savedViews = store.json('views', []);         // [{ name, tables: [keys] }]
  let mode = store.json('mode', { type: 'all' });   // all | group | saved | focus
  let keysOnly = store.get('keysOnly') === '1';
  let fileName = store.get('fileName') || null;
  let model = null;
  let firstRender = true;
  let selected = null;
  let tab = store.get('tab') === 'docs' ? 'docs' : 'diagram';
  let needsFit = false;   // a fit was requested while the diagram was hidden
  const docsPane = $('#docs-pane');
  const docsEl = $('#docs');
  if (tab === 'docs') split.classList.add('docs');

  const diagram = new DBMLDiagram.Diagram($('#canvas'), {
    onPositionsChange: (p) => { positions = { ...positions, ...p }; savePositions(); },
    onZoom: (k) => { zoomLabel.textContent = `${Math.round(k * 100)}%`; },
    onOpen: (t, col) => goToCode(col ? col.line : t.line),
    onSelect: (t) => { selected = t ? t.key : null; renderOutline(); renderViewbar(); },
  });
  diagram.setKeysOnly(keysOnly);

  const editor = new DBMLEditor.Editor($('#editor'), { onChange: schedule });

  function savePositions() { store.set('positions', JSON.stringify(positions)); }

  // ------------------------------------------------------------- parsing
  let timer = null;
  function schedule() { clearTimeout(timer); timer = setTimeout(update, 220); }

  function update() {
    const src = editor.value;
    store.set('source', src);
    let next;
    try {
      next = DBML.parse(src);
    } catch (e) {
      if (!(e instanceof DBML.DBMLError)) console.error(e);
      showError(e);
      return;
    }
    clearError();
    model = next;
    const placed = {};
    const known = model.tables.filter((t) => positions[t.key]);
    const fresh = model.tables.filter((t) => !positions[t.key]);
    for (const t of known) placed[t.key] = { ...positions[t.key] };
    if (fresh.length) {
      // only lay out when there is something new to place, not on every keystroke
      const sizes = DBMLDiagram.measureTables(model, false);
      const auto = DBMLLayout.autoLayout(model, sizes, { aspect: canvasAspect() });
      if (known.length) {
        // new tables go to the right of what has already been arranged
        const maxX = Math.max(...known.map((t) => placed[t.key].x + sizes[t.key].w));
        const minY = Math.min(...known.map((t) => placed[t.key].y));
        const ax = Math.min(...fresh.map((t) => auto[t.key].x));
        const ay = Math.min(...fresh.map((t) => auto[t.key].y));
        for (const t of fresh) placed[t.key] = { x: auto[t.key].x - ax + maxX + 110, y: auto[t.key].y - ay + minY };
      } else {
        for (const t of fresh) placed[t.key] = { ...auto[t.key] };
      }
    }
    positions = { ...positions, ...placed };
    savePositions();
    if (selected && !model.tables.some((t) => t.key === selected)) selected = null;
    if (!modeIsValid(mode)) { mode = { type: 'all' }; store.set('mode', JSON.stringify(mode)); }
    diagram.visible = visibleFor(mode);
    diagram.setModel(model, placed);
    renderOutline();
    renderViewbar();
    renderDocname();
    const n = model.tables.length, r = model.refs.length, en = model.enums.length;
    status.textContent = `${n} table${n === 1 ? '' : 's'} · ${r} ref${r === 1 ? '' : 's'}${en ? ` · ${en} enum${en === 1 ? '' : 's'}` : ''}`;
    status.classList.remove('bad');
    renderDocs();
    if (firstRender) { firstRender = false; requestFit(); }
  }

  // Shape of the diagram area, so auto-layout fills it rather than a long strip.
  function canvasAspect() {
    const el = $('#canvas');
    // same margins as Diagram.fit(): 48px padding, and room for the minimap on wide canvases
    const w = el.clientWidth - 96 - (el.clientWidth > 700 ? 170 : 0), h = el.clientHeight - 96;
    return w > 50 && h > 50 ? w / h : 1.6;
  }

  function requestFit() {
    if (tab === 'docs') needsFit = true;
    else requestAnimationFrame(() => diagram.fit());
  }

  function showError(e) {
    const where = e.line ? `Line ${e.line}${e.col ? `, col ${e.col}` : ''}` : 'Error';
    errorBar.innerHTML = '';
    const b = document.createElement('button');
    b.className = 'err-loc';
    b.textContent = where;
    b.onclick = () => editor.goTo(e.line, e.col);
    errorBar.append(b, document.createTextNode(e.message));
    errorBar.hidden = false;
    editor.markError(e.line);
    status.textContent = 'Syntax error — showing last valid diagram';
    status.classList.add('bad');
  }
  function clearError() { errorBar.hidden = true; editor.markError(null); }

  function renderDocname() {
    const name = fileName || (model && model.project && model.project.name ? `${model.project.name}.dbml` : 'untitled.dbml');
    $('#docname').textContent = name;
  }

  // ------------------------------------------------------ views and focus
  function neighborsOf(key) {
    const out = new Set();
    for (const r of model.refs) {
      const [a, b] = r.endpoints;
      if (a.table === key) out.add(b.table);
      if (b.table === key) out.add(a.table);
    }
    return out;
  }

  function focusSet(key, hops) {
    const seen = new Set([key]);
    let frontier = [key];
    for (let h = 0; h < hops; h++) {
      const next = [];
      for (const k of frontier) for (const n of neighborsOf(k)) if (!seen.has(n)) { seen.add(n); next.push(n); }
      frontier = next;
    }
    return seen;
  }

  function visibleFor(m) {
    if (!model) return null;
    const exists = (k) => model.tables.some((t) => t.key === k);
    if (m.type === 'group') {
      const g = model.groups.find((x) => x.name === m.name);
      return g ? new Set(g.tables) : null;
    }
    if (m.type === 'saved') {
      const v = savedViews.find((x) => x.name === m.name);
      return v ? new Set(v.tables.filter(exists)) : null;
    }
    if (m.type === 'focus') return exists(m.key) ? focusSet(m.key, m.hops || 1) : null;
    return null;
  }

  function modeIsValid(m) {
    return m.type === 'all' || visibleFor(m) !== null;
  }

  function setMode(m, opts = {}) {
    mode = model && !modeIsValid(m) ? { type: 'all' } : m;
    store.set('mode', JSON.stringify(mode));
    diagram.setVisible(visibleFor(mode));
    if (mode.type === 'focus') { selected = mode.key; diagram.select(mode.key); }
    renderOutline();
    renderViewbar();
    if (opts.fit !== false) requestFit();
  }

  function focusOn(key, hops) { setMode({ type: 'focus', key, hops: hops || (mode.type === 'focus' ? mode.hops : 1) }); }

  function modeLabel(m) {
    if (m.type === 'group') return `Group: ${m.name}`;
    if (m.type === 'saved') return `View: ${m.name}`;
    if (m.type === 'focus') return `Focus: ${m.key}`;
    return 'All tables';
  }

  function saveView(name) {
    name = name.trim();
    if (!name || !model) return;
    const vis = diagram.visible ? [...diagram.visible] : model.tables.map((t) => t.key);
    savedViews = savedViews.filter((v) => v.name !== name).concat([{ name, tables: vis }]);
    store.set('views', JSON.stringify(savedViews));
    setMode({ type: 'saved', name }, { fit: false });
    toast(`Saved view “${name}”`);
  }

  function deleteView(name) {
    savedViews = savedViews.filter((v) => v.name !== name);
    store.set('views', JSON.stringify(savedViews));
    if (mode.type === 'saved' && mode.name === name) setMode({ type: 'all' });
    else renderOutline();
    toast(`Deleted view “${name}”`);
  }

  function setKeysOnly(on) {
    keysOnly = on;
    store.set('keysOnly', on ? '1' : '0');
    diagram.setKeysOnly(on);
    renderViewbar();
  }

  // ----------------------------------------------------------- view bar
  function renderViewbar() {
    if (!model) { viewbar.innerHTML = ''; return; }
    const total = model.tables.length;
    const shown = diagram.visible ? diagram.visible.size : total;
    let h = `<span class="chip chip-mode${mode.type === 'all' ? '' : ' on'}">${esc(modeLabel(mode))}${mode.type !== 'all' ? ` <span class="chip-count">${shown} of ${total}</span>` : ''}</span>`;
    if (mode.type === 'focus') {
      h += `<span class="seg" role="group" aria-label="Neighbour depth">${[1, 2, 3].map((n) => `<button data-hops="${n}" aria-pressed="${mode.hops === n}" title="Show tables up to ${n} step${n === 1 ? '' : 's'} away">±${n}</button>`).join('')}</span>`;
    }
    if (mode.type !== 'all') h += '<button class="chip" data-act="all" title="Esc">Show all</button>';
    if (selected && !(mode.type === 'focus' && mode.key === selected)) {
      h += `<button class="chip" data-act="focus-selected">Focus on ${esc(selected)}</button>`;
    }
    h += `<button class="chip" data-act="keys" aria-pressed="${keysOnly}" title="Show only primary and foreign key columns">Keys only</button>`;
    viewbar.innerHTML = h;
  }

  viewbar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.hops) focusOn(mode.key, +b.dataset.hops);
    else if (b.dataset.act === 'all') setMode({ type: 'all' });
    else if (b.dataset.act === 'focus-selected') focusOn(selected);
    else if (b.dataset.act === 'keys') setKeysOnly(!keysOnly);
  });

  // -------------------------------------------------------------- outline
  const FOCUS_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';

  function renderOutline() {
    if (!model) return;
    const q = filterInput.value.trim().toLowerCase();
    const vis = diagram.visible;
    let h = '';

    if (!q) {
      const views = [
        { label: 'All tables', meta: model.tables.length, m: { type: 'all' } },
        ...model.groups.map((g) => ({ label: g.name, meta: g.tables.length, m: { type: 'group', name: g.name }, color: g.color, kind: 'group' })),
        ...savedViews.map((v) => ({ label: v.name, meta: v.tables.filter((k) => model.tables.some((t) => t.key === k)).length, m: { type: 'saved', name: v.name }, kind: 'saved' })),
      ];
      h += '<div class="o-section">Views</div>';
      for (const v of views) {
        const active = mode.type === v.m.type && (mode.name || null) === (v.m.name || null);
        h += `<div class="o-row"><button class="o-item${active ? ' active' : ''}" data-mode="${esc(JSON.stringify(v.m))}">`;
        h += v.kind === 'group' ? `<span class="o-swatch group" style="border-color:${esc(v.color || '#7F8FA6')}"></span>` : v.kind === 'saved' ? '<span class="o-glyph">★</span>' : '<span class="o-glyph">▦</span>';
        h += `<span class="o-name">${esc(v.label)}</span><span class="o-meta">${v.meta}</span></button>`;
        if (v.kind === 'saved') h += `<button class="o-btn" data-delete-view="${esc(v.label)}" title="Delete view “${esc(v.label)}”" aria-label="Delete view ${esc(v.label)}">×</button>`;
        h += '</div>';
      }
      h += '<button class="o-add" data-act="save-view">+ Save current view…</button>';
    }

    const rows = [];
    for (const t of model.tables) {
      const nameHit = !q || t.key.toLowerCase().includes(q) || (t.alias || '').toLowerCase().includes(q);
      const cols = q ? t.columns.filter((c) => c.name.toLowerCase().includes(q)) : [];
      if (!nameHit && !cols.length) continue;
      rows.push({ t, cols: nameHit ? [] : cols });
    }
    h += `<div class="o-section">Tables <span class="o-meta">${q ? `${rows.length} of ` : ''}${model.tables.length}</span></div>`;
    for (const { t, cols } of rows) {
      const hidden = vis && !vis.has(t.key);
      h += `<div class="o-row${hidden ? ' hidden-in-view' : ''}"><button class="o-item${t.key === selected ? ' active' : ''}" data-table="${esc(t.key)}" title="${hidden ? 'Not in the current view — click to show all tables and go to it' : 'Go to table'}">`;
      h += `<span class="o-swatch" style="background:${esc(t.color || '#2F5D8A')}"></span><span class="o-name">${esc(t.key)}</span><span class="o-meta">${t.columns.length}</span></button>`;
      h += `<button class="o-btn" data-focus="${esc(t.key)}" title="Focus on ${esc(t.key)} and its neighbours" aria-label="Focus on ${esc(t.key)}">${FOCUS_ICON}</button></div>`;
      for (const c of cols) {
        h += `<button class="o-sub" data-table="${esc(t.key)}" data-col="${esc(c.name)}"><span class="o-name">${esc(c.name)}</span><span class="o-meta">${esc(c.type)}</span></button>`;
      }
    }

    const enums = model.enums.filter((e) => !q || e.key.toLowerCase().includes(q) || e.values.some((v) => v.name.toLowerCase().includes(q)));
    if (enums.length) {
      h += `<div class="o-section">Enums <span class="o-meta">${enums.length}</span></div>`;
      for (const e of enums) {
        h += `<div class="o-row"><button class="o-item" data-line="${e.line}" data-enum="${esc(e.key)}" title="Go to enum"><span class="o-glyph enum">E</span><span class="o-name">${esc(e.key)}</span><span class="o-meta">${e.values.length}</span></button></div>`;
      }
    }
    if (q && !rows.length && !enums.length) h += `<div class="o-empty">Nothing matches “${esc(q)}”.</div>`;
    outlineEl.innerHTML = h;
  }

  outlineEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.mode) {
      const m = JSON.parse(b.dataset.mode);
      if (tab === 'docs' && m.type === 'all') docsPane.scrollTop = 0;
      else if (tab === 'docs' && m.type === 'group') scrollDocsTo('g', m.name, true);
      else { if (tab === 'docs') setTab('diagram'); setMode(m); }
    } else if (b.dataset.deleteView) deleteView(b.dataset.deleteView);
    else if (b.dataset.act === 'save-view') openPalette('name-view');
    else if (b.dataset.focus) { if (tab === 'docs') setTab('diagram'); focusOn(b.dataset.focus); }
    else if (b.dataset.table) goToTable(b.dataset.table, b.dataset.col);
    else if (b.dataset.enum && tab === 'docs') scrollDocsTo('e', b.dataset.enum, true);
    else if (b.dataset.line) goToCode(+b.dataset.line);
  });
  filterInput.addEventListener('input', () => { renderOutline(); renderDocs({ top: true }); });
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { filterInput.value = ''; renderOutline(); renderDocs({ top: true }); filterInput.blur(); }
    if (e.key === 'Enter') { const first = outlineEl.querySelector('[data-table]'); if (first) first.click(); }
  });

  function goToTable(key, colName) {
    const t = model && model.tables.find((x) => x.key === key);
    if (!t) return;
    if (tab === 'docs') {
      selected = key;
      diagram.select(key);
      scrollDocsTo('t', key, true);
      renderOutline();
      return;
    }
    if (diagram.visible && !diagram.visible.has(key)) setMode({ type: 'all' }, { fit: false });
    selected = key;
    diagram.focusTable(key);
    renderOutline();
    renderViewbar();
    const col = colName && t.columns.find((c) => c.name === colName);
    goToCode(col ? col.line : t.line, true);
  }

  function goToCode(line, keepFocus) {
    if (tab === 'docs' && !split.classList.contains('docs-editor')) {
      if (keepFocus) return;
      toggleEditor(true);
    } else if (tab !== 'docs' && split.classList.contains('no-editor')) {
      if (keepFocus) return; // editor hidden: navigating the outline shouldn't reopen it
      toggleEditor(true);
    }
    const active = document.activeElement;
    editor.goTo(line);
    if (keepFocus && active && active !== document.body) active.focus();
  }

  // --------------------------------------------------------- panes
  function toggleRail(force) {
    const show = force ?? split.classList.contains('no-rail');
    split.classList.toggle('no-rail', !show);
    store.set('rail', show ? '1' : '0');
    requestAnimationFrame(() => diagram.applyView());
  }
  function toggleEditor(force) {
    if (tab === 'docs') {
      split.classList.toggle('docs-editor', force ?? !split.classList.contains('docs-editor'));
      return;
    }
    const show = force ?? split.classList.contains('no-editor');
    split.classList.toggle('no-editor', !show);
    store.set('editor', show ? '1' : '0');
    requestAnimationFrame(() => diagram.applyView());
  }
  if (store.get('rail') === '0') split.classList.add('no-rail');
  if (store.get('editor') === '0') split.classList.add('no-editor');

  // ------------------------------------------------------- command palette
  const palette = $('#palette');
  const pInput = $('#palette-input');
  const pList = $('#palette-list');
  let pItems = [];
  let pIndex = 0;
  let pMode = 'commands';

  function commands() {
    const list = [];
    const add = (group, label, run, hint) => list.push({ group, label, run, hint });
    if (model) {
      for (const t of model.tables) add('Table', t.key, () => goToTable(t.key), `${t.columns.length} columns`);
      for (const t of model.tables) add('Focus', `Focus on ${t.key}`, () => { if (tab === 'docs') setTab('diagram'); focusOn(t.key); }, 'and its neighbours');
      add('View', tab === 'docs' ? 'Switch to Diagram' : 'Switch to Docs', () => setTab(tab === 'docs' ? 'diagram' : 'docs'), 'D');
      add('View', 'Show all tables', () => { if (tab === 'docs') setTab('diagram'); setMode({ type: 'all' }); }, 'Esc');
      for (const g of model.groups) add('View', `Show group: ${g.name}`, () => { if (tab === 'docs') setTab('diagram'); setMode({ type: 'group', name: g.name }); }, `${g.tables.length} tables`);
      for (const v of savedViews) add('View', `Show view: ${v.name}`, () => { if (tab === 'docs') setTab('diagram'); setMode({ type: 'saved', name: v.name }); }, `${v.tables.length} tables`);
      add('View', 'Save current view as…', () => openPalette('name-view'));
      for (const v of savedViews) add('View', `Delete view: ${v.name}`, () => deleteView(v.name));
      for (const e of model.enums) add('Enum', `Go to enum ${e.key}`, () => (tab === 'docs' ? scrollDocsTo('e', e.key, true) : goToCode(e.line)));
      add('Display', keysOnly ? 'Show all columns' : 'Show key columns only', () => setKeysOnly(!keysOnly));
      add('Display', 'Fit diagram to screen', () => diagram.fit(), 'F');
      add('Display', 'Zoom to 100%', () => diagram.zoomTo(1), '1');
      add('Display', 'Auto-arrange tables', autoArrange);
      add('Schema', 'Suggest relationships and groups…', () => openSuggest(), 'from names and keys');
    }
    add('Display', split.classList.contains('no-rail') ? 'Show outline' : 'Hide outline', () => toggleRail(), `${MOD}B`);
    const editorShown = tab === 'docs' ? split.classList.contains('docs-editor') : !split.classList.contains('no-editor');
    add('Display', editorShown ? 'Hide code editor' : 'Show code editor', () => toggleEditor(), `${MOD}\\`);
    add('File', 'Import information schema (CSV or text)…', () => openImport());
    add('File', 'Open a .dbml file…', () => $('#file').click(), `${MOD}O`);
    add('File', 'Save DBML', saveDbml, `${MOD}S`);
    add('File', 'Export diagram as SVG', exportSvg);
    add('File', 'Export diagram as PNG', exportPng);
    add('File', 'Export docs as HTML page', exportDocs);
    add('File', 'Copy share link', share);
    add('File', 'Load the example schema (replaces your DBML)', loadExample);
    if (store.get('previous')) add('File', 'Restore previous DBML', restorePrevious);
    return list;
  }

  function score(label, q) {
    const l = label.toLowerCase();
    const i = l.indexOf(q);
    if (i >= 0) return i === 0 ? 0 : (' _.:'.includes(l[i - 1]) ? 1 : 2) + i / 1000;
    let j = 0;
    for (const ch of l) if (ch === q[j]) j++;
    return j === q.length ? 5 + l.length / 1000 : Infinity;
  }

  function renderPalette() {
    const raw = pInput.value.trim();
    const q = raw.toLowerCase();
    if (pMode === 'name-view') {
      const n = diagram.visible ? diagram.visible.size : (model ? model.tables.length : 0);
      pItems = raw ? [{ group: 'View', label: `Save view “${raw}”`, hint: `${n} tables`, run: () => saveView(raw) }] : [];
      if (!raw) pList.innerHTML = `<div class="p-empty">Type a name for the ${n} table${n === 1 ? '' : 's'} on screen, then press Enter.</div>`;
    } else {
      const all = commands();
      if (q) {
        pItems = all.map((c) => ({ c, s: score(c.label, q) })).filter((x) => x.s < Infinity)
          .sort((a, b) => a.s - b.s || a.c.label.length - b.c.label.length).slice(0, 60).map((x) => x.c);
      } else {
        // empty query: tables first, then views and commands
        pItems = all.filter((c) => c.group === 'Table').concat(all.filter((c) => !['Table', 'Focus', 'Enum'].includes(c.group)));
      }
      if (!pItems.length) pList.innerHTML = `<div class="p-empty">No tables or commands match “${esc(raw)}”.</div>`;
    }
    if (pItems.length) {
      pIndex = Math.max(0, Math.min(pIndex, pItems.length - 1));
      pList.innerHTML = pItems.map((c, i) => `<div class="p-item${i === pIndex ? ' sel' : ''}" role="option" data-i="${i}" aria-selected="${i === pIndex}"><span class="p-group">${esc(c.group)}</span><span class="p-label">${esc(c.label)}</span>${c.hint ? `<span class="p-hint">${esc(c.hint)}</span>` : ''}</div>`).join('');
      const sel = pList.querySelector('.sel');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }
  }

  let pReturnFocus = null;
  function openPalette(kind) {
    if (palette.hidden) pReturnFocus = document.activeElement;
    pMode = kind || 'commands';
    pInput.value = '';
    pInput.placeholder = pMode === 'name-view' ? 'Name this view' : 'Search tables, views and commands';
    pIndex = 0;
    palette.hidden = false;
    renderPalette();
    pInput.focus();
  }
  function closePalette() {
    palette.hidden = true;
    if (pReturnFocus && document.contains(pReturnFocus) && pReturnFocus !== document.body) pReturnFocus.focus();
    pReturnFocus = null;
  }
  function runPalette(i) {
    const item = pItems[i];
    if (!item) return;
    if (item.label === 'Save current view as…') { item.run(); return; }
    closePalette();
    item.run();
  }

  pInput.addEventListener('input', () => { pIndex = 0; renderPalette(); });
  pInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); pIndex = Math.min(pItems.length - 1, pIndex + 1); renderPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pIndex = Math.max(0, pIndex - 1); renderPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(pIndex); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  pList.addEventListener('mousemove', (e) => {
    const it = e.target.closest('.p-item');
    if (it && +it.dataset.i !== pIndex) {
      pList.querySelectorAll('.p-item.sel').forEach((n) => { n.classList.remove('sel'); n.setAttribute('aria-selected', 'false'); });
      it.classList.add('sel');
      it.setAttribute('aria-selected', 'true');
      pIndex = +it.dataset.i;
    }
  });
  pList.addEventListener('click', (e) => { const it = e.target.closest('.p-item'); if (it) runPalette(+it.dataset.i); });
  palette.addEventListener('pointerdown', (e) => { if (e.target === palette) closePalette(); });
  $('#btn-palette').onclick = () => openPalette();

  // ------------------------------------------------------------ actions
  function download(name, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const baseName = () => (fileName ? fileName.replace(/\.[^.]+$/, '') : (model && model.project && model.project.name) || 'schema');

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function saveDbml() { download(`${baseName()}.dbml`, editor.value, 'text/plain'); }
  function exportDocs() {
    if (!model) return;
    download(`${baseName()}-docs.html`, DBMLDocs.exportHTML(model), 'text/html');
  }
  function exportSvg() { if (model) download(`${baseName()}.svg`, diagram.toSVG().svg, 'image/svg+xml'); }
  async function exportPng() {
    if (!model) return;
    try { download(`${baseName()}.png`, await diagram.toPNG(2)); } catch (e) { toast(e.message); }
  }
  function autoArrange() {
    if (!model) return;
    const auto = DBMLLayout.autoLayout(model, DBMLDiagram.measureTables(model, false), { aspect: canvasAspect() });
    for (const k in auto) positions[k] = auto[k];
    savePositions();
    diagram.setModel(model, auto);
    diagram.fit();
  }
  async function share() {
    try {
      const url = `${location.href.split('#')[0]}#dbml=${await encode(editor.value)}`;
      history.replaceState(null, '', url);
      await navigator.clipboard.writeText(url);
      toast('Link copied to clipboard');
    } catch (e) {
      toast('Link is in the address bar — copy it from there');
    }
  }
  function loadExample() {
    const had = editor.value.trim() && editor.value !== DBML_SAMPLE;
    if (had) store.set('previous', editor.value);
    fileName = null;
    store.set('fileName', '');
    loadText(DBML_SAMPLE, true);
    if (had) toast(`Example loaded. To get your DBML back: ${MOD}K → Restore previous DBML`);
  }
  function restorePrevious() {
    const prev = store.get('previous');
    if (!prev) return;
    store.set('previous', editor.value);
    loadText(prev, true);
    toast('Previous DBML restored');
  }
  function loadText(text, resetLayout) {
    if (resetLayout) {
      positions = {};
      savePositions();
      firstRender = true;
      mode = { type: 'all' };
      store.set('mode', JSON.stringify(mode));
      selected = null;
    }
    editor.value = text;
    update();
  }
  async function openFile(f) {
    if (!f) return;
    if (editor.value.trim()) store.set('previous', editor.value);
    fileName = f.name;
    store.set('fileName', f.name);
    loadText(await f.text(), true);
  }

  $('#btn-open').onclick = () => $('#file').click();
  $('#file').onchange = (e) => { openFile(e.target.files[0]); e.target.value = ''; };
  $('#btn-save').onclick = saveDbml;
  $('#btn-share').onclick = share;
  $('#btn-layout').onclick = autoArrange;
  $('#btn-fit').onclick = () => diagram.fit();
  $('#btn-zoom-in').onclick = () => diagram.zoomBy(1.2);
  $('#btn-zoom-out').onclick = () => diagram.zoomBy(1 / 1.2);
  zoomLabel.onclick = () => diagram.zoomTo(1);

  const exportBtn = $('#btn-export'), exportMenu = $('#export-menu');
  const closeMenu = () => { exportMenu.hidden = true; exportBtn.setAttribute('aria-expanded', 'false'); };
  exportBtn.onclick = (e) => {
    e.stopPropagation();
    exportMenu.hidden = !exportMenu.hidden;
    exportBtn.setAttribute('aria-expanded', String(!exportMenu.hidden));
  };
  exportMenu.onclick = (e) => {
    const k = e.target.closest('[data-export]');
    if (!k) return;
    closeMenu();
    ({ svg: exportSvg, png: exportPng, docs: exportDocs, dbml: saveDbml })[k.dataset.export]();
  };
  document.addEventListener('click', closeMenu);

  // ------------------------------------------------- information schema
  const importModal = $('#import');
  const impText = $('#imp-text');
  const impInput = document.querySelector('.imp-input');
  const impSummary = $('#imp-summary');
  const impIssues = $('#imp-issues');
  const impPre = $('#imp-dbml');
  const impGroup = $('#imp-group');
  const impFileName = $('#imp-file-name');
  let impResult = null;
  let impSource = null;     // file name the rows came from, if any
  let impReturnFocus = null;
  let impTimer = null;

  const IMPORT_EXAMPLE = [
    'database_name,schema_name,table_name,column_name,data_type,is_primary_key',
    'campus,enrolment,students,id,integer,YES',
    'campus,enrolment,students,full_name,character varying(120),NO',
    'campus,enrolment,students,born_on,date,NO',
    'campus,enrolment,enrolments,student_id,integer,YES',
    'campus,enrolment,enrolments,course_id,integer,YES',
    'campus,enrolment,enrolments,grade,"numeric(4,1)",NO',
    'campus,catalog,courses,id,integer,YES',
    'campus,catalog,courses,title,text,NO',
    'campus,catalog,courses,starts_at,timestamp with time zone,NO',
  ].join('\n');

  const impMode = () => document.querySelector('input[name="imp-mode"]:checked').value;

  function renderImport() {
    impIssues.innerHTML = '';
    impPre.innerHTML = '';
    impSummary.classList.remove('bad');
    impResult = null;
    const text = impText.value;
    if (!text.trim()) {
      impSummary.innerHTML = 'The generated DBML will appear here.<span class="muted">This input has no foreign-key information. After importing you can review relationships suggested from column names.</span>';
      return;
    }
    const res = DBMLImport.convert(text, { groupBySchema: impGroup.checked });
    const issues = res.errors.map((m) => ({ m, err: true })).concat(res.warnings.map((m) => ({ m })));
    if (!res.errors.length) {
      // make sure the result (and the combined text, when adding) is valid DBML
      const candidate = impMode() === 'append' && editor.value.trim() ? `${editor.value.replace(/\s+$/, '')}\n\n${res.dbml}` : res.dbml;
      try {
        DBML.parse(candidate);
        impResult = { dbml: res.dbml, stats: res.stats };
      } catch (e) {
        const msg = impMode() === 'append'
          ? `Can't add to your current DBML: ${e.message}. Choose “Replace current DBML” or remove the clash first.`
          : `The generated DBML didn't parse: ${e.message} (line ${e.line}).`;
        issues.unshift({ m: msg, err: true });
      }
    }
    const shown = issues.slice(0, 12);
    impIssues.innerHTML = shown.map((i) => `<li class="${i.err ? 'err' : ''}">${esc(i.m)}</li>`).join('') +
      (issues.length > shown.length ? `<li>…and ${issues.length - shown.length} more.</li>` : '');
    if (res.stats) {
      const st = res.stats;
      const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
      impSummary.innerHTML = `<b>${plural(st.tables, 'table')}</b> · ${plural(st.columns, 'column')} · ${plural(st.schemas, 'schema')} · ${plural(st.databases, 'database')}` +
        '<span class="muted">No relationships in this input. Likely ones can be suggested from column names after importing.</span>';
      impPre.innerHTML = DBMLEditor.highlight(res.dbml);
    } else {
      impSummary.textContent = 'Nothing to import yet.';
    }
    if (!impResult) impSummary.classList.add('bad');
  }
  const scheduleImport = () => { clearTimeout(impTimer); impTimer = setTimeout(renderImport, 150); };

  async function openImport(file) {
    if (importModal.hidden) impReturnFocus = document.activeElement;
    if (!palette.hidden) closePalette();
    importModal.hidden = false;
    if (file) {
      impText.value = await file.text();
      impSource = file.name;
      impFileName.textContent = file.name;
    }
    renderImport();
    impText.focus();
  }
  function closeImport() {
    importModal.hidden = true;
    if (impReturnFocus && document.contains(impReturnFocus) && impReturnFocus !== document.body) impReturnFocus.focus();
  }
  function runImport() {
    renderImport();
    if (!impResult) { impText.focus(); return; }
    const { dbml, stats } = impResult;
    const n = `${stats.tables} table${stats.tables === 1 ? '' : 's'}`;
    if (impMode() === 'append' && editor.value.trim()) {
      editor.value = `${editor.value.replace(/\s+$/, '')}\n\n${dbml}`;
      update();
      toast(`Added ${n}`);
    } else {
      if (editor.value.trim()) store.set('previous', editor.value);
      fileName = impSource ? impSource.replace(/\.[^.]+$/, '.dbml') : null;
      store.set('fileName', fileName || '');
      loadText(dbml, true);
      toast(`Imported ${n}. To undo: ${MOD}K → Restore previous DBML`);
    }
    closeImport();
    if ($('#imp-suggest').checked) {
      // replacing: the layout was made without relationships, so arrange again once some are added
      const replaced = impMode() !== 'append';
      if (!openSuggest({ quiet: true, arrange: replaced })) toast(`Imported ${n}. No relationships or groups to suggest.`);
    }
  }

  impText.addEventListener('input', () => { impSource = null; impFileName.textContent = ''; scheduleImport(); });
  impGroup.addEventListener('change', renderImport);
  document.querySelectorAll('input[name="imp-mode"]').forEach((r) => r.addEventListener('change', renderImport));
  $('#imp-file-btn').onclick = () => $('#imp-file').click();
  $('#imp-file').onchange = (e) => { const f = e.target.files[0]; if (f) openImport(f); e.target.value = ''; };
  $('#imp-example').onclick = () => { impText.value = IMPORT_EXAMPLE; impSource = null; impFileName.textContent = 'Example rows (fictional)'; renderImport(); };
  $('#imp-close').onclick = closeImport;
  $('#imp-cancel').onclick = closeImport;
  $('#imp-go').onclick = runImport;
  $('#btn-import').onclick = () => openImport();
  importModal.addEventListener('pointerdown', (e) => { if (e.target === importModal) closeImport(); });
  impInput.addEventListener('dragover', () => impInput.classList.add('dragging'));
  impInput.addEventListener('dragleave', (e) => { if (!impInput.contains(e.relatedTarget)) impInput.classList.remove('dragging'); });

  // ------------------------------------------------------- suggestions
  // Rule-based Ref and TableGroup suggestions (js/suggest.js). Nothing is written
  // until the user ticks what they want and presses Add.
  const sgModal = $('#suggest');
  const sgIntro = $('#sg-intro');
  const sgRefs = $('#sg-refs');
  const sgGroups = $('#sg-groups');
  const sgGroupsNote = $('#sg-groups-note');
  const sgSummary = $('#sg-summary');
  const sgPre = $('#sg-dbml');
  const sgGo = $('#sg-go');
  const LEVEL = { high: 'High', medium: 'Medium', low: 'Low' };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  let sg = null;             // { model, refs, on, groups, groupOff, names, dbml, arrange }
  let sgReturnFocus = null;

  // Returns false (and opens nothing) when quiet and there is nothing to suggest.
  function openSuggest(opts = {}) {
    let m;
    try { m = DBML.parse(editor.value); } catch (e) {
      toast('Fix the syntax error first, then try Suggest again');
      return false;
    }
    const refs = DBMLSuggest.suggestRefs(m);
    sg = {
      model: m, refs, on: new Set(refs.filter((r) => r.level !== 'low').map((r) => r.id)),
      groups: [], groupOff: new Set(), names: new Map(), dbml: '', arrange: !!opts.arrange,
    };
    if (opts.quiet && !refs.length && !DBMLSuggest.suggestGroups(m).groups.length) { sg = null; return false; }
    if (!palette.hidden) closePalette();
    if (sgModal.hidden) sgReturnFocus = document.activeElement;
    sgModal.hidden = false;
    renderSuggest();
    sgGo.focus();
    return true;
  }

  function closeSuggest() {
    sgModal.hidden = true;
    sg = null;
    if (sgReturnFocus && document.contains(sgReturnFocus) && sgReturnFocus !== document.body) sgReturnFocus.focus();
  }

  function renderSuggest() {
    const { refs, on, model: m } = sg;
    const counts = { high: 0, medium: 0, low: 0 };
    refs.forEach((r) => counts[r.level]++);
    sgIntro.innerHTML = refs.length
      ? `Found ${plural(refs.length, 'possible relationship')} (${counts.high} high, ${counts.medium} medium, ${counts.low} low confidence) from column names, types and keys. A matching name is a hint, not proof, so check each one.`
      : `No likely relationships found. Suggestions look for columns such as <code>customer_id</code> that match a table name and its key, with compatible types.${m.refs.length ? ' Columns that already have a reference are skipped.' : ''}`;
    $('#sg-refs-head').hidden = !refs.length;
    const tref = (t, c) => `<code>${esc(t)}.${esc(c)}</code>`;
    sgRefs.innerHTML = refs.map((r, i) => `<li><label class="sg-item${on.has(r.id) ? ' on' : ''}">` +
      `<input type="checkbox" data-ref="${i}"${on.has(r.id) ? ' checked' : ''}>` +
      `<span class="sg-main"><span class="sg-conf ${r.level}" title="Confidence ${Math.round(r.confidence * 100)}%">${LEVEL[r.level]}</span>` +
      `${tref(r.from.table, r.from.column)}<span class="sg-arrow" aria-label="references">→</span>${tref(r.to.table, r.to.column)}` +
      `<span class="sg-card">${r.cardinality}</span></span>` +
      `<span class="sg-why">${esc(r.reasons.join(' · '))}</span></label></li>`).join('');
    renderSuggestGroups();
  }

  // Groups depend on which relationships are ticked, so they are worked out again on every change.
  function renderSuggestGroups() {
    const chosen = sg.refs.filter((r) => sg.on.has(r.id));
    const res = DBMLSuggest.suggestGroups(sg.model, chosen);
    sg.groups = res.groups;
    const notes = [];
    if (!res.groups.length) notes.push('No groups found. Groups come from relationships and shared name prefixes such as <code>auth_</code>, and need at least four tables that are not already in a TableGroup.');
    else notes.push('Clusters of tables that are closely connected to each other. Rename a group by editing its name.');
    if (res.skipped) notes.push(`${plural(res.skipped, 'table')} already in a TableGroup ${res.skipped === 1 ? 'is' : 'are'} left out.`);
    sgGroupsNote.innerHTML = notes.join(' ');
    sgGroups.innerHTML = res.groups.map((g, i) => {
      const checked = !sg.groupOff.has(g.id);
      const name = sg.names.get(g.id) ?? g.name;
      return `<li><label class="sg-item${checked ? ' on' : ''}">` +
        `<input type="checkbox" data-group="${i}"${checked ? ' checked' : ''}>` +
        `<span class="sg-main"><input class="sg-name" data-name="${i}" value="${esc(name)}" aria-label="Group name" spellcheck="false">` +
        `<span class="sg-card">${plural(g.tables.length, 'table')}</span></span>` +
        `<span class="sg-why"><span class="sg-tables">${g.tables.map(esc).join(', ')}</span>` +
        `${g.reasons.length ? `<br>${esc(g.reasons.join(' · '))}` : ''}</span></label></li>`;
    }).join('');
    renderSuggestPreview();
  }

  function chosenSuggestions() {
    const refs = sg.refs.filter((r) => sg.on.has(r.id));
    const groups = sg.groups.filter((g) => !sg.groupOff.has(g.id))
      .map((g) => ({ ...g, name: (sg.names.get(g.id) ?? g.name).trim() || g.name }));
    return { refs, groups };
  }

  function renderSuggestPreview() {
    const { refs, groups } = chosenSuggestions();
    sg.dbml = DBMLSuggest.toDbml(sg.model, refs, groups);
    sgSummary.classList.remove('bad');
    sgGo.disabled = !sg.dbml;
    sgGo.textContent = sg.dbml ? `Add ${[refs.length && plural(refs.length, 'relationship'), groups.length && plural(groups.length, 'group')].filter(Boolean).join(' and ')}` : 'Add to DBML';
    if (!sg.dbml) {
      sgSummary.innerHTML = 'Nothing selected.<span class="muted">Tick the suggestions you want; the DBML they add appears here.</span>';
      sgPre.innerHTML = '';
      return;
    }
    try {
      DBML.parse(`${editor.value.replace(/\s+$/, '')}\n\n${sg.dbml}`);
    } catch (e) {
      sgSummary.classList.add('bad');
      sgSummary.innerHTML = `This wouldn't parse: ${esc(e.message)}.`;
      sgGo.disabled = true;
    }
    if (!sgSummary.classList.contains('bad')) {
      sgSummary.innerHTML = `<b>${plural(refs.length, 'relationship')}</b> · ${plural(groups.length, 'group')}<span class="muted">Added to the end of your DBML.</span>`;
    }
    sgPre.innerHTML = DBMLEditor.highlight(sg.dbml);
  }

  function applySuggest() {
    if (!sg || !sg.dbml || sgGo.disabled) return;
    const { refs, groups } = chosenSuggestions();
    const arrange = sg.arrange;
    store.set('previous', editor.value);
    editor.value = `${editor.value.replace(/\s+$/, '')}\n\n${sg.dbml}`;
    update();
    if (arrange) autoArrange();
    closeSuggest();
    const what = [refs.length && plural(refs.length, 'relationship'), groups.length && plural(groups.length, 'group')].filter(Boolean).join(' and ');
    toast(`Added ${what}. To undo: ${MOD}K → Restore previous DBML`);
  }

  sgRefs.addEventListener('change', (e) => {
    const i = e.target.getAttribute('data-ref');
    if (i === null) return;
    const r = sg.refs[+i];
    if (e.target.checked) sg.on.add(r.id); else sg.on.delete(r.id);
    e.target.closest('.sg-item').classList.toggle('on', e.target.checked);
    renderSuggestGroups();
  });
  sgGroups.addEventListener('change', (e) => {
    const i = e.target.getAttribute('data-group');
    if (i === null) return;
    const g = sg.groups[+i];
    if (e.target.checked) sg.groupOff.delete(g.id); else sg.groupOff.add(g.id);
    e.target.closest('.sg-item').classList.toggle('on', e.target.checked);
    renderSuggestPreview();
  });
  sgGroups.addEventListener('input', (e) => {
    const i = e.target.getAttribute('data-name');
    if (i === null) return;
    sg.names.set(sg.groups[+i].id, e.target.value);
    renderSuggestPreview();
  });
  // typing a name shouldn't toggle the group's checkbox
  sgGroups.addEventListener('click', (e) => { if (e.target.classList.contains('sg-name')) e.preventDefault(); });
  document.querySelectorAll('[data-pick]').forEach((b) => {
    b.onclick = () => {
      const pick = b.getAttribute('data-pick');
      const keep = { high: ['high'], medium: ['high', 'medium'], all: ['high', 'medium', 'low'], none: [] }[pick];
      sg.on = new Set(sg.refs.filter((r) => keep.includes(r.level)).map((r) => r.id));
      renderSuggest();
    };
  });
  $('#sg-close').onclick = closeSuggest;
  $('#sg-cancel').onclick = closeSuggest;
  sgGo.onclick = applySuggest;
  $('#btn-suggest').onclick = () => openSuggest();
  sgModal.addEventListener('pointerdown', (e) => { if (e.target === sgModal) closeSuggest(); });

  // --------------------------------------------------------------- docs
  function setTab(t) {
    tab = t;
    store.set('tab', t);
    split.classList.toggle('docs', t === 'docs');
    $('#tab-diagram').setAttribute('aria-selected', String(t === 'diagram'));
    $('#tab-docs').setAttribute('aria-selected', String(t === 'docs'));
    if (t === 'docs') {
      renderDocs();
      if (selected) scrollDocsTo('t', selected, false);
    } else {
      requestAnimationFrame(() => {
        diagram.applyView();
        if (needsFit) { needsFit = false; diagram.fit(); }
        diagram.select(selected);
      });
    }
    renderOutline();
  }

  function renderDocs(opts = {}) {
    if (!model || tab !== 'docs') return;
    const top = docsPane.scrollTop;
    DBMLDocs.render(docsEl, model, { query: filterInput.value, scrollRoot: docsPane });
    docsPane.scrollTop = opts.top ? 0 : top;
  }

  function scrollDocsTo(kind, key, flash) {
    let el = DBMLDocs.sectionFor(kind, key);
    if (!el && filterInput.value) {
      filterInput.value = '';
      renderOutline();
      renderDocs();
      el = DBMLDocs.sectionFor(kind, key);
    }
    if (!el) return;
    spyPaused = true;
    el.scrollIntoView({ block: 'start' });
    setTimeout(() => { spyPaused = false; }, 120);
    if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }

  async function copyTableLink(key) {
    try {
      const url = `${location.href.split('#')[0]}#dbml=${await encode(editor.value)}&tab=docs&table=${encodeURIComponent(key)}`;
      await navigator.clipboard.writeText(url);
      toast(`Link to ${key} copied`);
    } catch (e) {
      toast('Could not copy the link here');
    }
  }

  docsEl.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-table], a[data-enum], a[data-group]');
    if (a) {
      e.preventDefault();
      if (a.dataset.table) {
        selected = a.dataset.table;
        diagram.select(selected);
        scrollDocsTo('t', selected, true);
        renderOutline();
      } else if (a.dataset.enum) scrollDocsTo('e', a.dataset.enum, true);
      else scrollDocsTo('g', a.dataset.group, true);
      return;
    }
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.show) {
      const key = b.dataset.show;
      selected = key;
      setTab('diagram');
      if (diagram.visible && !diagram.visible.has(key)) setMode({ type: 'all' }, { fit: false });
      requestAnimationFrame(() => diagram.focusTable(key));
      renderViewbar();
    } else if (b.dataset.copy) copyTableLink(b.dataset.copy);
    else if ('clearFilter' in b.dataset) { filterInput.value = ''; renderOutline(); renderDocs({ top: true }); }
  });

  // keep the outline's highlight on the table being read
  let spyPaused = false;
  let spyQueued = false;
  docsPane.addEventListener('scroll', () => {
    if (spyQueued || spyPaused) return;
    spyQueued = true;
    requestAnimationFrame(() => {
      spyQueued = false;
      const paneTop = docsPane.getBoundingClientRect().top;
      let key = null;
      for (const sec of docsEl.querySelectorAll('section.d-table')) {
        if (sec.getBoundingClientRect().top - paneTop <= 80) key = sec.getAttribute('data-key');
        else break;
      }
      if (key === selected) return;
      selected = key;
      outlineEl.querySelectorAll('.o-item[data-table]').forEach((n) => {
        const on = n.getAttribute('data-table') === key;
        n.classList.toggle('active', on);
        if (on) n.scrollIntoView({ block: 'nearest' });
      });
    });
  }, { passive: true });

  $('#tab-diagram').onclick = () => setTab('diagram');
  $('#tab-docs').onclick = () => setTab('docs');

  // ----------------------------------------------------------- keyboard
  const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (!sgModal.hidden) {
      if (k === 'escape') { e.preventDefault(); closeSuggest(); }
      else if (mod && k === 'enter') { e.preventDefault(); applySuggest(); }
      return;
    }
    if (!importModal.hidden) {
      if (k === 'escape') { e.preventDefault(); closeImport(); }
      else if (mod && k === 'enter') { e.preventDefault(); runImport(); }
      return;
    }
    if (mod && k === 'k') { e.preventDefault(); if (palette.hidden) openPalette(); else closePalette(); return; }
    if (!palette.hidden) return;
    if (mod && k === 's') { e.preventDefault(); saveDbml(); return; }
    if (mod && k === 'o') { e.preventDefault(); $('#file').click(); return; }
    if (mod && k === 'b') { e.preventDefault(); toggleRail(); return; }
    if (mod && e.key === '\\') { e.preventDefault(); toggleEditor(); return; }
    if (k === 'escape' && !exportMenu.hidden) { closeMenu(); return; }
    if (mod || e.altKey || typing(document.activeElement)) return;
    if (k === 'd') { e.preventDefault(); setTab(tab === 'docs' ? 'diagram' : 'docs'); }
    else if (k === 'f' && tab === 'diagram') { e.preventDefault(); diagram.fit(); }
    else if (k === '1' && tab === 'diagram') { e.preventDefault(); diagram.zoomTo(1); }
    else if (k === '/') { e.preventDefault(); if (split.classList.contains('no-rail')) toggleRail(true); filterInput.focus(); filterInput.select(); }
    else if (k === 'escape') {
      if (tab === 'docs') { if (filterInput.value) { filterInput.value = ''; renderOutline(); renderDocs({ top: true }); } }
      else if (mode.type !== 'all') setMode({ type: 'all' });
      else if (selected) { selected = null; diagram.select(null); renderOutline(); renderViewbar(); }
    }
  });

  // drag & drop a .dbml file anywhere
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dropping');
    impInput.classList.remove('dragging');
    const f = e.dataTransfer.files[0];
    if (!f || !sgModal.hidden) return;
    if (!importModal.hidden || /\.(csv|tsv)$/i.test(f.name) || /csv|tab-separated/.test(f.type)) openImport(f);
    else openFile(f);
  });

  // ---------------------------------------------------------- share links
  async function encode(text) {
    const bytes = new TextEncoder().encode(text);
    let data = bytes;
    const z = typeof CompressionStream !== 'undefined';
    if (z) {
      const cs = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(cs).arrayBuffer());
    }
    let bin = '';
    data.forEach((b) => { bin += String.fromCharCode(b); });
    return (z ? 'z' : 'r') + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function decode(s) {
    const b64 = s.slice(1).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (s[0] === 'z') {
      const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new TextDecoder().decode(await new Response(ds).arrayBuffer());
    }
    return new TextDecoder().decode(bytes);
  }

  // ------------------------------------------------------ editor resizer
  const editorPane = document.querySelector('.editor-pane');
  const setSplit = (w) => {
    const max = Math.max(280, window.innerWidth - (split.classList.contains('no-rail') ? 0 : 220) - 340);
    const clamped = Math.max(260, Math.min(max, w));
    split.style.setProperty('--editor-w', `${clamped}px`);
    return clamped;
  };
  const savedSplit = parseFloat(store.get('split'));
  if (savedSplit) setSplit(savedSplit);
  $('#resizer').addEventListener('pointerdown', (e) => {
    const r = $('#resizer');
    r.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const left = editorPane.getBoundingClientRect().left;
    const move = (ev) => { setSplit(ev.clientX - left); diagram.applyView(); };
    const up = (ev) => {
      store.set('split', String(setSplit(ev.clientX - left)));
      document.body.classList.remove('resizing');
      r.removeEventListener('pointermove', move);
      r.removeEventListener('pointerup', up);
    };
    r.addEventListener('pointermove', move);
    r.addEventListener('pointerup', up);
  });

  // ----------------------------------------------------------------- boot
  (async function boot() {
    let src = null;
    const m = /#dbml=([\w-]+)/.exec(location.hash);
    if (m) {
      try {
        src = await decode(m[1]);
        positions = {};
        mode = { type: 'all' };
        fileName = null;
      } catch (e) { toast('Could not read the shared link'); }
    }
    const tabParam = /[#&]tab=(docs|diagram)/.exec(location.hash);
    const tableParam = /[#&]table=([^&]+)/.exec(location.hash);
    if (tabParam) { tab = tabParam[1]; split.classList.toggle('docs', tab === 'docs'); }
    if (src == null) src = store.get('source');
    if (src == null || !src.trim()) src = DBML_SAMPLE;
    editor.value = src;
    update();
    if (tableParam) {
      try { selected = decodeURIComponent(tableParam[1]); } catch (e) { selected = null; }
      if (selected && !(model && model.tables.some((t) => t.key === selected))) selected = null;
    }
    setTab(tab);
  })();

  window.addEventListener('resize', () => { if (model) diagram.applyView(); });
})();
