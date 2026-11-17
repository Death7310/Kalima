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

  K.lessons.register({
    id: 'shell',
    title: 'The shell and the filesystem',
    order: 10,
    summary: 'Read the Kali prompt, run commands, find your way around the filesystem, and work faster with completion, history, aliases, wildcards and quoting.',
    lessons: [firstLesson],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
