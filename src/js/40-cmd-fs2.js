/* Kalima — searching the filesystem and archives: find, tar, gzip, zip, locate, dd and friends.
 * Archives are stored in the real container layouts (ustar headers, gzip header and trailer, zip
 * local headers) around a simulated compressor, so `file` recognises them and tar/gzip/zip
 * round-trip names, modes, owners and contents inside the simulator. */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;

  const q = (s) => "'" + s + "'";
  const isFsErr = (e) => e && e.code && typeof e.message === 'string' && e.constructor && e.constructor.name === 'FsError';
  const pad = (s, n) => U.padStart(s, n);
  const joinPath = (dir, name) => (dir.endsWith('/') ? dir + name : dir + '/' + name);
  const baseName = (p) => { const t = p.replace(/\/+$/, ''); return t === '' ? (p ? '/' : '') : t.slice(t.lastIndexOf('/') + 1); };
  const dirName = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '.' : i === 0 ? '/' : p.slice(0, i); };
  const DAY = 86400000;

  function modeString(st) {
    const t = { d: 'd', l: 'l', c: 'c', f: '-' }[st.type] || '-';
    const m = st.mode;
    const tri = (sh, sp, ch) => {
      const b = (m >> sh) & 7;
      let x = b & 1 ? 'x' : '-';
      if (m & sp) x = b & 1 ? ch : ch.toUpperCase();
      return (b & 4 ? 'r' : '-') + (b & 2 ? 'w' : '-') + x;
    };
    return t + tri(6, 0o4000, 's') + tri(3, 0o2000, 's') + tri(0, 0o1000, 't');
  }

  function usage(ctx, text) { ctx.err(text); return 2; }

  /* ================================================================== find */

  const FIND_HELP = 'Usage: find [-H] [-L] [-P] [-Olevel] [-D debugopts] [path...] [expression]\n\n' +
    'default path is the current directory; default expression is -print\n' +
    'expression may consist of: operators, options, tests, and actions:\n\n' +
    'operators (decreasing precedence; -and is implicit where no others are given):\n' +
    '      ( EXPR )   ! EXPR   -not EXPR   EXPR1 -a EXPR2   EXPR1 -and EXPR2\n' +
    '      EXPR1 -o EXPR2   EXPR1 -or EXPR2   EXPR1 , EXPR2\n\n' +
    'positional options (always true): -daystart -follow -regextype\n\n' +
    'normal options (always true, specified before other expressions):\n' +
    '      -depth --help -maxdepth LEVELS -mindepth LEVELS -mount -noleaf\n' +
    '      --version -xdev -ignore_readdir_race -noignore_readdir_race\n\n' +
    'tests (N can be +N or -N or N): -amin N -anewer FILE -atime N -cmin N\n' +
    '      -cnewer FILE -ctime N -empty -false -fstype TYPE -gid N -group NAME\n' +
    '      -ilname PATTERN -iname PATTERN -inum N -ipath PATTERN -iregex PATTERN\n' +
    '      -links N -lname PATTERN -mmin N -mtime N -name PATTERN -newer FILE\n' +
    '      -nouser -nogroup -path PATTERN -perm [-/]MODE -regex PATTERN\n' +
    '      -readable -writable -executable\n' +
    '      -size N[bcwkMG] -true -type [bcdflpsD] -uid N -user NAME\n\n' +
    'actions: -delete -print0 -printf FORMAT -print -prune -quit\n' +
    '      -ls -exec COMMAND ; -exec COMMAND {} + -ok COMMAND ;\n' +
    '      -execdir COMMAND ; -execdir COMMAND {} + -okdir COMMAND ;\n\n' +
    'Report (and track progress on fixing) bugs via the Savannah bug-tracker at\n' +
    '\thttp://savannah.gnu.org/projects/findutils/\n';

  const FIND_VERSION = 'find (GNU findutils) 4.10.0\nCopyright (C) 2025 Free Software Foundation, Inc.\n' +
    'License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\n' +
    'This is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\n' +
    'Written by Eric B. Ziegler, David MacKenzie, James Youngman, and Kevin Dalley.\n' +
    'Features enabled: D_TYPE O_NOFOLLOW(enabled) LEAF_OPTIMISATION FTS() CBO(level=2) \n';

  class FindError extends Error {}

  /** Translate an Emacs-style regex (the find default) to a JS RegExp source. */
  function emacsToJs(re) {
    let out = '';
    for (let i = 0; i < re.length; i++) {
      const c = re[i];
      if (c === '\\' && i + 1 < re.length) {
        const n = re[++i];
        out += '()|{}'.includes(n) ? n : '\\' + n;
      } else out += '()|{}'.includes(c) ? '\\' + c : c;
    }
    return out;
  }

  /** Parse a -perm argument into {kind:'exact'|'all'|'any', bits}. */
  function parsePerm(arg) {
    let kind = 'exact'; let s = arg;
    if (s[0] === '-') { kind = 'all'; s = s.slice(1); } else if (s[0] === '/' || s[0] === '+') { kind = 'any'; s = s.slice(1); }
    if (/^[0-7]+$/.test(s)) return { kind, bits: parseInt(s, 8) };
    let bits = 0;
    for (const clause of s.split(',')) {
      const m = /^([ugoa]*)([-+=])([rwxXst]*)$/.exec(clause);
      if (!m) throw new FindError("invalid mode '" + arg + "'");
      if (m[2] === '-') continue;
      const who = m[1] === '' || m[1].includes('a') ? 'ugo' : m[1];
      for (const w of who) {
        const sh = { u: 6, g: 3, o: 0 }[w];
        for (const p of m[3]) {
          if (p === 'r') bits |= 4 << sh; else if (p === 'w') bits |= 2 << sh; else if (p === 'x' || p === 'X') bits |= 1 << sh;
          else if (p === 's' && w !== 'o') bits |= w === 'u' ? 0o4000 : 0o2000; else if (p === 't') bits |= 0o1000;
        }
      }
    }
    return { kind, bits };
  }

  /** Compare a number against N, +N or -N. */
  function cmpNum(spec, value) {
    return spec.sign === '+' ? value > spec.n : spec.sign === '-' ? value < spec.n : value === spec.n;
  }

  function numSpec(arg, pred) {
    const m = /^([+-]?)(\d+)$/.exec(arg);
    if (!m) throw new FindError("invalid argument `" + arg + "' to `" + pred + "'");
    return { sign: m[1], n: +m[2] };
  }

  const SIZE_UNITS = { b: 512, c: 1, w: 2, k: 1024, M: 1048576, G: 1073741824 };

  function sizeSpec(arg) {
    const m = /^([+-]?)(\d*)(.*)$/.exec(arg);
    if (m[3] && !SIZE_UNITS[m[3]]) throw new FindError('invalid -size type `' + m[3] + "'");
    if (!m[2]) throw new FindError('invalid argument `' + arg + "' to `-size'");
    return { sign: m[1], n: +m[2], unit: SIZE_UNITS[m[3] || 'b'] };
  }

  function ctimeString(ms) {
    const d = new Date(ms);
    return U.DAYS[d.getUTCDay()] + ' ' + U.MONTHS[d.getUTCMonth()] + ' ' + pad(d.getUTCDate(), 2) + ' ' +
      U.isoDate(ms).slice(11) + '.' + pad(String(Math.floor(ms % 1000)), 3, '0') + '0000000 ' + d.getUTCFullYear();
  }

  /** Expand a -printf format for one file. */
  function printfFormat(fmt, f, ctx) {
    const st = f.st;
    const esc = { n: '\n', t: '\t', '\\': '\\', 0: '\0', r: '\r', a: '\x07', f: '\f', v: '\v', b: '\b' };
    let out = '';
    for (let i = 0; i < fmt.length; i++) {
      const c = fmt[i];
      if (c === '\\' && i + 1 < fmt.length) { const n = fmt[++i]; out += n in esc ? esc[n] : '\\' + n; continue; }
      if (c !== '%') { out += c; continue; }
      const m = /^%(-?)(\d*)(?:\.(\d+))?([A-Za-z%@])([A-Za-z@+])?/.exec(fmt.slice(i));
      if (!m) { out += c; continue; }
      let d = m[4]; let used = m[0].length;
      let val;
      const tm = (kind) => {
        const t = new Date(st.mtime);
        switch (kind) {
          case '@': return (st.mtime / 1000).toFixed(10);
          case 'Y': return String(t.getUTCFullYear()); case 'm': return U.pad2(t.getUTCMonth() + 1); case 'd': return U.pad2(t.getUTCDate());
          case 'H': return U.pad2(t.getUTCHours()); case 'M': return U.pad2(t.getUTCMinutes()); case 'S': return U.pad2(t.getUTCSeconds());
          case '+': return U.isoDate(st.mtime).replace(' ', '+') + '.0000000000';
          default: return ctimeString(st.mtime);
        }
      };
      if ('ATC'.includes(d)) { val = tm(m[5] || ''); used = m[5] ? m[0].length : m[0].length - 0; if (!m[5]) used = m[0].length; }
      else {
        used = m[0].length - (m[5] ? 1 : 0);
        switch (d) {
          case 'p': val = f.path; break;
          case 'f': val = baseName(f.path); break;
          case 'h': val = dirName(f.path); break;
          case 'P': val = f.path === f.start ? '' : f.path.slice(f.start.length).replace(/^\//, ''); break;
          case 's': val = String(st.size); break;
          case 'm': val = (st.mode & 0o7777).toString(8); break;
          case 'M': val = modeString(st); break;
          case 'u': val = ctx.machine.userName(st.uid); break;
          case 'g': val = ctx.machine.groupName(st.gid); break;
          case 'U': val = String(st.uid); break;
          case 'G': val = String(st.gid); break;
          case 'y': val = { f: 'f', d: 'd', l: 'l', c: 'c' }[st.type]; break;
          case 'd': val = String(f.depth); break;
          case 'n': val = String(st.nlink); break;
          case 'i': val = String(st.ino); break;
          case 'l': val = st.isLink ? st.target : ''; break;
          case 'k': val = String(Math.ceil(st.size / 1024)); break;
          case '%': val = '%'; break;
          default: val = '%' + d; break;
        }
      }
      if (m[3] != null) val = val.slice(0, +m[3]);
      if (m[2]) val = m[1] ? U.padEnd(val, +m[2]) : pad(val, +m[2]);
      out += val;
      i += used - 1;
    }
    return out;
  }

  /** Lex and parse a find expression into a tree of async predicates. */
  function parseFind(ctx, args, state) {
    let pos = 0;
    const peek = () => args[pos];
    const need = (pred) => { if (pos >= args.length) throw new FindError('missing argument to `' + pred + "'"); return args[pos++]; };
    const userId = (name, kind) => {
      if (/^\d+$/.test(name)) return +name;
      const rec = kind === 'user' ? ctx.machine.userByName(name) : ctx.machine.groupByName(name);
      if (!rec) throw new FindError(q(name) + (kind === 'user' ? ' is not the name of a known user' : ' is not the name of an existing group'));
      return kind === 'user' ? rec.uid : rec.gid;
    };
    const reference = (name) => {
      try { return ctx.fs.stat(name).mtime; } catch (e) { if (!isFsErr(e)) throw e; throw new FindError(q(name) + ': ' + e.message); }
    };
    const glob = (pat, ci) => U.globToRe(pat, ci ? 'is' : 's');
    const now = () => state.now;

    function parseExec(pred) {
      const cmd = [];
      for (;;) {
        if (pos >= args.length) throw new FindError('missing argument to `' + pred + "'");
        const a = args[pos++];
        if (a === ';') break;
        if (a === '+' && cmd.length && cmd[cmd.length - 1] === '{}' && !pred.startsWith('-ok')) { return { cmd: cmd.slice(0, -1), batch: true }; }
        cmd.push(a);
      }
      if (!cmd.length) throw new FindError('missing argument to `' + pred + "'");
      return { cmd, batch: false };
    }

    function primary() {
      if (pos >= args.length) throw new FindError('expected an expression');
      const tok = args[pos++];
      const test = (fn) => ({ fn });
      const prevPattern = state.lastPattern;
      state.lastPattern = /^-(i?name|i?path|i?wholename|i?regex|i?lname)$/.test(tok) ? tok : null;
      switch (tok) {
        case '(': {
          const e = orExpr();
          if (peek() !== ')') throw new FindError("invalid expression; I was expecting to find a ')' somewhere but did not see one.");
          pos++;
          return e;
        }
        case '-true': return test(() => true);
        case '-false': return test(() => false);
        case '-name': case '-iname': { const re = glob(need(tok), tok === '-iname'); return test((f) => re.test(baseName(f.path))); }
        case '-path': case '-wholename': case '-ipath': case '-iwholename': { const re = glob(need(tok), tok.startsWith('-i')); return test((f) => re.test(f.path)); }
        case '-lname': case '-ilname': { const re = glob(need(tok), tok === '-ilname'); return test((f) => f.st.isLink && re.test(f.st.target)); }
        case '-regex': case '-iregex': {
          const src = need(tok); let re;
          try { re = new RegExp('^(?:' + emacsToJs(src) + ')$', tok === '-iregex' ? 'is' : 's'); } catch (e) { throw new FindError('Invalid regular expression ' + q(src)); }
          return test((f) => re.test(f.path));
        }
        case '-type': case '-xtype': {
          const spec = need(tok).split(',');
          for (const t of spec) if (!/^[bcdfpslD]$/.test(t)) throw new FindError('Unknown argument to ' + tok + ': ' + t);
          return test((f) => spec.includes(f.st.type));
        }
        case '-size': {
          const s = sizeSpec(need(tok));
          return test((f) => cmpNum(s, s.unit === 1 ? f.st.size : Math.ceil(f.st.size / s.unit)));
        }
        case '-mtime': case '-atime': case '-ctime': {
          const s = numSpec(need(tok), tok);
          return test((f) => cmpNum(s, Math.floor((now() - f.st.mtime) / DAY)));
        }
        case '-mmin': case '-amin': case '-cmin': {
          const s = numSpec(need(tok), tok);
          return test((f) => {
            const age = (now() - f.st.mtime) / 60000;
            return s.sign === '+' ? age > s.n : s.sign === '-' ? age < s.n : Math.ceil(age) === s.n;
          });
        }
        case '-newer': case '-anewer': case '-cnewer': { const ref = reference(need(tok)); return test((f) => f.st.mtime > ref); }
        case '-user': { const id = userId(need(tok), 'user'); return test((f) => f.st.uid === id); }
        case '-group': { const id = userId(need(tok), 'group'); return test((f) => f.st.gid === id); }
        case '-uid': { const s = numSpec(need(tok), tok); return test((f) => cmpNum(s, f.st.uid)); }
        case '-gid': { const s = numSpec(need(tok), tok); return test((f) => cmpNum(s, f.st.gid)); }
        case '-links': { const s = numSpec(need(tok), tok); return test((f) => cmpNum(s, f.st.nlink)); }
        case '-inum': { const s = numSpec(need(tok), tok); return test((f) => cmpNum(s, f.st.ino)); }
        case '-nouser': return test((f) => !ctx.machine.userByUid(f.st.uid));
        case '-nogroup': return test((f) => !ctx.machine.groupByGid(f.st.gid));
        case '-perm': {
          const p = parsePerm(need(tok));
          return test((f) => {
            const m = f.st.mode & 0o7777;
            return p.kind === 'exact' ? m === p.bits : p.kind === 'all' ? (m & p.bits) === p.bits : p.bits === 0 || (m & p.bits) !== 0;
          });
        }
        case '-readable': case '-writable': case '-executable': {
          const bit = { '-readable': 'r', '-writable': 'w', '-executable': 'x' }[tok];
          return test((f) => ctx.fs.can(f.path, bit));
        }
        case '-empty': return test((f) => {
          if (f.st.isFile) return f.st.size === 0;
          if (!f.st.isDir) return false;
          try { return ctx.fs.readdir(f.path).length === 0; } catch (e) { return false; }
        });
        case '-fstype': { const t = need(tok); return test(() => t === 'ext4'); }
        case '-prune': return test((f) => { f.prune = true; return true; });
        case '-quit': return test(() => { state.quit = true; return true; });
        case '-depth': case '-d': state.depth = true; return test(() => true);
        case '-maxdepth': case '-mindepth': {
          const v = need(tok);
          if (!/^\d+$/.test(v)) throw new FindError('Expected a positive decimal integer argument to ' + tok + ', but got ' + q(v));
          state[tok === '-maxdepth' ? 'maxdepth' : 'mindepth'] = +v;
          return test(() => true);
        }
        case '-xdev': case '-mount': case '-noleaf': case '-ignore_readdir_race': case '-noignore_readdir_race': case '-daystart': return test(() => true);
        case '-follow': state.follow = 'all'; return test(() => true);
        case '-regextype': need(tok); return test(() => true);
        case '-print': state.action = true; return test((f) => { state.emit(f.path + '\n'); return true; });
        case '-print0': state.action = true; return test((f) => { state.emit(f.path + '\0'); return true; });
        case '-printf': { const fmt = need(tok); state.action = true; return test((f) => { state.emit(printfFormat(fmt, f, ctx)); return true; }); }
        case '-ls': state.action = true; return test((f) => { state.emit(lsLine(f, ctx)); return true; });
        case '-delete': state.action = true; state.depth = true; return test((f) => deleteEntry(f, ctx, state));
        case '-exec': case '-execdir': case '-ok': case '-okdir': {
          state.action = true;
          const spec = parseExec(tok);
          const dirMode = tok.endsWith('dir');
          if (spec.batch) {
            const group = { cmd: spec.cmd, files: [], dirMode };
            state.batches.push(group);
            return test((f) => { group.files.push(dirMode ? './' + baseName(f.path) : f.path); return true; });
          }
          return test(async (f) => runExec(ctx, state, spec.cmd, f, dirMode, tok.startsWith('-ok')));
        }
        default:
          if (tok.startsWith('-')) throw new FindError('unknown predicate `' + tok + "'");
          state.lastPattern = prevPattern;
          throw new FindError('paths must precede expression: `' + tok + "'");
      }
    }

    function notExpr() {
      const tok = peek();
      if (tok === '!' || tok === '-not') {
        pos++;
        if (pos >= args.length) throw new FindError("expected an expression after '" + tok + "'");
        const e = notExpr();
        return { fn: async (f) => !(await e.fn(f)) };
      }
      return primary();
    }

    const binaryWithNothing = (tok) => new FindError('invalid expression; you have used a binary operator ' + q(tok) + ' with nothing before it.');

    function andExpr() {
      if (['-a', '-and', '-o', '-or', ','].includes(peek())) throw binaryWithNothing(peek());
      let left = notExpr();
      for (;;) {
        let t = peek();
        if (t === undefined || t === ')' || t === '-o' || t === '-or' || t === ',') return left;
        if (t === '-a' || t === '-and') {
          pos++;
          if (pos >= args.length) throw new FindError("expected an expression after '" + t + "'");
          if (['-a', '-and', '-o', '-or', ','].includes(peek())) throw binaryWithNothing(peek());
        }
        const l = left; const r = notExpr();
        left = { fn: async (f) => (await l.fn(f)) && (await r.fn(f)) };
      }
    }

    function orExpr() {
      let left = andExpr();
      for (;;) {
        const t = peek();
        if (t === '-o' || t === '-or' || t === ',') {
          pos++;
          if (pos >= args.length) throw new FindError("expected an expression after '" + t + "'");
          if (['-a', '-and', '-o', '-or', ','].includes(peek())) throw binaryWithNothing(peek());
          const l = left; const r = andExpr();
          left = t === ',' ? { fn: async (f) => { await l.fn(f); return r.fn(f); } } : { fn: async (f) => (await l.fn(f)) || (await r.fn(f)) };
        } else return left;
      }
    }

    if (!args.length) return { fn: () => true, empty: true };
    const e = orExpr();
    if (pos < args.length) {
      if (args[pos] === ')') throw new FindError('unmatched ) in expression');
      throw new FindError('paths must precede expression: `' + args[pos] + "'");
    }
    return e;
  }

  function lsLine(f, ctx) {
    const st = f.st;
    return pad(st.ino, 9) + ' ' + pad(Math.ceil(st.size / 1024 / 4) * 4 * (st.isLink ? 0 : 1), 6) + ' ' + modeString(st) + ' ' + pad(st.nlink, 3) + ' ' +
      U.padEnd(ctx.machine.userName(st.uid), 8) + ' ' + U.padEnd(ctx.machine.groupName(st.gid), 8) + ' ' + pad(st.size, 8) + ' ' +
      U.lsDate(st.mtime) + ' ' + f.path + (st.isLink ? ' -> ' + st.target : '') + '\n';
  }

  function deleteEntry(f, ctx, state) {
    if (f.path === '.') return true;
    try {
      if (f.st.isDir) ctx.fs.rmdir(f.path); else ctx.fs.unlink(f.path);
    } catch (e) {
      if (!isFsErr(e)) throw e;
      ctx.err('find: cannot delete ' + q(f.path) + ': ' + e.message + '\n');
      state.failed = true;
      return false;
    }
    return true;
  }

  async function runExec(ctx, state, cmd, f, dirMode, ask) {
    const target = dirMode ? './' + baseName(f.path) : f.path;
    const argv = cmd.map((a) => a.split('{}').join(target));
    if (ask) {
      const line = await ctx.readLine('< ' + argv.join(' ') + ' ... > ? ');
      if (line == null || !/^y/i.test(line)) return false;
    }
    return (await invoke(ctx, argv, dirMode ? dirName(f.path) : null)).code === 0;
  }

  async function invoke(ctx, argv, cwd) {
    const line = argv.map(shellQuote).join(' ');
    const r = await ctx.run(cwd ? 'cd ' + shellQuote(cwd) + ' && ' + line : line);
    if (r.out) ctx.out(r.out);
    if (r.err) ctx.err(r.err);
    return r;
  }

  function shellQuote(s) { return /^[A-Za-z0-9_\/.,:=@%+-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'"; }

  async function findRun(ctx) {
    const args = ctx.args.slice();
    if (args[0] === '--help') { ctx.out(FIND_HELP); return 0; }
    if (args[0] === '--version') { ctx.out(FIND_VERSION); return 0; }
    let follow = 'none';
    while (args.length && /^-[HLPO]/.test(args[0]) && args[0] !== '-L' + 'x') {
      const a = args.shift();
      if (a === '-L') follow = 'all'; else if (a === '-H') follow = 'cmd';
    }
    const starts = [];
    while (args.length && !args[0].startsWith('-') && args[0] !== '(' && args[0] !== '!' && args[0] !== ')' && args[0] !== ',') starts.push(args.shift());
    if (!starts.length) starts.push('.');

    const state = {
      now: K.clock.now(), maxdepth: Infinity, mindepth: 0, depth: false, follow, action: false, batches: [], quit: false, failed: false,
      emit: (s) => ctx.out(s),
    };
    let expr;
    try { expr = parseFind(ctx, args, state); } catch (e) {
      if (!(e instanceof FindError)) throw e;
      ctx.err('find: ' + e.message + '\n');
      if (e.message.startsWith('paths must precede') && state.lastPattern) {
        ctx.err('find: possible unquoted pattern after predicate `' + state.lastPattern + "'?\n");
      }
      return 1;
    }
    if (!state.action) { const inner = expr; expr = { fn: async (f) => { if (await inner.fn(f)) { ctx.out(f.path + '\n'); return true; } return false; } }; }
    if (expr.empty) expr = { fn: async (f) => { ctx.out(f.path + '\n'); return true; } };

    let status = 0;
    const statOf = (path, followLinks) => (followLinks ? ctx.fs.stat(path) : ctx.fs.lstat(path));

    async function visit(path, start, depth, isStart) {
      if (state.quit) return;
      ctx.checkAbort();
      let st;
      try { st = statOf(path, state.follow === 'all' || (state.follow === 'cmd' && isStart)); } catch (e) {
        if (!isFsErr(e)) throw e;
        if (state.follow === 'all' && e.code === 'ENOENT') { try { st = ctx.fs.lstat(path); } catch (e2) { st = null; } }
        if (!st) { ctx.err('find: ' + q(path) + ': ' + e.message + '\n'); status = 1; return; }
      }
      const f = { path, start, depth, st, prune: false };
      const report = depth >= state.mindepth && depth <= state.maxdepth;
      const isDir = st.isDir;
      let kids = null;
      if (isDir && depth < state.maxdepth) {
        if (!state.depth) {
          if (report) await expr.fn(f);
          if (f.prune || state.quit) return;
        }
        try { kids = ctx.fs.readdir(path); } catch (e) {
          if (!isFsErr(e)) throw e;
          ctx.err('find: ' + q(path) + ': ' + e.message + '\n'); status = 1;
        }
        if (kids) for (const k of kids) await visit(joinPath(path, k), start, depth + 1, false);
        if (state.depth && report && !state.quit) await expr.fn(f);
        return;
      }
      if (report) await expr.fn(f);
    }

    for (const s of starts) {
      if (state.quit) break;
      await visit(s, s, 0, true);
    }
    for (const b of state.batches) {
      if (!b.files.length) continue;
      const r = await invoke(ctx, b.cmd.concat(b.files), null);
      if (r.code !== 0) status = 1;
    }
    return state.failed ? 1 : status;
  }

  K.cmd.register({
    name: 'find', pkg: 'findutils', section: 1,
    summary: 'search for files in a directory hierarchy',
    synopsis: 'find [-H] [-L] [-P] [-D debugopts] [-Olevel] [starting-point...] [expression]',
    man: 'DESCRIPTION\n       find searches the directory tree rooted at each given starting-point by evaluating the given expression from left to right. The default starting point is the current directory and the default expression is -print.\n\n' +
      'OPTIONS\n       -name pattern, -iname pattern\n              base name matches the shell pattern (-iname ignores case)\n       -path pattern\n              whole path matches the pattern\n       -type c\n              file is of type c: f regular file, d directory, l symbolic link\n       -size [+-]n[ckMG]\n              file uses n units of space (+ greater, - less)\n       -mtime n, -mmin n\n              data last modified n*24 hours / n minutes ago\n       -newer file, -user name, -group name, -perm mode, -empty\n       -maxdepth n, -mindepth n\n              descend at most / at least n levels\n       ! expr, -a, -o, ( expr )\n              not, and, or and grouping (quote the parentheses)\n       -print, -print0, -ls, -delete\n       -exec command {} ;   -exec command {} +\n              run command for each file, or once with many files\n\n' +
      'EXAMPLES\n       find /etc -name "*.conf" -type f\n              Every .conf file below /etc.\n       find / -perm -4000 -type f 2>/dev/null\n              Set-uid files, hiding the permission errors.\n       find /var/www -name "*.php" -exec grep -l password {} +\n              Which PHP files mention a password.',
    run: findRun,
  });

  /* ================================================== archive plumbing */

  /* File contents are JS strings. Archives hold bytes, kept as "byte strings" (one char per byte). */
  const toBin = (s) => {
    if (!/[^\x00-\x7f]/.test(s)) return s;
    let out = ''; const b = U.toBytes(s);
    for (let i = 0; i < b.length; i += 8192) out += String.fromCharCode.apply(null, b.slice(i, i + 8192));
    return out;
  };
  const fromBin = (s) => {
    if (!/[\x80-\xff]/.test(s)) return s;
    const b = new Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return U.fromBytes(b);
  };
  const le = (n, w) => { let s = ''; for (let i = 0; i < w; i++) s += String.fromCharCode(Math.floor(n / Math.pow(2, 8 * i)) & 255); return s; };
  const rd = (s, o, w) => { let n = 0; for (let i = w - 1; i >= 0; i--) n = n * 256 + s.charCodeAt(o + i); return n; };

  const CRC_TABLE = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t.push(c >>> 0); }
    return t;
  })();
  function crc32(s) {
    let c = 0xffffffff;
    for (let i = 0; i < s.length; i++) c = CRC_TABLE[(c ^ s.charCodeAt(i)) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const hex8 = (n) => U.padStart(n.toString(16), 8, '0');

  /* The simulated compressor: a small LZ77 coder. Literal runs are [len-1, bytes...] (len 1..128);
   * matches are [128 + len-4, offset hi, offset lo] (len 4..131). Real ratios on repetitive text. */
  function lzPack(s) {
    let out = ''; let lit = 0; let i = 0; const seen = new Map();
    const flush = (end) => {
      while (lit < end) { const n = Math.min(128, end - lit); out += String.fromCharCode(n - 1) + s.slice(lit, lit + n); lit += n; }
    };
    while (i < s.length) {
      let len = 0; let off = 0;
      if (i + 4 <= s.length) {
        const key = s.substr(i, 4); const prev = seen.get(key);
        if (prev !== undefined && i - prev <= 65535) {
          len = 4; while (len < 131 && i + len < s.length && s[prev + len] === s[i + len]) len++;
          off = i - prev;
        }
        seen.set(key, i);
      }
      if (len >= 4) { flush(i); out += String.fromCharCode(128 + len - 4, off >> 8, off & 255); i += len; lit = i; } else i++;
    }
    flush(s.length);
    return out;
  }
  function lzUnpack(s) {
    let out = ''; let i = 0;
    while (i < s.length) {
      const c = s.charCodeAt(i++);
      if (c < 128) { if (i + c + 1 > s.length) return null; out += s.substr(i, c + 1); i += c + 1; } else {
        if (i + 2 > s.length) return null;
        const len = c - 128 + 4; const off = (s.charCodeAt(i) << 8) | s.charCodeAt(i + 1); i += 2;
        if (!off || off > out.length) return null;
        for (let k = 0; k < len; k++) out += out[out.length - off];
      }
    }
    return out;
  }

  const GZ_MAGIC = '\x1f\x8b'; const BZ_MAGIC = 'BZh'; const XZ_MAGIC = '\xfd7zXZ\0';
  const compressionOf = (bin) => (bin.startsWith(GZ_MAGIC) ? 'gz' : bin.startsWith(BZ_MAGIC) && bin.slice(4, 10) === '1AY&SY' ? 'bz' : bin.startsWith(XZ_MAGIC) ? 'xz' : null);

  /** Wrap a byte string in a gzip (or bzip2/xz-looking) container. */
  function compress(kind, bin, o) {
    o = o || {};
    if (kind === 'bz') return 'BZh9' + '1AY&SY' + lzPack(bin) + '\x17rE8P\x90' + le(crc32(bin), 4);
    if (kind === 'xz') return XZ_MAGIC + '\x00\x04' + lzPack(bin) + le(crc32(bin), 4) + le(bin.length, 4) + 'YZ';
    const name = o.name ? o.name + '\0' : '';
    const mtime = Math.floor((o.mtime || 0) / 1000);
    return GZ_MAGIC + '\x08' + String.fromCharCode(name ? 8 : 0) + le(mtime, 4) + String.fromCharCode(o.level === 9 ? 2 : o.level === 1 ? 4 : 0) + '\x03' +
      name + lzPack(bin) + le(crc32(bin), 4) + le(bin.length, 4);
  }

  /** Inspect a gzip member. Returns null when the data is not gzip, else {name, mtime, hdr, body, crc, size}. */
  function gzInfo(bin) {
    if (!bin.startsWith(GZ_MAGIC) || bin.length < 18 || bin.charCodeAt(2) !== 8) return null;
    const flags = bin.charCodeAt(3); let off = 10; let name = '';
    if (flags & 4) off += 2 + rd(bin, off, 2);
    if (flags & 8) { const e = bin.indexOf('\0', off); name = bin.slice(off, e); off = e + 1; }
    if (flags & 16) off = bin.indexOf('\0', off) + 1;
    return { name, mtime: rd(bin, 4, 4) * 1000, hdr: off, body: bin.slice(off, -8), crc: rd(bin, bin.length - 8, 4), size: rd(bin, bin.length - 4, 4), xfl: bin.charCodeAt(8) };
  }

  /** Decompress a container. Returns {data} or {error} with the gzip wording. */
  function decompress(bin) {
    const kind = compressionOf(bin);
    if (!kind) return { error: 'not in gzip format', notFormat: true };
    if (kind === 'gz') {
      const g = gzInfo(bin);
      if (!g) return { error: 'unexpected end of file' };
      const data = lzUnpack(g.body);
      if (data == null) return { error: 'invalid compressed data--format violated' };
      if (crc32(data) !== g.crc) return { error: 'invalid compressed data--crc error' };
      if ((data.length >>> 0) !== g.size) return { error: 'invalid compressed data--length error' };
      return { data, info: g, kind };
    }
    const body = kind === 'bz' ? bin.slice(10, -10) : bin.slice(8, -10);
    const data = lzUnpack(body);
    return data == null ? { error: 'data is corrupt' } : { data, kind };
  }

  /* ======================================================================= tar */

  const TAR_VERSION = 'tar (GNU tar) 1.35\nCopyright (C) 2023 Free Software Foundation, Inc.\n' +
    'License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\n' +
    'This is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by John Gilmore and Jay Fenlason.\n';

  const TAR_HELP = 'Usage: tar [OPTION...] [FILE]...\nGNU \'tar\' saves many files together into a single tape or disk archive, and can\nrestore individual files from the archive.\n\n' +
    'Examples:\n  tar -cf archive.tar foo bar  # Create archive.tar from files foo and bar.\n  tar -tvf archive.tar         # List all files in archive.tar verbosely.\n  tar -xf archive.tar          # Extract all files from archive.tar.\n\n' +
    ' Main operation mode:\n\n  -c, --create               create a new archive\n  -t, --list                 list the contents of an archive\n  -x, --extract, --get       extract files from an archive\n\n' +
    ' Device selection and switching:\n\n  -f, --file=ARCHIVE         use archive file or device ARCHIVE\n\n' +
    ' Archive format selection:\n\n  -j, --bzip2                filter the archive through bzip2\n  -J, --xz                   filter the archive through xz\n  -z, --gzip, --gunzip, --ungzip   filter the archive through gzip\n  -a, --auto-compress        use archive suffix to determine the compression program\n\n' +
    ' Local file selection:\n\n  -C, --directory=DIR        change to directory DIR\n      --exclude=PATTERN      exclude files, given as a PATTERN\n\n' +
    ' Handling of file attributes:\n\n  -m, --touch                don\'t extract file modified time\n  -p, --preserve-permissions, --same-permissions\n                             extract information about file permissions\n\n' +
    ' Informative output:\n\n  -v, --verbose              verbosely list files processed\n\n' +
    'Mandatory or optional arguments to long options are also mandatory or optional\nfor any corresponding short options.\n\nReport bugs to <bug-tar@gnu.org>.\n';

  const TAR_TYPES = { '0': 'f', '\0': 'f', '5': 'd', '2': 'l' };

  function tarHeader(e) {
    const f = (v, n) => (v + '\0'.repeat(n)).slice(0, n);
    const o = (v, n) => U.padStart(Math.floor(v).toString(8), n - 1, '0') + '\0';
    let name = e.name; let prefix = '';
    const link = e.link || '';
    let out = '';
    if (name.length > 100 || link.length > 100) {
      const longOf = (text, type) => tarHeader({ name: '././@LongLink', type, mode: 0, uid: 0, gid: 0, uname: 'root', gname: 'root', size: text.length + 1, mtime: 0, raw: true }) + padBlock(text + '\0');
      if (name.length > 100) { out += longOf(name, 'L'); name = name.slice(0, 100); }
      if (link.length > 100) out += longOf(link, 'K');
    }
    const hdr = f(name, 100) + o(e.mode & 0o7777, 8) + o(e.uid, 8) + o(e.gid, 8) + o(e.size, 12) + o(e.mtime, 12) + '        ' +
      (e.type === 'd' ? '5' : e.type === 'l' ? '2' : e.type === 'L' || e.type === 'K' ? e.type : '0') + f(link.slice(0, 100), 100) + 'ustar  \0' +
      f(e.uname, 32) + f(e.gname, 32) + '\0'.repeat(8 + 8) + f(prefix, 155) + '\0'.repeat(12);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += hdr.charCodeAt(i);
    return out + hdr.slice(0, 148) + U.padStart(sum.toString(8), 6, '0') + '\0 ' + hdr.slice(156);
  }
  const padBlock = (s) => (s.length % 512 ? s + '\0'.repeat(512 - (s.length % 512)) : s);

  /** Parse a tar byte string. Returns {entries:[{name,type,mode,uid,gid,uname,gname,size,mtime,link,data}], bad}. */
  function tarParse(bin) {
    const entries = []; let off = 0; let longName = null; let longLink = null;
    if (bin.length && bin.length < 512) return { entries, bad: true };
    const cstr = (o, n) => { const s = bin.substr(off + o, n); const z = s.indexOf('\0'); return z < 0 ? s : s.slice(0, z); };
    const num = (o, n) => parseInt(cstr(o, n).trim() || '0', 8);
    while (off + 512 <= bin.length) {
      const block = bin.substr(off, 512);
      if (/^\0*$/.test(block)) break;
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block.charCodeAt(i);
      if (sum !== num(148, 8)) return { entries, bad: true };
      const flag = block[156]; const size = num(124, 12);
      const data = bin.substr(off + 512, size);
      const advance = 512 + Math.ceil(size / 512) * 512;
      if (flag === 'L' || flag === 'K') {
        const text = data.replace(/\0.*$/s, '');
        if (flag === 'L') longName = text; else longLink = text;
        off += advance; continue;
      }
      const prefix = block.substr(345, 155).replace(/\0.*$/s, '');
      let name = longName != null ? longName : (block.substr(257, 6) === 'ustar\0' && prefix ? prefix + '/' : '') + cstr(0, 100);
      const type = TAR_TYPES[flag] || 'f';
      entries.push({
        name, type, mode: num(100, 8), uid: num(108, 8), gid: num(116, 8), uname: cstr(265, 32), gname: cstr(297, 32),
        size: type === 'f' ? size : 0, mtime: num(136, 12), link: longLink != null ? longLink : cstr(157, 100), data: type === 'f' ? data : '',
      });
      longName = longLink = null;
      off += advance;
    }
    return { entries, bad: false };
  }

  function tarSerialize(entries) {
    let out = '';
    for (const e of entries) out += tarHeader(e) + (e.type === 'f' ? padBlock(e.data) : '');
    out += '\0'.repeat(1024);
    const rec = 10240;
    return out.length % rec ? out + '\0'.repeat(rec - (out.length % rec)) : out;
  }

  const tarWhen = (sec) => U.isoDate(sec * 1000).slice(0, 16);

  function tarListLine(e, st) {
    const ug = (e.uname || e.uid) + '/' + (e.gname || e.gid);
    const size = String(e.size);
    st.w = Math.max(st.w, ug.length + size.length + 1);
    return modeString({ type: e.type, mode: e.mode }) + ' ' + ug + U.padStart(size, st.w - ug.length) + ' ' + tarWhen(e.mtime) + ' ' + e.name + (e.type === 'l' ? ' -> ' + e.link : '');
  }

  const TAR_SPEC = {
    short: 'ctxrukvf:zjJaC:pmOkhPT:X:V:',
    long: ['create', 'list', 'extract', 'get', 'file=', 'gzip', 'gunzip', 'ungzip', 'bzip2', 'xz', 'auto-compress', 'directory=', 'verbose', 'exclude=',
      'strip-components=', 'preserve-permissions', 'same-permissions', 'touch', 'to-stdout', 'keep-old-files', 'help', 'version', 'absolute-names',
      'same-owner', 'no-same-owner', 'dereference', 'wildcards', 'no-wildcards', 'usage'],
    alias: { create: 'c', list: 't', extract: 'x', get: 'x', file: 'f', gzip: 'z', gunzip: 'z', ungzip: 'z', bzip2: 'j', xz: 'J', 'auto-compress': 'a', directory: 'C',
      verbose: 'v', 'preserve-permissions': 'p', 'same-permissions': 'p', touch: 'm', 'to-stdout': 'O', 'keep-old-files': 'k', 'absolute-names': 'P', dereference: 'h' },
  };

  const TAR_TRY = "Try 'tar --help' or 'tar --usage' for more information.\n";

  function suffixKind(name) {
    if (/\.(tar\.gz|tgz)$/.test(name)) return 'gz';
    if (/\.(tar\.bz2|tbz2?)$/.test(name)) return 'bz';
    if (/\.(tar\.xz|txz)$/.test(name)) return 'xz';
    return null;
  }

  /** Does `name` fall under member argument `m` (the member itself or anything below it)? */
  const underMember = (name, m) => { const a = name.replace(/\/+$/, ''); const b = m.replace(/\/+$/, ''); return a === b || a.startsWith(b + '/'); };

  async function tarRun(ctx) {
    let args = ctx.args.slice();
    if (args.length && /^[A-Za-z]/.test(args[0])) args[0] = '-' + args[0];
    const g = K.getopt(args, TAR_SPEC);
    if (g.opts.help) { ctx.out(TAR_HELP); return 0; }
    if (g.opts.usage) { ctx.out('Usage: tar [-AcdrtuxGnSkUWOmpsMBiajJzZhPlRvwo?] [-g FILE] [-C DIR] [-f ARCHIVE] [--exclude=PATTERN] [FILE]...\n'); return 0; }
    if (g.opts.version) { ctx.out(TAR_VERSION); return 0; }
    if (g.err) { ctx.err('tar: ' + g.err + '\n' + TAR_TRY); return 64; }
    const modes = ['c', 't', 'x', 'r', 'u'].filter((m) => g.opts[m]);
    if (!modes.length) { ctx.err("tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\n" + TAR_TRY); return 2; }
    if (modes.length > 1) { ctx.err("tar: You may not specify more than one '-Acdtrux', '--delete' or '--test-label' option\n" + TAR_TRY); return 2; }
    const mode = modes[0];
    if (mode === 'r' || mode === 'u') { ctx.err('tar: Cannot update compressed archives\n'); return 2; }
    const o = g.opts; const file = o.f === undefined ? '-' : o.f;
    const members = g.rest;
    const fatal2 = () => { ctx.err('tar: Error is not recoverable: exiting now\n'); return 2; };
    const fatal = (msg) => { ctx.err('tar: ' + msg + '\n'); return fatal2(); };
    const base = o.C ? ctx.path(o.C) : null;
    if (base && !ctx.fs.isDir(base)) return fatal(o.C + ': Cannot open: ' + (ctx.fs.exists(base) ? 'Not a directory' : 'No such file or directory'));
    const real = (name) => (base ? joinPath(base, name) : name);
    const log = file === '-' ? (s) => ctx.err(s) : (s) => ctx.out(s);
    const state = { errors: 0, stripped: false, w: 19 };
    const bad = (msg) => { ctx.err('tar: ' + msg + '\n'); state.errors++; };
    const finish = () => { if (state.errors) { ctx.err('tar: Exiting with failure status due to previous errors\n'); return 2; } return 0; };
    const strip = (name) => {
      if (o.P || !name.startsWith('/')) return name;
      if (!state.stripped) { ctx.err("tar: Removing leading `/' from member names\n"); state.stripped = true; }
      return name.replace(/^\/+/, '') || '.';
    };
    const excludes = (g.all.exclude || []).map((p) => U.globToRe(p));
    const excluded = (name) => excludes.some((re) => { const parts = name.replace(/\/+$/, '').split('/'); return parts.some((_, i) => re.test(parts.slice(i).join('/'))); });
    const compression = o.z ? 'gz' : o.j ? 'bz' : o.J ? 'xz' : o.a ? suffixKind(file) : null;

    if (mode === 'c') {
      if (file === '-' && ctx.isTTY) return fatal('Refusing to write archive contents to terminal (missing -f option?)');
      if (!members.length) { ctx.err('tar: Cowardly refusing to create an empty archive\n' + TAR_TRY); return 2; }
      const self = file === '-' ? null : ctx.path(file);
      const entries = [];
      const add = (name, path) => {
        ctx.checkAbort();
        if (excluded(name)) return;
        let st;
        try { st = ctx.fs.lstat(path); } catch (e) { if (!isFsErr(e)) throw e; bad(name + ': Cannot stat: ' + e.message); return; }
        if (self && ctx.path(path) === self) { bad(name + ': file is the archive; not dumped'); return; }
        const arc = strip(name);
        const e = { name: arc, mode: st.mode, uid: st.uid, gid: st.gid, uname: ctx.machine.userName(st.uid), gname: ctx.machine.groupName(st.gid), mtime: Math.floor(st.mtime / 1000), size: 0, type: st.type, data: '' };
        if (st.isDir) {
          e.type = 'd'; e.name = arc.replace(/\/*$/, '/');
          entries.push(e); if (o.v) log(e.name + '\n');
          let kids;
          try { kids = ctx.fs.readdir(path); } catch (er) { if (!isFsErr(er)) throw er; bad(name.replace(/\/+$/, '') + ': Cannot open: ' + er.message); return; }
          for (const k of kids) add(joinPath(name, k), joinPath(path, k));
          return;
        }
        if (st.isLink) { e.type = 'l'; e.link = ctx.fs.readlink(path); } else if (st.isFile) {
          try { e.data = toBin(ctx.fs.read(path)); } catch (er) { if (!isFsErr(er)) throw er; bad(name + ': Cannot open: ' + er.message); return; }
          e.size = e.data.length; e.type = 'f';
        } else { bad(name + ': Unknown file type; file ignored'); return; }
        entries.push(e); if (o.v) log(e.name + '\n');
      };
      for (const m of members) add(m, real(m));
      let data = tarSerialize(entries);
      if (compression) data = compress(compression, data);
      if (file === '-') ctx.out(data);
      else {
        try { ctx.fs.write(file, data); } catch (e) { if (!isFsErr(e)) throw e; return fatal(file + ': Cannot open: ' + e.message); }
      }
      return finish();
    }

    let bin;
    if (file === '-') bin = ctx.stdin == null ? '' : ctx.stdin;
    else {
      try { bin = ctx.fs.read(file); } catch (e) { if (!isFsErr(e)) throw e; return fatal(file + ': Cannot open: ' + e.message); }
    }
    const kind = compressionOf(bin);
    if (compression && kind !== compression) { ctx.err('\n' + (compression === 'gz' ? 'gzip: stdin: not in gzip format\n' : compression === 'bz' ? 'bzip2: (stdin) is not a bzip2 file.\n' : 'xz: (stdin): File format not recognized\n') + 'tar: Child returned status ' + (compression === 'gz' ? 1 : 2) + '\n'); return fatal2(); }
    if (kind) {
      const r = decompress(bin);
      if (r.error) { ctx.err('\ngzip: stdin: ' + r.error + '\ntar: Child returned status 1\n'); return fatal2(); }
      bin = r.data;
    }
    const parsed = tarParse(bin);
    if (parsed.bad && !parsed.entries.length) {
      ctx.err('tar: This does not look like a tar archive\ntar: Skipping to next header\ntar: Exiting with failure status due to previous errors\n');
      return 2;
    }
    const matched = new Set();
    const wanted = (name) => {
      if (!members.length) return true;
      let hit = false;
      members.forEach((m, i) => { if (underMember(name, m)) { matched.add(i); hit = true; } });
      return hit;
    };
    const skip = (e) => excluded(e.name) || !wanted(e.name);

    if (mode === 't') {
      for (const e of parsed.entries) {
        if (skip(e)) continue;
        ctx.out((o.v ? tarListLine(e, state) : e.name) + '\n');
      }
    } else {
      const nstrip = o['strip-components'] ? parseInt(o['strip-components'], 10) : 0;
      const root = ctx.isRoot; const umask = ctx.fs._umask();
      const dirs = [];
      for (const e of parsed.entries) {
        ctx.checkAbort();
        if (skip(e)) continue;
        let name = strip(e.name);
        if (nstrip) { const p = name.replace(/\/+$/, '').split('/'); if (p.length <= nstrip) continue; name = p.slice(nstrip).join('/'); }
        if (o.v) log(e.name + '\n');
        if (o.O) { if (e.type === 'f') ctx.out(fromBin(e.data)); continue; }
        const path = real(name.replace(/\/+$/, ''));
        const perm = o.p || root ? e.mode & 0o7777 : e.mode & 0o7777 & ~umask;
        try {
          const parent = dirName(path);
          if (parent !== '.' && !ctx.fs.exists(parent)) ctx.fs.mkdir(parent, { parents: true });
          if (e.type === 'd') {
            if (!ctx.fs.isDir(path)) ctx.fs.mkdir(path, { mode: 0o700 });
            dirs.push({ path, e, perm });
            continue;
          }
          if (lexists(ctx, path)) {
            if (o.k) { bad(name + ': Cannot open: File exists'); continue; }
            ctx.fs.unlink(path);
          }
        } catch (er) {
          if (!isFsErr(er)) throw er;
          if (er.code !== 'ENOENT') { bad(name + ': Cannot open: ' + er.message); continue; }
        }
        try {
          if (e.type === 'l') ctx.fs.symlink(e.link, path);
          else { ctx.fs.write(path, fromBin(e.data), { mode: 0o666 }); ctx.fs.chmod(path, perm); }
          if (!o.m && e.type !== 'l') ctx.fs.utimes(path, e.mtime * 1000);
          if (root && e.type !== 'l') chownByName(ctx, path, e);
        } catch (er) { if (!isFsErr(er)) throw er; bad(name + ': Cannot open: ' + er.message); }
      }
      for (const d of dirs.reverse()) {
        try {
          ctx.fs.chmod(d.path, d.perm);
          if (!o.m) ctx.fs.utimes(d.path, d.e.mtime * 1000);
          if (root) chownByName(ctx, d.path, d.e);
        } catch (er) { if (!isFsErr(er)) throw er; }
      }
    }
    members.forEach((m, i) => { if (!matched.has(i)) bad(m + ': Not found in archive'); });
    return finish();
  }

  const lexists = (ctx, p) => { try { ctx.fs.lstat(p); return true; } catch (e) { if (!isFsErr(e)) throw e; return false; } };

  /** Restore ownership as root: names win when the machine knows them, numeric ids otherwise. */
  function chownByName(ctx, path, e) {
    const u = e.uname && ctx.machine.userByName(e.uname); const gr = e.gname && ctx.machine.groupByName(e.gname);
    try { ctx.fs.chown(path, u ? u.uid : e.uid, gr ? gr.gid : e.gid); } catch (er) { if (!isFsErr(er)) throw er; }
  }

  K.cmd.register({
    name: 'tar', pkg: 'tar', path: '/usr/bin/tar', aliases: [], section: 1,
    summary: 'an archiving utility',
    synopsis: 'tar -c|-t|-x [-zjJ] [-v] [-f ARCHIVE] [-C DIR] [--exclude=PATTERN] [MEMBER...]',
    man: 'DESCRIPTION\n       GNU tar stores many files together in one archive and restores them later. The first argument may be a bundle of letters without a dash (tar xvf a.tar).\n\n' +
      'OPTIONS\n       -c, --create      create a new archive from the listed files and directories\n       -x, --extract     extract members (all of them, or only the listed ones)\n       -t, --list        list the members\n       -v, --verbose     list each member processed; with -t show mode, owner, size and date\n       -f, --file=ARCHIVE  the archive file (- means standard input or output)\n       -z, -j, -J        compress with gzip, bzip2 or xz (extraction detects this by itself)\n       -a                choose the compression from the archive suffix (.tar.gz, .tar.xz ...)\n       -C, --directory=DIR  change to DIR first\n       --strip-components=N  drop N leading path elements on extraction\n       --exclude=PATTERN  skip files matching PATTERN\n       -O                extract to standard output\n       -p, -m, -k        keep permissions, do not restore times, do not overwrite\n\n' +
      'EXAMPLES\n       tar -czvf loot.tgz /home/kali/loot\n              Pack a directory into a compressed archive.\n       tar -tzf loot.tgz\n              List what is inside.\n       tar -xzf loot.tgz -C /tmp\n              Unpack it into /tmp.',
    run: tarRun,
  });

  /* ===================================================================== gzip */

  const GZIP_USAGE = 'Usage: gzip [OPTION]... [FILE]...\nCompress or uncompress FILEs (by default, compress FILES in-place).\n\nMandatory arguments to long options are mandatory for short options too.\n\n' +
    '  -c, --stdout      write on standard output, keep original files unchanged\n  -d, --decompress  decompress\n  -f, --force       force overwrite of output file and compress links\n  -h, --help        give this help\n' +
    "  -k, --keep        keep (don't delete) input files\n  -l, --list        list compressed file contents\n  -L, --license     display software license\n  -n, --no-name     do not save or restore the original name and timestamp\n" +
    '  -N, --name        save or restore the original name and timestamp\n  -q, --quiet       suppress all warnings\n  -r, --recursive   operate recursively on directories\n      --rsyncable   make rsync-friendly archive\n' +
    '  -S, --suffix=SUF  use suffix SUF on compressed files\n      --synchronous synchronous output (safer if system crashes, but slower)\n  -t, --test        test compressed file integrity\n  -v, --verbose     verbose mode\n' +
    '  -V, --version     display version number\n  -1, --fast        compress faster\n  -9, --best        compress better\n\nWith no FILE, or when FILE is -, read standard input.\n\nReport bugs to <bug-gzip@gnu.org>.\n';

  const GZIP_VERSION = 'gzip 1.12\nCopyright (C) 2018 Free Software Foundation, Inc.\nCopyright (C) 1993 Jean-loup Gailly.\nThis is free software.  You may redistribute copies of it under the terms of\n' +
    'the GNU General Public License <https://www.gnu.org/licenses/gpl.html>.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by Jean-loup Gailly.\n';

  const GZ_SUFFIXES = ['.gz', '.z', '.Z', '-gz', '-z', '_z'];

  const ratio = (unc, comp) => (unc ? ((unc - comp) / unc) * 100 : 0).toFixed(1) + '%';

  async function gzipRun(ctx, prog) {
    const g = K.getopt(ctx.args, {
      short: 'cdfhklLnNqrS:tvV123456789',
      long: ['stdout', 'to-stdout', 'decompress', 'uncompress', 'force', 'help', 'keep', 'list', 'license', 'no-name', 'name', 'quiet', 'recursive', 'rsyncable', 'suffix=', 'synchronous', 'test', 'verbose', 'version', 'fast', 'best'],
      alias: { stdout: 'c', 'to-stdout': 'c', decompress: 'd', uncompress: 'd', force: 'f', help: 'h', keep: 'k', list: 'l', license: 'L', 'no-name': 'n', name: 'N', quiet: 'q', recursive: 'r', suffix: 'S', test: 't', verbose: 'v', version: 'V' },
    });
    if (g.err) { ctx.err('gzip: ' + g.err + "\nTry `gzip --help' for more information.\n"); return 1; }
    const o = g.opts;
    if (o.h) { ctx.out(GZIP_USAGE); return 0; }
    if (o.V) { ctx.out(GZIP_VERSION); return 0; }
    if (o.L) { ctx.out(GZIP_VERSION.split('\n').slice(0, 5).join('\n') + '\n'); return 0; }
    const decomp = prog !== 'gzip' || !!o.d || !!o.t; const toOut = prog === 'zcat' || !!o.c;
    const suffix = o.S && o.S !== true ? o.S : '.gz';
    const level = o.fast || o[1] ? 1 : o.best || o[9] ? 9 : 6;
    let status = 0;
    const warn = (msg) => { if (!o.q) ctx.err('gzip: ' + msg + '\n'); if (status === 0) status = 2; };
    const error = (msg) => { ctx.err('gzip: ' + msg + '\n'); status = 1; };

    const listRows = [];
    const listing = (bin, name, when) => {
      const info = gzInfo(bin);
      if (!info) { error(name + ': not in gzip format'); return; }
      listRows.push({ comp: bin.length, unc: info.size, body: bin.length - info.hdr - 8, name: name.replace(/\.gz$/, ''), when, info });
    };

    async function output(path, data, src) {
      if (ctx.fs.exists(path)) {
        if (!o.f) {
          let yes = false;
          if (ctx.stdinTTY && ctx.errTTY) { const a = await ctx.readLine('gzip: ' + path + ' already exists; do you wish to overwrite (y or n)? '); yes = a != null && /^y/i.test(a); } else ctx.err('gzip: ' + path + ' already exists;');
          if (!yes) { ctx.err('\tnot overwritten\n'); if (status === 0) status = 2; return false; }
        }
      }
      try {
        ctx.fs.write(path, data, { mode: 0o666 });
        ctx.fs.chmod(path, src.mode & 0o7777);
        if (!o.n || decomp) ctx.fs.utimes(path, src.mtime);
        if (ctx.isRoot) ctx.fs.chown(path, src.uid, src.gid);
      } catch (e) { if (!isFsErr(e)) throw e; error(path + ': ' + e.message); return false; }
      return true;
    }

    async function one(name) {
      ctx.checkAbort();
      let path = name; let st;
      try { st = ctx.fs.stat(path); } catch (e) {
        if (!isFsErr(e)) throw e;
        if (decomp && e.code === 'ENOENT' && !GZ_SUFFIXES.some((s) => name.endsWith(s))) {
          path = name + suffix;
          try { st = ctx.fs.stat(path); } catch (e2) { if (!isFsErr(e2)) throw e2; error(path + ': ' + e2.message); return; }
        } else { error(name + ': ' + e.message); return; }
      }
      if (st.isDir) {
        if (o.r) { for (const k of ctx.fs.readdir(path)) await one(joinPath(path, k)); return; }
        warn(path + ' is a directory -- ignored'); return;
      }
      if (!st.isFile) { warn(path + ' is not a regular file -- ignored'); return; }
      let content;
      try { content = ctx.fs.read(path); } catch (e) { if (!isFsErr(e)) throw e; error(path + ': ' + e.message); return; }

      if (o.l) { listing(content, path, st.mtime); return; }
      const sfx = GZ_SUFFIXES.find((x) => path.endsWith(x)) || (o.S && path.endsWith(suffix) ? suffix : null);
      if (decomp && !toOut && !o.t && !sfx) { warn(path + ': unknown suffix -- ignored'); return; }
      if (decomp) {
        const r = decompress(content);
        if (r.error) { error(path + ': ' + r.error); return; }
        if (o.t) { if (o.v) ctx.err(path + ':\t OK\n'); return; }
        if (toOut) { ctx.out(fromBin(r.data)); return; }
        const dest = path.endsWith('.tgz') ? path.slice(0, -4) + '.tar' : path.slice(0, -sfx.length);
        const info = r.info || { mtime: st.mtime };
        if (!(await output(dest, fromBin(r.data), { mode: st.mode, mtime: o.n || !info.mtime ? st.mtime : info.mtime, uid: st.uid, gid: st.gid }))) return;
        if (o.v) ctx.err(path + ':\t' + U.padStart(ratio(r.data.length, content.length - 18), 5) + ' -- replaced with ' + dest + '\n');
        if (!o.k) ctx.fs.unlink(path);
        return;
      }
      if (!toOut && path.endsWith(suffix)) { warn(path + ' already has ' + suffix + ' suffix -- unchanged'); return; }
      const raw = toBin(content);
      const bin = compress('gz', raw, { name: o.n ? '' : baseName(path), mtime: o.n ? 0 : st.mtime, level });
      if (toOut) { if (ctx.isTTY && !o.f) { ctx.err('gzip: compressed data not written to a terminal. Use -f to force compression.\nFor help, type: gzip -h\n'); status = 1; return; } ctx.out(bin); return; }
      const dest = path + suffix;
      if (!(await output(dest, bin, st))) return;
      if (o.v) ctx.err(path + ':\t' + U.padStart(ratio(raw.length, bin.length - 12 - 8), 5) + ' -- replaced with ' + dest + '\n');
      if (!o.k) ctx.fs.unlink(path);
    }

    const files = g.rest;
    if (!files.length || (files.length === 1 && files[0] === '-')) {
      if (o.l) { error('stdin: not in gzip format'); return status; }
      if (ctx.stdin == null) {
        ctx.err('gzip: compressed data not ' + (decomp ? 'read from' : 'written to') + ' a terminal. Use -f to force ' + (decomp ? 'de' : '') + 'compression.\nFor help, type: gzip -h\n');
        return 1;
      }
      if (decomp) {
        const r = decompress(ctx.stdin);
        if (r.error) error('stdin: ' + r.error); else if (o.t) { if (o.v) ctx.err('stdin:\t OK\n'); } else ctx.out(fromBin(r.data));
      } else {
        if (ctx.isTTY && !o.f) { ctx.err('gzip: compressed data not written to a terminal. Use -f to force compression.\nFor help, type: gzip -h\n'); return 1; }
        ctx.out(compress('gz', toBin(ctx.stdin), { level }));
      }
      return status;
    }
    for (const f of files) await one(f);
    if (o.l) printGzList(ctx, listRows, !!o.v, !!o.q);
    return status;
  }

  function printGzList(ctx, rows, verbose, quiet) {
    if (!rows.length) return;
    if (!quiet) ctx.out((verbose ? 'method  crc     date  time  ' : '') + '         compressed        uncompressed  ratio uncompressed_name\n');
    let tc = 0; let tu = 0;
    for (const r of rows) {
      tc += r.comp; tu += r.unc;
      const pre = verbose ? 'defla ' + hex8(r.info.crc) + ' ' + U.lsDate(r.when).slice(0, 12) + ' ' : '';
      ctx.out(pre + U.padStart(r.comp, 19) + ' ' + U.padStart(r.unc, 19) + ' ' + U.padStart(ratio(r.unc, r.body), 6) + ' ' + r.name + '\n');
    }
    if (rows.length > 1) ctx.out((verbose ? '                            ' : '') + U.padStart(tc, 19) + ' ' + U.padStart(tu, 19) + ' ' + U.padStart(ratio(tu, tc - 20 * rows.length), 6) + ' (totals)\n');
  }

  for (const [name, aliases, summary, synopsis] of [
    ['gzip', [], 'compress or expand files', 'gzip [OPTION]... [FILE]...'],
    ['gunzip', ['uncompress'], 'compress or expand files', 'gunzip [OPTION]... [FILE]...'],
    ['zcat', [], 'compress or expand files', 'zcat [OPTION]... [FILE]...'],
  ]) {
    K.cmd.register({
      name, aliases: aliases.filter((a) => a !== 'uncompress'), pkg: 'gzip', path: name === 'gzip' ? '/usr/bin/gzip' : '/usr/bin/' + name, section: 1, summary, synopsis,
      man: 'DESCRIPTION\n       gzip reduces the size of the named files and replaces each FILE with FILE.gz, keeping the owner, mode and modification time. gunzip (gzip -d) restores the original, and zcat (gzip -dc) writes the original to standard output without touching the file.\n\n' +
        'OPTIONS\n       -c, --stdout      write on standard output, keep original files unchanged\n       -d, --decompress  decompress\n       -k, --keep        do not delete the input files\n       -l, --list        show compressed size, original size and ratio\n       -t, --test        check integrity\n       -f, --force       overwrite existing output\n       -r, --recursive   descend into directories\n       -v, --verbose     report the ratio for each file\n       -1 .. -9          faster .. better compression\n       -S, --suffix=SUF  use SUF instead of .gz\n\n' +
        'EXAMPLES\n       gzip -k access.log\n              Create access.log.gz and keep the original.\n       zcat /var/log/auth.log.gz | grep Failed\n              Search a compressed log without unpacking it.\n       gzip -l backup.tar.gz\n              Show the sizes inside a compressed file.',
      run: (ctx) => gzipRun(ctx, name),
    });
  }

  /* ======================================================================= zip */

  const ZIP_HELP = "Copyright (c) 1990-2008 Info-ZIP - Type 'zip \"-L\"' for software license.\nZip 3.0 (July 5th 2008). Usage:\n" +
    'zip [-options] [-b path] [-t mmddyyyy] [-n suffixes] [zipfile list] [-xi list]\n  The default action is to add or replace zipfile entries from list, which\n  can include the special name - to compress standard input.\n' +
    '  If zipfile and list are omitted, zip compresses stdin to stdout.\n  -f   freshen: only changed files  -u   update: only changed or new files\n  -d   delete entries in zipfile    -m   move into zipfile (delete OS files)\n' +
    "  -r   recurse into directories     -j   junk (don't record) directory names\n  -0   store only                   -l   convert LF to CR LF (-ll CR LF to LF)\n  -1   compress faster              -9   compress better\n" +
    '  -q   quiet operation              -v   verbose operation/print version info\n  -c   add one-line comments        -z   add zipfile comment\n  -@   read names from stdin        -o   make zipfile as old as latest entry\n' +
    '  -x   exclude the following names  -i   include only the following names\n  -F   fix zipfile (-FF try harder) -D   do not add directory entries\n  -A   adjust self-extracting exe   -J   junk zipfile prefix (unzipsfx)\n' +
    '  -T   test zipfile integrity       -X   eXclude eXtra file attributes\n  -y   store symbolic links as the link instead of the referenced file\n' +
    "  -e   encrypt                      -n   don't compress these suffixes\n  -h2  show more help\n";

  const UNZIP_HELP = 'UnZip 6.00 of 20 April 2009, by Debian. Original by Info-ZIP.\n\nUsage: unzip [-Z] [-opts[modifiers]] file[.zip] [list] [-x xlist] [-d exdir]\n' +
    '  Default action is to extract files in list, except those in xlist, to exdir;\n  file[.zip] may be a wildcard.  -Z => ZipInfo mode ("unzip -Z" for usage).\n\n' +
    '  -p  extract files to pipe, no messages     -l  list files (short format)\n  -f  freshen existing files, create none    -t  test compressed archive data\n' +
    '  -u  update files, create if necessary      -z  display archive comment only\n  -v  list verbosely/show version info       -T  timestamp archive to latest\n' +
    '  -x  exclude files that follow (in xlist)   -d  extract files into exdir\nmodifiers:\n  -n  never overwrite existing files         -q  quiet mode (-qq => quieter)\n' +
    '  -o  overwrite files WITHOUT prompting      -a  auto-convert any text files\n  -j  junk paths (do not make directories)   -aa treat ALL files as text\n' +
    '  -U  use escapes for all non-ASCII Unicode  -UU ignore any Unicode fields\n  -C  match filenames case-insensitively     -L  make (some) names lowercase\n' +
    '  -X  restore UID/GID info                   -V  retain VMS version numbers\n  -K  keep setuid/setgid/tacky permissions   -M  pipe through "more" pager\n' +
    '  -O CHARSET  specify a character encoding for DOS, Windows and OS/2 archives\n  -I CHARSET  specify a character encoding for UNIX and other archives\n\n' +
    'See "unzip -hh" or unzip.txt for more help.  Examples:\n  unzip data1 -x joe   => extract all files except joe from zipfile data1.zip\n' +
    '  unzip -p foo | more  => send contents of foo.zip via pipe into program more\n  unzip -fo foo ReadMe => quietly replace existing ReadMe if archive file newer\n';

  const dosStamp = (ms) => {
    const d = new Date(ms); const y = Math.max(1980, d.getUTCFullYear());
    return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
  };
  const dosToMs = (time, date) => Date.UTC(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);

  /** Serialise entries {name, bin, mtime, mode, level} into a zip file (local headers, central directory, end record). */
  function zipBuild(entries) {
    let body = ''; let central = '';
    for (const e of entries) {
      const dir = e.name.endsWith('/'); const packed = dir || e.level === 0 ? null : lzPack(e.bin);
      const deflate = packed != null && packed.length < e.bin.length;
      const data = deflate ? packed : e.bin; const method = deflate ? 8 : 0; const need = dir ? 10 : deflate ? 20 : 10;
      const st = dosStamp(e.mtime); const crc = crc32(e.bin);
      const common = le(method, 2) + le(st.time, 2) + le(st.date, 2) + le(crc, 4) + le(data.length, 4) + le(e.bin.length, 4) + le(e.name.length, 2);
      const attr = ((dir ? 0o040000 : 0o100000) | (e.mode & 0o7777)) * 65536 + (dir ? 0x10 : 0);
      central += 'PK\x01\x02' + le(0x031e, 2) + le(need, 2) + le(0, 2) + common + le(0, 2) + le(0, 2) + le(0, 2) + le(0, 2) + le(attr, 4) + le(body.length, 4) + e.name;
      body += 'PK\x03\x04' + le(need, 2) + le(0, 2) + common + le(0, 2) + e.name + data;
    }
    return body + central + 'PK\x05\x06' + le(0, 2) + le(0, 2) + le(entries.length, 2) + le(entries.length, 2) + le(central.length, 4) + le(body.length, 4) + le(0, 2);
  }

  /** Read a zip file back. Returns null when no end-of-central-directory record exists. */
  function zipParse(bin) {
    const end = bin.lastIndexOf('PK\x05\x06');
    if (end < 0) return null;
    const n = rd(bin, end + 10, 2); let off = rd(bin, end + 16, 4); const entries = [];
    for (let i = 0; i < n; i++) {
      if (bin.substr(off, 4) !== 'PK\x01\x02') return null;
      const method = rd(bin, off + 10, 2); const stamp = dosToMs(rd(bin, off + 12, 2), rd(bin, off + 14, 2));
      const nlen = rd(bin, off + 28, 2); const elen = rd(bin, off + 30, 2); const clen = rd(bin, off + 32, 2);
      const attr = rd(bin, off + 38, 4); const lo = rd(bin, off + 42, 4);
      const e = { name: bin.substr(off + 46, nlen), method, crc: rd(bin, off + 16, 4), csize: rd(bin, off + 20, 4), usize: rd(bin, off + 24, 4), mtime: stamp, mode: Math.floor(attr / 65536) & 0o7777 };
      const start = lo + 30 + rd(bin, lo + 26, 2) + rd(bin, lo + 28, 2);
      e.raw = bin.substr(start, e.csize);
      e.isDir = e.name.endsWith('/');
      entries.push(e);
      off += 46 + nlen + elen + clen;
    }
    return entries;
  }
  /** Uncompressed bytes of a parsed entry, or null when it is damaged. */
  function zipData(e) {
    const bin = e.method === 8 ? lzUnpack(e.raw) : e.raw;
    return bin != null && crc32(bin) === e.crc ? bin : null;
  }

  async function zipRun(ctx) {
    const args = ctx.args; const flags = {}; const list = []; const excl = []; const incl = [];
    let target = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-h' || a === '-h2' || a === '--help') { ctx.out(ZIP_HELP); return 0; }
      if (a === '-x' || a === '-i') { const dest = a === '-x' ? excl : incl; while (i + 1 < args.length && !args[i + 1].startsWith('-')) dest.push(args[++i]); continue; }
      if (a.startsWith('--')) { ctx.err("\nzip error: Invalid command arguments (long option '" + a.slice(2) + "' not supported)\n"); return 16; }
      if (a.startsWith('-') && a.length > 1) {
        for (const ch of a.slice(1)) {
          if (!'rqjdmufDXyTkv0123456789'.includes(ch)) { ctx.err("\nzip error: Invalid command arguments (short option '" + ch + "' not supported)\n"); return 16; }
          flags[ch] = true;
          if (/\d/.test(ch)) flags.level = +ch;
        }
        continue;
      }
      if (target == null) target = a; else list.push(a);
    }
    if (target == null) { ctx.out(ZIP_HELP); return 0; }
    if (!ctx.fs.exists(target) && !/\.[^/]*$/.test(baseName(target))) target += '.zip';
    let entries = [];
    if (ctx.fs.exists(target)) {
      const parsed = zipParse(ctx.fs.read(target));
      if (parsed) entries = parsed.map((e) => ({ name: e.name, bin: zipData(e) || '', mtime: e.mtime, mode: e.mode, level: 6 }));
    }
    const say = (s) => { if (!flags.q) ctx.out(s); };
    const matches = (name, pats) => pats.some((p) => U.globToRe(p).test(name));
    let warned = false;
    const warn = (name) => { ctx.err('\tzip warning: name not matched: ' + name + '\n'); warned = true; };
    const nothing = () => { ctx.err('\nzip error: Nothing to do! (' + target + ')\n'); return 12; };

    if (flags.d) {
      let removed = 0;
      for (const p of list) {
        const hit = entries.filter((e) => U.globToRe(p).test(e.name));
        if (!hit.length) { warn(p); continue; }
        for (const e of hit) { say('deleting: ' + e.name + '\n'); removed++; }
        entries = entries.filter((e) => !hit.includes(e));
      }
      if (!removed) return nothing();
      ctx.fs.write(target, zipBuild(entries));
      return warned ? 18 : 0;
    }
    if (!list.length) return nothing();

    const gather = (name, out) => {
      ctx.checkAbort();
      let st;
      try { st = ctx.fs.stat(name); } catch (e) { if (!isFsErr(e)) throw e; return false; }
      if (st.isDir) {
        out.push({ name: name.replace(/\/*$/, '/'), st, path: name });
        if (flags.r) for (const k of ctx.fs.readdir(name)) gather(joinPath(name, k), out);
      } else out.push({ name, st, path: name });
      return true;
    };
    let added = 0;
    for (const arg of list) {
      const found = []; const ok = gather(arg, found);
      if (!ok) { warn(arg); continue; }
      for (const f of found) {
        let name = flags.j ? baseName(f.name) + (f.name.endsWith('/') ? '/' : '') : f.name;
        if (flags.j && f.name.endsWith('/')) continue;
        name = name.replace(/^\/+/, '');
        if ((excl.length && matches(name, excl)) || (incl.length && !matches(name, incl))) continue;
        if (flags.D && name.endsWith('/')) continue;
        const dir = name.endsWith('/');
        let content = '';
        if (!dir) { try { content = toBin(ctx.fs.read(f.path)); } catch (e) { if (!isFsErr(e)) throw e; ctx.err('\tzip warning: ' + f.path + ': ' + e.message + '\n'); warned = true; continue; } }
        const entry = { name, bin: content, mtime: f.st.mtime, mode: f.st.mode, level: flags.level == null ? 6 : flags.level };
        const idx = entries.findIndex((e) => e.name === name);
        const verb = idx >= 0 ? 'updating' : '  adding';
        if (idx >= 0) entries[idx] = entry; else entries.push(entry);
        const packed = dir || entry.level === 0 ? null : lzPack(content);
        const pct = packed != null && packed.length < content.length ? 'deflated ' + Math.round((1 - packed.length / content.length) * 100) : 'stored 0';
        say(verb + ': ' + name + ' (' + pct + '%)\n');
        added++;
      }
    }
    if (!added) return nothing();
    ctx.fs.write(target, zipBuild(entries));
    if (flags.m) for (const arg of list) { try { if (ctx.fs.isDir(arg)) ctx.fs.rmTree(arg); else ctx.fs.unlink(arg); } catch (e) { if (!isFsErr(e)) throw e; } }
    return warned ? 18 : 0;
  }

  async function unzipRun(ctx) {
    const args = ctx.args; const f = {}; const names = []; const xlist = []; let zipName = null; let dir = null; let inX = false;
    if (!args.length) { ctx.out(UNZIP_HELP); return 0; }
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-h' || a === '--help') { ctx.out(UNZIP_HELP); return 0; }
      if (a.startsWith('-') && a.length > 1) {
        inX = false;
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          if (ch === 'd') { dir = a.slice(j + 1) || args[++i]; break; }
          if (ch === 'x') { inX = true; continue; }
          if (ch === 'Z') { f.Z = a.slice(j + 1); break; }
          f[ch] = (f[ch] || 0) + 1;
        }
        continue;
      }
      if (inX) xlist.push(a); else if (zipName == null) zipName = a; else names.push(a);
    }
    if (zipName == null) { ctx.out(UNZIP_HELP); return 0; }
    const candidates = zipName.endsWith('.zip') ? [zipName, zipName + '.zip', zipName + '.ZIP'] : [zipName, zipName + '.zip', zipName + '.ZIP'];
    const found = candidates.find((c) => ctx.fs.isFile(c));
    if (!found) {
      ctx.err('unzip:  cannot find or open ' + candidates[0] + ', ' + candidates[1] + ' or ' + candidates[2] + '.\n');
      return 9;
    }
    const entries = zipParse(ctx.fs.read(found));
    if (!entries) {
      ctx.out('Archive:  ' + found + '\n  End-of-central-directory signature not found.  Either this file is not\n  a zipfile, or it constitutes one disk of a multi-part archive.  In the\n  latter case the central directory and zipfile comment will be found on\n  the last disk(s) of this archive.\n');
      ctx.err('unzip:  cannot find zipfile directory in one of ' + zipName + ' or\n        ' + zipName + '.zip, and cannot find ' + zipName + '.ZIP, period.\n');
      return 9;
    }
    const quiet = f.q > 0 || f.p;
    const say = (s) => { if (!quiet) ctx.out(s); };
    if (f.Z === '1') { for (const e of entries) ctx.out(e.name + '\n'); return 0; }
    say('Archive:  ' + found + '\n');
    let status = 0;
    const sel = [];
    for (const p of names.length ? names : [null]) {
      const re = p == null ? null : U.globToRe(p);
      const hit = entries.filter((e) => (re ? re.test(e.name) : true) && !xlist.some((x) => U.globToRe(x).test(e.name)));
      if (p != null && !hit.length) { ctx.out('caution: filename not matched:  ' + p + '\n'); status = 11; }
      for (const e of hit) if (!sel.includes(e)) sel.push(e);
    }
    const when = (ms) => U.isoDate(ms).slice(0, 16);
    if (f.l || f.v) {
      const tot = sel.reduce((n, e) => n + e.usize, 0); const ctot = sel.reduce((n, e) => n + e.csize, 0);
      const files = sel.length + ' file' + (sel.length === 1 ? '' : 's') + '\n';
      const pct = (u, c) => (u ? Math.round((1 - c / u) * 100) : 0);
      if (f.v) {
        ctx.out(' Length   Method    Size  Cmpr    Date    Time   CRC-32   Name\n--------  ------  ------- ---- ---------- ----- --------  ----\n');
        for (const e of sel) ctx.out(U.padStart(e.usize, 8) + '  ' + U.padEnd(e.method === 8 ? 'Defl:N' : 'Stored', 6) + ' ' + U.padStart(e.csize, 7) + ' ' + U.padStart(pct(e.usize, e.csize), 3) + '% ' + when(e.mtime) + ' ' + hex8(e.crc) + '  ' + e.name + '\n');
        ctx.out('--------          -------  ---                            -------\n' + U.padStart(tot, 8) + '         ' + U.padStart(ctot, 7) + ' ' + U.padStart(pct(tot, ctot), 3) + '%                            ' + files);
      } else {
        ctx.out('  Length      Date    Time    Name\n---------  ---------- -----   ----\n');
        for (const e of sel) ctx.out(U.padStart(e.usize, 9) + '  ' + when(e.mtime) + '   ' + e.name + '\n');
        ctx.out('---------                     -------\n' + U.padStart(tot, 9) + '                     ' + files);
      }
      return status;
    }
    if (f.t) {
      for (const e of sel) {
        const ok = e.isDir || zipData(e) != null;
        say('    testing: ' + U.padEnd(e.name, 24) + ' ' + (ok ? 'OK' : 'bad CRC') + '\n');
        if (!ok) status = 2;
      }
      if (f.q === undefined) ctx.out(status === 2 ? 'At least one error was detected in ' + found + '.\n' : 'No errors detected in compressed data of ' + found + '.\n');
      return status;
    }
    const root = dir == null ? '' : dir; let policy = f.o ? 'A' : f.n ? 'N' : null;
    if (dir != null && !ctx.fs.isDir(dir)) { try { ctx.fs.mkdir(dir, { parents: true }); } catch (e) { if (!isFsErr(e)) throw e; ctx.err('checkdir:  cannot create extraction directory: ' + dir + '\n           ' + e.message + '\n'); return 1; } }
    for (const e of sel) {
      ctx.checkAbort();
      const rel = f.j ? baseName(e.name) : e.name;
      if (!rel) continue;
      const path = root ? joinPath(root, rel) : rel;
      const shown = path.replace(/\/$/, '') + (e.isDir ? '/' : '');
      const data = e.isDir ? '' : zipData(e);
      if (data == null) { ctx.err('error:  invalid compressed data to inflate\n'); status = 2; continue; }
      if (f.p) { ctx.out(fromBin(data)); continue; }
      try {
        if (e.isDir) {
          if (f.j) continue;
          if (!ctx.fs.isDir(path)) { ctx.fs.mkdir(path, { parents: true }); say('   creating: ' + shown + '\n'); }
          continue;
        }
        const parent = dirName(path);
        if (parent !== '.' && !ctx.fs.exists(parent)) ctx.fs.mkdir(parent, { parents: true });
        let target = path;
        if (ctx.fs.exists(path)) {
          if (policy == null) {
            const ans = await ctx.readLine('replace ' + path + '? [y]es, [n]o, [A]ll, [N]one, [r]ename: ');
            if (ans == null) { ctx.out('\n(EOF or read error, treating as "[N]one" ...)\n'); policy = 'N'; } else if (ans === 'A') policy = 'A'; else if (ans === 'N') policy = 'N';
            else if (ans === 'r') target = (await ctx.readLine('new name: ')) || path; else if (ans !== 'y') continue;
          }
          if (policy === 'N') continue;
        }
        ctx.fs.write(target, fromBin(data), { mode: 0o666 });
        ctx.fs.chmod(target, e.mode ? e.mode & 0o777 : 0o644 & ~ctx.fs._umask());
        ctx.fs.utimes(target, e.mtime);
        say((e.method === 8 ? '  inflating: ' : ' extracting: ') + U.padEnd(shown, 24) + '\n');
      } catch (er) { if (!isFsErr(er)) throw er; ctx.err('error:  cannot create ' + shown + '\n        ' + er.message + '\n'); status = 1; }
    }
    return status;
  }

  K.cmd.register({
    name: 'zip', pkg: 'zip', section: 1, summary: 'package and compress (archive) files',
    synopsis: 'zip [-options] [-b path] [-t mmddyyyy] [-n suffixes] [zipfile list] [-xi list]',
    man: 'DESCRIPTION\n       zip is a compression and file packaging utility. It stores the named files (and, with -r, whole directories) in zipfile, adding .zip when the name has no suffix, and replaces entries that are already there.\n\n' +
      'OPTIONS\n       -r   recurse into directories\n       -j   junk the directory names, store only file names\n       -q   quiet operation\n       -d   delete the named entries from the archive\n       -m   move the files into the archive (delete the originals)\n       -0, -1 .. -9  store only, or compress faster .. better\n       -x list   exclude names matching the patterns that follow\n       -i list   include only names matching the patterns that follow\n\n' +
      'EXAMPLES\n       zip -r site.zip /var/www/html\n              Archive a web root.\n       zip -d site.zip "*.bak"\n              Remove backup files from the archive.',
    run: zipRun,
  });
  K.cmd.register({
    name: 'unzip', pkg: 'unzip', section: 1, summary: 'list, test and extract compressed files in a ZIP archive',
    synopsis: 'unzip [-Z] [-opts[modifiers]] file[.zip] [list] [-x xlist] [-d exdir]',
    man: 'DESCRIPTION\n       unzip lists, tests and extracts files from a ZIP archive. By default every file is extracted into the current directory; existing files ask for confirmation.\n\n' +
      'OPTIONS\n       -l   list the files (short format)\n       -v   list verbosely with method, sizes and CRC\n       -t   test the archive data\n       -p   extract to standard output, no messages\n       -d dir   extract into dir\n       -o   overwrite without prompting\n       -n   never overwrite\n       -j   junk paths, extract everything flat\n       -q   quiet\n       -x list   do not extract the names that follow\n\n' +
      'EXAMPLES\n       unzip -l backup.zip\n              Show what the archive contains.\n       unzip -o backup.zip -d /tmp/restore\n              Extract into /tmp/restore, replacing files.',
    run: unzipRun,
  });

  /* ============================================================ locate / updatedb */

  const LOCATE_DB = '/var/lib/plocate/plocate.db';
  const DB_MAGIC = '\0plocate\0kalima-db-1\n';
  const PRUNE_PATHS = ['/tmp', '/var/spool', '/media', '/var/lib/os-prober', '/var/lib/ceph', '/home/.ecryptfs', '/var/lib/schroot', '/mnt', '/proc', '/sys', '/dev', '/run'];
  const PLOCATE_VERSION = 'plocate 1.1.23\nCopyright 2020 Steinar H. Gunderson\nLicense GPLv2+: GNU GPL version 2 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n';

  async function updatedbRun(ctx) {
    const g = K.getopt(ctx.args, { short: 'o:U:vVhl:', long: ['output=', 'database-root=', 'verbose', 'version', 'help', 'require-visibility=', 'prune-bind-mounts=', 'prunefs=', 'prunepaths=', 'prunenames=', 'add-prunepaths='], alias: { output: 'o', 'database-root': 'U', verbose: 'v', version: 'V', help: 'h' } });
    if (g.err) { ctx.err('updatedb: ' + g.err + "\nTry 'updatedb --help' for more information.\n"); return 1; }
    if (g.opts.V) { ctx.out(PLOCATE_VERSION.replace('plocate', 'updatedb (plocate)')); return 0; }
    if (g.opts.h) { ctx.out('Usage: updatedb [OPTION]...\n  -U, --database-root PATH   the subtree to index [/]\n  -o, --output FILE          the database to build [' + LOCATE_DB + ']\n  -v, --verbose              print paths of files as they are found\n  -h, --help                 print this help\n  -V, --version              print version information\n'); return 0; }
    const out = g.opts.o && g.opts.o !== true ? g.opts.o : LOCATE_DB;
    if (!ctx.isRoot) { ctx.err("updatedb: can not open a temporary file for `" + out + "'\n"); return 1; }
    const start = g.opts.U && g.opts.U !== true ? g.opts.U : '/';
    const paths = [];
    const walk = (p) => {
      ctx.checkAbort();
      if (PRUNE_PATHS.includes(p) || /\/(\.git|\.bzr|\.hg|\.svn)$/.test(p)) return;
      paths.push(p);
      if (g.opts.v) ctx.out(p + '\n');
      let st; try { st = ctx.fs.lstat(p); } catch (e) { if (!isFsErr(e)) throw e; return; }
      if (!st.isDir) return;
      let kids = []; try { kids = ctx.fs.readdir(p); } catch (e) { if (!isFsErr(e)) throw e; }
      for (const k of kids) walk(joinPath(p, k));
    };
    walk(start);
    try {
      ctx.fs.mkdir(dirName(out), { parents: true });
    } catch (e) { if (!isFsErr(e) || e.code !== 'EEXIST') throw e; }
    ctx.fs.write(out, DB_MAGIC + paths.sort().join('\n') + '\n', { mode: 0o640 });
    ctx.fs.chmod(out, 0o640);
    return 0;
  }

  async function locateRun(ctx) {
    const g = K.getopt(ctx.args, {
      short: 'bcd:eil:n:0rsSwVhNLP', long: ['basename', 'count', 'database=', 'existing', 'ignore-case', 'limit=', 'null', 'regexp', 'regex', 'statistics', 'wholename', 'version', 'help', 'literal', 'follow', 'nofollow'],
      alias: { basename: 'b', count: 'c', database: 'd', existing: 'e', 'ignore-case': 'i', limit: 'l', null: '0', regexp: 'r', statistics: 's', wholename: 'w', version: 'V', help: 'h', literal: 'N' },
    });
    if (g.err) { ctx.err('locate: ' + g.err + "\nTry 'locate --help' for more information.\n"); return 1; }
    const o = g.opts;
    if (o.V) { ctx.out(PLOCATE_VERSION); return 0; }
    if (o.h) { ctx.out('Usage: locate [OPTION]... PATTERN...\n\n  -b, --basename         search only the file name portion of path names\n  -c, --count            print number of matches instead of the matches\n  -d, --database DBPATH  search for files in DBPATH\n  -e, --existing         print only names of files that currently exist\n  -i, --ignore-case      ignore case distinctions when matching patterns\n  -l, --limit LIMIT      limit output (or counting) to LIMIT entries\n  -0, --null             separate entries with NUL on output\n  -r, --regexp REGEX     search for basic regexp REGEX instead of patterns\n      --regex            patterns are extended regexps\n  -w, --wholename        search the whole path name (default)\n  -V, --version          print version information\n  -h, --help             print this help\n'); return 0; }
    const dbPath = o.d && o.d !== true ? o.d : LOCATE_DB;
    const limitArg = o.l !== undefined ? o.l : o.n;
    const limit = limitArg === undefined ? Infinity : parseInt(limitArg, 10);
    if (limitArg !== undefined && !(limit >= 0)) { ctx.err('locate: Invalid limit \'' + limitArg + "'\n"); return 1; }
    let patterns = g.rest;
    if (!patterns.length) { ctx.err('locate: no pattern to search for specified\n'); return 1; }
    let db;
    try { db = ctx.vfs.read(ctx.fs.abs(dbPath)); } catch (e) {
      if (!isFsErr(e)) throw e;
      ctx.err("locate: can not open `" + dbPath + "': " + e.message + '\n');
      return 1;
    }
    if (!db.startsWith(DB_MAGIC.slice(0, 9))) { ctx.err('locate: ' + dbPath + ': not a plocate database\n'); return 1; }
    const all = db.slice(DB_MAGIC.length).split('\n').filter(Boolean);
    const flags = o.i ? 'i' : '';
    const matchers = patterns.map((p) => {
      if (o.r || o.regex) { try { return (s) => new RegExp(p, flags).test(s); } catch (e) { ctx.err('locate: Invalid regular expression\n'); return null; } }
      if (!o.N && /[*?[]/.test(p)) { const re = U.globToRe(p, flags); return (s) => re.test(s); }
      const needle = o.i ? p.toLowerCase() : p;
      return (s) => (o.i ? s.toLowerCase() : s).includes(needle);
    });
    if (matchers.includes(null)) return 1;
    const hits = [];
    for (const p of all) {
      const subject = o.b ? baseName(p) : p;
      if (!matchers.some((m) => m(subject))) continue;
      if (o.e && !lexists(ctx, p)) continue;
      hits.push(p);
      if (hits.length >= limit) break;
    }
    if (o.s) { ctx.out(U.padStart(all.length, 9) + ' files\n'); return 0; }
    if (o.c) { ctx.out(hits.length + '\n'); return hits.length ? 0 : 1; }
    ctx.out(hits.map((h) => h + (o['0'] ? '\0' : '\n')).join(''));
    return hits.length ? 0 : 1;
  }

  K.cmd.register({
    name: 'updatedb', pkg: 'plocate', path: '/usr/sbin/updatedb', aliases: [], section: 8, summary: 'create or update the database used by locate',
    synopsis: 'updatedb [-U path] [-o file] [-v]',
    man: 'DESCRIPTION\n       updatedb walks the filesystem and builds the file-name database that locate searches. It must run as root and is normally started once a day by a systemd timer. Files created after the last run are not found by locate until the next update.\n\n' +
      'OPTIONS\n       -U, --database-root PATH   index only this subtree\n       -o, --output FILE          write the database to FILE\n       -v, --verbose              print every path as it is added\n\n' +
      'EXAMPLES\n       sudo updatedb\n              Rebuild the default database.\n       sudo updatedb -U /home -o /tmp/home.db\n              Index only /home.',
    run: updatedbRun,
  });
  K.cmd.register({
    name: 'locate', aliases: ['plocate'], pkg: 'plocate', path: '/usr/bin/locate', section: 1, summary: 'find files by name, quickly, using a prebuilt database',
    synopsis: 'locate [OPTION]... PATTERN...',
    man: 'DESCRIPTION\n       locate searches the database built by updatedb for path names that contain PATTERN. A pattern with * ? or [ is a glob that must match the whole path. The result is only as fresh as the last updatedb run.\n\n' +
      'OPTIONS\n       -i   ignore case\n       -b   match the base name only\n       -c   print only the number of matches\n       -l N   stop after N matches\n       -e   print only entries that still exist\n       -r   treat PATTERN as a regular expression\n       -0   separate output with NUL\n       -d FILE   use another database\n\n' +
      'EXAMPLES\n       locate -i passwd\n              Every path with "passwd" in it, any case.\n       locate -b "*.conf" | head\n              Configuration files by name.',
    run: locateRun,
  });

  /* ===================================================================== dd */

  const COREUTILS_VERSION = (prog, authors) => prog + ' (GNU coreutils) 9.7\nCopyright (C) 2025 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\n' +
    'This is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by ' + authors + '.\n';

  const DD_HELP = 'Usage: dd [OPERAND]...\n  or:  dd OPTION\nCopy a file, converting and formatting according to the operands.\n\n' +
    '  bs=BYTES        read and write up to BYTES bytes at a time (default: 512);\n                  overrides ibs and obs\n  conv=CONVS      convert the file as per the comma separated symbol list\n  count=N         copy only N input blocks\n' +
    '  ibs=BYTES       read up to BYTES bytes at a time (default: 512)\n  if=FILE         read from FILE instead of stdin\n  obs=BYTES       write BYTES bytes at a time (default: 512)\n  of=FILE         write to FILE instead of stdout\n' +
    '  seek=N          skip N obs-sized output blocks\n  skip=N          skip N ibs-sized input blocks\n  status=LEVEL    The LEVEL of information to print to stderr;\n                  \'none\' suppresses everything but error messages,\n                  \'noxfer\' suppresses the final transfer statistics,\n                  \'progress\' shows periodic transfer statistics\n\n' +
    'N and BYTES may be followed by the following multiplicative suffixes:\nc=1, w=2, b=512, kB=1000, K=1024, MB=1000*1000, M=1024*1024, xM=M,\nGB=1000*1000*1000, G=1024*1024*1024, and so on for T, P, E, Z, Y, R, Q.\n\n' +
    'Each CONV symbol may be:\n\n  lcase     change upper case to lower case\n  ucase     change lower case to upper case\n  notrunc   do not truncate the output file\n  sync      pad every input block with NULs to ibs-size\n  noerror   continue after read errors\n  fsync     physically write data and metadata of output file before finishing\n';

  const DD_UNITS = { c: 1, w: 2, b: 512, kB: 1e3, k: 1024, K: 1024, KiB: 1024, MB: 1e6, M: 1048576, MiB: 1048576, GB: 1e9, G: 1073741824, GiB: 1073741824, TB: 1e12, T: 1099511627776, TiB: 1099511627776 };
  function ddNumber(s) {
    const m = /^(\d+)([A-Za-z]*)$/.exec(s);
    if (!m || (m[2] && !(m[2] in DD_UNITS))) return null;
    return +m[1] * (m[2] ? DD_UNITS[m[2]] : 1);
  }

  /** Three significant digits the way coreutils prints sizes: 3.1, 99.1, 188. */
  function sig3(v) { return v < 100 ? (Math.round(v * 10) / 10).toFixed(1) : String(Math.round(v)); }
  function humanUnits(n, base, units) {
    let v = n; let i = 0;
    while (v >= base && i < units.length - 1) { v /= base; i++; }
    return sig3(v) + ' ' + units[i];
  }
  /** printf("%g") with six significant digits. */
  function fmtG(x) {
    if (x === 0) return '0';
    if (x < 1e-4) { const [m, e] = x.toExponential(4).split('e'); return String(+m) + 'e-' + U.pad2(Math.abs(+e)); }
    return String(+x.toPrecision(6));
  }

  /** Print dd's three-line summary. `secs` is the simulated transfer time. */
  function ddStats(ctx, st, secs, level) {
    if (level === 'none') return;
    const rec = (full, part) => full + '+' + part + ' records ';
    ctx.err(rec(st.inFull, st.inPart) + 'in\n' + rec(st.outFull, st.outPart) + 'out\n');
    if (level === 'noxfer') return;
    const n = st.bytes;
    const size = n < 1000 ? n + ' bytes' : n + ' bytes (' + humanUnits(n, 1000, ['B', 'kB', 'MB', 'GB', 'TB']) + ', ' + humanUnits(n, 1024, ['B', 'KiB', 'MiB', 'GiB', 'TiB']) + ')';
    const rate = n && secs ? humanUnits(n / secs, 1000, ['B', 'kB', 'MB', 'GB', 'TB']) + '/s' : '0.0 kB/s';
    ctx.err(size + ' copied, ' + fmtG(secs) + ' s, ' + rate + '\n');
  }

  const DISK_NODE = /^\/dev\/(sd[a-z]\d*|vd[a-z]\d*|nvme\d+n\d+(p\d+)?|sr\d+|loop\d+)$/;

  async function ddRun(ctx) {
    const o = {};
    for (const a of ctx.args) {
      if (a === '--help') { ctx.out(DD_HELP); return 0; }
      if (a === '--version') { ctx.out(COREUTILS_VERSION('dd', 'Paul Rubin, David MacKenzie, and Stuart Kemp')); return 0; }
      const m = /^([a-z]+)=(.*)$/.exec(a);
      if (!m || !['if', 'of', 'bs', 'ibs', 'obs', 'count', 'skip', 'seek', 'conv', 'status', 'iflag', 'oflag'].includes(m[1])) {
        ctx.err("dd: unrecognized operand '" + a + "'\nTry 'dd --help' for more information.\n"); return 1;
      }
      o[m[1]] = m[2];
    }
    const num = (key, dflt) => {
      if (o[key] === undefined) return dflt;
      const v = ddNumber(o[key]);
      if (v == null || (key.endsWith('bs') && v === 0)) { ctx.err("dd: invalid number: '" + o[key] + "'\n"); return false; }
      return v;
    };
    const bs = num('bs', 0); const ibsN = num('ibs', 512); const obsN = num('obs', 512);
    const count = num('count', Infinity); const skip = num('skip', 0); const seek = num('seek', 0);
    if ([bs, ibsN, obsN, count, skip, seek].includes(false)) return 1;
    const ibs = bs || ibsN; const obs = bs || obsN;
    const conv = (o.conv || '').split(',').filter(Boolean);
    for (const c of conv) if (!['ucase', 'lcase', 'notrunc', 'sync', 'noerror', 'fsync', 'fdatasync', 'excl', 'nocreat', 'swab'].includes(c)) { ctx.err("dd: invalid conversion: '" + c + "'\nTry 'dd --help' for more information.\n"); return 1; }
    if (o.status && !['none', 'noxfer', 'progress'].includes(o.status)) { ctx.err("dd: invalid status level: '" + o.status + "'\nTry 'dd --help' for more information.\n"); return 1; }

    // input source: a finite byte string, or an endless generator for /dev/zero and /dev/random
    let src = null; let endless = null; const rnd = K.util.prng('dd:' + K.clock.now());
    if (o.if === undefined || o.if === '-') src = ctx.stdin == null ? '' : toBin(ctx.stdin);
    else {
      let st;
      try { st = ctx.fs.stat(o.if); } catch (e) { if (!isFsErr(e)) throw e; ctx.err("dd: failed to open '" + o.if + "': " + e.message + '\n'); return 1; }
      if (st.isDev) {
        endless = st.dev === 'zero' ? (n) => '\0'.repeat(n) : st.dev === 'random' ? (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode((rnd() * 127) | 0); return s; } : () => '';
      } else if (st.isDir) { ctx.err("dd: error reading '" + o.if + "': Is a directory\n0+0 records in\n0+0 records out\n0 bytes copied, 0.000142 s, 0.0 kB/s\n"); return 1; } else {
        try { src = toBin(ctx.fs.read(o.if)); } catch (e) { if (!isFsErr(e)) throw e; ctx.err("dd: failed to open '" + o.if + "': " + e.message + '\n'); return 1; }
      }
    }
    let sink = 'stdout'; let existing = '';
    if (o.of !== undefined && o.of !== '-') {
      const path = ctx.path(o.of);
      let st = null;
      try { st = ctx.fs.stat(o.of); } catch (e) { if (!isFsErr(e)) throw e; if (e.code !== 'ENOENT') { ctx.err("dd: failed to open '" + o.of + "': " + e.message + '\n'); return 1; } }
      if (st && st.isDev) sink = 'null';
      else if (!st && DISK_NODE.test(path)) {
        if (!ctx.isRoot) { ctx.err("dd: failed to open '" + o.of + "': Permission denied\n"); return 1; }
        sink = 'null'; // raw devices swallow data: nothing in the simulation can be damaged
      } else {
        if (st && st.isDir) { ctx.err("dd: failed to open '" + o.of + "': Is a directory\n"); return 1; }
        if (!st && conv.includes('nocreat')) { ctx.err("dd: failed to open '" + o.of + "': No such file or directory\n"); return 1; }
        if (st && conv.includes('excl')) { ctx.err("dd: failed to open '" + o.of + "': File exists\n"); return 1; }
        try { if (st) existing = toBin(ctx.fs.read(o.of)); ctx.fs.write(o.of, existing, { mode: 0o666 }); } catch (e) { if (!isFsErr(e)) throw e; ctx.err("dd: failed to open '" + o.of + "': " + e.message + '\n'); return 1; }
        sink = path;
      }
    }

    const stats = { inFull: 0, inPart: 0, outFull: 0, outPart: 0, bytes: 0 };
    const keep = sink !== 'null'; const LIMIT = 64 * 1048576;
    let data = ''; let total = 0; let pos = skip * ibs; let blocks = 0; let interrupted = false; let full = false;
    if (src != null && pos > src.length && skip) ctx.err("dd: '" + o.if + "': cannot skip to specified offset\n");
    try {
      while (blocks < count) {
        if (endless) { await ctx.sleep(1); ctx.checkAbort(); }
        const len = endless ? ibs : Math.max(0, Math.min(ibs, src.length - pos));
        if (!len) break;
        if (keep && total + len > LIMIT) { full = true; break; }
        const chunk = keep ? (endless ? endless(len) : src.substr(pos, len)) : '';
        pos += len; blocks++; total += len;
        if (len < ibs) { stats.inPart++; if (conv.includes('sync')) { total += ibs - len; if (keep) data += chunk + '\0'.repeat(ibs - len); continue; } } else stats.inFull++;
        data += chunk;
      }
    } catch (e) {
      if (!(e instanceof K.Interrupt)) throw e;
      interrupted = true;
    }
    if (conv.includes('ucase')) data = data.toUpperCase(); else if (conv.includes('lcase')) data = data.toLowerCase();
    stats.bytes = total;
    stats.outFull = Math.floor(total / obs); stats.outPart = total % obs ? 1 : 0;
    if (sink === 'stdout') ctx.out(fromBin(data));
    else if (sink !== 'null') {
      let result = data;
      if (seek) result = (existing.length >= seek * obs ? existing.slice(0, seek * obs) : existing + '\0'.repeat(seek * obs - existing.length)) + data;
      if (conv.includes('notrunc') && existing.length > result.length) result += existing.slice(result.length);
      try { ctx.fs.write(sink, fromBin(result), { mode: 0o666 }); } catch (e) { if (!isFsErr(e)) throw e; ctx.err("dd: error writing '" + o.of + "': " + e.message + '\n'); return 1; }
    }
    if (full) { ctx.err("dd: error writing '" + o.of + "': No space left on device\n"); ddStats(ctx, stats, 0.0004, o.status); return 1; }
    // a believable duration: a small fixed cost plus a few GB/s
    const secs = 0.00003 + (K.util.hash32('dd' + stats.bytes) % 90) / 1e6 + stats.bytes / 2.4e9;
    if (interrupted) ctx.err('\n');
    ddStats(ctx, stats, secs, o.status);
    return interrupted ? 130 : 0;
  }

  K.cmd.register({
    name: 'dd', pkg: 'coreutils', section: 1, summary: 'convert and copy a file', synopsis: 'dd [OPERAND]...',
    man: 'DESCRIPTION\n       Copy a file, converting and formatting according to the operands. Data is read in blocks and written in blocks; the numbers of full and partial blocks are reported on standard error when dd finishes (or when interrupted with Ctrl-C).\n\n' +
      'OPERANDS\n       if=FILE     read from FILE instead of standard input\n       of=FILE     write to FILE instead of standard output\n       bs=BYTES    block size for reading and writing (suffixes c w b kB K MB M GB G)\n       count=N     copy only N input blocks\n       skip=N      skip N input blocks\n       seek=N      skip N output blocks\n       conv=LIST   ucase, lcase, notrunc, sync, noerror\n       status=LEVEL  none, noxfer or progress\n\n' +
      'EXAMPLES\n       dd if=/dev/zero of=/tmp/blank bs=1M count=10\n              Make a 10 MiB file of zeros.\n       sudo dd if=/dev/sda of=disk.img bs=4M status=progress\n              Image a disk.',
    run: ddRun,
  });

  /* ================================================= lsblk, mount, sync, shred */

  const DISKS = [
    { name: 'sda', maj: 8, min: 0, rm: 0, size: 80 * 1073741824, ro: 0, type: 'disk', children: [
      { name: 'sda1', maj: 8, min: 1, rm: 0, size: 82419448 * 1024, ro: 0, type: 'part', mount: '/', fstype: 'ext4', fsver: '1.0', uuid: '3c1f2d7e-6a41-4b0a-9d21-5e7a0c8b94aa', used: 14380128 * 1024 },
      { name: 'sda2', maj: 8, min: 2, rm: 0, size: 1024, ro: 0, type: 'part' },
      { name: 'sda5', maj: 8, min: 5, rm: 0, size: 1466624 * 1024, ro: 0, type: 'part', mount: '[SWAP]', fstype: 'swap', fsver: '1', uuid: '8e0d4b1a-52c7-47f3-b6a9-1d3f7c2e90b5' },
    ] },
    { name: 'sr0', maj: 11, min: 0, rm: 1, size: 1073741312, ro: 0, type: 'rom' },
  ];

  const sizeText = (n) => {
    if (n === 0) return '0B';
    let v = n; let i = 0; const u = ['B', 'K', 'M', 'G', 'T'];
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return String(Math.round(v * 10) / 10) + u[i];
  };

  const LSBLK_HELP = 'Usage:\n lsblk [options] [<device> ...]\n\nList information about block devices.\n\nOptions:\n -a, --all            print all devices\n -b, --bytes          print SIZE in bytes instead of a human-readable format\n -d, --nodeps         don\'t print slaves or holders\n -f, --fs             output info about filesystems\n -l, --list           use list format output\n -n, --noheadings     don\'t print headings\n -o, --output <list>  output columns\n -p, --paths          print complete device path\n -h, --help           display this help\n -V, --version        display version\n';

  function lsblkRun(ctx) {
    const g = K.getopt(ctx.args, { short: 'abdflno:pVh', long: ['all', 'bytes', 'nodeps', 'fs', 'list', 'noheadings', 'output=', 'paths', 'version', 'help'], alias: { all: 'a', bytes: 'b', nodeps: 'd', fs: 'f', list: 'l', noheadings: 'n', output: 'o', paths: 'p', version: 'V', help: 'h' } });
    if (g.err) { ctx.err('lsblk: ' + g.err + "\nTry 'lsblk --help' for more information.\n"); return 1; }
    const o = g.opts;
    if (o.h) { ctx.out(LSBLK_HELP); return 0; }
    if (o.V) { ctx.out('lsblk from util-linux 2.41.2\n'); return 0; }
    const cols = o.o && o.o !== true ? o.o.toUpperCase().split(',') : o.f ? ['NAME', 'FSTYPE', 'FSVER', 'LABEL', 'UUID', 'FSAVAIL', 'FSUSE%', 'MOUNTPOINTS'] : ['NAME', 'MAJ:MIN', 'RM', 'SIZE', 'RO', 'TYPE', 'MOUNTPOINTS'];
    const right = new Set(['RM', 'SIZE', 'RO', 'FSAVAIL', 'FSUSE%']);
    const value = (d, c, prefix) => {
      switch (c) {
        case 'NAME': return prefix + (o.p ? '/dev/' : '') + d.name;
        case 'PATH': return '/dev/' + d.name;
        case 'KNAME': return d.name;
        case 'MAJ:MIN': return d.maj + ':' + d.min;
        case 'RM': return String(d.rm);
        case 'SIZE': return o.b ? String(d.size) : sizeText(d.size);
        case 'RO': return String(d.ro);
        case 'TYPE': return d.type;
        case 'MOUNTPOINT': case 'MOUNTPOINTS': return d.mount || '';
        case 'FSTYPE': return d.fstype || '';
        case 'FSVER': return d.fsver || '';
        case 'LABEL': return '';
        case 'UUID': return d.uuid || '';
        case 'FSAVAIL': return d.used ? sizeText(d.size - d.used) : '';
        case 'FSUSE%': return d.used ? Math.round((d.used / d.size) * 100) + '%' : '';
        default: return null;
      }
    };
    for (const c of cols) if (value(DISKS[0], c, '') === null) { ctx.err("lsblk: unknown column: " + c + '\n'); return 1; }
    const rows = [];
    const add = (d, prefix, childPrefix) => {
      rows.push(cols.map((c) => value(d, c, o.l ? '' : prefix)));
      const kids = o.d ? [] : d.children || [];
      kids.forEach((k, i) => add(k, o.l ? '' : childPrefix + (i === kids.length - 1 ? '└─' : '├─'), childPrefix + (i === kids.length - 1 ? '  ' : '│ ')));
    };
    for (const d of DISKS) add(d, '', '');
    const table = o.n ? rows : [cols].concat(rows);
    const widths = cols.map((c, i) => Math.max(...table.map((r) => r[i].length)));
    for (const r of table) ctx.out(r.map((cell, i) => (right.has(cols[i]) ? U.padStart(cell, widths[i]) : i === cols.length - 1 ? cell : U.padEnd(cell, widths[i]))).join(' ') + '\n');
    return 0;
  }

  K.cmd.register({
    name: 'lsblk', pkg: 'util-linux', section: 8, summary: 'list block devices', synopsis: 'lsblk [options] [device...]',
    man: 'DESCRIPTION\n       lsblk lists information about all available block devices: disks, their partitions and where they are mounted.\n\nOPTIONS\n       -f, --fs         show filesystem type, UUID, free space and use\n       -l, --list       list format instead of a tree\n       -p, --paths      print full device paths\n       -b, --bytes      sizes in bytes\n       -d, --nodeps     only the disks, not their partitions\n       -n, --noheadings  no header line\n       -o LIST          choose the columns, for example NAME,SIZE,TYPE\n\nEXAMPLES\n       lsblk\n              Show the disk layout.\n       lsblk -f\n              Show filesystems and their UUIDs.',
    run: async (ctx) => lsblkRun(ctx),
  });

  const MOUNT_TABLE = [
    ['sysfs', '/sys', 'sysfs', 'rw,nosuid,nodev,noexec,relatime'],
    ['proc', '/proc', 'proc', 'rw,nosuid,nodev,noexec,relatime'],
    ['udev', '/dev', 'devtmpfs', 'rw,nosuid,relatime,size=1950568k,nr_inodes=487642,mode=755'],
    ['devpts', '/dev/pts', 'devpts', 'rw,nosuid,noexec,relatime,gid=5,mode=620,ptmxmode=000'],
    ['tmpfs', '/run', 'tmpfs', 'rw,nosuid,nodev,noexec,relatime,size=396072k,mode=755'],
    ['/dev/sda1', '/', 'ext4', 'rw,relatime,errors=remount-ro'],
    ['securityfs', '/sys/kernel/security', 'securityfs', 'rw,nosuid,nodev,noexec,relatime'],
    ['tmpfs', '/dev/shm', 'tmpfs', 'rw,nosuid,nodev,size=1980348k'],
    ['tmpfs', '/run/lock', 'tmpfs', 'rw,nosuid,nodev,noexec,relatime,size=5120k'],
    ['cgroup2', '/sys/fs/cgroup', 'cgroup2', 'rw,nosuid,nodev,noexec,relatime,nsdelegate,memory_recursiveprot'],
    ['pstore', '/sys/fs/pstore', 'pstore', 'rw,nosuid,nodev,noexec,relatime'],
    ['systemd-1', '/proc/sys/fs/binfmt_misc', 'autofs', 'rw,relatime,fd=30,pgrp=1,timeout=0,minproto=5,maxproto=5,direct,pipe_ino=9560'],
    ['debugfs', '/sys/kernel/debug', 'debugfs', 'rw,nosuid,nodev,noexec,relatime'],
    ['tmpfs', '/tmp', 'tmpfs', 'rw,nosuid,nodev,size=1980348k,nr_inodes=1048576'],
    ['tmpfs', '/run/user/1000', 'tmpfs', 'rw,nosuid,nodev,relatime,size=396068k,nr_inodes=99017,mode=700,uid=1000,gid=1000'],
  ];

  function mountRun(ctx) {
    const g = K.getopt(ctx.args, { short: 'lt:aVhnrvw', long: ['types=', 'all', 'version', 'help', 'show-labels'], alias: { types: 't', all: 'a', version: 'V', help: 'h' } });
    if (g.err) { ctx.err('mount: ' + g.err + "\nTry 'mount --help' for more information.\n"); return 1; }
    if (g.opts.V) { ctx.out('mount from util-linux 2.41.2 (libmount 2.41.2: selinux, smack, btrfs, verity, namespaces, idmapping, statx, assert, debug)\n'); return 0; }
    if (g.opts.h) { ctx.out('\nUsage:\n mount [-lhV]\n mount -a [options]\n mount [options] [--source] <source> | [--target] <directory>\n mount [options] <source> <directory>\n\nMount a filesystem.\n\nOptions:\n -a, --all               mount all filesystems mentioned in fstab\n -t, --types <list>      limit the set of filesystem types\n -V, --version           display version\n -h, --help              display this help\n'); return 0; }
    if (g.rest.length) {
      if (!ctx.isRoot) { ctx.err('mount: ' + g.rest[g.rest.length - 1] + ': must be superuser to use mount.\n       dmesg(1) may have more information after failed mount system call.\n'); return 32; }
      if (g.rest.length === 1) { ctx.err('mount: ' + g.rest[0] + ": can't find in /etc/fstab.\n"); return 32; }
      const [dev, dir] = g.rest;
      if (!ctx.fs.exists(dir)) { ctx.err('mount: ' + dir + ': mount point does not exist.\n       dmesg(1) may have more information after failed mount system call.\n'); return 32; }
      ctx.err('mount: ' + dir + ': special device ' + dev + ' does not exist.\n       dmesg(1) may have more information after failed mount system call.\n');
      return 32;
    }
    if (g.opts.a) return 0;
    const types = g.opts.t && g.opts.t !== true ? g.opts.t.split(',') : null;
    for (const [dev, dir, type, opts] of MOUNT_TABLE) if (!types || types.includes(type)) ctx.out(dev + ' on ' + dir + ' type ' + type + ' (' + opts + ')\n');
    return 0;
  }

  K.cmd.register({
    name: 'mount', pkg: 'mount', path: '/usr/bin/mount', section: 8, summary: 'mount a filesystem', synopsis: 'mount [-l|-h|-V]\n       mount [-t type] [-o options] device dir',
    man: 'DESCRIPTION\n       All files accessible in a Unix system are arranged in one big tree. mount attaches a filesystem found on some device to that tree. Without arguments it lists the filesystems that are mounted now.\n\nOPTIONS\n       -t type   list or mount only this filesystem type\n       -a        mount everything in /etc/fstab\n       -V        print the version\n\nEXAMPLES\n       mount\n              List all mounted filesystems.\n       mount -t tmpfs\n              Only the tmpfs mounts.\n       sudo mount /dev/sdb1 /mnt\n              Attach a USB disk.',
    run: async (ctx) => mountRun(ctx),
  });

  K.cmd.register({
    name: 'sync', pkg: 'coreutils', section: 1, summary: 'synchronize cached writes to persistent storage', synopsis: 'sync [OPTION] [FILE]...',
    man: 'DESCRIPTION\n       Synchronize cached writes to persistent storage. If one or more files are specified, sync only them; with no files it flushes everything.\n\nOPTIONS\n       -d, --data   sync only file data, no unneeded metadata\n       -f, --file-system   sync the file systems that contain the files\n\nEXAMPLES\n       sync\n              Flush all pending writes, for instance before pulling out a USB stick.',
    run: async (ctx) => {
      const g = K.getopt(ctx.args, { short: 'df', long: ['data', 'file-system', 'help', 'version'] });
      if (g.err) { ctx.err('sync: ' + g.err + "\nTry 'sync --help' for more information.\n"); return 1; }
      if (g.opts.version) { ctx.out(COREUTILS_VERSION('sync', 'Jim Meyering and Giuseppe Scrivano')); return 0; }
      if (g.opts.help) { ctx.out('Usage: sync [OPTION] [FILE]...\nSynchronize cached writes to persistent storage\n\nIf one or more files are specified, sync only them,\nor their containing file systems.\n\n  -d, --data             sync only file data, no unneeded metadata\n  -f, --file-system      sync the file systems that contain the files\n      --help        display this help and exit\n      --version     output version information and exit\n'); return 0; }
      let status = 0;
      for (const f of g.rest) {
        if (!ctx.fs.exists(f)) { ctx.err("sync: error opening '" + f + "': No such file or directory\n"); status = 1; }
      }
      return status;
    },
  });

  async function shredRun(ctx) {
    const g = K.getopt(ctx.args, { short: 'n:s:uvxzf', long: ['iterations=', 'size=', 'remove=?', 'verbose', 'zero', 'force', 'exact', 'help', 'version', 'random-source='], alias: { iterations: 'n', size: 's', verbose: 'v', zero: 'z', force: 'f', exact: 'x' } });
    if (g.err) { ctx.err('shred: ' + g.err + "\nTry 'shred --help' for more information.\n"); return 1; }
    const o = g.opts;
    if (o.help) { ctx.out('Usage: shred [OPTION]... FILE...\nOverwrite the specified FILE(s) repeatedly, in order to make it harder\nfor even very expensive hardware probing to recover the data.\n\n  -f, --force    change permissions to allow writing if necessary\n  -n, --iterations=N  overwrite N times instead of the default (3)\n  -s, --size=N   shred this many bytes (suffixes like K, M, G accepted)\n  -u             deallocate and remove file after overwriting\n  -v, --verbose  show progress\n  -x, --exact    do not round file sizes up to the next full block;\n  -z, --zero     add a final overwrite with zeros to hide shredding\n'); return 0; }
    if (o.version) { ctx.out(COREUTILS_VERSION('shred', 'Colin Plumb')); return 0; }
    let passes = 3;
    if (o.n !== undefined) {
      passes = /^\d+$/.test(o.n) ? +o.n : NaN;
      if (isNaN(passes)) { ctx.err("shred: invalid number of passes: '" + o.n + "'\n"); return 1; }
    }
    if (!g.rest.length) { ctx.err("shred: missing file operand\nTry 'shred --help' for more information.\n"); return 1; }
    const remove = !!o.u || o.remove !== undefined;
    const rnd = K.util.prng('shred:' + K.clock.now());
    let status = 0;
    for (const f of g.rest) {
      ctx.checkAbort();
      let st;
      try { st = ctx.fs.stat(f); } catch (e) { if (!isFsErr(e)) throw e; ctx.err('shred: ' + f + ': failed to open for writing: ' + e.message + '\n'); status = 1; continue; }
      if (st.isDir) { ctx.err('shred: ' + f + ': failed to open for writing: Is a directory\n'); status = 1; continue; }
      if (o.f && !ctx.fs.can(f, 'w')) { try { ctx.fs.chmod(f, st.mode | 0o200); } catch (e) { if (!isFsErr(e)) throw e; } }
      if (!ctx.fs.can(f, 'w')) { ctx.err('shred: ' + f + ': failed to open for writing: Permission denied\n'); status = 1; continue; }
      const size = o.s && o.s !== true ? ddNumber(o.s) : st.size;
      if (size == null) { ctx.err("shred: " + o.s + ': invalid file size\n'); return 1; }
      const total = passes + (o.z ? 1 : 0);
      let content = toBin(ctx.fs.read(f)).slice(0, st.size);
      for (let p = 1; p <= total; p++) {
        const zero = o.z && p === total;
        content = zero ? '\0'.repeat(size) : Array.from({ length: size }, () => String.fromCharCode((rnd() * 127) | 0)).join('');
        if (o.v) ctx.err('shred: ' + f + ': pass ' + p + '/' + total + ' (' + (zero ? '000000' : 'random') + ')...\n');
        await ctx.sleep(5);
      }
      if (total) ctx.fs.write(f, content);
      if (!remove) continue;
      const dir = dirName(f) === '.' ? '' : joinPath(dirName(f), '');
      const base = baseName(f);
      if (o.v) ctx.err('shred: ' + f + ': removing\n');
      let current = f;
      for (let len = base.length; len >= 1; len--) {
        const next = dir + '0'.repeat(len);
        try { ctx.fs.rename(current, next); } catch (e) { if (!isFsErr(e)) throw e; break; }
        if (o.v) ctx.err('shred: ' + current + ': renamed to ' + next + '\n');
        current = next;
      }
      try { ctx.fs.unlink(current); } catch (e) { if (!isFsErr(e)) throw e; ctx.err('shred: ' + f + ': failed to remove: ' + e.message + '\n'); status = 1; continue; }
      if (o.v) ctx.err('shred: ' + f + ': removed\n');
    }
    return status;
  }

  K.cmd.register({
    name: 'shred', pkg: 'coreutils', section: 1, summary: 'overwrite a file to hide its contents, and optionally delete it', synopsis: 'shred [OPTION]... FILE...',
    man: 'DESCRIPTION\n       Overwrite the specified FILE(s) repeatedly, in order to make it harder for even very expensive hardware probing to recover the data. Note that journaling and copy-on-write filesystems may keep old copies of the data.\n\nOPTIONS\n       -n N   overwrite N times instead of the default (3)\n       -u     remove the file after overwriting\n       -z     add a final overwrite with zeros to hide shredding\n       -v     show progress\n       -f     change permissions to allow writing if necessary\n       -s N   shred this many bytes\n\nEXAMPLES\n       shred -vzu secrets.txt\n              Overwrite with random data, then zeros, then delete the file.',
    run: shredRun,
  });

  K.cmdFs2 = { modeString, shellQuote, crc32, lzPack, lzUnpack, toBin, fromBin, compress, decompress };
})(typeof globalThis !== 'undefined' ? globalThis : this);
