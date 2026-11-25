/*
 * DBML parser — zero dependencies.
 * Works in the browser (window.DBML) and in Node (module.exports).
 *
 * Supports: Project, Table (schema.name, alias, settings, note, indexes),
 * TablePartial + ~injection, Ref (short, long, inline, composite), Enum,
 * TableGroup, sticky Note, comments, quoted identifiers, ''' multi-line strings.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DBML = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class DBMLError extends Error {
    constructor(message, line, col) {
      super(message);
      this.name = 'DBMLError';
      this.line = line || 1;
      this.col = col || 1;
    }
  }

  const OPS = new Set(['<', '>', '-', '<>']);
  const PUNCT = new Set(['{', '}', '[', ']', '(', ')', ',', ':', '.', '<', '>', '-', '~', '*']);

  // ---------------------------------------------------------------- tokenizer
  function dedent(raw) {
    const lines = raw.replace(/\r/g, '').split('\n');
    if (lines.length && lines[0].trim() === '') lines.shift();
    if (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length);
    const ind = indents.length ? Math.min(...indents) : 0;
    return lines.map((l) => l.slice(ind)).join('\n');
  }

  function tokenize(src) {
    const toks = [];
    const n = src.length;
    let i = 0, line = 1, col = 1;
    const adv = (k) => {
      for (let j = 0; j < k; j++) {
        if (src[i] === '\n') { line++; col = 1; } else col++;
        i++;
      }
    };
    const push = (type, value, l, c) => toks.push({ type, value, line: l, col: c });

    while (i < n) {
      const ch = src[i];
      const l = line, c = col;

      if (ch === '\n') { push('nl', '\n', l, c); adv(1); continue; }
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '﻿') { adv(1); continue; }

      if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') adv(1); continue; }
      if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end < 0) throw new DBMLError('Unterminated block comment', l, c);
        adv(end + 2 - i);
        continue;
      }

      if (src.startsWith("'''", i)) {
        const end = src.indexOf("'''", i + 3);
        if (end < 0) throw new DBMLError("Unterminated ''' string", l, c);
        const raw = src.slice(i + 3, end);
        adv(end + 3 - i);
        push('string', dedent(raw), l, c);
        continue;
      }

      if (ch === "'" || ch === '"') {
        let j = i + 1, out = '';
        while (j < n && src[j] !== ch) {
          if (src[j] === '\n') throw new DBMLError('Unterminated string', l, c);
          if (src[j] === '\\' && j + 1 < n) {
            const e = src[j + 1];
            out += e === 'n' ? '\n' : e === 't' ? '\t' : e;
            j += 2;
            continue;
          }
          out += src[j++];
        }
        if (j >= n) throw new DBMLError('Unterminated string', l, c);
        adv(j + 1 - i);
        push(ch === '"' ? 'qident' : 'string', out, l, c);
        continue;
      }

      if (ch === '`') {
        const end = src.indexOf('`', i + 1);
        if (end < 0) throw new DBMLError('Unterminated `expression`', l, c);
        push('expr', src.slice(i + 1, end), l, c);
        adv(end + 1 - i);
        continue;
      }

      if (ch === '#') {
        const m = /^#[0-9a-fA-F]{3,8}\b/.exec(src.slice(i, i + 10));
        if (!m) throw new DBMLError('Invalid color — expected something like #3498DB', l, c);
        push('color', m[0], l, c);
        adv(m[0].length);
        continue;
      }

      if (/[\w$ -￿]/.test(ch)) {
        const rest = src.slice(i);
        const num = /^\d+(\.\d+)?(?![\w$ -￿])/.exec(rest);
        if (num) { push('number', num[0], l, c); adv(num[0].length); continue; }
        const word = /^[\w$ -￿]+/.exec(rest)[0];
        push('ident', word, l, c);
        adv(word.length);
        continue;
      }

      if (ch === '<' && src[i + 1] === '>') { push('punct', '<>', l, c); adv(2); continue; }
      if (PUNCT.has(ch)) { push('punct', ch, l, c); adv(1); continue; }

      throw new DBMLError(`Unexpected character '${ch}'`, l, c);
    }
    return toks;
  }

  function describe(tok) {
    switch (tok.type) {
      case 'eof': return 'end of input';
      case 'nl': return 'end of line';
      case 'string': return 'a string';
      case 'qident': return `"${tok.value}"`;
      case 'expr': return 'an `expression`';
      default: return `'${tok.value}'`;
    }
  }

  // ------------------------------------------------------------------ parser
  class Parser {
    constructor(tokens) { this.t = tokens; this.p = 0; }

    eof() {
      const last = this.t[this.t.length - 1];
      return { type: 'eof', value: '', line: last ? last.line : 1, col: last ? last.col + String(last.value).length : 1 };
    }
    peek(k = 0) { return this.t[this.p + k] || this.eof(); }
    next() { const tok = this.peek(); if (tok.type !== 'eof') this.p++; return tok; }
    atEnd() { return this.p >= this.t.length; }
    skipNL() { while (this.peek().type === 'nl') this.p++; }
    isWord(word, k = 0) { const t = this.peek(k); return t.type === 'ident' && t.value.toLowerCase() === word; }
    isPunct(v, k = 0) { const t = this.peek(k); return t.type === 'punct' && t.value === v; }
    isName(k = 0) { const t = this.peek(k); return t.type === 'ident' || t.type === 'qident'; }
    isEOF() { return this.peek().type === 'eof'; }
    error(msg, tok = this.peek()) { return new DBMLError(msg, tok.line, tok.col); }

    expectPunct(v, what) {
      if (this.isPunct(v)) return this.next();
      throw this.error(`Expected '${v}'${what ? ' ' + what : ''} but found ${describe(this.peek())}`);
    }
    name(what) {
      if (this.isName()) return this.next().value;
      throw this.error(`Expected ${what || 'a name'} but found ${describe(this.peek())}`);
    }
    dottedName(what) {
      const parts = [this.name(what)];
      while (this.isPunct('.') && this.isName(1)) { this.next(); parts.push(this.next().value); }
      return parts;
    }
    stringValue() {
      const t = this.peek();
      if (t.type === 'string' || t.type === 'qident') return this.next().value;
      throw this.error(`Expected a string but found ${describe(t)}`);
    }
    endOfLine() {
      const t = this.peek();
      if (t.type === 'nl') { this.skipNL(); return; }
      if (t.type === 'eof' || (t.type === 'punct' && t.value === '}')) return;
      throw this.error(`Unexpected ${describe(t)}`);
    }
    openBlock(what) { this.skipNL(); this.expectPunct('{', what); }
    isNoteStart() { return this.isWord('note') && (this.isPunct(':', 1) || this.isPunct('{', 1)); }
    parseNoteBody() {
      if (this.isPunct(':')) { this.next(); return this.stringValue(); }
      this.expectPunct('{');
      this.skipNL();
      const s = this.stringValue();
      this.skipNL();
      this.expectPunct('}', 'to close Note');
      return s;
    }
    blockEnd(open, what) {
      this.skipNL();
      if (this.isPunct('}')) { this.next(); return true; }
      if (this.isEOF()) throw this.error(`Missing '}' to close ${what}`, open);
      return false;
    }

    parse() {
      const out = { project: null, tables: [], partials: [], refs: [], enums: [], groups: [], notes: [] };
      for (;;) {
        this.skipNL();
        const tok = this.peek();
        if (tok.type === 'eof') break;
        if (tok.type !== 'ident') {
          throw this.error(`Unexpected ${describe(tok)} — expected Table, Ref, Enum, TableGroup, Project or Note`);
        }
        switch (tok.value.toLowerCase()) {
          case 'project': out.project = this.parseProject(); break;
          case 'table': out.tables.push(this.parseTable(false)); break;
          case 'tablepartial': out.partials.push(this.parseTable(true)); break;
          case 'ref': out.refs.push(...this.parseRef()); break;
          case 'enum': out.enums.push(this.parseEnum()); break;
          case 'tablegroup': out.groups.push(this.parseGroup()); break;
          case 'note': out.notes.push(this.parseStickyNote()); break;
          case 'records': this.skipRecords(); break;
          default: throw this.error(`Unknown keyword '${tok.value}' — expected Table, Ref, Enum, TableGroup, Project or Note`);
        }
      }
      return out;
    }

    skipRecords() {
      const kw = this.next();
      while (!this.isPunct('{')) { if (this.isEOF()) throw this.error("Expected '{' after Records", kw); this.next(); }
      let depth = 0;
      do {
        const t = this.next();
        if (t.type === 'eof') throw this.error("Missing '}' to close Records", kw);
        if (t.type === 'punct' && t.value === '{') depth++;
        if (t.type === 'punct' && t.value === '}') depth--;
      } while (depth > 0);
    }

    parseProject() {
      const kw = this.next();
      const proj = { name: null, note: null, settings: {}, line: kw.line };
      if (this.isName()) proj.name = this.name();
      this.openBlock('to open Project');
      while (!this.blockEnd(kw, 'Project')) {
        if (this.isNoteStart()) { this.next(); proj.note = this.parseNoteBody(); this.endOfLine(); continue; }
        const key = this.name('a project setting');
        this.expectPunct(':');
        proj.settings[key] = this.next().value;
        this.endOfLine();
      }
      return proj;
    }

    parseTable(partial) {
      const kw = this.next();
      const label = partial ? 'TablePartial' : 'table';
      const parts = this.dottedName(`a ${label} name`);
      const table = { parts, alias: null, settings: [], items: [], indexes: [], note: null, line: kw.line, col: kw.col, partial };
      if (this.isWord('as')) { this.next(); table.alias = this.name('an alias'); }
      if (this.isPunct('[')) table.settings = this.parseSettings();
      this.openBlock(`to open ${label} '${parts.join('.')}'`);
      while (!this.blockEnd(kw, `${label} '${parts.join('.')}'`)) {
        const tok = this.peek();
        if (this.isNoteStart()) {
          this.next();
          table.note = this.parseNoteBody();
          this.endOfLine();
        } else if (this.isWord('indexes') && (this.isPunct('{', 1) || this.peek(1).type === 'nl')) {
          this.parseIndexes(table);
        } else if (this.isPunct('~')) {
          this.next();
          table.items.push({ kind: 'partial', name: this.name('a TablePartial name'), line: tok.line, col: tok.col });
          this.endOfLine();
        } else {
          table.items.push({ kind: 'column', column: this.parseColumn() });
        }
      }
      return table;
    }

    parseColumn() {
      const tok = this.peek();
      const name = this.name('a column name');
      const nt = this.peek();
      if (nt.type === 'nl' || nt.type === 'eof' || this.isPunct('}') || this.isPunct('[')) {
        throw this.error(`Column '${name}' is missing a type`, nt);
      }
      const type = this.parseType();
      const settings = this.isPunct('[') ? this.parseSettings() : [];
      this.endOfLine();
      return { name, type, settings, line: tok.line, col: tok.col };
    }

    parseType() {
      let s = this.dottedName('a column type').join('.');
      while (this.peek().type === 'ident') s += ' ' + this.next().value; // e.g. double precision
      if (this.isPunct('(')) {
        const open = this.next();
        const args = [];
        let depth = 1, cur = '';
        for (;;) {
          const t = this.next();
          if (t.type === 'eof' || t.type === 'nl') throw this.error("Missing ')' in column type", open);
          if (t.type === 'punct' && t.value === '(') depth++;
          if (t.type === 'punct' && t.value === ')') { depth--; if (depth === 0) break; }
          if (t.type === 'punct' && t.value === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue; }
          cur += t.type === 'string' ? `'${t.value}'` : t.value;
        }
        args.push(cur.trim());
        s += '(' + args.join(',') + ')';
      }
      while (this.isPunct('[') && this.isPunct(']', 1)) { this.next(); this.next(); s += '[]'; }
      return s;
    }

    parseSettings() {
      const open = this.expectPunct('[');
      const groups = [];
      let cur = [], depth = 0;
      for (;;) {
        const t = this.next();
        if (t.type === 'eof') throw this.error("Missing ']' to close settings", open);
        if (t.type === 'nl') continue;
        if (t.type === 'punct') {
          if (t.value === '[' || t.value === '(') depth++;
          else if (t.value === ')') depth--;
          else if (t.value === ']') { if (depth === 0) break; depth--; }
          else if (t.value === ',' && depth === 0) { groups.push(cur); cur = []; continue; }
        }
        cur.push(t);
      }
      groups.push(cur);
      return groups.filter((g) => g.length).map(interpretSetting);
    }

    parseEndpoint() {
      const start = this.peek();
      const parts = [this.name('a table name')];
      let columns = null;
      while (this.isPunct('.')) {
        this.next();
        if (this.isPunct('(')) {
          this.next();
          columns = [];
          for (;;) {
            columns.push(this.name('a column name'));
            if (this.isPunct(',')) { this.next(); continue; }
            this.expectPunct(')', 'to close the column list');
            break;
          }
          break;
        }
        parts.push(this.name('a column name'));
      }
      if (!columns) {
        if (parts.length < 2) throw this.error(`'${parts[0]}' must be written as table.column`, start);
        columns = [parts.pop()];
      }
      return { table: parts, columns, line: start.line, col: start.col };
    }

    parseRef() {
      const kw = this.next();
      let name = null;
      if (this.isName()) name = this.name();
      if (this.isPunct(':')) {
        this.next();
        const r = this.parseRefLine(name);
        this.endOfLine();
        return [r];
      }
      this.openBlock("after Ref — use 'Ref: a.id < b.a_id' or 'Ref { ... }'");
      const refs = [];
      while (!this.blockEnd(kw, 'Ref')) { refs.push(this.parseRefLine(name)); this.endOfLine(); }
      return refs;
    }

    parseRefLine(name) {
      const from = this.parseEndpoint();
      const op = this.peek();
      if (op.type !== 'punct' || !OPS.has(op.value)) {
        throw this.error(`Expected a relationship operator (<, >, - or <>) but found ${describe(op)}`);
      }
      this.next();
      const to = this.parseEndpoint();
      const settings = this.isPunct('[') ? this.parseSettings() : [];
      return { name, from, op: op.value, to, settings, line: from.line, col: from.col };
    }

    parseEnum() {
      const kw = this.next();
      const parts = this.dottedName('an enum name');
      this.openBlock(`to open enum '${parts.join('.')}'`);
      const values = [];
      while (!this.blockEnd(kw, `enum '${parts.join('.')}'`)) {
        const t = this.peek();
        if (t.type !== 'string' && !this.isName()) throw this.error(`Expected an enum value but found ${describe(t)}`);
        this.next();
        const settings = this.isPunct('[') ? this.parseSettings() : [];
        const note = settings.find((s) => s.key === 'note');
        values.push({ name: t.value, note: note ? valueText(note.value) : null });
        this.endOfLine();
      }
      return { parts, values, line: kw.line, col: kw.col };
    }

    parseGroup() {
      const kw = this.next();
      const name = this.dottedName('a TableGroup name').join('.');
      const settings = this.isPunct('[') ? this.parseSettings() : [];
      this.openBlock(`to open TableGroup '${name}'`);
      const tables = [];
      let note = null;
      while (!this.blockEnd(kw, `TableGroup '${name}'`)) {
        if (this.isNoteStart()) { this.next(); note = this.parseNoteBody(); this.endOfLine(); continue; }
        const t = this.peek();
        tables.push({ parts: this.dottedName('a table name'), line: t.line, col: t.col });
        this.endOfLine();
      }
      return { name, settings, tables, note, line: kw.line, col: kw.col };
    }

    parseStickyNote() {
      const kw = this.next();
      const name = this.isName() ? this.name() : null;
      const text = this.parseNoteBody();
      this.endOfLine();
      return { name, text, line: kw.line };
    }

    parseIndexes(table) {
      const kw = this.next();
      this.openBlock('to open indexes');
      while (!this.blockEnd(kw, 'indexes')) {
        const start = this.peek();
        const columns = [];
        if (this.isPunct('(')) {
          this.next();
          for (;;) {
            this.skipNL();
            columns.push(this.indexColumn());
            this.skipNL();
            if (this.isPunct(',')) { this.next(); continue; }
            this.expectPunct(')', 'to close the index column list');
            break;
          }
        } else {
          columns.push(this.indexColumn());
        }
        const settings = this.isPunct('[') ? this.parseSettings() : [];
        table.indexes.push({ columns, settings, line: start.line, col: start.col });
        this.endOfLine();
      }
    }

    indexColumn() {
      const t = this.peek();
      if (t.type === 'expr') { this.next(); return { value: t.value, expr: true }; }
      return { value: this.name('an index column'), expr: false };
    }
  }

  function tokensToValue(ts) {
    if (!ts.length) return '';
    if (ts.length === 1) {
      const t = ts[0];
      if (t.type === 'number') return Number(t.value);
      if (t.type === 'expr') return { expr: t.value };
      if (t.type === 'string') return { str: t.value };
      return t.value;
    }
    if (ts.length === 2 && ts[0].value === '-' && ts[1].type === 'number') return -Number(ts[1].value);
    return ts.map((t) => (t.type === 'string' ? `'${t.value}'` : t.type === 'expr' ? `\`${t.value}\`` : t.value)).join('');
  }

  function interpretSetting(g) {
    const first = g[0];
    const pos = { line: first.line, col: first.col };
    if (first.type === 'ident' && first.value.toLowerCase() === 'ref' && g[1] && g[1].value === ':') {
      const op = g[2];
      if (!op || op.type !== 'punct' || !OPS.has(op.value)) {
        const at = op || g[1];
        throw new DBMLError("Expected a relationship operator (<, >, - or <>) after 'ref:'", at.line, at.col);
      }
      const sub = new Parser(g.slice(3));
      const target = sub.parseEndpoint();
      if (!sub.atEnd()) throw sub.error(`Unexpected ${describe(sub.peek())} in ref setting`);
      return { key: 'ref', op: op.value, target, ...pos };
    }
    const ci = g.findIndex((t) => t.type === 'punct' && t.value === ':');
    if (ci < 0) return { key: g.map((t) => t.value).join(' ').toLowerCase(), value: true, ...pos };
    const key = g.slice(0, ci).map((t) => t.value).join(' ').toLowerCase();
    return { key, value: tokensToValue(g.slice(ci + 1)), ...pos };
  }

  function valueText(v) {
    if (v == null) return null;
    if (typeof v === 'object' && 'str' in v) return v.str;
    if (typeof v === 'object' && 'expr' in v) return v.expr;
    return String(v);
  }
  function defaultText(v) {
    if (typeof v === 'object' && v && 'str' in v) return `'${v.str}'`;
    if (typeof v === 'object' && v && 'expr' in v) return `\`${v.expr}\``;
    return String(v);
  }

  // ------------------------------------------------------------ model build
  const RELATIONS = { '>': ['*', '1'], '<': ['1', '*'], '-': ['1', '1'], '<>': ['*', '*'] };

  function keyOf(parts) {
    const name = parts[parts.length - 1];
    const schema = parts.length > 1 ? parts.slice(0, -1).join('.') : null;
    return { name, schema, key: schema && schema !== 'public' ? `${schema}.${name}` : name };
  }

  function buildModel(ast) {
    const partials = new Map();
    for (const p of ast.partials) partials.set(p.parts.join('.'), p);

    const tables = [];
    const byKey = new Map();
    const byAlias = new Map();
    const pendingRefs = [];

    function makeColumn(c, tableKey) {
      const col = {
        name: c.name, type: c.type, pk: false, unique: false, notNull: false, increment: false,
        default: null, note: null, fk: false, enum: null, refs: [], line: c.line,
      };
      for (const s of c.settings) {
        switch (s.key) {
          case 'pk': case 'primary key': col.pk = true; break;
          case 'unique': col.unique = true; break;
          case 'not null': col.notNull = true; break;
          case 'null': col.notNull = false; break;
          case 'increment': col.increment = true; break;
          case 'default': col.default = defaultText(s.value); break;
          case 'note': col.note = valueText(s.value); break;
          case 'ref':
            pendingRefs.push({
              name: null, op: s.op, settings: [], line: s.line, col: s.col,
              from: { resolved: tableKey, columns: [c.name], line: s.line, col: s.col },
              to: s.target,
            });
            break;
          default: break; // tolerate unknown settings (check, etc.)
        }
      }
      return col;
    }

    function applyTableSettings(target, settings) {
      for (const s of settings) {
        if (s.key === 'headercolor') target.color = valueText(s.value);
        if (s.key === 'note') target.note = valueText(s.value);
      }
    }

    for (const t of ast.tables) {
      const { name, schema, key } = keyOf(t.parts);
      if (byKey.has(key)) throw new DBMLError(`Table '${key}' is defined more than once`, t.line, t.col);
      const table = { key, name, schema, alias: t.alias, note: null, color: null, columns: [], indexes: [], line: t.line };

      const own = new Set();
      for (const it of t.items) {
        if (it.kind !== 'column') continue;
        if (own.has(it.column.name)) {
          throw new DBMLError(`Column '${it.column.name}' is defined twice in table '${key}'`, it.column.line, it.column.col);
        }
        own.add(it.column.name);
      }

      const colIndex = new Map();
      const indexes = [];
      for (const it of t.items) {
        if (it.kind === 'partial') {
          const p = partials.get(it.name);
          if (!p) throw new DBMLError(`TablePartial '${it.name}' not found`, it.line, it.col);
          applyTableSettings(table, p.settings);
          if (p.note) table.note = p.note;
          indexes.push(...p.indexes);
          for (const pit of p.items) {
            if (pit.kind !== 'column' || own.has(pit.column.name)) continue;
            const col = makeColumn(pit.column, key);
            if (colIndex.has(col.name)) table.columns[colIndex.get(col.name)] = col;
            else { colIndex.set(col.name, table.columns.length); table.columns.push(col); }
          }
        } else {
          colIndex.set(it.column.name, table.columns.length);
          table.columns.push(makeColumn(it.column, key));
        }
      }
      applyTableSettings(table, t.settings);
      if (t.note) table.note = t.note;
      indexes.push(...t.indexes);

      for (const ix of indexes) {
        const settings = {};
        for (const s of ix.settings) settings[s.key] = s.value === true ? true : valueText(s.value);
        const idx = { columns: ix.columns.map((c) => (c.expr ? `\`${c.value}\`` : c.value)), pk: !!(settings.pk || settings['primary key']), unique: !!settings.unique, name: settings.name || null, type: settings.type || null, note: settings.note || null };
        for (const c of ix.columns) {
          if (c.expr) continue;
          const col = table.columns.find((x) => x.name === c.value);
          if (!col) throw new DBMLError(`Index column '${c.value}' not found in table '${key}'`, ix.line, ix.col);
          if (idx.pk) col.pk = true;
          if (idx.unique && ix.columns.length === 1) col.unique = true;
        }
        table.indexes.push(idx);
      }

      byKey.set(key, table);
      if (t.alias) byAlias.set(t.alias, table);
      tables.push(table);
    }

    function resolveTable(parts, pos) {
      let t;
      if (parts.length === 1) t = byKey.get(parts[0]) || byAlias.get(parts[0]);
      else t = byKey.get(keyOf(parts).key);
      if (!t) throw new DBMLError(`Table '${parts.join('.')}' not found`, pos.line, pos.col);
      return t;
    }
    function resolveEndpoint(ep) {
      const table = ep.resolved ? byKey.get(ep.resolved) : resolveTable(ep.table, ep);
      for (const c of ep.columns) {
        if (!table.columns.some((x) => x.name === c)) {
          throw new DBMLError(`Column '${c}' not found in table '${table.key}'`, ep.line, ep.col);
        }
      }
      return table;
    }

    const refs = [];
    for (const r of [...ast.refs, ...pendingRefs]) {
      const ta = resolveEndpoint(r.from);
      const tb = resolveEndpoint(r.to);
      if (r.from.columns.length !== r.to.columns.length) {
        throw new DBMLError('Both sides of a composite reference need the same number of columns', r.line, r.col);
      }
      const [ra, rb] = RELATIONS[r.op];
      const settings = {};
      for (const s of r.settings) settings[s.key] = valueText(s.value);
      const ref = {
        id: refs.length, name: r.name, op: r.op, line: r.line,
        onDelete: settings.delete || null, onUpdate: settings.update || null, color: settings.color || null,
        endpoints: [
          { table: ta.key, columns: r.from.columns.slice(), relation: ra },
          { table: tb.key, columns: r.to.columns.slice(), relation: rb },
        ],
      };
      refs.push(ref);
      ref.endpoints.forEach((ep, i) => {
        const t = byKey.get(ep.table);
        for (const c of ep.columns) {
          const col = t.columns.find((x) => x.name === c);
          col.refs.push(ref.id);
          const other = ref.endpoints[1 - i];
          if ((ep.relation === '*' && other.relation === '1') || (r.op === '-' && i === 0)) col.fk = true;
        }
      });
    }

    const enums = ast.enums.map((e) => ({ ...keyOf(e.parts), values: e.values, line: e.line }));
    const enumByName = new Map();
    for (const e of enums) {
      if (enumByName.has(e.key)) throw new DBMLError(`Enum '${e.key}' is defined more than once`, e.line, 1);
      enumByName.set(e.key, e);
      if (e.schema) enumByName.set(`${e.schema}.${e.name}`, e);
    }
    for (const t of tables) {
      for (const c of t.columns) {
        const base = c.type.replace(/\[\]$/, '');
        const e = enumByName.get(base) || enumByName.get(keyOf(base.split('.')).key);
        if (e) c.enum = e.key;
      }
    }

    const groups = ast.groups.map((g) => {
      const settings = {};
      for (const s of g.settings) settings[s.key] = valueText(s.value);
      return {
        name: g.name, note: g.note || settings.note || null, color: settings.color || null,
        tables: g.tables.map((x) => resolveTable(x.parts, x).key), line: g.line,
      };
    });

    return {
      project: ast.project, tables, refs, enums, groups,
      notes: ast.notes,
    };
  }

  function parse(src) {
    const tokens = tokenize(String(src));
    const ast = new Parser(tokens).parse();
    return buildModel(ast);
  }

  return { parse, tokenize, DBMLError };
});
