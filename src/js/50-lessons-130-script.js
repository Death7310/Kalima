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

  /* ----------------------------------------------------------------- flow */
  const GREET = '#!/bin/bash\\nif [ $# -lt 1 ]; then\\n  echo "usage: $0 name" >&2\\n  exit 2\\nfi\\necho "Hello, $1. You gave $# argument(s)."\\n';
  const flowLesson = {
    id: 'script-flow',
    title: 'Tests, loops and arguments',
    minutes: 12,
    objectives: [
      'Test a condition with `[ ]` and branch with `if` and `else`',
      'Repeat work with `for` over a list, `while read` over the lines of a file and `while` with a counter',
      'Make a script take input from its arguments using `$1` and `$#`',
    ],
    intro: T(
      'A script that only replays fixed commands is a start. The useful ones decide and repeat: check that a file exists before reading it, do the same thing for every address in a list, and take their input from the command line instead of having it written into the file.',
      '',
      'These are the building blocks of every tool you will write for a security assessment, from a note-taking helper to a careful sweep of a scoped list of hosts.'
    ),
    steps: [
      {
        id: 'workdir',
        prompt: T(
          'Work in a folder of your own so the practice files stay together:',
          '',
          '```',
          SETUP,
          '```'
        ),
        hint: 'Use `mkdir -p` with the path, then `cd` into it.',
        solution: SETUP,
        check: { cwd: /\/practice\/script$/ },
      },
      {
        id: 'test',
        prompt: T(
          'The brackets in `[ -f /etc/passwd ]` are not decoration: `[` is a command, and it needs a space after it and before the closing `]`. It tests a condition and reports the answer as an exit status, `0` for true and `1` for false. `-f` asks whether a path is a regular file and `-d` whether it is a directory. Try one of each:',
          '',
          '```',
          '[ -f /etc/passwd ]; echo $?; [ -d /nonexistent ]; echo $?',
          '```',
          '',
          'Expect `0` and then `1`.'
        ),
        hint: 'One line with two tests and an `echo $?` after each.',
        solution: '[ -f /etc/passwd ]; echo $?; [ -d /nonexistent ]; echo $?',
        check: { out: /^0\n1$/m, line: /\[ -f .*\]/ },
      },
      {
        id: 'if',
        prompt: T(
          '`if` runs a test and chooses what happens next. On one line, the parts are separated by semicolons:',
          '',
          '```',
          'if [ -f ~/engagement/scope.txt ]; then echo "scope file present"; else echo "scope file missing"; fi',
          '```',
          '',
          'The line is `if` *test*, `then` *commands*, `else` *commands*, `fi`. (`fi` is `if` backwards and closes the block.) Checking that the scope file exists before you do anything else is a good habit.',
          '',
          'Numbers and text are compared with different operators. For numbers use `-eq` (equal), `-ne`, `-lt`, `-le`, `-gt` and `-ge`, as in `[ "$ports" -gt 3 ]`. For text use `=` and `!=`, as in `[ "$answer" = yes ]`.'
        ),
        hint: 'Copy the line. Every `;` before `then`, `else` and `fi` matters when it is all on one line.',
        solution: 'if [ -f ~/engagement/scope.txt ]; then echo "scope file present"; else echo "scope file missing"; fi',
        check: { line: /\bif\b.*\bthen\b.*\bfi\b/, out: /scope file present/ },
      },
      {
        id: 'for-list',
        prompt: T(
          'A `for` loop runs the same commands once per item in a list. The loop variable takes each value in turn:',
          '',
          '```',
          'for h in web01 files01 db01; do echo "checking $h"; done',
          '```',
          '',
          'Between `do` and `done` you can put anything you could type at the prompt. This list is typed in the loop; the next steps read it from a file.'
        ),
        hint: 'The shape is `for NAME in WORDS; do COMMANDS; done`.',
        solution: 'for h in web01 files01 db01; do echo "checking $h"; done',
        check: { line: /\bfor\b.*\bin\b.*\bdo\b.*\bdone\b/, out: /^checking web01\nchecking files01\nchecking db01$/m },
      },
      {
        id: 'hostsfile',
        prompt: T(
          'Lists of targets belong in files, not in the loop, so they can be reviewed against the scope. Create `hosts.txt` in your practice folder with three addresses, one per line: `10.10.10.10`, `10.10.10.20` and `10.10.10.30`. These are lab hosts inside the engagement scope.'
        ),
        hint: 'Use `printf` with `\\n` between the addresses and redirect into `hosts.txt`, or write the file in an editor.',
        solution: 'printf \'10.10.10.10\\n10.10.10.20\\n10.10.10.30\\n\' > hosts.txt',
        check: { file: { path: WORK + '/hosts.txt', exists: true, contains: /^10\.10\.10\.10\n10\.10\.10\.20\n10\.10\.10\.30\n?$/ } },
      },
      {
        id: 'while-read',
        prompt: T(
          'To work through a file one line at a time, use `while read` and feed the file into the loop with `<`:',
          '',
          '```',
          'while read -r ip; do echo "address: $ip"; done < hosts.txt',
          '```',
          '',
          '`read` takes one line into the variable and reports failure at the end of the file, which ends the loop. `-r` stops it from treating backslashes specially. You will see one `address:` line per line of the file.'
        ),
        hint: 'The file goes in after `done`, using `< hosts.txt`.',
        solution: 'while read -r ip; do echo "address: $ip"; done < hosts.txt',
        check: { line: /\bwhile\b.*\bread\b.*\bdone\b/, out: /^address: 10\.10\.10\.10\naddress: 10\.10\.10\.20\naddress: 10\.10\.10\.30$/m },
      },
      {
        id: 'counter',
        prompt: T(
          'A `while` loop can also run for as long as a test stays true. Set a counter, test it on every pass and change it inside the loop. `$(( ))` does integer arithmetic. Goal: print `attempt 1`, `attempt 2` and `attempt 3` and then stop.',
          '',
          'The pieces: `n=1`, `while [ "$n" -le 3 ]`, `echo "attempt $n"`, and `n=$((n+1))`. If you forget to change the counter the loop never ends; Ctrl-C interrupts it.'
        ),
        hint: 'Put the `echo` and the `n=$((n+1))` between `do` and `done`, separated by a semicolon.',
        solution: 'n=1; while [ "$n" -le 3 ]; do echo "attempt $n"; n=$((n+1)); done',
        check: { line: /\bwhile\b.*\bdone\b/, out: /^attempt 1\nattempt 2\nattempt 3$/m },
      },
      {
        id: 'args-write',
        prompt: T(
          'Scripts receive what you type after their name as *arguments*: `$1` is the first, `$2` the second, `$#` is how many there were, and `$0` is the script\'s own name. Create `greet.sh` that prints a usage message and exits with status 2 when no argument was given, and otherwise greets the first one:',
          '',
          '```',
          '#!/bin/bash',
          'if [ $# -lt 1 ]; then',
          '  echo "usage: $0 name" >&2',
          '  exit 2',
          'fi',
          'echo "Hello, $1. You gave $# argument(s)."',
          '```',
          '',
          '`>&2` sends the message to the error stream, where a usage message belongs, and `exit 2` ends the script with a status that says "wrong usage".'
        ),
        hint: 'Write it in an editor, or with one `printf` where each `\\n` ends a line. Mind the single quotes around the text.',
        solution: 'printf \'' + GREET + '\' > greet.sh',
        check: { file: { path: WORK + '/greet.sh', exists: true, contains: /\$#[\s\S]*exit 2[\s\S]*\$1/ } },
      },
      {
        id: 'args-run',
        prompt: T(
          'Make it executable, then run it twice: once with a name, and once with no argument, printing the exit status after the second run.',
          '',
          '```',
          'chmod +x greet.sh; ./greet.sh Ana; ./greet.sh; echo $?',
          '```',
          '',
          'The first run takes the `if` branch that skips the usage message and prints the greeting, and the second takes the branch that prints the usage message and exits early.'
        ),
        hint: '`chmod +x greet.sh` once, then `./greet.sh Ana`, then `./greet.sh` with nothing after it and `echo $?`.',
        solution: 'chmod +x greet.sh; ./greet.sh Ana; ./greet.sh; echo $?',
        check: { out: /^Hello, Ana\. You gave 1 argument\(s\)\.$/m, fn: (ev) => /^usage: .*greet\.sh name$/m.test(outOf(ev)) && /^2$/m.test(outOf(ev)) },
      },
      {
        id: 'args-q',
        prompt: 'Which exit status did the script return when you ran it without an argument (the number printed at the end of the last output)? Answer with the number.',
        hint: 'It is the number printed by `echo $?`, and it comes from the `exit` line in the script.',
        solution: '2',
        answer: ['2', 'two'],
      },
    ],
    quiz: [
      {
        q: 'What is wrong with `if [-f notes.txt]; then echo yes; fi`?',
        choices: [
          'Nothing, it is correct',
          'There must be spaces inside the brackets, because `[` is a command and `]` is its last argument',
          '`-f` only works on directories',
          'The word `then` must be on its own line',
        ],
        answer: 1,
        why: 'The shell would look for a command named `[-f`. Write `[ -f notes.txt ]` with a space after `[` and before `]`.',
      },
      {
        q: 'A file has 40 lines and each line is a host name. Why is `while read -r host; do ...; done < file` safer than `for host in $(cat file)`?',
        choices: [
          'It is much faster',
          'It handles each line as a unit, while the `for` form splits on every space and tab as well',
          'It works without the file existing',
          'There is no difference',
        ],
        answer: 1,
        why: 'Command substitution output is split into words at any whitespace. A line with two words becomes two loop passes. `read` takes whole lines.',
      },
      {
        q: 'A script contains `echo "First: $1"` and you run `./list.sh a b c`. What does `$#` hold?',
        choices: ['1', '3', '4', 'The name of the script'],
        answer: 1,
        why: '`$#` counts the arguments, not the script name: a, b and c make three. The name is `$0`.',
      },
      {
        q: 'Which loop never ends, if nothing else stops it?',
        choices: [
          '`n=1; while [ "$n" -le 3 ]; do echo $n; n=$((n+1)); done`',
          '`for i in 1 2 3; do echo $i; done`',
          '`n=1; while [ "$n" -le 3 ]; do echo $n; done`',
          '`while read -r x; do echo $x; done < hosts.txt`',
        ],
        answer: 2,
        why: 'Here `n` never changes, so the test stays true for ever. The others change the counter, run out of list items or reach the end of the file.',
      },
    ],
    refs: ['bash(1), sections on Compound Commands and Parameters', 'test(1)', 'GNU Bash Reference Manual'],
  };

  /* ----------------------------------------------------------------- sweep */
  const SWEEP = [
    '#!/bin/bash',
    '# sweep.sh LIST - send one ping to each address in LIST and record the result',
    'list="$1"',
    'if [ ! -f "$list" ]; then',
    '  echo "usage: $0 list" >&2',
    '  exit 2',
    'fi',
    'out="$HOME/engagement/scans/sweep-$(date +%F).txt"',
    ': > "$out"',
    'while read -r ip; do',
    '  case "$ip" in',
    '    10.10.10.*) ;;',
    '    *) echo "skipping $ip: outside the scope" >&2; continue ;;',
    '  esac',
    '  if ping -c 1 -W 1 "$ip" > /dev/null 2>&1; then',
    '    echo "$(date +%T) $ip up" >> "$out"',
    '  else',
    '    echo "$(date +%T) $ip no-reply" >> "$out"',
    '  fi',
    'done < "$list"',
    'echo "wrote $out"',
    '',
  ];
  /** printf command that writes the text above: backslash-n for line ends, %% for a literal percent sign. */
  const SWEEP_PRINTF = 'printf \'' + SWEEP.join('\\n').replace(/%/g, '%%') + '\' > sweep.sh';
  const sweepLesson = {
    id: 'script-sweep',
    title: 'A careful reachability sweep',
    minutes: 12,
    objectives: [
      'Send one ping with a one-second timeout and read its exit status',
      'Write a loop that checks each address from a list file and records the result under `~/engagement/scans`',
      'Explain why the target list comes from the scope file and why a sweep stays small',
    ],
    intro: T(
      'Checking which hosts answer is usually the first technical step of an assessment, and it is a good first real script: a loop, a test and a results file. It is also where care matters most. Every address you send traffic to must be inside the agreed scope, so the list is drawn from `scope.txt` and checked again by the script. Every packet is a line in somebody\'s log. A short, deliberate list does the job and leaves a short, deliberate trail.',
      '',
      'You will write the sweep for five lab hosts, run it and read the result.'
    ),
    steps: [
      {
        id: 'scope',
        prompt: T(
          'Everything starts from the scope file. Go to the engagement folder and read it:',
          '',
          '```',
          'cd ~/engagement && cat scope.txt',
          '```'
        ),
        hint: 'Change into `~/engagement`, then `cat scope.txt`; `&&` lets you do both on one line.',
        solution: 'cd ~/engagement && cat scope.txt',
        check: { cwd: /\/engagement$/, out: /10\.10\.10\.0\/24/ },
      },
      {
        id: 'scope-q',
        prompt: 'Which network range is listed under `IN SCOPE`? Type it as it appears in the file.',
        hint: 'It is the line of numbers with a slash, just below `# IN SCOPE`.',
        solution: '10.10.10.0/24',
        answer: /^10\.10\.10\.0\/24$/,
      },
      {
        id: 'targets',
        prompt: T(
          'A range is not a to-do list. You decide which hosts you need to check and write them down, so the list can be reviewed. Create `~/engagement/targets.txt` with these six lines, in this order:',
          '',
          '```',
          '10.10.10.10',
          '10.10.10.20',
          '10.10.10.30',
          '10.10.10.50',
          '10.10.10.77',
          '192.0.2.9',
          '```',
          '',
          'The first five are in scope. The last one stands for an address someone pasted in from an old email. It is not in scope, and the script will have to refuse it.'
        ),
        hint: 'Use `printf` with `\\n` between the addresses, or an editor. The file belongs in `~/engagement`.',
        solution: 'printf \'10.10.10.10\\n10.10.10.20\\n10.10.10.30\\n10.10.10.50\\n10.10.10.77\\n192.0.2.9\\n\' > ~/engagement/targets.txt',
        check: { file: { path: '/home/kali/engagement/targets.txt', exists: true, contains: /^10\.10\.10\.10\n10\.10\.10\.20\n10\.10\.10\.30\n10\.10\.10\.50\n10\.10\.10\.77\n192\.0\.2\.9\n?$/ } },
      },
      {
        id: 'ping-one',
        prompt: T(
          'Before looping, run the single check by hand. `-c 1` sends one packet and `-W 1` waits at most one second for the reply, so a silent host cannot hold you up for long:',
          '',
          '```',
          'ping -c 1 -W 1 10.10.10.10',
          '```',
          '',
          'Look at the summary line: `1 packets transmitted, 1 received, 0% packet loss` means the host answered.'
        ),
        hint: 'The options are `-c 1` and `-W 1`, followed by the address.',
        solution: 'ping -c 1 -W 1 10.10.10.10',
        check: { cmd: 'ping', args: ['-c', '-W'], out: /1 received, 0% packet loss/ },
      },
      {
        id: 'ping-silent',
        prompt: T(
          'Now an address that does not answer, and the exit status that tells a script so:',
          '',
          '```',
          'ping -c 1 -W 1 10.10.10.50; echo $?',
          '```',
          '',
          '`ping` exits with `0` when a reply came back and `1` when none did. Notice that this tells you the host did not *answer*, not that it is down: `10.10.10.50` is the domain controller, and it is configured to drop ping. Silence is a fact about the reply, not proof about the host.'
        ),
        hint: 'Same ping as before with the other address, then `echo $?` after a semicolon.',
        solution: 'ping -c 1 -W 1 10.10.10.50; echo $?',
        check: { cmd: 'ping', out: /100% packet loss/, fn: (ev) => /^1$/m.test(outOf(ev)) },
      },
      {
        id: 'write',
        prompt: T(
          'Here is the sweep as a script. Create `~/engagement/sweep.sh` with this content, with an editor, or with a single `printf` command (the solution shows one):',
          '',
          '```',
          '#!/bin/bash',
          '# sweep.sh LIST - send one ping to each address in LIST and record the result',
          'list="$1"',
          'if [ ! -f "$list" ]; then',
          '  echo "usage: $0 list" >&2',
          '  exit 2',
          'fi',
          'out="$HOME/engagement/scans/sweep-$(date +%F).txt"',
          ': > "$out"',
          'while read -r ip; do',
          '  case "$ip" in',
          '    10.10.10.*) ;;',
          '    *) echo "skipping $ip: outside the scope" >&2; continue ;;',
          '  esac',
          '  if ping -c 1 -W 1 "$ip" > /dev/null 2>&1; then',
          '    echo "$(date +%T) $ip up" >> "$out"',
          '  else',
          '    echo "$(date +%T) $ip no-reply" >> "$out"',
          '  fi',
          'done < "$list"',
          'echo "wrote $out"',
          '```',
          '',
          'How it works. The list file is the first argument. `: > "$out"` empties the results file so a second run starts clean. The `case` block is the scope guard: only addresses that begin `10.10.10.` continue, and anything else is reported and skipped with `continue`. The ping goes inside `if`, so its exit status decides the branch, and `> /dev/null 2>&1` hides its output because you only want the result. In `printf`, a literal percent sign has to be written `%%`.'
        ),
        hint: 'Typing it into `nano ~/engagement/sweep.sh` is the most natural way. Save with Ctrl-O, Enter, then leave with Ctrl-X. The solution shows the one-line `printf` form.',
        solution: SWEEP_PRINTF.replace('> sweep.sh', '> ~/engagement/sweep.sh'),
        check: { file: { path: '/home/kali/engagement/sweep.sh', exists: true, contains: /^#!\/bin\/bash\n[\s\S]*while read[\s\S]*case[\s\S]*ping -c 1 -W 1[\s\S]*done/ } },
      },
      {
        id: 'run',
        prompt: T(
          'Make it executable and run it on your list:',
          '',
          '```',
          'chmod +x sweep.sh && ./sweep.sh targets.txt',
          '```',
          '',
          'Run it from `~/engagement`. The script reports the skipped address and tells you where it wrote the results.',
          '',
          'A note on time: each silent address costs the one-second timeout, so this run takes a few seconds. If you do not want to wait in real time, the simulator can shorten the waiting: `kalima speed fast` makes waits four times shorter and `kalima speed instant` removes them. `kalima speed realtime` puts it back. On a real network a sweep of hundreds of addresses is a decision to make with the client, not a loop to run casually.'
        ),
        hint: 'You should be in `~/engagement`. `chmod +x sweep.sh`, then `./sweep.sh targets.txt`.',
        solution: 'chmod +x sweep.sh && ./sweep.sh targets.txt',
        check: { out: /skipping 192\.0\.2\.9: outside the scope/, fn: (ev) => /wrote \/home\/kali\/engagement\/scans\/sweep-\d{4}-\d{2}-\d{2}\.txt/.test(outOf(ev)) },
      },
      {
        id: 'results',
        prompt: T(
          'Read what the script recorded:',
          '',
          '```',
          'cat ~/engagement/scans/sweep-*.txt',
          '```',
          '',
          'Each line is a time, an address and `up` or `no-reply`. The out-of-scope address was never contacted, so it does not appear at all.'
        ),
        hint: 'The results files are in `~/engagement/scans`; `sweep-*.txt` matches them.',
        solution: 'cat ~/engagement/scans/sweep-*.txt',
        check: { cmd: 'cat', out: /10\.10\.10\.10 up/, fn: (ev) => /10\.10\.10\.77 no-reply/.test(outOf(ev)) },
      },
      {
        id: 'results-q',
        prompt: 'How many of the addresses in the results file are marked `up`? Answer with the number.',
        hint: 'Count the lines that end in `up`. `grep -c " up$"` would count them for you.',
        solution: '3',
        answer: ['3', 'three'],
      },
      {
        id: 'note',
        prompt: T(
          'A result without a record is hard to defend later. Add a line to your engagement notes saying what you ran, with a timestamp:',
          '',
          '```',
          'echo "$(date \'+%F %T\') ping sweep of targets.txt (5 lab hosts), results in scans/" >> ~/engagement/notes.md',
          '```',
          '',
          '`>>` appends. The note says when you tested, what you tested and where the output is, which is what a client asks for if a log entry on their side needs an explanation.'
        ),
        hint: 'Append with `>>` to `~/engagement/notes.md`. Include the word `sweep` and a `date` call.',
        solution: 'echo "$(date \'+%F %T\') ping sweep of targets.txt (5 lab hosts), results in scans/" >> ~/engagement/notes.md',
        check: { line: /notes\.md/, file: { path: '/home/kali/engagement/notes.md', exists: true, contains: /sweep/i } },
      },
    ],
    quiz: [
      {
        q: 'Why is the target list written from `scope.txt` and not typed from memory or copied from a colleague\'s message?',
        choices: [
          'It makes the loop run faster',
          'Authorization is defined by the scope document, so every address you touch must be traceable to it',
          'ping refuses addresses that are not in a file',
          'Scripts cannot take addresses from the command line',
        ],
        answer: 1,
        why: 'Permission to test covers the systems the client named and nothing else. Building the list from the scope file, and checking it again in the script, keeps you from touching something you are not authorized to touch.',
      },
      {
        q: 'The sweep reports `10.10.10.50 no-reply`. What can you conclude?',
        choices: [
          'The host is switched off',
          'The host is not at that address',
          'It sent no reply to one ping; it may be down, or it may filter ICMP',
          'The scope is wrong',
        ],
        answer: 2,
        why: 'No reply means no reply. Firewalls often drop ICMP while the host and its services run normally, as the domain controller does here. Another check, such as a connection to a known port, is needed to say more.',
      },
      {
        q: 'What does `ping -c 1 -W 1 host` do differently from plain `ping host` on Linux?',
        choices: [
          'It sends one packet and gives up after one second without a reply, instead of sending until interrupted',
          'It sends one packet per second for one minute',
          'It pings from port 1',
          'It skips name resolution',
        ],
        answer: 0,
        why: '`-c` is the count of packets to send and `-W` the time in seconds to wait for a reply. Without `-c`, Linux ping keeps going until you press Ctrl-C.',
      },
      {
        q: 'Why keep a sweep list short and deliberate even when the whole /24 is in scope?',
        choices: [
          'Larger lists make the script fail',
          'Every packet appears in the client\'s logs and monitoring; testing only what the question needs keeps the noise, the load and the risk down',
          'Bash loops cannot read more than ten lines',
          'It is the law in every country',
        ],
        answer: 1,
        why: 'Being in scope means you may test, not that you must test everything. Minimal, planned traffic is easier to explain, less likely to disturb services and in line with the rules of engagement.',
      },
    ],
    refs: ['ping(8)', 'bash(1), the case and if commands', 'NIST SP 800-115, section on network discovery'],
  };

  const lessons = [firstLesson, flowLesson, sweepLesson];

  K.lessons.register({
    id: 'script',
    title: 'Automating with the shell',
    order: 130,
    summary: 'Turn commands you repeat into small, readable scripts: variables, tests, loops, a careful reachability sweep and a summary report.',
    lessons,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
