/* Kalima — package management, user management and assorted administration.
 *
 * apt apt-get apt-cache dpkg dpkg-query useradd usermod userdel groupadd
 * groupdel passwd chsh adduser getent lscpu lsmod lsusb lspci vmstat
 * timedatectl hostnamectl locale lastlog logname nice nohup crontab reboot
 * shutdown poweroff halt neofetch fastfetch kali-tweaks kali-undercover
 *
 * The package database lives in machine.packages (name -> {version, arch,
 * desc, status, auto}). Installing a package marks it installed and creates
 * the executable stubs of every K.cmd definition that names it.
 */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;

  /* ============================================================ package data */

  const APT_VERSION = '3.1.9';
  const MIRROR = 'http://http.kali.org/kali';
  const ARCH = 'amd64';

  // name|version|description — what a fresh Kali 2026.3 image ships besides the simulated tools
  const KALI_BASE = `
base-files|1:2026.3.0|Kali Linux base system miscellaneous files
base-passwd|3.6.7|Debian base system master password and group files
bash|5.3-1|GNU Bourne Again SHell
coreutils|9.7-3|GNU core utilities
dash|0.5.12-12|POSIX-compliant shell
dpkg|1.22.21|Debian package management system
apt|${APT_VERSION}|commandline package manager
apt-utils|${APT_VERSION}|package management related utility programs
adduser|3.152|add and remove users and groups
passwd|1:4.18.0-2|change and administer password and group data
login|1:4.18.0-2|system login tools
sudo|1.9.17p2-1|Provide limited super user privileges to specific users
util-linux|2.41.2-3|miscellaneous system utilities
mount|2.41.2-3|tools for mounting and manipulating filesystems
procps|2:4.0.4-9|/proc file system utilities
net-tools|2.10-1.3|NET-3 networking toolkit
iproute2|6.15.0-1|networking and traffic control tools
iputils-ping|3:20250605-1|Tools to test the reachability of network hosts
isc-dhcp-client|4.4.3-P1-8|DHCP client for automatically obtaining an IP address
network-manager|1.54.0-2|network management framework (daemon and userspace tools)
openssh-client|1:10.0p1-7|secure shell (SSH) client, for secure access to remote machines
openssh-server|1:10.0p1-7|secure shell (SSH) server, for secure access from remote machines
openssh-sftp-server|1:10.0p1-7|secure shell (SSH) sftp server module, for SFTP access from remote machines
ca-certificates|20250419|Common CA certificates
curl|8.17.0-1|command line tool for transferring data with URL syntax
wget|1.25.0-2|retrieves files from the web
vim|2:9.1.1230-2|Vi IMproved - enhanced vi editor
vim-common|2:9.1.1230-2|Vi IMproved - Common files
vim-tiny|2:9.1.1230-2|Vi IMproved - enhanced vi editor - compact version
nano|8.5-1|small, friendly text editor inspired by Pico
less|668-1|pager program similar to more
man-db|2.13.1-1|tools for reading manual pages
manpages|6.14-1|Manual pages about using a GNU/Linux system
git|1:2.51.0-1|fast, scalable, distributed revision control system
python3|3.13.7-1|interactive high-level object-oriented language (default python3 version)
python3-minimal|3.13.7-1|minimal subset of the Python language (default python3 version)
perl|5.40.1-6|Larry Wall's Practical Extraction and Report Language
gcc|4:15.2.0-3|GNU C compiler
make|4.4.1-3|utility for directing compilation
libc6|2.41-12|GNU C Library: Shared libraries
libc-bin|2.41-12|GNU C Library: Binaries
libssl3t64|3.5.4-1|Secure Sockets Layer toolkit - shared libraries
openssl|3.5.4-1|Secure Sockets Layer toolkit - cryptographic utility
libcurl4t64|8.17.0-1|easy-to-use client-side URL transfer library (OpenSSL flavour)
tzdata|2025c-4|time zone and daylight-saving time data
locales|2.41-12|GNU C Library: National Language (locale) data [support]
systemd|257.9-1|system and service manager
systemd-sysv|257.9-1|system and service manager - SysV compatibility symlinks
udev|257.9-1|/dev/ and hotplug management daemon
dbus|1.16.2-2|simple interprocess messaging system (system message bus)
cron|3.0pl1-197|process scheduling daemon
rsyslog|8.2504.0-1|reliable system and kernel logging daemon
zsh|5.9-8|shell with lots of features
zsh-common|5.9-8|architecture independent files for Zsh
kali-defaults|2026.3.0|Kali Linux default configuration files
kali-menu|2026.3.1|Kali Linux menu
kali-themes|2026.3.0|Kali Linux themes
kali-linux-core|2026.3.0|Kali Linux base system
kali-archive-keyring|2025.1|GnuPG archive keys of the Kali Linux archive
kali-tweaks|2.0.12|Kali Linux Tweaks
kali-undercover|2026.1.0|Kali Linux undercover mode
fastfetch|2.48.1-1|Fast neofetch-like system information tool
neofetch|7.1.0-4|Shows Linux System Information with Distribution Logo
linux-image-amd64|6.18.9-1kali1|Linux for 64-bit PCs (meta-package)
linux-image-6.18.9-amd64|6.18.9-1kali1|Linux 6.18 for 64-bit PCs
firefox-esr|140.4.0esr-1|Mozilla Firefox web browser - Extended Support Release (ESR)
xfce4|4.20.0|Meta-package for the Xfce Lightweight Desktop Environment
`.trim().split('\n');

  const SERVER_BASE = `
base-files|13.8+deb13u1|Debian base system miscellaneous files
base-passwd|3.6.7|Debian base system master password and group files
bash|5.2.37-2|GNU Bourne Again SHell
coreutils|9.7-3|GNU core utilities
dash|0.5.12-12|POSIX-compliant shell
dpkg|1.22.21|Debian package management system
apt|3.0.3|commandline package manager
adduser|3.152|add and remove users and groups
passwd|1:4.17.4-2|change and administer password and group data
login|1:4.16.0-2+really2.41.1-1|system login tools
sudo|1.9.16p2-3|Provide limited super user privileges to specific users
util-linux|2.41.1-4|miscellaneous system utilities
procps|2:4.0.4-8|/proc file system utilities
iproute2|6.15.0-1|networking and traffic control tools
openssh-server|1:10.0p1-7|secure shell (SSH) server, for secure access from remote machines
openssh-client|1:10.0p1-7|secure shell (SSH) client, for secure access to remote machines
ca-certificates|20250419|Common CA certificates
curl|8.14.1-2|command line tool for transferring data with URL syntax
nano|8.4-1|small, friendly text editor inspired by Pico
vim-tiny|2:9.1.1230-2|Vi IMproved - enhanced vi editor - compact version
less|668-1|pager program similar to more
python3|3.13.5-1|interactive high-level object-oriented language (default python3 version)
perl|5.40.1-6|Larry Wall's Practical Extraction and Report Language
libc6|2.41-12|GNU C Library: Shared libraries
libssl3t64|3.5.1-1|Secure Sockets Layer toolkit - shared libraries
openssl|3.5.1-1|Secure Sockets Layer toolkit - cryptographic utility
tzdata|2025b-5|time zone and daylight-saving time data
systemd|257.7-1|system and service manager
systemd-sysv|257.7-1|system and service manager - SysV compatibility symlinks
cron|3.0pl1-197|process scheduling daemon
rsyslog|8.2504.0-1|reliable system and kernel logging daemon
`.trim().split('\n');

  // Not installed by default: name|version|description|dependencies|section
  const AVAILABLE = `
tree|2.2.1-1|displays an indented directory tree, in color||utils
htop|3.4.1-5|interactive processes viewer|libnl-genl-3-200|utils
tmux|3.5a-3|terminal multiplexer||admin
ncdu|1.22-1|ncurses disk usage viewer||utils
jq|1.8.0-1|lightweight and flexible command-line JSON processor||utils
sl|5.02-1+b1|Correct you if you type 'sl' by mistake||games
cowsay|3.03+dfsg2-8|configurable talking characters in ASCII art||games
figlet|2.2.5-3+b2|Make large character ASCII banners out of ordinary text||text
nginx|1.28.0-6|small, powerful, scalable web/proxy server|nginx-common|httpd
nginx-common|1.28.0-6|small, powerful, scalable web/proxy server - common files||httpd
apache2|2.4.65-2|Apache HTTP Server|apache2-bin,apache2-data,apache2-utils|httpd
apache2-bin|2.4.65-2|Apache HTTP Server (modules and other binary files)||httpd
apache2-data|2.4.65-2|Apache HTTP Server (common files)||httpd
apache2-utils|2.4.65-2|Apache HTTP Server (utility programs for web servers)||httpd
libnl-genl-3-200|3.11.0-2|library for dealing with netlink sockets - generic netlink||libs
docker.io|26.1.5+dfsg1-9|Linux container runtime|containerd,runc|admin
containerd|1.7.24~ds1-6|open and reliable container runtime||admin
runc|1.1.15+ds1-2|Open Container Initiative runtime||admin
build-essential|12.12|Informational list of build-essential packages|gcc,make|devel
python3-pip|25.1.1+dfsg-1|Python package installer||python
golang-go|2:1.24~2|Go programming language compiler||golang
nodejs|20.19.2+dfsg-1|evented I/O for V8 javascript - runtime executable||javascript
php|2:8.4+96|server-side, HTML-embedded scripting language (default)||php
libreoffice|4:25.8.1-1|office productivity suite (metapackage)||editors
vlc|3.0.21-4|multimedia player and streamer||video
gimp|3.0.4-3|GNU Image Manipulation Program||graphics
kali-linux-default|2026.3.0|Kali Linux default tools|kali-tools-top10|misc
kali-linux-headless|2026.3.0|Kali Linux headless (no GUI) tools|kali-tools-top10|misc
kali-linux-large|2026.3.0|Kali Linux large tools selection|kali-linux-default|misc
kali-tools-top10|2026.3.0|Kali Linux top 10 tools|nmap,hydra,john,sqlmap,aircrack-ng|misc
kali-tools-web|2026.3.0|Kali Linux web application assessment tools|sqlmap,nikto|misc
kali-tools-wireless|2026.3.0|Kali Linux wireless tools|aircrack-ng|misc
`.trim().split('\n');

  // Packages that apt refuses to remove without the confirmation phrase
  const ESSENTIAL = new Set(['base-files', 'base-passwd', 'bash', 'coreutils', 'dash', 'dpkg', 'apt', 'login', 'passwd', 'util-linux', 'libc6', 'libc-bin', 'systemd', 'sudo']);
  // Installed packages that have a newer version in the mirror (for upgrade and apt list --upgradable)
  const UPGRADABLE = ['curl', 'libcurl4t64', 'openssl', 'libssl3t64', 'tzdata', 'python3', 'firefox-esr'];

  const hash = (s) => U.hash32(String(s));
  const parseRow = (row) => row.split('|');
  const bumpVersion = (v) => v.replace(/(\d+)([^\d]*)$/, (m, n, rest) => (parseInt(n, 10) + 1) + rest);
  const generatedVersion = (name) => { const h = hash('ver' + name); return (1 + h % 4) + '.' + (h >> 3) % 20 + '.' + (h >> 8) % 9 + '-0kali' + (1 + (h >> 12) % 3); };

  function adminState(machine) {
    const st = machine.state;
    if (!st.admin) st.admin = { upgradable: {}, listsAt: 0, lockedPw: {} };
    return st.admin;
  }

  /** Commands (including alias stubs) a package ships on this machine. */
  function commandsOf(machine, pkg) {
    return K.cmd.list().filter((d) => d.pkg === pkg && (!d.only || d.only === machine.profile));
  }

  /** The record every package-related command works from: repository data merged with installed state. */
  function buildDb(machine) {
    const recs = new Map();
    const add = (name, version, desc, deps, section) => {
      if (recs.has(name) && !desc) return;
      const h = hash(name);
      recs.set(name, { name, version, arch: /^(kali-|base-|tzdata|ca-cert|manpages|build-ess)/.test(name) ? 'all' : ARCH, desc, deps: deps ? deps.split(',') : [], section: section || 'misc', size: 18000 + (h % 900) * 1000, instSize: 45000 + (h % 2400) * 1000 });
    };
    for (const row of AVAILABLE) { const [n, v, d, deps, sec] = parseRow(row); add(n, v, d, deps, sec); }
    for (const t of K.atlas.list()) { const n = t.pkg || t.name; if (!recs.has(n)) add(n, generatedVersion(n), t.summary || t.name, '', 'utils'); }
    for (const def of K.cmd.list()) if (def.pkg && !recs.has(def.pkg) && (!def.only || def.only === machine.profile)) add(def.pkg, generatedVersion(def.pkg), def.summary || def.pkg, '', 'utils');
    const adm = adminState(machine);
    for (const [name, p] of machine.packages) {
      const rec = recs.get(name) || (add(name, p.version, p.desc, '', 'utils'), recs.get(name));
      rec.inst = p;
      rec.desc = p.desc || rec.desc;
      rec.current = p.version;
      rec.version = adm.upgradable[name] || p.version;
    }
    return recs;
  }
  const isInstalled = (rec) => !!rec && !!rec.inst && rec.inst.status === 'installed';
  const isUpgradable = (rec) => isInstalled(rec) && rec.version !== rec.current;

  K.fsSeeds.push((machine) => {
    const rows = (machine.profile === 'kali' ? KALI_BASE : SERVER_BASE).map(parseRow);
    for (const [name, version, desc] of rows) machine.packages.set(name, { version, arch: /^(kali-|base-|tzdata|ca-cert|manpages)/.test(name) ? 'all' : ARCH, desc, status: 'installed', auto: false });
    for (const def of K.cmd.list()) {
      if (!def.pkg || (def.only && def.only !== machine.profile) || def.installed === false || machine.packages.has(def.pkg)) continue;
      machine.packages.set(def.pkg, { version: generatedVersion(def.pkg), arch: ARCH, desc: def.summary || def.pkg, status: 'installed', auto: false });
    }
    const adm = adminState(machine);
    for (const name of UPGRADABLE) { const p = machine.packages.get(name); if (p) adm.upgradable[name] = bumpVersion(p.version); }
    machine.vfs.seed('/var/log/dpkg.log', '', { mode: 0o644 });
    machine.vfs.seed('/var/log/apt/history.log', '', { mode: 0o644 });
    machine.vfs.seed('/var/lib/dpkg/status', { dyn: 'dpkg.status' }, { mode: 0o644 });
  });

  K.dynFiles.register('dpkg.status', (m) => statusFile(m));
  function statusFile(machine) {
    const db = buildDb(machine);
    return Array.from(machine.packages.keys()).sort().map((name) => {
      const rec = db.get(name); const p = machine.packages.get(name);
      return ['Package: ' + name, 'Status: ' + (p.status === 'installed' ? 'install ok installed' : 'deinstall ok config-files'), 'Priority: optional', 'Section: ' + rec.section,
        'Installed-Size: ' + Math.round(rec.instSize / 1024), 'Maintainer: Kali Developers <devel@kali.org>', 'Architecture: ' + p.arch, 'Version: ' + p.version,
        'Description: ' + p.desc].join('\n');
    }).join('\n\n') + '\n';
  }

  /* ============================================================ shared helpers */

  const sleep = (ctx, ms) => ctx.sleep(ms);
  const groupDigits = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  /** apt's SizeToStr: SI units, one decimal below 100, thousands separators. */
  function sizeStr(bytes) {
    const units = ['B', 'kB', 'MB', 'GB', 'TB'];
    let v = bytes; let i = 0;
    while (v >= 10000 && i < units.length - 1) { v /= 1000; i++; }
    return (v < 100 && i !== 0 ? v.toFixed(1) : groupDigits(Math.round(v))) + ' ' + units[i];
  }

  /** Wrap names two-space separated at the terminal width, indented two spaces. */
  function wrapNames(names, width) {
    const lines = []; let cur = '  ';
    for (const n of names) {
      if (cur.length > 2 && cur.length + 2 + n.length > width) { lines.push(cur); cur = '  '; }
      cur += (cur.length > 2 ? '  ' : '') + n;
    }
    if (cur.length > 2) lines.push(cur);
    return lines.join('\n');
  }

  function log(machine, entry) {
    if (typeof K.syslog !== 'function') return;
    try { K.syslog(machine, Object.assign({ facility: 'user', severity: 'info', ts: K.clock.now() }, entry)); } catch (e) { /* logging must never break a command */ }
  }
  function appendFile(machine, path, text) {
    try { machine.vfs.write(path, text, { append: true }); } catch (e) { /* log directory removed by the learner */ }
  }

  const needRootGate = (ctx, lines) => {
    if (ctx.isRoot) return false;
    ctx.err(lines.map((l) => 'Error: ' + l + '\n').join(''));
    return true;
  };

  /** Describe why the mirror cannot be reached right now, or null when it can. */
  function mirrorFailure(ctx) {
    try { K.net.http(ctx.machine, { method: 'GET', url: MIRROR + '/dists/kali-rolling/InRelease' }); return null; }
    catch (e) {
      if (!(e instanceof K.NetError)) throw e;
      const r = K.net.resolve(ctx.machine, 'http.kali.org'); const ip = r ? r.ip : '192.99.200.113';
      if (e.code === 'ENOTFOUND') return "Temporary failure resolving 'http.kali.org'";
      if (e.code === 'ECONNREFUSED') return 'Could not connect to http.kali.org:80 (' + ip + '). - connect (111: Connection refused)';
      if (e.code === 'ENETUNREACH') return 'Could not connect to http.kali.org:80 (' + ip + '). - connect (101: Network is unreachable)';
      if (e.code === 'EHOSTUNREACH') return 'Could not connect to http.kali.org:80 (' + ip + '). - connect (113: No route to host)';
      return 'Could not connect to http.kali.org:80 (' + ip + '), connection timed out';
    }
  }

  /* ================================================================== apt */

  const APT_HELP = 'apt ' + APT_VERSION + ' (' + ARCH + ')\nUsage: apt [options] command\n\napt is a commandline package manager and provides commands for\nsearching and managing as well as querying information about packages.\nIt provides the same functionality as the specialized APT tools,\nlike apt-get and apt-cache, but enables options more suitable for\ninteractive use by default.\n\nMost used commands:\n  list - list packages based on package names\n  search - search in package descriptions\n  show - show package details\n  install - install packages\n  reinstall - reinstall packages\n  remove - remove packages\n  autoremove - automatically remove all unused packages\n  update - update list of available packages\n  upgrade - upgrade the system by installing/upgrading packages\n  full-upgrade - upgrade the system by removing/installing/upgrading packages\n  edit-sources - edit the source information file\n  satisfy - satisfy dependency strings\n\nSee apt(8) for more information about the available commands.\nConfiguration options and syntax is detailed in apt.conf(5).\nInformation about how to configure sources can be found in sources.list(5).\nPackage and version choices can be influenced by pinning in apt_preferences(5).\n\nThis APT has Super Cow Powers.\n';
  const APT_GET_HELP = 'apt ' + APT_VERSION + ' (' + ARCH + ')\nUsage: apt-get [options] command\n       apt-get [options] install|remove pkg1 [pkg2 ...]\n       apt-get [options] source pkg1 [pkg2 ...]\n\napt-get is a command line interface for retrieval of packages\nand information about them from authenticated sources and\nfor installation, upgrade and removal of packages together\nwith their dependencies.\n\nMost used commands:\n  update - Retrieve new lists of packages\n  upgrade - Perform an upgrade\n  install - Install new packages (pkg is libc6 not libc6.deb)\n  reinstall - Reinstall packages (pkg is libc6 not libc6.deb)\n  remove - Remove packages\n  purge - Remove packages and config files\n  autoremove - Remove automatically all unused packages\n  dist-upgrade - Distribution upgrade, see apt-get(8)\n  dselect-upgrade - Follow dselect selections\n  build-dep - Configure build-dependencies for source packages\n  satisfy - Satisfy dependency strings\n  clean - Erase downloaded archive files\n  autoclean - Erase old downloaded archive files\n  check - Verify that there are no broken dependencies\n  source - Download source archives\n  download - Download the binary package into the current directory\n  changelog - Download and display the changelog for the given package\n\nSee apt-get(8) for more information about the available commands.\nConfiguration options and syntax is detailed in apt.conf(5).\nInformation about how to configure sources can be found in sources.list(5).\nPackage and version choices can be influenced by pinning in apt_preferences(5).\n\nThis APT has Super Cow Powers.\n';
  const APT_CACHE_HELP = 'apt ' + APT_VERSION + ' (' + ARCH + ')\nUsage: apt-cache [options] command\n       apt-cache [options] show pkg1 [pkg2 ...]\n\napt-cache queries and displays available information about installed\nand installable packages. It works exclusively on the data acquired\ninto the local cache via the \'update\' command of e.g. apt-get. The\nfiles in /var/lib/apt/lists/ and /var/lib/dpkg/status are used.\n\nMost used commands:\n  showsrc - Show source records\n  search - Search the package list for a regex pattern\n  depends - Show raw dependency information for a package\n  rdepends - Show reverse dependency information for a package\n  show - Show a readable record for the package\n  policy - Show policy settings\n\nSee apt-cache(8) for more information about the available commands.\nConfiguration options and syntax is detailed in apt.conf(5).\nInformation about how to configure sources can be found in sources.list(5).\nPackage and version choices can be influenced by pinning in apt_preferences(5).\n';

  const APT_OPTS = {
    short: 'yqsfdVhvmo:c:t:',
    long: ['yes', 'assume-yes', 'quiet=?', 'simulate', 'dry-run', 'just-print', 'recon', 'no-act', 'no-install-recommends', 'install-recommends', 'install-suggests',
      'no-install-suggests', 'fix-broken', 'fix-missing', 'ignore-missing', 'download-only', 'version', 'help', 'reinstall', 'purge', 'installed', 'upgradable',
      'all-versions', 'no-upgrade', 'only-upgrade', 'allow-downgrades', 'allow-remove-essential', 'allow-change-held-packages', 'auto-remove', 'autoremove',
      'show-progress', 'verbose-versions', 'print-uris', 'force-yes', 'no-remove', 'target-release=', 'option=', 'config-file=', 'names-only', 'full',
      'all-names', 'no-all-names', 'with-new-pkgs', 'list-cleanup', 'no-list-cleanup', 'show-upgraded', 'trivial-only', 'build', 'compile', 'no-download', 'allow-unauthenticated', 'fix-policy'],
    alias: { yes: 'y', 'assume-yes': 'y', simulate: 's', 'dry-run': 's', 'just-print': 's', recon: 's', 'no-act': 's', version: 'V', help: 'h', quiet: 'q', 'fix-broken': 'f', 'download-only': 'd', 'target-release': 't', option: 'o', 'config-file': 'c' },
  };

  /** apt's own spelling of getopt failures. */
  function aptOptionError(ctx, err) {
    let m = /invalid option -- '(.)'/.exec(err);
    if (m) ctx.err("Error: Command line option '" + m[1] + "' [from -" + m[1] + '] is not understood in combination with the other options.\n');
    else if ((m = /unrecognized option '(--[^']*)'/.exec(err))) ctx.err('Error: Command line option ' + m[1] + ' is not understood in combination with the other options.\n');
    else ctx.err('Error: ' + err + '\n');
    return 100;
  }

  const readingLists = (ctx) => ctx.out('Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\n');
  const notUpgradingCount = (db, plan) => { let n = 0; for (const r of db.values()) if (isUpgradable(r) && !plan.upgrade.includes(r)) n++; return n; };
  const dbFileCount = (machine) => 395000 + machine.packages.size * 11;
  const debName = (rec) => rec.name + '_' + rec.version.replace(/^\d+:/, '').replace(':', '%3a') + '_' + rec.arch + '.deb';

  async function aptUpdate(ctx, flavor, db) {
    if (!ctx.isRoot) {
      if (flavor === 'apt') ctx.out('Reading package lists... Done\n');
      ctx.err('Error: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)\nError: Unable to lock directory /var/lib/apt/lists/\nWarning: Problem unlinking the file /var/cache/apt/pkgcache.bin - RemoveCaches (13: Permission denied)\nWarning: Problem unlinking the file /var/cache/apt/srcpkgcache.bin - RemoveCaches (13: Permission denied)\n');
      return 100;
    }
    const adm = adminState(ctx.machine);
    const failure = mirrorFailure(ctx);
    if (failure) {
      await sleep(ctx, 600);
      ctx.out('Err:1 ' + MIRROR + ' kali-rolling InRelease\n  ' + failure + '\n');
    } else if (adm.listsAt) {
      await sleep(ctx, 250);
      ctx.out('Hit:1 ' + MIRROR + ' kali-rolling InRelease\n');
    } else {
      const parts = [['InRelease', '', 41500, 400], ['/main amd64 Packages', '', 20900000, 1800], ['/non-free amd64 Packages', '', 195000, 300], ['/contrib amd64 Packages', '', 118000, 300], ['/non-free-firmware amd64 Packages', '', 10500, 200]];
      let total = 0; let t = 0;
      for (let i = 0; i < parts.length; i++) {
        const [what, , size, ms] = parts[i];
        await sleep(ctx, ms); t += ms; total += size;
        ctx.out('Get:' + (i + 1) + ' ' + MIRROR + ' kali-rolling' + (what === 'InRelease' ? ' InRelease' : what) + ' [' + sizeStr(size) + ']\n');
      }
      ctx.out('Fetched ' + sizeStr(total) + ' in ' + Math.round(t / 1000) + 's (' + groupDigits(Math.round(total / 1000 / (t / 1000))) + ' kB/s)\n');
      adm.listsAt = K.clock.now();
    }
    const n = Array.from(db.values()).filter(isUpgradable).length;
    if (flavor === 'apt') {
      readingLists(ctx);
      ctx.out(n === 0 ? 'All packages are up to date.\n' : n + (n === 1 ? " package can be upgraded. Run 'apt list --upgradable' to see it.\n" : " packages can be upgraded. Run 'apt list --upgradable' to see them.\n"));
    } else ctx.out('Reading package lists... Done\n');
    if (failure) {
      ctx.err('Warning: Failed to fetch ' + MIRROR + '/dists/kali-rolling/InRelease  ' + failure + '\nWarning: Some index files failed to download. They have been ignored, or old ones used instead.\n');
    }
    return 0;
  }

  /** Work out what an install/reinstall/upgrade request does. Returns {plan, missing, already}. */
  function planInstall(ctx, db, names, o) {
    const plan = { install: [], deps: [], upgrade: [], reinstall: [], remove: [], purge: false };
    const missing = []; const already = []; const manual = [];
    const addDeps = (rec) => {
      for (const dn of rec.deps) {
        const d = db.get(dn);
        if (d && !isInstalled(d) && !plan.install.includes(d) && !plan.deps.includes(d)) { plan.deps.push(d); addDeps(d); }
      }
    };
    for (const arg of names) {
      const name = arg.replace(/\/[\w.-]+$/, '').replace(/=.*$/, '');
      const rec = /^[a-z0-9][a-z0-9+.:-]*$/.test(name) ? db.get(name.replace(/:amd64$/, '')) : null;
      if (!rec) { missing.push(arg); continue; }
      if (isInstalled(rec)) {
        if (o.reinstall) plan.reinstall.push(rec);
        else if (isUpgradable(rec)) plan.upgrade.push(rec);
        else if (!plan.upgrade.includes(rec)) { already.push(rec); if (rec.inst.auto) manual.push(rec); }
      } else if (!plan.install.includes(rec) && !plan.deps.includes(rec)) { plan.install.push(rec); addDeps(rec); }
    }
    plan.deps = plan.deps.filter((d) => !plan.install.includes(d));
    return { plan, missing, already, manual };
  }

  /** Installed automatic packages that nothing installed depends on any more. */
  function orphans(machine, db) {
    const needed = new Set();
    const visit = (rec) => { for (const dn of rec.deps) { if (needed.has(dn)) continue; needed.add(dn); const d = db.get(dn); if (d) visit(d); } };
    for (const rec of db.values()) if (isInstalled(rec) && !rec.inst.auto) visit(rec);
    return Array.from(db.values()).filter((r) => isInstalled(r) && r.inst.auto && !needed.has(r.name) && !ESSENTIAL.has(r.name));
  }

  function planStats(plan) {
    const added = plan.install.concat(plan.deps);
    const download = added.concat(plan.upgrade, plan.reinstall).reduce((s, r) => s + r.size, 0);
    const delta = added.reduce((s, r) => s + r.instSize, 0) + plan.upgrade.reduce((s, r) => s + Math.round(r.instSize * 0.02), 0) - plan.remove.reduce((s, r) => s + r.instSize, 0);
    return { download, delta };
  }

  function renderPlan(ctx, flavor, db, plan) {
    const { download, delta } = planStats(plan);
    const notUp = notUpgradingCount(db, plan);
    const added = plan.install.concat(plan.deps);
    const names = (a) => a.map((r) => r.name).sort();
    const width = ctx.cols || 80;
    let out = '';
    if (flavor === 'apt') {
      const section = (title, recs) => { if (recs.length) out += title + '\n' + wrapNames(names(recs), width) + '\n\n'; };
      section('Installing:', plan.install); section('Installing dependencies:', plan.deps); section('Upgrading:', plan.upgrade);
      section('Reinstalling:', plan.reinstall); section(plan.purge ? 'REMOVING (purge):' : 'REMOVING:', plan.remove);
      out += 'Summary:\n  Upgrading: ' + plan.upgrade.length + ', Installing: ' + added.length + ', Removing: ' + plan.remove.length + ', Not Upgrading: ' + notUp + '\n';
      if (download > 0) out += '  Download size: ' + sizeStr(download) + '\n';
      out += delta >= 0 ? '  Space needed: ' + sizeStr(delta) + ' / ' + sizeStr(28100000000 - hash(ctx.machine.hostname) % 1000000000) + ' available\n' : '  Freed space: ' + sizeStr(-delta) + '\n';
      out += '\n';
    } else {
      const block = (title, recs) => { if (recs.length) out += title + '\n' + wrapNames(names(recs), width) + '\n'; };
      block('The following additional packages will be installed:', plan.deps);
      block('The following NEW packages will be installed:', added);
      block('The following packages will be REMOVED:', plan.remove);
      block('The following packages will be upgraded:', plan.upgrade);
      block('The following packages will be reinstalled:', plan.reinstall);
      out += plan.upgrade.length + ' upgraded, ' + added.length + ' newly installed, ' + plan.remove.length + (plan.reinstall.length ? ' reinstalled, ' + plan.reinstall.length : '') + ' to remove and ' + notUp + ' not upgraded.\n';
      if (download > 0) out += 'Need to get ' + sizeStr(download) + ' of archives.\n';
      if (delta >= 0 && (added.length || plan.upgrade.length || plan.reinstall.length)) out += 'After this operation, ' + sizeStr(delta) + ' of additional disk space will be used.\n';
      else if (delta < 0) out += 'After this operation, ' + sizeStr(-delta) + ' disk space will be freed.\n';
    }
    ctx.out(out);
  }

  /** Ask the Y/n question. Returns false (after printing "Abort.") when the learner declines. */
  async function confirm(ctx, flavor, o) {
    if (o.y) return true;
    const answer = await ctx.readLine(flavor === 'apt' ? 'Continue? [Y/n] ' : 'Do you want to continue? [Y/n] ');
    if (answer != null && /^(|y|yes)$/i.test(answer.trim())) return true;
    ctx.out('Abort.\n');
    return false;
  }

  function dpkgStamp(ms) { return U.isoDate(ms); }
  function histStamp(ms) { return U.isoDate(ms).replace(' ', '  '); }

  /** Carry out a prepared plan: download, unpack, configure, update the database and the logs. */
  async function execute(ctx, flavor, db, plan, o) {
    const m = ctx.machine; const adm = adminState(m);
    const incoming = plan.install.concat(plan.deps, plan.upgrade, plan.reinstall);
    const started = K.clock.now();
    const history = [];
    if (incoming.length) {
      const failure = mirrorFailure(ctx);
      if (failure) {
        incoming.forEach((r, i) => ctx.out('Err:' + (i + 1) + ' ' + MIRROR + ' kali-rolling/main ' + ARCH + ' ' + r.name + ' ' + ARCH + ' ' + r.version + '\n  ' + failure + '\n'));
        ctx.err('Error: Failed to fetch ' + MIRROR + '/pool/main/' + incoming[0].name[0] + '/' + incoming[0].name + '/' + debName(incoming[0]) + '  ' + failure + '\nError: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?\n');
        return 100;
      }
      let total = 0;
      for (let i = 0; i < incoming.length; i++) {
        const r = incoming[i];
        await sleep(ctx, 120 + r.size / 4000);
        total += r.size;
        ctx.out('Get:' + (i + 1) + ' ' + MIRROR + ' kali-rolling/main ' + ARCH + ' ' + r.name + ' ' + r.arch + ' ' + r.version + ' [' + sizeStr(r.size) + ']\n');
      }
      const secs = Math.max(0, Math.round(total / 2500000));
      ctx.out('Fetched ' + sizeStr(total) + ' in ' + secs + 's (' + groupDigits(Math.round(total / 1000 / Math.max(secs, 1))) + ' kB/s)\n');
    }
    if (o.downloadOnly) return 0;
    let announcedDb = false;
    const announce = () => { if (!announcedDb) { ctx.out('(Reading database ... ' + dbFileCount(m) + ' files and directories currently installed.)\n'); announcedDb = true; } };
    const dlog = (text) => appendFile(m, '/var/log/dpkg.log', text);
    const stamp = () => dpkgStamp(K.clock.now()) + ' ';
    dlog(stamp() + 'startup archives unpack\n');
    for (const r of plan.install.concat(plan.deps)) {
      const auto = plan.deps.includes(r);
      ctx.out('Selecting previously unselected package ' + r.name + '.\n');
      announce();
      ctx.out('Preparing to unpack .../' + debName(r) + ' ...\nUnpacking ' + r.name + ' (' + r.version + ') ...\n');
      await sleep(ctx, 200 + r.instSize / 20000);
      dlog(stamp() + 'install ' + r.name + ':' + r.arch + ' <none> ' + r.version + '\n' + stamp() + 'status half-installed ' + r.name + ':' + r.arch + ' ' + r.version + '\n' + stamp() + 'status unpacked ' + r.name + ':' + r.arch + ' ' + r.version + '\n');
      m.packages.set(r.name, { version: r.version, arch: r.arch, desc: r.desc, status: 'installed', auto });
      history.push(['Install', r.name + ':' + r.arch + ' (' + r.version + (auto ? ', automatic' : '') + ')']);
    }
    for (const r of plan.upgrade.concat(plan.reinstall)) {
      announce();
      ctx.out('Preparing to unpack .../' + debName(r) + ' ...\nUnpacking ' + r.name + ' (' + r.version + ') over (' + r.current + ') ...\n');
      await sleep(ctx, 150);
      dlog(stamp() + (plan.upgrade.includes(r) ? 'upgrade ' : 'install ') + r.name + ':' + r.arch + ' ' + r.current + ' ' + r.version + '\n' + stamp() + 'status unpacked ' + r.name + ':' + r.arch + ' ' + r.version + '\n');
      m.packages.set(r.name, Object.assign({}, r.inst, { version: r.version }));
      delete adm.upgradable[r.name];
      history.push([plan.upgrade.includes(r) ? 'Upgrade' : 'Reinstall', r.name + ':' + r.arch + ' (' + (plan.upgrade.includes(r) ? r.current + ', ' : '') + r.version + ')']);
    }
    for (const r of plan.remove) {
      if (isInstalled(r)) { announce(); ctx.out('Removing ' + r.name + ' (' + r.current + ') ...\n'); dlog(stamp() + 'remove ' + r.name + ':' + r.arch + ' ' + r.current + ' <none>\n' + stamp() + 'status config-files ' + r.name + ':' + r.arch + ' ' + r.current + '\n'); }
      else announce();
      if (plan.purge) { ctx.out('Purging configuration files for ' + r.name + ' (' + r.current + ') ...\n'); dlog(stamp() + 'purge ' + r.name + ':' + r.arch + ' ' + r.current + ' <none>\n' + stamp() + 'status not-installed ' + r.name + ':' + r.arch + ' <none>\n'); }
      await sleep(ctx, 100);
      for (const def of commandsOf(m, r.name)) { try { m.vfs.unlink(def.path); } catch (e) { /* already gone */ } }
      if (plan.purge) m.packages.delete(r.name); else m.packages.set(r.name, Object.assign({}, r.inst, { status: 'config-files' }));
      history.push([plan.purge ? 'Purge' : 'Remove', r.name + ':' + r.arch + ' (' + r.current + ')']);
    }
    for (const r of plan.install.concat(plan.deps, plan.upgrade, plan.reinstall)) {
      dlog(stamp() + 'startup packages configure\n' + stamp() + 'configure ' + r.name + ':' + r.arch + ' ' + r.version + ' <none>\n' + stamp() + 'status half-configured ' + r.name + ':' + r.arch + ' ' + r.version + '\n' + stamp() + 'status installed ' + r.name + ':' + r.arch + ' ' + r.version + '\n');
      ctx.out('Setting up ' + r.name + ' (' + r.version + ') ...\n');
      await sleep(ctx, 120);
      for (const def of commandsOf(m, r.name)) m.installCommand(def);
    }
    if (incoming.length || plan.remove.length) ctx.out('Processing triggers for man-db (' + m.packages.get('man-db').version + ') ...\n');
    const who = ctx.env.SUDO_USER || ctx.user.name; const u = m.userByName(who);
    const grouped = {};
    for (const [kind, text] of history) (grouped[kind] = grouped[kind] || []).push(text);
    appendFile(m, '/var/log/apt/history.log', '\nStart-Date: ' + histStamp(started) + '\nCommandline: ' + ctx.argv.join(' ') + '\nRequested-By: ' + who + ' (' + (u ? u.uid : ctx.user.uid) + ')\n' +
      Object.keys(grouped).map((k) => k + ': ' + grouped[k].join(', ') + '\n').join('') + 'End-Date: ' + histStamp(K.clock.now()) + '\n');
    for (const [kind, text] of history) log(m, { ident: 'dpkg', pid: ctx.pid, msg: kind.toLowerCase() + ' ' + text });
    return 0;
  }

  /** Shared body of install, reinstall, remove, purge, upgrade and autoremove after the plan is known. */
  async function runPlan(ctx, flavor, db, plan, o) {
    readingLists(ctx);
    if (o.preface) o.preface();
    const empty = !plan.install.length && !plan.deps.length && !plan.upgrade.length && !plan.reinstall.length && !plan.remove.length;
    const essential = plan.remove.filter((r) => ESSENTIAL.has(r.name));
    if (essential.length && !o.simulate) {
      if (o.y && !o.allowEssential) { ctx.err('Error: Essential packages were removed and -y was used without --allow-remove-essential.\n'); return 100; }
      ctx.out('WARNING: The following essential packages will be removed.\nThis should NOT be done unless you know exactly what you are doing!\n  ' + essential.map((r) => r.name).join(' ') + ' (due to ' + essential[0].name + ')\n');
    }
    renderPlan(ctx, flavor, db, plan);
    if (empty) return 0;
    if (o.simulate) {
      for (const r of plan.install.concat(plan.deps)) ctx.out('Inst ' + r.name + ' (' + r.version + ' Kali:kali-rolling [' + r.arch + '])\n');
      for (const r of plan.upgrade) ctx.out('Inst ' + r.name + ' [' + r.current + '] (' + r.version + ' Kali:kali-rolling [' + r.arch + '])\n');
      for (const r of plan.remove) ctx.out('Remv ' + r.name + ' [' + r.current + ']\n');
      for (const r of plan.install.concat(plan.deps, plan.upgrade)) ctx.out('Conf ' + r.name + ' (' + r.version + ' Kali:kali-rolling [' + r.arch + '])\n');
      return 0;
    }
    if (essential.length) {
      const phrase = await ctx.readLine("You are about to do something potentially harmful.\nTo continue type in the phrase 'Yes, do as I say!'\n ?] ");
      if (phrase !== 'Yes, do as I say!') { ctx.out('Abort.\n'); return 1; }
    } else if (!(await confirm(ctx, flavor, o))) return 1;
    return execute(ctx, flavor, db, plan, o);
  }

  async function aptTransaction(ctx, flavor, cmd, g) {
    const lock = ['Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)', 'Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?'];
    const o = { y: !!g.opts.y || g.count.q >= 2, simulate: !!g.opts.s, reinstall: !!g.opts.reinstall, downloadOnly: !!g.opts.d, allowEssential: !!g.opts['allow-remove-essential'] };
    if (!o.simulate && needRootGate(ctx, lock)) return 100;
    const m = ctx.machine; const db = buildDb(m);
    let plan = { install: [], deps: [], upgrade: [], reinstall: [], remove: [], purge: false };
    if (cmd === 'install' || (cmd === 'reinstall')) {
      if (cmd === 'reinstall') o.reinstall = true;
      const r = planInstall(ctx, db, g.rest, o);
      if (r.missing.length) {
        readingLists(ctx);
        for (const n of r.missing) ctx.err(/\.deb$|^\.?\//.test(n) ? "Error: Unsupported file " + n + " given on commandline\n" : 'Error: Unable to locate package ' + n + '\n');
        return 100;
      }
      plan = r.plan;
      o.preface = () => {
        for (const rec of r.already) ctx.out(rec.name + ' is already the newest version (' + rec.current + ').\n');
        for (const rec of r.manual) { ctx.out(rec.name + ' set to manually installed.\n'); rec.inst.auto = false; }
      };
    } else if (cmd === 'remove' || cmd === 'purge' || cmd === 'autopurge') {
      plan.purge = cmd === 'purge' || cmd === 'autopurge' || !!g.opts.purge;
      const notes = [];
      for (const arg of g.rest) {
        const rec = db.get(arg.replace(/:amd64$/, ''));
        if (!rec) { readingLists(ctx); ctx.err('Error: Unable to locate package ' + arg + '\n'); return 100; }
        if (isInstalled(rec) || (plan.purge && rec.inst && rec.inst.status === 'config-files')) plan.remove.push(rec);
        else notes.push("Package '" + arg + "' is not installed, so not removed");
      }
      o.preface = () => notes.forEach((n) => ctx.out(n + '\n'));
    } else if (cmd === 'autoremove' || cmd === 'autopurge') {
      plan.remove = orphans(m, db); plan.purge = cmd === 'autopurge';
    } else {
      plan.upgrade = Array.from(db.values()).filter(isUpgradable);
      if (g.rest.length) plan.upgrade = plan.upgrade.filter((r) => g.rest.includes(r.name));
    }
    return runPlan(ctx, flavor, db, plan, o);
  }

  /* ---- listing, search and show ---- */

  const globRe = (pat) => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  function statusLabel(rec) {
    const flags = isInstalled(rec) ? ['installed'].concat(rec.inst.auto ? ['automatic'] : []) : [];
    if (isUpgradable(rec)) return '[upgradable from: ' + rec.current + ']';
    return flags.length ? '[' + flags.join(',') + ']' : '';
  }
  function listLine(ctx, rec) {
    const name = ctx.isTTY ? K.c.green(rec.name) : rec.name;
    const now = isInstalled(rec) && !isUpgradable(rec) ? ',now' : '';
    return name + '/kali-rolling' + now + ' ' + rec.version + ' ' + rec.arch + (statusLabel(rec) ? ' ' + statusLabel(rec) : '');
  }
  const aptWarning = (ctx) => { if (!ctx.isTTY) ctx.err('\nWARNING: apt does not have a stable CLI interface. Use with caution in scripts.\n\n'); };

  function aptList(ctx, db, g) {
    aptWarning(ctx);
    ctx.out('Listing... Done\n');
    const res = g.rest.map(globRe);
    let recs = Array.from(db.values()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (res.length) recs = recs.filter((r) => res.some((re) => re.test(r.name)));
    if (g.opts.installed) recs = recs.filter(isInstalled);
    if (g.opts.upgradable) recs = recs.filter(isUpgradable);
    for (const r of recs) ctx.out(listLine(ctx, r) + '\n');
    return 0;
  }

  function matchTerms(terms, text) {
    return terms.every((t) => { try { return new RegExp(t, 'i').test(text); } catch (e) { return text.toLowerCase().includes(t.toLowerCase()); } });
  }
  function aptSearch(ctx, db, g) {
    aptWarning(ctx);
    if (!g.rest.length) { ctx.err('Error: You must give at least one search pattern\n'); return 100; }
    ctx.out('Sorting... Done\nFull Text Search... Done\n');
    const recs = Array.from(db.values()).filter((r) => matchTerms(g.rest, g.opts['names-only'] ? r.name : r.name + ' ' + r.desc)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const r of recs) ctx.out(listLine(ctx, r) + '\n  ' + r.desc + '\n\n');
    return 0;
  }

  function showRecord(rec) {
    const lines = ['Package: ' + rec.name, 'Version: ' + rec.version, 'Priority: optional', 'Section: ' + rec.section, 'Maintainer: Kali Developers <devel@kali.org>',
      'Installed-Size: ' + sizeStr(rec.instSize), 'Depends: libc6 (>= 2.38)' + (rec.deps.length ? ', ' + rec.deps.join(', ') : ''), 'Homepage: https://www.kali.org/tools/' + rec.name + '/',
      'Download-Size: ' + sizeStr(rec.size)];
    if (isInstalled(rec)) lines.push('APT-Manual-Installed: ' + (rec.inst.auto ? 'no' : 'yes'));
    lines.push('APT-Sources: ' + MIRROR + ' kali-rolling/main ' + rec.arch + ' Packages', 'Description: ' + rec.desc.split('\n')[0]);
    return lines.join('\n') + '\n';
  }
  function aptShow(ctx, db, g, quietNotice) {
    if (!g.rest.length) { ctx.err('Error: No packages found\n'); return 100; }
    let bad = false;
    for (const n of g.rest) {
      const rec = db.get(n.replace(/\/[\w.-]+$/, ''));
      if (!rec) { ctx.err('Notice: Unable to locate package ' + n + '\n'); bad = true; continue; }
      ctx.out(showRecord(rec) + '\n');
    }
    if (bad) ctx.err('Error: No packages found\n');
    return bad ? 100 : 0;
  }

  function aptPolicy(ctx, db, g) {
    if (!g.rest.length) {
      let out = 'Package files:\n 100 /var/lib/dpkg/status\n     release a=now\n';
      for (const c of ['non-free-firmware', 'non-free', 'contrib', 'main']) out += ' 500 ' + MIRROR + ' kali-rolling/' + c + ' ' + ARCH + ' Packages\n     release v=2026.3,o=Kali,a=kali-rolling,n=kali-rolling,l=Kali,c=' + c + ',b=' + ARCH + '\n     origin http.kali.org\n';
      ctx.out(out + 'Pinned packages:\n');
      return 0;
    }
    for (const n of g.rest) {
      const rec = db.get(n);
      if (!rec) { ctx.err('Notice: Unable to locate package ' + n + '\n'); continue; }
      let out = rec.name + ':\n  Installed: ' + (isInstalled(rec) ? rec.current : '(none)') + '\n  Candidate: ' + rec.version + '\n  Version table:\n';
      if (isUpgradable(rec)) out += '     ' + rec.version + ' 500\n        500 ' + MIRROR + ' kali-rolling/main ' + rec.arch + ' Packages\n';
      out += (isInstalled(rec) ? ' *** ' + rec.current + ' ' + (isUpgradable(rec) ? '100' : '500') : '     ' + rec.version + ' 500') + '\n        500 ' + MIRROR + ' kali-rolling/main ' + rec.arch + ' Packages\n';
      if (isInstalled(rec)) out += '        100 /var/lib/dpkg/status\n';
      ctx.out(out);
    }
    return 0;
  }

  async function aptMain(ctx, flavor) {
    const g = K.getopt(ctx.args, APT_OPTS);
    if (g.err) return aptOptionError(ctx, g.err);
    if (g.opts.V) { ctx.out('apt ' + APT_VERSION + ' (' + ARCH + ')\n'); return 0; }
    const cmd = g.rest.shift();
    if (g.opts.h || !cmd) { ctx.out(flavor === 'apt' ? APT_HELP : APT_GET_HELP); return cmd || g.opts.h ? 0 : 1; }
    const m = ctx.machine; const db = buildDb(m);
    const common = ['update', 'upgrade', 'install', 'remove', 'purge', 'autoremove', 'autopurge'];
    const own = flavor === 'apt' ? ['full-upgrade', 'reinstall', 'list', 'search', 'show', 'clean', 'autoclean', 'edit-sources', 'satisfy'] : ['dist-upgrade', 'clean', 'autoclean', 'check', 'source', 'build-dep', 'download', 'changelog', 'dselect-upgrade'];
    if (!common.concat(own).includes(cmd)) { ctx.err('Error: Invalid operation ' + cmd + '\n'); return 100; }
    switch (cmd) {
      case 'update': return aptUpdate(ctx, flavor, db);
      case 'list': return aptList(ctx, db, g);
      case 'search': return aptSearch(ctx, db, g);
      case 'show': return aptShow(ctx, db, g);
      case 'clean': case 'autoclean':
        if (cmd === 'clean' && !ctx.isRoot) { ctx.err('Error: Could not open lock file /var/cache/apt/archives/lock - open (13: Permission denied)\nError: Unable to lock directory /var/cache/apt/archives/\n'); return 100; }
        if (cmd === 'autoclean') readingLists(ctx);
        return 0;
      case 'check': readingLists(ctx); return 0;
      case 'source': case 'build-dep': ctx.err("Error: You must put some 'deb-src' URIs in your sources.list\n"); return 100;
      case 'edit-sources': ctx.err('Error: edit-sources is not simulated; the repository is described in /etc/apt/sources.list.d/kali.sources\n'); return 100;
      case 'satisfy': case 'download': case 'changelog': case 'dselect-upgrade':
        ctx.err('Error: ' + cmd + ' is not simulated in Kalima\n'); return 100;
      default: return aptTransaction(ctx, flavor, cmd === 'dist-upgrade' ? 'full-upgrade' : cmd, g);
    }
  }

  K.cmd.register({
    name: 'apt', pkg: 'apt', section: 8, summary: 'command-line interface', synopsis: 'apt [options] command',
    man: 'DESCRIPTION\n       apt provides a high-level commandline interface for the package management system. It is intended as an end user interface and enables some options better suited for interactive usage by default.\n\nCOMMANDS\n       list, search, show\n              Query the package lists.\n       update\n              Download package information from the Kali mirror.\n       install, reinstall, remove, purge, autoremove\n              Change what is installed. Needs root.\n       upgrade, full-upgrade\n              Install newer versions of installed packages.\n\nOPTIONS\n       -y, --assume-yes   automatic yes to prompts\n       -s, --simulate     only show what would be done\n       --installed, --upgradable   restrict apt list\n\nEXAMPLES\n       sudo apt update && sudo apt install -y nmap\n       apt list --upgradable\n       apt search "web server"',
    run: (ctx) => aptMain(ctx, 'apt'),
  });
  K.cmd.register({
    name: 'apt-get', pkg: 'apt', section: 8, summary: 'APT package handling utility -- command-line interface', synopsis: 'apt-get [options] command',
    man: 'DESCRIPTION\n       apt-get is the command-line tool for handling packages, and may be considered the user\'s "back-end" to other tools using the APT library.\n\nCOMMANDS\n       update, upgrade, dist-upgrade, install, remove, purge, autoremove, clean, autoclean, check\n\nOPTIONS\n       -y, --assume-yes   automatic yes to prompts\n       -s, --simulate     no action, perform a simulation\n       --reinstall        reinstall packages that are already installed\n\nEXAMPLES\n       sudo apt-get update\n       sudo apt-get install -y nikto',
    run: (ctx) => aptMain(ctx, 'apt-get'),
  });

  /* ---- apt-cache ---- */
  K.cmd.register({
    name: 'apt-cache', pkg: 'apt', section: 8, summary: 'query the APT cache', synopsis: 'apt-cache [options] command',
    man: 'DESCRIPTION\n       apt-cache performs a variety of operations on APT\'s package cache.\n\nCOMMANDS\n       search regex, show pkg, policy [pkg], depends pkg, pkgnames [prefix]\n\nOPTIONS\n       -n, --names-only   only search package names\n\nEXAMPLES\n       apt-cache policy nmap\n       apt-cache search "port scanner"',
    run(ctx) {
      const g = K.getopt(ctx.args, { short: 'nfiVhc:o:', long: ['names-only', 'full', 'installed', 'version', 'help', 'all-versions', 'recurse', 'generate', 'no-all-versions', 'config-file=', 'option='], alias: { 'names-only': 'n', version: 'V', help: 'h' } });
      if (g.err) return aptOptionError(ctx, g.err);
      if (g.opts.V) { ctx.out('apt ' + APT_VERSION + ' (' + ARCH + ')\n'); return 0; }
      const cmd = g.rest.shift();
      if (g.opts.h || !cmd) { ctx.out(APT_CACHE_HELP); return 0; }
      const db = buildDb(ctx.machine);
      const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      switch (cmd) {
        case 'search': {
          if (!g.rest.length) { ctx.err('Error: At least one argument is required\n'); return 100; }
          for (const r of Array.from(db.values()).sort(byName)) if (matchTerms(g.rest, g.opts.n ? r.name : r.name + ' ' + r.desc)) ctx.out(r.name + ' - ' + r.desc + '\n');
          return 0;
        }
        case 'show': return aptShow(ctx, db, g);
        case 'policy': return aptPolicy(ctx, db, g);
        case 'pkgnames': for (const r of Array.from(db.values()).sort(byName)) if (!g.rest[0] || r.name.startsWith(g.rest[0])) ctx.out(r.name + '\n'); return 0;
        case 'depends': {
          for (const n of g.rest) {
            const rec = db.get(n);
            if (!rec) { ctx.err('Error: No packages found\n'); return 100; }
            ctx.out(rec.name + '\n' + ['libc6'].concat(rec.deps).map((d) => '  Depends: ' + d + '\n').join(''));
          }
          return 0;
        }
        default: ctx.err('Error: Invalid operation ' + cmd + '\n'); return 100;
      }
    },
  });

  /* ================================================================ dpkg */

  const DPKG_VERSION = '1.22.21';
  const DPKG_FOOTER = "\nType dpkg --help for help about installing and deinstalling packages [*];\nUse 'apt' or 'aptitude' for user-friendly package management;\nType dpkg -Dhelp for a list of dpkg debug flag values;\nType dpkg --force-help for a list of forcing options;\nType dpkg-deb --help for help about manipulating *.deb files;\n\nOptions marked [*] produce a lot of output - pipe it through 'less' or 'more' !\n";
  const DPKG_ACTIONS = { l: 'list', L: 'listfiles', S: 'search', s: 'status', W: 'show', i: 'install', r: 'remove', P: 'purge', C: 'audit', V: 'verify' };

  /** Files a package ships here: its command paths, man pages and doc directory. */
  function filesOf(machine, name) {
    const files = new Set(['/.']);
    const add = (path) => { const parts = path.split('/').filter(Boolean); let cur = ''; parts.forEach((p, i) => { cur += '/' + p; if (i < parts.length - 1) files.add(cur); }); files.add(path); };
    for (const def of commandsOf(machine, name)) {
      add(def.path);
      if (def.man && !def.aliasOf) add('/usr/share/man/man' + def.section + '/' + def.name + '.' + def.section + '.gz');
    }
    add('/usr/share/doc/' + name + '/copyright');
    return Array.from(files).sort();
  }

  function globToRegExp(pat) { return new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'); }

  function statusCode(p) { return p.status === 'installed' ? 'ii' : 'rc'; }

  function dpkgList(ctx, db, patterns, prog) {
    const m = ctx.machine;
    const res = patterns.map(globToRegExp);
    const rows = Array.from(m.packages.keys()).sort().filter((n) => !res.length || res.some((re) => re.test(n)));
    if (!rows.length) { ctx.err(prog + ': no packages found matching ' + patterns.join(', ') + '\n'); return 1; }
    const pk = rows.map((n) => ({ n, p: m.packages.get(n) }));
    const nw = Math.max(14, ...pk.map((r) => r.n.length)); const vw = Math.max(12, ...pk.map((r) => r.p.version.length));
    const used = 4 + nw + 1 + vw + 1 + 12 + 1;
    let dw = Math.max(33, ...pk.map((r) => r.p.desc.length));
    if (ctx.isTTY) dw = Math.max(1, ctx.cols - used);
    const pad = U.padEnd;
    let out = 'Desired=Unknown/Install/Remove/Purge/Hold\n| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend\n|/ Err?=(none)/Reinst-required (Status,Err: uppercase=bad)\n';
    out += '||/ ' + pad('Name', nw) + ' ' + pad('Version', vw) + ' ' + pad('Architecture', 12) + ' Description\n';
    out += '+++-' + '='.repeat(nw) + '-' + '='.repeat(vw) + '-' + '='.repeat(12) + '-' + '='.repeat(dw) + '\n';
    for (const r of pk) out += statusCode(r.p) + '  ' + pad(r.n, nw) + ' ' + pad(r.p.version, vw) + ' ' + pad(r.p.arch, 12) + ' ' + r.p.desc.slice(0, dw) + '\n';
    ctx.out(out);
    return 0;
  }

  function dpkgStatus(ctx, db, names, prog) {
    let status = 0;
    for (const n of names) {
      const p = ctx.machine.packages.get(n); const rec = db.get(n);
      if (!p) { ctx.err(prog + ": package '" + n + "' is not installed and no information is available\nUse dpkg --info (= dpkg-deb --info) to examine archive files.\n"); status = 1; continue; }
      const lines = ['Package: ' + n, 'Status: ' + (p.status === 'installed' ? 'install ok installed' : 'deinstall ok config-files'), 'Priority: optional', 'Section: ' + rec.section,
        'Installed-Size: ' + Math.round(rec.instSize / 1024), 'Maintainer: Kali Developers <devel@kali.org>', 'Architecture: ' + p.arch, 'Version: ' + p.version];
      if (rec.deps.length || n !== 'libc6') lines.push('Depends: libc6 (>= 2.38)' + (rec.deps.length ? ', ' + rec.deps.join(', ') : ''));
      lines.push('Description: ' + p.desc, 'Homepage: https://www.kali.org/tools/' + n + '/');
      ctx.out(lines.join('\n') + '\n\n');
    }
    return status;
  }

  function dpkgListFiles(ctx, names, prog) {
    let status = 0;
    for (const n of names) {
      const p = ctx.machine.packages.get(n);
      if (!p || p.status !== 'installed') { ctx.err(prog + ": package '" + n + "' is not installed\nUse dpkg --contents (= dpkg-deb --contents) to list archive files contents.\n"); status = 1; continue; }
      ctx.out(filesOf(ctx.machine, n).join('\n') + '\n');
    }
    return status;
  }

  function dpkgSearch(ctx, patterns, prog) {
    let status = 0;
    for (const pat of patterns) {
      const glob = /[*?[]/.test(pat) ? pat : pat.startsWith('/') ? pat : '*' + pat + '*';
      const re = globToRegExp(glob.replace(/^\/+/, '/'));
      const hits = [];
      for (const [n, p] of ctx.machine.packages) if (p.status === 'installed') for (const f of filesOf(ctx.machine, n)) if (f !== '/.' && re.test(f)) hits.push([n, f]);
      if (!hits.length) { ctx.err(prog + ': no path found matching pattern ' + glob + '\n'); status = 1; continue; }
      for (const [n, f] of hits) ctx.out(n + ': ' + f + '\n');
    }
    return status;
  }

  function dpkgShow(ctx, db, g, prog) {
    const m = ctx.machine;
    const fmt = typeof g.opts.f === 'string' ? g.opts.f.replace(/^=/, '') : '${binary:Package}\t${Version}\n';
    const render = (n, p) => {
      const rec = db.get(n);
      const vars = { Package: n, 'binary:Package': n, Version: p.version, Architecture: p.arch, Status: p.status === 'installed' ? 'install ok installed' : 'deinstall ok config-files',
        'binary:Summary': p.desc, Section: rec.section, Priority: 'optional', 'Installed-Size': String(Math.round(rec.instSize / 1024)), Maintainer: 'Kali Developers <devel@kali.org>' };
      return fmt.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\$\{([^}]+)\}/g, (all, k) => (k in vars ? vars[k] : ''));
    };
    const names = g.rest.length ? g.rest : Array.from(m.packages.keys()).sort();
    let status = 0; let out = '';
    for (const n of names) {
      const res = g.rest.length ? [globToRegExp(n)] : null;
      const hit = res ? Array.from(m.packages.keys()).sort().filter((k) => res[0].test(k)) : [n];
      if (!hit.length) { ctx.err(prog + ': no packages found matching ' + n + '\n'); status = 1; }
      for (const k of hit) out += render(k, m.packages.get(k));
    }
    ctx.out(out);
    return status;
  }

  function dpkgSelections(ctx, patterns) {
    const m = ctx.machine; const res = patterns.map(globToRegExp);
    const names = Array.from(m.packages.keys()).sort().filter((n) => !res.length || res.some((re) => re.test(n)));
    if (patterns.length && !names.length) { ctx.err('dpkg: no packages found matching ' + patterns[0] + '\n'); return 1; }
    ctx.out(names.map((n) => n + '\t'.repeat(Math.max(1, 6 - Math.floor(n.length / 8))) + (m.packages.get(n).status === 'installed' ? 'install' : 'deinstall')).join('\n') + (names.length ? '\n' : ''));
    return 0;
  }

  async function dpkgModify(ctx, db, action, g) {
    if (!ctx.isRoot) { ctx.err('dpkg: error: requested operation requires superuser privilege\n'); return 2; }
    if (action === 'install') {
      if (!g.rest.length) { ctx.err('dpkg: error: --install needs at least one package archive file argument\n' + DPKG_FOOTER); return 2; }
      for (const f of g.rest) {
        if (!ctx.fs.exists(f)) { ctx.err("dpkg: error: cannot access archive '" + f + "': No such file or directory\n"); return 2; }
        ctx.err("dpkg-deb: error: '" + f + "' is not a Debian format archive\ndpkg: error: dpkg-deb --control subprocess returned error exit status 2\n");
        return 2;
      }
    }
    const plan = { install: [], deps: [], upgrade: [], reinstall: [], remove: [], purge: action === 'purge' };
    for (const n of g.rest) {
      const rec = db.get(n);
      if (rec && rec.inst && (rec.inst.status === 'installed' || (plan.purge && rec.inst.status === 'config-files'))) plan.remove.push(rec);
      else ctx.err("dpkg: warning: ignoring request to remove " + n + " which isn't installed\n");
    }
    if (!plan.remove.length) return 0;
    return execute(ctx, 'dpkg', db, plan, {});
  }

  function dpkgMain(ctx, prog) {
    const query = prog === 'dpkg-query';
    const g = K.getopt(ctx.args, { short: 'lLSsWiVrPCDGhf:', long: ['list', 'listfiles', 'search', 'status', 'show', 'install', 'remove', 'purge', 'configure', 'get-selections', 'print-architecture', 'version', 'help', 'audit', 'verify', 'showformat=', 'force-all', 'force-depends', 'force-confnew', 'force-confold', 'force-confdef', 'force-overwrite', 'force-architecture', 'no-pager', 'unpack', 'pending', 'skip-same-version', 'refuse-downgrade', 'admindir=', 'root=', 'instdir=', 'log=', 'set-selections', 'clear-selections', 'add-architecture', 'remove-architecture', 'print-foreign-architectures', 'listfiles', 'control-path'],
      alias: { list: 'l', listfiles: 'L', search: 'S', status: 's', show: 'W', install: 'i', remove: 'r', purge: 'P', audit: 'C', verify: 'V', showformat: 'f', help: 'h' } });
    const usageTail = query ? '\nUse --help for help about querying packages.\n' : DPKG_FOOTER;
    if (g.err) {
      const m = /invalid option -- '(.)'/.exec(g.err) || /unrecognized option '--([^']*)'/.exec(g.err);
      ctx.err(prog + ': error: unknown option ' + (m ? (g.err.startsWith('invalid') ? '-' : '--') + m[1] : g.err) + '\n' + usageTail);
      return 2;
    }
    if (g.opts.version) {
      ctx.out(query ? "Debian dpkg-query package management program query tool version " + DPKG_VERSION + ' (' + ARCH + ").\nThis is free software; see the GNU General Public License version 2 or\nlater for copying conditions. There is NO warranty.\n"
        : "Debian 'dpkg' package management program version " + DPKG_VERSION + ' (' + ARCH + ").\nThis is free software; see the GNU General Public License version 2 or\nlater for copying conditions. There is NO warranty.\n");
      return 0;
    }
    if (g.opts.h) { ctx.out('Usage: ' + prog + ' [<option> ...] <command>\n\nCommands:\n  -l|--list [<pattern> ...]        List packages concisely.\n  -s|--status <package> ...        Display package status details.\n  -L|--listfiles <package> ...     List files \'owned\' by package(s).\n  -S|--search <pattern> ...        Find package(s) owning file(s).\n  -W|--show [<pattern> ...]        Show information on package(s).\n' + (query ? '' : '  -i|--install <file> ...          Install package.\n  -r|--remove <package> ...        Remove an installed package.\n  -P|--purge <package> ...         Remove a package, including configuration.\n') + '\nUse --help for help about querying packages.\n'); return 0; }
    if (g.opts['print-architecture']) { ctx.out(ARCH + '\n'); return 0; }
    if (g.opts['print-foreign-architectures']) return 0;
    let action = null;
    for (const k of Object.keys(g.opts)) { if (DPKG_ACTIONS[k]) action = DPKG_ACTIONS[k]; }
    if (g.opts['get-selections']) action = 'get-selections';
    if (g.opts.configure || g.opts.pending || g.opts.unpack) action = 'configure';
    if (!action) { ctx.err(prog + ': error: need an action option\n' + usageTail); return 2; }
    const db = buildDb(ctx.machine);
    prog = 'dpkg-query'; // dpkg forwards the query actions, and the errors carry the forwarded name
    const needArgs = (what) => { if (!g.rest.length) { ctx.err(prog + ': error: --' + what + ' needs at least one package name argument\n' + usageTail); return false; } return true; };
    switch (action) {
      case 'list': return dpkgList(ctx, db, g.rest, prog);
      case 'status': return needArgs('status') ? dpkgStatus(ctx, db, g.rest, prog) : 2;
      case 'listfiles': return needArgs('listfiles') ? dpkgListFiles(ctx, g.rest, prog) : 2;
      case 'search': return needArgs('search') ? dpkgSearch(ctx, g.rest, prog) : 2;
      case 'show': return dpkgShow(ctx, db, g, prog);
      case 'get-selections': return dpkgSelections(ctx, g.rest);
      case 'audit': case 'verify': case 'configure': return action === 'configure' && !ctx.isRoot ? (ctx.err('dpkg: error: requested operation requires superuser privilege\n'), 2) : 0;
      default: return dpkgModify(ctx, db, action, g);
    }
  }

  K.cmd.register({
    name: 'dpkg', pkg: 'dpkg', section: 1, summary: 'package manager for Debian', synopsis: 'dpkg [option...] action',
    man: 'DESCRIPTION\n       dpkg is the software at the base of the package management system. It is used to install, remove and inspect .deb packages.\n\nOPTIONS\n       -l [pattern]   list packages\n       -L package     list files installed from a package\n       -S pattern     find the package owning a file\n       -s package     show package status\n       -i file.deb    install a package file (root)\n       -r, -P package remove or purge a package (root)\n       --get-selections   list package selections\n\nEXAMPLES\n       dpkg -l \'nmap*\'\n       dpkg -S /usr/bin/ls',
    run: (ctx) => dpkgMain(ctx, 'dpkg'),
  });
  K.cmd.register({
    name: 'dpkg-query', pkg: 'dpkg', section: 1, summary: 'a tool to query the dpkg database', synopsis: 'dpkg-query [option...] command',
    man: 'DESCRIPTION\n       dpkg-query is a tool to show information about packages listed in the dpkg database.\n\nOPTIONS\n       -l [pattern]   list packages\n       -L package     list files\n       -S pattern     search for a file\n       -s package     status\n       -W [-f format] show information, e.g. -f \'${Package} ${Version}\\n\'\n\nEXAMPLES\n       dpkg-query -W -f=\'${Package}\\t${Version}\\n\' bash',
    run: (ctx) => dpkgMain(ctx, 'dpkg-query'),
  });

  /* ================================================== users and groups */

  const NAME_RE = /^[a-z_][a-z0-9_-]{0,31}[$]?$/;
  const SKEL_FILES = ['.bashrc', '.profile', '.bash_logout', '.zshrc'];
  const LOGIN_UID_MIN = 1000; const LOGIN_UID_MAX = 59999;

  // New home directories are copied from /etc/skel, which Debian fills with the dotfiles of a fresh user.
  K.fsSeeds.push((machine) => {
    const sample = machine.users.find((u) => u.uid >= LOGIN_UID_MIN && u.uid < 60000);
    if (!sample) return;
    for (const f of SKEL_FILES) {
      try { machine.vfs.seed('/etc/skel/' + f, machine.vfs.read(sample.home + '/' + f), { mode: 0o644 }); } catch (e) { /* this profile has no such dotfile */ }
    }
  });

  function permissionDenied(ctx, prog, file) {
    ctx.err(prog + ': Permission denied.\n' + prog + ': cannot lock ' + (file || '/etc/passwd') + '; try again later.\n');
    return 1;
  }
  function nextFree(used, start, max) { let n = start; while (used.has(n) && n <= max) n++; return n; }
  const nextUid = (m) => nextFree(new Set(m.users.map((u) => u.uid)), LOGIN_UID_MIN, LOGIN_UID_MAX);
  const nextGid = (m) => nextFree(new Set(m.groups.map((g) => g.gid)), LOGIN_UID_MIN, LOGIN_UID_MAX);
  const systemId = (m, used) => { let n = 999; while (used.has(n) && n > 100) n--; return n; };

  function authLog(ctx, ident, msg) { log(ctx.machine, { facility: 'auth', ident, pid: ctx.pid, msg }); }

  /** Copy a directory tree inside the VFS giving every entry to uid:gid (used for /etc/skel). */
  function copyTree(vfs, from, to, uid, gid) {
    for (const name of vfs.readdir(from)) {
      const src = from + '/' + name; const dst = to + '/' + name;
      const st = vfs.lstat(src);
      if (st.isDir) { vfs.seedDir(dst, { mode: st.mode & 0o7777, uid, gid }); copyTree(vfs, src, dst, uid, gid); }
      else if (st.isLink) vfs.seedLink(dst, vfs.readlink(src), { uid, gid });
      else vfs.seed(dst, vfs.read(src), { mode: st.mode & 0o7777, uid, gid });
    }
  }

  function createHome(ctx, user, skel) {
    const vfs = ctx.vfs;
    if (vfs.exists(user.home)) {
      ctx.err('useradd: warning: the home directory ' + user.home + ' already exists.\nuseradd: Not copying any file from skel directory into it.\n');
      return;
    }
    vfs.seedDir(user.home, { mode: 0o700, uid: user.uid, gid: user.gid, mtime: K.clock.now() });
    if (vfs.exists(skel)) copyTree(vfs, skel, user.home, user.uid, user.gid);
  }

  const gidOf = (m, spec) => { const g = m.groupByName(spec) || (/^\d+$/.test(spec) ? m.groupByGid(parseInt(spec, 10)) : null); return g || null; };

  const USERADD_USAGE = 'Usage: useradd [options] LOGIN\n       useradd -D\n       useradd -D [options]\n\nOptions:\n      --badname                 do not check for bad names\n  -b, --base-dir BASE_DIR       base directory for the home directory of the\n                                new account\n  -c, --comment COMMENT         GECOS field of the new account\n  -d, --home-dir HOME_DIR       home directory of the new account\n  -D, --defaults                print or change default useradd configuration\n  -e, --expiredate EXPIRE_DATE  expiration date of the new account\n  -f, --inactive INACTIVE       password inactivity period of the new account\n  -g, --gid GROUP               name or ID of the primary group of the new\n                                account\n  -G, --groups GROUPS           list of supplementary groups of the new\n                                account\n  -h, --help                    display this help message and exit\n  -k, --skel SKEL_DIR           use this alternative skeleton directory\n  -m, --create-home             create the user\'s home directory\n  -M, --no-create-home          do not create the user\'s home directory\n  -N, --no-user-group           do not create a group with the same name as\n                                the user\n  -o, --non-unique              allow to create users with duplicate\n                                (non-unique) UID\n  -p, --password PASSWORD       encrypted password of the new account\n  -r, --system                  create a system account\n  -s, --shell SHELL             login shell of the new account\n  -u, --uid UID                 user ID of the new account\n  -U, --user-group              create a group with the same name as the user\n\n';

  function useraddMain(ctx) {
    const g = K.getopt(ctx.args, { short: 'b:c:d:De:f:g:G:hk:K:lmMNop:rR:s:u:UZ:P:', long: ['badname', 'base-dir=', 'comment=', 'home-dir=', 'defaults', 'expiredate=', 'inactive=', 'gid=', 'groups=', 'help', 'skel=', 'key=', 'no-log-init', 'create-home', 'no-create-home', 'no-user-group', 'non-unique', 'password=', 'system', 'root=', 'shell=', 'uid=', 'user-group', 'prefix=', 'selinux-user=', 'extrausers'],
      alias: { 'base-dir': 'b', comment: 'c', 'home-dir': 'd', defaults: 'D', gid: 'g', groups: 'G', help: 'h', skel: 'k', 'create-home': 'm', 'no-create-home': 'M', 'no-user-group': 'N', 'non-unique': 'o', password: 'p', system: 'r', shell: 's', uid: 'u', 'user-group': 'U' } });
    if (g.err) { ctx.err('useradd: ' + g.err + '\n' + USERADD_USAGE); return 2; }
    const o = g.opts; const m = ctx.machine;
    if (o.h) { ctx.out(USERADD_USAGE); return 0; }
    if (o.D && !g.rest.length && Object.keys(o).length === 1) { ctx.out('GROUP=100\nHOME=/home\nINACTIVE=-1\nEXPIRE=\nSHELL=/bin/sh\nSKEL=/etc/skel\nCREATE_MAIL_SPOOL=no\n'); return 0; }
    if (g.rest.length !== 1) { ctx.err(USERADD_USAGE); return 2; }
    if (!ctx.isRoot) return permissionDenied(ctx, 'useradd');
    const name = g.rest[0];
    if (!o.badname && !NAME_RE.test(name)) { ctx.err("useradd: invalid user name '" + name + "': use --badname to ignore\n"); return 3; }
    if (m.userByName(name)) { ctx.err("useradd: user '" + name + "' already exists\n"); return 9; }
    let uid;
    if (o.u != null) {
      if (!/^\d+$/.test(String(o.u))) { ctx.err("useradd: invalid user ID '" + o.u + "'\n"); return 3; }
      uid = parseInt(o.u, 10);
      if (m.userByUid(uid) && !o.o) { ctx.err('useradd: UID ' + uid + ' is not unique\n'); return 4; }
    } else uid = o.r ? systemId(m, new Set(m.users.map((u) => u.uid))) : nextUid(m);
    let group = null;
    if (o.g != null) { group = gidOf(m, String(o.g)); if (!group) { ctx.err("useradd: group '" + o.g + "' does not exist\n"); return 6; } }
    const extra = [];
    for (const n of o.G ? String(o.G).split(',').filter(Boolean) : []) {
      const eg = gidOf(m, n);
      if (!eg) { ctx.err("useradd: group '" + n + "' does not exist\n"); return 6; }
      extra.push(eg.name);
    }
    if (!group && !o.N) {
      if (m.groupByName(name)) { ctx.err('useradd: group ' + name + ' exists - if you want to add this user to that group, use -g.\n'); return 9; }
      const gid = o.r ? uid : (m.groupByGid(uid) ? nextGid(m) : uid);
      group = { name, gid, members: [] };
      m.groups.push(group);
      authLog(ctx, 'useradd', 'new group: name=' + name + ', GID=' + gid);
    } else if (!group) group = m.groupByName('users');
    const home = o.d || (o.b || '/home') + '/' + name;
    const user = m.addUser({ name, uid, gid: group.gid, gecos: o.c || '', home, shell: o.s || '/bin/sh', groups: extra });
    if (o.p != null) m.passwords[name] = null;
    if (o.m && !o.M && !o.r) createHome(ctx, user, o.k || '/etc/skel');
    authLog(ctx, 'useradd', 'new user: name=' + name + ', UID=' + uid + ', GID=' + group.gid + ', home=' + home + ', shell=' + user.shell + ', from=' + (ctx.env.SSH_CONNECTION ? 'pts/0' : '/dev/pts/0'));
    return 0;
  }

  const USERMOD_USAGE = 'Usage: usermod [options] LOGIN\n\nOptions:\n  -a, --append                  append the user to the supplemental GROUPS\n                                mentioned by the -G option without removing\n                                the user from other groups\n  -c, --comment COMMENT         new value of the GECOS field\n  -d, --home HOME_DIR           new home directory for the user account\n  -e, --expiredate EXPIRE_DATE  set account expiration date to EXPIRE_DATE\n  -g, --gid GROUP               force use GROUP as new primary group\n  -G, --groups GROUPS           new list of supplementary GROUPS\n  -h, --help                    display this help message and exit\n  -l, --login NEW_LOGIN         new value of the login name\n  -L, --lock                    lock the user account\n  -m, --move-home               move contents of the home directory to the\n                                new location (use only with -d)\n  -o, --non-unique              allow using duplicate (non-unique) UID\n  -s, --shell SHELL             new login shell for the user account\n  -u, --uid UID                 new UID for the user account\n  -U, --unlock                  unlock the user account\n\n';

  function lockAccount(m, name) {
    const adm = adminState(m);
    if (adm.locked && adm.locked[name]) return;
    adm.locked = adm.locked || {};
    adm.locked[name] = { pw: m.passwords[name] == null ? null : m.passwords[name] };
    m.passwords[name] = null;
  }
  function unlockAccount(m, name) {
    const adm = adminState(m);
    const saved = adm.locked && adm.locked[name];
    if (!saved) return true;
    if (saved.pw == null) return false;
    m.passwords[name] = saved.pw; delete adm.locked[name];
    return true;
  }
  const isLocked = (m, name) => !!(adminState(m).locked && adminState(m).locked[name]);
  const busyProc = (m, name) => m.procs.find((p) => p.user === name && p.pid > 1);

  function usermodMain(ctx) {
    const g = K.getopt(ctx.args, { short: 'ac:d:e:f:g:G:hl:Lmop:s:u:U', long: ['append', 'comment=', 'home=', 'expiredate=', 'inactive=', 'gid=', 'groups=', 'help', 'login=', 'lock', 'move-home', 'non-unique', 'password=', 'shell=', 'uid=', 'unlock'],
      alias: { append: 'a', comment: 'c', home: 'd', gid: 'g', groups: 'G', help: 'h', login: 'l', lock: 'L', 'move-home': 'm', 'non-unique': 'o', shell: 's', uid: 'u', unlock: 'U' } });
    if (g.err) { ctx.err('usermod: ' + g.err + '\n' + USERMOD_USAGE); return 2; }
    const o = g.opts; const m = ctx.machine;
    if (o.h) { ctx.out(USERMOD_USAGE); return 0; }
    if (g.rest.length !== 1) { ctx.err(USERMOD_USAGE); return 2; }
    if (o.a && o.G == null) { ctx.err('usermod: option -a requires option -G\n'); return 2; }
    if (o.L && o.U) { ctx.err('usermod: the options -L and -U are incompatible\n'); return 2; }
    if (!ctx.isRoot) return permissionDenied(ctx, 'usermod');
    const name = g.rest[0]; const user = m.userByName(name);
    if (!user) { ctx.err("usermod: user '" + name + "' does not exist\n"); return 6; }
    const touching = o.l != null || o.u != null || (o.d != null && o.m);
    if (touching) { const p = busyProc(m, name); if (p) { ctx.err('usermod: user ' + name + ' is currently used by process ' + p.pid + '\n'); return 8; } }
    if (o.l != null) {
      if (!NAME_RE.test(o.l)) { ctx.err("usermod: invalid user name '" + o.l + "'\n"); return 3; }
      if (m.userByName(o.l)) { ctx.err("usermod: user '" + o.l + "' already exists\n"); return 9; }
    }
    if (o.u != null) {
      if (!/^\d+$/.test(String(o.u))) { ctx.err("usermod: invalid user ID '" + o.u + "'\n"); return 3; }
      if (m.userByUid(parseInt(o.u, 10)) && !o.o) { ctx.err('usermod: UID \'' + o.u + '\' already exists\n'); return 4; }
    }
    let primary = null;
    if (o.g != null) { primary = gidOf(m, String(o.g)); if (!primary) { ctx.err("usermod: group '" + o.g + "' does not exist\n"); return 6; } }
    let wanted = null;
    if (o.G != null) {
      wanted = [];
      for (const n of String(o.G).split(',').filter(Boolean)) {
        const gr = gidOf(m, n);
        if (!gr) { ctx.err("usermod: group '" + n + "' does not exist\n"); return 6; }
        wanted.push(gr);
      }
    }
    if (wanted) {
      if (!o.a) for (const gr of m.groups) gr.members = gr.members.filter((x) => x !== name);
      for (const gr of wanted) if (!gr.members.includes(name)) gr.members.push(name);
    }
    if (primary) user.gid = primary.gid;
    if (o.c != null) user.gecos = o.c === true ? '' : o.c;
    if (o.s != null) user.shell = o.s === true ? '' : o.s;
    if (o.u != null) user.uid = parseInt(o.u, 10);
    if (o.d != null) {
      if (o.m && ctx.vfs.exists(user.home)) { ctx.vfs.rename(user.home, o.d); }
      user.home = o.d;
    }
    if (o.L) lockAccount(m, name);
    if (o.U && !unlockAccount(m, name)) { ctx.err('usermod: unlocking the user\'s password would result in a passwordless account.\nYou should set a password with usermod -p to unlock this user\'s password.\n'); return 1; }
    if (o.l != null) {
      for (const gr of m.groups) gr.members = gr.members.map((x) => (x === name ? o.l : x));
      if (name in m.passwords) { m.passwords[o.l] = m.passwords[name]; delete m.passwords[name]; }
      user.name = o.l;
    }
    authLog(ctx, 'usermod', 'change user name \'' + name + '\' to \'' + user.name + '\'');
    return 0;
  }

  function userdelMain(ctx) {
    const g = K.getopt(ctx.args, { short: 'fhrRZ:', long: ['force', 'help', 'remove', 'root=', 'selinux-user'], alias: { force: 'f', help: 'h', remove: 'r' } });
    const usage = 'Usage: userdel [options] LOGIN\n\nOptions:\n  -f, --force                   force some actions that would fail otherwise\n                                e.g. removal of user still logged in\n                                or files, even if not owned by the user\n  -h, --help                    display this help message and exit\n  -r, --remove                  remove home directory and mail spool\n\n';
    if (g.err) { ctx.err('userdel: ' + g.err + '\n' + usage); return 2; }
    if (g.opts.h) { ctx.out(usage); return 0; }
    if (g.rest.length !== 1) { ctx.err(usage); return 2; }
    if (!ctx.isRoot) return permissionDenied(ctx, 'userdel');
    const m = ctx.machine; const name = g.rest[0]; const user = m.userByName(name);
    if (!user) { ctx.err("userdel: user '" + name + "' does not exist\n"); return 6; }
    const p = busyProc(m, name);
    if (p && !g.opts.f) { ctx.err('userdel: user ' + name + ' is currently used by process ' + p.pid + '\n'); return 8; }
    m.users = m.users.filter((u) => u !== user);
    for (const gr of m.groups) gr.members = gr.members.filter((x) => x !== name);
    const own = m.groupByGid(user.gid);
    if (own && own.name === name && !m.users.some((u) => u.gid === own.gid)) { m.groups = m.groups.filter((x) => x !== own); authLog(ctx, 'userdel', 'removed group \'' + name + '\' owned by \'' + name + '\''); }
    delete m.passwords[name];
    const adm = adminState(m); if (adm.locked) delete adm.locked[name];
    delete m.sudoStamp[name];
    try { m.vfs.unlink('/var/spool/cron/crontabs/' + name); } catch (e) { /* no crontab */ }
    if (g.opts.r) {
      if (m.vfs.exists(user.home)) m.vfs.rmTree(user.home);
      else ctx.err('userdel: ' + name + ' home directory (' + user.home + ') not found\n');
      if (m.vfs.exists('/var/mail/' + name)) m.vfs.unlink('/var/mail/' + name);
      else ctx.err('userdel: ' + name + ' mail spool (/var/mail/' + name + ') not found\n');
    }
    authLog(ctx, 'userdel', "delete user '" + name + "'");
    return 0;
  }

  function groupaddMain(ctx) {
    const g = K.getopt(ctx.args, { short: 'fg:hK:op:rR:P:U:', long: ['force', 'gid=', 'help', 'key=', 'non-unique', 'password=', 'system', 'root=', 'prefix='], alias: { force: 'f', gid: 'g', help: 'h', 'non-unique': 'o', password: 'p', system: 'r' } });
    const usage = 'Usage: groupadd [options] GROUP\n\nOptions:\n  -f, --force                   exit successfully if the group already exists,\n                                and cancel -g if the GID is already used\n  -g, --gid GID                 use GID for the new group\n  -h, --help                    display this help message and exit\n  -o, --non-unique              allow to create groups with duplicate\n                                (non-unique) GID\n  -p, --password PASSWORD       use this encrypted password for the new group\n  -r, --system                  create a system account\n\n';
    if (g.err) { ctx.err('groupadd: ' + g.err + '\n' + usage); return 2; }
    if (g.opts.h) { ctx.out(usage); return 0; }
    if (g.rest.length !== 1) { ctx.err(usage); return 2; }
    if (!ctx.isRoot) return permissionDenied(ctx, 'groupadd', '/etc/group');
    const m = ctx.machine; const name = g.rest[0]; const o = g.opts;
    if (!NAME_RE.test(name)) { ctx.err("groupadd: '" + name + "' is not a valid group name\n"); return 3; }
    if (m.groupByName(name)) { if (o.f) return 0; ctx.err("groupadd: group '" + name + "' already exists\n"); return 9; }
    let gid;
    if (o.g != null) {
      if (!/^\d+$/.test(String(o.g))) { ctx.err("groupadd: invalid group ID '" + o.g + "'\n"); return 3; }
      gid = parseInt(o.g, 10);
      if (m.groupByGid(gid) && !o.o) { if (o.f) gid = o.r ? systemId(m, new Set(m.groups.map((x) => x.gid))) : nextGid(m); else { ctx.err("groupadd: GID '" + gid + "' already exists\n"); return 4; } }
    } else gid = o.r ? systemId(m, new Set(m.groups.map((x) => x.gid))) : nextGid(m);
    m.groups.push({ name, gid, members: [] });
    authLog(ctx, 'groupadd', 'new group: name=' + name + ', GID=' + gid);
    return 0;
  }

  function groupdelMain(ctx) {
    const g = K.getopt(ctx.args, { short: 'fhR:P:', long: ['force', 'help', 'root=', 'prefix='], alias: { force: 'f', help: 'h' } });
    const usage = 'Usage: groupdel [options] GROUP\n\nOptions:\n  -f, --force                   delete group even if it is the primary group of a user\n  -h, --help                    display this help message and exit\n\n';
    if (g.err) { ctx.err('groupdel: ' + g.err + '\n' + usage); return 2; }
    if (g.opts.h) { ctx.out(usage); return 0; }
    if (g.rest.length !== 1) { ctx.err(usage); return 2; }
    if (!ctx.isRoot) return permissionDenied(ctx, 'groupdel', '/etc/group');
    const m = ctx.machine; const name = g.rest[0]; const group = m.groupByName(name);
    if (!group) { ctx.err("groupdel: group '" + name + "' does not exist\n"); return 6; }
    const owner = m.users.find((u) => u.gid === group.gid);
    if (owner && !g.opts.f) { ctx.err("groupdel: cannot remove the primary group of user '" + owner.name + "'\n"); return 8; }
    m.groups = m.groups.filter((x) => x !== group);
    authLog(ctx, 'groupdel', "group '" + name + "' removed");
    return 0;
  }

  /* ---- passwords ---- */

  function weakPassword(pw, user) {
    if (pw.length < 4) return 'it is WAY too short';
    if (pw.length < 6) return 'it is too short';
    if (/^(.)\1*$/.test(pw)) return 'it does not contain enough DIFFERENT characters';
    if (pw === user) return 'it is based on your username';
    return null;
  }

  /**
   * Ask twice for a new password, applying the quality check to non-root callers.
   * Returns the password, or null after printing the failure like passwd does.
   */
  async function askNewPassword(ctx, prog, target, root) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const first = await ctx.readLine('New password: ', { hidden: true });
      if (first == null) { ctx.err(prog + ': Authentication token manipulation error\n' + prog + ': password unchanged\n'); return null; }
      if (first === '') { ctx.err('No password has been supplied.\n'); continue; }
      const weak = weakPassword(first, target);
      if (weak) {
        ctx.err('BAD PASSWORD: ' + weak + '\n');
        if (!root) continue;
      }
      const second = await ctx.readLine('Retype new password: ', { hidden: true });
      if (second !== first) { ctx.err('Sorry, passwords do not match.\n' + prog + ': Authentication token manipulation error\n' + prog + ': password unchanged\n'); return null; }
      return first;
    }
    ctx.err(prog + ': Have exhausted maximum number of retries for service\n' + prog + ': password unchanged\n');
    return null;
  }

  function setPassword(ctx, name, pw) {
    const m = ctx.machine; const adm = adminState(m);
    m.passwords[name] = pw;
    if (adm.locked) delete adm.locked[name];
    adm.pwChanged = adm.pwChanged || {};
    adm.pwChanged[name] = U.isoDate(K.clock.now()).slice(0, 10);
    authLog(ctx, 'passwd', 'pam_unix(passwd:chauthtok): password changed for ' + name);
  }

  async function passwdMain(ctx) {
    const g = K.getopt(ctx.args, { short: 'adehlnqrSuwxi:', long: ['all', 'delete', 'expire', 'help', 'lock', 'unlock', 'status', 'quiet', 'keep-tokens', 'repository=', 'root=', 'mindays=', 'maxdays=', 'warndays=', 'inactive=', 'stdin'],
      alias: { delete: 'd', expire: 'e', help: 'h', lock: 'l', unlock: 'u', status: 'S', quiet: 'q' } });
    const usage = 'Usage: passwd [options] [LOGIN]\n\nOptions:\n  -a, --all                     report password status on all accounts\n  -d, --delete                  delete the password for the named account\n  -e, --expire                  force expire the password for the named account\n  -h, --help                    display this help message and exit\n  -k, --keep-tokens             change password only if expired\n  -i, --inactive INACTIVE       set password inactive after expiration\n                                to INACTIVE\n  -l, --lock                    lock the password of the named account\n  -n, --mindays MIN_DAYS        set minimum number of days before password\n                                change to MIN_DAYS\n  -q, --quiet                   quiet mode\n  -r, --repository REPOSITORY   change password in REPOSITORY repository\n  -R, --root CHROOT_DIR         directory to chroot into\n  -S, --status                  report password status on the named account\n  -u, --unlock                  unlock the password of the named account\n  -w, --warndays WARN_DAYS      set expiration warning days to WARN_DAYS\n  -x, --maxdays MAX_DAYS        set maximum number of days before password\n                                change to MAX_DAYS\n\n';
    if (g.err) { ctx.err('passwd: ' + g.err + '\n' + usage); return 2; }
    if (g.opts.h) { ctx.out(usage); return 0; }
    const m = ctx.machine; const o = g.opts;
    const name = g.rest[0] || ctx.user.name;
    const user = m.userByName(name);
    if (!user) { ctx.err("passwd: user '" + name + "' does not exist\n"); return 1; }
    if (!ctx.isRoot && name !== ctx.user.name) { ctx.err('passwd: You may not view or modify password information for ' + name + '.\n'); return 1; }
    const adm = adminState(m);
    if (o.S) {
      const pw = m.passwords[name];
      const state = pw === '' ? 'NP' : pw == null ? 'L' : 'P';
      const stamp = (adm.pwChanged && adm.pwChanged[name]) || '2026-10-26';
      ctx.out(name + ' ' + state + ' ' + stamp + ' 0 99999 7 -1\n');
      return 0;
    }
    if (o.l || o.u || o.d || o.e) {
      if (!ctx.isRoot) { ctx.err('passwd: Permission denied.\n'); return 1; }
      if (o.l) lockAccount(m, name);
      else if (o.u && !unlockAccount(m, name)) { ctx.err('passwd: unlocking the password would result in a passwordless account.\nYou should set a password with usermod -p to unlock the password of this account.\n'); return 3; }
      if (o.d) { m.passwords[name] = ''; }
      ctx.out('passwd: password expiry information changed.\n');
      return 0;
    }
    if (!ctx.isRoot || name === ctx.user.name) ctx.out('Changing password for ' + name + '.\n');
    if (!ctx.isRoot) {
      const cur = await ctx.readLine('Current password: ', { hidden: true });
      if (cur == null || !m.checkPassword(name, cur)) { await sleep(ctx, 1500); ctx.err('passwd: Authentication token manipulation error\npasswd: password unchanged\n'); return 10; }
    }
    const pw = await askNewPassword(ctx, 'passwd', name, ctx.isRoot);
    if (pw == null) return 10;
    setPassword(ctx, name, pw);
    ctx.out('passwd: password updated successfully\n');
    return 0;
  }

  /* ---- chsh ---- */

  async function chshMain(ctx) {
    const g = K.getopt(ctx.args, { short: 'ls:uvhR:', long: ['list-shells', 'shell=', 'help', 'version', 'root='], alias: { 'list-shells': 'l', shell: 's', help: 'h', version: 'v' } });
    if (g.err) { ctx.err('chsh: ' + g.err + "\nTry 'chsh --help' for more information.\n"); return 1; }
    const m = ctx.machine; const o = g.opts;
    if (o.h) { ctx.out('\nUsage:\n chsh [options] [<username>]\n\nChange your login shell.\n\nOptions:\n -s, --shell <shell>  specify login shell\n -l, --list-shells    print list of shells and exit\n -u, --help           display this help\n -v, --version        display version\n'); return 0; }
    if (o.v) { ctx.out('chsh from util-linux 2.41.2\n'); return 0; }
    const shells = ctx.fs.read('/etc/shells').split('\n').filter((l) => l && l[0] !== '#');
    if (o.l) { ctx.out(shells.join('\n') + '\n'); return 0; }
    const name = g.rest[0] || ctx.user.name;
    const user = m.userByName(name);
    if (!user) { ctx.err("chsh: user '" + name + "' does not exist\n"); return 1; }
    if (!ctx.isRoot && name !== ctx.user.name) { ctx.err("chsh: running UID doesn't match UID of user we're asking to change\n"); return 1; }
    let shell = o.s;
    if (shell == null || shell === true) {
      ctx.out('Changing the login shell for ' + name + '\nEnter the new value, or press ENTER for the default\n');
      const ans = await ctx.readLine('\tLogin Shell [' + user.shell + ']: ');
      shell = ans ? ans : user.shell;
    }
    if (!ctx.isRoot) {
      const pw = await ctx.readLine('Password: ', { hidden: true });
      if (pw == null || !m.checkPassword(name, pw)) { ctx.err('chsh: PAM: Authentication failure\n'); return 1; }
    }
    if (shell[0] !== '/') { ctx.err('chsh: Shell not changed.\n'); return 1; }
    if (!ctx.isRoot && !shells.includes(shell)) { ctx.err('chsh: "' + shell + '" is not listed in /etc/shells.\nUse chsh -l to see list.\n'); return 1; }
    if (!ctx.vfs.exists(shell)) { ctx.err('chsh: "' + shell + '" is not executable.\n'); return 1; }
    if (shell === user.shell) { ctx.out('Shell not changed.\n'); return 0; }
    user.shell = shell;
    return 0;
  }

  /* ---- adduser ---- */

  async function adduserMain(ctx) {
    const g = K.getopt(ctx.args, { short: 'qvh', long: ['disabled-password', 'disabled-login', 'gecos=', 'comment=', 'home=', 'shell=', 'uid=', 'gid=', 'ingroup=', 'group', 'system', 'no-create-home', 'quiet', 'verbose', 'add-extra-groups', 'allow-bad-names', 'firstuid=', 'lastuid=', 'conf=', 'help', 'version'], alias: { quiet: 'q', verbose: 'v', help: 'h' } });
    const usage = 'adduser [--uid id] [--firstuid id] [--lastuid id]\n        [--gid id] [--ingroup group] [--add-extra-groups]\n        [--shell shell] [--comment comment] [--home dir] [--no-create-home]\n        [--allow-all-names] [--disabled-password]\n        [--disabled-login] [--add_extra_groups]\n        [--encrypt-home] user\n   Add a normal user\n\nadduser --system\n        [--uid id] [--group] [--ingroup group] [--gid id]\n        [--shell shell] [--comment comment] [--home dir] [--no-create-home]\n        [--conf file] [--quiet] [--debug] user\n   Add a system user\n\nadduser --group\n        [--gid ID] [--conf FILE] [--quiet] [--debug] group\naddgroup\n        [--gid ID] [--conf FILE] [--quiet] [--debug] group\n   Add a user group\n\nadduser USER GROUP\n   Add an existing user to an existing group\n';
    if (g.err) { ctx.err('adduser: ' + g.err + '\n'); return 1; }
    if (g.opts.h) { ctx.out(usage); return 0; }
    if (g.opts.version) { ctx.out('adduser version 3.152\n'); return 0; }
    const m = ctx.machine; const o = g.opts; const info = (s) => { if (!o.q) ctx.out('info: ' + s + '\n'); };
    if (!ctx.isRoot) { ctx.err('adduser: Only root may add a user or group to the system.\n'); return 1; }
    if (!g.rest.length || g.rest.length > 2) { ctx.err('fatal: Only one or two names allowed.\n'); return 1; }
    if (g.rest.length === 2) {
      const [uname, gname] = g.rest;
      if (!m.userByName(uname)) { ctx.err("fatal: The user `" + uname + "' does not exist.\n"); return 1; }
      const group = m.groupByName(gname);
      if (!group) { ctx.err("fatal: The group `" + gname + "' does not exist.\n"); return 1; }
      if (group.members.includes(uname)) { ctx.out('The user `' + uname + "' is already a member of `" + gname + "'.\n"); return 0; }
      info("Adding user `" + uname + "' to group `" + gname + "' ...");
      group.members.push(uname);
      return 0;
    }
    const name = g.rest[0];
    if (o.group && !o.system) {
      if (m.groupByName(name)) { ctx.err("fatal: The group `" + name + "' already exists.\n"); return 1; }
      const gid = o.gid != null ? parseInt(o.gid, 10) : nextGid(m);
      info("Adding group `" + name + "' (GID " + gid + ") ...");
      m.groups.push({ name, gid, members: [] });
      authLog(ctx, 'groupadd', 'new group: name=' + name + ', GID=' + gid);
      info('Done.');
      return 0;
    }
    if (!o['allow-bad-names'] && !NAME_RE.test(name)) {
      ctx.err("fatal: Please enter a username matching the regular expression configured\nvia the NAME_REGEX configuration variable.  Use the `--allow-bad-names'\noption to relax this check or reconfigure NAME_REGEX in configuration.\n");
      return 1;
    }
    if (m.userByName(name)) { ctx.err("fatal: The user `" + name + "' already exists.\n"); return 1; }
    if (m.groupByName(name) && !o.ingroup && !o.gid) { ctx.err("fatal: The group `" + name + "' already exists and is not a system group. Exiting.\n"); return 1; }
    const sys = !!o.system;
    info("Adding " + (sys ? 'system ' : '') + "user `" + name + "' ...");
    const uid = o.uid != null ? parseInt(o.uid, 10) : sys ? systemId(m, new Set(m.users.map((u) => u.uid))) : nextUid(m);
    if (m.userByUid(uid)) { ctx.err("fatal: The UID " + uid + ' is already in use.\n'); return 1; }
    if (o.uid == null) info('Selecting UID/GID from range ' + (sys ? '100 to 999' : LOGIN_UID_MIN + ' to ' + LOGIN_UID_MAX) + ' ...');
    let group;
    if (o.ingroup) {
      group = m.groupByName(o.ingroup);
      if (!group) { ctx.err("fatal: The group `" + o.ingroup + "' does not exist.\n"); return 1; }
    } else {
      const gid = o.gid != null ? parseInt(o.gid, 10) : (m.groupByGid(uid) ? nextGid(m) : uid);
      group = m.groupByGid(gid);
      if (!group) { group = { name, gid, members: [] }; info("Adding new group `" + name + "' (" + gid + ') ...'); m.groups.push(group); authLog(ctx, 'groupadd', 'new group: name=' + name + ', GID=' + gid); }
    }
    const home = o.home || '/home/' + name;
    const gecos = typeof (o.gecos || o.comment) === 'string' ? (o.gecos || o.comment) : '';
    const user = m.addUser({ name, uid, gid: group.gid, gecos, home, shell: o.shell || (sys ? '/usr/sbin/nologin' : '/bin/bash') });
    info("Adding new user `" + name + "' (" + uid + ") with group `" + group.name + ' (' + group.gid + ")' ...");
    if (!o['no-create-home'] && !(sys && o.home == null)) {
      info("Creating home directory `" + home + "' ...");
      info("Copying files from `/etc/skel' ...");
      ctx.vfs.seedDir(home, { mode: 0o700, uid, gid: group.gid, mtime: K.clock.now() });
      if (!sys && ctx.vfs.exists('/etc/skel')) copyTree(ctx.vfs, '/etc/skel', home, uid, group.gid);
    } else user.home = sys ? '/nonexistent' : home;
    authLog(ctx, 'useradd', 'new user: name=' + name + ', UID=' + uid + ', GID=' + group.gid + ', home=' + user.home + ', shell=' + user.shell + ', from=/dev/pts/0');
    if (o['disabled-password'] || o['disabled-login'] || sys) {
      if (o['disabled-login'] || sys) m.passwords[name] = null;
      if (o.gecos == null && o.comment == null && !sys) await askUserInfo(ctx, user);
      return 0;
    }
    for (;;) {
      const pw = await askNewPassword(ctx, 'passwd', name, true);
      if (pw != null) { setPassword(ctx, name, pw); ctx.out('passwd: password updated successfully\n'); break; }
      const again = await ctx.readLine('Try again? [y/N] ');
      if (!again || !/^y/i.test(again)) { ctx.err("fatal: `/usr/bin/passwd " + name + "' returned error code 10. Exiting.\n"); return 1; }
    }
    if (o.gecos == null && o.comment == null) await askUserInfo(ctx, user);
    return 0;
  }

  async function askUserInfo(ctx, user) {
    ctx.out('Changing the user information for ' + user.name + '\nEnter the new value, or press ENTER for the default\n');
    const fields = [];
    for (const f of ['Full Name', 'Room Number', 'Work Phone', 'Home Phone', 'Other']) {
      const v = await ctx.readLine('\t' + f + ' []: ');
      fields.push(v == null ? '' : v);
    }
    const ok = await ctx.readLine('Is the information correct? [Y/n] ');
    if (ok == null || /^(|y|yes)$/i.test(ok.trim())) user.gecos = fields.join(',');
  }

  /* ---- getent ---- */

  function passwdLine(u) { return [u.name, 'x', u.uid, u.gid, u.gecos, u.home, u.shell].join(':'); }
  function groupLine(gr) { return [gr.name, 'x', gr.gid, gr.members.join(',')].join(':'); }

  /** Entries of /etc/services or /etc/protocols as {name, num, proto, aliases}. */
  function parseDb(text, kind) {
    const out = [];
    for (const raw of text.split('\n')) {
      const line = raw.replace(/#.*/, '').trim();
      if (!line) continue;
      const f = line.split(/\s+/);
      if (kind === 'services') { const [port, proto] = f[1].split('/'); out.push({ name: f[0], port: parseInt(port, 10), proto, aliases: f.slice(2) }); }
      else out.push({ name: f[0], num: parseInt(f[1], 10), aliases: f.slice(2) });
    }
    return out;
  }

  function getentMain(ctx) {
    const hint = "Try `getent --help' or `getent --usage' for more information.\n";
    const args = ctx.args.slice();
    if (args[0] === '--help' || args[0] === '-?') { ctx.out('Usage: getent [OPTION...] database [key ...]\nGet entries from administrative database.\n\n  -s, --service=CONFIG       Service configuration to be used\n  -i, --no-idn               Disable IDN encoding\n  -?, --help                 Give this help list\n      --usage                Give a short usage message\n  -V, --version              Print program version\n'); return 0; }
    for (const a of args) if (a.startsWith('--') && !['--service', '--no-idn', '--help', '--usage', '--version'].some((o) => a.startsWith(o))) { ctx.err("getent: unrecognized option '" + a + "'\n" + hint); return 64; }
    const pos = args.filter((a) => !a.startsWith('-'));
    if (!pos.length) { ctx.err('getent: wrong number of arguments\n' + hint); return 1; }
    const db = pos[0]; const keys = pos.slice(1); const m = ctx.machine;
    const pad = (s, n) => U.padEnd(s, n);
    const lookups = {
      passwd: { all: () => m.users.map(passwdLine), find: (k) => { const u = m.userByName(k) || (/^\d+$/.test(k) ? m.userByUid(parseInt(k, 10)) : null); return u ? [passwdLine(u)] : []; } },
      group: { all: () => m.groups.map(groupLine), find: (k) => { const x = m.groupByName(k) || (/^\d+$/.test(k) ? m.groupByGid(parseInt(k, 10)) : null); return x ? [groupLine(x)] : []; } },
      shadow: { all: () => (ctx.isRoot ? ctx.fs.read('/etc/shadow').split('\n').filter(Boolean) : []), find: (k) => (ctx.isRoot ? ctx.fs.read('/etc/shadow').split('\n').filter((l) => l.startsWith(k + ':')) : []) },
      hosts: {
        all: () => ctx.fs.read('/etc/hosts').split('\n').filter((l) => l && l[0] !== '#' && /^[0-9]/.test(l)).map((l) => { const f = l.split(/\s+/); return pad(f[0], 15) + ' ' + f.slice(1).join(' '); }),
        find: (k) => {
          const file = ctx.fs.read('/etc/hosts').split('\n').map((l) => l.replace(/#.*/, '').trim().split(/\s+/)).filter((f) => f.length > 1 && (f[0] === k || f.slice(1).includes(k)));
          if (file.length) return [pad(file[0][0], 15) + ' ' + file[0].slice(1).join(' ')];
          if (U.isIPv4(k)) { const n = K.net.reverse(m, k); return n ? [pad(k, 15) + ' ' + n] : []; }
          const r = K.net.resolve(m, k);
          return r ? [pad(r.ip, 15) + ' ' + (r.name || k)] : [];
        },
      },
      services: {
        all: () => parseDb(ctx.fs.read('/etc/services'), 'services').map(svcLine),
        find: (k) => { const [a, b] = k.split('/'); return parseDb(ctx.fs.read('/etc/services'), 'services').filter((s) => (b ? (s.name === a || String(s.port) === a) && s.proto === b : s.name === k || s.aliases.includes(k) || String(s.port) === k)).slice(0, 1).map(svcLine); },
      },
      protocols: {
        all: () => parseDb(ctx.fs.read('/etc/protocols'), 'protocols').map(protoLine),
        find: (k) => parseDb(ctx.fs.read('/etc/protocols'), 'protocols').filter((p) => p.name === k || String(p.num) === k || p.aliases.includes(k)).map(protoLine),
      },
    };
    function svcLine(s) { return pad(s.name, 21) + ' ' + s.port + '/' + s.proto + (s.aliases.length ? ' ' + s.aliases.join(' ') : ''); }
    function protoLine(p) { return pad(p.name, 21) + ' ' + p.num + (p.aliases.length ? ' ' + p.aliases.join(' ') : ''); }
    const impl = lookups[db];
    if (!impl) { ctx.err('Unknown database: ' + db + '\n' + hint); return 1; }
    if (!keys.length) { const all = impl.all(); ctx.out(all.length ? all.join('\n') + '\n' : ''); return 0; }
    let status = 0;
    for (const k of keys) { const found = impl.find(k); if (!found.length) status = 2; else ctx.out(found.join('\n') + '\n'); }
    return status;
  }

  const reg = (def) => K.cmd.register(def);
  reg({ name: 'useradd', pkg: 'passwd', path: '/usr/sbin/useradd', section: 8, summary: 'create a new user or update default new user information', synopsis: 'useradd [options] LOGIN',
    man: 'DESCRIPTION\n       useradd creates a new user account using the values given on the command line plus the defaults of the system. Needs root.\n\nOPTIONS\n       -m, --create-home   create the home directory from /etc/skel\n       -s, --shell SHELL   login shell\n       -G, --groups GROUPS supplementary groups\n       -g, --gid GROUP     primary group\n       -u, --uid UID       numeric user ID\n       -c, --comment TEXT  GECOS field\n       -d, --home-dir DIR  home directory\n\nEXAMPLES\n       sudo useradd -m -s /bin/bash -G sudo analyst',
    run: async (ctx) => useraddMain(ctx) });
  reg({ name: 'usermod', pkg: 'passwd', path: '/usr/sbin/usermod', section: 8, summary: 'modify a user account', synopsis: 'usermod [options] LOGIN',
    man: 'DESCRIPTION\n       usermod modifies the system account files to reflect the changes that are specified on the command line. Needs root.\n\nOPTIONS\n       -a -G GROUPS   append the user to supplementary groups\n       -G GROUPS      set the supplementary groups\n       -s SHELL       new login shell\n       -L, -U         lock or unlock the password\n       -l NEW_LOGIN   rename the account\n\nEXAMPLES\n       sudo usermod -aG wireshark kali',
    run: async (ctx) => usermodMain(ctx) });
  reg({ name: 'userdel', pkg: 'passwd', path: '/usr/sbin/userdel', section: 8, summary: 'delete a user account and related files', synopsis: 'userdel [options] LOGIN',
    man: 'DESCRIPTION\n       userdel modifies the system account files, deleting all entries that refer to the user name LOGIN. Needs root.\n\nOPTIONS\n       -r, --remove   remove the home directory and mail spool\n       -f, --force    force removal\n\nEXAMPLES\n       sudo userdel -r analyst',
    run: async (ctx) => userdelMain(ctx) });
  reg({ name: 'groupadd', pkg: 'passwd', path: '/usr/sbin/groupadd', section: 8, summary: 'create a new group', synopsis: 'groupadd [options] GROUP',
    man: 'DESCRIPTION\n       groupadd creates a new group account. Needs root.\n\nOPTIONS\n       -g, --gid GID   numeric group ID\n       -r, --system    create a system group\n       -f, --force     succeed if the group already exists\n\nEXAMPLES\n       sudo groupadd pentest',
    run: async (ctx) => groupaddMain(ctx) });
  reg({ name: 'groupdel', pkg: 'passwd', path: '/usr/sbin/groupdel', section: 8, summary: 'delete a group', synopsis: 'groupdel [options] GROUP',
    man: 'DESCRIPTION\n       groupdel modifies the system account files, deleting all entries that refer to GROUP. Needs root.\n\nEXAMPLES\n       sudo groupdel pentest',
    run: async (ctx) => groupdelMain(ctx) });
  reg({ name: 'passwd', pkg: 'passwd', section: 1, mode: 0o4755, summary: 'change user password', synopsis: 'passwd [options] [LOGIN]',
    man: 'DESCRIPTION\n       The passwd command changes passwords for user accounts. A normal user can only change the password of their own account and must give the current one; root can change any account.\n\nOPTIONS\n       -l, --lock     lock the password (root)\n       -u, --unlock   unlock the password (root)\n       -S, --status   report password status\n\nEXAMPLES\n       passwd\n       sudo passwd analyst',
    run: passwdMain });
  reg({ name: 'chsh', pkg: 'passwd', section: 1, mode: 0o4755, summary: 'change login shell', synopsis: 'chsh [options] [LOGIN]',
    man: 'DESCRIPTION\n       chsh changes the user login shell, which must be listed in /etc/shells unless run by root.\n\nOPTIONS\n       -s, --shell SHELL   specify the login shell\n       -l, --list-shells   print the list of shells\n\nEXAMPLES\n       chsh -s /bin/bash',
    run: chshMain });
  reg({ name: 'adduser', aliases: ['addgroup'], pkg: 'adduser', path: '/usr/sbin/adduser', section: 8, summary: 'add a user or group to the system', synopsis: 'adduser [options] user',
    man: 'DESCRIPTION\n       adduser and addgroup add users and groups to the system according to command line options and configuration information. The interactive flow asks for a password and the GECOS fields.\n\nOPTIONS\n       --disabled-password   do not set a password\n       --gecos TEXT          GECOS field, no questions asked\n       --ingroup GROUP       primary group\n       --system              create a system user\n       adduser USER GROUP    add an existing user to a group\n\nEXAMPLES\n       sudo adduser analyst\n       sudo adduser analyst sudo',
    run: adduserMain });
  reg({ name: 'getent', pkg: 'libc-bin', path: '/usr/bin/getent', section: 1, summary: 'get entries from Name Service Switch libraries', synopsis: 'getent [option]... database key...',
    man: 'DESCRIPTION\n       The getent command displays entries from databases supported by the Name Service Switch libraries.\n\nDATABASES\n       passwd, group, shadow, hosts, services, protocols\n\nEXAMPLES\n       getent passwd kali\n       getent hosts web01.halcyon.lab\n       getent services ssh',
    run: async (ctx) => getentMain(ctx) });

  /* ============================================== system information */

  const kv = (rows, width) => rows.map(([k, v]) => U.padEnd(k + ':', width) + v).join('\n') + '\n';
  const unknownOption = (ctx, prog, err, tail) => { ctx.err(prog + ': ' + err + '\n' + tail); return 1; };
  const COREUTILS_VERSION = '9.7';
  const coreutilsVersion = (name, author) => name + ' (GNU coreutils) ' + COREUTILS_VERSION + '\nCopyright (C) 2025 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by ' + author + '.\n';
  const coreutilsFooter = (name) => '\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/' + name + '>\nor available locally via: info \'(coreutils) ' + name + ' invocation\'\n';
  const tryHelp = (name) => "Try '" + name + " --help' for more information.\n";

  function cpuInfo(ctx) {
    const text = ctx.fs.read('/proc/cpuinfo');
    const blocks = text.split('\n\n').filter(Boolean);
    const field = (k) => { const m = new RegExp('^' + k + '\\s*:\\s*(.*)$', 'm').exec(blocks[0]); return m ? m[1] : ''; };
    return { n: blocks.length, model: field('model name'), family: field('cpu family'), modelNo: field('model'), stepping: field('stepping'), bogo: field('bogomips'), flags: field('flags'), vendor: field('vendor_id'), cores: parseInt(field('cpu cores'), 10) || blocks.length, addr: field('address sizes') };
  }

  const VULNS = [['Gather data sampling', 'Unknown: Dependent on hypervisor status'], ['Indirect target selection', 'Not affected'], ['Itlb multihit', 'KVM: Mitigation: VMX unsupported'], ['L1tf', 'Mitigation; PTE Inversion'],
    ['Mds', 'Mitigation; Clear CPU buffers; SMT Host state unknown'], ['Meltdown', 'Mitigation; PTI'], ['Mmio stale data', 'Mitigation; Clear CPU buffers; SMT Host state unknown'], ['Reg file data sampling', 'Not affected'],
    ['Retbleed', 'Mitigation; IBRS'], ['Spec rstack overflow', 'Not affected'], ['Spec store bypass', 'Mitigation; Speculative Store Bypass disabled via prctl'],
    ['Spectre v1', 'Mitigation; usercopy/swapgs barriers and __user pointer sanitization'], ['Spectre v2', 'Mitigation; IBRS; IBPB conditional; STIBP disabled; RSB filling; PBRSB-eIBRS Not affected; BHI SW loop, KVM SW loop'],
    ['Srbds', 'Unknown: Dependent on hypervisor status'], ['Tsa', 'Not affected'], ['Tsx async abort', 'Not affected']];

  reg({ name: 'lscpu', pkg: 'util-linux', section: 1, summary: 'display information about the CPU architecture', synopsis: 'lscpu [options]',
    man: 'DESCRIPTION\n       lscpu gathers CPU architecture information from sysfs, /proc/cpuinfo and any applicable architecture-specific libraries and prints it in a human-readable format.\n\nOPTIONS\n       -V, --version   display version\n       -h, --help      display help\n\nEXAMPLES\n       lscpu | grep -i "model name"',
    run(ctx) {
      const g = K.getopt(ctx.args, { short: 'hV', long: ['help', 'version'] });
      if (g.err) return unknownOption(ctx, 'lscpu', g.err, "Try 'lscpu --help' for more information.\n");
      if (g.opts.h) { ctx.out('\nUsage:\n lscpu [options]\n\nDisplay information about the CPU architecture.\n\nOptions:\n -a, --all               print both online and offline CPUs (default for -e)\n -b, --online            print online CPUs only (default for -p)\n -h, --help              display this help\n -V, --version           display version\n\nFor more details see lscpu(1).\n'); return 0; }
      if (g.opts.V) { ctx.out('lscpu from util-linux 2.41.2\n'); return 0; }
      const c = cpuInfo(ctx);
      const online = c.n === 1 ? '0' : '0-' + (c.n - 1);
      const rows = [['Architecture', 'x86_64'], ['CPU op-mode(s)', '32-bit, 64-bit'], ['Address sizes', c.addr], ['Byte Order', 'Little Endian'], ['CPU(s)', String(c.n)], ['On-line CPU(s) list', online],
        ['Vendor ID', c.vendor], ['Model name', c.model], ['CPU family', c.family], ['Model', c.modelNo], ['Thread(s) per core', String(Math.max(1, c.n / c.cores))], ['Core(s) per socket', String(c.cores)], ['Socket(s)', '1'],
        ['Stepping', c.stepping], ['BogoMIPS', c.bogo], ['Flags', c.flags], ['Hypervisor vendor', 'KVM'], ['Virtualization type', 'full'], ['L1d cache', 32 * c.n + ' KiB (' + c.n + ' instances)'],
        ['L1i cache', 32 * c.n + ' KiB (' + c.n + ' instances)'], ['L2 cache', 256 * c.n + ' KiB (' + c.n + ' instances)'], ['L3 cache', '12 MiB (1 instance)'], ['NUMA node(s)', '1'], ['NUMA node0 CPU(s)', online]]
        .concat(VULNS.map(([k, v]) => ['Vulnerability ' + k, v]));
      ctx.out(kv(rows, 41));
      return 0;
    } });

  const MODULES = [['vsock_loopback', 12288, '0'], ['vmw_vsock_virtio_transport_common', 57344, '1 vsock_loopback'], ['vmw_vsock_vmci_transport', 40960, '1'], ['vsock', 61440, '5 vmw_vsock_virtio_transport_common,vsock_loopback,vmw_vsock_vmci_transport'],
    ['intel_rapl_msr', 20480, '0'], ['intel_rapl_common', 53248, '1 intel_rapl_msr'], ['crct10dif_pclmul', 12288, '1'], ['ghash_clmulni_intel', 16384, '0'], ['sha512_ssse3', 53248, '0'], ['aesni_intel', 122880, '0'], ['crypto_simd', 16384, '1 aesni_intel'],
    ['cryptd', 28672, '2 crypto_simd,ghash_clmulni_intel'], ['snd_intel8x0', 53248, '0'], ['snd_ac97_codec', 196608, '1 snd_intel8x0'], ['ac97_bus', 12288, '1 snd_ac97_codec'], ['snd_pcm', 188416, '2 snd_intel8x0,snd_ac97_codec'],
    ['vmwgfx', 421888, '2'], ['drm_ttm_helper', 16384, '1 vmwgfx'], ['ttm', 106496, '2 vmwgfx,drm_ttm_helper'], ['e1000', 180224, '0'], ['evdev', 28672, '12'], ['ac', 16384, '0'], ['button', 24576, '0'], ['joydev', 28672, '0'],
    ['loop', 40960, '0'], ['fuse', 200704, '3'], ['drm', 806912, '5 drm_kms_helper,vmwgfx,drm_ttm_helper,ttm'], ['ext4', 1163264, '1'], ['mbcache', 16384, '1 ext4'], ['jbd2', 217088, '1 ext4'], ['crc32c_generic', 12288, '0'],
    ['sd_mod', 77824, '3'], ['sg', 45056, '0'], ['sr_mod', 28672, '0'], ['cdrom', 81920, '1 sr_mod'], ['ata_generic', 12288, '0'], ['ata_piix', 45056, '0'], ['libata', 438272, '2 ata_piix,ata_generic'], ['scsi_mod', 327680, '4 sd_mod,libata,sg,sr_mod']];

  reg({ name: 'lsmod', pkg: 'kmod', path: '/usr/sbin/lsmod', section: 8, summary: 'Show the status of modules in the Linux Kernel', synopsis: 'lsmod',
    man: 'DESCRIPTION\n       lsmod is a trivial program which nicely formats the contents of the /proc/modules, showing what kernel modules are currently loaded.\n\nEXAMPLES\n       lsmod | grep -i snd',
    run(ctx) {
      if (ctx.args.length) { ctx.err('Usage: lsmod\n'); return 1; }
      ctx.out('Module                  Size  Used by\n' + MODULES.map(([n, size, used]) => U.padEnd(n, 19) + ' ' + U.padStart(size, 8) + '  ' + used).join('\n') + '\n');
      return 0;
    } });

  const USB_DEVICES = [{ bus: 2, dev: 1, id: '1d6b:0003', name: 'Linux Foundation 3.0 root hub' }, { bus: 1, dev: 2, id: '0627:0001', name: 'Adomax Technology Co., Ltd QEMU USB Tablet' }, { bus: 1, dev: 1, id: '1d6b:0002', name: 'Linux Foundation 2.0 root hub' }];
  reg({ name: 'lsusb', pkg: 'usbutils', section: 8, summary: 'list USB devices', synopsis: 'lsusb [options]',
    man: 'DESCRIPTION\n       lsusb is a utility for displaying information about USB buses in the system and the devices connected to them.\n\nOPTIONS\n       -t, --tree   dump the physical USB device hierarchy as a tree\n       -s [[bus]:][devnum]   show only devices with the given bus and device number\n       -V, --version   show version\n\nEXAMPLES\n       lsusb\n       lsusb -t',
    run(ctx) {
      const g = K.getopt(ctx.args, { short: 'vtVhs:d:D:', long: ['verbose', 'tree', 'version', 'help'], alias: { tree: 't', version: 'V', help: 'h', verbose: 'v' } });
      if (g.err) { ctx.err('lsusb: ' + g.err + '\nUsage: lsusb [options]...\n'); return 1; }
      if (g.opts.V) { ctx.out('lsusb (usbutils) 018\n'); return 0; }
      if (g.opts.h) { ctx.out('Usage: lsusb [options]...\nList USB devices\n  -v, --verbose\n      Increase verbosity (show descriptors)\n  -s [[bus]:][devnum]\n      Show only devices with specified device and/or\n      bus numbers (in decimal)\n  -d vendor:[product]\n      Show only devices with the specified vendor and\n      product ID numbers (in hexadecimal)\n  -t, --tree\n      Dump the physical USB device hierarchy as a tree\n  -V, --version\n      Show version of program\n  -h, --help\n      Show usage and help\n'); return 0; }
      if (g.opts.t) { ctx.out('/:  Bus 001.Port 001: Dev 001, Class=root_hub, Driver=xhci_hcd/4p, 480M\n    |__ Port 001: Dev 002, If 0, Class=Human Interface Device, Driver=usbhid, 480M\n/:  Bus 002.Port 001: Dev 001, Class=root_hub, Driver=xhci_hcd/4p, 5000M\n'); return 0; }
      let list = USB_DEVICES;
      if (typeof g.opts.s === 'string') { const [b, d] = g.opts.s.includes(':') ? g.opts.s.split(':') : ['', g.opts.s]; list = list.filter((x) => (!b || x.bus === +b) && (!d || x.dev === +d)); }
      if (typeof g.opts.d === 'string') list = list.filter((x) => x.id.startsWith(g.opts.d.replace(/:$/, '')));
      if (!list.length && (g.opts.s || g.opts.d)) return 1;
      ctx.out(list.map((x) => 'Bus ' + U.padStart(x.bus, 3, '0') + ' Device ' + U.padStart(x.dev, 3, '0') + ': ID ' + x.id + ' ' + x.name).join('\n') + '\n');
      return 0;
    } });

  const PCI_DEVICES = [['00:00.0', 'Host bridge', '0600', 'Intel Corporation 82G33/G31/P35/P31 Express DRAM Controller', '8086:29c0', '', ''], ['00:01.0', 'VGA compatible controller', '0300', 'Red Hat, Inc. Virtio 1.0 GPU', '1af4:1050', '01', 'virtio-pci'],
    ['00:02.0', 'Ethernet controller', '0200', 'Red Hat, Inc. Virtio 1.0 network device', '1af4:1041', '01', 'virtio-pci'], ['00:03.0', 'USB controller', '0c03', 'Red Hat, Inc. QEMU XHCI Host Controller', '1b36:000d', '01', 'xhci_hcd'],
    ['00:04.0', 'SCSI storage controller', '0100', 'Red Hat, Inc. Virtio 1.0 block device', '1af4:1042', '01', 'virtio-pci'], ['00:1f.0', 'ISA bridge', '0601', 'Intel Corporation 82801IB (ICH9) LPC Interface Controller', '8086:2918', '02', 'lpc_ich'],
    ['00:1f.2', 'SATA controller', '0106', 'Intel Corporation 82801IR/IO/IH (ICH9R/DO/DH) 6 port SATA Controller [AHCI mode]', '8086:2922', '02', 'ahci'], ['00:1f.3', 'SMBus', '0c05', 'Intel Corporation 82801I (ICH9 Family) SMBus Controller', '8086:2930', '02', 'i801_smbus']];
  reg({ name: 'lspci', pkg: 'pciutils', path: '/usr/bin/lspci', section: 8, summary: 'list all PCI devices', synopsis: 'lspci [options]',
    man: 'DESCRIPTION\n       lspci is a utility for displaying information about PCI buses in the system and devices connected to them.\n\nOPTIONS\n       -n    show numeric IDs\n       -nn   show both names and numeric IDs\n       -k    show kernel drivers handling each device\n       -v    be verbose\n\nEXAMPLES\n       lspci -k',
    run(ctx) {
      const g = K.getopt(ctx.args, { short: 'nkvmtxDs:d:', long: ['version', 'help'] });
      if (g.err) { ctx.err('lspci: ' + g.err + '\nUsage: lspci [<switches>]\n\nBasic display modes:\n-mm\t\tProduce machine-readable output (single -m for an obsolete format)\n-t\t\tShow bus tree\n\nDisplay options:\n-v\t\tBe verbose (-vv or -vvv for higher verbosity)\n-k\t\tShow kernel drivers handling each device\n-x\t\tShow hex-dump of the standard part of the config space\n-n\t\tShow numeric ID\'s\n-nn\t\tShow both textual and numeric ID\'s (names & numbers)\n'); return 1; }
      if (g.opts.version) { ctx.out('lspci version 3.13.0\n'); return 0; }
      let list = PCI_DEVICES;
      if (typeof g.opts.s === 'string') list = list.filter((d) => d[0].endsWith(g.opts.s.replace(/^0*:?/, '')) || d[0] === g.opts.s);
      const out = [];
      for (const [slot, cls, clsId, name, id, rev, drv] of list) {
        const revs = rev && rev !== '' ? ' (rev ' + rev + ')' : '';
        if (g.count.n === 1) out.push(slot + ' ' + clsId + ': ' + id + revs);
        else if (g.count.n >= 2) out.push(slot + ' ' + cls + ' [' + clsId + ']: ' + name + ' [' + id + ']' + revs);
        else out.push(slot + ' ' + cls + ': ' + name + revs);
        if (g.opts.k && drv) out.push('\tKernel driver in use: ' + drv);
      }
      ctx.out(out.join('\n') + '\n');
      return 0;
    } });

  function memInfo(ctx) {
    const kb = {};
    for (const line of ctx.fs.read('/proc/meminfo').split('\n')) { const m = /^(\w+):\s+(\d+)/.exec(line); if (m) kb[m[1]] = parseInt(m[2], 10); }
    return kb;
  }
  const VMSTAT_USAGE = '\nUsage:\n vmstat [options] [delay [count]]\n\nOptions:\n -a, --active           active/inactive memory\n -f, --forks            number of forks since boot\n -m, --slabs            slabinfo\n -n, --one-header       do not redisplay header\n -s, --stats            event counter statistics\n -d, --disk             disk statistics\n -D, --disk-sum         summarize disk statistics\n -p, --partition <dev>  partition specific statistics\n -S, --unit <char>      define display unit\n -w, --wide             wide output\n -t, --timestamp        show timestamp\n\n -h, --help     display this help and exit\n -V, --version  output version information and exit\n\nFor more details see vmstat(8).\n';
  reg({ name: 'vmstat', pkg: 'procps', section: 8, summary: 'Report virtual memory statistics', synopsis: 'vmstat [options] [delay [count]]',
    man: 'DESCRIPTION\n       vmstat reports information about processes, memory, paging, block IO, traps, disks and cpu activity. The first report shows averages since the last reboot.\n\nOPTIONS\n       -a   display active and inactive memory\n       -s   display a table of event counters and memory statistics\n       -S unit   k, K, m or M\n       delay count   repeat the report every delay seconds, count times\n\nEXAMPLES\n       vmstat\n       vmstat 2 5',
    async run(ctx) {
      const g = K.getopt(ctx.args, { short: 'afmnsdDp:S:wthV', long: ['active', 'forks', 'slabs', 'one-header', 'stats', 'disk', 'disk-sum', 'partition=', 'unit=', 'wide', 'timestamp', 'help', 'version'], alias: { active: 'a', stats: 's', unit: 'S', help: 'h', version: 'V', 'one-header': 'n' } });
      if (g.err) { ctx.err('vmstat: ' + g.err + '\n' + VMSTAT_USAGE); return 1; }
      if (g.opts.h) { ctx.out(VMSTAT_USAGE); return 0; }
      if (g.opts.V) { ctx.out('vmstat from procps-ng 4.0.4\n'); return 0; }
      const mi = memInfo(ctx);
      if (g.opts.s) {
        const used = mi.MemTotal - mi.MemFree;
        ctx.out([[mi.MemTotal, 'K total memory'], [used, 'K used memory'], [mi.Active, 'K active memory'], [mi.Inactive, 'K inactive memory'], [mi.MemFree, 'K free memory'], [mi.Buffers, 'K buffer memory'], [mi.Cached, 'K swap cache'], [mi.SwapTotal, 'K total swap'], [mi.SwapTotal - mi.SwapFree, 'K used swap'], [mi.SwapFree, 'K free swap']]
          .map(([n, l]) => U.padStart(n, 14) + ' ' + l).join('\n') + '\n');
        return 0;
      }
      const delay = g.rest[0] != null ? parseInt(g.rest[0], 10) : 0;
      let count = g.rest[1] != null ? parseInt(g.rest[1], 10) : delay > 0 ? Infinity : 1;
      if ((g.rest[0] != null && !(delay >= 0)) || (g.rest[1] != null && !(count > 0))) { ctx.err('vmstat: ' + (g.rest[0] != null && !(delay >= 0) ? 'delay' : 'count') + ' must be positive integer\n'); return 1; }
      const a = !!g.opts.a;
      const header = 'procs -----------memory---------- ---swap-- -----io---- -system-- -------cpu-------\n r  b   swpd   free  ' + (a ? 'inact active' : ' buff  cache') + '   si   so    bi    bo   in   cs us sy id wa st gu\n';
      const ends = [2, 5, 12, 19, 26, 33, 38, 43, 49, 55, 60, 65, 68, 71, 74, 77, 80, 83];
      const row = (first, i) => {
        const h = U.hash32('vm' + ctx.machine.hostname + i);
        const cpu = first ? [5 + (h % 3), 1, 94 - (h % 3), 0, 0, 0] : [1 + (h % 6), h % 3, 97 - (h % 6) - (h % 3), 0, 0, 0];
        const cols = [first ? 0 : h % 2, 0, mi.SwapTotal - mi.SwapFree, mi.MemFree - (i % 4) * 12, a ? mi.Inactive : mi.Buffers, a ? mi.Active : mi.Cached, 0, 0, first ? 826 : (h % 40), first ? 64 : 20 + (h % 300), first ? 680 : 300 + (h % 900), first ? 1 : 200 + (h % 4000)].concat(cpu);
        let line = '';
        cols.forEach((v, k) => { line += U.padStart(v, ends[k] - line.length); });
        return line + '\n';
      };
      ctx.out(header);
      for (let i = 0; i < count; i++) {
        ctx.out(row(i === 0, i));
        if (i + 1 < count) await ctx.sleep(delay * 1000);
      }
      return 0;
    } });

  const ZONES = { 'Etc/UTC': ['UTC', 0], UTC: ['UTC', 0], 'Europe/London': ['GMT', 0], 'Europe/Berlin': ['CET', 60], 'Europe/Paris': ['CET', 60], 'Europe/Madrid': ['CET', 60], 'Europe/Amsterdam': ['CET', 60], 'America/New_York': ['EST', -300], 'America/Chicago': ['CST', -360],
    'America/Denver': ['MST', -420], 'America/Los_Angeles': ['PST', -480], 'Asia/Tokyo': ['JST', 540], 'Asia/Kolkata': ['IST', 330], 'Asia/Singapore': ['+08', 480], 'Asia/Dubai': ['+04', 240], 'Australia/Sydney': ['AEDT', 660] };
  const offsetStr = (min) => (min < 0 ? '-' : '+') + U.pad2(Math.floor(Math.abs(min) / 60)) + U.pad2(Math.abs(min) % 60);
  const zoneOf = (ctx) => { const tz = ctx.fs.read('/etc/timezone').trim(); return { name: tz, info: ZONES[tz] || ['UTC', 0] }; };
  const stamp = (ms, abbr) => { const d = new Date(ms); return U.DAYS[d.getUTCDay()] + ' ' + U.isoDate(ms) + (abbr ? ' ' + abbr : ''); };
  const polkitDenied = (ctx, what) => { ctx.err(what + ': Interactive authentication required.\n'); return 1; };

  reg({ name: 'timedatectl', pkg: 'systemd-timesyncd', section: 1, summary: 'Control the system time and date', synopsis: 'timedatectl [OPTIONS...] COMMAND ...',
    man: 'DESCRIPTION\n       timedatectl may be used to query and change the system clock and its settings, and enable or disable time synchronization services.\n\nCOMMANDS\n       status           show current time settings\n       show             show properties in key=value form\n       set-timezone ZONE   set the system time zone (root)\n       set-ntp BOOL     enable or disable NTP synchronization (root)\n       list-timezones   list known time zones\n\nEXAMPLES\n       timedatectl\n       sudo timedatectl set-timezone Europe/Berlin',
    run(ctx) {
      const g = K.getopt(ctx.args, { short: 'hH:M:', long: ['help', 'version', 'no-pager', 'no-ask-password', 'value', 'property=', 'all'], alias: { help: 'h' } });
      if (g.err) { ctx.err('timedatectl: ' + g.err + '\n'); return 1; }
      if (g.opts.version) { ctx.out('systemd 257 (257.9-1)\n+PAM +AUDIT +SELINUX +APPARMOR +IMA +IPE +SMACK +SECCOMP +GCRYPT -GNUTLS +OPENSSL +ACL +BLKID +CURL +ELFUTILS +FIDO2 +IDN2 -IDN +IPTC +KMOD +LIBCRYPTSETUP +LIBCRYPTSETUP_PLUGINS +LIBFDISK +PCRE2 +PWQUALITY +P11KIT +QRENCODE +TPM2 +BZIP2 +LZ4 +XZ +ZLIB +ZSTD +BPF_FRAMEWORK +XKBCOMMON +UTMP +SYSVINIT +LIBARCHIVE\n'); return 0; }
      const cmd = g.rest[0] || 'status'; const m = ctx.machine; const adm = adminState(m);
      const { name: tz, info } = zoneOf(ctx); const now = K.clock.now();
      const ntp = adm.ntp !== false;
      switch (cmd) {
        case 'status': {
          const local = now + info[1] * 60000;
          ctx.out(U.padStart('Local time:', 26) + ' ' + stamp(local, info[0]) + '\n' + U.padStart('Universal time:', 26) + ' ' + stamp(now, 'UTC') + '\n' + U.padStart('RTC time:', 26) + ' ' + stamp(now) + '\n' +
            U.padStart('Time zone:', 26) + ' ' + tz + ' (' + info[0] + ', ' + offsetStr(info[1]) + ')\n' + U.padStart('System clock synchronized:', 26) + ' ' + (ntp ? 'yes' : 'no') + '\n' + U.padStart('NTP service:', 26) + ' ' + (ntp ? 'active' : 'inactive') + '\n' + U.padStart('RTC in local TZ:', 26) + ' no\n');
          return 0;
        }
        case 'show':
          ctx.out('Timezone=' + tz + '\nLocalRTC=no\nCanNTP=yes\nNTP=' + (ntp ? 'yes' : 'no') + '\nNTPSynchronized=' + (ntp ? 'yes' : 'no') + '\nTimeUSec=' + stamp(now + info[1] * 60000, info[0]) + '\nRTCTimeUSec=' + stamp(now, 'UTC') + '\n');
          return 0;
        case 'list-timezones': ctx.out(Object.keys(ZONES).filter((z) => z.includes('/') && z !== 'Etc/UTC').sort().join('\n') + '\n'); return 0;
        case 'set-timezone': case 'set-ntp': case 'set-time': case 'set-local-rtc': {
          if (!g.rest[1]) { ctx.err('Argument required.\n'); return 1; }
          if (!ctx.isRoot) return polkitDenied(ctx, 'Failed to ' + (cmd === 'set-timezone' ? 'set time zone' : cmd === 'set-ntp' ? 'set ntp' : cmd === 'set-time' ? 'set time' : 'set local RTC'));
          if (cmd === 'set-timezone') {
            if (!ZONES[g.rest[1]]) { ctx.err("Failed to set time zone: Invalid time zone '" + g.rest[1] + "'\n"); return 1; }
            m.vfs.write('/etc/timezone', g.rest[1] + '\n');
            log(m, { facility: 'daemon', ident: 'systemd-timedated', pid: ctx.pid, msg: 'Changed time zone to \'' + g.rest[1] + '\' (' + ZONES[g.rest[1]][0] + ').' });
          } else if (cmd === 'set-ntp') {
            if (!/^(true|false|yes|no|1|0|on|off)$/i.test(g.rest[1])) { ctx.err('Failed to parse bool: ' + g.rest[1] + '\n'); return 1; }
            adm.ntp = /^(true|yes|1|on)$/i.test(g.rest[1]);
          } else if (cmd === 'set-time') { ctx.err('Failed to set time: Automatic time synchronization is enabled\n'); return 1; }
          return 0;
        }
        default: ctx.err('Unknown command verb \'' + cmd + '\'.\n'); return 1;
      }
    } });

  const machineId = (m, seed) => [0, 1, 2, 3].map((i) => U.padStart(U.hash32(seed + m.hostname + i).toString(16), 8, '0')).join('');
  reg({ name: 'hostnamectl', pkg: 'systemd', section: 1, summary: 'Control the system hostname', synopsis: 'hostnamectl [OPTIONS...] COMMAND ...',
    man: 'DESCRIPTION\n       hostnamectl may be used to query and change the system hostname and related settings.\n\nCOMMANDS\n       status                 show current hostname settings\n       hostname [NAME]        show or set the system hostname\n       set-hostname NAME      set the system hostname (root)\n\nEXAMPLES\n       hostnamectl\n       sudo hostnamectl set-hostname lab-kali',
    run(ctx) {
      const g = K.getopt(ctx.args, { short: 'hH:', long: ['help', 'version', 'static', 'transient', 'pretty', 'no-ask-password', 'no-pager', 'json=?'], alias: { help: 'h' } });
      if (g.err) { ctx.err('hostnamectl: ' + g.err + '\n'); return 1; }
      if (g.opts.version) { ctx.out('systemd 257 (257.9-1)\n'); return 0; }
      const cmd = g.rest[0] || 'status'; const m = ctx.machine;
      if (cmd === 'hostname' && !g.rest[1]) { ctx.out(m.hostname + '\n'); return 0; }
      if (cmd === 'status') {
        const rows = [['Static hostname', m.hostname], ['Icon name', 'computer-vm'], ['Chassis', 'vm \u{1F5B4}'], ['Machine ID', machineId(m, 'mid')], ['Boot ID', machineId(m, 'bid' + K.getBootTime())], ['Virtualization', 'kvm'],
          ['Operating System', m.os.pretty || 'Kali GNU/Linux Rolling'], ['Kernel', 'Linux ' + m.os.kernel], ['Architecture', 'x86-64'], ['Hardware Vendor', 'QEMU'], ['Hardware Model', 'Standard PC _Q35 + ICH9, 2009_'], ['Firmware Version', '1.16.3-debian-1.16.3-2']];
        ctx.out(rows.map(([k, v]) => U.padStart(k + ':', 17) + ' ' + v).join('\n') + '\n');
        return 0;
      }
      if (cmd === 'set-hostname' || cmd === 'hostname') {
        const name = g.rest[1];
        if (!name) { ctx.err('Argument required.\n'); return 1; }
        if (!ctx.isRoot) return polkitDenied(ctx, 'Could not set static hostname');
        if (!/^[A-Za-z0-9]([A-Za-z0-9-]{0,62})$/.test(name)) { ctx.err("Could not set static hostname: Invalid static hostname '" + name + "'\n"); return 1; }
        const old = m.hostname;
        m.hostname = name;
        try { m.vfs.write('/etc/hosts', m.vfs.read('/etc/hosts').split(old).join(name)); } catch (e) { /* hosts file removed */ }
        log(m, { facility: 'daemon', ident: 'systemd-hostnamed', pid: ctx.pid, msg: 'Hostname set to <' + name + '> (static)' });
        return 0;
      }
      ctx.err("Unknown command verb '" + cmd + "'.\n");
      return 1;
    } });

  const LC_VARS = ['LC_CTYPE', 'LC_NUMERIC', 'LC_TIME', 'LC_COLLATE', 'LC_MONETARY', 'LC_MESSAGES', 'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION'];
  reg({ name: 'locale', pkg: 'libc-bin', section: 1, summary: 'get locale-specific information', synopsis: 'locale [option]',
    man: 'DESCRIPTION\n       The locale command displays information about the current locale, or all locales, on standard output.\n\nOPTIONS\n       -a, --all-locales   write names of available locales\n       -m, --charmaps      write names of available charmaps\n\nEXAMPLES\n       locale\n       locale -a',
    run(ctx) {
      const g = K.getopt(ctx.args, { short: 'amckV?', long: ['all-locales', 'charmaps', 'category-name', 'keyword-name', 'version', 'help', 'verbose'], alias: { 'all-locales': 'a', charmaps: 'm', version: 'V' } });
      if (g.err) { ctx.err('locale: ' + g.err + '\nTry `locale --help\' or `locale --usage\' for more information.\n'); return 64; }
      if (g.opts.V) { ctx.out('locale (Debian GLIBC 2.41-12) 2.41\n'); return 0; }
      if (g.opts.a) { ctx.out('C\nC.utf8\nen_US.utf8\nPOSIX\n'); return 0; }
      if (g.opts.m) { ctx.out('ANSI_X3.4-1968\nUTF-8\n'); return 0; }
      const env = ctx.env; const lang = env.LANG || 'en_US.UTF-8'; const all = env.LC_ALL || '';
      const lines = ['LANG=' + (env.LANG || ''), 'LANGUAGE=' + (env.LANGUAGE || '')];
      for (const v of LC_VARS) lines.push(env[v] && !all ? v + '=' + env[v] : v + '="' + (all || env[v] || lang) + '"');
      lines.push('LC_ALL=' + all);
      ctx.out(lines.join('\n') + '\n');
      return 0;
    } });

  const LASTLOG_USAGE = 'Usage: lastlog [options]\n\nOptions:\n  -b, --before DAYS             print only lastlog records older than DAYS\n  -C, --clear                   clear lastlog record of an user (usable only with -u)\n  -h, --help                    display this help message and exit\n  -R, --root CHROOT_DIR         directory to chroot into\n  -S, --set                     set lastlog record to current time (usable only with -u)\n  -t, --time DAYS               print only lastlog records more recent than DAYS\n  -u, --user LOGIN              print lastlog record of the specified LOGIN\n\n';
  reg({ name: 'lastlog', pkg: 'login', path: '/usr/bin/lastlog', section: 8, summary: 'reports the most recent login of all users or of a given user', synopsis: 'lastlog [options]',
    man: 'DESCRIPTION\n       lastlog formats and prints the contents of the last login log /var/log/lastlog. The login-name, port, and last login time will be printed.\n\nOPTIONS\n       -u, --user LOGIN   print the record of the specified user\n       -t, --time DAYS    only records more recent than DAYS\n       -b, --before DAYS  only records older than DAYS\n\nEXAMPLES\n       lastlog\n       lastlog -u kali',
    run(ctx) {
      const g = K.getopt(ctx.args, { short: 'b:Chn:R:St:u:', long: ['before=', 'clear', 'help', 'root=', 'set', 'time=', 'user='], alias: { before: 'b', clear: 'C', help: 'h', set: 'S', time: 't', user: 'u' } });
      if (g.err) { ctx.err('lastlog: ' + g.err + '\n' + LASTLOG_USAGE); return 1; }
      if (g.opts.h) { ctx.out(LASTLOG_USAGE); return 0; }
      const m = ctx.machine; const bootAt = K.getBootTime() + 20000;
      let users = m.users;
      if (g.opts.u != null) {
        users = m.users.filter((u) => u.name === g.opts.u || String(u.uid) === g.opts.u);
        if (!users.length) { ctx.err('lastlog: Unknown user: ' + g.opts.u + '\n'); return 1; }
      }
      const lastLoginOf = (u) => (u.uid >= LOGIN_UID_MIN && u.uid < 60000 && u.name === ctx.user.name ? bootAt : null);
      const day = 86400000; const now = K.clock.now();
      const rows = users.filter((u) => {
        const t = lastLoginOf(u);
        if (g.opts.t != null && !(t != null && now - t <= g.opts.t * day)) return false;
        if (g.opts.b != null && !(t == null || now - t > g.opts.b * day)) return false;
        return true;
      }).map((u) => {
        const t = lastLoginOf(u);
        const when = t == null ? '**Never logged in**' : U.DAYS[new Date(t).getUTCDay()] + ' ' + U.MONTHS[new Date(t).getUTCMonth()] + ' ' + U.padStart(new Date(t).getUTCDate(), 2, '0') + ' ' + U.isoDate(t).slice(11) + ' +0000 ' + new Date(t).getUTCFullYear();
        // lastlog really pads the "never" rows one column short of the header
        return t == null ? U.padEnd(u.name, 68) + when : U.padEnd(u.name, 16) + ' ' + U.padEnd('pts/0', 8) + ' ' + U.padEnd('', 42) + ' ' + when;
      });
      ctx.out('Username         Port     From                                       Latest\n' + (rows.length ? rows.join('\n') + '\n' : ''));
      return 0;
    } });

  reg({ name: 'logname', pkg: 'coreutils', section: 1, summary: "print user's login name", synopsis: 'logname [OPTION]',
    man: "DESCRIPTION\n       Print the name of the current user.\n\nOPTIONS\n       --help     display this help and exit\n       --version  output version information and exit\n\nEXAMPLES\n       logname",
    run(ctx) {
      const g = K.getopt(ctx.args, { long: ['help', 'version'] });
      if (g.err) { ctx.err('logname: ' + g.err + '\n' + tryHelp('logname')); return 1; }
      if (g.opts.help) { ctx.out("Usage: logname [OPTION]\nPrint the user's login name.\n\n      --help        display this help and exit\n      --version     output version information and exit\n" + coreutilsFooter('logname')); return 0; }
      if (g.opts.version) { ctx.out(coreutilsVersion('logname', 'FIXME: unknown')); return 0; }
      if (g.rest.length) { ctx.err("logname: extra operand '" + g.rest[0] + "'\n" + tryHelp('logname')); return 1; }
      ctx.out((ctx.env.LOGNAME || ctx.user.name) + '\n');
      return 0;
    } });

  /** Run another command for nice/nohup; null when it does not exist. */
  async function runChild(ctx, argv) {
    const sh = ctx.shell; const prog = argv[0];
    const known = sh && typeof sh.which === 'function' ? sh.which(prog) || (K.builtins && K.builtins[prog]) : true;
    if (!known && !(prog.includes('/') && ctx.fs.exists(prog))) return null;
    return ctx.run(argv, { stdin: ctx.stdin == null ? '' : ctx.stdin });
  }

  reg({ name: 'nice', pkg: 'coreutils', section: 1, summary: 'run a program with modified scheduling priority', synopsis: 'nice [OPTION] [COMMAND [ARG]...]',
    man: 'DESCRIPTION\n       Run COMMAND with an adjusted niceness, which affects process scheduling. With no COMMAND, print the current niceness. Niceness values range from -20 (most favorable to the process) to 19 (least favorable).\n\nOPTIONS\n       -n, --adjustment=N   add integer N to the niceness (default 10)\n\nEXAMPLES\n       nice -n 10 nmap -sV 10.10.10.10',
    async run(ctx) {
      const st = ctx.machine.state;
      const args = ctx.args.slice(); let adj = 10; let help = null;
      while (args.length && args[0][0] === '-' && args[0] !== '-') {
        const a = args.shift();
        if (a === '--') break;
        if (a === '--help') help = 'help'; else if (a === '--version') help = 'version';
        else if (a === '-n' || a === '--adjustment') { if (!args.length) { ctx.err("nice: option requires an argument -- 'n'\n" + tryHelp('nice')); return 125; } adj = args.shift(); }
        else if (a.startsWith('--adjustment=')) adj = a.slice(13);
        else if (a.startsWith('-n')) adj = a.slice(2);
        else if (/^-\d+$/.test(a)) adj = a.slice(1);
        else if (a.startsWith('--')) { ctx.err("nice: unrecognized option '" + a + "'\n" + tryHelp('nice')); return 125; }
        else { ctx.err("nice: invalid option -- '" + a[1] + "'\n" + tryHelp('nice')); return 125; }
      }
      if (help === 'help') { ctx.out("Usage: nice [OPTION] [COMMAND [ARG]...]\nRun COMMAND with an adjusted niceness, which affects process scheduling.\nWith no COMMAND, print the current niceness.  Niceness values range from\n-20 (most favorable to the process) to 19 (least favorable to the process).\n\nMandatory arguments to long options are mandatory for short options too.\n  -n, --adjustment=N   add integer N to the niceness (default 10)\n      --help        display this help and exit\n      --version     output version information and exit\n\nNOTE: your shell may have its own version of nice, which usually supersedes\nthe version described here.  Please refer to your shell's documentation\nfor details about the options it supports.\n\nExit status:\n  125  if the nice command itself fails\n  126  if COMMAND is found but cannot be invoked\n  127  if COMMAND cannot be found\n  -    the exit status of COMMAND otherwise\n" + coreutilsFooter('nice')); return 0; }
      if (help === 'version') { ctx.out(coreutilsVersion('nice', 'David MacKenzie')); return 0; }
      if (!/^[+-]?\d+$/.test(String(adj))) { ctx.err("nice: invalid adjustment '" + adj + "'\n"); return 125; }
      const cur = st.niceness || 0;
      if (!args.length) { ctx.out(cur + '\n'); return 0; }
      const next = Math.max(-20, Math.min(19, cur + parseInt(adj, 10)));
      if (next < cur && !ctx.isRoot) ctx.err('nice: cannot set niceness: Permission denied\n');
      st.niceness = next < cur && !ctx.isRoot ? cur : next;
      let res;
      try { res = await runChild(ctx, args); } finally { st.niceness = cur; }
      if (!res) { ctx.err('nice: \u2018' + args[0] + '\u2019: No such file or directory\n'); return 127; }
      ctx.out(res.out); ctx.err(res.err);
      return res.code;
    } });

  reg({ name: 'nohup', pkg: 'coreutils', section: 1, summary: 'run a command immune to hangups, with output to a non-tty', synopsis: 'nohup COMMAND [ARG]...',
    man: "DESCRIPTION\n       Run COMMAND, ignoring hangup signals. If standard input is a terminal, redirect it from an unreadable file. If standard output is a terminal, append output to 'nohup.out' if possible, '$HOME/nohup.out' otherwise.\n\nEXAMPLES\n       nohup ping -c 100 10.10.10.1 &",
    async run(ctx) {
      const args = ctx.args.slice();
      if (args[0] === '--help') { ctx.out("Usage: nohup COMMAND [ARG]...\n  or:  nohup OPTION\nRun COMMAND, ignoring hangup signals.\n\n      --help        display this help and exit\n      --version     output version information and exit\n\nIf standard input is a terminal, redirect it from an unreadable file.\nIf standard output is a terminal, append output to 'nohup.out' if possible,\n'$HOME/nohup.out' otherwise.\nIf standard error is a terminal, redirect it to standard output.\nTo save output to FILE, use 'nohup COMMAND > FILE'.\n\nNOTE: your shell may have its own version of nohup, which usually supersedes\nthe version described here.  Please refer to your shell's documentation\nfor details about the options it supports.\n\nExit status:\n  125  if the nohup command itself fails\n  126  if COMMAND is found but cannot be invoked\n  127  if COMMAND cannot be found\n  -    the exit status of COMMAND otherwise\n" + coreutilsFooter('nohup')); return 0; }
      if (args[0] === '--version') { ctx.out(coreutilsVersion('nohup', 'Jim Meyering')); return 0; }
      if (args[0] === '--') args.shift();
      else if (args[0] && args[0][0] === '-' && args[0] !== '-') { ctx.err("nohup: invalid option -- '" + args[0].replace(/^-+/, '')[0] + "'\n" + tryHelp('nohup')); return 125; }
      if (!args.length) { ctx.err('nohup: missing operand\n' + tryHelp('nohup')); return 125; }
      const inTty = ctx.stdin == null;
      let target = null;
      if (ctx.isTTY) {
        for (const p of ['nohup.out', (ctx.env.HOME || ctx.user.home) + '/nohup.out']) {
          try { if (!ctx.fs.exists(p)) ctx.fs.write(p, '', { mode: 0o600 }); ctx.fs.append(p, ''); target = p; break; } catch (e) { if (!(e instanceof K.FsError)) throw e; }
        }
        if (!target) { ctx.err("nohup: failed to open 'nohup.out': Permission denied\n"); return 125; }
        ctx.err('nohup: ' + (inTty ? 'ignoring input and appending output to ' : 'appending output to ') + "'" + (target === 'nohup.out' ? 'nohup.out' : target) + "'\n");
      } else if (inTty) ctx.err('nohup: ignoring input\n');
      const res = await runChild(ctx, args);
      if (!res) { ctx.err("nohup: failed to run command '" + args[0] + "': No such file or directory\n"); return 127; }
      if (target) ctx.fs.append(target, res.out + res.err); else { ctx.out(res.out); ctx.err(res.err); }
      return res.code;
    } });

  /* ---- crontab ---- */

  const CRON_SPOOL = '/var/spool/cron/crontabs';
  const CRON_TEMPLATE = "# Edit this file to introduce tasks to be run by cron.\n# \n# Each task to run has to be defined through a single line\n# indicating with different fields when the task will be run\n# and what command to run for the task\n# \n# To define the time you can provide concrete values for\n# minute (m), hour (h), day of month (dom), month (mon),\n# and day of week (dow) or use '*' in these fields (for 'any').\n# \n# Notice that tasks will be started based on the cron's system\n# daemon's notion of time and timezones.\n# \n# Output of the crontab jobs (including errors) is sent through\n# email to the user the crontab file belongs to (unless redirected).\n# \n# For example, you can run a backup of all your user accounts\n# at 5 a.m every week with:\n# 0 5 * * 1 tar -zcf /var/backups/home.tgz /home/\n# \n# For more information see the manual pages of crontab(5) and cron(8)\n# \n# m h  dom mon dow   command\n";
  const CRON_FIELDS = [['minute', 0, 59], ['hour', 0, 23], ['day-of-month', 1, 31], ['month', 1, 12], ['day-of-week', 0, 7]];
  const CRON_NAMES = { month: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], 'day-of-week': ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] };

  function cronFieldOk(text, [name, lo, hi]) {
    const names = CRON_NAMES[name] || [];
    const num = (t) => { const i = names.indexOf(t.toLowerCase()); if (i >= 0) return i + (name === 'month' ? 1 : 0); return /^\d+$/.test(t) ? parseInt(t, 10) : NaN; };
    return text.split(',').every((part) => {
      const [range, step] = part.split('/');
      if (step != null && !/^\d+$/.test(step)) return false;
      if (range === '*') return true;
      const [a, b] = range.split('-').map(num);
      const bounds = (v) => v >= lo && v <= hi;
      return range.includes('-') ? bounds(a) && bounds(b) : bounds(a);
    });
  }
  /** First problem in a crontab as {line, msg}, or null. Line numbers are 1-based. */
  function cronProblem(text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l || l[0] === '#' || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l)) continue;
      if (/^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)\s+\S/.test(l)) continue;
      if (l[0] === '@') return { line: i + 1, msg: 'bad command' };
      const f = l.split(/\s+/);
      for (let k = 0; k < 5; k++) if (f[k] == null || !cronFieldOk(f[k], CRON_FIELDS[k])) return { line: i + 1, msg: 'bad ' + CRON_FIELDS[k][0] };
      if (f.length < 6) return { line: i + 1, msg: 'bad command' };
    }
    return null;
  }

  const CRONTAB_USAGE = "usage:\tcrontab [-u user] file\n\tcrontab [-u user] [-i] { -e | -l | -r }\n\t\t(default operation is replace, per 1003.2)\n\t-e\t(edit user's crontab)\n\t-l\t(list user's crontab)\n\t-r\t(delete user's crontab)\n\t-i\tprompt before deleting\n\t-n <host> set host in cluster to run users' crontabs\n\t-c\tget host in cluster to run users' crontabs\n\t-s\tselinux context\n\t-x <mask> enable debugging\n";

  async function chooseEditor(ctx) {
    const sel = (ctx.env.HOME || ctx.user.home) + '/.selected_editor';
    let flavor = 'nano';
    try { if (/vim/.test(ctx.fs.read(sel))) flavor = 'vim'; return flavor; } catch (e) { /* first run: ask */ }
    ctx.out("\nSelect an editor.  To change later, run 'select-editor'.\n  1. /bin/nano        <---- easiest\n  2. /usr/bin/vim.basic\n  3. /usr/bin/vim.tiny\n  4. /bin/ed\n\n");
    const ans = await ctx.readLine('Choose 1-4 [1]: ');
    const path = ['/bin/nano', '/usr/bin/vim.basic', '/usr/bin/vim.tiny', '/bin/ed'][(parseInt(ans, 10) || 1) - 1] || '/bin/nano';
    flavor = /vim/.test(path) ? 'vim' : 'nano';
    try { ctx.fs.write(sel, '# Generated by /usr/bin/select-editor\nSELECTED_EDITOR="' + path + '"\n'); } catch (e) { /* read-only home */ }
    return flavor;
  }

  reg({ name: 'crontab', pkg: 'cron', section: 1, mode: 0o2755, summary: 'maintain crontab files for individual users', synopsis: 'crontab [-u user] file | crontab [-u user] [-i] {-e | -l | -r}',
    man: "DESCRIPTION\n       crontab is the program used to install, deinstall or list the tables used to drive the cron daemon. Each user can have their own crontab, kept in /var/spool/cron/crontabs.\n\nOPTIONS\n       -l   display the current crontab on standard output\n       -e   edit the current crontab using the editor\n       -r   remove the current crontab\n       -u user   operate on another user's crontab (root only)\n\nEXAMPLES\n       crontab -l\n       echo '*/5 * * * * /home/kali/scan.sh' | crontab -",
    async run(ctx) {
      const g = K.getopt(ctx.args, { short: 'u:elrinxcs' });
      if (g.err) { ctx.err('crontab: ' + g.err + '\n' + CRONTAB_USAGE); return 1; }
      const m = ctx.machine; const o = g.opts;
      let who = ctx.user.name;
      if (typeof o.u === 'string') {
        if (!ctx.isRoot && o.u !== who) { ctx.err('must be privileged to use -u\n'); return 1; }
        if (!m.userByName(o.u)) { ctx.err("crontab: user `" + o.u + "' unknown\n"); return 1; }
        who = o.u;
      }
      const path = CRON_SPOOL + '/' + who;
      const mutually = ['e', 'l', 'r'].filter((k) => o[k]).length;
      if (mutually > 1 || (mutually && g.rest.length)) { ctx.err(CRONTAB_USAGE); return 1; }
      const read = () => { try { return m.vfs.read(path); } catch (e) { return null; } };
      const write = (text) => {
        const u = m.userByName(who); const grp = m.groupByName('crontab');
        m.vfs.seed(path, text, { mode: 0o600, uid: u.uid, gid: grp ? grp.gid : u.gid, mtime: K.clock.now() });
        log(m, { facility: 'cron', ident: 'crontab', pid: ctx.pid, msg: '(' + who + ') REPLACE (' + who + ')' });
      };
      if (o.l) { const t = read(); if (t == null) { ctx.err('no crontab for ' + who + '\n'); return 1; } ctx.out(t); return 0; }
      if (o.r) {
        if (read() == null) { ctx.err('no crontab for ' + who + '\n'); return 1; }
        if (o.i) { const a = await ctx.readLine('crontab: really delete ' + who + "'s crontab? (y/n) "); if (!a || !/^y/i.test(a)) return 0; }
        m.vfs.unlink(path);
        log(m, { facility: 'cron', ident: 'crontab', pid: ctx.pid, msg: '(' + who + ') DELETE (' + who + ')' });
        return 0;
      }
      if (o.e) {
        let original = read();
        if (original == null) { ctx.err('no crontab for ' + who + ' - using an empty one\n'); original = ''; }
        const flavor = await chooseEditor(ctx);
        let content = original === '' ? CRON_TEMPLATE : original;
        const dir = '/tmp/crontab.' + U.hash32(who + K.clock.now()).toString(36).slice(0, 6).toUpperCase().padEnd(6, 'X');
        for (;;) {
          const res = await ctx.term.editor({ path: dir + '/crontab', content, flavor });
          if (!res || !res.saved || res.content === original || res.content === (original === '' ? CRON_TEMPLATE : original)) { ctx.err('crontab: no changes made to crontab\n'); return 0; }
          content = res.content;
          const bad = cronProblem(content);
          if (!bad) break;
          ctx.err('"' + dir + '/crontab":' + bad.line + ': ' + bad.msg + "\nerrors in crontab file, can't install.\n");
          const again = await ctx.readLine('Do you want to retry the same edit? (y/n) ');
          if (!again || !/^y/i.test(again)) { ctx.err('crontab: edits left in ' + dir + '/crontab\n'); return 1; }
        }
        write(content);
        ctx.out('crontab: installing new crontab\n');
        return 0;
      }
      let text;
      const src = g.rest[0];
      if (src == null || src === '-') { text = ctx.stdin != null ? ctx.stdin : ''; if (ctx.stdin == null) { const lines = []; for (let l = await ctx.readLine(''); l != null; l = await ctx.readLine('')) lines.push(l); text = lines.length ? lines.join('\n') + '\n' : ''; } }
      else { try { text = ctx.fs.read(src); } catch (e) { if (!(e instanceof K.FsError)) throw e; ctx.err('crontab: ' + src + ': ' + e.message + '\n'); return 1; } }
      const bad = cronProblem(text);
      if (bad) { ctx.err('"' + (src || '-') + '":' + bad.line + ': ' + bad.msg + "\nerrors in crontab file, can't install.\n"); return 1; }
      write(text);
      return 0;
    } });

  K.fsSeeds.push((machine) => {
    if (!machine.groupByName('crontab') && !machine.groupByGid(107)) machine.groups.push({ name: 'crontab', gid: 107, members: [] });
    const grp = machine.groupByName('crontab');
    machine.vfs.seedDir(CRON_SPOOL, { mode: 0o1730, uid: 0, gid: grp ? grp.gid : 0 });
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
