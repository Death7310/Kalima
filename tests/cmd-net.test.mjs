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
