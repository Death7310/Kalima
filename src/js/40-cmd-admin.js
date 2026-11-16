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

})(typeof globalThis !== 'undefined' ? globalThis : this);
