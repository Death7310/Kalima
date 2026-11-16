// Tests for the text filter pack (40-cmd-text.js). Expected output was checked
// against the GNU tools on the build machine.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

let sim;
before(async () => {
  sim = await boot();
  await sim.run('cd /tmp');
});
const run = (line) => sim.run(line);
const out = async (line) => (await run(line)).out;
/**
 * Table-driven tests: each row is [command line, stdout, stderr, exit status] as
 * printed by the real GNU tool on the same input (run in a fresh directory).
 */
let tableDir = 0;
function table(name, setup, locale, rows) {
  test(name, async () => {
    for (const [line, stdout, stderr, status] of rows) {
      const dir = '/tmp/tbl' + (tableDir++);     // every row starts from the same fresh files
      sim.machine.vfs.seedDir(dir);
      sim.machine.vfs.chmod(dir, 0o777);
      for (const m of setup.matchAll(/mkdir (\w+)/g)) sim.machine.vfs.seedDir(dir + '/' + m[1]);   // mkdir belongs to another pack
      await run('cd ' + dir + '; LC_ALL=' + locale + '; export LC_ALL');
      await run(setup.replace(/mkdir \w+;?/g, ''));
      const r = await run(line);
      assert.deepEqual([r.out, r.err.replace(/[‘’]/g, "'"), r.code], [stdout, stderr.replace(/[‘’]/g, "'"), status], line);
    }
  });
}
const SAMPLE = "printf 'Hello World\\nfoo bar\\nhello again\\n\\nlast line no nl' > a.txt; printf 'one\\ntwo\\nthree hello\\n' > b.txt";

test('grep: selection, counting and listing', async () => {
  await run(SAMPLE);
  assert.equal(await out('grep hello a.txt'), 'hello again\n');
  assert.equal(await out('grep -i hello a.txt'), 'Hello World\nhello again\n');
  assert.equal(await out('grep -v hello a.txt'), 'Hello World\nfoo bar\n\nlast line no nl\n');
  assert.equal(await out('grep -n hello a.txt b.txt'), 'a.txt:3:hello again\nb.txt:3:three hello\n');
  assert.equal(await out('grep -c hello a.txt b.txt'), 'a.txt:1\nb.txt:1\n');
  assert.equal(await out('grep -L hello a.txt b.txt'), '');
  assert.equal(await out('grep -lc hello a.txt b.txt'), 'a.txt\nb.txt\n', '-l wins over -c');
  assert.equal(await out('grep -h hello a.txt b.txt'), 'hello again\nthree hello\n');
  assert.equal(await out('grep -m1 hello a.txt b.txt'), 'a.txt:hello again\nb.txt:three hello\n');
});

test('grep: pattern styles and word/line matching', async () => {
  await run(SAMPLE);
  assert.equal(await out('grep -E "foo|two" a.txt b.txt'), 'a.txt:foo bar\nb.txt:two\n');
  assert.equal(await out('egrep "foo|two" a.txt'), 'foo bar\n');
  assert.equal(await out('fgrep "o b" a.txt'), 'foo bar\n');
  assert.equal(await out("grep -o 'l\\+' a.txt"), 'll\nl\nll\nl\nl\nl\n');
  assert.equal(await out('grep -ob o a.txt'), '4:o\n7:o\n13:o\n14:o\n24:o\n44:o\n');
  assert.equal(await out('grep -w hell a.txt'), '');
  assert.equal(await out('grep -w Hello a.txt'), 'Hello World\n');
  assert.equal(await out("grep -x 'foo bar' a.txt"), 'foo bar\n');
  assert.equal(await out('grep -e foo -e two a.txt b.txt'), 'a.txt:foo bar\nb.txt:two\n');
  await run("printf 'foo\\nbar\\n' > pats");
  assert.equal(await out('grep -f pats a.txt b.txt'), 'a.txt:foo bar\n');
  assert.equal(await out("grep -P '(?<=foo )bar' -o a.txt"), 'bar\n');
});

test('grep: context, colour and stdin', async () => {
  await run(SAMPLE);
  assert.equal(await out('grep -A1 foo a.txt'), 'foo bar\nhello again\n');
  assert.equal(await out('grep -B1 foo a.txt'), 'Hello World\nfoo bar\n');
  assert.equal(await out('grep -A1 hello a.txt b.txt'), 'a.txt:hello again\na.txt-\n--\nb.txt:three hello\n');
  assert.equal(await out('grep --color=always -n hello b.txt'), '\x1b[32m\x1b[K3\x1b[m\x1b[K\x1b[36m\x1b[K:\x1b[m\x1b[Kthree \x1b[01;31m\x1b[Khello\x1b[m\x1b[K\n');
  assert.equal(await out('grep --color=never hello b.txt'), 'three hello\n');
  assert.equal(await out('echo hello | grep -H hello'), '(standard input):hello\n');
  assert.equal(await out('echo hello | grep --label=in -H hello'), 'in:hello\n');
  assert.equal(await out('echo hello | grep -c hello - a.txt'), '(standard input):1\na.txt:1\n');
});

test('grep: recursion, include and exclude', async () => {
  sim.machine.vfs.seed('/tmp/gr/e/f.c', 'hello deep\n');
  sim.machine.vfs.seed('/tmp/gr/g.h', 'hello c\n');
  assert.equal(await out('grep -r hello gr'), 'gr/e/f.c:hello deep\ngr/g.h:hello c\n');
  assert.equal(await out("grep -r hello gr --include='*.c'"), 'gr/e/f.c:hello deep\n');
  assert.equal(await out("grep -r hello gr --exclude='*.c'"), 'gr/g.h:hello c\n');
  assert.equal(await out('grep -r hello gr --exclude-dir=e'), 'gr/g.h:hello c\n');
  assert.equal(await out('cd gr; grep -rh hello'), 'hello deep\nhello c\n');
  assert.equal(await out('cd /tmp; grep -rl hello gr'), 'gr/e/f.c\ngr/g.h\n');
});

test('grep: exit status and errors', async () => {
  await run(SAMPLE);
  assert.equal((await run('grep -q hello a.txt')).code, 0);
  assert.equal((await run('grep -q nothing a.txt')).code, 1);
  const missing = await run('grep hello nonexist');
  assert.equal(missing.err, 'grep: nonexist: No such file or directory\n');
  assert.equal(missing.code, 2);
  assert.equal((await run('grep -s hello nonexist')).err, '');
  assert.equal((await run('grep -q hello nonexist a.txt')).code, 0, '-q with a match beats a file error');
  assert.equal((await run('grep hello /tmp')).err, 'grep: /tmp: Is a directory\n');
  assert.equal((await run("grep '\\(' a.txt")).err, 'grep: Unmatched ( or \\(\n');
  assert.equal((await run("grep '[' a.txt")).err, 'grep: Invalid regular expression\n');
  assert.equal((await run('grep -A x foo a.txt')).err, 'grep: x: invalid context length argument\n');
  const bad = await run('grep -Q foo a.txt');
  assert.equal(bad.code, 2);
  assert.match(bad.err, /invalid option -- 'Q'/);
  assert.match((await run('grep --version')).out, /^grep \(GNU grep\)/);
});

table("wc, uniq and cut match GNU", "printf 'a b\\nc\\n' > f; printf 'x\\n' > g; mkdir dd; printf 'tab\\there  x\\n\\n  lead\\n' > t; printf 'héllo wörld\\nñ\\n' > u; printf 'no newline' > nn; printf '' > empty; printf 'a:b:c\\nd:e\\nf\\n:x:\\n' > c; printf 'a\\na\\nb\\nc\\nc\\nc\\na\\n' > r; printf 'A\\na\\nB\\nb x\\nB y\\n' > i; printf 'x 1 a\\ny 1 b\\nz 2 c\\n' > fl", 'C.UTF-8', [
  ["wc f", "2 3 6 f\n", "", 0],
  ["wc -l f", "2 f\n", "", 0],
  ["wc -c f g", "6 f\n2 g\n8 total\n", "", 0],
  ["wc nonex f", "2 3 6 f\n2 3 6 total\n", "wc: nonex: No such file or directory\n", 1],
  ["wc dd", "      0       0       0 dd\n", "wc: dd: Is a directory\n", 1],
  ["echo hi | wc", "      1       1       3\n", "", 0],
  ["echo hi | wc -l", "1\n", "", 0],
  ["echo hi | wc - f", "      1       1       3 -\n      2       3       6 f\n      3       4       9 total\n", "", 0],
  ["wc -L t", "15 t\n", "", 0],
  ["wc -L u", "11 u\n", "", 0],
  ["wc -m u", "14 u\n", "", 0],
  ["wc -c u", "17 u\n", "", 0],
  ["wc -lw f", "2 3 f\n", "", 0],
  ["wc nonex", "", "wc: nonex: No such file or directory\n", 1],
  ["wc t u nn empty", " 3  4 20 t\n 2  3 17 u\n 0  2 10 nn\n 0  0  0 empty\n 5  9 47 total\n", "", 0],
  ["wc -l t u", " 3 t\n 2 u\n 5 total\n", "", 0],
  ["wc --total=only f g", "3 4 8\n", "", 0],
  ["wc --total=always f", "2 3 6 f\n2 3 6 total\n", "", 0],
  ["wc --total=never f g", "2 3 6 f\n1 1 2 g\n", "", 0],
  ["wc --total=bad f", "", "wc: invalid argument ‘bad’ for ‘--total’\nValid arguments are:\n  - ‘auto’\n  - ‘always’\n  - ‘only’\n  - ‘never’\nTry 'wc --help' for more information.\n", 1],
  ["wc -x f", "", "wc: invalid option -- 'x'\nTry 'wc --help' for more information.\n", 1],
  ["wc --lines --words f g", "2 3 f\n1 1 g\n3 4 total\n", "", 0],
  ["wc -mc u", "14 17 u\n", "", 0],
  ["wc empty", "0 0 0 empty\n", "", 0],
  ["wc -w nn", "2 nn\n", "", 0],
  ["printf 'f\\0g\\0' | wc --files0-from=-", "2 3 6 f\n1 1 2 g\n3 4 8 total\n", "", 0],
  ["cat f | wc -c", "6\n", "", 0],
  ["printf 'a  b\\t\\tc\\n' | wc -w", "3\n", "", 0],
  ["wc --bytes f", "6 f\n", "", 0],
  ["wc -l < f", "2\n", "", 0],
  ["wc --files0-from=f g", "", "wc: extra operand 'g'\nfile operands cannot be combined with --files0-from\nTry 'wc --help' for more information.\n", 1],
  ["uniq -f x f", "", "uniq: x: invalid number of fields to skip\n", 1],
  ["uniq -s -1 f", "", "uniq: -1: invalid number of bytes to skip\n", 1],
  ["uniq -w x f", "", "uniq: x: invalid number of bytes to compare\n", 1],
  ["uniq a b c", "", "uniq: extra operand ‘c’\nTry 'uniq --help' for more information.\n", 1],
  ["uniq nonex", "", "uniq: nonex: No such file or directory\n", 1],
  ["uniq r", "a\nb\nc\na\n", "", 0],
  ["uniq -c r", "      2 a\n      1 b\n      3 c\n      1 a\n", "", 0],
  ["uniq -d r", "a\nc\n", "", 0],
  ["uniq -u r", "b\na\n", "", 0],
  ["uniq -D r", "a\na\nc\nc\nc\n", "", 0],
  ["uniq -cd r", "      2 a\n      3 c\n", "", 0],
  ["uniq -cu r", "      1 b\n      1 a\n", "", 0],
  ["uniq -cD r", "", "uniq: printing all duplicated lines and repeat counts is meaningless\nTry 'uniq --help' for more information.\n", 1],
  ["uniq -i i", "A\nB\nb x\nB y\n", "", 0],
  ["uniq -f1 i", "A\nb x\nB y\n", "", 0],
  ["uniq -s1 i", "A\nb x\nB y\n", "", 0],
  ["uniq -w1 i", "A\na\nB\nb x\nB y\n", "", 0],
  ["uniq -i -c i", "      2 A\n      1 B\n      1 b x\n      1 B y\n", "", 0],
  ["uniq -f1 fl; uniq -f2 -c fl", "x 1 a\ny 1 b\nz 2 c\n      1 x 1 a\n      1 y 1 b\n      1 z 2 c\n", "", 0],
  ["uniq r out; cat out", "a\nb\nc\na\n", "", 0],
  ["uniq --group r", "a\na\n\nb\n\nc\nc\nc\n\na\n", "", 0],
  ["uniq --all-repeated=separate r", "a\na\n\nc\nc\nc\n", "", 0],
  ["uniq --all-repeated=prepend r", "\na\na\n\nc\nc\nc\n", "", 0],
  ["uniq -D --group r", "", "uniq: --group is mutually exclusive with -c/-d/-D/-u\nTry 'uniq --help' for more information.\n", 1],
  ["uniq --group=both r", "\na\na\n\nb\n\nc\nc\nc\n\na\n\n", "", 0],
  ["uniq --group=append r", "a\na\n\nb\n\nc\nc\nc\n\na\n\n", "", 0],
  ["uniq --group=prepend r", "\na\na\n\nb\n\nc\nc\nc\n\na\n", "", 0],
  ["uniq --group=bad r", "", "uniq: invalid argument ‘bad’ for ‘--group’\nValid arguments are:\n  - ‘prepend’\n  - ‘append’\n  - ‘separate’\n  - ‘both’\nTry 'uniq --help' for more information.\n", 1],
  ["uniq --group -c r", "", "uniq: --group is mutually exclusive with -c/-d/-D/-u\nTry 'uniq --help' for more information.\n", 1],
  ["cut -d: -f1 c", "a\nd\nf\n\n", "", 0],
  ["cut -d: -f2- c", "b:c\ne\nf\nx:\n", "", 0],
  ["cut -d: -f1,3 c", "a:c\nd\nf\n:\n", "", 0],
  ["cut -d: -s -f1 c", "a\nd\n\n", "", 0],
  ["cut -d: -f2 -s c", "b\ne\nx\n", "", 0],
  ["cut -d: -f-2 c", "a:b\nd:e\nf\n:x\n", "", 0],
  ["cut -d: --complement -f2 c", "a:c\nd\nf\n:\n", "", 0],
  ["cut -d: -f1,3 --output-delimiter=- c", "a-c\nd\nf\n-\n", "", 0],
  ["cut -c1-3 u", "hé\nñ\n", "", 0],
  ["cut -b1-2 f", "a \nc\n", "", 0],
  ["cut -b2 u", "�\n�\n", "", 0],
  ["cut -c1,3 --complement f", " \n\n", "", 0],
  ["cut -f1 t", "tab\n\n  lead\n", "", 0],
  ["cut -f2 t", "here  x\n\n  lead\n", "", 0],
  ["cut -f 1,2 -d' ' f", "a b\nc\n", "", 0],
  ["cut -c3-1 f", "", "cut: invalid decreasing range\nTry 'cut --help' for more information.\n", 1],
  ["cut -f0 f", "", "cut: fields are numbered from 1\nTry 'cut --help' for more information.\n", 1],
  ["cut -f a f", "", "cut: invalid field value ‘a’\nTry 'cut --help' for more information.\n", 1],
  ["cut f", "", "cut: you must specify a list of bytes, characters, or fields\nTry 'cut --help' for more information.\n", 1],
  ["cut -f1 -c1 f", "", "cut: only one list may be specified\nTry 'cut --help' for more information.\n", 1],
  ["cut -d: -c1 f", "", "cut: an input delimiter may be specified only when operating on fields\nTry 'cut --help' for more information.\n", 1],
  ["cut -d:: -f1 f", "", "cut: the delimiter must be a single character\nTry 'cut --help' for more information.\n", 1],
  ["cut -s -c1 f", "", "cut: suppressing non-delimited lines makes sense\n\tonly when operating on fields\nTry 'cut --help' for more information.\n", 1],
  ["cut -f 1- c", "a:b:c\nd:e\nf\n:x:\n", "", 0],
  ["cut -f -1 c", "a:b:c\nd:e\nf\n:x:\n", "", 0],
  ["cut -f 2-,1 c", "a:b:c\nd:e\nf\n:x:\n", "", 0],
  ["cut -f1-2,2-3 -d: c", "a:b:c\nd:e\nf\n:x:\n", "", 0],
  ["cut -c1 nonex f", "a\nc\n", "cut: nonex: No such file or directory\n", 1],
  ["cut -f1 -d: c f", "a\nd\nf\n\na b\nc\n", "", 0],
  ["cut -f '' c", "", "cut: fields are numbered from 1\nTry 'cut --help' for more information.\n", 1],
  ["cut -f ',' c", "", "cut: fields are numbered from 1\nTry 'cut --help' for more information.\n", 1],
  ["cut -f '1,,2' c", "", "cut: fields are numbered from 1\nTry 'cut --help' for more information.\n", 1],
  ["cut -c - f", "", "cut: invalid range with no endpoint: -\nTry 'cut --help' for more information.\n", 1],
  ["cut -c -- f", "", "cut: invalid byte or character range\nTry 'cut --help' for more information.\n", 1],
]);

table("sort matches GNU", "printf 'banana\\nApple\\ncherry\\napple\\nBanana\\n10\\n9\\n2\\n' > w; printf 'b 3\\na 10\\nc 2\\na 2\\nb 3\\n' > k; printf 'root:x:0:0\\nbin:x:2:2\\nkali:x:1000:1000\\ndaemon:x:1:1\\n' > p; printf '10K\\n2M\\n1G\\n500\\n3k\\n-1K\\n' > h; printf 'Mar 3\\nJan 5\\nfeb 1\\nDec 9\\nxyz\\n' > m; printf 'v1.10\\nv1.2\\nv1.9\\nv10.0\\nv2\\nfile~\\nfile\\n' > v; printf '  b\\na\\n   c\\n' > bl; printf '1e3\\n5\\nabc\\n-2.5\\n0x10\\n 7\\n' > gn; printf 'a b\\na  b\\nb a\\n' > sp; printf 'dup\\ndup\\nuniq\\nDup\\n' > du; printf 'b,2\\na,1\\n' > csv", 'C', [
  ["sort w", "10\n2\n9\nApple\nBanana\napple\nbanana\ncherry\n", "", 0],
  ["sort -r w", "cherry\nbanana\napple\nBanana\nApple\n9\n2\n10\n", "", 0],
  ["sort -f w", "10\n2\n9\nApple\napple\nBanana\nbanana\ncherry\n", "", 0],
  ["sort -u w", "10\n2\n9\nApple\nBanana\napple\nbanana\ncherry\n", "", 0],
  ["sort -fu w", "10\n2\n9\nApple\nbanana\ncherry\n", "", 0],
  ["sort -n w", "Apple\nBanana\napple\nbanana\ncherry\n2\n9\n10\n", "", 0],
  ["sort -nr w", "10\n9\n2\ncherry\nbanana\napple\nBanana\nApple\n", "", 0],
  ["sort -k2 k", "a 10\na 2\nc 2\nb 3\nb 3\n", "", 0],
  ["sort -k2n k", "a 2\nc 2\nb 3\nb 3\na 10\n", "", 0],
  ["sort -k2,2n -k1,1r k", "c 2\na 2\nb 3\nb 3\na 10\n", "", 0],
  ["sort -k2nr k", "a 10\nb 3\nb 3\na 2\nc 2\n", "", 0],
  ["sort -k 1,1 -k 2n k", "a 2\na 10\nb 3\nb 3\nc 2\n", "", 0],
  ["sort -u -k1,1 k", "a 10\nb 3\nc 2\n", "", 0],
  ["sort -s -k1,1 k", "a 10\na 2\nb 3\nb 3\nc 2\n", "", 0],
  ["sort -t: -k3 -n p", "root:x:0:0\ndaemon:x:1:1\nbin:x:2:2\nkali:x:1000:1000\n", "", 0],
  ["sort -t: -k3,3nr p", "kali:x:1000:1000\nbin:x:2:2\ndaemon:x:1:1\nroot:x:0:0\n", "", 0],
  ["sort -t: -k4 p", "root:x:0:0\ndaemon:x:1:1\nkali:x:1000:1000\nbin:x:2:2\n", "", 0],
  ["sort -t: -k1.2 p", "daemon:x:1:1\nkali:x:1000:1000\nbin:x:2:2\nroot:x:0:0\n", "", 0],
  ["sort -t: -k1.2,1.3 p", "daemon:x:1:1\nkali:x:1000:1000\nbin:x:2:2\nroot:x:0:0\n", "", 0],
  ["sort -t: -k2 p", "root:x:0:0\nkali:x:1000:1000\ndaemon:x:1:1\nbin:x:2:2\n", "", 0],
  ["sort -h h", "-1K\n500\n3k\n10K\n2M\n1G\n", "", 0],
  ["sort -hr h", "1G\n2M\n10K\n3k\n500\n-1K\n", "", 0],
  ["sort -M m", "xyz\nJan 5\nfeb 1\nMar 3\nDec 9\n", "", 0],
  ["sort -V v", "file~\nfile\nv1.2\nv1.9\nv1.10\nv2\nv10.0\n", "", 0],
  ["sort -g gn", "abc\n-2.5\n5\n 7\n0x10\n1e3\n", "", 0],
  ["sort -n gn", "-2.5\n0x10\nabc\n1e3\n5\n 7\n", "", 0],
  ["sort -b bl", "a\n  b\n   c\n", "", 0],
  ["sort -k1b bl", "a\n  b\n   c\n", "", 0],
  ["sort -k1 bl", "   c\n  b\na\n", "", 0],
  ["sort -d w", "10\n2\n9\nApple\nBanana\napple\nbanana\ncherry\n", "", 0],
  ["sort -i w", "10\n2\n9\nApple\nBanana\napple\nbanana\ncherry\n", "", 0],
  ["sort -c w", "", "sort: w:2: disorder: Apple\n", 1],
  ["sort -c w; echo $?", "1\n", "sort: w:2: disorder: Apple\n", 0],
  ["sort -C w; echo $?", "1\n", "", 0],
  ["sort w | sort -c; echo $?", "0\n", "", 0],
  ["sort -cu du; echo $?", "1\n", "sort: du:2: disorder: dup\n", 0],
  ["sort -o out w; cat out", "10\n2\n9\nApple\nBanana\napple\nbanana\ncherry\n", "", 0],
  ["sort w -o out; cat out", "10\n2\n9\nApple\nBanana\napple\nbanana\ncherry\n", "", 0],
  ["sort -t, -k2 csv", "a,1\nb,2\n", "", 0],
  ["sort -k1 sp", "a  b\na b\nb a\n", "", 0],
  ["sort -k2 sp", "a  b\nb a\na b\n", "", 0],
  ["sort nonex", "", "sort: cannot read: nonex: No such file or directory\n", 2],
  ["sort w nonex", "", "sort: cannot read: nonex: No such file or directory\n", 2],
  ["sort -k x w", "", "sort: invalid number at field start: invalid count at start of 'x'\n", 2],
  ["sort -k 0 w", "", "sort: field number is zero: invalid field specification '0'\n", 2],
  ["sort -k1.0 w", "", "sort: character offset is zero: invalid field specification '1.0'\n", 2],
  ["sort -k 1,1.0 w", "10\n2\n9\nApple\nBanana\napple\nbanana\ncherry\n", "", 0],
  ["sort -k1,2x w", "", "sort: stray character in field spec: invalid field specification '1,2x'\n", 2],
  ["sort -nM w", "", "sort: options '-Mn' are incompatible\n", 2],
  ["sort -t ab w", "", "sort: multi-character tab 'ab'\n", 2],
  ["sort -Q w", "", "sort: invalid option -- 'Q'\nTry 'sort --help' for more information.\n", 2],
  ["sort --sort=numeric w", "Apple\nBanana\napple\nbanana\ncherry\n2\n9\n10\n", "", 0],
  ["sort --sort=version v", "file~\nfile\nv1.2\nv1.9\nv1.10\nv2\nv10.0\n", "", 0],
  ["sort --reverse --unique du", "uniq\ndup\nDup\n", "", 0],
  ["printf 'x\\ny' | sort", "x\ny\n", "", 0],
  ["printf '' | sort", "", "", 0],
  ["sort -k2,2 -k1,1 k", "a 10\na 2\nc 2\nb 3\nb 3\n", "", 0],
  ["sort -n -k2 k", "a 2\nc 2\nb 3\nb 3\na 10\n", "", 0],
  ["sort -r -k2 k", "b 3\nb 3\nc 2\na 2\na 10\n", "", 0],
  ["sort -k2r k", "b 3\nb 3\na 2\nc 2\na 10\n", "", 0],
  ["sort -nk2 k", "a 2\nc 2\nb 3\nb 3\na 10\n", "", 0],
  ["sort -m w w", "banana\nApple\nbanana\nApple\ncherry\napple\nBanana\n10\n9\n2\ncherry\napple\nBanana\n10\n9\n2\n", "", 0],
  ["sort -bk2 k", "a 10\na 2\nc 2\nb 3\nb 3\n", "", 0],
  ["sort -s -n k", "b 3\na 10\nc 2\na 2\nb 3\n", "", 0],
  ["sort -rn k", "c 2\nb 3\nb 3\na 2\na 10\n", "", 0],
  ["sort -u -n k", "b 3\n", "", 0],
  ["sort -k 2.2 sp", "a  b\nb a\na b\n", "", 0],
  ["sort -k1,1.2 p", "bin:x:2:2\ndaemon:x:1:1\nkali:x:1000:1000\nroot:x:0:0\n", "", 0],
]);


test('wc, sort, uniq and cut in pipelines', async () => {
  assert.equal(await out("printf 'b\\na\\nb\\nc\\nb\\n' | sort | uniq -c | sort -rn"), '      3 b\n      1 c\n      1 a\n');
  assert.equal(await out("printf 'a:1\\nb:2\\n' | cut -d: -f2 | sort -nr | wc -l"), '2\n');
});

test('--help and --version', async () => {
  for (const name of ['wc', 'sort', 'uniq', 'cut']) {
    assert.match((await run(name + ' --version')).out, new RegExp('^' + name + ' \\(GNU coreutils\\) 9\\.'));
    assert.match((await run(name + ' --help')).out, new RegExp('^Usage: ' + name + ' '));
  }
  assert.equal((await run('wc --bogus')).code, 1);
  assert.equal((await run('sort --bogus')).code, 2);
});

table("tr matches GNU", "printf 'Hello  World aab\\n' > in; printf 'a\\tb\\r\\nc d\\n' > dos; printf 'x\\ny\\n' > xy", 'C.UTF-8', [
  ["tr < in", "", "tr: missing operand\nTry 'tr --help' for more information.\n", 1],
  ["tr a < in", "", "tr: missing operand after ‘a’\nTwo strings must be given when translating.\nTry 'tr --help' for more information.\n", 1],
  ["tr a b c < in", "", "tr: extra operand ‘c’\nTry 'tr --help' for more information.\n", 1],
  ["tr -d a b < in", "", "tr: extra operand ‘b’\nOnly one string may be given when deleting without squeezing repeats.\nTry 'tr --help' for more information.\n", 1],
  ["tr -s < in", "", "tr: missing operand\nTry 'tr --help' for more information.\n", 1],
  ["tr -ds a < in", "", "tr: missing operand after ‘a’\nTwo strings must be given when both deleting and squeezing repeats.\nTry 'tr --help' for more information.\n", 1],
  ["tr a '' < in", "", "tr: when not truncating set1, string2 must be non-empty\n", 1],
  ["tr -t a '' < in", "Hello  World aab\n", "", 0],
  ["tr z-a x < in", "", "tr: range-endpoints of 'z-a' are in reverse collating sequence order\n", 1],
  ["tr '[:foo:]' x < in", "", "tr: invalid character class ‘foo’\n", 1],
  ["tr a '[:alpha:]' < in", "", "tr: when translating, the only character classes that may appear in\nstring2 are 'upper' and 'lower'\n", 1],
  ["tr '[:upper:]' '[:lower:]' < in", "hello  world aab\n", "", 0],
  ["tr '[:lower:]' '[:upper:]' < in", "HELLO  WORLD AAB\n", "", 0],
  ["tr 'a-z' 'A-Z' < in", "HELLO  WORLD AAB\n", "", 0],
  ["tr '[a*]' b < in", "", "tr: the [c*] repeat construct may not appear in string1\n", 1],
  ["tr a '[b*2]c' < in", "Hello  World bbb\n", "", 0],
  ["tr -c a < in", "", "tr: missing operand after ‘a’\nTwo strings must be given when translating.\nTry 'tr --help' for more information.\n", 1],
  ["tr -cd '[:alnum:]' < in", "HelloWorldaab", "", 0],
  ["tr 'a-c' 'A-B' < in", "Hello  World AAB\n", "", 0],
  ["tr -t 'a-c' 'A-B' < in", "Hello  World AAB\n", "", 0],
  ["tr aa xy < in", "Hello  World yyb\n", "", 0],
  ["tr ab 'x\\' < in", "Hello  World xx\\\n", "tr: warning: an unescaped backslash at end of string is not portable\n", 0],
  ["tr -x a < in", "", "tr: invalid option -- 'x'\nTry 'tr --help' for more information.\n", 1],
  ["tr '[=a=]' x < in", "Hello  World xxb\n", "", 0],
  ["tr -s ' ' < in", "Hello World aab\n", "", 0],
  ["tr -cs 'a-z' '\\n' < in", "\nello\norld\naab\n", "", 0],
  ["tr -ds 'a' 'b' < in", "Hello  World b\n", "", 0],
  ["tr ab 'x[:upper:]' < in", "", "tr: misaligned [:upper:] and/or [:lower:] construct\n", 1],
  ["tr '\\101-\\103' x < in", "Hello  World aab\n", "", 0],
  ["tr 'a-' x < in", "Hello  World xxb\n", "", 0],
  ["tr -d '\\r' < dos", "a\tb\nc d\n", "", 0],
  ["tr '\\t' ' ' < dos", "a b\r\nc d\n", "", 0],
  ["tr -d '\\n' < xy", "xy", "", 0],
  ["tr -d '[:space:]' < dos", "abcd", "", 0],
  ["tr 'a-y' 'b-z' < in", "Hfmmp  Wpsme bbc\n", "", 0],
  ["tr -s 'a-z' < in", "Helo  World ab\n", "", 0],
  ["tr -s 'lo' 'LO' < in", "HeLO  WOrLd aab\n", "", 0],
  ["tr -c '[:alpha:]' '_' < in", "Hello__World_aab_", "", 0],
  ["tr -C 'a-z' '[X*]' < in", "XelloXXXorldXaabX", "", 0],
  ["tr 'abc' '[X*]' < in", "Hello  World XXX\n", "", 0],
  ["tr a-c '[A*2]' < in", "Hello  World AAA\n", "", 0],
  ["tr -d 'a-z' < in", "H  W \n", "", 0],
  ["tr -dc 'a-z' < in", "elloorldaab", "", 0],
  ["tr '[:alpha:]' '[X*]' < in", "XXXXX  XXXXX XXX\n", "", 0],
  ["echo 'é à' | tr 'a-zé' 'A-Z_'", "__ _�\n", "", 0],
  ["echo hello | tr -- '-a' x", "hello\n", "", 0],
  ["tr '\\n' ',' < xy", "x,y,", "", 0],
  ["tr -d '\\000' < xy", "x\ny\n", "", 0],
  ["tr '[:punct:]' '.' < dos", "a\tb\r\nc d\n", "", 0],
  ["tr '\\\\' '/' < in", "Hello  World aab\n", "", 0],
  ["tr -s '\\n' < xy", "x\ny\n", "", 0],
  ["tr '[a-c]' '[A-C]' < in", "Hello  World AAB\n", "", 0],
  ["tr -d -- '-' < in", "Hello  World aab\n", "", 0],
  ["tr 'a-c-e' x < in", "Hxllo  World xxx\n", "", 0],
  ["tr '[:digit:]-' x < in", "Hello  World aab\n", "", 0],
  ["tr '[]' x < in", "Hello  World aab\n", "", 0],
  ["tr '[' x < in", "Hello  World aab\n", "", 0],
  ["tr 'a[' '\\n' < in", "Hello  World \n\nb\n", "", 0],
  ["tr '[x' y < in", "Hello  World aab\n", "", 0],
  ["tr '[x*' y < in", "Hello  World aab\n", "", 0],
  ["tr '[x*]' y < in", "", "tr: the [c*] repeat construct may not appear in string1\n", 1],
]);

table("xargs matches GNU", "printf 'a b\\n\"c d\" e\\n' > xin; printf 'one two\\nthree\\n' > l", 'C.UTF-8', [
  ["xargs -n1 echo < xin", "a\nb\nc d\ne\n", "", 0],
  ["xargs echo < /dev/null", "\n", "", 0],
  ["xargs -r echo hi < /dev/null", "", "", 0],
  ["xargs -I{} echo [{}] < xin", "[a b]\n[c d e]\n", "", 0],
  ["xargs -I{} echo [{}] < /dev/null", "", "", 0],
  ["xargs -L1 echo < xin", "a b\nc d e\n", "", 0],
  ["xargs -n2 -t echo < xin", "a b\nc d e\n", "echo a b\necho 'c d' e\n", 0],
  ["xargs -d, echo < xin", "a b\n\"c d\" e\n\n", "", 0],
  ["printf 'a\\0b c\\0' | xargs -0 -n1 echo", "a\nb c\n", "", 0],
  ["echo \"it's\" | xargs echo", "", "xargs: unmatched single quote; by default quotes are special to xargs unless you use the -0 option\n", 1],
  ["echo 'a\"b' | xargs echo", "", "xargs: unmatched double quote; by default quotes are special to xargs unless you use the -0 option\n", 1],
  ["xargs nonexistentcmd < xin; echo $?", "127\n", "xargs: nonexistentcmd: No such file or directory\n", 0],
  ["xargs -n0 echo < xin", "", "xargs: value 0 for -n option should be >= 1\nTry 'xargs --help' for more information.\n", 1],
  ["xargs -L0 echo < xin", "", "xargs: value 0 for -L option should be >= 1\nTry 'xargs --help' for more information.\n", 1],
  ["xargs -n x echo < xin", "", "xargs: invalid number \"x\" for -n option\nTry 'xargs --help' for more information.\n", 1],
  ["xargs -E c echo < xin", "a b c d e\n", "", 0],
  ["xargs sh -c 'exit 1' < xin; echo $?", "123\n", "", 0],
  ["printf '1\\n2\\n3\\n' | xargs -n2 echo", "1 2\n3\n", "", 0],
  ["printf 'a  b\\n' | xargs -I X echo 'X-X'", "a  b-a  b\n", "", 0],
  ["printf ' a\\n b \\n' | xargs -I X echo '<X>'", "<a>\n<b >\n", "", 0],
  ["printf 'a b\\nc\\n\\nd\\n' | xargs -L2 echo", "a b c\nd\n", "", 0],
  ["printf 'a \\nb\\nc\\n' | xargs -L1 echo", "a b\nc\n", "", 0],
  ["printf 'a\\\\ b\\n' | xargs echo", "a b\n", "", 0],
  ["xargs -a xin -n1 echo", "a\nb\nc d\ne\n", "", 0],
  ["xargs -a nonex echo", "", "xargs: Cannot open input file ‘nonex’: No such file or directory\n", 1],
  ["xargs -i echo '{}x' < xin", "a bx\nc d ex\n", "", 0],
  ["echo a b c | xargs -n 2 -I{} echo {}", "a b c\n", "xargs: warning: options --max-args and --replace/-I/-i are mutually exclusive, ignoring previous --max-args value\n", 0],
  ["xargs -n1 echo < /dev/null", "\n", "", 0],
  ["xargs -L1 echo < /dev/null", "\n", "", 0],
  ["printf 'a\\nSTOP\\nb\\n' | xargs -E STOP echo", "a\n", "", 0],
  ["printf 'x y z\\n' | xargs -n1 -t echo", "x\ny\nz\n", "echo x\necho y\necho z\n", 0],
  ["printf 'a b\\n' | xargs -t echo \"it's\"", "it's a b\n", "echo \"it's\" a b\n", 0],
  ["printf 'a\\n' | xargs", "a\n", "", 0],
  ["xargs --bogus", "", "xargs: unrecognized option '--bogus'\nTry 'xargs --help' for more information.\n", 1],
  ["printf 'a\\nb\\n' | xargs -n1 -I@ echo @ @", "a a\nb b\n", "xargs: warning: options --max-args and --replace/-I/-i are mutually exclusive, ignoring previous --max-args value\n", 0],
  ["printf 'b\\na\\n' | xargs -L1 echo x", "x b\nx a\n", "", 0],
  ["printf 'a\\n' | xargs -d '\\n' echo", "a\n", "", 0],
  ["printf 'a,b,c' | xargs -d, -n1 echo", "a\nb\nc\n", "", 0],
]);

table("seq and tee match GNU", "printf 'x\\ny\\n' > xy; printf 'old\\n' > old", 'C.UTF-8', [
  ["seq", "", "seq: missing operand\nTry 'seq --help' for more information.\n", 1],
  ["seq a", "", "seq: invalid floating point argument: ‘a’\nTry 'seq --help' for more information.\n", 1],
  ["seq 1 2 3 4", "", "seq: extra operand ‘4’\nTry 'seq --help' for more information.\n", 1],
  ["seq 0 1 3", "0\n1\n2\n3\n", "", 0],
  ["seq 1 0 3", "", "seq: invalid Zero increment value: ‘0’\nTry 'seq --help' for more information.\n", 1],
  ["seq 3 -1 1", "3\n2\n1\n", "", 0],
  ["seq 1.5", "1\n", "", 0],
  ["seq 0.5 0.25 2", "0.50\n0.75\n1.00\n1.25\n1.50\n1.75\n2.00\n", "", 0],
  ["seq -w 8 10", "08\n09\n10\n", "", 0],
  ["seq -s, 3", "1,2,3\n", "", 0],
  ["seq -f %03g 3", "001\n002\n003\n", "", 0],
  ["seq -f %d 3", "", "seq: format ‘%d’ has unknown %d directive\n", 1],
  ["seq -f '%.2f' 1 3", "1.00\n2.00\n3.00\n", "", 0],
  ["seq -f 'x%gy' 2", "x1y\nx2y\n", "", 0],
  ["seq -w -f %g 3", "", "seq: format string may not be specified when printing equal width strings\nTry 'seq --help' for more information.\n", 1],
  ["seq -f 'a' 3", "", "seq: format ‘a’ has no % directive\n", 1],
  ["seq -f '%g%g' 3", "", "seq: format ‘%g%g’ has too many % directives\n", 1],
  ["seq -f '%%%g' 2", "%1\n%2\n", "", 0],
  ["seq 1e2 e 1", "", "seq: invalid floating point argument: ‘e’\nTry 'seq --help' for more information.\n", 1],
  ["seq 10 -3 0", "10\n7\n4\n1\n", "", 0],
  ["seq 5 1", "", "", 0],
  ["seq -w 1 0.5 3", "1.0\n1.5\n2.0\n2.5\n3.0\n", "", 0],
  ["seq -s 'ab' 3", "1ab2ab3\n", "", 0],
  ["seq -w 08 10", "08\n09\n10\n", "", 0],
  ["seq -s: -w 99 101", "099:100:101\n", "", 0],
  ["seq 3.0", "1\n2\n3\n", "", 0],
  ["seq 1e1", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "", 0],
  ["seq 2 1e0 4", "2\n3\n4\n", "", 0],
  ["seq --equal-width 3 5", "3\n4\n5\n", "", 0],
  ["seq -- -3 -1", "-3\n-2\n-1\n", "", 0],
  ["seq -2", "", "", 0],
  ["seq nan", "", "seq: invalid ‘not-a-number’ argument: ‘nan’\nTry 'seq --help' for more information.\n", 1],
  ["seq 0.1 0.1 0.5", "0.1\n0.2\n0.3\n0.4\n0.5\n", "", 0],
  ["seq 1 -1", "", "", 0],
  ["seq 1 +2 5", "1\n3\n5\n", "", 0],
  ["seq -w -5 -1", "-5\n-4\n-3\n-2\n-1\n", "", 0],
  ["seq -w -1 1", "-1\n00\n01\n", "", 0],
  ["seq -f '%5.1f' 1 3", "  1.0\n  2.0\n  3.0\n", "", 0],
  ["seq -f '%e' 2", "1.000000e+00\n2.000000e+00\n", "", 0],
  ["seq -f '%x' 2", "", "seq: format ‘%x’ has unknown %x directive\n", 1],
  ["seq 0", "", "", 0],
  ["seq 1 1", "1\n", "", 0],
  ["seq -3 -1", "-3\n-2\n-1\n", "", 0],
  ["seq 1 2", "1\n2\n", "", 0],
  ["seq -s ' ' 5", "1 2 3 4 5\n", "", 0],
  ["seq --separator=- 3", "1-2-3\n", "", 0],
  ["seq --format=%g 2", "1\n2\n", "", 0],
  ["seq 10 5 30", "10\n15\n20\n25\n30\n", "", 0],
  ["tee", "", "", 0],
  ["tee f < xy; grep '' f", "x\ny\nx\ny\n", "", 0],
  ["tee -a old < xy; grep '' old", "x\ny\nold\nx\ny\n", "", 0],
  ["tee a b < xy; grep '' a b", "x\ny\na:x\na:y\nb:x\nb:y\n", "", 0],
  ["tee /nonexistent/f < xy; echo $?", "x\ny\n1\n", "tee: /nonexistent/f: No such file or directory\n", 0],
  ["tee -a f < xy; tee -a f < xy; grep '' f", "x\ny\nx\ny\nx\ny\nx\ny\n", "", 0],
  ["tee --bogus < xy", "", "tee: unrecognized option '--bogus'\nTry 'tee --help' for more information.\n", 1],
  ["tee -z < xy", "", "tee: invalid option -- 'z'\nTry 'tee --help' for more information.\n", 1],
]);


test('yes: bounded when captured, interruptible on the terminal', async () => {
  const lines = (await out('yes')).split('\n');
  assert.equal(lines[0], 'y');
  assert.ok(lines.length > 1000 && lines.length < 100000, 'bounded');
  assert.equal(await out('yes no thanks | grep -c "no thanks"'), String((await out('yes no thanks')).split('\n').length - 1) + '\n');
  assert.match((await run('yes --version')).out, /^yes \(GNU coreutils\)/);
  const { K, shell, term } = sim;
  K.clock.useReal(); K.settings.timeScale = 1;
  const p = shell.runLine('yes');
  setTimeout(() => term.raiseInterrupt(), 30);
  assert.equal(await p, 130);
  term.take();
  K.clock.useVirtual();
});

test('xargs runs commands through the shell and tee passes data on', async () => {
  assert.equal(await out("printf 'a\\nb\\n' | xargs -n1 echo item"), 'item a\nitem b\n');
  assert.equal(await out("printf 'a\\nb\\n' | tee /tmp/tee1.txt | grep -c ."), '2\n');
  assert.equal(await out('grep -c . /tmp/tee1.txt'), '2\n');
});

table("checksum tools match GNU", "printf 'hello\\n' > a; printf 'héllo wörld\\n' > u; : > empty; mkdir dd; printf 'two\\n' > 'sp ace'", 'C.UTF-8', [
  ["md5sum a", "b1946ac92492d2347c6235b4d2611184  a\n", "", 0],
  ["md5sum a u empty", "b1946ac92492d2347c6235b4d2611184  a\ne51a0dabd365a5b1533d3f4b0e097fb3  u\nd41d8cd98f00b204e9800998ecf8427e  empty\n", "", 0],
  ["md5sum < a", "b1946ac92492d2347c6235b4d2611184  -\n", "", 0],
  ["md5sum - < a", "b1946ac92492d2347c6235b4d2611184  -\n", "", 0],
  ["md5sum --tag a u", "MD5 (a) = b1946ac92492d2347c6235b4d2611184\nMD5 (u) = e51a0dabd365a5b1533d3f4b0e097fb3\n", "", 0],
  ["md5sum -b a", "b1946ac92492d2347c6235b4d2611184 *a\n", "", 0],
  ["md5sum -t a", "b1946ac92492d2347c6235b4d2611184  a\n", "", 0],
  ["md5sum nonex", "", "md5sum: nonex: No such file or directory\n", 1],
  ["md5sum a nonex; echo $?", "b1946ac92492d2347c6235b4d2611184  a\n1\n", "md5sum: nonex: No such file or directory\n", 0],
  ["md5sum dd", "", "md5sum: dd: Is a directory\n", 1],
  ["md5sum 'sp ace'", "c193497a1a06b2c72230e6146ff47080  sp ace\n", "", 0],
  ["sha1sum a", "f572d396fae9206628714fb2ce00f72e94f2258f  a\n", "", 0],
  ["sha224sum a", "2d6d67d91d0badcdd06cbbba1fe11538a68a37ec9c2e26457ceff12b  a\n", "", 0],
  ["sha256sum a u", "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  a\n3828eeee974aa7486e7acc258e5c73a0115e168444d6688deb8d5d1306d1f57d  u\n", "", 0],
  ["sha384sum a", "1d0f284efe3edea4b9ca3bd514fa134b17eae361ccc7a1eefeff801b9bd6604e01f21f6bf249ef030599f0c218f2ba8c  a\n", "", 0],
  ["sha512sum a", "e7c22b994c59d9cf2b48e549b1e24666636045930d3da7c1acb299d1c3b7f931f94aae41edda2c2b207a36e10f8bcb8d45223e54878f5b316e7ce3b6bc019629  a\n", "", 0],
  ["sha256sum --tag a", "SHA256 (a) = 5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03\n", "", 0],
  ["sha256sum -z a", "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  a\u0000", "", 0],
  ["sha256sum a > sums; sha256sum -c sums", "a: OK\n", "", 0],
  ["sha256sum a u > sums; sha256sum -c sums; echo $?", "a: OK\nu: OK\n0\n", "", 0],
  ["sha256sum a u > sums; echo changed >> a; sha256sum -c sums; echo $?", "a: FAILED\nu: OK\n1\n", "sha256sum: WARNING: 1 computed checksum did NOT match\n", 0],
  ["sha256sum a u > sums; echo changed >> a; sha256sum -c --quiet sums; echo $?", "a: FAILED\n1\n", "sha256sum: WARNING: 1 computed checksum did NOT match\n", 0],
  ["sha256sum a u > sums; echo changed >> a; sha256sum -c --status sums; echo $?", "1\n", "", 0],
  ["sha256sum a nonex > sums; sha256sum -c sums; echo $?", "a: OK\n0\n", "sha256sum: nonex: No such file or directory\n", 0],
  ["sha256sum --tag a u > sums; sha256sum -c sums; echo $?", "a: OK\nu: OK\n0\n", "", 0],
  ["printf 'garbage\\n' > sums; sha256sum -c sums; echo $?", "1\n", "sha256sum: sums: no properly formatted checksum lines found\n", 0],
  ["printf 'garbage\\n' > sums; md5sum -c sums; echo $?", "1\n", "md5sum: sums: no properly formatted checksum lines found\n", 0],
  ["sha1sum a > sums; printf 'bad line\\n' >> sums; sha1sum -c sums; echo $?", "a: OK\n0\n", "sha1sum: WARNING: 1 line is improperly formatted\n", 0],
  ["sha1sum a > sums; printf 'bad line\\n' >> sums; sha1sum -c --warn sums; echo $?", "a: OK\n0\n", "sha1sum: sums: 2: improperly formatted SHA1 checksum line\nsha1sum: WARNING: 1 line is improperly formatted\n", 0],
  ["sha1sum a > sums; printf 'bad line\\n' >> sums; sha1sum -c --strict sums; echo $?", "a: OK\n1\n", "sha1sum: WARNING: 1 line is improperly formatted\n", 0],
  ["sha1sum a nonex > sums; sha1sum -c --ignore-missing sums; echo $?", "a: OK\n0\n", "sha1sum: nonex: No such file or directory\n", 0],
  ["sha1sum nonex > sums; sha1sum -c --ignore-missing sums; echo $?", "1\n", "sha1sum: nonex: No such file or directory\nsha1sum: sums: no properly formatted checksum lines found\n", 0],
  ["sha1sum -c nonexlist; echo $?", "1\n", "sha1sum: nonexlist: No such file or directory\n", 0],
  ["sha1sum a | sha1sum -c; echo $?", "a: OK\n0\n", "", 0],
  ["sha1sum --quiet a", "", "sha1sum: the --quiet option is meaningful only when verifying checksums\nTry 'sha1sum --help' for more information.\n", 1],
  ["sha1sum --check --tag a", "", "sha1sum: the --tag option is meaningless when verifying checksums\nTry 'sha1sum --help' for more information.\n", 1],
  ["md5sum --bogus a", "", "md5sum: unrecognized option '--bogus'\nTry 'md5sum --help' for more information.\n", 1],
  ["sha256sum a a", "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  a\n5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  a\n", "", 0],
  ["sha512sum empty", "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e  empty\n", "", 0],
  ["md5sum --warn a", "", "md5sum: the --warn option is meaningful only when verifying checksums\nTry 'md5sum --help' for more information.\n", 1],
  ["md5sum --status a", "", "md5sum: the --status option is meaningful only when verifying checksums\nTry 'md5sum --help' for more information.\n", 1],
  ["sha256sum a | md5sum", "622e62086ae2bdb9520066b88bc2ae45  -\n", "", 0],
]);

table("base64, base32 and strings match GNU", "printf 'hello\\n' > a; printf 'abcdefgh' > b8; printf 'hi\\0there\\1\\2 and more text\\n\\0\\0x\\0longer string here\\n' > bin; printf 'aGVsbG8K' > enc; printf '\\xff\\xfe' > raw", 'C.UTF-8', [
  ["echo hello | base64", "aGVsbG8K\n", "", 0],
  ["echo hello | base64 -w 4", "aGVs\nbG8K\n", "", 0],
  ["echo hello | base64 -w0", "aGVsbG8K", "", 0],
  ["echo aGVsbG8K | base64 -d", "hello\n", "", 0],
  ["echo aGVsbG8 | base64 -d", "hello", "base64: invalid input\n", 1],
  ["echo 'aGVs bG8K' | base64 -d", "hel", "base64: invalid input\n", 1],
  ["echo '!!!' | base64 -d", "", "base64: invalid input\n", 1],
  ["echo 'aGVs!bG8K' | base64 -d", "hel", "base64: invalid input\n", 1],
  ["echo 'aGVs!bG8K' | base64 -di", "hello\n", "", 0],
  ["echo hello | base32", "NBSWY3DPBI======\n", "", 0],
  ["echo NBSWY3DPBI====== | base32 -d", "hello\n", "", 0],
  ["echo hello | base64 -w x", "", "base64: invalid wrap size: ‘x’\n", 1],
  ["base64 a b", "", "base64: extra operand ‘b’\nTry 'base64 --help' for more information.\n", 1],
  ["base64 nonex", "", "base64: nonex: No such file or directory\n", 1],
  ["base64 -d nonex", "", "base64: nonex: No such file or directory\n", 1],
  ["printf '' | base64", "", "", 0],
  ["printf 'a' | base64", "YQ==\n", "", 0],
  ["printf 'ab' | base64", "YWI=\n", "", 0],
  ["echo 'YQ' | base64 -d", "a", "base64: invalid input\n", 1],
  ["echo 'YQ=' | base64 -d", "a", "base64: invalid input\n", 1],
  ["echo 'YQ==YQ==' | base64 -d", "aa", "", 0],
  ["printf 'abcdefgh' | base32 -w 8", "MFRGGZDF\nMZTWQ===\n", "", 0],
  ["echo x | base32 -w0", "PAFA====", "", 0],
  ["base64 --wrap", "", "base64: option '--wrap' requires an argument\nTry 'base64 --help' for more information.\n", 1],
  ["echo hello | base64 -w -1", "", "base64: invalid wrap size: ‘-1’\n", 1],
  ["echo hello | base64 --wrap=3", "aGV\nsbG\n8K\n", "", 0],
  ["echo hello | base64 -x", "", "base64: invalid option -- 'x'\nTry 'base64 --help' for more information.\n", 1],
  ["echo 'YWJj' | base64 --decode --ignore-garbage", "abc", "", 0],
  ["base64 a", "aGVsbG8K\n", "", 0],
  ["base64 -d enc", "hello\n", "", 0],
  ["base64 < a", "aGVsbG8K\n", "", 0],
  ["base32 b8", "MFRGGZDFMZTWQ===\n", "", 0],
  ["base32 -d b8; echo $?", "1\n", "base32: invalid input\n", 0],
  ["echo 'MFRGG===' | base32 -d", "abc", "", 0],
  ["echo 'MFRGGZDF' | base32 -d", "abcde", "", 0],
  ["echo 'MFRGGZ' | base32 -d", "", "base32: invalid input\n", 1],
  ["echo 'M' | base32 -d", "", "base32: invalid input\n", 1],
  ["base64 -w 0 b8", "YWJjZGVmZ2g=", "", 0],
  ["base64 -i a", "aGVsbG8K\n", "", 0],
  ["echo 'YQ==' | base64 -d -w 3", "a", "", 0],
  ["strings bin", "there\n and more text\nlonger string here\n", "", 0],
  ["strings -n 8 bin", " and more text\nlonger string here\n", "", 0],
  ["strings -n 2 bin", "hi\nthere\n and more text\nlonger string here\n", "", 0],
  ["strings -3 bin", "there\n and more text\nlonger string here\n", "", 0],
  ["strings -t x bin", "      3 there\n      a  and more text\n     1d longer string here\n", "", 0],
  ["strings -t d bin", "      3 there\n     10  and more text\n     29 longer string here\n", "", 0],
  ["strings -o bin", "      3 there\n     12  and more text\n     35 longer string here\n", "", 0],
  ["strings -f bin", "bin: there\nbin:  and more text\nbin: longer string here\n", "", 0],
  ["strings a bin", "hello\nthere\n and more text\nlonger string here\n", "", 0],
  ["strings nonex", "", "strings: 'nonex': No such file\n", 1],
  ["strings -n 0 bin", "", "strings: minimum string length is too small: 0\n", 1],
  ["strings -n x bin", "", "strings: invalid integer argument x\n", 1],
  ["strings -t z bin", "", "Usage: strings [option(s)] [file(s)]\n Display printable strings in [file(s)] (stdin by default)\n The options are:\n  -a - --all                Scan the entire file, not just the data section [default]\n  -d --data                 Only scan the data sections in the file\n  -f --print-file-name      Print the name of the file before each string\n  -n <number>               Locate & print any sequence of at least <number>\n    --bytes=<number>         displayable characters.  (The default is 4).\n  -t --radix={o,d,x}        Print the location of the string in base 8, 10 or 16\n  -w --include-all-whitespace Include all whitespace as valid string characters\n  -o                        An alias for --radix=o\n  -T --target=<BFDNAME>     Specify the binary file format\n  -e --encoding={s,S,b,l,B,L} Select character size and endianness:\n                            s = 7-bit, S = 8-bit, {b,l} = 16-bit, {B,L} = 32-bit\n  --unicode={default|show|invalid|hex|escape|highlight}\n  -U {d|s|i|x|e|h}          Specify how to treat UTF-8 encoded unicode characters\n  -s --output-separator=<string> String used to separate strings in output.\n  @<file>                   Read options from <file>\n  -h --help                 Display this information\n  -v -V --version           Print the program's version number\nstrings: supported targets: elf64-x86-64 elf32-i386 elf32-iamcu elf32-x86-64 pei-i386 pe-x86-64 pei-x86-64 elf64-little elf64-big elf32-little elf32-big pe-bigobj-x86-64 pe-i386 pdb srec symbolsrec verilog tekhex binary ihex plugin\n", 1],
  ["strings < bin", "there\n and more text\nlonger string here\n", "", 0],
  ["strings -s, bin", "there, and more text,longer string here,", "", 0],
  ["strings -w bin", "there\n and more text\n\nlonger string here\n\n", "", 0],
  ["strings --bytes=6 bin", " and more text\nlonger string here\n", "", 0],
  ["strings -z bin", "", "strings: invalid option -- 'z'\nUsage: strings [option(s)] [file(s)]\n Display printable strings in [file(s)] (stdin by default)\n The options are:\n  -a - --all                Scan the entire file, not just the data section [default]\n  -d --data                 Only scan the data sections in the file\n  -f --print-file-name      Print the name of the file before each string\n  -n <number>               Locate & print any sequence of at least <number>\n    --bytes=<number>         displayable characters.  (The default is 4).\n  -t --radix={o,d,x}        Print the location of the string in base 8, 10 or 16\n  -w --include-all-whitespace Include all whitespace as valid string characters\n  -o                        An alias for --radix=o\n  -T --target=<BFDNAME>     Specify the binary file format\n  -e --encoding={s,S,b,l,B,L} Select character size and endianness:\n                            s = 7-bit, S = 8-bit, {b,l} = 16-bit, {B,L} = 32-bit\n  --unicode={default|show|invalid|hex|escape|highlight}\n  -U {d|s|i|x|e|h}          Specify how to treat UTF-8 encoded unicode characters\n  -s --output-separator=<string> String used to separate strings in output.\n  @<file>                   Read options from <file>\n  -h --help                 Display this information\n  -v -V --version           Print the program's version number\nstrings: supported targets: elf64-x86-64 elf32-i386 elf32-iamcu elf32-x86-64 pei-i386 pe-x86-64 pei-x86-64 elf64-little elf64-big elf32-little elf32-big pe-bigobj-x86-64 pe-i386 pdb srec symbolsrec verilog tekhex binary ihex plugin\n", 1],
]);


test('digests equal the platform implementation for awkward lengths', async () => {
  const { createHash } = await import('node:crypto');
  const samples = ['', 'a', 'héllo wörld €😀', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(111), 'x'.repeat(112), 'x'.repeat(128), 'The quick brown fox\n'.repeat(100)];
  for (const algo of ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512']) {
    for (const text of samples) assert.equal(sim.K.digest(algo, text), createHash(algo).update(text, 'utf8').digest('hex'), algo + ' ' + text.length);
  }
});

test('md5sum in a pipeline and known digests', async () => {
  assert.equal(await out("printf abc | md5sum"), '900150983cd24fb0d6963f7d28e17f72  -\n');
  assert.equal(await out("printf abc | sha256sum"), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n');
  assert.equal(await out("printf abc | sha1sum --tag"), 'SHA1 (-) = a9993e364706816aba3e25717850c26c9cd0d89d\n');
});

test('xxd dumps and reverses', async () => {
  // the ASCII column starts one blank after the hex area, which is padded to full width
  const row = (offset, hex, ascii, width) => (offset + ': ' + hex).padEnd(width) + ascii + '\n';
  assert.equal(await out("printf 'Hello, World! Kali' | xxd"),
    row('00000000', '4865 6c6c 6f2c 2057 6f72 6c64 2120 4b61', 'Hello, World! Ka', 51) + row('00000010', '6c69', 'li', 51));
  assert.equal(await out("printf 'Hello' | xxd -p"), '48656c6c6f\n');
  assert.equal(await out("printf 'Hello' | xxd -u -g1"), row('00000000', '48 65 6C 6C 6F', 'Hello', 59));
  assert.equal(await out("printf 'Hello, World' | xxd -s 7 -l 3"), row('00000007', '576f 72', 'Wor', 51));
  assert.equal(await out("printf 'abcdef' | xxd -c 4"), row('00000000', '6162 6364', 'abcd', 21) + row('00000004', '6566', 'ef', 21));
  assert.equal(await out("printf 'Hi' | xxd -b"), row('00000000', '01001000 01101001', 'Hi', 65));
  assert.equal(await out("printf 'Hi\\n' | xxd -i"), '  0x48, 0x69, 0x0a\n');
  assert.equal(await out("echo 6b616c69 | xxd -r -p"), 'kali');
  assert.equal(await out("printf 'Hello, World! Kali' | xxd | xxd -r"), 'Hello, World! Kali');
  assert.equal((await run('xxd /nonexistent')).err, 'xxd: /nonexistent: No such file or directory\n');
});
