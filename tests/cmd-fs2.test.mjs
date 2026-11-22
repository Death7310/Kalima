// Tests for the search and archive commands (src/js/40-cmd-fs2.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

async function setup() {
  const sim = await boot();
  const sh = (line, o) => sim.run(line, o);
  const out = async (line) => (await sim.run(line)).out;
  return { sim, sh, out };
}

const TREE = 'mkdir -p /tmp/w/src/lib /tmp/w/docs /tmp/w/empty; cd /tmp/w; echo a > src/a.c; echo bb > src/lib/b.h; printf "%2000s" x > docs/Big.TXT; echo n > notes.txt; touch .hidden';

/* ---------------------------------------------------------------- find */

const lines = (s) => s.split('\n').filter(Boolean).sort();

test('find lists the tree, defaults to ., and filters by name', async () => {
  const { sh, out } = await setup();
  await sh(TREE);
  assert.deepEqual(lines(await out('find')), ['.', './.hidden', './docs', './docs/Big.TXT', './empty', './notes.txt', './src', './src/a.c', './src/lib', './src/lib/b.h']);
  assert.equal(await out('find src -name "*.h"'), 'src/lib/b.h\n');
  assert.equal(await out('find . -iname "big.txt"'), './docs/Big.TXT\n');
  assert.equal(await out('find . -name "big.txt"'), '');
  assert.equal(await out('find /tmp/w/src/ -name a.c'), '/tmp/w/src/a.c\n');
  assert.equal(await out('find . -path "./src/*" -name "*.c"'), './src/a.c\n');
});

test('find -type, -empty, -size, -maxdepth, -mindepth', async () => {
  const { sh, out } = await setup();
  await sh(TREE);
  assert.deepEqual(lines(await out('find . -type d')), ['.', './docs', './empty', './src', './src/lib']);
  assert.deepEqual(lines(await out('find . -type f -name "*.*" -not -name ".*"')), ['./docs/Big.TXT', './notes.txt', './src/a.c', './src/lib/b.h']);
  assert.deepEqual(lines(await out('find . -empty')), ['./.hidden', './empty']);
  assert.equal(await out('find . -type f -size +1k'), './docs/Big.TXT\n');
  assert.equal(await out('find . -size -2c -type f'), './.hidden\n');
  assert.equal(await out('find . -size 3c'), './src/lib/b.h\n');
  assert.deepEqual(lines(await out('find . -maxdepth 1 -type d')), ['.', './docs', './empty', './src']);
  assert.deepEqual(lines(await out('find . -mindepth 2 -maxdepth 2')), ['./docs/Big.TXT', './src/a.c', './src/lib']);
});

test('find operators: -o, parentheses, ! and implicit and', async () => {
  const { sh, out } = await setup();
  await sh(TREE);
  assert.deepEqual(lines(await out('find . -name "*.c" -o -name "*.h"')), ['./src/a.c', './src/lib/b.h']);
  assert.deepEqual(lines(await out('find . -type f \\( -name "*.c" -o -name "*.txt" \\)')), ['./notes.txt', './src/a.c']);
  assert.deepEqual(lines(await out('find . -type f ! -name "*.c" -a ! -name ".*"')), ['./docs/Big.TXT', './notes.txt', './src/lib/b.h']);
  assert.equal(await out('find . -type f -name a.c -print -print'), './src/a.c\n./src/a.c\n');
  assert.equal(await out('find . -name notes.txt -o -name nothing -print'), '');
});

test('find -mtime, -mmin, -newer, -user, -group, -perm', async () => {
  const { sh, out } = await setup();
  await sh(TREE);
  await sh('touch -d "10 days ago" old; touch -d "30 minutes ago" recent; chmod 600 old; chmod 755 recent');
  assert.equal(await out('find . -type f -mtime +5'), './old\n');
  assert.equal(await out('find . -type f -mmin -60 -name recent'), './recent\n');
  assert.equal(await out('find . -type f -mmin +60 -name "?ld"'), './old\n');
  assert.equal(await out('find . -newer old -name recent'), './recent\n');
  assert.equal(await out('find . -maxdepth 1 -user kali -name old'), './old\n');
  assert.equal(await out('find . -maxdepth 1 -group kali -name old'), './old\n');
  assert.equal(await out('find . -maxdepth 1 -user root'), '');
  assert.equal(await out('find . -perm 600'), './old\n');
  assert.equal(await out('find . -type f -perm -111'), './recent\n');
  assert.equal(await out('find . -type f -perm /u+x'), './recent\n');
  assert.equal(await out('find . -type f -perm u=rw'), './old\n');
});

test('find -print0, -ls, -printf', async () => {
  const { sh, out } = await setup();
  await sh(TREE);
  assert.equal(await out('find src -type f -print0'), 'src/a.c\0src/lib/b.h\0');
  const ls = await out('find notes.txt -ls');
  assert.match(ls, /^ +\d+ +4 -rw-r--r-- +1 kali +kali +2 \w{3} [ \d]\d [\d:]{5} notes.txt\n$/);
  assert.equal(await out('find src -type f -printf "%f %s %m %u %y %d\\n"'), 'a.c 2 644 kali f 1\nb.h 3 644 kali f 2\n');
  assert.equal(await out('find src -name lib -printf "%h|%P|%p\\n"'), 'src|lib|src/lib\n');
});

test('find -exec with ; and + runs the command through the shell', async () => {
  const { sh, out } = await setup();
  await sh(TREE);
  assert.equal(await out('find src -name "*.c" -exec cat {} \\;'), 'a\n');
  assert.equal(await out('find src -type f -exec echo got {} \\;'), 'got src/a.c\ngot src/lib/b.h\n');
  assert.equal(await out('find src -type f -exec echo got {} +'), 'got src/a.c src/lib/b.h\n');
  assert.equal(await out('find src -name a.c -exec echo {}.bak \\;'), 'src/a.c.bak\n');
  assert.equal((await sh('find . -name "*.c" -exec false {} \\; -print')).out, '');
  assert.equal((await sh('find src -type f -exec grep -l bb {} +')).out, 'src/lib/b.h\n');
  assert.equal((await sh('find src -name a.c -exec')).err, "find: missing argument to `-exec'\n");
});

test('find -delete removes files and empty directories depth first', async () => {
  const { sh, out } = await setup();
  await sh(TREE);
  await sh('find src -delete');
  assert.equal(await out('ls'), 'docs\nempty\nnotes.txt\n');
  const r = await sh('mkdir -p d/e; touch d/e/f; find d -type d -name e -delete');
  assert.equal(r.err, "find: cannot delete 'd/e': Directory not empty\n");
  assert.equal(r.code, 1);
});

test('find -prune and -quit', async () => {
  const { sh, out } = await setup();
  await sh(TREE);
  assert.deepEqual(lines(await out('find . -name src -prune -o -type f -print')), ['./.hidden', './docs/Big.TXT', './notes.txt']);
  assert.equal(await out('find . -type f -print -quit').then((s) => s.split('\n').length), 2);
});

test('find reports unreadable directories and exits 1', async () => {
  const { sh } = await setup();
  await sh(TREE + '; mkdir locked; touch locked/x; chmod 000 locked');
  const r = await sh('find . -name x');
  assert.equal(r.err, "find: 'locked': Permission denied\n".replace("'locked'", "'./locked'"));
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  const missing = await sh('find /nonexistent');
  assert.equal(missing.err, "find: '/nonexistent': No such file or directory\n");
  assert.equal(missing.code, 1);
});

test('find usage errors match GNU find', async () => {
  const { sh } = await setup();
  await sh(TREE);
  const e = async (l) => { const r = await sh(l); assert.equal(r.code, 1, l); return r.err; };
  assert.equal(await e('find . -foo'), "find: unknown predicate `-foo'\n");
  assert.equal(await e('find . -name'), "find: missing argument to `-name'\n");
  assert.equal(await e('find . -type z'), 'find: Unknown argument to -type: z\n');
  assert.equal(await e('find . -size +x'), "find: invalid -size type `x'\n");
  assert.equal(await e('find . -mtime x'), "find: invalid argument `x' to `-mtime'\n");
  assert.equal(await e('find . -maxdepth x'), "find: Expected a positive decimal integer argument to -maxdepth, but got 'x'\n");
  assert.equal(await e('find . -user nosuch'), "find: 'nosuch' is not the name of a known user\n");
  assert.equal(await e('find . -newer nope'), "find: 'nope': No such file or directory\n");
  assert.equal(await e('find . -name a /tmp'), "find: paths must precede expression: `/tmp'\nfind: possible unquoted pattern after predicate `-name'?\n");
  assert.equal(await e('find . \\( -name a'), "find: invalid expression; I was expecting to find a ')' somewhere but did not see one.\n");
  assert.equal(await e('find . -a'), "find: invalid expression; you have used a binary operator '-a' with nothing before it.\n");
  assert.equal(await e('find . !'), "find: expected an expression after '!'\n");
  assert.match((await sh('find --version')).out, /^find \(GNU findutils\)/);
  assert.match((await sh('find --help')).out, /^Usage: find /);
});

test('find output feeds pipelines and xargs', async () => {
  const { sh, out } = await setup();
  await sh(TREE);
  assert.equal(await out('find src -type f | wc -l'), '2\n');
  assert.equal(await out('find src -type f -print0 | xargs -0 cat'), 'a\nbb\n');
});
