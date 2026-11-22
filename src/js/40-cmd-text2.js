/* Kalima — the stream editors sed and awk.
 *
 * Both are real interpreters: a tokenizer, a parser that builds a command list
 * or syntax tree, and an evaluator. Learner input is never evaluated as
 * JavaScript. sed follows GNU sed 4.9; awk follows mawk 1.3.4, the awk that
 * Kali installs (byte oriented, hexadecimal numeric strings, no `**`).
 *
 * Sections: shared helpers, POSIX regular expressions, sed, awk.
 */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;

  /* ================================================================ helpers */

  const isFsError = (e) => e instanceof K.FsError;

  /** Let the event loop run so that Ctrl-C can arrive during a long computation. */
  function breathe(ctx) {
    return new Promise((resolve, reject) => setTimeout(() => (ctx.aborted() ? reject(new K.Interrupt()) : resolve()), 0));
  }

  /** Everything on standard input: the pipe, or lines typed at the terminal until Ctrl-D. */
  async function stdinText(ctx) {
    if (ctx.stdin != null) return ctx.stdin;
    let s = '';
    for (;;) {
      const line = await ctx.readLine('');
      if (line == null) return s;
      s += line + '\n';
    }
  }

  /** Buffered stdout, flushed before anything else could interleave with it. */
  class Sink {
    constructor(ctx) { this.ctx = ctx; this.buf = ''; }
    write(s) { this.buf += s; if (this.buf.length > 65536) this.flush(); }
    flush() { if (this.buf) { this.ctx.out(this.buf); this.buf = ''; } }
  }

  /** Make a registered command's man page body from its parts. */
  function manPage(d) {
    const indent = (s, n) => s.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');
    return 'DESCRIPTION\n' + indent(d.desc, 7) + '\n\nOPTIONS\n' +
      d.opts.map((o) => indent(o[0], 7) + '\n' + indent(o[1], 14)).join('\n\n') +
      (d.exit ? '\n\nEXIT STATUS\n' + indent(d.exit, 7) : '') +
      '\n\nEXAMPLES\n' + d.examples.map((e) => indent(e[0], 7) + '\n' + indent(e[1], 14)).join('\n\n') + '\n';
  }

  /* ============================================ POSIX regular expressions
   * Basic and extended expressions (with the GNU extensions) are translated to
   * JavaScript RegExp source. POSIX wants the leftmost-longest match while
   * JavaScript takes the first alternative that works, so the top-level
   * alternatives are compiled separately and the longest wins.
   */
  class RegexError extends Error {}

  const CLASS_ASCII = {
    alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\r\\f\\v', blank: ' \\t',
    punct: '!-\\/:-@\\[-`{-~', print: ' -~', graph: '!-~', cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f',
  };
  const CLASS_UNICODE = Object.assign({}, CLASS_ASCII, { alpha: '\\p{L}', alnum: '\\p{L}\\p{N}', upper: '\\p{Lu}', lower: '\\p{Ll}' });
  const CTRL_ESC = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', a: '\x07' };
  const escLiteral = (ch) => (/[\\^$.*+?()[\]{}|/]/.test(ch) ? '\\' + ch : ch);
  const escInClass = (ch) => (/[\\\][^-]/.test(ch) ? '\\' + ch : ch);

  /** Decode a backslash escape naming one character at pat[i] ('\\'). Returns {ch, len} or null. */
  function charEscape(pat, i, awk) {
    const c = pat[i + 1];
    if (CTRL_ESC[c] != null) return { ch: CTRL_ESC[c], len: 2 };
    let m;
    if (awk) {
      if (c === 'b') return { ch: '\b', len: 2 };
      if ((m = /^[0-7]{1,3}/.exec(pat.slice(i + 1)))) return { ch: String.fromCharCode(parseInt(m[0], 8) & 255), len: 1 + m[0].length };
      return null;
    }
    if (c === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(pat.slice(i + 2)))) return { ch: String.fromCharCode(parseInt(m[0], 16)), len: 2 + m[0].length };
    if (c === 'o' && (m = /^[0-7]{1,3}/.exec(pat.slice(i + 2)))) return { ch: String.fromCharCode(parseInt(m[0], 8)), len: 2 + m[0].length };
    if (c === 'd' && (m = /^\d{1,3}/.exec(pat.slice(i + 2)))) return { ch: String.fromCharCode(+m[0]), len: 2 + m[0].length };
    if (c === 'c' && i + 2 < pat.length) return { ch: String.fromCharCode(pat[i + 2].toUpperCase().charCodeAt(0) ^ 64), len: 3 };
    return null;
  }

  /** Translate the bracket expression starting at pat[i] ('['). Returns {src, end}. */
  function bracketToJs(pat, i, o) {
    const unmatched = () => new RegexError('Unmatched [, [^, [:, [., or [=');
    const classes = o.awk ? CLASS_ASCII : CLASS_UNICODE;
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
          if (!classes[name]) throw new RegexError('Invalid character class name');
          body += classes[name];
        } else body += Array.from(name).map(escInClass).join('');
        j = close + 2;
      } else if (c === '\\' && j + 1 < pat.length) {
        const e = charEscape(pat, j, o.awk);
        if (e) { body += escInClass(e.ch); j += e.len; }
        else if (o.awk) { body += escInClass(pat[j + 1]); j += 2; }
        else { body += '\\\\'; j++; }
      } else if (c === '-' && j > first && pat[j + 1] !== ']') { body += '-'; j++; }
      else { body += escInClass(c); j++; }
    }
    return { src: '[' + (negate ? '^' : '') + body + ']', end: j + 1 };
  }

  /** Translate a POSIX expression; returns {alts: [js source], groups}. o: {awk, ere}. */
  function posixToJs(pat, o) {
    const ere = o.ere; const awk = !!o.awk;
    const word = awk ? 'A-Za-z0-9_' : '\\p{L}\\p{N}_';
    const gnu = {
      '<': '(?<![' + word + '])(?=[' + word + '])', '>': '(?<=[' + word + '])(?![' + word + '])',
      b: '(?:(?<=[' + word + '])(?![' + word + '])|(?<![' + word + '])(?=[' + word + ']))',
      B: '(?:(?<=[' + word + '])(?=[' + word + '])|(?<![' + word + '])(?![' + word + ']))',
      w: '[' + word + ']', W: '[^' + word + ']', s: '\\s', S: '\\S', '`': '(?<![\\s\\S])', "'": '(?![\\s\\S])',
    };
    const alts = []; let out = ''; let i = 0;
    const stack = [];        // offsets in `out` where the open groups start, with their numbers
    const open = new Set();
    let groups = 0; let groupsBefore = 0;
    let atomStart = -1;      // offset of the atom a quantifier applies to (-1: none)
    let quantified = false;  // that atom already has a quantifier
    let branchStart = true;  // at the start of the expression, a group or an alternative
    const atom = (s) => { atomStart = out.length; out += s; quantified = false; branchStart = false; };
    const zeroWidth = (s) => { out += s; atomStart = -1; branchStart = false; };
    const quantify = (s) => {
      if (quantified) out = out.slice(0, atomStart) + '(?:' + out.slice(atomStart) + ')';
      out += s; quantified = true;
    };
    const openGroup = () => { groups++; stack.push({ at: out.length, n: groups }); open.add(groups); out += '('; atomStart = -1; branchStart = true; };
    const closeGroup = () => {
      const g = stack.pop(); open.delete(g.n);
      atomStart = g.at; out += ')'; quantified = false; branchStart = false;
    };
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
      else if (ere) throw new RegexError('Invalid preceding regular expression');
      else atom(escLiteral(ch));
    };

    while (i < pat.length) {
      const c = pat[i];
      if (c === '\\') {
        if (i + 1 >= pat.length) throw new RegexError('Trailing backslash');
        const n = pat[i + 1];
        if (!ere && n === '(') { i += 2; openGroup(); continue; }
        if (!ere && n === ')') { if (!stack.length) throw new RegexError('Unmatched ) or \\)'); i += 2; closeGroup(); continue; }
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
          if (+n > groups || open.has(+n)) throw new RegexError('Invalid back reference');
          i += 2; atom('(?:\\' + n + ')'); continue;
        }
        if (!awk && gnu[n]) {
          i += 2;
          if (/[wWsS]/.test(n)) atom(gnu[n]); else zeroWidth(gnu[n]);
          continue;
        }
        const e = charEscape(pat, i, awk);
        if (e) { i += e.len; atom(escLiteral(e.ch)); continue; }
        i += 2; atom(escLiteral(n)); continue;
      }
      i++;
      if (c === '[') { const b = bracketToJs(pat, i - 1, o); i = b.end; atom(b.src); }
      else if (c === '.') atom('.');
      else if (c === '*') repeat('*');
      else if (c === '^') {
        if (ere || branchStart) zeroWidth('^'); else atom('\\^');
      } else if (c === '$') {
        const rest = pat.slice(i);
        if (ere || rest === '' || rest.startsWith('\\)') || rest.startsWith('\\|')) zeroWidth('$'); else atom('\\$');
      } else if (ere && c === '(') openGroup();
      else if (ere && c === ')') { if (stack.length) closeGroup(); else atom('\\)'); }
      else if (ere && c === '|') alternate();
      else if (ere && (c === '+' || c === '?')) repeat(c);
      else if (ere && c === '{') {
        if (pat.indexOf('}', i) < 0 && !awk) throw new RegexError('Unmatched \\{');
        const iv = atomStart >= 0 ? interval('}') : null;
        if (iv) quantify(iv); else atom('\\{');
      } else atom(escLiteral(c));
    }
    if (stack.length) throw new RegexError('Unmatched ( or \\(');
    alternate();
    return { alts, groups };
  }

  /** A compiled pattern: the leftmost match wins, and among those the longest. */
  class Pattern {
    constructor(res, groups, src) { this.res = res; this.groups = groups; this.src = src; }
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
  }

  function jsRegexError(e) {
    const m = String(e && e.message);
    if (/range out of order/i.test(m)) return 'Invalid range end';
    if (/numbers out of order/i.test(m)) return 'Invalid content of \\{\\}';
    if (/nothing to repeat/i.test(m)) return 'Invalid preceding regular expression';
    return 'Invalid regular expression';
  }

  /** Compile a POSIX expression. o: {ere, awk, icase, multiline}. Throws RegexError with GNU's message. */
  function compileRegex(pat, o) {
    const t = posixToJs(pat, o);
    const flags = 'gsu' + (o.icase ? 'i' : '') + (o.multiline ? 'm' : '');
    try { return new Pattern(t.alts.map((s) => new RegExp(s, flags)), t.groups, pat); }
    catch (e) { throw new RegexError(jsRegexError(e)); }
  }

  /* =================================================================== sed */

  class SedError extends Error {
    constructor(msg, pos) { super(msg); this.pos = pos; }
  }

  const SED_USAGE = 'Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n\n' +
    '  -n, --quiet, --silent\n                 suppress automatic printing of pattern space\n' +
    '      --debug\n                 annotate program execution\n' +
    '  -e script, --expression=script\n                 add the script to the commands to be executed\n' +
    '  -f script-file, --file=script-file\n                 add the contents of script-file to the commands to be executed\n' +
    '  --follow-symlinks\n                 follow symlinks when processing in place\n' +
    '  -i[SUFFIX], --in-place[=SUFFIX]\n                 edit files in place (makes backup if SUFFIX supplied)\n' +
    '  -l N, --line-length=N\n                 specify the desired line-wrap length for the `l\' command\n' +
    '  --posix\n                 disable all GNU extensions.\n' +
    '  -E, -r, --regexp-extended\n                 use extended regular expressions in the script\n                 (for portability use POSIX -E).\n' +
    '  -s, --separate\n                 consider files as separate rather than as a single,\n                 continuous long stream.\n' +
    '      --sandbox\n                 operate in sandbox mode (disable e/r/w commands).\n' +
    '  -u, --unbuffered\n                 load minimal amounts of data from the input files and flush\n                 the output buffers more often\n' +
    '  -z, --null-data\n                 separate lines by NUL characters\n' +
    '      --help     display this help and exit\n      --version  output version information and exit\n\n' +
    'If no -e, --expression, -f, or --file option is given, then the first\nnon-option argument is taken as the sed script to interpret.  All\n' +
    'remaining arguments are names of input files; if no input files are\nspecified, then the standard input is read.\n\n' +
    'GNU sed home page: <https://www.gnu.org/software/sed/>.\nGeneral help using GNU software: <https://www.gnu.org/gethelp/>.\n';
  const SED_VERSION = 'sed (GNU sed) 4.9\nPackaged by Debian\nCopyright (C) 2022 Free Software Foundation, Inc.\n' +
    'License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\n' +
    'This is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\n' +
    'Written by Jay Fenlason, Tom Lord, Ken Pizzini,\nPaolo Bonzini, Jim Meyering, and Assaf Gordon.\n\n' +
    'This sed program was built with SELinux support.\nSELinux is disabled on this system.\n\n' +
    'GNU sed home page: <https://www.gnu.org/software/sed/>.\nGeneral help using GNU software: <https://www.gnu.org/gethelp/>.\n' +
    'E-mail bug reports to: <bug-sed@gnu.org>.\n';

  /** Index just past the bracket expression that starts at text[i] ('['), or -1 if it is not closed. */
  function skipBracket(text, i) {
    let j = i + 1;
    if (text[j] === '^') j++;
    if (text[j] === ']') j++;
    while (j < text.length && text[j] !== ']') {
      if (text[j] === '[' && /[:.=]/.test(text[j + 1] || '')) {
        const close = text.indexOf(text[j + 1] + ']', j + 2);
        if (close < 0) return -1;
        j = close + 2;
      } else j++;
    }
    return j < text.length ? j + 1 : -1;
  }

  /**
   * Parse a sed script. chunks: [{text, kind: 'e'|'f', name}] — one per -e or -f.
   * Returns {cmds, quiet}: a flat command list in which `{` knows where its `}` is
   * and branches know their target. Throws SedError(message, consumedChars).
   */
  function parseSed(chunks, o) {
    const text = chunks.map((c) => c.text).join('\n');
    const n = text.length;
    let i = 0;
    const cmds = []; const blocks = []; const labels = new Map();
    const fail = (msg, at) => { throw new SedError(msg, at == null ? i : at); };
    const skipBlanks = () => { while (i < n && (text[i] === ' ' || text[i] === '\t')) i++; };
    const readNumber = () => { const m = /^\d+/.exec(text.slice(i)); if (!m) return null; i += m[0].length; return +m[0]; };

    /** Read up to the unescaped delimiter, the way sed's match_slash does. */
    function readDelimited(delim, isRegex, what) {
      let s = '';
      while (i < n) {
        const c = text[i];
        if (c === delim) { i++; return s; }
        if (c === '\\') {
          i++;
          if (i >= n) break;
          const e = text[i++];
          if (e === 'n' && isRegex) s += '\n';
          else if (e === delim && !(delim === '&' && !isRegex)) s += e;
          else if (e === '\n') s += isRegex ? '\n' : '\\\n';
          else s += '\\' + e;
        } else if (c === '[' && isRegex) {
          const end = skipBracket(text, i);
          if (end < 0) { i = n; break; }
          s += text.slice(i, end); i = end;
        } else { s += c; i++; }
      }
      return fail('unterminated ' + what, n);
    }

    const compile = (src, flags) => {
      if (src === '') return null;
      try { return compileRegex(src, { ere: o.ere, icase: flags.icase, multiline: flags.multiline }); }
      catch (e) { if (e instanceof RegexError) return fail(e.message); throw e; }
    };

    function readAddress() {
      const c = text[i];
      if (c >= '0' && c <= '9') {
        const first = readNumber();
        if (text[i] === '~') { i++; return { t: 'step', first, step: readNumber() || 0 }; }
        return { t: 'line', n: first };
      }
      if (c === '$') { i++; return { t: 'last' }; }
      if (c === '/' || c === '\\') {
        let delim = '/';
        if (c === '\\') { delim = text[i + 1]; i += 2; if (delim == null || delim === '\n') return fail('unexpected `,\''); } else i++;
        const src = readDelimited(delim, true, 'address regex');
        const flags = {};
        for (;; i++) {
          if (text[i] === 'I') flags.icase = true;
          else if (text[i] === 'M') flags.multiline = true;
          else break;
        }
        return { t: 're', re: compile(src, flags) };
      }
      return null;
    }

    const readEnd = () => {
      skipBlanks();
      if (i >= n) return;
      const c = text[i];
      if (c === '\n' || c === ';') { i++; return; }
      if (c === '}' || c === '#') return;
      i++;
      fail('extra characters after command');
    };

    const readFilename = () => {
      skipBlanks();
      const start = i;
      while (i < n && text[i] !== '\n') i++;
      const name = text.slice(start, i);
      if (name === '') fail('missing filename in r/R/w/W commands');
      return name;
    };

    const readLabel = () => {
      skipBlanks();
      const start = i;
      while (i < n && !/[\s;]/.test(text[i])) i++;
      return text.slice(start, i);
    };

    /** Text argument of a, i and c: either `a text` or `a\` newline text, with backslash escapes. */
    function readText() {
      skipBlanks();
      if (i >= n) fail('expected \\ after `a\', `c\' or `i\'');
      if (text[i] === '\\') {
        i++;
        if (text[i] === '\n') i++;
        else skipBlanksIfNewline();
        if (i >= n) return '';
      }
      let s = '';
      while (i < n) {
        const c = text[i++];
        if (c === '\n') break;
        if (c === '\\') {
          if (i >= n) break;
          const e = text[i++];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
        } else s += c;
      }
      return s + '\n';
    }
    // `a\` followed by blanks and a newline is the classic form; `a\text` keeps its leading blanks
    function skipBlanksIfNewline() {
      let j = i;
      while (text[j] === ' ' || text[j] === '\t') j++;
      if (text[j] === '\n') i = j + 1;
    }

    function parseReplacement(raw) {
      const parts = []; let lit = '';
      const flush = () => { if (lit) { parts.push({ lit }); lit = ''; } };
      for (let k = 0; k < raw.length; k++) {
        const c = raw[k];
        if (c === '&') { flush(); parts.push({ grp: 0 }); continue; }
        if (c !== '\\') { lit += c; continue; }
        const e = raw[++k];
        if (e === undefined) { lit += '\\'; break; }
        if (/[0-9]/.test(e)) { flush(); parts.push({ grp: +e }); }
        else if (/[LUluE]/.test(e)) { flush(); parts.push({ conv: e }); }
        else if (e === '\n') lit += '\n';
        else {
          const ce = charEscape(raw, k - 1, false);
          if (ce) { lit += ce.ch; k += ce.len - 2; } else lit += e;
        }
      }
      flush();
      return parts;
    }

    function readSubstitute(cmd) {
      const delim = text[i++];
      if (delim === undefined || delim === '\n' || delim === '\\') fail('unterminated `s\' command');
      const src = readDelimited(delim, true, '`s\' command');
      const raw = readDelimited(delim, false, '`s\' command');
      const flags = {}; let num = null; let doneFlags = false;
      while (!doneFlags) {
        if (i >= n) break;
        const c = text[i++];
        if (c === 'g') { if (cmd.g) fail('multiple `g\' options to `s\' command'); cmd.g = true; }
        else if (c === 'p') { if (cmd.p) fail('multiple `p\' options to `s\' command'); cmd.p = true; }
        else if (c === 'i' || c === 'I') flags.icase = true;
        else if (c === 'm' || c === 'M') flags.multiline = true;
        else if (c === 'e') cmd.e = true;
        else if (c >= '0' && c <= '9') {
          if (num != null) fail('multiple number options to `s\' command');
          i--; num = readNumber();
          if (num === 0) fail('number option to `s\' command may not be zero');
        } else if (c === 'w') { cmd.wfile = readFilename(); doneFlags = true; }
        else if (c === '}' || c === '#') { i--; doneFlags = true; }
        else if (c === '\n' || c === ';') doneFlags = true;
        else if (c === ' ' || c === '\t') continue;
        else fail('unknown option to `s\'');
      }
      cmd.num = num || 1;
      cmd.re = compile(src, flags);
      cmd.repl = parseReplacement(raw);
      for (const p of cmd.repl) {
        if (p.grp != null && cmd.re && p.grp > cmd.re.groups) fail('invalid reference \\' + p.grp + ' on `s\' command\'s RHS');
      }
    }

    function readTransliterate(cmd) {
      const delim = text[i++];
      if (delim === undefined || delim === '\n' || delim === '\\') fail('unterminated `y\' command');
      const unescape = (s) => s.replace(/\\(.)/gs, (m, c) => (c === 'n' ? '\n' : c === '\\' ? '\\' : c === 't' ? '\t' : m));
      const src = Array.from(unescape(readDelimited(delim, false, '`y\' command')));
      const dst = Array.from(unescape(readDelimited(delim, false, '`y\' command')));
      if (src.length !== dst.length) fail('strings for `y\' command are different lengths');
      cmd.map = new Map(src.map((ch, k) => [ch, dst[k]]));
    }

    while (true) {
      while (i < n && /[\s;]/.test(text[i])) i++;
      if (i >= n) break;
      const cmd = { a1: null, a2: null, neg: false, active: false, end: 0 };
      cmd.a1 = readAddress();
      if (cmd.a1) {
        skipBlanks();
        if (text[i] === ',') {
          i++; skipBlanks();
          if (text[i] === '+' || text[i] === '~') {
            const t = text[i] === '+' ? 'plus' : 'mult'; i++;
            const k = readNumber();
            if (k == null) fail('expected number after `' + (t === 'plus' ? '+' : '~') + '\'');
            cmd.a2 = { t, n: k };
          } else {
            cmd.a2 = readAddress();
            if (!cmd.a2) fail('unexpected `,\'');
          }
        }
        if (cmd.a1.t === 'line' && cmd.a1.n === 0 && !(cmd.a2 && cmd.a2.t === 're')) { i++; fail('invalid usage of line address 0'); }
        if (cmd.a1.t === 'line' && cmd.a1.n === 0) cmd.active = true;
      }
      skipBlanks();
      while (text[i] === '!') {
        i++;
        if (cmd.neg) fail('multiple `!\'s');
        cmd.neg = true; skipBlanks();
      }
      if (i >= n) fail('missing command', n);
      const c = text[i++];
      cmd.name = c;
      if (cmd.a1 && c === '#') fail('comments don\'t accept any addresses');
      if (cmd.a1 && (c === ':' || c === '}')) fail(c === ':' ? ': doesn\'t want any addresses' : 'unexpected `,\'');
      if (cmd.a2 && /[=aiqQrR]/.test(c) ) fail('command only uses one address');
      switch (c) {
        case '#': while (i < n && text[i] !== '\n') i++; continue;
        case '{': blocks.push(cmds.length); cmds.push(cmd); continue;
        case '}':
          if (!blocks.length) fail('unexpected `}\'');
          cmds[blocks.pop()].end = cmds.length;
          cmds.push(cmd); readEnd(); continue;
        case ':': {
          const label = readLabel();
          if (label === '') fail('":" lacks a label');
          labels.set(label, cmds.length); cmds.push(cmd); continue;
        }
        case 'a': case 'i': case 'c': cmd.text = readText(); break;
        case 'b': case 't': case 'T': cmd.label = readLabel(); readEnd(); break;
        case 'r': case 'R': case 'w': case 'W': cmd.file = readFilename(); break;
        case 's': readSubstitute(cmd); break;
        case 'y': readTransliterate(cmd); readEnd(); break;
        case 'q': case 'Q': case 'l': case 'L': skipBlanks(); cmd.arg = readNumber(); readEnd(); break;
        case '=': case 'd': case 'D': case 'g': case 'G': case 'h': case 'H': case 'n': case 'N': case 'p': case 'P':
        case 'x': case 'z': case 'F': readEnd(); break;
        case 'v': readLabel(); readEnd(); break;
        default: fail('unknown command: `' + c + '\'');
      }
      cmds.push(cmd);
    }
    if (blocks.length) fail('unmatched `{\'', 0);
    for (const cmd of cmds) {
      if ((cmd.name === 'b' || cmd.name === 't' || cmd.name === 'T') && cmd.label !== '') {
        if (!labels.has(cmd.label)) throw new SedError('can\'t find label for jump to `' + cmd.label + '\'', -1);
        cmd.target = labels.get(cmd.label);
      } else if (cmd.name === 'b' || cmd.name === 't' || cmd.name === 'T') cmd.target = cmds.length;
    }
    return { cmds, text };
  }

  /** Where `pos` characters into the joined script lies: [message prefix] for sed's error lines. */
  function sedErrorPrefix(chunks, pos) {
    let offset = 0; const starts = chunks.map((c) => { const s = offset; offset += c.text.length + 1; return s; });
    let k = 0;
    for (let j = 0; j < chunks.length; j++) if (starts[j] < pos || j === 0) k = j;
    const chunk = chunks[k]; const within = Math.min(pos - starts[k], chunk.text.length + 1);
    if (chunk.kind === 'f') {
      const line = chunk.text.slice(0, Math.max(0, within)).split('\n').length;
      return 'file ' + chunk.name + ' line ' + line + ': ';
    }
    const nth = chunks.slice(0, k + 1).filter((c) => c.kind === 'e').length;
    return '-e expression #' + nth + ', char ' + Math.max(0, within) + ': ';
  }

  /** Output stream with sed's "missing newline" bookkeeping. */
  class SedOut {
    constructor(write) { this.write = write; this.missing = false; }
    raw(s) { if (this.missing) { this.write('\n'); this.missing = false; } this.write(s); }
    line(s, chomped, sep) {
      this.raw(s);
      if (chomped) this.write(sep); else this.missing = true;
    }
  }

  /** The input lines of all operands, read lazily so that errors appear in order. */
  class SedInput {
    constructor(ctx, files, o, stdin, report) {
      Object.assign(this, { ctx, files, o, stdin, report, next: 0, queue: [], cur: null, pos: 0, lineNo: 0, chomped: true, fileName: '-' });
    }
    split(text) {
      const sep = this.o.sep;
      if (text === '') return { lines: [], lastChomped: true };
      const lines = text.split(sep);
      const lastChomped = lines[lines.length - 1] === '';
      if (lastChomped) lines.pop();
      return { lines, lastChomped };
    }
    /** Load the next operand into the queue. Returns false when there are no more. */
    load() {
      while (this.next < this.files.length) {
        const name = this.files[this.next++];
        let text;
        if (name === '-') text = this.stdin;
        else {
          try { text = this.ctx.fs.read(name); }
          catch (e) {
            if (!isFsError(e)) throw e;
            this.report(name, e);
            continue;
          }
        }
        this.queue.push(Object.assign({ name }, this.split(text)));
        return true;
      }
      return false;
    }
    open() {
      if (!this.queue.length && !this.load()) return false;
      this.cur = this.queue.shift(); this.pos = 0;
      if (this.o.separate) this.lineNo = 0;
      this.fileName = this.cur.name;
      if (this.onOpen) this.onOpen(this.cur.name);
      return true;
    }
    close() { if (this.onClose) this.onClose(this.cur.name); this.cur = null; }
    read() {
      for (;;) {
        if (!this.cur && !this.open()) return null;
        if (this.pos < this.cur.lines.length) {
          const line = this.cur.lines[this.pos++];
          this.chomped = this.pos < this.cur.lines.length || this.cur.lastChomped;
          this.lineNo++;
          return line;
        }
        this.close();
      }
    }
    isLast() {
      if (this.cur && this.pos < this.cur.lines.length) return false;
      if (this.o.separate) return true;
      for (;;) {
        if (this.queue.some((f) => f.lines.length)) return false;
        if (!this.load()) return true;
      }
    }
    /** Drop the rest of the input (the q command). */
    finish() { if (this.cur) this.close(); }
  }

  const L_ESC = { '\\': '\\\\', '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v' };

  /** Text printed by the `l` command. */
  function listLine(s, width) {
    let out = ''; let col = 0;
    const put = (piece) => {
      if (width > 1 && col + piece.length > width - 1) { out += '\\\n'; col = 0; }
      out += piece; col += piece.length;
    };
    for (const b of U.toBytes(s)) {
      const ch = String.fromCharCode(b);
      if (L_ESC[ch]) put(L_ESC[ch]);
      else if (b >= 32 && b < 127) put(ch);
      else put('\\' + b.toString(8).padStart(3, '0'));
    }
    return out + '$\n';
  }

  /** Expand the replacement of an s command for one match. */
  function expandReplacement(parts, m) {
    let out = ''; let mode = ''; let once = '';
    const add = (s) => {
      if (!s) return;
      if (mode === 'U') s = s.toUpperCase(); else if (mode === 'L') s = s.toLowerCase();
      if (once) { s = (once === 'u' ? s[0].toUpperCase() : s[0].toLowerCase()) + s.slice(1); once = ''; }
      out += s;
    };
    for (const p of parts) {
      if (p.lit != null) add(p.lit);
      else if (p.grp != null) add(m[p.grp] || '');
      else if (p.conv === 'E') { mode = ''; once = ''; }
      else if (p.conv === 'U' || p.conv === 'L') mode = p.conv;
      else once = p.conv;
    }
    return out;
  }

  class SedMachine {
    constructor(ctx, prog, o, input, out, files) {
      Object.assign(this, { ctx, cmds: prog.cmds, o, input, out, files, ps: '', hs: '', replaced: false, lastRe: null, appends: [], quit: null, steps: 0, wfiles: new Map(), rfiles: new Map() });
    }
    get sep() { return this.o.sep; }
    emit(s) { this.out.raw(s); }
    printPs() { this.out.line(this.ps, this.input.chomped, this.sep); }

    flushAppends() {
      for (const a of this.appends) {
        if (a.text != null) this.emit(a.text);
        else if (a.file != null) {
          let data = null;
          try { data = a.file === '/dev/stdin' ? this.o.stdinText : this.ctx.fs.read(a.file); } catch (e) { if (!isFsError(e)) throw e; }
          if (data) this.emit(data.endsWith('\n') ? data : data + '\n');
        }
      }
      this.appends = [];
    }

    wfile(name) {
      if (name === '/dev/stdout') return this.o.stdout;
      if (name === '/dev/stderr') return this.o.stderrOut;
      let w = this.wfiles.get(name);
      if (!w) {
        let buf = '';
        try { this.ctx.fs.write(name, ''); } catch (e) { if (!isFsError(e)) throw e; throw new SedError('couldn\'t open file ' + name + ': ' + e.message, -2); }
        w = new SedOut((s) => { buf += s; this.ctx.fs.write(name, buf); });
        this.wfiles.set(name, w);
      }
      return w;
    }

    matchAddr(a) {
      const input = this.input;
      switch (a.t) {
        case 'line': return input.lineNo === a.n;
        case 'last': return input.isLast();
        case 'step': return a.step <= 0 ? input.lineNo === a.first : input.lineNo >= a.first && (input.lineNo - a.first) % a.step === 0;
        default: return this.regexFor(a.re).test(this.ps);
      }
    }
    regexFor(re) {
      if (re) { this.lastRe = re; return re; }
      if (!this.lastRe) throw new SedError('no previous regular expression', -3);
      return this.lastRe;
    }

    matches(c) {
      let r;
      if (!c.a1) r = true;
      else if (!c.a2) r = this.matchAddr(c.a1);
      else r = this.matchRange(c);
      return c.neg ? !r : r;
    }
    matchRange(c) {
      const l = this.input.lineNo; const a2 = c.a2;
      if (!c.active) {
        if (!this.matchAddr(c.a1)) return false;
        if (a2.t === 'line') { if (a2.n <= l) return true; c.end = a2.n; }
        else if (a2.t === 'plus') { if (a2.n === 0) return true; c.end = l + a2.n; }
        else if (a2.t === 'mult') { if (a2.n <= 0 || l % a2.n === 0) return true; c.end = Math.ceil(l / a2.n) * a2.n; }
        else if (a2.t === 'last' && this.input.isLast()) return true;
        c.active = true;
        return true;
      }
      if (a2.t === 'line' || a2.t === 'plus' || a2.t === 'mult') {
        if (l >= c.end) c.active = false;
        return l <= c.end;
      }
      if (this.matchAddr(a2)) c.active = false;
      return true;
    }

    substitute(c) {
      const re = this.regexFor(c.re);
      const ps = this.ps; let out = ''; let copy = 0; let pos = 0; let prevEnd = -1; let count = 0; let did = false;
      while (pos <= ps.length) {
        const m = re.exec(ps, pos);
        if (!m) break;
        const start = m.index; const end = start + m[0].length;
        if (m[0] === '' && start === prevEnd) { pos = start + 1; continue; }
        count++;
        prevEnd = end; pos = end > start ? end : end + 1;
        if (count < c.num) continue;
        out += ps.slice(copy, start) + expandReplacement(c.repl, m);
        copy = end; did = true;
        if (!c.g) break;
      }
      if (!did) return false;
      this.ps = out + ps.slice(copy);
      return true;
    }

    /** Read the next line into the pattern space (n and N). Returns false at end of input. */
    nextLine(append) {
      if (this.input.isLast()) return false;
      this.flushAppends();
      const line = this.input.read();
      this.ps = append ? this.ps + '\n' + line : line;
      return true;
    }

    /** Run the script over every line. Resolves to nothing; this.quit holds an exit status when q was used. */
    async run() {
      const cmds = this.cmds; const quiet = this.o.quiet;
      let restart = false;
      for (;;) {
        if (!restart) {
          const line = this.input.read();
          if (line == null) break;
          this.ps = line; this.replaced = false;
        }
        restart = false;
        let autoprint = !quiet; let pc = 0; let stop = false;
        while (pc < cmds.length) {
          if ((++this.steps & 0x3fff) === 0) { this.o.flush(); await breathe(this.ctx); }
          const c = cmds[pc];
          if (!this.matches(c)) { pc = c.name === '{' ? c.end + 1 : pc + 1; continue; }
          pc++;
          switch (c.name) {
            case '=': this.emit(this.input.lineNo + '\n'); break;
            case 'a': this.appends.push({ text: c.text }); break;
            case 'i': this.emit(c.text); break;
            case 'c':
              if (!c.a2 || !c.active || c.neg) this.emit(c.text);
              autoprint = false; pc = cmds.length; break;
            case 'd': autoprint = false; pc = cmds.length; break;
            case 'D': {
              const nl = this.ps.indexOf('\n');
              autoprint = false; pc = cmds.length;
              if (nl >= 0) { this.ps = this.ps.slice(nl + 1); restart = true; }
              break;
            }
            case 'e': break;
            case 'F': this.emit((this.input.fileName === '-' ? '-' : this.input.fileName) + '\n'); break;
            case 'g': this.ps = this.hs; break;
            case 'G': this.ps += '\n' + this.hs; break;
            case 'h': this.hs = this.ps; break;
            case 'H': this.hs += '\n' + this.ps; break;
            case 'x': { const t = this.ps; this.ps = this.hs; this.hs = t; break; }
            case 'l': this.emit(listLine(this.ps, c.arg != null ? c.arg : this.o.lineLen)); break;
            case 'n':
              if (this.input.isLast()) { stop = true; pc = cmds.length; break; }
              if (!quiet) this.printPs();
              this.nextLine(false);
              break;
            case 'N':
              if (this.input.isLast()) { stop = true; pc = cmds.length; break; }
              this.nextLine(true);
              break;
            case 'p': this.printPs(); break;
            case 'P': { const nl = this.ps.indexOf('\n'); this.out.line(nl < 0 ? this.ps : this.ps.slice(0, nl), true, this.sep); break; }
            case 'q': this.quit = c.arg || 0; stop = true; pc = cmds.length; break;
            case 'Q': this.quit = c.arg || 0; autoprint = false; stop = true; this.appends = []; pc = cmds.length; break;
            case 'r': this.appends.push({ file: c.file }); break;
            case 'R': {
              let r = this.rfiles.get(c.file);
              if (!r) {
                let data = '';
                try { data = this.ctx.fs.read(c.file); } catch (e) { if (!isFsError(e)) throw e; }
                r = { lines: data === '' ? [] : data.replace(/\n$/, '').split('\n'), pos: 0 };
                this.rfiles.set(c.file, r);
              }
              if (r.pos < r.lines.length) this.appends.push({ text: r.lines[r.pos++] + '\n' });
              break;
            }
            case 's':
              if (this.substitute(c)) {
                this.replaced = true;
                if (c.p) this.printPs();
                if (c.wfile) this.wfile(c.wfile).line(this.ps, true, this.sep);
              }
              break;
            case 't': if (this.replaced) { this.replaced = false; pc = c.target; } break;
            case 'T': if (!this.replaced) pc = c.target; else this.replaced = false; break;
            case 'b': pc = c.target; break;
            case 'w': this.wfile(c.file).line(this.ps, true, this.sep); break;
            case 'W': { const nl = this.ps.indexOf('\n'); this.wfile(c.file).line(nl < 0 ? this.ps : this.ps.slice(0, nl), true, this.sep); break; }
            case 'y': this.ps = Array.from(this.ps).map((ch) => (this.cmdMap(c, ch))).join(''); break;
            case 'z': this.ps = ''; break;
            default: break;   // { } : # v
          }
        }
        if (autoprint) this.printPs();
        this.flushAppends();
        if (stop) break;
      }
    }
    cmdMap(c, ch) { return c.map.has(ch) ? c.map.get(ch) : ch; }
  }

  /** Command-line options of sed, parsed the way getopt_long permutes them. */
  function parseSedArgs(args) {
    const o = { chunks: [], files: [], quiet: false, ere: false, separate: false, inPlace: null, sep: '\n', lineLen: 70, posix: false };
    const longs = { quiet: 'n', silent: 'n', debug: '', 'expression': 'e:', file: 'f:', 'follow-symlinks': '', 'in-place': 'i?', 'line-length': 'l:', posix: 'P', 'regexp-extended': 'E', separate: 's', sandbox: '', unbuffered: 'u', 'null-data': 'z', 'zero-terminated': 'z', binary: 'b', help: 'help', version: 'version' };
    const apply = (key, val) => {
      switch (key) {
        case 'n': o.quiet = true; break;
        case 'e': o.chunks.push({ text: val, kind: 'e' }); break;
        case 'f': o.chunks.push({ file: val, kind: 'f' }); break;
        case 'i': o.inPlace = val || ''; o.separate = true; break;
        case 'l': o.lineLen = parseInt(val, 10); if (!(o.lineLen >= 0)) return 'invalid line length: ' + val; break;
        case 'E': case 'r': o.ere = true; break;
        case 's': o.separate = true; break;
        case 'z': o.sep = '\0'; break;
        case 'P': o.posix = true; break;
        case 'help': o.help = true; break;
        case 'version': o.version = true; break;
        default: break;   // u b and the long-only switches change nothing here
      }
      return null;
    };
    let onlyOperands = false;
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (onlyOperands || a === '-' || a[0] !== '-') { o.files.push(a); continue; }
      if (a === '--') { onlyOperands = true; continue; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('='); const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
        const cands = Object.keys(longs).filter((l) => l === name);
        const matched = cands.length ? cands : Object.keys(longs).filter((l) => l.startsWith(name));
        if (matched.length !== 1) return { error: matched.length ? "option '--" + name + "' is ambiguous; possibilities:" + matched.map((m) => " '--" + m + "'").join('') : "unrecognized option '--" + name + "'" };
        const full = matched[0]; const kind = longs[full];
        let val = eq < 0 ? null : a.slice(eq + 1);
        if (kind.endsWith(':')) {
          if (val == null) { if (k + 1 >= args.length) return { error: "option '--" + full + "' requires an argument" }; val = args[++k]; }
        } else if (val != null && kind !== 'i?') return { error: "option '--" + full + "' doesn't allow an argument" };
        const bad = apply(kind === 'i?' ? 'i' : kind.replace(':', '') || full, val);
        if (bad) return { error: bad, plain: true };
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (ch === 'i') { apply('i', a.slice(j + 1)); break; }
        if ('efl'.includes(ch)) {
          let val = a.slice(j + 1);
          if (!val) { if (k + 1 >= args.length) return { error: "option requires an argument -- '" + ch + "'" }; val = args[++k]; }
          const bad = apply(ch, val);
          if (bad) return { error: bad, plain: true };
          break;
        }
        if ('nErszubV'.includes(ch) && ch !== 'V') { apply(ch === 'r' ? 'E' : ch, null); continue; }
        return { error: "invalid option -- '" + ch + "'" };
      }
    }
    return o;
  }

  async function runSed(ctx) {
    const o = parseSedArgs(ctx.args);
    if (o.error) {
      if (o.plain) { ctx.err('sed: ' + o.error + '\n'); return 1; }
      ctx.err('sed: ' + o.error + '\n' + SED_USAGE);
      return 1;
    }
    if (o.help) { ctx.out(SED_USAGE); return 0; }
    if (o.version) { ctx.out(SED_VERSION); return 0; }
    if (!o.chunks.length) {
      if (!o.files.length) { ctx.err(SED_USAGE); return 1; }
      o.chunks.push({ text: o.files.shift(), kind: 'e' });
    }
    for (const ch of o.chunks) {
      if (ch.kind !== 'f') continue;
      try {
        ch.text = ch.file === '-' ? await stdinText(ctx) : ctx.fs.read(ch.file);
        ch.name = ch.file;
        if (ch.text.endsWith('\n')) ch.text = ch.text.slice(0, -1);
      } catch (e) {
        if (!isFsError(e)) throw e;
        ctx.err('sed: couldn\'t open file ' + ch.file + ': ' + e.message + '\n');
        return 1;
      }
    }
    if (/^#n(\n|$)/.test(o.chunks[0].text)) o.quiet = true;
    let prog;
    try { prog = parseSed(o.chunks, o); }
    catch (e) {
      if (!(e instanceof SedError)) throw e;
      if (e.pos === -1) { ctx.err('sed: ' + e.message + '\n'); return 4; }
      else ctx.err('sed: ' + sedErrorPrefix(o.chunks, e.pos) + e.message + '\n');
      return 1;
    }

    const sink = new Sink(ctx);
    const stdout = new SedOut((s) => sink.write(s));
    const stderrOut = new SedOut((s) => ctx.err(s));
    let status = 0;
    const files = o.files.length ? o.files : ['-'];
    if (o.inPlace != null && !o.files.length) { ctx.err('sed: no input files\n'); return 4; }
    const stdinData = files.includes('-') && o.inPlace == null ? await stdinText(ctx) : '';
    const report = (name, e) => {
      sink.flush();
      if (e.code === 'EISDIR') { ctx.err('sed: ' + (o.inPlace != null ? "couldn't edit " + name + ': not a regular file' : 'read error on ' + name + ': ' + e.message) + '\n'); status = 4; }
      else { ctx.err('sed: can\'t read ' + name + ': ' + e.message + '\n'); if (!status) status = 2; }
    };
    const input = new SedInput(ctx, files, { sep: o.sep, separate: o.separate }, stdinData, report);
    let out = stdout; let fileBuf = '';
    if (o.inPlace != null) {
      out = new SedOut((s) => { fileBuf += s; });
      input.onOpen = () => { fileBuf = ''; out.missing = false; };
      input.onClose = (name) => {
        const original = ctx.fs.read(name);
        if (o.inPlace) ctx.fs.write(backupName(name, o.inPlace), original);
        ctx.fs.write(name, fileBuf);
      };
    }
    const machine = new SedMachine(ctx, prog, Object.assign({}, o, { stdout, stderrOut, stdinText: stdinData, flush: () => sink.flush() }), input, out);
    try { await machine.run(); }
    catch (e) {
      if (!(e instanceof SedError)) throw e;
      sink.flush();
      ctx.err('sed: ' + (e.pos === -3 ? '-e expression #1, char 0: ' : '') + e.message + '\n');
      return e.pos === -3 ? 1 : 4;
    } finally { sink.flush(); }
    input.finish();
    sink.flush();
    return machine.quit != null ? machine.quit : status;
  }

  function backupName(name, suffix) {
    const slash = name.lastIndexOf('/');
    const dir = slash < 0 ? '' : name.slice(0, slash + 1); const base = name.slice(slash + 1);
    if (!suffix.includes('*')) return name + suffix;
    const b = suffix.replace(/\*/g, base);
    return b.includes('/') ? b : dir + b;
  }

  K.cmd.register({
    name: 'sed', pkg: 'sed', section: 1, path: '/usr/bin/sed',
    summary: 'stream editor for filtering and transforming text',
    synopsis: 'sed [OPTION]... {script-only-if-no-other-script} [input-file]...',
    man: manPage({
      desc: 'Sed is a stream editor. It reads each input line into the pattern space, runs the script\'s commands on it,\nand prints the result. The script is the first operand unless -e or -f is used.\n\n' +
        'Commands: s/RE/TEXT/FLAGS substitutes (flags g, p, i, N, w FILE; & and \\1..\\9 in TEXT), d deletes the line,\np prints it, q quits, a/i/c append, insert or change text, y/abc/xyz/ translates characters, = prints the\nline number, n/N read the next line, h/H/g/G/x use the hold space, b/t/T branch, and { } groups commands.\n\n' +
        'Addresses select lines: N, $, /RE/, N,M, N,+M, N,~M, FIRST~STEP and 0,/RE/; ! negates. Regular expressions\nare basic by default and extended with -E.',
      opts: [
        ['-n, --quiet, --silent', 'Suppress automatic printing of the pattern space.'],
        ['-e SCRIPT, --expression=SCRIPT', 'Add the commands in SCRIPT. May be repeated.'],
        ['-f FILE, --file=FILE', 'Add the commands in FILE.'],
        ['-E, -r, --regexp-extended', 'Use extended regular expressions.'],
        ['-i[SUFFIX], --in-place[=SUFFIX]', 'Edit files in place; keep a backup when SUFFIX is given.'],
        ['-s, --separate', 'Treat each file separately: line numbers and $ restart for every file.'],
        ['-z, --null-data', 'Separate lines by NUL characters instead of newlines.'],
        ['-l N, --line-length=N', 'Wrap the output of the l command at N characters.'],
      ],
      exit: '0 on success, 1 for an invalid command or option, 2 if an input file could not be read, 4 for an I/O error.\nq and Q can set the exit status.',
      examples: [
        ["sed -n '2,4p' /etc/passwd", 'Print lines 2 to 4 only.'],
        ["sed 's/student/kali/g' notes.txt", 'Replace every "student" with "kali".'],
        ["sed -i.bak '/^#/d' hosts.txt", 'Delete comment lines in place and keep hosts.txt.bak.'],
      ],
    }),
    run: runSed,
  });

  K.text2 = { compileRegex, RegexError, breathe, stdinText, Sink, manPage };
})(typeof globalThis !== 'undefined' ? globalThis : this);
