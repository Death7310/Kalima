/* Name lookup tools: dig, host, nslookup, whois, resolvectl.
 *
 * Every answer comes from K.net (dns, axfr, resolve). This file parses the
 * arguments and prints what the real tools print on Kali 2026.3.
 */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;

  const BIND = '9.20.11-4-Debian';
  const RR_TYPES = ['A', 'AAAA', 'ANY', 'AXFR', 'CAA', 'CNAME', 'DNSKEY', 'DS', 'HINFO', 'HTTPS', 'MX', 'NAPTR', 'NS', 'NSEC', 'PTR', 'RRSIG', 'SOA', 'SPF', 'SRV', 'SVCB', 'TLSA', 'TXT'];
  const RR_CLASSES = { IN: 'IN', CH: 'CH', CHAOS: 'CH', HS: 'HS', HESIOD: 'HS' };

  /* ------------------------------------------------------------ records */
  const dot = (name) => (name ? name + '.' : '.');
  const isType = (s) => RR_TYPES.indexOf(String(s).toUpperCase()) >= 0;
  const classOf = (s) => RR_CLASSES[String(s).toUpperCase()] || null;

  /** Presentation form of a record's data: host names get their trailing dot. */
  function rdata(r) {
    const f = String(r.data).split(' ');
    switch (r.type) {
      case 'NS': case 'CNAME': case 'PTR': return dot(r.data);
      case 'MX': return r.prio + ' ' + dot(r.data);
      case 'SOA': return [dot(f[0]), dot(f[1])].concat(f.slice(2)).join(' ');
      case 'SRV': return f.slice(0, 3).concat([dot(f[3])]).join(' ');
      default: return r.data;
    }
  }

  /**
   * BIND's master-file layout: each field starts at its column stop, reached with
   * tabs (width 8), and a field that overruns its stop is followed by one space.
   */
  function tabulate(fields, stops) {
    let line = fields[0]; let col = line.length;
    for (let i = 1; i < fields.length; i++) {
      const to = Math.max(stops[i - 1], col + 1);
      const tabs = Math.floor(to / 8) - Math.floor(col / 8);
      line += '\t'.repeat(tabs) + ' '.repeat(to - (tabs ? Math.floor(to / 8) * 8 : col)) + fields[i];
      col = to + fields[i].length;
    }
    return line;
  }

  /* Column stops for ttl, class, type and rdata, as dig picks them. */
  function stops(o) {
    if (!o.showTtl && !o.showClass) return [24, 24, 24, 32];
    return o.showTtl && o.showClass ? [24, 32, 40, 48] : [24, 24, 32, 40];
  }
  const FULL = { showTtl: true, showClass: true, cls: 'IN' };

  function recordLine(r, o) {
    const s = stops(o); const fields = [dot(r.name)]; const at = [];
    if (o.showTtl) { fields.push(String(r.ttl)); at.push(s[0]); }
    if (o.showClass) { fields.push(o.cls); at.push(s[1]); }
    const text = rdata(r);
    if (o.multiline && r.type === 'SOA' && text.split(' ').length === 7) {
      const p = text.split(' ');
      const span = (n) => {
        const parts = []; n = +n;
        for (const [u, sec] of [['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]]) {
          const c = Math.floor(n / sec); n -= c * sec;
          if (c) parts.push(c + ' ' + u + (c > 1 ? 's' : ''));
        }
        return parts.length ? ' (' + parts.join(' ') + ')' : '';
      };
      fields.push(r.type, p[0] + ' ' + p[1] + ' (');
      at.push(s[2], s[3]);
      const pad = '\t'.repeat(5);
      return tabulate(fields, at) + '\n' + pad + p[2].padEnd(10) + ' ; serial\n' +
        ['refresh', 'retry', 'expire', 'minimum'].map((k, i) => pad + p[3 + i].padEnd(10) + ' ; ' + k + span(p[3 + i]) + '\n').join('') + pad + ')';
    }
    fields.push(r.type, text); at.push(s[2], s[3]);
    return tabulate(fields, at);
  }
  function questionLine(q, o) {
    const s = stops(o);
    return ';' + tabulate([dot(q.name), o.cls, q.type], [s[1], s[2]]);
  }

  /** Size of the reply on the wire, with RFC 1035 name compression, so the byte counts are right. */
  function wireSize(question, records, optBytes) {
    const seen = new Set();
    const nameLen = (name, compress) => {
      const labels = name ? name.split('.') : [];
      let n = 0;
      for (let i = 0; i < labels.length; i++) {
        const suffix = labels.slice(i).join('.');
        if (compress && seen.has(suffix)) return n + 2;
        seen.add(suffix);
        n += 1 + labels[i].length;
      }
      return n + 1;
    };
    const rdLen = (r) => {
      const f = String(r.data).split(' ');
      switch (r.type) {
        case 'A': return 4;
        case 'AAAA': return 16;
        case 'NS': case 'CNAME': case 'PTR': return nameLen(r.data, true);
        case 'MX': return 2 + nameLen(r.data, true);
        case 'SOA': return nameLen(f[0], true) + nameLen(f[1], true) + 20;
        case 'SRV': return 6 + nameLen(f[3], false);
        case 'TXT': return (r.data.match(/"[^"]*"/g) || [r.data]).reduce((n, s) => n + s.replace(/"/g, '').length + 1, 0);
        default: return r.data.length;
      }
    };
    let size = 12 + nameLen(question, true) + 4 + optBytes;
    for (const r of records) { size += nameLen(r.name, true) + 10; size += rdLen(r); }
    return size;
  }
  const replySize = (res, optBytes) => wireSize(res.question.name, res.answers.concat(res.authority, res.additional), optBytes);

  /* ------------------------------------------------------------ queries */
  const ROOT_SERVERS = 'abcdefghijklm'.split('').map((l) => l + '.root-servers.net');

  /** K.net.dns, plus the one name the engine has no zone for: the root itself. */
  function query(ctx, name, type, server) {
    const r = ctx.net.dns(ctx.machine, name, type, { server });
    if (r.question.name !== '' || r.status !== 'NXDOMAIN') return r;
    r.status = 'NOERROR';
    if (type === 'NS' || type === 'ANY') { r.answers = ROOT_SERVERS.map((data) => ({ name: '', type: 'NS', ttl: 518400, data })); r.authority = []; }
    else if (type === 'SOA') { r.answers = r.authority; r.authority = []; }
    return r;
  }

  /** What BIND says about itself in the CHAOS class; everything else there is refused. */
  function chaosQuery(ctx, name, type, ip) {
    const res = ctx.net.dns(ctx.machine, name, type, { server: ip });
    if (res.status === 'TIMEOUT') return res;
    const host = ctx.net.knownHost(ip);
    const bind = host && ctx.net.servicesOf(host).find((s) => s.port === 53 && /BIND/.test(s.product || ''));
    const about = { 'version.bind': bind && bind.version + '-Debian', 'hostname.bind': bind && host.hostname }[res.question.name];
    const ok = about && (type === 'TXT' || type === 'ANY');
    res.status = ok ? 'NOERROR' : 'REFUSED';
    res.flags = { aa: !!ok, ra: false, rd: true };
    res.answers = ok ? [{ name: res.question.name, type: 'TXT', ttl: 0, data: '"' + about + '"' }] : [];
    res.authority = [];
    return res;
  }

  /** Why a server stays silent: a closed port answers at once, anything else runs into the timeout. */
  function silence(ctx, ip, port, tcp) {
    const probe = tcp ? ctx.net.tcp(ctx.machine, ip, port) : ctx.net.udp(ctx.machine, ip, port);
    return probe.state === 'closed' ? 'connection refused' : 'timed out';
  }

  /**
   * Put one question to the servers the way the BIND tools do: every server in
   * turn, `tries` rounds, waiting out each timeout. Returns the reply, or null
   * after printing a line for every attempt that failed.
   *   q: { shown, servers: [ip], arg, port, tcp, tries, timeout }; send(ip) -> reply with .status and .ms
   */
  async function ask(ctx, q, send) {
    for (let round = 0; round < q.tries; round++) {
      for (const ip of q.servers) {
        const res = q.port === 53 ? send(ip) : null;
        if (res && res.status !== 'TIMEOUT') { await ctx.sleep(res.ms); return res; }
        const why = silence(ctx, ip, q.port, q.tcp);
        await ctx.sleep(why === 'timed out' ? q.timeout * 1000 : 1);
        const at = ip + '#' + q.port;
        ctx.println(q.tcp ? ';; Connection to ' + at + '(' + (q.arg || ip) + ') for ' + q.shown + ' failed: ' + why + '.'
          : ';; communications error to ' + at + ': ' + why);
      }
    }
    return null;
  }

  /** Names the BIND tools try (ndots:1): a single label goes through the search list first, a dotted name is taken as it is. */
  function candidates(searchList, name) {
    if (name.indexOf('.') >= 0) return [name];
    return (searchList || []).map((s) => name + '.' + s).concat([name]);
  }

  /** The name a reply ends at once its CNAME chain is followed. */
  function canonicalName(res) {
    let name = res.question.name;
    for (let hop = res.answers.length; hop > 0; hop--) {
      const alias = res.answers.find((r) => r.type === 'CNAME' && r.name === name);
      if (!alias) break;
      name = alias.data;
    }
    return name;
  }
  const isAddress = (s) => U.isIPv4(s) || (s.indexOf(':') >= 0 && reverseName(s) !== null);
  const RCODES = { NOERROR: 0, NXDOMAIN: 3, REFUSED: 5, NOTAUTH: 9 };

  /* getopt's complaint in the words of the ISC command line parser. */
  const iscOptError = (err) => err.replace(/^invalid option/, 'illegal option').replace(/'(.)'$/, '$1');

  /**
   * Ask for each candidate name until one exists; send(name, ip) puts the question.
   * Returns the last reply, or null when no server answered.
   */
  async function askNames(ctx, q, names, send, trying) {
    let res = null;
    for (const name of names) {
      if (trying) trying(name);
      res = await ask(ctx, q, (ip) => send(name, ip));
      if (!res || res.status !== 'NXDOMAIN') break;
    }
    return res;
  }
  const sender = (ctx, type, cls) => (name, ip) => (cls === 'IN' ? query(ctx, name, type, ip) : chaosQuery(ctx, name, type, ip));
  const NO_SERVERS = ';; no servers could be reached\n\n';

  /** Addresses for a server given on the command line; empty when the name does not resolve. */
  function serverAddresses(ctx, arg) {
    if (U.isIPv4(arg)) return [arg];
    const r = ctx.net.resolve(ctx.machine, arg);
    if (!r) return [];
    if (r.source !== 'dns') return [r.ip];
    const all = ctx.net.dns(ctx.machine, r.name, 'A').answers.filter((a) => a.type === 'A').map((a) => a.data);
    return all.length ? all : [r.ip];
  }
  /* With no resolver configured the BIND tools fall back to localhost. */
  const systemServers = (machine) => (machine.dns.length ? machine.dns.slice() : ['127.0.0.1']);

  /** in-addr.arpa / ip6.arpa name for an address, or null for a malformed IPv6 address. */
  function reverseName(addr) {
    if (addr.indexOf(':') < 0) return addr.replace(/\.$/, '').split('.').reverse().join('.') + '.in-addr.arpa';
    const halves = addr.toLowerCase().split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves[1] ? halves[1].split(':') : [];
    const groups = head.concat(new Array(halves.length === 2 ? Math.max(8 - head.length - tail.length, 0) : 0).fill('0'), tail);
    if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
    return groups.map((g) => g.padStart(4, '0')).join('').split('').reverse().join('.') + '.ip6.arpa';
  }

  function headerLines(res, id, rd, additional) {
    const flags = ['qr'].concat(res.flags.aa ? ['aa'] : [], rd ? ['rd'] : [], res.flags.ra ? ['ra'] : []).join(' ');
    return ';; ->>HEADER<<- opcode: QUERY, status: ' + res.status + ', id: ' + id + '\n' +
      ';; flags: ' + flags + '; QUERY: 1, ANSWER: ' + res.answers.length + ', AUTHORITY: ' + res.authority.length + ', ADDITIONAL: ' + additional + '\n';
  }
  const queryId = (net) => Math.floor(net.rand() * 65536);
  const hex = (net, n) => Array.from({ length: n }, () => Math.floor(net.rand() * 16).toString(16)).join('');

  /* "Fri Nov 13 14:30:00 UTC 2026", strftime %a %b %d %H:%M:%S %Z %Y */
  function when(ms) {
    const d = new Date(ms);
    return U.DAYS[d.getUTCDay()] + ' ' + U.MONTHS[d.getUTCMonth()] + ' ' + U.pad2(d.getUTCDate()) + ' ' +
      [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map(U.pad2).join(':') + ' UTC ' + d.getUTCFullYear();
  }

  /* ---------------------------------------------------------------- dig */
  const DIG_USAGE = 'Usage:  dig [@global-server] [domain] [q-type] [q-class] {q-opt}\n' +
    '            {global-d-opt} host [@local-server] {local-d-opt}\n' +
    '            [ host [@local-server] {local-d-opt} [...]]\n';

  /* Every +keyword BIND 9.20 knows, so abbreviations are unique (or not) exactly as in the real dig. */
  const DIG_KEYWORDS = ('aaflag aaonly additional adflag all answer authority badcookie besteffort bufsize cdflag class cmd comments cookie crypto ' +
    'defname dns64prefix dnssec domain edns ednsflags ednsnegotiation ednsopt expandaaaa expire fail header-only https https-get https-post ' +
    'http-plain http-plain-get http-plain-post identify idnin idnout ignore keepalive keepopen mapped multiline ndots nsid nssearch onesoa opcode ' +
    'padding proxy proxy-plain qid qr question raflag rdflag recurse retry rrcomments search short showbadcookie showsearch split stats subnet ' +
    'tcflag tcp timeout tls tls-ca tls-certfile tls-hostname tls-keyfile trace tries ttlid ttlunits unknownformat vc yaml zflag').split(' ');
  /* Accepted, but with nothing to show for it in the simulated network. */
  const DIG_NO_EFFECT = ('aaflag aaonly adflag badcookie besteffort bufsize cdflag crypto domain ednsflags ednsnegotiation expandaaaa expire fail ' +
    'idnin idnout ignore keepalive keepopen mapped ndots nsid padding raflag rrcomments showbadcookie split subnet tcflag unknownformat zflag').split(' ');

  function digKeyword(key) {
    if (DIG_KEYWORDS.indexOf(key) >= 0) return key;
    const hits = DIG_KEYWORDS.filter((k) => k.startsWith(key));
    return hits.length === 1 ? hits[0] : null;
  }

  const digDefaults = () => ({
    type: 'A', cls: 'IN', server: null, port: 53, tcp: false, recurse: true, search: false, trace: false,
    question: true, answer: true, authority: true, additional: true, comments: true, stats: true, identify: false,
    edns: true, cookie: true, dnssec: false, showTtl: true, showClass: true, onesoa: false, tries: 3, timeout: 0, id: null,
    tcpSet: false,
  });

  /* dig sends ANY over TCP unless told otherwise, and prints a transfer without headers. */
  function digSetType(cur, type) {
    cur.type = type.toUpperCase();
    if (cur.type === 'ANY' && !cur.tcpSet) cur.tcp = true;
    if (cur.type === 'AXFR') cur.question = cur.comments = false;
  }

  /** Apply one +keyword[=value]. Returns null, or the text of the complaint. */
  function digPlus(cur, glob, word) {
    const eq = word.indexOf('=');
    const value = eq < 0 ? null : word.slice(eq + 1);
    let key = (eq < 0 ? word : word.slice(0, eq)).toLowerCase();
    const state = !key.startsWith('no');
    if (!state) key = key.slice(2);
    const full = digKeyword(key);
    const invalid = 'Invalid option: +' + word;
    const number = (what) => {
      if (value === null) return invalid;
      if (!/^\d+$/.test(value)) return "invalid " + what + " '" + value + "': not a valid number\n" + "dig: Couldn't parse " + what;
      return null;
    };
    switch (full) {
      case 'all': cur.question = cur.answer = cur.authority = cur.additional = cur.comments = cur.stats = state; glob.cmd = state; return null;
      case 'answer': case 'authority': case 'additional': case 'question': case 'comments': case 'stats':
      case 'identify': case 'recurse': case 'search': case 'edns': case 'cookie': case 'dnssec': case 'onesoa':
        cur[full] = state; return null;
      case 'tcp': case 'vc': cur.tcp = state; cur.tcpSet = true; return null;
      case 'rdflag': cur.recurse = state; return null;
      case 'defname': cur.search = state; return null;
      case 'class': cur.showClass = state; return null;
      case 'ttlid': cur.showTtl = state; return null;
      case 'multiline': cur.multiline = state; return null;
      case 'cmd': glob.cmd = state; return null;
      case 'short':
        glob.short = state;
        if (state) { glob.cmd = false; cur.question = cur.authority = cur.additional = cur.comments = cur.stats = false; cur.answer = true; }
        return null;
      case 'trace':
        cur.trace = state;
        if (state) { cur.recurse = true; cur.identify = true; cur.comments = cur.stats = cur.additional = cur.question = false; cur.authority = true; }
        return null;
      case 'timeout': { const bad = number('timeout'); if (!bad) cur.timeout = Math.max(1, +value); return bad; }
      case 'tries': { const bad = number('tries'); if (!bad) cur.tries = Math.max(1, +value); return bad; }
      case 'retry': { const bad = number('retries'); if (!bad) cur.tries = +value + 1; return bad; }
      case 'qid': { const bad = number('qid'); if (!bad) cur.id = +value % 65536; return bad; }
      default: return full && DIG_NO_EFFECT.indexOf(full) >= 0 ? null : invalid;
    }
  }

  /**
   * dig's command line: options before the first name are global, later ones
   * belong to the lookup they follow. Returns { lookups, glob, greet } or { exit }.
   */
  function digParse(ctx) {
    const args = ctx.args;
    const glob = { cmd: true, short: false, usec: false };
    const lookups = []; let greet = null;
    const defaults = digDefaults(); let cur = defaults;
    const usage = (msg) => { ctx.err(msg + '\n' + DIG_USAGE + '\nUse "dig -h" (or "dig -h | more") for complete list of options\n'); return { exit: 1 }; };
    const begin = (fields) => {
      cur = Object.assign({}, defaults, fields);
      if (!greet) greet = { on: glob.cmd, server: defaults.server };
      lookups.push(cur);
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a[0] === '@' && a.length > 1) { cur.server = a.slice(1); continue; }
      if (a[0] === '+') {
        const bad = digPlus(cur, glob, a.slice(1));
        if (!bad) continue;
        if (bad.startsWith('Invalid')) return usage(bad);
        const lines = bad.split('\n'); ctx.println(lines[0]); ctx.eprintln(lines[1]); return { exit: 1 };
      }
      if (a[0] === '-' && a.length > 1) {
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          if ('46mr'.indexOf(ch) >= 0) continue;
          if (ch === 'u') { glob.usec = true; continue; }
          if (ch === 'h') { ctx.out(DIG_HELP); return { exit: 0 }; }
          if (ch === 'v') { ctx.eprintln('DiG ' + BIND); return { exit: 0 }; }
          if ('bcpqtx'.indexOf(ch) < 0) return usage('Invalid option: ' + a);
          const value = a.slice(j + 1) || args[++i];
          if (value === undefined) return usage('Invalid option: ' + a);
          if (ch === 'q') begin({ name: value });
          else if (ch === 't') { if (isType(value)) digSetType(cur, value); else ctx.eprintln(';; Warning, ignoring invalid type ' + value); }
          else if (ch === 'c') { if (classOf(value)) cur.cls = classOf(value); else ctx.eprintln(';; Warning, ignoring invalid class ' + value); }
          else if (ch === 'p') {
            if (!/^\d+$/.test(value) || +value > 65535) {
              ctx.println("invalid port number '" + value + "': " + (/^\d+$/.test(value) ? 'out of range' : 'not a valid number'));
              ctx.eprintln("dig: Couldn't parse port number"); return { exit: 1 };
            }
            cur.port = +value;
          } else if (ch === 'x') {
            const name = reverseName(value);
            if (!name || (value.indexOf(':') < 0 && !U.isIPv4(value))) { ctx.eprintln('Invalid IP address ' + value); return { exit: 1 }; }
            begin({ name, type: defaults.type === 'A' ? 'PTR' : defaults.type });
          }
          break;
        }
        continue;
      }
      if (isType(a)) digSetType(cur, a);
      else if (classOf(a)) cur.cls = classOf(a);
      else begin({ name: a });
    }
    if (!lookups.length) begin({ name: '.', type: 'NS' });
    return { lookups, glob, greet };
  }

  function digBanner(ctx, p, counts) {
    if (!p.greet.on) return '';
    const n = p.greet.server ? counts[p.greet.server] : 0;
    return '\n; <<>> DiG ' + BIND + ' <<>>' + ctx.args.map((a) => ' ' + a).join('') + '\n' +
      (n ? '; (' + n + ' server' + (n > 1 ? 's' : '') + ' found)\n' : '') + ';; global options: +cmd\n';
  }

  function section(title, lines, comments) {
    if (!lines.length) return '';
    return (comments ? ';; ' + title + ' SECTION:\n' : '') + lines.join('\n') + '\n' + (comments ? '\n' : '');
  }

  /* BIND answers with a server cookie; the public resolvers in the lab's internet do not. */
  function speaksCookies(net, ip) {
    const host = net.knownHost(ip);
    return !!host && net.servicesOf(host).some((s) => s.port === 53 && /BIND/.test(s.product || ''));
  }

  function digReply(ctx, p, lk, res, via) {
    if (p.glob.short) {
      const tail = lk.identify ? ' from server ' + via.ip + ' in ' + res.ms + ' ms.' : '';
      return res.answers.map((r) => rdata(r) + tail + '\n').join('');
    }
    const cookie = lk.edns && lk.cookie && speaksCookies(ctx.net, via.ip);
    let out = '';
    if (lk.comments) {
      out += ';; Got answer:\n' + headerLines(res, lk.id === null ? queryId(ctx.net) : lk.id, lk.recurse, res.additional.length + (lk.edns ? 1 : 0));
      if (lk.recurse && !res.flags.ra) out += ';; WARNING: recursion requested but not available\n';
      out += '\n';
      if (lk.edns) out += ';; OPT PSEUDOSECTION:\n; EDNS: version: 0, flags:' + (lk.dnssec ? ' do' : '') + '; udp: 1232\n';
      if (cookie) out += '; COOKIE: ' + hex(ctx.net, 16) + '01000000' + Math.floor(K.clock.now() / 1000).toString(16) + hex(ctx.net, 16) + ' (good)\n';
    }
    const line = (r) => recordLine(r, lk);
    if (lk.question) out += section('QUESTION', [questionLine(res.question, lk)], lk.comments);
    if (lk.answer) out += section('ANSWER', res.answers.map(line), lk.comments);
    if (lk.authority) out += section('AUTHORITY', res.authority.map(line), lk.comments);
    if (lk.additional) out += section('ADDITIONAL', res.additional.map(line), lk.comments);
    if (lk.stats) out += digStats(p, lk, via, res.ms, ';; MSG SIZE  rcvd: ' + replySize(res, lk.edns ? (cookie ? 39 : 11) : 0));
    return out;
  }

  function digStats(p, lk, via, ms, sizeLine) {
    return ';; Query time: ' + (p.glob.usec ? ms * 1000 + ' usec' : ms + ' msec') + '\n' +
      ';; SERVER: ' + via.ip + '#' + lk.port + '(' + via.arg + ') (' + (lk.tcp || lk.type === 'AXFR' ? 'TCP' : 'UDP') + ')\n' +
      ';; WHEN: ' + when(K.clock.now()) + '\n' + sizeLine + '\n\n';
  }

  const digQuestion = (lk, servers) => ({
    shown: lk.name, servers: servers.ips, arg: servers.arg, port: lk.port, tcp: lk.tcp, tries: lk.tries, timeout: lk.timeout || (lk.tcp ? 10 : 5),
  });
  async function digLookup(ctx, p, lk, servers, banner) {
    if (lk.type === 'AXFR') return digTransfer(ctx, p, lk, servers, banner);
    if (lk.trace) return digTrace(ctx, p, lk, servers, banner);
    const q = digQuestion(lk, servers);
    const res = await askNames(ctx, q, lk.search ? candidates(ctx.machine.search, lk.name) : [lk.name], sender(ctx, lk.type, lk.cls));
    ctx.out(banner());
    if (!res) { ctx.out(NO_SERVERS); return 9; }
    ctx.out(digReply(ctx, p, lk, res, { ip: res.server, arg: servers.arg || res.server }));
    return 0;
  }

  async function digTransfer(ctx, p, lk, servers, banner) {
    const q = Object.assign(digQuestion(lk, servers), { tcp: true, timeout: lk.timeout || 10 });
    const x = await ask(ctx, q, (ip) => Object.assign(ctx.net.axfr(ctx.machine, lk.name, ip), { server: ip }));
    ctx.out(banner());
    if (!x) { ctx.out(NO_SERVERS); return 9; }
    if (x.status !== 'OK') { ctx.out('; Transfer failed.\n'); return 0; }
    const records = lk.onesoa ? x.records.slice(0, -1) : x.records;
    if (p.glob.short) { ctx.out(records.map((r) => rdata(r) + '\n').join('')); return 0; }
    let out = lk.answer ? records.map((r) => recordLine(r, lk) + '\n').join('') : '';
    const zone = lk.name.toLowerCase().replace(/\.$/, '');
    if (lk.stats) out += digStats(p, lk, { ip: x.server, arg: servers.arg || x.server }, x.ms, ';; XFR size: ' + records.length + ' records (messages 1, bytes ' + wireSize(zone, records, 0) + ')');
    ctx.out(out);
    return 0;
  }

  /* --- +trace: the referrals from the root down, simplified to one server per step and no DNSSEC records */
  const GTLD_SERVERS = ROOT_SERVERS.map((n) => n.replace('root-servers', 'gtld-servers'));
  const tldServers = (tld) => (tld === 'com' || tld === 'net' ? GTLD_SERVERS : 'abcd'.split('').map((l) => l + '.nic.' + tld));
  const nsSet = (name, hosts) => hosts.map((data) => ({ name, type: 'NS', ttl: 172800, data }));

  function isLabOnly(net, name) {
    const zones = net.world.dns.zones;
    return Object.keys(zones).some((z) => zones[z].internal && (name === z || name.endsWith('.' + z)));
  }

  /**
   * The record sets a resolver meets on the way to `name`: one per referral,
   * ending in the answer or in the SOA of whoever says the name does not exist.
   */
  function referrals(ctx, lk, name, resolver) {
    const net = ctx.net;
    const labels = name ? name.split('.') : [];
    const final = query(ctx, name, lk.type, resolver);
    const answer = final.answers.length ? final.answers : final.authority;
    if (!labels.length) return [answer];
    const tld = labels[labels.length - 1];
    const day = new Date(K.clock.now()).toISOString().slice(0, 10).replace(/-/g, '');
    const soa = (owner, mname, rname) => [{ name: owner, type: 'SOA', ttl: owner ? 900 : 86400, data: mname + ' ' + rname + ' ' + day + '00 1800 900 604800 86400' }];
    if (isLabOnly(net, name) || (final.status !== 'NOERROR' && !net._publicName('nic.' + tld))) return [soa('', ROOT_SERVERS[0], 'nstld.verisign-grs.com')];
    const steps = [nsSet(tld, tldServers(tld))];
    if (labels.length === 1) return steps;
    if (final.status !== 'NOERROR') return steps.concat([soa(tld, tldServers(tld)[0], 'hostmaster.nic.' + tld)]);
    const apex = labels.slice(-2).join('.');
    const ns = query(ctx, apex, 'NS', resolver).answers.filter((r) => r.type === 'NS').map((r) => r.data);
    return steps.concat([nsSet(apex, ns.length ? ns : ['ns1.' + apex, 'ns2.' + apex]), answer]);
  }

  async function digTrace(ctx, p, lk, servers, banner) {
    const net = ctx.net;
    const name = lk.name.toLowerCase().replace(/\.$/, '');
    const q = digQuestion(lk, servers);
    const step = (asked, records, ip, label, ms) => records.map((r) => recordLine(r, lk) + '\n').join('') +
      ';; Received ' + wireSize(asked, records, 11) + ' bytes from ' + ip + '#' + lk.port + '(' + label + ') in ' + ms + ' ms\n\n';
    const hints = await ask(ctx, q, (ip) => query(ctx, '.', 'NS', ip));
    ctx.out(banner());
    if (!hints) { ctx.out(NO_SERVERS); return 9; }
    ctx.out(step('', hints.answers, hints.server, servers.arg || hints.server, hints.ms));
    let from = hints.answers;
    for (const records of from.length ? referrals(ctx, lk, name, hints.server) : []) {
      const label = from[Math.floor(net.rand() * from.length)].data;
      const addr = net.resolve(ctx.machine, label);
      if (!addr) { ctx.eprintln("dig: couldn't get address for '" + label + "': not found"); return 10; }
      const rt = net.route(ctx.machine, addr.ip);
      if (!rt.ok || !(rt.inet || rt.direct || rt.self)) {
        for (let i = 0; i < q.tries; i++) { await ctx.sleep(q.timeout * 1000); ctx.println(';; communications error to ' + addr.ip + '#53: timed out'); }
        ctx.out(NO_SERVERS); return 9;
      }
      const ms = Math.max(1, Math.round(net.jitter(rt.rtt, 4)));
      await ctx.sleep(ms);
      ctx.out(step(name, records, addr.ip, label, ms));
      from = records.filter((r) => r.type === 'NS');
    }
    return 0;
  }

  async function digRun(ctx) {
    const p = digParse(ctx);
    if (p.exit !== undefined) return p.exit;
    const counts = {}; const found = {};
    for (const arg of p.lookups.map((l) => l.server).concat([p.greet.server])) {
      if (!arg || found[arg]) continue;
      found[arg] = serverAddresses(ctx, arg); counts[arg] = found[arg].length;
      if (!found[arg].length) { ctx.eprintln("dig: couldn't get address for '" + arg + "': not found"); return 10; }
    }
    let pending = digBanner(ctx, p, counts);
    const banner = () => { const b = p.glob.short ? '' : pending; pending = ''; return b; };
    let code = 0;
    for (const lk of p.lookups) {
      const servers = lk.server ? { ips: found[lk.server], arg: lk.server } : { ips: systemServers(ctx.machine), arg: null };
      code = Math.max(code, await digLookup(ctx, p, lk, servers, banner));
    }
    return code;
  }

  const DIG_HELP = DIG_USAGE +
    'Where:  domain\t  is in the Domain Name System\n' +
    '        q-class  is one of (in,hs,ch,...) [default: in]\n' +
    '        q-type   is one of (a,any,mx,ns,soa,hinfo,axfr,txt,...) [default:a]\n' +
    '        q-opt    is one of:\n' +
    '                 -4                  (use IPv4 query transport only)\n' +
    '                 -6                  (use IPv6 query transport only)\n' +
    '                 -b address[#port]   (bind to source address/port)\n' +
    '                 -c class            (specify query class)\n' +
    '                 -m                  (enable memory usage debugging)\n' +
    '                 -p port             (specify port number)\n' +
    '                 -q name             (specify query name)\n' +
    '                 -r                  (do not read ~/.digrc)\n' +
    '                 -t type             (specify query type)\n' +
    '                 -u                  (display times in usec instead of msec)\n' +
    '                 -x dot-notation     (shortcut for reverse lookups)\n' +
    '        d-opt    is of the form +keyword[=value], where keyword is:\n' +
    '                 +[no]additional     (Control display of additional section)\n' +
    '                 +[no]all            (Set or clear all display flags)\n' +
    '                 +[no]answer         (Control display of answer section)\n' +
    '                 +[no]authority      (Control display of authority section)\n' +
    '                 +[no]class          (Control display of class in records)\n' +
    '                 +[no]cmd            (Control display of command line -\n' +
    '                                      global option)\n' +
    '                 +[no]comments       (Control display of packet header\n' +
    '                                      and section name comments)\n' +
    '                 +[no]cookie         (Add a COOKIE option to the request)\n' +
    '                 +[no]defname        (Use search list (+[no]search))\n' +
    '                 +[no]dnssec         (Request DNSSEC records)\n' +
    '                 +[no]edns[=###]     (Set EDNS version) [0]\n' +
    '                 +[no]identify       (ID responders in short answers)\n' +
    '                 +[no]onesoa         (AXFR prints only one soa record)\n' +
    '                 +qid=###            (Specify the query ID to use when sending\n' +
    '                                      queries)\n' +
    '                 +[no]question       (Control display of question section)\n' +
    '                 +[no]rdflag         (Recursive mode (+[no]recurse))\n' +
    '                 +[no]recurse        (Recursive mode (+[no]rdflag))\n' +
    '                 +retry=###          (Set number of UDP retries) [2]\n' +
    '                 +[no]search         (Set whether to use searchlist)\n' +
    '                 +[no]short          (Display nothing except short\n' +
    '                                      form of answers - global option)\n' +
    '                 +[no]stats          (Control display of statistics)\n' +
    '                 +[no]tcp            (TCP mode (+[no]vc))\n' +
    '                 +timeout=###        (Set query timeout) [5]\n' +
    '                 +[no]trace          (Trace delegation down from root [+dnssec])\n' +
    '                 +tries=###          (Set number of UDP attempts) [3]\n' +
    '                 +[no]ttlid          (Control display of ttls in records)\n' +
    '                 +[no]vc             (TCP mode (+[no]tcp))\n' +
    '        global d-opts and servers (before host name) affect all queries.\n' +
    '        local d-opts and servers (after host name) affect only that lookup.\n' +
    '        -h                           (print help and exit)\n' +
    '        -v                           (print version and exit)\n';

  K.cmd.register({
    name: 'dig', pkg: 'bind9-dnsutils', section: 1,
    summary: 'DNS lookup utility',
    synopsis: 'dig [@server] [-p port] [-t type] [-x addr] [name] [type] [class] [queryopt...]',
    man: 'DESCRIPTION\n       dig is a flexible tool for interrogating DNS name servers. It performs DNS lookups and displays the answers that are returned from the name server(s) that were queried. Unless it is told to query a specific name server, dig tries each of the servers listed in /etc/resolv.conf. With no arguments it asks for the NS records of the root.\n\nOPTIONS\n       @server\n              The name or IP address of the name server to query.\n       -p port\n              Send the query to a non-standard port on the server.\n       -t type\n              The resource record type to query: A, AAAA, MX, NS, TXT, SOA, CNAME, PTR, SRV, ANY, or AXFR for a zone transfer. The type may also be given as a plain argument.\n       -x addr\n              Reverse lookup: query the PTR record for an address.\n       -q name\n              The domain name to query, for names that look like a type.\n\nQUERY OPTIONS\n       +short Print only the answer data.\n       +noall +answer\n              Clear all display flags, then show only the answer section.\n       +nocmd, +nocomments, +noquestion, +nostats\n              Leave out the banner, the header comments, the question section or the statistics.\n       +tcp   Use TCP instead of UDP.\n       +trace Follow the delegation path from the root name servers down to the answer.\n       +norecurse\n              Do not ask the server to recurse.\n       +time=T, +tries=N\n              Timeout in seconds (default 5) and number of attempts (default 3).\n\nEXIT STATUS\n       0 on a reply (even NXDOMAIN), 1 for a usage error, 9 when no server answered, 10 for an internal error.\n\nEXAMPLES\n       dig web01.halcyon.lab\n              Look up the address of a lab host with the default resolver.\n       dig @10.10.10.53 halcyon.lab MX +short\n              Ask the lab name server for the mail exchangers and print only the data.\n       dig axfr halcyon.lab @10.10.10.53\n              Request a transfer of the whole zone.',
    run: digRun,
  });
  /* --------------------------------------------------------------- host */
  const HOST_USAGE = 'Usage: host [-aCdilrTvVw] [-c class] [-N ndots] [-t type] [-W time]\n' +
    '            [-R number] [-m flag] [-p port] hostname [server]\n' +
    '       -a is equivalent to -v -t ANY\n' +
    '       -A is like -a but omits RRSIG, NSEC, NSEC3\n' +
    '       -c specifies query class for non-IN data\n' +
    '       -C compares SOA records on authoritative nameservers\n' +
    '       -d is equivalent to -v\n' +
    '       -l lists all hosts in a domain, using AXFR\n' +
    '       -m set memory debugging flag (trace|record|usage)\n' +
    '       -N changes the number of dots allowed before root lookup is done\n' +
    '       -p specifies the port on the server to query\n' +
    '       -r disables recursive processing\n' +
    '       -R specifies number of retries for UDP packets\n' +
    '       -s a SERVFAIL response should stop query\n' +
    '       -t specifies the query type\n' +
    '       -T enables TCP/IP mode\n' +
    '       -U enables UDP mode\n' +
    '       -v enables verbose output\n' +
    '       -V print version number and exit\n' +
    '       -w specifies to wait forever for a reply\n' +
    '       -W specifies how long to wait for a reply\n' +
    '       -4 use IPv4 query transport only\n' +
    '       -6 use IPv6 query transport only\n';
  const HOST_PHRASE = { A: 'has address', AAAA: 'has IPv6 address', NS: 'name server', CNAME: 'is an alias for', PTR: 'domain name pointer', MX: 'mail is handled by', TXT: 'descriptive text', HINFO: 'host information' };
  const hostSays = (r) => r.name + ' ' + (HOST_PHRASE[r.type] || 'has ' + r.type + ' record') + ' ' + rdata(r) + '\n';

  /** host -v: the whole message, sections separated by blank lines, without EDNS. */
  function hostVerbose(ctx, res, st) {
    const sections = [['QUESTION', [questionLine(res.question, st)]], ['ANSWER', res.answers], ['AUTHORITY', res.authority], ['ADDITIONAL', res.additional]];
    return headerLines(res, queryId(ctx.net), st.recurse, res.additional.length) +
      sections.filter((x) => x[1].length).map((x) => '\n;; ' + x[0] + ' SECTION:\n' + x[1].map((r) => (typeof r === 'string' ? r : recordLine(r, st)) + '\n').join('')).join('') + '\n';
  }

  function hostOptions(ctx) {
    const g = K.getopt(ctx.args, { short: 'aAc:Cdlm:N:p:rR:st:TUvVwW:46' });
    const usage = () => { ctx.err(HOST_USAGE); return { exit: 1 }; };
    const fatal = (msg) => { ctx.eprintln('host: ' + msg); return { exit: 1 }; };
    if (g.err) { ctx.eprintln('host: ' + iscOptError(g.err)); return usage(); }
    if (g.opts.V) { ctx.eprintln('host ' + BIND); return { exit: 0 }; }
    if (!g.rest.length) return usage();
    const o = g.opts; const all = !!(o.a || o.A);
    const st = Object.assign({}, FULL, {
      name: g.rest[0], serverArg: g.rest[1] || null, verbose: !!(o.v || o.d || all), list: !!o.l, compare: !!o.C, all,
      type: null, recurse: !o.r, tcp: !!o.T && !o.U, port: 53, tries: 2, timeout: o.w ? 2147483 : 5,
    });
    if (o.t !== undefined) { if (!isType(o.t)) return fatal('invalid type: ' + o.t + '\n'); st.type = o.t.toUpperCase(); }
    if (o.c !== undefined) { if (!classOf(o.c)) return fatal('invalid class: ' + o.c + '\n'); st.cls = classOf(o.c); }
    for (const k of ['p', 'R', 'W']) if (o[k] !== undefined && !/^\d+$/.test(o[k])) return usage();
    if (o.p !== undefined) st.port = +o.p;
    if (o.R !== undefined) st.tries = Math.max(+o.R, 1) + 1;
    if (o.W !== undefined) st.timeout = Math.max(+o.W, 1);
    if (all && st.type !== 'AXFR') st.type = 'ANY';
    return { st };
  }

  async function hostRun(ctx) {
    const parsed = hostOptions(ctx);
    if (parsed.exit !== undefined) return parsed.exit;
    const st = parsed.st; const net = ctx.net;
    const servers = st.serverArg ? serverAddresses(ctx, st.serverArg) : systemServers(ctx.machine);
    if (!servers.length) { ctx.eprintln("host: couldn't get address for '" + st.serverArg + "': not found"); return 1; }
    const q = { shown: st.name, servers, arg: st.serverArg, port: st.port, tcp: st.tcp, tries: st.tries, timeout: st.timeout };
    let failed = false; let introduced = !st.serverArg;
    const trying = st.verbose ? (name) => ctx.println('Trying "' + name + '"') : null;

    /* One reply the way host prints it; `defaults` is the plain "host name" mode with its follow-up lookups. */
    const show = (res, defaults) => {
      let out = '';
      if (!introduced) { out += 'Using domain server:\nName: ' + st.serverArg + '\nAddress: ' + res.server + '#' + st.port + '\nAliases: \n\n'; introduced = true; }
      if (res.status !== 'NOERROR') {
        failed = true;
        out += 'Host ' + (isAddress(st.name) ? reverseName(st.name) + '.' : res.status === 'NXDOMAIN' ? st.name : res.question.name) + ' not found: ' + RCODES[res.status] + '(' + res.status + ')\n';
      } else if (st.verbose) out += hostVerbose(ctx, res, st);
      else {
        out += res.answers.map(hostSays).join('');
        if (!defaults && !res.answers.length) out += res.question.name + ' has no ' + res.question.type + ' record\n';
      }
      if (st.verbose) out += 'Received ' + replySize(res, 0) + ' bytes from ' + res.server + '#' + st.port + ' in ' + res.ms + ' ms\n';
      ctx.out(out);
    };
    const lookup = async (names, type, defaults) => {
      const res = await askNames(ctx, q, names, sender(ctx, type, st.cls), trying);
      if (res) show(res, defaults); else { failed = true; ctx.out(NO_SERVERS); }
      return res;
    };

    if (st.list || st.type === 'AXFR') {
      const x = await ask(ctx, Object.assign({}, q, { tcp: true }), (ip) => Object.assign(net.axfr(ctx.machine, st.name, ip), { server: ip }));
      if (!x) { ctx.out(NO_SERVERS); return 1; }
      const zone = st.name.toLowerCase().replace(/\.$/, '');
      const wanted = st.all ? () => true : st.type && st.type !== 'AXFR' ? (r) => r.type === st.type : (r) => ['A', 'AAAA', 'NS', 'PTR'].indexOf(r.type) >= 0;
      const status = x.status === 'OK' ? 'NOERROR' : x.status;
      if (trying) trying(zone);
      show({ status, server: x.server, ms: x.ms, flags: { aa: true, ra: false }, question: { name: zone, type: 'AXFR' }, answers: x.records.filter(wanted), authority: [], additional: [] }, true);
      if (status !== 'NOERROR') ctx.out('; Transfer failed.\n');
    } else if (st.compare) {
      const ns = await lookupQuiet(ctx, q, st.name, 'NS');
      if (!ns) { ctx.out(NO_SERVERS); return 1; }
      for (const r of ns.answers.filter((a) => a.type === 'NS')) {
        const addr = net.resolve(ctx.machine, r.data);
        const soa = addr && await lookupQuiet(ctx, Object.assign({}, q, { servers: [addr.ip] }), st.name, 'SOA');
        if (!soa) { failed = true; continue; }
        ctx.out(soa.answers.filter((a) => a.type === 'SOA').map((a) => 'Nameserver ' + addr.ip + ':\n\t' + hostSays(a)).join(''));
      }
    } else if (isAddress(st.name)) {
      await lookup([reverseName(st.name)], 'PTR', false);
    } else if (st.type) {
      await lookup(candidates(ctx.machine.search, st.name), st.type, false);
    } else {
      const first = await lookup(candidates(ctx.machine.search, st.name), 'A', true);
      if (first && first.status === 'NOERROR') for (const type of ['AAAA', 'MX']) await lookup([canonicalName(first)], type, true);
    }
    return failed ? 1 : 0;
  }
  const lookupQuiet = (ctx, q, name, type) => ask(ctx, q, (ip) => query(ctx, name, type, ip));

  K.cmd.register({
    name: 'host', pkg: 'bind9-host', section: 1,
    summary: 'DNS lookup utility',
    synopsis: 'host [-aCdlrTvVw] [-c class] [-N ndots] [-R number] [-t type] [-W wait] [-p port] {name} [server]',
    man: 'DESCRIPTION\n       host is a simple utility for performing DNS lookups. It is normally used to convert names to IP addresses and vice versa. name is the domain name that is to be looked up; an IPv4 or IPv6 address makes host perform a reverse lookup. server is an optional name or address of the name server to query instead of the ones in /etc/resolv.conf.\n\n       With no type given host asks for the A, AAAA and MX records of the name.\n\nOPTIONS\n       -t type\n              Query for records of this type: A, AAAA, CNAME, MX, NS, PTR, SOA, SRV, TXT, ANY.\n       -a     Equivalent to -v -t ANY.\n       -v     Verbose output, in the format dig uses.\n       -l     List the zone: host performs a zone transfer of name and prints the NS, PTR and address records. With -a all records are printed.\n       -C     Query the SOA record of the zone from each of its listed name servers.\n       -T     Use TCP instead of UDP.\n       -r     Non-recursive query.\n       -R number, -W wait\n              Number of retries (default 1) and seconds to wait for a reply (default 5).\n       -V     Print the version number and exit.\n\nEXIT STATUS\n       0 when the lookup succeeded, 1 otherwise.\n\nEXAMPLES\n       host www.halcyon.lab\n              Print the alias and the address behind it.\n       host -t mx halcyon.lab 10.10.10.53\n              Ask the lab name server who handles mail for the domain.\n       host -l halcyon.lab 10.10.10.53\n              List the hosts in the zone by zone transfer.',
    run: hostRun,
  });

  /* ----------------------------------------------------------- nslookup */
  const NS_PHRASE = { A: 'internet address', AAAA: 'has AAAA address', NS: 'nameserver', CNAME: 'canonical name', PTR: 'name', MX: 'mail exchanger', TXT: 'text', SRV: 'service' };

  function nsRecords(records, inAnswer) {
    return records.map((r) => {
      if (inAnswer && (r.type === 'A' || r.type === 'AAAA')) return 'Name:\t' + r.name + '\nAddress: ' + r.data + '\n';
      if (r.type !== 'SOA') return r.name + '\t' + (NS_PHRASE[r.type] || r.type.toLowerCase()) + ' = ' + rdata(r) + '\n';
      const f = r.data.split(' ');
      return (r.name || '.') + '\n' + ['origin', 'mail addr', 'serial', 'refresh', 'retry', 'expire', 'minimum'].map((label, i) => '\t' + label + ' = ' + f[i] + '\n').join('');
    }).join('');
  }

  /** `set` keywords and their abbreviations, as nslookup's setoption() accepts them. */
  function nsOption(ctx, st, opt) {
    const eq = opt.indexOf('=');
    const key = (eq < 0 ? opt : opt.slice(0, eq)).toLowerCase();
    const value = eq < 0 ? null : opt.slice(eq + 1);
    const flag = (word, min) => value === null && key.length >= min && word.startsWith(key);
    const number = (what, max) => {
      if (/^\d+$/.test(value) && +value <= max) return true;
      ctx.println('invalid ' + what + " '" + value + "': " + (/^\d+$/.test(value) ? 'out of range' : 'not a valid number'));
      return false;
    };
    if (flag('all', 3)) return nsSettings(ctx, st, true);
    if (value !== null) {
      switch (key) {
        case 'type': case 'ty': case 'querytype': case 'query': case 'qu': case 'q':
          if (isType(value)) { st.type = value.toUpperCase(); st.defaults = false; } else ctx.println('unknown query type: ' + value);
          return undefined;
        case 'class': case 'cl': if (classOf(value)) st.cls = classOf(value); else ctx.println('unknown query class: ' + value); return undefined;
        case 'port': case 'po': if (number('port', 65535)) st.port = +value; return undefined;
        case 'timeout': case 't': if (number('timeout', 65535)) st.timeout = +value; return undefined;
        case 'retry': case 'ret': if (number('tries', 65535)) st.tries = +value; return undefined;
        case 'domain': case 'do': st.searchList = [value]; st.search = true; return undefined;
        case 'ndots': number('ndots', 255); return undefined;
        default:
      }
    }
    if (flag('recurse', 3) || flag('norecurse', 5)) st.recurse = key[0] !== 'n';
    else if (flag('search', 3) || flag('nosearch', 5) || flag('defname', 3) || flag('nodefname', 5)) st.search = key[0] !== 'n';
    else if (flag('vc', 2) || flag('novc', 4)) st.tcp = key[0] !== 'n';
    else if (!(flag('nodebug', 5) || flag('nod2', 4) || flag('fail', 3) || flag('nofail', 5) || flag('sil', 3))) ctx.println('*** Invalid option: ' + opt);
    return undefined;
  }

  function nsSettings(ctx, st, full) {
    let out = st.servers.map((ip) => 'Default server: ' + (st.arg || ip) + '\nAddress: ' + ip + '#' + st.port + '\n').join('');
    if (full) {
      out += '\nSet options:\n  ' + (st.tcp ? 'vc' : 'novc') + '\t\t\tnodebug\t\tnod2\n' +
        '  ' + (st.search ? 'search' : 'nosearch') + '\t\t' + (st.recurse ? 'recurse' : 'norecurse') + '\n' +
        '  timeout = ' + st.timeout + '\t\tretry = ' + st.tries + '\tport = ' + st.port + '\tndots = 1\n' +
        '  querytype = ' + st.type.padEnd(8) + '\tclass = ' + st.cls + '\n  srchlist = ' + st.searchList.join('/') + '\n';
    }
    ctx.out(out);
  }

  /** Point nslookup at another server. False (after the fatal message) when it has no address. */
  function nsServer(ctx, st, arg) {
    const addrs = serverAddresses(ctx, arg);
    if (!addrs.length) { ctx.eprintln("nslookup: couldn't get address for '" + arg + "': not found"); return false; }
    st.servers = addrs; st.arg = arg;
    return true;
  }

  /** One lookup as nslookup prints it; plain name lookups ask for A, then AAAA. */
  async function nsLookup(ctx, st, text, type) {
    const q = { shown: text, servers: st.servers, arg: st.arg, port: st.port, tcp: st.tcp, tries: st.tries, timeout: st.timeout || 5 };
    const fail = (out) => { ctx.out(out); st.failed = true; };
    const reverse = (type === 'A' || type === 'AAAA') && isAddress(text);
    if (reverse) type = 'PTR';
    let names = reverse ? [reverseName(text)] : st.search ? candidates(st.searchList, text) : [text];
    let noAddress = false;
    for (const asking of (st.defaults && type === 'A' ? ['A', 'AAAA'] : [type])) {
      const res = await askNames(ctx, q, names, sender(ctx, asking, st.cls));
      if (!res) return fail(NO_SERVERS);
      st.reached = true;
      const lead = !st.defaults || asking === 'A';
      let out = lead ? 'Server:\t\t' + (st.arg || res.server) + '\nAddress:\t' + res.server + '#' + st.port + '\n\n' : '';
      if (res.status !== 'NOERROR') return fail(out + "** server can't find " + res.question.name + ': ' + res.status + '\n');
      if (!res.flags.aa && lead) out += 'Non-authoritative answer:\n';
      if (res.answers.length) out += nsRecords(res.answers, true);
      else if (st.defaults && asking === 'A') noAddress = true;
      else if (!st.defaults || noAddress) out += "*** Can't find " + text + ': No answer\n';
      if (!res.flags.aa && asking !== 'A' && asking !== 'AAAA') out += '\nAuthoritative answers can be found from:\n' + nsRecords(res.authority, false) + nsRecords(res.additional, false);
      ctx.out(out);
      text = canonicalName(res); names = [text];
    }
    return undefined;
  }

  async function nsInteractive(ctx, st) {
    for (;;) {
      if (ctx.stdin !== null) ctx.out('> ');
      const line = await ctx.readLine('> ');
      if (line === null) break;
      const words = line.trim().split(/\s+/);
      const verb = words[0].toLowerCase();
      if (!verb) continue;
      if (verb === 'exit') break;
      if (verb === 'server' || verb === 'lserver') {
        if (!words[1]) ctx.println('usage: server hostname');
        else if (!nsServer(ctx, st, words[1])) return false;
        else nsSettings(ctx, st, false);
      } else if (verb === 'set') nsOption(ctx, st, words[1] || '');
      else if (['help', '?', 'ls', 'finger', 'root', 'view'].indexOf(verb) >= 0) ctx.println("The '" + words[0] + "' command is not yet implemented.");
      else await nsLookup(ctx, st, words[0], st.type);
    }
    return true;
  }

  async function nslookupRun(ctx) {
    const st = {
      type: 'A', defaults: true, cls: 'IN', port: 53, timeout: 0, tries: 3, recurse: true, tcp: false, search: true,
      searchList: (ctx.machine.search || []).slice(), servers: systemServers(ctx.machine), arg: null, reached: false, failed: false,
    };
    let target = null; let interactive = true;
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (/^-ver/i.test(a)) { ctx.eprintln('nslookup ' + BIND); return 0; }
      if (a[0] === '-' && a.length > 1) nsOption(ctx, st, a.slice(1));
      else if (a === '-' && !target) target = { interactive: true };
      else if (!target) { target = { name: a, type: st.type }; interactive = false; }
      else if (i + 1 < ctx.args.length) {
        ctx.err('Usage:\n   nslookup [-opt ...]             # interactive mode using default server\n   nslookup [-opt ...] - server    # interactive mode using \'server\'\n' +
          '   nslookup [-opt ...] host        # just look up \'host\' using default server\n   nslookup [-opt ...] host server # just look up \'host\' using \'server\'\n');
        return 1;
      } else if (!nsServer(ctx, st, a)) return 1;
    }
    if (!interactive) await nsLookup(ctx, st, target.name, target.type);
    else if (!await nsInteractive(ctx, st)) return 1;
    ctx.out('\n');
    return st.failed || !st.reached ? 1 : 0;
  }

  K.cmd.register({
    name: 'nslookup', pkg: 'bind9-dnsutils', section: 1,
    summary: 'query Internet name servers interactively',
    synopsis: 'nslookup [-option] [name | -] [server]',
    man: 'DESCRIPTION\n       nslookup is a program to query Internet domain name servers. It has two modes: interactive and non-interactive. Interactive mode is entered when no arguments are given, or when the first argument is a hyphen (-) and the second argument is the name or address of a name server. Non-interactive mode prints just the name and requested information for a host or domain.\n\n       An answer that does not come from a server that is authoritative for the name is introduced by "Non-authoritative answer:".\n\nOPTIONS\n       -type=TYPE, -query=TYPE, -q=TYPE\n              Change the type of the information query: A, AAAA, CNAME, MX, NS, PTR, SOA, SRV, TXT, ANY.\n       -port=N, -timeout=N, -retry=N\n              Server port (53), seconds to wait for a reply (5) and number of tries (3).\n       -norecurse, -vc, -nosearch\n              Do not ask for recursion, use TCP, do not use the search list.\n       -version\n              Print the version and exit.\n\nINTERACTIVE COMMANDS\n       host   Look up information for host using the current default server.\n       server domain\n              Change the default server to domain.\n       set keyword[=value]\n              Change state information; "set all" prints the current values, "set type=mx" changes the query type.\n       exit   Exit the program.\n\nEXAMPLES\n       nslookup web01.halcyon.lab\n              Look up a lab host with the default server.\n       nslookup -type=mx halcyon.lab 10.10.10.53\n              Ask the lab name server for the mail exchangers of the domain.',
    run: nslookupRun,
  });
  /* -------------------------------------------------------------- whois */
  const WHOIS_USAGE = 'Usage: whois [OPTION]... OBJECT...\n\n' +
    '-h HOST, --host HOST   connect to server HOST\n' +
    '-p PORT, --port PORT   connect to PORT\n' +
    '-I                     query whois.iana.org and follow its referral\n' +
    '-H                     hide legal disclaimers\n' +
    '      --verbose        explain what is being done\n' +
    '      --no-recursion   disable recursion from registry to registrar servers\n' +
    '      --help           display this help and exit\n' +
    '      --version        output version information and exit\n' +
    '\n' +
    'These flags are supported by whois.ripe.net and some RIPE-like servers:\n' +
    '-l                     find the one level less specific match\n' +
    '-L                     find all levels less specific matches\n' +
    '-m                     find all one level more specific matches\n' +
    '-M                     find all levels of more specific matches\n' +
    '-c                     find the smallest match containing a mnt-irt attribute\n' +
    '-x                     exact match\n' +
    '-b                     return brief IP address ranges with abuse contact\n' +
    '-B                     turn off object filtering (show email addresses)\n' +
    '-G                     turn off grouping of associated objects\n' +
    '-d                     return DNS reverse delegation objects too\n' +
    '-i ATTR[,ATTR]...      do an inverse look-up for specified ATTRibutes\n' +
    '-T TYPE[,TYPE]...      only look for objects of TYPE\n' +
    '-K                     only primary keys are returned\n' +
    '-r                     turn off recursive look-ups for contact information\n' +
    '-R                     force to show local copy of the domain object even\n' +
    '                       if it contains referral\n' +
    '-a                     also search all the mirrored databases\n' +
    '-s SOURCE[,SOURCE]...  search the database mirrored from SOURCE\n' +
    '-g SOURCE:FIRST-LAST   find updates from SOURCE from serial FIRST to LAST\n' +
    '-t TYPE                request template for object of TYPE\n' +
    '-v TYPE                request verbose template for object of TYPE\n' +
    '-q [version|sources|types]  query specified server info\n';

  const REDACTED = 'REDACTED FOR PRIVACY';
  const SIMULATED = 'This record is simulated by Kalima for training. It does not describe a real registration.';
  const WHOIS_HOSTS = { com: 'whois.verisign-grs.com', net: 'whois.verisign-grs.com', org: 'whois.publicinterestregistry.org', edu: 'whois.educause.edu', de: 'whois.denic.de' };
  const IANA_RESERVED = ['example.com', 'example.net', 'example.org'];
  const SECOND_LEVEL = ['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'ne.jp', 'or.jp'];
  const COUNTRY = { uk: 'GB', de: 'DE', fr: 'FR', nl: 'NL', ca: 'CA', au: 'AU', jp: 'JP' };
  const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const day = (ms) => stamp(ms).slice(0, 10);

  /** The part of a host name a registry sells: two labels, or three under a second-level suffix. */
  function registrable(name) {
    const labels = name.split('.');
    return labels.slice(SECOND_LEVEL.indexOf(labels.slice(-2).join('.')) >= 0 ? -3 : -2).join('.');
  }

  /** A stable invented registration for a public domain that has no curated record. */
  function inventedRegistration(domain, now) {
    const h = U.hash32('whois:' + domain);
    const born = new Date(Date.UTC(1996 + h % 26, (h >>> 5) % 12, 1 + (h >>> 9) % 28, (h >>> 14) % 24, (h >>> 19) % 60, (h >>> 25) % 60));
    const renewal = (year) => new Date(born).setUTCFullYear(year);
    const thisYear = new Date(now).getUTCFullYear();
    return {
      registrar: 'Simulated Registrar, Inc.', abuse: 'abuse@simulated-registrar.example', org: REDACTED, state: REDACTED,
      country: COUNTRY[domain.split('.').pop()] || 'US', ns: ['NS1.' + domain.toUpperCase(), 'NS2.' + domain.toUpperCase()],
      created: stamp(born.getTime()), updated: stamp(now - (20 + h % 300) * 86400000 - h % 86400000),
      expires: stamp(renewal(thisYear) > now ? renewal(thisYear) : renewal(thisYear + 1)),
    };
  }

  const domainFooter = (now, hide) => '>>> Last update of WHOIS database: ' + stamp(now - 41000) + ' <<<\n\n' +
    'For more information on Whois status codes, please visit https://icann.org/epp\n\nNOTICE: ' + SIMULATED + '\n' +
    (hide ? '' : '\nTERMS OF USE: You are not authorized to access or query our Whois database through the use\n' +
      'of electronic processes that are high-volume and automated. Whois data is provided for\ninformation purposes only, to assist persons in obtaining information about or related\n' +
      'to a domain name registration record. The registry does not guarantee its accuracy.\n');

  function domainRecord(domain, info, now, hide) {
    const name = domain.toUpperCase();
    const registrarHost = info.abuse.split('@')[1];
    const contact = (role) => ['Registry ' + role + ' ID', role + ' Name', role + ' Organization', role + ' Street', role + ' City', role + ' State/Province',
      role + ' Postal Code', role + ' Country', role + ' Phone', role + ' Email'].map((label) => [label, REDACTED]);
    const registrant = contact('Registrant');
    registrant[2][1] = info.org; registrant[5][1] = info.state; registrant[7][1] = info.country;
    const fields = [
      ['Domain Name', name], ['Registry Domain ID', U.hash32('roid:' + domain) + '_DOMAIN_' + name.split('.').pop() + '-SIM'],
      ['Registrar WHOIS Server', 'whois.' + registrarHost], ['Registrar URL', 'http://www.' + registrarHost],
      ['Updated Date', info.updated], ['Creation Date', info.created], ['Registry Expiry Date', info.expires],
      ['Registrar', info.registrar], ['Registrar IANA ID', '9999'], ['Registrar Abuse Contact Email', info.abuse], ['Registrar Abuse Contact Phone', REDACTED],
      ['Domain Status', 'clientTransferProhibited https://icann.org/epp#clientTransferProhibited'],
    ].concat(registrant, contact('Admin'), contact('Tech'), info.ns.map((ns) => ['Name Server', ns]),
      [['DNSSEC', 'unsigned'], ['URL of the ICANN Whois Inaccuracy Complaint Form', 'https://www.icann.org/wicf/']]);
    return fields.map((f) => f[0] + ': ' + f[1] + '\n').join('') + domainFooter(now, hide);
  }

  const ianaRecord = (domain) => '% IANA WHOIS server\n% for more information on IANA, visit http://www.iana.org\n% This query returned 1 object\n\n' +
    'domain:       ' + domain.toUpperCase() + '\n\norganisation: Internet Assigned Numbers Authority\n\ncreated:      1992-01-01\nsource:       IANA\n\n';

  /* --- address registries */
  const PRIVATE_USE = ['These addresses are in use by many millions of independently operated networks, which might be as small as a single computer connected to a home gateway, ' +
    'and are automatically configured in hundreds of millions of devices.  They are only intended for use within a private context  and traffic that needs to cross the Internet ' +
    'will need to use a different, unique address.', '',
  'These addresses can be used by anyone without any need to coordinate with IANA or an Internet registry.  The traffic from these addresses does not come from ICANN or IANA.  ' +
    'We are not the source of activity you may see on logs or in e-mail records.  Please refer to http://www.iana.org/abuse/answers', '',
  'These addresses were assigned by the IETF, the organization that develops Internet protocols, in the Best Current Practice document, RFC 1918 which can be found at:',
  'http://datatracker.ietf.org/doc/rfc1918'];
  const DOCUMENTATION = ['Addresses starting with "192.0.2.", "198.51.100.", or "203.0.113." are reserved for use in documentation and sample configurations.  ' +
    'They should never be used in a live network configuration.  No one has permission to use these addresses on the Internet.', '',
  'These addresses were assigned by the IETF, the organization that develops Internet protocols, in the Informational document RFC 5737, which can be found at:',
  'http://datatracker.ietf.org/doc/rfc5737'];
  const IANA_BLOCKS = [
    { cidr: '10.0.0.0/8', name: 'PRIVATE-ADDRESS-ABLK-RFC1918-IANA-RESERVED', comments: PRIVATE_USE },
    { cidr: '172.16.0.0/12', name: 'PRIVATE-ADDRESS-BBLK-RFC1918-IANA-RESERVED', comments: PRIVATE_USE },
    { cidr: '192.168.0.0/16', name: 'PRIVATE-ADDRESS-CBLK-RFC1918-IANA-RESERVED', comments: PRIVATE_USE },
    { cidr: '127.0.0.0/8', name: 'SPECIAL-IPV4-LOOPBACK-IANA-RESERVED', comments: ['Addresses starting with "127." are used when one program needs to talk to another program running on the same machine ' +
      'using the Internet Protocol.  127.0.0.1 is the most commonly used address and is called the "loopback" address.', '',
    'These addresses were assigned by the IETF, the organization that develops Internet protocols, in the Standard document, RFC 1122, which can be found at:', 'http://datatracker.ietf.org/doc/rfc1122'] },
    { cidr: '169.254.0.0/16', name: 'LINKLOCAL-RFC3927-IANA-RESERVED', comments: ['Addresses starting with "169.254." are used when a computer cannot obtain an address in any other way: ' +
      'it configures one for itself, valid only on the local link.', '',
    'These addresses were assigned by the IETF, the organization that develops Internet protocols, in the Standards Track document, RFC 3927, which can be found at:', 'http://datatracker.ietf.org/doc/rfc3927'] },
    { cidr: '100.64.0.0/10', name: 'SHARED-ADDRESS-SPACE-RFC6598-IANA-RESERVED', comments: ['This block is used as Shared Address Space by service providers that run carrier-grade NAT.  ' +
      'Traffic from these addresses does not come from IANA.', '',
    'These addresses were assigned by the IETF, the organization that develops Internet protocols, in the Best Current Practice document, RFC 6598, which can be found at:', 'http://datatracker.ietf.org/doc/rfc6598'] },
    { cidr: '192.0.2.0/24', name: 'TEST-NET-1', comments: DOCUMENTATION },
    { cidr: '198.51.100.0/24', name: 'TEST-NET-2', comments: DOCUMENTATION },
  ];
  const RIPE_OCTETS = [31, 37, 46, 62, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 109, 141, 145, 151, 176, 178, 185, 188, 193, 194, 195, 212, 213, 217];

  const arinTerms = (now) => '\n#\n# ARIN WHOIS data and services are subject to the Terms of Use\n# available at: https://www.arin.net/resources/registry/whois/tou/\n#\n' +
    '# If you see inaccuracies in the results, please report at\n# https://www.arin.net/resources/registry/whois/inaccuracy_reporting/\n#\n' +
    '# Copyright 1997-' + new Date(now).getUTCFullYear() + ', American Registry for Internet Numbers, Ltd.\n#\n\n';
  const arinPage = (body, now, hide) => (hide ? body : arinTerms(now) + '\n' + body + '\n' + arinTerms(now));
  const labelled = (fields, width) => fields.filter((f) => f[1] !== undefined).map((f) => (f[0] + ':').padEnd(width) + f[1] + '\n').join('');
  const dashed = (ip) => ip.replace(/\./g, '-');

  function arinNetwork(net, org) {
    const c = U.parseCidr(net.cidr); const first = U.intToIp(c.network);
    return labelled([['NetRange', first + ' - ' + U.intToIp(c.broadcast)], ['CIDR', net.cidr], ['NetName', net.name], ['NetHandle', 'NET-' + dashed(first) + '-1'],
      ['Parent', net.parent], ['NetType', net.type], ['OriginAS', net.origin], ['Organization', org.name + ' (' + org.id + ')'], ['RegDate', net.registered], ['Updated', net.updated]]
      .concat(net.comments.map((text) => ['Comment', text])), 16) + '\n\n' +
      labelled([['OrgName', org.name], ['OrgId', org.id], ['Address', org.address], ['City', org.city], ['StateProv', org.state], ['PostalCode', org.postal], ['Country', 'US'],
        ['RegDate', org.registered], ['Updated', org.updated]], 16) + '\n';
  }

  const ianaBlock = (block) => arinNetwork(
    { cidr: block.cidr, name: block.name, parent: ' ()', type: 'IANA Special Use', origin: '', registered: '', updated: '2024-05-24', comments: block.comments },
    { name: 'Internet Assigned Numbers Authority', id: 'IANA', registered: '', updated: '2024-05-24' });

  /* Every other address belongs to an invented operator; its allocation is the surrounding /16 (ARIN) or /24 (RIPE). */
  function inventedNetwork(ip, now) {
    const o = ip.split('.'); const h = U.hash32('net:' + o[0] + '.' + o[1]);
    return { o, tag: 'SIMNET-' + o[0] + '-' + o[1], asn: 'AS' + (64496 + h % 16), since: day(now - (1500 + h % 4000) * 86400000), changed: day(now - (30 + h % 700) * 86400000) };
  }
  function arinAllocation(ip, now) {
    const n = inventedNetwork(ip, now);
    return arinNetwork(
      { cidr: n.o[0] + '.' + n.o[1] + '.0.0/16', name: n.tag, parent: 'NET' + n.o[0] + ' (NET-' + n.o[0] + '-0-0-0-0)', type: 'Direct Allocation', origin: n.asn, registered: n.since, updated: n.changed,
        comments: [SIMULATED.replace('registration', 'network')] },
      { name: 'Simulated Network Operator ' + n.o[0] + '-' + n.o[1], id: n.tag, address: REDACTED, city: REDACTED, state: '', postal: '', registered: n.since, updated: n.changed }) +
      '\n' + labelled([['OrgAbuseHandle', 'ABUSE-' + n.tag], ['OrgAbuseName', 'Abuse Desk'], ['OrgAbusePhone', REDACTED], ['OrgAbuseEmail', 'abuse@' + n.tag.toLowerCase() + '.example']], 16) + '\n';
  }

  function ripeAllocation(ip, now, hide) {
    const n = inventedNetwork(ip, now);
    const base = n.o.slice(0, 3).join('.'); const range = base + '.0 - ' + base + '.255';
    const abuse = 'abuse@' + n.tag.toLowerCase() + '.example';
    const made = n.since + 'T09:41:27Z'; const touched = n.changed + 'T13:05:44Z';
    return '% This is the RIPE Database query service.\n% The objects are in RPSL format.\n%\n' +
      (hide ? '' : '% The RIPE Database is subject to Terms and Conditions.\n% See https://docs.db.ripe.net/terms-conditions.html\n') + '\n' +
      '% Note: this output has been filtered.\n%       To receive output for a database update, use the "-B" flag.\n\n' +
      "% Information related to '" + range + "'\n\n% Abuse contact for '" + range + "' is '" + abuse + "'\n\n" +
      labelled([['inetnum', range], ['netname', n.tag + '-' + n.o[2]], ['descr', 'Simulated network (Kalima training record, not a real assignment)'], ['country', 'NL'],
        ['admin-c', 'SIM' + n.o[0] + '-RIPE'], ['tech-c', 'SIM' + n.o[0] + '-RIPE'], ['status', 'ASSIGNED PA'], ['mnt-by', n.tag + '-MNT'], ['created', made], ['last-modified', touched], ['source', 'RIPE']], 16) + '\n' +
      labelled([['role', 'Simulated Network Operator ' + n.o[0] + '-' + n.o[1]], ['address', REDACTED], ['abuse-mailbox', abuse], ['nic-hdl', 'SIM' + n.o[0] + '-RIPE'], ['mnt-by', n.tag + '-MNT'],
        ['created', made], ['last-modified', touched], ['source', 'RIPE # Filtered']], 16) + '\n' +
      "% Information related to '" + base + '.0/24' + n.asn + "'\n\n" +
      labelled([['route', base + '.0/24'], ['origin', n.asn], ['mnt-by', n.tag + '-MNT'], ['created', made], ['last-modified', made], ['source', 'RIPE']], 16) + '\n' +
      '% This query was served by the RIPE Database Query Service version 1.114 (KALIMA-SIM)\n\n\n';
  }

  const APNIC_TEST_NET = '% [whois.apnic.net]\n% Whois data copyright terms    http://www.apnic.net/db/dbcopyright.html\n\n' +
    "% Information related to '203.0.113.0 - 203.0.113.255'\n\n" +
    labelled([['inetnum', '203.0.113.0 - 203.0.113.255'], ['netname', 'TEST-NET-3'], ['descr', 'IANA'], ['descr', 'RFC5737 Documentation Address Block'], ['country', 'AU'],
      ['status', 'ASSIGNED PORTABLE'], ['remarks', 'This block is reserved for use in documentation and'], ['remarks', 'should not be used in any real networks.'],
      ['remarks', 'Please see more details at'], ['remarks', 'http://www.iana.org/go/rfc5737'], ['source', 'APNIC']], 16) +
    '\n% This query was served by the APNIC Whois Service version 1.88 (KALIMA-SIM)\n\n\n';

  /**
   * Which registry answers for `object`, and with what: { server, query, body(hideLegal) }.
   * No server means the real client would not know where to ask either.
   */
  function whoisPlan(ctx, object) {
    const net = ctx.net; const now = K.clock.now();
    const text = object.toLowerCase().replace(/\.$/, '');
    const arin = (body) => ({ server: 'whois.arin.net', query: 'n + ' + object, body: (hide) => arinPage(body, now, hide) });
    if (U.parseCidr(text)) {
      const ip = text.split('/')[0];
      const special = IANA_BLOCKS.find((b) => U.inCidr(ip, b.cidr));
      if (special) return arin(ianaBlock(special));
      if (U.inCidr(ip, '203.0.113.0/24')) return { server: 'whois.apnic.net', query: object, body: () => APNIC_TEST_NET };
      if (RIPE_OCTETS.indexOf(+ip.split('.')[0]) >= 0) return { server: 'whois.ripe.net', query: '-V Md5.5.23 ' + object, body: (hide) => ripeAllocation(ip, now, hide) };
      return arin(arinAllocation(ip, now));
    }
    if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(text)) return arin('No match found for ' + object + '.\n\n');
    const tld = text.split('.').pop();
    if (!net._publicName('nic.' + tld)) return {};
    const server = WHOIS_HOSTS[tld] || 'whois.nic.' + tld;
    const query = (server === 'whois.verisign-grs.com' ? 'domain ' : '') + text;
    const curated = net.world.internet.whois[text];
    if (curated) return { server, query, body: (hide) => domainRecord(text, curated, now, hide) };
    if (IANA_RESERVED.indexOf(text) >= 0) return { server: 'whois.iana.org', query: text, body: () => ianaRecord(text) };
    if (registrable(text) !== text || !net._publicName(text)) return { server, query, body: (hide) => 'No match for domain "' + text.toUpperCase() + '".\n' + domainFooter(now, hide) };
    return { server, query, body: (hide) => domainRecord(text, inventedRegistration(text, now), now, hide) };
  }

  /** Open the connection to a whois server, or say why not. True when the query can be sent. */
  async function whoisConnect(ctx, host, port) {
    const net = ctx.net;
    const addr = net.resolve(ctx.machine, host);
    if (!addr) { ctx.eprintln('getaddrinfo(' + host + '): Name or service not known'); return false; }
    const rt = net.route(ctx.machine, addr.ip);
    if (!rt.ok) { ctx.eprintln('connect: ' + (rt.err === 'ENETUNREACH' ? 'Network is unreachable' : 'No route to host')); return false; }
    if (rt.inet) { await ctx.sleep(Math.round(net.jitter(180 + rt.rtt * 4, 120))); return true; }
    if (net.tcp(ctx.machine, addr.ip, port).state === 'closed') { ctx.eprintln('connect: Connection refused'); return false; }
    await ctx.sleep(60000);
    ctx.eprintln('Timeout.');
    return false;
  }

  async function whoisRun(ctx) {
    const g = K.getopt(ctx.args, { short: 'h:p:IHlLmMcxbBGdi:T:KrRas:g:t:v:q:', long: ['host=', 'port=', 'verbose', 'no-recursion', 'help', 'version'], alias: { host: 'h', port: 'p' } });
    if (g.err) { ctx.eprintln('whois: ' + g.err); ctx.err(WHOIS_USAGE); return 1; }
    if (g.opts.version) { ctx.out('Version 5.6.4.\n\nReport bugs to <md+whois@linux.it>.\n'); return 0; }
    if (g.opts.help) { ctx.out(WHOIS_USAGE); return 0; }
    if (!g.rest.length) { ctx.err(WHOIS_USAGE); return 1; }
    const port = g.opts.p === undefined ? 43 : +g.opts.p;
    if (!(port > 0 && port < 65536)) { ctx.eprintln('getaddrinfo(' + (g.opts.h || 'whois') + '): Servname not supported for ai_socktype'); return 2; }
    const object = g.rest.join(' ');
    const plan = whoisPlan(ctx, object);
    const server = g.opts.h || (g.opts.I ? 'whois.iana.org' : plan.server);
    if (!server) { ctx.println('No whois server is known for this kind of object.'); return 0; }
    if (g.opts.verbose) ctx.out('Using server ' + server + '.\nQuery string: "' + (plan.query || object) + '"\n\n');
    if (!await whoisConnect(ctx, server, port)) return 2;
    ctx.out(plan.body ? plan.body(!!g.opts.H) : '');
    return 0;
  }

  K.cmd.register({
    name: 'whois', pkg: 'whois', section: 1, only: 'kali',
    summary: 'client for the whois directory service',
    synopsis: 'whois [-h HOST] [-p PORT] [-H] [--verbose] OBJECT...',
    man: 'DESCRIPTION\n       whois searches for an object in a RFC 3912 database. This version of the whois client tries to guess the right server to ask for the specified object: the registry of the top-level domain for a domain name, a regional Internet registry (ARIN, RIPE, APNIC) for an IP address. If no guess can be made it prints "No whois server is known for this kind of object."\n\n       Registries only know registered domains (halcyonfreight.example), not host names below them, and nothing about private names such as the lab domain. The records in this lab are simulated: registrars are named as simulated and contact details are redacted.\n\nOPTIONS\n       -h HOST, --host HOST\n              Connect to HOST.\n       -p PORT, --port PORT\n              Connect to PORT.\n       -H     Do not display the legal disclaimers some registries like to show you.\n       -I     First query whois.iana.org and then follow its referral to the whois server authoritative for that request.\n       --verbose\n              Be verbose.\n       --help, --version\n              Display the usage or the version and exit.\n\n       Other options are passed to RIPE-like servers.\n\nEXIT STATUS\n       0 after a reply, 1 for a usage error, 2 when the server could not be reached.\n\nEXAMPLES\n       whois halcyonfreight.example\n              Registration record of the client\'s public domain: registrar, dates, name servers.\n       whois 203.0.113.10\n              Who is responsible for the network an address belongs to.',
    run: whoisRun,
  });
  /* --------------------------------------------------------- resolvectl */
  const SYSTEMD_VERSION = 'systemd 257 (257.9-1)\n+PAM +AUDIT +SELINUX +APPARMOR +IMA +IPE +SMACK +SECCOMP +GCRYPT -GNUTLS +OPENSSL +ACL +BLKID +CURL +ELFUTILS +FIDO2 +IDN2 -IDN +IPTC +KMOD ' +
    '+LIBCRYPTSETUP +LIBCRYPTSETUP_PLUGINS +LIBFDISK +PCRE2 +PWQUALITY +P11KIT +QRENCODE +TPM2 +BZIP2 +LZ4 +XZ +ZLIB +ZSTD +BPF_FRAMEWORK +XKBCOMMON +UTMP +SYSVINIT +LIBARCHIVE\n';
  const RESOLVECTL_HELP = 'resolvectl [OPTIONS...] COMMAND ...\n\n' +
    'Send control commands to the network name resolution manager, or\nresolve domain names, IPv4 and IPv6 addresses, DNS records, and services.\n\n' +
    'Commands:\n' +
    '  query HOSTNAME|ADDRESS...    Resolve domain names, IPv4 and IPv6 addresses\n' +
    '  status [LINK...]             Show link and server status\n' +
    '  flush-caches                 Flush all local DNS caches\n' +
    '  dns [LINK]                   Get per-interface DNS server address\n' +
    '  domain [LINK]                Get per-interface search domain\n\n' +
    'Options:\n' +
    '  -h --help                    Show this help\n' +
    '     --version                 Show package version\n' +
    '     --no-pager                Do not pipe output into a pager\n' +
    '  -4                           Resolve IPv4 addresses\n' +
    '  -6                           Resolve IPv6 addresses\n' +
    '  -t --type=TYPE               Query RR with DNS type\n' +
    '     --legend=BOOL             Print headers and additional info (default: yes)\n\n' +
    'See the resolvectl(1) man page for details.\n';

  /* systemd-resolved numbers links the way the kernel does: lo is 1, the first NIC 2. */
  const links = (machine) => machine.ifaces.map((i, n) => Object.assign({ index: n + 1 }, i)).filter((i) => i.kind !== 'loopback');
  const linkUp = (i) => !!i.ip && i.state !== 'DOWN';

  /** Right-aligned "Field: value" rows under a heading, as `resolvectl status` prints them. */
  function statusBlock(ctx, heading, rows) {
    const width = Math.max.apply(null, rows.map((r) => r[0].length));
    return (ctx.isTTY ? K.c.sgr('0;1;39', heading) : heading) + '\n' + rows.map((r) => r[0].padStart(width) + ': ' + r[1] + '\n').join('');
  }
  function linkStatus(ctx, link) {
    const m = ctx.machine; const dns = linkUp(link) ? m.dns : [];
    const rows = [['Current Scopes', linkUp(link) ? (dns.length ? 'DNS ' : '') + 'LLMNR/IPv4' : 'none'],
      ['Protocols', (dns.length ? '+' : '-') + 'DefaultRoute +LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported']];
    if (dns.length) rows.push(['Current DNS Server', dns[0]], ['DNS Servers', dns.join(' ')]);
    if (dns.length && m.search.length) rows.push(['DNS Domain', m.search.join(' ')]);
    return statusBlock(ctx, 'Link ' + link.index + ' (' + link.name + ')', rows);
  }
  function globalStatus(ctx) {
    const m = ctx.machine;
    const rows = [['Protocols', '+LLMNR +mDNS -DNSOverTLS DNSSEC=no/unsupported'], ['resolv.conf mode', 'foreign']];
    if (m.dns.length) rows.push(['Current DNS Server', m.dns[0]], ['DNS Servers', m.dns.join(' ')]);
    if (m.search.length) rows.push(['DNS Domain', m.search.join(' ')]);
    return statusBlock(ctx, 'Global', rows);
  }

  function hostsFileAddress(machine, name) {
    let text = '';
    try { text = machine.vfs.read('/etc/hosts'); } catch (e) { return null; }
    for (const line of text.split('\n')) {
      const f = line.replace(/#.*/, '').trim().split(/\s+/);
      if (U.isIPv4(f[0]) && f.slice(1).some((n) => n.toLowerCase() === name)) return f[0];
    }
    return null;
  }

  /* format_timespan() with 100us accuracy: "2.3ms", "3ms", "640us" */
  function timespan(us) {
    if (us < 1000) return us + 'us';
    const tenth = Math.floor((us % 1000) / 100);
    return Math.floor(us / 1000) + (us % 1000 ? '.' + tenth : '') + 'ms';
  }

  /** resolvectl query for one name or address. True when it resolved. */
  async function resolvedQuery(ctx, name, o) {
    const m = ctx.machine; const net = ctx.net;
    const grey = (text) => (ctx.isTTY ? K.c.sgr('0;38;5;245', text) : text);
    const bright = (text) => (ctx.isTTY ? K.c.sgr('0;1;39', text) : text);
    const fail = (why) => { ctx.eprintln(name + ': resolve call failed: ' + why); return false; };
    const uplink = (links(m).find(linkUp) || {}).name;
    /* values on consecutive lines, the "-- link" comment starting in column 60 */
    const show = (label, values, via, synthetic, us, canonical) => {
      let out = values.map((v, n) => {
        const head = label === null ? '' : (n ? ' '.repeat(label.length + 1) : label + ':') + ' ';
        return head + bright(v) + (via ? ' '.repeat(Math.max(60 - head.length - v.length, 1)) + grey('-- link: ' + via) : '') + '\n';
      }).join('');
      if (canonical) out += ' '.repeat(label.length + 2) + '(' + canonical + ')\n';
      if (o.legend) {
        out += '\n' + grey('-- Information acquired via protocol DNS in ' + timespan(us) + '.') + '\n' +
          grey('-- Data is authenticated: ' + (synthetic ? 'yes' : 'no') + '; Data was acquired via local or encrypted transport: ' + (synthetic ? 'yes' : 'no')) + '\n' +
          grey('-- Data from: ' + (synthetic ? 'synthetic' : 'network')) + '\n';
      }
      ctx.out(out);
      return true;
    };
    const lower = name.toLowerCase().replace(/\.$/, '');
    const local = o.type || U.isIPv4(lower) ? null : lower === 'localhost' ? '127.0.0.1' : hostsFileAddress(m, lower);
    if (local) return show(name, [local], lower === 'localhost' ? 'lo' : null, true, 300 + Math.floor(net.rand() * 9) * 100);
    if (!m.dns.length || !uplink) return fail('No appropriate name servers or networks for name found');

    let us = 0;
    /* one question to the configured server; null (after the message) when it fails outright */
    const put = async (qname, type) => {
      const res = query(ctx, qname, type, m.dns[0]);
      if (res.status === 'TIMEOUT') { await ctx.sleep(10000); fail('All attempts to contact name servers or networks failed'); return null; }
      await ctx.sleep(res.ms);
      us += res.ms * 1000 + Math.floor(net.rand() * 10) * 100;
      if (res.status === 'NOERROR' || res.status === 'NXDOMAIN') return res;
      fail("Could not resolve '" + qname + "', server or network returned error " + res.status);
      return null;
    };
    const noRecord = (qname) => fail("Name '" + qname + "' does not have any RR of the requested type");

    if (o.type || U.isIPv4(lower)) {
      const qname = o.type ? lower : reverseName(lower);
      const type = o.type || 'PTR';
      const res = await put(qname, type);
      if (!res) return false;
      if (res.status === 'NXDOMAIN') return fail("Name '" + qname + "' not found");
      if (!res.answers.length) return noRecord(qname);
      if (!o.type) return show(name, res.answers.map((r) => r.data), uplink, false, us);
      return show(null, res.answers.map((r) => r.name + ' IN ' + r.type + ' ' + (r.type === 'MX' ? r.prio + ' ' : '') + r.data), uplink, false, us);
    }

    let names = lower.indexOf('.') >= 0 ? [lower] : m.search.map((domain) => lower + '.' + domain);
    let canonical = lower; const addresses = [];
    for (const type of o.families) {
      let res = null;
      for (const qname of names) {
        res = await put(qname, type);
        if (!res) return false;
        if (res.status === 'NOERROR') { names = [qname]; break; }
      }
      if (!res || res.status === 'NXDOMAIN') return fail("Name '" + lower + "' not found");
      canonical = canonicalName(res);
      for (const r of res.answers) if (r.type === type) addresses.push(r.data);
    }
    if (!addresses.length) return noRecord(names[0]);
    return show(name, addresses, uplink, false, us, canonical === lower ? null : canonical);
  }

  async function resolvectlRun(ctx) {
    const g = K.getopt(ctx.args, { short: 'h46t:', long: ['help', 'version', 'no-pager', 'type=', 'legend='], alias: { help: 'h', type: 't' } });
    if (g.err) { ctx.eprintln('resolvectl: ' + g.err); return 1; }
    if (g.opts.h) { ctx.out(RESOLVECTL_HELP); return 0; }
    if (g.opts.version) { ctx.out(SYSTEMD_VERSION); return 0; }
    const m = ctx.machine;
    const verb = g.rest[0] || 'status'; const rest = g.rest.slice(1);
    const pick = (name) => {
      const link = links(m).find((i) => i.name === name || String(i.index) === name);
      if (!link) ctx.eprintln('Failed to resolve interface "' + name + '": No such device');
      return link;
    };
    const head = (text) => (ctx.isTTY ? K.c.sgr('0;1;39', text) : text);
    if (verb === 'status') {
      if (!rest.length) { ctx.out([globalStatus(ctx)].concat(links(m).map((l) => linkStatus(ctx, l))).join('\n')); return 0; }
      const chosen = rest.map(pick);
      if (chosen.some((l) => !l)) return 1;
      ctx.out(chosen.map((l) => linkStatus(ctx, l)).join('\n'));
      return 0;
    }
    if (verb === 'dns' || verb === 'domain') {
      const value = (link) => (!link || linkUp(link) ? (verb === 'dns' ? m.dns : m.search) : []).map((v) => ' ' + v).join('');
      if (rest.length > 1) { ctx.eprintln('Too many arguments.'); return 1; }
      const only = rest.length ? pick(rest[0]) : null;
      if (rest.length && !only) return 1;
      const rows = only ? [only] : [null].concat(links(m));
      ctx.out(rows.map((l) => head(l ? 'Link ' + l.index + ' (' + l.name + ')' : 'Global') + ':' + value(l) + '\n').join(''));
      return 0;
    }
    if (verb === 'flush-caches') return rest.length ? (ctx.eprintln('Too many arguments.'), 1) : 0;
    if (verb !== 'query') { ctx.eprintln("Unknown command verb '" + verb + "'."); return 1; }
    if (!rest.length) { ctx.eprintln('Too few arguments.'); return 1; }
    const o = { type: null, families: g.opts['4'] ? ['A'] : g.opts['6'] ? ['AAAA'] : ['A', 'AAAA'], legend: !/^(no|false|0|off)$/i.test(g.opts.legend || 'yes') };
    if (g.opts.t !== undefined) {
      if (!isType(g.opts.t) || /^(AXFR|ANY)$/i.test(g.opts.t)) { ctx.eprintln('Failed to parse RR record type ' + g.opts.t); return 1; }
      o.type = g.opts.t.toUpperCase();
    }
    let ok = true;
    for (const name of rest) ok = await resolvedQuery(ctx, name, o) && ok;
    return ok ? 0 : 1;
  }

  K.cmd.register({
    name: 'resolvectl', pkg: 'systemd-resolved', section: 1, only: 'kali',
    summary: 'Resolve domain names, IPv4 and IPv6 addresses, DNS resource records, and services; introspect and reconfigure the DNS resolver',
    synopsis: 'resolvectl [OPTIONS...] {COMMAND} [NAME...]',
    man: 'DESCRIPTION\n       resolvectl may be used to resolve domain names, IPv4 and IPv6 addresses and DNS resource records with the systemd-resolved resolver service, and to show which DNS servers and search domains the system uses. Unlike dig it resolves the way programs on this machine do: /etc/hosts first, then the configured DNS servers, with the search domains applied to single-label names.\n\nCOMMANDS\n       query HOSTNAME|ADDRESS...\n              Resolve domain names and IPv4 addresses. Each result shows the link it was learned on.\n       status [LINK...]\n              Show the global and per-link DNS settings: servers, search domains and protocols. This is the default command.\n       dns [LINK], domain [LINK]\n              Show the DNS servers or the search domains.\n       flush-caches\n              Flush all local DNS caches.\n\nOPTIONS\n       -4, -6 Resolve only IPv4 or only IPv6 addresses.\n       -t TYPE, --type=TYPE\n              Look up the resource records of this type (A, MX, NS, TXT, ...) instead of addresses.\n       --legend=BOOL\n              Whether to print the "-- Information acquired" lines.\n       -h, --help; --version\n              Print a short help text or the version and exit.\n\nEXAMPLES\n       resolvectl status\n              Which DNS server and search domain is this machine using?\n       resolvectl query web01.halcyon.lab\n              Resolve a lab host through the system resolver.',
    run: resolvectlRun,
    complete(info) {
      if (info.index === 1) return ['query', 'status', 'dns', 'domain', 'flush-caches'];
      if (info.words[1] === 'query') return info.words[info.index - 1] === '-t' ? typesFor(info.cur) : knownNames();
      return links(info.machine).map((l) => l.name);
    },
  });

  /* --------------------------------------------------------- completion */
  /** Every name the simulated DNS can answer for: zone owners first, then the curated internet sites. */
  function knownNames() {
    const world = K.net.world; const names = [];
    for (const zone of Object.keys(world.dns.zones)) {
      names.push(zone);
      for (const r of world.dns.zones[zone].records) if (r.name !== '@') names.push(r.name + '.' + zone);
    }
    return Array.from(new Set(names.concat(world.internet.sites.map((s) => s.name)))).sort();
  }
  const knownServers = () => Object.keys(K.net.world.dns.servers).sort((a, b) => U.ipToInt(a) - U.ipToInt(b));
  /* Record types in the case the learner started typing. */
  const typesFor = (cur) => (/^[a-z]/.test(cur) ? RR_TYPES.map((t) => t.toLowerCase()) : RR_TYPES);
  const positionals = (info) => info.words.slice(1, info.index).filter((w) => w[0] !== '-' && info.words[info.words.indexOf(w) - 1] !== '-t').length;

  K.cmd.get('dig').complete = (info) => {
    const cur = info.cur; const prev = info.words[info.index - 1];
    if (cur[0] === '@') return knownServers().map((ip) => '@' + ip);
    if (cur[0] === '+') return DIG_KEYWORDS.filter((k) => digPlus(digDefaults(), {}, k + '=1') === null).map((k) => '+' + k);
    if (prev === '-t') return typesFor(cur);
    if (prev === '-x') return K.net.world.hosts.map((h) => h.ip);
    return knownNames().concat(typesFor(cur));
  };
  K.cmd.get('host').complete = (info) => {
    if (info.words[info.index - 1] === '-t') return typesFor(info.cur);
    return positionals(info) ? knownServers() : knownNames();
  };
  K.cmd.get('nslookup').complete = (info) => {
    const option = /^(-(?:type|querytype|query|q)=)/i.exec(info.cur);
    if (option) return typesFor(info.cur.slice(option[1].length)).map((t) => option[1] + t);
    return positionals(info) ? knownServers() : knownNames();
  };
  K.cmd.get('whois').complete = () => Object.keys(K.net.world.internet.whois)
    .concat(K.net.world.internet.sites.map((s) => s.name).filter((n) => registrable(n) === n && K.net._publicName(n))).sort();
})(typeof globalThis !== 'undefined' ? globalThis : this);
