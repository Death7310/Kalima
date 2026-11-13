/* Kalima — machines (simulated hosts you can have a shell on), the command
 * registry, the tool atlas and the base filesystem image.
 */
;(function (root) {
  'use strict';
  const K = root.K;
  const VFS = K.VFS;

  /* --------------------------------------------------------- command registry
   * K.cmd.register({
   *   name: 'ping',                 // required, the executable name
   *   aliases: ['ping4'],           // optional extra names (installed as symlink-like stubs)
   *   path: '/usr/bin/ping',        // default '/usr/bin/<name>'
   *   pkg: 'iputils-ping',          // Debian/Kali package that ships it
   *   section: 8,                   // man section
   *   summary: 'send ICMP ECHO_REQUEST to network hosts',   // one line, used by man/whatis/apropos
   *   synopsis: 'ping [-c count] [-i interval] destination',
   *   man: '...long text...' | () => string,                // optional DESCRIPTION/OPTIONS body
   *   only: 'kali',                 // optional: only installed on the Kali box, not on lab servers
   *   run: async (ctx) => exitCode, // required
   *   complete: (info) => [...],    // optional tab completion: info = {words, index, cur, ctx}
   * })
   */
  K.cmd = {
    _c: new Map(),
    register(def) {
      if (!def || !def.name || typeof def.run !== 'function') throw new Error('K.cmd.register: name and run() are required');
      def.path = def.path || '/usr/bin/' + def.name;
      def.section = def.section || 1;
      this._c.set(def.name, def);
      for (const a of def.aliases || []) this._c.set(a, Object.assign({}, def, { name: a, aliasOf: def.name, path: VFS.dirname(def.path) + '/' + a }));
      return def;
    },
    get(name) { return this._c.get(name); },
    has(name) { return this._c.has(name); },
    list() { return Array.from(this._c.values()); },
    names() { return Array.from(this._c.keys()).sort(); },
  };

  /* --------------------------------------------------------------- tool atlas
   * Catalogue of Kali tools, including ones that are described but not simulated.
   * K.atlas.register({ name, pkg, category, summary, simulated: true|false, url? })
   */
  K.atlas = {
    _t: new Map(),
    categories: [],
    register(t) { this._t.set(t.name, t); return t; },
    get(name) { return this._t.get(name); },
    list() { return Array.from(this._t.values()); },
  };

  /* --------------------------------------------------------------- fs seeding
   * Packs add files to freshly built machines:
   *   K.fsSeeds.push((machine) => { if (machine.profile === 'kali') machine.vfs.seed('/usr/share/x', '...'); })
   */
  K.fsSeeds = [];

  const BASE_USERS = [
    { name: 'root', uid: 0, gid: 0, gecos: 'root', home: '/root', shell: '/usr/bin/zsh' },
    { name: 'daemon', uid: 1, gid: 1, gecos: 'daemon', home: '/usr/sbin', shell: '/usr/sbin/nologin' },
    { name: 'bin', uid: 2, gid: 2, gecos: 'bin', home: '/bin', shell: '/usr/sbin/nologin' },
    { name: 'sys', uid: 3, gid: 3, gecos: 'sys', home: '/dev', shell: '/usr/sbin/nologin' },
    { name: 'sync', uid: 4, gid: 65534, gecos: 'sync', home: '/bin', shell: '/bin/sync' },
    { name: 'games', uid: 5, gid: 60, gecos: 'games', home: '/usr/games', shell: '/usr/sbin/nologin' },
    { name: 'man', uid: 6, gid: 12, gecos: 'man', home: '/var/cache/man', shell: '/usr/sbin/nologin' },
    { name: 'lp', uid: 7, gid: 7, gecos: 'lp', home: '/var/spool/lpd', shell: '/usr/sbin/nologin' },
    { name: 'mail', uid: 8, gid: 8, gecos: 'mail', home: '/var/mail', shell: '/usr/sbin/nologin' },
    { name: 'www-data', uid: 33, gid: 33, gecos: 'www-data', home: '/var/www', shell: '/usr/sbin/nologin' },
    { name: 'backup', uid: 34, gid: 34, gecos: 'backup', home: '/var/backups', shell: '/usr/sbin/nologin' },
    { name: 'nobody', uid: 65534, gid: 65534, gecos: 'nobody', home: '/nonexistent', shell: '/usr/sbin/nologin' },
    { name: '_apt', uid: 42, gid: 65534, gecos: '', home: '/nonexistent', shell: '/usr/sbin/nologin' },
    { name: 'systemd-network', uid: 998, gid: 998, gecos: 'systemd Network Management', home: '/', shell: '/usr/sbin/nologin' },
    { name: 'messagebus', uid: 100, gid: 101, gecos: '', home: '/nonexistent', shell: '/usr/sbin/nologin' },
    { name: 'sshd', uid: 101, gid: 65534, gecos: 'sshd user', home: '/run/sshd', shell: '/usr/sbin/nologin' },
  ];
  const BASE_GROUPS = [
    { name: 'root', gid: 0, members: [] }, { name: 'daemon', gid: 1, members: [] }, { name: 'bin', gid: 2, members: [] },
    { name: 'sys', gid: 3, members: [] }, { name: 'adm', gid: 4, members: [] }, { name: 'tty', gid: 5, members: [] },
    { name: 'disk', gid: 6, members: [] }, { name: 'lp', gid: 7, members: [] }, { name: 'mail', gid: 8, members: [] },
    { name: 'man', gid: 12, members: [] }, { name: 'dialout', gid: 20, members: [] }, { name: 'cdrom', gid: 24, members: [] },
    { name: 'floppy', gid: 25, members: [] }, { name: 'sudo', gid: 27, members: [] }, { name: 'audio', gid: 29, members: [] },
    { name: 'dip', gid: 30, members: [] }, { name: 'www-data', gid: 33, members: [] }, { name: 'backup', gid: 34, members: [] },
    { name: 'shadow', gid: 42, members: [] }, { name: 'video', gid: 44, members: [] }, { name: 'plugdev', gid: 46, members: [] },
    { name: 'staff', gid: 50, members: [] }, { name: 'games', gid: 60, members: [] }, { name: 'users', gid: 100, members: [] },
    { name: 'messagebus', gid: 101, members: [] }, { name: 'netdev', gid: 106, members: [] },
    { name: 'wireshark', gid: 117, members: [] }, { name: 'kaboxer', gid: 120, members: [] },
    { name: 'systemd-network', gid: 998, members: [] }, { name: 'nogroup', gid: 65534, members: [] },
  ];

  class Machine {
    /**
     * new K.Machine({
     *   hostname, domain, profile: 'kali' | 'server',
     *   users: [{name, uid, gid, gecos, home, shell, password, groups:[names]}],   // in addition to system users
     *   ifaces: [{name, ip, bits, mac, kind:'ether'|'loopback', state:'UP'}],
     *   routes: [{dst:'default'|cidr, via, dev, src}],
     *   dns: ['10.10.10.53'], hostId (id of the matching host in the network world),
     *   os: {pretty, id, kernel, arch}
     * })
     */
    constructor(o) {
      o = o || {};
      this.hostname = o.hostname || 'kali';
      this.domain = o.domain || '';
      this.profile = o.profile || 'kali';
      this.hostId = o.hostId || this.hostname;
      this.os = Object.assign({}, K.distro, o.os || {});
      this.users = K.util.deepClone(BASE_USERS);
      this.groups = K.util.deepClone(BASE_GROUPS);
      this.passwords = { root: o.rootPassword == null ? null : o.rootPassword }; // null = locked
      for (const u of o.users || []) this.addUser(u);
      this.ifaces = o.ifaces || [];
      if (!this.ifaces.some((i) => i.name === 'lo')) {
        this.ifaces.unshift({ name: 'lo', ip: '127.0.0.1', bits: 8, mac: '00:00:00:00:00:00', kind: 'loopback', state: 'UNKNOWN', mtu: 65536 });
      }
      this.routes = o.routes || [];
      this.dns = o.dns || [];
      this.search = o.search || (this.domain ? [this.domain] : []);
      this.procs = [];
      this.units = [];
      this.packages = new Map(); // name -> {version, arch, desc, status}
      this.listeners = [];       // local listening sockets [{proto, addr, port, pid, prog}]
      this.env = {};
      this._pid = 900 + (K.util.hash32(this.hostname) % 400);
      this.sudoStamp = {};       // user -> ms of last successful sudo auth
      this.vfs = new VFS();
      this.vfs.machine = this;
      this.state = {};           // free-form per-machine state for packs
      K.buildBaseFs(this);
      for (const seed of K.fsSeeds) { try { seed(this); } catch (e) { if (K.debug) console.error('fsSeed failed', e); } }
      this.installCommands();
    }

    addUser(u) {
      const user = {
        name: u.name, uid: u.uid, gid: u.gid == null ? u.uid : u.gid, gecos: u.gecos || '',
        home: u.home || '/home/' + u.name, shell: u.shell || '/bin/bash',
      };
      this.users.push(user);
      if (!this.groups.some((g) => g.gid === user.gid)) this.groups.push({ name: u.name, gid: user.gid, members: [] });
      for (const gn of u.groups || []) {
        const g = this.groups.find((x) => x.name === gn);
        if (g && g.members.indexOf(u.name) < 0) g.members.push(u.name);
      }
      if (u.password != null) this.passwords[u.name] = u.password;
      return user;
    }
    userByName(n) { return this.users.find((u) => u.name === n); }
    userByUid(uid) { return this.users.find((u) => u.uid === uid); }
    groupByName(n) { return this.groups.find((g) => g.name === n); }
    groupByGid(gid) { return this.groups.find((g) => g.gid === gid); }
    userName(uid) { const u = this.userByUid(uid); return u ? u.name : String(uid); }
    groupName(gid) { const g = this.groupByGid(gid); return g ? g.name : String(gid); }
    /** All groups (objects) a user belongs to, primary first. */
    groupsOf(name) {
      const u = this.userByName(name); if (!u) return [];
      const out = []; const p = this.groupByGid(u.gid); if (p) out.push(p);
      for (const g of this.groups) if (g.members.indexOf(name) >= 0 && out.indexOf(g) < 0) out.push(g);
      return out;
    }
    credFor(name) {
      const u = this.userByName(name);
      if (!u) return null;
      return { uid: u.uid, gid: u.gid, groups: this.groupsOf(name).map((g) => g.gid), name: u.name, home: u.home };
    }
    canSudo(name) { return name === 'root' || this.groupsOf(name).some((g) => g.name === 'sudo'); }
    checkPassword(name, pw) { const p = this.passwords[name]; return p != null && p === pw; }

    nextPid() { this._pid += 1 + (K.util.hash32('pid' + this._pid) % 3); return this._pid; }
    spawn(p) {
      const proc = Object.assign({ pid: this.nextPid(), ppid: 1, user: 'root', tty: '?', stat: 'S', start: K.clock.now(), cpu: 0, mem: 0.1, cmd: '' }, p);
      this.procs.push(proc);
      return proc;
    }
    reap(pid) { const i = this.procs.findIndex((p) => p.pid === pid); if (i >= 0) this.procs.splice(i, 1); }

    primaryIface() { return this.ifaces.find((i) => i.kind !== 'loopback' && i.ip) || null; }
    primaryIp() { const i = this.primaryIface(); return i ? i.ip : '127.0.0.1'; }
    fqdn() { return this.domain ? this.hostname + '.' + this.domain : this.hostname; }

    /** Create executable stubs in the VFS for every registered command this machine should have. */
    installCommands() {
      for (const def of K.cmd.list()) {
        if (def.only && def.only !== this.profile) continue;
        if (def.installed === false) continue;
        this.installCommand(def);
      }
    }
    installCommand(def) {
      const stub = '\x7fELF\x02\x01\x01\0kalima:' + (def.aliasOf || def.name) + '\n';
      this.vfs.seed(def.path, stub, { mode: def.mode == null ? 0o755 : def.mode });
    }
    /** Resolve an executable file path back to its command definition (or null). */
    commandAt(path) {
      let data;
      try { data = this.vfs.read(path); } catch (e) { return null; }
      const m = /^\x7fELF[\s\S]{0,8}kalima:([^\n]+)\n/.exec(data);
      if (!m) return null;
      return K.cmd.get(m[1]) || null;
    }
  }
  K.Machine = Machine;

  /* ------------------------------------------------------------ dynamic /etc */
  K.dynFiles.register('etc.passwd', (m) => m.users.map((u) =>
    [u.name, 'x', u.uid, u.gid, u.gecos, u.home, u.shell].join(':')).join('\n') + '\n');
  K.dynFiles.register('etc.group', (m) => m.groups.map((g) =>
    [g.name, 'x', g.gid, g.members.join(',')].join(':')).join('\n') + '\n');
  K.dynFiles.register('etc.shadow', (m) => m.users.map((u) => {
    const pw = m.passwords[u.name];
    // Not real hashes: an opaque, obviously simulated placeholder derived from the name.
    const field = pw == null ? (u.uid === 0 ? '!' : '*') : '$y$j9T$' + K.util.hash32('salt' + u.name).toString(36) + '$' +
      (K.util.hash32('a' + u.name + pw).toString(36) + K.util.hash32('b' + u.name + pw).toString(36) + K.util.hash32('c' + u.name + pw).toString(36)).padEnd(21, 'x') + 'SIMULATED';
    return [u.name, field, 20405, 0, 99999, 7, '', '', ''].join(':');
  }).join('\n') + '\n');
  K.dynFiles.register('etc.hostname', (m) => m.hostname + '\n');
  K.dynFiles.register('etc.resolv', (m) =>
    '# Generated by NetworkManager\n' + (m.search.length ? 'search ' + m.search.join(' ') + '\n' : '') +
    m.dns.map((d) => 'nameserver ' + d + '\n').join(''));
  K.dynFiles.register('proc.uptime', () => {
    const up = (K.clock.now() - K.getBootTime()) / 1000;
    return up.toFixed(2) + ' ' + (up * 3.87).toFixed(2) + '\n';
  });
  K.dynFiles.register('proc.version', (m) =>
    'Linux version ' + m.os.kernel + ' (devel@kali.org) (x86_64-linux-gnu-gcc-15 (Debian 15.2.0-4) 15.2.0, GNU ld (GNU Binutils for Debian) 2.45) ' + m.os.kernelBuild + '\n');
  K.dynFiles.register('proc.loadavg', (m) => '0.08 0.11 0.09 1/' + (m.procs.length + 180) + ' ' + m._pid + '\n');
  K.dynFiles.register('proc.meminfo', () => [
    'MemTotal:        4026392 kB', 'MemFree:         1493820 kB', 'MemAvailable:    2871544 kB', 'Buffers:           84312 kB',
    'Cached:          1402268 kB', 'SwapCached:            0 kB', 'Active:          1180432 kB', 'Inactive:         952116 kB',
    'SwapTotal:       1048572 kB', 'SwapFree:        1048572 kB', 'Dirty:               132 kB', 'Shmem:             41280 kB',
  ].join('\n') + '\n');
  K.dynFiles.register('proc.cpuinfo', () => [0, 1].map((i) => [
    'processor\t: ' + i, 'vendor_id\t: GenuineIntel', 'cpu family\t: 6', 'model\t\t: 158',
    'model name\t: Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz', 'stepping\t: 10', 'cpu MHz\t\t: 2592.000',
    'cache size\t: 12288 KB', 'physical id\t: 0', 'siblings\t: 2', 'core id\t\t: ' + i, 'cpu cores\t: 2',
    'flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ht syscall nx rdtscp lm constant_tsc rep_good nopl xtopology nonstop_tsc cpuid pni pclmulqdq ssse3 cx16 pcid sse4_1 sse4_2 movbe popcnt aes xsave avx rdrand hypervisor lahf_lm abm 3dnowprefetch fsgsbase bmi1 avx2 bmi2 invpcid rdseed clflushopt',
    'bogomips\t: 5184.00', 'address sizes\t: 39 bits physical, 48 bits virtual', '',
  ].join('\n')).join('\n'));
  K.dynFiles.register('proc.net.dev', (m) =>
    'Inter-|   Receive                                                |  Transmit\n' +
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n' +
    m.ifaces.map((i) => {
      const h = K.util.hash32(i.name + m.hostname);
      const rx = i.kind === 'loopback' ? 6240 : 1200000 + (h % 900000); const tx = i.kind === 'loopback' ? 6240 : 310000 + (h % 200000);
      return K.util.padStart(i.name, 6) + ': ' + rx + ' ' + Math.floor(rx / 420) + '    0    0    0     0          0         0 ' + tx + ' ' + Math.floor(tx / 190) + '    0    0    0     0       0          0';
    }).join('\n') + '\n');

  /* --------------------------------------------------------- base filesystem */
  K.buildBaseFs = function (m) {
    const fs = m.vfs;
    const old = Date.UTC(2026, 9, 26, 9, 12, 0); // image build date (2026.3 release day)
    const D = (p, o) => fs.seedDir(p, Object.assign({ mtime: old }, o));
    const F = (p, c, o) => fs.seed(p, c, Object.assign({ mtime: old }, o));

    ['/boot', '/dev', '/etc', '/home', '/media', '/mnt', '/opt', '/proc', '/run', '/srv', '/sys', '/usr', '/var',
      '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/usr/local', '/usr/local/bin', '/usr/local/sbin', '/usr/share', '/usr/share/doc',
      '/usr/share/man', '/usr/include', '/usr/src', '/usr/games', '/var/log', '/var/lib', '/var/cache', '/var/spool', '/var/mail',
      '/var/backups', '/var/www', '/var/www/html', '/var/lib/dpkg', '/var/lib/apt/lists', '/var/cache/apt/archives',
      '/etc/apt', '/etc/apt/sources.list.d', '/etc/ssh', '/etc/network', '/etc/systemd/system', '/etc/default', '/etc/cron.d',
      '/etc/cron.daily', '/etc/sudoers.d', '/etc/skel', '/run/lock', '/sys/class/net', '/proc/net', '/proc/sys/net/ipv4',
    ].forEach((p) => D(p));
    fs.seedLink('/bin', 'usr/bin'); fs.seedLink('/sbin', 'usr/sbin'); fs.seedLink('/lib', 'usr/lib'); fs.seedLink('/lib64', 'usr/lib64');
    D('/tmp', { mode: 0o1777 }); D('/var/tmp', { mode: 0o1777 }); D('/root', { mode: 0o700 });
    D('/run/sshd'); D('/var/log/apt');

    fs.seedDev('/dev/null', 'null'); fs.seedDev('/dev/zero', 'zero'); fs.seedDev('/dev/random', 'random'); fs.seedDev('/dev/urandom', 'random');
    fs.seedDev('/dev/tty', 'tty'); D('/dev/pts'); fs.seedDev('/dev/pts/0', 'tty', 0o620);

    F('/etc/passwd', { dyn: 'etc.passwd' });
    F('/etc/group', { dyn: 'etc.group' });
    F('/etc/shadow', { dyn: 'etc.shadow' }, { mode: 0o640, gid: 42 });
    F('/etc/hostname', { dyn: 'etc.hostname' });
    F('/etc/resolv.conf', { dyn: 'etc.resolv' });
    F('/etc/hosts', '127.0.0.1\tlocalhost\n127.0.1.1\t' + m.hostname + (m.domain ? '\t' + m.fqdn() : '') +
      '\n\n# The following lines are desirable for IPv6 capable hosts\n::1     localhost ip6-localhost ip6-loopback\nff02::1 ip6-allnodes\nff02::2 ip6-allrouters\n');
    F('/etc/shells', '# /etc/shells: valid login shells\n/bin/sh\n/usr/bin/sh\n/bin/bash\n/usr/bin/bash\n/bin/zsh\n/usr/bin/zsh\n');
    F('/etc/nsswitch.conf', 'passwd:         files systemd\ngroup:          files systemd\nshadow:         files systemd\n\nhosts:          files mdns4_minimal [NOTFOUND=return] dns\nnetworks:       files\n\nprotocols:      db files\nservices:       db files\n');
    F('/etc/sudoers', '#\n# This file MUST be edited with the \'visudo\' command as root.\n#\nDefaults\tenv_reset\nDefaults\tmail_badpass\nDefaults\tsecure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"\nDefaults\tuse_pty\n\n# User privilege specification\nroot\tALL=(ALL:ALL) ALL\n\n# Allow members of group sudo to execute any command\n%sudo\tALL=(ALL:ALL) ALL\n\n@includedir /etc/sudoers.d\n', { mode: 0o440 });
    F('/etc/services', [
      '# Network services, Internet style', 'tcpmux\t\t1/tcp', 'echo\t\t7/tcp', 'echo\t\t7/udp', 'discard\t\t9/tcp', 'daytime\t\t13/tcp',
      'ftp-data\t20/tcp', 'ftp\t\t21/tcp', 'ssh\t\t22/tcp', 'telnet\t\t23/tcp', 'smtp\t\t25/tcp\t\tmail', 'domain\t\t53/tcp', 'domain\t\t53/udp',
      'bootps\t\t67/udp', 'bootpc\t\t68/udp', 'tftp\t\t69/udp', 'http\t\t80/tcp\t\twww', 'kerberos\t88/tcp', 'kerberos\t88/udp', 'pop3\t\t110/tcp',
      'sunrpc\t\t111/tcp\t\tportmapper', 'ntp\t\t123/udp', 'epmap\t\t135/tcp', 'netbios-ns\t137/udp', 'netbios-dgm\t138/udp', 'netbios-ssn\t139/tcp',
      'imap2\t\t143/tcp\t\timap', 'snmp\t\t161/udp', 'ldap\t\t389/tcp', 'https\t\t443/tcp', 'microsoft-ds\t445/tcp', 'submissions\t465/tcp',
      'syslog\t\t514/udp', 'printer\t\t515/tcp', 'submission\t587/tcp', 'ipp\t\t631/tcp', 'ldaps\t\t636/tcp', 'rsync\t\t873/tcp', 'imaps\t\t993/tcp',
      'pop3s\t\t995/tcp', 'ms-sql-s\t1433/tcp', 'nfs\t\t2049/tcp', 'mysql\t\t3306/tcp', 'ms-wbt-server\t3389/tcp', 'postgresql\t5432/tcp',
      'vnc\t\t5900/tcp', 'x11\t\t6000/tcp', 'http-alt\t8080/tcp', 'jetdirect\t9100/tcp',
    ].join('\n') + '\n');
    F('/etc/protocols', 'ip\t0\tIP\nicmp\t1\tICMP\nigmp\t2\tIGMP\ntcp\t6\tTCP\nudp\t17\tUDP\nipv6\t41\tIPv6\ngre\t47\tGRE\nesp\t50\tIPSEC-ESP\nah\t51\tIPSEC-AH\nipv6-icmp 58\tIPv6-ICMP\n');
    F('/etc/timezone', 'Etc/UTC\n');
    F('/etc/fstab', '# <file system> <mount point>   <type>  <options>       <dump>  <pass>\nUUID=5d2c8a4e-1f3b-4c6d-9e7a-0b1c2d3e4f5a /               ext4    errors=remount-ro 0       1\nUUID=9a8b7c6d-5e4f-3a2b-1c0d-e9f8a7b6c5d4 none            swap    sw              0       0\n');
    F('/etc/ssh/ssh_config', 'Include /etc/ssh/ssh_config.d/*.conf\n\nHost *\n    SendEnv LANG LC_*\n    HashKnownHosts yes\n    GSSAPIAuthentication yes\n');
    F('/etc/ssh/sshd_config', 'Include /etc/ssh/sshd_config.d/*.conf\n\n#Port 22\n#AddressFamily any\n#ListenAddress 0.0.0.0\n\n#PermitRootLogin prohibit-password\n#PubkeyAuthentication yes\n#PasswordAuthentication yes\nKbdInteractiveAuthentication no\nUsePAM yes\nX11Forwarding yes\nPrintMotd no\nAcceptEnv LANG LC_*\nSubsystem\tsftp\t/usr/lib/openssh/sftp-server\n');

    F('/proc/uptime', { dyn: 'proc.uptime' }, { mode: 0o444 });
    F('/proc/version', { dyn: 'proc.version' }, { mode: 0o444 });
    F('/proc/loadavg', { dyn: 'proc.loadavg' }, { mode: 0o444 });
    F('/proc/meminfo', { dyn: 'proc.meminfo' }, { mode: 0o444 });
    F('/proc/cpuinfo', { dyn: 'proc.cpuinfo' }, { mode: 0o444 });
    F('/proc/net/dev', { dyn: 'proc.net.dev' }, { mode: 0o444 });
    F('/proc/sys/net/ipv4/ip_forward', '0\n');
    F('/proc/sys/net/ipv4/ip_default_ttl', '64\n');

    if (m.profile === 'kali') {
      F('/etc/os-release', 'PRETTY_NAME="Kali GNU/Linux Rolling"\nNAME="Kali GNU/Linux"\nVERSION_ID="' + K.distro.release + '"\nVERSION="' + K.distro.release +
        '"\nVERSION_CODENAME=kali-rolling\nID=kali\nID_LIKE=debian\nHOME_URL="https://www.kali.org/"\nSUPPORT_URL="https://forums.kali.org/"\nBUG_REPORT_URL="https://bugs.kali.org/"\nANSI_COLOR="1;31"\n');
      fs.seedLink('/usr/lib/os-release', '/etc/os-release');
      F('/etc/debian_version', 'kali-rolling\n');
      F('/etc/issue', 'Kali GNU/Linux Rolling \\n \\l\n\n');
      F('/etc/motd', '\nThe programs included with the Kali GNU/Linux system are free software;\nthe exact distribution terms for each program are described in the\nindividual files in /usr/share/doc/*/copyright.\n\nKali GNU/Linux comes with ABSOLUTELY NO WARRANTY, to the extent\npermitted by applicable law.\n');
      // Since 2026.2 fresh installs use the deb822 format in sources.list.d
      F('/etc/apt/sources.list', '# See /etc/apt/sources.list.d/kali.sources\n');
      F('/etc/apt/sources.list.d/kali.sources', '# Kali Linux repository (deb822 format)\nTypes: deb\nURIs: http://http.kali.org/kali/\nSuites: kali-rolling\nComponents: main contrib non-free non-free-firmware\nSigned-By: /usr/share/keyrings/kali-archive-keyring.gpg\n');
      D('/usr/share/keyrings'); F('/usr/share/keyrings/kali-archive-keyring.gpg', '\x99\x02\x0d\x04kali-archive-keyring (simulated binary keyring)\n');
      F('/etc/sudoers.d/kali-grant-root', '# Allow members of group kali-trusted to execute any command without a\n# password prompt\n%kali-trusted\tALL=(ALL:ALL) NOPASSWD: ALL\n', { mode: 0o440 });
    } else {
      const pretty = m.os.pretty || 'Debian GNU/Linux 13 (trixie)';
      F('/etc/os-release', 'PRETTY_NAME="' + pretty + '"\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\nVERSION="13 (trixie)"\nVERSION_CODENAME=trixie\nID=debian\nHOME_URL="https://www.debian.org/"\n');
      F('/etc/debian_version', '13.2\n');
      F('/etc/issue', 'Debian GNU/Linux 13 \\n \\l\n\n');
      F('/etc/apt/sources.list', 'deb http://deb.debian.org/debian trixie main\ndeb http://security.debian.org/debian-security trixie-security main\n');
    }

    // Home directories for login users
    for (const u of m.users) {
      if (u.uid === 0) {
        F('/root/.profile', '# ~/.profile: executed by Bourne-compatible login shells.\n\nif [ "$BASH" ]; then\n  if [ -f ~/.bashrc ]; then\n    . ~/.bashrc\n  fi\nfi\n\nmesg n 2> /dev/null || true\n');
        F('/root/.zsh_history', '', { mode: 0o600 });
        continue;
      }
      if (u.uid < 1000 || u.uid >= 60000) continue;
      const h = u.home;
      D(h, { mode: 0o700 });
      F(h + '/.profile', '# ~/.profile: executed by the command interpreter for login shells.\n\n# set PATH so it includes user\'s private bin if it exists\nif [ -d "$HOME/bin" ] ; then\n    PATH="$HOME/bin:$PATH"\nfi\n');
      F(h + '/.bashrc', '# ~/.bashrc: executed by bash(1) for non-login shells.\n\n# If not running interactively, don\'t do anything\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\n\nHISTCONTROL=ignoreboth\nHISTSIZE=1000\nHISTFILESIZE=2000\n\nalias ll=\'ls -l\'\nalias la=\'ls -A\'\nalias l=\'ls -CF\'\n');
      F(h + '/.bash_logout', '# ~/.bash_logout: executed by bash(1) when login shell exits.\n');
      if (m.profile === 'kali') {
        F(h + '/.zshrc', '# ~/.zshrc file for zsh interactive shells.\n# see /usr/share/doc/zsh/examples/zshrc for examples\n\nsetopt autocd              # change directory just by typing its name\nsetopt interactivecomments # allow comments in interactive mode\nsetopt magicequalsubst     # enable filename expansion for arguments of the form \'anything=expression\'\nsetopt nonomatch           # hide error message if there is no match for the pattern\nsetopt notify              # report the status of background jobs immediately\nsetopt numericglobsort     # sort filenames numerically when it makes sense\nsetopt promptsubst         # enable command substitution in prompt\n\nHISTFILE=~/.zsh_history\nHISTSIZE=1000\nSAVEHIST=2000\n\n# some more ls aliases\nalias ll=\'ls -l\'\nalias la=\'ls -A\'\nalias l=\'ls -CF\'\n\nalias ls=\'ls --color=auto\'\nalias grep=\'grep --color=auto\'\nalias diff=\'diff --color=auto\'\nalias ip=\'ip --color=auto\'\n');
        F(h + '/.zsh_history', '', { mode: 0o600 });
        for (const d of ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Public', 'Templates', 'Videos']) D(h + '/' + d);
        D(h + '/.config'); D(h + '/.cache'); D(h + '/.local/share'); D(h + '/.ssh', { mode: 0o700 });
      }
      fs.seedOwn(h, u.uid, u.gid);
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
