/* Kalima — curriculum module "help": finding out how a command works.
 *
 * Lessons: help-man, help-flags. They only read manual pages and command help,
 * so they leave nothing behind and can be taken in any order. In the replay
 * test the pager prints straight through, so every solution is a plain command.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const MAN = ['man'];

  /* ------------------------------------------------------------------- man */
  const manLesson = {
    id: 'help-man',
    title: 'Reading manual pages',
    minutes: 10,
    objectives: [
      'Open the manual page of a command and find its NAME, SYNOPSIS, DESCRIPTION and OPTIONS sections',
      'Move through a page, search it and leave the pager',
      'Explain what the number in a name such as `ls(1)` tells you',
    ],
    intro: T(
      'Nobody remembers every option of every tool, and a Kali system ships hundreds of them. Professionals do not guess: they read the manual that is already on the machine, which works without a network connection and describes the version you actually have.',
      '',
      'In this lesson you open manual pages, learn how a page is laid out, and use the pager to find one option in a long page. You only read, so nothing here changes the system.'
    ),
    steps: [
      {
        id: 'open',
        prompt: T(
          'The manual is read with `man` followed by a name. Open the page for `ls`, the command that lists files:',
          '',
          '```',
          'man ls',
          '```',
          '',
          'The page opens in a pager, a program that shows text one screen at a time. The first line reads `LS(1)`; you will come back to that. Do not leave yet: the next steps use what is on the screen.'
        ),
        hint: 'Type `man` and a space, then the command name `ls`.',
        solution: 'man ls',
        check: { cmd: MAN, args: ['ls'], exit: 0 },
      },
      {
        id: 'sections',
        prompt: T(
          'A manual page has the same headings every time, which is what makes it quick to read once you know them:',
          '',
          '- **NAME**: the command and a one-line summary. `ls - list directory contents`.',
          '- **SYNOPSIS**: the shapes the command line can take. You learn to read these in the next lesson.',
          '- **DESCRIPTION**: what the command does, in prose.',
          '- **OPTIONS**: each flag and what it changes. Often the part you came for.',
          '- Some pages add **EXAMPLES**, which is worth a look when you are unsure how to start.',
          '',
          'Look at the page on your screen. In the pager, press `Space` for the next screen, `b` for the previous one, `g` for the top and `G` for the end.'
        ),
        info: true,
      },
      {
        id: 'which-option',
        prompt: 'Read the OPTIONS section of the `ls` page. Which single-letter option makes `ls` sort by file size, largest first? Type only the letter, with its dash.',
        hint: 'Scan the OPTIONS list for the description that says "sort by file size".',
        solution: '-S',
        answer: /^-?S$/,
      },
      {
        id: 'search',
        prompt: T(
          'Long pages are not meant to be read from top to bottom. Search instead. In the pager, type `/` followed by the text and press Enter. The pager jumps to the first match; press `n` for the next match and `N` for the one before.',
          '',
          'Try it on the open `ls` page: type `/human` and Enter. The cursor lands on the `-h` option, which prints sizes such as `1K` and `234M`.',
          '',
          'When you are finished, press `q` to quit. This works in every manual page and in `less`, which is the pager `man` uses. If you ever find yourself in a screen that will not respond to typing, `q` is the way out.'
        ),
        info: true,
      },
      {
        id: 'sec-name',
        prompt: T(
          'You do not always need the whole page. Because the output of `man` is text, you can pipe it to another tool. Show just the first lines of the `find` page:',
          '',
          '```',
          'man find | head -12',
          '```',
          '',
          'When output is piped, `man` does not open the pager; it prints the page and `head` keeps the first twelve lines. Find the NAME and SYNOPSIS sections in what you see.'
        ),
        hint: 'Pipe `man find` into `head -12`.',
        solution: 'man find | head -12',
        check: { cmd: MAN, args: ['find'], out: /find - search for files in a directory hierarchy/, not: { out: /EXAMPLES/ } },
      },
      {
        id: 'section-number',
        prompt: T(
          'The manual is divided into numbered sections. The number in `ls(1)` is the section the page belongs to. The ones you meet most often:',
          '',
          '- **1**: commands you run as a normal user, such as `ls` and `grep`',
          '- **5**: file formats and configuration files, such as `passwd(5)`',
          '- **8**: system administration commands, such as `useradd(8)`',
          '',
          'The same word can exist in two sections, and then you can choose by putting the number before the name. Ask for the page of `ls` in section 1 explicitly:',
          '',
          '```',
          'man 1 ls',
          '```'
        ),
        hint: 'The section number goes between `man` and the name.',
        solution: 'man 1 ls',
        check: { cmd: MAN, argsRe: /\b1 ls\b/, exit: 0 },
      },
      {
        id: 'man-man',
        prompt: T(
          'The manual describes itself. Its DESCRIPTION lists the sections the system documents. Print the page for `man` and pipe it to `head -20`, then read the sentence that begins "The manual is divided into sections".',
          '',
          'What is the number of the section for **system administration commands**?'
        ),
        hint: 'Run `man man | head -20` and read the list after "divided into sections".',
        solution: '8',
        answer: /^(section\s*)?8$/i,
      },
      {
        id: 'whatis',
        prompt: T(
          'When you only want to know what a command is for, `man -f` prints its one-line summary: the NAME line, without opening the page. Try it with a tool you have not met yet:',
          '',
          '```',
          'man -f tar',
          '```',
          '',
          'The answer has the form `name (section) - summary`. The next lesson shows the related commands `whatis` and `apropos`.'
        ),
        hint: 'Use the `-f` option, then the command name.',
        solution: 'man -f tar',
        check: { cmd: MAN, args: ['-f'], out: /tar \(1\)\s+- an archiving utility/ },
      },
      {
        id: 'missing',
        prompt: T(
          'When there is no page, `man` says so rather than guessing. Ask for a page that does not exist:',
          '',
          '```',
          'man frobnicate',
          '```',
          '',
          'The message is `No manual entry for frobnicate`. A missing page can mean a typo, a package that is not installed, or a shell built-in such as `cd`, which is documented in the shell\'s own manual instead.'
        ),
        hint: 'Run `man frobnicate`. An error here is the expected result.',
        solution: 'man frobnicate',
        check: { cmd: MAN, out: /No manual entry for frobnicate/ },
      },
    ],
    quiz: [
      {
        q: 'You are in the pager showing a long manual page. How do you find the text "recursive" in it?',
        choices: ['Type `/recursive` and press Enter', 'Type `grep recursive`', 'Press `q` and run `man` again', 'Type `find recursive`'],
        answer: 0,
        why: 'In the pager, `/` starts a search. Enter jumps to the first match and `n` moves to the next. `grep` and `find` are shell commands and have no meaning inside the pager.',
      },
      {
        q: 'What does the `5` in `passwd(5)` tell you?',
        choices: [
          'The page describes a file format, not the `passwd` command',
          'The page is the fifth version of the manual',
          'The command takes five arguments',
          'The page is about passwords of five characters',
        ],
        answer: 0,
        why: 'The number is the manual section. Section 5 covers file formats and configuration files, while the command is documented in section 1, as `passwd(1)`.',
      },
      {
        q: 'You run `man ls | head -5`. What do you see, and does a pager open?',
        choices: [
          'The first five lines of the page, and no pager opens',
          'The pager opens at line 5',
          'Only the NAME line',
          'An error, because `man` cannot be piped',
        ],
        answer: 0,
        why: '`man` only starts the pager when its output goes to the terminal. In a pipe it prints plain text, so `head` can cut it like any other output.',
      },
    ],
    refs: ['man(1)', 'less(1)', 'man-pages(7)', 'Kali Linux Revealed, ch. 3'],
  };

  /* ----------------------------------------------------------------- flags */
  const flagsLesson = {
    id: 'help-flags',
    title: 'Quick help, synopses and finding commands',
    minutes: 10,
    objectives: [
      'Get a short summary of a command with `--help` and read a SYNOPSIS line',
      'Find a command by what it does with `apropos` or `man -k`, and summarize one with `whatis`',
      'Use `type` and `which` to see what a command name really runs',
    ],
    intro: T(
      'A manual page is thorough but slow. Often you need a reminder of the right flag, or you know the job you want done and not the name of the tool. Linux has quick answers for both.',
      '',
      'On a security workstation it also matters what a name resolves to. A command name can be a program, a built-in, or an alias someone set up, and you should know which one you are running before you rely on its output.'
    ),
    steps: [
      {
        id: 'help',
        prompt: T(
          'Most commands print a short usage summary when you add `--help`. It is faster than the manual and goes straight to the point:',
          '',
          '```',
          'mkdir --help',
          '```',
          '',
          'The first line begins `Usage:` and shows the form of the command. The lines below list the options, a short flag on the left and often a long form beside it, such as `-p, --parents`.'
        ),
        hint: 'Type the command, a space, then two dashes and the word help.',
        solution: 'mkdir --help',
        check: { cmd: 'mkdir', args: ['--help'], out: /Usage: mkdir/ },
      },
      {
        id: 'optional',
        prompt: T(
          'The `Usage:` line follows a convention you will meet in every manual page. Here is the one for `mkdir`:',
          '',
          '```',
          'mkdir [OPTION]... DIRECTORY...',
          '```',
          '',
          'The symbols mean:',
          '',
          '- `[ ]` square brackets mark something **optional**. `[OPTION]` can be left out.',
          '- `...` after an item means it may be **repeated**. `DIRECTORY...` means one or more directories.',
          '- `|` separates **alternatives**: `a | b` means a or b, not both.',
          '- Words in capitals are placeholders that you replace with your own value.',
          '',
          'Words without brackets are required, so `mkdir` needs at least one DIRECTORY.'
        ),
        info: true,
      },
      {
        id: 'read-synopsis',
        prompt: T(
          'Use that reading on a second command. Run `cp --help | head -4` and look at the first form of the usage:',
          '',
          '```',
          'cp [OPTION]... [-T] SOURCE DEST',
          '```',
          '',
          'Which of the two names, SOURCE or DEST, is it that the command can take more than once in the second form (`SOURCE... DIRECTORY`)? Answer with the word.'
        ),
        hint: 'Look for the placeholder followed by `...` in the second line.',
        solution: 'SOURCE',
        answer: /^source$/i,
      },
      {
        id: 'short-flag',
        prompt: T(
          'Flags come in short and long forms. Short ones are a single letter after one dash and combine: `ls -l -a` is `ls -la`. Long ones use two dashes and a word. Both appear in the help output side by side.',
          '',
          'Run `ls --help | head -12` and find the long form of `-a`. Type the long form with its two dashes.'
        ),
        hint: 'The line for `-a` has the form `-a, --...`.',
        solution: '--all',
        answer: /^--all$/,
      },
      {
        id: 'whatis',
        prompt: T(
          '`whatis` prints the one-line description of a command from its manual page, so it works on tools you have not opened before:',
          '',
          '```',
          'whatis sed',
          '```',
          '',
          'The line has the command, its manual section in brackets, and what it does. You will use `sed` later in the course.'
        ),
        hint: 'Run `whatis` followed by the command name.',
        solution: 'whatis sed',
        check: { cmd: 'whatis', out: /sed \(1\)\s+- stream editor/ },
      },
      {
        id: 'apropos',
        prompt: T(
          'What if you know the job but not the name? `apropos` searches the one-line descriptions of every manual page for a word. `man -k` does the same thing.',
          '',
          '```',
          'apropos copy',
          '```',
          '',
          'The result is a list of commands whose description mentions copying. Read the descriptions: `cp` copies files and directories, `scp` copies over SSH. Searching for a few different words is normal, because the description may use a different term than you did.'
        ),
        hint: 'Use `apropos` followed by a keyword, or `man -k` with the same keyword.',
        solution: 'apropos copy',
        check: { cmd: ['apropos', 'man'], out: /cp \(1\)\s+- copy files and directories/ },
      },
      {
        id: 'find-tool',
        prompt: T(
          'Now use it to find something. Search the descriptions for the word `archive` and find the command that creates ZIP archives. Run the search, then read the output.',
          '',
          'Which command is it? Give the name only.'
        ),
        hint: 'Run `apropos archive` and look for the description that mentions ZIP.',
        solution: 'zip',
        answer: /^zip$/i,
      },
      {
        id: 'type',
        prompt: T(
          'Last, what does a name actually run? `type` tells you how the shell resolves a name:',
          '',
          '```',
          'type ls',
          'type cd',
          'type tar',
          '```',
          '',
          '`ls` is an **alias**, a shortcut the shell expands, here to `ls --color=auto`. `cd` is a **shell builtin**, part of the shell itself and not a file, which is why it has no manual page of its own. `tar` is a **program**, and `type` prints the path of the file that runs.',
          '',
          'Run `type` on all three at once.'
        ),
        hint: '`type` accepts several names in one line: `type ls cd tar`.',
        solution: 'type ls cd tar',
        check: { cmd: 'type', out: /ls is an alias[\s\S]*cd is a shell builtin[\s\S]*tar is \/usr\/bin\/tar/ },
      },
      {
        id: 'which',
        prompt: T(
          '`which` answers a narrower question: where is the program file? It searches the directories in your `PATH`, in order, and prints the first match:',
          '',
          '```',
          'which tar',
          '```',
          '',
          'If two programs with the same name were installed in different directories, the one `which` prints first is the one that runs. Check the real location of `find` this way.'
        ),
        hint: 'Run `which find`.',
        solution: 'which find',
        check: { cmd: 'which', args: ['find'], out: /\/usr\/bin\/find/ },
      },
    ],
    quiz: [
      {
        q: 'A synopsis reads `tool [-v] FILE...`. Which command line is valid?',
        choices: ['`tool a.txt b.txt c.txt`', '`tool -v`', '`tool [-v] a.txt`', '`tool FILE...`'],
        answer: 0,
        why: 'FILE is required and the dots allow it to be repeated, so one or more files work. `-v` is optional. Without a file, `tool -v` is incomplete, and the brackets and dots are notation, not text to type.',
      },
      {
        q: 'You need a tool that compares two files but do not know its name. What is the fastest first step?',
        choices: ['`apropos compare`', '`man compare`', '`which compare`', '`type compare`'],
        answer: 0,
        why: '`apropos` searches descriptions by keyword, so it finds commands by what they do. The other three need the actual command name, which you are trying to discover.',
      },
      {
        q: '`type ll` prints `ll is an alias for ls -l`. What happens when you run `man ll`?',
        choices: [
          'There is no manual entry, because `ll` is a shortcut and not a program',
          'The page for `ls` opens',
          'The page for `ll` opens',
          'The shell expands the alias and runs `man ls -l`',
        ],
        answer: 0,
        why: 'Aliases belong to the shell and have no manual page. `type` is how you discover what an alias stands for, and then you read the page of the real command, `ls`.',
      },
    ],
    refs: ['man(1)', 'apropos(1)', 'whatis(1)', 'which(1)', 'bash(1), section on builtin type'],
  };

  K.lessons.register({
    id: 'help',
    title: 'Getting help',
    order: 15,
    summary: 'Read manual pages and quick help, decode a synopsis and find the command for a job.',
    lessons: [manLesson, flagsLesson],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
