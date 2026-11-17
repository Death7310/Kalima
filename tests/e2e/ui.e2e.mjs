// End-to-end test of the browser interface.
//
//   node tools/build.mjs && node tests/e2e/ui.e2e.mjs
//
// Opens dist/kalima.html from file:// in Chromium (Playwright) and drives the
// real page. Any console error, uncaught exception or request other than the
// document itself fails the run: the app must work offline from one file.
// Only shell builtins and the fixture commands registered below are used, so
// the test does not depend on which command packs are present.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist', 'kalima.html');
const URL = pathToFileURL(DIST).href;
const SHOTS = process.env.KALIMA_SHOTS || '';      // directory for screenshots (optional)
const ONLY = process.env.KALIMA_ONLY || '';        // run only the groups whose name contains this text

if (!fs.existsSync(DIST)) { console.error('dist/kalima.html is missing: run "node tools/build.mjs" first'); process.exit(2); }

const problems = [];      // console errors, page errors and network requests seen so far
const results = [];
const groups = [];
const group = (name, fn) => groups.push({ name, fn });

/** Fail on anything the page should never do. */
function watch(page) {
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console error: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('uncaught: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)));
  page.on('request', (r) => { if (r.url().split('#')[0] !== URL) problems.push('network request: ' + r.method() + ' ' + r.url().slice(0, 120)); });
}

/** Wait for the app to boot and add the fixtures (again after every reload). */
let withLessons = false;      // the lesson groups switch this on; earlier groups see an app without lessons
async function ready(page) {
  await page.waitForFunction(() => window.K && K.app && K.app.booted);
  await page.evaluate(installFixtures);
  if (withLessons) await page.evaluate(installLessons);
}
const closeDialogs = (page) => page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
/** A dialog is removed from the page once its (asynchronous) close event has been handled. */
const dialogGone = (page) => page.waitForFunction(() => !document.querySelector('dialog'));
const termFocused = (page) => page.evaluate(() => document.activeElement === K.app.term.ta);
async function open(browser, o = {}) {
  const context = o.context || await browser.newContext({ viewport: o.viewport || { width: 1280, height: 800 }, hasTouch: !!o.touch, isMobile: !!o.touch });
  const page = await context.newPage();
  watch(page);
  await page.goto(URL);
  await ready(page);
  return page;
}

/* ---- helpers that drive the terminal ---- */
const text = (page) => page.evaluate(() => K.app.term.text());
const waitText = (page, re, timeout = 5000) => page.waitForFunction(
  ([src, flags]) => new RegExp(src, flags).test(K.app.term.text()), [re.source, re.flags], { timeout });
const waitMode = (page, mode) => page.waitForFunction((m) => K.app.term.mode === m, mode);
/** Everything on the screen after the last occurrence of `marker`. */
const after = async (page, marker) => { const t = await text(page); return t.slice(t.lastIndexOf(marker) + marker.length); };
/** Type a command line and wait for the shell to be reading the next one. */
async function run(page, line) {
  await waitMode(page, 'read');
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => K.app.term.mode === 'read');
}
const typed = (page) => page.evaluate(() => { const r = K.app.term._read; return r ? r.buf : null; });
/** Wait until an output line with exactly this text is in the DOM (painting happens once per frame). */
const waitLine = (page, line) => page.waitForFunction(
  (t) => Array.from(document.querySelectorAll('.kt-screen > .kt-line')).some((el) => el.textContent === t), line);
const findLine = 'const findLine = (t) => Array.from(document.querySelectorAll(".kt-screen > .kt-line")).reverse().find((el) => el.textContent === t);';

const overlay = (page) => page.evaluate(() => {
  const o = K.app.term._overlay;
  if (!o) return null;
  const el = document.querySelector('.kt-over');
  return {
    kind: o.kind, lines: o.lines ? o.lines.slice() : null, cy: o.cy, cx: o.cx, mode: o.mode, msg: o.msg,
    top: o.rows ? o.rows[o._top()].li + 1 : null, page: o._visible ? o._visible() : null,
    status: (el.querySelector('.kt-pager-status, .kt-vim-status, .kt-nano-status') || {}).textContent, screen: el.innerText,
  };
});
const press = async (page, ...keys) => { for (const k of keys) await page.keyboard.press(k); };
const fileOnKali = (page, p) => page.evaluate((f) => { try { return K.kali.vfs.read(f); } catch (e) { return null; } }, p);
async function start(page, line, mode) {
  await waitMode(page, 'read');
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
  await waitMode(page, mode);
}

/* ---- fixture commands, registered in the page ---- */
function installFixtures() {
  const defs = [
    { name: 'fx-sleep', async run(ctx) { ctx.println('sleeping'); await ctx.sleep(600000); ctx.println('woke up'); return 0; } },
    { name: 'fx-lines', async run(ctx) { const n = parseInt(ctx.args[0], 10) || 10; let s = ''; for (let i = 1; i <= n; i++) s += 'line ' + i + ' of ' + n + '\n'; ctx.out(s); return 0; } },
    { name: 'fx-ask', async run(ctx) { const v = await ctx.readLine('Password: ', { hidden: true }); window.fxSecret = v; ctx.println('got ' + (v == null ? 'EOF' : v.length + ' characters')); return 0; } },
    {
      name: 'fx-pager',
      async run(ctx) {
        let s = '';
        for (let i = 1; i <= 300; i++) s += (i % 50 === 0 ? 'needle on row ' : 'row ') + i + '\n';
        await ctx.term.pager(s, { title: ctx.args[0] || '' });
        return 0;
      },
    },
    {
      // stands in for nano and vim: open the terminal's editor on a file and write the result back
      name: 'fx-edit',
      async run(ctx) {
        const file = ctx.args[1];
        let content = null;
        try { content = ctx.fs.read(file); } catch (e) { content = null; }
        const r = await ctx.term.editor({ path: file, content, flavor: ctx.args[0] });
        if (r.saved) ctx.fs.write(r.path || file, r.content);
        return 0;
      },
    },
    {
      // a full-screen style program reading raw keys, as top and watch do
      name: 'fx-keys',
      run(ctx) {
        return new Promise((resolve) => {
          const off = ctx.term.onKey((k) => { ctx.println('key ' + k); if (k === 'q') { off(); resolve(0); } });
        });
      },
    },
    {
      // traffic through the simulated network, as ping and a port scanner would cause
      name: 'fx-probe',
      run(ctx) {
        for (const ip of ctx.args) ctx.println(ip + ' ' + ctx.net.ping(ctx.machine, ip, 1).status + ' ' + ctx.net.tcp(ctx.machine, ip, 80).state);
        return 0;
      },
    },
    { name: 'fx-nap', async run(ctx) { await ctx.sleep(30000); ctx.println('napped'); return 0; } },
    { name: 'fx-power', run(ctx) { ctx.println('going down'); K.events.emit('power', { action: ctx.args[0] || 'reboot' }); return 0; } },
    { name: 'fxa-one', run() { return 0; } },
    { name: 'fxb-alpha', run() { return 0; } },
    { name: 'fxb-alpine', run() { return 0; } },
  ];
  for (const def of defs) { K.cmd.register(def); K.kali.installCommand(def); }
}

/* ---- a fixture curriculum (real lesson packs arrive separately) ---- */
function installLessons() {
  K.lessons.register({
    id: 'fx-basics', title: 'Fixture basics', order: 1, summary: 'Two lessons used by the interface test.',
    lessons: [
      {
        id: 'fx-first', title: 'First commands', minutes: 8,
        objectives: ['Print text with `echo`', 'Change directory'],
        intro: 'The **shell** runs *one line* at a time.\n\n- Names are case sensitive.\n- Press `Tab` to complete.\n\n```\necho <b>not markup</b>\n```\n\n<img src=x onerror="window.fxInjected=1">',
        steps: [
          { id: 's1', prompt: 'Print the word `hello` with `echo`.', hint: 'Type **echo** and then the word.', solution: 'echo hello', check: { cmd: 'echo', out: /^hello$/m } },
          { id: 's2', prompt: 'The shell keeps a working directory. Read on when you are ready.', info: true },
          { id: 's3', prompt: 'Which command prints the working directory?', hint: 'Print working directory.', answer: ['pwd', '/bin/pwd'] },
          { id: 's4', prompt: 'Change to the `/etc` directory.', solution: 'cd /etc', check: { cwd: '/etc' } },
        ],
        quiz: [
          { q: 'What does `pwd` print?', choices: ['The password file', 'The working directory', 'The last command'], answer: 1, why: 'It stands for *print working directory*.' },
          { q: 'Which key completes a name?', choices: ['Tab', 'Esc'], answer: 0, why: 'Tab asks the shell to complete it.' },
        ],
        refs: ['zshbuiltins(1)', 'FHS 3.0'],
      },
      { id: 'fx-second', title: 'Second lesson', minutes: 5, steps: [{ id: 'a', prompt: 'Run `pwd`.', solution: 'pwd', check: { cmd: 'pwd' } }] },
    ],
  });
  K.lessons.register({ id: 'fx-more', title: 'Fixture extras', order: 2, lessons: [{ id: 'fx-third', title: 'Third lesson', steps: [{ id: 'a', prompt: 'Continue.', info: true }] }] });
  K.app.renderLesson();
}

/* ------------------------------------------------------------------- groups */
const WELCOME = 'first run: welcome';
group(WELCOME, async ({ page }) => {
  const dlg = page.locator('dialog[open]');
  await dlg.waitFor();
  const words = await dlg.innerText();
  assert.match(words, /Welcome to Kalima/);
  assert.match(words, /simulated and offline/i, 'says that everything is simulated and offline');
  assert.match(words, /only be used on systems you own or have written permission to test/i, 'says that real use needs authorization');
  await page.keyboard.type('blocked');
  assert.doesNotMatch(await text(page), /blocked/, 'the terminal does not take keys while the dialog is open');
  await dlg.getByRole('button', { name: 'Start' }).click();
  await dialogGone(page);
  assert.equal(await termFocused(page), true, 'closing the welcome puts the keyboard in the terminal');
  await page.reload();
  await ready(page);
  assert.equal(await page.locator('dialog[open]').count(), 0, 'the welcome shows only on the first run');
});

group('terminal: prompt and echo', async ({ page }) => {
  await waitText(page, /\(kali㉿kali\)-\[~\]\n└─\$ $/);
  await run(page, 'echo hello');
  assert.match(await text(page), /└─\$ echo hello\nhello\n/);
  assert.equal(await termFocused(page), true, 'the terminal has keyboard focus');
});

group('terminal: history with Up and Down', async ({ page }) => {
  await run(page, 'echo one');
  await run(page, 'echo two');
  await page.keyboard.press('ArrowUp');
  assert.equal(await typed(page), 'echo two');
  await page.keyboard.press('ArrowUp');
  assert.equal(await typed(page), 'echo one');
  await page.keyboard.press('ArrowDown');
  assert.equal(await typed(page), 'echo two');
  await page.keyboard.press('ArrowDown');
  assert.equal(await typed(page), '', 'Down past the newest entry returns to the empty draft');
  await page.keyboard.type('echo dr');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  assert.equal(await typed(page), 'echo dr', 'the unfinished line is kept while browsing history');
  await page.keyboard.press('Control+u');
  assert.equal(await typed(page), '');
});

group('terminal: Tab completion', async ({ page }) => {
  await waitMode(page, 'read');
  await page.keyboard.type('fxa');
  await page.keyboard.press('Tab');
  assert.equal(await typed(page), 'fxa-one ', 'a single candidate is inserted with a space');
  await page.keyboard.press('Control+u');

  await page.keyboard.type('fxb');
  await page.keyboard.press('Tab');
  assert.equal(await typed(page), 'fxb-alp', 'several candidates extend to their common prefix');
  assert.equal(await page.locator('.kt-below').first().textContent(), '', 'no list after the first Tab');
  await page.keyboard.press('Tab');
  assert.match(await page.locator('.kt-below').first().textContent(), /fxb-alpha\s+fxb-alpine/, 'the second Tab lists the candidates');
  assert.equal(await typed(page), 'fxb-alp');
  await page.keyboard.press('Tab');                    // further Tabs walk through the candidates, as zsh does
  assert.equal(await typed(page), 'fxb-alpha');
  assert.equal(await page.locator('.kt-below .kt-sel').first().textContent(), 'fxb-alpha');
  await page.keyboard.press('Tab');
  assert.equal(await typed(page), 'fxb-alpine');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await typed(page), 'fxb-alpha');
  await page.keyboard.press('Control+u');
  await page.keyboard.type('fxb-alp');
  await page.keyboard.press('Tab');
  await page.keyboard.type('i');
  assert.equal(await page.locator('.kt-below').first().textContent(), '', 'typing removes the list');
  await page.keyboard.press('Tab');
  assert.equal(await typed(page), 'fxb-alpine ');
  await page.keyboard.press('Control+u');

  await page.keyboard.type('cd /us');
  await page.keyboard.press('Tab');
  assert.equal(await typed(page), 'cd /usr/', 'a directory completes with a slash and no space');
  await page.keyboard.press('Control+u');
});

group('terminal: reverse search, suggestions and continuation lines', async ({ page }) => {
  await run(page, 'echo search-target-one');
  await run(page, 'echo other');
  await page.keyboard.press('Control+r');                 // must not reload the page
  await page.keyboard.type('target');
  assert.equal(await page.locator('.kt-below').first().textContent().then((t) => t.trim()), 'bck-i-search: target');
  assert.match(await text(page), /└─\$ echo search-target-one$/);
  await page.keyboard.press('Enter');
  await waitText(page, /\nsearch-target-one\n[^\n]*\n└─\$ $/);
  assert.equal(await page.evaluate(() => K.app.booted && !!K.cmd.get('fx-sleep')), true, 'the page was not reloaded');

  // zsh-autosuggestions: the rest of the newest matching history line, accepted with Right
  await page.keyboard.type('echo sea');
  assert.equal(await page.evaluate(() => K.app.term._read.suggest), 'rch-target-one');
  await page.locator('.kt-suggest').first().waitFor();
  await page.keyboard.press('ArrowRight');
  assert.equal(await typed(page), 'echo search-target-one');
  await page.keyboard.press('Control+w');
  assert.equal(await typed(page), 'echo ', 'Ctrl-W deletes the word before the cursor');
  await page.keyboard.press('Control+u');

  // an unfinished quote asks for the rest on a continuation line
  await page.keyboard.type('echo "two');
  await page.keyboard.press('Enter');
  await waitText(page, /\n> $/);
  await page.keyboard.type('lines"');
  await page.keyboard.press('Enter');
  await waitText(page, /\ntwo\nlines\n[^\n]*\n└─\$ $/);

  await page.keyboard.type('echo before');
  await page.keyboard.press('Control+l');
  assert.match(await text(page), /^┌──\(kali㉿kali\)-\[~\]\n└─\$ echo before$/, 'Ctrl-L clears the screen and keeps the line');
  await page.keyboard.press('Control+u');
});

group('terminal: Ctrl-C and Ctrl-D', async ({ page }) => {
  await waitMode(page, 'read');
  await page.keyboard.type('echo never-run');
  await page.keyboard.press('Control+c');
  await waitMode(page, 'read');
  assert.equal(await typed(page), '', 'Ctrl-C abandons the line');
  assert.match(await after(page, 'echo never-run'), /^\n┌──\(kali㉿kali\)-\[~\]\n└─\$ $/, 'a fresh prompt follows and nothing ran');

  await page.keyboard.type('fx-sleep');
  await page.keyboard.press('Enter');
  await waitText(page, /sleeping\n$/);
  assert.equal(await page.evaluate(() => K.app.term.mode), 'run');
  await page.keyboard.press('Control+c');
  await waitMode(page, 'read');
  const tail = await after(page, 'sleeping\n');
  assert.match(tail, /^\^C\n/, 'the interrupt is echoed as ^C');
  assert.doesNotMatch(tail, /woke up/);
  await run(page, 'echo status=$?');
  assert.match(await text(page), /status=130\n/, 'an interrupted command exits with 130');

  // Ctrl-D on an empty line ends the shell; the tab gets a new login shell
  await run(page, 'export FX_MARK=old-shell');
  await page.keyboard.press('Control+d');
  await waitText(page, /\[Shell exited[^\n]*\]\n┌──\(kali㉿kali\)-\[~\]\n└─\$ $/);
  await run(page, 'echo mark=[$FX_MARK]');
  assert.match(await text(page), /mark=\[\]\n/, 'the new shell does not have the old shell\'s variables');
  await page.keyboard.type('echo keep');
  await page.keyboard.press('Control+d');
  assert.equal(await typed(page), 'echo keep', 'Ctrl-D does nothing at the end of a non-empty line');
  await page.keyboard.press('Control+u');
});

group('terminal: hidden password input', async ({ page }) => {
  await waitMode(page, 'read');
  await page.keyboard.type('fx-ask');
  await page.keyboard.press('Enter');
  await waitText(page, /Password: $/);
  await page.keyboard.type('s3cr3t-fixture');
  assert.doesNotMatch(await text(page), /s3cr3t/, 'typed characters are not shown');
  assert.doesNotMatch(await page.locator('.kt-screen').first().innerText(), /s3cr3t/);
  await page.keyboard.press('Enter');
  await waitText(page, /got 14 characters\n/);
  assert.equal(await page.evaluate(() => window.fxSecret), 's3cr3t-fixture');
  assert.doesNotMatch(await text(page), /s3cr3t/);
  await waitMode(page, 'read');
  await page.keyboard.press('ArrowUp');
  assert.equal(await typed(page), 'fx-ask', 'the password did not enter the history');
  await page.keyboard.press('Control+u');
});

group('terminal: multi-line paste', async ({ page }) => {
  await waitMode(page, 'read');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'echo paste-1\r\necho paste-2\necho paste-3\necho unfinished');
    K.app.term.ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => K.app.term.mode === 'read' && K.app.term._read.buf === 'echo unfinished');
  const t = await text(page);
  assert.match(t, /\$ echo paste-1\npaste-1\n[^]*\$ echo paste-2\npaste-2\n[^]*\$ echo paste-3\npaste-3\n/, 'each pasted line ran in order');
  assert.doesNotMatch(t, /\nunfinished\n/, 'the last line has no newline and waits at the prompt');
  await page.keyboard.press('Enter');
  await waitText(page, /\nunfinished\n/);
});

group('terminal: selection and copy survive typing', async ({ page }) => {
  await run(page, 'echo select-this-output');
  const selected = () => page.evaluate(() => String(getSelection()));
  await waitLine(page, 'select-this-output');
  await page.evaluate(findLine + `
    const range = document.createRange();
    range.selectNodeContents(findLine('select-this-output'));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);`);
  assert.equal(await selected(), 'select-this-output');
  await page.waitForTimeout(60);                       // a repaint must not rebuild the selected line
  assert.equal(await selected(), 'select-this-output');
  await page.keyboard.press('Control+c');              // copies; must not interrupt
  assert.equal(await page.evaluate(() => K.app.term.mode), 'read');
  assert.doesNotMatch(await after(page, 'select-this-output\n'), /\^C|\n[^]*\n[^]*\n/, 'Ctrl-C with a selection is a copy, not an interrupt');
  await page.keyboard.type('echo typed');
  assert.equal(await typed(page), 'echo typed');
  assert.equal(await selected(), 'select-this-output', 'typing leaves the selection alone');
  await page.keyboard.press('Enter');
  await waitText(page, /\ntyped\n/);
  // dragging over output selects it and does not move focus away for good
  await waitLine(page, 'typed');
  const box = await page.evaluate(findLine + 'const r = findLine("typed").getBoundingClientRect(); ({ x: r.left, y: r.top + r.height / 2 })');
  await page.mouse.move(box.x + 1, box.y); await page.mouse.down(); await page.mouse.move(box.x + 60, box.y, { steps: 4 }); await page.mouse.up();
  assert.match(await selected(), /^typed?$|^type$|^typ$/, 'a drag selects terminal text');
  await page.keyboard.type('echo again');
  await page.keyboard.press('Enter');
  await waitText(page, /\nagain\n/);
  await page.mouse.click(box.x + 300, box.y);          // a plain click clears the selection and focuses the input
  assert.equal(await page.evaluate(() => document.activeElement === K.app.term.ta), true, await page.evaluate(() => JSON.stringify([document.activeElement.className, String(getSelection()), getSelection().isCollapsed, K.app.term.mode])));
});

group('terminal: long output stays fast', async ({ page }) => {
  await waitMode(page, 'read');
  const t0 = Date.now();
  await run(page, 'fx-lines 8000');
  await waitText(page, /line 8000 of 8000\n[^\n]*\n[^\n]*$/);
  const printed = Date.now() - t0;
  assert.ok(printed < 3000, 'printing 8000 lines took ' + printed + ' ms');
  const info = await page.evaluate(() => {
    const v = K.app.term.view;
    return { lines: document.querySelectorAll('.kt-screen > .kt-line').length, atBottom: v.scrollHeight - v.scrollTop - v.clientHeight < 4 };
  });
  assert.ok(info.lines <= 5300, 'scrollback is capped (' + info.lines + ' lines kept)');
  assert.equal(info.atBottom, true, 'the view follows the output');
  const t1 = Date.now();
  await run(page, 'echo still-fast');
  await waitText(page, /\nstill-fast\n/);
  assert.ok(Date.now() - t1 < 1000, 'typing after long output took ' + (Date.now() - t1) + ' ms');
  await run(page, 'clear');
  assert.match(await text(page), /^┌──\(kali㉿kali\)-\[~\]\n└─\$ $/, 'clear empties the screen');
});

group('terminal: raw keys and type-ahead', async ({ page }) => {
  await start(page, 'fx-keys', 'run');
  await press(page, 'a', 'ArrowUp', 'Enter', 'q');
  await waitMode(page, 'read');
  assert.match(await text(page), /key a\nkey ArrowUp\nkey Enter\nkey q\n/);

  // keys typed while a command runs are kept for the next prompt
  await page.keyboard.type('fx-lines 3; echo first-done');
  await page.keyboard.press('Enter');
  await page.keyboard.type('echo typed-ahead');
  await page.keyboard.press('Enter');
  await waitText(page, /first-done\n[^]*\$ echo typed-ahead\ntyped-ahead\n/);
});

/* ---- pager and editors ---- */
group('pager: j k Space b g G /search n q', async ({ page }) => {
  await start(page, 'fx-pager', 'pager');
  let o = await overlay(page);
  assert.equal(o.top, 1);
  assert.equal(o.status, ':');
  assert.ok(o.page > 10, 'the pager fills the terminal (' + o.page + ' rows)');
  await press(page, 'j', 'j');
  assert.equal((await overlay(page)).top, 3);
  await press(page, 'k');
  assert.equal((await overlay(page)).top, 2);
  await press(page, 'Space');
  assert.equal((await overlay(page)).top, 2 + o.page);
  await press(page, 'b');
  assert.equal((await overlay(page)).top, 2);
  await press(page, 'G');
  o = await overlay(page);
  assert.equal(o.top, 300 - o.page + 1);
  assert.equal(o.status, '(END)');
  await press(page, 'g');
  assert.equal((await overlay(page)).top, 1);
  await page.keyboard.type('/needle');
  assert.equal((await overlay(page)).status.trimEnd(), '/needle');
  await press(page, 'Enter');
  assert.equal((await overlay(page)).top, 50, 'the first match moves to the top line');
  assert.ok(await page.locator('.kt-pager .kt-mark').count() >= 6, 'matches are highlighted');
  await press(page, 'n');
  assert.equal((await overlay(page)).top, 100);
  await press(page, 'N');
  assert.equal((await overlay(page)).top, 50);
  await page.keyboard.type('/no-such-text');
  await press(page, 'Enter');
  assert.equal((await overlay(page)).status, 'Pattern not found  (press RETURN)');
  await press(page, 'Enter', 'q');
  await waitMode(page, 'read');
  assert.equal(await page.locator('.kt-over').first().isHidden(), true);
  assert.match(await text(page), /\$ fx-pager\n[^\n]*\n└─\$ $/, 'the pager leaves no text behind');

  await start(page, "fx-pager 'fx-pager(1)'", 'pager');
  assert.equal((await overlay(page)).status, ' Manual page fx-pager(1) line 1 (press h for help or q to quit)');
  await press(page, 'G');
  o = await overlay(page);
  assert.equal(o.status, ' Manual page fx-pager(1) line ' + o.top + '/300 (END) (press h for help or q to quit)');
  await press(page, 'q');
  await waitMode(page, 'read');
});

group('nano: write out, exit question, cut, paste, search', async ({ page }) => {
  await start(page, 'fx-edit nano notes.txt', 'nano');
  let o = await overlay(page);
  assert.match(o.screen, /GNU nano 8\.6\s+notes\.txt/);
  assert.equal(o.status, '[ New File ]');
  assert.match(o.screen, /\^G Help\s+\^O Write Out/);
  await page.keyboard.type('first line');
  await press(page, 'Enter');
  await page.keyboard.type('second line');
  await press(page, 'Enter');
  await page.keyboard.type('third');
  assert.match((await overlay(page)).screen, /Modified/);
  await press(page, 'Control+o');
  assert.equal((await overlay(page)).status.trimEnd(), 'File Name to Write: notes.txt');
  await press(page, 'Enter');
  o = await overlay(page);
  assert.equal(o.status, '[ Wrote 3 lines ]');
  assert.doesNotMatch(o.screen, /Modified/);

  await press(page, 'ArrowUp', 'Control+k');                 // cut "second line"
  assert.deepEqual((await overlay(page)).lines, ['first line', 'third']);
  await press(page, 'ArrowUp', 'Control+u');                 // paste it above "first line"
  assert.deepEqual((await overlay(page)).lines, ['second line', 'first line', 'third']);
  await press(page, 'Control+w');
  assert.equal((await overlay(page)).status.trimEnd(), 'Search:');
  await page.keyboard.type('thi');
  await press(page, 'Enter');
  o = await overlay(page);
  assert.deepEqual([o.cy, o.cx], [2, 0], 'the cursor is on the match');
  await press(page, 'Control+w');
  await page.keyboard.type('absent');
  await press(page, 'Enter');
  assert.equal((await overlay(page)).status, '[ "absent" not found ]');

  await press(page, 'Control+x');
  assert.equal((await overlay(page)).status.trimEnd(), 'Save modified buffer?');
  await press(page, 'Control+c');                            // cancel, still editing
  assert.equal((await overlay(page)).status, '[ Cancelled ]');
  await press(page, 'Control+x', 'y');
  assert.equal((await overlay(page)).status.trimEnd(), 'File Name to Write: notes.txt');
  await press(page, 'Enter');
  await waitMode(page, 'read');
  assert.equal(await fileOnKali(page, '/home/kali/notes.txt'), 'second line\nfirst line\nthird\n');

  await start(page, 'fx-edit nano notes.txt', 'nano');
  assert.equal((await overlay(page)).status, '[ Read 3 lines ]');
  await page.keyboard.type('discard me ');
  await press(page, 'Control+x', 'n');
  await waitMode(page, 'read');
  assert.equal(await fileOnKali(page, '/home/kali/notes.txt'), 'second line\nfirst line\nthird\n', 'answering N leaves the file alone');
});

group('vim: modes, motions, edits, search and ex commands', async ({ page }) => {
  await start(page, 'fx-edit vim v.txt', 'vim');
  let o = await overlay(page);
  assert.equal(o.mode, 'normal');
  assert.match(o.status, /^"v\.txt" \[New\]/);
  assert.match(o.screen, /\n~\n~\n/, 'empty screen lines show tildes');
  assert.equal(await page.evaluate(() => { const b = document.querySelector('.kt-vim .kt-ed-body'); return b.scrollHeight <= b.clientHeight; }), true, 'the tildes do not scroll');
  await press(page, 'i');
  assert.match((await overlay(page)).status, /^-- INSERT --/);
  await page.keyboard.type('alpha');
  await press(page, 'Enter');
  await page.keyboard.type('beta');
  await press(page, 'Escape');
  o = await overlay(page);
  assert.deepEqual([o.mode, o.lines, o.cy, o.cx], ['normal', ['alpha', 'beta'], 1, 3]);
  await press(page, 'o');
  await page.keyboard.type('gamma');
  await press(page, 'Escape', 'k', 'k', 'a');                // append after the "a" of alpha that the cursor is on
  await page.keyboard.type('X');
  await press(page, 'Escape');
  assert.deepEqual((await overlay(page)).lines, ['alphaX', 'beta', 'gamma']);
  await press(page, 'x');
  assert.deepEqual((await overlay(page)).lines, ['alpha', 'beta', 'gamma']);

  await press(page, '0', 'l', 'l', 'j');
  o = await overlay(page);
  assert.deepEqual([o.cy, o.cx], [1, 2]);
  await press(page, 'h', 'k');
  o = await overlay(page);
  assert.deepEqual([o.cy, o.cx], [0, 1]);

  await press(page, 'j', 'd', 'd');                          // delete "beta"
  assert.deepEqual((await overlay(page)).lines, ['alpha', 'gamma']);
  await press(page, 'u');
  assert.deepEqual((await overlay(page)).lines, ['alpha', 'beta', 'gamma']);
  await press(page, 'g', 'g', 'y', 'y', 'G', 'p');           // copy "alpha" below the last line
  o = await overlay(page);
  assert.deepEqual([o.lines, o.cy], [['alpha', 'beta', 'gamma', 'alpha'], 3]);

  await page.keyboard.type('/bet');
  assert.equal((await overlay(page)).status.trimEnd(), '/bet');
  await press(page, 'Enter');
  o = await overlay(page);
  assert.deepEqual([o.cy, o.cx], [1, 0]);

  await page.keyboard.type(':q');
  await press(page, 'Enter');
  assert.match((await overlay(page)).status, /^E37: No write since last change \(add ! to override\)/);
  await page.keyboard.type(':w');
  await press(page, 'Enter');
  assert.match((await overlay(page)).status, /^"v\.txt" \[New\] 4L, 23B written/);
  await press(page, 'G', 'd', 'd');
  await page.keyboard.type(':wq');
  await press(page, 'Enter');
  await waitMode(page, 'read');
  assert.equal(await fileOnKali(page, '/home/kali/v.txt'), 'alpha\nbeta\ngamma\n');

  await start(page, 'fx-edit vim v.txt', 'vim');
  assert.match((await overlay(page)).status, /^"v\.txt" 3L, 17B/);
  await press(page, 'd', 'd');
  await page.keyboard.type(':q!');
  await press(page, 'Enter');
  await waitMode(page, 'read');
  assert.equal(await fileOnKali(page, '/home/kali/v.txt'), 'alpha\nbeta\ngamma\n', ':q! throws the change away');
  await start(page, 'fx-edit vim v.txt', 'vim');
  await page.keyboard.type(':q');
  await press(page, 'Enter');
  await waitMode(page, 'read');
  assert.equal(await page.evaluate(() => document.activeElement === K.app.term.ta), true, 'focus is back on the command line');
});

/* ---- lessons ---- */
const panel = (page) => page.locator('#k-panel-lesson');
const stepState = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.k-step')).map((el) => (el.className.match(/is-\w+/g) || []).join('+')));
const waitCurrent = (page, n) => page.waitForFunction((i) => { const el = document.querySelectorAll('.k-step')[i]; return !!el && el.classList.contains('is-current'); }, n - 1);

group('lessons: empty state, then the browser', async ({ page }) => {
  assert.match(await panel(page).innerText(), /No lessons are installed/);
  assert.equal(await page.locator('.k-top-progress').isHidden(), true);
  assert.equal(await page.evaluate(() => K.ui.md('<i>x</i> & **b** *i* `c*d*`\n\n- one\n  more\n- two\n\n```\na < b\n```')),
    '<p>&lt;i&gt;x&lt;/i&gt; &amp; <strong>b</strong> <em>i</em> <code>c*d*</code></p><ul><li>one more</li><li>two</li></ul><pre><code>a &lt; b</code></pre>');

  withLessons = true;
  await page.evaluate(installLessons);
  const words = await panel(page).innerText();
  assert.match(words, /Lessons\s+0 of 3 complete/);
  assert.match(words, /START HERE\s+First commands/i);
  assert.match(words, /Fixture basics\s+0\/2[^]*First commands\s+8 min[^]*Second lesson[^]*Fixture extras\s+0\/1[^]*Third lesson/);
  assert.match(await page.locator('.k-top-progress').innerText(), /0 of 3 lessons/);
});

group('lessons: steps, hint, solution, question, quiz and completion', async ({ page }) => {
  await panel(page).getByRole('button', { name: /First commands 8 min/ }).click();
  const doc = page.locator('.k-doc');
  assert.equal(await doc.locator('h2').innerText(), 'First commands');
  assert.match(await doc.locator('.k-objectives').innerText(), /Print text with echo\s+Change directory/);
  assert.equal(await doc.locator('.k-md').first().innerHTML(),
    '<p>The <strong>shell</strong> runs <em>one line</em> at a time.</p><ul><li>Names are case sensitive.</li><li>Press <code>Tab</code> to complete.</li></ul>' +
    '<pre><code>echo &lt;b&gt;not markup&lt;/b&gt;</code></pre><p>&lt;img src=x onerror="window.fxInjected=1"&gt;</p>');
  assert.equal(await page.evaluate(() => window.fxInjected), undefined, 'lesson text cannot inject markup');
  assert.deepEqual(await stepState(page), ['is-current', 'is-todo', 'is-todo', 'is-todo']);
  assert.equal(await page.locator('.k-step[aria-current="step"]').count(), 1);
  assert.match(await panel(page).innerText(), /Step 1 of 4/);
  assert.equal(await termFocused(page), true, 'opening a lesson leaves the keyboard in the terminal');

  // a command that does not satisfy the check changes nothing
  await run(page, 'echo something else');
  assert.deepEqual(await stepState(page), ['is-current', 'is-todo', 'is-todo', 'is-todo']);

  // hint first, then the solution, which can be put on the command line
  assert.equal(await panel(page).getByRole('button', { name: 'Show solution' }).count(), 0);
  await panel(page).getByRole('button', { name: 'Hint' }).click();
  assert.match(await page.locator('.k-hint').innerText(), /HINT\s+Type echo and then the word\./i);
  await panel(page).getByRole('button', { name: 'Show solution' }).click();
  assert.match(await page.locator('.k-hint.is-solution').innerText(), /echo hello/);
  await panel(page).getByRole('button', { name: 'Put it on the command line' }).click();
  assert.equal(await typed(page), 'echo hello');
  assert.equal(await termFocused(page), true);
  await page.keyboard.press('Enter');

  // calm success state, then the next step opens by itself
  await page.locator('.k-step.is-fresh').waitFor();
  assert.match(await page.locator('.k-step.is-fresh').innerText(), /Step complete/);
  assert.equal(await page.evaluate(() => K.lessons.progress.of('fx-first').steps.s1), true);
  await waitCurrent(page, 2);
  assert.deepEqual(await stepState(page), ['is-done', 'is-current', 'is-todo', 'is-todo']);

  // info step
  await panel(page).getByRole('button', { name: 'Continue' }).click();
  await waitCurrent(page, 3);

  // question step: a wrong answer, then a right one
  const answer = panel(page).getByLabel('Your answer');
  await answer.fill('ls');
  await answer.press('Enter');
  assert.match(await page.locator('.k-step.is-current').innerText(), /Not quite/);
  assert.deepEqual(await stepState(page), ['is-done', 'is-done', 'is-current', 'is-todo']);
  assert.equal(await answer.inputValue(), 'ls', 'the wrong answer stays in the field for editing');
  await answer.fill(' PWD ');
  await panel(page).getByRole('button', { name: 'Check' }).click();
  await waitCurrent(page, 4);
  assert.equal(await termFocused(page), true, 'after the answer the keyboard returns to the terminal');

  // last command step (no hint: the solution is offered directly)
  assert.equal(await panel(page).getByRole('button', { name: 'Hint' }).count(), 0);
  assert.equal(await panel(page).getByRole('button', { name: 'Show solution' }).count(), 1);
  await run(page, 'cd /etc');
  const quiz = page.locator('.k-quiz');
  await quiz.waitFor();
  assert.match(await panel(page).innerText(), /\bQuiz\b/);
  assert.equal(await page.evaluate(() => K.lessons.progress.isDone('fx-first')), false, 'the lesson is not complete before the quiz');

  // quiz: immediate feedback with the explanation
  const q1 = quiz.locator('.k-q').nth(0); const q2 = quiz.locator('.k-q').nth(1);
  await q1.getByRole('button', { name: /The password file/ }).click();
  assert.match(await q1.locator('.k-why').innerText(), /Not quite\. The answer is B\. It stands for print working directory\./);
  assert.equal(await q1.locator('.k-choice.is-wrong').count(), 1);
  assert.match(await q1.locator('.k-choice.is-right').innerText(), /The working directory/);
  assert.equal(await q1.locator('.k-choice:disabled').count(), 3, 'an answered question is locked');
  await q2.getByRole('button', { name: /Tab/ }).click();
  assert.match(await q2.locator('.k-why').innerText(), /Correct\. Tab asks the shell to complete it\./);

  const done = page.locator('.k-complete');
  await done.waitFor();
  assert.match(await done.innerText(), /Lesson complete\s+Quiz: 1 of 2 correct\./);
  assert.match(await panel(page).locator('.k-refs').innerText(), /zshbuiltins\(1\)\s+FHS 3\.0/);
  assert.deepEqual(await page.evaluate(() => { const p = K.lessons.progress.of('fx-first'); return [p.done, p.quiz[0], p.quiz[1]]; }), [true, false, true]);
  assert.match(await page.locator('.k-top-progress').innerText(), /1 of 3 lessons/);

  await done.getByRole('button', { name: /Next: Second lesson/ }).click();
  assert.equal(await doc.locator('h2').innerText(), 'Second lesson');
  await panel(page).getByRole('button', { name: 'All lessons' }).click();
  const words = await panel(page).innerText();
  assert.match(words, /1 of 3 complete/);
  assert.match(words, /CONTINUE\s+Second lesson/i);
  assert.equal(await page.locator('.k-lesson-row.is-done').count(), 1);
  assert.match(await page.locator('.k-lesson-row.is-done').innerText(), /First commands[^]*Completed/);
  await run(page, 'cd');
});

/* ---- the rest of the app ---- */
const tabLabels = (page) => page.locator('.k-termtab').allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, ' ').trim()));
const settings = async (page) => { await page.getByRole('button', { name: 'Settings' }).click(); return page.locator('dialog[open]'); };

group('terminal tabs: up to four shells on the same machine', async ({ page }) => {
  await run(page, 'export FX_TAB=one');
  assert.deepEqual(await tabLabels(page), ['1 kali@kali: ~']);
  assert.equal(await page.locator('.k-termtab-x').count(), 0, 'a single tab cannot be closed');
  const add = page.getByRole('button', { name: 'New terminal tab' });
  await add.click();
  await waitText(page, /^┌──\(kali㉿kali\)-\[~\]\n└─\$ $/);
  assert.equal(await termFocused(page), true, 'the new tab has the keyboard');
  assert.equal(await page.locator('.k-term-stack .kt').count(), 2, 'each tab has its own terminal widget');
  await run(page, 'echo "tab=[$FX_TAB]"; cd /tmp; echo from-two > /tmp/fx-shared.txt');
  assert.match(await text(page), /tab=\[\]\n/, 'the second tab is a new shell');
  assert.deepEqual(await tabLabels(page), ['1 kali@kali: ~', '2 kali@kali: /tmp']);

  await page.getByRole('tab', { name: /1 kali@kali: ~/ }).click();
  assert.equal(await termFocused(page), true);
  await run(page, 'read line < /tmp/fx-shared.txt; echo "tab=[$FX_TAB] file=[$line]"');
  assert.match(await text(page), /tab=\[one\] file=\[from-two\]\n/, 'tabs keep their own shell state and share the filesystem');
  assert.doesNotMatch(await text(page), /fx-shared\.txt; cd/, 'each tab has its own screen');

  await add.click(); await add.click();
  assert.equal(await page.locator('.k-termtab').count(), 4);
  assert.equal(await add.isDisabled(), true, 'four tabs at most');
  await page.getByRole('button', { name: 'Close terminal 3' }).click();
  assert.equal(await page.locator('.k-termtab').count(), 3);
  assert.equal(await termFocused(page), true);
  await waitMode(page, 'read');
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => K.app.tabs.length === 2);      // exit closes the tab it was typed in
  await page.getByRole('button', { name: 'Close terminal 2' }).click();
  assert.deepEqual(await tabLabels(page), ['1 kali@kali: ~']);
  assert.equal(await page.locator('.k-term-stack .kt').count(), 1);
  assert.equal(await page.evaluate(() => K.kali.procs.filter((p) => /zsh$/.test(p.cmd)).length), 1, 'closed tabs leave no shell process behind');
  await run(page, 'echo "back in [$FX_TAB]"');
  assert.match(await text(page), /back in \[one\]\n/);
});

group('lab panel: engagement, scope, address and discovered hosts', async ({ page }) => {
  const lab = page.locator('#k-panel-lab');
  if (await lab.isHidden()) await page.getByRole('button', { name: 'Lab panel' }).click();
  let words = await lab.innerText();
  assert.match(words, /ENGAGEMENT HF-LAB-2026-11/i);
  assert.match(words, /Halcyon Freight internal network assessment/);
  assert.match(words, /In scope\s+10\.10\.10\.0\/24\s+\*\.halcyon\.lab/);
  assert.match(words, /Network map\s+0 hosts found\s+10\.10\.10\.5\/24\s*kali \(you\)\s+eth0\s+gateway 10\.10\.10\.1\s+dns 10\.10\.10\.53\s+No other hosts yet/);
  assert.equal(await termFocused(page), true, 'opening the panel does not take the keyboard');

  // web01 answers; .99 does not exist; dc01 drops pings and has no web server; 8.8.8.8 is not a lab host
  await run(page, 'fx-probe 10.10.10.10 10.10.10.99 10.10.10.50 8.8.8.8');
  await page.locator('.k-node:not(.is-self)').first().waitFor();
  words = await lab.locator('.k-hosts').innerText();
  assert.match(words, /Network map\s+1 host found/);
  assert.match(words, /kali \(you\)[^]*dns 10\.10\.10\.53\s+10\.10\.10\.10\s*web01\.halcyon\.lab\s+80 http/);
  assert.doesNotMatch(words, /8\.8\.8\.8|10\.10\.10\.99|10\.10\.10\.50/);
  await run(page, 'fx-probe 10.10.10.1');
  await page.waitForFunction(() => document.querySelectorAll('.k-node:not(.is-self)').length === 2);
  assert.match(await lab.locator('.k-hosts').innerText(), /10\.10\.10\.1\s*gw\.halcyon\.lab\s+80 http\s+10\.10\.10\.10/, 'hosts are listed in address order');
});

group('settings: time speed, font size, restart and the power event', async ({ page }) => {
  let dlg = await settings(page);
  await dlg.getByRole('radio', { name: 'Instant' }).check();
  assert.equal(await page.evaluate(() => K.settings.timeScale), 0);
  await dlg.getByRole('radio', { name: 'Fast' }).check();
  assert.equal(await page.evaluate(() => K.settings.timeScale), 0.2);
  assert.match(await dlg.innerText(), /five times shorter/);
  await dlg.getByRole('radio', { name: 'Instant' }).check();
  const before = await page.evaluate(() => ({ fs: getComputedStyle(K.app.term.el).getPropertyValue('--kt-fs'), cols: K.app.term.cols }));
  await dlg.getByRole('button', { name: 'Larger text' }).click();
  await dlg.getByRole('button', { name: 'Larger text' }).click();
  await page.waitForFunction((c) => K.app.term.cols < c, before.cols);
  assert.equal(await page.evaluate(() => getComputedStyle(K.app.term.el).getPropertyValue('--kt-fs')), parseInt(before.fs, 10) + 2 + 'px');
  assert.match(await dlg.innerText(), new RegExp((parseInt(before.fs, 10) + 2) + ' px'));
  await dlg.getByRole('button', { name: 'Smaller text' }).click();
  await dlg.getByRole('button', { name: 'Close' }).click();
  await dialogGone(page);
  assert.equal(await termFocused(page), true, 'closing settings returns the keyboard to the terminal');

  const t0 = Date.now();
  await run(page, 'fx-nap');                                    // sleeps 30 simulated seconds
  assert.match(await text(page), /napped\n/);
  assert.ok(Date.now() - t0 < 2000, 'instant time speed does not wait');

  // restart keeps the home directory and resets the rest of the machine
  await run(page, 'echo kept > ~/fx-keep.txt; echo lost > /tmp/fx-lost.txt; export FX_OLD=1');
  dlg = await settings(page);
  await dlg.getByRole('button', { name: 'Restart simulator' }).click();
  await page.waitForFunction(() => K.app.booted && K.app.term && K.app.term.mode === 'read' && !K.app.term.text().includes('fx-keep'));
  await page.evaluate(installFixtures);
  assert.match(await page.locator('.k-toast').innerText(), /restarted/);
  assert.equal(await termFocused(page), true);
  await run(page, 'read kept < ~/fx-keep.txt; [ -e /tmp/fx-lost.txt ] || lost=gone; echo "kept=$kept lost=$lost old=[$FX_OLD]"');
  assert.match(await text(page), /kept=kept lost=gone old=\[\]\n/);

  // reboot, poweroff and reset all arrive as a 'power' event
  await run(page, 'echo again > ~/fx-again.txt');
  await page.keyboard.type('fx-power poweroff');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => K.app.booted && K.app.term && K.app.term.mode === 'read' && !K.app.term.text().includes('going down'));
  await page.evaluate(installFixtures);
  await run(page, 'read again < ~/fx-again.txt; echo "again=$again"');
  assert.match(await text(page), /again=again\n/);
  assert.equal(await page.locator('.k-term-stack .kt').count(), 1);
});

group('persistence: state survives a reload', async ({ page }) => {
  await panel(page).getByRole('button', { name: /Second lesson/ }).first().click();
  await run(page, 'echo remember-me');
  await page.getByRole('button', { name: 'Lesson panel' }).click();        // collapse the lesson panel
  assert.equal(await panel(page).isHidden(), true);
  await page.getByRole('button', { name: 'Lesson panel' }).click();
  const saved = await page.evaluate(() => ({ fs: K.app.settings.fontSize, hosts: document.querySelectorAll('.k-node:not(.is-self)').length }));
  assert.equal(saved.hosts, 2);

  await page.reload();
  await ready(page);
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await page.locator('.k-doc h2').innerText(), 'Second lesson', 'the open lesson is restored');
  assert.deepEqual(await page.evaluate(() => [K.lessons.progress.isDone('fx-first'), K.lessons.progress.of('fx-first').quiz[1], K.settings.timeScale, K.app.settings.fontSize]),
    [true, true, 0, saved.fs], 'lesson progress and settings are restored');
  assert.match(await page.locator('.k-top-progress').innerText(), /1 of 3 lessons/);
  assert.equal(await page.locator('.k-node:not(.is-self)').count(), 2, 'the lab map is restored');
  await run(page, 'read kept < ~/fx-keep.txt; echo "kept=$kept"');
  assert.match(await text(page), /kept=kept\n/, 'the home directory is restored');
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
  assert.equal(await typed(page), 'echo remember-me', 'shell history is restored with the home directory');
  await page.keyboard.press('Control+u');
});

group('settings: erase saved progress', async ({ page }) => {
  const dlg = await settings(page);
  await dlg.getByRole('button', { name: 'Erase saved progress' }).click();
  assert.match(await dlg.innerText(), /Erase lesson progress, the files in your simulated home directory and the lab map/);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await page.evaluate(() => K.lessons.progress.isDone('fx-first')), true, 'cancel keeps everything');
  await dlg.getByRole('button', { name: 'Erase saved progress' }).click();
  await dlg.getByRole('button', { name: 'Erase', exact: true }).click();
  await page.waitForFunction(() => K.app.booted && K.app.term && K.app.term.mode === 'read' && !K.lessons.progress.isDone('fx-first'));
  await page.evaluate(installFixtures);
  assert.match(await panel(page).innerText(), /Lessons\s+0 of 3 complete/);
  assert.equal(await page.locator('.k-node:not(.is-self)').count(), 0);
  await run(page, '[ -e ~/fx-keep.txt ] || echo home-is-fresh');
  assert.match(await text(page), /home-is-fresh\n/);
  await page.reload();
  await ready(page);
  assert.equal(await page.locator('dialog[open]').count(), 0, 'erasing does not bring the welcome back');
  assert.deepEqual(await page.evaluate(() => [K.lessons.progress.summary().done, K.settings.timeScale]), [0, 0], 'progress is gone, preferences stay');
});

/* ---- layout ---- */
const box = (page, sel) => page.locator(sel).first().boundingBox();

group('wide layout: lesson beside the terminal, resizable and collapsible', async ({ page }) => {
  let lesson = await box(page, '#k-panel-lesson'); let work = await box(page, '#k-panel-terminal');
  assert.ok(lesson.x + lesson.width <= work.x + 1 && Math.abs(lesson.y - work.y) < 1, 'the lesson panel sits to the left of the terminal');
  assert.equal(await page.locator('.k-views').isHidden(), true, 'no view switcher on a wide screen');
  const colsBefore = await page.evaluate(() => K.app.term.cols);

  const split = await box(page, '.k-split');
  await page.mouse.move(split.x + split.width / 2, split.y + 200);
  await page.mouse.down();
  await page.mouse.move(split.x + split.width / 2 + 120, split.y + 220, { steps: 5 });
  await page.mouse.up();
  const wider = await box(page, '#k-panel-lesson');
  assert.ok(Math.abs(wider.width - (lesson.width + 120)) <= 2, 'dragging the divider resizes the panel (' + lesson.width + ' -> ' + wider.width + ')');
  await page.waitForFunction((c) => K.app.term.cols < c, colsBefore);
  assert.equal(await termFocused(page), true, 'after resizing the keyboard is in the terminal');
  await page.locator('.k-split').focus();
  await page.keyboard.press('ArrowLeft');
  assert.ok(Math.abs((await box(page, '#k-panel-lesson')).width - (wider.width - 24)) <= 1, 'the divider also works from the keyboard');
  await page.keyboard.press('Home');
  assert.equal((await box(page, '#k-panel-lesson')).width, 300, 'the panel has a minimum width');
  await page.locator('.k-split').dblclick();
  assert.equal((await box(page, '#k-panel-lesson')).width, 420);

  const toggle = page.getByRole('button', { name: 'Lesson panel' });
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  await toggle.click();
  assert.equal(await page.locator('#k-panel-lesson').isHidden(), true);
  work = await box(page, '#k-panel-terminal');
  assert.equal(work.x, 0, 'with the panel collapsed the terminal starts at the left edge');
  assert.equal(await termFocused(page), true);
  await page.reload();
  await ready(page);
  assert.equal(await page.locator('#k-panel-lesson').isHidden(), true, 'the collapsed state is remembered');
  await page.getByRole('button', { name: 'Lesson panel' }).click();
  assert.equal(await page.locator('#k-panel-lesson').isVisible(), true);

  // a key pressed while nothing has focus still reaches the command line
  await page.locator('.k-doc h2, .k-panel-head h2').first().click();
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.type('echo stray-keys');
  await page.keyboard.press('Enter');
  await waitText(page, /\nstray-keys\n/);
});

group('phone viewport: one view at a time, touch keys, usable terminal', async ({ browser }) => {
  const page = await open(browser, { viewport: { width: 360, height: 740 }, touch: true });
  try {
    const dlg = await box(page, 'dialog[open]');
    assert.ok(dlg.x >= 0 && dlg.x + dlg.width <= 360 && dlg.y >= 0 && dlg.y + dlg.height <= 740, 'the welcome fits the screen');
    await page.getByRole('button', { name: 'Start' }).tap();
    await dialogGone(page);

    const tabs = page.locator('.k-views');
    assert.equal(await tabs.isVisible(), true);
    await tabs.getByRole('tab', { name: 'Lesson' }).tap();
    assert.equal(await page.locator('#k-panel-terminal').isHidden(), true, 'only one view shows at a time');
    await panel(page).getByRole('button', { name: /First commands/ }).first().tap();
    assert.match(await page.locator('.k-step.is-current').innerText(), /Print the word hello/);
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && Array.from(document.querySelectorAll('.k-app *')).every((el) => {
      const r = el.getBoundingClientRect(); return r.width === 0 || el.closest('.kt-keys, .k-termtabs, pre') || (r.left >= -0.5 && r.right <= innerWidth + 0.5);
    }));
    assert.equal(await fits(), true, 'nothing in the lesson view is wider than the screen');

    await page.getByRole('button', { name: 'Open terminal' }).tap();
    const kt = await box(page, '.k-term:not([hidden]) .kt');
    assert.equal(kt.width, 360, 'the terminal gets the full width');
    assert.ok(await page.evaluate(() => K.app.term.cols) >= 40, 'at least 40 columns on a phone');
    assert.equal(await termFocused(page), true, 'switching to the terminal focuses it');
    assert.match(await page.locator('.k-task').innerText(), /STEP 1\/4\s+Print the word hello with echo\./i);
    assert.equal(await fits(), true, 'nothing in the terminal view is wider than the screen');

    // the key bar stands in for the keys a phone keyboard lacks
    const keys = page.locator('.k-term:not([hidden]) .kt-keys');
    assert.equal(await keys.isVisible(), true);
    assert.deepEqual((await keys.locator('button').allInnerTexts()).slice(0, 5), ['Tab', 'Ctrl', '^C', '^D', 'Esc']);
    await page.keyboard.type('fxa');
    await keys.getByRole('button', { name: 'Tab', exact: true }).tap();
    assert.equal(await typed(page), 'fxa-one ');
    assert.equal(await termFocused(page), true, 'tapping a key keeps the keyboard open');
    await keys.getByRole('button', { name: 'Control: applies to the next key' }).tap();
    assert.equal(await keys.getByRole('button', { name: /^Control:/ }).getAttribute('aria-pressed'), 'true');
    await page.keyboard.insertText('u');                       // text from a soft keyboard arrives without key codes
    assert.equal(await typed(page), '', 'Ctrl then u clears the line');
    await page.keyboard.insertText('echo hello');
    assert.equal(await typed(page), 'echo hello');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Step complete/.test(document.querySelector('.k-task').textContent));
    await page.waitForFunction(() => /STEP 2\/4/i.test(document.querySelector('.k-task').textContent));
    await page.keyboard.insertText('echo abandoned');
    await keys.getByRole('button', { name: 'Control C' }).tap();
    assert.equal(await typed(page), '');

    // full-screen programs bring their own keys
    await start(page, 'fx-pager', 'pager');
    assert.deepEqual((await keys.locator('button').allInnerTexts()).slice(0, 3), ['q', 'Space', 'b']);
    await keys.getByRole('button', { name: 'page down' }).tap();
    assert.ok((await overlay(page)).top > 1);
    await keys.getByRole('button', { name: 'quit' }).tap();
    await waitMode(page, 'read');

    await page.locator('.k-task').tap();
    assert.equal(await page.locator('#k-panel-lesson').isVisible(), true, 'the step strip leads back to the lesson');
    await tabs.getByRole('tab', { name: 'Lab' }).tap();
    assert.match(await page.locator('#k-panel-lab').innerText(), /HF-LAB-2026-11[^]*Network map/);
    assert.equal(await page.locator('#k-panel-lesson').isHidden(), true);
    assert.equal(await fits(), true, 'nothing in the lab view is wider than the screen');

    await page.getByRole('button', { name: 'Settings' }).tap();
    const sheet = await box(page, 'dialog[open]');
    assert.ok(sheet.x >= 0 && sheet.x + sheet.width <= 360 && sheet.y + sheet.height <= 740, 'settings fit the screen');
    await closeDialogs(page);
    await dialogGone(page);

    await page.reload();
    await ready(page);
    assert.equal(await page.locator('#k-panel-lab').isVisible(), true, 'the chosen view survives a reload');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    await tabs.getByRole('tab', { name: 'Lesson' }).tap();
    assert.match(await panel(page).innerText(), /Step 2 of 4/, 'lesson progress survives a reload');
  } finally {
    await page.context().close();
  }
});

/* ------------------------------------------------------------------- runner */
const browser = await chromium.launch();
let failed = 0;
try {
  const page = await open(browser);
  for (const g of groups) {
    if (ONLY && !g.name.includes(ONLY)) continue;
    const t0 = Date.now();
    let error = null;
    try {
      if (g.name !== WELCOME) await closeDialogs(page);
      await g.fn({ page, browser });
    } catch (e) { error = e; }
    if (!error && problems.length) error = new Error(problems.join('\n'));
    problems.length = 0;
    results.push({ name: g.name, ok: !error });
    console.log((error ? 'not ok ' : 'ok ') + results.length + ' - ' + g.name + ' (' + (Date.now() - t0) + ' ms)');
    if (error) {
      failed++;
      console.log(String(error && error.stack ? error.stack : error).split('\n').map((l) => '    ' + l).join('\n'));
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'fail-' + results.length + '.png') }).catch(() => {});
      // start the next group from a clean page so one failure does not cascade
      await page.reload().then(() => ready(page)).catch(() => {});
      problems.length = 0;
    }
  }
} finally {
  await browser.close();
}
console.log('# ' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
