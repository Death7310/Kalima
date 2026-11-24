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
    const where = 'TTY=' + ((sh && sh.tty) || 'pts/0') + ' ; PWD=' + e.cwd + ' ; USER=' + target.name + ' ; COMMAND=' + command;
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
    const words = text.replace(/(\d)t(\d)/, '$1 $2').replace(/(^|\s)([+-])\s+(\d)/g, '$1$2$3').replace(/,/g, ' ').split(/\s+/).filter(Boolean);
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
      if ((m = /^(\d{1,2})\s*([ap])m$/.exec(w)) && +m[1] >= 1 && +m[1] <= 12) { time = [(+m[1] % 12) + (m[2] === 'p' ? 12 : 0), 0, 0]; continue; }
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
    for (const k of ['HOME', 'USER', 'LOGNAME', 'PWD', 'SHLVL']) if (!(k in env)) child.unsetVar(k);
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

  /* ------------------------------------------------------ small system info */

  reg({
    name: 'arch', pkg: 'coreutils', summary: 'print machine hardware name (same as uname -m)', synopsis: 'arch [OPTION]...',
    man: 'DESCRIPTION\n       Print machine architecture.\n\n       --help display this help and exit\n\n       --version\n              output version information and exit\n\nEXAMPLES\n       arch\n              Print x86_64 on a 64-bit PC.',
    run(ctx) {
      const g = ctx.getopt({ long: ['help', 'version'] });
      if (g.err) return usageError(ctx, g.err);
      if (g.opts.help) { ctx.out(coreutilsHelp('arch', 'Usage: arch [OPTION]...\nPrint machine architecture.\n\n      --help        display this help and exit\n      --version     output version information and exit\n')); return 0; }
      if (g.opts.version) { ctx.out(coreutilsVersion('arch', 'David MacKenzie and Karel Zak')); return 0; }
      if (g.rest.length) return usageError(ctx, "extra operand '" + g.rest[0] + "'");
      ctx.println(K.distro.arch);
      return 0;
    },
  });

  reg({
    name: 'nproc', pkg: 'coreutils', summary: 'print the number of processing units available', synopsis: 'nproc [OPTION]...',
    man: 'DESCRIPTION\n       Print the number of processing units available to the current process, which may be less than the number of online processors.\n\nOPTIONS\n       --all  print the number of installed processors\n\n       --ignore=N\n              if possible, exclude N processing units\n\n       --help display this help and exit\n\n       --version\n              output version information and exit\n\nEXAMPLES\n       nproc\n              Print the number of CPUs, e.g. to choose how many threads a cracking tool gets.',
    run(ctx) {
      const g = ctx.getopt({ long: ['all', 'ignore=', 'help', 'version'] });
      if (g.err) return usageError(ctx, g.err);
      if (g.opts.help) { ctx.out(coreutilsHelp('nproc', 'Usage: nproc [OPTION]...\nPrint the number of processing units available to the current process,\nwhich may be less than the number of online processors\n\n      --all      print the number of installed processors\n      --ignore=N  if possible, exclude N processing units\n      --help        display this help and exit\n      --version     output version information and exit\n')); return 0; }
      if (g.opts.version) { ctx.out(coreutilsVersion('nproc', 'Giuseppe Scrivano')); return 0; }
      if (g.rest.length) return usageError(ctx, "extra operand '" + g.rest[0] + "'");
      let skip = 0;
      if (g.opts.ignore != null) {
        if (!/^\d+$/.test(g.opts.ignore)) return ctx.fail("invalid number: '" + g.opts.ignore + "'", 1);
        skip = +g.opts.ignore;
      }
      let cpus = 1;
      try { cpus = (ctx.fs.read('/proc/cpuinfo').match(/^processor/gm) || []).length || 1; } catch (e) { /* no cpuinfo: one CPU */ }
      ctx.println(Math.max(1, cpus - skip));
      return 0;
    },
  });

  reg({
    name: 'tty', pkg: 'coreutils', summary: 'print the file name of the terminal connected to standard input', synopsis: 'tty [OPTION]...',
    man: 'DESCRIPTION\n       Print the file name of the terminal connected to standard input.\n\nOPTIONS\n       -s, --silent, --quiet\n              print nothing, only return an exit status\n\n       --help display this help and exit\n\n       --version\n              output version information and exit\n\nEXIT STATUS\n       0 if standard input is a terminal, 1 if not, 2 for a wrong option.\n\nEXAMPLES\n       tty\n              Print /dev/pts/0 in a terminal window.',
    run(ctx) {
      const g = ctx.getopt({ short: 's', long: ['silent', 'quiet', 'help', 'version'], alias: { silent: 's', quiet: 's' } });
      if (g.err) { ctx.err('tty: ' + g.err + "\nTry 'tty --help' for more information.\n"); return 2; }
      if (g.opts.help) { ctx.out(coreutilsHelp('tty', 'Usage: tty [OPTION]...\nPrint the file name of the terminal connected to standard input.\n\n  -s, --silent, --quiet   print nothing, only return an exit status\n      --help        display this help and exit\n      --version     output version information and exit\n')); return 0; }
      if (g.opts.version) { ctx.out(coreutilsVersion('tty', 'David MacKenzie')); return 0; }
      if (g.rest.length) { ctx.err("tty: extra operand '" + g.rest[0] + "'\nTry 'tty --help' for more information.\n"); return 2; }
      if (!ctx.stdinTTY) { if (!g.opts.s) ctx.println('not a tty'); return 1; }
      if (!g.opts.s) ctx.println('/dev/' + ((ctx.shell && ctx.shell.tty) || 'pts/0'));
      return 0;
    },
  });

  const LSB_USAGE = 'Usage: lsb_release [options]\n\nOptions:\n  -h, --help         show this help message and exit\n  -v, --version      show LSB modules this system supports\n  -i, --id           show distributor ID\n  -d, --description  show description of this distribution\n  -r, --release      show release number of this distribution\n  -c, --codename     show code name of this distribution\n  -a, --all          show all of the above information\n  -s, --short        show requested information in a short format\n';

  reg({
    name: 'lsb_release', pkg: 'lsb-release', summary: 'print distribution-specific information', synopsis: 'lsb_release [OPTION]...',
    man: 'DESCRIPTION\n       The lsb_release command provides certain LSB (Linux Standard Base) and distribution-specific information.\n\nOPTIONS\n       -v, --version\n              Display the version of the LSB specification against which the distribution is compliant.\n\n       -i, --id\n              Display the string, referred to as the distributor ID.\n\n       -d, --description\n              Display the single line text description of the distribution.\n\n       -r, --release\n              Display the release number of the distribution.\n\n       -c, --codename\n              Display the codename according to the distribution release.\n\n       -a, --all\n              Display all of the above information.\n\n       -s, --short\n              Use a short output format for the other options.\n\nEXAMPLES\n       lsb_release -a\n              Show which Kali release this is.\n       lsb_release -ds\n              Print only the description.',
    run(ctx) {
      const g = ctx.getopt({ short: 'hvidrcas', long: ['help', 'version', 'id', 'description', 'release', 'codename', 'all', 'short'], alias: { help: 'h', version: 'v', id: 'i', description: 'd', release: 'r', codename: 'c', all: 'a', short: 's' } });
      if (g.err) { ctx.err('Usage: lsb_release [options]\n\nlsb_release: error: ' + g.err.replace(/^unrecognized option '(.*)'$/, 'no such option: $1').replace(/^invalid option -- '(.)'$/, 'no such option: -$1') + '\n'); return 2; }
      if (g.opts.h) { ctx.out(LSB_USAGE); return 0; }
      const fields = [['i', 'Distributor ID', 'Kali'], ['d', 'Description', K.distro.pretty], ['r', 'Release', K.distro.release], ['c', 'Codename', K.distro.codename]];
      const picked = fields.some((f) => g.opts[f[0]]);
      if (g.opts.v || !picked && !g.opts.a) ctx.println(g.opts.s ? 'n/a' : 'No LSB modules are available.');
      else if (g.opts.a) ctx.err('No LSB modules are available.\n');
      for (const [k, label, value] of fields) {
        if (!g.opts[k] && !g.opts.a) continue;
        ctx.println(g.opts.s ? value : label + ':\t' + value);
      }
      return 0;
    },
  });

  /* -------------------------------------------------------------------- free */

  const FREE_USAGE = '\nUsage:\n free [options]\n\nOptions:\n -b, --bytes         show output in bytes\n     --kilo          show output in kilobytes\n     --mega          show output in megabytes\n     --giga          show output in gigabytes\n     --tera          show output in terabytes\n     --peta          show output in petabytes\n -k, --kibi          show output in kibibytes\n -m, --mebi          show output in mebibytes\n -g, --gibi          show output in gibibytes\n     --tebi          show output in tebibytes\n     --pebi          show output in pebibytes\n -h, --human         show human-readable output\n     --si            use powers of 1000 not 1024\n -l, --lohi          show detailed low and high memory statistics\n -L, --line          show output on a single line\n -t, --total         show total for RAM + swap\n -v, --committed     show committed memory and commit limit\n -s N, --seconds N   repeat printing every N seconds\n -c N, --count N     repeat printing N times, then exit\n     --wide          wide output\n\n     --help     display this help and exit\n -V, --version  output version information and exit\n\nFor more details see free(1).\n';

  function memInfo(ctx) {
    const kb = {};
    for (const line of ctx.fs.read('/proc/meminfo').split('\n')) { const m = /^(\w+):\s+(\d+)/.exec(line); if (m) kb[m[1]] = +m[2]; }
    const cache = (kb.Cached || 0) + (kb.SReclaimable || 0);
    return { total: kb.MemTotal, free: kb.MemFree, shared: kb.Shmem || 0, buffers: kb.Buffers || 0, cache, available: kb.MemAvailable,
      used: kb.MemTotal - kb.MemAvailable, swapTotal: kb.SwapTotal || 0, swapFree: kb.SwapFree || 0 };
  }

  function humanBytes(bytes, base) {
    const names = base === 1000 ? ['B', 'kB', 'MB', 'GB', 'TB', 'PB'] : ['B', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi'];
    let i = 0; let v = bytes;
    const shown = () => (v < 10 ? (Math.round(v * 10) / 10).toFixed(1) : String(Math.round(v)));
    while (i < names.length - 1 && (i ? +shown() : v) >= base) { v /= base; i++; }
    return (i ? shown() : String(Math.round(v))) + names[i];
  }

  const FREE_UNITS = { b: 1, bytes: 1, kilo: 1000, mega: 1e6, giga: 1e9, tera: 1e12, peta: 1e15, k: 1024, kibi: 1024, m: 1048576, mebi: 1048576, g: 1073741824, gibi: 1073741824, tebi: 2 ** 40, pebi: 2 ** 50 };

  reg({
    name: 'free', pkg: 'procps', summary: 'Display amount of free and used memory in the system', synopsis: 'free [options]',
    man: 'DESCRIPTION\n       free displays the total amount of free and used physical and swap memory in the system, as well as the buffers and caches used by the kernel. The information is gathered by parsing /proc/meminfo.\n\nOPTIONS\n       -b, --bytes\n              Display the amount of memory in bytes.\n\n       -k, --kibi\n              Display the amount of memory in kibibytes. This is the default.\n\n       -m, --mebi\n              Display the amount of memory in mebibytes.\n\n       -g, --gibi\n              Display the amount of memory in gibibytes.\n\n       -h, --human\n              Show all output fields automatically scaled to shortest three digit unit and display the units of print out.\n\n       -t, --total\n              Display a line showing the column totals.\n\n       -s, --seconds seconds\n              Continuously display the result delay seconds apart.\n\n       -c, --count count\n              Display the result count times. Requires the -s option.\n\n       --wide Switch to the wide mode, with separate buffers and cache columns.\n\nEXAMPLES\n       free -h\n              Memory in human readable units.\n       free -m -s 2 -c 3\n              Print three samples, two seconds apart.',
    async run(ctx) {
      const g = ctx.getopt({ short: 'bkmghlLtvVws:c:', long: ['bytes', 'kilo', 'mega', 'giga', 'tera', 'peta', 'kibi', 'mebi', 'gibi', 'tebi', 'pebi', 'human', 'si', 'lohi', 'line', 'total', 'committed', 'seconds=', 'count=', 'wide', 'help', 'version'],
        alias: { bytes: 'b', kibi: 'k', mebi: 'm', gibi: 'g', human: 'h', lohi: 'l', line: 'L', total: 't', committed: 'v', seconds: 's', count: 'c', version: 'V', wide: 'w' } });
      if (g.err) { ctx.err('free: ' + g.err + '\n' + FREE_USAGE); return 1; }
      if (g.opts.help) { ctx.out(FREE_USAGE); return 0; }
      if (g.opts.V) { ctx.out('free from procps-ng 4.0.4\n'); return 0; }
      if (g.rest.length) { ctx.err('free: ' + "extra operand '" + g.rest[0] + "'\n" + FREE_USAGE); return 1; }
      let div = 1024; let human = false;
      for (const k of Object.keys(FREE_UNITS)) if (g.opts[k]) div = FREE_UNITS[k];
      if (g.opts.h) human = true;
      const si = !!g.opts.si;
      if (si && div === 1024) div = 1000;
      const delay = g.opts.s != null ? Number(g.opts.s) : 0;
      if (g.opts.s != null && !(delay > 0)) { ctx.err('free: seconds argument `' + g.opts.s + "' failed\n"); return 1; }
      let count = g.opts.c != null ? parseInt(g.opts.c, 10) : delay ? Infinity : 1;
      if (g.opts.c != null && !(count > 0)) { ctx.err('free: failed to parse count argument: \'' + g.opts.c + "'\n"); return 1; }
      const cell = (kb) => {
        const bytes = kb * 1024;
        if (human) return humanBytes(bytes, si ? 1000 : 1024);
        return String(Math.floor(bytes / div));
      };
      const row = (label, vals) => label.padEnd(8) + vals.map((v) => U.padStart(v, 12)).join('').slice(0);
      const frame = () => {
        const m = memInfo(ctx); const wide = !!g.opts.w;
        const head = wide ? ['total', 'used', 'free', 'shared', 'buffers', 'cache', 'available'] : ['total', 'used', 'free', 'shared', 'buff/cache', 'available'];
        const lines = [row('', head)];
        const memVals = wide ? [m.total, m.used, m.free, m.shared, m.buffers, m.cache, m.available] : [m.total, m.used, m.free, m.shared, m.buffers + m.cache, m.available];
        lines.push(row('Mem:', memVals.map(cell)));
        const swapUsed = m.swapTotal - m.swapFree;
        lines.push(row('Swap:', [m.swapTotal, swapUsed, m.swapFree].map(cell)));
        if (g.opts.t) lines.push(row('Total:', [m.total + m.swapTotal, m.used + swapUsed, m.free + m.swapFree].map(cell)));
        return lines.join('\n') + '\n';
      };
      for (let n = 0; n < count; n++) {
        if (n) ctx.out('\n');
        ctx.out(frame());
        if (n + 1 < count) await ctx.sleep(delay * 1000);
      }
      return 0;
    },
  });

  /* ------------------------------------------------------- who, w, users, last */

  const loginsOf = (machine) => machine.state.logins || [];
  const whoTime = (ms) => U.isoDate(ms).slice(0, 16);
  const idleText = (sec) => (sec < 60 ? '0.00s' : sec < 3600 ? Math.floor(sec / 60) + ':' + U.pad2(sec % 60) : Math.floor(sec / 3600) + ':' + U.pad2(Math.floor(sec / 60) % 60) + 'm');

  reg({
    name: 'users', pkg: 'coreutils', summary: 'print the user names of users currently logged in to the current host', synopsis: 'users [OPTION]... [FILE]',
    man: 'DESCRIPTION\n       Output who is currently logged in according to FILE. If FILE is not specified, use /var/run/utmp.\n\n       --help display this help and exit\n\n       --version\n              output version information and exit\n\nEXAMPLES\n       users\n              Print the login names of everyone logged in.',
    run(ctx) {
      const g = ctx.getopt({ long: ['help', 'version'] });
      if (g.err) return usageError(ctx, g.err);
      if (g.opts.help) { ctx.out(coreutilsHelp('users', 'Usage: users [OPTION]... [FILE]\nOutput who is currently logged in according to FILE.\nIf FILE is not specified, use /var/run/utmp.  /var/log/wtmp as FILE is common.\n\n      --help        display this help and exit\n      --version     output version information and exit\n')); return 0; }
      if (g.opts.version) { ctx.out(coreutilsVersion('users', 'Joseph Arceneaux, David MacKenzie, and Kaveh Ghazi')); return 0; }
      const names = loginsOf(ctx.machine).map((l) => l.user).sort();
      if (names.length) ctx.println(names.join(' '));
      return 0;
    },
  });

  reg({
    name: 'who', pkg: 'coreutils', summary: 'show who is logged on', synopsis: 'who [OPTION]... [ FILE | ARG1 ARG2 ]',
    man: 'DESCRIPTION\n       Print information about users who are currently logged in.\n\nOPTIONS\n       -a, --all\n              same as -b -d --login -p -r -t -T -u\n\n       -b, --boot\n              time of last system boot\n\n       -H, --heading\n              print line of column headings\n\n       -m     only hostname and user associated with stdin\n\n       -q, --count\n              all login names and number of users logged on\n\n       -u, --users\n              list users logged in\n\n       --help display this help and exit\n\n       --version\n              output version information and exit\n\nEXAMPLES\n       who\n              One line for each login session.\n       who -H\n              The same with a header line.',
    run(ctx) {
      const g = ctx.getopt({ short: 'abdHlmpqrstTuwi', long: ['all', 'boot', 'dead', 'heading', 'login', 'only-hostname-user', 'process', 'count', 'runlevel', 'short', 'time', 'mesg', 'message', 'writable', 'users', 'lookup', 'ips', 'help', 'version'],
        alias: { all: 'a', boot: 'b', dead: 'd', heading: 'H', login: 'l', process: 'p', count: 'q', runlevel: 'r', short: 's', time: 't', users: 'u' } });
      if (g.err) return usageError(ctx, g.err);
      if (g.opts.help) { ctx.out(coreutilsHelp('who', 'Usage: who [OPTION]... [ FILE | ARG1 ARG2 ]\nPrint information about users who are currently logged in.\n\n  -a, --all         same as -b -d --login -p -r -t -T -u\n  -b, --boot        time of last system boot\n  -d, --dead        print dead processes\n  -H, --heading     print line of column headings\n  -l, --login       print system login processes\n      --lookup      attempt to canonicalize hostnames via DNS\n  -m                only hostname and user associated with stdin\n  -p, --process     print active processes spawned by init\n  -q, --count       all login names and number of users logged on\n  -r, --runlevel    print current runlevel\n  -s, --short       print only name, line, and time (default)\n  -T, -w, --mesg    add user\'s message status as +, - or ?\n  -u, --users       list users logged in\n      --message     same as -T\n      --writable    same as -T\n      --help        display this help and exit\n      --version     output version information and exit\n')); return 0; }
      if (g.opts.version) { ctx.out(coreutilsVersion('who', 'Joseph Arceneaux, David MacKenzie, and Michael Stone')); return 0; }
      if (g.rest.length > 2) return usageError(ctx, "extra operand '" + g.rest[2] + "'");
      const m = ctx.machine; const lines = [];
      const boot = K.getBootTime(); const now = K.clock.now();
      if (g.opts.q) {
        const names = loginsOf(m).map((l) => l.user);
        ctx.println(names.join(' ') + (names.length ? '\n' : '') + '# users=' + names.length);
        return 0;
      }
      const wantAll = !!g.opts.a; const idle = g.opts.u || wantAll;
      const head = 'NAME     LINE         TIME             COMMENT';
      if (g.rest.length === 2 || g.opts.m) return 0; // "who am i": a terminal without a utmp record prints nothing
      if (g.opts.H) lines.push(idle ? 'NAME     LINE         TIME             IDLE          PID COMMENT' : head);
      if (g.opts.b || wantAll) lines.push('         system boot  ' + whoTime(boot));
      if (!g.opts.b || wantAll) {
        for (const l of loginsOf(m)) {
          const line = l.user.padEnd(8) + ' ' + l.tty.padEnd(12) + ' ' + whoTime(l.at);
          lines.push(idle ? line + ' ' + (now - l.at < 60 * SEC ? '  .  ' : 'old  ') + '       ' + U.padStart(m.procs.find((p) => p.tty === l.tty) ? m.procs.find((p) => p.tty === l.tty).pid : 1, 4) + ' (' + l.host + ')' : line + ' (' + l.host + ')');
        }
      }
      if (lines.length) ctx.println(lines.join('\n'));
      return 0;
    },
  });

  const W_USAGE = '\nUsage:\n w [options] [user]\n\nOptions:\n -h, --no-header     do not print header\n -u, --no-current    ignore current process username\n -s, --short         short format\n -f, --from          show remote hostname field\n -o, --old-style     old style output\n -i, --ip-addr       display IP address instead of hostname (if possible)\n\n     --help     display this help and exit\n -V, --version  output version information and exit\n\nFor more details see w(1).\n';

  reg({
    name: 'w', pkg: 'procps', summary: 'Show who is logged on and what they are doing.', synopsis: 'w [options] [user]',
    man: 'DESCRIPTION\n       w displays information about the users currently on the machine, and their processes. The header shows, in this order, the current time, how long the system has been running, how many users are currently logged on, and the system load averages for the past 1, 5, and 15 minutes.\n\nOPTIONS\n       -h, --no-header\n              Don\'t print the header.\n\n       -s, --short\n              Use the short format. Don\'t print the login time, JCPU or PCPU times.\n\n       -f, --from\n              Toggle printing the from (remote hostname) field.\n\n       user   Show information about the specified user only.\n\nEXAMPLES\n       w\n              Who is on the box and what they run.',
    run(ctx) {
      const g = ctx.getopt({ short: 'husfoiV', long: ['no-header', 'no-current', 'short', 'from', 'old-style', 'ip-addr', 'help', 'version'], alias: { 'no-header': 'h', short: 's', from: 'f' } });
      if (g.err) { ctx.err('w: ' + g.err + '\n' + W_USAGE); return 1; }
      if (g.opts.help) { ctx.out(W_USAGE); return 0; }
      if (g.opts.V) { ctx.out('w from procps-ng 4.0.4\n'); return 0; }
      const m = ctx.machine; const now = K.clock.now();
      let rows = loginsOf(m);
      if (g.rest.length) rows = rows.filter((l) => l.user === g.rest[0]);
      const showFrom = !g.opts.f; // procps shows FROM unless -f toggles it off
      const lines = [];
      if (!g.opts.h) {
        lines.push(uptimeLine(m));
        lines.push('USER     TTY      ' + (showFrom ? 'FROM            ' : '') + (g.opts.s ? ' IDLE WHAT' : ' LOGIN@   IDLE   JCPU   PCPU WHAT'));
      }
      for (const l of rows) {
        const idle = Math.floor((now - l.at) / 1000);
        const d = new Date(l.at); const login = U.pad2(d.getUTCHours()) + ':' + U.pad2(d.getUTCMinutes());
        const what = l.tty.indexOf('tty') === 0 ? 'xfce4-session' : '-zsh';
        const from = showFrom ? (l.host || '-').padEnd(16) : '';
        lines.push(l.user.padEnd(8) + ' ' + l.tty.padEnd(8) + ' ' + from + (g.opts.s ? U.padStart(idleText(idle), 6) + ' ' + what
          : ' ' + login.padEnd(8) + U.padStart(idleText(idle), 6) + U.padStart(idleText(Math.floor(idle / 80)), 7) + U.padStart('0.05s', 7) + ' ' + what));
      }
      ctx.println(lines.join('\n'));
      return 0;
    },
  });

  const LAST_USAGE = '\nUsage:\n last [options] [<username>...] [<tty>...]\n\nShow a listing of last logged in users.\n\nOptions:\n -<number>            how many lines to show\n -a, --hostlast       display hostnames in the last column\n -d, --dns            translate the IP number back into a hostname\n -f, --file <file>    use a specific file instead of /var/log/wtmp\n -F, --fulltimes      print full login and logout times and dates\n -i, --ip             display IP numbers in numbers-and-dots notation\n -n, --limit <number> how many lines to show\n -R, --nohostname     don\'t display the hostname field\n -s, --since <time>   display the lines since the specified time\n -t, --until <time>   display the lines until the specified time\n -p, --present <time> display who was present at the specified time\n -w, --fullnames      display full user and domain names\n -x, --system         display system shutdown entries and run level changes\n\n     --time-format <format>  show timestamps in the specified <format>:\n                               notime|short|full|iso\n\n -h, --help           display this help\n -V, --version        display version\n\nFor more details see last(1).\n';

  /** Earlier boots and sessions, so `last` has history beyond the current boot. */
  function loginHistory(machine) {
    const boot = K.getBootTime(); const kali = machine.profile === 'kali';
    const entries = [];
    const sessions = kali ? [['kali', 'tty7', ':0'], ['kali', 'pts/0', '10.10.10.1']] : [['student', 'pts/0', '10.10.10.5']];
    for (let i = 1; i <= 3; i++) {
      const bootAt = boot - i * (DAY + 3 * HOUR + i * 17 * MIN);
      const down = bootAt + 2 * HOUR + 25 * MIN + i * 7 * MIN;
      const s = sessions[(i - 1) % sessions.length];
      entries.push({ user: s[0], tty: s[1], host: s[2], at: bootAt + 40 * SEC, end: down - 20 * SEC });
      entries.push({ user: 'reboot', tty: 'system boot', host: K.distro.kernel, at: bootAt, end: down });
    }
    return entries;
  }

  reg({
    name: 'last', aliases: ['lastb'], pkg: 'util-linux', summary: 'show a listing of last logged in users', synopsis: 'last [options] [username...] [tty...]',
    man: 'DESCRIPTION\n       last searches back through the /var/log/wtmp file and displays a list of all users logged in (and out) since that file was created. One or more usernames and/or ttys can be given, in which case last will show only the entries matching those arguments.\n\nOPTIONS\n       -n, --limit number\n              Tell last how many lines to show.\n\n       -a, --hostlast\n              Display the hostname in the last column.\n\n       -R, --nohostname\n              Suppresses the display of the hostname field.\n\n       -F, --fulltimes\n              Print full login and logout times and dates.\n\n       -x, --system\n              Display the system shutdown entries and run level changes.\n\nEXAMPLES\n       last -n 5\n              The five most recent logins.\n       last reboot\n              Show the boot history.',
    run(ctx) {
      const args = ctx.args.map((a) => (/^-\d+$/.test(a) ? '-n' + a.slice(1) : a));
      const g = K.getopt(args, { short: 'adf:Fin:Rs:t:p:wxhV', long: ['hostlast', 'dns', 'file=', 'fulltimes', 'ip', 'limit=', 'nohostname', 'since=', 'until=', 'present=', 'fullnames', 'system', 'time-format=', 'help', 'version'],
        alias: { hostlast: 'a', dns: 'd', file: 'f', fulltimes: 'F', ip: 'i', limit: 'n', nohostname: 'R', fullnames: 'w', system: 'x', help: 'h', version: 'V' } });
      if (g.err) { ctx.err('last: ' + g.err + '\n' + LAST_USAGE); return 1; }
      if (g.opts.h) { ctx.out(LAST_USAGE); return 0; }
      if (g.opts.V) { ctx.out('last from util-linux 2.41\n'); return 0; }
      if (ctx.name === 'lastb' || g.opts.f) {
        const file = g.opts.f || '/var/log/btmp';
        if (!ctx.fs.exists(file)) { ctx.err('last: cannot open ' + file + ': No such file or directory\n'); return 1; }
        if (!ctx.isRoot) { ctx.err('last: cannot open ' + file + ': Permission denied\n'); return 1; }
        ctx.println('\n' + (ctx.name === 'lastb' ? 'btmp' : 'wtmp') + ' begins ' + U.dateString(K.getBootTime()).replace(/ [AP]M UTC/, '').replace(/^(\w+ \w+ +\d+) (\d+:\d+:\d+) (\d+)$/, '$1 $2 $3'));
        return 0;
      }
      const m = ctx.machine; const boot = K.getBootTime();
      const current = loginsOf(m).map((l) => ({ user: l.user, tty: l.tty, host: l.host, at: l.at, end: null }));
      current.push({ user: 'reboot', tty: 'system boot', host: K.distro.kernel, at: boot, end: null });
      let list = current.concat(loginHistory(m)).sort((a, b) => b.at - a.at);
      const filters = g.rest;
      if (filters.length) list = list.filter((e) => filters.some((f) => f === e.user || f === e.tty || f === e.tty.replace(/^\/dev\//, '') || (f === 'reboot' && e.user === 'reboot')));
      if (g.opts.n != null) {
        if (!/^\d+$/.test(g.opts.n)) { ctx.err("last: failed to parse number: '" + g.opts.n + "'\n"); return 1; }
        list = list.slice(0, +g.opts.n);
      }
      const stamp = (ms) => { const s = U.dateString(ms); return s.slice(0, 3) + ' ' + s.slice(4, 10) + ' ' + whoTime(ms).slice(11); };
      const out = list.map((e) => {
        const host = g.opts.R ? '' : (e.host || '').padEnd(16) + ' ';
        const left = e.user.padEnd(8) + ' ' + e.tty.padEnd(12) + ' ' + host;
        let tail;
        if (e.end == null) tail = e.user === 'reboot' ? 'still running' : 'still logged in';
        else {
          const span = Math.floor((e.end - e.at) / MIN);
          tail = whoTime(e.end).slice(11) + ' (' + (span >= 1440 ? Math.floor(span / 1440) + '+' : '') + U.pad2(Math.floor(span / 60) % 24) + ':' + U.pad2(span % 60) + ')';
        }
        return left + stamp(e.at) + (e.end == null ? '   ' : ' - ') + tail;
      });
      const begins = loginHistory(m).reduce((t, e) => Math.min(t, e.at), boot) - 2 * DAY - 7 * MIN - 11 * SEC;
      ctx.println(out.join('\n') + (out.length ? '\n' : '') + '\nwtmp begins ' + stamp(begins) + ':' + U.pad2(new Date(begins).getUTCSeconds()) + ' ' + new Date(begins).getUTCFullYear());
      return 0;
    },
  });

  /* --------------------------------------------------------------------- cal */

  const CAL_USAGE = '\nUsage:\n cal [options] [[[day] month] year]\n cal [options] <timestamp|monthname>\n\nDisplay a calendar, or some part of it.\nWithout any arguments, display the current month.\n\nOptions:\n -1, --one             show only a single month (default)\n -3, --three           show three months spanning the date\n -s, --sunday          Sunday as first day of week\n -m, --monday          Monday as first day of week\n -j, --julian          output Julian dates\n -y, --year            show the whole year\n -Y, --twelve          show the next twelve months\n -w, --week[=<num>]    show US or ISO-8601 week numbers\n     --color[=<when>]  colorize messages (auto, always or never)\n                         colors are enabled by default\n\n -h, --help            display this help\n -V, --version         display version\n\nFor more details see cal(1).\n';
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

  /** One month as seven-column weeks, each line 22 wide as util-linux pads them. */
  function calMonth(y, m, monday, today, color) {
    const title = MONTH_NAMES[m] + ' ' + y;
    const lines = [(' '.repeat(Math.floor((20 - title.length) / 2)) + title).padEnd(22)];
    const names = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    lines.push((monday ? names.slice(1).concat(names[0]) : names).join(' ').padEnd(22));
    let col = (new Date(Date.UTC(y, m, 1)).getUTCDay() - (monday ? 1 : 0) + 7) % 7;
    let row = ' '.repeat(col * 3);
    for (let d = 1; d <= daysInMonth(y, m); d++) {
      const cell = U.padStart(d, 2);
      row += (today && today.y === y && today.m === m && today.d === d && color ? K.c.inverse(cell) : cell) + ' ';
      if (++col === 7) { lines.push(row + ' '); row = ''; col = 0; }
    }
    if (row) lines.push(row + ' '.repeat(Math.max(0, 22 - K.util.stripAnsi(row).length)));
    return lines;
  }

  /** Months laid side by side, `per` to a row: one array of lines per row. */
  function calRows(months, per, monday, today, color) {
    const out = [];
    for (let i = 0; i < months.length; i += per) {
      const blocks = months.slice(i, i + per).map((x) => calMonth(x[0], x[1], monday, today, color));
      const height = Math.max.apply(null, blocks.map((b) => b.length));
      const rows = [];
      for (let r = 0; r < height; r++) rows.push(blocks.map((b) => (b[r] != null ? b[r] : ' '.repeat(22))).join(''));
      out.push(rows);
    }
    return out;
  }

  const MONTH_PREFIX = (word) => MONTH_NAMES.findIndex((n) => word.length >= 3 && n.toLowerCase().indexOf(word.toLowerCase()) === 0);

  reg({
    name: 'cal', aliases: ['ncal'], pkg: 'bsdextrautils', summary: 'display a calendar', synopsis: 'cal [options] [[[day] month] year]',
    man: 'DESCRIPTION\n       cal displays a simple calendar. If no arguments are specified, the current month is displayed.\n\nOPTIONS\n       -1, --one\n              Display single month output. (This is the default.)\n\n       -3, --three\n              Display prev/current/next month output.\n\n       -s, --sunday\n              Display Sunday as the first day of the week.\n\n       -m, --monday\n              Display Monday as the first day of the week.\n\n       -y, --year\n              Display a calendar for the current year.\n\nEXAMPLES\n       cal\n              The current month, with today highlighted.\n       cal 2 2028\n              February 2028 (a leap year).\n       cal -y\n              The whole current year.',
    run(ctx) {
      const g = ctx.getopt({ short: '13smjyYwhV', long: ['one', 'three', 'sunday', 'monday', 'julian', 'year', 'twelve', 'week=?', 'color=?', 'help', 'version'], alias: { one: '1', three: '3', sunday: 's', monday: 'm', year: 'y', help: 'h', version: 'V' } });
      if (g.err) { ctx.err('cal: ' + g.err + "\nTry 'cal --help' for more information.\n"); return 1; }
      if (g.opts.h) { ctx.out(CAL_USAGE); return 0; }
      if (g.opts.V) { ctx.out('cal from util-linux 2.41\n'); return 0; }
      const now = new Date(K.clock.now());
      const today = { y: now.getUTCFullYear(), m: now.getUTCMonth(), d: now.getUTCDate() };
      let y = today.y; let m = today.m; let wholeYear = !!g.opts.y; let showToday = true;
      const nums = g.rest.slice();
      const num = (s, what, lo, hi) => {
        if (!/^\d+$/.test(s) || +s < lo || +s > hi) { ctx.err('cal: illegal ' + what + ' value: use ' + lo + '-' + hi + '\n'); return null; }
        return +s;
      };
      if (nums.length > 3) { ctx.err(CAL_USAGE); return 1; }
      if (nums.length === 1 && MONTH_PREFIX(nums[0]) >= 0) { m = MONTH_PREFIX(nums[0]); } else if (nums.length === 1) {
        y = num(nums[0], 'year', 1, 9999); if (y == null) return 1; wholeYear = true; showToday = y === today.y;
      } else if (nums.length >= 2) {
        const mm = nums[nums.length - 2]; const yy = nums[nums.length - 1];
        const mi = MONTH_PREFIX(mm) >= 0 ? MONTH_PREFIX(mm) : (num(mm, 'month', 1, 12) || 0) - 1;
        if (mi < 0) return 1;
        y = num(yy, 'year', 1, 9999); if (y == null) return 1; m = mi; showToday = y === today.y && m === today.m;
        if (nums.length === 3 && num(nums[0], 'day', 1, 31) == null) return 1;
      }
      const monday = !!g.opts.m; const color = ctx.isTTY && showToday && g.opts.color !== 'never';
      const mark = showToday ? today : null;
      let lines;
      if (wholeYear) {
        const title = String(y);
        lines = [' '.repeat(Math.floor((66 - title.length) / 2)) + title + ' '.repeat(Math.ceil((66 - title.length) / 2)), ''];
        const rows = calRows(Array.from({ length: 12 }, (_, i) => [y, i]), 3, monday, mark, color);
        rows.forEach((r, i) => { if (i) lines.push(''); lines.push.apply(lines, r); });
      } else if (g.opts[3]) {
        lines = calRows([-1, 0, 1].map((d) => { const t = new Date(Date.UTC(y, m + d, 1)); return [t.getUTCFullYear(), t.getUTCMonth()]; }), 3, monday, mark, color)[0];
      } else lines = calMonth(y, m, monday, mark, color);
      ctx.println(lines.join('\n'));
      return 0;
    },
  });

  /* ------------------------------------------------------- top, htop, watch */

  /** Redraw frame() every delayMs until q or Ctrl-C. Ends the way top and watch do: quietly, status 0. */
  async function liveScreen(ctx, delayMs, frame, quitKeys) {
    let quit = false;
    const off = ctx.term.onKey((k) => { if (quitKeys.indexOf(k) >= 0) quit = true; });
    try {
      while (!quit) {
        ctx.term.write('\x1b[2J\x1b[H' + frame());
        for (let t = 0; t < delayMs && !quit; t += 100) {
          await ctx.sleep(Math.min(100, delayMs - t));
          if (K.clock._virtual) await new Promise((r) => setTimeout(r, 0)); // let queued key presses arrive
        }
      }
    } catch (e) {
      if (!(e instanceof K.Interrupt)) throw e;
    } finally { off(); }
    ctx.term.write('\x1b[2J\x1b[H');
    return 0;
  }

  const topNumber = (kb, width) => {
    if (String(kb).length <= width) return String(kb);
    const units = [['m', 1024], ['g', 1048576], ['t', 1073741824]];
    for (const [u, d] of units) { const s = (kb / d).toFixed(1) + u; if (s.length <= width) return s; }
    return String(kb);
  };
  const topTime = (sec, seed) => Math.floor(sec / 60) + ':' + U.pad2(Math.floor(sec) % 60) + '.' + U.pad2(U.hash32('t' + seed) % 100);

  function sysSummary(ctx, views) {
    const m = memInfo(ctx); const mib = (kb) => U.padStart((kb / 1024).toFixed(1), 8);
    const count = (re) => views.filter((v) => re.test(v.stat[0])).length;
    const run = count(/R/); const stopped = count(/T|t/); const zombie = count(/Z/);
    const busy = Math.min(100, views.reduce((a, v) => a + v.cpu, 0));
    const us = busy * 0.7 + K.net.rand() * 0.5; const sy = busy * 0.3 + K.net.rand() * 0.4; const wa = K.net.rand() * 0.2;
    const idle = Math.max(0, 100 - us - sy - wa);
    const cpu = [[us, 'us'], [sy, 'sy'], [0, 'ni'], [idle, 'id'], [wa, 'wa'], [0, 'hi'], [K.net.rand() * 0.1, 'si'], [0, 'st']].map(([v, n]) => U.padStart(v.toFixed(1), 4) + ' ' + n).join(', ');
    return [
      'top -' + uptimeLine(ctx.machine),
      'Tasks: ' + [[views.length, 'total'], [run, 'running'], [views.length - run - stopped - zombie, 'sleeping'], [stopped, 'stopped'], [zombie, 'zombie']].map(([n, w]) => U.padStart(n, w === 'total' ? 3 : 3) + ' ' + w).join(', '),
      '%Cpu(s): ' + cpu + ' ',
      'MiB Mem : ' + mib(m.total) + ' total, ' + mib(m.free) + ' free, ' + mib(m.used) + ' used, ' + mib(m.buffers + m.cache) + ' buff/cache     ',
      'MiB Swap: ' + mib(m.swapTotal) + ' total, ' + mib(m.swapFree) + ' free, ' + mib(m.swapTotal - m.swapFree) + ' used. ' + mib(m.available) + ' avail Mem ',
    ];
  }

  /** Processes ordered the way top shows them: busiest first. */
  function topProcesses(ctx, o) {
    let views = allProcs(ctx);
    for (const v of views) if (v.pid === ctx.pid) { v.cpu = 0.3; v.stat = 'R'; }
    const total = views.length;
    if (o.pids) views = views.filter((v) => o.pids.indexOf(v.pid) >= 0);
    if (o.user) views = views.filter((v) => v.user === o.user);
    return { total: views, shown: views.slice().sort((a, b) => b.cpu - a.cpu || a.pid - b.pid), count: total };
  }

  const TOP_USAGE = 'Usage:\n top -hv | -bcEeHiOSs1 -d secs -n max -u|U user -p pid(s) -o field -w [cols]\n';

  reg({
    name: 'top', pkg: 'procps', summary: 'display Linux processes', synopsis: 'top -hv | -bcEeHiOSs1 -d secs -n max -u|U user -p pid(s) -o field -w [cols]',
    man: 'DESCRIPTION\n       The top program provides a dynamic real-time view of a running system. It can display system summary information as well as a list of processes or threads currently being managed by the Linux kernel.\n\nOPTIONS\n       -b, --batch-mode\n              Starts top in Batch mode, which could be useful for sending output from top to other programs or to a file.\n\n       -c     Command-line/Program-name toggle.\n\n       -d, --delay=SECS\n              Specifies the delay between screen updates.\n\n       -n, --iterations=NUMBER\n              Specifies the maximum number of iterations, or frames, top should produce before ending.\n\n       -p, --pid=PIDLIST\n              Monitor only processes with specified process IDs.\n\n       -u, --filter-only-euser=USER\n              Monitor only processes with an effective user ID or user name matching that given.\n\n       -w, --width[=COLS]\n              In Batch mode, when used without an argument top will format output using the COLUMNS= and LINES= environment variables.\n\n       q      Quit interactive top.\n\nEXAMPLES\n       top\n              Watch the system; press q to leave.\n       top -b -n 1 | head -15\n              One snapshot, ready for a pipe.',
    async run(ctx) {
      const g = ctx.getopt({ short: 'bcd:n:p:u:U:o:w::hvHiSsEeO1', long: ['batch', 'help', 'version', 'delay=', 'iterations=', 'pid=', 'filter-only-euser=', 'width=?', 'sort-override='] });
      if (g.err) {
        const req = /option requires an argument -- '(.)'/.exec(g.err);
        if (req) { ctx.err('top: -' + req[1] + ' requires argument\n'); return 1; }
        const bad = /option -- '(.)'/.exec(g.err) || /option '(.*)'/.exec(g.err);
        ctx.err('top: unknown option \'' + (bad ? bad[1] : g.err) + '\'\n' + TOP_USAGE);
        return 1;
      }
      if (g.opts.h || g.opts.help) { ctx.out(' procps-ng 4.0.4\n' + TOP_USAGE); return 0; }
      if (g.opts.v || g.opts.version) { ctx.out('top from procps-ng 4.0.4\n'); return 0; }
      const delay = g.opts.d != null ? Number(g.opts.d) : g.opts.delay != null ? Number(g.opts.delay) : 3;
      if (!(delay >= 0)) { ctx.err('top: bad delay interval \'' + (g.opts.d || g.opts.delay) + "'\n"); return 1; }
      const nRaw = g.opts.n != null ? g.opts.n : g.opts.iterations;
      if (nRaw != null && !/^\d+$/.test(nRaw)) { ctx.err('top: bad iterations argument \'' + nRaw + "'\n"); return 1; }
      const iterations = nRaw != null ? +nRaw : Infinity;
      const pidArg = g.opts.p != null ? g.opts.p : g.opts.pid;
      let pids = null;
      if (pidArg != null) {
        pids = String(pidArg).split(',').map((x) => (/^\d+$/.test(x) ? +x : NaN));
        if (pids.some(isNaN)) { ctx.err('top: bad pid \'' + pidArg + "'\n"); return 1; }
      }
      const user = g.opts.u || g.opts.U || g.opts['filter-only-euser'] || null;
      if (user && !ctx.machine.userByName(user) && !ctx.machine.procs.some((p) => p.user === user)) { ctx.err('top: Invalid user \'' + user + "'\n"); return 1; }
      const batch = !!(g.opts.b || g.opts.batch) || !ctx.isTTY;
      const width = g.opts.w && g.opts.w !== true ? +g.opts.w : batch ? 512 : ctx.cols;
      const full = !!g.opts.c;
      const sortKeys = {
        PID: (v) => v.pid, USER: (v) => v.user, PR: (v) => (v.kthread ? 0 : 20 + v.ni), NI: (v) => v.ni, VIRT: (v) => v.vsz, RES: (v) => v.rss,
        SHR: (v) => (v.kthread ? 0 : v.rss * 0.36), S: (v) => v.stat[0], '%CPU': (v) => v.cpu, '%MEM': (v) => v.mem, 'TIME+': (v) => v.time, COMMAND: (v) => v.comm,
      };
      let sortBy = null;
      const sortArg = g.opts.o != null ? g.opts.o : g.opts['sort-override'];
      if (typeof sortArg === 'string') {
        const m = /^([+-]?)(.*)$/.exec(sortArg);
        const key = sortKeys[m[2].toUpperCase()];
        if (!key) { ctx.err("top: unknown field name '" + sortArg + "'\n" + TOP_USAGE); return 1; }
        sortBy = { key, asc: m[1] === '+' };
      }
      const frame = (rowsLeft) => {
        const sel = topProcesses(ctx, { pids, user });
        if (sortBy) sel.shown.sort((a, b) => { const x = sortBy.key(a); const y = sortBy.key(b); const c = x < y ? -1 : x > y ? 1 : 0; return (sortBy.asc ? c : -c) || a.pid - b.pid; });
        const head = sysSummary(ctx, sel.total.length ? allProcs(ctx) : []);
        const col = '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND';
        const rows = sel.shown.slice(0, rowsLeft).map((v) => {
          const shr = v.kthread ? 0 : Math.floor(v.rss * 0.36);
          return U.padStart(v.pid, 7) + ' ' + shortUser(v.user).padEnd(8) + ' ' + U.padStart(v.kthread ? 0 : 20 + v.ni, 3) + ' ' + U.padStart(v.ni, 3) + ' ' + U.padStart(topNumber(v.vsz, 7), 7) + ' ' +
            U.padStart(topNumber(v.rss, 6), 6) + ' ' + U.padStart(topNumber(shr, 6), 6) + ' ' + v.stat[0] + ' ' + U.padStart(v.cpu.toFixed(1), 5) + ' ' + U.padStart(v.mem.toFixed(1), 5) + ' ' + U.padStart(topTime(v.time, v.pid), 9) + ' ' + (full ? v.cmd : v.comm);
        });
        const text = head.concat(['', batch ? col : K.c.inverse(col.padEnd(width))], rows);
        return text.map((l) => (K.util.stripAnsi(l).length > width && !batch ? l.slice(0, width) : batch ? l.slice(0, width) : l)).join('\n') + '\n';
      };
      if (batch) {
        for (let i = 0; i < iterations; i++) {
          ctx.out(frame(Infinity));
          if (i + 1 < iterations) await ctx.sleep(delay * 1000);
        }
        return 0;
      }
      const rowsLeft = Math.max(1, ctx.rows - 7);
      let shown = 0;
      return liveScreen(ctx, delay * 1000, () => (++shown > iterations ? (ctx.term.write(''), '') : frame(rowsLeft).replace(/\n$/, '')), ['q', 'Q', 'Escape']);
    },
  });

  /** htop sizes: KiB while small, then whole MiB, then GiB with a decimal. */
  const htopSize = (kb) => (kb < 100000 ? String(kb) : kb < 10485760 ? Math.round(kb / 1024) + 'M' : (kb / 1048576).toFixed(1) + 'G');

  const htopBar = (label, frac, text, width) => {
    const inner = width - 2; const filled = Math.min(inner, Math.round(inner * frac));
    const body = '|'.repeat(filled).padEnd(inner);
    const t = text.length < inner ? body.slice(0, inner - text.length) + text : body;
    return label + '[' + t + ']';
  };

  reg({
    name: 'htop', pkg: 'htop', summary: 'interactive process viewer', synopsis: 'htop [-dCFhpustvH]',
    man: 'DESCRIPTION\n       htop is a cross-platform interactive process viewer. It is similar to top, but allows you to scroll vertically and horizontally, so you can see all the processes running on the system, along with their full command lines.\n\nOPTIONS\n       -d --delay=DELAY\n              Delay between updates, in tenths of seconds.\n\n       -u --user=USERNAME\n              Show only the processes of a given user.\n\n       -p --pid=PID[,PID...]\n              Show only the given PIDs.\n\n       -h --help\n              Print a help message and exit.\n\n       -V --version\n              Print version info and exit.\n\n       F10, q Quit.\n\nEXAMPLES\n       htop\n              Interactive process list; press F10 or q to leave.\n       htop -u kali\n              Only kali\'s processes.',
    async run(ctx) {
      const g = ctx.getopt({ short: 'd:CsFhpu:tVH', long: ['delay=', 'no-color', 'no-colour', 'help', 'version', 'user=', 'pid=', 'tree'] });
      if (g.err) { ctx.err('htop: ' + g.err + '\nPlease use \'htop --help\' for help on command line options.\n'); return 1; }
      if (g.opts.h || g.opts.help) { ctx.out('htop 3.4.1\n(C) 2004-2019 Hisham Muhammad. (C) 2020-2025 htop dev team.\nReleased under the GNU GPLv2+.\n\n-C --no-color               Use a monochrome color scheme\n-d --delay=DELAY            Set the delay between updates, in tenths of seconds\n-F --filter=FILTER          Show only the commands matching the given filter\n-h --help                   Print this help screen\n-p --pid=PID[,PID,PID...]   Show only the given PIDs\n-s --sort-key=COLUMN        Sort by COLUMN in list view (try --sort-key=help for a list)\n-t --tree                   Show the tree view (can be combined with -s)\n-u --user[=USERNAME]        Show only processes for a given user (or $USER)\n-U --no-unicode             Do not use unicode but ASCII characters for graph meters\n-V --version                Print version info\n'); return 0; }
      if (g.opts.V || g.opts.version) { ctx.out('htop 3.4.1\n'); return 0; }
      const user = g.opts.u || g.opts.user || null;
      if (user && !ctx.machine.procs.some((p) => p.user === user)) { ctx.err('htop: Unknown user: ' + user + '\n'); return 1; }
      const cols = ctx.cols; const rows = ctx.rows;
      const frame = () => {
        const views = allProcs(ctx).filter((v) => !user || v.user === user);
        const m = memInfo(ctx);
        const busy = Math.min(100, views.reduce((a, v) => a + v.cpu, 0));
        const half = Math.floor((cols - 4) / 2) - 1;
        const cpus = (ctx.fs.read('/proc/cpuinfo').match(/^processor/gm) || []).length || 1;
        const left = []; const right = [];
        for (let i = 0; i < cpus; i++) { const pct = i ? K.net.rand() * 2 : busy; left.push(htopBar(U.padStart(i, 3), pct / 100, pct.toFixed(1) + '%', half)); }
        left.push(htopBar('Mem', m.used / m.total, (m.used / 1048576).toFixed(2) + 'G/' + (m.total / 1048576).toFixed(2) + 'G', half));
        left.push(htopBar('Swp', 0, '0K/' + Math.round(m.swapTotal / 1024) + 'M', half));
        const thr = views.length + 14; const [l1, l5, l15] = loadAverage(ctx.machine);
        right.push('Tasks: ' + views.filter((v) => !v.kthread).length + ', ' + thr + ' thr, ' + views.filter((v) => v.kthread).length + ' kthr; ' + views.filter((v) => v.stat[0] === 'R').length + ' running');
        right.push('Load average: ' + l1 + ' ' + l5 + ' ' + l15);
        const up = Math.floor((K.clock.now() - K.getBootTime()) / 1000);
        right.push('Uptime: ' + U.pad2(Math.floor(up / 3600)) + ':' + U.pad2(Math.floor(up / 60) % 60) + ':' + U.pad2(up % 60));
        const top = left.map((l, i) => l + '  ' + (right[i] || ''));
        const col = '    PID USER       PRI  NI  VIRT   RES   SHR S  CPU% MEM%   TIME+  Command';
        const body = views.slice().sort((a, b) => b.cpu - a.cpu || a.pid - b.pid).slice(0, Math.max(1, rows - top.length - 3)).map((v) =>
          U.padStart(v.pid, 7) + ' ' + shortUser(v.user).padEnd(10) + ' ' + U.padStart(v.kthread ? 0 : 20 + v.ni, 3) + U.padStart(v.ni, 4) + U.padStart(htopSize(v.vsz), 6) + U.padStart(htopSize(v.rss), 6) +
          U.padStart(htopSize(v.kthread ? 0 : Math.floor(v.rss * 0.36)), 6) + ' ' + v.stat[0] + U.padStart(v.cpu.toFixed(1), 6) + U.padStart(v.mem.toFixed(1), 5) + U.padStart(topTime(v.time, v.pid), 9) + '  ' + v.cmd);
        const keys = 'F1Help  F2Setup F3SearchF4FilterF5Tree  F6SortByF7Nice -F8Nice +F9Kill  F10Quit';
        return top.concat(['', ctx.isTTY ? K.c.inverse(col.padEnd(cols)) : col], body, [ctx.isTTY ? K.c.inverse(keys.padEnd(cols)) : keys]).map((l) => (ctx.isTTY ? l : l.slice(0, cols))).join('\n') + '\n';
      };
      if (!ctx.isTTY) { ctx.out(frame()); return 0; }
      return liveScreen(ctx, (g.opts.d != null ? Number(g.opts.d) * 100 : 1500), () => frame().replace(/\n$/, ''), ['q', 'Q', 'F10']);
    },
  });

  const WATCH_USAGE = '\nUsage:\n watch [options] command\n\nOptions:\n  -b, --beep             beep if command has a non-zero exit\n  -c, --color            interpret ANSI color and style sequences\n  -d, --differences[=<permanent>]\n                         highlight changes between updates\n  -e, --errexit          exit if command has a non-zero exit\n  -g, --chgexit          exit when output from command changes\n  -q, --equexit <cycles>\n                         exit when output from command does not change\n  -n, --interval <secs>  seconds to wait between updates\n  -p, --precise          attempt run command in precise intervals\n  -r, --no-rerun         do not rerun program on window resize\n  -t, --no-title         turn off header\n  -w, --no-linewrap      turn off line wrapping\n  -x, --exec             pass command to exec instead of "sh -c"\n\n  -h, --help     display this help and exit\n  -v, --version  output version information and exit\n\nFor more details see watch(1).\n';

  reg({
    name: 'watch', pkg: 'procps', summary: 'execute a program periodically, showing output fullscreen', synopsis: 'watch [options] command',
    man: 'DESCRIPTION\n       watch runs command repeatedly, displaying its output and errors (the first screenfull). This allows you to watch the program output change over time. By default, command is run every 2 seconds and watch will run until interrupted.\n\nOPTIONS\n       -d, --differences\n              Highlight the differences between successive updates.\n\n       -e, --errexit\n              Freeze updates on command error, and exit after a key press.\n\n       -g, --chgexit\n              Exit when the output of command changes.\n\n       -n, --interval seconds\n              Specify update interval. The command will not allow quicker than 0.1 second interval.\n\n       -t, --no-title\n              Turn off the header showing the interval, command, and current time at the top of the display.\n\n       q      Quit watch.\n\nEXAMPLES\n       watch -n 1 date\n              Show the clock, refreshed every second.\n       watch -d free -m\n              Watch memory use and highlight changes.',
    async run(ctx) {
      const g = ctx.getopt({ short: 'bcd::egq:n:prtwxhv', long: ['beep', 'color', 'differences=?', 'errexit', 'chgexit', 'equexit=', 'interval=', 'precise', 'no-rerun', 'no-title', 'no-linewrap', 'exec', 'help', 'version'],
        alias: { interval: 'n', 'no-title': 't', errexit: 'e', chgexit: 'g', exec: 'x' }, stopAtNonOption: true });
      if (g.err) { ctx.err('watch: ' + g.err + '\n' + WATCH_USAGE); return 1; }
      if (g.opts.h) { ctx.out(WATCH_USAGE); return 0; }
      if (g.opts.v) { ctx.out('watch from procps-ng 4.0.4\n'); return 0; }
      if (!g.rest.length) { ctx.err(WATCH_USAGE); return 1; }
      let secs = 2;
      if (g.opts.n != null) {
        secs = Number(String(g.opts.n).replace(',', '.'));
        if (isNaN(secs)) secs = 0.1;
      }
      secs = Math.max(0.1, secs);
      const line = g.rest.join(' ');
      let last = null; let exitCode = null; let same = 0;
      const frame = async () => {
        const r = await ctx.run(g.opts.x ? g.rest : line);
        const text = r.out + r.err;
        if (g.opts.g && last != null && text !== last) exitCode = 0;
        if (g.opts.e && r.code) exitCode = r.code;
        same = last != null && text === last ? same + 1 : 0;
        if (g.opts.q != null && same >= Math.max(1, parseInt(g.opts.q, 10) || 1)) exitCode = 0;
        last = text;
        const stamp = U.dateString(K.clock.now()).replace(/^(\w+ \w+ +\d+) (\d+):(\d+):(\d+) [AP]M UTC (\d+)$/, '$1 ' + clockTime(K.clock.now()) + ' $5');
        const title = 'Every ' + secs.toFixed(1) + 's: ' + line;
        const right = ctx.machine.hostname + ': ' + stamp;
        const head = g.opts.t ? '' : title.slice(0, Math.max(0, ctx.cols - right.length - 1)).padEnd(Math.max(0, ctx.cols - right.length)) + right + '\n\n';
        return head + text.split('\n').slice(0, Math.max(1, ctx.rows - (g.opts.t ? 0 : 2))).map((l) => l.slice(0, ctx.cols)).join('\n');
      };
      if (!ctx.isTTY) {
        try {
          for (;;) {
            const text = await frame();
            ctx.out(text.replace(/\n?$/, '\n'));
            if (exitCode != null) return exitCode;
            await ctx.sleep(secs * 1000);
            if (K.clock._virtual) await new Promise((r) => setTimeout(r, 0));
          }
        } catch (e) { if (e instanceof K.Interrupt) return 0; throw e; }
      }
      let screen = await frame();
      let quit = false;
      const off = ctx.term.onKey((k) => { if (k === 'q' || k === 'Q') quit = true; });
      try {
        while (!quit && exitCode == null) {
          ctx.term.write('\x1b[2J\x1b[H' + screen.replace(/\n$/, ''));
          for (let t = 0; t < secs * 1000 && !quit; t += 100) {
            await ctx.sleep(Math.min(100, secs * 1000 - t));
            if (K.clock._virtual) await new Promise((r) => setTimeout(r, 0));
          }
          if (!quit) screen = await frame();
        }
      } catch (e) { if (!(e instanceof K.Interrupt)) throw e; } finally { off(); }
      ctx.term.write('\x1b[2J\x1b[H');
      return exitCode == null ? 0 : exitCode;
    },
  });

  /* ------------------------------------------------------------- systemctl */

  const UNIT_DIR = '/usr/lib/systemd/system/';
  const TASK_LIMIT = 4569;
  const SYSV_SCRIPTS = ['ssh', 'apache2', 'nginx', 'mariadb', 'smbd', 'nmbd', 'vsftpd', 'cron', 'rsyslog', 'rpcbind', 'postgresql', 'nfs-kernel-server'];
  const RELOADABLE = /^(ssh|apache2|nginx|rsyslog|NetworkManager|smbd|nmbd|postgresql|mariadb|dbus|systemd-logind|cron|lightdm)\./;
  const NO_RELOAD = /^(cron|lightdm|systemd-logind|mariadb|getty@.*|networking|user@.*)\./;

  /** "5s", "1min 3s", "3h 17min", "2 days 4h": the two leading units systemd shows after "ago". */
  function ago(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'min' + (s % 60 ? ' ' + (s % 60) + 's' : '');
    if (s < 86400) return Math.floor(s / 3600) + 'h' + (Math.floor(s / 60) % 60 ? ' ' + (Math.floor(s / 60) % 60) + 'min' : '');
    const days = Math.floor(s / 86400);
    if (days < 14) return plural(days, 'day') + (Math.floor(s / 3600) % 24 ? ' ' + (Math.floor(s / 3600) % 24) + 'h' : '');
    return plural(Math.floor(days / 7), 'week') + (days % 7 ? ' ' + plural(days % 7, 'day') : '');
  }
  const unitStamp = (ms) => U.DAYS[new Date(ms).getUTCDay()] + ' ' + U.isoDate(ms) + ' UTC';

  /** Line in the format journalctl and `systemctl status` print: "Nov 13 14:30:00 kali sshd[2212]: text". */
  function journalLine(machine, rec, mode) {
    const kernel = rec.ident === 'kernel';
    const tag = rec.ident + (rec.pid != null && rec.ident !== 'sudo' && !kernel ? '[' + rec.pid + ']' : '');
    if (mode === 'cat') return rec.msg;
    const when = mode === 'short-iso' ? U.isoDate(rec.ts).replace(' ', 'T') + '+0000' : U.syslogDate(rec.ts);
    return when + ' ' + machine.hostname + ' ' + tag + ': ' + rec.msg;
  }

  function unitProcs(machine, unit) { return machine.procs.filter((p) => p.unit === unit.name); }

  function statusDot(ctx, unit) {
    const c = K.c;
    if (!ctx.isTTY) return unit.active === 'failed' ? '×' : unit.active === 'active' ? '●' : '○';
    if (unit.active === 'failed') return c.red('×');
    return unit.active === 'active' ? c.green('●') : '○';
  }

  function sliceOf(unit) {
    if (/^user@(\d+)\./.test(unit.name)) return '/user.slice/user-' + /^user@(\d+)/.exec(unit.name)[1] + '.slice/' + unit.name;
    if (/^getty@/.test(unit.name)) return '/system.slice/system-getty.slice/' + unit.name;
    if (/^postgresql@/.test(unit.name)) return '/system.slice/system-postgresql.slice/' + unit.name;
    return '/system.slice/' + unit.name;
  }

  function unitStatus(ctx, unit, lines) {
    const m = ctx.machine; const now = K.clock.now();
    const enabled = unit.enabled === 'static' ? 'static' : unit.enabled ? 'enabled' : 'disabled';
    const preset = unit.enabled === 'static' ? '' : '; preset: ' + (unit.preset || 'enabled');
    const out = [statusDot(ctx, unit) + ' ' + unit.name + ' - ' + unit.desc];
    const row = (k, v) => out.push(k.padStart(11) + ': ' + v);
    if (unit.masked) { row('Loaded', 'masked (Reason: Unit ' + unit.name + ' is masked.)'); row('Active', 'inactive (dead)'); return out.join('\n') + '\n'; }
    row('Loaded', 'loaded (' + UNIT_DIR + (unit.instance ? unit.name.replace(/@[^.]*\./, '@.') : unit.name) + '; ' + enabled + preset + ')');
    const state = unit.active + ' (' + unit.sub + ')';
    if (unit.active === 'active') row('Active', state + ' since ' + unitStamp(unit.since) + '; ' + ago(now - unit.since) + ' ago');
    else if (unit.active === 'failed') row('Active', 'failed (Result: ' + (unit.result || 'exit-code') + ') since ' + unitStamp(unit.since) + '; ' + ago(now - unit.since) + ' ago');
    else row('Active', state + (unit.since ? ' since ' + unitStamp(unit.since) + '; ' + ago(now - unit.since) + ' ago' : ''));
    if (unit.active === 'inactive' && unit.since && unit.ranFor != null) row('Duration', ago(unit.ranFor));
    if (unit.invocation && unit.active !== 'inactive' || unit.invocation && unit.since) row('Invocation', unit.invocation);
    unit.docs.forEach((d, i) => out.push((i ? ' '.repeat(13) : 'Docs'.padStart(11) + ': ') + d));
    if (unit.active !== 'inactive' || unit.since) {
      const startLabel = unit.pre && unit.type !== 'forking' ? 'ExecStartPre' : 'ExecStart';
      if (unit.execPid) row('Process', unit.execPid + ' ' + startLabel + '=' + (unit.pre || '/bin/true') + ' (code=exited, status=0/SUCCESS)');
    }
    const procs = unitProcs(m, unit);
    if (unit.active === 'active' && unit.pid && procs.length) {
      const main = procs.find((p) => p.pid === unit.pid) || procs[0];
      row('Main PID', main.pid + ' (' + commOf(main) + ')');
      row('Tasks', procs.length + ' (limit: ' + TASK_LIMIT + ')');
      const rss = procs.reduce((a, p) => a + (p.rss || 0), 0);
      const mem = (kb) => (kb / 1024 < 10 ? (kb / 1024).toFixed(1) : String(Math.round(kb / 1024))) + 'M';
      row('Memory', mem(rss) + ' (peak: ' + mem(rss * 1.2) + ')');
      row('CPU', (20 + U.hash32(unit.name) % 400) + 'ms');
      out.push('CGroup'.padStart(11) + ': ' + sliceOf(unit));
      procs.forEach((p, i) => {
        const title = /^\w[\w-]*: /.test(p.cmd) && p.cmd.indexOf('/') > 0 ? '"' + p.cmd + '"' : p.cmd;
        out.push(' '.repeat(13) + (i === procs.length - 1 ? '└─' : '├─') + p.pid + ' ' + title);
      });
    } else if (unit.active === 'active' && unit.type === 'oneshot') { /* a finished oneshot has no processes */ }
    else if (unit.active === 'failed' && unit.pid == null && unit.since) row('Process', (unit.execPid || m.nextPid()) + ' ExecStart=' + unit.name.replace(/\.service$/, '') + ' (code=exited, status=1/FAILURE)');
    const recs = journalOf(m).filter((r) => r.unit === unit.name).slice(-lines);
    out.push('');
    if (recs.length) for (const r of recs) out.push(journalLine(m, r));
    return out.join('\n') + '\n';
  }

  const SYSTEMCTL_USAGE = 'systemctl [OPTIONS...] COMMAND ...\n\nQuery or send control commands to the system manager.\n\nUnit Commands:\n  list-units [PATTERN...]         List units currently in memory\n  list-unit-files [PATTERN...]    List installed unit files\n  status [PATTERN...|PID...]      Show runtime status of one or more units\n  start UNIT...                   Start (activate) one or more units\n  stop UNIT...                    Stop (deactivate) one or more units\n  reload UNIT...                  Reload one or more units\n  restart UNIT...                 Start or restart one or more units\n  is-active PATTERN...            Check whether units are active\n  is-failed [PATTERN...]          Check whether units are failed or system is degraded\n  enable [UNIT...|PATH...]        Enable one or more unit files\n  disable UNIT...                 Disable one or more unit files\n  is-enabled UNIT...              Check whether unit files are enabled\n  cat PATTERN...                  Show files and drop-ins of specified units\n  reset-failed [PATTERN...]       Reset failed state for all, one, or more units\n\nManager State Commands:\n  daemon-reload                   Reload systemd manager configuration\n\nSee the systemctl(1) man page for details.\n';

  function enableMessages(unit, enable) {
    const file = UNIT_DIR + unit.name; const lines = [];
    const sysv = SYSV_SCRIPTS.indexOf(unit.prog) >= 0 || SYSV_SCRIPTS.indexOf(unit.name.replace(/\.service$/, '')) >= 0;
    const base = unit.name.replace(/\.service$/, '');
    if (sysv && unit.enabled !== 'static') {
      lines.push('Synchronizing state of ' + unit.name + ' with SysV service script with /usr/lib/systemd/systemd-sysv-install.');
      lines.push('Executing: /usr/lib/systemd/systemd-sysv-install ' + (enable ? 'enable' : 'disable') + ' ' + base);
    }
    const links = unit.aliases.map((a) => '/etc/systemd/system/' + a).concat('/etc/systemd/system/multi-user.target.wants/' + unit.name);
    for (const l of links) lines.push(enable ? "Created symlink '" + l + "' → '" + file + "'." : "Removed '" + l + "'.");
    return lines;
  }

  /** Daemon units that react to systemctl. Returns false when the argument names no unit. */
  function resolveUnits(ctx, names, verb) {
    const missing = [];
    const units = names.map((n) => {
      const u = K.sys.unit(ctx.machine, n);
      if (!u) missing.push(n);
      return u;
    });
    return { units: units.filter(Boolean), missing };
  }
  const withSuffix = (n) => (/\.[a-z]+$/.test(n) ? n : n + '.service');

  const failedJob = (unit, verb) => 'Job for ' + unit.name + ' failed because the control process exited with error code.\nSee "systemctl status ' + unit.name + '" and "journalctl -xeu ' + unit.name + '" for details.\n';

  function unitTable(ctx, units, o) {
    const rows = units.map((u) => ({ mark: u.active === 'failed' ? (ctx.isTTY ? K.c.red('×') : '×') : (o.mark ? ' ' : ' '), cells: [u.name, 'loaded', u.active, u.sub, u.desc] }));
    const head = ['UNIT', 'LOAD', 'ACTIVE', 'SUB', 'DESCRIPTION'];
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r.cells[i].length)));
    const fmt = (cells) => cells.slice(0, 4).map((c, i) => c.padEnd(w[i])).join(' ') + ' ' + cells[4];
    const lines = [];
    const cut = (s) => (ctx.isTTY && K.util.stripAnsi(s).length > ctx.cols ? s.slice(0, ctx.cols - 1) + '…' : s);
    lines.push(cut('  ' + fmt(head)));
    for (const r of rows) lines.push(cut(r.mark + ' ' + fmt(r.cells)));
    return lines;
  }

  const EXTRA_UNITS = (machine) => [
    ['basic.target', 'Basic System'], ['getty.target', 'Login Prompts'], ['multi-user.target', 'Multi-User System'], ['network-online.target', 'Network is Online'],
    ['network.target', 'Network'], ['sysinit.target', 'System Initialization'], ['sockets.target', 'Socket Units'], ['timers.target', 'Timer Units'],
  ].concat(machine.profile === 'kali' ? [['graphical.target', 'Graphical Interface']] : []).map(([name, desc]) => ({ name, desc, active: 'active', sub: 'active', enabled: 'static', preset: 'disabled' }));

  reg({
    name: 'systemctl', pkg: 'systemd', summary: 'Control the systemd system and service manager', synopsis: 'systemctl [OPTIONS...] COMMAND [UNIT...]',
    man: 'DESCRIPTION\n       systemctl may be used to introspect and control the state of the "systemd" system and service manager.\n\nCOMMANDS\n       status [PATTERN...|PID...]\n              Show terse runtime status information about one or more units, followed by most recent log data from the journal.\n\n       start UNIT...\n              Start (activate) one or more units specified on the command line.\n\n       stop UNIT...\n              Stop (deactivate) one or more units.\n\n       restart UNIT...\n              Stop and then start one or more units.\n\n       enable UNIT...\n              Enable one or more units, so that they start at boot. Add --now to start them immediately.\n\n       disable UNIT...\n              Disable one or more units. Add --now to stop them as well.\n\n       is-active PATTERN...\n              Check whether any of the specified units are active.\n\n       list-units [PATTERN...]\n              List units that systemd currently has in memory. Use --failed to show only failed units.\n\n       list-unit-files [PATTERN...]\n              List unit files installed on the system, in combination with their enablement state.\n\n       daemon-reload\n              Reload the systemd manager configuration.\n\nEXAMPLES\n       sudo systemctl start ssh\n              Start the SSH server; port 22 opens.\n       systemctl status apache2\n              Is the web server running?\n       sudo systemctl enable --now postgresql\n              Start PostgreSQL now and at every boot.',
    run(ctx) {
      const g = ctx.getopt({ short: 'ahlqt:p:n:o:H:M:', long: ['all', 'help', 'version', 'no-pager', 'no-legend', 'no-ask-password', 'failed', 'now', 'full', 'quiet', 'type=', 'state=', 'property=', 'lines=', 'output=', 'system', 'user', 'plain', 'force', 'value', 'show-types', 'reverse', 'runtime'], alias: { type: 't', lines: 'n', quiet: 'q', all: 'a', full: 'l', help: 'h', property: 'p', output: 'o' } });
      if (g.err) { ctx.err('systemctl: ' + g.err + '\n'); return 1; }
      if (g.opts.help) { ctx.out(SYSTEMCTL_USAGE); return 0; }
      if (g.opts.version) { ctx.out('systemd 258 (258.1-1)\n+PAM +AUDIT +SELINUX +APPARMOR +IMA +IPE +SMACK +SECCOMP +GCRYPT -GNUTLS +OPENSSL +ACL +BLKID +CURL +ELFUTILS +FIDO2 +IDN2 -IDN +IPTC +KMOD +LIBCRYPTSETUP +LIBCRYPTSETUP_PLUGINS +LIBFDISK +PCRE2 +PWQUALITY +P11KIT +QRENCODE +TPM2 +BZIP2 +LZ4 +XZ +ZLIB +ZSTD +BPF_FRAMEWORK +BTF +XKBCOMMON +UTMP +SYSVINIT +LIBARCHIVE\n'); return 0; }
      const m = ctx.machine;
      if (g.opts.user) { ctx.err('Failed to connect to user scope bus via local transport: No medium found\n'); return 1; }
      const verb = g.rest[0] || 'list-units'; const names = g.rest.slice(1).map(withSuffix);
      const need = (what) => { if (!ctx.isRoot) { ctx.err(what + ': Interactive authentication required.\n'); return false; } return true; };
      const notFound = (n) => 'Unit ' + n + ' not found.';
      const quiet = !!g.opts.q;

      switch (verb) {
        case 'list-timers': {
          const now = K.clock.now();
          const stamp = (t) => strftime('%a %Y-%m-%d %H:%M:%S UTC', t, true);
          const rel = (ms) => { const s = Math.round(Math.abs(ms) / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'min' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + ' days'; };
          const at = (h, mi) => { const d = new Date(now); d.setUTCHours(h, mi, 0, 0); return d.getTime(); };
          const defs = [['apt-daily.timer', 'apt-daily.service', 6, 20, 86400000], ['apt-daily-upgrade.timer', 'apt-daily-upgrade.service', 6, 45, 86400000], ['dpkg-db-backup.timer', 'dpkg-db-backup.service', 0, 0, 86400000],
            ['e2scrub_all.timer', 'e2scrub_all.service', 3, 10, 7 * 86400000], ['fstrim.timer', 'fstrim.service', 0, 0, 7 * 86400000], ['logrotate.timer', 'logrotate.service', 0, 0, 86400000],
            ['man-db.timer', 'man-db.service', 0, 0, 86400000], ['systemd-tmpfiles-clean.timer', 'systemd-tmpfiles-clean.service', now ? new Date(now).getUTCHours() : 0, 0, 86400000]];
          const rows = defs.map(([unit, act, h, mi, every]) => {
            let next = at(h, mi); while (next <= now) next += every; const last = next - every;
            return { next, last, cells: [stamp(next), rel(next - now), stamp(last), rel(now - last) + ' ago', unit, act] };
          }).sort((x, y) => x.next - y.next);
          const head = ['NEXT', 'LEFT', 'LAST', 'PASSED', 'UNIT', 'ACTIVATES'];
          const widths = head.map((hd, i) => Math.max(hd.length, ...rows.map((r) => r.cells[i].length)));
          const fmtRow = (cells) => cells.map((c, i) => (i === 1 || i === 3 ? c.padStart(widths[i]) : i === cells.length - 1 ? c : c.padEnd(widths[i]))).join(' ');
          if (!g.opts['no-legend']) ctx.println(fmtRow(head));
          for (const r of rows) ctx.println(fmtRow(r.cells));
          if (!g.opts['no-legend']) ctx.println('\n' + rows.length + ' timers listed.\nPass --all to see loaded but inactive timers, too.');
          return 0;
        }
        case 'list-units': case 'list-sockets': {
          let units = m.units.filter((u) => g.opts.a || g.opts.failed ? true : u.active !== 'inactive' || u.sub === 'exited');
          const wantState = g.opts.state ? String(g.opts.state).split(',') : null;
          if (wantState) units = m.units.filter((u) => wantState.indexOf(u.active) >= 0 || wantState.indexOf(u.sub) >= 0 || wantState.indexOf('loaded') >= 0);
          else if (g.opts.failed) units = units.filter((u) => u.active === 'failed');
          else if (!g.opts.a) units = units.filter((u) => u.active === 'active' || u.active === 'failed');
          let list = units.map((u) => u);
          const type = g.opts.t || '';
          if (!type && !g.opts.failed && !wantState) list = list.concat(EXTRA_UNITS(m));
          if (type && type !== 'service') list = type === 'target' ? EXTRA_UNITS(m) : [];
          if (names.length) list = list.filter((u) => names.some((p) => U.globToRe(p.replace(/\.service$/, '') + '*').test(u.name)));
          list.sort((a, b) => (a.name < b.name ? -1 : 1));
          const lines = list.length ? unitTable(ctx, list, {}) : [];
          if (!list.length) { ctx.println('0 loaded units listed.'); return 0; }
          if (g.opts['no-legend']) lines.splice(0, 1);
          ctx.println(lines.join('\n'));
          if (!g.opts['no-legend']) ctx.println('\nLegend: LOAD   → Reflects whether the unit definition was properly loaded.\n        ACTIVE → The high-level unit activation state, i.e. generalization of SUB.\n        SUB    → The low-level unit activation state, values depend on unit type.\n\n' + list.length + ' loaded units listed.' + (g.opts.a ? '' : ' Pass --all to see loaded but inactive units, too.') + "\nTo show all installed unit files use 'systemctl list-unit-files'.");
          return 0;
        }
        case 'list-unit-files': {
          let units = m.units.filter((u) => !u.instance || true);
          if (g.opts.t && g.opts.t !== 'service') units = [];
          if (names.length) units = units.filter((u) => names.some((p) => U.globToRe(p.replace(/\.service$/, '') + '*').test(u.name)));
          units = units.slice().sort((a, b) => (a.name < b.name ? -1 : 1));
          const state = (u) => (u.enabled === 'static' ? 'static' : u.enabled ? 'enabled' : 'disabled');
          const rows = units.map((u) => [u.name, state(u), u.enabled === 'static' ? '-' : u.preset || 'enabled']);
          const head = ['UNIT FILE', 'STATE', 'PRESET'];
          const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
          const fmt = (r) => r.map((c, i) => (i < 2 ? c.padEnd(w[i]) : c)).join(' ');
          const lines = g.opts['no-legend'] ? [] : [fmt(head)];
          for (const r of rows) lines.push(fmt(r));
          ctx.println(lines.join('\n') + (g.opts['no-legend'] ? '' : '\n\n' + rows.length + ' unit files listed.'));
          return 0;
        }
        case 'status': {
          if (!names.length) { ctx.println('● ' + m.hostname + '\n    State: running\n    Units: ' + m.units.length + ' loaded (incl. loaded aliases)\n     Jobs: 0 queued\n   Failed: ' + m.units.filter((u) => u.active === 'failed').length + ' units'); return 0; }
          let code = 0; const blocks = [];
          const lines = g.opts.n != null ? parseInt(g.opts.n, 10) : 10;
          for (const n of names) {
            const u = K.sys.unit(m, n);
            if (!u) { ctx.err('Unit ' + n + ' could not be found.\n'); code = Math.max(code, 4); continue; }
            blocks.push(unitStatus(ctx, u, lines));
            code = Math.max(code, u.active === 'active' ? 0 : 3);
          }
          if (blocks.length) ctx.out(blocks.join('\n'));
          return code;
        }
        case 'is-active': case 'is-failed': {
          if (!names.length) { ctx.err('Too few arguments.\n'); return 1; }
          let code = verb === 'is-active' ? 3 : 1;
          for (const n of names) {
            const u = K.sys.unit(m, n);
            const state = u ? u.active : 'inactive';
            if (!quiet) ctx.println(state);
            if (verb === 'is-active' ? state === 'active' : state === 'failed') code = 0;
          }
          return code;
        }
        case 'is-enabled': {
          if (!names.length) { ctx.err('Too few arguments.\n'); return 1; }
          let code = 0;
          for (const n of names) {
            const u = K.sys.unit(m, n);
            if (!u) { ctx.err('Failed to get unit file state for ' + n + ': No such file or directory\n'); code = 1; continue; }
            const s = u.masked ? 'masked' : u.enabled === 'static' ? 'static' : u.enabled ? 'enabled' : 'disabled';
            if (!quiet) ctx.println(s);
            if (s === 'disabled' || s === 'masked') code = 1;
          }
          return code;
        }
        case 'start': case 'stop': case 'restart': case 'reload': case 'try-restart': case 'reload-or-restart': {
          if (!names.length) { ctx.err('Too few arguments.\n'); return 1; }
          const { units, missing } = resolveUnits(ctx, names, verb);
          const label = verb === 'try-restart' ? 'restart' : verb === 'reload-or-restart' ? 'reload' : verb;
          if (missing.length) { for (const n of missing) ctx.err('Failed to ' + label + ' ' + n + ': Unit ' + n + ' not found.\n'); return 5; }
          if (!ctx.isRoot) {
            ctx.err('Failed to ' + label + ' ' + units[0].name + ': Interactive authentication required.\nSee system logs and \'systemctl status ' + units[0].name + "' for details.\n");
            return 1;
          }
          const maskedUnit = verb !== 'stop' && units.find((u) => u.masked);
          if (maskedUnit) { ctx.err('Failed to ' + label + ' ' + maskedUnit.name + ': Unit ' + maskedUnit.name + ' is masked.\n'); return 1; }
          let code = 0;
          for (const u of units) {
            if (verb === 'reload' && (u.active !== 'active' || NO_RELOAD.test(u.name))) {
              ctx.err('Failed to reload ' + u.name + ': ' + (u.active !== 'active' ? 'Unit ' + u.name + ' is not active.' : 'Job type reload is not applicable for unit ' + u.name + '.') + '\n');
              code = 1; continue;
            }
            if (verb === 'reload' || verb === 'reload-or-restart' && u.active === 'active' && !NO_RELOAD.test(u.name)) {
              K.syslog(m, { ident: 'systemd', pid: 1, facility: 'daemon', unit: u.name, msg: 'Reloading ' + u.name + ' - ' + u.desc + '...' });
              K.syslog(m, { ident: 'systemd', pid: 1, facility: 'daemon', unit: u.name, msg: 'Reloaded ' + u.name + ' - ' + u.desc + '.' });
              continue;
            }
            if (verb === 'try-restart' && u.active !== 'active') continue;
            if (verb === 'stop') { const was = u.since; K.sys.stopUnit(m, u); if (u.since && was) u.ranFor = u.since - was; continue; }
            if (u.active === 'active' && verb === 'start') continue;
            if (u.active === 'active') K.sys.stopUnit(m, u);
            const r = K.sys.startUnit(m, u);
            if (!r.ok) { ctx.err(failedJob(u, verb)); code = 1; }
          }
          return code;
        }
        case 'enable': case 'disable': case 'reenable': {
          if (!names.length) { ctx.err('Too few arguments.\n'); return 1; }
          const enable = verb !== 'disable';
          const { units, missing } = resolveUnits(ctx, names, verb);
          if (missing.length) { ctx.err('Failed to ' + verb + ' unit: Unit file ' + missing[0] + ' does not exist.\n'); return 1; }
          if (!need('Failed to ' + verb + ' unit')) return 1;
          for (const u of units) {
            if (u.enabled === 'static') {
              ctx.err('The unit files have no installation config (WantedBy=, RequiredBy=, UpheldBy=,\nAlso=, or Alias= settings in the [Install] section, and DefaultInstance= for\ntemplate units). This means they are not meant to be enabled or disabled using systemctl.\n \nPossible reasons for having these kinds of units are:\n' +
                '• A unit may be statically enabled by being symlinked from another unit\'s\n  .wants/, .requires/, or .upholds/ directory.\n• A unit\'s purpose may be to act as a helper for some other unit which has\n  a requirement dependency on it.\n• A unit may be started when needed via activation (socket, path, timer,\n  D-Bus, udev, scripted systemctl call, ...).\n• In case of template units, the unit is meant to be enabled with some\n  instance name specified.\n');
              continue;
            }
            if (u.enabled !== enable || verb === 'reenable') for (const l of enableMessages(u, enable)) ctx.println(l);
            u.enabled = enable;
            if (g.opts.now) { if (enable) K.sys.startUnit(m, u); else K.sys.stopUnit(m, u); }
          }
          return 0;
        }
        case 'daemon-reload': case 'daemon-reexec': return need('Failed to ' + (verb === 'daemon-reload' ? 'reload daemon' : 'execute daemon')) ? 0 : 1;
        case 'reset-failed': {
          if (!need('Failed to reset failed state of all units')) return 1;
          for (const u of m.units) if (u.active === 'failed' && (!names.length || names.indexOf(u.name) >= 0)) Object.assign(u, { active: 'inactive', sub: 'dead', result: null });
          return 0;
        }
        case 'cat': {
          if (!names.length) { ctx.err('Too few arguments.\n'); return 1; }
          let code = 0;
          for (const n of names) {
            const u = K.sys.unit(m, n);
            if (!u) { ctx.err('No files found for ' + n + '.\n'); code = 1; continue; }
            const lines = ['# ' + UNIT_DIR + u.name, '[Unit]', 'Description=' + u.desc].concat(u.docs.length ? ['Documentation=' + u.docs.join(' ')] : [], ['', '[Service]', 'Type=' + u.type]);
            if (u.pre) lines.push('ExecStartPre=' + u.pre);
            if (u.exec.length) lines.push('ExecStart=' + u.exec[0].cmd.replace(/^\w[\w-]*: (?=\/)/, '').replace(/ \[listener\].*$/, '').replace(/^(\/usr\/sbin\/sshd -D)$/, '$1 $SSHD_OPTS'));
            lines.push('', '[Install]', 'WantedBy=multi-user.target');
            ctx.println(lines.join('\n'));
          }
          return code;
        }
        case 'is-system-running': if (!quiet) ctx.println('running'); return 0;
        case 'get-default': ctx.println(m.profile === 'kali' ? 'graphical.target' : 'multi-user.target'); return 0;
        case 'show': {
          const u = names.length ? K.sys.unit(m, names[0]) : null;
          if (!u) { ctx.err('Unit ' + (names[0] || '') + ' could not be found.\n'); return names.length ? 1 : 0; }
          const props = [['Id', u.name], ['Description', u.desc], ['LoadState', 'loaded'], ['ActiveState', u.active], ['SubState', u.sub], ['MainPID', u.pid || 0],
            ['UnitFileState', u.enabled === 'static' ? 'static' : u.enabled ? 'enabled' : 'disabled'], ['FragmentPath', UNIT_DIR + u.name]];
          const want = g.opts.p ? [].concat(g.all.p || g.opts.p).join(',').split(',') : null;
          for (const [k, v] of props) if (!want || want.indexOf(k) >= 0) ctx.println(g.opts.value ? v : k + '=' + v);
          return 0;
        }
        case 'mask': case 'unmask': {
          if (!names.length) { ctx.err('Too few arguments.\n'); return 1; }
          if (!need('Failed to ' + verb + ' unit')) return 1;
          for (const u of resolveUnits(ctx, names, verb).units) {
            const link = '/etc/systemd/system/' + u.name;
            if (verb === 'mask' && !u.masked) { u.masked = true; ctx.println("Created symlink '" + link + "' → '/dev/null'."); }
            else if (verb === 'unmask' && u.masked) { u.masked = false; ctx.println("Removed '" + link + "'."); }
          }
          const bad = resolveUnits(ctx, names, verb).missing;
          if (bad.length) { ctx.err('Failed to ' + verb + ' unit: Unit file ' + bad[0] + ' does not exist.\n'); return 1; }
          return 0;
        }
        case 'kill': case 'isolate': case 'poweroff': case 'reboot': case 'halt': case 'suspend':
          return need(verb === 'reboot' || verb === 'poweroff' || verb === 'halt' || verb === 'suspend' ? 'Failed to ' + verb + ' system via logind' : 'Failed to ' + verb + ' unit') ? 0 : 1;
        default:
          ctx.err("Unknown command verb '" + verb + "'.\n");
          return 1;
      }
    },
  });

  /* ---------------------------------------------------------------- service */

  const SERVICE_USAGE = 'Usage: service < option > | --status-all | [ service_name [ command | --full-restart ] ]\n';

  reg({
    name: 'service', path: '/usr/sbin/service', pkg: 'init-system-helpers', section: 8, summary: 'run a System V init script', synopsis: 'service SCRIPT COMMAND [OPTIONS]',
    man: 'DESCRIPTION\n       service runs a System V init script or systemd unit in as predictable an environment as possible, removing most environment variables and with current working directory set to /.\n\n       The SCRIPT parameter specifies a System V init script, located in /etc/init.d/SCRIPT. The supported values of COMMAND depend on the invoked script, service passes COMMAND and OPTIONS to the init script unmodified. For systemd units, the commands start, stop, restart, reload and status are supported.\n\nOPTIONS\n       --status-all\n              List all services with their state: [ + ] running, [ - ] stopped, [ ? ] no status support.\n\n       --full-restart\n              Stop, then start the service.\n\nEXAMPLES\n       sudo service ssh start\n              Start the SSH server.\n       service --status-all\n              Which services run?',
    async run(ctx) {
      const a = ctx.args;
      if (!a.length) { ctx.err(SERVICE_USAGE); return 1; }
      if (a[0] === '--help' || a[0] === '-h') { ctx.out(SERVICE_USAGE); return 0; }
      if (a[0] === '--version' || a[0] === '-V') { ctx.out('service ver. 0.91-ubuntu1\n'); return 0; }
      const m = ctx.machine;
      if (a[0] === '--status-all') {
        const rows = m.units.filter((u) => SYSV_SCRIPTS.indexOf(u.name.replace(/\.service$/, '')) >= 0 || SYSV_SCRIPTS.indexOf(u.prog) >= 0).map((u) => [u.name.replace(/\.service$/, ''), u.active === 'active']);
        rows.sort((x, y) => (x[0] < y[0] ? -1 : 1));
        ctx.println(rows.map(([n, up]) => ' [ ' + (up ? '+' : '-') + ' ]  ' + n).join('\n'));
        return 0;
      }
      const name = a[0];
      const unit = K.sys.unit(m, name);
      if (!unit || !/^[\w@.-]+$/.test(name)) { ctx.err(name + ': unrecognized service\n'); return 1; }
      if (a.length < 2) { ctx.err('Usage: /etc/init.d/' + name + ' {start|stop|restart|reload|force-reload|status}\n'); return 1; }
      let cmd = a[1];
      if (cmd === '--full-restart') cmd = 'restart';
      if (['start', 'stop', 'restart', 'reload', 'force-reload', 'status'].indexOf(cmd) < 0) { ctx.err('Usage: /etc/init.d/' + name + ' {start|stop|restart|reload|force-reload|status}\n'); return 1; }
      const verb = cmd === 'force-reload' ? 'reload' : cmd;
      const r = await ctx.run(['systemctl', verb, unit.name].concat(verb === 'status' ? ['--no-pager'] : []));
      ctx.out(r.out); ctx.err(r.err);
      return r.code;
    },
  });

  /* ------------------------------------------------------ journalctl, dmesg */

  const SPAN_MS = { s: SEC, sec: SEC, second: SEC, seconds: SEC, m: MIN, min: MIN, minute: MIN, minutes: MIN, h: HOUR, hour: HOUR, hours: HOUR, d: DAY, day: DAY, days: DAY, w: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY };

  /** The timestamps journalctl --since/--until accept that matter in practice; null when unparsable. */
  function parseWhen(text, now) {
    const t = text.trim().toLowerCase();
    const midnight = Math.floor(now / DAY) * DAY;
    if (t === 'now') return now;
    if (t === 'today') return midnight;
    if (t === 'yesterday') return midnight - DAY;
    if (t === 'tomorrow') return midnight + DAY;
    let m = /^([+-])?\s*(\d+)\s*([a-z]+)(\s+ago)?$/.exec(t);
    if (m && SPAN_MS[m[3]]) {
      const sign = m[4] || m[1] === '-' ? -1 : 1;
      return now + sign * m[2] * SPAN_MS[m[3]];
    }
    m = /^(\d{4})-(\d\d)-(\d\d)(?:[ t](\d\d):(\d\d)(?::(\d\d))?)?(?: utc)?$/.exec(t);
    if (m) return Date.UTC(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    m = /^(\d\d):(\d\d)(?::(\d\d))?$/.exec(t);
    if (m) return midnight + (+m[1]) * HOUR + (+m[2]) * MIN + (+(m[3] || 0)) * SEC;
    return null;
  }

  const PRIO_NAMES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
  function parsePriorityRange(text) {
    const one = (w) => (/^[0-7]$/.test(w) ? +w : PRIORITIES[w] != null ? PRIORITIES[w] : null);
    const parts = text.split('..');
    const lo = one(parts[0]); const hi = parts.length > 1 ? one(parts[1]) : null;
    if (lo == null || parts.length > 2 || (parts.length === 2 && hi == null)) return null;
    return parts.length === 1 ? [0, lo] : [Math.min(lo, hi), Math.max(lo, hi)];
  }

  /** journalctl takes "-n 5" and "-b -1" although the value is optional: glue a following number to the option. */
  function attachCounts(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if ((a === '-n' || a === '-b' || a === '--lines' || a === '--boot') && /^-?\d+$/.test(args[i + 1] || '')) out.push((a.length === 2 ? a : a + '=') + args[++i]);
      else out.push(a);
    }
    return out;
  }

  const JOURNALCTL_USAGE = 'journalctl [OPTIONS...] [MATCHES...]\n\nQuery the journal.\n\nOptions:\n     --system                Show the system journal\n  -b --boot[=ID]             Show current boot or the specified boot\n  -k --dmesg                 Show kernel message log from the current boot\n  -u --unit=UNIT             Show logs from the specified unit\n  -t --identifier=STRING     Show entries with the specified syslog identifier\n  -p --priority=RANGE        Show entries with the specified priority\n  -g --grep=REGEX            Show entries with MESSAGE matching REGEX\n  -S --since=DATE            Show entries not older than the specified date\n  -U --until=DATE            Show entries not newer than the specified date\n  -n --lines[=INTEGER]       Number of journal entries to show\n  -r --reverse               Show the newest entries first\n  -o --output=STRING         Change journal output mode (short, short-iso, cat, ...)\n  -x --catalog               Add message explanations where available\n  -e --pager-end             Immediately jump to the end in the pager\n  -f --follow                Follow the journal\n     --no-pager              Do not pipe output into a pager\n  -q --quiet                 Do not show info messages and privilege warning\n     --disk-usage            Show total disk usage of all journal files\n     --list-boots            Show terse information about recorded boots\n  -h --help                  Show this help\n     --version               Show package version\n';

  reg({
    name: 'journalctl', pkg: 'systemd', summary: 'Print log entries from the systemd journal', synopsis: 'journalctl [OPTIONS...] [MATCHES...]',
    man: 'DESCRIPTION\n       journalctl may be used to query the contents of the systemd(1) journal as written by systemd-journald.service(8).\n\n       If called without parameters, it will show the full contents of the journal, starting with the oldest entry collected.\n\nOPTIONS\n       -u, --unit=UNIT\n              Show messages for the specified systemd unit.\n\n       -n, --lines=N\n              Show the most recent N journal events.\n\n       -f, --follow\n              Show only the most recent journal entries, and continuously print new entries as they are appended to the journal.\n\n       -r, --reverse\n              Reverse output so that the newest entries are displayed first.\n\n       -p, --priority=\n              Filter output by message priorities or priority ranges (emerg, alert, crit, err, warning, notice, info, debug).\n\n       -b, --boot\n              Show messages from the current boot.\n\n       -k, --dmesg\n              Show only kernel messages.\n\n       -S, --since=, -U, --until=\n              Start or end the output at the given date, e.g. "2026-11-13 10:00:00", "today" or "1 hour ago".\n\n       --no-pager\n              Do not pipe output into a pager.\n\nEXAMPLES\n       journalctl -u ssh -n 20 --no-pager\n              The last twenty lines the SSH server logged.\n       journalctl -p err -b\n              Everything at priority err or worse since boot.\n       sudo journalctl -f -u apache2\n              Follow the web server log.',
    async run(ctx) {
      const g = K.getopt(attachCounts(ctx.args), { short: 'hu:b::kt:p:g:S:U:n::rxefqo:mNF:', long: ['help', 'version', 'unit=', 'boot=?', 'dmesg', 'identifier=', 'priority=', 'grep=', 'since=', 'until=', 'lines=?', 'reverse', 'catalog', 'pager-end', 'follow', 'no-pager', 'quiet', 'output=', 'system', 'user', 'merge', 'disk-usage', 'list-boots', 'no-hostname', 'utc', 'full', 'flush', 'rotate', 'vacuum-size=', 'field='],
        alias: { help: 'h', unit: 'u', boot: 'b', dmesg: 'k', identifier: 't', priority: 'p', grep: 'g', since: 'S', until: 'U', lines: 'n', reverse: 'r', catalog: 'x', 'pager-end': 'e', follow: 'f', quiet: 'q', output: 'o' } });
      if (g.err) { ctx.err('journalctl: ' + g.err + '\n'); return 1; }
      if (g.opts.h) { ctx.out(JOURNALCTL_USAGE); return 0; }
      if (g.opts.version) { ctx.out('systemd 258 (258.1-1)\n+PAM +AUDIT +SELINUX\n'); return 0; }
      const m = ctx.machine; const now = K.clock.now();
      const groups = m.groupsOf(ctx.user.name).map((x) => x.name);
      const sees = ctx.isRoot || groups.indexOf('adm') >= 0 || groups.indexOf('systemd-journal') >= 0;
      if (g.opts['disk-usage']) { ctx.println('Archived and active journals take up 8.0M in the file system.'); return 0; }
      if (g.opts['list-boots']) {
        const first = journalOf(m)[0]; const boot = K.getBootTime();
        const id = U.hash32('bid' + boot).toString(16).padStart(8, '0') + U.hash32('boot' + boot).toString(16).padStart(8, '0') + U.hash32(boot + 'x').toString(16).padStart(8, '0') + U.hash32('y' + boot).toString(16).padStart(8, '0');
        ctx.println(' IDX BOOT ID                          FIRST ENTRY                      LAST ENTRY                       \n  0 ' + id + ' ' + unitStamp(first ? first.ts : boot) + ' ' + unitStamp(now));
        return 0;
      }
      if (g.opts.flush || g.opts.rotate || g.opts['vacuum-size']) {
        if (!ctx.isRoot) { ctx.err('Failed to ' + (g.opts.flush ? 'flush journal' : 'rotate journal') + ': Interactive authentication required.\n'); return 1; }
        return 0;
      }
      if (typeof g.opts.b === 'string' && g.opts.b !== '0' && g.opts.b !== '-0') {
        if (/^-?\d+$/.test(g.opts.b)) { ctx.err('No journal boot entry found from the specified boot offset.\n'); return 1; }
        ctx.err('Data from the specified boot (' + g.opts.b + ') is not available: No such boot ID in journal\n'); return 1;
      }
      const units = [].concat(g.all.u || []).map(withSuffix);
      for (const u of units) if (!K.sys.unit(m, u) && g.all.u && false) return 1;
      let lo = 0; let hi = 7;
      if (g.opts.p != null) {
        const r = parsePriorityRange(String(g.opts.p));
        if (!r) { ctx.err('Unknown log level ' + g.opts.p + '\n'); return 1; }
        [lo, hi] = r;
      }
      let since = null; let until = null;
      for (const [key, set] of [['S', (v) => { since = v; }], ['U', (v) => { until = v; }]]) {
        if (g.opts[key] == null) continue;
        const v = parseWhen(String(g.opts[key]), now);
        if (v == null) { ctx.err('Failed to parse ' + (key === 'S' ? 'timestamp' : 'timestamp') + ': ' + g.opts[key] + '\n'); return 1; }
        set(v);
      }
      let re = null;
      if (g.opts.g != null) { try { re = new RegExp(g.opts.g); } catch (e) { ctx.err('Failed to compile regular expression ' + g.opts.g + '\n'); return 1; } }
      const fields = g.rest.map((x) => /^([A-Z_]+)=(.*)$/.exec(x)).filter(Boolean);
      const mode = g.opts.o === 'short-iso' || g.opts.o === 'cat' ? g.opts.o : 'short';
      if (g.opts.o && ['short', 'short-iso', 'short-precise', 'cat', 'json', 'verbose'].indexOf(g.opts.o) < 0) { ctx.err('Unknown output format \'' + g.opts.o + "'.\n"); return 1; }
      const matches = (r) => {
        if (!sees && r.ident !== 'sudo') return false;
        if (units.length && units.indexOf(r.unit) < 0) return false;
        if (g.opts.k && r.ident !== 'kernel') return false;
        if (g.opts.t && r.ident !== g.opts.t) return false;
        if (r.prio < lo || r.prio > hi) return false;
        if (since != null && r.ts < since) return false;
        if (until != null && r.ts > until) return false;
        if (re && !re.test(r.msg)) return false;
        for (const [, k, v] of fields) {
          if ((k === '_SYSTEMD_UNIT' && r.unit !== v) || (k === '_COMM' && r.ident !== v) || (k === 'SYSLOG_IDENTIFIER' && r.ident !== v) || (k === '_PID' && String(r.pid) !== v) || (k === 'PRIORITY' && String(r.prio) !== v)) return false;
        }
        return true;
      };
      const render = (r) => (g.opts.o === 'json'
        ? JSON.stringify({ __REALTIME_TIMESTAMP: String(r.ts * 1000), _HOSTNAME: m.hostname, SYSLOG_IDENTIFIER: r.ident, _PID: r.pid == null ? undefined : String(r.pid), PRIORITY: String(r.prio), MESSAGE: r.msg })
        : journalLine(m, r, mode));
      let recs = journalOf(m).filter(matches);
      const follow = !!g.opts.f;
      let limit = g.opts.n != null ? (g.opts.n === true ? 10 : parseInt(g.opts.n, 10)) : g.opts.e ? 1000 : follow ? 10 : null;
      if (limit != null && isNaN(limit)) { ctx.err('Failed to parse lines \'' + g.opts.n + "'\n"); return 1; }
      if (limit != null) recs = recs.slice(Math.max(0, recs.length - limit));
      if (g.opts.r) recs = recs.slice().reverse();
      const lines = recs.map(render);
      let text = lines.join('\n') + (lines.length ? '\n' : '');
      if (!lines.length) text = '-- No entries --\n';
      if (!sees && !g.opts.q) text = "Hint: You are currently not seeing messages from other users and the system.\n      Users in groups 'adm', 'systemd-journal' can see all messages.\n      Pass -q to turn off this notice.\n" + text;
      if (!follow) {
        if (ctx.isTTY && !g.opts['no-pager'] && lines.length > ctx.rows - 1) await ctx.term.pager(text, { title: 'journalctl' });
        else ctx.out(text);
        return 0;
      }
      ctx.out(lines.length ? text : '');
      let seen = journalOf(m).length;
      try {
        for (;;) {
          await ctx.sleep(1000);
          if (K.clock._virtual) await new Promise((r) => setTimeout(r, 0));
          const all = journalOf(m);
          if (all.length > seen) { for (const r of all.slice(seen).filter(matches)) ctx.println(render(r)); seen = all.length; }
        }
      } catch (e) { if (e instanceof K.Interrupt) return 130; throw e; }
    },
  });

  const DMESG_USAGE = '\nUsage:\n dmesg [options]\n\nDisplay or control the kernel ring buffer.\n\nOptions:\n -C, --clear                 clear the kernel ring buffer\n -c, --read-clear            read and clear all messages\n -H, --human                 human-readable output\n -k, --kernel                display kernel messages\n -l, --level <list>          restrict output to defined levels\n -r, --raw                   print the raw message buffer\n -T, --ctime                 show human-readable timestamp (may be inaccurate!)\n -t, --notime                don\'t show any timestamp with messages\n -x, --decode                decode facility and level to readable string\n\n -h, --help                  display this help\n -V, --version               display version\n\nSupported log facilities:\n    kern - kernel messages\n    user - random user-level messages\n  daemon - system daemons\n\nSupported log levels (priorities):\n   emerg - system is unusable\n   alert - action must be taken immediately\n    crit - critical conditions\n     err - error conditions\n    warn - warning conditions\n  notice - normal but significant condition\n    info - informational\n   debug - debug-level messages\n\nFor more details see dmesg(1).\n';

  reg({
    name: 'dmesg', path: '/usr/bin/dmesg', pkg: 'util-linux', summary: 'print or control the kernel ring buffer', synopsis: 'dmesg [options]',
    man: 'DESCRIPTION\n       dmesg is used to examine or control the kernel ring buffer.\n\n       The default action is to display all messages from the kernel ring buffer. On Kali, reading it needs root (kernel.dmesg_restrict is set).\n\nOPTIONS\n       -T, --ctime\n              Print human-readable timestamps.\n\n       -l, --level list\n              Restrict output to the given (comma-separated) list of levels, e.g. err,warn.\n\n       -x, --decode\n              Decode facility and level (priority) numbers to human-readable prefixes.\n\n       -t, --notime\n              Do not print kernel\'s timestamps.\n\n       -C, --clear\n              Clear the ring buffer.\n\nEXAMPLES\n       sudo dmesg | tail\n              The latest kernel messages.\n       sudo dmesg -T -l err,warn\n              Errors and warnings with wall-clock times.',
    run(ctx) {
      const g = ctx.getopt({ short: 'CcHkl:rTtxhVw', long: ['clear', 'read-clear', 'human', 'kernel', 'level=', 'raw', 'ctime', 'notime', 'decode', 'help', 'version', 'follow'], alias: { clear: 'C', 'read-clear': 'c', human: 'H', kernel: 'k', level: 'l', raw: 'r', ctime: 'T', notime: 't', decode: 'x', help: 'h', version: 'V' } });
      if (g.err) { ctx.err('dmesg: ' + g.err + "\nTry 'dmesg --help' for more information.\n"); return 1; }
      if (g.opts.h) { ctx.out(DMESG_USAGE); return 0; }
      if (g.opts.V) { ctx.out('dmesg from util-linux 2.41\n'); return 0; }
      if (!ctx.isRoot) { ctx.err('dmesg: ' + (g.opts.C || g.opts.c ? 'klogctl failed: Operation not permitted' : 'read kernel buffer failed: Operation not permitted') + '\n'); return 1; }
      let levels = null;
      if (g.opts.l != null) {
        levels = String(g.opts.l).split(',').map((w) => (w === 'warn' ? 4 : PRIORITIES[w]));
        if (levels.some((x) => x == null)) { ctx.err("dmesg: unknown level '" + String(g.opts.l).split(',').find((w) => PRIORITIES[w] == null && w !== 'warn') + "'\n"); return 1; }
      }
      const rows = journalOf(ctx.machine).filter((r) => r.ident === 'kernel' && (!levels || levels.indexOf(r.prio) >= 0));
      const boot = K.getBootTime();
      const lines = rows.map((r) => {
        const mono = r.mono != null ? r.mono : (r.ts - boot) / 1000;
        let stamp = '[' + U.padStart(mono.toFixed(6), 12) + '] ';
        if (g.opts.t) stamp = '';
        else if (g.opts.T) stamp = '[' + unitStamp(boot + mono * 1000).replace(/^(\w+) (\d{4})-(\d\d)-(\d\d) (\S+) UTC$/, (a, dow, y, mo, d, t) => dow + ' ' + U.MONTHS[+mo - 1] + ' ' + U.padStart(+d, 2) + ' ' + t + ' ' + y) + '] ';
        const prefix = g.opts.x ? 'kern  :' + PRIO_NAMES[r.prio === 4 ? 4 : r.prio].replace('warning', 'warn').padEnd(6) + ': ' : '';
        return prefix + stamp + r.msg;
      });
      if (g.opts.C || g.opts.c) { if (g.opts.C) return 0; }
      if (lines.length) ctx.println(lines.join('\n'));
      return 0;
    },
  });

  /* ---------------------------------------------- manual pages and look-ups */

  const SECTION_TITLES = { 1: 'User Commands', 5: 'File Formats Manual', 7: 'Miscellaneous Information Manual', 8: 'System Manager\'s Manual' };
  const PACKAGE_LABELS = { coreutils: 'GNU coreutils 9.7', procps: 'procps-ng 4.0.4', systemd: 'systemd 258', 'util-linux': 'util-linux 2.41', 'hostname': 'hostname 3.25', psmisc: 'psmisc 23.7' };
  const MAN_WIDTH = 78;

  /** Command definitions the machine really has (lab servers lack the Kali-only tools). */
  function commandsOf(machine) {
    return K.cmd.list().filter((d) => !(d.only === 'kali' && machine.profile !== 'kali') && d.installed !== false);
  }
  const manBody = (def) => (typeof def.man === 'function' ? def.man() : def.man) || MAN_BODIES[def.name] || '';

  /** Section 5 pages for the configuration files the lessons talk about, and bodies for commands registered without one. */
  const FILE_PAGES = [
    { name: 'passwd', section: 5, pkg: 'passwd', summary: 'the password file', synopsis: '/etc/passwd',
      man: 'DESCRIPTION\n       /etc/passwd contains one-line entries for each user account, with seven fields delimited by colons. These fields are:\n\n       login name : optional encrypted password : numerical user ID : numerical group ID : user name or comment field : user home directory : optional user command interpreter\n\n       A line such as\n\n              kali:x:1000:1000:Kali,,,:/home/kali:/usr/bin/zsh\n\n       describes the account kali. An "x" in the password field means the real password hash is kept in /etc/shadow. A "*" or "!" means the account cannot log in with a password. The file is readable by every user and writable only by root.\n\nFILES\n       /etc/passwd\n       /etc/shadow\n\nSEE ALSO\n       passwd(1), shadow(5), group(5), useradd(8), vipw(8)' },
    { name: 'shadow', section: 5, pkg: 'passwd', summary: 'encrypted password file', synopsis: '/etc/shadow',
      man: 'DESCRIPTION\n       shadow contains the encrypted password information for user accounts and optional password ageing information. It is readable only by root (mode 640, group shadow). Each line has nine fields, separated by colons:\n\n       login name : encrypted password : date of last password change : minimum password age : maximum password age : password warning period : password inactivity period : account expiration date : reserved field\n\n       The encrypted password field holds a hash in the form $id$salt$hash, where the id selects the algorithm ($y$ is yescrypt, the default on current Kali, $6$ is SHA-512). A password field starting with ! means the password is locked; * means no password login is possible.\n\nFILES\n       /etc/shadow\n\nSEE ALSO\n       passwd(5), passwd(1), chage(1), login.defs(5)' },
    { name: 'group', section: 5, pkg: 'passwd', summary: 'user group file', synopsis: '/etc/group',
      man: 'DESCRIPTION\n       /etc/group contains one-line entries for each group, with four fields delimited by colons:\n\n       group_name : password : GID : user_list\n\n       The password field is normally x (the real value, if any, is in /etc/gshadow). The user_list is a comma-separated list of the users who are members of the group, for example\n\n              sudo:x:27:kali\n\n       A user is also a member of the group named by the GID field of their /etc/passwd entry, even if not listed here.\n\nFILES\n       /etc/group\n\nSEE ALSO\n       passwd(5), id(1), groups(1), usermod(8), gpasswd(1)' },
    { name: 'hosts', section: 5, pkg: 'manpages', summary: 'static table lookup for hostnames', synopsis: '/etc/hosts',
      man: 'DESCRIPTION\n       This manual page describes the format of the /etc/hosts file. This file is a simple text file that associates IP addresses with hostnames, one line per IP address. For each host a single line should be present with the following information:\n\n              IP_address canonical_hostname [aliases...]\n\n       Fields of the entry are separated by any number of blanks and/or tab characters. Text from a "#" character until the end of the line is a comment and is ignored.\n\n       The resolver consults this file before asking a DNS server when /etc/nsswitch.conf lists "files" before "dns" on the hosts line. Example:\n\n              127.0.0.1   localhost\n              10.10.10.5  kali\n\nFILES\n       /etc/hosts\n\nSEE ALSO\n       hostname(1), resolv.conf(5), nsswitch.conf(5)' },
    { name: 'resolv.conf', section: 5, pkg: 'manpages', summary: 'resolver configuration file', synopsis: '/etc/resolv.conf',
      man: 'DESCRIPTION\n       The resolver is a set of routines in the C library that provide access to the Internet Domain Name System. The resolver configuration file contains information that is read by the resolver routines the first time they are invoked by a process. The file is designed to be human readable and contains a list of keywords with values:\n\n       nameserver\n              Name server IP address. Up to three may be listed, one per line; they are queried in order.\n\n       search Search list for host-name lookup. A bare name such as "web01" is tried with each domain appended.\n\n       domain Local domain name.\n\n       options\n              Options such as timeout:n, attempts:n and ndots:n.\n\n       On Kali this file is usually generated by NetworkManager or systemd-resolved; edits are overwritten when they next run.\n\nFILES\n       /etc/resolv.conf\n\nSEE ALSO\n       hosts(5), nsswitch.conf(5), resolvectl(1)' },
    { name: 'sudoers', section: 5, pkg: 'sudo', summary: 'default sudo security policy plugin', synopsis: '/etc/sudoers',
      man: 'DESCRIPTION\n       The sudoers policy plugin determines a user\'s sudo privileges. The policy is driven by the /etc/sudoers file and, optionally, files in /etc/sudoers.d. Always edit it with visudo, which checks the syntax before saving: a broken sudoers file can lock everyone out of sudo.\n\n       A user specification has the form\n\n              user host = (runas) command\n\n       for example\n\n              root    ALL=(ALL:ALL) ALL\n              %sudo   ALL=(ALL:ALL) ALL\n              kali    ALL=(root) NOPASSWD: /usr/bin/systemctl\n\n       A name starting with % is a group. NOPASSWD: lets the user run the listed commands without typing a password; grant it sparingly. Lines starting with # are comments (except #include and #includedir).\n\nFILES\n       /etc/sudoers\n       /etc/sudoers.d/\n\nSEE ALSO\n       sudo(8), visudo(8)' },
    { name: 'fstab', section: 5, pkg: 'mount', summary: 'static information about the filesystems', synopsis: '/etc/fstab',
      man: 'DESCRIPTION\n       The file fstab contains descriptive information about the filesystems the system can mount. Each filesystem is described on a separate line, with six fields separated by spaces or tabs:\n\n       fs_spec fs_file fs_vfstype fs_mntops fs_freq fs_passno\n\n       fs_spec is the device, or UUID=..., to mount; fs_file is the mount point; fs_vfstype the filesystem type (ext4, vfat, swap); fs_mntops the mount options (defaults, ro, noexec, nosuid ...); fs_freq is used by dump(8) and is normally 0; fs_passno is the order in which fsck checks the filesystem at boot (1 for /, 2 for others, 0 to skip).\n\n       Lines starting with # are comments.\n\nFILES\n       /etc/fstab\n\nSEE ALSO\n       mount(8), findmnt(8), swapon(8)' },
  ];
  const MAN_BODIES = {
    sudo: 'DESCRIPTION\n       sudo allows a permitted user to execute a command as the superuser or another user, as specified by the security policy in /etc/sudoers. The invoking user\'s own password is asked for (not root\'s), and is remembered for a few minutes.\n\nOPTIONS\n       -u user\n              Run the command as user instead of root.\n\n       -i     Run the login shell of the target user, with its environment.\n\n       -s     Run the shell given by $SHELL (or the target user\'s shell).\n\n       -l     List the commands the invoking user may run.\n\n       -k     Forget the remembered password so the next sudo asks again.\n\n       -v     Refresh the remembered password timestamp without running a command.\n\nEXAMPLES\n       sudo apt update\n              Run one command as root.\n       sudo -u www-data ls /var/www\n              Run a command as another user.\n       sudo -l\n              See what you are allowed to do.\n\nSEE ALSO\n       sudoers(5), su(1), visudo(8)',
    su: 'DESCRIPTION\n       su allows commands to be run with a substitute user and group ID. When called with no user specified, su defaults to running an interactive shell as root and asks for root\'s password. With - (or -l) the shell is a login shell with the target user\'s environment.\n\nOPTIONS\n       -, -l, --login\n              Start the shell as a login shell.\n\n       -c, --command=command\n              Pass command to the shell and exit.\n\n       -s, --shell=shell\n              Run shell instead of the one in /etc/passwd.\n\nEXAMPLES\n       su -\n              Become root with a login shell (needs root\'s password).\n       su - analyst -c id\n              Run one command as another user.\n\nSEE ALSO\n       sudo(8), passwd(5)',
    bash: 'DESCRIPTION\n       Bash is an sh-compatible command language interpreter that executes commands read from the standard input or from a file. A command line is split into words, expanded (variables, $(...), globs, braces), connected with pipes and redirections, and run.\n\nOPTIONS\n       -c string\n              Read commands from string, then exit.\n\n       -l     Act as a login shell.\n\n       -x     Print each command before it runs (trace).\n\n       -e     Exit at the first command that fails.\n\n       -n     Read commands but do not run them (syntax check).\n\n       --version\n              Show version information.\n\nINVOCATION\n       bash script.sh runs a script file; bash -c \'echo hi\' runs a string. A script that starts with #!/bin/bash and is executable can be run as ./script.sh.\n\nSEE ALSO\n       sh(1), zsh(1)',
    sh: 'DESCRIPTION\n       sh is the standard command interpreter. On Kali it is a link to dash or bash and behaves as a POSIX shell: fewer extensions than bash, so scripts that use arrays or [[ ]] should name bash explicitly.\n\nOPTIONS\n       -c string\n              Read commands from string, then exit.\n\n       -x     Print each command before it runs.\n\n       -e     Exit at the first command that fails.\n\nSEE ALSO\n       bash(1), zsh(1)',
    zsh: 'DESCRIPTION\n       Zsh is a shell with command line editing, spelling correction, programmable command completion and many bash-compatible features. It is the default interactive shell for the kali user on current Kali.\n\nOPTIONS\n       -c string\n              Read commands from string, then exit.\n\n       -l     Act as a login shell.\n\n       -x     Print each command before it runs.\n\nFILES\n       ~/.zshrc\n              Read by every interactive zsh; put aliases and prompt settings here.\n\nSEE ALSO\n       bash(1), sh(1)',
  };
  /** Every page the machine has: commands plus the file-format pages. */
  const allPages = (machine) => commandsOf(machine).concat(FILE_PAGES);

  /** Break long lines at the page width, keeping each line's indentation on the continuation. */
  function wrapManLine(line) {
    if (line.length <= MAN_WIDTH) return [line];
    const indent = /^ */.exec(line)[0]; const words = line.slice(indent.length).split(' ');
    const out = []; let cur = indent;
    for (const w of words) {
      if (cur.length > indent.length && (cur + ' ' + w).length > MAN_WIDTH) { out.push(cur); cur = indent + w; } else cur += (cur.length > indent.length ? ' ' : '') + w;
    }
    out.push(cur);
    return out;
  }

  const threeColumns = (l, c, r) => {
    const gap = MAN_WIDTH - l.length - c.length - r.length;
    const left = Math.floor(gap / 2);
    return l + ' '.repeat(Math.max(1, left)) + c + ' '.repeat(Math.max(1, gap - left)) + r;
  };

  /** A full man page for a command, laid out like groff's man macros do on a terminal. */
  function renderManPage(def, bold) {
    const title = def.name.toUpperCase() + '(' + def.section + ')';
    const heading = (h) => (bold ? K.c.bold(h) : h);
    const body = manBody(def).replace(/\n+$/, '');
    const lines = [threeColumns(title, SECTION_TITLES[def.section] || 'User Commands', title), ''];
    lines.push(heading('NAME'), ...wrapManLine('       ' + def.name + ' - ' + def.summary), '');
    if (def.synopsis) lines.push(heading('SYNOPSIS'), ...def.synopsis.split('\n').flatMap((l) => wrapManLine((l.startsWith('       ') ? '' : '       ') + l)), '');
    const text = /^[A-Z][A-Z ]+(\n|$)/.test(body) ? body : 'DESCRIPTION\n       ' + body;
    // Page text written hard-wrapped (about 70 columns) would otherwise show ragged breaks once the
    // renderer wraps at 78: join a long prose line with its same-indented continuation.
    const joined = [];
    for (const l of text.split('\n')) {
      const prev = joined[joined.length - 1];
      const ind = prev == null ? '' : /^ */.exec(prev)[0];
      if (prev != null && ind.length >= 7 && l.startsWith(ind) && l.length > ind.length && l[ind.length] !== ' ' && /^[a-z(\[]/.test(l.slice(ind.length)) &&
          prev.length >= 60 && prev.length < MAN_WIDTH && !/[:.]$/.test(prev) === true && !/^ *-/.test(prev)) joined[joined.length - 1] = prev + ' ' + l.slice(ind.length);
      else joined.push(l);
    }
    for (const l of joined) {
      if (/^[A-Z][A-Z ]+$/.test(l)) lines.push(heading(l));
      else lines.push.apply(lines, wrapManLine(l));
    }
    const now = new Date(K.clock.now());
    lines.push('', threeColumns(PACKAGE_LABELS[def.pkg] || def.pkg || 'Kali', MONTH_NAMES[now.getUTCMonth()] + ' ' + now.getUTCFullYear(), title));
    return lines.join('\n') + '\n';
  }

  const whatisLine = (d) => (d.name + ' (' + d.section + ')').padEnd(20) + ' - ' + d.summary;
  const NOTHING = (what) => what + ': nothing appropriate.\n';

  function findPage(ctx, name, section) {
    const defs = allPages(ctx.machine).filter((d) => d.name === name);
    return defs.find((d) => section == null || String(d.section) === String(section)) || null;
  }

  async function showManual(ctx, names, section, opts) {
    let code = 0;
    for (const name of names) {
      const def = findPage(ctx, name, section);
      if (!def) {
        ctx.err('No manual entry for ' + name + (section != null ? ' in section ' + section : '') + "\nSee 'man 7 undocumented' for help when manual pages are not available.\n");
        code = 16;
        continue;
      }
      if (opts.path) { ctx.println('/usr/share/man/man' + def.section + '/' + def.name + '.' + def.section + '.gz'); continue; }
      const text = renderManPage(def, ctx.isTTY);
      if (ctx.isTTY) await ctx.term.pager(text, { title: 'Manual page ' + name + '(' + def.section + ')' });
      else ctx.out(K.util.stripAnsi(text));
    }
    return code;
  }

  const MAN_USAGE = 'Usage: man [OPTION...] [SECTION] PAGE...\n\n  -k, --apropos              equivalent to apropos(1)\n  -f, --whatis               equivalent to whatis(1)\n  -w, --where, --path, --location\n                             print physical location of man page(s)\n  -a, --all                  find all matching manual pages\n  -s, --sections=LIST        use colon separated section list\n\n  -?, --help                 give this help list\n      --usage                give a short usage message\n  -V, --version              print program version\n';

  /** apropos and `man -k`: pages whose name or summary matches any keyword. */
  function searchPages(ctx, words, o) {
    const res = words.map((w) => { try { return new RegExp(o.exact ? '^' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$' : w, 'i'); } catch (e) { return null; } });
    if (res.some((r) => !r)) { ctx.err(ctx.name + ': invalid regular expression\n'); return 2; }
    const hits = [];
    for (const d of allPages(ctx.machine)) {
      const hay = (r) => r.test(d.name) || (!o.exact && r.test(d.summary));
      if (o.and ? res.every(hay) : res.some(hay)) hits.push(d);
    }
    hits.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.section - b.section));
    if (!hits.length) { ctx.err(NOTHING(words.join(' ')).replace(/^(.*): nothing/, (a, w) => w + ': nothing')); return 16; }
    ctx.println(hits.map(whatisLine).join('\n'));
    return 0;
  }

  reg({
    name: 'man', pkg: 'man-db', summary: 'an interface to the system reference manuals', synopsis: 'man [man options] [[section] page ...] ...\n       man -k [apropos options] regexp ...\n       man -f [whatis options] page ...',
    man: 'DESCRIPTION\n       man is the system\'s manual pager. Each page argument given to man is normally the name of a program, utility or function. The manual page associated with each of these arguments is then found and displayed. A section, if provided, will direct man to look only in that section of the manual.\n\n       The manual is divided into sections: 1 executable programs and shell commands, 5 file formats, 7 miscellaneous, 8 system administration commands.\n\nOPTIONS\n       -k, --apropos\n              Equivalent to apropos. Search the short manual page descriptions for keywords.\n\n       -f, --whatis\n              Equivalent to whatis. Display a short description from the manual page, if available.\n\n       -w, --where\n              Do not actually display the manual pages, but do print the location of the files.\n\n       -a, --all\n              By default, man will exit after displaying the most suitable manual page it finds. Using this option forces man to display all the manual pages with names that match the search criteria.\n\n       q      Quit the pager.\n\nEXAMPLES\n       man ls\n              Display the manual page for the ls command.\n       man 8 ping\n              Display ping from section 8.\n       man -k "copy files"\n              Search the descriptions for a phrase.',
    section: 1,
    async run(ctx) {
      const g = ctx.getopt({ short: 'k f w a s:?VhrCMLdD', long: ['apropos', 'whatis', 'where', 'path', 'location', 'all', 'sections=', 'help', 'usage', 'version'], alias: { apropos: 'k', whatis: 'f', where: 'w', path: 'w', location: 'w', all: 'a', sections: 's', help: '?', version: 'V' } });
      if (g.err) { ctx.err('man: ' + g.err + '\n' + MAN_USAGE.split('\n')[0] + '\n'); return 1; }
      if (g.opts['?'] || g.opts.h) { ctx.out(MAN_USAGE); return 0; }
      if (g.opts.usage) { ctx.out('Usage: man [-?] [-k|-f] [-w] [-a] [-s LIST] [--help] [--usage] [--version]\n            [SECTION] PAGE...\n'); return 0; }
      if (g.opts.V) { ctx.out('man 2.13.1\n'); return 0; }
      let args = g.rest;
      if (!args.length) { ctx.err("What manual page do you want?\nFor example, try 'man man'.\n"); return 1; }
      if (g.opts.k) { ctx.name = 'apropos'; return searchPages(ctx, args, {}); }
      if (g.opts.f) return whatisRun(ctx, args);
      let section = g.opts.s != null ? g.opts.s : null;
      if (/^[1-9][a-z]*$/.test(args[0]) && args.length > 1) { section = args[0].replace(/\D.*/, ''); args = args.slice(1); }
      return showManual(ctx, args, section, { path: !!g.opts.w });
    },
    complete(info) { return commandsOf(info.ctx.machine).map((d) => d.name).filter((n) => n.indexOf(info.cur) === 0); },
  });

  function whatisRun(ctx, names) {
    let code = 0;
    for (const n of names) {
      const hits = allPages(ctx.machine).filter((d) => d.name.toLowerCase() === n.toLowerCase()).sort((a, b) => a.section - b.section);
      if (!hits.length) { ctx.err(NOTHING(n)); code = 16; } else ctx.println(hits.map(whatisLine).join('\n'));
    }
    return code;
  }

  reg({
    name: 'whatis', pkg: 'man-db', summary: 'display one-line manual page descriptions', synopsis: 'whatis [-dlv?V] [-r|-w] [-s list] [-m system[,...]] [-M path] [-L locale] [-C file] name ...',
    man: 'DESCRIPTION\n       Each manual page has a short description available within it. whatis searches the manual page names and displays the manual page descriptions of any name matched.\n\nOPTIONS\n       -s, --sections=LIST\n              Search only the given manual sections.\n\n       -V, --version\n              Show the version number.\n\nEXAMPLES\n       whatis ls\n              ls (1) - list directory contents\n       whatis nmap ssh\n              One line per name.',
    run(ctx) {
      const g = ctx.getopt({ short: 'dlvrwV?s:m:M:L:C:', long: ['debug', 'long', 'verbose', 'regex', 'wildcard', 'version', 'help', 'usage', 'sections=', 'systems=', 'manpath=', 'locale=', 'config-file='] });
      if (g.err) { ctx.err('whatis: ' + g.err + '\nUsage: whatis [OPTION...] keyword ...\n'); return 1; }
      if (g.opts.V || g.opts.version) { ctx.out('whatis 2.13.1\n'); return 0; }
      if (g.opts['?'] || g.opts.help || g.opts.usage) { ctx.out('Usage: whatis [-dlv?V] [-r|-w] [-s LIST] [-m SYSTEM[,...]] [-M PATH] [-L LOCALE]\n            [-C FILE] [--debug] [--verbose] [--regex] [--wildcard] [--long]\n            [--sections=LIST] [--systems=SYSTEM[,...]] [--manpath=PATH]\n            [--locale=LOCALE] [--config-file=FILE] [--help] [--usage] [--version]\n            KEYWORD...\n'); return 0; }
      if (!g.rest.length) { ctx.err('whatis what?\n'); return 1; }
      return whatisRun(ctx, g.rest);
    },
  });

  reg({
    name: 'apropos', pkg: 'man-db', summary: 'search the manual page names and descriptions', synopsis: 'apropos [-dalv?V] [-e|-w|-r] [-s list] [-m system[,...]] [-M path] [-L locale] [-C file] keyword ...',
    man: 'DESCRIPTION\n       Each manual page has a short description available within it. apropos searches the descriptions for instances of keyword. keyword is usually a regular expression, as if (-r) was used, or may contain wildcards (-w), or match the exact keyword (-e).\n\nOPTIONS\n       -e, --exact\n              Each keyword will be exactly matched against the page names.\n\n       -a, --and\n              Only display items that match all the supplied keywords.\n\n       -s, --sections=LIST\n              Search only the given manual sections.\n\nEXAMPLES\n       apropos password\n              Pages that mention passwords.\n       apropos -a dns lookup\n              Pages whose description matches both words.',
    run(ctx) {
      const g = ctx.getopt({ short: 'dalvrweV?s:m:M:L:C:', long: ['debug', 'and', 'long', 'verbose', 'regex', 'wildcard', 'exact', 'version', 'help', 'usage', 'sections=', 'systems=', 'manpath=', 'locale=', 'config-file='] });
      if (g.err) { ctx.err('apropos: ' + g.err + '\nUsage: apropos [OPTION...] KEYWORD...\n'); return 1; }
      if (g.opts.V || g.opts.version) { ctx.out('apropos 2.13.1\n'); return 0; }
      if (g.opts['?'] || g.opts.help || g.opts.usage) { ctx.out('Usage: apropos [-dalv?V] [-e|-w|-r] [-s LIST] [-m SYSTEM[,...]] [-M PATH] [-L LOCALE]\n               [-C FILE] [--debug] [--verbose] [--and] [--long] [--exact]\n               [--wildcard] [--regex] [--sections=LIST] [--systems=SYSTEM[,...]]\n               [--manpath=PATH] [--locale=LOCALE] [--config-file=FILE] [--help]\n               [--usage] [--version]\n               KEYWORD...\n'); return 0; }
      if (!g.rest.length) { ctx.err('apropos what?\n'); return 1; }
      return searchPages(ctx, g.rest, { exact: !!g.opts.e, and: !!g.opts.a });
    },
  });

  reg({
    name: 'whereis', pkg: 'util-linux', summary: 'locate the binary, source, and manual page files for a command', synopsis: 'whereis [options] [-BMS directory... -f] name...',
    man: 'DESCRIPTION\n       whereis locates the binary, source and manual page files for the specified command names. The supplied names are first stripped of leading pathname components. Only the files whose names are exactly the same as the stripped names are reported.\n\nOPTIONS\n       -b     Search for binaries only.\n\n       -m     Search for manuals only.\n\n       -s     Search for sources only.\n\n       -l     Output the list of effective lookup paths.\n\nEXAMPLES\n       whereis nmap\n              nmap: /usr/bin/nmap /usr/share/man/man1/nmap.1.gz\n       whereis -b ssh\n              Only the executable.',
    run(ctx) {
      const g = ctx.getopt({ short: 'bmsulf:B:M:S:h', long: ['help', 'version'] });
      if (g.err) { ctx.err('whereis: ' + g.err + "\nTry 'whereis --help' for more information.\n"); return 1; }
      if (g.opts.h || g.opts.help) { ctx.out('\nUsage:\n whereis [options] [-BMS <dir>... -f] <name>\n\nLocate the binary, source, and manual-page files for a command.\n\nOptions:\n -b         search only for binaries\n -B <dirs>  define binaries lookup path\n -m         search only for manuals and infos\n -M <dirs>  define man and info lookup path\n -s         search only for sources\n -S <dirs>  define sources lookup path\n -f         terminate <dirs> argument list\n -u         search for unusual entries\n -l         output effective lookup paths\n\n -h, --help     display this help\n -V, --version  display version\n\nFor more details see whereis(1).\n'); return 0; }
      if (g.opts.version) { ctx.out('whereis from util-linux 2.41\n'); return 0; }
      if (g.opts.l) { ctx.println('bin: /usr/bin\nbin: /usr/sbin\nbin: /usr/lib\nbin: /usr/lib64\nbin: /usr/local/bin\nbin: /usr/local/sbin\nman: /usr/share/man\nman: /usr/local/share/man\nsrc: /usr/src'); return 0; }
      if (!g.rest.length) { ctx.err('whereis: no names specified\n'); return 1; }
      const only = g.opts.b || g.opts.m || g.opts.s;
      for (const arg of g.rest) {
        const name = K.VFS.basename(arg); const found = [];
        const def = commandsOf(ctx.machine).find((d) => d.name === name);
        if ((!only || g.opts.b) && def && ctx.fs.exists(def.path)) found.push(def.path);
        if ((!only || g.opts.m) && def) found.push('/usr/share/man/man' + def.section + '/' + def.name + '.' + def.section + '.gz');
        ctx.println(name + ':' + (found.length ? ' ' + found.join(' ') : ''));
      }
      return 0;
    },
  });

  reg({
    name: 'info', pkg: 'info', summary: 'read Info documents', synopsis: 'info [OPTION]... [MENU-ITEM...]',
    man: 'DESCRIPTION\n       Read documentation in Info format. When no Info document exists for a program, info shows its manual page instead.\n\nOPTIONS\n       -f, --file=MANUAL\n              Specify Info file to visit.\n\n       --version\n              Display version information and exit.\n\n       q      Quit the viewer.\n\nEXAMPLES\n       info ls\n              The coreutils manual entry for ls.',
    async run(ctx) {
      const g = ctx.getopt({ short: 'f:o:O?hwv', long: ['file=', 'output=', 'help', 'version', 'where', 'all', 'apropos='] });
      if (g.err) { ctx.err('info: ' + g.err + "\nTry 'info --help' for more information.\n"); return 1; }
      if (g.opts.version) { ctx.out('info (GNU texinfo) 7.2\n'); return 0; }
      if (g.opts.help || g.opts['?']) { ctx.out('Usage: info [OPTION]... [MANUAL] [MENU-ITEM-OR-INDEX-ENTRY]...\n\nRead documentation in Info format.\n\nOptions:\n  -f, --file=MANUAL            specify Info manual to visit\n  -o, --output=FILENAME        output selected nodes to FILENAME\n  -w, --where                  print physical location of Info file\n      --help                   display this help and exit\n      --version                display version information and exit\n'); return 0; }
      if (!g.rest.length) { ctx.println('File: dir,  Node: Top\tThis is the top of the INFO tree\n\n  This is the Info main menu.\n\n* Menu:\n\nBasics\n* Coreutils: (coreutils).       Core GNU utilities.\n* Man pages: (man).             Manual pages, opened through man.'); return 0; }
      const name = g.rest[0];
      if (!findPage(ctx, name, null)) { ctx.err("info: No menu item '" + name + "' in node '(dir)Top'.\n"); return 1; }
      return showManual(ctx, [name], null, {});
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
