(function (root) {
  const SAMPLE = `// Welcome to ERDLoom! Edit the DBML on the left — the diagram updates as you type.
// Drag tables to arrange them, scroll to pan, pinch or Ctrl/⌘ + scroll to zoom.
// This example schema is fictional.

Project lending_library {
  database_type: 'PostgreSQL'
  Note: 'Fictional schema for a neighbourhood lending library'
}

Table patrons as P {
  id integer [pk, increment]
  display_name varchar [not null]
  email varchar [unique]
  home_branch_id int [ref: > branches.id]
  joined_on date [default: \`current_date\`]
  Note: 'People who hold a library card'
}

Table branches [headercolor: #0E7C86] {
  id integer [pk]
  branch_name varchar [not null]
  city varchar
  opens_at time
}

Table titles [headercolor: #B5562B] {
  id integer [pk]
  title varchar [not null]
  author varchar
  isbn varchar(13) [unique]
  format item_format
  published_year smallint
}

Table copies {
  id integer [pk]
  title_id integer [not null]
  branch_id integer [not null]
  barcode varchar [unique, note: 'Printed on the spine label']
  acquired_on date

  indexes {
    (title_id, branch_id) [name: 'copies_by_branch']
  }
}

Table loans {
  id integer [pk, increment]
  copy_id integer [not null]
  patron_id integer [not null]
  status loan_state [default: 'active']
  due_on date
}

Table holds {
  patron_id integer
  title_id integer
  placed_at timestamp [default: \`now()\`]

  indexes {
    (patron_id, title_id) [pk]
  }
}

Enum loan_state {
  active
  returned
  overdue [note: 'Past the due date and not yet returned']
  lost
}

Enum item_format {
  hardcover
  paperback
  audiobook
  ebook [note: 'Lent through a partner app']
}

Ref: copies.title_id > titles.id [delete: cascade]
Ref: copies.branch_id > branches.id
Ref: loans.copy_id > copies.id

Ref {
  loans.patron_id > P.id
  holds.patron_id > patrons.id
  holds.title_id > titles.id
}

TableGroup catalog [color: #B5562B] {
  titles
  copies
}
`;
  if (typeof module === 'object' && module.exports) module.exports = SAMPLE;
  else root.DBML_SAMPLE = SAMPLE;
})(typeof self !== 'undefined' ? self : this);
