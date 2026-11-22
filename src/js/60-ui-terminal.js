/* Kalima — browser terminal widget (DOM code lives only in *-ui-* files).
 *
 * K.ui.Terminal implements the terminal interface the shell expects (see
 * K.HeadlessTerm in 21-shell.js): write, readLine, signal, raiseInterrupt,
 * clear, pager, editor, onKey, cols, rows.
 *
 *   Buffer     the screen model: logical lines of styled cells plus the ANSI parser
 *   Terminal   the view: renders the buffer, owns the real input field, the line
 *              editor (history, completion, reverse search) and the touch key bar
 *   Pager      less-style viewer            (term.pager)
 *   Nano, Vim  the two editors              (term.editor)
 *
 * Long lines are soft-wrapped by CSS instead of being split at `cols`, so
 * output reflows when the terminal is resized.
 *
 * Input always goes through a real <textarea>, so soft keyboards, IMEs and
 * paste work. While a line is being read the field mirrors the edit buffer
 * and the browser does the editing; in raw modes (pager, editors, a running
 * command) the field holds a sentinel and changes are replayed as key presses.
 */
;(function (root) {
  'use strict';
  const K = root.K;
  if (!K || typeof document === 'undefined') return;
  const ui = (K.ui = K.ui || {});

  const MAX_LINES = 5000;        // scrollback cap
  const TRIM_CHUNK = 200;        // trim in batches so a long listing does not shift the array per line
  const LIST_LIMIT = 400;        // completion candidates rendered at once
  const SENTINEL = '  ';         // raw-mode field content: gives soft keyboards something to delete
  const PROBE = 'MMMMMMMMMMMMMMMMMMMM';
  const NANO_VERSION = '8.4';        // the version `nano --version` reports in the command pack
  const WORD = /[A-Za-z0-9*?_\-.[\]~=&;!#$%^(){}<>]/;   // zsh WORDCHARS as set in Kali's zshrc (no slash)
  const COMBINING = /^[̀-ͯ‍︎️⃐-⃿]$/;
  const IS_MAC = /Mac|iPhone|iPad/.test((typeof navigator !== 'undefined' && navigator.platform) || '');

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  /** control characters in caret notation, as a tty echoes them (newlines and tabs are kept) */
  const visible = (s) => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => '^' + (c === '\x7f' ? '?' : String.fromCharCode(c.charCodeAt(0) + 64)));

  /** h('div', {class: 'x', onclick: fn}, child, 'text') */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }
  ui.h = h;
  ui.esc = esc;

  /* ---------------------------------------------------------------- SGR styles
   * A style is interned to a small integer; 0 is the default style. Palette
   * colours become classes (so the theme lives in CSS), 256-colour and
   * truecolor values become inline colours.
   */
  const CUBE = [0, 95, 135, 175, 215, 255];
  function color256(n) {
    if (n < 16) return n;
    if (n < 232) { n -= 16; return 'rgb(' + CUBE[Math.floor(n / 36)] + ',' + CUBE[Math.floor(n / 6) % 6] + ',' + CUBE[n % 6] + ')'; }
    const g = 8 + (n - 232) * 10;
    return 'rgb(' + g + ',' + g + ',' + g + ')';
  }
  function newSgr() { return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false }; }
  function applySgr(st, p) {
    if (!p.length) p = [0];
    for (let i = 0; i < p.length; i++) {
      const n = p[i] == null || isNaN(p[i]) ? 0 : p[i];
      if (n === 0) Object.assign(st, newSgr());
      else if (n === 1) st.bold = true;
      else if (n === 2) st.dim = true;
      else if (n === 3) st.italic = true;
      else if (n === 4 || n === 21) st.underline = true;
      else if (n === 7) st.inverse = true;
      else if (n === 9) st.strike = true;
      else if (n === 22) { st.bold = false; st.dim = false; }
      else if (n === 23) st.italic = false;
      else if (n === 24) st.underline = false;
      else if (n === 27) st.inverse = false;
      else if (n === 29) st.strike = false;
      else if (n >= 30 && n <= 37) st.fg = n - 30;
      else if (n >= 40 && n <= 47) st.bg = n - 40;
      else if (n >= 90 && n <= 97) st.fg = n - 82;
      else if (n >= 100 && n <= 107) st.bg = n - 92;
      else if (n === 39) st.fg = null;
      else if (n === 49) st.bg = null;
      else if (n === 38 || n === 48) {
        let col = null;
        if (p[i + 1] === 5) { col = color256(clamp(p[i + 2] | 0, 0, 255)); i += 2; }
        else if (p[i + 1] === 2) { col = 'rgb(' + (p[i + 2] & 255) + ',' + (p[i + 3] & 255) + ',' + (p[i + 4] & 255) + ')'; i += 4; }
        if (col != null) { if (n === 38) st.fg = col; else st.bg = col; }
      }
    }
  }
  const styleIds = new Map();
  const styleDefs = [{ cls: '', css: '' }];
  function styleOf(st) {
    let fg = st.fg; let bg = st.bg;
    if (st.inverse) { const f = fg; fg = bg == null ? 'bg' : bg; bg = f == null ? 'fg' : f; }
    const key = fg + '|' + bg + '|' + (st.bold ? 'b' : '') + (st.dim ? 'd' : '') + (st.italic ? 'i' : '') + (st.underline ? 'u' : '') + (st.strike ? 's' : '');
    if (key === 'null|null|') return 0;
    let id = styleIds.get(key);
    if (id == null) {
      const cls = []; const css = [];
      if (typeof fg === 'number') cls.push('kt-f' + fg); else if (fg === 'bg') cls.push('kt-fbg'); else if (fg) css.push('color:' + fg);
      if (typeof bg === 'number') cls.push('kt-b' + bg); else if (bg === 'fg') cls.push('kt-bfg'); else if (bg) css.push('background-color:' + bg);
      if (st.bold) cls.push('kt-bold');
      if (st.dim) cls.push('kt-dim');
      if (st.italic) cls.push('kt-italic');
      if (st.underline) cls.push('kt-ul');
      if (st.strike) cls.push('kt-strike');
      id = styleDefs.length;
      styleDefs.push({ cls: cls.join(' '), css: css.join(';') });
      styleIds.set(key, id);
    }
    return id;
  }
  function runHtml(key, text) {
    if (!text) return '';
    const d = styleDefs[key >> 1];
    const cls = (d.cls + (key & 1 ? ' kt-mark' : '')).trim();
    if (!cls && !d.css) return esc(text);
    return '<span' + (cls ? ' class="' + cls + '"' : '') + (d.css ? ' style="' + d.css + '"' : '') + '>' + esc(text) + '</span>';
  }
  /** HTML for cells [from, to) of a buffer line. `marks`: optional [start, end) ranges to highlight. */
  function cellsHtml(l, from, to, marks) {
    let html = ''; let run = ''; let key = 0;
    for (let i = from; i < to; i++) {
      let k = l.a[i] * 2;
      if (marks) for (const m of marks) if (i >= m[0] && i < m[1]) { k |= 1; break; }
      if (k !== key) { html += runHtml(key, run); run = ''; key = k; }
      run += l.c[i];
    }
    return html + runHtml(key, run);
  }

  /* -------------------------------------------------------------------- buffer */
  class Buffer {
    constructor(max) { this.max = max || Infinity; this.rows = 24; this.onTitle = null; this.reset(); }

    reset() {
      this.lines = []; this.fresh = []; this.dropped = []; this.dirty = new Set(); this.wiped = true;
      this.cx = 0; this.cy = 0; this.sgr = newSgr(); this.style = 0; this.carry = ''; this.cursorHidden = false;
      this._add();
    }
    _add() { const l = { c: [], a: [], el: null, dead: false }; this.lines.push(l); this.fresh.push(l); return l; }
    _drop(lines) { for (const l of lines) { l.dead = true; this.dropped.push(l); this.dirty.delete(l); } }
    text() { return this.lines.map((l) => l.c.join('')).join('\n'); }

    write(s) {
      s = this.carry + s; this.carry = '';
      const n = s.length; let i = 0;
      while (i < n) {
        const code = s.charCodeAt(i);
        if (code >= 0x20 && code !== 0x7f) {
          let j = i + 1;
          while (j < n) { const c = s.charCodeAt(j); if (c < 0x20 || c === 0x7f) break; j++; }
          this._put(s.slice(i, j)); i = j; continue;
        }
        if (code === 10) this._lf();
        else if (code === 13) this.cx = 0;
        else if (code === 8) { if (this.cx > 0) this.cx--; }
        else if (code === 9) this._tab();
        else if (code === 27) {
          const used = this._escape(s, i);
          if (!used) { if (n - i < 4096) this.carry = s.slice(i); break; }   // sequence continues in the next write
          i += used; continue;
        }
        i++;
      }
    }

    _put(text) {
      const l = this.lines[this.cy]; const c = l.c; const a = l.a; const st = this.style;
      let x = this.cx;
      while (c.length < x) { c.push(' '); a.push(0); }
      for (const ch of text) {
        if (x > 0 && COMBINING.test(ch)) { c[x - 1] += ch; continue; }
        c[x] = ch; a[x] = st; x++;
      }
      this.cx = x; this.dirty.add(l);
    }
    _tab() {
      const l = this.lines[this.cy]; const nx = (Math.floor(this.cx / 8) + 1) * 8;
      while (l.c.length < nx) { l.c.push(' '); l.a.push(0); }
      this.cx = nx; this.dirty.add(l);
    }
    _lf() {
      // like a tty with onlcr: a line feed also returns the carriage
      this.cy++; this.cx = 0;
      if (this.cy < this.lines.length) return;
      this._add();
      if (this.lines.length > this.max + TRIM_CHUNK) {
        const cut = this.lines.splice(0, this.lines.length - this.max);
        this._drop(cut); this.cy -= cut.length;
      }
    }
    _moveTo(row) {
      while (this.lines.length <= row) this._add();
      this.cy = Math.max(0, row);
    }

    /** s[i] is ESC. Returns the number of characters consumed, 0 when the sequence is incomplete. */
    _escape(s, i) {
      const n = s.length;
      if (i + 1 >= n) return 0;
      const c = s[i + 1];
      if (c === '[') {
        let j = i + 2;
        while (j < n) { const x = s.charCodeAt(j); if (x < 0x20 || x > 0x3f) break; j++; }
        if (j >= n) return 0;
        this._csi(s.slice(i + 2, j), s[j]);
        return j - i + 1;
      }
      if (c === ']') {
        for (let j = i + 2; j < n; j++) {
          if (s[j] === '\x07') { this._osc(s.slice(i + 2, j)); return j - i + 1; }
          if (s[j] === '\x1b') {
            if (j + 1 >= n) return 0;
            if (s[j + 1] === '\\') { this._osc(s.slice(i + 2, j)); return j - i + 2; }
          }
        }
        return 0;
      }
      if (c === '(' || c === ')' || c === '#') return i + 2 < n ? 3 : 0;
      if (c === 'c') this.reset();
      return 2;
    }
    _csi(params, fin) {
      const priv = params[0] === '?';
      const p = (priv ? params.slice(1) : params).split(/[;:]/).map((x) => (x === '' ? null : parseInt(x, 10)));
      const arg = (i, d) => (p[i] == null || isNaN(p[i]) ? d : p[i]);
      const l = this.lines[this.cy];
      switch (fin) {
        case 'm': if (!priv) { applySgr(this.sgr, p); this.style = styleOf(this.sgr); } break;
        case 'K': {
          const mode = arg(0, 0);
          if (mode === 0) { l.c.length = Math.min(l.c.length, this.cx); l.a.length = l.c.length; }
          else if (mode === 1) { for (let i = 0; i <= this.cx && i < l.c.length; i++) { l.c[i] = ' '; l.a[i] = 0; } }
          else { l.c.length = 0; l.a.length = 0; }
          this.dirty.add(l); break;
        }
        case 'J':
          if (arg(0, 0) >= 2) { const sgr = this.sgr; const st = this.style; this.reset(); this.sgr = sgr; this.style = st; }
          else if (arg(0, 0) === 0) {
            l.c.length = Math.min(l.c.length, this.cx); l.a.length = l.c.length; this.dirty.add(l);
            this._drop(this.lines.splice(this.cy + 1));
          }
          break;
        // cursor addressing is relative to the last screenful of lines
        case 'H': case 'f': this._moveTo(Math.max(0, this.lines.length - this.rows) + arg(0, 1) - 1); this.cx = Math.max(0, arg(1, 1) - 1); break;
        case 'A': this.cy = Math.max(0, this.cy - arg(0, 1)); break;
        case 'B': this.cy = Math.min(this.lines.length - 1, this.cy + arg(0, 1)); break;
        case 'C': this.cx += arg(0, 1); break;
        case 'D': this.cx = Math.max(0, this.cx - arg(0, 1)); break;
        case 'G': this.cx = Math.max(0, arg(0, 1) - 1); break;
        case 'h': case 'l': if (priv && p[0] === 25) this.cursorHidden = fin === 'l'; break;
        default: break;
      }
    }
    _osc(body) {
      const m = /^([02]);([\s\S]*)$/.exec(body);
      if (m && this.onTitle) this.onTitle(m[2]);
    }
  }

  /** Give a scrolling box a height of whole rows, so that no line is cut in half at its bottom edge. */
  function snapRows(body, lineH) {
    body.style.flex = ''; body.style.height = '';          // first let the layout hand it all the free space
    const free = body.clientHeight;
    if (!free || !lineH) return;
    body.style.flex = '0 0 auto';
    body.style.height = Math.max(1, Math.floor(free / lineH + 0.01)) * lineH + 'px';
  }

  /* ------------------------------------------------------------------ key bars */
  const KEY = (label, key, o) => Object.assign({ label, key }, o);
  const ARROWS = [
    KEY('←', 'ArrowLeft', { name: 'Left' }), KEY('↑', 'ArrowUp', { name: 'Up' }),
    KEY('↓', 'ArrowDown', { name: 'Down' }), KEY('→', 'ArrowRight', { name: 'Right' }),
  ];
  const CTRL = { label: 'Ctrl', latch: true, name: 'Control: applies to the next key' };
  const KEYSETS = {
    line: [KEY('Tab', 'Tab'), CTRL, KEY('^C', 'c', { ctrl: true, name: 'Control C' }), KEY('^D', 'd', { ctrl: true, name: 'Control D' }), KEY('Esc', 'Escape')]
      .concat(ARROWS, [KEY('|', '|', { name: 'pipe' }), KEY('/', '/', { name: 'slash' }), KEY('-', '-', { name: 'dash' }), KEY('~', '~', { name: 'tilde' })]),
    pager: [KEY('q', 'q', { name: 'quit' }), KEY('Space', ' ', { name: 'page down' }), KEY('b', 'b', { name: 'page up' }), ARROWS[1], ARROWS[2],
      KEY('g', 'g', { name: 'top' }), KEY('G', 'G', { name: 'end' }), KEY('/', '/', { name: 'search' }), KEY('n', 'n', { name: 'next match' })],
    nano: [CTRL, KEY('^O', 'o', { ctrl: true, name: 'write out' }), KEY('^X', 'x', { ctrl: true, name: 'exit' }), KEY('^K', 'k', { ctrl: true, name: 'cut line' }),
      KEY('^U', 'u', { ctrl: true, name: 'paste' }), KEY('^W', 'w', { ctrl: true, name: 'search' }), KEY('^C', 'c', { ctrl: true, name: 'cancel' }), KEY('Tab', 'Tab')].concat(ARROWS),
    vim: [KEY('Esc', 'Escape'), KEY(':', ':', { name: 'command line' }), KEY('/', '/', { name: 'search' })].concat(ARROWS, [CTRL, KEY('Tab', 'Tab')]),
  };
  // Ctrl chords the terminal owns even when nothing acts on them, so the browser does not (save page, open file, ...)
  const OWNED_CTRL = 'abdefghjklnopqrstuwxyz[\\]_/';

  /* ------------------------------------------------------------------ terminal */
  class Terminal {
    /**
     * new K.ui.Terminal(hostElement, { fontSize, keybar: 'auto'|'on'|'off', onTitle(text) })
     * onTitle receives window titles set by programs (OSC 0 and 2).
     */
    constructor(host, o) {
      this.opts = o || {};
      this.signal = new K.Signal();
      this.cols = 80; this.rows = 24; this.charW = 8; this.lineH = 18;
      this.buf = new Buffer(MAX_LINES);
      this.buf.onTitle = this.opts.onTitle || null;
      this._read = null;          // the line being edited
      this._pending = '';         // type-ahead and pasted lines waiting for a reader
      this._subs = new Set();     // raw key subscribers (onKey)
      this._overlay = null;       // pager or editor
      this._zsh = true; this._kill = ''; this._latch = false; this._composing = false; this._rawPrev = SENTINEL;
      this._raf = 0; this._stick = true; this._curLine = null; this._keyset = '';
      this._build(host);
      this.setFontSize(this.opts.fontSize || 14);
      this.setKeybar(this.opts.keybar || 'auto');
      this._mode();
      this._schedule();
    }

    /* ---- construction ---- */
    _build(host) {
      this.screen = h('div', { class: 'kt-screen', role: 'log', 'aria-label': 'Terminal output' });
      this.below = h('div', { class: 'kt-below' });
      this.ta = h('textarea', {
        class: 'kt-input', rows: '1', autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false',
        'aria-label': 'Terminal input', 'data-gramm': 'false', enterkeyhint: 'enter',
      });
      this.probe = h('div', { class: 'kt-probe', 'aria-hidden': 'true' }, PROBE);
      this.view = h('div', { class: 'kt-view' }, this.screen, this.below, this.ta, this.probe);
      this.over = h('div', { class: 'kt-over', hidden: true });
      this.keys = h('div', { class: 'kt-keys', role: 'toolbar', 'aria-label': 'Terminal keys', hidden: true });
      const el = (this.el = h('div', { class: 'kt', tabindex: '-1' }, this.view, this.over, this.keys));
      host.appendChild(el);

      el.addEventListener('keydown', (e) => this._onKeyDown(e));
      el.addEventListener('paste', (e) => {
        const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        e.preventDefault();
        if (text) this.paste(text);
      });
      this.ta.addEventListener('input', () => this._onInput());
      this.ta.addEventListener('compositionstart', () => { this._composing = true; });
      this.ta.addEventListener('compositionend', () => { this._composing = false; this._onInput(); });
      el.addEventListener('pointerdown', (e) => { this._pointer = e.pointerType; this._down = { x: e.clientX, y: e.clientY }; });
      // a tap must not pull focus out of the input field, or the soft keyboard flickers
      el.addEventListener('mousedown', (e) => { if (this._pointer === 'touch' && document.activeElement === this.ta) e.preventDefault(); });
      el.addEventListener('click', (e) => {
        if (e.target.closest('.kt-keys')) return;
        if (!this.selecting(e)) this.focus();
      });
      el.addEventListener('focusin', () => el.classList.add('kt-focus'));
      el.addEventListener('focusout', () => el.classList.remove('kt-focus'));
      this._onSel = () => this._selectionMoved();
      document.addEventListener('selectionchange', this._onSel);

      this.keys.addEventListener('pointerdown', (e) => e.preventDefault());
      this.keys.addEventListener('mousedown', (e) => e.preventDefault());
      this.keys.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (b) this._barKey(KEYSETS[this._keyset][+b.getAttribute('data-i')]);
      });

      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(() => { this.fit(); this._stick = true; this._schedule(); });
        this._ro.observe(this.view);
      }
      this._mq = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
    }

    dispose() {
      this._disposed = true;
      this._read = null;
      this.signal.abort();
      if (this._overlay) this._overlay.abort();
      if (this._ro) this._ro.disconnect();
      if (this._raf) cancelAnimationFrame(this._raf);
      document.removeEventListener('selectionchange', this._onSel);
      this.el.remove();
    }

    /* ---- geometry ---- */
    setFontSize(px) {
      px = clamp(Math.round(px), 9, 32);
      this.el.style.setProperty('--kt-fs', px + 'px');
      this.el.style.setProperty('--kt-lh', Math.round(px * 1.32) + 'px');
      this.fit();
    }
    setKeybar(mode) { this._keybar = mode; this._showKeys(); }
    _showKeys() {
      const show = this._keybar === 'on' || (this._keybar !== 'off' && !!this._mq && this._mq.matches);
      if (this.keys.hidden === !show) return;
      this.keys.hidden = !show;
    }

    /** Measure the cell size and recompute cols/rows. Safe to call while hidden (keeps the last size). */
    fit() {
      const r = this.probe.getBoundingClientRect();
      if (!r.width || !this.view.clientWidth) return;
      this.charW = r.width / PROBE.length; this.lineH = r.height;
      const cs = getComputedStyle(this.view);
      const w = this.view.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const ht = this.view.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const cols = Math.max(20, Math.floor(w / this.charW + 0.01)); const rows = Math.max(4, Math.floor(ht / this.lineH + 0.01));
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols; this.rows = rows; this.buf.rows = rows;
      if (this._overlay) this._overlay.resize();
      if (this._read && this._read.list) this._showList();
    }

    /* ---- output ---- */
    write(s) {
      if (s == null || s === '') return;
      this.buf.write(String(s));
      this._schedule();
    }
    clear() { this.buf.reset(); this._schedule(); }
    raiseInterrupt() { this.signal.abort(); }

    /** Plain text of the screen plus the line being typed (for tests and copying). */
    text() {
      const r = this._read;
      return this.buf.text() + (r && !r.hidden ? (r.search ? r.search.line : r.buf) : '');
    }
    /** 'read' while a line is being read, 'run' while a command runs, or 'pager', 'nano', 'vim'. */
    get mode() { return this._overlay ? this._overlay.kind : this._read ? 'read' : 'run'; }
    /** True while a full-screen program is open or a line is half typed: closing the page now would be a surprise. */
    get busy() { return !!(this._overlay || (this._read && this._read.buf)); }

    _schedule() {
      if (this._raf || this._disposed) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this._flush(); });
    }
    _flush() {
      const b = this.buf; const view = this.view;
      const stick = this._stick || view.scrollHeight - view.scrollTop - view.clientHeight < this.lineH * 2;
      this._stick = false;
      if (b.wiped) { this.screen.textContent = ''; b.wiped = false; }
      for (const l of b.dropped) if (l.el) l.el.remove();
      b.dropped.length = 0;
      if (b.fresh.length) {
        const frag = document.createDocumentFragment();
        for (const l of b.fresh) {
          if (l.dead) continue;
          l.el = document.createElement('div'); l.el.className = 'kt-line';
          frag.appendChild(l.el); b.dirty.add(l);
        }
        this.screen.appendChild(frag); b.fresh.length = 0;
      }
      const cur = b.lines[b.cy];
      if (this._curLine && this._curLine !== cur) b.dirty.add(this._curLine);
      this._curLine = cur; b.dirty.add(cur);
      for (const l of b.dirty) if (l.el && !l.dead) l.el.innerHTML = this._lineHtml(l, l === cur) || '<br>';
      b.dirty.clear();
      this._syncField();
      const c = cur.el && cur.el.querySelector('.kt-cursor');
      if (c) { this.ta.style.left = c.offsetLeft + 'px'; this.ta.style.top = c.offsetTop + 'px'; }
      if (stick) view.scrollTop = view.scrollHeight;
    }

    _lineHtml(l, isCur) {
      const n = l.c.length;
      if (!isCur) return cellsHtml(l, 0, n);
      const r = this._read;
      if (r) return cellsHtml(l, 0, n) + this._inputHtml(r);
      if (this.buf.cursorHidden) return cellsHtml(l, 0, n);
      const x = this.buf.cx;
      if (x >= n) return cellsHtml(l, 0, n) + ' '.repeat(x - n) + '<span class="kt-cursor"> </span>';
      return cellsHtml(l, 0, x) + '<span class="kt-cursor">' + esc(l.c[x]) + '</span>' + cellsHtml(l, x + 1, n);
    }
    _inputHtml(r) {
      if (r.hidden) return '<span class="kt-cursor"> </span>';
      const text = r.search ? r.search.line : r.buf;
      const pos = r.search ? r.search.pos : r.pos;
      const at = pos < text.length ? String.fromCodePoint(text.codePointAt(pos)) : '';
      const sug = !r.search && !at ? r.suggest : '';
      const under = at && at !== '\n' ? at : sug ? sug[0] : ' ';
      return '<span class="kt-typed">' + esc(visible(text.slice(0, pos))) + '</span><span class="kt-cursor' + (!at && sug ? ' kt-suggest' : '') + '">' + esc(visible(under)) + '</span>' +
        (at === '\n' ? '\n' : '') + '<span class="kt-typed">' + esc(visible(text.slice(pos + at.length))) + '</span>' + (sug.length > 1 ? '<span class="kt-suggest">' + esc(sug.slice(1)) + '</span>' : '');
    }

    /* ---- focus, selection, clipboard ---- */
    focus() { if (!this._disposed) { try { this.ta.focus({ preventScroll: true }); } catch (e) { this.ta.focus(); } } }
    _hasSelection() {
      const sel = typeof getSelection === 'function' ? getSelection() : null;
      // a click at the end of a line can leave a range that is not collapsed and yet selects nothing
      return !!sel && !sel.isCollapsed && this.el.contains(sel.anchorNode) && sel.anchorNode !== this.ta && String(sel) !== '';
    }
    /**
     * Did this click select text (a drag, a double click, a shift-click)? A plain click does not,
     * even though the browser may still report the previous selection while the click is handled.
     */
    selecting(e) {
      const d = this._down;
      const dragged = !!d && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4;
      return (dragged || e.detail > 1 || e.shiftKey) && this._hasSelection();
    }
    _copySelection() {
      const text = String(getSelection());
      if (!text) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => document.execCommand('copy'));
        else document.execCommand('copy');
      } catch (e) { /* clipboard unavailable */ }
    }
    /** The caret was moved inside the input field (soft-keyboard cursor keys, space-bar swipe). */
    _selectionMoved() {
      const r = this._read; const ta = this.ta;
      if (!r || r.search || this._overlay || this._composing || document.activeElement !== ta) return;
      const p = ta.selectionStart;
      if (ta.value !== r.buf || p === r.pos || ta.selectionEnd !== p) return;
      r.pos = p; this._refresh();
    }

    /** Keep the real input field in step with what is being edited. */
    _syncField() {
      if (this._composing) return;
      const ta = this.ta; const r = this._overlay ? null : this._read;
      const want = !r ? SENTINEL : r.search ? r.search.query : r.buf;
      const pos = !r || r.search ? want.length : r.pos;
      if (ta.value !== want) ta.value = want;
      if (ta.selectionStart !== pos || ta.selectionEnd !== pos) { try { ta.setSelectionRange(pos, pos); } catch (e) { /* not focusable yet */ } }
      this._rawPrev = want;
    }

    /* ---- reading a line ---- */
    readLine(o) {
      o = o || {};
      if (this._disposed) return new Promise(() => {});
      const prompt = o.prompt == null ? '' : String(o.prompt);
      const primary = typeof o.complete === 'function';
      const shell = primary || !!o.continuation;
      if (primary) {
        this._zsh = prompt.indexOf('└─') >= 0;   // Kali's two-line zsh prompt; lab servers use bash
        // zsh marks output that did not end with a newline and starts the prompt on a fresh line
        if (this._zsh && this.buf.cx > 0) this.buf.write('\x1b[0;1;7m%\x1b[0m\n');
      }
      if (prompt) this.buf.write(prompt);
      return new Promise((resolve, reject) => {
        const history = Array.isArray(o.history) ? o.history : [];
        const r = (this._read = {
          resolve, reject, prompt, hidden: !!o.hidden, history, complete: primary ? o.complete : null,
          shell, zsh: shell && this._zsh, buf: '', pos: 0, hIndex: history.length, draft: '',
          search: null, menu: null, list: null, ask: null, armed: false, suggest: '',
        });
        this._mode();
        this._syncField();     // now, not at the next repaint: keys can arrive before it
        const p = this._pending; this._pending = '';
        const nl = p.indexOf('\n');
        if (nl >= 0) { r.buf = p.slice(0, nl); this._pending = p.slice(nl + 1); this._submit(); return; }
        r.buf = p; r.pos = p.length;
        this._refresh();
      });
    }

    _refresh() {
      const r = this._read;
      if (r) r.suggest = this._suggestion(r);
      this._stick = true; this._schedule();
    }
    /** zsh-autosuggestions: the most recent history entry that starts with what was typed. */
    _suggestion(r) {
      if (!r.zsh || !r.complete || r.hidden || r.search || !r.buf || r.pos !== r.buf.length) return '';
      for (let i = r.history.length - 1; i >= 0; i--) {
        const e = r.history[i];
        if (e.length > r.buf.length && e.indexOf('\n') < 0 && e.lastIndexOf(r.buf, 0) === 0) return e.slice(r.buf.length);
      }
      return '';
    }
    _setBuf(buf, pos) {
      const r = this._read;
      r.buf = buf; r.pos = pos == null ? buf.length : clamp(pos, 0, buf.length);
      this._syncField(); this._refresh();
    }
    /** An edit ends menu completion and removes the candidate list. */
    _edit(buf, pos) {
      const r = this._read;
      r.menu = null; r.ask = null; r.armed = false;
      if (r.list) { r.list = null; this._setBelow(''); }
      this._setBuf(buf, pos);
    }
    _setBelow(html) { this.below.innerHTML = html; if (html) { this._stick = true; this._schedule(); } }

    _end(r) {
      this._read = null;
      this._setBelow('');
      this._mode();
      this._syncField();
      this._stick = true; this._schedule();
      return r;
    }
    _submit() {
      const r = this._end(this._read);
      if (r.search) r.buf = r.search.line;
      this.buf.write((r.hidden ? '' : visible(r.buf)) + '\n');
      r.resolve(r.buf);
    }
    _interruptRead() {
      const r = this._end(this._read);
      // zsh redraws silently, bash and programs reading input show ^C; the shell prints the newline for programs
      const tail = r.shell ? (r.zsh ? '' : '^C') + '\n' : '^C';
      this.buf.write((r.hidden ? '' : visible(r.search ? r.search.line : r.buf)) + tail);
      this._pending = '';
      r.reject(new K.Interrupt());
    }
    _eof() { this._end(this._read).resolve(null); }

    /** Insert text at the prompt as if typed. Lines ending in a newline are submitted. */
    paste(text) {
      text = String(text).replace(/\r\n?/g, '\n');
      this._stick = true;
      if (this._overlay) { this._overlay.paste(text); return; }
      const r = this._read;
      if (!r) { if (!this._subs.size) { this._pending += text; this.buf.write(visible(text)); this._schedule(); } return; }
      if (r.search) this._searchEnd(true);
      const nl = text.indexOf('\n');
      if (nl < 0) { this._edit(r.buf.slice(0, r.pos) + text + r.buf.slice(r.pos), r.pos + text.length); return; }
      r.buf = r.buf.slice(0, r.pos) + text.slice(0, nl) + r.buf.slice(r.pos);
      this._pending = text.slice(nl + 1) + this._pending;
      this._submit();
    }
    /** Put text on the command line without running it (used by the lesson panel). */
    insert(text) { this.paste(String(text).replace(/\n+$/, '')); }

    /* ---- keyboard ---- */
    /** Handle a key event that reached the page while the terminal did not have the focus. */
    keydown(e) { this._onKeyDown(e); }
    _onKeyDown(e) {
      if (e.isComposing || e.keyCode === 229 || e.metaKey) return;   // IME text arrives through input events; Cmd chords belong to the OS
      let key = e.key;
      if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta' || key === 'CapsLock' || key === 'AltGraph' || key === 'Dead' || key === 'Unidentified') return;
      let ctrl = e.ctrlKey; let alt = e.altKey;
      // AltGr reports Ctrl+Alt and Option composes characters on macOS: both produce ordinary text
      if (key.length === 1 && ((ctrl && alt) || (alt && IS_MAC) || (e.getModifierState && e.getModifierState('AltGraph')))) { ctrl = false; alt = false; }
      if (alt && !ctrl && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
      if (ctrl && !alt) {
        const lk = key.toLowerCase();
        if (lk === 'v' || (e.shiftKey && lk === 'insert')) return;                    // the paste event follows
        if (lk === 'c' && e.shiftKey) { e.preventDefault(); this._copySelection(); return; }
        if (lk === 'c' && this._hasSelection()) return;                                // copy the selection instead of interrupting
      }
      if (e.shiftKey && key === 'Insert') return;
      // Editing the field would move the browser's selection into it, so while output is
      // selected the keys are applied by hand and the selection stays for copying.
      if (e.target === this.ta && this._hasSelection()) this.el.focus({ preventScroll: true });
      const k = { key, ctrl, alt, shift: e.shiftKey, native: document.activeElement === this.ta };
      if (this._latch) { this._setLatch(false); k.ctrl = true; }
      if (this._handleKey(k)) e.preventDefault();
    }

    /** Text arrived in the input field: an edit of the line being read, or raw keys from a soft keyboard. */
    _onInput() {
      const ta = this.ta; const v = ta.value;
      const r = this._overlay ? null : this._read;
      if (r) {
        const cur = r.search ? r.search.query : r.buf;
        const s = ta.selectionStart; const added = v.length - cur.length;
        if (this._latch && added === 1 && s > 0) {
          this._setLatch(false); this._syncField();
          this._handleKey({ key: v[s - 1], ctrl: true });
          return;
        }
        if (v.split('\n').length > cur.split('\n').length) {
          // Enter from a keyboard that reports it only as inserted text, or dropped text containing newlines
          const typed = added > 0 ? v.slice(Math.max(0, s - added), s) : '\n';
          this._syncField();
          if (typed === '\n') this._handleKey({ key: 'Enter' }); else this.paste(typed);
          return;
        }
        if (r.search) { r.search.query = v; this._searchUpdate(true); return; }
        if (v !== r.buf) { r.menu = null; r.ask = null; if (r.list) { r.list = null; this._setBelow(''); } }
        r.buf = v; r.pos = s;
        this._refresh();
        return;
      }
      // raw mode: replay the difference from the last known field content as key presses
      const prev = this._rawPrev;
      let i = 0;
      while (i < prev.length && i < v.length && prev[i] === v[i]) i++;
      const typed = v.slice(i);
      if (this._composing) this._rawPrev = v;
      for (let j = prev.length; j > i; j--) this._handleKey({ key: 'Backspace' });
      for (const ch of typed) {
        const ctrl = this._latch;
        if (ctrl) this._setLatch(false);
        this._handleKey(ch === '\n' ? { key: 'Enter' } : { key: ch, ctrl });
      }
      if (!this._composing) this._syncField();
    }

    _barKey(def) {
      if (!def) return;
      if (def.latch) this._setLatch(!this._latch);
      else {
        const ctrl = !!def.ctrl || this._latch;
        if (this._latch) this._setLatch(false);
        this._handleKey({ key: def.key, ctrl });
      }
      if (document.activeElement !== this.ta) this.focus();
    }
    _setLatch(on) {
      this._latch = on;
      const b = this.keys.querySelector('[data-latch]');
      if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    /** Route one key press. Returns true when it was consumed (the browser default is then prevented). */
    _handleKey(k) {
      this._stick = true;
      let used;
      if (this._overlay) used = this._overlay.key(k);
      else if (this._read) used = this._editKey(k);
      else used = this._runKey(k);
      this._schedule();
      return used;
    }

    /** Keys while a command runs: Ctrl-C interrupts, onKey subscribers get raw keys, the rest is type-ahead. */
    _runKey(k) {
      const key = k.key; const lk = key.toLowerCase();
      if (k.ctrl && lk === 'c') {
        if (!this._subs.size) this.buf.write('^C');
        this._pending = '';
        this.raiseInterrupt();
        return true;
      }
      if (this._subs.size) {
        const name = k.ctrl ? 'C-' + lk : k.alt ? 'M-' + key : key;
        for (const fn of Array.from(this._subs)) { try { fn(name); } catch (e) { if (K.debug) console.error(e); } }
        return true;
      }
      if (!k.ctrl && !k.alt) {
        // type-ahead: the tty echoes it now and the next prompt reads it
        if (key === 'Enter') { this._pending += '\n'; this.buf.write('\n'); return true; }
        if (key === 'Backspace') {
          if (this._pending && !this._pending.endsWith('\n')) { this._pending = this._pending.slice(0, -1); this.buf.write('\b \b'); }
          return true;
        }
        if (isText(key)) { this._pending += key; this.buf.write(visible(key)); return true; }
        return key === 'Tab';
      }
      return k.ctrl && !k.alt && OWNED_CTRL.indexOf(lk) >= 0;
    }

    onKey(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }

    /* ---- the line editor ---- */
    _editKey(k) {
      const r = this._read; const key = k.key; const lk = key.length === 1 ? key.toLowerCase() : key;
      if (r.ask) return this._askKey(k);
      if (r.search) return this._searchKey(k);
      const buf = r.buf; const pos = r.pos; const len = buf.length;
      if (key !== 'Tab' && key !== 'Shift') { r.menu = null; r.armed = false; }
      if (k.ctrl && !k.alt) {
        switch (lk) {
          case 'c': this._interruptRead(); return true;
          case 'd': if (!len) this._eof(); else if (pos < len) this._edit(buf.slice(0, pos) + buf.slice(this._right(pos)), pos); return true;
          case 'a': case 'Home': this._setBuf(buf, 0); return true;
          case 'e': case 'End': this._toEnd(); return true;
          case 'b': this._setBuf(buf, this._left(pos)); return true;
          case 'f': if (pos === len) this._toEnd(); else this._setBuf(buf, this._right(pos)); return true;
          // zsh kills the whole line, bash and plain reads kill back to the start
          case 'u': if (r.zsh) { this._kill = buf; this._edit('', 0); } else { this._kill = buf.slice(0, pos); this._edit(buf.slice(pos), 0); } return true;
          case 'k': this._kill = buf.slice(pos); this._edit(buf.slice(0, pos), pos); return true;
          case 'w': case 'Backspace': { const i = this._wordLeft(pos); this._kill = buf.slice(i, pos); this._edit(buf.slice(0, i) + buf.slice(pos), i); return true; }
          case 'Delete': { const i = this._wordRight(pos); this._edit(buf.slice(0, pos) + buf.slice(i), pos); return true; }
          case 'y': this._edit(buf.slice(0, pos) + this._kill + buf.slice(pos), pos + this._kill.length); return true;
          case 'l': this.buf.reset(); this.buf.write(r.prompt); this._refresh(); return true;
          case 'r': if (r.history.length && !r.hidden) this._searchStart(); return true;
          case 'p': this._history(-1); return true;
          case 'n': this._history(1); return true;
          case 'h': if (pos > 0) { const i = this._left(pos); this._edit(buf.slice(0, i) + buf.slice(pos), i); } return true;
          case 'j': case 'm': this._submit(); return true;
          case 'i': this._complete(1); return true;
          case 'ArrowLeft': this._setBuf(buf, this._wordLeft(pos)); return true;
          case 'ArrowRight': this._setBuf(buf, this._wordRight(pos)); return true;
          default: return OWNED_CTRL.indexOf(lk) >= 0;
        }
      }
      if (k.alt && !k.ctrl) {
        switch (lk) {
          case 'b': this._setBuf(buf, this._wordLeft(pos)); return true;
          case 'f': this._setBuf(buf, this._wordRight(pos)); return true;
          case 'd': { const i = this._wordRight(pos); this._kill = buf.slice(pos, i); this._edit(buf.slice(0, pos) + buf.slice(i), pos); return true; }
          case 'Backspace': { const i = this._wordLeft(pos); this._kill = buf.slice(i, pos); this._edit(buf.slice(0, i) + buf.slice(pos), i); return true; }
          default: return false;
        }
      }
      switch (key) {
        case 'Enter': this._submit(); return true;
        case 'Tab': this._complete(k.shift ? -1 : 1); return true;
        case 'ArrowUp': this._history(-1); return true;
        case 'ArrowDown': this._history(1); return true;
        case 'ArrowLeft': this._setBuf(buf, this._left(pos)); return true;
        case 'ArrowRight': if (pos === len) this._toEnd(); else this._setBuf(buf, this._right(pos)); return true;
        case 'Home': this._setBuf(buf, 0); return true;
        case 'End': this._toEnd(); return true;
        case 'PageUp': this.view.scrollTop -= this.view.clientHeight - this.lineH; this._stick = false; return true;
        case 'PageDown': this.view.scrollTop += this.view.clientHeight - this.lineH; this._stick = false; return true;
        case 'Escape': if (r.list) { r.list = null; this._setBelow(''); } return true;
        case 'Backspace':
          if (k.native) return false;                                    // the browser edits the field, _onInput picks it up
          if (pos > 0) { const i = this._left(pos); this._edit(buf.slice(0, i) + buf.slice(pos), i); }
          return true;
        case 'Delete':
          if (k.native) return false;
          if (pos < len) this._edit(buf.slice(0, pos) + buf.slice(this._right(pos)), pos);
          return true;
        default:
          if (key.length > 2 || (key.length === 2 && key.codePointAt(0) <= 0xffff)) return false;   // function keys and the like
          if (k.native) return false;
          this._edit(buf.slice(0, pos) + key + buf.slice(pos), pos + key.length);
          return true;
      }
    }
    _left(pos) { const b = this._read.buf; return pos > 1 && b.codePointAt(pos - 2) > 0xffff ? pos - 2 : Math.max(0, pos - 1); }
    _right(pos) { const b = this._read.buf; return pos < b.length ? pos + (b.codePointAt(pos) > 0xffff ? 2 : 1) : pos; }
    _wordLeft(pos) {
      const b = this._read.buf;
      while (pos > 0 && !WORD.test(b[pos - 1])) pos--;
      while (pos > 0 && WORD.test(b[pos - 1])) pos--;
      return pos;
    }
    _wordRight(pos) {
      const b = this._read.buf;
      while (pos < b.length && !WORD.test(b[pos])) pos++;
      while (pos < b.length && WORD.test(b[pos])) pos++;
      return pos;
    }
    /** End of line; at the end already, accept the autosuggestion. */
    _toEnd() {
      const r = this._read;
      if (r.pos === r.buf.length && r.suggest) this._edit(r.buf + r.suggest);
      else this._setBuf(r.buf);
    }
    _history(d) {
      const r = this._read; const hst = r.history;
      const i = r.hIndex + d;
      if (r.hidden || i < 0 || i > hst.length) return;
      if (r.hIndex === hst.length) r.draft = r.buf;
      r.hIndex = i;
      this._edit(i === hst.length ? r.draft : hst[i]);
    }

    /* ---- tab completion ---- */
    _complete(dir) {
      const r = this._read;
      if (!r.complete || r.hidden) return;
      if (r.menu) { this._menuStep(dir); return; }
      let res = null;
      try { res = r.complete(r.buf, r.pos); } catch (e) { if (K.debug) console.error(e); }
      const items = (res && res.items) || [];
      if (!items.length) return;
      const head = r.buf.slice(0, res.from); const tail = r.buf.slice(res.to); const word = r.buf.slice(res.from, res.to);
      if (items.length === 1) {
        const it = items[0];
        const text = it.text + (it.dir || tail[0] === ' ' ? '' : ' ');
        this._edit(head + text + tail, head.length + text.length);
        return;
      }
      let common = items[0].text;
      for (const it of items) { let i = 0; while (i < common.length && common[i] === it.text[i]) i++; common = common.slice(0, i); }
      if (common.length > word.length) { this._edit(head + common + tail, head.length + common.length); return; }
      // Nothing more to insert. zsh lists the candidates and walks through them on further Tabs;
      // bash rings the bell and lists them on the second Tab.
      const key = r.buf + '\u0000' + r.pos;
      if (r.zsh) {
        if (r.list && r.list.key === key) { r.menu = { head, tail, items, index: -1 }; this._menuStep(dir); return; }
      } else if (!r.armed) { r.armed = true; return; }
      r.list = { key, items, sel: -1 };
      const perRow = Math.max(1, Math.floor(this.cols / (Math.max.apply(null, items.map((it) => it.display.length)) + 2)));
      const lines = Math.ceil(items.length / perRow);
      if (lines > Math.max(4, this.rows - 2)) {
        r.ask = true;
        this._setBelow(esc(r.zsh ? 'zsh: do you wish to see all ' + items.length + ' possibilities (' + lines + ' lines)? ' : 'Display all ' + items.length + ' possibilities? (y or n)'));
      } else this._showList();
    }
    _askKey(k) {
      const r = this._read;
      r.ask = null;
      if (k.key === 'y' || k.key === 'Y' || k.key === 'Tab' || k.key === ' ') this._showList();
      else { r.list = null; this._setBelow(''); }
      this._syncField();
      return true;
    }
    _menuStep(dir) {
      const r = this._read; const m = r.menu; const n = m.items.length;
      m.index = ((m.index + dir) % n + n) % n;
      const it = m.items[m.index];
      r.buf = m.head + it.text + m.tail; r.pos = m.head.length + it.text.length;
      if (r.list) { r.list.sel = m.index; r.list.key = r.buf + '\u0000' + r.pos; this._showList(); }
      this._syncField(); this._refresh();
    }
    /** Candidates in columns, filled column by column like zsh and ls. */
    _showList() {
      const list = this._read.list;
      const items = list.items.slice(0, LIST_LIMIT);
      const w = Math.max.apply(null, items.map((it) => it.display.length)) + 2;
      const ncol = Math.max(1, Math.floor(this.cols / w)); const nrow = Math.ceil(items.length / ncol);
      let html = '';
      for (let row = 0; row < nrow; row++) {
        for (let c = 0; c < ncol; c++) {
          const i = c * nrow + row;
          if (i >= items.length) continue;
          const it = items[i]; const cls = (it.dir ? 'kt-dir' : '') + (i === list.sel ? ' kt-sel' : '');
          html += (cls ? '<span class="' + cls.trim() + '">' : '<span>') + esc(it.display) + '</span>';
          if ((c + 1) * nrow + row < items.length) html += ' '.repeat(w - it.display.length);
        }
        html += '\n';
      }
      if (list.items.length > items.length) html += '(' + (list.items.length - items.length) + ' more not shown: type more characters to narrow the list)\n';
      this._setBelow(html);
    }

    /* ---- Ctrl-R: incremental reverse search (zsh shows it below the line) ---- */
    _searchStart() {
      const r = this._read;
      r.menu = null; r.list = null;
      r.search = { query: '', index: r.history.length, line: r.buf, pos: r.pos, saved: r.buf, savedPos: r.pos, failed: false };
      this._syncField(); this._searchShow();
    }
    /** Find the newest match at or before the current position (`fresh`), or strictly older (Ctrl-R again). */
    _searchUpdate(fresh) {
      const r = this._read; const s = r.search; const q = s.query;
      if (!q) { s.line = s.saved; s.pos = s.savedPos; s.index = r.history.length; s.failed = false; }
      else {
        let i = Math.min(r.history.length - 1, fresh ? r.history.length - 1 : s.index - 1);
        while (i >= 0 && r.history[i].indexOf(q) < 0) i--;
        s.failed = i < 0;
        if (i >= 0) { s.index = i; s.line = r.history[i]; s.pos = s.line.indexOf(q); }
      }
      this._searchShow();
    }
    _searchShow() {
      const s = this._read.search;
      this._setBelow((s.failed ? 'failing ' : '') + 'bck-i-search: ' + esc(s.query) + '<span class="kt-ul"> </span>');
      this._refresh();
    }
    /** Leave search mode; `keep` puts the found line on the command line. */
    _searchEnd(keep) {
      const r = this._read; const s = r.search;
      r.search = null;
      this._setBelow('');
      if (keep) { r.hIndex = s.index; this._setBuf(s.line, s.line.length); } else this._setBuf(s.saved, s.savedPos);
    }
    _searchKey(k) {
      const r = this._read; const s = r.search; const key = k.key; const lk = key.length === 1 ? key.toLowerCase() : key;
      if (k.ctrl && !k.alt) {
        if (lk === 'r') { this._searchUpdate(false); return true; }
        if (lk === 'g') { this._searchEnd(false); return true; }
        if (lk === 'c') { this._interruptRead(); return true; }
        if (lk === 'h') { s.query = s.query.slice(0, -1); this._syncField(); this._searchUpdate(true); return true; }
        if (lk === 'j' || lk === 'm') { this._submit(); return true; }
        this._searchEnd(true);
        return this._editKey(k);
      }
      if (key === 'Enter') { this._submit(); return true; }
      if (key === 'Backspace') {
        if (k.native) return false;
        s.query = s.query.slice(0, -1); this._syncField(); this._searchUpdate(true);
        return true;
      }
      if (key.length === 1 && !k.alt) {
        if (k.native) return false;
        s.query += key; this._syncField(); this._searchUpdate(true);
        return true;
      }
      if (key.length > 1 && /^F\d+$/.test(key)) return false;
      this._searchEnd(true);
      return key === 'Escape' ? true : this._editKey(k);
    }

    /* ---- full-screen programs ---- */
    pager(text, o) {
      if (this._disposed) return new Promise(() => {});
      return new Promise((resolve) => this._open(new Pager(this, text, o || {}, resolve)));
    }
    editor(o) {
      o = o || {};
      if (this._disposed) return new Promise(() => {});
      return new Promise((resolve) => this._open(new (o.flavor === 'vim' || o.flavor === 'vi' ? Vim : Nano)(this, o, resolve)));
    }
    _open(ov) {
      this._overlay = ov;
      this.over.textContent = ''; this.over.appendChild(ov.el); this.over.hidden = false;
      if (this.opts.onOverlay) { this.opts.onOverlay(true); this.fit(); }      // the app may give the program more room
      this._mode();
      this._syncField();
      ov.resize();
    }
    _closeOverlay() {
      this._overlay = null;
      this.over.hidden = true; this.over.textContent = '';
      if (this.opts.onOverlay) { this.opts.onOverlay(false); this.fit(); }
      this._mode();
      this._syncField();
      this._stick = true; this._schedule();
    }

    /** Show the key bar that matches what is on the screen: the command line, the pager or an editor. */
    _mode() {
      const set = KEYSETS[this.mode] ? this.mode : 'line';
      if (set === this._keyset) return;
      this._keyset = set; this._latch = false;
      this.keys.textContent = '';
      KEYSETS[set].forEach((d, i) => this.keys.appendChild(h('button', {
        type: 'button', class: 'kt-key', 'data-i': String(i), 'data-latch': d.latch ? '' : null,
        'aria-pressed': d.latch ? 'false' : null, 'aria-label': d.name || null, tabindex: '-1', text: d.label,
      })));
    }
  }
  ui.Terminal = Terminal;

  /* --------------------------------------------------------------------- pager
   * less-style viewer. Lines are hard-wrapped to the terminal width and put in
   * a natively scrolling box, so touch scrolling and the wheel work as well as
   * the keys: j k arrows, Space f b, d u, g G, /pattern ?pattern n N, q.
   */
  class Pager {
    constructor(term, text, o, done) {
      this.term = term; this.done = done; this.kind = 'pager';
      this.title = o.title && o.title !== '(standard input)' ? String(o.title) : '';
      // man(1) runs less with its own prompt; a title such as "ls(1)" or "Manual page ls(1)" selects it
      const man = /^(?:Manual page )?(\S+\(\d\w*\))$/.exec(this.title);
      this.man = man ? 'Manual page ' + man[1] : '';
      this.fresh = true; this.sawEnd = false;
      const b = new Buffer();
      b.write(String(text == null ? '' : text));
      this.src = b.lines;
      if (this.src.length > 1 && !this.src[this.src.length - 1].c.length) this.src.pop();   // the text ended with a newline
      this.rows = []; this.marks = null; this.re = null; this.hit = -1; this.input = null; this.msg = '';
      this.body = h('div', { class: 'kt-pager-body' });
      this.status = h('div', { class: 'kt-pager-status' });
      this.el = h('div', { class: 'kt-pager' }, this.body, this.status);
      this.body.addEventListener('scroll', () => this._status());
    }
    abort() { this.done(); }
    paste() {}

    resize() {
      const keep = this.rows.length ? this.rows[this._top()].li : 0;
      const cols = this.term.cols;
      snapRows(this.body, this.term.lineH);
      this.rows = [];
      this.src.forEach((l, li) => {
        const n = l.c.length;
        if (!n) this.rows.push({ li, from: 0, to: 0 });
        for (let from = 0; from < n; from += cols) this.rows.push({ li, from, to: Math.min(n, from + cols) });
      });
      this._render();
      this._goLine(keep);
    }
    _render() {
      const m = this.marks;
      this.body.innerHTML = this.rows.map((r) => '<div class="kt-row">' + (cellsHtml(this.src[r.li], r.from, r.to, m && m[r.li]) || '<br>') + '</div>').join('');
    }
    _visible() { return Math.max(1, Math.floor(this.body.clientHeight / this.term.lineH + 0.01)); }
    _top() { return clamp(Math.round(this.body.scrollTop / this.term.lineH), 0, this.rows.length - 1); }
    _go(top) {
      this.body.scrollTop = clamp(top, 0, Math.max(0, this.rows.length - this._visible())) * this.term.lineH;
      this._status();
    }
    _goLine(li) { this._go(this.rows.findIndex((r) => r.li === li)); }

    _status() {
      const inp = this.input;
      if (inp) { this.status.innerHTML = esc(inp.prefix + inp.text) + '<span class="kt-cursor"> </span>'; return; }
      const text = this.msg || this._prompt();
      this.status.innerHTML = text === ':' ? ':' : '<span class="kt-inv">' + esc(text) + '</span>';
    }
    /** less's short prompt (file name once, then ":" and "(END)"), or the prompt man gives it. */
    _prompt() {
      const top = this._top(); const bot = Math.min(this.rows.length, top + this._visible());
      const end = bot >= this.rows.length;
      if (end) this.sawEnd = true;
      if (this.man) {
        // less learns the length of piped input only when it has read to the end
        const total = this.src.length;
        return ' ' + this.man + ' line ' + (this.rows[top].li + 1) + (this.sawEnd ? '/' + total : '') +
          (end ? ' (END)' : this.sawEnd ? ' ' + Math.floor(this.rows[bot - 1].li * 100 / total) + '%' : '') + ' (press h for help or q to quit)';
      }
      if (end) return '(END)';
      return this.fresh && this.title ? this.title : ':';
    }
    _say(msg) { this.msg = msg; this._status(); }

    key(k) {
      if (this.input) return this._inputKey(k);
      const key = k.key; const lk = key.toLowerCase();
      this.fresh = false;
      if (this.msg) { this.msg = ''; this._status(); if (key === 'Enter') return true; }
      const top = this._top(); const page = this._visible(); const half = Math.max(1, Math.floor(page / 2));
      if (k.ctrl) {
        if (lk === 'f' || lk === 'v') this._go(top + page);
        else if (lk === 'b') this._go(top - page);
        else if (lk === 'd') this._go(top + half);
        else if (lk === 'u') this._go(top - half);
        else if (lk === 'e' || lk === 'n' || lk === 'j') this._go(top + 1);
        else if (lk === 'y' || lk === 'p' || lk === 'k') this._go(top - 1);
        else return OWNED_CTRL.indexOf(lk) >= 0;
        return true;
      }
      switch (key) {
        case 'q': case 'Q': this.term._closeOverlay(); this.done(); return true;
        case 'j': case 'e': case 'ArrowDown': case 'Enter': this._go(top + 1); return true;
        case 'k': case 'y': case 'ArrowUp': this._go(top - 1); return true;
        case ' ': case 'f': case 'PageDown': this._go(top + page); return true;
        case 'b': case 'PageUp': this._go(top - page); return true;
        case 'd': this._go(top + half); return true;
        case 'u': this._go(top - half); return true;
        case 'g': case '<': case 'Home': this._go(0); return true;
        case 'G': case '>': case 'End': this._go(this.rows.length); return true;
        case '/': case '?': this.input = { prefix: key, text: '' }; this._status(); return true;
        case 'n': this._next(this.dir || 1); return true;
        case 'N': this._next(-(this.dir || 1)); return true;
        case 'h': case 'H': this._say('q quit  SPACE/b page  j/k line  g/G top/end  /text search  n/N next/previous'); return true;
        default: return key.length === 1 || key === 'Tab' || key === 'Escape' || key === 'Backspace';
      }
    }
    _inputKey(k) {
      const inp = this.input; const key = k.key;
      if (key === 'Enter') {
        this.input = null;
        this.dir = inp.prefix === '/' ? 1 : -1;
        if (inp.text) this._search(inp.text); else this._next(this.dir);
        return true;
      }
      if (key === 'Escape' || (k.ctrl && (key === 'c' || key === 'g'))) this.input = null;
      else if (key === 'Backspace') { if (inp.text) inp.text = inp.text.slice(0, -1); else this.input = null; }
      else if (key.length === 1 && !k.ctrl && !k.alt) inp.text += key;
      else if (key.length > 1 && /^F\d+$/.test(key)) return false;
      this._status();
      return true;
    }
    _search(pattern) {
      let re;
      try { re = new RegExp(pattern, 'g'); } catch (e) { re = new RegExp(K.util.escapeRe(pattern), 'g'); }
      this.re = re; this.hit = -1;
      this.marks = this.src.map((l) => {
        const text = l.c.join(''); const out = []; let m;
        re.lastIndex = 0;
        while ((m = re.exec(text))) { if (!m[0]) { re.lastIndex++; continue; } out.push([m.index, m.index + m[0].length]); }
        return out.length ? out : null;
      });
      const top = this._top();
      this._render(); this._go(top);
      this._next(this.dir, true);
    }
    _next(dir, first) {
      if (!this.re) { this._say('No previous regular expression  (press RETURN)'); return; }
      const top = this._top(); const from = this.rows[top].li;
      const shown = this.hit >= from && this.hit <= this.rows[Math.min(this.rows.length, top + this._visible()) - 1].li;
      const start = shown ? this.hit : from;
      let li = -1;
      if (dir > 0) { for (let i = first && !shown ? start : start + 1; i < this.src.length; i++) if (this.marks[i]) { li = i; break; } }
      else { for (let i = start - 1; i >= 0; i--) if (this.marks[i]) { li = i; break; } }
      if (li < 0) { this._say('Pattern not found  (press RETURN)'); return; }
      this.hit = li; this._goLine(li);
    }
  }

  /* -------------------------------------------------------------------- editors
   * Shared text model and line rendering. Lines wrap by CSS; the cursor moves
   * over logical lines. Tapping or clicking a line moves the cursor there.
   */
  class Editor {
    constructor(term, o, done) {
      this.term = term; this.done = done;
      this.path = o.path ? String(o.path) : '';
      const content = o.content == null ? '' : String(o.content);
      // commands hand over '' for a file that does not exist yet, so an empty buffer counts as a new file
      this.isNew = o.isNew != null ? !!o.isNew : !content;
      this.lines = content.replace(/\n$/, '').split('\n');
      this.cy = 0; this.cx = 0; this.want = 0; this.hideCursor = false;
      this.saved = false; this.savedContent = content; this.savedPath = this.path;
      this.clean = this.content();     // what is on "disk": the buffer is modified when it differs
      this.text = h('div', { class: 'kt-ed-text' });
      this.body = h('div', { class: 'kt-ed-body' }, this.text);
      this._cache = [];
      this.body.addEventListener('click', (e) => this._click(e));
    }
    content() { return this.lines.length === 1 && !this.lines[0] ? '' : this.lines.join('\n') + '\n'; }
    get lineCount() { return this.lines.length === 1 && !this.lines[0] ? 0 : this.lines.length; }
    get dirty() { return this.content() !== this.clean; }
    abort() { this.done({ saved: this.saved, content: this.savedContent, path: this.savedPath }); }
    close() { this.term._closeOverlay(); this.abort(); }
    resize() { snapRows(this.body, this.term.lineH); this.draw(); }
    write(path) { this.saved = true; this.savedContent = this.clean = this.content(); this.savedPath = this.path = path; this.isNew = false; }

    maxX() { return this.lines[this.cy].length; }
    gutter() { return ''; }
    _paint() {
      const n = this.lines.length; const box = this.text;
      while (box.children.length > n) { box.lastChild.remove(); this._cache.pop(); }
      while (box.children.length < n) { box.appendChild(h('div', { class: 'kt-ed-line' })); this._cache.push(null); }
      for (let i = 0; i < n; i++) {
        const s = this.lines[i]; const cur = i === this.cy && !this.hideCursor;
        const g = this.gutter(i);
        const key = (cur ? this.cx + '\u0001' : '') + g + '\u0001' + s;
        if (this._cache[i] === key) continue;
        this._cache[i] = key;
        const x = Math.min(this.cx, s.length);
        box.children[i].innerHTML = g + (cur ? esc(s.slice(0, x)) + '<span class="kt-cursor">' + esc(s[x] || ' ') + '</span>' + esc(s.slice(x + 1)) : esc(s));
      }
      const el = box.children[this.cy]; const b = this.body;
      if (el.offsetTop < b.scrollTop) b.scrollTop = el.offsetTop;
      else if (el.offsetTop + el.offsetHeight > b.scrollTop + b.clientHeight) b.scrollTop = el.offsetTop + el.offsetHeight - b.clientHeight;
    }
    _click(e) {
      const lineEl = e.target.closest('.kt-ed-line');
      if (!lineEl || this.term.selecting(e) || this.hideCursor) return;
      const i = Array.prototype.indexOf.call(this.text.children, lineEl);
      let node = null; let off = 0;
      if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(e.clientX, e.clientY); if (p) { node = p.offsetNode; off = p.offset; } }
      else if (document.caretRangeFromPoint) { const p = document.caretRangeFromPoint(e.clientX, e.clientY); if (p) { node = p.startContainer; off = p.startOffset; } }
      let x = this.lines[i].length;
      if (node && lineEl.contains(node)) {
        const rg = document.createRange();
        const g = lineEl.querySelector('.kt-vim-nr');
        if (g) rg.setStartAfter(g); else rg.setStart(lineEl, 0);
        rg.setEnd(node, off);
        x = rg.toString().length;
      }
      this.cy = i; this.cx = 0; this.cx = Math.min(x, this.maxX()); this.want = this.cx;
      this.draw();
    }

    insert(str) {
      const parts = str.split('\n'); const l = this.lines[this.cy];
      const head = l.slice(0, this.cx); const tail = l.slice(this.cx);
      if (parts.length === 1) { this.lines[this.cy] = head + str + tail; this.cx += str.length; }
      else {
        const last = parts[parts.length - 1];
        this.lines.splice.apply(this.lines, [this.cy, 1, head + parts[0]].concat(parts.slice(1, -1), [last + tail]));
        this.cy += parts.length - 1; this.cx = last.length;
      }
      this.want = this.cx;
    }
    backspace() {
      const l = this.lines[this.cy];
      if (this.cx > 0) { this.lines[this.cy] = l.slice(0, this.cx - 1) + l.slice(this.cx); this.cx--; }
      else if (this.cy > 0) { const prev = this.lines[this.cy - 1]; this.lines.splice(this.cy - 1, 2, prev + l); this.cy--; this.cx = prev.length; }
      this.want = this.cx;
    }
    del() {
      const l = this.lines[this.cy];
      if (this.cx < l.length) this.lines[this.cy] = l.slice(0, this.cx) + l.slice(this.cx + 1);
      else if (this.cy < this.lines.length - 1) this.lines.splice(this.cy, 2, l + this.lines[this.cy + 1]);
    }
    moveV(d) { this.cy = clamp(this.cy + d, 0, this.lines.length - 1); this.cx = Math.min(this.want, this.maxX()); }
    moveH(d) {
      if (d < 0) { if (this.cx > 0) this.cx--; else if (this.cy > 0) { this.cy--; this.cx = this.maxX(); } }
      else if (this.cx < this.maxX()) this.cx++;
      else if (this.cy < this.lines.length - 1) { this.cy++; this.cx = 0; }
      this.want = this.cx;
    }
    page() { return Math.max(1, Math.floor(this.body.clientHeight / this.term.lineH) - 2); }
    /**
     * Search from the cursor in direction `dir`, wrapping around. `match(line, start, dir)` returns the
     * index of the first match at or after `start` (forward) or the last match before `start` (backward).
     */
    search(match, dir) {
      const n = this.lines.length;
      for (let step = 0; step <= n; step++) {
        const y = ((this.cy + dir * step) % n + n) % n;
        const start = step === 0 ? this.cx + (dir > 0 ? 1 : 0) : dir > 0 ? 0 : Infinity;
        const x = match(this.lines[y], start, dir);
        if (x >= 0) return { y, x, wrapped: step === n || (dir > 0 ? y < this.cy : y > this.cy) };
      }
      return null;
    }
  }
  const isText = (key) => key.length === 1 || (key.length === 2 && key.codePointAt(0) > 0xffff);

  /* ----------------------------------------------------------------------- nano */
  const NANO_MAIN = [['^G', 'Help'], ['^X', 'Exit'], ['^O', 'Write Out'], ['^R', 'Read File'], ['^W', 'Where Is'], ['^\\', 'Replace'],
    ['^K', 'Cut'], ['^U', 'Paste'], ['^T', 'Execute'], ['^J', 'Justify'], ['^C', 'Location'], ['^/', 'Go To Line']];
  const NANO_LEGENDS = {
    yn: [[' Y', 'Yes'], [' N', 'No'], ['', ''], ['^C', 'Cancel']],
    write: [['^G', 'Help'], ['^C', 'Cancel'], ['M-D', 'DOS Format'], ['M-M', 'Mac Format'], ['M-A', 'Append'], ['M-P', 'Prepend'], ['M-B', 'Backup File'], ['^T', 'Browse']],
    search: [['^G', 'Help'], ['^C', 'Cancel'], ['M-C', 'Case Sens'], ['M-R', 'Reg.exp.'], ['M-B', 'Backwards'], ['^R', 'Replace'], ['^P', 'Older'], ['^N', 'Newer']],
    goto: [['^G', 'Help'], ['^C', 'Cancel'], ['^W', 'Beg of Par'], ['^O', 'End of Par'], ['^Y', 'First Line'], ['^V', 'Last Line']],
  };
  const NOT_SIMULATED = 'This nano function is not part of the simulator';

  class Nano extends Editor {
    constructor(term, o, done) {
      super(term, o, done);
      this.kind = 'nano';
      this.cut = []; this.cutRun = false; this.lastSearch = ''; this.prompt = null;
      const n = this.lineCount;
      this.msg = this.isNew ? (this.path ? 'New File' : '') : 'Read ' + n + (n === 1 ? ' line' : ' lines');
      this.titleEl = h('div', { class: 'kt-nano-title' });
      this.statusEl = h('div', { class: 'kt-nano-status' });
      this.legendEl = h('div', { class: 'kt-nano-legend' });
      this.el = h('div', { class: 'kt-ed kt-nano' }, this.titleEl, this.body, this.statusEl, this.legendEl);
    }
    paste(text) { if (this.prompt) { if (this.prompt.kind !== 'yn') this.prompt.text += text.split('\n')[0]; } else this.insert(text); this.draw(); }

    draw() {
      this.titleEl.innerHTML = '<span>  GNU nano ' + NANO_VERSION + '</span><span>' + esc(this.path || 'New Buffer') + '</span><span>' + (this.dirty ? 'Modified' : '') + '</span>';
      this.hideCursor = !!this.prompt;
      this._paint();
      const p = this.prompt;
      if (p) this.statusEl.innerHTML = '<div class="kt-nano-ask">' + esc(p.label + (p.text || '')) + '<span class="kt-cursor"> </span></div>';
      else this.statusEl.innerHTML = this.msg ? '<span class="kt-inv">[ ' + esc(this.msg) + ' ]</span>' : '';
      const items = p ? NANO_LEGENDS[p.kind] : NANO_MAIN;
      const ncol = Math.min(clamp(Math.floor(this.term.cols / 13), 2, 6), Math.ceil(items.length / 2));
      let html = '';
      for (let row = 0; row < 2; row++) {
        for (let c = 0; c < ncol; c++) { const it = items[c * 2 + row] || ['', '']; html += '<span><b>' + esc(it[0]) + '</b> ' + esc(it[1]) + '</span>'; }
      }
      this.legendEl.style.gridTemplateColumns = 'repeat(' + ncol + ', 1fr)';
      this.legendEl.innerHTML = html;
    }

    key(k) {
      if (this.prompt) { const used = this._promptKey(k); if (this.term._overlay === this) this.draw(); return used; }
      const key = k.key; const lk = key.length === 1 ? key.toLowerCase() : key;
      const cutRun = this.cutRun;
      this.msg = ''; this.cutRun = false;
      let used = true;
      if (k.ctrl) {
        switch (lk) {
          case 'x': this._exit(); break;
          case 'o': this._askWrite(false); break;
          case 's': if (this.path) this._save(this.path); else this._askWrite(false); break;
          case 'k': this._cut(cutRun); break;
          case 'u': if (this.cut.length) this.insert(this.cut.join('\n') + '\n'); break;
          case 'w': this._askSearch(); break;
          case 'c': this._where(); break;
          case 'g': this.msg = 'Help is not part of the simulator: the main shortcuts are listed below'; break;
          case 'a': case 'Home': if (lk === 'Home') this.cy = 0; this.cx = this.want = 0; break;
          case 'e': case 'End': if (lk === 'End') this.cy = this.lines.length - 1; this.cx = this.want = this.maxX(); break;
          case 'p': this.moveV(-1); break;
          case 'n': this.moveV(1); break;
          case 'b': this.moveH(-1); break;
          case 'f': this.moveH(1); break;
          case 'y': this.moveV(-this.page()); break;
          case 'v': this.moveV(this.page()); break;
          case 'd': this.del(); break;
          case 'h': this.backspace(); break;
          case 'm': this.insert('\n'); break;
          case 'i': this.insert('\t'); break;
          case '_': case '/': case '-': this._askGoto(); break;
          case 'l': break;
          case 'r': case 't': case 'j': case '\\': case 'q': this.msg = NOT_SIMULATED; break;
          default: used = false;
        }
      } else if (k.alt) {
        if (lk === 'w') this._find(this.lastSearch);
        else if (lk === '\\') { this.cy = 0; this.cx = this.want = 0; }
        else if (lk === '/') { this.cy = this.lines.length - 1; this.cx = this.want = this.maxX(); }
        else if (lk === 'u' || lk === 'e' || lk === 'a' || lk === '6') this.msg = NOT_SIMULATED;
        else used = false;
      } else {
        switch (key) {
          case 'ArrowUp': this.moveV(-1); break;
          case 'ArrowDown': this.moveV(1); break;
          case 'ArrowLeft': this.moveH(-1); break;
          case 'ArrowRight': this.moveH(1); break;
          case 'Home': this.cx = this.want = 0; break;
          case 'End': this.cx = this.want = this.maxX(); break;
          case 'PageUp': this.moveV(-this.page()); break;
          case 'PageDown': this.moveV(this.page()); break;
          case 'Enter': this.insert('\n'); break;
          case 'Backspace': this.backspace(); break;
          case 'Delete': this.del(); break;
          case 'Tab': this.insert('\t'); break;
          case 'Escape': break;
          case 'F2': this._exit(); break;
          case 'F3': this._askWrite(false); break;
          case 'F6': this._askSearch(); break;
          case 'F9': this._cut(cutRun); break;
          case 'F10': if (this.cut.length) this.insert(this.cut.join('\n') + '\n'); break;
          default: if (isText(key)) this.insert(key); else used = false;
        }
      }
      if (this.term._overlay === this) this.draw();
      return used;
    }

    _ask(kind, label, text, enter) { this.prompt = { kind, label, text, enter }; }
    _promptKey(k) {
      const p = this.prompt; const key = k.key; const lk = key.toLowerCase();
      if ((k.ctrl && lk === 'c') || key === 'Escape') { this.prompt = null; this.msg = 'Cancelled'; return true; }
      if (p.kind === 'yn') {
        if (lk === 'y' && !k.ctrl) { this.prompt = null; this._askWrite(true); }
        else if (lk === 'n' && !k.ctrl) this.close();
        return key.length === 1 || OWNED_CTRL.indexOf(lk) >= 0;
      }
      if (key === 'Enter' || (k.ctrl && lk === 'm')) { this.prompt = null; p.enter(p.text); }
      else if (key === 'Backspace' || (k.ctrl && lk === 'h')) p.text = p.text.slice(0, -1);
      else if (isText(key) && !k.ctrl && !k.alt) p.text += key;
      else if (/^F\d+$/.test(key)) return false;
      return true;
    }
    _exit() {
      if (!this.dirty) { this.close(); return; }
      this._ask('yn', 'Save modified buffer? ', '', null);
    }
    _askWrite(thenExit) {
      this._ask('write', 'File Name to Write: ', this.path, (name) => {
        name = name.trim();
        if (!name) { this.msg = 'Cancelled'; return; }
        this._save(name);
        if (thenExit) this.close();
      });
    }
    _save(name) {
      this.write(name);
      const n = this.lineCount;
      this.msg = 'Wrote ' + n + (n === 1 ? ' line' : ' lines');
    }
    _cut(again) {
      if (this.cy === this.lines.length - 1 && !this.lines[this.cy]) return;
      if (!again) this.cut = [];
      this.cut.push(this.lines[this.cy]);
      if (this.lines.length > 1) this.lines.splice(this.cy, 1); else this.lines[0] = '';
      this.cy = Math.min(this.cy, this.lines.length - 1);
      this.cx = this.want = 0; this.cutRun = true;
    }
    _where() {
      const pct = (a, b) => Math.floor(b ? a * 100 / b : 0);
      const total = this.lines.reduce((s, l) => s + l.length + 1, 0);
      let before = this.cx;
      for (let i = 0; i < this.cy; i++) before += this.lines[i].length + 1;
      const cols = this.lines[this.cy].length + 1;
      this.msg = 'line ' + (this.cy + 1) + '/' + this.lines.length + ' (' + pct(this.cy + 1, this.lines.length) + '%), col ' + (this.cx + 1) + '/' + cols +
        ' (' + pct(this.cx + 1, cols) + '%), char ' + before + '/' + total + ' (' + pct(before, total) + '%)';
    }
    _askSearch() {
      this._ask('search', 'Search' + (this.lastSearch ? ' [' + this.lastSearch + ']' : '') + ': ', '', (q) => {
        if (!q && !this.lastSearch) { this.msg = 'Cancelled'; return; }
        this._find(q || this.lastSearch);
      });
    }
    _find(q) {
      if (!q) { this.msg = 'No current search pattern'; return; }
      this.lastSearch = q;
      const needle = q.toLowerCase();
      const hit = this.search((line, start) => line.toLowerCase().indexOf(needle, start), 1);
      if (!hit) { this.msg = '"' + q + '" not found'; return; }
      if (hit.y === this.cy && hit.x === this.cx) this.msg = 'This is the only occurrence';
      else if (hit.wrapped) this.msg = 'Search Wrapped';
      this.cy = hit.y; this.cx = this.want = hit.x;
    }
    _askGoto() {
      this._ask('goto', 'Enter line number, column number: ', '', (v) => {
        const m = /^\s*(-?\d+)?\s*(?:[ ,]\s*(-?\d+))?\s*$/.exec(v);
        if (!m || (m[1] == null && m[2] == null)) { this.msg = v.trim() ? 'Invalid line or column number' : 'Cancelled'; return; }
        if (m[1] != null) { const n = parseInt(m[1], 10); this.cy = clamp(n < 0 ? this.lines.length + n : n - 1, 0, this.lines.length - 1); }
        this.cx = this.want = clamp((m[2] == null ? 1 : parseInt(m[2], 10)) - 1, 0, this.maxX());
      });
    }
  }

  /* ------------------------------------------------------------------------ vim
   * Enough of vim to learn the basics: normal, insert and command-line modes;
   * counts; h j k l w b e 0 ^ $ gg G; i a I A o O; x X r J D C; d/y/c with
   * w e $ 0 and doubled (dd yy cc); p P; u and Ctrl-R; /pattern ?pattern n N;
   * :w :q :q! :wq :x :N :set nu; ZZ ZQ.
   */
  class Vim extends Editor {
    constructor(term, o, done) {
      super(term, o, done);
      this.kind = 'vim';
      this.mode = 'normal'; this.count = ''; this.op = ''; this.opCount = 0; this.cmd = ''; this.cmdPrefix = ':';
      this.reg = null; this.undo = []; this.redo = []; this.nu = false; this.ic = false; this.re = null; this.dir = 1;
      this.msgKind = '';
      this.msg = this.path ? this._fileInfo(this.isNew ? ' [New]' : '') : '';
      this.statusEl = h('div', { class: 'kt-vim-status' });
      this.fill = this.body.appendChild(h('div', { class: 'kt-vim-fill', 'aria-hidden': 'true' }));
      this.el = h('div', { class: 'kt-ed kt-vim' }, this.body, this.statusEl);
    }
    _fileInfo(tag) { return '"' + this.path + '"' + (tag === ' [New]' && !this.saved ? ' [New]' : tag + ' ' + this.lineCount + 'L, ' + K.util.byteLen(this.content()) + 'B'); }
    maxX() { const n = this.lines[this.cy].length; return this.mode === 'insert' ? n : Math.max(0, n - 1); }
    gutter(i) { return this.nu ? '<span class="kt-vim-nr">' + String(i + 1).padStart(Math.max(3, String(this.lines.length).length)) + ' </span>' : ''; }
    paste(text) { if (this.mode === 'insert') { this.insert(text); this.draw(); } else if (this.mode !== 'normal') { this.cmd += text.split('\n')[0]; this.draw(); } }

    draw() {
      this.hideCursor = this.mode === 'cmd';
      this.cx = clamp(this.cx, 0, this.maxX());
      this._paint();
      // tildes for the screen lines past the end of the buffer, never more than fit (they must not scroll)
      this.fill.textContent = '~\n'.repeat(Math.max(0, Math.floor((this.body.clientHeight - this.text.offsetHeight) / this.term.lineH)));
      if (this.mode === 'cmd') { this.statusEl.innerHTML = '<span class="kt-vim-msg">' + esc(this.cmdPrefix + this.cmd) + '<span class="kt-cursor"> </span></span>'; return; }
      const b = this.body; const more = b.scrollHeight - b.clientHeight;
      const where = more <= 1 ? 'All' : b.scrollTop <= 0 ? 'Top' : b.scrollTop >= more - 1 ? 'Bot' : Math.floor(b.scrollTop * 100 / more) + '%';
      const len = this.lines[this.cy].length;
      const ruler = (this.cy + 1) + ',' + (len ? this.cx + 1 : '0-1');
      const left = this.mode === 'insert' && !this.msg ? '<b>-- INSERT --</b>' : '<span class="' + (this.msgKind ? 'kt-vim-' + this.msgKind : '') + '">' + esc(this.msg) + '</span>';
      this.statusEl.innerHTML = '<span class="kt-vim-msg">' + left + '</span><span class="kt-vim-pend">' + esc((this.opCount || '') + this.op + this.count) + '</span>' +
        '<span class="kt-vim-ruler">' + esc(ruler.padEnd(10) + where) + '</span>';
    }
    _say(msg, kind) { this.msg = msg; this.msgKind = kind || ''; }
    _err(msg) { this._say(msg, 'err'); }

    key(k) {
      const before = this.msg;
      let used;
      if (this.mode === 'insert') used = this._insertKey(k);
      else if (this.mode === 'cmd') used = this._cmdKey(k);
      else used = this._normalKey(k);
      if (used && this.msg === before && this.mode !== 'cmd') this.msg = '';   // a message lasts until the next key
      if (this.term._overlay === this) this.draw();
      return used;
    }

    /* ---- helpers ---- */
    _snap() { this.undo.push({ lines: this.lines.slice(), cy: this.cy, cx: this.cx }); if (this.undo.length > 200) this.undo.shift(); this.redo = []; }
    _restore(from, to, none) {
      const s = from.pop();
      if (!s) { this._say(none); return; }
      to.push({ lines: this.lines.slice(), cy: this.cy, cx: this.cx });
      this.lines = s.lines; this.cy = s.cy; this.cx = s.cx; this.want = this.cx;
    }
    _firstNonBlank() { const m = /\S/.exec(this.lines[this.cy]); this.cx = this.want = m ? m.index : 0; }
    _gotoLine(n) { this.cy = clamp(n - 1, 0, this.lines.length - 1); this._firstNonBlank(); }
    _cls(ch) { return ch === undefined || /\s/.test(ch) ? 0 : /\w/.test(ch) ? 1 : 2; }
    _wordFwd(y, x) {
      let line = this.lines[y]; const c0 = this._cls(line[x]);
      if (c0) while (x < line.length && this._cls(line[x]) === c0) x++;
      for (;;) {
        while (x < line.length && !this._cls(line[x])) x++;
        if (x < line.length) return [y, x];
        if (y >= this.lines.length - 1) return [y, line.length];
        y++; x = 0; line = this.lines[y];
        if (!line.length) return [y, 0];
      }
    }
    _wordBack(y, x) {
      let line = this.lines[y];
      for (;;) {
        x--;
        while (x >= 0 && !this._cls(line[x])) x--;
        if (x >= 0) break;
        if (y === 0) return [0, 0];
        y--; line = this.lines[y]; x = line.length;
        if (!line.length) return [y, 0];
      }
      const c = this._cls(line[x]);
      while (x > 0 && this._cls(line[x - 1]) === c) x--;
      return [y, x];
    }
    _wordEnd(y, x) {
      let line = this.lines[y];
      x++;
      for (;;) {
        while (x < line.length && !this._cls(line[x])) x++;
        if (x < line.length) break;
        if (y >= this.lines.length - 1) return [y, Math.max(0, line.length - 1)];
        y++; line = this.lines[y]; x = 0;
      }
      const c = this._cls(line[x]);
      while (x + 1 < line.length && this._cls(line[x + 1]) === c) x++;
      return [y, x];
    }
    _repeat(fn, n) { let p = [this.cy, this.cx]; for (let i = 0; i < n; i++) p = fn.call(this, p[0], p[1]); return p; }
    _startInsert() { this._snap(); this.mode = 'insert'; }
    _endInsert() {
      const top = this.undo[this.undo.length - 1];
      if (top && top.lines.length === this.lines.length && top.lines.every((l, i) => l === this.lines[i])) this.undo.pop();
      this.mode = 'normal'; this.cx = this.want = Math.max(0, this.cx - 1);
    }
    _reset() { this.count = ''; this.op = ''; this.opCount = 0; }

    /* ---- insert mode ---- */
    _insertKey(k) {
      const key = k.key; const lk = key.toLowerCase();
      if (key === 'Escape' || (k.ctrl && (lk === '[' || lk === 'c'))) { this._endInsert(); return true; }
      if (k.ctrl) {
        if (lk === 'h') this.backspace(); else if (lk === 'm' || lk === 'j') this.insert('\n'); else if (lk === 'i') this.insert('\t');
        else return OWNED_CTRL.indexOf(lk) >= 0;
        return true;
      }
      switch (key) {
        case 'Enter': this.insert('\n'); return true;
        case 'Backspace': this.backspace(); return true;
        case 'Delete': this.del(); return true;
        case 'Tab': this.insert('\t'); return true;
        case 'ArrowUp': this.moveV(-1); return true;
        case 'ArrowDown': this.moveV(1); return true;
        case 'ArrowLeft': if (this.cx > 0) this.cx--; this.want = this.cx; return true;
        case 'ArrowRight': if (this.cx < this.maxX()) this.cx++; this.want = this.cx; return true;
        case 'Home': this.cx = this.want = 0; return true;
        case 'End': this.cx = this.want = this.maxX(); return true;
        default: if (isText(key) && !k.alt) { this.insert(key); return true; } return false;
      }
    }

    /* ---- normal mode ---- */
    _normalKey(k) {
      const key = k.key; const lk = key.toLowerCase();
      if (k.ctrl) {
        const page = this.page();
        if (lk === 'r') this._restore(this.redo, this.undo, 'Already at newest change');
        else if (lk === 'f') this.moveV(page);
        else if (lk === 'b') this.moveV(-page);
        else if (lk === 'd') this.moveV(Math.ceil(page / 2));
        else if (lk === 'u') this.moveV(-Math.ceil(page / 2));
        else if (lk === 'c') this._say('Type  :qa  and press <Enter> to exit Vim');
        else if (lk === 'g') this._say(this.path ? this._fileInfo('') : '"[No Name]"');
        else if (lk !== '[' && lk !== 'l') return OWNED_CTRL.indexOf(lk) >= 0;
        this._reset();
        return true;
      }
      if (key === 'Escape') { this._reset(); return true; }
      if (this.op === 'r') {
        const l = this.lines[this.cy];
        if (isText(key) && l.length) { this._snap(); this.lines[this.cy] = l.slice(0, this.cx) + key + l.slice(this.cx + 1); }
        this._reset();
        return true;
      }
      if (/^[1-9]$/.test(key) || (key === '0' && this.count)) { this.count += key; return true; }
      const counted = !!(this.count || this.opCount);
      const n = Math.min((this.count ? parseInt(this.count, 10) : 1) * (this.opCount || 1), 100000);
      if (this.op) { const op = this.op; this._reset(); this._operate(op, key, n, counted); return true; }
      this.count = '';
      const L = this.lines; const line = L[this.cy]; let p;
      switch (key) {
        case 'h': case 'ArrowLeft': case 'Backspace': this.cx = this.want = Math.max(0, this.cx - n); break;
        case 'l': case 'ArrowRight': case ' ': this.cx = this.want = Math.min(this.maxX(), this.cx + n); break;
        case 'j': case 'ArrowDown': this.moveV(n); break;
        case 'k': case 'ArrowUp': this.moveV(-n); break;
        case 'Enter': case '+': this.cy = Math.min(L.length - 1, this.cy + n); this._firstNonBlank(); break;
        case '-': this.cy = Math.max(0, this.cy - n); this._firstNonBlank(); break;
        case '0': case 'Home': this.cx = this.want = 0; break;
        case '^': this._firstNonBlank(); break;
        case '$': case 'End': this.cx = this.maxX(); this.want = Infinity; break;
        case 'w': p = this._repeat(this._wordFwd, n); this.cy = p[0]; this.cx = this.want = p[1]; break;
        case 'b': p = this._repeat(this._wordBack, n); this.cy = p[0]; this.cx = this.want = p[1]; break;
        case 'e': p = this._repeat(this._wordEnd, n); this.cy = p[0]; this.cx = this.want = p[1]; break;
        case 'G': this._gotoLine(counted ? n : L.length); break;
        case 'g': case 'Z': case 'r': case 'd': case 'y': case 'c': this.op = key; this.opCount = counted ? n : 0; break;
        case 'i': this._startInsert(); break;
        case 'a': this._startInsert(); if (line.length) this.cx++; break;
        case 'I': this._startInsert(); this._firstNonBlank(); break;
        case 'A': this._startInsert(); this.cx = line.length; break;
        case 'o': this._startInsert(); L.splice(this.cy + 1, 0, ''); this.cy++; this.cx = 0; break;
        case 'O': this._startInsert(); L.splice(this.cy, 0, ''); this.cx = 0; break;
        case 'x': case 'Delete': this._change('d', this.cx, Math.min(line.length, this.cx + n)); break;
        case 'X': this._change('d', Math.max(0, this.cx - n), this.cx); break;
        case 'D': this._change('d', this.cx, line.length); break;
        case 'C': this._change('c', this.cx, line.length); break;
        case 'J':
          if (this.cy < L.length - 1) {
            this._snap();
            for (let i = 0; i < Math.max(1, n - 1) && this.cy < L.length - 1; i++) {
              const a = L[this.cy].replace(/\s+$/, ''); const b = L[this.cy + 1].replace(/^\s+/, '');
              L.splice(this.cy, 2, a + (a && b ? ' ' : '') + b); this.cx = this.want = Math.max(0, a.length - (b ? 0 : 1));
            }
          }
          break;
        case 'p': case 'P': this._put(key === 'p', n); break;
        case 'u': this._restore(this.undo, this.redo, 'Already at oldest change'); break;
        case '/': case '?': case ':': this.mode = 'cmd'; this.cmdPrefix = key; this.cmd = ''; break;
        case 'n': this._searchNext(this.dir); break;
        case 'N': this._searchNext(-this.dir); break;
        default: return isText(key) || key === 'Tab';
      }
      return true;
    }
    /** Apply operator d, y or c (or the g and Z prefixes) to the motion `key`. */
    _operate(op, key, n, counted) {
      if (op === 'g') { if (key === 'g') this._gotoLine(counted ? n : 1); return; }
      if (op === 'Z') { if (key === 'Z') this._ex('x'); else if (key === 'Q') this._ex('q!'); return; }
      const y = this.cy; const line = this.lines[y]; let p;
      if (key === op) { this._changeLines(op, n); return; }
      switch (key) {
        case 'w':
          // cw behaves like ce: it stops at the end of the word instead of swallowing the space
          if (op === 'c' && this._cls(line[this.cx])) { p = this._repeat(this._wordEnd, n); this._change(op, this.cx, p[0] === y ? p[1] + 1 : line.length); }
          else { p = this._repeat(this._wordFwd, n); this._change(op, this.cx, p[0] === y ? p[1] : line.length); }
          break;
        case 'e': p = this._repeat(this._wordEnd, n); this._change(op, this.cx, p[0] === y ? p[1] + 1 : line.length); break;
        case 'b': p = this._repeat(this._wordBack, n); this._change(op, p[0] === y ? p[1] : 0, this.cx); break;
        case '$': this._change(op, this.cx, line.length); break;
        case '0': this._change(op, 0, this.cx); break;
        case 'l': case ' ': this._change(op, this.cx, Math.min(line.length, this.cx + n)); break;
        case 'h': this._change(op, Math.max(0, this.cx - n), this.cx); break;
        default: break;
      }
    }
    /** d, y or c over [from, to) of the current line. */
    _change(op, from, to) {
      const line = this.lines[this.cy];
      this.reg = { text: line.slice(from, to), linewise: false };
      if (op === 'y') { this.cx = this.want = from; return; }
      if (op === 'c') this._startInsert(); else if (from < to) this._snap();
      this.lines[this.cy] = line.slice(0, from) + line.slice(to);
      this.cx = this.want = clamp(from, 0, this.maxX());
    }
    /** dd, yy or cc over n lines. */
    _changeLines(op, n) {
      const y = this.cy; const count = Math.min(n, this.lines.length - y);
      this.reg = { lines: this.lines.slice(y, y + count), linewise: true };
      if (op === 'y') { if (count > 2) this._say(count + ' lines yanked'); return; }
      if (op === 'c') { this._startInsert(); this.lines.splice(y, count, ''); this.cx = 0; return; }
      this._snap();
      this.lines.splice(y, count);
      if (!this.lines.length) this.lines.push('');
      this.cy = Math.min(y, this.lines.length - 1); this._firstNonBlank();
      if (count > 2) this._say(count + ' fewer lines');
    }
    _put(after, n) {
      const r = this.reg;
      if (!r) { this._err('E353: Nothing in register "'); return; }
      this._snap();
      if (r.linewise) {
        let block = [];
        for (let i = 0; i < n; i++) block = block.concat(r.lines);
        const at = this.cy + (after ? 1 : 0);
        this.lines.splice.apply(this.lines, [at, 0].concat(block));
        this.cy = at; this._firstNonBlank();
        if (block.length > 2) this._say(block.length + ' more lines');
      } else {
        const line = this.lines[this.cy]; const text = r.text.repeat(n);
        const at = after && line.length ? this.cx + 1 : this.cx;
        this.lines[this.cy] = line.slice(0, at) + text + line.slice(at);
        this.cx = this.want = Math.max(0, at + text.length - 1);
      }
    }

    /* ---- command line and search ---- */
    _cmdKey(k) {
      const key = k.key; const lk = key.toLowerCase();
      if (key === 'Escape' || (k.ctrl && (lk === 'c' || lk === '['))) { this.mode = 'normal'; return true; }
      if (key === 'Enter' || (k.ctrl && (lk === 'm' || lk === 'j'))) {
        this.mode = 'normal';
        if (this.cmdPrefix === ':') this._ex(this.cmd); else this._searchSet(this.cmd, this.cmdPrefix === '/' ? 1 : -1);
        return true;
      }
      if (key === 'Backspace' || (k.ctrl && lk === 'h')) { if (this.cmd) this.cmd = this.cmd.slice(0, -1); else this.mode = 'normal'; return true; }
      if (isText(key) && !k.ctrl && !k.alt) { this.cmd += key; return true; }
      return !/^F\d+$/.test(key);
    }
    _searchSet(pattern, dir) {
      this.dir = dir;
      if (pattern) {
        try { this.re = new RegExp(pattern, this.ic ? 'gi' : 'g'); } catch (e) { this.re = new RegExp(K.util.escapeRe(pattern), this.ic ? 'gi' : 'g'); }
        this.pattern = pattern;
      }
      this._searchNext(dir);
    }
    _searchNext(dir) {
      const re = this.re;
      if (!re) { this._err('E35: No previous regular expression'); return; }
      const hit = this.search((line, start, d) => {
        let found = -1; let m;
        re.lastIndex = d > 0 ? Math.min(start, line.length + 1) : 0;
        while ((m = re.exec(line))) {
          if (d > 0) return m.index;
          if (m.index >= start) break;
          found = m.index;
          if (!m[0]) re.lastIndex++;
        }
        return found;
      }, dir);
      if (!hit) { this._err('E486: Pattern not found: ' + this.pattern); return; }
      if (hit.wrapped) this._say(dir > 0 ? 'search hit BOTTOM, continuing at TOP' : 'search hit TOP, continuing at BOTTOM', 'warn');
      else this._say((dir > 0 ? '/' : '?') + this.pattern);
      this.cy = hit.y; this.cx = this.want = hit.x;
    }
    _ex(input) {
      const s = input.trim().replace(/^:+/, '');
      if (!s) return;
      if (/^\d+$/.test(s)) { this._gotoLine(parseInt(s, 10)); return; }
      if (s === '$') { this._gotoLine(this.lines.length); return; }
      const m = /^([A-Za-z]+)(!?)\s*(.*)$/.exec(s);
      const name = m ? m[1] : ''; const bang = !!(m && m[2]); const arg = m ? m[3].trim() : '';
      const is = (full, min) => name.length >= min && full.lastIndexOf(name, 0) === 0;
      if (!m) this._err('E492: Not an editor command: ' + s);
      else if (is('write', 1)) this._w(arg);
      else if (is('quit', 1) || is('qall', 2)) { if (this.dirty && !bang) this._err('E37: No write since last change (add ! to override)'); else this.close(); }
      else if (name === 'wq' || name === 'wqa' || name === 'wqall' || name === 'xa' || name === 'xall' || is('xit', 1) || is('exit', 3)) {
        if (name[0] === 'w' || this.dirty || this.isNew) { if (this._w(arg)) this.close(); } else this.close();
      } else if (is('set', 2)) this._set(arg);
      else if (is('edit', 1) && bang && !arg) { this._snap(); this.lines = this.clean.replace(/\n$/, '').split('\n'); this.cy = 0; this.cx = 0; }
      else if (is('nohlsearch', 3)) { /* matches are never highlighted here */ }
      else if (is('help', 1)) this._say('Help files are not part of the simulator. On a real system run vimtutor.');
      else this._err('E492: Not an editor command: ' + s);
    }
    _w(arg) {
      const path = arg || this.path;
      if (!path) { this._err('E32: No file name'); return false; }
      const fresh = this.isNew || path !== this.path;
      this.write(path);
      this._say('"' + path + '"' + (fresh ? ' [New]' : '') + ' ' + this.lineCount + 'L, ' + K.util.byteLen(this.clean) + 'B written');
      return true;
    }
    _set(arg) {
      for (const opt of arg.split(/\s+/).filter(Boolean)) {
        if (opt === 'nu' || opt === 'number') this.nu = true;
        else if (opt === 'nonu' || opt === 'nonumber') this.nu = false;
        else if (opt === 'ic' || opt === 'ignorecase') this.ic = true;
        else if (opt === 'noic' || opt === 'noignorecase') this.ic = false;
        else if (!/^(no)?(hls|hlsearch|is|incsearch|wrap|list|ai|autoindent|et|expandtab|ru|ruler|sm|showmatch)$|^(ts|tabstop|sw|shiftwidth|mouse|bg|background)=/.test(opt)) { this._err('E518: Unknown option: ' + opt.replace(/[=!?].*$/, '')); return; }
      }
      this._cache = [];
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
