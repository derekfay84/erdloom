/*
 * Automatic layout: parents (the "one" side of a ref) to the left, children to
 * the right, ordered within each column by barycenter to reduce crossings.
 * Disconnected parts of the schema are shelf-packed into rows.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DBMLLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GAP_X = 110;
  const GAP_Y = 44;
  const COMP_GAP = 120;

  function autoLayout(model, sizes) {
    const keys = model.tables.map((t) => t.key);
    const order = new Map(keys.map((k, i) => [k, i]));
    const parents = new Map(keys.map((k) => [k, new Set()]));
    const neighbors = new Map(keys.map((k) => [k, new Set()]));

    for (const r of model.refs) {
      let [a, b] = r.endpoints;
      if (a.table === b.table) continue;
      if (a.relation === '1' && b.relation === '*') [a, b] = [b, a];
      // a = child (many side), b = parent (one side)
      parents.get(a.table).add(b.table);
      neighbors.get(a.table).add(b.table);
      neighbors.get(b.table).add(a.table);
    }

    // connected components
    const comp = new Map();
    const comps = [];
    for (const k of keys) {
      if (comp.has(k)) continue;
      const members = [];
      const stack = [k];
      comp.set(k, comps.length);
      while (stack.length) {
        const x = stack.pop();
        members.push(x);
        for (const y of neighbors.get(x)) if (!comp.has(y)) { comp.set(y, comps.length); stack.push(y); }
      }
      members.sort((p, q) => order.get(p) - order.get(q));
      comps.push(members);
    }

    // rank = longest path from a root parent (cycles broken)
    const rank = new Map();
    const visiting = new Set();
    function rankOf(k) {
      if (rank.has(k)) return rank.get(k);
      if (visiting.has(k)) return 0;
      visiting.add(k);
      let r = 0;
      for (const p of parents.get(k)) r = Math.max(r, rankOf(p) + 1);
      visiting.delete(k);
      rank.set(k, r);
      return r;
    }
    keys.forEach(rankOf);

    const groups = (model.groups || []).map((g) => new Set(g.tables));
    const blocks = comps.map((members) => ({ members, ...layoutComponent(members, rank, neighbors, sizes, groups) }));

    // Components whose tables all sit in one TableGroup are packed together first,
    // so each group stays in one place and its box doesn't swallow other tables.
    const buckets = new Map();
    for (const b of blocks) {
      const gi = groups.findIndex((g) => b.members.every((k) => g.has(k)));
      const key = gi >= 0 ? `g${gi}` : `c${buckets.size}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(b);
    }
    const merged = [...buckets.values()].map((bs) => (bs.length === 1 ? bs[0] : pack(bs, GAP_Y)));
    const packed = pack(merged, COMP_GAP);
    const positions = {};
    for (const k in packed.pos) positions[k] = { x: Math.round(packed.pos[k].x), y: Math.round(packed.pos[k].y) };
    return positions;
  }

  // Shelf-pack blocks (biggest first) into rows about as wide as a square of their area.
  function pack(blocks, gap) {
    const sorted = blocks.slice().sort((p, q) => q.w * q.h - p.w * p.h);
    const area = sorted.reduce((a, b) => a + (b.w + gap) * (b.h + gap), 0);
    const maxRowW = Math.max(sorted.length ? sorted[0].w : 0, Math.sqrt(area) * 1.6);
    const pos = {};
    let x = 0, y = 0, rowH = 0, w = 0;
    for (const b of sorted) {
      if (x > 0 && x + b.w > maxRowW) { x = 0; y += rowH + gap; rowH = 0; }
      for (const k in b.pos) pos[k] = { x: b.pos[k].x + x, y: b.pos[k].y + y };
      w = Math.max(w, x + b.w);
      x += b.w + gap;
      rowH = Math.max(rowH, b.h);
    }
    return { pos, w, h: y + rowH, members: sorted.flatMap((b) => b.members || Object.keys(b.pos)) };
  }

  function layoutComponent(members, rank, neighbors, sizes, groups) {
    const minRank = Math.min(...members.map((k) => rank.get(k)));
    const cols = [];
    for (const k of members) {
      const r = rank.get(k) - minRank;
      (cols[r] = cols[r] || []).push(k);
    }
    for (let i = 0; i < cols.length; i++) cols[i] = cols[i] || [];

    // barycenter sweeps
    const idx = new Map();
    const reindex = () => cols.forEach((c) => c.forEach((k, i) => idx.set(k, i)));
    reindex();
    for (let pass = 0; pass < 4; pass++) {
      const range = pass % 2 === 0 ? [...cols.keys()].slice(1) : [...cols.keys()].reverse().slice(1);
      for (const ci of range) {
        const bary = new Map();
        for (const k of cols[ci]) {
          const ns = [...neighbors.get(k)].filter((n) => idx.has(n) && n !== k);
          bary.set(k, ns.length ? ns.reduce((s, n) => s + idx.get(n), 0) / ns.length : idx.get(k));
        }
        cols[ci].sort((a, b) => bary.get(a) - bary.get(b));
        reindex();
      }
    }

    const heights = cols.map((c) => c.reduce((s, k) => s + sizes[k].h, 0) + GAP_Y * Math.max(0, c.length - 1));
    const H = Math.max(...heights);
    const pos = {};
    let x = 0;
    cols.forEach((c, ci) => {
      const w = Math.max(...c.map((k) => sizes[k].w), 0);
      let y = (H - heights[ci]) / 2;
      for (const k of c) { pos[k] = { x, y }; y += sizes[k].h + GAP_Y; }
      x += w + GAP_X;
    });
    separateGroups(cols, pos, sizes, groups);
    const ys = members.map((k) => pos[k].y);
    const top = Math.min(...ys);
    for (const k of members) pos[k].y -= top;
    const h = Math.max(...members.map((k) => pos[k].y + sizes[k].h));
    return { pos, w: Math.max(0, x - GAP_X), h };
  }

  // Push tables that aren't in a TableGroup out of that group's box, then re-stack columns.
  function separateGroups(cols, pos, sizes, groups) {
    const PAD = 22, TOP = 30;
    for (let iter = 0; iter < 6; iter++) {
      let changed = false;
      for (const g of groups) {
        const ms = [...g].filter((k) => pos[k]);
        if (!ms.length) continue;
        const x0 = Math.min(...ms.map((k) => pos[k].x)) - PAD;
        const y0 = Math.min(...ms.map((k) => pos[k].y)) - PAD - TOP;
        const x1 = Math.max(...ms.map((k) => pos[k].x + sizes[k].w)) + PAD;
        const y1 = Math.max(...ms.map((k) => pos[k].y + sizes[k].h)) + PAD;
        for (const k in pos) {
          if (g.has(k)) continue;
          const p = pos[k], s = sizes[k];
          if (p.x < x1 && p.x + s.w > x0 && p.y < y1 && p.y + s.h > y0) {
            p.y = y1 + GAP_Y / 2;
            changed = true;
          }
        }
      }
      for (const c of cols) {
        c.sort((a, b) => pos[a].y - pos[b].y);
        for (let i = 1; i < c.length; i++) {
          const prev = pos[c[i - 1]], min = prev.y + sizes[c[i - 1]].h + GAP_Y;
          if (pos[c[i]].y < min) { pos[c[i]].y = min; changed = true; }
        }
      }
      if (!changed) break;
    }
  }

  return { autoLayout };
});
