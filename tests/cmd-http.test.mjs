// HTTP pack: curl, wget, python3 (-c and -m http.server), whatweb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

/** Run a line on the real clock; `during` runs after a moment, then Ctrl-C is pressed. */
async function interrupted(sim, line, during, afterMs = 40) {
  const { K, shell, term } = sim;
  K.clock.useReal(); K.settings.timeScale = 1;
  term.take();
  const pending = shell.runLine(line);
  setTimeout(() => { if (during) during(); term.raiseInterrupt(); }, afterMs);
  const code = await pending;
  return { code, output: K.util.stripAnsi(term.take()) };
}

/* ------------------------------------------------------------------- curl */

test('curl: body goes to stdout, the progress meter to stderr', async () => {
  const sim = await boot();
  const r = await sim.run('curl http://web01.halcyon.lab/robots.txt');
  assert.equal(r.code, 0);
  assert.match(r.out, /^User-agent: \*\nDisallow: \/staff\/\n/);
  assert.match(r.err, /^ {2}% Total {4}% Received % Xferd {2}Average Speed/);
  assert.match(r.err, /\r100 +\d+ +100 +\d+ +0 +0 /);
});

test('curl -s: silent, and -sS shows errors', async () => {
  const sim = await boot();
  const ok = await sim.run('curl -s http://web01.halcyon.lab/robots.txt');
  assert.equal(ok.err, '');
  const bad = await sim.run('curl -s http://nonexistent.invalid');
  assert.deepEqual([bad.err, bad.code], ['', 6]);
  const shown = await sim.run('curl -sS http://nonexistent.invalid');
  assert.deepEqual([shown.err, shown.code], ['curl: (6) Could not resolve host: nonexistent.invalid\n', 6]);
});

test('curl -I: HEAD request, status line and headers with CRLF', async () => {
  const sim = await boot();
  const r = await sim.run('curl -I http://web01.halcyon.lab');
  assert.equal(r.code, 0);
  assert.match(r.out, /^HTTP\/1\.1 200 OK\r\nServer: nginx\/[\d.]+\r\nDate: .* GMT\r\n/);
  assert.match(r.out, /\r\n\r\n$/);
  assert.match(r.out, /ETag: "/);
  assert.doesNotMatch(r.out, /<html/i);
});

test('curl -i: headers then body', async () => {
  const sim = await boot();
  const r = await sim.run('curl -si http://web01.halcyon.lab/robots.txt');
  assert.match(r.out, /^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\nUser-agent: \*/);
});

test('curl -v: connection notes, > request and < response lines on stderr', async () => {
  const sim = await boot();
  const r = await sim.run('curl -sv http://web01.halcyon.lab/robots.txt -o /dev/null');
  const lines = r.err.split('\n');
  assert.equal(lines[0], '* Host web01.halcyon.lab:80 was resolved.');
  assert.equal(lines[1], '* IPv6: (none)');
  assert.equal(lines[2], '* IPv4: 10.10.10.10');
  assert.equal(lines[3], '*   Trying 10.10.10.10:80...');
  assert.equal(lines[4], '* Connected to web01.halcyon.lab (10.10.10.10) port 80');
  assert.ok(r.err.includes('> GET /robots.txt HTTP/1.1\r\n> Host: web01.halcyon.lab\r\n> User-Agent: curl/'));
  assert.ok(r.err.includes('> Accept: */*\r\n> \r\n'));
  assert.match(r.err, /< HTTP\/1\.1 200 OK\r\n< Server: nginx/);
  assert.match(r.err, /\* Connection #0 to host web01\.halcyon\.lab left intact\n$/);
});

test('curl -v: a literal IP skips the resolver notes', async () => {
  const sim = await boot();
  const r = await sim.run('curl -sv http://10.10.10.10/ -o /dev/null');
  assert.match(r.err, /^\*   Trying 10\.10\.10\.10:80\.\.\.\n\* Connected to 10\.10\.10\.10 \(10\.10\.10\.10\) port 80\n/);
});

test('curl: https to a lab host fails with 60 unless -k is given', async () => {
  const sim = await boot();
  const r = await sim.run('curl -s https://web01.halcyon.lab/');
  assert.equal(r.code, 60);
  assert.equal(r.out, '');
  const loud = await sim.run('curl https://web01.halcyon.lab/');
  assert.match(loud.err, /^curl: \(60\) SSL certificate problem: self-signed certificate\nMore details here: https:\/\/curl\.se\/docs\/sslcerts\.html\n/);
  const k = await sim.run('curl -sk https://web01.halcyon.lab/robots.txt');
  assert.equal(k.code, 0);
  assert.match(k.out, /^User-agent/);
});

test('curl -vk: TLS handshake lines and the certificate', async () => {
  const sim = await boot();
  const r = await sim.run('curl -vk https://web01.halcyon.lab/ -o /dev/null');
  assert.match(r.err, /\* TLSv1\.3 \(OUT\), TLS handshake, Client hello \(1\):/);
  assert.match(r.err, /\* SSL connection using TLSv1\.3 \/ TLS_AES_256_GCM_SHA384/);
  assert.match(r.err, /\* Server certificate:\n\*  subject: CN=/);
  assert.match(r.err, /SSL certificate verify result: self-signed certificate \(18\), continuing anyway\./);
});

test('curl: the public internet verifies fine', async () => {
  const sim = await boot();
  const r = await sim.run('curl -s https://www.kali.org/');
  assert.equal(r.code, 0);
  assert.match(r.out, /Kali Linux/);
});

test('curl -w: write-out variables', async () => {
  const sim = await boot();
  const r = await sim.run('curl -s -o /dev/null -w "%{http_code} %{size_download} %{remote_ip} %{url_effective}\\n" http://web01.halcyon.lab/robots.txt');
  assert.match(r.out, /^200 51 10\.10\.10\.10 http:\/\/web01\.halcyon\.lab\/robots\.txt\n$/);
  const t = await sim.run('curl -s -o /dev/null -w "%{time_total}|%%|%{num_redirects}" http://web01.halcyon.lab/');
  assert.match(t.out, /^\d+\.\d{6}\|%\|0$/);
});

test('curl -f: HTTP errors exit 22', async () => {
  const sim = await boot();
  const r = await sim.run('curl -sSf http://web01.halcyon.lab/nope');
  assert.equal(r.code, 22);
  assert.equal(r.out, '');
  assert.equal(r.err, 'curl: (22) The requested URL returned error: 404\n');
  const plain = await sim.run('curl -s http://web01.halcyon.lab/nope');
  assert.equal(plain.code, 0);
  assert.match(plain.out, /404 Not Found/);
});

test('curl: connection refused exits 7, unknown host exits 6', async () => {
  const sim = await boot();
  const r = await sim.run('curl -sS http://10.10.10.10:81/');
  assert.equal(r.code, 7);
  assert.match(r.err, /^curl: \(7\) Failed to connect to 10\.10\.10\.10 port 81 after \d+ ms: Couldn't connect to server\n$/);
  const d = await sim.run('curl http://nonexistent.invalid/');
  assert.equal(d.code, 6);
  assert.match(d.err, /curl: \(6\) Could not resolve host: nonexistent\.invalid/);
});

test('curl: filtered ports time out, with -m and --connect-timeout', async () => {
  const sim = await boot();
  const m = await sim.run('curl -sS -m 3 http://10.10.10.90/');
  assert.equal(m.code, 28);
  assert.match(m.err, /curl: \(28\) Connection timed out after 300\d milliseconds/);
  const c = await sim.run('curl -sS --connect-timeout 2 http://10.10.10.90/');
  assert.equal(c.code, 28);
  assert.match(c.err, /curl: \(28\) Failed to connect to 10\.10\.10\.90 port 80 after 200\d ms: Timeout was reached/);
  const long = await sim.run('curl -sS http://10.10.10.90/');
  assert.equal(long.code, 7);
});

test('curl: -L follows redirects, --max-redirs limits them', async () => {
  const sim = await boot();
  const plain = await sim.run('curl -s http://http.kali.org/');
  assert.equal(plain.out, '');
  const r = await sim.run('curl -sL http://http.kali.org/');
  assert.match(r.out, /Kali Linux/);
  const limited = await sim.run('curl -sSL --max-redirs 0 http://http.kali.org/');
  assert.equal(limited.code, 47);
  assert.equal(limited.err, 'curl: (47) Maximum (0) redirects followed\n');
  const w = await sim.run('curl -sL -o /dev/null -w "%{num_redirects} %{url_effective}" http://http.kali.org/');
  assert.equal(w.out, '1 https://www.kali.org/');
});

test('curl -L -i prints the headers of every hop', async () => {
  const sim = await boot();
  const r = await sim.run('curl -sLi http://http.kali.org/');
  assert.equal((r.out.match(/^HTTP\/1\.1 /gm) || []).length, 2);
  assert.match(r.out, /^HTTP\/1\.1 302 Found\r\n/);
  assert.match(r.out, /Location: https:\/\/www\.kali\.org\/\r\n/);
});

test('curl: -d posts a form, --data-urlencode encodes, -G moves data to the query', async () => {
  const sim = await boot();
  const seen = [];
  sim.K.net.bus.on('http', (e) => seen.push(e.request));
  await sim.run('curl -s -d "user=student&pass=s3" --data-urlencode "note=a b&c" http://web01.halcyon.lab/login');
  const post = seen.pop();
  assert.equal(post.method, 'POST');
  assert.equal(post.body, 'user=student&pass=s3&note=a%20b%26c');
  assert.equal(post.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(post.headers['content-length'], String(post.body.length));
  await sim.run('curl -s -G -d "q=1" http://web01.halcyon.lab/search');
  const get = seen.pop();
  assert.equal(get.method, 'GET');
  assert.equal(get.query, 'q=1');
});

test('curl: -d @file and -X, -H, -A, -e, -u', async () => {
  const sim = await boot();
  await sim.run('echo "a=1" > /tmp/body.txt');
  const seen = [];
  sim.K.net.bus.on('http', (e) => seen.push(e.request));
  await sim.run('curl -s -X PUT -d @/tmp/body.txt -H "X-Token: abc" -H "Accept: text/plain" -A "kalima/1" -e http://ref.example/ -u student:secret http://web01.halcyon.lab/x');
  const q = seen.pop();
  assert.equal(q.method, 'PUT');
  assert.equal(q.body, 'a=1');
  assert.equal(q.headers['x-token'], 'abc');
  assert.equal(q.headers.accept, 'text/plain');
  assert.equal(q.headers['user-agent'], 'kalima/1');
  assert.equal(q.headers.referer, 'http://ref.example/');
  assert.equal(q.headers.authorization, 'Basic c3R1ZGVudDpzZWNyZXQ=');
});

test('curl --resolve pins the address and keeps the Host header', async () => {
  const sim = await boot();
  const r = await sim.run('curl -sv --resolve intranet.example:80:10.10.10.10 http://intranet.example/ -o /dev/null');
  assert.match(r.err, /^\* Added intranet\.example:80:10\.10\.10\.10 to DNS cache\n\* Hostname intranet\.example was found in DNS cache\n\*   Trying 10\.10\.10\.10:80/);
  assert.match(r.err, /> Host: intranet\.example\r\n/);
});

test('curl -o saves a file; -O names it after the URL; the meter is shown', async () => {
  const sim = await boot();
  const r = await sim.run('cd /tmp && curl -o page.txt http://web01.halcyon.lab/robots.txt && curl -O http://web01.halcyon.lab/robots.txt');
  assert.match(r.err, /% Total/);
  assert.equal(r.out, '');
  assert.match((await sim.run('cat /tmp/page.txt')).out, /^User-agent/);
  assert.equal((await sim.run('cat /tmp/robots.txt')).out, (await sim.run('cat /tmp/page.txt')).out);
  const bad = await sim.run('curl -sS -o /nonexistent/x http://web01.halcyon.lab/robots.txt');
  assert.equal(bad.code, 23);
  const noName = await sim.run('curl -sS -O http://web01.halcyon.lab/');
  assert.equal(noName.code, 23);
  assert.match(noName.err, /Remote file name has no length!/);
});

test('curl: usage errors', async () => {
  const sim = await boot();
  const none = await sim.run('curl');
  assert.deepEqual([none.err, none.code], ["curl: try 'curl --help' or 'curl --manual' for more information\n", 2]);
  const unk = await sim.run('curl --bogus http://x/');
  assert.equal(unk.code, 2);
  assert.match(unk.err, /^curl: option --bogus: is unknown\ncurl: try 'curl --help'/);
  const short = await sim.run('curl -Z http://x/');
  assert.match(short.err, /^curl: option -Z: is unknown\n/);
  const arg = await sim.run('curl -o');
  assert.match(arg.err, /^curl: option -o: requires parameter\n/);
  assert.match((await sim.run('curl --version')).out, /^curl \d+\.\d+\.\d+ \(x86_64-pc-linux-gnu\) libcurl\/.*\nRelease-Date: /);
  assert.match((await sim.run('curl --help')).out, /^Usage: curl \[options\.\.\.\] <url>\n/);
  const ftp = await sim.run('curl -sS ftp://x/');
  assert.equal(ftp.code, 1);
});

test('curl: works in a pipeline', async () => {
  const sim = await boot();
  const r = await sim.run('curl -s http://web01.halcyon.lab/robots.txt | grep -c Disallow');
  assert.equal(r.out, '2\n');
  const h = await sim.run('curl -sI http://web01.halcyon.lab | head -n 1');
  assert.equal(h.out, 'HTTP/1.1 200 OK\r\n');
  const stdin = await sim.run('echo "k=v" | curl -s -d @- http://web01.halcyon.lab/');
  assert.equal(stdin.code, 0);
});

test('curl: 401 from the camera shows the challenge', async () => {
  const sim = await boot();
  const r = await sim.run('curl -sI http://cam01.halcyon.lab/');
  assert.match(r.out, /^HTTP\/1\.1 401 Unauthorized\r\n/);
  assert.match(r.out, /WWW-Authenticate: Basic realm="IP Camera"\r\n/);
});

/* ------------------------------------------------------------------- wget */

test('wget: downloads a file with the GNU Wget 1.25 transcript', async () => {
  const sim = await boot();
  const r = await sim.run('cd /tmp && wget http://web01.halcyon.lab/robots.txt');
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  const lines = r.err.split('\n');
  assert.match(lines[0], /^--\d{4}-\d\d-\d\d \d\d:\d\d:\d\d--  http:\/\/web01\.halcyon\.lab\/robots\.txt$/);
  assert.equal(lines[1], 'Resolving web01.halcyon.lab (web01.halcyon.lab)... 10.10.10.10');
  assert.equal(lines[2], 'Connecting to web01.halcyon.lab (web01.halcyon.lab)|10.10.10.10|:80... connected.');
  assert.equal(lines[3], 'HTTP request sent, awaiting response... 200 OK');
  assert.equal(lines[4], 'Length: 51 [text/plain]');
  assert.equal(lines[5], 'Saving to: ‘robots.txt’');
  assert.match(lines[7], /^ {5}0K \. {53,54}100% +\d+(\.\d+)?[KMG]=0s$/);
  assert.match(lines[9], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \([\d.]+ [KM]B\/s\) - ‘robots\.txt’ saved \[51\/51\]$/);
  assert.match((await sim.run('cat /tmp/robots.txt')).out, /^User-agent/);
});

test('wget: a second download does not overwrite, -nc skips', async () => {
  const sim = await boot();
  await sim.run('cd /tmp && wget -q http://web01.halcyon.lab/robots.txt && wget -q http://web01.halcyon.lab/robots.txt');
  assert.equal((await sim.run('ls /tmp')).out.includes('robots.txt.1'), true);
  const nc = await sim.run('cd /tmp && wget -nc http://web01.halcyon.lab/robots.txt');
  assert.match(nc.err, /File ‘robots\.txt’ already there; not retrieving\./);
});

test('wget -O - writes to stdout, -q is quiet, -nv prints one line', async () => {
  const sim = await boot();
  const r = await sim.run('wget -q -O - http://web01.halcyon.lab/robots.txt | head -n 1');
  assert.equal(r.out, 'User-agent: *\n');
  assert.equal(r.err, '');
  const nv = await sim.run('cd /tmp && wget -nv http://web01.halcyon.lab/robots.txt');
  assert.match(nv.err, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d URL:http:\/\/web01\.halcyon\.lab\/robots\.txt \[51\/51\] -> "robots\.txt" \[1\]\n$/);
});

test('wget -P saves into a directory; the index page is called index.html', async () => {
  const sim = await boot();
  await sim.run('wget -q -P /tmp/dl http://web01.halcyon.lab/');
  assert.match((await sim.run('cat /tmp/dl/index.html')).out, /<html/i);
});

test('wget: errors and exit codes', async () => {
  const sim = await boot();
  const nf = await sim.run('wget http://web01.halcyon.lab/nope');
  assert.equal(nf.code, 8);
  assert.match(nf.err, /awaiting response\.\.\. 404 Not Found\n.* ERROR 404: Not Found\.\n$/);
  const dns = await sim.run('wget http://nonexistent.invalid/');
  assert.equal(dns.code, 4);
  assert.match(dns.err, /Resolving nonexistent\.invalid \(nonexistent\.invalid\)\.\.\. failed: Name or service not known\.\nwget: unable to resolve host address ‘nonexistent\.invalid’\n$/);
  const refused = await sim.run('wget http://10.10.10.10:81/');
  assert.equal(refused.code, 4);
  assert.match(refused.err, /Connecting to 10\.10\.10\.10:81\.\.\. failed: Connection refused\.\n$/);
  const auth = await sim.run('wget -O /dev/null http://cam01.halcyon.lab/');
  assert.equal(auth.code, 6);
  assert.match(auth.err, /401 Unauthorized\n\nUsername\/Password Authentication Failed\.\n$/);
  const none = await sim.run('wget');
  assert.deepEqual([none.code, none.err.split('\n')[0]], [1, 'wget: missing URL']);
  const bad = await sim.run('wget --bogus x');
  assert.equal(bad.code, 2);
});

test('wget: https to a lab host needs --no-check-certificate', async () => {
  const sim = await boot();
  const r = await sim.run('wget -O /dev/null https://web01.halcyon.lab/');
  assert.equal(r.code, 5);
  assert.match(r.err, /ERROR: The certificate of ‘web01\.halcyon\.lab’ is not trusted\.\nERROR: The certificate of ‘web01\.halcyon\.lab’ doesn't have a known issuer\.\n$/);
  const ok = await sim.run('wget --no-check-certificate -q -O - https://web01.halcyon.lab/robots.txt');
  assert.equal(ok.code, 0);
  assert.match(ok.out, /^User-agent/);
});

test('wget: follows redirects and says so', async () => {
  const sim = await boot();
  const r = await sim.run('wget -O /dev/null http://http.kali.org/');
  assert.match(r.err, /awaiting response\.\.\. 302 Found\nLocation: https:\/\/www\.kali\.org\/ \[following\]\n--.*--  https:\/\/www\.kali\.org\/\nResolving www\.kali\.org/);
  assert.equal(r.code, 0);
});

test('wget -S --spider: headers and the existence verdict, nothing saved', async () => {
  const sim = await boot();
  const r = await sim.run('cd /tmp && wget -S --spider http://web01.halcyon.lab/robots.txt');
  assert.equal(r.code, 0);
  assert.match(r.err, /^Spider mode enabled\. Check if remote file exists\.\n--/);
  assert.match(r.err, /awaiting response\.\.\. \n {2}HTTP\/1\.1 200 OK\n {2}Server: nginx/);
  assert.match(r.err, /Length: 51 \[text\/plain\]\nRemote file exists\.\n/);
  assert.equal((await sim.run('ls /tmp')).out.includes('robots.txt'), false);
  const nf = await sim.run('wget --spider http://web01.halcyon.lab/nope');
  assert.equal(nf.code, 8);
  assert.match(nf.err, /Remote file does not exist -- broken link!!!\n$/);
});

test('wget --version and --help', async () => {
  const sim = await boot();
  assert.match((await sim.run('wget --version')).out, /^GNU Wget 1\.25\.0 built on linux-gnu\./);
  assert.match((await sim.run('wget -h')).out, /^GNU Wget 1\.25\.0, a non-interactive network retriever\.\nUsage: wget \[OPTION\]\.\.\. \[URL\]\.\.\./);
});

/* ---------------------------------------------------------------- python3 */

test('python3: --version, -V and the python alias', async () => {
  const sim = await boot();
  assert.match((await sim.run('python3 --version')).out, /^Python 3\.\d+\.\d+\n$/);
  assert.match((await sim.run('python3 -V')).out, /^Python 3\./);
  assert.match((await sim.run('python -V')).out, /^Python 3\./);
});

test('python3 -c: print of arithmetic and strings', async () => {
  const sim = await boot();
  const run = async (code) => (await sim.run("python3 -c '" + code + "'")).out;
  assert.equal(await run('print(2+3*4)'), '14\n');
  assert.equal(await run('print(7/2, 7//2, 7%3, 2**10)'), '3.5 3 1 1024\n');
  assert.equal(await run('print("ab"*3 + "!")'), 'ababab!\n');
  assert.equal(await run('print(6/2)'), '3.0\n');
  assert.equal(await run('print(0.1+0.2)'), '0.30000000000000004\n');
  assert.equal(await run('print(2**100)'), '1267650600228229401496703205376\n');
  assert.equal(await run('print(1, 2, 3, sep="-", end="!\\n")'), '1-2-3!\n');
  assert.equal(await run('print(len("kalima")); print("x".upper())'), '6\nX\n');
  assert.equal(await run('print([1, 2] + [3], (1,), "a" "b")'), '[1, 2, 3] (1,) ab\n');
  assert.equal(await run('print(-7 // 2, -7 % 3, round(2.5), abs(-3), int("12") + 1)'), '-4 2 2 3 13\n');
  assert.equal(await run('print(1e20, 1/3)'), '1e+20 0.3333333333333333\n');
});

test('python3 -c: real-looking errors', async () => {
  const sim = await boot();
  const z = await sim.run('python3 -c "print(1/0)"');
  assert.equal(z.code, 1);
  assert.equal(z.err, 'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\nZeroDivisionError: division by zero\n');
  const t = await sim.run('python3 -c "print(\'a\' + 1)"');
  assert.match(t.err, /TypeError: can only concatenate str \(not "int"\) to str\n$/);
  const n = await sim.run('python3 -c "print(foo)"');
  assert.match(n.err, /NameError: name 'foo' is not defined\n$/);
  const s = await sim.run('python3 -c "print(1 +)"');
  assert.match(s.err, /SyntaxError: invalid syntax\n$/);
});

test('python3: everything else says honestly that it is not simulated', async () => {
  const sim = await boot();
  for (const line of ['python3 -c "import os"', 'python3 -c "x = 1"', 'python3 script.py', 'python3 -m venv env', 'python3']) {
    const r = await sim.run(line);
    assert.equal(r.code, 1, line);
    assert.match(r.err, /not simulated/, line);
  }
  const mod = await sim.run('python3 -m SimpleHTTPServer');
  assert.equal(mod.err, '/usr/bin/python3: No module named SimpleHTTPServer\n');
  assert.equal((await sim.run('python3 -Z')).code, 2);
});

test('python3 -m http.server: banner, request logs, listing, files, 404, Ctrl-C', async () => {
  const sim = await boot();
  const { K, machine } = sim;
  await sim.run('mkdir -p /tmp/www/sub && echo hello > /tmp/www/a.txt && echo "<b>x</b>" > "/tmp/www/we ird&.html"');
  const answers = [];
  const get = (path, method) => {
    const r = K.net.http(machine, { method: method || 'GET', url: 'http://127.0.0.1:8123' + path, headers: {} });
    answers.push(r);
    return r;
  };
  const r = await interrupted(sim, 'python3 -m http.server 8123 -d /tmp/www', () => {
    get('/'); get('/a.txt'); get('/nope'); get('/sub'); get('/a.txt', 'HEAD'); get('/a.txt', 'POST');
  }, 80);
  assert.equal(r.code, 0);
  const lines = r.output.split('\n');
  assert.equal(lines[0], 'Serving HTTP on 0.0.0.0 port 8123 (http://0.0.0.0:8123/) ...');
  assert.match(lines[1], /^127\.0\.0\.1 - - \[\d\d\/Nov\/2026 \d\d:\d\d:\d\d\] "GET \/ HTTP\/1\.1" 200 -$/);
  assert.match(lines[2], /"GET \/a\.txt HTTP\/1\.1" 200 -$/);
  assert.match(lines[3], /"GET \/nope HTTP\/1\.1" 404 -$/);
  assert.match(lines[4], /"GET \/sub HTTP\/1\.1" 301 -$/);
  assert.match(lines[5], /"HEAD \/a\.txt HTTP\/1\.1" 200 -$/);
  assert.match(lines[6], /"POST \/a\.txt HTTP\/1\.1" 501 -$/);
  assert.match(r.output, /\nKeyboard interrupt received, exiting\.\n/);
  assert.equal(answers[0].status, 200);
  assert.equal(answers[0].body, '<!DOCTYPE HTML>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Directory listing for /</title>\n</head>\n<body>\n<h1>Directory listing for /</h1>\n<hr>\n<ul>\n<li><a href="a.txt">a.txt</a></li>\n<li><a href="sub/">sub/</a></li>\n<li><a href="we%20ird%26.html">we ird&amp;.html</a></li>\n</ul>\n<hr>\n</body>\n</html>\n');
  assert.equal(answers[1].body, 'hello\n');
  assert.match(answers[1].headers['content-type'], /^text\/plain/);
  assert.equal(answers[2].status, 404);
  assert.match(answers[2].body, /<p>Error code: 404<\/p>\n {8}<p>Message: File not found\.<\/p>\n {8}<p>Error code explanation: 404 - Nothing matches the given URI\.<\/p>/);
  assert.equal(answers[3].status, 301);
  assert.equal(answers[3].headers.location, '/sub/');
  assert.equal(answers[4].body, '');
  assert.equal(answers[5].status, 501);
  assert.equal(machine.listeners.length, 0, 'the listener is removed on exit');
});

test('python3 -m http.server: --bind, a busy port, a privileged port, bad arguments', async () => {
  const sim = await boot();
  const r = await interrupted(sim, 'python3 -m http.server 9001 --bind 127.0.0.1');
  assert.match(r.output, /^Serving HTTP on 127\.0\.0\.1 port 9001 \(http:\/\/127\.0\.0\.1:9001\/\) \.\.\.\n/);
  const sim2 = await boot();
  const priv = await sim2.run('python3 -m http.server 80');
  assert.equal(priv.code, 1);
  assert.match(priv.err, /PermissionError: \[Errno 13\] Permission denied\n$/);
  sim2.K.net.listen(sim2.machine, { port: 5000, prog: 'nc' });
  const busy = await sim2.run('python3 -m http.server 5000');
  assert.match(busy.err, /OSError: \[Errno 98\] Address already in use\n$/);
  const bad = await sim2.run('python3 -m http.server abc');
  assert.equal(bad.code, 2);
  assert.match(bad.err, /^usage: server\.py \[-h\].*\nserver\.py: error: argument port: invalid int value: 'abc'\n$/);
  assert.match((await sim2.run('python3 -m http.server --help')).out, /^usage: server\.py .*\n\npositional arguments:\n {2}port {18}bind to this port \(default: 8000\)\n/);
});

test('python3 -m http.server: other hosts and curl reach it, and the listener shows in ss', async () => {
  const sim = await boot();
  let body; let ss;
  await sim.run('mkdir -p /tmp/share && echo secret-plan > /tmp/share/plan.txt');
  const r = await interrupted(sim, 'cd /tmp/share && python3 -m http.server 8000', () => {
    body = sim.K.net.http(sim.machine, { method: 'GET', url: 'http://10.10.10.5:8000/plan.txt', headers: {} }).body;
    ss = sim.K.net.listening(sim.machine).filter((l) => l.port === 8000).length;
  }, 60);
  assert.equal(body, 'secret-plan\n');
  assert.equal(ss, 1);
  assert.match(r.output, /"GET \/plan\.txt HTTP\/1\.1" 200 -/);
});

/* --------------------------------------------------------------- whatweb */

test('whatweb: one bracketed summary line per target', async () => {
  const sim = await boot();
  const r = await sim.run('whatweb web01.halcyon.lab');
  assert.equal(r.code, 0);
  assert.match(r.out, /^http:\/\/web01\.halcyon\.lab \[200 OK\] Country\[RESERVED\]\[ZZ\], .*HTTPServer\[nginx\/[\d.]+\], IP\[10\.10\.10\.10\], nginx\[[\d.]+\], Title\[Halcyon Freight Intranet\]\n$/);
  const many = await sim.run('whatweb 10.10.10.80 10.10.10.60');
  const lines = many.out.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^http:\/\/10\.10\.10\.80 \[401 Unauthorized\] .*WWW-Authenticate\[IP Camera\]\[Basic\]/);
  assert.match(lines[1], /^http:\/\/10\.10\.10\.60 \[200 OK\] .*Title\[HP LaserJet M507 &nbsp; printer\.halcyon\.lab\]/);
});

test('whatweb: follows redirects, printing a line per hop', async () => {
  const sim = await boot();
  sim.K.settings.scopeGuard = false;
  const r = await sim.run('whatweb http.kali.org');
  const lines = r.out.trim().split('\n');
  assert.match(lines[0], /^http:\/\/http\.kali\.org \[302 Found\] .*RedirectLocation\[https:\/\/www\.kali\.org\/\]/);
  assert.match(lines[1], /^https:\/\/www\.kali\.org\/ \[200 OK\] .*Title\[Kali Linux/);
});

test('whatweb: the scope guard stops out-of-scope targets before any request', async () => {
  const sim = await boot();
  const seen = [];
  sim.K.net.bus.on('http', (e) => seen.push(e));
  const r = await sim.run('whatweb 8.8.8.8');
  assert.equal(r.code, 1);
  assert.match(r.err, /Out-of-scope target blocked: 8\.8\.8\.8/);
  assert.equal(r.out, '');
  assert.equal(seen.length, 0);
});

test('whatweb: errors, --version, --help, usage', async () => {
  const sim = await boot();
  const dead = await sim.run('whatweb 10.10.10.10:81');
  assert.equal(dead.code, 1);
  assert.match(dead.out, /^ERROR: Opening: http:\/\/10\.10\.10\.10:81\/ - Connection refused - connect\(2\) for "10\.10\.10\.10" port 81\n$/);
  const dns = await sim.run('whatweb nohost.halcyon.lab');
  assert.match(dns.out, /ERROR: Opening: http:\/\/nohost\.halcyon\.lab\/ - getaddrinfo: Name or service not known/);
  assert.match((await sim.run('whatweb --version')).out, /^WhatWeb version 0\.5\.5/);
  assert.match((await sim.run('whatweb --help')).out, /Usage: whatweb \[options\] <URLs>/);
  const none = await sim.run('whatweb');
  assert.equal(none.code, 1);
  assert.equal((await sim.run('whatweb -q web01.halcyon.lab')).out, '');
});

test('whatweb: shows in the web server log like any other request', async () => {
  const sim = await boot();
  const seen = [];
  sim.K.net.bus.on('http', (e) => seen.push(e.request));
  await sim.run('whatweb -U probe/1 web01.halcyon.lab');
  assert.equal(seen[0].headers['user-agent'], 'probe/1');
});

/* ------------------------------------------------------------ registration */

test('commands are registered with man pages', async () => {
  const sim = await boot();
  for (const n of ['curl', 'wget', 'python3', 'python', 'whatweb']) {
    const c = sim.K.cmd.get ? sim.K.cmd.get(n) : null;
    assert.ok(c || (await sim.run('command -v ' + n)).code === 0, n);
  }
  const man = await sim.run('man curl');
  assert.match(man.out, /DESCRIPTION/);
});
