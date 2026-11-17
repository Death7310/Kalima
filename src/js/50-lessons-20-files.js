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

  K.lessons.register({
    id: 'files',
    title: 'Working with files',
    order: 20,
    summary: 'Look inside files, organize them into a tidy working directory, capture the output of commands, and edit text in nano and vim.',
    lessons: [viewLesson],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
