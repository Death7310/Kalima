// Network pack: ping, ip, traceroute, tracepath, mtr, ss, netstat, ifconfig,
// route, arp, nmcli, iwconfig, ethtool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

/** Boot a simulator with sudo already authenticated. */
async function net(opts) {
  const sim = await boot(opts);
  sim.machine.sudoStamp.kali = sim.K.clock.now();
  sim.out = async (line, o) => (await sim.run(line, o)).out;
  return sim;
}

/** Run a line on the real clock and press Ctrl-C after a moment. Use last in a test. */
async function interrupted(sim, line, afterMs = 30) {
  const { K, shell, term } = sim;
  K.clock.useReal(); K.settings.timeScale = 1;
  term.take();
  const pending = shell.runLine(line);
  setTimeout(() => term.raiseInterrupt(), afterMs);
  const code = await pending;
  return { code, output: K.util.stripAnsi(term.take()) };
}

/* ------------------------------------------------------------------- ping */

test('ping: replies, statistics and exit status', async () => {
  const sim = await net();
  const r = await sim.run('ping -c 3 10.10.10.10');
  const lines = r.out.split('\n');
  assert.equal(lines[0], 'PING 10.10.10.10 (10.10.10.10) 56(84) bytes of data.');
  assert.match(lines[1], /^64 bytes from 10\.10\.10\.10: icmp_seq=1 ttl=64 time=0\.\d{3} ms$/);
  assert.equal(lines[4], '');
  assert.equal(lines[5], '--- 10.10.10.10 ping statistics ---');
  assert.match(lines[6], /^3 packets transmitted, 3 received, 0% packet loss, time 20\d\dms$/);
  assert.match(lines[7], /^rtt min\/avg\/max\/mdev = \d\.\d{3}\/\d\.\d{3}\/\d\.\d{3}\/\d\.\d{3} ms$/);
  assert.equal(r.code, 0);
});

test('ping: a host name is resolved and reverse-resolved in replies', async () => {
  const sim = await net();
  const r = await sim.run('ping -c 1 web01.halcyon.lab');
  assert.match(r.out, /^PING web01\.halcyon\.lab \(10\.10\.10\.10\) 56\(84\) bytes of data\.\n64 bytes from web01\.halcyon\.lab \(10\.10\.10\.10\): icmp_seq=1/);
  assert.match(r.out, /--- web01\.halcyon\.lab ping statistics ---\n1 packets transmitted, 1 received, 0% packet loss, time 0ms/);
});

test('ping: silent hosts time out and exit 1; -O reports outstanding replies', async () => {
  const sim = await net();
  const r = await sim.run('ping -c 3 -W 1 10.10.10.90');
  assert.equal(r.code, 1);
  assert.match(r.out, /3 packets transmitted, 0 received, 100% packet loss, time 20\d\dms/);
  assert.ok(!/rtt min/.test(r.out));
  const o = await sim.run('ping -O -c 3 10.10.10.90');
  assert.match(o.out, /no answer yet for icmp_seq=1\nno answer yet for icmp_seq=2\n/);
});

test('ping: unreachable local host reports Destination Host Unreachable', async () => {
  const sim = await net();
  sim.K.net.hostById('web01').up = false;
  const r = await sim.run('ping -c 4 10.10.10.10');
  assert.match(r.out, /From 10\.10\.10\.5 icmp_seq=1 Destination Host Unreachable\nFrom 10\.10\.10\.5 icmp_seq=2 Destination Host Unreachable\nFrom 10\.10\.10\.5 icmp_seq=3 Destination Host Unreachable\n/);
  assert.match(r.out, /4 packets transmitted, 0 received, \+3 errors, 100% packet loss, time 30\d\dms\npipe 4\n$/);
  assert.equal(r.code, 1);
});

test('ping: name and routing errors', async () => {
  const sim = await net();
  let r = await sim.run('ping -c 1 nosuch.halcyon.lab');
  assert.equal(r.err, 'ping: nosuch.halcyon.lab: Name or service not known\n');
  assert.equal(r.code, 2);
  sim.machine.dns = ['10.10.10.99'];
  r = await sim.run('ping -c 1 web01');
  assert.equal(r.err, 'ping: web01: Temporary failure in name resolution\n');
  sim.machine.routes.length = 0;
  r = await sim.run('ping -c 1 8.8.8.8');
  assert.equal(r.err, 'ping: connect: Network is unreachable\n');
  assert.equal(r.code, 2);
});

test('ping: option checking, usage and version', async () => {
  const sim = await net();
  let r = await sim.run('ping');
  assert.match(r.err, /^ping: usage error: Destination address required\nUsage\n  ping \[options\] <destination>/);
  assert.equal(r.code, 2);
  r = await sim.run('ping -z 10.10.10.1');
  assert.match(r.err, /^ping: invalid option -- 'z'\nUsage/);
  r = await sim.run('ping -c 0 10.10.10.1');
  assert.equal(r.err, "ping: invalid argument: '0': out of range: 1 <= value <= 9007199254740991\n");
  r = await sim.run('ping -c x 10.10.10.1');
  assert.equal(r.err, "ping: invalid argument: 'x'\n");
  assert.equal((await sim.run('ping -V')).out, 'ping from iputils 20250605\n');
});

test('ping: -s, -q, -n, -D, -t and -w', async () => {
  const sim = await net();
  let r = await sim.out('ping -c 1 -s 100 10.10.10.1');
  assert.match(r, /^PING 10\.10\.10\.1 \(10\.10\.10\.1\) 100\(128\) bytes of data\.\n108 bytes from/);
  r = await sim.out('ping -q -c 2 10.10.10.1');
  assert.ok(!/bytes from/.test(r) && /2 packets transmitted, 2 received/.test(r));
  r = await sim.out('ping -D -c 1 10.10.10.1');
  assert.match(r, /\n\[\d{10}\.\d{6}\] 64 bytes from/);
  r = await sim.out('ping -c 2 -t 1 8.8.8.8');
  assert.match(r, /From 10\.10\.10\.1 icmp_seq=1 Time to live exceeded/);
  r = await sim.out('ping -w 3 10.10.10.1');
  assert.match(r, /3 packets transmitted, 3 received, 0% packet loss, time 30\d\dms/);
});

test('ping: Ctrl-C prints the statistics', async () => {
  const sim = await net();
  const r = await interrupted(sim, 'ping 10.10.10.10');
  assert.match(r.output, /--- 10\.10\.10\.10 ping statistics ---\n1 packets transmitted, 1 received, 0% packet loss/);
  assert.equal(r.code, 0);
});

test('ping: works in a pipeline', async () => {
  const sim = await net();
  const r = await sim.out('ping -c 2 10.10.10.10 | grep -c "bytes from"');
  assert.equal(r, '2\n');
});
