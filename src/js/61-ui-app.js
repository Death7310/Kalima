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
  const ui = K.ui; const h = ui.h;

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

  /* ---------------------------------------------------------------------- app */
  class App {
    constructor(host) {
      this.host = host;
      this.settings = Object.assign({ fontSize: 14 }, store.get('settings', {}));
      this.tabs = [];
      this.booted = false;
    }

    async start() {
      this.termHost = h('div', { class: 'k-term-stack' });
      this.host.appendChild(h('div', { class: 'k-app' }, h('main', { class: 'k-work' }, this.termHost)));
      await this._boot();
    }

    /** Create the simulated machine and the first terminal session. */
    async _boot() {
      const term = new ui.Terminal(this.termHost, { fontSize: this.settings.fontSize });
      const { shell } = await K.boot({ term, home: store.get('home', null) });
      const tab = { term, shell, closed: false };
      this.tabs = [tab];
      this.term = term;
      this.booted = true;
      term.focus();
      this._session(tab);
    }

    /** Run the tab's shell until it exits, then give the tab a fresh login shell. */
    async _session(tab) {
      for (;;) {
        try { await tab.shell.repl(); } catch (e) { if (K.debug) console.error(e); }
        if (tab.closed) return;
        tab.shell.dispose();
        tab.term.write('\x1b[0;2m[Shell exited. A new login shell has started.]\x1b[0m\n');
        tab.shell = new K.Shell({ machine: K.kali, term: tab.term, user: 'kali', interactive: true, login: true });
      }
    }
  }

  function start() {
    const app = (K.app = new App(document.getElementById('app')));
    app.start();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})(typeof globalThis !== 'undefined' ? globalThis : this);
