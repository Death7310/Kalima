// Tests for the calculators, JSON and assorted filters (40-cmd-text3.js).
// Expected output was checked against the real tools where they are installed.
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

/** [command line, stdout, stderr, status] rows, run in one shell. */
function table(name, rows) {
  test(name, async () => {
    for (const [line, stdout, stderr = '', status = 0] of rows) {
      const r = await run(line);
      assert.deepEqual([r.out, r.err, r.code], [stdout, stderr, status], line);
    }
  });
}

/* ------------------------------------------------------------------- jq */
const J1 = `echo '{"a":[1,{"b":null,"c":true,"d":"x"}],"e":{},"f":[],"g":1.5}'`;
table('jq: pretty printing, compact output and paths', [
  [`${J1} | jq .`, '{\n  "a": [\n    1,\n    {\n      "b": null,\n      "c": true,\n      "d": "x"\n    }\n  ],\n  "e": {},\n  "f": [],\n  "g": 1.5\n}\n'],
  [`${J1} | jq -c .`, '{"a":[1,{"b":null,"c":true,"d":"x"}],"e":{},"f":[],"g":1.5}\n'],
  [`${J1} | jq -c '.a[1].d, .a[0], .g'`, '"x"\n1\n1.5\n'],
  [`${J1} | jq --tab '.a'`, '[\n\t1,\n\t{\n\t\t"b": null,\n\t\t"c": true,\n\t\t"d": "x"\n\t}\n]\n'],
  [`${J1} | jq --indent 1 '.e, .a[:1]'`, '{}\n[\n 1\n]\n'],
  [`echo '{"b":1,"a":{"d":1,"c":2}}' | jq -S -c .`, '{"a":{"c":2,"d":1},"b":1}\n'],
  [`echo '"é☃"' | jq -a .`, '"\\u00e9\\u2603"\n'],
  [`echo '["a","b c",1,null]' | jq -r '.[]'`, 'a\nb c\n1\nnull\n'],
  [`echo '["a",1,"b"]' | jq -j '.[]'`, 'a1b'],
]);

table('jq: operators, builtins and pipelines', [
  [`echo '[3,1,2,3]' | jq -c 'sort, sort_by(-.), unique, add, first, last, reverse, min, max'`, '[1,2,3,3]\n[3,3,2,1]\n[1,2,3]\n9\n3\n3\n[3,2,1,3]\n1\n3\n'],
  [`echo '[{"n":1,"name":"x"},{"n":2,"name":"y"},{"n":3,"name":"z"}]' | jq -c '.[] | select(.n > 1 and .n < 3) | .name'`, '"y"\n'],
  [`echo '{"b":1,"a":"s"}' | jq -c 'keys, length, map(type), to_entries'`, '["a","b"]\n2\n["number","string"]\n[{"key":"b","value":1},{"key":"a","value":"s"}]\n'],
  [`echo '[1,"a",null,true]' | jq 'join(",")'`, '"1,a,,true"\n'],
  [`echo '{"a":1,"b":2}' | jq -c 'with_entries(.value += 1), has("a"), (to_entries | map(select(.value > 1)) | from_entries)'`, '{"a":2,"b":3}\ntrue\n{"b":2}\n'],
  [`echo '[1,2,3]' | jq -c 'reduce .[] as $x (0; . + $x), [foreach .[] as $x (0; . + $x)], [.[] | if . > 1 then "big" else "small" end]'`, '6\n[1,3,6]\n["small","big","big"]\n'],
  [`echo '{"a":1,"b":2}' | jq -c '.a = 5 | .b |= . + 1 | .c += 2 | del(.a)'`, '{"b":3,"c":2}\n'],
  [`echo '[1,2,3]' | jq -c '(.[] | select(. > 1)) |= . * 10'`, '[1,20,30]\n'],
  [`echo '"abc"' | jq -c 'test("B";"i"), sub("b";"X"), gsub("[ac]";"-"), [scan("[a-c]")], capture("(?<x>b)"), ascii_upcase, length'`, 'true\n"aXc"\n"-b-"\n["a","b","c"]\n{"x":"b"}\n"ABC"\n3\n'],
  [`jq -nc '[limit(3;range(10))], [range(0;10;3)], ("a,b"|split(",")), (1 + 2 * 3), ("ab" * 2), ({a:1} + {b:2})'`, '[0,1,2]\n[0,3,6,9]\n["a","b"]\n7\n"abab"\n{"a":1,"b":2}\n'],
  [`jq -nc '{a:(1,2),b:(3,4)}, "\\(1,2)-\\(3,4)"'`, '{"a":1,"b":3}\n{"a":1,"b":4}\n{"a":2,"b":3}\n{"a":2,"b":4}\n"1-3"\n"2-3"\n"1-4"\n"2-4"\n'],
  [`echo '[1,"a b","<&>"]' | jq -r '@csv, @tsv, @sh, @json, @uri, @base64'`, '1,"a b","<&>"\n1\ta b\t<&>\n1 \'a b\' \'<&>\'\n[1,"a b","<&>"]\n%5B1%2C%22a%20b%22%2C%22%3C%26%3E%22%5D\nWzEsImEgYiIsIjwmPiJd\n'],
  [`jq -nc 'def f(x): x * 2; def fac: if . <= 1 then 1 else . * (. - 1 | fac) end; [f(3), (5 | fac)], (label $out | 1, 2, break $out, 3)'`, '[6,120]\n1\n2\n'],
  [`echo '[[1,2],[3,[4]]]' | jq -c 'flatten, transpose, [paths]'`, '[1,2,3,4]\n[[1,3],[2,[4]]]\n[[0],[0,0],[0,1],[1],[1,0],[1,1],[1,1,0]]\n'],
]);

table('jq: -n, -s, -R, -e, --arg and multiple inputs', [
  [`echo '1 2 3' | jq -c -s .`, '[1,2,3]\n'],
  [`echo '1 2 3' | jq -nc '[inputs]'`, '[1,2,3]\n'],
  [`printf 'a\\nb\\n' | jq -R .`, '"a"\n"b"\n'],
  [`printf 'a\\nb\\n' | jq -Rs .`, '"a\\nb\\n"\n'],
  [`jq -nc --arg x 1 --argjson y '{"a":2}' '[$x, $y, $ARGS.named]'`, '["1",{"a":2},{"x":"1","y":{"a":2}}]\n'],
  [`jq -nc '$ARGS.positional' --args a b`, '["a","b"]\n'],
  [`jq -nc '$ARGS.positional' --jsonargs 1 '"x"'`, '[1,"x"]\n'],
  [`echo null | jq -e .`, 'null\n', '', 1],
  [`echo 1 | jq -e empty`, '', '', 4],
  [`echo 1 | jq -e .`, '1\n'],
  [`echo '{"a":1}' > j.json; jq -c . j.json j.json`, '{"a":1}\n{"a":1}\n'],
  [`jq -n '"bye\\n" | halt_error(1)'`, '', 'bye\n', 1],
  [`echo '"x"' | jq -r '@base64 "v=\\(.)"'`, 'v=eA==\n'],
  [`echo '"aGk="' | jq -r '@base64d'`, 'hi\n'],
  [`echo '{"a":1}' | jq -r '.a as $x | "n=\\($x)"'`, 'n=1\n'],
  [`echo '{"a":{"b":2}}' | jq -c 'tojson, (tojson | fromjson), [paths], [..]'`, '"{\\"a\\":{\\"b\\":2}}"\n{"a":{"b":2}}\n[["a"],["a","b"]]\n[{"a":{"b":2}},{"b":2},2]\n'],
]);

table('jq: errors and exit codes', [
  [`echo '{"a":1}' | jq '.a.b'`, '', 'jq: error (at <stdin>:1): Cannot index number with string "b"\n', 5],
  [`printf '{"a":1}\\n{"a":2}\\n[1]\\n' | jq '.a'`, '1\n2\n', 'jq: error (at <stdin>:3): Cannot index array with string "a"\n', 5],
  [`echo 1 | jq 'error("boom")'`, '', 'jq: error (at <stdin>:1): boom\n', 5],
  [`echo '{"a":1}' | jq error`, '', 'jq: error (at <stdin>:1) (not a string): {"a":1}\n', 5],
  [`echo 1 | jq -c '[.[]?], (try error("x") catch .), ((1/0)? // "z")'`, '[]\n"x"\n"z"\n'],
  [`echo 1 | jq '.a b'`, '', 'jq: error: syntax error, unexpected IDENT, expecting end of file (Unix shell quoting issues?) at <top-level>, line 1:\n.a b\njq: 1 compile error\n', 3],
  [`echo 1 | jq foo`, '', 'jq: error: foo/0 is not defined at <top-level>, line 1:\nfoo\njq: 1 compile error\n', 3],
  [`echo 1 | jq '$y'`, '', 'jq: error: $y is not defined at <top-level>, line 1:\n$y\njq: 1 compile error\n', 3],
  [`echo '{a' | jq .`, '', 'jq: parse error: Invalid numeric literal at line 2, column 0\n', 5],
  [`echo '{"a":1,}' | jq .`, '', 'jq: parse error: Expected another key-value pair at line 1, column 8\n', 5],
  [`echo '[1 2]' | jq .`, '', 'jq: parse error: Expected separator between values at line 1, column 5\n', 5],
  [`echo '[1,2' | jq .`, '', 'jq: parse error: Unfinished JSON term at EOF at line 2, column 0\n', 5],
  [`jq . /nonexistent`, '', 'jq: error: Could not open /nonexistent: No such file or directory\n', 2],
  [`jq --bogus . < /dev/null`, '', 'jq: Unknown option --bogus\nUse jq --help for help with command-line options,\nor see the jq manpage, or online docs  at https://jqlang.github.io/jq\n', 2],
  [`jq --version`, 'jq-1.7.1\n'],
]);

test('jq: colours on a terminal match the real tool and are off in pipes', async () => {
  const r = await run(`${J1} | jq -C -c '.a'`);
  assert.equal(r.out, '\x1b[1;39m[\x1b[0;39m1\x1b[0m\x1b[1;39m,\x1b[1;39m{\x1b[0m\x1b[1;34m"b"\x1b[0m\x1b[1;39m:\x1b[0m\x1b[0;90mnull\x1b[0m\x1b[1;39m,\x1b[0m\x1b[1;34m"c"\x1b[0m\x1b[1;39m:\x1b[0m\x1b[0;39mtrue\x1b[0m\x1b[1;39m,\x1b[0m\x1b[1;34m"d"\x1b[0m\x1b[1;39m:\x1b[0m\x1b[0;32m"x"\x1b[0m\x1b[1;39m\x1b[1;39m}\x1b[0m\x1b[1;39m\x1b[1;39m]\x1b[0m\n');
  const t = await sim.type(`${J1} | jq -c .e`);
  assert.equal(t.output.trim(), '{}');
});

test('jq: help and man page', async () => {
  assert.match(await out('jq --help'), /^jq - commandline JSON processor/);
  assert.match(await out('man jq'), /DESCRIPTION/);
});

/* ------------------------------------------------------------------- bc */
const bcOut = (prog, flags = '') => out(`printf '%s\\n' '${prog.replace(/'/g, "'\\''")}' | bc ${flags}`);
test('bc: decimal arithmetic respects scale', async () => {
  const rows = [
    ['1+2*3', '7\n'], ['7/2', '3\n'], ['scale=2; 7/2', '3.50\n'], ['scale=5; 1/3', '.33333\n'], ['scale=5; -1/3', '-.33333\n'],
    ['2^100', '1267650600228229401496703205376\n'], ['2^-2', '0\n'], ['scale=3; 2^-2', '.250\n'], ['scale=2; 1.5^3', '3.37\n'],
    ['5%3', '2\n'], ['scale=3; 5.5%2', '0\n'], ['-5%3', '-2\n'], ['1.0+1.0', '2.0\n'], ['0.1*0.1', '0\n'], ['scale=3; 0.1*0.1', '.01\n'],
    ['scale=3; 10/3*3', '9.999\n'], ['length(12.345)', '5\n'], ['scale(1.50)', '2\n'], ['2 ^ 3 ^ 2', '512\n'], ['-2^2', '4\n'], ['(1+2)*3', '9\n'],
    ['scale=10; sqrt(2)', '1.4142135623\n'], ['sqrt(16)', '4\n'], ['5 > 3 && 2 > 1', '1\n'], ['!0', '1\n'], ['3 < 2', '0\n'],
  ];
  for (const [prog, want] of rows) assert.equal(await bcOut(prog), want, prog);
});

test('bc: variables, arrays, control flow and functions', async () => {
  assert.equal(await bcOut('x=5;x++;x'), '5\n6\n');
  assert.equal(await bcOut('x=5;x*=2;x/=3;x'), '3\n');
  assert.equal(await bcOut('a[1]=5;a[2]=6;a[1]+a[2]'), '11\n');
  assert.equal(await bcOut('for(i=0;i<3;i++) i'), '0\n1\n2\n');
  assert.equal(await bcOut('i=0;while(i<3){i;i+=1}'), '0\n1\n2\n');
  assert.equal(await bcOut('if (1) 1 else 2'), '1\n');
  assert.equal(await bcOut('define f(n){\nif(n<2) return n\nreturn f(n-1)+f(n-2)\n}\nf(15)'), '610\n');
  assert.equal(await bcOut('define g(a[],n){return a[n]}\nb[2]=7\ng(b[],2)'), '7\n');
  assert.equal(await bcOut('define f(n){auto i,s;for(i=1;i<=n;i++)s+=i;return(s)}\nf(100)'), '5050\n');
  assert.equal(await bcOut('"a";1'), 'a1\n');
  assert.equal(await bcOut('print "a","b\\n"'), 'ab\n');
  assert.equal(await bcOut('5;.'), '5\n5\n');
  assert.equal(await bcOut('1 # c\n2 /* x */ + 3'), '1\n5\n');
  assert.equal(await bcOut('1+1; quit; 5'), '');
  assert.equal(await bcOut('1+1\nquit\n5'), '2\n');
});

test('bc: bases and long numbers', async () => {
  assert.equal(await bcOut('obase=2; 255'), '11111111\n');
  assert.equal(await bcOut('obase=16; 255.25'), 'FF.40\n');
  assert.equal(await bcOut('obase=16; scale=3; 255.25'), 'FF.40\n');
  assert.equal(await bcOut('obase=100; 12345'), ' 01 23 45\n');
  assert.equal(await bcOut('ibase=16; FF'), '255\n');
  assert.equal(await bcOut('ibase=2; 101'), '5\n');
  assert.equal(await bcOut('obase=2; -5'), '-101\n');
  assert.equal(await bcOut('2^300'), '20370359763344860862684456884093781610514683936659362506361404493543\\\n81299763336706183397376\n');
});

test('bc -l: math library matches the real tool', async () => {
  assert.equal(await bcOut('scale=5; 4*a(1)', '-l'), '3.14156\n');
  assert.equal(await bcOut('s(1)+c(1)', '-l'), '1.38177329067603622405\n');
  assert.equal(await bcOut('l(10)', '-l'), '2.30258509299404568401\n');
  assert.equal(await bcOut('e(1)', '-l'), '2.71828182845904523536\n');
  assert.equal(await bcOut('scale=50; 4*a(1)', '-l'), '3.14159265358979323846264338327950288419716939937508\n');
  assert.equal(await bcOut('e(100)', '-l'), '26881171418161354484126255515800135873611118.77374192241519160861\n');
  assert.equal(await bcOut('sqrt(2)', '-l'), '1.41421356237309504880\n');
  assert.equal(await bcOut('1/3', '-l'), '.33333333333333333333\n');
});

test('bc: error messages', async () => {
  const run1 = async (prog) => run(`printf '%s\\n' '${prog}' | bc`);
  let r = await run1('1/0');
  assert.deepEqual([r.out, r.err, r.code], ['', 'Runtime error (func=(main), adr=3): Divide by zero\n', 0]);
  r = await run1('10 % 0');
  assert.equal(r.err, 'Runtime error (func=(main), adr=6): Modulo by zero\n');
  r = await run1('sqrt(-4)');
  assert.equal(r.err, 'Runtime error (func=(main), adr=6): Square root of a negative number\n');
  r = await run1('f(1)');
  assert.equal(r.err, 'Runtime error (func=(main), adr=3): Function f not defined.\n');
  r = await run1('1 +');
  assert.equal(r.err, '(standard_in) 2: syntax error\n');
  r = await run1('1 2');
  assert.equal(r.err, '(standard_in) 1: syntax error\n');
  r = await run1('2 | 3');
  assert.equal(r.err, '(standard_in) 1: illegal character: |\n(standard_in) 1: syntax error\n');
  r = await run('bc /nonexistent');
  assert.deepEqual([r.err, r.code], ['File /nonexistent is unavailable.\n', 1]);
  r = await run('bc -x < /dev/null');
  assert.match(r.err, /^bc: invalid option -- 'x'\nusage: bc/);
});

test('bc: files, banner and the interactive terminal', async () => {
  await run(`printf 'x=21\\nx*2\\nquit\\n' > /tmp/calc.bc`);
  assert.equal(await out('echo 99 | bc -q /tmp/calc.bc'), '42\n');
  assert.match(await out('bc --version'), /^bc 1\.07\.1\nCopyright/);
  sim.term.feed('2+2'); sim.term.feed('quit');
  const r = await sim.type('bc -q');
  assert.match(r.output.replace(/\r/g, ''), /\n4\n/);
  assert.match(await out('man bc'), /DESCRIPTION/);
});
