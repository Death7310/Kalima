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

  K.cmdFs2 = { modeString, shellQuote };
})(typeof globalThis !== 'undefined' ? globalThis : this);
