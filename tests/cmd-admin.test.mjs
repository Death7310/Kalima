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
  const r = await s.run('apt install tree');
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
  const r = await s.run('sudo apt install tree');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Installing:\n  tree\n\nSummary:\n  Upgrading: 0, Installing: 1, Removing: 0, Not Upgrading: \d+\n  Download size: .* kB\n  Space needed: .* \/ .* GB available/);
  assert.match(r.out, /Get:1 http:\/\/http\.kali\.org\/kali kali-rolling\/main amd64 tree amd64 2\.2\.1-1 \[/);
  assert.match(r.out, /Selecting previously unselected package tree\./);
  assert.match(r.out, /Unpacking tree \(2\.2\.1-1\) \.\.\.\nSetting up tree \(2\.2\.1-1\) \.\.\./);
  assert.equal(s.machine.packages.get('tree').status, 'installed');
  assert.match(await s.out('apt list --installed tree 2>/dev/null'), /^tree\/kali-rolling,now 2\.2\.1-1 amd64 \[installed\]$/m);
  assert.match(await s.out('cat /var/log/apt/history.log'), /Commandline: apt install tree\nRequested-By: kali \(1000\)\nInstall: tree:amd64 \(2\.2\.1-1\)/);
  assert.match(await s.out('cat /var/log/dpkg.log'), /install tree:amd64 <none> 2\.2\.1-1\n.*status half-installed tree:amd64/);
  const again = await s.run('sudo apt install tree');
  assert.match(again.out, /tree is already the newest version \(2\.2\.1-1\)\./);
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
  const inst = await s.run('sudo apt install -y tree');
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
  const se = await s.out('apt search tree 2>/dev/null');
  assert.match(se, /^Sorting\.\.\. Done\nFull Text Search\.\.\. Done\n/);
  assert.match(se, /^tree\/kali-rolling 2\.2\.1-1 amd64\n  displays an indented directory tree, in color\n\n/m);
  const w = await s.run('apt search tree');
  assert.match(w.err, /WARNING: apt does not have a stable CLI interface/);
  assert.match(await s.out('apt show curl'), /^Package: curl\nVersion: 8\.17\.0-2\n/);
  assert.equal((await s.run('apt show nonesuch')).code, 100);
  const pol = await s.out('apt-cache policy curl');
  assert.match(pol, /^curl:\n  Installed: 8\.17\.0-1\n  Candidate: 8\.17\.0-2\n  Version table:\n/);
  assert.match(await s.out('apt-cache policy tree'), /Installed: \(none\)/);
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
  const miss = await s.run('dpkg -s tree');
  assert.equal(miss.code, 1);
  assert.equal(miss.err, "dpkg-query: package 'tree' is not installed and no information is available\nUse dpkg --info (= dpkg-deb --info) to examine archive files.\n");
  assert.equal((await s.run('dpkg -L tree')).err, "dpkg-query: package 'tree' is not installed\nUse dpkg --contents (= dpkg-deb --contents) to list archive files contents.\n");
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
