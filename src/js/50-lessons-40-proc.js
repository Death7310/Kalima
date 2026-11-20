/* Kalima — curriculum module "proc": processes, services and logs.
 *
 * Lessons: proc-ps, proc-jobs, proc-services, proc-logs. They work on the
 * live process table, the systemd units and the journal of the Kali machine,
 * so there are no practice files to seed. Checks test what a line printed or
 * the state it left behind (a unit running or stopped, a record in the log).
 *
 * Background jobs live in real time. The replay test runs on a virtual clock,
 * where `sleep 300 &` is over before the next line is typed, so the steps of
 * proc-jobs that act on a running job carry a one-line `testSolution` that
 * starts the job and acts on it in the same line.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  /** What a line printed, without colour codes. */
  const outOf = (ev) => K.util.stripAnsi(ev.output || '');
  /** PID of the first process on the Kali machine whose command line matches, or null. */
  const pidOf = (re) => { const p = K.kali.procs.find((x) => re.test(x.cmd)); return p ? p.pid : null; };

  /* -------------------------------------------------------------------- ps */
  const psLesson = {
    id: 'proc-ps',
    title: 'What is running: ps, pgrep and top',
    minutes: 12,
    objectives: [
      'List your own processes with `ps` and every process on the machine with `ps aux`',
      'Read the columns `USER`, `PID`, `%CPU`, `%MEM`, `STAT` and `COMMAND`',
      'Follow parents and children with `--forest`, and find a process by name with `pgrep`',
      'Take a one-shot summary of the machine with `top -b -n 1`',
    ],
    intro: T(
      'Everything a Linux system does is done by a *process*: a running program with a number, an owner, and a parent that started it. When a machine is slow, when a tool seems stuck, or when you want to know what a system is really doing, the process list is where you look.',
      '',
      'For security work it is also evidence. What runs on a host, under which account, and what started it are among the first facts you collect when you review a system. The same commands tell you what your own workstation is doing while you test.'
    ),
    steps: [
      {
        id: 'ps',
        prompt: T(
          'Start with the processes that belong to your own terminal:',
          '',
          '```',
          'ps',
          '```',
          '',
          'Two lines appear under the header. `zsh` is the shell you are typing into. `ps` is the command itself: it was running at the moment the list was made, so it appears in its own output.',
          '',
          '`PID` is the process ID, the number the system uses to identify a process. `TTY` is the terminal the process is attached to, `TIME` is the processor time it has used so far, and `CMD` is the name of the program.'
        ),
        hint: 'Type `ps` with no options and press Enter.',
        solution: 'ps',
        check: { cmd: 'ps', out: /PID\s+TTY\s+TIME\s+CMD[\s\S]*\bzsh\b/, not: { out: /kthreadd|systemd/ } },
      },
      {
        id: 'aux',
        prompt: T(
          'That was two processes out of about a hundred. To see every process on the machine, add three letters. They are old-style options and are written without a dash:',
          '',
          '```',
          'ps aux',
          '```',
          '',
          '- `a` lists the processes of all users',
          '- `u` chooses the user-oriented layout, with an owner and resource columns',
          '- `x` includes processes that are not attached to a terminal, which is most of the system',
          '',
          'The list scrolls past. Six of its columns matter most:',
          '',
          '- `USER`: the account the process runs as',
          '- `PID`: its process ID',
          '- `%CPU` and `%MEM`: its share of processor time and of physical memory',
          '- `STAT`: its state, which the next step explains',
          '- `COMMAND`: the command line that started it',
          '',
          'Names in square brackets, such as `[kthreadd]`, are threads of the kernel itself and not programs from the disk. On a terminal, `ps` cuts each line off at the right edge of the window.'
        ),
        hint: 'Type `ps aux`: the three letters together, with no dash in front.',
        solution: 'ps aux',
        check: { any: [
          { cmd: 'ps', out: /^USER\s+PID\s+%CPU\s+%MEM\b.*\bSTAT\b/m, all: [{ out: /^root\s+1\s/m }] },
          // read through a pager, whose screen is not part of what the line printed
          { cmd: 'ps', argsRe: /^-?[aux]{3}\b/, line: /\|\s*(less|more)\b/ },
        ] },
      },
      {
        id: 'stat',
        prompt: T(
          '`STAT` holds the state of a process as a short code. The first letter is the state:',
          '',
          '- `R`: running, or ready to run as soon as a processor is free',
          '- `S`: sleeping, which means waiting for something such as input or a timer',
          '- `I`: an idle kernel thread',
          '- `T`: stopped',
          '- `Z`: a zombie, a process that has ended but has not yet been cleared away by its parent',
          '',
          'Further characters add detail. For example, `s` marks a session leader such as your shell, and `+` marks a process in the foreground of its terminal.',
          '',
          'Nearly everything in the list is asleep, and that is normal: a process needs the processor only when it has something to do.',
          '',
          'Look at the last line of the list. It is the `ps aux` that you ran. What is in its `STAT` column?'
        ),
        hint: 'It is the one process that was certainly at work at that moment. Type the characters exactly as they appear in the `STAT` column of the last line.',
        solution: 'R+',
        answer: /^R\+?$/i,
      },
      {
        id: 'sort',
        prompt: T(
          'On a slow machine the question is usually which process is using the memory or the processor. `ps` can sort its list, and `head` keeps only the top of it:',
          '',
          '```',
          'ps aux --sort=-%mem | head -n 5',
          '```',
          '',
          '`--sort=` names the column to sort by. The minus sign in front of `%mem` asks for the largest value first. What remains is the header and the four processes that use the most memory.',
          '',
          'Because the output now goes into a pipe and not straight to the terminal, the command lines are no longer cut off.'
        ),
        hint: 'Type the line as shown. The sort key is `-%mem`: a minus sign, a percent sign and `mem`.',
        solution: 'ps aux --sort=-%mem | head -n 5',
        check: { cmd: 'ps', argsRe: /--sort(=|\s+)-(%mem|pmem|rss|rsz)\b/, out: /%MEM/ },
      },
      {
        id: 'top-mem',
        prompt: 'Read the `%MEM` and `COMMAND` columns of that short list. Which program uses the most memory? Give its name, which is the last part of the path at the start of the `COMMAND` column.',
        hint: 'It is the first line under the header. The command starts with a path such as `/usr/lib/.../name`, and the name is the part after the last slash.',
        solution: 'Xorg',
        answer: /^(\/usr\/lib\/xorg\/)?xorg$/i,
      },
      {
        id: 'forest',
        prompt: T(
          'That program, `Xorg`, is the display server that draws the desktop, so its place at the top is no surprise.',
          '',
          'Every process is started by another one, its *parent*. The chain leads back to PID 1, `systemd`, which the kernel starts at boot and which starts everything else, directly or indirectly. `--forest` draws the family tree, and `-u kali` limits the list to the processes of the user `kali`:',
          '',
          '```',
          'ps -u kali --forest',
          '```',
          '',
          'A `\\_` in front of a name marks a child of the nearest line above it that is indented one level less. Find `zsh` near the bottom: `ps` hangs below it, because your shell started it.'
        ),
        hint: 'Two dashes before `forest`, one before `u`. The user name follows `-u`.',
        solution: 'ps -u kali --forest',
        check: { cmd: 'ps', out: /\\_ +-?zsh\b/ },
      },
      {
        id: 'parent',
        prompt: T(
          'Parentage tells you how a process came to exist. On a system you are reviewing, an unexpected parent deserves a closer look: a web server that has started a shell, for example, is not something a web server normally does.',
          '',
          'In the tree on your screen, which program is the parent of `zsh`?'
        ),
        hint: 'Go up from the `zsh` line to the nearest line whose `\\_` sits one level further left. Its name is the answer.',
        solution: 'qterminal',
        answer: /^(\/usr\/bin\/)?qterminal$/i,
      },
      {
        id: 'pgrep',
        prompt: T(
          'A terminal window started a shell, and the shell started `ps`. That is the chain behind every command you type.',
          '',
          'To find one process you do not have to read the whole list. `pgrep` searches the process names and prints the PIDs that match. With `-a` it prints the full command line next to each PID:',
          '',
          '```',
          'pgrep -a cron',
          '```',
          '',
          'One line: the PID, then the command. `cron` is the service that runs scheduled jobs. When nothing matches, `pgrep` prints nothing at all.'
        ),
        hint: 'Type `pgrep -a cron`.',
        solution: 'pgrep -a cron',
        check: { cmd: 'pgrep', out: /^\d+ \S*cron/m },
      },
      {
        id: 'pgrep-own',
        prompt: 'Now on your own. `NetworkManager` is the service that manages the network connections of this machine. Use `pgrep` to print its PID.',
        hint: '`pgrep` followed by the name, or by a distinctive part of it. Upper and lower case matter.',
        solution: 'pgrep NetworkManager',
        // the PID of NetworkManager, found by name and not by listing everything
        check: { cmd: ['pgrep', 'pidof'], fn: (ev) => {
          const pid = pidOf(/\/NetworkManager\b/); const lines = outOf(ev).split('\n').filter((l) => l.trim());
          return pid != null && lines.length <= 3 && lines.some((l) => new RegExp('^' + pid + '\\b').test(l.trim()));
        } },
      },
      {
        id: 'top',
        prompt: T(
          '`ps` lists processes. `top` adds a summary of the whole machine and puts the busiest processes first. Run on its own, `top` fills the screen and refreshes every three seconds until you press `q`. For a single report that stays in the terminal, ask for batch mode with `-b` and for one round with `-n 1`:',
          '',
          '```',
          'top -b -n 1 | head -n 12',
          '```',
          '',
          'Read the summary at the top:',
          '',
          '- `load average`: the average number of processes that were running or waiting their turn, over the last 1, 5 and 15 minutes. Compare it with the number of processors. This machine has two, so a value near 2 would mean both are fully occupied.',
          '- `Tasks`: how many processes exist, and how many of them are running, sleeping, stopped or zombies',
          '- `%Cpu(s)`: where processor time goes. `id` is idle time.',
          '- `MiB Mem`: total, free and used memory',
          '',
          'Below the summary come the processes, sorted by `%CPU`.'
        ),
        hint: 'The options are `-b` and `-n 1`. The pipe into `head -n 12` keeps the summary and the first few processes.',
        solution: 'top -b -n 1 | head -n 12',
        check: { cmd: 'top', out: /load average:[\s\S]*PID\s+USER/ },
      },
    ],
    quiz: [
      {
        q: 'In a new terminal, `ps` with no options lists two processes. Why so few?',
        choices: [
          'Only two processes are running on the machine',
          'Without options, `ps` lists only your own processes that are attached to this terminal',
          'An ordinary user may not see the other processes',
          '`ps` stops when the list would be longer than the window',
        ],
        answer: 1,
        why: 'Plain `ps` is limited to the current terminal. The other hundred or so processes are visible to you as well: `ps aux` lists them.',
      },
      {
        q: 'A line of `ps aux` on a web server shows `S` in the `STAT` column of an `nginx` process. What does it tell you?',
        choices: [
          'The process was stopped by an administrator',
          'The process has crashed and is waiting to be cleared away',
          'The process is sleeping: it is waiting for work, which is the normal state of a server between requests',
          'The process was started by systemd',
        ],
        answer: 2,
        why: '`S` means sleeping. A server process spends most of its life waiting for the next request. Stopped is `T`, and a zombie is `Z`.',
      },
      {
        q: 'You run `pgrep sshd`. It prints nothing and the prompt returns. What is the most reasonable conclusion?',
        choices: [
          'No process named `sshd` is running at the moment',
          '`pgrep` needs `sudo` to see processes of other users',
          'The SSH server is running, but it is asleep',
          'The command failed and should be repeated',
        ],
        answer: 0,
        why: '`pgrep` prints one PID for each match and nothing when there is no match. Sleeping processes are listed like any others, and no special privilege is needed to see process names.',
      },
      {
        q: '`top` on a machine with two processors reports `load average: 4.10, 3.90, 3.80`. What does that suggest?',
        choices: [
          'About 4 percent of the processor is in use',
          'Four users are logged in',
          'The machine was busy a quarter of an hour ago and has recovered',
          'For at least the last quarter of an hour, about twice as much work has been ready to run as the processors can take',
        ],
        answer: 3,
        why: 'Load is counted in processes, not percent. Around 4 on two processors means that work is queuing, and the three values (1, 5 and 15 minutes) show that it has been that way for a while.',
      },
    ],
    refs: ['ps(1)', 'pgrep(1)', 'top(1)', 'Kali Linux Revealed, ch. 3 (Managing Processes)'],
  };

  K.lessons.register({
    id: 'proc',
    title: 'Processes, services and logs',
    order: 40,
    summary: 'See what is running on a system and what started it, control jobs and services, and read the logs that record what happened.',
    lessons: [psLesson],
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
