// Atlas pack: the kalima control command, help, the Kali tool catalogue and stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

test('kalima and kalima help print the overview', async () => {
  const sim = await boot();
  const bare = await sim.run('kalima');
  const help = await sim.run('kalima help');
  assert.equal(bare.code, 0);
  assert.equal(bare.out, help.out);
  assert.equal(help.err, '');
  assert.match(help.out, /^Kalima \d+\.\d+\.\d+\nAn offline training simulator for Kali GNU\/Linux 2026\.3\.\n/);
  for (const part of ['LEARNING', 'Free practice', '~/engagement', 'rules-of-engagement.txt', 'COMMANDS', 'kalima status', 'man COMMAND', 'KEYS', 'Ctrl-C']) {
    assert.ok(help.out.includes(part), 'overview mentions ' + part);
  }
  assert.ok(help.out.split('\n').every((l) => l.length <= 80), 'fits an 80 column terminal');
  assert.ok(!/\x1b\[/.test(help.out), 'no colour when captured');
});

test('kalima output is coloured on a terminal and wraps to its width', async () => {
  const sim = await boot({ cols: 60 });
  sim.term.take();
  assert.equal(await sim.shell.runLine('kalima help'), 0);
  const raw = sim.term.take();
  assert.match(raw, /\x1b\[1mLEARNING\x1b\[22m/);
  const tooLong = sim.strip(raw).split('\n').filter((l) => l.length > 60);
  assert.deepEqual(tooLong, [], 'wrapped to 60 columns');
});

test('kalima --help, --version and bad invocations', async () => {
  const sim = await boot();
  const h = await sim.run('kalima --help');
  assert.equal(h.code, 0);
  assert.match(h.out, /^Usage: kalima \[COMMAND\] \[ARGUMENT\]\.\.\.\n/);
  assert.equal((await sim.run('kalima -h')).out, h.out);
  assert.equal((await sim.run('kalima --version')).out, `kalima ${sim.K.version}\n`);
  assert.equal((await sim.run('kalima -V')).out, `kalima ${sim.K.version}\n`);

  const bad = await sim.run('kalima frobnicate');
  assert.equal(bad.code, 2);
  assert.equal(bad.out, '');
  assert.equal(bad.err, "kalima: unknown command 'frobnicate'\nTry 'kalima help' for a list of commands.\n");
  assert.equal((await sim.run('kalima --frob')).err, "kalima: unrecognized option '--frob'\nTry 'kalima help' for a list of commands.\n");
  assert.equal((await sim.run('kalima -x')).err, "kalima: invalid option -- 'x'\nTry 'kalima help' for a list of commands.\n");
  assert.equal((await sim.run('kalima toString')).code, 2, 'object prototype names are not commands');
});

test('kalima status reports the release, speed and lesson progress', async () => {
  const sim = await boot();
  const { K } = sim;
  const r = await sim.run('kalima status');
  assert.equal(r.code, 0);
  assert.match(r.out, /Simulating\s+Kali GNU\/Linux Rolling 2026\.3 \(kali-rolling\)\n/);
  assert.ok(r.out.includes(K.distro.kernel));
  assert.match(r.out, /Machine\s+kali, 10\.10\.10\.5\/24 on eth0/);
  assert.match(r.out, /Engagement\s+HF-LAB-2026-11, scope 10\.10\.10\.0\/24 and \*\.halcyon\.lab/);
  assert.match(r.out, /Simulated time\s+real time \(time scale 1\)/);
  assert.match(r.out, /Scope guard\s+on/);
  const s = K.lessons.progress.summary();
  assert.ok(s.total > 0);
  assert.ok(r.out.includes(`0 of ${s.total} completed (0%)`));

  K.lessons.progress.complete(K.lessons.all()[0].lesson.id);
  assert.ok((await sim.run('kalima status')).out.includes(`1 of ${s.total} completed`));
  // status is plain text, so it can be filtered like any other output
  assert.match((await sim.run('kalima status | grep -c .')).out, /^\d+\n$/);
});

test('kalima speed reads and sets the time scale', async () => {
  const sim = await boot();
  const { K } = sim;
  const seen = [];
  K.events.on('settings', (s) => seen.push(s.timeScale));

  const show = await sim.run('kalima speed');
  assert.equal(show.code, 0);
  assert.match(show.out, /^Simulated time: real time \(time scale 1\)\n/);
  assert.match(show.out, /^\* realtime  1 {5}waits take as long as on a real system$/m);
  assert.match(show.out, /^ {2}fast {6}0\.25 {2}waits are four times shorter$/m);

  assert.equal((await sim.run('kalima speed fast')).out, 'Simulated time: fast (time scale 0.25)\n');
  assert.equal(K.settings.timeScale, 0.25);
  assert.match((await sim.run('kalima speed')).out, /^\* fast /m);
  await sim.run('kalima speed instant');
  assert.equal(K.settings.timeScale, 0);
  assert.equal((await sim.run('kalima speed 0.5')).out, 'Simulated time: custom (time scale 0.5)\n');
  assert.equal(K.settings.timeScale, 0.5);
  await sim.run('kalima speed REALTIME');
  assert.equal(K.settings.timeScale, 1);
  assert.deepEqual(seen, [0.25, 0, 0.5, 1]);

  for (const bad of ['warp', '-1', '11', '1e3', 'NaN']) {
    const r = await sim.run(`kalima speed ${bad}`);
    assert.equal(r.code, 2, bad);
    assert.equal(r.err, `kalima: speed: invalid time scale '${bad}'\nUse realtime, fast, instant or a number from 0 to 10.\n`);
  }
  assert.equal(K.settings.timeScale, 1, 'a rejected value changes nothing');
  assert.equal((await sim.run('kalima speed fast now')).code, 2);
});

test('kalima about says what is simulated and that the lab is fictional', async () => {
  const sim = await boot();
  const r = await sim.run('kalima about');
  assert.equal(r.code, 0);
  for (const part of ['SIMULATED', 'NOT SIMULATED', 'FICTIONAL', 'Halcyon Freight Ltd., its hosts, people', 'No packet ever leaves this page', 'written authorization']) {
    assert.ok(r.out.includes(part), 'about mentions ' + part);
  }
  assert.match(r.out, /- \d+ commands that print what the real programs print/);
  assert.ok(r.out.split('\n').every((l) => l.length <= 80));
});

test('kalima has a manual page, a binary on the Kali box only, and completion', async () => {
  const sim = await boot();
  const { K } = sim;
  assert.equal((await sim.run('which kalima')).out, '/usr/bin/kalima\n');
  const man = await sim.run('man kalima');
  assert.equal(man.code, 0);
  assert.match(man.out, /^KALIMA\(1\)/);
  assert.match(man.out, /kalima - control and explore the Kalima training simulator/);
  assert.match(man.out, /\nCOMMANDS\n/);
  assert.match(man.out, /\nEXAMPLES\n/);

  const def = K.cmd.get('kalima');
  assert.equal(def.only, 'kali');
  assert.ok(def.complete({ words: ['kalima', ''], index: 1, cur: '' }).includes('status'));
  assert.deepEqual(def.complete({ words: ['kalima', 'speed', ''], index: 2, cur: '' }), ['realtime', 'fast', 'instant']);
});

test('help points to kalima help, man and --help', async () => {
  const sim = await boot();
  const r = await sim.run('help');
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.match(r.out, /^zsh has no help builtin\./);
  for (const part of ['kalima help', 'man COMMAND', 'COMMAND --help']) assert.ok(r.out.includes(part));
  assert.equal((await sim.run('help | wc -l')).out.trim(), '5');
});
