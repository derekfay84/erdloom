/*
 * Relationship and group suggestions, without AI.
 *
 * Works on a parsed model (DBML.parse) and uses only what the schema says:
 * table and column names, types and keys. Nothing is changed by this module; it
 * returns candidates with a confidence and the reasons behind it, and turns the
 * ones the user accepts into DBML.
 *
 *   suggestRefs(model)               -> [{ id, from, to, op, confidence, level, reasons }]
 *   suggestGroups(model, extraRefs)  -> { groups: [{ id, name, tables, reasons }], skipped }
 *   toDbml(model, refs, groups)      -> DBML text to append
 *
 * Works in the browser (window.DBMLSuggest) and in Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DBMLSuggest = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ words
  // "billingAddressID" -> ['billing', 'address', 'id']; "order-items" -> ['order', 'items']
  function words(name) {
    return String(name)
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  const IRREGULAR = { people: 'person', children: 'child', men: 'man', women: 'woman', mice: 'mouse', geese: 'goose', data: 'data', media: 'media', criteria: 'criterion', indices: 'index', statuses: 'status', analyses: 'analysis', addresses: 'address', businesses: 'business', aliases: 'alias' };
  const NO_PLURAL = /(ss|us|is|ics|news|series|species)$/;

  function singular(w) {
    if (IRREGULAR[w]) return IRREGULAR[w];
    if (w.length <= 3 || NO_PLURAL.test(w)) return w;
    if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (/(sses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
    if (/s$/.test(w)) return w.slice(0, -1);
    return w;
  }
  const stemKey = (ws) => ws.map((w, i) => (i === ws.length - 1 ? singular(w) : w)).join('_');

  // Prefixes some teams put on every table name; they say nothing about the table.
  const NOISE_PREFIX = new Set(['tbl', 'tb', 't', 'dim', 'fact', 'fct', 'stg', 'raw', 'src', 'ref', 'lkp', 'lu']);
  const tableWords = (name) => {
    const ws = words(name);
    while (ws.length > 1 && NOISE_PREFIX.has(ws[0])) ws.shift();
    return ws;
  };

  // Words that mark a column as pointing at something: customer_id, fk_customer, customer_fk.
  const KEY_WORDS = new Set(['id', 'fk', 'key', 'uuid', 'guid', 'ref', 'code', 'no', 'num', 'number']);
  // Leading words that point a column back at its own table: parent_id, previous_version_id.
  const SELF_ROLES = new Set(['parent', 'root', 'previous', 'prev', 'next', 'original', 'predecessor', 'successor', 'replaced', 'superseded', 'merged', 'duplicate', 'master']);

  // ------------------------------------------------------------------ types
  function typeFamily(t) {
    const s = String(t || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/\b(unsigned|signed|zerofill)\b/g, '').replace(/\[\]$/, '').trim();
    if (!s || s === 'unknown' || s === 'user-defined') return null;
    if (/^(tiny|small|medium|big)?int(eger)?\d*$|^int[248]$|^(small|big)?serial\d*$|^number$|^long$|^short$/.test(s)) return 'int';
    if (/^(numeric|decimal|dec)$/.test(s)) return 'decimal';
    if (/^(uuid|uniqueidentifier|guid)$/.test(s)) return 'uuid';
    if (/char|text|string|clob|citext/.test(s)) return 'string';
    if (/^(bool|boolean|bit)$/.test(s)) return 'bool';
    if (/date|time|interval/.test(s)) return 'time';
    if (/^(float\d*|real|double( precision)?|money)$/.test(s)) return 'float';
    if (/json|xml|bytea|blob|binary|geometry|geography|point|polygon/.test(s)) return 'other';
    return s;
  }
  const normType = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').replace(/^serial$/, 'integer').replace(/^bigserial$/, 'bigint').trim();

  // How well two column types fit a foreign key: a score adjustment and a phrase, or null if they can't.
  function typeFit(a, b) {
    const fa = typeFamily(a), fb = typeFamily(b);
    if (!fa || !fb) return { adj: -0.1, why: 'one side has no known type' };
    if (normType(a) === normType(b)) return { adj: 0.05, why: `both ${normType(a)}` };
    if (fa === fb) return { adj: 0, why: `compatible types (${a} → ${b})` };
    if ((fa === 'int' && fb === 'decimal') || (fa === 'decimal' && fb === 'int')) return { adj: -0.05, why: `numeric types (${a} → ${b})` };
    return null;
  }
  const KEYABLE = new Set(['int', 'decimal', 'uuid', 'string']);

  // --------------------------------------------------------------- targets
  // The columns a reference can point at: a single-column primary key, unique
  // columns, and a bare "id" when the table declares no primary key at all.
  function keyColumns(t) {
    const pks = t.columns.filter((c) => c.pk);
    const out = [];
    if (pks.length === 1) out.push({ col: pks[0], declared: true });
    for (const c of t.columns) if (c.unique && !c.pk) out.push({ col: c, declared: true });
    if (!pks.length) {
      const id = t.columns.find((c) => c.name.toLowerCase() === 'id');
      if (id && !out.some((o) => o.col === id)) out.push({ col: id, declared: false });
    }
    return out;
  }

  function tableIndex(model) {
    const full = new Map();     // stem of the whole name -> tables
    const tail = new Map();     // stem of the name without its first word(s): auth_users -> user
    const add = (m, k, t) => { if (!m.has(k)) m.set(k, []); if (!m.get(k).includes(t)) m.get(k).push(t); };
    for (const t of model.tables) {
      const ws = tableWords(t.name);
      add(full, stemKey(ws), t);
      if (t.alias) add(full, stemKey(words(t.alias)), t);
      for (let i = 1; i < ws.length; i++) add(tail, stemKey(ws.slice(i)), t);
    }
    return { full, tail };
  }

  // ------------------------------------------------------------ relationships
  function suggestRefs(model, opts = {}) {
    const minConfidence = opts.minConfidence ?? 0.3;
    const byKey = new Map(model.tables.map((t) => [t.key, t]));
    const idx = tableIndex(model);
    const keysOf = new Map(model.tables.map((t) => [t.key, keyColumns(t)]));
    const existing = new Set();
    for (const r of model.refs) {
      const [a, b] = r.endpoints;
      a.columns.forEach((c, i) => {
        existing.add(`${a.table}.${c}|${b.table}.${b.columns[i]}`);
        existing.add(`${b.table}.${b.columns[i]}|${a.table}.${c}`);
      });
    }

    const found = new Map();   // "from|to" -> candidate
    let hits = 0;              // candidates offered so far, to tell whether a column matched
    function offer(t, c, target, key, base, reasons) {
      if (target === t && key.col === c) return;
      const id = `${t.key}.${c.name}|${target.key}.${key.col.name}`;
      if (existing.has(id)) return;
      const fit = typeFit(c.type, key.col.type);
      if (!fit) return;
      let score = base + fit.adj;
      const why = reasons.slice();
      why.push(fit.why);
      if (!key.declared) { score -= 0.15; why.push(`${target.key} declares no primary key, so “${key.col.name}” is assumed`); }
      if ((t.schema || '') !== (target.schema || '')) { score -= 0.05; why.push('crosses schemas'); }
      const prev = found.get(id);
      if (prev && prev.score >= score) return;
      found.set(id, { t, c, target, key: key.col, score, reasons: why });
      hits++;
    }

    for (const t of model.tables) {
      const pks = t.columns.filter((c) => c.pk);
      for (const c of t.columns) {
        if (c.fk || c.enum) continue;              // already references something, or is an enum
        if (pks.length === 1 && c.pk && words(c.name).join('_') === 'id') continue;
        const fam = typeFamily(c.type);
        if (fam && !KEYABLE.has(fam)) continue;

        const hitsBefore = hits;
        let ws = words(c.name);
        if (ws[0] === 'fk' || ws[0] === 'id') ws = ws.slice(1);  // fk_customer, id_customer
        if (!ws.length) continue;

        // 1. Same name as another table's primary key: orders.customer_id -> customers.customer_id
        for (const other of model.tables) {
          if (other === t) continue;
          const pk = keysOf.get(other.key).find((k) => k.declared && k.col.pk);
          if (pk && pk.col.name.toLowerCase() === c.name.toLowerCase() && words(pk.col.name).length > 1) {
            // A key named after a different table is itself a reference (tool_manuals.tool_id is
            // about tools), so it isn't what other tool_id columns point at.
            const named = idx.full.get(stemKey(words(pk.col.name).slice(0, -1))) || [];
            if (named.length && !named.includes(other)) continue;
            offer(t, c, other, pk, 0.9, [`same name as the primary key of ${other.key}`]);
          }
        }

        // 2. Name built from a table name plus one of its key columns: customer_id -> customers.id,
        //    country_code -> countries.code, billing_address_id -> addresses.id
        const last = ws[ws.length - 1];
        const splits = [];
        if (KEY_WORDS.has(last) && ws.length > 1) splits.push({ stem: ws.slice(0, -1), keyWs: [last] });
        // single word with "id" glued on: customerid
        if (ws.length === 1 && /^[a-z]{3,}id$/.test(last)) splits.push({ stem: [last.slice(0, -2)], keyWs: ['id'] });
        if (!splits.length) splits.push({ stem: ws, keyWs: [] });   // bare table name: orders.customer

        // 3. parent_id, previous_id: back to the same table
        if (splits[0].keyWs[0] === 'id' && splits[0].stem.every((w) => SELF_ROLES.has(w))) {
          const pk = keysOf.get(t.key).find((x) => x.col.pk) || keysOf.get(t.key).find((x) => !x.declared);
          if (pk && pk.col !== c) offer(t, c, t, pk, 0.8, [`“${splits[0].stem.join('_')}” points back at its own table`]);
          continue;
        }

        for (const { stem, keyWs } of splits) {
          for (let start = 0; start < stem.length; start++) {
            const part = stem.slice(start);
            const role = stem.slice(0, start);
            const k = stemKey(part);
            const selfOk = role.length > 0;   // manager_employee_id, referred_by_customer_id
            const usable = (list) => (list || []).filter((x) => x !== t || selfOk);
            // a match on the whole table name beats one on the end of a name
            const pools = usable(idx.full.get(k)).length ? [[usable(idx.full.get(k)), 'full']] : [[usable(idx.tail.get(k)), 'tail']];
            for (const [tables, kind] of pools) {
              let pool = tables;
              if (!pool.length) continue;
              // prefer a match in the same schema when the name exists in several
              if (pool.length > 1) {
                const same = pool.filter((x) => (x.schema || '') === (t.schema || ''));
                if (same.length) pool = same;
              }
              for (const target of pool) {
                const keys = keysOf.get(target.key);
                let key;
                if (!keyWs.length) key = keys.find((x) => x.col.pk) || keys.find((x) => !x.declared);
                else {
                  key = keys.find((x) => words(x.col.name).join('_') === keyWs.join('_'))
                     || keys.find((x) => words(x.col.name).join('_') === [...part, ...keyWs].join('_'));
                  // customer_id -> customers.customer_number? no; but customer_id -> customers.pk when the key word is "id"
                  if (!key && keyWs[0] === 'id') key = keys.find((x) => x.col.pk && x.declared);
                }
                if (!key) continue;
                const self = target === t;
                let base, why;
                if (self) { base = role.some((w) => SELF_ROLES.has(w)) ? 0.8 : 0.72; why = `“${c.name}” points back at its own table (role: ${role.join('_')})`; }
                else if (!keyWs.length) { base = 0.55; why = `named after table ${target.key}`; }
                else if (role.length) { base = 0.72; why = `“${part.join('_')}” matches table ${target.key} (role: ${role.join('_')})`; }
                else { base = 0.85; why = `“${c.name}” matches table ${target.key}`; }
                if (kind === 'tail') { base -= 0.15; why += ` by the end of its name`; }
                if (pool.length > 1) { base -= 0.25; why += `; ${pool.length} tables could match`; }
                offer(t, c, target, key, base, [why]);
              }
            }
            // longest match wins: don't also try "address" once "billing_address" matched
            if (hits > hitsBefore) break;
          }
        }
      }
    }

    // One target per column: keep the best, unless two are equally likely.
    const perCol = new Map();
    for (const f of found.values()) {
      const k = `${f.t.key}.${f.c.name}`;
      if (!perCol.has(k)) perCol.set(k, []);
      perCol.get(k).push(f);
    }
    const out = [];
    for (const list of perCol.values()) {
      list.sort((a, b) => b.score - a.score);
      const best = list[0].score;
      for (const f of list) {
        if (f.score < best - 0.1) continue;
        const confidence = Math.max(0.05, Math.min(0.99, f.score));
        if (confidence < minConfidence) continue;
        const sole = f.t.columns.filter((x) => x.pk).length === 1 && f.c.pk;
        const oneToOne = sole || f.c.unique;
        out.push({
          id: `${f.t.key}.${f.c.name}>${f.target.key}.${f.key.name}`,
          from: { table: f.t.key, column: f.c.name },
          to: { table: f.target.key, column: f.key.name },
          op: oneToOne ? '-' : '>',
          cardinality: oneToOne ? 'one-to-one' : 'many-to-one',
          confidence: Math.round(confidence * 100) / 100,
          level: confidence >= 0.8 ? 'high' : confidence >= 0.6 ? 'medium' : 'low',
          reasons: f.reasons.concat(oneToOne ? [`${f.c.name} is ${sole ? 'the primary key' : 'unique'}, so one-to-one`] : []),
        });
      }
    }
    const order = new Map(model.tables.map((t, i) => [t.key, i]));
    out.sort((a, b) => b.confidence - a.confidence || order.get(a.from.table) - order.get(b.from.table) || a.from.column.localeCompare(b.from.column));
    return out;
  }

  // ------------------------------------------------------------------ groups
  // Louvain community detection on a weighted, undirected graph.
  // nodes: number of nodes; edges: [[a, b, w]]. Returns a community index per node.
  function louvain(n, edges, resolution = 1) {
    let comm = Array.from({ length: n }, (_, i) => i);
    let graph = { n, adj: buildAdj(n, edges) };
    let members = comm.map((i) => [i]);   // super-node -> original nodes
    for (let level = 0; level < 10; level++) {
      const local = onePass(graph, resolution);
      const ids = [...new Set(local)];
      if (ids.length === graph.n) break;  // nothing moved
      const remap = new Map(ids.map((c, i) => [c, i]));
      const nextMembers = ids.map(() => []);
      local.forEach((c, node) => nextMembers[remap.get(c)].push(...members[node]));
      const nextEdges = new Map();
      for (let a = 0; a < graph.n; a++) {
        for (const [b, w] of graph.adj[a]) {
          if (b < a) continue;
          const ca = remap.get(local[a]), cb = remap.get(local[b]);
          const k = ca < cb ? `${ca},${cb}` : `${cb},${ca}`;
          nextEdges.set(k, (nextEdges.get(k) || 0) + w);
        }
      }
      members = nextMembers;
      graph = { n: ids.length, adj: buildAdj(ids.length, [...nextEdges].map(([k, w]) => [...k.split(',').map(Number), w])) };
    }
    members.forEach((ms, c) => ms.forEach((node) => { comm[node] = c; }));
    return comm;
  }
  function buildAdj(n, edges) {
    const adj = Array.from({ length: n }, () => new Map());
    for (const [a, b, w] of edges) {
      adj[a].set(b, (adj[a].get(b) || 0) + w);
      if (a !== b) adj[b].set(a, (adj[b].get(a) || 0) + w);
    }
    return adj;
  }
  function onePass({ n, adj }, resolution) {
    const deg = adj.map((m, i) => { let s = 0; for (const [j, w] of m) s += j === i ? 2 * w : w; return s; });
    const m2 = deg.reduce((a, b) => a + b, 0);
    const comm = Array.from({ length: n }, (_, i) => i);
    if (!m2) return comm;
    const tot = deg.slice();
    let moved = true;
    for (let pass = 0; moved && pass < 50; pass++) {
      moved = false;
      for (let i = 0; i < n; i++) {
        const own = comm[i];
        const links = new Map();
        for (const [j, w] of adj[i]) if (j !== i) links.set(comm[j], (links.get(comm[j]) || 0) + w);
        tot[own] -= deg[i];
        let best = own, bestGain = (links.get(own) || 0) - resolution * tot[own] * deg[i] / m2;
        for (const [c, w] of links) {
          const gain = w - resolution * tot[c] * deg[i] / m2;
          if (gain > bestGain + 1e-12) { best = c; bestGain = gain; }
        }
        tot[best] += deg[i];
        if (best !== own) { comm[i] = best; moved = true; }
      }
    }
    return comm;
  }

  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const ident = (s) => (IDENT.test(s) ? s : quote(s));

  // extraRefs: suggested refs to treat as real (the ones the user has ticked).
  function suggestGroups(model, extraRefs = [], opts = {}) {
    const minSize = opts.minSize ?? 2;
    const grouped = new Set(model.groups.flatMap((g) => g.tables));
    const tables = model.tables.filter((t) => !grouped.has(t.key));
    const skipped = model.tables.length - tables.length;
    if (tables.length < 4) return { groups: [], skipped };
    const index = new Map(tables.map((t, i) => [t.key, i]));
    const edges = [];
    const pairs = [];
    for (const r of model.refs) pairs.push([r.endpoints[0].table, r.endpoints[1].table]);
    for (const r of extraRefs) pairs.push([r.from.table, r.to.table]);
    const refCount = new Map();
    for (const [a, b] of pairs) {
      if (a === b || !index.has(a) || !index.has(b)) continue;
      edges.push([index.get(a), index.get(b), 1]);
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      refCount.set(k, (refCount.get(k) || 0) + 1);
    }
    // Shared name prefixes (auth_users, auth_sessions) pull tables together a little.
    const prefixOf = new Map();
    const byPrefix = new Map();
    for (const t of tables) {
      const ws = tableWords(t.name);
      if (ws.length < 2) continue;
      prefixOf.set(t.key, ws[0]);
      if (!byPrefix.has(ws[0])) byPrefix.set(ws[0], []);
      byPrefix.get(ws[0]).push(t);
    }
    for (const list of byPrefix.values()) {
      if (list.length < 2 || list.length > 60 || list.length > tables.length * 0.8) continue;
      const w = 1.5 / (list.length - 1);
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) edges.push([index.get(list[i].key), index.get(list[j].key), w]);
    }
    if (!edges.length) return { groups: [], skipped };

    const comm = louvain(tables.length, edges);
    const buckets = new Map();
    comm.forEach((c, i) => { if (!buckets.has(c)) buckets.set(c, []); buckets.get(c).push(tables[i]); });
    const communities = [...buckets.values()].filter((ts) => ts.length >= minSize);
    if (communities.length < 2 && (communities[0] || []).length === tables.length) return { groups: [], skipped };

    const usedNames = new Set(model.groups.map((g) => g.name.toLowerCase()));
    const groups = [];
    for (const ts of communities) {
      const keys = new Set(ts.map((t) => t.key));
      let inside = 0, outside = 0;
      const degree = new Map(ts.map((t) => [t.key, 0]));
      for (const [a, b] of pairs) {
        if (a === b) continue;
        const ia = keys.has(a), ib = keys.has(b);
        if (ia && ib) { inside++; degree.set(a, degree.get(a) + 1); degree.set(b, degree.get(b) + 1); }
        else if (ia || ib) outside++;
      }
      // Name: a prefix most of the tables share, otherwise the best-connected table.
      const counts = new Map();
      for (const t of ts) { const p = prefixOf.get(t.key); if (p) counts.set(p, (counts.get(p) || 0) + 1); }
      const [topPrefix, topCount] = [...counts].sort((a, b) => b[1] - a[1])[0] || [null, 0];
      const reasons = [];
      let name;
      if (topPrefix && topCount >= Math.max(2, ts.length * 0.6)) {
        name = topPrefix;
        reasons.push(`${topCount} of ${ts.length} tables start with “${topPrefix}_”`);
      } else {
        const hub = ts.slice().sort((a, b) => degree.get(b.key) - degree.get(a.key) || a.key.localeCompare(b.key))[0];
        name = hub.name;
        if (topCount >= 2) reasons.push(`${topCount} tables start with “${topPrefix}_”`);
      }
      if (inside) reasons.unshift(`${inside} relationship${inside === 1 ? '' : 's'} inside the group, ${outside} to other tables`);
      name = String(name).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^(\d)/, '_$1') || 'group';
      let unique = name, n = 2;
      while (usedNames.has(unique.toLowerCase())) unique = `${name}_${n++}`;
      usedNames.add(unique.toLowerCase());
      const order = new Map(model.tables.map((t, i) => [t.key, i]));
      const sorted = ts.map((t) => t.key).sort((a, b) => order.get(a) - order.get(b));
      groups.push({ id: sorted.join(','), name: unique, tables: sorted, reasons });
    }
    groups.sort((a, b) => b.tables.length - a.tables.length || a.name.localeCompare(b.name));
    return { groups, skipped };
  }

  // ------------------------------------------------------------------- DBML
  function tableRef(model, key) {
    const t = model.tables.find((x) => x.key === key);
    if (!t) return ident(key);
    // "public" is the default schema, so it is left out, as the parser does
    return [...(t.schema && t.schema !== 'public' ? t.schema.split('.') : []), t.name].map(ident).join('.');
  }

  function toDbml(model, refs = [], groups = [], opts = {}) {
    if (!refs.length && !groups.length) return '';
    const out = [];
    const today = opts.date || new Date().toISOString().slice(0, 10);
    out.push(`// Suggested from column names, types and keys; reviewed and added on ${today}.`);
    for (const r of refs) {
      out.push(`Ref: ${tableRef(model, r.from.table)}.${ident(r.from.column)} ${r.op} ${tableRef(model, r.to.table)}.${ident(r.to.column)}`);
    }
    for (const g of groups) {
      if (out.length > 1) out.push('');
      out.push(`TableGroup ${ident(g.name)} {`);
      for (const k of g.tables) out.push(`  ${tableRef(model, k)}`);
      out.push('}');
    }
    return out.join('\n') + '\n';
  }

  return { suggestRefs, suggestGroups, toDbml, louvain, words, singular, typeFamily };
});
