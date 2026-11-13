// Test harness: evaluates every src/js/*.js file (in filename order), exactly as
// the browser loads them, and boots a headless simulator.
//
//   import { boot } from './harness.mjs';
//   const sim = await boot();
//   const r = await sim.run('echo hello | tr a-z A-Z');   // { code, out, err, output }
//   sim.term.feed('kali');                                // queue terminal input (passwords, prompts)
//
// Time is virtual: ctx.sleep() returns immediately and advances K.clock, so
// tests never wait. The network jitter generator is seeded, so output is stable.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SRC = path.join(here, '..', 'src', 'js');

export function sourceFiles() {
  return fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();
}

/** Load the simulator sources into a new context and return its K namespace. */
export function load(opts = {}) {
  // Sources run in the main context (so arrays/objects they create compare equal
  // with assert.deepEqual). Each load() evaluates the files again and gets its
  // own fresh K; earlier simulators keep working because every file captured
  // its K when it was evaluated.
  globalThis.K = undefined;
  const failed = [];
  for (const f of sourceFiles()) {
    if (opts.skip && opts.skip.some((s) => f.includes(s))) continue;
    if (f.includes('-ui-') && !opts.ui) continue; // UI files need a DOM
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    try {
      vm.runInThisContext(code, { filename: path.join(SRC, f) });
    } catch (e) {
      failed.push({ file: f, error: e });
      if (!opts.quiet) console.error(`[harness] failed to load ${f}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : e}`);
    }
  }
  const K = globalThis.K;
  K._loadFailures = failed;
  return K;
}

/** Boot a headless simulator with virtual time. */
export async function boot(opts = {}) {
  const K = load(opts);
  K.clock.useVirtual(opts.now);
  K.net.seed(opts.seed || 'test');
  const term = new K.HeadlessTerm({ cols: opts.cols || 80, rows: opts.rows || 24 });
  const { machine, shell } = await K.boot({ term });
  const sim = {
    K, machine, shell, term,
    /** run a line in the Kali shell and capture output: { code, out, err, output } */
    run: (line, o) => shell.capture(line, o),
    /** run a line as the interactive terminal would (history, lesson events); returns { code, output } */
    async type(line) {
      term.take();
      const code = await shell.runLine(line);
      return { code, output: K.util.stripAnsi(term.take()) };
    },
    /** run several lines in order, returning the last result */
    async script(lines) { let r; for (const l of lines) r = await sim.run(l); return r; },
    strip: (s) => K.util.stripAnsi(s),
  };
  return sim;
}
