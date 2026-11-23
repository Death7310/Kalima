/* Kalima — curriculum module "tools": finding files, archives and stream editing.
 *
 * Lessons: tools-find, tools-archive, tools-sed, tools-awk. Practice files are
 * seeded read-only under /usr/share/kalima/tools (a small site-survey folder);
 * each lesson copies what it needs into ~/practice/tools/<lesson>/ and works there.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const HOME = '/home/kali';
  const WORK = HOME + '/practice/tools';
  const SEED = '/usr/share/kalima/tools';

  /* ------------------------------------------------------------ practice data */
  const rep = (n, f) => { const a = []; for (let i = 0; i < n; i++) a.push(f(i)); return a.join('\n') + '\n'; };
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  const PATHS = ['/index.html', '/login', '/api/items', '/static/app.js', '/static/site.css', '/images/logo.png', '/api/status'];
  const proxyLog = (n, day) => rep(n, (i) => {
    const t = pad(Math.floor(i / 60) % 24) + ':' + pad(i % 60) + ':' + pad((i * 7) % 60);
    return day + ' ' + t + ' 10.10.10.' + (20 + (i % 9)) + ' GET ' + PATHS[i % PATHS.length] + ' ' + (i % 13 === 0 ? 404 : 200) + ' ' + (300 + ((i * 37) % 900));
  });

  const SURVEY = {
    'README.txt': T(
      'Site survey: Halcyon Freight, Manchester depot',
      'Practice copy. Everything here is invented.',
      '',
      'notes/    working notes from the two survey days',
      'scans/    saved output from earlier scans of lab hosts',
      'logs/     proxy logs from the depot gateway',
      ''
    ),
    'notes/day1.txt': T('Day 1 - walkthrough', 'Met the depot manager at 09:00.', 'Photographed the server cupboard.', 'Gateway and web server are both in scope.', ''),
    'notes/day2.txt': T('Day 2 - network', 'Confirmed the address plan with the client.', 'Printer is out of scope.', 'Scans start after written approval only.', ''),
    'notes/Handover.TXT': T('Handover checklist', 'Return the visitor badge.', 'Send the draft summary to the client.', ''),
    'notes/summary.md': T('# Survey summary', '', '- Two survey days completed.', '- Scope confirmed in writing.', ''),
    'scans/web01.txt': T('Host: web01 (10.10.10.20)', '22/tcp  open  ssh', '80/tcp  open  http', '443/tcp open  https', ''),
    'scans/db01.txt': T('Host: db01 (10.10.10.30)', '22/tcp   open  ssh', '3306/tcp open  mysql', ''),
    'scans/web01.xml': T('<?xml version="1.0"?>', '<host name="web01" address="10.10.10.20">', '  <port number="22" state="open"/>', '  <port number="80" state="open"/>', '</host>', ''),
    'logs/proxy.log': proxyLog(900, '2026-11-12'),
    'logs/proxy.log.1': proxyLog(330, '2026-11-11'),
    'logs/errors.log': T('2026-11-12 09:14:02 upstream timeout 10.10.10.20', '2026-11-12 09:14:09 upstream timeout 10.10.10.20', '2026-11-12 13:40:51 certificate expires in 12 days', ''),
  };

  K.fsSeeds.push((machine) => {
    if (machine.profile !== 'kali') return;
    for (const name of Object.keys(SURVEY)) machine.vfs.seed(SEED + '/survey/' + name, SURVEY[name]);
  });

  /** What a line printed, as trimmed non-empty lines. */
  const linesOf = (ev) => K.util.stripAnsi(ev.output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const FIND = ['find'];

  /* ------------------------------------------------------------------ find */
  const findLesson = {
    id: 'tools-find',
    title: 'Finding files with find and locate',
    minutes: 12,
    objectives: [
      'Find files by name, size and age with `find`, and combine tests',
      'Run a command on every file found with `-exec`',
      'Explain why `locate` can miss new files and refresh its database with `updatedb`',
    ],
    intro: T(
      'During an engagement you collect scan output, logs, notes and captures, and a few days later you cannot remember where the file with the database host was. `find` searches by what a file is: its name, kind, size or age. It reads the disk as it is right now.',
      '',
      '`locate` is the faster alternative that searches a prebuilt index. In this lesson you work on an invented site-survey folder, so you can search freely without touching anything real.'
    ),
    steps: [
      {
        id: 'setup',
        prompt: T(
          'Make your own working copy of the survey folder and go into it. The originals under `/usr/share/kalima` are read-only; copies are yours to change.',
          '',
          '```',
          'mkdir -p ~/practice/tools/find',
          'cp -rT /usr/share/kalima/tools/survey ~/practice/tools/find',
          'cd ~/practice/tools/find',
          '```',
          '',
          '`mkdir -p` creates the folder and does not complain if it exists. `cp -r` copies a folder and everything below it, and `-T` makes the destination the copy itself, so running this twice does not nest a second copy. Use `ls` to see `README.txt` and the folders `notes`, `scans` and `logs`.'
        ),
        hint: 'Run the three commands in order. They can be on one line separated by `&&`.',
        solution: 'mkdir -p ~/practice/tools/find && cp -rT /usr/share/kalima/tools/survey ~/practice/tools/find && cd ~/practice/tools/find',
        check: { cwd: WORK + '/find', file: { path: WORK + '/find/logs/proxy.log', exists: true, type: 'file' } },
      },
      {
        id: 'name',
        prompt: T(
          '`find` takes a starting directory and then tests. The dot means the current directory. Search it for files whose name ends in `.txt`:',
          '',
          '```',
          'find . -name "*.txt"',
          '```',
          '',
          'Each match is printed with its path. `-name` compares the file name against a pattern, and the `*` stands for any characters. Quote the pattern so the shell passes the `*` to `find` instead of expanding it first.',
          '',
          'You get five files. `notes/summary.md` is not among them, because its name does not end in `.txt`.'
        ),
        hint: 'The shape is `find START -name "PATTERN"`.',
        solution: 'find . -name "*.txt"',
        check: { cmd: FIND, args: ['-name'], out: /\.\/notes\/day1\.txt/, all: [{ out: /\.\/scans\/db01\.txt/ }], not: { out: /summary\.md|Handover/ } },
      },
      {
        id: 'iname',
        prompt: T(
          'Names are case-sensitive for `-name`. Someone saved a checklist as `Handover.TXT`, and the last search skipped it. `-iname` ignores case:',
          '',
          '```',
          'find . -iname "*.txt"',
          '```',
          '',
          'Now six files appear. When you hunt for something you saved a while ago, `-iname` is the safer default.'
        ),
        hint: 'Replace `-name` with `-iname`.',
        solution: 'find . -iname "*.txt"',
        check: { cmd: FIND, args: ['-iname'], out: /\.\/notes\/Handover\.TXT/, all: [{ out: /\.\/notes\/day2\.txt/ }] },
      },
      {
        id: 'size',
        prompt: T(
          'Size is another test. `-size +20k` matches files larger than 20 kilobytes (`-` would mean smaller, `M` and `G` are megabytes and gigabytes). Add `-type f` to limit the result to regular files, because directories have a size too. Types include `f` for file, `d` for directory and `l` for symbolic link.',
          '',
          '```',
          'find . -type f -size +20k',
          '```',
          '',
          'Tests are joined with an implicit "and": a file must pass both. Which file is the large one?'
        ),
        hint: 'Combine `-type f` and `-size +20k` in one command.',
        solution: 'find . -type f -size +20k',
        check: { cmd: FIND, args: ['-size'], out: /\.\/logs\/proxy\.log$/m, not: { out: /proxy\.log\.1|day1/ } },
      },
      {
        id: 'size-count',
        prompt: 'Adjust the size test yourself. How many regular files in the folder are larger than 10 kilobytes? Run the command, then type the number you counted.',
        hint: 'Same command as before with `+10k`. Count the lines it prints.',
        solution: '2',
        answer: /^(2|two)$/i,
      },
      {
        id: 'mtime',
        prompt: T(
          'Age is tested with `-mtime`, in days since the file was last modified. `-mtime +7` means more than seven days ago, `-mtime -1` means within the last day. Your copies are all new, so first make one look old with `touch -d`, then search:',
          '',
          '```',
          'touch -d "30 days ago" logs/proxy.log.1',
          'find . -mtime +7',
          '```',
          '',
          'Only the backdated file is listed. `-mmin` does the same in minutes, which suits "what changed in the last ten minutes?".'
        ),
        hint: 'Run the `touch` line first, then `find . -mtime +7`.',
        solution: 'touch -d "30 days ago" logs/proxy.log.1; find . -mtime +7',
        check: {
          cmd: FIND, args: ['-mtime'], out: /\.\/logs\/proxy\.log\.1$/m, not: { out: /\.\/logs\/proxy\.log$/m },
          fn: () => { const st = K.kali.vfs.stat(WORK + '/find/logs/proxy.log.1'); return K.clock.now() - st.mtime > 7 * 86400 * 1000; },
        },
      },
      {
        id: 'combine',
        prompt: T(
          'Now combine what you know. Find regular files whose name starts with `proxy` and that were modified more than seven days ago. Run one `find` command that prints only `./logs/proxy.log.1`.',
          '',
          'Tests joined this way must all be true. You can also write `-o` for "or", and `!` in front of a test to negate it.'
        ),
        hint: 'Use `-type f`, `-name "proxy*"` and `-mtime +7` together.',
        solution: 'find . -type f -name "proxy*" -mtime +7',
        check: {
          cmd: FIND, argsRe: /-mtime/, out: /^\.\/logs\/proxy\.log\.1$/m,
          fn: (ev) => linesOf(ev).filter((l) => l.charAt(0) === '.').length === 1,
        },
      },
      {
        id: 'exec',
        prompt: T(
          '`-exec` runs another command on each file found. The file name goes where `{}` is, and `\;` marks the end of the command. The backslash stops the shell from treating `\;` as its own separator.',
          '',
          '```',
          'find . -name "*.txt" -exec wc -l {} \\;',
          '```',
          '',
          'Here `wc -l` counts the lines of each text file, and you see a count and a path for every match. Use `-exec` only with commands whose effect you understand: pairing it with `rm` deletes everything that matches.'
        ),
        hint: 'End the command with `-exec wc -l {} \\;`.',
        solution: 'find . -name "*.txt" -exec wc -l {} \\;',
        check: { cmd: FIND, args: ['-exec'], out: /\d+ \.\/notes\/day1\.txt/, all: [{ out: /\d+ \.\/scans\/web01\.txt/ }] },
      },
      {
        id: 'updatedb',
        prompt: T(
          '`find` walks the disk each time. `locate` is much faster because it looks in a database of file names that is rebuilt on a schedule, usually once a day. The trade-off is that anything created since the last rebuild is not in it, and files that were deleted may still be listed.',
          '',
          'Rebuild the database now. It needs root, so use `sudo` and your password (`kali`):',
          '',
          '```',
          'sudo updatedb',
          '```',
          '',
          'No output means it worked.'
        ),
        hint: 'Run `updatedb` with `sudo`. The password is `kali`.',
        solution: 'sudo updatedb',
        input: ['kali'],
        check: { cmd: 'updatedb', user: 'root', exit: 0 },
      },
      {
        id: 'locate',
        prompt: T(
          'Search the database for the proxy logs, including the copy you made:',
          '',
          '```',
          'locate proxy.log',
          '```',
          '',
          '`locate` matches the text anywhere in the full path and prints one path per line. You should see your copy under `/home/kali/practice/tools/find/logs` as well as the original under `/usr/share/kalima`. If you saw only the original, the database predates your copy and needs `updatedb` again.'
        ),
        hint: 'Run `locate proxy.log`. If your copy is missing, repeat the previous step first.',
        solution: 'locate proxy.log',
        check: { cmd: ['locate', 'plocate'], out: /\/home\/kali\/practice\/tools\/find\/logs\/proxy\.log/ },
      },
    ],
    quiz: [
      {
        q: 'You run `find . -name *.txt` without quotes in a folder that contains `a.txt` and `b.txt`. What goes wrong?',
        choices: [
          'The shell expands `*.txt` first, so `find` receives `a.txt b.txt` and complains or searches for the wrong thing',
          'Nothing, quotes only matter for spaces',
          '`find` prints only directories',
          'The shell refuses to run the command',
        ],
        answer: 0,
        why: 'The shell expands unquoted wildcards before the command starts. `find` then sees extra arguments instead of a pattern. Quoting hands the `*` to `find`, which matches names in every folder it walks.',
      },
      {
        q: 'You saved a capture a few minutes ago and `locate` cannot find it, but `find ~ -name "*.pcap"` can. Why?',
        choices: [
          'The `locate` database has not been rebuilt since the file was created',
          '`locate` only searches system directories',
          '`find` is case-insensitive and `locate` is not',
          'The file is hidden from `locate` by its permissions',
        ],
        answer: 0,
        why: '`locate` reads a prebuilt index. New files appear only after `updatedb` runs, while `find` inspects the disk directly at the moment you run it.',
      },
      {
        q: 'Which test finds files modified within the last 30 minutes?',
        choices: ['`-mmin -30`', '`-mtime -30`', '`-mmin +30`', '`-size -30`'],
        answer: 0,
        why: '`-mmin` counts minutes and `-30` means less than 30. `-mtime` counts days, so `-mtime -30` would match anything changed within a month.',
      },
    ],
    refs: ['find(1)', 'locate(1)', 'updatedb(8)', 'Kali Linux Revealed, ch. 3'],
  };

  K.lessons.register({
    id: 'tools',
    title: 'Finding files, archives and stream editing',
    order: 27,
    summary: 'Search for files, pack and unpack archives, and transform text with sed and awk.',
    lessons: [findLesson],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
