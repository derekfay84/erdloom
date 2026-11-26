/*
 * Information-schema importer: turns rows of
 *   database_name, schema_name, table_name, column_name, data_type, is_primary_key
 * (CSV, TSV or other delimited text) into DBML. No other information is used, so
 * no relationships are created here; js/suggest.js can propose them afterwards.
 * Works in the browser (window.DBMLImport) and in Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DBMLImport = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FIELDS = ['database_name', 'schema_name', 'table_name', 'column_name', 'data_type', 'is_primary_key'];
  const TRUE_RE = /^(true|t|yes|y|1|pri|primary|primary key|pk|x)$/i;
  const FALSE_RE = /^(false|f|no|n|0|-|null)?$/i;

  // ------------------------------------------------------------- delimited text
  function detectDelimiter(text) {
    const line = text.split(/\r?\n/).find((l) => l.trim()) || '';
    let best = ',', bestCount = 0;
    for (const d of [',', '\t', ';', '|']) {
      let count = 0, inQ = false;
      for (const ch of line) {
        if (ch === '"') inQ = !inQ;
        else if (ch === d && !inQ) count++;
      }
      if (count > bestCount) { best = d; bestCount = count; }
    }
    return best;
  }

  // RFC 4180-style parsing: quoted fields, "" escapes, newlines inside quotes.
  function parseDelimited(text, delim) {
    const rows = [];
    let row = [], field = '', inQ = false, line = 1, rowLine = 1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else {
          if (ch === '\n') line++;
          field += ch;
        }
        continue;
      }
      if (ch === '"' && field.trim() === '') { field = ''; inQ = true; }
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        rows.push({ cells: row, line: rowLine });
        row = []; field = ''; line++; rowLine = line;
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push({ cells: row, line: rowLine }); }
    return rows.filter((r) => r.cells.some((c) => c.trim() !== ''));
  }

  const normHeader = (s) => s.trim().replace(/^"|"$/g, '').toLowerCase().replace(/[\s-]+/g, '_');

  function readRows(text) {
    const errors = [], warnings = [];
    text = String(text || '').replace(/^﻿/, '');
    if (!text.trim()) return { rows: [], errors, warnings };
    const delim = detectDelimiter(text);
    const raw = parseDelimited(text, delim);
    if (!raw.length) return { rows: [], errors, warnings };

    let index = null, body = raw;
    const header = raw[0].cells.map(normHeader);
    if (FIELDS.some((f) => header.includes(f))) {
      const missing = FIELDS.filter((f) => !header.includes(f));
      if (missing.length) {
        errors.push(`The header row is missing ${missing.join(', ')}.`);
        return { rows: [], errors, warnings };
      }
      index = Object.fromEntries(FIELDS.map((f) => [f, header.indexOf(f)]));
      body = raw.slice(1);
    } else {
      index = Object.fromEntries(FIELDS.map((f, i) => [f, i]));
      warnings.push('No header row found, so the columns are read in the order database_name, schema_name, table_name, column_name, data_type, is_primary_key.');
    }

    const rows = [];
    for (const r of body) {
      const get = (f) => (r.cells[index[f]] ?? '').trim();
      const row = Object.fromEntries(FIELDS.map((f) => [f, get(f)]));
      if (r.cells.length < 4) { warnings.push(`Line ${r.line}: skipped — expected 6 values, found ${r.cells.length}.`); continue; }
      if (!row.table_name || !row.column_name) { warnings.push(`Line ${r.line}: skipped — table_name and column_name are required.`); continue; }
      const pk = row.is_primary_key;
      if (TRUE_RE.test(pk)) row.is_primary_key = true;
      else if (FALSE_RE.test(pk)) row.is_primary_key = false;
      else { warnings.push(`Line ${r.line}: is_primary_key “${pk}” not recognised, treated as false.`); row.is_primary_key = false; }
      if (!row.data_type) { warnings.push(`Line ${r.line}: ${row.table_name}.${row.column_name} has no data_type, so it is set to “unknown”.`); row.data_type = 'unknown'; }
      row.line = r.line;
      rows.push(row);
    }
    if (!rows.length && !errors.length) errors.push('No usable rows were found.');
    return { rows, errors, warnings, delimiter: delim };
  }

  // ------------------------------------------------------------------ DBML out
  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const quote = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const ident = (s) => (IDENT.test(s) ? s : quote(s));
  const SIMPLE_TYPE = /^[A-Za-z_][A-Za-z0-9_]*(\s*\(\s*[A-Za-z0-9_]+(\s*,\s*[A-Za-z0-9_]+)*\s*\))?(\[\])*$/;
  const typeText = (t) => (SIMPLE_TYPE.test(t) ? t.replace(/\s+/g, '') : quote(t));

  function toDbml(rows, opts = {}) {
    const warnings = [];
    const groupBySchema = opts.groupBySchema !== false;
    const databases = [...new Set(rows.map((r) => r.database_name))];
    const multiDb = databases.length > 1;

    // table key -> { qualifier, name, columns }
    const tables = new Map();
    for (const r of rows) {
      const schema = multiDb ? [r.database_name, r.schema_name].filter(Boolean).join('.') : r.schema_name;
      const key = `${schema}\u0000${r.table_name}`;
      if (!tables.has(key)) tables.set(key, { schema, db: r.database_name, name: r.table_name, columns: [], seen: new Set() });
      const t = tables.get(key);
      if (t.seen.has(r.column_name)) {
        warnings.push(`Line ${r.line}: duplicate column ${r.table_name}.${r.column_name} skipped.`);
        continue;
      }
      t.seen.add(r.column_name);
      t.columns.push({ name: r.column_name, type: r.data_type, pk: r.is_primary_key });
    }
    if (multiDb) warnings.push(`Rows come from ${databases.length} databases, so each table is qualified as “database.schema”.`);

    const tableRef = (t) => (t.schema ? `${ident(t.schema)}.${ident(t.name)}` : ident(t.name));
    const out = [];
    const today = opts.date || new Date().toISOString().slice(0, 10);
    out.push(`// Imported from information schema on ${today}.`);
    out.push('// This input has no foreign-key information, so no relationships are defined here.');
    out.push('');
    if (!multiDb && databases[0]) {
      out.push(`Project ${ident(databases[0])} {`);
      out.push("  Note: 'Imported from information schema'");
      out.push('}');
      out.push('');
    }

    let columns = 0;
    for (const t of tables.values()) {
      const pks = t.columns.filter((c) => c.pk);
      out.push(`Table ${tableRef(t)} {`);
      for (const c of t.columns) {
        columns++;
        out.push(`  ${ident(c.name)} ${typeText(c.type)}${pks.length === 1 && c.pk ? ' [pk]' : ''}`);
      }
      if (pks.length > 1) {
        out.push('');
        out.push('  indexes {');
        out.push(`    (${pks.map((c) => ident(c.name)).join(', ')}) [pk]`);
        out.push('  }');
      }
      out.push('}');
      out.push('');
    }

    const schemas = [...new Set([...tables.values()].map((t) => t.schema).filter(Boolean))];
    if (groupBySchema && schemas.length > 1) {
      for (const s of schemas) {
        out.push(`TableGroup ${ident(s)} {`);
        for (const t of tables.values()) if (t.schema === s) out.push(`  ${tableRef(t)}`);
        out.push('}');
        out.push('');
      }
    }

    return {
      dbml: out.join('\n').replace(/\n+$/, '\n'),
      stats: { databases: databases.filter(Boolean).length, schemas: schemas.length, tables: tables.size, columns },
      warnings,
    };
  }

  function convert(text, opts) {
    const read = readRows(text);
    if (read.errors.length) return { dbml: '', stats: null, errors: read.errors, warnings: read.warnings };
    const res = toDbml(read.rows, opts);
    return { dbml: res.dbml, stats: res.stats, errors: [], warnings: read.warnings.concat(res.warnings) };
  }

  return { convert, readRows, toDbml, parseDelimited, detectDelimiter, FIELDS };
});
