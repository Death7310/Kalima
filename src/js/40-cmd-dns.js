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
    fields.push(r.type, rdata(r)); at.push(s[2], s[3]);
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
  function candidates(machine, name) {
    if (name.indexOf('.') >= 0) return [name];
    return (machine.search || []).map((s) => name + '.' + s).concat([name]);
  }

  /** Ask for each candidate name until one exists. Returns the last reply, or null when no server answered. */
  async function askNames(ctx, q, names, type) {
    let res = null;
    for (const name of names) {
      res = await ask(ctx, q, (ip) => query(ctx, name, type, ip));
      if (!res || res.status !== 'NXDOMAIN') break;
    }
    return res;
  }

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
          if ('4mr'.indexOf(ch) >= 0) continue;
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
            if (!name) { ctx.eprintln('Invalid IP address ' + value); return { exit: 1 }; }
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

  const digQuestion = (lk, servers) => ({
    shown: lk.name, servers: servers.ips, arg: servers.arg, port: lk.port, tcp: lk.tcp, tries: lk.tries, timeout: lk.timeout || (lk.tcp ? 10 : 5),
  });
  const NO_SERVERS = ';; no servers could be reached\n\n';

  async function digLookup(ctx, p, lk, servers, banner) {
    if (lk.type === 'AXFR') return digTransfer(ctx, p, lk, servers, banner);
    if (lk.trace) return digTrace(ctx, p, lk, servers, banner);
    const q = digQuestion(lk, servers);
    const res = lk.cls === 'IN' ? await askNames(ctx, q, lk.search ? candidates(ctx.machine, lk.name) : [lk.name], lk.type)
      : await ask(ctx, q, (ip) => chaosQuery(ctx, lk.name, lk.type, ip));
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
})(typeof globalThis !== 'undefined' ? globalThis : this);
