/* Kalima — curriculum module "files": working with files.
 *
 * Lessons: files-view, files-manage, files-redirect, files-edit. They read the
 * practice data under /usr/share/kalima and write only under ~/practice/files
 * (plus one appended line in ~/engagement/notes.md). Checks test what a line
 * printed or left on disk, so any correct way of doing a step passes, and each
 * lesson can be repeated: its first steps rebuild what the later ones need.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const DATA = '/usr/share/kalima';
  const ACCESS = DATA + '/logs/access.log';
  const AUTH = DATA + '/logs/auth.log';

  /* ------------------------------------------------------------ files-view */
  const viewLesson = {
    id: 'files-view',
    title: 'Looking inside files',
    minutes: 10,
    objectives: [
      'Check what a file is with `file` and how long it is with `wc` before opening it',
      'Print a short file with `cat`, and the start or end of a long one with `head` and `tail`',
      'Read and search a long file in the pager `less`',
    ],
    intro: T(
      'Much of security work is reading: logs, configuration files, and the output that tools leave behind. Some of these files are five lines long and some are five hundred thousand, and some are not text at all. Opening a file the wrong way wastes time or floods your terminal.',
      '',
      'This lesson gives you a routine for any unfamiliar file: ask what it is, ask how big it is, then choose a viewer that fits. You practice on a web server log of 476 lines and a few smaller files. Every command here only reads, so nothing can be damaged.'
    ),
    steps: [
      {
        id: 'file',
        prompt: T(
          'Before you open a file you did not create, find out what it is. `file` examines the content, not the name, and reports the type:',
          '',
          '```',
          'file ' + ACCESS + ' /usr/bin/ls',
          '```',
          '',
          'You gave two arguments, so there are two answers. The log is `ASCII text`: plain text that is safe to print. `/usr/bin/ls` is an `ELF` executable, a compiled program. Printing a file like that produces a screenful of garbage, and `file` is how you find out beforehand.'
        ),
        hint: 'Type `file` followed by the two paths, with a space between them.',
        solution: 'file ' + ACCESS + ' /usr/bin/ls',
        check: { cmd: 'file', out: /access\.log:\s+ASCII text/ },
      },
      {
        id: 'wc',
        prompt: T(
          'Next, find out how long it is. `wc` (*word count*) counts the lines, words and bytes in a file. With the option `-l` it prints only the number of lines:',
          '',
          '```',
          'wc -l ' + ACCESS,
          '```',
          '',
          'The answer is 476 lines. A terminal window shows a few dozen lines at a time, so printing this file whole would send most of it scrolling past. The line count tells you which viewer to reach for.'
        ),
        hint: 'The option is a lowercase letter L. Use the Up arrow to bring back the path from the previous command.',
        solution: 'wc -l ' + ACCESS,
        check: { cmd: 'wc', out: /\b476\b/ },
      },
      {
        id: 'count',
        prompt: 'The same directory holds a second log, `auth.log`. Count its lines in the same way. How many does it have?',
        hint: 'Press Up to bring back the `wc -l` command and change the file name at the end to `auth.log`.',
        solution: '450',
        answer: /^450(\s*lines?)?\.?$/i,
      },
      {
        id: 'cat',
        prompt: T(
          '`cat` prints a whole file to the terminal without stopping, which suits short files. The depot shift log is 35 lines long:',
          '',
          '```',
          'cat ' + DATA + '/text/shift-log.txt',
          '```',
          '',
          'All of it is now on screen, and you can scroll the terminal back to read the top. The name comes from *concatenate*: given several files, `cat` prints them one after another. With `-n` it numbers the lines.'
        ),
        hint: 'Type `cat`, a space and the path of the file.',
        solution: 'cat ' + DATA + '/text/shift-log.txt',
        check: { cmd: 'cat', all: [{ out: /Gate opened/ }, { out: /Gate closed/ }] },
      },
      {
        id: 'head',
        prompt: T(
          'For a long file, look at the beginning first. `head` prints the first 10 lines, or as many as you ask for with `-n`:',
          '',
          '```',
          'head -n 3 ' + ACCESS,
          '```',
          '',
          'Three lines are enough to learn the layout. Each line is one request to a web server: the address of the client, the time, the request in quotes, the status code and the size of the reply. The last quoted field is the name the client\'s software gave for itself.'
        ),
        hint: 'After `-n` comes a space and the number of lines you want.',
        solution: 'head -n 3 ' + ACCESS,
        check: { cmd: 'head', out: /00:30:02/, not: { out: /00:45:02/ } },
      },
      {
        id: 'tail',
        prompt: T(
          '`tail` is the mirror image of `head`. It prints the end of a file, which is where a log keeps its newest entries, and it takes `-n` in the same way.',
          '',
          'Show the last 5 lines of `' + AUTH + '`.'
        ),
        hint: 'The command has the same shape as the `head` command you just ran: the name, `-n`, a number, then the path.',
        solution: 'tail -n 5 ' + AUTH,
        check: { cmd: 'tail', out: /21:17:01[^\n]*session closed/, not: { out: /21:17:01[^\n]*session opened/ } },
      },
      {
        id: 'last-time',
        prompt: 'Each line of that log begins with the date and time it was written. At what time, to the second, was the very last line written?',
        hint: 'Read the last line that `tail` printed. The time follows the date, in the form `HH:MM:SS`.',
        solution: '23:17:01',
        answer: /^(nov(ember)?\s+12,?\s+(at\s+)?)?23:17:01$/i,
      },
      {
        id: 'less',
        prompt: T(
          'To read a long file properly, open it in a **pager**. `less` shows one screen at a time and never changes the file:',
          '',
          '```',
          'less ' + ACCESS,
          '```',
          '',
          'Inside `less` you press keys instead of typing commands:',
          '',
          '- Space moves forward one screen, and `b` moves back.',
          '- `G` jumps to the end, and `g` returns to the start.',
          '- `/` followed by some text and Enter searches forward for that text. `n` repeats the search.',
          '- `q` quits and returns you to the prompt.',
          '',
          'Try each of them. Then press `g`, type `/admin` and press Enter. `less` jumps to the first line that contains `admin`. Note the client address at the start of that line before you press `q`: the next step asks for it.'
        ),
        hint: 'Start `less` with the path of the access log. This step completes when you leave `less` with `q`.',
        solution: 'less ' + ACCESS,
        check: { cmd: 'less', line: /access\.log/, not: { out: /No such file|is a directory/ } },
      },
      {
        id: 'searched',
        prompt: 'Your search stopped at a request for the page `/admin`. Which client address, at the start of that line, made the request?',
        hint: 'Open the log in `less` again, type `/admin` and press Enter. The line you want is at the top of the screen with the match highlighted. The address is the first thing on the line: four numbers separated by dots.',
        solution: '203.0.113.99',
        answer: ['203.0.113.99'],
      },
      {
        id: 'header',
        prompt: T(
          'Choosing a viewer comes down to asking what you need to see. The file `' + DATA + '/data/shipments.csv` is a table, and its first line names the columns.',
          '',
          'Print only that first line.'
        ),
        hint: 'Which command shows the beginning of a file, and which option sets how many lines it prints?',
        solution: 'head -n 1 ' + DATA + '/data/shipments.csv',
        check: { line: /shipments\.csv/, out: /id,date,origin,destination/, not: { out: /HF-2026-/ } },
      },
    ],
    quiz: [
      {
        q: 'A colleague sends you a file called `capture.dat` and you know nothing else about it. Which command is the sensible first step?',
        choices: ['`cat capture.dat`', '`file capture.dat`', '`head -n 1000 capture.dat`', '`less capture.dat`'],
        answer: 1,
        why: '`file` reports what the content is without printing any of it. A name proves nothing about the content, and printing binary data to a terminal produces garbage.',
      },
      {
        q: '`notes.txt` has only two lines. What does `tail -n 3 notes.txt` print?',
        choices: [
          'An error, because the file is too short',
          'The two lines followed by an empty line',
          'Both lines, and nothing else',
          'Only the last line',
        ],
        answer: 2,
        why: '`-n 3` means "at most the last three lines". When a file is shorter than that, `tail` prints all of it. `head` behaves the same way.',
      },
      {
        q: 'You are reading a log in `less` and want to jump to the next line that contains `404`. What do you press?',
        choices: [
          '`q`, and then run a different command',
          'Ctrl-F, as in a web browser',
          '`G`, which goes to the next match',
          '`/404` and then Enter',
        ],
        answer: 3,
        why: 'Inside `less`, `/` starts a forward search and Enter runs it. After that, `n` moves to each further match.',
      },
      {
        q: 'Run without options, `wc report.txt` prints `12  96 640 report.txt`. What is 96?',
        choices: ['The number of words', 'The number of lines', 'The number of bytes', 'The length of the longest line'],
        answer: 0,
        why: 'Plain `wc` prints lines, words and bytes, in that order, then the name. Here that is 12 lines, 96 words and 640 bytes. The options `-l`, `-w` and `-c` select one of the three.',
      },
    ],
    refs: ['file(1)', 'wc(1)', 'cat(1)', 'head(1)', 'tail(1)', 'less(1)'],
  };

  /* ---------------------------------------------------------- files-manage */
  const WORK = '/home/kali/practice/files';
  const exists = (path, type) => ({ file: type ? { path, type } : { path } });
  const gone = (path) => ({ file: { path, exists: false } });
  /** Is `path` itself a symbolic link (not the file it points to)? */
  const isLink = (path) => (ev, K2) => {
    try { return !!K2.kali.vfs.lstat(path).isLink; } catch (e) { return false; }
  };

  const manageLesson = {
    id: 'files-manage',
    title: 'Creating, copying, moving and deleting',
    minutes: 12,
    objectives: [
      'Create directories and empty files with `mkdir -p` and `touch`',
      'Copy and move files and directories with `cp`, `cp -r` and `mv`',
      'Delete with `rm` and `rm -r`, knowing that neither can be undone',
      'Give a file a second name with a symbolic link, `ln -s`',
    ],
    intro: T(
      'An assessment produces files quickly: copies of logs, tool output, notes. If they pile up in one directory you lose track of what came from where, and evidence you cannot place is evidence you cannot use. A tidy working directory is part of the job.',
      '',
      'In this lesson you build one under `~/practice/files` with the handful of commands that create, copy, move, delete and link files. One of them, `rm`, has no undo, so you also practice the habits that make it safe to use.'
    ),
    steps: [
      {
        id: 'mkdir',
        prompt: T(
          '`mkdir` makes a directory. Create one for the copies of files you collect:',
          '',
          '```',
          'mkdir -p ~/practice/files/evidence',
          '```',
          '',
          'The path names three levels. `-p` (*parents*) creates every level that is missing, here `practice`, then `files`, then `evidence`. It also stays quiet about levels that already exist, so the command is safe to run twice. Without `-p`, `mkdir` creates only the last level and fails if the ones above it are not there.'
        ),
        hint: 'Type it exactly. `~` stands for your home directory, so this works from anywhere.',
        solution: 'mkdir -p ~/practice/files/evidence',
        check: { cmd: 'mkdir', file: { path: WORK + '/evidence', type: 'dir' } },
      },
      {
        id: 'enter',
        prompt: T(
          'Move into the new working directory, so that the rest of the lesson can use short relative paths:',
          '',
          '```',
          'cd ~/practice/files',
          '```',
          '',
          'The prompt should now show `~/practice/files`. Every command from here on assumes you are in this directory. If you wander off, this `cd` brings you back.'
        ),
        hint: 'The argument is the path you just created, without the last part.',
        solution: 'cd ~/practice/files',
        check: { cwd: WORK },
      },
      {
        id: 'touch',
        prompt: T(
          '`touch` creates an empty file when the name is not in use yet. Start a notes file:',
          '',
          '```',
          'touch notes.txt',
          '```',
          '',
          'Run `ls -l` afterwards: `notes.txt` is there with a size of 0. If the file had already existed, `touch` would have left its content alone and only updated its time stamp.'
        ),
        hint: 'One command and one argument: the name of the file to create.',
        solution: 'touch notes.txt',
        check: { cmd: 'touch', file: { path: WORK + '/notes.txt', type: 'file' } },
      },
      {
        id: 'cp',
        prompt: T(
          '`cp` copies. It takes the source first and the destination second. The practice logs are read-only originals, so work on a copy:',
          '',
          '```',
          'cp ' + AUTH + ' .',
          '```',
          '',
          'The destination `.` means "this directory", and the copy keeps the name `auth.log`. Had you written a new name in place of the dot, the copy would have been given that name.',
          '',
          'Run `ls -l` and compare the owners: the original belongs to `root`, the copy belongs to you.'
        ),
        hint: 'Do not forget the final dot, with a space in front of it. It is the destination.',
        solution: 'cp ' + AUTH + ' .',
        check: { cmd: 'cp', file: { path: WORK + '/auth.log', contains: /sshd/ } },
      },
      {
        id: 'mv',
        prompt: T(
          '`mv` moves. It takes the same two things as `cp`: what, then where to. Put the log where it belongs:',
          '',
          '```',
          'mv auth.log evidence/',
          '```',
          '',
          'Because `evidence` is an existing directory, the file moves into it. When the last argument is not a directory, `mv` treats it as the new name, which is how files are renamed: `mv notes.txt notes.md` would rename your notes file.',
          '',
          'Check the result with `ls evidence`.'
        ),
        hint: 'You should be in `~/practice/files`. The file to move is `auth.log` and the destination is the directory `evidence`.',
        solution: 'mv auth.log evidence/',
        check: { cmd: 'mv', all: [exists(WORK + '/evidence/auth.log'), gone(WORK + '/auth.log')] },
      },
      {
        id: 'cp-r',
        prompt: T(
          'Given a directory, `cp` refuses with `-r not specified; omitting directory`. The option `-r` (*recursive*) tells it to copy the directory and everything inside it.',
          '',
          'Copy the whole directory `' + DATA + '/logs` to a new directory called `backup`, here in your working directory. Then look inside with `ls backup`.'
        ),
        hint: 'The shape is `cp -r SOURCE DESTINATION`, and the destination is a name that does not exist yet. If `backup` is left over from an earlier attempt, remove it first with `rm -r backup`.',
        solution: 'cp -r ' + DATA + '/logs backup',
        check: { cmd: 'cp', any: [exists(WORK + '/backup/access.log'), exists(WORK + '/backup/logs/access.log')] },
      },
      {
        id: 'rm',
        prompt: T(
          '`rm` removes a file. Delete one of the copies:',
          '',
          '```',
          'rm backup/access.log',
          '```',
          '',
          'It printed nothing, and `ls backup` confirms the file is gone. There is no trash on the command line and no undo: once `rm` returns, the only way back is another copy of the file. That is why you practiced on a copy.'
        ),
        hint: 'The argument is the path of the file inside `backup`.',
        solution: 'rm backup/access.log',
        check: { cmd: 'rm', file: { path: WORK + '/backup/access.log', exists: false } },
      },
      {
        id: 'rm-r',
        prompt: T(
          'Plain `rm` will not remove a directory: `rm backup` answers `Is a directory`. With `-r` it removes the directory and everything beneath it, without asking and without undo. It is the most destructive command you will use every day, so make three things a habit:',
          '',
          '- Read the whole command before you press Enter, the path above all.',
          '- Run `ls` on the same path first, to see exactly what you are about to remove.',
          '- When in doubt add `-i`, which asks before each removal.',
          '',
          'Look at what `backup` still holds, then remove the directory.'
        ),
        hint: 'First `ls backup`, then `rm` with the option `-r` and the name of the directory.',
        solution: 'rm -r backup',
        check: { cmd: 'rm', file: { path: WORK + '/backup', exists: false } },
      },
      {
        id: 'link',
        prompt: T(
          'A **symbolic link** is a small file that points to another path. Programs that open the link get the file it points to. `ln -s` creates one from the target and then the name of the link:',
          '',
          '```',
          'ln -s evidence/auth.log latest.log',
          '```',
          '',
          'Now `head -n 2 latest.log` prints the start of the log in `evidence`. A link is a convenient way to give a short, fixed name to a file that lives somewhere deeper.'
        ),
        hint: 'The target comes first and the new name second. If `ln` says `File exists`, a link from an earlier attempt is already there, which is fine.',
        solution: 'ln -s evidence/auth.log latest.log',
        check: { cmd: 'ln', fn: isLink(WORK + '/latest.log') },
      },
      {
        id: 'arrow',
        prompt: T(
          'Run `ls -l` in your working directory. The line for `latest.log` begins with `l`, for link, instead of `-` or `d`, and it ends with an arrow.',
          '',
          'What path does the arrow point to?'
        ),
        hint: 'Read the end of the line for `latest.log`, after `->`.',
        solution: 'evidence/auth.log',
        answer: /^(->\s*)?(\.\/|(\/home\/kali|~)\/practice\/files\/)?evidence\/auth\.log$/,
      },
    ],
    quiz: [
      {
        q: 'You run `mv report.txt evidence`, and `evidence` is an existing directory. What happens?',
        choices: [
          '`report.txt` is renamed to `evidence`, replacing the directory',
          '`report.txt` is copied into `evidence` and the original stays',
          '`mv` refuses, because the destination already exists',
          '`report.txt` is moved into `evidence` and keeps its name',
        ],
        answer: 3,
        why: 'When the last argument is an existing directory, `mv` moves the file into it. Only when it is not a directory is it taken as the new name.',
      },
      {
        q: 'You have just removed the wrong file with `rm`. How do you get it back?',
        choices: [
          'Run `rm --undo`',
          'Only from a backup or another copy: `rm` cannot be undone',
          'Move it back out of the trash directory in your home',
          'Press Ctrl-Z straight away',
        ],
        answer: 1,
        why: '`rm` removes the name at once and keeps no trash. This is the reason to look with `ls` first, and to work on copies of anything you cannot replace.',
      },
      {
        q: '`latest.log` is a symbolic link to `evidence/auth.log`. You delete `evidence/auth.log`. What happens when you then run `cat latest.log`?',
        choices: [
          'It prints the log, because the link kept a copy',
          'It prints nothing, and reports success',
          'It fails with `No such file or directory`, because the link now points at nothing',
          'The link was deleted together with its target',
        ],
        answer: 2,
        why: 'A symbolic link stores a path, not content. The link itself survives, but it dangles: the path it names no longer exists.',
      },
      {
        q: '`a` exists and is empty. What does `mkdir -p a/b/c` do?',
        choices: [
          'It creates `a/b` and then `a/b/c`, without complaint',
          'It fails, because `a` already exists',
          'It creates only `a/b`',
          'It fails, because `a/b` does not exist yet',
        ],
        answer: 0,
        why: '`-p` creates every missing level of the path and accepts levels that already exist. Without it, `mkdir a/b/c` would fail because `a/b` is missing.',
      },
    ],
    refs: ['mkdir(1)', 'touch(1)', 'cp(1)', 'mv(1)', 'rm(1)', 'ln(1)', 'symlink(7)'],
  };

  /* -------------------------------------------------------- files-redirect */
  const LOGS = DATA + '/logs';
  const NOTES = '/home/kali/engagement/notes.md';
  const has = (path, contains) => ({ file: { path, contains } });

  const redirectLesson = {
    id: 'files-redirect',
    title: 'Redirecting output and joining commands',
    minutes: 12,
    objectives: [
      'Send the output of a command to a file with `>` and add to a file with `>>`',
      'Tell standard output from standard error, and redirect errors with `2>`, `2>&1` and `/dev/null`',
      'Connect commands with a pipe, and save while you watch with `tee`',
      'Append command output to your engagement notes without overwriting them',
    ],
    intro: T(
      'What you cannot show, you cannot report. Careful testers keep the exact output of the commands they ran, with nothing retyped from memory, so that every finding can be checked and repeated.',
      '',
      'The shell makes this easy. Each command writes its results to one stream and its error messages to another, and you decide where each stream goes: to the screen, into a file, into the next command, or nowhere. In this lesson you steer those streams, and you finish by adding real command output to the notes file in `~/engagement`.'
    ),
    steps: [
      {
        id: 'setup',
        prompt: T(
          'Work in the practice directory, so that the files you create have a home:',
          '',
          '```',
          'mkdir -p ~/practice/files && cd ~/practice/files',
          '```',
          '',
          '`&&` joins two commands and runs the second only if the first succeeded. Here the shell enters the directory only once it is sure the directory exists.',
          '',
          'The prompt should now show `~/practice/files`. The rest of the lesson assumes you are there.'
        ),
        hint: 'Type the whole line, including the two ampersands with a space on each side.',
        solution: 'mkdir -p ~/practice/files && cd ~/practice/files',
        check: { cwd: WORK },
      },
      {
        id: 'write',
        prompt: T(
          'A command writes its results to a stream called **standard output**, which is normally connected to your terminal. `>` connects it to a file instead:',
          '',
          '```',
          'wc -l ' + ACCESS + ' > counts.txt',
          '```',
          '',
          'Nothing appeared, because the line count went into the file. Read it back with `cat counts.txt`.',
          '',
          'If the file does not exist, `>` creates it. If it does exist, `>` empties it first, without any warning.'
        ),
        hint: 'After the path of the log come a space, `>`, another space, and the name of the file to write.',
        solution: 'wc -l ' + ACCESS + ' > counts.txt',
        check: { cmd: 'wc', line: />/, file: { path: WORK + '/counts.txt', contains: /476\s+\S*access\.log/ }, not: { out: /476/ } },
      },
      {
        id: 'append',
        prompt: T(
          '`>>` adds to the end of a file and leaves what is already there in place. Add the line count of the second log:',
          '',
          '```',
          'wc -l ' + AUTH + ' >> counts.txt',
          '```',
          '',
          'Now `cat counts.txt` shows two lines. With a single `>` the second command would have replaced the first result. When the file is a record you are building up, `>>` is the operator you want.'
        ),
        hint: 'Two `>` characters with no space between them. If `counts.txt` ends up with only one line, run the previous step\'s command again and then this one.',
        solution: 'wc -l ' + AUTH + ' >> counts.txt',
        check: { cmd: 'wc', all: [has(WORK + '/counts.txt', /476\s+\S*access\.log/), has(WORK + '/counts.txt', /450\s+\S*auth\.log/)] },
      },
      {
        id: 'stderr',
        prompt: T(
          'Error messages travel on a second stream, **standard error**, so that they do not get mixed into the results. The streams are numbered: standard output is 1 and standard error is 2. `2>` redirects stream 2.',
          '',
          'Ask `ls` about one directory that exists and one that does not, and send only the errors to a file:',
          '',
          '```',
          'ls ' + LOGS + ' /nosuch 2> errors.txt',
          '```',
          '',
          'The listing still appears, because stream 1 was left alone. The complaint about `/nosuch` is in `errors.txt`. Had you used a plain `>`, it would have been the other way round: the listing in the file and the error on your screen.'
        ),
        hint: 'Write `2>` with no space between the digit and the `>`.',
        solution: 'ls ' + LOGS + ' /nosuch 2> errors.txt',
        check: { cmd: 'ls', out: /access\.log/, not: { out: /No such file/ }, file: { path: WORK + '/errors.txt', contains: /No such file or directory/ } },
      },
      {
        id: 'null',
        prompt: T(
          'Sometimes you do not want the errors at all. `/dev/null` is a special file that discards everything written to it.',
          '',
          'Run the same `ls` command on the two directories again, but this time throw the error message away, so that only the listing appears and no file is written.'
        ),
        hint: 'Keep `2>` and change where it points: to `/dev/null` in place of `errors.txt`.',
        solution: 'ls ' + LOGS + ' /nosuch 2> /dev/null',
        check: { cmd: 'ls', argsRe: /nosuch/, line: /\/dev\/null/, out: /access\.log/, not: { out: /No such file/ } },
      },
      {
        id: 'both',
        prompt: T(
          'To keep everything a command said, send both streams to one file. `2>&1` means "send stream 2 to wherever stream 1 is going now":',
          '',
          '```',
          'ls ' + LOGS + ' /nosuch > all.txt 2>&1',
          '```',
          '',
          'Nothing reaches the screen this time. `cat all.txt` shows the error and the listing together.',
          '',
          'The order matters. The shell reads redirections from left to right, so `> all.txt` must come first. Only then does "wherever stream 1 is going" mean the file.'
        ),
        hint: 'Type it exactly: `> all.txt` first, then `2>&1` with no spaces inside it.',
        solution: 'ls ' + LOGS + ' /nosuch > all.txt 2>&1',
        check: {
          cmd: 'ls', not: { out: /No such file|access\.log/ },
          all: [has(WORK + '/all.txt', /No such file or directory/), has(WORK + '/all.txt', /access\.log/)],
        },
      },
      {
        id: 'pipe',
        prompt: T(
          'A **pipe**, written `|`, connects the standard output of one command straight to the input of the next, with no file in between:',
          '',
          '```',
          'ls /usr/bin | wc -l',
          '```',
          '',
          '`ls` writes the names of the programs in `/usr/bin`, one per line, into the pipe. `wc -l` counts the lines it receives. The only thing printed is the count: the number of commands installed there.',
          '',
          'Each command does one small job, and the pipe combines them. Most of the text processing you will do on a security workstation is built this way.'
        ),
        hint: 'The pipe character is a vertical bar. On most keyboards it is typed with Shift and the backslash key.',
        solution: 'ls /usr/bin | wc -l',
        check: { cmd: 'wc', line: /\|/, argsRe: /-l/, out: /^\s*\d+\s*$/ },
      },
      {
        id: 'count',
        prompt: 'Build a pipeline of your own. Use it to count the names in the directory `' + DATA + '/shell`. How many are there?',
        hint: 'Use the same two commands as in the last step. Only the directory given to `ls` changes.',
        solution: '7',
        answer: /^(7|seven)(\s+(names|files|entries))?\.?$/i,
      },
      {
        id: 'tee',
        prompt: T(
          '`>` hides the output from you, and a pipe passes it on without keeping it. `tee` does both jobs: it copies what it receives into a file and also prints it, like a T-shaped junction in a water pipe:',
          '',
          '```',
          'wc -l ' + LOGS + '/*.log | tee counts.txt',
          '```',
          '',
          'You see the two counts and their total, and `counts.txt` now holds the same three lines. Like `>`, `tee` replaces the old content of the file. `tee -a` appends instead, like `>>`.'
        ),
        hint: 'The pattern `*.log` matches both logs. After the pipe comes `tee` and the name of the file to write.',
        solution: 'wc -l ' + LOGS + '/*.log | tee counts.txt',
        check: { cmd: 'tee', out: /926\s+total/, file: { path: WORK + '/counts.txt', contains: /926\s+total/ } },
      },
      {
        id: 'notes',
        prompt: T(
          'Your notes for this engagement are in `~/engagement/notes.md`. Good notes hold the actual output of commands, not a summary from memory.',
          '',
          'Add the line counts of both practice logs, with their total, to the end of `~/engagement/notes.md`. Everything already in the file must stay. Then read the file with `cat` to confirm that the old headings are still above the new lines.',
          '',
          'Check the operator twice before you press Enter. A single `>` would replace your notes.'
        ),
        hint: 'Run the same `wc -l` command as in the last step. Send its output to the notes file either with `>>`, or through a pipe to `tee -a`.',
        solution: 'wc -l ' + LOGS + '/*.log >> ~/engagement/notes.md',
        check: { any: [{ line: />>/ }, { cmd: 'tee', args: ['-a'] }], file: { path: NOTES, contains: /926\s+total/ } },
      },
    ],
    quiz: [
      {
        q: '`results.txt` holds an hour of saved tool output. You run `date > results.txt`. What is in the file afterwards?',
        choices: [
          'The old output, with the date added at the end',
          'The date, with the old output after it',
          'Nothing changes, because the shell refuses to overwrite a file',
          'Only the date: the old output is gone',
        ],
        answer: 3,
        why: '`>` empties an existing file before the command writes to it, and gives no warning. To add to a file, use `>>`.',
      },
      {
        q: 'You run `ls /etc /nosuch > out.txt`. Where does the message about `/nosuch` go?',
        choices: [
          'Into `out.txt`, after the listing',
          'To the terminal, because `>` redirects only standard output',
          'Nowhere: errors are dropped when output is redirected',
          'Into a second file named `out.txt.err`',
        ],
        answer: 1,
        why: 'Error messages travel on standard error, stream 2, and a plain `>` moves only stream 1. The file gets the listing and the error still reaches your screen.',
      },
      {
        q: 'What ends up in `all.txt` after `ls /etc /nosuch 2>&1 > all.txt`?',
        choices: [
          'Only the listing: the error message still goes to the terminal',
          'The listing and the error message',
          'Only the error message',
          'Nothing, because the command is not valid',
        ],
        answer: 0,
        why: 'Redirections are applied from left to right. When `2>&1` is read, stream 1 still points at the terminal, so that is where errors are sent. Only afterwards is stream 1 moved to the file. To capture both, write `> all.txt 2>&1`.',
      },
      {
        q: 'When would you choose `command | tee file` over `command > file`?',
        choices: [
          'When the file must be appended to instead of replaced',
          'When the command needs root privileges',
          'When you want to watch the output on screen and keep a copy at the same time',
          'When the output is too long to fit in one file',
        ],
        answer: 2,
        why: '`tee` writes what it receives to the file and passes it on to the terminal as well. With `>` the output goes only into the file.',
      },
    ],
    refs: ['zshmisc(1), section REDIRECTION', 'tee(1)', 'null(4)', 'pipe(7)', 'NIST SP 800-115, section 7.4 (Data Handling)'],
  };

  K.lessons.register({
    id: 'files',
    title: 'Working with files',
    order: 20,
    summary: 'Look inside files, organize them into a tidy working directory, capture the output of commands, and edit text in nano and vim.',
    lessons: [viewLesson, manageLesson, redirectLesson],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
