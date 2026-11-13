/* Kalima — simulated network engine.
 *
 * Nothing here touches a real network. The engine answers questions such as
 * "what happens if this machine pings that address" from the world model in
 * 31-world.js. All functions are synchronous and return timings in
 * milliseconds; commands decide how long to actually wait (ctx.sleep).
 */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;

  class NetError extends Error {
    constructor(code, detail) { super(NetError.MSG[code] || code); this.name = 'NetError'; this.code = code; this.detail = detail; }
  }
  NetError.MSG = {
    ECONNREFUSED: 'Connection refused', ETIMEDOUT: 'Connection timed out', EHOSTUNREACH: 'No route to host',
    ENETUNREACH: 'Network is unreachable', ENOTFOUND: 'Name or service not known', ECONNRESET: 'Connection reset by peer',
  };
  K.NetError = NetError;

  const CITIES = ['fra', 'ams', 'lon', 'par', 'nyc', 'chi', 'dal', 'sjc', 'sea', 'sin', 'tyo', 'syd'];
  const PUBLIC_TLDS = ['com', 'org', 'net', 'io', 'edu', 'gov', 'co', 'dev', 'app', 'info', 'uk', 'de', 'fr', 'nl', 'ca', 'au', 'jp', 'us', 'me', 'ai', 'example'];

  const net = (K.net = {
    NetError,
    world: null,
    hosts: [],
    machines: Object.create(null), // hostId -> K.Machine (lazily created for hosts you can log in to)
    bus: new K.Emitter(),          // 'packet' and 'conn' events
    state: { wan: true },          // toggles for troubleshooting scenarios
    _rand: U.prng('kalima'),
    _byIp: new Map(),

    /** Seed the jitter generator (tests use a fixed seed; the app seeds from the clock). */
    seed(s) { this._rand = U.prng(s); },
    rand() { return this._rand(); },
    jitter(base, spread) { return Math.max(0.01, base + (this.rand() - 0.35) * spread); },

    /* ------------------------------------------------------------ world */
    load(world) {
      this.world = world;
      this.hosts = world.hosts;
      this._byIp = new Map();
      for (const h of world.hosts) {
        h.up = h.up !== false;
        h.services = h.services || [];
        h.latency = h.latency || { base: 0.45, jitter: 0.3 };
        h.os = h.os || { family: 'Linux', ttl: 64 };
        if (!h.mac) h.mac = U.mac(h.id, h.oui);
        this._byIp.set(h.ip, h);
        for (const ip of h.ips || []) this._byIp.set(ip, h);
      }
      for (const s of world.internet.sites) {
        s.inet = true; s.up = s.up !== false; s.id = s.id || s.name;
        s.hostname = s.name; s.fqdn = s.name;
        s.os = s.os || { family: 'Linux', ttl: 64 };
        s.services = s.services || [
          { port: 80, proto: 'tcp', name: 'http', product: 'nginx', handler: 'http' },
          { port: 443, proto: 'tcp', name: 'https', product: 'nginx', handler: 'http', tls: true },
        ];
        this._byIp.set(s.ip, s);
        for (const ip of s.ips || []) this._byIp.set(ip, s);
      }
      this.machines = Object.create(null);
    },

    hostById(id) { return this.hosts.find((h) => h.id === id) || null; },
    /** Lab host or curated internet site at this IP (not synthesized ones). */
    knownHost(ip) { return this._byIp.get(ip) || null; },
    hostByName(name) {
      name = String(name).toLowerCase().replace(/\.$/, '');
      return this.hosts.find((h) => h.hostname === name || h.fqdn === name || (h.aliases || []).indexOf(name) >= 0) ||
        this.world.internet.sites.find((s) => s.name === name || (s.aliases || []).indexOf(name) >= 0) || null;
    },

    /** Any host at this IP: lab host, curated site, or a deterministic synthesized internet host. */
    hostAt(ip) {
      const k = this._byIp.get(ip);
      if (k) return k;
      if (!U.isIPv4(ip) || this.isReserved(ip)) return null;
      const h = U.hash32('inet:' + ip);
      return {
        id: 'inet-' + ip, ip, inet: true, synthetic: true,
        hostname: null, fqdn: null,
        up: h % 100 < 58,
        os: { family: 'Linux', ttl: (h >>> 7) % 5 === 0 ? 128 : 64 },
        latency: { base: 14 + ((h >>> 8) % 170), jitter: 6 },
        services: (h >>> 3) % 3 === 0 ? [] : [
          { port: 80, proto: 'tcp', name: 'http', product: 'nginx', handler: 'http' },
          { port: 443, proto: 'tcp', name: 'https', product: 'nginx', handler: 'http', tls: true },
        ],
        firewall: { default: 'filtered' },
      };
    },

    isReserved(ip) {
      return U.isPrivateIp(ip) || U.inCidr(ip, '0.0.0.0/8') || U.inCidr(ip, '100.64.0.0/10') || U.inCidr(ip, '224.0.0.0/3') ||
        U.inCidr(ip, '198.18.0.0/15');
    },

    /** The world host record that corresponds to a Machine. */
    hostOf(machine) { return this.hostById(machine.hostId); },

    /** Build (once) the Machine for a lab host that allows logins. Returns null if the host has no shell. */
    machineFor(hostId) {
      if (this.machines[hostId]) return this.machines[hostId];
      const h = this.hostById(hostId);
      if (!h || !h.shell) return null;
      const netw = this.world.nets.find((n) => U.inCidr(h.ip, n.cidr)) || this.world.nets[0];
      const bits = U.parseCidr(netw.cidr).bits;
      const m = new K.Machine({
        hostname: h.hostname, domain: h.fqdn && h.fqdn.indexOf('.') > 0 ? h.fqdn.slice(h.fqdn.indexOf('.') + 1) : '',
        profile: h.profile || 'server', hostId: h.id, users: h.shell.users || [], rootPassword: h.shell.rootPassword,
        os: h.shell.os || {},
        ifaces: [{ name: h.shell.iface || 'ens33', ip: h.ip, bits, mac: h.mac, kind: 'ether', state: 'UP', mtu: 1500 }],
        routes: [{ dst: 'default', via: netw.gateway, dev: h.shell.iface || 'ens33' }, { dst: netw.cidr, dev: h.shell.iface || 'ens33', src: h.ip }],
        dns: this.world.dns.lab ? [this.world.dns.lab] : [],
      });
      this.machines[hostId] = m;
      K.events.emit('machine-created', m);
      return m;
    },
    registerMachine(m) { this.machines[m.hostId] = m; },

    /* ---------------------------------------------------------- routing */
    /**
     * How does `machine` reach `dstIp`?
     * Returns { ok, err, self, direct, inet, blackhole, src, dev, gateway, host, hops:[{ip,name,rtt,silent}], rtt }
     *   ok=false with err 'ENETUNREACH' (no route) or 'EHOSTUNREACH' (ARP failure on the local segment).
     *   blackhole=true: packets leave but nothing ever answers (timeouts).
     */
    route(machine, dstIp) {
      if (!U.isIPv4(dstIp)) return { ok: false, err: 'ENETUNREACH', hops: [] };
      if (U.inCidr(dstIp, '127.0.0.0/8') || machine.ifaces.some((i) => i.ip === dstIp)) {
        return { ok: true, self: true, dev: 'lo', src: U.inCidr(dstIp, '127.0.0.0/8') ? '127.0.0.1' : dstIp, hops: [], rtt: 0.035, host: this.hostOf(machine) };
      }
      for (const i of machine.ifaces) {
        if (i.kind === 'loopback' || !i.ip || i.state === 'DOWN') continue;
        if (U.inCidr(dstIp, i.ip + '/' + i.bits)) {
          const host = this._byIp.get(dstIp);
          if (!host || !host.up) { this._arp(machine, dstIp, null, i.name); return { ok: false, err: 'EHOSTUNREACH', direct: true, src: i.ip, dev: i.name, hops: [] }; }
          this._arp(machine, dstIp, host.mac, i.name);
          return { ok: true, direct: true, src: i.ip, dev: i.name, host, hops: [], rtt: host.latency.base };
        }
      }
      let best = null;
      for (const r of machine.routes) {
        if (!r.via) continue;
        if (r.dst === 'default') { if (!best) best = r; continue; }
        if (U.inCidr(dstIp, r.dst)) { best = r; break; }
      }
      const dev = best && machine.ifaces.find((i) => i.name === best.dev && i.state !== 'DOWN' && i.ip);
      if (!best || !dev) return { ok: false, err: 'ENETUNREACH', hops: [] };
      const gw = this._byIp.get(best.via);
      if (!gw || !gw.up) { this._arp(machine, best.via, null, dev.name); return { ok: false, err: 'EHOSTUNREACH', src: dev.ip, dev: dev.name, hops: [], viaGateway: true }; }
      this._arp(machine, best.via, gw.mac, dev.name);
      const gwHop = { ip: gw.ip, name: gw.fqdn || gw.hostname, rtt: gw.latency.base };
      const base = { ok: true, src: dev.ip, dev: dev.name, gateway: gw.ip };
      if (this.isReserved(dstIp) || !this.state.wan) return Object.assign(base, { blackhole: true, hops: [gwHop], host: null, rtt: 0 });
      const host = this.hostAt(dstIp);
      const hops = [gwHop].concat(this._inetHops(dstIp, host));
      return Object.assign(base, { inet: true, host, hops, rtt: host.latency.base, blackhole: !host.up });
    },

    _arp(machine, ip, mac, dev) {
      machine.arp = machine.arp || new Map();
      machine.arp.set(ip, { ip, mac, dev, ts: K.clock.now(), state: mac ? 'REACHABLE' : 'FAILED' });
    },

    _inetHops(ip, host) {
      const h = U.hash32('path:' + ip);
      const total = host.hops || 6 + (h % 8);
      const rtt = host.latency.base;
      const hops = [];
      const cityA = CITIES[h % CITIES.length]; const cityB = CITIES[(h >>> 5) % CITIES.length];
      for (let i = 1; i <= total; i++) {
        const hh = U.hash32('hop:' + ip + ':' + i);
        const frac = Math.pow(i / (total + 1), 1.4);
        const r = Math.max(1.2 + i * 0.6, rtt * frac);
        let hopIp; let name;
        if (i === 1) { hopIp = '100.64.0.1'; name = null; }
        else if (i <= 3) { hopIp = '198.51.100.' + (1 + (hh % 250)); name = 'ae-' + (hh % 9) + '.cr' + (1 + (hh >>> 4) % 4) + '.' + cityA + '.simnet-isp.example'; }
        else if (i < total) { hopIp = '192.0.2.' + (1 + (hh % 250)); name = 'xe-' + (hh % 4) + '-' + ((hh >>> 3) % 3) + '-' + ((hh >>> 6) % 8) + '.bb' + (1 + (hh >>> 9) % 6) + '.' + (i < total / 2 + 2 ? cityA : cityB) + '.backbone.example'; }
        else { hopIp = ip.replace(/\.\d+$/, '.' + (1 + (hh % 3))); name = null; if (hopIp === ip) hopIp = ip.replace(/\.\d+$/, '.254'); }
        hops.push({ ip: hopIp, name, rtt: r, silent: i > 1 && hh % 6 === 0 });
      }
      return hops;
    },

    /* ----------------------------------------------------------- probes */
    packet(p) { p.ts = p.ts == null ? K.clock.now() : p.ts; this.bus.emit('packet', p); },

    /**
     * One ICMP echo. Returns { status, rtt, ttl, from, route }
     *   status: 'reply' | 'timeout' | 'unreachable' (from = address reporting it) | 'noroute'
     */
    ping(machine, dstIp, seq, o) {
      o = o || {};
      const rt = this.route(machine, dstIp);
      if (!rt.ok) {
        if (rt.err === 'ENETUNREACH') return { status: 'noroute', route: rt };
        return { status: 'unreachable', from: rt.src, route: rt, rtt: 3000 };
      }
      const size = o.size == null ? 56 : o.size;
      this.packet({ src: rt.src, dst: dstIp, proto: 'ICMP', info: 'echo request, id ' + (o.id || 1) + ', seq ' + seq + ', length ' + (size + 8), len: size + 28, dev: rt.dev });
      if (rt.self) return { status: 'reply', rtt: this.jitter(0.03, 0.03), ttl: 64, from: dstIp, route: rt };
      const host = rt.host;
      if (rt.blackhole || !host || !host.up) return { status: 'timeout', route: rt };
      if (host.firewall && host.firewall.icmp === false) return { status: 'timeout', route: rt };
      if (host.loss && this.rand() < host.loss) return { status: 'timeout', route: rt };
      const ttl0 = host.os.ttl || 64;
      const hopCount = rt.hops.length;
      if (o.ttl != null && o.ttl <= hopCount) {
        const hop = rt.hops[o.ttl - 1];
        if (hop.silent) return { status: 'timeout', route: rt };
        return { status: 'ttl-exceeded', from: hop.ip, fromName: hop.name, rtt: this.jitter(hop.rtt, hop.rtt * 0.12 + 0.2), route: rt };
      }
      const rtt = this.jitter(rt.rtt, host.latency.jitter == null ? 0.3 : host.latency.jitter);
      this.packet({ src: dstIp, dst: rt.src, proto: 'ICMP', info: 'echo reply, id ' + (o.id || 1) + ', seq ' + seq + ', length ' + (size + 8), len: size + 28, dev: rt.dev, ts: K.clock.now() + rtt });
      return { status: 'reply', rtt, ttl: ttl0 - hopCount, from: dstIp, route: rt };
    },

    /** Local listening sockets of a machine: active units plus ad-hoc listeners. */
    listening(machine) {
      const out = [];
      for (const u of machine.units || []) if (u.active === 'active') for (const p of u.ports || []) out.push(Object.assign({ unit: u.name, pid: u.pid, prog: u.prog || u.name.replace(/\.service$/, '') }, p));
      for (const l of machine.listeners || []) out.push(l);
      return out;
    },
    listen(machine, l) { machine.listeners.push(l); return () => { const i = machine.listeners.indexOf(l); if (i >= 0) machine.listeners.splice(i, 1); }; },

    /** Services a host exposes right now (static world data, or live data when it is a running Machine). */
    servicesOf(host) {
      if (!host) return [];
      const m = this.machines[host.id];
      if (m && host.dynamic) {
        return this.listening(m).map((l) => ({ port: l.port, proto: l.proto || 'tcp', name: l.name || l.prog, product: l.product, version: l.version, banner: l.banner, handler: l.handler, listener: l, bind: l.addr }));
      }
      return host.services;
    },

    /**
     * TCP port state as a scanner would see it.
     * Returns { state: 'open'|'closed'|'filtered', reason, rtt, service, host, route }
     */
    tcp(machine, dstIp, port, o) {
      o = o || {};
      const rt = this.route(machine, dstIp);
      if (!rt.ok) return { state: 'filtered', reason: rt.err === 'ENETUNREACH' ? 'net-unreach' : 'host-unreach', route: rt, hostDown: true, rtt: 0 };
      this.packet({ src: rt.src, dst: dstIp, proto: 'TCP', sport: o.sport || 40000 + Math.floor(this.rand() * 20000), dport: port, flags: 'S', info: 'Flags [S]', len: 60, dev: rt.dev });
      const host = rt.host;
      if (rt.blackhole || !host || !host.up) return { state: 'filtered', reason: 'no-response', route: rt, hostDown: true, rtt: 0 };
      const rtt = this.jitter(rt.rtt, host.latency.jitter == null ? 0.3 : host.latency.jitter);
      const svc = this.servicesOf(host).find((s) => s.port === port && (s.proto || 'tcp') === 'tcp' && !(s.bind === '127.0.0.1' && !rt.self));
      const fw = host.firewall || {};
      if (svc && svc.state !== 'filtered' && !(fw.filtered || []).includes(port)) {
        this.packet({ src: dstIp, dst: rt.src, proto: 'TCP', sport: port, dport: 0, flags: 'S.', info: 'Flags [S.]', len: 60, dev: rt.dev, ts: K.clock.now() + rtt });
        this.bus.emit('conn', { host, port, proto: 'tcp', src: rt.src, kind: o.kind || 'probe', ts: K.clock.now() });
        return { state: 'open', reason: 'syn-ack', rtt, service: svc, host, route: rt };
      }
      if ((svc && svc.state === 'filtered') || (fw.filtered || []).includes(port) || fw.default === 'filtered') {
        return { state: 'filtered', reason: 'no-response', rtt, host, route: rt, service: svc || null };
      }
      this.packet({ src: dstIp, dst: rt.src, proto: 'TCP', sport: port, dport: 0, flags: 'R.', info: 'Flags [R.]', len: 40, dev: rt.dev, ts: K.clock.now() + rtt });
      return { state: 'closed', reason: 'reset', rtt, host, route: rt };
    },

    /** UDP port state: 'open' | 'open|filtered' | 'closed' | 'filtered' */
    udp(machine, dstIp, port) {
      const rt = this.route(machine, dstIp);
      if (!rt.ok) return { state: 'filtered', reason: 'host-unreach', route: rt, hostDown: true, rtt: 0 };
      this.packet({ src: rt.src, dst: dstIp, proto: 'UDP', sport: 40000 + Math.floor(this.rand() * 20000), dport: port, info: 'UDP, length 0', len: 28, dev: rt.dev });
      const host = rt.host;
      if (rt.blackhole || !host || !host.up) return { state: 'open|filtered', reason: 'no-response', route: rt, hostDown: true, rtt: 0 };
      const rtt = this.jitter(rt.rtt, 0.3);
      const svc = this.servicesOf(host).find((s) => s.port === port && s.proto === 'udp');
      if (svc) return { state: svc.silent ? 'open|filtered' : 'open', reason: svc.silent ? 'no-response' : 'udp-response', rtt, service: svc, host, route: rt };
      if ((host.firewall || {}).default === 'filtered') return { state: 'open|filtered', reason: 'no-response', rtt, host, route: rt };
      return { state: 'closed', reason: 'port-unreach', rtt, host, route: rt };
    },

    /* --------------------------------------------------------- sessions */
    services: {
      _h: Object.create(null),
      /** register('ftp', { greet(session) -> string, data(session, input) -> string }) */
      register(name, handler) { this._h[name] = handler; },
      get(name) { return this._h[name]; },
    },

    /**
     * Open a TCP connection. Throws NetError (ECONNREFUSED, ETIMEDOUT, EHOSTUNREACH, ENETUNREACH).
     * Returns a session: { host, svc, ip, port, rtt, greeting, open, state, send(text) -> responseText, close() }
     */
    connect(machine, dstIp, port, o) {
      o = o || {};
      const t = this.tcp(machine, dstIp, port, { kind: o.kind || 'connect' });
      if (t.route && !t.route.ok) throw new NetError(t.route.err);
      if (t.state === 'closed') throw new NetError('ECONNREFUSED');
      if (t.state !== 'open') throw new NetError('ETIMEDOUT');
      const svc = t.service;
      const handler = (svc.listener && svc.listener.handlerObj) || this.services.get(svc.handler || svc.name) || this.services.get('generic');
      const session = {
        host: t.host, svc, ip: dstIp, port, rtt: t.rtt, open: true, state: {}, machine, client: t.route.src,
        send(text) {
          if (!this.open) return '';
          let res = '';
          try { res = handler.data ? handler.data(this, String(text)) : ''; } catch (e) { res = ''; if (K.debug) console.error(e); }
          return res == null ? '' : String(res);
        },
        close() { this.open = false; },
      };
      try { session.greeting = handler.greet ? String(handler.greet(session) || '') : ''; } catch (e) { session.greeting = ''; }
      return session;
    },

    /* -------------------------------------------------------------- DNS */
    /** Is `name` plausibly a public internet name the simulated internet should answer for? */
    _publicName(name) {
      const labels = name.split('.');
      if (labels.length < 2) return false;
      if (!labels.every((l) => /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/.test(l))) return false;
      const tld = labels[labels.length - 1];
      if (PUBLIC_TLDS.indexOf(tld) < 0) return false;
      if (/(^|\.)(nonexistent|does-not-exist|doesnotexist|nxdomain|invalid|notreal|no-such)/.test(name)) return false;
      return true;
    },
    /** Deterministic address for a synthesized public name. */
    _synthIp(name) {
      const base = name.split('.').slice(-2).join('.');
      const h = U.hash32('dns:' + base); const h2 = U.hash32('dns2:' + name);
      const first = [23, 34, 45, 52, 54, 64, 66, 69, 77, 85, 104, 108, 138, 142, 151, 162, 185, 199, 205, 216][h % 20];
      return first + '.' + ((h >>> 8) & 255) + '.' + ((h >>> 16) & 255) + '.' + (1 + (h2 % 253));
    },
    _zoneFor(name, server) {
      const zones = this.world.dns.zones;
      let best = null;
      for (const z of Object.keys(zones)) {
        if (name === z || name.endsWith('.' + z)) {
          const zone = zones[z];
          if (zone.internal && !(server && (server.zones || []).indexOf(z) >= 0)) continue;
          if (!best || z.length > best.length) best = z;
        }
      }
      return best;
    },
    _zoneRecords(zname) {
      const z = this.world.dns.zones[zname];
      const fq = (n) => (n === '@' ? zname : n.endsWith('.') ? n.slice(0, -1) : n + '.' + zname);
      return z.records.map((r) => ({ name: fq(r.name), type: r.type, ttl: r.ttl || z.ttl || 3600, data: r.data, prio: r.prio }));
    },
    _soa(zname) {
      const z = this.world.dns.zones[zname]; const s = z.soa;
      return { name: zname, type: 'SOA', ttl: z.ttl || 3600, data: s.mname + ' ' + s.rname + ' ' + s.serial + ' ' + (s.refresh || 3600) + ' ' + (s.retry || 900) + ' ' + (s.expire || 604800) + ' ' + (s.minimum || 86400) };
    },

    /**
     * DNS query from `machine`.
     *   o.server: resolver IP (default: machine.dns[0]); o.tcp
     * Returns { status: 'NOERROR'|'NXDOMAIN'|'REFUSED'|'SERVFAIL'|'TIMEOUT'|'NOSERVER', answers, authority, additional,
     *           server, ms, flags: {aa, ra, rd}, question: {name, type} }
     * Records: { name, type, ttl, data, prio? } — names and data are absolute without the trailing dot
     * (commands add the dot when printing).
     */
    dns(machine, name, type, o) {
      o = o || {};
      type = String(type || 'A').toUpperCase();
      name = String(name).toLowerCase().replace(/\.$/, '');
      const serverIp = o.server || machine.dns[0];
      const res = { status: 'NOERROR', answers: [], authority: [], additional: [], server: serverIp, ms: 0, flags: { aa: false, ra: true, rd: true }, question: { name, type } };
      if (!serverIp) { res.status = 'NOSERVER'; return res; }
      const probe = this.udp(machine, serverIp, 53);
      const sdef = this.world.dns.servers[serverIp] || null;
      if (probe.state !== 'open') { res.status = 'TIMEOUT'; res.ms = 5000; return res; }
      if (!sdef) { res.status = 'REFUSED'; res.flags.ra = false; res.ms = Math.max(1, Math.round(probe.rtt)); return res; }
      res.ms = Math.max(1, Math.round(probe.rtt + this.rand() * 3 + (sdef && sdef.public ? 8 : 0)));
      this.bus.emit('conn', { host: probe.host, port: 53, proto: 'udp', src: probe.route.src, kind: 'dns', ts: K.clock.now(), detail: type + ' ' + name });

      // reverse lookups
      const rev = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\.in-addr\.arpa$/.exec(name);
      if (rev) {
        const ip = rev[4] + '.' + rev[3] + '.' + rev[2] + '.' + rev[1];
        const ptr = this._ptr(ip, sdef);
        if (type === 'PTR' || type === 'ANY') {
          if (ptr) { res.answers.push({ name, type: 'PTR', ttl: 3600, data: ptr }); res.flags.aa = !!(sdef && !sdef.public && U.isPrivateIp(ip)); }
          else res.status = 'NXDOMAIN';
        }
        if (res.status === 'NXDOMAIN' || !res.answers.length) this._rootSoa(res, name);
        return res;
      }

      const zname = this._zoneFor(name, sdef);
      if (zname) {
        const zone = this.world.dns.zones[zname];
        const recs = this._zoneRecords(zname);
        res.flags.aa = !!(sdef && (sdef.zones || []).indexOf(zname) >= 0);
        let cur = name; let guard = 0; let exists = false;
        for (;;) {
          const here = recs.filter((r) => r.name === cur);
          if (here.length) exists = true;
          const match = here.filter((r) => type === 'ANY' || r.type === type);
          if (match.length) { res.answers.push.apply(res.answers, match); break; }
          const cname = here.find((r) => r.type === 'CNAME');
          if (cname && type !== 'CNAME' && guard++ < 8) {
            res.answers.push(cname); cur = cname.data.replace(/\.$/, '');
            if (!(cur === zname || cur.endsWith('.' + zname))) {
              const sub = this.dns(machine, cur, type, o);
              res.answers.push.apply(res.answers, sub.answers);
              return res;
            }
            continue;
          }
          break;
        }
        if (type === 'SOA' && name === zname && !res.answers.length) res.answers.push(this._soa(zname));
        if (!res.answers.length) {
          if (!exists && !recs.some((r) => r.name.endsWith('.' + name))) res.status = 'NXDOMAIN';
          res.authority.push(this._soa(zname));
        }
        void zone;
        return res;
      }

      if (sdef.recursive === false) { res.status = 'REFUSED'; res.flags.ra = false; return res; }
      // curated internet sites
      const site = this.world.internet.sites.find((x) => x.name === name || (x.aliases || []).indexOf(name) >= 0);
      if (site) {
        if (type === 'A' || type === 'ANY') for (const a of [site.ip].concat(site.ips || [])) res.answers.push({ name, type: 'A', ttl: 300, data: a });
        if (type === 'A' || type === 'ANY' || type === 'AAAA' || type === 'CNAME') {
          if (!res.answers.length) res.authority.push({ name: name.split('.').slice(-2).join('.'), type: 'SOA', ttl: 3600, data: 'ns1.' + name.split('.').slice(-2).join('.') + ' hostmaster.' + name.split('.').slice(-2).join('.') + ' 2026110101 7200 3600 1209600 3600' });
          return res;
        }
      } else if (!this._publicName(name)) {
        // internal-only names asked of a public resolver, or names that do not exist
        res.status = 'NXDOMAIN'; this._rootSoa(res, name); return res;
      }
      // synthesized public internet
      const apex = name.split('.').slice(-2).join('.');
      const ttl = 60 + (U.hash32('ttl:' + name) % 240);
      const ip = this._synthIp(name);
      const www = name.startsWith('www.') && name !== apex;
      switch (type) {
        case 'A': if (www) res.answers.push({ name, type: 'CNAME', ttl, data: apex }); res.answers.push({ name: www ? apex : name, type: 'A', ttl, data: www ? this._synthIp(apex) : ip }); break;
        case 'AAAA': { const h = U.hash32('v6:' + apex); res.answers.push({ name, type: 'AAAA', ttl, data: '2001:db8:' + (h & 0xffff).toString(16) + ':' + ((h >>> 16) & 0xffff).toString(16) + '::' + (1 + (U.hash32(name) % 200)).toString(16) }); break; }
        case 'MX': if (name === apex) { res.answers.push({ name, type: 'MX', ttl: 300, prio: 10, data: 'mail.' + apex }, { name, type: 'MX', ttl: 300, prio: 20, data: 'mail2.' + apex }); } break;
        case 'NS': if (name === apex) res.answers.push({ name, type: 'NS', ttl: 86400, data: 'ns1.' + apex }, { name, type: 'NS', ttl: 86400, data: 'ns2.' + apex }); break;
        case 'TXT': if (name === apex) res.answers.push({ name, type: 'TXT', ttl: 300, data: '"v=spf1 include:_spf.' + apex + ' ~all"' }); break;
        case 'SOA': if (name === apex) res.answers.push({ name, type: 'SOA', ttl: 3600, data: 'ns1.' + apex + ' hostmaster.' + apex + ' 2026110101 7200 3600 1209600 3600' }); break;
        case 'CNAME': if (www) res.answers.push({ name, type: 'CNAME', ttl, data: apex }); break;
        default: break;
      }
      if (!res.answers.length) res.authority.push({ name: apex, type: 'SOA', ttl: 3600, data: 'ns1.' + apex + ' hostmaster.' + apex + ' 2026110101 7200 3600 1209600 3600' });
      return res;
    },
    _rootSoa(res, name) {
      void name;
      res.authority.push({ name: '', type: 'SOA', ttl: 86400, data: 'a.root-servers.net nstld.verisign-grs.com 2026111300 1800 900 604800 86400' });
    },
    _ptr(ip, sdef) {
      const zones = this.world.dns.zones;
      for (const zname of Object.keys(zones)) {
        const z = zones[zname];
        if (z.internal && !(sdef && (sdef.zones || []).indexOf(zname) >= 0)) continue;
        for (const r of z.records) if (r.type === 'A' && r.data === ip && r.ptr !== false) return r.name === '@' ? zname : r.name + '.' + zname;
      }
      const site = this.world.internet.sites.find((s) => s.ip === ip || (s.ips || []).indexOf(ip) >= 0);
      if (site) return site.ptr || site.name;
      return null;
    },

    /** Zone transfer. Returns { status: 'OK'|'REFUSED'|'TIMEOUT'|'NOTAUTH', records, ms } */
    axfr(machine, zname, serverIp) {
      zname = String(zname).toLowerCase().replace(/\.$/, '');
      const t = this.tcp(machine, serverIp, 53, { kind: 'axfr' });
      if (t.state !== 'open') return { status: 'TIMEOUT', records: [], ms: 0 };
      const sdef = this.world.dns.servers[serverIp];
      const zone = this.world.dns.zones[zname];
      if (!sdef || !zone || (sdef.zones || []).indexOf(zname) < 0) return { status: 'NOTAUTH', records: [], ms: Math.round(t.rtt) + 1 };
      const allow = zone.axfr || [];
      if (!allow.some((c) => U.inCidr(t.route.src, c))) return { status: 'REFUSED', records: [], ms: Math.round(t.rtt) + 1 };
      const soa = this._soa(zname);
      return { status: 'OK', records: [soa].concat(this._zoneRecords(zname), [soa]), ms: Math.round(t.rtt) + 3 };
    },

    /**
     * Name resolution the way libc does it: IP literal, /etc/hosts, then DNS.
     * Returns { ip, name, source: 'literal'|'hosts'|'dns', ms } or null when the name does not resolve.
     */
    resolve(machine, name, o) {
      name = String(name).trim();
      if (U.isIPv4(name)) return { ip: name, name, source: 'literal', ms: 0 };
      const lower = name.toLowerCase().replace(/\.$/, '');
      if (lower === 'localhost') return { ip: '127.0.0.1', name: 'localhost', source: 'hosts', ms: 0 };
      let hostsFile = '';
      try { hostsFile = machine.vfs.read('/etc/hosts'); } catch (e) { hostsFile = ''; }
      for (const line of hostsFile.split('\n')) {
        const t = line.replace(/#.*/, '').trim().split(/\s+/);
        if (t.length >= 2 && U.isIPv4(t[0]) && t.slice(1).some((n) => n.toLowerCase() === lower)) return { ip: t[0], name: lower, source: 'hosts', ms: 0 };
      }
      const candidates = lower.indexOf('.') >= 0 ? [lower] : (machine.search || []).map((s) => lower + '.' + s).concat([lower]);
      let ms = 0;
      for (const server of (o && o.server ? [o.server] : machine.dns)) {
        for (const cand of candidates) {
          const r = this.dns(machine, cand, 'A', { server });
          ms += r.ms;
          if (r.status === 'TIMEOUT') break;
          const a = r.answers.find((x) => x.type === 'A');
          if (a) return { ip: a.data, name: a.name, source: 'dns', ms, cname: r.answers.find((x) => x.type === 'CNAME') ? a.name : null };
        }
      }
      return null;
    },
    /** Reverse name for an IP as seen from `machine` (or null). */
    reverse(machine, ip) {
      if (!U.isIPv4(ip)) return null;
      const self = machine.ifaces.find((i) => i.ip === ip);
      if (self) return self.kind === 'loopback' ? 'localhost' : machine.hostname;
      const name = ip.split('.').reverse().join('.') + '.in-addr.arpa';
      for (const server of machine.dns) {
        const r = this.dns(machine, name, 'PTR', { server });
        if (r.status === 'TIMEOUT') continue;
        const a = r.answers.find((x) => x.type === 'PTR');
        return a ? a.data : null;
      }
      return null;
    },

    /* ------------------------------------------------------------- HTTP */
    STATUS: { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 418: "I'm a teapot", 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' },

    /**
     * Perform one HTTP request (no redirect following; callers do that).
     *   req: { method, url, headers: {}, body, ip? (skip DNS), kind? }
     * Returns { status, statusText, headers: {lowercase: value}, body, ip, port, scheme, host, path, ms, tls }
     * Throws NetError: ENOTFOUND (DNS), ECONNREFUSED, ETIMEDOUT, EHOSTUNREACH, ENETUNREACH.
     */
    http(machine, req) {
      const m = /^(https?):\/\/([^\/:?#]+)(?::(\d+))?([^#]*)/i.exec(req.url);
      if (!m) throw new NetError('ENOTFOUND', req.url);
      const scheme = m[1].toLowerCase(); const hostname = m[2].toLowerCase();
      const port = m[3] ? parseInt(m[3], 10) : scheme === 'https' ? 443 : 80;
      let pathq = m[4] || '/'; if (pathq[0] !== '/') pathq = '/' + pathq;
      let ip = req.ip; let dnsMs = 0;
      if (!ip) {
        const r = this.resolve(machine, hostname);
        if (!r) throw new NetError('ENOTFOUND', hostname);
        ip = r.ip; dnsMs = r.ms;
      }
      const t = this.tcp(machine, ip, port, { kind: 'http' });
      if (t.route && !t.route.ok) throw new NetError(t.route.err, hostname);
      if (t.state === 'closed') throw new NetError('ECONNREFUSED', hostname);
      if (t.state !== 'open') throw new NetError('ETIMEDOUT', hostname);
      const svc = t.service; const host = t.host;
      const isTls = !!svc.tls;
      const out = { ip, port, scheme, host: hostname, path: pathq, ms: Math.round(dnsMs + t.rtt * (isTls ? 4 : 2) + 2 + this.rand() * 6), tls: null };
      if (scheme === 'https' && !isTls) { const e = new NetError('ECONNRESET', hostname); e.tlsError = 'wrong version number'; throw e; }
      if (scheme === 'http' && isTls) return Object.assign(out, { status: 400, statusText: 'Bad Request', headers: { 'content-type': 'text/html' }, body: '<html>\r\n<head><title>400 The plain HTTP request was sent to HTTPS port</title></head>\r\n<body>\r\n<center><h1>400 Bad Request</h1></center>\r\n<center>The plain HTTP request was sent to HTTPS port</center>\r\n</body>\r\n</html>\r\n' });
      const method = (req.method || 'GET').toUpperCase();
      const headers = {};
      for (const k of Object.keys(req.headers || {})) headers[k.toLowerCase()] = req.headers[k];
      const hostHeader = (headers.host || hostname).replace(/:\d+$/, '').toLowerCase();
      const qi = pathq.indexOf('?');
      const request = { method, path: qi >= 0 ? pathq.slice(0, qi) : pathq, query: qi >= 0 ? pathq.slice(qi + 1) : '', headers, body: req.body || '', host: hostHeader, port, scheme, client: t.route.src, machine };
      let resp;
      if (svc.listener && typeof svc.listener.http === 'function') resp = svc.listener.http(request);
      else resp = this._serve(host, svc, request);
      this.bus.emit('http', { host, svc, request, response: resp, ts: K.clock.now() });
      const rh = {};
      for (const k of Object.keys(resp.headers || {})) rh[k.toLowerCase()] = String(resp.headers[k]);
      let body = resp.body == null ? '' : String(resp.body);
      if (!rh['content-type'] && body) rh['content-type'] = resp.type || 'text/html; charset=utf-8';
      if (!rh.server && resp.server !== false) rh.server = (host.web && host.web.server) || (svc.product ? svc.product + (svc.version ? '/' + String(svc.version).split(' ')[0] : '') : 'nginx');
      rh.date = new Date(K.clock.now()).toUTCString();
      rh['content-length'] = String(U.byteLen(body));
      if (method === 'HEAD') body = '';
      if (isTls) out.tls = (host.web && host.web.tls) || { subject: 'CN=' + (host.fqdn || hostname), issuer: 'C=US, O=Simulated Trust Services, CN=SimTrust RSA CA 1', notBefore: 'Sep  1 00:00:00 2026 GMT', notAfter: 'Nov 30 23:59:59 2026 GMT', version: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384' };
      return Object.assign(out, { status: resp.status || 200, statusText: this.STATUS[resp.status || 200] || 'Unknown', headers: rh, body });
    },

    _serve(host, svc, request) {
      const web = host.web;
      const notFound = () => {
        const srv = (web && web.server) || svc.product || 'nginx';
        if (/apache/i.test(srv)) return { status: 404, body: '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>404 Not Found</title>\n</head><body>\n<h1>Not Found</h1>\n<p>The requested URL was not found on this server.</p>\n<hr>\n<address>' + srv.replace('/', '/') + ' Server at ' + request.host + ' Port ' + request.port + '</address>\n</body></html>\n' };
        return { status: 404, body: '<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>' + srv.split(' ')[0] + '</center>\r\n</body>\r\n</html>\r\n' };
      };
      if (!web) {
        if (host.synthetic || host.inet) {
          if (request.path !== '/' && request.path !== '/index.html') return notFound();
          return { status: 200, body: '<!doctype html>\n<html>\n<head>\n  <title>' + request.host + '</title>\n  <meta charset="utf-8">\n</head>\n<body>\n  <h1>' + request.host + '</h1>\n  <p>This page is served by the Kalima simulated internet. No real network traffic was sent.</p>\n</body>\n</html>\n' };
        }
        return notFound();
      }
      const siteKey = (web.vhosts && (web.vhosts[request.host + ':' + request.port] || web.vhosts[request.host])) || (web.ports && web.ports[request.port]) || 'default';
      const site = (web.sites && (web.sites[siteKey] || web.sites.default)) || web;
      const routes = site.routes || {};
      let r = routes[request.method + ' ' + request.path] || routes[request.path];
      if (r == null && request.path.length > 1 && request.path.endsWith('/')) r = routes[request.path.slice(0, -1)];
      if (r == null && typeof site.fallback === 'function') r = site.fallback;
      if (r == null) {
        // directory redirect: /dir -> /dir/
        if (routes[request.path + '/'] != null) return { status: 301, headers: { location: request.scheme + '://' + request.host + request.path + '/' }, body: '' };
        return notFound();
      }
      if (typeof r === 'function') { r = r(request, host); if (r == null) return notFound(); }
      if (typeof r === 'string') r = { status: 200, body: r };
      if (r.methods && r.methods.indexOf(request.method) < 0 && request.method !== 'HEAD') return { status: 405, headers: { allow: r.methods.join(', ') }, body: '' };
      return r;
    },

    /* ------------------------------------------------------------ scope */
    /** Is this IP (or name) inside the engagement scope? */
    inScope(target) {
      const e = this.world.engagement;
      if (U.isIPv4(target)) {
        if (U.inCidr(target, '127.0.0.0/8')) return true;
        return e.scope.some((c) => U.inCidr(target, c)) && !(e.exclude || []).includes(target);
      }
      const n = String(target).toLowerCase().replace(/\.$/, '');
      if (n === 'localhost') return true;
      return (e.domains || []).some((d) => n === d || n.endsWith('.' + d));
    },

    /**
     * Scope guard for ACTIVE testing tools (scanners and anything beyond normal client behaviour).
     * Returns true when the target is allowed. Otherwise prints an explanation to ctx.err and returns false.
     * Ordinary diagnostics (ping, traceroute, dig, curl, whois) do not call this.
     */
    guard(ctx, targetIp, tool) {
      if (!K.settings.scopeGuard) return true;
      const own = ctx.machine.ifaces.some((i) => i.ip === targetIp);
      if (own || this.inScope(targetIp)) return true;
      const e = this.world.engagement;
      ctx.err(
        K.c.red('[kalima] Out-of-scope target blocked: ' + targetIp) + '\n' +
        '  ' + (tool || ctx.name) + ' is an active testing tool. Your written authorization covers only:\n' +
        e.scope.map((s) => '    ' + s).join('\n') + '\n' + (e.domains || []).map((d) => '    *.' + d).join('\n') + '\n' +
        '  Testing systems without permission is illegal in most jurisdictions and breaks the\n' +
        '  rules of engagement. Review them with:  cat ~/engagement/rules-of-engagement.txt\n');
      K.events.emit('scope-violation', { target: targetIp, tool: tool || ctx.name });
      return false;
    },
  });

  /* Built-in protocol handlers. Packs may register richer ones (ftp, smtp, ...). */
  net.services.register('generic', {
    greet(s) { return s.svc.banner ? s.svc.banner + '\r\n' : ''; },
    data() { return ''; },
  });
  net.services.register('http', {
    greet() { return ''; },
    data(s, input) {
      // raw HTTP typed into nc/telnet: answer once the request head is complete
      s.state.buf = (s.state.buf || '') + input;
      if (!/\r?\n\r?\n/.test(s.state.buf) && !/^(GET|HEAD|POST|OPTIONS) \S+ HTTP\/1\.0\r?\n/.test(s.state.buf)) return '';
      const head = s.state.buf.split(/\r?\n/);
      s.state.buf = '';
      const m = /^([A-Z]+) (\S+)(?: HTTP\/(\d\.\d))?$/.exec(head[0].trim());
      const bad = 'HTTP/1.1 400 Bad Request\r\nServer: ' + ((s.host.web && s.host.web.server) || s.svc.product || 'nginx') + '\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html>\r\n<head><title>400 Bad Request</title></head>\r\n<body>\r\n<center><h1>400 Bad Request</h1></center>\r\n</body>\r\n</html>\r\n';
      s.open = false;
      if (!m) return bad;
      const headers = {};
      for (const l of head.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
      let res;
      try {
        res = net.http(s.machine, { method: m[1], url: (s.svc.tls ? 'https' : 'http') + '://' + (headers.host || s.ip) + ':' + s.port + m[2], headers, ip: s.ip });
      } catch (e) { return bad; }
      let out = 'HTTP/1.1 ' + res.status + ' ' + res.statusText + '\r\n';
      const order = ['server', 'date', 'content-type', 'content-length'];
      const keys = order.filter((k) => res.headers[k] != null).concat(Object.keys(res.headers).filter((k) => order.indexOf(k) < 0));
      for (const k of keys) out += k.replace(/(^|-)([a-z])/g, (x, a, b) => a + b.toUpperCase()) + ': ' + res.headers[k] + '\r\n';
      out += 'Connection: close\r\n\r\n' + res.body;
      return out;
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
