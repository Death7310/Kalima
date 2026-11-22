// Tests for the stream editors (40-cmd-text2.js). The tables hold output printed by
// the real GNU sed 4.9 and mawk 1.3.4 for the same command lines, run in a fresh
// directory with these files:
//   n5     one two three four five (one per line)      ab    "a b c" and "d e f"
//   col    x:1:foo y:22:bar z:333:baz                  nonl  "no newline" without a final newline
//   fruit  "5 apples" "12 pears" "7 figs"
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

const SETUP = "printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > n5; printf 'a b c\\nd e f\\n' > ab; printf 'x:1:foo\\ny:22:bar\\nz:333:baz\\n' > col; printf 'no newline' > nonl; printf '5 apples\\n12 pears\\n7 figs\\n' > fruit";

let sim; let dirCount = 0;
before(async () => { sim = await boot(); });
const run = (line, o) => sim.run(line, o);
const out = async (line, o) => (await run(line, o)).out;

/** Run each row [command line, stdout, stderr, status] in a fresh directory holding the sample files. */
function table(name, rows) {
  test(name, async () => {
    for (const [line, stdout, stderr, status] of rows) {
      const dir = '/tmp/tbl' + (dirCount++);
      sim.machine.vfs.seedDir(dir);
      sim.machine.vfs.chmod(dir, 0o777);
      await run('cd ' + dir + '; ' + SETUP);
      const r = await run(line);
      assert.deepEqual([r.out, r.err, r.code], [stdout, stderr, status], line);
    }
  });
}

const SED = [
// BEGIN SED
  ["sed 's/o/0/' n5", "0ne\ntw0\nthree\nf0ur\nfive\n", "", 0],
  ["sed -n '2,4p' n5", "two\nthree\nfour\n", "", 0],
  ["sed 's/a/b' n5", "", "sed: -e expression #1, char 5: unterminated `s' command\n", 1],
  ["sed 's/a/b/x' n5", "", "sed: -e expression #1, char 7: unknown option to `s'\n", 1],
  ["sed k n5", "", "sed: -e expression #1, char 1: unknown command: `k'\n", 1],
  ["sed '1,2,3p' n5", "", "sed: -e expression #1, char 4: unknown command: `,'\n", 1],
  ["sed '{p' n5", "", "sed: -e expression #1, char 0: unmatched `{'\n", 1],
  ["sed 'p}' n5", "", "sed: -e expression #1, char 2: unexpected `}'\n", 1],
  ["sed pp n5", "", "sed: -e expression #1, char 2: extra characters after command\n", 1],
  ["sed a n5", "", "sed: -e expression #1, char 1: expected \\ after `a', `c' or `i'\n", 1],
  ["sed 'y/abc/de/' n5", "", "sed: -e expression #1, char 9: strings for `y' command are different lengths\n", 1],
  ["sed 's/\\(a/b/' n5", "", "sed: -e expression #1, char 8: Unmatched ( or \\(\n", 1],
  ["sed 's/a\\{1/b/' n5", "", "sed: -e expression #1, char 9: Unmatched \\{\n", 1],
  ["sed 's/[a/b/' n5", "", "sed: -e expression #1, char 7: unterminated `s' command\n", 1],
  ["sed 's/a/\\1/' n5", "", "sed: -e expression #1, char 7: invalid reference \\1 on `s' command's RHS\n", 1],
  ["sed 0p n5", "", "sed: -e expression #1, char 2: invalid usage of line address 0\n", 1],
  ["sed '3,1p' n5", "one\ntwo\nthree\nthree\nfour\nfive\n", "", 0],
  ["sed '/x/,/y/d;3q5' n5", "one\ntwo\nthree\n", "", 5],
  ["sed '#n\n2p' n5", "two\n", "", 0],
  ["sed '$!N;P;D' n5", "one\ntwo\nthree\nfour\nfive\n", "", 0],
  ["sed '2,3!d' n5", "two\nthree\n", "", 0],
  ["sed '0~2d' n5", "one\nthree\nfive\n", "", 0],
  ["sed -n '2~2p' n5", "two\nfour\n", "", 0],
  ["sed '2,+1d' n5", "one\nfour\nfive\n", "", 0],
  ["sed '2,~4d' n5", "one\nfive\n", "", 0],
  ["sed '0,/o/d' n5", "two\nthree\nfour\nfive\n", "", 0],
  ["sed '1,/o/d' n5", "three\nfour\nfive\n", "", 0],
  ["sed -n '/two/,/four/{/three/!p}' n5", "two\nfour\n", "", 0],
  ["sed '2a hello' n5", "one\ntwo\nhello\nthree\nfour\nfive\n", "", 0],
  ["sed '2a\\  hello' n5", "one\ntwo\n  hello\nthree\nfour\nfive\n", "", 0],
  ["sed '2a\\\n  hello\\\nworld' n5", "one\ntwo\n  hello\nworld\nthree\nfour\nfive\n", "", 0],
  ["sed -e '2i\\' -e 'foo' n5", "one\nfoo\ntwo\nthree\nfour\nfive\n", "", 0],
  ["sed '2c\\changed' n5", "one\nchanged\nthree\nfour\nfive\n", "", 0],
  ["sed '2,3c\\X' n5", "one\nX\nfour\nfive\n", "", 0],
  ["sed '2,3!c\\X' n5", "X\ntwo\nthree\nX\nX\n", "", 0],
  ["sed 's/o/0/2' n5", "one\ntwo\nthree\nfour\nfive\n", "", 0],
  ["sed 's/o/0/g;s/e/E/2g' n5", "0ne\ntw0\nthreE\nf0ur\nfive\n", "", 0],
  ["sed -n 's/o/0/gp' n5", "0ne\ntw0\nf0ur\n", "", 0],
  ["sed 's/.*/\\U&/' n5", "ONE\nTWO\nTHREE\nFOUR\nFIVE\n", "", 0],
  ["sed 's/\\(.\\)\\(.*\\)/\\u\\1\\U\\2\\E!/' n5", "ONE!\nTWO!\nTHREE!\nFOUR!\nFIVE!\n", "", 0],
  ["sed -E 's/(o|e)+/<&>/' n5", "<o>ne\ntw<o>\nthr<ee>\nf<o>ur\nfiv<e>\n", "", 0],
  ["sed 's/o\\|e/_/g' n5", "_n_\ntw_\nthr__\nf_ur\nfiv_\n", "", 0],
  ["echo 'a+b' | sed 's+a\\+b+X+'", "X\n", "", 0],
  ["echo 'a|b' | sed -E 's|a\\|b|X|'", "X|b\n", "", 0],
  ["echo 'a b' | sed 's/a b/&\\n&/'", "a b\na b\n", "", 0],
  ["echo abc | sed 's/b*/X/g'", "XaXcX\n", "", 0],
  ["echo abc | sed 's/x*/-/g'", "-a-b-c-\n", "", 0],
  ["echo 'hello world' | sed 's/\\w\\+/[&]/g;s/\\bw/W/'", "[hello] [World]\n", "", 0],
  ["echo 'aaa' | sed 's/a/b/3'", "aab\n", "", 0],
  ["echo hi | sed -n 'l'", "hi$\n", "", 0],
  ["printf 'tab\\tx\\\\y\\n' | sed -n l", "tab\\tx\\\\y$\n", "", 0],
  ["printf '%080d\\n' 0 | sed -n l", "000000000000000000000000000000000000000000000000000000000000000000000\\\n00000000000$\n", "", 0],
  ["printf '%080d\\n' 0 | sed -n 'l 20'", "0000000000000000000\\\n0000000000000000000\\\n0000000000000000000\\\n0000000000000000000\\\n0000$\n", "", 0],
  ["printf 'a\\001' | sed -n l", "a\\001$\n", "", 0],
  ["printf 'a\\nb\\n' | sed 'N;N;s/\\n/+/'", "a\nb\n", "", 0],
  ["printf 'a\\nb\\nc\\n' | sed 'N;s/\\n/+/'", "a+b\nc\n", "", 0],
  ["sed -n '$=' n5", "5\n", "", 0],
  ["sed G ab", "a b c\n\nd e f\n\n", "", 0],
  ["sed -n 'H;${x;s/\\n/,/g;p}' n5", ",one,two,three,four,five\n", "", 0],
  ["sed '1!G;h;$!d' n5", "five\nfour\nthree\ntwo\none\n", "", 0],
  ["sed '/one/{n;d}' n5", "one\nthree\nfour\nfive\n", "", 0],
  ["sed 's/\\(a\\) \\(b\\)/\\2 \\1/' ab", "b a c\nd e f\n", "", 0],
  ["sed -s -n '$p' n5 ab", "five\nd e f\n", "", 0],
  ["sed -n '$p' n5 ab", "d e f\n", "", 0],
  ["sed -n '1p' n5 ab", "one\n", "", 0],
  ["sed -sn '1p' n5 ab", "one\na b c\n", "", 0],
  ["sed -n 'F;q' n5", "n5\n", "", 0],
  ["sed -n '2{p;q}' n5", "two\n", "", 0],
  ["sed 2q n5", "one\ntwo\n", "", 0],
  ["sed 2Q n5", "one\n", "", 0],
  ["sed '1d;n;d' n5", "two\nfour\n", "", 0],
  ["sed '/two/r ab' n5", "one\ntwo\na b c\nd e f\nthree\nfour\nfive\n", "", 0],
  ["sed '$r nofile' n5", "one\ntwo\nthree\nfour\nfive\n", "", 0],
  ["sed -n '/t/{=;p}' n5", "2\ntwo\n3\nthree\n", "", 0],
  ["sed ':a;s/o/0/;ta' n5", "0ne\ntw0\nthree\nf0ur\nfive\n", "", 0],
  ["sed 'b end;s/o/0/;:end' n5", "one\ntwo\nthree\nfour\nfive\n", "", 0],
  ["sed 'bnolabel' n5", "", "sed: can't find label for jump to `nolabel'\n", 4],
  ["sed 's/o/0/;T;s/$/!/' n5", "0ne!\ntw0!\nthree\nf0ur!\nfive\n", "", 0],
  ["sed -E 's/^(.)(.)/\\2\\1/' n5", "noe\nwto\nhtree\nofur\nifve\n", "", 0],
  ["echo 'a^b$c' | sed 's/a^b$c/Z/'", "Z\n", "", 0],
  ["echo '*a' | sed 's/*a/Z/'", "Z\n", "", 0],
  ["echo 'a*' | sed 's/\\(*\\)/Z/'", "aZ\n", "", 0],
  ["echo 'a{2}' | sed 's/a{2}/Z/'", "Z\n", "", 0],
  ["echo aa | sed -E 's/a{2}/Z/'", "Z\n", "", 0],
  ["echo aab | sed 's/a\\+b/Z/'", "Z\n", "", 0],
  ["echo 'abab' | sed -E 's/(ab)\\1/Z/'", "Z\n", "", 0],
  ["echo foobar | sed -E 's/foo|foobar/[&]/'", "[foobar]\n", "", 0],
  ["echo '*a' | sed -E 's/*a/Z/'", "", "sed: -e expression #1, char 7: Invalid preceding regular expression\n", 1],
  ["echo 'a{b' | sed -E 's/a{/Z/'", "", "sed: -e expression #1, char 7: Unmatched \\{\n", 1],
  ["echo a | sed 's/a/b/ ;p'", "b\nb\n", "", 0],
  ["echo 'a/b' | sed 's/[/]/X/'", "aXb\n", "", 0],
  ["echo a | sed 'a foo\\tbar'", "a\nfoo\tbar\n", "", 0],
  ["echo a | sed 'a\\'", "a\n", "", 0],
  ["echo a | sed 'a'", "", "sed: -e expression #1, char 1: expected \\ after `a', `c' or `i'\n", 1],
  ["echo a | sed p", "a\na\n", "", 0],
  ["echo a | sed -e p -e k", "", "sed: -e expression #2, char 1: unknown command: `k'\n", 1],
  ["echo a | sed -e p -e 's/a/b'", "", "sed: -e expression #2, char 5: unterminated `s' command\n", 1],
  ["printf 'p\\nk\\n' > sf; echo a | sed -f sf", "", "sed: file sf line 2: unknown command: `k'\n", 1],
  ["echo a | sed 's/a/b/w'", "", "sed: -e expression #1, char 7: missing filename in r/R/w/W commands\n", 1],
  ["echo a | sed r", "", "sed: -e expression #1, char 1: missing filename in r/R/w/W commands\n", 1],
  ["echo a | sed '/a'", "", "sed: -e expression #1, char 2: unterminated address regex\n", 1],
  ["echo a | sed '/a/'", "", "sed: -e expression #1, char 3: missing command\n", 1],
  ["echo a | sed '1,'", "", "sed: -e expression #1, char 2: unexpected `,'\n", 1],
  ["echo a | sed '1!!p'", "", "sed: -e expression #1, char 3: multiple `!'s\n", 1],
  ["echo a | sed '1 ! p'", "a\n", "", 0],
  ["echo a | sed '{;p;}'", "a\na\n", "", 0],
  ["echo a | sed '}'", "", "sed: -e expression #1, char 1: unexpected `}'\n", 1],
  ["echo a | sed 'y/a/'", "", "sed: -e expression #1, char 4: unterminated `y' command\n", 1],
  ["echo a | sed ':'", "", "sed: -e expression #1, char 1: \":\" lacks a label\n", 1],
  ["sed -i p", "", "sed: no input files\n", 4],
  ["sed -n p n5 nofile ab", "one\ntwo\nthree\nfour\nfive\na b c\nd e f\n", "sed: can't read nofile: No such file or directory\n", 2],
  ["mkdir dd; sed p dd", "", "sed: read error on dd: Is a directory\n", 4],
  ["echo abc | sed -E 's/(a)|b/[\\1]/g'", "[a][]c\n", "", 0],
  ["echo ab | sed 's/a/\\x41/'", "Ab\n", "", 0],
  ["echo a | sed 'a x\\ny\\\\z\\qw'", "a\nx\ny\\zqw\n", "", 0],
  ["printf 'a\\nb\\n' | sed 'x;$G'", "\na\nb\n", "", 0],
  ["echo a | sed -n --expression=p --quiet", "a\n", "", 0],
  ["echo a | sed --version | head -1", "sed (GNU sed) 4.9\n", "", 0],
  ["sed --help | head -3", "Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n\n  -n, --quiet, --silent\n", "", 0],
  ["sed -k", "", "sed: invalid option -- 'k'\nUsage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n\n  -n, --quiet, --silent\n                 suppress automatic printing of pattern space\n      --debug\n                 annotate program execution\n  -e script, --expression=script\n                 add the script to the commands to be executed\n  -f script-file, --file=script-file\n                 add the contents of script-file to the commands to be executed\n  --follow-symlinks\n                 follow symlinks when processing in place\n  -i[SUFFIX], --in-place[=SUFFIX]\n                 edit files in place (makes backup if SUFFIX supplied)\n  -l N, --line-length=N\n                 specify the desired line-wrap length for the `l' command\n  --posix\n                 disable all GNU extensions.\n  -E, -r, --regexp-extended\n                 use extended regular expressions in the script\n                 (for portability use POSIX -E).\n  -s, --separate\n                 consider files as separate rather than as a single,\n                 continuous long stream.\n      --sandbox\n                 operate in sandbox mode (disable e/r/w commands).\n  -u, --unbuffered\n                 load minimal amounts of data from the input files and flush\n                 the output buffers more often\n  -z, --null-data\n                 separate lines by NUL characters\n      --help     display this help and exit\n      --version  output version information and exit\n\nIf no -e, --expression, -f, or --file option is given, then the first\nnon-option argument is taken as the sed script to interpret.  All\nremaining arguments are names of input files; if no input files are\nspecified, then the standard input is read.\n\nGNU sed home page: <https://www.gnu.org/software/sed/>.\nGeneral help using GNU software: <https://www.gnu.org/gethelp/>.\n", 1],
  ["sed --foo", "", "sed: unrecognized option '--foo'\nUsage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n\n  -n, --quiet, --silent\n                 suppress automatic printing of pattern space\n      --debug\n                 annotate program execution\n  -e script, --expression=script\n                 add the script to the commands to be executed\n  -f script-file, --file=script-file\n                 add the contents of script-file to the commands to be executed\n  --follow-symlinks\n                 follow symlinks when processing in place\n  -i[SUFFIX], --in-place[=SUFFIX]\n                 edit files in place (makes backup if SUFFIX supplied)\n  -l N, --line-length=N\n                 specify the desired line-wrap length for the `l' command\n  --posix\n                 disable all GNU extensions.\n  -E, -r, --regexp-extended\n                 use extended regular expressions in the script\n                 (for portability use POSIX -E).\n  -s, --separate\n                 consider files as separate rather than as a single,\n                 continuous long stream.\n      --sandbox\n                 operate in sandbox mode (disable e/r/w commands).\n  -u, --unbuffered\n                 load minimal amounts of data from the input files and flush\n                 the output buffers more often\n  -z, --null-data\n                 separate lines by NUL characters\n      --help     display this help and exit\n      --version  output version information and exit\n\nIf no -e, --expression, -f, or --file option is given, then the first\nnon-option argument is taken as the sed script to interpret.  All\nremaining arguments are names of input files; if no input files are\nspecified, then the standard input is read.\n\nGNU sed home page: <https://www.gnu.org/software/sed/>.\nGeneral help using GNU software: <https://www.gnu.org/gethelp/>.\n", 1],
  ["sed -e", "", "sed: option requires an argument -- 'e'\nUsage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n\n  -n, --quiet, --silent\n                 suppress automatic printing of pattern space\n      --debug\n                 annotate program execution\n  -e script, --expression=script\n                 add the script to the commands to be executed\n  -f script-file, --file=script-file\n                 add the contents of script-file to the commands to be executed\n  --follow-symlinks\n                 follow symlinks when processing in place\n  -i[SUFFIX], --in-place[=SUFFIX]\n                 edit files in place (makes backup if SUFFIX supplied)\n  -l N, --line-length=N\n                 specify the desired line-wrap length for the `l' command\n  --posix\n                 disable all GNU extensions.\n  -E, -r, --regexp-extended\n                 use extended regular expressions in the script\n                 (for portability use POSIX -E).\n  -s, --separate\n                 consider files as separate rather than as a single,\n                 continuous long stream.\n      --sandbox\n                 operate in sandbox mode (disable e/r/w commands).\n  -u, --unbuffered\n                 load minimal amounts of data from the input files and flush\n                 the output buffers more often\n  -z, --null-data\n                 separate lines by NUL characters\n      --help     display this help and exit\n      --version  output version information and exit\n\nIf no -e, --expression, -f, or --file option is given, then the first\nnon-option argument is taken as the sed script to interpret.  All\nremaining arguments are names of input files; if no input files are\nspecified, then the standard input is read.\n\nGNU sed home page: <https://www.gnu.org/software/sed/>.\nGeneral help using GNU software: <https://www.gnu.org/gethelp/>.\n", 1],
  ["sed", "", "Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n\n  -n, --quiet, --silent\n                 suppress automatic printing of pattern space\n      --debug\n                 annotate program execution\n  -e script, --expression=script\n                 add the script to the commands to be executed\n  -f script-file, --file=script-file\n                 add the contents of script-file to the commands to be executed\n  --follow-symlinks\n                 follow symlinks when processing in place\n  -i[SUFFIX], --in-place[=SUFFIX]\n                 edit files in place (makes backup if SUFFIX supplied)\n  -l N, --line-length=N\n                 specify the desired line-wrap length for the `l' command\n  --posix\n                 disable all GNU extensions.\n  -E, -r, --regexp-extended\n                 use extended regular expressions in the script\n                 (for portability use POSIX -E).\n  -s, --separate\n                 consider files as separate rather than as a single,\n                 continuous long stream.\n      --sandbox\n                 operate in sandbox mode (disable e/r/w commands).\n  -u, --unbuffered\n                 load minimal amounts of data from the input files and flush\n                 the output buffers more often\n  -z, --null-data\n                 separate lines by NUL characters\n      --help     display this help and exit\n      --version  output version information and exit\n\nIf no -e, --expression, -f, or --file option is given, then the first\nnon-option argument is taken as the sed script to interpret.  All\nremaining arguments are names of input files; if no input files are\nspecified, then the standard input is read.\n\nGNU sed home page: <https://www.gnu.org/software/sed/>.\nGeneral help using GNU software: <https://www.gnu.org/gethelp/>.\n", 1],
  ["echo abc | sed -n 's/b/X/w /dev/stdout'", "aXc\n", "", 0],
  ["cp n5 w1; sed -i.bak 's/o/Z/' w1; cat w1 w1.bak", "Zne\ntwZ\nthree\nfZur\nfive\none\ntwo\nthree\nfour\nfive\n", "", 0],
  ["cp n5 w1; sed -n -i p w1; cat w1", "one\ntwo\nthree\nfour\nfive\n", "", 0],
  ["cp n5 w1; sed -i 2q w1; cat w1", "one\ntwo\n", "", 0],
  ["echo 'ab' | sed 's/\\(a\\)\\(b\\)/\\2\\1\\0/'", "baab\n", "", 0],
  ["echo abcdefghij | sed -n -l 5 l", "abcd\\\nefgh\\\nij$\n", "", 0],
  ["echo 'a]b' | sed 's/[]]/X/'", "aXb\n", "", 0],
  ["echo 'a b' | sed 's/ /\\\n/'", "a\nb\n", "", 0],
  ["sed -n '/two/,/four/p' n5", "two\nthree\nfour\n", "", 0],
  ["sed '2,4{/three/!d}' n5", "one\nthree\nfive\n", "", 0],
  ["sed '$d' n5", "one\ntwo\nthree\nfour\n", "", 0],
  ["sed -n '$!p' nonl ab", "no newline\na b c\n", "", 0],
  ["sed = ab", "1\na b c\n2\nd e f\n", "", 0],
  ["sed -n '2{p;p}' n5", "two\ntwo\n", "", 0],
  ["sed '2!{s/^/>/}' n5", ">one\ntwo\n>three\n>four\n>five\n", "", 0],
  ["sed 's/e$//' n5", "on\ntwo\nthre\nfour\nfiv\n", "", 0],
  ["sed '/^t/y/te/TE/' n5", "one\nTwo\nThrEE\nfour\nfive\n", "", 0],
  ["sed '1~3d' n5", "two\nthree\nfive\n", "", 0],
  ["sed '2,3s/^/#/' n5", "one\n#two\n#three\nfour\nfive\n", "", 0],
  ["sed -n '/o/!p' n5", "three\nfive\n", "", 0],
  ["sed --posix -n 1p n5", "one\n", "", 0],
  ["sed 's/[aeiou]//2g' n5", "on\ntwo\nthre\nfor\nfiv\n", "", 0],
  ["sed -e 's/o/0/' -e 's/e/3/' n5", "0n3\ntw0\nthr3e\nf0ur\nfiv3\n", "", 0],
  ["sed --quiet --expression='2p' n5", "two\n", "", 0],
  ["sed -En '/^(t|f)/p' n5", "two\nthree\nfour\nfive\n", "", 0],
  ["sed -n -e '/two/{' -e p -e '}' n5", "two\n", "", 0],
// END SED
];
table('sed: output of the real GNU sed', SED);

test('sed: pipelines, in-place editing and files in the simulated filesystem', async () => {
  await run('cd /tmp; ' + SETUP);
  assert.equal(await out('cat n5 | sed -n "2p" | tr a-z A-Z'), 'TWO\n');
  assert.equal(await out('printf "a\\nb\\n" | sed "s/a/x/" | sort -r'), 'x\nb\n');
  await run('cp n5 edit.txt; sed -i.orig "s/o/0/" edit.txt');
  assert.equal(await out('cat edit.txt'), '0ne\ntw0\nthree\nf0ur\nfive\n');
  assert.equal(await out('cat edit.txt.orig'), 'one\ntwo\nthree\nfour\nfive\n');
  await run('sed -n "2,3w picked.txt" n5');
  assert.equal(await out('cat picked.txt'), 'two\nthree\n');
  await run('printf "s/one/1/\\n# note\\n3d\\n" > prog.sed');
  assert.equal(await out('sed -f prog.sed n5'), '1\ntwo\nfour\nfive\n');
});

/** Run a line and press Ctrl-C after a moment. Use last in a test. */
async function interrupted(line, afterMs = 30) {
  const { K, shell, term } = sim;
  term.take();
  const pending = shell.runLine(line);
  setTimeout(() => term.raiseInterrupt(), afterMs);
  const code = await pending;
  return { code, output: K.util.stripAnsi(term.take()) };
}

test('sed: standard input, and Ctrl-C stops a runaway script', async () => {
  const r = await run('sed -n 1p', { stdin: 'first\nsecond\n' });
  assert.equal(r.out, 'first\n');
  const stopped = await interrupted('echo x | sed ":a;ba"');
  assert.equal(stopped.code, 130);
});
