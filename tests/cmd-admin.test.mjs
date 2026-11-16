// Tests for the administration pack: apt, dpkg, users, system information, power.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

async function sim() {
  const s = await boot();
  s.machine.sudoStamp.kali = s.K.clock.now();
  s.out = async (line) => (await s.run(line)).out;
  return s;
}

test('apt: changing anything needs root and prints the lock errors', async () => {
  const s = await sim();
  const r = await s.run('apt install ncdu');
  assert.equal(r.code, 100);
  assert.match(r.err, /Error: Could not open lock file \/var\/lib\/dpkg\/lock-frontend - open \(13: Permission denied\)/);
  assert.match(r.err, /are you root\?/);
  const u = await s.run('apt update');
  assert.equal(u.code, 100);
  assert.match(u.err, /Unable to lock directory \/var\/lib\/apt\/lists\//);
});

test('apt install: plan, confirmation, files, logs', async () => {
  const s = await sim();
  s.term.feed('y');
  const r = await s.run('sudo apt install ncdu');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Installing:\n  ncdu\n\nSummary:\n  Upgrading: 0, Installing: 1, Removing: 0, Not Upgrading: \d+\n  Download size: .* kB\n  Space needed: .* \/ .* GB available/);
  assert.match(r.out, /Get:1 http:\/\/http\.kali\.org\/kali kali-rolling\/main amd64 ncdu amd64 1\.22-1 \[/);
  assert.match(r.out, /Selecting previously unselected package ncdu\./);
  assert.match(r.out, /Unpacking ncdu \(1\.22-1\) \.\.\.\nSetting up ncdu \(1\.22-1\) \.\.\./);
  assert.equal(s.machine.packages.get('ncdu').status, 'installed');
  assert.match(await s.out('apt list --installed ncdu 2>/dev/null'), /^ncdu\/kali-rolling,now 1\.22-1 amd64 \[installed\]$/m);
  assert.match(await s.out('cat /var/log/apt/history.log'), /Commandline: apt install ncdu\nRequested-By: kali \(1000\)\nInstall: ncdu:amd64 \(1\.22-1\)/);
  assert.match(await s.out('cat /var/log/dpkg.log'), /install ncdu:amd64 <none> 1\.22-1\n.*status half-installed ncdu:amd64/);
  const again = await s.run('sudo apt install ncdu');
  assert.match(again.out, /ncdu is already the newest version \(1\.22-1\)\./);
});

test('apt install -y, dependencies, unknown packages and aborting', async () => {
  const s = await sim();
  const r = await s.run('sudo apt-get install -y nginx');
  assert.match(r.out, /The following additional packages will be installed:\n  nginx-common\nThe following NEW packages will be installed:\n  nginx nginx-common\n1 upgraded|0 upgraded, 2 newly installed, 0 to remove and \d+ not upgraded\./);
  assert.match(r.out, /Need to get .* of archives\./);
  const bad = await s.run('sudo apt install no-such-pkg');
  assert.equal(bad.code, 100);
  assert.match(bad.err, /Error: Unable to locate package no-such-pkg/);
  s.term.feed('n');
  const no = await s.run('sudo apt install htop');
  assert.equal(no.code, 1);
  assert.match(no.out, /Abort\./);
  assert.equal(s.machine.packages.has('htop'), false);
});

test('apt install creates command stubs and remove deletes them', async () => {
  const s2 = await sim();
  s2.K.cmd.register({ name: 'kal-demo', pkg: 'kal-demo', installed: false, summary: 'demo tool', run: (ctx) => { ctx.out('demo\n'); return 0; } });
  assert.equal(s2.machine.vfs.exists('/usr/bin/kal-demo'), false);
  const r = await s2.run('sudo apt install -y kal-demo');
  assert.equal(r.code, 0, r.err);
  assert.equal((await s2.run('kal-demo')).out, 'demo\n');
  const rm = await s2.run('sudo apt remove -y kal-demo');
  assert.match(rm.out, /REMOVING:\n  kal-demo/);
  assert.match(rm.out, /Removing kal-demo \(/);
  assert.equal((await s2.run('kal-demo')).code, 127);
  assert.equal(s2.machine.packages.get('kal-demo').status, 'config-files');
  assert.match((await s2.run('dpkg -l kal-demo')).out, /^rc  kal-demo/m);
  await s2.run('sudo apt purge -y kal-demo');
  assert.equal(s2.machine.packages.has('kal-demo'), false);
});

test('apt update: output, second run hits, outage', async () => {
  const s = await sim();
  const r = await s.run('sudo apt update');
  assert.match(r.out, /^Get:1 http:\/\/http\.kali\.org\/kali kali-rolling InRelease \[41\.5 kB\]/);
  assert.match(r.out, /Fetched .* MB in \d+s/);
  assert.match(r.out, /\d+ packages? can be upgraded\. Run 'apt list --upgradable' to see (them|it)\./);
  const again = await s.run('sudo apt update');
  assert.match(again.out, /^Hit:1 http:\/\/http\.kali\.org\/kali kali-rolling InRelease/);
  s.K.net.state.wan = false;
  const down = await s.run('sudo apt update');
  assert.match(down.out, /Err:1 http:\/\/http\.kali\.org\/kali kali-rolling InRelease\n  Could not connect to http\.kali\.org:80 /);
  assert.match(down.err, /Warning: Failed to fetch http:\/\/http\.kali\.org\/kali\/dists\/kali-rolling\/InRelease/);
  const inst = await s.run('sudo apt install -y ncdu');
  assert.equal(inst.code, 100);
  assert.match(inst.err, /Error: Unable to fetch some archives/);
});

test('apt upgrade installs the pending upgrades', async () => {
  const s = await sim();
  const list = await s.out('apt list --upgradable 2>/dev/null');
  assert.match(list, /^curl\/kali-rolling 8\.17\.0-2 amd64 \[upgradable from: 8\.17\.0-1\]$/m);
  const r = await s.run('sudo apt-get upgrade -y');
  assert.match(r.out, /The following packages will be upgraded:\n/);
  assert.match(r.out, /Unpacking curl \(8\.17\.0-2\) over \(8\.17\.0-1\) \.\.\./);
  assert.equal(s.machine.packages.get('curl').version, '8.17.0-2');
  assert.equal((await s.out('apt list --upgradable 2>/dev/null')), 'Listing... Done\n');
});

test('apt search, show, policy, errors', async () => {
  const s = await sim();
  const se = await s.out('apt search ncdu 2>/dev/null');
  assert.match(se, /^Sorting\.\.\. Done\nFull Text Search\.\.\. Done\n/);
  assert.match(se, /^ncdu\/kali-rolling 1\.22-1 amd64\n  ncurses disk usage viewer\n\n/m);
  const w = await s.run('apt search ncdu');
  assert.match(w.err, /WARNING: apt does not have a stable CLI interface/);
  assert.match(await s.out('apt show curl'), /^Package: curl\nVersion: 8\.17\.0-2\n/);
  assert.equal((await s.run('apt show nonesuch')).code, 100);
  const pol = await s.out('apt-cache policy curl');
  assert.match(pol, /^curl:\n  Installed: 8\.17\.0-1\n  Candidate: 8\.17\.0-2\n  Version table:\n/);
  assert.match(await s.out('apt-cache policy ncdu'), /Installed: \(none\)/);
  const inv = await s.run('apt frobnicate');
  assert.equal(inv.err, 'Error: Invalid operation frobnicate\n');
  const opt = await s.run('apt --bogus install x');
  assert.match(opt.err, /Command line option --bogus is not understood/);
  assert.match(await s.out('apt --version'), /^apt 3\.1\.9 \(amd64\)/);
  assert.match((await s.run('apt-get source nmap')).err, /deb-src/);
});

test('apt essential packages need the phrase', async () => {
  const s = await sim();
  const r = await s.run('sudo apt remove -y coreutils');
  assert.equal(r.code, 100);
  assert.match(r.err, /Essential packages were removed/);
});

test('apt autoremove removes orphaned dependencies', async () => {
  const s = await sim();
  await s.run('sudo apt install -y nginx');
  assert.match((await s.run('apt list --installed nginx-common 2>/dev/null')).out, /\[installed,automatic\]/);
  await s.run('sudo apt remove -y nginx');
  const r = await s.run('sudo apt autoremove -y');
  assert.match(r.out, /REMOVING:\n  nginx-common/);
});

test('dpkg -l: real table layout, patterns, rc and not found', async () => {
  const s = await sim();
  const r = await s.run('dpkg -l bash coreutils');
  const lines = r.out.split('\n');
  assert.equal(lines[0], 'Desired=Unknown/Install/Remove/Purge/Hold');
  assert.equal(lines[3], '||/ Name           Version      Architecture Description');
  assert.equal(lines[4], '+++-==============-============-============-=================================');
  assert.equal(lines[5], 'ii  bash           5.3-1        amd64        GNU Bourne Again SHell');
  const none = await s.run('dpkg -l nonesuch');
  assert.equal(none.code, 1);
  assert.equal(none.err, 'dpkg-query: no packages found matching nonesuch\n');
  assert.match((await s.run('dpkg-query -l "lib*"')).out, /^ii  libc6 +2\.41-12/m);
});

test('dpkg -s, -L, -S, -W, --get-selections', async () => {
  const s = await sim();
  assert.match(await s.out('dpkg -s bash'), /^Package: bash\nStatus: install ok installed\n/);
  const miss = await s.run('dpkg -s ncdu');
  assert.equal(miss.code, 1);
  assert.equal(miss.err, "dpkg-query: package 'ncdu' is not installed and no information is available\nUse dpkg --info (= dpkg-deb --info) to examine archive files.\n");
  assert.equal((await s.run('dpkg -L ncdu')).err, "dpkg-query: package 'ncdu' is not installed\nUse dpkg --contents (= dpkg-deb --contents) to list archive files contents.\n");
  assert.match(await s.out('dpkg -L sudo'), /^\/\.\n\/usr\n\/usr\/bin\n\/usr\/bin\/sudo\n/);
  assert.equal(await s.out('dpkg -S /usr/bin/sudo'), 'sudo: /usr/bin/sudo\n');
  assert.equal((await s.run('dpkg -S /nope')).err, 'dpkg-query: no path found matching pattern /nope\n');
  assert.equal(await s.out("dpkg-query -W -f='${Package} ${Version}\\n' bash"), 'bash 5.3-1\n');
  assert.equal(await s.out('dpkg-query -W bash'), 'bash\t5.3-1\n');
  assert.equal(await s.out('dpkg --get-selections bash libc6'), 'bash\t\t\t\t\t\tinstall\nlibc6\t\t\t\t\t\tinstall\n');
  assert.equal(await s.out('dpkg --print-architecture'), 'amd64\n');
  assert.equal(await s.out('dpkg -l | grep -c "^ii"') > '0', true);
});

test('dpkg -i and removal need root and report the real errors', async () => {
  const s = await sim();
  const r = await s.run('dpkg -i x.deb');
  assert.equal(r.code, 2);
  assert.equal(r.err, 'dpkg: error: requested operation requires superuser privilege\n');
  assert.equal((await s.run('sudo dpkg -i /tmp/missing.deb')).err, "dpkg: error: cannot access archive '/tmp/missing.deb': No such file or directory\n");
  await s.run('echo junk > /tmp/junk.deb');
  assert.match((await s.run('sudo dpkg -i /tmp/junk.deb')).err, /dpkg-deb: error: '\/tmp\/junk\.deb' is not a Debian format archive/);
  assert.equal((await s.run('sudo dpkg -r nonesuch')).err, "dpkg: warning: ignoring request to remove nonesuch which isn't installed\n");
  const rm = await s.run('sudo dpkg --purge nano');
  assert.match(rm.out, /Removing nano \(8\.5-1\) \.\.\.\nPurging configuration files for nano/);
  assert.equal(s.machine.packages.has('nano'), false);
  const bad = await s.run('dpkg --foo');
  assert.equal(bad.code, 2);
  assert.match(bad.err, /^dpkg: error: unknown option --foo\n/);
  assert.match((await s.run('dpkg')).err, /need an action option/);
  assert.match(await s.out('dpkg --version'), /^Debian 'dpkg' package management program version/);
});

test('useradd, usermod, userdel, groupadd, groupdel as root', async () => {
  const s = await sim();
  const { machine } = s;
  assert.equal((await s.run('useradd bob')).err, 'useradd: Permission denied.\nuseradd: cannot lock /etc/passwd; try again later.\n');
  assert.equal((await s.run('sudo useradd -m -s /bin/bash -c "Bob B" -G sudo,users bob')).code, 0);
  const bob = machine.userByName('bob');
  assert.deepEqual([bob.uid, bob.gid, bob.home, bob.shell, bob.gecos], [1001, 1001, '/home/bob', '/bin/bash', 'Bob B']);
  assert.equal(await s.out('getent passwd bob'), 'bob:x:1001:1001:Bob B:/home/bob:/bin/bash\n');
  assert.equal(await s.out('getent group sudo'), 'sudo:x:27:kali,bob\n');
  const home = await s.out('sudo ls -la /home/bob');
  assert.match(home, /drwx------ +2 bob +bob .* \.\n/);
  assert.match(home, / bob +bob +\d+ .* \.bashrc\n/);
  assert.equal((await s.run('sudo useradd bob')).err, "useradd: user 'bob' already exists\n");
  assert.equal((await s.run('sudo useradd -g nogrp x')).err, "useradd: group 'nogrp' does not exist\n");
  assert.equal((await s.run('sudo useradd -u 1000 y')).err, 'useradd: UID 1000 is not unique\n');
  assert.equal((await s.run('sudo useradd "bad name"')).err, "useradd: invalid user name 'bad name': use --badname to ignore\n");
  assert.equal((await s.run('sudo usermod -aG wireshark bob')).code, 0);
  assert.deepEqual(machine.groupByName('wireshark').members.includes('bob'), true);
  assert.equal((await s.run('sudo usermod -s /bin/zsh bob')).code, 0);
  assert.equal(machine.userByName('bob').shell, '/bin/zsh');
  assert.equal((await s.run('sudo usermod -aG nogrp bob')).err, "usermod: group 'nogrp' does not exist\n");
  assert.equal((await s.run('sudo usermod -s /bin/sh nouser')).err, "usermod: user 'nouser' does not exist\n");
  assert.equal((await s.run('sudo usermod -a bob')).err, 'usermod: option -a requires option -G\n');
  await s.run('sudo usermod -l robert bob');
  assert.ok(machine.userByName('robert') && !machine.userByName('bob'));
  assert.equal((await s.run('sudo groupadd pentest')).code, 0);
  assert.equal(machine.groupByName('pentest').gid, 1002);
  assert.equal((await s.run('sudo groupadd pentest')).err, "groupadd: group 'pentest' already exists\n");
  assert.equal((await s.run('sudo groupdel bob')).err, "groupdel: cannot remove the primary group of user 'robert'\n");
  assert.equal((await s.run('sudo groupdel pentest')).code, 0);
  const del = await s.run('sudo userdel -r robert');
  assert.equal(del.code, 0);
  assert.match(del.err, /userdel: robert mail spool \(\/var\/mail\/robert\) not found/);
  assert.equal(machine.vfs.exists('/home/bob'), false);
  assert.equal(machine.groupByName('bob').gid, 1001, 'userdel only removes a group named like the user');
  assert.equal((await s.run('sudo userdel ghost')).err, "userdel: user 'ghost' does not exist\n");
});

test('passwd: own password needs the current one, root can set any', async () => {
  const s = await sim();
  s.term.feed('wrong');
  const bad = await s.run('passwd');
  assert.equal(bad.code, 10);
  assert.match(bad.err, /passwd: Authentication token manipulation error\npasswd: password unchanged/);
  s.term.feed('kali'); s.term.feed('S3cret!pw'); s.term.feed('S3cret!pw');
  const ok = await s.run('passwd');
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /Changing password for kali\.\n/);
  assert.match(ok.out, /passwd: password updated successfully/);
  assert.equal(s.machine.passwords.kali, 'S3cret!pw');
  s.machine.sudoStamp.kali = s.K.clock.now();
  s.term.feed('S3cret!pw'); s.term.feed('abc'); s.term.feed('abcdefgh'); s.term.feed('different');
  const mismatch = await s.run('passwd');
  assert.match(mismatch.err, /BAD PASSWORD: it is WAY too short/);
  assert.match(mismatch.err, /Sorry, passwords do not match\./);
  assert.equal((await s.run('passwd root')).err, 'passwd: You may not view or modify password information for root.\n');
  s.term.feed('lab-pass'); s.term.feed('lab-pass');
  assert.equal((await s.run('sudo passwd kali')).code, 0);
  assert.equal(s.machine.passwords.kali, 'lab-pass');
  assert.equal((await s.run('sudo passwd ghost')).err, "passwd: user 'ghost' does not exist\n");
  assert.equal(await s.out('sudo passwd -S kali'), 'kali P ' + s.K.util.isoDate(s.K.clock.now()).slice(0, 10) + ' 0 99999 7 -1\n');
  await s.run('sudo passwd -l kali');
  assert.equal(s.machine.passwords.kali, null);
  assert.match(await s.out('sudo passwd -S kali'), /^kali L /);
  await s.run('sudo passwd -u kali');
  assert.equal(s.machine.passwords.kali, 'lab-pass');
});

test('adduser flow, chsh and getent', async () => {
  const s = await sim();
  assert.equal((await s.run('adduser eve')).err, 'adduser: Only root may add a user or group to the system.\n');
  for (const a of ['pw12345', 'pw12345', 'Eve Adams', '', '', '', '', 'y']) s.term.feed(a);
  const r = await s.run('sudo adduser eve');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^info: Adding user `eve' \.\.\.\ninfo: Selecting UID\/GID from range 1000 to 59999 \.\.\.\ninfo: Adding new group `eve' \(1001\) \.\.\.\ninfo: Adding new user `eve' \(1001\) with group `eve \(1001\)' \.\.\.\ninfo: Creating home directory `\/home\/eve' \.\.\.\ninfo: Copying files from `\/etc\/skel' \.\.\.\n/);
  assert.match(r.out, /Changing the user information for eve\nEnter the new value, or press ENTER for the default\n/);
  assert.equal(s.machine.userByName('eve').gecos, 'Eve Adams,,,,');
  assert.equal(s.machine.passwords.eve, 'pw12345');
  assert.equal((await s.run('sudo adduser eve')).err, "fatal: The user `eve' already exists.\n");
  assert.equal(await s.out('sudo adduser eve sudo'), "info: Adding user `eve' to group `sudo' ...\n");
  assert.equal((await s.run('sudo adduser --disabled-password --gecos "" tmp1')).code, 0);
  assert.equal((await s.run('sudo adduser nosuch sudo')).err, "fatal: The user `nosuch' does not exist.\n");
  // chsh
  s.term.feed('kali');
  const bad = await s.run('chsh -s /bin/nonexistent');
  assert.equal(bad.err, 'chsh: "/bin/nonexistent" is not listed in /etc/shells.\nUse chsh -l to see list.\n');
  s.term.feed('kali');
  assert.equal((await s.run('chsh -s /bin/bash')).code, 0);
  assert.equal(s.machine.userByName('kali').shell, '/bin/bash');
  assert.match(await s.out('chsh -l'), /^\/bin\/sh\n/);
  // getent
  assert.equal(await s.out('getent passwd kali'), 'kali:x:1000:1000:Kali,,,:/home/kali:/bin/bash\n');
  const none = await s.run('getent passwd nouser');
  assert.equal(none.code, 2);
  assert.equal(none.out, '');
  assert.equal(await s.out('getent hosts localhost'), '127.0.0.1       localhost\n');
  assert.equal(await s.out('getent services ssh'), 'ssh                   22/tcp\n');
  assert.equal(await s.out('getent services 25/tcp'), 'smtp                  25/tcp mail\n');
  assert.equal(await s.out('getent protocols tcp'), 'tcp                   6 TCP\n');
  assert.match(await s.out('getent hosts web01.halcyon.lab'), /^10\.10\.10\.10 +web01\.halcyon\.lab\n$/);
  const unk = await s.run('getent foo');
  assert.equal(unk.code, 1);
  assert.equal(unk.err, "Unknown database: foo\nTry `getent --help' or `getent --usage' for more information.\n");
  assert.equal((await s.run('getent')).err, "getent: wrong number of arguments\nTry `getent --help' or `getent --usage' for more information.\n");
  assert.equal(await s.out('getent passwd | grep -c :'), '19\n');
});

test('lscpu, lsmod, lsusb, lspci, vmstat', async () => {
  const s = await sim();
  const cpu = await s.out('lscpu');
  assert.match(cpu, /^Architecture:                            x86_64\nCPU op-mode\(s\):                          32-bit, 64-bit\n/);
  assert.match(cpu, /^Model name:                              Intel\(R\) Core\(TM\) i7-9750H CPU @ 2\.60GHz$/m);
  assert.match(cpu, /^CPU\(s\):                                  2$/m);
  assert.match(cpu, /^Vulnerability Spectre v2: +Mitigation/m);
  assert.equal(await s.out('lscpu -V'), 'lscpu from util-linux 2.41.2\n');
  assert.equal((await s.run('lscpu -z')).err, "lscpu: invalid option -- 'z'\nTry 'lscpu --help' for more information.\n");
  const mods = await s.out('lsmod');
  assert.match(mods, /^Module                  Size  Used by\nvsock_loopback         12288  0\n/);
  assert.match(await s.out('lsmod | grep -c ext4'), /^\d+\n/);
  assert.match(await s.out('lsusb'), /^Bus 002 Device 001: ID 1d6b:0003 Linux Foundation 3\.0 root hub\nBus 001 Device 002: .*\nBus 001 Device 001: ID 1d6b:0002 Linux Foundation 2\.0 root hub\n$/);
  assert.match(await s.out('lsusb -t'), /^\/:  Bus 001\.Port 001: Dev 001, Class=root_hub/);
  assert.match(await s.out('lspci'), /^00:00\.0 Host bridge: Intel Corporation .*\n00:01\.0 VGA compatible controller: /);
  assert.match(await s.out('lspci -nn'), /Ethernet controller \[0200\]: Red Hat, Inc\. Virtio 1\.0 network device \[1af4:1041\] \(rev 01\)/);
  assert.match(await s.out('lspci -k | grep -A1 Ethernet'), /Kernel driver in use: virtio-pci/);
  const vm = await s.out('vmstat');
  const lines = vm.split('\n');
  assert.equal(lines[0], 'procs -----------memory---------- ---swap-- -----io---- -system-- -------cpu-------');
  assert.equal(lines[1], ' r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st gu');
  assert.equal(lines[2].length, lines[1].length);
  const rep = await s.out('vmstat 1 3');
  assert.equal(rep.trim().split('\n').length, 5);
  assert.match(await s.out('vmstat -s'), /^ +\d+ K total memory\n +\d+ K used memory\n/);
  assert.match((await s.run('vmstat --bogus')).err, /^vmstat: unrecognized option '--bogus'\n\nUsage:\n vmstat/);
});

test('timedatectl, hostnamectl, locale, lastlog, logname', async () => {
  const s = await sim();
  const t = await s.out('timedatectl');
  assert.match(t, /^               Local time: Fri 2026-11-13 14:30:00 UTC\n           Universal time: Fri 2026-11-13 14:30:00 UTC\n/);
  assert.match(t, /^System clock synchronized: yes\n              NTP service: active\n          RTC in local TZ: no\n$/m);
  assert.equal((await s.run('timedatectl set-timezone Europe/Berlin')).err, 'Failed to set time zone: Interactive authentication required.\n');
  await s.run('sudo timedatectl set-timezone Europe/Berlin');
  assert.match(await s.out('timedatectl'), /Local time: Fri 2026-11-13 15:30:00 CET\n[\s\S]*Time zone: Europe\/Berlin \(CET, \+0100\)/);
  assert.match(await s.out('timedatectl show'), /^Timezone=Europe\/Berlin\nLocalRTC=no\n/);
  const h = await s.out('hostnamectl');
  assert.match(h, /^ Static hostname: kali\n       Icon name: computer-vm\n/);
  assert.match(h, /^Operating System: Kali GNU\/Linux Rolling\n          Kernel: Linux 7\.1\.5-kali1-amd64\n/m);
  assert.equal((await s.run('hostnamectl set-hostname lab')).err, 'Could not set static hostname: Interactive authentication required.\n');
  await s.run('sudo hostnamectl set-hostname lab-kali');
  assert.equal(s.machine.hostname, 'lab-kali');
  assert.equal(await s.out('hostnamectl hostname'), 'lab-kali\n');
  const loc = await s.out('locale');
  assert.match(loc, /^LANG=[^\n]*\nLANGUAGE=\nLC_CTYPE="[^"]+"\n/);
  assert.match(loc, /LC_IDENTIFICATION="[^"]+"\nLC_ALL=\n$/);
  assert.equal(await s.out('locale -a'), 'C\nC.utf8\nen_US.utf8\nPOSIX\n');
  const ll = await s.out('lastlog');
  assert.match(ll, /^Username         Port     From                                       Latest\nroot                                                                \*\*Never logged in\*\*\n/);
  assert.match(ll, /^kali +pts\/0 +\w{3} \w{3} \d\d \d\d:\d\d:\d\d \+0000 2026$/m);
  assert.equal((await s.run('lastlog -u nobody2')).err, 'lastlog: Unknown user: nobody2\n');
  assert.equal(await s.out('logname'), 'kali\n');
  assert.equal((await s.run('logname --bogus')).err, "logname: unrecognized option '--bogus'\nTry 'logname --help' for more information.\n");
  assert.match(await s.out('logname --version'), /^logname \(GNU coreutils\) /);
});

test('nice and nohup', async () => {
  const s = await sim();
  assert.equal(await s.out('nice'), '0\n');
  assert.equal(await s.out('nice -n 5 nice'), '5\n');
  assert.equal(await s.out('nice nice'), '10\n');
  assert.equal(await s.out('nice -n 30 nice'), '19\n');
  assert.equal(await s.out('nice -5 nice'), '5\n');
  const neg = await s.run('nice -n -5 nice');
  assert.equal(neg.err, 'nice: cannot set niceness: Permission denied\n');
  assert.equal(neg.out, '0\n');
  assert.equal((await s.run('nice -n abc true')).err, "nice: invalid adjustment 'abc'\n");
  assert.equal((await s.run('nice -n abc true')).code, 125);
  assert.equal((await s.run('nice nosuchcmd')).code, 127);
  assert.equal((await s.run('nice --bogus')).err, "nice: unrecognized option '--bogus'\nTry 'nice --help' for more information.\n");
  const nh = await s.run('nohup echo hi');
  assert.equal(nh.code, 0);
  assert.equal(await s.out('nohup echo hi < /dev/null | cat'), 'hi\n');
  const miss = await s.run('nohup nosuchcmd');
  assert.equal(miss.code, 127);
  assert.equal(miss.err, "nohup: ignoring input\nnohup: failed to run command 'nosuchcmd': No such file or directory\n");
  const none = await s.run('nohup');
  assert.equal(none.err, "nohup: missing operand\nTry 'nohup --help' for more information.\n");
  assert.equal(none.code, 125);
  assert.match(await s.out('nohup --version'), /^nohup \(GNU coreutils\) /);
});

test('crontab: install, list, remove, validation', async () => {
  const s = await sim();
  const none = await s.run('crontab -l');
  assert.equal(none.code, 1);
  assert.equal(none.err, 'no crontab for kali\n');
  assert.equal((await s.run('crontab -r')).err, 'no crontab for kali\n');
  assert.equal((await s.run('echo "*/5 * * * * /home/kali/scan.sh" | crontab -')).code, 0);
  assert.equal(await s.out('crontab -l'), '*/5 * * * * /home/kali/scan.sh\n');
  const st = s.machine.vfs.stat('/var/spool/cron/crontabs/kali');
  assert.equal(st.mode & 0o7777, 0o600);
  assert.equal(st.uid, 1000);
  assert.equal(await s.out('sudo ls /var/spool/cron/crontabs'), 'kali\n');
  const bad = await s.run('echo "61 * * * * x" | crontab -');
  assert.equal(bad.code, 1);
  assert.equal(bad.err, '"-":1: bad minute\nerrors in crontab file, can\'t install.\n');
  assert.equal((await s.run('echo "* * * * *" | crontab -')).err, '"-":1: bad command\nerrors in crontab file, can\'t install.\n');
  assert.equal((await s.run('crontab /nope')).err, 'crontab: /nope: No such file or directory\n');
  assert.equal((await s.run('crontab -u root -l')).err, 'must be privileged to use -u\n');
  assert.equal(await s.out('sudo crontab -u kali -l'), '*/5 * * * * /home/kali/scan.sh\n');
  assert.equal((await s.run('crontab -r')).code, 0);
  assert.equal((await s.run('crontab -l')).code, 1);
  s.term.feed('1');
  const e = await s.run('crontab -e');
  assert.match(e.err, /no crontab for kali - using an empty one\n/);
  assert.match(e.out, /Select an editor\./);
  assert.match(e.err, /crontab: no changes made to crontab/);
});

test('reboot, poweroff, halt and shutdown emit power events', async () => {
  const s = await sim();
  const events = [];
  s.K.events.on('power', (e) => events.push(e.action));
  const nr = await s.run('reboot');
  assert.equal(nr.code, 1);
  assert.equal(nr.err, 'Failed to set wall message, ignoring: Interactive authentication required.\nFailed to reboot system via logind: Interactive authentication required.\nFailed to open initctl fifo: Permission denied\nFailed to talk to init daemon.\n');
  assert.match((await s.run('poweroff')).err, /Failed to power off system via logind/);
  assert.match((await s.run('shutdown now')).err, /Failed to call ScheduleShutdown in logind, proceeding with immediate shutdown: Interactive authentication required\./);
  assert.deepEqual(events, []);
  assert.equal((await s.run('sudo reboot')).code, 0);
  assert.equal((await s.run('sudo poweroff')).out, '');
  assert.equal((await s.run('sudo halt')).code, 0);
  const now = await s.run('sudo shutdown -h now');
  assert.match(now.out, /^\nBroadcast message from root@kali on pts\/0 \(Fri 2026-11-13 14:30:00 UTC\):\n\nThe system will power off now!\n\n$/);
  await s.run('sudo shutdown -r now "back soon"');
  assert.deepEqual(events, ['reboot', 'poweroff', 'halt', 'poweroff', 'reboot']);
  const sched = await s.run('sudo shutdown +5');
  assert.equal(sched.err, "Shutdown scheduled for Fri 2026-11-13 14:35:00 UTC, use 'shutdown -c' to cancel.\n");
  assert.equal(events.length, 5, 'a scheduled shutdown does not fire immediately');
  assert.match(await s.out('sudo shutdown --show'), /Shutdown scheduled for/);
  assert.match(await s.out('sudo shutdown -c'), /The system shutdown has been cancelled/);
  assert.equal((await s.run('sudo shutdown -h bogus')).err, 'Failed to parse time specification: bogus\n');
  assert.equal((await s.run('sudo reboot --bogus')).err, "reboot: unrecognized option '--bogus'\n");
  assert.match(await s.out('reboot --help'), /^reboot \[OPTIONS\.\.\.\]\n\nReboot the system\./);
});

test('neofetch, fastfetch and the kali-* notes', async () => {
  const s = await sim();
  const nf = await s.out('neofetch');
  assert.match(nf, /kali@kali\n/);
  assert.match(nf, /OS: Kali GNU\/Linux Rolling x86_64\n/);
  assert.match(nf, /Kernel: 7\.1\.5-kali1-amd64\n/);
  assert.match(nf, /Packages: \d+ \(dpkg\)\n/);
  assert.match(nf, /Memory: \d+MiB \/ \d+MiB/);
  assert.match(nf, /^\.{14}/);
  const ff = await s.out('fastfetch');
  assert.match(ff, /OS: Kali GNU\/Linux Rolling x86_64\n/);
  assert.match(ff, /Kernel: Linux 7\.1\.5-kali1-amd64\n/);
  assert.match(ff, /Local IP \(eth0\): 10\.10\.10\.5\/24\n/);
  assert.match(await s.out('fastfetch -l none | head -1'), /^kali@kali\n$/);
  assert.match(await s.out('kali-tweaks'), /not simulated in Kalima/);
  assert.match(await s.out('kali-undercover'), /Nothing was changed on this machine\./);
  assert.match(await s.out('neofetch --version'), /^Neofetch /);
});
