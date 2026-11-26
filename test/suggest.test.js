const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../js/parser.js');
const { convert } = require('../js/importer.js');
const { suggestRefs, suggestGroups, toDbml, louvain, words, singular } = require('../js/suggest.js');

const rows = (lines) => convert(`database_name,schema_name,table_name,column_name,data_type,is_primary_key\n${lines.join('\n')}\n`).dbml;
const refText = (r) => `${r.from.table}.${r.from.column} ${r.op} ${r.to.table}.${r.to.column}`;

const SHOP = rows([
  'shop,public,customers,id,bigint,YES',
  'shop,public,customers,email,text,NO',
  'shop,public,customers,referred_by_customer_id,bigint,NO',
  'shop,public,addresses,id,bigint,YES',
  'shop,public,addresses,customer_id,bigint,NO',
  'shop,public,orders,id,bigint,YES',
  'shop,public,orders,customer_id,bigint,NO',
  'shop,public,orders,billing_address_id,bigint,NO',
  'shop,public,orders,status,varchar(20),NO',
  'shop,public,order_items,order_id,bigint,YES',
  'shop,public,order_items,product_id,bigint,YES',
  'shop,public,products,id,bigint,YES',
  'shop,public,products,category_id,int,NO',
  'shop,public,categories,id,int,YES',
  'shop,public,categories,parent_id,int,NO',
  'shop,public,invoices,invoice_id,bigint,YES',
  'shop,public,invoices,orderId,bigint,NO',
  'shop,public,payments,id,bigint,YES',
  'shop,public,payments,invoice_id,bigint,NO',
  'shop,public,auth_users,id,uuid,YES',
  'shop,public,auth_sessions,id,uuid,YES',
  'shop,public,auth_sessions,user_id,uuid,NO',
  'shop,public,auth_tokens,id,uuid,YES',
  'shop,public,auth_tokens,session_id,uuid,NO',
]);

test('words and singular forms', () => {
  assert.deepEqual(words('billingAddressID'), ['billing', 'address', 'id']);
  assert.deepEqual(words('Order-Items'), ['order', 'items']);
  assert.equal(singular('categories'), 'category');
  assert.equal(singular('addresses'), 'address');
  assert.equal(singular('boxes'), 'box');
  assert.equal(singular('people'), 'person');
  assert.equal(singular('status'), 'status');
});

test('suggests references from names, keys and types', () => {
  const refs = suggestRefs(parse(SHOP));
  const got = new Map(refs.map((r) => [refText(r), r]));
  for (const want of [
    'addresses.customer_id > customers.id',
    'orders.customer_id > customers.id',
    'order_items.order_id > orders.id',
    'order_items.product_id > products.id',
    'products.category_id > categories.id',
    'invoices.orderId > orders.id',
    'payments.invoice_id > invoices.invoice_id',
    'categories.parent_id > categories.id',
    'customers.referred_by_customer_id > customers.id',
    'orders.billing_address_id > addresses.id',
    'auth_sessions.user_id > auth_users.id',
    'auth_tokens.session_id > auth_sessions.id',
  ]) assert.ok(got.has(want), `missing ${want}`);
  assert.equal(got.get('orders.customer_id > customers.id').level, 'high');
  assert.equal(got.get('orders.billing_address_id > addresses.id').level, 'medium');
  assert.ok(got.get('orders.billing_address_id > addresses.id').reasons[0].includes('role: billing'));
  // status is varchar and nothing is called "statuses": no suggestion
  assert.ok(!refs.some((r) => r.from.column === 'status'));
  // a table's own id column never points anywhere
  assert.ok(!refs.some((r) => r.from.column === 'id'));
});

test('type mismatches are dropped and missing primary keys lower confidence', () => {
  const src = rows([
    'd,s,users,id,uuid,YES',
    'd,s,posts,id,int,YES',
    'd,s,posts,user_id,int,NO',      // int -> uuid: not a match
    'd,s,teams,id,int,NO',           // no declared primary key
    'd,s,posts,team_id,int,NO',
  ]);
  const refs = suggestRefs(parse(src));
  assert.ok(!refs.some((r) => r.from.column === 'user_id'));
  const team = refs.find((r) => r.from.column === 'team_id');
  assert.equal(team.to.column, 'id');
  assert.ok(team.confidence < 0.8);
  assert.ok(team.reasons.some((x) => /no primary key/.test(x)));
});

test('one-to-one when the referencing column is the primary key or unique', () => {
  const src = 'Table users { id int [pk] }\nTable user_profiles { user_id int [pk]\n bio text }\nTable passports { id int [pk]\n user_id int [unique] }';
  const refs = suggestRefs(parse(src));
  assert.equal(refs.find((r) => r.from.table === 'user_profiles').op, '-');
  assert.equal(refs.find((r) => r.from.table === 'passports').cardinality, 'one-to-one');
});

test('a primary key named after another table is not a target', () => {
  const src = 'Table tools { id int [pk] }\nTable tool_manuals { tool_id int [pk]\n url text }\nTable bookings { id int [pk]\n tool_id int }';
  const refs = suggestRefs(parse(src));
  assert.deepEqual(refs.map(refText).sort(), ['bookings.tool_id > tools.id', 'tool_manuals.tool_id - tools.id']);
});

test('existing references are not suggested again', () => {
  const src = 'Table users { id int [pk] }\nTable posts { id int [pk]\n user_id int [ref: > users.id]\n editor_user_id int }';
  const refs = suggestRefs(parse(src));
  assert.deepEqual(refs.map(refText), ['posts.editor_user_id > users.id']);
});

test('prefers the same schema when a table name exists in several', () => {
  const src = 'Table sales.customers { id int [pk] }\nTable crm.customers { id int [pk] }\nTable sales.orders { id int [pk]\n customer_id int }';
  const refs = suggestRefs(parse(src));
  assert.deepEqual(refs.map(refText), ['sales.orders.customer_id > sales.customers.id']);
});

test('louvain splits two linked cliques', () => {
  const e = [[0, 1, 1], [1, 2, 1], [0, 2, 1], [3, 4, 1], [4, 5, 1], [3, 5, 1], [2, 3, 1]];
  const c = louvain(6, e);
  assert.equal(c[0], c[1]); assert.equal(c[1], c[2]);
  assert.equal(c[3], c[4]); assert.equal(c[4], c[5]);
  assert.notEqual(c[0], c[3]);
});

test('groups from relationships and shared prefixes', () => {
  const m = parse(SHOP);
  const refs = suggestRefs(m).filter((r) => r.level !== 'low');
  const { groups } = suggestGroups(m, refs);
  const auth = groups.find((g) => g.name === 'auth');
  assert.ok(auth, 'auth group');
  assert.deepEqual(auth.tables, ['auth_users', 'auth_sessions', 'auth_tokens']);
  const orders = groups.find((g) => g.tables.includes('orders'));
  assert.ok(orders.tables.includes('customers'));
  assert.ok(!orders.tables.includes('auth_users'));
  // every table appears in at most one group
  const all = groups.flatMap((g) => g.tables);
  assert.equal(new Set(all).size, all.length);
});

test('tables already in a group are left out, and tiny schemas get no groups', () => {
  const m = parse(`${SHOP}\nTableGroup billing { invoices\n payments }\n`);
  const res = suggestGroups(m, suggestRefs(m));
  assert.equal(res.skipped, 2);
  assert.ok(!res.groups.some((g) => g.tables.includes('invoices')));
  assert.ok(!res.groups.some((g) => g.name === 'billing'));
  assert.deepEqual(suggestGroups(parse('Table a { id int }\nTable b { a_id int }')).groups, []);
});

test('accepted suggestions become DBML that parses with the schema', () => {
  const m = parse(SHOP);
  const refs = suggestRefs(m);
  const { groups } = suggestGroups(m, refs);
  const out = toDbml(m, refs, groups, { date: '2026-01-01' });
  assert.match(out, /^\/\/ Suggested/);
  assert.match(out, /^Ref: orders\.customer_id > customers\.id$/m);
  assert.ok(!/public\./.test(out));
  const after = parse(`${SHOP}\n${out}`);
  assert.equal(after.refs.length, refs.length);
  assert.equal(after.groups.length, groups.length);
  assert.equal(toDbml(m, [], []), '');
});

test('awkward names are quoted in the output', () => {
  const src = 'Table "Sales EU"."Order Lines" { id int [pk]\n "product id" int }\nTable "Sales EU".products { id int [pk] }';
  const m = parse(src);
  const refs = suggestRefs(m);
  assert.deepEqual(refs.map(refText), ['Sales EU.Order Lines.product id > Sales EU.products.id']);
  const out = toDbml(m, refs, []);
  assert.match(out, /Ref: "Sales EU"\."Order Lines"\."product id" > "Sales EU"\.products\.id/);
  assert.equal(parse(`${src}\n${out}`).refs.length, 1);
});
