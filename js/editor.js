/*
 * Lightweight code editor: a transparent <textarea> over a syntax-highlighted <pre>,
 * with a line-number gutter, auto-indent and error-line marking.
 */
(function (root) {
  'use strict';

  const TOKEN_RE = new RegExp([
    /(\/\*[\s\S]*?(?:\*\/|$))/.source,                                  // 1 block comment
    /(\/\/[^\n]*)/.source,                                              // 2 line comment
    /('''[\s\S]*?(?:'''|$))/.source,                                    // 3 multi-line string
    /('(?:\\.|[^'\\\n])*'?)/.source,                                    // 4 string
    /("(?:\\.|[^"\\\n])*"?)/.source,                                    // 5 quoted identifier
    /(`[^`\n]*`?)/.source,                                              // 6 expression
    /\b(Table|TablePartial|Ref|Enum|TableGroup|Project|Note|Records|indexes|as)\b/.source, // 7 keyword
    /\b(pk|primary key|not null|null|unique|increment|default|ref|headercolor|color|note|name|type|delete|update|cascade|restrict|set null|set default|no action)\b(?=[^\[\]\n]*\])/.source, // 8 setting
    /(#[0-9a-fA-F]{3,8}\b)/.source,                                     // 9 color
    /(\b\d+(?:\.\d+)?\b)/.source,                                       // 10 number
    /(<>|[<>](?!\w)|(?<=\s)-(?=\s))/.source,                             // 11 operator
    /([\[\]{}])/.source,                                                // 12 bracket
  ].join('|'), 'gi');
  const CLASSES = [null, 'c', 'c', 's', 's', 'q', 'x', 'k', 'st', 'col', 'n', 'op', 'b'];

  function escapeHTML(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  function highlight(src) {
    let out = '', last = 0, m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(src))) {
      if (m[0] === '') { TOKEN_RE.lastIndex++; continue; }
      out += escapeHTML(src.slice(last, m.index));
      let cls = 'x';
      for (let i = 1; i < m.length; i++) if (m[i] !== undefined) { cls = CLASSES[i]; break; }
      out += `<span class="t-${cls}">${escapeHTML(m[0])}</span>`;
      last = m.index + m[0].length;
    }
    return out + escapeHTML(src.slice(last)) + '\n';
  }

  class Editor {
    constructor(host, opts) {
      this.opts = opts || {};
      host.classList.add('editor');
      host.innerHTML = '<div class="gutter" aria-hidden="true"></div><div class="code"><pre class="hl" aria-hidden="true"></pre><textarea spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" aria-label="DBML source"></textarea></div>';
      this.gutter = host.querySelector('.gutter');
      this.pre = host.querySelector('.hl');
      this.ta = host.querySelector('textarea');
      this.errorLine = null;
      this.lineCount = 0;

      this.ta.addEventListener('input', () => this.changed());
      this.ta.addEventListener('scroll', () => this.syncScroll());
      this.ta.addEventListener('keydown', (e) => this.keydown(e));
    }

    get value() { return this.ta.value; }
    set value(v) { this.ta.value = v; this.render(); }

    changed() { this.render(); if (this.opts.onChange) this.opts.onChange(this.ta.value); }

    render() {
      this.pre.innerHTML = highlight(this.ta.value);
      const n = this.ta.value.split('\n').length;
      if (n !== this.lineCount) {
        this.lineCount = n;
        let h = '';
        for (let i = 1; i <= n; i++) h += `<div>${i}</div>`;
        this.gutter.innerHTML = h;
      }
      this.markError(this.errorLine);
      this.syncScroll();
    }

    syncScroll() {
      this.pre.scrollTop = this.ta.scrollTop;
      this.pre.scrollLeft = this.ta.scrollLeft;
      this.gutter.scrollTop = this.ta.scrollTop;
    }

    markError(line) {
      this.errorLine = line;
      this.gutter.querySelectorAll('.err').forEach((d) => d.classList.remove('err'));
      if (line && this.gutter.children[line - 1]) this.gutter.children[line - 1].classList.add('err');
    }

    insert(text) {
      this.ta.focus();
      if (!document.execCommand('insertText', false, text)) {
        this.ta.setRangeText(text, this.ta.selectionStart, this.ta.selectionEnd, 'end');
        this.changed();
      }
    }

    keydown(e) {
      const ta = this.ta;
      if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (e.shiftKey) {
          const start = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
          if (ta.value.startsWith('  ', start)) {
            const [s, en] = [ta.selectionStart, ta.selectionEnd];
            ta.setSelectionRange(start, start + 2);
            this.insert('');
            ta.setSelectionRange(Math.max(start, s - 2), Math.max(start, en - 2));
          }
        } else this.insert('  ');
      } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const pos = ta.selectionStart;
        const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
        const indent = ta.value.slice(lineStart).match(/^[ \t]*/)[0];
        const before = ta.value.slice(lineStart, pos).trimEnd();
        const after = ta.value.slice(pos, ta.selectionEnd === pos ? pos + 1 : pos);
        if (before.endsWith('{') && after === '}') {
          this.insert(`\n${indent}  \n${indent}`);
          ta.setSelectionRange(pos + indent.length + 3, pos + indent.length + 3);
        } else this.insert('\n' + indent + (before.endsWith('{') ? '  ' : ''));
      } else if (e.key === '}' && !e.metaKey && !e.ctrlKey) {
        const pos = ta.selectionStart;
        const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
        const line = ta.value.slice(lineStart, pos);
        if (/^[ \t]+$/.test(line) && line.length >= 2 && ta.selectionEnd === pos) {
          e.preventDefault();
          ta.setSelectionRange(pos - 2, pos);
          this.insert('}');
        }
      }
    }

    goTo(line, col) {
      const lines = this.ta.value.split('\n');
      let pos = 0;
      for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
      const end = pos + (lines[line - 1] || '').length;
      this.ta.focus();
      this.ta.setSelectionRange(col ? pos + col - 1 : pos, end);
      const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 20;
      this.ta.scrollTop = Math.max(0, (line - 1) * lh - this.ta.clientHeight / 3);
      this.syncScroll();
    }
  }

  root.DBMLEditor = { Editor, highlight };
})(typeof self !== 'undefined' ? self : this);
