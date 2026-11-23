/* Kalima — curriculum module "script": automating with the shell.
 *
 * Lessons: script-first, script-flow, script-sweep, script-report.
 * Learners write small scripts under ~/practice/script and, for the sweep,
 * ~/engagement/scans. Practice data that the lessons need is seeded read-only
 * under /usr/share/kalima/scans (a grepable scan file for script-report).
 * Scripts are written with an editor or with printf; the replay test uses the
 * printf form, so every check tests the file or the output, never the editor.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const WORK = '/home/kali/practice/script';
  /** What a line printed, without colour codes. */
  const outOf = (ev) => K.util.stripAnsi(ev.output || '');
  /** Content of a file on the Kali machine, or null. */
  const readFile = (path) => { try { return K.kali.vfs.read(path); } catch (e) { return null; } };
  const SETUP = 'mkdir -p ~/practice/script && cd ~/practice/script';
  const inWork = { cwd: /\/practice\/script$/ };

  /* ---------------------------------------------------------------- first */
  const firstLesson = {
    id: 'script-first',
    title: 'Your first shell script',
    minutes: 11,
    objectives: [
      'Store values in variables and use quoting correctly',
      'Capture a command\'s output with `$(...)`',
      'Write a script with a `#!` line, make it executable and run it with `./`',
      'Read a command\'s exit status with `$?`',
    ],
    intro: T(
      'Sooner or later you type the same commands twice. A script is those commands saved in a file so that they run the same way every time. That matters on a security workstation: a script is repeatable, it can be read and reviewed, and it documents what you did on an engagement.',
      '',
      'In this lesson you build the smallest useful script and learn the four ideas every script rests on: variables, quoting, command substitution and the exit status.'
    ),
    steps: [
      {
        id: 'variable',
        prompt: T(
          'A *variable* is a name that holds a value. You set one with `name=value`, with no spaces around the equals sign, and you read it back by putting a dollar sign in front of the name.',
          '',
          '```',
          'client="Halcyon Freight"; echo "Client: $client"',
          '```',
          '',
          'The quotes around the value keep the two words together as one value. Two commands on one line are separated by a semicolon. The output should read `Client: Halcyon Freight`.'
        ),
        hint: 'Type the line exactly as shown: assignment, a semicolon, then `echo` with `$client` inside double quotes.',
        solution: 'client="Halcyon Freight"; echo "Client: $client"',
        check: { cmd: 'echo', out: /^Client: Halcyon Freight$/m },
      },
      {
        id: 'single',
        prompt: T(
          'Quotes decide what the shell does with the text inside. Inside **double quotes** the shell still replaces `$client` with its value. Inside **single quotes** it passes the text through exactly as typed. Run the same `echo` with single quotes and compare:',
          '',
          '```',
          'echo \'Client: $client\'',
          '```'
        ),
        hint: 'Use single quotes (the apostrophe key) around the whole text instead of double quotes.',
        solution: 'echo \'Client: $client\'',
        check: { cmd: 'echo', line: /'Client: \$client'/, out: /^Client: \$client$/m },
      },
      {
        id: 'single-q',
        prompt: 'Look at the output of the last command. What did `echo` print in place of the variable\'s value? Type exactly what appeared after `Client: `.',
        hint: 'The shell did not replace anything inside single quotes, so the variable\'s name is printed as typed.',
        solution: '$client',
        answer: /^\$client$/,
      },
      {
        id: 'substitution',
        prompt: T(
          '*Command substitution* runs a command and puts its output where the `$(...)` was. It is how a script learns something about the system and keeps it in a variable.',
          '',
          '```',
          'today=$(date +%F); echo "Report date: $today"',
          '```',
          '',
          '`date +%F` prints the date as year-month-day, so the result looks like `Report date: 2026-11-13`. Use this form for anything you will want in a file name or a log line.'
        ),
        hint: 'Put `date +%F` inside `$(...)` on the right of the equals sign, then print the variable.',
        solution: 'today=$(date +%F); echo "Report date: $today"',
        check: { out: /^Report date: \d{4}-\d{2}-\d{2}$/m, line: /\$\(/ },
      },
      {
        id: 'workdir',
        prompt: T(
          'Now the script itself. Work in a folder of your own so the practice files stay together:',
          '',
          '```',
          SETUP,
          '```',
          '',
          '`mkdir -p` creates the folder and does not complain if it already exists. In a real engagement the equivalent folder would live under `~/engagement`.'
        ),
        hint: 'Use `mkdir -p` with the path, then `cd` into it.',
        solution: SETUP,
        check: { cwd: /\/practice\/script$/ },
      },
      {
        id: 'write',
        prompt: T(
          'Create a file named `notes.sh` with these five lines. You can use an editor (`nano notes.sh`, then Ctrl-O, Enter and Ctrl-X to save and leave) or let `printf` write it:',
          '',
          '```',
          '#!/bin/bash',
          'client="Halcyon Freight"',
          'echo "Notes for $client"',
          'echo "Run by $(whoami) on $(hostname)"',
          'echo "Working in $(pwd)"',
          '```',
          '',
          'The first line, starting with `#!`, is called the *shebang*. It names the program that should run the file, here `/bin/bash`. Check the result with `cat notes.sh`.'
        ),
        hint: 'With `printf`, put the whole text in single quotes and write `\\n` where each line ends, then redirect with `> notes.sh`.',
        solution: 'printf \'#!/bin/bash\\nclient="Halcyon Freight"\\necho "Notes for $client"\\necho "Run by $(whoami) on $(hostname)"\\necho "Working in $(pwd)"\\n\' > notes.sh',
        check: { file: { path: WORK + '/notes.sh', exists: true, contains: /^#!\/bin\/bash\n[\s\S]*\$\(whoami\)[\s\S]*\$\(hostname\)/ } },
      },
      {
        id: 'denied',
        prompt: T(
          'To run a file as a program you give its path. The current folder is written `.`, so `./notes.sh` means "the file notes.sh in this folder". Try it:',
          '',
          '```',
          './notes.sh',
          '```',
          '',
          'It fails with `permission denied`. A new file is not executable, and that is a safety feature: nothing runs until someone decides it should.'
        ),
        hint: 'Type `./notes.sh`. The error is expected.',
        solution: './notes.sh',
        check: { line: /\.\/notes\.sh/, out: /permission denied/i },
      },
      {
        id: 'chmod',
        prompt: T(
          'Give yourself permission to execute the file, then run it:',
          '',
          '```',
          'chmod +x notes.sh && ./notes.sh',
          '```',
          '',
          '`chmod +x` adds the execute bit. `&&` runs the second command only if the first one succeeded. You should see three lines, ending with the folder you are in.'
        ),
        hint: '`chmod +x notes.sh` first, then `./notes.sh`.',
        solution: 'chmod +x notes.sh && ./notes.sh',
        check: { out: /^Notes for Halcyon Freight$/m, exit: 0, file: { path: WORK + '/notes.sh', exists: true, contains: /#!\/bin\/bash/ } },
      },
      {
        id: 'status',
        prompt: T(
          'Every command ends with a number, its *exit status*. `0` means success and anything else means some kind of failure. The shell keeps the last one in the special variable `$?`. `grep -q` prints nothing and only sets the status, which makes it a good test:',
          '',
          '```',
          'grep -q kali /etc/passwd; echo $?; grep -q zzzz /etc/passwd; echo $?',
          '```',
          '',
          'The first search finds a match, the second does not. Scripts use these numbers to decide what to do next.'
        ),
        hint: 'Run `grep -q` on `/etc/passwd` twice, once for a word that is there and once for one that is not, and print `$?` after each.',
        solution: 'grep -q kali /etc/passwd; echo $?; grep -q zzzz /etc/passwd; echo $?',
        check: { cmd: 'grep', out: /^0\n1$/m },
      },
      {
        id: 'status-q',
        prompt: 'In the output above, which number meant "found a match"? Answer with the number.',
        hint: 'It was printed on the first line, after the search that succeeded.',
        solution: '0',
        answer: ['0', 'zero'],
      },
    ],
    quiz: [
      {
        q: 'You run `name=Kali Linux` and the shell complains that `Linux` is not found. What went wrong?',
        choices: [
          'Variable names must be written in capitals',
          'The value has a space and is not quoted, so the shell treats `Linux` as a command',
          'A variable can be set only inside a script',
          'The dollar sign is missing',
        ],
        answer: 1,
        why: 'Without quotes the shell splits the line at the space: `name=Kali` becomes a one-off assignment for the command `Linux`, which does not exist. Quote values that contain spaces.',
      },
      {
        q: 'After `host=web01`, what does `echo \'$host\'` print?',
        choices: ['web01', '$host', 'nothing', 'host'],
        answer: 1,
        why: 'Single quotes stop the shell from expanding anything, so the text is printed exactly as typed. Double quotes would have printed web01.',
      },
      {
        q: 'You wrote a script, saved it as `scan.sh` and ran `./scan.sh`, which printed `permission denied`. What is the usual fix?',
        choices: [
          'Run it with sudo every time',
          'Rename it without the extension',
          'Run `chmod +x scan.sh` to add the execute permission',
          'Delete the first line',
        ],
        answer: 2,
        why: 'A file only runs as a program when its execute bit is set. `chmod +x` sets it. Using sudo would run your script with more privilege than it needs.',
      },
      {
        q: 'A command prints nothing and `echo $?` shows `1`. What does that tell you?',
        choices: [
          'The command succeeded quietly',
          'The command failed or found nothing, depending on the command',
          'The command ran one time',
          'The terminal is broken',
        ],
        answer: 1,
        why: 'Zero is success; any other value is a failure. What a particular non-zero value means is defined by the command, and for grep it means no match.',
      },
    ],
    refs: ['bash(1)', 'chmod(1)', 'GNU Bash Reference Manual'],
  };

  const lessons = [firstLesson];

  K.lessons.register({
    id: 'script',
    title: 'Automating with the shell',
    order: 130,
    summary: 'Turn commands you repeat into small, readable scripts: variables, tests, loops, a careful reachability sweep and a summary report.',
    lessons,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
