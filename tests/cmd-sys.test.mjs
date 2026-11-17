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

/**
 * Run a line on the real clock and press Ctrl-C after a moment, as the kernel
 * tests do. Leaves the simulator on the real clock, so use it last in a test.
 */
async function interrupted(sim, line, afterMs = 20) {
  const { K, shell, term } = sim;
  K.clock.useReal(); K.settings.timeScale = 1;
  term.take();
  const pending = shell.runLine(line);
  setTimeout(() => term.raiseInterrupt(), afterMs);
  const code = await pending;
  return { code, output: K.util.stripAnsi(term.take()) };
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

/* --------------------------------------------------------- system information */

test('hostname: display forms and setting', async () => {
  const sim = await sys();
  assert.equal(await sim.out('hostname'), 'kali\n');
  assert.equal(await sim.out('hostname -I'), '10.10.10.5 \n');
  assert.equal(await sim.out('hostname -i'), '127.0.1.1\n');
  assert.equal(await sim.out('hostname -f; hostname -s; hostname --fqdn'), 'kali\nkali\nkali\n');
  assert.equal(await sim.out('hostname -d'), '', 'no DNS domain: nothing is printed');
  assert.equal(await sim.out('hostname -s -I'), '10.10.10.5 \n', 'the last display option wins');
  const denied = await sim.run('hostname pentest');
  assert.deepEqual([denied.err, denied.code], ['hostname: you must be root to change the host name\n', 1]);
  assert.equal(await sim.out('sudo hostname pentest; hostname; cat /etc/hostname; uname -n'), 'pentest\npentest\npentest\n');
  const bad = await sim.run('hostname -x');
  assert.equal(bad.code, 255);
  assert.match(bad.err, /^hostname: invalid option -- 'x'\nUsage: hostname \[-b\] \{hostname\|-F file\}/);
  assert.equal(await sim.out('hostname -V'), 'hostname 3.25\n');
  assert.equal((await sim.run('hostname -y')).err, 'hostname: Local domain name not set\n');
  await sim.run('echo "# comment\nfromfile" > /tmp/hn; sudo hostname -F /tmp/hn');
  assert.equal(await sim.out('hostname'), 'fromfile\n');
  assert.equal((await sim.run('hostname -F /nope')).err, 'hostname: No such file or directory\n');

  const web = sim.K.net.machineFor('web01');
  const sh = new sim.K.Shell({ machine: web, term: sim.term, user: 'student' });
  const on = async (line) => (await sh.capture(line)).out;
  assert.equal(await on('hostname -f; hostname -d; hostname -s; hostname -I; dnsdomainname'), 'web01.halcyon.lab\nhalcyon.lab\nweb01\n10.10.10.10 \nhalcyon.lab\n');
});

test('uname', async () => {
  const sim = await sys();
  assert.equal(await sim.out('uname'), 'Linux\n');
  assert.equal(await sim.out('uname -a'), 'Linux kali 7.1.5-kali1-amd64 #1 SMP PREEMPT_DYNAMIC Kali 7.1.5-1kali1 (2026-10-12) x86_64 GNU/Linux\n');
  assert.equal(await sim.out('uname -s; uname -n; uname -r; uname -v; uname -m; uname -p; uname -i; uname -o'),
    'Linux\nkali\n7.1.5-kali1-amd64\n#1 SMP PREEMPT_DYNAMIC Kali 7.1.5-1kali1 (2026-10-12)\nx86_64\nunknown\nunknown\nGNU/Linux\n');
  assert.equal(await sim.out('uname -o -m -rs'), 'Linux 7.1.5-kali1-amd64 x86_64 GNU/Linux\n', 'fields print in a fixed order');
  assert.equal(await sim.out('uname --kernel-release --machine'), '7.1.5-kali1-amd64 x86_64\n');
  assert.equal(await sim.out('echo "kernel $(uname -r | cut -d- -f1)"'), 'kernel 7.1.5\n');
  assert.equal((await sim.run('uname -x')).err, "uname: invalid option -- 'x'\nTry 'uname --help' for more information.\n");
  assert.equal((await sim.run('uname extra')).err, "uname: extra operand 'extra'\nTry 'uname --help' for more information.\n");
  assert.match(await sim.out('uname --help'), /^Usage: uname \[OPTION\]\.\.\.\nPrint certain system information\. {2}With no OPTION, same as -s\.\n/);
});

test('uptime', async () => {
  const sim = await sys();
  assert.equal(await sim.out('uptime'), ' 14:30:00 up  3:17,  1 user,  load average: 0.08, 0.11, 0.09\n');
  assert.equal(await sim.out('uptime -p'), 'up 3 hours, 17 minutes\n');
  assert.equal(await sim.out('uptime -s'), '2026-11-13 11:12:18\n');
  assert.equal(await sim.out('uptime --since | cut -d" " -f2'), '11:12:18\n');
  await sim.run('sleep 43m');
  assert.equal(await sim.out('uptime -p'), 'up 4 hours\n');
  await sim.run('sleep 2d');
  assert.equal(await sim.out('uptime'), ' 15:13:00 up 2 days,  4:00,  1 user,  load average: 0.08, 0.11, 0.09\n');
  assert.equal(await sim.out('uptime -p'), 'up 2 days, 4 hours\n');
  const bad = await sim.run('uptime -x');
  assert.deepEqual([bad.code, bad.err.split('\n').slice(0, 4)], [1, ["uptime: invalid option -- 'x'", '', 'Usage:', ' uptime [options]']]);
  assert.equal(await sim.out('uptime -V'), 'uptime from procps-ng 4.0.4\n');
  // a machine that has just booted reports minutes only
  sim.K.bootTime = sim.K.clock.now() - 39 * 60000;
  assert.equal(await sim.out('uptime'), ' 15:13:00 up 39 min,  1 user,  load average: 0.08, 0.11, 0.09\n');
});

test('date: default output, formats and presets', async () => {
  const sim = await sys();
  assert.equal(await sim.out('date'), 'Fri Nov 13 02:30:00 PM UTC 2026\n');
  assert.equal(await sim.out('LANG=C date'), 'Fri Nov 13 14:30:00 UTC 2026\n');
  assert.equal(await sim.out('date -u +%s'), '1794580200\n');
  assert.equal(await sim.out('date +%F_%T'), '2026-11-13_14:30:00\n');
  assert.equal(await sim.out("date '+%A %B %d %Y %j %U %a %b %e %H %I %M %S %p %Z %z %:z %y %C %D %F %T %R %r %u %w %% %N %s %h %k %l %P %G %V %g %E'"),
    'Friday November 13 2026 317 45 Fri Nov 13 14 02 30 00 PM UTC +0000 +00:00 26 20 11/13/26 2026-11-13 14:30:00 14:30 02:30:00 PM 5 5 % 000000000 1794580200 Nov 14  2 pm 2026 46 26 %E\n');
  assert.equal(await sim.out("date -d '2026-01-01' '+%10Y|%-d|%_d|%05d|%^a|%^B|%#Z|%-H|%3N|%e'"), '0000002026|1| 1|00001|THU|JANUARY|utc|0|000| 1\n');
  assert.equal(await sim.out("date -d '2026-01-05 03:04:05' '+%-d %-m %-H %e %k %l %_H %-I'"), '5 1 3  5  3  3  3 3\n');
  assert.equal(await sim.out('date "+%c|%x|%X"'), 'Fri 13 Nov 2026 02:30:00 PM UTC|11/13/2026|02:30:00 PM\n');
  assert.equal(await sim.out('LC_ALL=C date "+%c|%x|%X"'), 'Fri Nov 13 14:30:00 2026|11/13/26|14:30:00\n');
  assert.equal(await sim.out('date -I; date -Iseconds; date -Iminutes; date -Ihours; date --iso-8601=ns'),
    '2026-11-13\n2026-11-13T14:30:00+00:00\n2026-11-13T14:30+00:00\n2026-11-13T14+00:00\n2026-11-13T14:30:00,000000000+00:00\n');
  assert.equal(await sim.out('date -R; date --rfc-3339=seconds; date --rfc-3339=date'), 'Fri, 13 Nov 2026 14:30:00 +0000\n2026-11-13 14:30:00+00:00\n2026-11-13\n');
  assert.equal(await sim.out('touch -d "2026-10-01 08:00" /tmp/f 2>/dev/null; date -r /etc/hostname +%F'), '2026-10-26\n');
  assert.equal(await sim.out('echo "scan-$(date +%Y%m%d).txt"'), 'scan-20261113.txt\n');
});

test('date -d: ISO and relative inputs', async () => {
  const sim = await sys();
  const d = async (text, fmt = '%F %T') => (await sim.out(`date -d '${text}' '+${fmt}'`)).trimEnd();
  assert.equal(await d('@0'), '1970-01-01 00:00:00');
  assert.equal(await d('@1794580200'), '2026-11-13 14:30:00');
  assert.equal(await d('2026-12-25'), '2026-12-25 00:00:00');
  assert.equal(await d('2026-12-25 08:15'), '2026-12-25 08:15:00');
  assert.equal(await d('2026-12-25T08:15:30Z'), '2026-12-25 08:15:30');
  assert.equal(await d('2026-12-25T08:15:30+02:00'), '2026-12-25 06:15:30');
  assert.equal(await d('09:05'), '2026-11-13 09:05:00');
  assert.equal(await d('now'), '2026-11-13 14:30:00');
  assert.equal(await d(''), '2026-11-13 00:00:00');
  assert.equal(await d('tomorrow'), '2026-11-14 14:30:00');
  assert.equal(await d('yesterday'), '2026-11-12 14:30:00');
  assert.equal(await d('tomorrow 10:00'), '2026-11-14 10:00:00');
  assert.equal(await d('2 days ago'), '2026-11-11 14:30:00');
  assert.equal(await d('+3 hours'), '2026-11-13 17:30:00');
  assert.equal(await d('90 minutes ago'), '2026-11-13 13:00:00');
  assert.equal(await d('next week'), '2026-11-20 14:30:00');
  assert.equal(await d('1 month ago'), '2026-10-13 14:30:00');
  assert.equal(await d('next year'), '2027-11-13 14:30:00');
  assert.equal(await d('last monday'), '2026-11-09 00:00:00');
  assert.equal(await d('next friday'), '2026-11-20 00:00:00');
  assert.equal(await d('monday'), '2026-11-16 00:00:00');
  assert.equal(await d('13 nov 2026'), '2026-11-13 00:00:00');
  assert.equal(await d('Dec 1 2026 10:00'), '2026-12-01 10:00:00');
  assert.equal(await sim.out('date -d "2026-11-13 14:30:00"'), 'Fri Nov 13 02:30:00 PM UTC 2026\n');
  assert.equal(await sim.out('date --date=@86400 +%A'), 'Friday\n');
});

test('date: errors', async () => {
  const sim = await sys();
  const fails = async (line, err, code = 1) => { const r = await sim.run(line); assert.equal(r.err, err, line); assert.equal(r.code, code, line); };
  await fails('date -d garbage', "date: invalid date 'garbage'\n");
  await fails('date -d 2026-02-30', "date: invalid date '2026-02-30'\n");
  await fails('date extra', "date: invalid date 'extra'\n");
  await fails('date +%F +%T', "date: extra operand '+%T'\nTry 'date --help' for more information.\n");
  await fails('date -x', "date: invalid option -- 'x'\nTry 'date --help' for more information.\n");
  await fails('date -I -R', 'date: multiple output formats specified\n');
  await fails('date -I +%F', 'date: multiple output formats specified\n');
  await fails('date -d now -r /etc/hostname', "date: the options to specify dates for printing are mutually exclusive\nTry 'date --help' for more information.\n");
  await fails('date -r /nonexistent', 'date: /nonexistent: No such file or directory\n');
  await fails('date -Ix', "date: invalid argument 'x' for '--iso-8601'\nValid arguments are:\n  - 'hours'\n  - 'minutes'\n  - 'date'\n  - 'seconds'\n  - 'ns'\nTry 'date --help' for more information.\n");
  await fails('date --rfc-3339=x', "date: invalid argument 'x' for '--rfc-3339'\nValid arguments are:\n  - 'date'\n  - 'seconds'\n  - 'ns'\nTry 'date --help' for more information.\n");
  const set = await sim.run('date -s "2026-01-01 00:00:00"');
  assert.deepEqual([set.err, set.code], ['date: cannot set date: Operation not permitted\n', 1]);
  assert.match(await sim.out('date --version'), /^date \(GNU coreutils\) 9\.7\n/);
});

test('sleep: suffixes, fractions, errors and Ctrl-C', async () => {
  const sim = await sys();
  const elapsed = async (line) => { const t0 = sim.K.clock.now(); const r = await sim.run(line); assert.equal(r.code, 0, line); return sim.K.clock.now() - t0; };
  assert.equal(await elapsed('sleep 5'), 5000);
  assert.equal(await elapsed('sleep 0.25'), 250);
  assert.equal(await elapsed('sleep .5s'), 500);
  assert.equal(await elapsed('sleep 2m'), 120000);
  assert.equal(await elapsed('sleep 1h'), 3600000);
  assert.equal(await elapsed('sleep 1d'), 86400000);
  assert.equal(await elapsed('sleep 1m 30s 0.5'), 90500);
  const fails = async (line, err) => { const r = await sim.run(line); assert.deepEqual([r.err, r.code], [err, 1], line); };
  await fails('sleep', "sleep: missing operand\nTry 'sleep --help' for more information.\n");
  await fails('sleep abc', "sleep: invalid time interval 'abc'\nTry 'sleep --help' for more information.\n");
  await fails('sleep 1x 2', "sleep: invalid time interval '1x'\nTry 'sleep --help' for more information.\n");
  await fails('sleep -1', "sleep: invalid option -- '1'\nTry 'sleep --help' for more information.\n");
  assert.match(await sim.out('sleep --help'), /^Usage: sleep NUMBER\[SUFFIX\]\.\.\.\n/);
  const stopped = await interrupted(sim, 'sleep 100; echo not-reached');
  assert.equal(stopped.code, 130, 'Ctrl-C interrupts the wait');
  assert.doesNotMatch(stopped.output, /not-reached/);
});

test('env and printenv', async () => {
  const sim = await sys();
  const env = await sim.out('env');
  assert.match(env, /^SHELL=\/usr\/bin\/zsh\n/);
  assert.match(env, /\nHOME=\/home\/kali\n/);
  assert.match(env, /\nUSER=kali\n/);
  assert.equal(await sim.out('env | grep -c "^PATH="'), '1\n');
  assert.equal(await sim.out('export FOO=bar; env | grep FOO; printenv FOO'), 'FOO=bar\nbar\n');
  assert.equal(await sim.out('NOTEXPORTED=1; env | grep -c NOTEXPORTED'), '0\n');
  assert.equal(await sim.out('env -i A=1 B=2 env'), 'A=1\nB=2\n');
  assert.equal(await sim.out('env - A=5'), 'A=5\n');
  assert.equal(await sim.out('env -i'), '');
  assert.equal(await sim.out('env A=1 printenv A'), '1\n');
  assert.equal(await sim.out("env GREETING=hi sh -c 'echo $GREETING'; echo \"[$GREETING]\""), 'hi\n[]\n', 'the variable exists for that command only');
  assert.equal(await sim.out('env -u HOME printenv HOME; echo $?'), '1\n');
  assert.equal(await sim.out('env --unset=USER -i printenv; echo $?'), '0\n');
  assert.equal(await sim.out('env -C /tmp pwd; pwd'), '/tmp\n/home/kali\n');
  assert.equal(await sim.out('env echo hi'), 'hi\n');
  assert.equal(await sim.out('env LANG=C date'), 'Fri Nov 13 14:30:00 UTC 2026\n');
  assert.equal(await sim.out('env -0 -i A=1 B=2 | tr "\\0" :'), 'A=1:B=2:');
  assert.equal(await sim.out('env false; echo $?'), '1\n', 'the exit status of the command is passed on');
  const fails = async (line, err, code) => { const r = await sim.run(line); assert.deepEqual([r.err, r.code], [err, code], line); };
  await fails('env nosuchcmd', "env: 'nosuchcmd': No such file or directory\n", 127);
  await fails('env /etc/passwd', "env: '/etc/passwd': Permission denied\n", 126);
  await fails('env /no/such', "env: '/no/such': No such file or directory\n", 127);
  await fails('env -x', "env: invalid option -- 'x'\nTry 'env --help' for more information.\n", 125);
  await fails('env -0 true', "env: cannot specify --null (-0) with command\nTry 'env --help' for more information.\n", 125);
  await fails('env -C /tmp', "env: must specify command with --chdir (-C)\nTry 'env --help' for more information.\n", 125);

  assert.equal(await sim.out('printenv HOME SHELL'), '/home/kali\n/usr/bin/zsh\n');
  const some = await sim.run('printenv HOME NOPE');
  assert.deepEqual([some.out, some.code], ['/home/kali\n', 1]);
  assert.equal(await sim.out('printenv | grep -c "^HOME=/home/kali$"'), '1\n');
  assert.equal(await sim.out('printenv -0 HOME | tr "\\0" "!"'), '/home/kali!');
  await fails('printenv -x', "printenv: invalid option -- 'x'\nTry 'printenv --help' for more information.\n", 2);
});
