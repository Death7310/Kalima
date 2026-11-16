/* Kalima — everyday file and directory commands.
 *
 * ls cat head tail tac mkdir rmdir touch cp mv rm ln chmod chown chgrp stat
 * file less more nano vim vi du df tree basename dirname realpath readlink mktemp
 *
 * Everything works on the simulated filesystem (ctx.fs) only.
 */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;
  const VFS = K.VFS;

  /* ================================================================ helpers */

  const q = (s) => "'" + s + "'";
  const isFsError = (e) => e instanceof K.FsError;
  const byteCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const COREUTILS_VERSION = '9.7';

  /** Register a GNU-style command: option parsing, --help, --version and bad-option errors are shared. */
  function gnu(def) {
    const spec = Object.assign({}, def.spec);
    spec.long = (spec.long || []).concat(def.noHelp ? [] : ['help', 'version']);
    const bad = def.badStatus || 1;
    K.cmd.register(Object.assign({ pkg: 'coreutils', section: 1 }, def, {
      async run(ctx) {
        const g = K.getopt(def.prep ? def.prep(ctx.args) : ctx.args, spec);
        if (g.err) {
          ctx.eprintln(ctx.name + ': ' + g.err);
          ctx.eprintln("Try '" + ctx.name + " --help' for more information.");
          return bad;
        }
        if (g.opts.help && !def.noHelp) { ctx.out(helpText(def)); return 0; }
        if (g.opts.version && !def.noHelp) { ctx.out(versionText(ctx.name, def)); return 0; }
        return def.main(ctx, g);
      },
    }));
  }

  function helpText(def) {
    const sum = def.summary.charAt(0).toUpperCase() + def.summary.slice(1);
    return 'Usage: ' + def.synopsis + '\n' + sum + '.\n' + (def.help ? '\n' + def.help.replace(/^\n/, '') : '');
  }
  function versionText(name, def) {
    return name + ' (GNU ' + (def.pkg || 'coreutils') + ') ' + COREUTILS_VERSION + '\n' +
      'Copyright (C) 2025 Free Software Foundation, Inc.\n' +
      'License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\n' +
      'This is free software: you are free to change and redistribute it.\n' +
      'There is NO WARRANTY, to the extent permitted by law.\n\n' +
      'Written by ' + (def.authors || 'Richard M. Stallman and David MacKenzie') + '.\n';
  }

  /** Print "<tool>: <message>" for a filesystem failure on `what`. */
  function fsFail(ctx, text, e) { ctx.err(ctx.name + ': ' + text + ': ' + e.message + '\n'); }

  /** Everything on standard input: the pipe, or lines typed at the terminal until Ctrl-D. */
  async function stdinText(ctx) {
    if (ctx._stdinDone) return '';
    ctx._stdinDone = true;
    if (ctx.stdin != null) return ctx.stdin;
    let s = '';
    for (;;) {
      const line = await ctx.readLine('');
      if (line == null) return s;
      s += line + '\n';
    }
  }

  function splitLines(text) {
    if (text === '') return [];
    const a = text.split('\n');
    if (a[a.length - 1] === '') a.pop();
    return a;
  }

  /** Yield to the event loop so Ctrl-C can be delivered even when sleeping is instantaneous (virtual time). */
  function breathe(ctx) {
    return new Promise((resolve, reject) => setTimeout(() => (ctx.aborted() ? reject(new K.Interrupt()) : resolve()), 0));
  }

  function collator(env) {
    const loc = env.LC_ALL || env.LC_COLLATE || env.LANG || 'C';
    if (loc === 'C' || loc === 'POSIX' || typeof Intl === 'undefined') return byteCompare;
    const c = new Intl.Collator('en-US', { ignorePunctuation: true });
    return (a, b) => c.compare(a, b) || byteCompare(a, b);
  }

  const owner = (ctx, uid) => ctx.machine.userName(uid);
  const group = (ctx, gid) => ctx.machine.groupName(gid);

  /** "-rwxr-xr-x" style mode string for an lstat result. */
  function modeString(st) {
    const t = st.isDir ? 'd' : st.isLink ? 'l' : st.isDev ? 'c' : '-';
    const m = st.mode;
    const tri = (shift, special, onCh, offCh) => {
      const r = m & (4 << shift) ? 'r' : '-'; const w = m & (2 << shift) ? 'w' : '-';
      const x = m & (1 << shift);
      const s = m & special;
      return r + w + (s ? (x ? onCh : offCh) : (x ? 'x' : '-'));
    };
    return t + tri(6, 0o4000, 's', 'S') + tri(3, 0o2000, 's', 'S') + tri(0, 0o1000, 't', 'T');
  }

  /** Parse a size with a GNU multiplier suffix (K, M, G, b, kB ...). Returns null if malformed. */
  function parseSize(s) {
    const m = /^(\d+)(b|kB|KB|K|k|MB|M|GB|G|TB|T)?$/.exec(s);
    if (!m) return null;
    const mult = { b: 512, kB: 1000, KB: 1000, K: 1024, k: 1024, MB: 1e6, M: 1048576, GB: 1e9, G: 1073741824, TB: 1e12, T: 1099511627776 };
    return parseInt(m[1], 10) * (m[2] ? mult[m[2]] : 1);
  }

  const joinPath = (dir, name) => (dir.endsWith('/') ? dir + name : dir + '/' + name);
  const timeOf = (ms) => U.lsDate(ms);

  /* ==================================================================== ls */

  // GNU ls built-in LS_COLORS defaults
  const LS_COLOR = { di: '01;34', ln: '01;36', pi: '33', so: '01;35', bd: '01;33', cd: '01;33', ex: '01;32', su: '37;41', sg: '30;43', tw: '30;42', ow: '34;42', st: '37;44' };

  const paint = (code, s) => '\x1b[' + code + 'm' + s + '\x1b[0m';

  function colorKey(st, orphan) {
    if (st.isLink) return orphan ? 'or' : 'ln';
    if (st.isDir) {
      const ow = st.mode & 0o002; const sticky = st.mode & 0o1000;
      return ow && sticky ? 'tw' : ow ? 'ow' : sticky ? 'st' : 'di';
    }
    if (st.isDev) return 'cd';
    if (st.mode & 0o4000) return 'su';
    if (st.mode & 0o2000) return 'sg';
    if (st.mode & 0o111) return 'ex';
    return null;
  }

  function indicator(st, o) {
    if (st.isDir) return o.indicator ? '/' : '';
    if (!o.classify) return '';
    if (st.isLink) return '@';
    if (st.mode & 0o111 && !st.isDev) return '*';
    return '';
  }

  /** Quote a name the way ls does on a terminal (shell-escape style). */
  function quoteName(name) {
    if (!/[\s!"#$&'()*;<=>?[\\^`{|}~\x00-\x1f\x7f]/.test(name) && !/^[~%]/.test(name)) return name;
    if (name.indexOf("'") < 0) return q(name);
    if (!/[$`\\"\x00-\x1f\x7f]/.test(name)) return '"' + name + '"';
    return q(name.replace(/'/g, "'\\''"));
  }

  /** Arrange cells in columns the way GNU ls does: column-major, per-column widths, 2-space gaps. */
  function lsColumns(cells, width) {
    const n = cells.length;
    if (!n) return '';
    const maxCols = Math.max(1, Math.min(n, Math.floor(width / 3)));
    for (let cols = maxCols; cols >= 1; cols--) {
      const rows = Math.ceil(n / cols);
      const used = Math.ceil(n / rows);
      const widths = [];
      for (let c = 0; c < used; c++) {
        let w = 0;
        for (let r = 0; r < rows && c * rows + r < n; r++) w = Math.max(w, cells[c * rows + r].w);
        widths.push(w);
      }
      const total = widths.reduce((a, b) => a + b, 0) + 2 * (used - 1);
      if (total > width && cols > 1) continue;
      let out = '';
      for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < used; c++) {
          const cell = cells[c * rows + r];
          if (!cell) continue;
          const last = (c + 1) * rows + r >= n;
          line += last ? cell.text : cell.text + ' '.repeat(widths[c] - cell.w + 2);
        }
        out += line + '\n';
      }
      return out;
    }
    return '';
  }

  const LS_SPEC = {
    short: 'laAhRtrSdF1inCpsUxfgoGvXcuL',
    long: ['color=?', 'all', 'almost-all', 'human-readable', 'recursive', 'reverse', 'directory', 'classify', 'numeric-uid-gid',
      'inode', 'group-directories-first', 'si', 'time-style=', 'sort=', 'indicator-style=', 'dereference', 'literal', 'hide-control-chars', 'quote-name', 'full-time'],
    alias: { all: 'a', 'almost-all': 'A', 'human-readable': 'h', recursive: 'R', reverse: 'r', directory: 'd', classify: 'F', 'numeric-uid-gid': 'n', inode: 'i', dereference: 'L', 'quote-name': 'Q' },
  };

  function lsOptions(ctx, g) {
    const o = g.opts;
    const color = o.color === undefined ? false : (o.color === true || o.color === 'always' || o.color === 'yes' || o.color === 'force') ? true
      : (o.color === 'auto' || o.color === 'tty' || o.color === 'if-tty') ? ctx.isTTY : false;
    const sortBy = o.sort ? o.sort : o.t ? 'time' : o.S ? 'size' : o.U || o.f ? 'none' : o.X ? 'extension' : 'name';
    return {
      long: !!(o.l || o.n || o.g || o.o || o.full), numeric: !!o.n, all: !!(o.a || o.f), almost: !!o.A, human: !!o.h,
      recursive: !!o.R, reverse: !!o.r, dirOnly: !!o.d, classify: !!o.F, indicator: !!(o.F || o.p), inode: !!o.i, blocks: !!o.s,
      color, sortBy, dirsFirst: !!o['group-directories-first'], follow: !!o.L, oneColumn: !!o[1], fullTime: o['full-time'] != null,
      tty: ctx.isTTY, width: ctx.cols || 80, collate: collator(ctx.env),
      timeStyle: o['full-time'] ? 'full-iso' : o['time-style'] || null,
    };
  }

  function blocksOf(st) { return st.isDir ? 4 : st.isFile ? Math.ceil(st.size / 4096) * 4 : 0; }

  function fmtTime(ms, o) {
    const d = new Date(ms); const p = U.pad2;
    const iso = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
    const hm = p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
    switch (o.timeStyle) {
      case 'full-iso': return iso + ' ' + hm + ':' + p(d.getUTCSeconds()) + '.000000000 +0000';
      case 'long-iso': return iso + ' ' + hm;
      case 'iso': return Math.abs(K.clock.now() - ms) > 15778800000 ? iso : iso.slice(5) + ' ' + hm;
      default: return timeOf(ms);
    }
  }

  function makeEntry(ctx, o, name, full) {
    let st = ctx.fs.lstat(full);
    let orphan = false;
    if (st.isLink) {
      if (o.follow) { try { st = ctx.fs.stat(full); } catch (e) { orphan = true; } }
      else orphan = !ctx.fs.exists(full) || !(() => { try { ctx.fs.stat(full); return true; } catch (e) { return false; } })();
    }
    return { name, full, st, orphan };
  }

  function sortEntries(list, o) {
    const cmpName = (a, b) => o.collate(a.name, b.name);
    let cmp = cmpName;
    if (o.sortBy === 'time') cmp = (a, b) => b.st.mtime - a.st.mtime || cmpName(a, b);
    else if (o.sortBy === 'size') cmp = (a, b) => b.st.size - a.st.size || cmpName(a, b);
    else if (o.sortBy === 'extension') cmp = (a, b) => byteCompare(a.name.replace(/^.*\./, ''), b.name.replace(/^.*\./, '')) || cmpName(a, b);
    if (o.sortBy !== 'none') list.sort(cmp);
    if (o.reverse) list.reverse();
    if (o.dirsFirst) { const d = list.filter((e) => e.st.isDir); const f = list.filter((e) => !e.st.isDir); list.length = 0; list.push(...d, ...f); }
    return list;
  }

  function lsRender(ctx, o, entries, withTotal) {
    const needQuote = o.tty && entries.some((e) => quoteName(e.name) !== e.name);
    const cell = (e) => {
      let text = o.tty ? quoteName(e.name) : e.name;
      const plainLen = text.length;
      const key = o.color ? colorKey(e.st, e.orphan) : null;
      if (key) text = e.orphan && key === 'or' ? '\x1b[0m' + paint(LS_COLOR.ln, text) : paint(LS_COLOR[key], text);
      const ind = indicator(e.st, o);
      if (needQuote && quoteName(e.name) === e.name) { text = ' ' + text; return { text: text + ind, w: plainLen + 1 + ind.length }; }
      return { text: text + ind, w: plainLen + ind.length };
    };
    const cells = entries.map(cell);
    const prefix = (e) => (o.inode ? e.st.ino + ' ' : '') + (o.blocks ? (o.human ? U.humanSize(blocksOf(e.st) * 1024) : blocksOf(e.st)) + ' ' : '');
    if (o.long) {
      const rows = entries.map((e, i) => {
        const st = e.st;
        const size = st.isDev ? ({ null: '1, 3', zero: '1, 5', random: '1, 8', tty: '5, 0' }[st.dev] || '1, 3') : o.human ? U.humanSize(st.size) : String(st.size);
        let name = cells[i].text;
        if (st.isLink) name += ' -> ' + st.target;
        return {
          ino: String(st.ino), mode: modeString(st), nlink: String(st.nlink),
          owner: o.numeric ? String(st.uid) : owner(ctx, st.uid), group: o.numeric ? String(st.gid) : group(ctx, st.gid),
          size, date: fmtTime(st.mtime, o), name, blk: String(o.human ? U.humanSize(blocksOf(st) * 1024) : blocksOf(st)),
        };
      });
      const w = (k) => Math.max.apply(null, [0].concat(rows.map((r) => r[k].length)));
      const wi = w('ino'); const wl = w('nlink'); const wo = w('owner'); const wg = w('group'); const ws = w('size'); const wb = w('blk');
      let out = '';
      if (withTotal) {
        const total = entries.reduce((a, e) => a + blocksOf(e.st), 0);
        out += 'total ' + (o.human ? U.humanSize(total * 1024) : total) + '\n';
      }
      for (const r of rows) {
        out += (o.inode ? U.padStart(r.ino, wi) + ' ' : '') + (o.blocks ? U.padStart(r.blk, wb) + ' ' : '') + r.mode + ' ' + U.padStart(r.nlink, wl) + ' ' +
          U.padEnd(r.owner, wo) + ' ' + U.padEnd(r.group, wg) + ' ' + U.padStart(r.size, ws) + ' ' + r.date + ' ' + r.name + '\n';
      }
      return out;
    }
    if (o.inode || o.blocks) {
      const px = entries.map(prefix);
      const wp = Math.max.apply(null, px.map((s) => s.length - 1));
      cells.forEach((c, i) => { const p = U.padStart(px[i].trimEnd(), wp) + ' '; c.text = p + c.text; c.w += p.length; });
    }
    if (!o.tty || o.oneColumn) return cells.map((c) => c.text + '\n').join('');
    return lsColumns(cells, o.width);
  }

  async function lsMain(ctx, g) {
    const o = lsOptions(ctx, g);
    const operands = g.rest.length ? g.rest : ['.'];
    let status = 0; let first = true;
    const files = []; const dirs = [];
    for (const arg of operands) {
      let e;
      try {
        e = makeEntry(ctx, o, arg, arg);
        const followDir = e.st.isLink && !o.long && !o.classify && !o.dirOnly;
        if (followDir) { const t = ctx.fs.stat(arg); if (t.isDir) e = { name: arg, full: arg, st: t, orphan: false }; }
      } catch (err) {
        if (!isFsError(err)) throw err;
        ctx.err('ls: cannot access ' + q(arg) + ': ' + err.message + '\n'); status = 2; continue;
      }
      (e.st.isDir && !o.dirOnly ? dirs : files).push(e);
    }
    const multi = operands.length > 1 || o.recursive;
    sortEntries(files, o); sortEntries(dirs, o);
    if (files.length) { ctx.out(lsRender(ctx, o, files, false)); first = false; }

    const listDir = async (e, display) => {
      ctx.checkAbort();
      let names;
      try { names = ctx.fs.readdir(e.full); } catch (err) {
        if (!isFsError(err)) throw err;
        if (!first) ctx.out('\n');
        if (multi) ctx.out(display + ':\n');
        first = false;
        ctx.err('ls: cannot open directory ' + q(display) + ': ' + err.message + '\n'); status = Math.max(status, 2); return;
      }
      if (!(o.all || o.almost)) names = names.filter((n) => n[0] !== '.');
      else if (o.all) names = ['.', '..'].concat(names);
      const list = [];
      for (const n of names) {
        try { list.push(makeEntry(ctx, o, n, joinPath(e.full, n))); } catch (err) {
          if (!isFsError(err)) throw err;
          ctx.err('ls: cannot access ' + q(joinPath(display, n)) + ': ' + err.message + '\n'); status = Math.max(status, 2);
        }
      }
      sortEntries(list, o);
      if (!first) ctx.out('\n');
      if (multi) ctx.out(display + ':\n');
      first = false;
      ctx.out(lsRender(ctx, o, list, true));
      if (o.recursive) {
        for (const c of list) if (c.st.isDir && c.name !== '.' && c.name !== '..') await listDir(c, joinPath(display, c.name));
      }
    };
    for (const d of dirs) await listDir(d, d.name);
    return status;
  }

  gnu({
    name: 'ls', summary: 'list directory contents', synopsis: 'ls [OPTION]... [FILE]...', badStatus: 2,
    man: 'DESCRIPTION\n       List information about the FILEs (the current directory by default). Sort entries alphabetically.\n\nOPTIONS\n       -a     do not ignore entries starting with .\n       -A     do not list implied . and ..\n       -l     use a long listing format\n       -h     with -l, print sizes like 1K 234M 2G\n       -R     list subdirectories recursively\n       -t     sort by time, newest first\n       -S     sort by file size, largest first\n       -r     reverse order while sorting\n       -d     list directories themselves, not their contents\n       -F     append indicator (one of */=>@|) to entries\n       -i     print the index number of each file\n       -n     like -l, but list numeric user and group IDs\n       -1     list one file per line\n       --color[=WHEN]\n              colorize the output; WHEN can be always, auto or never\n\nEXAMPLES\n       ls -la /etc\n              List every entry of /etc with permissions and owners.\n       ls -lh ~/Downloads\n              Long listing with human readable sizes.',
    help: "Mandatory arguments to long options are mandatory for short options too.\n  -a, --all                  do not ignore entries starting with .\n  -A, --almost-all           do not list implied . and ..\n  -d, --directory            list directories themselves, not their contents\n  -F, --classify             append indicator (one of */=>@|) to entries\n  -h, --human-readable       with -l and -s, print sizes like 1K 234M 2G etc.\n  -i, --inode                print the index number of each file\n  -l                         use a long listing format\n  -n, --numeric-uid-gid      like -l, but list numeric user and group IDs\n  -r, --reverse              reverse order while sorting\n  -R, --recursive            list subdirectories recursively\n  -S                         sort by file size, largest first\n  -t                         sort by time, newest first\n  -1                         list one file per line\n      --color[=WHEN]         color the output WHEN\n",
    authors: 'Richard M. Stallman and David MacKenzie',
    spec: LS_SPEC, main: lsMain,
  });

  /* =================================================================== cat */

  /** Convert one line for `cat -v` (control and high bytes shown as ^X and M-x). */
  function showNonPrinting(line, tabs) {
    let out = '';
    for (const b of U.toBytes(line)) {
      let c = b;
      if (c >= 128) { out += 'M-'; c -= 128; }
      if (c === 9 && tabs) out += '^I';
      else if (c === 9) out += '\t';
      else if (c < 32) out += '^' + String.fromCharCode(c + 64);
      else if (c === 127) out += '^?';
      else out += String.fromCharCode(c);
    }
    return out;
  }

  /** A stateful line formatter so cat can process terminal input line by line. */
  function catFormatter(o) {
    let n = 0; let blank = false;
    return (line, newline) => {
      if (line === '') {
        if (o.squeeze && blank) return '';
        blank = true;
      } else blank = false;
      let s = line;
      if (o.nonprint || o.tabs) s = o.nonprint ? showNonPrinting(s, o.tabs) : s.replace(/\t/g, '^I');
      if (o.ends && newline) s += '$';
      if (o.numberAll || (o.numberNonblank && line !== '')) s = U.padStart(++n, 6) + '\t' + s;
      return s + (newline ? '\n' : '');
    };
  }

  gnu({
    name: 'cat', summary: 'concatenate files and print on the standard output', synopsis: 'cat [OPTION]... [FILE]...',
    man: 'DESCRIPTION\n       Concatenate FILE(s) to standard output. With no FILE, or when FILE is -, read standard input.\n\nOPTIONS\n       -A     equivalent to -vET\n       -b     number nonempty output lines, overrides -n\n       -E     display $ at end of each line\n       -n     number all output lines\n       -s     suppress repeated empty output lines\n       -T     display TAB characters as ^I\n       -v     use ^ and M- notation, except for LFD and TAB\n\nEXAMPLES\n       cat /etc/hosts\n              Print the hosts file.\n       cat -n notes.txt\n              Print notes.txt with line numbers.',
    help: "  -A, --show-all           equivalent to -vET\n  -b, --number-nonblank    number nonempty output lines, overrides -n\n  -E, --show-ends          display $ at end of each line\n  -n, --number             number all output lines\n  -s, --squeeze-blank      suppress repeated empty output lines\n  -T, --show-tabs          display TAB characters as ^I\n  -v, --show-nonprinting   use ^ and M- notation, except for LFD and TAB\n",
    authors: 'Torbjorn Granlund and Richard M. Stallman',
    spec: { short: 'AbeEnstTuv', long: ['show-all', 'number-nonblank', 'show-ends', 'number', 'squeeze-blank', 'show-tabs', 'show-nonprinting'],
      alias: { 'show-all': 'A', 'number-nonblank': 'b', 'show-ends': 'E', number: 'n', 'squeeze-blank': 's', 'show-tabs': 'T', 'show-nonprinting': 'v' } },
    async main(ctx, g) {
      const p = g.opts;
      const o = {
        nonprint: !!(p.A || p.e || p.v), ends: !!(p.A || p.E || p.e), tabs: !!(p.A || p.T || p.t), squeeze: !!p.s,
        numberNonblank: !!p.b, numberAll: !!p.n && !p.b,
      };
      const plain = !(o.nonprint || o.ends || o.tabs || o.squeeze || o.numberNonblank || o.numberAll);
      const fmt = catFormatter(o);
      const emit = (text) => {
        if (plain) { ctx.out(text); return; }
        const lines = text.split('\n'); const lastPartial = lines[lines.length - 1] !== '';
        if (!lastPartial) lines.pop();
        let out = '';
        lines.forEach((l, i) => { out += fmt(l, !(lastPartial && i === lines.length - 1)); });
        ctx.out(out);
      };
      let status = 0;
      for (const f of g.rest.length ? g.rest : ['-']) {
        ctx.checkAbort();
        if (f === '-') {
          if (ctx.stdin == null && !ctx._stdinDone) {
            for (;;) { const line = await ctx.readLine(''); if (line == null) break; emit(line + '\n'); }
            ctx._stdinDone = true;
          } else emit(await stdinText(ctx));
          continue;
        }
        try {
          if (ctx.fs.isDir(f)) { ctx.err('cat: ' + f + ': Is a directory\n'); status = 1; continue; }
          emit(ctx.fs.read(f));
        } catch (e) { if (!isFsError(e)) throw e; fsFail(ctx, f, e); status = 1; }
      }
      return status;
    },
  });

  /* ============================================================ head, tail */

  /** Rewrite obsolete "-NUM" arguments to "-n NUM" (but not the value of -n / -c itself). */
  function expandNumericOption(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { out.push(...args.slice(i)); break; }
      if (/^-\d+$/.test(a)) out.push('-n', a.slice(1));
      else { out.push(a); if (/^-[nc]$/.test(a) && i + 1 < args.length) out.push(args[++i]); }
    }
    return out;
  }

  /** Parse head/tail count: returns {n, sign} where sign is '+', '-' or ''. Prints the error and returns null when malformed. */
  function parseCount(ctx, s, what) {
    const m = /^([+-]?)(.*)$/.exec(s);
    const n = parseSize(m[2]);
    if (n == null) { ctx.eprintln(ctx.name + ': invalid number of ' + what + ': ' + q(s)); return null; }
    return { n, sign: m[1] };
  }

  /** Read operands for head/tail: returns [{name, text}|{name, error}] */
  async function readOperand(ctx, f) {
    if (f === '-') return { name: 'standard input', text: await stdinText(ctx) };
    try {
      if (ctx.fs.isDir(f)) return { name: f, dir: true };
      return { name: f, text: ctx.fs.read(f) };
    } catch (e) {
      if (!isFsError(e)) throw e;
      return { name: f, error: e };
    }
  }

  const reduceSpec = {
    short: 'n:c:qvz', long: ['lines=', 'bytes=', 'quiet', 'silent', 'verbose', 'zero-terminated'],
    alias: { lines: 'n', bytes: 'c', quiet: 'q', silent: 'q', verbose: 'v', 'zero-terminated': 'z' },
  };

  const headLines = (text, c) => {
    const lines = splitLines(text);
    const keep = c.sign === '-' ? lines.slice(0, Math.max(0, lines.length - c.n)) : lines.slice(0, c.n);
    if (!keep.length) return '';
    const endsNl = text.endsWith('\n');
    return keep.join('\n') + (keep.length === lines.length && !endsNl ? '' : '\n');
  };
  const headBytes = (text, c) => {
    const b = U.toBytes(text);
    return U.fromBytes(c.sign === '-' ? b.slice(0, Math.max(0, b.length - c.n)) : b.slice(0, c.n));
  };

  gnu({
    name: 'head', summary: 'output the first part of files', synopsis: 'head [OPTION]... [FILE]...',
    man: 'DESCRIPTION\n       Print the first 10 lines of each FILE to standard output. With more than one FILE, precede each with a header giving the file name.\n\nOPTIONS\n       -c, --bytes=[-]NUM\n              print the first NUM bytes of each file; with the leading -, print all but the last NUM bytes\n       -n, --lines=[-]NUM\n              print the first NUM lines instead of the first 10\n       -q     never print headers giving file names\n       -v     always print headers giving file names\n\nEXAMPLES\n       head -n 5 /etc/passwd\n              Show the first five accounts.\n       head -c 100 /etc/os-release\n              Show the first 100 bytes.',
    help: "  -c, --bytes=[-]NUM       print the first NUM bytes of each file;\n                             with the leading '-', print all but the last\n                             NUM bytes of each file\n  -n, --lines=[-]NUM       print the first NUM lines instead of the first 10;\n                             with the leading '-', print all but the last\n                             NUM lines of each file\n  -q, --quiet, --silent    never print headers giving file names\n  -v, --verbose            always print headers giving file names\n",
    authors: 'David MacKenzie and Jim Meyering',
    spec: reduceSpec, prep: expandNumericOption,
    async main(ctx, g) {
      const byBytes = g.opts.c != null;
      const c = byBytes ? parseCount(ctx, g.opts.c, 'bytes') : parseCount(ctx, g.opts.n == null ? '10' : g.opts.n, 'lines');
      if (!c) return 1;
      const files = g.rest.length ? g.rest : ['-'];
      const headers = g.opts.v || (files.length > 1 && !g.opts.q);
      let status = 0; let printed = false;
      for (const f of files) {
        const r = await readOperand(ctx, f);
        if (r.error) { ctx.eprintln('head: cannot open ' + q(f) + ' for reading: ' + r.error.message); status = 1; continue; }
        if (headers) ctx.out((printed ? '\n' : '') + '==> ' + r.name + ' <==\n');
        printed = true;
        if (r.dir) { ctx.eprintln('head: error reading ' + q(f) + ': Is a directory'); status = 1; continue; }
        ctx.out(byBytes ? headBytes(r.text, c) : headLines(r.text, c));
      }
      return status;
    },
  });

  const tailLines = (text, c) => {
    const lines = splitLines(text);
    const keep = c.sign === '+' ? lines.slice(Math.max(0, c.n - 1)) : c.n === 0 ? [] : lines.slice(-c.n);
    if (!keep.length) return '';
    return keep.join('\n') + (text.endsWith('\n') ? '\n' : '');
  };
  const tailBytes = (text, c) => {
    const b = U.toBytes(text);
    return U.fromBytes(c.sign === '+' ? b.slice(Math.max(0, c.n - 1)) : c.n === 0 ? [] : b.slice(-c.n));
  };

  const tailSpec = Object.assign({}, reduceSpec, {
    short: 'n:c:qvzfFs:', long: reduceSpec.long.concat(['follow=?', 'retry', 'sleep-interval=', 'pid=', 'max-unchanged-stats=']),
  });

  gnu({
    name: 'tail', summary: 'output the last part of files', synopsis: 'tail [OPTION]... [FILE]...',
    man: 'DESCRIPTION\n       Print the last 10 lines of each FILE to standard output. With more than one FILE, precede each with a header giving the file name.\n\nOPTIONS\n       -c, --bytes=[+]NUM\n              output the last NUM bytes; or use -c +NUM to output starting with byte NUM\n       -f, --follow\n              output appended data as the file grows\n       -F     same as --follow=name --retry\n       -n, --lines=[+]NUM\n              output the last NUM lines, instead of the last 10; or use -n +NUM to output starting with line NUM\n       -q, -v headers on or off\n\nEXAMPLES\n       tail -n 20 /var/log/auth.log\n              Show the last twenty authentication events.\n       tail -f /var/log/syslog\n              Follow the system log until Ctrl-C.',
    help: "  -c, --bytes=[+]NUM       output the last NUM bytes; or use -c +NUM to\n                             output starting with byte NUM of each file\n  -f, --follow[={name|descriptor}]\n                           output appended data as the file grows\n  -F                       same as --follow=name --retry\n  -n, --lines=[+]NUM       output the last NUM lines, instead of the last 10;\n                             or use -n +NUM to skip NUM-1 lines at the start\n  -q, --quiet, --silent    never output headers giving file names\n  -s, --sleep-interval=N   with -f, sleep for approximately N seconds\n  -v, --verbose            always output headers giving file names\n",
    authors: 'Paul Rubin, David MacKenzie, Ian Lance Taylor, and Jim Meyering',
    spec: tailSpec, prep: expandNumericOption,
    async main(ctx, g) {
      const byBytes = g.opts.c != null;
      const c = byBytes ? parseCount(ctx, g.opts.c, 'bytes') : parseCount(ctx, g.opts.n == null ? '10' : g.opts.n, 'lines');
      if (!c) return 1;
      const follow = !!(g.opts.f || g.opts.F || g.opts.follow);
      const retry = !!(g.opts.F || g.opts.retry);
      const files = g.rest.length ? g.rest : ['-'];
      const headers = g.opts.v || (files.length > 1 && !g.opts.q);
      let status = 0; let printed = false;
      const live = [];
      for (const f of files) {
        const r = await readOperand(ctx, f);
        if (r.error) {
          ctx.eprintln('tail: cannot open ' + q(f) + ' for reading: ' + r.error.message); status = 1;
          if (retry) live.push({ name: f, size: -1 });
          continue;
        }
        if (headers) ctx.out((printed ? '\n' : '') + '==> ' + r.name + ' <==\n');
        printed = true;
        if (r.dir) { ctx.eprintln('tail: error reading ' + q(f) + ': Is a directory'); status = 1; continue; }
        ctx.out(byBytes ? tailBytes(r.text, c) : tailLines(r.text, c));
        if (f !== '-') live.push({ name: f, text: r.text });
      }
      if (!follow || (ctx.stdin != null && files.length === 1 && files[0] === '-')) return status;
      if (!live.length) { ctx.eprintln('tail: no files remaining'); return 1; }
      return tailFollow(ctx, live, headers, retry, parseFloat(g.opts.s || '1') || 1, status);
    },
  });

  /** Poll the followed files until Ctrl-C and print whatever was appended. */
  async function tailFollow(ctx, live, headers, retry, interval, status) {
    let lastShown = live.length === 1 ? live[0].name : null;
    for (;;) {
      await ctx.sleep(interval * 1000);
      await breathe(ctx);
      for (const f of live) {
        let text;
        try { text = ctx.fs.isDir(f.name) ? null : ctx.fs.read(f.name); } catch (e) {
          if (!isFsError(e)) throw e;
          if (f.text != null) { ctx.eprintln('tail: ' + f.name + ': ' + (retry ? 'has become inaccessible: ' : '') + e.message); f.text = retry ? null : f.text; }
          continue;
        }
        if (text == null) continue;
        if (f.text == null) { ctx.eprintln('tail: ' + f.name + ' has appeared;  following new file'); f.text = ''; }
        if (text === f.text) continue;
        let add;
        if (text.startsWith(f.text)) add = text.slice(f.text.length);
        else { ctx.eprintln('tail: ' + f.name + ': file truncated'); add = text; }
        f.text = text;
        if (headers && lastShown !== f.name) ctx.out('\n==> ' + f.name + ' <==\n');
        lastShown = f.name;
        ctx.out(add);
      }
    }
  }

  /* ================================================== modes (chmod, mkdir -m) */

  /**
   * Apply a chmod mode string (octal or symbolic clauses) to `cur`.
   * Returns the new mode, or null when the string is not a valid mode.
   */
  function applyMode(spec, cur, isDir, umask) {
    if (/^[0-7]+$/.test(spec)) {
      if (spec.length > 4) return null;
      const n = parseInt(spec, 8);
      return isDir && spec.length < 5 ? n | (cur & 0o6000) : n;
    }
    let mode = cur;
    for (const clause of spec.split(',')) {
      const m = /^([ugoa]*)((?:[-+=](?:[ugo]|[rwxXst]*))+)$/.exec(clause);
      if (!m) return null;
      let who = m[1]; const implicit = who === '';
      if (implicit) who = 'a';
      const classes = who.indexOf('a') >= 0 ? 'ugo' : who;
      const classMask = { u: 0o4700, g: 0o2070, o: 0o0007 };
      let affected = 0;
      for (const c of classes) affected |= classMask[c];
      if (who.indexOf('a') >= 0) affected |= 0o1000;
      const ops = /([-+=])([ugo]|[rwxXst]*)/g; let op;
      while ((op = ops.exec(m[2]))) {
        let bits = 0;
        const perm = op[2];
        if (/^[ugo]$/.test(perm)) {
          const shift = { u: 6, g: 3, o: 0 }[perm];
          const rwx = (mode >> shift) & 7;
          for (const c of classes) bits |= rwx << { u: 6, g: 3, o: 0 }[c];
        } else {
          let rwx = 0;
          if (perm.indexOf('r') >= 0) rwx |= 4;
          if (perm.indexOf('w') >= 0) rwx |= 2;
          if (perm.indexOf('x') >= 0 || (perm.indexOf('X') >= 0 && (isDir || (mode & 0o111)))) rwx |= 1;
          for (const c of classes) bits |= rwx << { u: 6, g: 3, o: 0 }[c];
          if (perm.indexOf('s') >= 0) bits |= (classes.indexOf('u') >= 0 ? 0o4000 : 0) | (classes.indexOf('g') >= 0 ? 0o2000 : 0);
          if (perm.indexOf('t') >= 0) bits |= 0o1000;
        }
        if (implicit) bits &= ~umask;
        if (op[1] === '+') mode |= bits;
        else if (op[1] === '-') mode &= ~bits;
        else mode = (mode & ~affected) | bits;
      }
    }
    return mode & 0o7777;
  }

  /** Ask a yes/no question; anything starting with y or Y is a yes. */
  async function confirm(ctx, prompt) {
    const line = await ctx.readLine(prompt);
    return line != null && /^y/i.test(line);
  }

  const missingOperand = (ctx, extra) => {
    ctx.eprintln(ctx.name + ': missing ' + (extra || 'operand'));
    ctx.eprintln("Try '" + ctx.name + " --help' for more information.");
    return 1;
  };

  /** Parse the argument of touch -d / --date. Returns milliseconds or null. */
  function parseDate(s, now) {
    s = s.trim();
    const day = 86400000;
    const startOfDay = (t) => t - (t % day);
    if (s === '' || s === 'now') return now;
    if (s === 'today') return startOfDay(now);
    if (s === 'yesterday') return startOfDay(now) - day;
    if (s === 'tomorrow') return startOfDay(now) + day;
    let m = /^@(-?\d+)$/.exec(s);
    if (m) return parseInt(m[1], 10) * 1000;
    m = /^(\d+) (second|minute|hour|day|week|month|year)s? ago$/.exec(s);
    if (m) return now - parseInt(m[1], 10) * { second: 1000, minute: 60000, hour: 3600000, day, week: 7 * day, month: 30 * day, year: 365 * day }[m[2]];
    m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|UTC)?$/.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (m) return startOfDay(now) + ((+m[1] * 60 + +m[2]) * 60 + +(m[3] || 0)) * 1000;
    m = /^(\d{1,2}) (\w{3})\w* (\d{4})$/.exec(s) || null;
    if (m && U.MONTHS.indexOf(m[2][0].toUpperCase() + m[2].slice(1).toLowerCase()) >= 0) return Date.UTC(+m[3], U.MONTHS.indexOf(m[2][0].toUpperCase() + m[2].slice(1).toLowerCase()), +m[1]);
    return null;
  }

  /** touch -t [[CC]YY]MMDDhhmm[.ss] */
  function parseStamp(s, now) {
    const m = /^(?:(\d\d)?(\d\d))?(\d\d)(\d\d)(\d\d)(\d\d)(?:\.(\d\d))?$/.exec(s);
    if (!m) return null;
    const year = m[2] == null ? new Date(now).getUTCFullYear() : m[1] ? +(m[1] + m[2]) : +m[2] < 69 ? 2000 + +m[2] : 1900 + +m[2];
    return Date.UTC(year, +m[3] - 1, +m[4], +m[5], +m[6], +(m[7] || 0));
  }

  const sameFile = (ctx, a, b) => {
    try { return ctx.fs.stat(a).ino === ctx.fs.stat(b).ino && ctx.fs.realpath(a) === ctx.fs.realpath(b); } catch (e) { return false; }
  };

  /* ============================================================ mkdir, rmdir */

  gnu({
    name: 'mkdir', summary: 'make directories', synopsis: 'mkdir [OPTION]... DIRECTORY...',
    man: 'DESCRIPTION\n       Create the DIRECTORY(ies), if they do not already exist.\n\nOPTIONS\n       -m, --mode=MODE\n              set file mode (as in chmod)\n       -p, --parents\n              no error if existing, make parent directories as needed\n       -v, --verbose\n              print a message for each created directory\n\nEXAMPLES\n       mkdir -p ~/engagement/{notes,loot,scans}\n              Create the working folders for a job.\n       mkdir -m 700 secrets\n              Create a private directory.',
    help: "  -m, --mode=MODE   set file mode (as in chmod), not a=rwx - umask\n  -p, --parents     no error if existing, make parent directories as needed,\n                      with their file modes unaffected by any -m option.\n  -v, --verbose     print a message for each created directory\n",
    authors: 'David MacKenzie',
    spec: { short: 'm:pv', long: ['mode=', 'parents', 'verbose'], alias: { mode: 'm', parents: 'p', verbose: 'v' } },
    main(ctx, g) {
      if (!g.rest.length) return missingOperand(ctx);
      let mode = null;
      if (g.opts.m != null) {
        mode = applyMode(g.opts.m, 0o777, true, ctx.shell.umask);
        if (mode == null) { ctx.eprintln(ctx.name + ': invalid mode ' + q(g.opts.m)); return 1; }
      }
      let status = 0;
      const make = (path, final) => {
        ctx.fs.mkdir(path);
        if (final && mode != null) ctx.fs.chmod(path, mode);
        if (g.opts.v) ctx.println("mkdir: created directory '" + path + "'");
      };
      for (const dir of g.rest) {
        try {
          if (g.opts.p) {
            const parts = dir.replace(/\/+$/, '').split('/');
            let cur = dir[0] === '/' ? '' : '.';
            if (dir[0] === '/') parts.shift();
            const shown = [];
            for (let i = 0; i < parts.length; i++) {
              if (parts[i] === '') continue;
              cur = cur === '' ? '/' + parts[i] : cur + '/' + parts[i];
              shown.push(parts[i]);
              const last = i === parts.length - 1;
              if (ctx.fs.exists(cur)) {
                if (last && !ctx.fs.isDir(cur)) throw new K.FsError('EEXIST', dir);
                continue;
              }
              make(dir[0] === '/' ? cur : cur.replace(/^\.\//, ''), last);
            }
          } else make(dir, true);
        } catch (e) {
          if (!isFsError(e)) throw e;
          ctx.eprintln('mkdir: cannot create directory ' + q(dir) + ': ' + e.message); status = 1;
        }
      }
      return status;
    },
  });

  gnu({
    name: 'rmdir', summary: 'remove empty directories', synopsis: 'rmdir [OPTION]... DIRECTORY...',
    man: 'DESCRIPTION\n       Remove the DIRECTORY(ies), if they are empty.\n\nOPTIONS\n       --ignore-fail-on-non-empty\n              ignore each failure that is solely because a directory is non-empty\n       -p, --parents\n              remove DIRECTORY and its ancestors; e.g., rmdir -p a/b is similar to rmdir a/b a\n       -v, --verbose\n              output a diagnostic for every directory processed\n\nEXAMPLES\n       rmdir -p scans/old/2025\n              Remove the three nested empty directories.',
    help: "      --ignore-fail-on-non-empty\n                    ignore each failure that is solely because a directory\n                      is non-empty\n  -p, --parents     remove DIRECTORY and its ancestors; e.g., 'rmdir -p a/b' is\n                      similar to 'rmdir a/b a'\n  -v, --verbose     output a diagnostic for every directory processed\n",
    authors: 'David MacKenzie',
    spec: { short: 'pv', long: ['ignore-fail-on-non-empty', 'parents', 'verbose'], alias: { parents: 'p', verbose: 'v' } },
    main(ctx, g) {
      if (!g.rest.length) return missingOperand(ctx);
      let status = 0;
      const remove = (path) => {
        if (g.opts.v) ctx.println('rmdir: removing directory, ' + q(path));
        ctx.fs.rmdir(path);
      };
      for (const dir of g.rest) {
        try {
          if (!ctx.fs.lstat(dir).isDir) throw new K.FsError('ENOTDIR', dir);
          remove(dir);
          if (g.opts.p) {
            let p = dir.replace(/\/+$/, '');
            while (p.lastIndexOf('/') > 0) { p = p.slice(0, p.lastIndexOf('/')).replace(/\/+$/, ''); if (p === '') break; remove(p); }
          }
        } catch (e) {
          if (!isFsError(e)) throw e;
          if (e.code === 'ENOTEMPTY' && g.opts['ignore-fail-on-non-empty']) continue;
          ctx.eprintln('rmdir: failed to remove ' + q(e.path || dir) + ': ' + e.message); status = 1;
        }
      }
      return status;
    },
  });

  /* =================================================================== touch */

  gnu({
    name: 'touch', summary: 'change file timestamps', synopsis: 'touch [OPTION]... FILE...',
    man: 'DESCRIPTION\n       Update the access and modification times of each FILE to the current time. A FILE argument that does not exist is created empty, unless -c is supplied.\n\nOPTIONS\n       -a, -m change only the access time or only the modification time\n       -c, --no-create\n              do not create any files\n       -d, --date=STRING\n              parse STRING and use it instead of current time\n       -r, --reference=FILE\n              use this file\'s times instead of current time\n       -t STAMP\n              use [[CC]YY]MMDDhhmm[.ss] instead of current time\n\nEXAMPLES\n       touch notes.txt\n              Create notes.txt or refresh its timestamp.\n       touch -d "2026-01-01 12:00" old.log\n              Give old.log a fixed date.',
    help: "  -a                     change only the access time\n  -c, --no-create        do not create any files\n  -d, --date=STRING      parse STRING and use it instead of current time\n  -m                     change only the modification time\n  -r, --reference=FILE   use this file's times instead of current time\n  -t [[CC]YY]MMDDhhmm[.ss]  use specified time instead of current time\n",
    authors: 'Paul Rubin, Arnold Robbins, Jim Kingdon, David MacKenzie, and Randy Smith',
    spec: { short: 'acfmd:r:t:', long: ['no-create', 'date=', 'reference=', 'time='], alias: { 'no-create': 'c', date: 'd', reference: 'r' } },
    main(ctx, g) {
      if (!g.rest.length) return missingOperand(ctx, 'file operand');
      const now = K.clock.now();
      let when = now;
      if (g.opts.r != null) {
        try { when = ctx.fs.stat(g.opts.r).mtime; } catch (e) {
          if (!isFsError(e)) throw e;
          ctx.eprintln('touch: failed to get attributes of ' + q(g.opts.r) + ': ' + e.message); return 1;
        }
      } else if (g.opts.d != null) {
        when = parseDate(g.opts.d, now);
        if (when == null) { ctx.eprintln('touch: invalid date format ' + q(g.opts.d)); return 1; }
      } else if (g.opts.t != null) {
        when = parseStamp(g.opts.t, now);
        if (when == null) { ctx.eprintln('touch: invalid date format ' + q(g.opts.t)); return 1; }
      }
      const explicit = when !== now;
      let status = 0;
      for (const f of g.rest) {
        try {
          if (!ctx.fs.exists(f) && !(ctx.fs.lstat && tryLstat(ctx, f))) {
            if (g.opts.c) continue;
            ctx.fs.write(f, '');
          }
          ctx.fs.utimes(f, explicit ? when : null);
        } catch (e) {
          if (!isFsError(e)) throw e;
          ctx.eprintln('touch: cannot touch ' + q(f) + ': ' + e.message); status = 1;
        }
      }
      return status;
    },
  });

  function tryLstat(ctx, f) { try { return ctx.fs.lstat(f); } catch (e) { return null; } }

  /* ====================================================================== rm */

  const fileKind = (st) => (st.isDir ? 'directory' : st.isLink ? 'symbolic link' : st.isFile && st.size === 0 ? 'regular empty file' : st.isFile ? 'regular file' : 'character special file');

  gnu({
    name: 'rm', summary: 'remove files or directories', synopsis: 'rm [OPTION]... [FILE]...',
    man: 'DESCRIPTION\n       rm removes each specified file. By default, it does not remove directories.\n\nOPTIONS\n       -f, --force\n              ignore nonexistent files and arguments, never prompt\n       -i     prompt before every removal\n       -r, -R, --recursive\n              remove directories and their contents recursively\n       -d, --dir\n              remove empty directories\n       -v, --verbose\n              explain what is being done\n       --no-preserve-root\n              do not treat / specially\n\nEXAMPLES\n       rm -v old.txt\n              Remove old.txt and say so.\n       rm -rf build/\n              Remove a directory tree without asking.',
    help: "  -f, --force           ignore nonexistent files and arguments, never prompt\n  -i                    prompt before every removal\n  -I                    prompt once before removing more than three files, or\n                          when removing recursively\n  -r, -R, --recursive   remove directories and their contents recursively\n  -d, --dir             remove empty directories\n  -v, --verbose         explain what is being done\n",
    authors: 'Paul Rubin, David MacKenzie, Richard M. Stallman, and Jim Meyering',
    spec: { short: 'fiIrRdv', long: ['force', 'recursive', 'dir', 'verbose', 'interactive=?', 'no-preserve-root', 'preserve-root=?', 'one-file-system'], alias: { force: 'f', recursive: 'r', R: 'r', dir: 'd', verbose: 'v' } },
    async main(ctx, g) {
      const o = g.opts;
      if (!g.rest.length) { if (o.f) return 0; return missingOperand(ctx); }
      const force = !!o.f && !o.i;
      const ask = !!o.i || o.interactive === 'always';
      const recursive = !!o.r;
      let status = 0;
      const verbose = (path, st) => { if (o.v) ctx.println((st.isDir ? "removed directory '" : "removed '") + path + "'"); };
      const fail = (path, msg) => { ctx.eprintln('rm: cannot remove ' + q(path) + ': ' + msg); status = 1; };

      const removeOne = async (path, display, top) => {
        ctx.checkAbort();
        let st;
        try { st = ctx.fs.lstat(path); } catch (e) {
          if (!isFsError(e)) throw e;
          if (!(force && e.code === 'ENOENT')) fail(display, e.message);
          return false;
        }
        if (st.isDir) {
          if (!recursive && !o.d) { fail(display, 'Is a directory'); return false; }
          if (recursive) {
            if (ask && !(await confirm(ctx, 'rm: descend into directory ' + q(display) + '? '))) return false;
            let names;
            try { names = ctx.fs.readdir(path); } catch (e) {
              if (!isFsError(e)) throw e;
              ctx.eprintln('rm: cannot remove ' + q(display) + ': ' + e.message); status = 1; return false;
            }
            let clean = true;
            for (const n of names) if (!(await removeOne(joinPath(path, n), joinPath(display, n), false))) clean = false;
            if (!clean) return false;
          }
          if (ask && !(await confirm(ctx, 'rm: remove directory ' + q(display) + '? '))) return false;
          try { ctx.fs.rmdir(path); } catch (e) {
            if (!isFsError(e)) throw e;
            fail(display, e.message); return false;
          }
          verbose(display, st);
          return true;
        }
        const writable = st.isLink || ctx.fs.can(path, 'w');
        if (ask) { if (!(await confirm(ctx, 'rm: remove ' + fileKind(st) + ' ' + q(display) + '? '))) return false; }
        else if (!force && !writable && ctx.stdinTTY && !(await confirm(ctx, 'rm: remove write-protected ' + fileKind(st) + ' ' + q(display) + '? '))) return false;
        try { ctx.fs.unlink(path); } catch (e) {
          if (!isFsError(e)) throw e;
          fail(display, e.message); return false;
        }
        verbose(display, st);
        return top || true;
      };

      for (const f of g.rest) {
        const base = VFS.basename(f.replace(/\/+$/, '') || f);
        if (base === '.' || base === '..') { ctx.eprintln('rm: refusing to remove ' + q('.') + ' or ' + q('..') + ' directory: skipping ' + q(f)); status = 1; continue; }
        if (!o['no-preserve-root'] && ctx.fs.abs(f) === '/') {
          ctx.eprintln('rm: it is dangerous to operate recursively on ' + q('/'));
          ctx.eprintln('rm: use --no-preserve-root to override this failsafe');
          status = 1; continue;
        }
        await removeOne(f, f, true);
      }
      return status;
    },
  });

  /* =================================================================== ln */

  function hardLink(ctx, src, dst) {
    const a = ctx.vfs.walk(ctx.fs.abs(src), { cred: ctx.fs.cred, follow: false });
    if (a.node.t === 'd') throw Object.assign(new K.FsError('EPERM', src), { hardDir: true });
    const b = ctx.vfs.walk(ctx.fs.abs(dst), { cred: ctx.fs.cred, parent: true, follow: false });
    if (b.node) throw new K.FsError('EEXIST', dst);
    if (!ctx.vfs.access(b.parent, ctx.fs.cred, 'w') || !ctx.vfs.access(b.parent, ctx.fs.cred, 'x')) throw new K.FsError('EACCES', dst);
    b.parent.ch.set(b.name, a.node);
    if (ctx.vfs.onChange) ctx.vfs.onChange(b.path);
  }

  gnu({
    name: 'ln', summary: 'make links between files', synopsis: 'ln [OPTION]... [-T] TARGET LINK_NAME\n   or:  ln [OPTION]... TARGET\n   or:  ln [OPTION]... TARGET... DIRECTORY',
    man: 'DESCRIPTION\n       Create a link to TARGET with the name LINK_NAME. Create hard links by default, symbolic links with --symbolic.\n\nOPTIONS\n       -f, --force\n              remove existing destination files\n       -s, --symbolic\n              make symbolic links instead of hard links\n       -v, --verbose\n              print name of each linked file\n       -n, --no-dereference\n              treat LINK_NAME as a normal file if it is a symbolic link to a directory\n       -T     treat LINK_NAME as a normal file always\n\nEXAMPLES\n       ln -s /usr/share/wordlists ~/wordlists\n              Make a shortcut to the wordlists folder.',
    help: "  -f, --force                 remove existing destination files\n  -n, --no-dereference        treat LINK_NAME as a normal file if\n                                it is a symbolic link to a directory\n  -s, --symbolic              make symbolic links instead of hard links\n  -T, --no-target-directory   treat LINK_NAME as a normal file always\n  -v, --verbose               print name of each linked file\n",
    authors: 'Mike Parker and David MacKenzie',
    spec: { short: 'sfvnTi', long: ['symbolic', 'force', 'verbose', 'no-dereference', 'no-target-directory', 'interactive'], alias: { symbolic: 's', force: 'f', verbose: 'v', 'no-dereference': 'n', 'no-target-directory': 'T' } },
    main(ctx, g) {
      const o = g.opts; const args = g.rest.slice();
      if (!args.length) return missingOperand(ctx);
      let dest;
      if (args.length === 1) { dest = '.'; } else dest = args.pop();
      const destIsDir = !o.T && (o.n ? (tryLstat(ctx, dest) && tryLstat(ctx, dest).isDir) : ctx.fs.isDir(dest));
      if (args.length > 1 && !destIsDir) { ctx.eprintln('ln: target ' + q(dest) + ' is not a directory'); return 1; }
      if (args.length === 1 && g.rest.length === 1 && !destIsDir) return 1;
      let status = 0;
      for (const src of args) {
        const name = destIsDir ? joinPath(dest, VFS.basename(src)) : dest;
        try {
          if (!o.s) {
            if (!tryLstat(ctx, src)) { ctx.eprintln('ln: failed to access ' + q(src) + ': No such file or directory'); status = 1; continue; }
          }
          if (tryLstat(ctx, name)) {
            if (!o.f) throw new K.FsError('EEXIST', name);
            ctx.fs.unlink(name);
          }
          if (o.s) ctx.fs.symlink(src, name); else hardLink(ctx, src, name);
          if (o.v) ctx.println(q(name) + (o.s ? ' -> ' : ' => ') + q(src));
        } catch (e) {
          if (!isFsError(e)) throw e;
          if (e.hardDir) ctx.eprintln('ln: ' + q(src) + ': hard link not allowed for directory');
          else ctx.eprintln('ln: failed to create ' + (o.s ? 'symbolic' : 'hard') + ' link ' + q(name) + (o.s ? '' : ' => ' + q(src)) + ': ' + e.message);
          status = 1;
        }
      }
      return status;
    },
  });

  /* ======================================================================= cp */

  /** Shared state-free copy engine for cp. Returns true when everything was copied. */
  async function copyTree(ctx, o, src, dst, top) {
    ctx.checkAbort();
    const sst = o.deref ? ctx.fs.stat(src) : ctx.fs.lstat(src);
    let dstat = tryLstat(ctx, dst);
    if (dstat && dstat.isLink && !sst.isLink && ctx.fs.exists(dst) && !o.deref) { try { dstat = ctx.fs.stat(dst); } catch (e) { /* dangling */ } }
    if (sst.isDir) {
      if (!o.recursive) { ctx.eprintln('cp: -r not specified; omitting directory ' + q(src)); return false; }
      if (dstat && !dstat.isDir) { ctx.eprintln('cp: cannot overwrite non-directory ' + q(dst) + ' with directory ' + q(src)); return false; }
      if ((ctx.fs.abs(dst) + '/').indexOf(ctx.fs.abs(src).replace(/\/$/, '') + '/') === 0) {
        ctx.eprintln('cp: cannot copy a directory, ' + q(src) + ', into itself, ' + q(dst)); return false;
      }
      let ok = true;
      if (!dstat) {
        try { ctx.fs.mkdir(dst, { mode: sst.mode & 0o777 }); } catch (e) { return cpFail(ctx, 'cannot create directory', dst, e); }
        if (o.v) ctx.println(q(src) + ' -> ' + q(dst));
      }
      let names;
      try { names = ctx.fs.readdir(src); } catch (e) { return cpFail(ctx, 'cannot access', src, e); }
      for (const n of names) if (!(await copyTree(ctx, o, joinPath(src, n), joinPath(dst, n), false))) ok = false;
      if (o.preserve) preserveAttrs(ctx, o, dst, sst);
      return ok;
    }
    if (dstat && dstat.isDir) { ctx.eprintln('cp: cannot overwrite directory ' + q(dst) + ' with non-directory'); return false; }
    if (dstat && sameFile(ctx, src, dst)) { ctx.eprintln('cp: ' + q(src) + ' and ' + q(dst) + ' are the same file'); return false; }
    if (dstat) {
      if (o.n) return true;
      if (o.u && dstat.mtime >= sst.mtime) return true;
      if (o.i && !(await confirm(ctx, 'cp: overwrite ' + q(dst) + '? '))) return true;
    }
    if (sst.isLink) {
      try { if (dstat) ctx.fs.unlink(dst); ctx.fs.symlink(sst.target, dst); } catch (e) { return cpFail(ctx, 'cannot create symbolic link', dst, e); }
    } else {
      let data;
      try { data = ctx.fs.read(src); } catch (e) { return cpFail(ctx, 'cannot open', src, e, ' for reading'); }
      try {
        if (dstat && o.f && !ctx.fs.can(dst, 'w')) { ctx.fs.unlink(dst); dstat = null; }
        ctx.fs.write(dst, data, dstat ? undefined : { mode: sst.mode & 0o777 });
      } catch (e) { return cpFail(ctx, 'cannot create regular file', dst, e); }
    }
    if (o.v) ctx.println(q(src) + ' -> ' + q(dst));
    if (o.preserve) preserveAttrs(ctx, o, dst, sst);
    return true;
  }

  function cpFail(ctx, what, path, e, suffix) {
    if (!isFsError(e)) throw e;
    ctx.eprintln('cp: ' + what + ' ' + q(path) + (suffix || '') + ': ' + e.message);
    return false;
  }

  function preserveAttrs(ctx, o, dst, sst) {
    try {
      if (!sst.isLink) ctx.fs.chmod(dst, sst.mode);
      if (o.owner) ctx.fs.chown(dst, sst.uid, sst.gid);
      ctx.fs.utimes(dst, sst.mtime);
    } catch (e) { if (!isFsError(e)) throw e; }
  }

  /** Common driver for cp and mv: SOURCE... DEST handling, -t, -T. Returns the exit status. */
  async function transfer(ctx, g, op, o, verb) {
    let args = g.rest.slice();
    let dest;
    if (g.opts.t != null) dest = g.opts.t;
    else {
      if (!args.length) return missingOperand(ctx, 'file operand');
      if (args.length === 1) { ctx.eprintln(ctx.name + ': missing destination file operand after ' + q(args[0])); ctx.eprintln("Try '" + ctx.name + " --help' for more information."); return 1; }
      dest = args.pop();
    }
    if (!args.length) return missingOperand(ctx, 'file operand');
    const destIsDir = !g.opts.T && ctx.fs.isDir(dest);
    if ((args.length > 1 || g.opts.t != null) && !destIsDir) { ctx.eprintln(ctx.name + ': target ' + q(dest) + ' is not a directory'); return 1; }
    let status = 0;
    for (const src of args) {
      const target = destIsDir ? joinPath(dest, VFS.basename(src.replace(/\/+$/, '') || src)) : dest;
      try { if (!(await op(src, target))) status = 1; } catch (e) {
        if (!isFsError(e)) throw e;
        ctx.eprintln(ctx.name + ': ' + verb(src, target, e) + ': ' + e.message); status = 1;
      }
    }
    return status;
  }

  gnu({
    name: 'cp', summary: 'copy files and directories', synopsis: 'cp [OPTION]... [-T] SOURCE DEST\n   or:  cp [OPTION]... SOURCE... DIRECTORY\n   or:  cp [OPTION]... -t DIRECTORY SOURCE...',
    man: 'DESCRIPTION\n       Copy SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.\n\nOPTIONS\n       -a, --archive\n              same as -dR --preserve=all\n       -f, --force\n              if an existing destination file cannot be opened, remove it and try again\n       -i     prompt before overwrite\n       -n     do not overwrite an existing file\n       -p     preserve mode, ownership and timestamps\n       -r, -R, --recursive\n              copy directories recursively\n       -t DIRECTORY\n              copy all SOURCE arguments into DIRECTORY\n       -u     copy only when the SOURCE file is newer than the destination file or when the destination file is missing\n       -v, --verbose\n              explain what is being done\n\nEXAMPLES\n       cp -r ~/engagement ~/engagement.bak\n              Back up a directory tree.\n       cp -v a.txt b.txt /tmp\n              Copy two files into /tmp.',
    help: "  -a, --archive                same as -dR --preserve=all\n  -f, --force                  if an existing destination file cannot be\n                                 opened, remove it and try again\n  -i, --interactive            prompt before overwrite\n  -n, --no-clobber             do not overwrite an existing file\n  -p                           same as --preserve=mode,ownership,timestamps\n  -R, -r, --recursive          copy directories recursively\n  -t, --target-directory=DIRECTORY  copy all SOURCE arguments into DIRECTORY\n  -T, --no-target-directory    treat DEST as a normal file\n  -u, --update                 copy only when the SOURCE file is newer\n  -v, --verbose                explain what is being done\n",
    authors: 'Torbjorn Granlund, David MacKenzie, and Jim Meyering',
    spec: { short: 'afinpPLdrRuvt:T', long: ['archive', 'force', 'interactive', 'no-clobber', 'preserve=?', 'recursive', 'update', 'verbose', 'target-directory=', 'no-target-directory', 'dereference', 'no-dereference'],
      alias: { archive: 'a', force: 'f', interactive: 'i', 'no-clobber': 'n', recursive: 'r', R: 'r', update: 'u', verbose: 'v', 'target-directory': 't', 'no-target-directory': 'T', dereference: 'L', 'no-dereference': 'P' } },
    async main(ctx, g) {
      const p = g.opts;
      const recursive = !!(p.r || p.a);
      const o = {
        recursive, f: !!p.f, i: !!p.i, n: !!p.n, u: !!p.u, v: !!p.v,
        preserve: !!(p.p || p.a || p.preserve), owner: !!(p.a || (p.p && ctx.isRoot)) && ctx.isRoot,
        deref: p.L ? true : (p.P || p.d || p.a || recursive) ? false : true,
      };
      return transfer(ctx, g, (src, dst) => copyTree(ctx, o, src, dst, true), o, (s, d) => 'cannot stat ' + q(s));
    },
  });

  /* ======================================================================= mv */

  gnu({
    name: 'mv', summary: 'move (rename) files', synopsis: 'mv [OPTION]... [-T] SOURCE DEST\n   or:  mv [OPTION]... SOURCE... DIRECTORY\n   or:  mv [OPTION]... -t DIRECTORY SOURCE...',
    man: 'DESCRIPTION\n       Rename SOURCE to DEST, or move SOURCE(s) to DIRECTORY.\n\nOPTIONS\n       -f, --force\n              do not prompt before overwriting\n       -i, --interactive\n              prompt before overwrite\n       -n, --no-clobber\n              do not overwrite an existing file\n       -t DIRECTORY\n              move all SOURCE arguments into DIRECTORY\n       -u, --update\n              move only when the SOURCE file is newer than the destination\n       -v, --verbose\n              explain what is being done\n\nEXAMPLES\n       mv report.txt report-final.txt\n              Rename a file.\n       mv -v *.log /tmp/logs\n              Move every log file into a directory.',
    help: "  -f, --force                  do not prompt before overwriting\n  -i, --interactive            prompt before overwrite\n  -n, --no-clobber             do not overwrite an existing file\n  -t, --target-directory=DIRECTORY  move all SOURCE arguments into DIRECTORY\n  -T, --no-target-directory    treat DEST as a normal file\n  -u, --update                 move only when the SOURCE file is newer\n  -v, --verbose                explain what is being done\n",
    authors: 'Mike Parker, David MacKenzie, and Jim Meyering',
    spec: { short: 'finuvt:T', long: ['force', 'interactive', 'no-clobber', 'update', 'verbose', 'target-directory=', 'no-target-directory'],
      alias: { force: 'f', interactive: 'i', 'no-clobber': 'n', update: 'u', verbose: 'v', 'target-directory': 't', 'no-target-directory': 'T' } },
    async main(ctx, g) {
      const p = g.opts;
      const move = async (src, dst) => {
        const sst = tryLstat(ctx, src);
        if (!sst) { ctx.eprintln('mv: cannot stat ' + q(src) + ': No such file or directory'); return false; }
        const dstat = tryLstat(ctx, dst);
        if (dstat) {
          if (sameFile(ctx, src, dst) && ctx.fs.abs(src) === ctx.fs.abs(dst)) { ctx.eprintln('mv: ' + q(src) + ' and ' + q(dst) + ' are the same file'); return false; }
          if (sst.isDir && !dstat.isDir) { ctx.eprintln('mv: cannot overwrite non-directory ' + q(dst) + ' with directory ' + q(src)); return false; }
          if (!sst.isDir && dstat.isDir) { ctx.eprintln('mv: cannot overwrite directory ' + q(dst) + ' with non-directory'); return false; }
          if (p.n) return true;
          if (p.u && dstat.mtime >= sst.mtime) return true;
          if (p.i && !p.f && !(await confirm(ctx, 'mv: overwrite ' + q(dst) + '? '))) return true;
        }
        if (sst.isDir && (ctx.fs.abs(dst) + '/').indexOf(ctx.fs.abs(src).replace(/\/$/, '') + '/') === 0) {
          ctx.eprintln('mv: cannot move ' + q(src) + ' to a subdirectory of itself, ' + q(dst)); return false;
        }
        try { ctx.fs.rename(src, dst); } catch (e) {
          if (!isFsError(e)) throw e;
          ctx.eprintln('mv: cannot move ' + q(src) + ' to ' + q(dst) + ': ' + e.message); return false;
        }
        if (p.v) ctx.println('renamed ' + q(src) + ' -> ' + q(dst));
        return true;
      };
      return transfer(ctx, g, move, p, (s) => 'cannot stat ' + q(s));
    },
  });

  /* ============================================== chmod, chown, chgrp */

  const octal4 = (m) => ('0000' + (m & 0o7777).toString(8)).slice(-4);
  const rwxString = (m) => modeString({ mode: m, isDir: false, isLink: false, isDev: false }).slice(1);

  /** Visit a path and, with -R, everything below it (symbolic links below are not followed). */
  async function visitTree(ctx, path, recursive, fn) {
    ctx.checkAbort();
    const st = ctx.fs.lstat(path);
    await fn(path, st);
    if (recursive && st.isDir) {
      for (const n of ctx.fs.readdir(path)) await visitTree(ctx, joinPath(path, n), true, fn);
    }
  }

  /** Run `change(path, st)` over each operand (and tree with -R) printing GNU-style errors. */
  async function eachTarget(ctx, files, recursive, verb, change) {
    let status = 0;
    for (const f of files) {
      try {
        const top = ctx.fs.lstat(f);
        const start = top.isLink ? ctx.fs.abs(ctx.fs.realpath(f)) : f;
        await visitTree(ctx, start, recursive, async (p, st) => {
          if (st.isLink && p !== start) return;
          try { change(p, st, p === start ? f : p); } catch (e) {
            if (!isFsError(e)) throw e;
            if (e.code === 'EPERM' || e.code === 'EACCES') { ctx.eprintln(ctx.name + ': ' + verb + ' ' + q(p === start ? f : p) + ': ' + (e.code === 'EPERM' ? 'Operation not permitted' : e.message)); status = 1; }
            else throw e;
          }
        });
      } catch (e) {
        if (!isFsError(e)) throw e;
        ctx.eprintln(ctx.name + ': cannot access ' + q(f) + ': ' + e.message); status = 1;
      }
    }
    return status;
  }

  gnu({
    name: 'chmod', summary: 'change file mode bits', synopsis: 'chmod [OPTION]... MODE[,MODE]... FILE...\n   or:  chmod [OPTION]... OCTAL-MODE FILE...\n   or:  chmod [OPTION]... --reference=RFILE FILE...',
    man: 'DESCRIPTION\n       chmod changes the file mode bits of each given file according to MODE, which can be either a symbolic representation of changes to make, or an octal number representing the bit pattern for the new mode bits.\n\n       The symbolic format is [ugoa...][[-+=][perms...]...], where perms is zero or more letters from the set rwxXst, or a single letter from the set ugo.\n\nOPTIONS\n       -c, --changes\n              like verbose but report only when a change is made\n       -f, --silent, --quiet\n              suppress most error messages\n       -v, --verbose\n              output a diagnostic for every file processed\n       -R, --recursive\n              change files and directories recursively\n       --reference=RFILE\n              use RFILE\'s mode instead of MODE values\n\nEXAMPLES\n       chmod +x exploit.sh\n              Make a script executable.\n       chmod -R u=rwX,go= ~/engagement\n              Make the tree private to the owner.\n       chmod 600 id_rsa\n              Required permissions for an SSH key.',
    help: "  -c, --changes          like verbose but report only when a change is made\n  -f, --silent, --quiet  suppress most error messages\n  -v, --verbose          output a diagnostic for every file processed\n      --reference=RFILE  use RFILE's mode instead of MODE values\n  -R, --recursive        change files and directories recursively\n",
    authors: 'David MacKenzie and Jim Meyering',
    spec: { short: 'cfvR', long: ['changes', 'silent', 'quiet', 'verbose', 'recursive', 'reference=', 'preserve-root', 'no-preserve-root'], alias: { changes: 'c', silent: 'f', quiet: 'f', verbose: 'v', recursive: 'R' } },
    // "-x" and "u-w" style modes must not be mistaken for options
    prep: (args) => { const i = args.findIndex((a) => /^-[rwxXstugoa,=+-]+$/.test(a)); return i < 0 ? args : args.slice(0, i).concat('--', args.slice(i)); },
    async main(ctx, g) {
      const files = g.rest.slice();
      const ref = g.opts.reference;
      let spec = null;
      if (ref == null) {
        if (!files.length) return missingOperand(ctx);
        spec = files.shift();
      }
      if (!files.length) { ctx.eprintln('chmod: missing operand after ' + q(spec == null ? ref : spec)); ctx.eprintln("Try 'chmod --help' for more information."); return 1; }
      let refMode = null;
      if (ref != null) {
        try { refMode = ctx.fs.stat(ref).mode; } catch (e) { if (!isFsError(e)) throw e; ctx.eprintln('chmod: failed to get attributes of ' + q(ref) + ': ' + e.message); return 1; }
      } else if (applyMode(spec, 0, false, ctx.shell.umask) == null) {
        ctx.eprintln('chmod: invalid mode: ' + q(spec)); ctx.eprintln("Try 'chmod --help' for more information."); return 1;
      }
      const status = await eachTarget(ctx, files, !!g.opts.R, 'changing permissions of', (p, st, shown) => {
        const next = refMode != null ? refMode : applyMode(spec, st.mode, st.isDir, ctx.shell.umask);
        const target = st.isLink ? ctx.fs.stat(p) : st;
        if (target.mode === next && !g.opts.c && !g.opts.v) return;
        const old = target.mode & 0o7777;
        ctx.fs.chmod(p, next);
        const text = (m) => octal4(m) + ' (' + rwxString(m) + ')';
        if (old === next) { if (g.opts.v) ctx.println('mode of ' + q(shown) + ' retained as ' + text(next)); }
        else if (g.opts.v || g.opts.c) ctx.println('mode of ' + q(shown) + ' changed from ' + text(old) + ' to ' + text(next));
      });
      return g.opts.f ? (status ? 1 : 0) : status;
    },
  });

  /** Resolve "name" or a number to an id. */
  function resolveId(ctx, spec, kind) {
    if (/^\d+$/.test(spec)) return parseInt(spec, 10);
    const rec = kind === 'user' ? ctx.machine.userByName(spec) : ctx.machine.groupByName(spec);
    return rec ? (kind === 'user' ? rec.uid : rec.gid) : null;
  }

  async function chownMain(ctx, g, groupOnly) {
    const files = g.rest.slice();
    let spec; let uid = null; let gid = null;
    if (g.opts.reference != null) {
      try { const r = ctx.fs.stat(g.opts.reference); uid = groupOnly ? null : r.uid; gid = r.gid; } catch (e) {
        if (!isFsError(e)) throw e;
        ctx.eprintln(ctx.name + ': failed to get attributes of ' + q(g.opts.reference) + ': ' + e.message); return 1;
      }
    } else {
      if (!files.length) return missingOperand(ctx);
      spec = files.shift();
    }
    if (!files.length) { ctx.eprintln(ctx.name + ': missing operand after ' + q(spec == null ? g.opts.reference : spec)); ctx.eprintln("Try '" + ctx.name + " --help' for more information."); return 1; }
    if (spec != null) {
      let user = groupOnly ? '' : spec; let grp = groupOnly ? spec : null;
      if (!groupOnly) { const m = /^([^:.]*)[:.](.*)$/.exec(spec); if (m) { user = m[1]; grp = m[2]; } }
      if (user !== '') { uid = resolveId(ctx, user, 'user'); if (uid == null) { ctx.eprintln(ctx.name + ': invalid user: ' + q(spec)); return 1; } }
      if (grp != null && grp !== '') { gid = resolveId(ctx, grp, 'group'); if (gid == null) { ctx.eprintln(ctx.name + ': invalid group: ' + q(spec)); return 1; } }
      if (!groupOnly && grp === '' && user !== '') gid = ctx.machine.userByUid(uid) ? ctx.machine.userByUid(uid).gid : null;
      if (uid == null && gid == null && !groupOnly) return 0;
    }
    const names = (u, gr) => (groupOnly ? group(ctx, gr) : gid != null && spec != null && /[:.]/.test(spec) ? owner(ctx, u) + ':' + group(ctx, gr) : owner(ctx, u));
    return eachTarget(ctx, files, !!g.opts.R, groupOnly ? 'changing group of' : 'changing ownership of', (p, st, shown) => {
      const was = names(st.uid, st.gid);
      const nu = uid == null ? st.uid : uid; const ng = gid == null ? st.gid : gid;
      const changed = nu !== st.uid || ng !== st.gid;
      ctx.fs.chown(p, uid, gid, { follow: !g.opts.h });
      const now = names(nu, ng);
      const label = groupOnly ? 'group' : 'ownership';
      if (changed && (g.opts.v || g.opts.c)) ctx.println('changed ' + label + ' of ' + q(shown) + ' from ' + was + ' to ' + now);
      else if (!changed && g.opts.v) ctx.println(label + ' of ' + q(shown) + ' retained as ' + was);
    });
  }

  const chownSpec = { short: 'cfvRhH', long: ['changes', 'silent', 'quiet', 'verbose', 'recursive', 'reference=', 'dereference', 'no-dereference', 'preserve-root'], alias: { changes: 'c', silent: 'f', quiet: 'f', verbose: 'v', recursive: 'R', 'no-dereference': 'h' } };
  const chownHelp = "  -c, --changes          like verbose but report only when a change is made\n  -f, --silent, --quiet  suppress most error messages\n  -v, --verbose          output a diagnostic for every file processed\n  -h, --no-dereference   affect symbolic links instead of any referenced file\n      --reference=RFILE  use RFILE's owner and group rather than specifying values\n  -R, --recursive        operate on files and directories recursively\n";

  gnu({
    name: 'chown', summary: 'change file owner and group', synopsis: 'chown [OPTION]... [OWNER][:[GROUP]] FILE...\n   or:  chown [OPTION]... --reference=RFILE FILE...',
    man: 'DESCRIPTION\n       chown changes the user and/or group ownership of each given file.\n\n       OWNER, GROUP or OWNER:GROUP may be given; either may be a name or a numeric ID. Only root may change the owner of a file.\n\nOPTIONS\n       -R, --recursive\n              operate on files and directories recursively\n       -v, --verbose\n              output a diagnostic for every file processed\n       -c, --changes\n              like verbose but report only when a change is made\n       --reference=RFILE\n              use RFILE\'s owner and group\n\nEXAMPLES\n       sudo chown kali:kali report.txt\n              Give report.txt back to the kali user.\n       sudo chown -R www-data: /var/www/html\n              Hand a tree to www-data and its login group.',
    help: chownHelp, authors: 'David MacKenzie and Jim Meyering', spec: chownSpec, main: (ctx, g) => chownMain(ctx, g, false),
  });
  gnu({
    name: 'chgrp', summary: 'change group ownership', synopsis: 'chgrp [OPTION]... GROUP FILE...\n   or:  chgrp [OPTION]... --reference=RFILE FILE...',
    man: 'DESCRIPTION\n       Change the group of each FILE to GROUP. GROUP may be a name or a numeric ID.\n\nOPTIONS\n       -R, --recursive\n              operate on files and directories recursively\n       -v, --verbose\n              output a diagnostic for every file processed\n       -c, --changes\n              like verbose but report only when a change is made\n\nEXAMPLES\n       chgrp sudo shared.txt\n              Make the sudo group the owner group of shared.txt.',
    help: chownHelp.replace(" owner and group rather than specifying values", " group rather than specifying a value for GROUP"), authors: 'David MacKenzie and Jim Meyering', spec: chownSpec, main: (ctx, g) => chownMain(ctx, g, true),
  });

  /* ==================================================================== stat */

  const DEV_SPECIAL = { null: [1, 3], zero: [1, 5], random: [1, 8], tty: [5, 0] };
  const fileTypeName = (st) => (st.isDir ? 'directory' : st.isLink ? 'symbolic link' : st.isDev ? 'character special file' : st.size === 0 ? 'regular empty file' : 'regular file');
  const statTime = (ms) => U.isoDate(ms) + '.000000000 +0000';
  const rawMode = (st) => st.mode | (st.isDir ? 0o040000 : st.isLink ? 0o120000 : st.isDev ? 0o020000 : 0o100000);

  function statFormat(ctx, fmt, name, st) {
    const dev = DEV_SPECIAL[st.dev] || [0, 0];
    const t = Math.floor(st.mtime / 1000);
    return fmt.replace(/%([a-zA-Z%])/g, (all, c) => {
      switch (c) {
        case 'n': return name;
        case 'N': return st.isLink ? q(name) + ' -> ' + q(st.target) : q(name);
        case 's': return String(st.size);
        case 'b': return String(blocksOf(st) * 2);
        case 'B': return '512';
        case 'o': return '4096';
        case 'A': return modeString(st);
        case 'a': return (st.mode & 0o7777).toString(8);
        case 'f': return rawMode(st).toString(16);
        case 'F': return fileTypeName(st);
        case 'u': return String(st.uid);
        case 'U': return owner(ctx, st.uid);
        case 'g': return String(st.gid);
        case 'G': return group(ctx, st.gid);
        case 'h': return String(st.nlink);
        case 'i': return String(st.ino);
        case 'd': return '2049';
        case 'D': return '801';
        case 't': return dev[0].toString(16);
        case 'T': return dev[1].toString(16);
        case 'm': return '/';
        case 'C': return '?';
        case 'x': case 'y': case 'z': case 'w': return statTime(st.mtime);
        case 'X': case 'Y': case 'Z': case 'W': return String(t);
        case '%': return '%';
        default: return all;
      }
    });
  }

  /** Expand backslash escapes of --printf. */
  function unescapeFormat(s) {
    return s.replace(/\\(n|t|r|\\|0|a|b|f|v|")/g, (m, c) => ({ n: '\n', t: '\t', r: '\r', '\\': '\\', 0: '\0', a: '\x07', b: '\b', f: '\f', v: '\v', '"': '"' })[c]);
  }

  function statDefault(ctx, name, st) {
    const shown = st.isLink ? name + ' -> ' + st.target : name;
    const dev = DEV_SPECIAL[st.dev];
    let l = '  File: ' + shown + '\n';
    l += '  Size: ' + U.padEnd(st.size, 10) + '\tBlocks: ' + U.padEnd(blocksOf(st) * 2, 10) + ' IO Block: ' + U.padEnd(4096, 6) + ' ' + fileTypeName(st) + '\n';
    l += 'Device: 8,1\tInode: ' + U.padEnd(st.ino, 11) + ' Links: ' + (st.isDev ? U.padEnd(st.nlink, 5) + ' Device type: ' + dev.join(',') : st.nlink) + '\n';
    l += 'Access: (' + octal4(st.mode) + '/' + modeString(st) + ')  Uid: (' + U.padStart(st.uid, 5) + '/' + U.padStart(owner(ctx, st.uid), 8) + ')   Gid: (' + U.padStart(st.gid, 5) + '/' + U.padStart(group(ctx, st.gid), 8) + ')\n';
    for (const w of ['Access', 'Modify', 'Change']) l += w + ': ' + statTime(st.mtime) + '\n';
    return l + ' Birth: ' + statTime(st.mtime) + '\n';
  }

  gnu({
    name: 'stat', summary: 'display file status', synopsis: 'stat [OPTION]... FILE...',
    man: 'DESCRIPTION\n       Display file status.\n\nOPTIONS\n       -L, --dereference\n              follow links\n       -c, --format=FORMAT\n              use the specified FORMAT instead of the default; output a newline after each use of FORMAT\n       --printf=FORMAT\n              like --format, but interpret backslash escapes, and do not output a mandatory trailing newline\n       -t, --terse\n              print the information in terse form\n\n       Valid format sequences for files: %a access rights in octal, %A in human readable form, %F file type, %g and %G group, %h number of hard links, %i inode, %n file name, %N quoted name, %s total size in bytes, %u and %U user, %x %y %z last access, modification and change time, %X %Y %Z the same in seconds since the Epoch.\n\nEXAMPLES\n       stat /etc/passwd\n              Show size, permissions, owner and timestamps.\n       stat -c "%a %U %n" /etc/shadow\n              Print the mode, owner and name only.',
    help: "  -L, --dereference     follow links\n  -c  --format=FORMAT   use the specified FORMAT instead of the default;\n                          output a newline after each use of FORMAT\n      --printf=FORMAT   like --format, but interpret backslash escapes,\n                          and do not output a mandatory trailing newline\n  -t, --terse           print the information in terse form\n",
    authors: 'Michael Meskes',
    spec: { short: 'Lc:t', long: ['dereference', 'format=', 'printf=', 'terse'], alias: { dereference: 'L', format: 'c', terse: 't' } },
    main(ctx, g) {
      if (!g.rest.length) return missingOperand(ctx);
      let status = 0;
      for (const f of g.rest) {
        let st;
        try { st = g.opts.L ? ctx.fs.stat(f) : ctx.fs.lstat(f); } catch (e) {
          if (!isFsError(e)) throw e;
          ctx.eprintln('stat: cannot statx ' + q(f) + ': ' + e.message); status = 1; continue;
        }
        if (g.opts.printf != null) ctx.out(statFormat(ctx, unescapeFormat(g.opts.printf), f, st));
        else if (g.opts.c != null) ctx.out(statFormat(ctx, g.opts.c, f, st) + '\n');
        else if (g.opts.t) ctx.out(statFormat(ctx, '%n %s %b %f %u %g %D %i %h %t %T %X %Y %Z %W %o', f, st) + '\n');
        else ctx.out(statDefault(ctx, f, st));
      }
      return status;
    },
  });

  /* ========================================= basename, dirname, realpath, readlink, mktemp */

  /** Strip a trailing-slash run and return the last path component ("/" stays "/"). */
  function baseOf(name) {
    const trimmed = name.replace(/\/+$/, '');
    if (trimmed === '') return name === '' ? '' : '/';
    return trimmed.slice(trimmed.lastIndexOf('/') + 1);
  }

  function dirOf(name) {
    const trimmed = name.replace(/\/+$/, '');
    if (trimmed === '') return name === '' ? '.' : '/';
    const i = trimmed.lastIndexOf('/');
    if (i < 0) return '.';
    const head = trimmed.slice(0, i).replace(/\/+$/, '');
    return head === '' ? '/' : head;
  }

  gnu({
    name: 'basename', summary: 'strip directory and suffix from filenames', synopsis: 'basename NAME [SUFFIX]\n  or:  basename OPTION... NAME...',
    man: 'DESCRIPTION\n       Print NAME with any leading directory components removed. If specified, also remove a trailing SUFFIX.\n\nOPTIONS\n       -a, --multiple\n              support multiple arguments and treat each as a NAME\n       -s, --suffix=SUFFIX\n              remove a trailing SUFFIX; implies -a\n       -z, --zero\n              end each output line with NUL, not newline\n\nEXAMPLES\n       basename /usr/bin/sort\n              Prints "sort".\n       basename -s .txt notes.txt\n              Prints "notes".',
    help: "  -a, --multiple       support multiple arguments and treat each as a NAME\n  -s, --suffix=SUFFIX  remove a trailing SUFFIX; implies -a\n  -z, --zero           end each output line with NUL, not newline\n",
    authors: 'FIXME unknown',
    spec: { short: 'as:z', long: ['multiple', 'suffix=', 'zero'], alias: { multiple: 'a', suffix: 's', zero: 'z' } },
    main(ctx, g) {
      let names = g.rest.slice(); let suffix = g.opts.s;
      if (!names.length) return missingOperand(ctx);
      if (!g.opts.a && suffix == null) {
        if (names.length > 2) { ctx.eprintln('basename: extra operand ' + q(names[2])); ctx.eprintln("Try 'basename --help' for more information."); return 1; }
        if (names.length === 2) { suffix = names[1]; names = [names[0]]; }
      }
      const end = g.opts.z ? '\0' : '\n';
      for (const n of names) {
        let b = baseOf(n);
        if (suffix && b !== suffix && b.endsWith(suffix)) b = b.slice(0, -suffix.length);
        ctx.out(b + end);
      }
      return 0;
    },
  });

  gnu({
    name: 'dirname', summary: 'strip last component from file name', synopsis: 'dirname [OPTION] NAME...',
    man: 'DESCRIPTION\n       Output each NAME with its last non-slash component and trailing slashes removed; if NAME contains no /\'s, output \'.\' (meaning the current directory).\n\nOPTIONS\n       -z, --zero\n              end each output line with NUL, not newline\n\nEXAMPLES\n       dirname /usr/bin/sort\n              Prints "/usr/bin".',
    help: "  -z, --zero     end each output line with NUL, not newline\n",
    authors: 'David MacKenzie and Jim Meyering',
    spec: { short: 'z', long: ['zero'], alias: { zero: 'z' } },
    main(ctx, g) {
      if (!g.rest.length) return missingOperand(ctx);
      for (const n of g.rest) ctx.out(dirOf(n) + (g.opts.z ? '\0' : '\n'));
      return 0;
    },
  });

  /**
   * Canonicalise `path`. mode: 'e' every component must exist, 'f' all but the last, 'm' none.
   * `symlinks` false resolves only . and .. (realpath -s). Throws K.FsError.
   */
  function canonical(ctx, path, mode, symlinks) {
    const abs = ctx.fs.abs(path);
    if (!symlinks) return abs;
    const parts = abs.split('/').filter(Boolean);
    for (let i = parts.length; i >= 0; i--) {
      const head = '/' + parts.slice(0, i).join('/');
      let real;
      try { real = ctx.fs.realpath(head); } catch (e) { if (!isFsError(e) || e.code !== 'ENOENT') throw e; continue; }
      const rest = parts.slice(i);
      if (!rest.length) return real;
      if (mode === 'e' || (mode === 'f' && rest.length > 1)) throw new K.FsError('ENOENT', path);
      if (!ctx.fs.isDir(real)) throw new K.FsError('ENOTDIR', path);
      return (real === '/' ? '' : real) + '/' + rest.join('/');
    }
    return abs;
  }

  function relativePath(from, to) {
    const a = from.split('/').filter(Boolean); const b = to.split('/').filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const out = a.slice(i).map(() => '..').concat(b.slice(i)).join('/');
    return out || '.';
  }

  gnu({
    name: 'realpath', summary: 'print the resolved path', synopsis: 'realpath [OPTION]... FILE...',
    man: 'DESCRIPTION\n       Print the resolved absolute file name; all but the last component must exist.\n\nOPTIONS\n       -e, --canonicalize-existing\n              all components of the path must exist\n       -m, --canonicalize-missing\n              no path components need exist or be a directory\n       -s, --strip, --no-symlinks\n              don\'t expand symlinks\n       -q, --quiet\n              suppress most error messages\n       --relative-to=DIR\n              print the resolved path relative to DIR\n\nEXAMPLES\n       realpath ../notes\n              Print the absolute path of ../notes.',
    help: "  -e, --canonicalize-existing  all components of the path must exist\n  -m, --canonicalize-missing   no path components need exist or be a directory\n  -q, --quiet                  suppress most error messages\n      --relative-to=DIR        print the resolved path relative to DIR\n  -s, --strip, --no-symlinks   don't expand symlinks\n  -z, --zero                   end each output line with NUL, not newline\n",
    authors: 'Padraig Brady',
    spec: { short: 'emqsLPz', long: ['canonicalize-existing', 'canonicalize-missing', 'quiet', 'strip', 'no-symlinks', 'relative-to=', 'zero', 'logical', 'physical'], alias: { 'canonicalize-existing': 'e', 'canonicalize-missing': 'm', quiet: 'q', strip: 's', 'no-symlinks': 's', zero: 'z' } },
    main(ctx, g) {
      if (!g.rest.length) return missingOperand(ctx);
      const mode = g.opts.e ? 'e' : g.opts.m ? 'm' : 'f';
      let status = 0;
      for (const f of g.rest) {
        try {
          let p = canonical(ctx, f, mode, !g.opts.s);
          if (g.opts['relative-to'] != null) p = relativePath(canonical(ctx, g.opts['relative-to'], 'm', !g.opts.s), p);
          ctx.out(p + (g.opts.z ? '\0' : '\n'));
        } catch (e) {
          if (!isFsError(e)) throw e;
          if (!g.opts.q) ctx.eprintln('realpath: ' + f + ': ' + e.message);
          status = 1;
        }
      }
      return status;
    },
  });

  gnu({
    name: 'readlink', summary: 'print resolved symbolic links or canonical file names', synopsis: 'readlink [OPTION]... FILE...',
    man: 'DESCRIPTION\n       Print value of a symbolic link or canonical file name.\n\nOPTIONS\n       -f, --canonicalize\n              canonicalize by following every symlink in every component of the given name recursively; all but the last component must exist\n       -e, --canonicalize-existing\n              all components must exist\n       -m, --canonicalize-missing\n              no components need exist\n       -n, --no-newline\n              do not output the trailing delimiter\n       -q, -s, --quiet, --silent\n              suppress most error messages (on by default)\n       -v, --verbose\n              report error messages\n\nEXAMPLES\n       readlink /usr/bin/vi\n              Show where the symlink points.\n       readlink -f /usr/bin/vi\n              Follow the whole chain to the final file.',
    help: "  -f, --canonicalize            canonicalize by following every symlink in\n                                every component of the given name recursively;\n                                all but the last component must exist\n  -e, --canonicalize-existing   canonicalize by following every symlink in\n                                every component of the given name recursively,\n                                all components must exist\n  -m, --canonicalize-missing    canonicalize by following every symlink in\n                                every component of the given name recursively,\n                                without requirements on components existence\n  -n, --no-newline              do not output the trailing delimiter\n  -q, --quiet\n  -s, --silent                  suppress most error messages (on by default)\n  -v, --verbose                 report error messages\n  -z, --zero                    end each output line with NUL, not newline\n",
    authors: 'Dmitry V. Levin',
    spec: { short: 'femnqsvz', long: ['canonicalize', 'canonicalize-existing', 'canonicalize-missing', 'no-newline', 'quiet', 'silent', 'verbose', 'zero'], alias: { canonicalize: 'f', 'canonicalize-existing': 'e', 'canonicalize-missing': 'm', 'no-newline': 'n', quiet: 'q', silent: 's', verbose: 'v', zero: 'z' } },
    main(ctx, g) {
      if (!g.rest.length) return missingOperand(ctx);
      const mode = g.opts.e ? 'e' : g.opts.m ? 'm' : g.opts.f ? 'f' : null;
      const end = g.opts.n ? '' : g.opts.z ? '\0' : '\n';
      let status = 0;
      for (const f of g.rest) {
        try {
          if (mode) ctx.out(canonical(ctx, f, mode, true) + end);
          else ctx.out(ctx.fs.readlink(f) + end);
        } catch (e) {
          if (!isFsError(e)) throw e;
          if (g.opts.v) ctx.eprintln('readlink: ' + f + ': ' + e.message);
          status = 1;
        }
      }
      return status;
    },
  });

  const TEMP_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  gnu({
    name: 'mktemp', summary: 'create a temporary file or directory', synopsis: 'mktemp [OPTION]... [TEMPLATE]',
    man: 'DESCRIPTION\n       Create a temporary file or directory, safely, and print its name. TEMPLATE must contain at least 3 consecutive \'X\'s in last component. If TEMPLATE is not specified, use tmp.XXXXXXXXXX, and --tmpdir is implied.\n\nOPTIONS\n       -d, --directory\n              create a directory, not a file\n       -u, --dry-run\n              do not create anything; merely print a name (unsafe)\n       -q, --quiet\n              suppress diagnostics about file/dir-creation failure\n       --suffix=SUFF\n              append SUFF to TEMPLATE; SUFF must not contain a slash\n       -p DIR, --tmpdir[=DIR]\n              interpret TEMPLATE relative to DIR; if DIR is not specified, use $TMPDIR if set, else /tmp\n       -t     interpret TEMPLATE as a single file name component, relative to a directory\n\nEXAMPLES\n       mktemp\n              Create /tmp/tmp.XXXXXXXXXX and print its name.\n       mktemp -d scan.XXXXXX\n              Create a private directory named scan.<random> in the current directory.',
    help: "  -d, --directory     create a directory, not a file\n  -u, --dry-run       do not create anything; merely print a name (unsafe)\n  -q, --quiet         suppress diagnostics about file/dir-creation failure\n      --suffix=SUFF   append SUFF to TEMPLATE; SUFF must not contain a slash.\n                        This option is implied if TEMPLATE does not end in X\n  -p DIR, --tmpdir[=DIR]  interpret TEMPLATE relative to DIR; if DIR is not\n                        specified, use $TMPDIR if set, else /tmp.\n  -t                  interpret TEMPLATE as a single file name component,\n                        relative to a directory: $TMPDIR, if set; else the\n                        directory specified via -p; else /tmp\n",
    authors: 'Jim Meyering and Eric Blake',
    spec: { short: 'dp:qtu', long: ['directory', 'dry-run', 'quiet', 'suffix=', 'tmpdir=?'], alias: { directory: 'd', 'dry-run': 'u', quiet: 'q', tmpdir: 'p' } },
    main(ctx, g) {
      const o = g.opts;
      if (g.rest.length > 1) { ctx.eprintln('mktemp: too many templates'); ctx.eprintln("Try 'mktemp --help' for more information."); return 1; }
      let template = g.rest[0];
      const implied = template == null;
      if (implied) template = 'tmp.XXXXXXXXXX';
      let suffix = o.suffix || '';
      if (suffix.indexOf('/') >= 0) { ctx.eprintln('mktemp: invalid suffix ' + q(suffix) + ', contains directory separator'); return 1; }
      if (!/X$/.test(template) && o.suffix == null) {
        const m = /X+([^X/]*)$/.exec(template);
        if (m) { suffix = m[1]; template = template.slice(0, template.length - suffix.length); }
      }
      const m = /(X{3,})$/.exec(template);
      if (!m) { ctx.eprintln('mktemp: too few X\'s in template ' + q(g.rest[0] == null ? template : g.rest[0])); return 1; }
      const dirOpt = o.p === true ? null : o.p;
      if (o.t && template.indexOf('/') >= 0) { ctx.eprintln('mktemp: invalid template, ' + q(template) + ', contains directory separator'); return 1; }
      let dir = null;
      if (o.t || o.p != null || implied) dir = dirOpt || ctx.env.TMPDIR || '/tmp';
      const fill = m[1].replace(/X/g, () => TEMP_CHARS[Math.floor(K.net.rand() * TEMP_CHARS.length)]);
      let name = template.slice(0, template.length - m[1].length) + fill + suffix;
      if (dir != null) name = joinPath(dir, name);
      if (!o.u) {
        try {
          if (o.d) ctx.fs.mkdir(name, { mode: 0o700 }); else ctx.fs.write(name, '', { mode: 0o600 });
        } catch (e) {
          if (!isFsError(e)) throw e;
          if (!o.q) ctx.eprintln('mktemp: failed to create ' + (o.d ? 'directory' : 'file') + ' via template ' + q(name.replace(/[^/]*$/, (b) => b)) + ': ' + e.message);
          return 1;
        }
      }
      ctx.out(name + '\n');
      return 0;
    },
  });

  /* @@END */
})(typeof globalThis !== 'undefined' ? globalThis : this);
