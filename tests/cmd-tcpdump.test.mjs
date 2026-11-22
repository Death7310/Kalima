// tcpdump pack: live capture, filters, ambient traffic, -w/-r, payload display.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

async function lab(opts) {
  const sim = await boot(opts);
  sim.machine.sudoStamp.kali = sim.K.clock.now();
  return sim;
}

const settle = () => new Promise((res) => setTimeout(res, 20));

/** Start `sudo tcpdump <args>` in the background (output to /tmp/cap.txt), run `traffic`, wait for it, return the file. */
async function capture(sim, args, traffic) {
  await sim.run('sudo tcpdump ' + args + ' > /tmp/cap.txt 2>&1 &');
  await settle();
  if (traffic) await sim.run(traffic);
  const done = await Promise.race([sim.run('wait').then(() => true), new Promise((res) => setTimeout(() => res(false), 4000))]);
  if (!done) await sim.run('kill %1');
  const text = (await sim.run('cat /tmp/cap.txt')).out;
  assert.ok(done, 'capture did not finish by itself:\n' + text);
  return text;
}

/** Lines of a capture without the two header lines and the three summary lines. */
const packets = (text) => text.split('\n').filter((l) => /^(\d\d:|\d{4}-|\d+\.\d{6} |\t0x)/.test(l) || /^\s{4}\S/.test(l));

/** Run a line on the real clock and press Ctrl-C after a moment. */
async function interrupted(sim, line, afterMs = 30) {
  const { K, shell, term } = sim;
  K.clock.useReal(); K.settings.timeScale = 1;
  sim.machine.sudoStamp.kali = Date.now();
  term.take();
  const pending = shell.runLine(line);
  setTimeout(() => term.raiseInterrupt(), afterMs);
  const code = await pending;
  return { code, output: K.util.stripAnsi(term.take()) };
}

/* -------------------------------------------------------------- permissions */

test('tcpdump: needs root', async () => {
  const sim = await lab();
  const r = await sim.run('tcpdump -c 1');
  assert.equal(r.code, 1);
  assert.equal(r.err, "tcpdump: eth0: You don't have permission to perform this packet capture on that device\n(socket: Operation not permitted)\n");
  const any = await sim.run('tcpdump -i any');
  assert.match(any.err, /^tcpdump: any: You don't have permission/);
});

test('tcpdump: -D and --version need no root', async () => {
  const sim = await lab();
  const d = await sim.run('tcpdump -D');
  assert.equal(d.code, 0);
  assert.match(d.out, /^1\.eth0 \[Up, Running, Connected\]\n2\.any \(Pseudo-device that captures on all interfaces\) \[Up, Running\]\n3\.lo \[Up, Running, Loopback\]\n/);
  const v = await sim.run('tcpdump --version');
  assert.match(v.out, /^tcpdump version 4\.99\.\d\nlibpcap version 1\.10\./);
});

test('tcpdump: option errors', async () => {
  const sim = await lab();
  const bad = await sim.run('tcpdump -j9x');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^tcpdump: /);
  const odd = await sim.run('tcpdump --nonsense');
  assert.match(odd.err, /^tcpdump: unrecognized option '--nonsense'\nUsage: tcpdump /);
  assert.equal((await sim.run('sudo tcpdump -c x')).err.trim(), 'tcpdump: invalid packet count x');
  assert.equal((await sim.run('sudo tcpdump -c 0')).err.trim(), 'tcpdump: invalid packet count 0');
  assert.equal((await sim.run('sudo tcpdump -i nosuch0')).err.trim(), 'tcpdump: nosuch0: No such device exists');
  assert.match((await sim.run('tcpdump --help')).out, /^tcpdump version .*\nlibpcap version .*\nUsage: tcpdump /);
});

/* ------------------------------------------------------------ live capture */

test('tcpdump: ICMP from a ping in the same shell, headers and summary', async () => {
  const sim = await lab();
  const text = await capture(sim, '-n -c 4 icmp', 'ping -c 2 10.10.10.10 >/dev/null');
  assert.match(text, /^tcpdump: verbose output suppressed, use -v\[v\]\.\.\. for full protocol decode\nlistening on eth0, link-type EN10MB \(Ethernet\), snapshot length 262144 bytes\n/);
  const lines = packets(text);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^\d\d:\d\d:\d\d\.\d{6} IP 10\.10\.10\.5 > 10\.10\.10\.10: ICMP echo request, id \d+, seq 1, length 64$/);
  assert.match(lines[1], / IP 10\.10\.10\.10 > 10\.10\.10\.5: ICMP echo reply, id \d+, seq 1, length 64$/);
  assert.match(lines[2], /seq 2, length 64$/);
  assert.match(text, /4 packets captured\n4 packets received by filter\n0 packets dropped by kernel\n$/);
});

test('tcpdump: names are resolved unless -n', async () => {
  const sim = await lab();
  const text = await capture(sim, '-c 2 icmp', 'ping -c 1 10.10.10.10 >/dev/null');
  assert.match(packets(text)[0], / IP kali > web01\.halcyon\.lab: ICMP echo request/);
  assert.match(packets(text)[1], / IP web01\.halcyon\.lab > kali: ICMP echo reply/);
});

test('tcpdump: TCP handshake, flags, seq, win and length', async () => {
  const sim = await lab();
  const text = await capture(sim, '-nn -c 5 tcp', 'curl -s http://10.10.10.10/ >/dev/null');
  const l = packets(text);
  assert.match(l[0], /^\S+ IP 10\.10\.10\.5\.\d+ > 10\.10\.10\.10\.80: Flags \[S\], seq (\d+), win 64240, options \[mss 1460,sackOK,TS val \d+ ecr 0,nop,wscale 7\], length 0$/);
  const isn = /seq (\d+)/.exec(l[0])[1];
  assert.match(l[1], new RegExp('IP 10\\.10\\.10\\.10\\.80 > 10\\.10\\.10\\.5\\.\\d+: Flags \\[S\\.\\], seq \\d+, ack ' + (Number(isn) + 1) + ', win 65160, options'));
  assert.match(l[2], /Flags \[\.\], ack 1, win 502, options \[nop,nop,TS val \d+ ecr \d+\], length 0$/);
  assert.match(l[3], /Flags \[P\.\], seq 1:\d+, ack 1, win 502, options .*, length \d+: HTTP: GET \/ HTTP\/1\.1$/);
  assert.match(l[4], /Flags \[\.\], ack \d+, win 509/);
});

test('tcpdump: a refused connection shows the reset', async () => {
  const sim = await lab();
  const text = await capture(sim, '-nn -c 2 host 10.10.10.10 and port 81', 'curl -s http://10.10.10.10:81/');
  const l = packets(text);
  assert.match(l[0], /: Flags \[S\], seq \d+, win 64240/);
  assert.match(l[1], /10\.10\.10\.10\.81 > 10\.10\.10\.5\.\d+: Flags \[R\.\], seq 0, ack \d+, win 0, length 0$/);
});

test('tcpdump: -c ends the capture by itself, -q shortens lines', async () => {
  const sim = await lab();
  const r = await sim.run('sudo tcpdump -q -nn -c 3');
  assert.equal(r.code, 0);
  assert.equal(packets(r.out).length, 3);
  assert.match(r.err, /3 packets captured\n3 packets received by filter\n0 packets dropped by kernel\n$/);
  const one = await sim.run('sudo tcpdump -c 1');
  assert.match(one.err, /1 packet captured\n1 packet received by filter\n0 packets dropped/);
});

test('tcpdump: Ctrl-C prints the summary and exits 0', async () => {
  const sim = await lab();
  const r = await interrupted(sim, 'sudo tcpdump -n icmp', 40);
  assert.equal(r.code, 0);
  assert.match(r.output, /listening on eth0/);
  assert.match(r.output, /0 packets captured\n0 packets received by filter\n0 packets dropped by kernel\n/);
});

test('tcpdump: -v, -e and timestamp styles', async () => {
  const sim = await lab();
  const v = await capture(sim, '-nn -v -c 1 icmp', 'ping -c 1 10.10.10.10 >/dev/null');
  assert.match(v, /^tcpdump: listening on eth0/);
  assert.match(v, /IP \(tos 0x0, ttl 64, id \d+, offset 0, flags \[DF\], proto ICMP \(1\), length 84\)\n    10\.10\.10\.5 > 10\.10\.10\.10: ICMP echo request/);
  const e = await capture(sim, '-nn -e -c 1 icmp', 'ping -c 1 10.10.10.10 >/dev/null');
  assert.match(packets(e)[0], /^\S+ 08:00:27:1d:77:55 > 00:0c:29:46:b5:18, ethertype IPv4 \(0x0800\), length 98: IP 10\.10\.10\.5 > 10\.10\.10\.10: ICMP/);
  const t = await capture(sim, '-nn -t -c 1 icmp', 'ping -c 1 10.10.10.10 >/dev/null');
  assert.match(t, /\nIP 10\.10\.10\.5 > 10\.10\.10\.10: ICMP echo request/);
  const tt = await capture(sim, '-nn -tt -c 1 icmp', 'ping -c 1 10.10.10.10 >/dev/null');
  assert.match(tt, /\n\d{10}\.\d{6} IP 10\.10\.10\.5 > /);
  const tttt = await capture(sim, '-nn -tttt -c 1 icmp', 'ping -c 1 10.10.10.10 >/dev/null');
  assert.match(tttt, /\n2026-11-\d\d \d\d:\d\d:\d\d\.\d{6} IP 10\.10\.10\.5 > /);
  const ttt = await capture(sim, '-nn -ttt -c 2 icmp', 'ping -c 1 10.10.10.10 >/dev/null');
  assert.match(packets(ttt)[0], /^00:00:00\.000000 IP /);
  assert.match(packets(ttt)[1], /^00:00:00\.000\d{3} IP /);
});

test('tcpdump: -i any adds the interface and direction column', async () => {
  const sim = await lab();
  const text = await capture(sim, '-nn -i any -c 2 icmp', 'ping -c 1 10.10.10.10 >/dev/null');
  assert.match(text, /listening on any, link-type LINUX_SLL2 \(Linux cooked v2\), snapshot length 262144 bytes/);
  assert.match(packets(text)[0], /^\S+ eth0  Out IP 10\.10\.10\.5 > /);
  assert.match(packets(text)[1], /^\S+ eth0  In  IP 10\.10\.10\.10 > /);
});

test('tcpdump: -i lo sees loopback pings only', async () => {
  const sim = await lab();
  const text = await capture(sim, '-nn -i lo -c 1', 'ping -c 1 10.10.10.10 >/dev/null; ping -c 1 127.0.0.1 >/dev/null');
  assert.match(packets(text)[0], /IP 127\.0\.0\.1 > 127\.0\.0\.1: ICMP echo request/);
  assert.ok(!text.includes('10.10.10.10'));
});

test('tcpdump: DNS lookups appear in tcpdump format', async () => {
  const sim = await lab();
  const text = await capture(sim, '-nn -c 2 port 53', 'dig +short www.halcyon.lab >/dev/null');
  const l = packets(text);
  assert.match(l[0], /IP 10\.10\.10\.5\.\d+ > 10\.10\.10\.53\.53: (\d+)\+ A\? www\.halcyon\.lab\. \(\d+\)$/);
  assert.match(l[1], /IP 10\.10\.10\.53\.53 > 10\.10\.10\.5\.\d+: \d+\*? 1\/\d\/\d CNAME|IP 10\.10\.10\.53\.53 > 10\.10\.10\.5\.\d+: \d+\*? \d\/\d\/\d /);
});

/* ----------------------------------------------------------------- filters */

test('tcpdump: host, src host, dst host and net filters', async () => {
  const sim = await lab();
  const traffic = 'ping -c 1 10.10.10.10 >/dev/null; ping -c 1 10.10.10.30 >/dev/null';
  const host = await capture(sim, '-nn -c 2 host 10.10.10.30', traffic);
  assert.ok(packets(host).every((l) => l.includes('10.10.10.30')));
  const src = await capture(sim, '-nn -c 1 src host 10.10.10.30', traffic);
  assert.match(packets(src)[0], /IP 10\.10\.10\.30 > 10\.10\.10\.5/);
  const dst = await capture(sim, '-nn -c 1 dst host 10.10.10.10', traffic);
  assert.match(packets(dst)[0], /IP 10\.10\.10\.5 > 10\.10\.10\.10/);
  const net = await capture(sim, '-nn -c 2 net 10.10.10.0/28 and icmp', traffic);
  assert.ok(packets(net).every((l) => l.includes('10.10.10.10')));
  const byName = await capture(sim, '-nn -c 1 host web01', traffic);
  assert.match(packets(byName)[0], /10\.10\.10\.10/);
});

test('tcpdump: port, src port, dst port, tcp, udp', async () => {
  const sim = await lab();
  const traffic = 'curl -s http://10.10.10.10/ >/dev/null; curl -s http://10.10.10.10:81/';
  const dst = await capture(sim, '-nn -c 2 dst port 80', traffic);
  assert.ok(packets(dst).every((l) => /> 10\.10\.10\.10\.80:/.test(l)));
  const src = await capture(sim, '-nn -c 2 src port 80', traffic);
  assert.ok(packets(src).every((l) => /10\.10\.10\.10\.80 >/.test(l)));
  const either = await capture(sim, '-nn -c 2 tcp port 81', traffic);
  assert.ok(packets(either).every((l) => /\.81\b/.test(l)));
  const udp = await capture(sim, '-nn -c 2 udp and port 53', 'dig www.halcyon.lab >/dev/null');
  assert.ok(packets(udp).every((l) => /\.53\b/.test(l)));
  const named = await capture(sim, '-n -c 1 port http', 'curl -s http://10.10.10.10/ >/dev/null');
  assert.match(packets(named)[0], /\.http: Flags/);
});

test('tcpdump: and, or, not and parentheses', async () => {
  const sim = await lab();
  const traffic = 'ping -c 1 10.10.10.10 >/dev/null; curl -s http://10.10.10.30:3306/ >/dev/null; curl -s http://10.10.10.10/ >/dev/null';
  const notIcmp = await capture(sim, '-nn -c 2 not icmp and host 10.10.10.10', traffic);
  assert.ok(packets(notIcmp).every((l) => /Flags/.test(l)));
  const either = await capture(sim, '-nn -c 3 icmp or port 3306', traffic);
  assert.ok(packets(either).some((l) => /ICMP/.test(l)) && packets(either).some((l) => /\.3306/.test(l)));
  const grouped = await capture(sim, '-nn -c 2 "(icmp or tcp) and src host 10.10.10.10"', traffic);
  assert.ok(packets(grouped).every((l) => /IP 10\.10\.10\.10[. ]/.test(l)));
  const bang = await capture(sim, '-nn -c 1 ! icmp and ! arp and ! udp', traffic);
  assert.match(packets(bang)[0], /Flags \[S\]/);
  const list = await capture(sim, '-nn -c 3 tcp port 80 or 3306', traffic);
  assert.equal(packets(list).length, 3);
});

test('tcpdump: bad filter expressions fail like libpcap', async () => {
  const sim = await lab();
  for (const bad of ['host', 'port 80 and', '(host 10.10.10.10', 'icmp or or tcp', 'not', 'tcp )', 'src']) {
    const r = await sim.run("sudo tcpdump -c 1 '" + bad + "'");
    assert.equal(r.code, 1, bad);
    assert.equal(r.err, 'tcpdump: syntax error\n', bad);
  }
  assert.equal((await sim.run('sudo tcpdump host nosuchhost.invalid')).err, "tcpdump: unknown host 'nosuchhost.invalid'\n");
  assert.equal((await sim.run('sudo tcpdump port nosuchport')).err, "tcpdump: unknown port 'nosuchport'\n");
});

test('tcpdump: permission is checked before the filter', async () => {
  const sim = await lab();
  assert.match((await sim.run('tcpdump host')).err, /^tcpdump: eth0: You don't have permission/);
});

/* ----------------------------------------------------------------- ambient */

test('tcpdump: ambient ARP, DNS, NTP and mDNS traffic shows up on an idle segment', async () => {
  const sim = await lab();
  const r = await sim.run('sudo tcpdump -n -c 40');
  const lines = packets(r.out);
  assert.equal(lines.length, 40);
  assert.ok(lines.some((l) => /ARP, Request who-has 10\.10\.10\.\d+ tell 10\.10\.10\.\d+, length \d+$/.test(l)), 'arp request');
  assert.ok(lines.some((l) => /ARP, Reply 10\.10\.10\.\d+ is-at ([0-9a-f]{2}:){5}[0-9a-f]{2}, length \d+$/.test(l)), 'arp reply');
  assert.ok(lines.some((l) => /\.domain: \d+\+ A\? \S+\. \(\d+\)$/.test(l) && /> 10\.10\.10\.53\./.test(l)), 'dns query');
  assert.ok(lines.some((l) => /10\.10\.10\.53\.domain > .*: \d+\* 1\/0\/0 A \d/.test(l)), 'dns reply');
  assert.ok(lines.some((l) => /\.ntp: NTPv4, Client, length 48$/.test(l)), 'ntp');
  assert.ok(lines.some((l) => /> 224\.0\.0\.251\.mdns: .*PTR \(QM\)\? _ipp\._tcp\.local\./.test(l)), 'mdns');
});

test('tcpdump: ambient traffic stays off when capturing on lo and respects filters', async () => {
  const sim = await lab();
  const arp = await sim.run('sudo tcpdump -nn -c 3 arp');
  assert.ok(packets(arp.out).every((l) => /ARP,/.test(l)));
  const dns = await sim.run('sudo tcpdump -nn -c 2 port 53');
  assert.ok(packets(dns.out).every((l) => /\.53\b/.test(l)));
});

test('tcpdump: ARP lines with -e and -nn', async () => {
  const sim = await lab();
  const r = await sim.run('sudo tcpdump -nne -c 1 arp');
  assert.match(packets(r.out)[0], /^\S+ ([0-9a-f]{2}:){5}[0-9a-f]{2} > ff:ff:ff:ff:ff:ff, ethertype ARP \(0x0806\), length (42|60): Request who-has /);
});

/* ------------------------------------------------------------ -w and -r */

test('tcpdump: -w writes a capture file, -r reads it back without root', async () => {
  const sim = await lab();
  const w = await capture(sim, '-c 4 -w /tmp/ping.pcap icmp', 'ping -c 2 10.10.10.10 >/dev/null');
  assert.match(w, /^tcpdump: listening on eth0, link-type EN10MB \(Ethernet\), snapshot length 262144 bytes\n4 packets captured\n4 packets received by filter\n0 packets dropped by kernel\n$/);
  assert.ok(sim.machine.vfs && (await sim.run('test -s /tmp/ping.pcap')).code === 0);
  const r = await sim.run('tcpdump -nr /tmp/ping.pcap');
  assert.equal(r.code, 0);
  assert.equal(r.err, 'reading from file /tmp/ping.pcap, link-type EN10MB (Ethernet), snapshot length 262144\n');
  const l = r.out.trim().split('\n');
  assert.equal(l.length, 4);
  assert.match(l[0], /^\d\d:\d\d:\d\d\.\d{6} IP 10\.10\.10\.5 > 10\.10\.10\.10: ICMP echo request, id \d+, seq 1, length 64$/);
});

test('tcpdump: -r takes filters and -c, and works in pipelines', async () => {
  const sim = await lab();
  await capture(sim, '-c 8 -w /tmp/web.pcap host 10.10.10.10', 'curl -s http://10.10.10.10/ >/dev/null');
  assert.equal((await sim.run('tcpdump -nr /tmp/web.pcap -c 2')).out.trim().split('\n').length, 2);
  const syn = await sim.run('tcpdump -nr /tmp/web.pcap "tcp[tcpflags] & tcp-syn != 0"');
  assert.deepEqual(syn.out.trim().split('\n').map((l) => /Flags \[(S\.?)\]/.exec(l)[1]), ['S', 'S.']);
  assert.equal((await sim.run('tcpdump -nr /tmp/web.pcap "tcp[13] = 16"')).out.trim().split('\n').length >= 2, true);
  assert.equal((await sim.run('tcpdump -nr /tmp/web.pcap "tcp[tcpflags] == 99 or icmp[icmptype] == icmp-echo"')).out, '');
  assert.equal((await sim.run('tcpdump -r /tmp/web.pcap "icmp[tcpflags] == 1"')).err, 'tcpdump: syntax error\n');
  const http = await sim.run('tcpdump -nr /tmp/web.pcap | grep -c HTTP');
  assert.equal(http.out.trim(), '2');
  const q = await sim.run('tcpdump -qnr /tmp/web.pcap src port 80 and greater 100');
  assert.match(q.out, /10\.10\.10\.10\.http > 10\.10\.10\.5\.\d+: tcp 1448\n/);
  assert.equal((await sim.run('tcpdump -r /tmp/web.pcap -tn icmp')).out, '');
  const stdin = await sim.run('cat /tmp/web.pcap | tcpdump -nr - -c 1');
  assert.match(stdin.out, /Flags \[S\]/);
});

test('tcpdump: -r errors', async () => {
  const sim = await lab();
  assert.equal((await sim.run('tcpdump -r /tmp/nope.pcap')).err, 'tcpdump: /tmp/nope.pcap: No such file or directory\n');
  await sim.run('echo hello > /tmp/notpcap');
  assert.equal((await sim.run('tcpdump -r /tmp/notpcap')).err, 'tcpdump: /tmp/notpcap: unknown file format\n');
  assert.match((await sim.run('sudo tcpdump -c 1 -w /nonexistent/dir/x.pcap')).err, /tcpdump: \/nonexistent\/dir\/x\.pcap: No such file or directory/);
});

test('tcpdump: a written capture keeps the TCP numbers consistent', async () => {
  const sim = await lab();
  await capture(sim, '-c 8 -w /tmp/c.pcap tcp', 'curl -s http://10.10.10.10/ >/dev/null');
  const r = await sim.run('tcpdump -nnSr /tmp/c.pcap -c 2');
  const [a, b] = r.out.trim().split('\n');
  const isn = /seq (\d+)/.exec(a)[1];
  assert.match(b, new RegExp('ack ' + (Number(isn) + 1) + ','));
});

/* --------------------------------------------------------------- payloads */

test('tcpdump: -A shows the HTTP text', async () => {
  const sim = await lab();
  const text = await capture(sim, '-nn -A -c 6 port 80', 'curl -s http://10.10.10.10/ >/dev/null');
  assert.match(text, /GET \/ HTTP\/1\.1\nHost: 10\.10\.10\.10\nUser-Agent: curl\/[\d.]+\nAccept: \*\/\*\n/);
  assert.match(text, /HTTP\/1\.1 200 OK\n/);
  assert.match(text, /Server: nginx/);
});

test('tcpdump: -X prints hex and ASCII', async () => {
  const sim = await lab();
  const text = await capture(sim, '-nn -X -c 1 icmp', 'ping -c 1 10.10.10.10 >/dev/null');
  assert.match(text, /\t0x0000:  4500 0054 [0-9a-f]{4} 4000 4001 [0-9a-f]{4} 0a0a 0a05  E\.\.T/);
  assert.match(text, /\t0x0010:  0a0a 0a0a 0800 [0-9a-f]{4} [0-9a-f]{4} 0001 [0-9a-f]{4} [0-9a-f]{4}  /);
  assert.match(text, /\t0x0050:  3c3d 3e3f {32}<=>\?\n/);
  const http = await capture(sim, '-nn -X -c 4 port 80', 'curl -s http://10.10.10.10/ >/dev/null');
  assert.match(http, /GET \/ HTTP\/1\.1/);
});

test('tcpdump: -x prints hex without ASCII', async () => {
  const sim = await lab();
  const text = await capture(sim, '-nn -x -c 1 icmp', 'ping -c 1 10.10.10.10 >/dev/null');
  assert.match(text, /\t0x0000:  4500 0054 [0-9a-f]{4} 4000 4001 [0-9a-f]{4} 0a0a 0a05\n/);
});

test('tcpdump: HTTPS exchange shows lengths only, no payload text', async () => {
  const sim = await lab();
  const text = await capture(sim, '-nn -A -c 6 port 443', 'curl -sk https://10.10.10.10/ >/dev/null');
  assert.ok(!/GET \//.test(text));
  assert.match(packets(text).join('\n'), /Flags \[P\.\].*length 517/);
});

/* ---------------------------------------------------- scans and other tools */

test('tcpdump: a connect scan shows SYN, SYN-ACK and RST patterns', async () => {
  const sim = await lab();
  const text = await capture(sim, '-nn -c 8 host 10.10.10.30 and tcp', 'nmap -sT -p 22,81 10.10.10.30 >/dev/null');
  const l = packets(text);
  assert.ok(l.some((x) => /\.22: Flags \[S\],/.test(x)));
  assert.ok(l.some((x) => /10\.10\.10\.30\.22 > .*Flags \[S\.\],/.test(x)));
  assert.ok(l.some((x) => /10\.10\.10\.30\.81 > .*Flags \[R\.\], seq 0, ack \d+, win 0/.test(x)));
});
