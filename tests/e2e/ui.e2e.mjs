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

/** Wait for the app to boot and add the fixture commands (again after every reload). */
async function ready(page) {
  await page.waitForFunction(() => window.K && K.app && K.app.booted);
  await page.evaluate(installFixtures);
}
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
    { name: 'fxa-one', run() { return 0; } },
    { name: 'fxb-alpha', run() { return 0; } },
    { name: 'fxb-alpine', run() { return 0; } },
  ];
  for (const def of defs) { K.cmd.register(def); K.kali.installCommand(def); }
}

/* ------------------------------------------------------------------- groups */
group('terminal: prompt and echo', async ({ page }) => {
  await waitText(page, /\(kali㉿kali\)-\[~\]\n└─\$ $/);
  await run(page, 'echo hello');
  assert.match(await text(page), /└─\$ echo hello\nhello\n/);
  assert.equal(await page.evaluate(() => document.activeElement === K.app.term.ta), true, 'the terminal has keyboard focus');
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

/* ------------------------------------------------------------------- runner */
const browser = await chromium.launch();
let failed = 0;
try {
  const page = await open(browser);
  for (const g of groups) {
    if (ONLY && !g.name.includes(ONLY)) continue;
    const t0 = Date.now();
    let error = null;
    try { await g.fn({ page, browser }); } catch (e) { error = e; }
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
