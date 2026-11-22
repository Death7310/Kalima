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

  K.cmdFs2 = { modeString, shellQuote, crc32, lzPack, lzUnpack, toBin, fromBin, compress, decompress };
})(typeof globalThis !== 'undefined' ? globalThis : this);
