/* Kalima — system pack: identity, system information, processes, services,
 * logs and manual pages.
 *
 * Machine state this pack owns. Other packs read it, so these shapes are fixed:
 *
 * machine.units — systemd units
 *   { name: 'ssh.service', desc: 'OpenBSD Secure Shell server',
 *     active: 'active' | 'inactive' | 'failed',
 *     sub: 'running' | 'dead' | 'exited' | 'failed',
 *     enabled: true | false | 'static',
 *     pid: main PID or null, since: ms of the last state change or null,
 *     prog: 'sshd',                    // program that owns the unit's sockets
 *     ports: [{ port, proto, addr, name, product, version, banner, handler, http(request) }] }
 *   K.net.listening() reports the ports of active units, so starting a unit
 *   opens them. Change unit state through K.sys.startUnit(machine, name) and
 *   K.sys.stopUnit(machine, name) so processes and the journal stay in step;
 *   K.sys.unit(machine, name) finds a unit ('ssh', 'ssh.service', 'sshd').
 *
 * machine.procs — processes seeded here carry extra optional fields used by ps
 *   and top: vsz and rss (KiB), time (CPU seconds), unit (owning unit name),
 *   comm (short name, when it differs from the basename of the command).
 *
 * machine.state.journal — [{ ts, ident, pid, msg, facility, prio (0-7), unit }]
 *   K.syslog(machine, { ident, pid, msg, facility: 'auth'|'daemon'|'kern'|'cron'|'user',
 *                       prio: 'info', ts, unit })
 *   appends a record and the matching /var/log line: auth -> auth.log,
 *   kern -> kern.log and syslog, everything else -> syslog.
 *
 * machine.state.logins — [{ user, tty, host, at }] sessions listed by who, w and last.
 */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;
  const SEC = 1000; const MIN = 60 * SEC; const HOUR = 60 * MIN; const DAY = 24 * HOUR;

  const COREUTILS = '9.7';
  function coreutilsVersion(name, authors) {
    return name + ' (GNU coreutils) ' + COREUTILS + '\nCopyright (C) 2025 Free Software Foundation, Inc.\n' +
      'License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\n' +
      'This is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by ' + authors + '.\n';
  }
  function coreutilsHelp(name, body) {
    return body + '\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\n' +
      'Report any translation bugs to <https://translationproject.org/team/>\n' +
      'Full documentation <https://www.gnu.org/software/coreutils/' + name + '>\n' +
      "or available locally via: info '(coreutils) " + name + " invocation'\n";
  }
  /** GNU-style usage error: "name: msg" plus the "Try --help" hint, exit status 1 unless given. */
  function usageError(ctx, msg, code) {
    ctx.err(ctx.name + ': ' + msg + "\nTry '" + ctx.name + " --help' for more information.\n");
    return code == null ? 1 : code;
  }

  /* ================================================================ journal */

  const PRIORITIES = { emerg: 0, alert: 1, crit: 2, err: 3, error: 3, warning: 4, warn: 4, notice: 5, info: 6, debug: 7 };
  const JOURNAL_LIMIT = 6000;
  const LOG_FILE_MODE = { mode: 0o640, uid: 0, gid: 4 }; // root:adm, as rsyslog creates them

  function priority(p) {
    if (typeof p === 'number') return U.clamp(p | 0, 0, 7);
    const n = PRIORITIES[String(p == null ? 'info' : p).toLowerCase()];
    return n == null ? 6 : n;
  }
  function journalOf(machine) { return machine.state.journal || (machine.state.journal = []); }
  function logFilesFor(facility) {
    if (facility === 'auth' || facility === 'authpriv') return ['/var/log/auth.log'];
    if (facility === 'kern') return ['/var/log/kern.log', '/var/log/syslog'];
    return ['/var/log/syslog'];
  }
  /** Seconds since boot as the kernel prints them: "[    3.102880]". */
  function kernelStamp(rec) {
    const mono = rec.mono != null ? rec.mono : Math.max(0, (rec.ts - K.getBootTime()) / 1000);
    return '[' + U.padStart(mono.toFixed(6), 12) + ']';
  }
  /** One record as rsyslog writes it. sudo and the kernel log without a PID. */
  function syslogLine(machine, rec) {
    const kernel = rec.facility === 'kern' && rec.ident === 'kernel';
    const tag = rec.ident + (rec.pid != null && rec.ident !== 'sudo' && !kernel ? '[' + rec.pid + ']' : '');
    return U.syslogDate(rec.ts) + ' ' + machine.hostname + ' ' + tag + ': ' + (kernel ? kernelStamp(rec) + ' ' : '') + rec.msg;
  }
  function appendLog(machine, path, text) {
    const fs = machine.vfs;
    try {
      if (!fs.exists(path)) { if (!fs.exists('/var/log')) return; fs.seed(path, '', LOG_FILE_MODE); }
      fs.write(path, text, { append: true });
    } catch (e) { /* a log the learner replaced with a directory: rsyslog would complain, we stay quiet */ }
  }

  K.syslog = function (machine, entry) {
    const rec = {
      ts: entry.ts == null ? K.clock.now() : entry.ts,
      ident: entry.ident || 'unknown',
      pid: entry.pid == null ? null : entry.pid,
      msg: String(entry.msg == null ? '' : entry.msg),
      facility: entry.facility || 'user',
      prio: priority(entry.prio != null ? entry.prio : entry.severity),
      unit: entry.unit || unitOfIdent(machine, entry.ident),
    };
    if (entry.mono != null) rec.mono = entry.mono;
    const journal = journalOf(machine);
    journal.push(rec);
    if (journal.length > JOURNAL_LIMIT) journal.splice(0, journal.length - JOURNAL_LIMIT);
    const line = syslogLine(machine, rec) + '\n';
    for (const file of logFilesFor(rec.facility)) appendLog(machine, file, line);
    return rec;
  };

  /** The unit a daemon's log lines belong to, so `journalctl -u` finds them. */
  function unitOfIdent(machine, ident) {
    if (!ident) return null;
    const name = String(ident).toLowerCase().replace(/-session$/, '');
    const u = (machine.units || []).find((x) => x.prog.toLowerCase() === name || x.name.toLowerCase() === name + '.service');
    return u ? u.name : null;
  }

  /* ================================================================== units */

  const MEM_TOTAL_KB = 4026392; // MemTotal in /proc/meminfo
  const memPercent = (rssKb) => Math.round(rssKb / MEM_TOTAL_KB * 1000) / 10;

  /** proc(cmd, {user, rss, vsz, stat, tty, child}) — child processes hang off the unit's main PID. */
  const proc = (cmd, o) => Object.assign({ cmd, user: 'root', rss: 4200, vsz: 16800, stat: 'Ss', tty: '?', child: false }, o);

  function makeUnit(name, desc, o) {
    return Object.assign({
      name, desc, active: 'inactive', sub: 'dead', enabled: false, pid: null, since: null,
      prog: name.replace(/\.service$/, ''), ports: [],
      exec: [], docs: [], preset: 'enabled', type: 'simple', wants: [], aliases: [], boot: null, log: [],
    }, o);
  }
  const tcp = (port, name, o) => Object.assign({ port, proto: 'tcp', addr: '0.0.0.0', name }, o);

  const SSHD_LISTENER = 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups';
  const APACHE_VERSION = '2.4.65';
  const APACHE_SERVER = 'Apache/' + APACHE_VERSION + ' (Debian)';
  const NGINX_VERSION = '1.28.0';
  const PG_VERSION = '17';
  const PG_BIN = '/usr/lib/postgresql/' + PG_VERSION + '/bin/postgres';
  const pgCluster = (v) => [
    proc('/usr/lib/postgresql/' + v + '/bin/postgres -D /var/lib/postgresql/' + v + '/main -c config_file=/etc/postgresql/' + v + '/main/postgresql.conf', { user: 'postgres', rss: 31240, vsz: 224488 }),
    proc('postgres: ' + v + '/main: checkpointer ', { user: 'postgres', rss: 7320, vsz: 224620, child: true }),
    proc('postgres: ' + v + '/main: background writer ', { user: 'postgres', rss: 6180, vsz: 224488, child: true }),
    proc('postgres: ' + v + '/main: walwriter ', { user: 'postgres', rss: 9870, vsz: 224488, child: true }),
    proc('postgres: ' + v + '/main: autovacuum launcher ', { user: 'postgres', rss: 8540, vsz: 226052, child: true }),
  ];

  /** Units every Debian-family machine runs. `boot` is the start offset in seconds for units active after boot. */
  function baseUnits() {
    return [
      makeUnit('systemd-journald.service', 'Journal Service', { enabled: 'static', boot: 1.92, prog: 'systemd-journald',
        docs: ['man:systemd-journald.service(8)', 'man:journald.conf(5)'], exec: [proc('/usr/lib/systemd/systemd-journald', { rss: 20112, vsz: 66744 })] }),
      makeUnit('systemd-udevd.service', 'Rule-based Manager for Device Events and Files', { enabled: 'static', boot: 2.31, prog: 'systemd-udevd',
        docs: ['man:systemd-udevd.service(8)', 'man:udev(7)'], exec: [proc('/usr/lib/systemd/systemd-udevd', { rss: 9240, vsz: 36420 })] }),
      makeUnit('systemd-timesyncd.service', 'Network Time Synchronization', { enabled: true, boot: 3.84, prog: 'systemd-timesyncd',
        docs: ['man:systemd-timesyncd.service(8)'], exec: [proc('/usr/lib/systemd/systemd-timesyncd', { user: 'systemd-timesync', rss: 7480, vsz: 91044, stat: 'Ssl' })] }),
      makeUnit('dbus.service', 'D-Bus System Message Bus', { enabled: 'static', boot: 4.62, prog: 'dbus-daemon', docs: ['man:dbus-daemon(1)'],
        exec: [proc('/usr/bin/dbus-daemon --system --address=systemd: --nofork --nopidfile --systemd-activation --syslog-only', { user: 'messagebus', rss: 5456, vsz: 9872 })] }),
      makeUnit('systemd-logind.service', 'User Login Management', { enabled: 'static', boot: 4.71, prog: 'systemd-logind',
        docs: ['man:sd-login(3)', 'man:systemd-logind.service(8)', 'man:logind.conf(5)'], exec: [proc('/usr/lib/systemd/systemd-logind', { rss: 8732, vsz: 18420 })] }),
      makeUnit('rsyslog.service', 'System Logging Service', { enabled: true, boot: 4.78, prog: 'rsyslogd',
        docs: ['man:rsyslogd(8)', 'man:rsyslog.conf(5)', 'https://www.rsyslog.com/doc/'], exec: [proc('/usr/sbin/rsyslogd -n -iNONE', { rss: 6400, vsz: 222508, stat: 'Ssl' })],
        log: ['[origin software="rsyslogd" swVersion="8.2504.0" x-pid="$PID" x-info="https://www.rsyslog.com"] start'] }),
      makeUnit('cron.service', 'Regular background program processing daemon', { enabled: true, boot: 4.83, docs: ['man:cron(8)'],
        exec: [proc('/usr/sbin/cron -f', { rss: 2740, vsz: 6692 })], log: ['(CRON) INFO (pidfile fd = 3)', '(CRON) INFO (Running @reboot jobs)'] }),
      makeUnit('networking.service', 'Raise network interfaces', { enabled: true, boot: 3.27, type: 'oneshot', docs: ['man:interfaces(5)'] }),
      makeUnit('systemd-modules-load.service', 'Load Kernel Modules', { enabled: 'static', boot: 1.98, type: 'oneshot', docs: ['man:systemd-modules-load.service(8)', 'man:modules-load.d(5)'] }),
      makeUnit('systemd-remount-fs.service', 'Remount Root and Kernel File Systems', { enabled: 'static', boot: 2.02, type: 'oneshot', docs: ['man:systemd-remount-fs.service(8)'] }),
      makeUnit('systemd-sysctl.service', 'Apply Kernel Variables', { enabled: 'static', boot: 2.11, type: 'oneshot', docs: ['man:systemd-sysctl.service(8)', 'man:sysctl.d(5)'] }),
      makeUnit('systemd-random-seed.service', 'Load/Save OS Random Seed', { enabled: 'static', boot: 2.24, type: 'oneshot', docs: ['man:systemd-random-seed.service(8)', 'man:random(4)'] }),
      makeUnit('systemd-tmpfiles-setup.service', 'Create System Files and Directories', { enabled: 'static', boot: 2.87, type: 'oneshot', docs: ['man:tmpfiles.d(5)', 'man:systemd-tmpfiles(8)'] }),
      makeUnit('systemd-user-sessions.service', 'Permit User Sessions', { enabled: 'static', boot: 5.02, type: 'oneshot', docs: ['man:systemd-user-sessions.service(8)'] }),
      makeUnit('getty@tty1.service', 'Getty on tty1', { enabled: true, boot: 5.31, prog: 'agetty', docs: ['man:agetty(8)', 'man:systemd-getty-generator(8)'],
        exec: [proc('/sbin/agetty -o -- \\u --noreset --noclear - linux', { rss: 1924, vsz: 5880, tty: 'tty1', stat: 'Ss+' })] }),
    ];
  }

  function kaliUnits(machine) {
    const u = baseUnits();
    u.push(
      makeUnit('polkit.service', 'Authorization Manager', { enabled: 'static', boot: 4.66, prog: 'polkitd', docs: ['man:polkit(8)'],
        exec: [proc('/usr/lib/polkit-1/polkitd --no-debug --log-level=notice', { user: 'polkitd', rss: 9160, vsz: 307452, stat: 'Ssl' })] }),
      makeUnit('NetworkManager.service', 'Network Manager', { enabled: true, boot: 4.92, docs: ['man:NetworkManager(8)'],
        exec: [proc('/usr/sbin/NetworkManager --no-daemon', { rss: 21944, vsz: 342128, stat: 'Ssl' })] }),
      makeUnit('udisks2.service', 'Disk Manager', { enabled: true, boot: 5.12, prog: 'udisksd', docs: ['man:udisks(8)'],
        exec: [proc('/usr/libexec/udisks2/udisksd', { rss: 13412, vsz: 469204, stat: 'Ssl' })] }),
      makeUnit('lightdm.service', 'Light Display Manager', { enabled: true, boot: 5.44, docs: ['man:lightdm(1)'], exec: [
        proc('/usr/sbin/lightdm', { rss: 8520, vsz: 309840, stat: 'Ssl' }),
        proc('/usr/lib/xorg/Xorg :0 -seat seat0 -auth /var/run/lightdm/root/:0 -nolisten tcp vt7 -novtswitch', { rss: 118320, vsz: 421776, tty: 'tty7', stat: 'Ssl+', child: true, cpu: 1.2, time: 142 }),
        proc('lightdm --session-child 13 24', { rss: 7676, vsz: 164752, stat: 'Sl', child: true, key: 'session-child' }),
      ] }),
      makeUnit('rtkit-daemon.service', 'RealtimeKit Scheduling Policy Service', { enabled: true, boot: 6.97, docs: [],
        exec: [proc('/usr/libexec/rtkit-daemon', { user: 'rtkit', rss: 3188, vsz: 22940, stat: 'SNsl' })] }),
      makeUnit('upower.service', 'Daemon for power management', { enabled: true, boot: 7.38, prog: 'upowerd', docs: ['man:upowerd(8)'],
        exec: [proc('/usr/libexec/upowerd', { rss: 9044, vsz: 316388, stat: 'Ssl' })] }),
      makeUnit('user@1000.service', 'User Manager for UID 1000', { enabled: 'static', boot: 41.2, prog: 'systemd', docs: ['man:user@.service(5)'], exec: [
        proc('/usr/lib/systemd/systemd --user', { user: 'kali', rss: 12192, vsz: 21604, key: 'user-systemd' }),
        proc('(sd-pam)', { user: 'kali', rss: 3764, vsz: 23548, stat: 'S', child: true }),
      ] }),

      // Kali ships network services switched off: the learner starts them when needed.
      makeUnit('ssh.service', 'OpenBSD Secure Shell server', { preset: 'disabled', prog: 'sshd', aliases: ['sshd.service'],
        docs: ['man:sshd(8)', 'man:sshd_config(5)'], pre: '/usr/sbin/sshd -t', exec: [proc(SSHD_LISTENER, { rss: 7960, vsz: 11780 })],
        log: ['Server listening on 0.0.0.0 port 22.', 'Server listening on :: port 22.'],
        ports: [tcp(22, 'ssh', { product: 'OpenSSH', version: '10.0p2 Debian 7', banner: 'SSH-2.0-OpenSSH_10.0p2 Debian-7', handler: 'ssh' })] }),
      makeUnit('apache2.service', 'The Apache HTTP Server', { preset: 'disabled', type: 'forking', docs: ['https://httpd.apache.org/docs/2.4/'], pre: '/usr/sbin/apachectl start', exec: [
        proc('/usr/sbin/apache2 -k start', { rss: 5320, vsz: 6884 }),
        proc('/usr/sbin/apache2 -k start', { user: 'www-data', rss: 4476, vsz: 1998344, stat: 'Sl', child: true }),
        proc('/usr/sbin/apache2 -k start', { user: 'www-data', rss: 4476, vsz: 1998344, stat: 'Sl', child: true }),
      ], ports: [tcp(80, 'http', { product: 'Apache httpd', version: APACHE_VERSION + ' ((Debian))', handler: 'http', http: staticSite(machine, 'apache') })] }),
      makeUnit('nginx.service', 'A high performance web server and a reverse proxy server', { preset: 'disabled', type: 'forking', docs: ['man:nginx(8)'],
        pre: "/usr/sbin/nginx -t -q -g 'daemon on; master_process on;'", exec: [
          proc('nginx: master process /usr/sbin/nginx -g daemon on; master_process on;', { rss: 1820, vsz: 11208 }),
          proc('nginx: worker process', { user: 'www-data', rss: 4640, vsz: 12968, stat: 'S', child: true }),
          proc('nginx: worker process', { user: 'www-data', rss: 4640, vsz: 12968, stat: 'S', child: true }),
        ], ports: [tcp(80, 'http', { product: 'nginx', version: NGINX_VERSION, handler: 'http', http: staticSite(machine, 'nginx') })] }),
      // Debian's postgresql.service is an umbrella that only pulls in the cluster unit.
      makeUnit('postgresql.service', 'PostgreSQL RDBMS', { preset: 'disabled', type: 'oneshot', prog: 'postgres', wants: ['postgresql@' + PG_VERSION + '-main.service'],
        ports: [tcp(5432, 'postgresql', { addr: '127.0.0.1', product: 'PostgreSQL DB', version: PG_VERSION + '.6', handler: 'generic' })] }),
      makeUnit('postgresql@' + PG_VERSION + '-main.service', 'PostgreSQL Cluster ' + PG_VERSION + '-main', { enabled: 'static', type: 'forking', prog: 'postgres', instance: true,
        pre: '/usr/bin/pg_ctlcluster --skip-systemctl-redirect ' + PG_VERSION + '-main start', exec: pgCluster(PG_VERSION) }),
      makeUnit('mariadb.service', 'MariaDB 11.8.3 database server', { preset: 'disabled', prog: 'mariadbd', docs: ['man:mariadbd(8)', 'https://mariadb.com/kb/en/library/systemd/'],
        exec: [proc('/usr/sbin/mariadbd', { user: 'mysql', rss: 108244, vsz: 1387452, stat: 'Ssl' })],
        ports: [tcp(3306, 'mysql', { addr: '127.0.0.1', product: 'MariaDB', version: '11.8.3', handler: 'generic' })] }),
      makeUnit('smbd.service', 'Samba SMB Daemon', { preset: 'disabled', docs: ['man:smbd(8)', 'man:samba(7)', 'man:smb.conf(5)'], exec: [
        proc('/usr/sbin/smbd --foreground --no-process-group', { rss: 23104, vsz: 81044 }),
        proc('/usr/sbin/smbd --foreground --no-process-group', { rss: 11260, vsz: 79012, stat: 'S', child: true }),
      ], ports: [tcp(139, 'netbios-ssn', { product: 'Samba smbd', version: '4' }), tcp(445, 'microsoft-ds', { product: 'Samba smbd', version: '4' })] }),
    );
    return u;
  }

  /** Daemons behind the services a lab server exposes, keyed by a test on the world's service record. */
  const SERVER_DAEMONS = [
    { match: (s) => /OpenSSH/.test(s.product), unit: () => makeUnit('ssh.service', 'OpenBSD Secure Shell server', { enabled: true, prog: 'sshd', aliases: ['sshd.service'],
      docs: ['man:sshd(8)', 'man:sshd_config(5)'], pre: '/usr/sbin/sshd -t', exec: [proc(SSHD_LISTENER, { rss: 7960, vsz: 11780 })],
      log: ['Server listening on 0.0.0.0 port 22.', 'Server listening on :: port 22.'] }) },
    { match: (s) => /nginx/i.test(s.product), unit: () => makeUnit('nginx.service', 'A high performance web server and a reverse proxy server', { enabled: true, type: 'forking', docs: ['man:nginx(8)'],
      pre: "/usr/sbin/nginx -t -q -g 'daemon on; master_process on;'", exec: [
        proc('nginx: master process /usr/sbin/nginx -g daemon on; master_process on;', { rss: 1820, vsz: 11208 }),
        proc('nginx: worker process', { user: 'www-data', rss: 5964, vsz: 12968, stat: 'S', child: true }),
        proc('nginx: worker process', { user: 'www-data', rss: 5104, vsz: 12968, stat: 'S', child: true }),
      ] }) },
    { match: (s) => /vsftpd/i.test(s.product), unit: () => makeUnit('vsftpd.service', 'vsftpd FTP server', { enabled: true,
      exec: [proc('/usr/sbin/vsftpd /etc/vsftpd.conf', { rss: 3284, vsz: 8256 })] }) },
    { match: (s) => s.name === 'rpcbind' && s.proto === 'tcp', unit: () => makeUnit('rpcbind.service', 'RPC bind portmap service', { enabled: true, docs: ['man:rpcbind(8)'],
      exec: [proc('/sbin/rpcbind -f -w', { user: '_rpc', rss: 3720, vsz: 7968 })] }) },
    { match: (s) => /Samba smbd/.test(s.product), unit: () => makeUnit('smbd.service', 'Samba SMB Daemon', { enabled: true, docs: ['man:smbd(8)', 'man:samba(7)', 'man:smb.conf(5)'], exec: [
      proc('/usr/sbin/smbd --foreground --no-process-group', { rss: 23104, vsz: 81044 }),
      proc('/usr/sbin/smbd --foreground --no-process-group', { rss: 11260, vsz: 79012, stat: 'S', child: true }),
    ] }) },
    { match: (s) => /Samba nmbd/.test(s.product), unit: () => makeUnit('nmbd.service', 'Samba NMB Daemon', { enabled: true, docs: ['man:nmbd(8)', 'man:samba(7)', 'man:smb.conf(5)'],
      exec: [proc('/usr/sbin/nmbd --foreground --no-process-group', { rss: 9488, vsz: 71860 })] }) },
    { match: (s) => s.name === 'nfs', unit: () => makeUnit('nfs-server.service', 'NFS server and services', { enabled: true, type: 'oneshot', prog: 'nfsd', wants: ['nfs-mountd.service'] }) },
    { match: (s) => s.name === 'nfs', unit: () => makeUnit('nfs-mountd.service', 'NFS Mount Daemon', { enabled: 'static', prog: 'rpc.mountd', ports: null,
      exec: [proc('/usr/sbin/rpc.mountd', { rss: 5148, vsz: 43516 })] }) },
    { match: (s) => /MariaDB|MySQL/.test(s.product), unit: (s) => makeUnit('mariadb.service', 'MariaDB ' + (s.version || '11.8.3') + ' database server', { enabled: true, prog: 'mariadbd',
      docs: ['man:mariadbd(8)', 'https://mariadb.com/kb/en/library/systemd/'], exec: [proc('/usr/sbin/mariadbd', { user: 'mysql', rss: 108244, vsz: 1387452, stat: 'Ssl' })] }) },
    { match: (s) => s.name === 'postgresql', unit: () => makeUnit('postgresql@16-main.service', 'PostgreSQL Cluster 16-main', { enabled: 'static', type: 'forking', prog: 'postgres', exec: pgCluster('16') }) },
    { match: (s) => /Express|Node\.js/.test(s.product), unit: () => makeUnit('shipment-tracker.service', 'Shipment Tracker (development build)', { enabled: true, prog: 'node',
      exec: [proc('/usr/bin/node /home/student/projects/shipment-tracker/server.js', { user: 'student', rss: 58112, vsz: 1024736, stat: 'Ssl' })] }) },
    { match: (s) => /Jetty|Jenkins/.test(s.product), unit: () => makeUnit('jenkins.service', 'Jenkins Continuous Integration Server', { enabled: true, prog: 'java',
      exec: [proc('/usr/bin/java -Djava.awt.headless=true -jar /usr/share/java/jenkins.war --webroot=/var/cache/jenkins/war --httpPort=8080', { user: 'jenkins', rss: 612480, vsz: 3608212, stat: 'Ssl', cpu: 0.4, time: 96 })] }) },
  ];

  function serverUnits(machine) {
    const units = baseUnits();
    const host = K.net && K.net.world ? K.net.hostById(machine.hostId) : null;
    for (const svc of (host && host.services) || []) {
      for (const d of SERVER_DAEMONS) {
        if (!d.match(svc)) continue;
        const fresh = d.unit(svc);
        let unit = units.find((u) => u.name === fresh.name);
        if (!unit) { unit = fresh; unit.boot = 5.6 + units.length * 0.07; units.push(unit); }
        if (unit.ports) unit.ports.push({ port: svc.port, proto: svc.proto || 'tcp', addr: '0.0.0.0', name: svc.name, product: svc.product, version: svc.version, banner: svc.banner, handler: svc.handler });
      }
    }
    for (const u of units) if (!u.ports) u.ports = [];
    return units;
  }

  /* ---------------------------------------------------- unit state changes */

  const unitFile = (u) => '/usr/lib/systemd/system/' + (u.instance ? u.name.replace(/@[^.]*\./, '@.') : u.name);

  function findUnit(machine, name) {
    if (!name) return null;
    const full = /\.[a-z]+$/.test(name) ? name : name + '.service';
    return machine.units.find((u) => u.name === full || u.aliases.indexOf(full) >= 0) || null;
  }

  const systemdLog = (machine, unit, msg, ts) => K.syslog(machine, { ident: 'systemd', pid: 1, facility: 'daemon', msg, unit: unit.name, ts });

  /** Is another process already bound to one of the unit's ports? Returns the clashing port or null. */
  function portClash(machine, unit) {
    const busy = K.net && K.net.listening ? K.net.listening(machine) : [];
    for (const p of unit.ports) {
      if (busy.some((l) => l.unit !== unit.name && l.port === p.port && (l.proto || 'tcp') === p.proto)) return p;
    }
    return null;
  }

  function spawnUnit(machine, unit, spawn, at) {
    let main = null;
    for (const t of unit.exec) {
      const p = spawn({
        ppid: t.child && main ? main.pid : 1, user: t.user, tty: t.tty, stat: t.stat, cmd: t.cmd, start: at,
        cpu: t.cpu || 0, mem: memPercent(t.rss), rss: t.rss, vsz: t.vsz, time: t.time || 0, unit: unit.name,
      });
      if (t.key) machine.state.pids[t.key] = p.pid;
      if (!main) main = p;
    }
    return main;
  }

  /**
   * Bring a unit up. Returns { ok } or { ok: false, reason }. Units it wants start first.
   * `o.spawn` and `o.at` let the boot sequence place processes in the past.
   */
  function startUnit(machine, name, o) {
    o = o || {};
    const unit = typeof name === 'string' ? findUnit(machine, name) : name;
    if (!unit) return { ok: false, reason: 'not-found' };
    if (unit.active === 'active') return { ok: true, unit };
    const at = o.at == null ? K.clock.now() : o.at;
    const label = unit.name + ' - ' + unit.desc;
    systemdLog(machine, unit, 'Starting ' + label + '...', at);
    const clash = portClash(machine, unit);
    if (clash) {
      const addr = clash.addr + ':' + clash.port;
      K.syslog(machine, { ident: unit.prog, pid: machine.nextPid(), facility: 'daemon', prio: 'err', unit: unit.name, ts: at,
        msg: 'bind() to ' + addr + ' failed (98: Address already in use): could not bind to address ' + addr });
      systemdLog(machine, unit, unit.name + ': Control process exited, code=exited, status=1/FAILURE', at);
      systemdLog(machine, unit, unit.name + ": Failed with result 'exit-code'.", at);
      systemdLog(machine, unit, 'Failed to start ' + label + '.', at);
      Object.assign(unit, { active: 'failed', sub: 'failed', pid: null, since: at });
      return { ok: false, reason: 'failed', unit };
    }
    for (const w of unit.wants) startUnit(machine, w, o);
    const main = spawnUnit(machine, unit, o.spawn || ((p) => machine.spawn(p)), at);
    const oneshot = unit.type === 'oneshot';
    // An umbrella unit reports the PID that owns its sockets: the wanted unit's daemon.
    const owner = main || unit.wants.map((w) => findUnit(machine, w)).find((w) => w && w.pid);
    Object.assign(unit, { active: 'active', sub: oneshot ? 'exited' : 'running', pid: main ? main.pid : owner ? owner.pid : null, since: at });
    unit.invocation = U.hash32(unit.name + ':' + at).toString(16).padStart(8, '0') + U.hash32(at + ':' + unit.name).toString(16).padStart(8, '0') +
      U.hash32('i' + unit.name + at).toString(16).padStart(8, '0') + U.hash32('j' + at + unit.name).toString(16).padStart(8, '0');
    unit.execPid = oneshot || unit.pre ? (o.execPid ? o.execPid() : machine.nextPid()) : null;
    for (const msg of unit.log) K.syslog(machine, { ident: unit.prog, pid: unit.pid, facility: 'daemon', unit: unit.name, ts: at, msg: msg.replace('$PID', unit.pid) });
    systemdLog(machine, unit, (oneshot ? 'Finished ' : 'Started ') + label + '.', at);
    return { ok: true, unit };
  }

  function stopUnit(machine, name) {
    const unit = typeof name === 'string' ? findUnit(machine, name) : name;
    if (!unit) return { ok: false, reason: 'not-found' };
    const wasUp = unit.active === 'active';
    const label = unit.name + ' - ' + unit.desc;
    if (wasUp) systemdLog(machine, unit, 'Stopping ' + label + '...');
    for (const p of machine.procs.filter((x) => x.unit === unit.name)) machine.reap(p.pid);
    for (const w of unit.wants) stopUnit(machine, w);
    Object.assign(unit, { active: 'inactive', sub: 'dead', pid: null, since: wasUp || unit.since ? K.clock.now() : null });
    if (wasUp) {
      systemdLog(machine, unit, unit.name + ': Deactivated successfully.');
      systemdLog(machine, unit, 'Stopped ' + label + '.');
    }
    return { ok: true, unit };
  }

  // The shell's kill builtin reports the processes it removes; a unit whose main process dies goes down with it.
  K.events.on('proc-killed', (e) => {
    const unit = e.proc && e.proc.unit && e.machine.units.find((u) => u.name === e.proc.unit);
    if (!unit || unit.pid !== e.proc.pid) return;
    for (const p of e.machine.procs.filter((x) => x.unit === unit.name)) e.machine.reap(p.pid);
    const killed = e.signal === 'KILL';
    if (killed) {
      systemdLog(e.machine, unit, unit.name + ': Main process exited, code=killed, status=9/KILL');
      systemdLog(e.machine, unit, unit.name + ": Failed with result 'signal'.");
    } else systemdLog(e.machine, unit, unit.name + ': Deactivated successfully.');
    Object.assign(unit, { active: killed ? 'failed' : 'inactive', sub: killed ? 'failed' : 'dead', pid: null, since: K.clock.now(), result: killed ? 'signal' : null });
  });

  K.sys = { unit: findUnit, startUnit, stopUnit };

  /* =========================================================== web servers */

  const MIME = { html: 'text/html', htm: 'text/html', txt: 'text/plain', css: 'text/css', js: 'text/javascript', json: 'application/json', xml: 'application/xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/vnd.microsoft.icon', pdf: 'application/pdf',
    zip: 'application/zip', gz: 'application/gzip', sh: 'text/x-sh', php: 'text/html', md: 'text/markdown', csv: 'text/csv' };
  const DOCROOT = '/var/www/html';
  const WWW_CRED = { uid: 33, gid: 33, groups: [33], name: 'www-data' };
  const htmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const WEB_FLAVORS = {
    apache: {
      server: APACHE_SERVER, index: ['index.html', 'index.cgi', 'index.pl', 'index.php', 'index.xhtml', 'index.htm'], accessLog: '/var/log/apache2/access.log',
      error(status, title, text, request) {
        return { status, type: 'text/html; charset=iso-8859-1', body: '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>' + status + ' ' + title + '</title>\n</head><body>\n<h1>' + title +
          '</h1>\n<p>' + text + '</p>\n<hr>\n<address>' + APACHE_SERVER + ' Server at ' + request.host + ' Port ' + request.port + '</address>\n</body></html>\n' };
      },
      messages: { 301: (loc) => 'The document has moved <a href="' + loc + '">here</a>.', 403: "You don't have permission to access this resource.", 404: 'The requested URL was not found on this server.',
        405: (m) => 'The requested method ' + m + ' is not allowed for this URL.' },
      listing(machine, dir, urlPath, request) {
        const rows = machine.vfs.readdir(dir).filter((n) => n[0] !== '.').map((n) => {
          const st = machine.vfs.stat(dir + '/' + n);
          const ext = n.indexOf('.') > 0 ? n.split('.').pop().toLowerCase() : '';
          const icon = st.isDir ? ['folder.gif', 'DIR'] : /^(png|jpe?g|gif|svg|ico)$/.test(ext) ? ['image2.gif', 'IMG'] : /^(txt|html?|css|js|md|csv|sh|conf|log)$/.test(ext) ? ['text.gif', 'TXT'] : ['unknown.gif', '   '];
          const name = n + (st.isDir ? '/' : '');
          return '<tr><td valign="top"><img src="/icons/' + icon[0] + '" alt="[' + icon[1] + ']"></td><td><a href="' + encodeURI(name) + '">' + htmlEscape(name) + '</a></td><td align="right">' +
            U.isoDate(st.mtime).slice(0, 16) + '  </td><td align="right">' + (st.isDir ? '  - ' : U.padStart(U.humanSize(st.size), 3) + ' ') + '</td><td>&nbsp;</td></tr>\n';
        }).join('');
        const parent = urlPath === '/' ? '' : '<tr><td valign="top"><img src="/icons/back.gif" alt="[PARENTDIR]"></td><td><a href="' + urlPath.replace(/[^/]+\/$/, '') +
          '">Parent Directory</a></td><td>&nbsp;</td><td align="right">  - </td><td>&nbsp;</td></tr>\n';
        return { status: 200, type: 'text/html;charset=UTF-8', body: '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">\n<html>\n <head>\n  <title>Index of ' + htmlEscape(urlPath.replace(/(.)\/$/, '$1')) +
          '</title>\n </head>\n <body>\n<h1>Index of ' + htmlEscape(urlPath.replace(/(.)\/$/, '$1')) + '</h1>\n  <table>\n   <tr><th valign="top"><img src="/icons/blank.gif" alt="[ICO]"></th><th><a href="?C=N;O=D">Name</a></th>' +
          '<th><a href="?C=M;O=A">Last modified</a></th><th><a href="?C=S;O=A">Size</a></th><th><a href="?C=D;O=A">Description</a></th></tr>\n   <tr><th colspan="5"><hr></th></tr>\n' + parent + rows +
          '   <tr><th colspan="5"><hr></th></tr>\n</table>\n<address>' + APACHE_SERVER + ' Server at ' + request.host + ' Port ' + request.port + '</address>\n</body></html>\n' };
      },
    },
    nginx: {
      server: 'nginx/' + NGINX_VERSION, index: ['index.html', 'index.htm', 'index.nginx-debian.html'], accessLog: '/var/log/nginx/access.log',
      error(status, title) {
        return { status, type: 'text/html', body: '<html>\r\n<head><title>' + status + ' ' + title + '</title></head>\r\n<body>\r\n<center><h1>' + status + ' ' + title + '</h1></center>\r\n<hr><center>nginx/' + NGINX_VERSION + '</center>\r\n</body>\r\n</html>\r\n' };
      },
      messages: {},
      listing: null, // autoindex is off in Debian's default site: a directory without an index is 403
    },
  };
  const HTTP_TITLES = { 301: 'Moved Permanently', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed' };

  function clfDate(ms) {
    const d = new Date(ms);
    return U.pad2(d.getUTCDate()) + '/' + U.MONTHS[d.getUTCMonth()] + '/' + d.getUTCFullYear() + ':' + U.pad2(d.getUTCHours()) + ':' + U.pad2(d.getUTCMinutes()) + ':' + U.pad2(d.getUTCSeconds()) + ' +0000';
  }

  /** http(request) for a web server unit: serves /var/www/html from the machine's filesystem as www-data. */
  function staticSite(machine, flavorName) {
    const flavor = WEB_FLAVORS[flavorName];
    const fs = machine.vfs;
    const fail = (status, request, arg) => {
      const m = flavor.messages[status];
      return flavor.error(status, HTTP_TITLES[status], typeof m === 'function' ? m(arg) : m || '', request);
    };
    function respond(request) {
      if (!/^(GET|HEAD|POST|OPTIONS)$/.test(request.method)) return fail(405, request, request.method);
      let urlPath;
      try { urlPath = decodeURIComponent(request.path); } catch (e) { return fail(400, request); }
      const file = K.VFS.abs(DOCROOT + urlPath, '/');
      if (file !== DOCROOT && file.indexOf(DOCROOT + '/') !== 0) return fail(urlPath.indexOf('..') >= 0 ? 400 : 404, request);
      let st;
      try { st = fs.stat(file, { cred: WWW_CRED }); } catch (e) { return fail(e.code === 'EACCES' ? 403 : 404, request); }
      if (!st.isDir) return serveFile(file, st, request);
      if (!urlPath.endsWith('/')) {
        const loc = request.scheme + '://' + request.host + (request.port === 80 ? '' : ':' + request.port) + request.path + '/';
        return Object.assign(fail(301, request, loc), { headers: { location: loc } });
      }
      for (const name of flavor.index) {
        const idx = file + '/' + name;
        if (fs.exists(idx)) return serveFile(idx, fs.stat(idx), request);
      }
      if (!flavor.listing) return fail(403, request);
      try { return flavor.listing(machine, file, urlPath, request); } catch (e) { return fail(403, request); }
    }
    function serveFile(file, st, request) {
      let body;
      try { body = fs.read(file, { cred: WWW_CRED }); } catch (e) { return fail(403, request); }
      const ext = file.indexOf('.') >= 0 ? file.split('.').pop().toLowerCase() : '';
      const size = U.byteLen(body);
      return { status: 200, type: MIME[ext] || 'text/plain', body, headers: {
        'last-modified': new Date(st.mtime).toUTCString(), etag: '"' + size.toString(16) + '-' + U.hash32(file + st.mtime).toString(16) + '"', 'accept-ranges': 'bytes',
      } };
    }
    return function http(request) {
      const res = respond(request);
      res.headers = Object.assign({ server: flavor.server }, res.headers);
      const bytes = request.method === 'HEAD' ? 0 : U.byteLen(res.body || '');
      const query = request.query ? '?' + request.query : '';
      appendLog(machine, flavor.accessLog, (request.client || '127.0.0.1') + ' - - [' + clfDate(K.clock.now()) + '] "' + request.method + ' ' + request.path + query + ' HTTP/1.1" ' +
        res.status + ' ' + bytes + ' "' + (request.headers.referer || '-') + '" "' + (request.headers['user-agent'] || '-') + '"\n');
      return res;
    };
  }

  const APACHE_INDEX = [
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
    '<html xmlns="http://www.w3.org/1999/xhtml">',
    '  <head>',
    '    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />',
    '    <title>Apache2 Debian Default Page: It works</title>',
    '  </head>',
    '  <body>',
    '    <div class="main_page">',
    '      <div class="page_header floating_element">',
    '        <img src="/icons/openlogo-75.png" alt="Debian Logo" class="floating_element"/>',
    '        <span class="floating_element">',
    '          Apache2 Debian Default Page',
    '        </span>',
    '      </div>',
    '      <div class="content_section floating_element">',
    '        <div class="section_header section_header_red">',
    '          <div id="about"></div>',
    '          It works!',
    '        </div>',
    '        <div class="content_section_text">',
    '          <p>',
    '                This is the default welcome page used to test the correct',
    '                operation of the Apache2 server after installation on Debian systems.',
    '                If you can read this page, it means that the Apache HTTP server installed at',
    '                this site is working properly. You should <b>replace this file</b> (located at',
    '                <tt>/var/www/html/index.html</tt>) before continuing to operate your HTTP server.',
    '          </p>',
    '          <p>',
    '                If you are a normal user of this web site and don\'t know what this page is',
    '                about, this probably means that the site is currently unavailable due to',
    '                maintenance.',
    '                If the problem persists, please contact the site\'s administrator.',
    '          </p>',
    '        </div>',
    '        <div class="section_header">',
    '          <div id="docroot"></div>',
    '                Document Roots',
    '        </div>',
    '        <div class="content_section_text">',
    '            <p>',
    '                By default, Debian does not allow access through the web browser to',
    '                <em>any</em> file outside of those located in <tt>/var/www</tt>,',
    '                <a href="http://httpd.apache.org/docs/2.4/mod/mod_userdir.html" rel="nofollow">public_html</a>',
    '                directories (when enabled) and <tt>/usr/share</tt> (for web',
    '                applications). The default Debian document root is <tt>/var/www/html</tt>.',
    '            </p>',
    '        </div>',
    '      </div>',
    '    </div>',
    '    <div class="validator">',
    '    </div>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');

  const NGINX_INDEX = '<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to nginx!</title>\n<style>\nhtml { color-scheme: light dark; }\nbody { width: 35em; margin: 0 auto;\nfont-family: Tahoma, Verdana, Arial, sans-serif; }\n</style>\n</head>\n<body>\n' +
    '<h1>Welcome to nginx!</h1>\n<p>If you see this page, the nginx web server is successfully installed and\nworking. Further configuration is required.</p>\n\n<p>For online documentation and support please refer to\n' +
    '<a href="http://nginx.org/">nginx.org</a>.<br/>\nCommercial support is available at\n<a href="http://nginx.com/">nginx.com</a>.</p>\n\n<p><em>Thank you for using nginx.</em></p>\n</body>\n</html>\n';

  /* ======================================================== process tables */

  // [pid, name, state] — what a two-CPU VM shows shortly after boot.
  const KERNEL_THREADS = [
    [2, 'kthreadd', 'S'], [3, 'pool_workqueue_release', 'S'], [4, 'kworker/R-rcu_gp', 'I<'], [5, 'kworker/R-sync_wq', 'I<'],
    [6, 'kworker/R-kvfree_rcu_reclaim', 'I<'], [7, 'kworker/R-slub_flushwq', 'I<'], [8, 'kworker/R-netns', 'I<'],
    [10, 'kworker/0:0H-events_highpri', 'I<'], [12, 'kworker/R-mm_percpu_wq', 'I<'], [13, 'rcu_tasks_kthread', 'I'],
    [14, 'rcu_tasks_rude_kthread', 'I'], [15, 'rcu_tasks_trace_kthread', 'I'], [16, 'ksoftirqd/0', 'S'], [17, 'rcu_preempt', 'I'],
    [18, 'rcu_exp_par_gp_kthread_worker/0', 'S'], [19, 'rcu_exp_gp_kthread_worker', 'S'], [20, 'migration/0', 'S'], [21, 'idle_inject/0', 'S'],
    [22, 'cpuhp/0', 'S'], [23, 'cpuhp/1', 'S'], [24, 'idle_inject/1', 'S'], [25, 'migration/1', 'S'], [26, 'ksoftirqd/1', 'S'],
    [28, 'kworker/1:0H-events_highpri', 'I<'], [29, 'kdevtmpfs', 'S'], [30, 'kworker/R-inet_frag_wq', 'I<'], [31, 'kauditd', 'S'],
    [32, 'khungtaskd', 'S'], [33, 'oom_reaper', 'S'], [35, 'kworker/R-writeback', 'I<'], [36, 'kcompactd0', 'S'], [37, 'ksmd', 'SN'],
    [38, 'khugepaged', 'SN'], [39, 'kworker/R-kintegrityd', 'I<'], [40, 'kworker/R-kblockd', 'I<'], [41, 'kworker/R-blkcg_punt_bio', 'I<'],
    [42, 'irq/9-acpi', 'S'], [43, 'kworker/R-tpm_dev_wq', 'I<'], [44, 'kworker/R-edac-poller', 'I<'], [45, 'kworker/R-devfreq_wq', 'I<'],
    [47, 'kswapd0', 'S'], [53, 'kworker/R-kthrotld', 'I<'], [58, 'kworker/R-acpi_thermal_pm', 'I<'], [60, 'kworker/R-mld', 'I<'],
    [61, 'kworker/R-ipv6_addrconf', 'I<'], [66, 'kworker/R-kstrp', 'I<'], [71, 'kworker/u9:0', 'I<'], [128, 'kworker/R-ata_sff', 'I<'],
    [130, 'scsi_eh_0', 'S'], [131, 'kworker/R-scsi_tmf_0', 'I<'], [132, 'scsi_eh_1', 'S'], [133, 'kworker/R-scsi_tmf_1', 'I<'],
    [141, 'kworker/0:1H-kblockd', 'I<'], [152, 'kworker/1:1H-kblockd', 'I<'], [189, 'jbd2/sda1-8', 'S'], [190, 'kworker/R-ext4-rsv-conversion', 'I<'],
  ];
  const LATE_KERNEL_THREADS = ['kworker/0:2-events', 'kworker/1:1-mm_percpu_wq', 'kworker/u8:3-events_unbound', 'kworker/u8:0-flush-8:0'];

  // The Xfce session of the logged-in user: [command, rss, vsz, state, parent key, own key]
  const XFCE_LIB = '/usr/lib/x86_64-linux-gnu/xfce4';
  const KALI_SESSION = [
    ['/usr/bin/pipewire', 9872, 106404, 'S<sl', 'user-systemd'],
    ['/usr/bin/wireplumber', 16340, 407812, 'S<sl', 'user-systemd'],
    ['/usr/bin/pipewire-pulse', 12108, 105120, 'S<sl', 'user-systemd'],
    ['/usr/bin/dbus-daemon --session --address=systemd: --nofork --nopidfile --systemd-activation --syslog-only', 5932, 10244, 'Ss', 'user-systemd'],
    ['xfce4-session', 78412, 472916, 'Ssl', 'session-child', 'xfce4-session'],
    ['/usr/bin/ssh-agent x-session-manager', 1436, 8448, 'Ss', 'xfce4-session'],
    ['/usr/libexec/at-spi-bus-launcher', 8064, 309236, 'Ssl', 'user-systemd'],
    [XFCE_LIB + '/xfconf/xfconfd', 7208, 235104, 'Ssl', 'user-systemd'],
    ['/usr/bin/gpg-agent --supervised', 3508, 81160, 'Ss', 'user-systemd'],
    ['xfwm4', 98244, 1203316, 'Sl', 'xfce4-session'],
    ['/usr/libexec/gvfsd', 8236, 236700, 'Ssl', 'user-systemd'],
    ['xfsettingsd', 31044, 402228, 'Sl', 'xfce4-session'],
    ['xfce4-panel', 42816, 478132, 'Sl', 'xfce4-session', 'xfce4-panel'],
    ['Thunar --daemon', 39672, 549428, 'Sl', 'xfce4-session'],
    ['xfdesktop', 61208, 618772, 'Sl', 'xfce4-session'],
    [XFCE_LIB + '/panel/wrapper-2.0 ' + XFCE_LIB + '/panel/plugins/libwhiskermenu.so 1 18874375 whiskermenu Whisker Menu Show a menu to easily access installed applications', 46020, 554108, 'Sl', 'xfce4-panel'],
    [XFCE_LIB + '/panel/wrapper-2.0 ' + XFCE_LIB + '/panel/plugins/libsystray.so 6 18874376 systray Status Tray Plugin Provides status notifier items (application indicators) and legacy systray items', 30884, 401916, 'Sl', 'xfce4-panel'],
    ['/usr/lib/policykit-1-gnome/polkit-gnome-authentication-agent-1', 23180, 383040, 'Sl', 'xfce4-session'],
    ['nm-applet', 47236, 620492, 'Sl', 'xfce4-session'],
    ['xfce4-power-manager', 28952, 399184, 'Ssl', 'xfce4-session'],
    ['light-locker', 21404, 317660, 'Sl', 'xfce4-session'],
    [XFCE_LIB + '/notifyd/xfce4-notifyd', 26108, 388452, 'Ssl', 'user-systemd'],
    ['/usr/bin/qterminal', 95328, 918640, 'Sl', 'xfce4-panel', 'qterminal'],
  ];

  function seedProcesses(machine, boot) {
    machine.state.pids = {};
    let pid = 0;
    const add = (p) => {
      if (p.pid == null) p.pid = pid + 1;
      pid = p.pid;
      const full = Object.assign({ ppid: 1, user: 'root', tty: '?', stat: 'S', start: boot, cpu: 0, mem: 0, cmd: '', vsz: 0, rss: 0, time: 0 }, p);
      machine.procs.push(full);
      return full;
    };
    add({ pid: 1, ppid: 0, cmd: machine.profile === 'kali' ? '/sbin/init splash' : '/sbin/init', comm: 'systemd', stat: 'Ss', rss: 14320, vsz: 23956, mem: memPercent(14320), time: 2 });
    for (const [kpid, name, stat] of KERNEL_THREADS) add({ pid: kpid, ppid: kpid === 2 ? 0 : 2, cmd: '[' + name + ']', stat });

    pid = 228;
    const gap = (seed) => { pid += 2 + (U.hash32(machine.hostname + seed) % 19); };
    const booted = machine.units.filter((u) => u.boot != null).sort((a, b) => a.boot - b.boot);
    const bootSpawn = (p) => add(p);
    for (const unit of booted) {
      gap(unit.name);
      startUnit(machine, unit, { at: boot + Math.round(unit.boot * 1000), spawn: bootSpawn, execPid: () => { pid += 1; return pid; } });
    }
    if (machine.profile === 'kali') {
      const login = boot + 41 * SEC;
      KALI_SESSION.forEach(([cmd, rss, vsz, stat, parent, key], i) => {
        gap(cmd);
        const p = add({ ppid: machine.state.pids[parent] || 1, user: 'kali', cmd, stat, rss, vsz, mem: memPercent(rss), start: login + i * 180, time: Math.floor(rss / 30000) });
        if (key) machine.state.pids[key] = p.pid;
      });
      const term = machine.procs.find((p) => p.pid === machine.state.pids.qterminal);
      Object.assign(term, { start: boot + 6 * MIN + 12 * SEC, cpu: 0.3, time: 9 });
    }
    for (const name of LATE_KERNEL_THREADS) { gap(name); add({ ppid: 2, cmd: '[' + name + ']', stat: 'I', start: boot + (40 + pid % 90) * MIN }); }
    if (machine._pid < pid + 30) machine._pid = pid + 30;
  }

  /* ============================================================ boot logs */

  function kernelMessages(machine) {
    const os = machine.os; const eth = machine.ifaces.find((i) => i.kind !== 'loopback') || { name: 'eth0', mac: '08:00:27:00:00:01' };
    const rootUuid = '5d2c8a4e-1f3b-4c6d-9e7a-0b1c2d3e4f5a';
    return [
      [0, 'Linux version ' + os.kernel + ' (' + (machine.profile === 'kali' ? 'devel@kali.org' : 'debian-kernel@lists.debian.org') + ') (x86_64-linux-gnu-gcc-15 (Debian 15.2.0-4) 15.2.0, GNU ld (GNU Binutils for Debian) 2.45) ' + os.kernelBuild],
      [0, 'Command line: BOOT_IMAGE=/boot/vmlinuz-' + os.kernel + ' root=UUID=' + rootUuid + ' ro quiet' + (machine.profile === 'kali' ? ' splash' : '')],
      [0, 'BIOS-provided physical RAM map:'],
      [0, 'BIOS-e820: [mem 0x0000000000000000-0x000000000009fbff] usable'],
      [0, 'BIOS-e820: [mem 0x0000000000100000-0x00000000bffdffff] usable'],
      [0, 'BIOS-e820: [mem 0x0000000100000000-0x000000013fffffff] usable'],
      [0, 'NX (Execute Disable) protection: active'],
      [0, 'DMI: QEMU Standard PC (Q35 + ICH9, 2009), BIOS 1.16.3-debian-1.16.3-2 04/01/2014'],
      [0, 'Hypervisor detected: KVM'],
      [0.000003, 'tsc: Detected 2592.000 MHz processor'],
      [0.018442, 'Memory: 3912544K/4193720K available (18432K kernel code, 3334K rwdata, 13312K rodata, 4692K init, 5148K bss, 276100K reserved, 0K cma-reserved)'],
      [0.133725, 'smpboot: CPU0: Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz (family: 0x6, model: 0x9e, stepping: 0xa)'],
      [0.251663, 'smp: Brought up 1 node, 2 CPUs'],
      [0.412309, 'NET: Registered PF_INET protocol family'],
      [0.688201, 'Freeing unused kernel image (initmem) memory: 4692K'],
      [0.902127, 'ahci 0000:00:1f.2: AHCI vers 0001.0000, 32 command slots, 1.5 Gbps, SATA mode'],
      [1.049873, 'ata1.00: ATA-7: QEMU HARDDISK, 2.5+, max UDMA/100'],
      [1.060215, 'sd 0:0:0:0: [sda] 167772160 512-byte logical blocks: (85.9 GB/80.0 GiB)'],
      [1.071441, ' sda: sda1 sda2 < sda5 >'],
      [1.612874, 'EXT4-fs (sda1): mounted filesystem ' + rootUuid + ' ro with ordered data mode. Quota mode: none.'],
      [1.842551, 'systemd[1]: Detected virtualization kvm.'],
      [1.842690, 'systemd[1]: Detected architecture x86-64.'],
      [1.853117, 'systemd[1]: Hostname set to <' + machine.hostname + '>.'],
      [2.310442, 'EXT4-fs (sda1): re-mounted ' + rootUuid + ' r/w. Quota mode: none.'],
      [2.541003, 'Adding 1048572k swap on /dev/sda5.  Priority:-2 extents:1 across:1048572k'],
      [3.102880, 'e1000 0000:00:03.0 ' + eth.name + ': (PCI:33MHz:32-bit) ' + eth.mac],
      [3.103041, 'e1000 0000:00:03.0 ' + eth.name + ': Intel(R) PRO/1000 Network Connection'],
      [5.277316, 'e1000: ' + eth.name + ' NIC Link is Up 1000 Mbps Full Duplex, Flow Control: RX'],
    ];
  }

  /** The kernel ring buffer of this boot, written through K.syslog so kern.log, the journal and dmesg agree. */
  function seedKernelLog(machine, boot) {
    for (const [mono, msg] of kernelMessages(machine)) K.syslog(machine, { ts: boot + Math.floor(mono * 1000), facility: 'kern', ident: 'kernel', msg, mono });
  }

  /** What the daemons logged between boot and now: the desktop login on Kali and the hourly cron run. */
  function seedDaemonLog(machine, boot, now) {
    const kali = machine.profile === 'kali';
    const log = (ts, facility, ident, pid, msg) => K.syslog(machine, { ts, facility, ident, pid, msg });
    const pidOf = (name) => { const u = findUnit(machine, name); return u ? u.pid : null; };
    const eth = machine.ifaces.find((i) => i.kind !== 'loopback');
    const nm = pidOf('NetworkManager');
    if (eth && nm) {
      const gw = (machine.routes.find((r) => r.dst === 'default') || {}).via;
      const stamp = (ms) => '<info>  [' + ((boot + ms) / 1000).toFixed(4) + '] ';
      log(boot + 5300, 'daemon', 'NetworkManager', nm, stamp(5300) + 'device (' + eth.name + '): carrier: link connected');
      log(boot + 7900, 'daemon', 'NetworkManager', nm, stamp(7900) + 'dhcp4 (' + eth.name + '): state changed new lease, address=' + eth.ip);
      log(boot + 7950, 'daemon', 'NetworkManager', nm, stamp(7950) + "policy: set 'Wired connection 1' (" + eth.name + ') as default for IPv4 routing and DNS');
      log(boot + 8100, 'daemon', 'NetworkManager', nm, stamp(8100) + 'manager: NetworkManager state is now CONNECTED_GLOBAL' + (gw ? ' (gateway ' + gw + ')' : ''));
    }
    if (kali) {
      const dm = pidOf('lightdm'); const logind = pidOf('systemd-logind');
      const login = boot + 41 * SEC;
      log(boot + 9 * SEC, 'auth', 'lightdm', dm, 'pam_unix(lightdm-greeter:session): session opened for user lightdm(uid=107) by (uid=0)');
      log(boot + 9 * SEC + 200, 'auth', 'systemd-logind', logind, 'New session c1 of user lightdm.');
      log(login - 600, 'auth', 'lightdm', dm, 'pam_unix(lightdm-greeter:session): session closed for user lightdm');
      log(login, 'auth', 'lightdm', dm, 'pam_unix(lightdm:session): session opened for user kali(uid=1000) by (uid=0)');
      log(login + 100, 'auth', 'systemd-logind', logind, 'New session 2 of user kali.');
      log(login + 150, 'auth', 'systemd', machine.state.pids['user-systemd'], 'pam_unix(systemd-user:session): session opened for user kali(uid=1000) by kali(uid=0)');
    }
    // cron.hourly fires at minute 17, as in Debian's /etc/crontab. The lab content pack
    // writes the servers' auth.log history itself, so PAM lines are seeded on Kali only.
    let pid = machine.procs.reduce((max, p) => Math.max(max, p.pid), 0) + 3;
    for (let t = Math.floor(boot / HOUR) * HOUR + 17 * MIN; t < now; t += HOUR) {
      if (t <= boot + MIN) continue;
      pid += 5 + (U.hash32('cron' + t) % 40);
      if (kali) log(t + SEC, 'auth', 'CRON', pid, 'pam_unix(cron:session): session opened for user root(uid=0) by root(uid=0)');
      log(t + SEC, 'cron', 'CRON', pid + 1, '(root) CMD (   cd / && run-parts --report /etc/cron.hourly)');
      if (kali) log(t + SEC, 'auth', 'CRON', pid, 'pam_unix(cron:session): session closed for user root');
    }
    if (machine._pid < pid + 30) machine._pid = pid + 30;
  }

  /** What systemd printed on the console while booting, colour codes included, as plymouth saves it. */
  function bootLog(machine) {
    const ok = '[\x1b[0;32m  OK  \x1b[0m] ';
    const lines = [];
    for (const u of machine.units.filter((x) => x.boot != null).sort((a, b) => a.boot - b.boot)) {
      const label = '\x1b[0;1;39m' + u.name + '\x1b[0m - ' + u.desc;
      lines.push('         Starting ' + label + '...');
      lines.push(ok + (u.type === 'oneshot' ? 'Finished ' : 'Started ') + label + '.');
      if (u.name === 'systemd-tmpfiles-setup.service') lines.push(ok + 'Reached target \x1b[0;1;39msysinit.target\x1b[0m - System Initialization.');
      if (u.name === 'networking.service') lines.push(ok + 'Reached target \x1b[0;1;39mnetwork.target\x1b[0m - Network.');
    }
    lines.push(ok + 'Reached target \x1b[0;1;39mmulti-user.target\x1b[0m - Multi-User System.');
    if (machine.profile === 'kali') lines.push(ok + 'Reached target \x1b[0;1;39mgraphical.target\x1b[0m - Graphical Interface.');
    return lines.join('\n') + '\n';
  }

  K.fsSeeds.push(function initMachine(machine) {
    const fs = machine.vfs;
    const boot = K.getBootTime(); const now = K.clock.now();
    const kali = machine.profile === 'kali';
    for (const f of ['syslog', 'kern.log'].concat(kali ? ['auth.log'] : [])) fs.seed('/var/log/' + f, '', Object.assign({ mtime: boot }, LOG_FILE_MODE));

    machine.units = kali ? kaliUnits(machine) : serverUnits(machine);
    seedKernelLog(machine, boot);
    seedProcesses(machine, boot);
    seedDaemonLog(machine, boot, now);
    journalOf(machine).sort((a, b) => a.ts - b.ts);
    for (const f of ['syslog', 'kern.log', 'auth.log']) sortLogFile(machine, f, boot);
    fs.seed('/var/log/boot.log', bootLog(machine), Object.assign({ mtime: boot + 9 * SEC }, LOG_FILE_MODE));
    fs.seedDir('/var/log/journal', { mode: 0o2755, gid: 4, mtime: boot });

    machine.state.logins = kali ? [{ user: 'kali', tty: 'tty7', host: ':0', at: boot + 41 * SEC }] : [];
    if (kali) {
      fs.seed('/var/www/html/index.html', APACHE_INDEX, { mtime: Date.UTC(2026, 9, 26, 9, 14, 0) });
      fs.seed('/var/www/html/index.nginx-debian.html', NGINX_INDEX, { mtime: Date.UTC(2026, 9, 26, 9, 14, 0) });
      for (const d of ['apache2', 'nginx']) {
        fs.seedDir('/var/log/' + d, { mode: 0o750, gid: 4, mtime: boot });
        for (const f of ['access.log', 'error.log']) fs.seed('/var/log/' + d + '/' + f, '', Object.assign({ mtime: boot }, LOG_FILE_MODE));
      }
    }
  });

  /** Seeding writes records unit by unit; the files must read in time order like the real ones. */
  function sortLogFile(machine, name, mtime) {
    const path = '/var/log/' + name;
    if (!machine.vfs.exists(path)) return;
    const facilityOf = { 'auth.log': (r) => r.facility === 'auth' || r.facility === 'authpriv', 'kern.log': (r) => r.facility === 'kern', syslog: (r) => r.facility !== 'auth' && r.facility !== 'authpriv' };
    const text = journalOf(machine).filter(facilityOf[name]).map((r) => syslogLine(machine, r) + '\n').join('');
    machine.vfs.seed(path, text, Object.assign({ mtime }, LOG_FILE_MODE));
  }

  // The shell reports every interactive line: record each use of sudo the way sudo and PAM do.
  K.events.on('command', (e) => {
    const sh = e.shell; const machine = sh && sh.machine;
    if (!machine || !e.commands) return;
    for (const c of e.commands) if (c.argv[0] === 'sudo') logSudo(machine, sh, c, e);
  });

  function logSudo(machine, sh, c, e) {
    const g = K.getopt(c.argv.slice(1), { short: 'u:islkvnEHSh', long: ['user=', 'login', 'shell', 'list', 'reset-timestamp', 'validate', 'help', 'version', 'non-interactive', 'preserve-env'], alias: { user: 'u', login: 'i', shell: 's', list: 'l' }, stopAtNonOption: true });
    if (g.err || g.opts.h || g.opts.help || g.opts.version || g.opts.v || g.opts.k) return;
    const target = machine.userByName(g.opts.u || 'root');
    const invoker = machine.userByName(c.user);
    if (!target || !invoker) return;
    let command;
    if (g.opts.l) command = 'list';
    else if (g.rest.length) command = [(sh.which && sh.which(g.rest[0])) || g.rest[0]].concat(g.rest.slice(1)).join(' ');
    else command = target.shell;
    const where = 'TTY=pts/0 ; PWD=' + e.cwd + ' ; USER=' + target.name + ' ; COMMAND=' + command;
    const log = (msg, prio) => K.syslog(machine, { ident: 'sudo', pid: machine.nextPid(), facility: 'auth', prio: prio || 'notice', msg });
    const output = String(e.output || '');
    if (/is not in the sudoers file/.test(output)) return log('    ' + invoker.name + ' : user NOT in sudoers ; ' + where, 'alert');
    const wrong = /sudo: (\d) incorrect password attempts?/.exec(output);
    if (wrong) return log('    ' + invoker.name + ' : ' + wrong[1] + ' incorrect password attempt' + (wrong[1] === '1' ? '' : 's') + ' ; ' + where, 'alert');
    if (/sudo: a password is required/.test(output)) return undefined;
    log('    ' + invoker.name + ' : ' + where);
    if (g.opts.l) return undefined;
    log('pam_unix(sudo:session): session opened for user ' + target.name + '(uid=' + target.uid + ') by ' + invoker.name + '(uid=' + invoker.uid + ')', 'info');
    log('pam_unix(sudo:session): session closed for user ' + target.name, 'info');
    return undefined;
  }

  // The first shell on Kali runs inside the terminal emulator of the desktop session.
  K.events.on('boot', (e) => {
    const term = e.machine.state.pids && e.machine.state.pids.qterminal;
    if (term && e.shell && e.shell.proc) e.shell.proc.ppid = term;
  });

  /* ========================================================== registration */

  const reg = (def) => K.cmd.register(def);

  /* --------------------------------------------------------------- identity */

  reg({
    name: 'whoami', pkg: 'coreutils', summary: 'print effective user name', synopsis: 'whoami [OPTION]...',
    man: 'DESCRIPTION\n       Print the user name associated with the current effective user ID. Same as id -un.\n\nOPTIONS\n       --help display this help and exit\n\n       --version\n              output version information and exit\n\nEXAMPLES\n       whoami\n              Print your user name.\n       sudo whoami\n              Print root: sudo ran the command as the superuser.',
    run(ctx) {
      const g = ctx.getopt({ long: ['help', 'version'] });
      if (g.err) return usageError(ctx, g.err);
      if (g.opts.help) { ctx.out(coreutilsHelp('whoami', 'Usage: whoami [OPTION]...\nPrint the user name associated with the current effective user ID.\nSame as id -un.\n\n      --help        display this help and exit\n      --version     output version information and exit\n')); return 0; }
      if (g.opts.version) { ctx.out(coreutilsVersion('whoami', 'Richard Mlynarik')); return 0; }
      if (g.rest.length) return usageError(ctx, "extra operand '" + g.rest[0] + "'");
      ctx.println(ctx.user.name);
      return 0;
    },
  });

  const ID_HELP = 'Usage: id [OPTION]... [USER]...\nPrint user and group information for each specified USER,\nor (when USER omitted) for the current process.\n\n' +
    '  -a             ignore, for compatibility with other versions\n  -Z, --context  print only the security context of the process\n  -g, --group    print only the effective group ID\n' +
    '  -G, --groups   print all group IDs\n  -n, --name     print a name instead of a number, for -ugG\n  -r, --real     print the real ID instead of the effective ID, with -ugG\n' +
    '  -u, --user     print only the effective user ID\n  -z, --zero     delimit entries with NUL characters, not whitespace;\n                   not permitted in default format\n' +
    '      --help        display this help and exit\n      --version     output version information and exit\n\nWithout any OPTION, print some useful set of identified information.\n';

  /** uid, gid and group list of a named account, or of the calling process when no name is given. */
  function identity(ctx, name) {
    const m = ctx.machine;
    if (name == null) return { uid: ctx.user.uid, gid: ctx.user.gid, groups: ctx.user.groups.slice() };
    const u = m.userByName(name) || (/^\d+$/.test(name) ? m.userByUid(+name) : null);
    if (!u) return null;
    return { uid: u.uid, gid: u.gid, groups: m.groupsOf(u.name).map((g) => g.gid) };
  }
  function idLine(m, who) {
    const groups = who.groups.indexOf(who.gid) >= 0 ? who.groups : [who.gid].concat(who.groups);
    const user = m.userByUid(who.uid); const group = m.groupByGid(who.gid);
    return 'uid=' + who.uid + (user ? '(' + user.name + ')' : '') + ' gid=' + who.gid + (group ? '(' + group.name + ')' : '') +
      ' groups=' + groups.map((g) => g + (m.groupByGid(g) ? '(' + m.groupName(g) + ')' : '')).join(',');
  }

  reg({
    name: 'id', pkg: 'coreutils', summary: 'print real and effective user and group IDs', synopsis: 'id [OPTION]... [USER]...',
    man: 'DESCRIPTION\n       Print user and group information for each specified USER, or (when USER omitted) for the current process.\n\nOPTIONS\n       -g, --group\n              print only the effective group ID\n\n       -G, --groups\n              print all group IDs\n\n       -n, --name\n              print a name instead of a number, for -ugG\n\n       -r, --real\n              print the real ID instead of the effective ID, with -ugG\n\n       -u, --user\n              print only the effective user ID\n\n       -z, --zero\n              delimit entries with NUL characters, not whitespace; not permitted in default format\n\n       Without any OPTION, print some useful set of identified information.\n\nEXAMPLES\n       id\n              Show your UID, GID and every group you belong to.\n       id -un\n              Print only your user name.\n       id -Gn kali\n              List the names of the groups the user kali belongs to.',
    run(ctx) {
      const g = ctx.getopt({ short: 'agGnruzZ', long: ['context', 'group', 'groups', 'name', 'real', 'user', 'zero', 'help', 'version'], alias: { group: 'g', groups: 'G', name: 'n', real: 'r', user: 'u', zero: 'z', context: 'Z' } });
      if (g.err) return usageError(ctx, g.err);
      const o = g.opts; const m = ctx.machine;
      if (o.help) { ctx.out(coreutilsHelp('id', ID_HELP)); return 0; }
      if (o.version) { ctx.out(coreutilsVersion('id', 'Arnold Robbins and David MacKenzie')); return 0; }
      if (o.Z) return ctx.fail('--context (-Z) works only on an SELinux-enabled kernel');
      const only = (o.u ? 1 : 0) + (o.g ? 1 : 0) + (o.G ? 1 : 0);
      if (only > 1) return ctx.fail('cannot print "only" of more than one choice');
      if (!only && (o.n || o.r)) return ctx.fail('cannot print only names or real IDs in default format');
      if (!only && o.z) return ctx.fail('option --zero not permitted in default format');
      const end = o.z ? '\0' : '\n';
      let status = 0;
      for (const name of g.rest.length ? g.rest : [null]) {
        const who = identity(ctx, name);
        if (!who) { ctx.err("id: '" + name + "': no such user\n"); status = 1; continue; }
        if (o.u) ctx.out((o.n ? m.userName(who.uid) : who.uid) + end);
        else if (o.g) ctx.out((o.n ? m.groupName(who.gid) : who.gid) + end);
        else if (o.G) {
          const all = who.groups.indexOf(who.gid) >= 0 ? who.groups : [who.gid].concat(who.groups);
          ctx.out(all.map((x) => (o.n ? m.groupName(x) : x)).join(o.z ? '\0' : ' ') + end);
        } else ctx.out(idLine(m, who) + '\n');
      }
      return status;
    },
  });

  reg({
    name: 'groups', pkg: 'coreutils', summary: 'print the groups a user is in', synopsis: 'groups [OPTION]... [USERNAME]...',
    man: 'DESCRIPTION\n       Print group memberships for each USERNAME or, if no USERNAME is specified, for the current process (which may differ if the groups database has changed).\n\nOPTIONS\n       --help display this help and exit\n\n       --version\n              output version information and exit\n\nEXAMPLES\n       groups\n              List your own groups. On Kali the list includes sudo.\n       groups root kali\n              Show the groups of two accounts, one per line.',
    run(ctx) {
      const g = ctx.getopt({ long: ['help', 'version'] });
      if (g.err) return usageError(ctx, g.err);
      const m = ctx.machine;
      if (g.opts.help) { ctx.out(coreutilsHelp('groups', 'Usage: groups [OPTION]... [USERNAME]...\nPrint group memberships for each USERNAME or, if no USERNAME is specified, for\nthe current process (which may differ if the groups database has changed).\n      --help        display this help and exit\n      --version     output version information and exit\n')); return 0; }
      if (g.opts.version) { ctx.out(coreutilsVersion('groups', 'David MacKenzie and James Youngman')); return 0; }
      const names = (who) => (who.groups.indexOf(who.gid) >= 0 ? who.groups : [who.gid].concat(who.groups)).map((x) => m.groupName(x)).join(' ');
      if (!g.rest.length) { ctx.println(names(identity(ctx, null))); return 0; }
      let status = 0;
      for (const name of g.rest) {
        const who = m.userByName(name) ? identity(ctx, name) : null;
        if (!who) { ctx.err("groups: '" + name + "': no such user\n"); status = 1; continue; }
        ctx.println(name + ' : ' + names(who));
      }
      return status;
    },
  });

  /* ----------------------------------------------------- system information */

  const HOSTNAME_USAGE = 'Usage: hostname [-b] {hostname|-F file}         set host name (from file)\n       hostname [-a|-A|-d|-f|-i|-I|-s|-y]       display formatted name\n' +
    '       hostname                                 display host name\n\n       {yp,nis,}domainname {nisdomain|-F file}  set NIS domain name (from file)\n' +
    '       {yp,nis,}domainname                      display NIS domain name\n\n       dnsdomainname                            display dns domain name\n\n' +
    '       hostname -V|--version|-h|--help          print info and exit\n\nProgram name:\n       {yp,nis,}domainname=hostname -y\n       dnsdomainname=hostname -d\n\nProgram options:\n' +
    '    -a, --alias            alias names\n    -A, --all-fqdns        all long host names (FQDNs)\n    -b, --boot             set default hostname if none available\n' +
    '    -d, --domain           DNS domain name\n    -f, --fqdn, --long     long host name (FQDN)\n    -F, --file             read host name or NIS domain name from given file\n' +
    '    -i, --ip-address       addresses for the host name\n    -I, --all-ip-addresses all addresses for the host\n    -s, --short            short host name\n' +
    '    -y, --yp, --nis        NIS/YP domain name\n\nDescription:\n   This command can get or set the host name or the NIS domain name. You can\n' +
    '   also get the DNS domain or the FQDN (fully qualified domain name).\n   Unless you are using bind or NIS for host lookups you can change the\n' +
    '   FQDN (Fully Qualified Domain Name) and the DNS domain name (which is\n   part of the FQDN) in the /etc/hosts file.\n';

  function setHostname(ctx, name) {
    if (!ctx.isRoot) return ctx.fail('you must be root to change the host name');
    if (!name || name.length > 64 || !/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(name)) return ctx.fail('the specified hostname is invalid');
    ctx.machine.hostname = name;
    return 0;
  }

  reg({
    name: 'hostname', aliases: ['dnsdomainname'], pkg: 'hostname', summary: 'show or set the system\'s host name', synopsis: 'hostname [-a|-A|-d|-f|-i|-I|-s|-y] [-b] [-F file] [name]',
    man: 'DESCRIPTION\n       Hostname is used to display the system\'s DNS name, and to display or set its hostname. When called without any arguments, the program displays the current name. When called with one argument or with the --file option, the command sets the host name; only the super-user may do that.\n\nOPTIONS\n       -d, --domain\n              Display the name of the DNS domain.\n\n       -f, --fqdn, --long\n              Display the FQDN (Fully Qualified Domain Name).\n\n       -F, --file filename\n              Read the host name from the specified file.\n\n       -i, --ip-address\n              Display the network address(es) of the host name.\n\n       -I, --all-ip-addresses\n              Display all network addresses of the host, on all configured interfaces. The loopback interface is omitted.\n\n       -s, --short\n              Display the short host name. This is the host name cut at the first dot.\n\nEXAMPLES\n       hostname\n              Print the name of this machine.\n       hostname -I\n              Print the IP addresses of this machine: a quick way to find your own address in the lab.\n       sudo hostname pentest\n              Rename the machine until the next reboot.',
    run(ctx) {
      const g = ctx.getopt({ short: 'aAbdfF:iIsyhV', long: ['alias', 'all-fqdns', 'boot', 'domain', 'fqdn', 'long', 'file=', 'ip-address', 'all-ip-addresses', 'short', 'yp', 'nis', 'help', 'version'],
        alias: { alias: 'a', 'all-fqdns': 'A', boot: 'b', domain: 'd', fqdn: 'f', long: 'f', file: 'F', 'ip-address': 'i', 'all-ip-addresses': 'I', short: 's', yp: 'y', nis: 'y', help: 'h', version: 'V' } });
      const m = ctx.machine;
      if (g.err) { ctx.err('hostname: ' + g.err + '\n' + HOSTNAME_USAGE); return 255; }
      if (g.opts.h) { ctx.out(HOSTNAME_USAGE); return 0; }
      if (g.opts.V) { ctx.out('hostname 3.25\n'); return 0; }
      if (g.rest.length > 1) { ctx.err(HOSTNAME_USAGE); return 255; }
      if (g.opts.F != null) {
        let text;
        try { text = ctx.fs.read(g.opts.F); } catch (e) { return ctx.fail(e.message); }
        const line = U.lines(text).find((l) => l.trim() && l[0] !== '#');
        return setHostname(ctx, (line || '').trim());
      }
      if (g.rest.length) return setHostname(ctx, g.rest[0]);
      // the last display option wins, as in the real tool
      const mode = ctx.name === 'dnsdomainname' ? 'd' : ctx.args.join(' ').replace(/--(domain|fqdn|long|ip-address|all-ip-addresses|short|alias|all-fqdns|yp|nis)/g, (x, n) => ({ domain: '-d', fqdn: '-f', long: '-f', 'ip-address': '-i', 'all-ip-addresses': '-I', short: '-s', alias: '-a', 'all-fqdns': '-A', yp: '-y', nis: '-y' })[n]).replace(/[^aAdfiIsy]/g, '').slice(-1);
      switch (mode) {
        case 'd': if (m.domain) ctx.println(m.domain); return 0;
        case 'f': ctx.println(m.fqdn()); return 0;
        case 's': ctx.println(m.hostname.split('.')[0]); return 0;
        case 'i': { const r = K.net.resolve(m, m.hostname); if (!r) return ctx.fail('Name or service not known'); ctx.println(r.ip); return 0; }
        case 'I': ctx.println(m.ifaces.filter((i) => i.kind !== 'loopback' && i.ip && i.state !== 'DOWN').map((i) => i.ip + ' ').join('')); return 0;
        case 'a': ctx.println(''); return 0;
        case 'A': ctx.println(m.domain ? m.fqdn() + ' ' : ''); return 0;
        case 'y': return ctx.fail('Local domain name not set');
        default: ctx.println(m.hostname); return 0;
      }
    },
  });

  const UNAME_HELP = 'Usage: uname [OPTION]...\nPrint certain system information.  With no OPTION, same as -s.\n\n  -a, --all                print all information, in the following order,\n' +
    '                             except omit -p and -i if unknown:\n  -s, --kernel-name        print the kernel name\n  -n, --nodename           print the network node hostname\n' +
    '  -r, --kernel-release     print the kernel release\n  -v, --kernel-version     print the kernel version\n  -m, --machine            print the machine hardware name\n' +
    '  -p, --processor          print the processor type (non-portable)\n  -i, --hardware-platform  print the hardware platform (non-portable)\n' +
    '  -o, --operating-system   print the operating system\n      --help        display this help and exit\n      --version     output version information and exit\n';

  reg({
    name: 'uname', pkg: 'coreutils', summary: 'print system information', synopsis: 'uname [OPTION]...',
    man: 'DESCRIPTION\n       Print certain system information. With no OPTION, same as -s.\n\nOPTIONS\n       -a, --all\n              print all information, in the following order, except omit -p and -i if unknown:\n\n       -s, --kernel-name\n              print the kernel name\n\n       -n, --nodename\n              print the network node hostname\n\n       -r, --kernel-release\n              print the kernel release\n\n       -v, --kernel-version\n              print the kernel version\n\n       -m, --machine\n              print the machine hardware name\n\n       -p, --processor\n              print the processor type (non-portable)\n\n       -i, --hardware-platform\n              print the hardware platform (non-portable)\n\n       -o, --operating-system\n              print the operating system\n\nEXAMPLES\n       uname -a\n              Kernel name, host name, kernel release and build, architecture and operating system on one line.\n       uname -r\n              Only the kernel release, the value you compare against a list of kernel vulnerabilities.',
    run(ctx) {
      const g = ctx.getopt({ short: 'asnrvmpio', long: ['all', 'kernel-name', 'nodename', 'kernel-release', 'kernel-version', 'machine', 'processor', 'hardware-platform', 'operating-system', 'help', 'version'],
        alias: { all: 'a', 'kernel-name': 's', nodename: 'n', 'kernel-release': 'r', 'kernel-version': 'v', machine: 'm', processor: 'p', 'hardware-platform': 'i', 'operating-system': 'o' } });
      if (g.err) return usageError(ctx, g.err);
      const o = g.opts; const os = ctx.machine.os;
      if (o.help) { ctx.out(coreutilsHelp('uname', UNAME_HELP)); return 0; }
      if (o.version) { ctx.out(coreutilsVersion('uname', 'David MacKenzie')); return 0; }
      if (g.rest.length) return usageError(ctx, "extra operand '" + g.rest[0] + "'");
      // Debian builds coreutils without the processor patch that Ubuntu carries
      const cpu = /ubuntu/i.test(os.pretty) ? os.arch : 'unknown';
      const fields = [['s', 'Linux'], ['n', ctx.machine.hostname], ['r', os.kernel], ['v', os.kernelBuild], ['m', os.arch], ['p', cpu], ['i', cpu], ['o', 'GNU/Linux']];
      const none = !fields.some(([k]) => o[k]) && !o.a;
      const picked = fields.filter(([k, v]) => (o.a ? !(v === 'unknown' && (k === 'p' || k === 'i')) : o[k] || (none && k === 's')));
      ctx.println(picked.map((f) => f[1]).join(' '));
      return 0;
    },
  });

  const loadAverage = (machine) => { try { return machine.vfs.read('/proc/loadavg').split(' ').slice(0, 3); } catch (e) { return ['0.00', '0.00', '0.00']; } };
  const clockTime = (ms) => U.isoDate(ms).slice(11);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  /** The line shared by uptime, w and the first line of top: " 14:30:00 up  3:17,  1 user,  load average: ..." */
  function uptimeLine(machine) {
    const now = K.clock.now(); const up = Math.max(0, Math.floor((now - K.getBootTime()) / 1000));
    const days = Math.floor(up / 86400); const hours = Math.floor(up / 3600) % 24; const mins = Math.floor(up / 60) % 60;
    const users = (machine.state.logins || []).length;
    return ' ' + clockTime(now) + ' up ' + (days ? days + (days > 1 ? ' days, ' : ' day, ') : '') + (hours ? U.padStart(hours, 2) + ':' + U.pad2(mins) + ', ' : mins + ' min, ') +
      U.padStart(users, 2) + (users > 1 ? ' users' : ' user') + ',  load average: ' + loadAverage(machine).join(', ');
  }
  const UPTIME_USAGE = '\nUsage:\n uptime [options]\n\nOptions:\n -p, --pretty   show uptime in pretty format\n -h, --help     display this help and exit\n -s, --since    system up since\n -V, --version  output version information and exit\n\nFor more details see uptime(1).\n';

  reg({
    name: 'uptime', pkg: 'procps', summary: 'Tell how long the system has been running.', synopsis: 'uptime [options]',
    man: 'DESCRIPTION\n       uptime gives a one line display of the following information. The current time, how long the system has been running, how many users are currently logged on, and the system load averages for the past 1, 5, and 15 minutes.\n\n       System load averages is the average number of processes that are either in a runnable or uninterruptable state.\n\nOPTIONS\n       -p, --pretty\n              show uptime in pretty format\n\n       -s, --since\n              system up since, in yyyy-mm-dd HH:MM:SS format\n\n       -h, --help\n              display this help text\n\n       -V, --version\n              display version information and exit\n\nEXAMPLES\n       uptime\n              One line: time, uptime, logged-in users and load.\n       uptime -s\n              The moment the machine booted. Log entries older than this come from an earlier boot.',
    run(ctx) {
      const g = ctx.getopt({ short: 'pshV', long: ['pretty', 'since', 'help', 'version'], alias: { pretty: 'p', since: 's', help: 'h', version: 'V' } });
      if (g.err) { ctx.err('uptime: ' + g.err + '\n' + UPTIME_USAGE); return 1; }
      if (g.opts.h) { ctx.out(UPTIME_USAGE); return 0; }
      if (g.opts.V) { ctx.out('uptime from procps-ng 4.0.4\n'); return 0; }
      if (g.rest.length) { ctx.err(UPTIME_USAGE); return 1; }
      const boot = K.getBootTime();
      if (g.opts.s) { ctx.println(U.isoDate(boot)); return 0; }
      if (g.opts.p) {
        const mins = Math.floor((K.clock.now() - boot) / MIN);
        const parts = [[Math.floor(mins / 10080), 'week'], [Math.floor(mins / 1440) % 7, 'day'], [Math.floor(mins / 60) % 24, 'hour'], [mins % 60, 'minute']].filter((x) => x[0]);
        ctx.println('up ' + (parts.length ? parts.map((x) => plural(x[0], x[1])).join(', ') : '0 minutes'));
        return 0;
      }
      ctx.println(uptimeLine(ctx.machine));
      return 0;
    },
  });

  /* -------------------------------------------------------------------- date */

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const floorMod = (a, b) => ((a % b) + b) % b;
  const dayStart = (ms) => Math.floor(ms / DAY) * DAY;

  /** ISO 8601 week number and the year it belongs to. */
  function isoWeek(ms) {
    const thursday = dayStart(ms) + (3 - floorMod(new Date(ms).getUTCDay() + 6, 7)) * DAY;
    const year = new Date(thursday).getUTCFullYear();
    return { year, week: Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY)) + 1 };
  }

  /**
   * strftime with the GNU extensions date(1) documents: flags - _ 0 ^ #, a field
   * width, and %N %s %:z. The clock is UTC. `en` selects the en_US forms of %c %x %X.
   */
  function strftime(fmt, ms, en) {
    const d = new Date(ms);
    const Y = d.getUTCFullYear(); const mon = d.getUTCMonth(); const day = d.getUTCDate(); const H = d.getUTCHours(); const wd = d.getUTCDay();
    const yday = Math.floor((dayStart(ms) - Date.UTC(Y, 0, 1)) / DAY);
    const iso = isoWeek(ms);
    const num = (n, width, pad) => ({ n, width, pad: pad || '0' });
    const expand = (f) => strftime(f, ms, en);
    const conv = {
      a: () => U.DAYS[wd], A: () => DAY_NAMES[wd], b: () => U.MONTHS[mon], h: () => U.MONTHS[mon], B: () => MONTH_NAMES[mon],
      c: () => expand(en ? '%a %d %b %Y %r %Z' : '%a %b %e %H:%M:%S %Y'), C: () => num(Math.floor(Y / 100), 2), d: () => num(day, 2), D: () => expand('%m/%d/%y'),
      e: () => num(day, 2, ' '), F: () => expand('%Y-%m-%d'), g: () => num(iso.year % 100, 2), G: () => num(iso.year, 1), H: () => num(H, 2), I: () => num(H % 12 || 12, 2),
      j: () => num(yday + 1, 3), k: () => num(H, 2, ' '), l: () => num(H % 12 || 12, 2, ' '), m: () => num(mon + 1, 2), M: () => num(d.getUTCMinutes(), 2), n: () => '\n',
      N: () => num(floorMod(ms, 1000) * 1e6, 9), p: () => (H < 12 ? 'AM' : 'PM'), P: () => (H < 12 ? 'am' : 'pm'), q: () => num(Math.floor(mon / 3) + 1, 1),
      r: () => expand('%I:%M:%S %p'), R: () => expand('%H:%M'), s: () => num(Math.floor(ms / 1000), 1), S: () => num(d.getUTCSeconds(), 2), t: () => '\t', T: () => expand('%H:%M:%S'),
      u: () => num(wd || 7, 1), U: () => num(Math.floor((yday + 7 - wd) / 7), 2), V: () => num(iso.week, 2), w: () => num(wd, 1), W: () => num(Math.floor((yday + 7 - floorMod(wd + 6, 7)) / 7), 2),
      x: () => expand(en ? '%m/%d/%Y' : '%m/%d/%y'), X: () => expand(en ? '%r' : '%T'), y: () => num(Y % 100, 2), Y: () => num(Y, 1), Z: () => 'UTC', '%': () => '%',
    };
    return fmt.replace(/%([-_0^#]*)(\d*)(:{0,3})([A-Za-z%])/g, (all, flags, width, colons, c) => {
      if (c === 'z') return colons.length === 1 ? '+00:00' : colons.length === 2 ? '+00:00:00' : colons.length === 3 ? '+00' : '+0000';
      if (colons || !conv[c]) return all;
      const v = conv[c]();
      let text; let pad = ' ';
      if (typeof v === 'string') text = v;
      else {
        pad = flags.indexOf('_') >= 0 ? ' ' : flags.indexOf('0') >= 0 ? '0' : v.pad;
        const w = flags.indexOf('-') >= 0 ? 0 : width ? +width : v.width;
        text = String(v.n).padStart(c === 'N' ? 9 : 0, '0');
        if (c === 'N' && width) return text.slice(0, +width);
        return text.padStart(w, pad);
      }
      if (flags.indexOf('^') >= 0) text = text.toUpperCase();
      else if (flags.indexOf('#') >= 0) text = c === 'Z' || c === 'p' ? text.toLowerCase() : text.toUpperCase();
      return width && flags.indexOf('-') < 0 ? text.padStart(+width, flags.indexOf('0') >= 0 ? '0' : pad) : text;
    });
  }

  const usesEnglishLocale = (env) => /^en_/.test(env.LC_ALL || env.LC_TIME || env.LANG || '');

  const UNIT_MS = { sec: SEC, second: SEC, min: MIN, minute: MIN, hour: HOUR, day: DAY, week: 7 * DAY, fortnight: 14 * DAY };
  const shortName = (list, word) => list.findIndex((n) => word.length >= 3 && n.toLowerCase().indexOf(word) === 0);

  /**
   * The subset of GNU date's free-form input that people type: ISO dates and
   * times, @epoch, now/today/tomorrow/yesterday, weekday names and relative
   * items such as "2 days ago" or "next month". Returns ms, or null if invalid.
   */
  function parseDateString(input, now) {
    const text = String(input).trim().toLowerCase();
    if (/^@-?\d+(\.\d+)?$/.test(text)) return Math.round(parseFloat(text.slice(1)) * 1000);
    if (!text) return dayStart(now);
    const base = new Date(now);
    let date = null; let time = null; let shiftMs = 0; let months = 0; let weekday = null;
    const words = text.replace(/(\d)t(\d)/, '$1 $2').replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const w = words[i]; let m;
      if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(w)) || (m = /^(\d{4})(\d{2})(\d{2})$/.exec(w))) { date = [+m[1], +m[2] - 1, +m[3]]; continue; }
      if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(w))) { date = [+m[3], +m[1] - 1, +m[2]]; continue; }
      if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?(z|[+-]\d{2}:?\d{2})?$/.exec(w))) {
        let h = +m[1];
        const half = /^[ap]m$/.test(words[i + 1] || '') ? words[++i] : null;
        if (half) h = (h % 12) + (half === 'pm' ? 12 : 0);
        time = [h, +m[2], +(m[3] || 0)];
        if (m[4] && m[4] !== 'z') shiftMs -= (m[4][0] === '-' ? -1 : 1) * (+m[4].slice(1, 3) * HOUR + +m[4].slice(-2) * MIN);
        continue;
      }
      if (w === 'now' || w === 'today' || w === 'utc' || w === 'gmt' || w === 'z') continue;
      if (w === 'tomorrow') { shiftMs += DAY; continue; }
      if (w === 'yesterday') { shiftMs -= DAY; continue; }
      if (w === 'midnight') { time = [0, 0, 0]; continue; }
      if (w === 'noon') { time = [12, 0, 0]; continue; }
      // relative item: [+-]N unit [ago] | next unit | last unit | a unit
      let count = null;
      if (/^[+-]?\d+$/.test(w)) count = parseInt(w, 10);
      else if (w === 'next' || w === 'a' || w === 'an') count = 1;
      else if (w === 'last') count = -1;
      const word = count == null ? w : words[i + 1] || '';
      const dow = shortName(DAY_NAMES, word);
      if (dow >= 0 && (count == null || w === 'next' || w === 'last')) { weekday = { dow, dir: count == null ? 0 : count }; if (count != null) i++; continue; }
      const mon = shortName(MONTH_NAMES, word);
      if (mon >= 0 && (count == null || /^\d+$/.test(w))) {
        // "13 nov [2026]" or "nov 13 [2026]"
        const dayWord = count != null ? w : words[i + 1];
        if (!/^\d{1,2}$/.test(dayWord || '')) return null;
        i += 1;
        const year = /^\d{4}$/.test(words[i + 1] || '') ? +words[++i] : base.getUTCFullYear();
        date = [year, mon, +dayWord];
        continue;
      }
      if (count == null) return null;
      const unit = word.replace(/s$/, '');
      const ago = words[i + 2] === 'ago' ? -1 : 1;
      if (UNIT_MS[unit]) shiftMs += count * ago * UNIT_MS[unit];
      else if (unit === 'month') months += count * ago;
      else if (unit === 'year') months += 12 * count * ago;
      else return null;
      i += ago < 0 ? 2 : 1;
    }
    if (date && (date[1] > 11 || date[2] < 1 || date[2] > 31)) return null;
    if (time && (time[0] > 23 || time[1] > 59 || time[2] > 59)) return null;
    const d = date || [base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()];
    // a bare date or weekday means midnight; relative items keep the time of day
    const t = time || (date || weekday ? [0, 0, 0] : [base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds()]);
    let ms = Date.UTC(d[0], d[1] + months, d[2], t[0], t[1], t[2]) + (date || time || weekday ? 0 : floorMod(now, 1000));
    if (date && new Date(ms).getUTCDate() !== d[2] && !months) return null;
    if (weekday) {
      const today = new Date(ms).getUTCDay();
      let delta = floorMod(weekday.dow - today, 7);
      if (weekday.dir > 0 && delta === 0) delta = 7;
      if (weekday.dir < 0) delta = delta === 0 ? -7 : delta - 7;
      ms += delta * DAY;
    }
    return ms + shiftMs;
  }

  const ISO_FORMATS = { hours: '%Y-%m-%dT%H%:z', minutes: '%Y-%m-%dT%H:%M%:z', date: '%Y-%m-%d', seconds: '%Y-%m-%dT%H:%M:%S%:z', ns: '%Y-%m-%dT%H:%M:%S,%N%:z' };
  const RFC3339_FORMATS = { date: '%Y-%m-%d', seconds: '%Y-%m-%d %H:%M:%S%:z', ns: '%Y-%m-%d %H:%M:%S.%N%:z' };
  function chooseFormat(ctx, table, value, option) {
    const names = Object.keys(table).filter((n) => n.indexOf(value) === 0);
    if (value && names.length === 1) return table[names[0]];
    ctx.err("date: " + (names.length > 1 ? 'ambiguous' : 'invalid') + " argument '" + value + "' for '--" + option + "'\nValid arguments are:\n" + Object.keys(table).map((n) => "  - '" + n + "'\n").join('') + "Try 'date --help' for more information.\n");
    return null;
  }

  const DATE_HELP = 'Usage: date [OPTION]... [+FORMAT]\n  or:  date [-u|--utc|--universal] [MMDDhhmm[[CC]YY][.ss]]\nDisplay date and time in the given FORMAT.\nWith -s, or with [MMDDhhmm[[CC]YY][.ss]], set the date and time.\n\n' +
    'Mandatory arguments to long options are mandatory for short options too.\n  -d, --date=STRING          display time described by STRING, not \'now\'\n' +
    '  -I[FMT], --iso-8601[=FMT]  output date/time in ISO 8601 format.\n                               FMT=\'date\' for date only (the default),\n                               \'hours\', \'minutes\', \'seconds\', or \'ns\'\n' +
    '                               for date and time to the indicated precision.\n                               Example: 2006-08-14T02:34:56-06:00\n' +
    '  -R, --rfc-email            output date and time in RFC 5322 format.\n                               Example: Mon, 14 Aug 2006 02:34:56 -0600\n' +
    '      --rfc-3339=FMT         output date/time in RFC 3339 format.\n                               FMT=\'date\', \'seconds\', or \'ns\'\n                               for date and time to the indicated precision.\n' +
    '                               Example: 2006-08-14 02:34:56-06:00\n  -r, --reference=FILE       display the last modification time of FILE\n' +
    '  -s, --set=STRING           set time described by STRING\n  -u, --utc, --universal     print or set Coordinated Universal Time (UTC)\n' +
    '      --help        display this help and exit\n      --version     output version information and exit\n\nFORMAT controls the output.  Interpreted sequences are:\n\n' +
    '  %%   a literal %\n  %a   locale\'s abbreviated weekday name (e.g., Sun)\n  %A   locale\'s full weekday name (e.g., Sunday)\n  %b   locale\'s abbreviated month name (e.g., Jan)\n' +
    '  %B   locale\'s full month name (e.g., January)\n  %c   locale\'s date and time (e.g., Thu Mar  3 23:05:25 2005)\n  %d   day of month (e.g., 01)\n  %D   date; same as %m/%d/%y\n' +
    '  %e   day of month, space padded; same as %_d\n  %F   full date; like %+4Y-%m-%d\n  %H   hour (00..23)\n  %I   hour (01..12)\n  %j   day of year (001..366)\n  %m   month (01..12)\n' +
    '  %M   minute (00..59)\n  %n   a newline\n  %N   nanoseconds (000000000..999999999)\n  %p   locale\'s equivalent of either AM or PM; blank if not known\n  %R   24-hour hour and minute; same as %H:%M\n' +
    '  %s   seconds since the Epoch (1970-01-01 00:00 UTC)\n  %S   second (00..60)\n  %T   time; same as %H:%M:%S\n  %u   day of week (1..7); 1 is Monday\n  %y   last two digits of year (00..99)\n' +
    '  %Y   year\n  %z   +hhmm numeric time zone (e.g., -0400)\n  %Z   alphabetic time zone abbreviation (e.g., EDT)\n\nExamples:\nConvert seconds since the Epoch (1970-01-01 UTC) to a date\n  $ date --date=\'@2147483647\'\n\n' +
    'Show the local time for 9AM next Friday on the west coast of the US\n  $ date --date=\'TZ="America/Los_Angeles" 09:00 next Fri\'\n';

  reg({
    name: 'date', pkg: 'coreutils', summary: 'print or set the system date and time', synopsis: 'date [OPTION]... [+FORMAT]',
    man: 'DESCRIPTION\n       Display date and time in the given FORMAT. With -s, set the date and time.\n\nOPTIONS\n       -d, --date=STRING\n              display time described by STRING, not \'now\'\n\n       -I[FMT], --iso-8601[=FMT]\n              output date/time in ISO 8601 format. FMT=\'date\' for date only (the default), \'hours\', \'minutes\', \'seconds\', or \'ns\' for date and time to the indicated precision.\n\n       -R, --rfc-email\n              output date and time in RFC 5322 format. Example: Mon, 14 Aug 2006 02:34:56 -0600\n\n       -r, --reference=FILE\n              display the last modification time of FILE\n\n       -u, --utc, --universal\n              print or set Coordinated Universal Time (UTC)\n\n       FORMAT controls the output. Common sequences: %Y year, %m month, %d day, %H hour, %M minute, %S second, %F full date (%Y-%m-%d), %T time (%H:%M:%S), %s seconds since the Epoch, %a and %A weekday name, %b and %B month name, %j day of year, %Z time zone.\n\nDATE STRING\n       The --date=STRING is a mostly free format human readable date string such as "2026-11-13 14:30", "tomorrow", "2 days ago", "next Friday" or "@1794580200" (seconds since the Epoch).\n\nEXAMPLES\n       date +%F_%H%M\n              A timestamp that sorts well in file names, for example for scan output.\n       date -d @1794580200\n              Convert the epoch seconds found in a log file to a readable date.\n       date -u -d "2 hours ago" +%T\n              The time two hours ago.',
    run(ctx) {
      const g = ctx.getopt({ short: 'd:I::r:Rs:u', long: ['date=', 'iso-8601=?', 'reference=', 'rfc-email', 'rfc-2822', 'rfc-822', 'rfc-3339=', 'set=', 'utc', 'universal', 'help', 'version'],
        alias: { date: 'd', 'iso-8601': 'I', reference: 'r', 'rfc-email': 'R', 'rfc-2822': 'R', 'rfc-822': 'R', set: 's', utc: 'u', universal: 'u' } });
      if (g.err) return usageError(ctx, g.err);
      const o = g.opts; const en = usesEnglishLocale(ctx.env);
      if (o.help) { ctx.out(coreutilsHelp('date', DATE_HELP)); return 0; }
      if (o.version) { ctx.out(coreutilsVersion('date', 'David MacKenzie')); return 0; }
      const operands = g.rest.filter((a) => a[0] === '+');
      const stray = g.rest.find((a) => a[0] !== '+');
      if (operands.length > 1) return usageError(ctx, "extra operand '" + operands[1] + "'");
      if (stray != null) return ctx.fail("invalid date '" + stray + "'");
      let format = operands.length ? operands[0].slice(1) : null;
      const preset = (o.I != null ? 1 : 0) + (o.R ? 1 : 0) + (o['rfc-3339'] != null ? 1 : 0);
      if (preset + (format != null ? 1 : 0) > 1) return ctx.fail('multiple output formats specified');
      if (o.I != null) format = o.I === true ? ISO_FORMATS.date : chooseFormat(ctx, ISO_FORMATS, o.I, 'iso-8601');
      else if (o.R) format = '%a, %d %b %Y %H:%M:%S %z';
      else if (o['rfc-3339'] != null) format = chooseFormat(ctx, RFC3339_FORMATS, o['rfc-3339'], 'rfc-3339');
      if (format == null && preset) return 1;
      if (format == null) format = en ? '%a %b %e %r %Z %Y' : '%a %b %e %H:%M:%S %Z %Y';

      const sources = (o.d != null ? 1 : 0) + (o.r != null ? 1 : 0) + (o.s != null ? 1 : 0);
      if (sources > 1) return usageError(ctx, 'the options to specify dates for printing are mutually exclusive');
      let when = K.clock.now();
      if (o.r != null) {
        try { when = ctx.fs.stat(o.r).mtime; } catch (e) { return ctx.fail(o.r + ': ' + e.message); }
      } else if (o.d != null || o.s != null) {
        const text = o.d != null ? o.d : o.s;
        when = parseDateString(text, K.clock.now());
        if (when == null || isNaN(when)) return ctx.fail("invalid date '" + text + "'");
      }
      // The simulated clock follows the host: like a VM whose time is kept in sync, it cannot be set.
      if (o.s != null) ctx.err('date: cannot set date: Operation not permitted\n');
      ctx.println(strftime(format, when, en));
      return o.s != null ? 1 : 0;
    },
  });

  const SLEEP_HELP = "Usage: sleep NUMBER[SUFFIX]...\n  or:  sleep OPTION\nPause for NUMBER seconds.  SUFFIX may be 's' for seconds (the default),\n'm' for minutes, 'h' for hours or 'd' for days.  NUMBER need not be an\n" +
    'integer.  Given two or more arguments, pause for the amount of time\nspecified by the sum of their values.\n\n      --help        display this help and exit\n      --version     output version information and exit\n';

  reg({
    name: 'sleep', pkg: 'coreutils', summary: 'delay for a specified amount of time', synopsis: 'sleep NUMBER[SUFFIX]...',
    man: 'DESCRIPTION\n       Pause for NUMBER seconds. SUFFIX may be \'s\' for seconds (the default), \'m\' for minutes, \'h\' for hours or \'d\' for days. NUMBER need not be an integer. Given two or more arguments, pause for the amount of time specified by the sum of their values.\n\nOPTIONS\n       --help display this help and exit\n\n       --version\n              output version information and exit\n\nEXAMPLES\n       sleep 5\n              Wait five seconds.\n       sleep 0.5; echo done\n              Wait half a second, then print.\n       sleep 1m 30s\n              Wait a minute and a half. Press Ctrl-C to stop waiting.',
    async run(ctx) {
      const first = ctx.args[0];
      if (first === '--help') { ctx.out(coreutilsHelp('sleep', SLEEP_HELP)); return 0; }
      if (first === '--version') { ctx.out(coreutilsVersion('sleep', 'Jim Meyering and Paul Eggert')); return 0; }
      const args = first === '--' ? ctx.args.slice(1) : ctx.args;
      if (!args.length) return usageError(ctx, 'missing operand');
      if (/^-[^\d.]/.test(args[0]) || /^-\d/.test(args[0])) return usageError(ctx, /^--/.test(args[0]) ? "unrecognized option '" + args[0] + "'" : "invalid option -- '" + args[0][1] + "'");
      let total = 0; let bad = false;
      for (const a of args) {
        const m = /^(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|inf|infinity)([smhd]?)$/i.exec(a);
        if (!m) { ctx.err("sleep: invalid time interval '" + a + "'\n"); bad = true; continue; }
        total += (/^inf/i.test(m[1]) ? Infinity : parseFloat(m[1])) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
      }
      if (bad) { ctx.err("Try 'sleep --help' for more information.\n"); return 1; }
      // "sleep infinity" waits in day-long steps until interrupted
      while (total === Infinity) await ctx.sleep(DAY);
      await ctx.sleep(total * 1000);
      return 0;
    },
  });

  /* -------------------------------------------------------------- environment */

  const ENV_HELP = 'Usage: env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]\nSet each NAME to VALUE in the environment and run COMMAND.\n\nMandatory arguments to long options are mandatory for short options too.\n' +
    '  -i, --ignore-environment  start with an empty environment\n  -0, --null           end each output line with NUL, not newline\n  -u, --unset=NAME     remove variable from the environment\n' +
    '  -C, --chdir=DIR      change working directory to DIR\n  -S, --split-string=S  process and split S into separate arguments;\n                        used to pass multiple arguments on shebang lines\n' +
    '  -v, --debug          print verbose information for each processing step\n      --help        display this help and exit\n      --version     output version information and exit\n\n' +
    'A mere - implies -i.  If no COMMAND, print the resulting environment.\n\nExit status:\n  125  if the env command itself fails\n  126  if COMMAND is found but cannot be invoked\n' +
    '  127  if COMMAND cannot be found\n  -    the exit status of COMMAND otherwise\n';
  // Builtins of the simulated shell that exist as real programs too, so env and friends may run them.
  const PROGRAM_BUILTINS = /^(echo|printf|test|\[|true|false|pwd|kill)$/;

  /** Run argv in a child shell whose exported environment is exactly `env`. Returns the exit status env reports. */
  async function runWithEnv(ctx, env, cwd, argv) {
    const sh = ctx.shell; const name = argv[0];
    const child = sh.child({ env, cwd });
    for (const k of ['HOME', 'USER', 'LOGNAME', 'PWD']) if (!(k in env)) child.unsetVar(k);
    if (!('PATH' in env)) child.exported.delete('PATH'); // still searched, like execvp's default path
    try {
      if (name.indexOf('/') >= 0) {
        let st;
        try { st = ctx.fs.stat(name); } catch (e) { ctx.err("env: '" + name + "': " + e.message + '\n'); return 127; }
        if (st.isDir || !ctx.fs.can(name, 'x')) { ctx.err("env: '" + name + "': Permission denied\n"); return 126; }
      } else if (!child.which(name)) {
        if (!PROGRAM_BUILTINS.test(name)) { ctx.err("env: '" + name + "': No such file or directory\n"); return 127; }
        return await child.execArgv(argv, ctx.io);
      }
      return await child.execArgv(argv, ctx.io, { external: true });
    } catch (e) {
      if (e instanceof K.ExitSignal) return e.code;
      throw e;
    } finally { child.dispose(); }
  }

  reg({
    name: 'env', pkg: 'coreutils', summary: 'run a program in a modified environment', synopsis: 'env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]',
    man: 'DESCRIPTION\n       Set each NAME to VALUE in the environment and run COMMAND.\n\nOPTIONS\n       -i, --ignore-environment\n              start with an empty environment\n\n       -0, --null\n              end each output line with NUL, not newline\n\n       -u, --unset=NAME\n              remove variable from the environment\n\n       -C, --chdir=DIR\n              change working directory to DIR\n\n       A mere - implies -i. If no COMMAND, print the resulting environment.\n\nEXIT STATUS\n       125    if the env command itself fails\n\n       126    if COMMAND is found but cannot be invoked\n\n       127    if COMMAND cannot be found\n\n       -      the exit status of COMMAND otherwise\n\nEXAMPLES\n       env\n              Print every exported variable.\n       env | grep -i proxy\n              Check whether a proxy is configured for command-line tools.\n       env LANG=C date\n              Run one command with a variable changed, leaving your shell untouched.',
    async run(ctx) {
      const env = Object.assign({}, ctx.env);
      let cwd = null; let nul = false;
      const args = ctx.args.slice();
      const fail = (msg) => usageError(ctx, msg, 125);
      const clear = () => { for (const k of Object.keys(env)) delete env[k]; };
      let i = 0;
      for (; i < args.length; i++) {
        const a = args[i];
        if (a === '--') { i++; break; }
        if (a === '-' ) { clear(); continue; }
        if (a[0] !== '-') break;
        if (a === '--help') { ctx.out(coreutilsHelp('env', ENV_HELP)); return 0; }
        if (a === '--version') { ctx.out(coreutilsVersion('env', 'Richard Mlynarik, David MacKenzie, and Assaf Gordon')); return 0; }
        if (a === '--ignore-environment') { clear(); continue; }
        if (a === '--null') { nul = true; continue; }
        if (a === '--debug') continue;
        const long = /^--(unset|chdir|split-string)(?:=(.*))?$/.exec(a);
        if (long) {
          const value = long[2] != null ? long[2] : args[++i];
          if (value == null) return fail("option '--" + long[1] + "' requires an argument");
          if (long[1] === 'unset') delete env[value]; else if (long[1] === 'chdir') cwd = value; else args.splice(i + 1, 0, ...value.split(/\s+/).filter(Boolean));
          continue;
        }
        if (a.startsWith('--')) return fail("unrecognized option '" + a + "'");
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          if (c === 'i') clear(); else if (c === '0') nul = true; else if (c === 'v') continue;
          else if (c === 'u' || c === 'C' || c === 'S') {
            const value = a.slice(j + 1) || args[++i];
            if (value == null) return fail("option requires an argument -- '" + c + "'");
            if (c === 'u') delete env[value]; else if (c === 'C') cwd = value; else args.splice(i + 1, 0, ...value.split(/\s+/).filter(Boolean));
            break;
          } else return fail("invalid option -- '" + c + "'");
        }
      }
      for (; i < args.length && /^[^=]+=/.test(args[i]); i++) { const eq = args[i].indexOf('='); env[args[i].slice(0, eq)] = args[i].slice(eq + 1); }
      const command = args.slice(i);
      if (!command.length) {
        if (cwd != null) return fail('must specify command with --chdir (-C)');
        ctx.out(Object.keys(env).map((k) => k + '=' + env[k] + (nul ? '\0' : '\n')).join(''));
        return 0;
      }
      if (nul) return fail('cannot specify --null (-0) with command');
      if (cwd != null && !ctx.fs.isDir(cwd)) { ctx.err("env: cannot change directory to '" + cwd + "': " + (ctx.fs.exists(cwd) ? 'Not a directory' : 'No such file or directory') + '\n'); return 125; }
      return runWithEnv(ctx, env, cwd == null ? ctx.cwd : ctx.path(cwd), command);
    },
  });

  reg({
    name: 'printenv', pkg: 'coreutils', summary: 'print all or part of environment', synopsis: 'printenv [OPTION]... [VARIABLE]...',
    man: 'DESCRIPTION\n       Print the values of the specified environment VARIABLE(s). If no VARIABLE is specified, print name and value pairs for them all.\n\nOPTIONS\n       -0, --null\n              end each output line with NUL, not newline\n\n       --help display this help and exit\n\n       --version\n              output version information and exit\n\nEXIT STATUS\n       0 if all variables were found, 1 if at least one was missing, 2 on a usage error.\n\nEXAMPLES\n       printenv PATH\n              Show the directories searched for commands.\n       printenv HOME SHELL\n              Print the values of two variables, one per line.',
    run(ctx) {
      const g = ctx.getopt({ short: '0', long: ['null', 'help', 'version'], alias: { null: '0' } });
      if (g.err) return usageError(ctx, g.err, 2);
      if (g.opts.help) { ctx.out(coreutilsHelp('printenv', 'Usage: printenv [OPTION]... [VARIABLE]...\nPrint the values of the specified environment VARIABLE(s).\nIf no VARIABLE is specified, print name and value pairs for them all.\n\n  -0, --null     end each output line with NUL, not newline\n      --help        display this help and exit\n      --version     output version information and exit\n\nNOTE: your shell may have its own version of printenv, which usually supersedes\nthe version described here.  Please refer to your shell\'s documentation\nfor details about the options it supports.\n')); return 0; }
      if (g.opts.version) { ctx.out(coreutilsVersion('printenv', 'David MacKenzie and Richard Mlynarik')); return 0; }
      const end = g.opts['0'] ? '\0' : '\n';
      if (!g.rest.length) { ctx.out(Object.keys(ctx.env).map((k) => k + '=' + ctx.env[k] + end).join('')); return 0; }
      let status = 0;
      for (const name of g.rest) {
        if (name in ctx.env && name.indexOf('=') < 0) ctx.out(ctx.env[name] + end); else status = 1;
      }
      return status;
    },
  });

  /* =============================================================== processes */

  const SHELL_NAMES = /^(zsh|bash|sh|dash)$/;
  // Accounts that own daemons but have no passwd entry in the base image.
  const DAEMON_UIDS = { 'systemd-timesync': 992, polkitd: 990, rtkit: 105, lightdm: 107, postgres: 112, mysql: 104, _rpc: 103, jenkins: 108 };
  const uidOfUser = (machine, name) => { const u = machine.userByName(name); return u ? u.uid : DAEMON_UIDS[name] != null ? DAEMON_UIDS[name] : 65534; };
  const gidOfUser = (machine, name) => { const u = machine.userByName(name); return u ? u.gid : uidOfUser(machine, name); };

  /** The kernel's short name for a process: what `ps -e`, pgrep and killall match. */
  function commOf(p) {
    if (p.comm) return p.comm;
    const c = p.cmd;
    if (c[0] === '[' && c[c.length - 1] === ']') return c.slice(1, -1);
    let first = c.split(' ')[0];
    if (/^[\w.-]+:$/.test(first)) first = first.slice(0, -1); // daemons that rewrite their title: "sshd: ...", "nginx: ..."
    return K.VFS.basename(first.replace(/^-/, '')).slice(0, 15) || first;
  }

  /** Everything ps and top print about one process, with plausible numbers for processes a shell started. */
  function procView(machine, p, selfPid) {
    const comm = commOf(p); const h = U.hash32(comm);
    const kthread = p.cmd[0] === '[';
    const seeded = p.rss != null;
    const rss = seeded ? p.rss : kthread ? 0 : SHELL_NAMES.test(comm) ? 6212 + (h % 900) : 1300 + (h % 3900);
    const vsz = seeded ? p.vsz : kthread ? 0 : rss * 2 + 3800 + ((h >>> 8) % 5200);
    let stat = p.stat;
    if (!seeded && p.tty !== '?') stat = p.stat === 'R' ? (p.pid === selfPid ? 'R+' : 'S+') : SHELL_NAMES.test(comm) && p.stat === 'S' ? 'Ss' : p.stat;
    const ni = /N/.test(stat) ? (comm === 'khugepaged' ? 19 : comm === 'ksmd' ? 5 : 1) : /</.test(stat) ? (kthread ? -20 : -11) : 0;
    return {
      pid: p.pid, ppid: p.ppid, user: p.user, uid: uidOfUser(machine, p.user), gid: gidOfUser(machine, p.user), tty: p.tty, stat, start: p.start,
      cpu: p.cpu || 0, mem: seeded ? p.mem : memPercent(rss), cmd: p.cmd, comm, vsz, rss, time: p.time || 0, ni, nlwp: /l/.test(stat) ? 2 + (h % 5) : 1, kthread,
    };
  }
  const allProcs = (ctx) => ctx.machine.procs.map((p) => procView(ctx.machine, p, ctx.pid));
  const shortUser = (name) => (name.length > 8 ? name.slice(0, 7) + '+' : name);

  const hms = (sec) => (sec >= 86400 ? Math.floor(sec / 86400) + '-' : '') + U.pad2(Math.floor(sec / 3600) % 24) + ':' + U.pad2(Math.floor(sec / 60) % 60) + ':' + U.pad2(Math.floor(sec) % 60);
  const bsdTime = (sec) => Math.floor(sec / 60) + ':' + U.pad2(Math.floor(sec) % 60);
  /** START/STIME: the time of day for processes started today, otherwise the date. */
  function startShort(ms, now) {
    if (dayStart(ms) === dayStart(now)) return strftime('%H:%M', ms);
    return strftime(new Date(ms).getUTCFullYear() === new Date(now).getUTCFullYear() ? '%b%d' : '%Y', ms);
  }
  function elapsed(sec) {
    const d = Math.floor(sec / 86400); const h = Math.floor(sec / 3600) % 24;
    return (d ? d + '-' : '') + (d || h ? U.pad2(h) + ':' : '') + U.pad2(Math.floor(sec / 60) % 60) + ':' + U.pad2(sec % 60);
  }

  // ps output columns: name -> [header, width, 'l' | 'r', value(view, now)]
  const PS_COLUMNS = (() => {
    const c = {
      pid: ['PID', 7, 'r', (v) => v.pid], ppid: ['PPID', 7, 'r', (v) => v.ppid], pgid: ['PGID', 7, 'r', (v) => v.pid], sid: ['SID', 7, 'r', (v) => v.pid],
      user: ['USER', 8, 'l', (v) => shortUser(v.user)], ruser: ['RUSER', 8, 'l', (v) => shortUser(v.user)], uid_hack: ['UID', 8, 'l', (v) => shortUser(v.user)],
      uid: ['UID', 5, 'r', (v) => v.uid], gid: ['GID', 5, 'r', (v) => v.gid], group: ['GROUP', 8, 'l', (v) => shortUser(v.user)],
      '%cpu': ['%CPU', 4, 'r', (v) => v.cpu.toFixed(1)], c: ['C', 2, 'r', (v) => Math.round(v.cpu)], '%mem': ['%MEM', 4, 'r', (v) => v.mem.toFixed(1)],
      vsz: ['VSZ', 6, 'r', (v) => v.vsz], rss: ['RSS', 5, 'r', (v) => v.rss], sz: ['SZ', 5, 'r', (v) => Math.floor(v.vsz / 4)], addr_sz: ['ADDR SZ', 7, 'l', (v) => '-' + U.padStart(Math.floor(v.vsz / 4), 6)],
      tty: ['TT', 8, 'l', (v) => v.tty], tname: ['TTY', 8, 'l', (v) => v.tty], bsdtty: ['TTY', 8, 'l', (v) => v.tty], tpgid: ['TPGID', 7, 'r', () => -1],
      stat: ['STAT', 4, 'l', (v) => v.stat], s: ['S', 1, 'l', (v) => v.stat[0]], f: ['F', 1, 'l', (v) => (v.kthread ? 1 : v.uid === 0 ? 4 : 0)], wchan: ['WCHAN', 6, 'l', () => '-'],
      start: ['STARTED', 8, 'r', (v, now) => strftime(now - v.start < DAY ? '%H:%M:%S' : '%b %d', v.start)], lstart: ['STARTED', 24, 'l', (v) => strftime('%a %b %e %H:%M:%S %Y', v.start)],
      stime: ['STIME', 5, 'r', (v, now) => startShort(v.start, now)], bsdstart: ['START', 5, 'r', (v, now) => startShort(v.start, now)],
      etime: ['ELAPSED', 11, 'r', (v, now) => elapsed(Math.max(0, Math.floor((now - v.start) / 1000)))], etimes: ['ELAPSED', 7, 'r', (v, now) => Math.max(0, Math.floor((now - v.start) / 1000))],
      time: ['TIME', 8, 'r', (v) => hms(v.time)], bsdtime: ['TIME', 6, 'r', (v) => bsdTime(v.time)], times: ['TIME', 8, 'r', (v) => Math.floor(v.time)],
      ni: ['NI', 3, 'r', (v) => v.ni], pri: ['PRI', 3, 'r', (v) => 19 - v.ni], opri: ['PRI', 3, 'r', (v) => 80 + v.ni], nlwp: ['NLWP', 4, 'r', (v) => v.nlwp], psr: ['PSR', 3, 'r', (v) => v.pid % 2],
      comm: ['COMMAND', 15, 'l', (v) => v.comm, 'tree'], ucmd: ['CMD', 15, 'l', (v) => v.comm, 'tree'], args: ['COMMAND', 27, 'l', (v) => v.cmd, 'tree'], cmd: ['CMD', 27, 'l', (v) => v.cmd, 'tree'],
      fname: ['COMMAND', 8, 'l', (v) => v.comm.slice(0, 8)],
    };
    const alias = { euser: 'user', uname: 'user', euid: 'uid', ruid: 'uid', egid: 'gid', egroup: 'group', pcpu: '%cpu', pmem: '%mem', vsize: 'vsz', rssize: 'rss', rsz: 'rss', tt: 'tty',
      state: 's', start_time: 'stime', cputime: 'time', nice: 'ni', thcount: 'nlwp', ucomm: 'comm', command: 'args', sess: 'sid', session: 'sid', pgrp: 'pgid' };
    for (const a of Object.keys(alias)) c[a] = c[alias[a]];
    return c;
  })();
  const PS_FORMATS = {
    default: 'pid,tname,time,ucmd', full: 'uid_hack,pid,ppid,c,stime,tname,time,cmd', extraFull: 'uid_hack,pid,ppid,c,sz,rss,psr,stime,tname,time,cmd',
    long: 'f,s,uid,pid,ppid,c,opri,ni,addr_sz,wchan,tname,time,ucmd', jobs: 'pid,pgid,sid,tname,time,ucmd',
    bsd: 'pid,bsdtty,stat,bsdtime,args', bsdUser: 'user,pid,%cpu,%mem,vsz,rss,bsdtty,stat,bsdstart,bsdtime,args', bsdJobs: 'ppid,pid,pgid,sid,bsdtty,tpgid,stat,uid,bsdtime,args',
  };
  const PS_USAGE = "\nUsage:\n ps [options]\n\n Try 'ps --help <simple|list|output|threads|misc|all>'\n  or 'ps --help <s|l|o|t|m|a>'\n for additional help text.\n\nFor more details see ps(1).\n";
  const PS_HELP_SIMPLE = '\nUsage:\n ps [options]\n\nBasic options:\n -A, -e               all processes\n -a                   all with tty, except session leaders\n  a                   all with tty, including other users\n' +
    ' -d                   all except session leaders\n -N, --deselect       negate selection\n  r                   only running processes\n  T                   all processes on this terminal\n' +
    '  x                   processes without controlling ttys\n\nFor more details see ps(1).\n';
  const PS_SORT_KEYS = { pid: (v) => v.pid, ppid: (v) => v.ppid, '%cpu': (v) => v.cpu, pcpu: (v) => v.cpu, '%mem': (v) => v.mem, pmem: (v) => v.mem, rss: (v) => v.rss, vsz: (v) => v.vsz,
    start_time: (v) => v.start, start: (v) => v.start, time: (v) => v.time, cputime: (v) => v.time, comm: (v) => v.comm, cmd: (v) => v.cmd, args: (v) => v.cmd, user: (v) => v.user, uid: (v) => v.uid, ni: (v) => v.ni };

  class PsError extends Error {}

  /** Turn ps's three option dialects (Unix -x, BSD x, GNU --x) into one request object. */
  function parsePs(args) {
    const q = { all: false, bsd: false, bsdAll: false, bsdNoTty: false, unixTty: false, notLeaders: false, running: false, negate: false, pids: [], ppids: [], users: [], names: [], ttys: [],
      format: null, custom: [], forest: false, hierarchy: false, headers: true, sort: [], wide: 0, help: null, version: false };
    const list = (text, what) => { const items = String(text).split(/[,\s]+/).filter(Boolean); if (!items.length) throw new PsError(what + ' list syntax error'); return items; };
    const pidList = (text) => list(text, 'process ID').map((x) => { if (!/^\d+$/.test(x)) throw new PsError('process ID list syntax error'); return +x; });
    const valued = {
      p: (v) => q.pids.push(...pidList(v)), q: (v) => q.pids.push(...pidList(v)), u: (v) => q.users.push(...list(v, 'user')), U: (v) => q.users.push(...list(v, 'user')),
      C: (v) => q.names.push(...list(v, 'command')), t: (v) => q.ttys.push(...list(v, 'TTY')), o: (v) => q.custom.push(v), k: (v) => q.sort.push(...list(v, 'sort')),
    };
    const long = {
      forest: () => { q.forest = true; }, deselect: () => { q.negate = true; }, 'no-headers': () => { q.headers = false; }, 'no-heading': () => { q.headers = false; }, noheader: () => { q.headers = false; },
      headers: () => {}, version: () => { q.version = true; }, info: () => { q.version = true; },
    };
    const longValued = { pid: valued.p, ppid: (v) => q.ppids.push(...pidList(v)), user: valued.u, User: valued.u, format: valued.o, sort: valued.k, tty: valued.t, cols: () => {}, columns: () => {}, width: () => {}, lines: () => {}, rows: () => {} };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('--')) {
        const eq = a.indexOf('='); const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
        if (name === 'help') { q.help = (eq < 0 ? args[i + 1] : a.slice(eq + 1)) || ''; return q; }
        if (long[name] && eq < 0) { long[name](); continue; }
        if (!longValued[name]) throw new PsError('unknown gnu long option');
        const v = eq < 0 ? args[++i] : a.slice(eq + 1);
        if (v == null) throw new PsError('option --' + name + ' requires an argument');
        longValued[name](v);
      } else if (a[0] === '-' && a.length > 1) {
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          if (ch === 'e' || ch === 'A') q.all = true;
          else if (ch === 'a') q.unixTty = true; else if (ch === 'd') q.notLeaders = true; else if (ch === 'N') q.negate = true;
          else if (ch === 'f') q.format = 'full'; else if (ch === 'F') q.format = 'extraFull'; else if (ch === 'l') q.format = 'long'; else if (ch === 'j') q.format = 'jobs';
          else if (ch === 'H') q.hierarchy = true; else if (ch === 'w') q.wide++; else if (ch === 'V') q.version = true;
          else if (ch === 'L' || ch === 'T' || ch === 'M' || ch === 'x') continue;
          else if (valued[ch] || ch === 'O') {
            const v = a.slice(j + 1) || args[++i];
            if (v == null) throw new PsError('option -' + ch + ' requires an argument');
            if (ch !== 'O') valued[ch](v);
            break;
          } else throw new PsError('unsupported SysV option');
        }
      } else if (/^\d[\d,]*$/.test(a)) q.pids.push(...pidList(a));
      else {
        q.bsd = true;
        for (let j = 0; j < a.length; j++) {
          const ch = a[j];
          if (ch === 'a') q.bsdAll = true; else if (ch === 'x') q.bsdNoTty = true; else if (ch === 'u') q.format = 'bsdUser'; else if (ch === 'j') q.format = 'bsdJobs';
          else if (ch === 'f') q.forest = true; else if (ch === 'w') q.wide++; else if (ch === 'h') q.headers = false; else if (ch === 'r') q.running = true;
          else if (ch === 'e' || ch === 'c' || ch === 'T' || ch === 'S') continue;
          else if (ch === 'V') q.version = true;
          else if ('optUk'.indexOf(ch) >= 0) {
            const v = a.slice(j + 1) || args[++i];
            if (v == null) throw new PsError('option ' + ch + ' requires an argument');
            valued[ch === 'U' ? 'u' : ch](v);
            break;
          } else throw new PsError('unsupported option (BSD syntax)');
        }
      }
    }
    return q;
  }

  function psColumns(q) {
    const specs = q.custom.length ? q.custom.join(',') : PS_FORMATS[q.format || (q.bsd ? 'bsd' : 'default')];
    const cols = [];
    // "pid=,comm=NAME": a header override runs to the end of its -o argument
    for (const chunk of q.custom.length ? q.custom : [specs]) {
      let rest = chunk;
      while (rest) {
        const m = /^[,\s]*([^,\s=:]+)(?::(\d+))?(?:=([^]*))?/.exec(rest);
        if (!m) break;
        const hasHeader = m[3] != null;
        let consumed = m[0].length;
        if (hasHeader && q.custom.length) { const comma = m[3].indexOf(','); if (comma >= 0 && PS_COLUMNS[m[3].slice(comma + 1).split(/[,=:\s]/)[0].toLowerCase()]) consumed -= m[3].length - comma; }
        const headerText = hasHeader ? rest.slice(m[0].length - m[3].length, consumed) : null;
        const def = PS_COLUMNS[m[1].toLowerCase()] || PS_COLUMNS[m[1]];
        if (!def) throw new PsError('unknown user-defined format specifier "' + m[1] + '"');
        const header = headerText != null ? headerText : def[0];
        cols.push({ header, width: Math.max(m[2] ? +m[2] : def[1], header.length), align: def[2], value: def[3], tree: def[4] === 'tree' });
        rest = rest.slice(consumed);
      }
    }
    return cols;
  }

  function psSelect(ctx, q, views) {
    const m = ctx.machine;
    const self = views.find((v) => v.pid === ctx.pid);
    const myTty = self ? self.tty : 'pts/0';
    const leader = (v) => /s/.test(v.stat);
    let pick;
    if (q.pids.length || q.ppids.length || q.users.length || q.names.length || q.ttys.length) {
      const users = q.users.map((u) => {
        if (/^\d+$/.test(u)) return m.userName(+u);
        if (!m.userByName(u) && !views.some((v) => v.user === u)) throw new PsError('user name does not exist');
        return u;
      });
      const ttys = q.ttys.map((t) => t.replace(/^\/dev\//, ''));
      for (const t of ttys) if (t !== '?' && t !== '-' && !/^(pts\/\d+|tty\d+|\d+)$/.test(t)) throw new PsError('TTY could not be found');
      pick = (v) => q.pids.indexOf(v.pid) >= 0 || q.ppids.indexOf(v.ppid) >= 0 || users.indexOf(v.user) >= 0 || q.names.indexOf(v.comm) >= 0 || ttys.indexOf(v.tty) >= 0;
    } else if (q.all || (q.bsdAll && q.bsdNoTty)) pick = () => true;
    else if (q.bsdAll) pick = (v) => v.tty !== '?';
    else if (q.bsdNoTty) pick = (v) => v.user === ctx.user.name;
    else if (q.unixTty) pick = (v) => v.tty !== '?' && !leader(v);
    else if (q.notLeaders) pick = (v) => !leader(v);
    else if (q.bsd) pick = (v) => v.user === ctx.user.name && v.tty !== '?';
    else pick = (v) => v.user === ctx.user.name && v.tty === myTty;
    return views.filter((v) => (q.negate ? !pick(v) : pick(v)) && (!q.running || v.stat[0] === 'R'));
  }

  /** Order processes as a tree and give each its "\_" prefix. Children of init start at the left margin, as in procps. */
  function psForest(views, hierarchy) {
    const byPid = new Map(views.map((v) => [v.pid, v]));
    const kids = new Map();
    const roots = [];
    for (const v of views) {
      if (v.ppid > 1 && byPid.has(v.ppid)) { if (!kids.has(v.ppid)) kids.set(v.ppid, []); kids.get(v.ppid).push(v); } else roots.push(v);
    }
    const order = (list) => list.sort((a, b) => a.start - b.start || a.pid - b.pid);
    // kthreadd and its threads come before init, the order procps prints
    roots.sort((a, b) => (b.pid === 2) - (a.pid === 2) || (b.pid === 1) - (a.pid === 1) || a.start - b.start || a.pid - b.pid);
    const out = [];
    const walk = (v, prefix, depth, last) => {
      v.tree = hierarchy ? '  '.repeat(depth) : depth ? prefix + ' \\_ ' : '';
      out.push(v);
      const children = order(kids.get(v.pid) || []);
      children.forEach((c, i) => walk(c, depth ? prefix + (last ? '    ' : ' |  ') : '', depth + 1, i === children.length - 1));
    };
    for (const r of roots) walk(r, '', 0, true);
    return out;
  }

  function psRender(ctx, q, cols, views) {
    const now = K.clock.now();
    const limit = ctx.isTTY && q.wide < 2 ? (q.wide ? Math.max(132, ctx.cols) : ctx.cols) : Infinity;
    const line = (cells) => cells.map((text, i) => {
      const c = cols[i]; const lastCol = i === cols.length - 1;
      if (lastCol && c.align === 'l') return text;
      if (c.align === 'l' && text.length > c.width) return text.slice(0, c.width);
      return c.align === 'r' ? text.padStart(c.width) : text.padEnd(c.width);
    }).join(' ').slice(0, limit);
    let text = '';
    if (q.headers && cols.some((c) => c.header)) text += line(cols.map((c) => c.header)) + '\n';
    for (const v of views) text += line(cols.map((c) => (c.tree && v.tree ? v.tree : '') + String(c.value(v, now)))) + '\n';
    ctx.out(text);
  }

  reg({
    name: 'ps', pkg: 'procps', summary: 'report a snapshot of the current processes.', synopsis: 'ps [options]',
    man: 'DESCRIPTION\n       ps displays information about a selection of the active processes. If you want a repetitive update of the selection and the displayed information, use top instead.\n\n       This version of ps accepts several kinds of options: UNIX options, which may be grouped and must be preceded by a dash; BSD options, which may be grouped and must not be used with a dash; and GNU long options, which are preceded by two dashes.\n\n       By default, ps selects all processes with the same effective user ID as the current user and associated with the same terminal as the invoker. It displays the process ID (pid=PID), the terminal associated with the process (tname=TTY), the cumulated CPU time in [DD-]hh:mm:ss format (time=TIME), and the executable name (ucmd=CMD).\n\nOPTIONS\n       -e, -A Select all processes.\n\n       a      Lift the BSD-style "only yourself" restriction. With x, select all processes.\n\n       x      Lift the BSD-style "must have a tty" restriction.\n\n       u      Display user-oriented format.\n\n       -f     Do full-format listing.\n\n       -l     Long format.\n\n       -u userlist\n              Select by effective user ID or name.\n\n       -p pidlist\n              Select by process ID.\n\n       -C cmdlist\n              Select by command name.\n\n       --ppid pidlist\n              Select by parent process ID.\n\n       -o format\n              User-defined format: a comma-separated list of columns such as pid, ppid, user, %cpu, %mem, vsz, rss, tty, stat, start, etime, time, comm and args. "pid=" hides a header, "pid=NAME" renames it.\n\n       --sort spec\n              Sort by the given keys, for example --sort=-%mem.\n\n       f, --forest\n              ASCII art process tree.\n\n       --no-headers\n              Print no header line at all.\n\nEXAMPLES\n       ps aux\n              Every process on the system in BSD syntax.\n       ps -ef --forest\n              Every process with its parent, drawn as a tree.\n       ps -u www-data -o pid,etime,args\n              Processes of one account with chosen columns.\n       ps aux --sort=-%mem | head\n              The processes using the most memory.',
    run(ctx) {
      let q; let cols; let views;
      try {
        q = parsePs(ctx.args);
        if (q.help != null) { ctx.out(q.help ? PS_HELP_SIMPLE : PS_USAGE); return 0; }
        if (q.version) { ctx.out('ps from procps-ng 4.0.4\n'); return 0; }
        cols = psColumns(q);
        views = psSelect(ctx, q, allProcs(ctx));
        for (const key of q.sort) if (!PS_SORT_KEYS[key.replace(/^[+-]/, '')]) throw new PsError('unknown sort specifier');
      } catch (e) {
        if (!(e instanceof PsError)) throw e;
        ctx.err('error: ' + e.message + '\n' + PS_USAGE);
        return 1;
      }
      views.sort((a, b) => a.pid - b.pid);
      for (const key of q.sort.slice().reverse()) {
        const get = PS_SORT_KEYS[key.replace(/^[+-]/, '')]; const dir = key[0] === '-' ? -1 : 1;
        views.sort((a, b) => { const x = get(a); const y = get(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
      }
      if (q.forest || q.hierarchy) views = psForest(views, q.hierarchy && !q.forest);
      psRender(ctx, q, cols, views);
      return views.length ? 0 : 1;
    },
  });

  /* ------------------------------------------------- pgrep, pkill, killall, pidof */

  const SIGNALS = ['HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM', 'STKFLT', 'CHLD', 'CONT', 'STOP', 'TSTP', 'TTIN', 'TTOU',
    'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'POLL', 'PWR', 'SYS'];
  /** "9", "KILL", "SIGKILL", "kill" -> "KILL"; null when it is not a signal. */
  function signalName(text) {
    const t = String(text).toUpperCase().replace(/^SIG/, '');
    if (/^\d+$/.test(t)) return +t === 0 ? '0' : SIGNALS[+t - 1] || null;
    return SIGNALS.indexOf(t) >= 0 ? t : null;
  }

  /**
   * Deliver a signal the way kill(2) would: 'ok', or 'eperm' when the caller may not signal the process.
   * The shell's kill builtin does the work, so jobs, units and the process table stay consistent.
   */
  async function sendSignal(ctx, view, signal) {
    if (!ctx.isRoot && view.user !== ctx.user.name) return 'eperm';
    // kernel threads, init and the shells this command runs under ignore the signal
    const shells = []; for (let sh = ctx.shell; sh; sh = sh.parent) shells.push(sh.pid);
    if (signal === '0' || view.kthread || view.pid === 1 || shells.indexOf(view.pid) >= 0) return 'ok';
    await ctx.run(['kill', '-' + signal, String(view.pid)]);
    return 'ok';
  }

  const PGREP_OPTIONS = ' -d, --delimiter <string>  specify output delimiter\n -l, --list-name           list PID and process name\n -a, --list-full           list PID and full command line\n' +
    ' -v, --inverse             negates the matching\n -w, --lightweight         list all TID\n -c, --count               count of matching processes\n -f, --full                use full process name to match\n' +
    ' -g, --pgroup <PGID,...>   match listed process group IDs\n -G, --group <GID,...>     match real group IDs\n -i, --ignore-case         match case insensitively\n' +
    ' -n, --newest              select most recently started\n -o, --oldest              select least recently started\n -O, --older <seconds>     select where older than seconds\n' +
    ' -P, --parent <PPID,...>   match only child processes of the given parent\n -s, --session <SID,...>   match session IDs\n     --signal <sig>        signal to send (either number or name)\n' +
    ' -t, --terminal <tty,...>  match by controlling terminal\n -u, --euid <ID,...>       match by effective IDs\n -U, --uid <ID,...>        match by real IDs\n' +
    ' -x, --exact               match exactly with the command name\n -F, --pidfile <file>      read PIDs from file\n -L, --logpidfile          fail if PID file is not locked\n' +
    ' -r, --runstates <state>   match runstates [D,S,Z,...]\n -A, --ignore-ancestors    exclude our ancestors from results\n --cgroup <grp,...>        match by cgroup v2 names\n' +
    ' --ns <PID>                match the processes that belong to the same\n                           namespace as <pid>\n --nslist <ns,...>         list which namespaces will be considered for\n' +
    '                           the --ns option.\n                           Available namespaces: ipc, mnt, net, pid, user, uts\n\n -h, --help     display this help and exit\n -V, --version  output version information and exit\n';
  const pgrepUsage = (name) => '\nUsage:\n ' + name + ' [options] <pattern>\n\nOptions:\n' +
    (name === 'pkill' ? ' -<sig>                    signal to send (either number or name)\n -H, --require-handler     match only if signal handler is present\n -q, --queue <value>       integer value to be sent with the signal\n -e, --echo                display what is killed\n' : '') +
    PGREP_OPTIONS.replace(name === 'pkill' ? /^ -[dla],.*\n/gm : /^$/, '') + '\nFor more details see pgrep(1).\n';

  /** Shared matcher of pgrep and pkill. Returns { views, o } or an exit status after printing an error. */
  function pgrepMatch(ctx, args) {
    const name = ctx.name;
    const hint = "\nTry `" + name + " --help' for more information.\n";
    const g = K.getopt(args, { short: 'd:lavwcfg:G:inoO:P:s:t:u:U:xF:Lr:AhVe', long: ['delimiter=', 'list-name', 'list-full', 'inverse', 'lightweight', 'count', 'full', 'pgroup=', 'group=', 'ignore-case', 'newest', 'oldest',
      'older=', 'parent=', 'session=', 'signal=', 'terminal=', 'euid=', 'uid=', 'exact', 'help', 'version', 'echo'],
      alias: { delimiter: 'd', 'list-name': 'l', 'list-full': 'a', inverse: 'v', count: 'c', full: 'f', 'ignore-case': 'i', newest: 'n', oldest: 'o', parent: 'P', terminal: 't', euid: 'u', uid: 'U', exact: 'x', help: 'h', version: 'V', echo: 'e' } });
    if (g.err) { ctx.err(name + ': ' + g.err + '\n' + pgrepUsage(name)); return 2; }
    const o = g.opts; const m = ctx.machine;
    if (o.h) { ctx.out(pgrepUsage(name)); return 0; }
    if (o.V) { ctx.out(name + ' from procps-ng 4.0.4\n'); return 0; }
    if (g.rest.length > 1) { ctx.err(name + ': only one pattern can be provided' + hint); return 2; }
    const criteria = o.u != null || o.U != null || o.P != null || o.t != null;
    if (!g.rest.length && !criteria) { ctx.err(name + ': no matching criteria specified' + hint); return 2; }
    let users = null;
    if (o.u != null || o.U != null) {
      users = [];
      for (const u of String(o.u != null ? o.u : o.U).split(',')) {
        const user = /^\d+$/.test(u) ? m.userByUid(+u) : m.userByName(u);
        if (!user && !m.procs.some((p) => p.user === u)) { ctx.err(name + ': invalid user name: ' + u + '\n'); return 2; }
        users.push(user ? user.name : u);
      }
    }
    let re = null;
    if (g.rest.length) {
      const pattern = g.rest[0];
      if (!o.f && pattern.length > 15) ctx.err(name + ': pattern that searches for process name longer than 15 characters will result in zero matches\nTry `' + name + " -f' option to match against the complete command line.\n");
      try { re = new RegExp(o.x ? '^(?:' + pattern + ')$' : pattern, o.i ? 'i' : ''); } catch (e) { ctx.err(name + ': regex error: Invalid regular expression\n'); return 2; }
    }
    const parents = o.P != null ? String(o.P).split(',').map(Number) : null;
    const ttys = o.t != null ? String(o.t).split(',') : null;
    let views = allProcs(ctx).filter((v) => v.pid !== ctx.pid).filter((v) => {
      const hit = (!re || re.test(o.f ? v.cmd : v.comm)) && (!users || users.indexOf(v.user) >= 0) &&
        (!parents || parents.indexOf(v.ppid) >= 0) && (!ttys || ttys.indexOf(v.tty) >= 0);
      return o.v ? !hit : hit;
    }).sort((a, b) => a.pid - b.pid);
    if ((o.n || o.o) && views.length) {
      const pickNewest = !!o.n;
      views = [views.reduce((best, v) => ((pickNewest ? v.start > best.start || (v.start === best.start && v.pid > best.pid) : v.start < best.start) ? v : best))];
    }
    return { views, o };
  }

  reg({
    name: 'pgrep', pkg: 'procps', summary: 'look up processes based on name and other attributes', synopsis: 'pgrep [options] pattern',
    man: 'DESCRIPTION\n       pgrep looks through the currently running processes and lists the process IDs which match the selection criteria to stdout. All the criteria have to match. The pattern is an extended regular expression matched against the process name, or against the whole command line with -f.\n\nOPTIONS\n       -l, --list-name\n              List the process name as well as the process ID.\n\n       -a, --list-full\n              List the full command line as well as the process ID.\n\n       -c, --count\n              Suppress normal output; instead print a count of matching processes.\n\n       -f, --full\n              The pattern is normally only matched against the process name. When -f is set, the full command line is used.\n\n       -u, --euid euid,...\n              Only match processes whose effective user ID is listed. Either the numerical or symbolical value may be used.\n\n       -x, --exact\n              Only match processes whose names (or command lines if -f is specified) exactly match the pattern.\n\n       -n, --newest\n              Select only the newest (most recently started) of the matching processes.\n\n       -o, --oldest\n              Select only the oldest (least recently started) of the matching processes.\n\n       -P, --parent ppid,...\n              Only match processes whose parent process ID is listed.\n\n       -v, --inverse\n              Negates the matching.\n\nEXIT STATUS\n       0      One or more processes matched the criteria.\n       1      No processes matched.\n       2      Syntax error in the command line.\n\nEXAMPLES\n       pgrep -l ssh\n              PIDs and names of processes whose name contains ssh.\n       pgrep -u root -a cron\n              cron processes owned by root, with their command lines.',
    run(ctx) {
      const r = pgrepMatch(ctx, ctx.args);
      if (typeof r === 'number') return r;
      const { views, o } = r;
      if (o.c) { ctx.println(views.length); return views.length ? 0 : 1; }
      if (!views.length) return 1;
      const sep = o.d != null ? o.d : '\n';
      ctx.println(views.map((v) => v.pid + (o.a ? ' ' + v.cmd : o.l ? ' ' + v.comm : '')).join(sep));
      return 0;
    },
  });

  reg({
    name: 'pkill', pkg: 'procps', summary: 'signal processes based on name and other attributes', synopsis: 'pkill [options] pattern',
    man: 'DESCRIPTION\n       pkill will send the specified signal (by default SIGTERM) to each process instead of listing them on stdout. Processes are selected exactly as pgrep selects them.\n\nOPTIONS\n       -signal, --signal signal\n              Defines the signal to send to each matched process. Either the numeric or the symbolic signal name can be used.\n\n       -e, --echo\n              Display what is killed.\n\n       -f, --full\n              Match against the full command line.\n\n       -u, --euid euid,...\n              Only match processes whose effective user ID is listed.\n\n       -x, --exact\n              Only match processes whose names exactly match the pattern.\n\nEXIT STATUS\n       0      One or more processes matched the criteria and were signalled.\n       1      No processes matched or none of them could be signalled.\n       2      Syntax error in the command line.\n\nEXAMPLES\n       pkill -f "python3 -m http.server"\n              Stop a web server you started earlier, matching on its command line.\n       sudo pkill -HUP sshd\n              Ask sshd to reload its configuration.',
    async run(ctx) {
      const args = ctx.args.slice(); let signal = 'TERM';
      if (args.length && /^-[A-Za-z0-9]+$/.test(args[0]) && signalName(args[0].slice(1)) && !/^-[dlavwcfinoxLAhVe]+$/.test(args[0])) signal = signalName(args.shift().slice(1));
      const at = args.findIndex((a) => a === '--signal' || a.startsWith('--signal='));
      if (at >= 0) {
        const value = args[at] === '--signal' ? args[at + 1] : args[at].slice(9);
        if (!signalName(value || '')) { ctx.err('pkill: Unknown signal "' + (value || '') + '".\n' + pgrepUsage('pkill')); return 2; }
        signal = signalName(value);
        args.splice(at, args[at] === '--signal' ? 2 : 1);
      }
      const r = pgrepMatch(ctx, args);
      if (typeof r === 'number') return r;
      let killed = 0;
      for (const v of r.views) {
        if ((await sendSignal(ctx, v, signal)) === 'eperm') { ctx.err('pkill: killing pid ' + v.pid + ' failed: Operation not permitted\n'); continue; }
        killed++;
        if (r.o.e) ctx.println(v.comm + ' killed (pid ' + v.pid + ')');
      }
      return killed ? 0 : 1;
    },
  });

  const KILLALL_USAGE = 'Usage: killall [OPTION]... [--] NAME...\n       killall -l, --list\n       killall -V, --version\n\n  -e,--exact          require exact match for very long names\n' +
    '  -I,--ignore-case    case insensitive process name match\n  -g,--process-group  kill process group instead of process\n  -y,--younger-than   kill processes younger than TIME\n' +
    '  -o,--older-than     kill processes older than TIME\n  -i,--interactive    ask for confirmation before killing\n  -l,--list           list all known signal names\n' +
    "  -q,--quiet          don't print complaints\n  -r,--regexp         interpret NAME as an extended regular expression\n  -s,--signal SIGNAL  send this signal instead of SIGTERM\n" +
    '  -u,--user USER      kill only process(es) running as USER\n  -v,--verbose        report if the signal was successfully sent\n  -V,--version        display version information\n' +
    '  -w,--wait           wait for processes to die\n  -n,--ns PID         match processes that belong to the same namespaces\n                      as PID\n' +
    '  -Z,--context REGEXP kill only process(es) having context\n                      (must precede other arguments)\n\n';

  reg({
    name: 'killall', pkg: 'psmisc', summary: 'kill processes by name', synopsis: 'killall [-eIgiqrvw] [-s signal] [-u user] [--] name ...',
    man: 'DESCRIPTION\n       killall sends a signal to all processes running any of the specified commands. If no signal name is specified, SIGTERM is sent. Signals can be specified either by name (e.g. -HUP or -SIGHUP) or by number (e.g. -1) or by option -s.\n\n       killall returns a zero return code if at least one process has been killed for each listed command. killall returns non-zero otherwise.\n\nOPTIONS\n       -I, --ignore-case\n              Do case insensitive process name match.\n\n       -l, --list\n              List all known signal names.\n\n       -q, --quiet\n              Do not complain if no processes were killed.\n\n       -r, --regexp\n              Interpret process name pattern as a POSIX extended regular expression.\n\n       -s, --signal signal\n              Send this signal instead of SIGTERM.\n\n       -u, --user user\n              Kill only processes the specified user owns. Command names are optional.\n\n       -v, --verbose\n              Report if the signal was successfully sent.\n\nEXAMPLES\n       killall sleep\n              Send SIGTERM to every process named sleep.\n       sudo killall -9 apache2\n              Kill every apache2 process at once. systemd then marks the service as failed.',
    async run(ctx) {
      const args = ctx.args.slice(); let signal = 'TERM';
      const sigAt = args.findIndex((a) => /^-[A-Za-z0-9]+$/.test(a) && signalName(a.slice(1)) && !/^-[eIgiqrvwlVu]+$/.test(a));
      if (sigAt >= 0) signal = signalName(args.splice(sigAt, 1)[0].slice(1));
      const g = K.getopt(args, { short: 'eIgy:o:ilqrs:u:vVwn:Z:', long: ['exact', 'ignore-case', 'process-group', 'younger-than=', 'older-than=', 'interactive', 'list', 'quiet', 'regexp', 'signal=', 'user=', 'verbose', 'version', 'wait', 'ns=', 'context='],
        alias: { 'ignore-case': 'I', list: 'l', quiet: 'q', regexp: 'r', signal: 's', user: 'u', verbose: 'v', version: 'V' } });
      if (g.err) { ctx.err('killall: ' + g.err + '\n' + KILLALL_USAGE); return 1; }
      const o = g.opts;
      if (o.l) { ctx.out(SIGNALS.slice(0, 16).join(' ') + '\n' + SIGNALS.slice(16).join(' ') + '\n'); return 0; }
      if (o.V) { ctx.err('killall (PSmisc) 23.7\nCopyright (C) 1993-2024 Werner Almesberger and Craig Small\n\nPSmisc comes with ABSOLUTELY NO WARRANTY.\nThis is free software, and you are welcome to redistribute it under\nthe terms of the GNU General Public License.\nFor more information about these matters, see the files named COPYING.\n'); return 0; }
      if (o.s != null) { signal = signalName(o.s); if (!signal) { ctx.err(o.s + ': unknown signal; killall -l lists signals.\n'); return 1; } }
      if (o.u != null && !ctx.machine.userByName(o.u) && !ctx.machine.procs.some((p) => p.user === o.u)) { ctx.err('Cannot find user ' + o.u + '\n'); return 1; }
      if (!g.rest.length && o.u == null) { ctx.err(KILLALL_USAGE); return 1; }
      const views = allProcs(ctx).filter((v) => v.pid !== ctx.pid && (o.u == null || v.user === o.u));
      let status = 0;
      for (const name of g.rest.length ? g.rest : [null]) {
        let test = () => true;
        if (name != null && o.r) { let re; try { re = new RegExp(name, o.I ? 'i' : ''); } catch (e) { ctx.err('killall: Bad regular expression: ' + name + '\n'); return 1; } test = (v) => re.test(v.comm); }
        else if (name != null) test = (v) => (o.I ? v.comm.toLowerCase() === name.toLowerCase().slice(0, 15) : v.comm === name.slice(0, 15));
        let killed = 0;
        for (const v of views.filter(test)) {
          if ((await sendSignal(ctx, v, signal)) === 'eperm') { ctx.err(v.comm + '(' + v.pid + '): Operation not permitted\n'); continue; }
          killed++;
          if (o.v) ctx.err('Killed ' + v.comm + '(' + v.pid + ') with signal ' + (signal === '0' ? 0 : SIGNALS.indexOf(signal) + 1) + '\n');
        }
        if (!killed) { status = 1; if (!o.q) ctx.err((name == null ? o.u : name) + ': no process found\n'); }
      }
      return status;
    },
  });

  const PIDOF_USAGE = 'pidof usage: [options] <program-name>\n\n -c           Return PIDs with the same root directory\n -d <sep>     Use the provided character as output separator\n -h           Display this help text\n' +
    ' -n           Avoid using stat system function on network shares\n -o <pid>     Omit results with a given PID\n -q           Quiet mode. Do not display output\n -s           Only return one PID\n' +
    ' -x           Return PIDs of shells running scripts with a matching name\n -z           List zombie and I/O waiting processes. May cause pidof to hang.\n\n';

  reg({
    name: 'pidof', pkg: 'sysvinit-utils', summary: 'find the process ID of a running program', synopsis: 'pidof [-s] [-c] [-n] [-x] [-z] [-o omitpid[,omitpid...]] [-d sep] program [program...]',
    man: 'DESCRIPTION\n       pidof finds the process id\'s (PIDs) of the named programs. It prints those id\'s on the standard output.\n\nOPTIONS\n       -s     Single shot - this instructs the program to only return one pid.\n\n       -o omitpid\n              Tells pidof to omit processes with that process id.\n\n       -d sep Tells pidof to use sep as an output separator if more than one PID is shown. The default separator is a space.\n\n       -q     Do not display matched PIDs to standard out. Simply exit with a status of true or false to indicate whether a matching PID was found.\n\nEXIT STATUS\n       0      At least one program was found with the requested name.\n       1      No program was found with the requested name.\n\nEXAMPLES\n       pidof cron\n              Print the PID of the cron daemon.\n       kill $(pidof -s sleep)\n              Stop one sleep process by name.',
    run(ctx) {
      const g = ctx.getopt({ short: 'cd:hno:qsxz' });
      if (g.err) { ctx.err('pidof: ' + g.err + '\n' + PIDOF_USAGE); return 1; }
      if (g.opts.h) { ctx.out(PIDOF_USAGE); return 0; }
      const omit = (g.all.o || []).join(',').split(',').filter(Boolean).map((x) => (x === '%PPID' ? ctx.shell.pid : +x));
      const views = allProcs(ctx).filter((v) => v.pid !== ctx.pid && omit.indexOf(v.pid) < 0 && !v.kthread);
      const found = [];
      for (const name of g.rest) {
        const base = K.VFS.basename(name);
        const hits = views.filter((v) => v.comm === base.slice(0, 15) || v.cmd.split(' ')[0] === name).sort((a, b) => b.pid - a.pid);
        found.push(...(g.opts.s ? hits.slice(0, 1) : hits));
      }
      if (!found.length) return 1;
      if (!g.opts.q) ctx.println(found.map((v) => v.pid).join(g.opts.d != null ? g.opts.d : ' '));
      return 0;
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
