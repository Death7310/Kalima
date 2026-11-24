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
            case 'q': s = a === undefined || a === '' ? "''" : /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(a) ? a : /[\x00-\x1f\x7f]/.test(a) ? "$'" + String(a).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/[\x00-\x1f\x7f]/g, (c) => '\\' + c.charCodeAt(0).toString(8).padStart(3, '0')) + "'" : String(a).replace(/([^A-Za-z0-9_\/.:=@%+,-])/g, '\\$1'); break;
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
      this.arrays = new Map();
      this.readonly = new Set();
      this.traps = new Map();
      this.optind = 1;
      this.curLine = 1;
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
      this.opts = { xtrace: false, errexit: false, nounset: false, pipefail: false, noclobber: false, nullglob: false, dotglob: false, noglob: false };
      this.pipeStatus = [0];
      this.noErrexit = 0;
      this.dirStack = [];
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
      this.setVar('SHLVL', String((parseInt(base.SHLVL, 10) || 0) + 1), true);
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
    setVar(name, value, exp) { if (name === 'OPTIND') { this.optind = parseInt(value, 10) || 1; this._optSub = 0; return; } this.vars.set(name, String(value)); this.arrays.delete(name); if (exp) this.exported.add(name); }
    unsetVar(name) { this.vars.delete(name); this.arrays.delete(name); this.exported.delete(name); }
    /* arrays: indexed arrays are 0-based in bash and 1-based in zsh; associative ones are keyed by string */
    arrBase() { return this.flavor === 'zsh' ? 1 : 0; }
    arrValues(name) {
      const a = this.arrays.get(name);
      if (a) return a.assoc ? Array.from(a.v.values()) : a.v.filter((x) => x !== undefined);
      const v = this.vars.get(name);
      return v == null ? [] : [v];
    }
    arrKeys(name) {
      const a = this.arrays.get(name);
      if (a) {
        if (a.assoc) return Array.from(a.v.keys());
        const ks = []; a.v.forEach((x, i) => { if (x !== undefined) ks.push(String(i + this.arrBase())); }); return ks;
      }
      return this.vars.has(name) ? [String(this.arrBase())] : [];
    }
    async arrIndexKey(name, idx, io) {
      const a = this.arrays.get(name);
      const text = (await this.expandString(idx, io)).map((x) => x.s).join('');
      if (a && a.assoc) return text.replace(/^(["'])(.*)\1$/, '$2');
      let k;
      try { k = arith(text, (n) => this.getVar(n), (n, val) => this.setVar(n, val)); }
      catch (e) { throw new ShellError(this.msgPrefix() + e.message); }
      return k;
    }
    async arrGet(name, idx, io) {
      const a = this.arrays.get(name);
      const k = await this.arrIndexKey(name, idx, io);
      if (a && a.assoc) return a.v.has(k) ? a.v.get(k) : null;
      let i = k - this.arrBase();
      const len = a ? a.v.length : (this.vars.has(name) ? 1 : 0);
      if (k < 0) i = len + k;
      if (a) { const v = a.v[i]; return v === undefined ? null : v; }
      return i === 0 && this.vars.has(name) ? this.vars.get(name) : null;
    }
    async arrSet(name, idx, val, append, io) {
      let a = this.arrays.get(name);
      if (!a) {
        a = { assoc: false, v: [] };
        if (this.vars.has(name)) { a.v[0] = this.vars.get(name); this.vars.delete(name); }
        this.arrays.set(name, a);
      }
      const k = await this.arrIndexKey(name, idx, io);
      if (a.assoc) { a.v.set(k, (append && a.v.has(k) ? a.v.get(k) : '') + val); return; }
      let i = k - this.arrBase(); if (k < 0) i = a.v.length + k;
      if (i < 0) throw new ShellError(this.msgPrefix() + name + '[' + idx + ']: bad array subscript');
      a.v[i] = (append && a.v[i] !== undefined ? a.v[i] : '') + val;
    }
    /** run one parsed assignment (NAME=value, NAME+=value, NAME=(...), NAME[i]=value) */
    async runAssign(a, io, exp) {
      const name = a.name;
      if (this.readonly.has(name)) throw new ShellError(this.flavor === 'zsh' ? this.msgPrefix() + 'read-only variable: ' + name : this.msgPrefix() + name + ': readonly variable');
      if (a.arr) {
        const assoc = this.arrays.has(name) && this.arrays.get(name).assoc;
        const items = [];
        for (const w of a.arr) {
          const m = assoc || /^\[/.test(w.raw) ? /^\[([^\]]*)\]=(.*)$/s.exec(w.raw) : null;
          if (m) { items.push({ k: m[1].replace(/^(["'])(.*)\1$/, '$2'), v: m[2].replace(/^(["'])(.*)\1$/, '$2') }); continue; }
          for (const x of await this.expandWord(w, io)) items.push({ v: x });
        }
        let cur = a.append ? this.arrays.get(name) : null;
        if (a.append && !cur && this.vars.has(name)) cur = { assoc: false, v: [this.vars.get(name)] };
        if (assoc) {
          const e = cur || { assoc: true, v: new Map() };
          if (!a.append) e.v.clear();
          let pend = null;
          for (const it of items) { if (it.k != null) e.v.set(it.k, it.v); else if (pend == null) pend = it.v; else { e.v.set(pend, it.v); pend = null; } }
          this.arrays.set(name, e); this.vars.delete(name);
        } else {
          const e = cur || { assoc: false, v: [] };
          if (!a.append) e.v = [];
          let idx = e.v.length;
          for (const it of items) { if (it.k != null) { idx = parseInt(it.k, 10) - this.arrBase(); } e.v[idx++] = it.v; }
          this.arrays.set(name, e); this.vars.delete(name);
        }
        if (exp) this.exported.add(name);
        return;
      }
      let v = await this.expandSingle(a.word, io);
      if (a.index != null) { await this.arrSet(name, a.index, v, a.append, io); return; }
      if (a.append) {
        if (this.arrays.has(name) && this.flavor !== 'zsh') { await this.arrSet(name, String(this.arrBase()), v, true, io); return; }
        v = (this.getVar(name) || '') + v;
      }
      if (this.arrays.has(name) && this.flavor !== 'zsh' && !this.arrays.get(name).assoc) { await this.arrSet(name, String(this.arrBase()), v, false, io); return; }
      this.setVar(name, v, exp != null ? exp : this.exported.has(name));
    }
    getVar(name) {
      switch (name) {
        case '?': return String(this.status);
        case '$': return String(this.pid);
        case '!': return this.lastBgPid ? String(this.lastBgPid) : '';
        case '#': return String(this.positional.length);
        case '@': return this.positional.join(' ');
        case '*': return this.positional.join(this.ifsFirst());
        case '0': return this.scriptName;
        case '-': return (this.interactive ? 'hims' : 'h') + (this.opts.errexit ? 'e' : '') + (this.opts.nounset ? 'u' : '') + (this.opts.noclobber ? 'C' : '') + (this.opts.xtrace ? 'x' : '') + 'B' + (this.interactive ? 'H' : 'c');
        case 'LINENO': return String(this.curLine);
        case 'FUNCNAME': return this.funcNames && this.funcNames.length ? this.funcNames[this.funcNames.length - 1] : null;
        case 'OPTIND': return String(this.optind);
        case 'RANDOM': return String(Math.floor(K.util.prng('rnd' + K.clock.now() + ':' + (this._rnd = (this._rnd || 0) + 1))() * 32768));
        case 'SECONDS': return String(Math.floor((K.clock.now() - this.startTime) / 1000));
        case 'UID': case 'EUID': return String(this.user.uid);
        case 'PPID': return String(this.proc.ppid);
        case 'COLUMNS': return String(this.term.cols || 80);
        case 'LINES': return String(this.term.rows || 24);
      }
      if (/^[0-9]+$/.test(name)) { const v = this.positional[parseInt(name, 10) - 1]; return v == null ? '' : v; }
      const v = this.vars.get(name);
      if (v == null) {
        if (this.arrays.has(name)) { const vals = this.arrValues(name); return this.flavor === 'zsh' ? vals.join(' ') : (vals.length ? this.arrays.get(name).assoc ? null : (this.arrays.get(name).v[0] === undefined ? '' : this.arrays.get(name).v[0]) : ''); }
        return null;
      }
      return v;
    }
    ifsFirst() { const v = this.vars.get('IFS'); return v == null ? ' ' : v.charAt(0); }
    /** split a string into fields the way the shell splits unquoted expansions (honours $IFS) */
    ifsSplit(str) {
      const v = this.vars.get('IFS');
      if (v == null || v === ' \t\n') return str.split(/[ \t\n]+/).filter((b) => b !== '');
      if (v === '') return [str];
      const white = v.split('').filter((c) => c === ' ' || c === '\t' || c === '\n').join('');
      const out = []; let cur = ''; let pending = false;
      for (const ch of str) {
        if (v.indexOf(ch) < 0) { cur += ch; pending = true; continue; }
        if (white.indexOf(ch) >= 0) { if (pending) { out.push(cur); cur = ''; pending = false; } continue; }
        out.push(cur); cur = ''; pending = false;
      }
      if (pending) out.push(cur);
      return out;
    }
    /** exported environment as a plain object */
    env(extra) {
      const e = {};
      for (const k of this.exported) if (this.vars.has(k)) e[k] = this.vars.get(k);
      if (extra) Object.assign(e, extra);
      return e;
    }
    msgPrefix() {
      if (this.interactive) return this.flavor + ': ';
      if (this.flavor === 'zsh') return (this.scriptName || 'zsh') + ':' + this.curLine + ': ';
      if (this.flavor === 'sh') return (this.scriptName || 'sh') + ': ' + this.curLine + ': ';
      if (this.cmdString) return this.flavor + ': line ' + this.curLine + ': ';
      return (this.scriptName || this.flavor) + ': line ' + this.curLine + ': ';
    }
    /** wording of a syntax error for this shell */
    syntaxMessage(e) {
      if (this.flavor === 'zsh' || this.interactive || e.line == null) return this.flavor + ': ' + e.message;
      const who = this.flavor === 'sh' ? (this.scriptName || 'sh') : this.cmdString ? this.flavor + ': -c' : (this.scriptName || this.flavor);
      if (this.flavor === 'sh') return who + ': ' + e.line + ': Syntax error: ' + (e.incomplete ? 'end of file unexpected' : '"' + (e.tok || '') + '" unexpected');
      const pre = who + ': line ' + e.line + ': ';
      if (e.incomplete) return pre + (/unmatched|unexpected EOF|here-document/.test(e.message) ? e.message.replace(/^unmatched (.)$/, "unexpected EOF while looking for matching `$1'") : 'syntax error: unexpected end of file');
      return pre + 'syntax error near unexpected token `' + (e.tok || '') + "'\n" + pre + '`' + (e.srcLine || '') + "'";
    }

    /* ------------------------------------------------------------- expansion */
    async expandString(text, io, o) {
      // expands $-constructs inside `text`; returns array of {s, split}
      o = o || {};
      const out = [];
      let lit = '';
      const flushLit = () => { if (lit) { out.push({ s: lit, lit: true }); lit = ''; } };
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if ((ch === '`' || ch === '$') && text[i - 1] === '\u0000') { lit += ch; continue; }
        if (ch === '`') {
          let j = i + 1; while (j < text.length && text[j] !== '`') j += text[j] === '\\' ? 2 : 1;
          if (j < text.length) {
            flushLit();
            const res = await this.captureSource(text.slice(i + 1, j).replace(/\\([`$\\])/g, '$1'), io);
            out.push({ s: res.replace(/\n+$/, ''), split: true });
            i = j; continue;
          }
        }
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
          if (name === '@') out.push({ s: this.positional.join(' '), list: this.positional.slice() });
          else {
            const v = this.getVar(name);
            if (v == null && this.opts.nounset && /^[A-Za-z_]/.test(name)) throw Object.assign(new ShellError(this.msgPrefix() + name + ': ' + (this.flavor === 'zsh' ? 'parameter not set' : 'unbound variable')), { fatal: true });
            out.push({ s: v == null ? '' : v, split: this.flavor === 'zsh' && this.arrays.has(name) });
          }
        }
      }
      flushLit();
      return out;
    }

    async expandParam(body, io) {
      const sub = async (t) => (await this.expandString(t, io)).map((x) => x.s).join('');
      let m;
      // ${#a[@]} ${#a[i]} ${#name} ${#}
      if ((m = /^#([A-Za-z_][A-Za-z0-9_]*)\[([^\]]*)\]$/.exec(body))) {
        if (m[2] === '@' || m[2] === '*') return { s: String(this.arrValues(m[1]).length) };
        const e = await this.arrGet(m[1], m[2], io); return { s: String((e || '').length) };
      }
      if (body[0] === '#' && body.length > 1 && /^#[A-Za-z_0-9@*?]+$/.test(body)) {
        const n = body.slice(1);
        if (n === '@' || n === '*') return { s: String(this.positional.length) };
        if (this.arrays.has(n) && this.flavor === 'zsh') return { s: String(this.arrValues(n).length) };
        const v = this.getVar(n); return { s: String((v || '').length) };
      }
      // ${!a[@]} keys, ${!name} indirection
      if ((m = /^!([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]$/.exec(body))) { const ks = this.arrKeys(m[1]); return { s: ks.join(' '), list: ks }; }
      if ((m = /^!([A-Za-z_][A-Za-z0-9_]*)$/.exec(body))) { const t = this.getVar(m[1]); const v = t == null ? null : this.getVar(t); return { s: v == null ? '' : v }; }
      m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?$!#@*\-])(?:\[([^\]]*)\])?([\s\S]*)$/.exec(body);
      if (!m) throw new ShellError(this.msgPrefix() + 'bad substitution');
      const name = m[1]; const subscript = m[2]; let rest = m[3];
      let v; let list = null;
      if (subscript != null) {
        if (subscript === '@' || subscript === '*') {
          list = this.arrValues(name);
          v = list.length ? list.join(subscript === '*' ? this.ifsFirst() : ' ') : null;
        } else v = await this.arrGet(name, subscript, io);
      } else if (name === '@') { list = this.positional.slice(); v = list.join(' '); if (!list.length && rest) v = null; }
      else if (name === '*') { v = this.positional.length ? this.positional.join(this.ifsFirst()) : null; }
      else if (this.arrays.has(name) && this.flavor === 'zsh' && !this.arrays.get(name).assoc && rest && /^:-?\d/.test(rest)) { list = this.arrValues(name); v = list.join(' '); }
      else v = this.getVar(name);
      if (v == null && this.opts.nounset && !/^[-+=?]|^:[-+=?]/.test(rest) && /^[A-Za-z_]/.test(name)) throw Object.assign(new ShellError(this.msgPrefix() + name + ': ' + (this.flavor === 'zsh' ? 'parameter not set' : 'unbound variable')), { fatal: true });
      const res = (s2) => (list && subscript !== '*' ? { s: s2, list: s2 === v ? list : null } : { s: s2 });
      if (!rest) return list && subscript !== '*' ? { s: v == null ? '' : v, list } : { s: v == null ? '' : v };
      let mm;
      if ((mm = /^(:?)([-=+?])([\s\S]*)$/.exec(rest))) {
        const colon = mm[1] === ':'; const op = mm[2]; const arg = mm[3];
        const unset = v == null || (colon && v === '');
        if (op === '-') return unset ? { s: await sub(arg) } : res(v);
        if (op === '=') { if (unset) { v = await sub(arg); this.setVar(name, v); } return { s: v }; }
        if (op === '+') return unset ? { s: '' } : { s: await sub(arg) };
        if (op === '?') { if (unset) throw Object.assign(new ShellError(this.msgPrefix() + name + ': ' + ((await sub(arg)) || 'parameter null or not set')), { fatal: true }); return { s: v }; }
      }
      v = v == null ? '' : v;
      // array slice ${a[@]:off:len}
      if (list && (mm = /^:\s*(-?\d+)(?::(-?\d+))?$/.exec(rest))) {
        let off = parseInt(mm[1], 10); const arr = list;
        if (name === '@' && subscript == null && off > 0) off -= 1;
        if (off < 0) off = Math.max(0, arr.length + off);
        const sl = mm[2] == null ? arr.slice(off) : arr.slice(off, off + parseInt(mm[2], 10));
        return { s: sl.join(' '), list: sl };
      }
      const apply = (f) => (list ? { s: list.map(f).join(' '), list: list.map(f) } : { s: f(v) });
      if ((mm = /^(##?|%%?)([\s\S]*)$/.exec(rest))) {
        const pat = await sub(mm[2]); const op = mm[1];
        const src = K.util.globToRe(pat).source.slice(1, -1);
        const one = (x) => {
          if (op[0] === '#') {
            for (let i = op === '##' ? x.length : 0; op === '##' ? i >= 0 : i <= x.length; i += op === '##' ? -1 : 1) if (new RegExp('^' + src + '$').test(x.slice(0, i))) return x.slice(i);
            return x;
          }
          const full = new RegExp('^' + src + '$');
          if (op === '%%') { for (let i = 0; i <= x.length; i++) if (full.test(x.slice(i))) return x.slice(0, i); }
          else { for (let i = x.length; i >= 0; i--) if (full.test(x.slice(i))) return x.slice(0, i); }
          return x;
        };
        return apply(one);
      }
      if ((mm = /^(\/\/?|\/#|\/%)((?:\\.|[^\/])*)(?:\/([\s\S]*))?$/.exec(rest))) {
        const pat = await sub(mm[2]); const rp = mm[3] == null ? '' : await sub(mm[3]);
        const src = K.util.globToRe(pat).source.slice(1, -1);
        const flags = mm[1] === '//' ? 'g' : '';
        const re = new RegExp(mm[1] === '/#' ? '^(?:' + src + ')' : mm[1] === '/%' ? '(?:' + src + ')$' : src, flags);
        return apply((x) => x.replace(re, () => rp));
      }
      if ((mm = /^:\s*(-?\d+)(?::\s*(-?\d+))?$/.exec(rest))) {
        let off = parseInt(mm[1], 10); if (off < 0) off = Math.max(0, v.length + off);
        let len = mm[2] == null ? undefined : parseInt(mm[2], 10);
        if (len !== undefined && len < 0) len = Math.max(0, v.length + len - off);
        return { s: len === undefined ? v.slice(off) : v.slice(off, off + len) };
      }
      if (rest === '^^') return apply((x) => x.toUpperCase());
      if (rest === ',,') return apply((x) => x.toLowerCase());
      if (rest === '^') return apply((x) => x.charAt(0).toUpperCase() + x.slice(1));
      if (rest === ',') return apply((x) => x.charAt(0).toLowerCase() + x.slice(1));
      if (rest === '@Q') return { s: v === '' ? "''" : "'" + v.replace(/'/g, "'\\''") + "'" };
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

    /** <(cmd) / >(cmd): the command's output (or input) lives in a temporary /dev/fd/N file until the enclosing list item ends. */
    async procSub(part, io) {
      const vfs = this.machine.vfs; const root = this.rootShell;
      root._psubN = (root._psubN || 64) - 1; if (root._psubN < 3) root._psubN = 63;
      const path = '/dev/fd/' + root._psubN;
      try { vfs.mkdir('/dev/fd', { parents: true }); } catch (e) { /* exists */ }
      const ent = { path, dir: part.dir, cmd: part.cmd };
      if (part.dir === '<') vfs.write(path, await this.captureSource(part.cmd, io), { mode: 0o666, umask: 0 });
      else vfs.write(path, '', { mode: 0o666, umask: 0 });
      (root._psubs = root._psubs || []).push(ent);
      return path;
    }
    async procSubCleanup(mark, io) {
      const list = this.rootShell._psubs;
      if (!list) return;
      while (list.length > mark) {
        const ent = list.pop();
        let data = null;
        try { if (ent.dir === '>') data = this.machine.vfs.read(ent.path); this.machine.vfs.unlink(ent.path); } catch (e) { /* gone */ }
        if (data != null) { try { await this.execSource(ent.cmd, Object.assign({}, io, { stdin: data })); } catch (e) { if (!(e instanceof K.ExitSignal)) throw e; } }
      }
    }

    /** Expand one word token to zero or more argument strings. */
    async expandWord(word, io, o) {
      o = o || {};
      const results = [];
      const words = o.noBrace ? [word] : this.braceExpand(word);
      for (const w of words) {
        // fields: arrays of segments {s, glob}
        let fields = [[]]; let any = w.quoted; let listEmpty = false;
        const cur = () => fields[fields.length - 1];
        for (let pi = 0; pi < w.parts.length; pi++) {
          const part = w.parts[pi];
          if (part.q === 'p') { cur().push({ s: await this.procSub(part, io), glob: false }); any = true; continue; }
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
            if (pc.list && part.q === 'd' && !o.noSplit) {
              // "$@" and "${a[@]}" -> one field per element; nothing at all when empty
              const ps = pc.list;
              if (ps.length) {
                cur().push({ s: ps[0], glob: false });
                for (let k = 1; k < ps.length; k++) fields.push([{ s: ps[k], glob: false }]);
                any = true;
              } else listEmpty = true;
              continue;
            }
            const doSplit = part.q === 'n' && !o.noSplit && (pc.split || pc.list || this.flavor !== 'zsh');
            if (doSplit) {
              const ifs = this.vars.get('IFS');
              const wsOnly = ifs == null || ifs === ' \t\n';
              const bits = wsOnly ? pc.s.split(/[ \t\n]+/) : this.ifsSplit(pc.s);
              const lead = wsOnly && /^[ \t\n]/.test(pc.s); const trail = wsOnly && /[ \t\n]$/.test(pc.s);
              const nonEmpty = wsOnly ? bits.filter((b) => b !== '') : bits;
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
          if (listEmpty && fields.length === 1 && !f.length) continue;
          const text = f.map((x) => x.s).join('');
          if (!f.length && !(any && w.quoted && fields.length === 1)) { if (!(w.quoted && fields.length === 1)) continue; }
          if (text === '' && !w.quoted) continue;
          const hasGlob = !o.noGlob && !this.opts.noglob && f.some((x) => x.glob && /[*?\[]/.test(x.s));
          if (hasGlob) {
            const matches = this.glob(f);
            if (matches.length) { results.push.apply(results, matches); continue; }
            if (this.opts.nullglob) continue;
            // zsh (nomatch is on by default) refuses to run a command with a pattern that matches nothing
            if (this.flavor === 'zsh' && !this.interactive && !o.noNomatch && text !== '[' && text !== '[[' && !/^[A-Za-z_]\w*=/.test(text)) throw new ShellError(this.msgPrefix() + 'no matches found: ' + text);
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
          const showDot = comp[0].s[0] === '.' || this.opts.dotglob;
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
        if (e instanceof ParseError) {
          // a script runs the commands before the broken one, as bash and zsh read it command by command
          if (!this.interactive && src.indexOf('\n') > 0) {
            const lines = src.split('\n');
            let k = e.incomplete ? lines.length - 1 : Math.min((e.line || 1) - 1, lines.length);
            for (; k >= 1 && lines.length < 3000; k--) {
              let pre = null;
              try { pre = K.shlex.parse(lines.slice(0, k).join('\n'), this.aliases); } catch (e2) { continue; }
              const sl = this.curLine;
              try { await this.execNode(pre, io); } finally { this.curLine = sl; }
              break;
            }
          }
          io.err(this.syntaxMessage(e) + '\n'); const c = this.flavor === 'zsh' || this.interactive ? 1 : 2; this.status = c; return c;
        }
        throw e;
      }
      const savedLine = this.curLine;
      try { return await this.execNode(ast, io); }
      finally { this.curLine = savedLine; }
    }

    /** Run source in a context that captures stdout (command substitution). */
    async captureSource(src, io) {
      let buf = '';
      const sub = { stdin: io ? io.stdin : null, out: (s) => { if (buf.length < MAX_CAPTURE) buf += s; }, err: io ? io.err : () => {}, outTTY: false, errTTY: io ? io.errTTY : false, sig: io ? io.sig : this.term.signal };
      const saveCwd = this.cwd;
      try { this.lastSubst = await this.execSource(src, sub); }
      catch (e) { if (!(e instanceof K.ExitSignal)) throw e; this.lastSubst = e.code; }
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
        else if (e instanceof ReturnSignal) code = e.code;
        else if (e instanceof BreakSignal || e instanceof ContinueSignal) code = 0;
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
            else {
              const mark = (this.rootShell._psubs || []).length;
              try { st = await this.execNode(it.node, io); }
              catch (e) {
                if (!(e instanceof ShellError)) throw e;
                io.err(e.message + '\n'); st = 1;
                if (e.fatal && !this.interactive) throw new K.ExitSignal(1);
              } finally { if ((this.rootShell._psubs || []).length > mark) await this.procSubCleanup(mark, io); }
            }
            this.status = st;
            if (st !== 0 && !this.noErrexit && !it.bg) {
              const et = this.traps.get('ERR');
              if (et != null && !this._inErr) { this._inErr = true; try { await this.execSource(et, io); } finally { this._inErr = false; } }
              if (this.opts.errexit) throw new K.ExitSignal(st);
            }
          }
          return st;
        }
        case 'andor': {
          this.noErrexit++;
          let st;
          try {
            st = await this.execNode(node.first, io);
            this.status = st;
            for (let ri = 0; ri < node.rest.length; ri++) {
              const r = node.rest[ri];
              if ((r.op === '&&') === (st === 0)) {
                if (ri === node.rest.length - 1) this.noErrexit--;
                try { st = await this.execNode(r.node, io); } finally { if (ri === node.rest.length - 1) this.noErrexit++; }
                this.status = st;
              }
            }
          } finally { this.noErrexit--; }
          if (st !== 0 && this.opts.errexit && !this.noErrexit && node.rest.length && (node.rest[node.rest.length - 1].op === '&&' ? true : false) && false) throw new K.ExitSignal(st);
          return st;
        }
        case 'arithcmd': {
          this.curLine = node.line || this.curLine;
          const r = await this.applyRedirs(node.redirs, io);
          if (r.error) { io.err(r.error + '\n'); return 1; }
          try {
            const expr = (await this.expandString(node.expr, io)).map((x) => x.s).join('');
            const v = arith(expr, (n) => this.getVar(n), (n, val) => this.setVar(n, val));
            return v === 0 ? 1 : 0;
          } catch (e) {
            if (e instanceof ShellError) { io.err(e.message + '\n'); return 1; }
            io.err(this.msgPrefix() + e.message + '\n'); return 1;
          }
        }
        case 'pipeline': return this.execPipeline(node, io);
        case 'simple': return this.execSimple(node, io);
        case 'funcdef': this.functions.set(node.name, node.body); return 0;
        case 'if': case 'for': case 'cfor': case 'while': case 'case': case 'group': return this.execCompound(node, io);
      }
      throw new Error('unknown node type ' + node.type);
    }

    async execPipeline(node, io) {
      let stdin = io.stdin; let st = 0;
      const n = node.cmds.length;
      const codes = [];
      if (node.neg) this.noErrexit++;
      try {
        for (let i = 0; i < n; i++) {
          const last = i === n - 1;
          const cmd = node.cmds[i];
          if (last) { st = await this.execNode(cmd, Object.assign({}, io, { stdin })); codes.push(st); break; }
          let buf = ''; let overflow = false;
          const sink = (s) => { if (buf.length < MAX_CAPTURE) buf += s; else overflow = true; };
          const sub = Object.assign({}, io, { stdin, out: sink, outTTY: false });
          if (cmd.pipeErr) { sub.err = sink; sub.errTTY = false; }
          codes.push(await this.execNode(cmd, sub));
          void overflow;
          stdin = buf;
        }
      } finally { if (node.neg) this.noErrexit--; }
      if (this.opts.pipefail) { for (let i = codes.length - 1; i >= 0; i--) if (codes[i] !== 0) { st = codes[i]; break; } }
      this.setPipeStatus(codes);
      if (node.neg) st = st === 0 ? 1 : 0;
      this.status = st;
      return st;
    }
    setPipeStatus(codes) { this.arrays.set(this.flavor === 'zsh' ? 'pipestatus' : 'PIPESTATUS', { assoc: false, v: codes }); }

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
            if (!src) return { error: this.msgPrefix() + (this.flavor === 'zsh' ? 'bad file descriptor: ' + r.dup : r.dup + ': Bad file descriptor') };
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
          catch (e) { return { error: this.redirError(e, target) }; }
          continue;
        }
        // output redirections
        const append = r.op === '>>' || r.op === '&>>';
        try {
          let st = null;
          try { st = fsv.stat(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (st && st.isDir) throw new K.FsError('EISDIR', target);
          if (st && !append && this.opts.noclobber && !r.force && st.isFile) return { error: this.msgPrefix() + (this.flavor === 'zsh' ? 'file exists: ' + target : target + ': cannot overwrite existing file') };
          if (!append || !st) fsv.write(target, append && st ? fsv.read(target) : '');
          else if (!fsv.can(target, 'w')) throw new K.FsError('EACCES', target);
        } catch (e) {
          if (!(e instanceof K.FsError)) throw e;
          return { error: this.redirError(e, target) };
        }
        const sink = fileSink(target);
        if (r.op === '&>' || r.op === '&>>') { nio.out = sink; nio.err = sink; nio.outTTY = nio.errTTY = false; }
        else if (r.fd === 2) { nio.err = sink; nio.errTTY = false; }
        else { nio.out = sink; nio.outTTY = false; }
      }
      return { io: nio };
    }

    redirError(e, target) {
      return this.msgPrefix() + (this.flavor === 'zsh' ? this.fsMsg(e) + ': ' + target : target + ': ' + e.message);
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
        case 'cfor': {
          const ev = async (t) => {
            const expr = (await this.expandString(t, io)).map((x) => x.s).join('');
            try { return arith(expr, (n) => this.getVar(n), (n, val) => this.setVar(n, val)); }
            catch (e) { throw new ShellError(this.msgPrefix() + e.message); }
          };
          let st = 0; let guard = 0;
          this.loopDepth++;
          try {
            await ev(node.init);
            while (!node.cond.trim() || (await ev(node.cond)) !== 0) {
              if (io.sig && io.sig.aborted) throw new K.Interrupt();
              try { st = await this.execNode(node.body, io); }
              catch (e) {
                if (e instanceof BreakSignal) { if (e.n > 1) { e.n--; throw e; } break; }
                if (e instanceof ContinueSignal) { if (e.n > 1) { e.n--; throw e; } }
                else throw e;
              }
              if (node.step.trim()) await ev(node.step);
              if (++guard % 200 === 0) await new Promise((res) => setTimeout(res, 0));
              if (guard > 1000000) { io.err(this.msgPrefix() + 'loop aborted after 1000000 iterations (simulator limit)\n'); return 1; }
            }
          } catch (e) {
            if (e instanceof ShellError) { io.err(e.message + '\n'); return 1; }
            throw e;
          } finally { this.loopDepth--; }
          return st;
        }
        case 'if': {
          for (const c of node.clauses) {
            this.noErrexit++;
            let st;
            try { st = await this.execNode(c.cond, io); } finally { this.noErrexit--; }
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
              this.noErrexit++;
              let c;
              try { c = await this.execNode(node.cond, io); } finally { this.noErrexit--; }
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
      for (const [k, a] of this.arrays) c.arrays.set(k, { assoc: a.assoc, v: a.assoc ? new Map(a.v) : a.v.slice() });
      c.readonly = new Set(this.readonly);
      c.opts = Object.assign({}, this.opts);
      c.traps = new Map(this.traps);
      c.dirStack = this.dirStack.slice();
      c.cmdString = this.cmdString;
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
      if (node.line) this.curLine = node.line;
      // expand command words
      let argv = [];
      try {
        const dbl = node.words.length > 0 && node.words[0].raw === '[[' && !node.words[0].quoted;
        for (const w of node.words) argv.push.apply(argv, await this.expandWord(w, io, dbl ? { noGlob: true } : undefined));
      } catch (e) {
        if (e instanceof ShellError) { io.err(e.message + '\n'); this.status = 1; if (e.fatal && !this.interactive) throw new K.ExitSignal(1); return 1; }
        throw e;
      }
      const assigns = [];
      const bare = !argv.length;
      try {
        if (!bare) {
          for (const a of node.assigns) {
            if (a.arr || a.index != null) continue;
            let v = await this.expandSingle(a.word, io);
            if (a.append) v = (this.getVar(a.name) || '') + v;
            assigns.push([a.name, v]);
          }
        }
      } catch (e) {
        if (e instanceof ShellError) { io.err(e.message + '\n'); this.status = 1; return 1; }
        throw e;
      }
      const r = await this.applyRedirs(node.redirs, io);
      if (r.error) { io.err(r.error + '\n'); this.status = 1; return 1; }
      const cio = r.io;
      if (bare) {
        this.lastSubst = 0;
        try { for (const a of node.assigns) await this.runAssign(a, cio, this.exported.has(a.name)); }
        catch (e) {
          if (e instanceof ShellError) { io.err(e.message + '\n'); this.status = 1; return 1; }
          throw e;
        }
        return node.assigns.length ? (this.lastSubst || 0) : this.status;
      }
      if (this.opts.xtrace) cio.err('+ ' + (this.flavor === 'zsh' ? argv.join(' ') : argv.map((x) => (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(x) ? x : "'" + x.replace(/'/g, "'\\''") + "'")).join(' ')) + '\n');
      // temporary environment for this command only
      const saved = [];
      for (const [k, v] of assigns) { saved.push([k, this.vars.has(k) ? this.vars.get(k) : null, this.exported.has(k)]); this.setVar(k, v, true); }
      let st;
      try { st = await this.execArgv(argv, cio); }
      finally {
        for (const [k, v, ex] of saved) { if (v == null) this.unsetVar(k); else { this.vars.set(k, v); if (!ex) this.exported.delete(k); } }
      }
      this.status = st;
      if (!io.bgJob) this.rootShell._trace.push({ argv, code: st, user: this.user.name, host: this.machine.hostname });
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
      io.err(this.msgPrefix() + (this.flavor === 'zsh' ? 'command not found: ' + name : name + ': command not found') + '\n');
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

    /** Run the EXIT trap (once) when a non-interactive shell ends. */
    async exitTrap(io) {
      const cmd = this.traps.get('EXIT');
      if (cmd == null) return;
      this.traps.delete('EXIT');
      const st = this.status;
      try { await this.execSource(cmd, io); } catch (e) { if (!(e instanceof K.ExitSignal)) throw e; }
      this.status = st;
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
      } finally { try { await child.exitTrap(io); } catch (e) { /* trap failed */ } child.dispose(); }
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
      const jio = Object.assign({}, io, { sig, bgJob: true, stdin: io.stdin == null ? '' : io.stdin });
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

    /**
     * History expansion (!!, !$, !^, !*, !N, !-N, !str, !?str?, word designators,
     * :p, :s/old/new/ and ^old^new). Returns the new line; sets this._histPrint
     * for :p. Throws an Error with .histErr when an event is not found.
     */
    histExpand(line) {
      this._histPrint = false;
      const hist = this.history;
      const notFound = (what) => Object.assign(new Error(this.flavor === 'zsh' ? 'zsh: event not found: ' + what : 'bash: !' + what + ': event not found'), { histErr: true });
      if (line[0] === '^' && /^\^[^^]+\^[^^]*\^?$/.test(line)) {
        const m = /^\^([^^]+)\^([^^]*)\^?$/.exec(line);
        const last = hist[hist.length - 1];
        if (last == null || last.indexOf(m[1]) < 0) throw Object.assign(new Error(this.flavor === 'zsh' ? 'zsh: substitution failed' : 'bash: :s^' + m[1] + '^' + m[2] + ': substitution failed'), { histErr: true });
        return last.replace(m[1], m[2]);
      }
      if (line.indexOf('!') < 0) return line;
      let out = ''; let q = null; let changed = false;
      const words = (t) => t.trim().split(/\s+/);
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q === "'") { out += c; if (c === "'") q = null; continue; }
        if (c === '\\') { out += c + (line[i + 1] || ''); i++; continue; }
        if (c === "'") { q = "'"; out += c; continue; }
        if (c !== '!') { out += c; continue; }
        const n = line[i + 1];
        if (n === undefined || /[\s=(]/.test(n)) { out += c; continue; }
        let ev = null; let j = i + 1; let what = '';
        if (n === '!') { ev = hist[hist.length - 1]; j = i + 2; what = '!'; }
        else if (n === '$' || n === '^' || n === '*') { ev = hist[hist.length - 1]; j = i + 2; what = n; }
        else if (/\d/.test(n)) { const m = /^\d+/.exec(line.slice(i + 1))[0]; ev = hist[parseInt(m, 10) - 1]; j = i + 1 + m.length; what = m; }
        else if (n === '-' && /\d/.test(line[i + 2] || '')) { const m = /^\d+/.exec(line.slice(i + 2))[0]; ev = hist[hist.length - parseInt(m, 10)]; j = i + 2 + m.length; what = '-' + m; }
        else if (n === '?') { const m = /^\?([^?]*)\??/.exec(line.slice(i + 1)); what = m[1]; ev = null; for (let k = hist.length - 1; k >= 0; k--) if (hist[k].indexOf(what) >= 0) { ev = hist[k]; break; } j = i + 1 + m[0].length; }
        else if (/[A-Za-z0-9_.\/~-]/.test(n)) {
          const m = /^[^\s:;|&<>()'"]+/.exec(line.slice(i + 1))[0]; what = m; j = i + 1 + m.length;
          for (let k = hist.length - 1; k >= 0; k--) if (hist[k].startsWith(m)) { ev = hist[k]; break; }
        } else { out += c; continue; }
        if (ev == null) throw notFound(what);
        let res = ev;
        // word designator on a bare !$ !^ !*
        if (what === '$') res = words(ev).slice(-1)[0];
        else if (what === '^') res = words(ev)[1] || '';
        else if (what === '*') res = words(ev).slice(1).join(' ');
        // :designators and modifiers
        for (;;) {
          const m = /^:([0-9]+|\$|\^|\*|-[0-9]*|p|s\/[^/]*\/[^/]*\/?|h|t|r|e)/.exec(line.slice(j));
          if (!m) break;
          const d = m[1]; j += m[0].length;
          const w = words(res);
          if (/^[0-9]+$/.test(d)) res = w[parseInt(d, 10)] || '';
          else if (d === '$') res = w[w.length - 1] || '';
          else if (d === '^') res = w[1] || '';
          else if (d === '*') res = w.slice(1).join(' ');
          else if (d[0] === '-') res = w.slice(0, (parseInt(d.slice(1), 10) || w.length - 1) + 1).join(' ');
          else if (d === 'p') this._histPrint = true;
          else if (d[0] === 's') { const sm = /^s\/([^/]*)\/([^/]*)/.exec(d); if (res.indexOf(sm[1]) < 0) throw Object.assign(new Error(this.flavor === 'zsh' ? 'zsh: substitution failed' : 'bash: :s/' + sm[1] + '/' + sm[2] + ': substitution failed'), { histErr: true }); res = res.replace(sm[1], sm[2]); }
          else if (d === 'h') res = res.replace(/\/[^/]*$/, '') || '.';
          else if (d === 't') res = res.replace(/^.*\//, '');
          else if (d === 'r') res = res.replace(/\.[^./]*$/, '');
          else if (d === 'e') { const em = /\.([^./]*)$/.exec(res); res = em ? em[1] : ''; }
        }
        out += res; i = j - 1; changed = true;
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
      let expanded;
      try { expanded = this.histExpand(line); }
      catch (e) { if (!e.histErr) throw e; io.err(e.message + '\n'); this.status = 1; return 1; }
      if (expanded !== line) { io.out(expanded + '\n'); line = expanded; }
      this.addHistory(line);
      if (this._histPrint) { this._histPrint = false; this.status = 0; return 0; }
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

    /** zsh-style secondary prompt naming what is still open (dquote>, heredoc>, cmdand>, ...). */
    continuationPrompt(line, e) {
      if (this.flavor !== 'zsh') return '> ';
      const m = e.message || '';
      if (/^unmatched "/.test(m)) return 'dquote> ';
      if (/^unmatched '/.test(m)) return 'quote> ';
      if (/^unmatched `/.test(m)) return 'bquote> ';
      if (/^unmatched \$\(/.test(m) || /unmatched \$\(\(/.test(m)) return 'cmdsubst> ';
      if (/^unmatched \$\{/.test(m)) return 'braceparam> ';
      if (/here-document/.test(m)) return 'heredoc> ';
      if (/trailing backslash/.test(m)) return '> ';
      const t = line.replace(/\s+$/, '');
      if (/&&$/.test(t)) return 'cmdand> ';
      if (/\|\|$/.test(t)) return 'cmdor> ';
      if (/\|$/.test(t)) return 'pipe> ';
      // innermost open construct
      const stack = [];
      for (const w of t.replace(/'[^']*'|"[^"]*"/g, '').split(/[\s;&|]+/)) {
        if (w === 'if') stack.push('if'); else if (w === 'then' || w === 'elif' || w === 'else') { if (stack[stack.length - 1] === 'if') stack[stack.length - 1] = 'then'; }
        else if (w === 'fi') stack.pop();
        else if (w === 'for' || w === 'select') stack.push('for'); else if (w === 'while') stack.push('while'); else if (w === 'until') stack.push('until');
        else if (w === 'do') { /* keeps loop kind */ } else if (w === 'done') stack.pop();
        else if (w === 'case') stack.push('case'); else if (w === 'esac') stack.pop();
        else if (w === '{') stack.push('cursh'); else if (w === '}') stack.pop();
      }
      const top = stack[stack.length - 1];
      if (top) return top + '> ';
      if ((t.match(/\(/g) || []).length > (t.match(/\)/g) || []).length) return 'subsh> ';
      return '> ';
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
            const ps2 = this.continuationPrompt(line, e);
            let more;
            try { more = await this.term.readLine({ prompt: ps2, history: [], continuation: true }); }
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
          case '=~': {
            let mm;
            try { mm = new RegExp(r).exec(l); } catch (e) { return false; }
            if (!mm) { if (sh.flavor !== 'zsh') sh.arrays.set('BASH_REMATCH', { assoc: false, v: [] }); return false; }
            if (sh.flavor === 'zsh') { sh.setVar('MATCH', mm[0]); sh.arrays.set('match', { assoc: false, v: Array.from(mm).slice(1).map((x) => (x == null ? '' : x)) }); }
            else sh.arrays.set('BASH_REMATCH', { assoc: false, v: Array.from(mm).map((x) => (x == null ? '' : x)) });
            return true;
          }
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
      const sh = this; const args = ctx.args.filter((a) => a !== '--' && a !== '-P' && a !== '-L');
      let target = args[0];
      const zsh = sh.flavor === 'zsh';
      const fail = (msg, t) => { ctx.err(zsh ? (sh.interactive ? '' : sh.msgPrefix()) + 'cd: ' + msg + ': ' + t + '\n' : sh.msgPrefix() + 'cd: ' + t + ': ' + msg + '\n'); return 1; };
      let print = false;
      if (args.length > 1) {
        if (zsh) return fail('string not in pwd', args[0]);
        ctx.err(sh.msgPrefix() + 'cd: too many arguments\n'); return 1;
      }
      if (target == null) { target = sh.getVar('HOME'); if (!target) { ctx.err(sh.msgPrefix() + 'cd: HOME not set\n'); return 1; } }
      else if (target === '-') { target = sh.getVar('OLDPWD'); if (!target) { ctx.err(sh.msgPrefix() + 'cd: ' + (zsh ? 'no such file or directory: ' : 'OLDPWD not set') + '\n'); return 1; } print = true; }
      const abs = VFS.abs(target, sh.cwd);
      let st;
      try { st = sh.machine.vfs.stat(abs, { cred: sh.cred }); }
      catch (e) { return fail(zsh ? sh.fsMsg(e) : e.message, target); }
      if (!st.isDir) return fail(zsh ? 'not a directory' : 'Not a directory', target);
      if (!sh.machine.vfs.access(sh.machine.vfs.lookup(abs), sh.cred, 'x')) return fail(zsh ? 'permission denied' : 'Permission denied', target);
      sh.setVar('OLDPWD', sh.cwd, true);
      sh.cwd = abs;
      sh.setVar('PWD', abs, true);
      if (print) ctx.out((zsh && abs === sh.user.home ? '~' : abs) + '\n');
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
      const LONG = { errexit: 'errexit', nounset: 'nounset', xtrace: 'xtrace', pipefail: 'pipefail', noclobber: 'noclobber', noglob: 'noglob', verbose: 'verbose', allexport: 'allexport' };
      const SHORT = { e: 'errexit', u: 'nounset', x: 'xtrace', C: 'noclobber', f: 'noglob', v: 'verbose', a: 'allexport' };
      for (let i = 0; i < a.length; i++) {
        if (a[i] === '--') { sh.positional = a.slice(i + 1); break; }
        if (/^[-+][a-zA-Z]+$/.test(a[i])) {
          const on = a[i][0] === '-';
          for (const c of a[i].slice(1)) {
            if (c === 'o') {
              const nm = a[++i];
              if (nm == null) { for (const k of Object.keys(LONG)) ctx.out(K.util.padEnd(k, 16) + (sh.opts[k] ? 'on' : 'off') + '\n'); continue; }
              if (LONG[nm]) sh.opts[nm] = on;
              else { ctx.err(sh.msgPrefix() + (sh.flavor === 'zsh' ? 'no such option: ' + nm : 'set: ' + nm + ': invalid option name') + '\n'); return 1; }
            } else if (SHORT[c]) sh.opts[SHORT[c]] = on;
          }
          continue;
        }
        sh.positional = a.slice(i); break;
      }
      return 0;
    },
    setopt(ctx) { for (const x of ctx.args) { const n = x.toLowerCase().replace(/_/g, ''); if (n in this.opts) this.opts[n] = true; else if (n.startsWith('no') && n.slice(2) in this.opts) this.opts[n.slice(2)] = false; } return 0; },
    unsetopt(ctx) { for (const a of ctx.args) { const n = a.toLowerCase().replace(/_/g, ''); if (n in this.opts) this.opts[n] = false; } return 0; },
    shopt(ctx) {
      let on = null; const names = [];
      for (const a of ctx.args) { if (a === '-s') on = true; else if (a === '-u') on = false; else if (a[0] !== '-') names.push(a); }
      let st = 0;
      for (const n of names) {
        if (n in this.opts && on != null) this.opts[n] = on;
        else if (n in this.opts) { ctx.out(K.util.padEnd(n, 16) + '\t' + (this.opts[n] ? 'on' : 'off') + '\n'); if (!this.opts[n]) st = 1; }
      }
      return st;
    }, autoload() { return 0; }, compinit() { return 0; },
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
      const sh = this; let exp = false; let ro = false; let assoc = false; let arr = false; let print = false;
      const q = (v) => (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(v) ? v : "'" + v.replace(/'/g, "'\\''") + "'");
      const names = [];
      for (const arg of ctx.args) {
        if (/^[-+][A-Za-z]+$/.test(arg)) {
          if (arg[0] === '+') continue;
          if (arg.includes('x')) exp = true;
          if (arg.includes('r')) ro = true;
          if (arg.includes('A')) assoc = true;
          if (arg.includes('a')) arr = true;
          if (arg.includes('p')) print = true;
          continue;
        }
        names.push(arg);
      }
      if (ctx.name === 'readonly') ro = true;
      if (!names.length) {
        if (ro) for (const k of Array.from(sh.readonly).sort()) ctx.out((sh.flavor === 'zsh' ? 'readonly ' : 'declare -r ') + k + '=' + q(sh.getVar(k) || '') + '\n');
        return 0;
      }
      let st = 0;
      for (const arg of names) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=([\s\S]*))?$/.exec(arg);
        if (!m) { ctx.err(sh.msgPrefix() + (sh.flavor === 'zsh' ? 'not valid in this context: ' + arg : ctx.name + ': `' + arg + "': not a valid identifier") + '\n'); st = 1; continue; }
        const n = m[1];
        if (print) {
          if (sh.arrays.has(n)) { const a = sh.arrays.get(n); ctx.out((sh.flavor === 'zsh' ? 'typeset -' + (a.assoc ? 'A' : 'a') + ' ' + n + '=(' : 'declare -' + (a.assoc ? 'A' : 'a') + ' ' + n + '=(') + sh.arrValues(n).map((x) => q(x)).join(' ') + ')\n'); }
          else if (sh.vars.has(n)) ctx.out((sh.flavor === 'zsh' ? 'typeset ' : 'declare -- ') + n + '=' + q(sh.vars.get(n)) + '\n');
          else { ctx.err(sh.msgPrefix() + (sh.flavor === 'zsh' ? n + ' not found' : ctx.name + ': ' + n + ': not found') + '\n'); st = 1; }
          continue;
        }
        if (sh.readonly.has(n)) { ctx.err(sh.msgPrefix() + (sh.flavor === 'zsh' ? 'read-only variable: ' + n : n + ': readonly variable') + '\n'); st = 1; continue; }
        if (assoc && !(sh.arrays.has(n) && sh.arrays.get(n).assoc)) { sh.vars.delete(n); sh.arrays.set(n, { assoc: true, v: new Map() }); }
        else if (arr && !sh.arrays.has(n)) { const cur = sh.vars.get(n); sh.vars.delete(n); sh.arrays.set(n, { assoc: false, v: cur == null || cur === '' ? [] : [cur] }); }
        if (m[2] != null) sh.setVar(n, m[2], exp || sh.exported.has(n));
        else if (!sh.arrays.has(n) && !sh.vars.has(n) && ctx.name !== 'readonly' && !exp) { /* declared, unset */ }
        else if (exp) sh.exported.add(n);
        if (ro) sh.readonly.add(n);
      }
      return st;
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
      catch (e) { ctx.err(sh.flavor === 'zsh' ? ctx.name + ': ' + sh.fsMsg(e) + ': ' + ctx.args[0] + '\n' : sh.msgPrefix() + ctx.args[0] + ': ' + e.message + '\n'); return 1; }
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
      const flags = ctx.args.filter((n) => /^-[atpfPw]+$/.test(n)).join('');
      const all = flags.includes('a'); const tOnly = flags.includes('t'); const wOnly = flags.includes('w');
      for (const n of ctx.args) {
        if (/^-[atpfPw]+$/.test(n)) continue;
        let found = false;
        const say = (kind, text) => {
          found = true;
          if (tOnly) ctx.out(kind + '\n');
          else if (wOnly) ctx.out(n + ': ' + kind + '\n');
          else ctx.out(text + '\n');
        };
        if (sh.aliases.has(n)) { say('alias', n + ' is an alias for ' + sh.aliases.get(n)); if (!all) continue; }
        if (K.shlex.RESERVED.has(n)) { say('keyword', n + ' is a reserved word'); if (!all) continue; }
        if (sh.functions.has(n)) { say('function', n + ' is a shell function'); if (!all) continue; }
        if (BUILTINS[n]) { say('builtin', n + ' is a shell builtin'); if (!all) continue; }
        const paths = [];
        const p = sh.which(n);
        if (p) paths.push(p);
        if (all) {
          for (const dir of (sh.getVar('PATH') || '').split(':')) {
            if (!dir || n.indexOf('/') >= 0) continue;
            const q = VFS.abs(dir + '/' + n, sh.cwd);
            try { const t = sh.machine.vfs.stat(q, { cred: sh.cred }); if (t.isFile && paths.indexOf(q) < 0 && sh.machine.vfs.access(sh.machine.vfs.lookup(q), sh.cred, 'x')) paths.push(q); } catch (e) { /* none */ }
          }
        }
        for (const q of paths) say('file', n + ' is ' + q);
        if (!found) { if (!tOnly) { if (wOnly) ctx.out(n + ': none\n'); else if (sh.flavor === 'zsh') ctx.out(n + ' not found\n'); else ctx.err(sh.msgPrefix() + 'type: ' + n + ': not found\n'); } st = 1; }
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
      const sh = this; const a = ctx.args.slice(); let prompt = ''; let hidden = false; let raw = false; let arrName = null; let nchars = null; const names = [];
      for (let i = 0; i < a.length; i++) {
        if (a[i] === '-p') { prompt = a[++i] || ''; continue; }
        if (a[i] === '-a' || a[i] === '-A') { arrName = a[++i]; continue; }
        if (a[i] === '-n' || a[i] === '-N') { nchars = parseInt(a[++i], 10) || null; continue; }
        if (a[i] === '-d' || a[i] === '-t' || a[i] === '-u' || a[i] === '-i') { i++; continue; }
        if (/^-[a-zA-Z]+$/.test(a[i])) { if (a[i].includes('s')) hidden = true; if (a[i].includes('r')) raw = true; continue; }
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\?(.*)$/.exec(a[i]); // zsh: read "var?prompt"
        if (m && sh.flavor === 'zsh') { names.push(m[1]); prompt = m[2]; continue; }
        names.push(a[i]);
      }
      if (!names.length && arrName == null) names.push('REPLY');
      let line = await ctx.readLine(prompt, { hidden });
      const eof = line == null;
      if (eof) line = '';
      if (nchars != null) line = line.slice(0, nchars);
      if (!raw) line = line.replace(/\\(.)/g, '$1');
      const ifsV = sh.vars.get('IFS');
      const ifs = ifsV == null ? ' \t\n' : ifsV;
      const isWs = (c) => c === ' ' || c === '\t' || c === '\n';
      const fields = [];
      if (ifs === '') fields.push(line);
      else {
        let i = 0; const n = line.length;
        const skipWs = () => { while (i < n && ifs.indexOf(line[i]) >= 0 && isWs(line[i])) i++; };
        skipWs();
        const limit = arrName != null ? Infinity : names.length;
        while (i < n && fields.length < limit) {
          if (fields.length === limit - 1) { let rest = line.slice(i); while (rest.length && ifs.indexOf(rest[rest.length - 1]) >= 0 && isWs(rest[rest.length - 1])) rest = rest.slice(0, -1); fields.push(rest); i = n; break; }
          let j = i; while (j < n && ifs.indexOf(line[j]) < 0) j++;
          fields.push(line.slice(i, j)); i = j;
          if (i < n) { if (!isWs(line[i])) i++; skipWs(); }
        }
      }
      if (arrName != null) { sh.vars.delete(arrName); sh.arrays.set(arrName, { assoc: false, v: fields }); return eof ? 1 : 0; }
      names.forEach((nm, i) => { sh.setVar(nm, fields[i] == null ? '' : fields[i]); });
      return eof ? 1 : 0;
    },
    mapfile(ctx) {
      const sh = this; let strip = false; let name = null;
      for (const x of ctx.args) { if (/^-[a-zA-Z]+$/.test(x)) { if (x.includes('t')) strip = true; } else name = x; }
      name = name || (sh.flavor === 'zsh' ? 'reply' : 'MAPFILE');
      const text = ctx.stdin == null ? '' : ctx.stdin;
      const items = text === '' ? [] : text.split(/(?<=\n)/).map((l) => (strip ? l.replace(/\n$/, '') : l));
      sh.vars.delete(name); sh.arrays.set(name, { assoc: false, v: items });
      return 0;
    },
    readarray(ctx) { return BUILTINS.mapfile.call(this, ctx); },
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
    bg(ctx) {
      const found = this.findJob(ctx.args[0], 'bg');
      if (found.err) { ctx.err(found.err); return 1; }
      if (this.flavor === 'zsh') { ctx.err('bg: job already in background\n'); return 1; }
      ctx.err(this.msgPrefix() + 'bg: job ' + found.job.id + ' already in background\n');
      return 0;
    },
    trap(ctx) {
      const sh = this; const a = ctx.args.slice();
      const NUM = { 0: 'EXIT', 1: 'HUP', 2: 'INT', 3: 'QUIT', 9: 'KILL', 15: 'TERM', 17: 'CHLD', 18: 'CONT', 19: 'STOP' };
      const norm = (x) => { x = String(x).toUpperCase().replace(/^SIG/, ''); return /^\d+$/.test(x) ? (NUM[parseInt(x, 10)] || x) : x; };
      if (a[0] === '-l') { ctx.out('HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM\n'); return 0; }
      if (!a.length || a[0] === '-p') { for (const [sig, cmd] of sh.traps) ctx.out("trap -- '" + cmd.replace(/'/g, "'\\''") + "' " + (sh.flavor === 'zsh' ? 'SIG' + sig : sig) + '\n'); return 0; }
      if (a[0] === '--') a.shift();
      let cmd = a.shift();
      if (!a.length) { a.push(cmd); cmd = '-'; }
      let st = 0;
      for (const sg of a) {
        const n = norm(sg);
        if (!/^(EXIT|ERR|DEBUG|RETURN|HUP|INT|QUIT|ILL|TRAP|ABRT|BUS|FPE|KILL|USR1|SEGV|USR2|PIPE|ALRM|TERM|CHLD|CONT|STOP|TSTP|TTIN|TTOU|WINCH)$/.test(n)) { ctx.err(sh.msgPrefix() + (sh.flavor === 'zsh' ? 'trap: undefined signal: ' + sg : 'trap: ' + sg + ': invalid signal specification') + '\n'); st = 1; continue; }
        if (cmd === '-') sh.traps.delete(n); else sh.traps.set(n, cmd);
      }
      return st;
    },
    let(ctx) {
      const sh = this; let v = 0;
      if (!ctx.args.length) { ctx.err(sh.msgPrefix() + 'let: expression expected\n'); return 1; }
      for (const e of ctx.args) {
        try { v = arith(e, (n) => sh.getVar(n), (n, val) => sh.setVar(n, val)); }
        catch (err) { ctx.err(sh.msgPrefix() + (sh.flavor === 'zsh' ? '' : 'let: ') + err.message + '\n'); return 1; }
      }
      return v === 0 ? 1 : 0;
    },
    getopts(ctx) {
      const sh = this;
      if (ctx.args.length < 2) { ctx.err(sh.msgPrefix() + (sh.flavor === 'zsh' ? 'not enough arguments' : 'getopts: usage: getopts optstring name [arg ...]') + '\n'); return sh.flavor === 'zsh' ? 1 : 2; }
      const spec = ctx.args[0]; const name = ctx.args[1];
      const args = ctx.args.length > 2 ? ctx.args.slice(2) : sh.positional;
      const silent = spec[0] === ':'; const sp = spec.replace(/^:/, '');
      let idx = sh.optind >= 1 ? sh.optind : 1;
      let sub = sh._optSub || 0;
      const done = () => { sh._optSub = 0; sh.optind = idx; sh.setVar(name, '?'); return 1; };
      const arg = args[idx - 1];
      if (arg === undefined || arg === '-' || arg[0] !== '-') return done();
      if (arg === '--') { idx++; return done(); }
      const ch = arg[1 + sub]; const pos = sp.indexOf(ch);
      const who = sh.scriptName || sh.flavor;
      const adv = () => { sub++; if (1 + sub >= arg.length) { idx++; sub = 0; } };
      if (pos < 0 || ch === ':') {
        if (silent) { sh.setVar(name, '?'); sh.setVar('OPTARG', ch); } else { ctx.err(who + ': illegal option -- ' + ch + '\n'); sh.setVar(name, '?'); sh.unsetVar('OPTARG'); }
        adv();
      } else if (sp[pos + 1] === ':') {
        if (arg.length > 2 + sub) { sh.setVar('OPTARG', arg.slice(2 + sub)); sh.setVar(name, ch); idx++; sub = 0; }
        else if (idx < args.length) { sh.setVar('OPTARG', args[idx]); sh.setVar(name, ch); idx += 2; sub = 0; }
        else {
          if (silent) { sh.setVar(name, ':'); sh.setVar('OPTARG', ch); } else { ctx.err(who + ': option requires an argument -- ' + ch + '\n'); sh.setVar(name, '?'); sh.unsetVar('OPTARG'); }
          idx++; sub = 0;
        }
      } else { sh.setVar(name, ch); sh.unsetVar('OPTARG'); adv(); }
      sh._optSub = sub; sh.optind = idx;
      return 0;
    },
    dirs(ctx) {
      const sh = this; const home = sh.user.home;
      const ab = (p) => (p === home ? '~' : home !== '/' && p.indexOf(home + '/') === 0 ? '~' + p.slice(home.length) : p);
      const all = [sh.cwd].concat(sh.dirStack).map(ab);
      if (ctx.args.includes('-c')) { sh.dirStack = []; return 0; }
      if (ctx.args.includes('-v')) { all.forEach((d, i) => ctx.out(i + '\t' + d + '\n')); return 0; }
      if (ctx.args.includes('-p')) { all.forEach((d) => ctx.out(d + '\n')); return 0; }
      ctx.out(all.join(' ') + '\n'); return 0;
    },
    pushd(ctx) {
      const sh = this; const args = ctx.args.filter((x) => x !== '--');
      const old = sh.cwd;
      if (!args.length) {
        if (!sh.dirStack.length) { ctx.err(sh.flavor === 'zsh' ? 'pushd: no other directory\n' : sh.msgPrefix() + 'pushd: no other directory\n'); return 1; }
        const top = sh.dirStack.shift(); sh.dirStack.unshift(old);
        const st = BUILTINS.cd.call(sh, sh.makeCtx(['cd', top], ctx.io)); if (st) { sh.dirStack.shift(); sh.dirStack.unshift(top); return st; }
      } else {
        const st = BUILTINS.cd.call(sh, sh.makeCtx(['cd', args[0]], ctx.io));
        if (st) return st;
        sh.dirStack.unshift(old);
      }
      return BUILTINS.dirs.call(sh, ctx);
    },
    popd(ctx) {
      const sh = this;
      if (!sh.dirStack.length) { ctx.err(sh.flavor === 'zsh' ? 'popd: directory stack empty\n' : sh.msgPrefix() + 'popd: directory stack empty\n'); return 1; }
      const top = sh.dirStack[0];
      const st = BUILTINS.cd.call(sh, sh.makeCtx(['cd', top], ctx.io));
      if (st) return st;
      sh.dirStack.shift();
      return BUILTINS.dirs.call(sh, ctx);
    },
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
    let cmdStr = null; let login = false; let noexec = false; const setOpts = [];
    const FLAGS = { x: 'xtrace', e: 'errexit', u: 'nounset', f: 'noglob', C: 'noclobber' };
    while (a.length && (a[0][0] === '-' || a[0][0] === '+') && a[0] !== '-' && a[0] !== '+') {
      const f = a.shift();
      if (f === '--') break;
      if (f === '--version') { ctx.out(flavor === 'zsh' ? 'zsh 5.9.1 (x86_64-debian-linux-gnu)\n' : flavor === 'bash' ? 'GNU bash, version 5.3.3(1)-release (x86_64-pc-linux-gnu)\n' : 'dash 0.5.12\n'); return 0; }
      if (f === '--login') { login = true; continue; }
      if (f === '-o' || f === '+o') { const o = a.shift(); if (o && f === '-o') setOpts.push(o); continue; }
      if (f[0] === '+' || f[1] === '-') continue;
      let stop = false;
      for (const ch of f.slice(1)) {
        if (ch === 'c') { cmdStr = a.shift(); if (cmdStr == null) return ctx.fail('-c: option requires an argument', 2); stop = true; }
        else if (ch === 'l') login = true;
        else if (ch === 'n') noexec = true;
        else if (FLAGS[ch]) setOpts.push(FLAGS[ch]);
      }
      if (stop) break;
    }
    const child = sh.child({ flavor, interactive: cmdStr == null && !a.length && ctx.stdin == null, login });
    const LONG = { xtrace: 'xtrace', errexit: 'errexit', nounset: 'nounset', noglob: 'noglob', noclobber: 'noclobber', pipefail: 'pipefail' };
    for (const o of setOpts) if (LONG[o]) child.opts[LONG[o]] = true;
    const syntaxOnly = (text) => {
      try { K.shlex.parse(text, child.aliases); return 0; }
      catch (e) { if (!(e instanceof ParseError)) throw e; ctx.err(child.syntaxMessage(e) + '\n'); return 2; }
    };
    try {
      if (cmdStr != null) {
        child.scriptName = a[0] || flavor; child.positional = a.slice(1); child.cmdString = true;
        if (noexec) return syntaxOnly(cmdStr);
        return await child.execSource(cmdStr, ctx.io);
      }
      if (a.length) {
        let text;
        try { text = sh.fs.read(a[0]); }
        catch (e) {
          if (e.code === 'EISDIR') { ctx.err(flavor + ': ' + a[0] + ': Is a directory\n'); return 126; }
          ctx.err(flavor + ': ' + (flavor === 'zsh' ? "can't open input file: " + a[0] : a[0] + ': ' + e.message) + '\n'); return 127;
        }
        child.scriptName = a[0]; child.positional = a.slice(1);
        if (noexec) return syntaxOnly(text);
        return await child.execSource(text, ctx.io);
      }
      if (ctx.stdin != null) return await child.execSource(ctx.stdin, Object.assign({}, ctx.io, { stdin: '' }));
      return await child.repl();
    } catch (e) {
      if (e instanceof K.ExitSignal) return e.code;
      if (e instanceof ReturnSignal) return e.code;
      throw e;
    } finally { try { await child.exitTrap(ctx.io); } catch (e) { /* trap failed */ } child.dispose(); }
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
      if (!g.rest.length && !o.i && !o.s && !o.l && !o.v && !o.k) { ctx.err('usage: sudo -h | -K | -k | -V\nusage: sudo -v [-ABkNnS] [-g group] [-h host] [-p prompt] [-u user]\nusage: sudo -l [-ABkNnS] [-g group] [-h host] [-p prompt] [-U user] [-u user] [command [arg ...]]\nusage: sudo [-ABbEHkNnPS] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] [VAR=value] [-i | -s] [command [arg ...]]\n'); return 1; }
      if (o.n && sh.user.uid !== 0) {
        const stamp = m.sudoStamp[sh.user.name];
        if (!(stamp != null && K.clock.now() - stamp < SUDO_TIMEOUT && m.canSudo(sh.user.name))) { ctx.err('sudo: a password is required\n'); return 1; }
      }
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
    name: 'timeout', pkg: 'coreutils', summary: 'run a command with a time limit',
    synopsis: 'timeout [OPTION] DURATION COMMAND [ARG]...',
    man: 'Start COMMAND, and kill it if still running after DURATION.\n\n  -k, --kill-after=DURATION  also send a KILL signal if COMMAND is still running this long after the initial signal was sent\n  -s, --signal=SIGNAL        specify the signal to be sent on timeout\n      --preserve-status      exit with the same status as COMMAND, even when the command times out\n\nDURATION is a floating point number with an optional suffix: s (seconds, the default), m, h or d. A duration of 0 disables the timeout.\nIf the command times out, the exit status is 124 (or the status of COMMAND with --preserve-status).',
    async run(ctx) {
      const g = K.getopt(ctx.args, { short: 's:k:fp', long: ['signal=', 'kill-after=', 'preserve-status', 'foreground', 'verbose', 'help', 'version'], stopAtNonOption: true });
      if (g.err) return ctx.fail(g.err + "\nTry 'timeout --help' for more information.", 125);
      if (g.opts.help) { ctx.out('Usage: timeout [OPTION] DURATION COMMAND [ARG]...\n  or:  timeout [OPTION]\nStart COMMAND, and kill it if still running after DURATION.\n'); return 0; }
      if (g.opts.version) { ctx.out('timeout (GNU coreutils) 9.7\n'); return 0; }
      if (g.rest.length < 2) { ctx.err('timeout: missing operand\nTry \'timeout --help\' for more information.\n'); return 125; }
      const m = /^(\d*\.?\d+)([smhd]?)$/.exec(g.rest[0]);
      if (!m) return ctx.fail("invalid time interval '" + g.rest[0] + "'\nTry 'timeout --help' for more information.", 125);
      const secs = parseFloat(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2] || 's']);
      const sh = ctx.shell; const argv = g.rest.slice(1);
      if (!sh.which(argv[0]) && argv[0].indexOf('/') < 0 && !sh.functions.has(argv[0]) && !K.builtins[argv[0]]) return ctx.fail("failed to run command '" + argv[0] + "': No such file or directory", 127);
      const sig = new Signal(); const off = ctx.io.sig ? ctx.io.sig.onAbort(() => sig.abort()) : null;
      let timedOut = false; let timer = null; const t0 = K.clock.now();
      if (secs > 0 && !K.clock._virtual) timer = setTimeout(() => { timedOut = true; sig.abort(); }, secs * 1000 * K.settings.timeScale);
      let code; let held = '';
      // with the virtual clock a sleeping command returns at once, so its output is held back and dropped when the limit was exceeded
      const tio = Object.assign({}, ctx.io, { sig });
      if (K.clock._virtual && secs > 0) tio.out = (x) => { held += x; };
      try { code = await sh.execArgv(argv, tio, { external: !!sh.which(argv[0]) }); }
      catch (e) { if (e instanceof K.Interrupt && timedOut) code = 143; else throw e; }
      finally { if (timer) clearTimeout(timer); if (off) off(); }
      if (!timedOut && secs > 0 && K.clock._virtual && K.clock.now() - t0 > secs * 1000) timedOut = true;
      if (held && !timedOut) ctx.io.out(held);
      if (timedOut) return g.opts['preserve-status'] ? code : 124;
      return code;
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
