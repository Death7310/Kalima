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

/*@@END@@*/
})(typeof globalThis !== 'undefined' ? globalThis : this);
