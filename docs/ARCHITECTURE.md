# Kalima architecture and pack contract

Kalima is an offline training simulator for Kali Linux 2026.3. It ships as one
HTML file (`dist/kalima.html`) that runs from `file://` with no network, no
server and no dependencies. Everything the learner sees — the shell, the
filesystem, the lab network, the "internet" — is simulated in JavaScript.

## Hard rules

1. **Classic scripts only.** Every file in `src/js/` is an IIFE that attaches to the
   global `K`. No ES modules, no imports, no build-time dependencies, no CDN.
2. **Runs in the browser and in Node.** Do not touch `window`/`document` outside
   `*-ui-*.js` files. Do not use Node APIs in `src/`.
3. **No real network, ever.** No `fetch`, `XMLHttpRequest`, `WebSocket`. All
   network behaviour comes from `K.net`.
4. **No `eval` / `new Function` on learner input.** Interpreters (awk, sed, bc)
   must be real parsers.
5. **Everything is fictional.** Hosts, people, credentials and data are invented.
   Never include real exploit code, malware, real credentials or hashes, or
   instructions for attacking real systems. Tools that actively test targets must
   call `K.net.guard()` so they only work inside the engagement scope.
6. **Own your files.** A pack owns its own `src/js/NN-name.js` and
   `tests/name.test.mjs`. Do not rewrite files you do not own. If you find a
   genuine kernel bug, fix it with a minimal `Edit` (never a full rewrite), run
   the whole suite, and report the change.
7. **Do not run git commands that change state** (add/commit/checkout/stash).

## File layout and load order

Files load in filename order. Registration happens at load; nothing is
instantiated until `K.boot()`, so order between packs does not matter.

| File | Purpose |
| --- | --- |
| `00-core.js` | `K` namespace, `K.util`, `K.c` colours, `K.clock`, `K.getopt`, `K.events` |
| `10-vfs.js` | `K.VFS`, `K.FsView`, `K.FsError`, `K.dynFiles` |
| `12-machine.js` | `K.Machine`, `K.cmd` registry, `K.atlas`, `K.fsSeeds`, base filesystem |
| `20-shell-parse.js` | `K.shlex` lexer/parser/arithmetic |
| `21-shell.js` | `K.Shell`, builtins, `K.HeadlessTerm`, `sudo`, `su`, `bash`/`sh`/`zsh` |
| `30-net.js` | `K.net` engine: routing, probes, DNS, HTTP, sessions, scope |
| `31-world.js` | `K.makeWorld()` lab + simulated internet, engagement files |
| `35-lessons.js` | `K.lessons` registry, check evaluation, progress |
| `40-cmd-*.js` | command packs |
| `45-*.js` | world content packs |
| `48-atlas.js` | Kali tool catalogue |
| `50-lessons-*.js` | curriculum |
| `60-ui-*.js` | browser UI (terminal widget, app shell) — DOM allowed here only |
| `90-boot.js` | `K.boot()` |

Build: `node tools/build.mjs` → `dist/kalima.html`. Test: `node --test tests/*.test.mjs`.

## Writing a command

```js
;(function (root) {
  'use strict';
  const K = root.K;

  K.cmd.register({
    name: 'wc',                       // executable name
    aliases: [],                      // extra names for the same program
    path: '/usr/bin/wc',              // default /usr/bin/<name>; use /usr/sbin/... where Debian does
    pkg: 'coreutils',                 // Debian/Kali package name
    section: 1,                       // man section
    summary: 'print newline, word, and byte counts for each file',
    synopsis: 'wc [OPTION]... [FILE]...',
    man: 'DESCRIPTION and OPTIONS text for the man page (plain text)',
    only: 'kali',                     // optional: not installed on lab servers
    async run(ctx) { /* ... */ return 0; },   // exit status (undefined = 0)
    complete(info) { return []; },    // optional: candidates for tab completion
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

The `ctx` object:

| Member | Meaning |
| --- | --- |
| `name`, `argv`, `args` | program name, full argv, `argv.slice(1)` |
| `stdin` | `string` when input is piped/redirected, `null` when attached to the terminal |
| `out(s)`, `err(s)` | write to stdout / stderr (no newline added) |
| `println(s)`, `eprintln(s)` | same, with newline |
| `isTTY`, `errTTY`, `stdinTTY` | is stdout / stderr / stdin the terminal? (use `isTTY` to decide on colour and column layout) |
| `env` | exported environment (plain object, read-only snapshot) |
| `cwd` | working directory |
| `fs` | `K.FsView` bound to cwd, the user's credentials and umask (see below) |
| `machine`, `vfs` | the `K.Machine` the shell runs on and its raw `K.VFS` |
| `net` | `K.net` |
| `user`, `isRoot` | `{name, uid, gid, groups, home}` |
| `shell`, `term`, `io` | the `K.Shell`, the terminal, the raw io object |
| `cols`, `rows` | terminal size |
| `pid` | pid of this process (it is in `machine.procs` while running) |
| `path(p)` | absolute path for `p` |
| `await sleep(ms)` | wait simulated time. Rejects with `K.Interrupt` on Ctrl-C — let it propagate (or catch it to print a summary, then return 130) |
| `aborted()`, `checkAbort()` | poll for Ctrl-C in loops that do not sleep |
| `await readLine(prompt, {hidden})` | read a line: from `stdin` if piped, else from the terminal. `null` = EOF |
| `fail(msg, code=1)` | prints `name: msg` to stderr, returns the code |
| `getopt(spec)` | `K.getopt(ctx.args, spec)` |
| `await run(argvOrLine, {stdin})` | run another command, returns `{code, out, err}` (for `xargs`, `find -exec`, `watch`) |

Conventions:

- Throwing `K.FsError` out of `run` prints `name: path: message` and exits 1, but
  prefer catching it and printing the exact message the real tool prints.
- Never block: long output loops must `await ctx.sleep(...)` or call
  `ctx.checkAbort()` periodically so Ctrl-C works.
- A command that waits for time (ping, a scan, a download) must use
  `ctx.sleep` with realistic durations. Tests use virtual time, so this is free.
- Colour only when `ctx.isTTY` (or when `--color=always`).
- Support `--help` and `--version` where the real tool does.

### `K.getopt(args, spec)`

```js
const g = K.getopt(ctx.args, { short: 'c:i:nq', long: ['count=', 'help', 'color=?'], alias: { count: 'c' } });
if (g.err) return ctx.fail(g.err + "\nTry 'ping --help' for more information.", 2);
g.opts.c       // string value, or true for flags
g.count.v      // number of times -v was given
g.all.e        // every value given for a repeatable option
g.rest         // positional arguments
```
`x:` required argument, `x::` optional attached argument; long `name=` required, `name=?` optional.
`stopAtNonOption: true` stops at the first positional (for wrappers like `sudo`, `xargs`).

### Filesystem (`ctx.fs`, a `K.FsView`)

`read(p)`, `write(p, data, {mode})`, `append(p, data)`, `stat(p)`, `lstat(p)`,
`exists(p)`, `isDir(p)`, `isFile(p)`, `readdir(p)` (sorted names), `mkdir(p,
{parents, mode})`, `unlink(p)`, `rmdir(p)`, `rmTree(p)`, `rename(a, b)`,
`chmod(p, mode)`, `chown(p, uid, gid)`, `symlink(target, p)`, `readlink(p)`,
`realpath(p)`, `utimes(p, ms)`, `can(p, 'r'|'w'|'x')`, `abs(p)`.

`stat` returns `{type:'f'|'d'|'l'|'c', isFile, isDir, isLink, isDev, mode, uid,
gid, size, mtime, ino, nlink, target}`. Errors are `K.FsError` with `.code`
(`ENOENT`, `EACCES`, `EISDIR`, `ENOTDIR`, `EEXIST`, `ENOTEMPTY`, `EPERM`, …) and
`.message` (the strerror text, e.g. `No such file or directory`).

Permissions are enforced with the caller's uid/gid/groups, including the sticky
bit. File content is a JS string; `K.util.toBytes` / `fromBytes` convert to UTF-8.

Seeding files into new machines (bypasses permissions; runs for every machine):

```js
K.fsSeeds.push((machine) => {
  if (machine.profile !== 'kali') return;           // or check machine.hostId === 'web01'
  machine.vfs.seed('/usr/share/doc/x/README', 'text', { mode: 0o644, uid: 0, gid: 0, mtime: ms });
  machine.vfs.seedDir('/var/lib/x'); machine.vfs.seedLink('/usr/bin/vi', 'vim');
  machine.units.push({ name: 'ssh.service', /* ... */ });   // hooks may also initialise machine state
});
```

Files whose content is computed on read: `K.dynFiles.register('key', (machine) =>
'text')` and `vfs.seed(path, { dyn: 'key' })`.

### Machine (`ctx.machine`)

`hostname`, `domain`, `fqdn()`, `profile` (`'kali'` or `'server'`), `hostId`,
`os`, `users` / `groups` (`userByName`, `userByUid`, `groupByName`,
`groupByGid`, `userName(uid)`, `groupName(gid)`, `groupsOf(name)`, `addUser`,
`credFor`, `canSudo`, `checkPassword`, `passwords`), `ifaces` (`{name, ip, bits,
mac, kind:'ether'|'loopback', state, mtu}`), `routes` (`{dst:'default'|cidr,
via, dev, src, proto, metric}`), `dns` (resolver IPs), `search`, `arp` (Map,
filled by the engine), `procs` (`{pid, ppid, user, tty, stat, start, cpu, mem,
cmd}`; `spawn(p)`, `reap(pid)`, `nextPid()`), `units` (systemd units — owned by
the system pack), `packages` (Map — owned by the system pack), `listeners`
(use `K.net.listen`), `state` (free-form scratch space for packs),
`installCommand(def)`, `commandAt(path)`.

Kali's login is `kali` / `kali` (member of `sudo`). `root` is locked.

### Shell facts that affect commands

- Kali's interactive shell is **zsh** with Kali's prompt; lab servers use bash.
- Pipelines are buffered: each stage runs to completion and its stdout becomes
  the next stage's `stdin` string. The last stage streams to the terminal.
- Builtins (in `21-shell.js`, do not re-register): `cd pwd echo printf export
  unset set alias unalias exit return break continue shift history source . eval
  command builtin exec type which test [ [[ read umask jobs fg bg wait kill time
  clear reset local declare true false :`, plus `sudo`, `su`, `bash`, `sh`, `zsh`.
- After every interactive line the shell emits `K.events.emit('command', {line,
  code, output, commands:[{argv, code}], cwd, user, host, shell})`.

### Terminal (`ctx.term`)

`write(s)`, `cols`, `rows`, `clear()`, `await pager(text, {title})` (less/man),
`await editor({path, content, flavor:'nano'|'vim'})` → `{saved, content}`,
`onKey(fn)` → unsubscribe (raw keys for `top`, `watch`: `'q'`, `'Enter'`, …),
`readLine({prompt, hidden})`. Output supports SGR colours, `\r` (rewrite the
current line), `\x1b[K` (erase to end of line), `\x1b[2J\x1b[H` (clear screen),
`\b`, `\t`. Do not rely on other cursor movement.

In tests the terminal is a `K.HeadlessTerm`: `term.feed('line')` queues input,
`term.take()` returns and clears output, `pager()` writes the text straight
through, `editor()` returns `{saved:false}`, `term.pressKey('q')` fires `onKey`.

## Network engine (`K.net`)

All calls are synchronous and return timings in ms. The command decides how long
to really wait with `ctx.sleep`.

| Call | Returns |
| --- | --- |
| `resolve(machine, name)` | `{ip, name, source:'literal'\|'hosts'\|'dns', ms}` or `null` (libc-style: literal, `/etc/hosts`, DNS with search domains) |
| `reverse(machine, ip)` | PTR name or `null` |
| `dns(machine, name, type, {server})` | `{status:'NOERROR'\|'NXDOMAIN'\|'REFUSED'\|'TIMEOUT'\|'NOSERVER', answers, authority, additional, server, ms, flags:{aa,ra,rd}, question}`; records are `{name, type, ttl, data, prio}` without trailing dots |
| `axfr(machine, zone, serverIp)` | `{status:'OK'\|'REFUSED'\|'TIMEOUT'\|'NOTAUTH', records, ms}` |
| `route(machine, ip)` | `{ok, err:'ENETUNREACH'\|'EHOSTUNREACH', self, direct, inet, blackhole, src, dev, gateway, host, hops:[{ip, name, rtt, silent}], rtt}` — `hops` excludes the destination |
| `ping(machine, ip, seq, {ttl, size, id})` | `{status:'reply'\|'timeout'\|'unreachable'\|'ttl-exceeded'\|'noroute', rtt, ttl, from, fromName, route}` |
| `tcp(machine, ip, port)` | `{state:'open'\|'closed'\|'filtered', reason, rtt, service, host, route, hostDown}` |
| `udp(machine, ip, port)` | `{state:'open'\|'open\|filtered'\|'closed'\|'filtered', ...}` |
| `connect(machine, ip, port)` | session `{greeting, send(text) -> reply, close(), open, host, svc, rtt, state}`; throws `K.NetError` (`.code` `ECONNREFUSED`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`; `.message` is the strerror text) |
| `http(machine, {method, url, headers, body, ip})` | `{status, statusText, headers, body, ip, port, scheme, host, path, ms, tls}`; throws `K.NetError` (`ENOTFOUND` for DNS failure). Does not follow redirects |
| `hostAt(ip)`, `knownHost(ip)`, `hostByName(n)`, `hostById(id)` | world host records (`hostAt` also synthesizes deterministic internet hosts) |
| `servicesOf(host)` | `[{port, proto, name, product, version, extra, banner, handler, tls, state}]` |
| `listen(machine, {port, proto, addr, prog, pid, name, http(request) -> {status, headers, body}})` | registers a listening socket, returns an unlisten function |
| `listening(machine)` | active listeners (running units' ports + `listen` calls) |
| `machineFor(hostId)` | the `K.Machine` for a lab host that allows logins (created on first use), else `null` |
| `inScope(ipOrName)` | is the target inside the engagement scope? |
| `guard(ctx, ip, toolName)` | **required for active testing tools**: returns `true` if allowed, else prints the scope notice and returns `false` |
| `bus.on('packet', fn)` | every simulated packet `{ts, src, dst, proto:'ICMP'\|'TCP'\|'UDP', sport, dport, flags, info, len, dev}`; emit your own with `K.net.packet({...})` |
| `bus.on('conn', fn)`, `bus.on('http', fn)` | connections seen by hosts `{host, port, proto, src, kind, ts}`; HTTP exchanges `{host, svc, request, response, ts}` |
| `services.register(name, {greet(session), data(session, input)})` | protocol handler used by `connect()` for services whose `handler` (or `name`) matches |
| `state.wan` | set `false` to simulate an internet outage |
| `rand()`, `jitter(base, spread)` | seeded randomness (stable in tests) — use these, not `Math.random()` |

Ordinary client tools (ping, traceroute, dig, whois, curl) may talk to the
simulated internet. Unknown public names resolve deterministically; names
containing `nonexistent`, `invalid`, etc. return NXDOMAIN.

### The world (`K.net.world`, built by `K.makeWorld()`)

Engagement `HF-LAB-2026-11` for the fictional *Halcyon Freight Ltd.* Scope:
`10.10.10.0/24` and `*.halcyon.lab`. Kali is `10.10.10.5` (`eth0`), gateway
`10.10.10.1`, lab DNS `10.10.10.53`.

| Host | IP | Notes |
| --- | --- | --- |
| gw | 10.10.10.1 | router (OpenWrt); 80/443 open, 53/tcp and 22 filtered, other ports closed |
| web01 (www, intranet) | 10.10.10.10 | ssh, nginx 80/443; login `student`/`student` |
| files01 | 10.10.10.20 | ftp, ssh, rpcbind, Samba (139/445), nfs; login `student` |
| db01 | 10.10.10.30 | ssh, MariaDB 3306; login `student` |
| mail01 (mail) | 10.10.10.40 | ssh, smtp, pop3, imap, submission, imaps; no shell login |
| dc01 | 10.10.10.50 | Windows Server 2022 (DNS, Kerberos, RPC, LDAP/LDAPS, SMB, RDP, WinRM), drops ICMP, other ports filtered |
| ns1 | 10.10.10.53 | ssh, BIND (53 tcp/udp); authoritative for `halcyon.lab`; allows AXFR from the lab; no shell login |
| printer | 10.10.10.60 | http, https, lpd 515, ipp 631, JetDirect 9100, snmp/udp |
| dev01 | 10.10.10.70 | ssh, 3000 (Express), 8080 (Jetty), 5432 filtered, other ports closed; login `student` |
| cam01 | 10.10.10.80 | telnet, http (401), rtsp; 4 % packet loss |
| backup01 | 10.10.10.90 | drops ICMP, everything filtered except rsync 873 |

Simulated internet: `dns.google` 8.8.8.8/8.8.4.4, `one.one.one.one` 1.1.1.1,
`dns9.quad9.net` 9.9.9.9, `example.com`, `kali.org`, `http.kali.org`, and the
client's public presence `halcyonfreight.example` (203.0.113.10, mail .25, ns
.53) — **out of scope** for active testing.

Extend the world with `K.worldExtensions.push((world) => { ... })` (runs inside
`K.makeWorld()`). Host records may carry `web` (`{server, routes:{'/path':
{status, type, headers, body} | fn(request, host)}, vhosts, ports, sites}`),
`shell` (`{users:[...]}` → logins allowed), `firewall` (`{default:'closed'|
'filtered', filtered:[ports], icmp:false}`), `latency`, `loss`, `os`.

## Lessons (`K.lessons`)

See the header of `35-lessons.js` for the full schema. Rules for lesson authors:

- Every command step has a `solution` (one command line that satisfies `check`
  from a fresh boot plus the earlier steps' solutions). `tests/lessons.test.mjs`
  replays every solution and fails if a check does not pass.
- Steps that need typed input (passwords) list it in `input: ['kali']`.
- A step whose real solution needs the interactive editor (which a headless
  terminal cannot drive) also gives `testSolution`: a command line that produces
  the same outcome, used only by the replay test. The check must test the outcome
  (file content), not the editor command.
- Practice files that lessons need are seeded read-only under
  `/usr/share/kalima/` with `K.fsSeeds` (the learner's home directory is restored
  from saved state, so new seeds there would not reach returning learners).
- Checks test the *outcome* the step teaches, loosely enough that any correct
  approach passes, tightly enough that the wrong command does not.
- Text is "markdown-lite": paragraphs, `- ` lists, `` `code` ``, `**bold**`,
  `*italic*`, fenced code blocks. No HTML.

## Fidelity standard

Output must be what the real tool prints on Kali 2026.3: same columns, spacing,
wording, exit codes and error messages. When the real tool is installed on the
build machine (coreutils, grep, sed, awk, …) compare against it. When it is not,
reproduce the documented format from the tool's man page. Invented data is fine;
invented formats are not.
