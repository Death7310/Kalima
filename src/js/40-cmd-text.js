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
    if (i + 1 >= pat.length) throw new RegexError('Invalid regular expression');
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
        if (o.c && !o.l && !o.L && !o.q) out.line((names ? C.file(label) + C.sep(':') : '') + count);
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

  /* ============================================================ shared helpers */
  /** `alias` map for K.getopt from [short, long] pairs, so both spellings share one slot. */
  const aliasOf = (pairs) => Object.fromEntries(pairs.map(([s, l]) => [l, s]));
  const sumBytes = (s) => U.byteLen(s);
  const isRegular = (st) => st.isFile;

  /** Parse a numeric option such as `-n 5`; reports the GNU message and returns null when malformed. */
  function numberOption(ctx, value, what, status) {
    const n = parseCount(value);
    if (n == null) { ctx.err(ctx.name + ': ' + value + ': ' + what + '\n'); return null; }
    return n;
  }

  /* ===================================================================== wc */
  const wcWords = (text) => (text.match(/[^ \t\n\r\f\v\u0085\u00a0\u2000-\u200a\u2028\u2029\u3000]+/g) || []).length;
  function wcMaxLine(text) {
    let max = 0;
    for (const line of text.split('\n')) {
      let w = 0;
      for (const ch of line) w = ch === '\t' ? w + 8 - (w % 8) : ch === '\r' || ch === '\f' ? w : w + 1;
      if (w > max) max = w;
    }
    return max;
  }
  function wcCounts(text) {
    let lines = 0;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines++;
    return { lines, words: wcWords(text), chars: Array.from(text).length, bytes: U.byteLen(text), maxlen: wcMaxLine(text) };
  }

  define({
    name: 'wc', pkg: 'coreutils', summary: 'print newline, word, and byte counts for each file',
    usage: ['[OPTION]... [FILE]...', '[OPTION]... --files0-from=F'],
    desc: 'Print newline, word, and byte counts for each FILE, and a total line if more than one FILE is specified. A word is a non-zero-length sequence of printable characters delimited by white space.\nWith no FILE, or when FILE is -, read standard input.',
    opts: [
      ['-c, --bytes', 'print the byte counts'], ['-m, --chars', 'print the character counts'], ['-l, --lines', 'print the newline counts'],
      ['    --files0-from=F', 'read input from the files specified by NUL-terminated names in file F;\nIf F is - then read names from standard input'],
      ['-L, --max-line-length', 'print the maximum display width'], ['-w, --words', 'print the word counts'],
      ['    --total=WHEN', 'when to print a line with total counts;\nWHEN can be: auto, always, only, never'],
    ],
    notes: 'The counts are always printed in this order: newline, word, character, byte, maximum line length.',
    examples: [['wc -l /etc/passwd', 'Count the accounts defined on this system.'], ['grep -c . notes.txt && wc -w notes.txt', 'Compare non-empty lines with the word count.']],
    version: coreutils('Paul Rubin, David MacKenzie, Michael Meskes, and Bruno Haible'),
    async run(ctx, d) {
      const g = parseArgs(ctx, d, { short: 'cmlLw', long: ['bytes', 'chars', 'lines', 'max-line-length', 'words', 'total=', 'files0-from='],
        alias: aliasOf([['c', 'bytes'], ['m', 'chars'], ['l', 'lines'], ['L', 'max-line-length'], ['w', 'words']]) });
      if (typeof g === 'number') return g;
      const o = g.opts;
      const total = o.total || 'auto';
      if (!['auto', 'always', 'only', 'never'].includes(total)) {
        return usageError(ctx, "invalid argument " + q(total) + " for '--total'\nValid arguments are:\n  - " + q('auto') + '\n  - ' + q('always') + '\n  - ' + q('only') + '\n  - ' + q('never'));
      }
      let files = g.rest;
      if (o['files0-from'] != null) {
        if (files.length) return usageError(ctx, 'extra operand ' + q(files[0]) + '\nfile operands cannot be combined with --files0-from');
        try { files = (await readOperand(ctx, o['files0-from'])).split('\0').filter((x, i, a) => x !== '' || i < a.length - 1); }
        catch (e) { if (!isFsError(e)) throw e; ctx.err(ctx.name + ': cannot open ' + q(o['files0-from']) + ' for reading: ' + e.message + '\n'); return 1; }
      }
      let cols = ['lines', 'words', 'chars', 'bytes', 'maxlen'].filter((c) => ({ lines: o.l, words: o.w, chars: o.m, bytes: o.c, maxlen: o.L })[c]);
      if (!cols.length) cols = ['lines', 'words', 'bytes'];
      const operands = files.length ? files : ['-'];

      // GNU sizes the number columns from the file sizes; non-regular input forces width 7
      let width = 1; let regular = 0;
      for (const f of operands) {
        if (f === '-') { width = 7; break; }
        let st;
        try { st = ctx.fs.stat(f); } catch (e) { if (!isFsError(e)) throw e; continue; }
        if (!isRegular(st)) { width = 7; break; }
        regular += st.size;
      }
      if (width === 1) width = String(regular).length;
      if (cols.length === 1 && operands.length === 1 && total !== 'always' && total !== 'only') width = 1;

      const line = (c, label) => cols.map((k) => String(c[k]).padStart(width)).join(' ') + (label != null ? ' ' + label : '') + '\n';
      const sum = { lines: 0, words: 0, chars: 0, bytes: 0, maxlen: 0 };
      let status = 0; let ok = 0;
      for (const f of operands) {
        let text;
        try {
          if (f !== '-' && ctx.fs.stat(f).isDir) {
            ctx.err(ctx.name + ': ' + f + ': Is a directory\n');
            text = '';
            if (total !== 'only') ctx.out(line(wcCounts(text), f));
            status = 1; ok++; continue;
          }
          text = await readOperand(ctx, f);
        } catch (e) { if (!isFsError(e)) throw e; ctx.err(ctx.name + ': ' + f + ': ' + e.message + '\n'); status = 1; continue; }
        const c = wcCounts(text); ok++;
        for (const k of ['lines', 'words', 'chars', 'bytes']) sum[k] += c[k];
        sum.maxlen = Math.max(sum.maxlen, c.maxlen);
        if (total !== 'only') ctx.out(line(c, f === '-' && !files.length ? null : f));
      }
      if (total === 'always' || total === 'only' || (total === 'auto' && operands.length > 1)) ctx.out(line(sum, total === 'only' ? null : 'total'));
      return status;
    },
  });

  /* ==================================================================== uniq */
  define({
    name: 'uniq', pkg: 'coreutils', summary: 'report or omit repeated lines',
    usage: ['[OPTION]... [INPUT [OUTPUT]]'],
    desc: 'Filter adjacent matching lines from INPUT (or standard input), writing to OUTPUT (or standard output).\nWith no options, matching lines are merged to the first occurrence. Only adjacent lines are compared, so sort the input first.',
    opts: [
      ['-c, --count', 'prefix lines by the number of occurrences'], ['-d, --repeated', 'only print duplicate lines, one for each group'],
      ['-D', 'print all duplicate lines'], ['-f, --skip-fields=N', 'avoid comparing the first N fields'],
      ['-i, --ignore-case', 'ignore differences in case when comparing'], ['-s, --skip-chars=N', 'avoid comparing the first N characters'],
      ['-u, --unique', 'only print unique lines'], ['-w, --check-chars=N', 'compare no more than N characters in lines'],
      ['-z, --zero-terminated', 'line delimiter is NUL, not newline'],
    ],
    notes: 'A field is a run of blanks (usually spaces and/or TABs), then non-blank characters. Fields are skipped before chars.',
    examples: [["sort access.log | uniq -c | sort -rn | head", 'Rank the most repeated lines.'], ['sort names.txt | uniq -d', 'Show only the names that occur more than once.']],
    version: coreutils('Richard M. Stallman and David MacKenzie'),
    async run(ctx, d) {
      const g = parseArgs(ctx, d, { short: 'cdDf:is:uw:z', long: ['count', 'repeated', 'all-repeated=?', 'group=?', 'skip-fields=', 'ignore-case', 'skip-chars=', 'unique', 'check-chars=', 'zero-terminated'],
        alias: aliasOf([['c', 'count'], ['d', 'repeated'], ['D', 'all-repeated'], ['f', 'skip-fields'], ['i', 'ignore-case'], ['s', 'skip-chars'], ['u', 'unique'], ['w', 'check-chars'], ['z', 'zero-terminated']]) });
      if (typeof g === 'number') return g;
      const o = g.opts;
      const num = (v, what) => { if (v == null) return 0; const n = parseCount(v); if (n == null) { ctx.err('uniq: ' + v + ': invalid number of ' + what + '\n'); return null; } return n; };
      const skipFields = num(o.f, 'fields to skip'); if (skipFields == null) return 1;
      const skipChars = num(o.s, 'bytes to skip'); if (skipChars == null) return 1;
      const checkChars = o.w == null ? Infinity : num(o.w, 'bytes to compare'); if (checkChars == null) return 1;
      if (g.rest.length > 2) return usageError(ctx, 'extra operand ' + q(g.rest[2]));
      if (o.c && o.D) return usageError(ctx, 'printing all duplicated lines and repeat counts is meaningless');
      let text;
      try { text = await readOperand(ctx, g.rest[0] || '-'); }
      catch (e) { if (!isFsError(e)) throw e; ctx.err('uniq: ' + g.rest[0] + ': ' + e.message + '\n'); return 1; }
      const eol = o.z ? '\0' : '\n';
      let lines = text.split(eol); if (lines[lines.length - 1] === '') lines.pop();
      const key = (l) => {
        let s = l;
        for (let i = 0; i < skipFields; i++) s = s.replace(/^[ \t]*[^ \t]*/, '');
        s = Array.from(s).slice(skipChars, skipChars + checkChars).join('');
        return o.i ? s.toLowerCase() : s;
      };
      const groups = [];
      for (const l of lines) {
        const k = key(l); const last = groups[groups.length - 1];
        if (last && last.key === k) last.n++; else groups.push({ key: k, line: l, n: 1, all: [] });
        groups[groups.length - 1].all.push(l);
      }
      let res = '';
      const method = (opt, valid, what, dflt) => {
        const v = opt === true ? dflt : opt;
        if (!valid.includes(v)) { usageError(ctx, 'invalid argument ' + q(v) + ' for ' + q(what) + '\nValid arguments are:' + valid.map((x) => '\n  - ' + q(x)).join('')); return null; }
        return v;
      };
      const groupMethod = o.group != null ? method(o.group, ['separate', 'prepend', 'append', 'both'].sort((a, b) => 'prepend append separate both'.indexOf(a) - 'prepend append separate both'.indexOf(b)), '--group', 'separate') : null;
      const repeatMethod = o.D != null && o.D !== true ? method(o.D, ['none', 'prepend', 'separate'], '--all-repeated', 'none') : o.D ? 'none' : null;
      if ((o.group != null && groupMethod == null) || (o.D != null && o.D !== true && repeatMethod == null)) return 1;
      if (groupMethod && (o.c || o.d || o.D || o.u)) return usageError(ctx, '--group is mutually exclusive with -c/-d/-D/-u');
      let shown = 0;
      for (const gr of groups) {
        if (groupMethod) {
          if (groupMethod === 'prepend' || (groupMethod === 'both' && !shown) || ((groupMethod === 'separate' || groupMethod === 'both') && shown)) res += eol;
          for (const l of gr.all) res += l + eol;
          if (groupMethod === 'append' || (groupMethod === 'both' && gr === groups[groups.length - 1])) res += eol;
          shown++; continue;
        }
        if (o.d && gr.n < 2) continue;
        if (o.u && gr.n > 1) continue;
        if (repeatMethod) {
          if (gr.n < 2) continue;
          if (repeatMethod === 'prepend' || (repeatMethod === 'separate' && shown)) res += eol;
          for (const l of gr.all) res += l + eol;
          shown++; continue;
        }
        res += (o.c ? String(gr.n).padStart(7) + ' ' : '') + gr.line + eol;
      }
      if (g.rest[1] && g.rest[1] !== '-') {
        try { ctx.fs.write(g.rest[1], res); } catch (e) { if (!isFsError(e)) throw e; ctx.err('uniq: ' + g.rest[1] + ': ' + e.message + '\n'); return 1; }
      } else ctx.out(res);
      return 0;
    },
  });

  /* ===================================================================== cut */
  /** Parse a cut list ("1,3-5,7-") into sorted, merged [from, to] ranges (1-based, to may be Infinity). */
  function cutRanges(list, isField) {
    const bad = (what) => ({ err: 'invalid ' + (isField ? 'field' : 'byte or character') + ' ' + what });
    const ranges = [];
    for (const part of list.split(/[,\s]/)) {
      if (part === '-') return { err: 'invalid range with no endpoint: -' };
      const m = /^(\d*)(-?)(\d*)$/.exec(part);
      if (!m) {
        if ((part.match(/-/g) || []).length > 1 && /^[\d-]+$/.test(part)) return bad('range');
        const at = /^\d*-?/.exec(part)[0];
        return { err: 'invalid ' + (isField ? 'field' : 'byte/character position') + ' value ' + q(/^\d+-?$/.test(at) || !/^\d/.test(part) ? part.slice(/^\d+-/.test(part) ? at.length : 0) : part) };
      }
      const from = m[1] ? parseInt(m[1], 10) : 1; const to = m[2] ? (m[3] ? parseInt(m[3], 10) : Infinity) : from;
      if (part === '' || (m[1] && from === 0) || (!m[2] && to === 0)) return { err: (isField ? 'fields' : 'byte/character positions') + ' are numbered from 1' };
      if (from > to) return { err: 'invalid decreasing range' };
      ranges.push([from, to]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) { const l = merged[merged.length - 1]; if (l && r[0] <= l[1] + 1) l[1] = Math.max(l[1], r[1]); else merged.push(r.slice()); }
    return { ranges: merged };
  }
  const inRanges = (ranges, n) => ranges.some((r) => n >= r[0] && n <= r[1]);

  define({
    name: 'cut', pkg: 'coreutils', summary: 'remove sections from each line of files',
    usage: ['OPTION... [FILE]...'],
    desc: 'Print selected parts of lines from each FILE to standard output.\nWith no FILE, or when FILE is -, read standard input.\nEach LIST is made up of one range, or many ranges separated by commas. Selected input is written in the same order that it is read, and is written exactly once. Each range is one of: N, N-M, N- (from N to the end of the line) or -M (from the first character to M).',
    opts: [
      ['-b, --bytes=LIST', 'select only these bytes'], ['-c, --characters=LIST', 'select only these characters'],
      ['-d, --delimiter=DELIM', 'use DELIM instead of TAB for field delimiter'], ['-f, --fields=LIST', 'select only these fields; also print any line that contains no delimiter character, unless the -s option is specified'],
      ['-n', '(ignored)'], ['    --complement', 'complement the set of selected bytes, characters or fields'],
      ['-s, --only-delimited', 'do not print lines not containing delimiters'], ['    --output-delimiter=STRING', 'use STRING as the output delimiter; the default is to use the input delimiter'],
      ['-z, --zero-terminated', 'line delimiter is NUL, not newline'],
    ],
    examples: [["cut -d: -f1,7 /etc/passwd", 'List each account name with its login shell.'], ['echo "10.10.10.5 eth0" | cut -d" " -f1', 'Keep the first space-separated field.']],
    version: coreutils('David M. Ihnat, David MacKenzie, and Jim Meyering'),
    async run(ctx, d) {
      const g = parseArgs(ctx, d, { short: 'b:c:d:f:nsz', long: ['bytes=', 'characters=', 'delimiter=', 'fields=', 'complement', 'only-delimited', 'output-delimiter=', 'zero-terminated'],
        alias: aliasOf([['b', 'bytes'], ['c', 'characters'], ['d', 'delimiter'], ['f', 'fields'], ['s', 'only-delimited'], ['z', 'zero-terminated']]) });
      if (typeof g === 'number') return g;
      const o = g.opts;
      const modes = ['b', 'c', 'f'].filter((m) => o[m] != null);
      if (!modes.length) return usageError(ctx, 'you must specify a list of bytes, characters, or fields');
      if (modes.length > 1) return usageError(ctx, 'only one list may be specified');
      if (o.c != null) { o.b = o.c; modes[0] = 'b'; }   // GNU cut is not multibyte aware: -c is -b
      const mode = modes[0];
      if (o.d != null && mode !== 'f') return usageError(ctx, 'an input delimiter may be specified only when operating on fields');
      if (o.s && mode !== 'f') return usageError(ctx, 'suppressing non-delimited lines makes sense\n\tonly when operating on fields');
      if (o.d != null && Array.from(o.d).length > 1) return usageError(ctx, 'the delimiter must be a single character');
      const parsed = cutRanges(o[mode], mode === 'f');
      if (parsed.err) return usageError(ctx, parsed.err);
      const delim = o.d == null ? '\t' : o.d === '' ? '\0' : o.d;
      const outDelim = o['output-delimiter'] != null ? o['output-delimiter'] : delim;
      const eol = o.z ? '\0' : '\n';
      const keep = (n) => inRanges(parsed.ranges, n) !== !!o.complement;
      const { inputs, failed } = await readInputs(ctx, g.rest);
      const sink = new Sink(ctx);
      for (const inp of inputs) {
        const lines = inp.text.split(eol); if (lines[lines.length - 1] === '') lines.pop();
        for (const line of lines) {
          if (mode === 'f') {
            if (!line.includes(delim)) { if (!o.s) sink.write(line + eol); continue; }
            sink.write(line.split(delim).filter((_, i) => keep(i + 1)).join(outDelim) + eol);
          } else {
            const bytes = U.toBytes(line); const sel = []; let prev = false; let res = [];
            bytes.forEach((b, i) => {
              const k = keep(i + 1);
              if (k && !prev && sel.length && o['output-delimiter'] != null) res.push(...U.toBytes(outDelim));
              if (k) { res.push(b); sel.push(i); }
              prev = k;
            });
            sink.write(U.fromBytes(res) + eol);
          }
        }
      }
      sink.flush();
      return failed ? 1 : 0;
    },
  });

  /* ==================================================================== sort */
  const SORT_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const SORT_ORDER_LETTERS = 'bdfgiMhnRrV';
  const SORT_SIZE_SUFFIX = 'KMGTPEZYRQ';
  const isBlank = (c) => c === ' ' || c === '\t';

  /** Exact decimal value of the leading number in `s` (as `sort -n` reads it). */
  function leadingNumber(s) {
    const m = /^[ \t]*(-?)(\d*)(?:\.(\d*))?/.exec(s);
    const int = m[2].replace(/^0+/, ''); const frac = (m[3] || '').replace(/0+$/, '');
    return { neg: m[1] === '-' && (int !== '' || frac !== ''), int, frac, len: m[0].length };
  }
  function compareMagnitude(a, b) {
    if (a.int.length !== b.int.length) return a.int.length < b.int.length ? -1 : 1;
    if (a.int !== b.int) return a.int < b.int ? -1 : 1;
    const w = Math.max(a.frac.length, b.frac.length);
    return byteCompare(a.frac.padEnd(w, '0'), b.frac.padEnd(w, '0'));
  }
  function compareNumbers(a, b) {
    if (a.neg !== b.neg) return a.neg ? -1 : 1;
    return a.neg ? compareMagnitude(b, a) : compareMagnitude(a, b);
  }
  /** strtold-style leading float for sort -g; null when the text is not numeric. */
  function generalNumber(s) {
    const m = /^[ \t]*([+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan))/i.exec(s);
    if (!m) return null;
    const t = m[1].toLowerCase().replace(/^\+/, '');
    if (/^-?nan/.test(t)) return NaN;
    if (/^-?0x/.test(t)) return (t[0] === '-' ? -1 : 1) * parseInt(t.replace('-', ''), 16);
    return /^-?inf/.test(t) ? (t[0] === '-' ? -Infinity : Infinity) : parseFloat(t);
  }
  function humanNumber(s) {
    const n = leadingNumber(s);
    const suffix = SORT_SIZE_SUFFIX.indexOf(s.charAt(n.len).toUpperCase()) + 1;
    return { n, suffix: s.charAt(n.len) === '' ? 0 : suffix };
  }
  /** Debian-style version comparison (what sort -V does). */
  function versionCompare(a, b) {
    const weight = (c) => (c === undefined ? 0 : c === '~' ? -1 : /\d/.test(c) ? 0 : /[A-Za-z]/.test(c) ? c.charCodeAt(0) : c.charCodeAt(0) + 256);
    let i = 0; let j = 0;
    while (i < a.length || j < b.length) {
      while ((i < a.length && !/\d/.test(a[i])) || (j < b.length && !/\d/.test(b[j]))) {
        const d = weight(a[i]) - weight(b[j]);
        if (d) return d < 0 ? -1 : 1;
        i++; j++;
      }
      while (a[i] === '0') i++;
      while (b[j] === '0') j++;
      let d = 0;
      while (/\d/.test(a[i] || '') && /\d/.test(b[j] || '')) { if (!d) d = a.charCodeAt(i) - b.charCodeAt(j); i++; j++; }
      if (/\d/.test(a[i] || '')) return 1;
      if (/\d/.test(b[j] || '')) return -1;
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  /** Parse "F[.C][opts][,F[.C][opts]]" for sort -k. Returns { key } or { err }. */
  function parseSortKey(spec) {
    const bad = (why) => ({ err: why + ': invalid field specification ' + q(spec) });
    let rest = spec;
    const number = (what) => {
      const m = /^\d+/.exec(rest);
      if (!m) return { err: 'invalid number ' + what + ': invalid count at start of ' + q(rest) };
      rest = rest.slice(m[0].length);
      return { n: m[0].length > 15 ? Infinity : parseInt(m[0], 10) };
    };
    const flags = () => { const m = /^[bdfghiMnRrV]*/.exec(rest)[0]; rest = rest.slice(m.length); return m; };
    const key = { sword: 0, schar: 0, eword: Infinity, echar: 0, hasEnd: false };
    let r = number('at field start'); if (r.err) return r;
    if (r.n === 0) return bad('field number is zero');
    key.sword = r.n - 1;
    if (rest[0] === '.') {
      rest = rest.slice(1); r = number("after '.'"); if (r.err) return r;
      if (r.n === 0) return bad('character offset is zero');
      key.schar = r.n - 1;
    }
    let f = flags();
    let endFlags = '';
    if (rest[0] === ',') {
      rest = rest.slice(1); r = number("after ','"); if (r.err) return r;
      if (r.n === 0) return bad('field number is zero');
      key.eword = r.n - 1; key.hasEnd = true;
      if (rest[0] === '.') { rest = rest.slice(1); r = number("after '.'"); if (r.err) return r; key.echar = r.n; }
      endFlags = flags();
    }
    if (rest) return bad('stray character in field spec');
    key.flags = f + endFlags;
    key.skipStart = f.includes('b') || (!!endFlags && false);
    key.skipEnd = endFlags.includes('b');
    return { key };
  }

  /** The text of line `line` that key `k` selects (a port of GNU begfield/limfield). */
  function keyText(line, k, tab) {
    const len = line.length; let ptr = 0;
    const skipBlanks = () => { while (ptr < len && isBlank(line[ptr])) ptr++; };
    let n = k.sword;
    if (tab != null) { while (ptr < len && n--) { while (ptr < len && line[ptr] !== tab) ptr++; if (ptr < len) ptr++; } }
    else { while (ptr < len && n--) { skipBlanks(); while (ptr < len && !isBlank(line[ptr])) ptr++; } }
    if (k.skipStart) skipBlanks();
    const beg = Math.min(len, ptr + k.schar);
    if (!k.hasEnd) return line.slice(beg);
    ptr = 0; n = k.eword + (k.echar === 0 ? 1 : 0);
    if (tab != null) { while (ptr < len && n--) { while (ptr < len && line[ptr] !== tab) ptr++; if (ptr < len && (n || k.echar)) ptr++; } }
    else { while (ptr < len && n--) { skipBlanks(); while (ptr < len && !isBlank(line[ptr])) ptr++; } }
    if (k.echar !== 0) { if (k.skipEnd) skipBlanks(); ptr = Math.min(len, ptr + k.echar); }
    return line.slice(beg, Math.max(beg, ptr));
  }

  /** Comparison function for one key's text, as chosen by its ordering flags. */
  function keyComparer(flags, coll) {
    const has = (c) => flags.includes(c);
    const sign = has('r') ? -1 : 1;
    let cmp;
    if (has('n')) { const v = (s) => leadingNumber(s); cmp = (a, b) => compareNumbers(v(a), v(b)); }
    else if (has('g')) {
      cmp = (a, b) => {
        const x = generalNumber(a); const y = generalNumber(b);
        if (x == null || y == null || Number.isNaN(x) || Number.isNaN(y)) {
          const xl = x == null || Number.isNaN(x); const yl = y == null || Number.isNaN(y);
          return xl && yl ? 0 : xl ? -1 : 1;
        }
        return x < y ? -1 : x > y ? 1 : 0;
      };
    } else if (has('h')) {
      cmp = (a, b) => {
        const x = humanNumber(a); const y = humanNumber(b);
        if (x.n.neg !== y.n.neg) return x.n.neg ? -1 : 1;
        const flip = x.n.neg ? -1 : 1;
        if (x.suffix !== y.suffix) return x.suffix < y.suffix ? -flip : flip;
        return compareNumbers(x.n, y.n);
      };
    } else if (has('M')) {
      const month = (s) => { const t = s.replace(/^[ \t]+/, '').slice(0, 3).toUpperCase(); return SORT_MONTHS.indexOf(t) + 1; };
      cmp = (a, b) => month(a) - month(b);
    } else if (has('V')) cmp = versionCompare;
    else {
      const fold = has('f'); const dict = has('d'); const ign = has('i');
      const prep = (s) => {
        if (dict) s = s.replace(/[^\p{L}\p{N} \t]/gu, '');
        if (ign) s = s.replace(/[^\x20-\x7e -￿]/g, '');
        return fold ? s.toUpperCase() : s;
      };
      cmp = fold || dict || ign ? (a, b) => coll(prep(a), prep(b)) : coll;
    }
    return (a, b) => sign * cmp(a, b);
  }

  /** k-way merge of lists that are already sorted; earlier lists win ties. */
  function mergeSorted(lists, cmp) {
    const heads = lists.map(() => 0); const merged = [];
    for (;;) {
      let best = -1;
      for (let i = 0; i < lists.length; i++) {
        if (heads[i] < lists[i].length && (best < 0 || cmp(lists[i][heads[i]], lists[best][heads[best]]) < 0)) best = i;
      }
      if (best < 0) return merged;
      merged.push(lists[best][heads[best]++]);
    }
  }

  define({
    name: 'sort', pkg: 'coreutils', summary: 'sort lines of text files',
    usage: ['[OPTION]... [FILE]...', '[OPTION]... --files0-from=F'],
    desc: 'Write sorted concatenation of all FILE(s) to standard output.\nWith no FILE, or when FILE is -, read standard input.\nA KEYDEF is F[.C][OPTS][,F[.C][OPTS]] for start and stop position, where F is a field number and C a character position in the field; both are origin 1. If no stop position is given, the end of the line is used. OPTS is one or more single-letter ordering options [bdfgiMhnRrV], which override global ordering options for that key.',
    opts: [
      'Ordering options:',
      ['-b, --ignore-leading-blanks', 'ignore leading blanks'], ['-d, --dictionary-order', 'consider only blanks and alphanumeric characters'],
      ['-f, --ignore-case', 'fold lower case to upper case characters'], ['-g, --general-numeric-sort', 'compare according to general numerical value'],
      ['-i, --ignore-nonprinting', 'consider only printable characters'], ['-M, --month-sort', "compare (unknown) < 'JAN' < ... < 'DEC'"],
      ['-h, --human-numeric-sort', 'compare human readable numbers (e.g., 2K 1G)'], ['-n, --numeric-sort', 'compare according to string numerical value'],
      ['-r, --reverse', 'reverse the result of comparisons'], ['-V, --version-sort', 'natural sort of (version) numbers within text'],
      'Other options:',
      ['-c, --check, --check=diagnose-first', 'check for sorted input; do not sort'], ['-C, --check=quiet', 'like -c, but do not report first bad line'],
      ['-k, --key=KEYDEF', 'sort via a key; KEYDEF gives location and type'], ['-m, --merge', 'merge already sorted files; do not sort'],
      ['-o, --output=FILE', 'write result to FILE instead of standard output'], ['-s, --stable', 'stabilize sort by disabling last-resort comparison'],
      ['-S, --buffer-size=SIZE', 'use SIZE for main memory buffer'], ['-t, --field-separator=SEP', 'use SEP instead of non-blank to blank transition'],
      ['-u, --unique', 'with -c, check for strict ordering; without -c, output only the first of an equal run'], ['-z, --zero-terminated', 'line delimiter is NUL, not newline'],
    ],
    examples: [['sort -t: -k3 -n /etc/passwd', 'Order accounts by numeric user id (third field).'], ['sort -u hosts.txt', 'Remove duplicate lines while sorting.'], ['du -sh * | sort -h', 'List sizes from smallest to largest.']],
    exit: '0 if OK, 1 if the -c check found disorder, 2 on trouble.',
    version: coreutils('Mike Haertel and Paul Eggert'),
    usageStatus: 2,
    async run(ctx, d) {
      const modeNames = { n: 'numeric-sort', g: 'general-numeric-sort', h: 'human-numeric-sort', M: 'month-sort', V: 'version-sort', R: 'random-sort' };
      const g = parseArgs(ctx, d, {
        short: 'bdfgiMhnrVcCk:mo:sS:t:uzR',
        long: ['ignore-leading-blanks', 'dictionary-order', 'ignore-case', 'general-numeric-sort', 'ignore-nonprinting', 'month-sort', 'human-numeric-sort', 'numeric-sort', 'reverse',
          'version-sort', 'check=?', 'key=', 'merge', 'output=', 'stable', 'buffer-size=', 'field-separator=', 'unique', 'zero-terminated', 'sort=', 'parallel=', 'temporary-directory=', 'batch-size=', 'compress-program=', 'debug'],
        alias: aliasOf([['b', 'ignore-leading-blanks'], ['d', 'dictionary-order'], ['f', 'ignore-case'], ['g', 'general-numeric-sort'], ['i', 'ignore-nonprinting'], ['M', 'month-sort'],
          ['h', 'human-numeric-sort'], ['n', 'numeric-sort'], ['r', 'reverse'], ['V', 'version-sort'], ['c', 'check'], ['k', 'key'], ['m', 'merge'], ['o', 'output'], ['s', 'stable'],
          ['S', 'buffer-size'], ['t', 'field-separator'], ['u', 'unique'], ['z', 'zero-terminated']]),
      });
      if (typeof g === 'number') return g;
      const o = g.opts;
      const fail = (msg) => { ctx.err('sort: ' + msg + '\n'); return 2; };
      // global ordering flags, in the order GNU lists them in its "incompatible" message
      let global = '';
      for (const c of SORT_ORDER_LETTERS) if (o[c]) global += c;
      if (o.sort) {
        const word = Object.keys(modeNames).find((c) => modeNames[c].startsWith(o.sort) || (c === 'n' && 'numeric'.startsWith(o.sort)));
        if (!word) return usageError(ctx, "invalid argument " + q(o.sort) + " for '--sort'\nValid arguments are:\n  - " + q('general-numeric') + '\n  - ' + q('human-numeric') + '\n  - ' + q('month') + '\n  - ' + q('numeric') + '\n  - ' + q('random') + '\n  - ' + q('version'), 2);
        if (!global.includes(word)) global += word;
      }
      const incompatible = (flags) => {
        const kinds = [...flags].filter((c) => 'ngMhVR'.includes(c)); const text = [...flags].filter((c) => 'di'.includes(c));
        if (kinds.length > 1 || (kinds.length && text.length && !(kinds[0] === 'g' && false))) {
          const pick = [...flags].filter((c) => 'dgiMhnRV'.includes(c)).sort((a, b) => 'bdfgiMhnRrV'.indexOf(a) - 'bdfgiMhnRrV'.indexOf(b));
          return pick.length > 1 ? pick.join('') : null;
        }
        return null;
      };
      let bad = incompatible(global);
      if (bad) return fail("options '-" + bad + "' are incompatible");

      const tab = o.t == null ? null : o.t === '\\0' ? '\0' : o.t;
      if (tab != null && Array.from(tab).length !== 1) return fail('multi-character tab ' + q(tab));
      if (tab === '') return fail('empty tab');
      const coll = collation(ctx.env);
      const keys = [];
      for (const spec of g.all.k || []) {
        const r = parseSortKey(spec);
        if (r.err) return fail(r.err);
        const k = r.key;
        bad = incompatible(k.flags); if (bad) return fail("options '-" + bad + "' are incompatible");
        if (!k.flags) { k.flags = global; k.skipStart = global.includes('b'); k.skipEnd = global.includes('b'); }
        k.cmp = keyComparer(k.flags, coll);
        keys.push(k);
      }
      let wholeCmp = null;
      if (!keys.length) {
        const f = global.replace(/b/g, '');
        wholeCmp = keyComparer(f, coll);
        if (global.includes('b')) { keys.push({ sword: 0, schar: 0, eword: Infinity, echar: 0, hasEnd: false, skipStart: true, skipEnd: true, cmp: keyComparer(f, coll) }); wholeCmp = null; }
      }
      const reverse = global.includes('r');
      const lastResort = (a, b) => (reverse ? -1 : 1) * coll(a, b);
      const stable = !!o.s; const unique = !!o.u;
      const compare = (a, b, resort) => {
        let diff = 0;
        if (keys.length) {
          for (let i = 0; i < keys.length && !diff; i++) diff = keys[i].cmp(a.keys[i], b.keys[i]);
        } else if (wholeCmp) diff = wholeCmp(a.line, b.line);
        if (diff || unique || stable || !resort) return diff;
        return lastResort(a.line, b.line);
      };
      const item = (line) => ({ line, keys: keys.map((k) => keyText(line, k, tab)) });

      const { inputs, failed } = await readInputs(ctx, g.rest, (name, e) => 'cannot read: ' + name + ': ' + e.message);
      const eol = o.z ? '\0' : '\n';
      if (failed) return 2;
      const perFile = inputs.map((inp) => {
        const parts = inp.text.split(eol);
        if (parts[parts.length - 1] === '') parts.pop();
        return parts.map(item);
      });
      const lines = [].concat(...perFile);

      if (o.c != null || o.C) {
        const quiet = o.C || o.c === 'quiet' || o.c === 'silent';
        if (!quiet && o.c !== true && !['diagnose-first', 'quiet', 'silent'].includes(o.c)) return usageError(ctx, "invalid argument " + q(o.c) + " for '--check'", 2);
        const file = g.rest[0] || '-';
        if (lines.length && g.rest.length > 1) return usageError(ctx, 'extra operand ' + q(g.rest[1]) + '\nfile operands cannot be combined with -c or -C', 2);
        for (let i = 1; i < lines.length; i++) {
          const c = compare(lines[i - 1], lines[i], true);
          if (c > 0 || (unique && c === 0)) {
            if (!quiet) ctx.err('sort: ' + file + ':' + (i + 1) + ': disorder: ' + lines[i].line + '\n');
            return 1;
          }
        }
        return 0;
      }
      if (lines.length > 20000) await breathe(ctx);
      let result = o.m ? mergeSorted(perFile, (a, b) => compare(a, b, true)) : lines.sort((a, b) => compare(a, b, true));
      if (unique) result = result.filter((x, i) => i === 0 || compare(result[i - 1], x, false) !== 0);
      const text = result.map((x) => x.line + eol).join('');
      if (o.o != null) {
        try { ctx.fs.write(o.o, text); } catch (e) { if (!isFsError(e)) throw e; return fail('open failed: ' + o.o + ': ' + e.message); }
      } else ctx.out(text);
      return 0;
    },
  });

  /* ===================================================================== tr
   * tr works on bytes, like the real one: multibyte characters are never
   * matched by ranges or classes.
   */
  const trRange = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const TR_CLASSES = {
    alpha: trRange(65, 90).concat(trRange(97, 122)), digit: trRange(48, 57), alnum: trRange(48, 57).concat(trRange(65, 90), trRange(97, 122)),
    upper: trRange(65, 90), lower: trRange(97, 122), space: [9, 10, 11, 12, 13, 32], blank: [9, 32], punct: trRange(33, 47).concat(trRange(58, 64), trRange(91, 96), trRange(123, 126)),
    print: trRange(32, 126), graph: trRange(33, 126), cntrl: trRange(0, 31).concat([127]), xdigit: trRange(48, 57).concat(trRange(65, 70), trRange(97, 102)),
  };
  TR_CLASSES.alnum.sort((a, b) => a - b); TR_CLASSES.alpha.sort((a, b) => a - b);
  const TR_ESCAPES = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 };

  /** Parse a tr operand into items: {c} a byte, {cls, bytes} a class, {rep, n} a [c*n] construct. Throws RegexError. */
  function parseTrSet(spec, warn) {
    const s = U.toBytes(spec); const items = []; let i = 0;
    const ch = (b) => String.fromCharCode(b);
    const readByte = () => {
      if (s[i] !== 92) return s[i++];
      if (i + 1 >= s.length) { warn('warning: an unescaped backslash at end of string is not portable'); i++; return 92; }
      const e = ch(s[i + 1]);
      if (/[0-7]/.test(e)) { let j = i + 1; let v = 0; while (j < i + 4 && s[j] >= 48 && s[j] <= 55) v = v * 8 + s[j++] - 48; i = j; return v & 255; }
      i += 2;
      return e in TR_ESCAPES ? TR_ESCAPES[e] : s[i - 1];
    };
    while (i < s.length) {
      if (s[i] === 91 && i + 1 < s.length) {   // [
        const kind = ch(s[i + 1]);
        if (kind === ':' || kind === '=') {
          const end = s.findIndex((b, k) => k > i + 2 && b === s[i + 1] && s[k + 1] === 93);
          if (end > 0) {
            const body = U.fromBytes(s.slice(i + 2, end));
            if (kind === ':') {
              if (!TR_CLASSES[body]) throw new RegexError('invalid character class ' + q(body));
              items.push({ cls: body, bytes: TR_CLASSES[body] });
            } else {
              if (end - i - 2 !== 1) throw new RegexError('invalid equivalence class: [=' + body + '=]');
              items.push({ c: s[i + 2] });
            }
            i = end + 2; continue;
          }
        } else {
          const save = i; i++;
          const b = readByte();
          if (s[i] === 42) {
            let j = i + 1; let digits = '';
            while (j < s.length && s[j] !== 93) digits += ch(s[j++]);
            if (j < s.length && /^\d*$/.test(digits)) {
              const n = digits === '' ? 0 : parseInt(digits, digits[0] === '0' ? 8 : 10);
              items.push({ rep: b, n }); i = j + 1; continue;
            }
          }
          i = save;
        }
      }
      const from = readByte();
      if (s[i] === 45 && i + 1 < s.length) {
        i++;
        const to = readByte();
        if (to < from) throw new RegexError('range-endpoints of ' + "'" + ch(from) + '-' + ch(to) + "'" + ' are in reverse collating sequence order');
        for (let b = from; b <= to; b++) items.push({ c: b });
      } else items.push({ c: from });
    }
    return items;
  }
  const trLength = (items) => items.reduce((n, it) => n + (it.c != null ? 1 : it.cls ? it.bytes.length : it.n), 0);

  define({
    name: 'tr', pkg: 'coreutils', summary: 'translate or delete characters',
    usage: ['[OPTION]... STRING1 [STRING2]'],
    desc: 'Translate, squeeze, and/or delete characters from standard input, writing to standard output.',
    opts: [
      ['-c, -C, --complement', 'use the complement of STRING1'], ['-d, --delete', 'delete characters in STRING1, do not translate'],
      ['-s, --squeeze-repeats', 'replace each sequence of a repeated character that is listed in the last specified STRING, with a single occurrence of that character'],
      ['-t, --truncate-set1', 'first truncate STRING1 to length of STRING2'],
    ],
    notes: 'SETs are specified as strings of characters. Most represent themselves. Interpreted sequences are:\n\n  \\NNN            character with octal value NNN (1 to 3 octal digits)\n  \\\\              backslash\n  \\a \\b \\f \\n \\r \\t \\v   audible BEL, backspace, form feed, new line, return, horizontal tab, vertical tab\n  CHAR1-CHAR2     all characters from CHAR1 to CHAR2 in ascending order\n  [CHAR*]         in STRING2, copies of CHAR until length of STRING1\n  [CHAR*REPEAT]   REPEAT copies of CHAR, REPEAT octal if starting with 0\n  [:alnum:] [:alpha:] [:blank:] [:cntrl:] [:digit:] [:graph:] [:lower:] [:print:] [:punct:] [:space:] [:upper:] [:xdigit:]\n  [=CHAR=]        all characters which are equivalent to CHAR',
    examples: [["echo 'Kali Linux' | tr a-z A-Z", 'Convert to upper case.'], ["tr -d '\\r' < dos.txt > unix.txt", 'Strip carriage returns from a text file.'], ["tr -cs 'A-Za-z' '\\n' < notes.txt", 'Put each word of a file on its own line.']],
    version: coreutils('Jim Meyering'),
    async run(ctx, d) {
      const g = parseArgs(ctx, d, { short: 'cCdst', long: ['complement', 'delete', 'squeeze-repeats', 'truncate-set1'], alias: { complement: 'c', C: 'c', delete: 'd', 'squeeze-repeats': 's', 'truncate-set1': 't' } });
      if (typeof g === 'number') return g;
      const o = g.opts; const ops = g.rest;
      const two = o.d && o.s;
      if (!ops.length) return usageError(ctx, 'missing operand');
      if (ops.length > 2 || (o.d && !o.s && ops.length > 1)) {
        return usageError(ctx, 'extra operand ' + q(ops[ops.length > 2 ? 2 : 1]) + (o.d && !o.s && ops.length === 2 ? '\nOnly one string may be given when deleting without squeezing repeats.' : ''));
      }
      if (ops.length < 2 && (two || (!o.d && !o.s))) {
        return usageError(ctx, 'missing operand after ' + q(ops[0]) + '\nTwo strings must be given when ' + (two ? 'both deleting and squeezing repeats.' : 'translating.'));
      }
      const warn = (m) => ctx.err('tr: ' + m + '\n');
      const fail = (m) => { ctx.err('tr: ' + m + '\n'); return 1; };
      let items1; let items2 = null;
      try {
        items1 = parseTrSet(ops[0], warn);
        if (items1.some((it) => it.rep != null)) return fail('the [c*] repeat construct may not appear in string1');
        if (ops.length > 1) items2 = parseTrSet(ops[1], warn);
      } catch (e) { if (e instanceof RegexError) return fail(e.message); throw e; }
      const expand = (items, fillTo) => {
        const known = items.reduce((n, it) => n + (it.rep != null && it.n === 0 ? 0 : trLength([it])), 0);
        const out = [];
        for (const it of items) {
          if (it.c != null) out.push(it.c);
          else if (it.cls) out.push.apply(out, it.bytes);
          else for (let k = it.n || Math.max(0, fillTo - known); k > 0; k--) out.push(it.rep);
        }
        return out;
      };
      let set1 = expand(items1, 0);
      const inSet1 = new Set(set1);
      if (o.c) set1 = trRange(0, 255).filter((b) => !inSet1.has(b));
      const translating = items2 && !o.d;
      let set2 = [];
      if (items2) {
        if (translating) {
          const classes = items2.filter((it) => it.cls);
          if (classes.some((it) => it.cls !== 'upper' && it.cls !== 'lower')) {
            return fail("when translating, the only character classes that may appear in\nstring2 are 'upper' and 'lower'");
          }
          let at = 0; let at1 = 0; const starts1 = new Map();
          for (const it of items1) { if (it.cls) starts1.set(at1, it.cls); at1 += trLength([it]); }
          for (const it of items2) {
            if (it.cls && !(!o.c && starts1.get(at) && starts1.get(at) !== it.cls && (starts1.get(at) === 'upper' || starts1.get(at) === 'lower'))) return fail('misaligned [:upper:] and/or [:lower:] construct');
            at += trLength([it]);
          }
        }
        set2 = expand(items2, set1.length);
        if (translating && !set2.length && !o.t && set1.length) return fail('when not truncating set1, string2 must be non-empty');
      }
      const map = trRange(0, 255);
      if (translating) {
        const n = o.t ? Math.min(set1.length, set2.length) : set1.length;
        for (let i = 0; i < n; i++) map[set1[i]] = i < set2.length ? set2[i] : set2[set2.length - 1];
      }
      const deleteSet = o.d ? new Set(set1) : null;
      const squeezeSource = o.s ? (items2 ? set2 : set1) : null;
      const squeeze = squeezeSource ? new Set(squeezeSource) : null;
      const input = U.toBytes(await stdinText(ctx));
      const out = []; let prev = -1;
      for (const b of input) {
        if (deleteSet && deleteSet.has(b)) continue;
        const m = translating ? map[b] : b;
        if (squeeze && m === prev && squeeze.has(m)) continue;
        out.push(m); prev = m;
      }
      ctx.out(U.fromBytes(out));
      return 0;
    },
  });

  /* ===================================================================== tee */
  define({
    name: 'tee', pkg: 'coreutils', summary: 'read from standard input and write to standard output and files',
    usage: ['[OPTION]... [FILE]...'],
    desc: 'Copy standard input to each FILE, and also to standard output.',
    opts: [['-a, --append', 'append to the given FILEs, do not overwrite'], ['-i, --ignore-interrupts', 'ignore interrupt signals'], ['-p', 'operate in a more appropriate MODE with pipes.'], ['    --output-error[=MODE]', 'set behavior on write error.  See MODE below']],
    notes: 'MODE determines behavior with write errors on the outputs: warn, warn-nopipe, exit, exit-nopipe.',
    examples: [['ls -l | tee listing.txt', 'Show the listing and keep a copy in listing.txt.'], ['echo "10.10.10.10 web01" | sudo tee -a /etc/hosts', 'Append a line to a root-owned file.']],
    version: coreutils('Mike Parker, Richard M. Stallman, and David MacKenzie'),
    async run(ctx, d) {
      const g = parseArgs(ctx, d, { short: 'aip', long: ['append', 'ignore-interrupts', 'output-error=?'], alias: { append: 'a', 'ignore-interrupts': 'i' } });
      if (typeof g === 'number') return g;
      let status = 0; const files = [];
      for (const f of g.rest) {
        try {
          if (!g.opts.a) ctx.fs.write(f, ''); else if (!ctx.fs.exists(f)) ctx.fs.write(f, '');
          files.push(f);
        } catch (e) { if (!isFsError(e)) throw e; ctx.err('tee: ' + f + ': ' + e.message + '\n'); status = 1; }
      }
      const emit = (s) => {
        ctx.out(s);
        for (const f of files.slice()) {
          try { ctx.fs.append(f, s); } catch (e) { if (!isFsError(e)) throw e; ctx.err('tee: ' + f + ': ' + e.message + '\n'); status = 1; files.splice(files.indexOf(f), 1); }
        }
      };
      if (ctx.stdin != null) emit(ctx.stdin);
      else for (;;) { const line = await ctx.readLine(''); if (line == null) break; emit(line + '\n'); }
      return status;
    },
  });

  /* ===================================================================== seq */
  const SEQ_NUMBER = /^[ \t]*[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|0[xX][0-9a-fA-F]+)[ \t]*$/;
  function seqDecimals(text) {
    const m = /^[+-]?\d*(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
    if (!m || /^[+-]?0[xX]/.test(text.trim())) return 0;
    return Math.max(0, (m[1] || '').length - (m[2] ? parseInt(m[2], 10) : 0));
  }
  define({
    name: 'seq', pkg: 'coreutils', summary: 'print a sequence of numbers',
    usage: ['[OPTION]... LAST', '[OPTION]... FIRST LAST', '[OPTION]... FIRST INCREMENT LAST'],
    desc: 'Print numbers from FIRST to LAST, in steps of INCREMENT.',
    opts: [['-f, --format=FORMAT', 'use printf style floating-point FORMAT'], ['-s, --separator=STRING', 'use STRING to separate numbers (default: \\n)'], ['-w, --equal-width', 'equalize width by padding with leading zeroes']],
    notes: 'If FIRST or INCREMENT is omitted, it defaults to 1. That is, an omitted INCREMENT defaults to 1 even when LAST is smaller than FIRST.\nThe sequence of numbers ends when the sum of the current number and INCREMENT would become greater than LAST.\nFORMAT must be suitable for printing one argument of type \'double\'; it defaults to %.PRECf if FIRST, INCREMENT, and LAST are all fixed point decimal numbers with maximum precision PREC, and to %g otherwise.',
    examples: [['seq 1 5', 'Print 1 to 5, one per line.'], ["seq -f '10.10.10.%g' 1 5", 'Print five lab addresses.'], ['seq -w 8 11', 'Print 08, 09, 10, 11.']],
    version: coreutils('Ulrich Drepper'),
    async run(ctx, d) {
      // a leading '-' followed by a digit is a negative number operand, not an option
      const args = ctx.args.map((a) => a);
      const g = parseArgs(ctx, d, { short: 'f:s:wt', long: ['format=', 'separator=', 'equal-width'], alias: { format: 'f', separator: 's', 'equal-width': 'w' }, negativeNumbers: true }, args);
      if (typeof g === 'number') return g;
      const o = g.opts; const ops = g.rest;
      if (!ops.length) return usageError(ctx, 'missing operand');
      if (ops.length > 3) return usageError(ctx, 'extra operand ' + q(ops[3]));
      for (const t of ops) {
        if (/^[+-]?nan$/i.test(t.trim())) return usageError(ctx, 'invalid ' + q('not-a-number') + ' argument: ' + q(t));
        if (!SEQ_NUMBER.test(t) && !/^[+-]?inf(inity)?$/i.test(t.trim())) return usageError(ctx, 'invalid floating point argument: ' + q(t));
      }
      const num = (t) => (/^[+-]?inf/i.test(t.trim()) ? (t.trim()[0] === '-' ? -Infinity : Infinity) : /^[+-]?0[xX]/.test(t.trim()) ? (t.trim()[0] === '-' ? -1 : 1) * parseInt(t.trim().replace(/^[+-]/, ''), 16) : parseFloat(t));
      const first = ops.length > 1 ? num(ops[0]) : 1; const incr = ops.length > 2 ? num(ops[1]) : 1; const last = num(ops[ops.length - 1]);
      if (incr === 0) return usageError(ctx, 'invalid Zero increment value: ' + q(ops[1]));
      if (o.f != null && o.w) return usageError(ctx, 'format string may not be specified when printing equal width strings');
      const sep = o.s == null ? '\n' : o.s;
      const prec = Math.max(ops.length > 1 ? seqDecimals(ops[0]) : 0, ops.length > 2 ? seqDecimals(ops[1]) : 0);
      let format = o.f;
      let before = ''; let after = ''; let conv = null;
      if (format != null) {
        let at = -1;
        for (let i = 0; i < format.length; i++) {
          if (format[i] !== '%') continue;
          if (format[i + 1] === '%') { i++; continue; }
          const m = /^%([-+ 0#']*)(\d+)?(?:\.(\d+))?([a-zA-Z])/.exec(format.slice(i));
          if (!m) return ctx.fail('format ' + q(format) + ' ends in %', 1);
          if (!'aAeEfFgG'.includes(m[4])) return ctx.fail('format ' + q(format) + ' has unknown %' + m[4] + ' directive', 1);
          if (at >= 0) return ctx.fail('format ' + q(format) + ' has too many % directives', 1);
          at = i; conv = m;
        }
        if (at < 0) return ctx.fail('format ' + q(format) + ' has no % directive', 1);
        before = format.slice(0, at).replace(/%%/g, '%'); after = format.slice(at + conv[0].length).replace(/%%/g, '%');
      }
      const fixed = (x) => x.toFixed(prec);
      let width = 0;
      if (o.w) width = Math.max(fixed(first).length, fixed(first + Math.floor((last - first) / incr) * incr).length);
      const render = (x) => {
        if (conv) return before + cFormat(conv[1], conv[2] ? +conv[2] : 0, conv[3] != null ? +conv[3] : null, conv[4], x) + after;
        let s = fixed(x);
        if (width && s.length < width) { const neg = s[0] === '-'; s = (neg ? '-' : '') + s.slice(neg ? 1 : 0).padStart(width - (neg ? 1 : 0), '0'); }
        return s;
      };
      const sink = new Sink(ctx); const eps = Math.abs(incr) * 1e-9;
      let i = 0;
      for (let x = first; incr > 0 ? x <= last + eps : x >= last - eps; x = first + ++i * incr) {
        sink.write((i ? sep : '') + render(x));
        if (i % 50000 === 49999) { sink.flush(); await breathe(ctx); }
      }
      if (i) sink.write('\n');
      sink.flush();
      return 0;
    },
  });

  /* ===================================================================== yes */
  define({
    name: 'yes', pkg: 'coreutils', summary: 'output a string repeatedly until killed',
    usage: ['[STRING]...', 'OPTION'],
    desc: "Repeatedly output a line with all specified STRING(s), or 'y'.",
    examples: [['yes | head -3', 'Print three lines of "y".'], ['yes no | sudo apt upgrade', 'Answer every prompt with "no".']],
    version: coreutils('David MacKenzie'),
    async run(ctx, d) {
      const g = parseArgs(ctx, d, { short: '', long: [] });
      if (typeof g === 'number') return g;
      const line = (g.rest.length ? g.rest.join(' ') : 'y') + '\n';
      const burst = line.repeat(Math.max(1, Math.floor(4096 / line.length)));
      // Pipelines are buffered, so output that is not a terminal is cut off at 64 KiB
      // (a reader such as head would stop the real yes with SIGPIPE).
      if (!ctx.isTTY) { ctx.out(burst.repeat(Math.ceil(65536 / burst.length))); return 0; }
      for (;;) { ctx.out(burst); await breathe(ctx); }
    },
  });

  /* ================================================================== xargs */
  const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : s.includes("'") ? '"' + s.replace(/["\\$`]/g, '\\$&') + '"' : "'" + s + "'");

  /** Split xargs input into items the default way: blanks and newlines separate, quotes and backslashes protect. */
  function xargsItems(text, eofStr, blanksSeparate) {
    const items = []; let cur = null; let quote = null;
    const push = (eol) => { if (cur !== null) { items.push({ text: cur, eol }); cur = null; } else if (eol && items.length) items[items.length - 1].eol = true; };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === '\n') return { err: 'unmatched ' + (quote === "'" ? 'single' : 'double') + ' quote; by default quotes are special to xargs unless you use the -0 option' };
        if (c === quote) quote = null; else cur += c;
      } else if (c === '\\') { cur = (cur === null ? '' : cur) + (text[++i] === undefined ? '' : text[i]); }
      else if (c === '"' || c === "'") { quote = c; if (cur === null) cur = ''; }
      else if (c === '\n') push(!(i > 0 && (text[i - 1] === ' ' || text[i - 1] === '\t')) || cur !== null);
      else if (c === ' ' || c === '\t') { if (blanksSeparate) push(false); else if (cur !== null) cur += c; }
      else cur = (cur === null ? '' : cur) + c;
    }
    if (quote) return { err: 'unmatched ' + (quote === "'" ? 'single' : 'double') + ' quote; by default quotes are special to xargs unless you use the -0 option' };
    push(true);
    if (eofStr != null) { const at = items.findIndex((it) => it.text === eofStr); if (at >= 0) items.length = at; }
    return { items };
  }

  define({
    name: 'xargs', path: '/usr/bin/xargs', pkg: 'findutils', summary: 'build and execute command lines from standard input',
    usage: ['[OPTION]... COMMAND [INITIAL-ARGS]...'],
    desc: 'Run COMMAND with arguments INITIAL-ARGS and more arguments read from input.',
    opts: [
      ['-0, --null', 'items are separated by a null, not whitespace; disables quote and backslash processing and logical EOF processing'],
      ['-a, --arg-file=FILE', 'read arguments from FILE, not standard input'], ['-d, --delimiter=CHARACTER', 'items in input stream are separated by CHARACTER, not by whitespace; disables quote and backslash processing and logical EOF processing'],
      ['-E EOF-STR', 'set logical EOF string; if END occurs as a line of input, the rest of the input is ignored'],
      ['-I R', 'same as --replace=R'], ['-i, --replace[=R]', 'replace R in INITIAL-ARGS with names read from standard input; if R is unspecified, assume {}'],
      ['-L, --max-lines=MAX-LINES', 'use at most MAX-LINES non-blank input lines per command line'], ['-n, --max-args=MAX-ARGS', 'use at most MAX-ARGS arguments per command line'],
      ['-P, --max-procs=MAX-PROCS', 'run at most MAX-PROCS processes at a time'], ['-r, --no-run-if-empty', 'if there are no arguments, then do not run COMMAND; if this option is not given, COMMAND will be run at least once'],
      ['-s, --max-chars=MAX-CHARS', 'limit length of command line to MAX-CHARS'], ['-t, --verbose', 'print commands before executing them'], ['-x, --exit', 'exit if the size (see -s) is exceeded'],
    ],
    examples: [['find . -name "*.txt" | xargs grep -l password', 'Search every text file found.'], ["printf '10.10.10.10\\n10.10.10.20\\n' | xargs -n1 ping -c1", 'Run one ping per address.'], ['cat hosts.txt | xargs -I{} echo scanning {}', 'Substitute each line into the command.']],
    version: (name) => name + ' (GNU findutils) 4.10.0\nCopyright (C) 2024 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by Eric B. Decker, James Youngman, and Kevin Dalley.\nBuilt using GNU gnulib version 20240201\nFeatures enabled: D_TYPE O_NOFOLLOW(enabled) LEAF_OPTIMISATION FTS() CBO(level=2)\n',
    async run(ctx, d) {
      const g = parseArgs(ctx, d, {
        short: '0a:d:E:e::I:i::L:l::n:P:prs:tx', long: ['null', 'arg-file=', 'delimiter=', 'eof=?', 'replace=?', 'max-lines=?', 'max-args=', 'max-procs=', 'interactive', 'no-run-if-empty', 'max-chars=', 'verbose', 'exit', 'open-tty', 'show-limits', 'process-slot-var='],
        alias: { null: '0', 'arg-file': 'a', delimiter: 'd', eof: 'E', replace: 'i', 'max-lines': 'L', 'max-args': 'n', 'max-procs': 'P', interactive: 'p', 'no-run-if-empty': 'r', 'max-chars': 's', verbose: 't', exit: 'x' },
        stopAtNonOption: true,
      });
      if (typeof g === 'number') return g;
      const o = g.opts;
      const bad = (opt, v, min) => {
        if (!/^\d+$/.test(v)) { ctx.err('xargs: invalid number "' + v + '" for -' + opt + " option\nTry 'xargs --help' for more information.\n"); return true; }
        if (+v < min) { ctx.err('xargs: value ' + v + ' for -' + opt + " option should be >= 1\nTry 'xargs --help' for more information.\n"); return true; }
        return false;
      };
      for (const [opt, key, min] of [['n', 'n', 1], ['L', 'L', 1], ['s', 's', 1], ['P', 'P', 0]]) if (o[key] != null && bad(opt, o[key], min)) return 1;
      const replaceStr = o.i != null ? (o.i === true ? '{}' : o.i) : o.I != null ? o.I : null;
      if (replaceStr != null && o.n != null) ctx.err('xargs: warning: options --max-args and --replace/-I/-i are mutually exclusive, ignoring previous --max-args value\n');
      const lines = o.L != null ? +o.L : o.l != null ? (o.l === true ? 1 : +o.l) : null;
      const maxArgs = replaceStr == null && o.n != null ? +o.n : null;
      let input;
      try { input = o.a != null ? ctx.fs.read(o.a) : await stdinText(ctx); }
      catch (e) { if (!isFsError(e)) throw e; ctx.err('xargs: Cannot open input file ' + q(o.a) + ': ' + e.message + '\n'); return 1; }
      const cmd = g.rest.length ? g.rest : ['echo'];

      let items;
      const delim = o['0'] ? '\0' : o.d != null ? o.d.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\0/g, '\0').replace(/\\\\/g, '\\') : null;
      if (delim != null) {
        if (delim.length !== 1) { ctx.err('xargs: invalid delimiter ' + q(o.d) + "\nTry 'xargs --help' for more information.\n"); return 1; }
        const parts = input.split(delim); if (parts[parts.length - 1] === '') parts.pop();
        items = parts.map((t) => ({ text: t, eol: true }));
      } else {
        const r = xargsItems(input, o.E != null ? o.E : null, replaceStr == null);
        if (r.err) { ctx.err('xargs: ' + r.err + '\n'); return 1; }
        items = r.items;
      }

      const chunks = []; let cur = []; let seen = 0;
      for (const it of items) {
        cur.push(it.text);
        if (it.eol) seen++;
        if ((replaceStr != null) || (maxArgs != null && cur.length >= maxArgs) || (lines != null && it.eol && seen >= lines)) { chunks.push(cur); cur = []; seen = 0; }
      }
      if (cur.length) chunks.push(cur);
      if (!chunks.length && !o.r && replaceStr == null) chunks.push([]);

      let status = 0;
      for (const chunk of chunks) {
        const argv = replaceStr != null ? cmd.map((a) => a.split(replaceStr).join(chunk[0])) : cmd.concat(chunk);
        if (o.t) ctx.err(argv.map(shellQuote).join(' ') + '\n');
        const r = await ctx.run(argv, { stdin: '' });
        if (r.code === 127 && /command not found/.test(r.err)) { ctx.err('xargs: ' + argv[0] + ': No such file or directory\n'); return 127; }
        ctx.out(r.out); ctx.err(r.err);
        if (r.code === 255) { ctx.err('xargs: ' + argv[0] + ': exited with status 255; aborting\n'); return 124; }
        if (r.code === 127 || r.code === 126) return r.code;
        if (r.code !== 0) status = 123;
        ctx.checkAbort();
      }
      return status;
    },
  });

  /* @@INSERT@@ */
})(typeof globalThis !== 'undefined' ? globalThis : this);
