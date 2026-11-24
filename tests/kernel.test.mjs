// Kernel tests: shell language, filesystem permissions, network engine, lesson checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

// A few tiny commands so the kernel can be tested without any command pack.
async function kernelSim() {
  const sim = await boot();
  const { K, machine } = sim;
  const add = (def) => { K.cmd.register(def); machine.installCommand(K.cmd.get(def.name)); };
  if (!K.cmd.has('cat') || process.env.KERNEL_STUBS) {
    add({ name: 'cat', run(ctx) { if (!ctx.args.length) { ctx.out(ctx.stdin || ''); return 0; } let st = 0; for (const a of ctx.args) { try { ctx.out(ctx.fs.read(a)); } catch (e) { ctx.err(`cat: ${a}: ${e.message}\n`); st = 1; } } return st; } });
  }
  add({ name: 'k-upper', run(ctx) { ctx.out((ctx.stdin || '').toUpperCase()); return 0; } });
  add({ name: 'k-args', run(ctx) { ctx.out(ctx.args.map((a) => `<${a}>`).join('') + '\n'); return 0; } });
  add({ name: 'k-sleep', async run(ctx) { await ctx.sleep(parseFloat(ctx.args[0] || '1') * 1000); ctx.out('slept\n'); return 0; } });
  add({ name: 'k-ask', async run(ctx) { const a = await ctx.readLine('name? '); ctx.out(`hi ${a}\n`); return a == null ? 1 : 0; } });
  add({ name: 'k-whoami', run(ctx) { ctx.out(ctx.user.name + ' ' + ctx.user.uid + '\n'); return 0; } });
  return sim;
}

test('quoting and expansion', async () => {
  const sim = await kernelSim();
  const out = async (l) => (await sim.run(l)).out;
  assert.equal(await out('k-args "" \'\' a"b c"d $NOPE "$NOPE"'), '<><><ab cd><>\n');
  assert.equal(await out('X="a  b"; k-args $X "$X"'), '<a  b><a  b>\n', 'zsh does not word-split unquoted variables');
  assert.equal(await out('k-args $(echo "a  b") "$(echo "a  b")"'), '<a><b><a  b>\n', 'command substitution is split');
  assert.equal(await out('set -- one "two three"; k-args "$@"; k-args "$#"'), '<one><two three>\n<2>\n');
  assert.equal(await out("echo 'single $HOME' \"double $USER\" \\$HOME"), 'single $HOME double kali $HOME\n');
  assert.equal(await out('echo $((2+3*4)) $(( (2+3)*4 )) $((10/3)) $((2**10)) $((7%3))'), '14 20 3 1024 1\n');
  assert.equal(await out('echo {a,b}{1,2} {3..1} pre{x,y}post'), 'a1 a2 b1 b2 3 2 1 prexpost preypost\n');
  assert.equal(await out('V=hello; echo ${V^^} ${#V} ${V:1:3} ${V/l/L} ${V//l/L} ${UNSET:-dflt} ${V:+alt}'), 'HELLO 5 ell heLlo heLLo dflt alt\n');
  assert.equal(await out('F=/a/b/c.tar.gz; echo ${F##*/} ${F%/*} ${F%%.*} ${F#*.}'), 'c.tar.gz /a/b /a/b/c tar.gz\n');
  assert.equal(await out("echo $'tab\\there'"), 'tab\there\n');
  assert.equal(await out('echo "a" # comment'), 'a\n');
});

test('globbing', async () => {
  const sim = await kernelSim();
  await sim.run('mkdir_ok=1; cd /tmp; echo x > a.txt; echo y > b.txt; echo z > c.log; echo h > .hidden');
  assert.equal((await sim.run('cd /tmp; echo *.txt')).out, 'a.txt b.txt\n');
  assert.equal((await sim.run('cd /tmp; echo ?.log [ab].txt')).out, 'c.log a.txt b.txt\n');
  assert.equal((await sim.run('cd /tmp; echo *')).out, 'a.txt b.txt c.log\n', 'dotfiles are not matched by *');
  assert.equal((await sim.run('cd /tmp; echo .h*')).out, '.hidden\n');
  assert.equal((await sim.run('echo /tmp/*.txt')).out, '/tmp/a.txt /tmp/b.txt\n');
  assert.equal((await sim.run('echo /tmp/*.nomatch "*.txt"')).out, '/tmp/*.nomatch *.txt\n', 'Kali zsh sets nonomatch');
});

test('pipelines, redirection, status', async () => {
  const sim = await kernelSim();
  assert.equal((await sim.run('echo hello | k-upper')).out, 'HELLO\n');
  assert.equal((await sim.run('echo a | k-upper | cat')).out, 'A\n');
  await sim.run('echo one > /tmp/r.txt; echo two >> /tmp/r.txt');
  assert.equal((await sim.run('cat /tmp/r.txt')).out, 'one\ntwo\n');
  assert.equal((await sim.run('cat < /tmp/r.txt | k-upper')).out, 'ONE\nTWO\n');
  assert.equal((await sim.run('cat /nope 2> /tmp/err.txt; echo "st=$?"; cat /tmp/err.txt')).out, 'st=1\ncat: /nope: No such file or directory\n');
  assert.equal((await sim.run('cat /nope 2>/dev/null; echo $?')).output, '1\n');
  assert.equal((await sim.run('cat /nope /tmp/r.txt > /tmp/both.txt 2>&1; cat /tmp/both.txt')).out, 'cat: /nope: No such file or directory\none\ntwo\n');
  assert.equal((await sim.run('cat /nope &> /tmp/all.txt; cat /tmp/all.txt')).out, 'cat: /nope: No such file or directory\n');
  assert.equal((await sim.run('k-upper <<< "here string"')).out, 'HERE STRING\n');
  assert.equal((await sim.run('cat <<EOF\nhome=$HOME\nEOF')).out, 'home=/home/kali\n');
  assert.equal((await sim.run("cat <<'EOF'\nhome=$HOME\nEOF")).out, 'home=$HOME\n');
  const r = await sim.run('echo x > /etc/forbidden');
  assert.equal(r.code, 1);
  assert.match(r.err, /zsh: permission denied: \/etc\/forbidden/);
  assert.equal((await sim.run('true; echo $?; false; echo $?; nosuch 2>/dev/null; echo $?')).out, '0\n1\n127\n');
  assert.equal((await sim.run('false || echo recovered; true && echo chained')).out, 'recovered\nchained\n');
});

test('control flow and functions', async () => {
  const sim = await kernelSim();
  const out = async (l) => (await sim.run(l)).out;
  assert.equal(await out('for i in 1 2 3; do if [ $i -eq 2 ]; then continue; fi; echo $i; done'), '1\n3\n');
  assert.equal(await out('i=0; while true; do i=$((i+1)); [ $i -ge 3 ] && break; done; echo $i'), '3\n');
  assert.equal(await out('until [ -f /tmp/never ]; do echo once; break; done'), 'once\n');
  assert.equal(await out('greet() { local who=$1; echo "hi $who"; }; who=outer; greet kali; echo $who'), 'hi kali\nouter\n');
  assert.equal(await out('case "$HOME" in /root) echo r;; /home/*) echo h;; esac'), 'h\n');
  assert.equal(await out('if false; then echo a; elif true; then echo b; else echo c; fi'), 'b\n');
  assert.equal(await out('[ -d /etc ] && [ ! -f /etc ] && [ -r /etc/passwd ] && [ ! -r /etc/shadow ] && echo perms'), 'perms\n');
  assert.equal(await out('[[ "abc" == a* ]] && echo glob; [ "a" = "a" -a 2 -lt 3 ] && echo and'), 'glob\nand\n');
  const bad = await sim.run('if true; then echo unterminated');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /parse error/);
});

test('scripts, shebangs, source, PATH', async () => {
  const sim = await kernelSim();
  await sim.run("cat > /tmp/s.sh <<'EOF'\n#!/bin/bash\necho \"script $0 args=$# first=$1\"\nexit 7\nEOF");
  let r = await sim.run('/tmp/s.sh a b');
  assert.equal(r.code, 126, 'not executable yet');
  assert.match(r.err, /permission denied/);
  r = await sim.run('bash /tmp/s.sh a b');
  assert.equal(r.out, 'script /tmp/s.sh args=2 first=a\n');
  assert.equal(r.code, 7);
  sim.machine.vfs.chmod('/tmp/s.sh', 0o755);
  r = await sim.run('cd /tmp && ./s.sh x');
  assert.equal(r.out, 'script ./s.sh args=1 first=x\n');
  r = await sim.run('s.sh');
  assert.equal(r.code, 127, 'cwd is not on PATH');
  r = await sim.run('PATH=$PATH:/tmp; s.sh q');
  assert.equal(r.out, 'script /tmp/s.sh args=1 first=q\n');
  await sim.run("echo 'SOURCED=yes' > /tmp/v.sh; source /tmp/v.sh");
  assert.equal((await sim.run('echo $SOURCED')).out, 'yes\n');
  assert.equal((await sim.run('X=1 bash -c \'echo "x=$X"\'; echo "after=$X"')).out, 'x=1\nafter=\n');
});

test('permissions, sudo, su', async () => {
  const sim = await kernelSim();
  let r = await sim.run('cat /etc/shadow');
  assert.match(r.err, /Permission denied/);
  sim.term.feed('kali');
  r = await sim.run('sudo cat /etc/shadow');
  assert.equal(r.code, 0);
  assert.match(r.out, /^root:/);
  assert.match(sim.term.take(), /\[sudo\] password for kali: /);
  r = await sim.run('sudo k-whoami');
  assert.equal(r.out, 'root 0\n', 'sudo timestamp is cached, no second prompt');
  assert.equal(sim.term.take(), '');
  r = await sim.run('sudo -k; sudo k-whoami');
  assert.equal(r.code, 1, 'no password available after -k');
  sim.term.feed('nope', 'nope', 'nope');
  r = await sim.run('sudo k-whoami');
  assert.match(r.err, /3 incorrect password attempts/);
  r = await sim.run('ls_missing_in_root=1; cd /root');
  assert.match(r.err, /cd: permission denied: \/root/);
  // sticky /tmp: another user's file cannot be removed
  sim.machine.vfs.seed('/tmp/rootfile', 'x', { uid: 0, gid: 0, mode: 0o644 });
  assert.throws(() => sim.shell.fs.unlink('/tmp/rootfile'), /Operation not permitted/);
  sim.term.feed('kali');
  r = await sim.run('su -c k-whoami kali');
  assert.equal(r.out, 'kali 1000\n');
});

test('interactive: history, events, jobs, repl', async () => {
  const sim = await kernelSim();
  const { K, shell, term } = sim;
  const events = [];
  K.events.on('command', (e) => events.push(e));
  let r = await sim.type('echo first');
  assert.equal(r.output, 'first\n');
  r = await sim.type('!!');
  assert.equal(r.output, 'echo first\nfirst\n');
  await sim.type('sudo -k; echo done | k-upper');
  assert.equal(events.length, 3);
  assert.deepEqual(events[2].commands.map((c) => c.argv[0]), ['sudo', 'echo', 'k-upper']);
  assert.match(events[2].output, /DONE/);
  assert.match(shell.fs.read('/home/kali/.zsh_history'), /;echo first\n/);
  // background job
  r = await sim.type('k-sleep 5 &');
  assert.match(r.output, /^\[1\] \d+\n/);
  await shell.jobs[0]?.promise;
  r = await sim.type('true');
  assert.match(r.output, /\[1\]  \+ done\s+k-sleep 5/);
  // repl with scripted input, continuation line, and exit
  term.feed('echo "multi', 'line"', 'k-ask', 'ash', 'cd /tmp', 'exit 3');
  term.take();
  const code = await shell.repl();
  assert.equal(code, 3);
  const text = K.util.stripAnsi(term.take());
  assert.match(text, /multi\nline\n/);
  assert.match(text, /name\? ash\nhi ash\n/);
  assert.match(text, /\[\/tmp\]/, 'prompt shows the new directory');
});

test('interrupt aborts a sleeping command', async () => {
  const sim = await kernelSim();
  const { K, shell, term } = sim;
  K.clock.useReal(); K.settings.timeScale = 1;
  const p = shell.runLine('k-sleep 30; echo not-reached');
  setTimeout(() => term.raiseInterrupt(), 20);
  const code = await p;
  assert.equal(code, 130);
  assert.doesNotMatch(term.take(), /not-reached/);
});

test('tab completion', async () => {
  const sim = await kernelSim();
  const c = (l) => sim.shell.complete(l, l.length).items.map((i) => i.text);
  assert.deepEqual(c('k-ar'), ['k-args']);
  assert.ok(c('ec').includes('echo'));
  assert.deepEqual(c('cat /etc/host'), ['/etc/hostname', '/etc/hosts']);
  assert.deepEqual(c('cd ~/Do'), ['~/Documents/', '~/Downloads/']);
  assert.deepEqual(c('cd /etc/ss'), ['/etc/ssh/']);
  assert.ok(c('echo $HO').includes('$HOME'));
  assert.ok(c('sudo k-wh').includes('k-whoami'));
});

test('network engine', async () => {
  const sim = await kernelSim();
  const { K, machine: m } = sim;
  const N = K.net;
  assert.equal(N.ping(m, '10.10.10.10', 1).status, 'reply');
  assert.equal(N.ping(m, '10.10.10.10', 1).ttl, 64);
  assert.equal(N.ping(m, '127.0.0.1', 1).status, 'reply');
  assert.equal(N.ping(m, '10.10.10.50', 1).status, 'timeout', 'Windows host firewall drops ICMP');
  assert.equal(N.ping(m, '10.10.10.77', 1).status, 'unreachable', 'no such host on the local segment');
  assert.equal(N.ping(m, '192.168.99.1', 1).status, 'timeout', 'unrouted private network');
  const g = N.ping(m, '8.8.8.8', 1);
  assert.equal(g.status, 'reply');
  assert.equal(g.ttl, 128 - N.route(m, '8.8.8.8').hops.length);
  assert.equal(N.ping(m, '8.8.8.8', 1, { ttl: 1 }).from, '10.10.10.1', 'TTL 1 expires at the gateway');
  assert.equal(N.tcp(m, '10.10.10.10', 80).state, 'open');
  assert.equal(N.tcp(m, '10.10.10.10', 8081).state, 'closed');
  assert.equal(N.tcp(m, '10.10.10.50', 8081).state, 'filtered');
  assert.equal(N.tcp(m, '10.10.10.70', 5432).state, 'filtered');
  assert.equal(N.udp(m, '10.10.10.53', 53).state, 'open');
  assert.equal(N.tcp(m, '10.10.10.5', 22).state, 'closed', 'nothing listens on Kali by default');
  const off = N.listen(m, { port: 8000, proto: 'tcp', addr: '0.0.0.0', prog: 'python3', http: () => ({ status: 200, body: 'hi' }) });
  assert.equal(N.tcp(m, '10.10.10.5', 8000).state, 'open');
  assert.equal(N.http(m, { url: 'http://127.0.0.1:8000/' }).body, 'hi');
  off();
  assert.equal(N.tcp(m, '10.10.10.5', 8000).state, 'closed');
  // DNS
  assert.equal(N.dns(m, 'web01.halcyon.lab', 'A').answers[0].data, '10.10.10.10');
  assert.deepEqual(N.dns(m, 'www.halcyon.lab', 'A').answers.map((a) => a.type), ['CNAME', 'A']);
  assert.equal(N.dns(m, 'halcyon.lab', 'MX').answers[0].prio, 10);
  assert.equal(N.dns(m, 'missing.halcyon.lab', 'A').status, 'NXDOMAIN');
  assert.equal(N.dns(m, 'web01.halcyon.lab', 'A', { server: '8.8.8.8' }).status, 'NXDOMAIN', 'public resolvers do not know the lab zone');
  assert.equal(N.dns(m, '10.10.10.10.in-addr.arpa', 'PTR').answers[0].data, 'web01.halcyon.lab');
  assert.equal(N.dns(m, 'example.com', 'A').answers[0].data, '93.184.215.14');
  assert.equal(N.dns(m, 'some-site.com', 'A').status, 'NOERROR');
  assert.equal(N.dns(m, 'this.nonexistent.com', 'A').status, 'NXDOMAIN');
  assert.equal(N.dns(m, 'example.com', 'A', { server: '10.10.10.99' }).status, 'TIMEOUT');
  assert.equal(N.axfr(m, 'halcyon.lab', '10.10.10.53').status, 'OK');
  assert.equal(N.axfr(m, 'halcyonfreight.example', '203.0.113.53').status, 'REFUSED');
  assert.equal(N.resolve(m, 'web01').ip, '10.10.10.10', 'search domain is applied');
  assert.equal(N.resolve(m, 'no-such-host'), null);
  m.vfs.write('/etc/hosts', '10.10.10.99 custom.test\n', { append: true });
  assert.equal(N.resolve(m, 'custom.test').source, 'hosts');
  // HTTP
  const res = N.http(m, { url: 'http://web01.halcyon.lab/robots.txt' });
  assert.equal(res.status, 200);
  assert.match(res.body, /Disallow: \/staff\//);
  assert.equal(N.http(m, { url: 'http://web01.halcyon.lab/nope' }).status, 404);
  assert.equal(N.http(m, { url: 'http://10.10.10.70:3000/api/health' }).headers['x-powered-by'], 'Express');
  assert.throws(() => N.http(m, { url: 'http://10.10.10.10:8081/' }), /Connection refused/);
  assert.throws(() => N.http(m, { url: 'http://no-such-host/' }), /Name or service not known/);
  // sessions and banners
  const s = N.connect(m, '10.10.10.40', 25);
  assert.match(s.greeting, /^220 mail01\.halcyon\.lab ESMTP/);
  assert.throws(() => N.connect(m, '10.10.10.10', 23), /Connection refused/);
  // scope
  assert.equal(N.inScope('10.10.10.10'), true);
  assert.equal(N.inScope('8.8.8.8'), false);
  assert.equal(N.inScope('web01.halcyon.lab'), true);
  assert.equal(N.inScope('halcyonfreight.example'), false);
  // packets are observable
  const pk = [];
  const offp = N.bus.on('packet', (p) => pk.push(p));
  N.ping(m, '10.10.10.1', 1);
  offp();
  assert.deepEqual(pk.map((p) => p.proto + ' ' + p.src + '>' + p.dst), ['ICMP 10.10.10.5>10.10.10.1', 'ICMP 10.10.10.1>10.10.10.5']);
  // WAN outage scenario
  N.state.wan = false;
  assert.equal(N.ping(m, '8.8.8.8', 1).status, 'timeout');
  assert.equal(N.ping(m, '10.10.10.1', 1).status, 'reply');
  N.state.wan = true;
});

test('lab host machines', async () => {
  const sim = await kernelSim();
  const { K } = sim;
  const web = K.net.machineFor('web01');
  assert.equal(web.hostname, 'web01');
  assert.equal(web.checkPassword('student', 'student'), true);
  assert.equal(K.net.machineFor('web01'), web, 'machines are created once');
  assert.equal(K.net.machineFor('printer'), null, 'no shell on the printer');
  const sh = new K.Shell({ machine: web, term: sim.term, user: 'student', interactive: true });
  await sh.init();
  assert.equal((await sh.capture('echo $HOME; pwd')).out, '/home/student\n/home/student\n');
  assert.match(K.util.stripAnsi(sh.prompt()), /^student@web01:~\$ $/);
  assert.equal(K.net.ping(web, '10.10.10.5', 1).status, 'reply', 'lab hosts can reach the Kali box');
});

test('lesson checks', async () => {
  const sim = await kernelSim();
  const { K } = sim;
  let last = null;
  K.events.on('command', (e) => { last = e; });
  const ok = (spec) => K.lessons.check(spec, last);
  await sim.type('echo hello | k-upper');
  assert.ok(ok({ cmd: 'k-upper' }));
  assert.ok(ok({ cmd: ['x', 'echo'], args: ['hello'] }));
  assert.ok(ok({ out: /HELLO/, exit: 0 }));
  assert.ok(!ok({ cmd: 'cat' }));
  assert.ok(ok({ any: [{ cmd: 'cat' }, { line: /upper/ }] }));
  assert.ok(!ok({ all: [{ cmd: 'echo' }, { out: /nope/ }] }));
  await sim.type('cd /tmp && echo data > lesson.txt');
  assert.ok(ok({ cwd: '/tmp', file: { path: '/tmp/lesson.txt', contains: /data/ } }));
  assert.ok(!ok({ file: { path: '/tmp/absent.txt' } }));
  assert.ok(ok({ file: { path: '/tmp/absent.txt', exists: false } }));
  sim.term.feed('kali');
  await sim.type('sudo k-whoami');
  assert.ok(ok({ cmd: 'k-whoami', out: /root/ }), 'sudo wrapper is looked through');
  assert.ok(ok({ cmd: 'sudo' }));
  await sim.type('export TARGET=10.10.10.10');
  assert.ok(ok({ env: { TARGET: /^10\.10\.10\.10$/ } }));
  assert.ok(K.lessons.checkAnswer({ answer: ['22', 'ssh'] }, ' SSH '));
  assert.ok(K.lessons.checkAnswer({ answer: /^6[34]$/ }, '64'));
  assert.ok(!K.lessons.checkAnswer({ answer: '80' }, '8080'));
  K.lessons.register({ id: 't', title: 'T', order: 1, lessons: [{ id: 't-1', title: 'one', steps: [] }] });
  assert.equal(K.lessons.get('t-1').module.id, 't');
  assert.equal(K.lessons.progress.stepDone('t-1', 's1'), true);
  assert.equal(K.lessons.progress.stepDone('t-1', 's1'), false);
  K.lessons.progress.complete('t-1');
  assert.ok(K.lessons.progress.isDone('t-1'));
});

test('job specs, lowest free job number, background trace, per-shell tty', async () => {
  const sim = await kernelSim();
  const { K, shell } = sim;
  const events = [];
  K.events.on('command', (e) => events.push(e));
  let r = await sim.type('k-sleep 300 &');
  assert.match(r.output, /^\[1\] \d+\n/);
  assert.deepEqual(events.at(-1).commands.map((c) => c.argv), [['k-sleep', '300']], 'a background-only line is traced');
  assert.equal(events.at(-1).commands[0].background, true);
  await shell.jobs[0].promise;
  // finished but unreported: the number is free again
  r = await sim.type('k-sleep 301 &');
  assert.match(r.output, /^\[1\] \d+\n/);
  await shell.jobs.find((j) => j.text === 'k-sleep 301').promise;
  await sim.type('true');
  // specs
  const s2 = await kernelSim(); const sh = s2.shell;
  s2.K.cmd.register({ name: 'k-hang', run(ctx) { return new Promise((resolve) => ctx.io.sig.onAbort(() => resolve(143))); } });
  s2.machine.installCommand(s2.K.cmd.get('k-hang'));
  await sh.runLine('k-hang one &'); await sh.runLine('k-hang two &');
  r = await s2.run('jobs');
  assert.match(r.out, /\[1\]  - running    k-hang one\n\[2\]  \+ running    k-hang two\n/);
  r = await s2.run('kill %9'); assert.equal(r.err, 'kill: no such job: 9\n');
  r = await s2.run('kill %nope'); assert.equal(r.err, 'kill: job not found: nope\n');
  r = await s2.run('fg %?zzz'); assert.equal(r.err, 'fg: job not found: zzz\n');
  r = await s2.run('kill %-'); assert.equal(r.code, 0);
  await sh.jobs.find((j) => j.id === 1).promise;
  r = await s2.run('jobs'); assert.equal(r.out, '[2]  + running    k-hang two\n');
  r = await s2.run('kill %k-hang'); assert.equal(r.code, 0);
  await sh.jobs.find((j) => j.id === 2).promise;
  r = await s2.run('kill %+'); assert.equal(r.err, 'kill: no current job\n');
  await sh.runLine('k-hang a &'); await sh.runLine('k-hang b &');
  r = await s2.run('kill %?hang'); assert.equal(r.code, 0, 'zsh picks the most recent match');
  // tty option is inherited by processes and child shells
  const K2 = s2.K;
  const t = new K2.Shell({ machine: s2.machine, term: s2.term, user: 'kali', tty: 'pts/3' });
  assert.equal(t.proc.tty, 'pts/3');
  assert.equal(t.fork().proc.tty, 'pts/3');
  assert.equal(t.child().tty, 'pts/3');
  assert.equal(shell.tty, 'pts/0');
});

test('FsView: empty path is ENOENT, hard links count in nlink', async () => {
  const sim = await boot();
  const fs = sim.shell.fs || null;
  const r = await sim.run('cat ""; ls ""; echo x > /tmp/h1; ln /tmp/h1 /tmp/h2; ls -l /tmp/h1 /tmp/h2; rm /tmp/h2; ls -l /tmp/h1');
  assert.equal(r.err, "cat: '': No such file or directory\nls: cannot access '': No such file or directory\n");
  const lines = r.out.trim().split('\n');
  assert.match(lines[0], /^-rw-r--r-- 2 /);
  assert.match(lines[1], /^-rw-r--r-- 2 /);
  assert.match(lines[2], /^-rw-r--r-- 1 /);
});

test('shell review: arrays, readonly, declare, zsh $array expansion', async () => {
  const sim = await kernelSim();
  const out = async (l) => (await sim.run(l)).out;
  assert.equal(await out('a=(x y z); echo ${a[2]} ${#a[@]} $a; for i in $a; do echo "i$i"; done'), 'y 3 x y z\nix\niy\niz\n');
  assert.equal(await out('a+=(w); echo "${a[@]}" "$a"'), 'x y z w x y z w\n');
  assert.equal(await out('declare -A m; m[k]=v; m[j]=w; echo ${m[k]}${m[j]}'), 'vw\n');
  let r = await sim.run('readonly R=1; R=2; echo $R');
  assert.equal(r.err, 'zsh: read-only variable: R\n');
  assert.equal(r.out, '1\n');
  assert.equal((await sim.run("bash -c 'readonly Q=1; Q=2; echo ok'")).err, 'bash: line 1: Q: readonly variable\n');
  assert.equal(await out('declare -p a'), 'typeset -a a=(x y z w)\n');
  // top-level return/break do not escape capture()
  assert.equal((await sim.run('return 3')).code, 3);
  assert.equal((await sim.run('break')).code, 0);
});

test('shell review: scripts, set options, trap, let, getopts, read', async () => {
  const sim = await kernelSim();
  const b = async (src, ...args) => { sim.shell.fs.write('/tmp/rv.sh', src); return sim.run(['bash /tmp/rv.sh', ...args].join(' ')); };
  // empty "$@" expands to nothing
  assert.equal((await b('for a in "$@"; do echo "- $a"; done\necho n=$#\n')).out, 'n=0\n');
  assert.equal((await b('for a in "$@"; do echo "- $a"; done\n', 'a', '"b c"')).out, '- a\n- b c\n');
  // set -e stops the script, set -u is fatal, pipefail, nullglob
  assert.deepEqual((({ out, code }) => ({ out, code }))(await b('set -e\necho start\nfalse\necho no\n')), { out: 'start\n', code: 1 });
  let r = await sim.run('bash -c \'set -u; echo $nope; echo no\'');
  assert.equal(r.out, ''); assert.equal(r.err, 'bash: line 1: nope: unbound variable\n'); assert.equal(r.code, 1);
  assert.equal((await sim.run("bash -c 'false | true; echo $?; set -o pipefail; false | true; echo $?'")).out, '0\n1\n');
  assert.equal((await sim.run("bash -c 'shopt -s nullglob; echo /tmp/*.nomatch; echo done'")).out, '\ndone\n');
  // trap EXIT runs when the script ends, also after exit
  assert.equal((await b('trap "echo cleanup" EXIT\necho body\nexit 3\n')).out, 'body\ncleanup\n');
  // let, base#, printf %q
  assert.equal((await sim.run("bash -c 'let y=3+4; echo $y $((2#101)) $((16#ff))'")).out, '7 5 255\n');
  assert.equal((await sim.run('printf "%q|%q\\n" "a b" "x*y"')).out, 'a\\ b|x\\*y\n');
  // getopts loop terminates and reports bad options
  r = await sim.run("bash -c 'while getopts \"ab:\" o; do echo \"o=$o $OPTARG\"; done; echo idx=$OPTIND' _ -a -b val -z");
  assert.equal(r.out, 'o=a \no=b val\no=? \nidx=5\n');
  assert.equal(r.err, '_: illegal option -- z\n');
  // read honours IFS, -a, and keeps the remainder in the last variable
  assert.equal((await sim.run("bash -c 'IFS=: read a b <<< \"1:2:3\"; echo $a-$b; read x y <<< \"  p   q  r \"; echo [$x][$y]'")).out, '1-2:3\n[p][q r]\n');
  assert.equal((await sim.run("bash -c 'read -a arr <<< \"a b c\"; echo ${#arr[@]} ${arr[1]}'")).out, '3 b\n');
  // BASH_REMATCH
  assert.equal((await sim.run("bash -c 'if [[ abc =~ ^a(.)c$ ]]; then echo ${BASH_REMATCH[1]}; fi'")).out, 'b\n');
});

test('shell review: script errors run earlier lines and carry line numbers', async () => {
  const sim = await kernelSim();
  sim.shell.fs.write('/tmp/e1.sh', 'echo hi\nfoo\ncd /nonexist\nls /nonexist\n');
  let r = await sim.run('bash /tmp/e1.sh');
  assert.equal(r.out, 'hi\n');
  assert.match(r.err, /^\/tmp\/e1\.sh: line 2: foo: command not found\n\/tmp\/e1\.sh: line 3: cd: \/nonexist: No such file or directory\n/);
  sim.shell.fs.write('/tmp/e2.sh', 'echo one\necho "oops\necho two\n');
  r = await sim.run('bash /tmp/e2.sh');
  assert.equal(r.out, 'one\n');
  assert.match(r.err, /unexpected EOF while looking for matching `"'/);
  r = await sim.run('zsh /tmp/e1.sh');
  assert.match(r.err, /^\/tmp\/e1\.sh:2: command not found: foo\n\/tmp\/e1\.sh:3: cd: no such file or directory: \/nonexist\n/);
  assert.equal((await sim.run("bash -c 'foo'")).err, 'bash: line 1: foo: command not found\n');
  assert.equal((await sim.run("bash -c 'cd /nonexist'")).err, 'bash: line 1: cd: /nonexist: No such file or directory\n');
  assert.equal((await sim.run('cd /nonexist')).err, 'cd: no such file or directory: /nonexist\n');
});

test('shell review: type, bg, dirs, pushd, popd', async () => {
  const sim = await kernelSim();
  const out = async (l) => (await sim.run(l)).out;
  assert.equal(await out('type -a ls'), 'ls is an alias for ls --color=auto\nls is /usr/bin/ls\nls is /bin/ls\n');
  assert.equal(await out('type -t ls cd if'), 'alias\nbuiltin\nkeyword\n');
  assert.equal((await sim.run('type nope')).out, 'nope not found\n');
  assert.equal((await sim.run("bash -c 'type nope'")).err, 'bash: line 1: type: nope: not found\n');
  // bg with no job and with a running job
  assert.equal((await sim.run('bg')).err, 'bg: no current job\n');
  sim.K.cmd.register({ name: 'k-hang2', run(ctx) { return new Promise((resolve) => ctx.io.sig.onAbort(() => resolve(143))); } });
  sim.machine.installCommand(sim.K.cmd.get('k-hang2'));
  await sim.shell.runLine('k-hang2 &');
  const r = await sim.run('bg %1');
  assert.equal(r.err, 'bg: job already in background\n'); assert.equal(r.code, 1);
  await sim.run('kill %1'); await sim.shell.jobs[0].promise;
  // directory stack
  assert.equal(await out('cd /tmp; pushd /etc; pushd /var; dirs'), '/etc /tmp\n/var /etc /tmp\n/var /etc /tmp\n');
  assert.equal(await out('popd; pwd'), '/etc /tmp\n/etc\n');
  assert.equal((await sim.run('cd /; dirs -c; popd')).err, 'popd: directory stack empty\n');
});

test('shell review: history expansion', async () => {
  const sim = await kernelSim();
  const t = async (l) => (await sim.type(l)).output;
  await t('echo one two three');
  assert.equal(await t('echo !$ !^ !*'), 'echo three one one two three\nthree one one two three\n');
  assert.equal(await t('!1'), 'echo one two three\none two three\n');
  assert.equal(await t('!echo:p'), 'echo one two three\n');
  assert.equal(await t('!?two?:s/two/2/'), 'echo one 2 three\none 2 three\n');
  assert.equal(await t('echo a b c'), 'a b c\n');
  assert.equal(await t('echo !!:2 !-1:$'), 'echo b c\nb c\n');
  assert.equal(await t('^b^X'), 'echo X c\nX c\n');
  assert.equal(await t('!nonexistent'), 'zsh: event not found: nonexistent\n');
  assert.equal(await t('echo "hi!"; echo hi! there'), 'hi!\nhi! there\n');
});

test('shell review: continuation prompts in the repl (here-documents, quotes, operators)', async () => {
  const sim = await kernelSim();
  const { term, shell, K } = sim;
  term.feed("cat > /tmp/hd.txt <<'EOF'", 'one $HOME', 'two', 'EOF', 'cat /tmp/hd.txt',
    'echo "a', 'b"', 'echo x &&', 'echo y', 'if true; then', 'echo z', 'fi', 'echo p |', 'k-upper', 'exit');
  term.take();
  await shell.repl();
  const text = K.util.stripAnsi(term.take());
  assert.match(text, /heredoc> one \$HOME\nheredoc> two\nheredoc> EOF\n/);
  assert.match(text, /one \$HOME\ntwo\n/);
  assert.match(text, /dquote> b"\na\nb\n/);
  assert.match(text, /cmdand> echo y\nx\ny\n/);
  assert.match(text, /then> echo z\nthen> fi\nz\n/);
  assert.match(text, /pipe> k-upper\nP\n/);
  assert.equal(shell.fs.read('/tmp/hd.txt'), 'one $HOME\ntwo\n');
});

test('shell review: zsh scripts fail on unmatched globs, Kali interactive zsh and bash do not', async () => {
  const sim = await kernelSim();
  const z = async (src) => { sim.shell.fs.write('/tmp/ng.zsh', src); return sim.run('zsh /tmp/ng.zsh'); };
  let r = await z('echo *.nomatch\necho after\n');
  assert.equal(r.err, '/tmp/ng.zsh:1: no matches found: *.nomatch\n'); assert.equal(r.out, 'after\n');
  r = await z('for f in *.zz; do echo $f; done\n');
  assert.equal(r.err, '/tmp/ng.zsh:1: no matches found: *.zz\n');
  assert.equal((await z('echo "*.x" a\\*\nX="*.zz"; echo $X\n[[ abc == a* ]] && echo yes\n')).out, '*.x a*\n*.zz\nyes\n');
  assert.equal((await sim.run('echo *.nomatch')).out, '*.nomatch\n', 'Kali .zshrc sets nonomatch');
  assert.equal((await sim.run('bash -c "echo *.zz"')).out, '*.zz\n');
  // [[ never globs its operands
  assert.equal((await sim.run('cd /etc; [[ passwd == pass* ]] && echo yes')).out, 'yes\n');
});

test('net: a secondary address of the machine itself answers locally', async () => {
  const sim = await boot();
  sim.machine.ifaces.find((i) => i.name === 'eth0').secondary = [{ ip: '10.10.10.99', bits: 24 }];
  const rt = sim.K.net.route(sim.machine, '10.10.10.99');
  assert.equal(rt.ok && rt.self, true);
});

test('shell review: sudo with no command prints usage, -n never prompts', async () => {
  const sim = await kernelSim();
  let r = await sim.run('sudo');
  assert.match(r.err, /^usage: sudo -h \| -K \| -k \| -V\n/); assert.equal(r.code, 1);
  r = await sim.run('sudo -n true');
  assert.equal(r.err, 'sudo: a password is required\n'); assert.equal(r.code, 1);
  sim.machine.sudoStamp.kali = sim.K.clock.now();
  assert.equal((await sim.run('sudo -n id -u')).out, '0\n');
});

test('shell review: arithmetic assignment operators, heredoc backticks, fatal ${x:?}', async () => {
  const sim = await kernelSim();
  const out = async (l) => (await sim.run(l)).out;
  assert.equal(await out('x=10; ((x-=3)); ((x*=2)); echo $x $((x/=4)) $((x%=2)) $((x<<=3)) $((++x)) $((--x)) $x'), '14 3 1 8 9 8 8\n');
  assert.equal(await out('echo $((4--1)) $((3-1)) $((2*-3)) $((a=5, a*2))'), '5 2 -6 10\n');
  assert.equal(await out('until [ $((i+=1)) -ge 3 ]; do echo i$i; done'), 'i1\ni2\n');
  assert.equal(await out('cat <<EOF\nx `echo hi` $(echo sub) \\`e\\` \\$HOME\nEOF'), 'x hi sub `e` $HOME\n');
  sim.shell.fs.write('/tmp/fa.sh', 'echo "${nope:?}"\necho after\n');
  const r = await sim.run('bash /tmp/fa.sh');
  assert.equal(r.out, ''); assert.equal(r.err, '/tmp/fa.sh: line 1: nope: parameter null or not set\n'); assert.equal(r.code, 1);
});

test('shell review: process substitution, status of assignment from $(...), exit inside $(...)', async () => {
  const sim = await kernelSim();
  const out = async (l) => (await sim.run(l)).out;
  assert.equal(await out('cat <(echo one) <(echo two)'), 'one\ntwo\n');
  assert.equal(await out("while read l; do echo \"got $l\"; done < <(printf 'x\\ny\\n')"), 'got x\ngot y\n');
  assert.equal(await out("echo b > /tmp/pa; echo a > /tmp/pb; diff <(cat /tmp/pa) <(cat /tmp/pb) | head -1"), '1c1\n');
  assert.equal(await out('echo hi > >(k-upper)'), 'HI\n');
  assert.equal(await out('echo <(true) | grep -c /dev/fd/'), '1\n');
  assert.equal(sim.shell.fs.exists('/dev/fd/63'), false, 'temporary files are removed');
  assert.equal(await out('x=$(false); echo $?; x=$(true); echo $?; x=$(exit 3) || echo "failed $?"; echo alive'), '1\n0\nfailed 3\nalive\n');
});

test('shell review: bash -n / -x / -e flags, bash on a directory, SHLVL, timeout', async () => {
  const sim = await kernelSim();
  sim.shell.fs.write('/tmp/nx.sh', 'echo ran\n[ -z "" ]\n');
  let r = await sim.run('bash -n /tmp/nx.sh'); assert.equal(r.out, ''); assert.equal(r.code, 0);
  r = await sim.run('bash -x /tmp/nx.sh');
  assert.equal(r.out, 'ran\n'); assert.equal(r.err, "+ echo ran\n+ '[' -z '' ']'\n");
  r = await sim.run('bash -ex -c "false; echo no"'); assert.equal(r.out, ''); assert.equal(r.code, 1);
  r = await sim.run('bash /tmp'); assert.equal(r.err, 'bash: /tmp: Is a directory\n'); assert.equal(r.code, 126);
  assert.equal((await sim.run('echo $SHLVL; bash -c \'echo $SHLVL\'')).out, '1\n2\n');
  r = await sim.run('timeout 1 k-sleep 5; echo rc=$?'); assert.equal(r.out, 'rc=124\n');
  assert.equal((await sim.run('timeout 10 k-sleep 1; echo rc=$?')).out, 'slept\nrc=0\n');
  assert.equal((await sim.run('timeout')).code, 125);
  assert.equal((await sim.run('timeout 5 nosuchcmd')).code, 127);
});

test('shell review: missing redirection target is an error, not a continuation; bash -c syntax errors say -c', async () => {
  const sim = await kernelSim();
  const { term, shell, K } = sim;
  term.feed('cat /tmp/x >', 'echo ok', 'exit'); term.take();
  await shell.repl();
  const text = K.util.stripAnsi(term.take());
  assert.match(text, /zsh: parse error near `\\n'\n/);
  assert.match(text, /echo ok\nok\n/);
  assert.equal((await sim.run('bash -c "ls | | x"')).err, "bash: -c: line 1: syntax error near unexpected token `|'\nbash: -c: line 1: `ls | | x'\n");
  assert.equal((await sim.run('bash -c "cat >"')).err, "bash: -c: line 1: syntax error near unexpected token `newline'\nbash: -c: line 1: `cat >'\n");
});

test('shell review: leading-zero numbers are octal in bash and decimal in zsh, version variables', async () => {
  const sim = await kernelSim();
  assert.equal((await sim.run('echo $((017)) $((010+1))')).out, '17 11\n');
  assert.equal((await sim.run("bash -c 'echo $((017)) $((010+1)) $((10#08))'")).out, '15 9 8\n');
  assert.equal((await sim.run("bash -c 'echo $((08))'")).err, 'bash: line 1: 08: value too great for base (error token is "08")\n');
  assert.equal((await sim.run("bash -c 'echo $BASH_VERSION'")).out, '5.3.3(1)-release\n');
  assert.equal((await sim.run('echo $ZSH_VERSION')).out, '5.9\n');
});

test('shell review: printf -v, $(<file), wait status, ulimit', async () => {
  const sim = await kernelSim();
  const out = async (l) => (await sim.run(l)).out;
  assert.equal(await out("printf -v v '%03d' 5; echo $v"), '005\n');
  assert.equal(await out('echo $(< /etc/hostname) x$(</etc/hostname)'), 'kali xkali\n');
  const r = await sim.run('x=$(< /nonexist); echo "[$x]"'); assert.equal(r.out, '[]\n'); assert.equal(r.err, 'zsh: no such file or directory: /nonexist\n');
  sim.K.cmd.register({ name: 'k-hang3', run(ctx) { return new Promise((resolve) => ctx.io.sig.onAbort(() => resolve(143))); } });
  sim.machine.installCommand(sim.K.cmd.get('k-hang3'));
  assert.equal(await out('k-hang3 & kill $!; wait $!; echo $?'), '143\n');
  assert.equal((await sim.run('wait 99999')).err, 'zsh: wait: pid 99999 is not a child of this shell\n');
  assert.equal(await out('ulimit -n; ulimit -n 4096; ulimit -n'), '1024\n4096\n');
  assert.equal((await out('ulimit -a')).split('\n')[0], 'core file size              (blocks, -c) 0');
});

test('shell review: history expansion !:N, ranges, :gs', async () => {
  const sim = await kernelSim();
  const t = async (l) => (await sim.type(l)).output;
  await t('echo a b c d');
  assert.equal(await t('echo !:1 !:2-3 !:*'), 'echo a b c a b c d\na b c a b c d\n');
  assert.equal(await t('echo banana'), 'banana\n');
  assert.equal(await t('!!:gs/a/X/'), 'echo bXnXnX\nbXnXnX\n');
  assert.equal(await t('!!:s/a/Y/'), 'zsh: substitution failed\n');
});

test('shell review: endless producers before head stop, fork bombs are bounded, huge expansions do not overflow the stack', async () => {
  const sim = await kernelSim();
  const t0 = Date.now();
  let r = await sim.run('while true; do echo x; done | head -n 2');
  assert.equal(r.out, 'x\nx\n'); assert.equal(r.err, '');
  r = await sim.run('i=0; while true; do i=$((i+1)); echo $i; done | head -3'); assert.equal(r.out, '1\n2\n3\n');
  assert.equal((await sim.run('echo {a..z}{a..z}{a..z}{a..z} | wc -w')).out, '456976\n');
  r = await sim.run(':(){ :|:& };:'); assert.match(r.err, /^\[1\] \d+\n/);
  assert.equal((await sim.run('echo alive')).out, 'alive\n');
  assert.ok(Date.now() - t0 < 20000);
});

test('shell review: jobs -l / -p and disown', async () => {
  const sim = await kernelSim();
  sim.K.cmd.register({ name: 'k-hang4', run(ctx) { return new Promise((resolve) => ctx.io.sig.onAbort(() => resolve(143))); } });
  sim.machine.installCommand(sim.K.cmd.get('k-hang4'));
  await sim.shell.runLine('k-hang4 &');
  const pid = sim.shell.jobs[0].pid;
  assert.equal((await sim.run('jobs')).out, '[1]  + running    k-hang4\n');
  assert.equal((await sim.run('jobs -l')).out, '[1]  + ' + pid + ' running    k-hang4\n');
  assert.equal((await sim.run('jobs -p')).out, pid + '\n');
  assert.equal((await sim.run("bash -c 'jobs'")).out, '');
  assert.equal((await sim.run('disown; jobs')).out, '');
  assert.equal((await sim.run('disown')).err, 'disown: no current job\n');
  sim.shell.jobs.length = 0;
});
