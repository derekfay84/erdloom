const test = require('node:test');
const assert = require('node:assert/strict');
const { convert } = require('../js/importer.js');
const { parse } = require('../js/parser.js');

const CSV = `database_name,schema_name,table_name,column_name,data_type,is_primary_key
campus,enrolment,students,id,integer,YES
campus,enrolment,students,full_name,character varying(120),NO
campus,enrolment,students,born_on,date,
campus,enrolment,enrolments,student_id,integer,true
campus,enrolment,enrolments,course_id,integer,1
campus,enrolment,enrolments,"grade, final","numeric(4, 1)",false
campus,catalog,courses,id,integer,PRI
campus,catalog,courses,title,text,0
campus,catalog,courses,starts_at,timestamp with time zone,no
`;

test('converts CSV into DBML that the parser accepts', () => {
  const r = convert(CSV, { date: '2026-01-01' });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.stats, { databases: 1, schemas: 2, tables: 3, columns: 9 });
  const m = parse(r.dbml);
  assert.equal(m.project.name, 'campus');
  assert.deepEqual(m.tables.map((t) => t.key), ['enrolment.students', 'enrolment.enrolments', 'catalog.courses']);
  assert.equal(m.refs.length, 0);
  const students = m.tables[0];
  assert.equal(students.columns[0].pk, true);
  assert.equal(students.columns[1].type, 'character varying(120)');
  const enr = m.tables[1];
  assert.deepEqual(enr.columns.filter((c) => c.pk).map((c) => c.name), ['student_id', 'course_id']);
  assert.equal(enr.indexes[0].pk, true);
  assert.equal(enr.columns[2].name, 'grade, final');
  assert.equal(enr.columns[2].type, 'numeric(4,1)');
  assert.equal(m.tables[2].columns[2].type, 'timestamp with time zone');
  assert.deepEqual(m.groups.map((g) => g.name), ['enrolment', 'catalog']);
});

test('tab-separated text without a header, in the documented order', () => {
  const tsv = 'db\tpublic\tusers\tid\tbigint\tt\ndb\tpublic\tusers\temail\ttext\tf\n';
  const r = convert(tsv);
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings[0], /No header row/);
  const m = parse(r.dbml);
  assert.equal(m.tables[0].key, 'users');
  assert.equal(m.tables[0].columns[0].pk, true);
});

test('header columns in any order and case, extra columns ignored', () => {
  const txt = 'Table_Name;COLUMN_NAME;Data Type;is_primary_key;schema_name;database_name;ordinal\nt;a;int;Y;s;d;1\n';
  const r = convert(txt);
  assert.deepEqual(r.errors, []);
  assert.equal(parse(r.dbml).tables[0].key, 's.t');
});

test('multiple databases are kept apart', () => {
  const txt = 'database_name,schema_name,table_name,column_name,data_type,is_primary_key\nA,s,t,id,int,1\nB,s,t,id,int,1\n';
  const r = convert(txt);
  const m = parse(r.dbml);
  assert.deepEqual(m.tables.map((t) => t.key), ['A.s.t', 'B.s.t']);
  assert.equal(m.project, null);
  assert.ok(r.warnings.some((w) => /2 databases/.test(w)));
});

test('warnings and errors', () => {
  assert.match(convert('database_name,table_name\nx,y\n').errors[0], /missing schema_name/);
  assert.equal(convert('').stats.tables, 0);
  assert.match(convert('database_name,schema_name,table_name,column_name,data_type,is_primary_key\n').errors[0], /No usable rows/);
  const r = convert('database_name,schema_name,table_name,column_name,data_type,is_primary_key\nd,s,t,a,int,maybe\nd,s,t,a,int,no\nd,s,t,b,,no\nd,s,,c,int,no\n');
  assert.equal(r.warnings.length, 4);
  const m = parse(r.dbml);
  assert.deepEqual(m.tables[0].columns.map((c) => `${c.name}:${c.type}`), ['a:int', 'b:unknown']);
});

test('awkward names and types are quoted', () => {
  const r = convert('database_name,schema_name,table_name,column_name,data_type,is_primary_key\nmy db,"Sales ""EU""",Order Lines,"quote""d",USER-DEFINED,yes\n');
  const m = parse(r.dbml);
  assert.equal(m.project.name, 'my db');
  assert.equal(m.tables[0].key, 'Sales "EU".Order Lines');
  assert.equal(m.tables[0].columns[0].name, 'quote"d');
  assert.equal(m.tables[0].columns[0].type, 'USER-DEFINED');
});
