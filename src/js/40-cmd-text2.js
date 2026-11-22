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
        case 'e': skipBlanks(); cmd.file = text.slice(i, (text.indexOf('\n', i) + 1 || n + 1) - 1); i += cmd.file.length; break;
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
      Object.assign(this, { ctx, cmds: prog.cmds, o, input, out, files, ps: '', hs: '', psChomped: true, hsChomped: true, replaced: false, lastRe: null, appends: [], quit: null, steps: 0, wfiles: new Map(), rfiles: new Map() });
    }
    get sep() { return this.o.sep; }
    emit(s) { this.out.raw(s); }
    printPs() { this.out.line(this.ps, this.psChomped, this.sep); }

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

    /** Output of a shell command (the e command and the s///e flag). */
    async shell(cmd) {
      this.o.flush();
      const r = await this.ctx.run(['sh', '-c', cmd]);
      if (r.err) this.ctx.err(r.err);
      return r.out;
    }

    /** Read the next line into the pattern space (n and N). Returns false at end of input. */
    nextLine(append) {
      if (this.input.isLast()) return false;
      this.flushAppends();
      const line = this.input.read();
      this.ps = append ? this.ps + '\n' + line : line;
      this.psChomped = this.input.chomped;
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
          this.ps = line; this.psChomped = this.input.chomped; this.replaced = false;
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
            case 'e': {
              const r = await this.shell(c.file || this.ps);
              if (c.file) this.emit(r); else this.ps = r.replace(/\n$/, '');
              break;
            }
            case 'F': this.emit((this.input.fileName === '-' ? '-' : this.input.fileName) + '\n'); break;
            case 'g': this.ps = this.hs; this.psChomped = this.hsChomped; break;
            case 'G': this.ps += '\n' + this.hs; this.psChomped = this.psChomped || this.hsChomped; break;
            case 'h': this.hs = this.ps; this.hsChomped = this.psChomped; break;
            case 'H': this.hs += '\n' + this.ps; this.hsChomped = this.hsChomped || this.psChomped; break;
            case 'x': {
              const t = this.ps; this.ps = this.hs; this.hs = t;
              const k = this.psChomped; this.psChomped = this.hsChomped; this.hsChomped = k;
              break;
            }
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
                if (c.e) this.ps = (await this.shell(this.ps)).replace(/\n$/, '');
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
        return 4;
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


  /* =================================================================== awk
   * Strings are byte strings (one JavaScript character per byte), as in mawk:
   * length() counts bytes and substr() cuts between them. Program text and
   * input are converted on the way in and the output on the way out.
   */

  const toBin = (s) => {
    if (!/[^\x00-\x7f]/.test(s)) return s;
    let r = '';
    for (const b of new TextEncoder().encode(s)) r += String.fromCharCode(b);
    return r;
  };
  const fromBin = (s) => (/[^\x00-\x7f]/.test(s) ? new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0))) : s);

  class AwkSyntax extends Error {
    constructor(msg, line) { super(msg); this.line = line; }
  }
  /** A run time error: mawk prints it with the position in the input. `partial` is output produced before it. */
  class AwkRuntime extends Error {
    constructor(msg, partial) { super(msg); this.partial = partial; }
  }
  /** A fatal error without the run time banner (unreadable file, bad option). */
  class AwkFatal extends Error {}
  /** Thrown inside the synchronous evaluator when it needs the event loop (a command, a terminal read). */
  class Blocked extends Error {
    constructor(run) { super('blocked'); this.run = run; }
  }

  /* ------------------------------------------------------------ values
   * A value is a JavaScript number, a string, undefined (never assigned) or a
   * StrNum: input text that looks like a number and compares as one.
   */
  class StrNum {
    constructor(s, n) { this.s = s; this.n = n; }
  }
  const NUM_PREFIX = /^[ \t\n\r\f\v]*([+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan))/i;
  const NUM_FULL = /^[ \t\n\r\f\v]*[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan)[ \t\n\r\f\v]*$/i;

  function parseNum(text) {
    const lower = text.toLowerCase();
    const neg = lower[0] === '-';
    const body = lower[0] === '-' || lower[0] === '+' ? lower.slice(1) : lower;
    let v;
    if (body.startsWith('0x')) v = parseInt(body, 16);
    else if (body.startsWith('inf')) v = Infinity;
    else if (body === 'nan') v = NaN;
    else v = parseFloat(body);
    return neg ? -v : v;
  }
  /** Numeric value of the longest numeric prefix of a string (0 when there is none). */
  function strToNum(s) {
    const m = NUM_PREFIX.exec(s);
    return m ? parseNum(m[1]) : 0;
  }
  /** Input text as a value: a StrNum when it looks like a number. */
  function inputValue(s) {
    return NUM_FULL.test(s) ? new StrNum(s, strToNum(s)) : s;
  }
  const toNum = (v) => (typeof v === 'number' ? v : v === undefined ? 0 : typeof v === 'string' ? strToNum(v) : v.n);
  const isNumeric = (v) => typeof v === 'number' || v === undefined || v instanceof StrNum;

  /** Associative array whose for-in order imitates mawk's hash table. */
  class AwkArray {
    constructor() { this.m = new Map(); this.peak = 0; this.counter = 0; }
    get(k) { const e = this.m.get(k); return e ? e.v : undefined; }
    get size() { return this.m.size; }
    has(k) { return this.m.has(k); }
    /** The entry for a key, created (unset) when missing. `isInt`: created by an integer subscript. */
    ref(k, isInt) {
      let e = this.m.get(k);
      if (!e) {
        e = { v: undefined, int: isInt, seq: ++this.counter };
        this.m.set(k, e);
        if (this.m.size > this.peak) this.peak = this.m.size;
      }
      return e;
    }
    delete(k) { this.m.delete(k); }
    clear() { this.m.clear(); }
    /** Keys in the order mawk's `for (k in a)` visits them: by FNV-1a bucket, then by list position. */
    keys() {
      let size = 64;
      while (this.peak > size * 12) size *= 2;
      const rows = [];
      for (const [k, e] of this.m) rows.push({ k, e, b: fnv1a(k) & (size - 1) });
      const mask = size - 1;
      rows.sort((x, y) => {
        if (x.b !== y.b) return x.b - y.b;
        if (x.e.int !== y.e.int) return x.e.int ? -1 : 1;
        if (x.e.int) return ((+y.k) & mask) - ((+x.k) & mask) || x.e.seq - y.e.seq;
        return y.e.seq - x.e.seq;
      });
      return rows.map((r) => r.k);
    }
  }
  function fnv1a(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) & 255; h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

  /* ------------------------------------------------------- number formatting */
  const trimZeros = (s) => (s.indexOf('.') < 0 ? s : s.replace(/\.?0+$/, ''));
  const nonFinite = (x, upper) => {
    const s = Number.isNaN(x) ? '-nan' : x < 0 ? '-inf' : 'inf';
    return upper ? s.toUpperCase() : s;
  };
  /** printf("%.<prec>f"): JavaScript rounds exact ties up, C rounds them to even. */
  function fixed(x, prec) {
    if (Math.abs(x) >= 1e21) return BigInt(x).toString() + (prec ? '.' + '0'.repeat(prec) : '');
    const long = x.toFixed(Math.min(100, prec + 25));
    const base = long.slice(0, long.length - 25);
    if (/^50{24}$/.test(long.slice(-25)) && prec + 25 <= 100) {
      const kept = base.replace(/\.$/, '');
      if ((+kept[kept.length - 1]) % 2 === 0) return kept;
    }
    return x.toFixed(prec);
  }
  function expo(x, prec, upper) {
    const s = x.toExponential(prec).replace(/e([+-])(\d)$/, 'e$10$2');
    return upper ? s.toUpperCase() : s;
  }
  function general(x, prec, alt, upper) {
    const p = prec === 0 ? 1 : prec;
    if (x === 0) return alt ? (0).toFixed(p - 1) : '0';
    const exp = parseInt(x.toExponential(p - 1).split('e')[1], 10);
    if (exp < -4 || exp >= p) {
      const parts = expo(x, p - 1, upper).split(upper ? 'E' : 'e');
      return (alt ? parts[0] : trimZeros(parts[0])) + (upper ? 'E' : 'e') + parts[1];
    }
    const f = fixed(x, Math.max(0, p - 1 - exp));
    return alt ? f : trimZeros(f);
  }
  const INT_MIN = -(2n ** 63n); const UINT_MAX = 2n ** 64n - 1n;
  const toBig = (x) => (Number.isNaN(x) ? INT_MIN : x >= 1.8446744073709552e19 ? UINT_MAX : x <= -9.223372036854776e18 ? INT_MIN : BigInt(Math.trunc(x)));

  /** Format one conversion. Returns the text before padding to the field width. */
  function convert(conv, spec, v) {
    const { flags, prec } = spec;
    const sign = (x, s) => (x < 0 || Object.is(x, -0) ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + s;
    switch (conv) {
      case 'd': case 'i': {
        const n = toBig(toNum(v)); let digits = (n < 0n ? -n : n).toString();
        if (prec != null) digits = digits.padStart(prec, '0');
        return { text: (n < 0n ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + digits, numeric: prec == null };
      }
      case 'o': case 'x': case 'X': case 'u': {
        let n = toBig(toNum(v)); if (n < 0n) n += 2n ** 64n;
        let digits = n.toString(conv === 'u' ? 10 : conv === 'o' ? 8 : 16);
        if (conv === 'X') digits = digits.toUpperCase();
        if (prec != null) digits = digits.padStart(prec, '0');
        if (flags.includes('#') && n !== 0n) digits = (conv === 'o' ? '0' : conv === 'x' ? '0x' : conv === 'X' ? '0X' : '') + digits;
        return { text: digits, numeric: prec == null };
      }
      case 'e': case 'E': case 'f': case 'F': case 'g': case 'G': {
        const x = toNum(v); const upper = conv === 'E' || conv === 'F' || conv === 'G';
        if (!isFinite(x)) return { text: nonFinite(x, upper), numeric: false };
        const p = prec == null ? 6 : prec; const a = Math.abs(x);
        const body = conv === 'f' || conv === 'F' ? fixed(a, p) : conv === 'e' || conv === 'E' ? expo(a, p, upper) : general(a, p, flags.includes('#'), upper);
        return { text: sign(x, body), numeric: true };
      }
      case 'c': {
        if (typeof v === 'string') return { text: v === '' ? '\0' : v[0], numeric: false };
        return { text: String.fromCharCode(toNum(v) & 255), numeric: false };
      }
      default: {
        const s = typeof v === 'string' ? v : toStrBasic(v);
        return { text: prec != null ? s.slice(0, prec) : s, numeric: false };
      }
    }
  }
  /** String value of a number or StrNum with the default CONVFMT (used where no runtime is at hand). */
  function toStrBasic(v) {
    if (v === undefined) return '';
    if (typeof v === 'string') return v;
    if (v instanceof StrNum) return v.s;
    return numberToString(v, '%.6g');
  }
  const printfError = (msg, partial) => new AwkRuntime(msg, partial);

  /**
   * sprintf for awk. `args` are values; `who` names the function in error messages.
   * Raises a run time error (with the text produced so far) like mawk.
   */
  function sprintf(fmt, args, who) {
    let out = ''; let ai = 0; let n = 0;
    for (let i = 0; i < fmt.length; i++) {
      const c = fmt[i];
      if (c !== '%') { out += c; continue; }
      if (fmt[i + 1] === '%') { out += '%'; i++; continue; }
      n++;
      const m = /^%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?([a-zA-Z%]?)/.exec(fmt.slice(i));
      const next = () => {
        if (ai >= args.length) throw printfError('not enough arguments passed to ' + who + '("' + fmt + '")', out);
        return args[ai++];
      };
      let flags = m[1]; let width = m[2]; let prec = m[3];
      if (width === '*') { width = toNum(next()); if (width < 0) { flags += '-'; width = -width; } } else width = width ? +width : 0;
      if (prec === '*') prec = Math.max(0, toNum(next())); else if (prec != null) prec = prec === '' ? 0 : +prec;
      const conv = m[4];
      if (!conv || !/[diouxXeEfFgGcs]/.test(conv)) throw printfError('improper conversion(number ' + n + ') in ' + who + '("' + fmt + '")', out);
      const r = convert(conv, { flags, prec }, next());
      let text = r.text;
      if (text.length < width) {
        if (flags.includes('-')) text = text.padEnd(width);
        else if (flags.includes('0') && r.numeric !== false && conv !== 's' && conv !== 'c') {
          const sg = /^[-+ ]|^0[xX]/.exec(text);
          const head = sg ? sg[0] : '';
          text = head + text.slice(head.length).padStart(width - head.length, '0');
        } else text = text.padStart(width);
      }
      out += text;
      i += m[0].length - 1;
    }
    return out;
  }

  /** Number to string: integers print as integers, other numbers with CONVFMT or OFMT. */
  function numberToString(n, fmt) {
    if (Number.isInteger(n)) {
      if (Math.abs(n) < 1e15) return String(n);
      if (n >= -9223372036854775808 && n <= 18446744073709551616) return (n >= 18446744073709551616 ? UINT_MAX : BigInt(n)).toString();
    }
    if (!isFinite(n)) return nonFinite(n, false);
    return sprintf(fmt, [n], 'sprintf');
  }

  /** Process the backslash escapes of a command line assignment or -F value (mawk's rm_escape). */
  function unescapeArg(s) {
    return s.replace(/\\(?:([0-7]{1,3})|(x[0-9a-fA-F]{1,2})|([\s\S]))/g, (m, oct, hex, ch) => {
      if (oct) return String.fromCharCode(parseInt(oct, 8) & 255);
      if (hex) return String.fromCharCode(parseInt(hex.slice(1), 16));
      const map = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', a: '\x07', b: '\b', '\\': '\\', '"': '"' };
      return map[ch] != null ? map[ch] : m;
    });
  }

  /* ------------------------------------------------------------------ lexer */
  const AWK_KEYWORDS = new Set(['BEGIN', 'END', 'function', 'func', 'if', 'else', 'while', 'for', 'do', 'break', 'continue', 'next', 'nextfile', 'exit', 'return', 'delete', 'in', 'getline', 'print', 'printf']);
  const AWK_BUILTINS = {
    length: [0, 1], substr: [2, 3], index: [2, 2], split: [2, 3], sub: [2, 3], gsub: [2, 3], match: [2, 2], sprintf: [1, Infinity],
    sin: [1, 1], cos: [1, 1], atan2: [2, 2], exp: [1, 1], log: [1, 1], sqrt: [1, 1], int: [1, 1], rand: [0, 0], srand: [0, 1],
    tolower: [1, 1], toupper: [1, 1], system: [1, 1], close: [1, 1], fflush: [0, 1], systime: [0, 0], strftime: [0, 3],
  };
  const PUNCT = ['+=', '-=', '*=', '/=', '%=', '^=', '==', '<=', '>=', '!=', '++', '--', '&&', '||', '>>', '!~'];

  class AwkLexer {
    constructor(src) { this.src = src; this.i = 0; this.line = 1; }
    save() { return { i: this.i, line: this.line }; }
    restore(s) { this.i = s.i; this.line = s.line; }
    error(msg) { throw new AwkSyntax(msg, this.line); }

    /** Read the regular expression literal whose opening slash is at `pos`; leaves the lexer after it. */
    regexAt(pos) {
      const src = this.src; let i = pos + 1; let s = ''; let inBracket = false;
      for (;;) {
        const c = src[i];
        if (c === undefined || c === '\n') this.error('runaway regular expression /' + s.slice(0, 10) + ' ...');
        if (c === '\\' && src[i + 1] !== undefined) {
          if (src[i + 1] === '/') s += '/'; else s += c + src[i + 1];
          i += 2; continue;
        }
        if (inBracket) { if (c === ']') inBracket = false; }
        else if (c === '[') { inBracket = true; if (src[i + 1] === '^') { s += '[^'; i += 2; if (src[i] === ']') { s += ']'; i++; } continue; } if (src[i + 1] === ']') { s += '[]'; i += 2; continue; } }
        else if (c === '/') break;
        s += c; i++;
      }
      this.i = i + 1;
      return s;
    }

    next() {
      const src = this.src;
      for (;;) {
        const c = src[this.i];
        if (c === ' ' || c === '\t' || c === '\r') this.i++;
        else if (c === '\\' && (src[this.i + 1] === '\n' || (src[this.i + 1] === '\r' && src[this.i + 2] === '\n'))) { this.i += src[this.i + 1] === '\n' ? 2 : 3; this.line++; }
        else if (c === '#') { while (this.i < src.length && src[this.i] !== '\n') this.i++; }
        else break;
      }
      const pos = this.i; const c = src[pos];
      if (c === undefined) return { t: 'eof', pos, line: this.line, text: 'end of file' };
      const tok = (t, v, len) => { this.i = pos + len; return { t, v, pos, line: this.line, text: src.slice(pos, pos + len) }; };
      if (c === '\n') { this.i++; const t = { t: 'nl', pos, line: this.line, text: 'end of line' }; this.line++; return t; }
      let m;
      if ((m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(pos, pos + 64)))) {
        const v = strToNum(m[0]);
        if (!isFinite(v)) this.error(m[0] + ' : decimal overflow');
        return tok('num', v, m[0].length);
      }
      if (c === '"') return this.string(pos);
      if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(pos, pos + 256)))) {
        const name = m[0];
        if (AWK_KEYWORDS.has(name)) return tok('kw', name === 'func' ? 'function' : name, name.length);
        if (Object.prototype.hasOwnProperty.call(AWK_BUILTINS, name)) return tok('builtin', name, name.length);
        return tok(src[pos + name.length] === '(' ? 'funcname' : 'name', name, name.length);
      }
      for (const p of PUNCT) if (src.startsWith(p, pos)) return tok('p', p, 2);
      if ('{}()[];,+-*/%^!<>|?:~$='.includes(c)) return tok('p', c, 1);
      return this.error("unexpected character '" + c + "'");
    }

    string(pos) {
      const src = this.src; let i = pos + 1; let s = '';
      for (;;) {
        const c = src[i];
        if (c === undefined || c === '\n') this.error('runaway string constant "' + s.slice(0, 10) + ' ...');
        if (c === '"') break;
        if (c === '\\') {
          const e = src[i + 1];
          if (e === '\n') { i += 2; this.line++; continue; }
          const m = /^\\(?:([0-7]{1,3})|x([0-9a-fA-F]{1,2}))/.exec(src.slice(i, i + 5));
          if (m) { s += String.fromCharCode(m[1] ? parseInt(m[1], 8) & 255 : parseInt(m[2], 16)); i += m[0].length; continue; }
          const map = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', a: '\x07', b: '\b', '\\': '\\', '"': '"' };
          if (map[e] != null) s += map[e]; else s += '\\' + (e === undefined ? '' : e);
          i += 2; continue;
        }
        s += c; i++;
      }
      this.i = i + 1;
      return { t: 'str', v: s, pos, line: this.line, text: src.slice(pos, i + 1) };
    }
  }

  /* ----------------------------------------------------------------- parser
   * Expression nodes have a `type`: num str regex var local field index assign cond or and not neg plus
   * in match cmp concat bin preinc postinc group call builtin getline. Statements: block expr print if
   * while do for forin break continue next nextfile exit return delete.
   */
  const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^=']);
  const isLvalue = (n) => n.type === 'var' || n.type === 'local' || n.type === 'field' || n.type === 'index';

  class AwkParser {
    constructor(src) {
      this.lex = new AwkLexer(src);
      this.cur = this.lex.next();
      this.funcs = new Map(); this.locals = null; this.fn = null;
      this.begin = []; this.end = []; this.rules = []; this.calls = [];
      this.arrays = new Set(); this.scalars = new Set();
      this.noGt = false; this.where = 'rule';
    }

    advance() { const t = this.cur; this.cur = this.lex.next(); return t; }
    peek() { const st = this.lex.save(); const t = this.lex.next(); this.lex.restore(st); return t; }
    mark() { return { lex: this.lex.save(), cur: this.cur }; }
    reset(m) { this.lex.restore(m.lex); this.cur = m.cur; }
    is(v) { return this.cur.t === 'p' && this.cur.v === v; }
    isKw(v) { return this.cur.t === 'kw' && this.cur.v === v; }
    skipNl() { while (this.cur.t === 'nl') this.advance(); }
    skipTerminators() { while (this.cur.t === 'nl' || this.is(';')) this.advance(); }
    fail(msg) { throw new AwkSyntax(msg, this.cur.line); }
    syntaxError() { return this.fail('syntax error at or near ' + this.cur.text); }
    expect(v) {
      if (!this.is(v)) {
        if (this.cur.t === 'eof' || this.cur.t === 'nl') this.fail('missing ' + v + ' near ' + this.cur.text);
        this.syntaxError();
      }
      return this.advance();
    }

    compileRe(src) {
      try { return compileRegex(src, { ere: true, awk: true }); }
      catch (e) {
        if (e instanceof RegexError) throw new AwkSyntax('regular expression compile failed (' + mawkRegexMessage(e.message) + ')\n' + src, this.cur.line);
        throw e;
      }
    }

    /** Parse the whole program. */
    parseProgram() {
      this.skipTerminators();
      while (this.cur.t !== 'eof') {
        this.parseItem();
        this.skipTerminators();
      }
      this.finish();
      return { begin: this.begin, end: this.end, rules: this.rules, funcs: this.funcs };
    }

    /** Checks that need the whole program: undefined functions, array parameters, scalar/array clashes. */
    finish() {
      const eofLine = this.lex.line + 1;
      for (const c of this.calls) {
        if (!this.funcs.has(c.name)) throw new AwkSyntax('function ' + c.name + ' never defined', eofLine);
      }
      for (let changed = true; changed;) {
        changed = false;
        for (const c of this.calls) {
          const callee = this.funcs.get(c.name);
          c.args.forEach((a, i) => {
            if (a.type === 'local' && callee.arrays.has(i) && !c.from.arrays.has(a.idx)) { c.from.arrays.add(a.idx); changed = true; }
          });
        }
      }
      for (const name of this.arrays) {
        if (this.scalars.has(name)) throw new AwkSyntax('illegal reference to array ' + name, 1);
      }
    }

    parseItem() {
      if (this.is('}')) throw new AwkSyntax("extra '}'\n{NAME}: line " + this.cur.line + ': syntax error at or near end of line', this.cur.line);
      if (this.isKw('function')) return this.parseFunction();
      if (this.isKw('BEGIN') || this.isKw('END')) {
        const which = this.advance().v;
        if (!this.is('{')) this.syntaxError();
        this.where = which;
        const body = this.parseBlock();
        this.where = 'rule';
        (which === 'BEGIN' ? this.begin : this.end).push(body);
        return null;
      }
      let a = null; let b = null; let action = null;
      if (!this.is('{')) {
        a = this.parseExpr();
        if (this.is(',')) { this.advance(); this.skipNl(); b = this.parseExpr(); }
      }
      if (this.is('{')) action = this.parseBlock();
      else if (a === null) this.syntaxError();
      this.rules.push({ a, b, action, active: false });
      return null;
    }

    parseFunction() {
      this.advance();
      if (this.cur.t !== 'name' && this.cur.t !== 'funcname') this.syntaxError();
      const name = this.advance().v;
      if (this.funcs.has(name)) this.fail('function ' + name + ' redefined');
      this.expect('(');
      const params = [];
      while (!this.is(')')) {
        if (this.cur.t !== 'name') this.syntaxError();
        params.push(this.advance().v);
        if (this.is(',')) { this.advance(); this.skipNl(); } else if (!this.is(')')) this.syntaxError();
      }
      this.advance(); this.skipNl();
      const fn = { name, params, body: null, arrays: new Set() };
      this.funcs.set(name, fn);
      this.locals = new Map(params.map((p, i) => [p, i]));
      this.fn = fn; this.where = 'function';
      fn.body = this.parseBlock();
      this.locals = null; this.fn = null; this.where = 'rule';
    }

    parseBlock() {
      this.expect('{');
      const body = [];
      this.skipTerminators();
      while (!this.is('}')) {
        if (this.cur.t === 'eof') this.fail('missing } near end of file');
        body.push(this.parseStmt());
        this.skipTerminators();
      }
      this.advance();
      return { type: 'block', body };
    }

    endStmt() {
      const c = this.cur;
      if (c.t === 'nl' || this.is(';')) { this.advance(); return; }
      if (this.is('}') || c.t === 'eof') return;
      this.syntaxError();
    }

    parseStmt() {
      const c = this.cur;
      if (this.is('{')) return this.parseBlock();
      if (this.is(';')) { this.advance(); return { type: 'block', body: [] }; }
      if (c.t === 'kw') {
        switch (c.v) {
          case 'if': return this.parseIf();
          case 'while': {
            this.advance(); this.expect('(');
            const cond = this.parseExpr(); this.expect(')');
            if (this.is(';')) { this.advance(); return { type: 'while', cond, body: { type: 'block', body: [] } }; }
            this.skipNl();
            return { type: 'while', cond, body: this.parseStmt() };
          }
          case 'do': {
            this.advance(); this.skipNl();
            const body = this.parseStmt();
            this.skipTerminators();
            if (!this.isKw('while')) this.syntaxError();
            this.advance(); this.expect('(');
            const cond = this.parseExpr(); this.expect(')');
            this.endStmt();
            return { type: 'do', body, cond };
          }
          case 'for': return this.parseFor();
          case 'break': case 'continue': this.advance(); this.endStmt(); return { type: c.v };
          case 'next': case 'nextfile':
            if (this.where !== 'rule') this.fail('improper use of ' + c.v);
            this.advance(); this.endStmt(); return { type: c.v };
          case 'exit': case 'return': {
            this.advance();
            if (c.v === 'return' && !this.fn) this.fail('return outside function body');
            let e = null;
            if (!(this.cur.t === 'nl' || this.is(';') || this.is('}') || this.cur.t === 'eof')) e = this.parseExpr();
            this.endStmt();
            return { type: c.v, e };
          }
          case 'delete': {
            this.advance();
            const arr = this.arrayRef(this.parseName());
            let subs = null;
            if (this.is('[')) subs = this.parseSubscripts();
            this.endStmt();
            return { type: 'delete', arr, subs };
          }
          case 'print': case 'printf': return this.parsePrint();
          default: break;
        }
      }
      const e = this.parseExpr();
      this.endStmt();
      return { type: 'expr', e };
    }

    parseIf() {
      this.advance(); this.expect('(');
      const cond = this.parseExpr(); this.expect(')');
      this.skipNl();
      const then = this.parseStmt();
      let other = null;
      const m = this.mark();
      this.skipNl();
      if (this.isKw('else')) { this.advance(); this.skipNl(); other = this.parseStmt(); } else this.reset(m);
      return { type: 'if', cond, then, other };
    }

    parseFor() {
      this.advance(); this.expect('(');
      if (this.cur.t === 'name') {
        const m = this.mark();
        const v = this.parseName();
        if (this.isKw('in')) {
          this.advance();
          if (this.cur.t === 'name') {
            const arr = this.arrayRef(this.parseName());
            if (this.is(')')) {
              this.advance(); this.skipNl();
              return { type: 'forin', v, arr, body: this.parseStmt() };
            }
          }
        }
        this.reset(m);
      }
      let init = null; let cond = null; let step = null;
      if (!this.is(';')) init = { type: 'expr', e: this.parseExpr() };
      this.expect(';'); this.skipNl();
      if (!this.is(';')) cond = this.parseExpr();
      this.expect(';'); this.skipNl();
      if (!this.is(')')) step = { type: 'expr', e: this.parseExpr() };
      this.expect(')');
      if (this.is(';')) { this.advance(); return { type: 'for', init, cond, step, body: { type: 'block', body: [] } }; }
      this.skipNl();
      return { type: 'for', init, cond, step, body: this.parseStmt() };
    }

    parsePrint() {
      const kind = this.advance().v;
      const ends = () => this.cur.t === 'nl' || this.cur.t === 'eof' || this.is(';') || this.is('}') || this.is('>') || this.is('>>') || this.is('|');
      let args = [];
      if (!ends()) {
        let grouped = null;
        if (this.is('(')) {
          const m = this.mark();
          this.advance();
          const saved = this.noGt; this.noGt = false;
          const list = this.parseExprList(')');
          this.noGt = saved;
          if (this.is(')')) { this.advance(); if (ends()) grouped = list; }
          if (!grouped) this.reset(m);
        }
        if (grouped) args = grouped;
        else { this.noGt = true; try { args = this.parseExprList(null); } finally { this.noGt = false; } }
      }
      let redir = null;
      if (this.is('>') || this.is('>>') || this.is('|')) {
        const op = this.advance().v;
        this.noGt = true;
        let target;
        try { target = this.parseTernary(); } finally { this.noGt = false; }
        redir = { op, target };
      }
      this.endStmt();
      if (kind === 'printf' && !args.length) this.syntaxError();
      return { type: kind, args, redir };
    }

    parseExprList(closer) {
      const list = [];
      this.skipNl();
      if (closer && this.is(closer)) return list;
      for (;;) {
        list.push(this.parseExpr());
        if (this.is(',')) { this.advance(); this.skipNl(); continue; }
        return list;
      }
    }

    parseName() {
      if (this.cur.t !== 'name' && this.cur.t !== 'funcname') this.syntaxError();
      const name = this.advance().v;
      if (this.locals && this.locals.has(name)) return { type: 'local', idx: this.locals.get(name), name };
      return { type: 'var', name, special: name === 'NF' || name === 'NR' || name === 'FNR' };
    }

    /** Mark a variable node as used as an array. */
    arrayRef(node) {
      if (node.type === 'local') this.fn.arrays.add(node.idx);
      else this.arrays.add(node.name);
      return node;
    }

    parseSubscripts() {
      this.expect('[');
      const saved = this.noGt; this.noGt = false;
      const subs = this.parseExprList(']');
      this.noGt = saved;
      if (!subs.length) this.syntaxError();
      this.expect(']');
      return subs;
    }

    /* ---- expressions, from the lowest precedence up */
    parseExpr() {
      const left = this.parseTernary();
      if (this.cur.t === 'p' && ASSIGN_OPS.has(this.cur.v) && isLvalue(left)) {
        const op = this.advance().v;
        this.skipNl();
        if (left.type === 'var' && !left.special) this.scalars.add(left.name);
        return { type: 'assign', op, lhs: left, rhs: this.parseExpr() };
      }
      return left;
    }

    parseTernary() {
      const cond = this.parseOr();
      if (!this.is('?')) return cond;
      this.advance(); this.skipNl();
      const a = this.parseExpr(); this.skipNl();
      this.expect(':'); this.skipNl();
      return { type: 'cond', cond, a, b: this.parseExpr() };
    }

    parseOr() {
      let left = this.parseAnd();
      while (this.is('||')) { this.advance(); this.skipNl(); left = { type: 'or', l: left, r: this.parseAnd() }; }
      return left;
    }
    parseAnd() {
      let left = this.parseIn();
      while (this.is('&&')) { this.advance(); this.skipNl(); left = { type: 'and', l: left, r: this.parseIn() }; }
      return left;
    }
    parseIn() {
      let left = this.parseMatch();
      while (this.isKw('in')) {
        this.advance();
        const arr = this.arrayRef(this.parseName());
        left = { type: 'in', subs: [left], arr };
      }
      return left;
    }
    parseMatch() {
      let left = this.parseComparison();
      while (this.is('~') || this.is('!~')) {
        const neg = this.advance().v === '!~';
        left = { type: 'match', neg, l: left, r: this.parseComparison() };
      }
      return left;
    }
    parseComparison() {
      let left = this.parseConcat();
      for (;;) {
        if (this.is('|') && this.peek().t === 'kw' && this.peek().v === 'getline') {
          this.advance(); this.advance();
          const lhs = this.parseGetlineTarget();
          left = { type: 'getline', kind: 'cmd', src: left, lhs };
          continue;
        }
        const c = this.cur;
        if (c.v === '>=' && this.noGt && c.t === 'p') this.fail('syntax error at or near =');   // mawk reads `>` then `=` here
        if (c.t === 'p' && ['<', '<=', '==', '!=', '>=', '>'].includes(c.v) && !(c.v === '>' && this.noGt)) {
          this.advance();
          return { type: 'cmp', op: c.v, l: left, r: this.parseConcat() };
        }
        return left;
      }
    }

    startsOperand() {
      const c = this.cur;
      if (c.t === 'num' || c.t === 'str' || c.t === 'name' || c.t === 'funcname' || c.t === 'builtin') return true;
      if (c.t === 'p') return c.v === '$' || c.v === '(' || c.v === '++' || c.v === '--';
      return false;
    }
    parseConcat() {
      let left = this.parseAdditive();
      while (this.startsOperand()) left = { type: 'concat', l: left, r: this.parseAdditive() };
      return left;
    }
    parseAdditive() {
      let left = this.parseMul();
      while (this.is('+') || this.is('-')) { const op = this.advance().v; left = { type: 'bin', op, l: left, r: this.parseMul() }; }
      return left;
    }
    parseMul() {
      let left = this.parseUnary();
      while (this.is('*') || this.is('/') || this.is('%')) { const op = this.advance().v; left = { type: 'bin', op, l: left, r: this.parseUnary() }; }
      return left;
    }
    parseUnary() {
      if (this.is('!')) { this.advance(); return { type: 'not', e: this.parseUnary() }; }
      if (this.is('-')) { this.advance(); return { type: 'neg', e: this.parseUnary() }; }
      if (this.is('+')) { this.advance(); return { type: 'plus', e: this.parseUnary() }; }
      return this.parsePow();
    }
    parsePow() {
      const base = this.parsePostfix();
      if (!this.is('^')) return base;
      this.advance();
      return { type: 'bin', op: '^', l: base, r: this.parsePowOperand() };
    }
    parsePowOperand() {
      if (this.is('-')) { this.advance(); return { type: 'neg', e: this.parsePowOperand() }; }
      if (this.is('+')) { this.advance(); return { type: 'plus', e: this.parsePowOperand() }; }
      if (this.is('!')) { this.advance(); return { type: 'not', e: this.parsePowOperand() }; }
      return this.parsePow();
    }
    parsePostfix() {
      const e = this.parsePrimary();
      if (isLvalue(e) && (this.is('++') || this.is('--'))) {
        const op = this.advance().v;
        if (e.type === 'var' && !e.special) this.scalars.add(e.name);
        return { type: 'postinc', delta: op === '++' ? 1 : -1, e };
      }
      return e;
    }

    parseGetlineTarget() {
      if (this.cur.t === 'name' || (this.is('$'))) return this.parsePrimary();
      return null;
    }

    parsePrimary() {
      const c = this.cur;
      switch (c.t) {
        case 'num': this.advance(); return { type: 'num', v: c.v };
        case 'str': this.advance(); return { type: 'str', v: c.v };
        case 'name': {
          const v = this.parseName();
          if (this.is('[')) {
            const subs = this.parseSubscripts();
            this.arrayRef(v);
            return { type: 'index', arr: v, subs };
          }
          return v;
        }
        case 'funcname': return this.parseCall();
        case 'builtin': return this.parseBuiltin();
        case 'kw':
          if (c.v === 'getline') return this.parseGetline();
          return this.syntaxError();
        case 'p': break;
        default: return this.syntaxError();
      }
      switch (c.v) {
        case '/': case '/=': {
          const src = this.lex.regexAt(c.pos);
          this.cur = this.lex.next();
          return { type: 'regex', src, pat: this.compileRe(src) };
        }
        case '$': {
          this.advance();
          let e;
          if (this.is('++') || this.is('--')) {
            const op = this.advance().v;
            const target = this.parsePrimary();
            if (!isLvalue(target)) this.syntaxError();
            e = { type: 'preinc', delta: op === '++' ? 1 : -1, e: target };
          } else if (this.is('-')) { this.advance(); e = { type: 'neg', e: this.parsePrimary() }; }
          else if (this.is('+')) { this.advance(); e = { type: 'plus', e: this.parsePrimary() }; }
          else if (this.is('!')) { this.advance(); e = { type: 'not', e: this.parsePrimary() }; }
          else e = this.parsePrimary();
          return { type: 'field', e };
        }
        case '++': case '--': {
          this.advance();
          const target = this.parsePrimary();
          if (!isLvalue(target)) this.syntaxError();
          if (target.type === 'var' && !target.special) this.scalars.add(target.name);
          return { type: 'preinc', delta: c.v === '++' ? 1 : -1, e: target };
        }
        case '(': {
          this.advance();
          const saved = this.noGt; this.noGt = false;
          const list = this.parseExprList(')');
          this.noGt = saved;
          this.expect(')');
          if (list.length > 1) {
            if (!this.isKw('in')) this.syntaxError();
            this.advance();
            return { type: 'in', subs: list, arr: this.arrayRef(this.parseName()) };
          }
          if (!list.length) this.syntaxError();
          return { type: 'group', e: list[0] };
        }
        case '-': case '+': case '!': return this.parseUnary();
        default: return this.syntaxError();
      }
    }

    parseGetline() {
      this.advance();
      const lhs = this.parseGetlineTarget();
      if (this.is('<')) {
        this.advance();
        return { type: 'getline', kind: 'file', src: this.parsePostfix(), lhs };
      }
      return { type: 'getline', kind: 'simple', lhs };
    }

    parseArgs() {
      this.expect('(');
      const saved = this.noGt; this.noGt = false;
      const args = this.parseExprList(')');
      this.noGt = saved;
      this.expect(')');
      return args;
    }

    parseCall() {
      const name = this.advance().v;
      const args = this.parseArgs();
      const call = { type: 'call', name, args, from: this.fn };
      this.calls.push(call);
      const fn = this.funcs.get(name);
      if (fn && args.length > fn.params.length) this.fail('too many arguments in call to ' + name);
      return call;
    }

    parseBuiltin() {
      const tok = this.advance(); const name = tok.v;
      let args = [];
      if (name === 'length' && !this.is('(')) args = [];
      else args = this.parseArgs();
      const [min, max] = AWK_BUILTINS[name];
      if (args.length < min || args.length > max) {
        if (name === 'length') this.syntaxError();
        this.fail('wrong number of arguments in call to ' + name);
      }
      if (name === 'split') {
        if (args[1].type !== 'var' && args[1].type !== 'local') this.syntaxError();
        this.arrayRef(args[1]);
      }
      if ((name === 'sub' || name === 'gsub') && args[2] && !isLvalue(args[2]) && args[2].type !== 'group') this.fail('syntax error at or near )');
      if (name === 'length' && args[0] && (args[0].type === 'var' || args[0].type === 'local')) args[0].maybeArray = true;
      return { type: 'builtin', name, args };
    }
  }

  /* ---------------------------------------------------------------- input */

  /** Text being split into records. A terminal source is read a line at a time through `fill`. */
  class Reader {
    constructor(text, fill) { this.text = text; this.pos = 0; this.fill = fill || null; this.eof = !fill; }
    more() {
      return new Blocked(async () => {
        const line = await this.fill();
        if (line == null) this.eof = true; else this.text += line + '\n';
      });
    }
    /** Next record for the record separator `rs`, or null at the end. Throws Blocked when it needs terminal input. */
    read(rs, rt) {
      const t = this.text;
      if (rs.length === 1) {
        const idx = t.indexOf(rs, this.pos);
        if (idx >= 0) { const rec = t.slice(this.pos, idx); this.pos = idx + 1; return rec; }
      } else if (rs === '') {
        while (t[this.pos] === '\n') this.pos++;
        const m = /\n\n+/.exec(t.slice(this.pos));
        if (m && (this.eof || this.pos + m.index + m[0].length < t.length)) {
          const rec = t.slice(this.pos, this.pos + m.index); this.pos += m.index + m[0].length; return rec;
        }
        if (this.pos >= t.length && !this.eof) throw this.more();
      } else {
        const pat = rt.regex(rs);
        for (let from = this.pos; from <= t.length;) {
          const m = pat.exec(t, from);
          if (!m) break;
          if (m[0] === '') { from = m.index + 1; continue; }
          if (!this.eof && m.index + m[0].length >= t.length) break;
          const rec = t.slice(this.pos, m.index); this.pos = m.index + m[0].length; return rec;
        }
      }
      if (!this.eof) throw this.more();
      if (this.pos >= t.length) return null;
      let rec = t.slice(this.pos); this.pos = t.length;
      if (rs === '') rec = rec.replace(/\n$/, '');
      return rec;
    }
  }

  /** The operands of the command line, read in turn as the main input. */
  class MainInput {
    constructor(rt) { this.rt = rt; this.reader = null; this.argi = 1; this.usedOperand = false; this.usedStdin = false; }
    next() {
      const rt = this.rt;
      for (;;) {
        if (!this.reader && !this.openNext()) return null;
        const rec = this.reader.read(rt.str(rt.g.get('RS')), rt);
        if (rec !== null) return rec;
        this.reader = null;
      }
    }
    openNext() {
      const rt = this.rt; const argv = rt.g.get('ARGV');
      while (this.argi < toNum(rt.g.get('ARGC'))) {
        const a = rt.str(argv.get(String(this.argi++)));
        if (a === '') continue;
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(a);
        if (m) { rt.setVar(m[1], inputValue(unescapeArg(m[2]))); continue; }
        this.usedOperand = true;
        rt.g.set('FILENAME', a); rt.fnr = 0;
        if (a === '-') { this.reader = rt.stdinReader(); return true; }
        try { this.reader = new Reader(toBin(rt.ctx.fs.read(a))); }
        catch (e) {
          if (!isFsError(e)) throw e;
          throw new AwkFatal('cannot open "' + a + '" (' + e.message + ')');
        }
        return true;
      }
      if (this.usedOperand || this.usedStdin) return false;
      this.usedStdin = true;
      rt.g.set('FILENAME', '-'); rt.fnr = 0;
      this.reader = rt.stdinReader();
      return true;
    }
  }

  /* ------------------------------------------------------------ interpreter */
  const BRK = 1; const CNT = 2; const NXT = 3; const EXT = 4; const RET = 5; const NXF = 6;
  const BREATHE = { breathe: true };
  const ZERO_FIELD = { type: 'field', e: { type: 'num', v: 0 } };
  const MATH1 = { sin: Math.sin, cos: Math.cos, exp: Math.exp, log: Math.log, sqrt: Math.sqrt };

  /** Can evaluating this node need the event loop (a command, a terminal read, a function call)? */
  function pureNode(n) {
    if (n === null || typeof n !== 'object') return true;
    if (Array.isArray(n)) return n.every(pureNode);
    if (n._pure !== undefined) return n._pure;
    let pure = true;
    if (n.type === 'call' || n.type === 'getline' || (n.type === 'builtin' && (n.name === 'system' || n.name === 'close'))) pure = false;
    else for (const k of Object.keys(n)) if (k !== 'pat' && k !== 'from' && typeof n[k] === 'object' && !pureNode(n[k])) { pure = false; break; }
    n._pure = pure;
    return pure;
  }

  class AwkInterp {
    constructor(ctx, prog, sink, name) {
      this.ctx = ctx; this.prog = prog; this.sink = sink; this.name = name;
      this.g = new Map(); this.frame = null; this.steps = 0;
      this.nr = 0; this.fnr = 0; this.nf = 0; this.record = ''; this.fields = null;
      this.files = new Map(); this.pipes = new Map(); this.readers = new Map();
      this.reCache = new Map(); this.retval = undefined; this.exitCode = 0;
      this.sysResult = null; this.closeResult = null; this.stdin = null; this.depth = 0;
      this.seed = Math.floor(K.clock.now() / 1000) % 2147483647; this.rngState = this.seed;
      this.main = new MainInput(this);
      for (const [k, v] of [['FS', ' '], ['OFS', ' '], ['ORS', '\n'], ['RS', '\n'], ['SUBSEP', '\x1c'], ['CONVFMT', '%.6g'], ['OFMT', '%.6g'], ['RSTART', 0], ['RLENGTH', -1], ['FILENAME', '']]) this.g.set(k, v);
      const env = new AwkArray();
      for (const [k, v] of Object.entries(ctx.env || {})) env.ref(toBin(k), false).v = inputValue(toBin(String(v)));
      this.g.set('ENVIRON', env);
    }

    /* ---- values */
    str(v) {
      if (typeof v === 'string') return v;
      if (v === undefined) return '';
      if (typeof v === 'number') return numberToString(v, this.str(this.g.get('CONVFMT')));
      if (v instanceof StrNum) return v.s;
      throw new AwkRuntime("can't use an array in a scalar context");
    }
    outStr(v) { return typeof v === 'number' ? numberToString(v, this.str(this.g.get('OFMT'))) : this.str(v); }
    bool(v) { return typeof v === 'number' ? v !== 0 : typeof v === 'string' ? v !== '' : v === undefined ? false : v.n !== 0; }
    compare(a, b) {
      if (isNumeric(a) && isNumeric(b)) { const x = toNum(a); const y = toNum(b); return x < y ? -1 : x > y ? 1 : x === y ? 0 : NaN; }
      const x = this.str(a); const y = this.str(b);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    regex(src) {
      let p = this.reCache.get(src);
      if (!p) {
        try { p = compileRegex(src, { ere: true, awk: true }); }
        catch (e) { if (e instanceof RegexError) throw new AwkRuntime('regular expression compile failed (' + mawkRegexMessage(e.message) + ')\n' + src); throw e; }
        this.reCache.set(src, p);
      }
      return p;
    }
    patternOf(node) { return node.type === 'regex' ? node.pat : this.regex(this.str(this.ev(node))); }

    /* ---- variables */
    getVar(n) {
      if (!n.special) return this.g.get(n.name);
      if (n.name === 'NF') { this.ensureFields(); return this.nf; }
      return n.name === 'NR' ? this.nr : this.fnr;
    }
    setVar(name, v) {
      if (name === 'NF') this.setNF(Math.trunc(toNum(v)));
      else if (name === 'NR') this.nr = toNum(v);
      else if (name === 'FNR') this.fnr = toNum(v);
      else {
        if (this.g.get(name) instanceof AwkArray) throw new AwkRuntime("can't assign to " + name + '; it\'s an array name.');
        this.g.set(name, v);
      }
    }
    arrayOf(n) {
      if (n.type === 'local') { let a = this.frame[n.idx]; if (a === undefined) a = this.frame[n.idx] = new AwkArray(); return a; }
      let a = this.g.get(n.name);
      if (a === undefined) { a = new AwkArray(); this.g.set(n.name, a); }
      return a;
    }
    subscript(subs) {
      const sep = this.str(this.g.get('SUBSEP'));
      if (subs.length === 1) {
        const v = this.ev(subs[0]);
        if (typeof v === 'number') return { key: this.str(v), int: Number.isInteger(v) && Math.abs(v) <= 2147483647 };
        return { key: this.str(v), int: false };
      }
      return { key: subs.map((s) => this.str(this.ev(s))).join(sep), int: false };
    }
    entry(n) { const s = this.subscript(n.subs); return this.arrayOf(n.arr).ref(s.key, s.int); }

    /* ---- record and fields */
    setRecord(s) { this.record = s; this.fields = null; }
    splitBy(s, fs, paragraph) {
      if (fs === ' ') { const t = s.replace(/^[ \t\n]+|[ \t\n]+$/g, ''); return t === '' ? [] : t.split(/[ \t\n]+/); }
      if (s === '') return [];
      if (fs === '') return s.split('');
      if (fs.length === 1 && fs !== '\\') return paragraph ? s.split(new RegExp('[' + escInClass(fs) + '\\n]')) : s.split(fs);
      const pat = this.regex(paragraph ? '(' + fs + ')|\n' : fs);
      const out = []; let last = 0;
      for (let from = 0; from <= s.length;) {
        const m = pat.exec(s, from);
        if (!m) break;
        if (m[0] === '') { from = m.index + 1; continue; }
        out.push(s.slice(last, m.index)); last = m.index + m[0].length; from = last;
      }
      out.push(s.slice(last));
      return out;
    }
    ensureFields() {
      if (this.fields) return;
      const rs = this.str(this.g.get('RS'));
      const parts = this.splitBy(this.record, this.str(this.g.get('FS')), rs === '');
      this.fields = [''].concat(parts); this.nf = parts.length;
    }
    rebuild() { this.record = this.fields.slice(1, this.nf + 1).join(this.str(this.g.get('OFS'))); }
    getField(i) {
      if (i < 0) throw new AwkRuntime('negative field index $' + i);
      if (i === 0) return inputValue(this.record);
      this.ensureFields();
      return i > this.nf ? undefined : inputValue(this.fields[i]);
    }
    setField(i, v) {
      if (i < 0) throw new AwkRuntime('negative field index $' + i);
      if (i === 0) { this.setRecord(this.str(v)); return; }
      this.ensureFields();
      while (this.nf < i) this.fields[++this.nf] = '';
      this.fields[i] = this.str(v);
      this.rebuild();
    }
    setNF(n) {
      this.ensureFields();
      n = Math.max(0, n);
      while (this.nf < n) this.fields[++this.nf] = '';
      this.fields.length = n + 1; this.nf = n;
      this.rebuild();
    }

    /* ---- assignment targets */
    store(t, v) {
      switch (t.type) {
        case 'var': this.setVar(t.name, v); break;
        case 'local': this.frame[t.idx] = v; break;
        case 'field': this.setField(Math.trunc(toNum(this.ev(t.e))), v); break;
        default: this.entry(t).v = v;
      }
    }
    /** Update an lvalue with fn(old) -> new and return the new value. */
    modify(t, fn) {
      switch (t.type) {
        case 'var': { const nv = fn(this.getVar(t)); this.setVar(t.name, nv); return nv; }
        case 'local': { const nv = fn(this.frame[t.idx]); this.frame[t.idx] = nv; return nv; }
        case 'field': { const i = Math.trunc(toNum(this.ev(t.e))); const nv = fn(this.getField(i)); this.setField(i, nv); return nv; }
        default: { const e = this.entry(t); e.v = fn(e.v); return e.v; }
      }
    }
    arith(op, a, b) {
      switch (op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b;
        case '%': return a % b; default: return Math.pow(a, b);
      }
    }

    /* ---- expressions */
    ev(n) {
      switch (n.type) {
        case 'num': case 'str': return n.v;
        case 'var': return this.getVar(n);
        case 'local': return this.frame[n.idx];
        case 'group': return this.ev(n.e);
        case 'field': return this.getField(Math.trunc(toNum(this.ev(n.e))));
        case 'index': return this.entry(n).v;
        case 'regex': return n.pat.test(this.record) ? 1 : 0;
        case 'assign': {
          if (n.op === '=') {
            const v = this.ev(n.rhs);
            this.store(n.lhs, v);
            return v;
          }
          const op = n.op[0]; const r = toNum(this.ev(n.rhs));
          return this.modify(n.lhs, (old) => this.arith(op, toNum(old), r));
        }
        case 'cond': return this.bool(this.ev(n.cond)) ? this.ev(n.a) : this.ev(n.b);
        case 'or': return this.bool(this.ev(n.l)) || this.bool(this.ev(n.r)) ? 1 : 0;
        case 'and': return this.bool(this.ev(n.l)) && this.bool(this.ev(n.r)) ? 1 : 0;
        case 'not': return this.bool(this.ev(n.e)) ? 0 : 1;
        case 'neg': return -toNum(this.ev(n.e));
        case 'plus': return toNum(this.ev(n.e));
        case 'in': { const s = this.subscript(n.subs); return this.arrayOf(n.arr).has(s.key) ? 1 : 0; }
        case 'match': {
          const s = this.str(this.ev(n.l));
          return this.patternOf(n.r).test(s) !== n.neg ? 1 : 0;
        }
        case 'cmp': {
          const c = this.compare(this.ev(n.l), this.ev(n.r));
          switch (n.op) {
            case '<': return c < 0 ? 1 : 0; case '<=': return c <= 0 ? 1 : 0; case '==': return c === 0 ? 1 : 0;
            case '!=': return c !== 0 ? 1 : 0; case '>': return c > 0 ? 1 : 0; default: return c >= 0 ? 1 : 0;
          }
        }
        case 'concat': return this.str(this.ev(n.l)) + this.str(this.ev(n.r));
        case 'bin': return this.arith(n.op, toNum(this.ev(n.l)), toNum(this.ev(n.r)));
        case 'preinc': return this.modify(n.e, (old) => toNum(old) + n.delta);
        case 'postinc': { let old = 0; this.modify(n.e, (o) => { old = toNum(o); return old + n.delta; }); return old; }
        case 'call': return this.callUser(n);
        case 'builtin': return this.builtin(n);
        case 'getline': return this.getline(n);
        default: throw new Error('awk: unknown node ' + n.type);
      }
    }

    callUser(n) {
      const fn = this.prog.funcs.get(n.name);
      const frame = new Array(fn.params.length);
      n.args.forEach((a, i) => {
        frame[i] = (a.type === 'var' || a.type === 'local') && fn.arrays.has(i) ? this.arrayOf(a) : this.ev(a);
      });
      if (++this.depth > 400) { this.depth = 0; throw new AwkRuntime('function call nesting too deep'); }
      const saved = this.frame; this.frame = frame;
      try {
        const r = this.runSync(this.exec(fn.body));
        return r === RET ? this.retval : undefined;
      } finally { this.frame = saved; this.depth--; }
    }
    /** Run a generator to completion where waiting is impossible: a request to wait restarts the caller. */
    runSync(gen) {
      let r = gen.next();
      while (!r.done) {
        if (r.value && r.value.run) throw new Blocked(r.value.run);
        r = gen.next();
      }
      return r.value;
    }

    /* ---- getline, commands and files */
    stdinReader() {
      if (this.stdin) return this.stdin;
      const ctx = this.ctx;
      this.stdin = ctx.stdin != null ? new Reader(toBin(ctx.stdin)) : new Reader('', () => ctx.readLine('').then((l) => (l == null ? null : toBin(l))));
      return this.stdin;
    }
    getline(n) {
      let rec;
      if (n.kind === 'simple') rec = this.main.next();
      else {
        const name = this.str(this.ev(n.src));
        const key = (n.kind === 'cmd' ? '|' : '<') + name;
        let r = this.readers.get(key);
        if (!r) {
          if (n.kind === 'cmd') throw new Blocked(() => this.runForReader(name, key));
          if (name === '-') r = this.stdinReader();
          else {
            this.flushFiles();
            try { r = new Reader(toBin(this.ctx.fs.read(name))); } catch (e) { if (!isFsError(e)) throw e; return -1; }
          }
          this.readers.set(key, r);
        }
        rec = r.read(this.str(this.g.get('RS')), this);
      }
      if (rec === null) return 0;
      if (n.kind === 'simple') { this.nr++; this.fnr++; }
      if (n.lhs) this.store(n.lhs, inputValue(rec)); else this.setRecord(rec);
      return 1;
    }
    async runForReader(cmd, key) {
      this.sink.flush(); this.flushFiles();
      const r = await this.ctx.run(['sh', '-c', cmd]);
      if (r.err) this.ctx.err(r.err);
      this.readers.set(key, new Reader(toBin(r.out)));
    }
    flushFiles() { for (const [name, f] of this.files) if (f.dirty) { this.ctx.fs.write(name, f.buf); f.dirty = false; } }
    /** Where print writes: stdout, stderr, a file or a command. */
    write(redir, text) {
      if (!redir) { this.sink.write(fromBin(text)); return; }
      const { op, name } = redir;
      if (op === '|') {
        const p = this.pipes.get(name);
        if (p) p.text += text; else { this.sink.flush(); this.pipes.set(name, { text }); }   // starting a command flushes stdout
        return;
      }
      if (name === '/dev/stdout' || name === '-') { this.sink.write(fromBin(text)); return; }
      if (name === '/dev/stderr') { this.sink.flush(); this.ctx.err(fromBin(text)); return; }
      let f = this.files.get(name);
      if (!f) {
        let buf = '';
        try {
          if (op === '>>' && this.ctx.fs.exists(name)) buf = toBin(this.ctx.fs.read(name));
          this.ctx.fs.write(name, buf);
        } catch (e) {
          if (!isFsError(e)) throw e;
          throw new AwkFatal('cannot open "' + name + '" for output (' + e.message + ')');
        }
        f = { buf, dirty: false };
        this.files.set(name, f);
      }
      f.buf += text; f.dirty = true;
    }
    /** Feed text to a command. Its output bypasses awk's own buffer, as it does when stdout is not a terminal. */
    async runPipe(cmd, text) {
      if (this.ctx.isTTY) this.sink.flush();
      const r = await this.ctx.run(['sh', '-c', cmd], { stdin: fromBin(text) });
      if (r.out) this.ctx.out(r.out);
      if (r.err) this.ctx.err(r.err);
      return r.code;
    }
    system(cmd) {
      if (this.sysResult && this.sysResult.cmd === cmd) { const c = this.sysResult.code; this.sysResult = null; return c; }
      throw new Blocked(async () => {
        this.sink.flush(); this.flushFiles();
        const r = await this.ctx.run(['sh', '-c', cmd]);
        if (r.out) this.ctx.out(r.out);
        if (r.err) this.ctx.err(r.err);
        this.sysResult = { cmd, code: r.code };
      });
    }
    close(name) {
      if (this.closeResult && this.closeResult.name === name) { const c = this.closeResult.code; this.closeResult = null; return c; }
      if (this.pipes.has(name)) {
        throw new Blocked(async () => {
          const p = this.pipes.get(name); this.pipes.delete(name);
          this.closeResult = { name, code: await this.runPipe(name, p.text) };
        });
      }
      let found = false;
      if (this.files.has(name)) {
        const f = this.files.get(name);
        if (f.dirty) this.ctx.fs.write(name, f.buf);
        this.files.delete(name); found = true;
      }
      for (const key of ['<' + name, '|' + name]) if (this.readers.delete(key)) found = true;
      return found ? 0 : -1;
    }

    /* ---- built-in functions */
    builtin(n) {
      const a = n.args; const name = n.name;
      switch (name) {
        case 'length': {
          if (!a.length) return this.record.length;
          const v = a[0].type === 'var' || a[0].type === 'local' ? (a[0].type === 'var' ? this.g.get(a[0].name) : this.frame[a[0].idx]) : this.ev(a[0]);
          return v instanceof AwkArray ? v.size : this.str(this.ev(a[0])).length;
        }
        case 'substr': return this.substr(this.str(this.ev(a[0])), toNum(this.ev(a[1])), a.length > 2 ? toNum(this.ev(a[2])) : Infinity);
        case 'index': { const s = this.str(this.ev(a[0])); return s.indexOf(this.str(this.ev(a[1]))) + 1; }
        case 'split': return this.split(n);
        case 'sub': case 'gsub': return this.substitute(n, name === 'gsub');
        case 'match': {
          const s = this.str(this.ev(a[0]));
          const m = this.patternOf(a[1]).exec(s, 0);
          this.g.set('RSTART', m ? m.index + 1 : 0); this.g.set('RLENGTH', m ? m[0].length : -1);
          return m ? m.index + 1 : 0;
        }
        case 'sprintf': {
          const vals = a.map((x) => this.ev(x));
          return sprintf(this.str(vals[0]), vals.slice(1), 'sprintf');
        }
        case 'sin': case 'cos': case 'exp': case 'log': case 'sqrt': return MATH1[name](toNum(this.ev(a[0])));
        case 'atan2': return Math.atan2(toNum(this.ev(a[0])), toNum(this.ev(a[1])));
        case 'int': return Math.trunc(toNum(this.ev(a[0])));
        case 'rand': return this.random();
        case 'srand': {
          const prev = this.seed;
          this.seed = a.length ? toNum(this.ev(a[0])) : Math.floor(K.clock.now() / 1000);
          this.rngState = (Math.floor(this.seed) >>> 0) || 1;
          return prev;
        }
        case 'tolower': return this.str(this.ev(a[0])).replace(/[A-Z]/g, (c) => c.toLowerCase());
        case 'toupper': return this.str(this.ev(a[0])).replace(/[a-z]/g, (c) => c.toUpperCase());
        case 'system': return this.system(this.str(this.ev(a[0])));
        case 'close': return this.close(this.str(this.ev(a[0])));
        case 'fflush': this.sink.flush(); this.flushFiles(); return 0;
        case 'systime': return Math.floor(K.clock.now() / 1000);
        default: return strftime(a.length ? this.str(this.ev(a[0])) : '%a %b %e %H:%M:%S %Z %Y', a.length > 1 ? toNum(this.ev(a[1])) : Math.floor(K.clock.now() / 1000));
      }
    }
    /** mawk 1.3.4-20240123 cuts substr() oddly when the start is below 1: the length grows by the shortfall. */
    substr(s, m, n) {
      let start = Math.trunc(m); let len = Math.trunc(n);
      if (Number.isNaN(start) || Number.isNaN(len)) return '';
      if (start < 1) { len = len - start; start = 1; }
      return len <= 0 ? '' : s.substr(start - 1, len);
    }
    random() {
      let t = (this.rngState += 0x6d2b79f5) >>> 0;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    split(n) {
      const a = n.args;
      const s = this.str(this.ev(a[0]));
      let parts;
      if (a.length < 3) parts = this.splitBy(s, this.str(this.g.get('FS')), false);
      else if (a[2].type === 'regex') parts = this.splitRegex(s, a[2].pat);
      else parts = this.splitBy(s, this.str(this.ev(a[2])), false);
      const arr = this.arrayOf(a[1]); arr.clear();
      parts.forEach((p, i) => { arr.ref(String(i + 1), true).v = inputValue(p); });
      return parts.length;
    }
    splitRegex(s, pat) {
      if (s === '') return [];
      const out = []; let last = 0;
      for (let from = 0; from <= s.length;) {
        const m = pat.exec(s, from);
        if (!m) break;
        if (m[0] === '') { from = m.index + 1; continue; }
        out.push(s.slice(last, m.index)); last = m.index + m[0].length; from = last;
      }
      out.push(s.slice(last));
      return out;
    }
    substitute(n, global) {
      const a = n.args;
      const pat = this.patternOf(a[0]);
      const repl = this.str(this.ev(a[1]));
      const target = a[2] ? (a[2].type === 'group' ? a[2].e : a[2]) : ZERO_FIELD;
      const s = this.str(this.ev(target));
      let out = ''; let copy = 0; let pos = 0; let prevEnd = -1; let count = 0;
      while (pos <= s.length) {
        const m = pat.exec(s, pos);
        if (!m) break;
        const start = m.index; const end = start + m[0].length;
        if (m[0] === '' && start === prevEnd) { pos = start + 1; continue; }
        count++;
        out += s.slice(copy, start) + expandSub(repl, m[0]);
        copy = end; prevEnd = end; pos = end > start ? end : end + 1;
        if (!global) break;
      }
      if (count) this.store(target, out + s.slice(copy));
      return count;
    }

    /* ---- statements */
    *val(node) {
      for (;;) {
        try { return this.ev(node); }
        catch (e) { if (!(e instanceof Blocked)) throw e; yield { run: e.run }; }
      }
    }
    *eval(node) { return pureNode(node) ? this.ev(node) : yield* this.val(node); }

    *exec(s) {
      switch (s.type) {
        case 'block':
          for (const t of s.body) { const r = yield* this.exec(t); if (r) return r; }
          return 0;
        case 'expr': yield* this.eval(s.e); return 0;
        case 'print': case 'printf': return yield* this.execPrint(s);
        case 'if':
          if (this.bool(yield* this.eval(s.cond))) return yield* this.exec(s.then);
          return s.other ? yield* this.exec(s.other) : 0;
        case 'while':
          while (this.bool(yield* this.eval(s.cond))) {
            if ((++this.steps & 0x3ff) === 0) yield BREATHE;
            const r = yield* this.exec(s.body);
            if (r === BRK) break;
            if (r && r !== CNT) return r;
          }
          return 0;
        case 'do':
          do {
            if ((++this.steps & 0x3ff) === 0) yield BREATHE;
            const r = yield* this.exec(s.body);
            if (r === BRK) break;
            if (r && r !== CNT) return r;
          } while (this.bool(yield* this.eval(s.cond)));
          return 0;
        case 'for':
          if (s.init) yield* this.exec(s.init);
          while (!s.cond || this.bool(yield* this.eval(s.cond))) {
            if ((++this.steps & 0x3ff) === 0) yield BREATHE;
            const r = yield* this.exec(s.body);
            if (r === BRK) break;
            if (r && r !== CNT) return r;
            if (s.step) yield* this.exec(s.step);
          }
          return 0;
        case 'forin': {
          for (const k of this.arrayOf(s.arr).keys()) {
            this.store(s.v, k);
            if ((++this.steps & 0x3ff) === 0) yield BREATHE;
            const r = yield* this.exec(s.body);
            if (r === BRK) break;
            if (r && r !== CNT) return r;
          }
          return 0;
        }
        case 'break': return BRK;
        case 'continue': return CNT;
        case 'next': return NXT;
        case 'nextfile': return NXF;
        case 'exit':
          if (s.e) this.exitCode = Math.trunc(toNum(yield* this.eval(s.e))) & 255;
          return EXT;
        case 'return': this.retval = s.e ? yield* this.eval(s.e) : undefined; return RET;
        case 'delete': {
          const arr = this.arrayOf(s.arr);
          if (s.subs) arr.delete(this.subscript(s.subs).key); else arr.clear();
          return 0;
        }
        default: throw new Error('awk: unknown statement ' + s.type);
      }
    }

    *execPrint(s) {
      const vals = [];
      for (const a of s.args) vals.push(yield* this.eval(a));
      let redir = null;
      if (s.redir) redir = { op: s.redir.op, name: this.str(yield* this.eval(s.redir.target)) };
      if (s.type === 'print') {
        const text = vals.length ? vals.map((v) => this.outStr(v)).join(this.str(this.g.get('OFS'))) : this.record;
        this.write(redir, text + this.str(this.g.get('ORS')));
        return 0;
      }
      let text;
      try { text = sprintf(this.str(vals[0]), vals.slice(1), 'printf'); }
      catch (e) { if (e instanceof AwkRuntime && e.partial) this.write(redir, e.partial); throw e; }
      this.write(redir, text);
      return 0;
    }

    /** The program: BEGIN actions, the rules for every input record, END actions. */
    *run() {
      const prog = this.prog; let exiting = false;
      for (const b of prog.begin) if ((yield* this.exec(b)) === EXT) { exiting = true; break; }
      if (!exiting && (prog.rules.length || prog.end.length)) {
        for (;;) {
          let rec;
          for (;;) {
            try { rec = this.main.next(); break; }
            catch (e) { if (!(e instanceof Blocked)) throw e; yield { run: e.run }; }
          }
          if (rec === null) break;
          this.nr++; this.fnr++; this.setRecord(rec);
          let r = 0;
          for (const rule of prog.rules) {
            if (!(yield* this.ruleMatches(rule))) continue;
            r = rule.action ? yield* this.exec(rule.action) : (this.write(null, this.record + this.str(this.g.get('ORS'))), 0);
            if (r) break;
          }
          if (r === EXT) { exiting = true; break; }
          if (r === NXF) this.main.reader = null;
        }
      }
      for (const e of prog.end) {
        if ((yield* this.exec(e)) === EXT) break;
      }
    }
    *ruleMatches(rule) {
      if (!rule.a) return true;
      if (!rule.b) return this.bool(yield* this.eval(rule.a));
      if (!rule.active) {
        if (!this.bool(yield* this.eval(rule.a))) return false;
        rule.active = true;
      }
      if (this.bool(yield* this.eval(rule.b))) rule.active = false;
      return true;
    }
  }

  /** Expand the replacement text of sub/gsub for one match: & is the match, \& a literal ampersand. */
  function expandSub(repl, match) {
    if (repl.indexOf('&') < 0 && repl.indexOf('\\') < 0) return repl;
    let out = '';
    for (let i = 0; i < repl.length; i++) {
      const c = repl[i];
      if (c === '\\' && (repl[i + 1] === '&' || repl[i + 1] === '\\')) out += repl[++i];
      else if (c === '&') out += match;
      else out += c;
    }
    return out;
  }

  function mawkRegexMessage(m) {
    if (/^Unmatched \(/.test(m)) return "missing ')'";
    if (/^Unmatched \)/.test(m)) return "missing '('";
    if (/^Unmatched \[/.test(m)) return 'bad class -- [], [^] or [';
    if (/preceding/.test(m)) return 'missing operand';
    return m.toLowerCase();
  }

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  /** strftime in UTC (the simulated machines run in UTC). */
  function strftime(fmt, ts) {
    const d = new Date(ts * 1000);
    const p2 = (n) => String(n).padStart(2, '0');
    const yday = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
    const h12 = d.getUTCHours() % 12 || 12;
    const f = {
      Y: d.getUTCFullYear(), y: p2(d.getUTCFullYear() % 100), m: p2(d.getUTCMonth() + 1), d: p2(d.getUTCDate()), e: String(d.getUTCDate()).padStart(2),
      H: p2(d.getUTCHours()), M: p2(d.getUTCMinutes()), S: p2(d.getUTCSeconds()), I: p2(h12), p: d.getUTCHours() < 12 ? 'AM' : 'PM',
      A: DAYS[d.getUTCDay()], a: DAYS[d.getUTCDay()].slice(0, 3), B: MONTHS[d.getUTCMonth()], b: MONTHS[d.getUTCMonth()].slice(0, 3), h: MONTHS[d.getUTCMonth()].slice(0, 3),
      j: String(yday).padStart(3, '0'), Z: 'UTC', z: '+0000', s: String(Math.floor(ts)), u: d.getUTCDay() || 7, w: d.getUTCDay(), n: '\n', t: '\t', '%': '%',
    };
    f.F = f.Y + '-' + f.m + '-' + f.d; f.T = f.H + ':' + f.M + ':' + f.S; f.D = f.m + '/' + f.d + '/' + f.y; f.R = f.H + ':' + f.M;
    f.c = f.a + ' ' + f.b + ' ' + f.e + ' ' + f.T + ' ' + f.Y; f.x = f.D; f.X = f.T;
    return fmt.replace(/%(.)/g, (m, c) => (f[c] != null ? String(f[c]) : m));
  }

  /* ----------------------------------------------------------------- command */

  const AWK_USAGE = 'Usage: mawk [Options] [Program] [file ...]\n\nProgram:\n' +
    '    The -f option value is the name of a file containing program text.\n' +
    '    If no -f option is given, a "--" ends option processing; the following\n    parameters are the program text.\n\n' +
    'Options:\n    -f program-file  Program  text is read from file instead of from the\n                     command-line.  Multiple -f options are accepted.\n' +
    '    -F value         sets the field separator, FS, to value.\n    -v var=value     assigns value to program variable var.\n' +
    '    --               unambiguous end of options.\n\n' +
    '    Implementation-specific options are prefixed with "-W".  They can be\n    abbreviated:\n\n' +
    '    -W version       show version information and exit.\n    -W compat        pre-POSIX 2001.\n' +
    '    -W dump          show assembler-like listing of program and exit.\n    -W help          show this message and exit.\n' +
    '    -W interactive   set unbuffered output, line-buffered input.\n    -W exec file     use file as program as well as last option.\n' +
    '    -W posix         stricter POSIX checking.\n    -W random=number set initial random seed.\n' +
    '    -W sprintf=number adjust size of sprintf buffer.\n    -W usage         show this message and exit.\n';
  const AWK_VERSION = 'mawk 1.3.4 20240123\nCopyright 2008-2023,2024, Thomas E. Dickey\nCopyright 1991-1996,2014, Michael D. Brennan\n\n' +
    'random-funcs:       arc4random_stir/arc4random\nregex-funcs:        internal\n\ncompiled limits:\nsprintf buffer      8192\nmaximum-integer     9223372036854775808\n';

  /** mawk's command line: options may be glued to their values (-F: -vx=1 -fprog.awk). */
  function parseAwkArgs(args) {
    const o = { progFiles: [], assigns: [], fs: null, program: null, operands: [], warnings: [] };
    let i = 0;
    const value = (flag, glued) => {
      if (glued) return glued;
      if (i + 1 >= args.length) return { error: 'option -' + flag + ' lacks argument' };
      return args[++i];
    };
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { i++; break; }
      if (a === '--version') { o.version = true; continue; }
      if (a === '--help' || a === '--usage') { o.help = true; continue; }
      if (a[0] !== '-' || a === '-') break;
      const flag = a[1]; const glued = a.slice(2);
      if (flag === 'f' || flag === 'F' || flag === 'v' || flag === 'W') {
        const v = value(flag, glued);
        if (typeof v === 'object') return { error: v.error };
        if (flag === 'f') o.progFiles.push(v);
        else if (flag === 'F') o.fs = v;
        else if (flag === 'v') o.assigns.push(v);
        else if (/^v/.test(v)) o.version = true;
        else if (/^[hu]/.test(v)) o.help = true;
        else if (!/^(c|d|e|i|p|r|s)/.test(v)) o.warnings.push('vacuous option: -W "' + v + '"');
        continue;
      }
      return { error: 'not an option: ' + a };
    }
    o.operands = args.slice(i);
    if (!o.progFiles.length && o.program === null && o.operands.length) o.program = o.operands.shift();
    return o;
  }

  async function runAwk(ctx) {
    const name = ctx.name || 'awk';
    const o = parseAwkArgs(ctx.args);
    if (o.error) { ctx.err(name + ': ' + o.error + '\n'); return 2; }
    for (const w of o.warnings) ctx.err(name + ': ' + w + '\n');
    if (o.version) { ctx.out(AWK_VERSION); return 0; }
    if (o.help) { ctx.out(AWK_USAGE); return 0; }
    if (o.program === null && !o.progFiles.length) { ctx.err(AWK_USAGE); return 0; }
    let source = o.program;
    if (o.progFiles.length) {
      source = '';
      for (const f of o.progFiles) {
        try { source += (f === '-' ? await stdinText(ctx) : ctx.fs.read(f)) + '\n'; }
        catch (e) {
          if (!isFsError(e)) throw e;
          ctx.err(name + ': cannot open "' + f + '" (' + e.message + ')\n');
          return 2;
        }
      }
    }
    const assigns = [];
    for (const a of o.assigns) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(a);
      if (!m) { ctx.err(name + ': improper assignment: -v ' + a + '\n'); return 2; }
      assigns.push([m[1], inputValue(unescapeArg(toBin(m[2])))]);
    }
    let prog;
    try { prog = new AwkParser(toBin(source)).parseProgram(); }
    catch (e) {
      if (!(e instanceof AwkSyntax)) throw e;
      ctx.err(name + ': line ' + e.line + ': ' + e.message.replace('{NAME}', name) + '\n');
      return 2;
    }

    const sink = new Sink(ctx);
    const rt = new AwkInterp(ctx, prog, sink, name);
    const argv = new AwkArray();
    [name].concat(o.operands).forEach((a, i) => { argv.ref(String(i), true).v = inputValue(toBin(a)); });
    rt.g.set('ARGV', argv); rt.g.set('ARGC', argv.size);
    if (o.fs !== null) rt.g.set('FS', unescapeArg(toBin(o.fs)));
    for (const [k, v] of assigns) rt.setVar(k, v);

    try {
      await driveAwk(rt);
      await closePipes(rt);
      return rt.exitCode;
    } catch (e) {
      if (e instanceof AwkRuntime) {
        sink.flush();
        ctx.err(name + ': run time error: ' + e.message + '\n\tFILENAME="' + rt.str(rt.g.get('FILENAME')) + '" FNR=' + rt.fnr + ' NR=' + rt.nr + '\n');
        return 2;
      }
      if (e instanceof AwkFatal) { sink.flush(); ctx.err(name + ': ' + e.message + '\n'); return 2; }
      throw e;
    } finally {
      rt.flushFiles();
      sink.flush();
    }
  }

  /** Run the interpreter's generator, waiting where it asks to (commands, terminal input, Ctrl-C checks). */
  async function driveAwk(rt) {
    const gen = rt.run();
    let r = gen.next();
    while (!r.done) {
      if (r.value === BREATHE) { rt.sink.flush(); await breathe(rt.ctx); }
      else await r.value.run();
      r = gen.next();
    }
  }
  /** At exit awk flushes its output, then lets the commands it fed finish. */
  async function closePipes(rt) {
    rt.flushFiles();
    for (const [cmd, p] of Array.from(rt.pipes)) { await rt.runPipe(cmd, p.text); rt.pipes.delete(cmd); }
  }

  K.cmd.register({
    name: 'awk', aliases: ['mawk', 'nawk'], pkg: 'mawk', section: 1, path: '/usr/bin/awk',
    summary: 'pattern scanning and text processing language',
    synopsis: "awk [-F value] [-v var=value] [--] 'program text' [file ...]\nawk [-F value] [-v var=value] [-f program-file] [--] [file ...]",
    man: manPage({
      desc: 'awk reads each input file (or standard input) one record at a time, usually a line, and splits it into fields\n$1, $2, ... $NF. For every record it runs the rules of the program: a pattern followed by an action in braces.\n' +
        'Without a pattern an action runs for every record; without an action a matching record is printed.\n\n' +
        'Patterns: BEGIN and END, /regex/, any expression, and ranges "pattern1, pattern2". Statements include print,\nprintf, if/else, while, do, for, for (k in array), delete, next and exit. Built-in variables: NR NF FNR FS OFS\nORS RS FILENAME. Functions: length substr index split sub gsub match sprintf tolower toupper int sqrt sin cos\natan2 log exp rand srand system close, and your own with "function name(args) { ... }".\n\n' +
        'This is mawk, the awk that Kali uses by default.',
      opts: [
        ['-F value', 'Set the field separator FS: a single character, or a regular expression.'],
        ['-v var=value', 'Assign value to var before the program starts. May be repeated.'],
        ['-f program-file', 'Read the program from a file instead of the command line. May be repeated.'],
        ['--', 'End of options.'],
        ['-W version, --version', 'Show the version and exit.'],
      ],
      exit: '0 on success, 2 for a syntax error, a run time error or an unreadable file. exit N sets the status.',
      examples: [
        ["awk -F: '{print $1, $NF}' /etc/passwd", 'Print the user name and the shell of each account.'],
        ["awk '$3 > 100' fruit.txt", 'Print the lines whose third field is larger than 100.'],
        ["awk '{c[$1]++} END {for (k in c) print c[k], k}' access.log", 'Count how often each first field occurs.'],
      ],
    }),
    run: runAwk,
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
