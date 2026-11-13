/* Kalima — shell language front end: lexer, parser, arithmetic.
 *
 * Supported grammar (a practical subset of POSIX sh / bash / zsh):
 *   lists (; & newline), && ||, pipelines, ! negation, redirections
 *   (> >> < 2> 2>> &> &>> 2>&1 >&2 <<< <<EOF), quoting ('', "", \, $''),
 *   $var ${var...} $(cmd) `cmd` $((arith)), ~ expansion, globs, {a,b} {1..5},
 *   if/elif/else, for, while/until, case, { group; }, ( subshell ), functions.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  class ParseError extends Error {
    constructor(msg, incomplete) { super(msg); this.name = 'ParseError'; this.incomplete = !!incomplete; }
  }

  const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', '{', '}', 'function', '!']);

  /** Index just past the `$`-construct that starts at src[i] === '$'. */
  function dollarEnd(src, i) {
    const n = src.length;
    const c = src[i + 1];
    if (c === '(') {
      if (src[i + 2] === '(') {
        // $(( arithmetic ))
        let depth = 0;
        for (let j = i + 1; j < n; j++) {
          if (src[j] === '(') depth++;
          else if (src[j] === ')') { depth--; if (depth === 0) return j + 1; }
        }
        throw new ParseError('unmatched $((', true);
      }
      let depth = 0;
      for (let j = i + 1; j < n; j++) {
        const ch = src[j];
        if (ch === '\\') { j++; continue; }
        if (ch === "'") { const k = src.indexOf("'", j + 1); if (k < 0) throw new ParseError('unmatched \'', true); j = k; continue; }
        if (ch === '"') {
          let k = j + 1;
          while (k < n && src[k] !== '"') { if (src[k] === '\\') k++; k++; }
          if (k >= n) throw new ParseError('unmatched "', true);
          j = k; continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) return j + 1; }
      }
      throw new ParseError('unmatched $(', true);
    }
    if (c === '{') {
      let depth = 0;
      for (let j = i + 1; j < n; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return j + 1; }
      }
      throw new ParseError('unmatched ${', true);
    }
    if (c === undefined) return i + 1;
    if (/[A-Za-z_]/.test(c)) { let j = i + 2; while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++; return j; }
    if (/[0-9?$!#@*\-]/.test(c)) return i + 2;
    return i + 1;
  }

  function ansiC(s) {
    return s.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|u[0-9a-fA-F]{1,4}|.)/g, (m, e) => {
      switch (e[0]) {
        case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r'; case 'a': return '\x07'; case 'b': return '\b';
        case 'e': case 'E': return '\x1b'; case 'f': return '\f'; case 'v': return '\v'; case '\\': return '\\';
        case "'": return "'"; case '"': return '"';
        case 'x': return String.fromCharCode(parseInt(e.slice(1), 16));
        case 'u': return String.fromCharCode(parseInt(e.slice(1), 16));
        default:
          if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
          return m;
      }
    });
  }

  /* ------------------------------------------------------------------- lexer */
  function lex(src) {
    const toks = [];
    const n = src.length;
    let i = 0;
    const pendingHeredocs = [];

    function readWord() {
      const parts = []; let cur = ''; let curQ = 'n'; let quoted = false;
      const start = i;
      const flush = () => { if (cur !== '') { parts.push({ q: curQ, s: cur }); cur = ''; } };
      const push = (q, s) => { if (s === '') return; if (q !== curQ) { flush(); curQ = q; } cur += s; };
      while (i < n) {
        const ch = src[i];
        if (ch === "'") {
          const j = src.indexOf("'", i + 1);
          if (j < 0) throw new ParseError('unmatched \'', true);
          push('s', src.slice(i + 1, j)); quoted = true; i = j + 1; continue;
        }
        if (ch === '"') {
          i++; quoted = true;
          for (;;) {
            if (i >= n) throw new ParseError('unmatched "', true);
            const c = src[i];
            if (c === '"') { i++; break; }
            if (c === '\\') {
              const d = src[i + 1];
              if (d === undefined) throw new ParseError('unmatched "', true);
              if (d === '$' || d === '`' || d === '"' || d === '\\') push('s', d);
              else if (d !== '\n') push('s', '\\' + d);
              i += 2; continue;
            }
            if (c === '$') { const e = dollarEnd(src, i); push('d', src.slice(i, e)); i = e; continue; }
            if (c === '`') {
              const j = src.indexOf('`', i + 1);
              if (j < 0) throw new ParseError('unmatched `', true);
              push('d', '$(' + src.slice(i + 1, j) + ')'); i = j + 1; continue;
            }
            push('s', c); i++;
          }
          continue;
        }
        if (ch === '\\') {
          if (i + 1 >= n) throw new ParseError('trailing backslash', true);
          if (src[i + 1] === '\n') { i += 2; continue; }
          push('s', src[i + 1]); quoted = true; i += 2; continue;
        }
        if (ch === '$') {
          if (src[i + 1] === "'") {
            let j = i + 2;
            while (j < n && src[j] !== "'") { if (src[j] === '\\') j++; j++; }
            if (j >= n) throw new ParseError('unmatched \'', true);
            push('s', ansiC(src.slice(i + 2, j))); quoted = true; i = j + 1; continue;
          }
          const e = dollarEnd(src, i);
          push('n', src.slice(i, e)); i = e; continue;
        }
        if (ch === '`') {
          const j = src.indexOf('`', i + 1);
          if (j < 0) throw new ParseError('unmatched `', true);
          push('n', '$(' + src.slice(i + 1, j) + ')'); i = j + 1; continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === ';' || ch === '&' || ch === '|' || ch === '<' || ch === '>' || ch === '(' || ch === ')') break;
        push('n', ch); i++;
      }
      flush();
      return { type: 'word', parts, quoted, raw: src.slice(start, i) };
    }

    function readHeredocs() {
      // called right after a newline was consumed
      while (pendingHeredocs.length) {
        const h = pendingHeredocs.shift();
        let body = '';
        for (;;) {
          if (i >= n) throw new ParseError('here-document delimited by end-of-file (wanted `' + h.delim + '\')', true);
          let j = src.indexOf('\n', i);
          const lineEnd = j < 0 ? n : j;
          let line = src.slice(i, lineEnd);
          i = j < 0 ? n : j + 1;
          if (h.strip) line = line.replace(/^\t+/, '');
          if (line === h.delim) break;
          body += line + '\n';
          if (j < 0) throw new ParseError('here-document delimited by end-of-file (wanted `' + h.delim + '\')', true);
        }
        h.body = body;
      }
    }

    while (i < n) {
      const ch = src[i];
      if (ch === ' ' || ch === '\t') { i++; continue; }
      if (ch === '\\' && src[i + 1] === '\n') { i += 2; continue; }
      if (ch === '\n') { toks.push({ type: 'nl' }); i++; readHeredocs(); continue; }
      if (ch === '#') { while (i < n && src[i] !== '\n') i++; continue; }
      // redirection with an explicit fd, e.g. 2> or 2>&1
      let fd = null; let j = i;
      if (/[0-9]/.test(ch)) {
        let k = i; while (k < n && /[0-9]/.test(src[k])) k++;
        if (src[k] === '>' || src[k] === '<') { fd = parseInt(src.slice(i, k), 10); j = k; }
      }
      const c = src[j];
      if (c === '>' || c === '<' || (c === '&' && src[j + 1] === '>')) {
        let op;
        if (c === '&') { op = src[j + 2] === '>' ? '&>>' : '&>'; j += op.length; }
        else if (c === '>') {
          if (src[j + 1] === '>') { op = '>>'; j += 2; }
          else if (src[j + 1] === '&') { op = '>&'; j += 2; }
          else if (src[j + 1] === '|') { op = '>'; j += 2; }
          else { op = '>'; j += 1; }
        } else {
          if (src[j + 1] === '<' && src[j + 2] === '<') { op = '<<<'; j += 3; }
          else if (src[j + 1] === '<') { op = '<<'; j += 2; }
          else if (src[j + 1] === '&') { op = '<&'; j += 2; }
          else { op = '<'; j += 1; }
        }
        i = j;
        const tok = { type: 'redir', op, fd: fd == null ? (op[0] === '<' ? 0 : 1) : fd };
        if (op === '>&' || op === '<&') {
          const m = /^([0-9]+|-)/.exec(src.slice(i));
          if (m) { tok.dup = m[1]; i += m[1].length; }
          else if (op === '>&') { tok.op = '&>'; } // `>& file` is the same as `&> file`
        }
        if (op === '<<') {
          let strip = false;
          if (src[i] === '-') { strip = true; i++; }
          while (src[i] === ' ' || src[i] === '\t') i++;
          const w = readWord();
          if (!w.parts.length && !w.quoted) throw new ParseError('parse error near `<<\'');
          const h = { delim: w.parts.map((p) => p.s).join(''), quoted: w.quoted, strip, body: '' };
          tok.heredoc = h; pendingHeredocs.push(h);
        }
        toks.push(tok);
        continue;
      }
      if (ch === ';') { if (src[i + 1] === ';') { toks.push({ type: 'op', v: ';;' }); i += 2; } else { toks.push({ type: 'op', v: ';' }); i++; } continue; }
      if (ch === '&') { if (src[i + 1] === '&') { toks.push({ type: 'op', v: '&&' }); i += 2; } else { toks.push({ type: 'op', v: '&' }); i++; } continue; }
      if (ch === '|') {
        if (src[i + 1] === '|') { toks.push({ type: 'op', v: '||' }); i += 2; }
        else if (src[i + 1] === '&') { toks.push({ type: 'op', v: '|&' }); i += 2; }
        else { toks.push({ type: 'op', v: '|' }); i++; }
        continue;
      }
      if (ch === '(' || ch === ')') { toks.push({ type: 'op', v: ch }); i++; continue; }
      const w = readWord();
      if (!w.parts.length && !w.quoted) { throw new ParseError('parse error near `' + src[i] + '\''); }
      toks.push(w);
    }
    if (pendingHeredocs.length) throw new ParseError('here-document delimited by end-of-file', true);
    return toks;
  }

  /* ------------------------------------------------------------------ parser */
  function wordText(tok) {
    if (!tok || tok.type !== 'word' || tok.quoted || tok.parts.length !== 1 || tok.parts[0].q !== 'n') return null;
    return tok.parts[0].s;
  }

  class Parser {
    constructor(toks, aliases) { this.t = toks; this.p = 0; this.aliases = aliases || null; }
    peek(o) { return this.t[this.p + (o || 0)]; }
    next() { return this.t[this.p++]; }
    atEnd() { return this.p >= this.t.length; }
    isOp(v) { const t = this.peek(); return !!t && t.type === 'op' && t.v === v; }
    isWord(text) { return wordText(this.peek()) === text; }
    skipNl() { while (!this.atEnd() && this.peek().type === 'nl') this.p++; }
    describe(t) {
      if (!t) return 'end of input';
      if (t.type === 'nl') return '\\n';
      if (t.type === 'op') return t.v;
      if (t.type === 'redir') return t.op;
      return t.raw;
    }
    fail(t) {
      if (!t) throw new ParseError('parse error: unexpected end of input', true);
      throw new ParseError('parse error near `' + this.describe(t) + '\'');
    }
    expectWord(text) {
      if (!this.isWord(text)) this.fail(this.peek());
      this.p++;
    }

    parseProgram() {
      const list = this.parseList(null);
      if (!this.atEnd()) this.fail(this.peek());
      return list;
    }

    /** terms: array of reserved words / op values that end the list (not consumed). */
    parseList(terms) {
      const items = [];
      const atTerm = () => {
        if (this.atEnd()) return true;
        if (!terms) return false;
        const t = this.peek();
        if (t.type === 'op') return terms.indexOf(t.v) >= 0;
        const w = wordText(t);
        return w != null && terms.indexOf(w) >= 0;
      };
      for (;;) {
        while (!this.atEnd() && (this.peek().type === 'nl' || this.isOp(';'))) this.p++;
        if (atTerm()) break;
        const node = this.parseAndOr();
        let bg = false;
        if (this.isOp('&')) { bg = true; this.p++; }
        else if (this.isOp(';') || (!this.atEnd() && this.peek().type === 'nl')) this.p++;
        else if (!atTerm()) this.fail(this.peek());
        items.push({ node, bg });
      }
      return { type: 'list', items };
    }

    parseAndOr() {
      const first = this.parsePipeline();
      const rest = [];
      while (this.isOp('&&') || this.isOp('||')) {
        const op = this.next().v;
        this.skipNl();
        if (this.atEnd()) this.fail(null);
        rest.push({ op, node: this.parsePipeline() });
      }
      return rest.length ? { type: 'andor', first, rest } : first;
    }

    parsePipeline() {
      let neg = false;
      while (this.isWord('!')) { neg = !neg; this.p++; }
      const cmds = [this.parseCommand()];
      while (this.isOp('|') || this.isOp('|&')) {
        const op = this.next().v;
        if (op === '|&') cmds[cmds.length - 1].pipeErr = true;
        this.skipNl();
        if (this.atEnd()) this.fail(null);
        cmds.push(this.parseCommand());
      }
      if (cmds.length === 1 && !neg) return cmds[0];
      return { type: 'pipeline', neg, cmds };
    }

    parseRedirs(node) {
      node.redirs = node.redirs || [];
      while (!this.atEnd() && this.peek().type === 'redir') node.redirs.push(this.parseRedir());
      return node;
    }

    parseRedir() {
      const r = this.next();
      const out = { op: r.op, fd: r.fd };
      if (r.dup != null) { out.dup = r.dup; return out; }
      if (r.heredoc) { out.heredoc = r.heredoc; return out; }
      const w = this.peek();
      if (!w || w.type !== 'word') this.fail(w);
      this.p++;
      out.word = w;
      return out;
    }

    parseCommand() {
      const t = this.peek();
      if (!t) this.fail(null);
      if (t.type === 'op' && t.v === '(') {
        this.p++;
        const body = this.parseList([')']);
        if (!this.isOp(')')) this.fail(this.peek());
        this.p++;
        return this.parseRedirs({ type: 'group', subshell: true, body });
      }
      const w = wordText(t);
      if (w === 'if') return this.parseRedirs(this.parseIf());
      if (w === 'for') return this.parseRedirs(this.parseFor());
      if (w === 'while' || w === 'until') return this.parseRedirs(this.parseWhile());
      if (w === 'case') return this.parseRedirs(this.parseCase());
      if (w === '{') {
        this.p++;
        const body = this.parseList(['}']);
        this.expectWord('}');
        return this.parseRedirs({ type: 'group', subshell: false, body });
      }
      if (w === 'function') {
        this.p++;
        const nameTok = this.next();
        const name = wordText(nameTok);
        if (!name) this.fail(nameTok);
        if (this.isOp('(')) { this.p++; if (!this.isOp(')')) this.fail(this.peek()); this.p++; }
        this.skipNl();
        return { type: 'funcdef', name, body: this.parseCommand() };
      }
      if (w === 'then' || w === 'do' || w === 'done' || w === 'fi' || w === 'elif' || w === 'else' || w === 'esac' || w === '}' || w === 'in') this.fail(t);
      if (t.type === 'op') this.fail(t);
      return this.parseSimple();
    }

    parseIf() {
      this.expectWord('if');
      const clauses = [];
      let cond = this.parseList(['then']);
      this.expectWord('then');
      let body = this.parseList(['elif', 'else', 'fi']);
      clauses.push({ cond, body });
      let otherwise = null;
      for (;;) {
        if (this.isWord('elif')) {
          this.p++;
          cond = this.parseList(['then']);
          this.expectWord('then');
          body = this.parseList(['elif', 'else', 'fi']);
          clauses.push({ cond, body });
        } else if (this.isWord('else')) {
          this.p++;
          otherwise = this.parseList(['fi']);
        } else break;
      }
      this.expectWord('fi');
      return { type: 'if', clauses, otherwise };
    }

    parseFor() {
      this.expectWord('for');
      const nameTok = this.next();
      const name = wordText(nameTok);
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) this.fail(nameTok);
      let words = null;
      this.skipNl();
      if (this.isWord('in')) {
        this.p++;
        words = [];
        while (!this.atEnd() && this.peek().type === 'word' && !this.isWord('do')) words.push(this.next());
      }
      while (!this.atEnd() && (this.peek().type === 'nl' || this.isOp(';'))) this.p++;
      this.expectWord('do');
      const body = this.parseList(['done']);
      this.expectWord('done');
      return { type: 'for', name, words, body };
    }

    parseWhile() {
      const until = wordText(this.next()) === 'until';
      const cond = this.parseList(['do']);
      this.expectWord('do');
      const body = this.parseList(['done']);
      this.expectWord('done');
      return { type: 'while', until, cond, body };
    }

    parseCase() {
      this.expectWord('case');
      const word = this.next();
      if (!word || word.type !== 'word') this.fail(word);
      this.skipNl();
      this.expectWord('in');
      const items = [];
      for (;;) {
        this.skipNl();
        if (this.isWord('esac')) break;
        if (this.atEnd()) this.fail(null);
        if (this.isOp('(')) this.p++;
        const patterns = [];
        for (;;) {
          const pt = this.next();
          if (!pt || pt.type !== 'word') this.fail(pt);
          patterns.push(pt);
          if (this.isOp('|')) { this.p++; continue; }
          break;
        }
        if (!this.isOp(')')) this.fail(this.peek());
        this.p++;
        const body = this.parseList([';;', 'esac']);
        items.push({ patterns, body });
        if (this.isOp(';;')) this.p++;
      }
      this.expectWord('esac');
      return { type: 'case', word, items };
    }

    parseSimple() {
      const node = { type: 'simple', assigns: [], words: [], redirs: [] };
      const usedAliases = new Set();
      for (;;) {
        const t = this.peek();
        if (!t) break;
        if (t.type === 'redir') { node.redirs.push(this.parseRedir()); continue; }
        if (t.type !== 'word') break;
        if (!node.words.length) {
          // assignment?  NAME=value
          const p0 = t.parts[0];
          if (p0 && p0.q === 'n') {
            const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(p0.s);
            if (m) {
              const restFirst = p0.s.slice(m[0].length);
              const parts = (restFirst ? [{ q: 'n', s: restFirst }] : []).concat(t.parts.slice(1));
              this.p++;
              node.assigns.push({ name: m[1], append: m[2] === '+', word: { type: 'word', parts, quoted: true, raw: t.raw } });
              continue;
            }
          }
          // alias expansion on the command word
          const w = wordText(t);
          if (w != null && this.aliases && this.aliases.has(w) && !usedAliases.has(w)) {
            usedAliases.add(w);
            const sub = lex(this.aliases.get(w));
            this.t.splice(this.p, 1, ...sub);
            continue;
          }
        }
        this.p++;
        node.words.push(t);
        // function definition:  name() { ... }
        if (node.words.length === 1 && !node.assigns.length && this.isOp('(') && this.peek(1) && this.peek(1).type === 'op' && this.peek(1).v === ')') {
          const name = wordText(t);
          if (name == null) this.fail(this.peek());
          this.p += 2;
          this.skipNl();
          return { type: 'funcdef', name, body: this.parseCommand() };
        }
      }
      if (!node.words.length && !node.assigns.length && !node.redirs.length) this.fail(this.peek());
      return node;
    }
  }

  /* -------------------------------------------------------------- arithmetic */
  function arith(expr, getVar, setVar) {
    const toks = [];
    const re = /\s*(0[xX][0-9a-fA-F]+|\d+|[A-Za-z_][A-Za-z0-9_]*|\*\*|<<|>>|<=|>=|==|!=|&&|\|\||\+\+|--|[-+*\/%()<>!~&|^?:=,])/y;
    let m; re.lastIndex = 0;
    let pos = 0;
    while (pos < expr.length) {
      re.lastIndex = pos;
      m = re.exec(expr);
      if (!m) { if (/^\s*$/.test(expr.slice(pos))) break; throw new Error('bad math expression: `' + expr.trim() + '\''); }
      toks.push(m[1]); pos = re.lastIndex;
    }
    let p = 0;
    const peek = () => toks[p];
    const eat = (t) => { if (toks[p] === t) { p++; return true; } return false; };
    const num = (name) => {
      const v = getVar(name);
      if (v == null || v === '') return 0;
      const nn = parseInt(v, /^0[xX]/.test(v) ? 16 : 10);
      return isNaN(nn) ? 0 : nn;
    };
    function primary() {
      const t = toks[p++];
      if (t === undefined) throw new Error('bad math expression: operand expected at end of string');
      if (t === '(') { const v = ternary(); if (!eat(')')) throw new Error("bad math expression: ')' expected"); return v; }
      if (t === '-') return -unary();
      if (t === '+') return +unary();
      if (t === '!') return unary() ? 0 : 1;
      if (t === '~') return ~unary();
      if (/^\d/.test(t)) return /^0[xX]/.test(t) ? parseInt(t, 16) : parseInt(t, 10);
      if (/^[A-Za-z_]/.test(t)) {
        if (peek() === '++') { p++; const v = num(t); if (setVar) setVar(t, String(v + 1)); return v; }
        if (peek() === '--') { p++; const v = num(t); if (setVar) setVar(t, String(v - 1)); return v; }
        if (peek() === '=' ) { p++; const v = ternary(); if (setVar) setVar(t, String(v)); return v; }
        return num(t);
      }
      throw new Error('bad math expression: operand expected at `' + t + '\'');
    }
    function unary() { return primary(); }
    function pow() { const b = unary(); if (eat('**')) return Math.pow(b, pow()); return b; }
    const LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '<=', '>', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
    function bin(level) {
      if (level >= LEVELS.length) return pow();
      let l = bin(level + 1);
      for (;;) {
        const op = peek();
        if (LEVELS[level].indexOf(op) < 0) return l;
        p++;
        const r = bin(level + 1);
        switch (op) {
          case '||': l = l || r ? 1 : 0; break; case '&&': l = l && r ? 1 : 0; break;
          case '|': l = l | r; break; case '^': l = l ^ r; break; case '&': l = l & r; break;
          case '==': l = l === r ? 1 : 0; break; case '!=': l = l !== r ? 1 : 0; break;
          case '<': l = l < r ? 1 : 0; break; case '<=': l = l <= r ? 1 : 0; break;
          case '>': l = l > r ? 1 : 0; break; case '>=': l = l >= r ? 1 : 0; break;
          case '<<': l = l << r; break; case '>>': l = l >> r; break;
          case '+': l = l + r; break; case '-': l = l - r; break; case '*': l = l * r; break;
          case '/': if (r === 0) throw new Error('division by zero'); l = Math.trunc(l / r); break;
          case '%': if (r === 0) throw new Error('division by zero'); l = l % r; break;
        }
      }
    }
    function ternary() {
      const c = bin(0);
      if (eat('?')) { const a = ternary(); if (!eat(':')) throw new Error("bad math expression: ':' expected"); const b = ternary(); return c ? a : b; }
      return c;
    }
    if (!toks.length) return 0;
    let v = ternary();
    while (eat(',')) v = ternary();
    if (p < toks.length) throw new Error('bad math expression: operator expected at `' + toks[p] + '\'');
    return v;
  }

  K.shlex = { lex, Parser, ParseError, dollarEnd, arith, wordText, RESERVED, ansiC };
  /** Parse shell source to an AST. Throws ParseError (with .incomplete when more input is needed). */
  K.shlex.parse = function (src, aliases) { return new Parser(lex(src), aliases).parseProgram(); };
})(typeof globalThis !== 'undefined' ? globalThis : this);
