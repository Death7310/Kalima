/* Network configuration and reachability: ping, ip, traceroute, tracepath,
 * mtr, ss, netstat, ifconfig, route, arp, nmcli, iwconfig, ethtool.
 *
 * Every answer comes from K.net and from the machine's own interface, route
 * and ARP tables; commands that change configuration edit those tables, so
 * routing reacts to what the learner types.
 */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;
  const C = K.c;

  /* ------------------------------------------------------------ shared helpers */
  const pad = (s, n) => U.padEnd(s, n);
  const padL = (s, n) => U.padStart(s, n);
  const lab = () => K.net.world;
  const nowSec = () => K.clock.now() / 1000;
  const state = (m) => (m.state.net = m.state.net || { stash: {}, lease: null });

  /** Names a learner may type for a lab host or a curated internet site. */
  function hostNames() {
    const w = lab(); const out = [];
    for (const h of w.hosts) { if (h.id === 'kali') continue; out.push(h.hostname); if (h.fqdn && h.fqdn !== h.hostname) out.push(h.fqdn); for (const a of h.aliases || []) out.push(a); }
    for (const s of w.internet.sites) out.push(s.name);
    return Array.from(new Set(out.filter(Boolean))).sort();
  }
  const ifaceNames = (m) => m.ifaces.map((i) => i.name);
  /** net-tools list real interfaces first and the loopback last. */
  const netToolsOrder = (m) => m.ifaces.filter((i) => i.kind !== 'loopback').concat(m.ifaces.filter((i) => i.kind === 'loopback'));
  const ifaceByName = (m, n) => m.ifaces.find((i) => i.name === n) || null;

  /** Resolve a host argument the way libc does; distinguishes "no such name" from "resolver unreachable". */
  function lookup(ctx, name) {
    if (U.isIPv4(name)) return { ip: name, name, literal: true };
    if (/^(localhost|localhost\.localdomain)$/.test(name)) return { ip: '127.0.0.1', name: 'localhost' };
    const r = K.net.resolve(ctx.machine, name);
    if (r) return { ip: r.ip, name: r.name || name };
    const d = K.net.dns(ctx.machine, name, 'A');
    return { err: d.status === 'TIMEOUT' || d.status === 'NOSERVER' ? 'tempfail' : 'nxdomain' };
  }
  const RESOLVE_MSG = { tempfail: 'Temporary failure in name resolution', nxdomain: 'Name or service not known' };

  /** Reverse name for output lines; loopback is localhost. */
  function rdns(ctx, ip) {
    if (U.inCidr(ip, '127.0.0.0/8')) return 'localhost';
    if (ctx.machine.ifaces.some((i) => i.ip === ip)) return ctx.machine.hostname;
    return K.net.reverse(ctx.machine, ip);
  }

  /** Integer option with iputils-style range errors; returns null after printing the error. */
  function intArg(ctx, tool, val, min, max, float) {
    const bad = float ? !/^\d*\.?\d+$/.test(val) : !/^[+-]?\d+$/.test(val);
    if (bad) { ctx.eprintln(tool + ": invalid argument: '" + val + "'"); return null; }
    const n = float ? parseFloat(val) : parseInt(val, 10);
    if (n < min || n > max) { ctx.eprintln(tool + ": invalid argument: '" + val + "': out of range: " + min + ' <= value <= ' + max); return null; }
    return n;
  }

  const usageErr = (ctx, tool, text, err) => { ctx.eprintln(tool + ': ' + err); ctx.err(text); return 2; };

  /* ====================================================================== ping */
  const PING_VERSION = 'ping from iputils 20250605';
  const PING_USAGE = [
    'Usage', '  ping [options] <destination>', '', 'Options:',
    '  <destination>      dns name or ip address',
    '  -a                 use audible ping',
    '  -A                 use adaptive ping',
    '  -B                 sticky source address',
    '  -c <count>         stop after <count> replies',
    '  -D                 print timestamps',
    '  -d                 use SO_DEBUG socket option',
    '  -f                 flood ping',
    '  -h                 print help and exit',
    '  -I <interface>     either interface name or address',
    '  -i <interval>      seconds between sending each packet',
    '  -L                 suppress loopback of multicast packets',
    '  -l <preload>       send <preload> number of packages while waiting replies',
    '  -m <mark>          tag the packets going out',
    '  -M <pmtud opt>     define path MTU discovery, can be one of <do|dont|want|probe>',
    '  -n                 no dns name resolution',
    '  -O                 report outstanding replies',
    '  -p <pattern>       contents of padding byte',
    '  -q                 quiet output',
    '  -Q <tclass>        use quality of service <tclass> bits',
    '  -s <size>          use <size> as number of data bytes to be sent',
    '  -S <size>          use <size> as SO_SNDBUF socket option value',
    '  -t <ttl>           define time to live',
    '  -U                 print user-to-user latency',
    '  -v                 verbose output',
    '  -V                 print version and exit',
    '  -w <deadline>      reply wait <deadline> in seconds',
    '  -W <timeout>       time to wait for response', '',
    'IPv4 options:',
    '  -4                 use IPv4',
    '  -b                 allow pinging broadcast',
    '  -R                 record route',
    '  -T <timestamp>     define timestamp, can be one of <tsonly|tsandaddr|tsprespec>', '',
    'IPv6 options:',
    '  -6                 use IPv6',
    '  -F <flowlabel>     define flow label, default is random',
    '  -N <nodeinfo opt>  use IPv6 node info query, try <help> as argument', '',
    'For more details see ping(8).', '',
  ].join('\n');

  const pingTime = (ms) => ms.toFixed(ms >= 99.95 ? 0 : ms >= 9.995 ? 1 : ms >= 0.9995 ? 2 : 3);

  /** Resolve -I (interface name or local address) to a source address, or print the error. */
  function pingSource(ctx, val) {
    const m = ctx.machine;
    const i = ifaceByName(m, val);
    if (i) return { dev: i.name, src: i.ip };
    if (U.isIPv4(val) && m.ifaces.some((x) => x.ip === val)) return { src: val };
    if (U.isIPv4(val)) ctx.eprintln('ping: bind: Cannot assign requested address');
    else ctx.eprintln('ping: SO_BINDTODEVICE ' + val + ': No such device');
    return null;
  }

  async function pingRun(ctx) {
    const g = K.getopt(ctx.args, { short: '46aAbBdDfhLnOqrRUvVc:F:i:I:l:m:M:N:p:Q:s:S:t:T:w:W:', long: ['help', 'version'], alias: { help: 'h', version: 'V' } });
    if (g.err) return usageErr(ctx, 'ping', PING_USAGE, g.err);
    const o = g.opts;
    if (o.h) { ctx.out(PING_USAGE); return 0; }
    if (o.V) { ctx.println(PING_VERSION); return 0; }
    if (!g.rest.length) return usageErr(ctx, 'ping', PING_USAGE, 'usage error: Destination address required');
    const count = o.c != null ? intArg(ctx, 'ping', o.c, 1, Number.MAX_SAFE_INTEGER) : Infinity;
    const interval = o.i != null ? intArg(ctx, 'ping', o.i, 0, 2147483647, true) : 1;
    const size = o.s != null ? intArg(ctx, 'ping', o.s, 0, 2147483647) : 56;
    const ttl = o.t != null ? intArg(ctx, 'ping', o.t, 0, 255) : undefined;
    const deadline = o.w != null ? intArg(ctx, 'ping', o.w, 0, 2147483647) : 0;
    const wait = o.W != null ? intArg(ctx, 'ping', o.W, 0, 2147483647, true) : 10;
    if ([count, interval, size, ttl, deadline, wait].includes(null)) return 2;
    if (interval < 0.002 && !ctx.isRoot) { ctx.eprintln('ping: cannot flood; minimal interval allowed for user is 2ms'); return 2; }
    if (o.f && !ctx.isRoot) { ctx.eprintln('ping: cannot flood; minimal interval allowed for user is 2ms'); return 2; }
    const bound = o.I != null ? pingSource(ctx, o.I) : {};
    if (!bound) return 2;
    let status = 0;
    for (const target of g.rest) status = await pingOne(ctx, target, { o, count, interval, size, ttl, deadline, wait, bound });
    return status;
  }

  async function pingOne(ctx, target, p) {
    const { o } = p; const net = K.net; const machine = ctx.machine;
    if (o['6']) { ctx.eprintln('ping: ' + target + ': Address family for hostname not supported'); return 2; }
    const dest = lookup(ctx, target);
    if (dest.err) { ctx.eprintln('ping: ' + target + ': ' + RESOLVE_MSG[dest.err]); return 2; }
    const numeric = !!(o.n || dest.literal);
    const shown = dest.literal ? target : dest.name;
    const first = net.route(machine, dest.ip);
    if (!first.ok && first.err === 'ENETUNREACH') { ctx.eprintln('ping: connect: Network is unreachable'); return 2; }
    if (p.bound.dev && first.ok && first.dev !== p.bound.dev && !first.self) { ctx.eprintln('ping: connect: Network is unreachable'); return 2; }
    const id = (ctx.pid & 0xffff) || 1;
    ctx.println('PING ' + shown + ' (' + dest.ip + ') ' + p.size + '(' + (p.size + 28) + ') bytes of data.');

    const from = (ip) => {
      const n = numeric ? null : rdns(ctx, ip);
      return n ? n + ' (' + ip + ')' : ip;
    };
    const stamp = () => (o.D ? '[' + nowSec().toFixed(6) + '] ' : '');
    const interval = Math.max(p.interval, o.f ? 0 : 0.002) * 1000;
    const stats = { sent: 0, recv: 0, errs: 0, rtts: [] };
    const pending = []; // unreachable probes the kernel reports after the ARP timeout
    let t = 0; let lastAnswer = 0; let timedOut = null;

    const flushPending = (limit) => {
      while (pending.length && pending[0] <= limit) {
        const seq = pending.shift();
        stats.errs++;
        if (!o.q) ctx.println(stamp() + 'From ' + from(first.src || machine.primaryIp()) + ' icmp_seq=' + seq + ' Destination Host Unreachable');
      }
    };
    let interrupted = false;
    try {
      for (let seq = 1; seq <= p.count; seq++) {
        if (p.deadline && t >= p.deadline * 1000) break;
        if (o.O && timedOut != null && !o.q) ctx.println(stamp() + 'no answer yet for icmp_seq=' + timedOut);
        timedOut = null;
        stats.sent++;
        const r = net.ping(machine, dest.ip, seq, { ttl: p.ttl, size: p.size, id });
        if (r.status === 'reply') {
          stats.recv++; stats.rtts.push(r.rtt); lastAnswer = r.rtt;
          if (!o.q) ctx.println(stamp() + (p.size + 8) + ' bytes from ' + from(r.from) + ': icmp_seq=' + seq + ' ttl=' + r.ttl + ' time=' + pingTime(r.rtt) + ' ms');
        } else if (r.status === 'unreachable') {
          pending.push(seq);
        } else if (r.status === 'ttl-exceeded') {
          stats.errs++;
          if (!o.q) ctx.println(stamp() + 'From ' + from(r.from) + ' icmp_seq=' + seq + ' Time to live exceeded');
        } else if (r.status === 'noroute') {
          stats.errs++;
          if (!o.q) ctx.println('ping: sendmsg: Network is unreachable');
        } else timedOut = seq;
        if (t >= 3000) flushPending(seq - 1);
        if (seq === p.count) break;
        await ctx.sleep(interval); t += interval;
      }
      if (p.deadline && p.count === Infinity) { await ctx.sleep(Math.max(0, p.deadline * 1000 - t)); t = p.deadline * 1000; }
      else await ctx.sleep(Math.min(p.wait * 1000, 200));
    } catch (e) {
      if (!(e instanceof K.Interrupt)) throw e;
      interrupted = true;
    }
    const elapsed = Math.round(t + (stats.sent > 1 || interrupted ? 2 + net.rand() * 5 : 0) + (stats.recv ? lastAnswer : 0));
    ctx.println('\n--- ' + shown + ' ping statistics ---');
    const loss = Math.floor((stats.sent - stats.recv) * 100 / stats.sent);
    ctx.println(stats.sent + ' packets transmitted, ' + stats.recv + ' received, ' + (stats.errs ? '+' + stats.errs + ' errors, ' : '') + loss + '% packet loss, time ' + elapsed + 'ms');
    if (stats.recv) {
      const a = stats.rtts; const avg = a.reduce((x, y) => x + y, 0) / a.length;
      const mdev = Math.sqrt(a.reduce((x, y) => x + y * y, 0) / a.length - avg * avg);
      ctx.println('rtt min/avg/max/mdev = ' + [Math.min.apply(null, a), avg, Math.max.apply(null, a), mdev].map((x) => x.toFixed(3)).join('/') + ' ms');
    } else if (stats.errs && first.err) ctx.println('pipe ' + stats.sent);
    return stats.recv ? 0 : 1;
  }

  K.cmd.register({
    name: 'ping', aliases: ['ping4'], path: '/usr/bin/ping', pkg: 'iputils-ping', section: 8,
    summary: 'send ICMP ECHO_REQUEST to network hosts',
    synopsis: 'ping [-aAbBdDfhLnOqrRUvV46] [-c count] [-i interval] [-I interface] [-s packetsize] [-t ttl] [-w deadline] [-W timeout] destination',
    man: 'DESCRIPTION\n       ping uses the ICMP protocol mandatory ECHO_REQUEST datagram to elicit an ICMP ECHO_RESPONSE from a host or gateway. ECHO_REQUEST datagrams ("pings") have an IP and ICMP header, followed by a struct timeval and then an arbitrary number of "pad" bytes used to fill out the packet.\n\n       Without -c, ping sends one request per second until you press Ctrl-C, then prints statistics.\n\nOPTIONS\n       -c count\n              Stop after sending count ECHO_REQUEST packets.\n       -i interval\n              Wait interval seconds between sending each packet. The default is one second.\n       -W timeout\n              Time to wait for a response, in seconds.\n       -w deadline\n              Specify a timeout, in seconds, before ping exits regardless of how many packets have been sent or received.\n       -s packetsize\n              Number of data bytes to be sent. The default is 56, which translates into 64 ICMP data bytes when combined with the 8 bytes of ICMP header data.\n       -t ttl\n              Set the IP Time to Live.\n       -I interface\n              Interface name or source address to send from.\n       -n     Numeric output only. No attempt will be made to lookup symbolic names for host addresses.\n       -q     Quiet output. Only the summary lines at startup and at the end are displayed.\n       -D     Print timestamp (unix time + microseconds as in gettimeofday) before each line.\n       -O     Report outstanding ICMP ECHO reply before sending next packet.\n       -4, -6 Use IPv4 or IPv6 only.\n\nEXIT STATUS\n       0 when at least one reply was received, 1 when none was, 2 on other errors.\n\nEXAMPLES\n       ping -c 4 web01.halcyon.lab\n              Send four probes to the intranet web server.\n       ping -c 1 -W 2 10.10.10.90\n              One probe, give up after two seconds.',
    run: pingRun,
    complete: (info) => (info.cur && info.cur[0] === '-' ? [] : hostNames()),
  });

  /* ======================================================================== ip */
  const IP_VERSION = 'ip utility, iproute2-6.15.0';
  const IP_USAGE = [
    'Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }',
    '       ip [ -force ] -batch filename',
    'where  OBJECT := { address | addrlabel | amtrelay | fou | help | ila | ioam | l2tp | link |',
    '                   macsec | maddress | monitor | mptcp | mroute | mrule | neighbor | neighbour |',
    '                   netconf | netns | nexthop | ntable | ntbl | route | rule | sr | stats |',
    '                   tap | tcpmetrics | token | tunnel | tuntap | vrf | xfrm }',
    '       OPTIONS := { -V[ersion] | -s[tatistics] | -d[etails] | -r[esolve] |',
    '                    -h[uman-readable] | -iec | -j[son] | -p[retty] |',
    '                    -f[amily] { inet | inet6 | mpls | bridge | link } |',
    '                    -4 | -6 | -M | -B | -0 |',
    '                    -l[oops] { maximum-addr-flush-attempts } | -br[ief] |',
    '                    -o[neline] | -t[imestamp] | -ts[hort] | -b[atch] [filename] |',
    '                    -rc[vbuf] [size] | -n[etns] name | -N[umeric] | -a[ll] |',
    '                    -c[olor]}',
    '',
  ].join('\n');
  const IP_HELP = {
    address: 'Usage: ip address {add|change|replace} IFADDR dev IFNAME [ LIFETIME ]\n                                                      [ CONFFLAG-LIST ]\n       ip address del IFADDR dev IFNAME [mngtmpaddr]\n       ip address {save|flush} [ dev IFNAME ] [ scope SCOPE-ID ]\n                            [ to PREFIX ] [ FLAG-LIST ] [ label LABEL ] [up]\n       ip address [ show [ dev IFNAME ] [ scope SCOPE-ID ] [ master DEVICE ]\n                         [ type TYPE ] [ to PREFIX ] [ FLAG-LIST ]\n                         [ label LABEL ] [up] [ vrf NAME ] ]\n',
    link: 'Usage: ip link add [link DEV | parentdev NAME] [ name ] NAME\n                   [ txqueuelen PACKETS ]\n                   [ address LLADDR ]\n                   [ broadcast LLADDR ]\n                   [ mtu MTU ] [index IDX ]\n                   type TYPE [ ARGS ]\n\n       ip link delete { DEVICE | dev DEVICE | group DEVGROUP } type TYPE [ ARGS ]\n\n       ip link set { DEVICE | dev DEVICE | group DEVGROUP }\n                      [ { up | down } ]\n                      [ address LLADDR ]\n                      [ mtu MTU ]\n                      [ name NEWNAME ]\n                      [ promisc { on | off } ]\n       ip link show [ DEVICE | group GROUP ] [up] [master DEV] [type TYPE]\n',
    route: 'Usage: ip route { list | flush } SELECTOR\n       ip route save SELECTOR\n       ip route restore\n       ip route showdump\n       ip route get [ ROUTE_GET_FLAGS ] ADDRESS\n                            [ from ADDRESS iif STRING ]\n                            [ oif STRING ] [ tos TOS ]\n                            [ mark NUMBER ] [ vrf NAME ]\n                            [ ipproto PROTOCOL ] [ sport NUMBER ] [ dport NUMBER ]\n       ip route { add | del | change | append | replace } ROUTE [ nexthop NH ] ...\n',
    neighbor: 'Usage: ip neigh { add | del | change | replace }\n                { ADDR [ lladdr LLADDR ] [ nud STATE ] | proxy ADDR } [ dev DEV ]\n\n       ip neigh { show | flush } [ proxy ] [ to PREFIX ] [ dev DEV ] [ nud STATE ]\n                                [ vrf NAME ]\n',
  };
  /* Command abbreviations work as in iproute2: any prefix of the full word. */
  const abbr = (given, full) => given.length > 0 && full.startsWith(given);
  const IP_OBJECTS = ['address', 'link', 'route', 'neighbor', 'neighbour', 'rule', 'netns', 'maddress', 'tuntap', 'tunnel', 'monitor', 'addrlabel', 'mroute', 'tcpmetrics', 'nexthop', 'xfrm', 'vrf', 'l2tp', 'fou', 'macsec', 'mptcp', 'netconf', 'ntable', 'sr', 'stats', 'token', 'ila', 'ioam', 'amtrelay', 'mrule', 'tap'];
  const IP_OPTIONS = [
    ['stats', 'statistics'], ['details'], ['resolve'], ['human-readable', 'human'], ['iec'], ['json'], ['pretty'], ['oneline'],
    ['brief'], ['color'], ['all'], ['Version'], ['Numeric'], ['timestamp'], ['tshort'], ['family', 'f'], ['loops'], ['netns'],
    ['rcvbuf'], ['force'], ['batch'],
  ];
  const IP_OPT_ARG = ['family', 'loops', 'netns', 'rcvbuf'];

  /* Interface model helpers. */
  const ifIndex = (m, i) => m.ifaces.indexOf(i) + 1;
  const addrList = (i) => (i.ip ? [{ ip: i.ip, bits: i.bits }] : []).concat(i.secondary || []);
  function setAddrList(i, list) {
    i.ip = list.length ? list[0].ip : null;
    i.bits = list.length ? list[0].bits : undefined;
    i.secondary = list.slice(1);
  }
  const isUp = (i) => i.state !== 'DOWN';
  const linkType = (i) => (i.kind === 'loopback' ? 'loopback' : 'ether');
  const BCAST_MAC = 'ff:ff:ff:ff:ff:ff';
  function flagsOf(i) {
    const f = i.kind === 'loopback' ? ['LOOPBACK'] : i.kind === 'dummy' ? ['BROADCAST', 'NOARP'] : ['BROADCAST', 'MULTICAST'];
    if (i.promisc) f.push('PROMISC');
    if (isUp(i)) f.push('UP', 'LOWER_UP');
    return f;
  }
  const qdiscOf = (i) => (i.kind === 'loopback' || i.kind === 'dummy' ? 'noqueue' : 'fq_codel');
  const operState = (i) => (i.state === 'DOWN' ? 'DOWN' : i.kind === 'loopback' || i.kind === 'dummy' ? 'UNKNOWN' : 'UP');
  function linkLocal6(mac) {
    const b = mac.split(':').map((x) => parseInt(x, 16));
    const g = [(b[0] ^ 2) << 8 | b[1], b[2] << 8 | 0xff, 0xfe00 | b[3], b[4] << 8 | b[5]];
    return 'fe80::' + g.map((x) => x.toString(16)).join(':') + '/64';
  }
  /** Addresses of one family, with the properties iproute2 prints. */
  function infoOf(m, i, family) {
    const dyn = !!dhcpDev(m, i.name);
    if (family === 6) {
      if (i.kind === 'loopback') return [{ family: 'inet6', local: '::1', prefixlen: 128, scope: 'host', noprefixroute: true, forever: true }];
      return isUp(i) ? [{ family: 'inet6', local: linkLocal6(i.mac).slice(0, -3), prefixlen: 64, scope: 'link', noprefixroute: true, forever: true }] : [];
    }
    return addrList(i).map((a, n) => {
      const first = addrList(i).findIndex((b) => U.inCidr(a.ip, b.ip + '/' + b.bits) && b.bits === a.bits);
      const lo = i.kind === 'loopback';
      const e = { family: 'inet', local: a.ip, prefixlen: a.bits, scope: lo ? 'host' : 'global', label: i.name, forever: true };
      if (a.bits < 31 && !lo) e.broadcast = U.intToIp((U.parseCidr(a.ip + '/' + a.bits).broadcast));
      if (first !== n) e.secondary = true;
      else if (n === 0 && dyn && !lo) { e.dynamic = true; e.noprefixroute = true; e.forever = false; }
      return e;
    });
  }
  const dhcpDev = (m, dev) => m.routes.concat(state(m).stash[dev] || []).find((r) => r.proto === 'dhcp' && r.dev === dev);
  function leaseLeft(m) {
    const s = state(m);
    if (s.lease == null) s.lease = K.clock.now() - 137000;
    return Math.max(0, 86400 - Math.floor((K.clock.now() - s.lease) / 1000));
  }

  /** Colour helper: paint(kind, text) honours --color. */
  const IP_COLOR = { ifname: '\x1b[36m', mac: '\x1b[33m', inet: '\x1b[1;34m', inet6: '\x1b[1;35m', up: '\x1b[32m', down: '\x1b[31m' };
  const painter = (on) => (kind, s) => (on ? IP_COLOR[kind] + s + '\x1b[0m' : s);

  function addrLines(ctx, m, i, e, p, indent) {
    const bits = [e.family, p(e.family, e.local + '/' + e.prefixlen)];
    if (e.broadcast) bits.push('brd', e.broadcast);
    bits.push('scope', e.scope);
    if (e.secondary) bits.push('secondary');
    if (e.dynamic) bits.push('dynamic');
    if (e.noprefixroute) bits.push('noprefixroute');
    if (e.family === 'inet') bits.push(p('ifname', i.name));
    const life = e.forever ? 'forever' : leaseLeft(m) + 'sec';
    return { head: indent + bits.join(' ') + (e.family === 'inet6' ? ' ' : ''), tail: 'valid_lft ' + life + ' preferred_lft ' + life };
  }
  function nlStats(m, i) {
    const h = U.hash32(i.name + m.hostname);
    const rx = i.kind === 'loopback' ? 6240 : 1200000 + (h % 900000); const tx = i.kind === 'loopback' ? 6240 : 310000 + (h % 200000);
    return { rx, rxp: Math.floor(rx / 420), tx, txp: Math.floor(tx / 190) };
  }

  /** Pick the interfaces an "ip addr/link show" selector names; null after printing an error. */
  function pickIfaces(ctx, args) {
    const m = ctx.machine; let dev = null; let onlyUp = false; let scope = null;
    for (let n = 0; n < args.length; n++) {
      const a = args[n];
      if (a === 'dev') dev = args[++n];
      else if (a === 'up') onlyUp = true;
      else if (a === 'scope') scope = args[++n];
      else if (['label', 'master', 'type', 'to', 'vrf', 'group'].includes(a)) n++;
      else if (a === 'dynamic' || a === 'permanent' || a === 'primary' || a === 'secondary') continue;
      else if (dev == null) dev = a;
    }
    if (dev != null && !ifaceByName(m, dev)) { ctx.eprintln('Device "' + dev + '" does not exist.'); return null; }
    return { list: m.ifaces.filter((i) => (dev == null || i.name === dev) && (!onlyUp || isUp(i))), scope };
  }

  function ipShowAddr(ctx, g, args, linkOnly) {
    const sel = pickIfaces(ctx, args); if (!sel) return 1;
    const m = ctx.machine; const p = painter(g.color); const out = [];
    const fam = g.family;
    const json = [];
    for (const i of sel.list) {
      const idx = ifIndex(m, i);
      const infos = linkOnly ? [] : [].concat(fam === 6 ? [] : infoOf(m, i, 4), fam === 4 ? [] : infoOf(m, i, 6)).filter((e) => !sel.scope || e.scope === sel.scope);
      const flags = flagsOf(i); const state = operState(i);
      const mac = i.mac || '00:00:00:00:00:00'; const brd = i.kind === 'loopback' ? mac : BCAST_MAC;
      const stP = p(state === 'DOWN' ? 'down' : state === 'UP' ? 'up' : 'up', state);
      if (g.json) {
        const o = { ifindex: idx, ifname: i.name, flags, mtu: i.mtu || 1500, qdisc: qdiscOf(i), operstate: state };
        if (linkOnly) o.linkmode = 'DEFAULT';
        Object.assign(o, { group: 'default', txqlen: 1000, link_type: linkType(i), address: mac, broadcast: brd });
        if (!linkOnly) o.addr_info = infos.map((e) => {
          const a = { family: e.family, local: e.local, prefixlen: e.prefixlen };
          if (e.broadcast) a.broadcast = e.broadcast;
          a.scope = e.scope;
          if (e.dynamic) a.dynamic = true;
          if (e.noprefixroute) a.noprefixroute = true;
          if (e.family === 'inet') a.label = i.name;
          a.valid_life_time = e.forever ? 4294967295 : leaseLeft(m); a.preferred_life_time = a.valid_life_time;
          return a;
        });
        json.push(o); continue;
      }
      if (g.brief) {
        const cols = linkOnly ? [p('mac', mac), '<' + flags.join(',') + '>'] : infos.map((e) => p(e.family, e.local + '/' + e.prefixlen));
        out.push(pad(p('ifname', i.name), 16) + ' ' + pad(stP, 14) + ' ' + cols.join(' ') + ' ');
        continue;
      }
      const head = idx + ': ' + p('ifname', i.name) + ': <' + flags.join(',') + '> mtu ' + (i.mtu || 1500) + ' qdisc ' + qdiscOf(i) + ' state ' + stP + (linkOnly ? ' mode DEFAULT' : '') + ' group default qlen 1000';
      const link = 'link/' + linkType(i) + ' ' + p('mac', mac) + ' brd ' + p('mac', brd);
      if (g.oneline) {
        if (linkOnly) { out.push(head + '\\    ' + link); continue; }
        for (const e of infos) { const l = addrLines(ctx, m, i, e, p, ''); out.push(idx + ': ' + p('ifname', i.name) + '    ' + l.head + '\\       ' + l.tail); }
        continue;
      }
      out.push(head, '    ' + link);
      if (g.stats) {
        const s = nlStats(m, i);
        out.push('    RX:  bytes packets errors dropped  missed   mcast', '    ' + [padL(s.rx, 10), padL(s.rxp, 7), padL(0, 7), padL(0, 7), padL(0, 7), padL(0, 7)].join(' '),
          '    TX:  bytes packets errors dropped carrier collsns', '    ' + [padL(s.tx, 10), padL(s.txp, 7), padL(0, 7), padL(0, 7), padL(0, 7), padL(0, 7)].join(' '));
      }
      for (const e of infos) { const l = addrLines(ctx, m, i, e, p, '    '); out.push(l.head, '       ' + l.tail); }
    }
    if (g.json) ctx.println(g.pretty ? JSON.stringify(json, null, 4) : JSON.stringify(json));
    else if (out.length) ctx.println(out.join('\n'));
    return 0;
  }

  /* ------------------------------------------------------------ ip route */
  const routeBits = (r) => (r.dst === 'default' ? 0 : U.parseCidr(r.dst).bits);
  /** Keep the table in lookup order (longest prefix, then lowest metric), which K.net.route relies on. */
  function sortRoutes(m) { m.routes.sort((a, b) => routeBits(b) - routeBits(a) || (a.metric || 0) - (b.metric || 0)); }
  function routeText(m, r, p) {
    const dst = r.dst === 'default' ? 'default' : r.dst.replace(/\/32$/, '');
    const parts = [(r.type ? r.type + ' ' : '') + dst];
    if (r.via) parts.push('via', p('inet', r.via));
    if (r.dev) parts.push('dev', p('ifname', r.dev));
    if (r.proto && r.proto !== 'boot') parts.push('proto', r.proto);
    if (!r.via && !r.type) parts.push('scope', r.scope || 'link');
    const dev = ifaceByName(m, r.dev);
    const src = r.src || (r.proto === 'dhcp' && dev ? dev.ip : null);
    if (src) parts.push('src', p('inet', src));
    if (r.metric) parts.push('metric', r.metric);
    return parts.join(' ') + ' ';
  }
  const displayOrder = (a, b) => (a.dst === 'default' ? -1 : U.ipToInt(a.dst)) - (b.dst === 'default' ? -1 : U.ipToInt(b.dst)) || routeBits(a) - routeBits(b);
  function localTable(m) {
    const out = [];
    for (const i of m.ifaces) {
      if (!isUp(i)) continue;
      for (const a of addrList(i)) {
        const c = U.parseCidr(a.ip + '/' + a.bits);
        if (i.kind === 'loopback') out.push([c.network, 'broadcast ' + U.intToIp(c.network) + ' dev lo proto kernel scope link src ' + a.ip], [c.network + 1, 'local ' + U.intToIp(c.network) + '/' + a.bits + ' dev lo proto kernel scope host src ' + a.ip]);
        out.push([c.ip, 'local ' + a.ip + ' dev ' + i.name + ' proto kernel scope host src ' + a.ip]);
        if (a.bits < 31) out.push([c.broadcast, 'broadcast ' + U.intToIp(c.broadcast) + ' dev ' + i.name + ' proto kernel scope link src ' + a.ip]);
        if (a.bits < 31 && i.kind !== 'loopback') out.push([c.network - 0.5, 'broadcast ' + U.intToIp(c.network) + ' dev ' + i.name + ' proto kernel scope link src ' + a.ip]);
      }
    }
    return out.sort((a, b) => a[0] - b[0]).map((x) => x[1] + ' ');
  }
  function ipRouteShow(ctx, g, args) {
    const m = ctx.machine; const p = painter(g.color);
    let table = 'main'; const f = {};
    for (let n = 0; n < args.length; n++) {
      const a = args[n];
      if (['dev', 'via', 'proto', 'scope', 'table', 'type', 'src', 'metric'].includes(a)) { f[a] = args[++n]; if (a === 'table') table = f.table; } else if (a === 'to' || a === 'exact' || a === 'root' || a === 'match') continue;
      else f.dst = a;
    }
    if (f.dev && !ifaceByName(m, f.dev)) { ctx.eprintln('Cannot find device "' + f.dev + '"'); return 1; }
    if (table === 'local') { if (g.family !== 6) ctx.println(localTable(m).join('\n')); return 0; }
    if (g.family === 6) {
      const v6 = [];
      for (const i of m.ifaces) if (isUp(i)) v6.push(i.kind === 'loopback' ? '::1 dev lo proto kernel metric 256 pref medium' : 'fe80::/64 dev ' + i.name + ' proto kernel metric 1024 pref medium');
      if (v6.length) ctx.println(v6.join('\n'));
      return 0;
    }
    const rows = m.routes.filter((r) => (!f.dev || r.dev === f.dev) && (!f.via || r.via === f.via) && (!f.proto || r.proto === f.proto) && (!f.scope || (f.scope === 'link') === (!r.via)) && (!f.dst || r.dst === (f.dst === 'default' ? 'default' : normPrefix(f.dst))) && (!f.type || (r.type || 'unicast') === f.type));
    if (g.json) {
      const arr = rows.slice().sort(displayOrder).map((r) => {
        const o = { dst: r.dst === 'default' ? 'default' : r.dst.replace(/\/32$/, '') };
        if (r.via) o.gateway = r.via;
        o.dev = r.dev;
        if (r.proto && r.proto !== 'boot') o.protocol = r.proto;
        if (!r.via) o.scope = 'link';
        const dev = ifaceByName(m, r.dev); const src = r.src || (r.proto === 'dhcp' && dev ? dev.ip : null);
        if (src) o.prefsrc = src;
        if (r.metric) o.metric = r.metric;
        o.flags = [];
        return o;
      });
      ctx.println(g.pretty ? JSON.stringify(arr, null, 4) : JSON.stringify(arr));
      return 0;
    }
    if (rows.length) ctx.println(rows.slice().sort(displayOrder).map((r) => routeText(m, r, p)).join('\n'));
    return 0;
  }
  /** "10.0.0.1" -> "10.0.0.1/32"; null when it is not a prefix. */
  function normPrefix(s) {
    const c = U.parseCidr(s); if (!c) return null;
    return U.intToIp(c.ip) + '/' + c.bits;
  }
  /** Where would the kernel send a packet to ip? Pure lookup, no probing. */
  function routeLookup(m, ip) {
    if (U.inCidr(ip, '127.0.0.0/8') || m.ifaces.some((i) => i.ip === ip)) return { local: true, src: ip };
    for (const i of m.ifaces) if (i.kind !== 'loopback' && isUp(i) && addrList(i).some((a) => U.inCidr(ip, a.ip + '/' + a.bits))) return { dev: i.name, src: i.ip };
    for (const r of m.routes) {
      if (!r.via || r.type) continue;
      if (r.dst !== 'default' && !U.inCidr(ip, r.dst)) continue;
      const dev = ifaceByName(m, r.dev);
      if (dev && isUp(dev) && dev.ip) return { via: r.via, dev: dev.name, src: r.src || dev.ip };
    }
    return null;
  }
  function ipRouteGet(ctx, g, args) {
    const m = ctx.machine; const p = painter(g.color);
    const dst = args.filter((a) => a !== 'to')[0];
    if (!dst) { ctx.eprintln('need at least a destination address'); return 1; }
    if (!U.isIPv4(dst)) { ctx.eprintln('Error: inet address is expected rather than "' + dst + '".'); return 1; }
    const r = routeLookup(m, dst);
    if (!r) { ctx.eprintln('RTNETLINK answers: Network is unreachable'); return 2; }
    if (r.local) ctx.println('local ' + p('inet', dst) + ' dev lo src ' + p('inet', r.src) + ' uid ' + ctx.user.uid + ' \n    cache <local> ');
    else ctx.println(p('inet', dst) + (r.via ? ' via ' + p('inet', r.via) : '') + ' dev ' + p('ifname', r.dev) + ' src ' + p('inet', r.src) + ' uid ' + ctx.user.uid + ' \n    cache ');
    return 0;
  }

  const ROUTE_TYPES = ['unicast', 'blackhole', 'unreachable', 'prohibit', 'local', 'throw'];
  /** Parse "[type] TARGET [via GW] [dev D] ..." into a route record; prints and returns null on error. */
  function parseRoute(ctx, args) {
    const m = ctx.machine; const r = {};
    let n = 0;
    if (ROUTE_TYPES.includes(args[0])) { if (args[0] !== 'unicast') r.type = args[0]; n = 1; }
    const target = args[n++];
    if (!target) { ctx.eprintln('Error: Route target is missing'); return null; }
    if (target === 'default') r.dst = 'default';
    else if (target === '0.0.0.0/0') r.dst = 'default';
    else {
      const c = U.parseCidr(target);
      if (!c) { ctx.eprintln('Error: inet prefix is expected rather than "' + target + '".'); return null; }
      if (((c.ip & c.mask) >>> 0) !== c.ip) { ctx.eprintln('Error: Invalid prefix for given prefix length.'); return { fatal: 2 }; }
      r.dst = U.intToIp(c.ip) + '/' + c.bits;
    }
    for (; n < args.length; n++) {
      const k = args[n];
      if (k === 'via') { r.via = args[++n]; if (!U.isIPv4(r.via)) { ctx.eprintln('Error: inet address is expected rather than "' + r.via + '".'); return null; } }
      else if (k === 'dev' || k === 'oif') r.dev = args[++n];
      else if (k === 'metric' || k === 'priority' || k === 'preference') r.metric = parseInt(args[++n], 10) || 0;
      else if (k === 'proto') r.proto = args[++n];
      else if (k === 'src') r.src = args[++n];
      else if (k === 'scope') r.scope = args[++n];
      else if (['onlink', 'pervasive', 'realm'].includes(k)) continue;
      else if (['table', 'mtu', 'advmss', 'initcwnd', 'tos', 'weight', 'protocol'].includes(k)) n++;
      else { ctx.eprintln('Error: either "to" is duplicate, or "' + k + '" is a garbage.'); return null; }
    }
    if (r.dev && !ifaceByName(m, r.dev)) { ctx.eprintln('Cannot find device "' + r.dev + '"'); return null; }
    return r;
  }
  const sameRoute = (a, b) => a.dst === b.dst && (a.metric || 0) === (b.metric || 0);
  /**
   * Apply a route change to the machine. Returns null on success or an error code
   * ('perm', 'nodev', 'badgw', 'exists', 'nosuch') for the calling tool to word.
   */
  function applyRoute(ctx, cmd, r) {
    const m = ctx.machine;
    if (!ctx.isRoot) return 'perm';
    if (cmd === 'delete') {
      const i = m.routes.findIndex((x) => x.dst === r.dst && (r.metric == null || (x.metric || 0) === r.metric) && (!r.via || x.via === r.via) && (!r.dev || x.dev === r.dev));
      if (i < 0) return 'nosuch';
      m.routes.splice(i, 1);
      return null;
    }
    if (r.via) {
      const dev = m.ifaces.find((i) => i.kind !== 'loopback' && isUp(i) && (!r.dev || i.name === r.dev) && addrList(i).some((a) => U.inCidr(r.via, a.ip + '/' + a.bits)));
      if (!dev) return 'badgw';
      r.dev = dev.name;
    } else if (!r.dev && !r.type) return 'nodev';
    const existing = m.routes.findIndex((x) => sameRoute(x, r));
    if (cmd === 'add' && existing >= 0) return 'exists';
    if (cmd === 'change' && existing < 0) return 'nosuch';
    if (existing >= 0) m.routes.splice(existing, 1);
    m.routes.push(r); sortRoutes(m);
    return null;
  }
  const IP_ROUTE_ERR = { perm: 'RTNETLINK answers: Operation not permitted', nodev: 'RTNETLINK answers: No such device', badgw: 'Error: Nexthop has invalid gateway.', exists: 'RTNETLINK answers: File exists', nosuch: 'RTNETLINK answers: No such process' };
  function ipRouteChange(ctx, cmd, args) {
    const r = parseRoute(ctx, args);
    if (!r) return 1;
    if (r.fatal) return r.fatal;
    const err = applyRoute(ctx, cmd, r);
    if (!err) return 0;
    ctx.eprintln(cmd === 'change' && err === 'nosuch' ? 'RTNETLINK answers: No such file or directory' : IP_ROUTE_ERR[err]);
    return 2;
  }
  function ipRouteFlush(ctx, args) {
    const m = ctx.machine;
    if (!args.length) { ctx.eprintln('"ip route flush" requires arguments.'); return 1; }
    const dev = args[args.indexOf('dev') + 1];
    if (args.includes('dev') && !ifaceByName(m, dev)) { ctx.eprintln('Cannot find device "' + dev + '"'); return 1; }
    if (!ctx.isRoot) { ctx.eprintln('RTNETLINK answers: Operation not permitted'); return 2; }
    const keep = m.routes.filter((r) => (args.includes('dev') && r.dev !== dev) || (!args.includes('dev') && args[0] !== 'all' && !(args[0] === 'default' ? r.dst === 'default' : r.dst === normPrefix(args[0]))));
    m.routes.splice(0, m.routes.length, ...keep);
    return 0;
  }

  /** Drop routes whose interface or gateway is gone, as the kernel does. */
  function pruneRoutes(m) {
    const covered = (ip, dev) => ifaceByName(m, dev) && isUp(ifaceByName(m, dev)) && addrList(ifaceByName(m, dev)).some((a) => U.inCidr(ip, a.ip + '/' + a.bits));
    const keep = m.routes.filter((r) => {
      if (r.type) return true;
      if (r.via) return covered(r.via, r.dev);
      if (r.proto === 'kernel') { const base = r.dst.split('/')[0]; return covered(base, r.dev); }
      return true;
    });
    m.routes.splice(0, m.routes.length, ...keep);
  }
  function setLinkState(m, i, up) {
    const s = state(m);
    if (up === isUp(i)) return;
    i.state = up ? (i.kind === 'loopback' ? 'UNKNOWN' : 'UP') : 'DOWN';
    if (up) {
      for (const r of s.stash[i.name] || []) m.routes.push(r);
      delete s.stash[i.name];
      if (i.kind !== 'loopback') for (const a of addrList(i)) { const r = connectedRoute(i, a); if (!m.routes.some((x) => x.dst === r.dst && x.dev === i.name)) m.routes.push(r); }
      sortRoutes(m);
    } else {
      s.stash[i.name] = m.routes.filter((r) => r.dev === i.name);
      m.routes.splice(0, m.routes.length, ...m.routes.filter((r) => r.dev !== i.name));
      if (m.arp) for (const [k, e] of Array.from(m.arp)) if (e.dev === i.name) m.arp.delete(k);
    }
  }

  /* ------------------------------------------------------------ ip addr / link changes */
  function connectedRoute(i, a) {
    const c = U.parseCidr(a.ip + '/' + a.bits);
    return { dst: U.intToIp(c.network) + '/' + a.bits, dev: i.name, src: a.ip, proto: 'kernel', scope: 'link' };
  }
  function ipAddrChange(ctx, cmd, args) {
    const m = ctx.machine; let spec = null; let dev = null;
    for (let n = 0; n < args.length; n++) {
      const a = args[n];
      if (a === 'dev') dev = args[++n];
      else if (['brd', 'broadcast', 'label', 'scope', 'valid_lft', 'preferred_lft', 'peer', 'local', 'metric'].includes(a)) n++;
      else if (spec == null) spec = a;
      else if (dev == null) dev = a;
    }
    if (cmd === 'flush') {
      if (dev == null) { ctx.eprintln('Flush requires arguments.'); return 1; }
    } else if (spec == null) { ctx.eprintln('Not enough information: "ADDR" argument is required.'); return 1; }
    if (dev == null) { ctx.eprintln('Not enough information: "dev" argument is required.'); return 1; }
    const c = cmd === 'flush' ? null : U.parseCidr(spec);
    if (cmd !== 'flush' && !c) { ctx.eprintln('Error: any valid prefix is expected rather than "' + spec + '".'); return 1; }
    const i = ifaceByName(m, dev);
    if (!i) { ctx.eprintln(cmd === 'flush' ? 'Device "' + dev + '" does not exist.' : 'Cannot find device "' + dev + '"'); return 1; }
    if (!ctx.isRoot) { ctx.eprintln('RTNETLINK answers: Operation not permitted'); return 2; }
    let list = addrList(i);
    if (cmd === 'flush') list = [];
    else if (cmd === 'delete') {
      const at = list.findIndex((a) => a.ip === U.intToIp(c.ip) && a.bits === c.bits);
      if (at < 0) { ctx.eprintln('RTNETLINK answers: Cannot assign requested address'); return 2; }
      const gone = list[at]; const net0 = U.parseCidr(gone.ip + '/' + gone.bits).network;
      const primary = list.findIndex((a) => a.bits === gone.bits && U.parseCidr(a.ip + '/' + a.bits).network === net0) === at;
      list = list.filter((a, n) => n !== at && !(primary && a.bits === gone.bits && U.parseCidr(a.ip + '/' + a.bits).network === net0));
    } else {
      const ip = U.intToIp(c.ip);
      const have = list.find((a) => a.ip === ip && a.bits === c.bits);
      if (have && cmd === 'add') { ctx.eprintln('RTNETLINK answers: File exists'); return 2; }
      if (!have) list.push({ ip, bits: c.bits });
    }
    setAddrList(i, list);
    if (isUp(i) && i.kind !== 'loopback') for (const a of list) { const r = connectedRoute(i, a); if (!m.routes.some((x) => x.dst === r.dst && x.dev === i.name)) m.routes.push(r); }
    pruneRoutes(m); sortRoutes(m);
    return 0;
  }

  const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
  function ipLinkSet(ctx, args) {
    const m = ctx.machine; let dev = null; const acts = [];
    for (let n = 0; n < args.length; n++) {
      const a = args[n];
      if (a === 'dev') dev = args[++n];
      else if (a === 'up' || a === 'down') acts.push([a]);
      else if (['mtu', 'address', 'name', 'promisc', 'multicast', 'arp', 'txqueuelen', 'alias', 'allmulticast', 'master', 'type'].includes(a)) acts.push([a, args[++n]]);
      else if (dev == null) dev = a;
      else { ctx.eprintln('Error: either "dev" is duplicate, or "' + a + '" is a garbage.'); return 1; }
    }
    if (dev == null) { ctx.eprintln('Not enough information: "dev" argument is required.'); return 1; }
    const i = ifaceByName(m, dev);
    if (!i) { ctx.eprintln('Cannot find device "' + dev + '"'); return 1; }
    for (const [k, v] of acts) {
      if (k === 'address' && !MAC_RE.test(v)) { ctx.eprintln('Error: argument "' + v + '" is wrong: Invalid address'); return 1; }
      if (k === 'mtu' && !/^\d+$/.test(v || '')) { ctx.eprintln('Error: argument "' + v + '" is wrong: Invalid "mtu" value'); return 1; }
      if (k === 'promisc' && v !== 'on' && v !== 'off') { ctx.eprintln('Error: argument "' + v + '" is wrong: Invalid "promisc" value'); return 1; }
    }
    if (!ctx.isRoot) { ctx.eprintln('RTNETLINK answers: Operation not permitted'); return 2; }
    for (const [k, v] of acts) {
      if (k === 'up') setLinkState(m, i, true);
      else if (k === 'down') setLinkState(m, i, false);
      else if (k === 'mtu') {
        if (+v < 68 || +v > 65535) { ctx.eprintln('RTNETLINK answers: Invalid argument'); return 2; }
        i.mtu = +v;
      } else if (k === 'address') i.mac = v.toLowerCase();
      else if (k === 'promisc') i.promisc = v === 'on';
      else if (k === 'name') {
        if (isUp(i)) { ctx.eprintln('RTNETLINK answers: Device or resource busy'); return 2; }
        if (ifaceByName(m, v)) { ctx.eprintln('RTNETLINK answers: File exists'); return 2; }
        for (const r of m.routes) if (r.dev === i.name) r.dev = v;
        i.name = v;
      }
    }
    return 0;
  }
  function ipLinkAddDel(ctx, cmd, args) {
    const m = ctx.machine;
    const t = args.indexOf('type');
    const name = args.filter((a, n) => (t < 0 || (n !== t && n !== t + 1)) && a !== 'name' && a !== 'dev')[0];
    if (cmd === 'delete') {
      const i = ifaceByName(m, name);
      if (!i) { ctx.eprintln('Cannot find device "' + name + '"'); return 1; }
      if (!ctx.isRoot) { ctx.eprintln('RTNETLINK answers: Operation not permitted'); return 2; }
      if (i.kind !== 'dummy') { ctx.eprintln('RTNETLINK answers: Operation not supported'); return 2; }
      setLinkState(m, i, false); delete state(m).stash[i.name];
      m.ifaces.splice(m.ifaces.indexOf(i), 1);
      return 0;
    }
    if (t < 0 || !args[t + 1]) { ctx.eprintln('Not enough information: "type" argument is required'); return 1; }
    if (args[t + 1] !== 'dummy') { ctx.eprintln('Error: Unknown device type.'); return 1; }
    if (!name) { ctx.eprintln('Not enough information: "dev" argument is required.'); return 1; }
    if (!ctx.isRoot) { ctx.eprintln('RTNETLINK answers: Operation not permitted'); return 2; }
    if (ifaceByName(m, name)) { ctx.eprintln('RTNETLINK answers: File exists'); return 2; }
    m.ifaces.push({ name, ip: null, bits: undefined, mac: U.mac(name + m.hostname, '3e:61:0c'), kind: 'dummy', state: 'DOWN', mtu: 1500 });
    return 0;
  }

  /* ------------------------------------------------------------ ip neigh */
  function neighState(e) {
    if (e.permanent) return 'PERMANENT';
    if (e.state === 'FAILED') return 'FAILED';
    return K.clock.now() - e.ts < 30000 ? 'REACHABLE' : 'STALE';
  }
  function ipNeighShow(ctx, g, args) {
    const m = ctx.machine; const p = painter(g.color);
    const dev = args.includes('dev') ? args[args.indexOf('dev') + 1] : args.find((a) => ifaceByName(m, a));
    if (dev && !ifaceByName(m, dev)) { ctx.eprintln('Cannot find device "' + dev + '"'); return 1; }
    if (g.family === 6) return 0;
    const lines = Array.from((m.arp || new Map()).values()).filter((e) => !dev || e.dev === dev).map((e) => {
      const st = neighState(e);
      const ll = st === 'FAILED' ? ' ' : ' lladdr ' + p('mac', e.mac);
      const extra = g.stats ? ' ref 1 used 0/0/0 probes ' + (st === 'FAILED' ? 3 : 1) : '';
      return p('inet', e.ip) + ' dev ' + p('ifname', e.dev) + ll + extra + ' ' + st;
    });
    if (lines.length) ctx.println(lines.join('\n'));
    return 0;
  }
  function ipNeighChange(ctx, cmd, args) {
    const m = ctx.machine; let ip = null; let mac = null; let dev = null;
    for (let n = 0; n < args.length; n++) {
      const a = args[n];
      if (a === 'dev') dev = args[++n]; else if (a === 'lladdr') mac = args[++n]; else if (a === 'nud') n++; else if (a === 'to') ip = args[++n]; else if (ip == null) ip = a;
    }
    if (cmd === 'flush') {
      if (dev == null && ip == null && !args.includes('all')) { ctx.eprintln('Flush requires arguments.'); return 1; }
    } else if (!U.isIPv4(ip)) { ctx.eprintln('Error: any valid address is expected rather than "' + ip + '".'); return 1; }
    if (dev && !ifaceByName(m, dev)) { ctx.eprintln('Cannot find device "' + dev + '"'); return 1; }
    if (!ctx.isRoot) { ctx.eprintln('RTNETLINK answers: Operation not permitted'); return 2; }
    m.arp = m.arp || new Map();
    if (cmd === 'flush') { for (const [k, e] of Array.from(m.arp)) if (!dev || e.dev === dev) m.arp.delete(k); return 0; }
    if (cmd === 'delete') { if (!m.arp.delete(ip)) { ctx.eprintln('RTNETLINK answers: No such file or directory'); return 2; } return 0; }
    if (!dev) { ctx.eprintln('Not enough information: "dev" argument is required.'); return 1; }
    if (!mac || !MAC_RE.test(mac)) { ctx.eprintln('Not enough information: "lladdr" argument is required.'); return 1; }
    if (cmd === 'add' && m.arp.has(ip)) { ctx.eprintln('RTNETLINK answers: File exists'); return 2; }
    m.arp.set(ip, { ip, mac: mac.toLowerCase(), dev, ts: K.clock.now(), state: 'REACHABLE', permanent: true });
    return 0;
  }

  /* ------------------------------------------------------------ ip main */
  function ipParseOptions(ctx, args) {
    const g = { family: 0, color: false, stats: 0 };
    let color = null; let n = 0;
    for (; n < args.length && args[n][0] === '-' && args[n].length > 1; n++) {
      let a = args[n].replace(/^--?/, ''); let val = null;
      const eq = a.indexOf('=');
      if (eq >= 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
      if (a === '4') { g.family = 4; continue; }
      if (a === '6') { g.family = 6; continue; }
      if (/^[0IDBM]$/.test(a)) continue;
      const opt = ['s', 'd', 'r', 'h', 'j', 'p', 'o', 'c', 'a', 'V', 'N', 't', 'f', 'l', 'n', 'b'].includes(a) ? IP_OPTIONS.find((o) => o[0][0] === a && (a !== 't' || o[0] === 'timestamp') && (a !== 'p' || o[0] === 'pretty')) : IP_OPTIONS.find((o) => a.length > 1 && o.some((w) => abbr(a, w)));
      if (!opt) return { err: 'Option "' + args[n] + '" is unknown, try "ip -help".' };
      const name = opt[0];
      if (name === 'stats') g.stats++;
      else if (name === 'color') color = val || 'auto';
      else if (name === 'family') { const f = val || args[++n]; g.family = f === 'inet6' ? 6 : f === 'inet' ? 4 : 0; }
      else if (IP_OPT_ARG.includes(name)) { if (val == null) n++; } else if (name === 'batch') return { err: 'Option "-batch" is not supported here.' };
      else g[{ details: 'details', json: 'json', pretty: 'pretty', oneline: 'oneline', brief: 'brief', Version: 'version', Numeric: 'numeric' }[name] || name] = true;
    }
    g.color = color === 'always' || (color === 'auto' && ctx.isTTY);
    g.stats = g.stats > 0;
    if (g.pretty) g.json = true;
    return { g, rest: args.slice(n) };
  }

  const CMDS = ['add', 'delete', 'flush', 'show', 'list', 'change', 'replace', 'set', 'get', 'append', 'help', 'save'];
  const cmdOf = (a) => (a === 'lst' || a === 'ls' ? 'show' : a === 'del' ? 'delete' : (CMDS.find((c) => abbr(a, c)) === 'list' ? 'show' : CMDS.find((c) => abbr(a, c)) || null));

  async function ipRun(ctx) {
    const parsed = ipParseOptions(ctx, ctx.args);
    if (parsed.err) { ctx.eprintln(parsed.err); return 255; }
    const { g, rest } = parsed;
    if (g.version) { ctx.println(IP_VERSION); return 0; }
    if (!rest.length) { ctx.err(IP_USAGE); return 255; }
    if (rest[0] === 'help' || rest[0] === '-help') { ctx.out(IP_USAGE); return 0; }
    let obj = IP_OBJECTS.find((o) => abbr(rest[0], o));
    if (!obj) { ctx.eprintln('Object "' + rest[0] + '" is unknown, try "ip help".'); return 255; }
    if (obj === 'neighbour') obj = 'neighbor';
    const word = rest[1];
    const cmd = word == null ? 'show' : cmdOf(word);
    const args = rest.slice(2);
    const known = ['address', 'link', 'route', 'neighbor'];
    if (obj === 'rule') {
      if (cmd !== 'show') return ipRulePlaceholder(ctx, cmd);
      ctx.println(g.family === 6 ? '0:\tfrom all lookup local\n32766:\tfrom all lookup main' : '0:\tfrom all lookup local\n32766:\tfrom all lookup main\n32767:\tfrom all lookup default');
      return 0;
    }
    if (!known.includes(obj)) return 0;
    if (!cmd) { ctx.eprintln('Command "' + word + '" is unknown, try "ip ' + (obj === 'address' ? 'addr' : obj === 'neighbor' ? 'neigh' : obj) + ' help".'); return 255; }
    if (cmd === 'help') { ctx.err(IP_HELP[obj]); return 255; }
    const rd = [g, args];
    switch (obj) {
      case 'address':
        if (cmd === 'show') return ipShowAddr(ctx, g, args, false);
        if (['add', 'delete', 'flush', 'change', 'replace'].includes(cmd)) return ipAddrChange(ctx, cmd, args);
        break;
      case 'link':
        if (cmd === 'show') return ipShowAddr(ctx, g, args, true);
        if (cmd === 'set') return ipLinkSet(ctx, args);
        if (cmd === 'add' || cmd === 'delete') return ipLinkAddDel(ctx, cmd, args);
        break;
      case 'route':
        if (cmd === 'show') return ipRouteShow(ctx, g, args);
        if (cmd === 'get') return ipRouteGet(ctx, g, args);
        if (cmd === 'flush') return ipRouteFlush(ctx, args);
        if (['add', 'delete', 'change', 'replace', 'append'].includes(cmd)) return ipRouteChange(ctx, cmd === 'append' ? 'add' : cmd, args);
        break;
      default:
        if (cmd === 'show') return ipNeighShow(ctx, g, args);
        if (['add', 'delete', 'flush', 'change', 'replace'].includes(cmd)) return ipNeighChange(ctx, cmd, args);
    }
    void rd;
    ctx.eprintln('Command "' + word + '" is unknown, try "ip ' + (obj === 'address' ? 'addr' : obj === 'neighbor' ? 'neigh' : obj) + ' help".');
    return 255;
  }
  function ipRulePlaceholder(ctx) {
    if (!ctx.isRoot) { ctx.eprintln('RTNETLINK answers: Operation not permitted'); return 2; }
    return 0;
  }

  const IP_WORDS = { address: ['show', 'add', 'del', 'flush', 'replace', 'change'], link: ['show', 'set', 'add', 'delete'], route: ['show', 'add', 'del', 'replace', 'change', 'get', 'flush'], neighbor: ['show', 'add', 'del', 'flush', 'replace'] };
  K.cmd.register({
    name: 'ip', path: '/usr/bin/ip', pkg: 'iproute2', section: 8,
    summary: 'show / manipulate routing, network devices, interfaces and tunnels',
    synopsis: 'ip [ OPTIONS ] OBJECT { COMMAND | help }',
    man: 'DESCRIPTION\n       ip is the iproute2 tool for showing and changing the kernel network configuration: interfaces (link), addresses (address), routes (route) and the neighbour (ARP) table (neigh). Every object takes show as its default command; most names may be abbreviated (ip a, ip l, ip r, ip n).\n\nOPTIONS\n       -4, -6 Only the IPv4 or IPv6 family.\n       -br, -brief\n              Print one short line per interface or route.\n       -o, -oneline\n              Print every record on a single line.\n       -s, -stats\n              Print interface statistics.\n       -c, -color[=auto|always|never]\n              Colour the output.\n       -j, -json; -p, -pretty\n              JSON output, optionally indented.\n       -V     Print the version and exit.\n\nOBJECTS\n       ip address [show|add|del|flush] [dev IFNAME] ADDR/LEN\n       ip link [show|set] [dev] IFNAME [up|down|mtu N|address MAC|promisc on|off]\n       ip route [show|add|del|replace|get] PREFIX [via GW] [dev IFNAME] [metric N]\n       ip neigh [show|flush|add|del]\n\n       Changes need root and print "RTNETLINK answers: Operation not permitted" otherwise.\n\nEXAMPLES\n       ip -br addr\n              One line per interface with its state and addresses.\n       ip route get 10.10.10.10\n              Which interface and gateway would reach the intranet server?\n       sudo ip link set dev eth0 down\n              Take the interface down; routes through it disappear.',
    run: ipRun,
    complete(info) {
      const w = info.words;
      if (info.index === 1) return ['address', 'link', 'route', 'neighbor', 'rule', 'netns', '-br', '-c', '-s', '-o', '-4', '-6', '-j'];
      const optN = w.slice(1, info.index).filter((x) => x[0] === '-').length;
      const objAt = 1 + optN;
      const obj = IP_OBJECTS.find((o) => abbr(w[objAt] || '', o));
      if (info.index === objAt) return ['address', 'link', 'route', 'neighbor', 'rule', 'netns'];
      if (info.index === objAt + 1) return IP_WORDS[obj === 'neighbour' ? 'neighbor' : obj] || [];
      const prev = w[info.index - 1];
      if (prev === 'dev' || info.index === objAt + 2) return ifaceNames(info.ctx ? info.ctx.machine : K.kali);
      if (obj === 'route') return ['via', 'dev', 'metric', 'proto', 'src', 'default'];
      return ['dev'];
    },
  });


  /* ============================================== traceroute, tracepath and mtr */
  /**
   * What answers a probe sent with this TTL? Intermediate routers come from the
   * route; the destination answers unless it filters the probe type.
   * Returns { ip, name, rtt } or null for silence.
   */
  function probeHop(ctx, rt, dstIp, ttl, proto, port) {
    const net = K.net;
    const hops = rt.hops || [];
    if (ttl <= hops.length) {
      const h = hops[ttl - 1];
      if (h.silent) return null;
      net.packet({ src: rt.src, dst: dstIp, proto: proto === 'icmp' ? 'ICMP' : proto === 'tcp' ? 'TCP' : 'UDP', dport: port, info: 'ttl ' + ttl, len: 60, dev: rt.dev });
      return { ip: h.ip, name: h.name, rtt: net.jitter(h.rtt, h.rtt * 0.12 + 0.2) };
    }
    const host = rt.host;
    if (rt.self) return { ip: dstIp, rtt: net.jitter(0.03, 0.03) };
    if (rt.blackhole || !host || !host.up) return null;
    if (proto === 'tcp') {
      const t = net.tcp(ctx.machine, dstIp, port);
      return t.state === 'filtered' ? null : { ip: dstIp, rtt: t.rtt };
    }
    net.packet({ src: rt.src, dst: dstIp, proto: proto === 'icmp' ? 'ICMP' : 'UDP', dport: port, info: proto === 'icmp' ? 'echo request' : 'UDP, length 32', len: 60, dev: rt.dev });
    if ((host.firewall || {}).icmp === false) return null;
    if (host.loss && net.rand() < host.loss) return null;
    return { ip: dstIp, rtt: net.jitter(rt.rtt, host.latency.jitter == null ? 0.3 : host.latency.jitter) };
  }
  const hopLabel = (ctx, r, numeric) => {
    if (numeric) return r.ip;
    const n = r.name || rdns(ctx, r.ip);
    return n ? n + ' (' + r.ip + ')' : r.ip + ' (' + r.ip + ')';
  };

  const TRACEROUTE_VERSION = 'Modern traceroute for Linux, version 2.1.6\nCopyright (c) 2016  Dmitry Butskoy,   License: GPL v2 or any later';
  const TRACEROUTE_USAGE = [
    'Usage:', '  traceroute [ -46dFITnreAUDV ] [ -f first_ttl ] [ -g gate,... ] [ -i device ] [ -m max_ttl ] [ -N squeries ] [ -p port ] [ -t tos ] [ -l flow_label ] [ -w MAX,HERE,NEAR ] [ -q nqueries ] [ -s src_addr ] [ -z sendwait ] [ --fwmark=num ] host [ packetlen ]',
    'Options:',
    '  -4                          Use IPv4',
    '  -6                          Use IPv6',
    '  -f first_ttl  --first=first_ttl',
    '                              Start from the first_ttl hop (instead from 1)',
    '  -I  --icmp                  Use ICMP ECHO for tracerouting',
    '  -T  --tcp                   Use TCP SYN for tracerouting (default port is 80)',
    '  -i device  --interface=device',
    '                              Specify a network interface to operate with',
    '  -m max_ttl  --max-hops=max_ttl',
    '                              Set the max number of hops (max TTL to be',
    '                              reached). Default is 30',
    '  -n                          Do not resolve IP addresses to their domain names',
    '  -p port  --port=port        Set the destination port to use',
    '  -w MAX,HERE,NEAR  --wait=MAX,HERE,NEAR',
    '                              Wait for a probe no more than HERE (default 3)',
    '                              times longer than a response from the same hop,',
    '                              or no more than NEAR (default 10) times than some',
    '                              next hop, or MAX (default 5.0) seconds (float',
    '                              point values allowed too)',
    '  -q nqueries  --queries=nqueries',
    '                              Set the number of probes per each hop. Default is',
    '                              3',
    '  -s src_addr  --source=src_addr',
    '                              Use source src_addr for outgoing packets',
    '  -U  --udp                   Use UDP to particular port for tracerouting',
    '  -V  --version               Print version info and exit',
    '  --help                      Read this help and exit', '',
    'Arguments:',
    '+     host          The host to traceroute to',
    '      packetlen     The full packet length (default is the length of an IP',
    '                    header plus 40). Can be ignored or increased to a minimal',
    '                    allowed value', '',
  ].join('\n');

  async function tracerouteRun(ctx) {
    const g = K.getopt(ctx.args, { short: '46dFITnreAUDVf:g:i:m:N:p:t:l:w:q:s:z:M:O:P:', long: ['help', 'version', 'icmp', 'tcp', 'udp', 'first=', 'max-hops=', 'queries=', 'wait=', 'port=', 'source=', 'interface=', 'extensions', 'as-path-lookups', 'dont-fragment', 'debug', 'sim-queries=', 'gateway=', 'tos=', 'flowlabel=', 'sendwait=', 'module=', 'options=', 'protocol=', 'sport=', 'fwmark=', 'mtu', 'back', 'dccp'], alias: { icmp: 'I', tcp: 'T', udp: 'U', first: 'f', 'max-hops': 'm', queries: 'q', wait: 'w', port: 'p', source: 's', interface: 'i', version: 'V' } });
    if (g.err) { ctx.eprintln('Bad option `' + (g.err.match(/'(.)'/) ? '-' + g.err.match(/'(.)'/)[1] : g.err) + "' (with argument)"); ctx.eprintln('Use --help for help'); return 2; }
    const o = g.opts;
    if (o.help) { ctx.out(TRACEROUTE_USAGE); return 0; }
    if (o.V) { ctx.println(TRACEROUTE_VERSION); return 0; }
    const num = (opt, name, min, max, float) => {
      if (o[opt] == null) return undefined;
      const v = float ? parseFloat(String(o[opt]).split(',')[0]) : /^\d+$/.test(o[opt]) ? parseInt(o[opt], 10) : NaN;
      if (isNaN(v) || v < min || v > max) { ctx.eprintln('Cannot handle `-' + name + "' option with arg `" + o[opt] + "' (argc " + (ctx.args.indexOf(String(o[opt])) + 1) + ')'); return null; }
      return v;
    };
    const first = num('f', 'f', 1, 255); const max = num('m', 'm', 1, 255); const nq = num('q', 'q', 1, 10); const wait = num('w', 'w', 0.001, 60, true);
    if ([first, max, nq, wait].includes(null)) return 2;
    if (!g.rest.length) { ctx.eprintln('Specify "host" missing argument.'); return 2; }
    const target = g.rest[0];
    if (o.T && !ctx.isRoot) { ctx.eprintln('You do not have enough privileges to use this traceroute method.'); return 1; }
    const start = first || 1; const maxTtl = max || 30; const queries = nq || 3; const waitMs = (wait || 5) * 1000;
    if (start > maxTtl) { ctx.eprintln('first hop out of range'); return 2; }
    const len = g.rest[1] != null ? Math.max(28, parseInt(g.rest[1], 10) || 60) : 60;
    const dest = lookup(ctx, target);
    if (dest.err) { ctx.eprintln(target + ': ' + RESOLVE_MSG[dest.err]); ctx.eprintln('Cannot handle "host" cmdline arg `' + target + "' on position 1 (argc " + (ctx.args.indexOf(target) + 1) + ')'); return 2; }
    const rt = K.net.route(ctx.machine, dest.ip);
    if (!rt.ok && rt.err === 'ENETUNREACH') { ctx.eprintln('connect: Network is unreachable'); return 2; }
    ctx.println('traceroute to ' + target + ' (' + dest.ip + '), ' + maxTtl + ' hops max, ' + len + ' byte packets');
    const proto = o.T ? 'tcp' : o.I ? 'icmp' : 'udp';
    const port = o.p ? parseInt(o.p, 10) : o.T ? 80 : o.U ? 53 : 33434;
    if (!rt.ok) {
      // the local segment cannot resolve the next hop: the first hop reports host unreachable
      const label = hopLabel(ctx, { ip: rt.src, name: ctx.machine.hostname }, o.n);
      const t = [0, 1, 2].slice(0, queries).map(() => (3000 + K.net.rand() * 60).toFixed(3) + ' ms !H');
      await ctx.sleep(3000);
      ctx.println(padL(start, 2) + '  ' + label + '  ' + t.join('  '));
      return 0;
    }
    for (let ttl = start; ttl <= maxTtl; ttl++) {
      let line = padL(ttl, 2) + ' '; let lastIp = null; let reached = false;
      ctx.out(line);
      for (let q = 0; q < queries; q++) {
        const r = probeHop(ctx, rt, dest.ip, ttl, proto, proto === 'udp' && !o.U ? port + (ttl - 1) * queries + q : port);
        if (!r) { await ctx.sleep(waitMs); ctx.out(' *'); continue; }
        await ctx.sleep(r.rtt);
        if (r.ip !== lastIp) { ctx.out(' ' + hopLabel(ctx, r, o.n)); lastIp = r.ip; }
        ctx.out('  ' + r.rtt.toFixed(3) + ' ms');
        if (r.ip === dest.ip) reached = true;
      }
      ctx.out('\n');
      if (reached) return 0;
    }
    return 0;
  }

  K.cmd.register({
    name: 'traceroute', aliases: ['traceroute.db'], path: '/usr/bin/traceroute', pkg: 'traceroute', section: 8,
    summary: 'print the route packets trace to network host',
    synopsis: 'traceroute [-46dFITnreAUDV] [-f first_ttl] [-m max_ttl] [-p port] [-q nqueries] [-w waittime] [-s src_addr] host [packetlen]',
    man: 'DESCRIPTION\n       traceroute tracks the route packets take from this machine to a destination host by sending probes with small time-to-live (TTL) values. Every router that discards a probe because its TTL ran out answers with an ICMP "time exceeded" message, which reveals its address. The TTL starts at 1 and grows until the destination answers or the maximum number of hops is reached.\n\n       Each line shows the hop number, the router and the round-trip time of three probes. A row of asterisks means the router (or a firewall) did not answer.\n\nOPTIONS\n       -n     Do not resolve addresses to names.\n       -m max_ttl\n              Set the maximum number of hops (default 30).\n       -f first_ttl\n              Start from this hop (default 1).\n       -q nqueries\n              Probes per hop (default 3).\n       -w max\n              Seconds to wait for a response (default 5).\n       -I     Use ICMP ECHO probes instead of UDP datagrams.\n       -T     Use TCP SYN probes (default port 80). Needs root.\n       -U     Use UDP to the single port 53.\n       -p port\n              Destination port (UDP and TCP) of the probes.\n\nEXAMPLES\n       traceroute -n 8.8.8.8\n              Trace the path to a public DNS server without name lookups.\n       sudo traceroute -T -p 443 kali.org\n              Probe with TCP SYN to port 443 to get through ICMP and UDP filters.',
    run: tracerouteRun,
    complete: (info) => (info.cur && info.cur[0] === '-' ? [] : hostNames()),
  });

  /* -------------------------------------------------------------- tracepath */
  const TRACEPATH_USAGE = 'Usage\n  tracepath [options] <destination>\n\nOptions:\n  -4             use IPv4\n  -6             use IPv6\n  -b             print both name and IP\n  -l <length>    use packet <length>\n  -m <hops>      use maximum <hops>\n  -n             no reverse DNS name resolution\n  -p <port>      use destination <port>\n  -V             print version and exit\n  <destination>  DNS name or IP address\n\nFor more details see tracepath(8).\n';

  async function tracepathRun(ctx) {
    const g = K.getopt(ctx.args, { short: '46bhnVl:m:p:' });
    if (g.err || g.opts.h) { if (g.err) ctx.eprintln('tracepath: ' + g.err); ctx.err(TRACEPATH_USAGE); return g.err ? 255 : 255; }
    if (g.opts.V) { ctx.println('tracepath from iputils 20250605'); return 0; }
    if (!g.rest.length) { ctx.err(TRACEPATH_USAGE); return 255; }
    const hopsMax = g.opts.m != null ? parseInt(g.opts.m, 10) : 30;
    if (!(hopsMax > 0 && hopsMax <= 255)) { ctx.eprintln('tracepath: Invalid argument: ' + g.opts.m); return 255; }
    const dest = lookup(ctx, g.rest[0]);
    if (dest.err) { ctx.eprintln('tracepath: ' + g.rest[0] + ': ' + RESOLVE_MSG[dest.err]); return 1; }
    const rt = K.net.route(ctx.machine, dest.ip);
    if (!rt.ok && rt.err === 'ENETUNREACH') { ctx.eprintln('connect: Network is unreachable'); return 1; }
    const iface = ifaceByName(ctx.machine, rt.dev || '') || ctx.machine.primaryIface();
    const mtu = (iface && iface.mtu) || 1500;
    const label = (r) => {
      if (g.opts.n) return r.ip;
      const n = r.name || rdns(ctx, r.ip);
      return g.opts.b ? (n ? n + ' (' + r.ip + ')' : r.ip + ' (' + r.ip + ')') : n || r.ip;
    };
    const row = (ttl, text, ms, tail) => padL(ttl, 2) + ':  ' + pad(text, 46) + padL(ms.toFixed(3), 9) + 'ms ' + (tail || '');
    ctx.println(' 1?: ' + pad('[LOCALHOST]', 32) + ' pmtu ' + mtu);
    let reachedAt = 0;
    for (let ttl = 1; ttl <= hopsMax; ttl++) {
      const r = rt.ok ? probeHop(ctx, rt, dest.ip, ttl, 'udp', 44444 + ttl) : null;
      if (!r) { await ctx.sleep(3000); ctx.println(padL(ttl, 2) + ':  no reply'); continue; }
      await ctx.sleep(r.rtt);
      const reached = r.ip === dest.ip;
      ctx.println(row(ttl, label(r), r.rtt, reached ? 'reached' : ''));
      if (ttl === 1 && !reached) { const again = probeHop(ctx, rt, dest.ip, 1, 'udp', 44444); if (again) ctx.println(row(1, label(again), again.rtt, '')); }
      if (reached) { reachedAt = ttl; break; }
    }
    if (!reachedAt) { ctx.println('     Too many hops: pmtu ' + mtu); ctx.println('     Resume: pmtu ' + mtu + ' '); return 1; }
    ctx.println('     Resume: pmtu ' + mtu + ' hops ' + reachedAt + ' back ' + reachedAt + ' ');
    return 0;
  }

  K.cmd.register({
    name: 'tracepath', aliases: ['tracepath6'], path: '/usr/bin/tracepath', pkg: 'iputils-tracepath', section: 8,
    summary: 'traces path to a network host discovering MTU along this path',
    synopsis: 'tracepath [-4] [-6] [-n] [-b] [-l pktlen] [-m max_hops] [-p port] destination',
    man: 'DESCRIPTION\n       tracepath traces the network path to destination discovering MTU along this path. It uses UDP port port or some random port. It is similar to traceroute, only it does not require superuser privileges and has no fancy options.\n\nOPTIONS\n       -n     Print primarily IP addresses, no name lookups.\n       -b     Print both host names and IP addresses.\n       -l pktlen\n              Set the initial packet length.\n       -m max_hops\n              Set maximum hops (or maximum TTLs) to max_hops. Default is 30.\n       -p port\n              Sets the initial destination port to use.\n\nEXAMPLES\n       tracepath -n 10.10.10.10\n              Show the path and path MTU to the intranet server.',
    run: tracepathRun,
    complete: (info) => (info.cur && info.cur[0] === '-' ? [] : hostNames()),
  });

  /* -------------------------------------------------------------------- mtr */
  const MTR_USAGE = 'usage: mtr [-hvbgspxtTUCe46zJ] [--help] [--version] [--report] [--report-wide]\n\t\t[--report-cycles=COUNT] [--no-dns] [--address ADDRESS] [--interval=SECONDS]\n\t\t[--max-ttl=NUM] [--psize=BYTES|-s BYTES] HOSTNAME [PORT]\n\nSee the man page for details.\n';
  function mtrStats(h) {
    const a = h.rtts; const n = a.length;
    const avg = n ? a.reduce((x, y) => x + y, 0) / n : 0;
    const sd = n > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - avg) * (y - avg), 0) / (n - 1)) : 0;
    return { loss: h.sent ? (h.sent - n) * 100 / h.sent : 0, last: n ? a[n - 1] : 0, avg, best: n ? Math.min.apply(null, a) : 0, worst: n ? Math.max.apply(null, a) : 0, sd };
  }
  function mtrRow(i, label, h, width) {
    const s = mtrStats(h); const f = (x) => x.toFixed(1);
    const loss = s.loss >= 100 ? '100.0' : f(s.loss) + '%';
    return pad(padL(i + 1, 3) + '.|-- ' + label, width) + padL(loss, 5) + padL(h.sent, 6) + padL(f(s.last), 7) + padL(f(s.avg), 6) + padL(f(s.best), 6) + padL(f(s.worst), 6) + padL(f(s.sd), 6);
  }

  async function mtrRun(ctx) {
    const g = K.getopt(ctx.args, { short: '46bgspxtTUCeJzhvrwnc:i:m:o:P:a:f:B:S:', long: ['help', 'version', 'report', 'report-wide', 'no-dns', 'show-ips', 'report-cycles=', 'interval=', 'max-ttl=', 'psize=', 'address=', 'curses', 'displaymode=', 'udp', 'tcp', 'json', 'csv'], alias: { help: 'h', version: 'v', report: 'r', 'report-wide': 'w', 'no-dns': 'n', 'show-ips': 'b', 'report-cycles': 'c', interval: 'i', 'max-ttl': 'm', psize: 's' } });
    if (g.err) { ctx.eprintln('mtr: ' + g.err); ctx.err(MTR_USAGE); return 1; }
    const o = g.opts;
    if (o.h) { ctx.out(MTR_USAGE); return 0; }
    if (o.v) { ctx.println('mtr 0.96'); return 0; }
    if (!g.rest.length) { ctx.err(MTR_USAGE); return 1; }
    const cycles = o.c != null ? parseInt(o.c, 10) : 10; const interval = o.i != null ? parseFloat(o.i) : 1; const maxTtl = o.m != null ? parseInt(o.m, 10) : 30;
    if (!(cycles > 0) || !(interval > 0) || !(maxTtl > 0)) { ctx.eprintln('mtr: Invalid argument'); return 1; }
    const target = g.rest[0];
    const dest = lookup(ctx, target);
    if (dest.err) { ctx.eprintln('mtr: Failed to resolve host: ' + target + ': ' + RESOLVE_MSG[dest.err]); return 1; }
    const rt = K.net.route(ctx.machine, dest.ip);
    if (!rt.ok && rt.err === 'ENETUNREACH') { ctx.eprintln('mtr: Failed to start: Network is unreachable'); return 1; }
    const hopCount = Math.min(maxTtl, rt.ok ? (rt.hops || []).length + 1 : 1);
    const hops = Array.from({ length: hopCount }, () => ({ sent: 0, rtts: [], ip: null, name: null }));
    const proto = o.T || o.tcp ? 'tcp' : o.U || o.udp ? 'udp' : 'icmp';
    const cycle = () => hops.forEach((h, n) => {
      h.sent++;
      const r = rt.ok ? probeHop(ctx, rt, dest.ip, n + 1, proto, 80) : null;
      if (r) { h.rtts.push(r.rtt); h.ip = r.ip; h.name = r.name; }
    });
    const label = (h, n) => {
      if (!h.ip) return '???';
      const name = h.name || rdns(ctx, h.ip) || (n === hops.length - 1 && h.ip === dest.ip && !dest.literal ? target : null);
      if (o.n || !name) return h.ip;
      return o.b ? name + ' (' + h.ip + ')' : name;
    };
    const live = ctx.isTTY && !o.r && !o.json && !o.csv;
    if (live) return mtrLive(ctx, { hops, cycle, label, target, dest, interval, o });
    for (let c = 0; c < cycles; c++) { cycle(); if (c < cycles - 1) await ctx.sleep(interval * 1000); }
    await ctx.sleep(Math.min(interval * 1000, 1000));
    const labels = hops.map(label);
    const width = Math.max(34, o.w ? 8 + Math.max.apply(null, labels.map((l) => l.length)) + 1 : 0);
    ctx.println('Start: ' + U.isoDate(K.clock.now()).replace(' ', 'T').slice(0, 19) + '+0000');
    ctx.println(pad('HOST: ' + ctx.machine.hostname, width) + 'Loss%   Snt   Last   Avg  Best  Wrst StDev');
    hops.forEach((h, n) => ctx.println(mtrRow(n, labels[n].length > 25 && !o.w ? labels[n].slice(0, 25) : labels[n], h, width)));
    return 0;
  }

  /** The curses screen: redrawn every interval until q or Ctrl-C. */
  async function mtrLive(ctx, s) {
    let quit = false;
    const off = ctx.term.onKey((k) => { if (k === 'q' || k === 'Q') quit = true; });
    try {
      while (!quit) {
        s.cycle();
        const labels = s.hops.map(s.label);
        const head = ctx.machine.hostname + ' (' + ctx.machine.primaryIp() + ')';
        const stamp = U.isoDate(K.clock.now()).replace(' ', 'T').slice(0, 19) + '+0000';
        const lines = [
          U.padStart('My traceroute  [v0.96]', 48), pad(head, Math.max(40, ctx.cols - stamp.length)) + stamp,
          'Keys:  Help   Display mode   Restart statistics   Order of fields   quit',
          U.padStart('Packets               Pings', 62),
          ' Host' + ' '.repeat(34) + 'Loss%   Snt   Last   Avg  Best  Wrst StDev',
        ].concat(s.hops.map((h, n) => mtrRow(n, labels[n], h, 40).replace(/^(\s*\d+)\.\|-- /, '$1. ')));
        ctx.out('\x1b[2J\x1b[H' + lines.join('\n') + '\n');
        await ctx.sleep(s.interval * 1000);
      }
    } finally { off(); }
    return 0;
  }

  K.cmd.register({
    name: 'mtr', pkg: 'mtr-tiny', section: 8,
    summary: 'a network diagnostic tool',
    synopsis: 'mtr [-hvbgspxtTUCe46zJ] [--report] [--report-wide] [--report-cycles COUNT] [--no-dns] [--interval SECONDS] [--max-ttl NUM] HOSTNAME',
    man: 'DESCRIPTION\n       mtr combines the functionality of the traceroute and ping programs in a single network diagnostic tool. As mtr starts, it investigates the network connection between the host mtr runs on and HOSTNAME by sending packets with purposely low TTLs, then keeps measuring every hop it found: loss, latency and jitter.\n\n       Without --report mtr runs on the terminal and redraws the table every second; press q or Ctrl-C to leave.\n\nOPTIONS\n       -r, --report\n              Run non-interactively for --report-cycles cycles and print one table.\n       -c COUNT, --report-cycles COUNT\n              Number of pings sent per hop in report mode (default 10).\n       -n, --no-dns\n              Do not resolve host names.\n       -b, --show-ips\n              Show both host names and IP addresses.\n       -w, --report-wide\n              Report mode with the full host names.\n       -i SECONDS, --interval SECONDS\n              Time between pings (default 1).\n       -m NUM, --max-ttl NUM\n              Largest TTL to probe (default 30).\n       -T, --tcp; -u, --udp\n              Probe with TCP SYN or UDP instead of ICMP.\n       -4     Use IPv4 only.\n\nEXAMPLES\n       mtr -rn -c 5 10.10.10.10\n              Five-cycle report without name lookups.\n       mtr kali.org\n              Live view; press q to quit.',
    run: mtrRun,
    complete: (info) => (info.cur && info.cur[0] === '-' ? [] : hostNames()),
  });


  /* ============================================== sockets: ss and netstat */
  const SERVICES = { 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'domain', 67: 'bootps', 68: 'bootpc', 80: 'http', 110: 'pop3', 111: 'sunrpc', 123: 'ntp', 139: 'netbios-ssn', 143: 'imap2', 161: 'snmp', 389: 'ldap', 443: 'https', 445: 'microsoft-ds', 515: 'printer', 631: 'ipp', 873: 'rsync', 993: 'imaps', 995: 'pop3s', 2049: 'nfs', 3306: 'mysql', 5353: 'mdns', 5432: 'postgresql', 8080: 'http-alt' };
  const portText = (port, numeric) => (numeric || port === '*' ? String(port) : SERVICES[port] || String(port));
  const BACKLOG = { apache2: 511, nginx: 511, mariadbd: 80, mysqld: 80 };

  /** Every socket the machine has open, one row per bound address. */
  function localSockets(ctx) {
    const m = ctx.machine; const rows = []; const fds = {};
    const owner = (l) => { const p = m.procs.find((x) => x.pid === l.pid); return p ? p.user : 'root'; };
    for (const l of K.net.listening(m)) {
      const proto = l.proto === 'udp' ? 'udp' : 'tcp';
      const prog = l.prog || String(l.name || l.unit || '?').replace(/\.service$/, '');
      const base = { proto, state: proto === 'tcp' ? 'LISTEN' : 'UNCONN', recvq: 0, sendq: proto === 'tcp' ? l.backlog || BACKLOG[prog] || 128 : 0, lport: l.port, pport: '*', pid: l.pid, prog, owner: owner(l) };
      const add = (v6, laddr, extra) => { fds[l.pid] = (fds[l.pid] || 2) + 1; rows.push(Object.assign({}, base, { v6, laddr, paddr: v6 ? '::' : '0.0.0.0', fd: fds[l.pid] }, extra)); };
      const addr = l.addr || '0.0.0.0';
      if (addr !== '0.0.0.0') add(false, addr);
      else if (prog === 'apache2') add(true, '::', { star: true });
      else { add(false, '0.0.0.0'); add(true, '::'); }
    }
    const nm = m.procs.find((p) => /NetworkManager/.test(p.cmd));
    const eth = m.primaryIface();
    if (nm && eth && m.profile === 'kali') rows.push({ proto: 'udp', state: 'UNCONN', recvq: 0, sendq: 0, laddr: eth.ip + '%' + eth.name, lport: 68, paddr: '0.0.0.0', pport: '*', v6: false, pid: nm.pid, prog: 'NetworkManager', owner: 'root', fd: 29, plainAddr: eth.ip });
    return rows;
  }
  /** Rows after the tool's own filters (-t -u -l -a -4 -6). */
  function selectSockets(ctx, f) {
    return localSockets(ctx).filter((r) => (f.tcp && r.proto === 'tcp') || (f.udp && r.proto === 'udp'))
      .filter((r) => (f.listening && r.state !== 'ESTAB') || f.all || (!f.listening && !f.all && r.state === 'ESTAB'))
      .filter((r) => (f.v4 && !r.v6) || (f.v6 && r.v6) || (!f.v4 && !f.v6))
      .sort((a, b) => (a.proto === b.proto ? 0 : a.proto === 'udp' ? -1 : 1));
  }
  const visibleProc = (ctx, r) => ctx.isRoot || r.owner === ctx.user.name;

  const SS_USAGE = 'Usage: ss [ OPTIONS ]\n       ss [ OPTIONS ] [ FILTER ]\n   -h, --help          this message\n   -V, --version       output version information\n   -n, --numeric       don\'t resolve service names\n   -r, --resolve       resolve host names\n   -a, --all           display all sockets\n   -l, --listening     display listening sockets\n   -o, --options       show timer information\n   -e, --extended      show detailed socket information\n   -m, --memory        show socket memory usage\n   -p, --processes     show process using socket\n   -i, --info          show internal TCP information\n   -s, --summary       show socket usage summary\n   -4, --ipv4          display only IP version 4 sockets\n   -6, --ipv6          display only IP version 6 sockets\n   -0, --packet        display PACKET sockets\n   -t, --tcp           display only TCP sockets\n   -u, --udp           display only UDP sockets\n   -d, --dccp          display only DCCP sockets\n   -w, --raw           display only RAW sockets\n   -x, --unix          display only Unix domain sockets\n   -H, --no-header     Suppress header line\n   -O, --oneline       socket\'s data printed on a single line\n\n   -A, --query=QUERY, --socket=QUERY\n       QUERY := {all|inet|tcp|udp|raw|unix|unix_dgram|unix_stream|unix_seqpacket|packet|netlink|vsock_stream|vsock_dgram|tipc}[,QUERY]\n\n   -D, --diag=FILE     Dump raw information about TCP sockets to FILE\n   -F, --filter=FILE   read filter information from FILE\n       FILTER := [ state STATE-FILTER ] [ EXPRESSION ]\n       STATE-FILTER := {all|connected|synchronized|bucket|big|TCP-STATES}\n         TCP-STATES := {established|syn-sent|syn-recv|fin-wait-{1,2}|time-wait|closed|close-wait|last-ack|listening|closing}\n          connected := {established|syn-sent|syn-recv|fin-wait-{1,2}|time-wait|close-wait|last-ack|closing}\n       synchronized := {established|syn-recv|fin-wait-{1,2}|time-wait|close-wait|last-ack|closing}\n          bucket := {syn-recv|time-wait}\n             big := {established|syn-sent|fin-wait-{1,2}|closed|close-wait|last-ack|listening|closing}\n';

  async function ssRun(ctx) {
    const g = K.getopt(ctx.args, { short: 'hVnraloemMpiOsHtudwx046A:D:F:f:bKNEzSTQCc', long: ['help', 'version', 'numeric', 'resolve', 'all', 'listening', 'options', 'extended', 'memory', 'processes', 'info', 'summary', 'ipv4', 'ipv6', 'packet', 'tcp', 'udp', 'raw', 'unix', 'dccp', 'no-header', 'oneline', 'query=', 'socket=', 'diag=', 'filter='], alias: { help: 'h', version: 'V', numeric: 'n', resolve: 'r', all: 'a', listening: 'l', options: 'o', extended: 'e', memory: 'm', processes: 'p', info: 'i', summary: 's', ipv4: '4', ipv6: '6', packet: '0', tcp: 't', udp: 'u', raw: 'w', unix: 'x', 'no-header': 'H', oneline: 'O' } });
    if (g.err) { ctx.eprintln('ss: ' + g.err); ctx.err(SS_USAGE); return 1; }
    const o = g.opts;
    if (o.h) { ctx.out(SS_USAGE); return 0; }
    if (o.V) { ctx.println(IP_VERSION.replace('ip utility', 'ss utility')); return 0; }
    const anyProto = o.t || o.u || o.x || o.w || o.d || o['0'];
    const f = { tcp: !anyProto || !!o.t, udp: !anyProto || !!o.u, listening: !!o.l, all: !!o.a, v4: !!o['4'], v6: !!o['6'] };
    if (o.x && !o.t && !o.u) { f.tcp = false; f.udp = false; }
    const rows = selectSockets(ctx, f);
    const netid = (f.tcp ? 1 : 0) + (f.udp ? 1 : 0) + (o.x ? 1 : 0) > 1;
    const text = rows.map((r) => {
      const star = r.star ? '*' : r.v6 ? '[' + r.laddr + ']' : r.laddr;
      const pstar = r.star ? '*' : r.v6 ? '[' + r.paddr + ']' : r.paddr;
      const users = o.p && visibleProc(ctx, r) ? 'users:(("' + r.prog + '",pid=' + r.pid + ',fd=' + r.fd + '))' : '';
      return [r.proto, r.state, String(r.recvq), String(r.sendq), star + ':', portText(r.lport, o.n), pstar + ':', r.pport, users];
    });
    const heads = ['Netid', 'State', 'Recv-Q', 'Send-Q', 'Local Address:', 'Port', 'Peer Address:', 'Port', 'Process'];
    const all = o.H ? text : [heads].concat(text);
    const w = heads.map((h, c) => Math.max(c === 2 || c === 3 ? 6 : 0, ...all.map((r) => r[c].length)));
    w[4] = w[6] = Math.max(w[4], w[6]);
    const align = [0, 0, 0, 0, 1, 0, 1, 0, 0]; const delim = ['', ' ', ' ', ' ', ' ', '', ' ', '', ''];
    const out = all.map((r) => {
      let line = '';
      r.forEach((cell, c) => {
        if (c === 0 && !netid) return;
        const lead = (c === 1 && !netid) ? '' : delim[c];
        line += lead + (align[c] ? padL(cell, w[c]) : pad(cell, w[c]));
      });
      return line;
    });
    if (out.length) ctx.println(out.join('\n'));
    return 0;
  }

  K.cmd.register({
    name: 'ss', path: '/usr/bin/ss', pkg: 'iproute2', section: 8,
    summary: 'another utility to investigate sockets',
    synopsis: 'ss [options] [ FILTER ]',
    man: 'DESCRIPTION\n       ss is used to dump socket statistics. It allows showing information similar to netstat. It can display more TCP and state information than other tools.\n\nOPTIONS\n       -t, --tcp      Display TCP sockets.\n       -u, --udp      Display UDP sockets.\n       -l, --listening\n              Display only listening sockets (these are omitted by default).\n       -a, --all      Display both listening and non-listening sockets.\n       -n, --numeric  Do not try to resolve service names.\n       -p, --processes\n              Show process using socket. Other users\' processes are only shown to root.\n       -4, --ipv4; -6, --ipv6\n              Display only IP version 4 or 6 sockets.\n       -H, --no-header\n              Suppress the header line.\n       -V, --version  Output version information.\n\nEXAMPLES\n       ss -tulpn\n              All listening TCP and UDP sockets with the owning process.\n       ss -tlnH\n              Listening TCP sockets without a header, handy for scripts.',
    run: ssRun,
  });

  /* ---------------------------------------------------------------- netstat */
  const NETSTAT_USAGE = 'usage: netstat [-vWeenNcCF] [<Af>] -r         netstat {-V|--version|-h|--help}\n       netstat [-vWnNcaeol] [<Socket> ...]\n       netstat { [-vWeenNac] -I[<Iface>] | [-veenNac] -i | [-cnNe] -M | -s [-6tuw] } [delay]\n\n        -r, --route              display routing table\n        -I, --interfaces=<Iface> display interface table for <Iface>\n        -i, --interfaces         display interface table\n        -g, --groups             display multicast group memberships\n        -s, --statistics         display networking statistics (like SNMP)\n        -M, --masquerade         display masqueraded connections\n\n        -v, --verbose            be verbose\n        -W, --wide               don\'t truncate IP addresses\n        -n, --numeric            don\'t resolve names\n        --numeric-hosts          don\'t resolve host names\n        --numeric-ports          don\'t resolve port names\n        --numeric-users          don\'t resolve user names\n        -N, --symbolic           resolve hardware names\n        -e, --extend             display other/more information\n        -p, --programs           display PID/Program name for sockets\n        -o, --timers             display timers\n        -c, --continuous         continuous listing\n\n        -l, --listening          display listening server sockets\n        -a, --all                display all sockets (default: connected)\n        -F, --fib                display Forwarding Information Base (default)\n        -C, --cache              display routing cache instead of FIB\n        -Z, --context            display SELinux security context for sockets\n\n  <Socket>={-t|--tcp} {-u|--udp} {-U|--udplite} {-S|--sctp} {-w|--raw}\n           {-x|--unix} --ax25 --ipx --netrom\n  <AF>=Use \'-6|-4\' or \'-A <af>\' or \'--<af>\'; default: inet\n  List of possible address families (which support routing):\n    inet (DARPA Internet) inet6 (IPv6) ax25 (AMPR AX.25) \n    netrom (AMPR NET/ROM) ipx (Novell IPX) ddp (Appletalk DDP) \n    x25 (CCITT X.25) \n';
  const NET_TOOLS_VERSION = 'net-tools 2.10';

  function ifaceStatsRow(m, i) {
    const s = nlStats(m, i);
    const lo = i.kind === 'loopback';
    const flg = (lo ? 'L' : 'BM') + (i.promisc ? 'p' : '') + (isUp(i) ? 'RU' : '');
    return pad(i.name, 5) + ' ' + padL(i.mtu || 1500, 8) + ' ' + padL(s.rxp, 8) + ' ' + padL(0, 6) + ' ' + padL(0, 6) + ' ' + pad('0', 6) + ' ' + padL(s.txp, 8) + ' ' + padL(0, 6) + ' ' + padL(0, 6) + ' ' + padL(0, 6) + ' ' + flg;
  }
  const IFACE_STATS_HEAD = 'Iface      MTU    RX-OK RX-ERR RX-DRP RX-OVR    TX-OK TX-ERR TX-DRP TX-OVR Flg';
  const UNIX_SOCKETS = [
    ['unix', 2, '[ ACC ]', 'STREAM', 'LISTENING', 17418, '/run/user/1000/systemd/private'], ['unix', 2, '[ ACC ]', 'STREAM', 'LISTENING', 12874, '/run/systemd/private'],
    ['unix', 2, '[ ACC ]', 'STREAM', 'LISTENING', 12876, '/run/dbus/system_bus_socket'], ['unix', 2, '[ ACC ]', 'SEQPACKET', 'LISTENING', 12883, '/run/udev/control'],
    ['unix', 2, '[ ]', 'DGRAM', '', 12858, '/run/systemd/notify'],
  ];

  function netstatRoutes(ctx, numeric) {
    const m = ctx.machine;
    const rows = m.routes.filter((r) => !r.type).slice().sort(displayOrder).map((r) => {
      const c = r.dst === 'default' ? { network: 0, mask: 0, bits: 0 } : U.parseCidr(r.dst);
      const flags = 'U' + (r.via ? 'G' : '') + (c.bits === 32 ? 'H' : '');
      return { dst: U.intToIp(c.network), via: r.via || '0.0.0.0', mask: U.maskFromBits(c.bits), flags, metric: r.metric || 0, dev: r.dev, def: r.dst === 'default' };
    });
    return rows.map((r) => Object.assign(r, numeric ? {} : { dst: r.def ? 'default' : r.dst, via: r.via === '0.0.0.0' ? r.via : rdns(ctx, r.via) || r.via }));
  }

  async function netstatRun(ctx) {
    const g = K.getopt(ctx.args, { short: 'rIiMgsvWnNecoplaFCZtuUSwxd46hVAc:', long: ['route', 'interfaces', 'groups', 'statistics', 'verbose', 'wide', 'numeric', 'numeric-hosts', 'numeric-ports', 'numeric-users', 'symbolic', 'extend', 'programs', 'timers', 'continuous', 'listening', 'all', 'fib', 'cache', 'tcp', 'udp', 'raw', 'unix', 'help', 'version', 'ipv4', 'ipv6', 'masquerade', 'udplite', 'sctp', 'context'], alias: { route: 'r', interfaces: 'i', numeric: 'n', programs: 'p', listening: 'l', all: 'a', tcp: 't', udp: 'u', raw: 'w', unix: 'x', help: 'h', version: 'V', extend: 'e', wide: 'W', verbose: 'v', ipv4: '4', ipv6: '6' } });
    if (g.err) { ctx.eprintln('netstat: ' + g.err); ctx.err(NETSTAT_USAGE); return 1; }
    const o = g.opts; const m = ctx.machine;
    if (o.h) { ctx.out(NETSTAT_USAGE); return 0; }
    if (o.V) { ctx.println(NET_TOOLS_VERSION + '\nFred Baumgarten, Alan Cox, Bernd Eckenfels, Phil Blundell, Tuan Hoang, Brian Micek and others\n+NEW_ADDRT +RTNETLINK +IPV6 +IPX +AX25 +NETROM +X25 +ATALK +ECONET +ROSE'); return 0; }
    if (o.r) {
      const rows = netstatRoutes(ctx, !!o.n);
      const lines = ['Kernel IP routing table', 'Destination     Gateway         Genmask         Flags   MSS Window  irtt Iface'];
      for (const r of rows) lines.push(pad(r.dst, 15) + ' ' + pad(r.via, 15) + ' ' + pad(r.mask, 15) + ' ' + pad(r.flags, 5) + ' ' + padL(0, 5) + ' ' + pad('0', 6) + ' ' + padL(0, 5) + ' ' + r.dev);
      ctx.println(lines.join('\n'));
      return 0;
    }
    if (o.i) {
      const list = netToolsOrder(m).filter((i) => o.a || isUp(i));
      ctx.println(['Kernel Interface table', IFACE_STATS_HEAD].concat(list.map((i) => ifaceStatsRow(m, i))).join('\n'));
      return 0;
    }
    if (o.s) { ctx.eprintln('netstat: statistics are not available in the simulator'); return 1; }
    const anyProto = o.t || o.u || o.w || o.x;
    const f = { tcp: !anyProto || !!o.t, udp: !anyProto || !!o.u, listening: !!o.l, all: !!o.a, v4: !!o['4'], v6: !!o['6'] };
    const rows = selectSockets(ctx, f);
    if (o.p && !ctx.isRoot) ctx.err('(Not all processes could be identified, non-owned process info\n will not be shown, you would have to be root to see it all.)\n');
    const kind = o.l && !o.a ? 'only servers' : o.a ? 'servers and established' : 'w/o servers';
    const lines = ['Active Internet connections (' + kind + ')', 'Proto Recv-Q Send-Q Local Address           Foreign Address         State      ' + (o.p ? ' PID/Program name    ' : '')];
    for (const r of rows.slice().sort((a, b) => (a.proto === b.proto ? 0 : a.proto === 'tcp' ? -1 : 1) || (a.v6 ? 1 : 0) - (b.v6 ? 1 : 0))) {
      const a = r.v6 ? '::' : r.plainAddr || r.laddr;
      const host = (name) => (o.n ? name : name === '127.0.0.1' ? 'localhost' : name);
      const local = (r.v6 ? ':::' : host(a) + ':') + portText(r.lport, o.n);
      const foreign = (r.v6 ? ':::' : '0.0.0.0:') + '*';
      const proc = o.p ? ' ' + pad(visibleProc(ctx, r) ? r.pid + '/' + r.prog : '-', 20) : '';
      lines.push(pad(r.proto + (r.v6 ? '6' : ''), 5) + ' ' + padL(r.recvq, 6) + ' ' + padL(r.sendq, 6) + ' ' + pad(local, 23) + ' ' + pad(foreign, 23) + ' ' + pad(r.proto === 'tcp' ? r.state : '', 11).slice(0, 11) + proc);
    }
    if (o.a && !o.t && !o.u || o.x) {
      lines.push('Active UNIX domain sockets (' + (o.l && !o.a ? 'only servers' : 'servers and established') + ')', 'Proto RefCnt Flags       Type       State         I-Node   Path');
      for (const u of UNIX_SOCKETS) lines.push(pad(u[0], 5) + ' ' + pad(String(u[1]), 6) + ' ' + pad(u[2], 11) + ' ' + pad(u[3], 10) + ' ' + pad(u[4], 13) + ' ' + pad(String(u[5]), 8) + ' ' + u[6]);
    }
    ctx.println(lines.join('\n'));
    return 0;
  }

  K.cmd.register({
    name: 'netstat', path: '/usr/bin/netstat', pkg: 'net-tools', section: 8, only: 'kali',
    summary: 'Print network connections, routing tables, interface statistics, masquerade connections, and multicast memberships',
    synopsis: 'netstat [address_family_options] [--tcp|-t] [--udp|-u] [--raw|-w] [--listening|-l] [--all|-a] [--numeric|-n] [--programs|-p]\n       netstat {--route|-r} [-n]\n       netstat {--interfaces|-i}',
    man: 'DESCRIPTION\n       Netstat prints information about the Linux networking subsystem. The type of information printed is controlled by the first argument: sockets (the default), the routing table (-r) or the interface table (-i).\n\nOPTIONS\n       -t, --tcp; -u, --udp\n              Show only TCP or UDP sockets.\n       -l, --listening\n              Show only listening sockets.\n       -a, --all\n              Show both listening and non-listening sockets.\n       -n, --numeric\n              Show numerical addresses instead of trying to determine symbolic host, port or user names.\n       -p, --programs\n              Show the PID and name of the program to which each socket belongs. Other users\' programs are only shown to root.\n       -r, --route\n              Display the kernel routing tables.\n       -i, --interfaces\n              Display a table of all network interfaces.\n\nEXAMPLES\n       netstat -tulpn\n              Listening TCP and UDP sockets with their programs.\n       netstat -rn\n              The routing table without name lookups.',
    run: netstatRun,
  });


  /* ------------------------------------------------ ifconfig, route and arp */
  const NET_TOOLS_USAGE_IF = 'Usage:\n  ifconfig [-a] [-v] [-s] <interface> [[<AF>] <address>]\n  [add <address>[/<prefixlen>]]\n  [del <address>[/<prefixlen>]]\n  [[-]broadcast [<address>]]  [[-]pointopoint [<address>]]\n  [netmask <address>]  [dstaddr <address>]  [tunnel <address>]\n  [outfill <NN>] [keepalive <NN>]\n  [hw <HW> <address>]  [mtu <NN>]\n  [[-]trailers]  [[-]arp]  [[-]allmulti]\n  [multicast]  [[-]promisc]\n  [mem_start <NN>]  [io_addr <NN>]  [irq <NN>]  [media <type>]\n  [txqueuelen <NN>]\n  [[-]dynamic]\n  [up|down] ...\n\n  <HW>=Hardware Type.\n  List of possible hardware types:\n    loop (Local Loopback) slip (Serial Line IP) cslip (VJ Serial Line IP) \n    slip6 (6-bit Serial Line IP) cslip6 (VJ 6-bit Serial Line IP) adaptive (Adaptive Serial Line IP) \n    ash (Ash) ether (Ethernet) ax25 (AMPR AX.25) \n    netrom (AMPR NET/ROM) rose (AMPR ROSE) tunnel (IPIP Tunnel) \n    ppp (Point-to-Point Protocol) hdlc ((Cisco)-HDLC) lapb (LAPB) \n    arcnet (ARCnet) dlci (Frame Relay DLCI) frad (Frame Relay Access Device) \n    sit (IPv6-in-IPv4) fddi (Fiber Distributed Data Interface) hippi (HIPPI) \n    irda (IrLAP) ec (Econet) x25 (generic X.25) \n    eui64 (Generic EUI-64) \n  <AF>=Address family. Default: inet\n  List of possible address families:\n    unix (UNIX Domain) inet (DARPA Internet) inet6 (IPv6) \n    ax25 (AMPR AX.25) netrom (AMPR NET/ROM) rose (AMPR ROSE) \n    ipx (Novell IPX) ddp (Appletalk DDP) ec (Econet) \n    ash (Ash) x25 (CCITT X.25) \n';

  const IFF = { UP: 1, BROADCAST: 2, LOOPBACK: 8, RUNNING: 0x40, NOARP: 0x80, PROMISC: 0x100, MULTICAST: 0x1000 };
  function ifFlagNames(i) {
    const f = [];
    if (isUp(i)) f.push('UP');
    f.push(i.kind === 'loopback' ? 'LOOPBACK' : 'BROADCAST');
    if (isUp(i)) f.push('RUNNING');
    if (i.promisc) f.push('PROMISC');
    if (i.kind !== 'loopback') f.push(i.kind === 'dummy' ? 'NOARP' : 'MULTICAST');
    return f;
  }
  const byteSize = (n) => {
    if (n < 1024) return n + ' bytes';
    const u = ['KiB', 'MiB', 'GiB', 'TiB']; let v = n; let k = -1;
    do { v /= 1024; k++; } while (v >= 1024 && k < 3);
    return (v.toFixed(1)) + ' ' + u[k];
  };
  const humanBytes = (n) => (n < 1024 ? n + ' (' + n.toFixed(1) + ' B)' : n + ' (' + byteSize(n) + ')');

  function ifconfigBlock(m, i) {
    const names = ifFlagNames(i);
    const num = names.reduce((a, n) => a + IFF[n], 0);
    const lines = [i.name + ': flags=' + num + '<' + names.join(',') + '>  mtu ' + (i.mtu || 1500)];
    if (i.ip) {
      const c = U.parseCidr(i.ip + '/' + i.bits);
      lines.push('        inet ' + i.ip + '  netmask ' + U.maskFromBits(i.bits) + (i.kind !== 'loopback' && i.bits < 31 ? '  broadcast ' + U.intToIp(c.broadcast) : ''));
    }
    if (i.kind === 'loopback') lines.push('        inet6 ::1  prefixlen 128  scopeid 0x10<host>');
    else if (isUp(i)) lines.push('        inet6 ' + linkLocal6(i.mac).slice(0, -3) + '  prefixlen 64  scopeid 0x20<link>');
    lines.push(i.kind === 'loopback' ? '        loop  txqueuelen 1000  (Local Loopback)' : '        ether ' + i.mac + '  txqueuelen 1000  (Ethernet)');
    const s = nlStats(m, i);
    lines.push('        RX packets ' + s.rxp + '  bytes ' + humanBytes(s.rx), '        RX errors 0  dropped 0  overruns 0  frame 0',
      '        TX packets ' + s.txp + '  bytes ' + humanBytes(s.tx), '        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0', '');
    return lines.join('\n');
  }
  /** Netmask argument as a prefix length, or null. */
  function maskBits(mask) {
    if (!U.isIPv4(mask)) return null;
    const n = U.ipToInt(mask); let bits = 0;
    while (bits < 32 && (n & (0x80000000 >>> bits))) bits++;
    return U.maskFromBits(bits) === mask ? bits : null;
  }
  const classfulBits = (ip) => { const a = +ip.split('.')[0]; return a < 128 ? 8 : a < 192 ? 16 : 24; };

  function ifconfigSet(ctx, i, args) {
    const m = ctx.machine; let ip = null; let bits = null;
    const deny = (what) => { ctx.eprintln(what + ': Operation not permitted'); return 255; };
    for (let n = 0; n < args.length; n++) {
      const a = args[n];
      if (a === 'up' || a === 'down' || a === '-promisc' || a === 'promisc') {
        if (!ctx.isRoot) return deny('SIOCSIFFLAGS');
        if (a === 'up') setLinkState(m, i, true); else if (a === 'down') setLinkState(m, i, false); else i.promisc = a === 'promisc';
      } else if (a === 'netmask') {
        bits = maskBits(args[++n]);
        if (bits == null) { ctx.eprintln('ifconfig: bad netmask'); return 255; }
      } else if (a === 'mtu') {
        if (!ctx.isRoot) return deny('SIOCSIFMTU');
        i.mtu = parseInt(args[++n], 10) || i.mtu;
      } else if (a === 'hw') {
        const mac = args[n + 2]; n += 2;
        if (!ctx.isRoot) return deny('SIOCSIFHWADDR');
        if (!MAC_RE.test(mac || '')) { ctx.eprintln('ifconfig: bad hardware address'); return 255; }
        i.mac = mac.toLowerCase();
      } else if (['broadcast', 'pointopoint', 'dstaddr', 'txqueuelen', 'metric'].includes(a)) n++;
      else if (a === 'add' || a === 'del') n++;
      else if (U.isIPv4(a.split('/')[0])) { ip = a; } else { ctx.eprintln('ifconfig: `--help\' gives usage information.'); return 255; }
    }
    if (ip) {
      if (!ctx.isRoot) return deny('SIOCSIFADDR');
      const [addr, len] = ip.split('/');
      const b = len != null ? parseInt(len, 10) : bits != null ? bits : classfulBits(addr);
      const old = addrList(i)[0];
      setAddrList(i, [{ ip: addr, bits: b }].concat((i.secondary || []).slice()));
      if (old) m.routes.splice(0, m.routes.length, ...m.routes.filter((r) => !(r.proto === 'kernel' && r.dev === i.name)));
      if (isUp(i)) m.routes.push(connectedRoute(i, { ip: addr, bits: b }));
      pruneRoutes(m); sortRoutes(m);
    } else if (bits != null) {
      if (!ctx.isRoot) return deny('SIOCSIFNETMASK');
      const old = addrList(i)[0];
      if (old) { setAddrList(i, [{ ip: old.ip, bits }].concat(i.secondary || [])); m.routes.splice(0, m.routes.length, ...m.routes.filter((r) => !(r.proto === 'kernel' && r.dev === i.name))); if (isUp(i)) m.routes.push(connectedRoute(i, { ip: old.ip, bits })); pruneRoutes(m); sortRoutes(m); }
    }
    return 0;
  }

  async function ifconfigRun(ctx) {
    const m = ctx.machine;
    const args = ctx.args.slice();
    const flags = { a: false, s: false, v: false };
    while (args.length && /^-[asv]+$/.test(args[0])) for (const ch of args.shift().slice(1)) flags[ch] = true;
    if (args[0] === '--version' || args[0] === '-V') { ctx.println(NET_TOOLS_VERSION); return 0; }
    if (args[0] === '--help' || args[0] === '-h') { ctx.err(NET_TOOLS_USAGE_IF); return 0; }
    if (args[0] && args[0][0] === '-' && !/^-(promisc)$/.test(args[0])) { ctx.eprintln('ifconfig: option `' + args[0] + "' not recognised."); ctx.eprintln("ifconfig: `--help' gives usage information."); return 1; }
    const name = args[0] && !['up', 'down'].includes(args[0]) ? args.shift() : null;
    if (name == null) {
      const list = netToolsOrder(m).filter((i) => flags.a || isUp(i));
      if (flags.s) ctx.println([IFACE_STATS_HEAD].concat(list.map((i) => ifaceStatsRow(m, i))).join('\n'));
      else if (list.length) ctx.println(list.map((i) => ifconfigBlock(m, i)).join('\n'));
      return 0;
    }
    const i = ifaceByName(m, name.replace(/:\d+$/, ''));
    if (!i) { ctx.eprintln(name + ': error fetching interface information: Device not found'); return 1; }
    if (args.length) return ifconfigSet(ctx, i, args);
    ctx.println(flags.s ? [IFACE_STATS_HEAD, ifaceStatsRow(m, i)].join('\n') : ifconfigBlock(m, i));
    return 0;
  }
  K.cmd.register({
    name: 'ifconfig', path: '/usr/sbin/ifconfig', pkg: 'net-tools', section: 8, only: 'kali',
    summary: 'configure a network interface',
    synopsis: 'ifconfig [-v] [-a] [-s] [interface]\n       ifconfig [-v] interface [aftype] options | address ...',
    man: 'DESCRIPTION\n       Ifconfig is used to configure the kernel-resident network interfaces. It is used at boot time to set up interfaces as necessary. After that, it is usually only needed when debugging or when system tuning is needed.\n\n       If no arguments are given, ifconfig displays the status of the currently active interfaces. If a single interface argument is given, it displays the status of the given interface only; if a single -a argument is given, it displays the status of all interfaces, even those that are down.\n\nOPTIONS\n       -a     display all interfaces which are currently available, even if down\n       -s     display a short list (like netstat -i)\n       up     This flag causes the interface to be activated. It is implicitly specified if an address is assigned to the interface.\n       down   This flag causes the driver for this interface to be shut down.\n       netmask addr\n              Set the IP network mask for this interface.\n       mtu N  Set the Maximum Transfer Unit of an interface.\n       [-]promisc\n              Enable or disable the promiscuous mode of the interface.\n       hw class address\n              Set the hardware address of this interface.\n\n       Changing an interface needs root.\n\nEXAMPLES\n       ifconfig eth0\n              Show only eth0.\n       sudo ifconfig eth0 down\n              Shut the interface down.',
    run: ifconfigRun,
    complete: (info) => (info.index === 1 || info.index === 2 ? ifaceNames(K.kali || info.ctx.machine).concat(info.index === 1 ? ['-a', '-s'] : ['up', 'down', 'netmask', 'mtu', 'promisc']) : ['up', 'down', 'netmask', 'mtu', 'promisc']),
  });

  /* ------------------------------------------------------------------ route */
  const ROUTE_USAGE = 'Usage: route [-nNvee] [-FC] [<AF>]           List kernel routing tables\n       route [-v] [-FC] {add|del|flush} ...  Modify routing table for AF.\n\n       route {-h|--help} [<AF>]              Detailed usage syntax for specified AF.\n       route {-V|--version}                  Display version/author and exit.\n\n        -v, --verbose            be verbose\n        -n, --numeric            don\'t resolve names\n        -e, --extend             display other/more information\n        -F, --fib                display Forwarding Information Base (default)\n        -C, --cache              display routing cache instead of FIB\n\n  <AF>=Use -4, -6, \'-A <af>\' or \'--<af>\'; default: inet\n  List of possible address families (which support routing):\n    inet (DARPA Internet) inet6 (IPv6) ax25 (AMPR AX.25) \n    netrom (AMPR NET/ROM) ipx (Novell IPX) ddp (Appletalk DDP) \n    x25 (CCITT X.25) \n';
  const ROUTE_ERR = { perm: 'Operation not permitted', nodev: 'No such device', badgw: 'Network is unreachable', exists: 'File exists', nosuch: 'No such process' };

  function routeTable(ctx, numeric) {
    const lines = ['Kernel IP routing table', 'Destination     Gateway         Genmask         Flags Metric Ref    Use Iface'];
    for (const r of netstatRoutes(ctx, numeric)) lines.push(pad(r.dst, 15) + ' ' + pad(r.via, 15) + ' ' + pad(r.mask, 15) + ' ' + pad(r.flags, 5) + ' ' + pad(String(r.metric), 6) + ' ' + pad('0', 6) + ' ' + padL(0, 3) + ' ' + r.dev);
    return lines.join('\n');
  }
  /** Parse net-tools "add|del [-net|-host] TARGET [netmask M] [gw G] [metric N] [dev D]". */
  function routeFromArgs(ctx, args) {
    const r = {}; let target = null; let mask = null; let host = false;
    for (let n = 0; n < args.length; n++) {
      const a = args[n];
      if (a === '-net') continue;
      if (a === '-host') host = true;
      else if (a === 'netmask') mask = args[++n];
      else if (a === 'gw') r.via = args[++n];
      else if (a === 'metric') r.metric = parseInt(args[++n], 10) || 0;
      else if (a === 'dev') r.dev = args[++n];
      else if (a === 'mss' || a === 'window' || a === 'irtt') n++;
      else if (a === 'default') target = 'default';
      else if (target == null) target = a;
      else { ctx.eprintln(ROUTE_USAGE); return null; }
    }
    if (target == null) { ctx.err(ROUTE_USAGE); return null; }
    if (target === 'default' || target === '0.0.0.0' && (mask === '0.0.0.0' || mask == null) && !host) r.dst = 'default';
    else {
      const [addr, len] = target.split('/');
      if (!U.isIPv4(addr)) { ctx.eprintln(target + ': Unknown host'); return null; }
      const bits = host ? 32 : len != null ? parseInt(len, 10) : mask != null ? maskBits(mask) : 32;
      if (bits == null) { ctx.eprintln('route: bogus netmask ' + mask); return null; }
      const c = U.parseCidr(addr + '/' + bits);
      if (((c.ip & c.mask) >>> 0) !== c.ip) { ctx.eprintln('route: netmask ' + U.maskFromBits(bits) + " doesn't match route address"); return null; }
      r.dst = addr + '/' + bits;
    }
    if (r.via && !U.isIPv4(r.via)) { ctx.eprintln(r.via + ': Unknown host'); return null; }
    if (r.dev && !ifaceByName(ctx.machine, r.dev)) { ctx.eprintln('SIOCADDRT: No such device'); return null; }
    return r;
  }
  async function routeRun(ctx) {
    const args = ctx.args.slice(); let numeric = false;
    while (args.length && /^-[nNveFC]+$/.test(args[0])) { if (args.shift().includes('n')) numeric = true; }
    if (args[0] === '-V' || args[0] === '--version') { ctx.println(NET_TOOLS_VERSION); return 0; }
    if (args[0] === '-h' || args[0] === '--help') { ctx.out(ROUTE_USAGE); return 0; }
    if (args[0] && args[0][0] === '-' && !['-net', '-host'].includes(args[0])) { ctx.eprintln("route: invalid option -- '" + args[0].replace(/^-+/, '')[0] + "'"); ctx.err(ROUTE_USAGE); return 1; }
    if (!args.length) { ctx.println(routeTable(ctx, numeric)); return 0; }
    const cmd = args.shift();
    if (cmd !== 'add' && cmd !== 'del' && cmd !== 'delete') { ctx.eprintln('route: ' + (cmd === 'flush' ? 'flush: not supported' : "unknown command '" + cmd + "'")); return 1; }
    const r = routeFromArgs(ctx, args);
    if (!r) return 1;
    const err = applyRoute(ctx, cmd === 'add' ? 'add' : 'delete', r);
    if (!err) return 0;
    ctx.eprintln((cmd === 'add' ? 'SIOCADDRT: ' : 'SIOCDELRT: ') + ROUTE_ERR[err]);
    return 7;
  }
  K.cmd.register({
    name: 'route', path: '/usr/sbin/route', pkg: 'net-tools', section: 8, only: 'kali',
    summary: 'show / manipulate the IP routing table',
    synopsis: 'route [-CFvnee]\n       route [-v] [-A family] add [-net|-host] target [netmask Nm] [gw Gw] [metric N] [dev If]\n       route [-v] [-A family] del [-net|-host] target [gw Gw] [netmask Nm] [metric N] [dev If]',
    man: 'DESCRIPTION\n       Route manipulates the kernel\'s IP routing tables. Its primary use is to set up static routes to specific hosts or networks via an interface after it has been configured with the ifconfig program.\n\n       When the add or del options are used, route modifies the routing tables. Without these options, route displays the current contents of the routing tables. Changing the table needs root.\n\nOPTIONS\n       -n     show numerical addresses instead of trying to determine symbolic host names.\n       -net   the target is a network.\n       -host  the target is a host.\n       netmask NM\n              when adding a network route, the netmask to be used.\n       gw GW  route packets via a gateway.\n       metric M\n              set the metric field in the routing table.\n       dev If force the route to be associated with the specified device.\n\nEXAMPLES\n       route -n\n              Show the routing table without name lookups.\n       sudo route add -net 172.30.0.0 netmask 255.255.0.0 gw 10.10.10.1\n              Reach another network through the lab gateway.\n       sudo route del default\n              Remove the default route.',
    run: routeRun,
  });

  /* -------------------------------------------------------------------- arp */
  const ARP_USAGE = 'Usage:\n  arp [-vn]  [<HW>] [-i <if>] [-a] [<hostname>]             <-Display ARP cache\n  arp [-v]          [-i <if>] -d  <host> [pub]               <-Delete ARP entry\n  arp [-vnD] [<HW>] [-i <if>] -f  [<filename>]            <-Add entry from file\n  arp [-v]   [<HW>] [-i <if>] -s  <host> <hwaddr> [temp]            <-Add entry\n  arp [-v]   [<HW>] [-i <if>] -Ds <host> <if> [netmask <nm>] pub          <-\'\'-\n\n        -a                       display (all) hosts in alternative (BSD) style\n        -e                       display (all) hosts in default (Linux) style\n        -s, --set                set a new ARP entry\n        -d, --delete             delete a specified entry\n        -v, --verbose            be verbose\n        -n, --numeric            don\'t resolve names\n        -i, --device             specify network interface (e.g. eth0)\n        -D, --use-device         read <hwaddr> from given device\n        -A, -p, --protocol       specify protocol family\n        -f, --file               read new entries from file or from /etc/ethers\n\n  <HW>=Use \'-H <hw>\' to specify hardware address type. Default: ether\n  List of possible hardware types (which support ARP):\n    ash (Ash) ether (Ethernet) ax25 (AMPR AX.25) \n    netrom (AMPR NET/ROM) rose (AMPR ROSE) arcnet (ARCnet) \n    dlci (Frame Relay DLCI) fddi (Fiber Distributed Data Interface) hippi (HIPPI) \n    irda (IrLAP) x25 (generic X.25) eui64 (Generic EUI-64) \n';
  async function arpRun(ctx) {
    const g = K.getopt(ctx.args, { short: 'vneaDsdfi:H:A:p:hV', long: ['verbose', 'numeric', 'set', 'delete', 'file', 'device=', 'use-device', 'protocol=', 'help', 'version', 'all', 'display'], alias: { verbose: 'v', numeric: 'n', set: 's', delete: 'd', file: 'f', device: 'i', help: 'h', version: 'V' } });
    if (g.err) { ctx.eprintln('arp: ' + g.err); ctx.err(ARP_USAGE); return 1; }
    const o = g.opts; const m = ctx.machine;
    if (o.V) { ctx.println(NET_TOOLS_VERSION); return 0; }
    if (o.h) { ctx.err(ARP_USAGE); return 0; }
    m.arp = m.arp || new Map();
    if (o.i && !ifaceByName(m, o.i)) { ctx.eprintln('arp: in_arp: device \'' + o.i + "' not found"); return 1; }
    if (o.d || o.s) {
      const ip = g.rest[0];
      if (!ip) { ctx.eprintln('arp: need host name'); return 1; }
      const dest = lookup(ctx, ip);
      if (dest.err) { ctx.eprintln('arp: ' + ip + ': Unknown host'); return 1; }
      if (!ctx.isRoot) { ctx.eprintln(o.d ? 'SIOCDARP(dontpub): Operation not permitted' : 'SIOCSARP: Operation not permitted'); return 255; }
      if (o.d) { if (!m.arp.delete(dest.ip)) { ctx.eprintln('No ARP entry for ' + ip); return 255; } return 0; }
      const mac = g.rest[1];
      if (!mac) { ctx.eprintln('arp: need hardware address'); return 1; }
      if (!MAC_RE.test(mac)) { ctx.eprintln('arp: invalid hardware address'); return 1; }
      const rt = routeLookup(m, dest.ip);
      m.arp.set(dest.ip, { ip: dest.ip, mac: mac.toLowerCase(), dev: o.i || (rt && rt.dev) || (m.primaryIface() || {}).name, ts: K.clock.now(), state: 'REACHABLE', permanent: true });
      return 0;
    }
    let entries = Array.from(m.arp.values()).filter((e) => !o.i || e.dev === o.i);
    if (g.rest.length) {
      const dest = lookup(ctx, g.rest[0]);
      entries = dest.err ? [] : entries.filter((e) => e.ip === dest.ip);
      if (!entries.length) { ctx.println((dest.err ? g.rest[0] : g.rest[0]) + ' (' + (dest.ip || g.rest[0]) + ') -- no entry'); return o.a ? 0 : 1; }
    }
    if (!entries.length) return 0;
    if (o.a) {
      ctx.println(entries.map((e) => {
        const name = o.n ? null : rdns(ctx, e.ip);
        const incomplete = e.state === 'FAILED';
        return (name || '?') + ' (' + e.ip + ') at ' + (incomplete ? '<incomplete>' : e.mac + ' [ether]' + (e.permanent ? ' PERM' : '')) + ' on ' + e.dev;
      }).join('\n'));
      return 0;
    }
    ctx.println(['Address                  HWtype  HWaddress           Flags Mask            Iface'].concat(entries.map((e) => {
      const incomplete = e.state === 'FAILED';
      const name = o.n ? e.ip : rdns(ctx, e.ip) || e.ip;
      return pad(name, 24) + ' ' + pad(incomplete ? '' : 'ether', 7) + ' ' + pad(incomplete ? '(incomplete)' : e.mac, 19) + ' ' + pad(incomplete ? '' : e.permanent ? 'CM' : 'C', 5) + ' ' + pad('', 15) + ' ' + e.dev;
    })).join('\n'));
    return 0;
  }
  K.cmd.register({
    name: 'arp', path: '/usr/sbin/arp', pkg: 'net-tools', section: 8, only: 'kali',
    summary: 'manipulate the system ARP cache',
    synopsis: 'arp [-vn] [-H type] [-i if] [-a] [hostname]\n       arp [-v] [-i if] -d hostname [pub]\n       arp [-v] [-H type] [-i if] -s hostname hw_addr [temp]',
    man: 'DESCRIPTION\n       Arp manipulates or displays the kernel\'s IPv4 network neighbour cache. It can add entries to the table, delete one or display the current content.\n\nOPTIONS\n       -a [hostname]\n              Use alternate BSD style output format (with no fixed columns).\n       -e     Use default Linux style output format (with fixed columns).\n       -n     Show numerical addresses instead of trying to determine symbolic host, port or user names.\n       -i If  Select an interface.\n       -d hostname\n              Remove any entry for the specified host (root).\n       -s hostname hw_addr\n              Manually create an ARP address mapping entry for host hostname with hardware address set to hw_addr (root).\n\nEXAMPLES\n       arp -a\n              BSD style listing of all neighbours.\n       arp -n\n              Numeric table of the cache.',
    run: arpRun,
  });


/*@@END@@*/
})(typeof globalThis !== 'undefined' ? globalThis : this);
