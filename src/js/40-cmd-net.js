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
  function ipRouteChange(ctx, cmd, args) {
    const m = ctx.machine;
    const r = parseRoute(ctx, args);
    if (!r) return 1;
    if (r.fatal) return r.fatal;
    if (cmd === 'delete') {
      if (!ctx.isRoot) { ctx.eprintln('RTNETLINK answers: Operation not permitted'); return 2; }
      const i = m.routes.findIndex((x) => x.dst === r.dst && (r.metric == null || (x.metric || 0) === r.metric) && (!r.via || x.via === r.via) && (!r.dev || x.dev === r.dev));
      if (i < 0) { ctx.eprintln('RTNETLINK answers: No such process'); return 2; }
      m.routes.splice(i, 1);
      return 0;
    }
    if (!ctx.isRoot) { ctx.eprintln('RTNETLINK answers: Operation not permitted'); return 2; }
    if (r.via) {
      const dev = m.ifaces.find((i) => i.kind !== 'loopback' && isUp(i) && (!r.dev || i.name === r.dev) && addrList(i).some((a) => U.inCidr(r.via, a.ip + '/' + a.bits)));
      if (!dev) { ctx.eprintln('Error: Nexthop has invalid gateway.'); return 2; }
      r.dev = dev.name;
    } else if (!r.dev && !r.type) { ctx.eprintln('RTNETLINK answers: No such device'); return 2; }
    const existing = m.routes.findIndex((x) => sameRoute(x, r));
    if (cmd === 'add' && existing >= 0) { ctx.eprintln('RTNETLINK answers: File exists'); return 2; }
    if (cmd === 'change' && existing < 0) { ctx.eprintln('RTNETLINK answers: No such file or directory'); return 2; }
    if (existing >= 0) m.routes.splice(existing, 1);
    m.routes.push(r); sortRoutes(m);
    return 0;
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


/*@@END@@*/
})(typeof globalThis !== 'undefined' ? globalThis : this);
