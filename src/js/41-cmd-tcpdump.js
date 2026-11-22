/* Kalima — packet capture pack: tcpdump.
 *
 * Packets come from the K.net.bus 'packet' stream (ping, TCP probes, HTTP exchanges, DNS
 * queries). While a capture runs on the lab segment it also generates gentle ambient
 * traffic (ARP, DNS, NTP, mDNS) so there is always something to read. Output follows
 * tcpdump 4.99 / libpcap 1.10.
 */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;

  const VERSION = ['tcpdump version 4.99.5', 'libpcap version 1.10.5 (with TPACKET_V3)', 'OpenSSL 3.5.1 1 Jul 2025'];
  const USAGE = [
    'Usage: tcpdump [-AbdDefhHIJKlLnNOpqStuUvxX#] [ -B size ] [ -c count ] [--count]',
    '\t\t[ -C file_size ] [ -E algo:secret ] [ -F file ] [ -G seconds ]',
    '\t\t[ -i interface ] [ --immediate-mode ] [ -j tstamptype ]',
    '\t\t[ -M secret ] [ --number ] [ --print ] [ -Q in|out|inout ]',
    '\t\t[ -r file ] [ -s snaplen ] [ -T type ] [ --version ]',
    '\t\t[ -V file ] [ -w file ] [ -W filecount ] [ -y datalinktype ]',
    '\t\t[ --time-stamp-precision precision ] [ --micro ] [ --nano ]',
    '\t\t[ -z postrotate-command ] [ -Z user ] [ expression ]',
  ].join('\n');

  const DEVICES = [
    ['eth0', '[Up, Running, Connected]'],
    ['any', '(Pseudo-device that captures on all interfaces) [Up, Running]'],
    ['lo', '[Up, Running, Loopback]'],
    ['bluetooth-monitor', '(Bluetooth Linux Monitor) [none]'],
    ['nflog', '(Linux netfilter log (NFLOG) interface) [none]'],
    ['nfqueue', '(Linux netfilter queue (NFQUEUE) interface) [none]'],
    ['dbus-system', '(D-Bus system bus) [none]'],
    ['dbus-session', '(D-Bus session bus) [none]'],
  ];

  // The names /etc/services gives to the ports a learner will meet.
  const SERVICES = {
    tcp: { 20: 'ftp-data', 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'domain', 80: 'http', 110: 'pop3', 111: 'sunrpc', 139: 'netbios-ssn', 143: 'imap', 389: 'ldap', 443: 'https', 445: 'microsoft-ds', 587: 'submission', 631: 'ipp', 873: 'rsync', 993: 'imaps', 995: 'pop3s', 3306: 'mysql', 5432: 'postgresql', 8080: 'http-alt' },
    udp: { 53: 'domain', 67: 'bootps', 68: 'bootpc', 69: 'tftp', 111: 'sunrpc', 123: 'ntp', 137: 'netbios-ns', 138: 'netbios-dgm', 161: 'snmp', 162: 'snmp-trap', 514: 'syslog', 631: 'ipp', 5353: 'mdns' },
  };
  const PORT_BY_NAME = {};
  for (const proto of ['tcp', 'udp']) for (const p of Object.keys(SERVICES[proto])) PORT_BY_NAME[SERVICES[proto][p]] = +p;

  const RESERVED_NAMES = { '224.0.0.251': 'mdns.mcast.net', '127.0.0.1': 'localhost' };
  const MAC_MDNS = '01:00:5e:00:00:fb';
  const MAC_BROADCAST = 'ff:ff:ff:ff:ff:ff';
  const TCP_BITS = { F: 1, S: 2, R: 4, P: 8, '.': 16 };

  class FilterError extends Error {}

  /* ---------------------------------------------------------------- filter */

  const KEYWORDS = new Set(['src', 'dst', 'host', 'net', 'port', 'portrange', 'tcp', 'udp', 'icmp', 'arp', 'ip', 'ip6', 'ether', 'not', 'and', 'or', 'broadcast', 'multicast', 'less', 'greater']);
  const PROTOS = new Set(['tcp', 'udp', 'icmp', 'arp', 'ip', 'ip6', 'ether']);

  /** Compile a pcap-filter expression into a predicate on packet records. */
  function compileFilter(machine, text) {
    const toks = text.match(/\(|\)|&&|\|\||!|[^\s()!&|]+/g) || [];
    let i = 0;
    const syntax = () => new FilterError('syntax error');
    const peek = () => toks[i];
    const isOp = (t) => t === 'and' || t === '&&' || t === 'or' || t === '||';

    const resolveHost = (name) => {
      if (U.isIPv4(name)) return name;
      const r = K.net.resolve(machine, name);
      if (!r) throw new FilterError("unknown host '" + name + "'");
      return r.ip;
    };
    const resolvePort = (v) => {
      if (/^\d+$/.test(v)) return +v;
      if (PORT_BY_NAME[v] == null) throw new FilterError("unknown port '" + v + "'");
      return PORT_BY_NAME[v];
    };
    const parseNet = (v) => {
      let cidr = v;
      if (peek() === 'mask') { i++; const m = toks[i++]; if (!m || !U.isIPv4(m)) throw syntax(); cidr = v + '/' + m.split('.').reduce((n, b) => n + (+b).toString(2).replace(/0/g, '').length, 0); }
      else if (!v.includes('/')) { const parts = v.split('.'); if (!parts.every((p) => /^\d+$/.test(p)) || parts.length > 4) throw new FilterError("unknown network '" + v + "'"); cidr = parts.concat(['0', '0', '0']).slice(0, 4).join('.') + '/' + parts.length * 8; }
      if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(cidr)) throw new FilterError("unknown network '" + v + "'");
      return cidr;
    };
    const side = (dir, a, b) => (p) => (dir === 'src' ? a(p) : dir === 'dst' ? b(p) : a(p) || b(p));

    // type predicates, built from a qualifier set and the value token
    function makeValue(q, v) {
      let pred;
      if (q.type === 'host' && q.proto === 'ether') {
        const mac = v.toLowerCase();
        pred = side(q.dir, (p) => p.smac === mac, (p) => p.dmac === mac);
      } else if (q.type === 'host') {
        const ip = resolveHost(v);
        pred = side(q.dir, (p) => p.src === ip, (p) => p.dst === ip);
      } else if (q.type === 'net') {
        const cidr = parseNet(v);
        pred = side(q.dir, (p) => U.inCidr(p.src, cidr), (p) => U.inCidr(p.dst, cidr));
      } else if (q.type === 'port') {
        const n = resolvePort(v);
        pred = side(q.dir, (p) => p.sport === n, (p) => p.dport === n);
      } else {
        const m = /^(\d+)-(\d+)$/.exec(v);
        if (!m) throw syntax();
        pred = side(q.dir, (p) => p.sport >= +m[1] && p.sport <= +m[2], (p) => p.dport >= +m[1] && p.dport <= +m[2]);
      }
      const proto = q.type === 'port' || q.type === 'portrange' ? (q.proto === 'tcp' || q.proto === 'udp' ? q.proto : null) : q.proto;
      const needPorts = q.type === 'port' || q.type === 'portrange';
      return (p) => pred(p) && (!needPorts || p.sport != null) && protoMatch(proto, p);
    }

    function protoMatch(proto, p) {
      if (!proto || proto === 'ether') return true;
      if (proto === 'ip') return p.proto !== 'ARP';
      if (proto === 'ip6') return false;
      return p.proto === proto.toUpperCase();
    }

    function parsePrimitive() {
      const q = { dir: null, proto: null, type: null };
      let t = peek();
      if (t === 'broadcast' || t === 'multicast') { i++; return t === 'broadcast' ? (p) => p.dmac === MAC_BROADCAST : (p) => p.dmac === MAC_MDNS; }
      if (t === 'less' || t === 'greater') {
        i++; const n = toks[i++];
        if (!/^\d+$/.test(n || '')) throw syntax();
        return t === 'less' ? (p) => p.wirelen <= +n : (p) => p.wirelen >= +n;
      }
      if (t === 'src' || t === 'dst') { q.dir = t; i++; t = peek(); }
      if (PROTOS.has(t)) { q.proto = t; i++; t = peek(); }
      if (!q.dir && (t === 'src' || t === 'dst')) { q.dir = t; i++; t = peek(); }
      if (t === 'host' || t === 'net' || t === 'port' || t === 'portrange') { q.type = t; i++; }
      else if (q.dir || !q.proto) {
        // "src 10.0.0.1" and a bare address both mean host
        if (t == null || KEYWORDS.has(t) || t === ')' || t === '(' || t === '!' || t === '&&' || t === '||') throw syntax();
        q.type = 'host';
      } else return protoPredicate(q.proto);
      const v = toks[i++];
      if (v == null || KEYWORDS.has(v) || v === '(' || v === ')') throw syntax();
      q.value = v;
      const pred = makeValue(q, v);
      pred.qual = q;
      return pred;
    }

    function protoPredicate(proto) { return (p) => protoMatch(proto, p); }

    function parseOperand(prev) {
      const t = peek();
      if (t == null) throw syntax();
      if (t === 'not' || t === '!') { i++; const e = parseOperand(prev); return (p) => !e(p); }
      if (t === '(') {
        i++;
        const e = parseExpr();
        if (peek() !== ')') throw syntax();
        i++;
        return e;
      }
      // "tcp port 80 or 22": a bare value repeats the previous qualifiers
      if (prev && prev.qual && prev.qual.type && !KEYWORDS.has(t) && t !== ')' && !isOp(t)) {
        i++;
        const pred = makeValue(prev.qual, t);
        pred.qual = prev.qual;
        return pred;
      }
      return parsePrimitive();
    }

    function parseExpr() {
      let left = parseOperand(null);
      while (i < toks.length && peek() !== ')') {
        const op = peek();
        if (!isOp(op)) throw syntax();
        i++;
        const right = parseOperand(left);
        const l = left;
        left = op === 'and' || op === '&&' ? (p) => l(p) && right(p) : (p) => l(p) || right(p);
        left.qual = right.qual;
      }
      return left;
    }

    if (!toks.length) return () => true;
    const pred = parseExpr();
    if (i < toks.length) throw syntax();
    return pred;
  }

  /* --------------------------------------------------------- packet records */

  /**
   * Turns bus packets into the records tcpdump prints: adds MAC addresses, IP header fields and
   * TCP sequence bookkeeping. Keeps per-flow state, so every packet must pass through it in order.
   */
  function makeEnricher(machine) {
    const eth = machine.ifaces.find((f) => f.kind === 'ether');
    const flows = new Map();
    const isLocal = (ip) => machine.ifaces.some((f) => f.ip === ip);
    const sameNet = (ip) => !!eth && U.inCidr(ip, eth.ip + '/' + eth.bits);
    const gwMac = () => { const gw = K.net.knownHost('10.10.10.1'); return gw && gw.mac ? gw.mac : '00:00:00:00:00:00'; };
    const macOf = (ip) => {
      if (ip === '127.0.0.1') return '00:00:00:00:00:00';
      if (isLocal(ip)) return eth.mac;
      const h = sameNet(ip) && K.net.knownHost(ip);
      return h && h.mac ? h.mac : gwMac();
    };
    const hostTtl = (ip) => {
      if (isLocal(ip)) return 64;
      const h = K.net.knownHost(ip);
      return ((h && h.os && h.os.ttl) || 64) - (sameNet(ip) ? 0 : 4 + (U.hash32(ip) % 10));
    };

    function flowState(p) {
      const a = p.src + ':' + p.sport; const b = p.dst + ':' + p.dport;
      const key = a < b ? a + '|' + b : b + '|' + a;
      let f = flows.get(key);
      if (!f) { f = { init: p.flags === 'S' ? a : b, dirs: {} }; flows.set(key, f); }
      for (const d of [a, b]) if (!f.dirs[d]) f.dirs[d] = { isn: U.hash32(d + '>' + (d === a ? b : a)), next: 0, known: false, tsval: 0 };
      return { f, mine: f.dirs[a], peer: f.dirs[b], a };
    }

    function tcpFields(p, rec) {
      const { f, mine, peer, a } = flowState(p);
      const flags = p.flags || '.';
      const plen = p.plen || 0;
      const syn = flags.includes('S');
      const rst = flags.includes('R');
      const tsval = ((U.hash32(p.src) + Math.floor(p.ts)) >>> 0) % 4294967296;
      const ecr = syn && !flags.includes('.') ? 0 : peer.tsval;
      mine.tsval = tsval;
      const seqRel = syn ? 0 : rst && !mine.known ? 0 : mine.next;
      const relative = mine.known && !syn;
      const hasAck = flags.includes('.');
      const ackRel = peer.next;
      rec.seqAbs = (mine.isn + seqRel) >>> 0;
      rec.ackAbs = hasAck ? (peer.isn + ackRel) >>> 0 : 0;
      let seq = '';
      if (syn) seq = String(rec.seqAbs);
      else if (plen) seq = (relative ? seqRel : rec.seqAbs) + ':' + ((relative ? seqRel : rec.seqAbs) + plen);
      else if (flags.includes('F') || rst) seq = String(relative || rst ? seqRel : rec.seqAbs);
      rec.seqText = seq;
      rec.ackText = !hasAck ? '' : syn || rst || !peer.known ? String(rec.ackAbs) : String(ackRel);
      rec.win = rst ? 0 : flags === 'S' ? 64240 : flags === 'S.' ? 65160 : f.init === a ? 502 : 509;
      rec.opts = rst ? '' : syn ? 'mss 1460,sackOK,TS val ' + tsval + ' ecr ' + ecr + ',nop,wscale 7' : 'nop,nop,TS val ' + tsval + ' ecr ' + ecr;
      rec.optBytes = rst ? [] : syn ? [2, 4, 5, 0xb4, 4, 2, 8, 10].concat(be32(tsval), be32(ecr), [1, 3, 3, 7]) : [1, 1, 8, 10].concat(be32(tsval), be32(ecr));
      rec.cksum = U.hash32(rec.seqAbs + ':' + p.dport + ':' + plen) & 0xffff;
      rec.iplen = 20 + 20 + rec.optBytes.length + plen;
      if (syn) { mine.known = true; mine.next = 1; } else mine.next += plen + (flags.includes('F') ? 1 : 0);
    }

    let counter = 0;
    return function enrich(p) {
      counter++;
      const rec = { ts: p.ts, proto: p.proto, src: p.src, dst: p.dst, sport: p.sport == null ? null : p.sport, dport: p.dport == null ? null : p.dport, dev: p.dev || 'eth0', ttl: hostTtl(p.src), id: U.hash32(p.src + ':' + counter) & 0xffff };
      if (p.proto === 'ARP') {
        // frames we send are 42 bytes; frames that arrive are padded to the 60-byte Ethernet minimum
        Object.assign(rec, { op: p.op, smac: p.smac, dmac: p.dmac, tmac: p.tmac || null, wirelen: isLocal(p.src) ? 42 : 60 });
        return rec;
      }
      rec.smac = p.smac || macOf(p.src);
      rec.dmac = p.dmac || macOf(p.dst);
      if (p.proto === 'TCP') {
        rec.flags = p.flags || '.'; rec.plen = p.plen || 0; rec.data = p.data || null;
        tcpFields(p, rec);
      } else if (p.proto === 'UDP') {
        rec.info = p.info || 'UDP, length 0'; rec.dns = !!p.dns;
        rec.ulen = p.ulen == null ? Math.max(0, (p.len || 28) - 28) : p.ulen;
        rec.iplen = 28 + rec.ulen;
      } else {
        rec.info = p.info || ''; rec.iplen = p.len || 84;
      }
      rec.wirelen = rec.iplen + 14;
      return rec;
    };
  }

  function be32(n) { return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function be16(n) { return [(n >>> 8) & 255, n & 255]; }

  /* ------------------------------------------------------------- formatting */

  function makeNamer(machine, o) {
    const cache = new Map();
    return {
      host(ip) {
        if (o.n) return ip;
        let n = cache.get(ip);
        if (n === undefined) {
          const h = K.net.knownHost(ip);
          n = RESERVED_NAMES[ip] || (machine.ifaces.some((f) => f.ip === ip) ? machine.hostname : h ? h.fqdn || h.hostname : null) || ip;
          cache.set(ip, n);
        }
        return n;
      },
      port(port, proto) { return o.n > 1 ? String(port) : SERVICES[proto.toLowerCase()][port] || String(port); },
    };
  }

  function two(n) { return String(n).padStart(2, '0'); }

  function stamp(rec, o, st) {
    if (o.t === 1) return '';
    const us = Math.round(rec.ts * 1000);
    const clockText = (v) => {
      const d = new Date(Math.floor(v / 1000));
      return two(d.getUTCHours()) + ':' + two(d.getUTCMinutes()) + ':' + two(d.getUTCSeconds()) + '.' + String(v % 1000000).padStart(6, '0');
    };
    let s;
    if (o.t === 2) s = Math.floor(us / 1e6) + '.' + String(us % 1e6).padStart(6, '0');
    else if (o.t === 3 || o.t === 5) {
      const ref = o.t === 3 ? st.prev : st.first;
      const diff = ref == null ? 0 : Math.max(0, us - ref);
      s = two(Math.floor(diff / 3.6e9)) + ':' + two(Math.floor(diff / 6e7) % 60) + ':' + two(Math.floor(diff / 1e6) % 60) + '.' + String(diff % 1e6).padStart(6, '0');
    } else if (o.t === 4) { const d = new Date(Math.floor(us / 1000)); s = d.getUTCFullYear() + '-' + two(d.getUTCMonth() + 1) + '-' + two(d.getUTCDate()) + ' ' + clockText(us); }
    else s = clockText(us);
    if (st.first == null) st.first = us;
    st.prev = us;
    return s + ' ';
  }

  const IP_PROTO = { TCP: 6, UDP: 17, ICMP: 1 };

  function arpText(rec, nm, o) {
    const len = rec.wirelen - 14;
    const body = rec.op === 'request'
      ? 'Request who-has ' + nm.host(rec.dst) + ' tell ' + nm.host(rec.src) + ', length ' + len
      : 'Reply ' + nm.host(rec.src) + ' is-at ' + rec.smac + ', length ' + len;
    return o.e ? body : 'ARP, ' + body;
  }

  function httpSuffix(rec) {
    if (!rec.data || (rec.sport !== 80 && rec.dport !== 80)) return '';
    const first = rec.data.split('\r\n')[0];
    return /^([A-Z]+ \S+ HTTP\/1\.[01]|HTTP\/1\.[01] \d{3}.*)$/.test(first) ? ': HTTP: ' + first : '';
  }

  /** The "src > dst: details" part of a line. */
  function flowText(rec, nm, o) {
    const ep = (ip, port) => nm.host(ip) + (port == null ? '' : '.' + nm.port(port, rec.proto));
    const head = ep(rec.src, rec.sport) + ' > ' + ep(rec.dst, rec.dport) + ': ';
    if (rec.proto === 'TCP') {
      if (o.q) return head + 'tcp ' + rec.plen;
      const parts = ['Flags [' + rec.flags + ']'];
      if (o.v) parts.push('cksum 0x' + rec.cksum.toString(16).padStart(4, '0') + ' (correct)');
      if (rec.seqText) parts.push('seq ' + (o.S ? rec.seqText.replace(/^\d+(?=:|$)/, String(rec.seqAbs)) : rec.seqText));
      if (rec.ackText) parts.push('ack ' + (o.S ? rec.ackAbs : rec.ackText));
      parts.push('win ' + rec.win);
      if (rec.opts) parts.push('options [' + rec.opts + ']');
      parts.push('length ' + rec.plen);
      return head + parts.join(', ') + httpSuffix(rec);
    }
    if (rec.proto === 'UDP') return head + (o.q ? 'UDP, length ' + rec.ulen : (o.v && rec.dns ? '[udp sum ok] ' : '') + rec.info);
    return head + 'ICMP ' + rec.info;
  }

  /** The full text of one packet (possibly several lines), without the trailing newline. */
  function formatPacket(rec, o, nm, st) {
    let line = stamp(rec, o, st);
    const out = rec.dir === 'Out' ? 'Out' : 'In ';
    if (o.cooked) line += rec.dev + '  ' + out + ' ' + (o.e ? 'ifindex 2 ' + rec.smac + ' ethertype ' + (rec.proto === 'ARP' ? 'ARP (0x0806)' : 'IPv4 (0x0800)') + ', length ' + rec.wirelen + ': ' : '');
    else if (o.e) line += rec.smac + ' > ' + rec.dmac + ', ethertype ' + (rec.proto === 'ARP' ? 'ARP (0x0806)' : 'IPv4 (0x0800)') + ', length ' + rec.wirelen + ': ';
    if (rec.proto === 'ARP') line += arpText(rec, nm, o);
    else if (o.v) {
      const df = rec.proto === 'UDP' || (rec.proto === 'ICMP' && rec.info.startsWith('echo reply')) ? 'none' : 'DF';
      line += 'IP (tos 0x0, ttl ' + rec.ttl + ', id ' + rec.id + ', offset 0, flags [' + df + '], proto ' + rec.proto + ' (' + IP_PROTO[rec.proto] + '), length ' + rec.iplen + ')\n    ' + flowText(rec, nm, o);
    } else line += 'IP ' + flowText(rec, nm, o);
    if (o.A || o.X || o.x) {
      const bytes = wireBytes(rec);
      if (o.A) line += '\n' + asciiDump(bytes) + '\n';
      else line += '\n' + hexDump(bytes, !o.xOnly);
    }
    return line;
  }

  /* ------------------------------------------------------------ packet bytes */

  function ipChecksum(h) {
    let sum = 0;
    for (let k = 0; k < h.length; k += 2) sum += (h[k] << 8) + h[k + 1];
    while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
    return ~sum & 0xffff;
  }

  /** Reconstruct the IP packet (headers and payload) a record stands for. */
  function wireBytes(rec) {
    const mac = (m) => m.split(':').map((h) => parseInt(h, 16));
    const ip4 = (a) => a.split('.').map(Number);
    if (rec.proto === 'ARP') {
      const reply = rec.op === 'reply';
      return [0, 1, 8, 0, 6, 4, 0, reply ? 2 : 1].concat(mac(rec.smac), ip4(rec.src), reply ? mac(rec.tmac || rec.dmac) : [0, 0, 0, 0, 0, 0], ip4(rec.dst));
    }
    let l4;
    if (rec.proto === 'TCP') {
      const payload = rec.data != null ? Array.from(U.toBytes(rec.data)) : Array.from({ length: rec.plen }, (v, k) => U.hash32(rec.seqAbs + ':' + k) & 255);
      const flagByte = rec.flags.split('').reduce((n, c) => n | TCP_BITS[c], 0);
      l4 = [].concat(be16(rec.sport), be16(rec.dport), be32(rec.seqAbs), be32(rec.ackAbs), [((20 + rec.optBytes.length) / 4) << 4, flagByte], be16(rec.win), be16(rec.cksum), [0, 0], rec.optBytes, payload);
    } else if (rec.proto === 'UDP') {
      const text = Array.from(U.toBytes(rec.info)).slice(0, Math.max(0, rec.ulen));
      l4 = [].concat(be16(rec.sport), be16(rec.dport), be16(rec.ulen + 8), be16(U.hash32(rec.info) & 0xffff), text.concat(Array(Math.max(0, rec.ulen - text.length)).fill(0)));
    } else {
      const m = /^echo (request|reply), id (\d+), seq (\d+), length (\d+)/.exec(rec.info);
      const n = m ? +m[4] - 8 : 0;
      const body = Array.from({ length: n }, (v, k) => (k < 8 ? 0 : 0x10 + k - 8));
      l4 = [m && m[1] === 'reply' ? 0 : 8, 0, 0, 0].concat(be16(m ? +m[2] : 0), be16(m ? +m[3] : 0), body);
    }
    const flagsFrag = rec.proto === 'UDP' || (rec.proto === 'ICMP' && rec.info.startsWith('echo reply')) ? 0 : 0x4000;
    const hdr = [0x45, 0].concat(be16(rec.iplen), be16(rec.id), be16(flagsFrag), [rec.ttl, IP_PROTO[rec.proto], 0, 0], ip4(rec.src), ip4(rec.dst));
    const ck = be16(ipChecksum(hdr));
    hdr[10] = ck[0]; hdr[11] = ck[1];
    return hdr.concat(l4);
  }

  function hexDump(bytes, withAscii) {
    const rows = [];
    for (let off = 0; off < bytes.length; off += 16) {
      const chunk = bytes.slice(off, off + 16);
      const groups = [];
      for (let k = 0; k < chunk.length; k += 2) groups.push(chunk.slice(k, k + 2).map((b) => b.toString(16).padStart(2, '0')).join(''));
      const hex = groups.join(' ').padEnd(39);
      const ascii = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      rows.push('\t0x' + off.toString(16).padStart(4, '0') + ':  ' + hex + (withAscii ? '  ' + ascii : ''));
    }
    return rows.join('\n');
  }

  /** -A: printable characters as they are, CR LF as a newline, anything else as a dot. */
  function asciiDump(bytes) {
    let s = '';
    for (let k = 0; k < bytes.length; k++) {
      const b = bytes[k];
      if (b === 13 && bytes[k + 1] === 10) { s += '\n'; k++; }
      else if (b === 10 || b === 9 || (b >= 32 && b < 127)) s += String.fromCharCode(b);
      else s += '.';
    }
    return s;
  }

  /* ------------------------------------------------------------ ambient traffic */

  const live = []; // running live captures; the first one generates the ambient traffic
  const AMBIENT_NAMES = ['www.halcyon.lab', 'mail.halcyon.lab', 'intranet.halcyon.lab', 'files01.halcyon.lab', 'kali.org', 'example.com'];

  function ambientHosts(machine) {
    return K.net.hosts.filter((h) => h.up && h.id !== 'kali' && h.ip && /^10\.10\.10\./.test(h.ip) && h.mac && !h.silent);
  }

  function pick(list) { return list[Math.floor(K.net.rand() * list.length)]; }

  /** Emit one small burst of background traffic (ARP, DNS, NTP or mDNS) at the current time. */
  function emitAmbient(machine) {
    const hosts = ambientHosts(machine);
    if (hosts.length < 3) return;
    const eth = machine.ifaces.find((f) => f.kind === 'ether');
    const now = K.clock.now();
    const r = K.net.rand();
    const client = pick(hosts.filter((h) => ['web01', 'files01', 'mail01', 'dev01'].includes(h.id)).concat([hosts[0]]));
    const ns = K.net.hostById('ns1');
    const gw = K.net.hostById('gw');
    const pkt = (p, dt) => K.net.packet(Object.assign({ dev: 'eth0', ts: now + (dt || 0) }, p));
    if (r < 0.3) {
      const target = K.net.rand() < 0.35 ? { ip: eth.ip, mac: eth.mac } : pick(hosts.filter((h) => h !== client));
      const dstFor = target.mac;
      pkt({ proto: 'ARP', op: 'request', src: client.ip, dst: target.ip, smac: client.mac, dmac: MAC_BROADCAST });
      pkt({ proto: 'ARP', op: 'reply', src: target.ip, dst: client.ip, smac: dstFor, dmac: client.mac, tmac: client.mac }, 0.2 + K.net.rand() * 0.4);
    } else if (r < 0.65 && ns) {
      const name = pick(AMBIENT_NAMES);
      const known = K.net.hostByName(name);
      const id = Math.floor(K.net.rand() * 65536);
      const sport = 32768 + Math.floor(K.net.rand() * 28000);
      const qlen = 18 + name.length;
      pkt({ proto: 'UDP', src: client.ip, dst: ns.ip, sport, dport: 53, info: id + '+ A? ' + name + '. (' + (qlen - 4) + ')', ulen: qlen - 4, dns: true });
      pkt({ proto: 'UDP', src: ns.ip, dst: client.ip, sport: 53, dport: sport, info: id + '* 1/0/0 A ' + (known ? known.ip : '93.184.216.34') + ' (' + (qlen + 16) + ')', ulen: qlen + 16, dns: true }, 0.3 + K.net.rand() * 0.5);
    } else if (r < 0.8 && gw) {
      const sport = 123;
      pkt({ proto: 'UDP', src: client.ip, dst: gw.ip, sport, dport: 123, info: 'NTPv4, Client, length 48', ulen: 48 });
      pkt({ proto: 'UDP', src: gw.ip, dst: client.ip, sport: 123, dport: sport, info: 'NTPv4, Server, length 48', ulen: 48 }, 0.4 + K.net.rand() * 0.4);
    } else {
      const printer = K.net.hostById('printer') || client;
      pkt({ proto: 'UDP', src: printer.ip, dst: '224.0.0.251', sport: 5353, dport: 5353, info: '0 PTR (QM)? _ipp._tcp.local. (45)', ulen: 45, dmac: MAC_MDNS });
    }
  }

  /* ---------------------------------------------------------- capture files */

  const PCAP_MAGIC = '\u00d4\u00c3\u00b2\u00a1\u0002\u0000\u0004\u0000';
  const PCAP_HEADER = PCAP_MAGIC + '\u0000'.repeat(8) + '\u0000\u0000\u0004\u0000\u0001\u0000\u0000\u0000\n';

  function parsePcap(text) {
    if (!text.startsWith(PCAP_MAGIC)) return null;
    const lines = text.slice(PCAP_HEADER.length).split('\n').filter(Boolean);
    try { return lines.map((l) => JSON.parse(l)); } catch (e) { return null; }
  }

  /* ---------------------------------------------------------------- command */

  const SPEC = {
    short: 'AeDhlnpqStUvxX' + 'c:F:i:j:Q:r:s:T:w:y:z:Z:B:',
    long: ['version', 'help', 'list-interfaces', 'interface=', 'count=', 'no-promiscuous-mode', 'immediate-mode', 'absolute-tcp-sequence-numbers', 'quiet', 'line-buffered', 'numeric'],
    alias: { 'list-interfaces': 'D', interface: 'i', count: 'c', 'absolute-tcp-sequence-numbers': 'S', quiet: 'q', 'line-buffered': 'l', numeric: 'n', 'no-promiscuous-mode': 'p' },
  };

  /** One capture or read-back, from option parsing to the summary lines. */
  async function run(ctx) {
    const g = K.getopt(ctx.args, Object.assign({}, SPEC));
    if (g.err) { ctx.eprintln('tcpdump: ' + g.err); ctx.eprintln(USAGE); return 1; }
    const opts = g.opts;
    if (opts.version) { ctx.println(VERSION.join('\n')); return 0; }
    if (opts.h || opts.help) { ctx.println(VERSION.slice(0, 2).join('\n')); ctx.println(USAGE); return 0; }
    if (opts.D) { DEVICES.forEach((d, k) => ctx.println((k + 1) + '.' + d[0] + ' ' + d[1])); return 0; }

    let count = Infinity;
    if (opts.c != null) {
      count = /^\d+$/.test(String(opts.c)) ? parseInt(opts.c, 10) : NaN;
      if (!(count > 0)) return ctx.fail('invalid packet count ' + opts.c, 1);
    }
    let filterText = g.rest.join(' ');
    if (opts.F != null) {
      try { filterText = ctx.fs.read(ctx.path(opts.F)); } catch (e) { return ctx.fail(opts.F + ': ' + e.message, 1); }
    }
    const fmt = {
      n: g.count.n || 0, q: !!opts.q, v: g.count.v || 0, e: !!opts.e, t: g.count.t || 0,
      A: !!opts.A, X: !!opts.X, x: !!opts.x, xOnly: !!opts.x && !opts.X, S: !!opts.S, cooked: false,
    };

    const reading = opts.r != null;
    let iface = 'eth0';
    if (!reading) {
      iface = opts.i == null ? 'eth0' : String(opts.i);
      if (/^\d+$/.test(iface) && DEVICES[+iface - 1]) iface = DEVICES[+iface - 1][0];
      if (!ctx.isRoot) {
        ctx.eprintln('tcpdump: ' + iface + ": You don't have permission to perform this packet capture on that device");
        ctx.eprintln('(socket: Operation not permitted)');
        return 1;
      }
      if (!['eth0', 'any', 'lo'].includes(iface)) { ctx.eprintln('tcpdump: ' + iface + ': No such device exists'); return 1; }
      fmt.cooked = iface === 'any';
    }

    let pred;
    try { pred = compileFilter(ctx.machine, filterText); }
    catch (e) { if (!(e instanceof FilterError)) throw e; return ctx.fail(e.message, 1); }
    if (opts.Q) {
      const local = (ip) => ctx.machine.ifaces.some((f) => f.ip === ip);
      const dir = String(opts.Q);
      if (!['in', 'out', 'inout'].includes(dir)) return ctx.fail('Invalid direction ' + dir, 1);
      const base = pred;
      pred = (p) => base(p) && (dir === 'inout' || (dir === 'out') === local(p.src));
    }

    const nm = makeNamer(ctx.machine, fmt);
    const st = { prev: null, first: null };
    if (reading) return readCapture(ctx, opts, pred, fmt, nm, st, count);
    return liveCapture(ctx, opts, iface, pred, fmt, nm, st, count);
  }

  function readCapture(ctx, opts, pred, fmt, nm, st, count) {
    let text;
    if (opts.r === '-' && ctx.stdin != null) text = ctx.stdin;
    else {
      try { text = ctx.fs.read(ctx.path(opts.r)); } catch (e) { return ctx.fail(opts.r + ': ' + e.message, 1); }
    }
    const recs = parsePcap(text);
    if (!recs) return ctx.fail(opts.r + ': unknown file format', 1);
    ctx.eprintln('reading from file ' + opts.r + ', link-type EN10MB (Ethernet), snapshot length 262144');
    let shown = 0;
    for (const rec of recs) {
      if (shown >= count) break;
      if (!pred(rec)) continue;
      ctx.println(formatPacket(rec, fmt, nm, st));
      shown++;
    }
    return 0;
  }

  async function liveCapture(ctx, opts, iface, pred, fmt, nm, st, count) {
    const machine = ctx.machine;
    const enrich = makeEnricher(machine);
    const local = (ip) => machine.ifaces.some((f) => f.ip === ip);
    const wfile = opts.w;
    const quietHeader = wfile != null;
    const kind = iface === 'any' ? 'LINUX_SLL2 (Linux cooked v2)' : 'EN10MB (Ethernet)';
    const listening = 'listening on ' + iface + ', link-type ' + kind + ', snapshot length 262144 bytes';
    if (quietHeader) ctx.eprintln('tcpdump: ' + listening);
    else if (fmt.v) ctx.eprintln('tcpdump: ' + listening);
    else { ctx.eprintln('tcpdump: verbose output suppressed, use -v[v]... for full protocol decode'); ctx.eprintln(listening); }

    let wpath = null;
    if (wfile != null && wfile !== '-') {
      wpath = ctx.path(wfile);
      try { ctx.fs.write(wpath, PCAP_HEADER, { mode: 0o644 }); } catch (e) { return ctx.fail(wfile + ': ' + e.message, 1); }
    } else if (wfile === '-') ctx.out(PCAP_HEADER);

    const queue = [];
    const off = K.net.bus.on('packet', (p) => {
      if (iface !== 'any' && (p.dev || 'eth0') !== iface) return;
      const rec = enrich(p);
      rec.dir = local(rec.src) ? 'Out' : 'In';
      if (!pred(rec)) return;
      let k = queue.length;
      while (k > 0 && queue[k - 1].ts > rec.ts) k--;
      queue.splice(k, 0, rec);
    });
    const token = {};
    live.push(token);

    let captured = 0;
    const flush = () => {
      const now = K.clock.now();
      const batch = [];
      while (queue.length && queue[0].ts <= now && captured < count) { batch.push(queue.shift()); captured++; }
      for (const rec of batch) if (wfile == null) ctx.println(formatPacket(rec, fmt, nm, st));
      if (batch.length && wfile != null) {
        const lines = batch.map((r) => JSON.stringify(r)).join('\n') + '\n';
        if (wpath) ctx.fs.append(wpath, lines); else ctx.out(lines);
      }
    };

    let nextAmbient = K.clock.now() + 200 + K.net.rand() * 600;
    const ambientOn = iface === 'eth0' || iface === 'any';
    try {
      while (captured < count) {
        if (ambientOn && live[0] === token && K.clock.now() >= nextAmbient) {
          emitAmbient(machine);
          nextAmbient = K.clock.now() + 400 + K.net.rand() * 2200;
        }
        flush();
        if (captured >= count) break;
        const wake = Math.min(nextAmbient, queue.length ? queue[0].ts : Infinity) - K.clock.now();
        if (K.clock._virtual) await new Promise((res) => setTimeout(res, 0));
        await ctx.sleep(Math.max(5, Math.min(200, wake)));
      }
    } catch (e) {
      if (!(e instanceof K.Interrupt)) throw e;
    } finally {
      off();
      live.splice(live.indexOf(token), 1);
    }
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    ctx.eprintln(plural(captured, 'packet') + ' captured');
    ctx.eprintln(plural(captured, 'packet') + ' received by filter');
    ctx.eprintln('0 packets dropped by kernel');
    return 0;
  }

  K.cmd.register({
    name: 'tcpdump',
    path: '/usr/bin/tcpdump',
    pkg: 'tcpdump',
    section: 8,
    summary: 'dump traffic on a network',
    synopsis: 'tcpdump [-AdDefhlnpqStUvxX] [-c count] [-F file] [-i interface] [-Q in|out|inout] [-r file] [-s snaplen] [-w file] [expression]',
    man: [
      'DESCRIPTION',
      '  Tcpdump prints a description of the contents of packets on a network interface that match the boolean expression. Capturing needs root. In Kalima it shows the simulated traffic of the lab segment: your own commands plus a little background chatter (ARP, DNS, NTP, mDNS).',
      '',
      'OPTIONS',
      '  -i interface   Listen on interface (eth0, lo or any). -D lists them.',
      '  -c count       Exit after receiving count packets.',
      '  -n             Do not convert addresses to names; -nn also leaves port numbers alone.',
      '  -q             Quick output, less protocol information.',
      '  -v             Verbose: IP header fields and checksums.',
      '  -e             Print the link-level header (MAC addresses).',
      '  -t, -tt, -ttt, -tttt, -ttttt   No timestamp, Unix time, delta, date, delta from first.',
      '  -A             Print each packet in ASCII.',
      '  -X, -x         Print each packet in hex (and ASCII with -X).',
      '  -S             Print absolute TCP sequence numbers.',
      '  -w file        Write the packets to file instead of printing them.',
      '  -r file        Read packets from file (no root needed).',
      '  -Q direction   Capture only in, out or inout packets.',
      '',
      'EXPRESSIONS',
      '  host, src host, dst host, net, port, src port, dst port, portrange, icmp, tcp, udp, arp, ip, broadcast, less, greater, combined with and, or, not and parentheses.',
      '',
      'EXAMPLES',
      '  sudo tcpdump -n -i eth0 icmp',
      '    Watch pings. Run "ping -c 3 10.10.10.10" in another terminal, or start the capture with & first.',
      '  sudo tcpdump -nn -c 10 tcp port 80 and host 10.10.10.10',
      '  sudo tcpdump -A -c 6 port 80      (then: curl http://10.10.10.10/)',
      '  sudo tcpdump -w web.pcap -c 20 host 10.10.10.10; tcpdump -nr web.pcap',
    ].join('\n'),
    run,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
