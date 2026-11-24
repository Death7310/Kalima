// Tests for the everyday file and directory commands (src/js/40-cmd-fs.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

async function setup() {
  const sim = await boot();
  const sh = async (line) => sim.run(line);
  const out = async (line) => (await sim.run(line)).out;
  return { sim, sh, out };
}

/* ---------------------------------------------------------------- ls */

test('ls lists one name per line when not a terminal, hides dotfiles', async () => {
  const { sh, out } = await setup();
  await sh('mkdir /tmp/t1; cd /tmp/t1; touch b a .hid C');
  assert.equal(await out('ls'), 'a\nb\nC\n');
  assert.equal(await out('ls -a'), '.\n..\na\nb\nC\n.hid\n');
  assert.equal(await out('ls -A'), 'a\nb\nC\n.hid\n');
  assert.equal(await out('ls -r'), 'C\nb\na\n');
});

test('ls -l layout, total line, owners and symlinks', async () => {
  const { sh, out } = await setup();
  await sh('mkdir /tmp/t2; cd /tmp/t2; echo hello > f; mkdir d; ln -s f l');
  const o = (await out('ls -l')).split('\n');
  assert.equal(o[0], 'total 8');
  assert.match(o[1], /^drwxr-xr-x 2 kali kali 4096 \w{3} [ \d]\d [\d:]{5} d$/);
  assert.match(o[2], /^-rw-r--r-- 1 kali kali    6 \w{3} [ \d]\d [\d:]{5} f$/);
  assert.match(o[3], /^lrwxrwxrwx 1 kali kali    1 \w{3} [ \d]\d [\d:]{5} l -> f$/);
  assert.match(await out('ls -n f'), /^-rw-r--r-- 1 1000 1000 6 /);
});

test('ls -h, -S, -t, -d, -F, -i, -1, -R', async () => {
  const { sh, out } = await setup();
  await sh('mkdir /tmp/t3; cd /tmp/t3; mkdir sub; echo a > sub/x; printf "%3000s" x > big; echo s > small; chmod +x small');
  assert.match(await out('ls -lh big'), / 3\.0K /);
  assert.equal(await out('ls -S'), 'sub\nbig\nsmall\n');
  await sh('touch -d "2026-01-01" big; touch -d "2026-06-01" small; touch -d "2026-03-01" sub');
  assert.equal(await out('ls -t'), 'small\nsub\nbig\n');
  assert.equal(await out('ls -tr'), 'big\nsub\nsmall\n');
  assert.equal(await out('ls -d sub'), 'sub\n');
  assert.equal(await out('ls -d *'), 'big\nsmall\nsub\n');
  assert.equal(await out('ls -F'), 'big\nsmall*\nsub/\n');
  assert.match(await out('ls -i small'), /^\d+ small\n$/);
  assert.equal(await out('ls -R'), '.:\nbig\nsmall\nsub\n\n./sub:\nx\n');
  assert.equal(await out('ls -1 sub'), 'x\n');
});

test('ls with several operands prints headers; errors exit 2', async () => {
  const { sh, out } = await setup();
  await sh('mkdir /tmp/t4; cd /tmp/t4; mkdir a b; touch a/1 b/2 file');
  assert.equal(await out('ls file a b'), 'file\n\na:\n1\n\nb:\n2\n');
  const r = await sh('ls /nonexistent');
  assert.equal(r.err, "ls: cannot access '/nonexistent': No such file or directory\n");
  assert.equal(r.code, 2);
  await sh('mkdir /tmp/t4/secret; chmod 000 /tmp/t4/secret');
  const p = await sh('ls /tmp/t4/secret');
  assert.equal(p.err, "ls: cannot open directory '/tmp/t4/secret': Permission denied\n");
  assert.equal(p.code, 2);
});

test('ls rejects unknown options like GNU ls', async () => {
  const { sh } = await setup();
  const r = await sh('ls -y');
  assert.equal(r.code, 2);
  assert.equal(r.err, "ls: invalid option -- 'y'\nTry 'ls --help' for more information.\n");
  assert.match((await sh('ls --version')).out, /^ls \(GNU coreutils\)/);
  assert.match((await sh('ls --help')).out, /^Usage: ls \[OPTION\]\.\.\. \[FILE\]\.\.\./);
});

test('ls colours on a terminal and with --color=always', async () => {
  const { sim, sh } = await setup();
  await sh('mkdir /tmp/t5; cd /tmp/t5; mkdir d; touch f x; chmod +x x; ln -s d l; mkdir tw; chmod 1777 tw; touch su; chmod 4755 su');
  const c = (await sh('ls --color=always')).out;
  assert.ok(c.includes('\x1b[01;34md\x1b[0m'), 'directory bold blue');
  assert.ok(c.includes('\x1b[01;36ml\x1b[0m'), 'symlink bold cyan');
  assert.ok(c.includes('\x1b[01;32mx\x1b[0m'), 'executable bold green');
  assert.ok(c.includes('\x1b[37;41msu\x1b[0m'), 'setuid white on red');
  assert.ok(c.includes('\x1b[30;42mtw\x1b[0m'), 'sticky other-writable black on green');
  assert.ok(!(await sh('ls --color=never')).out.includes('\x1b'));
  assert.ok(!(await sh('ls --color=auto')).out.includes('\x1b'), 'auto is off when piped');
  const t = await sim.type('cd /tmp/t5; ls --color=auto');
  assert.ok(!t.output.includes('\x1b'), 'type() strips ansi');
  assert.equal(t.output.trim().split(/\s+/).length, 6);
  assert.equal(t.output.trim().split('\n').length, 1, 'columns on a terminal');
});

test('ls quotes names with spaces on a terminal', async () => {
  const { sim, sh } = await setup();
  await sh("mkdir /tmp/t6; cd /tmp/t6; touch 'a b' c");
  const t = await sim.type('cd /tmp/t6; ls');
  assert.equal(t.output, "'a b'   c\n");
  assert.equal((await sh('cd /tmp/t6; ls')).out, 'a b\nc\n');
});

/* ---------------------------------------------------------------- cat */

test('cat prints files, stdin, and handles errors', async () => {
  const { sh, out } = await setup();
  await sh("printf 'one\\ntwo\\n' > /tmp/c1; printf 'three' > /tmp/c2");
  assert.equal(await out('cat /tmp/c1 /tmp/c2'), 'one\ntwo\nthree');
  assert.equal(await out('echo piped | cat'), 'piped\n');
  assert.equal(await out('echo piped | cat /tmp/c1 - /tmp/c1'), 'one\ntwo\npiped\none\ntwo\n');
  const r = await sh('cat /tmp/c1 /nope /tmp');
  assert.equal(r.err, 'cat: /nope: No such file or directory\ncat: /tmp: Is a directory\n');
  assert.equal(r.code, 1);
});

test('cat -n -b -s -E -T -A', async () => {
  const { sh, out } = await setup();
  await sh("printf 'a\\n\\n\\n\\tb\\n' > /tmp/c3");
  assert.equal(await out('cat -n /tmp/c3'), '     1\ta\n     2\t\n     3\t\n     4\t\tb\n');
  assert.equal(await out('cat -b /tmp/c3'), '     1\ta\n\n\n     2\t\tb\n');
  assert.equal(await out('cat -s /tmp/c3'), 'a\n\n\tb\n');
  assert.equal(await out('cat -E /tmp/c3'), 'a$\n$\n$\n\tb$\n');
  assert.equal(await out('cat -T /tmp/c3'), 'a\n\n\n^Ib\n');
  assert.equal(await out('cat -A /tmp/c3'), 'a$\n$\n$\n^Ib$\n');
  assert.equal(await out('printf "x" | cat -E'), 'x');
});

/* ---------------------------------------------------------------- head, tail */

test('head and tail count lines', async () => {
  const { sh, out } = await setup();
  await sh('seq 1 20 > /tmp/n');
  assert.equal(await out('head -n 3 /tmp/n'), '1\n2\n3\n');
  assert.equal(await out('head -2 /tmp/n'), '1\n2\n');
  assert.equal(await out('head -n -18 /tmp/n'), '1\n2\n');
  assert.equal(await out('head /tmp/n | wc -l'), '10\n');
  assert.equal(await out('head -c 5 /tmp/n'), '1\n2\n3');
  assert.equal(await out('tail -n 2 /tmp/n'), '19\n20\n');
  assert.equal(await out('tail -3 /tmp/n'), '18\n19\n20\n');
  assert.equal(await out('tail -n +19 /tmp/n'), '19\n20\n');
  assert.equal(await out('tail -c 3 /tmp/n'), '19\n20\n'.slice(-3));
  assert.equal(await out('seq 1 5 | tail -n 1'), '5\n');
  assert.equal(await out('seq 1 5 | head -n 1'), '1\n');
});

test('head and tail print headers for several files and report errors', async () => {
  const { sh, out } = await setup();
  await sh('echo a > /tmp/h1; echo b > /tmp/h2');
  assert.equal(await out('head -n 1 /tmp/h1 /tmp/h2'), '==> /tmp/h1 <==\na\n\n==> /tmp/h2 <==\nb\n');
  assert.equal(await out('tail -q -n 1 /tmp/h1 /tmp/h2'), 'a\nb\n');
  assert.equal(await out('tail -v -n 1 /tmp/h1'), '==> /tmp/h1 <==\na\n');
  const r = await sh('head /nope');
  assert.equal(r.err, "head: cannot open '/nope' for reading: No such file or directory\n");
  assert.equal(r.code, 1);
  assert.equal((await sh('tail -n x /tmp/h1')).err, "tail: invalid number of lines: 'x'\n");
});

test('tail -f follows appended data until interrupted', async () => {
  const { sim, sh } = await setup();
  await sh('echo first > /tmp/log');
  setTimeout(() => sim.term.raiseInterrupt(), 30);
  const p = sh('tail -f /tmp/log');
  await new Promise((r) => setTimeout(r, 5));
  await sim.shell.fs.append('/tmp/log', 'second\n');
  const r = await p;
  assert.match(r.out, /^first\n/);
});

/* ---------------------------------------------------------------- mkdir, rmdir, touch */

test('mkdir: -p, -v, -m and errors', async () => {
  const { sh, out } = await setup();
  assert.equal((await sh('mkdir /tmp/m1')).code, 0);
  const r = await sh('mkdir /tmp/m1');
  assert.equal(r.err, "mkdir: cannot create directory '/tmp/m1': File exists\n");
  assert.equal(r.code, 1);
  assert.equal((await sh('mkdir /tmp/x/y/z')).err, "mkdir: cannot create directory '/tmp/x/y/z': No such file or directory\n");
  assert.equal((await sh('mkdir -p /tmp/p/q/r')).code, 0);
  assert.equal((await sh('mkdir -p /tmp/p/q/r')).code, 0);
  assert.equal(await out('mkdir -pv /tmp/p/q/s/t'), "mkdir: created directory '/tmp/p/q/s'\nmkdir: created directory '/tmp/p/q/s/t'\n");
  assert.equal(await out('mkdir -v /tmp/v1'), "mkdir: created directory '/tmp/v1'\n");
  await sh('mkdir -m 700 /tmp/priv; mkdir -m u=rwx,go=rx /tmp/pub');
  assert.equal(await out('stat -c %a /tmp/priv /tmp/pub'), '700\n755\n');
  assert.equal((await sh('mkdir')).err, "mkdir: missing operand\nTry 'mkdir --help' for more information.\n");
  assert.equal((await sh('mkdir -m zz /tmp/zz')).err, "mkdir: invalid mode 'zz'\n");
  assert.equal((await sh('mkdir -Q x')).err, "mkdir: invalid option -- 'Q'\nTry 'mkdir --help' for more information.\n");
});

test('rmdir: empty only, -p, errors', async () => {
  const { sh, out } = await setup();
  await sh('mkdir -p /tmp/r/a/b; touch /tmp/r/f');
  assert.equal((await sh('rmdir /tmp/r/a')).err, "rmdir: failed to remove '/tmp/r/a': Directory not empty\n");
  assert.equal((await sh('rmdir /tmp/r/f')).err, "rmdir: failed to remove '/tmp/r/f': Not a directory\n");
  assert.equal((await sh('rmdir /tmp/r/none')).err, "rmdir: failed to remove '/tmp/r/none': No such file or directory\n");
  assert.equal((await sh('rmdir -p /tmp/r/a/b')).code, 1, 'stops at non-empty /tmp/r');
  assert.equal(await out('ls /tmp/r'), 'f\n');
  assert.equal(await out('rmdir -v /tmp/p1 2>&1; mkdir /tmp/p1; rmdir -v /tmp/p1'), "rmdir: removing directory, '/tmp/p1'\nrmdir: failed to remove '/tmp/p1': No such file or directory\nrmdir: removing directory, '/tmp/p1'\n");
});

test('touch creates files, sets dates, honours -c and -r', async () => {
  const { sh, out } = await setup();
  await sh('cd /tmp; touch a; touch -c nope');
  assert.equal(await out('ls /tmp/a /tmp/nope 2>&1'), "ls: cannot access '/tmp/nope': No such file or directory\n/tmp/a\n");
  await sh('touch -d "2020-05-17 10:30:00" /tmp/a');
  assert.equal(await out('stat -c %y /tmp/a'), '2020-05-17 10:30:00.000000000 +0000\n');
  await sh('touch -t 202101021504.05 /tmp/b; touch -r /tmp/a /tmp/c');
  assert.equal(await out('stat -c %Y /tmp/b'), String(Date.UTC(2021, 0, 2, 15, 4, 5) / 1000) + '\n');
  assert.equal(await out('stat -c %y /tmp/c'), '2020-05-17 10:30:00.000000000 +0000\n');
  assert.equal((await sh('touch -d garbage /tmp/a')).err, "touch: invalid date format 'garbage'\n");
  assert.equal((await sh('touch /nodir/x')).err, "touch: cannot touch '/nodir/x': No such file or directory\n");
  assert.equal((await sh('touch')).err, "touch: missing file operand\nTry 'touch --help' for more information.\n");
});

/* ---------------------------------------------------------------- cp, mv, rm, ln */

test('cp copies files, directories and several sources', async () => {
  const { sh, out } = await setup();
  await sh('mkdir -p /tmp/cp/src/sub /tmp/cp/dst; cd /tmp/cp; echo one > src/a; echo two > src/sub/b; echo x > f1; echo y > f2; chmod 750 f1');
  await sh('cp f1 g1');
  assert.equal(await out('cat g1; stat -c %a g1'), 'x\n750\n');
  assert.equal(await out('cp -v f1 f2 dst'), "'f1' -> 'dst/f1'\n'f2' -> 'dst/f2'\n");
  let r = await sh('cp src dst2');
  assert.equal(r.err, "cp: -r not specified; omitting directory 'src'\n");
  assert.equal(r.code, 1);
  assert.equal(await out('cp -rv src dst2'), "'src' -> 'dst2'\n'src/a' -> 'dst2/a'\n'src/sub' -> 'dst2/sub'\n'src/sub/b' -> 'dst2/sub/b'\n");
  assert.equal(await out('cat dst2/sub/b'), 'two\n');
  r = await sh('cp nope dst');
  assert.equal(r.err, "cp: cannot stat 'nope': No such file or directory\n");
  r = await sh('cp f1 f2 f1x');
  assert.equal(r.err, "cp: target 'f1x': No such file or directory\n");
  r = await sh('cp f1 f1');
  assert.equal(r.err, "cp: 'f1' and 'f1' are the same file\n");
  assert.equal((await sh('cp f1')).err, "cp: missing destination file operand after 'f1'\nTry 'cp --help' for more information.\n");
  r = await sh('cp -r src src/sub/inner');
  assert.equal(r.err, "cp: cannot copy a directory, 'src', into itself, 'src/sub/inner'\n");
});

test('cp -n -u -i -p -a', async () => {
  const { sim, sh, out } = await setup();
  await sh('cd /tmp; echo new > n1; echo old > n2; cp -n n1 n2');
  assert.equal(await out('cat /tmp/n2'), 'old\n');
  await sh('touch -d 2000-01-01 /tmp/n1; cp -u n1 n2');
  assert.equal(await out('cat /tmp/n2'), 'old\n');
  await sh('cp -p n1 n3');
  assert.equal(await out('stat -c %y /tmp/n3'), '2000-01-01 00:00:00.000000000 +0000\n');
  sim.term.feed('n', 'y');
  await sim.type('cd /tmp; cp -i n1 n2; cp -i n1 n2');
  assert.equal(await out('cat /tmp/n2'), 'new\n');
  await sh('ln -s n1 lk; cp -a lk lk2');
  assert.equal(await out('readlink /tmp/lk2'), 'n1\n');
});

test('mv renames, moves into directories and reports errors', async () => {
  const { sh, out } = await setup();
  await sh('mkdir -p /tmp/mv/d; cd /tmp/mv; echo a > a; echo b > b');
  assert.equal(await out('mv -v a c'), "renamed 'a' -> 'c'\n");
  assert.equal(await out('mv b c d; ls d'), 'b\nc\n');
  assert.equal((await sh('mv nope d')).err, "mv: cannot stat 'nope': No such file or directory\n");
  await sh('echo 1 > x; echo 2 > y; mv -n x y');
  assert.equal(await out('cat y'), '2\n');
  await sh('mv x y');
  assert.equal(await out('cat y'), '1\n');
  assert.equal((await sh('mv d d/e')).err, "mv: cannot move 'd' to a subdirectory of itself, 'd/e'\n");
  assert.equal((await sh('mv y')).err, "mv: missing destination file operand after 'y'\nTry 'mv --help' for more information.\n");
  assert.equal((await sh('mv y z w')).err, "mv: target 'w': No such file or directory\n");
});

test('rm removes files, refuses directories and /', async () => {
  const { sim, sh, out } = await setup();
  await sh('mkdir -p /tmp/rm/d/e; cd /tmp/rm; touch f g d/e/h');
  assert.equal(await out('rm -v f'), "removed 'f'\n");
  let r = await sh('rm d');
  assert.equal(r.err, "rm: cannot remove 'd': Is a directory\n");
  assert.equal(r.code, 1);
  r = await sh('rm nope');
  assert.equal(r.err, "rm: cannot remove 'nope': No such file or directory\n");
  assert.equal((await sh('rm -f nope')).code, 0);
  assert.equal(await out('rm -rv d'), "removed 'd/e/h'\nremoved directory 'd/e'\nremoved directory 'd'\n");
  await sh('mkdir empty; rm -d empty');
  assert.equal(await out('ls'), 'g\n');
  r = await sh('rm -rf /');
  assert.equal(r.err, "rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n");
  assert.equal(r.code, 1);
  assert.equal((await sh('rm -r .')).err, "rm: refusing to remove '.' or '..' directory: skipping '.'\n");
  assert.equal((await sh('rm')).err, "rm: missing operand\nTry 'rm --help' for more information.\n");
  sim.term.feed('n');
  await sim.type('cd /tmp/rm; rm -i g');
  assert.equal(await out('ls'), 'g\n');
  sim.term.feed('y');
  const t = await sim.type('cd /tmp/rm; rm -i g');
  assert.equal(t.output, "rm: remove regular empty file 'g'? y\n");
  assert.equal(await out('ls'), '');
});

test('ln makes hard and symbolic links', async () => {
  const { sh, out } = await setup();
  await sh('cd /tmp; echo data > t1');
  assert.equal(await out('ln -sv t1 s1'), "'s1' -> 't1'\n");
  assert.equal(await out('readlink s1; cat s1'), 't1\ndata\n');
  assert.equal((await sh('ln -s t1 s1')).err, "ln: failed to create symbolic link 's1': File exists\n");
  assert.equal((await sh('ln -sf t2 s1')).code, 0);
  assert.equal(await out('readlink s1'), 't2\n');
  await sh('ln t1 h1; echo more >> t1');
  assert.equal(await out('cat h1'), 'data\nmore\n');
  assert.equal((await sh('ln nope h2')).err, "ln: failed to access 'nope': No such file or directory\n");
  await sh('mkdir /tmp/lndir; ln -s /etc/hostname /tmp/lndir');
  assert.equal(await out('readlink /tmp/lndir/hostname'), '/etc/hostname\n');
});

/* ---------------------------------------------------------------- chmod, chown, chgrp, stat */

test('chmod octal and symbolic modes', async () => {
  const { sh, out } = await setup();
  await sh('cd /tmp; touch f; mkdir d');
  const mode = async (p) => (await out('stat -c %a ' + p)).trim();
  await sh('chmod 755 f'); assert.equal(await mode('f'), '755');
  await sh('chmod u-x,go-rx f'); assert.equal(await mode('f'), '600');
  await sh('chmod +x f'); assert.equal(await mode('f'), '711');
  await sh('chmod a=r f'); assert.equal(await mode('f'), '444');
  await sh('chmod g=u f'); assert.equal(await mode('f'), '444');
  await sh('chmod u+w,g+w f'); assert.equal(await mode('f'), '664');
  await sh('chmod -x f; chmod a-w f'); assert.equal(await mode('f'), '444');
  await sh('chmod 666 f; chmod -w f'); assert.equal(await mode('f'), '466', 'umask bits are not touched without ugoa');
  await sh('chmod 444 f');
  await sh('chmod u+s f'); assert.equal(await mode('f'), '4444');
  assert.equal(await out('ls -l f | cut -c1-10'), '-r-Sr--r--\n');
  await sh('chmod 4755 f'); assert.equal(await out('ls -l f | cut -c1-10'), '-rwsr-xr-x\n');
  await sh('chmod o+t d; chmod 755 f'); assert.equal(await out('ls -ld d | cut -c1-10'), 'drwxr-xr-t\n');
  await sh('chmod 0755 d; chmod g+s d'); assert.equal(await mode('d'), '2755');
  await sh('chmod 600 f; chmod a+X f d'); assert.equal(await mode('f'), '600');
  assert.equal(await mode('d'), '2755');
  await sh('touch x; chmod 744 x; chmod a+X x'); assert.equal(await mode('x'), '755');
  await sh('mkdir -p r/s; touch r/s/t; chmod -R 700 r'); assert.equal(await mode('r/s/t'), '700');
});

test('chmod verbose output, errors', async () => {
  const { sh, out } = await setup();
  await sh('cd /tmp; touch f; chmod 644 f');
  assert.equal(await out('chmod -v 600 f'), "mode of 'f' changed from 0644 (rw-r--r--) to 0600 (rw-------)\n");
  assert.equal(await out('chmod -v 600 f'), "mode of 'f' retained as 0600 (rw-------)\n");
  assert.equal(await out('chmod -c 600 f'), '');
  assert.equal((await sh('chmod zz f')).err, "chmod: invalid mode: 'zz'\nTry 'chmod --help' for more information.\n");
  assert.equal((await sh('chmod 600 nope')).err, "chmod: cannot access 'nope': No such file or directory\n");
  assert.equal((await sh('chmod')).err, "chmod: missing operand\nTry 'chmod --help' for more information.\n");
  assert.equal((await sh('chmod 755')).err, "chmod: missing operand after '755'\nTry 'chmod --help' for more information.\n");
  const r = await sh('chmod 777 /etc/passwd');
  assert.equal(r.err, "chmod: changing permissions of '/etc/passwd': Operation not permitted\n");
  assert.equal(r.code, 1);
  assert.equal(await out('touch ref; chmod 640 ref; chmod --reference=ref f; stat -c %a f'), '640\n');
});

test('chown and chgrp', async () => {
  const { sim, sh, out } = await setup();
  sim.term.feed('kali');
  await sh('cd /tmp; touch f; sudo true');
  let r = await sh('chown root f');
  assert.equal(r.err, "chown: changing ownership of 'f': Operation not permitted\n");
  r = await sh('chown nosuch f');
  assert.equal(r.err, "chown: invalid user: 'nosuch'\n");
  assert.equal((await sh('chown :nosuch f')).err, "chown: invalid group: ':nosuch'\n");
  assert.equal((await sh('chgrp nosuch f')).err, "chgrp: invalid group: 'nosuch'\n");
  assert.equal((await sh('chown')).err, "chown: missing operand\nTry 'chown --help' for more information.\n");
  assert.equal(await out('sudo chown -v root:shadow f'), "changed ownership of 'f' from kali:kali to root:shadow\n");
  assert.equal(await out('ls -l f | cut -d" " -f3,4'), 'root shadow\n');
  assert.equal(await out('sudo chown -v kali f'), "changed ownership of 'f' from root to kali\n");
  assert.equal(await out('sudo chgrp -v users f'), "changed group of 'f' from shadow to users\n");
  assert.equal(await out('sudo chown :kali f; sudo chown -R 0:0 f; stat -c "%u %g" f'), '0 0\n');
  assert.equal(await out('sudo chown -v 0:0 f'), "ownership of 'f' retained as root:root\n");
  assert.equal(await out('chgrp users f 2>&1; echo $?'), "chgrp: changing group of 'f': Operation not permitted\n1\n");
  await sh('sudo mkdir -p /tmp/tree/sub; sudo touch /tmp/tree/sub/x; sudo chown -R kali: /tmp/tree');
  assert.equal(await out('stat -c %U:%G /tmp/tree /tmp/tree/sub/x'), 'kali:kali\nkali:kali\n');
});

test('stat default layout and -c formats', async () => {
  const { sh, out } = await setup();
  await sh('cd /tmp; printf "hello\\n" > st; chmod 640 st; ln -s st sl; touch -d "2026-01-02 03:04:05" st');
  const o = (await out('stat st')).split('\n');
  assert.equal(o[0], '  File: st');
  assert.match(o[1], /^  Size: 6         \tBlocks: 8          IO Block: 4096   regular file$/);
  assert.match(o[2], /^Device: [\d,]+\tInode: \d+ +Links: 1$/);
  assert.equal(o[3], 'Access: (0640/-rw-r-----)  Uid: ( 1000/    kali)   Gid: ( 1000/    kali)');
  assert.equal(o[4], 'Access: 2026-01-02 03:04:05.000000000 +0000');
  assert.equal(o[5], 'Modify: 2026-01-02 03:04:05.000000000 +0000');
  assert.match(o[7], /^ Birth: /);
  assert.equal(await out('stat -c "%n %s %a %A %U %G %F" st'), 'st 6 640 -rw-r----- kali kali regular file\n');
  assert.equal(await out('stat -c %N sl'), "'sl' -> 'st'\n");
  assert.equal((await out('stat sl')).split('\n')[0], '  File: sl -> st');
  assert.equal(await out('stat -L -c %F sl'), 'regular file\n');
  assert.equal(await out('stat -c %F /tmp /dev/null /nonexistent 2>&1'), 'directory\ncharacter special file\nstat: cannot statx \'/nonexistent\': No such file or directory\n');
  assert.equal(await out('stat -c "%Y %%" st'), String(Date.UTC(2026, 0, 2, 3, 4, 5) / 1000) + ' %\n');
  assert.equal(await out('stat --printf "%s\\n" st'), '6\n');
  assert.equal((await sh('stat')).err, "stat: missing operand\nTry 'stat --help' for more information.\n");
});

/* ---------------------------------------------------------------- basename, dirname, realpath, readlink, mktemp */

test('basename and dirname', async () => {
  const { sh, out } = await setup();
  assert.equal(await out('basename /usr/bin/sort'), 'sort\n');
  assert.equal(await out('basename /usr/bin/sort/'), 'sort\n');
  assert.equal(await out('basename /'), '/\n');
  assert.equal(await out('basename notes.txt .txt'), 'notes\n');
  assert.equal(await out('basename .txt .txt'), '.txt\n');
  assert.equal(await out('basename -s .c a.c b.c'), 'a\nb\n');
  assert.equal(await out('basename -a /x/y /z/w'), 'y\nw\n');
  assert.equal((await sh('basename a b c')).err, "basename: extra operand 'c'\nTry 'basename --help' for more information.\n");
  assert.equal((await sh('basename')).err, "basename: missing operand\nTry 'basename --help' for more information.\n");
  assert.equal(await out('dirname /usr/bin/sort /usr/bin/ file /file / a/b//'), '/usr/bin\n/usr\n.\n/\n/\na\n');
  assert.equal(await out('echo /a/b/c | basename $(cat)'), 'c\n');
});

test('realpath and readlink', async () => {
  const { sh, out } = await setup();
  await sh('mkdir -p /tmp/rp/real; cd /tmp/rp; ln -s real lnk; ln -s lnk lnk2; touch real/f');
  assert.equal(await out('realpath lnk2/f'), '/tmp/rp/real/f\n');
  assert.equal(await out('realpath ./real/../real/./f'), '/tmp/rp/real/f\n');
  assert.equal(await out('realpath real/missing'), '/tmp/rp/real/missing\n');
  assert.equal((await sh('realpath real/a/b')).err, 'realpath: real/a/b: No such file or directory\n');
  assert.equal((await sh('realpath -e real/missing')).code, 1);
  assert.equal(await out('realpath -m real/a/b'), '/tmp/rp/real/a/b\n');
  assert.equal(await out('realpath -s lnk/../x'), '/tmp/rp/x\n');
  assert.equal(await out('realpath --relative-to=/tmp /tmp/rp/real'), 'rp/real\n');
  assert.equal(await out('readlink lnk2'), 'lnk\n');
  assert.equal(await out('readlink -f lnk2'), '/tmp/rp/real\n');
  assert.equal(await out('readlink -f real/nofile'), '/tmp/rp/real/nofile\n');
  const r = await sh('readlink real');
  assert.equal(r.out, '');
  assert.equal(r.code, 1);
  assert.equal(await out('readlink -n lnk | od -c | head -1'), (await out('printf real | od -c | head -1')));
});

test('mktemp creates files and directories', async () => {
  const { sh, out } = await setup();
  const f = (await out('mktemp')).trim();
  assert.match(f, /^\/tmp\/tmp\.[A-Za-z0-9]{10}$/);
  assert.equal((await out('stat -c "%a %F" ' + f)).trim(), '600 regular empty file');
  const d = (await out('mktemp -d')).trim();
  assert.equal((await out('stat -c "%a %F" ' + d)).trim(), '700 directory');
  const t = (await out('cd /tmp; mktemp scan.XXXXXX')).trim();
  assert.match(t, /^scan\.[A-Za-z0-9]{6}$/);
  assert.equal(await out('ls /tmp/' + t), '/tmp/' + t + '\n');
  assert.match((await out('mktemp -t job.XXXX')).trim(), /^\/tmp\/job\.[A-Za-z0-9]{4}$/);
  assert.match((await out('mktemp --suffix=.txt /tmp/aXXXXXX')).trim(), /^\/tmp\/a[A-Za-z0-9]{6}\.txt$/);
  assert.match((await out('mktemp -p /var/tmp x.XXX')).trim(), /^\/var\/tmp\/x\.[A-Za-z0-9]{3}$/);
  const u = (await out('mktemp -u /tmp/dryXXXX')).trim();
  assert.equal((await sh('ls ' + u)).code, 2, '-u does not create');
  assert.equal((await sh('mktemp abc')).err, "mktemp: too few X's in template 'abc'\n");
  assert.match((await sh('mktemp /nodir/xXXXX')).err, /^mktemp: failed to create file via template '\/nodir\/x[A-Za-z0-9]{4}': No such file or directory\n$/);
});

/* ---------------------------------------------------------------- file, tac, pagers, editors */

test('file identifies common types', async () => {
  const { sh, out } = await setup();
  await sh('cd /tmp; mkdir fd; touch empty; echo hi > a.txt; printf "h\\303\\251\\n" > u.txt; ln -s fd lnk; ln -s nowhere bad');
  assert.equal(await out('file fd'), 'fd: directory\n');
  assert.equal(await out('file empty'), 'empty: empty\n');
  assert.equal(await out('file a.txt'), 'a.txt: ASCII text\n');
  assert.equal(await out('file -b a.txt'), 'ASCII text\n');
  assert.equal(await out('file u.txt'), 'u.txt: Unicode text, UTF-8 text\n');
  assert.equal(await out('file lnk bad'), 'lnk: symbolic link to fd\nbad: broken symbolic link to nowhere\n');
  assert.equal(await out('file -L lnk'), 'lnk: directory\n');
  assert.equal(await out('file a.txt empty'), 'a.txt: ASCII text\nempty: empty\n');
  assert.equal(await out('file a.txt nonexistent-file'), "a.txt:            ASCII text\nnonexistent-file: cannot open `nonexistent-file' (No such file or directory)\n");
  assert.match(await out('file /bin/ls'), /^\/bin\/ls: ELF 64-bit LSB pie executable, x86-64, version 1 \(SYSV\), dynamically linked, interpreter \/lib64\/ld-linux-x86-64\.so\.2, BuildID\[sha1\]=[0-9a-f]{40}, for GNU\/Linux 3\.2\.0, stripped\n$/);
  assert.equal(await out('file -i a.txt fd'), 'a.txt: text/plain; charset=us-ascii\nfd:    inode/directory; charset=binary\n');
  assert.equal(await out('file --mime-type a.txt'), 'a.txt: text/plain\n');
  assert.equal(await out('echo hello | file -'), '/dev/stdin: ASCII text\n');
});

test('file recognises scripts, markup and containers', async () => {
  const { sh, out } = await setup();
  const w = async (name, data) => sh(`printf '${data}' > /tmp/${name}`);
  await w('s.sh', '#!/bin/bash\\necho\\n');
  await w('p.sh', '#!/bin/sh\\n');
  await w('p.py', '#!/usr/bin/env python3\\nprint(1)\\n');
  await w('p.pl', '#!/usr/bin/perl\\nprint 1;\\n');
  await w('j.json', '{"a": 1}\\n');
  await w('h.html', '<!DOCTYPE html>\\n<html></html>\\n');
  await w('x.xml', '<?xml version="1.0"?>\\n<a/>\\n');
  await w('cert.pem', '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----\\n');
  await w('rsa.pem', '-----BEGIN RSA PRIVATE KEY-----\\nMIIB\\n');
  await w('crlf', 'a\\r\\nb\\r\\n');
  await w('nonl', 'abc');
  await w('bin', '\\000\\001\\002');
  await w('doc.pdf', '%%PDF-1.4\\n1 0 obj\\n');
  await w('pic.png', '\\211PNG\\r\\n\\032\\n');
  const f = async (n) => (await out('file -b /tmp/' + n)).trim();
  assert.equal(await f('s.sh'), 'Bourne-Again shell script, ASCII text executable');
  assert.equal(await f('p.sh'), 'POSIX shell script, ASCII text executable');
  assert.equal(await f('p.py'), 'Python script, ASCII text executable');
  assert.equal(await f('p.pl'), 'Perl script text executable');
  assert.equal(await f('j.json'), 'JSON text data');
  assert.equal(await f('h.html'), 'HTML document, ASCII text');
  assert.equal(await f('x.xml'), 'XML 1.0 document, ASCII text');
  assert.equal(await f('cert.pem'), 'PEM certificate');
  assert.equal(await f('rsa.pem'), 'PEM RSA private key');
  assert.equal(await f('crlf'), 'ASCII text, with CRLF line terminators');
  assert.equal(await f('nonl'), 'ASCII text, with no line terminators');
  assert.equal(await f('bin'), 'data');
  assert.equal(await f('doc.pdf'), 'PDF document, version 1.4');
  assert.equal(await f('pic.png'), 'PNG image data');
  // synthetic archives with the right magic bytes
  await sh(`printf '\\037\\213\\010\\010\\000\\000\\000\\000\\000\\003x.tar\\000abcdefgh\\000\\050\\000\\000' > /tmp/x.gz`);
  assert.match(await f('x.gz'), /^gzip compressed data, was "x\.tar", from Unix, original size modulo 2\^32 10240$/);
  await sh(`printf 'PK\\003\\004\\024\\000\\000\\000\\010\\000rest' > /tmp/x.zip`);
  assert.equal(await f('x.zip'), 'Zip archive data, at least v2.0 to extract, compression method=deflate');
  assert.equal((await sh('file')).code, 1);
  assert.match((await sh('file --version')).out, /^file-5\.\d+/);
});

test('tac reverses lines', async () => {
  const { sh, out } = await setup();
  await sh('printf "a\\nb\\nc\\n" > /tmp/t; printf "x\\ny" > /tmp/u');
  assert.equal(await out('tac /tmp/t'), 'c\nb\na\n');
  assert.equal(await out('tac /tmp/u'), 'yx\n');
  assert.equal(await out('seq 1 3 | tac'), '3\n2\n1\n');
  assert.equal(await out('printf "a,b,c" | tac -s ,'), 'cb,a,');
  assert.equal((await sh('tac /nope')).err, "tac: failed to open '/nope' for reading: No such file or directory\n");
});

test('less and more pass text through when not a terminal and page on a terminal', async () => {
  const { sim, sh, out } = await setup();
  await sh('printf "l1\\nl2\\n" > /tmp/pg');
  assert.equal(await out('less /tmp/pg'), 'l1\nl2\n');
  assert.equal(await out('cat /tmp/pg | less'), 'l1\nl2\n');
  assert.equal(await out('more /tmp/pg'), 'l1\nl2\n');
  assert.equal(await out('less -N /tmp/pg'), '     1 l1\n     2 l2\n');
  assert.equal((await sh('less /nope')).err, '/nope: No such file or directory\n');
  assert.equal((await sh('more /nope')).err, 'more: cannot open /nope: No such file or directory\n');
  let seen = null;
  sim.term.pager = async (text, o) => { seen = { text, o }; };
  await sim.type('less /tmp/pg');
  assert.deepEqual(seen, { text: 'l1\nl2\n', o: { title: '/tmp/pg' } });
  await sim.type('echo piped | more');
  assert.equal(seen.text, 'piped\n');
});

test('nano, vim and vi call the terminal editor and write the result back', async () => {
  const { sim, sh, out } = await setup();
  await sh('echo old > /tmp/ed');
  let call = null;
  sim.term.editor = async (o) => { call = o; return { saved: true, content: 'new text\n' }; };
  await sim.type('nano /tmp/ed');
  assert.deepEqual(call, { path: '/tmp/ed', content: 'old\n', flavor: 'nano', isNew: false });
  assert.equal(await out('cat /tmp/ed'), 'new text\n');
  await sim.type('vim /tmp/fresh');
  assert.deepEqual(call, { path: '/tmp/fresh', content: '', flavor: 'vim', isNew: true });
  await sh('cd /tmp; : > empty');
  await sim.type('cd /tmp; nano empty');
  assert.deepEqual(call, { path: 'empty', content: '', flavor: 'nano', isNew: false }, 'path as typed; an existing empty file is not new');
  assert.equal(await out('cat /tmp/fresh'), 'new text\n');
  sim.term.editor = async (o) => { call = o; return { saved: false, content: 'ignored' }; };
  await sim.type('vi /tmp/ed');
  assert.equal(call.flavor, 'vim');
  assert.equal(await out('cat /tmp/ed'), 'new text\n', 'not saved, not written');
  let r = await sh('nano /tmp/ed');
  assert.equal(r.code, 1);
  assert.match(r.err, /Too many errors from stdin/);
  r = await sh('echo x | vim -');
  assert.match(r.err, /Vim: Warning/);
  assert.match((await sh('vim --version')).out, /^VIM - Vi IMproved/);
  assert.match((await sh('nano --version')).out, /GNU nano, version/);
});

/* ---------------------------------------------------------------- du, df, tree */

test('du reports disk usage in 1K blocks', async () => {
  const { sh, out } = await setup();
  await sh('mkdir -p /tmp/du/a/b; cd /tmp/du; printf "%5000s" x > a/f; echo hi > a/b/g; : > empty');
  assert.equal(await out('du'), '8\t./a/b\n20\t./a\n24\t.\n');
  assert.equal(await out('du -s'), '24\t.\n');
  assert.equal(await out('du -a'), '4\t./a/b/g\n8\t./a/b\n8\t./a/f\n20\t./a\n0\t./empty\n24\t.\n');
  assert.equal(await out('du -d 1'), '20\t./a\n24\t.\n');
  assert.equal(await out('du -d0'), '24\t.\n');
  assert.equal(await out('du -sh a'), '20K\ta\n');
  assert.equal(await out('du -sc a empty'), '20\ta\n0\tempty\n20\ttotal\n');
  assert.equal(await out('du -sb a/f'), '5000\ta/f\n');
  assert.equal(await out('du a/f'), '8\ta/f\n');
  const r = await sh('du nope');
  assert.equal(r.err, "du: cannot access 'nope': No such file or directory\n");
  assert.equal(r.code, 1);
  assert.equal((await sh('du -s -d 1 .')).code, 1);
  assert.equal(await out('du -ah /tmp/du/a/f /etc/hostname'), '8.0K\t/tmp/du/a/f\n4.0K\t/etc/hostname\n');
});

test('df lists simulated filesystems', async () => {
  const { sh, out } = await setup();
  const o = (await out('df')).split('\n');
  assert.match(o[0], /^Filesystem {5}1K-blocks +Used Available Use% Mounted on$/);
  assert.ok(o.some((l) => /^\/dev\/sda1 +\d+ +\d+ +\d+ +\d+% \/$/.test(l)));
  const h = (await out('df -h')).split('\n');
  assert.match(h[0], /^Filesystem {6}Size {2}Used Avail Use% Mounted on$/);
  assert.ok(h.some((l) => /^\/dev\/sda1 +\d+G +\d+G +\d+G +\d+% \/$/.test(l)));
  const t = (await out('df -hT /')).split('\n');
  assert.match(t[0], /^Filesystem +Type +Size +Used Avail Use% Mounted on$/);
  assert.match(t[1], /^\/dev\/sda1 +ext4 /);
  assert.equal((await out('df -h /tmp')).split('\n').length, 3);
  assert.match(await out('df /tmp'), /^Filesystem .*\ntmpfs +\d+ +\d+ +\d+ +\d+% \/tmp\n$/);
  assert.equal((await sh('df /nonexistent')).err, 'df: /nonexistent: No such file or directory\n');
});

test('tree draws the directory structure and counts', async () => {
  const { sh, out } = await setup();
  await sh('mkdir -p /tmp/tr/a/b /tmp/tr/c; cd /tmp/tr; touch a/f1 a/b/f2 .hid top');
  assert.equal(await out('tree'), '.\n├── a\n│   ├── b\n│   │   └── f2\n│   └── f1\n├── c\n└── top\n\n3 directories, 3 files\n');
  assert.equal(await out('tree -L 1'), '.\n├── a\n├── c\n└── top\n\n2 directories, 1 file\n');
  assert.equal(await out('tree -a -L 1'), '.\n├── a\n├── c\n├── .hid\n└── top\n\n2 directories, 2 files\n'.replace('├── .hid\n└── top', '├── .hid\n└── top'));
  assert.equal(await out('tree -d'), '.\n├── a\n│   └── b\n└── c\n\n3 directories\n');
  assert.equal(await out('tree -f -L 1 a'), 'a\n├── a/b\n└── a/f1\n\n1 directory, 1 file\n');
  assert.equal(await out('tree --noreport -L 1 c'), 'c\n');
  assert.equal(await out('tree /tmp/nonexistent'), '/tmp/nonexistent [error opening dir]\n\n0 directories, 0 files\n');
  assert.equal(await out('LC_ALL=C tree -L 1'), '.\n|-- a\n|-- c\n`-- top\n\n2 directories, 1 file\n');
  assert.match(await out('tree -C -L 1'), /\x1b\[01;34ma\x1b\[0m/);
  assert.match(await out('tree --version'), /^tree v2\.2\.1/);
  await sh('mkdir /tmp/tr/priv; chmod 000 /tmp/tr/priv');
  assert.match(await out('tree -L 1 -d'), /priv {2}\[error opening dir\]/);
});

test('regressions found by comparing with GNU tools', async () => {
  const { sim, sh, out } = await setup();
  // ls columns never use the last terminal column
  const names = Array.from({ length: 14 }, (_, i) => 'file-name-number-' + String(i).padStart(2, '0'));
  await sh('mkdir /tmp/cols; cd /tmp/cols; touch ' + names.join(' '));
  const t = await sim.type('cd /tmp/cols; ls');
  for (const l of t.output.split('\n')) assert.ok(l.length < 80);
  // chmod "=" keeps setuid on directories, clears sticky with o
  await sh('mkdir /tmp/sd; chmod 4755 /tmp/sd; chmod a=r /tmp/sd');
  assert.equal(await out('stat -c %a /tmp/sd'), '4444\n');
  await sh('touch /tmp/sf; chmod 1777 /tmp/sf; chmod o=g /tmp/sf');
  assert.equal(await out('stat -c %a /tmp/sf'), '777\n');
  assert.equal(await out('printf "a\\0b\\0" | head -z -n 1 | od -c | head -1'), (await out('printf "a\\0" | od -c | head -1')));
});

test('ls formats: -x, -m, -g, -o, -H, trailing slash, --sort and --color validation', async () => {
  const { sim, sh, out } = await setup();
  await sh('mkdir -p /tmp/lf/d; cd /tmp/lf; touch a b c; ln -s d ld');
  assert.equal(await out('cd /tmp/lf; ls -x'), 'a  b  c  d  ld\n');
  assert.equal(await out('cd /tmp/lf; ls -m'), 'a, b, c, d, ld\n');
  assert.equal(await out('cd /tmp/lf; ls -C'), 'a  b  c  d  ld\n');
  assert.equal((await out('cd /tmp/lf; ls -lg a')).trim().split(/\s+/).slice(2, 3)[0], 'kali');
  assert.match(await out('cd /tmp/lf; ls -lg a'), /^-rw-r--r-- 1 kali 0 /);
  assert.match(await out('cd /tmp/lf; ls -lo a'), /^-rw-r--r-- 1 kali 0 /);
  assert.equal(await out('cd /tmp/lf; ls -d */'), 'd/\nld/\n');
  assert.equal(await out('cd /tmp/lf; echo */'), 'd/ ld/\n');
  assert.equal(await out('cd /tmp/lf; ls ld/'), '', 'link with trailing slash lists the directory (empty)');
  assert.match(await out('cd /tmp/lf; ls -l ld'), /ld -> d$/m);
  assert.equal(await out('cd /tmp/lf; ls -lH ld'), 'total 0\n');
  assert.equal(await out('cd /tmp/lf; ls --group-directories-first'), 'd\nld\na\nb\nc\n');
  const r = await sh('ls --color=bogus');
  assert.equal(r.err, "ls: invalid argument 'bogus' for '--color'\nValid arguments are:\n  - 'always', 'yes', 'force'\n  - 'never', 'no', 'none'\n  - 'auto', 'tty', 'if-tty'\nTry 'ls --help' for more information.\n");
  assert.match((await sh('ls --sort=bogus')).err, /^ls: invalid argument 'bogus' for '--sort'\nValid arguments are:\n  - 'none'\n/);
  assert.equal(await out('cd /tmp/lf; ls -lF ld | cut -d" " -f9-'), 'ld -> d\n');
});

test('cp, mv, ln, rm messages match coreutils 9', async () => {
  const { sh, out } = await setup();
  await sh('cd /tmp; mkdir cm; cd cm; echo x > f; echo y > g; mkdir d');
  assert.equal((await sh('cd /tmp/cm; cp f g nope')).err, "cp: target 'nope': No such file or directory\n");
  assert.equal((await sh('cd /tmp/cm; cp f g f')).err, "cp: target 'f': Not a directory\n");
  assert.equal((await sh('cd /tmp/cm; cp -n f g')).err, 'cp: warning: behavior of -n is non-portable and may change in future; use --update=none instead\n');
  const r = await sh('cd /tmp/cm; mv -n f g');
  assert.equal(r.err, "mv: not replacing 'g'\n");
  assert.equal(r.code, 1);
  assert.equal((await sh('cd /tmp/cm; rm .')).err, "rm: cannot remove '.': Is a directory\n");
  assert.equal((await sh('cd /tmp/cm; ln')).err, "ln: missing file operand\nTry 'ln --help' for more information.\n");
  assert.equal((await sh('cd /tmp/cm; ln f g')).err, "ln: failed to create hard link 'g': File exists\n");
  assert.equal((await sh('cd /tmp/cm; ln d dd')).err, 'ln: d: hard link not allowed for directory\n');
  assert.equal((await sh('cd /tmp/cm; mkdir -p f/x')).err, "mkdir: cannot create directory 'f': Not a directory\n");
  assert.equal((await sh('cd /tmp/cm; rmdir nope')).err, "rmdir: failed to remove 'nope': No such file or directory\n");
  assert.equal((await sh('cd /tmp/cm; chmod -- -x f')).code, 0);
  assert.equal((await sh('du -s -d 1 /tmp')).err, "du: warning: summarizing conflicts with --max-depth=1\nTry 'du --help' for more information.\n");
  await sh('cd /tmp/cm; ln -s nowhere bad; ln -s d dl');
  assert.equal(await out('cd /tmp/cm; realpath bad; readlink -f bad'), '/tmp/cm/nowhere\n/tmp/cm/nowhere\n');
  assert.equal(await out('cd /tmp/cm; du dl/'), '4\tdl/\n');
});

/* ------------------------------------------------- review round: ls fixes */

test('ls: dangling symlink operand, trailing slash on a file, ignore patterns, -s total, -q', async () => {
  const { sh, out } = await setup();
  await sh('mkdir /tmp/r1; cd /tmp/r1; touch a.txt b.log c; ln -s nowhere dang');
  assert.equal(await out('ls dang'), 'dang\n');
  let r = await sh('ls a.txt/');
  assert.equal(r.err, "ls: cannot access 'a.txt/': Not a directory\n");
  assert.equal(r.code, 2);
  assert.equal(await out("ls -I '*.txt'"), 'b.log\nc\ndang\n');
  assert.equal(await out("ls --hide='*.log'"), 'a.txt\nc\ndang\n');
  assert.equal(await out('ls -s'), 'total 0\n0 a.txt\n0 b.log\n0 c\n0 dang\n');
  assert.equal(await out('ls -q'), 'a.txt\nb.log\nc\ndang\n');
  assert.equal(await out('ls -w 40 -k'), 'a.txt\nb.log\nc\ndang\n');
});

test('ls: unreadable subdirectory under -R exits 1 and prints no header for it', async () => {
  const { sh } = await setup();
  await sh('mkdir -p /tmp/r2/ok /tmp/r2/no; touch /tmp/r2/ok/f; chmod 000 /tmp/r2/no; cd /tmp/r2');
  let r = await sh('ls -R');
  assert.equal(r.out, '.:\nno\nok\n\n./ok:\nf\n');
  assert.equal(r.err, "ls: cannot open directory './no': Permission denied\n");
  assert.equal(r.code, 1);
  r = await sh('ls -R no');
  assert.equal(r.out, '');
  assert.equal(r.code, 2);
});

/* ------------------------------------------------ review round 2 regressions */

test('cp and mv to "name/" that does not exist fail like the real tools', async () => {
  const { sh } = await setup();
  await sh('mkdir /tmp/r2; cd /tmp/r2; echo a > a');
  const r = await sh('cp a nodir/');
  assert.equal(r.code, 1);
  assert.equal(r.err, "cp: cannot create regular file 'nodir/': Not a directory\n");
  assert.equal((await sh('ls')).out, 'a\n');
  const m = await sh('mv a nodir/');
  assert.equal(m.err, "mv: cannot move 'a' to 'nodir/': Not a directory\n");
  await sh('mkdir sd'); assert.equal((await sh('cp -r sd newd/')).code, 0);
});

test('cp -i and mv -i print the prompt on stderr when stdin is redirected and fail on EOF', async () => {
  const { sh } = await setup();
  await sh('mkdir /tmp/r3; cd /tmp/r3; echo a > a; echo b > b');
  const r = await sh('cp -i a b < /dev/null');
  assert.equal(r.err, "cp: overwrite 'b'? ");
  assert.equal(r.code, 1);
  assert.equal((await sh('cat b')).out, 'b\n');
  const m = await sh('mv -i a b < /dev/null');
  assert.equal(m.err, "mv: overwrite 'b'? ");
  assert.equal(m.code, 1);
});

test('mv reports permission denied from stat, mkdir shows the operand as typed', async () => {
  const { sh } = await setup();
  await sh('mkdir -p /tmp/r4/np; cd /tmp/r4; touch np/x; echo f > f; chmod 000 np');
  assert.equal((await sh('mv np/x .')).err, "mv: cannot stat 'np/x': Permission denied\n");
  assert.equal((await sh('mkdir f/g/h')).err, "mkdir: cannot create directory 'f/g/h': Not a directory\n");
  assert.equal((await sh('mkdir -p f/g/h')).err, "mkdir: cannot create directory 'f': Not a directory\n");
});

test('chmod by a non-owner fails even when the mode would not change; -f is silent', async () => {
  const { sh } = await setup();
  const r = await sh('chmod a+x /usr/bin/ls');
  assert.equal(r.err, "chmod: changing permissions of '/usr/bin/ls': Operation not permitted\n");
  assert.equal(r.code, 1);
  const q = await sh('chmod -f 777 /etc/passwd');
  assert.equal(q.err, '');
  assert.equal(q.code, 1);
});

test('rmdir . says Invalid argument; touch accepts -h', async () => {
  const { sh } = await setup();
  await sh('mkdir /tmp/r5; cd /tmp/r5; touch f');
  assert.equal((await sh('rmdir .')).err, "rmdir: failed to remove '.': Invalid argument\n");
  assert.equal((await sh('touch -h f')).code, 0);
});

test('ls -Q, -w and --indicator-style', async () => {
  const { sh } = await setup();
  await sh('mkdir /tmp/r6; cd /tmp/r6; mkdir d; touch a');
  assert.equal((await sh('ls -Q')).out, '"a"\n"d"\n');
  assert.equal((await sh('ls --indicator-style=slash')).out, 'a\nd/\n');
  assert.equal((await sh('ls -w 3 -C')).out, 'a\nd\n');
});

test('cp -b, --backup, -l, -s and --parents; mv -b', async () => {
  const { sh, out } = await setup();
  await sh('mkdir /tmp/r7; cd /tmp/r7; echo a > a; echo b > b');
  await sh('cp -b a b');
  assert.equal(await out('cat b~'), 'b\n');
  assert.equal(await out('cat b'), 'a\n');
  await sh('cp --backup=numbered a b; cp --backup=numbered a b');
  assert.equal(await out('ls'), 'a\nb\nb~\nb.~1~\nb.~2~\n');
  await sh('cp -l a hard; cp -s a soft');
  assert.match(await out('ls -l hard soft'), /hard\n.*soft -> a\n/);
  assert.equal(await out('stat -c %h a'), '2\n');
  await sh('mkdir -p x/y dest; echo q > x/y/f; cp --parents x/y/f dest');
  assert.equal(await out('cat dest/x/y/f'), 'q\n');
  await sh('echo n > n; mv -b n a');
  assert.equal(await out('cat a~'), 'a\n');
});

test('file: truncated zip is data, CSV text, unreadable file, sticky directory, bad option line', async () => {
  const { sh, out } = await setup();
  await sh('mkdir /tmp/f1; cd /tmp/f1; printf "PK\\003\\004" > fk.zip; printf "a,b\\n1,2\\n" > c.csv; printf "a,b,c\\n1,2\\n" > bad.csv; printf "a,b\\n" > one.csv');
  assert.equal(await out('file fk.zip'), 'fk.zip: data\n');
  assert.equal(await out('file c.csv bad.csv one.csv'), 'c.csv:   CSV ASCII text\nbad.csv: ASCII text\none.csv: ASCII text\n');
  assert.equal(await out('file /etc/shadow'), '/etc/shadow: regular file, no read permission\n');
  assert.equal(await out('file /tmp'), '/tmp: sticky, directory\n');
  const r = await sh('file --bogus');
  assert.equal(r.code, 1);
  assert.match(r.err, /^file: unrecognized option '--bogus'\nUsage: file /);
});

test('mktemp error names the template as given', async () => {
  const { sh } = await setup();
  assert.equal((await sh('mktemp /nonexist/XXXXXX')).err, "mktemp: failed to create file via template '/nonexist/XXXXXX': No such file or directory\n");
});

/* ------------------------------------------------ review regressions (round 2) */

test('ls in a readable but unsearchable directory shows question marks like GNU ls', async () => {
  const { sh, out } = await setup();
  await sh('mkdir /tmp/q1; cd /tmp/q1; mkdir d; touch d/x; chmod 444 d');
  const r = await sh('ls -l d');
  assert.equal(r.out, 'total 0\n-????????? ? ? ? ?            ? x\n');
  assert.match(r.err, /^ls: cannot access 'd\/x': Permission denied\n$/);
  assert.equal(r.code, 1);
  const p = await sh('ls d');
  assert.equal(p.out, 'x\n'); assert.equal(p.err, ''); assert.equal(p.code, 0);
});

test('tail +N obsolete form, head -c on /dev/zero, touch -d with month names, rm file/', async () => {
  const { sh, out } = await setup();
  await sh('cd /tmp; seq 1 20 > q2');
  assert.equal(await out('tail +19 q2'), '19\n20\n');
  assert.equal((await sh('head -c 8 /dev/zero | wc -c')).out, '8\n');
  await sh('touch -d "Jan 5 2021" q3; touch -d "5 January 2021 10:30" q4');
  assert.match(await out('ls -l --full-time q3'), /2021-01-05 00:00:00/);
  assert.match(await out('ls -l --full-time q4'), /2021-01-05 10:30:00/);
  const r = await sh('rm q2/');
  assert.equal(r.err, "rm: cannot remove 'q2/': Not a directory\n"); assert.equal(r.code, 1);
});

test('ln -r/-b/-L/-P/-t, chmod long octal, du -B/--exclude/-0/--time, df -i/-x, file details', async () => {
  const { sh, out } = await setup();
  await sh('mkdir -p /tmp/q5/a/b /tmp/q5/c; cd /tmp/q5; touch a/b/f');
  await sh('ln -sr a/b/f c/l');
  assert.equal(await out('readlink c/l'), '../a/b/f\n');
  await sh('touch f; ln -b f g; ln -b f g');
  assert.equal(await out('ls g*'), 'g\ng~\n');
  assert.equal((await sh('ln -L f h; ln -P f i; ln -t c f; ls c')).out, 'f\nl\n');
  assert.equal((await sh('chmod 00640 f; echo $?')).out, '0\n');
  assert.match(await out('du -BM a'), /^1M\ta\/b\n1M\ta\n$/);
  assert.equal(await out('du --exclude=b a'), '4\ta\n');
  assert.equal(await out('du -0 a | tr "\\0" X'), '4\ta/bX8\taX');
  assert.match(await out('du --time a'), /^4\t\d{4}-\d\d-\d\d \d\d:\d\d\ta\/b\n/);
  assert.match(await out('df -i /'), /^Filesystem +Inodes +IUsed +IFree IUse% Mounted on\n/);
  assert.equal((await out('df -x tmpfs -x devtmpfs')).split('\n').length, 3);
  await sh('printf "a\\r\\nb\\n" > crlf; printf "int main(){}\\n" > m.c; ln -s nowhere dang');
  assert.equal(await out('file crlf'), 'crlf: ASCII text, with CRLF, LF line terminators\n');
  assert.equal(await out('file m.c'), 'm.c: C source, ASCII text\n');
  assert.equal(await out('file -L dang'), "dang: cannot open `dang' (No such file or directory)\n");
  const r = await sh('file');
  assert.equal(r.out, ''); assert.match(r.err, /^Usage: file/);
});

test('ls -b/--si/--time-style=+FMT, tree -P/-I/-h/-Q/--prune, more +N and less +F', async () => {
  const { sh, out } = await setup();
  await sh('mkdir -p /tmp/q6; cd /tmp/q6; printf x > "sp ace"; head -c 1500 /dev/zero > f; touch -d "2026-01-01 10:20" f');
  assert.equal(await out('ls -b'), 'f\nsp\\ ace\n');
  assert.match(await out('ls -l --si f'), / 1\.5k /);
  assert.match(await out('ls -l --time-style=+%Y-%m-%d f'), / 2026-01-01 f\n$/);
  await sh('mkdir -p t/a/b t/c; touch t/a/f t/a/b/g t/h');
  assert.equal(await out('tree --noreport -I "a|c" t'), 't\n└── h\n');
  assert.equal(await out('tree --noreport -P g --prune t'), 't\n└── a\n    └── b\n        └── g\n');
  assert.match(await out('tree -Q --noreport t'), /"a"/);
  assert.match(await out('tree -h --noreport t'), /\[4\.0K\]  a/);
  await sh('seq 1 5 > n');
  assert.equal(await out('more +3 n'), '3\n4\n5\n');
  assert.equal(await out('less +F n'), '1\n2\n3\n4\n5\n');
});
