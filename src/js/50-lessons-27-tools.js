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

  const SETTINGS = T('# depot sync agent', 'server = 10.10.10.70', 'port = 8080', 'timeout = 30', 'retries = 3', 'log_level = warn', '');

  K.fsSeeds.push((machine) => {
    if (machine.profile !== 'kali') return;
    machine.vfs.seed(SEED + '/settings.conf', SETTINGS);
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
          '`-exec` runs another command on each file found. The file name goes where `{}` is, and `\\;` marks the end of the command. The backslash stops the shell from treating `\;` as its own separator.',
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

  /* --------------------------------------------------------------- archives */
  const AR = WORK + '/archive';
  const TAR = ['tar'];
  const archiveLesson = {
    id: 'tools-archive',
    title: 'Archives: tar, gzip and zip',
    minutes: 12,
    objectives: [
      'Create, list and extract a compressed tar archive with `tar` and the letters c, t, x, z and f',
      'Check what an archive contains before unpacking it',
      'Compress a single file with `gzip` and read it back, and handle ZIP files with `zip` and `unzip`',
    ],
    intro: T(
      'Evidence, scan results and reports travel as archives: one file that holds many files and keeps their folder layout. You will also receive archives from other people, and unpacking one blindly can scatter files across your current directory or overwrite your own.',
      '',
      'In this lesson you build an archive of the survey folder, look inside it before you extract anything, and meet the three tools you will use most: `tar`, `gzip` and `zip`.'
    ),
    steps: [
      {
        id: 'setup',
        prompt: T(
          'Make a working copy of the survey folder for this lesson and move into it:',
          '',
          '```',
          'mkdir -p ~/practice/tools/archive',
          'cp -rT /usr/share/kalima/tools/survey ~/practice/tools/archive',
          'cd ~/practice/tools/archive',
          '```',
          '',
          'You are now in a folder with `notes`, `scans` and `logs`. Everything you pack and unpack below stays inside it.'
        ),
        hint: 'Run the three commands in order, for example joined with `&&`.',
        solution: 'mkdir -p ~/practice/tools/archive && cp -rT /usr/share/kalima/tools/survey ~/practice/tools/archive && cd ~/practice/tools/archive',
        check: { cwd: AR, file: { path: AR + '/scans/web01.txt', exists: true } },
      },
      {
        id: 'create',
        prompt: T(
          'Pack the `notes` and `scans` folders into one compressed archive:',
          '',
          '```',
          'tar -czf survey.tgz notes scans',
          '```',
          '',
          'The option letters each do one job:',
          '',
          '- `c` creates a new archive',
          '- `z` compresses it with gzip',
          '- `f` says the next word is the archive file name',
          '',
          '`f` must come last in the group, because the file name follows it. After the archive name come the things to pack. `tar` prints nothing on success; check the result with `ls -l survey.tgz`.'
        ),
        hint: 'The archive name comes right after the letters, then the folders to include.',
        solution: 'tar -czf survey.tgz notes scans',
        check: { cmd: TAR, argsRe: /-?[a-z]*c[a-z]*/, file: { path: AR + '/survey.tgz', exists: true, type: 'file' }, exit: 0 },
      },
      {
        id: 'list',
        prompt: T(
          'Before you extract an archive, and especially one from someone else, list what is inside. Replace `c` with `t` for table of contents:',
          '',
          '```',
          'tar -tzf survey.tgz',
          '```',
          '',
          'Each line is a path as stored in the archive. Look for two things: whether everything sits under one top-level folder, and whether any path starts with `/` or contains `..`. Paths like that would extract outside the place you intended. Add `v` (`-tvzf`) to see permissions, owner, size and date too.'
        ),
        hint: 'Same letters as before with `t` in place of `c`.',
        solution: 'tar -tzf survey.tgz',
        check: { cmd: TAR, args: ['-t'], out: /notes\/day1\.txt/, all: [{ out: /scans\/db01\.txt/ }], not: { file: { path: AR + '/restore', exists: true } } },
      },
      {
        id: 'which-xml',
        prompt: 'Read the listing again. One file in the archive ends in `.xml`. Type its path exactly as the listing shows it.',
        hint: 'Run `tar -tzf survey.tgz` and look at the paths under `scans/`.',
        solution: 'scans/web01.xml',
        answer: /^(\.\/)?scans\/web01\.xml$/i,
      },
      {
        id: 'extract',
        prompt: T(
          'Extract into a new, empty folder instead of the current directory. That keeps the contents separate from your own files, and it is a good habit with any archive you did not make. `-C` tells `tar` to change into a directory first:',
          '',
          '```',
          'mkdir -p restore',
          'tar -xzf survey.tgz -C restore',
          '```',
          '',
          '`x` extracts. Run `ls -R restore` to see that `notes` and `scans` were recreated inside it.'
        ),
        hint: 'Create the folder, then use `x` in place of `t` and add `-C restore`.',
        solution: 'mkdir -p restore && tar -xzf survey.tgz -C restore',
        check: { cmd: TAR, args: ['-x'], file: { path: AR + '/restore/notes/day1.txt', exists: true }, all: [{ file: { path: AR + '/restore/scans/web01.xml', exists: true } }] },
      },
      {
        id: 'one-member',
        prompt: T(
          'You can also extract a single member by naming it after the archive, with the path exactly as the listing printed it. Pull out only the database host scan into a second folder:',
          '',
          '```',
          'mkdir -p one',
          'tar -xzf survey.tgz -C one scans/db01.txt',
          '```',
          '',
          'The `one` folder gets `scans/db01.txt` and nothing else. Name each member the way `tar -t` showed it, otherwise `tar` reports that it was not found in the archive.'
        ),
        hint: 'Add the member path after `-C one`.',
        solution: 'mkdir -p one && tar -xzf survey.tgz -C one scans/db01.txt',
        check: { cmd: TAR, file: { path: AR + '/one/scans/db01.txt', exists: true }, all: [{ file: { path: AR + '/one/notes', exists: false } }] },
      },
      {
        id: 'gzip',
        prompt: T(
          '`gzip` compresses one file. By default it replaces the file with a `.gz` version; `-k` keeps the original as well:',
          '',
          '```',
          'gzip -k logs/proxy.log',
          'ls -l logs',
          '```',
          '',
          'Compare the two sizes in the listing. Text compresses well, and the `.gz` file is noticeably smaller than the original.'
        ),
        hint: 'Use `gzip -k` and the path of the log.',
        solution: 'gzip -k logs/proxy.log',
        check: { cmd: 'gzip', args: ['-k'], file: { path: AR + '/logs/proxy.log.gz', exists: true }, all: [{ file: { path: AR + '/logs/proxy.log', exists: true } }] },
      },
      {
        id: 'read-gz',
        prompt: T(
          'You do not have to unpack a `.gz` file to read it. `gunzip -c` writes the uncompressed data to the screen and leaves the file alone, and `zcat` does the same. Pipe it to `head` to see the first lines:',
          '',
          '```',
          'gunzip -c logs/proxy.log.gz | head -3',
          '```',
          '',
          'Plain `gunzip logs/proxy.log.gz` would instead restore the file and delete the `.gz`. It refuses to overwrite an existing file without asking.'
        ),
        hint: 'Use `gunzip -c` or `zcat`, then pipe to `head -3`.',
        solution: 'gunzip -c logs/proxy.log.gz | head -3',
        check: { cmd: ['gunzip', 'zcat', 'gzip'], out: /2026-11-12 00:00:00 10\.10\.10\.20 GET/ },
      },
      {
        id: 'zip',
        prompt: T(
          'Archives from Windows users and from many web services arrive as ZIP files. `zip` both archives and compresses, so there is no separate `z` step. `-r` includes folders and their contents:',
          '',
          '```',
          'zip -r survey.zip notes scans',
          '```',
          '',
          'It prints a line for each item it adds. The archive name comes first, then the things to add, which is the same order as `tar`.'
        ),
        hint: 'Use `zip -r`, the archive name, then the folders.',
        solution: 'zip -r survey.zip notes scans',
        check: { cmd: 'zip', file: { path: AR + '/survey.zip', exists: true, type: 'file' }, out: /adding: notes\/day1\.txt/ },
      },
      {
        id: 'unzip',
        prompt: T(
          'List a ZIP file before opening it with `unzip -l`. The listing has the size, date and name of each member:',
          '',
          '```',
          'unzip -l survey.zip',
          '```',
          '',
          'To extract, `unzip survey.zip -d folder` unpacks into `folder` (created if needed), and `unzip -t survey.zip` tests the archive without extracting. The last line of the listing totals the size and the number of files.'
        ),
        hint: 'The option is `-l`, followed by the archive name.',
        solution: 'unzip -l survey.zip',
        check: { cmd: 'unzip', args: ['-l'], out: /notes\/day2\.txt/, all: [{ out: /\d+ files/ }] },
      },
    ],
    quiz: [
      {
        q: 'Which command lists the contents of `evidence.tar.gz` without extracting anything?',
        choices: ['`tar -tzf evidence.tar.gz`', '`tar -xzf evidence.tar.gz`', '`tar -czf evidence.tar.gz`', '`gzip -t evidence.tar.gz`'],
        answer: 0,
        why: '`t` lists, `x` extracts and `c` creates. `z` is needed because the archive is compressed with gzip, and `f` names the file.',
      },
      {
        q: 'You run `tar -czf notes.tgz notes` and, in the same line, make a typo and write `tar -czf notes notes.tgz`. What is the likely result?',
        choices: [
          '`tar` tries to write the archive to a file named `notes`, where a folder of that name already exists, and fails',
          'The same archive as before',
          '`tar` extracts instead of creating',
          'The folder is deleted after archiving',
        ],
        answer: 0,
        why: 'The word after `f` is always the archive to write. Put the wrong word there and `tar` aims at the wrong target. Reading the command left to right as "create, compressed, file ..." catches this kind of slip.',
      },
      {
        q: 'You receive `report.tar.gz` from a third party. What is the safest first step?',
        choices: [
          'List it with `tar -tzf`, then extract it into a new empty folder with `-C`',
          'Extract it in your home directory and see what appears',
          'Extract it as root so that permissions are preserved',
          'Delete it, because archives cannot be checked',
        ],
        answer: 0,
        why: 'Listing shows the paths before anything is written, and a fresh folder keeps stray files away from your own. Running as root would only increase the damage of a badly made archive.',
      },
    ],
    refs: ['tar(1)', 'gzip(1)', 'zip(1)', 'unzip(1)', 'Kali Linux Revealed, ch. 3'],
  };

  /* ------------------------------------------------------------------- sed */
  const SD = WORK + '/sed';
  const SED = ['sed'];
  const sedLesson = {
    id: 'tools-sed',
    title: 'Editing streams with sed',
    minutes: 11,
    objectives: [
      'Replace text in a stream with `sed \'s/old/new/\'` and know what the `g` flag changes',
      'Print only chosen lines with `-n` and `p`, and select them by pattern or line number',
      'Edit a file in place with `-i` while keeping a backup, and check the change with `diff`',
    ],
    intro: T(
      'Often you have to change text in bulk: clean up a log before you share it, swap an address throughout a file, or adjust a setting in a configuration file on many machines. Opening each file in an editor does not scale.',
      '',
      '`sed` is a stream editor. It reads text a line at a time, applies your instructions to each line and writes the result. Because it works on a stream, it fits into pipelines. By default it leaves the original file alone, which makes it safe to try.'
    ),
    steps: [
      {
        id: 'setup',
        prompt: T(
          'Copy this lesson\'s two practice files into a folder of your own and move there: the depot shift log from earlier lessons and a small configuration file.',
          '',
          '```',
          'mkdir -p ~/practice/tools/sed',
          'cp /usr/share/kalima/text/shift-log.txt /usr/share/kalima/tools/settings.conf ~/practice/tools/sed',
          'cd ~/practice/tools/sed',
          '```',
          '',
          'If you run this again later, it overwrites your copies with fresh originals, which is a quick way to start over.'
        ),
        hint: 'Create the folder, copy both files into it, then `cd` there.',
        solution: 'mkdir -p ~/practice/tools/sed && cp /usr/share/kalima/text/shift-log.txt /usr/share/kalima/tools/settings.conf ~/practice/tools/sed && cd ~/practice/tools/sed',
        check: { cwd: SD, file: { path: SD + '/settings.conf', exists: true }, all: [{ file: { path: SD + '/shift-log.txt', exists: true } }] },
      },
      {
        id: 'subst',
        prompt: T(
          'The most used `sed` instruction is substitution, written `s/old/new/`. Replace the word `WARN` with `CAUTION`:',
          '',
          '```',
          'sed \'s/WARN/CAUTION/\' shift-log.txt',
          '```',
          '',
          'The pieces are `s` for substitute, the text to find, the replacement, each separated by `/`, and then the file. The whole instruction is quoted so the shell leaves it alone. Look at the output: every `WARN` line now says `CAUTION`. The file itself is unchanged, because `sed` only prints its result. Run `grep -c WARN shift-log.txt` if you want to see that the original still has them.'
        ),
        hint: 'Quote the instruction, `s/WARN/CAUTION/`, and give the file name after it.',
        solution: 'sed \'s/WARN/CAUTION/\' shift-log.txt',
        check: { cmd: SED, out: /06:31\s+CAUTION\s+Scanner SC-14 battery/, not: { out: /\bWARN\b/ } },
      },
      {
        id: 'global',
        prompt: T(
          'Without a flag, `s` replaces only the first match on each line. Add `g` after the last slash to replace every match on the line. Lines of the log have runs of spaces between the time, the level and the message. Collapse each run into a single space:',
          '',
          '```',
          'sed \'s/  */ /g\' shift-log.txt',
          '```',
          '',
          'In the pattern, the first character is a space and `  *` means "a space followed by any number of further spaces". So `06:02  INFO   Gate opened...` becomes `06:02 INFO Gate opened...`. Try the same command without the `g` and notice that only the first run on each line is collapsed.'
        ),
        hint: 'Use the pattern from the example, and put `g` after the final slash.',
        solution: 'sed \'s/  */ /g\' shift-log.txt',
        check: { cmd: SED, out: /^06:02 INFO Gate opened, 14 vehicles on site$/m, all: [{ out: /^07:41 WARN \S/m }] },
      },
      {
        id: 'quiet',
        prompt: T(
          '`sed` normally prints every line. With `-n` it prints only what you ask for, and the `p` command asks for a line to be printed. Put a pattern in front of `p` and only matching lines qualify:',
          '',
          '```',
          'sed -n \'/ERROR/p\' shift-log.txt',
          '```',
          '',
          'The pattern goes between slashes. You get the four `ERROR` lines, the same as `grep ERROR` would give. Forgetting `-n` is a common mistake: every line is printed once normally, and the matching ones a second time.'
        ),
        hint: 'You need `-n` and the instruction `/ERROR/p`.',
        solution: 'sed -n \'/ERROR/p\' shift-log.txt',
        check: { cmd: SED, args: ['-n'], out: /Weighbridge reading rejected/, not: { out: /Gate opened|WARN/ } },
      },
      {
        id: 'lines',
        prompt: T(
          'A number in front of a command selects a line, and two numbers separated by a comma select a range. `$` means the last line. Print lines 3 to 5:',
          '',
          '```',
          'sed -n \'3,5p\' shift-log.txt',
          '```',
          '',
          'Line 1 is the title and line 2 the column headings, so these are the first three log entries. `sed -n \'$p\'` would print only the last line, which tells you when the log ends.'
        ),
        hint: 'Use `-n` with the instruction `3,5p`.',
        solution: 'sed -n \'3,5p\' shift-log.txt',
        check: { cmd: SED, args: ['-n'], out: /06:02\s+INFO\s+Gate opened/, all: [{ out: /06:31\s+WARN/ }], not: { out: /Depot shift log|06:48/ } },
      },
      {
        id: 'delete',
        prompt: T(
          'The `d` command deletes lines from the output. Addresses work the same way: a number, a range or a pattern. Use it to remove the title and column headings, which are lines 1 and 2, so that only the entries remain:',
          '',
          '```',
          'sed \'1,2d\' shift-log.txt',
          '```',
          '',
          'Now change the approach: write a command that prints the log without the `INFO` lines, using a pattern address. Run it and read the output.'
        ),
        hint: 'Put a pattern, `/INFO/`, in front of `d`. The first example shows the shape.',
        solution: 'sed \'/INFO/d\' shift-log.txt',
        check: { cmd: SED, out: /Depot shift log/, all: [{ out: /06:31\s+WARN/ }], not: { out: /Gate opened|\bINFO\b/ } },
      },
      {
        id: 'count-left',
        prompt: 'Look at the lowercase entry at 07:06, which reads `info`. The pattern `/INFO/` is case-sensitive. Does that line still appear in the output of `sed \'/INFO/d\' shift-log.txt`? Answer yes or no.',
        hint: 'The 07:06 line has the level in lower case, so it does not match `INFO`.',
        solution: 'yes',
        answer: /^(yes|y)$/i,
      },
      {
        id: 'redirect',
        prompt: T(
          'To keep a result, send the output to a new file with `>`. The original stays as it was, so you can compare the two:',
          '',
          '```',
          'sed \'s/WARN/CAUTION/\' shift-log.txt > shift-log-clean.txt',
          '```',
          '',
          'Never redirect to the same file you are reading from (`> shift-log.txt`). The shell empties the file before `sed` gets to read it, and you lose the content. That is what `-i` is for, in the next step.'
        ),
        hint: 'Repeat the substitution and add `> shift-log-clean.txt`.',
        solution: 'sed \'s/WARN/CAUTION/\' shift-log.txt > shift-log-clean.txt',
        check: { cmd: SED, file: { path: SD + '/shift-log-clean.txt', contains: /CAUTION/ }, all: [{ file: { path: SD + '/shift-log.txt', contains: /\bWARN\b/ } }] },
      },
      {
        id: 'inplace',
        prompt: T(
          '`-i` edits the file in place. A suffix attached to it, as in `-i.bak`, tells `sed` to save the original under that extra ending first. Raise the retry count in the settings file from 3 to 5:',
          '',
          '```',
          'sed -i.bak \'s/^retries = 3/retries = 5/\' settings.conf',
          'ls',
          '```',
          '',
          'The `^` ties the pattern to the start of the line. `sed` prints nothing, but `ls` now shows `settings.conf.bak` beside `settings.conf`. Keep the backup suffix on every in-place edit, especially on real configuration files: there is no undo.'
        ),
        hint: 'Write `-i.bak` with no space between the option and the suffix, then the substitution, then the file.',
        solution: 'sed -i.bak \'s/^retries = 3/retries = 5/\' settings.conf',
        check: { cmd: SED, file: { path: SD + '/settings.conf', contains: /^retries = 5$/m }, all: [{ file: { path: SD + '/settings.conf.bak', contains: /^retries = 3$/m } }] },
      },
      {
        id: 'diff',
        prompt: T(
          'Confirm exactly what changed by comparing the backup with the edited file:',
          '',
          '```',
          'diff settings.conf.bak settings.conf',
          '```',
          '',
          'Lines starting with `<` come from the first file and `>` from the second. You should see one line of each: `retries = 3` replaced by `retries = 5`. Reviewing a diff after an automated edit is how you make sure the pattern touched only what you meant it to.'
        ),
        hint: 'List the old file first and the new file second.',
        solution: 'diff settings.conf.bak settings.conf',
        check: { cmd: 'diff', out: /< retries = 3[\s\S]*> retries = 5/ },
      },
    ],
    quiz: [
      {
        q: 'A line reads `error error error`. What does `sed \'s/error/ok/\'` print for it?',
        choices: ['`ok error error`', '`ok ok ok`', '`error error error`', '`ok`'],
        answer: 0,
        why: 'Without the `g` flag, `s` replaces only the first match on each line. `s/error/ok/g` would give `ok ok ok`.',
      },
      {
        q: 'What is wrong with `sed -n \'/root/\' auth.log`?',
        choices: [
          'It prints nothing, because `-n` turns off automatic printing and there is no `p` command to print',
          'It prints every line, because `-n` means all',
          'It deletes the matching lines',
          'It edits `auth.log` in place',
        ],
        answer: 0,
        why: '`-n` suppresses the automatic output, and the address alone does not print anything. The instruction needs `p`: `sed -n \'/root/p\' auth.log`.',
      },
      {
        q: 'You run `sed -i \'s/8080/9090/\' agent.conf` on a live configuration file and the pattern was wrong. Why is it a good habit to write `-i.bak`?',
        choices: [
          'The original is saved as `agent.conf.bak`, so you can restore it',
          'It makes `sed` run faster',
          'It stops `sed` from changing more than one line',
          'It makes `sed` ask for confirmation',
        ],
        answer: 0,
        why: 'In-place editing overwrites the file immediately. A backup suffix keeps the previous version beside it, so a wrong substitution is a one-line fix.',
      },
    ],
    refs: ['sed(1)', 'diff(1)', 'The sed FAQ and the GNU sed manual', 'Kali Linux Revealed, ch. 3'],
  };

  K.lessons.register({
    id: 'tools',
    title: 'Finding files, archives and stream editing',
    order: 27,
    summary: 'Search for files, pack and unpack archives, and transform text with sed and awk.',
    lessons: [findLesson, archiveLesson, sedLesson],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
