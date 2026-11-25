const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, DBMLError } = require('../js/parser.js');
const SAMPLE = require('../js/sample.js');

const err = (src) => {
  try { parse(src); } catch (e) { assert.ok(e instanceof DBMLError, `expected DBMLError, got ${e}`); return e; }
  assert.fail('expected a parse error');
};

test('parses the bundled sample', () => {
  const m = parse(SAMPLE);
  assert.equal(m.tables.length, 6);
  assert.equal(m.refs.length, 7);
  assert.equal(m.enums.length, 2);
  assert.equal(m.groups[0].tables.join(), 'titles,copies');
  assert.equal(m.project.name, 'lending_library');
  assert.equal(m.project.note, 'Fictional schema for a neighbourhood lending library');
});

test('columns, types and settings', () => {
  const m = parse(`Table t {
    id int [pk, increment]
    name varchar(255) [not null, unique, note: 'hi']
    price decimal(10,2) [default: -1.5]
    tags text[]
    at timestamp [default: \`now()\`]
    "first name" "character varying"
    kind status [default: 'a']
  }`);
  const [id, name, price, tags, at, first, kind] = m.tables[0].columns;
  assert.deepEqual([id.pk, id.increment], [true, true]);
  assert.equal(name.type, 'varchar(255)');
  assert.deepEqual([name.notNull, name.unique, name.note], [true, true, 'hi']);
  assert.equal(price.type, 'decimal(10,2)');
  assert.equal(price.default, '-1.5');
  assert.equal(tags.type, 'text[]');
  assert.equal(at.default, '`now()`');
  assert.equal(first.name, 'first name');
  assert.equal(first.type, 'character varying');
  assert.equal(kind.default, "'a'");
});

test('ref forms and relations', () => {
  const m = parse(`
    Table a { id int [pk] }
    Table b { id int [pk]
      a_id int [ref: > a.id] }
    Table c { x int
      y int }
    Ref name1: b.id - a.id
    Ref { c.x < a.id [delete: cascade] }
    Ref: c.(x, y) <> b.(id, a_id)
  `);
  assert.equal(m.refs.length, 4);
  const byOp = Object.fromEntries(m.refs.map((r) => [r.op, r]));
  assert.deepEqual(byOp['>'].endpoints.map((e) => e.relation), ['*', '1']);
  assert.deepEqual(byOp['<'].endpoints.map((e) => e.relation), ['1', '*']);
  assert.equal(byOp['<'].onDelete, 'cascade');
  assert.equal(byOp['-'].name, 'name1');
  assert.deepEqual(byOp['<>'].endpoints[0].columns, ['x', 'y']);
  assert.equal(m.tables[1].columns[1].fk, true);
});

test('schemas, aliases and quoted names', () => {
  const m = parse(`
    Table public.users as U { id int [pk] }
    Table "audit"."log entries" { user_id int [ref: > U.id] }
    Ref: audit."log entries".user_id > public.users.id
  `);
  assert.equal(m.tables[0].key, 'users');
  assert.equal(m.tables[1].key, 'audit.log entries');
  assert.equal(m.refs.length, 2);
});

test('indexes, composite pk, notes, partials, comments', () => {
  const m = parse(`
    /* block
       comment */
    TablePartial base_template [headercolor: #ff0000] {
      id int [pk]
      created_at timestamp
    }
    Table t [note: 'table note'] {
      ~base_template
      a int // trailing comment
      b int
      Note {
        '''
          Multi-line
          note
        '''
      }
      indexes {
        (a, b) [pk]
        \`lower(a)\` [name: 'expr_idx']
        b [unique, type: hash]
      }
    }
    Note sticky { 'free floating' }
  `);
  const t = m.tables[0];
  assert.deepEqual(t.columns.map((c) => c.name), ['id', 'created_at', 'a', 'b']);
  assert.equal(t.color, '#ff0000');
  assert.equal(t.note, 'Multi-line\nnote');
  assert.equal(t.columns[2].pk, true);
  assert.equal(t.columns[3].unique, true);
  assert.equal(t.indexes[1].columns[0], '`lower(a)`');
  assert.equal(m.notes[0].text, 'free floating');
});

test('enum columns are linked', () => {
  const m = parse(`Enum s.status { a
   "b c" }
   Table t { x s.status }`);
  assert.equal(m.tables[0].columns[0].enum, 's.status');
  assert.equal(m.enums[0].values[1].name, 'b c');
  assert.equal(parse("Enum e { a [note: 'first'] }").enums[0].values[0].note, 'first');
});

test('useful errors with positions', () => {
  let e = err('Table users {\n  id int [pk\n}');
  assert.match(e.message, /Missing '\]'/);
  e = err('Table users {\n  id\n}');
  assert.match(e.message, /missing a type/);
  assert.equal(e.line, 2);
  e = err('Table a { id int }\nRef: a.id > b.id');
  assert.match(e.message, /Table 'b' not found/);
  assert.equal(e.line, 2);
  e = err('Table a { id int }\nRef: a.nope > a.id');
  assert.match(e.message, /Column 'nope' not found/);
  e = err('Table a { id int }\nTable a { id int }');
  assert.match(e.message, /defined more than once/);
  e = err('Table a {\n id int');
  assert.match(e.message, /Missing '\}'/);
  e = err('Tabel a {}');
  assert.match(e.message, /Unknown keyword 'Tabel'/);
  e = err("Table a { n varchar [note: 'oops] }");
  assert.match(e.message, /Unterminated string/);
});
