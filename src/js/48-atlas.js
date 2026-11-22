/* Kalima — the simulator's own helper commands (kalima, help), the catalogue of
 * Kali tools (K.atlas) and honest placeholders for catalogue tools that this
 * build does not simulate.
 *
 * The catalogue is a map of the toolbox, not a manual: an entry says what kind
 * of tool something is and nothing about how to use it.
 */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;

  /* ------------------------------------------------------------ text layout */
  const identity = (s) => s;
  const PLAIN = { head: identity, key: identity, ok: identity, warn: identity, bad: identity, dim: identity };
  const COLOUR = { head: K.c.bold, key: K.c.cyan, ok: K.c.green, warn: K.c.yellow, bad: K.c.red, dim: K.c.gray };
  const pen = (ctx) => (ctx.isTTY ? COLOUR : PLAIN);
  const errPen = (ctx) => (ctx.errTTY ? COLOUR : PLAIN);

  const textWidth = (ctx) => Math.max(40, Math.min(ctx.cols || 80, 100));

  /** Break text into lines of at most `width` characters. */
  function wrap(text, width) {
    const lines = []; let cur = '';
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
      if (cur && cur.length + 1 + word.length > width) { lines.push(cur); cur = word; } else cur = cur ? cur + ' ' + word : word;
    }
    lines.push(cur);
    return lines;
  }

  /** A paragraph wrapped to the terminal, every line indented and, if asked, coloured. */
  const para = (ctx, text, indent, paint) => wrap(text, textWidth(ctx) - indent).map((l) => ' '.repeat(indent) + (paint || identity)(l)).join('\n') + '\n';

  /** Label and text in two columns; long text wraps with a hanging indent. */
  function rows(ctx, pairs, paint) {
    const keyWidth = Math.max.apply(null, pairs.map((r) => r[0].length)) + 2;
    const width = textWidth(ctx) - 2 - keyWidth;
    let out = '';
    for (const [key, text] of pairs) {
      const lines = wrap(text, width);
      out += '  ' + (paint || identity)(key.padEnd(keyWidth)) + lines[0] + '\n';
      for (const l of lines.slice(1)) out += ' '.repeat(2 + keyWidth) + l + '\n';
    }
    return out;
  }

  /**
   * Aligned columns under a header row. The last column takes what is left of the
   * line and wraps; on a terminal too narrow for that it moves to lines of its own.
   * `paints` may give a colour function for each column.
   */
  function table(ctx, head, body, paints) {
    const last = head.length - 1;
    const widths = head.map((h, i) => Math.max.apply(null, [h].concat(body.map((r) => r[i])).map((cell) => cell.length)));
    const indent = 2 + widths.slice(0, last).reduce((sum, w) => sum + w + 2, 0);
    const stacked = textWidth(ctx) - indent < 24;
    const hang = stacked ? 6 : indent;
    const line = (cells, paint) => {
      // the cell that ends a line is not padded, so no line ends in spaces
      const fixed = cells.slice(0, last).map((cell, i) => paint(i)(stacked && i === last - 1 ? cell : cell.padEnd(widths[i])));
      const text = wrap(cells[last], textWidth(ctx) - hang).map(paint(last));
      if (stacked) return '  ' + fixed.join('  ') + '\n' + text.map((l) => ' '.repeat(hang) + l + '\n').join('');
      return text.map((l, n) => (n ? ' '.repeat(hang) : '  ' + fixed.concat('').join('  ')) + l + '\n').join('');
    };
    return line(head, () => pen(ctx).head) + body.map((r) => line(r, (i) => (paints && paints[i]) || identity)).join('');
  }

  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  /* ------------------------------------------------------------- time speed */
  const SPEEDS = [
    { name: 'realtime', scale: 1, label: 'real time', note: 'waits take as long as on a real system' },
    { name: 'fast', scale: 0.25, label: 'fast', note: 'waits are four times shorter' },
    { name: 'instant', scale: 0, label: 'instant', note: 'nothing waits' },
  ];
  const MAX_SCALE = 10;

  function describeSpeed(scale) {
    const s = SPEEDS.find((x) => x.scale === scale);
    return (s ? s.label : 'custom') + ' (time scale ' + scale + ')';
  }

  /** Time scale for a `kalima speed` argument, or null when it is not one. */
  function parseSpeed(word) {
    const named = SPEEDS.find((s) => s.name === word.toLowerCase());
    if (named) return named.scale;
    if (!/^(\d+\.?\d*|\.\d+)$/.test(word)) return null;
    const n = parseFloat(word);
    return n <= MAX_SCALE ? n : null;
  }

  function cmdSpeed(ctx, args) {
    const p = pen(ctx);
    if (args.length > 1) return usageError(ctx, 'speed: too many arguments');
    if (args.length) {
      const scale = parseSpeed(args[0]);
      if (scale == null) return usageError(ctx, "speed: invalid time scale '" + args[0] + "'\nUse realtime, fast, instant or a number from 0 to " + MAX_SCALE + '.', true);
      K.settings.timeScale = scale;
      K.events.emit('settings', { timeScale: scale });
      ctx.println('Simulated time: ' + describeSpeed(scale));
      return 0;
    }
    const current = K.settings.timeScale;
    let out = 'Simulated time: ' + p.head(describeSpeed(current)) + '\n\n';
    for (const s of SPEEDS) {
      const line = (s.scale === current ? '* ' : '  ') + s.name.padEnd(10) + String(s.scale).padEnd(6) + s.note;
      out += (s.scale === current ? p.ok(line) : line) + '\n';
    }
    out += '  ' + 'NUMBER'.padEnd(16) + 'a time scale of your own, from 0 to ' + MAX_SCALE + '\n';
    out += '\nChange it with: ' + p.key('kalima speed realtime|fast|instant|NUMBER') + '\n';
    ctx.out(out);
    return 0;
  }

  /* ----------------------------------------------------------- help, status */
  const SUBCOMMANDS = [
    ['help', '', 'this overview'],
    ['status', '', 'the release being simulated, time speed and lesson progress'],
    ['scope', '', 'the engagement scope, the rules in brief and the scope guard'],
    ['hosts', '[--all]', 'lab hosts that have answered you so far'],
    ['lessons', '', 'modules and lessons with completion marks'],
    ['atlas', '[CATEGORY|TOOL]', 'browse the catalogue of Kali tools'],
    ['speed', '[MODE]', 'show or set how fast simulated time passes'],
    ['reset', '[--yes]', 'restart the simulated machine and the lab'],
    ['about', '', 'version, and what is and is not simulated'],
  ];
  const usageOf = ([name, arg]) => name + (arg ? ' ' + arg : '');

  const KEYS = [
    ['Tab', 'complete a command, an option or a file name'],
    ['Up, Down', 'earlier and later commands from the history'],
    ['Ctrl-R', 'search the history'],
    ['Ctrl-C', 'interrupt the running command'],
    ['Ctrl-L', 'clear the screen'],
    ['Ctrl-A, Ctrl-E', 'jump to the start or the end of the line'],
    ['Ctrl-U, Ctrl-W', 'delete the line, or the word before the cursor'],
    ['Ctrl-D', 'end of input; on an empty line, log out'],
  ];

  const ENGAGEMENT_FILES = [
    ['scope.txt', 'what you are allowed to test'],
    ['rules-of-engagement.txt', 'how you agreed to work'],
    ['credentials.txt', 'the test account the client supplied'],
    ['notes.md, scans/', 'your own notes and saved tool output'],
  ];

  const banner = (ctx) => pen(ctx).head('Kalima ' + K.version) + '\n' +
    para(ctx, 'An offline training simulator for ' + K.distro.name + ' ' + K.distro.release + '.', 0) + '\n';

  function scopeList(e) { return e.scope.concat((e.domains || []).map((d) => '*.' + d)); }

  function cmdHelp(ctx) {
    const p = pen(ctx); const e = K.net.world.engagement;
    const usage = SUBCOMMANDS.map((sub) => ['kalima ' + usageOf(sub), sub[2]]);
    ctx.out(
      banner(ctx) +
      para(ctx, 'This terminal, its filesystem, the lab network and the "internet" behind it are all simulated. Nothing you type leaves this page, so you can experiment freely.', 0) + '\n' +
      p.head('LEARNING') + '\n' +
      rows(ctx, [
        ['Lessons', 'Pick a lesson in the Lessons panel and follow its steps in this terminal. A step is marked done when the line you type achieves what it asks. Hints and solutions are there when you are stuck.'],
        ['Free practice', 'The terminal does not need a lesson. Explore the lab network ' + e.scope.join(', ') + ' whenever you like.'],
      ]) + '\n' +
      p.head('THE ENGAGEMENT') + '\n' +
      para(ctx, 'You are the tester on engagement ' + e.id + ' for ' + e.client + '. The paperwork is in ~/engagement:', 2) +
      rows(ctx, ENGAGEMENT_FILES, p.key) + '\n' +
      p.head('COMMANDS') + '\n' + rows(ctx, usage, p.key) + '\n' +
      p.head('HELP ON ANY COMMAND') + '\n' +
      rows(ctx, [
        ['man COMMAND', 'the manual page (q closes it)'],
        ['COMMAND --help', 'a short usage summary'],
        ['apropos WORD', 'search the manual page descriptions'],
      ], p.key) + '\n' +
      p.head('KEYS') + '\n' + rows(ctx, KEYS, p.key));
    return 0;
  }

  function lessonLine() {
    const s = K.lessons.progress.summary();
    if (!s.total) return 'no lesson packs are loaded';
    return s.done + ' of ' + s.total + ' completed (' + Math.round((100 * s.done) / s.total) + '%)';
  }

  function machineLine(machine) {
    const i = machine.primaryIface();
    return machine.hostname + (i ? ', ' + i.ip + '/' + i.bits + ' on ' + i.name : '');
  }

  function cmdStatus(ctx, args) {
    if (!subArgs(ctx, 'status', args)) return 2;
    const p = pen(ctx); const d = K.distro; const e = K.net.world.engagement;
    const atlas = K.atlas.list();
    ctx.out(p.head('Kalima ' + K.version) + '\n\n' + rows(ctx, [
      ['Simulating', d.pretty + ' ' + d.release + ' (' + d.codename + ')'],
      ['Kernel', d.kernel],
      ['Machine', machineLine(ctx.machine)],
      ['Engagement', e.id + ', scope ' + scopeList(e).join(' and ')],
      ['Simulated time', describeSpeed(K.settings.timeScale)],
      ['Scope guard', K.settings.scopeGuard ? 'on' : 'off'],
      ['Lessons', lessonLine()],
      ['Tool atlas', atlas.length + ' tools catalogued, ' + simulatedIn(atlas) + ' of them simulated'],
    ], p.key));
    return 0;
  }

  /* ------------------------------------------------------------------ scope */
  // The numbered rules of ~/engagement/rules-of-engagement.txt, one line each.
  const RULES = [
    ['Authorization', 'you hold written permission for the addresses in scope and for nothing else'],
    ['Scope', 'active testing stays inside the in-scope ranges'],
    ['Do no harm', 'prefer the least intrusive technique that answers the question'],
    ['Handle data with care', 'what you see belongs to the client; record only what the report needs'],
    ['Record what you do', 'keep commands and times so that every finding can be reproduced'],
    ['Stop and report', 'on signs of a real incident, or of anything outside the agreed scope, stop and contact the client'],
  ];

  const GUARD_ON = 'The scope guard is on. Active testing tools, such as port scanners, check every target against this scope before they send anything, and refuse a target outside it with an explanation. Ordinary client tools such as ping, dig, whois and curl are not held back: looking something up is not testing it.';
  const GUARD_OFF = 'The scope guard is off. Active testing tools no longer check their targets against this scope. The scope itself has not changed, and neither have the rules.';

  function cmdScope(ctx, args) {
    if (!subArgs(ctx, 'scope', args)) return 2;
    const p = pen(ctx); const e = K.net.world.engagement;
    const excluded = (e.exclude || []).length ? para(ctx, 'Excluded from the ranges above: ' + e.exclude.join(', ') + '.', 2) : '';
    ctx.out(
      p.head('Engagement ' + e.id) + '\n' + para(ctx, e.name, 0) + '\n' +
      rows(ctx, [['Client', e.client], ['Window', e.window], ['Contact', e.contact]], p.key) + '\n' +
      p.head('IN SCOPE') + '\n' + scopeList(e).map((s) => '  ' + p.ok(s) + '\n').join('') + '\n' +
      p.head('OUT OF SCOPE') + '\n' + excluded +
      para(ctx, 'Everything else, including the public internet. Looking up public records (DNS, WHOIS) is permitted; active testing is not.', 2) + '\n' +
      p.head('RULES IN BRIEF') + '\n' + rows(ctx, RULES.map(([title, text], i) => [(i + 1) + '. ' + title, text])) +
      para(ctx, 'The full text is in ~/engagement/rules-of-engagement.txt.', 2) + '\n' +
      p.head('SCOPE GUARD') + '\n' + para(ctx, K.settings.scopeGuard ? GUARD_ON : GUARD_OFF, 2));
    return 0;
  }

  /* ------------------------------------------------------- discovered hosts
   * A lab host counts as discovered once it has answered something: any packet
   * it sent back, or a connection one of its services accepted. The record
   * belongs to one world, so a new boot starts with nothing discovered.
   */
  const seen = { world: null, hosts: new Map(), unwatch: [] };

  /** Address -> set of open ports ('80/tcp') seen on it, for the current world. */
  function seenHosts() {
    if (seen.world !== K.net.world) { seen.world = K.net.world; seen.hosts = new Map(); }
    return seen.hosts;
  }

  const isLabHost = (h) => !!h && !h.inet && h.id !== 'kali' && K.net.inScope(h.ip);
  const labHosts = () => K.net.hosts.filter(isLabHost);
  const labHostAt = (ip) => { const h = K.net.knownHost(ip); return isLabHost(h) ? h : null; };

  function noteHost(host, port) {
    const found = seenHosts();
    if (!found.has(host.ip)) found.set(host.ip, new Set());
    if (port) found.get(host.ip).add(port);
  }

  function sawPacket(p) {
    const host = labHostAt(p.src);
    if (host) noteHost(host, p.proto === 'TCP' && p.flags === 'S.' ? p.sport + '/tcp' : null);
  }

  function sawConn(c) {
    const host = c.host && labHostAt(c.host.ip);
    if (host) noteHost(host, c.port + '/' + c.proto);
  }

  /** (Re)subscribe to the network bus; K.boot() may have replaced it along with the world. */
  function watchNetwork() {
    for (const off of seen.unwatch) off();
    seen.unwatch = [K.net.bus.on('packet', sawPacket), K.net.bus.on('conn', sawConn)];
  }
  watchNetwork();
  K.events.on('boot', watchNetwork);

  const byAddress = (a, b) => U.ipToInt(a.ip) - U.ipToInt(b.ip);
  const byPort = (a, b) => parseInt(a, 10) - parseInt(b, 10) || (a < b ? -1 : 1);
  const portList = (ports) => (ports && ports.size ? Array.from(ports).sort(byPort).join(' ') : '-');
  const hostName = (h) => h.fqdn || h.hostname;

  const HOSTS_HINT = 'A host is listed once it has replied to something you sent, and a port once a connection to it succeeded.';
  const HOSTS_ALL_HINT = 'kalima hosts --all lists every lab host. That is a spoiler: finding them is part of the exercise.';

  function hostsFound(ctx) {
    const p = pen(ctx); const found = seenHosts();
    const hosts = labHosts().filter((h) => found.has(h.ip)).sort(byAddress);
    const lab = K.net.world.engagement.scope.join(', ');
    if (!hosts.length) return 'No lab host has answered you yet.\n\n' + para(ctx, HOSTS_HINT + ' The lab network is ' + lab + '.', 0) + para(ctx, HOSTS_ALL_HINT, 0);
    return 'Lab hosts that have answered you so far: ' + p.head(String(hosts.length)) + '\n\n' +
      table(ctx, ['ADDRESS', 'NAME', 'OPEN PORTS SEEN'], hosts.map((h) => [h.ip, hostName(h), portList(found.get(h.ip))]), [p.key]) + '\n' +
      para(ctx, HOSTS_HINT, 0) + para(ctx, HOSTS_ALL_HINT, 0);
  }

  function hostsAll(ctx) {
    const p = pen(ctx); const found = seenHosts();
    const hosts = labHosts().sort(byAddress);
    const body = hosts.map((h) => [h.ip, hostName(h), h.kind || 'host', found.has(h.ip) ? 'yes' : 'no', portList(found.get(h.ip))]);
    return para(ctx, 'Spoiler: this is the whole lab, including hosts you have not found yet.', 0, p.warn) + '\n' +
      table(ctx, ['ADDRESS', 'NAME', 'ROLE', 'FOUND', 'OPEN PORTS SEEN'], body, [p.key, null, null, (cell) => (cell.trim() === 'yes' ? p.ok(cell) : cell)]) + '\n' +
      para(ctx, plural(hosts.filter((h) => found.has(h.ip)).length, 'host') + ' of ' + hosts.length + ' found. Open ports are still listed only where you have seen them.', 0);
  }

  function cmdHosts(ctx, args) {
    const g = subArgs(ctx, 'hosts', args, { short: 'a', long: ['all'], alias: { all: 'a' } });
    if (!g) return 2;
    ctx.out(g.opts.a ? hostsAll(ctx) : hostsFound(ctx));
    return 0;
  }

  /* ---------------------------------------------------------------- lessons */
  const MARKS = { done: '[x]', started: '[~]', open: '[ ]' };

  function lessonState(lesson) {
    const progress = K.lessons.progress.of(lesson.id);
    if (progress.done) return 'done';
    return Object.keys(progress.steps).length ? 'started' : 'open';
  }

  function cmdLessons(ctx, args) {
    if (!subArgs(ctx, 'lessons', args)) return 2;
    if (!K.lessons.modules.length) { ctx.println('No lesson packs are loaded.'); return 0; }
    const p = pen(ctx); const paint = { done: p.ok, started: p.warn, open: identity };
    let out = 'Lessons: ' + lessonLine() + '\n';
    for (const mod of K.lessons.modules) {
      const done = mod.lessons.filter((l) => K.lessons.progress.isDone(l.id)).length;
      out += '\n' + p.head(mod.title) + p.dim('  ' + done + ' of ' + mod.lessons.length) + '\n';
      for (const lesson of mod.lessons) {
        const state = lessonState(lesson);
        const title = lesson.title + (lesson.minutes ? ' (' + lesson.minutes + ' min)' : '');
        out += '  ' + paint[state](MARKS[state]) + ' ' + wrap(title, textWidth(ctx) - 6).join('\n      ') + '\n';
      }
    }
    ctx.out(out + '\n' + p.dim(MARKS.done + ' completed   ' + MARKS.started + ' started   ' + MARKS.open + ' not started') + '\n' +
      para(ctx, 'Lessons are opened from the Lessons panel, next to this terminal.', 0));
    return 0;
  }

  /* ------------------------------------------------------------------ reset */
  const RESET_NOTICE = 'This restarts the simulated machine and rebuilds the lab network. Running programs stop and every change outside your home directory is undone. Your home directory and your lesson progress are kept.';

  async function cmdReset(ctx, args) {
    const g = subArgs(ctx, 'reset', args, { short: 'y', long: ['yes'], alias: { yes: 'y' } });
    if (!g) return 2;
    ctx.out(para(ctx, RESET_NOTICE, 0));
    if (!g.opts.y) {
      const answer = await ctx.readLine('Restart now? [y/N] ');
      if (answer == null && ctx.stdin == null) ctx.println('');
      if (!/^y(es)?$/i.test((answer || '').trim())) { ctx.println('Nothing was reset.'); return 1; }
    }
    ctx.println('Restarting the simulator...');
    K.events.emit('power', { action: 'reset' });
    return 0;
  }

  /* ------------------------------------------------------------------ about */
  function simulatedCommandCount() { return K.cmd.list().filter((d) => !d.stub && !d.aliasOf).length; }

  function cmdAbout(ctx, args) {
    if (!subArgs(ctx, 'about', args)) return 2;
    const p = pen(ctx); const e = K.net.world.engagement;
    const labHosts = K.net.hosts.filter((h) => h.id !== 'kali').length;
    const bullets = (items) => items.map((t) => wrap(t, textWidth(ctx) - 4).map((l, i) => (i ? '    ' : '  - ') + l).join('\n')).join('\n') + '\n';
    ctx.out(
      banner(ctx) +
      p.head('SIMULATED') + '\n' + bullets([
        'A Kali workstation as seen from its terminal: zsh, a filesystem with users and permissions, processes, services and packages.',
        plural(simulatedCommandCount(), 'command') + ' that print what the real programs print, including their error messages and exit codes.',
        'A lab network (' + e.scope.join(', ') + ') with ' + plural(labHosts, 'host') + ', and a small pretend internet for client tools to talk to.',
      ]) + '\n' +
      p.head('NOT SIMULATED') + '\n' + bullets([
        'A real network. No packet ever leaves this page.',
        'A kernel, hardware or the graphical desktop. Programs that need a window do not run.',
        'Most of Kali\'s specialist tools. They are catalogued, not imitated, and say so when you run them.',
        'Attacks. The simulator carries no exploit code, no malware and no real credentials.',
      ]) + '\n' +
      p.head('FICTIONAL') + '\n' +
      para(ctx, e.client.replace(/\s*\(fictional\)/, '') + ', its hosts, people, accounts and data are invented for this lab. Any resemblance to real organisations or systems is coincidental.', 2) + '\n' +
      p.head('REAL WORK') + '\n' +
      para(ctx, 'On a real network the same tools need written authorization from the system owner. Testing systems without permission is illegal in most jurisdictions.', 2));
    return 0;
  }

  /* -------------------------------------------------------------- catalogue
   * Categories follow the classic Kali applications menu, plus one group for
   * the general-purpose programs around it.
   */
  const CATEGORIES = [
    { id: 'information-gathering', title: 'Information Gathering',
      summary: 'Finding out what exists: hosts, names, open ports, services and the public footprint of an organisation. This is the discovery phase of NIST SP 800-115, and every later step of an assessment depends on how complete its picture is.' },
    { id: 'vulnerability-analysis', title: 'Vulnerability Analysis',
      summary: 'Comparing what was discovered against known weaknesses and insecure configuration. NIST SP 800-115 calls this vulnerability scanning and places it at the end of discovery. Its results are leads, which still have to be confirmed by hand.' },
    { id: 'web-application-analysis', title: 'Web Application Analysis',
      summary: 'Examining web sites and the applications behind them: their content, technology, inputs and session handling. Web applications have a methodology of their own, the OWASP Web Security Testing Guide, which is used alongside the discovery and attack phases of NIST SP 800-115.' },
    { id: 'database-assessment', title: 'Database Assessment',
      summary: 'Checking how database servers are exposed and configured, and how the applications in front of them pass input on. It sits between vulnerability analysis and validation. Databases hold what an intruder is usually after, so their weaknesses weigh heavily in a report.' },
    { id: 'password-attacks', title: 'Password Attacks',
      summary: 'Testing whether passwords and stored password hashes resist guessing. NIST SP 800-115 lists password cracking among the techniques that validate a vulnerability. In an assessment it shows whether a password policy holds in practice.' },
    { id: 'wireless-attacks', title: 'Wireless Attacks',
      summary: 'Assessing Wi-Fi, Bluetooth and other radio links: which networks exist, how they are protected and whether unauthorised devices are present. NIST SP 800-115 treats wireless scanning as a discovery technique of its own, because radio does not stop at the walls of a building.' },
    { id: 'reverse-engineering', title: 'Reverse Engineering',
      summary: 'Working out what a program does without its source code, by disassembling, decompiling or debugging it. It is a supporting skill, not a phase: analysts use it to understand unknown binaries, firmware and malware samples that turn up during other work.' },
    { id: 'exploitation-tools', title: 'Exploitation Tools',
      summary: 'Demonstrating that a weakness can really be used, within the limits the rules of engagement set. This is the attack phase of NIST SP 800-115, where a suspected vulnerability is validated. A confirmed finding usually leads back into further discovery.' },
    { id: 'sniffing-spoofing', title: 'Sniffing and Spoofing',
      summary: 'Capturing and inspecting network traffic, and testing how a network reacts to forged traffic. NIST SP 800-115 counts passive network sniffing among its review techniques. The active, spoofing side belongs to the attack phase and needs explicit permission.' },
    { id: 'post-exploitation', title: 'Post Exploitation',
      summary: 'What a tester does after gaining access: judging how far the access reaches, what it exposes and whether it could be kept. In NIST SP 800-115 these are the later steps of the attack phase, and they are what shows the real impact of a finding.' },
    { id: 'forensics', title: 'Forensics',
      summary: 'Collecting and examining digital evidence from disks, memory and files without altering it. Forensics belongs to incident response, which NIST covers in SP 800-86, not to penetration testing. Kali ships the tools so that it can also serve as an examiner\'s workstation.' },
    { id: 'reporting-tools', title: 'Reporting Tools',
      summary: 'Keeping notes and evidence in order and turning them into a report. Reporting is the last phase of NIST SP 800-115, and note-taking runs alongside all the others. An assessment is only as useful as the report its owner can act on.' },
    { id: 'social-engineering', title: 'Social Engineering Tools',
      summary: 'Testing the human side of security, for example with simulated phishing that the client has agreed to in advance. NIST SP 800-115 lists social engineering among the techniques that validate a vulnerability. It needs particular care with consent, privacy and scope.' },
    { id: 'system-utilities', title: 'System and Utilities',
      summary: 'General-purpose programs that every phase leans on: remote access, file transfer, editors, scripting and the package manager. They are not security tools as such, but most of an assessor\'s time is spent in them.' },
  ];

  /* One row per tool: executable name, package, 1 when it ships in the default
   * desktop install (kali-linux-default), one sentence on what kind of tool it
   * is, and where its reference page lives when that is not the Kali tools page
   * of the package ('man' for a plain Debian tool, else the name of the Kali page).
   */
  const TOOLS = {
    'information-gathering': [
      ['nmap', 'nmap', 1, 'Network exploration tool and security / port scanner'],
      ['masscan', 'masscan', 1, 'TCP port scanner designed to cover large address ranges quickly'],
      ['arp-scan', 'arp-scan', 1, 'ARP scanner that discovers and fingerprints hosts on the local network'],
      ['netdiscover', 'netdiscover', 1, 'Active and passive ARP reconnaissance tool'],
      ['arping', 'arping', 1, 'Sends ARP or ICMP requests to a host on the local network'],
      ['fping', 'fping', 1, 'Sends ICMP echo probes to many hosts at once'],
      ['hping3', 'hping3', 1, 'Command-line TCP/IP packet assembler and analyser'],
      ['traceroute', 'traceroute', 1, 'Traces the route that packets take to a network host', 'man'],
      ['dig', 'bind9-dnsutils', 1, 'DNS lookup utility that queries name servers directly', 'man'],
      ['host', 'bind9-host', 1, 'Simple utility for DNS lookups', 'man'],
      ['nslookup', 'bind9-dnsutils', 1, 'Program for querying Internet domain name servers', 'man'],
      ['whois', 'whois', 1, 'Client for the WHOIS directory service', 'man'],
      ['dnsenum', 'dnsenum', 1, 'Script that enumerates the DNS information of a domain'],
      ['dnsrecon', 'dnsrecon', 1, 'DNS enumeration and reconnaissance script'],
      ['amass', 'amass', 1, 'In-depth attack surface mapping and asset discovery tool'],
      ['theHarvester', 'theharvester', 1, 'Gathers e-mail addresses, names and subdomains from public sources'],
      ['recon-ng', 'recon-ng', 1, 'Modular framework for web-based reconnaissance'],
      ['spiderfoot', 'spiderfoot', 1, 'Automation tool for collecting open-source intelligence'],
      ['maltego', 'maltego', 1, 'Graphical link analysis tool for open-source intelligence'],
      ['legion', 'legion', 1, 'Semi-automated network reconnaissance tool with a graphical interface'],
      ['enum4linux', 'enum4linux', 1, 'Enumerates information from Windows and Samba systems'],
      ['smbmap', 'smbmap', 1, 'Enumerates SMB shares and the permissions on them'],
      ['sslscan', 'sslscan', 1, 'Queries TLS services for the protocols and ciphers they support'],
      ['wafw00f', 'wafw00f', 1, 'Identifies and fingerprints web application firewalls'],
    ],
    'vulnerability-analysis': [
      ['nikto', 'nikto', 1, 'Web server scanner that checks for dangerous files and outdated software'],
      ['lynis', 'lynis', 1, 'Security auditing tool for Unix-based systems'],
      ['unix-privesc-check', 'unix-privesc-check', 1, 'Script that checks a Unix system for simple privilege escalation vectors'],
      ['gvm-start', 'gvm', 0, 'Starts Greenbone Vulnerability Management (OpenVAS), a network vulnerability scanner'],
      ['nuclei', 'nuclei', 0, 'Vulnerability scanner driven by community-maintained templates'],
      ['wapiti', 'wapiti', 0, 'Black-box vulnerability scanner for web applications'],
      ['testssl', 'testssl.sh', 0, 'Checks a TLS server for supported ciphers, protocols and known flaws'],
      ['afl-fuzz', 'afl++', 0, 'Coverage-guided fuzzer for finding bugs in compiled programs', 'aflplusplus'],
    ],
    'web-application-analysis': [
      ['burpsuite', 'burpsuite', 1, 'Integrated platform for security testing of web applications'],
      ['zaproxy', 'zaproxy', 0, 'Zed Attack Proxy, an intercepting proxy and scanner for web applications'],
      ['caido', 'caido', 0, 'Lightweight web security auditing toolkit'],
      ['whatweb', 'whatweb', 1, 'Next generation web scanner that identifies the technologies a website uses'],
      ['dirb', 'dirb', 1, 'Web content scanner that looks for existing and hidden objects'],
      ['dirbuster', 'dirbuster', 1, 'Graphical application for finding directories and files on web servers'],
      ['gobuster', 'gobuster', 0, 'Discovery tool for directories, files, DNS names and virtual hosts, written in Go'],
      ['ffuf', 'ffuf', 1, 'Fast web fuzzer written in Go'],
      ['wfuzz', 'wfuzz', 1, 'Web application fuzzer'],
      ['feroxbuster', 'feroxbuster', 0, 'Recursive content discovery tool written in Rust'],
      ['wpscan', 'wpscan', 1, 'WordPress security scanner'],
      ['skipfish', 'skipfish', 1, 'Automated reconnaissance tool for web application security'],
      ['commix', 'commix', 1, 'Automated tester for command injection flaws in web applications'],
      ['cadaver', 'cadaver', 1, 'Command-line WebDAV client'],
    ],
    'database-assessment': [
      ['sqlmap', 'sqlmap', 1, 'Automatic tool for detecting and testing SQL injection flaws'],
      ['sqlitebrowser', 'sqlitebrowser', 1, 'Graphical browser and editor for SQLite database files'],
      ['sqlite3', 'sqlite3', 1, 'Command-line interface for SQLite databases', 'man'],
      ['mysql', 'mariadb-client', 1, 'Command-line client for MariaDB and MySQL servers', 'man'],
      ['psql', 'postgresql-client', 1, 'Interactive terminal for PostgreSQL', 'man'],
      ['impacket-mssqlclient', 'impacket-scripts', 1, 'Microsoft SQL Server client from the Impacket collection'],
      ['redis-cli', 'redis-tools', 0, 'Command-line client for Redis key-value stores', 'man'],
    ],
    'password-attacks': [
      ['john', 'john', 1, 'John the Ripper, an active password cracking tool'],
      ['hashcat', 'hashcat', 1, 'Advanced password recovery utility that runs on CPUs and GPUs'],
      ['hydra', 'hydra', 1, 'Parallelized login cracker that supports many network protocols'],
      ['medusa', 'medusa', 1, 'Fast, parallel, modular login brute-forcer for network services'],
      ['ncrack', 'ncrack', 1, 'High-speed network authentication cracking tool'],
      ['patator', 'patator', 1, 'Multi-purpose brute-forcer with a modular design'],
      ['crunch', 'crunch', 1, 'Wordlist generator'],
      ['cewl', 'cewl', 1, 'Custom wordlist generator that spiders a website'],
      ['hashid', 'hashid', 1, 'Identifies the different types of hashes'],
      ['ophcrack', 'ophcrack', 1, 'Windows password cracker based on rainbow tables'],
      ['chntpw', 'chntpw', 1, 'Offline editor for Windows NT passwords and registry files'],
      ['wordlists', 'wordlists', 1, 'Collection of wordlists, among them rockyou'],
      ['seclists', 'seclists', 0, 'Collection of the lists that security assessments draw on'],
    ],
    'wireless-attacks': [
      ['aircrack-ng', 'aircrack-ng', 1, 'Key cracker for 802.11 WEP and WPA-PSK, and the suite named after it'],
      ['airmon-ng', 'aircrack-ng', 1, 'Switches wireless interfaces into and out of monitor mode'],
      ['airodump-ng', 'aircrack-ng', 1, 'Captures raw 802.11 frames'],
      ['kismet', 'kismet', 1, 'Wireless network and device detector, sniffer and wardriving tool'],
      ['wifite', 'wifite', 1, 'Automated wireless auditing script'],
      ['reaver', 'reaver', 1, 'Tests the PIN mechanism of Wi-Fi Protected Setup'],
      ['pixiewps', 'pixiewps', 1, 'Offline tool for testing Wi-Fi Protected Setup PINs'],
      ['fern-wifi-cracker', 'fern-wifi-cracker', 1, 'Graphical auditing tool for wireless security'],
      ['hcxdumptool', 'hcxdumptool', 0, 'Captures packets from wireless devices for later analysis'],
      ['bluetoothctl', 'bluez', 1, 'Interactive control tool for Bluetooth devices', 'man'],
      ['iwconfig', 'wireless-tools', 1, 'Configures a wireless network interface', 'man'],
    ],
    'reverse-engineering': [
      ['radare2', 'radare2', 1, 'Reverse engineering framework and command-line hexadecimal editor'],
      ['rizin', 'rizin', 0, 'Reverse engineering framework that began as a fork of radare2'],
      ['ghidra', 'ghidra', 0, 'Software reverse engineering framework with a decompiler'],
      ['gdb', 'gdb', 0, 'The GNU debugger', 'man'],
      ['objdump', 'binutils', 1, 'Displays information from object files, including a disassembly', 'man'],
      ['strings', 'binutils', 1, 'Prints the sequences of printable characters in files', 'man'],
      ['xxd', 'xxd', 1, 'Makes a hex dump of a file, or turns one back into a file', 'man'],
      ['nasm', 'nasm', 1, 'General-purpose x86 assembler', 'man'],
      ['clang', 'clang', 1, 'C, C++ and Objective-C compiler of the LLVM project', 'man'],
      ['apktool', 'apktool', 0, 'Tool for reverse engineering Android application packages'],
      ['jadx', 'jadx', 0, 'Decompiler from Android Dex bytecode to Java'],
    ],
    'exploitation-tools': [
      ['msfconsole', 'metasploit-framework', 1, 'Console of the Metasploit Framework, a penetration testing platform'],
      ['msfvenom', 'metasploit-framework', 1, 'Payload generator and encoder of the Metasploit Framework'],
      ['searchsploit', 'exploitdb', 1, 'Searches the local copy of the Exploit Database archive'],
      ['netexec', 'netexec', 1, 'Network service assessment tool for large networks, successor to CrackMapExec'],
      ['certipy-ad', 'certipy-ad', 1, 'Tool for auditing Active Directory Certificate Services'],
      ['beef-xss', 'beef-xss', 0, 'Browser Exploitation Framework, a testing tool focused on the web browser'],
      ['armitage', 'armitage', 0, 'Graphical front end for the Metasploit Framework'],
      ['routersploit', 'routersploit', 0, 'Exploitation framework for embedded devices'],
    ],
    'sniffing-spoofing': [
      ['wireshark', 'wireshark', 1, 'Graphical network protocol analyser'],
      ['tshark', 'tshark', 1, 'Terminal version of the Wireshark protocol analyser', 'wireshark'],
      ['tcpdump', 'tcpdump', 1, 'Command-line network traffic analyser'],
      ['ettercap', 'ettercap-graphical', 1, 'Multipurpose sniffer and content filter for man-in-the-middle testing on a LAN', 'ettercap'],
      ['bettercap', 'bettercap', 0, 'Modular framework for network monitoring and man-in-the-middle testing'],
      ['arpspoof', 'dsniff', 1, 'Redirects packets on a LAN by forging ARP replies'],
      ['dsniff', 'dsniff', 1, 'Sniffer for passwords sent over cleartext protocols'],
      ['responder', 'responder', 1, 'LLMNR, NBT-NS and mDNS poisoner with built-in rogue authentication servers'],
      ['mitmproxy', 'mitmproxy', 1, 'Interactive intercepting proxy for HTTP and TLS traffic'],
      ['macchanger', 'macchanger', 1, 'Utility for viewing and changing the MAC address of a network interface'],
      ['scapy', 'python3-scapy', 1, 'Interactive packet manipulation program and library', 'scapy'],
      ['netsniff-ng', 'netsniff-ng', 1, 'Packet sniffing toolkit for Linux'],
    ],
    'post-exploitation': [
      ['evil-winrm', 'evil-winrm', 1, 'Windows Remote Management shell for penetration testing'],
      ['impacket-psexec', 'impacket-scripts', 1, 'Remote command execution over SMB, from the Impacket collection'],
      ['mimikatz', 'mimikatz', 1, 'Windows credential tool, shipped as Windows binaries'],
      ['powershell-empire', 'powershell-empire', 1, 'Post-exploitation and adversary emulation framework'],
      ['starkiller', 'starkiller', 1, 'Graphical front end for the Empire framework'],
      ['weevely', 'weevely', 1, 'Web shell for remote administration of PHP servers during a test'],
      ['proxychains4', 'proxychains4', 1, 'Redirects the connections of a program through proxy servers', 'proxychains-ng'],
      ['chisel', 'chisel', 0, 'Fast TCP and UDP tunnel transported over HTTP'],
      ['ligolo-proxy', 'ligolo-ng', 0, 'Proxy side of ligolo-ng, a tunnelling tool built on a TUN interface'],
      ['bloodhound', 'bloodhound', 0, 'Graphical tool that maps relationships in Active Directory environments'],
      ['peass', 'peass', 0, 'Collection of scripts that look for privilege escalation paths', 'peass-ng'],
    ],
    forensics: [
      ['autopsy', 'autopsy', 1, 'Graphical interface to The Sleuth Kit for analysing disk images'],
      ['fls', 'sleuthkit', 1, 'Lists file and directory names in a disk image, from The Sleuth Kit'],
      ['binwalk', 'binwalk', 1, 'Tool for analysing and extracting firmware images'],
      ['bulk_extractor', 'bulk-extractor', 1, 'Extracts features such as e-mail addresses from disk images without parsing the file system'],
      ['foremost', 'foremost', 0, 'Recovers files from disk images by their headers and footers'],
      ['photorec', 'testdisk', 1, 'Recovers lost files from disks and memory cards'],
      ['testdisk', 'testdisk', 1, 'Partition scanner and disk recovery tool'],
      ['guymager', 'guymager', 1, 'Graphical forensic imager for acquiring media'],
      ['hashdeep', 'hashdeep', 1, 'Computes and audits hashes for any number of files, recursively'],
      ['exiftool', 'libimage-exiftool-perl', 1, 'Reads and writes metadata in image and other files'],
      ['steghide', 'steghide', 0, 'Steganography program that hides data in image and audio files'],
    ],
    'reporting-tools': [
      ['cherrytree', 'cherrytree', 1, 'Hierarchical note-taking application with rich text and syntax highlighting'],
      ['cutycapt', 'cutycapt', 1, 'Captures a web page, as WebKit renders it, into an image or document'],
      ['eyewitness', 'eyewitness', 0, 'Takes screenshots of websites and collects their server header information'],
      ['faraday', 'faraday', 1, 'Collaborative platform for managing penetration test results'],
      ['dradis', 'dradis', 0, 'Collaboration and reporting framework for security assessments'],
      ['pipal', 'pipal', 1, 'Statistical analyser for password lists'],
      ['recordmydesktop', 'recordmydesktop', 1, 'Records a desktop session as video'],
      ['script', 'bsdutils', 1, 'Makes a typescript of a terminal session', 'man'],
    ],
    'social-engineering': [
      ['setoolkit', 'set', 1, 'Social-Engineer Toolkit, a framework for social engineering exercises'],
      ['gophish', 'gophish', 0, 'Open-source toolkit for phishing simulations'],
      ['evilginx2', 'evilginx2', 0, 'Reverse proxy framework for phishing simulations'],
      ['wifiphisher', 'wifiphisher', 0, 'Rogue access point framework for Wi-Fi security testing'],
      ['dnstwist', 'dnstwist', 0, 'Finds look-alike domain names of a given domain'],
    ],
    'system-utilities': [
      ['ssh', 'openssh-client', 1, 'OpenSSH remote login client'],
      ['curl', 'curl', 1, 'Transfers data from or to a server using URLs'],
      ['wget', 'wget', 1, 'Non-interactive network downloader'],
      ['nc', 'netcat-traditional', 1, 'TCP/IP swiss army knife'],
      ['socat', 'socat', 1, 'Multipurpose relay for bidirectional data transfer'],
      ['telnet', 'inetutils-telnet', 1, 'Client for the TELNET protocol'],
      ['ftp', 'tnftp', 1, 'Internet file transfer program'],
      ['smbclient', 'smbclient', 1, 'FTP-like client for file shares on SMB servers'],
      ['ping', 'iputils-ping', 1, 'Sends ICMP echo requests to network hosts'],
      ['ip', 'iproute2', 1, 'Shows and changes routing, network devices and interfaces'],
      ['python3', 'python3', 1, 'Interpreter for the Python programming language'],
      ['vim', 'vim', 1, 'Vi IMproved, a text editor for programmers'],
      ['tmux', 'tmux', 1, 'Terminal multiplexer'],
      ['git', 'git', 1, 'Distributed revision control system'],
      ['openssl', 'openssl', 1, 'Command-line tool of the OpenSSL cryptography toolkit'],
      ['apt', 'apt', 1, 'Command-line interface of the package manager'],
      ['kali-tweaks', 'kali-tweaks', 1, 'Configuration helper for Kali Linux', 'kali-tweaks'],
    ],
  };

  const kaliPage = (page) => 'https://www.kali.org/tools/' + page + '/';
  const manPage = (name) => 'https://manpages.debian.org/' + name;

  K.atlas.categories = CATEGORIES;
  for (const category of CATEGORIES) {
    const generic = category.id === 'system-utilities';
    for (const [name, pkg, inDefault, summary, page] of TOOLS[category.id]) {
      const url = page === 'man' || (generic && !page) ? manPage(name) : kaliPage(page || pkg);
      K.atlas.register({ name, pkg, category: category.id, summary, installed: !!inDefault, url });
    }
  }

  /** A catalogue tool is simulated when a real command, not a placeholder, is registered under its name. */
  K.atlas.isSimulated = (name) => { const def = K.cmd.get(name); return !!def && !def.stub; };

  const categoryOf = (tool) => CATEGORIES.find((c) => c.id === tool.category);
  const toolsIn = (category) => K.atlas.list().filter((t) => t.category === category.id);
  const simulatedIn = (tools) => tools.filter((t) => K.atlas.isSimulated(t.name)).length;
  const yesNo = (flag) => (flag ? 'yes' : 'no');

  /* ----------------------------------------------------------- kalima atlas */
  function atlasOverview(ctx) {
    const p = pen(ctx); const all = K.atlas.list();
    const body = CATEGORIES.map((c) => { const tools = toolsIn(c); return [c.id, String(tools.length), String(simulatedIn(tools)), c.title]; });
    return p.head('Kali tool atlas') + '\n' +
      para(ctx, 'A map of the toolbox: ' + all.length + ' tools in ' + CATEGORIES.length + ' categories, ' + simulatedIn(all) + ' of them simulated in this build. An entry says what kind of tool something is, not how to use it.', 0) + '\n' +
      table(ctx, ['CATEGORY', 'TOOLS', 'SIMULATED', 'TITLE'], body, [p.key]) + '\n' +
      rows(ctx, [
        ['kalima atlas CATEGORY', 'the tools of a category; the beginning of its name is enough, as in kalima atlas web'],
        ['kalima atlas TOOL', 'the entry of one tool'],
      ], p.key);
  }

  const paintYes = (ctx) => (cell) => (cell.trim() === 'yes' ? pen(ctx).ok(cell) : cell);

  function atlasCategory(ctx, category) {
    const p = pen(ctx); const tools = toolsIn(category);
    const body = tools.map((t) => [t.name, yesNo(K.atlas.isSimulated(t.name)), yesNo(t.installed), t.summary]);
    return p.head(category.title) + p.dim('  ' + plural(tools.length, 'tool') + ', ' + simulatedIn(tools) + ' simulated') + '\n' +
      para(ctx, category.summary, 2) + '\n' +
      table(ctx, ['TOOL', 'SIMULATED', 'DEFAULT', 'WHAT IT IS'], body, [p.key, paintYes(ctx)]) + '\n' +
      rows(ctx, [
        ['SIMULATED', 'this build imitates the tool, so it can be run here'],
        ['DEFAULT', 'the tool ships in the default Kali desktop install (kali-linux-default)'],
      ], p.dim) +
      para(ctx, 'kalima atlas TOOL shows one entry.', 0);
  }

  function atlasTool(ctx, tool) {
    const p = pen(ctx); const simulated = K.atlas.isSimulated(tool.name);
    return p.head(tool.name) + '\n' + para(ctx, tool.summary + '.', 0) + '\n' + rows(ctx, [
      ['Category', categoryOf(tool).title],
      ['Package', tool.pkg],
      ['Default install', tool.installed ? 'yes, as part of kali-linux-default' : 'no; Kali adds it with: sudo apt install ' + tool.pkg],
      ['In this build', simulated ? 'simulated; man ' + tool.name + ' describes what works here' : 'not simulated; this entry is all the simulator knows about it'],
      ['Reference', tool.url],
    ], p.key);
  }

  /** The tool or category a word names: an exact tool name first, then a category by id, title or unique beginning. */
  function atlasLookup(word) {
    const w = word.toLowerCase();
    const tool = K.atlas.get(word) || K.atlas.list().find((t) => t.name.toLowerCase() === w);
    if (tool) return { tool };
    const exact = CATEGORIES.find((c) => c.id === w || c.title.toLowerCase() === w);
    const starting = exact ? [exact] : CATEGORIES.filter((c) => c.id.startsWith(w) || c.title.toLowerCase().startsWith(w));
    if (starting.length === 1) return { category: starting[0] };
    return { ambiguous: starting, similar: K.atlas.list().filter((t) => t.name.toLowerCase().includes(w)) };
  }

  function cmdAtlas(ctx, args) {
    const g = subArgs(ctx, 'atlas', args, {}, 1);
    if (!g) return 2;
    if (!g.rest.length) { ctx.out(atlasOverview(ctx)); return 0; }
    const hit = atlasLookup(g.rest[0]);
    if (hit.tool) { ctx.out(atlasTool(ctx, hit.tool)); return 0; }
    if (hit.category) { ctx.out(atlasCategory(ctx, hit.category)); return 0; }
    const names = (list, key) => list.map((x) => x[key]).join(', ');
    if (hit.ambiguous.length) return ctx.fail("atlas: '" + g.rest[0] + "' could be any of these categories: " + names(hit.ambiguous, 'id'));
    return ctx.fail("atlas: no category or tool named '" + g.rest[0] + "'\n" +
      (hit.similar.length ? 'Tools with a similar name: ' + names(hit.similar, 'name') : "Run 'kalima atlas' for the list of categories."));
  }

  /* ------------------------------------------------------------------ stubs
   * Catalogue tools that no pack simulates still get an executable, so that a
   * learner who runs one is told plainly where the simulation ends. A pack
   * that registers the real command later simply replaces the placeholder.
   */
  const SBIN = ['netdiscover', 'hping3', 'lynis', 'airmon-ng', 'airodump-ng', 'wifite', 'arpspoof', 'dsniff', 'responder', 'netsniff-ng'];

  function stubNotice(ctx, tool, p) {
    return para(ctx, '[kalima] ' + tool.name + ' is a real Kali Linux tool, but this build does not simulate it.', 0, p.warn) + rows(ctx, [
      ['What it is', tool.summary],
      ['Category', categoryOf(tool).title],
      ['Catalogue entry', 'kalima atlas ' + tool.name],
    ], p.key);
  }

  function registerStub(tool) {
    const sbin = SBIN.includes(tool.name);
    K.cmd.register({
      name: tool.name,
      pkg: tool.pkg,
      path: (sbin ? '/usr/sbin/' : '/usr/bin/') + tool.name,
      section: sbin ? 8 : 1,
      only: 'kali',
      installed: tool.installed,
      stub: true,
      summary: tool.summary,
      man: 'DESCRIPTION\n       ' + tool.name + ' is a real Kali Linux tool from the ' + categoryOf(tool).title + ' category, shipped in the package ' + tool.pkg + '. This build of the Kalima simulator lists it in its catalogue but does not simulate it: running ' + tool.name + ' here prints a notice and does nothing else.\n\n' +
        '       This page stands in for the manual page of the real tool, which is not reproduced.\n\n' +
        'SEE ALSO\n       kalima atlas ' + tool.name + '\n       ' + tool.url,
      run(ctx) {
        const help = ctx.args.includes('--help') || ctx.args.includes('-h');
        if (help) ctx.out(stubNotice(ctx, tool, pen(ctx))); else ctx.err(stubNotice(ctx, tool, errPen(ctx)));
        return help ? 0 : 1;
      },
    });
  }

  for (const tool of K.atlas.list()) if (!K.cmd.has(tool.name)) registerStub(tool);

  /* ---------------------------------------------------------------- kalima */
  const TRY_HELP = "Try 'kalima help' for a list of commands.";

  /** Report a mistake in how kalima was called; exit status 2. */
  function usageError(ctx, msg, noHint) { return ctx.fail(msg + (noHint ? '' : '\n' + TRY_HELP), 2); }

  /** Parsed arguments of a subcommand, or null after reporting what is wrong with them. */
  function subArgs(ctx, sub, args, spec, positional) {
    const g = K.getopt(args, spec || {});
    if (!g.err && g.rest.length <= (positional || 0)) return g;
    usageError(ctx, sub + ': ' + (g.err || 'too many arguments'));
    return null;
  }

  const HANDLERS = { help: cmdHelp, status: cmdStatus, scope: cmdScope, hosts: cmdHosts, lessons: cmdLessons, atlas: cmdAtlas, speed: cmdSpeed, reset: cmdReset, about: cmdAbout };

  function usageText() {
    const options = [['-h, --help', 'display this help and exit'], ['-V, --version', 'output version information and exit']];
    const width = Math.max.apply(null, SUBCOMMANDS.map((sub) => usageOf(sub).length)) + 2;
    const list = (pairs) => pairs.map(([key, text]) => '  ' + key.padEnd(width) + text + '\n').join('');
    return 'Usage: kalima [COMMAND] [ARGUMENT]...\n\n' + list(SUBCOMMANDS.map((sub) => [usageOf(sub), sub[2]])) + '\n' + list(options);
  }

  K.cmd.register({
    name: 'kalima',
    pkg: 'kalima',
    only: 'kali',
    summary: 'control and explore the Kalima training simulator',
    synopsis: 'kalima [COMMAND] [ARGUMENT]...',
    man: () => 'DESCRIPTION\n' +
      '       kalima belongs to the simulator, not to Kali Linux. It explains how the simulator works, shows the state of the training lab and changes a few simulator settings. Without a command it prints the overview that kalima help prints.\n\n' +
      'COMMANDS\n' + SUBCOMMANDS.map((sub) => '       ' + usageOf(sub) + '\n              ' + sub[2][0].toUpperCase() + sub[2].slice(1) + '.').join('\n\n') + '\n\n' +
      'OPTIONS\n       -h, --help\n              Display a usage summary and exit.\n\n       -V, --version\n              Output version information and exit.\n\n' +
      'EXIT STATUS\n       0 on success, 1 when a command could not do what was asked, 2 when kalima was called incorrectly.\n\n' +
      'EXAMPLES\n       kalima status\n              Show what is being simulated and how far the lessons have been completed.\n\n       kalima hosts\n              List the lab hosts that have replied so far, with the open ports seen on each.\n\n       kalima atlas password-attacks\n              List the catalogued password tools and whether this build simulates them.\n\n       kalima speed fast\n              Shorten every simulated wait, such as the second between two pings.',
    run(ctx) {
      const [sub, ...args] = ctx.args;
      if (sub == null) return cmdHelp(ctx);
      if (sub === '-h' || sub === '--help') { ctx.out(usageText()); return 0; }
      if (sub === '-V' || sub === '--version') { ctx.println('kalima ' + K.version); return 0; }
      if (sub[0] === '-') return usageError(ctx, (sub.startsWith('--') ? "unrecognized option '" + sub + "'" : "invalid option -- '" + sub[1] + "'"));
      const handler = Object.prototype.hasOwnProperty.call(HANDLERS, sub) ? HANDLERS[sub] : null;
      if (!handler) return usageError(ctx, "unknown command '" + sub + "'");
      return handler(ctx, args);
    },
    complete(info) {
      if (info.index === 1) return SUBCOMMANDS.map((s) => s[0]);
      if (info.index !== 2) return [];
      if (info.words[1] === 'speed') return SPEEDS.map((s) => s.name);
      if (info.words[1] === 'hosts') return ['--all'];
      if (info.words[1] === 'reset') return ['--yes'];
      if (info.words[1] === 'atlas') return CATEGORIES.map((c) => c.id).concat(K.atlas.list().map((t) => t.name));
      return [];
    },
  });

  /* zsh has no `help` builtin; a learner who types it should still land somewhere useful. */
  K.cmd.register({
    name: 'help',
    pkg: 'kalima',
    only: 'kali',
    summary: 'where to find help in the Kalima simulator',
    synopsis: 'help',
    man: 'DESCRIPTION\n       zsh, the shell Kali uses, has no help builtin (bash does). The simulator provides this command in its place: it prints where help can be found. It is not part of Kali Linux.\n\n' +
      'SEE ALSO\n       kalima(1), man(1), apropos(1)',
    run(ctx) {
      const p = pen(ctx);
      ctx.out(
        para(ctx, 'zsh has no help builtin. In this simulator, help comes from three places:', 0) + '\n' +
        rows(ctx, [
          ['kalima help', 'how the simulator, the lessons and the lab work'],
          ['man COMMAND', 'the manual page of a command, for example: man ls'],
          ['COMMAND --help', 'a short usage summary, for example: ls --help'],
        ], p.key));
      return 0;
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
