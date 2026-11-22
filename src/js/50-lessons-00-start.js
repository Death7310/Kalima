/* Kalima — curriculum module "start": orientation.
 *
 * Lessons: start-welcome, start-kali, start-engagement. They only read: the
 * system's own identity files, the kalima command, and the engagement papers
 * in ~/engagement. The one write is a dated entry appended to
 * ~/engagement/notes.md (start-engagement). Checks look at what a line printed
 * or at the state it left behind.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const outOf = (ev) => K.util.stripAnsi(ev.output || '');
  const NOTES = '/home/kali/engagement/notes.md';
  const appendsToNotes = { any: [{ line: />>\s*\S*notes\.md/ }, { cmd: 'tee', args: ['-a'], argsRe: /notes\.md/ }] };
  /** Answers to in-scope questions. */
  const YES = /^(yes|y|in|in scope|in-scope|it is|it is in scope)\.?$/i;
  const NO = /^(no|n|out|out of scope|out-of-scope|it is not|it is not in scope|not in scope)\.?$/i;

  /* ---------------------------------------------------------------- welcome */
  const welcome = {
    id: 'start-welcome',
    title: 'How Kalima works',
    minutes: 8,
    objectives: [
      'Explain what the terminal, the lesson panel and the lab panel are for',
      'Use `kalima help`, `kalima status` and `kalima speed` to learn about the simulator',
      'Identify who you are, which machine you are on and which Kali release it runs',
    ],
    intro: T(
      'Kalima is a practice workstation. It simulates a Kali Linux 2026.3 machine, a small company network and a slice of the internet, all inside this page. Nothing you type reaches a real network, so you can try things, make mistakes and repeat them.',
      '',
      'What you learn here is real, though. The commands, the options and the way output looks follow the real tools. Reading that output carefully is the skill this course builds, and it starts with a small habit: before you do anything on a system, find out where you are.'
    ),
    steps: [
      {
        id: 'layout',
        info: true,
        prompt: T(
          'The screen has three parts.',
          '',
          '- The **terminal** is where you type. Every command you run here is run by a simulated shell, `zsh`, on a simulated Kali machine named `kali`.',
          '- The **lesson panel** shows the step you are on. When the line you typed does what the step asks, the step is marked done. The hint nudges you; the solution shows the full command if you are stuck.',
          '- The **lab panel** shows the lab hosts you have found so far, so you can follow what your own commands discover.',
          '',
          'On a narrow screen the three parts are tabs: Lesson, Terminal and Lab.',
          '',
          'Steps come in two kinds. A *command* step asks you to type something in the terminal. A *question* step asks you to read something off the screen and type the answer into the lesson panel.'
        ),
      },
      {
        id: 'whoami',
        prompt: T(
          'Start with the most basic question: which user are you? The command is `whoami`, short for "who am I":',
          '',
          '```',
          'whoami',
          '```',
          '',
          'Type it in the terminal and press Enter. The output is a single word, your user name.'
        ),
        hint: 'Type `whoami` in the terminal and press Enter.',
        solution: 'whoami',
        check: { cmd: 'whoami', out: /^kali$/m },
      },
      {
        id: 'who-q',
        prompt: 'Which user name did `whoami` print? Type it in the answer box.',
        hint: 'Look at the line the command printed. It is one word.',
        solution: 'kali',
        answer: /^kali$/i,
      },
      {
        id: 'hostname',
        prompt: T(
          'You know who you are. Now find out which machine you are on. `hostname` prints the machine\'s name:',
          '',
          '```',
          'hostname',
          '```',
          '',
          'On a real engagement this matters. When you have several terminals and SSH sessions open, it is easy to type a command on the wrong machine. The name in the prompt and the output of `hostname` tell you which one you are on.'
        ),
        hint: 'Type `hostname` and press Enter.',
        solution: 'hostname',
        check: { cmd: 'hostname', out: /^kali$/m },
      },
      {
        id: 'release',
        prompt: T(
          'Next, which operating system is this? Linux systems keep that in a text file, `/etc/os-release`. Print it with `cat`, which shows the contents of a file:',
          '',
          '```',
          'cat /etc/os-release',
          '```',
          '',
          'Each line is `NAME=value`. `VERSION_ID` is the release number. (`lsb_release -a` prints the same facts in a different layout, and you may use either.)'
        ),
        hint: 'Use `cat /etc/os-release`, or `lsb_release -a`.',
        solution: 'cat /etc/os-release',
        check: { any: [{ cmd: 'cat', args: ['/etc/os-release'], out: /2026\.3/ }, { cmd: 'lsb_release', out: /2026\.3/ }] },
      },
      {
        id: 'release-q',
        prompt: 'Which Kali release number is this machine running? Read the `VERSION_ID` line (or `Release:`) and type it.',
        hint: 'The number looks like a year, a dot and a digit.',
        solution: '2026.3',
        answer: /^(kali\s*)?2026\.3$/i,
      },
      {
        id: 'help',
        prompt: T(
          'Kalima adds one command of its own, `kalima`, for managing the simulator. Without it you would not know what the simulator can do for you, so read its overview:',
          '',
          '```',
          'kalima help',
          '```',
          '',
          'Skim the sections LEARNING, THE ENGAGEMENT and COMMANDS. The paperwork for your engagement is in a folder called `engagement` in your home directory, and you will use it throughout this course.'
        ),
        hint: 'Type `kalima help`.',
        solution: 'kalima help',
        check: { cmd: 'kalima', out: /THE ENGAGEMENT/ },
      },
      {
        id: 'status',
        prompt: T(
          '`kalima status` summarizes the simulation: the release, the kernel, your machine and its network address, the engagement, and your lesson progress:',
          '',
          '```',
          'kalima status',
          '```'
        ),
        hint: 'Type `kalima status`.',
        solution: 'kalima status',
        check: { cmd: 'kalima', args: ['status'], out: /Machine/ },
      },
      {
        id: 'ip-q',
        prompt: 'On the `Machine` line, what is the IPv4 address of your workstation? Type the address, without the part after the slash.',
        hint: 'The line reads `kali, ` followed by an address and `/24`.',
        solution: '10.10.10.5',
        answer: /^10\.10\.10\.5(\s*\/\s*24)?$/,
      },
      {
        id: 'speed',
        prompt: T(
          'Some real commands take a long time. A scan can run for minutes. The simulator lets you choose how fast simulated time passes. Look at the current setting:',
          '',
          '```',
          'kalima speed',
          '```',
          '',
          'The default, `realtime`, makes waits as long as on a real system, which teaches you how long things take. `fast` and `instant` skip the waiting. Change it with `kalima speed fast` if you are impatient; this course works at every speed.'
        ),
        hint: 'Type `kalima speed` with no argument to only look at the setting.',
        solution: 'kalima speed',
        check: { cmd: 'kalima', args: ['speed'], out: /realtime/ },
      },
    ],
    quiz: [
      {
        q: 'You type a scan command and the simulator is slow to answer. What does that mean?',
        choices: [
          'The command reached a real network and the network is slow',
          'The simulator imitates real timing; `kalima speed fast` shortens the waits',
          'Your lesson progress is lost',
          'The lab hosts are overloaded',
        ],
        answer: 1,
        why: 'Nothing leaves the page. Waits are simulated on purpose so you learn how long real tools take, and `kalima speed` changes the pace.',
      },
      {
        q: 'Why check `hostname` before running a command you are unsure about?',
        choices: [
          'It makes the command run faster',
          'It shows which machine the command will act on, which is easy to forget with several sessions open',
          'It changes the name of the machine',
          'It is required before every command',
        ],
        answer: 1,
        why: '`hostname` only reports the name, and that is the point: running the right command on the wrong machine is a classic mistake.',
      },
      {
        q: 'A lesson step is a question step. Where do you type the answer?',
        choices: ['In the terminal', 'In the answer box of the lesson panel', 'In a file in your home directory', 'In the lab panel'],
        answer: 1,
        why: 'Question steps ask you to read a value off the screen and type it into the lesson panel. Command steps are the ones you type in the terminal.',
      },
    ],
    refs: ['whoami(1)', 'hostname(1)', 'os-release(5)', 'Kali Linux Revealed, ch. 1'],
  };

  /* ------------------------------------------------------------------- kali */
  const kali = {
    id: 'start-kali',
    title: 'What Kali Linux is',
    minutes: 8,
    objectives: [
      'Describe Kali Linux as a Debian-based rolling distribution for security work',
      'Explain why the default user is unprivileged and what the default shell is',
      'Find tools by category and name the metapackages that install them',
      'Say which parts of Kali this course practices and which it only catalogs',
    ],
    intro: T(
      'Kali Linux is a free distribution maintained by OffSec for security testing, forensics and related work. It is not magic and it is not a single program. It is Debian Linux with a large, curated collection of tools and sensible defaults for people who use them for a living.',
      '',
      'Knowing what is under the hood makes you better with it. Most of what you do on Kali is ordinary Linux administration: files, users, processes, networks and packages. The security tools are programs on top of that, and they are only as useful as your understanding of the system they run on.'
    ),
    steps: [
      {
        id: 'debian',
        prompt: T(
          'Kali is built on Debian, one of the oldest Linux distributions. The file you read earlier says so. Print the `ID` lines:',
          '',
          '```',
          'grep ID /etc/os-release',
          '```',
          '',
          '`ID=kali` names this system. `ID_LIKE=debian` says it is derived from Debian, so Debian\'s package tools (`apt`, `dpkg`) and file layout apply. `VERSION_CODENAME=kali-rolling` names the release channel.'
        ),
        hint: 'Use `grep ID /etc/os-release`.',
        solution: 'grep ID /etc/os-release',
        check: { cmd: 'grep', out: /ID_LIKE=debian/ },
      },
      {
        id: 'rolling-q',
        prompt: T(
          '"Rolling" means Kali has no big upgrade from one version to the next. Packages are updated continuously, and the numbered releases such as 2026.3 are snapshots of that stream, built a few times a year.',
          '',
          'Look at the output above once more. What is the codename of the release channel? Type it.'
        ),
        hint: 'Look at the `VERSION_CODENAME` line.',
        solution: 'kali-rolling',
        answer: /^kali-rolling$/i,
      },
      {
        id: 'user',
        prompt: T(
          'Older versions of Kali logged you in as `root`, the all-powerful administrator. Since 2020 the default user is an ordinary one, because a mistake or a bug in a tool running as root can damage the whole system. Check what you are allowed to do:',
          '',
          '```',
          'id',
          '```',
          '',
          '`uid=1000` marks a regular account. Look at the `groups=` list: you are in `sudo`, so you can run single commands as root when a task needs it, such as raw-packet scanning. You will see this in the discovery module.'
        ),
        hint: 'Type `id`.',
        solution: 'id',
        check: { cmd: 'id', out: /uid=1000\(kali\)/ },
      },
      {
        id: 'shell',
        prompt: T(
          'The default shell on Kali is `zsh`, not `bash` as on many other distributions. The environment variable `SHELL` holds the login shell\'s path. Print it:',
          '',
          '```',
          'echo $SHELL',
          '```',
          '',
          'Both shells work almost the same for everything in this course.'
        ),
        hint: 'Type `echo $SHELL`.',
        solution: 'echo $SHELL',
        check: { cmd: 'echo', out: /zsh/ },
      },
      {
        id: 'meta',
        prompt: T(
          'Kali groups its tools into **metapackages**, empty packages that only depend on other packages. Installing one installs the whole set. Ask the package database which exist:',
          '',
          '```',
          'apt-cache search kali-linux',
          '```',
          '',
          'The common ones are `kali-linux-core` (the base system), `kali-linux-headless` (tools without a graphical desktop, good for servers), `kali-linux-default` (what the standard image installs) and `kali-linux-large` (more).'
        ),
        hint: 'Use `apt-cache search kali-linux`.',
        solution: 'apt-cache search kali-linux',
        check: { cmd: 'apt-cache', out: /kali-linux-headless/ },
      },
      {
        id: 'meta-q',
        prompt: 'Which metapackage would you install on a server with no graphical desktop, where you only want the command-line tools? Type its name.',
        hint: 'Read the descriptions in the output you just got.',
        solution: 'kali-linux-headless',
        answer: /^kali-linux-headless$/i,
      },
      {
        id: 'atlas',
        prompt: T(
          'Kali has hundreds of tools, which is too many to memorize. Kalima includes an atlas, a map of the toolbox by category. List the categories:',
          '',
          '```',
          'kalima atlas',
          '```',
          '',
          'The first category, Information Gathering, is the one you will practice in this course. Others, such as password attacks or exploitation tools, are listed here so you know they exist, but this course does not teach their use. The `SIMULATED` column shows which tools you can actually run in this build.'
        ),
        hint: 'Type `kalima atlas`.',
        solution: 'kalima atlas',
        check: { cmd: 'kalima', args: ['atlas'], out: /information-gathering/ },
      },
      {
        id: 'atlas-nmap',
        prompt: T(
          'Look up one tool. Ask the atlas about `nmap`, the network scanner you will use for discovery:',
          '',
          '```',
          'kalima atlas nmap',
          '```',
          '',
          'An entry says what kind of tool it is and which category it belongs to. The real Kali site, `kali.org/tools`, has the same kind of page for every tool, with the package name and its manual.'
        ),
        hint: 'Type `kalima atlas nmap`.',
        solution: 'kalima atlas nmap',
        check: { cmd: 'kalima', args: ['atlas'], out: /nmap/i, argsRe: /nmap/ },
      },
      {
        id: 'practice',
        info: true,
        prompt: T(
          'What this course practices hands-on: operating the workstation (shell, files, users, packages), understanding networks and the protocols tools rely on, discovering what exists on an authorized network, reading logs, and the methodology of a professional engagement.',
          '',
          'What it only catalogs: the tools for attacking systems, such as exploitation frameworks and password crackers. You learn that they exist and what category they belong to. Using them well requires the foundations first, and using them at all requires written permission.'
        ),
      },
    ],
    quiz: [
      {
        q: 'Why does Kali give you an unprivileged user by default instead of `root`?',
        choices: [
          'Root accounts do not exist on Kali',
          'A mistake in a tool run as root can damage the whole system, so you use `sudo` only when needed',
          'Security tools refuse to run as root',
          'It makes the tools faster',
        ],
        answer: 1,
        why: 'The least-privilege habit applies to testers too. Most tools run fine as a normal user, and the few that need root can be run through `sudo`.',
      },
      {
        q: 'What does it mean that Kali is a "rolling" distribution?',
        choices: [
          'It is released once every ten years',
          'Packages are updated continuously, and numbered releases are snapshots',
          'It only runs from a USB stick',
          'It cannot be updated',
        ],
        answer: 1,
        why: 'There is no big version-to-version upgrade. You keep the system current with `apt`, and releases such as 2026.3 are periodic snapshots.',
      },
      {
        q: 'What does installing the metapackage `kali-linux-headless` do?',
        choices: [
          'Installs one program called headless',
          'Removes the graphical desktop',
          'Installs the set of command-line tools it depends on',
          'Updates the kernel only',
        ],
        answer: 2,
        why: 'A metapackage contains no tools of its own. It depends on the packages that make up a group, so installing it pulls them all in.',
      },
    ],
    refs: ['apt-cache(8)', 'id(1)', 'zsh(1)', 'Kali Linux Revealed, ch. 1 and 8', 'https://www.kali.org/docs/'],
  };

  /* ------------------------------------------------------------- engagement */
  const engagement = {
    id: 'start-engagement',
    title: 'Authorization, scope and rules',
    minutes: 10,
    objectives: [
      'Read a scope file and decide whether an address or name is in scope',
      'Name the four phases of an assessment in NIST SP 800-115 and the ones this course covers',
      'Begin a dated entry in the engagement notes',
    ],
    intro: T(
      'The same commands that find weaknesses for a defender can be used to break into a system for a criminal. What separates them is permission. A professional assessment starts with a written agreement that says who may test what, when, and how. Staying inside it is not a formality: testing a system you are not authorized to test can be a crime, and it can take down a service your client depends on.',
      '',
      'In this course the paperwork lives in `~/engagement`. You will read it before you scan anything, and you will keep notes as you work.'
    ),
    steps: [
      {
        id: 'scope',
        prompt: T(
          'The scope file lists what you may test. Read it:',
          '',
          '```',
          'cat ~/engagement/scope.txt',
          '```',
          '',
          'Lines that start with `#` are comments. Below the IN SCOPE comment are the permitted targets: a network range written as `10.10.10.0/24` (every address from `10.10.10.0` to `10.10.10.255`) and a name pattern, `*.halcyon.lab` (any host name ending in `.halcyon.lab`). Everything else is out of scope.'
        ),
        hint: 'Use `cat ~/engagement/scope.txt`.',
        solution: 'cat ~/engagement/scope.txt',
        check: { cmd: 'cat', argsRe: /scope\.txt/, out: /IN SCOPE/ },
      },
      {
        id: 'roe',
        prompt: T(
          'Now the rules of engagement, which say how you must work inside that scope:',
          '',
          '```',
          'cat ~/engagement/rules-of-engagement.txt',
          '```',
          '',
          'Read all six rules. Note rule 3 (use the least intrusive technique that answers the question) and rule 5 (record what you do). The notes you keep in this course serve rule 5.'
        ),
        hint: 'Use `cat ~/engagement/rules-of-engagement.txt`.',
        solution: 'cat ~/engagement/rules-of-engagement.txt',
        check: { cmd: 'cat', argsRe: /rules-of-engagement/, out: /RULES OF ENGAGEMENT/ },
      },
      {
        id: 'q-db01',
        prompt: 'Is the host name `db01.halcyon.lab` in scope? Answer yes or no.',
        hint: 'Compare the name with the pattern `*.halcyon.lab`.',
        solution: 'yes',
        answer: YES,
      },
      {
        id: 'q-1011',
        prompt: 'A colleague mentions a printer at `10.10.11.60` and suggests including it. Is that address in scope? Answer yes or no.',
        hint: 'Compare the third number with `10.10.10.0/24`. A /24 range fixes the first three numbers.',
        solution: 'no',
        answer: NO,
      },
      {
        id: 'q-public',
        prompt: 'The client\'s public website, `halcyonfreight.example`, is on the internet and answers anyone. Is it in scope for active testing? Answer yes or no.',
        hint: 'Check what the OUT OF SCOPE comment says about public systems. Being reachable is not the same as being authorized.',
        solution: 'no',
        answer: NO,
      },
      {
        id: 'phases',
        info: true,
        prompt: T(
          'NIST Special Publication 800-115, the *Technical Guide to Information Security Testing and Assessment*, describes an assessment in four phases:',
          '',
          '- **Planning**: agree the scope and rules, get permission, prepare.',
          '- **Discovery**: find out what exists (hosts, services, names) and analyze it for weaknesses.',
          '- **Attack**: try to confirm that weaknesses can be used.',
          '- **Reporting**: record what was found and recommend fixes. It runs alongside the other phases.',
          '',
          'This course covers planning, discovery and reporting: how to prepare, how to see what is on a network, and how to write it down. It does not teach the attack phase.'
        ),
      },
      {
        id: 'q-phase',
        prompt: 'Finding out which hosts and services exist on an authorized network belongs to which phase? Type its name.',
        hint: 'One of planning, discovery, attack or reporting.',
        solution: 'discovery',
        answer: /^(the\s+)?discovery( phase)?$/i,
      },
      {
        id: 'notes',
        prompt: T(
          'Rule 5 says to keep commands and timestamps. Start a dated entry in your notes file. The `>>` operator appends output to a file without overwriting it, and `$(date +%F)` inserts today\'s date as `year-month-day`:',
          '',
          '```',
          'echo "## $(date +%F) Engagement start" >> ~/engagement/notes.md',
          '```',
          '',
          'The `##` makes it a heading in Markdown, the format of the notes file. Be careful to type `>>`, not `>`: a single `>` would replace the whole file.'
        ),
        hint: 'Use `echo`, put the date in with `$(date +%F)`, and append to `~/engagement/notes.md` with `>>`.',
        solution: 'echo "## $(date +%F) Engagement start" >> ~/engagement/notes.md',
        check: { all: [appendsToNotes, { file: { path: NOTES, contains: /^##\s+.*\d{4}-\d{2}-\d{2}/m } }] },
      },
      {
        id: 'read-notes',
        prompt: T(
          'Check that the entry is there:',
          '',
          '```',
          'tail -5 ~/engagement/notes.md',
          '```',
          '',
          '`tail` prints the last lines of a file. Your heading should be among them. Good notes are the difference between a result you can reproduce and a vague memory.'
        ),
        hint: 'Use `tail -5 ~/engagement/notes.md`, or `cat` to see the whole file.',
        solution: 'tail -5 ~/engagement/notes.md',
        check: { cmd: ['tail', 'cat'], argsRe: /notes\.md/, out: /^##\s+.*\d{4}-\d{2}-\d{2}/m },
      },
    ],
    quiz: [
      {
        q: 'The scope file lists `10.10.10.0/24`. Which of these addresses is outside it?',
        choices: ['10.10.10.0', '10.10.10.200', '10.10.11.1', '10.10.10.255'],
        answer: 2,
        why: 'A /24 fixes the first three numbers, so the range is 10.10.10.0 to 10.10.10.255. `10.10.11.1` differs in the third number.',
      },
      {
        q: 'Which statement about scope is correct?',
        choices: [
          'A system that answers requests from the internet may be tested by anyone',
          'Only the systems named in the signed scope may be actively tested',
          'Scope applies to attacks but not to scans',
          'Scope can be widened by the tester when something interesting turns up',
        ],
        answer: 1,
        why: 'Permission comes from the system owner and is limited to what it names. Scans count as active testing, and only the client can widen the scope.',
      },
      {
        q: 'According to NIST SP 800-115, in which phase do you record findings and recommend fixes?',
        choices: ['Planning', 'Discovery', 'Attack', 'Reporting'],
        answer: 3,
        why: 'Reporting is the fourth phase. In practice you keep notes through all of them so the report can be written from them.',
      },
      {
        q: 'What would `echo "Day 2" > ~/engagement/notes.md` do, compared with `>>`?',
        choices: [
          'The same thing',
          'It would replace the whole notes file with that line',
          'It would add the line at the top',
          'It would fail because the file exists',
        ],
        answer: 1,
        why: 'A single `>` truncates the file first. `>>` appends. Using the wrong one is how notes get lost.',
      },
    ],
    refs: ['NIST SP 800-115, sections 2 and 3', 'bash(1), section REDIRECTION', 'date(1)', 'tail(1)'],
  };

  K.lessons.register({
    id: 'start',
    title: 'Orientation',
    order: 0,
    summary: 'How the simulator works, what Kali Linux is, and the authorization and scope that govern every engagement.',
    lessons: [welcome, kali, engagement],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
