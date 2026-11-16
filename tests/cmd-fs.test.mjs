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
  const r = await sh('ls -Z');
  assert.equal(r.code, 2);
  assert.equal(r.err, "ls: invalid option -- 'Z'\nTry 'ls --help' for more information.\n");
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
  assert.equal(await out('rmdir -v /tmp/p1 2>&1; mkdir /tmp/p1; rmdir -v /tmp/p1'), "rmdir: failed to remove '/tmp/p1': No such file or directory\nrmdir: removing directory, '/tmp/p1'\n");
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
  assert.equal(r.err, "cp: target 'f1x' is not a directory\n");
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
  assert.equal((await sh('mv y z w')).err, "mv: target 'w' is not a directory\n");
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
  assert.equal(await out('readlink -n lnk | od -c | head -1'), (await out('printf lnk | od -c | head -1')));
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
