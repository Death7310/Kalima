/* Kalima — curriculum module "text": searching and shaping text.
 *
 * Lessons: text-grep, text-pipeline, text-csv. They read the practice data the
 * content pack seeds under /usr/share/kalima and write only under
 * ~/practice/text. Checks test what a line printed or left on disk, so any
 * correct spelling of a command passes.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const GREP = ['grep', 'egrep', 'fgrep'];
  const WORK = '/home/kali/practice/text';
  /** What a line printed, as trimmed non-empty lines. */
  const linesOf = (ev) => K.util.stripAnsi(ev.output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

  /* ------------------------------------------------------------------ grep */
  const grepLesson = {
    id: 'text-grep',
    title: 'Finding lines with grep',
    minutes: 10,
    objectives: [
      'Print the lines of a file that match a pattern, with or without regard to case',
      'Count matches with `-c`, locate them with `-n` and hide noise with `-v`',
      'Match one of several words with `-E`, and tie a pattern to the start or end of a line',
      'Search every file under a directory with `-r`',
    ],
    intro: T(
      'Most of what a system tells you about itself is text: logs, configuration files, the output of tools. A security workstation collects a great deal of it, and the answer you need is usually a handful of lines in a file of thousands.',
      '',
      '`grep` prints the lines that match a pattern and leaves out the rest. In this lesson you search a depot shift log and two days of SSH login records. Both are invented and stored read-only under `/usr/share/kalima`. grep only reads, so nothing you do here can change them.'
    ),
    steps: [
      {
        id: 'plain',
        prompt: T(
          'Move to the practice data so that file names stay short, then run your first search. The simplest form of grep is a pattern followed by the file to search:',
          '',
          '```',
          'cd /usr/share/kalima',
          'grep ERROR text/shift-log.txt',
          '```',
          '',
          'grep reads the file line by line and prints every line that contains the text `ERROR`. The other 31 lines stay hidden. Look at the result: four lines, each with a time, a level and a message, and the matching text picked out in color.',
          '',
          'The rest of this lesson uses paths relative to `/usr/share/kalima`. If a command answers `No such file or directory`, you are in another directory: run the `cd` again.'
        ),
        hint: 'Run the two commands in order. In the second, the pattern comes first and the file second.',
        solution: 'cd /usr/share/kalima; grep ERROR text/shift-log.txt',
        check: { cmd: GREP, out: /06:48\s+ERROR/, not: { out: /08:30\s+error|Gate opened/ } },
      },
      {
        id: 'nocase',
        prompt: T(
          'People typed this log, and not all of them wrote the level in capitals. grep is case-sensitive unless you say otherwise. Add `-i` to ignore case:',
          '',
          '```',
          'grep -i error text/shift-log.txt',
          '```',
          '',
          'Compare this with the previous output. Two more lines appear, at 08:30 and 18:30, where the level was written `error` and `Error`. When you search logs for evidence, a case-sensitive search can miss lines like these without any warning.'
        ),
        hint: 'Put `-i` between `grep` and the pattern. With `-i` the pattern can be in either case.',
        solution: 'grep -i error text/shift-log.txt',
        check: { cmd: GREP, out: /08:30\s+error/, all: [{ out: /18:30\s+Error/ }, { out: /06:48\s+ERROR/ }], not: { out: /Gate opened/ } },
      },
      {
        id: 'number',
        prompt: T(
          'To point a colleague at a line, or to cite it in your notes, you need to say where it is. `-n` puts the line number in front of each match. Options combine, so keep `-i`:',
          '',
          '```',
          'grep -n -i error text/shift-log.txt',
          '```',
          '',
          'Every line now starts with a number and a colon. `6:06:48  ERROR ...` means the match is on line 6 of the file. The time that follows has a colon of its own, so read the line number up to the first colon only.'
        ),
        hint: 'Add `-n` to the previous command. `-n -i`, `-i -n` and `-in` all mean the same.',
        solution: 'grep -n -i error text/shift-log.txt',
        check: { cmd: GREP, out: /^13:08:30\s+error/m, all: [{ out: /^6:06:48\s+ERROR/m }] },
      },
      {
        id: 'which-line',
        prompt: 'Read the output you just produced. On which line of the file is the entry about the forklift that failed its check?',
        hint: 'Find the line that mentions `forklift` and read the number before the first colon.',
        solution: '13',
        answer: /^(line\s*)?13\.?$/i,
      },
      {
        id: 'count',
        prompt: T(
          'Sometimes the question is *how many*, not *which*. `-c` prints the number of matching lines instead of the lines. Switch to the SSH login records and count the failed password attempts. The pattern contains a space, so it needs quotes:',
          '',
          '```',
          'grep -c "Failed password" logs/auth.log',
          '```',
          '',
          'One number comes back: 118 lines out of 450. Without the quotes the shell would hand grep two separate words, and grep would search for `Failed` in a file named `password`.'
        ),
        hint: 'Use `-c` and keep the two-word pattern inside quotes.',
        solution: 'grep -c "Failed password" logs/auth.log',
        check: { cmd: GREP, out: /(^|:)\s*118\s*$/m, exit: 0 },
      },
      {
        id: 'invert',
        prompt: T(
          '`-v` inverts the match: it prints the lines that do *not* contain the pattern. That makes it the quick way to remove noise. Most of the shift log is routine `INFO` lines. Hide them:',
          '',
          '```',
          'grep -v INFO text/shift-log.txt',
          '```',
          '',
          'What remains is the two heading lines, the warnings and the errors. One `info` line in lower case is still there at 07:06, because this search is case-sensitive too.'
        ),
        hint: 'Same shape as the first search, with `-v` added and `INFO` as the pattern.',
        solution: 'grep -v INFO text/shift-log.txt',
        check: { cmd: GREP, out: /WARN\s+Bay 3 door sensor/, all: [{ out: /Depot shift log/ }], not: { out: /INFO\s+Gate opened/ } },
      },
      {
        id: 'either',
        prompt: T(
          'A pattern can offer alternatives. With `-E` (extended regular expressions) the character `|` means *or*. Quote the pattern: outside quotes the shell would take `|` for itself, to connect two commands, which is the subject of the next lesson.',
          '',
          '```',
          'grep -E \'WARN|ERROR\' text/shift-log.txt',
          '```',
          '',
          'You get every line that contains either word, nine in all, in the order they were written. Warnings and errors appear interleaved, as they happened during the day.'
        ),
        hint: 'Use `-E` and put both words, separated by `|`, inside single quotes.',
        solution: 'grep -E \'WARN|ERROR\' text/shift-log.txt',
        check: { cmd: GREP, out: /WARN\s+Bay 3 door sensor/, all: [{ out: /ERROR\s+Weighbridge/ }], not: { out: /Depot shift log|Gate opened/ } },
      },
      {
        id: 'start',
        prompt: T(
          'Two characters tie a pattern to a position: `^` stands for the start of a line and `$` for the end. Suppose you want everything logged between 07:00 and 07:59. Searching for `07` alone would also find the scanner `SC-07` in the 06:15 entry. Anchor the pattern to the start of the line:',
          '',
          '```',
          'grep \'^07\' text/shift-log.txt',
          '```',
          '',
          'Four lines, and every one has a time that begins with `07`. The 06:15 entry is gone, because its `07` is not at the start of the line.'
        ),
        hint: 'Put `^` in front of `07`, inside single quotes.',
        solution: 'grep \'^07\' text/shift-log.txt',
        check: { cmd: GREP, out: /07:41\s+WARN/, all: [{ out: /07:05\s+INFO/ }], not: { out: /SC-07 docked|Gate opened/ } },
      },
      {
        id: 'end',
        prompt: T(
          'Now use the other anchor yourself, together with the counting option. In `logs/auth.log` the word `root` appears on 120 lines. On how many lines is it the *last* thing on the line?',
          '',
          'Build one grep command that prints that count.'
        ),
        hint: 'A pattern followed by `$` matches only at the end of a line, and `-c` counts. Quote the pattern: `\'root$\'`.',
        solution: 'grep -c \'root$\' logs/auth.log',
        check: { cmd: GREP, out: /(^|:)\s*48\s*$/m, exit: 0 },
      },
      {
        id: 'recursive',
        prompt: T(
          'So far you named the file to search. With `-r` you name a directory instead, and grep searches every file below it, printing the file name in front of each match. A single dot, `.`, stands for the current directory.',
          '',
          'At 08:55 the shift log mentions consignment `HF-2026-10431`. Search everything under `/usr/share/kalima` for that reference.',
          '',
          'Besides the shift log, which file mentions it? Give the file name.'
        ),
        hint: 'From `/usr/share/kalima`, run `grep -r HF-2026-10431 .` and read the part of each line before the first colon.',
        solution: 'shipments.csv',
        answer: /^(\.?\/?|\/usr\/share\/kalima\/)?(data\/)?shipments\.csv$/i,
      },
    ],
    quiz: [
      {
        q: 'The shift log has the level `ERROR` on four lines, `error` on one and `Error` on one. What does `grep -c error text/shift-log.txt` print?',
        choices: ['6', '4', '1', '0'],
        answer: 2,
        why: 'grep is case-sensitive by default, so only the line with `error` in lower case matches. Adding `-i` would count all six.',
      },
      {
        q: 'What does `grep -v sshd logs/auth.log` print?',
        choices: [
          'Only the lines that mention `sshd`',
          'Every line that does not mention `sshd`',
          'The number of lines that mention `sshd`',
          'Nothing, because `-v` only works together with `-c`',
        ],
        answer: 1,
        why: '`-v` inverts the match and prints the lines without the pattern. Here that leaves what other programs logged, which is a quick way to see past the dominant source in a log.',
      },
      {
        q: 'Every line of `logs/auth.log` begins with a date such as `Nov 12`. Which command prints only the lines written on November 12?',
        choices: [
          '`grep \'Nov 12$\' logs/auth.log`',
          '`grep \'^Nov 12\' logs/auth.log`',
          '`grep -v \'Nov 12\' logs/auth.log`',
          '`grep -c \'Nov 12\' logs/auth.log`',
        ],
        answer: 1,
        why: '`^` ties the pattern to the start of the line, where the date is. `$` would look for it at the end, `-v` would print the other days, and `-c` would print a count instead of the lines.',
      },
      {
        q: 'A colleague types `grep Failed password logs/auth.log` without quotes. What happens?',
        choices: [
          'The same as with quotes: grep looks for the two words together',
          'grep prints lines that contain either word',
          'grep looks for `Failed` in two files, `password` and `logs/auth.log`, and complains that `password` does not exist',
          'The shell reports a syntax error and grep never runs',
        ],
        answer: 2,
        why: 'The shell splits unquoted text at spaces. grep takes the first word as the pattern and everything after it as file names, so quotes are needed to keep a pattern with spaces in one piece.',
      },
    ],
    refs: ['grep(1)', 'regex(7)', 'Kali Linux Revealed, ch. 3'],
  };

  /* -------------------------------------------------------------- pipeline */
  const pipelineLesson = {
    id: 'text-pipeline',
    title: 'Building a pipeline',
    minutes: 12,
    objectives: [
      'Join commands with `|` and build a pipeline one stage at a time, reading the output after each stage',
      'Take one field from every line with `cut`, and count repeated values with `sort` and `uniq -c`',
      'Rank counts with `sort -n -r`, keep the top of a list with `head`, and reduce a list to a number with `wc -l`',
      'Combine grep with these stages to answer a question about a log',
    ],
    intro: T(
      'No single command can tell you which address sent the most requests to a web server. A pipeline can: a row of small commands joined by `|`, each one reading what the one before it printed. Analysts read logs this way every day.',
      '',
      'The method matters more than any one command. Add a stage, look at what comes out, then add the next. You will practice it on one day of requests to a fictional web shop: 476 lines in the *combined* format that nginx and Apache write.'
    ),
    steps: [
      {
        id: 'look',
        prompt: T(
          'Start by looking at the raw material. Move to the directory that holds the log and print its first three lines:',
          '',
          '```',
          'cd /usr/share/kalima/logs',
          'head -n 3 access.log',
          '```',
          '',
          'Each line records one request. Read one from left to right: the client address, two dashes for fields that are empty here, the time in square brackets, the request in quotes, the status code the server answered with, the size of the answer in bytes, the referring page, and the name of the client software.',
          '',
          'Split a line at its spaces and count from 1. The address is field 1, the requested path is field 7 and the status code is field 9. The time contains a space, so it takes up fields 4 and 5.',
          '',
          'The commands in this lesson assume you stay in this directory. If one answers `No such file or directory`, run the `cd` again.'
        ),
        hint: 'Run the two commands in order. `head -n 3` prints the first three lines of a file.',
        solution: 'cd /usr/share/kalima/logs; head -n 3 access.log',
        check: { out: /12\/Nov\/2026:00:00:02 \+0000\] "GET \/status/, not: { out: /12\/Nov\/2026:23:45:02/ } },
      },
      {
        id: 'cut',
        prompt: T(
          'The question for this lesson is: **which client made the most requests?** You will build the answer in stages. First, keep only the client address from every line. `cut` selects fields: `-d \' \'` says that fields are separated by a space, and `-f 1` asks for the first field.',
          '',
          '```',
          'cut -d \' \' -f 1 access.log',
          '```',
          '',
          '476 addresses scroll past, one for each request. That is too much to read, and it is meant to be: the next stages will boil it down. For now, check that each line is an address and nothing else.'
        ),
        hint: 'There is a space between the two quotes after `-d`. The file name comes last.',
        solution: 'cut -d \' \' -f 1 access.log',
        check: { fn: (ev) => { const l = linesOf(ev); return l.length > 0 && l[0] === '192.0.2.44' && l.every((x) => IPV4.test(x)); } },
      },
      {
        id: 'sort',
        prompt: T(
          'The character `|`, called a *pipe*, connects two commands: what the first one prints becomes the input of the second instead of going to the screen. Press the Up arrow to bring back your last command, then add a second stage that sorts the addresses:',
          '',
          '```',
          'cut -d \' \' -f 1 access.log | sort',
          '```',
          '',
          'There are still 476 lines, but identical addresses now sit next to each other. Scroll back and you will see long runs of the same address. The next stage depends on that.'
        ),
        hint: 'Add ` | sort` to the end of the previous command. `sort` needs no file name here, because its input comes from the pipe.',
        solution: 'cut -d \' \' -f 1 access.log | sort',
        check: { cmd: 'sort', fn: (ev) => { const l = linesOf(ev); return l.length === 476 && l[0] === '192.0.2.10' && l[475] === '203.0.113.99'; } },
      },
      {
        id: 'count',
        prompt: T(
          '`uniq` merges identical lines that follow one another into a single line. With `-c` it also writes, in front of each, how many lines it merged. Add it as a third stage:',
          '',
          '```',
          'cut -d \' \' -f 1 access.log | sort | uniq -c',
          '```',
          '',
          'The 476 lines have become eight, each a count followed by an address: the log holds requests from eight clients. This only works because of the `sort` stage. `uniq` compares each line with the one before it and nothing else, so equal lines that are apart would be counted separately.'
        ),
        hint: 'Add ` | uniq -c` after `sort`.',
        solution: 'cut -d \' \' -f 1 access.log | sort | uniq -c',
        check: { fn: (ev) => { const l = linesOf(ev); return l.length === 8 && l.indexOf('110 203.0.113.99') >= 0 && l.indexOf('40 192.0.2.10') >= 0; } },
      },
      {
        id: 'rank',
        prompt: T(
          'The counts are there, but the list is in address order. Sort it again, this time by the number at the start of each line. `-n` compares numbers by their value instead of character by character, and `-r` reverses the order so that the largest comes first.',
          '',
          '```',
          'cut -d \' \' -f 1 access.log | sort | uniq -c | sort -n -r',
          '```',
          '',
          'Read the top line: the busiest client and the number of requests it made. Notice that `sort` appears twice in this pipeline, doing two different jobs.'
        ),
        hint: 'Add ` | sort -n -r` to the end. `-nr` and `-rn` mean the same.',
        solution: 'cut -d \' \' -f 1 access.log | sort | uniq -c | sort -n -r',
        check: { cmd: 'sort', fn: (ev) => { const l = linesOf(ev); return l.length === 8 && l[0] === '110 203.0.113.99' && l[7] === '5 203.0.113.7'; } },
      },
      {
        id: 'top',
        prompt: T(
          'In a real log this list could run to thousands of addresses, and you would only want the start of it. Add one more stage so that only the three busiest clients are printed.',
          '',
          'You already used the command you need, in the first step of this lesson.'
        ),
        hint: '`head -n 3` reads from a pipe just as it reads from a file.',
        solution: 'cut -d \' \' -f 1 access.log | sort | uniq -c | sort -n -r | head -n 3',
        check: { fn: (ev) => { const l = linesOf(ev); return l.length === 3 && ['110 203.0.113.99', '96 192.0.2.44', '86 198.51.100.23'].every((x) => l.indexOf(x) >= 0); } },
      },
      {
        id: 'status',
        prompt: T(
          'Now a second question, with a pipeline of your own: **how many requests were answered with status 404 (not found)?**',
          '',
          'The status code is field 9. Count how often each status code appears, the same way you counted the addresses, and read the answer from the output.',
          '',
          'How many requests returned 404?'
        ),
        hint: 'Take the pipeline that ended in `uniq -c` and change the field number: `cut -d \' \' -f 9 access.log | sort | uniq -c`. Each output line is a count followed by a status code.',
        solution: '108',
        answer: /^108(\s+(requests?|lines?))?\.?$/i,
      },
      {
        id: 'methods',
        prompt: T(
          'Fields do not always come out clean. Field 6 is the request method, but the request is quoted in the log, so the method arrives with a quotation mark stuck to it: `"GET`. `tr` changes or deletes single characters in whatever passes through it, and `tr -d` deletes. Put it between `cut` and `sort` to strip the quotation marks:',
          '',
          '```',
          'cut -d \' \' -f 6 access.log | tr -d \'"\' | sort | uniq -c',
          '```',
          '',
          'Three methods, with `GET` far ahead of the others. Unlike the other commands here, `tr` never takes a file name. It only reads what is piped or redirected into it.'
        ),
        hint: 'The argument of `tr -d` is one double quotation mark inside single quotes.',
        solution: 'cut -d \' \' -f 6 access.log | tr -d \'"\' | sort | uniq -c',
        check: { out: /^\s*447 GET\s*$/m, all: [{ out: /^\s*24 POST\s*$/m }] },
      },
      {
        id: 'distinct',
        prompt: T(
          '`wc -l` counts lines, which makes it the usual last stage when the answer you want is a single number. To count how many *different* clients appear in the log, use `uniq` without `-c`, so that each address is printed once, and then count the lines:',
          '',
          '```',
          'cut -d \' \' -f 1 access.log | sort | uniq | wc -l',
          '```',
          '',
          'The result agrees with the number of lines in the table of counts you made earlier. Checking one result against another like this is a cheap way to catch a mistake in a pipeline.'
        ),
        hint: 'Four stages: `cut`, `sort`, `uniq`, `wc -l`.',
        solution: 'cut -d \' \' -f 1 access.log | sort | uniq | wc -l',
        check: { cmd: 'wc', out: /^\s*8\s*$/m, exit: 0 },
      },
      {
        id: 'who',
        prompt: T(
          'Combine all this with grep. The 404 answers deserve a closer look: **which clients received them, and how many each?**',
          '',
          'Start the pipeline with a grep that keeps only the lines with status 404. Give it the pattern `\' 404 \'`: the number with a space on each side, held together by the quotes, so that it cannot match inside a longer number. Then count those lines for each client address, as you did before.',
          '',
          'When it works, read the result with care. The number of lines in it tells you as much as the counts do.'
        ),
        hint: 'The first stage is `grep \' 404 \' access.log`. Follow it with the `cut`, `sort` and `uniq -c` stages you used for the addresses.',
        solution: 'grep \' 404 \' access.log | cut -d \' \' -f 1 | sort | uniq -c',
        check: { out: /^\s*108 203\.0\.113\.99\b/m, exit: 0 },
      },
    ],
    quiz: [
      {
        q: 'What would `cut -d \' \' -f 1 access.log | uniq -c` print, with the `sort` stage left out?',
        choices: [
          'The same eight lines, in a different order',
          'Many more than eight lines, because `uniq` only merges identical lines that follow one another',
          'An error message, because `uniq` refuses input that is not sorted',
          'Eight lines, each with a count of 1',
        ],
        answer: 1,
        why: '`uniq` compares each line only with the line before it. In the unsorted log the same address returns many times with other addresses in between, and every run is counted on its own line.',
      },
      {
        q: 'A file holds the numbers 5, 24 and 110, one per line. In what order does plain `sort`, without `-n`, print them?',
        choices: ['110, 24, 5', '5, 24, 110', '24, 5, 110', 'In the order they are in the file'],
        answer: 0,
        why: 'Without `-n`, sort compares text one character at a time, and `1` comes before `2`, which comes before `5`. `-n` makes it compare the values of the numbers.',
      },
      {
        q: 'All 108 answers with status 404 went to one address, within 45 seconds, for paths such as `/admin`, `/backup` and `/config`. What is the most reasonable reading?',
        choices: [
          'The site is broken and every visitor is getting errors',
          'Files were stolen from the server',
          'One client asked for a list of likely paths to find out which exist',
          'The log file is damaged',
        ],
        answer: 2,
        why: 'A 404 says only that a path does not exist. Many of them from one client in a short time, for names that no page links to, is the trace of an automated search for hidden content. It shows probing, not success.',
      },
      {
        q: 'Why build a pipeline one stage at a time, looking at the output after each stage?',
        choices: [
          'Because the shell cannot start more than two commands at once',
          'Because `sort` is unable to read from a file',
          'Because long pipelines lose lines',
          'Because a mistake in an early stage, such as the wrong field number, is easy to see before counting and sorting hide it',
        ],
        answer: 3,
        why: 'Each stage sees only what the previous one printed. If the first stage selects the wrong field, the later stages will still produce a tidy table, and it will be wrong. Checking as you go keeps every stage honest.',
      },
    ],
    refs: ['cut(1)', 'sort(1)', 'uniq(1)', 'tr(1)', 'wc(1)', 'head(1)', 'The Linux Command Line (W. Shotts), ch. 6 and ch. 20'],
  };

  /* ------------------------------------------------------------------- csv */
  const DATA = '/usr/share/kalima/data';
  const REVISED = DATA + '/shipments-revised.csv';

  /* A second export of the consignment table, made "a week later", for the diff
   * steps. It is derived from the content pack's shipments.csv so that the two
   * files differ only in the four edits below: two status changes, one row
   * removed and one row added. */
  K.fsSeeds.push((machine) => {
    if (machine.profile !== 'kali') return;
    const vfs = machine.vfs;
    let base; let mtime;
    try { base = vfs.read(DATA + '/shipments.csv'); mtime = vfs.stat(DATA + '/shipments.csv').mtime; } catch (e) { return; }
    const delivered = { 'HF-2026-10433': 1, 'HF-2026-10474': 1 };
    const rows = [];
    for (const row of base.split('\n')) {
      if (!row) continue;
      const f = row.split(',');
      if (f[0] === 'HF-2026-10460') continue;
      if (delivered[f[0]]) f[7] = 'delivered';
      rows.push(f.join(','));
    }
    rows.push('HF-2026-10481,2026-10-31,Hull,Lincoln,1890,5,economy,in_transit,Albion Tool Hire');
    vfs.seed(REVISED, rows.join('\n') + '\n', { mode: 0o644, uid: 0, gid: 0, mtime: mtime + 8 * 86400000 });
  });

  const csvLesson = {
    id: 'text-csv',
    title: 'Questioning a CSV file',
    minutes: 10,
    objectives: [
      'Select columns of a comma-separated file with `cut` and rows with `grep`',
      'Count rows by category and sort a table numerically on one column',
      'Compare two versions of a file with `diff` and read what changed',
    ],
    intro: T(
      'Inventories, exported records and the results of many tools arrive as CSV: a table in plain text, one row per line, with commas between the columns. You do not need a spreadsheet to question one. `cut` selects columns, `grep` selects rows, `sort` orders them and `diff` shows what changed between two versions.',
      '',
      'The table in this lesson lists sixty consignments shipped by Halcyon Freight, the fictional client of your lab engagement. You will work on a copy in your own practice directory, which is the right habit for any file you have been handed as a record.'
    ),
    steps: [
      {
        id: 'setup',
        prompt: T(
          'Make a working copy in your practice directory. The original stays untouched under `/usr/share/kalima`.',
          '',
          '```',
          'mkdir -p ~/practice/text',
          'cd ~/practice/text',
          'cp /usr/share/kalima/data/shipments.csv .',
          '```',
          '',
          '`mkdir -p` creates the directory if it is missing and does nothing if it is already there. The `.` at the end tells `cp` to copy into the current directory.',
          '',
          'The rest of this lesson assumes you stay in `~/practice/text`.'
        ),
        hint: 'Run the three commands in order. The step completes when you are in `~/practice/text` and the copy is there.',
        solution: 'mkdir -p ~/practice/text && cd ~/practice/text && cp /usr/share/kalima/data/shipments.csv .',
        check: { cwd: WORK, file: { path: WORK + '/shipments.csv', type: 'file', contains: /^id,date,origin,/ } },
      },
      {
        id: 'header',
        prompt: T(
          'The first line of a CSV file is usually a header that names the columns. Print the first three lines:',
          '',
          '```',
          'head -n 3 shipments.csv',
          '```',
          '',
          'Line 1 is the header, and lines 2 and 3 are consignments. To work on a column you need its position, counted from 1: `id` is field 1, `date` is field 2, and so on.',
          '',
          'Which field number is `status`?'
        ),
        hint: 'Count the names in the header line from the left, starting at 1.',
        solution: '8',
        answer: /^(field\s*|column\s*)?(8|eight)\.?$/i,
      },
      {
        id: 'columns',
        prompt: T(
          '`cut` selects columns. `-d ,` sets the separator to a comma, and `-f` lists the fields you want, here the id and the status:',
          '',
          '```',
          'cut -d , -f 1,8 shipments.csv',
          '```',
          '',
          'Every row is still there, 61 lines with the header, but each is reduced to two columns. A table this narrow is far easier to scan by eye.'
        ),
        hint: 'After `-f`, give the two field numbers separated by a comma, without spaces.',
        solution: 'cut -d , -f 1,8 shipments.csv',
        check: { fn: (ev) => { const l = linesOf(ev); return l.indexOf('HF-2026-10421,delivered') >= 0 && l.indexOf('HF-2026-10433,in_transit') >= 0 && l.every((x) => x.split(',').length === 2); } },
      },
      {
        id: 'rows',
        prompt: T(
          '`grep` selects rows. To see only the consignments that came back, search for the status with a comma on each side:',
          '',
          '```',
          'grep ,returned, shipments.csv',
          '```',
          '',
          'Five rows. The commas tie the word to a whole field, so the search cannot match the same letters inside some other column. The header is gone as well, because it does not contain the pattern.'
        ),
        hint: 'The pattern is `,returned,` and the file comes after it.',
        solution: 'grep ,returned, shipments.csv',
        check: { cmd: GREP, fn: (ev) => { const l = linesOf(ev); return l.length === 5 && l.every((x) => /^HF-2026-\d+,.*,returned,/.test(x)); } },
      },
      {
        id: 'both',
        prompt: T(
          'Now combine the two. Three consignments have the status `delayed`. Print only their ids and their destinations.',
          '',
          'Select the rows first, then pipe them into `cut` to keep the two columns you need. The header you printed earlier tells you which field holds the destination.'
        ),
        hint: '`grep ,delayed, shipments.csv` selects the rows. Add `| cut -d , -f` and the field numbers of `id` and `destination`.',
        solution: 'grep ,delayed, shipments.csv | cut -d , -f 1,4',
        check: { fn: (ev) => linesOf(ev).sort().join('|') === 'HF-2026-10453,Newcastle|HF-2026-10474,Blackpool|HF-2026-10477,Sheffield' },
      },
      {
        id: 'services',
        prompt: T(
          'Counting by category takes three stages: cut the column out, `sort` it so that equal values sit together, and let `uniq -c` count each group.',
          '',
          'How many consignments used each service level? The service is field 7. Build the pipeline.',
          '',
          'When it works, look for the line `1 service`. That is the header row, counted like any other line. Keep it in mind whenever you count the rows of a CSV file.'
        ),
        hint: 'Three stages joined by `|`: `cut -d , -f 7 shipments.csv`, then `sort`, then `uniq -c`.',
        solution: 'cut -d , -f 7 shipments.csv | sort | uniq -c',
        check: { out: /^\s*30 next-day\s*$/m, all: [{ out: /^\s*16 economy\s*$/m }, { out: /^\s*14 timed\s*$/m }] },
      },
      {
        id: 'weight',
        prompt: T(
          'To order the table by one column, `sort` needs three things: `-t ,` names the separator, `-k 5,5` says that the sort key starts and ends at field 5, the weight in kilograms, and `-n` compares the keys as numbers.',
          '',
          '```',
          'sort -t , -k 5,5 -n shipments.csv',
          '```',
          '',
          'The lightest consignment comes first and the heaviest last. Scroll to the top of the output: the header is the very first line, because its field 5 is the text `weight_kg`, and text counts as zero in a numeric sort.'
        ),
        hint: 'Type it as shown. `-k 5,5` is one argument: the field to start at, a comma, the field to stop at.',
        solution: 'sort -t , -k 5,5 -n shipments.csv',
        check: { cmd: 'sort', fn: (ev) => { const l = linesOf(ev); return l.length === 61 && /^id,date,/.test(l[0]) && /^HF-2026-10440,/.test(l[1]) && /^HF-2026-10466,/.test(l[60]); } },
      },
      {
        id: 'heaviest',
        prompt: T(
          'Turn the order around and keep only the start of the list: add `-r` to the sort, and pipe the result into `head` so that three lines are printed.',
          '',
          'What is the id of the heaviest consignment?'
        ),
        hint: '`sort -t , -k 5,5 -n -r shipments.csv | head -n 3` puts the heaviest first. The id is the first column of the first line.',
        solution: 'HF-2026-10466',
        answer: /^(HF-2026-)?10466$/i,
      },
      {
        id: 'diff',
        prompt: T(
          'A week later the depot exported the table again. Did anything change? `diff` compares two files line by line and prints only the differences:',
          '',
          '```',
          'diff shipments.csv /usr/share/kalima/data/shipments-revised.csv',
          '```',
          '',
          'Lines marked `<` come from the first file and lines marked `>` from the second. Each group starts with a short code: `14c14` means that line 14 was *changed*, `41d40` that line 41 of the first file was *deleted*, and `61a61` that a line was *added* after line 61. The 58 lines that are the same in both files are not shown at all.'
        ),
        hint: 'Give `diff` the older file first and the newer file second.',
        solution: 'diff shipments.csv /usr/share/kalima/data/shipments-revised.csv',
        check: { cmd: 'diff', out: /^41d40$/m, all: [{ out: /^> HF-2026-10481,/m }, { out: /^< HF-2026-10433,.*,in_transit,/m }] },
      },
      {
        id: 'removed',
        prompt: T(
          'Read the output of `diff` once more. Two consignments changed status and one was added.',
          '',
          'One consignment is in the original table but missing from the revised one. What is its id?'
        ),
        hint: 'Find the group whose code contains the letter `d`. The line below it starts with `<`, because it exists only in the first file.',
        solution: 'HF-2026-10460',
        answer: /^(HF-2026-)?10460$/i,
      },
    ],
    quiz: [
      {
        q: '`grep -c , shipments.csv` prints 61, yet the table lists 60 consignments. Why?',
        choices: [
          'The header line contains commas too, so it is counted',
          '`grep -c` counts commas, not lines',
          'The last line of the file is counted twice',
          'One consignment was entered twice',
        ],
        answer: 0,
        why: '`-c` counts matching lines, and the header matches as well. Whenever you count the rows of a CSV file, decide whether the header should be part of the number.',
      },
      {
        q: 'What changes if you leave `-n` out of `sort -t , -k 5,5 -n shipments.csv`?',
        choices: [
          'Nothing: sort recognizes numbers on its own',
          'The weights are compared as text, so `1028` is placed before `244`',
          'sort stops with an error because the key is not text',
          'The rows are ordered by the first column instead',
        ],
        answer: 1,
        why: 'Without `-n`, sort compares the key one character at a time, and `1` comes before `2`. The result looks sorted at a glance but is not in order of weight.',
      },
      {
        q: 'You run `diff old.csv new.csv` and it prints nothing. What does that tell you?',
        choices: [
          'diff could not read one of the files',
          'The two files have the same lines in a different order',
          'The two files are identical',
          'One of the files is empty',
        ],
        answer: 2,
        why: 'diff prints only differences, so no output means there are none. An unreadable file would produce an error message, and lines in another order would be reported as changes.',
      },
      {
        q: '`cut -d ,` splits a line at every comma. For which kind of CSV file does that give the wrong columns?',
        choices: [
          'A file with more than nine columns',
          'A file with a header line',
          'A file in which a value itself contains a comma, such as a quoted company name',
          'A file in which values contain spaces',
        ],
        answer: 2,
        why: 'cut knows nothing about the quoting rules of CSV, so a comma inside a quoted value shifts every column after it. For simple tables like this one cut is fine. For anything else, use a tool that understands CSV.',
      },
    ],
    refs: ['cut(1)', 'sort(1)', 'uniq(1)', 'diff(1)', 'RFC 4180'],
  };

  K.lessons.register({
    id: 'text',
    title: 'Searching and shaping text',
    order: 25,
    summary: 'Find the lines that matter with grep, build pipelines one stage at a time, and answer questions about logs and tables without opening an editor.',
    lessons: [grepLesson, pipelineLesson, csvLesson],
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
