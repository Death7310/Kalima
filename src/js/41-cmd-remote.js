/* Kalima — remote login, file transfer and plain TCP clients.
 *
 *   remote login        ssh ssh-keygen ssh-copy-id
 *   file transfer       scp ftp
 *   plain TCP clients   nc (netcat, ncat) telnet
 *   protocol handlers   ssh ftp smtp pop3 (what a connection to those ports answers,
 *                       whether it comes from a client here or is typed by hand into nc)
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
    return { label: KEY_LABEL.ecdsa, bits: +/\d+$/.exec(key.type)[0] };
  }

  const DIGEST_SIZE = { md5: 16, sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
  /** Digest-like bytes for a key blob, as many as the named hash would give. Stable, but not a real hash. */
  const digestBytes = (blob, alg) => noiseBytes(U.prng('fingerprint:' + (alg === 'sha256' ? '' : alg + ':') + blob), DIGEST_SIZE[alg]);
  /** A fingerprint in ssh-keygen's notation: "SHA256:" and unpadded base64, or "MD5:" and colon-separated hex. */
  function fingerprint(blob, alg) {
    alg = alg || 'sha256';
    const bytes = digestBytes(blob, alg);
    if (alg === 'md5') return 'MD5:' + bytes.map((b) => b.toString(16).padStart(2, '0')).join(':');
    return alg.toUpperCase() + ':' + b64enc(bytes).replace(/=+$/, '');
  }

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

  /** Has -q or a LogLevel below INFO silenced ssh's warnings and its closing line? */
  const sshQuiet = (conf) => /^(quiet|fatal|error)$/i.test(conf.loglevel || '');

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
      if (!sshQuiet(conf)) say("Warning: Permanently added '" + name + "' (ED25519) to the list of known hosts.");
    } catch (e) {
      say('Failed to add the host to the list of known hosts (' + file + ').');
    }
    return true;
  }

  /* ============================================================== ssh login */

  const DEFAULT_IDENTITIES = ['id_rsa', 'id_ecdsa', 'id_ed25519'];
  const SSH_KEYWORDS = ['hostname', 'user', 'port', 'identityfile', 'stricthostkeychecking', 'userknownhostsfile', 'hashknownhosts',
    'batchmode', 'connecttimeout', 'numberofpasswordprompts', 'preferredauthentications', 'pubkeyauthentication', 'passwordauthentication', 'loglevel'];
  // Real keywords that change nothing a learner can see here; they are accepted and otherwise ignored.
  const SSH_KEYWORDS_IGNORED = ['addkeystoagent', 'addressfamily', 'checkhostip', 'ciphers', 'compression', 'connectionattempts', 'controlmaster', 'controlpath', 'controlpersist',
    'escapechar', 'forwardagent', 'forwardx11', 'globalknownhostsfile', 'gssapiauthentication', 'hostbasedauthentication', 'hostkeyalgorithms', 'hostkeyalias', 'identitiesonly',
    'kbdinteractiveauthentication', 'kexalgorithms', 'macs', 'pubkeyacceptedalgorithms', 'requesttty', 'sendenv', 'serveralivecountmax', 'serveraliveinterval', 'setenv',
    'tcpkeepalive', 'updatehostkeys', 'verifyhostkeydns', 'visualhostkey'];

  /** "-o Keyword=value" arguments as a lower-cased map: { conf } or { err } for a keyword ssh does not have. */
  function cliOptions(list) {
    const conf = {};
    for (const item of list) {
      const m = /^\s*([A-Za-z]+)\s*[=\s]\s*(.*?)\s*$/.exec(item);
      const key = m ? m[1].toLowerCase() : item;
      if (!m || !SSH_KEYWORDS.concat(SSH_KEYWORDS_IGNORED).includes(key)) return { err: 'command-line: line 0: Bad configuration option: ' + key };
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
   * spec: see sshTarget, plus { verbose, beforeAuth(machine, account) } - beforeAuth runs once the server is
   * trusted and may return false to hang up. Returns the login { target, ip, rtt, machine, account, close() },
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
    if (spec.beforeAuth && !spec.beforeAuth(side.machine, account)) { session.close(); return null; }
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
      target, ip: res.ip, client: session.client, rtt: session.rtt, machine: side.machine, account, procs: [],
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
      if (opt('q')) cli.conf.loglevel = 'QUIET';
      const command = after.rest.join(' ');
      const login = await sshLogin(ctx, {
        host: dest.host, user: opt('l') || dest.user, port, identities: every('i'), options: cli.conf, configFile: opt('F'), verbose: !!opt('v'),
      });
      if (!login) return 255;
      const closed = () => { if (!sshQuiet(login.target.conf)) ctx.err('Connection to ' + login.target.host + ' closed.\n'); };
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

  /* ============================================================= ssh-keygen */

  const KEYGEN_USAGE = [
    'usage: ssh-keygen [-q] [-a rounds] [-b bits] [-C comment] [-f output_keyfile]',
    '                  [-m format] [-N new_passphrase] [-O option]',
    '                  [-t ecdsa | ecdsa-sk | ed25519 | ed25519-sk | rsa]',
    '                  [-w provider] [-Z cipher]',
    '       ssh-keygen -p [-a rounds] [-f keyfile] [-m format] [-N new_passphrase]',
    '                   [-P old_passphrase] [-Z cipher]',
    '       ssh-keygen -i [-f input_keyfile] [-m key_format]',
    '       ssh-keygen -e [-f input_keyfile] [-m key_format]',
    '       ssh-keygen -y [-f input_keyfile]',
    '       ssh-keygen -c [-a rounds] [-C comment] [-f keyfile] [-P passphrase]',
    '       ssh-keygen -l [-v] [-E fingerprint_hash] [-f input_keyfile]',
    '       ssh-keygen -B [-f input_keyfile]',
    '       ssh-keygen -D pkcs11',
    '       ssh-keygen -F hostname [-lv] [-f known_hosts_file]',
    '       ssh-keygen -H [-f known_hosts_file]',
    '       ssh-keygen -K [-a rounds] [-w provider]',
    '       ssh-keygen -R hostname [-f known_hosts_file]',
    '       ssh-keygen -r hostname [-g] [-f input_keyfile]',
    '       ssh-keygen -M generate [-O option] output_file',
    '       ssh-keygen -M screen [-f input_file] [-O option] output_file',
    '       ssh-keygen -I certificate_identity -s ca_key [-hU] [-D pkcs11_provider]',
    '                  [-n principals] [-O option] [-V validity_interval]',
    '                  [-z serial_number] file ...',
    '       ssh-keygen -L [-f input_keyfile]',
    '       ssh-keygen -A [-a rounds] [-f prefix_path]',
    '       ssh-keygen -k -f krl_file [-u] [-s ca_public] [-z version_number]',
    '                  file ...',
    '       ssh-keygen -Q [-l] -f krl_file [file ...]',
    '       ssh-keygen -Y find-principals -s signature_file -f allowed_signers_file',
    '       ssh-keygen -Y match-principals -I signer_identity -f allowed_signers_file',
    '       ssh-keygen -Y check-novalidate -n namespace -s signature_file',
    '       ssh-keygen -Y sign -f key_file -n namespace file [-O option] ...',
    '       ssh-keygen -Y verify -f allowed_signers_file -I signer_identity',
    '                  -n namespace -s signature_file [-r krl_file] [-O option]', '',
  ].join('\n');
  const RSA_BITS = { min: 1024, standard: 3072, max: 16384 };
  const ECDSA_BITS = [256, 384, 521];

  /** OpenSSH's fatal(): the message alone on stderr, exit status 255. */
  function fatal(ctx, msg) { ctx.err(msg + '\n'); return 255; }

  /** Prompt on stdout and read the answer from stdin, as programs built on printf and fgets do. */
  async function ask(ctx, prompt) {
    if (ctx.stdin == null) return ctx.readLine(prompt);
    ctx.out(prompt);
    return ctx.readLine('');
  }

  /** The "drunken bishop" picture OpenSSH draws from the bytes of a fingerprint. */
  function randomart(key, alg) {
    const W = 17; const H = 9; const symbols = ' .o+=*BOX@%&#/^SE'; const top = symbols.length - 1;
    const field = Array.from({ length: H }, () => new Array(W).fill(0));
    let x = W >> 1; let y = H >> 1;
    for (let byte of digestBytes(key.blob, alg)) {
      for (let step = 0; step < 4; step++, byte >>= 2) {
        x = Math.min(W - 1, Math.max(0, x + (byte & 1 ? 1 : -1)));
        y = Math.min(H - 1, Math.max(0, y + (byte & 2 ? 1 : -1)));
        if (field[y][x] < top - 2) field[y][x]++;
      }
    }
    field[H >> 1][W >> 1] = top - 1;
    field[y][x] = top;
    const border = (label) => { const left = (W - label.length) >> 1; return '+' + '-'.repeat(left) + label + '-'.repeat(W - left - label.length) + '+\n'; };
    const info = keyInfo(key);
    return border('[' + info.label + ' ' + info.bits + ']') + field.map((row) => '|' + row.map((v) => symbols[v]).join('') + '|\n').join('') + border('[' + alg.toUpperCase() + ']');
  }

  /** The size a new key gets: { bits } or { err } with ssh-keygen's complaint about -b. */
  function keygenBits(kind, text) {
    if (text != null && !/^\d+$/.test(text)) return { err: 'Bits has bad value ' + text + ' (invalid)' };
    if (text != null && +text === 0) return { err: 'Bits has bad value ' + text + ' (too small)' };
    if (kind === 'ed25519') return { bits: 256 };
    if (kind === 'ecdsa') {
      const bits = text == null ? ECDSA_BITS[0] : +text;
      return ECDSA_BITS.includes(bits) ? { bits } : { err: 'Invalid ECDSA key length: valid lengths are 256, 384 or 521 bits' };
    }
    const bits = text == null ? RSA_BITS.standard : +text;
    if (bits < RSA_BITS.min) return { err: 'Invalid RSA key length: minimum is ' + RSA_BITS.min + ' bits' };
    return bits > RSA_BITS.max ? { err: 'Invalid RSA key length: maximum is ' + RSA_BITS.max + ' bits' } : { bits };
  }

  /** A new passphrase, typed twice until both entries agree. */
  async function newPassphrase(ctx, file) {
    for (;;) {
      const first = await ctx.term.readLine({ prompt: 'Enter passphrase for "' + file + '" (empty for no passphrase): ', hidden: true });
      const second = await ctx.term.readLine({ prompt: 'Enter same passphrase again: ', hidden: true });
      if ((first || '') === (second || '')) return first || '';
      ctx.out('Passphrases do not match.  Try again.\n');
    }
  }

  /** ssh-keygen with no mode option: make a key pair and save both halves. */
  async function keygenGenerate(ctx, o, alg) {
    const say = (s) => { if (!o.q) ctx.out(s + '\n'); };
    const kind = String(o.t || 'ed25519').toLowerCase();
    if (!KEY_LABEL[kind]) return fatal(ctx, 'unknown key type ' + o.t);
    const size = keygenBits(kind, o.b);
    if (size.err) return fatal(ctx, size.err);
    say('Generating public/private ' + kind + ' key pair.');
    if (kind === 'rsa') await ctx.sleep(K.net.jitter(size.bits * size.bits / 9000, size.bits / 8));

    const sshDir = ctx.user.home + '/.ssh';
    let file = o.f;
    if (file == null) {
      const standard = sshDir + '/id_' + kind;
      const typed = await ask(ctx, 'Enter file in which to save the key (' + standard + '): ');
      if (typed == null) return 1;
      file = typed.trim() || standard;
    }
    if (K.VFS.dirname(ctx.path(file)) === sshDir && !ctx.fs.exists(sshDir)) {
      try { ctx.fs.mkdir(sshDir, { mode: 0o700 }); ctx.err("Created directory '" + sshDir + "'.\n"); }
      catch (e) { ctx.err("Could not create directory '" + sshDir + "' (" + e.message + ').\n'); }
    }
    if (ctx.fs.exists(file)) {
      ctx.out(file + ' already exists.\n');
      const answer = await ask(ctx, 'Overwrite (y/n)? ');
      if (!/^y/i.test(answer || '')) return 1;
    }
    const passphrase = o.N != null ? o.N : await newPassphrase(ctx, file);
    const seed = K.clock.now() + ':' + K.net.rand();
    const key = { type: keyTypeName(kind, size.bits), blob: makeBlob(kind, size.bits, seed), comment: o.C != null ? o.C : ctx.user.name + '@' + ctx.machine.hostname };
    try {
      if (ctx.fs.exists(file)) ctx.fs.unlink(file);
      ctx.fs.write(file, makePrivateFile(key, passphrase, seed), { mode: 0o600 });
    } catch (e) { return fatal(ctx, 'Saving key "' + file + '" failed: ' + e.message); }
    say('Your identification has been saved in ' + file);
    try { ctx.fs.write(file + '.pub', key.type + ' ' + key.blob + ' ' + key.comment + '\n', { mode: 0o644 }); }
    catch (e) { return fatal(ctx, 'Unable to save public key to ' + file + '.pub: ' + e.message); }
    say('Your public key has been saved in ' + file + '.pub');
    say('The key fingerprint is:\n' + fingerprint(key.blob, alg) + ' ' + key.comment);
    say("The key's randomart image is:\n" + randomart(key, alg).trimEnd());
    return 0;
  }

  /** The file a mode option works on: -f, or the answer to ssh-keygen's question. null at end of input. */
  async function keygenInput(ctx, o) {
    if (o.f != null) return o.f;
    const standard = ctx.user.home + '/.ssh/id_ed25519';
    const typed = await ask(ctx, 'Enter file in which the key is (' + standard + '): ');
    return typed == null ? null : typed.trim() || standard;
  }

  /** ssh-keygen -l: fingerprints of a private key, a public key, or every key in an authorized_keys or known_hosts file. */
  function keygenFingerprints(ctx, o, alg, path) {
    let text;
    try { text = ctx.fs.read(path); } catch (e) { return fatal(ctx, 'ssh-keygen: ' + path + ': ' + e.message); }
    const show = (key, comment) => {
      const info = keyInfo(key);
      ctx.out(info.bits + ' ' + fingerprint(key.blob, alg) + ' ' + (comment || 'no comment') + ' (' + info.label + ')\n');
      if (o.v) ctx.out(randomart(key, alg));
    };
    if (/PRIVATE KEY/.test(text.split('\n')[0])) {
      // The public half next to a private key carries the comment even when the private key is locked.
      let beside = null;
      try { beside = parsePublicLine(ctx.fs.read(path + '.pub')); } catch (e) { /* no public half */ }
      const inside = parsePrivateFile(text);
      if (!beside && !inside) return fatal(ctx, path + ' is not a key file.');
      show(beside || inside, (beside && beside.comment) || (inside && inside.comment));
      return 0;
    }
    let found = false;
    for (const line of text.split('\n')) {
      const key = /^\s*(#|$)/.test(line) ? null : parsePublicLine(line);
      if (!key) continue;
      const lead = line.trim().split(/\s+/)[0]; // a host name or key options in front of the key
      show(key, key.comment || (lead === key.type ? '' : lead));
      found = true;
    }
    return found ? 0 : fatal(ctx, path + ' is not a public key file.');
  }

  /** ssh-keygen -y: the public half of a private key file. */
  async function keygenPublic(ctx, path) {
    if (!ctx.fs.exists(path)) return fatal(ctx, path + ': No such file or directory');
    const key = loadIdentity(ctx, path);
    if (!key) return 255;
    if (key.locked) {
      const typed = await ctx.term.readLine({ prompt: 'Enter passphrase for "' + path + '": ', hidden: true });
      if (passphraseCheck(key.salt, typed || '') !== key.check) return fatal(ctx, 'Load key "' + path + '": incorrect passphrase supplied to decrypt private key');
    }
    ctx.out(key.type + ' ' + key.blob + (key.comment ? ' ' + key.comment : '') + '\n');
    return 0;
  }

  /** ssh-keygen -R: drop every known_hosts line for a host, keeping the old file beside the new one. */
  function keygenRemoveHost(ctx, o, name) {
    const file = o.f != null ? o.f : ctx.user.home + '/.ssh/known_hosts';
    let text;
    try { text = ctx.fs.read(file); } catch (e) { return fatal(ctx, 'Cannot stat ' + file + ': ' + e.message); }
    const gone = readKnownHosts(ctx.fs, file).filter((entry) => knownAs(entry, name)).map((entry) => entry.n);
    if (!gone.length) { ctx.err('Host ' + name + ' not found in ' + file + '\n'); return 0; }
    if (!o.q) for (const n of gone) ctx.out('# Host ' + name + ' found: line ' + n + '\n');
    try {
      ctx.fs.write(file + '.old', text, { mode: 0o600 });
      ctx.fs.write(file, text.split('\n').filter((line, i) => !gone.includes(i + 1)).join('\n'), { mode: 0o600 });
    } catch (e) { return fatal(ctx, file + ': ' + e.message); }
    if (!o.q) ctx.out(file + ' updated.\nOriginal contents retained as ' + file + '.old\n');
    return 0;
  }

  K.cmd.register({
    name: 'ssh-keygen', pkg: 'openssh-client', section: 1,
    summary: 'OpenSSH authentication key utility',
    synopsis: 'ssh-keygen [-q] [-b bits] [-C comment] [-f output_keyfile] [-N new_passphrase] [-t ecdsa | ed25519 | rsa]\n       ssh-keygen -y [-f input_keyfile]\n       ssh-keygen -l [-v] [-E fingerprint_hash] [-f input_keyfile]\n       ssh-keygen -R hostname [-f known_hosts_file]',
    man: 'DESCRIPTION\n       ssh-keygen generates, manages and converts authentication keys for ssh(1). With no mode option it creates a key pair: the private key stays in the file you name (by default ~/.ssh/id_ed25519) and the public key is written next to it with the extension .pub. The public key is the half you hand out, for example with ssh-copy-id(1).\n\n' +
      '       A passphrase protects the private key file; an empty passphrase leaves it unprotected. In this simulator the key files use the real OpenSSH layouts, but the key material is placeholder data marked KALIMA+SIMULATED+KEY and the fingerprints are stand-ins, so nothing here works against a real server.\n\n' +
      'OPTIONS\n       -b bits\n              Number of bits in the key. RSA keys are 3072 bits by default (minimum 1024). ECDSA accepts 256, 384 or 521. Ed25519 keys have a fixed length and ignore -b.\n       -C comment\n              Provides a new comment. The default is user@host.\n' +
      '       -E fingerprint_hash\n              Hash algorithm used when displaying key fingerprints: md5 or sha256 (the default).\n       -f filename\n              Filename of the key file.\n       -l     Show the fingerprint of a public or private key file. Every key in an authorized_keys or known_hosts file is listed. With -v the randomart image is shown as well.\n' +
      '       -N new_passphrase\n              Provides the new passphrase, so nothing is asked.\n       -q     Silence ssh-keygen.\n       -R hostname\n              Removes all keys belonging to hostname from a known_hosts file.\n' +
      '       -t ecdsa | ed25519 | rsa\n              Type of key to create. The default is ed25519.\n       -y     Read a private key file and print the public key to stdout.\n\n' +
      "EXAMPLES\n       ssh-keygen\n              Create an Ed25519 key pair, answering the questions about the file and the passphrase.\n       ssh-keygen -t rsa -b 4096 -f ~/.ssh/lab_rsa -N '' -C 'kali@lab'\n              Create an RSA key without any questions.\n       ssh-keygen -lv -f ~/.ssh/id_ed25519.pub\n              Show a key's fingerprint and randomart image.\n       ssh-keygen -R web01.halcyon.lab\n              Forget the stored host key of web01.",
    async run(ctx) {
      const g = bsdGetopt(ctx.args, 'loqvya:b:C:E:f:N:R:t:'); // -a (KDF rounds) and -o (new format, long the default) change nothing here
      if (g.err || g.rest.length) { ctx.err((g.err || 'Too many arguments.') + '\n' + KEYGEN_USAGE); return 1; }
      const o = g.opts;
      const alg = String(o.E || 'sha256').toLowerCase();
      if (!DIGEST_SIZE[alg]) return fatal(ctx, 'Invalid hash algorithm "' + o.E + '"');
      if (o.R != null) return keygenRemoveHost(ctx, o, o.R);
      if (!o.l && !o.y) return keygenGenerate(ctx, o, alg);
      const path = await keygenInput(ctx, o);
      if (path == null) return 1;
      return o.l ? keygenFingerprints(ctx, o, alg, path) : keygenPublic(ctx, path);
    },
  });

  /* ==================================================================== scp */

  const SCP_USAGE = 'usage: scp [-346ABCOpqRrsTv] [-c cipher] [-D sftp_server_path] [-F ssh_config]\n' +
    '           [-i identity_file] [-J destination] [-l limit] [-o ssh_option]\n           [-P port] [-S program] [-X sftp_option] source ... target\n';
  // Bytes per millisecond on the lab's switch once a transfer is under way.
  const LAN_THROUGHPUT = 60000;
  const SIZE_UNITS = ' KMGT';

  /** progressmeter.c's format_size: four digits and a unit. */
  function meterSize(bytes) {
    let i = 0;
    for (; bytes >= 10000 && SIZE_UNITS[i] !== 'T'; i++) bytes = Math.floor((bytes + 512) / 1024);
    return String(bytes).padStart(4) + SIZE_UNITS[i] + (i ? 'B' : ' ');
  }
  /** progressmeter.c's format_rate: one decimal, never less than kilobytes. */
  function meterRate(bytesPerSecond) {
    let n = Math.floor(bytesPerSecond) * 100; let i = 0;
    for (; n >= 100000 && SIZE_UNITS[i] !== 'T'; i++) n = Math.floor((n + 512) / 1024);
    if (i === 0) { i = 1; n = Math.floor((n + 512) / 1024); }
    return String(Math.floor((n + 5) / 100)).padStart(3) + '.' + (Math.floor((n + 5) / 10) % 10) + SIZE_UNITS[i] + 'B';
  }
  /** The line scp leaves behind for a finished file. */
  function meterLine(name, bytes, ms, cols) {
    const width = Math.max(0, cols - 36);
    const seconds = Math.floor(ms / 1000);
    const line = U.padEnd(name.slice(0, width), width) + ' 100% ' + meterSize(bytes) + ' ' + meterRate(bytes / (ms / 1000)) + '/s   ' +
      U.pad2(Math.floor(seconds / 60)) + ':' + U.pad2(seconds % 60) + '    ';
    return '\r' + line.slice(0, cols - 1) + '\n';
  }

  /** "[user@]host:path" -> { user, host, path }; null for a local name (a colon after a slash belongs to the file name). */
  function parseRemoteSpec(arg) {
    const m = /^(?:([^@/:]+)@)?([^@/:]+):(.*)$/.exec(arg);
    return m ? { user: m[1], host: m[2], path: m[3] } : null;
  }

  /** The remote account's view of its machine's files, starting in its home directory as an SFTP session does. */
  const remoteFs = (login, umask) => new K.FsView(login.machine.vfs, login.account.home, login.machine.credFor(login.account.name), umask);
  /** A path as the SFTP server resolves it: relative to the home directory, with a leading ~ meaning the same place. */
  const remotePath = (rfs, path) => rfs.abs(path.replace(/^~(?=\/|$)\/?/, '') || '.');
  /** SFTP has only a few status codes, so its error texts are coarser than strerror. */
  const sftpStatus = (e) => (e.code === 'ENOENT' ? 'No such file' : e.code === 'EACCES' || e.code === 'EPERM' ? 'Permission denied' : 'Failure');
  const trimSlashes = (p) => p.replace(/(.)\/+$/, '$1');

  /** Remote paths matching a pattern whose last component may hold wildcards. */
  function remoteGlob(rfs, path) {
    const dir = K.VFS.dirname(path); const base = K.VFS.basename(path);
    if (!/[*?[]/.test(base)) return rfs.exists(path) ? [path] : [];
    const re = U.globToRe(base);
    let names = [];
    try { names = rfs.readdir(dir); } catch (e) { /* an unreadable directory matches nothing */ }
    return names.filter((n) => re.test(n) && (n[0] !== '.' || base[0] === '.')).map((n) => (dir === '/' ? '' : dir) + '/' + n);
  }

  // What scp says when a step of a transfer fails; remote failures carry SFTP's status text.
  const SCP_COMPLAINTS = {
    upload: {
      read: (src, dst, e) => 'open local "' + src + '": ' + e.message,
      write: (src, dst, e) => 'dest open "' + dst + '": ' + sftpStatus(e),
      mkdir: (src, dst, e) => 'remote mkdir "' + dst + '": ' + sftpStatus(e),
    },
    download: {
      read: (src, dst, e) => 'remote open "' + src + '": ' + sftpStatus(e),
      write: (src, dst, e) => 'open local "' + dst + '": ' + e.message,
      mkdir: (src, dst, e) => 'mkdir ' + dst + ': ' + e.message,
    },
  };

  /** Copy one regular file from job.from to job.to. */
  async function scpFile(job, src, dst) {
    const ctx = job.ctx;
    let st; let data;
    try { st = job.from.stat(src); data = job.from.read(src); } catch (e) { return job.complain(job.wording.read(src, dst, e)); }
    try {
      job.to.write(dst, data, { mode: st.mode & 0o777 });
      if (job.preserve) { job.to.chmod(dst, st.mode & 0o7777); job.to.utimes(dst, st.mtime); }
    } catch (e) { return job.complain(job.wording.write(src, dst, e)); }
    const bytes = U.byteLen(data);
    const ms = 2 * job.rtt + bytes / LAN_THROUGHPUT;
    await ctx.sleep(ms);
    if (job.meter) ctx.out(meterLine(K.VFS.basename(src), bytes, ms, ctx.cols));
  }

  /** Copy a directory and everything below it. */
  async function scpTree(job, src, dst) {
    let st; let names;
    try { st = job.from.stat(src); names = job.from.readdir(src); } catch (e) { return job.complain(job.wording.read(src, dst, e)); }
    try { if (!job.to.isDir(dst)) job.to.mkdir(dst, { mode: (st.mode & 0o777) | 0o700 }); } catch (e) { return job.complain(job.wording.mkdir(src, dst, e)); }
    for (const name of names) {
      const from = src + '/' + name; const to = dst + '/' + name;
      if (job.from.isDir(from)) await scpTree(job, from, to); else await scpFile(job, from, to);
    }
    if (job.preserve) job.to.utimes(dst, st.mtime);
  }

  /** Log in for a transfer. A failed login ends scp the way a dead ssh child does. */
  async function scpLogin(job, spec) {
    const login = await sshLogin(job.ctx, Object.assign({ host: spec.host, user: spec.user }, job.ssh));
    if (!login) job.ctx.err('scp: Connection closed\n');
    else job.rtt = login.rtt;
    return login;
  }

  /** Local files to one remote place. Returns an exit status when scp has to stop early. */
  async function scpUpload(job, sources, spec) {
    const ctx = job.ctx;
    const login = await scpLogin(job, spec);
    if (!login) return 255;
    try {
      const rfs = remoteFs(login, 0o022);
      Object.assign(job, { from: ctx.fs, to: rfs, wording: SCP_COMPLAINTS.upload });
      const target = remotePath(rfs, spec.path);
      let intoDir = rfs.isDir(target);
      if (sources.length > 1 && !intoDir) {
        try { rfs.mkdir(target); } catch (e) { ctx.err('scp: remote mkdir "' + target + '": ' + sftpStatus(e) + '\n'); return 255; }
        intoDir = true;
      }
      for (const src of sources) {
        let st;
        try { st = ctx.fs.stat(src); } catch (e) { ctx.err('scp: stat local "' + src + '": ' + e.message + '\n'); return 255; }
        const dst = intoDir ? trimSlashes(target) + '/' + K.VFS.basename(trimSlashes(src)) : target;
        const before = job.errs;
        const wholeDir = st.isDir && job.recursive;
        if (wholeDir) await scpTree(job, trimSlashes(src), dst);
        else if (st.isDir) job.complain('local "' + src + '" is not a regular file');
        else await scpFile(job, src, dst);
        if (job.errs > before) ctx.err('scp: failed to upload ' + (wholeDir ? 'directory' : 'file') + ' ' + src + ' to ' + (spec.path || '.') + '\n');
      }
    } finally { login.close(); }
    return null;
  }

  /** One remote source (which may be a pattern) to a local place. */
  async function scpDownload(job, spec, target) {
    const ctx = job.ctx;
    const login = await scpLogin(job, spec);
    if (!login) return 255;
    try {
      const rfs = remoteFs(login, 0o022);
      Object.assign(job, { from: rfs, to: ctx.fs, wording: SCP_COMPLAINTS.download });
      const matches = remoteGlob(rfs, remotePath(rfs, spec.path));
      if (!matches.length) return job.complain((spec.path || '.') + ': No such file or directory');
      let intoDir = ctx.fs.isDir(target);
      if (matches.length > 1 && !intoDir) {
        if (ctx.fs.exists(target)) return job.complain('Multiple files match pattern, but destination "' + target + '" is not a directory');
        try { ctx.fs.mkdir(target); } catch (e) { return job.complain('local mkdir "' + target + '": ' + e.message); }
        intoDir = true;
      }
      for (const src of matches) {
        const dst = intoDir ? trimSlashes(target) + '/' + K.VFS.basename(src) : target;
        if (!rfs.isDir(src)) await scpFile(job, src, dst);
        else if (job.recursive) await scpTree(job, src, dst);
        else job.complain('download ' + src + '/: not a regular file');
      }
    } finally { login.close(); }
    return null;
  }

  K.cmd.register({
    name: 'scp', pkg: 'openssh-client', section: 1,
    summary: 'OpenSSH secure file copy',
    synopsis: 'scp [-pqrv] [-F ssh_config] [-i identity_file] [-o ssh_option] [-P port] source ... target',
    man: 'DESCRIPTION\n       scp copies files between hosts on a network. It uses ssh(1) for the connection, so it asks the same host key question, uses the same keys and passwords, and gives the same protection as a login session.\n\n' +
      '       The source and target may be specified as a local pathname or as a remote host with optional path in the form [user@]host:[path]. A remote path that is not absolute starts in the home directory of the remote account. Local file names containing a colon can be made explicit with an absolute pathname or a leading ./ to keep scp from treating them as host specifiers.\n\n' +
      'OPTIONS\n       -F ssh_config\n              Specifies an alternative per-user configuration file for ssh.\n       -i identity_file\n              Selects the file from which the identity (private key) for public key authentication is read.\n' +
      '       -o ssh_option\n              Can be used to pass options to ssh in the format used in ssh_config(5).\n       -P port\n              Specifies the port to connect to on the remote host. Note that this option is written with a capital P.\n' +
      '       -p     Preserves modification times and file mode bits from the source file.\n       -q     Quiet mode: disables the progress meter as well as warning and diagnostic messages from ssh(1).\n       -r     Recursively copy entire directories.\n       -v     Verbose mode. Causes scp and ssh(1) to print debugging messages about their progress.\n\n' +
      'EXIT STATUS\n       The scp utility exits 0 on success, and >0 if an error occurs.\n\n' +
      'EXAMPLES\n       scp notes.txt student@web01.halcyon.lab:\n              Copy a local file to the home directory of student on web01.\n       scp student@web01.halcyon.lab:/etc/hostname .\n              Fetch a file from web01 into the current directory.\n       scp -r student@files01.halcyon.lab:reports ./reports\n              Copy a whole directory.',
    async run(ctx) {
      const g = bsdGetopt(ctx.args, '346ABCOpqRrsTvc:D:F:i:J:l:o:P:S:X:');
      if (g.err || g.rest.length < 2) { ctx.err((g.err ? g.err + '\n' : '') + SCP_USAGE); return 1; }
      const o = g.opts;
      if (o.P != null && !(/^\d+$/.test(o.P) && +o.P > 0 && +o.P < 65536)) { ctx.err('scp: bad port "' + o.P + '"\n'); return 255; }
      const cli = cliOptions(g.all.o || []);
      if (cli.err) { ctx.err(cli.err + '\nscp: Connection closed\n'); return 255; }
      const job = {
        ctx, errs: 0, recursive: !!o.r, preserve: !!o.p, meter: ctx.isTTY && !o.q,
        ssh: { port: o.P, identities: g.all.i || [], options: cli.conf, configFile: o.F, verbose: !!o.v },
        complain(msg) { ctx.err('scp: ' + msg + '\n'); job.errs++; },
      };
      const sources = g.rest.slice(0, -1); const target = g.rest[g.rest.length - 1];
      const remoteTarget = parseRemoteSpec(target);
      if (remoteTarget && sources.some(parseRemoteSpec)) { ctx.err('scp: copies between two remote hosts are not part of this simulator\n'); return 1; }
      if (remoteTarget) {
        const stopped = await scpUpload(job, sources, remoteTarget);
        if (stopped != null) return stopped;
      }
      for (const src of remoteTarget ? [] : sources) {
        const from = parseRemoteSpec(src);
        if (from) {
          const stopped = await scpDownload(job, from, target);
          if (stopped != null) return stopped;
        } else {
          // Two local names: scp hands the job to cp.
          const r = await ctx.run(['cp'].concat(o.r ? ['-r'] : [], o.p ? ['-p'] : [], ['--', src, target]));
          ctx.out(r.out); ctx.err(r.err);
          if (r.code) job.errs++;
        }
      }
      return job.errs ? 1 : 0;
    },
  });

  /* ============================================================ ssh-copy-id */

  const COPY_ID = '/usr/bin/ssh-copy-id';
  const COPY_ID_USAGE = 'Usage: ' + COPY_ID + ' [-h|-?|-f|-n|-s|-x] [-i [identity_file]] [-t target_path] [-F ssh_config] [[-o ssh_option] ...] [-p port] user@hostname\n' +
    '\t-f: force mode -- copy keys without trying to check if they are already installed\n\t-n: dry run    -- no keys are actually copied\n' +
    '\t-s: use sftp   -- use sftp instead of executing remote-commands. Can be useful if the remote only allows sftp\n\t-x: debug      -- enables -x in this shell, for debugging\n\t-h|-?: print this help\n';

  /** ssh-copy-id's own argument walk: -i may stand alone, and options may come after the host. { opt } or null for the usage text. */
  function copyIdArgs(args) {
    const opt = { o: [], hosts: [] };
    for (let i = 0; i < args.length; i++) {
      const m = /^-([fnsxiotpF])(.*)$/.exec(args[i]);
      if (!m) {
        if (/^-/.test(args[i])) return null;
        opt.hosts.push(args[i]);
      } else if ('fnsx'.includes(m[1])) {
        if (m[2]) return null;
        opt[m[1]] = true;
      } else if (m[1] === 'i') {
        // the file name is optional: a last argument must be the host
        opt.i = m[2] || (i + 2 < args.length && !/^-/.test(args[i + 1]) ? args[++i] : '');
      } else {
        const value = m[2] || args[++i];
        if (value == null) return null;
        if (m[1] === 'o') opt.o.push(value); else opt[m[1]] = value;
      }
    }
    return opt.hosts.length === 1 ? opt : null;
  }

  /** The newest public key in ~/.ssh, which is what ssh-copy-id installs when no -i names one. */
  function newestPublicKey(ctx) {
    const dir = ctx.user.home + '/.ssh';
    let names = [];
    try { names = ctx.fs.readdir(dir); } catch (e) { /* no ~/.ssh, no keys */ }
    const files = names.filter((n) => /^id.*\.pub$/.test(n) && !/-cert\.pub$/.test(n)).map((n) => dir + '/' + n);
    return files.sort((a, b) => ctx.fs.stat(b).mtime - ctx.fs.stat(a).mtime)[0] || null;
  }

  K.cmd.register({
    name: 'ssh-copy-id', pkg: 'openssh-client', section: 1,
    summary: "use locally available keys to authorise logins on a remote machine",
    synopsis: 'ssh-copy-id [-f] [-n] [-i [identity_file]] [-p port] [-F ssh_config] [-o ssh_option] [-t target_path] [user@]hostname',
    man: "DESCRIPTION\n       ssh-copy-id is a script that uses ssh(1) to log into a remote machine (presumably using a login password, so password authentication should be enabled). It assembles a list of one or more fingerprints (as described below) and tries to log in with each key, to see if any of them are already installed. It then assembles a list of those that failed to log in and, using ssh, enables logins with those keys on the remote server by appending them to the remote user's ~/.ssh/authorized_keys (creating the file, and directory, if necessary).\n\n" +
      'OPTIONS\n       -i [identity_file]\n              Use only the key(s) contained in identity_file. If the filename does not end in .pub this is added. If the filename is omitted, the default_ID_file is used: the most recent file that matches ~/.ssh/id*.pub.\n' +
      '       -f     Forced mode: doesn\'t check if the keys are present on the remote server.\n       -n     Do a dry-run. Instead of installing keys on the remote system simply prints the key(s) that would have been installed.\n' +
      '       -p port\n              Connect to this port on the remote host.\n       -F ssh_config, -o ssh_option\n              These options are simply passed through untouched to ssh.\n       -t target_path\n              The path on the target system where the keys should be added (defaults to ".ssh/authorized_keys").\n       -h, -?\n              Print usage summary.\n\n' +
      'EXAMPLES\n       ssh-copy-id student@web01.halcyon.lab\n              Install your newest public key for student on web01; the next ssh login needs no password.\n       ssh-copy-id -i ~/.ssh/lab_rsa.pub student@db01.halcyon.lab\n              Install one particular key.',
    async run(ctx) {
      const opt = copyIdArgs(ctx.args);
      if (!opt) { ctx.err(COPY_ID_USAGE); return 1; }
      const note = (level, msg) => ctx.err(COPY_ID + ': ' + level + ': ' + msg + '\n');
      const pubFile = opt.i ? (/\.pub$/.test(opt.i) ? opt.i : opt.i + '.pub') : newestPublicKey(ctx);
      if (!pubFile) { note('ERROR', 'No identities found'); return 1; }
      const privFile = pubFile.replace(/\.pub$/, '');
      let text;
      try {
        text = ctx.fs.read(pubFile);
        if (!opt.f) ctx.fs.read(privFile);
      } catch (e) {
        const missing = text == null ? pubFile : privFile;
        ctx.out('\n' + COPY_ID + ": ERROR: failed to open ID file '" + missing + "': " + (e.code === 'ENOENT' ? 'No such file' : e.message) +
          (text == null ? '' : "\n\t(to install the contents of '" + pubFile + "' anyway, look at the -f option)") + '\n');
        return 1;
      }
      const keys = text.split('\n').filter((line) => parsePublicLine(line));
      note('INFO', 'Source of key(s) to be installed: "' + pubFile + '"');

      const dest = parseDestination(opt.hosts[0]);
      const cli = cliOptions(opt.o);
      if (cli.err) { note('ERROR', cli.err); return 1; }
      let fresh = keys;
      // Failures of the ssh that ssh-copy-id runs for the check come back with its own prefix.
      const relay = Object.assign(Object.create(ctx), { err: (s) => ctx.err(s.replace(/^(?=ssh: )/gm, COPY_ID + ': ERROR: ')) });
      const login = await sshLogin(relay, {
        host: dest.host, user: dest.user, port: opt.p, identities: opt.i ? [privFile] : [], options: cli.conf, configFile: opt.F,
        beforeAuth(machine, account) {
          if (opt.f) return true;
          note('INFO', 'attempting to log in with the new key(s), to filter out any that are already installed');
          const installed = account ? authorizedBlobs(machine, account) : [];
          fresh = keys.filter((line) => !installed.includes(parsePublicLine(line).blob));
          if (fresh.length && !opt.n) note('INFO', fresh.length + ' key(s) remain to be installed -- if you are prompted now it is to install the new keys');
          return fresh.length > 0 && !opt.n;
        },
      });
      if (!fresh.length) {
        ctx.err('\n' + COPY_ID + ': WARNING: All keys were skipped because they already exist on the remote system.\n\t\t(if you think this is a mistake, you may want to use -f option)\n\n');
        return 0;
      }
      if (opt.n) { ctx.out('=-=-=-=-=-=-=-=\nWould have added the following key(s):\n\n' + fresh.join('\n') + '\n=-=-=-=-=-=-=-=\n'); return 0; }
      if (!login) return 1;
      const targetPath = opt.t || '.ssh/authorized_keys';
      try {
        const rfs = remoteFs(login, 0o077); // the remote half runs under "umask 077"
        if (!opt.t && !rfs.exists('.ssh')) rfs.mkdir('.ssh');
        const unfinished = rfs.exists(targetPath) && /[^\n]$/.test(rfs.read(targetPath));
        rfs.append(targetPath, (unfinished ? '\n' : '') + fresh.join('\n') + '\n');
      } catch (e) {
        ctx.err('sh: 1: cannot create ' + targetPath + ': ' + e.message + '\n');
        return 1;
      } finally { login.close(); }
      const how = (opt.i ? ' -i ' + privFile : '') + (opt.p ? " -p '" + opt.p + "'" : '');
      ctx.out('\nNumber of key(s) added: ' + fresh.length + '\n\nNow try logging into the machine, with: "ssh' + how + " '" + opt.hosts[0] + "'\"\nand check to make sure that only the key(s) you wanted were added.\n\n");
      return 0;
    },
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

  /** Client mode: try each port in turn; returns the exit status, which only a single port can make non-zero. */
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
    return single ? status : 0;
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
      // The byte counts go out through netcat's bail(), which always exits 1.
      if (nc.verbose > 1) { ctx.err(' sent ' + nc.sent + ', rcvd ' + nc.rcvd + '\n'); return 1; }
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

  /* ============================================================= ftp client */

  const FTP_VERSION = 'tnftp 20230507';
  const FTP_USAGE = 'usage: ftp [-46AadefginpRtVv] [-N netrc] [-o outfile] [-P port] [-q quittime]\n           [-r retry] [-s srcaddr] [-T dir,max[,inc]] [-x xfersize]\n' +
    '           [[user@]host [port]] [host:path[/]] [file:///file]\n           [ftp://[user[:pass]@]host[:port]/path[/]]\n           [http://[user[:pass]@]host[:port]/path] [...]\n       ftp -u URL file [...]\n';
  // tnftp's command table, in the order `help` lists it.
  const FTP_COMMANDS = ('! $ account append ascii bell binary bye case cd cdup chmod close cr debug delete dir disconnect edit epsv epsv4 epsv6 exit features fget form ftp gate get glob hash help ' +
    'idle image lcd less lpage lpwd ls macdef mdelete mdir mget mkdir mls mlsd mlst mode modtime more mput mreget msend newer nlist nmap ntrans open page passive pdir pls pmlsd preserve ' +
    'progress prompt proxy put pwd quit quote radix rate rcvbuf recv reget remopts rename reset restart rhelp rmdir rstatus runique send sendport set site size sndbuf status struct sunique ' +
    'system tenex throttle trace type umask unset usage user verbose xferbuf ?').split(' ');
  const FTP_UNITS = ['', 'Ki', 'Mi', 'Gi', 'Ti'];
  const onOff = (flag) => (flag ? 'on' : 'off');

  /** tnftp's list_vertical: names down the columns, tab-separated. */
  function listVertical(names, cols) {
    const width = (Math.max(...names.map((n) => n.length)) + 8) & ~7;
    const columns = Math.max(1, Math.floor(cols / width));
    const lines = Math.ceil(names.length / columns);
    let out = '';
    for (let i = 0; i < lines; i++) {
      for (let j = 0; j < columns; j++) {
        const name = names[j * lines + i];
        out += name;
        if (j * lines + i + lines >= names.length) break;
        out += '\t'.repeat(Math.ceil((width - name.length) / 8));
      }
      out += '\n';
    }
    return out;
  }

  /** "12.34 KiB/s" as tnftp prints a rate: kibibytes at least, two decimals. */
  function ftpRate(bytesPerSecond) {
    let n = Math.floor(bytesPerSecond); let i = 1;
    for (; n >= 1024000 && i < FTP_UNITS.length - 1; i++) n = Math.floor(n / 1024);
    return Math.floor(n / 1024) + '.' + U.pad2(Math.floor((n % 1024) * 100 / 1024)) + ' ' + FTP_UNITS[i] + 'B/s';
  }
  /** The finished progress bar of a transfer (progressbar.c). */
  function ftpProgressBar(bytes, seconds, cols) {
    let shown = bytes; let unit = 0;
    for (; shown >= 100000 && unit < FTP_UNITS.length - 1; unit++) shown = Math.floor(shown / 1024);
    const stars = Math.max(0, Math.min(255, cols) - 45);
    return '\r100% |' + '*'.repeat(stars) + '| ' + U.padStart(shown, 5) + ' ' + U.padEnd(FTP_UNITS[unit], 3) + ' ' + ' ' + U.padStart(ftpRate(bytes / seconds), 12) + ' ' + '   00:00 ETA\n';
  }

  /** Print reply lines the way ftp does: all of them when verbose, otherwise only permanent errors. */
  function ftpShow(c, lines) {
    if (c.verbose || /^5/.test(lines[lines.length - 1] || '')) for (const l of lines) c.ctx.out(l + '\n');
  }

  /** Send one command over the control connection; resolves { code, lines }. `quiet` keeps the reply off the screen. */
  async function ftpSay(c, line, quiet) {
    const ctx = c.ctx;
    if (!c.session || !c.session.open) { c.session = null; ctx.out('Not connected.\n'); return { code: 0, lines: [] }; }
    const reply = c.session.send(line + '\r\n');
    await ctx.sleep(c.session.rtt);
    const lines = reply.split('\r\n').filter(Boolean);
    if (!quiet) ftpShow(c, lines);
    if (!lines.length) { c.session = null; ctx.out('421 Service not available, remote server has closed connection.\n'); return { code: 421, lines }; }
    return { code: parseInt(lines[lines.length - 1], 10), lines };
  }

  /** USER and PASS, then the remote system check tnftp makes after a login. Resolves true when logged in. */
  async function ftpLogin(c, user, password) {
    const ctx = c.ctx;
    let r = await ftpSay(c, 'USER ' + user);
    if (r.code === 331) {
      if (password == null) password = (await ctx.term.readLine({ prompt: 'Password: ', hidden: true })) || '';
      r = await ftpSay(c, 'PASS ' + password, true);
      if (r.code === 530) await ctx.sleep(1000); // vsftpd's delay_failed_login
      ftpShow(c, r.lines);
    }
    if (r.code !== 230) return false;
    c.loggedIn = true;
    const syst = await ftpSay(c, 'SYST', true);
    if (c.verbose && syst.code === 215) {
      ctx.out('Remote system type is ' + syst.lines[0].split(' ')[1] + '.\n');
      if (/UNIX Type: L8/.test(syst.lines[0])) ctx.out('Using binary mode to transfer files.\n');
    }
    await ftpSay(c, 'TYPE I', true);
    c.binary = true;
    return true;
  }

  /** Look the host up, connect and (unless -n) log in. */
  async function ftpOpen(c, target, portText) {
    const ctx = c.ctx;
    if (c.session && c.session.open) { ctx.out('Already connected to ' + c.host + ', use close first.\n'); return; }
    const at = target.lastIndexOf('@');
    const host = target.slice(at + 1); let user = at > 0 ? target.slice(0, at) : null;
    const port = portNumber(ctx.machine, portText || 'ftp', 'tcp');
    const res = K.net.resolve(ctx.machine, host);
    if (!res || !port) {
      ctx.err("ftp: Can't lookup `" + host + ':' + (portText || 'ftp') + "': " + (res ? 'Servname not supported for ai_socktype' : resolveFailure(ctx.machine, host)) + '\n');
      return;
    }
    await ctx.sleep(res.ms);
    try { c.session = await dial(ctx, res.ip, port); }
    catch (e) {
      if (!(e instanceof K.NetError)) throw e;
      ctx.err("ftp: Can't connect to `" + res.ip + ':' + port + "': " + e.message + "\nftp: Can't connect to `" + host + ':' + (portText || 'ftp') + "'\n");
      return;
    }
    Object.assign(c, { host, loggedIn: false, binary: false });
    if (c.verbose) ctx.out('Connected to ' + host + '.\n' + c.session.greeting.replace(/\r\n/g, '\n'));
    if (!c.autoLogin) return;
    let password;
    if (c.anonymous) { user = 'anonymous'; password = ctx.user.name + '@'; }
    if (!user) {
      const typed = await ask(ctx, 'Name (' + host + ':' + ctx.user.name + '): ');
      user = (typed || '').trim() || ctx.user.name;
    }
    if (!(await ftpLogin(c, user, password)) && c.session) ctx.err('ftp: Login failed\n');
  }

  /** Ask for a data connection, send a transfer command and collect what arrives. null when the server refuses. */
  async function ftpTransfer(c, command) {
    const opened = await ftpSay(c, c.passive ? 'EPSV' : 'EPRT |1|' + c.session.client + '|' + ephemeralPort() + '|');
    if (opened.code !== 229 && opened.code !== 200) return null;
    c.session.state.data = ''; // our end of the data connection
    const r = await ftpSay(c, command, true);
    const data = c.session ? c.session.state.data : '';
    if (c.session) c.session.state.data = null;
    if (!/^150/.test(r.lines[0] || '')) { ftpShow(c, r.lines); return null; }
    if (c.verbose) c.ctx.out(r.lines[0] + '\n');
    return { data, rest: r.lines.slice(1) };
  }

  async function ftpListing(c, verb, args) {
    if (c.binary) { await ftpSay(c, 'TYPE A', true); c.binary = false; }
    const t = await ftpTransfer(c, [verb].concat(args).join(' '));
    if (!t) return;
    c.ctx.out(t.data.replace(/\r\n/g, '\n'));
    ftpShow(c, t.rest);
  }

  async function ftpGet(c, args) {
    const ctx = c.ctx;
    if (!args.length) { ctx.out('usage: get remote-file [local-file]\n'); return; }
    const remote = args[0]; const local = args[1] || K.VFS.basename(remote);
    const path = K.VFS.abs(local, c.lcwd); const dir = K.VFS.dirname(path);
    if (c.verbose) ctx.out('local: ' + local + ' remote: ' + remote + '\n');
    if (!ctx.fs.can(ctx.fs.exists(path) ? path : dir, 'w')) {
      ctx.err("ftp: Can't access `" + local + "': " + (ctx.fs.exists(dir) ? 'Permission denied' : 'No such file or directory') + '\n');
      return;
    }
    if (!c.binary) { await ftpSay(c, 'TYPE I', true); c.binary = true; }
    const t = await ftpTransfer(c, 'RETR ' + remote);
    if (!t) return;
    const bytes = U.byteLen(t.data);
    const ms = Math.max(0.5, 2 * c.session.rtt + bytes / LAN_THROUGHPUT);
    await ctx.sleep(ms);
    try { ctx.fs.write(path, t.data); } catch (e) { ctx.err("ftp: Can't open `" + local + "': " + e.message + '\n'); return; }
    if (c.verbose && ctx.isTTY) ctx.out(ftpProgressBar(bytes, ms / 1000, ctx.cols));
    ftpShow(c, t.rest);
    if (c.verbose) {
      ctx.out(bytes + ' byte' + (bytes === 1 ? '' : 's') + ' received in 00:' + U.pad2(Math.floor(ms / 1000)) + ' (' + ftpRate(bytes / (ms / 1000)) + ')\n');
    }
  }

  function ftpStatusReport(c) {
    const connected = c.session && c.session.open;
    c.ctx.out([
      connected ? 'Connected ' + (c.loggedIn ? 'and logged in' : '') + 'to ' + c.host + '.' : 'Not connected.', 'No proxy connection.', 'Gate ftp: off, server (none), port ftpgate.',
      'Passive mode: ' + onOff(c.passive) + '; fallback to active mode: ' + onOff(c.passive) + '.', 'Mode: stream; Type: ' + (c.binary ? 'binary' : 'ascii') + '; Form: non-print; Structure: file.',
      'Verbose: ' + onOff(c.verbose) + '; Bell: off; Prompting: on; Globbing: on.', 'Store unique: off; Receive unique: off.', 'Preserve modification times: on.', 'Case: off; CR stripping: on.',
      'Ntrans: off.', 'Nmap: off.', 'Hash mark printing: off; Mark count: 1024; Progress bar: ' + onOff(c.ctx.isTTY) + '.', 'Get transfer rate throttle: off; maximum: 0; increment 1024.',
      'Put transfer rate throttle: off; maximum: 0; increment 1024.', 'Socket buffer sizes: send 16384, receive 131072.', 'Use of PORT cmds: on.', 'Use of EPSV/EPRT cmds for IPv4: on.',
      'Use of EPSV/EPRT cmds for IPv6: on.', 'Command line editing: ' + onOff(c.ctx.stdinTTY) + '.', 'Version: ' + FTP_VERSION, '',
    ].join('\n'));
  }

  const FTP_HELP_TEXT = {
    ascii: 'set ascii transfer type', binary: 'set binary transfer type', bye: 'terminate ftp session and exit', cd: 'change remote working directory', cdup: 'change remote working directory to parent directory',
    close: 'terminate ftp session', dir: 'list contents of remote path', disconnect: 'terminate ftp session', exit: 'terminate ftp session and exit', get: 'receive file', help: 'print local help information',
    lcd: 'change local working directory', lpwd: 'print local working directory', ls: 'list contents of remote path', nlist: 'nlist contents of remote path', open: 'connect to remote ftp',
    passive: 'toggle use of passive transfer mode', pwd: 'print working directory on remote machine', quit: 'terminate ftp session and exit', status: 'show current status',
    system: 'show remote system type', user: 'send new user information', '?': 'print local help information',
  };

  /** Commands that work with or without a connection: name -> (c, args). */
  const FTP_LOCAL_COMMANDS = {
    help(c, args) {
      const out = c.ctx.out;
      if (!args.length) out('Commands may be abbreviated.  Commands are:\n\n' + listVertical(FTP_COMMANDS, c.ctx.cols));
      for (const a of args) out(FTP_COMMANDS.includes(a) ? U.padEnd(a, 11) + '\t' + (FTP_HELP_TEXT[a] || 'not part of this simulator') + '\n' : "?Invalid help command `" + a + "'\n");
    },
    status: ftpStatusReport,
    passive(c) {
      c.passive = !c.passive;
      c.ctx.out('Passive mode: ' + onOff(c.passive) + '; fallback to active mode: ' + onOff(c.passive) + '.\n');
    },
    verbose(c) { c.verbose = !c.verbose; c.ctx.out('Verbose mode ' + onOff(c.verbose) + '.\n'); },
    lpwd(c) { c.ctx.out('Local directory: ' + c.lcwd + '\n'); },
    lcd(c, args) {
      const ctx = c.ctx;
      const dir = K.VFS.abs(args[0] || ctx.user.home, c.lcwd);
      if (ctx.fs.isDir(dir)) { c.lcwd = dir; ctx.out('Local directory now: ' + dir + '\n'); }
      else ctx.err("ftp: Can't chdir `" + dir + "': " + (ctx.fs.exists(dir) ? 'Not a directory' : 'No such file or directory') + '\n');
    },
    async open(c, args) {
      if (!args.length) c.ctx.out('usage: open host-name [port]\n'); else await ftpOpen(c, args[0], args[1]);
    },
  };
  FTP_LOCAL_COMMANDS['?'] = FTP_LOCAL_COMMANDS.help;

  /** A command that is a single protocol command; `needs` names its argument for the usage line. */
  const ftpPlain = (build, needs) => async (c, args, name) => {
    if (needs && !args.length) c.ctx.out('usage: ' + name + ' ' + needs + '\n'); else await ftpSay(c, build(args));
  };
  async function ftpSetType(c, binary) {
    const r = await ftpSay(c, binary ? 'TYPE I' : 'TYPE A');
    if (r.code === 200) c.binary = binary;
  }

  /** Commands for an open connection: name -> (c, args, name). */
  const FTP_REMOTE_COMMANDS = {
    cd: ftpPlain((a) => 'CWD ' + a[0], 'remote-directory'), cdup: ftpPlain(() => 'CDUP'), system: ftpPlain(() => 'SYST'), features: ftpPlain(() => 'FEAT'), rstatus: ftpPlain(() => 'STAT'),
    mkdir: ftpPlain((a) => 'MKD ' + a[0], 'directory-name'), rmdir: ftpPlain((a) => 'RMD ' + a[0], 'directory-name'), delete: ftpPlain((a) => 'DELE ' + a[0], 'remote-file'),
    size: ftpPlain((a) => 'SIZE ' + a[0], 'remote-file'), quote: ftpPlain((a) => a.join(' '), 'line to send'), rhelp: ftpPlain((a) => ['HELP'].concat(a).join(' ')),
    ascii: (c) => ftpSetType(c, false), binary: (c) => ftpSetType(c, true), image: (c) => ftpSetType(c, true),
    ls: (c, args) => ftpListing(c, 'LIST', args), dir: (c, args) => ftpListing(c, 'LIST', args), nlist: (c, args) => ftpListing(c, 'NLST', args),
    get: ftpGet, recv: ftpGet,
    async close(c) { await ftpSay(c, 'QUIT'); c.session = null; },
    async user(c, args) {
      if (!args.length) c.ctx.out('usage: user username [password [account]]\n');
      else if (!(await ftpLogin(c, args[0], args[1]))) c.ctx.out('Login failed.\n');
    },
    async pwd(c) {
      const r = await ftpSay(c, 'PWD', true);
      const m = /^257 "(.*)"/.exec(r.lines[0] || '');
      c.ctx.out(m ? 'Remote directory: ' + m[1] + '\n' : 'Unable to determine remote directory\n');
    },
  };
  FTP_REMOTE_COMMANDS.disconnect = FTP_REMOTE_COMMANDS.close;

  /** Run one line typed at the ftp> prompt. Resolves false when the client should exit. */
  async function ftpDispatch(c, line) {
    const ctx = c.ctx;
    const words = (line.match(/"[^"]*"|\S+/g) || []).map((w) => w.replace(/^"(.*)"$/, '$1'));
    if (!words.length) return true;
    const matches = FTP_COMMANDS.includes(words[0]) ? [words[0]] : FTP_COMMANDS.filter((n) => n.startsWith(words[0]));
    if (matches.length !== 1) { ctx.out(matches.length ? '?Ambiguous command.\n' : '?Invalid command.\n'); return true; }
    const name = matches[0]; const args = words.slice(1);
    const online = c.session && c.session.open;
    if (name === 'bye' || name === 'quit' || name === 'exit') {
      if (online) await ftpSay(c, 'QUIT');
      return false;
    }
    if (FTP_LOCAL_COMMANDS[name]) await FTP_LOCAL_COMMANDS[name](c, args);
    else if (!online) ctx.out('Not connected.\n');
    else if (FTP_REMOTE_COMMANDS[name]) await FTP_REMOTE_COMMANDS[name](c, args, name);
    else ctx.out('ftp: ' + name + ' is not part of this simulator\n');
    return true;
  }

  K.cmd.register({
    name: 'ftp', aliases: ['tnftp'], pkg: 'tnftp', section: 1,
    summary: 'Internet file transfer program',
    synopsis: 'ftp [-46AadefginpRtVv] [-N netrc] [-o outfile] [-P port] [-q quittime] [-r retry] [-s srcaddr] [-T dir,max[,inc]] [-x xfersize] [[user@]host [port]]',
    man: 'DESCRIPTION\n       ftp is the user interface to the Internet standard File Transfer Protocol. The program allows a user to transfer files to and from a remote network site. FTP sends everything, passwords included, as plain text; prefer scp(1) where the server offers SSH.\n\n' +
      '       The host with which ftp is to communicate may be specified on the command line. If this is done, ftp will immediately attempt to establish a connection to an FTP server on that host and asks for a login name and password; otherwise, ftp will enter its command interpreter and await instructions from the user at the prompt "ftp> ". Many servers accept the name anonymous with any password for their public area.\n\n' +
      'OPTIONS\n       -a     Causes ftp to bypass normal login procedure, and use an anonymous login instead.\n       -n     Restrains ftp from attempting "auto-login" upon initial connection.\n       -P port\n              Sets the port number to port.\n       -p     Enable passive mode operation (the default).\n' +
      '       -V     Disable verbose and progress, overriding the default of enabled when output is to a terminal.\n       -v     Enable verbose and progress.\n\n' +
      'COMMANDS\n       ascii, binary\n              Set the file transfer type.\n       bye, exit, quit\n              Terminate the FTP session with the remote server and exit ftp. An end of file will also terminate the session and exit.\n' +
      '       cd remote-directory, cdup\n              Change the working directory on the remote machine.\n       close, disconnect\n              Terminate the FTP session with the remote server, and return to the command interpreter.\n' +
      '       dir [remote-path], ls [remote-path]\n              Print a listing of the contents of a directory on the remote machine.\n       get remote-file [local-file]\n              Retrieve the remote-file and store it on the local machine.\n' +
      '       help [command], ? [command]\n              Print an informative message about the meaning of command, or a list of the known commands.\n       lcd [directory], lpwd\n              Change or print the working directory on the local machine.\n' +
      '       open host [port]\n              Establish a connection to the specified host FTP server.\n       passive\n              Toggle passive mode.\n       pwd    Print the name of the current working directory on the remote machine.\n' +
      '       status Show the current status of ftp.\n       user user-name [password]\n              Identify yourself to the remote FTP server.\n\n' +
      'EXAMPLES\n       ftp files01.halcyon.lab\n              Connect to the lab file server; log in as anonymous, then try ls, cd pub and get README.txt.\n       ftp -a files01.halcyon.lab\n              The same, with the anonymous login done for you.',
    async run(ctx) {
      const g = K.getopt(ctx.args, { short: '46AadefginpRtVvN:o:P:q:r:s:T:x:u', stopAtNonOption: true });
      if (g.err || g.opts.u) { ctx.err((g.err ? 'ftp: ' + g.err + '\n' : '') + FTP_USAGE); return 1; }
      const o = g.opts;
      const c = {
        ctx, session: null, host: '', loggedIn: false, binary: false, lcwd: ctx.cwd,
        verbose: o.V ? false : !!o.v || ctx.isTTY, passive: !o.A, autoLogin: !o.n, anonymous: !!o.a,
      };
      try {
        if (g.rest.length) await ftpOpen(c, g.rest[0], g.rest[1] || o.P);
        for (;;) {
          const line = await ctx.readLine('ftp> ');
          if (line == null) { if (c.session && c.session.open) await ftpSay(c, 'QUIT'); break; }
          if (!(await ftpDispatch(c, line))) break;
        }
      } finally { if (c.session) c.session.close(); }
      return 0;
    },
  });

  /* =========================================================== ftp protocol */

  // What an FTP server offers when its host record says nothing: a harmless anonymous area.
  const DEFAULT_FTP = {
    anonymous: true, users: {},
    files: {
      '/README': 'This FTP server is part of a training lab. Nothing here is real.\n',
      '/pub/welcome.txt': 'Welcome to the public area.\nFiles placed here can be read by anyone who connects.\n',
    },
  };
  const VSFTPD_LOG = '/var/log/vsftpd.log';
  const FTP_HELP = ['214-The following commands are recognized.', ' ABOR ACCT ALLO APPE CDUP CWD  DELE EPRT EPSV FEAT HELP LIST MDTM MKD',
    ' MODE NLST NOOP OPTS PASS PASV PORT PWD  QUIT REIN REST RETR RMD  RNFR', ' RNTO SITE SIZE SMNT STAT STOR STOU STRU SYST TYPE USER XCUP XCWD XMKD',
    ' XPWD XRMD', '214 Help OK.'].join('\r\n');
  const FTP_FEATURES = ['211-Features:', ' EPRT', ' EPSV', ' MDTM', ' PASV', ' REST STREAM', ' SIZE', ' TVFS', ' UTF8', '211 End'].join('\r\n');
  const FTP_WRITE_COMMANDS = ['STOR', 'STOU', 'APPE', 'DELE', 'MKD', 'XMKD', 'RMD', 'XRMD', 'RNFR', 'RNTO'];
  const FTP_UNIMPLEMENTED = ['ACCT', 'REIN', 'SMNT'];
  const FTP_BEFORE_LOGIN = ['USER', 'PASS', 'QUIT', 'FEAT', 'OPTS'];
  const FTP_MAX_LOGIN_FAILS = 3;
  const HALF_YEAR = 182 * 86400000;

  /** The first working day of the month at 08:05 - when the lab's public files were last put in place. */
  function publishedAt(now) {
    const d = new Date(now);
    const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 8, 5));
    while (first.getUTCDay() % 6 === 0) first.setUTCDate(first.getUTCDate() + 1);
    return first.getTime();
  }

  /** A read-only tree from a { '/path': 'content' } map: how host.ftp.files describes what a session sees. */
  function mapTree(files) {
    const dirs = new Set(['/']);
    for (const path of Object.keys(files)) for (let d = K.VFS.dirname(path); !dirs.has(d); d = K.VFS.dirname(d)) dirs.add(d);
    const mtime = publishedAt(K.clock.now());
    const children = (path) => Array.from(dirs).concat(Object.keys(files)).filter((p) => p !== '/' && K.VFS.dirname(p) === path);
    return {
      stat(path) {
        if (dirs.has(path)) return { isDir: true, mode: 0o755, nlink: 2 + children(path).filter((p) => dirs.has(p)).length, uid: 0, gid: 0, size: 4096, mtime };
        return path in files ? { isDir: false, mode: 0o644, nlink: 1, uid: 0, gid: 0, size: U.byteLen(files[path]), mtime } : null;
      },
      list: (path) => children(path).map((p) => K.VFS.basename(p)).sort(),
      read: (path) => (path in files ? files[path] : null),
      canEnter: (path) => dirs.has(path),
    };
  }

  /** The same interface over a machine's real files, with the permissions of the account that logged in. */
  function accountTree(fs) {
    const quietly = (fn, otherwise) => { try { return fn(); } catch (e) { return otherwise; } };
    return {
      stat: (path) => quietly(() => fs.stat(path), null),
      list: (path) => quietly(() => fs.readdir(path), []),
      read: (path) => quietly(() => (fs.stat(path).isFile ? fs.read(path) : null), null),
      canEnter: (path) => fs.isDir(path) && fs.can(path, 'x'),
    };
  }

  /** One line of a LIST reply in vsftpd's layout (numeric owners, zero-padded day). */
  function ftpListLine(name, st) {
    const bits = 'rwxrwxrwx'.split('').map((ch, i) => (st.mode & (0o400 >> i) ? ch : '-')).join('');
    const d = new Date(st.mtime);
    const recent = Math.abs(K.clock.now() - st.mtime) < HALF_YEAR;
    const when = U.MONTHS[d.getUTCMonth()] + ' ' + U.pad2(d.getUTCDate()) + ' ' + (recent ? U.pad2(d.getUTCHours()) + ':' + U.pad2(d.getUTCMinutes()) : ' ' + d.getUTCFullYear());
    return (st.isDir ? 'd' : '-') + bits + ' ' + U.padStart(st.nlink, 4) + ' ' + U.padEnd(st.uid, 8) + ' ' + U.padEnd(st.gid, 8) + ' ' + U.padStart(st.size, 8) + ' ' + when + ' ' + name;
  }

  /**
   * vsftpd's own log on the server, when the host is one a learner can log in to and read it.
   * `pid` is what vsftpd prints from inside its sandbox: 1 for the login process, 3 for a transfer.
   */
  function vsftpdLog(s, pid, who, event, details) {
    const machine = K.net.machineFor(s.host.id);
    if (!machine) return;
    const line = ctime(K.clock.now()) + ' [pid ' + pid + '] [' + who + '] ' + event + ': Client "' + s.client + '"' + (details || '') + '\n';
    try { machine.vfs.write(VSFTPD_LOG, line, { append: true }); }
    catch (e) { /* no log directory: nothing to record */ }
  }

  /** Check a password and set the session up for the account. Returns the reply. */
  function ftpPass(s, st, password) {
    const conf = s.host.ftp || DEFAULT_FTP;
    const anonymous = /^(anonymous|ftp)$/i.test(st.user);
    const ok = anonymous ? !!conf.anonymous : (conf.users || {})[st.user] != null && conf.users[st.user] === password;
    if (!ok) {
      vsftpdLog(s, 1, st.user, 'FAIL LOGIN');
      st.user = null;
      if (++st.fails >= FTP_MAX_LOGIN_FAILS) s.open = false;
      return '530 Login incorrect.';
    }
    const machine = anonymous ? null : K.net.machineFor(s.host.id);
    const account = machine && machine.userByName(st.user);
    // A local account sees the server's real files from its home directory; everyone else sees the public area.
    st.tree = account ? accountTree(new K.FsView(machine.vfs, '/', machine.credFor(st.user))) : mapTree(conf.files || {});
    st.cwd = account ? account.home : '/';
    st.authed = true;
    if (anonymous) st.user = 'ftp';
    vsftpdLog(s, 1, st.user, 'OK LOGIN', anonymous ? ', anon password "' + (password || '?') + '"' : '');
    return '230 Login successful.';
  }

  /**
   * Send `payload` over the data connection. A client that has made that connection leaves a
   * string in session.state.data; a raw control session never does, so its transfers fail.
   */
  function ftpSend(s, st, payload, opening, done) {
    if (!st.passive) return '425 Use PORT or PASV first.';
    st.passive = false;
    if (typeof s.state.data !== 'string') return '425 Failed to establish connection.';
    s.state.data += payload;
    return opening + '\r\n' + done;
  }

  /** LIST and NLST: option words are skipped (-a shows dot files), a missing path lists nothing. */
  function ftpList(s, st, arg, namesOnly) {
    const words = arg.split(/\s+/).filter(Boolean);
    const flags = words.filter((w) => w[0] === '-').join('');
    const given = words.filter((w) => w[0] !== '-')[0];
    const path = K.VFS.abs(given || '.', st.cwd);
    const top = st.tree.stat(path);
    const names = !top ? [] : top.isDir ? st.tree.list(path).filter((n) => n[0] !== '.' || /a/i.test(flags)) : [K.VFS.basename(path)];
    const lines = names.map((name) => {
      if (namesOnly) return given && top.isDir ? given.replace(/\/$/, '') + '/' + name : name;
      const entry = top.isDir ? st.tree.stat((path === '/' ? '' : path) + '/' + name) : top;
      return entry ? ftpListLine(name, entry) : null;
    }).filter(Boolean);
    return ftpSend(s, st, lines.map((l) => l + '\r\n').join(''), '150 Here comes the directory listing.', '226 Directory send OK.');
  }

  function ftpRetr(s, st, arg) {
    const path = K.VFS.abs(arg, st.cwd);
    const content = arg ? st.tree.read(path) : null;
    if (content == null) return '550 Failed to open file.';
    const reply = ftpSend(s, st, content, '150 Opening BINARY mode data connection for ' + arg + ' (' + U.byteLen(content) + ' bytes).', '226 Transfer complete.');
    if (/^150/.test(reply)) vsftpdLog(s, 3, st.user, 'OK DOWNLOAD', ', "' + path + '", ' + U.byteLen(content) + ' bytes, ' + (40 + K.net.rand() * 400).toFixed(2) + 'Kbyte/sec');
    return reply;
  }

  function ftpStatus(s, st) {
    return ['211-FTP server status:', '     Connected to ::ffff:' + s.client, '     Logged in as ' + st.user, '     TYPE: ' + (st.binary ? 'BINARY' : 'ASCII'),
      '     No session bandwidth limit', '     Session timeout in seconds is 300', '     Control connection is plain text', '     Data connections will be plain text',
      '     At session startup, client count was 1', '     vsFTPd ' + (s.svc.version || '3.0.5') + ' - secure, fast, stable', '211 End of status'].join('\r\n');
  }

  /** The reply to one command line. */
  function ftpCommand(s, st, line) {
    const m = /^\s*(\S+)\s*(.*?)\s*$/.exec(line);
    if (!m) return '500 Unknown command.';
    const verb = m[1].toUpperCase(); const arg = m[2];
    if (!st.authed && !FTP_BEFORE_LOGIN.includes(verb)) return '530 Please login with USER and PASS.';
    switch (verb) {
      case 'USER':
        if (st.authed) return "530 Can't change to another user.";
        if (!arg) return '530 Permission denied.';
        if (!/^(anonymous|ftp)$/i.test(arg) && !Object.keys((s.host.ftp || DEFAULT_FTP).users || {}).length) return '530 This FTP server is anonymous only.';
        st.user = arg;
        return '331 Please specify the password.';
      case 'PASS':
        if (st.authed) return '230 Already logged in.';
        return st.user ? ftpPass(s, st, arg) : '503 Login with USER first.';
      case 'QUIT': s.open = false; return '221 Goodbye.';
      case 'FEAT': return FTP_FEATURES;
      case 'OPTS': return /^UTF8 ON$/i.test(arg) ? '200 Always in UTF8 mode.' : '501 Option not understood.';
      case 'SYST': return '215 UNIX Type: L8';
      case 'NOOP': return '200 NOOP ok.';
      case 'HELP': return FTP_HELP;
      case 'STAT': return ftpStatus(s, st);
      case 'PWD': case 'XPWD': return '257 "' + st.cwd + '" is the current directory';
      case 'CWD': case 'XCWD': case 'CDUP': case 'XCUP': {
        const path = K.VFS.abs(/CUP|CDUP/.test(verb) ? '..' : arg || '.', st.cwd);
        if (!st.tree.canEnter(path)) return '550 Failed to change directory.';
        st.cwd = path;
        return '250 Directory successfully changed.';
      }
      case 'TYPE':
        if (!/^(A|A N|I|L8|L 8)$/i.test(arg)) return '500 Unrecognised TYPE command.';
        st.binary = !/^A/i.test(arg);
        return st.binary ? '200 Switching to Binary mode.' : '200 Switching to ASCII mode.';
      case 'MODE': return /^S$/i.test(arg) ? '200 Mode set to S.' : '504 Bad MODE command.';
      case 'STRU': return /^F$/i.test(arg) ? '200 Structure set to F.' : '504 Bad STRU command.';
      case 'PASV': case 'EPSV': {
        st.passive = true;
        const port = 1024 + Math.floor(K.net.rand() * 64000);
        if (verb === 'EPSV') return '229 Entering Extended Passive Mode (|||' + port + '|)';
        return '227 Entering Passive Mode (' + s.host.ip.split('.').join(',') + ',' + (port >> 8) + ',' + (port & 255) + ').';
      }
      case 'PORT': case 'EPRT':
        if (verb === 'PORT' && !/^\d+(,\d+){5}$/.test(arg)) return '500 Illegal PORT command.';
        st.passive = true;
        return '200 ' + verb + ' command successful. Consider using ' + (verb === 'PORT' ? 'PASV' : 'EPSV') + '.';
      case 'LIST': return ftpList(s, st, arg, false);
      case 'NLST': return ftpList(s, st, arg, true);
      case 'RETR': return ftpRetr(s, st, arg);
      case 'SIZE': case 'MDTM': {
        const there = st.tree.stat(K.VFS.abs(arg || '.', st.cwd));
        if (!there || there.isDir) return verb === 'SIZE' ? '550 Could not get file size.' : '550 Could not get file modification time.';
        return '213 ' + (verb === 'SIZE' ? there.size : U.isoDate(there.mtime).replace(/\D/g, ''));
      }
      case 'REST': return '350 Restart position accepted (' + (parseInt(arg, 10) > 0 ? parseInt(arg, 10) : 0) + ').';
      case 'ABOR': return '225 No transfer to ABOR.';
      case 'ALLO': return '202 ALLO command ignored.';
      case 'SITE': return /^HELP$/i.test(arg) ? '214 CHMOD UMASK HELP' : '500 Unknown SITE command.';
      default:
        if (FTP_WRITE_COMMANDS.includes(verb)) return '550 Permission denied.';
        return FTP_UNIMPLEMENTED.includes(verb) ? '502 ' + verb + ' not implemented.' : '500 Unknown command.';
    }
  }

  K.net.services.register('ftp', {
    greet(s) {
      s.state.ftp = { user: null, authed: false, fails: 0, cwd: '/', binary: false, passive: false, tree: null };
      return (s.svc.banner || '220 (vsFTPd 3.0.5)') + '\r\n';
    },
    data(s, input) {
      const st = s.state.ftp;
      st.pending = (st.pending || '') + input;
      let out = '';
      for (let nl = st.pending.indexOf('\n'); nl >= 0 && s.open; nl = st.pending.indexOf('\n')) {
        const line = st.pending.slice(0, nl).replace(/\r$/, '');
        st.pending = st.pending.slice(nl + 1);
        out += ftpCommand(s, st, line) + '\r\n';
      }
      return out;
    },
  });

  /* ================================================= smtp and pop3 protocols */

  const SMTP_EXTENSIONS = ['PIPELINING', 'SIZE 10240000', 'ETRN', 'STARTTLS', 'ENHANCEDSTATUSCODES', '8BITMIME', 'DSN', 'SMTPUTF8', 'CHUNKING'];
  const smtpName = (s) => (s.svc.banner || '').split(' ')[1] || s.host.fqdn || s.host.hostname;
  /** "<user@domain>" out of "FROM:<user@domain> SIZE=1"; null when the argument is not an address in that form. */
  function smtpAddress(arg, keyword) {
    const m = new RegExp('^' + keyword + ':\\s*<([^<>\\s]*)>', 'i').exec(arg) || new RegExp('^' + keyword + ':\\s*([^<>\\s]+)', 'i').exec(arg);
    return m ? m[1] : null;
  }
  /** Is the address one this server takes mail for (its own name, its domain, or no domain at all)? */
  function smtpLocal(s, address) {
    const domain = address.includes('@') ? address.split('@').pop().toLowerCase() : '';
    const name = smtpName(s).toLowerCase();
    return !domain || domain === name || domain === name.slice(name.indexOf('.') + 1) || domain === 'localhost';
  }

  /** The reply to one SMTP command line, in Postfix's words. Nothing is ever delivered. */
  function smtpCommand(s, st, line) {
    const m = /^\s*(\S+)\s*(.*?)\s*$/.exec(line);
    if (!m) return '500 5.5.2 Error: bad syntax';
    const verb = m[1].toUpperCase(); const arg = m[2];
    switch (verb) {
      case 'HELO':
        if (!arg) return '501 Syntax: HELO hostname';
        st.mail = null; st.rcpt = 0;
        return '250 ' + smtpName(s);
      case 'EHLO':
        if (!arg) return '501 Syntax: EHLO hostname';
        st.mail = null; st.rcpt = 0;
        return [smtpName(s)].concat(SMTP_EXTENSIONS).map((text, i, all) => '250' + (i < all.length - 1 ? '-' : ' ') + text).join('\r\n');
      case 'MAIL': {
        if (st.mail != null) return '503 5.5.1 Error: nested MAIL command';
        const from = smtpAddress(arg, 'FROM');
        if (from == null) return '501 5.5.4 Syntax: MAIL FROM:<address>';
        st.mail = from;
        return '250 2.1.0 Ok';
      }
      case 'RCPT': {
        if (st.mail == null) return '503 5.5.1 Error: need MAIL command';
        const to = smtpAddress(arg, 'TO');
        if (!to) return '501 5.5.4 Syntax: RCPT TO:<address>';
        if (!smtpLocal(s, to)) return '454 4.7.1 <' + to + '>: Relay access denied';
        st.rcpt++;
        return '250 2.1.5 Ok';
      }
      case 'DATA':
        if (!st.rcpt) return st.mail == null ? '503 5.5.1 Error: need RCPT command' : '554 5.5.1 Error: no valid recipients';
        st.body = true;
        return '354 End data with <CR><LF>.<CR><LF>';
      case 'RSET': st.mail = null; st.rcpt = 0; return '250 2.0.0 Ok';
      case 'NOOP': return '250 2.0.0 Ok';
      case 'VRFY': return '502 5.5.1 VRFY command is disabled';
      case 'ETRN': return arg ? '459 <' + arg + '>: service unavailable' : '500 Syntax: ETRN domain';
      case 'AUTH': return '503 5.5.1 Error: authentication not enabled';
      case 'STARTTLS': st.tls = true; return '220 2.0.0 Ready to start TLS';
      case 'QUIT': s.open = false; return '221 2.0.0 Bye';
      case 'GET': case 'POST': case 'CONNECT': case 'HEAD': case 'PUT':
        s.open = false;
        return '221 2.7.0 Error: I can break rules, too. Goodbye.';
      default: return '502 5.5.2 Error: command not recognized';
    }
  }

  K.net.services.register('smtp', {
    greet(s) {
      s.state.smtp = { mail: null, rcpt: 0, body: false, tls: false, pending: '' };
      return (s.svc.banner || '220 ' + smtpName(s) + ' ESMTP Postfix') + '\r\n';
    },
    data(s, input) {
      const st = s.state.smtp;
      st.pending += input;
      let out = '';
      for (let nl = st.pending.indexOf('\n'); nl >= 0 && s.open; nl = st.pending.indexOf('\n')) {
        const line = st.pending.slice(0, nl).replace(/\r$/, '');
        st.pending = st.pending.slice(nl + 1);
        if (st.tls) { s.open = false; break; } // plain text where a TLS handshake belongs
        if (!st.body) out += smtpCommand(s, st, line) + '\r\n';
        else if (line === '.') {
          Object.assign(st, { body: false, mail: null, rcpt: 0 });
          out += '250 2.0.0 Ok: queued as ' + Array.from({ length: 11 }, () => '0123456789ABCDEF'[Math.floor(K.net.rand() * 16)]).join('') + '\r\n';
        }
      }
      return out;
    },
  });

  const POP3_CAPABILITIES = ['+OK', 'CAPA', 'TOP', 'UIDL', 'RESP-CODES', 'PIPELINING', 'AUTH-RESP-CODE', 'STLS', 'USER', 'SASL PLAIN', '.'].join('\r\n');

  /** The reply to one POP3 command line, in Dovecot's words. Nobody can log in. */
  function pop3Command(s, st, line) {
    const m = /^\s*(\S+)\s*(.*?)\s*$/.exec(line);
    const verb = m ? m[1].toUpperCase() : '';
    switch (verb) {
      case 'CAPA': return POP3_CAPABILITIES;
      case 'USER':
        if (!m[2]) return '-ERR No username given.';
        st.user = m[2];
        return '+OK';
      case 'PASS':
        if (!st.user) return '-ERR No username given.';
        st.user = null;
        return '-ERR [AUTH] Authentication failed.';
      case 'AUTH': return m[2] ? '-ERR [AUTH] Authentication failed.' : '+OK\r\nPLAIN\r\n.';
      case 'STLS': st.tls = true; return '+OK Begin TLS negotiation now.';
      case 'QUIT': s.open = false; return '+OK Logging out';
      default: return '-ERR Unknown command.';
    }
  }

  K.net.services.register('pop3', {
    greet(s) {
      s.state.pop3 = { user: null, tls: false, pending: '' };
      return (s.svc.banner || '+OK Dovecot ready.') + '\r\n';
    },
    data(s, input) {
      const st = s.state.pop3;
      st.pending += input;
      let out = '';
      for (let nl = st.pending.indexOf('\n'); nl >= 0 && s.open; nl = st.pending.indexOf('\n')) {
        const line = st.pending.slice(0, nl).replace(/\r$/, '');
        st.pending = st.pending.slice(nl + 1);
        if (st.tls) { s.open = false; break; }
        out += pop3Command(s, st, line) + '\r\n';
      }
      return out;
    },
  });

  /* ============================================================= completion */

  const OPTIONS_WITH_VALUES = /^-[bCEeFilNoPpqstwX]$/;

  /** Lab machine names for a host argument, keeping a typed "user@" in front. An option's value is left to path completion. */
  function completeHost(info) {
    if (OPTIONS_WITH_VALUES.test(info.words[info.index - 1] || '')) return [];
    const prefix = info.cur.slice(0, info.cur.lastIndexOf('@') + 1);
    return K.net.world.hosts.filter((h) => h.fqdn).map((h) => prefix + h.fqdn);
  }
  for (const name of ['ssh', 'ssh-copy-id', 'nc', 'telnet', 'ftp']) K.cmd.get(name).complete = completeHost;
  // scp arguments are files unless they name a user: only then are hosts offered, ready for the path.
  K.cmd.get('scp').complete = (info) => (info.cur.includes('@') && !info.cur.includes(':') ? completeHost(info).map((h) => h + ':') : []);
})(typeof globalThis !== 'undefined' ? globalThis : this);
