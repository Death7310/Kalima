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

  K.lessons.register({
    id: 'shell',
    title: 'The shell and the filesystem',
    order: 10,
    summary: 'Read the Kali prompt, run commands, find your way around the filesystem, and work faster with completion, history, aliases, wildcards and quoting.',
    lessons: [firstLesson, navigateLesson],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
