/* Kalima — calculators, JSON, dumps and assorted filters.
 *
 *   JSON         jq
 *   calculator   bc
 *   crypto       openssl (version, dgst, base64/enc, rand)
 *   dumps        hexdump od
 *   filters      fold fmt join expand unexpand factor shuf sum
 *
 * jq and bc are real parsers/interpreters: learner input is never evaluated as
 * JavaScript. Everything works on the simulated filesystem only.
 */

/* ====================================================================== jq */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;

  /* ------------------------------------------------------------- values
   * null, true/false, number, string, Array and Map (objects keep insertion order). */
  class JQError { constructor(value) { this.value = value; } }
  class BreakSignal { constructor(label) { this.label = label; } }
  const isObj = (v) => v instanceof Map;
  const isArr = Array.isArray;
  const typeOf = (v) => (v === null ? 'null' : typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number'
    : typeof v === 'string' ? 'string' : isArr(v) ? 'array' : 'object');
  const truthy = (v) => v !== null && v !== false;
  const typeRank = { null: 0, boolean: 1, number: 3, string: 4, array: 5, object: 6 };

  function cmp(a, b) {
    const ta = typeOf(a); const tb = typeOf(b);
    if (ta !== tb) {
      const ra = ta === 'boolean' ? (a ? 2 : 1) : typeRank[ta]; const rb = tb === 'boolean' ? (b ? 2 : 1) : typeRank[tb];
      return ra < rb ? -1 : 1;
    }
    if (ta === 'number') return a < b ? -1 : a > b ? 1 : 0;
    if (ta === 'string') return a < b ? -1 : a > b ? 1 : 0;
    if (ta === 'array') {
      for (let i = 0; i < a.length && i < b.length; i++) { const c = cmp(a[i], b[i]); if (c) return c; }
      return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
    }
    if (ta === 'object') {
      const ka = sortedKeys(a); const kb = sortedKeys(b);
      const c = cmp(ka, kb); if (c) return c;
      for (const k of ka) { const d = cmp(a.get(k), b.get(k)); if (d) return d; }
    }
    return 0;
  }
  function sortedKeys(m) { return Array.from(m.keys()).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)); }

  /* ------------------------------------------------------------- output */
  function numText(n) {
    if (Number.isNaN(n)) return 'null';
    if (Object.is(n, -0)) return '-0';
    if (!Number.isFinite(n)) return n > 0 ? '1.7976931348623157e+308' : '-1.7976931348623157e+308';
    return String(n).replace(/e([+-])(\d)$/, 'e$10$2');
  }
  function strText(s, ascii) {
    let o = '"';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (ch === '"') o += '\\"';
      else if (ch === '\\') o += '\\\\';
      else if (c === 8) o += '\\b';
      else if (c === 9) o += '\\t';
      else if (c === 10) o += '\\n';
      else if (c === 12) o += '\\f';
      else if (c === 13) o += '\\r';
      else if (c < 32 || c === 127 || (ascii && c > 126)) {
        if (c > 0xffff) { const d = c - 0x10000; o += '\\u' + (0xd800 + (d >> 10)).toString(16).padStart(4, '0') + '\\u' + (0xdc00 + (d & 1023)).toString(16).padStart(4, '0'); }
        else o += '\\u' + c.toString(16).padStart(4, '0');
      } else o += ch;
    }
    return o + '"';
  }
  const COLORS = { null: '0;90', false: '0;39', true: '0;39', number: '0;39', string: '0;32', array: '1;39', object: '1;39', key: '1;34' };
  const esc = (c) => '\x1b[' + c + 'm';
  const RESET = '\x1b[0m';

  /** Serialise like jq: opts {indent (0 = compact), tab, color, sort, ascii}. */
  function dump(v, o) {
    o = o || {};
    const pretty = !!(o.indent || o.tab);
    const unit = o.tab ? '\t' : ' '.repeat(o.indent || 0);
    const nl = (lvl) => (pretty ? '\n' + unit.repeat(lvl) : '');
    function walk(x, lvl) {
      const t = typeOf(x);
      if (t !== 'array' && t !== 'object') {
        const text = t === 'string' ? strText(x, o.ascii) : t === 'number' ? numText(x) : String(x);
        return o.color ? esc(COLORS[t === 'boolean' ? String(x) : t]) + text + RESET : text;
      }
      const col = o.color ? esc(COLORS[t]) : '';
      const open = t === 'array' ? '[' : '{'; const close = t === 'array' ? ']' : '}';
      const items = t === 'array' ? x : (o.sort ? sortedKeys(x) : Array.from(x.keys()));
      if (!items.length) return col + open + close + (o.color ? RESET : '');
      let s = col + open + nl(lvl + 1);
      items.forEach((it, i) => {
        if (t === 'array') s += walk(it, lvl + 1);
        else {
          s += (o.color ? RESET + esc(COLORS.key) + strText(it, o.ascii) + RESET + col + ':' + (pretty ? ' ' : '') + RESET
            : strText(it, o.ascii) + ':' + (pretty ? ' ' : '')) + walk(x.get(it), lvl + 1);
        }
        s += col;
        if (i < items.length - 1) s += ',' + nl(lvl + 1);
      });
      return s + nl(lvl) + col + close + (o.color ? RESET : '');
    }
    return walk(v, 0);
  }
  const compact = (v) => dump(v, {});
  /** Value text as used inside error messages: truncated like jq does. */
  function trunc(v) {
    const s = compact(v);
    return s.length > 14 ? s.slice(0, 11) + '...' : s;
  }
  const descr = (v) => typeOf(v) + ' (' + trunc(v) + ')';

  /* ------------------------------------------------------ JSON text parser */
  /**
   * Port of jq's incremental parser (same messages and line/column numbers).
   * Returns { values: [{value, end}], error }.
   */
  function parseJson(text, atEofError) {
    const values = []; const stack = []; let next; let hasNext = false;
    let tok = ''; let inStr = false; let escape = false; let strBuf = '';
    let line = 1; let col = 0; let err = null;
    const fail = (m) => { err = m + ' at line ' + line + ', column ' + col; return false; };
    const setValue = (v) => {
      if (hasNext) return fail('Expected separator between values');
      next = v; hasNext = true; return true;
    };
    const done = (end) => { if (!stack.length && hasNext) { values.push({ value: next, end }); hasNext = false; next = undefined; } };
    function literal() {
      if (!tok) return true;
      const t = tok; tok = '';
      if (t === 'true') return setValue(true);
      if (t === 'false') return setValue(false);
      if (t === 'null') return setValue(null);
      if (t === 'nan') return setValue(NaN);
      if (/^[tfn]/.test(t)) return fail(t[0] === 'n' && t.length === 4 ? 'Invalid numeric literal' : 'Invalid literal');
      if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return fail('Invalid numeric literal');
      return setValue(Number(t));
    }
    function token(ch) {
      const top = stack[stack.length - 1];
      switch (ch) {
        case '[': if (hasNext) return fail('Expected separator between values'); stack.push([]); return true;
        case '{': if (hasNext) return fail('Expected separator between values'); stack.push(new Map()); return true;
        case ':':
          if (!hasNext) return fail("Expected string key before ':'");
          if (!stack.length || !isObj(top)) return fail("':' not as part of an object");
          if (typeof next !== 'string') return fail('Object keys must be strings');
          stack.push({ key: next }); hasNext = false; next = undefined; return true;
        case ',':
          if (!hasNext) return fail("Expected value before ','");
          if (!stack.length) return fail("',' not as part of an object or array");
          if (isArr(top)) top.push(next);
          else if (top && top.key !== undefined) { stack.pop(); stack[stack.length - 1].set(top.key, next); }
          else return fail('Objects must consist of key:value pairs');
          hasNext = false; next = undefined; return true;
        case ']': {
          if (!stack.length || !isArr(top)) return fail("Unmatched ']'");
          if (hasNext) { top.push(next); hasNext = false; } else if (top.length) return fail('Expected another array element');
          stack.pop(); return setValue(top);
        }
        default: { // '}'
          if (!stack.length) return fail("Unmatched '}'");
          let obj = top;
          if (hasNext) {
            if (!top || top.key === undefined) return fail('Objects must consist of key:value pairs');
            stack.pop(); obj = stack[stack.length - 1]; obj.set(top.key, next); hasNext = false;
          } else {
            if (!isObj(top)) return fail("Unmatched '}'");
            if (top.size) return fail('Expected another key-value pair');
          }
          stack.pop(); return setValue(obj);
        }
      }
    }
    const chars = Array.from(text);
    let pos = 0;
    for (const ch of chars) {
      pos += ch.length;
      if (ch === '\n') { line++; col = 0; } else col++;
      if (inStr) {
        if (escape) {
          escape = false;
          const m = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[ch];
          if (m !== undefined) strBuf += m;
          else if (ch === 'u') { strBuf += '\u0000u'; } else { fail('Invalid escape'); break; }
        } else if (ch === '\\') escape = true;
        else if (ch === '"') {
          inStr = false;
          let s = strBuf.replace(/\u0000u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
          if (/\u0000u/.test(s)) { fail('Invalid escape'); break; }
          s = s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
          if (!setValue(s)) break;
          done(pos);
        } else strBuf += ch;
        continue;
      }
      if (ch === '"') {
        if (!literal()) break;
        inStr = true; strBuf = ''; continue;
      }
      if (/[ \t\r\n]/.test(ch) || '[{:,]}'.includes(ch)) {
        if (!literal()) break;
        done(pos);
        if (!/[ \t\r\n]/.test(ch) && !token(ch)) break;
        done(pos);
        continue;
      }
      tok += ch;
    }
    if (!err) {
      if (inStr) { err = 'Unfinished string at EOF at line ' + line + ', column ' + col; }
      else if (tok) {
        if (!literal()) { err = err.replace(/ at line/, ' at EOF at line'); if (atEofError) err = atEofError(err); } else done(pos);
      }
      if (!err && (stack.length || hasNext) && stack.length) err = 'Unfinished JSON term at EOF at line ' + line + ', column ' + col;
    }
    return { values, error: err };
  }

  /* ------------------------------------------------------------- lexer */
  const KEYWORDS = new Set(['def', 'if', 'then', 'elif', 'else', 'end', 'as', 'reduce', 'foreach', 'try', 'catch', 'label', 'import', 'include', 'and', 'or', '__loc__']);

  const LITERALS = { null: null, true: true, false: false };

  class CompileError extends Error { constructor(info) { super('compile error'); this.info = info; } }

  /** Tokenise jq program text. Strings carry parts: literal text or a token list for \( ). */
  function lex(src, start, nested) {
    const toks = []; let i = start;
    const isIdStart = (c) => /[A-Za-z_]/.test(c);
    const isId = (c) => /[A-Za-z0-9_]/.test(c);
    const bad = (pos) => { throw new CompileError({ tok: 'INVALID_CHARACTER', pos }); };
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
      const pos = i;
      if (c === '"') {
        const parts = []; let cur = ''; i++;
        for (;;) {
          if (i >= src.length) throw new CompileError({ tok: 'end of file', pos: i });
          const d = src[i];
          if (d === '"') { i++; break; }
          if (d === '\\') {
            const e = src[i + 1];
            if (e === '(') {
              if (cur) parts.push(cur); cur = '';
              const r = lex(src, i + 2, true); parts.push(r.toks); i = r.pos; continue;
            }
            const m = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e];
            if (m !== undefined) { cur += m; i += 2; continue; }
            if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) { cur += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
            bad(i);
          }
          cur += d; i++;
        }
        if (cur || !parts.length) parts.push(cur);
        toks.push({ t: 'str', parts, pos }); continue;
      }
      if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] || ''))) {
        const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
        toks.push({ t: 'num', v: Number(m[0]), pos }); i += m[0].length; continue;
      }
      if (c === '.') {
        if (src[i + 1] === '.') { toks.push({ t: 'op', v: '..', pos }); i += 2; continue; }
        if (isIdStart(src[i + 1] || '')) {
          let j = i + 1; while (j < src.length && isId(src[j])) j++;
          toks.push({ t: 'field', v: src.slice(i + 1, j), pos }); i = j; continue;
        }
        toks.push({ t: 'op', v: '.', pos }); i++; continue;
      }
      if (c === '$') {
        const m = /^\$([A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*)/.exec(src.slice(i));
        if (!m) bad(i);
        toks.push({ t: 'var', v: m[1], pos }); i += m[0].length; continue;
      }
      if (c === '@') {
        const m = /^@[A-Za-z0-9_]+/.exec(src.slice(i));
        if (!m) bad(i);
        toks.push({ t: 'format', v: m[0], pos }); i += m[0].length; continue;
      }
      if (isIdStart(c)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i));
        toks.push({ t: KEYWORDS.has(m[0]) ? 'kw' : 'id', v: m[0], pos }); i += m[0].length; continue;
      }
      const three = src.slice(i, i + 3); const two = src.slice(i, i + 2);
      if (three === '//=') { toks.push({ t: 'op', v: three, pos }); i += 3; continue; }
      if (['|=', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '//'].includes(two)) { toks.push({ t: 'op', v: two, pos }); i += 2; continue; }
      if (c === '(') depth++;
      if (c === ')') { if (nested && depth === 0) return { toks, pos: i + 1 }; depth--; }
      if ('|,()[]{}:;=<>+-*/%?'.includes(c)) { toks.push({ t: 'op', v: c, pos }); i++; continue; }
      bad(i);
    }
    if (nested) throw new CompileError({ tok: 'end of file', pos: i });
    return { toks, pos: i };
  }

  /* ------------------------------------------------------------ parser */
  function parseProgram(src) {
    const { toks } = lex(src, 0, false);
    return new Parser(toks, src.length).program();
  }

  class Parser {
    constructor(toks, endPos) { this.toks = toks; this.i = 0; this.endPos = endPos; }
    peek() { return this.toks[this.i]; }
    isOp(v) { const t = this.toks[this.i]; return t && t.t === 'op' && t.v === v; }
    isKw(v) { const t = this.toks[this.i]; return t && t.t === 'kw' && t.v === v; }
    unexpected(expecting) {
      const t = this.peek();
      const name = !t ? 'end of file' : t.t === 'id' ? 'IDENT' : t.t === 'num' ? 'LITERAL' : t.t === 'str' ? 'QQSTRING_START' : t.t === 'field' ? 'FIELD' : t.t === 'var' ? '\'$\'' : t.t === 'format' ? 'FORMAT' : t.t === 'kw' ? t.v : "'" + t.v + "'";
      throw new CompileError({ tok: name, pos: t ? t.pos : this.endPos, expecting });
    }
    expectOp(v) { if (!this.isOp(v)) this.unexpected(); this.i++; }
    expectKw(v) { if (!this.isKw(v)) this.unexpected(); this.i++; }
    program() {
      if (!this.toks.length) return { t: 'id' };
      const n = this.pipe();
      if (this.i < this.toks.length) this.unexpected('end of file');
      return n;
    }
    pipe() {
      if (this.isKw('def')) {
        const d = this.def();
        d.rest = this.pipe();
        return d;
      }
      if (this.isKw('label')) {
        this.i++;
        const v = this.peek(); if (!v || v.t !== 'var') this.unexpected();
        this.i++; this.expectOp('|');
        return { t: 'label', name: v.v, body: this.pipe() };
      }
      const l = this.comma();
      if (this.isOp('|')) { this.i++; return { t: 'pipe', l, r: this.pipe() }; }
      return l;
    }
    def() {
      this.expectKw('def');
      const id = this.peek(); if (!id || (id.t !== 'id' && id.t !== 'kw')) this.unexpected();
      this.i++;
      const params = [];
      if (this.isOp('(')) {
        this.i++;
        for (;;) {
          const p = this.peek();
          if (p && p.t === 'var') params.push('$' + p.v); else if (p && (p.t === 'id' || p.t === 'kw')) params.push(p.v); else this.unexpected();
          this.i++;
          if (this.isOp(';')) { this.i++; continue; }
          this.expectOp(')'); break;
        }
      }
      this.expectOp(':');
      const body = this.pipe();
      this.expectOp(';');
      return { t: 'def', name: id.v, params, body };
    }
    comma() {
      let l = this.alt();
      while (this.isOp(',')) { this.i++; l = { t: 'comma', l, r: this.alt() }; }
      return l;
    }
    alt() {
      const l = this.assign();
      if (this.isOp('//')) { this.i++; return { t: 'alt', l, r: this.alt() }; }
      return l;
    }
    assign() {
      const l = this.or();
      const t = this.peek();
      if (t && t.t === 'op' && ['=', '|=', '+=', '-=', '*=', '/=', '%=', '//='].includes(t.v)) {
        this.i++;
        return { t: 'assign', op: t.v, l, r: this.alt() };
      }
      return l;
    }
    or() {
      let l = this.and();
      while (this.isKw('or')) { this.i++; l = { t: 'or', l, r: this.and() }; }
      return l;
    }
    and() {
      let l = this.compare();
      while (this.isKw('and')) { this.i++; l = { t: 'and', l, r: this.compare() }; }
      return l;
    }
    compare() {
      const l = this.add();
      const t = this.peek();
      if (t && t.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) { this.i++; return { t: 'bin', op: t.v, l, r: this.add() }; }
      return l;
    }
    add() {
      let l = this.mul();
      for (;;) {
        const t = this.peek();
        if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) { this.i++; l = { t: 'bin', op: t.v, l, r: this.mul() }; } else return l;
      }
    }
    mul() {
      let l = this.unary();
      for (;;) {
        const t = this.peek();
        if (t && t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '%')) { this.i++; l = { t: 'bin', op: t.v, l, r: this.unary() }; } else return l;
      }
    }
    unary() {
      if (this.isOp('-')) { this.i++; return { t: 'neg', e: this.unary() }; }
      return this.postfix();
    }
    postfix() {
      const n = this.postfixCore();
      if (this.isKw('as')) {
        this.i++;
        const pats = [this.pattern()];
        while (this.isOp('?') && this.toks[this.i + 1] && this.toks[this.i + 1].v === '//') { this.i += 2; pats.push(this.pattern()); }
        this.expectOp('|');
        return { t: 'as', src: n, pats, body: this.pipe() };
      }
      return n;
    }
    bracket(target) {
      this.expectOp('[');
      if (this.isOp(']')) { this.i++; return { t: 'iter', target }; }
      if (this.isOp(':')) {
        this.i++; const to = this.pipe(); this.expectOp(']');
        return { t: 'slice', target, from: null, to };
      }
      const a = this.pipe();
      if (this.isOp(':')) {
        this.i++;
        if (this.isOp(']')) { this.i++; return { t: 'slice', target, from: a, to: null }; }
        const b = this.pipe(); this.expectOp(']');
        return { t: 'slice', target, from: a, to: b };
      }
      this.expectOp(']');
      return { t: 'index', target, key: a };
    }
    pattern() {
      const t = this.peek();
      if (t && t.t === 'var') { this.i++; return { t: 'pvar', name: t.v }; }
      if (this.isOp('[')) {
        this.i++; const items = [];
        for (;;) { items.push(this.pattern()); if (this.isOp(',')) { this.i++; continue; } this.expectOp(']'); break; }
        return { t: 'parr', items };
      }
      if (this.isOp('{')) {
        this.i++; const items = [];
        for (;;) {
          const k = this.peek();
          if (k && k.t === 'var') {
            this.i++;
            const e = { key: { t: 'lit', v: k.v }, name: k.v, pat: null };
            if (this.isOp(':')) { this.i++; e.pat = this.pattern(); }
            items.push(e);
          } else {
            let key;
            if (k && (k.t === 'id' || k.t === 'kw')) { this.i++; key = { t: 'lit', v: k.v }; }
            else if (k && k.t === 'str') { this.i++; key = this.stringNode(k, null); }
            else if (this.isOp('(')) { this.i++; key = this.pipe(); this.expectOp(')'); }
            else this.unexpected();
            this.expectOp(':');
            items.push({ key, name: null, pat: this.pattern() });
          }
          if (this.isOp(',')) { this.i++; continue; }
          this.expectOp('}'); break;
        }
        return { t: 'pobj', items };
      }
      return this.unexpected();
    }
    stringNode(tok, fmt) {
      const parts = tok.parts.map((p) => (typeof p === 'string' ? p : new Parser(p, this.endPos).program()));
      if (parts.length === 1 && typeof parts[0] === 'string') return { t: 'lit', v: parts[0] };
      return { t: 'str', parts, fmt };
    }
    term() {
      const t = this.peek();
      if (!t) this.unexpected();
      switch (t.t) {
        case 'num': this.i++; return { t: 'lit', v: t.v };
        case 'str': this.i++; return this.stringNode(t, null);
        case 'format': {
          this.i++;
          const nx = this.peek();
          if (nx && nx.t === 'str') { this.i++; return this.stringNode(nx, t.v); }
          return { t: 'fmt', name: t.v };
        }
        case 'field': this.i++; return { t: 'index', target: { t: 'id' }, key: { t: 'lit', v: t.v } };
        case 'var':
          this.i++;
          return t.v === '__loc__' ? { t: 'loc' } : { t: 'var', name: t.v };
        case 'id': {
          this.i++;
          if (!this.isOp('(') && t.v in LITERALS) return { t: 'lit', v: LITERALS[t.v] };
          if (t.v === 'break' && this.peek() && this.peek().t === 'var') return { t: 'break', name: this.toks[this.i++].v };
          const args = [];
          if (this.isOp('(')) {
            this.i++;
            for (;;) { args.push(this.pipe()); if (this.isOp(';')) { this.i++; continue; } this.expectOp(')'); break; }
          }
          return { t: 'call', name: t.v, args, pos: t.pos };
        }
        case 'kw': return this.keywordTerm(t);
        default: break;
      }
      if (t.v === '.') {
        this.i++;
        const nx = this.peek();
        if (nx && nx.t === 'str') { this.i++; return { t: 'index', target: { t: 'id' }, key: this.stringNode(nx, null) }; }
        return { t: 'id' };
      }
      if (t.v === '..') { this.i++; return { t: 'call', name: 'recurse', args: [], pos: t.pos }; }
      if (t.v === '(') { this.i++; const e = this.pipe(); this.expectOp(')'); return { t: 'paren', e }; }
      if (t.v === '[') {
        this.i++;
        if (this.isOp(']')) { this.i++; return { t: 'arr', body: null }; }
        const body = this.pipe(); this.expectOp(']');
        return { t: 'arr', body };
      }
      if (t.v === '{') return this.object();
      if (t.v === '-') { this.i++; return { t: 'neg', e: this.postfix() }; }
      return this.unexpected();
    }
    keywordTerm(t) {
      switch (t.v) {
        case 'if': {
          this.i++;
          const cond = this.pipe(); this.expectKw('then'); const then = this.pipe();
          const node = { t: 'if', cond, then, else: null };
          let cur = node;
          while (this.isKw('elif')) {
            this.i++;
            const c = this.pipe(); this.expectKw('then'); const th = this.pipe();
            const n = { t: 'if', cond: c, then: th, else: null };
            cur.else = n; cur = n;
          }
          if (this.isKw('else')) { this.i++; cur.else = this.pipe(); }
          this.expectKw('end');
          return node;
        }
        case 'try': {
          this.i++;
          const body = this.postfixNoAs();
          let handler = null;
          if (this.isKw('catch')) { this.i++; handler = this.postfixNoAs(); }
          return { t: 'try', body, handler };
        }
        case 'reduce': case 'foreach': {
          this.i++;
          const src = this.postfixNoAs();
          this.expectKw('as');
          const pat = this.pattern();
          this.expectOp('(');
          const init = this.pipe(); this.expectOp(';');
          const update = this.pipe();
          let extract = null;
          if (t.v === 'foreach' && this.isOp(';')) { this.i++; extract = this.pipe(); }
          this.expectOp(')');
          return { t: t.v, src, pat, init, update, extract };
        }
        case 'def': { const d = this.def(); d.rest = this.pipe(); return d; }
        default: return this.unexpected();
      }
    }
    postfixNoAs() { return this.postfixCore(); }
    postfixCore() {
      let n = this.term();
      for (;;) {
        const t = this.peek();
        if (!t) break;
        if (t.t === 'field') { this.i++; n = { t: 'index', target: n, key: { t: 'lit', v: t.v } }; continue; }
        if (t.t === 'op' && t.v === '.' && this.toks[this.i + 1]) {
          const nx = this.toks[this.i + 1];
          if (nx.t === 'str') { this.i += 2; n = { t: 'index', target: n, key: this.stringNode(nx, null) }; continue; }
          if (nx.t === 'op' && nx.v === '[') { this.i++; continue; }
        }
        if (t.t === 'op' && t.v === '[') { n = this.bracket(n); continue; }
        if (t.t === 'op' && t.v === '?') { this.i++; n = { t: 'try', body: n, handler: null }; continue; }
        break;
      }
      return n;
    }
    object() {
      this.expectOp('{');
      const entries = [];
      if (this.isOp('}')) { this.i++; return { t: 'obj', entries }; }
      for (;;) {
        const k = this.peek();
        let key; let val = null;
        if (k && k.t === 'var') {
          this.i++;
          key = { t: 'lit', v: k.v };
          val = k.v === '__loc__' ? { t: 'loc' } : { t: 'var', name: k.v };
        } else if (k && (k.t === 'id' || k.t === 'kw')) { this.i++; key = { t: 'lit', v: k.v }; }
        else if (k && k.t === 'num') { this.i++; key = { t: 'lit', v: String(k.v) }; }
        else if (k && k.t === 'str') { this.i++; key = this.stringNode(k, null); }
        else if (k && k.t === 'format') {
          this.i++;
          const nx = this.peek();
          if (nx && nx.t === 'str') { this.i++; key = this.stringNode(nx, k.v); } else this.unexpected();
        } else if (this.isOp('(')) { this.i++; key = this.pipe(); this.expectOp(')'); }
        else this.unexpected();
        if (this.isOp(':')) {
          this.i++;
          val = this.alt();
          while (this.isOp('|')) { this.i++; val = { t: 'pipe', l: val, r: this.alt() }; }
        } else if (!val) val = { t: 'index', target: { t: 'id' }, key };
        entries.push({ key, val });
        if (this.isOp(',')) { this.i++; continue; }
        this.expectOp('}'); break;
      }
      return { t: 'obj', entries };
    }
  }

  K.jq = { CompileError, parseJson, dump, parseProgram, cmp, JQError, BreakSignal, typeOf, truthy, isObj, descr, trunc, compact, numText, strText };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ------------------------------------------------------- jq: interpreter */
;(function (root) {
  'use strict';
  const K = root.K;
  const J = K.jq;
  const { JQError, BreakSignal, typeOf, truthy, isObj, cmp, descr, compact, CompileError } = J;
  const isArr = Array.isArray;

  const fail = (msg) => { throw new JQError(msg); };
  const np = (path) => (path === null ? null : false);
  const cps = (s) => Array.from(s);
  const strCmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

  /* --------------------------------------------------------- arithmetic */
  function deepMerge(a, b) {
    const r = new Map(a);
    for (const [k, v] of b) r.set(k, isObj(r.get(k)) && isObj(v) ? deepMerge(r.get(k), v) : v);
    return r;
  }
  function binop(op, a, b) {
    const bad = (verb) => fail(descr(a) + ' and ' + descr(b) + ' cannot be ' + verb);
    switch (op) {
      case '+':
        if (a === null) return b;
        if (b === null) return a;
        if (typeof a === 'number' && typeof b === 'number') return a + b;
        if (typeof a === 'string' && typeof b === 'string') return a + b;
        if (isArr(a) && isArr(b)) return a.concat(b);
        if (isObj(a) && isObj(b)) return new Map([...a, ...b]);
        return bad('added');
      case '-':
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        if (isArr(a) && isArr(b)) return a.filter((x) => !b.some((y) => cmp(x, y) === 0));
        return bad('subtracted');
      case '*':
        if (typeof a === 'number' && typeof b === 'number') return a * b;
        if ((typeof a === 'string' && typeof b === 'number') || (typeof a === 'number' && typeof b === 'string')) {
          const s = typeof a === 'string' ? a : b; const n = typeof a === 'string' ? b : a;
          return n > 0 ? s.repeat(Math.max(1, Math.ceil(n))) : null;
        }
        if (isObj(a) && isObj(b)) return deepMerge(a, b);
        return bad('multiplied');
      case '/':
        if (typeof a === 'number' && typeof b === 'number') {
          if (b === 0) fail(descr(a) + ' and ' + descr(b) + ' cannot be divided because the divisor is zero');
          return a / b;
        }
        if (typeof a === 'string' && typeof b === 'string') return splitStr(a, b);
        return bad('divided');
      case '%':
        if (typeof a === 'number' && typeof b === 'number') {
          const x = Math.trunc(a); const y = Math.trunc(b);
          if (y === 0) fail(descr(a) + ' and ' + descr(b) + ' cannot be divided (remainder) because the divisor is zero');
          const r = Math.abs(x) % Math.abs(y);
          return x < 0 ? -r : r;
        }
        return bad('divided');
      case '==': return cmp(a, b) === 0;
      case '!=': return cmp(a, b) !== 0;
      case '<': return cmp(a, b) < 0;
      case '<=': return cmp(a, b) <= 0;
      case '>': return cmp(a, b) > 0;
      default: return cmp(a, b) >= 0;
    }
  }
  function splitStr(s, sep) {
    if (s === '') return [];
    if (sep === '') return cps(s);
    return s.split(sep);
  }

  /* ------------------------------------------------------ paths and access */
  function sliceBounds(len, from, to) {
    const num = (x, dflt) => {
      if (x === null || x === undefined) return dflt;
      if (typeof x !== 'number') fail('Start and end indices of an array slice must be numbers');
      return x;
    };
    let a = num(from, 0); let b = num(to, len);
    if (a < 0) a += len;
    if (b < 0) b += len;
    a = Math.max(0, Math.min(len, Math.floor(a)));
    b = Math.max(0, Math.min(len, Math.ceil(b)));
    return [a, Math.max(a, b)];
  }
  function getIndex(v, k) {
    if (isObj(v) && typeof k === 'string') return v.has(k) ? v.get(k) : null;
    if (isArr(v) && typeof k === 'number') {
      if (Number.isNaN(k)) return null;
      let i = Math.floor(k); if (i < 0) i += v.length;
      return i >= 0 && i < v.length ? v[i] : null;
    }
    if (isObj(k) && (isArr(v) || typeof v === 'string' || v === null)) {
      if (v === null) return null;
      const arr = typeof v === 'string' ? cps(v) : v;
      const [a, b] = sliceBounds(arr.length, k.get('start'), k.get('end'));
      return typeof v === 'string' ? arr.slice(a, b).join('') : arr.slice(a, b);
    }
    if (v === null && (typeof k === 'string' || typeof k === 'number' || k === null)) return null;
    if (isArr(v) && isArr(k)) return indices(v, k);
    return fail('Cannot index ' + typeOf(v) + ' with ' + (typeof k === 'string' ? 'string "' + k + '"' : typeOf(k)));
  }
  function indices(v, x) {
    if (v === null) return null;
    const out = [];
    if (typeof v === 'string' && typeof x === 'string') {
      if (x === '') return null;
      const bytes = U.toBytes(v); const nb = U.toBytes(x);
      for (let i = 0; i + nb.length <= bytes.length; i++) {
        let ok = true; for (let j = 0; j < nb.length && ok; j++) ok = bytes[i + j] === nb[j];
        if (ok) out.push(i);
      }
      return out;
    }
    if (isArr(v) && isArr(x)) {
      if (!x.length) return null;
      for (let i = 0; i + x.length <= v.length; i++) if (x.every((y, j) => cmp(v[i + j], y) === 0)) out.push(i);
      return out;
    }
    if (isArr(v)) { v.forEach((y, i) => { if (cmp(y, x) === 0) out.push(i); }); return out; }
    return fail('Cannot determine indices of ' + typeOf(x) + ' in ' + typeOf(v));
  }
  const U = K.util;
  function getpath(v, p) {
    for (const k of p) {
      if (v === null) return null;
      v = getIndex(v, k);
    }
    return v;
  }
  function setpath(v, p, i, x) {
    if (i === p.length) return x;
    const k = p[i];
    if (typeof k === 'string') {
      if (v !== null && !isObj(v)) fail('Cannot index ' + typeOf(v) + ' with "' + k + '"');
      const m = new Map(v || []); m.set(k, setpath(m.has(k) ? m.get(k) : null, p, i + 1, x)); return m;
    }
    if (typeof k === 'number') {
      if (v !== null && !isArr(v)) fail('Cannot index ' + typeOf(v) + ' with number');
      const a = (v || []).slice(); let idx = Math.floor(k);
      if (idx < 0) { idx += a.length; if (idx < 0) fail('Out of bounds negative array index'); }
      while (a.length < idx) a.push(null);
      a[idx] = setpath(idx < a.length ? a[idx] : null, p, i + 1, x);
      return a;
    }
    if (isObj(k)) {
      if (v !== null && !isArr(v)) fail('Cannot update field at object index of ' + typeOf(v));
      const a = (v || []).slice(); const [s, e] = sliceBounds(a.length, k.get('start'), k.get('end'));
      const repl = setpath(a.slice(s, e), p, i + 1, x);
      if (!isArr(repl)) fail('A slice of an array can only be assigned another array');
      return a.slice(0, s).concat(repl, a.slice(e));
    }
    return fail('Invalid path component ' + descr(k));
  }
  function delpath(v, p, i) {
    if (v === null) return null;
    const k = p[i];
    if (i === p.length - 1) {
      if (isObj(v) && typeof k === 'string') { const m = new Map(v); m.delete(k); return m; }
      if (isArr(v) && typeof k === 'number') {
        let idx = Math.floor(k); if (idx < 0) idx += v.length;
        return idx >= 0 && idx < v.length ? v.slice(0, idx).concat(v.slice(idx + 1)) : v;
      }
      if (isArr(v) && isObj(k)) { const [s, e] = sliceBounds(v.length, k.get('start'), k.get('end')); return v.slice(0, s).concat(v.slice(e)); }
      return fail('Cannot delete field at ' + (typeof k === 'string' ? 'object' : 'array') + ' index of ' + typeOf(v));
    }
    const child = getIndex(v, k);
    if (child === null) return v;
    return setpath(v, [k], 0, delpath(child, p, i + 1));
  }
  function delpaths(v, paths) {
    const sorted = paths.slice().sort((a, b) => cmp(b, a));
    for (const p of sorted) v = p.length ? delpath(v, p, 0) : null;
    return v;
  }

  /* ------------------------------------------------------------ formats */
  function toStr(v) { return typeof v === 'string' ? v : compact(v); }
  const FORMATS = {
    '@text': toStr,
    '@json': (v) => compact(v),
    '@html': (v) => toStr(v).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])),
    '@uri': (v) => U.toBytes(toStr(v)).map((b) => (/[A-Za-z0-9\-_.~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0'))).join(''),
    '@csv': (v) => rowFormat(v, 'csv'),
    '@tsv': (v) => rowFormat(v, 'tsv'),
    '@sh': (v) => (isArr(v) ? v : [v]).map((x) => {
      if (isArr(x) || isObj(x)) return fail(typeOf(x) + ' (' + J.trunc(x) + ') can not be escaped for shell');
      return typeof x === 'string' ? "'" + x.replace(/'/g, "'\\''") + "'" : compact(x);
    }).join(' '),
    '@base64': (v) => b64enc(U.toBytes(toStr(v))),
    '@base64d': (v) => {
      const s = toStr(v).replace(/=+$/, '');
      if (/[^A-Za-z0-9+/]/.test(s) || s.length % 4 === 1) fail(descr(v) + ' is not valid base64 data');
      return U.fromBytes(b64dec(s));
    },
  };
  function rowFormat(v, kind) {
    if (!isArr(v)) fail(descr(v) + ' cannot be ' + kind + '-formatted, only an array can be');
    return v.map((x) => {
      if (typeof x === 'number') return J.numText(x);
      if (typeof x === 'boolean') return String(x);
      if (x === null) return '';
      if (typeof x === 'string') {
        return kind === 'csv' ? '"' + x.replace(/"/g, '""') + '"'
          : x.replace(/[\\\t\n\r]/g, (c) => ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' }[c]));
      }
      return fail(descr(x) + ' is not valid in a csv row');
    }).join(kind === 'csv' ? ',' : '\t');
  }
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64enc(bytes) {
    let o = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      o += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
    }
    return o;
  }
  function b64dec(s) {
    const out = []; let acc = 0; let bits = 0;
    for (const ch of s) { acc = (acc << 6) | B64.indexOf(ch); bits += 6; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } }
    return out;
  }
  K.b64 = { enc: b64enc, dec: b64dec };

  /* ---------------------------------------------------------- regexes */
  function mkRegex(re, flags, forceGlobal) {
    if (typeof re !== 'string') fail(descr(re) + ' cannot be matched, as it is not a string');
    if (flags !== null && typeof flags !== 'string') fail(descr(flags) + ' is not a string');
    let f = 'd'; let g = !!forceGlobal;
    for (const c of flags || '') {
      if (c === 'g') g = true;
      else if (c === 'i') f += 'i';
      else if (c === 's') f += 's';
      else if (c === 'x') re = re.replace(/\s+|#.*$/gm, '');
      else if (c === 'n' || c === 'l' || c === 'p') { if (c === 'p') f += 's'; }
      else fail(flags + ' is not a valid modifier string');
    }
    try { return { rx: new RegExp(re, f + (g ? 'g' : '')), global: g }; }
    catch (e) { return fail(re + ' (at offset 0) is not a valid regex: ' + String(e.message).replace(/^Invalid regular expression: /, '')); }
  }
  function matches(s, re, flags, forceGlobal) {
    if (typeof s !== 'string') fail(descr(s) + ' cannot be matched, as it is not a string');
    const { rx, global } = mkRegex(re, flags, forceGlobal);
    const toCp = (i) => cps(s.slice(0, i)).length;
    const out = [];
    let m;
    rx.lastIndex = 0;
    while ((m = rx.exec(s))) {
      const names = {};
      if (m.groups) for (const k of Object.keys(m.groups)) names[k] = true;
      const nameAt = new Map();
      if (m.groups) for (const [k, ind] of Object.entries(m.indices.groups)) if (ind) nameAt.set(ind[0] + ':' + ind[1], k);
      const caps = [];
      for (let i = 1; i < m.length; i++) {
        const ind = m.indices[i];
        const nm = ind ? nameAt.get(ind[0] + ':' + ind[1]) : null;
        caps.push(new Map([['offset', ind ? toCp(ind[0]) : -1], ['length', ind ? cps(m[i]).length : 0], ['string', ind ? m[i] : null], ['name', nm || null]]));
      }
      out.push(new Map([['offset', toCp(m.index)], ['length', cps(m[0]).length], ['string', m[0]], ['captures', caps]]));
      if (!global) break;
      if (m[0] === '') rx.lastIndex++;
    }
    return out;
  }

  /* ------------------------------------------------------------ prelude */
  const PRELUDE = `
def map(f): [.[] | f];
def select(f): if f then . else empty end;
def recurse(f): def r: ., (f | r); r;
def recurse(f; cond): def r: ., (f | select(cond) | r); r;
def recurse: recurse(.[]?);
def values: select(. != null);
def nulls: select(. == null);
def booleans: select(type == "boolean");
def numbers: select(type == "number");
def strings: select(type == "string");
def arrays: select(type == "array");
def objects: select(type == "object");
def iterables: select(type == "array" or type == "object");
def scalars: select(type != "array" and type != "object");
def map_values(f): .[] |= f;
def to_entries: [keys_unsorted[] as $k | {key: $k, value: .[$k]}];
def from_entries: reduce .[] as $x ({}; . + { ($x | if .key == null then .k // .name // .Name // .K // .Key else .key end | if type == "string" then . else tojson end): ($x | if has("value") then .value elif has("v") then .v else .Value end) });
def with_entries(f): to_entries | map(f) | from_entries;
def add(f): reduce f as $x (null; . + $x);
def add: reduce .[] as $x (null; . + $x);
def del(f): delpaths([path(f)]);
def paths: path(..) | select(length > 0);
def paths(node_filter): . as $dot | paths | select(. as $p | $dot | getpath($p) | node_filter);
def any: reduce .[] as $x (false; . or $x);
def all: reduce .[] as $x (true; . and $x);
def any(f): reduce (.[] | f) as $x (false; . or $x);
def all(f): reduce (.[] | f) as $x (true; . and $x);
def isempty(g): first((g | false), true);
def any(g; cond): isempty(first(g | cond | select(.))) | not;
def all(g; cond): isempty(first(g | cond | select(. | not)));
def IN(s): any(s == .; .);
def IN(src; s): any(src == s; .);
def in(xs): . as $x | xs | has($x);
def inside(xs): . as $x | xs | contains($x);
def combinations: if length == 0 then [] else .[0][] as $x | (.[1:] | combinations) as $w | [$x] + $w end;
def combinations(n): . as $dot | [range(n)] | map($dot) | combinations;
def walk(f): def w: if type == "object" then map_values(w) elif type == "array" then map(w) else . end | f; w;
def last(f): reduce f as $x (null; $x);
def nth($n): .[$n];
def first: .[0];
def last: .[-1];
def nth($n; f): if $n < 0 then error("Out of bounds negative array index") else last(limit($n + 1; f)) end;
def until(cond; update): def _until: if cond then . else (update | _until) end; _until;
def while(cond; update): def _while: if cond then ., (update | _while) else empty end; _while;
def repeat(f): def _repeat: f | (., _repeat); _repeat;
def range($x): range(0; $x);
def finites: select(isinfinite or isnan | not);
def normals: select(isnormal);
def tostream: path(def r: (.[]? | r), .; r) as $p | getpath($p) | reduce path(.[]?) as $q ([$p, .]; [$p + $q]);
def fromstream(f): { x: null, e: false } as $init | foreach f as $i ($init; if .e then $init else . end | if $i | length == 2 then setpath(["e"]; $i[0] | length == 0) | setpath(["x"] + $i[0]; $i[1]) else setpath(["e"]; $i[0] | length == 1) end; if .e then .x else empty end);
def truncate_stream(stream): . as $n | null | stream | . as $input | if (.[0] | length) > $n then setpath([0]; .[0][$n:]) else empty end;
def sort_by(f): _sort_by_impl(map([f]));
def group_by(f): _group_by_impl(map([f]));
def unique_by(f): [group_by(f)[] | .[0]];
def min_by(f): _min_by_impl(map([f]));
def max_by(f): _max_by_impl(map([f]));
def unique: group_by(.) | map(.[0]);
def join($x): reduce .[] as $i (null; (if . == null then "" else . + $x end) + ($i | if . == null then "" elif (type == "boolean" or type == "number") then tojson else . end)) // "";
def transpose: if . == [] then [] else . as $in | (map(length) | max) as $max | [range(0; $max) as $j | [range(0; $in | length) as $i | $in[$i][$j]]] end;
def index($i): indices($i) | .[0];
def rindex($i): indices($i) | .[-1:][0];
def match(re): match(re; null);
def test(re): test(re; null);
def capture(re; mods): match(re; mods) | [.captures | .[] | select(.name != null) | {key: .name, value: .string}] | from_entries;
def capture(re): capture(re; null);
def scan($re; $flags): match($re; "g" + $flags) | if (.captures | length) > 0 then [.captures | .[] | .string] else .string end;
def scan($re): scan($re; null);
def split($re; flags): . as $s | [foreach ((match($re; flags + "g") | [.offset, .length]), null) as $m ([0, null]; if $m == null then [.[0], $s[.[0]:]] else [$m[0] + $m[1], $s[.[0]:$m[0]]] end; .[1])];
def splits($re; flags): split($re; flags) | .[];
def splits($re): splits($re; null);
def todate: strftime("%Y-%m-%dT%H:%M:%SZ");
def fromdateiso8601: strptime("%Y-%m-%dT%H:%M:%SZ") | mktime;
def todateiso8601: strftime("%Y-%m-%dT%H:%M:%SZ");
def fromdate: fromdateiso8601;
def dateadd(u; n): . + n;
def pick(pathexps): . as $top | reduce path(pathexps) as $p (null; setpath($p; $top | getpath($p)));
def debug(msg): (msg | debug | empty), .;
def halt_error: halt_error(5);
def abs: if type == "number" and . < 0 then -. else . end;
`;
  let preludeDefs = null;
  function prelude() {
    if (!preludeDefs) {
      const defs = [];
      let n = J.parseProgram(PRELUDE + ' .');
      while (n.t === 'def') { defs.push(n); n = n.rest; }
      preludeDefs = defs;
    }
    return preludeDefs;
  }

  /* -------------------------------------------------------- interpreter */
  const NATIVE = {};
  /** Register a function of plain values; argument generators are expanded as a cartesian product. */
  function value(name, arity, f) {
    NATIVE[name + '/' + arity] = function* (it, args, inp, path, env) {
      for (const vals of it.cart(args, inp, env)) yield [f(inp, ...vals), np(path)];
    };
  }
  function special(name, arity, g) { NATIVE[name + '/' + arity] = g; }

  class Interp {
    constructor(cx) {
      this.cx = cx;
      this.base = null;
      for (const d of prelude()) this.base = this.bindDef(this.base, d);
    }
    bindDef(env, d) {
      const node = { p: env, k: d.name + '/' + d.params.length, v: { def: d, env: null } };
      node.v.env = node;
      return node;
    }
    lookup(env, key) {
      for (let e = env; e; e = e.p) if (e.k === key) return e.v;
      return undefined;
    }
    *cart(args, inp, env, i = 0, acc = []) {
      if (i === args.length) { yield acc.slice(); return; }
      for (const [v] of this.ev(args[i], inp, null, env)) {
        acc[i] = v;
        yield* this.cart(args, inp, env, i + 1, acc);
      }
    }
    run(ast, input) {
      const env = { p: this.base, k: '$ENV', v: this.cx.ENV };
      let e = env;
      for (const [k, v] of this.cx.vars) e = { p: e, k: '$' + k, v };
      return this.ev(ast, input, null, e);
    }
    *ev(n, inp, path, env) {
      switch (n.t) {
        case 'id': yield [inp, path]; return;
        case 'paren': yield* this.ev(n.e, inp, path, env); return;
        case 'lit': yield [n.v, np(path)]; return;
        case 'loc': yield [new Map([['file', '<top-level>'], ['line', 1]]), np(path)]; return;
        case 'var': {
          const e = this.lookup(env, '$' + n.name);
          if (e === undefined) throw new CompileError({ undefinedVar: n.name });
          yield [e, np(path)]; return;
        }
        case 'pipe':
          for (const [v, p] of this.ev(n.l, inp, path, env)) yield* this.ev(n.r, v, p, env);
          return;
        case 'comma':
          yield* this.ev(n.l, inp, path, env);
          yield* this.ev(n.r, inp, path, env);
          return;
        case 'neg':
          for (const [v] of this.ev(n.e, inp, null, env)) {
            if (typeof v !== 'number') fail(descr(v) + ' cannot be negated');
            yield [-v, np(path)];
          }
          return;
        case 'index': {
          for (const [t, tp] of this.ev(n.target, inp, path, env)) {
            for (const [k] of this.ev(n.key, inp, null, env)) {
              if (tp === false) fail('Invalid path expression with result ' + J.trunc(t));
              yield [getIndex(t, k), tp === null ? null : tp.concat([k])];
            }
          }
          return;
        }
        case 'slice': {
          for (const [t, tp] of this.ev(n.target, inp, path, env)) {
            const froms = n.from ? Array.from(this.ev(n.from, inp, null, env), (x) => x[0]) : [null];
            const tos = n.to ? Array.from(this.ev(n.to, inp, null, env), (x) => x[0]) : [null];
            for (const to of tos) {
              for (const from of froms) {
                if (tp === false) fail('Invalid path expression with result ' + J.trunc(t));
                const key = new Map([['start', from], ['end', to]]);
                yield [getIndex(t, key), tp === null ? null : tp.concat([key])];
              }
            }
          }
          return;
        }
        case 'iter': {
          for (const [t, tp] of this.ev(n.target, inp, path, env)) {
            if (tp === false) fail('Invalid path expression with result ' + J.trunc(t));
            if (isArr(t)) { for (let i = 0; i < t.length; i++) yield [t[i], tp === null ? null : tp.concat([i])]; }
            else if (isObj(t)) { for (const [k, v] of t) yield [v, tp === null ? null : tp.concat([k])]; }
            else fail('Cannot iterate over ' + typeOf(t) + (t === null ? ' (null)' : ' (' + J.trunc(t) + ')'));
          }
          return;
        }
        case 'arr': {
          const out = [];
          if (n.body) for (const [v] of this.ev(n.body, inp, null, env)) out.push(v);
          yield [out, np(path)]; return;
        }
        case 'obj': yield* this.object(n, inp, path, env, 0, new Map()); return;
        case 'str': {
          const fmt = n.fmt ? FORMATS[n.fmt] : toStr;
          if (!fmt) fail(n.fmt.slice(1) + ' is not a valid format');
          yield* this.interp(n.parts, inp, env, fmt, path); return;
        }
        case 'fmt': {
          const f = FORMATS[n.name];
          if (!f) fail(n.name.slice(1) + ' is not a valid format');
          yield [f(inp), np(path)]; return;
        }
        case 'bin': {
          for (const [r] of this.ev(n.r, inp, null, env)) {
            for (const [l] of this.ev(n.l, inp, null, env)) yield [binop(n.op, l, r), np(path)];
          }
          return;
        }
        case 'and': case 'or': {
          const isAnd = n.t === 'and';
          for (const [l] of this.ev(n.l, inp, null, env)) {
            if (isAnd ? !truthy(l) : truthy(l)) { yield [!isAnd, np(path)]; continue; }
            for (const [r] of this.ev(n.r, inp, null, env)) yield [truthy(r), np(path)];
          }
          return;
        }
        case 'alt': {
          let any = false;
          for (const [v, p] of this.ev(n.l, inp, path, env)) if (truthy(v)) { any = true; yield [v, p]; }
          if (!any) yield* this.ev(n.r, inp, path, env);
          return;
        }
        case 'if': {
          for (const [c] of this.ev(n.cond, inp, null, env)) {
            if (truthy(c)) yield* this.ev(n.then, inp, path, env);
            else if (n.else) yield* this.ev(n.else, inp, path, env);
            else yield [inp, path];
          }
          return;
        }
        case 'try': {
          try {
            for (const r of this.ev(n.body, inp, path, env)) yield r;
          } catch (e) {
            if (!(e instanceof JQError)) throw e;
            if (n.handler) yield* this.ev(n.handler, e.value, np(path), env);
          }
          return;
        }
        case 'as': {
          for (const [v] of this.ev(n.src, inp, null, env)) {
            for (const e of this.bindAlternatives(n.pats, v, inp, env)) yield* this.ev(n.body, inp, path, e);
          }
          return;
        }
        case 'reduce': {
          for (const [iv, ip] of this.ev(n.init, inp, path, env)) {
            let acc = [iv, ip];
            for (const [sv] of this.ev(n.src, inp, null, env)) {
              for (const e of this.bind(n.pat, sv, inp, env)) {
                let last = [null, np(path)];
                for (const r of this.ev(n.update, acc[0], acc[1], e)) last = r;
                acc = last;
              }
            }
            yield acc;
          }
          return;
        }
        case 'foreach': {
          for (const [iv, ip] of this.ev(n.init, inp, path, env)) {
            let acc = [iv, ip];
            for (const [sv] of this.ev(n.src, inp, null, env)) {
              for (const e of this.bind(n.pat, sv, inp, env)) {
                for (const r of this.ev(n.update, acc[0], acc[1], e)) {
                  acc = r;
                  if (n.extract) yield* this.ev(n.extract, r[0], r[1], e); else yield r;
                }
              }
            }
          }
          return;
        }
        case 'def': yield* this.ev(n.rest, inp, path, this.bindDef(env, n)); return;
        case 'break': {
          const tag = this.lookup(env, '*label*' + n.name);
          if (tag === undefined) throw new CompileError({ msg: '$*label-' + n.name + ' is not defined' });
          throw new BreakSignal(tag);
        }
        case 'label': {
          const tag = {};
          try { yield* this.ev(n.body, inp, path, { p: env, k: '*label*' + n.name, v: tag }); }
          catch (e) { if (!(e instanceof BreakSignal) || e.label !== tag) throw e; }
          return;
        }
        case 'assign': yield* this.assign(n, inp, path, env); return;
        case 'call': yield* this.call(n, inp, path, env); return;
        default: throw new Error('jq: unknown node ' + n.t);
      }
    }
    /** String interpolation: jq varies the first interpolated expression fastest. */
    *interp(parts, inp, env, fmt, path) {
      const alts = parts.map((p) => (typeof p === 'string' ? [p] : Array.from(this.ev(p, inp, null, env), (x) => fmt(x[0]))));
      if (alts.some((g) => !g.length)) return;
      const total = alts.reduce((a, g) => a * g.length, 1);
      for (let c = 0, r = c; c < total; c++) {
        r = c;
        yield [alts.map((g) => { const k = r % g.length; r = Math.floor(r / g.length); return g[k]; }).join(''), np(path)];
      }
    }
    *object(n, inp, path, env, i, acc) {
      if (i === n.entries.length) { yield [acc, np(path)]; return; }
      const { key, val } = n.entries[i];
      for (const [k] of this.ev(key, inp, null, env)) {
        if (typeof k !== 'string') fail('Object keys must be strings');
        for (const [v] of this.ev(val, inp, null, env)) yield* this.object(n, inp, path, env, i + 1, new Map(acc).set(k, v));
      }
    }
    *bindAlternatives(pats, v, inp, env) {
      if (pats.length === 1) { yield* this.bind(pats[0], v, inp, env); return; }
      let lastErr;
      for (let i = 0; i < pats.length; i++) {
        try { yield* this.bind(pats[i], v, inp, env); return; } catch (e) { if (!(e instanceof JQError)) throw e; lastErr = e; }
      }
      throw lastErr;
    }
    *bind(pat, v, inp, env) {
      if (pat.t === 'pvar') { yield { p: env, k: '$' + pat.name, v }; return; }
      if (pat.t === 'parr') {
        if (v !== null && !isArr(v)) fail('Cannot index ' + typeOf(v) + ' with number');
        yield* this.bindList(pat.items.map((p, i) => [p, i]), 0, v, inp, env, (x, i) => getIndex(x, i));
        return;
      }
      const entries = pat.items.map((e) => ({ e }));
      yield* this.bindObj(entries, 0, v, inp, env);
    }
    *bindList(items, i, v, inp, env, get) {
      if (i === items.length) { yield env; return; }
      for (const e of this.bind(items[i][0], get(v, items[i][1]), inp, env)) yield* this.bindList(items, i + 1, v, inp, e, get);
    }
    *bindObj(entries, i, v, inp, env) {
      if (i === entries.length) { yield env; return; }
      const { e } = entries[i];
      for (const [k] of this.ev(e.key, inp, null, env)) {
        if (typeof k !== 'string') fail('Cannot index ' + typeOf(v) + ' with ' + typeOf(k));
        const x = getIndex(v, k);
        let env2 = env;
        if (e.name) env2 = { p: env2, k: '$' + e.name, v: x };
        if (e.pat) for (const e3 of this.bind(e.pat, x, inp, env2)) yield* this.bindObj(entries, i + 1, v, inp, e3);
        else yield* this.bindObj(entries, i + 1, v, inp, env2);
      }
    }
    *assign(n, inp, path, env) {
      const paths = () => Array.from(this.ev(n.l, inp, [], env), ([v, p]) => {
        if (p === false || p === null) fail('Invalid path expression with result ' + J.trunc(v));
        return p;
      });
      if (n.op === '|=') { yield [this.modify(inp, paths(), (old) => { for (const [r] of this.ev(n.r, old, null, env)) return { v: r }; return null; }), np(path)]; return; }
      for (const [rv] of this.ev(n.r, inp, null, env)) {
        let out;
        if (n.op === '=') { out = inp; for (const p of paths()) out = setpath(out, p, 0, rv); }
        else {
          const op = n.op.slice(0, -1);
          out = this.modify(inp, paths(), (old) => ({ v: op === '//' ? (truthy(old) ? old : rv) : binop(op, old, rv) }));
        }
        yield [out, np(path)];
      }
    }
    modify(inp, paths, f) {
      let out = inp; const dels = [];
      for (const p of paths) {
        const r = f(getpath(out, p));
        if (r === null) dels.push(p); else out = setpath(out, p, 0, r.v);
      }
      return dels.length ? delpaths(out, dels) : out;
    }
    *call(n, inp, path, env) {
      const key = n.name + '/' + n.args.length;
      const ent = this.lookup(env, key);
      if (ent !== undefined) {
        if (ent.ast) { yield* this.ev(ent.ast, inp, path, ent.env); return; }
        yield* this.callDef(ent, n.args, inp, path, env, 0, ent.env);
        return;
      }
      const nat = NATIVE[key];
      if (!nat) throw new CompileError({ undefinedFn: key });
      yield* nat(this, n.args, inp, path, env);
    }
    *callDef(ent, args, inp, path, callerEnv, i, env) {
      const d = ent.def;
      if (i === d.params.length) { yield* this.ev(d.body, inp, path, env); return; }
      const p = d.params[i];
      if (p[0] === '$') {
        for (const [v] of this.ev(args[i], inp, null, callerEnv)) {
          const e2 = { p: { p: env, k: '$' + p.slice(1), v }, k: p.slice(1) + '/0', v: { ast: { t: 'lit', v }, env: null } };
          yield* this.callDef(ent, args, inp, path, callerEnv, i + 1, e2);
        }
      } else yield* this.callDef(ent, args, inp, path, callerEnv, i + 1, { p: env, k: p + '/0', v: { ast: args[i], env: callerEnv } });
    }
  }

  /* ----------------------------------------------------------- builtins */
  const needStr = (v, what) => { if (typeof v !== 'string') fail(descr(v) + ' ' + what); return v; };
  special('empty', 0, function* () { /* nothing */ });
  special('error', 0, function* (it, a, inp) { throw new JQError(inp); });
  special('error', 1, function* (it, a, inp, p, env) { for (const [v] of it.ev(a[0], inp, null, env)) throw new JQError(v); });
  special('not', 0, function* (it, a, inp, path) { yield [!truthy(inp), np(path)]; });
  special('path', 1, function* (it, a, inp, path, env) {
    for (const [v, p] of it.ev(a[0], inp, [], env)) {
      if (p === false || p === null) fail('Invalid path expression with result ' + J.trunc(v));
      yield [p, np(path)];
    }
  });
  special('getpath', 1, function* (it, a, inp, path, env) {
    for (const [p] of it.ev(a[0], inp, null, env)) {
      if (!isArr(p)) fail('Path must be specified as an array');
      let v; try { v = getpath(inp, p); } catch (e) { if (path !== null) v = null; else throw e; }
      yield [v, path === null ? null : (path === false ? false : path.concat(p))];
    }
  });
  special('range', 2, function* (it, a, inp, path, env) {
    for (const [from] of it.ev(a[0], inp, null, env)) {
      for (const [to] of it.ev(a[1], inp, null, env)) {
        if (typeof from !== 'number' || typeof to !== 'number') fail('Range bounds must be numeric');
        for (let x = from; x < to; x++) yield [x, np(path)];
      }
    }
  });
  special('range', 3, function* (it, a, inp, path, env) {
    for (const [from] of it.ev(a[0], inp, null, env)) {
      for (const [to] of it.ev(a[1], inp, null, env)) {
        for (const [by] of it.ev(a[2], inp, null, env)) {
          if (typeof from !== 'number' || typeof to !== 'number' || typeof by !== 'number') fail('Range bounds must be numeric');
          if (by > 0) for (let x = from; x < to; x += by) yield [x, np(path)];
          else if (by < 0) for (let x = from; x > to; x += by) yield [x, np(path)];
          else if (from < to) for (;;) yield [from, np(path)];
        }
      }
    }
  });
  special('first', 1, function* (it, a, inp, path, env) { for (const r of it.ev(a[0], inp, path, env)) { yield r; return; } });
  special('limit', 2, function* (it, a, inp, path, env) {
    for (const [n] of it.ev(a[0], inp, null, env)) {
      if (n <= 0) { if (n < 0) yield* it.ev(a[1], inp, path, env); continue; }
      let c = 0;
      for (const r of it.ev(a[1], inp, path, env)) { yield r; if (++c >= n) break; }
    }
  });
  special('input', 0, function* (it, a, inp, path) {
    const r = it.cx.nextInput();
    if (r === undefined) fail('No more inputs');
    yield [r, np(path)];
  });
  special('debug', 0, function* (it, a, inp, path) { it.cx.err('["DEBUG:",' + compact(inp) + ']\n'); yield [inp, path]; });
  special('stderr', 0, function* (it, a, inp, path) { it.cx.err(compact(inp)); yield [inp, path]; });
  special('halt', 0, function* () { throw new J.Halt(0); });
  special('halt_error', 1, function* (it, a, inp, path, env) {
    for (const [c] of it.ev(a[0], inp, null, env)) {
      if (typeof c !== 'number') fail('halt_error/1: number required');
      it.cx.err(typeof inp === 'string' ? inp : compact(inp) + '\n');
      throw new J.Halt(c);
    }
  });
  special('input_filename', 0, function* (it, a, inp, path) { yield [it.cx.filename(), np(path)]; });
  special('env', 0, function* (it, a, inp, path) { yield [it.cx.ENV, np(path)]; });
  special('sub', 2, function* (it, a, inp, path, env) { yield* subImpl(it, a, inp, path, env, null, false); });
  special('sub', 3, function* (it, a, inp, path, env) { yield* subImpl(it, a, inp, path, env, a[2], false); });
  special('gsub', 2, function* (it, a, inp, path, env) { yield* subImpl(it, a, inp, path, env, null, true); });
  special('gsub', 3, function* (it, a, inp, path, env) { yield* subImpl(it, a, inp, path, env, a[2], true); });
  function* subImpl(it, a, inp, path, env, flagsAst, global) {
    const flagVals = flagsAst ? Array.from(it.ev(flagsAst, inp, null, env), (x) => x[0]) : [null];
    for (const [re] of it.ev(a[0], inp, null, env)) {
      for (const flags of flagVals) {
        const ms = matches(inp, re, flags, global);
        const chars = cps(inp);
        const build = function* (i, pos, acc) {
          if (i === ms.length) { yield acc + chars.slice(pos).join(''); return; }
          const m = ms[i];
          const cap = new Map();
          for (const c of m.get('captures')) if (c.get('name') !== null) cap.set(c.get('name'), c.get('string'));
          for (const [r] of it.ev(a[1], cap, null, env)) {
            if (typeof r !== 'string') fail(descr(cap) + ' and ' + descr(r) + ' cannot be added');
            yield* build(i + 1, m.get('offset') + m.get('length'), acc + chars.slice(pos, m.get('offset')).join('') + r);
          }
        };
        for (const s of build(0, 0, '')) yield [s, np(path)];
      }
    }
  }

  value('length', 0, (v) => {
    if (v === null) return 0;
    if (typeof v === 'boolean') return fail('boolean (' + v + ') has no length');
    if (typeof v === 'number') return Math.abs(v);
    if (typeof v === 'string') return cps(v).length;
    return isArr(v) ? v.length : v.size;
  });
  value('utf8bytelength', 0, (v) => U.toBytes(needStr(v, 'only strings have UTF-8 byte length')).length);
  value('type', 0, (v) => typeOf(v));
  value('keys', 0, (v) => {
    if (isObj(v)) return Array.from(v.keys()).sort(strCmp);
    if (isArr(v)) return v.map((x, i) => i);
    return fail(descr(v) + ' has no keys');
  });
  value('keys_unsorted', 0, (v) => {
    if (isObj(v)) return Array.from(v.keys());
    if (isArr(v)) return v.map((x, i) => i);
    return fail(descr(v) + ' has no keys');
  });
  value('has', 1, (v, k) => {
    if (isObj(v) && typeof k === 'string') return v.has(k);
    if (isArr(v) && typeof k === 'number') return k >= 0 && k < v.length;
    return fail('Cannot check whether ' + typeOf(v) + ' has a ' + (typeof k === 'string' ? 'string' : typeOf(k)) + ' key');
  });
  value('contains', 1, (a, b) => contains(a, b));
  function contains(a, b) {
    if (isObj(a) && isObj(b)) return Array.from(b).every(([k, v]) => a.has(k) && contains(a.get(k), v));
    if (isArr(a) && isArr(b)) return b.every((y) => a.some((x) => contains(x, y)));
    if (typeof a === 'string' && typeof b === 'string') return a.includes(b);
    if (typeOf(a) === typeOf(b)) return cmp(a, b) === 0;
    return fail(descr(a) + ' and ' + descr(b) + ' cannot have their containment checked');
  }
  value('tostring', 0, (v) => toStr(v));
  value('tojson', 0, (v) => compact(v));
  value('fromjson', 0, (v) => {
    needStr(v, 'cannot be parsed as JSON');
    const r = J.parseJson(v, null);
    if (r.error) return fail(r.error + ' (while parsing \'' + v + '\')');
    if (r.values.length !== 1) return fail(r.values.length ? 'Unexpected extra JSON values (while parsing \'' + v + '\')' : 'Expected JSON value (while parsing \'' + v + '\')');
    return r.values[0].value;
  });
  value('tonumber', 0, (v) => {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return fail(descr(v) + ' cannot be parsed as a number');
    if (!/^\s*-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v)) {
      const r = J.parseJson(v, null);
      return fail(r.error ? r.error + " (while parsing '" + v + "')" : descr(v) + ' cannot be parsed as a number');
    }
    return Number(v);
  });
  const explodeStr = (v) => { if (typeof v !== 'string') fail('explode input must be a string'); return v; };
  value('ascii_downcase', 0, (v) => explodeStr(v).replace(/[A-Z]/g, (c) => c.toLowerCase()));
  value('ascii_upcase', 0, (v) => explodeStr(v).replace(/[a-z]/g, (c) => c.toUpperCase()));
  value('explode', 0, (v) => cps(needStr(v, 'cannot be exploded')).map((c) => c.codePointAt(0)));
  value('implode', 0, (v) => {
    if (!isArr(v)) fail('implode input must be an array');
    return v.map((c) => { if (typeof c !== 'number') fail(descr(c) + " can't be imploded, unicode codepoint needs to be numeric"); return String.fromCodePoint(c > 0x10ffff || (c >= 0xd800 && c < 0xe000) ? 0xfffd : c); }).join('');
  });
  value('startswith', 1, (v, x) => { if (typeof v !== 'string' || typeof x !== 'string') fail('startswith() requires string inputs'); return v.startsWith(x); });
  value('endswith', 1, (v, x) => { if (typeof v !== 'string' || typeof x !== 'string') fail('endswith() requires string inputs'); return v.endsWith(x); });
  value('split', 1, (v, x) => { if (typeof v !== 'string' || typeof x !== 'string') fail('split input and separator must be strings'); return splitStr(v, x); });
  value('trim', 0, (v) => needStr(v, 'cannot be trimmed').replace(/^\s+|\s+$/g, ''));
  value('ltrim', 0, (v) => needStr(v, 'cannot be trimmed').replace(/^\s+/, ''));
  value('rtrim', 0, (v) => needStr(v, 'cannot be trimmed').replace(/\s+$/, ''));
  value('test', 2, (v, re, fl) => matches(v, re, fl).length > 0);
  special('match', 2, function* (it, a, inp, path, env) {
    for (const [re] of it.ev(a[0], inp, null, env)) for (const [fl] of it.ev(a[1], inp, null, env)) for (const m of matches(inp, re, fl)) yield [m, np(path)];
  });
  value('indices', 1, (v, x) => indices(v, x));
  value('sort', 0, (v) => { if (!isArr(v)) fail(descr(v) + ' cannot be sorted, as it is not an array'); return v.slice().sort(cmp); });
  const keyed = (v, ks, what) => {
    if (!isArr(v)) fail(descr(v) + ' cannot be ' + what + ', as it is not an array');
    return v.map((x, i) => ({ x, k: ks[i] }));
  };
  value('_sort_by_impl', 1, (v, ks) => keyed(v, ks, 'sorted').sort((a, b) => cmp(a.k, b.k)).map((e) => e.x));
  value('_group_by_impl', 1, (v, ks) => {
    const out = []; let last;
    for (const e of keyed(v, ks, 'grouped').sort((a, b) => cmp(a.k, b.k))) {
      if (out.length && cmp(last, e.k) === 0) out[out.length - 1].push(e.x); else { out.push([e.x]); last = e.k; }
    }
    return out;
  });
  const extreme = (dir) => (v, ks) => {
    const es = keyed(v, ks, 'iterated over');
    if (!es.length) return null;
    return es.reduce((b, e) => (dir < 0 ? (cmp(e.k, b.k) < 0 ? e : b) : (cmp(e.k, b.k) >= 0 ? e : b))).x;
  };
  value('_min_by_impl', 1, extreme(-1));
  value('_max_by_impl', 1, extreme(1));
  value('min', 0, (v) => extreme(-1)(v, v));
  value('max', 0, (v) => extreme(1)(v, v));
  value('reverse', 0, (v) => {
    if (typeof v === 'string') return cps(v).reverse().join('');
    if (v === null) return [];
    if (!isArr(v)) fail('Cannot reverse ' + descr(v));
    return v.slice().reverse();
  });
  const flatten = (a, d) => a.reduce((o, x) => (isArr(x) && d > 0 ? o.concat(flatten(x, d - 1)) : (o.push(x), o)), []);
  value('flatten', 0, (v) => { if (!isArr(v)) fail('Cannot iterate over ' + descr(v)); return flatten(v, 1e9); });
  value('flatten', 1, (v, d) => {
    if (d < 0) fail('flatten depth must not be negative');
    if (!isArr(v)) fail('Cannot iterate over ' + descr(v));
    return flatten(v, d);
  });
  value('setpath', 2, (v, p, x) => { if (!isArr(p)) fail('Path must be specified as an array'); return setpath(v, p, 0, x); });
  value('delpaths', 1, (v, ps) => { if (!isArr(ps)) fail('Paths must be specified as an array'); return delpaths(v, ps); });
  value('tostring', 0, (v) => toStr(v));
  value('infinite', 0, () => Infinity);
  value('nan', 0, () => NaN);
  value('isinfinite', 0, (v) => { if (typeof v !== 'number') fail(descr(v) + ' number required'); return v === Infinity || v === -Infinity; });
  value('isnan', 0, (v) => { if (typeof v !== 'number') fail(descr(v) + ' number required'); return Number.isNaN(v); });
  value('isnormal', 0, (v) => { if (typeof v !== 'number') fail(descr(v) + ' number required'); return Number.isFinite(v) && v !== 0 && Math.abs(v) >= 2.2250738585072014e-308; });
  value('now', 0, () => K.clock.now() / 1000);
  for (const [name, f] of Object.entries({ floor: Math.floor, ceil: Math.ceil, round: (x) => (x < 0 ? -Math.round(-x) : Math.round(x)), sqrt: Math.sqrt, fabs: Math.abs,
    exp: Math.exp, exp2: (x) => 2 ** x, exp10: (x) => 10 ** x, log: Math.log, log2: Math.log2, log10: Math.log10, sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan, trunc: Math.trunc, cbrt: Math.cbrt })) {
    value(name, 0, (v) => { if (typeof v !== 'number') fail(descr(v) + ' number required'); return f(v); });
  }
  value('pow', 2, (v, a, b) => { if (typeof a !== 'number' || typeof b !== 'number') fail(descr(a) + ' number required'); return a ** b; });
  value('atan2', 2, (v, a, b) => Math.atan2(a, b));
  value('fmin', 2, (v, a, b) => Math.min(a, b));
  value('fmax', 2, (v, a, b) => Math.max(a, b));
  const pad2 = U.pad2;
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  value('strftime', 1, (v, f) => {
    if (typeof v === 'number') v = [new Date(v * 1000)].map((d) => [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds() + (v % 1), d.getUTCDay(), 0])[0];
    if (!isArr(v)) fail('strftime/1 requires parsed datetime inputs');
    if (typeof f !== 'string') fail('strftime/1 requires a string format');
    const [Y, M, D, h, m, s, wd] = v;
    return f.replace(/%([YmdHMSaAbBjeTZzy%])/g, (x, c) => ({ Y: String(Y), m: pad2(M + 1), d: pad2(D), H: pad2(h), M: pad2(m), S: pad2(Math.floor(s)), a: DAYS[wd].slice(0, 3), A: DAYS[wd], b: MONTHS[M].slice(0, 3), B: MONTHS[M], e: String(D).padStart(2), T: pad2(h) + ':' + pad2(m) + ':' + pad2(Math.floor(s)), Z: 'UTC', z: '+0000', y: pad2(Y % 100), j: String(Math.floor((Date.UTC(Y, M, D) - Date.UTC(Y, 0, 1)) / 864e5) + 1).padStart(3, '0'), '%': '%' }[c]));
  });
  value('strptime', 1, (v, f) => {
    if (typeof v !== 'string') fail('strptime/1 requires string inputs and arguments');
    const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)Z$/.exec(v);
    if (!m || f !== '%Y-%m-%dT%H:%M:%SZ') fail('date "' + v + '" does not match format "' + f + '"');
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    return [+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], d.getUTCDay(), Math.floor((d - Date.UTC(+m[1], 0, 1)) / 864e5)];
  });
  value('mktime', 0, (v) => { if (!isArr(v)) fail('mktime requires array of 6 numbers'); return Date.UTC(v[0], v[1], v[2], v[3], v[4], v[5]) / 1000; });
  value('gmtime', 0, (v) => { const d = new Date(v * 1000); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds() + (v % 1), d.getUTCDay(), Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5)]; });
  value('ltrimstr', 1, (v, x) => (typeof v === 'string' && typeof x === 'string' && v.startsWith(x) ? v.slice(x.length) : v));
  value('rtrimstr', 1, (v, x) => (typeof v === 'string' && typeof x === 'string' && x !== '' && v.endsWith(x) ? v.slice(0, v.length - x.length) : v));
  value('input_line_number', 0, () => 0);
  special('inputs', 0, function* (it, a, inp, path) {
    for (;;) { const r = it.cx.nextInput(); if (r === undefined) return; yield [r, np(path)]; }
  });

  K.jq.Interp = Interp;
  K.jq.hasNative = (key) => key in NATIVE;
  K.jq.Halt = class Halt { constructor(code) { this.code = code; } };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ------------------------------------------------------------- jq: command */
;(function (root) {
  'use strict';
  const K = root.K;
  const J = K.jq;
  const VERSION = 'jq-1.7.1';
  const HELP = `jq - commandline JSON processor [version 1.7.1]

Usage:	jq [options] <jq filter> [file...]
	jq [options] --args <jq filter> [strings...]
	jq [options] --jsonargs <jq filter> [JSON_TEXTS...]

jq is a tool for processing JSON inputs, applying the given filter to
its JSON text inputs and producing the filter's results as JSON on
standard output.

The simplest filter is ., which copies jq's input to its output
unmodified except for formatting. For more advanced filters see
the jq(1) manpage ("man jq") and/or https://jqlang.github.io/jq/.

Example:

	$ echo '{"foo": 0}' | jq .
	{
	  "foo": 0
	}

Command options:
  -n, --null-input          use \`null\` as the single input value;
  -R, --raw-input           read each line as string instead of JSON;
  -s, --slurp               read all inputs into an array and use it as
                            the single input value;
  -c, --compact-output      compact instead of pretty-printed output;
  -r, --raw-output          output strings without escapes and quotes;
      --raw-output0         implies -r and output NUL after each output;
  -j, --join-output         implies -r and output without newline after
                            each output;
  -a, --ascii-output        output strings by only ASCII characters
                            using escape sequences;
  -S, --sort-keys           sort keys of each object on output;
  -C, --color-output        colorize JSON output;
  -M, --monochrome-output   disable colored output;
      --tab                 use tabs for indentation;
      --indent n            use n spaces for indentation (max 7 spaces);
      --unbuffered          flush output stream after each output;
      --stream              parse the input value in streaming fashion;
      --stream-errors       implies --stream and report parse error as
                            an array;
      --seq                 parse input/output as application/json-seq;
  -f, --from-file file      load filter from the file;
  -L directory              search modules from the directory;
      --arg name value      set $name to the string value;
      --argjson name value  set $name to the JSON value;
      --slurpfile name file set $name to an array of JSON values read
                            from the file;
      --rawfile name file   set $name to string contents of file;
      --args                consume remaining arguments as positional
                            string values;
      --jsonargs            consume remaining arguments as positional
                            JSON values;
  -e, --exit-status         set exit status code based on the output;
  -V, --version             show the version;
  --build-configuration     show jq's build configuration;
  -h, --help                show the help;
  --                        terminates argument processing;

Named arguments are also available as $ARGS.named[], while
positional arguments are available as $ARGS.positional[].
`;
  const HINT = 'Use jq --help for help with command-line options,\nor see the jq manpage, or online docs  at https://jqlang.github.io/jq\n';
  const LONG = ['null-input', 'raw-input', 'slurp', 'compact-output', 'raw-output', 'join-output', 'ascii-output', 'sort-keys', 'color-output',
    'monochrome-output', 'tab', 'indent', 'unbuffered', 'seq', 'exit-status', 'arg', 'argjson', 'slurpfile', 'rawfile', 'args', 'jsonargs',
    'from-file', 'help', 'version', 'raw-output0'];

  const MAN = `DESCRIPTION
       jq is a lightweight and flexible command-line JSON processor. It reads
       JSON text from the files named on the command line (or standard input),
       applies the FILTER to every value and prints the results.

OPTIONS
       -n, --null-input      use null as the single input value
       -r, --raw-output      print strings without quotes and escapes
       -j, --join-output     like -r, without the newline after each output
       -c, --compact-output  one line per result
       -s, --slurp           read all inputs into one array
       -R, --raw-input       read each line as a string
       -S, --sort-keys       sort object keys in the output
       -e, --exit-status     exit 1 if the last output was false or null
       -C, -M                force or disable colour
       --tab, --indent N     indentation
       --arg NAME VALUE      bind $NAME to a string
       --argjson NAME JSON   bind $NAME to a JSON value
       -f, --from-file FILE  read the filter from FILE

FILTERS
       .  .foo  .[0]  .[]  a | b  a, b  select(f)  map(f)  keys  length
       sort_by(f)  group_by(f)  unique  add  join(",")  to_entries
       if c then a else b end  reduce/foreach  test("re")  sub("re";"x")

EXAMPLES
       echo '{"host":"web01","ports":[22,80]}' | jq -r '.host, (.ports | join(","))'
       curl -s http://www.halcyon.lab/api/users | jq '.[] | select(.role == "admin") | .name'`;

  /** Text of a compile failure as jq prints it (without the final "1 compile error" line). */
  function compileMessage(e, prog) {
    const i = e.info;
    const at = ' at <top-level>, line 1:\n' + prog + '\n';
    if (i.undefinedFn) return 'jq: error: ' + i.undefinedFn + ' is not defined' + at;
    if (i.undefinedVar) return 'jq: error: $' + i.undefinedVar + ' is not defined' + at;
    return 'jq: error: syntax error, unexpected ' + i.tok + (i.expecting ? ', expecting ' + i.expecting : '') + ' (Unix shell quoting issues?)' + at;
  }

  /** Report names that are not defined as compile errors, before anything runs. */
  function checkNames(ast, interp, globals) {
    const scope = (names, vars) => ({ names, vars });
    const known = (key, sc) => sc.names.has(key) || interp.lookup(interp.base, key) !== undefined || J.hasNative(key);
    const patVars = (p, vars, visit, sc) => {
      if (p.t === 'pvar') vars.add(p.name);
      else if (p.t === 'parr') p.items.forEach((x) => patVars(x, vars, visit, sc));
      else p.items.forEach((e) => { if (e.name) vars.add(e.name); visit(e.key, sc); if (e.pat) patVars(e.pat, vars, visit, sc); });
    };
    const visit = (n, sc) => {
      if (!n || typeof n !== 'object') return;
      switch (n.t) {
        case 'call': {
          const key = n.name + '/' + n.args.length;
          if (!known(key, sc)) throw new J.CompileError({ undefinedFn: key });
          n.args.forEach((a) => visit(a, sc)); return;
        }
        case 'var':
          if (!sc.vars.has(n.name) && !globals.has(n.name)) throw new J.CompileError({ undefinedVar: n.name });
          return;
        case 'str':
          n.parts.forEach((p) => typeof p !== 'string' && visit(p, sc)); return;
        case 'label': { const vars = new Set(sc.vars).add('*label*' + n.name); visit(n.body, scope(sc.names, vars)); return; }
        case 'break':
          if (!sc.vars.has('*label*' + n.name)) throw new J.CompileError({ undefinedVar: '*label-' + n.name });
          return;
        case 'def': {
          const names = new Set(sc.names); names.add(n.name + '/' + n.params.length);
          const inner = new Set(names); const vars = new Set(sc.vars);
          for (const p of n.params) { if (p[0] === '$') { vars.add(p.slice(1)); inner.add(p.slice(1) + '/0'); } else inner.add(p + '/0'); }
          visit(n.body, scope(inner, vars)); visit(n.rest, scope(names, sc.vars)); return;
        }
        case 'as': {
          visit(n.src, sc);
          const vars = new Set(sc.vars); n.pats.forEach((p) => patVars(p, vars, visit, sc));
          visit(n.body, scope(sc.names, vars)); return;
        }
        case 'reduce': case 'foreach': {
          visit(n.src, sc); visit(n.init, sc);
          const vars = new Set(sc.vars); patVars(n.pat, vars, visit, sc);
          const inner = scope(sc.names, vars); visit(n.update, inner); visit(n.extract, inner); return;
        }
        case 'obj': n.entries.forEach((e) => { visit(e.key, sc); visit(e.val, sc); }); return;
        default:
          for (const c of Object.values(n)) {
            if (Array.isArray(c)) c.forEach((x) => visit(x, sc)); else if (c && typeof c === 'object' && c.t) visit(c, sc);
          }
      }
    };
    visit(ast, scope(new Set(), new Set()));
  }

  const countNl = (s) => { let n = 0; for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++; return n; };

  /** Lazily reads the input files (or stdin) and hands out values one at a time. */
  function inputReader(ctx, files, o) {
    const r = { name: null, started: false, failed: false, line: 0, parseError: null };
    let queue = null; let idx = 0;
    const load = async () => {
      const texts = [];
      for (const f of files) texts.push({ name: f, text: f === null ? (ctx.stdin != null ? ctx.stdin : await readTerminal(ctx)) : ctx.fs.read(f) });
      queue = [];
      if (o.R) {
        if (o.slurp) queue.push({ value: texts.map((t) => t.text).join(''), line: 0, name: null });
        else for (const t of texts) { const ls = t.text.split('\n'); if (ls[ls.length - 1] === '') ls.pop(); ls.forEach((l, i) => queue.push({ value: l, line: i + 1, name: t.name })); }
        return;
      }
      for (const t of texts) {
        const p = J.parseJson(t.text, null);
        for (const v of p.values) {
          const nl = t.text.indexOf('\n', v.end - 1);
          queue.push({ value: v.value, line: countNl(t.text.slice(0, nl < 0 ? v.end : nl + 1)), name: t.name });
        }
        if (p.error) { queue.push({ error: p.error }); break; }
      }
      if (o.slurp) { const vals = queue.filter((q) => !q.error).map((q) => q.value); const err = queue.find((q) => q.error); queue = [{ value: vals, line: 0, name: null }]; if (err) queue.push(err); }
    };
    r.ready = load;
    r.next = () => {
      const q = queue[idx++];
      if (!q) return null;
      if (q.error) { r.failed = true; r.parseError = q.error; return null; }
      r.name = q.name; r.line = q.line; r.started = true;
      return q;
    };
    return r;
  }
  async function readTerminal(ctx) {
    let s = '';
    for (;;) { const l = await ctx.readLine(''); if (l == null) return s; s += l + '\n'; }
  }

  function usageFail(ctx, msg) { ctx.err('jq: ' + msg + '\n' + HINT); return 2; }

  /** Parse the command line; returns { o } or { code }. */
  function parseArgs(ctx) {
    const o = { indent: 2, vars: new Map(), positional: [], rest: [], filter: null, file: null };
    const argv = ctx.args; let mode = 'files'; let opts = true;
    const pushValue = (a) => {
      if (o.filter === null && o.file === null) { o.filter = a; return null; }
      if (mode === 'args') o.positional.push(a);
      else if (mode === 'jsonargs') {
        const r = J.parseJson(a, null);
        if (r.error || r.values.length !== 1) return usageFail(ctx, 'Invalid JSON text passed to --jsonargs');
        o.positional.push(r.values[0].value);
      } else o.rest.push(a);
      return null;
    };
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!opts || a === '-' || a[0] !== '-') { const c = pushValue(a); if (c) return { code: c }; continue; }
      if (a === '--') { opts = false; continue; }
      const take = (n) => argv.length - i - 1 >= n;
      if (a.startsWith('--')) {
        const name = a.slice(2);
        const cands = LONG.includes(name) ? [name] : LONG.filter((l) => l.startsWith(name));
        if (cands.length !== 1) return { code: usageFail(ctx, 'Unknown option ' + a) };
        const nm = cands[0];
        if (nm === 'help') { ctx.out(HELP); return { code: 0 }; }
        if (nm === 'version') { ctx.println(VERSION); return { code: 0 }; }
        if (nm === 'tab') o.tab = true;
        else if (nm === 'indent') {
          if (!take(1)) return { code: usageFail(ctx, '--indent takes one parameter') };
          const n = Number(argv[++i]);
          if (!Number.isInteger(n)) return { code: usageFail(ctx, '--indent takes a number') };
          if (n < -1 || n > 7) return { code: usageFail(ctx, '--indent takes a number between -1 and 7') };
          o.indent = n < 0 ? 0 : n; o.tab = n < 0;
        } else if (['arg', 'argjson', 'slurpfile', 'rawfile'].includes(nm)) {
          if (!take(2)) return { code: usageFail(ctx, '--' + nm + ' takes two parameters (e.g. --' + nm + ' varname ' + (nm === 'arg' ? 'value' : nm === 'argjson' ? 'text' : 'filename') + ')') };
          const k = argv[++i]; const v = argv[++i];
          const c = bindVar(ctx, o, nm, k, v);
          if (c) return { code: c };
        } else if (nm === 'args' || nm === 'jsonargs') mode = nm;
        else if (nm === 'from-file') { if (!take(1)) return { code: usageFail(ctx, '-f takes a parameter (e.g. -f filename)') }; o.file = argv[++i]; }
        else if (nm === 'null-input') o.n = true;
        else if (nm === 'raw-input') o.R = true;
        else if (nm === 'slurp') o.slurp = true;
        else if (nm === 'compact-output') o.indent = 0;
        else if (nm === 'raw-output') o.r = true;
        else if (nm === 'join-output') { o.r = true; o.j = true; }
        else if (nm === 'raw-output0') { o.r = true; o.nul = true; }
        else if (nm === 'ascii-output') o.ascii = true;
        else if (nm === 'sort-keys') o.sort = true;
        else if (nm === 'color-output') o.color = true;
        else if (nm === 'monochrome-output') o.color = false;
        else if (nm === 'exit-status') o.e = true;
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (c === 'h') { ctx.out(HELP); return { code: 0 }; }
        if (c === 'V') { ctx.println(VERSION); return { code: 0 }; }
        if (c === 'f') { if (!take(1)) return { code: usageFail(ctx, '-f takes a parameter (e.g. -f filename)') }; o.file = argv[++i]; continue; }
        const flag = { n: 'n', R: 'R', s: 'slurp', r: 'r', a: 'ascii', S: 'sort', e: 'e' }[c];
        if (flag) o[flag] = true;
        else if (c === 'c') o.indent = 0;
        else if (c === 'j') { o.r = true; o.j = true; }
        else if (c === 'C') o.color = true;
        else if (c === 'M') o.color = false;
        else return { code: usageFail(ctx, 'Unknown option ' + a) };
      }
    }
    return { o };
  }

  function bindVar(ctx, o, kind, name, v) {
    if (kind === 'arg') { o.vars.set(name, v); return 0; }
    if (kind === 'argjson') {
      const r = J.parseJson(v, null);
      if (r.error || r.values.length !== 1) return usageFail(ctx, 'Invalid JSON text passed to --argjson');
      o.vars.set(name, r.values[0].value); return 0;
    }
    let text;
    try { text = ctx.fs.read(v); } catch (e) {
      if (!(e instanceof K.FsError)) throw e;
      return usageFail(ctx, 'Bad JSON in --' + kind + ' ' + name + ' ' + v + ': Could not open ' + v + ': ' + e.message);
    }
    if (kind === 'rawfile') { o.vars.set(name, text); return 0; }
    const r = J.parseJson(text, null);
    if (r.error) return usageFail(ctx, 'Bad JSON in --slurpfile ' + name + ' ' + v + ': ' + r.error);
    o.vars.set(name, r.values.map((x) => x.value));
    return 0;
  }

  K.cmd.register({
    name: 'jq',
    pkg: 'jq',
    summary: 'commandline JSON processor',
    synopsis: 'jq [OPTIONS] FILTER [FILES...]',
    man: MAN,
    async run(ctx) {
      const parsed = parseArgs(ctx);
      if (parsed.code !== undefined) return parsed.code;
      const o = parsed.o;
      let filter = o.filter;
      if (o.file !== null) {
        if (o.filter !== null) o.rest.unshift(o.filter);
        try { filter = ctx.fs.read(o.file); } catch (e) {
          if (!(e instanceof K.FsError)) throw e;
          ctx.err('jq: error: Could not open ' + o.file + ': ' + e.message + '\n'); return 2;
        }
      }
      if (filter === null) {
        if (ctx.stdinTTY && ctx.isTTY) { ctx.err(HELP.split('\n').slice(0, 5).join('\n') + '\n'); return usageFail(ctx, 'no filter given'); }
        filter = '.';
      }
      const dumpOpts = { indent: o.indent, tab: o.tab, color: o.color === undefined ? ctx.isTTY && !ctx.env.NO_COLOR : o.color, sort: o.sort, ascii: o.ascii };

      let rd;
      const cx = {
        ENV: new Map(Object.entries(ctx.env)),
        vars: new Map(o.vars),
        err: (s) => ctx.err(s),
        nextInput: () => { const q = rd.next(); return q ? q.value : undefined; },
        filename: () => (rd.started ? rd.name || '<stdin>' : null),
      };
      cx.vars.set('ARGS', new Map([['positional', o.positional], ['named', new Map(o.vars)]]));
      let ast; let interp;
      try {
        ast = J.parseProgram(filter);
        interp = new J.Interp(cx);
        checkNames(ast, interp, new Set([...cx.vars.keys(), 'ENV']));
      } catch (e) {
        if (!(e instanceof J.CompileError)) throw e;
        ctx.err(compileMessage(e, filter) + 'jq: 1 compile error\n');
        return 3;
      }

      /* inputs: named files, else standard input */
      const files = []; let exit = 0;
      for (const f of o.rest) {
        if (ctx.fs.exists(f) && ctx.fs.isFile(f)) { files.push(f); continue; }
        ctx.err('jq: error: Could not open ' + f + ': ' + (ctx.fs.exists(f) ? 'Is a directory' : 'No such file or directory') + '\n'); exit = 2;
      }
      if (!o.rest.length) files.push(null);
      rd = inputReader(ctx, files, o);
      try { await rd.ready(); } catch (e) { if (e instanceof K.FsError) { ctx.err('jq: error: Could not open: ' + e.message + '\n'); return 2; } throw e; }

      let last; let any = false;
      const where = () => (o.n && !rd.started ? '<unknown>' : (rd.name || '<stdin>') + ':' + rd.line);
      const emit = (v) => {
        any = true; last = v;
        ctx.out((o.r && typeof v === 'string' ? v : J.dump(v, dumpOpts)) + (o.j ? (o.nul ? '\0' : '') : '\n'));
      };
      async function runOne(input) {
        try {
          for (const [v] of interp.run(ast, input)) { emit(v); ctx.checkAbort(); }
        } catch (e) {
          if (e instanceof J.JQError) {
            ctx.err('jq: error (at ' + where() + ')' + (typeof e.value === 'string' ? '' : ' (not a string)') + ': ' + (typeof e.value === 'string' ? e.value : J.compact(e.value)) + '\n');
            exit = 5; return;
          }
          if (e instanceof J.BreakSignal) { ctx.err('jq: error (at ' + where() + '): break\n'); exit = 5; return; }
          throw e;
        }
      }
      try {
        if (o.n) await runOne(null);
        else for (let q = rd.next(); q; q = rd.next()) await runOne(q.value);
      } catch (e) {
        if (e instanceof J.Halt) return e.code;
        throw e;
      }
      if (rd.failed) { ctx.err('jq: parse error: ' + rd.parseError + '\n'); return 5; }
      if (exit) return exit;
      if (o.e) return !any ? 4 : (J.truthy(last) ? 0 : 1);
      return 0;
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
