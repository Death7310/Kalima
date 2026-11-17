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
 *   and top: vsz and rss (KiB), time (CPU seconds), unit (owning unit name).
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
    add({ pid: 1, ppid: 0, cmd: machine.profile === 'kali' ? '/sbin/init splash' : '/sbin/init', stat: 'Ss', rss: 14320, vsz: 23956, mem: memPercent(14320), time: 2 });
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
      for (const [cmd, rss, vsz, stat, parent, key] of KALI_SESSION) {
        gap(cmd);
        const p = add({ ppid: machine.state.pids[parent] || 1, user: 'kali', cmd, stat, rss, vsz, mem: memPercent(rss), start: login + (pid % 7) * SEC, time: Math.floor(rss / 30000) });
        if (key) machine.state.pids[key] = p.pid;
      }
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
})(typeof globalThis !== 'undefined' ? globalThis : this);
