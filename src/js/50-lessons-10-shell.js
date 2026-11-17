/* Kalima — curriculum module "shell": the shell and the filesystem.
 *
 * Lessons: shell-first, shell-navigate, shell-efficient. They only read the
 * machine (the practice data under /usr/share/kalima and the standard
 * directories), so they can be repeated or taken in any order. The files that
 * shell-efficient uses for wildcards and quoting are seeded read-only under
 * /usr/share/kalima/shell by the hook at the end of this file.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const DATA = '/usr/share/kalima';

  /* ----------------------------------------------------------- shell-first */
  const firstLesson = {
    id: 'shell-first',
    title: 'The prompt and your first commands',
    minutes: 9,
    objectives: [
      'Read the Kali prompt: user, host, working directory and the `$` or `#` symbol',
      'Take a command apart into its name, its options and its arguments',
      'Run `whoami`, `pwd` and `ls`, and read what they print',
    ],
    intro: T(
      'Most work on a Kali workstation is done by typing commands into a shell. A command line shows exactly what was run and exactly what came back, and that record is what lets you repeat a piece of security work, explain it and put it in a report.',
      '',
      'In this lesson you read the prompt, run three small commands and learn the shape that nearly every command shares. The terminal is a simulated Kali Linux 2026.3 machine. Nothing you type can harm a real system, so type each command yourself instead of pasting it: your hands learn faster than your eyes.'
    ),
    steps: [
      {
        id: 'prompt',
        info: true,
        prompt: T(
          'Look at the terminal. Before you type anything, the shell prints a **prompt**:',
          '',
          '```',
          '┌──(kali㉿kali)-[~]',
          '└─$',
          '```',
          '',
          'It answers three questions:',
          '',
          '- **Who am I, and on which machine?** `kali㉿kali` is *user* then *host*: you are the user `kali` on the machine named `kali`.',
          '- **Where am I?** The square brackets hold the directory you are working in. `~` is shorthand for your home directory.',
          '- **How much power do I have?** `$` marks an ordinary user. For `root`, the administrator, the symbol is `#`.',
          '',
          'Whatever you type appears after the `$`. Glance at the prompt before you press Enter: it is the quickest way to avoid running the right command in the wrong place.'
        ),
      },
      {
        id: 'whoami',
        prompt: T(
          'Type this command and press Enter:',
          '',
          '```',
          'whoami',
          '```',
          '',
          '`whoami` prints the name of the user the shell is running as. Compare the answer with the first name in the prompt: they agree.'
        ),
        hint: 'Type `whoami` in lowercase, with no spaces, and press Enter.',
        solution: 'whoami',
        check: { cmd: 'whoami', exit: 0 },
      },
      {
        id: 'pwd',
        prompt: T(
          'Now ask where you are:',
          '',
          '```',
          'pwd',
          '```',
          '',
          '`pwd` stands for *print working directory*. A shell is always "in" exactly one directory, and commands act there unless you tell them otherwise.',
          '',
          'The answer is a **path**: the route from the top of the filesystem, written `/`, down to a directory, with a `/` between each step.'
        ),
        hint: 'Three lowercase letters: `pwd`.',
        solution: 'pwd',
        check: { cmd: 'pwd', exit: 0 },
      },
      {
        id: 'home',
        prompt: 'The prompt shows `~` because you are in your home directory. Going by what `pwd` printed, what full path does `~` stand for?',
        hint: 'Read the line that `pwd` printed. If the brackets in your prompt show something other than `~`, type `cd` and press Enter to go home, then run `pwd` again.',
        solution: '/home/kali',
        answer: ['/home/kali', '/home/kali/'],
      },
      {
        id: 'ls',
        prompt: T(
          'List what is in the working directory:',
          '',
          '```',
          'ls',
          '```',
          '',
          '`ls` prints the names of the files and directories here, in columns. Kali colors the names by type, and directories are blue. One of them is `engagement`, which holds the paperwork for this lab; later lessons use it.'
        ),
        hint: 'Two lowercase letters, L and S: `ls`.',
        solution: 'ls',
        check: { cmd: 'ls', exit: 0 },
      },
      {
        id: 'anatomy',
        prompt: T(
          'Most commands are built from three kinds of part, separated by spaces:',
          '',
          '```',
          'ls -l ' + DATA + '/logs',
          '```',
          '',
          '- `ls` is the **command name**: the program to run.',
          '- `-l` is an **option**: it changes how the program behaves. This one asks for the *long* format.',
          '- `' + DATA + '/logs` is an **argument**: what to act on. Here it is a directory other than the one you are in.',
          '',
          'Run it. Each line now describes one file. From left to right: type and permissions, number of links, owner, group, size in bytes, when it was last changed, and the name.'
        ),
        hint: 'Type it exactly, with one space after `ls` and one after `-l`. The option is a lowercase letter L, not the digit 1.',
        solution: 'ls -l ' + DATA + '/logs',
        check: { cmd: 'ls', args: ['-l'], out: /access\.log/ },
      },
      {
        id: 'owner',
        prompt: 'Read the listing. The third column names the user who owns each file. Which user owns `access.log` and `auth.log`?',
        hint: 'Each line begins with something like `-rw-r--r-- 1`. The two words after that are the owner and the group.',
        solution: 'root',
        answer: ['root', 'the root user', 'user root'],
      },
      {
        id: 'own-listing',
        prompt: T(
          'Now build a command yourself. The practice data has another directory, `' + DATA + '/text`.',
          '',
          'Show a long listing of it.'
        ),
        hint: 'The command name and the option stay the same as in the last command. Only the argument changes.',
        solution: 'ls -l ' + DATA + '/text',
        check: { cmd: 'ls', args: ['-l'], out: /shift-log\.txt/ },
      },
      {
        id: 'larger',
        prompt: 'The fifth column is the size in bytes. Which file is larger: `fleet.txt` or `shift-log.txt`?',
        hint: 'Compare the number just before the date on each line.',
        solution: 'shift-log.txt',
        answer: /^(the\s+)?shift-?\s?log(\.txt)?\.?$/i,
      },
      {
        id: 'not-found',
        prompt: T(
          'Commands do not always work, and when they fail the message is the useful part. Linux treats uppercase and lowercase letters as different. Type `whoami` with a capital W:',
          '',
          '```',
          'Whoami',
          '```',
          '',
          'Read the reply from the start. The shell could not find a command with that exact name, and Kali suggests the one you probably meant. Whenever you see `not found`, check spelling and capitals before anything else.'
        ),
        hint: 'Type `Whoami` with an uppercase W and press Enter. This step wants the error.',
        solution: 'Whoami',
        check: { exit: 127, out: /not found/i },
      },
    ],
    quiz: [
      {
        q: 'The last line of a prompt ends in `#` instead of `$`. What does that tell you?',
        choices: [
          'The shell is running as root, the administrator',
          'The line is a comment and will not be run',
          'The previous command failed',
          'You are logged in to a remote machine',
        ],
        answer: 0,
        why: '`#` marks a root shell, where permissions no longer hold a command back. `$` marks an ordinary user. Check which one you have before you run anything that changes the system.',
      },
      {
        q: 'In `ls -l /var/log`, what is `/var/log`?',
        choices: [
          'An option that changes how `ls` behaves',
          'An argument: the thing `ls` should act on',
          'The directory the shell is working in',
          'The name of the program to run',
        ],
        answer: 1,
        why: 'Options normally begin with a dash and change behavior. Arguments say what to act on. This command lists `/var/log` no matter which directory you are in.',
      },
      {
        q: 'You move to the directory `/var/log` and the shell prints a new prompt. What do the square brackets show?',
        choices: ['`~`', '`~/var/log`', '`/var/log`', '`log`'],
        answer: 2,
        why: '`~` replaces only the path of your home directory. Anywhere else the prompt shows the path itself, the same one `pwd` prints.',
      },
      {
        q: 'You type `LS` in capitals and press Enter. What is the most likely result?',
        choices: [
          'The same listing that `ls` prints',
          'A listing with the names in capitals',
          'A listing that includes hidden files',
          'An error, because no command has that exact name',
        ],
        answer: 3,
        why: 'Command names are case-sensitive and the program is called `ls`. The shell reports that it found nothing named `LS`.',
      },
    ],
    refs: ['whoami(1)', 'pwd(1)', 'ls(1)', 'Kali Linux Revealed, ch. 3 (Linux Fundamentals)'],
  };

  /* -------------------------------------------------------- shell-navigate */
  const navigateLesson = {
    id: 'shell-navigate',
    title: 'Moving around the filesystem',
    minutes: 11,
    objectives: [
      'Change directory with absolute and relative paths, and with `~`, `..` and `cd -`',
      'Show hidden files with `ls -a` and read a long listing of them',
      'Say what `/etc`, `/var/log`, `/home`, `/usr/bin`, `/tmp` and `/root` are for',
    ],
    intro: T(
      'Every file on a Linux system hangs from a single tree that starts at `/`. Tools, configuration, logs and your own notes each have a customary place in it, and the layout is nearly the same on the servers you will examine as on your own workstation.',
      '',
      'If you can move through that tree without thinking, you can find a service\'s configuration or its log on a machine you have never seen before. In this lesson you travel the tree with `cd`, uncover hidden files, and take a short tour of the directories that matter most. You only look; nothing is changed.'
    ),
    steps: [
      {
        id: 'absolute',
        prompt: T(
          '`cd` changes the working directory. Give it a path that starts with `/` and it goes there from anywhere:',
          '',
          '```',
          'cd ' + DATA,
          '```',
          '',
          'A path that starts at `/` is an **absolute path**. It means the same thing wherever you are.',
          '',
          '`cd` prints nothing when it works. Look at the prompt instead: the brackets now show the new directory.'
        ),
        hint: 'Type `cd`, a space, then the path beginning with `/`.',
        solution: 'cd ' + DATA,
        check: { cwd: DATA },
      },
      {
        id: 'relative',
        prompt: T(
          'A path that does not start with `/` is a **relative path**. It is followed from the directory you are in.',
          '',
          'You are in `' + DATA + '`, which contains a directory called `logs`. Go into it:',
          '',
          '```',
          'cd logs',
          '```',
          '',
          'The prompt now reads `' + DATA + '/logs`. The same command typed in another directory would fail, because there would be no `logs` there to enter.'
        ),
        hint: 'Just the name, with no `/` in front: `cd logs`. If it says `no such file or directory`, run `cd ' + DATA + '` first.',
        solution: 'cd logs',
        check: { cwd: DATA + '/logs' },
      },
      {
        id: 'parent',
        prompt: T(
          'Every directory contains two special names: `.` is the directory itself and `..` is its parent, one level up.',
          '',
          'Go back up to `' + DATA + '` using the parent name.'
        ),
        hint: 'Give `cd` the two-dot name as its argument.',
        solution: 'cd ..',
        check: { cwd: DATA, line: /\.\./ },
      },
      {
        id: 'tilde',
        prompt: T(
          'The shell replaces `~` with the path of your home directory, so `~` gives you a short path that works from anywhere.',
          '',
          'Your home contains the directory `engagement`. Go to it with one command, using `~`.'
        ),
        hint: 'A path can start with `~` the way an absolute path starts with `/`: `~/` followed by the name of the directory.',
        solution: 'cd ~/engagement',
        check: { cwd: '/home/kali/engagement' },
      },
      {
        id: 'back',
        prompt: T(
          'You often need to hop between two directories, for example a log directory and your notes. A dash means "the directory I was in before":',
          '',
          '```',
          'cd -',
          '```',
          '',
          'This time `cd` does print something: the directory it took you back to. Run it again later and it returns you here. Plain `cd`, with no argument at all, always takes you home.'
        ),
        hint: 'Type `cd`, a space and a single dash.',
        solution: 'cd -',
        check: { cmd: 'cd', args: ['-'], exit: 0 },
      },
      {
        id: 'hidden',
        prompt: T(
          'Names that begin with a dot are hidden from a plain `ls`. Most of them are settings that programs keep in your home directory. The option `-a` (*all*) shows them:',
          '',
          '```',
          'ls -a ~',
          '```',
          '',
          'Because you gave `~` as the argument, this lists your home directory without your leaving the directory you are in. Look for `.zshrc`, the settings of your shell, and for `.` and `..` at the start of the list.'
        ),
        hint: 'The option is `-a` and the argument is `~`.',
        solution: 'ls -a ~',
        check: { cmd: 'ls', out: /\.zshrc/ },
      },
      {
        id: 'long-hidden',
        prompt: T(
          'Options can be combined after a single dash: `-la` means `-l` and `-a` together.',
          '',
          'List your home directory again, hidden files included, this time in the long format.'
        ),
        hint: 'Add the letter `l` to the option you used in the last command.',
        solution: 'ls -la ~',
        check: { cmd: 'ls', args: ['-l'], out: /\.zshrc/ },
      },
      {
        id: 'private',
        prompt: T(
          'Read the first column of that listing. A line that starts with `d` is a directory, and `drwx------` marks a directory that only its owner may open.',
          '',
          'Apart from `.` (your home directory itself), which hidden directory is marked `drwx------`?'
        ),
        hint: 'Look down the first column for the pattern `drwx------`, then read the name at the end of that line. It begins with a dot.',
        solution: '.ssh',
        answer: ['.ssh', '.ssh/', '~/.ssh', '~/.ssh/', 'ssh', '/home/kali/.ssh'],
      },
      {
        id: 'root-dir',
        prompt: T(
          'Now look at the top of the tree:',
          '',
          '```',
          'ls /',
          '```',
          '',
          'These directories are found on nearly every Linux system. The ones you will visit most often:',
          '',
          '- `/etc` holds system-wide configuration, almost all of it plain text.',
          '- `/var/log` holds the logs that the system and its services write.',
          '- `/home` holds one directory for each ordinary user. Yours is `/home/kali`.',
          '- `/usr/bin` holds the programs you run as commands. `ls` itself is the file `/usr/bin/ls`.',
          '- `/tmp` is scratch space that any user may write to. It is emptied when the machine restarts, so keep nothing there that you need.',
          '- `/root` is the home directory of the administrator, `root`.'
        ),
        hint: 'The argument is a single slash: `ls /`.',
        solution: 'ls /',
        check: { cmd: 'ls', all: [{ out: /\betc\b/ }, { out: /\bvar\b/ }, { out: /\broot\b/ }, { out: /\busr\b/ }] },
      },
      {
        id: 'closed',
        prompt: T(
          'Not every directory is open to you. Try to enter the administrator\'s home:',
          '',
          '```',
          'cd /root',
          '```',
          '',
          'The shell refuses with `permission denied`, and the prompt shows that you have not moved. This is ordinary and useful: the system is protecting one user\'s files from another. On a server you assess, what an account can and cannot open is one of the first things worth noting.'
        ),
        hint: 'Type the command exactly. This step wants the refusal.',
        solution: 'cd /root',
        check: { line: /\/root/, out: /permission denied/i },
      },
    ],
    quiz: [
      {
        q: 'You are in `' + DATA + '/logs`. Where does `cd ../text` take you?',
        choices: ['`/text`', '`' + DATA + '/logs/text`', '`/usr/share/text`', '`' + DATA + '/text`'],
        answer: 3,
        why: '`..` climbs one level, to `' + DATA + '`, and `text` is then followed from there. A relative path is always read from the directory you are in.',
      },
      {
        q: 'You are in `/var/log` and type `cd engagement`. What happens?',
        choices: [
          'You arrive in `/home/kali/engagement`, because `cd` searches your home directory',
          'The shell reports that there is no such directory, because `/var/log` contains no `engagement`',
          'You arrive in `/engagement`',
          'The shell creates `/var/log/engagement` and enters it',
        ],
        answer: 1,
        why: '`engagement` is a relative path, so the shell looks for it inside `/var/log`. From there you would type `cd ~/engagement`.',
      },
      {
        q: 'You need to read how the SSH service on a machine is configured. Which directory do you look in first?',
        choices: ['`/etc`', '`/var/log`', '`/usr/bin`', '`/tmp`'],
        answer: 0,
        why: 'System-wide configuration lives under `/etc`. `/var/log` would tell you what the service did, and `/usr/bin` holds programs, not their settings.',
      },
      {
        q: 'A plain `ls` in a directory prints nothing, yet `ls -a` prints `.`, `..` and `.config`. Why?',
        choices: [
          'The directory is closed to you unless you use `-a`',
          '`.config` was created between the two commands',
          'Names that begin with a dot are hidden unless you ask for all entries',
          '`-a` also lists the contents of the parent directory',
        ],
        answer: 2,
        why: 'A leading dot hides a name from a plain listing. It is a convention for keeping settings out of the way, not a security measure: `-a` shows them to anyone who may read the directory.',
      },
    ],
    refs: ['zshbuiltins(1), for `cd`', 'ls(1)', 'hier(7)', 'Filesystem Hierarchy Standard 3.0', 'Kali Linux Revealed, ch. 3 (The File System)'],
  };

  /* ------------------------------------------------------- shell-efficient */
  const SAMPLES = DATA + '/shell';

  /** Does the shell that ran this line now have an alias `lh` that is a long, human-readable ls? */
  const hasLhAlias = (ev) => {
    const aliases = ev.shell && ev.shell.aliases;
    const value = aliases && aliases.get ? aliases.get('lh') : null;
    if (!value || !/^\s*ls(\s|$)/.test(value)) return false;
    const long = /\s-[a-zA-Z]*l/.test(value);
    const human = /\s-[a-zA-Z]*h/.test(value) || /--human-readable/.test(value);
    return long && human;
  };

  const efficientLesson = {
    id: 'shell-efficient',
    title: 'Typing less: completion, history, wildcards and quotes',
    minutes: 12,
    objectives: [
      'Complete commands and paths with Tab, and reuse earlier commands with the history and `!!`',
      'Find out what a name really runs with `type`, and define an alias of your own',
      'Select groups of files with the wildcards `*`, `?` and `[ ]`',
      'Quote names that contain spaces, and choose between single and double quotes',
    ],
    intro: T(
      'Long paths and long commands invite typing mistakes, and in security work a mistyped path or address can aim a command at the wrong thing. The shell has features that let you type less and be right more often: it finishes names for you, remembers what you ran, lets you give short names to the commands you use most, and turns patterns into lists of files.',
      '',
      'This lesson practices each of them on a few sample files from an imaginary engagement, stored in `' + SAMPLES + '`. They are read-only, so you can experiment freely.'
    ),
    steps: [
      {
        id: 'tab',
        prompt: T(
          'The Tab key asks the shell to finish a name for you. Go to the sample files, letting Tab do most of the typing:',
          '',
          '- Type `cd /usr/sh` and press Tab. Only one name in `/usr` starts with `sh`, so the shell completes it: `/usr/share/`.',
          '- Type `ka` and press Tab. The line grows to `/usr/share/kalima/`.',
          '- Type `sh` and press Tab, which adds `shell/`. Now press Enter.',
          '',
          'You typed about half of the path, and none of it can be misspelled, because Tab only writes names that exist.',
          '',
          'When Tab adds nothing, either no name matches what you typed, or several do. If several match, the shell lists them under the prompt. Type one more letter and press Tab again, or keep pressing Tab to step through the list.'
        ),
        hint: 'The goal is to arrive in `' + SAMPLES + '`. Typing the whole path by hand also works, but try the Tab key.',
        solution: 'cd ' + SAMPLES,
        check: { cwd: SAMPLES },
      },
      {
        id: 'history',
        prompt: T(
          'The shell remembers what you type. Press the **Up** arrow and your last command returns to the prompt, ready to run again or to edit. Press **Down** to go forward again, back to an empty line.',
          '',
          'As you type, Kali may also show the rest of an earlier command in gray. The Right arrow accepts that suggestion.',
          '',
          'To see the whole record, run:',
          '',
          '```',
          'history',
          '```',
          '',
          'Each line is a number and a command, oldest first. The record is kept in the file `~/.zsh_history`, so it is still there after you close the terminal. That makes it a useful reminder of what you did during an engagement. It is also the reason never to type a password as part of a command line.'
        ),
        hint: 'One word: `history`.',
        solution: 'history',
        check: { cmd: 'history', exit: 0 },
      },
      {
        id: 'denied',
        prompt: T(
          'History is most useful just after something goes wrong. Ask for a listing of the administrator\'s home directory, hidden files included:',
          '',
          '```',
          'ls -a /root',
          '```',
          '',
          'It fails with `Permission denied`, because `/root` is closed to ordinary users. Nothing was wrong with the command itself. It needed more privilege than you have.'
        ),
        hint: 'Type it exactly. This step wants the error message.',
        solution: 'ls -a /root',
        check: { cmd: 'ls', argsRe: /\/root/, out: /Permission denied/ },
      },
      {
        id: 'bang',
        prompt: T(
          '`sudo` runs a single command as root, and `!!` stands for the whole of your previous command line. Together they repeat a command with the privilege it was missing:',
          '',
          '```',
          'sudo !!',
          '```',
          '',
          'The shell first prints the line it built, `sudo ls -a /root`, so you can see exactly what ran. Then `sudo` asks for your password. Type `kali` and press Enter. Nothing appears while you type a password; that is normal.',
          '',
          'On an installed Kali system zsh is more careful still: it puts the expanded line back on the prompt and waits for a second Enter, so that you can check it before it runs.'
        ),
        hint: 'Type `sudo`, a space and two exclamation marks. The password is `kali`. If you ran another command since `ls -a /root`, run that one again first.',
        input: ['kali'],
        solution: 'sudo !!',
        // the replay types `true` before each step, so it has to restore the previous command itself
        testSolution: ['ls -a /root', 'sudo !!'],
        check: { cmd: 'ls', user: 'root', argsRe: /\/root/, exit: 0 },
      },
      {
        id: 'type',
        prompt: T(
          'The name you type is not always the name of the program that runs. The shell first looks through its **aliases**: short names that it replaces with longer commands. `type` reports what a name really stands for:',
          '',
          '```',
          'type ls',
          '```',
          '',
          'The answer, `ls is an alias for ls --color=auto`, explains why your listings are colored: on Kali, typing `ls` runs `ls --color=auto`.',
          '',
          'Try `type cd` and `type nano` afterwards to see the two other kinds of answer: a command built into the shell, and a program stored on disk. `alias` on its own lists every alias that is defined.'
        ),
        hint: 'Type `type`, a space and the name you are asking about, `ls`.',
        solution: 'type ls',
        check: { cmd: ['type', 'which', 'whence'], argsRe: /(^| )ls( |$)/ },
      },
      {
        id: 'alias',
        prompt: T(
          'You can define aliases of your own. `ls -lh` is a long listing with sizes in readable units such as `K` and `M` (the `h` is for *human-readable*). Give it a short name:',
          '',
          '```',
          'alias lh=\'ls -lh\'',
          '```',
          '',
          'There are no spaces around the `=`, and the quotes keep the two words together as one value. Then try your new command on the practice logs: `lh ' + DATA + '/logs`.',
          '',
          'An alias made this way lasts until you close this shell. Kali\'s own aliases come back every time because they are written in `~/.zshrc`, which the shell reads when it starts.'
        ),
        hint: 'The shape is `alias name=\'command\'`. The name must be `lh` and the command `ls -lh`.',
        solution: 'alias lh=\'ls -lh\'',
        check: { cmd: 'alias', fn: hasLhAlias },
      },
      {
        id: 'star',
        prompt: T(
          'A **wildcard** is a pattern that the shell replaces with the file names that match it, before the command runs. `*` matches any run of characters, including none. You are still in `' + SAMPLES + '`:',
          '',
          '```',
          'ls *.md',
          '```',
          '',
          'The shell found two names ending in `.md` and ran `ls report-draft.md report-final.md`. `ls` never saw the star.',
          '',
          'That is why wildcards work with every command. It is also why a pattern deserves a second look before you give it to a command that deletes or overwrites files. Handing the pattern to `ls` or `echo` first shows what it matches and changes nothing.'
        ),
        hint: 'The prompt should show `' + SAMPLES + '`. The pattern is a star followed by `.md`.',
        solution: 'ls *.md',
        check: { cmd: 'ls', line: /\*/, out: /report-draft\.md/, not: { out: /scan-|meeting/ } },
      },
      {
        id: 'pattern',
        prompt: T(
          'Two more wildcards are more exact:',
          '',
          '- `?` matches exactly one character. `scan-d?01.txt` matches `scan-db01.txt` but not `scan-dev01.txt`.',
          '- `[ ]` matches one character out of those listed between the brackets. `[dw]` means a `d` or a `w`.',
          '',
          'Run `ls` to see the four scan files. Then, with a single pattern, list the scans of the hosts whose names begin with `d` or `w`. That is three files; `scan-files01.txt` must not be among them.'
        ),
        hint: 'All four names start with `scan-`. Follow that with brackets holding the two letters you want, then a `*` for the rest of the name.',
        solution: 'ls scan-[dw]*',
        check: {
          cmd: 'ls', line: /[*?[]/,
          all: [{ out: /scan-db01\.txt/ }, { out: /scan-dev01\.txt/ }, { out: /scan-web01\.txt/ }],
          not: { out: /scan-files01|report-|meeting/ },
        },
      },
      {
        id: 'spaces',
        prompt: T(
          'One file here has a space in its name, and `ls` prints it inside quotes as a warning: `\'meeting notes.txt\'`. The shell splits a command line at spaces, so `cat meeting notes.txt` would ask `cat` for two files, `meeting` and `notes.txt`. Neither exists.',
          '',
          'Quotes switch the splitting off. Read the file:',
          '',
          '```',
          'cat "meeting notes.txt"',
          '```',
          '',
          'Tab completion handles this for you as well. Type `cat mee` and press Tab: the shell writes the name with a backslash in front of the space, which protects that one character in the same way.'
        ),
        hint: 'Put the whole file name, space included, between a pair of double quotes.',
        solution: 'cat "meeting notes.txt"',
        check: { cmd: 'cat', exit: 0, out: /Kickoff call/ },
      },
      {
        id: 'quotes',
        prompt: T(
          'Single and double quotes differ in one important way. Inside **double** quotes the shell still replaces `$NAME` with the value of the variable called `NAME`. Inside **single** quotes every character stays exactly as you typed it.',
          '',
          '`USER` is a variable that holds your user name. Run both of these and compare the results:',
          '',
          '```',
          'echo "I am $USER"',
          'echo \'I am $USER\'',
          '```',
          '',
          'The first prints `I am kali`. The second prints the text untouched. When a string must reach a command exactly as written, a search pattern full of symbols for example, put it in single quotes.'
        ),
        hint: 'Run the two lines one after the other. The step completes on the one with single quotes.',
        solution: 'echo \'I am $USER\'',
        check: { cmd: 'echo', out: /I am \$USER/ },
      },
    ],
    quiz: [
      {
        q: 'You type `cat ' + DATA + '/logs/a` and press Tab. Two files there start with `a`: `access.log` and `auth.log`. What does the shell do?',
        choices: [
          'It completes `access.log`, the first in alphabetical order',
          'It reports an error because the name is ambiguous',
          'It shows both names and leaves the line for you to continue',
          'It runs `cat` on both files',
        ],
        answer: 2,
        why: 'Tab completes only as far as the candidates agree. When they differ at the next character the shell lists them, and you choose by typing one more letter or by pressing Tab again to step through them.',
      },
      {
        q: 'Your last command was `nano /etc/hosts`, and it could not save because the file belongs to root. What does `sudo !!` run?',
        choices: ['`sudo nano /etc/hosts`', '`sudo nano`', '`sudo` followed by every command in the history', '`sudo /etc/hosts`'],
        answer: 0,
        why: '`!!` is replaced by the whole previous command line, so the same command runs again with `sudo` in front of it.',
      },
      {
        q: 'A directory holds `a.txt`, `b.txt` and `notes.md`. You run `rm *.txt`. What does the `rm` program receive as its arguments?',
        choices: [
          'The single argument `*.txt`, which `rm` then matches against the directory',
          'The two arguments `a.txt` and `b.txt`',
          'All three file names',
          'Nothing, because `rm` does not accept patterns',
        ],
        answer: 1,
        why: 'The shell expands the pattern before the command starts, so `rm` is handed the matching names and never sees the star. This is why it pays to preview a pattern with `ls` before using it with `rm`.',
      },
      {
        q: 'What does `echo \'Home: $HOME\'` print?',
        choices: ['`Home: /home/kali`', '`Home:` and nothing more', '`Home: $HOME`', 'An error, because `$HOME` is not allowed inside quotes'],
        answer: 2,
        why: 'Single quotes keep every character literal, so the dollar sign is not treated as the start of a variable. With double quotes the shell would have substituted `/home/kali`.',
      },
    ],
    refs: ['zshexpn(1), for history expansion and wildcards', 'zshbuiltins(1), for `alias`, `type` and `history`', 'glob(7)', 'sudo(8)', 'Kali Linux Revealed, ch. 3 (The Command Line)'],
  };

  K.lessons.register({
    id: 'shell',
    title: 'The shell and the filesystem',
    order: 10,
    summary: 'Read the Kali prompt, run commands, find your way around the filesystem, and work faster with completion, history, aliases, wildcards and quoting.',
    lessons: [firstLesson, navigateLesson, efficientLesson],
  });

  /* ------------------------------------------------------------- practice files
   * Sample files for shell-efficient: names chosen so that *, ? and [ ] each
   * select a different subset, plus one name with a space in it.
   */
  K.fsSeeds.push((machine) => {
    if (machine.profile !== 'kali') return;
    const mtime = Date.UTC(2026, 10, 9, 16, 40, 0);
    const put = (name, lines) => machine.vfs.seed(SAMPLES + '/' + name, lines.join('\n') + '\n', { mtime });
    const scan = (host, ip) => put('scan-' + host + '.txt', [
      'Host:   ' + host + '.halcyon.lab (' + ip + ')',
      'Saved:  2026-11-09',
      '',
      'Placeholder. During the engagement the port scan of this host is saved here.',
    ]);
    put('report-draft.md', [
      '# Halcyon Freight lab assessment (draft)',
      '',
      'Engagement: HF-LAB-2026-11',
      'Status: draft, not for release',
      '',
      '## Summary',
      '',
      'To be written when testing is complete.',
    ]);
    put('report-final.md', [
      '# Halcyon Freight lab assessment',
      '',
      'Engagement: HF-LAB-2026-11',
      'Status: outline only',
      '',
      '## Summary',
      '',
      '## Findings',
      '',
      '## Recommendations',
    ]);
    scan('db01', '10.10.10.30');
    scan('dev01', '10.10.10.70');
    scan('files01', '10.10.10.20');
    scan('web01', '10.10.10.10');
    put('meeting notes.txt', [
      'Kickoff call with Halcyon Freight, 9 November 2026',
      '',
      '- Testing window: any time (this is a lab)',
      '- Contact: IT Operations, it-ops@halcyon.lab',
      '- In scope: 10.10.10.0/24 and *.halcyon.lab',
      '- Out of scope: the public website, halcyonfreight.example',
      '- Notes and evidence stay inside ~/engagement',
    ]);
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
