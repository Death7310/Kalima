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
          'So far you named the file to search. With `-r` you name a directory instead, and grep searches every file below it, printing the file name in front of each match. The current directory is written `.`',
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

  K.lessons.register({
    id: 'text',
    title: 'Searching and shaping text',
    order: 25,
    summary: 'Find the lines that matter with grep, build pipelines one stage at a time, and answer questions about logs and tables without opening an editor.',
    lessons: [grepLesson],
  });

  void WORK;
})(typeof globalThis !== 'undefined' ? globalThis : this);
