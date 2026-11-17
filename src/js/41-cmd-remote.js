/* Kalima — remote login, file transfer and plain TCP clients.
 *
 *   remote login        ssh
 *   plain TCP clients   nc (netcat, ncat) telnet
 *   protocol handlers   ssh (what a raw connection to that port answers)
 *
 * Every connection goes through K.net, so nothing leaves the simulator.
 * Keys are simulated: the files use the real OpenSSH layouts, but the key
 * material is seeded noise that carries a readable KALIMA+SIMULATED+KEY marker,
 * and fingerprints are stable stand-ins rather than real digests. Passwords are
 * only ever compared with the lab accounts in the world model.
 */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;

  /* ================================================================ helpers */

  const SSH_VERSION = 'OpenSSH_10.0p1 Debian-7';
  const AUTH_LOG = '/var/log/auth.log';
  const IMAGE_BUILT = Date.UTC(2026, 9, 26, 9, 12, 0);

  /** ctime(3) without the newline: "Fri Nov 13 14:30:05 2026" */
  function ctime(ms) {
    const d = new Date(ms);
    return U.DAYS[d.getUTCDay()] + ' ' + U.MONTHS[d.getUTCMonth()] + ' ' + U.padStart(d.getUTCDate(), 2) + ' ' + U.isoDate(ms).slice(11) + ' ' + d.getUTCFullYear();
  }

  /** getaddrinfo's complaint for a name that did not resolve. */
  function resolveFailure(machine, name) {
    const status = K.net.dns(machine, name, 'A').status;
    return status === 'TIMEOUT' || status === 'NOSERVER' ? 'Temporary failure in name resolution' : 'Name or service not known';
  }

  // How long connect(2) takes to give up: SYN retries for a silent host, ARP retries for a missing neighbour.
  const CONNECT_WAIT = { ETIMEDOUT: 130000, EHOSTUNREACH: 3100 };

  /**
   * Open a TCP connection with the waiting a real client sees. `limitMs` is the caller's own
   * timeout; `probeOnly` checks the port without opening a session (and resolves null).
   * Returns the session; throws K.NetError after the wait.
   */
  async function dial(ctx, ip, port, limitMs, probeOnly) {
    let session = null; let rtt;
    try {
      if (probeOnly) {
        const t = K.net.tcp(ctx.machine, ip, port);
        const code = !t.route.ok ? t.route.err : t.state === 'open' ? null : t.state === 'closed' ? 'ECONNREFUSED' : 'ETIMEDOUT';
        if (code) throw new K.NetError(code);
        rtt = t.rtt;
      } else {
        session = K.net.connect(ctx.machine, ip, port);
        rtt = session.rtt;
      }
    } catch (e) {
      if (!(e instanceof K.NetError)) throw e;
      const wait = CONNECT_WAIT[e.code] || 1;
      if (limitMs == null || wait <= limitMs) { await ctx.sleep(wait); throw e; }
      await ctx.sleep(limitMs);
      throw new K.NetError('ETIMEDOUT');
    }
    await ctx.sleep(rtt);
    return session;
  }

  /** /etc/services on this machine, as getservbyport(3) and getservbyname(3) read it. */
  function servicesFile(machine) {
    try { return machine.vfs.read('/etc/services'); } catch (e) { return ''; }
  }
  function serviceName(machine, port, proto) {
    const m = new RegExp('^(\\S+)\\s+' + port + '/' + proto + '\\b', 'm').exec(servicesFile(machine));
    return m ? m[1] : null;
  }
  /** A port given as a number or a service name; 0 when it is neither. */
  function portNumber(machine, text, proto) {
    if (/^\d+$/.test(text)) return +text < 65536 ? +text : 0;
    const m = new RegExp('^' + U.escapeRe(text) + '\\s+(\\d+)/' + proto + '\\b', 'm').exec(servicesFile(machine));
    return m ? +m[1] : 0;
  }
  const ephemeralPort = () => 32768 + Math.floor(K.net.rand() * 28232);

  /** What gets sent: piped input exactly as given (a last line may lack its newline), or lines typed at the terminal. */
  function lineSource(ctx) {
    if (ctx.stdin == null) return async () => { const line = await ctx.readLine(''); return line == null ? null : line + '\n'; };
    const chunks = ctx.stdin.match(/[^\n]*\n|[^\n]+$/g) || [];
    return async () => (chunks.length ? chunks.shift() : null);
  }

  /**
   * Open a listening socket. Lab servers answer from the world's static service table,
   * so a listener started on one has to appear there too.
   */
  function openListener(machine, listener) {
    const stop = K.net.listen(machine, listener);
    const host = K.net.hostOf(machine);
    if (!host || host.dynamic) return stop;
    const svc = { port: listener.port, proto: listener.proto, name: listener.name, listener };
    host.services.push(svc);
    return () => { stop(); host.services.splice(host.services.indexOf(svc), 1); };
  }

  /** K.getopt with BSD getopt's wording, which the OpenSSH tools print. Parsing stops at the first operand. */
  function bsdGetopt(args, short) {
    const g = K.getopt(args, { short, stopAtNonOption: true });
    if (g.err) {
      g.err = /^unrecognized/.test(g.err) ? 'unknown option -- -' : g.err.replace(/^invalid option/, 'unknown option').replace(/'(.)'$/, '$1');
    }
    return g;
  }

  /* ========================================================= simulated keys */

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function b64enc(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      s += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
    }
    return s;
  }
  function b64dec(text) {
    const out = []; let acc = 0; let bits = 0;
    for (const ch of text) {
      const v = B64.indexOf(ch);
      if (v < 0) continue;
      acc = ((acc << 6) | v) & 0xffff; bits += 6;
      if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
    }
    return out;
  }

  /* SSH wire format: big-endian lengths in front of strings. */
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0) & 255);
  const wireStr = (bytes) => u32(bytes.length).concat(bytes);
  const noiseBytes = (rnd, n) => Array.from({ length: n }, () => Math.floor(rnd() * 256));

  /** Reads the fields of a wire-format buffer in order. */
  function wireReader(bytes) {
    let pos = 0;
    return {
      skip(n) { pos += n; },
      str() {
        const n = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
        const s = bytes.slice(pos + 4, pos + 4 + n);
        pos += 4 + n;
        return s;
      },
    };
  }

  const MARK = b64dec('KALIMA+SIMULATED+KEY');
  const KEY_LABEL = { ed25519: 'ED25519', rsa: 'RSA', ecdsa: 'ECDSA' };
  const keyTypeName = (kind, bits) => (kind === 'ecdsa' ? 'ecdsa-sha2-nistp' + bits : 'ssh-' + kind);

  /** A public key blob (base64): real wire framing around seeded noise. */
  function makeBlob(kind, bits, seed) {
    const rnd = U.prng('key:' + seed);
    let frame; let key;
    if (kind === 'ed25519') {
      key = noiseBytes(rnd, 32);
      frame = wireStr(ascii('ssh-ed25519')).concat(u32(32));
    } else if (kind === 'rsa') {
      key = noiseBytes(rnd, bits / 8); key[0] |= 0x80;
      frame = wireStr(ascii('ssh-rsa')).concat(wireStr([1, 0, 1]), u32(key.length + 1), [0]);
    } else {
      key = noiseBytes(rnd, 2 * Math.ceil(bits / 8));
      frame = wireStr(ascii(keyTypeName(kind, bits))).concat(wireStr(ascii('nistp' + bits)), u32(key.length + 1), [4]);
    }
    // The marker goes where it lines up with base64's three-byte groups, so it reads as text in the file.
    key.splice(3 - (frame.length % 3), MARK.length, ...MARK);
    return b64enc(frame.concat(key));
  }

  /** { type, blob, comment } from a public key line; authorized_keys options in front of the type are skipped. */
  function parsePublicLine(line) {
    const m = /(?:^|\s)(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp\d+)\s+([A-Za-z0-9+/]+=*)(?:\s+(.*))?$/.exec(line.trim());
    return m ? { type: m[1], blob: m[2], comment: m[3] || '' } : null;
  }

  /** Display name and size for a key, e.g. { label: 'RSA', bits: 3072 }. */
  function keyInfo(key) {
    if (key.type === 'ssh-ed25519') return { label: KEY_LABEL.ed25519, bits: 256 };
    if (key.type === 'ssh-rsa') return { label: KEY_LABEL.rsa, bits: (b64dec(key.blob).length - 23) * 8 };
    return { label: KEY_LABEL.ecdsa, bits: parseInt(key.type.replace(/^\D+/, ''), 10) };
  }

  /** 32 digest-like bytes for a key blob. Stable, but not a real SHA-256. */
  const digestBytes = (blob) => noiseBytes(U.prng('fingerprint:' + blob), 32);
  const fingerprint = (blob) => 'SHA256:' + b64enc(digestBytes(blob)).replace(/=+$/, '');

  const PEM_HEAD = '-----BEGIN OPENSSH PRIVATE KEY-----';
  const PEM_TAIL = '-----END OPENSSH PRIVATE KEY-----';
  const PRIVATE_NOTE = 'KALIMA SIMULATED PRIVATE KEY - no real key material';
  // Roughly how much secret data a real key of each kind carries, so file sizes look right.
  const secretSize = (key) => (key.type === 'ssh-rsa' ? Math.round(b64dec(key.blob).length * 4.3) : 64);

  /** Stand-in for the KDF: lets a passphrase be checked without storing it. */
  const passphraseCheck = (salt, passphrase) => U.hash32(salt.join(',') + ':a:' + passphrase).toString(16) + U.hash32(salt.join(',') + ':b:' + passphrase).toString(16);

  /** Text of a private key file in the openssh-key-v1 layout for { type, blob, comment }. */
  function makePrivateFile(key, passphrase, seed) {
    const rnd = U.prng('private:' + seed);
    const locked = passphrase !== '';
    const salt = noiseBytes(rnd, 16);
    const secret = wireStr(ascii(PRIVATE_NOTE)).concat(
      wireStr(U.toBytes(key.comment)), wireStr(ascii(locked ? passphraseCheck(salt, passphrase) : '')), wireStr(noiseBytes(rnd, secretSize(key))));
    const body = ascii('openssh-key-v1\0').concat(
      wireStr(ascii(locked ? 'aes256-ctr' : 'none')), wireStr(ascii(locked ? 'bcrypt' : 'none')),
      wireStr(locked ? wireStr(salt).concat(u32(24)) : []), u32(1), wireStr(b64dec(key.blob)), wireStr(secret));
    return PEM_HEAD + '\n' + b64enc(body).match(/.{1,70}/g).join('\n') + '\n' + PEM_TAIL + '\n';
  }

  /** Read a private key file written by makePrivateFile: { type, blob, comment, locked, salt, check }, or null. */
  function parsePrivateFile(text) {
    const m = /^-----BEGIN OPENSSH PRIVATE KEY-----\n([\s\S]*?)\n-----END OPENSSH PRIVATE KEY-----\s*$/.exec(text);
    const bytes = m ? b64dec(m[1]) : [];
    if (U.fromBytes(bytes.slice(0, 15)) !== 'openssh-key-v1\0') return null;
    const r = wireReader(bytes.slice(15));
    const locked = U.fromBytes(r.str()) !== 'none';
    r.str();
    const kdf = wireReader(r.str());
    r.skip(4);
    const blob = r.str();
    const secret = wireReader(r.str());
    if (U.fromBytes(secret.str()) !== PRIVATE_NOTE) return null;
    return {
      type: U.fromBytes(wireReader(blob).str()), blob: b64enc(blob), comment: U.fromBytes(secret.str()),
      locked, salt: locked ? kdf.str() : [], check: U.fromBytes(secret.str()),
    };
  }

  /** Every SSH server in the world has one ED25519 host key, derived from its host id. */
  const hostKeyBlob = (hostId) => makeBlob('ed25519', 256, 'hostkey:' + hostId);

  K.fsSeeds.push((machine) => {
    const key = { type: 'ssh-ed25519', blob: hostKeyBlob(machine.hostId), comment: 'root@' + machine.hostname };
    machine.vfs.seed('/etc/ssh/ssh_host_ed25519_key', makePrivateFile(key, '', 'hostkey:' + machine.hostId), { mode: 0o600, mtime: IMAGE_BUILT });
    machine.vfs.seed('/etc/ssh/ssh_host_ed25519_key.pub', key.type + ' ' + key.blob + ' ' + key.comment + '\n', { mtime: IMAGE_BUILT });
  });

  /* ============================================================ known_hosts */

  /** Stand-in for the HMAC-SHA1 of a hashed known_hosts name. */
  const hostHash = (salt, name) => b64enc(noiseBytes(U.prng('known_hosts:' + salt + ':' + name), 20));

  /** Parsed known_hosts entries: [{ n (line number), names | null when hashed, salt, hash, type, blob }] */
  function readKnownHosts(fs, path) {
    let text;
    try { text = fs.read(path); } catch (e) { return []; }
    const entries = [];
    text.split('\n').forEach((line, i) => {
      const f = line.trim().split(/\s+/);
      if (f.length < 3 || f[0][0] === '#') return;
      const hashed = /^\|1\|([^|]+)\|([^|]+)$/.exec(f[0]);
      entries.push({ n: i + 1, names: hashed ? null : f[0].split(','), salt: hashed && hashed[1], hash: hashed && hashed[2], type: f[1], blob: f[2] });
    });
    return entries;
  }
  const knownAs = (entry, name) => (entry.names ? entry.names.includes(name) : hostHash(entry.salt, name) === entry.hash);

  const CHANGED_KEY_WARNING = [
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
    'Someone could be eavesdropping on you right now (man-in-the-middle attack)!',
    'It is also possible that a host key has just been changed.',
  ];

  /**
   * Check the server's host key against known_hosts, asking about a new host the way ssh does.
   * Resolves true when the connection may go on.
   */
  async function checkHostKey(ctx, target, ip, blob) {
    const say = (s) => ctx.err(s + '\n');
    const conf = target.conf;
    const strict = (conf.stricthostkeychecking || 'ask').toLowerCase();
    const file = target.tilde(conf.userknownhostsfile || '~/.ssh/known_hosts');
    const name = target.port === 22 ? target.host : '[' + target.host + ']:' + target.port;
    const entries = readKnownHosts(ctx.fs, file);
    const mine = entries.filter((e) => e.type === 'ssh-ed25519' && knownAs(e, name));
    if (mine.some((e) => e.blob === blob)) return true;
    const print = fingerprint(blob);
    if (mine.length) {
      say(CHANGED_KEY_WARNING.concat([
        'The fingerprint for the ED25519 key sent by the remote host is', print + '.', 'Please contact your system administrator.',
        'Add correct host key in ' + file + ' to get rid of this message.', 'Offending ED25519 key in ' + file + ':' + mine[0].n,
        '  remove with:', "  ssh-keygen -f '" + file + "' -R '" + name + "'",
        'Host key for ' + name + ' has changed and you have requested strict checking.', 'Host key verification failed.',
      ]).join('\n'));
      return false;
    }
    if (strict === 'yes') {
      say('No ED25519 host key is known for ' + name + ' and you have requested strict checking.');
      say('Host key verification failed.');
      return false;
    }
    if (strict === 'ask') {
      say("The authenticity of host '" + name + ' (' + (target.port === 22 ? ip : '[' + ip + ']:' + target.port) + ")' can't be established.");
      say('ED25519 key fingerprint is ' + print + '.');
      const others = entries.filter((e) => e.blob === blob);
      if (others.length) {
        say('This host key is known by the following other names/addresses:');
        for (const e of others) say('    ' + (conf.userknownhostsfile || '~/.ssh/known_hosts') + ':' + e.n + ': ' + (e.names ? e.names.join(',') : '[hashed name]'));
      } else say('This key is not known by any other names.');
      let prompt = 'Are you sure you want to continue connecting (yes/no/[fingerprint])? ';
      for (;;) {
        const answer = await ctx.term.readLine({ prompt });
        if (answer == null || /^no$/i.test(answer.trim())) { say('Host key verification failed.'); return false; }
        if (/^yes$/i.test(answer.trim()) || answer.trim() === print) break;
        prompt = "Please type 'yes', 'no' or the fingerprint: ";
      }
    }
    const salt = b64enc(noiseBytes(() => K.net.rand(), 20));
    const first = /^yes$/i.test(conf.hashknownhosts || '') ? '|1|' + salt + '|' + hostHash(salt, name) : name;
    try {
      if (!ctx.fs.exists(K.VFS.dirname(file))) ctx.fs.mkdir(K.VFS.dirname(file), { mode: 0o700 });
      ctx.fs.append(file, first + ' ssh-ed25519 ' + blob + '\n', { mode: 0o600 });
      say("Warning: Permanently added '" + name + "' (ED25519) to the list of known hosts.");
    } catch (e) {
      say('Failed to add the host to the list of known hosts (' + file + ').');
    }
    return true;
  }

  /* ============================================================== ssh login */

  const DEFAULT_IDENTITIES = ['id_rsa', 'id_ecdsa', 'id_ed25519'];
  const SSH_KEYWORDS = ['hostname', 'user', 'port', 'identityfile', 'stricthostkeychecking', 'userknownhostsfile', 'hashknownhosts',
    'batchmode', 'connecttimeout', 'numberofpasswordprompts', 'preferredauthentications', 'pubkeyauthentication', 'passwordauthentication'];

  /** "-o Keyword=value" arguments as a lower-cased map: { conf } or { err } for a keyword ssh does not have. */
  function cliOptions(list) {
    const conf = {};
    for (const item of list) {
      const m = /^\s*([A-Za-z]+)\s*[=\s]\s*(.*?)\s*$/.exec(item);
      const key = m ? m[1].toLowerCase() : item;
      if (!m || !SSH_KEYWORDS.includes(key)) return { err: 'command-line: line 0: Bad configuration option: ' + key };
      conf[key] = m[2];
    }
    return { conf };
  }

  /** ssh_config(5) lookup for one host: command line first, then the files; the first value found for a keyword wins. */
  function sshConfig(ctx, host, cli, configFile) {
    const conf = Object.assign({}, cli);
    for (const file of configFile ? [configFile] : [ctx.user.home + '/.ssh/config', '/etc/ssh/ssh_config']) {
      let text;
      try { text = ctx.fs.read(file); } catch (e) { continue; }
      let applies = true;
      for (const line of text.split('\n')) {
        const m = /^\s*([A-Za-z]+)(?:\s*=\s*|\s+)(.*?)\s*$/.exec(line);
        if (!m) continue;
        const key = m[1].toLowerCase(); const value = m[2].replace(/^"(.*)"$/, '$1');
        if (key === 'host') applies = value.split(/\s+/).some((pattern) => U.globToRe(pattern).test(host));
        else if (key === 'match') applies = false;
        else if (applies && !(key in conf)) conf[key] = value;
      }
    }
    return conf;
  }

  /**
   * Who to log in as and where. spec: { host, user, port, identities: [paths], options: {-o map}, configFile }
   */
  function sshTarget(ctx, spec) {
    const conf = sshConfig(ctx, spec.host, spec.options, spec.configFile);
    const home = ctx.user.home;
    const tilde = (p) => p.replace(/^~(?=\/|$)/, home);
    return {
      host: (conf.hostname || spec.host).toLowerCase(),
      user: spec.user || conf.user || ctx.user.name,
      port: parseInt(spec.port || conf.port || 22, 10),
      explicit: spec.identities.concat(conf.identityfile ? [conf.identityfile] : []).map(tilde),
      defaults: DEFAULT_IDENTITIES.map((n) => home + '/.ssh/' + n),
      conf, tilde,
    };
  }

  /** Load one identity file with ssh's complaints. Returns the parsed key or null. */
  function loadIdentity(ctx, path) {
    let mode; let text;
    try { mode = ctx.fs.stat(path).mode & 0o777; text = ctx.fs.read(path); } catch (e) { return null; }
    if (mode & 0o077) {
      ctx.err(['@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@', '@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @',
        '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@', 'Permissions 0' + mode.toString(8).padStart(3, '0') + " for '" + path + "' are too open.",
        'It is required that your private key files are NOT accessible by others.', 'This private key will be ignored.',
        'Load key "' + path + '": bad permissions', ''].join('\n'));
      return null;
    }
    const key = parsePrivateFile(text);
    if (!key) ctx.err('Load key "' + path + '": invalid format\n');
    return key;
  }

  /** Ask for a key's passphrase, three tries as ssh allows. */
  async function unlockIdentity(ctx, path, key) {
    for (let i = 0; i < 3; i++) {
      const typed = await ctx.term.readLine({ prompt: "Enter passphrase for key '" + path + "': ", hidden: true });
      if (typed != null && passphraseCheck(key.salt, typed) === key.check) return true;
    }
    return false;
  }

  /** Key blobs the account's authorized_keys file accepts. */
  function authorizedBlobs(machine, account) {
    try {
      return machine.vfs.read(account.home + '/.ssh/authorized_keys').split('\n').map(parsePublicLine).filter(Boolean).map((k) => k.blob);
    } catch (e) { return []; }
  }

  /** One auth-facility line from sshd: through K.syslog when a logging pack provides it, otherwise straight into auth.log. */
  function authLog(machine, ident, pid, msg) {
    const entry = { facility: 'auth', severity: 'info', ident, pid, msg, ts: K.clock.now() };
    try {
      if (typeof K.syslog === 'function') K.syslog(machine, entry);
      else machine.vfs.write(AUTH_LOG, U.syslogDate(entry.ts) + ' ' + machine.hostname + ' ' + ident + '[' + pid + ']: ' + msg + '\n', { append: true });
    } catch (e) { /* a full or missing /var/log must not break the login */ }
  }

  /** The server side of one connection: its machine (null when the host has no logins) and its log lines. */
  function sshdSide(session) {
    const machine = K.net.machineFor(session.host.id);
    if (!machine) return { machine: null, from: '', log() {} };
    // OpenSSH 9.8 moved per-connection work, and its log lines, into sshd-session.
    const ident = session.svc.version && parseFloat(session.svc.version) < 9.8 ? 'sshd' : 'sshd-session';
    // The world may already have logged "Connection from" for this connection: keep its pid and client port.
    let last = '';
    try { last = machine.vfs.read(AUTH_LOG).trimEnd().split('\n').pop(); } catch (e) { /* no log yet */ }
    const seen = /\[(\d+)\]: Connection from (\S+) port (\d+) on /.exec(last);
    const mine = seen && seen[2] === session.client;
    const pid = mine ? +seen[1] : machine.nextPid();
    const from = session.client + ' port ' + (mine ? seen[3] : ephemeralPort());
    return { machine, from, log: (msg) => authLog(machine, ident, pid, msg) };
  }

  const isSshService = (svc) => svc.handler === 'ssh' || /^sshd?$/.test(svc.name || '');

  /**
   * What ssh, scp and ssh-copy-id share: resolve, connect, check the host key, authenticate.
   * spec: see sshTarget, plus { verbose }. Returns the login { target, ip, machine, account, close() },
   * or null after printing why it failed (the caller exits 255).
   */
  async function sshLogin(ctx, spec) {
    const target = sshTarget(ctx, spec);
    const conf = target.conf;
    const say = (s) => ctx.err(s + '\n');
    const debug = (s) => { if (spec.verbose) ctx.err('debug1: ' + s + '\n'); };
    const identities = target.explicit.filter((path) => {
      if (ctx.fs.exists(path)) return true;
      say('Warning: Identity file ' + path + ' not accessible: No such file or directory.');
      return false;
    }).concat(target.defaults);

    const res = K.net.resolve(ctx.machine, target.host);
    if (!res) { say('ssh: Could not resolve hostname ' + target.host + ': ' + resolveFailure(ctx.machine, target.host)); return null; }
    await ctx.sleep(res.ms);
    debug('Connecting to ' + target.host + ' [' + res.ip + '] port ' + target.port + '.');
    let session;
    try { session = await dial(ctx, res.ip, target.port, conf.connecttimeout ? conf.connecttimeout * 1000 : null); }
    catch (e) {
      if (!(e instanceof K.NetError)) throw e;
      say('ssh: connect to host ' + target.host + ' port ' + target.port + ': ' + e.message);
      return null;
    }
    debug('Connection established.');
    if (!isSshService(session.svc)) {
      session.close();
      say('kex_exchange_identification: Connection closed by remote host');
      say('Connection closed by ' + res.ip + ' port ' + target.port);
      return null;
    }
    debug('Local version string SSH-2.0-' + SSH_VERSION);
    debug('Remote protocol version 2.0, remote software version ' + (session.svc.banner || 'SSH-2.0-' + SSH_VERSION).replace(/^SSH-2\.0-/, ''));
    debug('Authenticating to ' + target.host + ':' + target.port + " as '" + target.user + "'");
    const hostBlob = hostKeyBlob(session.host.id);
    debug('Server host key: ssh-ed25519 ' + fingerprint(hostBlob));
    if (!(await checkHostKey(ctx, target, res.ip, hostBlob))) { session.close(); return null; }

    const side = sshdSide(session);
    const account = side.machine && side.machine.userByName(target.user);
    if (side.machine && !account) side.log('Invalid user ' + target.user + ' from ' + side.from);
    const offered = (conf.preferredauthentications || 'publickey,password').split(',');
    const allowed = (name, keyword) => offered.includes(name) && !/^no$/i.test(conf[keyword] || '');
    debug('Authentications that can continue: publickey,password');
    let method = null; let detail = '';

    if (allowed('publickey', 'pubkeyauthentication')) {
      debug('Next authentication method: publickey');
      const accepted = account ? authorizedBlobs(side.machine, account) : [];
      for (const path of identities) {
        const key = ctx.fs.exists(path) ? loadIdentity(ctx, path) : null;
        if (!key) { debug('Trying private key: ' + path); continue; }
        const shown = keyInfo(key).label + ' ' + fingerprint(key.blob);
        debug('Offering public key: ' + path + ' ' + shown);
        if (!accepted.includes(key.blob)) continue;
        debug('Server accepts key: ' + path + ' ' + shown);
        if (key.locked && !(await unlockIdentity(ctx, path, key))) continue;
        method = 'publickey'; detail = ': ' + shown;
        break;
      }
    }
    if (!method && allowed('password', 'passwordauthentication') && !/^yes$/i.test(conf.batchmode || '')) {
      debug('Next authentication method: password');
      const tries = parseInt(conf.numberofpasswordprompts, 10) || 3;
      for (let i = 0; i < tries && !method; i++) {
        const typed = await ctx.term.readLine({ prompt: target.user + '@' + target.host + "'s password: ", hidden: true });
        if (typed != null && account && side.machine.checkPassword(target.user, typed)) { method = 'password'; break; }
        await ctx.sleep(K.net.jitter(2100, 600));
        side.log('Failed password for ' + (account ? '' : 'invalid user ') + target.user + ' from ' + side.from + ' ssh2');
        if (i < tries - 1) say('Permission denied, please try again.');
      }
    }
    if (!method) {
      side.log('Connection closed by ' + (account ? 'authenticating' : 'invalid') + ' user ' + target.user + ' ' + side.from + ' [preauth]');
      session.close();
      say(target.user + '@' + target.host + ': Permission denied (publickey,password).');
      return null;
    }
    await ctx.sleep(K.net.jitter(120, 60));
    if (spec.verbose) say('Authenticated to ' + target.host + ' ([' + res.ip + ']:' + target.port + ') using "' + method + '".');
    // Before this login reaches the log: what the host knows about the account's previous one.
    const lastSeen = (side.machine.state.sshLastLogin = side.machine.state.sshLastLogin || {});
    if (!(target.user in lastSeen)) lastSeen[target.user] = loggedLogin(side.machine, target.user);
    side.log('Accepted ' + method + ' for ' + target.user + ' from ' + side.from + ' ssh2' + detail);
    side.log('pam_unix(sshd:session): session opened for user ' + target.user + '(uid=' + account.uid + ') by ' + target.user + '(uid=0)');
    const login = {
      target, ip: res.ip, client: session.client, machine: side.machine, account, procs: [],
      close() {
        for (const p of login.procs) side.machine.reap(p.pid);
        side.log('Received disconnect from ' + side.from + ':11: disconnected by user');
        side.log('Disconnected from user ' + target.user + ' ' + side.from);
        side.log('pam_unix(sshd:session): session closed for user ' + target.user);
        session.close();
      },
    };
    return login;
  }

  /* ========================================================== ssh sessions */

  const DEBIAN_MOTD = '\nThe programs included with the Debian GNU/Linux system are free software;\nthe exact distribution terms for each program are described in the\n' +
    'individual files in /usr/share/doc/*/copyright.\n\nDebian GNU/Linux comes with ABSOLUTELY NO WARRANTY, to the extent\npermitted by applicable law.\n';

  /** The last SSH login the host's auth.log records for an account: { ts, from } or null. */
  function loggedLogin(machine, user) {
    let text = '';
    try { text = machine.vfs.read(AUTH_LOG); } catch (e) { return null; }
    const re = new RegExp('^(\\w{3}) +(\\d+) (\\d\\d):(\\d\\d):(\\d\\d) \\S+ sshd[^:]*: Accepted \\S+ for ' + U.escapeRe(user) + ' from (\\S+) ', 'gm');
    let m; let last = null;
    while ((m = re.exec(text))) last = m;
    if (!last) return null;
    const now = K.clock.date(); const month = U.MONTHS.indexOf(last[1]);
    const year = now.getUTCFullYear() - (month > now.getUTCMonth() ? 1 : 0); // syslog lines carry no year
    return { ts: Date.UTC(year, month, +last[2], +last[3], +last[4], +last[5]), from: last[6] };
  }

  /** What a login prints before the prompt: the kernel line, the message of the day and the previous login. */
  function loginBanner(login) {
    const m = login.machine; const os = m.os; const user = login.account.name;
    let text;
    if (/^Ubuntu/.test(os.pretty || '')) {
      text = 'Welcome to ' + os.pretty + ' (GNU/Linux ' + os.kernel + ' ' + os.arch + ')\n\n * Documentation:  https://help.ubuntu.com\n' +
        ' * Management:     https://landscape.canonical.com\n * Support:        https://ubuntu.com/pro\n';
    } else {
      let motd = DEBIAN_MOTD;
      try { motd = m.vfs.read('/etc/motd'); } catch (e) { /* the host has no motd of its own */ }
      text = 'Linux ' + m.hostname + ' ' + os.kernel + ' ' + os.kernelBuild + ' ' + os.arch + '\n' + motd;
    }
    const last = m.state.sshLastLogin[user];
    if (last) text += 'Last login: ' + ctime(last.ts) + ' from ' + last.from + '\n';
    m.state.sshLastLogin[user] = { ts: K.clock.now(), from: login.client };
    return text;
  }

  /**
   * A shell on the remote machine for the logged-in account. It is a child of the local
   * shell so the commands it runs count in the local line's trace (lesson checks look there).
   */
  function remoteShell(ctx, login, tty) {
    const acct = login.account; const m = login.machine;
    const clientPort = ephemeralPort();
    const env = {
      SHELL: acct.shell, LANG: ctx.env.LANG || 'en_US.UTF-8',
      PATH: acct.uid === 0 ? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' : '/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games',
      SSH_CLIENT: login.client + ' ' + clientPort + ' ' + login.target.port,
      SSH_CONNECTION: login.client + ' ' + clientPort + ' ' + m.primaryIp() + ' ' + login.target.port,
    };
    if (tty) Object.assign(env, { TERM: ctx.env.TERM || 'xterm-256color', SSH_TTY: '/dev/pts/0' });
    const flavor = /zsh$/.test(acct.shell) ? 'zsh' : /bash$/.test(acct.shell) ? 'bash' : 'sh';
    const sh = ctx.shell.child({ machine: m, user: acct.name, flavor, cwd: acct.home, env, interactive: tty, login: tty });
    const priv = m.spawn({ user: 'root', cmd: 'sshd-session: ' + acct.name + ' [priv]' });
    const conn = m.spawn({ ppid: priv.pid, user: acct.name, cmd: 'sshd-session: ' + acct.name + (tty ? '@pts/0' : '@notty') });
    sh.proc.ppid = conn.pid;
    login.procs.push(priv, conn);
    return sh;
  }

  /**
   * The terminal as the remote login shell sees it. End of input at the shell's own prompt
   * (the read that offers completion) ends the session here, so the caller can print what a
   * login shell prints; reads made by commands running in that shell pass through untouched.
   */
  function sessionTerm(term, sh) {
    return new Proxy(term, {
      get(target, prop) {
        if (prop === 'readLine') {
          return async (o) => {
            const line = await target.readLine(o);
            if (line == null && o && typeof o.complete === 'function') throw new K.ExitSignal(sh.status);
            return line;
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, prop, value) { target[prop] = value; return true; },
    });
  }

  async function interactiveSession(ctx, login) {
    ctx.out(loginBanner(login));
    const sh = remoteShell(ctx, login, true);
    sh.term = sessionTerm(ctx.term, sh);
    let status;
    try { status = await sh.repl(); }
    catch (e) {
      if (!(e instanceof K.ExitSignal)) throw e;
      status = e.code;
    } finally { sh.dispose(); }
    if (sh.flavor === 'bash') ctx.out('logout\n');
    return status;
  }

  /** Run shell source on the remote machine without a terminal, as `ssh host command` does. */
  async function remoteCommand(ctx, login, source, stdin) {
    const sh = remoteShell(ctx, login, false);
    const io = { stdin, out: ctx.out, err: ctx.err, outTTY: false, errTTY: false, sig: ctx.io.sig };
    try { return await sh.execSource(source, io); }
    catch (e) {
      if (e instanceof K.ExitSignal) return e.code;
      throw e;
    } finally { sh.dispose(); }
  }

  /* -------------------------------------------------------------------- ssh */

  const SSH_USAGE = [
    'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address]',
    '           [-c cipher_spec] [-D [bind_address:]port] [-E log_file]',
    '           [-e escape_char] [-F configfile] [-I pkcs11] [-i identity_file]',
    '           [-J destination] [-L address] [-l login_name] [-m mac_spec]',
    '           [-O ctl_cmd] [-o option] [-P tag] [-p port] [-R address]',
    '           [-S ctl_path] [-W host:port] [-w local_tun[:remote_tun]]',
    '           destination [command [argument ...]]',
    '       ssh [-Q query_option]', '',
  ].join('\n');
  // Options the simulator acts on, or that change nothing a learner can see here (compression, X11, agent).
  const SSH_OPTIONS = '4aCkqTtVvxF:i:l:o:p:';

  /** "[user@]host" or "ssh://[user@]host[:port]" -> { user, host, port } */
  function parseDestination(text) {
    const uri = /^ssh:\/\/(?:([^@]*)@)?([^:/]+)(?::(\d+))?\/?$/.exec(text);
    if (uri) return { user: uri[1], host: uri[2], port: uri[3] };
    const at = text.lastIndexOf('@');
    return { user: at >= 0 ? text.slice(0, at) : undefined, host: text.slice(at + 1) };
  }

  K.cmd.register({
    name: 'ssh', pkg: 'openssh-client', section: 1,
    summary: 'OpenSSH remote login client',
    synopsis: 'ssh [-i identity_file] [-l login_name] [-o option] [-p port] destination [command [argument ...]]',
    man: 'DESCRIPTION\n       ssh (SSH client) is a program for logging into a remote machine and for executing commands on a remote machine. It provides encrypted communications between two hosts over an insecure network.\n\n' +
      '       ssh connects and logs into the specified destination, which may be specified as either [user@]hostname or a URI of the form ssh://[user@]hostname[:port]. If a command is specified, it is executed on the remote host instead of a login shell.\n\n' +
      '       The first time you connect to a host, ssh shows the fingerprint of its host key and asks whether to trust it. Accepted keys are stored in ~/.ssh/known_hosts and checked on every later connection.\n\n' +
      'OPTIONS\n       -F configfile\n              Use this per-user configuration file instead of ~/.ssh/config.\n       -i identity_file\n              Read the private key for public key authentication from this file. The default is ~/.ssh/id_rsa, ~/.ssh/id_ecdsa and ~/.ssh/id_ed25519.\n' +
      '       -l login_name\n              Log in as this user on the remote machine.\n       -o option\n              Give an option in the format used in the configuration file, for example -o StrictHostKeyChecking=accept-new.\n' +
      '       -p port\n              Port to connect to on the remote host.\n       -q     Quiet mode. Suppress most warning and diagnostic messages.\n       -T     Disable pseudo-terminal allocation.\n       -t     Force pseudo-terminal allocation.\n' +
      '       -V     Display the version number and exit.\n       -v     Verbose mode. Print debugging messages about the progress of the connection.\n\n' +
      'FILES\n       ~/.ssh/config, ~/.ssh/known_hosts, ~/.ssh/id_ed25519, ~/.ssh/authorized_keys (on the server)\n\n' +
      'EXIT STATUS\n       ssh exits with the exit status of the remote command or with 255 if an error occurred.\n\n' +
      'EXAMPLES\n       ssh student@web01.halcyon.lab\n              Log in to the lab web server.\n       ssh student@db01.halcyon.lab uptime\n              Run one command on db01 and come back.\n       ssh -i ~/.ssh/id_ed25519 -p 22 student@dev01.halcyon.lab\n              Log in with a specific key.',
    async run(ctx) {
      const before = bsdGetopt(ctx.args, SSH_OPTIONS);
      const after = before.err || !before.rest.length ? before : bsdGetopt(before.rest.slice(1), SSH_OPTIONS); // options may follow the destination
      const err = before.err || after.err;
      if (err) { ctx.err(err + '\n' + SSH_USAGE); return 255; }
      const opt = (k) => (after.opts[k] != null ? after.opts[k] : before.opts[k]);
      const every = (k) => (before.all[k] || []).concat(after === before ? [] : after.all[k] || []);
      if (opt('V')) { ctx.err(SSH_VERSION + ', OpenSSL 3.5.4 30 Sep 2025\n'); return 0; }
      if (!before.rest.length) { ctx.err(SSH_USAGE); return 255; }
      const dest = parseDestination(before.rest[0]);
      const port = opt('p') || dest.port;
      if (port != null && !(/^\d+$/.test(port) && +port > 0 && +port < 65536)) { ctx.err("Bad port '" + port + "'\n"); return 255; }
      const cli = cliOptions(every('o'));
      if (cli.err) { ctx.err(cli.err + '\n'); return 255; }
      const command = after.rest.join(' ');
      const login = await sshLogin(ctx, {
        host: dest.host, user: opt('l') || dest.user, port, identities: every('i'), options: cli.conf, configFile: opt('F'), verbose: !!opt('v'),
      });
      if (!login) return 255;
      const closed = () => { if (!opt('q')) ctx.err('Connection to ' + login.target.host + ' closed.\n'); };
      try {
        if (command) {
          const status = await remoteCommand(ctx, login, command, ctx.stdin);
          if (opt('t')) closed();
          return status;
        }
        if (ctx.stdin != null || opt('T')) {
          if (ctx.stdin != null && !opt('T')) ctx.err('Pseudo-terminal will not be allocated because stdin is not a terminal.\n');
          ctx.out(loginBanner(login));
          return await remoteCommand(ctx, login, ctx.stdin || '', '');
        }
        const status = await interactiveSession(ctx, login);
        closed();
        return status;
      } finally { login.close(); }
    },
  });

  K.net.services.register('ssh', {
    greet(s) { return (s.svc.banner || 'SSH-2.0-' + SSH_VERSION) + '\r\n'; },
    data(s) { s.open = false; return 'Invalid SSH identification string.\r\n'; },
  });

  /* ================================================================= netcat */

  const NC_HELP = [
    '[v1.10-50]', 'connect to somewhere:\tnc [-options] hostname port[s] [ports] ... ', 'listen for inbound:\tnc -l -p port [-options] [hostname] [port]', 'options:',
    "\t-c shell commands\tas `-e'; use /bin/sh to exec [dangerous!!]", '\t-e filename\t\tprogram to exec after connect [dangerous!!]', '\t-b\t\t\tallow broadcasts',
    '\t-g gateway\t\tsource-routing hop point[s], up to 8', '\t-G num\t\t\tsource-routing pointer: 4, 8, 12, ...', '\t-h\t\t\tthis cruft',
    '\t-i secs\t\t\tdelay interval for lines sent, ports scanned', '        -k                      set keepalive option on socket', '\t-l\t\t\tlisten mode, for inbound connects',
    '\t-n\t\t\tnumeric-only IP addresses, no DNS', '\t-o file\t\t\thex dump of traffic', '\t-p port\t\t\tlocal port number', '\t-r\t\t\trandomize local and remote ports',
    '\t-q secs\t\t\tquit after EOF on stdin and delay of secs', '\t-s addr\t\t\tlocal source address', '\t-T tos\t\t\tset Type Of Service', '\t-t\t\t\tanswer TELNET negotiation',
    '\t-u\t\t\tUDP mode', '\t-v\t\t\tverbose [use twice to be more verbose]', '\t-w secs\t\t\ttimeout for connects and final net reads', '\t-C\t\t\tSend CRLF as line-ending',
    '\t-z\t\t\tzero-I/O mode [used for scanning]', 'port numbers can be individual or ranges: lo-hi [inclusive];', "hyphens in port names must be backslash escaped (e.g. 'ftp\\-data').", '',
  ].join('\n');
  // Servers drop a client that says nothing; netcat itself would wait for that for ever.
  const SERVER_IDLE = 300000;

  /** h_errno text for a failed lookup. */
  const lookupFailure = (machine, name) => (/^Temporary/.test(resolveFailure(machine, name)) ? 'Host name lookup failure' : 'Unknown host');

  /**
   * netcat's host lookup: { name, ip }, printing its DNS cross-check warnings when verbose.
   * Returns null after the fatal message.
   */
  function ncLookup(nc, text) {
    const ctx = nc.ctx; const m = ctx.machine;
    const warn = (s) => { if (nc.verbose) ctx.err(s + '\n'); };
    const literal = U.isIPv4(text) ? text : /^\d+$/.test(text) ? U.intToIp(+text) : null; // inet_aton takes a bare number too
    if (nc.numeric && !literal) { ctx.err("Can't parse " + text + ' as an IP address\n'); return null; }
    if (literal) {
      const ptr = nc.numeric || !nc.verbose ? null : K.net.reverse(m, literal);
      if (!ptr && !nc.numeric) warn(text + ': inverse host lookup failed: ' + lookupFailure(m, text));
      return { name: ptr || '(UNKNOWN)', ip: literal };
    }
    const res = K.net.resolve(m, text);
    if (!res) { ctx.err(text + ': forward host lookup failed: ' + lookupFailure(m, text) + '\n'); return null; }
    const ptr = nc.verbose ? K.net.reverse(m, res.ip) : res.name;
    if (!ptr) warn('Warning: inverse host lookup failed for ' + res.ip + ': Unknown host');
    else if (ptr.toLowerCase() !== res.name.toLowerCase()) warn('DNS fwd/rev mismatch: ' + res.name + ' != ' + ptr);
    return { name: res.name, ip: res.ip };
  }

  /** Expand port arguments: numbers, service names and lo-hi ranges (walked from the top down). { ports } or { bad }. */
  function ncPorts(nc, args) {
    const proto = nc.udp ? 'udp' : 'tcp'; const number = (t) => portNumber(nc.ctx.machine, nc.numeric && !/^\d+$/.test(t) ? '' : t, proto);
    const ports = [];
    for (const arg of args) {
      const dash = arg.indexOf('-');
      const lo = number(dash > 0 ? arg.slice(0, dash) : arg);
      const hi = dash > 0 ? number(arg.slice(dash + 1)) : lo;
      if (!hi) return { bad: arg.slice(dash + 1) };
      if (!lo) return { bad: dash > 0 ? arg.slice(0, dash) : arg };
      for (let p = Math.max(lo, hi); p >= lo; p--) ports.push(p);
    }
    if (nc.random) for (let i = ports.length - 1; i > 0; i--) { const j = Math.floor(K.net.rand() * (i + 1)); [ports[i], ports[j]] = [ports[j], ports[i]]; }
    return { ports };
  }

  /** Shovel data between our input and the session until one side ends. */
  async function ncRelay(nc, session) {
    const ctx = nc.ctx;
    const show = (text) => { ctx.out(text); nc.rcvd += U.byteLen(text); };
    const next = lineSource(ctx);
    show(session.greeting);
    while (session.open) {
      let line = await next();
      if (line == null) break;
      if (nc.crlf) line = line.replace(/\r?\n$/, '\r\n');
      if (nc.interval) await ctx.sleep(nc.interval * 1000);
      nc.sent += U.byteLen(line);
      const reply = session.send(line);
      await ctx.sleep(session.rtt);
      show(reply);
    }
    // After local end of input netcat keeps reading until the peer hangs up or -q / -w runs out.
    if (session.open) await ctx.sleep(nc.quit != null ? nc.quit * 1000 : nc.wait != null ? nc.wait * 1000 : SERVER_IDLE);
  }

  /** Client mode: try each port in turn; returns the exit status (that of the last port). */
  async function ncConnect(nc, target, ports) {
    const ctx = nc.ctx; const proto = nc.udp ? 'udp' : 'tcp';
    const single = ports.length === 1;
    let status = 1;
    for (const port of ports) {
      const label = target.name + ' [' + target.ip + '] ' + port + ' (' + ((!nc.numeric && serviceName(ctx.machine, port, proto)) || '?') + ')';
      let session = null; let failure = null;
      try {
        if (!nc.udp) session = await dial(ctx, target.ip, port, nc.wait == null ? null : nc.wait * 1000, nc.zero);
        else if (K.net.udp(ctx.machine, target.ip, port).state === 'closed') failure = 'Connection refused';
      } catch (e) {
        if (!(e instanceof K.NetError)) throw e;
        failure = e.message;
      }
      status = failure ? 1 : 0;
      // At one -v a scan of several ports keeps quiet about the closed ones.
      if (failure && (single || nc.verbose > 1 || failure !== 'Connection refused')) nc.holler(label + ' : ' + failure);
      if (!failure) nc.holler(label + ' open');
      if (session) {
        try { await ncRelay(nc, session); } finally { session.close(); }
      } else if (!failure && nc.udp && !nc.zero) {
        // UDP has no session to read from: datagrams go out and nothing in the lab answers them.
        for (let line = await ctx.readLine(''); line != null; line = await ctx.readLine('')) { nc.sent += U.byteLen(line) + 1; K.net.udp(ctx.machine, target.ip, port); }
      }
      if (nc.interval && !single) await ctx.sleep(nc.interval * 1000);
    }
    return status;
  }

  /** Listen mode: take one inbound connection, show what it sends, hand it our piped input. */
  async function ncListen(nc, allowed) {
    const ctx = nc.ctx; const m = ctx.machine; const proto = nc.udp ? 'udp' : 'tcp';
    const port = nc.localPort || ephemeralPort();
    const taken = K.net.listening(m).some((l) => l.port === port && (l.proto || 'tcp') === proto);
    if (taken || (port < 1024 && !ctx.isRoot)) { ctx.err("Can't grab 0.0.0.0:" + port + ' with bind : ' + (taken ? 'Address already in use' : 'Permission denied') + '\n'); return 1; }
    let peer = null; let refused = false;
    const handlerObj = {
      greet(session) {
        if (peer) { session.open = false; return ''; }
        peer = session;
        const from = (nc.numeric ? null : K.net.reverse(m, session.client)) || '(UNKNOWN)';
        const where = '[' + session.ip + '] from ' + from + ' [' + session.client + '] ' + ephemeralPort();
        refused = !!allowed && allowed.ip !== session.client;
        nc.holler((refused ? 'invalid connection to ' : 'connect to ') + where);
        if (refused) session.open = false;
        return refused || ctx.stdin == null ? '' : ctx.stdin;
      },
      data(session, input) { ctx.out(input); nc.rcvd += U.byteLen(input); return ''; },
    };
    const stop = openListener(m, { port, proto, addr: '0.0.0.0', prog: 'nc', pid: ctx.pid, handlerObj });
    nc.holler('listening on [any] ' + port + ' ...');
    try {
      for (let waited = 0; !peer || peer.open; waited += 200) {
        if (!peer && nc.wait != null && waited >= nc.wait * 1000) { ctx.err('no connection : Connection timed out\n'); return 1; }
        await ctx.sleep(200);
      }
    } finally { stop(); }
    return refused ? 1 : 0;
  }

  K.cmd.register({
    name: 'nc', aliases: ['netcat', 'ncat', 'nc.traditional'], pkg: 'netcat-traditional', section: 1,
    summary: 'TCP/IP swiss army knife',
    synopsis: 'nc [-options] hostname port[s] [ports] ...\n       nc -l -p port [-options] [hostname] [port]',
    man: 'DESCRIPTION\n       netcat is a simple unix utility which reads and writes data across network connections, using TCP or UDP protocol. In the simplest usage, "nc host port" creates a TCP connection to the given port on the given target host. Your standard input is then sent to the host, and anything that comes back across the connection is sent to your standard output. This continues until the network side of the connection shuts down.\n\n' +
      '       netcat can also function as a server, by listening for inbound connections on arbitrary ports and then doing the same reading and writing.\n\n' +
      'OPTIONS\n       -C     Send CRLF as line-ending\n       -h     display help\n       -i secs\n              delay interval for lines sent, ports scanned\n       -l     listen mode, for inbound connects\n       -n     numeric-only IP addresses, no DNS\n' +
      '       -p port\n              local port number (port numbers can be individual or ranges: lo-hi [inclusive])\n       -q seconds\n              after EOF on stdin, wait the specified number of seconds and then quit\n       -r     randomize local and remote ports\n' +
      '       -u     UDP mode\n       -v     verbose [use twice to be more verbose]\n       -w secs\n              timeout for connects and final net reads\n       -z     zero-I/O mode [used for scanning]\n\n' +
      'NOTES\n       Checking ports with -z is active probing: the simulator only allows it against targets inside the engagement scope. Kali ships the traditional netcat; a listener needs both -l and -p.\n\n' +
      'EXAMPLES\n       nc -v web01.halcyon.lab 22\n              Connect to the SSH port and read its banner.\n       nc -zv files01.halcyon.lab 20-25\n              Check which ports in a range accept connections.\n       nc -lvnp 4444\n              Wait for one inbound connection on port 4444 and print what it sends.',
    async run(ctx) {
      let args = ctx.args;
      if (!args.length) args = ((await ctx.readLine('Cmd line: ')) || '').trim().split(/\s+/).filter(Boolean);
      const g = K.getopt(args, { short: 'Chklnruvzi:p:q:w:' });
      const bail = (msg) => { ctx.err(msg + '\n'); return 1; };
      if (g.err) return bail(ctx.name + ': ' + g.err + '\nnc -h for help');
      const o = g.opts;
      if (o.h) { ctx.err(NC_HELP); return 1; }
      const seconds = (v) => (v == null ? null : parseInt(v, 10) || 0);
      const nc = {
        ctx, verbose: g.count.v || 0, numeric: !!o.n, udp: !!o.u, zero: !!o.z, crlf: !!o.C, random: !!o.r,
        wait: seconds(o.w), quit: seconds(o.q), interval: seconds(o.i), sent: 0, rcvd: 0,
        holler: (s) => { if (nc.verbose) ctx.err(s + '\n'); },
      };
      if (o.w != null && nc.wait <= 0) return bail('invalid wait-time ' + o.w);
      if (o.i != null && nc.interval <= 0) return bail('invalid interval time ' + o.i);
      if (o.p != null && !(nc.localPort = portNumber(ctx.machine, o.p, nc.udp ? 'udp' : 'tcp'))) return bail('invalid local port ' + o.p);
      const target = g.rest.length ? ncLookup(nc, g.rest[0]) : null;
      if (g.rest.length && !target) return 1;
      let status;
      if (o.l) status = await ncListen(nc, target);
      else {
        if (!target) return bail('no destination');
        if (g.rest.length < 2) return bail('no port[s] to connect to');
        const list = ncPorts(nc, g.rest.slice(1));
        if (list.bad != null) return bail('invalid port ' + list.bad);
        if (nc.zero && !K.net.guard(ctx, target.ip, ctx.name)) return 1;
        status = await ncConnect(nc, target, list.ports);
      }
      if (nc.verbose > 1) ctx.err(' sent ' + nc.sent + ', rcvd ' + nc.rcvd + '\n');
      return status;
    },
  });

  /* ================================================================= telnet */

  const TELNET_HELP = [
    'Usage: telnet [OPTION...] [HOST [PORT]]', 'Login to remote system HOST (optionally, on service port PORT)', '', ' General options:', '',
    '  -4, --ipv4                 use only IPv4', '  -6, --ipv6                 use only IPv6', '  -8, --binary               use an 8-bit data transmission',
    '  -a, --login                attempt automatic login', '  -b, --bind=ADDRESS         bind to specific local ADDRESS', "  -c, --no-rc                do not read the user's .telnetrc file",
    '  -d, --debug                turn on debugging', '  -e, --escape=CHAR          use CHAR as an escape character', '  -E, --no-escape            use no escape character',
    '  -K, --no-login             do not automatically login to the remote system', '  -l, --user=USER            attempt automatic login as USER',
    '  -L, --binary-output        use an 8-bit data transmission for output only', '  -n, --trace=FILE           record trace information into FILE',
    '  -r, --rlogin               use a user-interface similar to rlogin', '', ' Encryption control:', '', '  -x, --encrypt              encrypt the data stream, if possible', '',
    ' Authentication and Kerberos options:', '', '  -k, --realm=REALM          obtain tickets for the given REALM instead of the', "                             remote host's realm",
    '  -X, --disable-auth=ATYPE   disable type ATYPE authentication', '', '  -?, --help                 give this help list', '      --usage                give a short usage message',
    '  -V, --version              print program version', '', 'Mandatory or optional arguments to long options are also mandatory or optional', 'for any corresponding short options.', '',
    'Report bugs to <bug-inetutils@gnu.org>.', '',
  ].join('\n');
  const TELNET_USAGE = [
    'Usage: telnet [-468acdEKLrx?V] [-b ADDRESS] [-e CHAR] [-k REALM] [-l USER]', '            [-n FILE] [-X ATYPE] [--ipv4] [--ipv6] [--binary] [--login]',
    '            [--bind=ADDRESS] [--no-rc] [--debug] [--escape=CHAR] [--no-escape]', '            [--realm=REALM] [--no-login] [--user=USER] [--binary-output]',
    '            [--trace=FILE] [--rlogin] [--encrypt] [--disable-auth=ATYPE]', '            [--help] [--usage] [--version] [HOST [PORT]]', '',
  ].join('\n');
  const TELNET_VERSION = 'telnet (GNU inetutils) 2.6\nCopyright (C) 2025 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\n' +
    'This is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by many authors.\n';

  /** The "telnet> " prompt reached with the escape character. Resolves true when the user quits. */
  async function telnetEscape(ctx) {
    for (;;) {
      const line = await ctx.readLine('telnet> ');
      const word = (line || '').trim().split(/\s+/)[0];
      if (line == null || /^(q|qu|qui|quit|c|cl|clo|clos|close)$/.test(word)) return true;
      if (!word) return false;
      ctx.out('?Invalid command\n');
    }
  }

  /** Connect and run a line-at-a-time session. Returns the exit status. */
  async function telnetOpen(ctx, host, portText) {
    const res = K.net.resolve(ctx.machine, host);
    const port = portNumber(ctx.machine, portText || 'telnet', 'tcp');
    if (!res || !port) {
      ctx.err('telnet: could not resolve ' + host + '/' + (portText || 'telnet') + ': ' + (res ? 'Servname not supported for ai_socktype' : resolveFailure(ctx.machine, host)) + '\n');
      return 1;
    }
    await ctx.sleep(res.ms);
    ctx.out('Trying ' + res.ip + '...\n');
    let session;
    try { session = await dial(ctx, res.ip, port); }
    catch (e) {
      if (!(e instanceof K.NetError)) throw e;
      ctx.err('telnet: Unable to connect to remote host: ' + e.message + '\n');
      return 1;
    }
    ctx.out('Connected to ' + host + ".\nEscape character is '^]'.\n" + session.greeting);
    const next = lineSource(ctx);
    try {
      while (session.open) {
        const line = await next();
        if (line == null) break;
        if (line.trim() === '^]') {
          if (await telnetEscape(ctx)) { ctx.out('Connection closed.\n'); return 0; }
          continue;
        }
        const reply = session.send(line.replace(/\r?\n$/, '\r\n'));
        await ctx.sleep(session.rtt);
        ctx.out(reply);
      }
    } finally { session.close(); }
    ctx.err('Connection closed by foreign host.\n');
    return 1;
  }

  K.cmd.register({
    name: 'telnet', pkg: 'inetutils-telnet', section: 1,
    summary: 'user interface to the TELNET protocol',
    synopsis: 'telnet [OPTION...] [HOST [PORT]]',
    man: 'DESCRIPTION\n       Login to remote system HOST (optionally, on service port PORT). telnet also makes a handy plain TCP client: every line you type is sent to the service, followed by CR LF, and whatever the service answers is printed.\n\n' +
      '       Nothing in a TELNET session is encrypted. Use ssh for real remote logins.\n\n' +
      'OPTIONS\n       -4, --ipv4\n              use only IPv4\n       -?, --help\n              give this help list\n       --usage\n              give a short usage message\n       -V, --version\n              print program version\n\n' +
      "COMMANDS\n       Type the escape character ^] on a line of its own to reach the telnet> prompt; quit or close ends the session there.\n\n" +
      'EXAMPLES\n       telnet cam01.halcyon.lab\n              Connect to the camera\'s TELNET service.\n       telnet mail01.halcyon.lab 25\n              Talk to the mail server by hand: try HELO kali, then QUIT.',
    async run(ctx) {
      const g = K.getopt(ctx.args, { short: '4V?', long: ['ipv4', 'help', 'usage', 'version'], alias: { ipv4: '4', help: '?', version: 'V' } });
      if (g.err) { ctx.err('telnet: ' + g.err + "\nTry 'telnet --help' or 'telnet --usage' for more information.\n"); return 64; }
      if (g.opts['?']) { ctx.out(TELNET_HELP); return 0; }
      if (g.opts.usage) { ctx.out(TELNET_USAGE); return 0; }
      if (g.opts.V) { ctx.out(TELNET_VERSION); return 0; }
      if (g.rest.length) return telnetOpen(ctx, g.rest[0], g.rest[1]);
      for (;;) {
        const line = await ctx.readLine('telnet> ');
        const words = (line || '').trim().split(/\s+/).filter(Boolean);
        if (line == null || /^(q|qu|qui|quit)$/.test(words[0] || '')) return 0;
        if (/^(o|op|ope|open)$/.test(words[0] || '') && words[1]) return telnetOpen(ctx, words[1], words[2]);
        if (words.length) ctx.out(/^o/.test(words[0]) ? 'usage: open [-l user] [-a] host-name [port]\n' : '?Invalid command\n');
      }
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
