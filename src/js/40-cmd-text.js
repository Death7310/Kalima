/* Kalima — text processing, encoding and hashing commands.
 *
 * grep sed awk cut sort uniq wc tr tee xargs diff cmp comm paste join nl rev
 * fold fmt column expand unexpand seq yes expr bc factor shuf split base64
 * base32 xxd hexdump od strings md5sum sha*sum cksum sum openssl jq
 *
 * Everything here works on the simulated filesystem only. Interpreters (sed,
 * awk, bc, jq, expr) are real parsers: learner input is never evaluated as
 * JavaScript.
 */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;

  /* ================================================================ helpers */

  /** GNU error-message quoting in a UTF-8 locale: ‘text’ */
  const q = (s) => '‘' + s + '’';
  const isFsError = (e) => e instanceof K.FsError;

  /** Split text into lines. A final line without a newline still counts. */
  function splitLines(text) {
    if (text === '') return [];
    const a = text.split('\n');
    if (a[a.length - 1] === '') a.pop();
    return a;
  }

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

  /** Read one operand; "-" means standard input. Throws K.FsError. */
  async function readOperand(ctx, file) {
    return file === '-' ? stdinText(ctx) : ctx.fs.read(file);
  }

  /**
   * Read every operand (standard input when there are none). Failures are
   * reported as "<tool>: <file>: <reason>" unless `report` builds another message.
   * Returns { inputs: [{name, text}], failed }.
   */
  async function readInputs(ctx, files, report) {
    const inputs = []; let failed = false;
    for (const name of files.length ? files : ['-']) {
      try { inputs.push({ name, text: await readOperand(ctx, name) }); }
      catch (e) {
        if (!isFsError(e)) throw e;
        failed = true;
        ctx.err(ctx.name + ': ' + (report ? report(name, e) : name + ': ' + e.message) + '\n');
      }
    }
    return { inputs, failed };
  }

  /** Let the event loop run so that Ctrl-C can arrive during a long computation. */
  function breathe(ctx) {
    return new Promise((resolve, reject) => setTimeout(() => (ctx.aborted() ? reject(new K.Interrupt()) : resolve()), 0));
  }

  /** Buffered stdout: avoids one write per line when output goes to a file. */
  class Sink {
    constructor(ctx) { this.ctx = ctx; this.buf = ''; }
    write(s) { this.buf += s; if (this.buf.length > 65536) this.flush(); }
    line(s) { this.write(s + '\n'); }
    flush() { if (this.buf) { this.ctx.out(this.buf); this.buf = ''; } }
  }

  /** Is the locale the byte-order "C" locale? (LC_ALL, then LC_COLLATE, then LANG) */
  function cLocale(env) {
    const loc = env.LC_ALL || env.LC_COLLATE || env.LANG || 'C';
    return loc === 'C' || loc === 'POSIX';
  }
  const byteCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  let enCollator = null;
  /** String comparison as strcoll() does it: code point order in C, dictionary-like order in en_US.UTF-8. */
  function collation(env) {
    if (cLocale(env) || typeof Intl === 'undefined') return byteCompare;
    enCollator = enCollator || new Intl.Collator('en-US');
    return (a, b) => enCollator.compare(a, b) || byteCompare(a, b);
  }

  /** Parse a non-negative decimal integer option value; null when malformed. */
  function parseCount(s) { return /^\d+$/.test(String(s)) ? parseInt(s, 10) : null; }

  /* ------------------------------------------------------ C-style formatting */
  function trimZeros(s) { return s.indexOf('.') < 0 ? s : s.replace(/\.?0+$/, ''); }
  function cExp(x, prec, upper) {
    let s = x.toExponential(prec).replace(/e([+-])(\d)$/, 'e$10$2');
    return upper ? s.toUpperCase() : s;
  }
  /** printf("%g") */
  function cG(x, prec, alt, upper) {
    if (!isFinite(x)) return cNonFinite(x, upper);
    const p = prec == null ? 6 : prec === 0 ? 1 : prec;
    if (x === 0) return alt ? (0).toFixed(p - 1) : '0';
    const exp = parseInt(x.toExponential(p - 1).split('e')[1], 10);
    if (exp < -4 || exp >= p) {
      const parts = cExp(x, p - 1, upper).split(upper ? 'E' : 'e');
      return (alt ? parts[0] : trimZeros(parts[0])) + (upper ? 'E' : 'e') + parts[1];
    }
    const fixed = x.toFixed(Math.max(0, p - 1 - exp));
    return alt ? fixed : trimZeros(fixed);
  }
  function cNonFinite(x, upper) {
    const s = isNaN(x) ? 'nan' : x < 0 ? '-inf' : 'inf';
    return upper ? s.toUpperCase() : s;
  }
  /** Exact decimal digits of an integral double (JavaScript switches to exponents at 1e21). */
  function integerDigits(x) { return Math.abs(x) < 1e21 ? String(x) : BigInt(x).toString(); }

  /**
   * Format one printf conversion. `conv` is the conversion letter, `arg` a
   * number for numeric conversions or a string for %s / %c.
   */
  function cFormat(flags, width, prec, conv, arg) {
    let s; let numeric = true;
    switch (conv) {
      case 'd': case 'i': {
        if (!isFinite(arg)) { s = cNonFinite(arg); break; }
        const v = Math.trunc(arg);
        s = integerDigits(Math.abs(v));
        if (prec != null) s = s.padStart(prec, '0');
        s = (v < 0 || Object.is(v, -0) && arg < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + s;
        break;
      }
      case 'o': case 'x': case 'X': case 'u': {
        let v = BigInt(Math.trunc(isFinite(arg) ? arg : 0));
        if (v < 0n) v += 1n << 64n;
        s = v.toString(conv === 'o' ? 8 : conv === 'u' ? 10 : 16);
        if (conv === 'X') s = s.toUpperCase();
        if (prec != null) s = s.padStart(prec, '0');
        if (flags.includes('#') && v !== 0n) s = (conv === 'o' ? '0' : conv === 'x' ? '0x' : conv === 'X' ? '0X' : '') + s;
        break;
      }
      case 'f': case 'F': s = isFinite(arg) ? arg.toFixed(prec == null ? 6 : Math.min(prec, 100)) : cNonFinite(arg, conv === 'F'); break;
      case 'e': case 'E': s = isFinite(arg) ? cExp(arg, prec == null ? 6 : Math.min(prec, 100), conv === 'E') : cNonFinite(arg, conv === 'E'); break;
      case 'g': case 'G': s = cG(arg, prec, flags.includes('#'), conv === 'G'); break;
      case 'c': s = String(arg); numeric = false; break;
      default: s = String(arg); if (prec != null) s = Array.from(s).slice(0, prec).join(''); numeric = false;
    }
    if (numeric && 'fFeEgG'.includes(conv) && isFinite(arg) && !s.startsWith('-')) {
      if (flags.includes('+')) s = '+' + s; else if (flags.includes(' ')) s = ' ' + s;
    }
    const len = Array.from(s).length;
    if (width > len) {
      if (flags.includes('-')) s += ' '.repeat(width - len);
      else if (flags.includes('0') && numeric && isFinite(arg) && !(prec != null && 'dioxXu'.includes(conv))) {
        const sign = /^[-+ ]/.test(s) ? s[0] : ''; const pre = /^0[xX]/.test(s.slice(sign.length)) ? s.slice(sign.length, sign.length + 2) : '';
        s = sign + pre + '0'.repeat(width - len) + s.slice(sign.length + pre.length);
      } else s = ' '.repeat(width - len) + s;
    }
    return s;
  }
  const CONV_RE = /^%([-+ 0#']*)(\*|\d+)?(?:\.(\*|\d*))?(?:hh|h|ll|l|L|q|j|z|t)?([a-zA-Z%])/;

  /* ============================================================ documentation
   * Each tool is declared once with define(); --help, --version and the man
   * page body are all generated from that declaration.
   */
  const gnuVersion = (pkg, version, year, authors) => (name) =>
    name + ' (' + pkg + ') ' + version + '\nCopyright (C) ' + year + ' Free Software Foundation, Inc.\n' +
    'License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\n' +
    'This is free software: you are free to change and redistribute it.\n' +
    'There is NO WARRANTY, to the extent permitted by law.\n\nWritten by ' + authors + '.\n';
  const coreutils = (authors) => gnuVersion('GNU coreutils', '9.7', 2025, authors);
  const UTIL_LINUX = '2.41.2';
  const utilLinux = (name) => name + ' from util-linux ' + UTIL_LINUX + '\n';

  /** Format [flags, description] pairs as aligned option lines; a bare string is a section heading. */
  function optionLines(opts, indent) {
    const width = Math.max.apply(null, opts.filter((o) => typeof o !== 'string').map((o) => o[0].length)) + 2;
    return opts.map((o) => {
      if (typeof o === 'string') return '\n' + o;
      const text = o[1].split('\n');
      return indent + (o[0].padEnd(width) + text[0]).trimEnd() + text.slice(1).map((l) => '\n' + indent + ' '.repeat(width + 2) + l).join('');
    }).join('\n') + '\n';
  }

  function helpText(d, name) {
    if (d.help) return typeof d.help === 'function' ? d.help(name) : d.help;
    if (d.style === 'util-linux') {
      return '\nUsage:\n' + d.usage.map((u) => ' ' + (name + ' ' + u).trim() + '\n').join('') + '\n' + d.desc + '\n\nOptions:\n' +
        optionLines((d.opts || []).concat([[' -h, --help', 'display this help'], [' -V, --version', 'display version']]), '') +
        '\nFor more details see ' + name + '(' + (d.section || 1) + ').\n';
    }
    let s = 'Usage: ' + d.usage.map((u, i) => (i ? '  or:  ' : '') + (name + ' ' + u).trim()).join('\n') + '\n' + d.desc + '\n\n';
    s += optionLines((d.opts || []).concat([['    --help', 'display this help and exit'], ['    --version', 'output version information and exit']]), '  ');
    if (d.notes) s += '\n' + d.notes + '\n';
    if (d.pkg === 'coreutils') {
      s += '\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nFull documentation <https://www.gnu.org/software/coreutils/' + name +
        '>\nor available locally via: info \'(coreutils) ' + name + ' invocation\'\n';
    }
    return s;
  }

  function manBody(d) {
    const indent = (text, n) => text.split('\n').map((l) => (l ? ' '.repeat(n) + l : '')).join('\n');
    let s = 'DESCRIPTION\n' + indent(d.desc + (d.notes ? '\n\n' + d.notes : ''), 7) + '\n';
    if (d.opts && d.opts.length) {
      s += '\nOPTIONS\n' + d.opts.map((o) => (typeof o === 'string' ? '   ' + o
        : indent(o[0].trim(), 7) + '\n' + indent(o[1].replace(/\n\s*/g, ' '), 14))).join('\n\n') + '\n';
    }
    if (d.exit) s += '\nEXIT STATUS\n' + indent(d.exit, 7) + '\n';
    if (d.examples) s += '\nEXAMPLES\n' + d.examples.map((e) => indent(e[0], 7) + '\n' + indent(e[1], 14)).join('\n\n') + '\n';
    return s;
  }

  /**
   * Register a tool.
   *   usage: argument synopsis lines; desc: what it does; opts: [[flags, text]] (or raw help);
   *   notes: extra help paragraph; examples: [[command, explanation]]; version: (name) => text;
   *   run(ctx, d): the implementation.
   */
  function define(d) {
    d.usage = d.usage || ['[OPTION]... [FILE]...'];
    K.cmd.register({
      name: d.name, aliases: d.aliases || [], path: d.path, pkg: d.pkg, section: d.section,
      summary: d.summary, synopsis: d.synopsis || (d.name + ' ' + d.usage[0]).trim(),
      man: () => manBody(d),
      run: (ctx) => d.run(ctx, d),
    });
  }

  /** "<tool>: <message>" plus the GNU "Try --help" hint; returns the exit status. */
  function usageError(ctx, msg, status) {
    ctx.err(ctx.name + ': ' + msg + "\nTry '" + ctx.name + " --help' for more information.\n");
    return status == null ? 1 : status;
  }

  /**
   * Parse options for a tool declared with define(). --help and --version are
   * handled here. Returns the K.getopt result, or an exit status (a number)
   * when the tool has nothing more to do.
   */
  function parseArgs(ctx, d, spec, args) {
    const g = K.getopt(args || ctx.args, Object.assign({}, spec, { long: (spec.long || []).concat(['help', 'version']) }));
    if (g.err) return d.badOption ? d.badOption(ctx, g.err) : usageError(ctx, g.err, d.usageStatus);
    if (g.opts.help) { ctx.out(helpText(d, ctx.name)); return 0; }
    if (g.opts.version) { ctx.out(d.version(ctx.name)); return 0; }
    return g;
  }

  /* ====================================================== regular expressions
   * POSIX basic/extended regular expressions (plus the GNU extensions) are
   * translated to JavaScript RegExp source. POSIX wants the leftmost-longest
   * match while JavaScript takes the first alternative that works, so
   * top-level alternatives are compiled separately and the longest wins.
   */
  class RegexError extends Error {}

  const WORD = '\\p{L}\\p{N}_';
  const RE_CLASSES = {
    alpha: '\\p{L}', digit: '0-9', alnum: '\\p{L}\\p{N}', upper: '\\p{Lu}', lower: '\\p{Ll}', space: ' \\t\\n\\r\\f\\v',
    blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', print: ' -~\\u00a0-\\uffff', graph: '!-~\\u00a1-\\uffff', cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f',
  };
  const RE_GNU = {
    '<': '(?<![' + WORD + '])(?=[' + WORD + '])', '>': '(?<=[' + WORD + '])(?![' + WORD + '])',
    b: '(?:(?<=[' + WORD + '])(?![' + WORD + '])|(?<![' + WORD + '])(?=[' + WORD + ']))',
    B: '(?:(?<=[' + WORD + '])(?=[' + WORD + '])|(?<![' + WORD + '])(?![' + WORD + ']))',
    w: '[' + WORD + ']', W: '[^' + WORD + ']', s: '\\s', S: '\\S', '`': '(?<![\\s\\S])', "'": '(?![\\s\\S])',
  };
  const RE_CTRL = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', a: '\x07' };
  const escLiteral = (ch) => (/[\\^$.*+?()[\]{}|\/]/.test(ch) ? '\\' + ch : ch);
  const escInClass = (ch) => (/[\\\][^-]/.test(ch) ? '\\' + ch : ch);

  /** Decode a backslash escape that names a character (\n, \t, \x41, \101). Returns {ch, len} or null. */
  function charEscape(pat, i, octal) {
    const c = pat[i + 1];
    if (RE_CTRL[c] != null) return { ch: RE_CTRL[c], len: 2 };
    let m;
    if (c === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(pat.slice(i + 2)))) return { ch: String.fromCharCode(parseInt(m[0], 16)), len: 2 + m[0].length };
    if (octal && (m = /^[0-7]{1,3}/.exec(pat.slice(i + 1)))) return { ch: String.fromCharCode(parseInt(m[0], 8)), len: 1 + m[0].length };
    return null;
  }

  /** Translate the bracket expression starting at pat[i] ('['). Returns {src, end}. */
  function bracketToJs(pat, i, awk) {
    const unmatched = () => new RegexError('Unmatched [, [^, [:, [., or [=');
    let j = i + 1; let body = '';
    const negate = pat[j] === '^';
    if (negate) j++;
    const first = j;
    for (;;) {
      if (j >= pat.length) throw unmatched();
      const c = pat[j];
      if (c === ']' && j > first) break;
      if (c === '[' && /[:.=]/.test(pat[j + 1] || '')) {
        const kind = pat[j + 1]; const close = pat.indexOf(kind + ']', j + 2);
        if (close < 0) throw unmatched();
        const name = pat.slice(j + 2, close);
        if (kind === ':') {
          if (!RE_CLASSES[name]) throw new RegexError('Invalid character class name');
          body += RE_CLASSES[name];
        } else body += Array.from(name).map(escInClass).join('');
        j = close + 2;
      } else if (c === '\\' && awk && j + 1 < pat.length) {
        const e = charEscape(pat, j, true) || { ch: pat[j + 1], len: 2 };
        body += escInClass(e.ch); j += e.len;
      } else if (c === '-' && j > first && pat[j + 1] !== ']') { body += '-'; j++; }
      else { body += escInClass(c); j++; }
    }
    return { src: '[' + (negate ? '^' : '') + body + ']', end: j + 1 };
  }

  /**
   * Translate a POSIX regular expression to JavaScript source, one string per
   * top-level alternative.
   *   mode: 'bre' | 'ere' | 'awk' (ERE with awk's escapes)
   *   o.escapes: also decode \n \t \xHH (sed);  o.warn(msg): receives GNU grep style warnings
   */
  function posixToJs(pat, mode, o) {
    o = o || {};
    const ere = mode !== 'bre'; const awk = mode === 'awk';
    const alts = []; let out = ''; let i = 0;
    const stack = [];        // offsets in `out` where the open groups start
    let groups = 0; let groupsBefore = 0;
    let atomStart = -1;      // offset of the atom a quantifier applies to (-1: none)
    let quantified = false;  // that atom already has a quantifier
    let branchStart = true;  // at the start of the expression, a group or an alternative
    const atom = (s) => { atomStart = out.length; out += s; quantified = false; branchStart = false; };
    const quantify = (s) => {
      if (quantified) out = out.slice(0, atomStart) + '(?:' + out.slice(atomStart) + ')';
      out += s; quantified = true;
    };
    const open = () => { stack.push(out.length); out += '('; groups++; atomStart = -1; branchStart = true; };
    const close = () => { atomStart = stack.pop(); out += ')'; quantified = false; branchStart = false; };
    const alternate = () => {
      if (stack.length) out += '|';
      else {
        // keep group numbers stable across separately compiled alternatives
        alts.push((groupsBefore ? '(?:' + '()'.repeat(groupsBefore) + '){0}' : '') + out);
        out = ''; groupsBefore = groups;
      }
      atomStart = -1; branchStart = true;
    };
    const interval = (closer) => {
      const j = pat.indexOf(closer, i);
      const m = j < 0 ? null : /^(\d*)(,(\d*))?$/.exec(pat.slice(i, j));
      if (!m || (m[1] === '' && !m[3])) return null;
      i = j + closer.length;
      return '{' + (m[1] || '0') + (m[2] ? ',' + m[3] : '') + '}';
    };
    const repeat = (ch) => {
      if (atomStart >= 0) quantify(ch);
      else if (ere && o.warn) o.warn(ch + ' at start of expression');   // GNU grep -E ignores the operator
      else atom(escLiteral(ch));
    };

    while (i < pat.length) {
      const c = pat[i];
      if (c === '\\') {
        if (i + 1 >= pat.length) throw new RegexError('Trailing backslash');
        const n = pat[i + 1];
        if (!ere && n === '(') { i += 2; open(); continue; }
        if (!ere && n === ')') { if (!stack.length) throw new RegexError('Unmatched ) or \\)'); i += 2; close(); continue; }
        if (!ere && n === '|') { i += 2; alternate(); continue; }
        if (!ere && n === '{') {
          i += 2;
          if (pat.indexOf('\\}', i) < 0) throw new RegexError('Unmatched \\{');
          const iv = interval('\\}');
          if (iv == null) throw new RegexError('Invalid content of \\{\\}');
          if (atomStart < 0) throw new RegexError('Invalid preceding regular expression');
          quantify(iv); continue;
        }
        if (!ere && (n === '+' || n === '?')) { i += 2; if (atomStart >= 0) quantify(n); else atom('\\' + n); continue; }
        if (/[1-9]/.test(n) && !awk) {
          if (+n > groups) throw new RegexError('Invalid back reference');
          i += 2; atom('(?:\\' + n + ')'); continue;
        }
        if (awk && n === 'y') { i += 2; out += RE_GNU.b; atomStart = -1; continue; }
        if (RE_GNU[n] && !(awk && n === 'b')) {
          i += 2;
          if (/[wWsS]/.test(n)) atom(RE_GNU[n]); else { out += RE_GNU[n]; atomStart = -1; branchStart = false; }
          continue;
        }
        const e = (awk || o.escapes) && charEscape(pat, i, awk);
        if (e) { i += e.len; atom(escLiteral(e.ch)); continue; }
        if (awk && n === 'b') { i += 2; atom('\\x08'); continue; }
        i += 2; atom(escLiteral(n)); continue;
      }
      i++;
      if (c === '[') { const b = bracketToJs(pat, i - 1, awk); i = b.end; atom(b.src); }
      else if (c === '.') atom('.');
      else if (c === '*') repeat('*');
      else if (c === '^') {
        if (ere || branchStart) { out += '^'; atomStart = -1; } else atom('\\^');
      } else if (c === '$') {
        const rest = pat.slice(i);
        if (ere || rest === '' || rest.startsWith('\\)') || rest.startsWith('\\|')) { out += '$'; atomStart = -1; branchStart = false; } else atom('\\$');
      } else if (ere && c === '(') open();
      else if (ere && c === ')') { if (stack.length) close(); else atom('\\)'); }
      else if (ere && c === '|') alternate();
      else if (ere && (c === '+' || c === '?')) repeat(c);
      else if (ere && c === '{') {
        const iv = atomStart >= 0 ? interval('}') : null;
        if (iv) quantify(iv); else atom('\\{');
      } else atom(escLiteral(c));
    }
    if (stack.length) throw new RegexError('Unmatched ( or \\(');
    alternate();
    return alts;
  }

  function jsRegexError(e) {
    const m = String(e && e.message);
    if (/character class/i.test(m)) return 'Invalid range end';
    if (/numbers out of order/i.test(m)) return 'Invalid content of \\{\\}';
    if (/nothing to repeat/i.test(m)) return 'Invalid preceding regular expression';
    return 'Invalid regular expression';
  }

  /** A compiled pattern: one or more RegExps of which the leftmost, then longest, match wins. */
  class Pattern {
    constructor(regexps) { this.res = regexps; }
    /** First match at or after `from` (a RegExp exec result), or null. */
    exec(s, from) {
      let best = null;
      for (const re of this.res) {
        re.lastIndex = from || 0;
        const m = re.exec(s);
        if (m && (!best || m.index < best.index || (m.index === best.index && m[0].length > best[0].length))) best = m;
      }
      return best;
    }
    test(s) { return this.exec(s, 0) !== null; }
    /**
     * Every match the way POSIX tools iterate: an empty match is not allowed
     * right after the previous match.
     */
    all(s) {
      const found = []; let pos = 0; let lastEnd = -1;
      while (pos <= s.length) {
        const m = this.exec(s, pos);
        if (!m) break;
        const end = m.index + m[0].length;
        if (m[0] === '' && m.index === lastEnd) { pos = m.index + 1; continue; }
        found.push(m);
        lastEnd = end;
        pos = m[0] === '' ? end + 1 : end;
      }
      return found;
    }
  }

  /**
   * Compile a POSIX pattern. o: { icase, multiline, escapes, warn, wrap(src) -> src }.
   * Throws RegexError with the message GNU tools print.
   */
  function compilePosix(pat, mode, o) {
    o = o || {};
    let sources = posixToJs(pat, mode, o);
    if (o.wrap) sources = sources.map(o.wrap);
    const flags = 'gsu' + (o.icase ? 'i' : '') + (o.multiline ? 'm' : '');
    try { return new Pattern(sources.map((s) => new RegExp(s, flags))); }
    catch (e) { throw new RegexError(jsRegexError(e)); }
  }

  const PCRE_CLASSES = {
    alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', space: '\\s', blank: ' \\t', word: '\\w',
    punct: '!-\\/:-@\\[-`{-~', print: ' -~', graph: '!-~', cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f',
  };
  /** Translate the commonly used Perl-only syntax (grep -P) to JavaScript. Returns {src, flags}. */
  function pcreToJs(pat) {
    let flags = ''; let out = '';
    pat = pat.replace(/^\(\?([imsx]+)\)/, (m, f) => { flags = f.replace(/[^ims]/g, ''); return ''; });
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i];
      if (c === '\\' && i + 1 < pat.length) {
        const n = pat[++i];
        if (n === 'K') out = '(?<=(?:' + out + '))';
        else if (n === 'A') out += '^';
        else if (n === 'z' || n === 'Z') out += '$';
        else if (n === 'h') out += '[ \\t]';
        else if (n === 'Q') {
          const e = pat.indexOf('\\E', i + 1); const end = e < 0 ? pat.length : e;
          out += U.escapeRe(pat.slice(i + 1, end)); i = end + 1;
        } else out += '\\' + n;
      } else if (c === '[') {
        let j = i + 1; let cls = '[';
        if (pat[j] === '^') { cls += '^'; j++; }
        if (pat[j] === ']') { cls += '\\]'; j++; }
        while (j < pat.length && pat[j] !== ']') {
          const m = /^\[:(\w+):\]/.exec(pat.slice(j));
          if (m && PCRE_CLASSES[m[1]]) { cls += PCRE_CLASSES[m[1]]; j += m[0].length; }
          else if (pat[j] === '\\' && j + 1 < pat.length) { cls += pat.slice(j, j + 2); j += 2; }
          else cls += pat[j++];
        }
        out += cls + (j < pat.length ? ']' : '');
        i = j;
      } else if (c === '(' && pat.startsWith('(?P<', i)) { out += '(?<'; i += 3; }
      else if (c === '(' && pat.startsWith('(?>', i)) { out += '(?:'; i += 2; }
      else if (c === '+' && /[*+?}]/.test(pat[i - 1] || '') && pat[i - 2] !== '\\') { /* possessive quantifier: plain greedy is close enough */ }
      else out += c;
    }
    return { src: out, flags };
  }

  /* =================================================================== grep */
  const GREP_HELP = [
    'Usage: grep [OPTION]... PATTERNS [FILE]...',
    'Search for PATTERNS in each FILE.',
    "Example: grep -i 'hello world' menu.h main.c",
    'PATTERNS can contain multiple patterns separated by newlines.',
    '',
    'Pattern selection and interpretation:',
    '  -E, --extended-regexp     PATTERNS are extended regular expressions',
    '  -F, --fixed-strings       PATTERNS are strings',
    '  -G, --basic-regexp        PATTERNS are basic regular expressions',
    '  -P, --perl-regexp         PATTERNS are Perl regular expressions',
    '  -e, --regexp=PATTERNS     use PATTERNS for matching',
    '  -f, --file=FILE           take PATTERNS from FILE',
    '  -i, --ignore-case         ignore case distinctions in patterns and data',
    '      --no-ignore-case      do not ignore case distinctions (default)',
    '  -w, --word-regexp         match only whole words',
    '  -x, --line-regexp         match only whole lines',
    '',
    'Miscellaneous:',
    '  -s, --no-messages         suppress error messages',
    '  -v, --invert-match        select non-matching lines',
    '  -V, --version             display version information and exit',
    '      --help                display this help text and exit',
    '',
    'Output control:',
    '  -m, --max-count=NUM       stop after NUM selected lines',
    '  -b, --byte-offset         print the byte offset with output lines',
    '  -n, --line-number         print line number with output lines',
    '  -H, --with-filename       print file name with output lines',
    '  -h, --no-filename         suppress the file name prefix on output',
    '      --label=LABEL         use LABEL as the standard input file name prefix',
    '  -o, --only-matching       show only nonempty parts of lines that match',
    '  -q, --quiet, --silent     suppress all normal output',
    '  -a, --text                equivalent to --binary-files=text',
    '  -r, --recursive           like --directories=recurse',
    '  -R, --dereference-recursive  likewise, but follow all symlinks',
    '      --include=GLOB        search only files that match GLOB (a file pattern)',
    '      --exclude=GLOB        skip files that match GLOB',
    '      --exclude-dir=GLOB    skip directories that match GLOB',
    '  -L, --files-without-match  print only names of FILEs with no selected lines',
    '  -l, --files-with-matches  print only names of FILEs with selected lines',
    '  -c, --count               print only a count of selected lines per FILE',
    '',
    'Context control:',
    '  -B, --before-context=NUM  print NUM lines of leading context',
    '  -A, --after-context=NUM   print NUM lines of trailing context',
    '  -C, --context=NUM         print NUM lines of output context',
    '  -NUM                      same as --context=NUM',
    '      --no-group-separator  do not print separator for matches with context',
    '      --color[=WHEN],',
    '      --colour[=WHEN]       use markers to highlight the matching strings;',
    "                            WHEN is 'always', 'never', or 'auto'",
    '',
    "When FILE is '-', read standard input.  With no FILE, read '.' if",
    "recursive, '-' otherwise.  With fewer than two FILEs, assume -h.",
    'Exit status is 0 if any line is selected, 1 otherwise;',
    'if any error occurs and -q is not given, the exit status is 2.',
    '',
    'Report bugs to: bug-grep@gnu.org',
    'GNU grep home page: <https://www.gnu.org/software/grep/>',
    'General help using GNU software: <https://www.gnu.org/gethelp/>',
  ].join('\n') + '\n';

  const GREP_LONG = {
    'extended-regexp': 'E', 'fixed-strings': 'F', 'basic-regexp': 'G', 'perl-regexp': 'P', regexp: 'e', file: 'f', 'ignore-case': 'i',
    'word-regexp': 'w', 'line-regexp': 'x', 'no-messages': 's', 'invert-match': 'v', 'max-count': 'm', 'byte-offset': 'b',
    'line-number': 'n', 'with-filename': 'H', 'no-filename': 'h', 'only-matching': 'o', quiet: 'q', silent: 'q', text: 'a',
    recursive: 'r', 'dereference-recursive': 'R', 'files-without-match': 'L', 'files-with-matches': 'l', count: 'c',
    'before-context': 'B', 'after-context': 'A', context: 'C', colour: 'color', V: 'version',
  };
  const GREP_VALUE_OPTS = /^-[^-]*[efmABC]$|^--(regexp|file|max-count|after-context|before-context|context|label|include|exclude|exclude-dir)$/;

  /** Build the line matcher for grep from its patterns. Returns a Pattern. */
  function grepMatcher(patterns, mode, o, warn) {
    const W = mode === 'P' ? '\\w' : '[' + WORD + ']';
    const wrap = (src) => (o.x ? '^(?:' + src + ')$' : o.w ? '(?<!' + W + ')(?:' + src + ')(?!' + W + ')' : src);
    const regexps = [];
    for (const p of patterns) {
      if (mode === 'F') regexps.push(new RegExp(wrap(U.escapeRe(p)), 'gsu' + (o.i ? 'i' : '')));
      else if (mode === 'P') {
        const t = pcreToJs(p);
        const flags = 'g' + (o.i || t.flags.includes('i') ? 'i' : '') + (t.flags.includes('s') ? 's' : '') + (t.flags.includes('m') ? 'm' : '');
        try { regexps.push(new RegExp(wrap(t.src), flags)); }
        catch (e) {
          const m = String(e.message);
          throw new RegexError(/Unterminated group/.test(m) ? 'missing closing parenthesis' : /Unmatched '\)'/.test(m) ? 'unmatched closing parenthesis'
            : /Nothing to repeat/.test(m) ? 'quantifier does not follow a repeatable item' : /character class/.test(m) ? 'missing terminating ] for character class'
              : 'unrecognized character follows \\');
        }
      } else regexps.push.apply(regexps, compilePosix(p, mode === 'E' ? 'ere' : 'bre', { icase: o.i, warn, wrap }).res);
    }
    return new Pattern(regexps);
  }

  define({
    name: 'grep', aliases: ['egrep', 'fgrep'], pkg: 'grep',
    summary: 'print lines that match patterns',
    usage: ['[OPTION]... PATTERNS [FILE]...'],
    desc: 'grep searches for PATTERNS in each FILE and prints each line that matches a pattern. PATTERNS is one or\nmore patterns separated by newline characters. With no FILE, grep searches standard input, or the\nworking directory when -r is given.\n\n' +
      'By default a pattern is a basic regular expression (BRE): . matches any character, * repeats the\nprevious item, ^ and $ anchor to the start and end of the line, [abc] matches one of a set, and\n\\(...\\), \\{n,m\\}, \\+, \\? and \\| need a backslash. With -E (or egrep) those operators are written\nwithout the backslash. -F (or fgrep) searches for fixed strings and -P accepts Perl syntax such as\n\\d, \\K and lookaround.',
    opts: [
      ['-E, --extended-regexp', 'Interpret PATTERNS as extended regular expressions (ERE).'],
      ['-F, --fixed-strings', 'Interpret PATTERNS as fixed strings, not regular expressions.'],
      ['-P, --perl-regexp', 'Interpret PATTERNS as Perl-compatible regular expressions (PCRE).'],
      ['-e PATTERNS, --regexp=PATTERNS', 'Use PATTERNS as the patterns. May be repeated; also protects a pattern beginning with "-".'],
      ['-f FILE, --file=FILE', 'Obtain patterns from FILE, one per line.'],
      ['-i, --ignore-case', 'Ignore case distinctions in patterns and input data.'],
      ['-v, --invert-match', 'Select non-matching lines.'],
      ['-w, --word-regexp', 'Select only lines containing matches that form whole words.'],
      ['-x, --line-regexp', 'Select only matches that exactly match the whole line.'],
      ['-c, --count', 'Print a count of matching lines for each input file instead of the lines.'],
      ['--color[=WHEN]', 'Highlight matches, file names and line numbers. WHEN is never, always or auto.'],
      ['-L, --files-without-match', 'Print only the names of files with no selected lines.'],
      ['-l, --files-with-matches', 'Print only the names of files with selected lines.'],
      ['-m NUM, --max-count=NUM', 'Stop reading a file after NUM selected lines.'],
      ['-o, --only-matching', 'Print only the matched (non-empty) parts of a matching line, each on its own line.'],
      ['-q, --quiet, --silent', 'Write nothing; exit with status 0 as soon as a match is found.'],
      ['-s, --no-messages', 'Suppress error messages about nonexistent or unreadable files.'],
      ['-H, --with-filename', 'Print the file name for each match (the default with more than one file).'],
      ['-h, --no-filename', 'Suppress the file name prefix on output.'],
      ['-n, --line-number', 'Prefix each line of output with its 1-based line number.'],
      ['-A NUM, -B NUM, -C NUM', 'Print NUM lines of context after, before, or around each match. Groups are separated by "--".'],
      ['-a, --text', 'Process a binary file as if it were text.'],
      ['-r, --recursive', 'Read all files under each directory, following symbolic links only if they are on the command line.'],
      ['-R, --dereference-recursive', 'Like -r, but follow all symbolic links.'],
      ['--include=GLOB, --exclude=GLOB, --exclude-dir=GLOB', 'Limit a recursive search to (or keep it away from) files or directories whose name matches GLOB.'],
    ],
    exit: '0 if a line is selected, 1 if no lines were selected, 2 if an error occurred.',
    examples: [
      ['grep -n root /etc/passwd', 'Show the lines of /etc/passwd that contain "root", with line numbers.'],
      ["grep -E -o '[0-9]+/(tcp|udp)' /etc/services | sort -u", 'Extract only the port/protocol pairs from the services database.'],
      ['grep -ril password /etc 2>/dev/null', 'List the files under /etc that mention "password" in any letter case.'],
    ],
    version: (name) => name + ' (GNU grep) 3.12\nCopyright (C) 2025 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\n' +
      'This is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\n' +
      'Written by Mike Haertel and others; see\n<https://git.savannah.gnu.org/cgit/grep.git/tree/AUTHORS>.\n\ngrep -P uses PCRE2 10.46 2025-08-27\n',
    help: () => GREP_HELP,
    usageStatus: 2,
    badOption(ctx, msg) {
      ctx.err(ctx.name + ': ' + msg + '\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry \'grep --help\' for more information.\n');
      return 2;
    },
    async run(ctx, d) {
      // -NUM is shorthand for --context=NUM
      const args = [];
      for (let i = 0; i < ctx.args.length; i++) {
        const a = ctx.args[i];
        if (a === '--') { args.push.apply(args, ctx.args.slice(i)); break; }
        if (/^-\d+$/.test(a)) args.push('-C' + a.slice(1));
        else { args.push(a); if (GREP_VALUE_OPTS.test(a) && i + 1 < ctx.args.length) args.push(ctx.args[++i]); }
      }
      const g = parseArgs(ctx, d, {
        short: 'EFGPe:f:iywxsvVm:bnHhoqarRLlcB:A:C:',
        long: Object.keys(GREP_LONG).filter((k) => k !== 'V').map((k) => (/^[efmABC]$/.test(GREP_LONG[k]) ? k + '=' : k === 'colour' ? k + '=?' : k))
          .concat(['color=?', 'no-ignore-case', 'label=', 'include=', 'exclude=', 'exclude-dir=', 'no-group-separator', 'line-buffered']),
        alias: Object.assign({ y: 'i' }, GREP_LONG),
      }, args);
      if (typeof g === 'number') return g;
      const o = g.opts;
      if (o['no-ignore-case']) o.i = false;
      const rest = g.rest.slice();
      const fail = (msg) => { ctx.err(ctx.name + ': ' + msg + '\n'); return 2; };

      let color = false;
      if (o.color != null) {
        const when = o.color === true ? 'auto' : o.color;
        if (/^(always|yes|force)$/.test(when)) color = true;
        else if (/^(auto|tty|if-tty)$/.test(when)) color = ctx.isTTY;
        else if (!/^(never|no|none)$/.test(when)) { ctx.out(GREP_HELP); return 0; }   // what GNU grep really does
      }
      const context = { A: 0, B: 0 };
      for (const k of ['C', 'A', 'B']) {
        if (o[k] == null) continue;
        const n = parseCount(o[k]);
        if (n == null) return fail(o[k] + ': invalid context length argument');
        if (k === 'C') context.A = context.B = n; else context[k] = n;
      }
      let maxCount = Infinity;
      if (o.m != null) { maxCount = /^-?\d+$/.test(o.m) ? parseInt(o.m, 10) : NaN; if (isNaN(maxCount)) return fail('invalid max count'); if (maxCount < 0) maxCount = Infinity; }

      let patterns = [];
      for (const p of g.all.e || []) patterns.push.apply(patterns, p.split('\n'));
      for (const f of g.all.f || []) {
        try { patterns.push.apply(patterns, splitLines(await readOperand(ctx, f))); }
        catch (e) { if (!isFsError(e)) throw e; return fail(f + ': ' + e.message); }
      }
      if (!g.all.e && !g.all.f) {
        if (!rest.length) { ctx.err('Usage: grep [OPTION]... PATTERNS [FILE]...\nTry \'grep --help\' for more information.\n'); return 2; }
        patterns = rest.shift().split('\n');
      }
      const mode = o.P ? 'P' : o.F ? 'F' : o.E ? 'E' : o.G ? 'G' : ctx.name === 'egrep' ? 'E' : ctx.name === 'fgrep' ? 'F' : 'G';
      let matcher;
      try { matcher = grepMatcher(patterns, mode, o, (w) => ctx.err(ctx.name + ': warning: ' + w + '\n')); }
      catch (e) { if (e instanceof RegexError) return fail(e.message); throw e; }

      const paint = (code) => (color ? (s) => '\x1b[' + code + 'm\x1b[K' + s + '\x1b[m\x1b[K' : (s) => s);
      const C = { match: paint('01;31'), file: paint('35'), num: paint('32'), sep: paint('36') };
      const recursive = !!(o.r || o.R);
      const globs = (list) => (list || []).map((p) => U.globToRe(p));
      const include = globs(g.all.include); const exclude = globs(g.all.exclude); const excludeDir = globs(g.all['exclude-dir']);
      const base = (p) => K.VFS.basename(p);
      const wanted = (p) => !exclude.some((re) => re.test(base(p))) && (!include.length || include.some((re) => re.test(base(p))));
      const out = new Sink(ctx);
      const st = { matched: false, error: false, printed: false, quit: false, showNames: !!o.H };
      const problem = (path, msg) => { st.error = true; if (!o.s) { out.flush(); ctx.err(ctx.name + ': ' + path + ': ' + msg + '\n'); } };
      const useContext = (context.A > 0 || context.B > 0) && !o.o;

      /** Search one file's text, printing as required. */
      const search = (text, label) => {
        const lines = splitLines(text);
        const binary = !o.a && text.indexOf('\0') >= 0;
        const names = st.showNames && !o.h;
        const prefix = (n, offset, sep) => (names ? C.file(label) + C.sep(sep) : '') + (o.n ? C.num(n) + C.sep(sep) : '') + (o.b ? C.num(offset) + C.sep(sep) : '');
        const listing = o.c || o.l || o.L || o.q;
        let count = 0; let lastShown = -1; let after = 0; let offset = 0; const offsets = [];
        for (let i = 0; i < lines.length && count < maxCount; i++) {
          const line = lines[i];
          if (o.b) { offsets[i] = offset; offset += U.byteLen(line) + 1; }
          if (matcher.test(line) === !!o.v) {
            if (after > 0 && !listing && !binary) { out.line(prefix(i + 1, offsets[i], '-') + line); lastShown = i; after--; }
            continue;
          }
          count++; st.matched = true;
          if (o.q) { st.quit = true; return; }
          if (listing) { if (o.l || o.L) break; continue; }
          if (binary) { out.flush(); ctx.err(ctx.name + ': ' + label + ': binary file matches\n'); return; }
          if (useContext) {
            const from = Math.max(lastShown + 1, i - context.B);
            if (st.printed && (lastShown < 0 || from > lastShown + 1) && !o['no-group-separator']) out.line(C.sep('--'));
            for (let k = from; k < i; k++) out.line(prefix(k + 1, offsets[k], '-') + lines[k]);
          }
          if (o.o) {
            if (!o.v) for (const m of matcher.all(line)) {
              if (m[0] !== '') out.line(prefix(i + 1, o.b ? offsets[i] + U.byteLen(line.slice(0, m.index)) : 0, ':') + C.match(m[0]));
            }
          } else {
            let shown = line;
            if (color && !o.v) {
              shown = ''; let pos = 0;
              for (const m of matcher.all(line)) {
                if (m[0] === '') continue;
                shown += line.slice(pos, m.index) + C.match(m[0]); pos = m.index + m[0].length;
              }
              shown += line.slice(pos);
            }
            out.line(prefix(i + 1, offsets[i], ':') + shown);
          }
          st.printed = true; lastShown = i; after = context.A;
        }
        // trailing context once --max-count stopped the search
        for (let i = lastShown + 1; after > 0 && i < lines.length && count >= maxCount && !listing && lastShown >= 0; i++, after--) out.line(prefix(i + 1, offsets[i], '-') + lines[i]);
        if (o.c) out.line((names ? C.file(label) + C.sep(':') : '') + count);
        if ((o.l && count > 0) || (o.L && count === 0)) out.line(C.file(label));
      };

      const searchFile = (path, label) => {
        let text;
        try { text = ctx.fs.read(path); }
        catch (e) { if (!isFsError(e)) throw e; problem(label, e.message); return; }
        search(text, label);
      };
      const walk = (dir, label) => {
        let names;
        try { names = ctx.fs.readdir(dir); }
        catch (e) { if (!isFsError(e)) throw e; problem(label || dir, e.message); return; }
        for (const name of names) {
          if (st.quit) return;
          ctx.checkAbort();
          const path = dir + '/' + name;
          const shown = label === '' ? name : label.endsWith('/') ? label + name : label + '/' + name;
          let info;
          try { info = ctx.fs.lstat(path); if (info.isLink) { if (!o.R) continue; info = ctx.fs.stat(path); } }
          catch (e) { if (!isFsError(e)) throw e; continue; }
          if (info.isDir) { if (!excludeDir.some((re) => re.test(name))) walk(path, shown); }
          else if (info.isFile && wanted(name)) searchFile(path, shown);
        }
      };

      const operands = rest.length ? rest : [recursive ? null : '-'];
      if (operands.length > 1) st.showNames = true;
      for (const f of operands) {
        if (st.quit) break;
        if (f === '-') { search(await stdinText(ctx), o.label || '(standard input)'); continue; }
        if (f === null) { st.showNames = true; walk('.', ''); continue; }
        let info;
        try { info = ctx.fs.stat(f); }
        catch (e) { if (!isFsError(e)) throw e; problem(f, e.message); continue; }
        if (info.isDir) {
          if (!recursive) { problem(f, 'Is a directory'); continue; }
          if (excludeDir.some((re) => re.test(base(f)))) continue;
          const single = st.showNames; st.showNames = true;
          walk(f, f);
          st.showNames = single;
        } else if (wanted(f)) searchFile(f, f);
      }
      out.flush();
      if (st.error && !(o.q && st.matched)) return 2;
      return st.matched ? 0 : 1;
    },
  });

  /* @@INSERT@@ */
})(typeof globalThis !== 'undefined' ? globalThis : this);
