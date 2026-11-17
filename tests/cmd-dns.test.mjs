// Name lookup pack: dig, host, nslookup, whois, resolvectl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

// A line counter of our own, so pipeline tests do not depend on another pack.
async function dnsSim() {
  const sim = await boot();
  const { K, machine } = sim;
  K.cmd.register({ name: 't-count', run(ctx) { ctx.out(String((ctx.stdin || '').split('\n').filter(Boolean).length) + '\n'); return 0; } });
  machine.installCommand(K.cmd.get('t-count'));
  return sim;
}

// Query ids, cookies and round-trip times vary: pin them so whole replies can be compared.
const stable = (s) => s.replace(/id: \d+/g, 'id: N').replace(/COOKIE: [0-9a-f]{48}/g, 'COOKIE: C')
  .replace(/Query time: \d+ msec/g, 'Query time: T msec').replace(/ in \d+ ms/g, ' in T ms');

test('dig prints a full BIND 9.20 reply', async () => {
  const sim = await dnsSim();
  const r = await sim.run('dig web01.halcyon.lab');
  assert.equal(r.code, 0);
  assert.equal(stable(r.out), [
    '',
    '; <<>> DiG 9.20.11-4-Debian <<>> web01.halcyon.lab',
    ';; global options: +cmd',
    ';; Got answer:',
    ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: N',
    ';; flags: qr aa rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1',
    '',
    ';; OPT PSEUDOSECTION:',
    '; EDNS: version: 0, flags:; udp: 1232',
    '; COOKIE: C (good)',
    ';; QUESTION SECTION:',
    ';web01.halcyon.lab.\t\tIN\tA',
    '',
    ';; ANSWER SECTION:',
    'web01.halcyon.lab.\t3600\tIN\tA\t10.10.10.10',
    '',
    ';; Query time: T msec',
    ';; SERVER: 10.10.10.53#53(10.10.10.53) (UDP)',
    ';; WHEN: Fri Nov 13 14:30:00 UTC 2026',
    ';; MSG SIZE  rcvd: 90',
    '',
    '',
  ].join('\n'));
});

test('dig lays records out on BIND column stops', async () => {
  const sim = await dnsSim();
  const ans = async (args) => (await sim.run('dig +noall +answer ' + args)).out;
  assert.equal(await ans('halcyon.lab mx'), 'halcyon.lab.\t\t3600\tIN\tMX\t10 mail01.halcyon.lab.\n');
  assert.equal(await ans('www.halcyon.lab'), 'www.halcyon.lab.\t3600\tIN\tCNAME\tweb01.halcyon.lab.\nweb01.halcyon.lab.\t3600\tIN\tA\t10.10.10.10\n');
  assert.equal(await ans('-t srv _ldap._tcp.halcyon.lab'), '_ldap._tcp.halcyon.lab.\t3600\tIN\tSRV\t0 100 389 dc01.halcyon.lab.\n');
  assert.equal(await ans('-x 10.10.10.10'), '10.10.10.10.in-addr.arpa. 3600\tIN\tPTR\tweb01.halcyon.lab.\n', 'a name past the ttl column is followed by one space');
  assert.equal(await ans('halcyon.lab soa'), 'halcyon.lab.\t\t3600\tIN\tSOA\tns1.halcyon.lab. hostmaster.halcyon.lab. 2026111201 3600 900 604800 86400\n');
  assert.equal(await ans('+nottlid +noclass web01.halcyon.lab'), 'web01.halcyon.lab.\tA\t10.10.10.10\n');
});

test('dig +short, option order and pipelines', async () => {
  const sim = await dnsSim();
  assert.equal((await sim.run('dig +short www.halcyon.lab')).out, 'web01.halcyon.lab.\n10.10.10.10\n');
  assert.equal((await sim.run('dig halcyon.lab TXT +short @10.10.10.53')).out, '"v=spf1 mx -all"\n');
  assert.equal((await sim.run('dig @10.10.10.53 +short mx halcyon.lab')).out, '10 mail01.halcyon.lab.\n');
  assert.equal((await sim.run('dig -x 10.10.10.40 +short')).out, 'mail01.halcyon.lab.\n');
  assert.equal((await sim.run('dig +short web01.halcyon.lab db01.halcyon.lab')).out, '10.10.10.10\n10.10.10.30\n');
  assert.equal((await sim.run('dig +short www.halcyon.lab | t-count')).out, '2\n');
  assert.equal(stable((await sim.run('dig +short +identify web01.halcyon.lab')).out), '10.10.10.10 from server 10.10.10.53 in T ms.\n');
  assert.equal((await sim.run('dig +short nosuch.halcyon.lab')).out, '', 'NXDOMAIN is silent in short form and still exits 0');
});

test('dig banner, server count and display flags', async () => {
  const sim = await dnsSim();
  const first = async (line, n) => (await sim.run(line)).out.split('\n').slice(0, n);
  assert.deepEqual(await first('dig @10.10.10.53 web01.halcyon.lab', 4), ['', '; <<>> DiG 9.20.11-4-Debian <<>> @10.10.10.53 web01.halcyon.lab', '; (1 server found)', ';; global options: +cmd']);
  assert.deepEqual(await first('dig web01.halcyon.lab @10.10.10.53', 3), ['', '; <<>> DiG 9.20.11-4-Debian <<>> web01.halcyon.lab @10.10.10.53', ';; global options: +cmd'], 'a server after the name is not counted');
  assert.deepEqual(await first('dig +nocmd web01.halcyon.lab', 1), [';; Got answer:']);
  const quiet = (await sim.run('dig +nocmd +nocomments +nostats web01.halcyon.lab')).out;
  assert.equal(quiet, ';web01.halcyon.lab.\t\tIN\tA\nweb01.halcyon.lab.\t3600\tIN\tA\t10.10.10.10\n');
  const tcp = (await sim.run('dig +tcp +noedns web01.halcyon.lab')).out;
  assert.match(tcp, /ADDITIONAL: 0\n\n;; QUESTION SECTION:/);
  assert.match(tcp, /;; SERVER: 10\.10\.10\.53#53\(10\.10\.10\.53\) \(TCP\)\n/);
  assert.match(tcp, /;; MSG SIZE {2}rcvd: 51\n/);
  assert.match((await sim.run('dig @ns1.halcyon.lab web01.halcyon.lab')).out, /;; SERVER: 10\.10\.10\.53#53\(ns1\.halcyon\.lab\) \(UDP\)/);
});

test('dig statuses: NXDOMAIN, no data, refused recursion, root', async () => {
  const sim = await dnsSim();
  const nx = stable((await sim.run('dig nosuch.halcyon.lab')).out);
  assert.match(nx, /status: NXDOMAIN, id: N\n;; flags: qr aa rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1\n/);
  assert.match(nx, /;nosuch\.halcyon\.lab\.\t\tIN\tA\n\n;; AUTHORITY SECTION:\nhalcyon\.lab\.\t\t3600\tIN\tSOA\tns1\.halcyon\.lab\. hostmaster\.halcyon\.lab\. 2026111201 3600 900 604800 86400\n\n;; Query time/);
  const refused = (await sim.run('dig @10.10.10.50 example.com')).out;
  assert.match(refused, /status: REFUSED, id: \d+\n;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1\n;; WARNING: recursion requested but not available\n\n;; OPT/);
  const rootNs = (await sim.run('dig')).out;
  assert.match(rootNs, /<<>> DiG 9\.20\.11-4-Debian <<>>\n;; global options: \+cmd\n/);
  assert.match(rootNs, /ANSWER: 13,/);
  assert.match(rootNs, /;\.\t\t\t\tIN\tNS\n\n;; ANSWER SECTION:\n\.\t\t\t518400\tIN\tNS\ta\.root-servers\.net\.\n/);
  const pub = (await sim.run('dig @8.8.8.8 example.com')).out;
  assert.match(pub, /flags: qr rd ra; QUERY: 1, ANSWER: 1/);
  assert.doesNotMatch(pub, /COOKIE/);
  assert.match(pub, /example\.com\.\t\t300\tIN\tA\t93\.184\.215\.14\n/);
  assert.match(pub, /MSG SIZE {2}rcvd: 56\n/);
});

test('dig failures: silent servers, bad arguments', async () => {
  const sim = await dnsSim();
  const before = sim.K.clock.now();
  const dead = await sim.run('dig @10.10.10.99 web01.halcyon.lab');
  assert.equal(dead.code, 9);
  assert.equal(dead.out, ';; communications error to 10.10.10.99#53: timed out\n'.repeat(3) +
    '\n; <<>> DiG 9.20.11-4-Debian <<>> @10.10.10.99 web01.halcyon.lab\n; (1 server found)\n;; global options: +cmd\n;; no servers could be reached\n\n');
  assert.equal(sim.K.clock.now() - before, 15000, 'three tries of five seconds');
  const quick = await sim.run('dig +time=1 +tries=2 @10.10.10.99 web01.halcyon.lab');
  assert.equal(quick.out.match(/timed out/g).length, 2);
  const closed = await sim.run('dig @10.10.10.10 web01.halcyon.lab');
  assert.match(closed.out, /^;; communications error to 10\.10\.10\.10#53: connection refused\n/);
  assert.equal(closed.code, 9);
  const port = await sim.run('dig -p 5353 @10.10.10.53 web01.halcyon.lab');
  assert.match(port.out, /communications error to 10\.10\.10\.53#5353: connection refused/);

  const bad = await sim.run('dig +bogus example.com');
  assert.equal(bad.code, 1);
  assert.equal(bad.err, 'Invalid option: +bogus\nUsage:  dig [@global-server] [domain] [q-type] [q-class] {q-opt}\n' +
    '            {global-d-opt} host [@local-server] {local-d-opt}\n            [ host [@local-server] {local-d-opt} [...]]\n\n' +
    'Use "dig -h" (or "dig -h | more") for complete list of options\n');
  assert.match((await sim.run('dig +sh example.com')).err, /^Invalid option: \+sh\n/, 'ambiguous abbreviation');
  assert.match((await sim.run('dig +yaml example.com')).err, /^Invalid option: \+yaml\n/, 'real but unsupported keyword');
  assert.match((await sim.run('dig -Z example.com')).err, /^Invalid option: -Z\n/);
  const noServer = await sim.run('dig @ns.nonexistent.example web01.halcyon.lab');
  assert.equal(noServer.code, 10);
  assert.equal(noServer.err, "dig: couldn't get address for 'ns.nonexistent.example': not found\n");
  const warn = await sim.run('dig -t bogus +short web01.halcyon.lab');
  assert.equal(warn.err, ';; Warning, ignoring invalid type bogus\n');
  assert.equal(warn.out, '10.10.10.10\n');
  assert.equal((await sim.run('dig -v')).err, 'DiG 9.20.11-4-Debian\n');
  const help = await sim.run('dig -h');
  assert.equal(help.code, 0);
  assert.match(help.out, /^Usage: {2}dig \[@global-server\]/);
  assert.match(help.out, /\+\[no\]short/);
});

test('dig axfr transfers the zone or reports the refusal', async () => {
  const sim = await dnsSim();
  const r = await sim.run('dig axfr halcyon.lab @10.10.10.53');
  assert.equal(r.code, 0);
  const lines = stable(r.out).split('\n');
  assert.deepEqual(lines.slice(0, 4), ['', '; <<>> DiG 9.20.11-4-Debian <<>> axfr halcyon.lab @10.10.10.53', ';; global options: +cmd',
    'halcyon.lab.\t\t3600\tIN\tSOA\tns1.halcyon.lab. hostmaster.halcyon.lab. 2026111201 3600 900 604800 86400']);
  assert.ok(lines.includes('_kerberos._tcp.halcyon.lab. 3600 IN\tSRV\t0 100 88 dc01.halcyon.lab.'));
  assert.ok(lines.includes('backup01.halcyon.lab.\t3600\tIN\tA\t10.10.10.90'));
  assert.deepEqual(lines.slice(-7), ['halcyon.lab.\t\t3600\tIN\tSOA\tns1.halcyon.lab. hostmaster.halcyon.lab. 2026111201 3600 900 604800 86400',
    ';; Query time: T msec', ';; SERVER: 10.10.10.53#53(10.10.10.53) (TCP)', ';; WHEN: Fri Nov 13 14:30:00 UTC 2026',
    ';; XFR size: 21 records (messages 1, bytes 565)', '', '']);
  assert.equal((await sim.run('dig axfr halcyon.lab')).out.split('\n').length, lines.length, 'the default resolver is used without @server');
  assert.equal((await sim.run('dig +noall +answer +onesoa -t axfr halcyon.lab | t-count')).out, '20\n');

  const refused = await sim.run('dig axfr halcyonfreight.example @203.0.113.53');
  assert.equal(refused.out, '\n; <<>> DiG 9.20.11-4-Debian <<>> axfr halcyonfreight.example @203.0.113.53\n;; global options: +cmd\n; Transfer failed.\n');
  assert.equal(refused.code, 0);
  assert.match((await sim.run('dig @8.8.8.8 axfr halcyon.lab')).out, /; \(1 server found\)\n;; global options: \+cmd\n; Transfer failed\.\n$/, 'not authoritative');
  const down = await sim.run('dig axfr halcyon.lab @10.10.10.10');
  assert.equal(down.code, 9);
  assert.match(down.out, /^;; Connection to 10\.10\.10\.10#53\(10\.10\.10\.10\) for halcyon\.lab failed: connection refused\.\n/);
  assert.match(down.out, /;; no servers could be reached\n\n$/);
});

test('dig +trace walks the delegations; lab names stop at the root', async () => {
  const sim = await dnsSim();
  const r = await sim.run('dig +trace www.kali.org');
  assert.equal(r.code, 0);
  const blocks = stable(r.out).split('\n\n');
  assert.match(blocks[0], /^\n; <<>> DiG 9\.20\.11-4-Debian <<>> \+trace www\.kali\.org\n;; global options: \+cmd\n\.\t\t\t518400\tIN\tNS\ta\.root-servers\.net\.\n/);
  assert.match(blocks[0], /;; Received 239 bytes from 10\.10\.10\.53#53\(10\.10\.10\.53\) in T ms$/);
  assert.match(blocks[1], /^org\.\t\t\t172800\tIN\tNS\ta\.nic\.org\.\n[^]*;; Received \d+ bytes from [\d.]+#53\([a-m]\.root-servers\.net\) in T ms$/);
  assert.match(blocks[2], /^kali\.org\.\t\t172800\tIN\tNS\tns1\.kali\.org\.\n[^]*\([a-d]\.nic\.org\) in T ms$/);
  assert.match(blocks[3], /^www\.kali\.org\.\t\t300\tIN\tA\t104\.18\.4\.159\n[^]*\(ns[12]\.kali\.org\) in T ms$/);
  const lab = stable((await sim.run('dig +trace web01.halcyon.lab')).out).split('\n\n');
  assert.equal(lab.length, 3);
  assert.match(lab[1], /^\.\t\t\t86400\tIN\tSOA\ta\.root-servers\.net\. nstld\.verisign-grs\.com\. 2026111300 1800 900 604800 86400\n;; Received \d+ bytes from [\d.]+#53\([a-m]\.root-servers\.net\)/);
  const gone = (await sim.run('dig +trace www.nonexistent-shop.com')).out.split('\n\n');
  assert.match(gone[1], /^com\.\t\t\t172800\tIN\tNS\ta\.gtld-servers\.net\.\n/);
  assert.match(gone[2], /^com\.\t\t\t900\tIN\tSOA\ta\.gtld-servers\.net\. hostmaster\.nic\.com\. /);
  sim.K.net.state.wan = false;
  const cut = await sim.run('dig +trace +tries=1 www.kali.org');
  assert.equal(cut.code, 9);
  assert.match(cut.out, /;; communications error to [\d.]+#53: timed out\n;; no servers could be reached\n\n$/);
});

test('dig asks BIND about itself in the CHAOS class and sends ANY over TCP', async () => {
  const sim = await dnsSim();
  const v = await sim.run('dig @10.10.10.53 version.bind chaos txt');
  assert.match(v.out, /status: NOERROR, id: \d+\n;; flags: qr aa rd; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1\n;; WARNING: recursion requested but not available\n/);
  assert.match(v.out, /;version\.bind\.\t\t\tCH\tTXT\n\n;; ANSWER SECTION:\nversion\.bind\.\t\t0\tCH\tTXT\t"9\.20\.11-Debian"\n/);
  assert.equal((await sim.run('dig +short -c CH -t TXT hostname.bind @10.10.10.53')).out, '"ns1"\n');
  assert.match((await sim.run('dig @8.8.8.8 version.bind CH TXT')).out, /status: REFUSED/);
  const any = (await sim.run('dig any halcyon.lab')).out;
  assert.match(any, /ANSWER: 3,/);
  assert.match(any, /\(TCP\)\n/);
  assert.match((await sim.run('dig +notcp any halcyon.lab')).out, /\(UDP\)\n/);
});
