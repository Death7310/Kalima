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

async function open(browser, o = {}) {
  const context = o.context || await browser.newContext({ viewport: o.viewport || { width: 1280, height: 800 }, hasTouch: !!o.touch, isMobile: !!o.touch });
  const page = await context.newPage();
  watch(page);
  await page.goto(URL);
  await page.waitForFunction(() => window.K && K.app && K.app.booted);
  await page.evaluate(installFixtures);
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
  assert.equal(await page.evaluate(() => document.activeElement === K.app.term.ta), true);
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
    }
  }
} finally {
  await browser.close();
}
console.log('# ' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
