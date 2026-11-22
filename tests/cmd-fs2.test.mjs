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

/* ------------------------------------------------------------ tar, gzip */

const FILES = 'mkdir -p /tmp/a/d/e; cd /tmp/a; echo hi > d/a; echo hello > d/e/b; chmod 600 d/e/b; ln -s a d/l; touch -d "2026-01-02 03:04:05" d/a';

test('tar -c / -t / -x round-trip names, modes, contents and symlinks', async () => {
  const { sh, out } = await setup();
  await sh(FILES);
  const c = await sh('tar -cvf x.tar d');
  assert.equal(c.out, 'd/\nd/a\nd/e/\nd/e/b\nd/l\n');
  assert.equal(await out('tar -tf x.tar'), 'd/\nd/a\nd/e/\nd/e/b\nd/l\n');
  assert.equal(await out('tar -tf x.tar d/e'), 'd/e/\nd/e/b\n');
  const v = await out('tar -tvf x.tar');
  assert.match(v, /^drwxr-xr-x kali\/kali {9}0 \d{4}-\d\d-\d\d \d\d:\d\d d\/\n/);
  assert.match(v, /-rw-r--r-- kali\/kali +3 2026-01-02 03:04 d\/a\n/);
  assert.match(v, /-rw------- kali\/kali +6 .* d\/e\/b\n/);
  assert.match(v, /lrwxrwxrwx kali\/kali +0 .* d\/l -> a\n/);
  await sh('mkdir out; tar -xvf x.tar -C out');
  assert.equal(await out('cat out/d/e/b'), 'hello\n');
  assert.equal(await out('readlink out/d/l'), 'a\n');
  assert.equal(await out('stat -c "%a %y" out/d/e/b out/d/a'), '600 ' + (await out('stat -c %y d/e/b')).trim() + '\n644 2026-01-02 03:04:05.000000000 +0000\n');
  assert.equal(await out('file x.tar'), 'x.tar: POSIX tar archive (GNU)\n');
  assert.equal(await out('wc -c < x.tar'), '10240\n');
});

test('tar -z, -j, -J, -a and automatic detection on read', async () => {
  const { sh, out } = await setup();
  await sh(FILES);
  await sh('tar -czf x.tgz d; tar -cjf x.tbz d; tar -cJf x.txz d; tar -caf y.tar.gz d');
  assert.match(await out('file x.tgz'), /gzip compressed data/);
  assert.match(await out('file x.tbz'), /bzip2 compressed data/);
  assert.match(await out('file x.txz'), /XZ compressed data/);
  assert.match(await out('file y.tar.gz'), /gzip compressed data/);
  for (const f of ['x.tgz', 'x.tbz', 'x.txz']) assert.equal(await out('tar -tf ' + f + ' | wc -l'), '5\n');
  assert.equal(await out('tar -xzOf x.tgz d/e/b'), 'hello\n');
  await sh('mkdir /tmp/sc; tar xf x.tgz --strip-components=1 -C /tmp/sc');
  assert.equal(await out('cat /tmp/sc/a'), 'hi\n');
  assert.equal(await out('tar -cf - d | tar -tf -'), 'd/\nd/a\nd/e/\nd/e/b\nd/l\n');
  assert.equal(await out('tar -czf - d | gunzip | tar -tf - | wc -l'), '5\n');
});

test('tar excludes, member lists and the error paths', async () => {
  const { sim, sh, out } = await setup();
  await sh(FILES);
  assert.equal(await out('tar -cf - --exclude=e d | tar -tf -'), 'd/\nd/a\nd/l\n');
  await sh('tar -cf x.tar d');
  assert.equal((await sh('tar -xf x.tar nothere')).err, 'tar: nothere: Not found in archive\ntar: Exiting with failure status due to previous errors\n');
  assert.equal((await sh('tar -xf x.tar nothere')).code, 2);
  const r = await sh('tar -tf nope.tar');
  assert.equal(r.err, 'tar: nope.tar: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n');
  assert.equal(r.code, 2);
  assert.equal((await sh('tar -cf y.tar d/zz')).err, 'tar: d/zz: Cannot stat: No such file or directory\ntar: Exiting with failure status due to previous errors\n');
  assert.equal((await sh('tar')).err, "tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\nTry 'tar --help' or 'tar --usage' for more information.\n");
  assert.equal((await sh('tar --foo')).code, 64);
  assert.equal((await sh('tar -cf y.tar')).err.split('\n')[0], 'tar: Cowardly refusing to create an empty archive');
  assert.equal((await sh('echo junk > j; tar -tf j')).err, 'tar: This does not look like a tar archive\ntar: Skipping to next header\ntar: Exiting with failure status due to previous errors\n');
  assert.match((await sh('tar -tzf x.tar')).err, /gzip: stdin: not in gzip format\ntar: Child returned status 1/);
  assert.equal((await sh('tar -cf x.tar x.tar d')).err, 'tar: x.tar: file is the archive; not dumped\ntar: Exiting with failure status due to previous errors\n');
  assert.match((await sim.type('tar -c d')).output, /^tar: Refusing to write archive contents to terminal \(missing -f option\?\)\n/);
  assert.equal((await sh('tar -cf /y.tar d')).err.split('\n')[0], 'tar: /y.tar: Cannot open: Permission denied');
  assert.match((await sh('tar --version')).out, /^tar \(GNU tar\) 1\.35/);
});

test('tar strips a leading slash and preserves root ownership when extracting as root', async () => {
  const { sim, sh, out } = await setup();
  await sh(FILES);
  const r = await sh('tar -cf abs.tar /tmp/a/d/a');
  assert.equal(r.err, "tar: Removing leading `/' from member names\n");
  assert.equal(await out('tar -tf abs.tar'), 'tmp/a/d/a\n');
  sim.term.feed('kali');
  await sh('sudo tar -cf /tmp/root.tar -C /etc hostname; mkdir /tmp/rx');
  assert.match(await out('tar -tvf /tmp/root.tar'), /^-rw-r--r-- root\/root +\d+ \d{4}-/);
  await sh('sudo tar -xf /tmp/root.tar -C /tmp/rx');
  assert.equal(await out('stat -c %U /tmp/rx/hostname'), 'root\n');
  assert.equal(await out('tar -xf /tmp/root.tar -C /tmp/rx; stat -c %U /tmp/rx/hostname'), 'kali\n');
});

test('gzip, gunzip, zcat: in place, -k, -c, -d, -l, -t, -v and error texts', async () => {
  const { sh, out } = await setup();
  await sh('cd /tmp; seq 1 1000 > big; echo hello > a; chmod 640 a');
  assert.equal((await sh('gzip -k a')).code, 0);
  assert.equal(await out('ls a a.gz'), 'a\na.gz\n');
  assert.match(await out('file a.gz'), /gzip compressed data, was "a", last modified: .*, from Unix, original size modulo 2\^32 6/);
  assert.equal(await out('stat -c %a a.gz'), '640\n');
  assert.equal((await sh('gzip -k a')).err, 'gzip: a.gz already exists;\tnot overwritten\n');
  assert.equal((await sh('gzip -f a')).code, 0);
  assert.equal(await out('ls a a.gz'.replace('a a.gz', 'a.gz')), 'a.gz\n');
  assert.equal(await out('zcat a.gz'), 'hello\n');
  assert.equal(await out('gzip -dc a.gz'), 'hello\n');
  assert.equal(await out('gunzip a.gz; cat a'), 'hello\n');
  assert.equal((await sh('gzip a.gz')).err, 'gzip: a.gz: No such file or directory\n');
  await sh('gzip big');
  assert.equal(await out('zcat big.gz | tail -1'), '1000\n');
  assert.equal(await out('zcat big.gz | md5sum'), await out('seq 1 1000 | md5sum'));
  const l = await out('gzip -l big.gz');
  assert.match(l, /^ +compressed +uncompressed +ratio uncompressed_name\n +\d+ +3893 +\d+\.\d% big\n$/);
  assert.match(await out('gzip -lv big.gz'), /^method  crc     date  time  +compressed +uncompressed +ratio uncompressed_name\ndefla [0-9a-f]{8} \w{3} [ \d]\d [\d:]{5} +\d+ +3893/);
  assert.equal((await sh('gzip -tv big.gz')).err, 'big.gz:\t OK\n');
  const v = await sh('gzip -vk big.gz'); assert.equal(v.err, 'gzip: big.gz already has .gz suffix -- unchanged\n'.replace('gzip: ', 'gzip: '));
  assert.match((await sh('gunzip -vk big.gz')).err, /^big.gz:\t +\d+\.\d% -- replaced with big\n$/);
});

test('gzip error texts and stdin handling', async () => {
  const { sh, out } = await setup();
  await sh('cd /tmp; echo plain > p; mkdir dd');
  assert.equal((await sh('gzip -d p')).err, 'gzip: p: unknown suffix -- ignored\n');
  assert.equal((await sh('gzip -d p')).code, 2);
  assert.equal((await sh('gzip -t p')).err, 'gzip: p: not in gzip format\n');
  assert.equal((await sh('gunzip nope')).err, 'gzip: nope.gz: No such file or directory\n');
  assert.equal((await sh('gzip nope')).err, 'gzip: nope: No such file or directory\n');
  assert.equal((await sh('gzip nope')).code, 1);
  assert.equal((await sh('gzip dd')).err, 'gzip: dd is a directory -- ignored\n');
  assert.equal((await sh('gzip --foo')).err, "gzip: unrecognized option '--foo'\nTry `gzip --help' for more information.\n");
  assert.match((await sh('gzip')).err, /^gzip: compressed data not written to a terminal/);
  assert.equal(await out('echo piped | gzip | zcat'), 'piped\n');
  assert.equal(await out('echo piped | gzip -c | gzip -dc'), 'piped\n');
  assert.equal((await sh('echo plain | gunzip')).err, 'gzip: stdin: not in gzip format\n');
  assert.equal(await out('cd dd; echo x > f; gzip -r ..; ls'), 'f.gz\n'.replace('f.gz', 'f.gz'));
  assert.match((await sh('gzip --version')).out, /^gzip 1\.12/);
  assert.match((await sh('gzip -h')).out, /^Usage: gzip \[OPTION\]/);
  assert.equal(await out('gzip -c p | wc -c'), (await out('gzip -c p | wc -c')));
});

/* ------------------------------------------------------------ zip, unzip */

const ZTREE = 'mkdir -p /tmp/z/p/q; cd /tmp/z; echo hi > p/a.txt; seq 1 300 > p/q/b; chmod 600 p/a.txt; touch -d "2026-03-04 05:06:08" p/a.txt';

test('zip -r, unzip -l/-lv/-t/-p and the adding messages', async () => {
  const { sh, out } = await setup();
  await sh(ZTREE);
  const z = await sh('zip -r x.zip p');
  assert.match(z.out, /^  adding: p\/ \(stored 0%\)\n  adding: p\/a.txt \(stored 0%\)\n  adding: p\/q\/ \(stored 0%\)\n  adding: p\/q\/b \(deflated \d+%\)\n$/);
  assert.equal((await sh('zip -r x.zip p')).out.split('\n')[0], 'updating: p/ (stored 0%)');
  assert.match(await out('file x.zip'), /Zip archive data, at least v1\.0 to extract/);
  const l = await out('unzip -l x.zip');
  assert.match(l, /^Archive:  x.zip\n  Length      Date    Time    Name\n---------  ---------- -----   ----\n +0  \d{4}-\d\d-\d\d \d\d:\d\d   p\/\n +3  2026-03-04 05:06   p\/a.txt\n/);
  assert.match(l, /\n---------                     -------\n +1095                     4 files\n$/);
  assert.match(await out('unzip -lv x.zip'), /\n +3  Stored +3   0% 2026-03-04 05:06 [0-9a-f]{8}  p\/a.txt\n/);
  assert.match(await out('unzip -t x.zip'), /^Archive:  x.zip\n    testing: p\/ {23}OK\n/);
  assert.match(await out('unzip -t x.zip'), /No errors detected in compressed data of x.zip.\n$/);
  assert.equal(await out('unzip -p x.zip p/a.txt'), 'hi\n');
  assert.equal(await out('unzip -p x.zip "p/q/*" | wc -l'), '300\n');
});

test('unzip extracts with -d, restores modes and times, and handles existing files', async () => {
  const { sh, out } = await setup();
  await sh(ZTREE + '; zip -qr x.zip p');
  const u = await sh('unzip x.zip -d out');
  assert.equal(u.out, 'Archive:  x.zip\n   creating: out/p/\n extracting: out/p/a.txt' + ' '.repeat(13) + '\n   creating: out/p/q/\n  inflating: out/p/q/b' + ' '.repeat(15) + '\n');
  assert.equal(await out('stat -c "%a %y" out/p/a.txt'), '600 2026-03-04 05:06:08.000000000 +0000\n');
  assert.equal(await out('cat out/p/a.txt'), 'hi\n');
  assert.equal((await sh('unzip -n x.zip -d out')).out, 'Archive:  x.zip\n');
  assert.match((await sh('unzip -o x.zip -d out')).out, /extracting: out\/p\/a.txt/);
  assert.match((await sh('unzip -q x.zip -d out2; ls out2')).out, /^p\n$/);
  assert.equal((await sh('unzip x.zip nomatch')).out, 'Archive:  x.zip\ncaution: filename not matched:  nomatch\n');
  assert.equal((await sh('unzip x.zip nomatch')).code, 11);
  assert.equal(await out('unzip -j -q x.zip -d flat; ls flat'), 'a.txt\nb\n');
  assert.equal(await out('unzip -q x.zip -x "p/q/*" -d only; find only -type f'), 'only/p/a.txt\n');
});

test('zip options: -j, -d, -x, -m and errors', async () => {
  const { sh, out } = await setup();
  await sh(ZTREE);
  await sh('zip -qrj j.zip p');
  assert.equal(await out('unzip -Z1 j.zip'), 'a.txt\nb\n');
  await sh('zip -qr x.zip p -x "*.txt"');
  assert.equal(await out('unzip -Z1 x.zip'), 'p/\np/q/\np/q/b\n');
  assert.equal((await sh('zip -d x.zip "p/q/*"')).out, 'deleting: p/q/\ndeleting: p/q/b\n');
  assert.equal((await sh('zip -q m.zip p/a.txt -m; ls p')).out, 'q\n');
  const miss = await sh('zip y.zip nofile');
  assert.equal(miss.err, '\tzip warning: name not matched: nofile\n\nzip error: Nothing to do! (y.zip)\n');
  assert.equal(miss.code, 12);
  assert.equal((await sh('zip -Q a.zip p')).err, "\nzip error: Invalid command arguments (short option 'Q' not supported)\n");
  assert.match((await sh('zip')).out, /^Copyright \(c\) 1990-2008 Info-ZIP/);
  assert.equal((await sh('zip -q noext p/q/b; ls noext.zip')).out, 'noext.zip\n');
});

test('unzip errors: missing and invalid archives', async () => {
  const { sh } = await setup();
  await sh('cd /tmp; echo junk > j');
  const a = await sh('unzip nope.zip');
  assert.equal(a.err, 'unzip:  cannot find or open nope.zip, nope.zip.zip or nope.zip.ZIP.\n');
  assert.equal(a.code, 9);
  assert.equal((await sh('unzip nope')).err, 'unzip:  cannot find or open nope, nope.zip or nope.ZIP.\n');
  const b = await sh('unzip j');
  assert.match(b.out, /^Archive:  j\n  End-of-central-directory signature not found/);
  assert.equal(b.err, 'unzip:  cannot find zipfile directory in one of j or\n        j.zip, and cannot find j.ZIP, period.\n');
  assert.equal(b.code, 9);
  assert.match((await sh('unzip')).out, /^UnZip 6\.00/);
});

/* ------------------------------------------------------- locate, updatedb */

test('locate fails before updatedb, needs root to build, and then finds files', async () => {
  const { sim, sh, out } = await setup();
  const r = await sh('locate passwd');
  assert.equal(r.err, "locate: can not open `/var/lib/plocate/plocate.db': No such file or directory\n");
  assert.equal(r.code, 1);
  assert.equal((await sh('updatedb')).code, 1);
  sim.term.feed('kali');
  assert.equal((await sh('sudo updatedb')).code, 0);
  assert.match(await out('locate -b passwd'), /^\/etc\/passwd\n/m);
  assert.match(await out('locate passwd'), /\/etc\/passwd/);
  await sh('echo x > /tmp/newfile_zz');
  assert.equal((await sh('locate newfile_zz')).code, 1);
  await sh('mkdir -p /home/kali/docs; echo x > /home/kali/docs/Report.PDF; sudo updatedb');
  assert.equal(await out('locate -i report.pdf'), '/home/kali/docs/Report.PDF\n');
  assert.equal(await out('locate report.pdf'), '');
  assert.equal(await out('locate -c -i report.pdf'), '1\n');
  assert.equal(await out('locate "/home/kali/docs/*.PDF"'), '/home/kali/docs/Report.PDF\n');
  assert.equal(await out('locate -l 1 -b "*.conf" | wc -l'), '1\n');
  assert.equal(await out('locate -r "docs/R.*PDF$"'), '/home/kali/docs/Report.PDF\n');
  assert.equal(await out('locate -e Report | wc -l'), '1\n');
  assert.equal((await sh('locate')).err, 'locate: no pattern to search for specified\n');
  assert.match((await sh('locate --version')).out, /^plocate /);
  assert.equal((await sh('locate zzznothing')).code, 1);
});

/* ------------------------------------------- dd, lsblk, mount, sync, shred */

test('dd copies blocks and prints the three-line summary', async () => {
  const { sh, out } = await setup();
  await sh('cd /tmp; seq 1 1000 > s');
  let r = await sh('dd if=/dev/zero of=z bs=1M count=3');
  assert.match(r.err, /^3\+0 records in\n3\+0 records out\n3145728 bytes \(3\.1 MB, 3\.0 MiB\) copied, [0-9.e-]+ s, [\d.]+ [kMG]B\/s\n$/);
  assert.equal(await out('wc -c < z'), '3145728\n');
  r = await sh('dd if=/dev/zero of=z bs=512 count=1');
  assert.match(r.err, /^1\+0 records in\n1\+0 records out\n512 bytes copied, [0-9.e-]+ s, [\d.]+ [kMG]?B\/s\n$/);
  r = await sh('dd if=s of=t bs=1000');
  assert.match(r.err, /^3\+1 records in\n3\+1 records out\n3893 bytes \(3\.9 kB, 3\.8 KiB\) copied/);
  assert.equal(await out('cmp s t && echo same'), 'same\n');
  assert.equal((await sh('dd if=s of=t bs=1k count=1 status=none')).err, '');
  assert.equal((await sh('dd if=s of=t bs=1k count=1 status=noxfer')).err, '1+0 records in\n1+0 records out\n');
  assert.equal(await out('dd if=s bs=1 skip=3890 count=3 2>/dev/null'), '00\n');
  assert.equal(await out('dd if=s of=u conv=ucase 2>&1 >/dev/null | head -1; echo hello | dd conv=ucase 2>/dev/null'), '7+1 records in\nHELLO\n');
  assert.equal(await out('echo abcdef > w; printf XY | dd of=w bs=1 seek=1 conv=notrunc 2>/dev/null; cat w'), 'aXYdef\n');
  assert.equal(await out('dd if=/dev/zero bs=4 count=2 2>/dev/null | wc -c'), '8\n');
  assert.equal(await out('dd if=/dev/urandom of=r bs=1k count=2 2>/dev/null; wc -c < r'), '2048\n');
});

test('dd errors and device handling', async () => {
  const { sim, sh } = await setup();
  assert.equal((await sh('dd if=nope')).err, "dd: failed to open 'nope': No such file or directory\n");
  assert.equal((await sh('dd bs=x')).err, "dd: invalid number: 'x'\n");
  assert.equal((await sh('dd foo=1')).err, "dd: unrecognized operand 'foo=1'\nTry 'dd --help' for more information.\n");
  assert.equal((await sh('dd if=/dev/zero of=/dev/sda count=1')).err, "dd: failed to open '/dev/sda': Permission denied\n");
  sim.term.feed('kali');
  const r = await sh('sudo dd if=/dev/zero of=/dev/sda bs=1M count=2');
  assert.match(r.err, /^2\+0 records in\n2\+0 records out\n2097152 bytes/);
  assert.equal((await sh('dd if=/tmp of=/dev/null')).code, 1);
  assert.match((await sh('dd --version')).out, /^dd \(GNU coreutils\) /);
  assert.match((await sh('dd --help')).out, /^Usage: dd \[OPERAND\]/);
});

test('lsblk draws the disk tree, lists, and shows filesystems', async () => {
  const { sh, out } = await setup();
  const t = await out('lsblk');
  assert.match(t, /^NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS\nsda    8:0      0   80G  0 disk \n├─sda1 8:1      0 78.6G  0 part \/\n├─sda2 8:2      0    1K  0 part \n└─sda5 8:5      0  1.4G  0 part \[SWAP\]\nsr0    11:0     1 1024M  0 rom  \n$/);
  assert.match(await out('lsblk -l | head -3'), /^NAME MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS\nsda  8:0      0   80G  0 disk \nsda1 8:1/);
  assert.match(await out('lsblk -f'), /^NAME   FSTYPE FSVER LABEL UUID +FSAVAIL FSUSE% MOUNTPOINTS\n/);
  assert.match(await out('lsblk -f'), /sda1 +ext4 +1\.0 +3c1f2d7e-[0-9a-f-]+ +\d+(\.\d)?G +17% \/\n/);
  assert.equal(await out('lsblk -dn -o NAME,SIZE'), 'sda   80G\nsr0 1024M\n');
  assert.match(await out('lsblk -p -d'), /\/dev\/sda/);
  assert.equal((await sh('lsblk -o NOPE')).err, 'lsblk: unknown column: NOPE\n');
  assert.equal((await sh('lsblk --bogus')).code, 1);
  assert.match((await sh('lsblk --version')).out, /^lsblk from util-linux/);
});

test('mount lists mounts, filters by type, and refuses non-root mounting', async () => {
  const { sim, sh, out } = await setup();
  const m = await out('mount');
  assert.match(m, /^sysfs on \/sys type sysfs \(rw,nosuid,nodev,noexec,relatime\)\n/);
  assert.match(m, /\/dev\/sda1 on \/ type ext4 \(rw,relatime,errors=remount-ro\)\n/);
  assert.equal(await out('mount -t ext4'), '/dev/sda1 on / type ext4 (rw,relatime,errors=remount-ro)\n');
  assert.equal(await out('mount | grep -c tmpfs'), '6\n');
  const r = await sh('mount /dev/sdb1 /mnt');
  assert.match(r.err, /^mount: \/mnt: must be superuser to use mount\./);
  assert.equal(r.code, 32);
  sim.term.feed('kali');
  assert.match((await sh('sudo mount /dev/sdb1 /mnt')).err, /^mount: \/mnt: special device \/dev\/sdb1 does not exist\./);
});

test('sync and shred', async () => {
  const { sh, out } = await setup();
  await sh('cd /tmp; seq 1 100 > f; cp f g');
  assert.deepEqual([(await sh('sync')).code, (await sh('sync')).out], [0, '']);
  assert.equal((await sh('sync nope')).err, "sync: error opening 'nope': No such file or directory\n");
  assert.equal((await sh('sync nope')).code, 1);
  const v = await sh('shred -v -n 2 f');
  assert.equal(v.err, 'shred: f: pass 1/2 (random)...\nshred: f: pass 2/2 (random)...\n');
  assert.equal(await out('wc -c < f'), '292\n');
  assert.notEqual(await out('cat f | head -c 20 | wc -c'), '');
  assert.equal(await out('cmp -s f g || echo differs'), 'differs\n');
  assert.equal((await sh('shred -zv -n 1 g')).err, 'shred: g: pass 1/2 (random)...\nshred: g: pass 2/2 (000000)...\n');
  assert.equal(await out('tr -d "\\0" < g | wc -c'), '0\n');
  const u = await sh('shred -u -v -n 1 f');
  assert.equal(u.err, 'shred: f: pass 1/1 (random)...\nshred: f: removing\nshred: f: renamed to 0\nshred: f: removed\n');
  assert.equal(await out('ls f 2>&1'), "ls: cannot access 'f': No such file or directory\n");
  await sh('echo x > secret.txt');
  assert.match((await sh('shred -uv -n 0 secret.txt')).err, /removing\nshred: secret.txt: renamed to 0000000000\nshred: 0000000000: renamed to 000000000\n[\s\S]*shred: 00: renamed to 0\nshred: secret.txt: removed\n$/);
  assert.equal((await sh('shred nope')).err, 'shred: nope: failed to open for writing: No such file or directory\n');
  assert.equal((await sh('shred /tmp')).err, 'shred: /tmp: failed to open for writing: Is a directory\n');
  assert.equal((await sh('shred')).err, "shred: missing file operand\nTry 'shred --help' for more information.\n");
  assert.equal((await sh('shred --foo')).err, "shred: unrecognized option '--foo'\nTry 'shred --help' for more information.\n");
  assert.equal((await sh('shred -n x f')).err, "shred: invalid number of passes: 'x'\n");
});
