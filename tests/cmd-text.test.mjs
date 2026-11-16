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
    const dir = '/tmp/tbl' + (tableDir++);
    sim.machine.vfs.seedDir(dir);
    sim.machine.vfs.chmod(dir, 0o777);
    await run('cd ' + dir + '; LC_ALL=' + locale + '; export LC_ALL');
    for (const m of setup.matchAll(/mkdir (\w+)/g)) sim.machine.vfs.seedDir(dir + '/' + m[1]);   // mkdir belongs to another pack
    await run(setup.replace(/mkdir \w+;?/g, ''));
    for (const [line, stdout, stderr, status] of rows) {
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
