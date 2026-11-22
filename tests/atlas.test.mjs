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

test('kalima scope shows the engagement, the rules in brief and the scope guard', async () => {
  const sim = await boot();
  const { K } = sim;
  const r = await sim.run('kalima scope');
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.match(r.out, /^Engagement HF-LAB-2026-11\nHalcyon Freight internal network assessment/);
  assert.match(r.out, /Client +Halcyon Freight Ltd\. \(fictional\)/);
  assert.match(r.out, /\nIN SCOPE\n {2}10\.10\.10\.0\/24\n {2}\*\.halcyon\.lab\n/);
  assert.match(r.out, /\nOUT OF SCOPE\n {2}Everything else, including the public internet\./);
  assert.equal(r.out.match(/^ {2}\d\. /gm).length, 6, 'six rules, as in rules-of-engagement.txt');
  assert.ok(r.out.includes('~/engagement/rules-of-engagement.txt'));
  assert.ok(r.out.includes('The scope guard is on.'));
  assert.ok(!r.out.includes('Excluded from the ranges'));
  assert.ok(r.out.split('\n').every((l) => l.length <= 80));

  K.settings.scopeGuard = false;
  K.net.world.engagement.exclude = ['10.10.10.99'];
  const off = (await sim.run('kalima scope')).out;
  assert.ok(off.includes('The scope guard is off.'));
  assert.ok(off.includes('Excluded from the ranges above: 10.10.10.99.'));

  const bad = await sim.run('kalima scope now');
  assert.equal(bad.code, 2);
  assert.match(bad.err, /^kalima: scope: too many arguments\n/);
});

test('kalima hosts lists only lab hosts that have answered', async () => {
  const sim = await boot();
  const empty = await sim.run('kalima hosts');
  assert.equal(empty.code, 0);
  assert.match(empty.out, /^No lab host has answered you yet\.\n/);
  assert.ok(empty.out.includes('kalima hosts --all'));

  // dc01 drops ICMP, 10.10.10.99 does not exist, 8.8.8.8 is not a lab host; -n keeps the resolver out of it
  await sim.script(['ping -n -c 1 10.10.10.1', 'ping -n -c 1 -W 1 10.10.10.50', 'ping -n -c 1 -W 1 10.10.10.99', 'ping -n -c 1 8.8.8.8', 'nc -n -z 10.10.10.10 22']);
  const r = await sim.run('kalima hosts');
  assert.match(r.out, /^Lab hosts that have answered you so far: 2\n\n {2}ADDRESS +NAME +OPEN PORTS SEEN\n/);
  assert.match(r.out, /^ {2}10\.10\.10\.1 +gw\.halcyon\.lab +-$/m);
  assert.match(r.out, /^ {2}10\.10\.10\.10 +web01\.halcyon\.lab +22\/tcp$/m);
  for (const absent of ['10.10.10.50', '10.10.10.99', '8.8.8.8', 'kali']) assert.ok(!new RegExp('^ +' + absent.replace(/\./g, '\\.') + ' ', 'm').test(r.out), absent + ' is not listed');

  // a DNS answer counts for the name server, and ports are sorted by number
  await sim.script(['dig +short web01.halcyon.lab', 'nc -n -z 10.10.10.10 443', 'nc -n -z 10.10.10.10 80']);
  const more = (await sim.run('kalima hosts')).out;
  assert.match(more, /^ {2}10\.10\.10\.10 +web01\.halcyon\.lab +22\/tcp 80\/tcp 443\/tcp$/m);
  assert.match(more, /^ {2}10\.10\.10\.53 +ns1\.halcyon\.lab +53\/udp$/m);
  assert.equal((await sim.run('kalima hosts | grep -c halcyon.lab')).out, '3\n');
});

test('kalima hosts --all reveals the whole lab with a spoiler note', async () => {
  const sim = await boot();
  const { K } = sim;
  await sim.run('ping -n -c 1 10.10.10.60');
  const r = await sim.run('kalima hosts --all');
  assert.equal(r.code, 0);
  assert.match(r.out, /^Spoiler: this is the whole lab/);
  const lab = K.net.hosts.filter((h) => h.id !== 'kali');
  for (const h of lab) assert.ok(r.out.includes(h.ip + ' '), h.ip);
  assert.match(r.out, /^ {2}10\.10\.10\.60 +printer\.halcyon\.lab +printer +yes +-$/m);
  assert.match(r.out, /^ {2}10\.10\.10\.30 +db01\.halcyon\.lab +server +no +-$/m);
  assert.ok(r.out.includes(`1 host of ${lab.length} found.`));
  const addresses = r.out.split('\n').filter((l) => /^ {2}10\./.test(l)).map((l) => +l.trim().split(/\s+/)[0].split('.')[3]);
  assert.deepEqual(addresses, addresses.slice().sort((a, b) => a - b), 'sorted by address');
  assert.equal((await sim.run('kalima hosts -a')).out, r.out);

  for (const [args, msg] of [['-x', "invalid option -- 'x'"], ['--everything', "unrecognized option '--everything'"], ['web01', 'too many arguments']]) {
    const bad = await sim.run('kalima hosts ' + args);
    assert.equal(bad.code, 2);
    assert.equal(bad.err, `kalima: hosts: ${msg}\nTry 'kalima help' for a list of commands.\n`);
  }
});

test('discovered hosts are forgotten on a new boot and tracked again after it', async () => {
  const sim = await boot();
  const { K } = sim;
  await sim.run('ping -n -c 1 10.10.10.1');
  assert.match((await sim.run('kalima hosts')).out, /so far: 1\n/);

  const second = await K.boot({ term: sim.term });
  assert.match((await second.shell.capture('kalima hosts')).out, /^No lab host has answered you yet\./);
  await second.shell.capture('ping -n -c 2 10.10.10.20');
  const r = await second.shell.capture('kalima hosts');
  assert.match(r.out, /so far: 1\n/);
  assert.match(r.out, /^ {2}10\.10\.10\.20 +files01\.halcyon\.lab +-$/m, 'each reply is counted once');
});

test('kalima lessons lists modules and lessons with completion marks', async () => {
  const sim = await boot();
  const { K } = sim;
  const mods = K.lessons.modules;
  const first = mods[0].lessons;
  const r = await sim.run('kalima lessons');
  assert.equal(r.code, 0);
  const total = K.lessons.all().length;
  assert.ok(r.out.startsWith(`Lessons: 0 of ${total} completed (0%)\n`));
  for (const m of mods) assert.ok(r.out.includes(`\n${m.title}  0 of ${m.lessons.length}\n`), m.title);
  assert.equal(r.out.match(/^ {2}\[ \] /gm).length, total);
  assert.ok(r.out.includes(`  [ ] ${first[0].title} (${first[0].minutes} min)\n`));
  assert.ok(r.out.includes('[x] completed   [~] started   [ ] not started'));

  K.lessons.progress.complete(first[0].id);
  K.lessons.progress.stepDone(first[1].id, first[1].steps[0].id);
  const after = (await sim.run('kalima lessons')).out;
  assert.ok(after.includes(`\n${mods[0].title}  1 of ${first.length}\n`));
  assert.ok(after.includes(`  [x] ${first[0].title}`));
  assert.ok(after.includes(`  [~] ${first[1].title}`));
  assert.equal((await sim.run('kalima lessons | grep -c "\\[x\\]"')).out, '2\n', 'one lesson and the legend');
  assert.equal((await sim.run('kalima lessons extra')).code, 2);

  const bare = await boot({ skip: ['50-lessons'] });
  assert.equal((await bare.run('kalima lessons')).out, 'No lesson packs are loaded.\n');
});

test('kalima reset asks before it restarts the simulator', async () => {
  const sim = await boot();
  const { K } = sim;
  const power = [];
  K.events.on('power', (ev) => power.push(ev));

  sim.term.feed('n');
  const no = await sim.type('kalima reset');
  assert.equal(no.code, 1);
  assert.match(no.output, /Your home\s+directory and your lesson progress are kept\.\nRestart now\? \[y\/N\] n\nNothing was reset\.\n$/);
  assert.equal((await sim.type('kalima reset')).code, 1, 'end of input means no');
  assert.deepEqual(power, []);

  sim.term.feed('y');
  const yes = await sim.type('kalima reset');
  assert.equal(yes.code, 0);
  assert.match(yes.output, /Restart now\? \[y\/N\] y\nRestarting the simulator\.\.\.\n$/);
  assert.deepEqual(power, [{ action: 'reset' }]);

  assert.equal((await sim.run('kalima reset --yes')).code, 0);
  assert.equal((await sim.run('echo YES | kalima reset')).code, 0);
  assert.equal((await sim.run('echo maybe | kalima reset')).code, 1);
  assert.equal(power.length, 3);

  const bad = await sim.run('kalima reset --hard');
  assert.equal(bad.code, 2);
  assert.match(bad.err, /^kalima: reset: unrecognized option '--hard'\n/);
  assert.equal(power.length, 3);
});

test('the catalogue maps the Kali toolbox by category', async () => {
  const { K } = await boot();
  const cats = K.atlas.categories;
  assert.deepEqual(cats.map((c) => c.title), [
    'Information Gathering', 'Vulnerability Analysis', 'Web Application Analysis', 'Database Assessment', 'Password Attacks',
    'Wireless Attacks', 'Reverse Engineering', 'Exploitation Tools', 'Sniffing and Spoofing', 'Post Exploitation', 'Forensics',
    'Reporting Tools', 'Social Engineering Tools', 'System and Utilities',
  ]);
  assert.equal(new Set(cats.map((c) => c.id)).size, cats.length);
  for (const c of cats) {
    assert.match(c.id, /^[a-z-]+$/);
    const sentences = c.summary.split(/\. (?=[A-Z])/).length;
    assert.ok(sentences >= 2 && sentences <= 3, `${c.id}: two or three sentences, found ${sentences}`);
  }
  assert.ok(cats.filter((c) => c.summary.includes('NIST SP 800-115')).length >= 8, 'summaries place the phases in a methodology');

  const tools = K.atlas.list();
  assert.ok(tools.length >= 120 && tools.length <= 160, `${tools.length} entries`);
  assert.equal(new Set(tools.map((t) => t.name)).size, tools.length);
  for (const t of tools) {
    assert.deepEqual(Object.keys(t).sort(), ['category', 'installed', 'name', 'pkg', 'summary', 'url'], t.name);
    assert.match(t.name, /^[A-Za-z0-9][A-Za-z0-9._+-]*$/, t.name);
    assert.match(t.pkg, /^[a-z0-9][a-z0-9.+-]+$/, t.name);
    assert.ok(cats.some((c) => c.id === t.category), t.name);
    assert.equal(typeof t.installed, 'boolean', t.name);
    assert.match(t.url, /^https:\/\/(www\.kali\.org\/tools\/[a-z0-9.+-]+\/|manpages\.debian\.org\/[A-Za-z0-9._+-]+)$/, t.name);
    // one neutral sentence, and nothing that reads like usage: no options, commands or examples
    assert.ok(/^[A-Z]/.test(t.summary) && !/[.!?;:]( |$)/.test(t.summary), t.name);
    assert.ok(t.summary.length >= 10 && t.summary.length <= 100, t.name);
    assert.ok(!/(^|\s)--?[a-z]|[`$|<>]|\b(usage|example|e\.g\.|run|type|use it)\b/i.test(t.summary), t.name);
  }
  for (const c of cats) assert.ok(tools.filter((t) => t.category === c.id).length >= 5, c.id);
  assert.equal(K.atlas.get('nmap').pkg, 'nmap');
  assert.equal(K.atlas.get('gobuster').installed, false);
  assert.equal(K.atlas.get('hydra').installed, true);
});

test('whether a tool is simulated is worked out when asked', async () => {
  const sim = await boot();
  const { K } = sim;
  assert.equal(K.atlas.isSimulated('nmap'), true);
  assert.equal(K.atlas.isSimulated('hydra'), false);
  assert.equal(K.atlas.isSimulated('no-such-tool'), false);
  // catalogue packages agree with the commands that are simulated
  for (const t of K.atlas.list().filter((x) => K.atlas.isSimulated(x.name))) assert.equal(t.pkg, K.cmd.get(t.name).pkg, t.name);

  assert.match((await sim.run('kalima atlas hydra')).out, /In this build +not simulated/);
  K.cmd.register({ name: 'hydra', pkg: 'hydra', summary: 'test double', run() { return 0; } });
  assert.equal(K.atlas.isSimulated('hydra'), true);
  assert.match((await sim.run('kalima atlas hydra')).out, /In this build +simulated; man hydra/);
});

test('kalima atlas gives an overview of the categories', async () => {
  const sim = await boot();
  const { K } = sim;
  const r = await sim.run('kalima atlas');
  assert.equal(r.code, 0);
  const tools = K.atlas.list();
  const simulated = tools.filter((t) => K.atlas.isSimulated(t.name)).length;
  assert.ok(r.out.startsWith(`Kali tool atlas\nA map of the toolbox: ${tools.length} tools in 14 categories, ${simulated} of them simulated in this\n`));
  for (const c of K.atlas.categories) {
    const mine = tools.filter((t) => t.category === c.id);
    const sim1 = mine.filter((t) => K.atlas.isSimulated(t.name)).length;
    assert.match(r.out, new RegExp(`^  ${c.id} +${mine.length} +${sim1} +${c.title}$`, 'm'), c.id);
  }
  assert.ok(r.out.includes('kalima atlas TOOL'));
  assert.equal((await sim.run('kalima atlas | grep -cE "^  [a-z-]+ +[0-9]+ +[0-9]+ "')).out, '14\n', 'one line per category');
  assert.match((await sim.run('kalima status')).out, new RegExp(`Tool atlas +${tools.length} tools catalogued, ${simulated} of them simulated`));
});

test('kalima atlas CATEGORY lists the tools of a category', async () => {
  const sim = await boot();
  const { K } = sim;
  const r = await sim.run('kalima atlas web-application-analysis');
  assert.equal(r.code, 0);
  assert.match(r.out, /^Web Application Analysis {2}\d+ tools, \d+ simulated\n {2}Examining web sites/);
  assert.match(r.out, /^ {2}TOOL +SIMULATED +DEFAULT +WHAT IT IS$/m);
  assert.match(r.out, /^ {2}whatweb +yes +yes +Next generation web scanner/m);
  assert.match(r.out, /^ {2}gobuster +no +no +Discovery tool/m);
  assert.match(r.out, /^ {2}burpsuite +no +yes +Integrated platform/m);
  assert.ok(r.out.includes('kali-linux-default'));
  for (const t of K.atlas.list().filter((x) => x.category === 'web-application-analysis')) assert.ok(r.out.includes(`\n  ${t.name} `), t.name);
  assert.ok(!r.out.includes('\n  nmap '), 'tools of other categories are left out');

  // a unique beginning of the id or the title, in any case
  for (const word of ['web', 'WEB', 'Web Application Analysis', 'web-app']) assert.equal((await sim.run(`kalima atlas '${word}'`)).out, r.out, word);
  assert.match((await sim.run('kalima atlas forensics')).out, /^Forensics {2}/);
  assert.match((await sim.run('kalima atlas sys')).out, /^System and Utilities {2}/);
  assert.equal((await sim.run('kalima atlas info | grep -c " yes  *yes "')).out.trim(), String(K.atlas.list().filter((t) => t.category === 'information-gathering' && K.atlas.isSimulated(t.name) && t.installed).length));

  for (const c of K.atlas.categories) {
    const out = (await sim.run('kalima atlas ' + c.id)).out;
    assert.ok(out.split('\n').every((l) => l.length <= 80 && !/\s$/.test(l)), c.id + ' fits 80 columns');
  }
});

test('kalima atlas TOOL shows one entry, and says so when nothing matches', async () => {
  const sim = await boot();
  const nmap = await sim.run('kalima atlas nmap');
  assert.equal(nmap.code, 0);
  assert.equal(nmap.out, [
    'nmap', 'Network exploration tool and security / port scanner.', '',
    '  Category         Information Gathering',
    '  Package          nmap',
    '  Default install  yes, as part of kali-linux-default',
    '  In this build    simulated; man nmap describes what works here',
    '  Reference        https://www.kali.org/tools/nmap/', '',
  ].join('\n'));
  const gobuster = (await sim.run('kalima atlas gobuster')).out;
  assert.match(gobuster, /Default install +no; Kali adds it with: sudo apt install gobuster/);
  assert.match(gobuster, /In this build +not simulated/);
  assert.match((await sim.run('kalima atlas theharvester')).out, /^theHarvester\n/, 'tool names match in any case');
  assert.match((await sim.run('kalima atlas ssh')).out, /Reference +https:\/\/manpages\.debian\.org\/ssh\n/);

  const vague = await sim.run('kalima atlas re');
  assert.equal(vague.code, 1);
  assert.equal(vague.err, "kalima: atlas: 're' could be any of these categories: reverse-engineering, reporting-tools\n");
  const near = await sim.run('kalima atlas smb');
  assert.equal(near.code, 1);
  assert.equal(near.out, '');
  assert.equal(near.err, "kalima: atlas: no category or tool named 'smb'\nTools with a similar name: smbmap, smbclient\n");
  assert.equal((await sim.run('kalima atlas zzz')).err, "kalima: atlas: no category or tool named 'zzz'\nRun 'kalima atlas' for the list of categories.\n");
  assert.equal((await sim.run('kalima atlas nmap hydra')).code, 2);
  assert.equal((await sim.run('kalima atlas --list')).err, "kalima: atlas: unrecognized option '--list'\nTry 'kalima help' for a list of commands.\n");

  const words = sim.K.cmd.get('kalima').complete({ words: ['kalima', 'atlas', ''], index: 2, cur: '' });
  for (const w of ['forensics', 'password-attacks', 'nmap', 'hydra']) assert.ok(words.includes(w), w);
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
  assert.deepEqual(def.complete({ words: ['kalima', 'hosts', ''], index: 2, cur: '' }), ['--all']);
  assert.deepEqual(def.complete({ words: ['kalima', 'status', ''], index: 2, cur: '' }), []);
  for (const sub of def.complete({ words: ['kalima', ''], index: 1, cur: '' })) {
    assert.ok(man.out.includes(`\n       ${sub}`), `man page documents ${sub}`);
    assert.notEqual((await sim.run(`kalima ${sub} --bogus-option`)).code, 70, `${sub} survives a bad argument`);
  }
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

test('a tool nobody simulates is a stub that says so honestly', async () => {
  const sim = await boot();
  const { K } = sim;
  assert.equal(K.cmd.get('hydra').stub, true);
  const run = await sim.run('hydra -l admin 10.10.10.10');
  assert.equal(run.code, 1);
  assert.match(run.err, /not simulate/);
  assert.match(run.err, /kalima atlas hydra/);
  const help = await sim.run('hydra --help');
  assert.equal(help.code, 0);
  assert.match(help.out, /Password Attacks/);
  assert.equal((await sim.run('hydra -h')).code, 0);
  assert.equal((await sim.run('hydra --help | grep -c atlas')).out.trim(), '1');
});
