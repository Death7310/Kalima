/* Kalima — core namespace, utilities, clock, getopt.
 * Every source file is a classic script that attaches to the global `K`.
 * No modules, no dependencies: the whole app must run from file:// offline.
 */
;(function (root) {
  'use strict';
  const K = (root.K = root.K || {});

  K.version = '0.1.0';
  K.distro = {
    id: 'kali',
    name: 'Kali GNU/Linux',
    pretty: 'Kali GNU/Linux Rolling',
    release: '2026.3',
    codename: 'kali-rolling',
    kernel: '7.1.5-kali1-amd64',
    kernelBuild: '#1 SMP PREEMPT_DYNAMIC Kali 7.1.5-1kali1 (2026-10-12)',
    arch: 'x86_64',
  };

  /* ------------------------------------------------------------------ errors */
  class Interrupt extends Error {
    constructor() { super('Interrupt'); this.name = 'Interrupt'; }
  }
  class ExitSignal extends Error {
    constructor(code) { super('exit'); this.name = 'ExitSignal'; this.code = code | 0; }
  }
  K.Interrupt = Interrupt;
  K.ExitSignal = ExitSignal;

  /* ----------------------------------------------------------------- emitter */
  class Emitter {
    constructor() { this._h = Object.create(null); }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return () => this.off(ev, fn); }
    off(ev, fn) { const a = this._h[ev]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    emit(ev, data) {
      const a = this._h[ev]; if (!a) return;
      for (const fn of a.slice()) { try { fn(data); } catch (e) { if (K.debug) console.error(e); } }
    }
  }
  K.Emitter = Emitter;
  K.events = new Emitter();

  /* -------------------------------------------------------------- hash / prng */
  function hash32(str) {
    let h = 0x811c9dc5;
    str = String(str);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }
  /** Deterministic PRNG. `seed` may be a string or number. Returns () => float in [0,1). */
  function prng(seed) {
    let a = typeof seed === 'number' ? seed >>> 0 : hash32(seed);
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------- clock */
  // Real mode: wall clock. Virtual mode (tests): frozen time advanced by ctx.sleep().
  K.clock = {
    _virtual: false,
    _t: 0,
    now() { return this._virtual ? this._t : Date.now(); },
    date() { return new Date(this.now()); },
    useVirtual(startMs) { this._virtual = true; this._t = startMs == null ? Date.UTC(2026, 10, 13, 14, 30, 0) : startMs; },
    useReal() { this._virtual = false; },
    advance(ms) { if (this._virtual) this._t += ms; },
  };
  // Moment the simulated machine "booted" (used by uptime, dmesg, ps start times).
  K.bootTime = null;
  K.getBootTime = function () {
    if (K.bootTime == null) K.bootTime = K.clock.now() - (3 * 3600 + 17 * 60 + 42) * 1000;
    return K.bootTime;
  };

  /* ---------------------------------------------------------------- settings */
  K.settings = {
    timeScale: 1,      // 1 = real time waits (ping waits 1s between probes). 0 = instant.
    scopeGuard: true,  // active scanners refuse targets outside the engagement scope
  };

  /* -------------------------------------------------------------------- ansi */
  const ESC = '\x1b[';
  function sgr(open, close) { return (s) => ESC + open + 'm' + s + ESC + close + 'm'; }
  K.c = {
    reset: ESC + '0m',
    bold: sgr(1, 22), dim: sgr(2, 22), italic: sgr(3, 23), underline: sgr(4, 24), inverse: sgr(7, 27),
    black: sgr(30, 39), red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39),
    blue: sgr(34, 39), magenta: sgr(35, 39), cyan: sgr(36, 39), white: sgr(37, 39),
    gray: sgr(90, 39), brightRed: sgr(91, 39), brightGreen: sgr(92, 39), brightYellow: sgr(93, 39),
    brightBlue: sgr(94, 39), brightMagenta: sgr(95, 39), brightCyan: sgr(96, 39), brightWhite: sgr(97, 39),
    /** raw SGR: K.c.sgr('1;34', 'text') */
    sgr(codes, s) { return ESC + codes + 'm' + s + ESC + '0m'; },
  };
  const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

  /* ------------------------------------------------------------------- utils */
  const util = (K.util = {
    hash32,
    prng,
    stripAnsi(s) { return String(s).replace(ANSI_RE, ''); },
    /** visible width (ANSI stripped; wide chars counted as 1) */
    width(s) { return util.stripAnsi(s).length; },
    padEnd(s, n, ch) { s = String(s); const w = util.width(s); return w >= n ? s : s + (ch || ' ').repeat(n - w); },
    padStart(s, n, ch) { s = String(s); const w = util.width(s); return w >= n ? s : (ch || ' ').repeat(n - w) + s; },
    byteLen(s) {
      s = String(s); let n = 0;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3;
      }
      return n;
    },
    /** UTF-8 encode a JS string to an array of byte values (0..255). */
    toBytes(s) {
      s = String(s); const out = [];
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
          const c2 = s.charCodeAt(++i);
          c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
          out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return out;
    },
    /** UTF-8 decode an array of byte values to a JS string (invalid sequences -> U+FFFD). */
    fromBytes(bytes) {
      let s = '';
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i] & 255;
        if (b < 0x80) s += String.fromCharCode(b);
        else if (b >= 0xc2 && b < 0xe0 && i + 1 < bytes.length) s += String.fromCharCode(((b & 31) << 6) | (bytes[++i] & 63));
        else if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) {
          s += String.fromCharCode(((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)); i += 2;
        } else if (b >= 0xf0 && b < 0xf5 && i + 3 < bytes.length) {
          const cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
          s += String.fromCodePoint(cp); i += 3;
        } else s += '�';
      }
      return s;
    },
    /** Human size like `ls -h` (1.2K, 34M). */
    humanSize(n) {
      if (n < 1024) return String(n);
      const u = ['K', 'M', 'G', 'T', 'P']; let i = -1; let v = n;
      do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
      return (v < 10 ? (Math.ceil(v * 10) / 10).toFixed(1) : String(Math.ceil(v))) + u[i];
    },
    /** Lay a list of names out in terminal columns, column-major like `ls`. */
    columns(items, termWidth) {
      if (!items.length) return '';
      termWidth = termWidth || 80;
      const w = Math.max.apply(null, items.map(util.width)) + 2;
      const ncol = Math.max(1, Math.floor(termWidth / w));
      const nrow = Math.ceil(items.length / ncol);
      const lines = [];
      for (let r = 0; r < nrow; r++) {
        let line = '';
        for (let c = 0; c < ncol; c++) {
          const i = c * nrow + r;
          if (i >= items.length) continue;
          const last = (c + 1) * nrow + r >= items.length;
          line += last ? items[i] : util.padEnd(items[i], w);
        }
        lines.push(line);
      }
      return lines.join('\n') + '\n';
    },
    lines(s) {
      if (s == null || s === '') return [];
      const a = String(s).split('\n');
      if (a[a.length - 1] === '') a.pop();
      return a;
    },
    escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); },
    /** Shell glob -> RegExp source (anchored). Supports * ? [abc] [!abc]. */
    globToRe(glob, flags) {
      let re = '';
      for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === '*') re += '.*';
        else if (ch === '?') re += '.';
        else if (ch === '[') {
          const j = glob.indexOf(']', i + 2);
          if (j < 0) { re += '\\['; continue; }
          let cls = glob.slice(i + 1, j);
          if (cls[0] === '!' || cls[0] === '^') cls = '^' + cls.slice(1);
          re += '[' + cls.replace(/\\/g, '\\\\') + ']';
          i = j;
        } else if (ch === '\\' && i + 1 < glob.length) { re += util.escapeRe(glob[++i]); }
        else re += util.escapeRe(ch);
      }
      return new RegExp('^' + re + '$', flags || '');
    },
    /* ---- dates ---- */
    MONTHS: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    DAYS: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    pad2(n) { return (n < 10 ? '0' : '') + n; },
    /** `ls -l` style timestamp: "Nov 13 14:30" or "Nov 13  2025" when older than ~6 months. (UTC) */
    lsDate(ms) {
      const d = new Date(ms); const now = K.clock.now();
      const mon = util.MONTHS[d.getUTCMonth()]; const day = util.padStart(d.getUTCDate(), 2);
      if (Math.abs(now - ms) > 15778800000) return mon + ' ' + day + '  ' + d.getUTCFullYear();
      return mon + ' ' + day + ' ' + util.pad2(d.getUTCHours()) + ':' + util.pad2(d.getUTCMinutes());
    },
    /** "2026-11-13 14:30:05" (UTC) */
    isoDate(ms) {
      const d = new Date(ms);
      return d.getUTCFullYear() + '-' + util.pad2(d.getUTCMonth() + 1) + '-' + util.pad2(d.getUTCDate()) + ' ' +
        util.pad2(d.getUTCHours()) + ':' + util.pad2(d.getUTCMinutes()) + ':' + util.pad2(d.getUTCSeconds());
    },
    /** `date` default format: "Fri Nov 13 02:30:05 PM UTC 2026" */
    dateString(ms) {
      const d = new Date(ms); let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
      return util.DAYS[d.getUTCDay()] + ' ' + util.MONTHS[d.getUTCMonth()] + ' ' + util.padStart(d.getUTCDate(), 2) + ' ' +
        util.pad2(h) + ':' + util.pad2(d.getUTCMinutes()) + ':' + util.pad2(d.getUTCSeconds()) + ' ' + ap + ' UTC ' + d.getUTCFullYear();
    },
    /** syslog style: "Nov 13 14:30:05" */
    syslogDate(ms) {
      const d = new Date(ms);
      return util.MONTHS[d.getUTCMonth()] + ' ' + util.padStart(d.getUTCDate(), 2) + ' ' + util.pad2(d.getUTCHours()) + ':' +
        util.pad2(d.getUTCMinutes()) + ':' + util.pad2(d.getUTCSeconds());
    },
    /* ---- IPv4 ---- */
    isIPv4(s) {
      const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s));
      return !!m && m.slice(1).every((x) => +x <= 255);
    },
    ipToInt(ip) { const p = String(ip).split('.'); return (((+p[0] << 24) >>> 0) + (+p[1] << 16) + (+p[2] << 8) + +p[3]) >>> 0; },
    intToIp(n) { n = n >>> 0; return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); },
    /** Parse "10.10.10.0/24" -> {base, mask, bits, first, last, network, broadcast, size} (ints) */
    parseCidr(cidr) {
      const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/.exec(String(cidr));
      if (!m || !util.isIPv4(m[1])) return null;
      const bits = m[2] == null ? 32 : +m[2];
      if (bits > 32) return null;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      const ip = util.ipToInt(m[1]);
      const network = (ip & mask) >>> 0;
      const broadcast = (network | (~mask >>> 0)) >>> 0;
      return { ip, bits, mask, network, broadcast, size: broadcast - network + 1 };
    },
    inCidr(ip, cidr) {
      const c = util.parseCidr(cidr); if (!c || !util.isIPv4(ip)) return false;
      return ((util.ipToInt(ip) & c.mask) >>> 0) === c.network;
    },
    maskFromBits(bits) { return util.intToIp(bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0); },
    isPrivateIp(ip) {
      return util.inCidr(ip, '10.0.0.0/8') || util.inCidr(ip, '172.16.0.0/12') || util.inCidr(ip, '192.168.0.0/16') ||
        util.inCidr(ip, '127.0.0.0/8') || util.inCidr(ip, '169.254.0.0/16');
    },
    /** deterministic MAC from a seed string, with a given OUI prefix ("08:00:27") */
    mac(seed, oui) {
      const r = prng('mac:' + seed);
      const hex = () => ('0' + Math.floor(r() * 256).toString(16)).slice(-2);
      return (oui || '08:00:27') + ':' + hex() + ':' + hex() + ':' + hex();
    },
    clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); },
    deepClone(o) { return JSON.parse(JSON.stringify(o)); },
  });

  /* ------------------------------------------------------------------ getopt */
  /**
   * GNU-style option parser.
   *   K.getopt(args, { short: 'c:i:nq', long: ['count=', 'help', 'color=?'], stopAtNonOption: false })
   * short: letters; `x:` requires an argument, `x::` takes an optional attached argument.
   * long:  names; `name=` requires an argument, `name=?` optional (--name=val only).
   * alias: { count: 'c' } maps a long name onto another key so both land in the same slot.
   * Returns { opts, all, count, rest, err }:
   *   opts[name]  = true | string (last occurrence)
   *   all[name]   = array of every value given
   *   count[name] = number of occurrences (e.g. -vvv -> 3)
   *   seq = every [name, value] in command-line order (for options whose order matters, like od -c -x)
   *   rest        = positional arguments
   *   err         = null | GNU-style message without the program name, e.g. "invalid option -- 'z'"
   */
  K.getopt = function (args, spec) {
    spec = spec || {};
    const short = {}; const long = {};
    const s = spec.short || '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (s[i + 1] === ':' && s[i + 2] === ':') { short[ch] = 'opt'; i += 2; }
      else if (s[i + 1] === ':') { short[ch] = 'req'; i += 1; }
      else short[ch] = 'none';
    }
    for (const l of spec.long || []) {
      if (l.endsWith('=?')) long[l.slice(0, -2)] = 'opt';
      else if (l.endsWith('=')) long[l.slice(0, -1)] = 'req';
      else long[l] = 'none';
    }
    const alias = spec.alias || {};
    const res = { opts: {}, all: {}, count: {}, seq: [], rest: [], err: null };
    const set = (name, val) => {
      name = alias[name] || name;
      res.opts[name] = val;
      (res.all[name] = res.all[name] || []).push(val);
      res.count[name] = (res.count[name] || 0) + 1;
      res.seq.push([name, val]);
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { res.rest.push.apply(res.rest, args.slice(i + 1)); break; }
      if (a.startsWith('--') && a.length > 2) {
        const eq = a.indexOf('=');
        let name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
        const val = eq >= 0 ? a.slice(eq + 1) : null;
        if (!(name in long)) {
          const cands = Object.keys(long).filter((k) => k.startsWith(name));
          if (cands.length === 1) name = cands[0];
          else if (cands.length > 1) { res.err = "option '--" + name + "' is ambiguous"; return res; }
          else { res.err = "unrecognized option '--" + name + "'"; return res; }
        }
        const kind = long[name];
        if (kind === 'none') {
          if (val != null) { res.err = "option '--" + name + "' doesn't allow an argument"; return res; }
          set(name, true);
        } else if (kind === 'req') {
          if (val != null) set(name, val);
          else if (i + 1 < args.length) set(name, args[++i]);
          else { res.err = "option '--" + name + "' requires an argument"; return res; }
        } else set(name, val == null ? true : val);
        continue;
      }
      if (a[0] === '-' && a.length > 1 && !(spec.negativeNumbers && /^-\d/.test(a))) {
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          const kind = short[ch];
          if (!kind) { res.err = "invalid option -- '" + ch + "'"; return res; }
          if (kind === 'none') { set(ch, true); continue; }
          const attached = a.slice(j + 1);
          if (kind === 'req') {
            if (attached) set(ch, attached);
            else if (i + 1 < args.length) set(ch, args[++i]);
            else { res.err = "option requires an argument -- '" + ch + "'"; return res; }
          } else set(ch, attached || true);
          break;
        }
        continue;
      }
      if (spec.stopAtNonOption) { res.rest.push.apply(res.rest, args.slice(i)); break; }
      res.rest.push(a);
    }
    return res;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
