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

/* ------------------------------------------------------------------- groups */
group('terminal: prompt and echo', async ({ page }) => {
  await waitText(page, /\(kali㉿kali\)-\[~\]\n└─\$ $/);
  await run(page, 'echo hello');
  assert.match(await text(page), /└─\$ echo hello\nhello\n/);
  assert.equal(await page.evaluate(() => document.activeElement === K.app.term.ta), true, 'the terminal has keyboard focus');
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
