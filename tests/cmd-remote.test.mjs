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
