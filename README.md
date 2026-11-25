# ERDLoom

**Write [DBML](https://github.com/holistics/dbml), get a live entity-relationship diagram and readable schema docs, all in your browser.**

ERDLoom is a dependency-free editor for DBML (Database Markup Language). You type DBML on the left and the diagram on the right redraws as you type. There's also a Docs tab that turns the same schema into a reference page you can export and share. It runs entirely in the browser, with no server, no build step and no account.

![The ERDLoom editor: DBML code on the left, the generated diagram on the right](docs/images/diagram.png)

## Quick start

```bash
git clone https://github.com/derekfay84/erdloom.git
cd erdloom
open index.html          # macOS; on Windows use `start index.html`, on Linux `xdg-open index.html`
```

That's all you need. If you'd rather serve it over HTTP, run `npm start` and go to <http://localhost:5173>.

`dist/erdloom.html` is the whole app in a single file, which is handy for sending to someone or keeping offline.

## Features

### Editor and diagram

- **Live diagram.** The diagram updates as you type. If you make a syntax error, the last valid diagram stays on screen, and an error bar shows the line and column; click it to jump there.
- **Relationship lines** attach to the exact column rows, use crow's-foot notation, and route around tables where they can.
- **Arrange freely.** Drag tables and they snap to the grid (hold ⌥/Alt to place them freely). Positions are remembered. **Arrange** lays everything out automatically.
- **Hover** a table or column to highlight its relationships and see its type, flags, default, note, enum values and references.
- **Export** the diagram as SVG or PNG, save the DBML, or **Copy link** to get a URL with the whole schema compressed into it.

### Built for big schemas

- **Outline rail** with views, tables and enums. Its filter also matches column names.
- **Command palette (⌘/Ctrl+K)** to jump to any table or run any action.
- **Focus mode** shows one table plus its neighbours one, two or three references away.
- **Views:** every `TableGroup` becomes a view, and you can save your own named views.
- **Keys only** shows just primary and foreign key columns. It turns on automatically when you zoom out below 50%.
- **Minimap** for getting around.

### Docs tab

![The Docs tab showing the loans table with its columns, references and a mini-diagram](docs/images/docs.png)

Press **D** (or use the Diagram/Docs switch) for a reference page built from the same DBML:

- **Overview:** project note, counts, groups and a table index.
- **One section per table:** columns with types, keys (foreign keys link to their target), nullability, defaults and notes; indexes; what the table references and what references it; and a small diagram of its neighbours.
- **Enums** with their values and the columns that use them.
- **Export → Docs as HTML page** saves a single self-contained file with a contents sidebar, ready to share or print.

### Import from an information schema

![The import dialog converting information-schema rows into DBML](docs/images/import.png)

**Import** turns rows with exactly these columns into DBML:

```
database_name, schema_name, table_name, column_name, data_type, is_primary_key
```

- Paste text or choose (or drop) a CSV file. Comma, tab, semicolon and pipe separators are detected automatically.
- The header row is optional if the columns are in the order above. With a header, any order works and extra columns are ignored.
- `is_primary_key` accepts `YES`/`NO`, `true`/`false`, `t`/`f`, `1`/`0` and `PRI`. A table with several key columns gets a composite primary key.
- Tables are qualified by schema and grouped by schema.
- You see the generated DBML and any skipped rows before importing. You can then replace your DBML (and restore it later from the command palette) or add the new tables to it.
- These six columns carry no foreign-key information, so imported tables have no relationships until you add `Ref`s.

## DBML support

ERDLoom has its own parser (`js/parser.js`), which supports:

| Feature | Examples |
| --- | --- |
| Projects | `Project name { database_type: 'PostgreSQL'  Note: '…' }` |
| Tables | schema-qualified names, `as` aliases, `[headercolor: #hex]`, notes |
| Column settings | `pk`, `unique`, `not null`, `null`, `increment`, `default:`, `note:`, inline `ref:` |
| Indexes | single, composite, composite primary keys, `` `expressions` ``, `name` and `type` |
| References | `Ref: a.x > b.y`, `Ref { … }`, inline refs, composite refs; `<` `>` `-` `<>`; `delete`, `update` and `color` settings |
| Other | `Enum` (with value notes), `TableGroup` (with `color`), `TablePartial` with `~injection`, sticky `Note`, `//` and `/* */` comments, `"quoted names"`, `'''multi-line strings'''` |

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| ⌘/Ctrl+K | Command palette |
| D | Switch between Diagram and Docs |
| F / 1 | Fit the diagram / zoom to 100% |
| / | Filter the outline |
| Esc | Leave focus or view mode, clear the selection, or clear the docs filter |
| ⌘/Ctrl+B | Show or hide the outline |
| ⌘/Ctrl+\\ | Show or hide the code editor |
| ⌘/Ctrl+S, ⌘/Ctrl+O | Save, open |

Single-key shortcuts only work when you're not typing in a field. Your DBML, table positions, saved views and layout preferences are kept in this browser's local storage.

## Development

There are no runtime dependencies. Node 18 or newer is needed only for the tests and the build.

```bash
npm test         # parser and importer tests (node:test)
npm run build    # writes dist/erdloom.html, the single-file build
npm start        # serves the folder at http://localhost:5173 (uses Python 3)
```

| File | What it does |
| --- | --- |
| `index.html`, `css/styles.css` | App shell and styles |
| `js/parser.js` | Tokenizer, parser and model builder. Also works in Node: `require('./js/parser.js').parse(src)` |
| `js/layout.js` | Automatic layout: layered by relationship, schema groups kept together |
| `js/renderer.js` | SVG diagram: line routing, pan/zoom/drag, minimap, tooltips, SVG/PNG export |
| `js/editor.js` | Code editor with syntax highlighting, line numbers and auto-indent |
| `js/docs.js` | Docs tab and the exported HTML docs page |
| `js/importer.js` | Information-schema rows to DBML. Also works in Node |
| `js/app.js` | Wires it all together: outline, palette, views, import dialog, persistence |
| `js/sample.js` | The fictional example schema |
| `scripts/build.mjs` | Inlines everything into `dist/erdloom.html` |
| `test/` | Parser and importer tests |

`DBML.parse(src)` returns `{ project, tables, refs, enums, groups, notes }`, or throws a `DBMLError` with `line` and `col`.

## License and notices

ERDLoom is released under the [MIT License](LICENSE). All of its code was written for this project. It does not include or depend on any third-party code.

DBML (Database Markup Language) is an open-source language created by Holistics and published under the Apache License 2.0. ERDLoom is an independent implementation of that language. It is not affiliated with, sponsored by, or endorsed by Holistics or any of its products. The DBML name is used only to describe the file format ERDLoom reads.

The example schema in `js/sample.js` and the rows in the screenshots are fictional and were written for this project.
