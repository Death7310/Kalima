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
  assert.equal(r.err, 'ping: usage error: Destination address required\n');
  assert.equal(r.code, 2);
  r = await sim.run('ping -z 10.10.10.1');
  assert.match(r.err, /^ping: invalid option -- 'z'\nUsage/);
  r = await sim.run('ping -c 0 10.10.10.1');
  assert.equal(r.err, "ping: invalid argument: '0': out of range: 1 <= value <= 9223372036854775807\n");
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

/* --------------------------------------------------------------------- ip */

test('ip addr: full layout for lo and eth0', async () => {
  const sim = await net();
  const out = await sim.out('ip addr');
  const lines = out.split('\n');
  assert.equal(lines[0], '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000');
  assert.equal(lines[1], '    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00');
  assert.equal(lines[2], '    inet 127.0.0.1/8 scope host lo');
  assert.equal(lines[3], '       valid_lft forever preferred_lft forever');
  assert.equal(lines[4], '    inet6 ::1/128 scope host noprefixroute ');
  assert.match(lines[6], /^2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000$/);
  assert.match(lines[7], /^    link\/ether [0-9a-f:]{17} brd ff:ff:ff:ff:ff:ff$/);
  assert.equal(lines[8], '    inet 10.10.10.5/24 brd 10.10.10.255 scope global dynamic noprefixroute eth0');
  assert.match(lines[9], /^       valid_lft \d+sec preferred_lft \d+sec$/);
  assert.match(lines[10], /^    inet6 fe80::[0-9a-f:]+\/64 scope link noprefixroute $/);
});

test('ip: brief, oneline, -4 and abbreviations', async () => {
  const sim = await net();
  const br = (await sim.out('ip -br a')).split('\n');
  assert.equal(br[0], 'lo               UNKNOWN        127.0.0.1/8 ::1/128 ');
  assert.match(br[1], /^eth0             UP             10\.10\.10\.5\/24 fe80::[0-9a-f:]+\/64 $/);
  const brl = (await sim.out('ip -br link')).split('\n');
  assert.match(brl[1], /^eth0             UP             [0-9a-f:]{17} <BROADCAST,MULTICAST,UP,LOWER_UP> $/);
  const one = (await sim.out('ip -o -4 addr show eth0')).trim();
  assert.match(one, /^2: eth0    inet 10\.10\.10\.5\/24 brd 10\.10\.10\.255 scope global dynamic noprefixroute eth0\\       valid_lft \d+sec preferred_lft \d+sec$/);
  assert.equal((await sim.out('ip -4 -br a s lo')), 'lo               UNKNOWN        127.0.0.1/8 \n');
  assert.equal(await sim.out('ip a show dev lo | head -1'), '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000\n');
});

test('ip link: mode field, statistics and errors', async () => {
  const sim = await net();
  const l = await sim.out('ip -s link show eth0');
  assert.match(l, /^2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP mode DEFAULT group default qlen 1000\n/);
  assert.match(l, /\n    RX:  bytes packets errors dropped  missed   mcast\n +\d+ +\d+ +0 +0 +0 +0\n    TX:  bytes packets errors dropped carrier collsns\n/);
  const r = await sim.run('ip addr show dev nope');
  assert.equal(r.err, 'Device "nope" does not exist.\n');
  assert.equal(r.code, 1);
});

test('ip route: show, get, and abbreviations', async () => {
  const sim = await net();
  const out = await sim.out('ip route');
  const [d, c] = out.split('\n');
  assert.equal(d, 'default via 10.10.10.1 dev eth0 proto dhcp src 10.10.10.5 metric 100 ');
  assert.equal(c, '10.10.10.0/24 dev eth0 proto kernel scope link src 10.10.10.5 metric 100 ');
  assert.equal(await sim.out('ip r get 10.10.10.10'), '10.10.10.10 dev eth0 src 10.10.10.5 uid 1000 \n    cache \n');
  assert.equal(await sim.out('ip route get 8.8.8.8'), '8.8.8.8 via 10.10.10.1 dev eth0 src 10.10.10.5 uid 1000 \n    cache \n');
  assert.equal(await sim.out('ip route get 127.0.0.1'), 'local 127.0.0.1 dev lo src 127.0.0.1 uid 1000 \n    cache <local> \n');
});

test('ip: changes need root and really change the machine', async () => {
  const sim = await net();
  sim.machine.sudoStamp = {};
  let r = await sim.run('ip link set dev eth0 down');
  assert.equal(r.err, 'RTNETLINK answers: Operation not permitted\n');
  assert.equal(r.code, 2);
  assert.equal(sim.machine.ifaces[1].state, 'UP');
  r = await sim.run('ip route add 192.168.9.0/24 via 10.10.10.1');
  assert.equal(r.err, 'RTNETLINK answers: Operation not permitted\n');
  assert.equal((await sim.run('ip addr add 10.10.10.77/24 dev eth0')).err, 'RTNETLINK answers: Operation not permitted\n');
});

test('ip link set down/up: routing reacts and routes come back', async () => {
  const sim = await net();
  assert.equal((await sim.run('sudo ip link set dev eth0 down')).code, 0);
  assert.match(await sim.out('ip -br link'), /eth0             DOWN           [0-9a-f:]{17} <BROADCAST,MULTICAST> /);
  assert.equal(await sim.out('ip route'), '');
  const p = await sim.run('ping -c 1 10.10.10.10');
  assert.equal(p.err, 'ping: connect: Network is unreachable\n');
  assert.equal((await sim.run('sudo ip link set eth0 up')).code, 0);
  assert.match(await sim.out('ip route'), /^default via 10\.10\.10\.1 dev eth0 proto dhcp/);
  assert.equal((await sim.run('ping -c 1 10.10.10.10')).code, 0);
});

test('ip addr add/del and ip route add/del', async () => {
  const sim = await net();
  assert.equal((await sim.run('sudo ip addr add 10.10.10.77/24 dev eth0')).code, 0);
  assert.match(await sim.out('ip -4 addr show eth0'), /inet 10\.10\.10\.77\/24 brd 10\.10\.10\.255 scope global secondary eth0/);
  assert.equal((await sim.run('sudo ip addr add 10.10.10.77/24 dev eth0')).err, 'RTNETLINK answers: File exists\n');
  assert.equal((await sim.run('sudo ip addr del 10.10.10.77/24 dev eth0')).code, 0);
  assert.equal((await sim.run('sudo ip addr del 10.10.10.77/24 dev eth0')).err, 'RTNETLINK answers: Cannot assign requested address\n');
  assert.equal((await sim.run('sudo ip route add 172.30.0.0/16 via 10.10.10.1')).code, 0);
  assert.match(await sim.out('ip route'), /\n172\.30\.0\.0\/16 via 10\.10\.10\.1 dev eth0 \n/);
  assert.equal((await sim.run('sudo ip route add 172.30.0.0/16 via 10.10.10.1')).err, 'RTNETLINK answers: File exists\n');
  assert.equal((await sim.run('sudo ip route add 172.31.0.0/16 via 192.168.77.1')).err, 'Error: Nexthop has invalid gateway.\n');
  assert.equal((await sim.run('sudo ip route del 172.30.0.0/16')).code, 0);
  assert.equal((await sim.run('sudo ip route del 172.30.0.0/16')).err, 'RTNETLINK answers: No such process\n');
  assert.equal((await sim.run('sudo ip route del default')).code, 0);
  assert.equal((await sim.run('ping -c 1 8.8.8.8')).err, 'ping: connect: Network is unreachable\n');
});

test('ip addr del of the only address removes its routes', async () => {
  const sim = await net();
  await sim.run('sudo ip addr del 10.10.10.5/24 dev eth0');
  assert.equal(await sim.out('ip route'), '');
  await sim.run('sudo ip addr add 10.10.10.5/24 dev eth0');
  assert.equal(await sim.out('ip route'), '10.10.10.0/24 dev eth0 proto kernel scope link src 10.10.10.5 \n');
});

test('ip link: mtu, address, dummy devices', async () => {
  const sim = await net();
  await sim.run('sudo ip link set eth0 mtu 9000');
  assert.match(await sim.out('ip link show eth0'), /mtu 9000/);
  await sim.run('sudo ip link set dev eth0 address 02:00:00:aa:bb:cc');
  assert.match(await sim.out('ip link show eth0'), /link\/ether 02:00:00:aa:bb:cc/);
  assert.equal((await sim.run('sudo ip link set dev eth0 address nonsense')).err, 'Error: argument "nonsense" is wrong: Invalid address\n');
  await sim.run('sudo ip link add dummy0 type dummy');
  assert.match(await sim.out('ip -br link'), /^dummy0 +DOWN +[0-9a-f:]{17} <BROADCAST,NOARP> $/m);
  await sim.run('sudo ip addr add 192.168.50.1/24 dev dummy0');
  await sim.run('sudo ip link set dummy0 up');
  assert.match(await sim.out('ip route'), /192\.168\.50\.0\/24 dev dummy0 proto kernel scope link src 192\.168\.50\.1/);
  await sim.run('sudo ip link del dummy0');
  assert.doesNotMatch(await sim.out('ip -br link'), /dummy0/);
});

test('ip neigh shows what ping learned; flush clears it', async () => {
  const sim = await net();
  await sim.run('ping -c 1 10.10.10.10');
  assert.match(await sim.out('ip neigh'), /^10\.10\.10\.10 dev eth0 lladdr [0-9a-f:]{17} REACHABLE\n$/);
  sim.K.net.hostById('web01').up = false;
  sim.machine.arp.clear();
  await sim.run('ping -c 1 -W 1 10.10.10.10');
  assert.equal(await sim.out('ip neigh'), '10.10.10.10 dev eth0  FAILED\n');
  assert.equal((await sim.run('sudo ip neigh flush all')).code, 0);
  assert.equal(await sim.out('ip neigh'), '');
});

test('ip: errors, options and version', async () => {
  const sim = await net();
  let r = await sim.run('ip foo');
  assert.equal(r.err, 'Object "foo" is unknown, try "ip help".\n');
  assert.equal(r.code, 255);
  r = await sim.run('ip addr frobnicate');
  assert.equal(r.err, 'Command "frobnicate" is unknown, try "ip addr help".\n');
  r = await sim.run('ip -x addr');
  assert.equal(r.err, 'Option "-x" is unknown, try "ip -help".\n');
  assert.equal((await sim.run('ip -V')).out, 'ip utility, iproute2-6.15.0\n');
  r = await sim.run('ip');
  assert.match(r.err, /^Usage: ip \[ OPTIONS \] OBJECT \{ COMMAND \| help \}/);
  assert.equal(r.code, 255);
  assert.match((await sim.run('ip -4 route add foo via 10.10.10.1')).err, /^Error: inet prefix is expected rather than "foo"\./);
});

test('ip: colour with --color=always, json and pipelines', async () => {
  const sim = await net();
  assert.match(await sim.out('ip --color=always -br a'), /\x1b\[36mlo\x1b\[0m/);
  assert.doesNotMatch(await sim.out('ip --color=auto -br a'), /\x1b/);
  const j = JSON.parse(await sim.out('ip -j addr show eth0'));
  assert.equal(j[0].ifname, 'eth0');
  assert.equal(j[0].addr_info[0].local, '10.10.10.5');
  assert.equal(await sim.out('ip -o -4 addr | grep -c inet'), '2\n');
  assert.equal(await sim.out('ip -4 -br a | grep eth0 | tr -s " " | cut -d" " -f3'), '10.10.10.5/24\n');
});

/* ------------------------------------------------- traceroute, tracepath, mtr */

test('traceroute: header, hop lines and the destination last', async () => {
  const sim = await net();
  const r = await sim.run('traceroute -n 8.8.8.8');
  const lines = r.out.split('\n');
  assert.equal(lines[0], 'traceroute to 8.8.8.8 (8.8.8.8), 30 hops max, 60 byte packets');
  assert.match(lines[1], /^ 1  10\.10\.10\.1  \d\.\d{3} ms  \d\.\d{3} ms  \d\.\d{3} ms$/);
  assert.ok(lines.some((l) => /^ \d  \* \* \*$/.test(l)), 'a silent hop shows * * *');
  const last = lines[lines.length - 2];
  assert.match(last, /^10  8\.8\.8\.8  \d+\.\d{3} ms  \d+\.\d{3} ms  \d+\.\d{3} ms$/);
  assert.equal(r.code, 0);
});

test('traceroute: names, -m, -q, -f and a destination that never answers', async () => {
  const sim = await net();
  let r = await sim.out('traceroute web01.halcyon.lab');
  assert.match(r, /^traceroute to web01\.halcyon\.lab \(10\.10\.10\.10\), 30 hops max, 60 byte packets\n 1  web01\.halcyon\.lab \(10\.10\.10\.10\)  /);
  r = await sim.out('traceroute -n -m 3 -q 1 10.10.10.90');
  assert.equal(r, 'traceroute to 10.10.10.90 (10.10.10.90), 3 hops max, 60 byte packets\n 1  * \n 2  * \n 3  * \n'.replace(/ \n/g, '\n'));
  r = await sim.out('traceroute -n -f 2 -m 3 -q 1 8.8.8.8');
  assert.match(r, /\n 2  100\.64\.0\.1  [\d.]+ ms\n 3  \*\n$/);
  assert.match(await sim.out('traceroute -I -n -q 1 10.10.10.90 -m 1'), /^traceroute to/);
});

test('traceroute: errors, privileges and version', async () => {
  const sim = await net();
  let r = await sim.run('traceroute nosuch.halcyon.lab');
  assert.equal(r.err, "nosuch.halcyon.lab: Name or service not known\nCannot handle \"host\" cmdline arg `nosuch.halcyon.lab' on position 1 (argc 1)\n");
  assert.equal(r.code, 2);
  r = await sim.run('traceroute -T 10.10.10.10');
  assert.equal(r.err, 'You do not have enough privileges to use this traceroute method.\n');
  assert.equal(r.code, 1);
  r = await sim.run('sudo traceroute -T -n 10.10.10.10');
  assert.match(r.out, / 1  10\.10\.10\.10  /);
  sim.machine.routes.length = 0;
  assert.equal((await sim.run('traceroute 8.8.8.8')).err, 'connect: Network is unreachable\n');
  assert.match((await sim.run('traceroute -V')).out, /^Modern traceroute for Linux, version 2\.1\.6/);
  assert.equal((await sim.run('traceroute')).err, 'Specify "host" missing argument.\n');
});

test('traceroute: a dead host on the local segment reports !H', async () => {
  const sim = await net();
  sim.K.net.hostById('web01').up = false;
  const r = await sim.out('traceroute -n 10.10.10.10');
  assert.match(r, / 1  10\.10\.10\.5  30\d\d\.\d{3} ms !H  30\d\d\.\d{3} ms !H  30\d\d\.\d{3} ms !H\n$/);
});

test('tracepath: hop lines, no reply, resume line', async () => {
  const sim = await net();
  const r = await sim.run('tracepath -n 8.8.8.8');
  const lines = r.out.split('\n');
  assert.match(lines[0], /^ 1\?: \[LOCALHOST\] +pmtu 1500$/);
  assert.match(lines[1], /^ 1:  10\.10\.10\.1 +\d\.\d{3}ms $/);
  assert.match(lines[2], /^ 1:  10\.10\.10\.1 +\d\.\d{3}ms $/);
  assert.ok(lines.includes(' 3:  no reply'));
  assert.match(lines[lines.length - 3], /^10:  8\.8\.8\.8 +\d+\.\d{3}ms reached$/);
  assert.equal(lines[lines.length - 2], '     Resume: pmtu 1500 hops 10 back 10 ');
  assert.equal((await sim.run('tracepath')).code, 255);
  assert.equal((await sim.run('tracepath nosuch.halcyon.lab')).err, 'tracepath: nosuch.halcyon.lab: Name or service not known\n');
});

test('mtr: report mode table', async () => {
  const sim = await net();
  const r = await sim.run('mtr -r -n -c 4 8.8.8.8');
  const lines = r.out.split('\n');
  assert.match(lines[0], /^Start: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+0000$/);
  assert.equal(lines[1], 'HOST: kali                        Loss%   Snt   Last   Avg  Best  Wrst StDev');
  assert.match(lines[2], /^  1\.\|-- 10\.10\.10\.1 +0\.0% +4 +\d\.\d +\d\.\d +\d\.\d +\d\.\d +\d\.\d$/);
  assert.ok(lines.some((l) => /^  3\.\|-- \?\?\? +100\.0 +4 +0\.0 +0\.0 +0\.0 +0\.0 +0\.0$/.test(l)));
  assert.match(lines[11], /^ 10\.\|-- 8\.8\.8\.8 /);
  assert.equal((await sim.run('mtr --version')).out, 'mtr 0.96\n');
  assert.match((await sim.run('mtr -r nosuch.halcyon.lab')).err, /^mtr: Failed to resolve host: nosuch\.halcyon\.lab: Name or service not known/);
});

test('mtr: live view redraws until q', async () => {
  const sim = await net();
  sim.term.isTTY = true;
  const { K, shell, term } = sim;
  K.clock.useReal(); K.settings.timeScale = 0.01;
  term.take();
  const run = shell.runLine('mtr -n 10.10.10.10');
  setTimeout(() => term.pressKey('q'), 60);
  const code = await run;
  const out = K.util.stripAnsi(term.take());
  assert.equal(code, 0);
  assert.match(out, /My traceroute  \[v0\.96\]/);
  assert.match(out, / Host +Loss% +Snt +Last +Avg +Best +Wrst StDev/);
});

test('traceroute works in a pipeline', async () => {
  const sim = await net();
  assert.equal(await sim.out('traceroute -n -q 1 10.10.10.10 | grep -c "10.10.10.10"'), '2\n');
});

/* ------------------------------------------------- ss, netstat, ifconfig, route, arp */

async function withSsh() {
  const sim = await net();
  await sim.run('sudo systemctl start ssh');
  return sim;
}

test('ss: listening sockets with the iproute2 column layout', async () => {
  const sim = await withSsh();
  const lines = (await sim.out('ss -tln')).split('\n');
  assert.equal(lines[0], 'State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess');
  assert.equal(lines[1], 'LISTEN 0      128          0.0.0.0:22         0.0.0.0:*          ');
  assert.equal(lines[2], 'LISTEN 0      128             [::]:22            [::]:*          ');
  assert.equal(await sim.out('ss -tlnH -4'), 'LISTEN 0      128    0.0.0.0:22 0.0.0.0:*\n');
});

test('ss: -u adds the Netid column; service names without -n; -p only for root', async () => {
  const sim = await withSsh();
  const udp = (await sim.out('ss -ul')).split('\n');
  assert.match(udp[0], /^State  Recv-Q Send-Q +Local Address:Port +Peer Address:PortProcess$/);
  assert.match(udp[1], /^UNCONN 0      0      +10\.10\.10\.5%eth0:bootpc +0\.0\.0\.0:\* +$/);
  const both = (await sim.out('ss -tuln')).split('\n');
  assert.match(both[0], /^Netid State  Recv-Q Send-Q/);
  assert.match(await sim.out('ss -tl'), /0\.0\.0\.0:ssh/);
  assert.doesNotMatch(await sim.out('ss -tlnp'), /users:/);
  const root = await sim.out('sudo ss -tlnp');
  assert.match(root, /users:\(\("sshd",pid=\d+,fd=3\)\)/);
  assert.match(root, /users:\(\("sshd",pid=\d+,fd=4\)\)/);
});

test('ss: nothing established, option errors and version', async () => {
  const sim = await net();
  assert.equal(await sim.out('ss -t'), 'State Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess\n');
  assert.equal(await sim.out('ss -tlnH'), '');
  const r = await sim.run('ss -j');
  assert.match(r.err, /^ss: invalid option -- 'j'\nUsage: ss \[ OPTIONS \]/);
  assert.equal(r.code, 1);
  assert.match((await sim.run('ss -V')).out, /^ss utility, iproute2-/);
  sim.machine.listeners.push({ port: 4444, proto: 'tcp', addr: '0.0.0.0', prog: 'nc', pid: 4242, name: 'nc' });
  assert.match(await sim.out('ss -tln'), /LISTEN 0 +128 +0\.0\.0\.0:4444/);
});

test('netstat: -tulpn, -rn, -i and the non-root warning', async () => {
  const sim = await withSsh();
  const r = await sim.run('netstat -tulpn');
  assert.match(r.err, /^\(Not all processes could be identified, non-owned process info\n will not be shown/);
  const lines = r.out.split('\n');
  assert.equal(lines[0], 'Active Internet connections (only servers)');
  assert.equal(lines[1], 'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name    ');
  assert.match(lines.find((l) => l.startsWith('tcp ')), /^tcp        0    128 0\.0\.0\.0:22              0\.0\.0\.0:\*               LISTEN      -  +$/);
  const root = await sim.out('sudo netstat -tulpn');
  assert.match(root, /\ntcp6       0    128 :::22                   :::\*                    LISTEN      \d+\/sshd +\n/);
  assert.match(root, /\nudp        0      0 10\.10\.10\.5:68           0\.0\.0\.0:\*                           \d+\/NetworkManager +\n/);
  assert.equal(await sim.out('netstat -rn'), 'Kernel IP routing table\nDestination     Gateway         Genmask         Flags   MSS Window  irtt Iface\n0.0.0.0         10.10.10.1      0.0.0.0         UG        0 0          0 eth0\n10.10.10.0      0.0.0.0         255.255.255.0   U         0 0          0 eth0\n');
  const i = (await sim.out('netstat -i')).split('\n');
  assert.equal(i[0], 'Kernel Interface table');
  assert.equal(i[1], 'Iface      MTU    RX-OK RX-ERR RX-DRP RX-OVR    TX-OK TX-ERR TX-DRP TX-OVR Flg');
  assert.match(i[2], /^eth0      1500 +\d+      0      0 0 +\d+      0      0      0 BMRU$/);
  assert.match(i[3], /^lo       65536 +\d+      0      0 0 +\d+      0      0      0 LRU$/);
});

test('ifconfig: net-tools layout, -a, an interface, errors', async () => {
  const sim = await net();
  const out = await sim.out('ifconfig');
  const lines = out.split('\n');
  assert.equal(lines[0], 'eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500');
  assert.equal(lines[1], '        inet 10.10.10.5  netmask 255.255.255.0  broadcast 10.10.10.255');
  assert.match(lines[2], /^        inet6 fe80::[0-9a-f:]+  prefixlen 64  scopeid 0x20<link>$/);
  assert.match(lines[3], /^        ether [0-9a-f:]{17}  txqueuelen 1000  \(Ethernet\)$/);
  assert.match(lines[4], /^        RX packets \d+  bytes \d+ \(\d+\.\d MiB\)$/);
  assert.equal(lines[5], '        RX errors 0  dropped 0  overruns 0  frame 0');
  assert.equal(lines[7], '        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0');
  assert.equal(lines[8], '');
  assert.equal(lines[9], 'lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536');
  assert.equal(lines[12], '        loop  txqueuelen 1000  (Local Loopback)');
  const r = await sim.run('ifconfig eth9');
  assert.equal(r.err, 'eth9: error fetching interface information: Device not found\n');
  assert.equal(r.code, 1);
  assert.doesNotMatch(await sim.out('ifconfig lo'), /eth0/);
});

test('ifconfig: up and down as root, refused without', async () => {
  const sim = await net();
  sim.machine.sudoStamp = {};
  const r = await sim.run('ifconfig eth0 down');
  assert.equal(r.err, 'SIOCSIFFLAGS: Operation not permitted\n');
  assert.equal(r.code, 255);
  sim.machine.sudoStamp.kali = sim.K.clock.now();
  assert.equal((await sim.run('sudo ifconfig eth0 down')).code, 0);
  assert.doesNotMatch(await sim.out('ifconfig'), /eth0/);
  assert.match(await sim.out('ifconfig -a'), /^eth0: flags=4098<BROADCAST,MULTICAST>  mtu 1500/);
  assert.equal(await sim.out('ip route'), '');
  await sim.run('sudo ifconfig eth0 up');
  assert.match(await sim.out('ip route'), /^default via 10\.10\.10\.1/);
  await sim.run('sudo ifconfig eth0 10.10.10.99 netmask 255.255.255.0');
  assert.match(await sim.out('ip -br a show eth0'), /10\.10\.10\.99\/24/);
  assert.match(await sim.out('ip route'), /^default via 10\.10\.10\.1 dev eth0 proto dhcp src 10\.10\.10\.99/);
});

test('route: table, -n, add and delete', async () => {
  const sim = await net();
  assert.equal(await sim.out('route -n'), 'Kernel IP routing table\nDestination     Gateway         Genmask         Flags Metric Ref    Use Iface\n0.0.0.0         10.10.10.1      0.0.0.0         UG    100    0        0 eth0\n10.10.10.0      0.0.0.0         255.255.255.0   U     100    0        0 eth0\n');
  assert.match(await sim.out('route'), /\ndefault         gw\.halcyon\.lab  0\.0\.0\.0         UG    100/);
  let r = await sim.run('route add -net 172.30.0.0 netmask 255.255.0.0 gw 10.10.10.1');
  assert.equal(r.err, 'SIOCADDRT: Operation not permitted\n');
  assert.equal((await sim.run('sudo route add -net 172.30.0.0 netmask 255.255.0.0 gw 10.10.10.1')).code, 0);
  assert.match(await sim.out('route -n'), /\n172\.30\.0\.0      10\.10\.10\.1      255\.255\.0\.0     UG    0      0        0 eth0\n/);
  assert.equal((await sim.run('sudo route add -net 172.30.0.0 netmask 255.255.0.0 gw 10.10.10.1')).err, 'SIOCADDRT: File exists\n');
  assert.equal((await sim.run('sudo route add -net 172.31.0.0 netmask 255.255.0.0 gw 192.168.1.1')).err, 'SIOCADDRT: Network is unreachable\n');
  assert.equal((await sim.run('sudo route del -net 172.30.0.0 netmask 255.255.0.0')).code, 0);
  assert.equal((await sim.run('sudo route del -net 172.30.0.0 netmask 255.255.0.0')).err, 'SIOCDELRT: No such process\n');
  await sim.run('sudo route del default');
  assert.equal((await sim.run('ping -c 1 8.8.8.8')).err, 'ping: connect: Network is unreachable\n');
  await sim.run('sudo route add default gw 10.10.10.1');
  assert.equal((await sim.run('ping -c 1 8.8.8.8')).code, 0);
});

test('arp: table, -a, -n, set and delete', async () => {
  const sim = await net();
  assert.equal(await sim.out('arp'), '');
  await sim.run('ping -c 1 10.10.10.10');
  const t = (await sim.out('arp -n')).split('\n');
  assert.equal(t[0], 'Address                  HWtype  HWaddress           Flags Mask            Iface');
  assert.match(t[1], /^10\.10\.10\.10 {14}ether   [0-9a-f:]{17}   C {21}eth0$/);
  assert.match(await sim.out('arp -a'), /^web01\.halcyon\.lab \(10\.10\.10\.10\) at [0-9a-f:]{17} \[ether\] on eth0\n$/);
  assert.match(await sim.out('arp -an'), /^\? \(10\.10\.10\.10\) at /);
  assert.equal((await sim.run('arp -d 10.10.10.10')).err, 'SIOCDARP(dontpub): Operation not permitted\n');
  assert.equal((await sim.run('sudo arp -s 10.10.10.99 02:00:00:00:00:99')).code, 0);
  assert.match(await sim.out('arp -n'), /10\.10\.10\.99 +ether +02:00:00:00:00:99 +CM +eth0/);
  assert.equal((await sim.run('sudo arp -d 10.10.10.99')).code, 0);
  assert.equal((await sim.run('sudo arp -d 10.10.10.99')).err, 'No ARP entry for 10.10.10.99\n');
  sim.K.net.hostById('web01').up = false;
  sim.machine.arp.clear();
  await sim.run('ping -c 1 10.10.10.10');
  assert.match(await sim.out('arp -an'), /^\? \(10\.10\.10\.10\) at <incomplete> on eth0\n$/);
});

/* ------------------------------------------------------ nmcli, iwconfig, ethtool */

test('nmcli: general, device and connection tables', async () => {
  const sim = await net();
  assert.equal(await sim.out('nmcli general status'), 'STATE      CONNECTIVITY  WIFI-HW  WIFI     WWAN-HW  WWAN     \nconnected  full          enabled  enabled  enabled  enabled  \n');
  assert.equal(await sim.out('nmcli device status'), 'DEVICE  TYPE      STATE                   CONNECTION          \neth0    ethernet  connected               Wired connection 1  \nlo      loopback  connected (externally)  lo                  \n');
  const con = (await sim.out('nmcli connection show')).split('\n');
  assert.equal(con[0], 'NAME                UUID                                  TYPE      DEVICE  ');
  assert.match(con[1], /^Wired connection 1  [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}  ethernet  eth0    $/);
  assert.equal(await sim.out('nmcli d'), await sim.out('nmcli device status'));
  assert.equal(await sim.out('nmcli -t -f DEVICE,STATE device'), 'eth0:connected\nlo:connected (externally)\n');
});

test('nmcli device show: key column and addresses', async () => {
  const sim = await net();
  const out = await sim.out('nmcli device show eth0');
  assert.match(out, /^GENERAL\.DEVICE: {25}eth0\nGENERAL\.TYPE: {27}ethernet\nGENERAL\.HWADDR: {25}08:00:27:[0-9A-F:]{8}\n/);
  assert.match(out, /\nIP4\.ADDRESS\[1\]: {25}10\.10\.10\.5\/24\nIP4\.GATEWAY: {28}10\.10\.10\.1\nIP4\.ROUTE\[1\]: {27}dst = 10\.10\.10\.0\/24, nh = 0\.0\.0\.0, mt = 100\n/);
  assert.match(out, /IP4\.DNS\[1\]: +10\.10\.10\.53\nIP4\.DOMAIN\[1\]: +halcyon\.lab\n/);
  const r = await sim.run('nmcli device show eth9');
  assert.equal(r.err, "Error: Device 'eth9' not found.\n");
  assert.equal(r.code, 10);
  assert.match(await sim.out('nmcli device show'), /\n\nGENERAL\.DEVICE: +lo\n/);
});

test('nmcli: overview, actions, errors', async () => {
  const sim = await net();
  assert.match(await sim.out('nmcli'), /^eth0: connected to Wired connection 1\n        "Intel 82540EM"\n        ethernet \(e1000\), 08:00:27:/);
  assert.match(await sim.out('nmcli'), /DNS configuration:\n        servers: 10\.10\.10\.53/);
  const r = await sim.run('nmcli device disconnect eth0');
  assert.equal(r.out, "Device 'eth0' successfully disconnected.\n");
  assert.match(await sim.out('nmcli device status'), /eth0 +ethernet +disconnected +--/);
  assert.equal(await sim.out('nmcli -t -f STATE general'), 'disconnected\n');
  assert.equal((await sim.run('ping -c 1 10.10.10.10')).err, 'ping: connect: Network is unreachable\n');
  assert.match((await sim.run('nmcli device connect eth0')).out, /^Device 'eth0' successfully activated with '[0-9a-f-]{36}'\.\n$/);
  assert.equal((await sim.run('ping -c 1 10.10.10.10')).code, 0);
  assert.match((await sim.run('nmcli connection down "Wired connection 1"')).out, /^Connection 'Wired connection 1' successfully deactivated/);
  assert.match((await sim.run('nmcli connection up "Wired connection 1"')).out, /^Connection successfully activated/);
  const bad = await sim.run('nmcli foo');
  assert.equal(bad.err, "Error: argument 'foo' not understood. Try passing --help instead.\n");
  assert.equal(bad.code, 2);
  assert.equal((await sim.run('nmcli connection show nosuch')).err, 'Error: nosuch - no such connection profile.\n');
  assert.equal((await sim.run('nmcli -v')).out, 'nmcli tool, version 1.52.1\n');
});

test('iwconfig: no wireless extensions', async () => {
  const sim = await net();
  assert.equal(await sim.out('iwconfig'), 'lo        no wireless extensions.\n\neth0      no wireless extensions.\n\n');
  assert.equal(await sim.out('iwconfig eth0'), 'eth0      no wireless extensions.\n\n');
  const r = await sim.run('iwconfig wlan0');
  assert.equal(r.err, 'wlan0     No such device\n');
  assert.equal(r.code, 1);
});

test('ethtool: settings, driver, errors and privileges', async () => {
  const sim = await net();
  const user = await sim.out('ethtool eth0');
  assert.match(user, /^Settings for eth0:\n\tSupported ports: \[ TP \]\n\tSupported link modes:   10baseT\/Half 10baseT\/Full\n/);
  assert.match(user, /\tSpeed: 1000Mb\/s\n\tDuplex: Full\n/);
  assert.match(user, /\nCannot get wake-on-lan settings: Operation not permitted\n\tCurrent message level: 0x00000007 \(7\)\n\t\t\t       drv probe link\n\tLink detected: yes\n$/);
  const root = await sim.out('sudo ethtool eth0');
  assert.match(root, /\tSupports Wake-on: umbg\n\tWake-on: d\n/);
  assert.match(await sim.out('ethtool -i eth0'), /^driver: e1000\nversion: .+\nfirmware-version: \n/);
  assert.equal(await sim.out('ethtool lo'), 'Settings for lo:\n\tLink detected: yes\n');
  const r = await sim.run('ethtool eth9');
  assert.equal(r.code, 75);
  assert.match(r.err, /^Cannot get device settings: No such device\n/);
  assert.equal((await sim.run('ethtool')).code, 1);
  await sim.run('sudo ip link set eth0 down');
  assert.match(await sim.out('ethtool eth0'), /Link detected: no\n$/);
});

test('completion: hosts for ping, interfaces and keywords for ip', async () => {
  const sim = await net();
  const def = sim.K.cmd.get('ping');
  const names = def.complete({ words: ['ping', ''], index: 1, cur: '', ctx: {} });
  assert.ok(names.includes('web01.halcyon.lab') && names.includes('dc01') && names.includes('kali.org'));
  assert.ok(sim.K.cmd.get('traceroute').complete({ words: ['traceroute', ''], index: 1, cur: '' }).includes('files01'));
  const ip = sim.K.cmd.get('ip');
  assert.ok(ip.complete({ words: ['ip', ''], index: 1, cur: '' }).includes('route'));
  assert.deepEqual(ip.complete({ words: ['ip', 'link', 'set', 'dev', ''], index: 4, cur: '', ctx: { machine: sim.machine } }), ['lo', 'eth0']);
  assert.ok(ip.complete({ words: ['ip', 'addr', ''], index: 2, cur: '' }).includes('add'));
});

/* --------------------------------------------------- review regressions */

test('ping: bare ping prints only the usage error; -t and -s ranges', async () => {
  const sim = await net();
  let r = await sim.run('ping');
  assert.equal(r.err, 'ping: usage error: Destination address required\n');
  assert.equal(r.code, 2);
  r = await sim.run('ping -c1 -t 0 8.8.8.8');
  assert.equal(r.err, "ping: invalid argument: '0': out of range: 1 <= value <= 255\n");
  assert.equal(r.code, 2);
  r = await sim.run('ping -c1 -s 70000 10.10.10.10');
  assert.equal(r.err, "ping: invalid argument: '70000': out of range: 0 <= value <= 65507\n");
});

test('ping: a single probe to a missing LAN host reports Host Unreachable', async () => {
  const sim = await net();
  const r = await sim.run('ping -c1 10.10.10.99');
  assert.match(r.out, /\nFrom 10\.10\.10\.5 icmp_seq=1 Destination Host Unreachable\n\n--- 10\.10\.10\.99 ping statistics ---\n1 packets transmitted, 0 received, \+1 errors, 100% packet loss, time 0ms\n$/);
  assert.equal(r.code, 1);
});

test('mtr: -w alone means report mode', async () => {
  const sim = await net();
  sim.term.isTTY = true;
  const r = await sim.run('mtr -w -c 1 -n 10.10.10.10');
  assert.match(r.out, /^Start: /);
});

test('ss: -s summary and FILTER expressions', async () => {
  const sim = await net();
  await sim.run('sudo systemctl start ssh');
  const s = await sim.out('ss -s');
  assert.match(s, /^Total: \d+\nTCP:   2 \(estab 0, closed 0, orphaned 0, timewait 0\)\n\nTransport Total     IP        IPv6\nRAW\t  /);
  const one = await sim.out('ss -ltnH sport = :22');
  assert.equal(one.trim().split('\n').length, 2);
  assert.equal(await sim.out('ss -ltnH sport = :80'), '');
  assert.equal((await sim.out("ss -ltnH '( sport = :80 or sport = :ssh )'")).trim().split('\n').length, 2);
  assert.equal(await sim.out('ss -tnH state established'), '');
  const bad = await sim.run('ss -tln foo');
  assert.equal(bad.code, 1);
});

test('netstat: -c is a flag, -g, -ie, and the UNIX section of -nlp', async () => {
  const sim = await net();
  const c = await sim.run('netstat -c');
  assert.equal(c.code, 0);
  assert.match(await sim.out('netstat -g'), /^IPv6\/IPv4 Group Memberships\nInterface       RefCnt Group\n/);
  assert.match(await sim.out('netstat -ie'), /^Kernel Interface table\neth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>/);
  const l = await sim.out('sudo netstat -nlp');
  assert.match(l, /Active UNIX domain sockets \(only servers\)\nProto RefCnt Flags       Type       State         I-Node   PID\/Program name    Path\nunix  2      \[ ACC \]     STREAM     LISTENING     \d+ +1\/init +\/run/);
});

/* ------------------------------------------------- review regressions */

test('ip route lists routes in kernel order (ascending address, default first)', async () => {
  const sim = await net();
  await sim.run('sudo ip route add 192.168.50.0/24 via 10.10.10.1');
  await sim.run('sudo ip route add 10.20.0.0/16 via 10.10.10.1');
  const lines = (await sim.out('ip route')).trim().split('\n').map((l) => l.split(' ')[0]);
  assert.deepEqual(lines, ['default', '10.10.10.0/24', '10.20.0.0/16', '192.168.50.0/24']);
  const n = (await sim.out('netstat -rn')).split('\n').slice(2, -1).map((l) => l.split(/\s+/)[0]);
  assert.deepEqual(n, ['0.0.0.0', '10.10.10.0', '10.20.0.0', '192.168.50.0']);
});

test('ping: broadcast address needs -b, count limit text matches iputils', async () => {
  const sim = await net();
  const r = await sim.run('ping -c 1 10.10.10.255');
  assert.equal(r.err, 'ping: Do you want to ping broadcast? Then -b. If not, check your local firewall rules\n');
  assert.equal(r.code, 2);
  assert.equal((await sim.run('ping -c 0 10.10.10.1')).err, "ping: invalid argument: '0': out of range: 1 <= value <= 9223372036854775807\n");
});

test('arp: an unresolvable name is Unknown host', async () => {
  const sim = await net();
  const r = await sim.run('arp nosuchhost.halcyon.lab');
  assert.equal(r.err, 'nosuchhost.halcyon.lab: Unknown host\n');
  assert.equal(r.code, 1);
});

test('nmcli: -g and -f filter device show, networking and radio switches work', async () => {
  const sim = await net();
  assert.equal(await sim.out('nmcli -g IP4.ADDRESS dev show eth0'), '10.10.10.5/24\n');
  assert.equal(await sim.out('nmcli -t -f GENERAL.DEVICE dev show eth0'), 'GENERAL.DEVICE:eth0\n');
  assert.equal((await sim.run('sudo nmcli networking off')).code, 0);
  assert.equal(await sim.out('nmcli networking'), 'disabled\n');
  assert.match((await sim.run('ping -c 1 10.10.10.1')).err, /Network is unreachable/);
  await sim.run('sudo nmcli networking on');
  assert.equal((await sim.run('ping -c 1 10.10.10.1')).code, 0);
  await sim.run('sudo nmcli radio wifi off');
  assert.match(await sim.out('nmcli radio'), /enabled\s+disabled\s+enabled\s+enabled/);
});

/* ------------------------------------------------------------ review fixes */

test('ifconfig: eth0:1 adds an alias instead of replacing the address; add/del and alias down', async () => {
  const sim = await net();
  await sim.run('sudo ifconfig eth0:1 10.10.10.78');
  const all = await sim.out('ifconfig');
  assert.match(all, /TX errors 0 .*\n\neth0:1: flags=4163<UP,BROADCAST,RUNNING,MULTICAST> {2}mtu 1500\n {8}inet 10\.10\.10\.78 {2}netmask 255\.0\.0\.0 {2}broadcast 10\.255\.255\.255\n {8}ether 08:00:27:1d:77:55 {2}txqueuelen 1000 {2}\(Ethernet\)\n\nlo: /);
  assert.match(await sim.out('ifconfig eth0:1'), /^eth0:1: flags=/);
  assert.match(await sim.out('ip -br a'), /10\.10\.10\.5\/24 10\.10\.10\.78\/8/);
  assert.match(await sim.out('ip a show eth0'), /inet 10\.10\.10\.78\/8 brd 10\.255\.255\.255 scope global eth0:1/);
  assert.match(await sim.out('ping -c 1 10.10.10.78'), /64 bytes from 10\.10\.10\.78: icmp_seq=1 ttl=64/);
  await sim.run('sudo ifconfig eth0 add 10.1.1.1/24');
  assert.match(await sim.out('ip -br a'), /10\.1\.1\.1\/24/);
  await sim.run('sudo ifconfig eth0 del 10.1.1.1');
  assert.doesNotMatch(await sim.out('ip -br a'), /10\.1\.1\.1/);
  await sim.run('sudo ifconfig eth0:1 down');
  assert.doesNotMatch(await sim.out('ip -br a'), /10\.10\.10\.78/);
  assert.match(await sim.out('ip -br a'), /eth0 +UP +10\.10\.10\.5\/24/);
  const r = await sim.run('ifconfig eth0:1');
  assert.equal(r.code, 1);
  assert.match(r.err, /eth0:1: error fetching interface information: Device not found/);
});

test('nmcli: connection show --active, connection modify applies on up', async () => {
  const sim = await net();
  assert.match(await sim.out('nmcli con show --active'), /Wired connection 1 .*ethernet +eth0/);
  assert.equal((await sim.run('nmcli con mod "Wired connection 1" ipv4.method manual ipv4.addresses 10.10.10.77/24 ipv4.gateway 10.10.10.1 ipv4.dns 8.8.8.8')).code, 0);
  assert.match(await sim.out('nmcli con show "Wired connection 1"'), /ipv4\.addresses: +10\.10\.10\.77\/24/);
  assert.match(await sim.out('ip -br a'), /10\.10\.10\.5\/24/);   // not applied until the connection is brought up
  await sim.run('nmcli con up "Wired connection 1"');
  assert.match(await sim.out('ip -br a'), /eth0 +UP +10\.10\.10\.77\/24/);
  assert.match(await sim.out('ip r'), /^default via 10\.10\.10\.1 dev eth0 proto static metric 100/);
  assert.match(await sim.out('cat /etc/resolv.conf'), /nameserver 8\.8\.8\.8/);
  await sim.run('nmcli con mod "Wired connection 1" ipv4.method auto');
  await sim.run('nmcli con up "Wired connection 1"');
  assert.match(await sim.out('ip -br a'), /10\.10\.10\.5\/24/);
  assert.match(await sim.out('cat /etc/resolv.conf'), /nameserver 10\.10\.10\.53/);
  const bad = await sim.run('nmcli con mod nosuch ipv4.dns 1.1.1.1');
  assert.equal(bad.code, 10);
});

test('mtr: -s takes a size, -u selects UDP, -P sets the port', async () => {
  const sim = await net();
  const r = await sim.run('mtr -rn -c 2 -s 100 10.10.10.10');
  assert.equal(r.code, 0);
  assert.match(r.out, /1\.\|-- 10\.10\.10\.10/);
  assert.equal((await sim.run('mtr -rn -c 2 -u 10.10.10.10')).code, 0);
});

test('netstat -s prints the SNMP counter sections; -t and -u narrow them', async () => {
  const sim = await net();
  const all = await sim.out('netstat -s');
  assert.match(all, /^Ip:\n {4}Forwarding: 2\n {4}\d+ total packets received/);
  for (const sec of ['Icmp:', 'IcmpMsg:', 'Tcp:', 'Udp:', 'TcpExt:', 'IpExt:']) assert.ok(all.includes('\n' + sec + '\n'), sec);
  const tcp = await sim.out('netstat -st');
  assert.match(tcp, /^Tcp:\n/m);
  assert.doesNotMatch(tcp, /^Udp:/m);
  assert.doesNotMatch(await sim.out('netstat -su'), /^Tcp:/m);
});

test('ping -f as root prints no per-reply lines and the ipg/ewma summary', async () => {
  const sim = await net();
  const r = await sim.run('sudo ping -f -c 20 10.10.10.10');
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /bytes from/);
  assert.match(r.out, /20 packets transmitted, 20 received, 0% packet loss, time \d+ms\nrtt min\/avg\/max\/mdev = [\d.\/]+ ms, ipg\/ewma \d+\.\d{3}\/\d+\.\d{3} ms\n$/);
  const u = await sim.run('ping -f -c 5 10.10.10.10');
  assert.equal(u.code, 2);
});

test('ping: inet_aton shorthand addresses, kali resolves to itself by name', async () => {
  const sim = await net();
  assert.match(await sim.out('ping -c 1 127.1'), /^PING 127\.1 \(127\.0\.0\.1\) 56\(84\) bytes of data\.\n64 bytes from 127\.0\.0\.1: icmp_seq=1/);
  assert.match(await sim.out('ping -c 1 0x7f000001'), /^PING 0x7f000001 \(127\.0\.0\.1\)/);
  assert.match(await sim.out('ping -c 1 10.10.10'), /^PING 10\.10\.10 \(10\.10\.0\.10\)/);
  assert.match(await sim.out('ping -c 1 kali'), /64 bytes from kali \(127\.0\.1\.1\)/);
  for (const bad of ['08', '300.1.1.1', '1.2.3.4.5']) {
    const r = await sim.run('ping -c 1 ' + bad);
    assert.equal(r.code, 2, bad);
    assert.equal(r.err, 'ping: ' + bad + ': Name or service not known\n');
  }
});

test('ping -M do: packets larger than the MTU fail locally, and a lowered MTU is honoured', async () => {
  const sim = await net();
  const r = await sim.run('ping -c 2 -M do -s 1473 10.10.10.10');
  assert.equal(r.code, 1);
  assert.equal(r.err, 'ping: local error: message too long, mtu=1500\nping: local error: message too long, mtu=1500\n');
  assert.match(r.out, /2 packets transmitted, 0 received, \+2 errors, 100% packet loss/);
  assert.match(await sim.out('ping -c 1 -M do -s 1472 10.10.10.10'), /1480 bytes from/);
  assert.match(await sim.out('ping -c 1 -s 1473 10.10.10.10'), /1481 bytes from/);   // without DF the packet is fragmented
  await sim.run('sudo ip link set eth0 mtu 1400');
  assert.match((await sim.run('ping -c 1 -M do -s 1400 10.10.10.10')).err, /mtu=1400/);
  assert.equal((await sim.run('ping -c 1 -M bogus 10.10.10.10')).err, "ping: invalid argument: 'bogus'\n");
});

test('route accepts -4 and -6 as address-family flags', async () => {
  const sim = await net();
  const r = await sim.run('route -4n');
  assert.equal(r.code, 0);
  assert.match(r.out, /^Kernel IP routing table\nDestination/);
});

test('ip -j neigh prints JSON, [] when the table is empty', async () => {
  const sim = await net();
  await sim.run('sudo ip neigh flush all');
  assert.equal(await sim.out('ip -j neigh'), '[]\n');
  await sim.run('ping -c 1 10.10.10.10');
  const rows = JSON.parse(await sim.out('ip -j neigh'));
  assert.equal(rows[0].dst, '10.10.10.10');
  assert.deepEqual(rows[0].state, ['REACHABLE']);
  assert.match(rows[0].lladdr, /^00:0c:29:/);
});
