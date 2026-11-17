// System pack: machine initialisation, logging, identity, system information,
// processes, services, logs and manual pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

/** Boot a simulator with sudo already authenticated, plus shorthands for stdout and stderr. */
async function sys(opts) {
  const sim = await boot(opts);
  sim.out = async (line, o) => (await sim.run(line, o)).out;
  sim.err = async (line, o) => (await sim.run(line, o)).err;
  sim.machine.sudoStamp.kali = sim.K.clock.now();
  return sim;
}

/* ------------------------------------------------------ machine initialisation */

test('boot: Kali process table has the desktop session and the shell under qterminal', async () => {
  const { machine, shell } = await sys();
  const byCmd = (re) => machine.procs.find((p) => re.test(p.cmd));
  assert.equal(machine.procs[0].pid, 1);
  assert.equal(machine.procs[0].cmd, '/sbin/init splash');
  assert.equal(byCmd(/^\[kthreadd\]$/).pid, 2);
  for (const re of [/systemd-journald$/, /systemd-udevd$/, /dbus-daemon --system/, /NetworkManager --no-daemon/, /polkitd/, /cron -f/, /lightdm$/, /Xorg :0/, /^xfce4-session$/, /qterminal$/]) {
    assert.ok(byCmd(re), 'missing process ' + re);
  }
  assert.equal(byCmd(/Xorg/).tty, 'tty7');
  assert.equal(byCmd(/^xfce4-session$/).user, 'kali');
  assert.equal(shell.proc.ppid, byCmd(/qterminal$/).pid, 'the login shell is a child of the terminal emulator');
  const pids = machine.procs.map((p) => p.pid);
  assert.equal(new Set(pids).size, pids.length, 'PIDs are unique');
  assert.ok(pids.slice(0, -1).every((p) => p < shell.pid), 'boot processes have lower PIDs than the shell');
});

test('boot: Kali units follow the documented shape', async () => {
  const { K, machine } = await sys();
  const ssh = K.sys.unit(machine, 'ssh');
  assert.equal(ssh.name, 'ssh.service');
  assert.equal(K.sys.unit(machine, 'sshd.service'), ssh, 'sshd is an alias of ssh.service');
  assert.deepEqual([ssh.active, ssh.sub, ssh.enabled, ssh.pid], ['inactive', 'dead', false, null]);
  assert.deepEqual(ssh.ports, [{ port: 22, proto: 'tcp', addr: '0.0.0.0', name: 'ssh', product: 'OpenSSH', version: '10.0p2 Debian 7', banner: 'SSH-2.0-OpenSSH_10.0p2 Debian-7', handler: 'ssh' }]);
  const apache = K.sys.unit(machine, 'apache2');
  assert.equal(apache.active, 'inactive');
  assert.equal(apache.ports[0].port, 80);
  assert.equal(typeof apache.ports[0].http, 'function');
  const pg = K.sys.unit(machine, 'postgresql.service');
  assert.deepEqual([pg.active, pg.ports[0].addr, pg.ports[0].port], ['inactive', '127.0.0.1', 5432]);
  for (const name of ['NetworkManager', 'cron', 'dbus', 'systemd-journald', 'lightdm', 'rsyslog']) {
    const u = K.sys.unit(machine, name);
    assert.deepEqual([u.active, u.sub], ['active', 'running'], name);
    assert.ok(machine.procs.some((p) => p.pid === u.pid && p.unit === u.name), name + ' has a main process');
    assert.ok(u.since >= K.getBootTime() && u.since < K.clock.now());
  }
  assert.equal(K.sys.unit(machine, 'dbus').enabled, 'static');
  assert.equal(K.sys.unit(machine, 'cron').enabled, true);
  assert.equal(K.sys.unit(machine, 'nosuch'), null);
});

test('boot: starting ssh.service opens TCP 22, stopping closes it', async () => {
  const { K, machine } = await sys();
  assert.equal(K.net.tcp(machine, '10.10.10.5', 22).state, 'closed');
  const r = K.sys.startUnit(machine, 'ssh');
  assert.equal(r.ok, true);
  const ssh = K.sys.unit(machine, 'ssh');
  assert.deepEqual([ssh.active, ssh.sub, ssh.since], ['active', 'running', K.clock.now()]);
  assert.equal(machine.procs.find((p) => p.pid === ssh.pid).cmd, 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups');
  assert.equal(K.net.tcp(machine, '10.10.10.5', 22).state, 'open');
  assert.ok(K.net.listening(machine).some((l) => l.port === 22 && l.pid === ssh.pid && l.prog === 'sshd'));
  K.sys.stopUnit(machine, 'ssh');
  assert.equal(K.net.tcp(machine, '10.10.10.5', 22).state, 'closed');
  assert.equal(machine.procs.some((p) => p.unit === 'ssh.service'), false);
});

test('boot: apache2 serves /var/www/html from the filesystem', async () => {
  const { K, machine } = await sys();
  assert.match(machine.vfs.read('/var/www/html/index.html'), /<title>Apache2 Debian Default Page: It works<\/title>/);
  assert.throws(() => K.net.http(machine, { url: 'http://127.0.0.1/' }), (e) => e.code === 'ECONNREFUSED');
  K.sys.startUnit(machine, 'apache2');
  const home = K.net.http(machine, { url: 'http://10.10.10.5/' });
  assert.equal(home.status, 200);
  assert.equal(home.headers.server, 'Apache/2.4.65 (Debian)');
  assert.equal(home.headers['content-type'], 'text/html');
  assert.equal(home.body, machine.vfs.read('/var/www/html/index.html'));

  machine.vfs.seed('/var/www/html/notes/todo.txt', 'buy milk\n');
  machine.vfs.seed('/var/www/html/secret.txt', 'x', { mode: 0o600 });
  assert.equal(K.net.http(machine, { url: 'http://localhost/notes/todo.txt' }).body, 'buy milk\n');
  const moved = K.net.http(machine, { url: 'http://10.10.10.5/notes' });
  assert.deepEqual([moved.status, moved.headers.location], [301, 'http://10.10.10.5/notes/']);
  const listing = K.net.http(machine, { url: 'http://10.10.10.5/notes/' });
  assert.match(listing.body, /<h1>Index of \/notes<\/h1>/);
  assert.match(listing.body, /<a href="todo.txt">todo.txt<\/a>/);
  assert.equal(K.net.http(machine, { url: 'http://10.10.10.5/secret.txt' }).status, 403);

  const missing = K.net.http(machine, { url: 'http://10.10.10.5/nope', headers: { 'User-Agent': 'curl/8.15.0' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body, '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>404 Not Found</title>\n</head><body>\n<h1>Not Found</h1>\n' +
    '<p>The requested URL was not found on this server.</p>\n<hr>\n<address>Apache/2.4.65 (Debian) Server at 10.10.10.5 Port 80</address>\n</body></html>\n');
  const access = machine.vfs.read('/var/log/apache2/access.log').trimEnd().split('\n');
  assert.equal(access.at(-1), '10.10.10.5 - - [13/Nov/2026:14:30:00 +0000] "GET /nope HTTP/1.1" 404 ' + missing.body.length + ' "-" "curl/8.15.0"');
  assert.equal(K.net.http(machine, { url: 'http://10.10.10.5/../etc/passwd' }).status, 400);
});

test('boot: a second web server cannot bind port 80 and the unit fails', async () => {
  const { K, machine } = await sys();
  K.sys.startUnit(machine, 'apache2');
  const r = K.sys.startUnit(machine, 'nginx');
  assert.deepEqual([r.ok, r.reason], [false, 'failed']);
  assert.deepEqual([r.unit.active, r.unit.sub], ['failed', 'failed']);
  assert.match(machine.state.journal.at(-1).msg, /^Failed to start nginx\.service/);
});

test('boot: lab servers run the daemons behind their services', async () => {
  const { K } = await sys();
  const web = K.net.machineFor('web01');
  assert.equal(web.procs[0].cmd, '/sbin/init');
  const nginx = K.sys.unit(web, 'nginx');
  assert.deepEqual([nginx.active, nginx.sub, nginx.enabled], ['active', 'running', true]);
  assert.deepEqual(nginx.ports.map((p) => p.port), [80, 443]);
  assert.equal(web.procs.filter((p) => /^nginx: worker process$/.test(p.cmd) && p.user === 'www-data' && p.ppid === nginx.pid).length, 2);
  assert.equal(K.sys.unit(web, 'ssh').active, 'active');
  assert.equal(K.sys.unit(web, 'lightdm'), null, 'servers have no desktop');
  assert.ok(K.net.listening(web).some((l) => l.port === 22 && l.prog === 'sshd'));

  const files = K.net.machineFor('files01');
  for (const name of ['vsftpd', 'smbd', 'nmbd', 'rpcbind', 'nfs-mountd']) assert.equal(K.sys.unit(files, name).sub, 'running', name);
  assert.equal(K.sys.unit(files, 'nfs-server').sub, 'exited');
  assert.ok(files.procs.some((p) => p.cmd === '/usr/sbin/vsftpd /etc/vsftpd.conf'));
  const db = K.net.machineFor('db01');
  assert.ok(db.procs.some((p) => p.cmd === '/usr/sbin/mariadbd' && p.user === 'mysql'));
});

/* -------------------------------------------------------------------- logging */

test('logs: seeded files hold the boot history in syslog format', async () => {
  const sim = await sys();
  const { K, machine } = sim;
  const syslog = machine.vfs.read('/var/log/syslog').split('\n');
  assert.match(syslog[0], /^Nov 13 11:12:18 kali kernel: \[ {4}0\.000000\] Linux version 7\.1\.5-kali1-amd64 /);
  assert.ok(syslog.includes('Nov 13 11:12:22 kali systemd[1]: Started cron.service - Regular background program processing daemon.'));
  assert.ok(syslog.some((l) => /CRON\[\d+\]: \(root\) CMD \( {3}cd \/ && run-parts --report \/etc\/cron\.hourly\)$/.test(l)));
  const stamps = syslog.filter(Boolean).map((l) => l.slice(0, 15));
  assert.deepEqual(stamps, stamps.slice().sort(), 'entries are in time order');
  const kern = machine.vfs.read('/var/log/kern.log');
  assert.ok(kern.split('\n').filter(Boolean).every((l) => / kali kernel: \[ *\d+\.\d{6}\] /.test(l)));
  assert.match(machine.vfs.read('/var/log/auth.log'), /lightdm\[\d+\]: pam_unix\(lightdm:session\): session opened for user kali\(uid=1000\) by \(uid=0\)/);
  assert.match(machine.vfs.read('/var/log/boot.log'), /\[\x1b\[0;32m {2}OK {2}\x1b\[0m\] Started \x1b\[0;1;39mcron\.service\x1b\[0m - Regular background program processing daemon\./);
  const st = machine.vfs.stat('/var/log/auth.log');
  assert.deepEqual([st.mode & 0o777, st.uid, st.gid], [0o640, 0, 4], 'root:adm 0640');
  assert.equal(machine.state.journal.length, K.util.lines(machine.vfs.read('/var/log/syslog')).length + K.util.lines(machine.vfs.read('/var/log/auth.log')).length);
});

test('logs: K.syslog appends to the journal and the matching file', async () => {
  const { K, machine } = await sys();
  const before = machine.state.journal.length;
  K.syslog(machine, { ident: 'sshd', pid: 4242, msg: 'Failed password for invalid user admin from 10.10.10.70 port 51514 ssh2', facility: 'auth', prio: 'info' });
  K.syslog(machine, { ident: 'myapp', msg: 'hello', facility: 'user', severity: 'warning' });
  K.syslog(machine, { ident: 'kernel', msg: 'device eth0 entered promiscuous mode', facility: 'kern' });
  assert.equal(machine.state.journal.length, before + 3);
  const [auth, user, kern] = machine.state.journal.slice(-3);
  assert.deepEqual([auth.ident, auth.pid, auth.facility, auth.prio, auth.unit, auth.ts], ['sshd', 4242, 'auth', 6, 'ssh.service', K.clock.now()]);
  assert.deepEqual([user.prio, user.pid, user.unit], [4, null, null]);
  assert.equal(machine.vfs.read('/var/log/auth.log').trimEnd().split('\n').at(-1), 'Nov 13 14:30:00 kali sshd[4242]: Failed password for invalid user admin from 10.10.10.70 port 51514 ssh2');
  const syslog = machine.vfs.read('/var/log/syslog').trimEnd().split('\n');
  assert.equal(syslog.at(-2), 'Nov 13 14:30:00 kali myapp: hello');
  assert.equal(syslog.at(-1), 'Nov 13 14:30:00 kali kernel: [11862.000000] device eth0 entered promiscuous mode');
  assert.equal(machine.vfs.read('/var/log/kern.log').trimEnd().split('\n').at(-1), syslog.at(-1));
  assert.doesNotMatch(machine.vfs.read('/var/log/syslog'), /Failed password/, 'auth messages stay out of syslog');
  assert.equal(kern.unit, null);
  // a removed log directory must not break logging
  machine.vfs.rmTree('/var/log');
  K.syslog(machine, { ident: 'x', msg: 'still fine' });
  assert.equal(machine.state.journal.at(-1).msg, 'still fine');
});

test('logs: sudo use is recorded in auth.log', async () => {
  const sim = await sys();
  const tail = (n) => sim.machine.vfs.read('/var/log/auth.log').trimEnd().split('\n').slice(-n);
  await sim.type('cd /tmp && sudo whoami');
  assert.deepEqual(tail(3), [
    'Nov 13 14:30:00 kali sudo:     kali : TTY=pts/0 ; PWD=/tmp ; USER=root ; COMMAND=/usr/bin/whoami',
    'Nov 13 14:30:00 kali sudo: pam_unix(sudo:session): session opened for user root(uid=0) by kali(uid=1000)',
    'Nov 13 14:30:00 kali sudo: pam_unix(sudo:session): session closed for user root',
  ]);
  assert.equal(sim.machine.state.journal.at(-1).ident, 'sudo');
  assert.ok(sim.machine.state.journal.at(-1).pid > 0, 'the journal knows the PID even though the file omits it');

  delete sim.machine.sudoStamp.kali;
  sim.term.feed('wrong', 'wrong', 'wrong');
  const lines = sim.machine.state.journal.length;
  await sim.type('sudo -u www-data id');
  assert.equal(sim.machine.state.journal.length, lines + 1);
  assert.equal(tail(1)[0], 'Nov 13 14:30:00 kali sudo:     kali : 3 incorrect password attempts ; TTY=pts/0 ; PWD=/tmp ; USER=www-data ; COMMAND=/usr/bin/id');
});

/* ------------------------------------------------------------------- identity */

test('whoami, id, groups', async () => {
  const sim = await sys();
  const kaliGroups = 'kali adm dialout cdrom floppy sudo audio dip video plugdev users netdev wireshark kaboxer';
  assert.equal(await sim.out('whoami'), 'kali\n');
  assert.equal(await sim.out('sudo whoami'), 'root\n');
  assert.equal(await sim.out('id'), 'uid=1000(kali) gid=1000(kali) groups=1000(kali),4(adm),20(dialout),24(cdrom),25(floppy),27(sudo),29(audio),30(dip),44(video),46(plugdev),100(users),106(netdev),117(wireshark),120(kaboxer)\n');
  assert.equal(await sim.out('sudo id'), 'uid=0(root) gid=0(root) groups=0(root)\n');
  assert.equal(await sim.out('id -u; id -g; id -un; id -gn; id -ru'), '1000\n1000\nkali\nkali\n1000\n');
  assert.equal(await sim.out('id -G'), '1000 4 20 24 25 27 29 30 44 46 100 106 117 120\n');
  assert.equal(await sim.out('id -Gn'), kaliGroups + '\n');
  assert.equal(await sim.out('id root www-data'), 'uid=0(root) gid=0(root) groups=0(root)\nuid=33(www-data) gid=33(www-data) groups=33(www-data)\n');
  assert.equal(await sim.out('id -u nobody'), '65534\n');
  assert.equal(await sim.out('id -Gz | tr "\\0" :'), '1000:4:20:24:25:27:29:30:44:46:100:106:117:120:');
  assert.equal(await sim.out('groups'), kaliGroups + '\n');
  assert.equal(await sim.out('groups root kali'), 'root : root\nkali : ' + kaliGroups + '\n');
  assert.equal(await sim.out('echo "I am $(whoami) in $(id -gn)"'), 'I am kali in kali\n');
});

test('whoami, id, groups: errors', async () => {
  const sim = await sys();
  const fails = async (line, err, code = 1) => { const r = await sim.run(line); assert.equal(r.err, err, line); assert.equal(r.code, code, line); };
  await fails('whoami extra', "whoami: extra operand 'extra'\nTry 'whoami --help' for more information.\n");
  await fails('whoami -x', "whoami: invalid option -- 'x'\nTry 'whoami --help' for more information.\n");
  await fails('id nosuch', "id: 'nosuch': no such user\n");
  await fails('id -ug', 'id: cannot print "only" of more than one choice\n');
  await fails('id -n', 'id: cannot print only names or real IDs in default format\n');
  await fails('id -z', 'id: option --zero not permitted in default format\n');
  await fails('id --bogus', "id: unrecognized option '--bogus'\nTry 'id --help' for more information.\n");
  await fails('groups nosuch', "groups: 'nosuch': no such user\n");
  const mixed = await sim.run('id root nosuch');
  assert.deepEqual([mixed.out, mixed.code], ['uid=0(root) gid=0(root) groups=0(root)\n', 1]);
  assert.match(await sim.out('whoami --version'), /^whoami \(GNU coreutils\) 9\.7\n/);
  assert.match(await sim.out('id --help'), /^Usage: id \[OPTION\]\.\.\. \[USER\]\.\.\.\n/);
  assert.match(await sim.out('groups --help'), /^Usage: groups \[OPTION\]\.\.\. \[USERNAME\]\.\.\.\n/);
});
