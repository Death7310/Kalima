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

/* ====================================================================== bc */
;(function (root) {
  'use strict';
  const K = root.K;

  /* A bc number is { v: BigInt, s: digits after the point }: value = v / 10^s. */
  const pow10 = (n) => 10n ** BigInt(n);
  const num = (v, s) => ({ v, s: s || 0 });
  const ZERO = num(0n);
  const ONE = num(1n);
  const isZero = (a) => a.v === 0n;

  /** Re-express with exactly `s` fractional digits (truncating toward zero). */
  function rescale(a, s) {
    if (s === a.s) return a;
    return s > a.s ? num(a.v * pow10(s - a.s), s) : num(a.v / pow10(a.s - s), s);
  }
  const align = (a, b) => { const s = Math.max(a.s, b.s); return [rescale(a, s), rescale(b, s), s]; };
  const add = (a, b) => { const [x, y, s] = align(a, b); return num(x.v + y.v, s); };
  const sub = (a, b) => { const [x, y, s] = align(a, b); return num(x.v - y.v, s); };
  const neg = (a) => num(-a.v, a.s);
  const cmpNum = (a, b) => { const [x, y] = align(a, b); return x.v < y.v ? -1 : x.v > y.v ? 1 : 0; };
  function mul(a, b, scale) {
    const s = Math.min(a.s + b.s, Math.max(scale, a.s, b.s));
    return rescale(num(a.v * b.v, a.s + b.s), s);
  }
  /** Division with `scale` fractional digits; the caller checks for zero. */
  function div(a, b, scale) {
    return num((a.v * pow10(scale + b.s)) / (b.v * pow10(a.s)), scale);
  }
  function mod(a, b, scale) {
    const q = div(a, b, scale);
    const prod = num(q.v * b.v, q.s + b.s);
    const r = sub(a, prod);
    return rescale(r, Math.max(a.s, scale + b.s));
  }
  function power(a, b, scale) {
    let e = b.v / pow10(b.s);
    const neg = e < 0n; if (neg) e = -e;
    if (e > 100000n) throw new BcError('exponent too large in raise');
    const n = Number(e);
    let p = num(a.v ** e, a.s * n);
    if (neg) return div(ONE, p, scale);
    return rescale(p, Math.min(a.s * n, Math.max(scale, a.s)));
  }
  /** Integer square root by Newton iteration from an upper bound. */
  function isqrt(n) {
    if (n < 2n) return n;
    let x = 1n << BigInt((n.toString(2).length >> 1) + 1);
    for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; }
  }
  function sqrtNum(a, scale) {
    if (cmpNum(a, ONE) === 0) return ONE;
    const rs = Math.max(scale, a.s);
    // sqrt(v / 10^s) at rs digits = isqrt(v * 10^(2*rs - s)) / 10^rs
    return num(isqrt(a.v * pow10(2 * rs - a.s)), rs);
  }
  const digitsOf = (a) => {
    let n = (a.v < 0n ? -a.v : a.v).toString().length;
    if (n < a.s) n = a.s;
    return a.v === 0n ? a.s || 1 : n;
  };

  class BcError extends Error {}
  class Flow { constructor(kind, value) { this.kind = kind; this.value = value; } }

  /* ----------------------------------------------------- math library (-l) */
  /** Fixed point helpers at P fractional decimal digits. */
  function fixedLib(P) {
    const one = pow10(P);
    const m = (a, b) => (a * b) / one;
    const atanInv = (n) => { // atan(1/n)
      const nn = BigInt(n); const n2 = nn * nn;
      let term = one / nn; let sum = term; let k = 1n; let sign = -1n;
      while (term !== 0n) { term /= n2; k += 2n; sum += (sign * term) / k; sign = -sign; }
      return sum;
    };
    const pi = () => 16n * atanInv(5) - 4n * atanInv(239);
    const atanSmall = (x) => {
      const x2 = m(x, x); let term = x; let sum = x; let k = 1n; let sign = -1n;
      while (term !== 0n) { term = m(term, x2); k += 2n; sum += (sign * term) / k; sign = -sign; }
      return sum;
    };
    const sqrtFx = (x) => isqrt(x * one);
    const atan = (x) => {
      if (x < 0n) return -atan(-x);
      if (x > one) return pi() / 2n - atan((one * one) / x);
      let halvings = 0;
      while (x > one / 5n) { x = (x * one) / (one + sqrtFx(one + m(x, x))); halvings++; }
      return atanSmall(x) << BigInt(halvings);
    };
    const sincos = (x, wantSin) => {
      const twoPi = 2n * pi();
      x %= twoPi;
      const x2 = m(x, x);
      let term = wantSin ? x : one; let sum = term; let k = wantSin ? 1n : 0n;
      while (term !== 0n) { term = -m(term, x2) / ((k + 1n) * (k + 2n)); k += 2n; sum += term; }
      return sum;
    };
    const exp = (x) => {
      let halvings = 0;
      while (x > one || x < -one) { x /= 2n; halvings++; }
      let term = one; let sum = one; let k = 1n;
      while (term !== 0n) { term = m(term, x) / k; k++; sum += term; }
      for (let i = 0; i < halvings; i++) sum = m(sum, sum);
      return sum;
    };
    const atanh = (z) => {
      const z2 = m(z, z); let term = z; let sum = z; let k = 1n;
      while (term !== 0n) { term = m(term, z2); k += 2n; sum += term / k; }
      return sum;
    };
    const ln = (x) => {
      let k = 0n;
      while (x > 2n * one) { x /= 2n; k++; }
      while (x < one / 2n) { x *= 2n; k--; }
      const z = ((x - one) * one) / (x + one);
      return 2n * atanh(z) + k * 2n * atanh(one / 3n);
    };
    return { one, atan, sincos, exp, ln };
  }
  /** Evaluate fn(fixed, lib) with enough guard digits and truncate to `scale` digits. */
  function mathFn(x, scale, kind) {
    const intDigits = Math.max(0, digitsOf(x) - x.s);
    const P = scale + 30 + (kind === 'e' ? Math.ceil(Math.abs(Number(x.v) / 10 ** x.s) * 0.4343) + 10 : intDigits);
    const lib = fixedLib(P);
    const fx = rescale(x, P).v;
    let r;
    if (kind === 's') r = lib.sincos(fx, true);
    else if (kind === 'c') r = lib.sincos(fx, false);
    else if (kind === 'a') r = lib.atan(fx);
    else if (kind === 'e') r = lib.exp(fx);
    else r = lib.ln(fx);
    return rescale(num(r, P), scale);
  }

  /* ------------------------------------------------------------- lexer */
  const KEYWORDS = new Set(['auto', 'break', 'continue', 'define', 'else', 'for', 'halt', 'if', 'length', 'print', 'quit', 'return', 'scale', 'sqrt', 'while', 'ibase', 'obase', 'last', 'read', 'void', 'limits', 'warranty']);
  class SyntaxErr extends Error { constructor(line, eof) { super('syntax'); this.line = line; this.eof = !!eof; } }

  function lex(src, line0) {
    const toks = []; const illegal = []; let i = 0; let line = line0;
    const push = (t, v) => toks.push({ t, v, line, pc: 0 });
    while (i < src.length) {
      const c = src[i];
      if (c === '\n') { line++; push('nl'); i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '\\' && src[i + 1] === '\n') { i += 2; line++; continue; }
      if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') {
        const e = src.indexOf('*/', i + 2);
        if (e < 0) return { toks, illegal, unterminated: 'comment' };
        for (const ch of src.slice(i, e)) if (ch === '\n') line++;
        i = e + 2; continue;
      }
      if (c === '"') {
        const e = src.indexOf('"', i + 1);
        if (e < 0) return { toks, illegal: [{ ch: '"', line }], unterminated: 'string' };
        const text = src.slice(i + 1, e);
        for (const ch of text) if (ch === '\n') line++;
        push('str', text); i = e + 1; continue;
      }
      if (/[0-9A-Z.]/.test(c)) { let j = i; while (j < src.length && /[0-9A-Z.]/.test(src[j])) j++; push('num', src.slice(i, j)); i = j; continue; }
      if (/[a-z]/.test(c)) {
        let j = i; while (j < src.length && /[a-z0-9_]/.test(src[j])) j++;
        const w = src.slice(i, j); push(KEYWORDS.has(w) ? 'kw' : 'name', w); i = j; continue;
      }
      const two = src.slice(i, i + 2);
      if (['==', '<=', '>=', '!=', '++', '--', '&&', '||', '+=', '-=', '*=', '/=', '%=', '^='].includes(two)) { push('op', two); i += 2; continue; }
      if ('+-*/%^<>=!(){}[],;&'.includes(c)) { push('op', c); i++; continue; }
      illegal.push({ ch: c, line }); i++;
    }
    return { toks, line, illegal };
  }

  /* ------------------------------------------------------------ parser */
  /**
   * Builds an AST. Every node that raises a runtime error records `pc`, the
   * position bc's bytecode would have reached, which appears in its messages.
   */
  class Parser {
    constructor(toks, pcStart) { this.toks = toks; this.i = 0; this.pc = pcStart || 0; }
    peek() { return this.toks[this.i]; }
    line() {
      const t = this.peek();
      if (t) return t.line;
      const last = this.toks[this.toks.length - 1];
      return last ? last.line - (last.t === 'nl' ? 1 : 0) : 1;
    }
    is(t, v) { const k = this.peek(); return !!k && k.t === t && (v === undefined || k.v === v); }
    op(v) { return this.is('op', v); }
    kw(v) { return this.is('kw', v); }
    err() { throw new SyntaxErr(this.line(), this.i >= this.toks.length); }
    eatOp(v) { if (!this.op(v)) this.err(); this.i++; }
    skipNl() { while (this.is('nl') || this.op(';')) this.i++; }
    skipNlOnly() { while (this.is('nl')) this.i++; }

    statements() {
      const list = [];
      this.skipNl();
      while (this.i < this.toks.length) { list.push(this.statement()); this.skipNl(); }
      return list;
    }
    /** One statement terminated by ; or newline (or followed by }). */
    statement() {
      const t = this.peek();
      if (!t) this.err();
      if (t.t === 'op' && t.v === '{') {
        this.i++; const body = [];
        this.skipNl();
        while (!this.op('}')) { if (this.i >= this.toks.length) this.err(); body.push(this.statement()); this.skipNl(); }
        this.i++;
        return { t: 'block', body };
      }
      if (t.t === 'kw') {
        switch (t.v) {
          case 'if': return this.ifStmt();
          case 'while': {
            this.i++; this.eatOp('('); const cond = this.expr(); this.eatOp(')'); this.pc += 3;
            this.skipNlOnly(); return { t: 'while', cond, body: this.bodyStmt() };
          }
          case 'for': return this.forStmt();
          case 'break': case 'continue': this.i++; this.pc += 3; this.end(); return { t: t.v };
          case 'halt': this.i++; this.end(); return { t: 'halt' };
          case 'quit': this.i++; this.end(); return { t: 'quit' };
          case 'return': {
            this.i++;
            let e = null;
            if (this.op('(')) { this.i++; if (this.op(')')) this.i++; else { e = this.expr(); this.eatOp(')'); } } else if (!this.is('nl') && !this.op(';') && !this.op('}') && this.i < this.toks.length) e = this.expr();
            this.pc += e ? 1 : 2; this.end();
            return { t: 'return', e };
          }
          case 'print': {
            this.i++; const items = [];
            for (;;) {
              if (this.is('str')) { const s = this.toks[this.i++]; this.pc += 2; items.push({ str: s.v }); } else items.push({ e: this.expr() });
              if (this.op(',')) { this.i++; continue; }
              break;
            }
            this.end(); return { t: 'print', items };
          }
          case 'define': return this.define();
          case 'limits': this.i++; this.end(); return { t: 'limits' };
          case 'warranty': this.i++; this.end(); return { t: 'warranty' };
          default: break;
        }
      }
      if (t.t === 'str') { this.i++; this.pc += 2; this.end(); return { t: 'string', text: t.v }; }
      const e = this.expr();
      this.end();
      return { t: 'expr', e };
    }
    end() {
      if (this.i >= this.toks.length || this.is('nl') || this.op(';') || this.op('}') || this.kw('else')) return;
      this.err();
    }
    bodyStmt() { this.skipNlOnly(); return this.statement(); }
    ifStmt() {
      this.i++; this.eatOp('('); const cond = this.expr(); this.eatOp(')'); this.pc += 3;
      this.skipNlOnly();
      const then = this.statement();
      let save = this.i;
      this.skipNl();
      let other = null;
      if (this.kw('else')) { this.i++; this.skipNlOnly(); other = this.statement(); } else this.i = save;
      return { t: 'if', cond, then, other };
    }
    forStmt() {
      this.i++; this.eatOp('(');
      const init = this.op(';') ? null : this.expr(); this.eatOp(';');
      const cond = this.op(';') ? null : this.expr(); this.eatOp(';');
      const step = this.op(')') ? null : this.expr(); this.eatOp(')');
      this.pc += 6;
      this.skipNlOnly();
      return { t: 'for', init, cond, step, body: this.bodyStmt() };
    }
    define() {
      this.i++;
      let isVoid = false;
      if (this.kw('void')) { this.i++; isVoid = true; }
      if (!this.is('name')) this.err();
      const name = this.toks[this.i++].v;
      this.eatOp('(');
      const params = [];
      while (!this.op(')')) {
        if (!this.is('name')) this.err();
        const p = { name: this.toks[this.i++].v, array: false };
        if (this.op('[')) { this.i++; this.eatOp(']'); p.array = true; }
        params.push(p);
        if (this.op(',')) this.i++; else if (!this.op(')')) this.err();
      }
      this.i++;
      this.skipNlOnly();
      this.eatOp('{');
      const outer = this.pc; this.pc = 0;
      this.skipNl();
      const autos = [];
      if (this.kw('auto')) {
        this.i++;
        for (;;) {
          if (!this.is('name')) this.err();
          const n = this.toks[this.i++].v; let array = false;
          if (this.op('[')) { this.i++; this.eatOp(']'); array = true; }
          autos.push({ name: n, array });
          if (this.op(',')) { this.i++; continue; }
          break;
        }
        this.end(); this.skipNl();
      }
      const body = [];
      while (!this.op('}')) { if (this.i >= this.toks.length) this.err(); body.push(this.statement()); this.skipNl(); }
      this.i++;
      this.pc = outer;
      return { t: 'define', name, params, autos, body, isVoid };
    }

    /* expressions, lowest precedence first */
    expr() { return this.orExpr(); }
    bin(op, l, r) { this.pc += 1; return { t: 'bin', op, l, r, pc: this.pc }; }
    orExpr() {
      let l = this.andExpr();
      while (this.op('||')) { this.i++; l = this.bin('||', l, this.andExpr()); }
      return l;
    }
    andExpr() {
      let l = this.notExpr();
      while (this.op('&&')) { this.i++; l = this.bin('&&', l, this.notExpr()); }
      return l;
    }
    notExpr() {
      if (this.op('!')) { this.i++; const e = this.notExpr(); this.pc += 1; return { t: 'not', e }; }
      return this.relExpr();
    }
    relExpr() {
      let l = this.addExpr();
      for (;;) {
        const t = this.peek();
        if (t && t.t === 'op' && ['==', '<=', '>=', '!=', '<', '>'].includes(t.v)) { this.i++; l = this.bin(t.v, l, this.addExpr()); } else return l;
      }
    }
    addExpr() {
      let l = this.mulExpr();
      for (;;) {
        const t = this.peek();
        if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) { this.i++; l = this.bin(t.v, l, this.mulExpr()); } else return l;
      }
    }
    mulExpr() {
      let l = this.powExpr();
      for (;;) {
        const t = this.peek();
        if (t && t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '%')) { this.i++; l = this.bin(t.v, l, this.powExpr()); } else return l;
      }
    }
    powExpr() {
      const l = this.unary();
      if (this.op('^')) { this.i++; return this.bin('^', l, this.powExpr()); }
      return l;
    }
    unary() {
      if (this.op('-')) { this.i++; const e = this.unary(); this.pc += 1; return { t: 'neg', e }; }
      return this.postfix();
    }
    postfix() {
      const t = this.peek();
      if (!t) this.err();
      if (t.t === 'op' && (t.v === '++' || t.v === '--')) {
        this.i++; const target = this.lvalue(); this.pc += 2;
        return { t: 'incr', target, op: t.v, prefix: true };
      }
      const e = this.primary();
      if (e.lv) {
        const n = this.peek();
        if (n && n.t === 'op') {
          if (n.v === '++' || n.v === '--') { this.i++; this.pc += 2; return { t: 'incr', target: e, op: n.v, prefix: false }; }
          if (['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(n.v)) {
            this.i++;
            const r = this.orExpr();
            this.pc += 2;
            return { t: 'assign', op: n.v, target: e, e: r, pc: this.pc };
          }
        }
      }
      return e;
    }
    lvalue() {
      const e = this.primary();
      if (!e.lv) this.err();
      return e;
    }
    primary() {
      const t = this.peek();
      if (!t) this.err();
      if (t.t === 'num' && t.v === '.') { this.i++; this.pc += 1; return { t: 'special', name: 'last', lv: true }; }
      if (t.t === 'num') {
        if (/\..*\./.test(t.v)) this.err();
        this.i++;
        this.pc += constLen(t.v);
        return { t: 'num', text: t.v };
      }
      if (t.t === 'op' && t.v === '(') { this.i++; const e = this.expr(); this.eatOp(')'); return { t: 'paren', e }; }
      if (t.t === 'name') {
        this.i++;
        if (this.op('(')) {
          this.i++;
          const args = [];
          if (!this.op(')')) for (;;) {
            if (this.is('name') && this.toks[this.i + 1] && this.toks[this.i + 1].v === '[' && this.toks[this.i + 2] && this.toks[this.i + 2].v === ']') {
              args.push({ t: 'arrayref', name: this.toks[this.i].v }); this.i += 3;
            } else args.push(this.expr());
            if (this.op(',')) { this.i++; continue; }
            break;
          }
          this.eatOp(')');
          this.pc += 2;
          const pc = this.pc; this.pc += 1;
          return { t: 'call', name: t.v, args, pc };
        }
        if (this.op('[')) {
          this.i++; const idx = this.expr(); this.eatOp(']'); this.pc += 2;
          return { t: 'elem', name: t.v, idx, lv: true, pc: this.pc };
        }
        this.pc += 2;
        return { t: 'var', name: t.v, lv: true };
      }
      if (t.t === 'kw') {
        if (t.v === 'scale' || t.v === 'ibase' || t.v === 'obase') {
          this.i++;
          if (t.v === 'scale' && this.op('(')) {
            this.i++; const e = this.expr(); this.eatOp(')'); this.pc += 2;
            return { t: 'builtin', name: 'scale', e };
          }
          this.pc += 1;
          return { t: 'special', name: t.v, lv: true };
        }
        if (t.v === 'last') { this.i++; this.pc += 1; return { t: 'special', name: 'last', lv: true }; }
        if (t.v === 'length' || t.v === 'sqrt') {
          this.i++; this.eatOp('('); const e = this.expr(); this.eatOp(')');
          this.pc += 2;
          return { t: 'builtin', name: t.v, e, pc: this.pc };
        }
        if (t.v === 'read') { this.i++; this.eatOp('('); this.eatOp(')'); this.pc += 2; return { t: 'read' }; }
      }
      return this.err();
    }
  }
  /** Bytes bc's compiler uses for a number constant: zero and one are single opcodes. */
  function constLen(text) {
    if (/^0*\.?0*$/.test(text) || /^0*1$/.test(text)) return 1;
    return 2 + text.replace(/^0+(?=\d)/, '').replace(/^0\./, '.').length;
  }
  function parseLiteral(text, base) {
    let intPart = text; let frac = '';
    const dot = text.indexOf('.');
    if (dot >= 0) { intPart = text.slice(0, dot); frac = text.slice(dot + 1); }
    const digit = (ch) => { const d = parseInt(ch, 36); return d >= base ? base - 1 : d; };
    const all = intPart + frac;
    const digits = Array.from(all, (ch) => (all.length === 1 ? parseInt(ch, 36) : digit(ch)));
    if (base === 10 && /^[0-9]*$/.test(all)) return num(BigInt(all || '0'), frac.length);
    // other bases: the integer part is exact, the fraction is truncated to the same digit count
    let v = 0n; const B = BigInt(base);
    for (const d of digits.slice(0, intPart.length)) v = v * B + BigInt(d);
    if (!frac) return num(v, 0);
    let f = 0n; let den = 1n;
    for (const d of digits.slice(intPart.length)) { f = f * B + BigInt(d); den *= B; }
    const s = frac.length;
    return num(v * pow10(s) + (f * pow10(s)) / den, s);
  }

  /* ------------------------------------------------------- interpreter */
  class Bc {
    constructor(ctx, opts) {
      this.ctx = ctx; this.opts = opts;
      this.scale = 0; this.ibase = 10; this.obase = 10;
      this.vars = new Map(); this.arrays = new Map(); this.funcs = new Map();
      this.last = ZERO; this.col = 0; this.buf = '';
      this.func = '(main)'; this.pcBase = 0; this.depth = 0; this.ticks = 0;
      if (opts.lib) this.scale = 20;
    }
    out(s) {
      for (const ch of s) {
        if (ch === '\n') { this.buf += ch; this.col = 0; continue; }
        this.buf += ch; this.col++;
      }
    }
    flush() { if (this.buf) { this.ctx.out(this.buf); this.buf = ''; } }
    warn(msg, pc) { this.flush(); this.ctx.err('Runtime warning (func=' + this.func + ', adr=' + pc + '): ' + msg + '\n'); }
    fail(msg, pc) { throw new BcError('Runtime error (func=' + this.func + ', adr=' + pc + '): ' + msg); }
    async tick() { if (++this.ticks % 512 === 0) { await new Promise((r) => setTimeout(r, 0)); this.ctx.checkAbort(); } }

    /** Print a number in obase with bc's 70 column wrapping. */
    printNum(a) {
      let text;
      const neg = a.v < 0n; const av = neg ? -a.v : a.v;
      const ip = av / pow10(a.s); const fp = av % pow10(a.s);
      if (this.obase === 10) {
        text = a.s ? (ip === 0n ? '' : ip.toString()) + '.' + fp.toString().padStart(a.s, '0') : ip.toString();
        if (ip === 0n && fp === 0n) text = '0';
        if (a.s && ip === 0n && fp !== 0n) text = '.' + fp.toString().padStart(a.s, '0');
        return this.emitNum((neg && av !== 0n ? '-' : '') + text);
      }
      const B = BigInt(this.obase);
      const digitText = (d) => (this.obase <= 16 ? d.toString(16).toUpperCase() : ' ' + d.toString().padStart(String(this.obase - 1).length, '0'));
      let s = '';
      if (ip === 0n) s = a.s && fp !== 0n ? '' : '0';
      else { let x = ip; const ds = []; while (x > 0n) { ds.push(x % B); x /= B; } s = ds.reverse().map(digitText).join(''); }
      if (a.s) {
        let frac = fp; const limit = pow10(a.s); let f = '';
        let n = 0; for (let q = 1n; q < limit; q *= B) n++;
        for (let i = 0; i < n; i++) {
          frac *= B; const d = frac / limit; frac %= limit;
          f += i === 0 ? digitText(d).trimStart() : digitText(d);
        }
        s += '.' + f;
      }
      if (this.obase > 16 && !s.startsWith(' ') && s !== '0') s = ' ' + s;
      return this.emitNum((neg && av !== 0n ? '-' : '') + s);
    }
    emitNum(text) {
      for (const ch of text) {
        if (this.col >= 68) { this.out('\\\n'); }
        this.out(ch);
      }
    }

    getVar(name) { return this.vars.has(name) ? this.vars.get(name) : ZERO; }
    getElem(name, i) { const a = this.arrays.get(name); return a && a.has(i) ? a.get(i) : ZERO; }
    toIndex(n, name, pc) {
      const i = n.v / pow10(n.s);
      if (i < 0n) this.fail('Array ' + name + ' subscript out of bounds.', pc);
      return String(i);
    }
    setSpecial(name, val, pc) {
      const n = val.v / pow10(val.s);
      if (name === 'scale') {
        if (n < 0n) { this.warn('negative scale, set to 0', pc); this.scale = 0; } else this.scale = Number(n);
      } else if (name === 'ibase') {
        if (n < 2n) { this.warn('ibase too small, set to 2', pc); this.ibase = 2; } else if (n > 16n) { this.warn('ibase too large, set to 16', pc); this.ibase = 16; } else this.ibase = Number(n);
      } else if (name === 'obase') {
        if (n < 2n) { this.warn('obase too small, set to 2', pc); this.obase = 2; } else if (n > 999n) { this.warn('obase too large, set to 999', pc); this.obase = 999; } else this.obase = Number(n);
      } else this.last = val;
    }
    getSpecial(name) {
      return name === 'scale' ? num(BigInt(this.scale)) : name === 'ibase' ? num(BigInt(this.ibase)) : name === 'obase' ? num(BigInt(this.obase)) : this.last;
    }
    async readTarget(t) {
      if (t.t === 'var') return this.getVar(t.name);
      if (t.t === 'special') return this.getSpecial(t.name);
      return this.getElem(t.name, this.toIndex(await this.eval(t.idx), t.name, t.pc));
    }
    async writeTarget(t, val, pc, idxKey) {
      if (t.t === 'var') this.vars.set(t.name, val);
      else if (t.t === 'special') this.setSpecial(t.name, val, pc);
      else {
        if (!this.arrays.has(t.name)) this.arrays.set(t.name, new Map());
        this.arrays.get(t.name).set(idxKey, val);
      }
    }
    arith(op, a, b, pc) {
      switch (op) {
        case '+': return add(a, b);
        case '-': return sub(a, b);
        case '*': return mul(a, b, this.scale);
        case '/': if (isZero(b)) this.fail('Divide by zero', pc); return div(a, b, this.scale);
        case '%': if (isZero(b)) this.fail('Modulo by zero', pc); return mod(a, b, this.scale);
        default: {
          if (b.v % pow10(b.s) !== 0n) this.warn('non-zero scale in exponent', pc);
          try { return power(a, b, this.scale); } catch (e) { if (e instanceof BcError) this.fail('exponent too large in raise', pc); throw e; }
        }
      }
    }
    async eval(n) {
      switch (n.t) {
        case 'num': return parseLiteral(n.text, this.ibase);
        case 'paren': return this.eval(n.e);
        case 'var': return this.getVar(n.name);
        case 'special': return this.getSpecial(n.name);
        case 'elem': return this.getElem(n.name, this.toIndex(await this.eval(n.idx), n.name, n.pc));
        case 'neg': { const v = await this.eval(n.e); return neg(v); }
        case 'not': return isZero(await this.eval(n.e)) ? ONE : ZERO;
        case 'bin': {
          if (n.op === '&&') { const l = await this.eval(n.l); if (isZero(l)) return ZERO; return isZero(await this.eval(n.r)) ? ZERO : ONE; }
          if (n.op === '||') { const l = await this.eval(n.l); if (!isZero(l)) return ONE; return isZero(await this.eval(n.r)) ? ZERO : ONE; }
          const a = await this.eval(n.l); const b = await this.eval(n.r);
          if (['==', '<=', '>=', '!=', '<', '>'].includes(n.op)) {
            const c = cmpNum(a, b);
            const r = { '==': c === 0, '<=': c <= 0, '>=': c >= 0, '!=': c !== 0, '<': c < 0, '>': c > 0 }[n.op];
            return r ? ONE : ZERO;
          }
          return this.arith(n.op, a, b, n.pc);
        }
        case 'assign': {
          let key = null;
          if (n.target.t === 'elem') key = this.toIndex(await this.eval(n.target.idx), n.target.name, n.pc - 2);
          let val = await this.eval(n.e);
          if (n.op !== '=') {
            const cur = n.target.t === 'elem' ? this.getElem(n.target.name, key) : await this.readTarget(n.target);
            val = this.arith(n.op.slice(0, -1), cur, val, n.pc);
          }
          if (n.target.t === 'special' && n.target.name === 'scale') val = rescale(val, 0);
          await this.writeTarget(n.target, val, n.pc, key);
          return val;
        }
        case 'incr': {
          let key = null;
          if (n.target.t === 'elem') key = this.toIndex(await this.eval(n.target.idx), n.target.name, n.target.pc);
          const cur = n.target.t === 'elem' ? this.getElem(n.target.name, key) : await this.readTarget(n.target);
          const nv = n.op === '++' ? add(cur, ONE) : sub(cur, ONE);
          await this.writeTarget(n.target, nv, 0, key);
          return n.prefix ? nv : cur;
        }
        case 'builtin': {
          const v = await this.eval(n.e);
          if (n.name === 'scale') return num(BigInt(v.s));
          if (n.name === 'length') return num(BigInt(digitsOf(v)));
          if (v.v < 0n) this.fail('Square root of a negative number', n.pc);
          return sqrtNum(v, this.scale);
        }
        case 'read': return ZERO;
        case 'call': return this.call(n);
        default: throw new Error('bc: bad node ' + n.t);
      }
    }
    async call(n) {
      const lib = this.opts.lib && MATHFN[n.name];
      if (lib && !this.funcs.has(n.name)) {
        const args = []; for (const a of n.args) args.push(await this.eval(a));
        if (args.length !== 1) this.fail('Parameter number mismatch', n.pc);
        if (n.name === 'l' && args[0].v <= 0n) return div(sub(ONE, num(pow10(this.scale))), ONE, this.scale);
        return mathFn(args[0], this.scale, lib);
      }
      const f = this.funcs.get(n.name);
      if (!f) this.fail('Function ' + n.name + ' not defined.', n.pc);
      if (f.params.length !== n.args.length) this.fail('Parameter number mismatch', n.pc);
      if (++this.depth > 1000) { this.depth = 0; this.fail('Stack overflow', n.pc); }
      const args = [];
      for (let i = 0; i < n.args.length; i++) {
        const a = n.args[i];
        if (f.params[i].array) args.push(a.t === 'arrayref' ? new Map(this.arrays.get(a.name) || []) : new Map());
        else args.push(await this.eval(a));
      }
      const saved = [];
      const bindScalar = (name, v) => { saved.push([name, false, this.vars.has(name), this.vars.get(name)]); this.vars.set(name, v); };
      const bindArray = (name, v) => { saved.push([name, true, this.arrays.has(name), this.arrays.get(name)]); this.arrays.set(name, v); };
      f.params.forEach((p, i) => (p.array ? bindArray(p.name, args[i]) : bindScalar(p.name, args[i])));
      for (const a of f.autos) (a.array ? bindArray(a.name, new Map()) : bindScalar(a.name, ZERO));
      const prevFunc = this.func; this.func = n.name;
      let result = ZERO;
      try { await this.execList(f.body); } catch (e) {
        if (!(e instanceof Flow && e.kind === 'return')) throw e;
        result = e.value || ZERO;
      } finally {
        this.func = prevFunc; this.depth--;
        for (const [name, isArr, had, old] of saved.reverse()) {
          const store = isArr ? this.arrays : this.vars;
          if (had) store.set(name, old); else store.delete(name);
        }
      }
      return result;
    }
    async execList(list) { for (const s of list) await this.exec(s); }
    async exec(s) {
      await this.tick();
      switch (s.t) {
        case 'block': await this.execList(s.body); return;
        case 'expr': {
          const v = await this.eval(s.e);
          if (s.e.t === 'assign') return;
          this.printNum(v); this.out('\n'); this.last = v; return;
        }
        case 'string': this.out(s.text); return;
        case 'print':
          for (const it of s.items) {
            if (it.str !== undefined) this.out(it.str.replace(/\\([abfnrqt\\])/g, (m, c) => ({ a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', q: '"', t: '\t', '\\': '\\' }[c])));
            else { const v = await this.eval(it.e); this.printNum(v); this.last = v; }
          }
          return;
        case 'if':
          if (!isZero(await this.eval(s.cond))) await this.exec(s.then); else if (s.other) await this.exec(s.other);
          return;
        case 'while':
          while (!isZero(await this.eval(s.cond))) {
            try { await this.exec(s.body); } catch (e) { if (e instanceof Flow && e.kind === 'break') break; if (!(e instanceof Flow && e.kind === 'continue')) throw e; }
          }
          return;
        case 'for':
          if (s.init) await this.eval(s.init);
          while (!s.cond || !isZero(await this.eval(s.cond))) {
            try { await this.exec(s.body); } catch (e) { if (e instanceof Flow && e.kind === 'break') break; if (!(e instanceof Flow && e.kind === 'continue')) throw e; }
            if (s.step) await this.eval(s.step);
          }
          return;
        case 'break': case 'continue': throw new Flow(s.t);
        case 'return': throw new Flow('return', s.e ? await this.eval(s.e) : ZERO);
        case 'halt': case 'quit': throw new Flow('quit');
        case 'define': this.funcs.set(s.name, s); return;
        case 'limits':
          this.out('BC_BASE_MAX     = 99\nBC_DIM_MAX      = 16777215\nBC_SCALE_MAX    = 2147483647\nBC_STRING_MAX   = 2147483647\nMAX Exponent   = 2147483647\nNumber of vars = 32767\n');
          return;
        default: return;
      }
    }
  }
  const MATHFN = { s: 's', c: 'c', a: 'a', l: 'l', e: 'e' };

  /* ----------------------------------------------------------- command */
  const USAGE = 'usage: bc [options] [file ...]\n  -h  --help         print this usage and exit\n  -i  --interactive  force interactive mode\n  -l  --mathlib      use the predefined math routines\n  -q  --quiet        don\'t print initial banner\n  -s  --standard     non-standard bc constructs are errors\n  -w  --warn         warn about non-standard bc constructs\n  -v  --version      print version information and exit\n';
  const VERSION = 'bc 1.07.1\nCopyright 1991-1994, 1997, 1998, 2000, 2004, 2006, 2008, 2012-2017 Free Software Foundation, Inc.\n';

  /** Does the text so far end inside an open { ( comment, string or after a backslash? */
  function incomplete(text) {
    const r = lex(text, 1);
    if (r.unterminated) return true;
    let depth = 0;
    for (const t of r.toks) if (t.t === 'op') { if (t.v === '{' || t.v === '(') depth++; else if (t.v === '}' || t.v === ')') depth--; }
    return depth > 0 || /\\\s*$/.test(text.replace(/\n$/, ''));
  }

  const MAN = `DESCRIPTION
       bc is an arbitrary precision calculator language. It reads expressions
       and statements from the files named on the command line and then from
       standard input, evaluates them and prints the results.

OPTIONS
       -l, --mathlib       define the math library (s c a l e j) and set scale to 20
       -q, --quiet         do not print the welcome banner
       -s, --standard      treat non-standard bc constructs as errors
       -w, --warn          warn about non-standard bc constructs
       -v, --version       print the version and exit
       -h, --help          print a usage message

LANGUAGE
       Numbers have an arbitrary number of digits; "scale" sets how many digits
       follow the decimal point in division. ibase and obase set the input and
       output base. Operators: + - * / % ^ and comparisons, && || !, ++ --.
       Statements: if, while, for, break, continue, define, return, print,
       quit. Variables are single names; arrays are written a[i]. With -l the
       functions s(x), c(x), a(x), l(x) and e(x) are available.

EXAMPLES
       echo "scale=4; 22/7" | bc
       echo "obase=2; 255" | bc
       echo "scale=20; 4*a(1)" | bc -l`;

  K.cmd.register({
    name: 'bc',
    pkg: 'bc',
    summary: 'An arbitrary precision calculator language',
    synopsis: 'bc [ -hlwsqv ] [long-options] [ file ... ]',
    man: MAN,
    async run(ctx) {
      const opts = { lib: false, quiet: false, std: false, files: [] };
      for (const a of ctx.args) {
        if (a === '--help') { ctx.out(USAGE); return 0; }
        if (a === '--version') { ctx.out(VERSION); return 0; }
        if (a === '--mathlib') opts.lib = true;
        else if (a === '--quiet') opts.quiet = true;
        else if (a === '--standard') opts.std = true;
        else if (a === '--warn' || a === '--interactive') continue;
        else if (a.startsWith('--') && a.length > 2) { ctx.err('bc: unrecognized option ' + a + '\n' + USAGE); return 1; }
        else if (a[0] === '-' && a.length > 1) {
          for (const c of a.slice(1)) {
            if (c === 'h') { ctx.out(USAGE); return 0; }
            if (c === 'v') { ctx.out(VERSION); return 0; }
            if (c === 'l') opts.lib = true;
            else if (c === 'q') opts.quiet = true;
            else if (c === 's') opts.std = true;
            else if (c !== 'w' && c !== 'i') { ctx.err("bc: invalid option -- '" + c + "'\n" + USAGE); return 1; }
          }
        } else opts.files.push(a);
      }
      const bc = new Bc(ctx, opts);
      const sources = [];
      for (const f of opts.files) {
        try { sources.push({ name: f, text: ctx.fs.read(f) }); } catch (e) {
          if (!(e instanceof K.FsError)) throw e;
          ctx.err('File ' + f + ' is unavailable.\n'); return 1;
        }
      }
      let quit = false;
      for (const src of sources) { quit = await feed(ctx, bc, src.text, src.name); if (quit) break; }
      if (!quit) {
        const interactive = ctx.stdin == null;
        if (interactive && !opts.quiet) ctx.out(VERSION + 'This is free software with ABSOLUTELY NO WARRANTY.\nFor details type `warranty\'. \n');
        let text = '';
        if (ctx.stdin != null) text = ctx.stdin;
        else {
          // terminal: run line by line as typed
          let pending = '';
          for (;;) {
            let line;
            try { line = await ctx.readLine(''); } catch (e) { if (e instanceof K.Interrupt) { ctx.out('\n(interrupt) Use quit to exit.\n'); pending = ''; continue; } throw e; }
            if (line == null) break;
            pending += line + '\n';
            if (incomplete(pending)) continue;
            const q = await feed(ctx, bc, pending, '(standard_in)');
            pending = '';
            if (q) break;
          }
          bc.flush();
          return 0;
        }
        await feed(ctx, bc, text, '(standard_in)');
      }
      bc.flush();
      return 0;
    },
  });

  /** Run program text chunk by chunk (a chunk is one input line, or a whole { } construct). Returns true after quit. */
  async function feed(ctx, bc, text, where) {
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    let lineNo = 0; let chunk = ''; let chunkStart = 1;
    /** Returns 'quit', 'more' (the construct is not finished) or 'done'. */
    const run = async (src, startLine, atEof) => {
      const lexed = lex(src, startLine);
      let list;
      let failed = false;
      try { list = new Parser(lexed.toks, 0).statements(); } catch (e) {
        if (!(e instanceof SyntaxErr)) throw e;
        if (e.eof && !atEof && !lexed.illegal.length) return 'more';
        bc.flush();
        for (const il of lexed.illegal) ctx.err(where + ' ' + il.line + ': illegal character: ' + il.ch + '\n');
        ctx.err(where + ' ' + e.line + ': syntax error\n');
        return 'done';
      }
      if (lexed.illegal.length) {
        bc.flush();
        for (const il of lexed.illegal) ctx.err(where + ' ' + il.line + ': illegal character: ' + il.ch + '\n');
        failed = true;
      }
      if (failed) return 'done';
      if (list.some((st) => st.t === 'quit')) return 'quit';
      try { await bc.execList(list); } catch (e) {
        if (e instanceof Flow && e.kind === 'quit') return 'quit';
        if (e instanceof Flow) return 'done';
        if (e instanceof BcError) { bc.flush(); ctx.err(e.message + '\n'); return 'done'; }
        throw e;
      }
      bc.flush();
      return 'done';
    };
    for (const line of lines) {
      lineNo++;
      if (!chunk) chunkStart = lineNo;
      chunk += line + '\n';
      if (incomplete(chunk)) continue;
      const r = await run(chunk, chunkStart, false);
      if (r === 'more') continue;
      chunk = '';
      if (r === 'quit') return true;
    }
    if (chunk) {
      const r = lex(chunk, chunkStart);
      bc.flush();
      if (r.unterminated === 'comment') ctx.err('EOF encountered in a comment.\n');
      else if (r.unterminated === 'string') ctx.err(where + ' ' + chunkStart + ': illegal character: "\n');
      else await run(chunk, chunkStart, true);
    }
    return false;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ================================================================= openssl */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;

  /* --------------------------------------------------- message digests */
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const PRIMES = [];
  for (let n = 2; PRIMES.length < 80; n++) if (PRIMES.every((p) => n % p)) PRIMES.push(n);
  /** floor(frac(p^(1/root)) * 2^bits) with exact integer arithmetic. */
  function fracBits(p, root, bits) {
    const target = BigInt(p) << BigInt(root * bits);
    let lo = 0n; let hi = 1n << BigInt(bits + 8);
    while (lo < hi) { const mid = (lo + hi + 1n) >> 1n; if (mid ** BigInt(root) <= target) lo = mid; else hi = mid - 1n; }
    return lo & ((1n << BigInt(bits)) - 1n);
  }
  let tables = null;
  function sha2Tables() {
    if (tables) return tables;
    const k256 = PRIMES.slice(0, 64).map((p) => Number(fracBits(p, 3, 32)));
    const k512 = PRIMES.map((p) => fracBits(p, 3, 64));
    const h = (from, bits) => PRIMES.slice(from, from + 8).map((p) => fracBits(p, 2, bits));
    tables = {
      k256, k512,
      h256: h(0, 32).map(Number),
      h224: h(8, 64).map((v) => Number(v & 0xffffffffn)),
      h512: h(0, 64), h384: h(8, 64),
    };
    return tables;
  }
  /** Pad per MD construction: 0x80, zeros, bit length in `lenBytes` bytes. */
  function mdPad(bytes, block, lenBytes, littleEndian) {
    const total = Math.ceil((bytes.length + 1 + lenBytes) / block) * block;
    const out = new Uint8Array(total);
    out.set(bytes); out[bytes.length] = 0x80;
    let bits = BigInt(bytes.length) * 8n;
    for (let i = 0; i < lenBytes; i++) {
      out[littleEndian ? total - lenBytes + i : total - 1 - i] = Number(bits & 255n); bits >>= 8n;
    }
    return out;
  }
  function md5(bytes) {
    const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const T = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);
    const data = mdPad(bytes, 64, 8, true);
    let a0 = 0x67452301; let b0 = 0xefcdab89 | 0; let c0 = 0x98badcfe | 0; let d0 = 0x10325476;
    for (let off = 0; off < data.length; off += 64) {
      const M = Array.from({ length: 16 }, (_, i) => data[off + 4 * i] | (data[off + 4 * i + 1] << 8) | (data[off + 4 * i + 2] << 16) | (data[off + 4 * i + 3] << 24));
      let A = a0; let B = b0; let C = c0; let D = d0;
      for (let i = 0; i < 64; i++) {
        let F; let g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + T[i] + M[g]) | 0;
        A = D; D = C; C = B; B = (B + rotl(F, S[(i >> 4) * 4 + (i % 4)])) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    return [a0, b0, c0, d0].flatMap((w) => [w & 255, (w >>> 8) & 255, (w >>> 16) & 255, (w >>> 24) & 255]);
  }
  const be32 = (words) => words.flatMap((w) => [(w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255]);
  function sha1(bytes) {
    const data = mdPad(bytes, 64, 8, false);
    let h = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0];
    for (let off = 0; off < data.length; off += 64) {
      const w = Array.from({ length: 80 }, (_, i) => (i < 16 ? (data[off + 4 * i] << 24) | (data[off + 4 * i + 1] << 16) | (data[off + 4 * i + 2] << 8) | data[off + 4 * i + 3] : 0));
      for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
      let [a, b, c, d, e] = h;
      for (let i = 0; i < 80; i++) {
        const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc | 0] : [b ^ c ^ d, 0xca62c1d6 | 0];
        const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
        e = d; d = c; c = rotl(b, 30); b = a; a = t;
      }
      h = [(h[0] + a) | 0, (h[1] + b) | 0, (h[2] + c) | 0, (h[3] + d) | 0, (h[4] + e) | 0];
    }
    return be32(h);
  }
  function sha256(bytes, is224) {
    const t = sha2Tables();
    const data = mdPad(bytes, 64, 8, false);
    let h = (is224 ? t.h224 : t.h256).map((x) => x | 0);
    for (let off = 0; off < data.length; off += 64) {
      const w = Array.from({ length: 64 }, (_, i) => (i < 16 ? (data[off + 4 * i] << 24) | (data[off + 4 * i + 1] << 16) | (data[off + 4 * i + 2] << 8) | data[off + 4 * i + 3] : 0));
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + t.k256[i] + w[i]) | 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h = [a, b, c, d, e, f, g, hh].map((v, i) => (h[i] + v) | 0);
    }
    return be32(is224 ? h.slice(0, 7) : h);
  }
  const M64 = (1n << 64n) - 1n;
  const rotr64 = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64;
  function sha512(bytes, is384) {
    const t = sha2Tables();
    const data = mdPad(bytes, 128, 16, false);
    let h = (is384 ? t.h384 : t.h512).slice();
    for (let off = 0; off < data.length; off += 128) {
      const w = [];
      for (let i = 0; i < 16; i++) { let v = 0n; for (let j = 0; j < 8; j++) v = (v << 8n) | BigInt(data[off + 8 * i + j]); w.push(v); }
      for (let i = 16; i < 80; i++) {
        const s0 = rotr64(w[i - 15], 1) ^ rotr64(w[i - 15], 8) ^ (w[i - 15] >> 7n);
        const s1 = rotr64(w[i - 2], 19) ^ rotr64(w[i - 2], 61) ^ (w[i - 2] >> 6n);
        w.push((w[i - 16] + s0 + w[i - 7] + s1) & M64);
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 80; i++) {
        const t1 = (hh + (rotr64(e, 14) ^ rotr64(e, 18) ^ rotr64(e, 41)) + ((e & f) ^ (~e & M64 & g)) + t.k512[i] + w[i]) & M64;
        const t2 = ((rotr64(a, 28) ^ rotr64(a, 34) ^ rotr64(a, 39)) + ((a & b) ^ (a & c) ^ (b & c))) & M64;
        hh = g; g = f; f = e; e = (d + t1) & M64; d = c; c = b; b = a; a = (t1 + t2) & M64;
      }
      h = [a, b, c, d, e, f, g, hh].map((v, i) => (h[i] + v) & M64);
    }
    return h.slice(0, is384 ? 6 : 8).flatMap((v) => Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(56 - 8 * i)) & 255n)));
  }
  /** name as printed by dgst, block size, function */
  const DIGESTS = {
    md5: { label: 'MD5', block: 64, fn: md5 },
    sha1: { label: 'SHA1', block: 64, fn: sha1 },
    sha224: { label: 'SHA2-224', block: 64, fn: (b) => sha256(b, true) },
    sha256: { label: 'SHA2-256', block: 64, fn: (b) => sha256(b, false) },
    sha384: { label: 'SHA2-384', block: 128, fn: (b) => sha512(b, true) },
    sha512: { label: 'SHA2-512', block: 128, fn: (b) => sha512(b, false) },
  };
  function hmac(alg, key, msg) {
    const d = DIGESTS[alg];
    let k = key.length > d.block ? d.fn(key) : key.slice();
    while (k.length < d.block) k.push(0);
    const inner = d.fn(k.map((x) => x ^ 0x36).concat(msg));
    return d.fn(k.map((x) => x ^ 0x5c).concat(inner));
  }
  const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  const latin1 = (bytes) => String.fromCharCode(...bytes);

  /* ------------------------------------------------------------ helpers */
  const HELP = { dgst: "Usage: dgst [options] [file...]\n\nGeneral options:\n -help               Display this summary\n -list               List digests\n -engine val         Use engine e, possibly a hardware device\n -engine_impl        Also use engine given by -engine for digest operations\n -passin val         Input file pass phrase source\n\nOutput options:\n -c                  Print the digest with separating colons\n -r                  Print the digest in coreutils format\n -out outfile        Output to filename rather than stdout\n -keyform format     Key file format (ENGINE, other values ignored)\n -hex                Print as hex dump\n -binary             Print in binary form\n -xoflen +int        Output length for XOF algorithms. To obtain the maximum security strength set this to 32 (or greater) for SHAKE128, and 64 (or greater) for SHAKE256\n -d                  Print debug info\n -debug              Print debug info\n\nSigning options:\n -sign val           Sign digest using private key\n -verify val         Verify a signature using public key\n -prverify val       Verify a signature using private key\n -sigopt val         Signature parameter in n:v form\n -signature infile   File with signature to verify\n -hmac val           Create hashed MAC with key\n -mac val            Create MAC (not necessarily HMAC)\n -macopt val         MAC algorithm parameters in n:v form or key\n -*                  Any supported digest\n -fips-fingerprint   Compute HMAC with the key used in OpenSSL-FIPS fingerprint\n\nRandom state options:\n -rand val           Load the given file(s) into the random number generator\n -writerand outfile  Write random data to the specified file\n\nProvider options:\n -provider-path val  Provider load path (must be before 'provider' argument if required)\n -provider val       Provider to load (can be specified multiple times)\n -propquery val      Property query used when fetching algorithms\n\nParameters:\n file                Files to digest (optional; default is stdin)\n", rand: "Usage: rand [options] num\n\nGeneral options:\n -help               Display this summary\n -engine val         Use engine, possibly a hardware device\n\nOutput options:\n -out outfile        Output file\n -base64             Base64 encode output\n -hex                Hex encode output\n\nRandom state options:\n -rand val           Load the given file(s) into the random number generator\n -writerand outfile  Write random data to the specified file\n\nProvider options:\n -provider-path val  Provider load path (must be before 'provider' argument if required)\n -provider val       Provider to load (can be specified multiple times)\n -propquery val      Property query used when fetching algorithms\n\nParameters:\n num                 Number of bytes to generate\n", enc: "Usage: enc [options]\n\nGeneral options:\n -help               Display this summary\n -list               List ciphers\n -ciphers            Alias for -list\n -e                  Encrypt\n -d                  Decrypt\n -p                  Print the iv/key\n -P                  Print the iv/key and exit\n -engine val         Use engine, possibly a hardware device\n\nInput options:\n -in infile          Input file\n -k val              Passphrase\n -kfile infile       Read passphrase from file\n\nOutput options:\n -out outfile        Output file\n -pass val           Passphrase source\n -v                  Verbose output\n -a                  Base64 encode/decode, depending on encryption flag\n -base64             Same as option -a\n -A                  Used with -[base64|a] to specify base64 buffer as a single line\n\nEncryption options:\n -nopad              Disable standard block padding\n -salt               Use salt in the KDF (default)\n -nosalt             Do not use salt in the KDF\n -debug              Print debug info\n -bufsize val        Buffer size\n -K val              Raw key, in hex\n -S val              Salt, in hex\n -iv val             IV in hex\n -md val             Use specified digest to create a key from the passphrase\n -iter +int          Specify the iteration count and force the use of PBKDF2\n                     Default: 10000\n -pbkdf2             Use password-based key derivation function 2 (PBKDF2)\n                     Use -iter to change the iteration count from 10000\n -none               Don't encrypt\n -*                  Any supported cipher\n\nRandom state options:\n -rand val           Load the given file(s) into the random number generator\n -writerand outfile  Write random data to the specified file\n\nProvider options:\n -provider-path val  Provider load path (must be before 'provider' argument if required)\n -provider val       Provider to load (can be specified multiple times)\n -propquery val      Property query used when fetching algorithms\n", version: "Usage: version [options]\n\nGeneral options:\n -help  Display this summary\n\nOutput options:\n -a     Show all data\n -b     Show build date\n -d     Show configuration directory\n -e     Show engines directory\n -m     Show modules directory\n -f     Show compiler flags used\n -o     Show some internal datatype options\n -p     Show target build platform\n -r     Show random seeding options\n -v     Show library version\n -c     Show CPU settings info\n" };
  const helpListing = "help:\n\nStandard commands\nasn1parse         ca                ciphers           cmp               \ncms               crl               crl2pkcs7         dgst              \ndhparam           dsa               dsaparam          ec                \necparam           enc               engine            errstr            \nfipsinstall       gendsa            genpkey           genrsa            \nhelp              info              kdf               list              \nmac               nseq              ocsp              passwd            \npkcs12            pkcs7             pkcs8             pkey              \npkeyparam         pkeyutl           prime             rand              \nrehash            req               rsa               rsautl            \ns_client          s_server          s_time            sess_id           \nsmime             speed             spkac             srp               \nstoreutl          ts                verify            version           \nx509              \n\nMessage Digest commands (see the `dgst' command for more details)\nblake2b512        blake2s256        md4               md5               \nrmd160            sha1              sha224            sha256            \nsha3-224          sha3-256          sha3-384          sha3-512          \nsha384            sha512            sha512-224        sha512-256        \nshake128          shake256          sm3               \n\nCipher commands (see the `enc' command for more details)\naes-128-cbc       aes-128-ecb       aes-192-cbc       aes-192-ecb       \naes-256-cbc       aes-256-ecb       aria-128-cbc      aria-128-cfb      \naria-128-cfb1     aria-128-cfb8     aria-128-ctr      aria-128-ecb      \naria-128-ofb      aria-192-cbc      aria-192-cfb      aria-192-cfb1     \naria-192-cfb8     aria-192-ctr      aria-192-ecb      aria-192-ofb      \naria-256-cbc      aria-256-cfb      aria-256-cfb1     aria-256-cfb8     \naria-256-ctr      aria-256-ecb      aria-256-ofb      base64            \nbf                bf-cbc            bf-cfb            bf-ecb            \nbf-ofb            camellia-128-cbc  camellia-128-ecb  camellia-192-cbc  \ncamellia-192-ecb  camellia-256-cbc  camellia-256-ecb  cast              \ncast-cbc          cast5-cbc         cast5-cfb         cast5-ecb         \ncast5-ofb         des               des-cbc           des-cfb           \ndes-ecb           des-ede           des-ede-cbc       des-ede-cfb       \ndes-ede-ofb       des-ede3          des-ede3-cbc      des-ede3-cfb      \ndes-ede3-ofb      des-ofb           des3              desx              \nrc2               rc2-40-cbc        rc2-64-cbc        rc2-cbc           \nrc2-cfb           rc2-ecb           rc2-ofb           rc4               \nrc4-40            seed              seed-cbc          seed-cfb          \nseed-ecb          seed-ofb          sm4-cbc           sm4-cfb           \nsm4-ctr           sm4-ecb           sm4-ofb           \n\n";
  const VERSION_LINE = 'OpenSSL 3.5.1 1 Jul 2025 (Library: OpenSSL 3.5.1 1 Jul 2025)';
  const toBytes = (s) => U.toBytes(s);

  /** The 16-hex-digit thread id OpenSSL puts in front of its error queue lines. */
  const errId = () => Array.from({ length: 16 }, () => '0123456789ABCDEF'[Math.floor(K.net.rand() * 16)]).join('');

  async function readStdin(ctx) {
    if (ctx.stdin != null) return ctx.stdin;
    let s = '';
    for (;;) { const l = await ctx.readLine(''); if (l == null) return s; s += l + '\n'; }
  }
  /** Contents of a file operand ("-" or none: stdin); null after reporting the failure. */
  async function readFile(ctx, path, sub, kind) {
    if (path === null || path === '-') return readStdin(ctx);
    try { return ctx.fs.read(path); } catch (e) {
      if (!(e instanceof K.FsError)) throw e;
      if (kind === 'dgst') {
        if (e.code === 'EISDIR') {
          ctx.err('Read error in ' + path + '\n' + errId() + ':error:80000015:system library:file_read:Is a directory:../crypto/bio/bss_file.c:148:calling fread()\n' + errId() + ':error:10080002:BIO routines:file_read:system lib:../crypto/bio/bss_file.c:150:\n');
        } else {
          ctx.err(path + ': ' + e.message + '\n' + errId() + ':error:80000002:system library:file_ctrl:' + e.message + ':../crypto/bio/bss_file.c:297:calling fopen(' + path + ', r)\n' + errId() + ':error:10080002:BIO routines:file_ctrl:system lib:../crypto/bio/bss_file.c:300:\n');
        }
      } else {
        ctx.err('Can\'t open "' + path + '" for reading, ' + e.message + '\n' + errId() + ':error:80000002:system library:BIO_new_file:' + e.message + ':../crypto/bio/bss_file.c:67:calling fopen(' + path + ', rb)\n' + errId() + ':error:10000080:BIO routines:BIO_new_file:no such file:../crypto/bio/bss_file.c:75:\n');
      }
      return null;
    }
  }
  function writeOut(ctx, path, text) {
    if (path == null) { ctx.out(text); return true; }
    try { ctx.fs.write(path, text); return true; } catch (e) {
      if (!(e instanceof K.FsError)) throw e;
      ctx.err('Can\'t open "' + path + '" for writing, ' + e.message + '\n');
      return false;
    }
  }
  const usage = (ctx, sub) => { ctx.err(sub + ': Use -help for summary.\n'); return 1; };

  /* ---------------------------------------------------------- commands */
  async function dgst(ctx, sub, args, fixedAlg) {
    let alg = fixedAlg;
    const o = { files: [] };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { o.files.push(...args.slice(i + 1)); break; }
      if (a[0] !== '-' || a === '-') { o.files.push(a); continue; }
      const opt = a.replace(/^--?/, '');
      if (opt === 'help' || opt === 'h') { ctx.err(HELP.dgst); return 0; }
      if (opt === 'list') { ctx.out('Supported digests:\n' + Object.keys(DIGESTS).map((d) => '-' + d).join('\n') + '\n'); return 0; }
      if (opt === 'r') o.coreutils = true;
      else if (opt === 'hex') o.hex = true;
      else if (opt === 'binary') o.binary = true;
      else if (opt === 'c') o.colons = true;
      else if (opt === 'out' || opt === 'hmac' || opt === 'sign' || opt === 'verify' || opt === 'passin' || opt === 'engine') {
        if (i + 1 >= args.length) { ctx.err(sub + ': Option -' + opt + ' needs a value\n'); return usage(ctx, sub); }
        o[opt] = args[++i];
      } else if (opt in DIGESTS) alg = opt;
      else {
        ctx.err(sub + ': Unknown option or message digest: ' + opt + '\n' + sub + ': Use -help for summary.\n' + errId() + ':error:0308010C:digital envelope routines:inner_evp_generic_fetch:unsupported:../crypto/evp/evp_fetch.c:386:Global default library context, Algorithm (' + opt + ' : 0), Properties (<null>)\n');
        return 1;
      }
    }
    const algName = alg || 'sha256';
    const d = DIGESTS[algName];
    const label = (alg ? d.label : 'SHA256');
    let status = 0; let text = '';
    for (const f of o.files.length ? o.files : [null]) {
      const content = await readFile(ctx, f, sub, 'dgst');
      if (content === null) { status = 1; continue; }
      const bytes = toBytes(content);
      const digest = o.hmac !== undefined ? hmac(algName, toBytes(o.hmac), bytes) : d.fn(bytes);
      const shown = f === null || f === '-' ? 'stdin' : f;
      if (o.binary) text += latin1(digest);
      else {
        const h = o.colons ? digest.map((b) => b.toString(16).padStart(2, '0')).join(':') : hex(digest);
        text += o.coreutils ? h + ' *' + shown + '\n' : (o.hmac !== undefined && f !== null ? 'HMAC-' : '') + label + '(' + shown + ')= ' + h + '\n';
      }
    }
    if (!writeOut(ctx, o.out, text)) return 1;
    return status;
  }

  function b64Decode(text) {
    const s = text.replace(/\s/g, '');
    const m = /^([A-Za-z0-9+/]*)(={0,2})$/.exec(s);
    if (!m || (m[1].length + m[2].length) % 4 !== 0) return null;
    return K.b64.dec(m[1]);
  }

  async function enc(ctx, sub, args) {
    const o = { dec: false, one: false, base64: sub === 'base64' };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-help' || a === '-h') { ctx.err(HELP.enc); return 0; }
      if (a === '-d') o.dec = true;
      else if (a === '-e') o.dec = false;
      else if (a === '-a' || a === '-base64') o.base64 = true;
      else if (a === '-A') o.one = true;
      else if (a === '-in' || a === '-out' || a === '-k' || a === '-pass' || a === '-md' || a === '-iter') {
        if (i + 1 >= args.length) { ctx.err(sub + ': Option ' + a + ' needs a value\n'); return usage(ctx, sub); }
        o[a.slice(1)] = args[++i];
      } else if (/^-(aes|aria|bf|camellia|cast5?|des|rc[24]|seed|sm4)/.test(a) || a === '-pbkdf2' || a === '-salt' || a === '-nosalt' || a === '-p' || a === '-P') {
        if (/^-(aes|aria|bf|camellia|cast5?|des|rc[24]|seed|sm4)/.test(a)) o.cipher = a.slice(1);
      } else {
        ctx.err(sub + ': Unknown cipher: ' + a.replace(/^-+/, '') + '\n' + sub + ': Use -help for summary.\n' + errId() + ':error:0308010C:digital envelope routines:inner_evp_generic_fetch:unsupported:../crypto/evp/evp_fetch.c:386:Global default library context, Algorithm (' + a.replace(/^-+/, '') + ' : 0), Properties (<null>)\n');
        return 1;
      }
    }
    if (o.cipher) { ctx.err(sub + ': the ' + o.cipher + ' cipher is not available in this simulator; use -base64 for encoding\n'); return 1; }
    if (!o.base64) { ctx.err(sub + ': a cipher or -base64 is required in this simulator\n'); return 1; }
    const content = await readFile(ctx, o.in === undefined ? null : o.in, sub, 'enc');
    if (content === null) return 1;
    let result;
    if (o.dec) {
      const bytes = b64Decode(content);
      result = bytes ? latin1To(bytes) : '';
    } else {
      const b = K.b64.enc(toBytes(content));
      result = !b ? '' : o.one ? b : b.replace(/(.{64})(?=.)/g, '$1\n') + '\n';
    }
    return writeOut(ctx, o.out, result) ? 0 : 1;
  }
  const latin1To = (bytes) => U.fromBytes(bytes);

  async function rand(ctx, args) {
    const o = {};
    let count = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-help') { ctx.err(HELP.rand); return 0; }
      if (a === '-hex') o.hex = true;
      else if (a === '-base64') o.b64 = true;
      else if (a === '-out') { if (i + 1 >= args.length) { ctx.err('rand: Option -out needs a value\n'); return usage(ctx, 'rand'); } o.out = args[++i]; }
      else if (a === '-writerand' || a === '-engine') i++;
      else if (a[0] === '-' && a.length > 1) { ctx.err('rand: Unknown option: ' + a + '\n'); return usage(ctx, 'rand'); }
      else if (count !== null) return usage(ctx, 'rand');
      else {
        if (!/^\d+$/.test(a)) { ctx.err('rand: Can\'t parse "' + a + '" as a number\n'); return usage(ctx, 'rand'); }
        count = Number(a);
      }
    }
    if (count === null) { if (o.hex || o.b64) ctx.out('\n'); return 0; }
    if (count < 1) return usage(ctx, 'rand');
    const bytes = Array.from({ length: count }, () => Math.floor(K.net.rand() * 256));
    const text = o.hex ? hex(bytes) + '\n' : o.b64 ? K.b64.enc(bytes).replace(/(.{64})(?=.)/g, '$1\n') + '\n' : latin1(bytes);
    return writeOut(ctx, o.out, text) ? 0 : 1;
  }

  function version(ctx, args) {
    const all = {
      '-v': VERSION_LINE, '-b': 'built on: Tue Jul  1 12:00:00 2025 UTC', '-p': 'platform: debian-amd64', '-o': 'options: bn(64,64)',
      '-d': 'OPENSSLDIR: "/usr/lib/ssl"', '-m': 'MODULESDIR: "/usr/lib/x86_64-linux-gnu/ossl-modules"', '-r': 'Seeding source: os-specific',
    };
    if (!args.length) { ctx.println(VERSION_LINE); return 0; }
    const lines = [];
    for (const a of args) {
      if (a === '-help') { ctx.err(HELP.version); return 0; }
      if (a === '-a') lines.push(...Object.values(all));
      else if (all[a]) lines.push(all[a]);
      else if (a[0] === '-') { ctx.err('version: Unknown option: ' + a + '\n'); return usage(ctx, 'version'); }
      else { ctx.err('Use -help for summary.\n'); return 1; }
    }
    ctx.out(lines.join('\n') + '\n');
    return 0;
  }

  const MAN = `DESCRIPTION
       openssl is a cryptography toolkit. In this simulator the following
       commands are available:

       openssl version [-a]
       openssl dgst [-md5|-sha1|-sha224|-sha256|-sha384|-sha512] [-r] [-hex]
                    [-binary] [-c] [-hmac key] [-out file] [file...]
       openssl md5|sha1|sha224|sha256|sha384|sha512 [file...]
       openssl base64 [-d] [-e] [-A] [-in file] [-out file]
       openssl enc -base64 [-d] [-A] [-in file] [-out file]
       openssl rand [-hex|-base64] [-out file] num

       The digest commands print "SHA2-256(file)= hex" and read standard input
       when no file is given. rand draws from the simulator's seeded generator.

EXAMPLES
       openssl dgst -sha256 /etc/passwd
       echo -n 'password' | openssl dgst -md5
       echo 'user:pass' | openssl base64
       openssl rand -hex 16`;

  K.cmd.register({
    name: 'openssl',
    pkg: 'openssl',
    summary: 'OpenSSL command line program',
    synopsis: 'openssl command [ options ] [ parameters ]',
    man: MAN,
    async run(ctx) {
      const [sub, ...rest] = ctx.args;
      if (sub === undefined || sub === 'help') { ctx.err(helpListing); return 0; }
      if (sub === 'version') return version(ctx, rest);
      if (sub === 'dgst') return dgst(ctx, 'dgst', rest, null);
      if (DIGESTS[sub]) return dgst(ctx, sub, rest, sub);
      if (sub === 'base64' || sub === 'enc') return enc(ctx, sub, rest);
      if (sub === 'rand') return rand(ctx, rest);
      ctx.err('Invalid command \'' + sub + '\'; type "help" for a list.\n');
      return 1;
    },
    complete() { return ['version', 'dgst', 'enc', 'base64', 'rand', 'md5', 'sha1', 'sha256', 'sha512', 'help']; },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ============================================== assorted GNU filters: text */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;

  const HELP = {
    fold: "Usage: fold [OPTION]... [FILE]...\nWrap input lines in each FILE, writing to standard output.\n\nWith no FILE, or when FILE is -, read standard input.\n\nMandatory arguments to long options are mandatory for short options too.\n  -b, --bytes         count bytes rather than columns\n  -s, --spaces        break at spaces\n  -w, --width=WIDTH   use WIDTH columns instead of 80\n      --help        display this help and exit\n      --version     output version information and exit\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/fold>\nor available locally via: info '(coreutils) fold invocation'\n",
    fmt: "Usage: fmt [-WIDTH] [OPTION]... [FILE]...\nReformat each paragraph in the FILE(s), writing to standard output.\nThe option -WIDTH is an abbreviated form of --width=DIGITS.\n\nWith no FILE, or when FILE is -, read standard input.\n\nMandatory arguments to long options are mandatory for short options too.\n  -c, --crown-margin        preserve indentation of first two lines\n  -p, --prefix=STRING       reformat only lines beginning with STRING,\n                              reattaching the prefix to reformatted lines\n  -s, --split-only          split long lines, but do not refill\n  -t, --tagged-paragraph    indentation of first line different from second\n  -u, --uniform-spacing     one space between words, two after sentences\n  -w, --width=WIDTH         maximum line width (default of 75 columns)\n  -g, --goal=WIDTH          goal width (default of 93% of width)\n      --help        display this help and exit\n      --version     output version information and exit\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/fmt>\nor available locally via: info '(coreutils) fmt invocation'\n",
    join: "Usage: join [OPTION]... FILE1 FILE2\nFor each pair of input lines with identical join fields, write a line to\nstandard output.  The default join field is the first, delimited by blanks.\n\nWhen FILE1 or FILE2 (not both) is -, read standard input.\n\n  -a FILENUM             also print unpairable lines from file FILENUM, where\n                           FILENUM is 1 or 2, corresponding to FILE1 or FILE2\n  -e STRING              replace missing (empty) input fields with STRING;\n                           I.e., missing fields specified with '-12jo' options\n  -i, --ignore-case      ignore differences in case when comparing fields\n  -j FIELD               equivalent to '-1 FIELD -2 FIELD'\n  -o FORMAT              obey FORMAT while constructing output line\n  -t CHAR                use CHAR as input and output field separator\n  -v FILENUM             like -a FILENUM, but suppress joined output lines\n  -1 FIELD               join on this FIELD of file 1\n  -2 FIELD               join on this FIELD of file 2\n      --check-order      check that the input is correctly sorted, even\n                           if all input lines are pairable\n      --nocheck-order    do not check that the input is correctly sorted\n      --header           treat the first line in each file as field headers,\n                           print them without trying to pair them\n  -z, --zero-terminated  line delimiter is NUL, not newline\n      --help        display this help and exit\n      --version     output version information and exit\n\nUnless -t CHAR is given, leading blanks separate fields and are ignored,\nelse fields are separated by CHAR.  Any FIELD is a field number counted\nfrom 1.  FORMAT is one or more comma or blank separated specifications,\neach being 'FILENUM.FIELD' or '0'.  Default FORMAT outputs the join field,\nthe remaining fields from FILE1, the remaining fields from FILE2, all\nseparated by CHAR.  If FORMAT is the keyword 'auto', then the first\nline of each file determines the number of fields output for each line.\n\nImportant: FILE1 and FILE2 must be sorted on the join fields.\nE.g., use \"sort -k 1b,1\" if 'join' has no options,\nor use \"join -t ''\" if 'sort' has no options.\nNote, comparisons honor the rules specified by 'LC_COLLATE'.\nIf the input is not sorted and some lines cannot be joined, a\nwarning message will be given.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/join>\nor available locally via: info '(coreutils) join invocation'\n",
    expand: "Usage: expand [OPTION]... [FILE]...\nConvert tabs in each FILE to spaces, writing to standard output.\n\nWith no FILE, or when FILE is -, read standard input.\n\nMandatory arguments to long options are mandatory for short options too.\n  -i, --initial    do not convert tabs after non blanks\n  -t, --tabs=N     have tabs N characters apart, not 8\n  -t, --tabs=LIST  use comma separated list of tab positions.\n                     The last specified position can be prefixed with '/'\n                     to specify a tab size to use after the last\n                     explicitly specified tab stop.  Also a prefix of '+'\n                     can be used to align remaining tab stops relative to\n                     the last specified tab stop instead of the first column\n      --help        display this help and exit\n      --version     output version information and exit\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/expand>\nor available locally via: info '(coreutils) expand invocation'\n",
    unexpand: "Usage: unexpand [OPTION]... [FILE]...\nConvert blanks in each FILE to tabs, writing to standard output.\n\nWith no FILE, or when FILE is -, read standard input.\n\nMandatory arguments to long options are mandatory for short options too.\n  -a, --all        convert all blanks, instead of just initial blanks\n      --first-only  convert only leading sequences of blanks (overrides -a)\n  -t, --tabs=N     have tabs N characters apart instead of 8 (enables -a)\n  -t, --tabs=LIST  use comma separated list of tab positions.\n                     The last specified position can be prefixed with '/'\n                     to specify a tab size to use after the last\n                     explicitly specified tab stop.  Also a prefix of '+'\n                     can be used to align remaining tab stops relative to\n                     the last specified tab stop instead of the first column\n      --help        display this help and exit\n      --version     output version information and exit\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/unexpand>\nor available locally via: info '(coreutils) unexpand invocation'\n",
    factor: "Usage: factor [OPTION] [NUMBER]...\nPrint the prime factors of each specified integer NUMBER.  If none\nare specified on the command line, read them from standard input.\n\n  -h, --exponents   print repeated factors in form p^e unless e is 1\n      --help        display this help and exit\n      --version     output version information and exit\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/factor>\nor available locally via: info '(coreutils) factor invocation'\n",
    shuf: "Usage: shuf [OPTION]... [FILE]\n  or:  shuf -e [OPTION]... [ARG]...\n  or:  shuf -i LO-HI [OPTION]...\nWrite a random permutation of the input lines to standard output.\n\nWith no FILE, or when FILE is -, read standard input.\n\nMandatory arguments to long options are mandatory for short options too.\n  -e, --echo                treat each ARG as an input line\n  -i, --input-range=LO-HI   treat each number LO through HI as an input line\n  -n, --head-count=COUNT    output at most COUNT lines\n  -o, --output=FILE         write result to FILE instead of standard output\n      --random-source=FILE  get random bytes from FILE\n  -r, --repeat              output lines can be repeated\n  -z, --zero-terminated     line delimiter is NUL, not newline\n      --help        display this help and exit\n      --version     output version information and exit\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/shuf>\nor available locally via: info '(coreutils) shuf invocation'\n",
    sum: "Usage: sum [OPTION]... [FILE]...\nPrint or check BSD (16-bit) checksums.\n\nWith no FILE, or when FILE is -, read standard input.\n\n  -r              use BSD sum algorithm (the default), use 1K blocks\n  -s, --sysv      use System V sum algorithm, use 512 bytes blocks\n      --help        display this help and exit\n      --version     output version information and exit\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/sum>\nor available locally via: info '(coreutils) sum invocation'\n",
    od: "Usage: od [OPTION]... [FILE]...\n  or:  od [-abcdfilosx]... [FILE] [[+]OFFSET[.][b]]\n  or:  od --traditional [OPTION]... [FILE] [[+]OFFSET[.][b] [+][LABEL][.][b]]\n\nWrite an unambiguous representation, octal bytes by default,\nof FILE to standard output.  With more than one FILE argument,\nconcatenate them in the listed order to form the input.\n\nWith no FILE, or when FILE is -, read standard input.\n\nIf first and second call formats both apply, the second format is assumed\nif the last operand begins with + or (if there are 2 operands) a digit.\nAn OFFSET operand means -j OFFSET.  LABEL is the pseudo-address\nat first byte printed, incremented when dump is progressing.\nFor OFFSET and LABEL, a 0x or 0X prefix indicates hexadecimal;\nsuffixes may be . for octal and b for multiply by 512.\n\nMandatory arguments to long options are mandatory for short options too.\n  -A, --address-radix=RADIX   output format for file offsets; RADIX is one\n                                of [doxn], for Decimal, Octal, Hex or None\n      --endian={big|little}   swap input bytes according the specified order\n  -j, --skip-bytes=BYTES      skip BYTES input bytes first\n  -N, --read-bytes=BYTES      limit dump to BYTES input bytes\n  -S BYTES, --strings[=BYTES]  show only NUL terminated strings\n                                of at least BYTES (3) printable characters\n  -t, --format=TYPE           select output format or formats\n  -v, --output-duplicates     do not use * to mark line suppression\n  -w[BYTES], --width[=BYTES]  output BYTES bytes per output line;\n                                32 is implied when BYTES is not specified\n      --traditional           accept arguments in third form above\n      --help        display this help and exit\n      --version     output version information and exit\n\n\nTraditional format specifications may be intermixed; they accumulate:\n  -a   same as -t a,  select named characters, ignoring high-order bit\n  -b   same as -t o1, select octal bytes\n  -c   same as -t c,  select printable characters or backslash escapes\n  -d   same as -t u2, select unsigned decimal 2-byte units\n  -f   same as -t fF, select floats\n  -i   same as -t dI, select decimal ints\n  -l   same as -t dL, select decimal longs\n  -o   same as -t o2, select octal 2-byte units\n  -s   same as -t d2, select decimal 2-byte units\n  -x   same as -t x2, select hexadecimal 2-byte units\n\n\nTYPE is made up of one or more of these specifications:\n  a          named character, ignoring high-order bit\n  c          printable character or backslash escape\n  d[SIZE]    signed decimal, SIZE bytes per integer\n  f[SIZE]    floating point, SIZE bytes per float\n  o[SIZE]    octal, SIZE bytes per integer\n  u[SIZE]    unsigned decimal, SIZE bytes per integer\n  x[SIZE]    hexadecimal, SIZE bytes per integer\n\nSIZE is a number.  For TYPE in [doux], SIZE may also be C for\nsizeof(char), S for sizeof(short), I for sizeof(int) or L for\nsizeof(long).  If TYPE is f, SIZE may also be F for sizeof(float), D\nfor sizeof(double) or L for sizeof(long double).\n\nAdding a z suffix to any type displays printable characters at the end of\neach output line.\n\n\nBYTES is hex with 0x or 0X prefix, and may have a multiplier suffix:\n  b    512\n  KB   1000\n  K    1024\n  MB   1000*1000\n  M    1024*1024\nand so on for G, T, P, E, Z, Y, R, Q.\nBinary prefixes can be used, too: KiB=K, MiB=M, and so on.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/od>\nor available locally via: info '(coreutils) od invocation'\n",
  };
  const VERSION = {
    fold: "fold (GNU coreutils) 9.4\nCopyright (C) 2023 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by David MacKenzie.\n",
    fmt: "fmt (GNU coreutils) 9.4\nCopyright (C) 2023 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by Ross Paterson.\n",
    join: "join (GNU coreutils) 9.4\nCopyright (C) 2023 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by Mike Haertel.\n",
    expand: "expand (GNU coreutils) 9.4\nCopyright (C) 2023 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by David MacKenzie.\n",
    unexpand: "unexpand (GNU coreutils) 9.4\nCopyright (C) 2023 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by David MacKenzie.\n",
    factor: "factor (GNU coreutils) 9.4\nCopyright (C) 2023 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by Paul Rubin, Torbj\u00f6rn Granlund, and Niels M\u00f6ller.\n",
    shuf: "shuf (GNU coreutils) 9.4\nCopyright (C) 2023 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by Paul Eggert.\n",
    sum: "sum (GNU coreutils) 9.4\nCopyright (C) 2023 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by Kayvan Aghaiepour and David MacKenzie.\n",
    od: "od (GNU coreutils) 9.4\nCopyright (C) 2023 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by Jim Meyering.\n",
  };

  /* ------------------------------------------------------------ helpers */
  const isC = (env) => { const l = env.LC_ALL || env.LC_CTYPE || env.LANG || 'C'; return l === 'C' || l === 'POSIX'; };
  /** GNU error-message quoting: ‘x’ in UTF-8 locales, 'x' in C. */
  const quote = (ctx, s) => (isC(ctx.env) ? "'" + s + "'" : '‘' + s + '’');
  const bytesOf = (s) => U.toBytes(s);

  async function stdinText(ctx) {
    if (ctx._stdinDone) return '';
    ctx._stdinDone = true;
    if (ctx.stdin != null) return ctx.stdin;
    let s = '';
    for (;;) { const l = await ctx.readLine(''); if (l == null) return s; s += l + '\n'; }
  }
  /** Read the operands ("-" is stdin; none means stdin). Reports failures as "name: file: reason". */
  async function readFiles(ctx, files) {
    const inputs = []; let failed = false;
    for (const f of files.length ? files : ['-']) {
      try { inputs.push({ name: f, text: f === '-' ? await stdinText(ctx) : ctx.fs.read(f) }); } catch (e) {
        if (!(e instanceof K.FsError)) throw e;
        failed = true; ctx.err(ctx.name + ': ' + f + ': ' + e.message + '\n');
      }
    }
    return { inputs, failed };
  }
  const breathe = (ctx) => new Promise((resolve, reject) => setTimeout(() => (ctx.aborted() ? reject(new K.Interrupt()) : resolve()), 0));

  /** Register a GNU-style command; `spec` is the getopt spec, run(ctx, g) gets the parsed options. */
  function gnu(def) {
    const helpText = HELP[def.name];
    K.cmd.register({
      name: def.name,
      pkg: def.pkg || 'coreutils',
      summary: def.summary,
      synopsis: def.synopsis,
      man: def.man,
      async run(ctx) {
        if (ctx.args.length === 1 && ctx.args[0] === '--help' && helpText) { ctx.out(helpText); return 0; }
        if (ctx.args.length === 1 && ctx.args[0] === '--version' && VERSION[def.name]) { ctx.out(VERSION[def.name]); return 0; }
        const g = K.getopt(ctx.args, def.spec);
        if (g.err) { ctx.err(def.name + ': ' + g.err + "\nTry '" + def.name + " --help' for more information.\n"); return 1; }
        if (g.opts.help && helpText) { ctx.out(helpText); return 0; }
        if (g.opts.version && VERSION[def.name]) { ctx.out(VERSION[def.name]); return 0; }
        return def.run(ctx, g);
      },
      complete: def.complete,
    });
  }
  const usageTry = (ctx) => { ctx.err("Try '" + ctx.name + " --help' for more information.\n"); return 1; };

  /* --------------------------------------------------------------- sum */
  gnu({
    name: 'sum',
    summary: 'checksum and count the blocks in a file',
    synopsis: 'sum [OPTION]... [FILE]...',
    man: `DESCRIPTION
       Print a checksum and block count for each FILE. The default is the
       BSD 16-bit checksum with 1024-byte blocks.

OPTIONS
       -r              use the BSD algorithm and 1K blocks (the default)
       -s, --sysv      use the System V algorithm and 512-byte blocks

EXAMPLES
       sum /etc/hostname
       sum -s /etc/hostname`,
    spec: { short: 'rs', long: ['sysv', 'help', 'version'], alias: { sysv: 's' } },
    async run(ctx, g) {
      const sysv = !!g.opts.s;
      const { inputs, failed } = await readFiles(ctx, g.rest);
      for (const { name, text } of inputs) {
        const bytes = bytesOf(text);
        let line;
        if (sysv) {
          let s = 0; for (const b of bytes) s += b;
          s = (s & 0xffff) + (s >>> 16); s = (s & 0xffff) + (s >>> 16);
          line = s + ' ' + Math.ceil(bytes.length / 512);
        } else {
          let c = 0; for (const b of bytes) { c = ((c >> 1) | ((c & 1) << 15)) & 0xffff; c = (c + b) & 0xffff; }
          line = String(c).padStart(5, '0') + ' ' + String(Math.ceil(bytes.length / 1024)).padStart(5);
        }
        ctx.println(line + (g.rest.length ? ' ' + name : ''));
      }
      return failed ? 1 : 0;
    },
  });

  /* ------------------------------------------------------------ factor */
  const SMALL_PRIMES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];
  const modPow = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; };
  function isPrime(n) {
    if (n < 2n) return false;
    for (const p of SMALL_PRIMES) { if (n === p) return true; if (n % p === 0n) return false; }
    let d = n - 1n; let s = 0; while ((d & 1n) === 0n) { d >>= 1n; s++; }
    for (const a of SMALL_PRIMES) {
      let x = modPow(a, d, n);
      if (x === 1n || x === n - 1n) continue;
      let comp = true;
      for (let i = 1; i < s && comp; i++) { x = (x * x) % n; if (x === n - 1n) comp = false; }
      if (comp) return false;
    }
    return true;
  }
  const gcd = (a, b) => { while (b) { [a, b] = [b, a % b]; } return a; };
  function rho(n) {
    for (let c = 1n; ; c++) {
      let x = 2n; let y = 2n; let d = 1n;
      while (d === 1n) { x = (x * x + c) % n; y = (y * y + c) % n; y = (y * y + c) % n; d = gcd(x > y ? x - y : y - x, n); }
      if (d !== n) return d;
    }
  }
  async function factorize(ctx, n) {
    const out = [];
    for (let p = 2n; p < 1000n && p * p <= n; p += p === 2n ? 1n : 2n) while (n % p === 0n) { out.push(p); n /= p; }
    const stack = n > 1n ? [n] : [];
    let steps = 0;
    while (stack.length) {
      const m = stack.pop();
      if (m < 1000000n * 1000000n ? m > 1n && isPrimeSmall(m) : isPrime(m)) { out.push(m); continue; }
      if (++steps % 4 === 0) await breathe(ctx);
      const d = rho(m); stack.push(d, m / d);
    }
    return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  const isPrimeSmall = isPrime;

  gnu({
    name: 'factor',
    summary: 'factor numbers',
    synopsis: 'factor [OPTION] [NUMBER]...',
    man: `DESCRIPTION
       Print the prime factors of each specified integer NUMBER. If none are
       specified on the command line, read them from standard input.

OPTIONS
       -h, --exponents   print repeated factors in form p^e unless e is 1

EXAMPLES
       factor 360
       echo 1000000007 | factor`,
    spec: { short: 'h', long: ['exponents', 'help', 'version'], alias: { exponents: 'h' } },
    async run(ctx, g) {
      const tokens = g.rest.length ? g.rest : (await stdinText(ctx)).split(/\s+/).filter(Boolean);
      let status = 0;
      for (const t of tokens) {
        if (!/^\+?\d+$/.test(t)) { ctx.err('factor: ' + quote(ctx, t) + ' is not a valid positive integer\n'); status = 1; continue; }
        const fs = await factorize(ctx, BigInt(t));
        let text;
        if (g.opts.h) {
          const groups = []; for (const f of fs) { const last = groups[groups.length - 1]; if (last && last[0] === f) last[1]++; else groups.push([f, 1]); }
          text = groups.map(([p, e]) => (e > 1 ? p + '^' + e : String(p))).join(' ');
        } else text = fs.join(' ');
        ctx.println(BigInt(t) + ':' + (text ? ' ' + text : ''));
      }
      return status;
    },
  });

  /* ------------------------------------------------- expand / unexpand */
  /** Parse a -t argument into { stops, step } ; step > 0 repeats every `step` columns after the last stop. */
  function parseTabs(ctx, name, spec) {
    const stops = []; let step = 0; let plus = 0;
    for (const item of spec.split(/[,\s]+/).filter(Boolean)) {
      let s = item; let kind = '';
      if (s[0] === '/' || s[0] === '+') { kind = s[0]; s = s.slice(1); }
      if (!/^\d+$/.test(s)) { ctx.err(name + ': tab size contains invalid character(s): ' + quote(ctx, s) + '\n'); return null; }
      const n = Number(s);
      if (kind === '/') step = n; else if (kind === '+') plus = n;
      else if (!kind && n === 0) { ctx.err(name + ': tab size cannot be 0\n'); return null; }
      if (kind === '/' || kind === '+') { if (n === 0) { ctx.err(name + ': tab size cannot be 0\n'); return null; } if (kind === '+') stops.push((stops.length ? stops[stops.length - 1] : 0) + n); continue; }
      if (stops.length && n <= stops[stops.length - 1]) { ctx.err(name + ': tab sizes must be ascending\n'); return null; }
      stops.push(n);
    }
    void plus;
    if (stops.length === 1 && !step) return { stops: [], step: stops[0] };
    return { stops, step };
  }
  /** Next tab stop after column `col`, or null when there is none (unexpand) */
  function nextStop(tabs, col) {
    for (const s of tabs.stops) if (s > col) return s;
    if (tabs.step) {
      const base = tabs.stops.length ? tabs.stops[tabs.stops.length - 1] : 0;
      return base + (Math.floor((col - base) / tabs.step) + 1) * tabs.step;
    }
    return null;
  }

  async function tabsCommand(ctx, g, kind) {
    let spec = g.opts.t;
    for (const a of ctx.args) if (/^-\d+$/.test(a) && spec === undefined) spec = a.slice(1);
    const tabs = spec === undefined ? { stops: [], step: 8 } : parseTabs(ctx, ctx.name, String(spec));
    if (!tabs) return 1;
    const files = g.rest.filter((f) => !/^-\d+$/.test(f));
    const { inputs, failed } = await readFiles(ctx, files);
    const all = kind === 'unexpand' && (!!g.opts.a || spec !== undefined) && !g.opts['first-only'];
    for (const { text } of inputs) ctx.out(kind === 'expand' ? expandText(text, tabs, !!g.opts.i) : unexpandText(text, tabs, all));
    return failed ? 1 : 0;
  }
  function expandText(text, tabs, initialOnly) {
    let out = ''; let col = 0; let initial = true;
    for (const c of text) {
      if (c === '\n') { out += c; col = 0; initial = true; continue; }
      if (c === '\t' && (!initialOnly || initial)) {
        const n = nextStop(tabs, col);
        const to = n === null ? col + 1 : n;
        out += ' '.repeat(to - col); col = to; continue;
      }
      if (c === '\b') { out += c; col = Math.max(0, col - 1); initial = false; continue; }
      if (c !== ' ') initial = false;
      out += c; col++;
    }
    return out;
  }
  function unexpandText(text, tabs, all) {
    let out = ''; let col = 0; let run = null; let leading = true;
    const flush = () => { if (run) { out += run.text; run = null; } };
    for (const c of text) {
      if ((c === ' ' || c === '\t') && (all || leading)) {
        if (!run) run = { text: '', blanks: 0, tab: false };
        let to;
        if (c === '\t') { const n = nextStop(tabs, col); to = n === null ? col + 1 : n; run.tab = true; } else to = col + 1;
        run.blanks += to - col;
        run.text += c === '\t' ? '\t' : ' ';
        col = to;
        const stop = nextStop(tabs, col - 1);
        if (stop === col && (run.tab || run.blanks > 1)) { out += '\t'; run = { text: '', blanks: 0, tab: false }; }
        else if (stop === col) { out += run.text; run = null; }
        continue;
      }
      flush();
      if (c === '\n') { out += c; col = 0; leading = true; continue; }
      if (c === '\b') col = Math.max(0, col - 1); else col++;
      if (c !== ' ' && c !== '\t') leading = false;
      out += c;
    }
    flush();
    return out;
  }
  gnu({
    name: 'expand',
    summary: 'convert tabs to spaces',
    synopsis: 'expand [OPTION]... [FILE]...',
    man: `DESCRIPTION
       Convert tabs in each FILE to spaces, writing to standard output.

OPTIONS
       -i, --initial     do not convert tabs after non blanks
       -t, --tabs=N      have tabs N characters apart, not 8
       -t, --tabs=LIST   use comma separated list of tab positions

EXAMPLES
       expand -t 4 Makefile
       printf 'a\\tb\\n' | expand`,
    spec: { short: 'it:0123456789', long: ['initial', 'tabs=', 'help', 'version'], alias: { initial: 'i', tabs: 't' } },
    run: (ctx, g) => tabsCommand(ctx, g, 'expand'),
  });
  gnu({
    name: 'unexpand',
    summary: 'convert spaces to tabs',
    synopsis: 'unexpand [OPTION]... [FILE]...',
    man: `DESCRIPTION
       Convert blanks in each FILE to tabs, writing to standard output.

OPTIONS
       -a, --all         convert all blanks, instead of just initial blanks
       --first-only      convert only leading sequences of blanks (overrides -a)
       -t, --tabs=N      have tabs N characters apart instead of 8 (enables -a)

EXAMPLES
       unexpand -a -t 4 script.py`,
    spec: { short: 'at:0123456789', long: ['all', 'first-only', 'tabs=', 'help', 'version'], alias: { all: 'a', tabs: 't' } },
    run: (ctx, g) => tabsCommand(ctx, g, 'unexpand'),
  });

  /* -------------------------------------------------------------- fold */
  function foldText(text, width, countBytes, atSpaces) {
    let out = ''; let line = []; let col = 0;
    const adjust = (c0, ch) => {
      if (countBytes) return c0 + bytesOf(ch).length;
      if (ch === '\b') return Math.max(0, c0 - 1);
      if (ch === '\r') return 0;
      if (ch === '\t') return c0 + 8 - (c0 % 8);
      return c0 + 1;
    };
    const widthOf = (chars) => chars.reduce((c, ch) => adjust(c, ch), 0);
    for (const ch of text) {
      if (ch === '\n') { out += line.join('') + '\n'; line = []; col = 0; continue; }
      for (;;) {
        const next = adjust(col, ch);
        if (next <= width || !line.length) { line.push(ch); col = next; break; }
        let cut = line.length;
        if (atSpaces) {
          let i = line.length;
          while (i > 0) { i--; if (line[i] === ' ' || line[i] === '\t') { cut = i + 1; break; } if (i === 0) cut = line.length; }
        }
        out += line.slice(0, cut).join('') + '\n';
        line = line.slice(cut); col = widthOf(line);
      }
    }
    return out + line.join('');
  }
  gnu({
    name: 'fold',
    summary: 'wrap each input line to fit in specified width',
    synopsis: 'fold [OPTION]... [FILE]...',
    man: `DESCRIPTION
       Wrap input lines in each FILE, writing to standard output.

OPTIONS
       -b, --bytes         count bytes rather than columns
       -s, --spaces        break at spaces
       -w, --width=WIDTH   use WIDTH columns instead of 80

EXAMPLES
       fold -w 40 -s README
       echo 'a long line' | fold -w 5`,
    spec: { short: 'bsw:0123456789', long: ['bytes', 'spaces', 'width=', 'help', 'version'], alias: { bytes: 'b', spaces: 's', width: 'w' } },
    async run(ctx, g) {
      let w = g.opts.w;
      if (w === undefined) { const num = ctx.args.find((a) => /^-\d+$/.test(a)); if (num) w = num.slice(1); }
      let width = 80;
      if (w !== undefined) {
        if (!/^\d+$/.test(String(w)) || Number(w) === 0) { ctx.err('fold: invalid number of columns: ' + quote(ctx, String(w)) + '\n'); return 1; }
        width = Number(w);
      }
      const { inputs, failed } = await readFiles(ctx, g.rest.filter((f) => !/^-\d+$/.test(f)));
      for (const { text } of inputs) ctx.out(foldText(text, width, !!g.opts.b, !!g.opts.s));
      return failed ? 1 : 0;
    },
  });

  /* -------------------------------------------------------------- shuf */
  gnu({
    name: 'shuf',
    summary: 'generate random permutations',
    synopsis: 'shuf [OPTION]... [FILE]',
    man: `DESCRIPTION
       Write a random permutation of the input lines to standard output.

OPTIONS
       -e, --echo              treat each ARG as an input line
       -i, --input-range=LO-HI treat each number LO through HI as an input line
       -n, --head-count=COUNT  output at most COUNT lines
       -o, --output=FILE       write result to FILE instead of standard output
       -r, --repeat            output lines can be repeated
       -z, --zero-terminated   line delimiter is NUL, not newline

EXAMPLES
       shuf -n 3 /usr/share/wordlists/rockyou.txt
       shuf -i 1-10 -n 3
       shuf -e red green blue`,
    spec: { short: 'ei:n:o:rz', long: ['echo', 'input-range=', 'head-count=', 'output=', 'random-source=', 'repeat', 'zero-terminated', 'help', 'version'], alias: { echo: 'e', 'input-range': 'i', 'head-count': 'n', output: 'o', repeat: 'r', 'zero-terminated': 'z' } },
    async run(ctx, g) {
      const o = g.opts;
      if (g.all.i && g.all.i.length > 1) { ctx.err('shuf: multiple -i options specified\n'); return 1; }
      if (g.all.o && g.all.o.length > 1) { ctx.err('shuf: multiple -o options specified\n'); return 1; }
      if (o.e && o.i !== undefined) { ctx.err('shuf: cannot combine -e and -i options\n'); return 1; }
      let lines; const sep = o.z ? '\0' : '\n';
      if (o.i !== undefined) {
        const m = /^(\d+)-(\d+)$/.exec(String(o.i));
        if (!m || Number(m[1]) > Number(m[2]) + 1) { ctx.err('shuf: invalid input range: ' + quote(ctx, String(o.i)) + '\n'); return 1; }
        if (g.rest.length) { ctx.err('shuf: extra operand ' + quote(ctx, g.rest[0]) + '\n'); return usageTry(ctx); }
        lines = []; for (let i = Number(m[1]); i <= Number(m[2]); i++) lines.push(String(i));
      } else if (o.e) lines = g.rest;
      else {
        if (g.rest.length > 1) { ctx.err('shuf: extra operand ' + quote(ctx, g.rest[1]) + '\n'); return usageTry(ctx); }
        const { inputs, failed } = await readFiles(ctx, g.rest);
        if (failed) return 1;
        lines = inputs[0].text.split(sep); if (lines[lines.length - 1] === '') lines.pop();
      }
      let count = Infinity;
      if (o.n !== undefined) {
        if (!/^\d+$/.test(String(o.n))) { ctx.err('shuf: invalid line count: ' + quote(ctx, String(o.n)) + '\n'); return 1; }
        count = Number(o.n);
      }
      const rnd = (n) => Math.floor(K.net.rand() * n);
      let result = '';
      if (o.r) {
        if (!lines.length && count !== 0) { ctx.err('shuf: no lines to repeat\n'); return 1; }
        for (let i = 0; i < count; i++) { result += lines[rnd(lines.length)] + sep; if (i % 1000 === 999) { await breathe(ctx); if (o.o === undefined) { ctx.out(result); result = ''; } } }
      } else {
        for (let i = lines.length - 1; i > 0; i--) { const j = rnd(i + 1); [lines[i], lines[j]] = [lines[j], lines[i]]; }
        result = lines.slice(0, count).map((l) => l + sep).join('');
      }
      if (o.o !== undefined) {
        try { ctx.fs.write(o.o, result); } catch (e) { if (!(e instanceof K.FsError)) throw e; ctx.err('shuf: ' + o.o + ': ' + e.message + '\n'); return 1; }
      } else ctx.out(result);
      return 0;
    },
  });

  /* ---------------------------------------------------------------- od */
  const BYTE_MULT = { b: 512, KB: 1e3, K: 1024, KiB: 1024, MB: 1e6, M: 1048576, MiB: 1048576, GB: 1e9, G: 2 ** 30, GiB: 2 ** 30, TB: 1e12, T: 2 ** 40, TiB: 2 ** 40, PB: 1e15, P: 2 ** 50, PiB: 2 ** 50 };
  /** Parse a BYTES argument (decimal or 0x hex, optional multiplier suffix); null when invalid. */
  function parseBytes(s) {
    const m = /^(0[xX][0-9a-fA-F]+|\d+)([A-Za-z]*)$/.exec(s);
    if (!m || (m[2] && !(m[2] in BYTE_MULT))) return null;
    return Number(m[1]) * (m[2] ? BYTE_MULT[m[2]] : 1);
  }
  const ASCII_NAMES = ['nul', 'soh', 'stx', 'etx', 'eot', 'enq', 'ack', 'bel', 'bs', 'ht', 'nl', 'vt', 'ff', 'cr', 'so', 'si', 'dle', 'dc1', 'dc2', 'dc3', 'dc4', 'nak', 'syn', 'etb', 'can', 'em', 'sub', 'esc', 'fs', 'gs', 'rs', 'us', 'sp'];
  const C_ESCAPES = { 0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };
  /** printf "%g" of the shortest round-trip digits, switching to exponent form at `prec` digits. */
  function fmtShortG(x, prec, single) {
    if (Number.isNaN(x)) return 'nan';
    if (!Number.isFinite(x)) return x < 0 ? '-inf' : 'inf';
    if (x === 0) return Object.is(x, -0) ? '-0' : '0';
    let digits;
    if (single) for (digits = 0; digits < 8 && Math.fround(Number(x.toExponential(digits))) !== x; digits++);
    const [mant, ex] = (single ? x.toExponential(digits) : x.toExponential()).split('e');
    const e = Number(ex);
    if (e < -4 || e >= prec) return mant + 'e' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(2, '0');
    return String(Number(x.toFixed(Math.max(0, Math.min(100, mant.replace(/[-.]/g, '').length - 1 - e)))));
  }
  const INT_SIZES = { C: 1, S: 2, I: 4, L: 8 };
  const FLOAT_SIZES = { F: 4, D: 8, L: 8 };
  /** Parse one -t TYPE string into [{kind, size, z}] or an error message. */
  function parseOdTypes(str, q) {
    const specs = []; let i = 0;
    while (i < str.length) {
      const kind = str[i++];
      if (!'acdfoux'.includes(kind)) return { err: "invalid character '" + kind + "' in type string " + q(str) };
      let size = kind === 'f' ? 8 : 4;
      if (kind === 'a' || kind === 'c') size = 1;
      else {
        const m = /^(\d+|[A-Z])/.exec(str.slice(i));
        if (m) {
          i += m[1].length;
          size = /\d/.test(m[1]) ? Number(m[1]) : (kind === 'f' ? FLOAT_SIZES : INT_SIZES)[m[1]];
          const ok = kind === 'f' ? [4, 8] : [1, 2, 4, 8];
          if (!ok.includes(size)) {
            return { err: 'invalid type string ' + q(str) + ";\nthis system doesn't provide a " + m[1] + '-byte ' + (kind === 'f' ? 'floating point' : 'integral') + ' type' };
          }
        }
      }
      const z = str[i] === 'z'; if (z) i++;
      specs.push({ kind, size, z });
    }
    return { specs };
  }
  const odFieldWidth = ({ kind, size }) => {
    if (kind === 'a' || kind === 'c') return 3;
    if (kind === 'f') return size === 4 ? 15 : 24;
    const bits = 8 * size;
    if (kind === 'x') return 2 * size;
    if (kind === 'o') return Math.ceil(bits / 3);
    return (kind === 'd' ? 1 : 0) + String(2n ** BigInt(kind === 'd' ? bits - 1 : bits)).length;
  };
  function odItem(spec, bytes, pos, size, big) {
    const raw = new Uint8Array(size);
    for (let k = 0; k < size; k++) raw[k] = pos + k < bytes.length ? bytes[pos + k] : 0;
    if (!big) raw.reverse(); // raw is now in big-endian order
    const view = new DataView(raw.buffer);
    const asBig = () => { let v = 0n; for (const x of raw) v = (v << 8n) | BigInt(x); return v; };
    const { kind } = spec;
    if (kind === 'a') { const b = bytes[pos] & 0x7f; return b <= 32 ? ASCII_NAMES[b] : b === 127 ? 'del' : String.fromCharCode(b); }
    if (kind === 'c') { const b = bytes[pos]; return b in C_ESCAPES ? C_ESCAPES[b] : b >= 32 && b < 127 ? String.fromCharCode(b) : b.toString(8).padStart(3, '0'); }
    if (kind === 'f') return fmtShortG(size === 4 ? view.getFloat32(0) : view.getFloat64(0), size === 4 ? 9 : 17, size === 4);
    const v = asBig();
    if (kind === 'x') return v.toString(16).padStart(2 * size, '0');
    if (kind === 'o') return v.toString(8).padStart(Math.ceil(8 * size / 3), '0');
    if (kind === 'u') return v.toString();
    return BigInt.asIntN(8 * size, v).toString();
  }
  const lcm = (a, b) => { let x = a; let y = b; while (y) [x, y] = [y, x % y]; return (a / x) * b; };

  function odDump(ctx, bytes, o) {
    const { specs, radix, width, verbose } = o;
    const addrWidth = radix === 'x' ? 6 : 7;
    const base = { o: 8, d: 10, x: 16 }[radix];
    const addr = (n) => (radix === 'n' ? '' : n.toString(base).padStart(addrWidth, '0'));
    const lines = [];
    // With several formats every column grid is stretched to the widest line so items line up.
    const total = Math.max(...specs.map((s) => (width / s.size) * (odFieldWidth(s) + 1)));
    const rowFor = (spec, chunk) => {
      const w = Math.floor(total / (width / spec.size)) - 1;
      let row = '';
      for (let p = 0; p < chunk.length; p += spec.size) row += ' ' + odItem(spec, chunk, p, spec.size, o.big).padStart(w);
      if (spec.z) {
        row = row.padEnd(total);
        row += '  >' + Array.from(chunk, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('') + '<';
      }
      return row;
    };
    let prev = null; let squeezing = false;
    for (let pos = 0; pos < bytes.length; pos += width) {
      const chunk = bytes.subarray(pos, pos + width);
      const full = chunk.length === width;
      if (!verbose && full && prev && prev.length === width && chunk.every((b, i) => b === prev[i])) {
        if (!squeezing) lines.push('*');
        squeezing = true; prev = chunk; continue;
      }
      squeezing = false; prev = chunk;
      specs.forEach((spec, i) => lines.push((i === 0 ? addr(pos + o.skipped) : ' '.repeat(radix === 'n' ? 0 : addrWidth)) + rowFor(spec, chunk)));
    }
    if (radix !== 'n') lines.push(addr(bytes.length + o.skipped));
    ctx.out(lines.map((l) => l + '\n').join(''));
  }

  gnu({
    name: 'od',
    summary: 'dump files in octal and other formats',
    synopsis: 'od [OPTION]... [FILE]...',
    man: `DESCRIPTION
       Write an unambiguous representation, octal bytes by default, of FILE to
       standard output. With no FILE, or when FILE is -, read standard input.

OPTIONS
       -A, --address-radix=RADIX   file offsets in [d]ecimal, [o]ctal, he[x] or [n]one
       -j, --skip-bytes=BYTES      skip BYTES input bytes first
       -N, --read-bytes=BYTES      limit dump to BYTES input bytes
       -t, --format=TYPE           output format: a, c, d, f, o, u or x, with optional size
       -v, --output-duplicates     do not use * to mark line suppression
       -w[BYTES], --width[=BYTES]  output BYTES bytes per output line
       -a -b -c -d -f -i -l -o -s -x   traditional format shortcuts

EXAMPLES
       od -c /etc/hostname
       echo -n hello | od -An -tx1`,
    spec: { short: 'A:j:N:t:vw::abcdfilosx', long: ['address-radix=', 'skip-bytes=', 'read-bytes=', 'format=', 'output-duplicates', 'width=?', 'endian=', 'help', 'version'], alias: { 'address-radix': 'A', 'skip-bytes': 'j', 'read-bytes': 'N', format: 't', 'output-duplicates': 'v', width: 'w' } },
    async run(ctx, g) {
      const bad = (m) => { ctx.err('od: ' + m + '\n'); return 1; };
      let radix = 'o';
      if (g.opts.A !== undefined) {
        const a = String(g.opts.A);
        if (a.length !== 1 || !'doxn'.includes(a)) return bad("invalid output address radix '" + a + "'; it must be one character from [doxn]");
        radix = a;
      }
      const num = (key, flag) => {
        if (g.opts[key] === undefined) return { v: undefined };
        const v = parseBytes(String(g.opts[key]));
        return v === null ? { err: 'invalid -' + flag + " argument '" + g.opts[key] + "'" } : { v };
      };
      const skip = num('j', 'j'); if (skip.err) return bad(skip.err);
      const limit = num('N', 'N'); if (limit.err) return bad(limit.err);
      let big = false;
      if (g.opts.endian !== undefined) {
        if (!['big', 'little'].includes(g.opts.endian)) return bad('invalid argument ' + quote(ctx, String(g.opts.endian)) + " for '--endian'\nValid arguments are:\n  - 'little'\n  - 'big'\nTry 'od --help' for more information.");
        big = g.opts.endian === 'big';
      }
      const specs = [];
      const shortcuts = { a: 'a', b: 'o1', c: 'c', d: 'u2', f: 'fF', i: 'dI', l: 'dL', o: 'o2', s: 'd2', x: 'x2' };
      for (const [k, v] of g.seq) {
        if (k !== 't' && !(k in shortcuts)) continue;
        const t = parseOdTypes(k === 't' ? String(v) : shortcuts[k], (x) => quote(ctx, x));
        if (t.err) return bad(t.err);
        specs.push(...t.specs);
      }
      if (!specs.length) specs.push(...parseOdTypes('o2').specs);
      const unit = specs.reduce((a, s) => lcm(a, s.size), 1);
      let width = 16;
      if (g.opts.w !== undefined) {
        const w = g.opts.w === true || g.opts.w === '' ? 32 : parseBytes(String(g.opts.w));
        if (w === null || w === 0) return bad("invalid -w argument '" + g.opts.w + "'");
        width = w;
      }
      if (width % unit) { ctx.err('od: warning: invalid width ' + width + '; using ' + unit + ' instead\n'); width = unit; }
      else if (width < unit) width = unit;
      const { inputs, failed } = await readFiles(ctx, g.rest);
      const parts = inputs.map((i) => bytesOf(i.text));
      let bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0; for (const p of parts) { bytes.set(p, at); at += p.length; }
      const skipped = skip.v || 0;
      if (skipped > bytes.length) { if (!failed) ctx.err('od: cannot skip past end of combined input\n'); return 1; }
      bytes = bytes.subarray(skipped, limit.v === undefined ? undefined : skipped + limit.v);
      if (failed && !inputs.length) return 1;
      odDump(ctx, bytes, { specs, radix, width, verbose: !!g.opts.v, big, skipped });
      return failed ? 1 : 0;
    },
  });

  /* ----------------------------------------------------------- hexdump */
  const hexByteChar = (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.');
  /** Row builders for the fixed display formats; each returns the text after the offset. */
  const HEXDUMP_FORMATS = {
    b: { unit: 1, per: 16, item: (v) => ' ' + v.toString(8).padStart(3, '0') },
    c: { unit: 1, per: 16, item: (v) => ' ' + (v in C_ESCAPES ? C_ESCAPES[v] : v >= 32 && v < 127 ? String.fromCharCode(v) : v.toString(8).padStart(3, '0')).padStart(3) },
    d: { unit: 2, per: 8, item: (v) => ' ' + String(v).padStart(5, '0') },
    o: { unit: 2, per: 8, item: (v) => ' ' + v.toString(8).padStart(6, '0') },
    x: { unit: 2, per: 8, item: (v) => ' ' + v.toString(16).padStart(4, '0') },
  };
  function hexdumpCanonical(chunk, pos) {
    let hex = '';
    for (let i = 0; i < 16; i++) hex += (i === 8 ? ' ' : '') + (i < chunk.length ? chunk[i].toString(16).padStart(2, '0') + ' ' : '   ');
    return pos.toString(16).padStart(8, '0') + '  ' + hex + ' |' + Array.from(chunk, hexByteChar).join('') + '|';
  }
  function hexdumpRow(fmt, chunk) {
    let row = '';
    for (let i = 0; i < chunk.length; i += fmt.unit) {
      let v = chunk[i]; if (fmt.unit === 2) v |= (i + 1 < chunk.length ? chunk[i + 1] : 0) << 8;
      row += fmt.item(v);
    }
    return row;
  }
  K.cmd.register({
    name: 'hexdump',
    aliases: ['hd'],
    pkg: 'bsdextrautils',
    summary: 'display file contents in hexadecimal, decimal, octal, or ascii',
    synopsis: 'hexdump [options] file...',
    man: `DESCRIPTION
       Display the contents of the given files, or standard input, in a
       user-specified format. The default format shows 16-bit words in
       hexadecimal; identical lines are replaced by a single asterisk.

OPTIONS
       -b, --one-byte-octal      one-byte octal display
       -c, --one-byte-char       one-byte character display
       -C, --canonical           canonical hex+ASCII display
       -d, --two-bytes-decimal   two-byte decimal display
       -o, --two-bytes-octal     two-byte octal display
       -x, --two-bytes-hex       two-byte hexadecimal display
       -n, --length length       interpret only length bytes of input
       -s, --skip offset         skip offset bytes from the beginning
       -v, --no-squeezing        output identical lines

EXAMPLES
       hexdump -C /etc/hostname
       echo -n hi | hexdump`,
    async run(ctx) {
      if (ctx.args.length === 1 && ctx.args[0] === '--help') { ctx.out(HEXDUMP_HELP); return 0; }
      if (ctx.args.length === 1 && (ctx.args[0] === '-V' || ctx.args[0] === '--version')) { ctx.out('hexdump from util-linux 2.40.2\n'); return 0; }
      const g = K.getopt(ctx.args, { short: 'bcCdn:os:vxV', long: ['one-byte-octal', 'one-byte-char', 'canonical', 'two-bytes-decimal', 'two-bytes-octal', 'two-bytes-hex', 'length=', 'skip=', 'no-squeezing', 'version', 'help'], alias: { 'one-byte-octal': 'b', 'one-byte-char': 'c', canonical: 'C', 'two-bytes-decimal': 'd', 'two-bytes-octal': 'o', 'two-bytes-hex': 'x', length: 'n', skip: 's', 'no-squeezing': 'v' } });
      if (g.err) { ctx.err('hexdump: ' + g.err + "\nTry 'hexdump --help' for more information.\n"); return 1; }
      const num = (key) => {
        if (g.opts[key] === undefined) return 0;
        const v = parseBytes(String(g.opts[key]));
        if (v === null) { ctx.err('hexdump: invalid number: ' + g.opts[key] + '\n'); return null; }
        return v;
      };
      const length = g.opts.n === undefined ? Infinity : num('n'); const skip = num('s');
      if (length === null || skip === null) return 1;
      const kinds = [];
      for (const [k] of g.seq) if (k === 'C' || k in HEXDUMP_FORMATS) kinds.push(k);
      if (!kinds.length) kinds.push('default');
      const { inputs, failed } = await readFiles(ctx, g.rest);
      if (!inputs.length) return 1;
      const parts = inputs.map((i) => bytesOf(i.text));
      let bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0; for (const p of parts) { bytes.set(p, at); at += p.length; }
      bytes = bytes.subarray(skip, length === Infinity ? undefined : skip + length);
      if (!bytes.length) return failed ? 1 : 0;
      const canonical = kinds[0] === 'C';
      const offW = canonical ? 8 : 7;
      const lines = []; let prev = null; let squeezing = false;
      for (let pos = 0; pos < bytes.length; pos += 16) {
        const chunk = bytes.subarray(pos, pos + 16);
        if (!g.opts.v && prev && chunk.length === 16 && chunk.every((b, i) => b === prev[i])) {
          if (!squeezing) lines.push('*');
          squeezing = true; continue;
        }
        squeezing = false; prev = chunk;
        const off = pos + skip;
        kinds.forEach((k, i) => {
          if (k === 'C') lines.push(hexdumpCanonical(chunk, off));
          else {
            const body = hexdumpRow(HEXDUMP_FORMATS[k === 'default' ? 'x' : k], chunk);
            lines.push((i === 0 ? off.toString(16).padStart(offW, '0') : ' '.repeat(offW)) + body);
          }
        });
      }
      lines.push((bytes.length + skip).toString(16).padStart(offW, '0'));
      ctx.out(lines.map((l) => l + '\n').join(''));
      return failed ? 1 : 0;
    },
  });
  const HEXDUMP_HELP = `\nUsage:\n hexdump [options] <file>...\n\nDisplay file contents in hexadecimal, decimal, octal, or ascii.\n\nOptions:\n -b, --one-byte-octal      one-byte octal display\n -c, --one-byte-char       one-byte character display\n -C, --canonical           canonical hex+ASCII display\n -d, --two-bytes-decimal   two-byte decimal display\n -e, --format <format>     display format string\n -f, --format-file <file>  file that contains format strings\n -L, --color[=<mode>]      interpret color formatting specifiers\n                             colors are enabled by default\n -n, --length <length>     interpret only length bytes of input\n -o, --two-bytes-octal     two-byte octal display\n -s, --skip <offset>       skip offset bytes from the beginning\n -v, --no-squeezing        output identical lines\n -x, --two-bytes-hex       two-byte hexadecimal display\n\n -h, --help                display this help\n -V, --version             display version\n\nFor more details see hexdump(1).\n`;

  /* --------------------------------------------------------------- fmt */
  const FMT = { LINE: 4900, SENTENCE_BONUS: 2500, NOBREAK: 360000, PUNCT_BONUS: 1600, PAREN_BONUS: 1600 };
  const fmtShort = (n) => (n * 10) * (n * 10);
  const fmtRagged = (n) => Math.floor(fmtShort(n) / 2);
  /** Split a line into its indent (in columns) and words; `rest` is the text after any prefix. */
  function fmtWords(rest, startCol) {
    let col = startCol; let i = 0;
    const advance = (c) => (c === '\t' ? col + 8 - (col % 8) : col + 1);
    while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) { col = advance(rest[i]); i++; }
    const indent = col; const words = [];
    while (i < rest.length) {
      let j = i; while (j < rest.length && rest[j] !== ' ' && rest[j] !== '\t') j++;
      const text = rest.slice(i, j); col += [...text].length;
      let space = 0; i = j;
      while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) { const next = advance(rest[i]); space += next - col; col = next; i++; }
      const core = text.replace(/[)\]'"]+$/, '');
      const last = core[core.length - 1] || text[text.length - 1];
      words.push({ text, length: [...text].length, space, period: '.?!'.includes(last), punct: /[!-/:-@[-`{-~]/.test(last), paren: text[0] === '(' || text[0] === '[', atEol: i >= rest.length });
    }
    return { indent, words };
  }
  const fmtBaseCost = (words, i) => {
    let cost = FMT.LINE;
    if (i > 0) {
      const prev = words[i - 1];
      if (prev.period) cost += prev.final ? -FMT.SENTENCE_BONUS : FMT.NOBREAK;
      else if (prev.punct) cost -= FMT.PUNCT_BONUS;
      else if (i > 1 && words[i - 2].final) cost += Math.floor(40000 / (prev.length + 2));
    }
    const w = words[i];
    if (w.paren) cost -= FMT.PAREN_BONUS;
    else if (w.final) cost += Math.floor(22500 / (w.length + 2));
    return cost;
  }
  /** Optimal line breaking as in GNU fmt: returns the start index of each output line. */
  function fmtBreaks(words, firstIndent, otherIndent, goal, max) {
    const n = words.length;
    const best = new Array(n + 1).fill(0); const next = new Array(n + 1).fill(n); const lineLen = new Array(n + 1).fill(0);
    for (let start = n - 1; start >= 0; start--) {
      let bestCost = Infinity;
      let len = (start === 0 ? firstIndent : otherIndent) + words[start].length;
      let w = start;
      do {
        w++;
        let cost = 0;
        if (w !== n) {
          cost = fmtShort(goal - len);
          if (next[w] !== n) cost += fmtRagged(len - lineLen[w]);
        }
        cost += best[w];
        if (cost < bestCost) { bestCost = cost; next[start] = w; lineLen[start] = len; }
        if (w === n) break;
        len += words[w - 1].space + words[w].length;
      } while (len < max);
      best[start] = bestCost + fmtBaseCost(words, start);
    }
    const starts = []; for (let s = 0; s < n; s = next[s]) starts.push(s);
    return starts;
  }
  /** Emit n columns of white space the way fmt does (tabs where they cover at least two columns). */
  function fmtSpace(col, n, useTabs) {
    const target = col + n; const tabTarget = Math.floor(target / 8) * 8;
    let out = '';
    if (useTabs && col + 1 < tabTarget) while (col < tabTarget) { out += '\t'; col = (Math.floor(col / 8) + 1) * 8; }
    return out + ' '.repeat(Math.max(0, target - col));
  }
  function fmtEmit(para, o) {
    const { words, firstIndent, otherIndent } = para;
    fmtFinish(words, o.uniform);
    const starts = fmtBreaks(words, firstIndent, otherIndent, o.goal, o.max);
    let out = '';
    starts.forEach((s, li) => {
      const end = li + 1 < starts.length ? starts[li + 1] : words.length;
      let col = 0; let line = '';
      if (o.prefix) { line = o.prefix; col = o.prefix.length; }
      const indent = li === 0 ? firstIndent : otherIndent;
      line += fmtSpace(col, indent - col, o.tabs); col = Math.max(col, indent);
      for (let k = s; k < end; k++) {
        line += words[k].text; col += words[k].length;
        if (k + 1 < end) { line += fmtSpace(col, words[k].space, o.tabs); col += words[k].space; }
      }
      out += line + '\n';
    });
    return out;
  }
  function fmtText(text, o) {
    const lines = text.split('\n'); if (lines[lines.length - 1] === '') lines.pop();
    let out = ''; let para = null; o.tabs = false;
    const flush = () => { if (para) { out += fmtEmit(para, o); para = null; } };
    const parse = (line) => {
      if (o.prefix && !line.startsWith(o.prefix)) return null;
      return fmtWords(o.prefix ? line.slice(o.prefix.length) : line, o.prefix ? o.prefix.length : 0);
    };
    for (const line of lines) {
      // Like GNU fmt, output uses tabs from the moment a tab has been read.
      if (/^[ ]*\t/.test(line)) o.tabs = true;
      const p = parse(line);
      if (!p) { flush(); out += line + '\n'; continue; }
      if (!p.words.length) { flush(); out += (o.prefix ? line.replace(/\s+$/, '') : '') + '\n'; continue; }
      const joins = para && !o.split && (para.count === 1 ? (o.crown || (o.tagged && p.indent !== para.firstIndent) || (!o.crown && !o.tagged && p.indent === para.firstIndent)) : p.indent === para.otherIndent);
      if (!joins) {
        flush();
        para = { words: [], firstIndent: p.indent, otherIndent: p.indent, count: 0 };
      } else if (para.count === 1 && (o.crown || o.tagged)) para.otherIndent = p.indent;
      para.count++;
      for (const w of p.words) para.words.push(w);
      if (line.includes('\t')) o.tabs = true;
    }
    flush();
    return out;
  }
  /** Decide each word's trailing space once its paragraph is complete (end of line, sentence ends, -u). */
  function fmtFinish(words, uniform) {
    words.forEach((w) => { w.final = w.period && (w.atEol || w.space > 1); });
    words[words.length - 1].final = true; // the end of a paragraph counts as a sentence end
    words.forEach((w, i) => {
      if (uniform) w.space = w.final ? 2 : 1;
      else if (w.atEol) w.space = w.period ? 2 : 1;
      if (i === words.length - 1) w.space = 0;
    });
  }
  gnu({
    name: 'fmt',
    summary: 'simple optimal text formatter',
    synopsis: 'fmt [-WIDTH] [OPTION]... [FILE]...',
    man: `DESCRIPTION
       Reformat each paragraph in the FILE(s), writing to standard output.
       Lines are joined and refilled to at most WIDTH columns (default 75).

OPTIONS
       -c, --crown-margin       preserve indentation of first two lines
       -p, --prefix=STRING      reformat only lines beginning with STRING
       -s, --split-only         split long lines, but do not refill
       -t, --tagged-paragraph   indentation of first line different from second
       -u, --uniform-spacing    one space between words, two after sentences
       -w, --width=WIDTH        maximum line width (default of 75 columns)
       -g, --goal=WIDTH         goal width (default of 93% of width)

EXAMPLES
       fmt -w 60 notes.txt
       fmt -s -w 72 -p '> ' reply.txt`,
    spec: { short: 'cstuw:g:p:0123456789', long: ['crown-margin', 'tagged-paragraph', 'split-only', 'uniform-spacing', 'width=', 'goal=', 'prefix=', 'help', 'version'], alias: { 'crown-margin': 'c', 'tagged-paragraph': 't', 'split-only': 's', 'uniform-spacing': 'u', width: 'w', goal: 'g', prefix: 'p' } },
    async run(ctx, g) {
      const bad = (what, v, why) => { ctx.err('fmt: invalid ' + what + ': ' + quote(ctx, String(v)) + (why ? ': ' + why : '') + '\n'); return 1; };
      let widthArg = g.opts.w;
      const first = ctx.args[0];
      if (widthArg === undefined && first && /^-\d+$/.test(first)) widthArg = first.slice(1);
      const parse = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);
      let max = 75; let goal;
      if (widthArg !== undefined) { max = parse(widthArg); if (max === null) return bad('width', widthArg); }
      if (g.opts.g !== undefined) { goal = parse(g.opts.g); if (goal === null) return bad('width', g.opts.g); }
      if (goal !== undefined && widthArg === undefined) max = goal + 10;
      if (max > 2500) return bad('width', widthArg === undefined ? g.opts.g : widthArg, 'Numerical result out of range');
      if (goal === undefined) goal = Math.floor((max * 187) / 200);
      else if (goal > max) return bad('width', g.opts.g, 'Numerical result out of range');
      const opts = { max, goal, crown: !!g.opts.c, tagged: !!g.opts.t, split: !!g.opts.s, uniform: !!g.opts.u, prefix: g.opts.p === undefined ? '' : String(g.opts.p) };
      let failed = false;
      const operands = g.rest.filter((f) => !(f === first && /^-\d+$/.test(f)));
      for (const f of operands.length ? operands : ['-']) {
        let text;
        try { text = f === '-' ? await stdinText(ctx) : ctx.fs.read(f); } catch (e) {
          if (!(e instanceof K.FsError)) throw e;
          ctx.err("fmt: cannot open '" + f + "' for reading: " + e.message + '\n'); failed = true; continue;
        }
        ctx.out(fmtText(text, opts));
      }
      return failed ? 1 : 0;
    },
  });

  K.textKit = { gnu, readFiles, stdinText, quote, breathe, bytesOf, HELP, VERSION, usageTry };
})(typeof globalThis !== 'undefined' ? globalThis : this);
