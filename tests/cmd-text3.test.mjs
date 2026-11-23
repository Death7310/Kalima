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

/* -------------------------------------------------------------- openssl */
table('openssl: digests in the OpenSSL 3 output style', [
  [`echo hello > h.txt; openssl dgst -sha256 h.txt`, 'SHA2-256(h.txt)= 5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03\n'],
  [`openssl dgst -md5 h.txt`, 'MD5(h.txt)= b1946ac92492d2347c6235b4d2611184\n'],
  [`openssl dgst -sha1 h.txt`, 'SHA1(h.txt)= f572d396fae9206628714fb2ce00f72e94f2258f\n'],
  [`openssl dgst -sha512 h.txt`, 'SHA2-512(h.txt)= e7c22b994c59d9cf2b48e549b1e24666636045930d3da7c1acb299d1c3b7f931f94aae41edda2c2b207a36e10f8bcb8d45223e54878f5b316e7ce3b6bc019629\n'],
  [`openssl dgst -sha224 h.txt`, 'SHA2-224(h.txt)= 2d6d67d91d0badcdd06cbbba1fe11538a68a37ec9c2e26457ceff12b\n'],
  [`openssl dgst -sha384 /dev/null`, 'SHA2-384(/dev/null)= 38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b\n'],
  [`echo hi | openssl dgst -sha256`, 'SHA2-256(stdin)= 98ea6e4f216f2fb4b69fff9b3a44842c38686ca685f3f55dc48c5d3fb1107be4\n'],
  [`openssl dgst h.txt`, 'SHA256(h.txt)= 5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03\n'],
  [`openssl dgst -sha256 -r h.txt`, '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03 *h.txt\n'],
  [`openssl dgst -sha1 -c h.txt`, 'SHA1(h.txt)= f5:72:d3:96:fa:e9:20:66:28:71:4f:b2:ce:00:f7:2e:94:f2:25:8f\n'],
  [`openssl md5 h.txt`, 'MD5(h.txt)= b1946ac92492d2347c6235b4d2611184\n'],
  [`openssl sha256 h.txt`, 'SHA2-256(h.txt)= 5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03\n'],
  [`openssl dgst -sha256 -hmac key h.txt`, 'HMAC-SHA2-256(h.txt)= 8e384ff349a3d90f2c7837b0d76de8f81c6e85b390ed38905f521ae77cb9a29a\n'],
  [`printf 'The quick brown fox jumps over the lazy dog' | openssl dgst -sha256 -hmac key`, 'SHA2-256(stdin)= f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8\n'],
  [`openssl dgst -sha256 -out o.txt h.txt; cat o.txt`, 'SHA2-256(h.txt)= 5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03\n'],
  [`openssl dgst -sha256 h.txt h.txt | wc -l`, '2\n'],
]);

test('openssl: digest errors', async () => {
  let r = await run('openssl dgst -sha256 nonexist');
  assert.equal(r.code, 1);
  assert.match(r.err, /^nonexist: No such file or directory\n[0-9A-F]{16}:error:80000002:system library:file_ctrl:No such file or directory:\.\.\/crypto\/bio\/bss_file\.c:297:calling fopen\(nonexist, r\)\n/);
  r = await run('openssl dgst -bogus h.txt');
  assert.match(r.err, /^dgst: Unknown option or message digest: bogus\ndgst: Use -help for summary\.\n/);
  r = await run('openssl dgst -hmac');
  assert.equal(r.err, 'dgst: Option -hmac needs a value\ndgst: Use -help for summary.\n');
  r = await run('openssl foo');
  assert.deepEqual([r.out, r.err, r.code], ['', 'Invalid command \'foo\'; type "help" for a list.\n', 1]);
  assert.match((await run('openssl')).err, /^help:\n\nStandard commands\nasn1parse/);
  assert.match((await run('openssl dgst -help')).err, /^Usage: dgst \[options\] \[file\.\.\.\]/);
});

table('openssl: base64, enc, rand and version', [
  [`printf 'hello world, this is a longer line of text to force base64 wrapping at sixty four chars' | openssl base64`, 'aGVsbG8gd29ybGQsIHRoaXMgaXMgYSBsb25nZXIgbGluZSBvZiB0ZXh0IHRvIGZv\ncmNlIGJhc2U2NCB3cmFwcGluZyBhdCBzaXh0eSBmb3VyIGNoYXJz\n'],
  [`printf hello | openssl base64 -A`, 'aGVsbG8='],
  [`printf hello | openssl enc -base64`, 'aGVsbG8=\n'],
  [`echo aGVsbG8= | openssl base64 -d`, 'hello'],
  [`echo aGVsbG8= | openssl enc -d -base64`, 'hello'],
  [`echo 'aGVs bG8=' | openssl base64 -d`, 'hello'],
  [`echo '!!' | openssl base64 -d`, ''],
  [`openssl base64 -in h.txt`, 'aGVsbG8K\n'],
  [`openssl base64 -in h.txt -out h.b64; cat h.b64`, 'aGVsbG8K\n'],
  [`openssl rand -hex 8 | wc -c`, '17\n'],
  [`openssl rand -base64 6 | wc -c`, '9\n'],
  [`openssl rand -hex 4 -out r.txt; wc -c < r.txt`, '9\n'],
  [`openssl version`, 'OpenSSL 3.5.1 1 Jul 2025 (Library: OpenSSL 3.5.1 1 Jul 2025)\n'],
  [`openssl rand -hex abc`, '', 'rand: Can\'t parse "abc" as a number\nrand: Use -help for summary.\n', 1],
  [`openssl rand -hex 0`, '', 'rand: Use -help for summary.\n', 1],
  [`openssl rand -hex -5`, '', 'rand: Unknown option: -5\nrand: Use -help for summary.\n', 1],
  [`openssl base64 -in nonexist 2>&1 | head -1`, 'Can\'t open "nonexist" for reading, No such file or directory\n'],
]);

test('openssl: rand is seeded and man page exists', async () => {
  const a = await out('openssl rand -hex 16');
  assert.match(a, /^[0-9a-f]{32}\n$/);
  assert.notEqual(a, await out('openssl rand -hex 16'));
  assert.match(await out('man openssl'), /DESCRIPTION/);
});

/* ------------------------------------------------------- od, hexdump */
// od expectations were taken from GNU od 9.4 on the same input.
const ODIN = `printf 'hello world\\n1 apple\\n'`;
table('od: formats compared with GNU od', [
  [`printf 'hello world\\n' | od`, '0000000 062550 066154 020157 067567 066162 005144\n0000014\n'],
  [`printf 'a\\tb\\n' | od -c`, '0000000   a  \\t   b  \\n\n0000004\n'],
  [`printf 'abcdefg' | od -An -tx1`, ' 61 62 63 64 65 66 67\n'],
  [`printf 'abcdefg' | od -t d4 -t x1`, '0000000  1684234849     6776421\n        61 62 63 64 65 66 67\n0000007\n'],
  [`printf 'ab\\n' | od -a -x`, '0000000   a   b  nl\n           6261    000a\n0000003\n'],
  [`printf 'abcdefg' | od -Ax -j2 -N3 -c`, '000002   c   d   e\n000005\n'],
  [`printf 'abcd' | od --endian=big -tx2`, '0000000 6162 6364\n0000004\n'],
  [`printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' | od -c`, '0000000   a   a   a   a   a   a   a   a   a   a   a   a   a   a   a   a\n*\n0000040   a   a   a   a   a   a   a   a   a   a   a   a   a\n0000055\n'],
  [`printf 'abcd' | od -tx1z -w2`, '0000000 61 62  >ab<\n0000002 63 64  >cd<\n0000004\n'],
  [`printf '\\x00\\x00\\x00?' | od -f`, '0000000             0.5\n0000004\n'],
]);

table('od: errors', [
  [`od -A z h.txt`, '', "od: invalid output address radix 'z'; it must be one character from [doxn]\n", 1],
  [`od -t q h.txt`, '', "od: invalid character 'q' in type string ‘q’\n", 1],
  [`od -j 99 h.txt`, '', 'od: cannot skip past end of combined input\n', 1],
  [`od nofile`, '', 'od: nofile: No such file or directory\n', 1],
  [`od -Z`, '', "od: invalid option -- 'Z'\nTry 'od --help' for more information.\n", 1],
]);

table('hexdump: default, canonical and byte formats', [
  [`printf 'hello\\n' | hexdump`, '0000000 6568 6c6c 0a6f\n0000006\n'],
  [`printf 'hello world, this is hexdump\\n' | hexdump -C`, '00000000  68 65 6c 6c 6f 20 77 6f  72 6c 64 2c 20 74 68 69  |hello world, thi|\n00000010  73 20 69 73 20 68 65 78  64 75 6d 70 0a           |s is hexdump.|\n0000001d\n'],
  [`printf 'abcdefghijklmnopabcdefghijklmnopabcdefghijklmnopxyz' | hexdump -C`, '00000000  61 62 63 64 65 66 67 68  69 6a 6b 6c 6d 6e 6f 70  |abcdefghijklmnop|\n*\n00000030  78 79 7a                                          |xyz|\n00000033\n'],
  [`printf 'abc' | hexdump -bc`, '0000000 141 142 143\n          a   b   c\n0000003\n'],
  [`printf 'abcdefghijklmnop' | hexdump -d`, '0000000 25185 25699 26213 26727 27241 27755 28269 28783\n0000010\n'],
  [`printf 'abcdef' | hexdump -n 2 -s 3 -C`, '00000003  64 65                                             |de|\n00000005\n'],
  [`hexdump -Z`, '', "hexdump: invalid option -- 'Z'\nTry 'hexdump --help' for more information.\n", 1],
  [`printf 'abc' | hexdump -C | head -1 | wc -l`, '1\n'],
]);
