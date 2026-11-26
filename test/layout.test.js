const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../js/parser.js');
const { autoLayout } = require('../js/layout.js');
const SAMPLE = require('../js/sample.js');

// Rough stand-in for the renderer's measureTables.
const sizesOf = (m) => Object.fromEntries(m.tables.map((t) => [t.key, { w: 220, h: 38 + 28 * t.columns.length }]));
const rect = (pos, sizes, k) => ({ x0: pos[k].x, y0: pos[k].y, x1: pos[k].x + sizes[k].w, y1: pos[k].y + sizes[k].h });
const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
function bounds(pos, sizes) {
  const rs = Object.keys(pos).map((k) => rect(pos, sizes, k));
  const w = Math.max(...rs.map((r) => r.x1)) - Math.min(...rs.map((r) => r.x0));
  const h = Math.max(...rs.map((r) => r.y1)) - Math.min(...rs.map((r) => r.y0));
  return { w, h };
}

// Four groups that all reference a shared "people" group, like a typical app schema.
function schema() {
  const out = ['Table people.users { id int [pk]\n name text }', 'Table people.teams { id int [pk]\n user_id int [ref: > people.users.id] }'];
  for (const g of ['billing', 'content', 'events', 'files']) {
    out.push(`Table ${g}.a { id int [pk]\n user_id int [ref: > people.users.id] }`);
    out.push(`Table ${g}.b { id int [pk]\n a_id int [ref: > ${g}.a.id] }`);
    out.push(`Table ${g}.c { id int [pk]\n b_id int [ref: > ${g}.b.id]\n team_id int [ref: > people.teams.id] }`);
    out.push(`TableGroup ${g} { ${g}.a\n ${g}.b\n ${g}.c }`);
  }
  out.push('TableGroup people { people.users\n people.teams }');
  out.push('Table loose_one { id int }\nTable loose_two { id int }');
  return parse(out.join('\n'));
}

test('every table gets a position and none overlap', () => {
  for (const m of [schema(), parse(SAMPLE)]) {
    const sizes = sizesOf(m);
    const pos = autoLayout(m, sizes);
    assert.equal(Object.keys(pos).length, m.tables.length);
    const ks = Object.keys(pos);
    for (let i = 0; i < ks.length; i++) {
      for (let j = i + 1; j < ks.length; j++) assert.ok(!hit(rect(pos, sizes, ks[i]), rect(pos, sizes, ks[j])), `${ks[i]} overlaps ${ks[j]}`);
    }
  }
});

test('group boxes hold only their own tables', () => {
  const m = schema();
  const sizes = sizesOf(m);
  const pos = autoLayout(m, sizes, { aspect: 1 });
  for (const g of m.groups) {
    const rs = g.tables.map((k) => rect(pos, sizes, k));
    // the box the renderer draws: 22px padding and a 30px label band
    const box = { x0: Math.min(...rs.map((r) => r.x0)) - 22, y0: Math.min(...rs.map((r) => r.y0)) - 52, x1: Math.max(...rs.map((r) => r.x1)) + 22, y1: Math.max(...rs.map((r) => r.y1)) + 22 };
    for (const t of m.tables) {
      if (!g.tables.includes(t.key)) assert.ok(!hit(rect(pos, sizes, t.key), box), `${t.key} is inside group ${g.name}`);
    }
  }
});

test('the layout follows the shape of the screen', () => {
  const m = schema();
  const sizes = sizesOf(m);
  const wide = bounds(autoLayout(m, sizes, { aspect: 2 }), sizes);
  const tall = bounds(autoLayout(m, sizes, { aspect: 0.6 }), sizes);
  assert.ok(wide.w / wide.h > tall.w / tall.h, `wide ${wide.w}x${wide.h}, tall ${tall.w}x${tall.h}`);
  assert.ok(wide.w / wide.h > 1.2);
  assert.ok(tall.w / tall.h < 1);
});

test('groups linked to another group are placed next to it', () => {
  const m = schema();
  const sizes = sizesOf(m);
  const pos = autoLayout(m, sizes, { aspect: 1.6 });
  const box = (keys) => {
    const rs = keys.map((k) => rect(pos, sizes, k));
    return { x0: Math.min(...rs.map((r) => r.x0)), y0: Math.min(...rs.map((r) => r.y0)), x1: Math.max(...rs.map((r) => r.x1)), y1: Math.max(...rs.map((r) => r.y1)) };
  };
  const gap = (a, b) => Math.max(0, a.x0 - b.x1, b.x0 - a.x1) + Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  const people = box(['people.users', 'people.teams']);
  for (const g of ['billing', 'content', 'events', 'files']) {
    const d = gap(people, box([`${g}.a`, `${g}.b`, `${g}.c`]));
    assert.ok(d < 400, `${g} is ${d}px from people`);
  }
});

test('same input, same layout; empty model is fine', () => {
  const m = schema();
  const sizes = sizesOf(m);
  assert.deepEqual(autoLayout(m, sizes), autoLayout(m, sizes));
  assert.deepEqual(autoLayout(parse(''), {}), {});
});

test('tables without groups or refs are packed, not strung out', () => {
  const m = parse(Array.from({ length: 30 }, (_, i) => `Table t${i} { id int }`).join('\n'));
  const sizes = sizesOf(m);
  const { w, h } = bounds(autoLayout(m, sizes, { aspect: 1.6 }), sizes);
  assert.ok(w / h > 0.8 && w / h < 3, `${w}x${h}`);
});
