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

test('host: addresses, aliases, mail, reverse and search list', async () => {
  const sim = await dnsSim();
  const out = async (line) => (await sim.run(line)).out;
  assert.equal(await out('host web01.halcyon.lab'), 'web01.halcyon.lab has address 10.10.10.10\n');
  assert.equal(await out('host www.halcyon.lab'), 'www.halcyon.lab is an alias for web01.halcyon.lab.\nweb01.halcyon.lab has address 10.10.10.10\n');
  assert.equal(await out('host halcyon.lab'), 'halcyon.lab mail is handled by 10 mail01.halcyon.lab.\n');
  assert.equal(await out('host web01'), 'web01.halcyon.lab has address 10.10.10.10\n', 'single labels go through the search list');
  assert.equal(await out('host 10.10.10.40'), '40.10.10.10.in-addr.arpa domain name pointer mail01.halcyon.lab.\n');
  assert.equal(await out('host example.com 8.8.8.8'), 'Using domain server:\nName: 8.8.8.8\nAddress: 8.8.8.8#53\nAliases: \n\nexample.com has address 93.184.215.14\n' +
    'example.com mail is handled by 10 mail.example.com.\nexample.com mail is handled by 20 mail2.example.com.\n');
  assert.equal(await out('host -t ns halcyon.lab'), 'halcyon.lab name server ns1.halcyon.lab.\n');
  assert.equal(await out('host -t txt halcyon.lab'), 'halcyon.lab descriptive text "v=spf1 mx -all"\n');
  assert.equal(await out('host -t soa halcyon.lab'), 'halcyon.lab has SOA record ns1.halcyon.lab. hostmaster.halcyon.lab. 2026111201 3600 900 604800 86400\n');
  assert.equal(await out('host -t srv _ldap._tcp.halcyon.lab'), '_ldap._tcp.halcyon.lab has SRV record 0 100 389 dc01.halcyon.lab.\n');
  assert.equal(await out('host -t cname www.halcyon.lab'), 'www.halcyon.lab is an alias for web01.halcyon.lab.\n');
  assert.equal(await out('host -t txt web01.halcyon.lab'), 'web01.halcyon.lab has no TXT record\n');
  assert.equal(await out('host -C halcyon.lab'), 'Nameserver 10.10.10.53:\n\thalcyon.lab has SOA record ns1.halcyon.lab. hostmaster.halcyon.lab. 2026111201 3600 900 604800 86400\n');
  assert.equal(await out('host -c CH -t txt version.bind 10.10.10.53 | t-count'), '5\n');
  assert.equal(await out('host mail.halcyon.lab | t-count'), '2\n');
});

test('host: verbose output, zone listing and failures', async () => {
  const sim = await dnsSim();
  const v = stable((await sim.run('host -t a -v web01.halcyon.lab')).out);
  assert.equal(v, 'Trying "web01.halcyon.lab"\n;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: N\n' +
    ';; flags: qr aa rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 0\n\n;; QUESTION SECTION:\n;web01.halcyon.lab.\t\tIN\tA\n\n' +
    ';; ANSWER SECTION:\nweb01.halcyon.lab.\t3600\tIN\tA\t10.10.10.10\n\nReceived 51 bytes from 10.10.10.53#53 in T ms\n');
  assert.equal((await sim.run('host -v web01.halcyon.lab')).out.match(/^Trying "web01\.halcyon\.lab"$/gm).length, 3, 'A, AAAA and MX');
  assert.match((await sim.run('host -a halcyon.lab')).out, /;halcyon\.lab\.\t\t\tIN\tANY\n\n;; ANSWER SECTION:\nhalcyon\.lab\.\t\t3600\tIN\tNS\tns1\.halcyon\.lab\.\n/);

  const list = await sim.run('host -l halcyon.lab 10.10.10.53');
  assert.equal(list.code, 0);
  const lines = list.out.split('\n');
  assert.deepEqual(lines.slice(0, 7), ['Using domain server:', 'Name: 10.10.10.53', 'Address: 10.10.10.53#53', 'Aliases: ', '',
    'halcyon.lab name server ns1.halcyon.lab.', 'gw.halcyon.lab has address 10.10.10.1']);
  assert.equal(lines.filter((l) => / has address /.test(l)).length, 11);
  assert.ok(!/alias|mail is handled/.test(list.out), 'only NS, PTR and address records are listed');
  assert.equal((await sim.run('host -l -t cname halcyon.lab | t-count')).out, '3\n');
  assert.match((await sim.run('host -l -a halcyon.lab')).out, /ANSWER: 21,[^]*;halcyon\.lab\.\t\t\tIN\tAXFR\n/);
  const refused = await sim.run('host -l halcyonfreight.example 203.0.113.53');
  assert.equal(refused.code, 1);
  assert.match(refused.out, /Aliases: \n\nHost halcyonfreight\.example not found: 5\(REFUSED\)\n; Transfer failed\.\n$/);

  const nx = await sim.run('host nosuch.halcyon.lab');
  assert.deepEqual([nx.code, nx.out], [1, 'Host nosuch.halcyon.lab not found: 3(NXDOMAIN)\n']);
  assert.equal((await sim.run('host nosuchhost')).out, 'Host nosuchhost not found: 3(NXDOMAIN)\n');
  assert.match(stable((await sim.run('host -v nosuch.halcyon.lab')).out), /^Trying "nosuch\.halcyon\.lab"\nHost nosuch\.halcyon\.lab not found: 3\(NXDOMAIN\)\nReceived \d+ bytes from 10\.10\.10\.53#53 in T ms\n$/);
  const dead = await sim.run('host web01.halcyon.lab 10.10.10.99');
  assert.deepEqual([dead.code, dead.out], [1, ';; communications error to 10.10.10.99#53: timed out\n'.repeat(2) + ';; no servers could be reached\n\n']);
  const bad = await sim.run('host -z web01');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^host: illegal option -- z\nUsage: host \[-aCdilrTvVw\] \[-c class\] \[-N ndots\] \[-t type\] \[-W time\]\n/);
  assert.match((await sim.run('host')).err, /^Usage: host /);
  assert.equal((await sim.run('host -t')).err.split('\n')[0], 'host: option requires an argument -- t');
  assert.deepEqual(await sim.run('host -t bogus web01').then((r) => [r.code, r.err]), [1, 'host: invalid type: bogus\n\n']);
  assert.equal((await sim.run('host -V')).err, 'host 9.20.11-4-Debian\n');
  assert.equal((await sim.run('host web01 ns.nonexistent.example')).err, "host: couldn't get address for 'ns.nonexistent.example': not found\n");
});

test('nslookup non-interactive output', async () => {
  const sim = await dnsSim();
  const out = async (line) => (await sim.run(line)).out;
  const lab = 'Server:\t\t10.10.10.53\nAddress:\t10.10.10.53#53\n\n';
  assert.equal(await out('nslookup web01.halcyon.lab'), lab + 'Name:\tweb01.halcyon.lab\nAddress: 10.10.10.10\n\n');
  assert.equal(await out('nslookup www.halcyon.lab'), lab + 'www.halcyon.lab\tcanonical name = web01.halcyon.lab.\nName:\tweb01.halcyon.lab\nAddress: 10.10.10.10\n\n');
  assert.equal(await out('nslookup web01'), lab + 'Name:\tweb01.halcyon.lab\nAddress: 10.10.10.10\n\n');
  assert.equal(await out('nslookup example.com 8.8.8.8'), 'Server:\t\t8.8.8.8\nAddress:\t8.8.8.8#53\n\nNon-authoritative answer:\nName:\texample.com\nAddress: 93.184.215.14\n\n');
  assert.equal(await out('nslookup example.com dns.google'), 'Server:\t\tdns.google\nAddress:\t8.8.8.8#53\n\nNon-authoritative answer:\nName:\texample.com\nAddress: 93.184.215.14\n\n');
  assert.equal(await out('nslookup -type=mx halcyon.lab'), lab + 'halcyon.lab\tmail exchanger = 10 mail01.halcyon.lab.\n\n');
  assert.equal(await out('nslookup -q=ns halcyon.lab 10.10.10.53'), lab + 'halcyon.lab\tnameserver = ns1.halcyon.lab.\n\n');
  assert.equal(await out('nslookup -query=txt halcyon.lab'), lab + 'halcyon.lab\ttext = "v=spf1 mx -all"\n\n');
  assert.equal(await out('nslookup -type=soa halcyon.lab'), lab + 'halcyon.lab\n\torigin = ns1.halcyon.lab\n\tmail addr = hostmaster.halcyon.lab\n\tserial = 2026111201\n' +
    '\trefresh = 3600\n\tretry = 900\n\texpire = 604800\n\tminimum = 86400\n\n');
  assert.equal(await out('nslookup -type=mx kali.org 1.1.1.1'), 'Server:\t\t1.1.1.1\nAddress:\t1.1.1.1#53\n\nNon-authoritative answer:\n' +
    'kali.org\tmail exchanger = 10 mail.kali.org.\nkali.org\tmail exchanger = 20 mail2.kali.org.\n\nAuthoritative answers can be found from:\n\n');
  assert.equal(await out('nslookup 10.10.10.10'), '10.10.10.10.in-addr.arpa\tname = web01.halcyon.lab.\n\n');
  assert.equal(await out('nslookup 8.8.8.8'), '8.8.8.8.in-addr.arpa\tname = dns.google.\n\nAuthoritative answers can be found from:\n\n');
  assert.equal(await out('nslookup -type=aaaa example.com 8.8.8.8'), "Server:\t\t8.8.8.8\nAddress:\t8.8.8.8#53\n\nNon-authoritative answer:\n*** Can't find example.com: No answer\n\n");
  assert.equal(await out('nslookup web01.halcyon.lab | t-count'), '4\n');
});

test('nslookup failures and options', async () => {
  const sim = await dnsSim();
  const nx = await sim.run('nslookup nosuch.halcyon.lab');
  assert.deepEqual([nx.code, nx.out], [1, "Server:\t\t10.10.10.53\nAddress:\t10.10.10.53#53\n\n** server can't find nosuch.halcyon.lab: NXDOMAIN\n\n"]);
  const hidden = await sim.run('nslookup web01.halcyon.lab 8.8.8.8');
  assert.match(hidden.out, /\*\* server can't find web01\.halcyon\.lab: NXDOMAIN\n\n$/, 'public resolvers do not know the lab zone');
  const dead = await sim.run('nslookup -timeout=2 web01.halcyon.lab 10.10.10.99');
  assert.deepEqual([dead.code, dead.out], [1, ';; communications error to 10.10.10.99#53: timed out\n'.repeat(3) + ';; no servers could be reached\n\n\n']);
  assert.match((await sim.run('nslookup -type=bogus web01.halcyon.lab')).out, /^unknown query type: bogus\nServer:/);
  assert.match((await sim.run('nslookup -frobnicate web01.halcyon.lab')).out, /^\*\*\* Invalid option: frobnicate\nServer:/);
  assert.equal((await sim.run('nslookup -version')).err, 'nslookup 9.20.11-4-Debian\n');
  const many = await sim.run('nslookup a b c');
  assert.equal(many.code, 1);
  assert.match(many.err, /^Usage:\n {3}nslookup \[-opt \.\.\.\] {13}# interactive mode using default server\n/);
  assert.equal((await sim.run('nslookup web01 ns.nonexistent.example')).err, "nslookup: couldn't get address for 'ns.nonexistent.example': not found\n");
});

test('nslookup interactive mode', async () => {
  const sim = await dnsSim();
  for (const line of ['web01.halcyon.lab', 'set type=mx', 'halcyon.lab', 'server 8.8.8.8', 'example.com', 'set bogus', 'exit']) sim.term.feed(line);
  const r = await sim.type('nslookup');
  assert.equal(r.code, 0);
  assert.equal(r.output.replace(/\r/g, ''), [
    '> web01.halcyon.lab', 'Server:\t\t10.10.10.53', 'Address:\t10.10.10.53#53', '', 'Name:\tweb01.halcyon.lab', 'Address: 10.10.10.10',
    '> set type=mx',
    '> halcyon.lab', 'Server:\t\t10.10.10.53', 'Address:\t10.10.10.53#53', '', 'halcyon.lab\tmail exchanger = 10 mail01.halcyon.lab.',
    '> server 8.8.8.8', 'Default server: 8.8.8.8', 'Address: 8.8.8.8#53',
    '> example.com', 'Server:\t\t8.8.8.8', 'Address:\t8.8.8.8#53', '', 'Non-authoritative answer:', 'example.com\tmail exchanger = 10 mail.example.com.',
    'example.com\tmail exchanger = 20 mail2.example.com.', '', 'Authoritative answers can be found from:',
    '> set bogus', '*** Invalid option: bogus',
    '> exit', '', '',
  ].join('\n'));

  const piped = await sim.run('printf "set type=ns\\nhalcyon.lab\\nset all\\n" | nslookup - 10.10.10.53');
  assert.equal(piped.out, '> > Server:\t\t10.10.10.53\nAddress:\t10.10.10.53#53\n\nhalcyon.lab\tnameserver = ns1.halcyon.lab.\n' +
    '> Default server: 10.10.10.53\nAddress: 10.10.10.53#53\n\nSet options:\n  novc\t\t\tnodebug\t\tnod2\n  search\t\trecurse\n' +
    '  timeout = 0\t\tretry = 3\tport = 53\tndots = 1\n  querytype = NS      \tclass = IN\n  srchlist = halcyon.lab\n> \n');
});

test('whois: domain records from the registry', async () => {
  const sim = await dnsSim();
  const client = await sim.run('whois halcyonfreight.example');
  assert.equal(client.code, 0);
  const lines = client.out.split('\n');
  assert.deepEqual(lines.slice(0, 10), ['Domain Name: HALCYONFREIGHT.EXAMPLE', 'Registry Domain ID: ' + lines[1].split(': ')[1],
    'Registrar WHOIS Server: whois.simulated-registrar.example', 'Registrar URL: http://www.simulated-registrar.example',
    'Updated Date: 2026-02-11T08:15:02Z', 'Creation Date: 2009-03-14T10:22:31Z', 'Registry Expiry Date: 2027-03-14T10:22:31Z',
    'Registrar: Simulated Registrar, Inc.', 'Registrar IANA ID: 9999', 'Registrar Abuse Contact Email: abuse@simulated-registrar.example']);
  for (const want of ['Registrant Organization: Halcyon Freight Ltd.', 'Registrant State/Province: Greater Manchester', 'Registrant Country: GB',
    'Registrant Name: REDACTED FOR PRIVACY', 'Registrant Email: REDACTED FOR PRIVACY', 'Name Server: NS1.HALCYONFREIGHT.EXAMPLE', 'Name Server: NS2.HALCYONFREIGHT.EXAMPLE',
    'DNSSEC: unsigned', '>>> Last update of WHOIS database: 2026-11-13T14:29:19Z <<<']) assert.ok(lines.includes(want), want);
  assert.match(client.out, /\nTERMS OF USE: /);
  assert.equal((await sim.run('whois halcyonfreight.example | grep -c x 2>/dev/null; whois HalcyonFreight.Example. | t-count')).out.trim().split('\n').pop(), String(lines.filter(Boolean).length));

  const generic = (await sim.run('whois -H kali.org')).out;
  assert.match(generic, /^Domain Name: KALI\.ORG\n/);
  assert.match(generic, /\nRegistrar: Simulated Registrar, Inc\.\n/);
  assert.match(generic, /\nRegistrant Organization: REDACTED FOR PRIVACY\n/);
  assert.match(generic, /\nCreation Date: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\nRegistry Expiry Date: 202[67]-/);
  assert.match(generic, /\nNOTICE: This record is simulated by Kalima for training\./);
  assert.doesNotMatch(generic, /TERMS OF USE/, '-H hides the legal text');
  assert.equal((await sim.run('whois -H kali.org')).out, generic, 'invented registrations are stable');

  assert.equal((await sim.run('whois example.com')).out, '% IANA WHOIS server\n% for more information on IANA, visit http://www.iana.org\n% This query returned 1 object\n\n' +
    'domain:       EXAMPLE.COM\n\norganisation: Internet Assigned Numbers Authority\n\ncreated:      1992-01-01\nsource:       IANA\n\n');
  assert.match((await sim.run('whois www.kali.org')).out, /^No match for domain "WWW\.KALI\.ORG"\.\n>>> Last update of WHOIS database: /, 'registries know domains, not hosts');
  assert.match((await sim.run('whois nonexistent-shop.com')).out, /^No match for domain "NONEXISTENT-SHOP\.COM"\.\n/);
  assert.match((await sim.run('whois -H bbc.co.uk')).out, /^Domain Name: BBC\.CO\.UK\n[^]*Registrant Country: GB\n/);
  for (const name of ['halcyon.lab', 'web01.halcyon.lab', 'printer.local']) {
    assert.deepEqual(await sim.run('whois ' + name).then((r) => [r.code, r.out]), [0, 'No whois server is known for this kind of object.\n'], name);
  }
});

test('whois: address registries', async () => {
  const sim = await dnsSim();
  const lab = (await sim.run('whois 10.10.10.10')).out;
  assert.match(lab, /^\n#\n# ARIN WHOIS data and services are subject to the Terms of Use\n/);
  assert.match(lab, /\n\n\nNetRange: {7}10\.0\.0\.0 - 10\.255\.255\.255\nCIDR: {11}10\.0\.0\.0\/8\nNetName: {8}PRIVATE-ADDRESS-ABLK-RFC1918-IANA-RESERVED\nNetHandle: {6}NET-10-0-0-0-1\nParent: {10}\(\)\nNetType: {8}IANA Special Use\n/);
  assert.match(lab, /\nComment: {8}These addresses were assigned by the IETF[^\n]*RFC 1918 which can be found at:\nComment: {8}http:\/\/datatracker\.ietf\.org\/doc\/rfc1918\n/);
  assert.match(lab, /\nOrgName: {8}Internet Assigned Numbers Authority\nOrgId: {10}IANA\n/);
  assert.match((await sim.run('whois -H 192.168.1.1')).out, /^NetRange: {7}192\.168\.0\.0 - 192\.168\.255\.255\nCIDR: {11}192\.168\.0\.0\/16\n/);
  assert.match((await sim.run('whois -H 172.20.1.1')).out, /NetName: {8}PRIVATE-ADDRESS-BBLK-RFC1918-IANA-RESERVED\n/);
  assert.match((await sim.run('whois -H 192.0.2.7')).out, /NetName: {8}TEST-NET-1\n[^]*reserved for use in documentation and sample configurations/);

  const doc = (await sim.run('whois 203.0.113.10')).out;
  assert.match(doc, /^% \[whois\.apnic\.net\]\n/);
  assert.match(doc, /\ninetnum: {8}203\.0\.113\.0 - 203\.0\.113\.255\nnetname: {8}TEST-NET-3\ndescr: {10}IANA\ndescr: {10}RFC5737 Documentation Address Block\n/);
  const arin = (await sim.run('whois -H 104.18.4.159')).out;
  assert.match(arin, /^NetRange: {7}104\.18\.0\.0 - 104\.18\.255\.255\nCIDR: {11}104\.18\.0\.0\/16\nNetName: {8}SIMNET-104-18\n/);
  assert.match(arin, /\nOriginAS: {7}AS64[45]\d\d\nOrganization: {3}Simulated Network Operator 104-18 \(SIMNET-104-18\)\n/);
  assert.match(arin, /\nComment: {8}This record is simulated by Kalima for training\. It does not describe a real network\.\n/);
  assert.match(arin, /\nOrgAbuseEmail: {2}abuse@simnet-104-18\.example\n/);
  const ripe = (await sim.run('whois 185.49.219.7')).out;
  assert.match(ripe, /^% This is the RIPE Database query service\.\n% The objects are in RPSL format\.\n/);
  assert.match(ripe, /\ninetnum: {8}185\.49\.219\.0 - 185\.49\.219\.255\nnetname: {8}SIMNET-185-49-219\n/);
  assert.match(ripe, /\nroute: {10}185\.49\.219\.0\/24\norigin: {9}AS64[45]\d\d\n/);
  assert.match((await sim.run('whois -H halcyon')).out, /^No match found for halcyon\.\n/);
});

test('whois: options, verbose mode and unreachable servers', async () => {
  const sim = await dnsSim();
  assert.match((await sim.run('whois --verbose -H kali.org')).out, /^Using server whois\.publicinterestregistry\.org\.\nQuery string: "kali\.org"\n\nDomain Name: KALI\.ORG\n/);
  assert.match((await sim.run('whois --verbose -H nonexistent-shop.com')).out, /^Using server whois\.verisign-grs\.com\.\nQuery string: "domain nonexistent-shop\.com"\n\nNo match/);
  assert.match((await sim.run('whois --verbose -H 8.8.8.8')).out, /^Using server whois\.arin\.net\.\nQuery string: "n \+ 8\.8\.8\.8"\n\nNetRange/);
  assert.equal((await sim.run('whois --version')).out, 'Version 5.6.4.\n\nReport bugs to <md+whois@linux.it>.\n');
  const help = await sim.run('whois --help');
  assert.deepEqual([help.code, help.err], [0, '']);
  assert.match(help.out, /^Usage: whois \[OPTION\]\.\.\. OBJECT\.\.\.\n\n-h HOST, --host HOST {3}connect to server HOST\n/);
  const none = await sim.run('whois');
  assert.deepEqual([none.code, none.out, none.err], [1, '', help.out]);
  const bad = await sim.run('whois -z kali.org');
  assert.equal(bad.code, 1);
  assert.equal(bad.err, "whois: invalid option -- 'z'\n" + help.out);
  assert.match((await sim.run('whois --frob kali.org')).err, /^whois: unrecognized option '--frob'\n/);

  const refused = await sim.run('whois -h 10.10.10.10 kali.org');
  assert.deepEqual([refused.code, refused.out, refused.err], [2, '', 'connect: Connection refused\n']);
  const unknown = await sim.run('whois -h whois.nonexistent.example kali.org');
  assert.deepEqual([unknown.code, unknown.err], [2, 'getaddrinfo(whois.nonexistent.example): Name or service not known\n']);
  sim.K.net.state.wan = false;
  const before = sim.K.clock.now();
  const cut = await sim.run('whois kali.org');
  assert.deepEqual([cut.code, cut.out, cut.err], [2, '', 'Timeout.\n']);
  assert.equal(sim.K.clock.now() - before, 60000);
  assert.equal((await sim.run('whois web01.halcyon.lab')).out, 'No whois server is known for this kind of object.\n', 'no connection is needed to know that');
});
