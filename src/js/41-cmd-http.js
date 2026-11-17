/* HTTP clients and a file server: curl, wget, python3 (-c, -m http.server), whatweb.
 *
 * Every response comes from K.net.http(); this file parses arguments and prints
 * what the real tools print on Kali 2026.3. Nothing here touches a real network.
 */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;

  const CURL_VERSION = '8.18.0';
  const WGET_VERSION = '1.25.0';
  const PYTHON_VERSION = '3.13.9';
  const REDIRECTS = [301, 302, 303, 307, 308];

  /* ------------------------------------------------------------ shared helpers */
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function base64(s) {
    const b = U.toBytes(s); let out = '';
    for (let i = 0; i < b.length; i += 3) {
      const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
      out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
    }
    return out;
  }

  const percent = (s) => Array.from(U.toBytes(s)).map((c) => (/[A-Za-z0-9\-_.~]/.test(String.fromCharCode(c)) ? String.fromCharCode(c) : '%' + (c < 16 ? '0' : '') + c.toString(16).toUpperCase())).join('');
  const SPECIAL_HEADERS = { etag: 'ETag', 'www-authenticate': 'WWW-Authenticate', 'x-xss-protection': 'X-XSS-Protection', te: 'TE', dnt: 'DNT' };
  const titleCase = (n) => SPECIAL_HEADERS[n] || n.replace(/(^|-)([a-z])/g, (x, a, b) => a + b.toUpperCase());

  /** Split a URL. Returns null when it has no usable host. */
  function parseUrl(raw, defScheme) {
    let s = raw.replace(/#.*$/, '');
    let scheme = defScheme || 'http';
    const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(s);
    if (m) { scheme = m[1].toLowerCase(); s = m[2]; }
    const slash = s.search(/[\/?]/);
    let auth = slash < 0 ? s : s.slice(0, slash);
    let path = slash < 0 ? '/' : s.slice(slash);
    if (path[0] === '?') path = '/' + path;
    let user = null; let pass = null;
    const at = auth.lastIndexOf('@');
    if (at >= 0) { const ui = auth.slice(0, at); auth = auth.slice(at + 1); const c = ui.indexOf(':'); user = decodeURIComponent(c < 0 ? ui : ui.slice(0, c)); pass = c < 0 ? null : decodeURIComponent(ui.slice(c + 1)); }
    const pm = /^(.*?)(?::(\d*))?$/.exec(auth);
    const host = pm[1].toLowerCase();
    if (!host || /[\s<>"]/.test(host)) return null;
    const dflt = scheme === 'https' ? 443 : 80;
    const port = pm[2] ? parseInt(pm[2], 10) : dflt;
    return { scheme, host, port, path, user, pass, explicitPort: !!pm[2], hostport: host + (port !== dflt || pm[2] ? ':' + port : '') };
  }
  const urlString = (u) => u.scheme + '://' + u.hostport + u.path;

  /** Resolve a Location header against the URL it came from. */
  function joinUrl(base, loc) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(loc)) return loc;
    const origin = base.scheme + '://' + base.hostport;
    if (loc.startsWith('//')) return base.scheme + ':' + loc;
    if (loc[0] === '/') return origin + loc;
    const dir = base.path.replace(/[?].*$/, '').replace(/[^\/]*$/, '');
    return origin + dir + loc;
  }

  /** Response headers in the order real servers send them. */
  function headerList(resp) {
    const first = ['server', 'date', 'content-type', 'content-length'].filter((k) => resp.headers[k] != null);
    return first.concat(Object.keys(resp.headers).filter((k) => first.indexOf(k) < 0)).map((k) => [titleCase(k), resp.headers[k]]);
  }

  /** Are this host's certificates self-signed? True for every lab host. */
  function selfSigned(ip) {
    const h = K.net.hostAt(ip); const t = h && h.web && h.web.tls;
    if (t && t.selfSigned != null) return t.selfSigned;
    return K.net.inScope(ip);
  }
  function certOf(host, name) {
    return (host.web && host.web.tls) || { subject: 'CN=' + (host.fqdn || name), issuer: 'C=US, O=Simulated Trust Services, CN=SimTrust RSA CA 1', notBefore: 'Sep  1 00:00:00 2026 GMT', notAfter: 'Nov 30 23:59:59 2026 GMT', version: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384' };
  }

  /**
   * One HTTP exchange against K.net. `req` = {u (parsed url), method, headers, body}.
   * Returns {ip, dnsMs, resp} or {ip, dnsMs, fail: {kind: 'resolve'|'cert'|'net', code, message, cert}}.
   */
  function exchange(ctx, req, opts) {
    const u = req.u; let ip = null; let dnsMs = 0;
    const pinned = opts.resolve && opts.resolve[u.host + ':' + u.port];
    if (pinned) ip = pinned;
    else if (U.isIPv4(u.host)) ip = u.host;
    else {
      const r = K.net.resolve(ctx.machine, u.host);
      if (!r) return { ip: null, dnsMs: 0, fail: { kind: 'resolve' } };
      ip = r.ip; dnsMs = r.ms;
    }
    if (u.scheme === 'https' && opts.verify && selfSigned(ip)) {
      const t = K.net.tcp(ctx.machine, ip, u.port, { kind: 'http' });
      if (t.state === 'open' && t.service && t.service.tls) return { ip, dnsMs, rtt: t.rtt, fail: { kind: 'cert', cert: certOf(t.host, u.host) } };
    }
    const headers = Object.assign({ host: u.hostport }, req.headers);
    try {
      const resp = K.net.http(ctx.machine, { method: req.method, url: u.scheme + '://' + u.host + ':' + u.port + u.path, headers, body: req.body, ip });
      return { ip, dnsMs, resp };
    } catch (e) {
      if (!(e instanceof K.NetError)) throw e;
      return { ip, dnsMs, fail: { kind: 'net', code: e.code, message: e.message, tlsError: e.tlsError } };
    }
  }

  async function readFileOrFail(ctx, path) {
    try { return ctx.fs.read(path); } catch (e) { if (e instanceof K.FsError) return null; throw e; }
  }

  /* =================================================================== curl */
  const CURL_LONG = ['help', 'version', 'head', 'include', 'verbose', 'silent', 'show-error', 'output=', 'remote-name', 'location', 'max-redirs=', 'request=', 'header=', 'data=', 'data-raw=', 'data-binary=', 'data-ascii=', 'data-urlencode=', 'user-agent=', 'referer=', 'user=', 'insecure', 'max-time=', 'connect-timeout=', 'write-out=', 'fail', 'resolve=', 'get', 'cookie=', 'dump-header=', 'upload-file=', 'compressed', 'url=', 'http1.1', 'http1.0', 'ipv4', 'ipv6', 'no-keepalive', 'output-dir=', 'create-dirs', 'path-as-is', 'post301', 'post302', 'fail-with-body', 'no-progress-meter'];
  const CURL_ALIAS = { help: 'h', version: 'V', head: 'I', include: 'i', verbose: 'v', silent: 's', 'show-error': 'S', output: 'o', 'remote-name': 'O', location: 'L', request: 'X', header: 'H', data: 'd', 'data-ascii': 'd', 'user-agent': 'A', referer: 'e', user: 'u', insecure: 'k', 'max-time': 'm', 'write-out': 'w', fail: 'f', get: 'G', cookie: 'b', 'dump-header': 'D', 'upload-file': 'T', ipv4: '4', ipv6: '6' };

  const CURL_HELP = [
    'Usage: curl [options...] <url>',
    ' -d, --data <data>          HTTP POST data',
    ' -f, --fail                 Fail fast with no output on HTTP errors',
    ' -h, --help <subject>       Get help for commands',
    ' -i, --include              Include protocol response headers in the output',
    ' -o, --output <file>        Write to file instead of stdout',
    ' -O, --remote-name          Write output to a file named as the remote file',
    ' -s, --silent               Silent mode',
    ' -T, --upload-file <file>   Transfer local FILE to destination',
    ' -u, --user <user:password> Server user and password',
    ' -A, --user-agent <name>    Send User-Agent <name> to server',
    ' -v, --verbose              Make the operation more talkative',
    ' -V, --version              Show version number and quit',
    '',
    'This is not the full help; this menu is split into categories.',
    'Use "--help category" to get an overview of all categories, which are',
    'help for options in the category.',
    'For all options use the manual or "--help all".',
    '',
  ].join('\n');

  const CURL_VERSION_TEXT = [
    'curl ' + CURL_VERSION + ' (x86_64-pc-linux-gnu) libcurl/' + CURL_VERSION + ' OpenSSL/3.5.4 zlib/1.3.1 brotli/1.1.0 zstd/1.5.7 libidn2/2.3.8 libpsl/0.21.2 libssh2/1.11.1 nghttp2/1.64.0 OpenLDAP/2.6.10',
    'Release-Date: 2026-01-07, security patched: ' + CURL_VERSION + '-1',
    'Protocols: dict file ftp ftps gopher gophers http https imap imaps ipfs ipns ldap ldaps mqtt pop3 pop3s rtmp rtsp scp sftp smb smbs smtp smtps telnet tftp ws wss',
    'Features: alt-svc AsynchDNS brotli HSTS HTTP2 HTTPS-proxy IDN IPv6 Kerberos Largefile libz NTLM PSL SPNEGO SSL threadsafe TLS-SRP UnixSockets zstd',
    '',
  ].join('\n');

  const curlExtra = "curl: try 'curl --help' or 'curl --manual' for more information\n";

  /** curl's max5data: byte counts in at most five columns. */
  function max5(n) {
    if (n < 100000) return String(n);
    const k = Math.floor(n / 1024);
    if (k < 10000) return k + 'k';
    const m = n / 1048576;
    if (m < 100) return m.toFixed(1) + 'M';
    if (m < 10000) return Math.floor(m) + 'M';
    return Math.floor(m / 1024) + 'G';
  }
  const clock = (s) => (s < 1 ? '--:--:--' : Math.floor(s / 3600) + ':' + U.pad2(Math.floor(s / 60) % 60) + ':' + U.pad2(s % 60));

  function progressMeter(size, ms) {
    const speed = ms > 0 ? Math.floor(size / (ms / 1000)) : size;
    const secs = Math.floor(ms / 1000);
    const P = U.padStart;
    return '  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n' +
      '                                 Dload  Upload   Total   Spent    Left  Speed\n' +
      '\r' + P(0, 3) + P(0, 6) + P(0, 5) + P(0, 6) + P(0, 5) + P(0, 6) + P(0, 7) + P(0, 7) + ' --:--:-- --:--:-- --:--:--' + P(0, 6) +
      '\r' + P(100, 3) + P(max5(size), 6) + P(100, 5) + P(max5(size), 6) + P(0, 5) + P(0, 6) + P(max5(speed), 7) + P(0, 7) +
      P(clock(secs), 9) + P(clock(secs), 9) + ' --:--:--' + P(max5(speed), 6) + '\n';
  }

  /** Build the -d / --data-urlencode body. Returns null on an unreadable @file (after reporting it). */
  async function curlBody(ctx, g) {
    const parts = [];
    const fromFile = async (spec, strip) => {
      let text;
      if (spec === '-') text = ctx.stdin == null ? '' : ctx.stdin;
      else {
        text = await readFileOrFail(ctx, spec);
        if (text == null) { if (!g.opts.s || g.opts.S) ctx.eprintln('Warning: Couldn\'t read data from file "' + spec + '", this makes an empty POST.'); return ''; }
      }
      return strip ? text.replace(/[\r\n]/g, '') : text;
    };
    for (const d of g.all.d || []) parts.push(d[0] === '@' ? await fromFile(d.slice(1), true) : d);
    for (const d of g.all['data-raw'] || []) parts.push(d);
    for (const d of g.all['data-binary'] || []) parts.push(d[0] === '@' ? await fromFile(d.slice(1), false) : d);
    for (const d of g.all['data-urlencode'] || []) {
      const at = d.indexOf('@'); const eq = d.indexOf('=');
      if (eq >= 0 && (at < 0 || eq < at)) parts.push(d.slice(0, eq) ? d.slice(0, eq) + '=' + percent(d.slice(eq + 1)) : percent(d.slice(eq + 1)));
      else if (at >= 0) parts.push((at ? d.slice(0, at) + '=' : '') + percent(await fromFile(d.slice(at + 1), false)));
      else parts.push(percent(d));
    }
    return parts.length ? parts.join('&') : null;
  }

  /** Apply -H headers on top of the defaults, in curl's order. Returns [[name, value]]. */
  function curlHeaders(defaults, custom) {
    const list = defaults.slice();
    for (const h of custom) {
      const c = h.indexOf(':'); const sc = h.indexOf(';');
      const name = c >= 0 ? h.slice(0, c).trim() : sc >= 0 && sc === h.length - 1 ? h.slice(0, sc) : null;
      if (name == null) continue;
      const value = c >= 0 ? h.slice(c + 1).trim() : '';
      const i = list.findIndex((x) => x[0].toLowerCase() === name.toLowerCase());
      if (c >= 0 && !value) { if (i >= 0) list.splice(i, 1); continue; }
      if (c < 0) { list.push([name, '']); continue; }
      if (i >= 0) list[i] = [name, value]; else list.push([name, value]);
    }
    return list;
  }

  function writeOut(fmt, v, resp) {
    return fmt.replace(/\\([nrt\\])|%(%|\{([a-z_0-9]+)\}|header\{([^}]+)\})/g, (m, esc, pc, name, hdr) => {
      if (esc) return { n: '\n', r: '\r', t: '\t', '\\': '\\' }[esc];
      if (pc === '%') return '%';
      if (hdr) return (resp && resp.headers[hdr.toLowerCase()]) || '';
      return v[name] == null ? '' : String(v[name]);
    });
  }
  const secs = (ms) => (ms / 1000).toFixed(6);

  /** Report an exchange failure the way curl does; returns the exit code. */
  async function curlFail(ctx, o, u, f, ex, verbose, begin) {
    const say = (s) => { if (verbose) ctx.eprintln(s); };
    const report = (code, msg) => { if (!o.silent || o.showError) ctx.eprintln('curl: (' + code + ') ' + msg); return code; };
    const dest = (ex.ip || u.host) + ' port ' + u.port;
    if (f.kind === 'resolve') {
      await ctx.sleep(20);
      say('* Could not resolve host: ' + u.host); say('* shutting down connection #0');
      return report(6, 'Could not resolve host: ' + u.host);
    }
    if (f.kind === 'cert') {
      await ctx.sleep(Math.round(ex.rtt * 3));
      say('* TLSv1.3 (OUT), TLS alert, unknown CA (560):'); say('* SSL certificate problem: self-signed certificate'); say('* closing connection #0');
      if (!o.silent || o.showError) ctx.eprintln('curl: (60) SSL certificate problem: self-signed certificate\nMore details here: https://curl.se/docs/sslcerts.html\n\ncurl failed to verify the legitimacy of the server and therefore could not\nestablish a secure connection to it. To learn more about this situation and\nhow to fix it, please visit the web page mentioned above.');
      return 60;
    }
    if (f.tlsError) {
      await ctx.sleep(5);
      say('* TLS connect error: error:0A00010B:SSL routines::' + f.tlsError); say('* closing connection #0');
      return report(35, 'TLS connect error: error:0A00010B:SSL routines::' + f.tlsError);
    }
    let waited;
    if (f.code === 'ETIMEDOUT') {
      waited = o.maxTime ? o.maxTime * 1000 + 1 : o.connectTimeout ? o.connectTimeout * 1000 + 1 : 127000 + Math.floor(K.net.rand() * 300);
      await ctx.sleep(waited);
      say('* connect to ' + ex.ip + ' port ' + u.port + ' failed: Connection timed out'); say('* Failed to connect to ' + u.host + ' port ' + u.port + ' after ' + waited + ' ms: ' + (o.connectTimeout ? 'Timeout was reached' : "Couldn't connect to server"));
      if (o.maxTime && !o.connectTimeout) return report(28, 'Connection timed out after ' + waited + ' milliseconds');
      if (o.connectTimeout) return report(28, 'Failed to connect to ' + u.host + ' port ' + u.port + ' after ' + waited + ' ms: Timeout was reached');
      return report(7, 'Failed to connect to ' + u.host + ' port ' + u.port + ' after ' + waited + " ms: Couldn't connect to server");
    }
    waited = f.code === 'ECONNREFUSED' ? 0 : 1;
    await ctx.sleep(waited);
    say('* connect to ' + dest.replace(' port ', ' port ') + ' from ' + ctx.machine.ifaces[0].ip + ' port ' + (40000 + Math.floor(K.net.rand() * 20000)) + ' failed: ' + f.message);
    say('* Failed to connect to ' + u.host + ' port ' + u.port + ' after ' + waited + ' ms: ' + (f.code === 'ECONNREFUSED' ? "Couldn't connect to server" : f.message));
    say('* closing connection #0');
    return report(7, 'Failed to connect to ' + u.host + ' port ' + u.port + ' after ' + waited + ' ms: ' + (f.code === 'ECONNREFUSED' ? "Couldn't connect to server" : f.message));
  }

  /** Print the `* Host ... was resolved.` / `Trying` / TLS block of curl -v. */
  function curlConnectNotes(ctx, u, ex, pinned) {
    const e = (s) => ctx.eprintln(s);
    if (pinned) e('* Hostname ' + u.host + ' was found in DNS cache');
    else if (!U.isIPv4(u.host)) { e('* Host ' + u.host + ':' + u.port + ' was resolved.'); e('* IPv6: (none)'); e('* IPv4: ' + ex.ip); }
    e('*   Trying ' + ex.ip + ':' + u.port + '...');
    e('* Connected to ' + u.host + ' (' + ex.ip + ') port ' + u.port);
    const tls = ex.resp && ex.resp.tls;
    if (u.scheme !== 'https' || !tls) return;
    for (const l of ['* ALPN: curl offers h2,http/1.1', '* TLSv1.3 (OUT), TLS handshake, Client hello (1):', '* TLSv1.3 (IN), TLS handshake, Server hello (2):', '* TLSv1.3 (IN), TLS handshake, Encrypted Extensions (8):', '* TLSv1.3 (IN), TLS handshake, Certificate (11):', '* TLSv1.3 (IN), TLS handshake, CERT verify (15):', '* TLSv1.3 (IN), TLS handshake, Finished (20):', '* TLSv1.3 (OUT), TLS change cipher, Change cipher spec (1):', '* TLSv1.3 (OUT), TLS handshake, Finished (20):',
      '* SSL connection using ' + (tls.version || 'TLSv1.3') + ' / ' + (tls.cipher || 'TLS_AES_256_GCM_SHA384') + ' / x25519 / RSASSA-PSS', '* ALPN: server accepted http/1.1', '* Server certificate:', '*  subject: ' + tls.subject, '*  start date: ' + tls.notBefore, '*  expire date: ' + tls.notAfter, '*  issuer: ' + tls.issuer]) e(l);
    e(selfSigned(ex.ip) ? '*  SSL certificate verify result: self-signed certificate (18), continuing anyway.' : '*  SSL certificate verify ok.');
  }

  async function curlRun(ctx) {
    const fail = (msg, code) => { ctx.eprintln('curl: ' + msg); ctx.err(curlExtra); return code; };
    const g = K.getopt(ctx.args, { short: 'hVIivsSo:OLX:H:d:A:e:u:kfm:w:Gb:D:T:46gjNq#', long: CURL_LONG, alias: CURL_ALIAS });
    if (g.err) {
      const m = /^invalid option -- '(.)'/.exec(g.err); const l = /^unrecognized option '(.*)'/.exec(g.err);
      const rq = /^option requires an argument -- '(.)'/.exec(g.err); const lr = /^option '(--[^']+)' requires an argument/.exec(g.err);
      if (m) return fail('option -' + m[1] + ': is unknown', 2);
      if (l) return fail('option ' + l[1] + ': is unknown', 2);
      if (rq) return fail('option -' + rq[1] + ': requires parameter', 2);
      if (lr) return fail('option ' + lr[1] + ': requires parameter', 2);
      return fail(g.err, 2);
    }
    const x = g.opts;
    if (x.h) { ctx.out(CURL_HELP); return 0; }
    if (x.V) { ctx.out(CURL_VERSION_TEXT); return 0; }
    const urls = (g.all.url || []).concat(g.rest);
    if (!urls.length) { ctx.err(curlExtra); return 2; }
    const o = {
      silent: !!x.s, showError: !!x.S, verbose: !!x.v, head: !!x.I, include: !!x.i || !!x.I, fail: !!x.f, insecure: !!x.k,
      follow: !!x.L, maxRedirs: x['max-redirs'] != null ? parseInt(x['max-redirs'], 10) : 50,
      maxTime: x.m != null ? parseFloat(x.m) : 0, connectTimeout: x['connect-timeout'] != null ? parseFloat(x['connect-timeout']) : 0,
    };
    for (const [k, v] of [['m', 'max-time'], ['connect-timeout', 'connect-timeout']]) {
      const val = x[k] != null ? x[k] : x[v];
      if (val != null && !(parseFloat(val) >= 0)) return fail("option --" + v + ': expected a proper numerical parameter', 2);
    }
    const resolve = {};
    for (const r of g.all.resolve || []) { const m = /^\[?([^:\]]+)\]?:(\d+):(.+)$/.exec(r); if (m) resolve[m[1].toLowerCase() + ':' + m[2]] = m[3].split(',')[0]; }
    const body = await curlBody(ctx, g);
    const upload = x.T != null ? (x.T === '-' ? ctx.stdin || '' : await readFileOrFail(ctx, x.T)) : null;
    if (x.T != null && upload == null) { if (!o.silent || o.showError) ctx.eprintln('curl: (26) Failed to open/read local data from file/application'); return 26; }
    let user = x.u != null ? String(x.u) : null;
    if (user != null && user.indexOf(':') < 0) {
      const pw = await ctx.readLine("Enter host password for user '" + user + "':", { hidden: true });
      user += ':' + (pw == null ? '' : pw);
    }
    let code = 0; let outIndex = 0;
    const outs = g.all.o || []; const dumps = g.all.D || [];
    for (const raw of urls) {
      const r = await curlTransfer(ctx, o, { x, g, raw, resolve, body, upload, user, out: x.O ? null : outs[outIndex] != null ? outs[outIndex] : null, dump: dumps[0], toFile: !!x.O || outs[outIndex] != null });
      if (!x.O) outIndex++;
      if (r) code = r;
    }
    return code;
  }

  async function curlTransfer(ctx, o, t) {
    const { x, g } = t;
    const verbose = o.verbose;
    const eln = (s) => ctx.eprintln(s);
    const report = (c, msg) => { if (!o.silent || o.showError) eln('curl: (' + c + ') ' + msg); return c; };
    let u = parseUrl(t.raw);
    if (!u) return report(3, 'URL rejected: Bad hostname');
    if (u.scheme !== 'http' && u.scheme !== 'https') return report(1, 'Protocol "' + u.scheme + '" not supported');
    let method = x.X || (o.head ? 'HEAD' : t.upload != null ? 'PUT' : t.body != null && !x.G ? 'POST' : 'GET');
    let reqBody = t.upload != null ? t.upload : t.body != null && !x.G ? t.body : '';
    if (x.G && t.body != null) u = Object.assign({}, u, { path: u.path + (u.path.indexOf('?') >= 0 ? '&' : '?') + t.body });
    const info = { v: {}, status: 0, bytes: 0, headerBytes: 0, redirects: 0 };
    let fileName = t.out;
    if (x.O) {
      fileName = decodeURIComponent(u.path.replace(/[?].*$/, '').replace(/^.*\//, ''));
      if (!fileName) { if (!o.silent || o.showError) ctx.eprintln('curl: Remote file name has no length!'); return 23; }
      if (x['output-dir']) fileName = x['output-dir'].replace(/\/$/, '') + '/' + fileName;
    } else if (fileName != null && x['output-dir'] && fileName !== '-') fileName = x['output-dir'].replace(/\/$/, '') + '/' + fileName;
    if (fileName === '-') fileName = null;
    const toTerminal = fileName == null;
    let hdrDump = '';
    let ex; let resp; let lastCode = 0; let first = true; let prevHost = null;
    for (;;) {
      const defaults = [['Host', u.hostport], ['User-Agent', 'curl/' + CURL_VERSION], ['Accept', '*/*']];
      const credUser = t.user != null ? t.user : u.user != null ? u.user + ':' + (u.pass == null ? '' : u.pass) : null;
      if (credUser != null) defaults.splice(1, 0, ['Authorization', 'Basic ' + base64(credUser)]);
      if (x.A != null) defaults[defaults.findIndex((h) => h[0] === 'User-Agent')][1] = x.A;
      if (x.e != null) defaults.push(['Referer', String(x.e).replace(/;auto$/, '')]);
      if (x.b != null) {
        const ck = String(x.b).indexOf('=') >= 0 ? String(x.b) : ((await readFileOrFail(ctx, x.b)) || '').trim();
        if (ck) defaults.push(['Cookie', ck]);
      }
      if (x.compressed) defaults.push(['Accept-Encoding', 'deflate, gzip, br, zstd']);
      if (reqBody !== '' || method === 'POST' || method === 'PUT') {
        if (method !== 'GET' || t.body != null) defaults.push(['Content-Length', String(U.byteLen(reqBody))]);
        if (t.body != null && !x.G && t.upload == null) defaults.push(['Content-Type', 'application/x-www-form-urlencoded']);
      }
      const hdrs = curlHeaders(defaults, g.all.H || []);
      const headerObj = {}; for (const h of hdrs) headerObj[h[0].toLowerCase()] = h[1];
      const pinKey = u.host + ':' + u.port;
      if (verbose && t.resolve[pinKey] && first) eln('* Added ' + pinKey + ':' + t.resolve[pinKey] + ' to DNS cache');
      ex = exchange(ctx, { u, method, headers: headerObj, body: reqBody }, { verify: !o.insecure, resolve: t.resolve });
      if (ex.fail) { lastCode = await curlFail(ctx, o, u, ex.fail, ex, verbose); resp = null; break; }
      resp = ex.resp;
      await ctx.sleep(resp.ms);
      if (verbose) {
        const reuse = prevHost === u.scheme + '://' + u.hostport;
        if (reuse) eln('* Re-using existing ' + u.scheme + ': connection with host ' + u.host);
        else curlConnectNotes(ctx, u, ex, !!t.resolve[pinKey]);
        eln('* using HTTP/1.x');
        eln('> ' + method + ' ' + u.path + ' HTTP/1.1\r');
        for (const h of hdrs) eln('> ' + h[0] + ': ' + h[1] + '\r');
        eln('> \r');
        if (reqBody) eln('} [' + U.byteLen(reqBody) + ' bytes data]');
        eln('< HTTP/1.1 ' + resp.status + ' ' + resp.statusText + '\r');
        for (const h of headerList(resp)) eln('< ' + h[0] + ': ' + h[1] + '\r');
        eln('< \r');
      }
      const head = 'HTTP/1.1 ' + resp.status + ' ' + resp.statusText + '\r\n' + headerList(resp).map((h) => h[0] + ': ' + h[1] + '\r\n').join('') + '\r\n';
      info.headerBytes = head.length;
      hdrDump += head;
      info.status = resp.status;
      const redirect = o.follow && REDIRECTS.indexOf(resp.status) >= 0 && resp.headers.location;
      if (o.include && t.dump == null && toTerminal) ctx.out(head);
      if (!redirect) break;
      if (info.redirects >= o.maxRedirs) {
        lastCode = report(47, 'Maximum (' + o.maxRedirs + ') redirects followed');
        resp = null; break;
      }
      info.redirects++;
      const next = joinUrl(u, resp.headers.location);
      if (verbose) { eln('* Ignoring the response-body'); eln('* Connection #0 to host ' + u.host + ' left intact'); eln("* Issue another request to this URL: '" + next + "'"); }
      prevHost = u.scheme + '://' + u.hostport;
      const nu = parseUrl(next);
      if (!nu || (nu.scheme !== 'http' && nu.scheme !== 'https')) { lastCode = report(1, 'Protocol "' + (nu ? nu.scheme : 'unknown') + '" not supported'); resp = null; break; }
      if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method === 'POST' && !x.post301 && !x.post302)) { method = method === 'HEAD' ? 'HEAD' : 'GET'; reqBody = ''; }
      info.lastLocation = next;
      u = nu; first = false;
    }
    if (resp) {
      const failed = o.fail && resp.status >= 400;
      const text = resp.body;
      info.bytes = U.byteLen(text);
      if (!failed) {
        const payload = (o.head ? '' : text);
        if (toTerminal) { if (payload) ctx.out(payload); }
        else if (!await curlSave(ctx, o, fileName, (o.include ? hdrDump.split('\r\n\r\n').slice(-2)[0] + '\r\n\r\n' : '') + payload)) return 23;
        if (verbose && !toTerminal) eln('{ [' + info.bytes + ' bytes data]');
        if (verbose && toTerminal && !ctx.isTTY && info.bytes) eln('{ [' + info.bytes + ' bytes data]');
      }
      if (verbose) { eln('* Connection #0 to host ' + u.host + ' left intact'); }
      if (t.dump != null) await curlDump(ctx, t.dump, hdrDump);
      if (!o.silent && !o.head && (!toTerminal || !ctx.isTTY) && !failed) ctx.err(progressMeter(info.bytes, resp.ms));
      if (failed) lastCode = report(22, 'The requested URL returned error: ' + resp.status);
    }
    if (x.w != null) {
      const fmt = x.w[0] === '@' ? (await readFileOrFail(ctx, x.w.slice(1))) || '' : x.w;
      ctx.out(writeOut(fmt, curlVars(ctx, u, ex, resp, info, lastCode, method), resp));
    }
    return lastCode;
  }

  async function curlSave(ctx, o, name, data) {
    if (name === '/dev/null') return true;
    try { ctx.fs.write(name, data); return true; } catch (e) {
      if (!(e instanceof K.FsError)) throw e;
      if (!o.silent) ctx.eprintln('Warning: Failed to open the file ' + name + ': ' + e.message);
      if (!o.silent || o.showError) ctx.eprintln('curl: (23) Failure writing output to destination, passed ' + U.byteLen(data) + ' returned 0');
      return false;
    }
  }
  async function curlDump(ctx, dest, text) {
    if (dest === '-') ctx.out(text); else { try { ctx.fs.write(dest, text); } catch (e) { if (!(e instanceof K.FsError)) throw e; } }
  }

  function curlVars(ctx, u, ex, resp, info, code, method) {
    const total = resp ? resp.ms : 0;
    const lookup = ex.dnsMs || 0;
    const connect = resp ? lookup + (total - lookup) / (resp.tls ? 4 : 2) : 0;
    const app = resp && resp.tls ? lookup + (total - lookup) / 2 : 0;
    const bytes = resp && method !== 'HEAD' ? info.bytes : 0;
    return {
      http_code: resp ? String(resp.status).padStart(3, '0') : '000', response_code: resp ? String(resp.status).padStart(3, '0') : '000',
      time_total: secs(total), time_namelookup: secs(lookup), time_connect: secs(connect), time_appconnect: secs(app), time_pretransfer: secs(resp && resp.tls ? app : connect), time_starttransfer: secs(total * 0.98), time_redirect: secs(0),
      size_download: bytes, size_header: info.headerBytes, size_upload: 0, size_request: 0, speed_download: total > 0 ? Math.floor(bytes / (total / 1000)) : 0, speed_upload: 0,
      remote_ip: ex.ip || '', remote_port: resp ? u.port : 0, local_ip: resp ? ctx.machine.ifaces.find((i) => i.kind === 'ether').ip : '', local_port: resp ? 40000 + Math.floor(K.net.rand() * 20000) : 0,
      url_effective: urlString(u), url: urlString(u), scheme: u.scheme.toUpperCase(), method, content_type: resp ? resp.headers['content-type'] || '' : '',
      num_redirects: info.redirects, redirect_url: resp && REDIRECTS.indexOf(resp.status) >= 0 && resp.headers.location ? joinUrl(u, resp.headers.location) : '',
      http_version: resp ? '1.1' : '0', num_connects: resp ? 1 : 0, exitcode: code, errormsg: '', filename_effective: '',
    };
  }

  /* ==================================================================== wget */
  const WGET_USAGE = 'Usage: wget [OPTION]... [URL]...\n';
  const WGET_TRY = "\nTry `wget --help' for more options.\n";
  const WGET_HELP = [
    'GNU Wget ' + WGET_VERSION + ', a non-interactive network retriever.',
    WGET_USAGE.trim(), '',
    'Mandatory arguments to long options are mandatory for short options too.', '',
    'Startup:',
    '  -V,  --version                   display the version of Wget and exit',
    '  -h,  --help                      print this help', '',
    'Logging and input file:',
    '  -q,  --quiet                     quiet (no output)',
    '  -v,  --verbose                   be verbose (this is the default)',
    '  -nv, --no-verbose                turn off verboseness, without being quiet', '',
    'Download:',
    '  -t,  --tries=NUMBER              set number of retries to NUMBER (0 unlimits)',
    '  -O,  --output-document=FILE      write documents to FILE',
    '  -nc, --no-clobber                skip downloads that would download to existing files',
    '  -T,  --timeout=SECONDS           set all timeout values to SECONDS', '',
    'Directories:',
    '  -P,  --directory-prefix=PREFIX   save files to PREFIX/..', '',
    'HTTP options:',
    '       --user=USER                 set both ftp and http user to USER',
    '       --password=PASS             set both ftp and http password to PASS',
    '       --header=STRING             insert STRING among the headers',
    '       --post-data=STRING          use the POST method; send STRING as the data',
    '  -U,  --user-agent=AGENT          identify as AGENT instead of Wget/VERSION',
    '  -S,  --server-response           print server response',
    '       --spider                    don\'t download anything', '',
    'HTTPS (SSL/TLS) options:',
    '       --no-check-certificate      don\'t validate the server\'s certificate', '',
    'Mail bug reports and suggestions to <bug-wget@gnu.org>.', '',
  ].join('\n');

  const WGET_VERSION_TEXT = [
    'GNU Wget ' + WGET_VERSION + ' built on linux-gnu.', '',
    '+cares +digest +https +ipv6 +iri +large-file +nls +ntlm +opie +psl +ssl/gnutls', '',
    'Wgetrc: ', '    /etc/wgetrc (system)', 'Locale: ', '    /usr/share/locale', 'Compile: ', '    gcc -DHAVE_CONFIG_H -DSYSTEM_WGETRC="/etc/wgetrc" -DLOCALEDIR="/usr/share/locale"', 'Link: ', '    gcc -lpsl -lgnutls -lz -lcares', '',
    'Copyright (C) 2024 Free Software Foundation, Inc.',
    'License GPLv3+: GNU GPL version 3 or later',
    '<http://www.gnu.org/licenses/gpl.html>.',
    'This is free software: you are free to change and redistribute it.',
    'There is NO WARRANTY, to the extent permitted by law.', '',
    'Originally written by Hrvoje Niksic <hniksic@xemacs.org>.',
    'Please send bug reports and questions to <bug-wget@gnu.org>.', '',
  ].join('\n');

  /** wget's human_readable: 1.7K, 114K, 1.2M. */
  function wgetSize(n, digits) {
    const u = ['', 'K', 'M', 'G', 'T']; let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    const d = digits != null ? digits : v < 10 ? 1 : 0;
    return (i === 0 ? String(n) : v.toFixed(i === 0 ? 0 : d)) + u[i];
  }
  /** Transfer rate as "673 MB/s" or "1.50 MB/s". */
  function wgetRate(bytes, ms, unitSep) {
    const bps = ms > 0 ? bytes / (ms / 1000) : bytes;
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = bps;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + unitSep + u[i] + '/s';
  }
  const wgetStamp = () => U.isoDate(K.clock.now());
  const wq = (s) => '‘' + s + '’';

  /** Progress output. A terminal gets the bar, anything else gets wget's dot style. */
  function wgetProgress(ctx, name, size, ms, tty) {
    const shortRate = wgetRate(size, ms, '').replace(/B\/s$/, '').replace(' ', '');
    const t = Math.floor(ms / 1000);
    if (tty) {
      const cols = Math.max(ctx.cols || 80, 60);
      const bar = Math.max(cols - 61, 10);
      const label = (name.length > 19 ? name.slice(0, 19) : name);
      const rate = t > 0 ? wgetRate(size, ms, '') : '--.-KB/s';
      const line = U.padEnd(label, 20) + '100%[' + '='.repeat(bar - 1) + '>]' + U.padStart(wgetSize(size, 2), 8) + '  ' + rate + '    in ' + (t > 0 ? ms / 1000 < 10 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000) : 0) + 's';
      return U.padEnd(line, cols - 1) + '\n';
    }
    let out = '';
    const per = 51200;
    const lines = Math.max(1, Math.ceil(size / per));
    for (let i = 0; i < lines; i++) {
      const bytes = Math.min(per, size - i * per);
      const dots = Math.max(1, Math.floor(bytes / 1024));
      const d = U.padEnd(Array.from({ length: Math.ceil(dots / 10) }, (x, g) => '.'.repeat(Math.min(10, dots - g * 10))).join(' '), 54);
      const last = i === lines - 1;
      const pct = last ? 100 : Math.floor(((i + 1) * per * 100) / size);
      out += U.padStart(i * 50, 6) + 'K ' + d + U.padStart(pct + '%', 4) + ' ' + U.padStart(shortRate, 5) + (last ? '=' : ' ') + t + 's\n';
    }
    return out;
  }

  function wgetOutName(o, u) {
    let name = decodeURIComponent(u.path.replace(/^([^?]*\/)?/, '').replace(/\/$/, '')) || 'index.html';
    if (u.path.replace(/[?].*$/, '').endsWith('/')) name = 'index.html' + (u.path.indexOf('?') >= 0 ? u.path.slice(u.path.indexOf('?')) : '');
    return o.prefix ? o.prefix.replace(/\/$/, '') + '/' + name : name;
  }

  function wgetTarget(ctx, name, noClobber) {
    if (!ctx.fs.exists(name)) return name;
    if (noClobber) return null;
    for (let i = 1; ; i++) if (!ctx.fs.exists(name + '.' + i)) return name + '.' + i;
  }

  async function wgetRun(ctx) {
    const g = K.getopt(ctx.args, { short: 'qvVhSO:P:U:t:T:ncdr', long: ['quiet', 'verbose', 'no-verbose', 'version', 'help', 'server-response', 'output-document=', 'directory-prefix=', 'user-agent=', 'tries=', 'timeout=', 'no-clobber', 'no-check-certificate', 'spider', 'header=', 'post-data=', 'user=', 'password=', 'max-redirect=', 'content-on-error'], alias: { quiet: 'q', verbose: 'v', version: 'V', help: 'h', 'server-response': 'S', 'output-document': 'O', 'directory-prefix': 'P', 'user-agent': 'U', tries: 't', timeout: 'T', 'no-clobber': 'n' } });
    if (g.err) {
      const m = /^invalid option -- '(.)'/.exec(g.err);
      const rq = /^option requires an argument -- '(.)'/.exec(g.err);
      if (m) ctx.eprintln('wget: invalid option -- \'' + m[1] + '\'');
      else if (rq) ctx.eprintln('wget: option requires an argument -- \'' + rq[1] + '\'');
      else ctx.eprintln('wget: ' + g.err);
      ctx.err(WGET_USAGE + WGET_TRY);
      return 2;
    }
    const x = g.opts;
    if (x.h) { ctx.out(WGET_HELP); return 0; }
    if (x.V) { ctx.out(WGET_VERSION_TEXT); return 0; }
    // -nv and -nc are written "n" plus a letter; getopt sees -n -v / -n -c
    const nv = !!x.n && !!x.v && !(g.count.v > 1); const nc = !!x.n && !!x.c;
    const o = {
      quiet: !!x.q, nv: nv, spider: !!x.spider, headers: !!x.S, out: x.O != null ? x.O : null, prefix: x.P || '',
      ua: x.U != null ? x.U : 'Wget/' + WGET_VERSION, verify: !x['no-check-certificate'], tries: x.t != null ? (parseInt(x.t, 10) || Infinity) : 20,
      timeout: x.T != null ? parseFloat(x.T) : 30, noClobber: nc && !nv ? true : !!x['no-clobber'] && nc, maxRedirect: x['max-redirect'] != null ? parseInt(x['max-redirect'], 10) : 20,
      post: x['post-data'], extra: g.all.header || [],
      user: x.user, password: x.password,
    };
    if (x.n && !x.v && !x.c) { ctx.eprintln('wget: invalid option -- \'n\''); ctx.err(WGET_USAGE + WGET_TRY); return 2; }
    if (!g.rest.length) { ctx.eprintln('wget: missing URL'); ctx.err(WGET_USAGE + WGET_TRY); return 1; }
    let status = 0;
    for (const raw of g.rest) { const c = await wgetFetch(ctx, o, raw); if (c) status = c; }
    return status;
  }

  async function wgetFetch(ctx, o, raw) {
    const say = (s) => { if (!o.quiet && !o.nv) ctx.err(s); };
    const note = (s) => { if (!o.quiet) ctx.eprintln(s); };
    let u = parseUrl(raw);
    if (!u || (u.scheme !== 'http' && u.scheme !== 'https')) {
      if (u && !o.quiet) ctx.eprintln(raw + ': Unsupported scheme ' + wq(u.scheme + '://') + '.');
      else if (!o.quiet) ctx.eprintln(raw + ': Invalid host name.');
      return 1;
    }
    if (o.spider) say('Spider mode enabled. Check if remote file exists.\n');
    let method = o.spider ? 'HEAD' : o.post != null ? 'POST' : 'GET';
    let redirects = 0; let attempt = 1;
    for (;;) {
      const stamp = wgetStamp();
      say('--' + stamp + '--  ' + urlString(u) + '\n' + (attempt > 1 ? '(try:' + U.padStart(attempt, 2) + ')  ' + urlString(u) + '\n' : ''));
      let ip; let dnsMs = 0;
      if (U.isIPv4(u.host)) ip = u.host;
      else {
        const hostLabel = u.host;
        const r = K.net.resolve(ctx.machine, u.host);
        say('Resolving ' + hostLabel + ' (' + hostLabel + ')... ');
        if (!r) {
          await ctx.sleep(30);
          say('failed: Name or service not known.\n');
          note('wget: unable to resolve host address ' + wq(u.host));
          return 4;
        }
        ip = r.ip; dnsMs = r.ms; await ctx.sleep(dnsMs);
        say(ip + '\n');
      }
      const target = U.isIPv4(u.host) ? u.host + ':' + u.port : u.host + ' (' + u.host + ')|' + ip + '|:' + u.port;
      const headers = { 'user-agent': o.ua, accept: '*/*', 'accept-encoding': 'identity', connection: 'Keep-Alive' };
      for (const h of o.extra) { const c = h.indexOf(':'); if (c > 0) headers[h.slice(0, c).trim().toLowerCase()] = h.slice(c + 1).trim(); }
      if (o.user != null) headers.authorization = 'Basic ' + base64(o.user + ':' + (o.password || ''));
      if (o.post != null) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers['content-length'] = String(U.byteLen(o.post)); }
      const ex = exchange(ctx, { u, method, headers, body: o.post || '' }, { verify: o.verify, resolve: null });
      const connecting = 'Connecting to ' + target + '... ';
      if (ex.fail) {
        const f = ex.fail;
        say(connecting);
        if (f.kind === 'cert') {
          await ctx.sleep(Math.round(ex.rtt * 3));
          say('connected.\n');
          note('ERROR: The certificate of ' + wq(u.host) + ' is not trusted.');
          note('ERROR: The certificate of ' + wq(u.host) + " doesn't have a known issuer.");
          return 5;
        }
        if (f.tlsError) { await ctx.sleep(5); say('connected.\n'); note('OpenSSL: error:0A00010B:SSL routines::wrong version number\nUnable to establish SSL connection.'); return 4; }
        if (f.code === 'ETIMEDOUT') {
          await ctx.sleep(o.timeout * 1000);
          say('failed: Connection timed out.\n');
          if (attempt >= o.tries) return 4;
          say('Retrying.\n');
          attempt++; continue;
        }
        say('failed: ' + f.message + '.\n');
        return 4;
      }
      say(connecting + 'connected.\n');
      const resp = ex.resp;
      await ctx.sleep(resp.ms);
      const line = resp.status + ' ' + resp.statusText;
      if (o.headers) {
        say('HTTP request sent, awaiting response... \n');
        say('  HTTP/1.1 ' + line + '\n' + headerList(resp).map((h) => '  ' + h[0] + ': ' + h[1] + '\n').join(''));
      } else say('HTTP request sent, awaiting response... ' + line + '\n');
      if (REDIRECTS.indexOf(resp.status) >= 0 && resp.headers.location && !o.spider) {
        const next = joinUrl(u, resp.headers.location);
        if (++redirects > o.maxRedirect) { note(redirects - 1 + ' redirections exceeded.'); return 1; }
        say('Location: ' + next + ' [following]\n');
        const nu = parseUrl(next); if (!nu) return 1;
        if (resp.status === 303) method = o.spider ? 'HEAD' : 'GET';
        u = nu; attempt = 1; continue;
      }
      if (resp.status === 401) { note('\nUsername/Password Authentication Failed.'); return 6; }
      if (resp.status >= 400) {
        if (o.nv) { note(urlString(u) + ':'); note(stamp + ' ERROR ' + resp.status + ': ' + resp.statusText + '.'); }
        else if (o.spider) { note('Remote file does not exist -- broken link!!!'); }
        else note(stamp + ' ERROR ' + resp.status + ': ' + resp.statusText + '.');
        return 8;
      }
      const length = parseInt(resp.headers['content-length'], 10);
      const type = (resp.headers['content-type'] || 'application/octet-stream').replace(/;.*$/, '');
      const sizeText = isNaN(length) ? 'unspecified' : length < 1024 ? String(length) : length + ' (' + wgetSize(length) + ')';
      say('Length: ' + sizeText + ' [' + type + ']\n');
      if (o.spider) {
        say(/html/.test(type) ? 'Remote file exists and could contain further links,\nbut recursion is disabled -- not retrieving.\n\n' : 'Remote file exists.\n\n');
        return 0;
      }
      const size = U.byteLen(resp.body);
      const toStdout = o.out === '-';
      let name = o.out != null ? o.out : wgetTarget(ctx, wgetOutName(o, u), o.noClobber);
      if (name == null) {
        note('File ' + wq(wgetOutName(o, u)) + ' already there; not retrieving.\n');
        return 0;
      }
      if (o.prefix && o.out == null) { try { ctx.fs.mkdir(o.prefix, { parents: true }); } catch (e) { if (!(e instanceof K.FsError)) throw e; } }
      say('Saving to: ' + wq(toStdout ? 'STDOUT' : name) + '\n\n');
      await ctx.sleep(Math.max(0, size / 2000));
      if (toStdout) ctx.out(resp.body);
      else {
        try { ctx.fs.write(name, resp.body); } catch (e) {
          if (!(e instanceof K.FsError)) throw e;
          note(name + ': ' + e.message + '\n\nCannot write to ' + wq(name) + ' (' + e.message + ').');
          return 3;
        }
      }
      const tty = !!ctx.errTTY;
      say(wgetProgress(ctx, toStdout ? '-' : name.replace(/^.*\//, ''), size, resp.ms, tty) + '\n');
      if (o.nv && !o.quiet) ctx.eprintln(stamp + ' URL:' + urlString(u) + ' [' + size + '/' + size + '] -> "' + (toStdout ? '-' : name) + '" [1]');
      else say(wgetStamp() + ' (' + wgetRate(size, resp.ms, ' ') + ') - ' + (toStdout ? wq('STDOUT') : wq(name)) + ' saved [' + size + '/' + size + ']\n\n');
      return 0;
    }
  }

  /* ================================================================ python3 */
  const PY_HELP_SERVER = [
    'usage: server.py [-h] [--cgi] [-b ADDRESS] [-d DIRECTORY] [-p VERSION] [port]', '',
    'positional arguments:', '  port                  bind to this port (default: 8000)', '',
    'options:', '  -h, --help            show this help message and exit', '  --cgi                 run as CGI server',
    '  -b, --bind ADDRESS    bind to this address (default: all interfaces)', '  -d, --directory DIRECTORY', '                        serve this directory (default: current directory)',
    '  -p, --protocol VERSION', '                        conform to this HTTP version (default: HTTP/1.0)', '',
  ].join('\n');
  const PY_HELP = [
    'usage: python3 [option] ... [-c cmd | -m mod | file | -] [arg] ...',
    'Options (and corresponding environment variables):',
    '-c cmd : program passed in as string (terminates option list)',
    '-m mod : run library module as a script (terminates option list)',
    '-V     : print the Python version number and exit (also --version)',
    '-h     : print this help message and exit (also -? or --help)', '',
    'This is Kalima: only "python3 -c \'print(...)\'" and "python3 -m http.server" are simulated.', '',
  ].join('\n');
  const NOT_SIMULATED = 'python3: the Python interpreter is not simulated in Kalima; only -c with print() of simple expressions and -m http.server are available';

  const MIME = { html: 'text/html', htm: 'text/html', txt: 'text/plain', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', xml: 'application/xml', csv: 'text/csv', md: 'text/markdown', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/vnd.microsoft.icon', pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', py: 'text/x-python', sh: 'application/x-sh', c: 'text/x-csrc', php: 'application/x-httpd-php', pl: 'application/x-perl', log: 'text/plain', conf: 'application/octet-stream' };
  const mimeOf = (name) => { const m = /\.([A-Za-z0-9]+)$/.exec(name); return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream'; };
  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  const PY_SERVER = 'SimpleHTTP/0.6 Python/' + PYTHON_VERSION;

  const pyError = (code, message, explain) => ({
    status: code, headers: { server: PY_SERVER, connection: 'close', 'content-type': 'text/html;charset=utf-8' },
    body: '<!DOCTYPE HTML>\n<html lang="en">\n    <head>\n        <meta charset="utf-8">\n        <title>Error response</title>\n    </head>\n    <body>\n        <h1>Error response</h1>\n        <p>Error code: ' + code + '</p>\n        <p>Message: ' + message + '.</p>\n        <p>Error code explanation: ' + code + ' - ' + explain + '.</p>\n    </body>\n</html>\n',
  });

  /** Answer one request the way http.server.SimpleHTTPRequestHandler does. */
  function pyServe(ctx, dir, req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return pyError(501, "Unsupported method (\\'" + req.method + "\\')".replace(/\\/g, ''), 'Server does not support this operation');
    let path;
    try { path = decodeURIComponent(req.path); } catch (e) { path = req.path; }
    const trailing = path.endsWith('/');
    const parts = [];
    for (const p of path.split('/')) { if (p === '..') parts.pop(); else if (p && p !== '.') parts.push(p); }
    const fsPath = (dir.replace(/\/$/, '') + '/' + parts.join('/')).replace(/\/$/, '') || '/';
    let st;
    try { st = ctx.fs.stat(fsPath); } catch (e) { if (!(e instanceof K.FsError)) throw e; return pyError(404, 'File not found', 'Nothing matches the given URI'); }
    if (st.isDir) {
      if (!trailing) return { status: 301, headers: { server: PY_SERVER, location: req.path + '/' + (req.query ? '?' + req.query : ''), 'content-length': '0' }, body: '' };
      for (const idx of ['index.html', 'index.htm']) {
        if (ctx.fs.isFile(fsPath.replace(/\/$/, '') + '/' + idx)) return pyFile(ctx, fsPath.replace(/\/$/, '') + '/' + idx, idx);
      }
      return pyListing(ctx, fsPath, path);
    }
    if (trailing) return pyError(404, 'File not found', 'Nothing matches the given URI');
    return pyFile(ctx, fsPath, parts[parts.length - 1]);
  }
  function pyFile(ctx, fsPath, name) {
    let data;
    try { data = ctx.fs.read(fsPath); } catch (e) { if (!(e instanceof K.FsError)) throw e; return pyError(404, 'File not found', 'Nothing matches the given URI'); }
    const st = ctx.fs.stat(fsPath);
    return { status: 200, headers: { server: PY_SERVER, 'content-type': mimeOf(name), 'last-modified': new Date(st.mtime).toUTCString() }, body: data };
  }
  function pyListing(ctx, fsPath, urlPath) {
    let names;
    try { names = ctx.fs.readdir(fsPath); } catch (e) { if (!(e instanceof K.FsError)) throw e; return pyError(404, 'No permission to list directory', 'Nothing matches the given URI'); }
    names.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
    const title = 'Directory listing for ' + escapeHtml(urlPath);
    let body = '<!DOCTYPE HTML>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>' + title + '</title>\n</head>\n<body>\n<h1>' + title + '</h1>\n<hr>\n<ul>\n';
    for (const n of names) {
      const full = fsPath.replace(/\/$/, '') + '/' + n;
      let shown = n; let link = n;
      let ls = null; try { ls = ctx.fs.lstat(full); } catch (e) { if (!(e instanceof K.FsError)) throw e; }
      if (ls && ls.isDir) { shown += '/'; link += '/'; }
      if (ls && ls.isLink) shown += '@';
      body += '<li><a href="' + percent(link).replace(/%2F/g, '/') + '">' + escapeHtml(shown) + '</a></li>\n';
    }
    body += '</ul>\n<hr>\n</body>\n</html>\n';
    return { status: 200, headers: { server: PY_SERVER, 'content-type': 'text/html; charset=utf-8' }, body };
  }

  const pyLogDate = (ms) => { const d = new Date(ms); return U.pad2(d.getUTCDate()) + '/' + U.MONTHS[d.getUTCMonth()] + '/' + d.getUTCFullYear() + ' ' + U.pad2(d.getUTCHours()) + ':' + U.pad2(d.getUTCMinutes()) + ':' + U.pad2(d.getUTCSeconds()); };

  async function pyHttpServer(ctx, args) {
    const g = K.getopt(args, { short: 'hb:d:p:', long: ['help', 'cgi', 'bind=', 'directory=', 'protocol='], alias: { help: 'h', bind: 'b', directory: 'd', protocol: 'p' } });
    const usage = PY_HELP_SERVER.split('\n')[0];
    if (g.err) {
      const bad = /^unrecognized option '(.*)'/.exec(g.err); const inv = /^invalid option -- '(.)'/.exec(g.err);
      ctx.eprintln(usage); ctx.eprintln('server.py: error: ' + (bad ? 'unrecognized arguments: ' + bad[1] : inv ? 'unrecognized arguments: -' + inv[1] : g.err));
      return 2;
    }
    if (g.opts.h) { ctx.out(PY_HELP_SERVER); return 0; }
    if (g.rest.length > 1) { ctx.eprintln(usage); ctx.eprintln('server.py: error: unrecognized arguments: ' + g.rest.slice(1).join(' ')); return 2; }
    let port = 8000;
    if (g.rest.length) {
      if (!/^[-+]?\d+$/.test(g.rest[0])) { ctx.eprintln(usage); ctx.eprintln("server.py: error: argument port: invalid int value: '" + g.rest[0] + "'"); return 2; }
      port = parseInt(g.rest[0], 10);
    }
    const addr = g.opts.b != null ? String(g.opts.b) : '0.0.0.0';
    const dir = ctx.path(g.opts.d != null ? String(g.opts.d) : '.');
    const refuse = (msg) => { ctx.eprintln('Traceback (most recent call last):\n  File "<frozen runpy>", line 198, in _run_module_as_main\n  File "<frozen runpy>", line 88, in _run_code\n  File "/usr/lib/python3.13/http/server.py", line 1347, in <module>\n    test(\n' + msg); return 1; };
    if (port < 0 || port > 65535) return refuse('OverflowError: bind(): port must be 0-65535.');
    if (port < 1024 && !ctx.isRoot) return refuse('PermissionError: [Errno 13] Permission denied');
    if (K.net.listening(ctx.machine).some((l) => l.port === port && (l.proto || 'tcp') === 'tcp')) return refuse('OSError: [Errno 98] Address already in use');
    const unlisten = K.net.listen(ctx.machine, {
      port, proto: 'tcp', addr, prog: 'python3', pid: ctx.pid, name: 'http', handler: 'http', product: 'SimpleHTTP', version: '0.6',
      http(request) {
        const resp = pyServe(ctx, dir, request);
        ctx.eprintln((request.client || '127.0.0.1') + ' - - [' + pyLogDate(K.clock.now()) + '] "' + request.method + ' ' + request.path + (request.query ? '?' + request.query : '') + ' HTTP/1.1" ' + resp.status + ' -');
        return resp;
      },
    });
    const shown = addr === '0.0.0.0' ? '0.0.0.0' : addr;
    ctx.println('Serving HTTP on ' + addr + ' port ' + port + ' (http://' + shown + ':' + port + '/) ...');
    try {
      for (;;) await ctx.sleep(1000);
    } catch (e) {
      if (!(e instanceof K.Interrupt)) throw e;
      ctx.println('\nKeyboard interrupt received, exiting.');
      return 0;
    } finally { unlisten(); }
  }

  /* ---- python3 -c: print() of simple expressions, parsed by a real parser ---- */
  class PyError extends Error { constructor(type, msg) { super(msg); this.pyType = type; } }
  class PyUnsupported extends Error {}

  function pyTokens(src) {
    const toks = []; let i = 0;
    const isDigit = (c) => c >= '0' && c <= '9';
    while (i < src.length) {
      const c = src[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if (c === '#') break;
      if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
        const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?|\d[\d_]*\.)/.exec(src.slice(i));
        toks.push({ t: 'num', v: m[0].replace(/_/g, '') }); i += m[0].length; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        const m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(src.slice(i));
        if ((src[i + m[0].length] === '"' || src[i + m[0].length] === "'") && /^[rRbBfFuU]{1,2}$/.test(m[0])) {
          if (/[fF]/.test(m[0]) || /[bB]/.test(m[0])) throw new PyUnsupported();
          const raw = /[rR]/.test(m[0]); i += m[0].length;
          const s = pyString(src, i, raw); toks.push({ t: 'str', v: s.v }); i = s.end; continue;
        }
        toks.push({ t: 'name', v: m[0] }); i += m[0].length; continue;
      }
      if (c === '"' || c === "'") { const s = pyString(src, i, false); toks.push({ t: 'str', v: s.v }); i = s.end; continue; }
      const op = ['**', '//', '==', '!=', '<=', '>=', '<<', '>>'].find((p) => src.startsWith(p, i)) || c;
      if (!'+-*/%()<>=,;.[]{}~&|^:'.includes(op[0])) throw new PyError('SyntaxError', 'invalid character');
      toks.push({ t: 'op', v: op }); i += op.length;
    }
    return toks;
  }
  function pyString(src, i, raw) {
    const q = src[i]; const triple = src.startsWith(q + q + q, i);
    const end = triple ? q + q + q : q; let j = i + end.length; let v = '';
    const esc = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', 0: '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };
    for (;;) {
      if (j >= src.length) throw new PyError('SyntaxError', 'unterminated string literal');
      if (src.startsWith(end, j)) return { v, end: j + end.length };
      const c = src[j];
      if (c === '\n' && !triple) throw new PyError('SyntaxError', 'unterminated string literal');
      if (c === '\\' && !raw) {
        const n = src[j + 1];
        if (n === 'x') { v += String.fromCharCode(parseInt(src.substr(j + 2, 2), 16)); j += 4; continue; }
        if (n === 'u') { v += String.fromCharCode(parseInt(src.substr(j + 2, 4), 16)); j += 6; continue; }
        if (n === '\n') { j += 2; continue; }
        v += n in esc ? esc[n] : '\\' + n; j += 2; continue;
      }
      v += c; j++;
    }
  }

  const pyInt = (v) => ({ t: 'int', v: BigInt(v) });
  const pyFloat = (v) => ({ t: 'float', v });
  const pyStr = (v) => ({ t: 'str', v });
  const pyBool = (v) => ({ t: 'bool', v });
  const pyNone = { t: 'none' };
  const isNum = (a) => a.t === 'int' || a.t === 'float' || a.t === 'bool';
  const numVal = (a) => (a.t === 'float' ? a.v : Number(a.v === true ? 1n : a.v === false ? 0n : a.v));
  const typeName = (a) => ({ int: 'int', float: 'float', str: 'str', bool: 'bool', none: 'NoneType', list: 'list', tuple: 'tuple' }[a.t]);

  function fmtFloat(x) {
    if (Number.isNaN(x)) return 'nan';
    if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
    const ax = Math.abs(x);
    if (ax !== 0 && (ax >= 1e16 || ax < 1e-4)) return x.toExponential().replace(/e([+-])(\d)$/, 'e$10$2').replace(/(\.\d*?)0+e/, '$1e');
    const s = String(x);
    if (/e/.test(s)) return x.toFixed(20).replace(/0+$/, '').replace(/\.$/, '.0');
    return /\./.test(s) ? s : s + '.0';
  }
  const pyQuote = (s) => { const q = s.indexOf("'") >= 0 && s.indexOf('"') < 0 ? '"' : "'"; return q + s.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), '\\' + q).replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r') + q; };
  function pyRepr(a) {
    switch (a.t) {
      case 'int': return a.v.toString();
      case 'float': return fmtFloat(a.v);
      case 'str': return pyQuote(a.v);
      case 'bool': return a.v ? 'True' : 'False';
      case 'none': return 'None';
      case 'list': return '[' + a.v.map(pyRepr).join(', ') + ']';
      default: return '(' + a.v.map(pyRepr).join(', ') + (a.v.length === 1 ? ',' : '') + ')';
    }
  }
  const pyText = (a) => (a.t === 'str' ? a.v : pyRepr(a));

  function pyArith(op, a, b) {
    const tErr = () => new PyError('TypeError', 'unsupported operand type(s) for ' + op + ": '" + typeName(a) + "' and '" + typeName(b) + "'");
    if (a.t === 'str' || b.t === 'str') {
      if (op === '+') {
        if (a.t === 'str' && b.t === 'str') return pyStr(a.v + b.v);
        throw new PyError('TypeError', a.t === 'str' ? 'can only concatenate str (not "' + typeName(b) + '") to str' : 'unsupported operand type(s) for +: \'' + typeName(a) + "' and 'str'");
      }
      if (op === '*' && (a.t === 'int' || b.t === 'int' || a.t === 'bool' || b.t === 'bool')) {
        const s = a.t === 'str' ? a : b; const n = a.t === 'str' ? b : a;
        const k = Number(n.v === true ? 1n : n.v === false ? 0n : n.v);
        return pyStr(k > 0 ? s.v.repeat(k) : '');
      }
      if (op === '*') throw new PyError('TypeError', "can't multiply sequence by non-int of type '" + typeName(a.t === 'str' ? b : a) + "'");
      if (op === '%') throw new PyUnsupported();
      throw tErr();
    }
    if (a.t === 'list' || a.t === 'tuple' || b.t === 'list' || b.t === 'tuple') {
      if (op === '+' && a.t === b.t) return { t: a.t, v: a.v.concat(b.v) };
      throw tErr();
    }
    if (!isNum(a) || !isNum(b)) throw tErr();
    const bothInt = a.t !== 'float' && b.t !== 'float';
    const toBig = (n) => (n.v === true ? 1n : n.v === false ? 0n : n.v);
    if (bothInt) {
      const x = toBig(a); const y = toBig(b);
      switch (op) {
        case '+': return pyInt(x + y);
        case '-': return pyInt(x - y);
        case '*': return pyInt(x * y);
        case '/': if (y === 0n) throw new PyError('ZeroDivisionError', 'division by zero'); return pyFloat(Number(x) / Number(y));
        case '//': { if (y === 0n) throw new PyError('ZeroDivisionError', 'integer division or modulo by zero'); let q = x / y; if ((x % y !== 0n) && ((x < 0n) !== (y < 0n))) q -= 1n; return pyInt(q); }
        case '%': { if (y === 0n) throw new PyError('ZeroDivisionError', 'integer modulo by zero'); const r = x % y; return pyInt(r !== 0n && ((r < 0n) !== (y < 0n)) ? r + y : r); }
        case '**': if (y < 0n) return pyFloat(Math.pow(Number(x), Number(y))); if (y > 100000n) throw new PyUnsupported(); return pyInt(x ** y);
        default: break;
      }
    }
    const x = numVal(a); const y = numVal(b);
    switch (op) {
      case '+': return pyFloat(x + y);
      case '-': return pyFloat(x - y);
      case '*': return pyFloat(x * y);
      case '/': if (y === 0) throw new PyError('ZeroDivisionError', 'float division by zero'); return pyFloat(x / y);
      case '//': if (y === 0) throw new PyError('ZeroDivisionError', 'float floor division by zero'); return pyFloat(Math.floor(x / y));
      case '%': if (y === 0) throw new PyError('ZeroDivisionError', 'float modulo'); return pyFloat(x - Math.floor(x / y) * y);
      default: return pyFloat(Math.pow(x, y));
    }
  }
  function pyCompare(op, a, b) {
    const cmp = isNum(a) && isNum(b) ? numVal(a) - numVal(b) : a.t === 'str' && b.t === 'str' ? (a.v < b.v ? -1 : a.v > b.v ? 1 : 0) : null;
    if (cmp == null) {
      if (op === '==') return pyBool(pyRepr(a) === pyRepr(b) && a.t === b.t);
      if (op === '!=') return pyBool(!(pyRepr(a) === pyRepr(b) && a.t === b.t));
      throw new PyError('TypeError', "'" + op + "' not supported between instances of '" + typeName(a) + "' and '" + typeName(b) + "'");
    }
    return pyBool({ '==': cmp === 0, '!=': cmp !== 0, '<': cmp < 0, '>': cmp > 0, '<=': cmp <= 0, '>=': cmp >= 0 }[op]);
  }
  const truthy = (a) => (a.t === 'str' ? a.v !== '' : a.t === 'int' ? a.v !== 0n : a.t === 'float' ? a.v !== 0 : a.t === 'bool' ? a.v : a.t === 'none' ? false : a.v.length > 0);

  /** Recursive-descent parser/evaluator for a Python expression subset. */
  class PyExpr {
    constructor(toks) { this.toks = toks; this.i = 0; }
    peek() { return this.toks[this.i]; }
    isOp(v) { const t = this.peek(); return t && t.t === 'op' && t.v === v; }
    isName(v) { const t = this.peek(); return t && t.t === 'name' && t.v === v; }
    eat(v) { if (!this.isOp(v)) throw new PyError('SyntaxError', 'invalid syntax'); this.i++; }
    atEnd() { return this.i >= this.toks.length; }
    expr() { return this.orTest(); }
    orTest() { let a = this.andTest(); while (this.isName('or')) { this.i++; const b = this.andTest(); a = truthy(a) ? a : b; } return a; }
    andTest() { let a = this.notTest(); while (this.isName('and')) { this.i++; const b = this.notTest(); a = truthy(a) ? b : a; } return a; }
    notTest() { if (this.isName('not')) { this.i++; return pyBool(!truthy(this.notTest())); } return this.comparison(); }
    comparison() {
      let a = this.arith();
      for (;;) {
        const t = this.peek();
        if (!t || t.t !== 'op' || !['==', '!=', '<', '>', '<=', '>='].includes(t.v)) return a;
        this.i++; a = pyCompare(t.v, a, this.arith());
      }
    }
    arith() {
      let a = this.term();
      while (this.isOp('+') || this.isOp('-')) { const op = this.peek().v; this.i++; a = pyArith(op, a, this.term()); }
      return a;
    }
    term() {
      let a = this.factor();
      while (['*', '/', '//', '%'].some((o) => this.isOp(o))) { const op = this.peek().v; this.i++; a = pyArith(op, a, this.factor()); }
      return a;
    }
    factor() {
      if (this.isOp('-') || this.isOp('+')) {
        const op = this.peek().v; this.i++; const a = this.factor();
        if (!isNum(a)) throw new PyError('TypeError', "bad operand type for unary " + op + ": '" + typeName(a) + "'");
        return op === '+' ? (a.t === 'bool' ? pyInt(a.v ? 1 : 0) : a) : a.t === 'float' ? pyFloat(-a.v) : pyInt(-(a.v === true ? 1n : a.v === false ? 0n : a.v));
      }
      return this.power();
    }
    power() { const a = this.atomTrailer(); if (this.isOp('**')) { this.i++; return pyArith('**', a, this.factor()); } return a; }
    atomTrailer() {
      let a = this.atom();
      for (;;) {
        if (this.isOp('[')) { this.i++; const idx = this.expr(); this.eat(']'); a = this.index(a, idx); continue; }
        if (this.isOp('.')) { this.i++; const n = this.peek(); if (!n || n.t !== 'name') throw new PyError('SyntaxError', 'invalid syntax'); this.i++; a = this.method(a, n.v); continue; }
        return a;
      }
    }
    index(a, idx) {
      if (!['str', 'list', 'tuple'].includes(a.t)) throw new PyError('TypeError', "'" + typeName(a) + "' object is not subscriptable");
      if (idx.t !== 'int') throw new PyError('TypeError', (a.t === 'str' ? 'string' : a.t) + ' indices must be integers or slices, not ' + typeName(idx));
      const len = a.t === 'str' ? a.v.length : a.v.length; let k = Number(idx.v); if (k < 0) k += len;
      if (k < 0 || k >= len) throw new PyError('IndexError', a.t === 'str' ? 'string index out of range' : a.t + ' index out of range');
      return a.t === 'str' ? pyStr(a.v[k]) : a.v[k];
    }
    method(obj, name) {
      if (obj.t !== 'str' || !this.isOp('(')) throw new PyUnsupported();
      const args = this.callArgs();
      const strMethods = { upper: (s) => s.toUpperCase(), lower: (s) => s.toLowerCase(), strip: (s) => s.trim(), title: (s) => s.toLowerCase().replace(/(^|[^A-Za-z])([a-z])/g, (m, a, b) => a + b.toUpperCase()), capitalize: (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() };
      if (strMethods[name] && !args.length) return pyStr(strMethods[name](obj.v));
      if (name === 'replace' && args.length === 2 && args.every((x) => x.t === 'str')) return pyStr(obj.v.split(args[0].v).join(args[1].v));
      if (name === 'join' && args.length === 1 && (args[0].t === 'list' || args[0].t === 'tuple')) {
        for (const x of args[0].v) if (x.t !== 'str') throw new PyError('TypeError', 'sequence item 0: expected str instance, ' + typeName(x) + ' found');
        return pyStr(args[0].v.map((x) => x.v).join(obj.v));
      }
      if (name === 'split' && args.length <= 1) return { t: 'list', v: (args.length ? obj.v.split(args[0].v) : obj.v.trim().split(/\s+/).filter(Boolean)).map(pyStr) };
      throw new PyUnsupported();
    }
    callArgs() {
      this.eat('('); const args = [];
      while (!this.isOp(')')) { args.push(this.expr()); if (this.isOp(',')) this.i++; else break; }
      this.eat(')'); return args;
    }
    atom() {
      const t = this.peek();
      if (!t) throw new PyError('SyntaxError', 'invalid syntax');
      if (t.t === 'num') {
        this.i++;
        if (/^0[xXbBoO]/.test(t.v)) return pyInt(BigInt(t.v.toLowerCase()));
        return /[.eE]/.test(t.v) ? pyFloat(parseFloat(t.v)) : pyInt(BigInt(t.v));
      }
      if (t.t === 'str') { this.i++; let s = t.v; while (this.peek() && this.peek().t === 'str') s += this.toks[this.i++].v; return pyStr(s); }
      if (t.t === 'op' && t.v === '(') {
        this.i++;
        if (this.isOp(')')) { this.i++; return { t: 'tuple', v: [] }; }
        const first = this.expr();
        if (this.isOp(',')) { const v = [first]; while (this.isOp(',')) { this.i++; if (this.isOp(')')) break; v.push(this.expr()); } this.eat(')'); return { t: 'tuple', v }; }
        this.eat(')'); return first;
      }
      if (t.t === 'op' && t.v === '[') {
        this.i++; const v = [];
        while (!this.isOp(']')) { v.push(this.expr()); if (this.isOp(',')) this.i++; else break; }
        this.eat(']'); return { t: 'list', v };
      }
      if (t.t === 'name') {
        this.i++;
        if (t.v === 'True') return pyBool(true);
        if (t.v === 'False') return pyBool(false);
        if (t.v === 'None') return pyNone;
        if (this.isOp('(')) return this.call(t.v);
        throw new PyError('NameError', "name '" + t.v + "' is not defined");
      }
      throw new PyError('SyntaxError', 'invalid syntax');
    }
    call(name) {
      const args = this.callArgs();
      const one = () => { if (args.length !== 1) throw new PyError('TypeError', name + '() takes exactly one argument (' + args.length + ' given)'); return args[0]; };
      switch (name) {
        case 'len': { const a = one(); if (!['str', 'list', 'tuple'].includes(a.t)) throw new PyError('TypeError', "object of type '" + typeName(a) + "' has no len()"); return pyInt(a.v.length); }
        case 'str': return pyStr(args.length ? pyText(args[0]) : '');
        case 'repr': return pyStr(pyRepr(one()));
        case 'int': {
          if (!args.length) return pyInt(0);
          const a = args[0];
          if (a.t === 'str') { if (!/^\s*[-+]?\d+\s*$/.test(a.v)) throw new PyError('ValueError', 'invalid literal for int() with base 10: ' + pyQuote(a.v)); return pyInt(BigInt(a.v.trim())); }
          if (a.t === 'float') { if (!Number.isFinite(a.v)) throw new PyError('OverflowError', 'cannot convert float infinity to integer'); return pyInt(BigInt(Math.trunc(a.v))); }
          if (isNum(a)) return pyInt(a.v === true ? 1n : a.v === false ? 0n : a.v);
          throw new PyError('TypeError', "int() argument must be a string, a bytes-like object or a real number, not '" + typeName(a) + "'");
        }
        case 'float': {
          if (!args.length) return pyFloat(0);
          const a = args[0];
          if (a.t === 'str') { if (!/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(a.v)) throw new PyError('ValueError', 'could not convert string to float: ' + pyQuote(a.v)); return pyFloat(parseFloat(a.v)); }
          if (isNum(a)) return pyFloat(numVal(a));
          throw new PyError('TypeError', "float() argument must be a string or a real number, not '" + typeName(a) + "'");
        }
        case 'abs': { const a = one(); if (!isNum(a)) throw new PyError('TypeError', "bad operand type for abs(): '" + typeName(a) + "'"); return a.t === 'float' ? pyFloat(Math.abs(a.v)) : pyInt(a.v < 0n ? -a.v : a.v === true ? 1n : a.v === false ? 0n : a.v); }
        case 'round': {
          const a = args[0];
          if (!a || !isNum(a)) throw new PyError('TypeError', 'type ' + (a ? typeName(a) : 'NoneType') + " doesn't define __round__ method");
          if (args.length === 1) { const x = numVal(a); const r = Math.round(x); return pyInt(BigInt(Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r)); }
          const d = Number(args[1].v); return a.t === 'float' ? pyFloat(Number(a.v.toFixed(Math.max(0, d)))) : a;
        }
        case 'max': case 'min': {
          const list = args.length === 1 && (args[0].t === 'list' || args[0].t === 'tuple') ? args[0].v : args;
          if (!list.length) throw new PyError('ValueError', name + '() iterable argument is empty');
          return list.reduce((m, x) => (truthy(pyCompare(name === 'max' ? '>' : '<', x, m)) ? x : m));
        }
        case 'pow': if (args.length === 2) return pyArith('**', args[0], args[1]); throw new PyUnsupported();
        case 'chr': return pyStr(String.fromCharCode(Number(one().v)));
        case 'ord': { const a = one(); if (a.t !== 'str' || a.v.length !== 1) throw new PyError('TypeError', 'ord() expected a character, but string of length ' + (a.t === 'str' ? a.v.length : 1) + ' found'); return pyInt(a.v.charCodeAt(0)); }
        case 'hex': return pyStr((one().v < 0n ? '-0x' : '0x') + (one().v < 0n ? -one().v : one().v).toString(16));
        case 'bin': return pyStr((one().v < 0n ? '-0b' : '0b') + (one().v < 0n ? -one().v : one().v).toString(2));
        default: throw new PyError('NameError', "name '" + name + "' is not defined");
      }
    }
  }

  const PY_KEYWORDS = ['import', 'from', 'def', 'class', 'for', 'while', 'if', 'with', 'try', 'lambda', 'return', 'del', 'global', 'assert', 'raise', 'exec'];

  /** Run a `-c` program made of print(...) statements. Returns the text printed. */
  function pyRunC(src) {
    let out = '';
    for (const stmt of splitStatements(src)) {
      const toks = pyTokens(stmt);
      if (!toks.length) continue;
      if (toks[0].t === 'name' && PY_KEYWORDS.indexOf(toks[0].v) >= 0 || toks[0].t === 'name' && toks[1] && toks[1].v === '=') throw new PyUnsupported();
      const p = new PyExpr(toks);
      if (p.isName('print') && toks[1] && toks[1].v === '(') {
        p.i++; p.eat('(');
        const vals = []; let sep = ' '; let end = '\n';
        while (!p.isOp(')')) {
          const t = p.peek();
          if (t && t.t === 'name' && toks[p.i + 1] && toks[p.i + 1].v === '=' && (t.v === 'sep' || t.v === 'end')) {
            p.i += 2; const v = p.expr();
            if (v.t !== 'str') throw new PyError('TypeError', t.v + ' must be None or a string, not ' + typeName(v));
            if (t.v === 'sep') sep = v.v; else end = v.v;
          } else vals.push(p.expr());
          if (p.isOp(',')) p.i++; else break;
        }
        p.eat(')');
        if (!p.atEnd()) throw new PyError('SyntaxError', 'invalid syntax');
        out += vals.map(pyText).join(sep) + end;
      } else {
        p.expr();
        if (!p.atEnd()) throw new PyError('SyntaxError', 'invalid syntax');
      }
    }
    return out;
  }
  /** Split on ';' and newlines that are outside strings. */
  function splitStatements(src) {
    const out = []; let cur = ''; let q = null;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (q) { cur += c; if (c === '\\') cur += src[++i] || ''; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === ';' || c === '\n') { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out.filter((s) => s.trim());
  }

  async function pythonRun(ctx) {
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-V' || a === '--version') { ctx.println('Python ' + PYTHON_VERSION); return 0; }
      if (a === '-h' || a === '--help' || a === '-?') { ctx.out(PY_HELP); return 0; }
      if (a === '-c') {
        if (i + 1 >= args.length) { ctx.eprintln('Argument expected for the -c option'); ctx.eprintln('usage: python3 [option] ... [-c cmd | -m mod | file | -] [arg] ...'); ctx.eprintln("Try `python -h' for more information."); return 2; }
        return pythonC(ctx, args[i + 1]);
      }
      if (a === '-m') {
        const mod = args[i + 1];
        if (!mod) { ctx.eprintln('Argument expected for the -m option'); ctx.eprintln('usage: python3 [option] ... [-c cmd | -m mod | file | -] [arg] ...'); ctx.eprintln("Try `python -h' for more information."); return 2; }
        if (mod === 'http.server') return pyHttpServer(ctx, args.slice(i + 2));
        if (mod === 'SimpleHTTPServer') { ctx.eprintln('/usr/bin/python3: No module named SimpleHTTPServer'); return 1; }
        ctx.eprintln(NOT_SIMULATED); return 1;
      }
      if (/^-[a-zA-Z]+$/.test(a) && !/^-[BdEiIOPqsSuvWxX]+$/.test(a)) { ctx.eprintln('Unknown option: ' + a); ctx.eprintln('usage: python3 [option] ... [-c cmd | -m mod | file | -] [arg] ...'); ctx.eprintln("Try `python -h' for more information."); return 2; }
      if (a[0] !== '-' || a === '-') break;
    }
    if (!args.filter((a) => a[0] !== '-').length && ctx.stdin == null) { ctx.eprintln(NOT_SIMULATED); return 1; }
    ctx.eprintln(NOT_SIMULATED);
    return 1;
  }

  function pythonC(ctx, src) {
    try {
      ctx.out(pyRunC(src));
      return 0;
    } catch (e) {
      if (e instanceof PyUnsupported) { ctx.eprintln(NOT_SIMULATED); return 1; }
      if (e instanceof PyError) {
        if (e.pyType === 'SyntaxError') ctx.eprintln('  File "<string>", line 1\n' + '    ' + src.split('\n')[0] + '\nSyntaxError: ' + e.message);
        else ctx.eprintln('Traceback (most recent call last):\n  File "<string>", line 1, in <module>\n' + e.pyType + ': ' + e.message);
        return 1;
      }
      throw e;
    }
  }

  /* =============================================================== whatweb */
  const WHATWEB_VERSION = 'WhatWeb version 0.5.5 ( https://www.morningstarsecurity.com/research/whatweb )';
  const WHATWEB_USAGE = 'WhatWeb - Next generation web scanner version 0.5.5.\nDeveloped by Andrew Horton (urbanadventurer) and Brendan Coles (bcoles).\nHomepage: https://www.morningstarsecurity.com/research/whatweb\n\nUsage: whatweb [options] <URLs>\n\nTARGET SELECTION:\n  <TARGETs>\t\t\tEnter URLs, hostnames, IP addresses, filenames or\n\t\t\t\tfile system paths.\n\nTARGET MODIFICATION:\n  --url-prefix\t\t\tAdd a prefix to target URLs.\n\nAGGRESSION:\n  -a, --aggression LEVEL\tSet the aggression level. Default: 1.\n\t\t\t\t1 (Stealthy)\tOne HTTP request per target.\n\t\t\t\t3 (Aggressive)\tTriggers plugin-specific aggressive requests.\n\nHTTP OPTIONS:\n  -U, --user-agent=AGENT\tIdentify as AGENT instead of WhatWeb/0.5.5.\n  --max-redirects=NUM\t\tMaximum number of contiguous redirects. Default: 10.\n\nOUTPUT:\n  -v, --verbose\t\t\tVerbose output includes plugin descriptions.\n  -q, --quiet\t\t\tDo not display brief logging to STDOUT.\n  --no-errors\t\t\tSuppress error messages.\n  --colour=WHEN, --color=WHEN\tcontrol whether colour is used. WHEN may be `never`, `always`, or `auto`.\n\nHELP & MISCELLANEOUS:\n  -h, --help\t\t\tShow this help.\n  --version\t\t\tDisplay version information.\n';
  const COMMON_HEADERS = ['server', 'date', 'content-type', 'content-length', 'connection', 'last-modified', 'etag', 'accept-ranges', 'vary', 'cache-control', 'expires', 'set-cookie', 'location', 'x-powered-by', 'x-frame-options', 'www-authenticate', 'strict-transport-security', 'content-encoding', 'keep-alive', 'transfer-encoding', 'pragma'];
  const PRIVATE_IP = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

  function detect(resp, ip) {
    const found = {};
    const add = (name, ...vals) => { (found[name] = found[name] || []).push(...vals); };
    const server = resp.headers.server;
    if (server) {
      const os = /\(([^)]*)\)/.exec(server); const osName = os && /debian|ubuntu|centos|fedora|red hat/i.test(os[1]) ? os[1].replace(/^(\w+).*$/, '$1') + ' Linux' : null;
      add('HTTPServer', ...(osName ? [osName] : []), server);
      const prod = /^(Apache|nginx)\/?([\d.]*)/i.exec(server);
      if (prod) add(prod[1].toLowerCase() === 'apache' ? 'Apache' : 'nginx', ...(prod[2] ? [prod[2]] : []));
    }
    add('IP', ip);
    if (PRIVATE_IP.test(ip)) add('Country', 'RESERVED', 'ZZ');
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(resp.body);
    if (title) add('Title', title[1].trim().replace(/\s+/g, ' '));
    if (/^\s*<!doctype html>/i.test(resp.body)) add('HTML5');
    if (/<script/i.test(resp.body)) add('Script');
    const pw = /<input[^>]*type=["']?password["']?[^>]*>/i.exec(resp.body);
    if (pw) { const n = /name=["']?([^"'\s>]+)/i.exec(pw[0]); add('PasswordField', ...(n ? [n[1]] : [])); }
    const mails = resp.body.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g);
    if (mails) add('Email', ...Array.from(new Set(mails)));
    const gen = /<meta[^>]*name=["']generator["'][^>]*content=["']([^"']*)["']/i.exec(resp.body);
    if (gen) add('MetaGenerator', gen[1]);
    const xp = resp.headers['x-powered-by'];
    if (xp) { add('X-Powered-By', xp); const php = /^PHP\/([\d.]+)/.exec(xp); if (php) add('PHP', php[1]); }
    if (resp.headers['x-frame-options']) add('X-Frame-Options', resp.headers['x-frame-options']);
    if (resp.headers['strict-transport-security']) add('Strict-Transport-Security', resp.headers['strict-transport-security']);
    const ck = resp.headers['set-cookie'];
    if (ck) {
      const names = ck.split(/,\s*(?=[^;,]+=)/).map((c) => c.split('=')[0].trim());
      add('Cookies', ...names);
      const http = ck.split(/,\s*(?=[^;,]+=)/).filter((c) => /;\s*httponly/i.test(c)).map((c) => c.split('=')[0].trim());
      if (http.length) add('HttpOnly', ...http);
    }
    if (resp.headers.location) add('RedirectLocation', resp.headers.location);
    const auth = resp.headers['www-authenticate'];
    if (auth) { const realm = /realm="?([^"]*)"?/i.exec(auth); add('WWW-Authenticate', ...(realm ? [realm[1]] : []), auth.split(/\s/)[0]); }
    const unc = Object.keys(resp.headers).filter((h) => COMMON_HEADERS.indexOf(h) < 0);
    if (unc.length) add('UncommonHeaders', unc.join(','));
    return found;
  }
  const plugins = (found) => Object.keys(found).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).map((n) => n + found[n].map((v) => '[' + v + ']').join('')).join(', ');

  async function whatwebRun(ctx) {
    const g = K.getopt(ctx.args, { short: 'hvqa:U:', long: ['help', 'version', 'verbose', 'quiet', 'aggression=', 'user-agent=', 'max-redirects=', 'no-errors', 'color=', 'colour=', 'follow-redirect=', 'open-timeout=', 'read-timeout='], alias: { help: 'h', verbose: 'v', quiet: 'q', aggression: 'a', 'user-agent': 'U' } });
    if (g.err) { ctx.eprintln('whatweb: ' + g.err); return 1; }
    const x = g.opts;
    if (x.h) { ctx.out(WHATWEB_USAGE); return 0; }
    if (x.version) { ctx.println(WHATWEB_VERSION); return 0; }
    if (!g.rest.length) { ctx.out(WHATWEB_USAGE); return 1; }
    const maxRedirects = x['max-redirects'] != null ? parseInt(x['max-redirects'], 10) : 10;
    const ua = x.U != null ? x.U : 'WhatWeb/0.5.5';
    let code = 0;
    for (const target of g.rest) {
      let url = /^[a-z]+:\/\//i.test(target) ? target : 'http://' + target;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        const u = parseUrl(url);
        if (!u) { if (!x['no-errors']) ctx.eprintln('ERROR: Opening: ' + url + ' - bad URI(is not URI?): "' + url + '"'); code = 1; break; }
        let ip = U.isIPv4(u.host) ? u.host : null;
        if (!ip) { const r = K.net.resolve(ctx.machine, u.host); if (r) ip = r.ip; }
        if (!ip) { await ctx.sleep(20); if (!x['no-errors']) ctx.println('ERROR: Opening: ' + urlString(u) + ' - getaddrinfo: Name or service not known'); code = 1; break; }
        if (!K.net.guard(ctx, ip, 'whatweb')) { code = 1; break; }
        const ex = exchange(ctx, { u, method: 'GET', headers: { 'user-agent': ua, accept: '*/*', connection: 'close' }, body: '' }, { verify: false, resolve: null });
        if (ex.fail) {
          await ctx.sleep(ex.fail.code === 'ETIMEDOUT' ? 30000 : 5);
          const why = ex.fail.code === 'ETIMEDOUT' ? 'execution expired' : ex.fail.code === 'ECONNREFUSED' ? 'Connection refused - connect(2) for "' + u.host + '" port ' + u.port : ex.fail.message + ' - connect(2) for "' + u.host + '" port ' + u.port;
          if (!x['no-errors']) ctx.println('ERROR: Opening: ' + urlString(u) + ' - ' + why);
          code = 1; break;
        }
        const resp = ex.resp;
        await ctx.sleep(resp.ms);
        const found = detect(resp, ex.ip);
        if (!x.q) {
          if (x.v) {
            ctx.println('WhatWeb report for ' + url);
            ctx.println('Status    : ' + resp.status + ' ' + resp.statusText);
            if (found.Title) ctx.println('Title     : ' + found.Title[0]);
            ctx.println('IP        : ' + ex.ip);
            if (found.Country) ctx.println('Country   : ' + found.Country.join(', '));
            ctx.println('\nSummary   : ' + plugins(found).replace(/^.*?(?=[A-Z])/, '') + '\n');
          } else ctx.println(url + ' [' + resp.status + ' ' + resp.statusText + '] ' + plugins(found));
        }
        if (REDIRECTS.indexOf(resp.status) >= 0 && resp.headers.location) { url = joinUrl(u, resp.headers.location); continue; }
        break;
      }
    }
    return code;
  }

  /* ============================================================ registration */
  K.cmd.register({
    name: 'curl', path: '/usr/bin/curl', pkg: 'curl', section: 1, only: 'kali',
    summary: 'transfer a URL',
    synopsis: 'curl [options / URLs]',
    man: 'DESCRIPTION\n       curl is a tool for transferring data from or to a server using URLs. In Kalima it speaks HTTP and HTTPS to the simulated lab and internet.\n\nOPTIONS\n       -I, --head\n              Fetch the headers only (HEAD request).\n       -i, --include\n              Include the response headers in the output.\n       -v, --verbose\n              Show the connection, TLS and request/response header exchange.\n       -s, --silent; -S, --show-error\n              Hide the progress meter and errors; -S shows errors again.\n       -o file, -O\n              Save the body to a file or to the remote file name.\n       -L, --location; --max-redirs N\n              Follow redirects (at most N, default 50).\n       -X method, -H header, -d data, --data-urlencode data\n              Choose the method, add request headers, send a request body.\n       -A agent, -e referer, -u user:password, -b cookie\n              Set the User-Agent, Referer, Basic credentials or cookies.\n       -k, --insecure\n              Do not verify the server certificate. Lab hosts use self-signed certificates.\n       -m seconds, --connect-timeout seconds\n              Limit the total time or the connect time.\n       -w format\n              Print variables such as %{http_code}, %{time_total}, %{size_download}, %{remote_ip} after the transfer.\n       -f, --fail\n              Exit 22 on HTTP errors instead of printing the error page.\n       --resolve host:port:address\n              Use this address instead of DNS for host:port.\n\nEXIT STATUS\n       0 success, 6 could not resolve host, 7 failed to connect, 22 HTTP error with -f, 28 timeout, 35 TLS error, 60 certificate verification failed.\n\nEXAMPLES\n       curl -I http://web01.halcyon.lab\n              Look at the server headers of the intranet server.\n       curl -sk https://web01.halcyon.lab/ -o /dev/null -w "%{http_code}\\n"\n              Print only the status code, ignoring the self-signed certificate.\n       curl -d "user=student&pass=student" http://web01.halcyon.lab/login\n              POST a form.',
    async run(ctx) { return curlRun(ctx); },
  });

  K.cmd.register({
    name: 'wget', path: '/usr/bin/wget', pkg: 'wget', section: 1, only: 'kali',
    summary: 'the non-interactive network downloader',
    synopsis: 'wget [option]... [URL]...',
    man: 'DESCRIPTION\n       GNU Wget is a free utility for non-interactive download of files from the Web. It supports HTTP and HTTPS and follows redirects.\n\nOPTIONS\n       -O file, --output-document=file\n              Write the document to file ("-" for standard output).\n       -P prefix, --directory-prefix=prefix\n              Save files below prefix.\n       -q, --quiet; -nv, --no-verbose\n              Print nothing, or only a one-line summary.\n       -S, --server-response\n              Print the headers sent by the server.\n       --spider\n              Check that a file exists without downloading it.\n       --no-check-certificate\n              Do not validate the server certificate. Lab hosts use self-signed certificates.\n       -U agent, --header=string, --post-data=string\n              Set the User-Agent, add a header, send a POST body.\n       -t number, -T seconds, -nc\n              Number of tries, timeout, do not overwrite files.\n\nEXIT STATUS\n       0 success, 3 file I/O error, 4 network failure, 5 SSL verification failure, 6 authentication failure, 8 server issued an error response.\n\nEXAMPLES\n       wget http://web01.halcyon.lab/robots.txt\n              Download a file into the current directory.\n       wget --spider -S http://web01.halcyon.lab/admin/\n              Look at the response headers without downloading.\n       wget --no-check-certificate -O - https://web01.halcyon.lab/\n              Print a page from the HTTPS port to the terminal.',
    async run(ctx) { return wgetRun(ctx); },
  });

  K.cmd.register({
    name: 'python3', aliases: ['python'], path: '/usr/bin/python3', pkg: 'python3', section: 1,
    summary: 'an interpreted, interactive, object-oriented programming language',
    synopsis: 'python3 [-c command | -m module-name | script | -] [args]',
    man: 'DESCRIPTION\n       Python is an interpreted language. Kalima does not simulate the interpreter; it provides only the parts below.\n\nOPTIONS\n       -V, --version\n              Print the version number and exit.\n       -c command\n              Run print() calls of string and arithmetic expressions, for example python3 -c \'print(2**10)\'.\n       -m http.server [port] [--bind address] [--directory dir]\n              Serve a directory over HTTP (default port 8000) until Ctrl-C. Every request is logged.\n\nEXAMPLES\n       python3 -m http.server 8000\n              Share the current directory with the lab. Fetch from another host with wget http://10.10.10.5:8000/file.\n       python3 -c \'print("A" * 8)\'\n              Print a string.',
    async run(ctx) { return pythonRun(ctx); },
  });

  K.cmd.register({
    name: 'whatweb', path: '/usr/bin/whatweb', pkg: 'whatweb', section: 1, only: 'kali',
    summary: 'next generation web scanner',
    synopsis: 'whatweb [options] <URLs>',
    man: 'DESCRIPTION\n       WhatWeb identifies web technologies: it requests each target, follows redirects and prints one line per response with the status and the plugins that matched (HTTP server, title, headers, cookies, e-mail addresses). It is an active tool and only works inside the engagement scope.\n\nOPTIONS\n       -v, --verbose\n              Print a longer report per target.\n       -q, --quiet\n              Do not print results.\n       -U, --user-agent=AGENT\n              Send this User-Agent.\n       --max-redirects=NUM\n              Follow at most NUM redirects (default 10).\n       --no-errors\n              Suppress error messages.\n       --version\n              Print the version.\n\nEXAMPLES\n       whatweb web01.halcyon.lab\n              Fingerprint the intranet server.\n       whatweb 10.10.10.10 10.10.10.80\n              Fingerprint two lab hosts.',
    async run(ctx) { return whatwebRun(ctx); },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
