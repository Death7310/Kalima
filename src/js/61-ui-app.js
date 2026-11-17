/* Kalima — application shell (DOM code lives only in *-ui-* files).
 *
 * K.ui.md(text)   markdown-lite to HTML for lesson text
 * K.app           the running App: terminal tabs, lesson panel, lab panel, settings
 *
 * The app boots the simulator with K.boot({ term, home }), runs the shell's
 * read-eval loop in every terminal tab and restarts the whole simulated
 * machine on a 'power' event. Everything it remembers lives in localStorage.
 */
;(function (root) {
  'use strict';
  const K = root.K;
  if (!K || typeof document === 'undefined' || !K.ui || !K.ui.Terminal) return;
  const ui = K.ui; const h = ui.h; const esc = ui.esc;

  const WIDE = '(min-width: 900px)';     // keep in step with the media queries in 20-app.css
  const MAX_TABS = 4;
  const SIDE_MIN = 300; const SIDE_MAX = 720; const SIDE_DEFAULT = 420; const WORK_MIN = 380;
  const CELEBRATE_MS = 1100;             // how long a finished step shows its success state before the next one opens
  const SPEEDS = [
    { value: 1, label: 'Real time', note: 'Waits take as long as on a real system: a second between pings.' },
    { value: 0.2, label: 'Fast', note: 'Waits are five times shorter.' },
    { value: 0, label: 'Instant', note: 'Nothing waits. Good for repeating a lesson.' },
  ];
  const KEYBARS = [{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'Always' }, { value: 'off', label: 'Never' }];

  /* ------------------------------------------------------------------ storage
   * localStorage can be missing, full or forbidden (private windows, some
   * file:// setups), so every access is guarded and failure only means that
   * nothing is remembered.
   */
  const STORE_PREFIX = 'kalima.v1.';
  const store = {
    get(key, fallback) {
      try {
        const raw = root.localStorage.getItem(STORE_PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { root.localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    clear() {
      try {
        const ls = root.localStorage; const doomed = [];
        for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.indexOf(STORE_PREFIX) === 0) doomed.push(k); }
        doomed.forEach((k) => ls.removeItem(k));
      } catch (e) { /* nothing stored */ }
    },
  };

  /* ------------------------------------------------------------ markdown-lite
   * Lesson text: paragraphs, "- " lists, `code`, **bold**, *italic* and fenced
   * code blocks. All HTML is escaped first, so lesson text can never inject
   * markup.
   */
  function mdInline(escaped) {
    return escaped.split(/(`[^`]+`)/).map((part, i) => {
      if (i % 2) return '<code>' + part.slice(1, -1) + '</code>';
      return part
        .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^\w*])\*(\S(?:[^*]*?\S)?)\*(?![\w*])/g, '$1<em>$2</em>');
    }).join('');
  }
  ui.md = function (text) {
    const lines = esc(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    let html = ''; let para = []; let list = null;
    const endPara = () => { if (para.length) { html += '<p>' + mdInline(para.join(' ')) + '</p>'; para = []; } };
    const endList = () => { if (list) { html += '<ul>' + list.map((item) => '<li>' + mdInline(item) + '</li>').join('') + '</ul>'; list = null; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        endPara(); endList();
        const code = [];
        for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
        html += '<pre><code>' + code.join('\n') + '</code></pre>';
        continue;
      }
      const item = /^\s*- (.*)$/.exec(line);
      if (item) { endPara(); (list = list || []).push(item[1]); continue; }
      if (!line.trim()) { endPara(); endList(); continue; }
      if (list && /^\s+\S/.test(line)) { list[list.length - 1] += ' ' + line.trim(); continue; }   // an indented line continues the item
      endList();
      para.push(line.trim());
    }
    endPara(); endList();
    return html;
  };
  /** The text of a markdown-lite string without any markup (for one-line summaries). */
  function mdText(text) {
    const box = document.createElement('div');
    box.innerHTML = ui.md(text).replace(/<\/(p|li|pre)>/g, ' </$1>');
    return box.textContent.replace(/\s+/g, ' ').trim();
  }

  /* -------------------------------------------------------------------- icons */
  const ICONS = {
    book: 'M12 6.5C10 5.2 7.5 4.5 4 4.5v13c3.5 0 6 .7 8 2 2-1.3 4.5-2 8-2v-13c-3.5 0-6 .7-8 2zM12 6.5v13',
    lab: 'M12 7.5v4M12 11.5l-5.2 5.3M12 11.5l5.2 5.3M14.5 5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM7.5 19a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM21.5 19a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
    sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5',
    plus: 'M12 5v14M5 12h14',
    close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
    back: 'M14.5 5.5L8 12l6.5 6.5',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    terminal: 'M4 5.5h16v13H4zM7.5 10l3 2.2-3 2.3M12.5 14.5H16',
  };
  const icon = (name) => '<svg class="k-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="' + ICONS[name] + '"/></svg>';
  const MARK = '<svg class="k-mark" viewBox="0 0 28 28" aria-hidden="true"><rect x="1.5" y="1.5" width="25" height="25" rx="7"/>' +
    '<path class="k-mark-a" d="M8.5 9.5l5 4.5-5 4.5"/><path class="k-mark-b" d="M15.5 19h5"/></svg>';

  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  /* ---------------------------------------------------------------------- app */
  class App {
    constructor(host) {
      this.host = host;
      this.wide = root.matchMedia(WIDE);
      this.settings = Object.assign({ timeScale: 1, fontSize: this.wide.matches ? 14 : 12, keybar: 'auto', welcomed: false }, store.get('settings', {}));
      this.state = Object.assign({ lesson: null, view: null, sideWidth: SIDE_DEFAULT, lessonOpen: true, labOpen: null }, store.get('ui', {}));
      this.found = store.get('lab', {});     // lab hosts seen so far, by IP: { up, ports: { 'tcp/22': true } }
      this.tabs = []; this.active = null; this.term = null; this.tabSeq = 0;
      this.booted = false;
      this.stepUi = {};                      // hint, solution and answer state of the current step
      this.celebrating = null;               // id of the step showing its success state
      this.picks = {};                       // quiz choices made in this session: lessonId -> { index: choice }
    }

    async start() {
      K.settings.timeScale = this.settings.timeScale;
      K.lessons.progress.attach(store.get('progress', null), (data) => store.set('progress', data));
      if (this.state.view == null) this.state.view = K.lessons.modules.length ? 'lesson' : 'terminal';
      if (this.state.labOpen == null) this.state.labOpen = root.innerWidth >= 1320;
      this._build();
      this._listen();
      await this._boot(store.get('home', null));
      this.renderLesson();
      this.renderLab();
      if (!this.settings.welcomed) this.showWelcome();
    }

    /* ---------------------------------------------------------------- layout */
    _build() {
      const viewTab = (id, label) => h('button', {
        type: 'button', class: 'k-view-tab', role: 'tab', 'data-view': id, 'aria-controls': 'k-panel-' + id, onclick: () => this.setView(id),
      }, label);
      this.viewTabs = [viewTab('lesson', 'Lesson'), viewTab('terminal', 'Terminal'), viewTab('lab', 'Lab')];
      this.progressEl = h('button', { type: 'button', class: 'k-top-progress', hidden: true, onclick: () => this.openBrowser() });
      this.btnLesson = h('button', { type: 'button', class: 'k-icon-btn k-wide-only', title: 'Lesson panel', 'aria-label': 'Lesson panel', html: icon('book'), onclick: () => this.togglePanel('lessonOpen') });
      this.btnLab = h('button', { type: 'button', class: 'k-icon-btn k-wide-only', title: 'Lab panel', 'aria-label': 'Lab panel', html: icon('lab'), onclick: () => this.togglePanel('labOpen') });
      const top = h('header', { class: 'k-top' },
        h('div', { class: 'k-brand', html: MARK }, h('span', { class: 'k-brand-name' }, 'Kalima')),
        h('nav', { class: 'k-views k-narrow-only', role: 'tablist', 'aria-label': 'Views' }, this.viewTabs[0], this.viewTabs[1], this.viewTabs[2]),
        this.progressEl,
        h('div', { class: 'k-top-actions' }, this.btnLesson, this.btnLab,
          h('button', { type: 'button', class: 'k-icon-btn', title: 'Settings', 'aria-label': 'Settings', html: icon('sliders'), onclick: () => this.showSettings() })));

      this.lessonHead = h('div', { class: 'k-panel-head' });
      this.lessonBody = h('div', { class: 'k-panel-body k-scroll', tabindex: '-1' });
      this.lessonEl = h('aside', { class: 'k-panel k-lesson', id: 'k-panel-lesson', 'aria-label': 'Lessons' }, this.lessonHead, this.lessonBody);
      this.splitEl = h('div', { class: 'k-split k-wide-only', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the lesson panel', tabindex: '0' });
      this.termTabsEl = h('div', { class: 'k-termtabs', role: 'tablist', 'aria-label': 'Terminal tabs' });
      this.btnNewTab = h('button', { type: 'button', class: 'k-icon-btn k-newtab', title: 'New terminal tab', 'aria-label': 'New terminal tab', html: icon('plus'), onclick: () => this.newTab() });
      this.taskEl = h('button', { type: 'button', class: 'k-task k-narrow-only', hidden: true, onclick: () => this.setView('lesson') });
      this.termHost = h('div', { class: 'k-term-stack' });
      this.workEl = h('main', { class: 'k-work', id: 'k-panel-terminal' }, h('div', { class: 'k-termbar' }, this.termTabsEl, this.btnNewTab), this.taskEl, this.termHost);
      this.labEl = h('aside', { class: 'k-panel k-lab', id: 'k-panel-lab', 'aria-label': 'Lab' });
      this.bodyEl = h('div', { class: 'k-body' }, this.lessonEl, this.splitEl, this.workEl, this.labEl);
      this.toastEl = h('div', { class: 'k-toast', role: 'status', 'aria-live': 'polite', hidden: true });
      this.el = h('div', { class: 'k-app' }, top, this.bodyEl, this.toastEl);
      this.host.textContent = '';
      this.host.appendChild(this.el);
      this._applyLayout();
    }

    _applyLayout() {
      const s = this.state; const el = this.el;
      el.setAttribute('data-view', s.view);
      el.classList.toggle('is-lesson-closed', !s.lessonOpen);
      el.classList.toggle('is-lab-open', !!s.labOpen);
      el.style.setProperty('--k-side-w', s.sideWidth + 'px');
      for (const t of this.viewTabs) t.setAttribute('aria-selected', String(t.getAttribute('data-view') === s.view));
      this.btnLesson.setAttribute('aria-pressed', String(!!s.lessonOpen));
      this.btnLab.setAttribute('aria-pressed', String(!!s.labOpen));
      this.splitEl.setAttribute('aria-valuenow', String(s.sideWidth));
      this.splitEl.setAttribute('aria-valuemin', String(SIDE_MIN));
      this.splitEl.setAttribute('aria-valuemax', String(SIDE_MAX));
    }
    _saveState() { store.set('ui', this.state); }
    _saveSettings() { store.set('settings', this.settings); }

    /** Narrow screens show one of the three views at a time. */
    setView(view) {
      this.state.view = view;
      this._saveState(); this._applyLayout();
      if (view === 'terminal') this.focusTerminal();
    }
    togglePanel(key) {
      this.state[key] = !this.state[key];
      this._saveState(); this._applyLayout();
      this.focusTerminal();
    }
    _setSideWidth(px) {
      const room = this.bodyEl.clientWidth - WORK_MIN - (this.state.labOpen ? this.labEl.offsetWidth : 0);
      this.state.sideWidth = Math.round(Math.max(SIDE_MIN, Math.min(SIDE_MAX, room, px)));
      this._applyLayout();
    }

    /* --------------------------------------------------------------- wiring */
    _listen() {
      K.events.on('command', (ev) => this._onCommand(ev));
      K.events.on('power', (ev) => this._onPower(ev));
      K.net.bus.on('packet', (p) => { this._sawPacket(p); });
      K.net.bus.on('conn', (c) => { this._sawService(c.host, c.proto, c.port); });
      K.net.bus.on('http', (x) => { this._sawService(x.host, 'tcp', x.svc && x.svc.port); });

      this.lessonEl.addEventListener('click', (e) => this._lessonClick(e));
      this.lessonEl.addEventListener('submit', (e) => { e.preventDefault(); this._answer(); });
      this.lessonEl.addEventListener('input', (e) => { if (e.target.name === 'answer') this.stepUi.answer = e.target.value; });
      this.labEl.addEventListener('click', (e) => this._handBack(e));
      this.termTabsEl.addEventListener('click', (e) => this._tabClick(e));
      this._listenSplit();

      const relayout = () => { this._applyLayout(); if (this.wide.matches) this.focusTerminal(); };
      if (this.wide.addEventListener) this.wide.addEventListener('change', relayout); else this.wide.addListener(relayout);
      document.addEventListener('keydown', (e) => this._strayKey(e));
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this._saveHome(); });
      root.addEventListener('pagehide', () => this._saveHome());
      // Ctrl+W belongs to the browser and closes the page: ask first when that would interrupt an editor or a half-typed line
      root.addEventListener('beforeunload', (e) => { if (this.tabs.some((t) => t.term.busy)) e.preventDefault(); });
      this._followViewport();
    }

    _listenSplit() {
      const split = this.splitEl; let dragging = false;
      const stop = () => { if (!dragging) return; dragging = false; this.el.classList.remove('is-resizing'); this._saveState(); this.focusTerminal(); };
      split.addEventListener('pointerdown', (e) => {
        if (e.button) return;
        dragging = true; split.setPointerCapture(e.pointerId); this.el.classList.add('is-resizing'); e.preventDefault();
      });
      split.addEventListener('pointermove', (e) => { if (dragging) this._setSideWidth(e.clientX - this.bodyEl.getBoundingClientRect().left); });
      split.addEventListener('pointerup', stop);
      split.addEventListener('pointercancel', stop);
      split.addEventListener('dblclick', () => { this._setSideWidth(SIDE_DEFAULT); this._saveState(); });
      split.addEventListener('keydown', (e) => {
        const step = { ArrowLeft: -24, ArrowRight: 24, Home: -SIDE_MAX, End: SIDE_MAX }[e.key];
        if (!step) return;
        e.preventDefault(); this._setSideWidth(this.state.sideWidth + step); this._saveState();
      });
    }

    /** Keep the app inside the visible part of the window while a soft keyboard is open. */
    _followViewport() {
      const vv = root.visualViewport;
      if (!vv) return;
      const fit = () => {
        if (Math.abs(vv.scale - 1) > 0.01) return;      // pinch zoom also shrinks the visual viewport: leave the layout alone
        this.el.style.height = vv.height + 'px';
        this.el.style.transform = vv.offsetTop ? 'translateY(' + vv.offsetTop + 'px)' : '';
      };
      vv.addEventListener('resize', fit);
      vv.addEventListener('scroll', fit);
      fit();
    }

    _dialogOpen() { return !!document.querySelector('dialog[open]'); }
    _terminalShown() { return this.wide.matches || this.state.view === 'terminal'; }
    focusTerminal() { if (this.term && this._terminalShown() && !this._dialogOpen()) this.term.focus(); }

    /** A key pressed while nothing has focus belongs to the terminal. */
    _strayKey(e) {
      const a = document.activeElement;
      if (e.defaultPrevented || (a && a !== document.body) || !this.term || !this._terminalShown() || this._dialogOpen()) return;
      if (e.key === 'Tab' || e.metaKey) return;                                                      // Tab moves focus as usual
      if ((e.ctrlKey || e.key === 'Control') && String(root.getSelection && root.getSelection())) return;   // copying selected lesson text
      this.term.focus();
      this.term.keydown(e);
    }

    /** After a mouse click on a side panel, give the keyboard back to the terminal unless a text field took it. */
    _handBack(e) {
      const a = document.activeElement;
      if (e.detail === 0 || !this.wide.matches || (a && a.matches('input, textarea, select'))) return;
      if (String(root.getSelection && root.getSelection())) return;                                   // text was selected for copying
      this.focusTerminal();
    }

    toast(message) {
      clearTimeout(this._toastTimer);
      this.toastEl.textContent = message;
      this.toastEl.hidden = false;
      this._toastTimer = setTimeout(() => { this.toastEl.hidden = true; }, 4200);
    }

    /* ------------------------------------------------- simulator and terminals */
    /** Create the simulated machine and the first terminal session. */
    async _boot(home) {
      const tab = this._makeTab();
      const { shell } = await K.boot({ term: tab.term, home });
      tab.shell = shell;
      this.booted = true;
      this._activate(tab);
      this._session(tab);
    }

    /** Reboot the simulated machine and lab. `fresh` also forgets the home directory. */
    async restart(o) {
      o = o || {};
      if (this._restarting || !this.booted) return;
      this._restarting = true;
      const home = o.fresh ? null : this._saveHome();
      for (const tab of this.tabs) { tab.closed = true; tab.term.dispose(); tab.host.remove(); }
      this.tabs = []; this.active = null; this.term = null; this.booted = false;
      await this._boot(home);
      this._restarting = false;
      this.renderLesson(); this.renderLab();
      if (o.notice) this.toast(o.notice);
    }

    /** Forget lesson progress, the saved home directory and the lab map; preferences stay. */
    async erase() {
      K.lessons.progress.reset();
      this.found = {}; this.picks = {}; this.stepUi = {}; this.celebrating = null;
      this.state.lesson = null;
      store.clear();
      this._saveSettings(); this._saveState();
      await this.restart({ fresh: true, notice: 'Saved progress was erased. This is a fresh system.' });
    }

    /** reboot, poweroff and halt on the Kali machine all end the same way here: the simulator starts again. */
    _onPower(ev) {
      if (ev && ev.machine && ev.machine !== K.kali) return;      // a lab server going down is that server's business
      setTimeout(() => this.restart({ notice: 'The simulated machine restarted. Your files and progress were kept.' }), 300);
    }

    _saveHome() {
      const home = this.booted ? K.saveHome() : null;
      if (home) store.set('home', home);
      return home;
    }
    _saveHomeSoon() {
      clearTimeout(this._homeTimer);
      this._homeTimer = setTimeout(() => this._saveHome(), 400);
    }

    _makeTab() {
      const host = h('div', { class: 'k-term', role: 'tabpanel' });
      this.termHost.appendChild(host);
      const tab = { id: ++this.tabSeq, host, term: null, shell: null, closed: false, label: 'kali@kali: ~' };
      tab.term = new ui.Terminal(host, { fontSize: this.settings.fontSize, keybar: this.settings.keybar, onTitle: (title) => this._setLabel(tab, title) });
      this.tabs.push(tab);
      return tab;
    }
    _loginShell(term) { return new K.Shell({ machine: K.kali, term, user: 'kali', interactive: true, login: true }); }

    /** Run the tab's shell. When it exits the tab closes, or the last tab gets a fresh login shell. */
    async _session(tab) {
      for (;;) {
        let crashed = false;
        try { await tab.shell.repl(); } catch (e) { crashed = true; if (K.debug) console.error(e); }
        if (tab.closed) return;
        tab.shell.dispose();
        if (this.tabs.length > 1) { this.closeTab(tab); return; }
        if (crashed) await new Promise((resolve) => setTimeout(resolve, 300));     // never spin if a shell cannot start
        tab.term.write('\x1b[0;2m[Shell exited. A new login shell has started.]\x1b[0m\n');
        tab.shell = this._loginShell(tab.term);
        this._setLabel(tab, 'kali@kali: ~');
      }
    }

    newTab() {
      if (!this.booted || this.tabs.length >= MAX_TABS) return;
      const tab = this._makeTab();
      tab.shell = this._loginShell(tab.term);
      this._activate(tab);
      this._session(tab);
    }
    closeTab(tab) {
      const i = this.tabs.indexOf(tab);
      if (i < 0 || this.tabs.length === 1) return;
      tab.closed = true;
      tab.term.dispose(); tab.shell.dispose(); tab.host.remove();
      this.tabs.splice(i, 1);
      if (this.active === tab) this._activate(this.tabs[Math.min(i, this.tabs.length - 1)]); else this._renderTabs();
    }
    _activate(tab) {
      this.active = tab; this.term = tab.term;
      for (const t of this.tabs) t.host.hidden = t !== tab;
      this._renderTabs();
      tab.term.fit();
      this.focusTerminal();
    }
    _renderTabs() {
      const many = this.tabs.length > 1;
      this.termTabsEl.innerHTML = this.tabs.map((t, i) => {
        const on = t === this.active;
        return '<div class="k-termtab' + (on ? ' is-active' : '') + '">' +
          '<button type="button" class="k-termtab-btn" role="tab" aria-selected="' + on + '" data-tab="' + t.id + '">' +
          '<span class="k-termtab-n">' + (i + 1) + '</span><span class="k-termtab-label">' + esc(t.label) + '</span></button>' +
          (many ? '<button type="button" class="k-termtab-x" data-close="' + t.id + '" aria-label="Close terminal ' + (i + 1) + '" title="Close">' + icon('close') + '</button>' : '') +
          '</div>';
      }).join('');
      this.btnNewTab.disabled = this.tabs.length >= MAX_TABS;
      this.btnNewTab.title = this.btnNewTab.disabled ? 'At most ' + MAX_TABS + ' terminal tabs' : 'New terminal tab';
    }
    _tabClick(e) {
      const b = e.target.closest('button');
      if (!b) return;
      const tab = this.tabs.find((t) => String(t.id) === (b.getAttribute('data-tab') || b.getAttribute('data-close')));
      if (!tab) return;
      if (b.hasAttribute('data-close')) this.closeTab(tab); else this._activate(tab);
      this.focusTerminal();
    }
    /** Name a tab after where its shell is, as terminal emulators do: user@host: directory. */
    _labelTab(ev) {
      const tab = this.tabs.find((t) => ev.shell && t.term === ev.shell.term);
      if (!tab) return;
      const home = ev.shell.user && ev.shell.user.home;
      const cwd = home && ev.cwd === home ? '~' : home && ev.cwd.indexOf(home + '/') === 0 ? '~' + ev.cwd.slice(home.length) : ev.cwd;
      this._setLabel(tab, ev.user + '@' + ev.host + ': ' + cwd);
    }
    _setLabel(tab, label) { if (label !== tab.label) { tab.label = label; this._renderTabs(); } }

    _onCommand(ev) {
      this._saveHomeSoon();
      this._labelTab(ev);
      const entry = this._entry();
      const step = entry && this._currentStep(entry.lesson);
      if (step && this._kind(step) === 'command' && K.lessons.check(step.check, ev)) this._stepDone(entry.lesson, step);
    }

    /* ---------------------------------------------------------------- lessons */
    _entry() { return this.state.lesson ? K.lessons.get(this.state.lesson) : null; }
    _kind(step) { return step.info ? 'info' : step.answer != null ? 'question' : 'command'; }
    _currentIndex(lesson) {
      const done = K.lessons.progress.of(lesson.id).steps;
      const i = lesson.steps.findIndex((s) => !done[s.id]);
      return i < 0 ? lesson.steps.length : i;
    }
    _currentStep(lesson) { return lesson.steps[this._currentIndex(lesson)] || null; }
    _quizLeft(lesson) {
      const answered = K.lessons.progress.of(lesson.id).quiz;
      return (lesson.quiz || []).filter((q, i) => answered[i] == null).length;
    }
    _nextLesson(id) {
      const all = K.lessons.all();
      return all[all.findIndex((x) => x.lesson.id === id) + 1] || null;
    }

    openLesson(id) {
      this.state.lesson = id; this.stepUi = {}; this.celebrating = null;
      this._saveState();
      this.renderLesson();
      this.lessonBody.scrollTop = 0;
      this._showCurrent();
    }
    openBrowser() {
      this.state.lesson = null; this.stepUi = {}; this.celebrating = null;
      if (!this.state.lessonOpen) this.state.lessonOpen = true;
      this.state.view = 'lesson';
      this._saveState(); this._applyLayout();
      this.renderLesson();
      this.lessonBody.scrollTop = 0;
    }

    _stepDone(lesson, step) {
      if (!K.lessons.progress.stepDone(lesson.id, step.id)) return;
      this.stepUi = {};
      this.celebrating = step.id;
      clearTimeout(this._celebrateTimer);
      this._celebrateTimer = setTimeout(() => { this.celebrating = null; this.renderLesson(); this._showCurrent(); }, CELEBRATE_MS);
      this._finishIfDone(lesson);
      this.renderLesson();
      if (this.wide.matches && !this.state.lessonOpen) this.toast('Step complete. The lesson panel has the next one.');
    }
    _finishIfDone(lesson) {
      if (this._currentIndex(lesson) >= lesson.steps.length && !this._quizLeft(lesson)) K.lessons.progress.complete(lesson.id);
    }

    /** Scroll the lesson to whatever needs attention next: the open step, the quiz or the end. */
    _showCurrent() {
      const target = this.lessonBody.querySelector('.k-step.is-current, .k-q:not(.is-answered), .k-complete');
      if (!target) return;
      const box = this.lessonBody; const top = target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      if (top < box.scrollTop + 8 || top + target.offsetHeight > box.scrollTop + box.clientHeight - 8) {
        box.scrollTo({ top: Math.max(0, top - 16), behavior: root.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
    }

    _lessonClick(e) {
      const b = e.target.closest('[data-act]');
      if (b) this._lessonAct(b.getAttribute('data-act'), b);
      this._handBack(e);
    }
    _lessonAct(act, b) {
      const entry = this._entry(); const lesson = entry && entry.lesson;
      const step = lesson && this._currentStep(lesson);
      switch (act) {
        case 'open': this.openLesson(b.getAttribute('data-id')); break;
        case 'back': this.openBrowser(); break;
        case 'hint': this.stepUi.hint = true; this.renderLesson(); break;
        case 'solution': this.stepUi.solution = true; this.renderLesson(); break;
        case 'continue': if (step && this._kind(step) === 'info') this._stepDone(lesson, step); break;
        case 'terminal': this.setView('terminal'); break;
        case 'insert':
          if (step && step.solution && this.term) { this.term.insert(step.solution); this.setView('terminal'); this.focusTerminal(); }
          break;
        case 'choice': if (lesson) this._choose(lesson, +b.getAttribute('data-q'), +b.getAttribute('data-c')); break;
        case 'restart':
          if (!lesson) break;
          K.lessons.progress.reset(lesson.id);
          delete this.picks[lesson.id];
          this.openLesson(lesson.id);
          break;
        default: break;
      }
    }
    /** Check the text typed for a question step. */
    _answer() {
      const entry = this._entry(); const step = entry && this._currentStep(entry.lesson);
      if (!step || this._kind(step) !== 'question') return;
      const text = (this.stepUi.answer || '').trim();
      if (!text) return;
      if (K.lessons.checkAnswer(step, text)) { this._stepDone(entry.lesson, step); this.focusTerminal(); return; }
      this.stepUi.wrong = (this.stepUi.wrong || 0) + 1;
      this.renderLesson();
      const field = this.lessonBody.querySelector('input[name="answer"]');
      if (field) { field.focus(); field.select(); }
    }
    _choose(lesson, q, choice) {
      const item = (lesson.quiz || [])[q];
      if (!item || K.lessons.progress.of(lesson.id).quiz[q] != null) return;
      (this.picks[lesson.id] = this.picks[lesson.id] || {})[q] = choice;
      K.lessons.progress.quizAnswered(lesson.id, q, choice === item.answer);
      this._finishIfDone(lesson);
      this.renderLesson();
      if (!this._quizLeft(lesson)) this._showCurrent();
    }

    renderLesson() {
      const entry = this._entry();
      const field = this.lessonBody.querySelector('input[name="answer"]');
      const typing = !!field && document.activeElement === field;
      if (entry) { this.lessonHead.innerHTML = this._lessonHeadHtml(entry.lesson); this.lessonBody.innerHTML = this._lessonHtml(entry); }
      else { this.lessonHead.innerHTML = this._browserHeadHtml(); this.lessonBody.innerHTML = this._browserHtml(); }
      const again = this.lessonBody.querySelector('input[name="answer"]');
      if (again) { again.value = this.stepUi.answer || ''; if (typing) again.focus(); }
      this._renderProgress();
      this._renderTask();
    }

    _renderProgress() {
      const sum = K.lessons.progress.summary();
      this.progressEl.hidden = !sum.total;
      this.progressEl.innerHTML = '<span class="k-top-progress-text">' + sum.done + ' of ' + plural(sum.total, 'lesson') + '</span>' + this._barHtml(sum.done, sum.total);
      this.progressEl.setAttribute('aria-label', sum.done + ' of ' + plural(sum.total, 'lesson') + ' complete. Show all lessons.');
    }
    _barHtml(done, total) {
      return '<span class="k-bar" aria-hidden="true"><span style="width:' + (total ? Math.round(done * 100 / total) : 0) + '%"></span></span>';
    }

    /** The strip above the terminal on narrow screens: what the lesson is asking for right now. */
    _renderTask() {
      const entry = this._entry(); const el = this.taskEl;
      el.hidden = !entry;
      if (!entry) return;
      const lesson = entry.lesson; const i = this._currentIndex(lesson); const step = lesson.steps[i];
      let label; let body;
      if (this.celebrating) { label = 'Done'; body = 'Step complete'; }
      else if (step) { label = 'Step ' + (i + 1) + '/' + lesson.steps.length; body = this._kind(step) === 'command' ? mdText(step.prompt) : 'Continue in the Lesson view'; }
      else if (this._quizLeft(lesson)) { label = 'Quiz'; body = 'Answer the questions in the Lesson view'; }
      else { label = 'Done'; body = 'Lesson complete'; }
      el.classList.toggle('is-ok', label === 'Done');
      el.innerHTML = '<span class="k-task-label">' + esc(label) + '</span><span class="k-task-text">' + esc(body) + '</span>';
    }

    _browserHeadHtml() {
      const sum = K.lessons.progress.summary();
      return '<div class="k-head-row"><h2>Lessons</h2>' + (sum.total ? '<span class="k-head-note">' + sum.done + ' of ' + sum.total + ' complete</span>' : '') + '</div>' +
        (sum.total ? this._barHtml(sum.done, sum.total) : '');
    }
    _browserHtml() {
      const P = K.lessons.progress; const mods = K.lessons.modules.filter((m) => m.lessons.length);
      if (!mods.length) {
        return '<div class="k-empty"><h3>No lessons are installed</h3>' +
          '<p>This copy of Kalima has no lesson packs. The terminal and the lab network still work: explore them freely, and read <code>~/engagement</code> for the scope of the exercise.</p></div>';
      }
      const next = K.lessons.all().find((x) => !P.isDone(x.lesson.id));
      const started = P.summary().done > 0 || K.lessons.all().some((x) => Object.keys(P.of(x.lesson.id).steps).length);
      let html = next
        ? '<button type="button" class="k-resume" data-act="open" data-id="' + esc(next.lesson.id) + '"><span class="k-resume-label">' + (started ? 'Continue' : 'Start here') + '</span>' +
          '<span class="k-resume-title">' + esc(next.lesson.title) + '</span><span class="k-resume-note">' + esc(next.module.title) + '</span></button>'
        : '<div class="k-alldone"><strong>Every lesson is complete.</strong> Open any lesson to repeat it.</div>';
      for (const m of mods) {
        const done = m.lessons.filter((l) => P.isDone(l.id)).length;
        html += '<section class="k-mod"><div class="k-mod-head"><h3>' + esc(m.title || m.id) + '</h3><span class="k-mod-count">' + done + '/' + m.lessons.length + '</span></div>' +
          (m.summary ? '<p class="k-mod-sum">' + esc(m.summary) + '</p>' : '') + '<ol class="k-lessons">' +
          m.lessons.map((l) => {
            const p = P.of(l.id); const state = p.done ? 'done' : Object.keys(p.steps).length ? 'started' : 'new';
            const word = { done: 'Completed', started: 'In progress', new: 'Not started' }[state];
            return '<li><button type="button" class="k-lesson-row is-' + state + '" data-act="open" data-id="' + esc(l.id) + '">' +
              '<span class="k-dot" aria-hidden="true">' + (p.done ? icon('check') : '') + '</span>' +
              '<span class="k-lesson-name">' + esc(l.title) + '</span>' +
              '<span class="k-lesson-meta">' + (l.minutes ? l.minutes + ' min' : '') + '</span>' +
              '<span class="k-sr">' + word + '</span></button></li>';
          }).join('') + '</ol></section>';
      }
      return html;
    }

    _lessonHeadHtml(lesson) {
      const n = lesson.steps.length; const i = Math.min(this._currentIndex(lesson), n);
      const where = K.lessons.progress.isDone(lesson.id) ? 'Complete' : i >= n ? 'Quiz' : 'Step ' + (i + 1) + ' of ' + n;
      return '<div class="k-head-row"><button type="button" class="k-btn is-quiet k-back" data-act="back">' + icon('back') + 'All lessons</button>' +
        '<span class="k-head-note">' + where + '</span></div>' + this._barHtml(i, n);
    }
    _lessonHtml(entry) {
      const lesson = entry.lesson; const cur = this._currentIndex(lesson);
      const meta = [lesson.minutes ? lesson.minutes + ' min' : '', plural(lesson.steps.length, 'step'), (lesson.quiz || []).length ? 'quiz' : ''].filter(Boolean).join(' · ');
      let html = '<article class="k-doc"><p class="k-eyebrow">' + esc(entry.module.title || entry.module.id) + '</p><h2>' + esc(lesson.title) + '</h2><p class="k-meta">' + meta + '</p>';
      if ((lesson.objectives || []).length) {
        html += '<section class="k-objectives"><h3>In this lesson</h3><ul>' + lesson.objectives.map((o) => '<li>' + mdInline(esc(o)) + '</li>').join('') + '</ul></section>';
      }
      if (lesson.intro) html += '<div class="k-md">' + ui.md(lesson.intro) + '</div>';
      html += '<ol class="k-steps">' + lesson.steps.map((s, i) => this._stepHtml(s, i, cur)).join('') + '</ol>';
      if (cur >= lesson.steps.length && !this.celebrating) html += this._quizHtml(lesson) + this._completeHtml(lesson);
      if ((lesson.refs || []).length) html += '<section class="k-refs"><h3>References</h3><ul>' + lesson.refs.map((r) => '<li>' + mdInline(esc(r)) + '</li>').join('') + '</ul></section>';
      if (cur > 0) html += '<p class="k-doc-foot"><button type="button" class="k-btn is-quiet" data-act="restart">Restart this lesson</button></p>';
      return html + '</article>';
    }
    _stepHtml(step, i, cur) {
      const fresh = this.celebrating === step.id;
      const state = fresh ? 'is-done is-fresh' : i < cur ? 'is-done' : i === cur && !this.celebrating ? 'is-current' : 'is-todo';
      const done = state.indexOf('is-done') === 0;
      return '<li class="k-step ' + state + '"' + (state === 'is-current' ? ' aria-current="step"' : '') + '>' +
        '<span class="k-step-n" aria-hidden="true">' + (done ? icon('check') : i + 1) + '</span>' +
        '<div class="k-step-main"><div class="k-md">' + ui.md(step.prompt) + '</div>' +
        (fresh ? '<p class="k-step-ok" role="status">Step complete</p>' : '') +
        (state === 'is-current' ? this._stepActionsHtml(step) : '') +
        (done ? '<span class="k-sr">Completed</span>' : '') + '</div></li>';
    }
    _stepActionsHtml(step) {
      const kind = this._kind(step); const u = this.stepUi;
      let html = '';
      if (kind === 'info') html += '<div class="k-step-row"><button type="button" class="k-btn is-primary" data-act="continue">Continue</button></div>';
      else if (kind === 'question') {
        html += '<form class="k-answer" novalidate><label class="k-sr" for="k-answer">Your answer</label>' +
          '<input id="k-answer" class="k-input" name="answer" type="text" placeholder="Your answer" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">' +
          '<button type="submit" class="k-btn is-primary">Check</button></form>' +
          (u.wrong ? '<p class="k-step-no" role="status">Not quite. Look at the output again' + (step.hint && !u.hint ? ', or open the hint.' : '.') + '</p>' : '');
      } else html += '<p class="k-step-how">' + icon('terminal') + '<span>Run it in the terminal. This step completes on its own.</span>' +
        '<button type="button" class="k-btn k-narrow-only" data-act="terminal">Open terminal</button></p>';
      const solution = this._solutionOf(step);
      if (step.hint && !u.hint) html += '<div class="k-step-row"><button type="button" class="k-btn is-quiet" data-act="hint">Hint</button></div>';
      if (step.hint && u.hint) html += '<div class="k-hint"><span class="k-hint-label">Hint</span><div class="k-md">' + ui.md(step.hint) + '</div></div>';
      if (solution != null && (u.hint || !step.hint)) {
        html += u.solution
          ? '<div class="k-hint is-solution"><span class="k-hint-label">Solution</span><pre><code>' + esc(solution) + '</code></pre>' +
            (kind === 'command' ? '<button type="button" class="k-btn" data-act="insert">Put it on the command line</button>' : '') + '</div>'
          : '<div class="k-step-row"><button type="button" class="k-btn is-quiet" data-act="solution">Show solution</button></div>';
      }
      return html;
    }
    /** What "Show solution" reveals: the command, or an accepted answer when one can be shown. */
    _solutionOf(step) {
      if (step.solution != null) return String(step.solution);
      const a = step.answer;
      if (typeof a === 'string' || typeof a === 'number') return String(a);
      return Array.isArray(a) && a.length ? String(a[0]) : null;
    }
    _quizHtml(lesson) {
      const quiz = lesson.quiz || [];
      if (!quiz.length) return '';
      const answered = K.lessons.progress.of(lesson.id).quiz; const picks = this.picks[lesson.id] || {};
      return '<section class="k-quiz"><h3>Check your understanding</h3><ol>' + quiz.map((item, q) => {
        const result = answered[q];
        const choices = item.choices.map((c, i) => {
          const cls = result == null ? '' : i === item.answer ? ' is-right' : picks[q] === i ? ' is-wrong' : '';
          return '<li><button type="button" class="k-choice' + cls + '" data-act="choice" data-q="' + q + '" data-c="' + i + '"' + (result == null ? '' : ' disabled') + '>' +
            '<span class="k-choice-key" aria-hidden="true">' + String.fromCharCode(65 + i) + '</span><span>' + mdInline(esc(c)) + '</span></button></li>';
        }).join('');
        const why = result == null ? '' : '<div class="k-why ' + (result ? 'is-right' : 'is-wrong') + '" role="status"><strong>' + (result ? 'Correct.' : 'Not quite.') + '</strong> ' +
          (result ? '' : 'The answer is ' + String.fromCharCode(65 + item.answer) + '. ') + mdInline(esc(item.why || '')) + '</div>';
        return '<li class="k-q' + (result == null ? '' : ' is-answered') + '"><p class="k-q-text">' + mdInline(esc(item.q)) + '</p><ul class="k-choices">' + choices + '</ul>' + why + '</li>';
      }).join('') + '</ol></section>';
    }
    _completeHtml(lesson) {
      if (!K.lessons.progress.isDone(lesson.id)) return '';
      const quiz = lesson.quiz || []; const answered = K.lessons.progress.of(lesson.id).quiz;
      const right = quiz.filter((q, i) => answered[i]).length;
      const next = this._nextLesson(lesson.id);
      return '<section class="k-complete"><h3>' + icon('check') + 'Lesson complete</h3>' +
        (quiz.length ? '<p>Quiz: ' + right + ' of ' + quiz.length + ' correct.</p>' : '') +
        (next ? '<button type="button" class="k-btn is-primary" data-act="open" data-id="' + esc(next.lesson.id) + '">Next: ' + esc(next.lesson.title) + '</button>'
          : '<button type="button" class="k-btn is-primary" data-act="back">Back to all lessons</button>') + '</section>';
    }

    /* -------------------------------------------------------------------- lab */
    _labHost(ip) {
      const host = K.net.knownHost(ip);
      return host && !host.inet && host.id !== 'kali' ? host : null;
    }
    /** A reply from a lab host proves it is up; a SYN-ACK also proves the port is open. */
    _sawPacket(p) {
      const host = this._labHost(p.src);
      if (!host) return;
      this._found(host, p.proto === 'TCP' && p.flags === 'S.' ? 'tcp/' + p.sport : null);
    }
    _sawService(host, proto, port) {
      if (host && this._labHost(host.ip) && port) this._found(host, proto + '/' + port);
    }
    _found(host, portKey) {
      const rec = this.found[host.ip] || (this.found[host.ip] = { ports: {} });
      if (rec.up && (!portKey || rec.ports[portKey])) return;
      rec.up = true;
      if (portKey) rec.ports[portKey] = true;
      if (this._labFrame) return;
      // a scan produces thousands of packets: repaint and save once per frame at most
      this._labFrame = requestAnimationFrame(() => { this._labFrame = 0; store.set('lab', this.found); this._renderHosts(); });
    }

    /** Kali's interface on the lab network. */
    _iface() { return K.kali.ifaces.find((i) => i.kind !== 'loopback') || K.kali.ifaces[0]; }

    renderLab() {
      const e = K.net.world.engagement;
      const scope = e.scope.concat((e.domains || []).map((d) => '*.' + d));
      const row = (k, v) => '<div class="k-kv"><dt>' + k + '</dt><dd>' + v + '</dd></div>';
      const code = (s) => '<code>' + esc(s) + '</code>';
      this.labEl.innerHTML = '<div class="k-panel-head"><div class="k-head-row"><h2>Lab</h2><span class="k-head-note">Simulated network</span></div></div>' +
        '<div class="k-panel-body k-scroll">' +
        '<section class="k-card"><p class="k-eyebrow">Engagement ' + esc(e.id) + '</p><h3>' + esc(e.name) + '</h3><dl>' +
        row('Client', esc(e.client)) + row('In scope', scope.map(code).join(' ')) +
        ((e.exclude || []).length ? row('Excluded', e.exclude.map(code).join(' ')) : '') +
        row('Window', esc(e.window)) + row('Contact', esc(e.contact)) + '</dl>' +
        '<p class="k-note">Stay inside the scope. Active tools in this simulator refuse other targets, as a professional would.</p></section>' +
        '<section class="k-hosts"></section></div>';
      this._renderHosts();
    }
    _renderHosts() {
      const box = this.labEl.querySelector('.k-hosts');
      if (!box) return;
      const ipKey = (ip) => ip.split('.').map((n) => ('00' + n).slice(-3)).join('.');
      const ips = Object.keys(this.found).filter((ip) => this._labHost(ip)).sort((a, b) => (ipKey(a) < ipKey(b) ? -1 : 1));
      const iface = this._iface(); const lan = K.net.world.nets[0];
      const facts = [iface.name, 'gateway ' + lan.gateway].concat(K.kali.dns.map((ip) => 'dns ' + ip));
      box.innerHTML = '<div class="k-hosts-head"><h3>Network map</h3><span class="k-head-note">' + plural(ips.length, 'host') + ' found</span></div>' +
        '<ol class="k-map"><li class="k-node is-self"><span class="k-node-dot" aria-hidden="true"></span><div><span class="k-node-ip">' + esc(iface.ip + '/' + iface.bits) +
        '</span><span class="k-node-name">kali (you)</span><ul class="k-ports">' + facts.map((f) => '<li>' + esc(f) + '</li>').join('') + '</ul></div></li>' +
        ips.map((ip) => this._hostHtml(ip)).join('') + '</ol>' +
        (ips.length ? '' : '<p class="k-note">No other hosts yet. They appear here when they answer something you send: a ping, a scan, a web request.</p>');
    }
    _hostHtml(ip) {
      const host = this._labHost(ip); const svcs = K.net.servicesOf(host);
      const ports = Object.keys(this.found[ip].ports).map((key) => {
        const proto = key.split('/')[0]; const port = +key.split('/')[1];
        const svc = svcs.find((s) => s.port === port && (s.proto || 'tcp') === proto);
        return { port, proto, name: svc ? svc.name : '' };
      }).sort((a, b) => a.port - b.port);
      return '<li class="k-node"><span class="k-node-dot" aria-hidden="true"></span><div><span class="k-node-ip">' + esc(ip) + '</span>' +
        '<span class="k-node-name">' + esc(host.fqdn || host.hostname || '') + '</span>' +
        (ports.length ? '<ul class="k-ports">' + ports.map((p) => '<li>' + p.port + (p.proto === 'udp' ? '/udp' : '') + (p.name ? ' <span>' + esc(p.name) + '</span>' : '') + '</li>').join('') + '</ul>' : '') +
        '</div></li>';
    }

    /* ---------------------------------------------------------------- dialogs */
    _dialog(title, body, foot) {
      const dlg = h('dialog', { class: 'k-dialog', 'aria-labelledby': 'k-dialog-title' },
        h('div', { class: 'k-dialog-head' }, h('h2', { id: 'k-dialog-title' }, title),
          h('button', { type: 'button', class: 'k-icon-btn', 'aria-label': 'Close', html: icon('close'), onclick: () => dlg.close() })),
        h('div', { class: 'k-dialog-body k-scroll' }, body), foot);
      dlg.addEventListener('close', () => { dlg.remove(); this.focusTerminal(); });
      dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });      // a click on the backdrop
      this.el.appendChild(dlg);
      dlg.showModal();
      return dlg;
    }

    showWelcome() {
      const body = h('div', { class: 'k-welcome', html:
        '<p>Kalima is a place to practise Kali Linux 2026.3: a terminal, a small company network to explore and guided lessons, all inside this one file.</p>' +
        '<ul><li><strong>Everything is simulated and offline.</strong> The machines, addresses, people and data are invented. Nothing you type leaves this page or touches a real network.</li>' +
        '<li><strong>Nothing can break.</strong> Experiment freely. You can restart the simulator or erase saved progress from Settings.</li>' +
        '<li><strong>In real work, authorization comes first.</strong> These tools may only be used on systems you own or have written permission to test. The lab has a scope for the same reason.</li></ul>' });
      const start = h('button', { type: 'button', class: 'k-btn is-primary', onclick: () => dlg.close() }, 'Start');
      const dlg = this._dialog('Welcome to Kalima', body, h('div', { class: 'k-dialog-foot' }, start));
      dlg.addEventListener('close', () => { this.settings.welcomed = true; this._saveSettings(); });
      start.focus();
    }

    showSettings() {
      if (this._dialogOpen()) return;
      const choice = (legend, name, options, current, onPick) => {
        const note = h('p', { class: 'k-field-note' });
        const describe = (value) => { const o = options.find((x) => x.value === value); note.textContent = (o && o.note) || ''; note.hidden = !note.textContent; };
        const box = h('div', { class: 'k-seg' });
        for (const o of options) {
          const input = h('input', { type: 'radio', name, value: String(o.value), checked: o.value === current, onchange: () => { describe(o.value); onPick(o.value); } });
          box.appendChild(h('label', null, input, h('span', null, o.label)));
        }
        describe(current);
        return h('fieldset', { class: 'k-field' }, h('legend', null, legend), box, note);
      };
      const sizeOut = h('output', { class: 'k-size-value' }, this.settings.fontSize + ' px');
      const resize = (d) => { this.setFontSize(this.settings.fontSize + d); sizeOut.textContent = this.settings.fontSize + ' px'; };
      const confirm = h('div', { class: 'k-confirm', hidden: true },
        h('p', null, 'Erase lesson progress, the files in your simulated home directory and the lab map from this browser?'),
        h('div', { class: 'k-confirm-row' },
          h('button', { type: 'button', class: 'k-btn is-danger', onclick: () => { dlg.close(); this.erase(); } }, 'Erase'),
          h('button', { type: 'button', class: 'k-btn', onclick: () => { confirm.hidden = true; eraseBtn.hidden = false; eraseBtn.focus(); } }, 'Cancel')));
      const eraseBtn = h('button', { type: 'button', class: 'k-btn is-danger', onclick: () => { confirm.hidden = false; eraseBtn.hidden = true; confirm.querySelector('button').focus(); } }, 'Erase saved progress');
      const body = h('div', { class: 'k-settings' },
        choice('Simulated time', 'k-speed', SPEEDS, this.settings.timeScale, (v) => this.setTimeScale(v)),
        h('fieldset', { class: 'k-field' }, h('legend', null, 'Terminal font size'),
          h('div', { class: 'k-size' },
            h('button', { type: 'button', class: 'k-btn', 'aria-label': 'Smaller text', onclick: () => resize(-1) }, 'A−'), sizeOut,
            h('button', { type: 'button', class: 'k-btn', 'aria-label': 'Larger text', onclick: () => resize(1) }, 'A+'))),
        choice('On-screen terminal keys', 'k-keybar', KEYBARS, this.settings.keybar, (v) => this.setKeybar(v)),
        document.documentElement.requestFullscreen && h('fieldset', { class: 'k-field' }, h('legend', null, 'Browser shortcuts'),
          h('button', { type: 'button', class: 'k-btn', onclick: () => { dlg.close(); this.toggleFullscreen(); } }, document.fullscreenElement ? 'Leave full screen' : 'Full screen'),
          h('p', { class: 'k-field-note' }, 'The browser keeps a few keys for itself: Ctrl+W closes this page before the terminal sees it. In full screen, Chromium browsers pass these keys to the terminal. Hold Esc to leave full screen.')),
        h('fieldset', { class: 'k-field' }, h('legend', null, 'Simulator'),
          h('div', { class: 'k-action' }, h('button', { type: 'button', class: 'k-btn', onclick: () => { dlg.close(); this.restart({ notice: 'The simulator restarted. Your files and progress were kept.' }); } }, 'Restart simulator'),
            h('p', { class: 'k-field-note' }, 'Reboots the simulated Kali machine and the lab network. Files and lesson progress are kept.')),
          h('div', { class: 'k-action' }, eraseBtn, confirm,
            h('p', { class: 'k-field-note' }, 'Everything Kalima remembers is stored in this browser only.'))),
        h('p', { class: 'k-about' }, 'Kalima ' + K.version + ', a simulator of ' + K.distro.name + ' ' + K.distro.release +
          '. Everything is simulated and offline. In real work, use these tools only on systems you are authorized to test.'));
      const dlg = this._dialog('Settings', body);
    }

    /** In full screen, Chromium browsers let the page have Ctrl+W, Ctrl+T, Ctrl+N and Esc, which otherwise act on the browser. */
    async toggleFullscreen() {
      try {
        if (document.fullscreenElement) { await document.exitFullscreen(); return; }
        await document.documentElement.requestFullscreen();
        if (navigator.keyboard && navigator.keyboard.lock) await navigator.keyboard.lock(['KeyW', 'KeyT', 'KeyN', 'Escape']);
      } catch (e) { this.toast('Full screen is not available here.'); }
    }

    setTimeScale(value) { this.settings.timeScale = K.settings.timeScale = value; this._saveSettings(); }
    setFontSize(px) {
      this.settings.fontSize = Math.max(10, Math.min(24, px));
      for (const t of this.tabs) t.term.setFontSize(this.settings.fontSize);
      this._saveSettings();
    }
    setKeybar(mode) {
      this.settings.keybar = mode;
      for (const t of this.tabs) t.term.setKeybar(mode);
      this._saveSettings();
    }
  }

  /** Starting failed (a broken pack, most likely): say so instead of leaving an empty page. */
  function fatal(host, error) {
    console.error(error);
    host.textContent = '';
    host.appendChild(h('div', { class: 'k-fatal', role: 'alert' },
      h('h1', null, 'Kalima could not start'),
      h('p', null, 'The simulator stopped while starting up. Reloading the page may help; nothing was sent anywhere.'),
      h('pre', null, String((error && error.stack) || error))));
  }

  function start() {
    const host = document.getElementById('app');
    const app = (K.app = new App(host));
    app.start().catch((error) => fatal(host, error));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})(typeof globalThis !== 'undefined' ? globalThis : this);
