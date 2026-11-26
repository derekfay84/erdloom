/*
 * Automatic layout, in two levels.
 *
 * 1. Tables are split into clusters: each TableGroup is one, and tables outside
 *    any group are clustered by how they connect to each other.
 * 2. Each cluster is laid out on its own: parents (the "one" side of a ref) to
 *    the left, children to the right, ordered within each column by barycenter
 *    to reduce crossings. Long columns wrap so a cluster stays roughly square.
 * 3. Clusters are then placed as blocks, one at a time, next to the clusters
 *    they share the most refs with, keeping the whole diagram compact and close
 *    to the shape of the screen. Blocks never overlap, so group boxes stay apart.
 *
 * autoLayout(model, sizes, { aspect }) -> { [tableKey]: { x, y } }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DBMLLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GAP_X = 110;        // between columns of a cluster
  const WRAP_GAP_X = 60;    // between the wrapped parts of one long column
  const GAP_Y = 44;         // between tables in a column
  const BLOCK_GAP = 90;     // between clusters
  // Must match the group box the renderer draws around a TableGroup's tables.
  const GROUP_PAD = 22, GROUP_TOP = 30;
  const GREEDY_LIMIT = 150; // above this many linked clusters, fall back to plain packing

  // How tall a column may get and how wide a band of columns may be, relative to
  // a cluster's area. No one setting suits every schema, so several are tried and
  // the layout that Fit can show largest on the screen wins.
  const TRIES = [[1.1, 1.3], [0.8, 1.6], [1.1, 1.6], [0.8, 1.3], [1.4, 2.0], [0.8, 1.0]];

  function autoLayout(model, sizes, opts = {}) {
    const aspect = opts.aspect > 0.3 && opts.aspect < 6 ? opts.aspect : 1.6;
    if (!model.tables.length) return {};
    const tries = model.tables.length > 400 ? TRIES.slice(0, 3) : TRIES;
    let best = null, bestZoom = -1;
    for (const [colF, bandF] of tries) {
      const pos = layoutOnce(model, sizes, aspect, colF, bandF);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const k in pos) {
        x0 = Math.min(x0, pos[k].x); y0 = Math.min(y0, pos[k].y);
        x1 = Math.max(x1, pos[k].x + sizes[k].w); y1 = Math.max(y1, pos[k].y + sizes[k].h);
      }
      // zoom at which Fit would show it on a screen 1 high and `aspect` wide
      const zoom = Math.min(aspect / (x1 - x0), 1 / (y1 - y0));
      if (zoom > bestZoom * 1.02) { best = pos; bestZoom = zoom; }
    }
    return best;
  }

  function layoutOnce(model, sizes, aspect, colF, bandF) {
    const keys = model.tables.map((t) => t.key);
    const order = new Map(keys.map((k, i) => [k, i]));
    const parents = new Map(keys.map((k) => [k, new Set()]));
    const neighbors = new Map(keys.map((k) => [k, new Set()]));
    const links = [];   // [child, parent] pairs between different tables

    for (const r of model.refs) {
      let [a, b] = r.endpoints;
      if (a.table === b.table || !parents.has(a.table) || !parents.has(b.table)) continue;
      if (a.relation === '1' && b.relation === '*') [a, b] = [b, a];
      // a = child (many side), b = parent (one side)
      parents.get(a.table).add(b.table);
      neighbors.get(a.table).add(b.table);
      neighbors.get(b.table).add(a.table);
      links.push([a.table, b.table]);
    }

    // ---- clusters: one per TableGroup, then connected parts of what's left
    const clusterOf = new Map();
    const clusters = [];
    for (const g of model.groups || []) {
      const members = g.tables.filter((k) => order.has(k) && !clusterOf.has(k));
      if (!members.length) continue;
      members.forEach((k) => clusterOf.set(k, clusters.length));
      clusters.push({ members, group: true });
    }
    for (const k of keys) {
      if (clusterOf.has(k)) continue;
      const members = [];
      const stack = [k];
      const id = clusters.length;
      clusterOf.set(k, id);
      while (stack.length) {
        const x = stack.pop();
        members.push(x);
        for (const y of neighbors.get(x)) if (!clusterOf.has(y)) { clusterOf.set(y, id); stack.push(y); }
      }
      clusters.push({ members, group: false });
    }

    // ---- lay out each cluster as a block with its own origin
    const blocks = clusters.map((c, i) => {
      c.members.sort((p, q) => order.get(p) - order.get(q));
      const inner = layoutCluster(c.members, parents, neighbors, sizes, aspect, colF, bandF);
      const pad = c.group ? { x: GROUP_PAD, top: GROUP_PAD + GROUP_TOP, bottom: GROUP_PAD } : { x: 0, top: 0, bottom: 0 };
      const pos = {};
      for (const k in inner.pos) pos[k] = { x: inner.pos[k].x + pad.x, y: inner.pos[k].y + pad.top };
      return { id: i, members: c.members, pos, w: inner.w + pad.x * 2, h: inner.h + pad.top + pad.bottom };
    });

    // ---- how strongly each pair of clusters is linked
    const weight = blocks.map(() => new Map());
    for (const [a, b] of links) {
      const ca = clusterOf.get(a), cb = clusterOf.get(b);
      if (ca === cb) continue;
      weight[ca].set(cb, (weight[ca].get(cb) || 0) + 1);
      weight[cb].set(ca, (weight[cb].get(ca) || 0) + 1);
    }

    const linked = blocks.filter((b) => weight[b.id].size);
    const loose = blocks.filter((b) => !weight[b.id].size);
    let placed;
    if (linked.length && linked.length <= GREEDY_LIMIT) {
      placed = placeBlocks(linked, weight, aspect);
      if (loose.length) {
        // unlinked clusters are packed together and placed as one more block
        const rest = pack(loose, BLOCK_GAP, aspect);
        const extra = { id: -1, pos: rest.pos, w: rest.w, h: rest.h };
        placed = placeBlocks([placed, extra].map((b, i) => ({ ...b, id: i })), [new Map(), new Map()], aspect);
      }
    } else {
      placed = pack(blocks, BLOCK_GAP, aspect);
    }

    const positions = {};
    for (const k in placed.pos) positions[k] = { x: Math.round(placed.pos[k].x), y: Math.round(placed.pos[k].y) };
    return positions;
  }

  // ------------------------------------------------------------- one cluster
  function layoutCluster(members, parents, neighbors, sizes, aspect, colF, bandF) {
    const inside = new Set(members);
    const nbrs = (k) => [...neighbors.get(k)].filter((n) => inside.has(n) && n !== k);

    // rank = longest path from a parent inside the cluster (cycles broken)
    const rank = new Map();
    const visiting = new Set();
    function rankOf(k) {
      if (rank.has(k)) return rank.get(k);
      if (visiting.has(k)) return 0;
      visiting.add(k);
      let r = 0;
      for (const p of parents.get(k)) if (inside.has(p)) r = Math.max(r, rankOf(p) + 1);
      visiting.delete(k);
      rank.set(k, r);
      return r;
    }
    members.forEach(rankOf);

    // tables with no refs inside the cluster go in a column of their own at the end
    const connected = members.filter((k) => nbrs(k).length);
    const alone = members.filter((k) => !nbrs(k).length);
    let cols = [];
    for (const k of connected) (cols[rank.get(k)] = cols[rank.get(k)] || []).push(k);
    cols = cols.filter(Boolean);

    // barycenter sweeps
    const idx = new Map();
    const reindex = () => cols.forEach((c) => c.forEach((k, i) => idx.set(k, i)));
    reindex();
    for (let pass = 0; pass < 4; pass++) {
      const range = pass % 2 === 0 ? [...cols.keys()].slice(1) : [...cols.keys()].reverse().slice(1);
      for (const ci of range) {
        const bary = new Map();
        for (const k of cols[ci]) {
          const ns = nbrs(k);
          bary.set(k, ns.length ? ns.reduce((s, n) => s + idx.get(n), 0) / ns.length : idx.get(k));
        }
        cols[ci].sort((a, b) => bary.get(a) - bary.get(b));
        reindex();
      }
    }
    if (alone.length) cols.push(alone);

    // The cluster should come out roughly the shape of the screen: wrap columns
    // that are too tall, and fold a long run of columns into stacked bands.
    const area = members.reduce((s, k) => s + (sizes[k].w + GAP_X / 2) * (sizes[k].h + GAP_Y), 0);
    const tallest = Math.max(...members.map((k) => sizes[k].h));
    const widest = Math.max(...members.map((k) => sizes[k].w));
    const limit = Math.max(tallest, Math.sqrt(area / aspect) * colF);
    const maxW = Math.max(widest, Math.sqrt(area * aspect) * bandF);
    const colH = (c) => c.reduce((s, k) => s + sizes[k].h, 0) + GAP_Y * Math.max(0, c.length - 1);
    const groupsOfCols = cols.map((c) => {
      const h = colH(c);
      if (h <= limit * 1.25 || c.length < 2) return [c];
      const parts = Math.min(c.length, Math.ceil(h / limit));
      const target = h / parts;
      const out = [[]];
      let acc = 0;
      for (const k of c) {
        const cur = out[out.length - 1];
        if (cur.length && acc + sizes[k].h / 2 > target && out.length < parts) { out.push([k]); acc = sizes[k].h + GAP_Y; }
        else { cur.push(k); acc += sizes[k].h + GAP_Y; }
      }
      return out;
    });

    // Split the column sequence into bands no wider than maxW, then stack the bands.
    const partW = (c) => Math.max(...c.map((k) => sizes[k].w), 0);
    const groupW = (parts) => parts.reduce((s, c) => s + partW(c), 0) + WRAP_GAP_X * (parts.length - 1);
    const bands = [[]];
    let bandW = 0;
    for (const parts of groupsOfCols) {
      const w = groupW(parts);
      if (bands[bands.length - 1].length && bandW + GAP_X + w > maxW) { bands.push([]); bandW = 0; }
      bandW += (bands[bands.length - 1].length ? GAP_X : 0) + w;
      bands[bands.length - 1].push(parts);
    }
    const pos = {};
    let top0 = 0;
    for (const band of bands) {
      const H = Math.max(...band.flat().map(colH));
      let x = 0;
      for (const parts of band) {
        parts.forEach((c, pi) => {
          let y = top0 + (H - colH(c)) / 2;
          for (const k of c) { pos[k] = { x, y }; y += sizes[k].h + GAP_Y; }
          x += partW(c) + (pi < parts.length - 1 ? WRAP_GAP_X : GAP_X);
        });
      }
      top0 += H + GAP_Y * 2;
    }
    const top = Math.min(...members.map((k) => pos[k].y));
    for (const k of members) pos[k].y -= top;
    const h = Math.max(...members.map((k) => pos[k].y + sizes[k].h));
    const w = Math.max(...members.map((k) => pos[k].x + sizes[k].w));
    return { pos, w, h };
  }

  // ------------------------------------------------------- placing clusters
  // Greedy placement: the most-linked block first, then each next block at the
  // free spot beside an already placed block that is closest to the blocks it
  // links to, while keeping the overall shape compact and near `aspect`.
  function placeBlocks(blocks, weight, aspect) {
    const W = (a, b) => weight[a.id] ? weight[a.id].get(b.id) || 0 : 0;
    const total = (b) => blocks.reduce((s, o) => s + W(b, o), 0);
    const left = blocks.slice().sort((p, q) => total(q) - total(p) || q.w * q.h - p.w * p.h);
    const done = [];
    const at = new Map();   // block -> { x, y }
    let box = null;         // bounding box of what's placed

    const overlaps = (x, y, b) => done.some((o) => {
      const p = at.get(o);
      return x < p.x + o.w + BLOCK_GAP - 1 && x + b.w + BLOCK_GAP - 1 > p.x && y < p.y + o.h + BLOCK_GAP - 1 && y + b.h + BLOCK_GAP - 1 > p.y;
    });

    while (left.length) {
      // next: the block most linked to what's placed (ties: bigger first)
      let bi = 0;
      if (done.length) {
        let best = -1;
        left.forEach((b, i) => {
          const s = done.reduce((acc, o) => acc + W(b, o), 0) * 1e6 + b.w * b.h;
          if (s > best) { best = s; bi = i; }
        });
      }
      const b = left.splice(bi, 1)[0];
      if (!done.length) {
        at.set(b, { x: 0, y: 0 });
        done.push(b);
        box = { x0: 0, y0: 0, x1: b.w, y1: b.h };
        continue;
      }
      const cands = [];
      for (const o of done) {
        const p = at.get(o);
        const xs = [p.x, p.x + (o.w - b.w) / 2, p.x + o.w - b.w];
        const ys = [p.y, p.y + (o.h - b.h) / 2, p.y + o.h - b.h];
        for (const y of ys) { cands.push({ x: p.x + o.w + BLOCK_GAP, y }); cands.push({ x: p.x - BLOCK_GAP - b.w, y }); }
        for (const x of xs) { cands.push({ x, y: p.y + o.h + BLOCK_GAP }); cands.push({ x, y: p.y - BLOCK_GAP - b.h }); }
      }
      let best = null, bestCost = Infinity;
      for (const c of cands) {
        if (overlaps(c.x, c.y, b)) continue;
        const cx = c.x + b.w / 2, cy = c.y + b.h / 2;
        let pull = 0;
        for (const o of done) {
          const w = W(b, o);
          if (!w) continue;
          const p = at.get(o);
          // gap between the two blocks, not their centres, so big blocks aren't penalised
          const dx = Math.max(0, Math.abs(cx - (p.x + o.w / 2)) - (b.w + o.w) / 2);
          const dy = Math.max(0, Math.abs(cy - (p.y + o.h / 2)) - (b.h + o.h) / 2);
          pull += w * (dx + dy);
        }
        const x0 = Math.min(box.x0, c.x), y0 = Math.min(box.y0, c.y);
        const x1 = Math.max(box.x1, c.x + b.w), y1 = Math.max(box.y1, c.y + b.h);
        const r = (x1 - x0) / (y1 - y0);
        const shape = Math.max(r / aspect, aspect / r);
        const cost = pull * 4 + Math.sqrt((x1 - x0) * (y1 - y0)) * shape;
        if (cost < bestCost) { bestCost = cost; best = c; }
      }
      at.set(b, best);
      done.push(b);
      box = { x0: Math.min(box.x0, best.x), y0: Math.min(box.y0, best.y), x1: Math.max(box.x1, best.x + b.w), y1: Math.max(box.y1, best.y + b.h) };
    }

    const pos = {};
    for (const b of done) {
      const p = at.get(b);
      for (const k in b.pos) pos[k] = { x: b.pos[k].x + p.x - box.x0, y: b.pos[k].y + p.y - box.y0 };
    }
    return { pos, w: box.x1 - box.x0, h: box.y1 - box.y0 };
  }

  // Shelf-pack blocks (biggest first) into rows, aiming for the given aspect ratio.
  function pack(blocks, gap, aspect) {
    const sorted = blocks.slice().sort((p, q) => q.w * q.h - p.w * p.h);
    const area = sorted.reduce((a, b) => a + (b.w + gap) * (b.h + gap), 0);
    const maxRowW = Math.max(sorted.length ? sorted[0].w : 0, Math.sqrt(area * aspect));
    const pos = {};
    let x = 0, y = 0, rowH = 0, w = 0;
    for (const b of sorted) {
      if (x > 0 && x + b.w > maxRowW) { x = 0; y += rowH + gap; rowH = 0; }
      for (const k in b.pos) pos[k] = { x: b.pos[k].x + x, y: b.pos[k].y + y };
      w = Math.max(w, x + b.w);
      x += b.w + gap;
      rowH = Math.max(rowH, b.h);
    }
    return { pos, w, h: y + rowH };
  }

  return { autoLayout };
});
