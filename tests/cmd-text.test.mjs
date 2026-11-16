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
  assert.equal(await out('grep -ob o a.txt'), '1:o\n2:o\n8:o\n16:o\n');
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
