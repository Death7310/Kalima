/* Kalima — the shell: expansion, execution, builtins, job control, REPL.
 *
 * A Shell runs on a Machine as a user, attached to a terminal object (see
 * HeadlessTerm below for the interface a terminal must provide).
 */
;(function (root) {
  'use strict';
  const K = root.K;
  const VFS = K.VFS;
  const { lex, Parser, ParseError, dollarEnd, arith } = K.shlex;

  /* ------------------------------------------------------------------ signal */
  class Signal {
    constructor() { this.aborted = false; this._l = new Set(); }
    abort() { if (this.aborted) return; this.aborted = true; for (const fn of Array.from(this._l)) { try { fn(); } catch (e) { /* ignore */ } } }
    reset() { this.aborted = false; this._l.clear(); }
    onAbort(fn) { this._l.add(fn); return () => this._l.delete(fn); }
  }
  K.Signal = Signal;

  /* ---------------------------------------------------------------- terminal
   * Terminal interface (the browser terminal implements the same methods):
   *   cols, rows, signal: Signal
   *   write(str)                              ANSI text; '\n' newlines
   *   readLine({prompt, hidden, history, complete}) -> Promise<string|null>
   *        resolves null on EOF (Ctrl-D on an empty line); rejects K.Interrupt on Ctrl-C
   *   raiseInterrupt()                        called on Ctrl-C while a command runs
   *   clear()
   *   pager(text, {title}) -> Promise         full-screen pager (less/man)
   *   editor({path, content, flavor}) -> Promise<{saved, content}>
   *   onKey(fn) -> unsubscribe                raw key presses for commands like top ('q', 'Enter', ...)
   */
  class HeadlessTerm {
    constructor(o) {
      o = o || {};
      this.cols = o.cols || 80; this.rows = o.rows || 24;
      this.output = ''; this.inputs = []; this.signal = new Signal(); this.headless = true;
      this._keys = new Set();
    }
    /** subscribe to raw key presses while a full-screen style command runs; returns an unsubscribe function */
    onKey(fn) { this._keys.add(fn); return () => this._keys.delete(fn); }
    /** test helper: deliver a key ('q', 'Enter', 'ArrowUp', ...) to onKey subscribers */
    pressKey(k) { for (const fn of Array.from(this._keys)) fn(k); }
    write(s) { this.output += s; }
    /** queue lines that subsequent readLine() calls will return */
    feed() { for (const l of arguments) this.inputs.push(l); }
    async readLine(o) {
      o = o || {};
      if (o.prompt) this.write(o.prompt);
      if (!this.inputs.length) return null;
      const l = this.inputs.shift();
      this.write((o.hidden ? '' : l) + '\n');
      return l;
    }
    raiseInterrupt() { this.signal.abort(); }
    clear() { this.output = ''; }
    async pager(text) { this.write(text); }
    async editor(o) { return { saved: false, content: o.content }; }
    take() { const s = this.output; this.output = ''; return s; }
  }
  K.HeadlessTerm = HeadlessTerm;

  /* ------------------------------------------------------ control-flow throws */
  class BreakSignal { constructor(n) { this.n = n; } }
  class ContinueSignal { constructor(n) { this.n = n; } }
  class ReturnSignal { constructor(code) { this.code = code; } }

  const MAX_CAPTURE = 4 * 1024 * 1024;
  const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/games:/usr/games';

  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    const d = [];
    for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[a.length][b.length];
  }

  function echoEscapes(s) {
    let stop = false;
    const out = s.replace(/\\(c|0[0-7]{0,3}|x[0-9a-fA-F]{1,2}|.)/g, (m, e, off) => {
      if (stop) return '';
      switch (e[0]) {
        case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r'; case 'a': return '\x07'; case 'b': return '\b';
        case 'e': return '\x1b'; case 'f': return '\f'; case 'v': return '\v'; case '\\': return '\\';
        case 'c': stop = off; return '';
        case '0': return String.fromCharCode(parseInt(e.slice(1) || '0', 8));
        case 'x': return String.fromCharCode(parseInt(e.slice(1), 16));
        default: return m;
      }
    });
    return stop === false ? { s: out, stop: false } : { s: out.slice(0, stop), stop: true };
  }
  K.util.echoEscapes = (s) => echoEscapes(s).s;

  function formatPrintf(fmt, args) {
    let out = ''; let ai = 0; let used = false;
    const nextArg = () => { used = true; return ai < args.length ? args[ai++] : undefined; };
    const one = () => {
      let res = '';
      for (let i = 0; i < fmt.length; i++) {
        const ch = fmt[i];
        if (ch === '\\') {
          const m = /^\\(0[0-7]{0,3}|[0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)/.exec(fmt.slice(i));
          if (m) {
            const e = m[1];
            const map = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'" };
            if (map[e] != null) res += map[e];
            else if (e[0] === 'x') res += String.fromCharCode(parseInt(e.slice(1), 16));
            else if (/^[0-7]/.test(e)) res += String.fromCharCode(parseInt(e, 8));
            else res += '\\' + e;
            i += m[0].length - 1; continue;
          }
        }
        if (ch === '%') {
          const m = /^%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?([sdiuxXocfeEgGbq%])/.exec(fmt.slice(i));
          if (!m) { res += ch; continue; }
          i += m[0].length - 1;
          if (m[4] === '%') { res += '%'; continue; }
          const flags = m[1] || '';
          let width = m[2] === '*' ? parseInt(nextArg(), 10) || 0 : m[2] ? parseInt(m[2], 10) : 0;
          const prec = m[3] === '*' ? parseInt(nextArg(), 10) || 0 : m[3] != null ? parseInt(m[3], 10) : null;
          let a = nextArg(); let s;
          const numArg = () => {
            if (a === undefined || a === '') return 0;
            if (/^['"]/.test(a)) return a.charCodeAt(1) || 0;
            const v = /^-?0[xX]/.test(a) ? parseInt(a, 16) : /^-?0[0-7]+$/.test(a) ? parseInt(a, 8) : parseFloat(a);
            return isNaN(v) ? 0 : v;
          };
          switch (m[4]) {
            case 's': s = a === undefined ? '' : String(a); if (prec != null) s = s.slice(0, prec); break;
            case 'b': s = a === undefined ? '' : echoEscapes(String(a)).s; break;
            case 'q': s = a === undefined ? "''" : /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(a) ? a : "'" + String(a).replace(/'/g, "'\\''") + "'"; break;
            case 'c': s = a === undefined ? '' : String(a).charAt(0); break;
            case 'd': case 'i': case 'u': { const v = Math.trunc(numArg()); s = String(Math.abs(v)); if (prec != null) s = s.padStart(prec, '0'); if (v < 0) s = '-' + s; else if (flags.includes('+')) s = '+' + s; else if (flags.includes(' ')) s = ' ' + s; break; }
            case 'x': s = (Math.trunc(numArg()) >>> 0).toString(16); if (flags.includes('#')) s = '0x' + s; break;
            case 'X': s = (Math.trunc(numArg()) >>> 0).toString(16).toUpperCase(); if (flags.includes('#')) s = '0X' + s; break;
            case 'o': s = (Math.trunc(numArg()) >>> 0).toString(8); if (flags.includes('#')) s = '0' + s; break;
            case 'f': s = numArg().toFixed(prec == null ? 6 : prec); if (flags.includes('+') && numArg() >= 0) s = '+' + s; break;
            case 'e': case 'E': s = numArg().toExponential(prec == null ? 6 : prec).replace(/e([+-])(\d)$/, 'e$10$2'); if (m[4] === 'E') s = s.toUpperCase(); break;
            default: s = String(numArg());
          }
          if (width < 0) { width = -width; s = s.padEnd(width); }
          else if (flags.includes('-')) s = s.padEnd(width);
          else if (flags.includes('0') && /[diuxXofeE]/.test(m[4])) {
            const neg = /^[-+ ]/.test(s) ? s[0] : ''; s = neg + s.slice(neg.length).padStart(width - neg.length, '0');
          } else s = s.padStart(width);
          res += s; continue;
        }
        res += ch;
      }
      return res;
    };
    do { used = false; out += one(); } while (used && ai < args.length);
    return out;
  }
  K.util.printf = formatPrintf;

  /* ------------------------------------------------------------------- shell */
  class Shell {
    /**
     * new K.Shell({ machine, term, user: 'kali', parent, interactive, flavor: 'zsh'|'bash'|'sh', cwd, env })
     * Call `await shell.init()` once before use when interactive (sources the rc file).
     */
    constructor(o) {
      this.machine = o.machine;
      this.term = o.term || new HeadlessTerm();
      this.parent = o.parent || null;
      this.rootShell = this.parent ? this.parent.rootShell : this;
      this.interactive = !!o.interactive;
      this.flavor = o.flavor || (this.machine.profile === 'kali' ? 'zsh' : 'bash');
      this.vars = new Map();
      this.exported = new Set();
      this.aliases = new Map();
      this.functions = new Map();
      this.history = [];
      this.jobs = [];
      this.positional = [];
      this.scriptName = this.flavor;
      this.umask = this.parent ? this.parent.umask : 0o022;
      this.status = 0;
      this.lastBgPid = 0;
      this.opts = { xtrace: false };
      this.loopDepth = 0;
      this.funcDepth = 0;
      this.localStack = [];
      this.sourceDepth = 0;
      this._trace = [];
      this.login = !!o.login;
      this.tty = o.tty || (this.parent && this.parent.tty) || 'pts/0';
      this.setUser(o.user || 'kali');
      let cwd = o.cwd || this.user.home;
      if (!this.machine.vfs.exists(cwd) || !this._isDir(cwd)) cwd = '/';
      this.cwd = cwd;
      const base = o.env || {
        SHELL: (this.machine.userByName(this.user.name) || {}).shell || '/bin/sh',
        PATH: DEFAULT_PATH, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor',
      };
      for (const k of Object.keys(base)) this.setVar(k, base[k], true);
      this.setVar('HOME', this.user.home, true);
      this.setVar('USER', this.user.name, true);
      this.setVar('LOGNAME', this.user.name, true);
      this.setVar('PWD', this.cwd, true);
      if (!this.vars.has('PATH')) this.setVar('PATH', DEFAULT_PATH, true);
      this.setVar('HOSTNAME', this.machine.hostname, false);
      this.startTime = K.clock.now();
      this.proc = this.machine.spawn({
        ppid: this.parent ? this.parent.pid : 1, user: this.user.name, tty: this.tty,
        cmd: (this.login ? '-' : '') + this.flavor, stat: 'S',
      });
      this.pid = this.proc.pid;
      if (o.utmp && this.machine.state) {
        // a terminal window's login shell is a utmp record (who, w): one line per pseudo-terminal
        this.utmp = { user: this.user.name, tty: this.tty, host: ':0', at: this.startTime };
        (this.machine.state.logins = this.machine.state.logins || []).push(this.utmp);
      }
    }

    setUser(name) {
      const cred = this.machine.credFor(name);
      if (!cred) throw new Error('no such user: ' + name);
      this.user = cred;
      this.cred = cred;
      this.fs = new K.FsView(this.machine.vfs, () => this.cwd, cred, () => this.umask);
    }

    _isDir(p) { try { return this.machine.vfs.stat(p).isDir; } catch (e) { return false; } }
    dispose() {
      this.machine.reap(this.pid);
      if (this.utmp) { const l = this.machine.state.logins; const i = l ? l.indexOf(this.utmp) : -1; if (i >= 0) l.splice(i, 1); this.utmp = null; }
    }

    /* ------------------------------------------------------------- variables */
    setVar(name, value, exp) { this.vars.set(name, String(value)); if (exp) this.exported.add(name); }
    unsetVar(name) { this.vars.delete(name); this.exported.delete(name); }
    getVar(name) {
      switch (name) {
        case '?': return String(this.status);
        case '$': return String(this.pid);
        case '!': return this.lastBgPid ? String(this.lastBgPid) : '';
        case '#': return String(this.positional.length);
        case '@': case '*': return this.positional.join(' ');
        case '0': return this.scriptName;
        case '-': return this.interactive ? 'himBHs' : 'hB';
        case 'RANDOM': return String(Math.floor(K.util.prng('rnd' + K.clock.now() + ':' + (this._rnd = (this._rnd || 0) + 1))() * 32768));
        case 'SECONDS': return String(Math.floor((K.clock.now() - this.startTime) / 1000));
        case 'UID': case 'EUID': return String(this.user.uid);
        case 'PPID': return String(this.proc.ppid);
        case 'LINENO': return '1';
        case 'COLUMNS': return String(this.term.cols || 80);
        case 'LINES': return String(this.term.rows || 24);
      }
      if (/^[0-9]+$/.test(name)) { const v = this.positional[parseInt(name, 10) - 1]; return v == null ? '' : v; }
      const v = this.vars.get(name);
      return v == null ? null : v;
    }
    /** exported environment as a plain object */
    env(extra) {
      const e = {};
      for (const k of this.exported) if (this.vars.has(k)) e[k] = this.vars.get(k);
      if (extra) Object.assign(e, extra);
      return e;
    }
    msgPrefix() { return this.flavor + ': '; }

    /* ------------------------------------------------------------- expansion */
    async expandString(text, io, o) {
      // expands $-constructs inside `text`; returns array of {s, split}
      o = o || {};
      const out = [];
      let lit = '';
      const flushLit = () => { if (lit) { out.push({ s: lit, lit: true }); lit = ''; } };
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch !== '$') { lit += ch; continue; }
        const end = dollarEnd(text, i);
        const tok = text.slice(i, end);
        i = end - 1;
        if (tok === '$') { lit += '$'; continue; }
        flushLit();
        if (tok.startsWith('$((')) {
          const expr = (await this.expandString(tok.slice(3, -2), io)).map((x) => x.s).join('');
          let v;
          try { v = arith(expr, (n) => this.getVar(n), (n, val) => this.setVar(n, val)); }
          catch (e) { throw new ShellError(this.msgPrefix() + e.message); }
          out.push({ s: String(v) });
        } else if (tok.startsWith('$(')) {
          const res = await this.captureSource(tok.slice(2, -1), io);
          out.push({ s: res.replace(/\n+$/, ''), split: true });
        } else if (tok.startsWith('${')) {
          out.push(await this.expandParam(tok.slice(2, -1), io));
        } else {
          const name = tok.slice(1);
          if (name === '@') out.push({ s: this.positional.join(' '), at: true });
          else { const v = this.getVar(name); out.push({ s: v == null ? '' : v }); }
        }
      }
      flushLit();
      return out;
    }

    async expandParam(body, io) {
      const sub = async (t) => (await this.expandString(t, io)).map((x) => x.s).join('');
      if (body[0] === '#' && body.length > 1 && /^#[A-Za-z_0-9@*?]+$/.test(body)) {
        const n = body.slice(1);
        if (n === '@' || n === '*') return { s: String(this.positional.length) };
        const v = this.getVar(n); return { s: String((v || '').length) };
      }
      const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?$!#@*\-])(.*)$/s.exec(body);
      if (!m) throw new ShellError(this.msgPrefix() + 'bad substitution');
      const name = m[1]; const rest = m[2];
      let v = this.getVar(name);
      if (name === '@' && !rest) return { s: this.positional.join(' '), at: true };
      if (!rest) return { s: v == null ? '' : v };
      let mm;
      if ((mm = /^(:?)([-=+?])([\s\S]*)$/.exec(rest))) {
        const colon = mm[1] === ':'; const op = mm[2]; const arg = mm[3];
        const unset = v == null || (colon && v === '');
        if (op === '-') return { s: unset ? await sub(arg) : v };
        if (op === '=') { if (unset) { v = await sub(arg); this.setVar(name, v); } return { s: v }; }
        if (op === '+') return { s: unset ? '' : await sub(arg) };
        if (op === '?') { if (unset) throw new ShellError(this.msgPrefix() + name + ': ' + ((await sub(arg)) || 'parameter not set')); return { s: v }; }
      }
      v = v == null ? '' : v;
      if ((mm = /^(##?|%%?)([\s\S]*)$/.exec(rest))) {
        const pat = await sub(mm[2]); const op = mm[1];
        const src = K.util.globToRe(pat).source.slice(1, -1);
        if (op[0] === '#') {
          const re = new RegExp('^' + (op === '##' ? src : src.replace(/\.\*/g, '.*?')));
          return { s: v.replace(re, '') };
        }
        // suffix removal: try every split point
        const full = new RegExp('^' + src + '$');
        if (op === '%%') { for (let i = 0; i <= v.length; i++) if (full.test(v.slice(i))) return { s: v.slice(0, i) }; }
        else { for (let i = v.length; i >= 0; i--) if (full.test(v.slice(i))) return { s: v.slice(0, i) }; }
        return { s: v };
      }
      if ((mm = /^(\/\/?)((?:\\.|[^\/])*)(?:\/([\s\S]*))?$/.exec(rest))) {
        const pat = await sub(mm[2]); const rep = mm[3] == null ? '' : await sub(mm[3]);
        const src = K.util.globToRe(pat).source.slice(1, -1);
        return { s: v.replace(new RegExp(src, mm[1] === '//' ? 'g' : ''), () => rep) };
      }
      if ((mm = /^:(-?\d+)(?::(-?\d+))?$/.exec(rest))) {
        let off = parseInt(mm[1], 10); if (off < 0) off = Math.max(0, v.length + off);
        return { s: mm[2] == null ? v.slice(off) : v.slice(off, off + parseInt(mm[2], 10)) };
      }
      if (rest === '^^') return { s: v.toUpperCase() };
      if (rest === ',,') return { s: v.toLowerCase() };
      if (rest === '^') return { s: v.charAt(0).toUpperCase() + v.slice(1) };
      if (rest === ',') return { s: v.charAt(0).toLowerCase() + v.slice(1) };
      throw new ShellError(this.msgPrefix() + 'bad substitution');
    }

    /** brace expansion on a word token -> array of word tokens */
    braceExpand(word) {
      for (let pi = 0; pi < word.parts.length; pi++) {
        const part = word.parts[pi];
        if (part.q !== 'n') continue;
        const s = part.s;
        for (let i = 0; i < s.length; i++) {
          if (s[i] === '$' ) { i = dollarEnd(s, i) - 1; continue; }
          if (s[i] !== '{') continue;
          let depth = 0; let j = i; const commas = [];
          for (; j < s.length; j++) {
            if (s[j] === '$') { j = dollarEnd(s, j) - 1; continue; }
            if (s[j] === '{') depth++;
            else if (s[j] === '}') { depth--; if (depth === 0) break; }
            else if (s[j] === ',' && depth === 1) commas.push(j);
          }
          if (j >= s.length) break;
          const inner = s.slice(i + 1, j);
          let alts = null;
          const rm = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(inner);
          const cm = /^([A-Za-z])\.\.([A-Za-z])$/.exec(inner);
          if (rm) {
            const a = parseInt(rm[1], 10); const b = parseInt(rm[2], 10); let st = Math.abs(parseInt(rm[3] || '1', 10)) || 1;
            const padW = (/^-?0\d/.test(rm[1]) || /^-?0\d/.test(rm[2])) ? Math.max(rm[1].length, rm[2].length) : 0;
            alts = [];
            if (Math.abs(b - a) / st > 100000) st = Math.ceil(Math.abs(b - a) / 100000);
            for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? st : -st) alts.push(padW ? (v < 0 ? '-' : '') + String(Math.abs(v)).padStart(padW - (v < 0 ? 1 : 0), '0') : String(v));
          } else if (cm) {
            const a = cm[1].charCodeAt(0); const b = cm[2].charCodeAt(0); alts = [];
            for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? 1 : -1) alts.push(String.fromCharCode(v));
          } else if (commas.length) {
            alts = []; let prev = i + 1;
            for (const c of commas.concat([j])) { alts.push(s.slice(prev, c)); prev = c + 1; }
          }
          if (!alts) continue;
          const res = [];
          for (const alt of alts) {
            const parts = word.parts.slice(0, pi).concat([{ q: 'n', s: s.slice(0, i) + alt + s.slice(j + 1) }], word.parts.slice(pi + 1));
            res.push.apply(res, this.braceExpand({ type: 'word', parts: parts.filter((p) => p.s !== ''), quoted: word.quoted || true, raw: word.raw }));
          }
          return res;
        }
      }
      return [word];
    }

    /** Expand one word token to zero or more argument strings. */
    async expandWord(word, io, o) {
      o = o || {};
      const results = [];
      const words = o.noBrace ? [word] : this.braceExpand(word);
      for (const w of words) {
        // fields: arrays of segments {s, glob}
        let fields = [[]]; let any = w.quoted;
        const cur = () => fields[fields.length - 1];
        for (let pi = 0; pi < w.parts.length; pi++) {
          const part = w.parts[pi];
          if (part.q === 's') { cur().push({ s: part.s, glob: false }); any = true; continue; }
          let text = part.s;
          if (part.q === 'n' && pi === 0 && text[0] === '~') {
            const m = /^~([A-Za-z0-9_-]*)(?=\/|$)/.exec(text);
            if (m && (m[0].length === text.length ? w.parts.length === 1 || true : true)) {
              let home = null;
              if (m[1] === '') home = this.getVar('HOME');
              else { const u = this.machine.userByName(m[1]); if (u) home = u.home; }
              if (home != null) { cur().push({ s: home, glob: false }); text = text.slice(m[0].length); any = true; }
            }
          }
          const pieces = await this.expandString(text, io);
          for (const pc of pieces) {
            if (pc.lit) { cur().push({ s: pc.s, glob: part.q === 'n' }); any = true; continue; }
            if (pc.at && part.q === 'd') {
              // "$@" -> one field per positional parameter
              const ps = this.positional;
              if (ps.length) {
                cur().push({ s: ps[0], glob: false });
                for (let k = 1; k < ps.length; k++) fields.push([{ s: ps[k], glob: false }]);
                any = true;
              }
              continue;
            }
            const doSplit = part.q === 'n' && !o.noSplit && (pc.split || pc.at || this.flavor !== 'zsh');
            if (doSplit) {
              const bits = pc.s.split(/[ \t\n]+/);
              const lead = /^[ \t\n]/.test(pc.s); const trail = /[ \t\n]$/.test(pc.s);
              const nonEmpty = bits.filter((b) => b !== '');
              if (!nonEmpty.length) { if (pc.s !== '' && cur().length) fields.push([]); continue; }
              if (lead && cur().length) fields.push([]);
              nonEmpty.forEach((b, k) => { if (k > 0) fields.push([]); cur().push({ s: b, glob: false }); });
              if (trail) fields.push([]);
              any = true;
            } else {
              if (pc.s !== '' || part.q === 'd') { cur().push({ s: pc.s, glob: false }); }
              if (part.q === 'd') any = true;
            }
          }
          if (part.q === 'd') any = true;
        }
        for (const f of fields) {
          const text = f.map((x) => x.s).join('');
          if (!f.length && !(any && w.quoted && fields.length === 1)) { if (!(w.quoted && fields.length === 1)) continue; }
          if (text === '' && !w.quoted) continue;
          const hasGlob = !o.noGlob && f.some((x) => x.glob && /[*?\[]/.test(x.s));
          if (hasGlob) {
            const matches = this.glob(f);
            if (matches.length) { results.push.apply(results, matches); continue; }
          }
          results.push(text);
        }
      }
      return results;
    }

    /** Expand a word to exactly one string (no splitting / globbing): assignments, redirect targets, case words. */
    async expandSingle(word, io) {
      const r = await this.expandWord(word, io, { noSplit: true, noGlob: true, noBrace: true });
      return r.join(' ');
    }

    /** segments: [{s, glob}] -> sorted matching paths */
    glob(segs) {
      // Build per-path-component patterns preserving which characters are glob-active.
      const comps = [[]];
      for (const seg of segs) {
        const bits = seg.s.split('/');
        bits.forEach((b, i) => {
          if (i > 0) comps.push([]);
          if (b !== '') comps[comps.length - 1].push({ s: b, glob: seg.glob });
        });
      }
      const absolute = segs.length && segs.map((x) => x.s).join('')[0] === '/';
      const toRe = (comp) => new RegExp('^' + comp.map((c) => (c.glob ? K.util.globToRe(c.s).source.slice(1, -1) : K.util.escapeRe(c.s))).join('') + '$');
      let bases = [absolute ? '/' : ''];
      const list = comps.filter((c, i) => !(i === 0 && absolute && !c.length));
      for (let ci = 0; ci < list.length; ci++) {
        const comp = list[ci];
        if (!comp.length) continue;
        const isGlob = comp.some((c) => c.glob && /[*?\[]/.test(c.s));
        const next = [];
        const lit = comp.map((c) => c.s).join('');
        for (const b of bases) {
          const dirPath = b === '' ? this.cwd : VFS.abs(b, this.cwd);
          if (!isGlob) {
            const p = b + (b === '' || b.endsWith('/') ? '' : '/') + lit;
            if (this.machine.vfs.exists(VFS.abs(p, this.cwd), { cred: this.cred, follow: false })) next.push(p);
            continue;
          }
          let names;
          try { names = this.machine.vfs.readdir(dirPath, { cred: this.cred }); } catch (e) { continue; }
          const re = toRe(comp);
          const showDot = comp[0].s[0] === '.';
          for (const nme of names) {
            if (nme[0] === '.' && !showDot) continue;
            if (!re.test(nme)) continue;
            const p = b + (b === '' || b.endsWith('/') ? '' : '/') + nme;
            if (ci < list.length - 1) { if (!this._isDir(VFS.abs(p, this.cwd))) continue; }
            next.push(p);
          }
        }
        bases = next;
        if (!bases.length) break;
      }
      const found = bases.filter((b) => b !== '' ).sort();
      // a pattern ending in "/" matches directories only and keeps the slash
      if (segs.map((x) => x.s).join('').endsWith('/')) return found.filter((p) => this._isDir(VFS.abs(p, this.cwd))).map((p) => p + '/');
      return found;
    }

    /* ------------------------------------------------------------- execution */
    /** Parse and run source text. Returns exit status. */
    async execSource(src, io) {
      let ast;
      try { ast = K.shlex.parse(src, this.interactive || this.sourceDepth ? this.aliases : this.aliases); }
      catch (e) {
        if (e instanceof ParseError) { io.err(this.msgPrefix() + e.message + '\n'); this.status = 1; return 1; }
        throw e;
      }
      return this.execNode(ast, io);
    }

    /** Run source in a context that captures stdout (command substitution). */
    async captureSource(src, io) {
      let buf = '';
      const sub = { stdin: io ? io.stdin : null, out: (s) => { if (buf.length < MAX_CAPTURE) buf += s; }, err: io ? io.err : () => {}, outTTY: false, errTTY: io ? io.errTTY : false, sig: io ? io.sig : this.term.signal };
      const saveCwd = this.cwd;
      await this.execSource(src, sub);
      this.cwd = saveCwd;
      return buf;
    }

    /** Run a line and capture everything (used by tests and tooling). */
    async capture(line, o) {
      o = o || {};
      let out = ''; let err = ''; let all = '';
      const io = {
        stdin: o.stdin == null ? null : o.stdin,
        out: (s) => { out += s; all += s; }, err: (s) => { err += s; all += s; },
        outTTY: !!o.tty, errTTY: !!o.tty, sig: this.term.signal,
      };
      this.term.signal.reset();
      let code;
      try { code = await this.execSource(line, io); }
      catch (e) {
        if (e instanceof K.ExitSignal) code = e.code;
        else if (e instanceof K.Interrupt) code = 130;
        else throw e;
      }
      return { code, out, err, output: all };
    }

    ttyIO() {
      const t = this.term;
      return { stdin: null, out: (s) => t.write(s), err: (s) => t.write(s), outTTY: true, errTTY: true, sig: t.signal };
    }

    async execNode(node, io) {
      if (io.sig && io.sig.aborted) throw new K.Interrupt();
      switch (node.type) {
        case 'list': {
          let st = this.status;
          for (const it of node.items) {
            if (it.bg) st = this.startJob(it.node, io);
            else st = await this.execNode(it.node, io);
            this.status = st;
          }
          return st;
        }
        case 'andor': {
          let st = await this.execNode(node.first, io);
          this.status = st;
          for (const r of node.rest) {
            if ((r.op === '&&') === (st === 0)) { st = await this.execNode(r.node, io); this.status = st; }
          }
          return st;
        }
        case 'pipeline': return this.execPipeline(node, io);
        case 'simple': return this.execSimple(node, io);
        case 'funcdef': this.functions.set(node.name, node.body); return 0;
        case 'if': case 'for': case 'while': case 'case': case 'group': return this.execCompound(node, io);
      }
      throw new Error('unknown node type ' + node.type);
    }

    async execPipeline(node, io) {
      let stdin = io.stdin; let st = 0;
      const n = node.cmds.length;
      for (let i = 0; i < n; i++) {
        const last = i === n - 1;
        const cmd = node.cmds[i];
        if (last) { st = await this.execNode(cmd, Object.assign({}, io, { stdin })); break; }
        let buf = ''; let overflow = false;
        const sink = (s) => { if (buf.length < MAX_CAPTURE) buf += s; else overflow = true; };
        const sub = Object.assign({}, io, { stdin, out: sink, outTTY: false });
        if (cmd.pipeErr) { sub.err = sink; sub.errTTY = false; }
        await this.execNode(cmd, sub);
        void overflow;
        stdin = buf;
      }
      if (node.neg) st = st === 0 ? 1 : 0;
      this.status = st;
      return st;
    }

    /** Apply redirections; returns {io, error} */
    async applyRedirs(redirs, io) {
      if (!redirs || !redirs.length) return { io };
      const nio = Object.assign({}, io);
      const fsv = this.fs;
      const fileSink = (path) => (s) => { try { fsv.append(path, s); } catch (e) { /* ignore */ } };
      for (const r of redirs) {
        if (r.dup != null) {
          if (r.op === '>&') {
            if (r.dup === '-') { if (r.fd === 2) nio.err = () => {}; else nio.out = () => {}; continue; }
            const src = r.dup === '1' ? { f: nio.out, t: nio.outTTY } : r.dup === '2' ? { f: nio.err, t: nio.errTTY } : null;
            if (!src) return { error: this.msgPrefix() + r.dup + ': bad file descriptor' };
            if (r.fd === 2) { nio.err = src.f; nio.errTTY = src.t; } else { nio.out = src.f; nio.outTTY = src.t; }
          }
          continue;
        }
        if (r.heredoc) {
          let body = r.heredoc.body;
          if (!r.heredoc.quoted) body = (await this.expandString(body.replace(/\\([$`\\])/g, '\u0000$1'), io)).map((x) => x.s).join('').replace(/\u0000\$/g, '$').replace(/\u0000/g, '');
          nio.stdin = body; continue;
        }
        const target = await this.expandSingle(r.word, io);
        if (r.op === '<<<') { nio.stdin = target + '\n'; continue; }
        if (r.op === '<') {
          try { nio.stdin = fsv.read(target); }
          catch (e) { return { error: this.msgPrefix() + this.fsMsg(e) + ': ' + target }; }
          continue;
        }
        // output redirections
        const append = r.op === '>>' || r.op === '&>>';
        try {
          let st = null;
          try { st = fsv.stat(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (st && st.isDir) throw new K.FsError('EISDIR', target);
          if (!append || !st) fsv.write(target, append && st ? fsv.read(target) : '');
          else if (!fsv.can(target, 'w')) throw new K.FsError('EACCES', target);
        } catch (e) {
          if (!(e instanceof K.FsError)) throw e;
          return { error: this.msgPrefix() + this.fsMsg(e) + ': ' + target };
        }
        const sink = fileSink(target);
        if (r.op === '&>' || r.op === '&>>') { nio.out = sink; nio.err = sink; nio.outTTY = nio.errTTY = false; }
        else if (r.fd === 2) { nio.err = sink; nio.errTTY = false; }
        else { nio.out = sink; nio.outTTY = false; }
      }
      return { io: nio };
    }

    fsMsg(e) {
      const m = (e && e.message) || 'error';
      return this.flavor === 'zsh' ? m.charAt(0).toLowerCase() + m.slice(1) : m;
    }

    async execCompound(node, io) {
      const r = await this.applyRedirs(node.redirs, io);
      if (r.error) { io.err(r.error + '\n'); return 1; }
      io = r.io;
      switch (node.type) {
        case 'group': {
          if (!node.subshell) return this.execNode(node.body, io);
          const child = this.fork();
          try { return await child.execNode(node.body, io); }
          catch (e) { if (e instanceof K.ExitSignal) return e.code; throw e; }
          finally { child.dispose(); }
        }
        case 'if': {
          for (const c of node.clauses) {
            const st = await this.execNode(c.cond, io);
            if (st === 0) return this.execNode(c.body, io);
          }
          if (node.otherwise) return this.execNode(node.otherwise, io);
          return 0;
        }
        case 'for': {
          let items = [];
          if (node.words) for (const w of node.words) items.push.apply(items, await this.expandWord(w, io));
          else items = this.positional.slice();
          let st = 0;
          this.loopDepth++;
          try {
            for (const it of items) {
              this.setVar(node.name, it);
              try { st = await this.execNode(node.body, io); }
              catch (e) {
                if (e instanceof BreakSignal) { if (e.n > 1) { e.n--; throw e; } break; }
                if (e instanceof ContinueSignal) { if (e.n > 1) { e.n--; throw e; } continue; }
                throw e;
              }
            }
          } finally { this.loopDepth--; }
          return st;
        }
        case 'while': {
          let st = 0; let guard = 0;
          this.loopDepth++;
          try {
            for (;;) {
              if (io.sig && io.sig.aborted) throw new K.Interrupt();
              const c = await this.execNode(node.cond, io);
              if ((c === 0) === node.until) break;
              try { st = await this.execNode(node.body, io); }
              catch (e) {
                if (e instanceof BreakSignal) { if (e.n > 1) { e.n--; throw e; } break; }
                if (e instanceof ContinueSignal) { if (e.n > 1) { e.n--; throw e; } continue; }
                throw e;
              }
              // let the event loop breathe so Ctrl-C can land in tight loops
              if (++guard % 200 === 0) await new Promise((res) => setTimeout(res, 0));
              if (guard > 1000000) { io.err(this.msgPrefix() + 'loop aborted after 1000000 iterations (simulator limit)\n'); return 1; }
            }
          } finally { this.loopDepth--; }
          return st;
        }
        case 'case': {
          const val = await this.expandSingle(node.word, io);
          for (const item of node.items) {
            for (const pw of item.patterns) {
              const pat = await this.expandSingle(pw, io);
              if (K.util.globToRe(pat).test(val)) return this.execNode(item.body, io);
            }
          }
          return 0;
        }
      }
      return 0;
    }

    fork() {
      const c = new Shell({ machine: this.machine, term: this.term, parent: this, user: this.user.name, flavor: this.flavor, cwd: this.cwd, env: {}, tty: this.tty });
      for (const [k, v] of this.vars) c.vars.set(k, v);
      c.exported = new Set(this.exported);
      c.aliases = new Map(this.aliases);
      c.functions = new Map(this.functions);
      c.positional = this.positional.slice();
      c.scriptName = this.scriptName;
      return c;
    }

    /** Child shell that inherits only the exported environment (scripts, bash -c, sudo). */
    child(o) {
      o = o || {};
      const env = o.env || this.env();
      return new Shell({
        machine: o.machine || this.machine, term: this.term, parent: this, user: o.user || this.user.name,
        flavor: o.flavor || this.flavor, cwd: o.cwd || this.cwd, env, interactive: !!o.interactive, login: !!o.login,
      });
    }

    async execSimple(node, io) {
      // expand command words
      let argv = [];
      try {
        for (const w of node.words) argv.push.apply(argv, await this.expandWord(w, io));
      } catch (e) {
        if (e instanceof ShellError) { io.err(e.message + '\n'); this.status = 1; return 1; }
        throw e;
      }
      const assigns = [];
      try {
        for (const a of node.assigns) {
          let v = await this.expandSingle(a.word, io);
          if (a.append) v = (this.getVar(a.name) || '') + v;
          assigns.push([a.name, v]);
        }
      } catch (e) {
        if (e instanceof ShellError) { io.err(e.message + '\n'); this.status = 1; return 1; }
        throw e;
      }
      const r = await this.applyRedirs(node.redirs, io);
      if (r.error) { io.err(r.error + '\n'); this.status = 1; return 1; }
      const cio = r.io;
      if (!argv.length) {
        for (const [k, v] of assigns) this.setVar(k, v, this.exported.has(k));
        return node.assigns.length ? 0 : this.status;
      }
      if (this.opts.xtrace) cio.err('+ ' + argv.join(' ') + '\n');
      // temporary environment for this command only
      const saved = [];
      for (const [k, v] of assigns) { saved.push([k, this.vars.has(k) ? this.vars.get(k) : null, this.exported.has(k)]); this.setVar(k, v, true); }
      let st;
      try { st = await this.execArgv(argv, cio); }
      finally {
        for (const [k, v, ex] of saved) { if (v == null) this.unsetVar(k); else { this.vars.set(k, v); if (!ex) this.exported.delete(k); } }
      }
      this.status = st;
      this.rootShell._trace.push({ argv, code: st, user: this.user.name, host: this.machine.hostname });
      return st;
    }

    /** Run an argv (already expanded). opts: {external:true} skips functions and builtins. */
    async execArgv(argv, io, opts) {
      opts = opts || {};
      const name = argv[0];
      if (io.sig && io.sig.aborted) throw new K.Interrupt();
      if (!opts.external) {
        if (this.functions.has(name)) return this.callFunction(name, argv.slice(1), io);
        const b = BUILTINS[name];
        if (b) {
          try { const st = await b.call(this, this.makeCtx(argv, io)); return st == null ? 0 : st | 0; }
          catch (e) { if (e instanceof K.FsError) { io.err(name + ': ' + this.fsMsg(e) + (e.path ? ': ' + e.path : '') + '\n'); return 1; } throw e; }
        }
      }
      return this.execExternal(argv, io);
    }

    async callFunction(name, args, io) {
      const body = this.functions.get(name);
      const savedPos = this.positional;
      this.positional = args;
      this.funcDepth++;
      this.localStack.push([]);
      if (this.funcDepth > 200) { this.funcDepth--; this.localStack.pop(); this.positional = savedPos; io.err(this.msgPrefix() + 'maximum nested function level reached\n'); return 1; }
      try { return await this.execNode(body, io); }
      catch (e) { if (e instanceof ReturnSignal) return e.code; throw e; }
      finally {
        for (const [k, v, ex] of this.localStack.pop().reverse()) { if (v == null) this.unsetVar(k); else { this.vars.set(k, v); if (ex) this.exported.add(k); } }
        this.funcDepth--; this.positional = savedPos;
      }
    }

    /** Find an executable by name using $PATH; returns absolute path or null. */
    which(name) {
      if (name.indexOf('/') >= 0) return null;
      const path = this.getVar('PATH') || '';
      for (const dir of path.split(':')) {
        if (!dir) continue;
        const p = VFS.abs(dir + '/' + name, this.cwd);
        try {
          const st = this.machine.vfs.stat(p, { cred: this.cred });
          if (st.isFile && this.machine.vfs.access(this.machine.vfs.lookup(p), this.cred, 'x')) return p;
        } catch (e) { /* keep looking */ }
      }
      return null;
    }

    notFound(name, io) {
      if (this.machine.profile === 'kali') {
        const at = K.atlas.get(name);
        const def = K.cmd.get(name);
        if (at || def) {
          io.err("Command '" + name + "' not found, but can be installed with:\nsudo apt install " + ((at && at.pkg) || (def && def.pkg) || name) + '\n');
          return 127;
        }
        let best = null; let bd = 3;
        for (const n of K.cmd.names()) {
          if (Math.abs(n.length - name.length) > 1 || name.length < 3) continue;
          const d = editDistance(n, name);
          if (d < bd && d <= 1) { bd = d; best = n; }
        }
        if (best) {
          const d = K.cmd.get(best);
          io.err("Command '" + name + "' not found, did you mean:\n  command '" + best + "' from deb " + (d.pkg || best) + '\nTry: sudo apt install <deb name>\n');
          return 127;
        }
      }
      io.err(this.flavor === 'zsh' ? 'zsh: command not found: ' + name + '\n' : this.flavor + ': ' + name + ': command not found\n');
      return 127;
    }

    async execExternal(argv, io) {
      const name = argv[0];
      let path;
      const vfs = this.machine.vfs;
      if (name.indexOf('/') >= 0) {
        path = VFS.abs(name, this.cwd);
        let st;
        try { st = vfs.stat(path, { cred: this.cred }); }
        catch (e) { io.err(this.msgPrefix() + (this.flavor === 'zsh' ? this.fsMsg(e) + ': ' + name : name + ': ' + e.message) + '\n'); return e.code === 'EACCES' ? 126 : 127; }
        if (st.isDir) {
          if (this.flavor === 'zsh' && argv.length === 1 && this.interactive) return BUILTINS.cd.call(this, this.makeCtx(['cd', name], io));
          io.err(this.msgPrefix() + (this.flavor === 'zsh' ? 'permission denied: ' + name : name + ': Is a directory') + '\n'); return 126;
        }
        if (!vfs.access(vfs.lookup(path), this.cred, 'x')) {
          io.err(this.msgPrefix() + (this.flavor === 'zsh' ? 'permission denied: ' + name : name + ': Permission denied') + '\n'); return 126;
        }
      } else {
        path = this.which(name);
        if (!path) {
          if (this.flavor === 'zsh' && this.interactive && argv.length === 1 && this._isDir(VFS.abs(name, this.cwd))) {
            return BUILTINS.cd.call(this, this.makeCtx(['cd', name], io));
          }
          return this.notFound(name, io);
        }
      }
      const def = this.machine.commandAt(path);
      if (def) return this.runDef(def, argv, io);
      // not a simulated binary: treat as a script
      let text;
      try { text = vfs.read(path, { cred: this.cred }); }
      catch (e) { io.err(this.msgPrefix() + this.fsMsg(e) + ': ' + name + '\n'); return 126; }
      if (text.startsWith('\x7fELF')) { io.err(this.msgPrefix() + 'exec format error: ' + name + '\n'); return 126; }
      let interp = 'sh'; let interpArgs = [];
      const m = /^#!\s*(\S+)(?:[ \t]+([^\n]*))?/.exec(text);
      if (m) {
        interp = VFS.basename(m[1]); interpArgs = m[2] ? m[2].trim().split(/\s+/) : [];
        if (interp === 'env' && interpArgs.length) { interp = interpArgs[0]; interpArgs = interpArgs.slice(1); }
      }
      if (interp === 'sh' || interp === 'bash' || interp === 'zsh' || interp === 'dash') {
        return this.runScript(text, [name.indexOf('/') >= 0 ? name : path].concat(argv.slice(1)), io, interp === 'dash' ? 'sh' : interp);
      }
      const idef = K.cmd.get(interp);
      if (idef && this.which(interp)) return this.runDef(idef, [interp].concat(interpArgs, [path], argv.slice(1)), io);
      io.err(this.msgPrefix() + name + ': bad interpreter: ' + (m ? m[1] : interp) + ': no such file or directory\n');
      return 126;
    }

    /** Execute a script's source text in a child shell. argv[0] is the script name. */
    async runScript(text, argv, io, flavor) {
      const child = this.child({ flavor: flavor || 'bash' });
      child.scriptName = argv[0];
      child.positional = argv.slice(1);
      try { return await child.execSource(text, io); }
      catch (e) {
        if (e instanceof K.ExitSignal) return e.code;
        if (e instanceof ReturnSignal) return e.code;
        if (e instanceof BreakSignal || e instanceof ContinueSignal) return 0;
        throw e;
      } finally { child.dispose(); }
    }

    async runDef(def, argv, io) {
      const ctx = this.makeCtx(argv, io);
      const proc = this.machine.spawn({ ppid: this.pid, user: this.user.name, tty: this.tty, cmd: argv.join(' '), stat: 'R' });
      ctx.pid = proc.pid;
      try {
        const st = await def.run(ctx);
        return st == null ? 0 : st | 0;
      } catch (e) {
        if (e instanceof K.Interrupt || e instanceof K.ExitSignal || e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnSignal) throw e;
        if (e instanceof K.FsError) { io.err(ctx.name + ': ' + (e.path ? e.path + ': ' : '') + e.message + '\n'); return 1; }
        io.err(ctx.name + ': simulator error: ' + (e && e.message ? e.message : e) + '\n');
        if (K.debug && typeof console !== 'undefined') console.error(e);
        K.events.emit('sim-error', { cmd: argv, error: e });
        return 70;
      } finally { this.machine.reap(proc.pid); }
    }

    /** Build the context object handed to command implementations. */
    makeCtx(argv, io) {
      const sh = this;
      const sig = io.sig || this.term.signal;
      const ctx = {
        name: VFS.basename(argv[0]), argv, args: argv.slice(1),
        stdin: io.stdin == null ? null : io.stdin,
        out: io.out, err: io.err,
        println(s) { io.out((s == null ? '' : s) + '\n'); },
        eprintln(s) { io.err((s == null ? '' : s) + '\n'); },
        isTTY: !!io.outTTY, errTTY: !!io.errTTY, stdinTTY: io.stdin == null,
        env: sh.env(), cwd: sh.cwd,
        machine: sh.machine, vfs: sh.machine.vfs, net: K.net,
        user: sh.user, isRoot: sh.user.uid === 0,
        fs: sh.fs, shell: sh, term: sh.term, io,
        cols: sh.term.cols || 80, rows: sh.term.rows || 24,
        pid: sh.pid,
        /** absolute path for a possibly-relative one */
        path(p) { return VFS.abs(p, sh.cwd); },
        /** wait `ms` of simulated time; rejects with K.Interrupt on Ctrl-C */
        sleep(ms) {
          if (sig.aborted) return Promise.reject(new K.Interrupt());
          if (K.clock._virtual) { K.clock.advance(ms); return Promise.resolve(); }
          const scaled = Math.max(0, ms * K.settings.timeScale);
          return new Promise((res, rej) => {
            let off = null;
            const t = setTimeout(() => { if (off) off(); res(); }, scaled);
            off = sig.onAbort(() => { clearTimeout(t); off(); rej(new K.Interrupt()); });
          });
        },
        aborted() { return sig.aborted; },
        checkAbort() { if (sig.aborted) throw new K.Interrupt(); },
        /** Read one line of input: from piped stdin when present, otherwise from the terminal. null on EOF. */
        async readLine(prompt, o) {
          if (io.stdin != null) {
            if (io._pos == null) io._pos = 0;
            if (io._pos >= io.stdin.length) return null;
            let j = io.stdin.indexOf('\n', io._pos);
            if (j < 0) j = io.stdin.length;
            const line = io.stdin.slice(io._pos, j);
            io._pos = j + 1;
            return line;
          }
          if (sig.aborted) throw new K.Interrupt();
          return sh.term.readLine(Object.assign({ prompt: prompt || '' }, o));
        },
        /** print "<name>: <msg>" to stderr and return an exit code */
        fail(msg, code) { io.err(ctx.name + ': ' + msg + '\n'); return code == null ? 1 : code; },
        getopt(spec) { return K.getopt(ctx.args, spec); },
        /** run another command line and capture its output: {code, out, err} */
        async run(argvOrLine, o) {
          o = o || {};
          let out = ''; let err = '';
          const sub = { stdin: o.stdin == null ? null : o.stdin, out: (s) => { out += s; }, err: (s) => { err += s; }, outTTY: false, errTTY: false, sig };
          const code = Array.isArray(argvOrLine) ? await sh.execArgv(argvOrLine, sub) : await sh.execSource(argvOrLine, sub);
          return { code, out, err };
        },
      };
      return ctx;
    }

    /* ----------------------------------------------------------- job control */
    startJob(node, io) {
      const sig = new Signal();
      let id = 1;
      while (this.jobs.some((j) => !j.done && j.id === id)) id++;
      const text = nodeText(node);
      const proc = this.machine.spawn({ ppid: this.pid, user: this.user.name, tty: this.tty, cmd: text, stat: 'S' });
      for (const sn of simpleNodes(node)) {
        const argv = sn.words.map((w) => unquoteRaw(w.raw));
        if (argv.length) this.rootShell._trace.push({ argv, code: 0, user: this.user.name, host: this.machine.hostname, background: true });
      }
      const job = { id, pid: proc.pid, text, sig, done: false, code: 0, reported: false };
      const jio = Object.assign({}, io, { sig, stdin: io.stdin == null ? '' : io.stdin });
      const sub = this.fork();
      job.promise = (async () => {
        try { job.code = await sub.execNode(node, jio); }
        catch (e) { job.code = e instanceof K.Interrupt ? 143 : e instanceof K.ExitSignal ? e.code : 1; if (!(e instanceof K.Interrupt) && !(e instanceof K.ExitSignal) && K.debug) console.error(e); }
        job.done = true;
        this.machine.reap(proc.pid);
        sub.dispose();
      })();
      this.jobs.push(job);
      this.lastBgPid = proc.pid;
      if (this.interactive) io.err('[' + id + '] ' + proc.pid + '\n');
      return 0;
    }

    /** Resolve a job spec (%N %+ %% %- %name %?text, or none) to a live job: {job} or {err}. */
    findJob(spec, cmd) {
      const live = this.jobs.filter((j) => !j.done);
      const zsh = this.flavor === 'zsh';
      const pre = zsh ? '' : this.msgPrefix();
      const miss = (s, kind) => (zsh
        ? { err: cmd + ': ' + (kind === 'num' ? 'no such job: ' + s : 'job not found: ' + s) + '\n' }
        : { err: pre + cmd + ': ' + s + (kind === 'amb' ? ': ambiguous job spec' : ': no such job') + '\n' });
      if (spec == null || spec === '' || spec === '%' || spec === '%+' || spec === '%%' || spec === '+') {
        const j = live[live.length - 1];
        return j ? { job: j } : { err: pre + cmd + ': ' + (zsh ? 'no current job' : 'current: no such job') + '\n' };
      }
      let t = spec[0] === '%' ? spec.slice(1) : spec;
      if (t === '-') {
        const j = live[live.length - 2];
        return j ? { job: j } : { err: pre + cmd + ': ' + (zsh ? 'no previous job' : 'previous: no such job') + '\n' };
      }
      if (/^\d+$/.test(t)) {
        const j = live.find((x) => x.id === parseInt(t, 10));
        return j ? { job: j } : miss(zsh ? t : spec, 'num');
      }
      const sub = t[0] === '?';
      if (sub) t = t.slice(1);
      const m = live.filter((j) => (sub ? j.text.indexOf(t) >= 0 : j.text.startsWith(t)));
      if (!m.length) return miss(zsh ? t : spec, 'name');
      if (m.length > 1 && !zsh) return miss(spec, 'amb');
      return { job: m[m.length - 1] };
    }

    reportJobs(io) {
      for (const j of this.jobs.slice()) {
        if (j.done && !j.reported) {
          j.reported = true;
          const state = j.code === 0 ? 'done' : j.code === 143 ? 'terminated' : 'exit ' + j.code;
          if (this.interactive) io.err('[' + j.id + ']  + ' + K.util.padEnd(state, 10) + ' ' + j.text + '\n');
          this.jobs.splice(this.jobs.indexOf(j), 1);
        }
      }
    }

    /* ------------------------------------------------------------ interactive */
    async init() {
      if (!this.interactive) return this;
      const rc = this.flavor === 'zsh' ? '.zshrc' : this.flavor === 'bash' ? '.bashrc' : null;
      if (rc) {
        const p = this.user.home + '/' + rc;
        let text = null;
        try { text = this.fs.read(p); } catch (e) { /* no rc file */ }
        if (text != null) {
          const io = { stdin: '', out: () => {}, err: () => {}, outTTY: false, errTTY: false, sig: new Signal() };
          this.sourceDepth++;
          try { await this.execSource(text, io); }
          catch (e) { if (!(e instanceof ReturnSignal) && !(e instanceof K.ExitSignal) && K.debug) console.error(e); }
          this.sourceDepth--;
          this.status = 0;
        }
      }
      // load history
      try {
        const hf = this.fs.read(this.user.home + (this.flavor === 'zsh' ? '/.zsh_history' : '/.bash_history'));
        this.history = K.util.lines(hf).map((l) => l.replace(/^: \d+:\d+;/, ''));
      } catch (e) { /* none */ }
      return this;
    }

    prompt() {
      const u = this.user.name; const h = this.machine.hostname; const isRoot = this.user.uid === 0;
      let p = this.cwd;
      const home = this.user.home;
      if (p === home) p = '~'; else if (home !== '/' && p.indexOf(home + '/') === 0) p = '~' + p.slice(home.length);
      if (this.machine.profile === 'kali') {
        const frame = isRoot ? '34' : '32'; const nameCol = isRoot ? '1;31' : '1;34';
        const sym = isRoot ? '\ud83d\udc80' : '\u327f';
        return '\x1b[' + frame + 'm\u250c\u2500\u2500(\x1b[' + nameCol + 'm' + u + sym + h + '\x1b[0;' + frame + 'm)-[\x1b[0;1m' + p +
          '\x1b[0;' + frame + 'm]\n\u2514\u2500\x1b[' + nameCol + 'm' + (isRoot ? '#' : '$') + '\x1b[0m ';
      }
      return '\x1b[1;32m' + u + '@' + h + '\x1b[0m:\x1b[1;34m' + p + '\x1b[0m' + (isRoot ? '# ' : '$ ');
    }

    histExpand(line) {
      if (line.indexOf('!') < 0 || !this.history.length) return line;
      const last = this.history[this.history.length - 1];
      let out = ''; let q = null; let changed = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q === "'") { out += c; if (c === "'") q = null; continue; }
        if (c === '\\') { out += c + (line[i + 1] || ''); i++; continue; }
        if (c === "'") { q = "'"; out += c; continue; }
        if (c === '!' && line[i + 1] === '!') { out += last; i++; changed = true; continue; }
        if (c === '!' && line[i + 1] === '$') { const w = last.trim().split(/\s+/); out += w[w.length - 1]; i++; changed = true; continue; }
        out += c;
      }
      return changed ? out : line;
    }

    addHistory(line) {
      if (!line.trim()) return;
      if (this.history[this.history.length - 1] === line) return;
      this.history.push(line);
      if (this.history.length > 2000) this.history.shift();
      try {
        const hf = this.user.home + (this.flavor === 'zsh' ? '/.zsh_history' : '/.bash_history');
        const entry = this.flavor === 'zsh' ? ': ' + Math.floor(K.clock.now() / 1000) + ':0;' + line + '\n' : line + '\n';
        this.fs.append(hf, entry);
      } catch (e) { /* history file not writable */ }
    }

    /**
     * Run one interactive line: history expansion, execution on the terminal,
     * job reports, and the 'command' event used by the lesson engine.
     * Returns the exit status. Throws K.ExitSignal when the shell should end.
     */
    async runLine(line) {
      const io = this.ttyIO();
      const expanded = this.histExpand(line);
      if (expanded !== line) { io.out(expanded + '\n'); line = expanded; }
      this.addHistory(line);
      this.term.signal.reset();
      this.rootShell._trace = [];
      let captured = '';
      const tee = (f) => (s) => { if (captured.length < 262144) captured += s; f(s); };
      io.out = tee(io.out); io.err = tee(io.err);
      let code = 0; let exit = null;
      try { code = await this.execSource(line, io); }
      catch (e) {
        if (e instanceof K.Interrupt) { code = 130; io.out('\n'); }
        else if (e instanceof K.ExitSignal) { exit = e; code = e.code; }
        else if (e instanceof BreakSignal || e instanceof ContinueSignal) code = 0;
        else if (e instanceof ReturnSignal) code = e.code;
        else if (e instanceof ShellError) { io.err(e.message + '\n'); code = 1; }
        else { io.err(this.msgPrefix() + 'simulator error: ' + (e && e.message) + '\n'); code = 70; if (K.debug) console.error(e); }
      }
      this.status = code;
      this.term.signal.reset();
      K.events.emit('command', {
        line, code, output: captured, commands: this.rootShell._trace.slice(), cwd: this.cwd,
        user: this.user.name, host: this.machine.hostname, shell: this,
      });
      this.reportJobs(io);
      if (exit) throw exit;
      return code;
    }

    /** Interactive read-eval loop. Resolves with the exit status when the shell ends. */
    async repl() {
      if (!this._inited) { this._inited = true; await this.init(); }
      for (;;) {
        let line;
        try {
          line = await this.term.readLine({ prompt: this.prompt(), history: this.history, complete: (l, pos) => this.complete(l, pos) });
        } catch (e) {
          if (e instanceof K.Interrupt) { this.status = 130; continue; }
          throw e;
        }
        if (line == null) { this.term.write(this.flavor === 'zsh' ? '' : 'exit\n'); return this.status; }
        // continuation lines for incomplete input
        for (;;) {
          try { K.shlex.parse(this.histExpand(line), this.aliases); break; }
          catch (e) {
            if (!(e instanceof ParseError) || !e.incomplete) break;
            let more;
            try { more = await this.term.readLine({ prompt: '> ', history: [], continuation: true }); }
            catch (e2) { if (e2 instanceof K.Interrupt) { line = ''; break; } throw e2; }
            if (more == null) break;
            line += '\n' + more;
          }
        }
        if (!line.trim()) { this.reportJobs(this.ttyIO()); continue; }
        try { await this.runLine(line); }
        catch (e) {
          if (e instanceof K.ExitSignal) return e.code;
          throw e;
        }
      }
    }

    /**
     * Tab completion. Returns { from, to, items: [{text, display, dir}] } where
     * line.slice(from, to) is the word being completed.
     */
    complete(line, pos) {
      pos = pos == null ? line.length : pos;
      const before = line.slice(0, pos);
      // find the start of the current word (unescaped whitespace or operator)
      let start = before.length;
      while (start > 0) {
        const c = before[start - 1];
        if ((c === ' ' || c === '\t' || c === '|' || c === ';' || c === '&' || c === '<' || c === '>' || c === '(') && before[start - 2] !== '\\') break;
        start--;
      }
      const cur = before.slice(start).replace(/\\(.)/g, '$1');
      const head = before.slice(0, start);
      const segStart = Math.max(head.lastIndexOf('|'), head.lastIndexOf(';'), head.lastIndexOf('&'), head.lastIndexOf('(')) + 1;
      const words = head.slice(segStart).trim().split(/\s+/).filter(Boolean);
      let cmdPos = words.length === 0;
      let cmdWord = words[0];
      if (words.length === 1 && /^(sudo|time|command|exec|nohup|watch|man|which|type|whatis)$/.test(words[0]) && !/[<>]\s*$/.test(head)) cmdPos = true;
      if (words.length >= 2 && words[0] === 'sudo') cmdWord = words[1];
      if (/[<>]\s*$/.test(head)) cmdPos = false;
      const esc = (s) => s.replace(/([ \t'"\\$`!&|;()<>*?\[\]#~])/g, '\\$1');
      const items = [];
      const seen = new Set();
      const add = (text, dir) => { if (seen.has(text)) return; seen.add(text); items.push({ text: esc(text) + (dir ? '/' : ''), display: text + (dir ? '/' : ''), dir: !!dir }); };
      if (cur[0] === '$' && cur.indexOf('/') < 0) {
        const pre = cur.slice(1).replace(/^\{/, '');
        for (const k of Array.from(this.vars.keys()).sort()) if (k.startsWith(pre)) add('$' + k, false);
        items.forEach((it) => { it.text = it.display; });
        return { from: start, to: pos, items };
      }
      if (cmdPos && cur.indexOf('/') < 0) {
        const names = new Set();
        for (const b of Object.keys(BUILTINS)) names.add(b);
        for (const a of this.aliases.keys()) names.add(a);
        for (const f of this.functions.keys()) names.add(f);
        for (const dir of (this.getVar('PATH') || '').split(':')) {
          try { for (const n of this.machine.vfs.readdir(VFS.abs(dir, this.cwd), { cred: this.cred })) names.add(n); } catch (e) { /* skip */ }
        }
        for (const n of Array.from(names).sort()) if (n.startsWith(cur) && n !== '[' && n !== ':' && n !== '.') add(n, false);
        if (items.length) return { from: start, to: pos, items };
      }
      // command-specific completion
      const def = cmdWord && K.cmd.get(this.aliases.has(cmdWord) ? this.aliases.get(cmdWord).split(/\s+/)[0] : cmdWord);
      if (!cmdPos && def && typeof def.complete === 'function') {
        let res = null;
        try { res = def.complete({ words: words.concat([cur]), index: words.length, cur, shell: this, machine: this.machine }); } catch (e) { res = null; }
        if (res && res.length) {
          for (const r of res) if (String(r).startsWith(cur)) add(String(r), false);
          if (items.length) return { from: start, to: pos, items };
        }
      }
      // path completion
      let dirPart = ''; let base = cur;
      const slash = cur.lastIndexOf('/');
      if (slash >= 0) { dirPart = cur.slice(0, slash + 1); base = cur.slice(slash + 1); }
      let dirPath = dirPart;
      if (/^~[^/]*\//.test(dirPart) || dirPart === '~/') {
        const m = /^~([^/]*)\//.exec(dirPart);
        const home = m[1] ? (this.machine.userByName(m[1]) || {}).home : this.user.home;
        if (home) dirPath = home + '/' + dirPart.slice(m[0].length);
      }
      let names = [];
      try { names = this.machine.vfs.readdir(VFS.abs(dirPath || '.', this.cwd), { cred: this.cred }); } catch (e) { names = []; }
      const onlyDirs = cmdWord === 'cd' || cmdWord === 'rmdir' || cmdWord === 'pushd';
      for (const n of names) {
        if (!n.startsWith(base)) continue;
        if (n[0] === '.' && base[0] !== '.') continue;
        const isDir = this._isDir(VFS.abs((dirPath || '') + n, this.cwd));
        if (onlyDirs && !isDir) continue;
        if (seen.has(dirPart + n)) continue;
        seen.add(dirPart + n);
        items.push({ text: esc(dirPart).replace(/^\\~/, '~') + esc(n) + (isDir ? '/' : ''), display: n + (isDir ? '/' : ''), dir: isDir });
      }
      return { from: start, to: pos, items };
    }
  }

  class ShellError extends Error {}
  K.ShellError = ShellError;

  function simpleNodes(node) {
    switch (node.type) {
      case 'simple': return [node];
      case 'pipeline': return [].concat(...node.cmds.map(simpleNodes));
      case 'andor': return simpleNodes(node.first).concat(...node.rest.map((r) => simpleNodes(r.node)));
      case 'list': return [].concat(...node.items.map((i) => simpleNodes(i.node)));
      default: return [];
    }
  }
  function unquoteRaw(r) {
    return String(r).replace(/'([^']*)'|"([^"]*)"|\\(.)/g, (m, a, b, c) => (a != null ? a : b != null ? b : c));
  }

  function nodeText(node) {
    const w = (t) => t.raw;
    switch (node.type) {
      case 'simple': return node.assigns.map((a) => a.word.raw).concat(node.words.map(w)).join(' ');
      case 'pipeline': return (node.neg ? '! ' : '') + node.cmds.map(nodeText).join(' | ');
      case 'andor': return [nodeText(node.first)].concat(node.rest.map((r) => r.op + ' ' + nodeText(r.node))).join(' ');
      case 'list': return node.items.map((i) => nodeText(i.node)).join('; ');
      default: return node.type;
    }
  }

  /* ---------------------------------------------------------------- builtins */
  function testExpr(sh, a) {
    // POSIX test: recursive descent over an argv array
    let p = 0;
    const fs = sh.fs;
    const stat = (f) => { try { return fs.stat(f); } catch (e) { return null; } };
    const lstat = (f) => { try { return fs.lstat(f); } catch (e) { return null; } };
    const num = (s) => { const v = parseInt(s, 10); if (isNaN(v)) throw new Error('integer expression expected: ' + s); return v; };
    function primary() {
      const t = a[p];
      if (t === undefined) throw new Error('argument expected');
      if (t === '!') { p++; return !primary(); }
      if (t === '(') { p++; const v = or(); if (a[p] !== ')') throw new Error("')' expected"); p++; return v; }
      const bin = a[p + 1];
      if (bin !== undefined && a[p + 2] !== undefined && /^(=|==|!=|=~|<|>|-eq|-ne|-lt|-le|-gt|-ge|-nt|-ot|-ef)$/.test(bin)) {
        const l = t; const r = a[p + 2]; p += 3;
        switch (bin) {
          case '=': case '==': return sh._dbl ? K.util.globToRe(r).test(l) : l === r;
          case '!=': return sh._dbl ? !K.util.globToRe(r).test(l) : l !== r;
          case '=~': try { return new RegExp(r).test(l); } catch (e) { return false; }
          case '<': return l < r; case '>': return l > r;
          case '-eq': return num(l) === num(r); case '-ne': return num(l) !== num(r);
          case '-lt': return num(l) < num(r); case '-le': return num(l) <= num(r);
          case '-gt': return num(l) > num(r); case '-ge': return num(l) >= num(r);
          case '-nt': { const x = stat(l); const y = stat(r); return !!x && (!y || x.mtime > y.mtime); }
          case '-ot': { const x = stat(l); const y = stat(r); return !!y && (!x || x.mtime < y.mtime); }
          case '-ef': { const x = stat(l); const y = stat(r); return !!x && !!y && x.ino === y.ino; }
        }
      }
      if (/^-[a-zA-Z]$/.test(t) && a[p + 1] !== undefined && a[p + 1] !== '-a' && a[p + 1] !== '-o') {
        const f = a[p + 1]; p += 2;
        const st = t === '-L' || t === '-h' ? lstat(f) : stat(f);
        switch (t) {
          case '-e': return !!st; case '-f': return !!st && st.isFile; case '-d': return !!st && st.isDir;
          case '-L': case '-h': return !!st && st.isLink; case '-s': return !!st && st.size > 0;
          case '-r': return fs.can(f, 'r'); case '-w': return fs.can(f, 'w'); case '-x': return fs.can(f, 'x');
          case '-z': return f === ''; case '-n': return f !== '';
          case '-b': return false; case '-c': return !!st && st.isDev; case '-p': case '-S': return false;
          case '-u': return !!st && (st.mode & 0o4000) !== 0; case '-g': return !!st && (st.mode & 0o2000) !== 0;
          case '-k': return !!st && (st.mode & 0o1000) !== 0; case '-O': return !!st && st.uid === sh.user.uid;
          case '-G': return !!st && st.gid === sh.user.gid; case '-t': return f === '0' || f === '1' || f === '2';
          case '-v': return sh.vars.has(f);
          default: throw new Error('unknown condition: ' + t);
        }
      }
      p++;
      return t !== '';
    }
    function and() { let v = primary(); while (a[p] === '-a' || a[p] === '&&') { p++; const r = primary(); v = v && r; } return v; }
    function or() { let v = and(); while (a[p] === '-o' || a[p] === '||') { p++; const r = and(); v = v || r; } return v; }
    if (!a.length) return false;
    const v = or();
    if (p < a.length) throw new Error('too many arguments');
    return v;
  }

  const BUILTINS = {
    ':': () => 0,
    true: () => 0,
    false: () => 1,
    cd(ctx) {
      const sh = this; let target = ctx.args.filter((a) => a !== '--' && a !== '-P' && a !== '-L')[0];
      let print = false;
      if (target == null) target = sh.getVar('HOME') || '/';
      else if (target === '-') { target = sh.getVar('OLDPWD') || sh.cwd; print = true; }
      const abs = VFS.abs(target, sh.cwd);
      let st;
      try { st = sh.machine.vfs.stat(abs, { cred: sh.cred }); }
      catch (e) { ctx.err('cd: ' + sh.fsMsg(e) + ': ' + target + '\n'); return 1; }
      if (!st.isDir) { ctx.err('cd: not a directory: ' + target + '\n'); return 1; }
      if (!sh.machine.vfs.access(sh.machine.vfs.lookup(abs), sh.cred, 'x')) { ctx.err('cd: permission denied: ' + target + '\n'); return 1; }
      sh.setVar('OLDPWD', sh.cwd, true);
      sh.cwd = abs;
      sh.setVar('PWD', abs, true);
      if (print) ctx.out((abs === sh.user.home ? '~' : abs) + '\n');
      return 0;
    },
    pwd(ctx) { ctx.out(this.cwd + '\n'); return 0; },
    echo(ctx) {
      const a = ctx.args.slice(); let nl = true; let esc = this.flavor === 'zsh' || this.flavor === 'sh';
      while (a.length && /^-[neE]+$/.test(a[0])) {
        for (const c of a[0].slice(1)) { if (c === 'n') nl = false; else if (c === 'e') esc = true; else if (c === 'E') esc = false; }
        a.shift();
      }
      let s = a.join(' ');
      if (esc) { const r = echoEscapes(s); s = r.s; if (r.stop) nl = false; }
      ctx.out(s + (nl ? '\n' : ''));
      return 0;
    },
    printf(ctx) {
      const a = ctx.args.slice();
      if (a[0] === '--') a.shift();
      if (!a.length) { ctx.err('printf: not enough arguments\n'); return 1; }
      ctx.out(formatPrintf(a[0], a.slice(1)));
      return 0;
    },
    export(ctx) {
      const sh = this; const a = ctx.args.filter((x) => x !== '-p');
      if (!a.length) {
        for (const k of Array.from(sh.exported).sort()) if (sh.vars.has(k)) ctx.out((sh.flavor === 'bash' ? 'declare -x ' + k + '="' + sh.vars.get(k) + '"' : k + '=' + sh.vars.get(k)) + '\n');
        return 0;
      }
      let st = 0;
      for (const arg of a) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=([\s\S]*))?$/.exec(arg);
        if (!m) { ctx.err('export: not valid in this context: ' + arg + '\n'); st = 1; continue; }
        if (m[2] != null) sh.setVar(m[1], m[2], true);
        else { sh.exported.add(m[1]); }
      }
      return st;
    },
    unset(ctx) { for (const a of ctx.args) { if (a === '-v') continue; if (a === '-f') continue; this.unsetVar(a); this.functions.delete(a); } return 0; },
    set(ctx) {
      const sh = this; const a = ctx.args;
      if (!a.length) { for (const k of Array.from(sh.vars.keys()).sort()) ctx.out(k + '=' + sh.vars.get(k) + '\n'); return 0; }
      for (let i = 0; i < a.length; i++) {
        if (a[i] === '--') { sh.positional = a.slice(i + 1); break; }
        if (/^[-+][a-zA-Z]+$/.test(a[i])) {
          if (a[i].includes('x')) sh.opts.xtrace = a[i][0] === '-';
          if (a[i].includes('o')) i++;
          continue;
        }
        sh.positional = a.slice(i); break;
      }
      return 0;
    },
    setopt() { return 0; }, unsetopt() { return 0; }, shopt() { return 0; }, autoload() { return 0; }, compinit() { return 0; },
    bindkey() { return 0; }, zstyle() { return 0; }, ulimit(ctx) { ctx.out('unlimited\n'); return 0; }, disown() { return 0; }, hash() { return 0; },
    local(ctx) {
      const sh = this;
      if (!sh.funcDepth) { ctx.err('local: can only be used in a function\n'); return 1; }
      const frame = sh.localStack[sh.localStack.length - 1];
      for (const arg of ctx.args) {
        if (arg[0] === '-') continue;
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=([\s\S]*))?$/.exec(arg);
        if (!m) continue;
        frame.push([m[1], sh.vars.has(m[1]) ? sh.vars.get(m[1]) : null, sh.exported.has(m[1])]);
        sh.setVar(m[1], m[2] == null ? '' : m[2]);
      }
      return 0;
    },
    declare(ctx) {
      const sh = this; let exp = false;
      for (const arg of ctx.args) {
        if (/^-/.test(arg)) { if (arg.includes('x')) exp = true; continue; }
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=([\s\S]*))?$/.exec(arg);
        if (m) sh.setVar(m[1], m[2] == null ? (sh.getVar(m[1]) || '') : m[2], exp);
      }
      return 0;
    },
    typeset(ctx) { return BUILTINS.declare.call(this, ctx); },
    readonly(ctx) { return BUILTINS.declare.call(this, ctx); },
    alias(ctx) {
      const sh = this; let st = 0;
      const q = (v) => (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(v) ? v : "'" + v.replace(/'/g, "'\\''") + "'");
      if (!ctx.args.length) { for (const k of Array.from(sh.aliases.keys()).sort()) ctx.out((sh.flavor === 'bash' ? 'alias ' : '') + k + '=' + q(sh.aliases.get(k)) + '\n'); return 0; }
      for (const arg of ctx.args) {
        const i = arg.indexOf('=');
        if (i > 0) sh.aliases.set(arg.slice(0, i), arg.slice(i + 1));
        else if (sh.aliases.has(arg)) ctx.out((sh.flavor === 'bash' ? 'alias ' : '') + arg + '=' + q(sh.aliases.get(arg)) + '\n');
        else { if (sh.flavor === 'bash') ctx.err('bash: alias: ' + arg + ': not found\n'); st = 1; }
      }
      return st;
    },
    unalias(ctx) {
      let st = 0;
      for (const a of ctx.args) {
        if (a === '-a') { this.aliases.clear(); continue; }
        if (!this.aliases.delete(a)) { ctx.err('unalias: no such hash table element: ' + a + '\n'); st = 1; }
      }
      return st;
    },
    exit(ctx) {
      const code = ctx.args.length ? parseInt(ctx.args[0], 10) || 0 : this.status;
      throw new K.ExitSignal(code & 255);
    },
    logout(ctx) { return BUILTINS.exit.call(this, ctx); },
    return(ctx) { throw new ReturnSignal(ctx.args.length ? (parseInt(ctx.args[0], 10) || 0) & 255 : this.status); },
    break(ctx) { if (!this.loopDepth) { return 0; } throw new BreakSignal(parseInt(ctx.args[0] || '1', 10) || 1); },
    continue(ctx) { if (!this.loopDepth) { return 0; } throw new ContinueSignal(parseInt(ctx.args[0] || '1', 10) || 1); },
    shift(ctx) {
      const n = ctx.args.length ? parseInt(ctx.args[0], 10) || 0 : 1;
      if (n > this.positional.length) { ctx.err('shift: shift count must be <= $#\n'); return 1; }
      this.positional = this.positional.slice(n); return 0;
    },
    history(ctx) {
      const sh = this;
      if (ctx.args[0] === '-c') { sh.history.length = 0; return 0; }
      let n = sh.history.length;
      const arg = ctx.args.find((a) => /^-?\d+$/.test(a));
      if (arg != null) n = Math.abs(parseInt(arg, 10));
      const start = Math.max(0, sh.history.length - n);
      for (let i = start; i < sh.history.length; i++) ctx.out(K.util.padStart(i + 1, 5) + '  ' + sh.history[i] + '\n');
      return 0;
    },
    async source(ctx) {
      const sh = this;
      if (!ctx.args.length) { ctx.err(ctx.name + ': not enough arguments\n'); return 1; }
      let text;
      try { text = sh.fs.read(ctx.args[0]); }
      catch (e) { ctx.err(ctx.name + ': ' + sh.fsMsg(e) + ': ' + ctx.args[0] + '\n'); return 127; }
      const savedPos = sh.positional;
      if (ctx.args.length > 1) sh.positional = ctx.args.slice(1);
      sh.sourceDepth++;
      try { return await sh.execSource(text, ctx.io); }
      catch (e) { if (e instanceof ReturnSignal) return e.code; throw e; }
      finally { sh.sourceDepth--; sh.positional = savedPos; }
    },
    async '.'(ctx) { return BUILTINS.source.call(this, ctx); },
    async eval(ctx) { return this.execSource(ctx.args.join(' '), ctx.io); },
    async command(ctx) {
      const a = ctx.args.slice();
      if (a[0] === '-v' || a[0] === '-V') {
        let st = 1;
        for (const n of a.slice(1)) {
          if (BUILTINS[n] || this.functions.has(n)) { ctx.out(n + '\n'); st = 0; }
          else if (this.aliases.has(n)) { ctx.out("alias " + n + "='" + this.aliases.get(n) + "'\n"); st = 0; }
          else { const p = this.which(n); if (p) { ctx.out(p + '\n'); st = 0; } }
        }
        return st;
      }
      if (!a.length) return 0;
      return this.execArgv(a, ctx.io, { external: !BUILTINS[a[0]] });
    },
    async builtin(ctx) {
      const a = ctx.args;
      if (!a.length) return 0;
      if (!BUILTINS[a[0]]) { ctx.err('builtin: no such builtin: ' + a[0] + '\n'); return 1; }
      return BUILTINS[a[0]].call(this, this.makeCtx(a, ctx.io));
    },
    async exec(ctx) { if (!ctx.args.length) return 0; const st = await this.execArgv(ctx.args, ctx.io); throw new K.ExitSignal(st); },
    type(ctx) {
      const sh = this; let st = 0;
      for (const n of ctx.args) {
        if (n[0] === '-') continue;
        if (sh.aliases.has(n)) ctx.out(n + ' is an alias for ' + sh.aliases.get(n) + '\n');
        else if (K.shlex.RESERVED.has(n)) ctx.out(n + ' is a reserved word\n');
        else if (sh.functions.has(n)) ctx.out(n + ' is a shell function\n');
        else if (BUILTINS[n]) ctx.out(n + ' is a shell builtin\n');
        else {
          const p = sh.which(n);
          if (p) ctx.out(n + ' is ' + p + '\n'); else { ctx.out(n + ' not found\n'); st = 1; }
        }
      }
      return st;
    },
    which(ctx) {
      const sh = this; let st = 0;
      const all = ctx.args.includes('-a');
      for (const n of ctx.args) {
        if (n[0] === '-') continue;
        if (sh.flavor === 'zsh') {
          if (sh.aliases.has(n)) { ctx.out(n + ': aliased to ' + sh.aliases.get(n) + '\n'); if (!all) continue; }
          if (sh.functions.has(n)) { ctx.out(n + ' () {\n\t# shell function\n}\n'); if (!all) continue; }
          if (BUILTINS[n] && n !== 'which') { ctx.out(n + ': shell built-in command\n'); if (!all) continue; }
        }
        const p = sh.which(n);
        if (p) ctx.out(p + '\n');
        else if (!(all && (sh.aliases.has(n) || BUILTINS[n]))) { if (sh.flavor === 'zsh') ctx.out(n + ' not found\n'); st = 1; }
      }
      return st;
    },
    test(ctx) {
      try { return testExpr(this, ctx.args) ? 0 : 1; }
      catch (e) { ctx.err('test: ' + e.message + '\n'); return 2; }
    },
    '['(ctx) {
      const a = ctx.args.slice();
      if (a[a.length - 1] !== ']') { ctx.err("[: ']' expected\n"); return 2; }
      a.pop();
      try { return testExpr(this, a) ? 0 : 1; }
      catch (e) { ctx.err('[: ' + e.message + '\n'); return 2; }
    },
    '[['(ctx) {
      const a = ctx.args.slice();
      if (a[a.length - 1] !== ']]') { ctx.err("[[: ']]' expected\n"); return 2; }
      a.pop();
      this._dbl = true;
      try { return testExpr(this, a) ? 0 : 1; }
      catch (e) { ctx.err('[[: ' + e.message + '\n'); return 2; }
      finally { this._dbl = false; }
    },
    async read(ctx) {
      const sh = this; const a = ctx.args.slice(); let prompt = ''; let hidden = false; const names = [];
      for (let i = 0; i < a.length; i++) {
        if (a[i] === '-p') { prompt = a[++i] || ''; continue; }
        if (a[i] === '-s') { hidden = true; continue; }
        if (a[i] === '-r') continue;
        if (/^-[rs]+$/.test(a[i])) { if (a[i].includes('s')) hidden = true; continue; }
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\?(.*)$/.exec(a[i]); // zsh: read "var?prompt"
        if (m) { names.push(m[1]); prompt = m[2]; continue; }
        names.push(a[i]);
      }
      if (!names.length) names.push('REPLY');
      const line = await ctx.readLine(prompt, { hidden });
      if (line == null) { for (const n of names) sh.setVar(n, ''); return 1; }
      const parts = line.trim().split(/[ \t]+/);
      names.forEach((n, i) => { sh.setVar(n, i === names.length - 1 ? parts.slice(i).join(' ') : parts[i] || ''); });
      return 0;
    },
    umask(ctx) {
      const sh = this;
      if (!ctx.args.length) { ctx.out((sh.flavor === 'zsh' ? '0' : '0') + sh.umask.toString(8).padStart(3, '0').slice(-3).padStart(sh.flavor === 'zsh' ? 2 : 3, '0') + '\n'); return 0; }
      if (ctx.args[0] === '-S') {
        const m = 0o777 & ~sh.umask; const f = (v) => (v & 4 ? 'r' : '') + (v & 2 ? 'w' : '') + (v & 1 ? 'x' : '');
        ctx.out('u=' + f(m >> 6) + ',g=' + f((m >> 3) & 7) + ',o=' + f(m & 7) + '\n'); return 0;
      }
      if (!/^[0-7]{1,4}$/.test(ctx.args[0])) { ctx.err('umask: bad umask\n'); return 1; }
      sh.umask = parseInt(ctx.args[0], 8) & 0o777; return 0;
    },
    jobs(ctx) {
      const live = this.jobs.filter((j) => !j.done);
      for (const j of live) {
        const k = live.length - 1 - live.indexOf(j);
        ctx.out('[' + j.id + ']  ' + (k === 0 ? '+' : k === 1 ? '-' : ' ') + ' running    ' + j.text + '\n');
      }
      return 0;
    },
    async fg(ctx) {
      const sh = this;
      const spec = ctx.args[0];
      const found = sh.findJob(spec, 'fg');
      if (found.err) { ctx.err(found.err); return 1; }
      const job = found.job;
      ctx.out('[' + job.id + ']  + continued  ' + job.text + '\n');
      const off = sh.term.signal.onAbort(() => job.sig.abort());
      await job.promise;
      off();
      job.reported = true;
      sh.jobs.splice(sh.jobs.indexOf(job), 1);
      if (job.code === 143) { sh.term.signal.reset(); return 130; }
      return job.code;
    },
    bg(ctx) { ctx.err('bg: no current job\n'); return 1; },
    async wait() { await Promise.all(this.jobs.map((j) => j.promise)); return 0; },
    kill(ctx) {
      const sh = this; const m = sh.machine; let st = 0; let sigName = 'TERM';
      const a = ctx.args.slice();
      const SIGS = ['HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM', 'STKFLT', 'CHLD', 'CONT', 'STOP', 'TSTP', 'TTIN', 'TTOU'];
      if (a[0] === '-l') { ctx.out(SIGS.join(' ') + '\n'); return 0; }
      if (!a.length) { ctx.err('kill: not enough arguments\n'); return 1; }
      const targets = [];
      for (let i = 0; i < a.length; i++) {
        if (a[i] === '-s') { sigName = String(a[++i] || '').replace(/^SIG/, ''); continue; }
        if (/^-\d+$/.test(a[i])) { sigName = SIGS[parseInt(a[i].slice(1), 10) - 1] || a[i].slice(1); continue; }
        if (/^-[A-Za-z]/.test(a[i])) { sigName = a[i].slice(1).replace(/^SIG/, ''); continue; }
        targets.push(a[i]);
      }
      if (sigName === '0') sigName = 'NULL';
      for (const t of targets) {
        if (t[0] === '%') {
          const found = sh.findJob(t, 'kill');
          if (found.err) { ctx.err(found.err); st = 1; continue; }
          const job = found.job;
          if (sigName !== 'NULL') job.sig.abort();
          continue;
        }
        const pid = parseInt(t, 10);
        if (isNaN(pid)) { ctx.err('kill: illegal pid: ' + t + '\n'); st = 1; continue; }
        const job = sh.rootShell.jobs.find((j) => j.pid === pid && !j.done) || sh.jobs.find((j) => j.pid === pid && !j.done);
        if (job) { if (sigName !== 'NULL') job.sig.abort(); continue; }
        const proc = m.procs.find((p) => p.pid === pid);
        if (!proc) { ctx.err('kill: kill ' + pid + ' failed: no such process\n'); st = 1; continue; }
        if (sh.user.uid !== 0 && proc.user !== sh.user.name) { ctx.err('kill: kill ' + pid + ' failed: operation not permitted\n'); st = 1; continue; }
        if (sigName === 'NULL' || sigName === 'CONT' || sigName === 'CHLD' || sigName === 'USR1' || sigName === 'USR2' || sigName === 'HUP' && proc.unit) continue;
        if (sigName === 'STOP' || sigName === 'TSTP') { proc.stat = 'T'; continue; }
        if (proc.pid === 1) continue;
        m.reap(pid);
        K.events.emit('proc-killed', { machine: m, proc, signal: sigName });
      }
      return st;
    },
    async time(ctx) {
      if (!ctx.args.length) return 0;
      const t0 = K.clock.now();
      const st = await this.execArgv(ctx.args, ctx.io);
      const dt = (K.clock.now() - t0) / 1000;
      if (this.flavor === 'zsh') ctx.err(ctx.args.join(' ') + '  0.00s user 0.00s system 0% cpu ' + dt.toFixed(3) + ' total\n');
      else {
        const f = (v) => Math.floor(v / 60) + 'm' + (v % 60).toFixed(3) + 's';
        ctx.err('\nreal\t' + f(dt) + '\nuser\t0m0.001s\nsys\t0m0.002s\n');
      }
      return st;
    },
    clear(ctx) { if (ctx.isTTY) this.term.clear(); return 0; },
    reset(ctx) { if (ctx.isTTY) this.term.clear(); return 0; },
  };
  K.builtins = BUILTINS;

  /* ----------------------------------------------- shells, sudo, su as commands */
  async function shellCommand(ctx, flavor) {
    const sh = ctx.shell; const a = ctx.args.slice();
    let cmdStr = null; let login = false;
    while (a.length && a[0][0] === '-' && a[0] !== '-') {
      const f = a.shift();
      if (f === '-c') { cmdStr = a.shift(); if (cmdStr == null) return ctx.fail('-c: option requires an argument', 2); break; }
      if (f === '-l' || f === '--login') login = true;
      if (f === '--') break;
      if (f === '--version') { ctx.out(flavor === 'zsh' ? 'zsh 5.9.1 (x86_64-debian-linux-gnu)\n' : flavor === 'bash' ? 'GNU bash, version 5.3.3(1)-release (x86_64-pc-linux-gnu)\n' : 'dash 0.5.12\n'); return 0; }
    }
    const child = sh.child({ flavor, interactive: cmdStr == null && !a.length && ctx.stdin == null, login });
    try {
      if (cmdStr != null) {
        child.scriptName = a[0] || flavor; child.positional = a.slice(1);
        return await child.execSource(cmdStr, ctx.io);
      }
      if (a.length) {
        let text;
        try { text = sh.fs.read(a[0]); }
        catch (e) { ctx.err(flavor + ': ' + (flavor === 'zsh' ? "can't open input file: " + a[0] : a[0] + ': ' + e.message) + '\n'); return 127; }
        child.scriptName = a[0]; child.positional = a.slice(1);
        return await child.execSource(text, ctx.io);
      }
      if (ctx.stdin != null) return await child.execSource(ctx.stdin, Object.assign({}, ctx.io, { stdin: '' }));
      return await child.repl();
    } catch (e) {
      if (e instanceof K.ExitSignal) return e.code;
      if (e instanceof ReturnSignal) return e.code;
      throw e;
    } finally { child.dispose(); }
  }
  K.cmd.register({ name: 'bash', pkg: 'bash', summary: 'GNU Bourne-Again SHell', synopsis: 'bash [options] [command_string | file]', run: (ctx) => shellCommand(ctx, 'bash') });
  K.cmd.register({ name: 'sh', pkg: 'dash', summary: 'command interpreter (shell)', synopsis: 'sh [-c command_string | file]', run: (ctx) => shellCommand(ctx, 'sh') });
  K.cmd.register({ name: 'zsh', pkg: 'zsh', summary: 'the Z shell', synopsis: 'zsh [options] [command_string | file]', run: (ctx) => shellCommand(ctx, 'zsh') });

  const SUDO_TIMEOUT = 15 * 60 * 1000;
  async function sudoAuth(ctx) {
    const sh = ctx.shell; const m = ctx.machine; const u = sh.user.name;
    if (sh.user.uid === 0) return true;
    const stamp = m.sudoStamp[u];
    if (stamp != null && K.clock.now() - stamp < SUDO_TIMEOUT && m.canSudo(u)) return true;
    for (let i = 0; i < 3; i++) {
      let pw;
      if (ctx.stdin != null && !sh.term.headless) { ctx.err('sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper\nsudo: a password is required\n'); return false; }
      pw = await sh.term.readLine({ prompt: '[sudo] password for ' + u + ': ', hidden: true });
      if (pw == null) { ctx.err('\nsudo: a password is required\n'); return false; }
      if (m.checkPassword(u, pw)) {
        if (!m.canSudo(u)) { ctx.err(u + ' is not in the sudoers file.\n'); return false; }
        m.sudoStamp[u] = K.clock.now();
        return true;
      }
      if (i < 2) ctx.err('Sorry, try again.\n');
    }
    ctx.err('sudo: 3 incorrect password attempts\n');
    return false;
  }

  K.cmd.register({
    name: 'sudo', pkg: 'sudo', section: 8, mode: 0o4755,
    summary: 'execute a command as another user',
    synopsis: 'sudo [-u user] [-i | -s] [-l] [-k] [-v] [command [arg ...]]',
    async run(ctx) {
      const sh = ctx.shell; const m = ctx.machine;
      const g = K.getopt(ctx.args, { short: 'u:islkvnEHSh', long: ['user=', 'login', 'shell', 'list', 'reset-timestamp', 'validate', 'help', 'version', 'non-interactive', 'preserve-env'], alias: { user: 'u', login: 'i', shell: 's', list: 'l', validate: 'v', 'reset-timestamp': 'k', help: 'h' }, stopAtNonOption: true });
      if (g.err) { ctx.err('sudo: ' + g.err + '\nusage: sudo -h | -K | -k | -V\nusage: sudo -v [-ABkNnS] [-g group] [-h host] [-p prompt] [-u user]\nusage: sudo -l [-ABkNnS] [-g group] [-h host] [-p prompt] [-U user] [-u user] [command [arg ...]]\nusage: sudo [-ABbEHkNnPS] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] [VAR=value] [-i | -s] [command [arg ...]]\n'); return 1; }
      const o = g.opts;
      if (o.version) { ctx.out('Sudo version 1.9.17p2\nSudoers policy plugin version 1.9.17p2\n'); return 0; }
      if (o.h) { ctx.out('sudo - execute a command as another user\n\nusage: sudo -h | -K | -k | -V\nusage: sudo -v [-ABkNnS] [-g group] [-h host] [-p prompt] [-u user]\nusage: sudo -l [-ABkNnS] [-g group] [-h host] [-p prompt] [-U user] [-u user] [command [arg ...]]\nusage: sudo [-ABbEHkNnPS] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] [VAR=value] [-i | -s] [command [arg ...]]\n\nOptions:\n  -i, --login                   run login shell as the target user; a command may also be specified\n  -k, --reset-timestamp         invalidate timestamp file\n  -l, --list                    list user\'s privileges or check a specific command; use twice for longer format\n  -s, --shell                   run shell as the target user; a command may also be specified\n  -u, --user=user               run command (or edit file) as specified user name or ID\n  -v, --validate                update user\'s timestamp without running a command\n'); return 0; }
      if (o.k && !g.rest.length) { delete m.sudoStamp[sh.user.name]; return 0; }
      const target = o.u || 'root';
      if (!m.userByName(target)) { ctx.err('sudo: unknown user ' + target + '\nsudo: error initializing audit plugin sudoers_audit\n'); return 1; }
      if (!(await sudoAuth(ctx))) return 1;
      if (o.v) return 0;
      if (o.l) {
        ctx.out('Matching Defaults entries for ' + sh.user.name + ' on ' + m.hostname + ':\n    env_reset, mail_badpass, secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/sbin\\:/usr/bin\\:/sbin\\:/bin, use_pty\n\nUser ' + sh.user.name + ' may run the following commands on ' + m.hostname + ':\n    (ALL : ALL) ALL\n');
        return 0;
      }
      const tu = m.userByName(target);
      const env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', TERM: sh.getVar('TERM') || 'xterm-256color', LANG: sh.getVar('LANG') || 'en_US.UTF-8', SHELL: tu.shell, SUDO_USER: sh.user.name, SUDO_UID: String(sh.user.uid), SUDO_GID: String(sh.user.gid), SUDO_COMMAND: g.rest.length ? g.rest.join(' ') : tu.shell };
      const interactiveShell = (o.i || o.s) && !g.rest.length;
      const flavor = /zsh$/.test(tu.shell) ? 'zsh' : /bash$/.test(tu.shell) ? 'bash' : 'sh';
      const child = sh.child({ user: target, env, cwd: o.i ? tu.home : sh.cwd, interactive: interactiveShell, flavor: interactiveShell ? flavor : sh.flavor, login: !!o.i });
      try {
        if (interactiveShell) return await child.repl();
        if (!g.rest.length) { ctx.err('usage: sudo -h | -K | -k | -V\nusage: sudo [-ABbEHkNnPS] [-u user] [VAR=value] [-i | -s] [command [arg ...]]\n'); return 1; }
        if (!child.which(g.rest[0]) && g.rest[0].indexOf('/') < 0 && !K.builtins[g.rest[0]]) { ctx.err('sudo: ' + g.rest[0] + ': command not found\n'); return 1; }
        // sudo runs real programs only; `cd`-style builtins are not programs
        if (K.builtins[g.rest[0]] && !child.which(g.rest[0]) && !/^(echo|printf|test|\[|true|false|pwd|kill)$/.test(g.rest[0])) { ctx.err('sudo: ' + g.rest[0] + ': command not found\n'); return 1; }
        return await child.execArgv(g.rest, ctx.io, { external: !!child.which(g.rest[0]) });
      } catch (e) {
        if (e instanceof K.ExitSignal) return e.code;
        throw e;
      } finally { child.dispose(); }
    },
  });

  K.cmd.register({
    name: 'su', pkg: 'util-linux', mode: 0o4755,
    summary: 'run a command with substitute user and group ID',
    synopsis: 'su [options] [-] [user [argument...]]',
    async run(ctx) {
      const sh = ctx.shell; const m = ctx.machine;
      const g = K.getopt(ctx.args.filter((a) => a !== '-'), { short: 'lc:s:mph', long: ['login', 'command=', 'shell=', 'help', 'version'], alias: { login: 'l', command: 'c', shell: 's', help: 'h' } });
      if (g.err) return ctx.fail(g.err + "\nTry 'su --help' for more information.");
      if (g.opts.h) { ctx.out('\nUsage:\n su [options] [-] [<user> [<argument>...]]\n\nChange the effective user ID and group ID to that of <user>.\nA mere - implies -l.  If <user> is not given, root is assumed.\n\nOptions:\n -, -l, --login                  make the shell a login shell\n -c, --command <command>         pass a single command to the shell with -c\n -s, --shell <shell>             run <shell> if /etc/shells allows it\n -h, --help                      display this help\n -V, --version                   display version\n'); return 0; }
      const login = ctx.args.includes('-') || !!g.opts.l;
      const target = g.rest[0] || 'root';
      const tu = m.userByName(target);
      if (!tu) { ctx.err('su: user ' + target + ' does not exist or the user entry does not contain all the required fields\n'); return 1; }
      if (sh.user.uid !== 0) {
        const pw = await sh.term.readLine({ prompt: 'Password: ', hidden: true });
        if (pw == null || !m.checkPassword(target, pw)) { ctx.err('su: Authentication failure\n'); return 1; }
      }
      if (/nologin$|\/false$/.test(tu.shell) && !g.opts.s) { ctx.out('This account is currently not available.\n'); return 1; }
      const shellPath = g.opts.s || tu.shell;
      const flavor = /zsh$/.test(shellPath) ? 'zsh' : /bash$/.test(shellPath) ? 'bash' : 'sh';
      const env = login ? { PATH: DEFAULT_PATH, TERM: sh.getVar('TERM') || 'xterm-256color', LANG: sh.getVar('LANG') || 'en_US.UTF-8', SHELL: tu.shell } : Object.assign(sh.env(), { SHELL: tu.shell });
      const child = sh.child({ user: target, env, cwd: login ? tu.home : sh.cwd, interactive: g.opts.c == null, flavor, login });
      try {
        if (g.opts.c != null) return await child.execSource(g.opts.c, ctx.io);
        return await child.repl();
      } catch (e) {
        if (e instanceof K.ExitSignal) return e.code;
        throw e;
      } finally { child.dispose(); }
    },
  });

  K.Shell = Shell;
})(typeof globalThis !== 'undefined' ? globalThis : this);
