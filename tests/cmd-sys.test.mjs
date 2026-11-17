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

/* ------------------------------------------------------------------ processes */

test('ps: default, aux and -ef layouts', async () => {
  const sim = await sys();
  const { shell } = sim;
  const own = (await sim.out('ps')).split('\n');
  assert.equal(own[0], '    PID TTY          TIME CMD');
  assert.equal(own[1], `   ${shell.pid} pts/0    00:00:00 zsh`);
  assert.match(own[2], /^ {3}\d{4} pts\/0 {4}00:00:00 ps$/);
  assert.equal(own.length, 4);

  const aux = (await sim.out('ps aux')).split('\n');
  assert.equal(aux[0], 'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND');
  assert.equal(aux[1], 'root           1  0.0  0.4  23956 14320 ?        Ss   11:12   0:02 /sbin/init splash');
  assert.equal(aux[2], 'root           2  0.0  0.0      0     0 ?        S    11:12   0:00 [kthreadd]');
  assert.ok(aux.includes('message+     312  0.0  0.1   9872  5456 ?        Ss   11:12   0:00 /usr/bin/dbus-daemon --system --address=systemd: --nofork --nopidfile --systemd-activation --syslog-only'), 'long user names are cut with +');
  assert.ok(aux.includes('root         452  1.2  2.9 421776 118320 tty7     Ssl+ 11:12   2:22 /usr/lib/xorg/Xorg :0 -seat seat0 -auth /var/run/lightdm/root/:0 -nolisten tcp vt7 -novtswitch'));
  assert.ok(aux.some((l) => new RegExp(`^kali {8}${shell.pid}  0\\.0  0\\.\\d +\\d+ +\\d+ pts/0    Ss   14:30   0:00 -zsh$`).test(l)));
  assert.match(aux.at(-2), /^kali +\d+  0\.0  0\.\d +\d+ +\d+ pts\/0    R\+   14:30   0:00 ps aux$/);
  assert.equal(aux.length - 2, sim.machine.procs.length + 1, 'every process plus ps itself');

  const ef = (await sim.out('ps -ef')).split('\n');
  assert.equal(ef[0], 'UID          PID    PPID  C STIME TTY          TIME CMD');
  assert.equal(ef[1], 'root           1       0  0 11:12 ?        00:00:02 /sbin/init splash');
  assert.ok(ef.includes('root         452     451  1 11:12 tty7     00:02:22 /usr/lib/xorg/Xorg :0 -seat seat0 -auth /var/run/lightdm/root/:0 -nolisten tcp vt7 -novtswitch'));
  assert.equal((await sim.out('ps -e')).split('\n')[1], '      1 ?        00:00:02 systemd');
  assert.equal(await sim.out('ps -eF | head -2'), 'UID          PID    PPID  C    SZ   RSS PSR STIME TTY          TIME CMD\nroot           1       0  0  5989 14320   1 11:12 ?        00:00:02 /sbin/init splash\n');
  assert.match(await sim.out('ps -l'), /^F S {3}UID {5}PID {4}PPID {2}C PRI {2}NI ADDR SZ WCHAN {2}TTY {10}TIME CMD\n0 S {2}1000 {4}\d+ {5}\d+ {2}0 {2}80 {3}0 - +\d+ - {6}pts\/0 {4}00:00:00 zsh\n/);
  assert.equal(await sim.out('ps ax | head -3'), '    PID TTY      STAT   TIME COMMAND\n      1 ?        Ss     0:02 /sbin/init splash\n      2 ?        S      0:00 [kthreadd]\n');
  assert.equal(await sim.out('ps axj | head -2'), '   PPID     PID    PGID     SID TTY        TPGID STAT   UID   TIME COMMAND\n      0       1       1       1 ?             -1 Ss       0   0:02 /sbin/init splash\n');
  assert.equal(await sim.out('ps -V'), 'ps from procps-ng 4.0.4\n');
});

test('ps: selection by user, PID, name and parent', async () => {
  const sim = await sys();
  const pids = async (line) => (await sim.out(line + ' -o pid=')).trim().split(/\s+/).filter(Boolean).map(Number);
  const byUser = (u) => sim.machine.procs.filter((p) => p.user === u).map((p) => p.pid);
  assert.deepEqual((await pids('ps -u messagebus')), byUser('messagebus'));
  assert.deepEqual((await pids('ps -u kali')).slice(0, -1), byUser('kali'));
  assert.deepEqual((await pids('ps -U 33 -u root')).length, byUser('root').length);
  assert.deepEqual(await pids('ps -p 1,2'), [1, 2]);
  assert.deepEqual(await pids('ps -p 1 -p 2'), [1, 2]);
  assert.deepEqual(await pids('ps 1'), [1]);
  assert.deepEqual(await pids('ps -C cron'), [sim.K.sys.unit(sim.machine, 'cron').pid]);
  assert.deepEqual(await pids('ps --ppid 451'), [452, 453]);
  assert.deepEqual((await pids('ps a')).slice(0, -1), sim.machine.procs.filter((p) => p.tty !== '?').map((p) => p.pid), 'a: every process with a terminal');
  assert.ok((await pids('ps x')).includes(563), 'x adds processes without a terminal');
  assert.equal((await pids('ps -e')).length, sim.machine.procs.length + 1);
  assert.equal((await pids('ps -A')).length, sim.machine.procs.length + 1);
  const none = await sim.run('ps -p 99999');
  assert.deepEqual([none.out, none.code], ['    PID TTY          TIME CMD\n', 1]);
  assert.equal(await sim.out('ps -t tty7 -o pid=,comm='), '    452 Xorg\n');
  assert.equal(await sim.out('ps -e | grep -c kworker'), '32\n');
  assert.equal(await sim.out('ps aux | grep "[c]ron -f" | tr -s " " | cut -d" " -f1,2,11-'), 'root 365 /usr/sbin/cron -f\n');
});

test('ps: -o columns, headers and sorting', async () => {
  const sim = await sys();
  assert.equal(await sim.out('ps -o pid,ppid,user,stat,comm,args -p 1'), '    PID    PPID USER     STAT COMMAND         COMMAND\n      1       0 root     Ss   systemd         /sbin/init splash\n');
  assert.equal(await sim.out('ps -o pid,cmd,%cpu,%mem,etime,time,tty,ni,pri,vsz,rss,start,lstart,uid,gid,nlwp,s,tname,stime -p 1'),
    '    PID CMD                         %CPU %MEM     ELAPSED     TIME TT        NI PRI    VSZ   RSS  STARTED STARTED                    UID   GID NLWP S TTY      STIME\n' +
    '      1 /sbin/init splash            0.0  0.4    03:17:42 00:00:02 ?          0  19  23956 14320 11:12:18 Fri Nov 13 11:12:18 2026     0     0    1 S ?        11:12\n');
  assert.equal(await sim.out('ps -o pid= -p 1'), '      1\n');
  assert.equal(await sim.out('ps -o pid=,comm= -p 1'), '      1 systemd\n');
  assert.equal(await sim.out('ps -o pid=PROCESS,comm=NAME -p 1'), 'PROCESS NAME\n      1 systemd\n');
  assert.equal(await sim.out('ps -o user:20,pid -p 1'), 'USER                     PID\nroot                       1\n');
  assert.equal(await sim.out('ps -o pid -o comm -p 2'), '    PID COMMAND\n      2 kthreadd\n');
  assert.equal(await sim.out('ps --no-headers -o comm -p 1'), 'systemd\n');
  assert.equal(await sim.out('ps -eo pid,comm,args | grep "systemd-journald$"'), '    239 systemd-journal /usr/lib/systemd/systemd-journald\n', 'comm is cut to 15 characters');
  assert.equal(await sim.out('ps -eo user,pid,ni,comm | grep -E "ksmd|khugepaged|rtkit"'), 'root          37   5 ksmd\nroot          38  19 khugepaged\nrtkit        457   1 rtkit-daemon\n');
  assert.equal(await sim.out('ps aux --sort=-%mem | head -3 | cut -c1-41'), 'USER         PID %CPU %MEM    VSZ   RSS T\nroot         452  1.2  2.9 421776 118320 \nkali         631  0.0  2.4 1203316 98244 \n');
  assert.equal(await sim.out('ps -eo pid=,rss= --sort=-rss | head -2'), '    452 118320\n    631 98244\n');
  assert.equal(await sim.out('ps -eo pid= --sort=-pid | tail -1'), '      1\n');
  // on a terminal, lines are cut to its width
  const wide = (await sim.run('ps aux', { tty: true })).out.split('\n');
  assert.ok(wide.every((l) => l.length <= 80));
  assert.equal(wide.find((l) => / 452 /.test(l)), 'root         452  1.2  2.9 421776 118320 tty7     Ssl+ 11:12   2:22 /usr/lib/xorg/Xorg :0 -seat seat0'.slice(0, 80));
  assert.ok((await sim.run('ps auxww', { tty: true })).out.split('\n').some((l) => l.length > 132), 'ww lifts the limit');
});

test('ps: process tree', async () => {
  const sim = await sys();
  const ef = (await sim.out('ps -ef --forest')).split('\n');
  assert.equal(ef[1], 'root           2       0  0 11:12 ?        00:00:00 [kthreadd]');
  assert.equal(ef[2], 'root           3       2  0 11:12 ?        00:00:00  \\_ [pool_workqueue_release]');
  const at = (re) => ef.findIndex((l) => re.test(l));
  assert.ok(at(/ \/sbin\/init splash$/) > at(/\[kworker\/u8:0-flush-8:0\]$/), 'kernel threads come before init');
  const dm = at(/ \/usr\/sbin\/lightdm$/);
  const shown = ef.slice(dm, dm + 6).map((l) => l.replace(/^.*?\d\d:\d\d:\d\d/, ''));
  assert.deepEqual(shown.map((l) => l.replace(/^( *(\\_ )?)(\S+).*$/, '$1$3')), [
    ' /usr/sbin/lightdm',
    '  \\_ /usr/lib/xorg/Xorg',
    '  \\_ lightdm',
    '      \\_ xfce4-session',
    '          \\_ /usr/bin/ssh-agent',
    '          \\_ xfwm4',
  ]);
  const panel = at(/ {10}\\_ xfce4-panel$/);
  assert.match(ef[panel + 1], / {10}\| {3}\\_ \/usr\/lib\/x86_64-linux-gnu\/xfce4\/panel\/wrapper-2\.0 /);
  const term = at(/\\_ \/usr\/bin\/qterminal$/);
  assert.match(ef[term + 1], / {10}\| {7}\\_ -zsh$/);
  assert.match(ef[term + 2], / {10}\| {11}\\_ ps -ef --forest$/);
  assert.match(await sim.out('ps f'), /^ {4}PID TTY {6}STAT {3}TIME COMMAND\n +\d+ pts\/0 {4}Ss {5}0:00 -zsh\n +\d+ pts\/0 {4}R\+ {5}0:00 {2}\\_ ps f\n$/);
  assert.match(await sim.out('ps -H'), /\n +\d+ pts\/0 {4}00:00:00 zsh\n +\d+ pts\/0 {4}00:00:00 {3}ps\n$/);
});

test('ps: errors', async () => {
  const sim = await sys();
  const usage = "\nUsage:\n ps [options]\n\n Try 'ps --help <simple|list|output|threads|misc|all>'\n  or 'ps --help <s|l|o|t|m|a>'\n for additional help text.\n\nFor more details see ps(1).\n";
  const fails = async (line, msg) => { const r = await sim.run(line); assert.deepEqual([r.err, r.code, r.out], ['error: ' + msg + '\n' + usage, 1, ''], line); };
  await fails('ps -o bogus', 'unknown user-defined format specifier "bogus"');
  await fails('ps --bogus', 'unknown gnu long option');
  await fails('ps -z', 'unsupported SysV option');
  await fails('ps z', 'unsupported option (BSD syntax)');
  await fails('ps -u nosuchuser', 'user name does not exist');
  await fails('ps -p abc', 'process ID list syntax error');
  await fails('ps -t pts/x', 'TTY could not be found');
  assert.equal(await sim.out('ps --help'), usage);
  assert.match(await sim.out('ps --help simple'), /^\nUsage:\n ps \[options\]\n\nBasic options:\n -A, -e {15}all processes\n/);
});

test('pgrep and pidof', async () => {
  const sim = await sys();
  assert.equal(await sim.out('pgrep cron'), '365\n');
  assert.equal(await sim.out('pgrep -l dbus'), '312 dbus-daemon\n550 dbus-daemon\n');
  assert.equal(await sim.out('pgrep -a cron'), '365 /usr/sbin/cron -f\n');
  assert.equal(await sim.out('pgrep -u kali -l xfce4'), '563 xfce4-session\n682 xfce4-panel\n770 xfce4-power-man\n796 xfce4-notifyd\n');
  assert.equal(await sim.out('pgrep -u 0 -x systemd'), '1\n');
  assert.equal(await sim.out('pgrep -x systemd'), '1\n483\n');
  assert.equal(await sim.out('pgrep -c kworker'), '32\n');
  assert.equal(await sim.out('pgrep -n xfce4; pgrep -o xfce4'), '796\n563\n');
  assert.equal(await sim.out('pgrep -f session-child'), '453\n');
  assert.equal(await sim.out('pgrep -P 451 -l'), '452 Xorg\n453 lightdm\n');
  assert.equal(await sim.out('pgrep -d, dbus'), '312,550\n');
  assert.equal(await sim.out('pgrep -t tty7 -l'), '452 Xorg\n');
  assert.equal(await sim.out('pgrep -i XORG'), '452\n');
  assert.equal(await sim.out('pgrep -vc .'), '0\n');
  assert.equal(await sim.out('pgrep pgrep; echo $?'), '1\n', 'pgrep never reports itself');
  assert.equal(await sim.out('ps -o comm= -p $(pgrep -x cron)'), 'cron\n');
  const none = await sim.run('pgrep nosuchproc');
  assert.deepEqual([none.output, none.code], ['', 1]);
  const fails = async (line, err, code) => { const r = await sim.run(line); assert.deepEqual([r.err, r.code], [err, code], line); };
  await fails('pgrep', "pgrep: no matching criteria specified\nTry `pgrep --help' for more information.\n", 2);
  await fails('pgrep a b', "pgrep: only one pattern can be provided\nTry `pgrep --help' for more information.\n", 2);
  await fails('pgrep -u nosuchuser x', 'pgrep: invalid user name: nosuchuser\n', 2);
  await fails('pgrep xfce4-power-manager', "pgrep: pattern that searches for process name longer than 15 characters will result in zero matches\nTry `pgrep -f' option to match against the complete command line.\n", 1);
  assert.match((await sim.run('pgrep -z')).err, /^pgrep: invalid option -- 'z'\n\nUsage:\n pgrep \[options\] <pattern>\n/);
  assert.equal(await sim.out('pgrep -V'), 'pgrep from procps-ng 4.0.4\n');

  assert.equal(await sim.out('pidof cron'), '365\n');
  assert.equal(await sim.out('pidof dbus-daemon'), '550 312\n', 'newest first');
  assert.equal(await sim.out('pidof -s dbus-daemon'), '550\n');
  assert.equal(await sim.out('pidof -o 550 dbus-daemon'), '312\n');
  assert.equal(await sim.out('pidof -d, cron dbus-daemon'), '365,550,312\n');
  assert.equal(await sim.out('pidof /usr/sbin/cron'), '365\n');
  assert.equal(await sim.out('pidof -q cron; echo $?'), '0\n');
  assert.equal(await sim.out('pidof nosuchproc; echo $?'), '1\n');
  assert.match(await sim.out('pidof -h'), /^pidof usage: \[options\] <program-name>\n/);
});

test('pkill and killall: permissions, signals and units', async () => {
  const sim = await sys();
  const { K, machine } = sim;
  const denied = await sim.run('pkill cron');
  assert.deepEqual([denied.err, denied.code], ['pkill: killing pid 365 failed: Operation not permitted\n', 1]);
  const denied2 = await sim.run('killall cron');
  assert.deepEqual([denied2.err, denied2.code], ['cron(365): Operation not permitted\ncron: no process found\n', 1]);
  assert.equal(K.sys.unit(machine, 'cron').active, 'active');
  assert.deepEqual([(await sim.run('killall nosuchproc')).err, (await sim.run('killall -q nosuchproc')).err], ['nosuchproc: no process found\n', '']);
  assert.equal((await sim.run('pkill nosuchproc')).code, 1);
  assert.equal(await sim.out('pkill -0 xfwm4; echo $?; killall -0 xfwm4; echo $?'), '0\n0\n', 'signal 0 only tests');

  // a HUP makes a daemon reload: it stays up
  assert.equal((await sim.run('sudo pkill -HUP cron')).code, 0);
  assert.equal(K.sys.unit(machine, 'cron').active, 'active');
  // TERM stops the daemon cleanly; systemd notices
  const r = await sim.run('sudo killall -v cron');
  assert.deepEqual([r.err, r.code], ['Killed cron(365) with signal 15\n', 0]);
  assert.equal(await sim.out('pgrep cron; echo $?'), '1\n');
  assert.deepEqual([K.sys.unit(machine, 'cron').active, K.sys.unit(machine, 'cron').pid], ['inactive', null]);
  assert.equal(machine.state.journal.at(-1).msg, 'cron.service: Deactivated successfully.');
  // KILL takes the whole unit down as failed
  K.sys.startUnit(machine, 'apache2');
  assert.equal(await sim.out('pgrep -c apache2'), '3\n');
  assert.equal((await sim.run('sudo pkill -9 -o apache2')).code, 0);
  assert.deepEqual([K.sys.unit(machine, 'apache2').active, K.sys.unit(machine, 'apache2').sub], ['failed', 'failed']);
  assert.equal(await sim.out('pgrep -c apache2'), '0\n');
  assert.equal(K.net.tcp(machine, '10.10.10.5', 80).state, 'closed');
  // own desktop processes can be signalled without sudo
  assert.equal(await sim.out('pkill -e -x nm-applet; pgrep nm-applet; echo $?'), 'nm-applet killed (pid 757)\n1\n');
  assert.equal(await sim.out('killall -u kali -r "^xfce4-p"; pgrep -c xfce4-p'), '0\n');
  assert.equal(await sim.out('pkill zsh; echo $?; ps -o comm= -p $$'), '0\nzsh\n', 'an interactive shell ignores SIGTERM');

  assert.equal(await sim.out('killall -l'), 'HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM STKFLT\nCHLD CONT STOP TSTP TTIN TTOU URG XCPU XFSZ VTALRM PROF WINCH POLL PWR SYS\n');
  const usage = await sim.run('killall');
  assert.equal(usage.code, 1);
  assert.match(usage.err, /^Usage: killall \[OPTION\]\.\.\. \[--\] NAME\.\.\.\n/);
  assert.deepEqual([(await sim.run('killall -s BOGUS cron')).err], ['BOGUS: unknown signal; killall -l lists signals.\n']);
  assert.deepEqual([(await sim.run('pkill')).err, (await sim.run('pkill')).code], ["pkill: no matching criteria specified\nTry `pkill --help' for more information.\n", 2]);
  assert.equal(await sim.out('pkill -V'), 'pkill from procps-ng 4.0.4\n');
});

test('pkill stops a background job', async () => {
  const sim = await sys();
  sim.K.clock.useReal(); sim.K.settings.timeScale = 1;
  await sim.shell.runLine('sleep 5 &');
  assert.match(await sim.out('jobs'), /running +sleep 5/);
  assert.equal((await sim.run('pgrep -x sleep')).code, 0);
  assert.equal((await sim.run('pkill sleep')).code, 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await sim.out('pgrep -c sleep'), '0\n');
  assert.doesNotMatch(await sim.out('jobs'), /running/);
});

/* ------------------------------------------------- memory, sessions, calendar */

test('free: layout and units', async () => {
  const sim = await sys();
  const lines = (await sim.out('free')).split('\n');
  assert.equal(lines[0], '               total        used        free      shared  buff/cache   available');
  assert.match(lines[1], /^Mem: {9}4026392 +\d+ +1493820 +41280 +\d+ +2871544$/);
  assert.match(lines[2], /^Swap: {8}1048572 {11}0 +1048572$/);
  assert.match(await sim.out('free -h'), /^ +total.*\nMem: +3\.8Gi +1\.\dGi +1\.4Gi +40Mi +1\.\dGi +2\.7Gi\nSwap: +1\.0Gi +0B +1\.0Gi\n$/);
  assert.match(await sim.out('free -m -t'), /\nTotal: +4956 +\d+ +\d+\n$/);
  assert.match(await sim.out('free -w'), /shared +buffers +cache +available/);
  assert.equal((await sim.out('free -s 1 -c 2')).split('\n\n').length, 2);
  assert.match(await sim.out('free --si -h'), /Mem: +4\.1GB/);
  const bad = await sim.run('free -z');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^free: invalid option -- 'z'\n\nUsage:\n free \[options\]/);
  assert.match(await sim.out('free -V'), /^free from procps-ng/);
});

test('arch, nproc, tty, lsb_release', async () => {
  const sim = await sys();
  assert.equal(await sim.out('arch'), 'x86_64\n');
  assert.equal(await sim.out('nproc'), '2\n');
  assert.equal(await sim.out('nproc --ignore=1'), '1\n');
  assert.equal(await sim.out('nproc --ignore=9'), '1\n');
  assert.equal((await sim.run('nproc --ignore=x')).err, "nproc: invalid number: 'x'\n");
  assert.equal(await sim.out('tty'), '/dev/pts/0\n');
  const piped = await sim.run('echo | tty');
  assert.equal(piped.out, 'not a tty\n');
  assert.equal(piped.code, 1);
  assert.equal((await sim.run('echo | tty -s')).out, '');
  const lsb = await sim.run('lsb_release -a');
  assert.equal(lsb.out, 'Distributor ID:\tKali\nDescription:\tKali GNU/Linux Rolling\nRelease:\t2026.3\nCodename:\tkali-rolling\n');
  assert.equal(lsb.err, 'No LSB modules are available.\n');
  assert.equal(await sim.out('lsb_release -ds'), 'Kali GNU/Linux Rolling\n');
  assert.equal(await sim.out('lsb_release -rc'), 'Release:\t2026.3\nCodename:\tkali-rolling\n');
  assert.equal(await sim.out('lsb_release'), 'No LSB modules are available.\n');
});

test('who, w, users, last', async () => {
  const sim = await sys();
  assert.match(await sim.out('who'), /^kali {5}tty7 {9}\d{4}-\d\d-\d\d \d\d:\d\d \(:0\)\n$/);
  assert.match(await sim.out('who -H'), /^NAME {5}LINE {9}TIME {13}COMMENT\nkali/);
  assert.match(await sim.out('who -b'), /^ {9}system boot {2}\d{4}-/);
  assert.equal(await sim.out('who -q'), 'kali\n# users=1\n');
  assert.equal(await sim.out('who am i'), '');
  assert.equal(await sim.out('users'), 'kali\n');
  const w = (await sim.out('w')).split('\n');
  assert.match(w[0], /^ \d\d:\d\d:\d\d up .*1 user,  load average: /);
  assert.equal(w[1], 'USER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT');
  assert.match(w[2], /^kali {5}tty7 {5}:0 {15}\d\d:\d\d +[\d:]+m +[\d:]+ +0\.05s xfce4-session$/);
  assert.equal((await sim.out('w -h')).split('\n').length, 2);
  assert.equal(await sim.out('w nobody -h'), '\n');
  const last = (await sim.out('last')).split('\n');
  assert.match(last[0], /^kali {5}tty7 {9}:0 {15}\w{3} \w{3} [ \d]\d \d\d:\d\d {3}still logged in$/);
  assert.match(last[1], /^reboot {3}system boot {2}7\.1\.5-kali1-amd64 \w{3} \w{3} [ \d]\d \d\d:\d\d {3}still running$/);
  assert.match(last[2], / - \d\d:\d\d \(\d\d:\d\d\)$/);
  assert.match(last.slice(-2)[0], /^wtmp begins \w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
  assert.equal((await sim.out('last -n 2')).split('\n').filter((l) => /^\S/.test(l) && !/^wtmp/.test(l)).length, 2);
  assert.equal((await sim.out('last -2 reboot')).split('\n').filter((l) => /^reboot/.test(l)).length, 2);
  assert.match((await sim.run('last -z')).err, /^last: invalid option -- 'z'/);
});

test('cal', async () => {
  const sim = await sys();
  sim.K.clock.useVirtual(Date.UTC(2026, 10, 17, 12, 0, 0));
  assert.equal(await sim.out('cal'), [
    '   November 2026      ', 'Su Mo Tu We Th Fr Sa  ', ' 1  2  3  4  5  6  7  ', ' 8  9 10 11 12 13 14  ',
    '15 16 17 18 19 20 21  ', '22 23 24 25 26 27 28  ', '29 30                 ', ''].join('\n'));
  assert.equal((await sim.out('cal 2 2028')).split('\n')[6], '27 28 29              ');
  assert.equal((await sim.out('cal feb 2027')).split('\n')[0], '   February 2027      ');
  assert.equal((await sim.out('cal -m 9 2026')).split('\n')[1], 'Mo Tu We Th Fr Sa Su  ');
  assert.match((await sim.out('cal -3')).split('\n')[0], /^ {4}October 2026 {9}November 2026 {9}December 2026 {6}$/);
  const year = (await sim.out('cal 2027')).split('\n');
  assert.equal(year[0].trim(), '2027');
  assert.match(year[2], /January 2027 +February 2027 +March 2027/);
  assert.equal((await sim.run('cal 13 2026')).err, 'cal: illegal month value: use 1-12\n');
  assert.equal((await sim.run('cal 1 10000')).err, 'cal: illegal year value: use 1-9999\n');
  assert.ok((await sim.out('cal', { tty: true })).includes('\x1b[7m17\x1b[27m'));
});

/* ---------------------------------------------------------- top, htop, watch */

test('top: batch mode', async () => {
  const sim = await sys();
  const lines = (await sim.out('top -b -n 1')).split('\n');
  assert.match(lines[0], /^top - \d\d:\d\d:\d\d up .*load average: /);
  assert.match(lines[1], /^Tasks: +\d+ total, +1 running, +\d+ sleeping, +0 stopped, +0 zombie$/);
  assert.match(lines[2], /^%Cpu\(s\): +[\d.]+ us, +[\d.]+ sy, +0\.0 ni, +[\d.]+ id, +[\d.]+ wa, +0\.0 hi, +[\d.]+ si, +0\.0 st $/);
  assert.match(lines[3], /^MiB Mem : +3932\.0 total, +[\d.]+ free, +[\d.]+ used, +[\d.]+ buff\/cache {5}$/);
  assert.match(lines[4], /^MiB Swap: +1024\.0 total, +1024\.0 free, +0\.0 used\. +[\d.]+ avail Mem $/);
  assert.equal(lines[5], '');
  assert.equal(lines[6], '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND');
  assert.match(lines[7], /^ +452 root +20 +0 +421776 +118320 +\d+ S +1\.2 +2\.9 +2:22\.\d\d Xorg$/);
  assert.equal((await sim.out('top -b -n 2')).split('\n').filter((l) => /^top - /.test(l)).length, 2);
  assert.equal((await sim.out('top -bn1 -p 1')).split('\n').length, 9);
  assert.ok((await sim.out('top -bn1 -u kali')).split('\n').slice(7).every((l) => !l || / kali /.test(l)));
  assert.match(await sim.out('top -bn1 -c -p 452'), /\/usr\/lib\/xorg\/Xorg :0 -seat seat0/);
});

test('top: options and errors', async () => {
  const sim = await sys();
  const bad = await sim.run('top -x');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^top: unknown option 'x'\nUsage:/);
  assert.match((await sim.run('top -n x')).err, /^top: bad iterations argument 'x'/);
  assert.match((await sim.run('top -u nobodyhere')).err, /^top: Invalid user 'nobodyhere'/);
  assert.match(await sim.out('top -v'), /^top from procps-ng/);
});

test('top: live screen redraws until q', async () => {
  const sim = await sys();
  sim.term.take();
  const pending = sim.shell.runLine('top');
  setTimeout(() => sim.term.pressKey('q'), 80);
  assert.equal(await pending, 0);
  const out = sim.term.take();
  assert.ok(out.includes('\x1b[2J\x1b[H'));
  assert.ok(out.split('top - ').length > 2, 'redrawn more than once');
  const again = await interrupted(sim, 'top');
  assert.equal(again.code, 0);
});

test('htop and watch', async () => {
  const sim = await sys();
  const h = (await sim.out('htop')).split('\n');
  assert.match(h[0], /^ {2}0\[\|*\s+[\d.]+%\] {2}Tasks: \d+, \d+ thr, \d+ kthr; 1 running$/);
  assert.match(h[5], /^ {4}PID USER {7}PRI {2}NI/);
  assert.match(h.find((l) => /F10Quit/.test(l)), /^F1Help/);
  assert.match((await sim.run('htop -u nobody')).err, /^htop: Unknown user: nobody/);
  const w = await sim.run('watch -n 1 -g date');
  assert.equal(w.code, 0);
  assert.match(w.out, /^Every 1\.0s: date +kali: \w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}\n\n\w{3} /);
  assert.equal((await sim.out('watch -t -q 1 echo hi')).split('\n')[0], 'hi');
  assert.equal((await sim.run('watch')).code, 1);
  const stopped = await interrupted(sim, 'watch -n 1 echo hi');
  assert.equal(stopped.code, 0);
});

/* ------------------------------------------------ systemctl, service, journal */

test('systemctl status: layout of a stopped and a running service', async () => {
  const sim = await sys();
  const stopped = await sim.run('systemctl status ssh');
  assert.equal(stopped.code, 3);
  assert.equal(stopped.out, '○ ssh.service - OpenBSD Secure Shell server\n     Loaded: loaded (/usr/lib/systemd/system/ssh.service; disabled; preset: disabled)\n     Active: inactive (dead)\n       Docs: man:sshd(8)\n             man:sshd_config(5)\n\n');
  assert.equal((await sim.run('sudo systemctl start ssh')).code, 0);
  const up = await sim.run('systemctl status ssh');
  assert.equal(up.code, 0);
  const lines = up.out.split('\n');
  assert.equal(lines[0], '● ssh.service - OpenBSD Secure Shell server');
  assert.match(lines[2], /^ {5}Active: active \(running\) since \w{3} \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC; \d+s ago$/);
  assert.match(lines[3], /^ Invocation: [0-9a-f]{32}$/);
  assert.match(up.out, /\n {4}Process: \d+ ExecStartPre=\/usr\/sbin\/sshd -t \(code=exited, status=0\/SUCCESS\)\n {3}Main PID: \d+ \(sshd\)\n {6}Tasks: 1 \(limit: \d+\)\n/);
  assert.match(up.out, /\n {5}CGroup: \/system\.slice\/ssh\.service\n {13}└─\d+ "sshd: \/usr\/sbin\/sshd -D \[listener\] 0 of 10-100 startups"\n\n/);
  assert.match(up.out, /kali systemd\[1\]: Starting ssh\.service - OpenBSD Secure Shell server\.\.\.\n.*sshd\[\d+\]: Server listening on 0\.0\.0\.0 port 22\.\n/);
  assert.match((await sim.run('systemctl status ssh', { tty: true })).out, /^\x1b\[32m●\x1b\[39m ssh\.service/);
  const missing = await sim.run('systemctl status nosuch');
  assert.equal(missing.code, 4);
  assert.equal(missing.err, 'Unit nosuch.service could not be found.\n');
});

test('systemctl: start opens the port, stop closes it', async () => {
  const sim = await sys();
  const listening = () => sim.K.net.listening(sim.machine).some((l) => l.port === 22);
  assert.equal(listening(), false);
  assert.equal((await sim.run('sudo systemctl start ssh')).out, '');
  assert.equal(listening(), true);
  assert.ok(sim.machine.procs.some((p) => /^sshd: /.test(p.cmd)));
  assert.equal(await sim.out('systemctl is-active ssh'), 'active\n');
  assert.equal((await sim.run('sudo systemctl restart ssh')).code, 0);
  assert.equal((await sim.run('sudo systemctl stop ssh')).code, 0);
  assert.equal(listening(), false);
  assert.ok(!sim.machine.procs.some((p) => /^sshd: /.test(p.cmd)));
  const inactive = await sim.run('systemctl is-active ssh');
  assert.equal(inactive.out, 'inactive\n');
  assert.equal(inactive.code, 3);
  assert.match(await sim.out('systemctl status ssh'), /Active: inactive \(dead\) since .*\n {3}Duration: /);
  assert.match(await sim.out('sudo journalctl -u ssh --no-pager'), /Stopped ssh\.service - OpenBSD Secure Shell server\./);
});

test('systemctl: apache2 serves the web root once started', async () => {
  const sim = await sys();
  await sim.run('sudo systemctl start apache2');
  const r = sim.K.net.http(sim.machine, { method: 'GET', url: 'http://127.0.0.1/' });
  assert.equal(r.status, 200);
  assert.match(r.body, /Apache2 Debian Default Page/);
  const nf = sim.K.net.http(sim.machine, { method: 'GET', url: 'http://127.0.0.1/nope.html' });
  assert.equal(nf.status, 404);
  assert.match(nf.body, /Not Found/);
});

test('systemctl: permissions, unknown units, enable and disable', async () => {
  const sim = await sys();
  const denied = await sim.run('systemctl start ssh');
  assert.equal(denied.code, 1);
  assert.equal(denied.err, "Failed to start ssh.service: Interactive authentication required.\nSee system logs and 'systemctl status ssh.service' for details.\n");
  assert.equal((await sim.run('systemctl stop cron')).err, "Failed to stop cron.service: Interactive authentication required.\nSee system logs and 'systemctl status cron.service' for details.\n");
  assert.equal((await sim.run('systemctl enable ssh')).err, 'Failed to enable unit: Interactive authentication required.\n');
  assert.equal((await sim.run('systemctl daemon-reload')).err, 'Failed to reload daemon: Interactive authentication required.\n');
  const nosuch = await sim.run('sudo systemctl start nosuch');
  assert.equal(nosuch.code, 5);
  assert.equal(nosuch.err, 'Failed to start nosuch.service: Unit nosuch.service not found.\n');
  assert.equal((await sim.run('sudo systemctl enable nosuch')).err, 'Failed to enable unit: Unit file nosuch.service does not exist.\n');
  const en = await sim.out('sudo systemctl enable ssh');
  assert.equal(en, "Synchronizing state of ssh.service with SysV service script with /usr/lib/systemd/systemd-sysv-install.\nExecuting: /usr/lib/systemd/systemd-sysv-install enable ssh\nCreated symlink '/etc/systemd/system/sshd.service' → '/usr/lib/systemd/system/ssh.service'.\nCreated symlink '/etc/systemd/system/multi-user.target.wants/ssh.service' → '/usr/lib/systemd/system/ssh.service'.\n");
  assert.equal(await sim.out('systemctl is-enabled ssh'), 'enabled\n');
  assert.match(await sim.out('sudo systemctl disable ssh'), /Removed '\/etc\/systemd\/system\/multi-user\.target\.wants\/ssh\.service'\.\n$/);
  const dis = await sim.run('systemctl is-enabled ssh');
  assert.equal(dis.out, 'disabled\n');
  assert.equal(dis.code, 1);
  assert.equal(await sim.out('systemctl is-enabled dbus'), 'static\n');
  await sim.run('sudo systemctl enable --now ssh');
  assert.equal(await sim.out('systemctl is-active ssh'), 'active\n');
  assert.equal((await sim.run('systemctl frobnicate')).err, "Unknown command verb 'frobnicate'.\n");
  assert.equal((await sim.run('sudo systemctl reload cron')).err, 'Failed to reload cron.service: Job type reload is not applicable for unit cron.service.\n');
});

test('systemctl: listings', async () => {
  const sim = await sys();
  const units = (await sim.out('systemctl list-units --type=service')).split('\n');
  assert.match(units[0], /^ {2}UNIT +LOAD +ACTIVE SUB +DESCRIPTION$/);
  assert.ok(units.some((l) => /^ {2}cron\.service +loaded active running +Regular background program processing daemon$/.test(l)));
  assert.ok(!units.some((l) => /^ {2}ssh\.service/.test(l)));
  assert.match(units.slice(-5).join('\n'), /loaded units listed\.[^\n]*\nTo show all installed unit files use 'systemctl list-unit-files'\./);
  assert.ok((await sim.out('systemctl list-units --all --type=service')).includes('ssh.service'));
  assert.match(await sim.out('systemctl list-units --failed'), /^0 loaded units listed\.\n$/);
  const files = (await sim.out('systemctl list-unit-files')).split('\n');
  assert.match(files[0], /^UNIT FILE +STATE +PRESET$/);
  assert.ok(files.some((l) => /^ssh\.service +disabled +disabled$/.test(l)));
  assert.ok(files.some((l) => /^dbus\.service +static +-$/.test(l)));
  assert.match(files.slice(-2).join(''), /\d+ unit files listed\./);
  assert.match(await sim.out('systemctl --version'), /^systemd \d+ \(/);
});

test('systemctl: a daemon that dies marks its unit', async () => {
  const sim = await sys();
  await sim.run('sudo systemctl start ssh');
  const pid = sim.machine.procs.find((p) => /^sshd: /.test(p.cmd)).pid;
  await sim.run('sudo kill ' + pid);
  assert.equal(await sim.out('systemctl is-active ssh'), 'inactive\n');
  await sim.run('sudo systemctl start ssh');
  await sim.run('sudo kill -9 ' + sim.machine.procs.find((p) => /^sshd: /.test(p.cmd)).pid);
  assert.equal(await sim.out('systemctl is-active ssh'), 'failed\n');
  assert.match(await sim.out('systemctl --failed --no-pager'), /ssh\.service +loaded failed failed/);
});

test('service: start, status and --status-all', async () => {
  const sim = await sys();
  const denied = await sim.run('service ssh start');
  assert.equal(denied.code, 1);
  assert.match(denied.err, /^Failed to start ssh\.service: Interactive authentication required\./);
  assert.equal((await sim.run('sudo service ssh start')).code, 0);
  assert.match(await sim.out('service ssh status'), /^● ssh\.service - OpenBSD Secure Shell server\n/);
  assert.match(await sim.out('service --status-all'), / \[ \+ \] {2}cron\n(.*\n)* \[ \+ \] {2}ssh\n?/);
  assert.match(await sim.out('service --status-all'), / \[ - \] {2}apache2\n/);
  assert.equal((await sim.run('service nosuch start')).err, 'nosuch: unrecognized service\n');
  assert.match((await sim.run('service')).err, /^Usage: service < option >/);
  assert.match((await sim.run('service ssh')).err, /^Usage: \/etc\/init\.d\/ssh \{start\|stop/);
});

test('journalctl: filters and formats', async () => {
  const sim = await sys();
  const all = (await sim.out('journalctl --no-pager')).split('\n');
  assert.match(all[0], /^[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d kali kernel: Linux version 7\.1\.5-kali1-amd64/);
  assert.equal((await sim.out('journalctl -n 3')).split('\n').length, 4);
  assert.equal((await sim.out('journalctl -n3')).split('\n').length, 4);
  const rev = (await sim.out('journalctl -r -n 2')).split('\n');
  const fwd = (await sim.out('journalctl -n 2')).split('\n');
  assert.equal(rev[0], fwd[1]);
  assert.ok((await sim.out('journalctl -k')).split('\n').filter(Boolean).every((l) => / kali kernel: /.test(l)));
  assert.equal(await sim.out('journalctl -u nosuch'), '-- No entries --\n');
  await sim.run('sudo systemctl start ssh');
  const ssh = (await sim.out('journalctl -u ssh -n 2 -o cat')).split('\n');
  assert.equal(ssh[1], 'Started ssh.service - OpenBSD Secure Shell server.');
  assert.match(await sim.out('journalctl -u ssh -o short-iso'), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+0000 kali systemd\[1\]: Starting/);
  assert.equal(await sim.out('journalctl -p err'), '-- No entries --\n');
  assert.match(await sim.out('journalctl -t sshd -g "port 22"'), /sshd\[\d+\]: Server listening on 0\.0\.0\.0 port 22\./);
  assert.match(await sim.out('journalctl --since "10 min ago" --no-pager'), /Started ssh\.service/);
  assert.equal(await sim.out('journalctl --since tomorrow'), '-- No entries --\n');
  assert.equal((await sim.run('journalctl --since nonsense')).err, 'Failed to parse timestamp: nonsense\n');
  assert.equal((await sim.run('journalctl -b -1')).err, 'No journal boot entry found from the specified boot offset.\n');
  assert.equal((await sim.run('journalctl -p loud')).err, 'Unknown log level loud\n');
  assert.match(await sim.out('journalctl --disk-usage'), /^Archived and active journals take up /);
});

test('journalctl: sudo use shows up and -f follows until Ctrl-C', async () => {
  const sim = await sys();
  await sim.type('sudo id');
  assert.match(await sim.out('journalctl -t sudo --no-pager'), /sudo: {5}kali : TTY=pts\/0 ; PWD=\S+ ; USER=root ; COMMAND=\/usr\/bin\/id/);
  const f = await interrupted(sim, 'journalctl -f -n 1');
  assert.equal(f.code, 130);
  assert.match(f.output, /kali /);
});

test('dmesg needs root', async () => {
  const sim = await sys();
  const denied = await sim.run('dmesg');
  assert.equal(denied.code, 1);
  assert.equal(denied.err, 'dmesg: read kernel buffer failed: Operation not permitted\n');
  const lines = (await sim.out('sudo dmesg')).split('\n');
  assert.match(lines[0], /^\[ {4}0\.000000\] Linux version 7\.1\.5-kali1-amd64/);
  assert.match((await sim.out('sudo dmesg -t')).split('\n')[0], /^Linux version/);
  assert.match((await sim.out('sudo dmesg -T')).split('\n')[0], /^\[\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}\] Linux version/);
  assert.match((await sim.out('sudo dmesg -x -l info')).split('\n')[0], /^kern {2}:info {2}: \[/);
  assert.match((await sim.run('sudo dmesg -l loud')).err, /^dmesg: unknown level 'loud'/);
  assert.match((await sim.out('sudo dmesg | grep -i "Link is Up"')), /e1000: eth0 NIC Link is Up 1000 Mbps/);
});

/* ------------------------------------------------------------ manual pages */

test('man: page layout rendered from the command definition', async () => {
  const sim = await sys();
  const page = (await sim.out('man whoami')).split('\n');
  assert.match(page[0], /^WHOAMI\(1\) {7}User Commands {8}WHOAMI\(1\)$|^WHOAMI\(1\) +User Commands +WHOAMI\(1\)$/);
  assert.equal(page[0].length, 78);
  assert.deepEqual(page.slice(1, 8), ['', 'NAME', '       whoami - print effective user name', '', 'SYNOPSIS', '       whoami [OPTION]...', '']);
  assert.ok(page.includes('DESCRIPTION') && page.includes('EXAMPLES'));
  assert.match(page.slice(-2)[0], /^GNU coreutils 9\.7 +\w+ \d{4} +WHOAMI\(1\)$/);
  assert.ok(page.every((l) => l.length <= 78));
  assert.match(await sim.out('man 8 ping'), /^PING\(8\) +System Manager's Manual +PING\(8\)\n/);
  assert.match(await sim.out('man 1 ls'), /^LS\(1\)/);
  assert.equal(await sim.out('man -w ls'), '/usr/share/man/man1/ls.1.gz\n');
  // on a terminal the page goes through the pager, with bold headings
  sim.term.take();
  await sim.run('man whoami', { tty: true });
  assert.ok(sim.term.take().includes('\x1b[1mNAME\x1b[22m'));
});

test('man: errors and options', async () => {
  const sim = await sys();
  const none = await sim.run('man nosuchpage');
  assert.equal(none.code, 16);
  assert.equal(none.err, "No manual entry for nosuchpage\nSee 'man 7 undocumented' for help when manual pages are not available.\n");
  assert.equal((await sim.run('man 5 ls')).err, "No manual entry for ls in section 5\nSee 'man 7 undocumented' for help when manual pages are not available.\n");
  const bare = await sim.run('man');
  assert.equal(bare.code, 1);
  assert.equal(bare.err, "What manual page do you want?\nFor example, try 'man man'.\n");
  assert.match(await sim.out('man --help'), /^Usage: man \[OPTION\.\.\.\] \[SECTION\] PAGE\.\.\./);
  assert.match(await sim.out('man -V'), /^man \d/);
  assert.match(await sim.out('man man'), /\nNAME\n {7}man - an interface to the system reference manuals\n/);
});

test('whatis, apropos, man -k and -f', async () => {
  const sim = await sys();
  assert.equal(await sim.out('whatis ls'), 'ls (1)               - list directory contents\n');
  assert.equal(await sim.out('man -f whoami'), 'whoami (1)           - print effective user name\n');
  const miss = await sim.run('whatis nosuch');
  assert.equal(miss.code, 16);
  assert.equal(miss.err, 'nosuch: nothing appropriate.\n');
  assert.match(await sim.out('apropos "kernel ring"'), /^dmesg \(1\) +- print or control the kernel ring buffer\n$/);
  assert.equal(await sim.out('man -k "kernel ring"'), await sim.out('apropos "kernel ring"'));
  const lines = (await sim.out('apropos process')).split('\n').filter(Boolean);
  assert.ok(lines.length > 2 && lines.every((l) => /^\S+ \(\d\) +- /.test(l)));
  assert.deepEqual(lines.map((l) => l.split(' ')[0]), lines.map((l) => l.split(' ')[0]).slice().sort());
  assert.equal((await sim.run('apropos zzzqqq')).err, 'zzzqqq: nothing appropriate.\n');
  assert.equal((await sim.run('apropos zzzqqq')).code, 16);
  assert.equal(await sim.out('apropos -e whoami'), 'whoami (1)           - print effective user name\n');
  assert.equal((await sim.run('apropos')).err, 'apropos what?\n');
});

test('whereis and info', async () => {
  const sim = await sys();
  assert.equal(await sim.out('whereis ls'), 'ls: /usr/bin/ls /usr/share/man/man1/ls.1.gz\n');
  assert.equal(await sim.out('whereis -b ls'), 'ls: /usr/bin/ls\n');
  assert.equal(await sim.out('whereis -m ls'), 'ls: /usr/share/man/man1/ls.1.gz\n');
  assert.equal(await sim.out('whereis nosuchcmd'), 'nosuchcmd:\n');
  assert.equal((await sim.run('whereis')).err, 'whereis: no names specified\n');
  assert.match(await sim.out('info ls'), /^LS\(1\)/);
  const bad = await sim.run('info nosuchthing');
  assert.equal(bad.code, 1);
  assert.equal(bad.err, "info: No menu item 'nosuchthing' in node '(dir)Top'.\n");
});
