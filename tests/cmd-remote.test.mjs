// Remote pack: ssh, scp, key tools, nc, telnet, ftp and the protocol handlers behind them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

const WEB01 = 'student@web01.halcyon.lab';

/** Run a line with the given terminal input queued; returns the result plus what reached the terminal. */
async function withInput(sim, line, input, opts) {
  sim.term.take();
  sim.term.feed(...input);
  const r = await sim.run(line, opts);
  return Object.assign(r, { screen: sim.strip(sim.term.take()) });
}

/** Trust web01's host key so later tests in the same simulator skip the question. */
async function trustWeb01(sim) {
  return withInput(sim, `ssh ${WEB01} true`, ['yes', 'student']);
}

test('ssh: connection failures use the real wording and exit 255', async () => {
  const sim = await boot();
  const fail = async (line, text) => {
    const r = await sim.run(line);
    assert.equal(r.code, 255, line);
    assert.equal(r.err, text + '\n', line);
  };
  await fail('ssh nohost.halcyon.lab', 'ssh: Could not resolve hostname nohost.halcyon.lab: Name or service not known');
  await fail('ssh student@printer.halcyon.lab', 'ssh: connect to host printer.halcyon.lab port 22: Connection refused');
  await fail('ssh backup01.halcyon.lab', 'ssh: connect to host backup01.halcyon.lab port 22: Connection timed out');
  await fail('ssh 10.10.10.99', 'ssh: connect to host 10.10.10.99 port 22: No route to host');
  await fail('ssh -p 2222 web01.halcyon.lab', 'ssh: connect to host web01.halcyon.lab port 2222: Connection refused');
  await fail('ssh -p 80 web01.halcyon.lab', 'kex_exchange_identification: Connection closed by remote host\nConnection closed by 10.10.10.10 port 80');
  await fail('ssh -p http web01', "Bad port 'http'");
  const t0 = sim.K.clock.now();
  await sim.run('ssh -o ConnectTimeout=5 backup01.halcyon.lab');
  assert.equal(sim.K.clock.now() - t0 < 6000, true, 'ConnectTimeout bounds the wait');
});

test('ssh: usage, version and unknown options', async () => {
  const sim = await boot();
  let r = await sim.run('ssh -V');
  assert.equal(r.code, 0);
  assert.match(r.err, /^OpenSSH_10\.0p1 Debian-7, OpenSSL /);
  r = await sim.run('ssh');
  assert.equal(r.code, 255);
  assert.match(r.err, /^usage: ssh \[-46AaCfGgKkMNnqsTtVvXxYy\]/);
  r = await sim.run('ssh -Z web01');
  assert.equal(r.code, 255);
  assert.match(r.err, /^unknown option -- Z\nusage: ssh /);
  r = await sim.run('ssh -p');
  assert.match(r.err, /^option requires an argument -- p\n/);
  r = await sim.run('ssh -o NoSuchThing=1 web01');
  assert.equal(r.err, 'command-line: line 0: Bad configuration option: nosuchthing\n');
  assert.match(sim.K.cmd.get('ssh').man, /^DESCRIPTION\n[\s\S]*\nOPTIONS\n[\s\S]*\nEXAMPLES\n {7}ssh student@web01\.halcyon\.lab\n/);
});

test('ssh: first connection asks about the host key and records it', async () => {
  const sim = await boot();
  let r = await withInput(sim, `ssh ${WEB01}`, ['maybe', 'no']);
  assert.equal(r.code, 255);
  assert.match(r.err, /^The authenticity of host 'web01\.halcyon\.lab \(10\.10\.10\.10\)' can't be established\.\nED25519 key fingerprint is SHA256:[A-Za-z0-9+/]{43}\.\nThis key is not known by any other names\.\nHost key verification failed\.\n$/);
  assert.match(r.screen, /^Are you sure you want to continue connecting \(yes\/no\/\[fingerprint\]\)\? maybe\nPlease type 'yes', 'no' or the fingerprint: no\n$/);
  assert.equal((await sim.run('cat ~/.ssh/known_hosts')).code, 1, 'nothing stored after "no"');

  r = await withInput(sim, `ssh ${WEB01}`, ['yes', 'student', 'hostname; whoami; pwd', 'exit']);
  assert.equal(r.code, 0);
  assert.match(r.err, /Warning: Permanently added 'web01\.halcyon\.lab' \(ED25519\) to the list of known hosts\.\n/);
  assert.match(r.err, /Connection to web01\.halcyon\.lab closed\.\n$/);
  assert.match(r.out, /^Linux web01 \S+ .* x86_64\n\nThe programs included with the Debian GNU\/Linux system are free software;/);
  assert.match(r.out, /logout\n$/);
  assert.match(r.screen, /student@web01\.halcyon\.lab's password: \n/);
  assert.match(r.screen, /student@web01:~\$ hostname; whoami; pwd\nweb01\nstudent\n\/home\/student\n/);

  // Debian hashes names in known_hosts; the key itself is the server's /etc/ssh host key
  const known = (await sim.run('cat ~/.ssh/known_hosts')).out;
  assert.match(known, /^\|1\|[A-Za-z0-9+/]{27}=\|[A-Za-z0-9+/]{27}= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}\n$/);
  assert.equal((await sim.run('stat -c %a ~/.ssh/known_hosts')).out, '600\n');
  r = await withInput(sim, `ssh ${WEB01} cat /etc/ssh/ssh_host_ed25519_key.pub`, ['student']);
  assert.equal(r.out.split(' ')[1], known.trim().split(' ')[2]);
  assert.match(r.out, /KALIMA\+SIMULATED\+KEY/);
  assert.doesNotMatch(r.err, /authenticity/, 'a known host is not asked about again');

  // the same server under another name: ssh points at the entry it already has
  r = await withInput(sim, 'ssh student@10.10.10.10 true', ['yes', 'student']);
  assert.match(r.err, /This host key is known by the following other names\/addresses:\n {4}~\/\.ssh\/known_hosts:1: \[hashed name\]\n/);
});

test('ssh: a changed host key stops the connection', async () => {
  const sim = await boot();
  await sim.run('mkdir -p ~/.ssh; echo "web01.halcyon.lab ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOldKeyOldKeyOldKeyOldKeyOldKeyOldKeyOldKeyOld" > ~/.ssh/known_hosts');
  const r = await withInput(sim, `ssh ${WEB01}`, ['student']);
  assert.equal(r.code, 255);
  assert.match(r.err, /@ {4}WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! {5}@\n/);
  assert.match(r.err, /Offending ED25519 key in \/home\/kali\/\.ssh\/known_hosts:1\n {2}remove with:\n {2}ssh-keygen -f '\/home\/kali\/\.ssh\/known_hosts' -R 'web01\.halcyon\.lab'\n/);
  assert.match(r.err, /Host key verification failed\.\n$/);
  const strict = await sim.run('ssh -o StrictHostKeyChecking=yes student@db01.halcyon.lab');
  assert.equal(strict.err, 'No ED25519 host key is known for db01.halcyon.lab and you have requested strict checking.\nHost key verification failed.\n');
});

test('ssh: three password attempts, then the real denial', async () => {
  const sim = await boot();
  await trustWeb01(sim);
  let r = await withInput(sim, `ssh ${WEB01}`, ['wrong', 'nope', 'bad']);
  assert.equal(r.code, 255);
  assert.equal(r.err, 'Permission denied, please try again.\nPermission denied, please try again.\nstudent@web01.halcyon.lab: Permission denied (publickey,password).\n');
  assert.equal(r.screen, "student@web01.halcyon.lab's password: \n".repeat(3));

  r = await withInput(sim, `ssh ${WEB01} whoami`, ['wrong', 'student']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'student\n');
  assert.equal(r.err, 'Permission denied, please try again.\n');

  // the local user name is the default login; kali has no account on web01
  r = await withInput(sim, 'ssh web01.halcyon.lab', ['kali', 'kali', 'kali']);
  assert.match(r.screen, /^kali@web01\.halcyon\.lab's password: /);
  assert.match(r.err, /kali@web01\.halcyon\.lab: Permission denied \(publickey,password\)\.\n$/);
  r = await withInput(sim, 'ssh -l root web01.halcyon.lab', ['root', 'toor', '']);
  assert.equal(r.code, 255, 'root is locked');
  r = await sim.run(`ssh -o BatchMode=yes ${WEB01} true`);
  assert.equal(r.err, 'student@web01.halcyon.lab: Permission denied (publickey,password).\n', 'BatchMode never prompts');
});

test('ssh: hosts without logins always deny', async () => {
  const sim = await boot();
  const r = await withInput(sim, 'ssh -o StrictHostKeyChecking=accept-new student@ns1.halcyon.lab', ['student', 'student', 'student']);
  assert.equal(r.code, 255);
  assert.match(r.err, /^Warning: Permanently added 'ns1\.halcyon\.lab' \(ED25519\)/);
  assert.match(r.err, /student@ns1\.halcyon\.lab: Permission denied \(publickey,password\)\.\n$/);
  assert.equal(sim.K.net.machines.ns1, undefined);
});

test('ssh: a command argument runs remotely and returns its status', async () => {
  const sim = await boot();
  await trustWeb01(sim);
  let r = await withInput(sim, `ssh ${WEB01} 'echo $USER@$(hostname); exit 3'`, ['student']);
  assert.equal(r.out, 'student@web01\n');
  assert.equal(r.code, 3);
  assert.equal(r.err, '', 'no banner and no closing line for a command');
  r = await withInput(sim, `ssh ${WEB01} cat /etc/hostname | tr a-z A-Z`, ['student']);
  assert.equal(r.out, 'WEB01\n');
  r = await withInput(sim, `ssh ${WEB01} nosuchcommand`, ['student']);
  assert.equal(r.code, 127);
  assert.equal(r.err, 'bash: nosuchcommand: command not found\n');
  r = await withInput(sim, `echo 'echo piped on $(hostname)' | ssh ${WEB01}`, ['student']);
  assert.match(r.err, /^Pseudo-terminal will not be allocated because stdin is not a terminal\.\n/);
  assert.match(r.out, /piped on web01\n$/);
  r = await withInput(sim, `ssh -t ${WEB01} true`, ['student']);
  assert.equal(r.err, 'Connection to web01.halcyon.lab closed.\n');

  // lesson checks see where the command ran
  const seen = [];
  const off = sim.K.events.on('command', (e) => seen.push(e));
  sim.term.feed('student');
  await sim.type(`ssh ${WEB01} id -un`);
  off();
  assert.deepEqual(seen[0].commands.map((c) => [c.argv[0], c.host]), [['id', 'web01'], ['ssh', 'kali']]);
});

test('ssh: interactive session details', async () => {
  const sim = await boot();
  sim.K.cmd.register({ name: 'k-procs', run(ctx) { ctx.out(ctx.machine.procs.slice(-3).map((p) => p.user + ' ' + p.cmd).join('\n') + '\n'); } });
  await trustWeb01(sim);
  // end of input logs out like Ctrl-D; a second login shows the previous one
  let r = await withInput(sim, `ssh ${WEB01}`, ['student', 'echo $SSH_CONNECTION; k-procs']);
  assert.equal(r.code, 0);
  assert.match(r.screen, /10\.10\.10\.5 \d+ 10\.10\.10\.10 22\n/);
  assert.match(r.screen, /root sshd-session: student \[priv\]\nstudent sshd-session: student@pts\/0\nstudent k-procs\n/);
  assert.match(r.out, /logout\n$/);
  assert.doesNotMatch(r.screen, /\$ exit\n/);
  r = await withInput(sim, `ssh ${WEB01}`, ['student', 'exit 4']);
  assert.match(r.out, /Last login: \w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d 2026 from 10\.10\.10\.5\n/);
  assert.equal(r.code, 4, 'exit status of the remote shell');
  // end of input inside a remote command ends that command, not the session
  r = await withInput(sim, `ssh ${WEB01}`, ['student', 'cat; echo after', 'typed into cat']);
  assert.match(r.screen, /typed into cat\ntyped into cat\nafter\nstudent@web01:~\$ $/);
  assert.equal(sim.K.net.machines.web01.procs.some((p) => /sshd-session/.test(p.cmd)), false, 'session processes are gone');
  // dev01 is Ubuntu and greets differently
  r = await withInput(sim, 'ssh -q -o StrictHostKeyChecking=accept-new student@dev01.halcyon.lab', ['student', 'exit']);
  assert.match(r.out, /^Welcome to Ubuntu 24\.04\.3 LTS \(GNU\/Linux 6\.8\.0-86-generic x86_64\)\n\n \* Documentation: {2}https:\/\/help\.ubuntu\.com\n/);
  assert.doesNotMatch(r.err, /Connection to/);
});

test('ssh: ~/.ssh/config and -v', async () => {
  const sim = await boot();
  await sim.run('mkdir -p ~/.ssh; printf "Host web\\n  HostName web01.halcyon.lab\\n  User student\\n  StrictHostKeyChecking accept-new\\n" > ~/.ssh/config');
  let r = await withInput(sim, 'ssh web hostname', ['student']);
  assert.equal(r.out, 'web01\n');
  assert.match(r.screen, /^student@web01\.halcyon\.lab's password: /);
  r = await withInput(sim, 'ssh -v web true', ['student']);
  assert.match(r.err, /^debug1: Connecting to web01\.halcyon\.lab \[10\.10\.10\.10\] port 22\.\ndebug1: Connection established\.\n/);
  assert.match(r.err, /debug1: Remote protocol version 2\.0, remote software version OpenSSH_10\.0p2 Debian-7\n/);
  assert.match(r.err, /debug1: Trying private key: \/home\/kali\/\.ssh\/id_ed25519\ndebug1: Next authentication method: password\nAuthenticated to web01\.halcyon\.lab \(\[10\.10\.10\.10\]:22\) using "password"\.\n/);
  r = await withInput(sim, 'ssh -i /tmp/nokey web true', ['student']);
  assert.match(r.err, /^Warning: Identity file \/tmp\/nokey not accessible: No such file or directory\.\n/);
  // options often seen in lab write-ups: a throw-away known_hosts file and no warnings
  r = await withInput(sim, 'ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o LogLevel=ERROR -o ServerAliveInterval=30 student@db01.halcyon.lab hostname', ['student']);
  assert.deepEqual([r.code, r.out, r.err], [0, 'db01\n', '']);
  r = await withInput(sim, 'ssh -q -o StrictHostKeyChecking=accept-new student@dev01.halcyon.lab hostname', ['student']);
  assert.deepEqual([r.out, r.err], ['dev01\n', '']);
});

test("ssh: Kali's own sshd only answers while something listens on port 22", async () => {
  const sim = await boot();
  let r = await sim.run('ssh localhost');
  assert.equal(r.err, 'ssh: connect to host localhost port 22: Connection refused\n');
  const stop = sim.K.net.listen(sim.machine, { port: 22, proto: 'tcp', addr: '0.0.0.0', prog: 'sshd', name: 'ssh' });
  r = await withInput(sim, 'ssh localhost whoami', ['yes', 'kali']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'kali\n');
  r = await withInput(sim, 'ssh kali@10.10.10.5', ['yes', 'kali', 'echo $0']);
  assert.match(r.out, /^Linux kali /);
  assert.doesNotMatch(r.out, /logout/, 'zsh does not announce the logout');
  stop();
  assert.equal((await sim.run('ssh localhost')).code, 255);
});

test('ssh: logins are logged on the server', async () => {
  const sim = await boot();
  await trustWeb01(sim);
  await withInput(sim, `ssh ${WEB01} true`, ['wrong', 'student']);
  await withInput(sim, 'ssh mallory@web01.halcyon.lab', ['a', 'b', 'c']);
  const log = sim.K.net.machines.web01.vfs.read('/var/log/auth.log').split('\n').slice(-18).join('\n');
  assert.match(log, /web01 sshd-session\[(\d+)\]: Failed password for student from 10\.10\.10\.5 port (\d+) ssh2\n.* sshd-session\[\1\]: Accepted password for student from 10\.10\.10\.5 port \2 ssh2\n.*session opened for user student\(uid=1001\) by student\(uid=0\)\n/);
  assert.match(log, /Invalid user mallory from 10\.10\.10\.5 port \d+\n/);
  assert.match(log, /Failed password for invalid user mallory from 10\.10\.10\.5 port \d+ ssh2\n/);
  assert.match(log, /Connection closed by invalid user mallory 10\.10\.10\.5 port \d+ \[preauth\]\n$/);

  // a logging pack takes over when it provides K.syslog
  const entries = [];
  sim.K.syslog = (machine, entry) => { if (!/^Connection from/.test(entry.msg)) entries.push([machine.hostname, entry.facility, entry.ident, entry.msg]); };
  await withInput(sim, `ssh ${WEB01} true`, ['wrong', 'student']);
  delete sim.K.syslog;
  assert.deepEqual(entries.map((e) => e.slice(0, 3)), Array(6).fill(['web01', 'auth', 'sshd-session']));
  assert.match(entries[0][3], /^Failed password for student from 10\.10\.10\.5 port \d+ ssh2$/);
  assert.match(entries[1][3], /^Accepted password for student from /);
});

test('ssh protocol handler: banner, then any input is refused', async () => {
  const sim = await boot();
  const s = sim.K.net.connect(sim.machine, '10.10.10.10', 22);
  assert.equal(s.greeting, 'SSH-2.0-OpenSSH_10.0p2 Debian-7\r\n');
  assert.equal(s.send('hello\n'), 'Invalid SSH identification string.\r\n');
  assert.equal(s.open, false);
  assert.equal(s.send('again\n'), '');
});

/** Let a command that is still running take a few steps (virtual time never yields to timers). */
async function until(condition) {
  for (let i = 0; i < 2000 && !condition(); i++) await Promise.resolve();
  assert.equal(condition(), true, 'condition reached');
}

test('nc: client mode prints the greeting and exchanges lines', async () => {
  const sim = await boot();
  let r = await withInput(sim, 'nc -v web01.halcyon.lab 22', ['hello']);
  assert.equal(r.code, 0);
  assert.equal(r.err, 'web01.halcyon.lab [10.10.10.10] 22 (ssh) open\n');
  assert.equal(r.out, 'SSH-2.0-OpenSSH_10.0p2 Debian-7\r\nInvalid SSH identification string.\r\n');
  assert.equal(r.screen, 'hello\n');
  r = await sim.run('nc web01.halcyon.lab 22 < /dev/null');
  assert.equal(r.output, 'SSH-2.0-OpenSSH_10.0p2 Debian-7\r\n', 'quiet without -v');
  r = await sim.run('printf "GET /robots.txt HTTP/1.0\\r\\n\\r\\n" | nc web01.halcyon.lab 80 | head -1');
  assert.equal(r.out, 'HTTP/1.1 200 OK\r\n');
  for (const alias of ['netcat', 'ncat', 'nc.traditional']) {
    r = await sim.run(alias + ' -vn 10.10.10.10 22 < /dev/null');
    assert.equal(r.err, '(UNKNOWN) [10.10.10.10] 22 (?) open\n', alias);
  }
});

test('nc: failures in netcat-traditional wording', async () => {
  const sim = await boot();
  const fail = async (line, text) => {
    const r = await sim.run(line);
    assert.equal(r.code, 1, line);
    assert.equal(r.err, text + '\n', line);
    assert.equal(r.out, '', line);
  };
  await fail('nc -v printer.halcyon.lab 22', 'printer.halcyon.lab [10.10.10.60] 22 (ssh) : Connection refused');
  await fail('nc -v 10.10.10.10 81', 'web01.halcyon.lab [10.10.10.10] 81 (?) : Connection refused');
  await fail('nc -v 10.10.10.99 22', '10.10.10.99: inverse host lookup failed: Unknown host\n(UNKNOWN) [10.10.10.99] 22 (ssh) : No route to host');
  await fail('nc -v nohost.halcyon.lab 22', 'nohost.halcyon.lab: forward host lookup failed: Unknown host');
  await fail('nc -vn web01.halcyon.lab 22', "Can't parse web01.halcyon.lab as an IP address");
  await fail('nc web01.halcyon.lab', 'no port[s] to connect to');
  await fail('nc -v web01 nosuch', 'invalid port nosuch');
  await fail('nc -w 0 web01 22', 'invalid wait-time 0');
  await fail('nc -x web01 22', "nc: invalid option -- 'x'\nnc -h for help");
  await fail('nc -l -p 80', "Can't grab 0.0.0.0:80 with bind : Permission denied");
  const quiet = await sim.run('nc printer.halcyon.lab 22');
  assert.deepEqual([quiet.code, quiet.output], [1, ''], 'no -v, no message');
  const help = await sim.run('nc -h');
  assert.equal(help.code, 1);
  assert.match(help.err, /^\[v1\.10-50\]\nconnect to somewhere:\tnc \[-options\] hostname port\[s\] \[ports\] \.\.\. \nlisten for inbound:\tnc -l -p port \[-options\] \[hostname\] \[port\]\n/);
  // -w bounds how long a silent host is waited for
  const t0 = sim.K.clock.now();
  await fail('nc -vn -w 2 10.10.10.90 22', '(UNKNOWN) [10.10.10.90] 22 (?) : Connection timed out');
  assert.equal(sim.K.clock.now() - t0, 2000);
});

test('nc -z: port checks, ranges, UDP and the scope guard', async () => {
  const sim = await boot();
  let r = await sim.run('nc -zv files01.halcyon.lab 20-25');
  assert.equal(r.err, 'files01.halcyon.lab [10.10.10.20] 22 (ssh) open\nfiles01.halcyon.lab [10.10.10.20] 21 (ftp) open\n', 'one -v hides refusals in a scan');
  assert.equal(r.code, 0);
  r = await sim.run('nc -zvv 10.10.10.10 79-80 443');
  assert.match(r.err, /^web01\.halcyon\.lab \[10\.10\.10\.10\] 80 \(http\) open\nweb01\.halcyon\.lab \[10\.10\.10\.10\] 79 \((finger|\?)\) : Connection refused\nweb01\.halcyon\.lab \[10\.10\.10\.10\] 443 \(https\) open\n sent 0, rcvd 0\n$/);
  assert.equal(r.code, 1, 'the -vv byte counts leave through bail()');
  r = await sim.run('nc -zv web01 http');
  assert.deepEqual([r.code, r.err], [0, 'web01.halcyon.lab [10.10.10.10] 80 (http) open\n']);
  r = await sim.run('nc -z web01 80 && echo open; nc -z web01 81 || echo closed');
  assert.equal(r.output, 'open\nclosed\n');
  r = await sim.run('nc -zvu printer.halcyon.lab 161');
  assert.deepEqual([r.code, r.err], [0, 'printer.halcyon.lab [10.10.10.60] 161 (snmp) open\n']);
  r = await sim.run('nc -zvu web01.halcyon.lab 161');
  assert.deepEqual([r.code, r.err], [1, 'web01.halcyon.lab [10.10.10.10] 161 (snmp) : Connection refused\n']);

  // probing is only allowed inside the engagement scope; a plain connection is not probing
  const seen = [];
  const off = sim.K.events.on('scope-violation', (e) => seen.push(e));
  r = await sim.run('nc -zv example.com 80');
  off();
  assert.equal(r.code, 1);
  assert.match(sim.strip(r.err), /Out-of-scope target blocked/);
  assert.doesNotMatch(r.err, /open\n/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, 'nc');
  r = await sim.run('nc -v example.com 80 < /dev/null');
  assert.match(r.err, /^example\.com \[[\d.]+\] 80 \(http\) open\n$/);
});

test('nc -l: a listener shows what a client in another terminal sends', async () => {
  const sim = await boot();
  const K = sim.K;
  const listening = () => K.net.listening(sim.machine).some((l) => l.port === 4444);
  const pending = sim.run('nc -lvnp 4444');
  await until(listening);
  const other = new K.Shell({ machine: sim.machine, term: new K.HeadlessTerm(), user: 'kali', interactive: true });
  await other.init();
  const sent = await other.capture('echo hello from the other tab | nc -v -q 1 10.10.10.5 4444');
  assert.equal(sent.err, 'kali [10.10.10.5] 4444 (?) open\n');
  const r = await pending;
  assert.equal(r.code, 0);
  assert.equal(r.out, 'hello from the other tab\n');
  assert.match(r.err, /^listening on \[any\] 4444 \.\.\.\nconnect to \[10\.10\.10\.5\] from \(UNKNOWN\) \[10\.10\.10\.5\] \d+\n$/);
  assert.equal(listening(), false, 'the port is released');
  assert.equal((await other.capture('nc -v localhost 4444')).err, 'localhost [127.0.0.1] 4444 (?) : Connection refused\n');

  // nothing connects: the listener runs until Ctrl-C
  const waiting = sim.run('nc -lvp 5555');
  await until(() => K.net.listening(sim.machine).some((l) => l.port === 5555));
  const busy = await other.capture('nc -lp 5555');
  assert.equal(busy.err, "Can't grab 0.0.0.0:5555 with bind : Address already in use\n");
  sim.term.raiseInterrupt();
  const stopped = await waiting;
  assert.equal(stopped.code, 130);
  assert.equal(stopped.err, 'listening on [any] 5555 ...\n');
  assert.equal(K.net.listening(sim.machine).some((l) => l.port === 5555), false);
  const timed = await sim.run('nc -lvp 5556 -w 3');
  assert.deepEqual([timed.code, timed.err], [1, 'listening on [any] 5556 ...\nno connection : Connection timed out\n']);
});

test('telnet: connection lines and a line session', async () => {
  const sim = await boot();
  let r = await withInput(sim, 'telnet web01.halcyon.lab 22', ['hello']);
  assert.equal(r.out, "Trying 10.10.10.10...\nConnected to web01.halcyon.lab.\nEscape character is '^]'.\nSSH-2.0-OpenSSH_10.0p2 Debian-7\r\nInvalid SSH identification string.\r\n");
  assert.equal(r.err, 'Connection closed by foreign host.\n');
  assert.equal(r.code, 1);
  r = await withInput(sim, 'telnet cam01.halcyon.lab', ['^]', 'bogus', 'quit']);
  assert.match(r.out, /Escape character is '\^\]'\.\n\r\ncam01 login: \r\n\?Invalid command\nConnection closed\.\n$/);
  assert.equal(r.code, 0);
  assert.match(r.screen, /telnet> bogus\ntelnet> quit\n$/);
  r = await sim.run('telnet printer.halcyon.lab');
  assert.deepEqual([r.code, r.out, r.err], [1, 'Trying 10.10.10.60...\n', 'telnet: Unable to connect to remote host: Connection refused\n']);
  r = await sim.run('telnet nohost.halcyon.lab');
  assert.deepEqual([r.code, r.err], [1, 'telnet: could not resolve nohost.halcyon.lab/telnet: Name or service not known\n']);
  r = await sim.run('telnet web01 nosuchsvc');
  assert.equal(r.err, 'telnet: could not resolve web01/nosuchsvc: Servname not supported for ai_socktype\n');
  r = await withInput(sim, 'telnet', ['open web01.halcyon.lab ssh']);
  assert.match(r.out, /^Trying 10\.10\.10\.10\.\.\.\nConnected to web01\.halcyon\.lab\.\n/);
  r = await sim.run('telnet -Q');
  assert.deepEqual([r.code, r.err], [64, "telnet: invalid option -- 'Q'\nTry 'telnet --help' or 'telnet --usage' for more information.\n"]);
  assert.match((await sim.run('telnet --help')).out, /^Usage: telnet \[OPTION\.\.\.\] \[HOST \[PORT\]\]\nLogin to remote system HOST/);
  assert.match((await sim.run('telnet --version')).out, /^telnet \(GNU inetutils\) 2\.\d+\n/);
});

test('ssh-keygen: interactive generation writes both halves in the OpenSSH layouts', async () => {
  const sim = await boot();
  await sim.run('rm -rf ~/.ssh');
  let r = await withInput(sim, 'ssh-keygen', ['', 'first try', 'second try', '', '']);
  assert.equal(r.code, 0);
  assert.equal(r.screen, 'Enter file in which to save the key (/home/kali/.ssh/id_ed25519): \n' +
    'Enter passphrase for "/home/kali/.ssh/id_ed25519" (empty for no passphrase): \nEnter same passphrase again: \n'.repeat(2));
  assert.equal(r.err, "Created directory '/home/kali/.ssh'.\n");
  const lines = r.out.split('\n');
  assert.deepEqual(lines.slice(0, 5), ['Generating public/private ed25519 key pair.', 'Passphrases do not match.  Try again.',
    'Your identification has been saved in /home/kali/.ssh/id_ed25519', 'Your public key has been saved in /home/kali/.ssh/id_ed25519.pub', 'The key fingerprint is:']);
  assert.match(lines[5], /^SHA256:[A-Za-z0-9+/]{43} kali@kali$/);
  assert.equal(lines[6], "The key's randomart image is:");
  assert.equal(lines[7], '+--[ED25519 256]--+');
  for (const row of lines.slice(8, 17)) assert.match(row, /^\|[ .o+=*BOX@%&#/^SE]{17}\|$/);
  assert.equal(lines[17], '+----[SHA256]-----+');
  assert.equal(lines.slice(8, 17).join('').replace(/[^SE]/g, '').length, 2, 'start and end of the walk are marked');

  assert.equal((await sim.run('stat -c "%a %n" ~/.ssh ~/.ssh/id_ed25519 ~/.ssh/id_ed25519.pub')).out,
    '700 /home/kali/.ssh\n600 /home/kali/.ssh/id_ed25519\n644 /home/kali/.ssh/id_ed25519.pub\n');
  const pub = (await sim.run('cat ~/.ssh/id_ed25519.pub')).out;
  assert.match(pub, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43} kali@kali\n$/);
  assert.match(pub, /KALIMA\+SIMULATED\+KEY/, 'the key says what it is');
  const prv = (await sim.run('cat ~/.ssh/id_ed25519')).out.split('\n');
  assert.equal(prv[0], '-----BEGIN OPENSSH PRIVATE KEY-----');
  assert.match(prv[1], /^b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB[A-Za-z0-9+/]{18}$/, 'openssh-key-v1, no cipher, 70 columns');
  assert.equal(prv[prv.length - 2], '-----END OPENSSH PRIVATE KEY-----');

  // the same key again: -y and -l read it back
  assert.equal((await sim.run('ssh-keygen -y -f ~/.ssh/id_ed25519')).out, pub);
  r = await sim.run('ssh-keygen -l -f ~/.ssh/id_ed25519');
  assert.equal(r.out, '256 ' + lines[5] + ' (ED25519)\n');
  r = await sim.run('ssh-keygen -lv -f ~/.ssh/id_ed25519.pub');
  assert.equal(r.out, '256 ' + lines[5] + ' (ED25519)\n' + lines.slice(7, 18).join('\n') + '\n');

  // an existing key is only replaced after a yes
  r = await withInput(sim, 'ssh-keygen', ['', 'n']);
  assert.equal(r.code, 1);
  assert.match(r.screen, /Overwrite \(y\/n\)\? n\n$/);
  assert.equal(r.out, 'Generating public/private ed25519 key pair.\n/home/kali/.ssh/id_ed25519 already exists.\n');
  assert.equal((await sim.run('cat ~/.ssh/id_ed25519.pub')).out, pub);
  r = await sim.run("printf '\\ny\\n' | ssh-keygen -N ''");
  assert.equal(r.code, 0);
  assert.match(r.out, /^Generating public\/private ed25519 key pair\.\nEnter file in which to save the key \(\/home\/kali\/\.ssh\/id_ed25519\): \/home\/kali\/\.ssh\/id_ed25519 already exists\.\nOverwrite \(y\/n\)\? Your identification has been saved in /);
  assert.notEqual((await sim.run('cat ~/.ssh/id_ed25519.pub')).out, pub, 'a new key each time');
});

test('ssh-keygen: key types, sizes, passphrases and options', async () => {
  const sim = await boot();
  let r = await sim.run("ssh-keygen -t rsa -b 4096 -f /tmp/lab_rsa -N '' -C 'kali@lab'");
  assert.equal(r.code, 0);
  assert.match(r.out, /^Generating public\/private rsa key pair\.\nYour identification has been saved in \/tmp\/lab_rsa\nYour public key has been saved in \/tmp\/lab_rsa\.pub\nThe key fingerprint is:\nSHA256:\S{43} kali@lab\nThe key's randomart image is:\n\+---\[RSA 4096\]----\+\n/);
  assert.match((await sim.run('cat /tmp/lab_rsa.pub')).out, /^ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQ[A-Za-z0-9+/]+=* kali@lab\n$/);
  assert.match((await sim.run('ssh-keygen -l -f /tmp/lab_rsa.pub')).out, /^4096 SHA256:\S{43} kali@lab \(RSA\)\n$/);
  assert.match((await sim.run("ssh-keygen -t rsa -f /tmp/r -N '' -q; ssh-keygen -l -f /tmp/r")).out, /^3072 SHA256:\S+ kali@kali \(RSA\)\n$/);
  r = await sim.run("ssh-keygen -t ecdsa -b 384 -f /tmp/ec -N '' | tail -11 | head -1; cat /tmp/ec.pub");
  assert.match(r.out, /^\+---\[ECDSA 384\]---\+\necdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQAAABh\S+ kali@kali\n$/);

  // a passphrase locks the private key
  r = await sim.run('ssh-keygen -q -f /tmp/locked -N "correct horse"');
  assert.deepEqual([r.code, r.output], [0, '']);
  assert.match((await sim.run('head -2 /tmp/locked | tail -1')).out, /^b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0/, 'aes256-ctr with bcrypt');
  r = await withInput(sim, 'ssh-keygen -y -f /tmp/locked', ['wrong']);
  assert.deepEqual([r.code, r.err], [255, 'Load key "/tmp/locked": incorrect passphrase supplied to decrypt private key\n']);
  assert.equal(r.screen, 'Enter passphrase for "/tmp/locked": \n');
  r = await withInput(sim, 'ssh-keygen -y -f /tmp/locked', ['correct horse']);
  assert.equal(r.out, (await sim.run('cat /tmp/locked.pub')).out);
  assert.match((await sim.run('ssh-keygen -l -f /tmp/locked')).out, / kali@kali \(ED25519\)\n$/, 'the fingerprint needs no passphrase');
  assert.match((await sim.run('ssh-keygen -l -E md5 -f /tmp/locked.pub')).out, /^256 MD5:([0-9a-f]{2}:){15}[0-9a-f]{2} kali@kali \(ED25519\)\n$/);

  // a private key readable by others is refused
  await sim.run('chmod 644 /tmp/r');
  r = await sim.run('ssh-keygen -y -f /tmp/r');
  assert.equal(r.code, 255);
  assert.match(r.err, /WARNING: UNPROTECTED PRIVATE KEY FILE! +@\n@+\nPermissions 0644 for '\/tmp\/r' are too open\.\n[\s\S]*Load key "\/tmp\/r": bad permissions\n$/);

  const fatal = async (line, text, code = 255) => {
    const f = await sim.run(line);
    assert.equal(f.code, code, line);
    assert.equal(f.err.split('\n').slice(0, text.split('\n').length).join('\n'), text, line);
  };
  await fatal('ssh-keygen -t dsa', 'unknown key type dsa');
  await fatal('ssh-keygen -t rsa -b 512', 'Invalid RSA key length: minimum is 1024 bits');
  await fatal('ssh-keygen -t ecdsa -b 300', 'Invalid ECDSA key length: valid lengths are 256, 384 or 521 bits');
  await fatal('ssh-keygen -b many', 'Bits has bad value many (invalid)');
  await fatal('ssh-keygen -l -E crc32 -f /tmp/r.pub', 'Invalid hash algorithm "crc32"');
  await fatal('ssh-keygen -l -f /nofile', 'ssh-keygen: /nofile: No such file or directory');
  await fatal('ssh-keygen -l -f /etc/hostname', '/etc/hostname is not a public key file.');
  await fatal('ssh-keygen -y -f /nofile', '/nofile: No such file or directory');
  await fatal("ssh-keygen -f /nodir/key -N ''", 'Saving key "/nodir/key" failed: No such file or directory');
  await fatal('ssh-keygen -Z', 'unknown option -- Z\nusage: ssh-keygen [-q] [-a rounds] [-b bits] [-C comment] [-f output_keyfile]', 1);
  await fatal('ssh-keygen extra', 'Too many arguments.\nusage: ssh-keygen [-q] [-a rounds] [-b bits] [-C comment] [-f output_keyfile]', 1);
  assert.match(sim.K.cmd.get('ssh-keygen').man, /^DESCRIPTION\n[\s\S]*\nOPTIONS\n[\s\S]*\nEXAMPLES\n/);
});

test('ssh-keygen: known_hosts fingerprints and -R', async () => {
  const sim = await boot();
  await sim.run('mkdir -p ~/.ssh; echo "Host *\n  HashKnownHosts no" > ~/.ssh/config');
  await withInput(sim, `ssh ${WEB01} true`, ['yes', 'student']);
  await withInput(sim, 'ssh student@db01.halcyon.lab true', ['yes', 'student']);
  let r = await sim.run('ssh-keygen -l -f ~/.ssh/known_hosts');
  assert.match(r.out, /^256 SHA256:\S{43} web01\.halcyon\.lab \(ED25519\)\n256 SHA256:\S{43} db01\.halcyon\.lab \(ED25519\)\n$/);
  r = await sim.run('ssh-keygen -R web01.halcyon.lab');
  assert.equal(r.code, 0);
  assert.equal(r.out, '# Host web01.halcyon.lab found: line 1\n/home/kali/.ssh/known_hosts updated.\nOriginal contents retained as /home/kali/.ssh/known_hosts.old\n');
  assert.match((await sim.run('cat ~/.ssh/known_hosts')).out, /^db01\.halcyon\.lab ssh-ed25519 \S+\n$/);
  assert.equal((await sim.run('wc -l < ~/.ssh/known_hosts.old')).out, '2\n');
  r = await sim.run('ssh-keygen -R web01.halcyon.lab');
  assert.deepEqual([r.code, r.output], [0, 'Host web01.halcyon.lab not found in /home/kali/.ssh/known_hosts\n']);
  r = await withInput(sim, `ssh ${WEB01} true`, ['no']);
  assert.match(r.err, /^The authenticity of host 'web01\.halcyon\.lab/, 'the host is unknown again');
  r = await sim.run('ssh-keygen -R web01 -f /tmp/none');
  assert.deepEqual([r.code, r.err], [255, 'Cannot stat /tmp/none: No such file or directory\n']);
});

test('scp: local to remote and back, with the progress line on a terminal', async () => {
  const sim = await boot();
  await trustWeb01(sim);
  await sim.run('echo hello lab > notes.txt; mkdir -p proj/sub; echo one > proj/a.txt; echo two > proj/sub/b.txt; chmod 640 proj/a.txt');
  let r = await withInput(sim, `scp notes.txt ${WEB01}:`, ['student'], { tty: true });
  assert.equal(r.code, 0);
  assert.match(r.out, /^\rnotes\.txt {35} 100% {3}10 {3}[ \d]{3}\.\dKB\/s {3}00:00 {4}\n$/, 'the layout of progressmeter.c at 80 columns');
  assert.equal(r.screen, "student@web01.halcyon.lab's password: \n");
  const web01 = sim.K.net.machines.web01;
  assert.equal(web01.vfs.read('/home/student/notes.txt'), 'hello lab\n');
  assert.equal(web01.vfs.stat('/home/student/notes.txt').uid, 1001, 'owned by the account that logged in');

  r = await withInput(sim, `scp ${WEB01}:/etc/hostname copy.txt`, ['student']);
  assert.deepEqual([r.code, r.output], [0, ''], 'no progress line when stdout is not a terminal');
  assert.equal((await sim.run('cat copy.txt')).out, 'web01\n');
  r = await withInput(sim, `scp -q ${WEB01}:notes.txt ${WEB01}:/etc/hostname /tmp`, ['student', 'student'], { tty: true });
  assert.deepEqual([r.code, r.output], [0, ''], '-q hides the meter');
  assert.equal((await sim.run('cat /tmp/notes.txt /tmp/hostname')).out, 'hello lab\nweb01\n');

  // -r copies trees, -p keeps mode and time
  r = await withInput(sim, `scp -rp proj ${WEB01}:work`, ['student'], { tty: true });
  assert.match(r.out, /^\ra\.txt .* 100% .*\n\rb\.txt .* 100% .*\n$/);
  assert.equal(web01.vfs.read('/home/student/work/sub/b.txt'), 'two\n');
  assert.equal(web01.vfs.stat('/home/student/work/a.txt').mode & 0o777, 0o640);
  assert.equal(web01.vfs.stat('/home/student/work/a.txt').mtime, sim.machine.vfs.stat('/home/kali/proj/a.txt').mtime);
  r = await withInput(sim, `scp -r ${WEB01}:work /tmp/back`, ['student']);
  assert.equal((await sim.run('cat /tmp/back/a.txt /tmp/back/sub/b.txt')).out, 'one\ntwo\n');
  r = await withInput(sim, `scp '${WEB01}:/etc/host*' /tmp/`, ['student'], { tty: true });
  assert.match(r.out, /^\rhostname .*\n\rhosts .*\n$/);

  // two local names: plain cp
  r = await sim.run('scp notes.txt /tmp/n2 && cat /tmp/n2');
  assert.equal(r.out, 'hello lab\n');
});

test('scp: error messages and exit codes', async () => {
  const sim = await boot();
  await trustWeb01(sim);
  await sim.run('echo x > f.txt');
  const fail = async (line, code, text, input = ['student']) => {
    const r = await withInput(sim, line, input);
    assert.equal(r.err, text + '\n', line);
    assert.equal(r.code, code, line);
  };
  await fail(`scp nofile ${WEB01}:`, 255, 'scp: stat local "nofile": No such file or directory');
  await fail(`scp ${WEB01}:nofile .`, 1, 'scp: nofile: No such file or directory');
  await fail(`scp ${WEB01}:/etc/shadow .`, 1, 'scp: remote open "/etc/shadow": Permission denied');
  await fail(`scp ${WEB01}:/etc/ssh .`, 1, 'scp: download /etc/ssh/: not a regular file');
  await fail(`scp ${WEB01}:/etc/hostname /nodir/x`, 1, 'scp: open local "/nodir/x": No such file or directory');
  await fail(`scp f.txt ${WEB01}:/etc/f.txt`, 1, 'scp: dest open "/etc/f.txt": Permission denied\nscp: failed to upload file f.txt to /etc/f.txt');
  await fail(`scp f.txt ${WEB01}:nodir/f.txt`, 1, 'scp: dest open "/home/student/nodir/f.txt": No such file\nscp: failed to upload file f.txt to nodir/f.txt');
  await fail(`scp /etc ${WEB01}:`, 1, 'scp: local "/etc" is not a regular file\nscp: failed to upload file /etc to .');
  await fail('scp f.txt nohost.halcyon.lab:', 255, 'ssh: Could not resolve hostname nohost.halcyon.lab: Name or service not known\nscp: Connection closed', []);
  await fail(`scp -P 2222 f.txt ${WEB01}:`, 255, 'ssh: connect to host web01.halcyon.lab port 2222: Connection refused\nscp: Connection closed', []);
  await fail(`scp f.txt ${WEB01}:`, 255, 'Permission denied, please try again.\nPermission denied, please try again.\nstudent@web01.halcyon.lab: Permission denied (publickey,password).\nscp: Connection closed', ['a', 'b', 'c']);
  await fail('scp -P http f.txt web01:', 255, 'scp: bad port "http"', []);
  let r = await sim.run('scp f.txt');
  assert.equal(r.code, 1);
  assert.match(r.err, /^usage: scp \[-346ABCOpqRrsTv\] \[-c cipher\] \[-D sftp_server_path\] \[-F ssh_config\]\n/);
  r = await sim.run('scp -Z a b');
  assert.match(r.err, /^unknown option -- Z\nusage: scp /);
  r = await sim.run('scp nofile /tmp/x');
  assert.deepEqual([r.code, r.err], [1, "cp: cannot stat 'nofile': No such file or directory\n"]);
});

test('ssh-copy-id: installs the key, after which ssh and scp need no password', async () => {
  const sim = await boot();
  let r = await sim.run(`ssh-copy-id ${WEB01}`);
  assert.deepEqual([r.code, r.err], [1, '/usr/bin/ssh-copy-id: ERROR: No identities found\n']);
  await sim.run("ssh-keygen -q -N '' -f ~/.ssh/id_ed25519");
  const pub = (await sim.run('cat ~/.ssh/id_ed25519.pub')).out;

  r = await withInput(sim, `ssh-copy-id ${WEB01}`, ['yes', 'student']);
  assert.equal(r.code, 0);
  assert.equal(r.err, '/usr/bin/ssh-copy-id: INFO: Source of key(s) to be installed: "/home/kali/.ssh/id_ed25519.pub"\n' +
    r.err.split('\n').slice(1, 5).join('\n') + '\n' +
    '/usr/bin/ssh-copy-id: INFO: attempting to log in with the new key(s), to filter out any that are already installed\n' +
    '/usr/bin/ssh-copy-id: INFO: 1 key(s) remain to be installed -- if you are prompted now it is to install the new keys\n');
  assert.match(r.err.split('\n')[1], /^The authenticity of host 'web01\.halcyon\.lab \(10\.10\.10\.10\)' can't be established\.$/);
  assert.equal(r.out, '\nNumber of key(s) added: 1\n\nNow try logging into the machine, with: "ssh \'student@web01.halcyon.lab\'"\nand check to make sure that only the key(s) you wanted were added.\n\n');
  assert.match(r.screen, /student@web01\.halcyon\.lab's password: \n$/);
  const web01 = sim.K.net.machines.web01;
  assert.equal(web01.vfs.read('/home/student/.ssh/authorized_keys'), pub);
  assert.equal(web01.vfs.stat('/home/student/.ssh').mode & 0o777, 0o700);
  assert.equal(web01.vfs.stat('/home/student/.ssh/authorized_keys').mode & 0o777, 0o600);

  // the key now opens the door: no password prompt
  r = await withInput(sim, `ssh ${WEB01} whoami`, []);
  assert.deepEqual([r.code, r.out, r.screen], [0, 'student\n', '']);
  assert.match(web01.vfs.read('/var/log/auth.log'), /Accepted publickey for student from 10\.10\.10\.5 port \d+ ssh2: ED25519 SHA256:\S{43}\n/);
  r = await withInput(sim, `scp ${WEB01}:/etc/hostname /tmp/h && cat /tmp/h`, []);
  assert.deepEqual([r.code, r.out, r.screen], [0, 'web01\n', '']);
  r = await sim.run(`ssh -v ${WEB01} true`);
  assert.match(r.err, /debug1: Offering public key: \/home\/kali\/\.ssh\/id_ed25519 ED25519 SHA256:\S+\ndebug1: Server accepts key: \/home\/kali\/\.ssh\/id_ed25519 ED25519 SHA256:\S+\nAuthenticated to web01\.halcyon\.lab \(\[10\.10\.10\.10\]:22\) using "publickey"\.\n/);

  // a second run has nothing to do
  r = await sim.run(`ssh-copy-id ${WEB01}`);
  assert.equal(r.code, 0);
  assert.match(r.err, /filter out any that are already installed\n\n\/usr\/bin\/ssh-copy-id: WARNING: All keys were skipped because they already exist on the remote system\.\n\t\t\(if you think this is a mistake, you may want to use -f option\)\n\n$/);
  assert.equal(web01.vfs.read('/home/student/.ssh/authorized_keys'), pub);

  // a key with a passphrase asks for it instead of the password
  await sim.run("ssh-keygen -q -t rsa -N 'open sesame' -f /tmp/lab_rsa");
  r = await withInput(sim, `ssh-copy-id -n -i /tmp/lab_rsa ${WEB01}`, []);
  assert.match(r.out, /^=-=-=-=-=-=-=-=\nWould have added the following key\(s\):\n\nssh-rsa \S+ kali@kali\n=-=-=-=-=-=-=-=\n$/);
  r = await withInput(sim, `ssh-copy-id -i /tmp/lab_rsa.pub -p 22 ${WEB01}`, []);
  assert.match(r.out, /Now try logging into the machine, with: "ssh -i \/tmp\/lab_rsa -p '22' 'student@web01\.halcyon\.lab'"\n/);
  assert.equal(web01.vfs.read('/home/student/.ssh/authorized_keys').split('\n').length, 3);
  await sim.run('mv ~/.ssh/id_ed25519 /tmp/aside');
  r = await withInput(sim, `ssh -i /tmp/lab_rsa ${WEB01} hostname`, ['open sesame']);
  assert.deepEqual([r.out, r.screen], ['web01\n', "Enter passphrase for key '/tmp/lab_rsa': \n"]);
});

test('ssh-copy-id: failures', async () => {
  const sim = await boot();
  await sim.run("ssh-keygen -q -N '' -f ~/.ssh/id_ed25519");
  const source = '/usr/bin/ssh-copy-id: INFO: Source of key(s) to be installed: "/home/kali/.ssh/id_ed25519.pub"\n';
  let r = await sim.run('ssh-copy-id student@nohost.halcyon.lab');
  assert.deepEqual([r.code, r.err], [1, source + '/usr/bin/ssh-copy-id: ERROR: ssh: Could not resolve hostname nohost.halcyon.lab: Name or service not known\n']);
  r = await sim.run('ssh-copy-id student@printer.halcyon.lab');
  assert.deepEqual([r.code, r.err], [1, source + '/usr/bin/ssh-copy-id: ERROR: ssh: connect to host printer.halcyon.lab port 22: Connection refused\n']);
  r = await sim.run('ssh-copy-id -i /tmp/nokey student@web01.halcyon.lab');
  assert.deepEqual([r.code, r.out], [1, "\n/usr/bin/ssh-copy-id: ERROR: failed to open ID file '/tmp/nokey.pub': No such file\n"]);
  r = await withInput(sim, `ssh-copy-id -o StrictHostKeyChecking=accept-new ${WEB01}`, ['x', 'y', 'z']);
  assert.equal(r.code, 1);
  assert.match(r.err, /student@web01\.halcyon\.lab: Permission denied \(publickey,password\)\.\n$/);
  assert.equal(sim.K.net.machines.web01.vfs.exists('/home/student/.ssh/authorized_keys'), false);
  for (const line of ['ssh-copy-id', 'ssh-copy-id -h', 'ssh-copy-id -Z web01', 'ssh-copy-id a b']) {
    r = await sim.run(line);
    assert.equal(r.code, 1, line);
    assert.match(r.err, /^Usage: \/usr\/bin\/ssh-copy-id \[-h\|-\?\|-f\|-n\|-s\|-x\] \[-i \[identity_file\]\] /, line);
  }
});

const FILES01 = 'files01.halcyon.lab';

test('ftp: anonymous session with the tnftp prompts and vsftpd replies', async () => {
  const sim = await boot();
  const r = await withInput(sim, `ftp ${FILES01}`, ['anonymous', 'kali@lab', 'pwd', 'ls', 'cd pub', 'dir', 'get README.txt', 'get nofile', 'cd /nodir', 'ascii', 'binary', 'bogus', 's', 'bye'], { tty: true });
  assert.equal(r.code, 0);
  assert.equal(r.screen, `Name (${FILES01}:kali): anonymous\nPassword: \n` + ['pwd', 'ls', 'cd pub', 'dir', 'get README.txt', 'get nofile', 'cd /nodir', 'ascii', 'binary', 'bogus', 's', 'bye'].map((c) => 'ftp> ' + c + '\n').join(''));
  const out = r.out.split('\n');
  assert.deepEqual(out.slice(0, 7), [`Connected to ${FILES01}.`, '220 (vsFTPd 3.0.5)', '331 Please specify the password.', '230 Login successful.',
    'Remote system type is UNIX.', 'Using binary mode to transfer files.', 'Remote directory: /']);
  assert.match(out[7], /^229 Entering Extended Passive Mode \(\|\|\|\d+\|\)$/);
  assert.deepEqual(out.slice(8, 12), ['150 Here comes the directory listing.', 'drwxr-xr-x    5 0        0            4096 Nov 02 08:05 pub', '226 Directory send OK.', '250 Directory successfully changed.']);
  const size = sim.K.net.hostById('files01').ftp.files['/pub/README.txt'].length;
  assert.equal(out[14], '-rw-r--r--    1 0        0        ' + String(size).padStart(8) + ' Nov 02 08:05 README.txt');
  assert.equal(out[15], 'drwxr-xr-x    2 0        0            4096 Nov 02 08:05 forms');
  const get = out.indexOf('local: README.txt remote: README.txt');
  assert.equal(get, 19);
  assert.equal(out[get + 2], `150 Opening BINARY mode data connection for README.txt (${size} bytes).`);
  assert.match(out[get + 3], new RegExp(`^\\r100% \\|\\*{35}\\| {3}${size} {6}[ \\d]{3}\\.\\d\\d [KM]iB/s {4}00:00 ETA$`), 'the progress bar at 80 columns');
  assert.equal(out[get + 4], '226 Transfer complete.');
  assert.match(out[get + 5], new RegExp(`^${size} bytes received in 00:00 \\(\\d+\\.\\d\\d [KM]iB/s\\)$`));
  assert.deepEqual(out.slice(get + 6, get + 9).filter((l) => !/^229/.test(l)), ['local: nofile remote: nofile', '550 Failed to open file.']);
  assert.deepEqual(out.slice(get + 9), ['550 Failed to change directory.', '200 Switching to ASCII mode.', '200 Switching to Binary mode.', '?Invalid command.', '?Ambiguous command.', '221 Goodbye.', '']);
  assert.equal((await sim.run('cat README.txt')).out, sim.K.net.hostById('files01').ftp.files['/pub/README.txt']);
});

test('ftp: logins, local accounts and client commands', async () => {
  const sim = await boot();
  // a wrong password, then the user command; a local account sees the real files of the server
  let r = await withInput(sim, `ftp ${FILES01}`, ['student', 'wrong', 'ls', 'user student', 'student', 'pwd', 'cd /root', 'get /etc/shadow', 'get /etc/hostname /tmp/h', 'mkdir x', 'close', 'pwd', 'quit'], { tty: true });
  assert.match(r.out, /331 Please specify the password\.\n530 Login incorrect\.\n530 Please login with USER and PASS\.\n331 Please specify the password\.\n230 Login successful\.\n/);
  assert.match(r.err, /^ftp: Login failed\n$/);
  assert.match(r.out, /Remote directory: \/home\/student\n550 Failed to change directory\.\nlocal: shadow remote: \/etc\/shadow\n229 .*\n550 Failed to open file\.\n/);
  assert.match(r.out, /550 Permission denied\.\n221 Goodbye\.\nNot connected\.\n$/, 'the server is read-only');
  assert.equal((await sim.run('cat /tmp/h')).out, 'files01\n');
  const log = sim.K.net.machines.files01.vfs.read('/var/log/vsftpd.log');
  assert.match(log, /\[pid 1\] \[student\] FAIL LOGIN: Client "10\.10\.10\.5"\n.*\[pid 1\] \[student\] OK LOGIN: Client "10\.10\.10\.5"\n.*\[pid 3\] \[student\] OK DOWNLOAD: Client "10\.10\.10\.5", "\/etc\/hostname", 8 bytes, [\d.]+Kbyte\/sec\n$/);

  // -a logs in as anonymous; without a terminal on stdout only data and errors are shown
  r = await sim.run(`printf 'ls pub/forms\\nnlist pub\\ncd nodir\\nget pub/README.txt /tmp/readme\\nbye\\n' | ftp -a ${FILES01}`);
  assert.equal(r.code, 0);
  assert.match(r.out, /^(-rw-r--r-- {4}1 0 {8}0 +\d+ Nov 02 08:05 \S+\.txt\n){2}pub\/README\.txt\npub\/forms\npub\/rates\npub\/schedules\n550 Failed to change directory\.\n$/);
  assert.equal((await sim.run('cmp /tmp/readme README.txt 2>&1; wc -l < /tmp/readme')).code, 0);

  // -n: no automatic login; open and status from the prompt
  r = await withInput(sim, 'ftp -n', ['status', 'ls', `open ${FILES01}`, 'user anonymous x', 'passive', 'ls', 'status', 'lcd /tmp', 'lpwd', 'help get', 'exit'], { tty: true });
  assert.match(r.out, /^Not connected\.\nNo proxy connection\.\n[\s\S]*Version: tnftp \d+\nNot connected\.\nConnected to files01\.halcyon\.lab\.\n220 \(vsFTPd 3\.0\.5\)\n331 /);
  assert.match(r.out, /Passive mode: off; fallback to active mode: off\.\n200 EPRT command successful\. Consider using EPSV\.\n150 Here comes the directory listing\.\n/);
  assert.match(r.out, /Connected and logged into files01\.halcyon\.lab\.\n/);
  assert.match(r.out, /Local directory now: \/tmp\nLocal directory: \/tmp\nget {8}\treceive file\n221 Goodbye\.\n$/);
  r = await withInput(sim, 'ftp', ['help', 'quit'], { tty: true });
  assert.match(r.out, /^Commands may be abbreviated\. {2}Commands are:\n\n!\t\tepsv6\t\tmget\t\tpreserve\tsend\n\$\t\texit\t\tmkdir\t\tprogress\tsendport\n/);
});

test('ftp: connection failures leave the prompt, bad options print the usage', async () => {
  const sim = await boot();
  let r = await withInput(sim, 'ftp printer.halcyon.lab', ['ls', 'quit']);
  assert.equal(r.err, "ftp: Can't connect to `10.10.10.60:21': Connection refused\nftp: Can't connect to `printer.halcyon.lab:ftp'\n");
  assert.equal(r.out, 'Not connected.\n');
  assert.equal(r.screen, 'ftp> ls\nftp> quit\n');
  assert.equal(r.code, 0);
  r = await sim.run('ftp nohost.halcyon.lab < /dev/null');
  assert.equal(r.err, "ftp: Can't lookup `nohost.halcyon.lab:ftp': Name or service not known\n");
  r = await sim.run('ftp -Z');
  assert.equal(r.code, 1);
  assert.match(r.err, /^ftp: invalid option -- 'Z'\nusage: ftp \[-46AadefginpRtVv\] \[-N netrc\] \[-o outfile\] \[-P port\] \[-q quittime\]\n/);
  assert.match(sim.K.cmd.get('ftp').man, /^DESCRIPTION\n[\s\S]*\nOPTIONS\n[\s\S]*\nEXAMPLES\n {7}ftp files01\.halcyon\.lab\n/);
});

/** Open a raw session and return a function that sends one line and returns the reply. */
function raw(sim, ip, port) {
  const s = sim.K.net.connect(sim.machine, ip, port);
  return Object.assign((line) => s.send(line + '\r\n'), { session: s });
}

test('ftp protocol handler: the vsftpd state machine', async () => {
  const sim = await boot();
  const ftp = raw(sim, '10.10.10.20', 21);
  assert.equal(ftp.session.greeting, '220 (vsFTPd 3.0.5)\r\n');
  assert.equal(ftp('PWD'), '530 Please login with USER and PASS.\r\n');
  assert.equal(ftp('PASS x'), '503 Login with USER first.\r\n');
  assert.equal(ftp('FEAT'), '211-Features:\r\n EPRT\r\n EPSV\r\n MDTM\r\n PASV\r\n REST STREAM\r\n SIZE\r\n TVFS\r\n UTF8\r\n211 End\r\n');
  assert.equal(ftp('user anonymous'), '331 Please specify the password.\r\n', 'commands are case-insensitive');
  assert.equal(ftp('PASS guest@'), '230 Login successful.\r\n');
  assert.equal(ftp('USER student'), "530 Can't change to another user.\r\n");
  assert.equal(ftp('SYST'), '215 UNIX Type: L8\r\n');
  assert.equal(ftp('PWD'), '257 "/" is the current directory\r\n');
  assert.equal(ftp('CWD pub/forms'), '250 Directory successfully changed.\r\n');
  assert.equal(ftp('CDUP'), '250 Directory successfully changed.\r\n');
  assert.equal(ftp('PWD'), '257 "/pub" is the current directory\r\n');
  assert.equal(ftp('CWD README.txt'), '550 Failed to change directory.\r\n');
  assert.equal(ftp('TYPE I'), '200 Switching to Binary mode.\r\n');
  assert.equal(ftp('TYPE A'), '200 Switching to ASCII mode.\r\n');
  assert.equal(ftp('TYPE Q'), '500 Unrecognised TYPE command.\r\n');
  assert.match(ftp('SIZE README.txt'), /^213 \d+\r\n$/);
  assert.equal(ftp('SIZE forms'), '550 Could not get file size.\r\n');
  assert.equal(ftp('NOOP'), '200 NOOP ok.\r\n');
  assert.match(ftp('HELP'), /^214-The following commands are recognized\.\r\n ABOR ACCT ALLO APPE CDUP CWD {2}DELE EPRT EPSV FEAT HELP LIST MDTM MKD\r\n[\s\S]*\r\n214 Help OK\.\r\n$/);
  assert.equal(ftp('STOR x'), '550 Permission denied.\r\n');
  assert.equal(ftp('XYZZY'), '500 Unknown command.\r\n');

  // a transfer needs PASV first, and a data connection that a typed session never makes
  assert.equal(ftp('LIST'), '425 Use PORT or PASV first.\r\n');
  assert.match(ftp('PASV'), /^227 Entering Passive Mode \(10,10,10,20,\d+,\d+\)\.\r\n$/);
  assert.equal(ftp('LIST'), '425 Failed to establish connection.\r\n');
  ftp('PASV');
  ftp.session.state.data = ''; // what the ftp client does once it has connected to the passive port
  assert.equal(ftp('RETR README.txt'), `150 Opening BINARY mode data connection for README.txt (${ftp.session.state.data.length} bytes).\r\n226 Transfer complete.\r\n`);
  assert.equal(ftp.session.state.data, sim.K.net.hostById('files01').ftp.files['/pub/README.txt']);
  assert.equal(ftp('RETR nofile'), '550 Failed to open file.\r\n');
  assert.equal(ftp('NOOP\r\nPWD'), '200 NOOP ok.\r\n257 "/pub" is the current directory\r\n', 'several lines in one write');
  assert.equal(ftp('QUIT'), '221 Goodbye.\r\n');
  assert.equal(ftp.session.open, false);
});

test('ftp protocol handler: policy from host.ftp, and a default tree without it', async () => {
  const sim = await boot();
  const host = sim.K.net.hostById('files01');
  host.ftp = { anonymous: false, users: { carol: 'depot-pass' }, files: { '/drop/readme.txt': 'for carol\n' } };
  let ftp = raw(sim, '10.10.10.20', 21);
  assert.equal(ftp('USER anonymous'), '331 Please specify the password.\r\n');
  assert.equal(ftp('PASS x'), '530 Login incorrect.\r\n');
  assert.equal(ftp('USER carol'), '331 Please specify the password.\r\n');
  assert.equal(ftp('PASS nope'), '530 Login incorrect.\r\n');
  assert.equal(ftp('USER carol'), '331 Please specify the password.\r\n');
  assert.equal(ftp('PASS depot-pass'), '230 Login successful.\r\n');
  assert.equal(ftp('SIZE /drop/readme.txt'), '213 10\r\n');
  ftp = raw(sim, '10.10.10.20', 21);
  for (let i = 0; i < 3; i++) { ftp('USER carol'); assert.equal(ftp('PASS wrong' + i), '530 Login incorrect.\r\n'); }
  assert.equal(ftp.session.open, false, 'three failed logins end the session');

  delete host.ftp;
  ftp = raw(sim, '10.10.10.20', 21);
  assert.equal(ftp('USER carol'), '530 This FTP server is anonymous only.\r\n');
  ftp('USER ftp');
  assert.equal(ftp('PASS x'), '230 Login successful.\r\n');
  ftp('EPSV');
  ftp.session.state.data = '';
  ftp('NLST');
  assert.equal(ftp.session.state.data, 'README\r\npub\r\n');
  // the client and a typed session meet the same handler
  const r = await sim.run(`printf 'ls\\nbye\\n' | ftp -a ${FILES01}`);
  assert.match(r.out, /^-rw-r--r-- {4}1 0 {8}0 +\d+ \w{3} \d\d \d\d:\d\d README\ndrwxr-xr-x {4}2 0 {8}0 {12}4096 \w{3} \d\d \d\d:\d\d pub\n$/);
  const typed = await withInput(sim, `nc ${FILES01} 21`, ['USER anonymous', 'PASS x', 'PWD', 'QUIT']);
  assert.equal(typed.out, '220 (vsFTPd 3.0.5)\r\n331 Please specify the password.\r\n230 Login successful.\r\n257 "/" is the current directory\r\n221 Goodbye.\r\n');
});

test('smtp protocol handler: Postfix replies, nothing is delivered', async () => {
  const sim = await boot();
  const smtp = raw(sim, '10.10.10.40', 25);
  assert.equal(smtp.session.greeting, '220 mail01.halcyon.lab ESMTP Postfix (Debian/GNU)\r\n');
  assert.equal(smtp('HELO'), '501 Syntax: HELO hostname\r\n');
  assert.equal(smtp('HELO kali'), '250 mail01.halcyon.lab\r\n');
  assert.equal(smtp('EHLO kali'), '250-mail01.halcyon.lab\r\n250-PIPELINING\r\n250-SIZE 10240000\r\n250-ETRN\r\n250-STARTTLS\r\n250-ENHANCEDSTATUSCODES\r\n250-8BITMIME\r\n250-DSN\r\n250-SMTPUTF8\r\n250 CHUNKING\r\n');
  assert.equal(smtp('VRFY root'), '502 5.5.1 VRFY command is disabled\r\n');
  assert.equal(smtp('HELP'), '502 5.5.2 Error: command not recognized\r\n');
  assert.equal(smtp('RCPT TO:<ops@halcyon.lab>'), '503 5.5.1 Error: need MAIL command\r\n');
  assert.equal(smtp('MAIL kali'), '501 5.5.4 Syntax: MAIL FROM:<address>\r\n');
  assert.equal(smtp('mail from:<kali@kali>'), '250 2.1.0 Ok\r\n');
  assert.equal(smtp('MAIL FROM:<kali@kali>'), '503 5.5.1 Error: nested MAIL command\r\n');
  assert.equal(smtp('DATA'), '554 5.5.1 Error: no valid recipients\r\n');
  assert.equal(smtp('RCPT TO:<someone@example.com>'), '454 4.7.1 <someone@example.com>: Relay access denied\r\n');
  assert.equal(smtp('RCPT TO:<ops@halcyon.lab>'), '250 2.1.5 Ok\r\n');
  assert.equal(smtp('DATA'), '354 End data with <CR><LF>.<CR><LF>\r\n');
  assert.equal(smtp('Subject: test'), '');
  assert.equal(smtp('QUIT'), '', 'inside DATA a command is just text');
  assert.match(smtp('.'), /^250 2\.0\.0 Ok: queued as [0-9A-F]{11}\r\n$/);
  assert.equal(smtp('RSET'), '250 2.0.0 Ok\r\n');
  assert.equal(smtp('NOOP'), '250 2.0.0 Ok\r\n');
  assert.equal(smtp('DATA'), '503 5.5.1 Error: need RCPT command\r\n');
  assert.equal(smtp('QUIT'), '221 2.0.0 Bye\r\n');
  assert.equal(smtp.session.open, false);

  // typed by hand, piped through nc, and on the submission port
  let r = await withInput(sim, 'telnet mail01.halcyon.lab 25', ['HELO kali', 'QUIT']);
  assert.equal(r.out, "Trying 10.10.10.40...\nConnected to mail01.halcyon.lab.\nEscape character is '^]'.\n220 mail01.halcyon.lab ESMTP Postfix (Debian/GNU)\r\n250 mail01.halcyon.lab\r\n221 2.0.0 Bye\r\n");
  const t0 = sim.K.clock.now();
  r = await sim.run("printf 'EHLO kali\\r\\nQUIT\\r\\n' | nc -C mail.halcyon.lab 587 | tail -1");
  assert.equal(r.out, '221 2.0.0 Bye\r\n');
  assert.equal(sim.K.clock.now() - t0 < 1000, true, 'the server hangs up after QUIT, so nc returns');
  const web = raw(sim, '10.10.10.40', 25);
  assert.equal(web('GET / HTTP/1.1'), '221 2.7.0 Error: I can break rules, too. Goodbye.\r\n');
  assert.equal(web.session.open, false);
});

test('pop3 protocol handler: Dovecot replies, logins always fail', async () => {
  const sim = await boot();
  const pop = raw(sim, '10.10.10.40', 110);
  assert.equal(pop.session.greeting, '+OK Dovecot (Debian) ready.\r\n');
  assert.equal(pop('CAPA'), '+OK\r\nCAPA\r\nTOP\r\nUIDL\r\nRESP-CODES\r\nPIPELINING\r\nAUTH-RESP-CODE\r\nSTLS\r\nUSER\r\nSASL PLAIN\r\n.\r\n');
  assert.equal(pop('PASS secret'), '-ERR No username given.\r\n');
  assert.equal(pop('USER'), '-ERR No username given.\r\n');
  assert.equal(pop('USER ops'), '+OK\r\n');
  assert.equal(pop('PASS anything'), '-ERR [AUTH] Authentication failed.\r\n');
  assert.equal(pop('user ops'), '+OK\r\n');
  assert.equal(pop('pass ops'), '-ERR [AUTH] Authentication failed.\r\n');
  assert.equal(pop('STAT'), '-ERR Unknown command.\r\n');
  assert.equal(pop('QUIT'), '+OK Logging out\r\n');
  assert.equal(pop.session.open, false);
  const r = await withInput(sim, 'nc -v mail01.halcyon.lab 110', ['USER ops', 'PASS x', 'QUIT']);
  assert.equal(r.err, 'mail01.halcyon.lab [10.10.10.40] 110 (pop3) open\n');
  assert.equal(r.out, '+OK Dovecot (Debian) ready.\r\n+OK\r\n-ERR [AUTH] Authentication failed.\r\n+OK Logging out\r\n');
});

test('completion offers lab hosts where a host belongs', async () => {
  const sim = await boot();
  const items = (line) => sim.shell.complete(line).items.map((i) => i.display);
  assert.deepEqual(items('ssh student@we'), ['student@web01.halcyon.lab']);
  assert.deepEqual(items('nc -v fi'), ['files01.halcyon.lab']);
  assert.deepEqual(items('telnet ma'), ['mail01.halcyon.lab']);
  assert.deepEqual(items('ftp files'), ['files01.halcyon.lab']);
  assert.deepEqual(items('scp notes.txt student@db'), ['student@db01.halcyon.lab:']);
  await sim.run('mkdir -p ~/.ssh && touch ~/.ssh/web_key notes.txt');
  assert.deepEqual(items('ssh -i ~/.ssh/we'), ['web_key'], 'an identity file is a path');
  assert.deepEqual(items('scp no'), ['notes.txt']);
});
