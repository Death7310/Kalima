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

const AWK = [
// BEGIN AWK
  ["awk '{print $1}' ab", "a\nd\n", "", 0],
  ["awk -F: '{print $1, $NF}' col", "x foo\ny bar\nz baz\n", "", 0],
  ["awk '$2 > 10' fruit", "5 apples\n12 pears\n7 figs\n", "", 0],
  ["awk '{s += $1} END {print s}' fruit", "24\n", "", 0],
  ["awk '{c[$1]++} END {for (k in c) print c[k], k}' ab col", "1 y:22:bar\n1 a\n1 x:1:foo\n1 d\n1 z:333:baz\n", "", 0],
  ["awk 'NR==2,NR==4' n5", "two\nthree\nfour\n", "", 0],
  ["awk 'BEGIN{printf \"%5.2f|%-5s|%05d|%x|%o|%c%c|%e|%g|%+d|% d\\n\", 3.14159, \"ab\", 42, 255, 8, 65, \"hello\", 12345.6789, 0.0000123, 5, 5}'", " 3.14|ab   |00042|ff|10|Ah|1.234568e+04|1.23e-05|+5| 5\n", "", 0],
  ["awk 'BEGIN{print 2^53, 2^31, 2^63, 1e18, 1e30, 0.1+0.2, 100000*100000, -3, 1/3, 17/4, 1e6, 1e-5, 123456789012}'", "9007199254740992 2147483648 9223372036854775808 1000000000000000000 1e+30 0.3 10000000000 -3 0.333333 4.25 1000000 1e-05 123456789012\n", "", 0],
  ["awk 'BEGIN{print \"0x1A\"+0, \"1e3\"+0, \".5\"+0, \"+5x\"+0, \" 12 \"+0}'", "26 1000 0.5 5 12\n", "", 0],
  ["awk 'BEGIN{print substr(\"hello\",0,2) \"|\" substr(\"hello\",-1) \"|\" substr(\"hello\",2,100) \"|\" substr(\"hello\",1.5,2) \"|\" substr(\"hello\",2) \"|\" substr(\"hello\", 6) \"|\" substr(\"hello\",-1,3)}'", "he|hello|ello|he|ello||hell\n", "", 0],
  ["awk 'BEGIN{printf \"%s %s\\n\", \"a\"}'", "a ", "awk: run time error: not enough arguments passed to printf(\"%s %s\n\")\n\tFILENAME=\"\" FNR=0 NR=0\n", 2],
  ["awk 'BEGIN{print 1/0}'", "inf\n", "", 0],
  ["awk '{print}' nofile", "", "awk: cannot open \"nofile\" (No such file or directory)\n", 2],
  ["awk 'BEGIN { x = }'", "", "awk: line 1: syntax error at or near }\n", 2],
  ["awk 'BEGIN { print \"abc\" ~ /(/ }'", "", "awk: line 1: regular expression compile failed (missing ')')\n(\n", 2],
  ["awk 'BEGIN{print \"\\q\" \"\\/\" \"\\101\" \"\\x41\"}'", "\\q\\/AA\n", "", 0],
  ["awk 'BEGIN{x[\"a\"]=1; print length(x); delete x; print length(x)}'", "1\n0\n", "", 0],
  ["awk 'BEGIN{print -2^2, 2^3^2, 1 - 1, 1 \" \" -1, !x, !\"a\", 1==1.0, \"a\"<\"b\", \"10\"<\"9\", 10<9}'", "-4 512 0 1-1 1 0 1 1 1 0\n", "", 0],
  ["echo \"a b c\" | awk '{$5=\"x\"; print; print NF; NF=2; print; $0=\"p q r s\"; print NF}'", "a b c  x\n5\na b\n4\n", "", 0],
  ["echo \"a:b\" | awk -F: -v OFS=- '{$1=$1; print}'", "a-b\n", "", 0],
  ["printf 'a b\\n\\nc d\\ne\\n\\n\\nf\\n' | awk 'BEGIN{RS=\"\"}{print NR\": \"$1\"|\"$NF\"|\"NF}'", "1: a|b|2\n2: c|e|3\n3: f|f|1\n", "", 0],
  ["echo \"x\" | awk '{ print NR, FNR, FILENAME \"|\" }'", "1 1 -|\n", "", 0],
  ["echo \"3 4\" | awk '{print $1*$2, $1/$2, $1%$2, $1^$2, $1 $2}'", "12 0.75 3 81 34\n", "", 0],
  ["awk 'BEGIN{printf \"%d\\n\", \"abc\"}'", "0\n", "", 0],
  ["awk 'function f(a){a[\"x\"]=1} BEGIN{f(arr); print arr[\"x\"]}'", "1\n", "", 0],
  ["awk 'BEGIN{print 1e300*1e300, -1e300*1e300}'", "inf -inf\n", "", 0],
  ["awk 'BEGIN{print int(-3.7), int(\"3abc\"), int(\"\"), sqrt(16), exp(0), log(1), atan2(0,-1), sin(0), cos(0)}'", "-3 3 0 4 1 0 3.14159 0 1\n", "", 0],
  ["awk 'END{print $0, NF, NR}' ab", "d e f 3 2\n", "", 0],
  ["awk -v 'x=a\\tb' 'BEGIN{print x; print length(x)}'", "a\tb\n3\n", "", 0],
  ["awk '{print v, $1}' v=1 n5 v=2 ab", "1 one\n1 two\n1 three\n1 four\n1 five\n2 a\n2 d\n", "", 0],
  ["echo '1.0 1 abc ABC 0x10 16 +1 1e0' | awk '{print ($1==$2), ($3==$4), ($5==$6), ($7==$2), ($8==$2), ($1==\"1\"), ($2==\"1.0\")}'", "1 0 1 1 1 0 0\n", "", 0],
  ["awk 'BEGIN{x=\"a\"; y = x ~ \"a\"; print y; $0=\"a b\"; print /a/ + /c/; print !/a/}'", "1\n1\n0\n", "", 0],
  ["awk 'BEGIN{printf \"%*d|%-*d|%.*f\\n\", 5, 42, 4, 7, 2, 3.14159}'", "   42|7   |3.14\n", "", 0],
  ["awk 'BEGIN{printf \"%d %d %d\\n\", 2147483648, -2147483649, 1e19; printf \"%s %s\\n\", 1e6, 1234567.5; OFMT=\"%.2f\"; print 3.14159, 3.14159 \"\"; CONVFMT=\"%.3f\"; print 3.14159 \"\"}'", "2147483648 -2147483649 10000000000000000000\n1000000 1.23457e+06\n3.14 3.14159\n3.142\n", "", 0],
  ["awk 'BEGIN{a[\"x\"];if (\"x\" in a) print \"in\"; if ((\"y\") in a) print \"no\"; print length(a); a[1,2]=3; for (k in a) {n=split(k,p,SUBSEP); print n}}'", "in\n1\n1\n2\n", "", 0],
  ["printf 'a,b;c\\n' | awk -F'[,;]' '{print $2, NF}'", "b 3\n", "", 0],
  ["printf 'a  b\\n' | awk -F' ' '{print NF}'; printf 'a  b\\n' | awk -F'[ ]' '{print NF}'; printf 'atbtc\\n' | awk -Ft '{print NF}'; printf 'a|b\\n' | awk -F'|' '{print $2}'; printf 'a.b\\n' | awk -F. '{print $2}'", "2\n3\n3\nb\nb\n", "", 0],
  ["printf 'aXXbXc\\n' | awk 'BEGIN{RS=\"X+\"}{print NR\":\"$0}'", "1:a\n2:b\n3:c\n\n", "", 0],
  ["printf 'a b\\nc d\\n' | awk '{ $2 = \"\"; print; print NF }'", "a \n2\nc \n2\n", "", 0],
  ["printf 'one two\\n' | awk '{ sub(/o/, \"[&]\"); print; gsub(/o/, \"\\\\&\"); print; n = gsub(/e/, \"E\", $2); print n, $0 }'", "[o]ne two\n[&]ne tw&\n0 [&]ne tw&\n", "", 0],
  ["awk 'BEGIN{s=\"aaa\"; n=gsub(/x*/,\"-\",s); print n, s; t=\"hello\"; gsub(/l*/,\"X\",t); print t; u=\"abc\"; sub(/b/,\"\\\\\\\\&\",u); print u}'", "4 -a-a-a-\nXhXeXoX\na\\bc\n", "", 0],
  ["awk 'BEGIN{print match(\"foobar\", /o+/), RSTART, RLENGTH; print match(\"x\", /y/), RSTART, RLENGTH; print split(\"a b  c\", arr), arr[3]; print split(\"\", arr), length(arr); print split(\"abc\", c, \"\"), c[2]; print split(\"a1b2c\", d, /[0-9]/), d[3]}'", "2 2 2\n0 0 -1\n3 c\n0 0\n3 b\n3 c\n", "", 0],
  ["awk 'BEGIN{print tolower(\"ABC\") toupper(\"abc\"), sprintf(\"%03d\", 7), index(\"\", \"a\"), index(\"a\", \"\")}'", "abcABC 007 0 1\n", "", 0],
  ["awk 'BEGIN { while (i < 3) { i++; if (i == 2) continue; print i } do { j++ } while (j < 5); print j; for (;;) { k++; if (k > 3) break }; print k }'", "1\n3\n5\n4\n", "", 0],
  ["awk 'function fact(n) { return n <= 1 ? 1 : n * fact(n-1) } BEGIN { print fact(10), fact(20) }'", "3628800 2432902008176640000\n", "", 0],
  ["awk 'BEGIN { exit 3 } END { print \"end\" }'", "end\n", "", 3],
  ["awk 'BEGIN{print length(12345), length(1/3)}'", "5 8\n", "", 0],
  ["awk 'NR==2,/9/' n5; awk '/two/,/two/{print \"r\" $0}' n5", "two\nthree\nfour\nfive\nrtwo\n", "", 0],
  ["awk '{c[$1]++} END {for (k in c) print c[k], k}' n5", "1 three\n1 five\n1 four\n1 two\n1 one\n", "", 0],
  ["awk 'BEGIN { printf \"a\" \"b\" \"\\n\"; print(\"x\")(\"y\"); print (1)(2) }'", "ab\nxy\n12\n", "", 0],
  ["awk 'BEGIN { x = 5; x ^= 2; x %= 7; print x; y = x++ + ++x; print y, x; print x--, --x }'", "4\n10 6\n6 4\n", "", 0],
  ["awk 'BEGIN { print 010 + 0, \"010\" + 0, 1e3, .5 }'", "10 10 1000 0.5\n", "", 0],
  ["awk 'BEGIN{getline; print \"got \" $0; getline x; print \"x=\" x, NR}' n5", "got one\nx=two 2\n", "", 0],
  ["awk '{ print FILENAME, FNR, NR }' n5 ab", "n5 1 1\nn5 2 2\nn5 3 3\nn5 4 4\nn5 5 5\nab 1 6\nab 2 7\n", "", 0],
  ["awk 'BEGIN { print substr(\"abc\", 2) > \"out1\"; close(\"out1\"); while ((getline l < \"out1\") > 0) print \"read\", l }'", "read bc\n", "", 0],
  ["awk 'BEGIN{print ENVIRON[\"NOPE\"] \"|\", ARGC, ARGV[0], ARGV[1]}' zz", "| 2 awk zz\n", "", 0],
  ["awk 'BEGIN { print length(\"a\\nb\"); print \"a\" \"b\" == \"ab\"; print 1 \" \" 2, 1+1 \"x\" }'", "3\n1\n1 2 2x\n", "", 0],
  ["awk 'BEGIN{x[1]=1; x=2}'", "", "awk: line 1: illegal reference to array x\n", 2],
  ["awk 'function f(x){return x} BEGIN{print f(1,2)}'", "", "awk: line 1: too many arguments in call to f\n", 2],
  ["awk 'BEGIN{nosuch(1)}'", "", "awk: line 2: function nosuch never defined\n", 2],
  ["awk 'BEGIN{print -\"3x\", +\"4\", - -2}'", "-3 4 2\n", "", 0],
  ["awk 'BEGIN { print }}'", "", "awk: line 1: extra '}'\nawk: line 1: syntax error at or near end of line\n", 2],
  ["awk 'BEGIN{printf \"%z\\n\", 1}'", "", "awk: run time error: improper conversion(number 1) in printf(\"%z\n\")\n\tFILENAME=\"\" FNR=0 NR=0\n", 2],
  ["echo 'a b' | awk '{print $(-1)}'", "", "awk: run time error: negative field index $-1\n\tFILENAME=\"-\" FNR=1 NR=1\n", 2],
  ["echo 'x y' | awk '{ print $NF, $(NF-1) ; NF++; print NF}'", "y x\n3\n", "", 0],
  ["awk 'BEGIN { OFS=\"-\"; $0 = \"a b c\"; $1=$1; print; print $0 }'", "a-b-c\na-b-c\n", "", 0],
  ["awk 'BEGIN{printf \"%x %X %o %u\\n\", 255, 255, 8, -1}'", "ff FF 10 18446744073709551615\n", "", 0],
  ["awk 'BEGIN{printf \"%.2f %.0f %.0f %.0f %.1f\\n\", 2.675, 0.5, 1.5, 2.5, 0.25}'", "2.67 0 2 2 0.2\n", "", 0],
  ["awk 'BEGIN { print 5 % 3, -5 % 3, 5.5 % 2, 2 ^ 0.5, 2 ^ -1 }'", "2 -2 1.5 1.41421 0.5\n", "", 0],
  ["awk 'BEGIN{for(i=1;i<=12;i++)a[i]=i; for(k in a) printf \"%s \", k; print \"\"; b[\"x\"];b[\"y\"];b[\"z\"];b[\"apple\"];b[\"banana\"]; for(k in b) printf \"%s \", k; print \"\"; delete a[3]; for(k in a) printf \"%s \", k; print \"\"}'", "3 10 8 6 5 2 11 1 4 12 9 7 \nx banana z y apple \n10 8 6 5 2 11 1 4 12 9 7 \n", "", 0],
  ["echo 65 | awk '{printf \"%c|%c\\n\", $1, $1+0}'", "A|A\n", "", 0],
  ["awk 'BEGIN{print \"z\\na\" | \"sort\"; print \"first\"}'", "a\nz\nfirst\n", "", 0],
  ["awk 'BEGIN{print system(\"exit 3\"), system(\"true\")}'", "3 0\n", "", 0],
  ["awk 'BEGIN{while((\"echo a;echo b\" | getline l)>0) print \"got\", l; print close(\"echo a;echo b\")}'", "got a\ngot b\n0\n", "", 0],
  ["awk 'BEGIN { \"echo hi\" | getline y; print y; system(\"echo sys\"); print \"z\" | \"cat\"; close(\"cat\"); print \"after\" }'", "hi\nsys\nz\nafter\n", "", 0],
  ["awk --version | head -1", "mawk 1.3.4 20240123\n", "", 0],
  ["awk", "", "Usage: mawk [Options] [Program] [file ...]\n\nProgram:\n    The -f option value is the name of a file containing program text.\n    If no -f option is given, a \"--\" ends option processing; the following\n    parameters are the program text.\n\nOptions:\n    -f program-file  Program  text is read from file instead of from the\n                     command-line.  Multiple -f options are accepted.\n    -F value         sets the field separator, FS, to value.\n    -v var=value     assigns value to program variable var.\n    --               unambiguous end of options.\n\n    Implementation-specific options are prefixed with \"-W\".  They can be\n    abbreviated:\n\n    -W version       show version information and exit.\n    -W compat        pre-POSIX 2001.\n    -W dump          show assembler-like listing of program and exit.\n    -W help          show this message and exit.\n    -W interactive   set unbuffered output, line-buffered input.\n    -W exec file     use file as program as well as last option.\n    -W posix         stricter POSIX checking.\n    -W random=number set initial random seed.\n    -W sprintf=number adjust size of sprintf buffer.\n    -W usage         show this message and exit.\n", 0],
  ["awk -z 'BEGIN{}'", "", "awk: not an option: -z\n", 2],
  ["awk -F", "", "awk: option -F lacks argument\n", 2],
  ["awk -f nofile", "", "awk: cannot open \"nofile\" (No such file or directory)\n", 2],
  ["awk -v 1x=3 'BEGIN{}'", "", "awk: improper assignment: -v 1x=3\n", 2],
  ["awk 'BEGIN{getline x < \"nofile\"; print (getline y < \"nofile\")}'", "-1\n", "", 0],
  ["awk '/o/ && !/e/ {print NR\": \"$0}' n5", "2: two\n4: four\n", "", 0],
  ["awk 'NR%2' n5", "one\nthree\nfive\n", "", 0],
  ["awk '{ $1 = toupper(substr($1,1,1)) substr($1,2) } 1' n5", "One\nTwo\nThree\nFour\nFive\n", "", 0],
  ["awk 'BEGIN { while ((\"echo 1 2 3\" | getline) > 0) print NF, $2 }'", "3 2\n", "", 0],
  ["awk '{ n = split($0, p, \"\"); print n }' ab", "5\n5\n", "", 0],
  ["awk '{ for (i = NF; i > 0; i--) printf \"%s%s\", $i, (i > 1 ? OFS : ORS) }' ab", "c b a\nf e d\n", "", 0],
  ["awk 'BEGIN { printf \"%s\\n\", 0.1 + 0.2; print 0.1+0.2 == 0.3; print 1e3 \"\" , 1e3 + 0 \"\"; x = 0.1; print x \"\" ; print 3/2 \"\" }'", "0.3\n0\n1000 1000\n0.1\n1.5\n", "", 0],
  ["awk 'BEGIN { x[\"a\"]=1; f(x) } function f(arr, k) { for (k in arr) print k, arr[k] }'", "a 1\n", "", 0],
  ["awk 'function g(n,   loc) { loc = n * 2; return loc } BEGIN { print g(4), loc \"|\" }'", "8 |\n", "", 0],
  ["awk 'BEGIN{ OFS=\":\"; print \"a\",\"b\"; ORS=\"!\\n\"; print \"c\" }'", "a:b\nc!\n", "", 0],
  ["awk '{ print > \"/dev/stderr\" }' ab", "", "a b c\nd e f\n", 0],
  ["awk 'BEGIN{printf \"%s %d\\n\", \"x\"}'", "x ", "awk: run time error: not enough arguments passed to printf(\"%s %d\n\")\n\tFILENAME=\"\" FNR=0 NR=0\n", 2],
  ["awk 'BEGIN{print length()}' < /dev/null", "0\n", "", 0],
  ["awk -F: '$2 > 20 { print $1 > \"big.txt\" } END { close(\"big.txt\"); while ((getline l < \"big.txt\") > 0) print \"big:\", l }' col", "big: y\nbig: z\n", "", 0],
  ["awk 'BEGIN { print substr(\"hello\", 2, 3), substr(\"x\", 1, 0) \"|\" }'", "ell |\n", "", 0],
// END AWK
];
table('awk: output of the real mawk', AWK);

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

test('awk: pipelines, files and commands in the simulated filesystem', async () => {
  await run('cd /tmp; ' + SETUP);
  assert.equal(await out('cat fruit | awk \'{ total += $1 } END { print total }\''), '24\n');
  assert.equal(await out('awk \'{ print $2 }\' fruit | sort'), 'apples\nfigs\npears\n');
  assert.equal(await out('ls | awk \'/^n/ { print "file:", $0 }\' | head -n 2'), 'file: n5\nfile: nonl\n');
  assert.equal(await out('printf "b 2\\na 1\\n" | awk \'{ print $2, $1 | "sort" }\''), '1 a\n2 b\n');
  assert.equal(await out('awk \'BEGIN { "echo kalima" | getline name; print toupper(name) }\''), 'KALIMA\n');
  assert.equal(await out('awk \'BEGIN { system("echo from system") }\''), 'from system\n');
  await run('printf "BEGIN { n = 0 }\\n{ n += \\$1 }\\nEND { print \\"sum\\", n }\\n" > sum.awk');
  assert.equal(await out('awk -f sum.awk fruit'), 'sum 24\n');
  await run('awk \'{ print $1 > "firsts.txt" }\' ab');
  assert.equal(await out('cat firsts.txt'), 'a\nd\n');
});

test('awk: standard input, the terminal and the field separator option', async () => {
  assert.equal((await run('awk -F, \'{ print $2 }\'', { stdin: 'a,b,c\nd,e,f\n' })).out, 'b\ne\n');
  assert.equal((await run('awk \'END { print NR }\'', { stdin: 'x\ny\nz' })).out, '3\n');
  sim.term.feed('one two');
  const r = await run('awk \'{ print $2; exit }\'');
  assert.equal(r.out, 'two\n');
});

test('awk: Ctrl-C stops an endless loop', async () => {
  const stopped = await interrupted('awk \'BEGIN { while (1) n++ }\'');
  assert.equal(stopped.code, 130);
  const printing = await interrupted('awk \'BEGIN { while (1) print "y" }\' | head -c 0 >/dev/null; echo done');
  assert.ok(printing.output.length >= 0);
});
