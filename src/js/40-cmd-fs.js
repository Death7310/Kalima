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

  /** GNU quotearg "shell-escape-always" style, as used in coreutils diagnostics: 'x y', "it's", 'a'$'\t''b'. */
  function q(s) {
    s = String(s);
    if (/[\x00-\x1f\x7f]/.test(s)) {
      const esc = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r', 27: '\\033' };
      let out = ''; let run = ''; let ctl = false;
      const flush = () => { if (run) out += ctl ? "$'" + run + "'" : "'" + run.replace(/'/g, "'\\''") + "'"; run = ''; };
      for (const ch of s) {
        const c = ch.charCodeAt(0); const isCtl = c < 32 || c === 127;
        if (isCtl !== ctl) { flush(); ctl = isCtl; }
        run += isCtl ? (esc[c] || '\\' + c.toString(8).padStart(3, '0')) : ch;
      }
      flush();
      return out;
    }
    if (s.indexOf("'") >= 0 && !/[$`\\"]/.test(s)) return '"' + s + '"';
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  /** Like q() but leaves names alone that need no quoting (coreutils quotef). */
  const qf = (s) => (s !== '' && !/[\s!"#$&'()*;<=>?[\\^`{|}~\x00-\x1f\x7f]/.test(s) && !/^[~%]/.test(s) ? s : q(s));
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
        if (g.opts.version && !def.noHelp) { ctx.out(def.version || versionText(ctx.name, def)); return 0; }
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
  function fsFail(ctx, text, e) { ctx.err(ctx.name + ': ' + qf(text) + ': ' + e.message + '\n'); }

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

  function splitLines(text, sep) {
    if (text === '') return [];
    const a = text.split(sep || '\n');
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
  function lsColumns(cells, width, across) {
    const n = cells.length;
    if (!n) return '';
    const maxCols = Math.max(1, Math.min(n, Math.floor(width / 3)));
    for (let cols = maxCols; cols >= 1; cols--) {
      const rows = Math.ceil(n / cols);
      const used = across ? Math.min(cols, n) : Math.ceil(n / rows);
      const at = (r, c) => cells[across ? r * cols + c : c * rows + r];
      const widths = [];
      for (let c = 0; c < used; c++) {
        let w = 0;
        for (let r = 0; r < rows; r++) { const cell = at(r, c); if (cell) w = Math.max(w, cell.w); }
        widths.push(w);
      }
      const total = widths.reduce((a, b) => a + b, 0) + 2 * (used - 1);
      if (total >= width && cols > 1) continue;
      let out = '';
      for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < used; c++) {
          const cell = at(r, c);
          if (!cell) continue;
          const last = !at(r, c + 1) || c === used - 1;
          line += last ? cell.text : cell.text + ' '.repeat(widths[c] - cell.w + 2);
        }
        out += line + '\n';
      }
      return out;
    }
    return '';
  }

  /** ls -m: names separated by ", ", wrapped at the terminal width. */
  function lsCommas(cells, width) {
    let out = ''; let pos = 0;
    cells.forEach((c, i) => {
      if (i > 0) {
        if (pos + c.w + 2 > width) { out += ',\n'; pos = 0; } else { out += ', '; pos += 2; }
      }
      out += c.text; pos += c.w;
    });
    return cells.length ? out + '\n' : '';
  }

  const LS_SPEC = {
    short: 'laAhRtrSdF1inCpsUxfgoGvXcuLZmHqbkQw:I:',
    long: ['color=?', 'all', 'almost-all', 'human-readable', 'recursive', 'reverse', 'directory', 'classify', 'numeric-uid-gid',
      'inode', 'group-directories-first', 'si', 'time-style=', 'sort=', 'indicator-style=', 'dereference', 'literal', 'hide-control-chars', 'quote-name', 'full-time', 'hide=', 'ignore=', 'width=', 'escape', 'kibibytes'],
    alias: { ignore: 'I', width: 'w', escape: 'b', kibibytes: 'k', all: 'a', 'almost-all': 'A', 'human-readable': 'h', recursive: 'R', reverse: 'r', directory: 'd', classify: 'F', 'numeric-uid-gid': 'n', inode: 'i', dereference: 'L', 'quote-name': 'Q' },
  };

  function lsOptions(ctx, g) {
    const o = g.opts;
    const color = o.color === undefined ? false : (o.color === true || o.color === 'always' || o.color === 'yes' || o.color === 'force') ? true
      : (o.color === 'auto' || o.color === 'tty' || o.color === 'if-tty') ? ctx.isTTY : false;
    const isLong = !!(o.l || o.n || o.g || o.o || o['full-time']);
    const timeKey = o.t || ((o.c || o.u) && !isLong);
    const sortBy = o.sort && o.sort !== 'version' ? o.sort : o.S ? 'size' : timeKey ? 'time' : o.U || o.f ? 'none' : o.X ? 'extension' : 'name';
    return {
      ignorePats: [].concat(g.all.I || [], g.all.ignore || [], o.hide && !o.all && !o.a ? [o.hide] : []).filter((x) => typeof x === 'string').map(globRe),
      context: !!o.Z, across: !!o.x, commas: !!o.m, columns: !!(o.C || o.x), noOwner: !!o.g, noGroup: !!(o.o || o.G), followCmd: !!o.H,
      long: isLong, numeric: !!o.n, all: !!(o.a || o.f), almost: !!o.A, human: !!o.h,
      recursive: !!o.R, reverse: !!o.r, dirOnly: !!o.d, classify: !!o.F || o['indicator-style'] === 'classify', indicator: !!(o.F || o.p) || ['classify', 'slash', 'file-type'].includes(o['indicator-style']), inode: !!o.i, blocks: !!o.s,
      color, sortBy, dirsFirst: !!o['group-directories-first'], follow: !!o.L, oneColumn: !!o[1], fullTime: o['full-time'] != null,
      quote: !!o.Q, indStyle: typeof o['indicator-style'] === 'string' ? o['indicator-style'] : null,
      tty: ctx.isTTY, width: (o.w != null && parseInt(o.w, 10) > 0 ? parseInt(o.w, 10) : ctx.cols || 80), collate: collator(ctx.env),
      timeStyle: o['full-time'] ? 'full-iso' : o['time-style'] || null,
    };
  }

  function globRe(pat) {
    let re = '';
    for (const ch of pat) re += ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + re + '$');
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
    const dirLike = st.isDir || (st.isLink && !orphan && !!tryStat(ctx, full) && tryStat(ctx, full).isDir);
    return { name, full, st, orphan, dirLike };
  }

  function sortEntries(list, o) {
    const cmpName = (a, b) => o.collate(a.name, b.name);
    let cmp = cmpName;
    if (o.sortBy === 'time') cmp = (a, b) => b.st.mtime - a.st.mtime || cmpName(a, b);
    else if (o.sortBy === 'size') cmp = (a, b) => b.st.size - a.st.size || cmpName(a, b);
    else if (o.sortBy === 'extension') cmp = (a, b) => byteCompare(a.name.replace(/^.*\./, ''), b.name.replace(/^.*\./, '')) || cmpName(a, b);
    if (o.sortBy !== 'none') list.sort(cmp);
    if (o.reverse) list.reverse();
    if (o.dirsFirst) { const d = list.filter((e) => e.dirLike); const f = list.filter((e) => !e.dirLike); list.length = 0; list.push(...d, ...f); }
    return list;
  }

  function lsRender(ctx, o, entries, withTotal) {
    const needQuote = o.tty && entries.some((e) => quoteName(e.name) !== e.name);
    const cell = (e) => {
      let text = (o.context ? '? ' : '') + (o.quote ? '"' + e.name.replace(/(["\\])/g, '\\$1') + '"' : o.tty ? quoteName(e.name) : e.name);
      const plainLen = text.length;
      const key = o.color ? colorKey(e.st, e.orphan) : null;
      if (key) text = e.orphan && key === 'or' ? '\x1b[0m' + paint(LS_COLOR.ln, text) : paint(LS_COLOR[key], text);
      const ind = o.long && e.st.isLink ? '' : indicator(e.st, o);
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
        if (e.unknown) return { ino: '?', mode: '-?????????', nlink: '?', owner: '?', group: '?', size: '?', date: U.padStart('?', 12), name, blk: '?' };
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
        const total = entries.reduce((a, e) => a + (e.unknown ? 0 : blocksOf(e.st)), 0);
        out += 'total ' + (o.human ? U.humanSize(total * 1024) : total) + '\n';
      }
      for (const r of rows) {
        out += (o.inode ? U.padStart(r.ino, wi) + ' ' : '') + (o.blocks ? U.padStart(r.blk, wb) + ' ' : '') + r.mode + ' ' + U.padStart(r.nlink, wl) + ' ' +
          (o.noOwner ? '' : U.padEnd(r.owner, wo) + ' ') + (o.noGroup ? '' : U.padEnd(r.group, wg) + ' ') + U.padStart(r.size, ws) + ' ' + r.date + ' ' + r.name + '\n';
      }
      return out;
    }
    if (o.inode || o.blocks) {
      const px = entries.map(prefix);
      const wp = Math.max.apply(null, px.map((s) => s.length - 1));
      cells.forEach((c, i) => { const p = U.padStart(px[i].trimEnd(), wp) + ' '; c.text = p + c.text; c.w += p.length; });
    }
    if (o.oneColumn) return cells.map((c) => c.text + '\n').join('');
    if (o.commas) return lsCommas(cells, o.width);
    if (!o.tty && !o.columns) return cells.map((c) => c.text + '\n').join('');
    return lsColumns(cells, o.width, o.across);
  }

  const LS_ARGS = {
    color: [['always', 'yes', 'force'], ['never', 'no', 'none'], ['auto', 'tty', 'if-tty']],
    sort: [['none'], ['time'], ['size'], ['extension'], ['version'], ['width']],
  };

  /** GNU "invalid argument" report for --color and --sort, or null when both are fine. */
  function lsBadArgument(opts) {
    for (const key of Object.keys(LS_ARGS)) {
      const v = opts[key];
      if (typeof v !== 'string' || LS_ARGS[key].some((g) => g.indexOf(v) >= 0) || (key === 'sort' && v === 'name')) continue;
      return 'ls: invalid argument ' + q(v) + ' for ' + q('--' + key) + '\nValid arguments are:\n' +
        LS_ARGS[key].map((g) => '  - ' + g.map(q).join(', ')).join('\n') + "\nTry 'ls --help' for more information.\n";
    }
    return null;
  }

  async function lsMain(ctx, g) {
    const bad = lsBadArgument(g.opts);
    if (bad) { ctx.err(bad); return 1; }
    const o = lsOptions(ctx, g);
    const operands = g.rest.length ? g.rest : ['.'];
    let status = 0; let first = true;
    const files = []; const dirs = [];
    for (const arg of operands) {
      let e;
      try {
        if (arg === '') throw new K.FsError('ENOENT', arg);
        e = makeEntry(ctx, o, arg, arg);
        const slash = arg.length > 1 && arg.endsWith('/');
        if (slash && !e.st.isDir && !(e.st.isLink && tryStat(ctx, arg) && tryStat(ctx, arg).isDir)) throw new K.FsError('ENOTDIR', arg);
        const followDir = e.st.isLink && !o.dirOnly && (slash || o.followCmd || (!o.long && !o.classify));
        if (followDir) { const t = tryStat(ctx, arg); if (t && t.isDir) e = { name: arg, full: arg, st: t, orphan: false, dirLike: true }; }
      } catch (err) {
        if (!isFsError(err)) throw err;
        ctx.err('ls: cannot access ' + q(arg) + ': ' + err.message + '\n'); status = 2; continue;
      }
      (e.st.isDir && !o.dirOnly ? dirs : files).push(e);
    }
    const multi = operands.length > 1 || o.recursive;
    sortEntries(files, o); sortEntries(dirs, o);
    if (files.length) { ctx.out(lsRender(ctx, o, files, false)); first = false; }

    const listDir = async (e, display, top) => {
      ctx.checkAbort();
      let names;
      try { names = ctx.fs.readdir(e.full); } catch (err) {
        if (!isFsError(err)) throw err;
        ctx.err('ls: cannot open directory ' + q(display) + ': ' + err.message + '\n'); status = Math.max(status, top ? 2 : 1); return;
      }
      if (!(o.all || o.almost)) names = names.filter((n) => n[0] !== '.');
      else if (o.all) names = ['.', '..'].concat(names);
      if (o.ignorePats.length) names = names.filter((n) => !o.ignorePats.some((re) => re.test(n)));
      const list = [];
      for (const n of names) {
        try { list.push(makeEntry(ctx, o, n, joinPath(e.full, n))); } catch (err) {
          if (!isFsError(err)) throw err;
          // a directory we may read but not search: real ls lists the names, and with -l shows a row of question marks
          const stub = { name: n, full: joinPath(e.full, n), st: { isDir: false, isFile: false, isLink: false, size: 0, mtime: 0, mode: 0, ino: 0, nlink: 0 }, orphan: false, dirLike: false, unknown: true };
          if (err.code !== 'EACCES' || o.long || o.blocks || o.color || o.classify || o.indicator || o.sortBy === 'time' || o.sortBy === 'size') {
            ctx.err('ls: cannot access ' + q(joinPath(display, n)) + ': ' + err.message + '\n'); status = Math.max(status, 1);
            if (err.code === 'EACCES') list.push(stub);
          } else list.push(stub);
        }
      }
      sortEntries(list, o);
      if (!first) ctx.out('\n');
      if (multi) ctx.out(display + ':\n');
      first = false;
      if (o.blocks && !o.long) { const t = list.reduce((a, c) => a + blocksOf(c.st), 0); ctx.out('total ' + (o.human ? U.humanSize(t * 1024) : t) + '\n'); }
      ctx.out(lsRender(ctx, o, list, true));
      if (o.recursive) {
        for (const c of list) if (c.st.isDir && c.name !== '.' && c.name !== '..') await listDir(c, joinPath(display, c.name), false);
      }
    };
    for (const d of dirs) await listDir(d, d.name, true);
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
          if (ctx.fs.isDir(f)) { ctx.err('cat: ' + qf(f) + ': Is a directory\n'); status = 1; continue; }
          emit(ctx.fs.read(f));
        } catch (e) { if (!isFsError(e)) throw e; fsFail(ctx, f, e); status = 1; }
      }
      return status;
    },
  });

  /* ============================================================ head, tail */

  /** Rewrite obsolete "-NUM" arguments to "-n NUM" (but not the value of -n / -c itself). */
  function expandNumericOption(args, plus) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { out.push(...args.slice(i)); break; }
      if (/^-\d+$/.test(a)) out.push('-n', a.slice(1));
      else if (plus && /^\+\d+$/.test(a)) out.push('-n', a);
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
  async function readOperand(ctx, f, length) {
    if (f === '-') return { name: 'standard input', text: await stdinText(ctx) };
    try {
      if (ctx.fs.isDir(f)) return { name: f, dir: true };
      return { name: f, text: ctx.fs.read(f, length ? { length } : undefined) };
    } catch (e) {
      if (!isFsError(e)) throw e;
      return { name: f, error: e };
    }
  }

  const reduceSpec = {
    short: 'n:c:qvz', long: ['lines=', 'bytes=', 'quiet', 'silent', 'verbose', 'zero-terminated'],
    alias: { lines: 'n', bytes: 'c', quiet: 'q', silent: 'q', verbose: 'v', 'zero-terminated': 'z' },
  };

  const headLines = (text, c, sep) => {
    const lines = splitLines(text, sep);
    const keep = c.sign === '-' ? lines.slice(0, Math.max(0, lines.length - c.n)) : lines.slice(0, c.n);
    if (!keep.length) return '';
    return keep.join(sep) + (keep.length === lines.length && !text.endsWith(sep) ? '' : sep);
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
        const r = await readOperand(ctx, f, byBytes && c.sign !== '-' ? Math.min(c.n, 1 << 24) : 0);
        if (r.error) { ctx.eprintln('head: cannot open ' + q(f) + ' for reading: ' + r.error.message); status = 1; continue; }
        if (headers) ctx.out((printed ? '\n' : '') + '==> ' + r.name + ' <==\n');
        printed = true;
        if (r.dir) { ctx.eprintln('head: error reading ' + q(f) + ': Is a directory'); status = 1; continue; }
        ctx.out(byBytes ? headBytes(r.text, c) : headLines(r.text, c, g.opts.z ? '\0' : '\n'));
      }
      return status;
    },
  });

  const tailLines = (text, c, sep) => {
    const lines = splitLines(text, sep);
    const keep = c.sign === '+' ? lines.slice(Math.max(0, c.n - 1)) : c.n === 0 ? [] : lines.slice(-c.n);
    if (!keep.length) return '';
    return keep.join(sep) + (text.endsWith(sep) ? sep : '');
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
    spec: tailSpec, prep: (a) => expandNumericOption(a, true),
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
        ctx.out(byBytes ? tailBytes(r.text, c) : tailLines(r.text, c, g.opts.z ? '\0' : '\n'));
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
      const n = parseInt(spec, 8);
      if (n > 0o7777) return null;
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
        else {
          // "=" also clears the sticky bit with "o"; directories keep setuid/setgid unless the clause says "s"
          const cleared = affected | (classes.indexOf('o') >= 0 ? 0o1000 : 0);
          const kept = isDir && perm.indexOf('s') < 0 ? mode & 0o6000 : 0;
          mode = ((mode & ~cleared) | bits | kept);
        }
      }
    }
    return mode & 0o7777;
  }

  /** Ask a yes/no question; anything starting with y or Y is a yes. */
  async function confirm(ctx, prompt) {
    if (ctx.stdin != null) ctx.err(prompt); // redirected stdin: the real tools still print the prompt on stderr
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
    m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    const mon = (w) => { return w.length >= 3 ? U.MONTHS.findIndex((n) => n.toLowerCase() === w.slice(0, 3).toLowerCase()) : -1; };
    const hms = '(?:\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?';
    // "5 Jan 2021 [10:00]" and "Jan 5[,] 2021 [10:00]"
    m = new RegExp('^(\\d{1,2})\\s+([A-Za-z]{3,9})\\.?\\s+(\\d{4})' + hms + '$').exec(s);
    if (m && mon(m[2]) >= 0) return Date.UTC(+m[3], mon(m[2]), +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    m = new RegExp('^([A-Za-z]{3,9})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})' + hms + '$').exec(s);
    if (m && mon(m[1]) >= 0) return Date.UTC(+m[3], mon(m[1]), +m[2], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    if (typeof K.util.parseDateString === 'function') { const v = K.util.parseDateString(s, now); if (v != null) return v; }
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
            let cur = '';
            for (let i = 0; i < parts.length; i++) {
              if (parts[i] === '') continue;
              cur = cur === '' && dir[0] !== '/' ? parts[i] : cur + '/' + parts[i];
              const last = i === parts.length - 1;
              if (ctx.fs.exists(cur)) {
                if (!ctx.fs.isDir(cur)) throw new K.FsError(last ? 'EEXIST' : 'ENOTDIR', last ? dir : cur);
                continue;
              }
              make(cur, last);
            }
          } else make(dir, true);
        } catch (e) {
          if (!isFsError(e)) throw e;
          ctx.eprintln('mkdir: cannot create directory ' + q(g.opts.p && e.code === 'ENOTDIR' && e.path ? e.path : dir) + ': ' + e.message); status = 1;
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
      for (const dir of g.rest) {
        let current = dir;
        const remove = (path) => {
          current = path;
          if (g.opts.v) ctx.println('rmdir: removing directory, ' + q(path));
          if (!ctx.fs.lstat(path).isDir) throw new K.FsError('ENOTDIR', path);
          if (/(^|\/)\.$/.test(path)) { const err = new K.FsError('EINVAL', path); err.message = 'Invalid argument'; throw err; }
          ctx.fs.rmdir(path);
        };
        try {
          remove(dir);
          if (g.opts.p) {
            let p = dir.replace(/\/+$/, '');
            while (p.lastIndexOf('/') > 0) { p = p.slice(0, p.lastIndexOf('/')).replace(/\/+$/, ''); if (p === '') break; remove(p); }
          }
        } catch (e) {
          if (!isFsError(e)) throw e;
          if (e.code === 'ENOTEMPTY' && g.opts['ignore-fail-on-non-empty']) continue;
          ctx.eprintln('rmdir: failed to remove ' + q(current) + ': ' + e.message); status = 1;
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
    spec: { short: 'acfhmd:r:t:', long: ['no-dereference', 'no-create', 'date=', 'reference=', 'time='], alias: { 'no-create': 'c', date: 'd', reference: 'r' } },
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
        if (!st.isDir && !st.isLink && top && /\/$/.test(display)) { fail(display, 'Not a directory'); return false; }
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
        if (recursive && (base === '.' || base === '..')) { ctx.eprintln('rm: refusing to remove ' + q('.') + ' or ' + q('..') + ' directory: skipping ' + q(f)); status = 1; continue; }
        if (!o['no-preserve-root'] && f !== '' && ctx.fs.abs(f) === '/') {
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
    a.node.nl = (a.node.nl || 1) + 1;
    if (ctx.vfs.onChange) ctx.vfs.onChange(b.path);
  }

  gnu({
    name: 'ln', summary: 'make links between files', synopsis: 'ln [OPTION]... [-T] TARGET LINK_NAME\n   or:  ln [OPTION]... TARGET\n   or:  ln [OPTION]... TARGET... DIRECTORY',
    man: 'DESCRIPTION\n       Create a link to TARGET with the name LINK_NAME. Create hard links by default, symbolic links with --symbolic.\n\nOPTIONS\n       -f, --force\n              remove existing destination files\n       -s, --symbolic\n              make symbolic links instead of hard links\n       -v, --verbose\n              print name of each linked file\n       -n, --no-dereference\n              treat LINK_NAME as a normal file if it is a symbolic link to a directory\n       -T     treat LINK_NAME as a normal file always\n\nEXAMPLES\n       ln -s /usr/share/wordlists ~/wordlists\n              Make a shortcut to the wordlists folder.',
    help: "  -f, --force                 remove existing destination files\n  -n, --no-dereference        treat LINK_NAME as a normal file if\n                                it is a symbolic link to a directory\n  -s, --symbolic              make symbolic links instead of hard links\n  -T, --no-target-directory   treat LINK_NAME as a normal file always\n  -v, --verbose               print name of each linked file\n",
    authors: 'Mike Parker and David MacKenzie',
    spec: { short: 'sfvnTirbLPt:S:', long: ['symbolic', 'force', 'verbose', 'no-dereference', 'no-target-directory', 'interactive', 'relative', 'backup=?', 'logical', 'physical', 'target-directory=', 'suffix='], alias: { symbolic: 's', force: 'f', verbose: 'v', 'no-dereference': 'n', 'no-target-directory': 'T', relative: 'r', 'target-directory': 't', logical: 'L', physical: 'P', suffix: 'S' } },
    main(ctx, g) {
      const o = g.opts; const args = g.rest.slice();
      if (!args.length) return missingOperand(ctx, 'file operand');
      let dest;
      if (o.t != null) dest = o.t; else if (args.length === 1) { dest = '.'; } else dest = args.pop();
      if (o.t != null && !ctx.fs.isDir(dest)) { ctx.eprintln('ln: target ' + q(dest) + ': ' + notDirReason(ctx, dest)); return 1; }
      const destIsDir = !o.T && (o.n ? (tryLstat(ctx, dest) && tryLstat(ctx, dest).isDir) : ctx.fs.isDir(dest));
      if (args.length > 1 && !destIsDir) { ctx.eprintln('ln: target ' + q(dest) + ': ' + notDirReason(ctx, dest)); return 1; }
      if (args.length === 1 && g.rest.length === 1 && o.t == null && !destIsDir) return 1;
      let status = 0;
      for (const src of args) {
        const name = destIsDir ? joinPath(dest, VFS.basename(src)) : dest;
        try {
          if (!o.s) {
            if (!tryLstat(ctx, src)) { ctx.eprintln('ln: failed to access ' + q(src) + ': No such file or directory'); status = 1; continue; }
          }
          let target = src;
          if (o.s && o.r) {
            const from = ctx.fs.abs(name).split('/').slice(0, -1).filter(Boolean); const to = ctx.fs.abs(src).split('/').filter(Boolean);
            let i = 0; while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
            target = from.slice(i).map(() => '..').concat(to.slice(i)).join('/') || '.';
          }
          if (tryLstat(ctx, name)) {
            if (o.b != null || o.backup != null) ctx.fs.rename(name, backupName(ctx, name, backupMode(o.backup != null ? o.backup : true), o.S || o.suffix || null));
            else if (!o.f) throw new K.FsError('EEXIST', name);
            else ctx.fs.unlink(name);
          }
          if (o.s) ctx.fs.symlink(target, name); else hardLink(ctx, src, name);
          if (o.v) ctx.println(q(name) + (o.s ? ' -> ' : ' => ') + q(src));
        } catch (e) {
          if (!isFsError(e)) throw e;
          if (e.hardDir) ctx.eprintln('ln: ' + qf(src) + ': hard link not allowed for directory');
          else ctx.eprintln('ln: failed to create ' + (o.s ? 'symbolic' : 'hard') + ' link ' + q(name) + ': ' + e.message);
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
      if (o.i && !(await confirm(ctx, 'cp: overwrite ' + q(dst) + '? '))) return false;
    }
    if (o.backup && dstat && !dstat.isDir) { try { ctx.fs.rename(dst, backupName(ctx, dst, o.backup, o.suffix)); dstat = null; } catch (e) { return cpFail(ctx, 'cannot backup', dst, e); } }
    if ((o.hard || o.sym) && !sst.isLink) {
      try {
        if (dstat) { if (!o.f) throw new K.FsError('EEXIST', dst); ctx.fs.unlink(dst); }
        if (o.sym) ctx.fs.symlink(src, dst); else hardLink(ctx, src, dst);
      } catch (e) { return cpFail(ctx, 'cannot create ' + (o.sym ? 'symbolic' : 'hard') + ' link', dst, e); }
    } else if (sst.isLink) {
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

  /** GNU backup file name for `cp -b` / `mv -b` (--backup=simple|numbered|existing). */
  function backupName(ctx, dst, mode, suffix) {
    suffix = suffix || '~';
    const dir = dst.indexOf('/') >= 0 ? dst.slice(0, dst.lastIndexOf('/') + 1) : '';
    const base = dst.slice(dir.length);
    let names = [];
    try { names = ctx.fs.readdir(dir || '.'); } catch (e) { /* fall through to simple */ }
    const numbered = names.filter((n) => n.startsWith(base + '.~') && /^\.~\d+~$/.test(n.slice(base.length)));
    if (mode === 'numbered' || (mode === 'existing' && numbered.length)) {
      const max = numbered.reduce((a, n) => Math.max(a, parseInt(n.slice(base.length + 2), 10)), 0);
      return dir + base + '.~' + (max + 1) + '~';
    }
    return dst + suffix;
  }
  function backupMode(v) {
    if (v == null || v === false) return null;
    if (v === true || v === '') return 'existing';
    return { none: null, off: null, simple: 'simple', never: 'simple', numbered: 'numbered', t: 'numbered', existing: 'existing', nil: 'existing' }[v] || 'existing';
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

  const notDirReason = (ctx, path) => (tryLstat(ctx, path) ? 'Not a directory' : 'No such file or directory');

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
    if ((args.length > 1 || g.opts.t != null) && !destIsDir) { ctx.eprintln(ctx.name + ': target ' + q(dest) + ': ' + notDirReason(ctx, dest)); return 1; }
    let status = 0;
    if (!destIsDir && !g.opts.T && args.length === 1 && dest.length > 1 && dest.endsWith('/')) {
      const st0 = tryLstat(ctx, args[0]);
      if (st0 && (!st0.isDir || ctx.name === 'mv') && !ctx.fs.exists(dest)) {
        ctx.eprintln(ctx.name === 'mv' ? 'mv: cannot move ' + q(args[0]) + ' to ' + q(dest) + ': Not a directory' : 'cp: cannot create regular file ' + q(dest) + ': Not a directory');
        return 1;
      }
    }
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
    spec: { short: 'afinpPLdrRuvt:TblsxS:', long: ['backup=?', 'suffix=', 'link', 'symbolic-link', 'parents', 'one-file-system', 'archive', 'force', 'interactive', 'no-clobber', 'preserve=?', 'recursive', 'update', 'verbose', 'target-directory=', 'no-target-directory', 'dereference', 'no-dereference'],
      alias: { archive: 'a', force: 'f', interactive: 'i', 'no-clobber': 'n', recursive: 'r', R: 'r', update: 'u', verbose: 'v', 'target-directory': 't', 'no-target-directory': 'T', dereference: 'L', 'no-dereference': 'P' } },
    async main(ctx, g) {
      const p = g.opts;
      const recursive = !!(p.r || p.a);
      if (p.n) ctx.eprintln('cp: warning: behavior of -n is non-portable and may change in future; use --update=none instead');
      const o = {
        recursive, f: !!p.f, i: !!p.i, n: !!p.n, u: !!p.u, v: !!p.v, hard: !!(p.l || p.link), sym: !!(p.s || p['symbolic-link']),
        backup: backupMode(p.backup != null ? p.backup : p.b ? true : null), suffix: p.S || p.suffix || null,
        preserve: !!(p.p || p.a || p.preserve), owner: !!(p.a || (p.p && ctx.isRoot)) && ctx.isRoot,
        deref: p.L ? true : (p.P || p.d || p.a || recursive) ? false : true,
      };
      if (p.parents) {
        const dir = g.opts.t != null ? g.opts.t : g.rest[g.rest.length - 1];
        const srcs = g.opts.t != null ? g.rest : g.rest.slice(0, -1);
        if (!dir || !srcs.length) return missingOperand(ctx, 'file operand');
        if (!ctx.fs.isDir(dir)) { ctx.eprintln('cp: target ' + q(dir) + ': ' + notDirReason(ctx, dir)); return 1; }
        let status = 0;
        for (const src of srcs) {
          const rel = src.replace(/^\/+/, '');
          const parts = rel.split('/'); let cur = dir;
          try { for (const part of parts.slice(0, -1)) { cur = joinPath(cur, part); if (!ctx.fs.exists(cur)) ctx.fs.mkdir(cur); } } catch (e) { if (!isFsError(e)) throw e; ctx.eprintln('cp: cannot make directory ' + q(cur) + ': ' + e.message); status = 1; continue; }
          if (!tryLstat(ctx, src)) { ctx.eprintln('cp: cannot stat ' + q(src) + ': No such file or directory'); status = 1; continue; }
          if (!(await copyTree(ctx, o, src, joinPath(dir, rel), true))) status = 1;
        }
        return status;
      }
      return transfer(ctx, g, (src, dst) => copyTree(ctx, o, src, dst, true), o, (s, d) => 'cannot stat ' + q(s));
    },
  });

  /* ======================================================================= mv */

  gnu({
    name: 'mv', summary: 'move (rename) files', synopsis: 'mv [OPTION]... [-T] SOURCE DEST\n   or:  mv [OPTION]... SOURCE... DIRECTORY\n   or:  mv [OPTION]... -t DIRECTORY SOURCE...',
    man: 'DESCRIPTION\n       Rename SOURCE to DEST, or move SOURCE(s) to DIRECTORY.\n\nOPTIONS\n       -f, --force\n              do not prompt before overwriting\n       -i, --interactive\n              prompt before overwrite\n       -n, --no-clobber\n              do not overwrite an existing file\n       -t DIRECTORY\n              move all SOURCE arguments into DIRECTORY\n       -u, --update\n              move only when the SOURCE file is newer than the destination\n       -v, --verbose\n              explain what is being done\n\nEXAMPLES\n       mv report.txt report-final.txt\n              Rename a file.\n       mv -v *.log /tmp/logs\n              Move every log file into a directory.',
    help: "  -f, --force                  do not prompt before overwriting\n  -i, --interactive            prompt before overwrite\n  -n, --no-clobber             do not overwrite an existing file\n  -t, --target-directory=DIRECTORY  move all SOURCE arguments into DIRECTORY\n  -T, --no-target-directory    treat DEST as a normal file\n  -u, --update                 move only when the SOURCE file is newer\n  -v, --verbose                explain what is being done\n",
    authors: 'Mike Parker, David MacKenzie, and Jim Meyering',
    spec: { short: 'finuvt:TbS:', long: ['backup=?', 'suffix=', 'force', 'interactive', 'no-clobber', 'update', 'verbose', 'target-directory=', 'no-target-directory'],
      alias: { force: 'f', interactive: 'i', 'no-clobber': 'n', update: 'u', verbose: 'v', 'target-directory': 't', 'no-target-directory': 'T' } },
    async main(ctx, g) {
      const p = g.opts;
      const move = async (src, dst) => {
        let sst = null; let why = 'No such file or directory';
        try { sst = ctx.fs.lstat(src); } catch (e) { if (!isFsError(e)) throw e; why = e.message; }
        if (!sst) { ctx.eprintln('mv: cannot stat ' + q(src) + ': ' + why); return false; }
        const dstat = tryLstat(ctx, dst);
        if (dstat) {
          if (sameFile(ctx, src, dst) && ctx.fs.abs(src) === ctx.fs.abs(dst)) { ctx.eprintln('mv: ' + q(src) + ' and ' + q(dst) + ' are the same file'); return false; }
          if (sst.isDir && !dstat.isDir) { ctx.eprintln('mv: cannot overwrite non-directory ' + q(dst) + ' with directory ' + q(src)); return false; }
          if (!sst.isDir && dstat.isDir) { ctx.eprintln('mv: cannot overwrite directory ' + q(dst) + ' with non-directory'); return false; }
          if (p.n) { ctx.eprintln('mv: not replacing ' + q(dst)); return false; }
          if (p.u && dstat.mtime >= sst.mtime) return true;
          if (p.i && !p.f && !(await confirm(ctx, 'mv: overwrite ' + q(dst) + '? '))) return false;
          const bm = backupMode(p.backup != null ? p.backup : p.b ? true : null);
          if (bm && !dstat.isDir) { try { ctx.fs.rename(dst, backupName(ctx, dst, bm, p.S || p.suffix)); } catch (e) { if (!isFsError(e)) throw e; ctx.eprintln('mv: cannot backup ' + q(dst) + ': ' + e.message); return false; } }
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
    prep: (args) => { const i = args.findIndex((a) => /^-[rwxXstugoa,=+-]+$/.test(a) || a === '--'); return i < 0 || args[i] === '--' ? args : args.slice(0, i).concat('--', args.slice(i)); },
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
      const status = await eachTarget(g.opts.f ? Object.assign(Object.create(ctx), { eprintln() {}, err() {} }) : ctx, files, !!g.opts.R, 'changing permissions of', (p, st, shown) => {
        const next = refMode != null ? refMode : applyMode(spec, st.mode, st.isDir, ctx.shell.umask);
        const target = st.isLink ? ctx.fs.stat(p) : st;
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
    if (!symlinks) return ctx.fs.abs(path);
    let pending = ctx.fs.abs(path).split('/').filter(Boolean);
    let done = []; let hops = 0;
    while (pending.length) {
      const name = pending.shift();
      if (name === '.') continue;
      if (name === '..') { done.pop(); continue; }
      const last = pending.length === 0;
      let st = null;
      try { st = ctx.fs.lstat('/' + done.concat(name).join('/')); } catch (e) { if (!isFsError(e) || e.code !== 'ENOENT') throw e; }
      if (!st) {
        if (mode === 'e' || (mode === 'f' && !last)) throw new K.FsError('ENOENT', path);
        done.push(name);
      } else if (st.isLink) {
        if (++hops > 40) throw new K.FsError('ELOOP', path);
        if (st.target[0] === '/') done = [];
        pending = st.target.split('/').filter(Boolean).concat(pending);
      } else if (!last && !st.isDir) throw new K.FsError('ENOTDIR', path);
      else done.push(name);
    }
    return '/' + done.join('/');
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
          if (!g.opts.q) ctx.eprintln('realpath: ' + qf(f) + ': ' + e.message);
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
          if (g.opts.v) ctx.eprintln('readlink: ' + qf(f) + ': ' + e.message);
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
      let shownTemplate = template + suffix;
      if (dir != null) { name = joinPath(dir, name); shownTemplate = joinPath(dir, shownTemplate); }
      if (!o.u) {
        try {
          if (o.d) ctx.fs.mkdir(name, { mode: 0o700 }); else ctx.fs.write(name, '', { mode: 0o600 });
        } catch (e) {
          if (!isFsError(e)) throw e;
          if (!o.q) ctx.eprintln('mktemp: failed to create ' + (o.d ? 'directory' : 'file') + ' via template ' + q(shownTemplate) + ': ' + e.message);
          return 1;
        }
      }
      ctx.out(name + '\n');
      return 0;
    },
  });

  /* ===================================================================== file */

  const FILE_USAGE = 'Usage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]\n            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]\n            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]\n            <file> ...\n       file -C [-m <magicfiles>]\n       file [--help]\n';

  const SCRIPT_TYPES = [
    [/(^|[/ ])bash$/, 'Bourne-Again shell script', 'text/x-shellscript'],
    [/(^|[/ ])(ba)?sh$|dash$/, 'POSIX shell script', 'text/x-shellscript'],
    [/(^|[/ ])zsh$/, "Paul Falstad's zsh script", 'text/x-shellscript'],
    [/(^|[/ ])python[\d.]*$/, 'Python script', 'text/x-script.python'],
    [/(^|[/ ])perl[\d.]*$/, 'Perl script', 'text/x-perl'],
    [/(^|[/ ])ruby[\d.]*$/, 'Ruby script', 'text/x-ruby'],
    [/(^|[/ ])php[\d.]*$/, 'PHP script', 'text/x-php'],
    [/(^|[/ ])(node|nodejs)$/, 'Node.js script executable', 'application/javascript'],
  ];

  const u32le = (s, i) => (s.charCodeAt(i) | (s.charCodeAt(i + 1) << 8) | (s.charCodeAt(i + 2) << 16) | (s.charCodeAt(i + 3) << 24)) >>> 0;
  const u32be = (s, i) => ((s.charCodeAt(i) << 24) | (s.charCodeAt(i + 1) << 16) | (s.charCodeAt(i + 2) << 8) | s.charCodeAt(i + 3)) >>> 0;
  const hexHash = (name) => { let h = ''; for (let i = 0; h.length < 40; i++) h += U.hash32(name + ':' + i).toString(16).padStart(8, '0'); return h.slice(0, 40); };

  /** Describe text content as `file` does: charset plus line-terminator modifiers. */
  function textDescription(whole) {
    const text = whole.slice(0, 65536); // file(1) only examines the start of the data
    const ascii = !/[^\x00-\x7f]/.test(text);
    const bom = text.charCodeAt(0) === 0xfeff;
    let d = bom ? 'Unicode text, UTF-8 (with BOM) text' : ascii ? 'ASCII text' : 'Unicode text, UTF-8 text';
    const lines = text.split('\n');
    const longest = Math.max.apply(null, lines.map((l) => U.byteLen(l.replace(/\r$/, ''))));
    const mods = [];
    if (longest > 300) mods.push('with very long lines (' + longest + ')');
    const kinds = [];
    if (/\r\n/.test(text)) kinds.push('CRLF');
    if (/\r(?!\n)/.test(text)) kinds.push('CR');
    if (/(^|[^\r])\n/.test(text)) kinds.push(kinds.length ? 'LF' : '');
    if (kinds.length && kinds[kinds.length - 1] === '') kinds.pop();
    if (kinds.length) mods.push('with ' + kinds.join(', ') + ' line terminators');
    if (!/[\r\n]/.test(text)) mods.push('with no line terminators');
    return { base: d, mods, ascii };
  }

  function describeJpeg(s) {
    let d = 'JPEG image data';
    if (s.slice(6, 10) === 'JFIF') d += ', JFIF standard ' + s.charCodeAt(11) + '.' + U.pad2(s.charCodeAt(12));
    let i = 2;
    while (i + 4 < s.length) {
      if (s.charCodeAt(i) !== 0xff) break;
      const marker = s.charCodeAt(i + 1); const len = (s.charCodeAt(i + 2) << 8) | s.charCodeAt(i + 3);
      if (marker >= 0xc0 && marker <= 0xc2) {
        const h = (s.charCodeAt(i + 5) << 8) | s.charCodeAt(i + 6); const w = (s.charCodeAt(i + 7) << 8) | s.charCodeAt(i + 8);
        return d + ', ' + (marker === 0xc2 ? 'progressive' : 'baseline') + ', precision ' + s.charCodeAt(i + 4) + ', ' + w + 'x' + h + ', components ' + s.charCodeAt(i + 9);
      }
      i += 2 + len;
    }
    return d;
  }

  function describePng(s) {
    if (s.length < 29) return 'PNG image data';
    const depth = s.charCodeAt(24); const ct = s.charCodeAt(25);
    const kind = { 0: 'grayscale', 2: 'RGB', 3: 'colormap', 4: 'gray+alpha', 6: 'RGBA' }[ct] || 'RGB';
    const colour = ct === 2 || ct === 6 ? depth + '-bit/color ' + kind : depth + '-bit ' + kind;
    return 'PNG image data, ' + u32be(s, 16) + ' x ' + u32be(s, 20) + ', ' + colour + ', ' + (s.charCodeAt(28) ? 'interlaced' : 'non-interlaced');
  }

  function describeGzip(s) {
    const flags = s.charCodeAt(3); let d = 'gzip compressed data';
    let off = 10;
    if (flags & 4) off += 2 + (s.charCodeAt(off) | (s.charCodeAt(off + 1) << 8));
    if (flags & 8) { const e = s.indexOf('\0', off); if (e > 0) d += ', was "' + s.slice(off, e) + '"'; }
    const mtime = u32le(s, 4);
    if (mtime) { const t = new Date(mtime * 1000); d += ', last modified: ' + U.DAYS[t.getUTCDay()] + ' ' + U.MONTHS[t.getUTCMonth()] + ' ' + U.padStart(t.getUTCDate(), 2) + ' ' + U.isoDate(mtime * 1000).slice(11) + ' ' + t.getUTCFullYear(); }
    const xfl = s.charCodeAt(8);
    if (xfl === 2) d += ', max compression'; else if (xfl === 4) d += ', max speed';
    const os = { 0: 'FAT filesystem', 3: 'Unix', 11: 'NTFS filesystem (NT)' }[s.charCodeAt(9)];
    if (os) d += ', from ' + os;
    if (s.length >= 18) d += ', original size modulo 2^32 ' + u32le(s, s.length - 4);
    return d;
  }

  /** Classify file content. Returns {desc, mime, enc}. */
  function sniff(ctx, path, st) {
    const bin = (desc, mime) => ({ desc, mime, enc: 'binary' });
    if (st.isDir) return bin((st.mode & 0o4000 ? 'setuid, ' : '') + (st.mode & 0o2000 ? 'setgid, ' : '') + (st.mode & 0o1000 ? 'sticky, ' : '') + 'directory', 'inode/directory');
    if (st.isDev) return bin('character special (' + (DEV_SPECIAL[st.dev] || [0, 0]).join('/') + ')', 'inode/chardevice');
    let s;
    try { s = ctx.fs.read(path); } catch (e) {
      if (!isFsError(e)) throw e;
      if (e.code === 'EACCES') return bin(st.mode & 0o4000 ? 'setuid regular file, no read permission' : 'regular file, no read permission', 'application/octet-stream');
      return { error: e };
    }
    return sniffContent(s, path);
  }

  /** Classify the content of a regular file (or of standard input). */
  function sniffContent(s, name) {
    const bin = (desc, mime) => ({ desc, mime, enc: 'binary' });
    if (s === '') return bin('empty', 'inode/x-empty');
    if (s.startsWith('\x7fELF')) {
      const m = /kalima:([^\n]+)/.exec(s.slice(0, 64));
      const id = hexHash(m ? m[1] : name);
      return bin('ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, BuildID[sha1]=' + id + ', for GNU/Linux 3.2.0, stripped', 'application/x-pie-executable');
    }
    if (s.startsWith('\x1f\x8b')) return bin(describeGzip(s), 'application/gzip');
    if (s.startsWith('BZh')) return bin('bzip2 compressed data, block size = ' + (s.charCodeAt(3) - 48) * 100 + 'k', 'application/x-bzip2');
    if (s.startsWith('\xfd7zXZ')) return bin('XZ compressed data, checksum CRC64', 'application/x-xz');
    if (s.startsWith('PK\x03\x04') && s.length >= 10) {
      const v = s.charCodeAt(4); const method = { 0: 'store', 8: 'deflate' }[s.charCodeAt(8)] || 'deflate';
      return bin('Zip archive data, at least v' + Math.floor(v / 10) + '.' + (v % 10) + ' to extract, compression method=' + method, 'application/zip');
    }
    if (s.startsWith('PK\x05\x06')) return bin('Zip archive data (empty)', 'application/zip');
    if (s.slice(257, 262) === 'ustar') return bin(s.slice(257, 265) === 'ustar  \0' ? 'POSIX tar archive (GNU)' : 'POSIX tar archive', 'application/x-tar');
    if (s.startsWith('\x89PNG\r\n\x1a\n')) return bin(describePng(s), 'image/png');
    if (s.startsWith('\xff\xd8\xff')) return bin(describeJpeg(s), 'image/jpeg');
    if (s.startsWith('GIF8')) return bin('GIF image data, version ' + s.slice(3, 6) + ', ' + (s.charCodeAt(6) | (s.charCodeAt(7) << 8)) + ' x ' + (s.charCodeAt(8) | (s.charCodeAt(9) << 8)), 'image/gif');
    if (s.startsWith('%PDF-')) {
      const pages = (s.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
      return bin('PDF document, version ' + s.slice(5, 8) + (pages ? ', ' + pages + ' page(s)' : ''), 'application/pdf');
    }
    if (s.startsWith('SQLite format 3\0')) return bin('SQLite 3.x database', 'application/vnd.sqlite3');
    if (/[\x00-\x08\x0e-\x1a\x1c-\x1f�]/.test(s)) return bin('data', 'application/octet-stream');

    const t = textDescription(s);
    const tail = (extra) => [extra || t.base].concat(t.mods).join(', ');
    const charset = t.ascii ? 'us-ascii' : 'utf-8';
    const text = (desc, mime) => ({ desc, mime, enc: charset });
    const head = s.replace(/^﻿/, '').trimStart();
    const she = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(s);
    if (she) {
      const interp = she[1].endsWith('/env') && she[2] ? she[2] : she[1];
      const known = SCRIPT_TYPES.find((r) => r[0].test(interp));
      if (known) {
        if (known[1] === 'Perl script') return text('Perl script text executable' + t.mods.map((m) => ', ' + m).join(''), known[2]);
        if (known[1].endsWith('executable')) return text(known[1] + ', ' + tail(), known[2]);
        return text(known[1] + ', ' + t.base + ' executable' + t.mods.map((m) => ', ' + m).join(''), known[2]);
      }
      return text('a ' + she[1] + (she[2] && she[1].endsWith('/env') ? ' ' + she[2] : '') + ' script, ' + t.base + ' executable' + t.mods.map((m) => ', ' + m).join(''), 'text/plain');
    }
    if (/^-----BEGIN CERTIFICATE-----/.test(head)) return text('PEM certificate', 'application/x-x509-ca-cert');
    if (/^-----BEGIN CERTIFICATE REQUEST-----/.test(head)) return text('PEM certificate request', 'application/pkcs10');
    if (/^-----BEGIN RSA PRIVATE KEY-----/.test(head)) return text('PEM RSA private key', 'application/x-pem-file');
    if (/^-----BEGIN OPENSSH PRIVATE KEY-----/.test(head)) return text('OpenSSH private key', 'application/x-pem-file');
    if (/^-----BEGIN EC PRIVATE KEY-----/.test(head)) return text('PEM EC private key', 'application/x-pem-file');
    const ssh = /^ssh-(rsa|ed25519|dss) /.exec(head) || /^ecdsa-sha2-nistp\d+ /.exec(head);
    if (ssh) return text('OpenSSH ' + (ssh[1] ? { rsa: 'RSA', ed25519: 'ED25519', dss: 'DSA' }[ssh[1]] : 'ECDSA') + ' public key', 'text/plain');
    if (/^<\?xml\s/.test(head)) {
      const v = /version=["']([\d.]+)["']/.exec(head);
      if (/<svg[\s>]/.test(head)) return text('SVG Scalable Vector Graphics image', 'image/svg+xml');
      return text('XML ' + (v ? v[1] : '1.0') + ' document, ' + tail(), 'text/xml');
    }
    if (/^<!doctype html|^<html/i.test(head)) return text('HTML document, ' + tail(), 'text/html');
    if (/^<\?php/.test(head)) return text('PHP script, ' + tail(), 'text/x-php');
    if (/^[[{]/.test(head)) {
      try { JSON.parse(s); return text('JSON text data', 'application/json'); } catch (e) { /* plain text */ }
    }
    if (/^\s*#\s*include\s*[<"][\w./]+[>"]/m.test(s) || /^\s*(?:int|void)\s+main\s*\(/m.test(s)) return text('C source, ' + tail(), 'text/x-c');
    if (looksLikeCsv(s)) return text('CSV ' + tail(), 'text/csv');
    return text(tail(), 'text/plain');
  }

  /** file(1) 5.45 calls text CSV when 2 or more lines all have the same number (at least 2) of comma separated fields. */
  function looksLikeCsv(s) {
    const lines = s.replace(/\r?\n$/, '').split(/\r?\n/);
    if (lines.length < 2 || lines.length > 5000) return false;
    let want = -1;
    for (const line of lines) {
      let n = 1; let inq = false;
      for (const ch of line) { if (ch === '"') inq = !inq; else if (ch === ',' && !inq) n++; }
      if (inq || n < 2) return false;
      if (want < 0) want = n; else if (n !== want) return false;
    }
    return true;
  }

  function describeFile(ctx, f, o) {
    let st;
    try { st = o.follow ? ctx.fs.stat(f) : ctx.fs.lstat(f); } catch (e) {
      if (!isFsError(e)) throw e;
      return { error: e };
    }
    if (st.isLink) {
      const ok = tryStat(ctx, f);
      return { desc: (ok ? 'symbolic link to ' : 'broken symbolic link to ') + st.target, mime: 'inode/symlink', enc: 'binary' };
    }
    return sniff(ctx, f, st);
  }
  function tryStat(ctx, f) { try { return ctx.fs.stat(f); } catch (e) { return null; } }

  K.cmd.register({
    name: 'file', pkg: 'file', section: 1, summary: 'determine file type', synopsis: 'file [OPTION...] [FILE...]',
    man: 'DESCRIPTION\n       file tests each argument in an attempt to classify it. There are three sets of tests, performed in this order: filesystem tests, magic tests, and language tests. The first test that succeeds causes the file type to be printed.\n\nOPTIONS\n       -b, --brief\n              do not prepend filenames to output lines\n       -i, --mime\n              output MIME type strings instead of the more traditional human readable ones\n       --mime-type, --mime-encoding\n              output only the MIME type or only the encoding\n       -L, --dereference\n              follow symlinks\n       -h, --no-dereference\n              do not follow symlinks (default)\n\nEXAMPLES\n       file /bin/ls\n              Show that /bin/ls is an ELF executable.\n       file -b payload.bin\n              Print the type without the file name.',
    async run(ctx) {
      const g = ctx.getopt({ short: 'bchiLlNnprsSvzZEkdFf:', long: ['brief', 'mime', 'mime-type', 'mime-encoding', 'dereference', 'no-dereference', 'help', 'version', 'separator='], alias: { brief: 'b', mime: 'i', dereference: 'L', 'no-dereference': 'h' } });
      if (g.err) { ctx.err('file: ' + g.err + '\n' + FILE_USAGE); return 1; }
      if (g.opts.version) { ctx.out('file-5.45\nmagic file from /etc/magic:/usr/share/misc/magic\n'); return 0; }
      if (g.opts.help) { ctx.out('Usage: file [OPTION...] [FILE...]\nDetermine type of FILEs.\n\n  -b, --brief                do not prepend filenames to output lines\n  -i, --mime                 output MIME type strings (--mime-type and\n                             --mime-encoding)\n  -L, --dereference          follow symlinks\n  -h, --no-dereference       don\'t follow symlinks (default)\n      --help                 display this help and exit\n      --version              output version information and exit\n'); return 0; }
      const files = g.rest.length ? g.rest : null;
      if (!files) { ctx.err(FILE_USAGE); return 1; }
      const o = { follow: !!g.opts.L };
      const width = Math.max.apply(null, files.map((f) => (f === '-' ? '/dev/stdin' : f).length)) + 1;
      for (const f of files) {
        const shown = f === '-' ? '/dev/stdin' : f;
        let r;
        r = f === '-' ? sniffContent(await stdinText(ctx), shown) : describeFile(ctx, f, o);
        let line;
        if (r.error) {
          line = 'cannot open `' + f + "' (" + r.error.message + ')';
        } else if (g.opts['mime-type']) line = r.mime;
        else if (g.opts['mime-encoding']) line = r.enc;
        else if (g.opts.i) line = r.mime + '; charset=' + r.enc;
        else line = r.desc;
        ctx.out((g.opts.b ? '' : U.padEnd(shown + ':', width) + ' ') + line + '\n');
      }
      return 0;
    },
  });

  /* ===================================================================== tac */

  gnu({
    name: 'tac', summary: 'concatenate and print files in reverse', synopsis: 'tac [OPTION]... [FILE]...',
    man: 'DESCRIPTION\n       Write each FILE to standard output, last line first.\n\nOPTIONS\n       -s, --separator=STRING\n              use STRING as the separator instead of newline\n\nEXAMPLES\n       tac /var/log/auth.log | head\n              The ten newest authentication log lines.',
    help: "  -b, --before             attach the separator before instead of after\n  -r, --regex              interpret the separator as a regular expression\n  -s, --separator=STRING   use STRING as the separator instead of newline\n",
    authors: 'Jay Lepreau and David MacKenzie',
    spec: { short: 'brs:', long: ['before', 'regex', 'separator='], alias: { before: 'b', regex: 'r', separator: 's' } },
    async main(ctx, g) {
      const sep = g.opts.s == null ? '\n' : g.opts.s;
      if (sep === '') { ctx.eprintln('tac: separator cannot be empty'); return 1; }
      let status = 0;
      for (const f of g.rest.length ? g.rest : ['-']) {
        let text;
        try { text = f === '-' ? await stdinText(ctx) : ctx.fs.read(f); } catch (e) {
          if (!isFsError(e)) throw e;
          ctx.eprintln('tac: failed to open ' + q(f) + ' for reading: ' + e.message); status = 1; continue;
        }
        const parts = text.split(sep);
        const trailing = parts.pop();
        const records = parts.map((p) => p + sep);
        if (trailing !== '') records.push(trailing);
        if (g.opts.b) { ctx.out(text); continue; }
        ctx.out(records.reverse().join(''));
      }
      return status;
    },
  });

  /* ================================================================ less, more */

  /** Shared pager front end: files or stdin, pager on a terminal, plain output otherwise. */
  async function pageFiles(ctx, g, missing, opts) {
    const files = g.rest;
    let status = 0; const chunks = [];
    if (!files.length) {
      if (ctx.stdin == null) { ctx.eprintln(opts.noInput); return 1; }
      chunks.push({ name: null, text: ctx.stdin });
    }
    for (const f of files) {
      try {
        if (ctx.fs.isDir(f)) { ctx.println(opts.dirMsg(f)); status = 1; continue; }
        chunks.push({ name: f, text: ctx.fs.read(f) });
      } catch (e) {
        if (!isFsError(e)) throw e;
        ctx.eprintln(missing(f, e)); status = 1;
      }
    }
    if (g.opts.N) {
      for (const c of chunks) { let n = 0; c.text = splitLines(c.text).map((l) => U.padStart(++n, 6) + ' ' + l).join('\n') + (c.text.endsWith('\n') ? '\n' : ''); }
    }
    if (!chunks.length) return 0;
    const text = chunks.map((c, i) => (chunks.length > 1 && opts.headers ? (i ? '\n' : '') + '::::::::::::::\n' + c.name + '\n::::::::::::::\n' : '') + c.text).join('');
    if (ctx.isTTY && ctx.term && ctx.term.pager) await ctx.term.pager(text, { title: chunks[0].name || '(standard input)' });
    else ctx.out(text);
    return status;
  }

  gnu({
    name: 'less', pkg: 'less', summary: 'opposite of more', synopsis: 'less [OPTIONS] [FILE]...',
    man: 'DESCRIPTION\n       less is a program similar to more, but it has many more features. less does not have to read the entire input file before starting, so with large input files it starts up faster than text editors like vi.\n\n       Inside less: SPACE or f scroll forward, b scroll back, /pattern search, n next match, g and G go to the start and the end, q quit, h help.\n\nOPTIONS\n       -N, --LINE-NUMBERS\n              causes a line number to be displayed at the beginning of each line\n       -S, --chop-long-lines\n              causes lines longer than the screen width not to be folded\n       -R, --RAW-CONTROL-CHARS\n              like -r, but only ANSI colour escape sequences are output in raw form\n       -F     quit if the entire file can be displayed on one screen\n       -X     disables sending the termcap initialization and deinitialization strings\n\nEXAMPLES\n       less /var/log/syslog\n              Page through the system log.\n       ps aux | less -S\n              Page a wide process list without wrapping.',
    help: "  -N  or --LINE-NUMBERS  Display line number for each line.\n  -R  or --RAW-CONTROL-CHARS  Output \"raw\" control characters.\n  -S  or --chop-long-lines  Chop (truncate) long lines rather than wrapping.\n  -F  or --quit-if-one-screen  Quit if entire file fits on first screen.\n  -X  or --no-init       Don't use termcap init/deinit strings.\n",
    authors: 'Mark Nudelman',
    spec: { short: 'NSRFXrisMmeEwcCgGfaPpjkntTuUVx:z:', long: ['LINE-NUMBERS', 'chop-long-lines', 'RAW-CONTROL-CHARS', 'quit-if-one-screen', 'no-init', 'ignore-case', 'IGNORE-CASE'], alias: { 'LINE-NUMBERS': 'N', 'chop-long-lines': 'S', 'RAW-CONTROL-CHARS': 'R', 'quit-if-one-screen': 'F', 'no-init': 'X' } },
    main: (ctx, g) => pageFiles(ctx, g, (f, e) => f + ': ' + e.message, {
      noInput: 'Missing filename ("less --help" for help)', dirMsg: (f) => f + ' is a directory', headers: false,
    }),
  });

  gnu({
    name: 'more', pkg: 'util-linux', summary: 'file perusal filter for crt viewing', synopsis: 'more [options] file...',
    man: 'DESCRIPTION\n       more is a filter for paging through text one screenful at a time.\n\nOPTIONS\n       -d     display help instead of ringing bell\n       -f     count logical rather than screen lines\n       -s     squeeze multiple blank lines into one\n       -N     display line numbers (not in real more; accepted for convenience)\n\nEXAMPLES\n       more /etc/services\n              Read the services file a screen at a time.',
    help: "Options:\n  -d, --silent          display help instead of ringing bell\n  -f, --logical         count logical rather than screen lines\n  -s, --squeeze         squeeze multiple blank lines into one\n  -h, --help            display this help\n  -V, --version         display version\n",
    authors: 'Eric Shienbrood, Geoff Collyer, and others',
    spec: { short: 'dflprsucV0123456789n:', long: ['silent', 'logical', 'no-pause', 'print-over', 'clean-print', 'squeeze', 'plain'] },
    main: (ctx, g) => pageFiles(ctx, g, (f, e) => 'more: cannot open ' + f + ': ' + e.message, {
      noInput: 'more: bad usage\nTry \'more --help\' for more information.', dirMsg: (f) => '\n*** ' + f + ': directory ***\n', headers: true,
    }),
  });

  /* =========================================================== nano, vim, vi */

  function editorCommand(def) {
    K.cmd.register(Object.assign({ section: 1, async run(ctx) {
      const g = ctx.getopt({ short: def.shortOpts, long: ['help', 'version'].concat(def.longOpts || []) });
      if (g.err) { ctx.eprintln(ctx.name + ': ' + g.err); ctx.eprintln("Try '" + ctx.name + " --help' for more information."); return 1; }
      if (g.opts.version) { ctx.out(def.version); return 0; }
      if (g.opts.help) { ctx.out('Usage: ' + def.synopsis + '\n'); return 0; }
      if (!ctx.stdinTTY) { ctx.eprintln(def.notTerminal); return 1; }
      if (!ctx.isTTY || !ctx.term || !ctx.term.editor) { ctx.eprintln(def.notTerminalOut); return 1; }
      const file = g.rest.find((a) => !/^\+\d*$/.test(a)) || null;
      let content = '';
      let isNew = file == null;
      if (file != null) {
        try {
          if (ctx.fs.isDir(file)) { ctx.eprintln(def.dirMsg(file)); return 1; }
          content = ctx.fs.read(file);
        } catch (e) {
          if (!isFsError(e)) throw e;
          if (e.code === 'ENOENT') isNew = true;
          else { ctx.eprintln(def.readError(file, e)); content = ''; }
        }
      }
      const res = await ctx.term.editor({ path: file == null ? null : file, content, flavor: def.flavor, isNew });
      if (res && res.saved && file != null) {
        try { ctx.fs.write(file, res.content); } catch (e) {
          if (!isFsError(e)) throw e;
          ctx.eprintln(def.writeError(file, e)); return 1;
        }
      }
      return 0;
    } }, def.reg));
  }

  editorCommand({
    flavor: 'nano', shortOpts: 'ABCDEFGHIKLMNOPQRSTUWYZabcdegiklmnopqrstuvwxyz0123456789@$_%+-', synopsis: 'nano [OPTIONS] [[+LINE[,COLUMN]] FILE]...',
    version: ' GNU nano, version 8.4\n (C) 1999-2011, 2013-2025 Free Software Foundation, Inc.\n Email: nano@nano-editor.org\tWeb: https://nano-editor.org/\n',
    notTerminal: 'Too many errors from stdin', notTerminalOut: 'Too many errors from stdin',
    dirMsg: (f) => '"' + f + '" is a directory', readError: (f, e) => 'Error reading ' + f + ': ' + e.message,
    writeError: (f, e) => 'Error writing ' + f + ': ' + e.message,
    reg: { name: 'nano', pkg: 'nano', summary: 'Nano\'s ANOther editor, inspired by Pico', synopsis: 'nano [OPTIONS] [[+LINE[,COLUMN]] FILE]...',
      man: 'DESCRIPTION\n       nano is a small and friendly text editor. Besides editing plain text it offers features such as undo/redo, syntax colouring, interactive search and replace, auto-indentation and line numbers.\n\n       Common keys: Ctrl+O write the file out, Ctrl+X exit, Ctrl+W search, Ctrl+K cut a line, Ctrl+U paste, Ctrl+G help.\n\nOPTIONS\n       -l, --linenumbers\n              display line numbers in front of the text\n       -B, --backup\n              when saving a file, back up the previous version\n\nEXAMPLES\n       nano notes.txt\n              Edit notes.txt, creating it when saved if it does not exist.' },
  });

  const VIM_VERSION = 'VIM - Vi IMproved 9.1 (2024 Jan 02, compiled Nov 10 2025 10:11:12)\nIncluded patches: 1-1500\nCompiled by Debian\n';
  editorCommand({
    flavor: 'vim', shortOpts: 'bcCdDeEfFgGhHlLmMnNoOpqrRsStTuUvVwWxXyYzZ', synopsis: 'vim [arguments] [file ..]       edit specified file(s)',
    version: VIM_VERSION,
    notTerminal: 'Vim: Warning: Input is not from a terminal', notTerminalOut: 'Vim: Warning: Output is not to a terminal',
    dirMsg: (f) => '"' + f + '" is a directory', readError: (f, e) => '"' + f + '" ' + e.message, writeError: (f, e) => 'E212: Can\'t open file for writing',
    reg: { name: 'vim', aliases: ['vi'], path: '/usr/bin/vim', pkg: 'vim', summary: 'Vi IMproved, a programmer\'s text editor', synopsis: 'vim [options] [file ..]',
      man: 'DESCRIPTION\n       Vim is a text editor that is upwards compatible to Vi. It can be used to edit all kinds of plain text.\n\n       Modes: press i to insert text, Esc to return to normal mode, then :w to write, :q to quit, :wq to write and quit, :q! to quit without saving. /pattern searches, dd deletes a line, u undoes.\n\nOPTIONS\n       -R     read-only mode\n       -n     no swap file\n       +N     start at line N\n\nEXAMPLES\n       vim /etc/hosts\n              Edit the hosts file (needs sudo to save).\n       vi notes.txt\n              vi is the same program.' },
  });

  /* ================================================================ du, df */

  const timeIso = (ms) => { const d = new Date(ms); const p = U.pad2; return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()); };

  /** Blocks (in bytes) that an entry occupies on disk. */
  const diskBytes = (st) => blocksOf(st) * 1024;

  function duUnit(g) {
    const o = g.opts;
    if (o.b) return { div: 1, human: false, apparent: true };
    if (o.h) return { div: 1, human: true, apparent: !!o['apparent-size'] };
    if (o.m) return { div: 1048576, human: false, apparent: !!o['apparent-size'] };
    if (o.k) return { div: 1024, human: false, apparent: !!o['apparent-size'] };
    const bs = o.B != null ? o.B : o['block-size'];
    const m = typeof bs === 'string' ? /^(\d*)([KMGTkmgt])?(B)?$/.exec(bs) : null;
    if (m && (m[1] || m[2])) {
      const base = m[3] ? 1000 : 1024; const pow = m[2] ? 'KMGT'.indexOf(m[2].toUpperCase()) + 1 : 0;
      return { div: (parseInt(m[1] || '1', 10) || 1) * Math.pow(base, pow), human: false, apparent: !!o['apparent-size'], suffix: m[1] ? '' : m[2].toUpperCase() + (m[3] || '') };
    }
    return { div: 1024, human: false, apparent: !!o['apparent-size'] };
  }

  gnu({
    name: 'du', summary: 'estimate file space usage', synopsis: 'du [OPTION]... [FILE]...',
    man: 'DESCRIPTION\n       Summarize device usage of the set of FILEs, recursively for directories.\n\nOPTIONS\n       -a, --all\n              write counts for all files, not just directories\n       -b, --bytes\n              equivalent to --apparent-size --block-size=1\n       -c, --total\n              produce a grand total\n       -d, --max-depth=N\n              print the total for a directory only if it is N or fewer levels below the command line argument\n       -h, --human-readable\n              print sizes in human readable format (e.g., 1K 234M 2G)\n       -k     like --block-size=1K\n       -s, --summarize\n              display only a total for each argument\n\nEXAMPLES\n       du -sh /var/log\n              Total size of the log directory.\n       du -h -d 1 ~ | sort -h\n              Which top-level folders in the home directory are biggest.',
    help: "  -a, --all             write counts for all files, not just directories\n      --apparent-size   print apparent sizes rather than device usage\n  -b, --bytes           equivalent to '--apparent-size --block-size=1'\n  -c, --total           produce a grand total\n  -d, --max-depth=N     print the total for a directory (or file, with --all)\n                          only if it is N or fewer levels below the command\n                          line argument\n  -h, --human-readable  print sizes in human readable format (e.g., 1K 234M 2G)\n  -k                    like --block-size=1K\n  -m                    like --block-size=1M\n  -s, --summarize       display only a total for each argument\n",
    authors: 'Torbjorn Granlund, David MacKenzie, Paul Eggert, and Jim Meyering',
    spec: { short: 'abchkmsd:xSDLP0B:', long: ['all', 'bytes', 'total', 'human-readable', 'summarize', 'max-depth=', 'apparent-size', 'block-size=', 'si', 'one-file-system', 'null', 'time=?', 'exclude='], alias: { all: 'a', bytes: 'b', total: 'c', 'human-readable': 'h', summarize: 's', 'max-depth': 'd' } },
    main(ctx, g) {
      const o = g.opts;
      if (o.s && o.d != null) { ctx.eprintln('du: warning: summarizing conflicts with --max-depth=' + o.d); ctx.eprintln("Try 'du --help' for more information."); return 1; }
      const maxDepth = o.s ? 0 : o.d == null ? Infinity : parseInt(o.d, 10);
      if (o.d != null && !/^\d+$/.test(o.d)) { ctx.eprintln('du: invalid maximum depth ' + q(o.d)); ctx.eprintln("Try 'du --help' for more information."); return 1; }
      const unit = duUnit(g);
      const fmt = (bytes) => (unit.human ? U.humanSize(bytes) : String(Math.ceil(bytes / unit.div)) + (unit.suffix || ''));
      const excl = [].concat(g.all && g.all.exclude || o.exclude || []).filter((x) => typeof x === 'string').map(globRe);
      const eol = o['0'] || o.null ? '\0' : '\n';
      const sizeOf = (st) => (unit.apparent ? st.size : diskBytes(st));
      let status = 0; let grand = 0;
      const line = (bytes, name, st) => ctx.out(fmt(bytes) + '\t' + (o.time && st ? timeIso(st.mtime) + '\t' : '') + name + eol);
      const walk = (path, name, depth) => {
        ctx.checkAbort();
        let st;
        try { st = path.length > 1 && path.endsWith('/') ? ctx.fs.stat(path) : ctx.fs.lstat(path); } catch (e) {
          if (!isFsError(e)) throw e;
          ctx.eprintln('du: cannot access ' + q(name) + ': ' + e.message); status = 1; return 0;
        }
        if (depth > 0 && excl.some((re) => re.test(VFS.basename(path)))) return 0;
        let total = sizeOf(st);
        if (st.isDir) {
          let names = [];
          try { names = ctx.fs.readdir(path); } catch (e) {
            if (!isFsError(e)) throw e;
            ctx.eprintln('du: cannot read directory ' + q(name) + ': ' + e.message); status = 1;
          }
          for (const n of names) total += walk(joinPath(path, n), joinPath(name, n), depth + 1);
          if (depth <= maxDepth) line(total, name, st);
        } else if ((o.a && depth <= maxDepth) || depth === 0) line(total, name, st);
        return total;
      };
      for (const f of g.rest.length ? g.rest : ['.']) grand += walk(f, f, 0);
      if (o.c) line(grand, 'total');
      return status;
    },
  });

  // The simulated machine's mounted filesystems (sizes in KiB).
  const MOUNTS = [
    { dev: 'udev', type: 'devtmpfs', mount: '/dev', size: 1950568, used: 0 },
    { dev: 'tmpfs', type: 'tmpfs', mount: '/run', size: 396072, used: 1196 },
    { dev: '/dev/sda1', type: 'ext4', mount: '/', size: 82419448, used: 14380128 },
    { dev: 'tmpfs', type: 'tmpfs', mount: '/dev/shm', size: 1980348, used: 0 },
    { dev: 'tmpfs', type: 'tmpfs', mount: '/run/lock', size: 5120, used: 0 },
    { dev: 'tmpfs', type: 'tmpfs', mount: '/tmp', size: 1980348, used: 12 },
    { dev: 'tmpfs', type: 'tmpfs', mount: '/run/user/1000', size: 396068, used: 112 },
  ];

  function dfRows(ctx, g) {
    const hum = g.opts.h || g.opts.H;
    const fmt = (kib) => (hum ? U.humanSize(kib * 1024) : String(kib));
    const unitHead = hum ? 'Size' : '1K-blocks';
    const rows = (list) => list.map((m) => {
      const avail = m.size - m.used;
      return { dev: m.dev, type: m.type, size: fmt(m.size), used: fmt(m.used), avail: fmt(avail), pct: Math.ceil((m.used / (m.used + avail)) * 100) + '%', mount: m.mount };
    });
    return { rows, unitHead, hum };
  }

  function dfTable(ctx, rows, o, hum, unitHead, inodes) {
    const cols = [{ k: 'dev', h: 'Filesystem', min: 14, left: true }];
    if (o.T) cols.push({ k: 'type', h: 'Type', left: true });
    cols.push({ k: 'size', h: unitHead, min: hum ? 5 : 0 }, { k: 'used', h: inodes ? 'IUsed' : 'Used', min: hum ? 5 : 0 }, { k: 'avail', h: inodes ? 'IFree' : hum ? 'Avail' : 'Available', min: hum ? 5 : 0 }, { k: 'pct', h: inodes ? 'IUse%' : 'Use%', min: 0 }, { k: 'mount', h: 'Mounted on', left: true, last: true });
    for (const c of cols) c.w = Math.max(c.min || 0, c.h.length, ...rows.map((r) => r[c.k].length));
    const fmtRow = (r) => cols.map((c) => (c.last ? r[c.k] : c.left ? U.padEnd(r[c.k], c.w) : U.padStart(r[c.k], c.w))).join(' ');
    const head = {}; for (const c of cols) head[c.k] = c.h;
    return [head].concat(rows).map(fmtRow).join('\n') + '\n';
  }

  gnu({
    name: 'df', summary: 'report file system space usage', synopsis: 'df [OPTION]... [FILE]...',
    man: 'DESCRIPTION\n       This manual page documents the GNU version of df. df displays the amount of space available on the file system containing each file name argument. If no file name is given, the space available on all currently mounted file systems is shown.\n\nOPTIONS\n       -h, --human-readable\n              print sizes in powers of 1024 (e.g., 1023M)\n       -T, --print-type\n              print file system type\n       -k     like --block-size=1K\n\nEXAMPLES\n       df -h\n              Show every filesystem in human readable sizes.\n       df -hT /\n              Show the type and usage of the root filesystem.',
    help: "  -a, --all             include pseudo, duplicate, inaccessible file systems\n  -h, --human-readable  print sizes in powers of 1024 (e.g., 1023M)\n  -H, --si              print sizes in powers of 1000 (e.g., 1.1G)\n  -k                    like --block-size=1K\n  -T, --print-type      print file system type\n",
    authors: 'Torbjorn Granlund, David MacKenzie, and Paul Eggert',
    spec: { short: 'ahHkTPlix:t:', long: ['all', 'human-readable', 'si', 'print-type', 'local', 'inodes', 'exclude-type=', 'type=', 'total'], alias: { all: 'a', 'human-readable': 'h', si: 'H', 'print-type': 'T', inodes: 'i', 'exclude-type': 'x', type: 't' } },
    main(ctx, g) {
      const { rows, unitHead, hum } = dfRows(ctx, g);
      let list = MOUNTS; let status = 0;
      if (g.rest.length) {
        list = [];
        for (const f of g.rest) {
          let real;
          try { real = ctx.fs.realpath(f); } catch (e) {
            if (!isFsError(e)) throw e;
            ctx.eprintln('df: ' + qf(f) + ': ' + e.message); status = 1; continue;
          }
          const m = MOUNTS.filter((x) => x.mount === '/' || real === x.mount || real.startsWith(x.mount + '/')).sort((a, b) => b.mount.length - a.mount.length)[0];
          if (list.indexOf(m) < 0) list.push(m);
        }
        if (!list.length) return status;
      }
      const xs = [].concat(g.all.x || [], g.all['exclude-type'] || []).filter((v) => typeof v === 'string');
      const ts = [].concat(g.all.t || [], g.all.type || []).filter((v) => typeof v === 'string');
      if (xs.length) list = list.filter((m) => xs.indexOf(m.type) < 0);
      if (ts.length) list = list.filter((m) => ts.indexOf(m.type) >= 0);
      if (g.opts.i) {
        const fmtN = (n) => (hum ? U.humanSize(n).replace(/B$/, '') : String(n));
        const irows = list.map((m) => {
          const total = Math.floor(m.size / 4); const used = m.mount === '/' ? 245803 : Math.min(total, 4 + Math.floor(m.used / 40000));
          return { dev: m.dev, type: m.type, size: fmtN(total), used: fmtN(used), avail: fmtN(total - used), pct: (Math.ceil(used / total * 100) || 0) + '%', mount: m.mount };
        });
        ctx.out(dfTable(ctx, irows, g.opts, hum, 'Inodes', true));
        return status;
      }
      ctx.out(dfTable(ctx, rows(list), g.opts, hum, unitHead));
      return status;
    },
  });

  /* =================================================================== tree */

  gnu({
    name: 'tree', pkg: 'tree', summary: 'list contents of directories in a tree-like format', synopsis: 'tree [-acdfghilnpqrstuvxACDFJQNSUX] [-L level [-R]] [-H baseHREF] [-T title]\n\t[-o filename] [--nolinks] [-P pattern] [-I pattern] [--inodes] [--device]\n\t[--noreport] [--dirsfirst] [--version] [--help] [--filelimit #] [--si]\n\t[--prune] [--du] [--timefmt format] [--matchdirs] [--fromfile] [--] [directory ...]',
    man: 'DESCRIPTION\n       Tree is a recursive directory listing program that produces a depth indented listing of files. With no arguments, tree lists the files in the current directory. When directory arguments are given, tree lists all the files and/or directories found in the given directories each in turn. Upon completion of listing all files and directories found, tree returns the total number of files and/or directories listed.\n\nOPTIONS\n       -a     All files are printed, including hidden ones\n       -d     List directories only\n       -f     Print the full path prefix for each file\n       -L level\n              Max display depth of the directory tree\n       -C     Turn colorization on always\n       --noreport\n              Omits printing of the file and directory report at the end of the tree listing\n       --dirsfirst\n              List directories before files\n\nEXAMPLES\n       tree -L 2 ~/engagement\n              Show two levels of the engagement folder.\n       tree -a -d\n              Every directory, including hidden ones, but no files.',
    help: "  ------- Listing options -------\n  -a            All files are listed.\n  -d            List directories only.\n  -l            Follow symbolic links like directories.\n  -f            Print the full path prefix for each file.\n  -L level      Descend only level directories deep.\n  --dirsfirst   List directories before files (-U disables).\n  --noreport    Turn off file/directory count at end of tree listing.\n  -C            Turn colorization on always.\n",
    version: 'tree v2.2.1 (c) 1996 - 2024 by Steve Baker, Thomas Moore, Francesc Rocher, Florian Sesser, Kyosuke Tokoro\n',
    spec: { short: 'adflL:CNpPIsiqrthuUF', long: ['noreport', 'dirsfirst', 'charset=', 'filelimit=', 'prune', 'inodes', 'device'] },
    main(ctx, g) {
      const o = g.opts;
      if (o.L != null && !/^\d+$/.test(o.L) || o.L === '0') { ctx.eprintln('tree: Invalid level, must be greater than 0.'); return 1; }
      const maxLevel = o.L == null ? Infinity : parseInt(o.L, 10);
      const utf = !/^(C|POSIX)$/.test(ctx.env.LC_ALL || ctx.env.LANG || 'C') && !/ascii/i.test(o.charset || '');
      const glyph = utf ? { mid: '├── ', last: '└── ', bar: '│   ', gap: '    ' } : { mid: '|-- ', last: '`-- ', bar: '|   ', gap: '    ' };
      const color = !!o.C;
      const collate = collator(ctx.env);
      let dirs = 0; let files = 0;
      const label = (e, shown) => {
        let t = shown + (o.F && e.st.isDir ? '/' : '');
        const key = color ? colorKey(e.st, false) : null;
        if (key) t = paint(LS_COLOR[key], t);
        if (e.st.isLink) t += ' -> ' + e.st.target;
        return t;
      };
      const visit = (path, prefix, level) => {
        ctx.checkAbort();
        let names = ctx.fs.readdir(path);
        if (!o.a) names = names.filter((n) => n[0] !== '.');
        let entries = names.map((n) => ({ name: n, full: joinPath(path, n), st: ctx.fs.lstat(joinPath(path, n)) }));
        if (o.d) entries = entries.filter((e) => e.st.isDir);
        entries.sort((a, b) => collate(a.name, b.name));
        if (o.r) entries.reverse();
        if (o.dirsfirst) entries = entries.filter((e) => e.st.isDir).concat(entries.filter((e) => !e.st.isDir));
        entries.forEach((e, i) => {
          const last = i === entries.length - 1;
          let extra = '';
          if (o.p) extra += '[' + modeString(e.st) + ']  ';
          if (o.s) extra += '[' + U.padStart(e.st.size, 11) + ']  ';
          const readable = !e.st.isDir || (ctx.fs.can(e.full, 'r') && ctx.fs.can(e.full, 'x'));
          if (e.st.isDir) dirs++; else files++;
          ctx.out(prefix + (last ? glyph.last : glyph.mid) + extra + label(e, o.f ? e.full : e.name) + (readable ? '' : '  [error opening dir]') + '\n');
          if (e.st.isDir && readable && level < maxLevel) visit(e.full, prefix + (last ? glyph.gap : glyph.bar), level + 1);
        });
      };
      let status = 0;
      for (const root of g.rest.length ? g.rest : ['.']) {
        let st;
        try { st = ctx.fs.stat(root); } catch (e) {
          if (!isFsError(e)) throw e;
          ctx.out(root + ' [error opening dir]\n'); status = 2; continue;
        }
        ctx.out(root + '\n');
        if (st.isDir && ctx.fs.can(root, 'r')) visit(root, '', 1);
        else if (st.isDir) { ctx.out('[error opening dir]\n'); status = 2; }
      }
      if (!o.noreport) {
        ctx.out('\n' + dirs + ' ' + (dirs === 1 ? 'directory' : 'directories') + (o.d ? '' : ', ' + files + ' ' + (files === 1 ? 'file' : 'files')) + '\n');
      }
      return status;
    },
  });

  /* @@END */
})(typeof globalThis !== 'undefined' ? globalThis : this);
