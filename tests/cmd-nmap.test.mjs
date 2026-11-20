// Discovery pack: nmap, arp-scan, fping, arping against the simulated lab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

/** A simulator whose sudo timestamp is already valid, so `sudo ...` lines need no password. */
async function lab() {
  const sim = await boot();
  sim.term.feed('kali');
  await sim.run('sudo true');
  sim.term.take();
  return sim;
}

/** Seconds from the "Nmap done" line. */
const seconds = (out) => parseFloat(/scanned in ([\d.]+) seconds/.exec(out)[1]);
/** The "PORT ..." table of a report as an array of lines. */
const portLines = (out) => out.split('\n').filter((l) => /^(PORT|\d+\/(tcp|udp)) /.test(l));

/** Run a line on the real clock and press Ctrl-C shortly after. Leaves the simulator on the real clock. */
async function interrupted(sim, line, afterMs = 20) {
  const { K, shell, term } = sim;
  K.clock.useReal(); K.settings.timeScale = 1;
  term.feed('kali');
  await shell.capture('sudo true'); // the sudo timestamp from virtual time means nothing on the real clock
  term.take();
  const pending = shell.runLine(line);
  setTimeout(() => term.raiseInterrupt(), afterMs);
  const code = await pending;
  return { code, output: K.util.stripAnsi(term.take()) };
}

/* ------------------------------------------------------------------ nmap core */

test('nmap: default scan without root is a connect scan of the 1000 common ports', async () => {
  const sim = await lab();
  const r = await sim.run('nmap web01.halcyon.lab');
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  const lines = r.out.split('\n');
  assert.equal(lines[0], 'Starting Nmap 7.98 ( https://nmap.org ) at 2026-11-13 14:30 UTC');
  assert.equal(lines[1], 'Nmap scan report for web01.halcyon.lab (10.10.10.10)');
  assert.match(lines[2], /^Host is up \(0\.000\d\ds latency\)\.$/);
  assert.deepEqual(lines.slice(3, 9), [
    'Not shown: 997 closed tcp ports (conn-refused)',
    'PORT    STATE SERVICE',
    '22/tcp  open  ssh',
    '80/tcp  open  http',
    '443/tcp open  https',
    '',
  ]);
  assert.match(lines[9], /^Nmap done: 1 IP address \(1 host up\) scanned in \d\.\d\d seconds$/);
  assert.ok(seconds(r.out) > 0.4 && seconds(r.out) < 1.5, 'about a second for one LAN host');
  assert.doesNotMatch(r.out, /MAC Address/, 'no MAC address without ARP');
});

test('nmap: as root it is a SYN scan, discovery uses ARP and the MAC address is shown', async () => {
  const sim = await lab();
  const r = await sim.run('sudo nmap 10.10.10.10');
  assert.equal(r.code, 0);
  assert.match(r.out, /Nmap scan report for web01\.halcyon\.lab \(10\.10\.10\.10\)\n/);
  assert.match(r.out, /Not shown: 997 closed tcp ports \(reset\)\n/);
  assert.match(r.out, /443\/tcp open  https\nMAC Address: 00:0C:29:[0-9A-F:]{8} \(VMware\)\n\nNmap done/);
});

test('nmap -sn: ARP finds hosts that the connect ping misses', async () => {
  const sim = await lab();
  const user = await sim.run('nmap -sn 10.10.10.0/24');
  assert.match(user.out, /Nmap done: 256 IP addresses \(10 hosts up\) scanned in/);
  assert.doesNotMatch(user.out, /dc01|backup01/, 'hosts that filter 80 and 443 look down');
  assert.doesNotMatch(user.out, /MAC Address|PORT/);
  assert.ok(seconds(user.out) > 2 && seconds(user.out) < 8, 'a sweep takes a few seconds');

  const root = await sim.run('sudo nmap -sn 10.10.10.0/24');
  assert.match(root.out, /Nmap done: 256 IP addresses \(12 hosts up\) scanned in/);
  assert.match(root.out, /Nmap scan report for dc01\.halcyon\.lab \(10\.10\.10\.50\)\nHost is up \(0\.\d+s latency\)\.\nMAC Address: 00:15:5D:[0-9A-F:]{8} \(Microsoft\)\n/);
  assert.match(root.out, /Nmap scan report for backup01\.halcyon\.lab \(10\.10\.10\.90\)\nHost is up/);
  assert.match(root.out, /Nmap scan report for kali \(10\.10\.10\.5\)\nHost is up\.\nNmap scan report for web01/, 'the scanner itself has no latency or MAC line');
  assert.ok(seconds(root.out) > 1 && seconds(root.out) < 5);
});

test('nmap: a host that filters everything seems down without root, -Pn scans it anyway', async () => {
  const sim = await lab();
  const down = await sim.run('nmap backup01.halcyon.lab');
  assert.deepEqual(down.out.split('\n').slice(1), [
    'Note: Host seems down. If it is really up, but blocking our ping probes, try -Pn',
    'Nmap done: 1 IP address (0 hosts up) scanned in ' + seconds(down.out).toFixed(2) + ' seconds', '',
  ]);
  assert.ok(seconds(down.out) >= 3 && seconds(down.out) < 3.5);

  const pn = await sim.run('nmap -Pn backup01.halcyon.lab');
  assert.match(pn.out, /Host is up \(0\.\d+s latency\)\.\nNot shown: 999 filtered tcp ports \(no-response\)\nPORT    STATE SERVICE\n873\/tcp open  rsync\n/);
  assert.ok(seconds(pn.out) > 3, 'waiting for filtered ports takes longer');

  const none = await sim.run('nmap -Pn 10.10.10.99');
  assert.match(none.out, /Nmap scan report for 10\.10\.10\.99\nHost is up\.\nAll 1000 scanned ports on 10\.10\.10\.99 are in ignored states\.\nNot shown: 1000 filtered tcp ports \(host-unreach\)\n/);

  const two = await sim.run('nmap 10.10.10.90 10.10.10.99');
  assert.doesNotMatch(two.out, /Note: Host seems down/, 'the note is only for a single target');
  assert.match(two.out, /Nmap done: 2 IP addresses \(0 hosts up\)/);
});

test('nmap: port selection with -p, -F and --top-ports', async () => {
  const sim = await lab();
  let r = await sim.run('nmap -p 22,80,8080 dev01.halcyon.lab');
  assert.deepEqual(portLines(r.out), ['PORT     STATE  SERVICE', '22/tcp   open   ssh', '80/tcp   closed http', '8080/tcp open   http-proxy']);
  assert.doesNotMatch(r.out, /Not shown/);

  r = await sim.run('nmap -p20-25 files01.halcyon.lab');
  assert.deepEqual(portLines(r.out), ['PORT   STATE  SERVICE', '20/tcp closed ftp-data', '21/tcp open   ftp', '22/tcp open   ssh', '23/tcp closed telnet', '24/tcp closed priv-mail', '25/tcp closed smtp']);

  r = await sim.run('nmap -p- dev01.halcyon.lab');
  assert.match(r.out, /Not shown: 65531 closed tcp ports \(conn-refused\)\n/);
  assert.deepEqual(portLines(r.out).slice(1), ['22/tcp   open     ssh', '3000/tcp open     ppp', '5432/tcp filtered postgresql', '8080/tcp open     http-proxy']);
  assert.ok(seconds(r.out) > 10, 'all ports take noticeably longer');

  r = await sim.run('nmap -F dc01.halcyon.lab -Pn');
  assert.match(r.out, /Not shown: 93 filtered tcp ports \(no-response\)\n/);
  assert.equal(portLines(r.out).length, 8);

  r = await sim.run('nmap --top-ports 10 mail01.halcyon.lab');
  assert.deepEqual(portLines(r.out).map((l) => l.split('/')[0]), ['PORT     STATE  SERVICE', '21', '22', '23', '25', '80', '110', '139', '443', '445', '3389']);

  r = await sim.run('nmap -p http,ssh,U:53 web01.halcyon.lab');
  assert.deepEqual(portLines(r.out).slice(1), ['22/tcp   open   ssh', '80/tcp   open   http', '8008/tcp closed http']);
});

test('nmap: the default port set covers every TCP port the lab uses', async () => {
  const sim = await lab();
  const r = await sim.run('sudo nmap 10.10.10.0/24');
  for (const host of sim.K.net.world.hosts) {
    if (host.id === 'kali') continue;
    const block = r.out.split('Nmap scan report for ').find((b) => b.includes('(' + host.ip + ')'));
    assert.ok(block, host.id + ' is reported');
    for (const svc of host.services) {
      if (svc.proto !== 'tcp' || svc.state === 'filtered') continue;
      assert.match(block, new RegExp('^' + svc.port + '/tcp +open ', 'm'), host.id + ' port ' + svc.port);
    }
  }
  assert.match(r.out, /Nmap done: 256 IP addresses \(12 hosts up\)/);
});

test('nmap: --open, --reason and -n', async () => {
  const sim = await lab();
  let r = await sim.run('nmap --open -p 22,80,5432,8080 dev01.halcyon.lab');
  assert.match(r.out, /Not shown: 1 closed tcp port \(conn-refused\), 1 filtered tcp port \(no-response\)\n/);
  assert.deepEqual(portLines(r.out), ['PORT     STATE SERVICE', '22/tcp   open  ssh', '8080/tcp open  http-proxy']);

  r = await sim.run('nmap --open -p 81 web01.halcyon.lab');
  assert.doesNotMatch(r.out, /scan report/, 'a host without open ports is left out');
  assert.match(r.out, /Nmap done: 1 IP address \(1 host up\)/);

  r = await sim.run('nmap --reason -p 22,81,5432 dev01.halcyon.lab');
  assert.match(r.out, /Host is up, received conn-refused \(0\.\d+s latency\)\./, 'dev01 refused the connect ping to port 80');
  assert.deepEqual(portLines(r.out), ['PORT     STATE    SERVICE    REASON', '22/tcp   open     ssh        syn-ack', '81/tcp   closed   hosts2-ns  conn-refused', '5432/tcp filtered postgresql no-response']);

  r = await sim.run('sudo nmap --reason -p 22,81,5432 dev01.halcyon.lab');
  assert.match(r.out, /Host is up, received arp-response \(0\.\d+s latency\)\./);
  assert.deepEqual(portLines(r.out).slice(1), ['22/tcp   open     ssh        syn-ack ttl 64', '81/tcp   closed   hosts2-ns  reset ttl 64', '5432/tcp filtered postgresql no-response']);

  r = await sim.run('nmap -n -sn 10.10.10.10 www.halcyon.lab');
  assert.match(r.out, /Nmap scan report for 10\.10\.10\.10\nHost is up/);
  assert.match(r.out, /Nmap scan report for www\.halcyon\.lab \(10\.10\.10\.10\)\nHost is up[^\n]*\nNmap done/, 'no rDNS line with -n');
  r = await sim.run('nmap -sn www');
  assert.match(r.out, /Nmap scan report for www \(10\.10\.10\.10\)\nHost is up[^\n]*\nrDNS record for 10\.10\.10\.10: web01\.halcyon\.lab\n/);
});

test('nmap: target specifications', async () => {
  const sim = await lab();
  const up = async (line) => (await sim.run(line)).out.split('\n').filter((l) => l.startsWith('Nmap scan report')).map((l) => /\(?([\d.]+)\)?$/.exec(l)[1]);
  assert.deepEqual(await up('nmap -sn 10.10.10.1-20'), ['10.10.10.1', '10.10.10.5', '10.10.10.10', '10.10.10.20']);
  assert.deepEqual(await up('nmap -sn 10.10.10.10,30,40'), ['10.10.10.10', '10.10.10.30', '10.10.10.40']);
  assert.deepEqual(await up('nmap -sn db01 10.10.10.70 gw.halcyon.lab/30'), ['10.10.10.30', '10.10.10.70', '10.10.10.1']);
  assert.deepEqual(await up('nmap -sn 10.10.10.0/24 --exclude 10.10.10.1-30,cam01.halcyon.lab'), ['10.10.10.40', '10.10.10.53', '10.10.10.60', '10.10.10.70']);
  assert.match((await sim.run('nmap -sn 10.10.10.0/28 --exclude 10.10.10.10')).out, /Nmap done: 15 IP addresses \(2 hosts up\)/);

  await sim.run('printf "10.10.10.10\\n# the file server\\nfiles01.halcyon.lab 10.10.10.2\\n" > /tmp/targets.txt');
  assert.deepEqual(await up('nmap -sn -iL /tmp/targets.txt'), ['10.10.10.10', '10.10.10.20']);
  assert.deepEqual(await up('echo 10.10.10.30 | nmap -sn -iL -'), ['10.10.10.30']);
  let r = await sim.run('nmap -iL /tmp/missing.txt');
  assert.deepEqual([r.code, r.err], [1, 'Failed to open input file /tmp/missing.txt for reading: No such file or directory (2)\nQUITTING!\n']);

  r = await sim.run('nmap -sn nosuchhost.halcyon.lab');
  assert.equal(r.err, 'Failed to resolve "nosuchhost.halcyon.lab".\nWARNING: No targets were specified, so 0 hosts scanned.\n');
  assert.match(r.out, /Nmap done: 0 IP addresses \(0 hosts up\) scanned in 0\.0\d seconds/);
  assert.equal(r.code, 0);
});

test('nmap: targets outside the engagement scope are refused, the rest of the run continues', async () => {
  const sim = await lab();
  const seen = [];
  sim.K.events.on('scope-violation', (e) => seen.push(e));
  sim.K.net.bus.on('packet', (p) => { if (!p.dst.startsWith('10.10.10.') && !p.src.startsWith('10.10.10.')) seen.push(p); });
  let r = await sim.run('nmap -sn 8.8.8.8 10.10.10.10');
  assert.match(r.err, /Out-of-scope target blocked: 8\.8\.8\.8/);
  assert.match(r.err, /nmap is an active testing tool/);
  assert.match(r.out, /Nmap scan report for web01\.halcyon\.lab \(10\.10\.10\.10\)/);
  assert.match(r.out, /Nmap done: 1 IP address \(1 host up\)/);
  assert.deepEqual(seen, [{ target: '8.8.8.8', tool: 'nmap' }], 'nothing was sent to the refused address');

  r = await sim.run('sudo nmap -sn 203.0.113.0/24 halcyonfreight.example');
  assert.equal(r.err.match(/Out-of-scope target blocked/g).length, 2, 'one notice per specification');
  assert.match(r.err, /\[kalima\] 255 more addresses of 203\.0\.113\.0\/24 outside the scope: skipped\./);
  assert.match(r.out, /Nmap done: 0 IP addresses \(0 hosts up\)/);

  r = await sim.run('nmap -sn 10.10.9-10.1-2');
  assert.doesNotMatch(r.out, /10\.10\.9\./);
  assert.match(r.out, /Nmap scan report for gw\.halcyon\.lab \(10\.10\.10\.1\)/);

  r = await sim.run('nmap -p 22 localhost 10.10.10.5');
  assert.equal(r.err, '', 'the Kali box itself is always allowed');
  assert.match(r.out, /Nmap scan report for localhost \(127\.0\.0\.1\)/);
  assert.match(r.out, /Nmap scan report for kali \(10\.10\.10\.5\)/);
});

test('nmap: errors use the real wording and exit codes', async () => {
  const sim = await lab();
  const fails = async (line, code, err) => {
    const r = await sim.run(line);
    assert.deepEqual([r.code, r.err, r.out], [code, err, ''], line);
  };
  // Ports and probes are worked out after the opening line, so these errors follow it.
  const failsLate = async (line, err) => {
    const r = await sim.run(line);
    assert.deepEqual([r.code, r.err], [1, err + '\nQUITTING!\n'], line);
    assert.match(r.out, /^Starting Nmap 7\.98 [^\n]*\n$/, line);
  };
  await fails('nmap -sS 10.10.10.10', 1, 'You requested a scan type which requires root privileges.\nQUITTING!\n');
  await fails('nmap --bogus 10.10.10.10', 255, "nmap: unrecognized option '--bogus'\nSee the output of nmap -h for a summary of options.\n");
  await fails('nmap -Z 10.10.10.10', 255, "nmap: invalid option -- 'Z'\nSee the output of nmap -h for a summary of options.\n");
  await fails('nmap 10.10.10.10 -p', 255, "nmap: option requires an argument -- 'p'\nSee the output of nmap -h for a summary of options.\n");
  let r = await sim.run('nmap -sK 10.10.10.10');
  assert.deepEqual([r.code, r.err], [255, 'Scantype K not supported\n\n']);
  assert.match(r.out, /^Nmap 7\.98 \( https:\/\/nmap\.org \)\nUsage: nmap /, 'an unknown scan type prints the usage summary first');
  r = await sim.run('nmap -s');
  assert.deepEqual([r.code, r.err], [255, 'An option is required for -s, most common are -sT (tcp scan), -sS (SYN scan), -sF (FIN scan), -sU (UDP scan) and -sn (Ping scan)\n']);
  await fails('nmap -PX 10.10.10.10', 1, 'Illegal Argument to -P, use -Pn, -PE, -PS, -PA, -PP, -PM, -PU, -PY, or -PO\nQUITTING!\n');
  await fails('nmap -T9 10.10.10.10', 1, 'Unknown timing mode (-T argument).  Use either "Paranoid", "Sneaky", "Polite", "Normal", "Aggressive", "Insane" or a number from 0 (Paranoid) to 5 (Insane)\nQUITTING!\n');
  await failsLate('nmap -p 70000 10.10.10.10', 'Ports specified must be between 0 and 65535 inclusive');
  await failsLate('nmap -p 80-22 10.10.10.10', 'Your port range 80-22 is backwards. Did you mean 22-80?');
  await failsLate('nmap -p 22:80 10.10.10.10', 'Your port specifications are illegal.  Example of proper form: "-100,200-1024,T:3000-4000,U:60000-"');
  await failsLate('nmap -p nosuchservice 10.10.10.10', "Found no matches for the service mask 'nosuchservice' and your specified protocols");
  await failsLate('nmap -F -p 22 10.10.10.10', 'You cannot use -F (fast scan) with -p (explicit port selection) but see --top-ports and --port-ratio to fast scan a range of ports');
  await failsLate('nmap -sn -p 22 10.10.10.10', 'You cannot use -F (fast scan) or -p (explicit port selection) when not doing a port scan');
  await failsLate('nmap --traceroute 10.10.10.10', 'Traceroute has to be run as root');
  await fails('nmap -sL -sT 10.10.10.10', 1, '-sL and -sn (skip port scan) are not valid with any other scan types\nQUITTING!\n');
  await fails('nmap --min-rate fast 10.10.10.10', 1, 'Argument to --min-rate must be a positive floating-point number\nQUITTING!\n');
  await fails('nmap --top-ports 0 10.10.10.10', 1, '--top-ports should be an integer 1 or greater\nQUITTING!\n');
  await fails('sudo nmap -sS -sT 10.10.10.10', 1, 'You specified more than one type of TCP scan.  Please choose only one of -sA, -b, -sT, -sF, -sI, -sM, -sN, -sS, -sW, and -sX\nQUITTING!\n');
  const dup = await sim.run('nmap -p 22,22 10.10.10.10');
  assert.equal(dup.err, 'WARNING: Duplicate port number(s) specified.  Are you alert enough to be using Nmap?  Have some coffee or Jolt(tm).\n');
  assert.equal(dup.code, 0);
});

test('nmap: -h, no arguments and -V', async () => {
  const sim = await lab();
  const help = await sim.run('nmap -h');
  assert.equal(help.code, 0);
  assert.match(help.out, /^Nmap 7\.98 \( https:\/\/nmap\.org \)\nUsage: nmap \[Scan Type\(s\)\] \[Options\] \{target specification\}\nTARGET SPECIFICATION:\n/);
  assert.match(help.out, /\n  -sn: Ping Scan - disable port scan\n/);
  assert.match(help.out, /SEE THE MAN PAGE \(https:\/\/nmap\.org\/book\/man\.html\) FOR MORE OPTIONS AND EXAMPLES\n$/);
  assert.equal((await sim.run('nmap --help')).out, help.out);
  const bare = await sim.run('nmap');
  assert.deepEqual([bare.code, bare.out], [255, help.out]);
  const v = await sim.run('nmap -V');
  assert.match(v.out, /^Nmap version 7\.98 \( https:\/\/nmap\.org \)\nPlatform: x86_64-pc-linux-gnu\nCompiled with: /);
  assert.equal((await sim.run('nmap --version')).out, v.out);
  assert.match((await sim.run('man nmap')).out, /Network exploration tool and security \/ port scanner/);
});

test('nmap -v: phases, discovered ports, down hosts and packet counts', async () => {
  const sim = await lab();
  let r = await sim.run('sudo nmap -v -p 22,80,81 10.10.10.10');
  const lines = r.out.split('\n');
  assert.deepEqual(lines.slice(1, 4), ['Initiating ARP Ping Scan at 14:30', 'Scanning 10.10.10.10 [1 port]', 'Completed ARP Ping Scan at 14:30, ' + /, (\d\.\d\ds)/.exec(lines[3])[1] + ' elapsed (1 total hosts)']);
  assert.match(r.out, /Initiating Parallel DNS resolution of 1 host\. at 14:30\nCompleted Parallel DNS resolution of 1 host\. at 14:30, 0\.0\ds elapsed\n/);
  assert.match(r.out, /Initiating SYN Stealth Scan at 14:30\nScanning web01\.halcyon\.lab \(10\.10\.10\.10\) \[3 ports\]\nDiscovered open port 22\/tcp on 10\.10\.10\.10\nDiscovered open port 80\/tcp on 10\.10\.10\.10\nCompleted SYN Stealth Scan at 14:30, \d\.\d\ds elapsed \(3 total ports\)\n/);
  assert.match(r.out, /\nRead data files from: \/usr\/share\/nmap\nNmap done: 1 IP address \(1 host up\) scanned in \d\.\d\d seconds\n {11}Raw packets sent: 4 \(160B\) \| Rcvd: 4 \(156B\)\n$/);

  r = await sim.run('nmap -v -sn 10.10.10.9-10');
  assert.match(r.out, /Initiating Ping Scan at 14:30\nScanning 2 hosts \[2 ports\/host\]\n/);
  assert.match(r.out, /Nmap scan report for 10\.10\.10\.9 \[host down\]\nNmap scan report for web01/);
  assert.doesNotMatch(r.out, /Raw packets/);

  r = await sim.run('sudo nmap -vv -p 22 10.10.10.10');
  assert.match(r.out, /Host is up, received arp-response \(0\.\d+s latency\)\.\nScanned at 2026-11-13 14:30:\d\d UTC for \ds\n/);
  assert.match(r.out, /PORT   STATE SERVICE REASON\n22\/tcp open  ssh     syn-ack ttl 64\n/);
});

test('nmap: timing templates scale the duration', async () => {
  const sim = await lab();
  const took = async (line) => seconds((await sim.run(line)).out);
  const normal = await took('nmap -Pn 10.10.10.90');
  const fast = await took('nmap -Pn -T4 10.10.10.90');
  const insane = await took('nmap -Pn -T insane 10.10.10.90');
  assert.ok(insane < fast && fast < normal, `${insane} < ${fast} < ${normal}`);
  const polite = await took('nmap -T2 -p 1-100 10.10.10.10');
  assert.ok(polite > 40 && polite < 50, 'polite waits 0.4 s between probes: ' + polite);
  assert.ok(await took('nmap -T1 -p 22,80 10.10.10.10') > 60, 'sneaky waits 15 s between probes');
});

test('nmap: output works in pipelines and redirections', async () => {
  const sim = await lab();
  assert.equal((await sim.run('nmap -sn 10.10.10.0/24 | grep -c "Host is up"')).out, '10\n');
  assert.equal((await sim.run("nmap -sn 10.10.10.0/24 | grep 'scan report' | cut -d' ' -f5 | head -3")).out, 'gw.halcyon.lab\nkali\nweb01.halcyon.lab\n');
  await sim.run('nmap -p 22 10.10.10.30 > /tmp/scan.txt 2>&1');
  assert.match((await sim.run('grep -c open /tmp/scan.txt')).out, /^1\n$/);
});

test('nmap -sL lists the targets without sending them anything', async () => {
  const sim = await lab();
  const packets = [];
  sim.K.net.bus.on('packet', (p) => { if (p.proto !== 'UDP') packets.push(p); });
  let r = await sim.run('nmap -sL 10.10.10.0/29');
  assert.deepEqual(r.out.split('\n').slice(1), [
    'Nmap scan report for 10.10.10.0', 'Nmap scan report for gw.halcyon.lab (10.10.10.1)', 'Nmap scan report for 10.10.10.2',
    'Nmap scan report for 10.10.10.3', 'Nmap scan report for 10.10.10.4', 'Nmap scan report for kali (10.10.10.5)',
    'Nmap scan report for 10.10.10.6', 'Nmap scan report for 10.10.10.7',
    'Nmap done: 8 IP addresses (0 hosts up) scanned in ' + seconds(r.out).toFixed(2) + ' seconds', '',
  ]);
  assert.deepEqual(packets, [], 'only DNS questions leave the machine');
  assert.equal((await sim.run('nmap -sL -n 10.10.10.10-11 | grep -c report')).out, '2\n');
  assert.equal((await sim.run('nmap -sL -oG - 10.10.10.10 | grep Status')).out, 'Host: 10.10.10.10 (web01.halcyon.lab)\tStatus: Unknown\n');
  r = await sim.run('nmap -sL 10.10.9.0/24');
  assert.match(r.err, /Out-of-scope target blocked: 10\.10\.9\.0/);
  assert.match(r.out, /Nmap done: 0 IP addresses/);
});

test('nmap: discovery probes can be chosen with -PS, -PA, -PE and -PU', async () => {
  const sim = await lab();
  let r = await sim.run('nmap -sn -PS445 dc01.halcyon.lab backup01.halcyon.lab');
  assert.match(r.out, /Nmap scan report for dc01\.halcyon\.lab \(10\.10\.10\.50\)\nHost is up/, 'a connect to 445 finds the host that filters 80 and 443');
  assert.match(r.out, /Nmap done: 2 IP addresses \(1 host up\)/);
  r = await sim.run('nmap -v -sn -PS22,873 -PA445 10.10.10.90');
  assert.match(r.out, /Scanning 10\.10\.10\.90 \[3 ports\]\n/);
  assert.match(r.out, /Nmap scan report for backup01\.halcyon\.lab \(10\.10\.10\.90\)\nHost is up/);

  r = await sim.run('nmap -sn -PE 10.10.10.50');
  assert.equal(r.err, 'Warning:  You are not root -- using TCP pingscan rather than ICMP\n');
  assert.match(r.out, /Note: Host seems down/, 'the fallback is a connect to port 80');
  r = await sim.run('nmap -sn -PU 10.10.10.10');
  assert.deepEqual([r.code, r.err], [1, 'Sorry, UDP Ping (-PU) only works if you are root (because we need to read raw responses off the wire)\nQUITTING!\n']);
  r = await sim.run('nmap -sn -PS22 -PS80 10.10.10.10');
  assert.deepEqual([r.code, r.err], [1, 'Only one -PS option is allowed. Combine port ranges with commas.\nQUITTING!\n']);
  r = await sim.run('nmap -sn -PSssh 10.10.10.10');
  assert.equal(r.err, 'Bogus argument to -PS: ssh\nQUITTING!\n');

  // As root the local network is asked with ARP whatever the probes; --disable-arp-ping shows what they alone find.
  r = await sim.run('sudo nmap -sn -PE 10.10.10.50');
  assert.match(r.out, /Host is up[^\n]*\nMAC Address: /);
  r = await sim.run('sudo nmap -sn --disable-arp-ping --reason 10.10.10.10 10.10.10.50');
  assert.match(r.out, /Nmap scan report for web01\.halcyon\.lab \(10\.10\.10\.10\)\nHost is up, received echo-reply ttl 64 \(0\.\d+s latency\)\.\nNmap done: 2 IP addresses \(1 host up\)/);
  assert.doesNotMatch(r.out, /MAC Address/);
  r = await sim.run('sudo nmap -sn --disable-arp-ping -PS445 -PU --reason 10.10.10.50');
  assert.match(r.out, /Host is up, received syn-ack ttl 128 /);
  r = await sim.run('sudo nmap -v -sn --disable-arp-ping 10.10.10.50');
  assert.match(r.out, /Scanning 10\.10\.10\.50 \[4 ports\]\n/);
  assert.match(r.out, /Raw packets sent: 4 \(152B\) \| Rcvd: 0 \(0B\)\n$/);
});

test('nmap: what else the report says (other addresses, -Pn notice, min-rate, port 0)', async () => {
  const sim = await lab();
  let r = await sim.run('nmap -p 22 localhost');
  assert.match(r.out, /Nmap scan report for localhost \(127\.0\.0\.1\)\nHost is up \(0\.0000\d+s latency\)\.\nOther addresses for localhost \(not scanned\): ::1\nPORT /);
  r = await sim.run('nmap -Pn -v -p 22 10.10.10.10');
  assert.equal(r.err, "Host discovery disabled (-Pn). All addresses will be marked 'up' and scan times may be slower.\n");
  assert.equal((await sim.run('nmap -Pn -p 22 10.10.10.10')).err, '');
  const slow = seconds((await sim.run('nmap -Pn -p- 10.10.10.90')).out);
  const pushed = seconds((await sim.run('nmap -Pn -p- --min-rate 5000 10.10.10.90')).out);
  assert.ok(pushed < slow / 3 && pushed > 10, `--min-rate shortens the scan: ${pushed} < ${slow}`);
  r = await sim.run('nmap -p 0-2 10.10.10.10');
  assert.equal(r.err, 'WARNING: Scanning "port 0" is supported, but unusual.\n');
  assert.deepEqual(portLines(r.out).slice(1), ['0/tcp closed unknown', '1/tcp closed tcpmux', '2/tcp closed compressnet']);

  r = await sim.run('nmap -sV -oN /tmp/down.nmap backup01.halcyon.lab');
  assert.doesNotMatch(r.out, /detection performed/, 'nothing was detected on a host that seems down');
  assert.doesNotMatch((await sim.run('cat /tmp/down.nmap')).out, /Note: Host seems down/, 'the hint is for the screen only');
  sim.term.feed('10.10.10.30');
  r = await sim.run('nmap -sn -iL -');
  assert.match(r.out, /Nmap scan report for db01\.halcyon\.lab/, 'without a pipe the list is typed at the terminal');
});

/* ------------------------------------------- nmap: detection and output files */

test('nmap -sV: VERSION column, Service Info and a longer run', async () => {
  const sim = await lab();
  let r = await sim.run('nmap -sV web01.halcyon.lab');
  assert.deepEqual(portLines(r.out), [
    'PORT    STATE SERVICE  VERSION',
    '22/tcp  open  ssh      OpenSSH 10.0p2 Debian 7 (protocol 2.0)',
    '80/tcp  open  http     nginx 1.26.3',
    '443/tcp open  ssl/http nginx 1.26.3',
  ]);
  assert.match(r.out, /\nService Info: OS: Linux; CPE: cpe:\/o:linux:linux_kernel\n\nService detection performed\. Please report any incorrect results at https:\/\/nmap\.org\/submit\/ \.\nNmap done: /);
  assert.ok(seconds(r.out) > 6 && seconds(r.out) < 9, 'several seconds longer than a plain scan');

  r = await sim.run('nmap -sV -p 21,111,139,2049 files01.halcyon.lab');
  assert.deepEqual(portLines(r.out).slice(1), ['21/tcp   open  ftp         vsftpd 3.0.5', '111/tcp  open  rpcbind     2-4 (RPC #100000)', '139/tcp  open  netbios-ssn Samba smbd 4', '2049/tcp open  nfs         3-4 (RPC #100003)']);
  assert.match(r.out, /\nService Info: Host: FILES01; OS: Unix\n/);

  r = await sim.run('sudo nmap -sV -p 25,389,445,464,636,3000,8080,873 mail01 dc01 dev01 backup01 -n');
  assert.match(r.out, /25\/tcp +open +smtp +Postfix smtpd\n/);
  assert.match(r.out, /Service Info: Host: mail01\.halcyon\.lab\n/);
  assert.match(r.out, /389\/tcp +open +ldap +Microsoft Windows Active Directory LDAP \(Domain: halcyon\.lab\)\n445\/tcp +open +microsoft-ds\?\n464\/tcp +open +kpasswd5\?\n636\/tcp +open +tcpwrapped\n/);
  assert.match(r.out, /Service Info: Host: DC01; OS: Windows; CPE: cpe:\/o:microsoft:windows\n/);
  assert.match(r.out, /3000\/tcp open +http +Node\.js Express framework\n8080\/tcp open +http +Jetty 12\.0\.25\n/, 'the name comes from the service, not the port number');
  assert.match(r.out, /445\/tcp +closed microsoft-ds\n/, 'ports that are not open keep an empty VERSION cell');
  assert.match(r.out, /873\/tcp +open +rsync +\(protocol version 31\)\n/);

  r = await sim.run('nmap -sV -v -p 22,80 10.10.10.10');
  assert.match(r.out, /Initiating Service scan at 14:3\d\nScanning 2 services on web01\.halcyon\.lab \(10\.10\.10\.10\)\nCompleted Service scan at 14:3\d, 6\.\d\ds elapsed \(2 services on 1 host\)\n/);
});

test('nmap -O: needs root and prints the OS block from the host record', async () => {
  const sim = await lab();
  let r = await sim.run('nmap -O 10.10.10.10');
  assert.deepEqual([r.code, r.err], [1, 'TCP/IP fingerprinting (for OS scan) requires root privileges.\nQUITTING!\n']);

  r = await sim.run('sudo nmap -O 10.10.10.10');
  assert.match(r.out, /\nMAC Address: [0-9A-F:]{17} \(VMware\)\nDevice type: general purpose\nRunning: Linux 6\.X\nOS CPE: cpe:\/o:linux:linux_kernel:6\nOS details: Linux 6\.1 - 6\.12\nNetwork Distance: 1 hop\n\nOS detection performed\. Please report any incorrect results at https:\/\/nmap\.org\/submit\/ \.\nNmap done/);

  r = await sim.run('sudo nmap -O printer.halcyon.lab dc01.halcyon.lab');
  assert.match(r.out, /Device type: printer\nRunning: HP embedded\nOS CPE: cpe:\/h:hp:laserjet\nOS details: HP LaserJet printer \(JetDirect\)\n/);
  assert.match(r.out, /Warning: OSScan results may be unreliable because we could not find at least 1 open and 1 closed port\nDevice type: general purpose\nRunning \(JUST GUESSING\): Microsoft Windows 2022 \(\d\d%\)\nOS CPE: cpe:\/o:microsoft:windows_server_2022\nAggressive OS guesses: Microsoft Windows Server 2022 \(\d\d%\)\nNo exact OS matches for host \(test conditions non-ideal\)\.\nNetwork Distance: 1 hop\n/);

  r = await sim.run('sudo nmap -O -p 81 10.10.10.10');
  assert.match(r.out, /Warning: OSScan results may be unreliable[^\n]*\nToo many fingerprints match this host to give specific OS details\nNetwork Distance: 1 hop\n/);
});

test('nmap -A and --traceroute', async () => {
  const sim = await lab();
  let r = await sim.run('nmap --traceroute 10.10.10.10');
  assert.deepEqual([r.code, r.err], [1, 'Traceroute has to be run as root\nQUITTING!\n']);

  r = await sim.run('sudo nmap -A -p 22,80,81 web01.halcyon.lab');
  assert.match(r.out, /22\/tcp open +ssh +OpenSSH 10\.0p2 Debian 7 \(protocol 2\.0\)\n/);
  assert.match(r.out, /OS details: Linux 6\.1 - 6\.12\nNetwork Distance: 1 hop\nService Info: OS: Linux; CPE: cpe:\/o:linux:linux_kernel\n\nTRACEROUTE\nHOP RTT     ADDRESS\n1   0\.\d\d ms web01\.halcyon\.lab \(10\.10\.10\.10\)\n\nOS and Service detection performed\./);

  r = await sim.run('nmap -A -p 22 web01.halcyon.lab');
  assert.equal(r.code, 0, 'without root -A leaves out what needs raw sockets');
  assert.match(r.out, /22\/tcp open  ssh     OpenSSH/);
  assert.doesNotMatch(r.out, /TRACEROUTE|OS details/);
  assert.match(r.out, /\nService detection performed\./);
});

test('nmap -sU: UDP scan as root', async () => {
  const sim = await lab();
  let r = await sim.run('nmap -sU 10.10.10.53');
  assert.deepEqual([r.code, r.err], [1, 'You requested a scan type which requires root privileges.\nQUITTING!\n']);

  r = await sim.run('sudo nmap -sU -p 53,123,161 --reason ns1.halcyon.lab printer.halcyon.lab');
  assert.match(r.out, /PORT    STATE  SERVICE REASON\n53\/udp  open   domain  udp-response ttl 64\n123\/udp closed ntp     port-unreach ttl 64\n161\/udp closed snmp    port-unreach ttl 64\n/);
  assert.match(r.out, /161\/udp open   snmp    udp-response ttl 64\n/);

  r = await sim.run('sudo nmap -sU -F dc01.halcyon.lab');
  assert.match(r.out, /Not shown: 97 open\|filtered udp ports \(no-response\)\nPORT    STATE SERVICE\n53\/udp  open  domain\n88\/udp  open  kerberos-sec\n123\/udp open  ntp\n/);

  r = await sim.run('sudo nmap -sU --top-ports 30 files01.halcyon.lab');
  assert.match(r.out, /Not shown: 28 closed udp ports \(port-unreach\)\nPORT    STATE SERVICE\n111\/udp open  rpcbind\n137\/udp open  netbios-ns\n/);
  assert.ok(seconds(r.out) > 15, 'closed UDP ports are slow because the target limits its ICMP errors');

  r = await sim.run('sudo nmap -sS -sU -p T:22,U:53 -sV ns1.halcyon.lab');
  assert.deepEqual(portLines(r.out), ['PORT   STATE SERVICE VERSION', '22/tcp open  ssh     OpenSSH 10.0p2 Debian 7 (protocol 2.0)', '53/udp open  domain  ISC BIND 9.20.11']);

  r = await sim.run('nmap -p U:53,T:22 ns1.halcyon.lab');
  assert.equal(r.err, 'WARNING: Your ports include "U:" but you haven\'t specified UDP scan with -sU.\n');
  assert.deepEqual(portLines(r.out).slice(1), ['22/tcp open  ssh']);
});

test('nmap -oN, -oG, -oX and -oA write the real file formats', async () => {
  const sim = await lab();
  const cat = async (f) => (await sim.run('cat ' + f)).out;
  let r = await sim.run('cd /tmp && sudo nmap -sV -p 22,80,81 web01.halcyon.lab -oA web');
  assert.match(r.out, /^Starting Nmap/);

  const normal = (await cat('/tmp/web.nmap')).split('\n');
  assert.match(normal[0], /^# Nmap 7\.98 scan initiated Fri Nov 13 14:30:\d\d 2026 as: nmap -sV -p 22,80,81 web01\.halcyon\.lab -oA web$/);
  assert.equal(normal[1], 'Nmap scan report for web01.halcyon.lab (10.10.10.10)');
  assert.match(normal[normal.length - 2], /^# Nmap done at Fri Nov 13 14:30:\d\d 2026 -- 1 IP address \(1 host up\) scanned in \d\.\d\d seconds$/);
  assert.deepEqual(normal.slice(1, -2), r.out.split('\n').slice(1, -2), 'the report lines are the ones shown on screen');

  const grep = (await cat('/tmp/web.gnmap')).split('\n');
  assert.equal(grep[1], 'Host: 10.10.10.10 (web01.halcyon.lab)\tStatus: Up');
  assert.equal(grep[2], 'Host: 10.10.10.10 (web01.halcyon.lab)\tPorts: 22/open/tcp//ssh//OpenSSH 10.0p2 Debian 7 (protocol 2.0)/, 80/open/tcp//http//nginx 1.26.3/, 81/closed/tcp//hosts2-ns///');
  assert.match(grep[3], /^# Nmap done at /);

  const xml = await cat('/tmp/web.xml');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE nmaprun>\n<\?xml-stylesheet href="file:\/\/\/usr\/share\/nmap\/nmap\.xsl" type="text\/xsl"\?>\n<!-- Nmap 7\.98 scan initiated /);
  assert.match(xml, /<nmaprun scanner="nmap" args="nmap -sV -p 22,80,81 web01\.halcyon\.lab -oA web" start="\d+" startstr="Fri Nov 13 14:30:\d\d 2026" version="7\.98" xmloutputversion="1\.05">\n<scaninfo type="syn" protocol="tcp" numservices="3" services="22,80-81"\/>\n<verbose level="0"\/>\n<debugging level="0"\/>\n/);
  assert.match(xml, /<host starttime="\d+" endtime="\d+"><status state="up" reason="arp-response" reason_ttl="0"\/>\n<address addr="10\.10\.10\.10" addrtype="ipv4"\/>\n<address addr="[0-9A-F:]{17}" addrtype="mac" vendor="VMware"\/>\n<hostnames>\n<hostname name="web01\.halcyon\.lab" type="user"\/>\n<hostname name="web01\.halcyon\.lab" type="PTR"\/>\n<\/hostnames>\n<ports><port protocol="tcp" portid="22"><state state="open" reason="syn-ack" reason_ttl="64"\/><service name="ssh" product="OpenSSH" version="10\.0p2 Debian 7" extrainfo="protocol 2\.0" method="probed" conf="10"\/><\/port>\n/);
  assert.match(xml, /<port protocol="tcp" portid="81"><state state="closed" reason="reset" reason_ttl="64"\/><service name="hosts2-ns" method="table" conf="3"\/><\/port>\n<\/ports>\n<times srtt="\d+" rttvar="\d+" to="100000"\/>\n<\/host>\n<runstats><finished time="\d+" timestr="[^"]+" summary="Nmap done at [^;]+; 1 IP address \(1 host up\) scanned in \d\.\d\d seconds" elapsed="\d\.\d\d" exit="success"\/><hosts up="1" down="0" total="1"\/>\n<\/runstats>\n<\/nmaprun>\n$/);

  r = await sim.run('nmap -oX - 10.10.10.70');
  assert.match(r.out, /^<\?xml/, '"-" sends that format to standard output instead of the normal text');
  assert.match(r.out, /<ports><extraports state="closed" count="996">\n<extrareasons reason="conn-refused" count="996" proto="tcp" ports="1,3-4,6-7,[\d,-]+"\/>\n<\/extraports>\n<port protocol="tcp" portid="22">/);
  assert.match(r.out, /<port protocol="tcp" portid="5432"><state state="filtered" reason="no-response" reason_ttl="0"\/><service name="postgresql" method="table" conf="3"\/><\/port>/);

  r = await sim.run("sudo nmap -sn 10.10.10.0/24 -oG - | grep 'Status: Up' | cut -f1 | cut -d' ' -f2 | tail -3");
  assert.equal(r.out, '10.10.10.70\n10.10.10.80\n10.10.10.90\n');
  r = await sim.run('nmap -F 10.10.10.10 -oG /tmp/fast.gnmap >/dev/null; grep -c "Ignored State: closed (97)" /tmp/fast.gnmap');
  assert.equal(r.out, '1\n');
  r = await sim.run('nmap -v -sn 10.10.10.9-10 -oG - | grep Down');
  assert.equal(r.out, 'Host: 10.10.10.9 ()\tStatus: Down\n');
  r = await sim.run('sudo nmap -O -oG - 10.10.10.60 | grep -o "OS: .*"');
  assert.equal(r.out, 'OS: HP LaserJet printer (JetDirect)\n');

  r = await sim.run('nmap -oN /etc/scan.txt 10.10.10.10');
  assert.deepEqual([r.code, r.err, r.out], [1, 'Failed to open normal output file /etc/scan.txt for writing\nQUITTING!\n', '']);
  r = await sim.run('nmap -oQ x 10.10.10.10');
  assert.equal(r.code, 255);
});

test('nmap -R resolves names of hosts that are down too', async () => {
  const sim = await lab();
  const r = await sim.run('nmap -v -R -sn 10.10.10.50');
  assert.match(r.out, /Nmap scan report for dc01\.halcyon\.lab \(10\.10\.10\.50\) \[host down\]\n/);
  assert.match((await sim.run('nmap -v -sn 10.10.10.50')).out, /Nmap scan report for 10\.10\.10\.50 \[host down\]\n/);
});

/* ------------------------------------------------------------- nmap: scripts */

test('nmap -sC: default scripts report what the services publish', async () => {
  const sim = await lab();
  let r = await sim.run('nmap -sC web01.halcyon.lab');
  const out = r.out.split('\n');
  const at = out.indexOf('22/tcp  open  ssh');
  assert.equal(out[at + 1], '| ssh-hostkey: ');
  assert.match(out[at + 2], /^\|   3072 ([0-9a-f]{2}:){15}[0-9a-f]{2} \(RSA\)$/);
  assert.match(out[at + 3], /^\|   256 ([0-9a-f]{2}:){15}[0-9a-f]{2} \(ECDSA\)$/);
  assert.match(out[at + 4], /^\|_  256 ([0-9a-f]{2}:){15}[0-9a-f]{2} \(ED25519\)$/);
  assert.deepEqual(out.slice(at + 5, at + 16), [
    '80/tcp  open  http',
    '| http-robots.txt: 2 disallowed entries ',
    '|_/staff/ /backup/',
    '|_http-title: Halcyon Freight Intranet',
    '443/tcp open  https',
    '| http-robots.txt: 2 disallowed entries ',
    '|_/staff/ /backup/',
    '|_http-title: Halcyon Freight Intranet',
    '| ssl-cert: Subject: commonName=web01.halcyon.lab',
    '| Subject Alternative Name: DNS:web01.halcyon.lab, DNS:www.halcyon.lab, DNS:intranet.halcyon.lab',
    '| Not valid before: 2026-09-01T00:00:00',
  ]);
  assert.equal(out[at + 16], '|_Not valid after:  2026-11-30T23:59:59');
  assert.ok((await sim.run('nmap -sC -p 22 web01.halcyon.lab')).out.includes(out[at + 2] + '\n'), 'a host keeps its simulated fingerprint');
  assert.ok(!(await sim.run('nmap -sC -p 22 db01.halcyon.lab')).out.includes(out[at + 2]), 'and every host has its own');

  r = await sim.run('nmap --script=default -p 21,25 files01.halcyon.lab mail01.halcyon.lab');
  assert.match(r.out, /21\/tcp open +ftp\n\| ftp-anon: Anonymous FTP login allowed \(FTP code 230\)\n\|_drwxr-xr-x +\d+ 0 +0 +4096 \w{3} \d\d [\d:]+ pub\n/);
  assert.match(r.out, /25\/tcp open +smtp\n\|_smtp-commands: mail01\.halcyon\.lab, PIPELINING, SIZE 10240000, [A-Z0-9, ]+\n/);
});

test('nmap --script: named scripts, -sV adds http-server-header, anything else is declined', async () => {
  const sim = await lab();
  let r = await sim.run('nmap --script banner -p 21,22,80 files01.halcyon.lab dev01.halcyon.lab');
  assert.match(r.out, /21\/tcp open +ftp\n\|_banner: 220 \(vsFTPd 3\.0\.5\)\n22\/tcp open +ssh\n\|_banner: SSH-2\.0-OpenSSH_10\.0p2 Debian-7\n80\/tcp closed http\n/);
  assert.match(r.out, /\|_banner: SSH-2\.0-OpenSSH_9\.6p1 Ubuntu-3ubuntu13\.14\n/);

  r = await sim.run('nmap --script http-title -p 80,3000,8080 cam01.halcyon.lab dev01.halcyon.lab printer.halcyon.lab');
  assert.match(r.out, /80\/tcp +open +http\n\|_http-title: 401 Unauthorized\n/);
  assert.match(r.out, /3000\/tcp open +ppp\n\|_http-title: Shipment Tracker \(dev\)\n8080\/tcp open +http-proxy\n\|_http-title: Site doesn't have a title \(text\/html; charset=utf-8\)\.\n/);
  assert.match(r.out, /\|_http-title: HP LaserJet M507 &nbsp; printer\.halcyon\.lab\n/);

  r = await sim.run('nmap -sC -sV -p 80 web01.halcyon.lab');
  assert.match(r.out, /80\/tcp open  http    nginx 1\.26\.3\n\| http-robots\.txt: 2 disallowed entries \n\|_\/staff\/ \/backup\/\n\|_http-server-header: nginx\/1\.26\.3\n\|_http-title: Halcyon Freight Intranet\n/);
  assert.doesNotMatch((await sim.run('nmap -sC -p 80 web01.halcyon.lab')).out, /http-server-header/);

  r = await sim.run('nmap --script vuln,http-title -p 80 gw.halcyon.lab');
  assert.equal(r.err, "NSE: 'vuln' is not part of this simulation, which only has these informational scripts: banner, ftp-anon, http-robots.txt, http-server-header, http-title, smtp-commands, ssh-hostkey, ssl-cert.\n");
  assert.match(r.out, /80\/tcp open  http\n\|_http-title: gw - LuCI\n/);
  r = await sim.run('nmap --script ssh-brute -p 22 web01.halcyon.lab');
  assert.match(r.err, /^NSE: 'ssh-brute' is not part of this simulation/);
  assert.doesNotMatch(r.out, /\|/, 'the scan itself still runs, without script output');
  assert.match(r.out, /22\/tcp open  ssh\n/);

  r = await sim.run('nmap -v --script "http-*" -p 80 web01.halcyon.lab');
  assert.match(r.out, /^Starting Nmap[^\n]*\nNSE: Loaded 3 scripts for scanning\.\n/);
  assert.match(r.out, /NSE: Script scanning 10\.10\.10\.10\.\nInitiating NSE at 14:3\d\nCompleted NSE at 14:3\d, \d\.\d\ds elapsed\n/);

  r = await sim.run('nmap -sC -p 80 web01.halcyon.lab -oX - | grep -o "<script[^>]*>"');
  assert.equal(r.out, '<script id="http-robots.txt" output="2 disallowed entries &#xa;/staff/ /backup/"/>\n<script id="http-title" output="Halcyon Freight Intranet"/>\n');
});

test('nmap scripts behave like clients: requests reach the server logs', async () => {
  const sim = await lab();
  const seen = [];
  sim.K.net.bus.on('http', (e) => seen.push(e.request.method + ' ' + e.request.path + ' ' + e.request.headers['user-agent']));
  await sim.run('nmap -sC -p 80 web01.halcyon.lab');
  assert.deepEqual(seen, [
    'GET /robots.txt Mozilla/5.0 (compatible; Nmap Scripting Engine; https://nmap.org/book/nse.html)',
    'GET / Mozilla/5.0 (compatible; Nmap Scripting Engine; https://nmap.org/book/nse.html)',
  ]);
});

test('nmap: tab completion offers lab hosts and the network in scope', async () => {
  const sim = await lab();
  const complete = (l) => sim.shell.complete(l, l.length).items.map((i) => i.text);
  assert.deepEqual(complete('nmap web'), ['web01.halcyon.lab']);
  assert.deepEqual(complete('nmap -sn 10.'), ['10.10.10.0/24']);
  assert.ok(complete('sudo nmap -p 22 ').includes('dc01.halcyon.lab'));
  assert.deepEqual(complete('nmap --to'), ['--top-ports']);
  assert.deepEqual(complete('nmap --script http-t'), ['http-title']);
  assert.deepEqual(complete('nmap -iL /etc/hostn'), ['/etc/hostname'], 'file names after -iL and -oN');
});

test('nmap: Ctrl-C stops a running scan', async () => {
  const sim = await lab();
  const r = await interrupted(sim, 'nmap -Pn -p- 10.10.10.90');
  assert.equal(r.code, 1, 'Nmap catches the signal and exits with status 1');
  assert.match(r.output, /^Starting Nmap 7\.98/);
  assert.match(r.output, /caught SIGINT signal, cleaning up\n$/);
  assert.doesNotMatch(r.output, /Nmap done/);
});

/* ------------------------------------------------------------------ arp-scan */

test('arp-scan -l: header, one line per responding host and the closing summary', async () => {
  const sim = await lab();
  const r = await sim.run('sudo arp-scan -l');
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  const lines = r.out.split('\n');
  assert.match(lines[0], /^Interface: eth0, type: EN10MB, MAC: 08:00:27:[0-9a-f:]{8}, IPv4: 10\.10\.10\.5$/);
  assert.equal(lines[1], 'Starting arp-scan 1.10.0 with 256 hosts (https://github.com/royhills/arp-scan)');
  assert.match(lines[2], /^10\.10\.10\.1\t00:1b:21:[0-9a-f:]{8}\tIntel Corporate$/);
  assert.match(lines[3], /^10\.10\.10\.10\t00:0c:29:[0-9a-f:]{8}\tVMware, Inc\.$/);
  assert.equal(lines.filter((l) => /^10\.10\.10\.\d+\t/.test(l)).length, 11, 'every lab host answers ARP, the scanner itself is not listed');
  assert.match(r.out, /\n10\.10\.10\.50\t00:15:5d:[0-9a-f:]{8}\tMicrosoft Corporation\n/, 'a host that drops ICMP still answers ARP');
  assert.match(r.out, /\n10\.10\.10\.90\t[0-9a-f:]{17}\tVMware, Inc\.\n\n11 packets received by filter, 0 packets dropped by kernel\n/);
  const end = /\nEnding arp-scan 1\.10\.0: 256 hosts scanned in (\d\.\d{3}) seconds \((\d+\.\d\d) hosts\/sec\)\. 11 responded\n$/.exec(r.out);
  assert.ok(end, 'closing summary');
  assert.ok(+end[1] > 1.5 && +end[1] < 2.6, 'a /24 takes about two seconds: ' + end[1]);
  assert.ok(Math.abs(256 / +end[1] - +end[2]) < 0.1, 'the rate matches the duration');
  assert.equal((await sim.run('sudo arp-scan --localnet')).out.split('\n').length, lines.length);
});

test('arp-scan: explicit targets, ranges, -I, -q and -x', async () => {
  const sim = await lab();
  let r = await sim.run('sudo arp-scan -I eth0 10.10.10.1-10.10.10.20');
  assert.match(r.out, /Starting arp-scan 1\.10\.0 with 20 hosts /);
  assert.deepEqual(r.out.split('\n').filter((l) => /\t/.test(l)).map((l) => l.split('\t')[0]), ['10.10.10.1', '10.10.10.10', '10.10.10.20']);
  assert.match(r.out, /Ending arp-scan 1\.10\.0: 20 hosts scanned in 1\.\d{3} seconds \(\d+\.\d\d hosts\/sec\)\. 3 responded\n$/);

  r = await sim.run('sudo arp-scan 10.10.10.0/28 --plain --quiet');
  assert.match(r.out, /^10\.10\.10\.1\t[0-9a-f:]{17}\n10\.10\.10\.10\t[0-9a-f:]{17}\n$/, 'plain output has no header or footer, quiet output no vendor');
  assert.match((await sim.run('sudo arp-scan 10.10.10.0:255.255.255.240')).out, /with 16 hosts /);

  r = await sim.run('sudo arp-scan dc01.halcyon.lab 10.10.10.99 nosuchhost.halcyon.lab');
  assert.equal(r.err, 'WARNING: get_host_address failed for "nosuchhost.halcyon.lab": Name or service not known - target ignored\n');
  assert.match(r.out, /with 2 hosts [^\n]*\n10\.10\.10\.50\t[^\n]*\n\n1 packets received by filter, 0 packets dropped by kernel\nEnding arp-scan 1\.10\.0: 2 hosts scanned in \d\.\d{3} seconds [^\n]*\. 1 responded\n$/);

  r = await sim.run('sudo arp-scan 10.10.10.10 10.10.10.20');
  assert.match(r.out, /2 hosts scanned in 0\.\d{3} seconds/, 'nothing to wait for when every host answered');
  assert.equal((await sim.run("sudo arp-scan -l -x | cut -f1 | tail -2")).out, '10.10.10.80\n10.10.10.90\n', 'usable in a pipeline');
});

test('arp-scan: needs root, and its error paths', async () => {
  const sim = await lab();
  let r = await sim.run('arp-scan -l');
  assert.deepEqual([r.code, r.out, r.err], [1, '', "pcap_activate: eth0: You don't have permission to perform this capture on that device (socket: Operation not permitted)\n"]);
  r = await sim.run('sudo arp-scan');
  assert.equal(r.code, 1);
  assert.match(r.err, /^Usage: arp-scan \[options\] \[hosts\.\.\.\]\n\nTarget hosts must be specified on the command line unless the --file or\n--localnet option is used\.\n/);
  assert.match(r.err, /\nuse "arp-scan --help" for detailed information on the available options\.\n/);
  r = await sim.run('sudo arp-scan --bogus');
  assert.equal(r.code, 1);
  assert.match(r.err, /^arp-scan: unrecognized option '--bogus'\nUsage: arp-scan /);
  r = await sim.run('sudo arp-scan -l 10.10.10.10');
  assert.deepEqual([r.code, r.err], [1, 'ERROR: You can not specify targets with the --localnet option\n']);
  r = await sim.run('sudo arp-scan -I eth7 -l');
  assert.deepEqual([r.code, r.err], [1, 'ioctl: No such device\n']);
  r = await sim.run('sudo arp-scan nosuchhost.halcyon.lab');
  assert.equal(r.code, 1);
  assert.match(r.err, /target ignored\nERROR: No hosts to process\.\n$/);
  r = await sim.run('arp-scan --help');
  assert.equal(r.code, 0);
  assert.match(r.out, /\n--localnet or -l\tGenerate addresses from network interface configuration\.\n/);
  assert.match((await sim.run('arp-scan -V')).out, /^arp-scan 1\.10\.0\n\nCopyright \(C\) 2005-2022 Roy Hills\n/);
  assert.match((await sim.run('man arp-scan')).out, /Send ARP requests to target hosts and display responses/);
});

test('arp-scan: addresses outside the scope are not probed', async () => {
  const sim = await lab();
  const r = await sim.run('sudo arp-scan 192.168.56.0/24 10.10.10.10');
  assert.equal(r.err.match(/Out-of-scope target blocked/g).length, 1);
  assert.match(r.err, /arp-scan is an active testing tool/);
  assert.match(r.err, /\[kalima\] 255 more addresses of 192\.168\.56\.0\/24 outside the scope: skipped\./);
  assert.match(r.out, /\n10\.10\.10\.10\t/);
  assert.match(r.out, /: 1 hosts scanned in [^\n]* 1 responded\n$/);
});

/* --------------------------------------------------------------------- fping */

test('fping: alive and unreachable targets, exit status', async () => {
  const sim = await lab();
  let r = await sim.run('fping web01.halcyon.lab 10.10.10.20');
  assert.deepEqual([r.code, r.out, r.err], [0, 'web01.halcyon.lab is alive\n10.10.10.20 is alive\n', '']);

  r = await sim.run('fping 10.10.10.10 dc01.halcyon.lab');
  assert.deepEqual([r.code, r.out, r.err], [1, '10.10.10.10 is alive\ndc01.halcyon.lab is unreachable\n', ''], 'a host that drops ICMP looks unreachable');

  r = await sim.run('fping 10.10.10.99');
  assert.equal(r.out, '10.10.10.99 is unreachable\n');
  assert.equal(r.err, 'ICMP Host Unreachable from 10.10.10.5 for ICMP Echo sent to 10.10.10.99\n'.repeat(3), 'the kernel reports the failed ARP lookup');

  r = await sim.run('fping nosuchhost.halcyon.lab 10.10.10.10');
  assert.deepEqual([r.code, r.out, r.err], [2, '10.10.10.10 is alive\n', 'nosuchhost.halcyon.lab: Name or service not known\n']);

  r = await sim.run('fping -e 10.10.10.10 10.10.10.60');
  assert.match(r.out, /^10\.10\.10\.10 is alive \(0\.\d{3} ms\)\n10\.10\.10\.60 is alive \(\d\.\d\d ms\)\n$/);
  assert.equal((await sim.run('fping -A web01.halcyon.lab')).out, '10.10.10.10 is alive\n');
  assert.equal((await sim.run('fping -n 10.10.10.30')).out, 'db01.halcyon.lab is alive\n');
  r = await sim.run('fping -q 10.10.10.10 10.10.10.99');
  assert.deepEqual([r.code, r.out, r.err], [1, '', '']);
});

test('fping -a, -u and -g sweep a range', async () => {
  const sim = await lab();
  let r = await sim.run('fping -a -g 10.10.10.0/24 2>/dev/null');
  assert.equal(r.code, 1);
  assert.equal(r.out, ['1', '5', '10', '20', '30', '40', '53', '60', '70', '80'].map((n) => '10.10.10.' + n + '\n').join(''), 'the hosts that answer ICMP; dc01 and backup01 do not');

  r = await sim.run('fping -u -g 10.10.10.8 10.10.10.11 2>/dev/null');
  assert.equal(r.out, '10.10.10.8\n10.10.10.9\n10.10.10.11\n');
  r = await sim.run('fping -g 10.10.10.0/30');
  assert.equal(r.out, '10.10.10.1 is alive\n10.10.10.2 is unreachable\n', 'network and broadcast address are left out');
  r = await sim.run('fping -g 10.10.10.10/32');
  assert.equal(r.out, '10.10.10.10 is alive\n');
  assert.equal((await sim.run('fping -a -g 10.10.10.0/24 2>/dev/null | wc -l')).out.trim(), '10');

  await sim.run('printf "10.10.10.10\\n# printers\\n  printer.halcyon.lab  the big one\\n" > /tmp/hosts.txt');
  assert.equal((await sim.run('fping -f /tmp/hosts.txt')).out, '10.10.10.10 is alive\nprinter.halcyon.lab is alive\n');
  assert.equal((await sim.run('echo 10.10.10.30 | fping')).out, '10.10.10.30 is alive\n');
  assert.equal((await sim.run('cat /tmp/hosts.txt | fping -a -f -')).out, '10.10.10.10\nprinter.halcyon.lab\n');
});

test('fping -c: per-ping lines, per-target statistics, -q and -s', async () => {
  const sim = await lab();
  let r = await sim.run('fping -c 3 web01.halcyon.lab 10.10.10.50');
  assert.equal(r.code, 1);
  const out = r.out.split('\n');
  assert.equal(out.length, 7);
  assert.match(out[0], /^web01\.halcyon\.lab : \[0\], 64 bytes, 0\.\d{3} ms \(0\.\d{3} avg, 0% loss\)$/);
  assert.equal(out[1], '10.10.10.50       : [0], timed out (NaN avg, 100% loss)');
  assert.match(out[4], /^web01\.halcyon\.lab : \[2\], 64 bytes, /);
  assert.match(r.err, /^\nweb01\.halcyon\.lab : xmt\/rcv\/%loss = 3\/3\/0%, min\/avg\/max = 0\.\d{3}\/0\.\d{3}\/0\.\d{3}\n10\.10\.10\.50       : xmt\/rcv\/%loss = 3\/0\/100%\n$/);

  r = await sim.run('fping -q -c 2 10.10.10.10');
  assert.equal(r.out, '');
  assert.match(r.err, /^10\.10\.10\.10 : xmt\/rcv\/%loss = 2\/2\/0%, min\/avg\/max = [\d.]+\/[\d.]+\/[\d.]+\n$/);
  r = await sim.run('fping -q -c 1 -g 10.10.10.8/30 2>&1 | grep -c "0/100%"');
  assert.equal(r.out, '1\n', 'the summary can be filtered once stderr is redirected');

  r = await sim.run('fping -s 10.10.10.10 10.10.10.50');
  assert.match(r.err, /^\n {7}2 targets\n {7}1 alive\n {7}1 unreachable\n {7}0 unknown addresses\n\n {7}1 timeouts \(waiting for response\)\n {7}5 ICMP Echos sent\n {7}1 ICMP Echo Replies received\n {7}0 other ICMP received\n\n 0\.\d{3} ms \(min round trip time\)\n 0\.\d{3} ms \(avg round trip time\)\n 0\.\d{3} ms \(max round trip time\)\n {8}4\.\d{3} sec \(elapsed real time\)\n\n$/);
  r = await sim.run('fping -s -r 0 10.10.10.50');
  assert.match(r.err, /\n 0\.000 ms \(min round trip time\)\n/);
});

test('fping: usage, version, option errors and the scope guard', async () => {
  const sim = await lab();
  let r = await sim.run('fping -h');
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage: fping \[options\] \[targets\.\.\.\]\n\nProbing options:\n/);
  assert.match(r.out, /\n   -a, --alive        show targets that are alive\n/);
  assert.equal((await sim.run('fping -v')).out, 'fping: Version 5.4\n');
  r = await sim.run('fping -Z 10.10.10.10');
  assert.deepEqual([r.code, r.err], [1, "fping: invalid option -- 'Z'\nsee 'fping -h' for usage information\n"]);
  r = await sim.run('fping --bogus 10.10.10.10');
  assert.equal(r.err, "fping: invalid option -- 'bogus'\nsee 'fping -h' for usage information\n");
  r = await sim.run('fping -a -u 10.10.10.10');
  assert.deepEqual([r.code, r.err], [1, 'fping: specify only one of a, u\n']);
  r = await sim.run('fping -g');
  assert.equal(r.code, 1);
  assert.match(r.err, /^Usage: fping /);
  r = await sim.run('fping -g 10.0.0.0/8');
  assert.deepEqual([r.code, r.err], [1, 'fping: -g parameter generates too many addresses\n']);
  r = await sim.run('fping -g 10.10.10.0/40');
  assert.equal(r.err, 'fping: netmask must be between 1 and 32 (is: 40)\n');
  r = await sim.run('fping -f /tmp/missing.txt');
  assert.deepEqual([r.code, r.err], [4, 'fping: fopen : No such file or directory\n']);
  assert.match((await sim.run('man fping')).out, /send ICMP ECHO_REQUEST packets to network hosts/);

  r = await sim.run('fping 8.8.8.8 10.10.10.10');
  assert.match(r.err, /Out-of-scope target blocked: 8\.8\.8\.8/);
  assert.equal(r.out, '10.10.10.10 is alive\n');
  r = await sim.run('fping -a -g 203.0.113.0/29');
  assert.equal(r.err.match(/Out-of-scope target blocked/g).length, 1);
  assert.deepEqual([r.code, r.out], [1, '']);
});

/* -------------------------------------------------------------------- arping */

test('arping: replies, timeouts and statistics', async () => {
  const sim = await lab();
  let r = await sim.run('sudo arping -c 3 10.10.10.50');
  assert.equal(r.code, 0);
  const lines = r.out.split('\n');
  assert.equal(lines[0], 'ARPING 10.10.10.50');
  for (let i = 0; i < 3; i++) assert.match(lines[1 + i], new RegExp('^60 bytes from 00:15:5d:[0-9a-f:]{8} \\(10\\.10\\.10\\.50\\): index=' + i + ' time=(\\d{3}\\.\\d{3} usec|\\d\\.\\d{3} msec)$'));
  assert.deepEqual(lines.slice(4, 7), ['', '--- 10.10.10.50 statistics ---', '3 packets transmitted, 3 packets received,   0% unanswered (0 extra)']);
  assert.match(lines[7], /^rtt min\/avg\/max\/std-dev = 0\.\d{3}\/0\.\d{3}\/\d\.\d{3}\/0\.\d{3} ms$/);

  r = await sim.run('sudo arping -c 2 10.10.10.99');
  assert.deepEqual([r.code, r.out], [1, 'ARPING 10.10.10.99\nTimeout\nTimeout\n\n--- 10.10.10.99 statistics ---\n2 packets transmitted, 0 packets received, 100% unanswered (0 extra)\n\n']);

  r = await sim.run('sudo arping -c 1 -I eth0 gw.halcyon.lab');
  assert.match(r.out, /^ARPING 10\.10\.10\.1\n60 bytes from 00:1b:21:[0-9a-f:]{8} \(10\.10\.10\.1\): index=0 /);
  r = await sim.run('sudo arping -r -c 2 gw.halcyon.lab');
  assert.match(r.out, /^(00:1b:21:[0-9a-f:]{8}\n){2}$/, '-r prints only the MAC address');
  assert.equal((await sim.run('sudo arping -r -c 1 10.10.10.10 | tr a-f A-F')).out, sim.K.net.hostById('web01').mac.toUpperCase() + '\n');
  r = await sim.run('sudo arping -q -c 1 10.10.10.10');
  assert.deepEqual([r.code, r.out], [0, '']);
  assert.equal((await sim.run('sudo arping -q -c 1 10.10.10.99')).code, 1);
});

test('arping: needs root, error paths and the scope guard', async () => {
  const sim = await lab();
  let r = await sim.run('arping -c 1 10.10.10.10');
  assert.deepEqual([r.code, r.out, r.err], [1, '', 'arping: libnet_init(LIBNET_LINK, <null>): libnet_open_link(): UID/EUID 0 or capability CAP_NET_RAW required\n']);
  r = await sim.run('sudo arping');
  assert.equal(r.code, 1);
  assert.match(r.err, /^ARPing 2\.26, by Thomas Habets <thomas@habets\.se>\nusage: arping /);
  r = await sim.run('sudo arping -Z 10.10.10.10');
  assert.equal(r.code, 1);
  assert.match(r.err, /^arping: invalid option -- 'Z'\nARPing 2\.26, /);
  r = await sim.run('sudo arping -c 1 -i eth7 10.10.10.10');
  assert.deepEqual([r.code, r.err], [1, 'arping: libnet_init(LIBNET_LINK, eth7): libnet_check_iface() ioctl: No such device\n']);
  r = await sim.run('sudo arping -c 1 nosuchhost.halcyon.lab');
  assert.equal(r.code, 1);
  assert.match(r.err, /^arping: Can't resolve nosuchhost\.halcyon\.lab, or nosuchhost\.halcyon\.lab is broadcast: /);
  r = await sim.run('sudo arping -c 1 8.8.8.8');
  assert.equal(r.code, 1);
  assert.match(r.err, /Out-of-scope target blocked: 8\.8\.8\.8/);
  assert.equal(r.out, '');
  assert.equal((await sim.run('arping --help')).code, 0);
  assert.match((await sim.run('man arping')).out, /sends arp and\/or ip pings to a given host/);
});

test('arping and fping: Ctrl-C ends the run with the statistics', async () => {
  const sim = await lab();
  let r = await interrupted(sim, 'sudo arping 10.10.10.10');
  assert.match(r.output, /ARPING 10\.10\.10\.10\n60 bytes from [0-9a-f:]{17} \(10\.10\.10\.10\): index=0 [^\n]*\n\n--- 10\.10\.10\.10 statistics ---\n1 packets transmitted, 1 packets received, {3}0% unanswered \(0 extra\)\n/);
  assert.equal(r.code, 0, 'like ping, the exit status says whether a reply came');

  const sim2 = await lab();
  r = await interrupted(sim2, 'fping -c 50 10.10.10.10');
  assert.match(r.output, /10\.10\.10\.10 : \[0\], 64 bytes, [^\n]*\n\n10\.10\.10\.10 : xmt\/rcv\/%loss = 1\/1\/0%, min\/avg\/max = /);

  const sim3 = await lab();
  r = await interrupted(sim3, 'sudo arp-scan -t 5000 10.10.10.99');
  assert.equal(r.code, 130);
  assert.doesNotMatch(r.output, /Ending arp-scan/);
});

test('discovery tools: tab completion offers lab hosts and interfaces', async () => {
  const sim = await lab();
  const complete = (l) => sim.shell.complete(l, l.length).items.map((i) => i.text);
  assert.deepEqual(complete('fping db'), ['db01.halcyon.lab']);
  assert.deepEqual(complete('sudo arp-scan 10.'), ['10.10.10.0/24']);
  assert.deepEqual(complete('sudo arp-scan -I e'), ['eth0']);
  assert.deepEqual(complete('sudo arping -i e'), ['eth0']);
  assert.ok(complete('sudo arping ').includes('gw.halcyon.lab'));
});
