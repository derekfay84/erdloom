const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../js/parser.js');
const { groupColor, groupColorByName, GROUP_PALETTE } = require('../js/colors.js');

test('groups get different palette colours in order, and their own color wins', () => {
  const m = parse('Table a { id int }\nTable b { id int }\nTable c { id int }\nTableGroup one { a }\nTableGroup two [color: #123456] { b }\nTableGroup three { c }');
  const [one, two, three] = m.groups;
  assert.equal(groupColor(m, one), GROUP_PALETTE[0]);
  assert.equal(groupColor(m, two), '#123456');
  assert.equal(groupColor(m, three), GROUP_PALETTE[2]);
  assert.notEqual(groupColor(m, one), groupColor(m, three));
  assert.equal(groupColorByName(m, 'three'), GROUP_PALETTE[2]);
});

test('the palette has distinct colours and wraps around', () => {
  assert.equal(new Set(GROUP_PALETTE).size, GROUP_PALETTE.length);
  const src = Array.from({ length: GROUP_PALETTE.length + 1 }, (_, i) => `Table t${i} { id int }\nTableGroup g${i} { t${i} }`).join('\n');
  const m = parse(src);
  assert.equal(groupColor(m, m.groups[GROUP_PALETTE.length]), GROUP_PALETTE[0]);
});
