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

  /** A paragraph wrapped to the terminal, every line indented. */
  const para = (ctx, text, indent) => wrap(text, textWidth(ctx) - indent).map((l) => ' '.repeat(indent) + l).join('\n') + '\n';

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
   * line and wraps; `paints` may give a colour function for each column.
   */
  function table(ctx, head, body, paints) {
    const last = head.length - 1;
    const widths = head.map((h, i) => Math.max.apply(null, [h].concat(body.map((r) => r[i])).map((cell) => cell.length)));
    const indent = 2 + widths.slice(0, last).reduce((sum, w) => sum + w + 2, 0);
    const room = Math.max(20, textWidth(ctx) - indent);
    const line = (cells, paint) => {
      const fixed = cells.slice(0, last).map((cell, i) => paint(i)(cell.padEnd(widths[i])) + '  ').join('');
      return wrap(cells[last], room).map((l, n) => (n ? ' '.repeat(indent) : '  ' + fixed) + paint(last)(l) + '\n').join('');
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
    out += '  ' + 'NUMBER'.padEnd(16) + 'any time scale from 0 to ' + MAX_SCALE + '; 0.5 halves every wait\n';
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

  function cmdStatus(ctx) {
    const p = pen(ctx); const d = K.distro; const e = K.net.world.engagement;
    ctx.out(p.head('Kalima ' + K.version) + '\n\n' + rows(ctx, [
      ['Simulating', d.pretty + ' ' + d.release + ' (' + d.codename + ')'],
      ['Kernel', d.kernel],
      ['Machine', machineLine(ctx.machine)],
      ['Engagement', e.id + ', scope ' + scopeList(e).join(' and ')],
      ['Simulated time', describeSpeed(K.settings.timeScale)],
      ['Scope guard', K.settings.scopeGuard ? 'on' : 'off'],
      ['Lessons', lessonLine()],
    ], p.key));
    return 0;
  }

  /* ------------------------------------------------------------------ about */
  function simulatedCommandCount() { return K.cmd.list().filter((d) => !d.stub && !d.aliasOf).length; }

  function cmdAbout(ctx) {
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

  /* ---------------------------------------------------------------- kalima */
  const TRY_HELP = "Try 'kalima help' for a list of commands.";

  /** Report a mistake in how kalima was called; exit status 2. */
  function usageError(ctx, msg, noHint) { return ctx.fail(msg + (noHint ? '' : '\n' + TRY_HELP), 2); }

  const HANDLERS = { help: cmdHelp, status: cmdStatus, speed: cmdSpeed, about: cmdAbout };

  const usageText = () => 'Usage: kalima [COMMAND] [ARGUMENT]...\n\n' +
    SUBCOMMANDS.map(([name, arg, text]) => '  ' + (name + (arg ? ' ' + arg : '')).padEnd(16) + text).join('\n') +
    '\n\n  -h, --help      display this help and exit\n  -V, --version   output version information and exit\n';

  K.cmd.register({
    name: 'kalima',
    pkg: 'kalima',
    only: 'kali',
    summary: 'control and explore the Kalima training simulator',
    synopsis: 'kalima [COMMAND] [ARGUMENT]...',
    man: () => 'DESCRIPTION\n' +
      '       kalima belongs to the simulator, not to Kali Linux. It explains how the simulator works, shows the state of the training lab and changes a few simulator settings. Without a command it prints the overview that kalima help prints.\n\n' +
      'COMMANDS\n' + SUBCOMMANDS.map(([name, arg, text]) => '       ' + name + (arg ? ' ' + arg : '') + '\n              ' + text[0].toUpperCase() + text.slice(1) + '.').join('\n\n') + '\n\n' +
      'OPTIONS\n       -h, --help\n              Display a usage summary and exit.\n\n       -V, --version\n              Output version information and exit.\n\n' +
      'EXIT STATUS\n       0 on success, 1 when a command could not do what was asked, 2 when kalima was called incorrectly.\n\n' +
      'EXAMPLES\n       kalima status\n              Show what is being simulated and how far the lessons have been completed.\n\n       kalima speed fast\n              Shorten every simulated wait, such as the second between two pings.',
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
      if (info.words[1] === 'speed' && info.index === 2) return SPEEDS.map((s) => s.name);
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
