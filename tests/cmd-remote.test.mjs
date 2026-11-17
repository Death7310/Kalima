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
