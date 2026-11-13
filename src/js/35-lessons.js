/* Kalima — lesson engine: registry, declarative checks, progress.
 *
 * A module groups lessons; a lesson is a sequence of steps. Step kinds:
 *   command step   { id, prompt, hint, solution, check }      satisfied by something typed in the terminal
 *   question step  { id, prompt, hint, answer }               satisfied by an answer typed into the lesson panel
 *   info step      { id, prompt, info: true }                 read and continue
 *
 * K.lessons.register({
 *   id: 'net', title: 'Networking fundamentals', order: 70, summary: '...',
 *   lessons: [{
 *     id: 'net-ping', title: 'Reachability with ping', minutes: 10,
 *     objectives: ['...'],
 *     intro: 'markdown-lite text',
 *     steps: [ { id: 's1', prompt: '...', hint: '...', solution: 'ping -c 4 10.10.10.1',
 *                check: { cmd: 'ping', args: ['-c'], out: /bytes from/ } } ],
 *     quiz: [ { q: '...', choices: ['a', 'b', 'c'], answer: 1, why: '...' } ],
 *     refs: ['ping(8)', 'RFC 792'],
 *   }]
 * })
 *
 * Check spec (all given conditions must hold):
 *   cmd:    'ping' | ['ping', 'ping4']   a command with this name ran during the line
 *   args:   ['-c', '4']                  every item appears in that command's arguments
 *   argsRe: /regex/                      tested against that command's arguments joined by spaces
 *   line:   /regex/                      tested against the raw line the learner typed
 *   out:    /regex/                      tested against everything the line printed (ANSI stripped)
 *   exit:   0                            exit status of the whole line
 *   cwd:    '/path' | /regex/            working directory after the line ran
 *   user:   'root'                       user who ran it
 *   host:   'web01'                      hostname of the machine the shell is on
 *   file:   { path, exists, contains: /re/, mode: '600', type: 'file'|'dir' }   state on the Kali box after the line
 *   env:    { NAME: /re/ }               shell variable after the line
 *   any:    [check, ...]   all: [check, ...]   not: check
 *   fn:     (event, K) => boolean        escape hatch
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const L = (K.lessons = {
    modules: [],

    register(mod) {
      if (!mod || !mod.id || !Array.isArray(mod.lessons)) throw new Error('K.lessons.register: id and lessons[] required');
      const i = this.modules.findIndex((m) => m.id === mod.id);
      if (i >= 0) this.modules.splice(i, 1);
      this.modules.push(mod);
      this.modules.sort((a, b) => (a.order || 0) - (b.order || 0));
      return mod;
    },

    /** Flat list of { module, lesson } in curriculum order. */
    all() {
      const out = [];
      for (const m of this.modules) for (const l of m.lessons) out.push({ module: m, lesson: l });
      return out;
    },
    get(id) { return this.all().find((x) => x.lesson.id === id) || null; },

    /** Evaluate a declarative check against a 'command' event. */
    check(spec, ev) {
      if (!spec) return false;
      if (typeof spec === 'function') { try { return !!spec(ev, K); } catch (e) { return false; } }
      if (spec.any) return spec.any.some((s) => L.check(s, ev));
      if (spec.all && !spec.all.every((s) => L.check(s, ev))) return false;
      if (spec.not && L.check(spec.not, ev)) return false;
      const re = (r, s) => { if (typeof r === 'string') return String(s).indexOf(r) >= 0; r.lastIndex = 0; return r.test(String(s)); };
      const base = (n) => String(n || '').split('/').pop();
      if (spec.cmd != null || spec.args || spec.argsRe) {
        const names = spec.cmd == null ? null : Array.isArray(spec.cmd) ? spec.cmd : [spec.cmd];
        const hit = (ev.commands || []).some((c) => {
          let argv = c.argv;
          // look through wrappers so `sudo nmap ...` still counts as nmap
          while (argv.length > 1 && /^(sudo|time|command|nohup|exec)$/.test(base(argv[0]))) {
            argv = argv.slice(1);
            while (argv.length > 1 && /^-/.test(argv[0]) && base(c.argv[0]) === 'sudo') argv = argv.slice(argv[0] === '-u' ? 2 : 1);
          }
          const variants = argv === c.argv ? [argv] : [argv, c.argv];
          return variants.some((a) => {
            if (names && names.indexOf(base(a[0])) < 0) return false;
            const rest = a.slice(1);
            if (spec.args && !spec.args.every((x) => rest.indexOf(x) >= 0 || rest.some((r) => r.indexOf(x) === 0 && /^-[a-zA-Z]$/.test(x) && r[0] === '-' && r[1] !== '-'))) return false;
            if (spec.argsRe && !re(spec.argsRe, rest.join(' '))) return false;
            return true;
          });
        });
        if (!hit) return false;
      }
      if (spec.line && !re(spec.line, ev.line)) return false;
      if (spec.out && !re(spec.out, K.util.stripAnsi(ev.output || ''))) return false;
      if (spec.exit != null && ev.code !== spec.exit) return false;
      if (spec.cwd != null && !(typeof spec.cwd === 'string' ? ev.cwd === spec.cwd : re(spec.cwd, ev.cwd))) return false;
      if (spec.user != null && ev.user !== spec.user) return false;
      if (spec.host != null && ev.host !== spec.host) return false;
      if (spec.file) {
        const f = spec.file; const vfs = K.kali ? K.kali.vfs : null;
        if (!vfs) return false;
        let st = null;
        try { st = vfs.stat(f.path); } catch (e) { st = null; }
        if (f.exists === false) { if (st) return false; }
        else {
          if (!st) return false;
          if (f.type === 'dir' && !st.isDir) return false;
          if (f.type === 'file' && !st.isFile) return false;
          if (f.mode != null && (st.mode & 0o7777).toString(8) !== String(f.mode).replace(/^0+(?=\d)/, '')) return false;
          if (f.contains != null) {
            let data = '';
            try { data = vfs.read(f.path); } catch (e) { return false; }
            if (!re(f.contains, data)) return false;
          }
        }
      }
      if (spec.env) {
        const sh = ev.shell;
        for (const k of Object.keys(spec.env)) {
          const v = sh ? sh.getVar(k) : null;
          if (v == null || !re(spec.env[k], v)) return false;
        }
      }
      if (spec.fn) { try { if (!spec.fn(ev, K)) return false; } catch (e) { return false; } }
      return true;
    },

    /** Does `text` satisfy a question step's `answer` (string, array of strings, or RegExp)? */
    checkAnswer(step, text) {
      const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
      const a = step.answer;
      if (a == null) return false;
      if (a instanceof RegExp || (a && typeof a.test === 'function')) { a.lastIndex = 0; return a.test(String(text).trim()); }
      const list = Array.isArray(a) ? a : [a];
      return list.some((x) => norm(x) === norm(text));
    },

    /* ------------------------------------------------------------ progress */
    progress: {
      data: { lessons: {}, version: 1 },
      _save: null,
      /** install persistence: load(obj) happens once, save(fn) is called on every change */
      attach(initial, saveFn) { if (initial && initial.lessons) this.data = initial; this._save = saveFn; },
      _touch() { if (this._save) { try { this._save(this.data); } catch (e) { /* storage unavailable */ } } K.events.emit('progress', this.data); },
      of(lessonId) { return this.data.lessons[lessonId] || { steps: {}, quiz: {}, done: false }; },
      stepDone(lessonId, stepId) {
        const p = (this.data.lessons[lessonId] = this.of(lessonId));
        if (p.steps[stepId]) return false;
        p.steps[stepId] = true; this._touch(); return true;
      },
      quizAnswered(lessonId, index, correct) {
        const p = (this.data.lessons[lessonId] = this.of(lessonId));
        p.quiz[index] = !!correct; this._touch();
      },
      complete(lessonId) {
        const p = (this.data.lessons[lessonId] = this.of(lessonId));
        if (!p.done) { p.done = true; p.at = K.clock.now(); this._touch(); }
      },
      isDone(lessonId) { return !!this.of(lessonId).done; },
      reset(lessonId) { if (lessonId) delete this.data.lessons[lessonId]; else this.data.lessons = {}; this._touch(); },
      summary() {
        const all = L.all();
        const done = all.filter((x) => this.isDone(x.lesson.id)).length;
        return { total: all.length, done };
      },
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
