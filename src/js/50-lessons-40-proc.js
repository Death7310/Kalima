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

  /* ------------------------------------------------------------------ jobs */
  /** Did this line's `kill` name, by PID, a background job of the shell that ran it? */
  const killedJobByPid = (ev) => {
    const jobs = (ev.shell && ev.shell.jobs) || [];
    return (ev.commands || []).some((c) => c.argv[0] === 'kill' &&
      c.argv.slice(1).some((a) => /^\d+$/.test(a) && jobs.some((j) => j.pid === +a)));
  };
  const KILL_SIGNAL = /(^|\s)-(9|KILL|SIGKILL|s\s*(9|KILL|SIGKILL))(\s|$)/i;

  const jobsLesson = {
    id: 'proc-jobs',
    title: 'Foreground, background and signals',
    minutes: 10,
    objectives: [
      'Stop a foreground command with `Ctrl-C` and say which signal that sends',
      'Start a command in the background with `&` and list background jobs with `jobs`',
      'End a job with `kill`, by job number and by PID',
      'Explain the difference between the signals `TERM` and `KILL`, and when each is appropriate',
    ],
    intro: T(
      'Some commands finish before you have let go of the Enter key. Others, such as a scan of a network range or a large download, run for minutes or hours. You need to be able to stop a command that is going wrong, and to keep working while a slow one runs.',
      '',
      'The tools are the same on every Linux system: the foreground and the background of a terminal, and *signals*, the short messages by which the system tells a process to stop. This lesson uses `sleep`, a command that only waits, so nothing can go wrong while you practice.'
    ),
    steps: [
      {
        id: 'foreground',
        prompt: T(
          '`sleep` does nothing for the number of seconds you give it. That makes it a harmless stand-in for any slow tool:',
          '',
          '```',
          'sleep 5',
          '```',
          '',
          'For five seconds there is no prompt, and anything you type has to wait. The command is running in the *foreground*: the shell has handed the terminal to it and waits until it ends.'
        ),
        hint: 'Type `sleep 5`, press Enter and wait for the prompt to come back.',
        solution: 'sleep 5',
        check: { cmd: 'sleep', exit: 0, not: { line: /&/ } },
      },
      {
        id: 'interrupt',
        prompt: T(
          'A command can run for much longer than you meant it to. Start a sleep of five minutes, and once you have seen that the prompt is gone, press `Ctrl-C`:',
          '',
          '```',
          'sleep 300',
          '```',
          '',
          'The prompt comes back at once. `Ctrl-C` makes the terminal send a *signal* called `INT`, for interrupt, to the process in the foreground. A signal is a short message that the system delivers to a process, and most programs respond to `INT` by ending.',
          '',
          '`Ctrl-C` is the normal way to stop a foreground command. It reaches only the command that holds the terminal at that moment.'
        ),
        hint: 'Type `sleep 300` and press Enter. Then hold `Ctrl` and press `C`. The step completes when the command has been interrupted.',
        solution: 'sleep 300',
        // Ctrl-C cannot be pressed in the replay: the test line ends with the status an interrupted command leaves
        testSolution: 'sleep 300; (exit 130)',
        check: { line: /^\s*sleep\s+\S/, exit: 130 },
      },
      {
        id: 'background',
        prompt: T(
          'You do not have to wait for a slow command. An `&` at the end of the line starts it in the *background*:',
          '',
          '```',
          'sleep 300 &',
          '```',
          '',
          'The prompt returns immediately and the command keeps running. The shell answers with one line, for example `[1] 1290`. The number in brackets is the *job number*, which is the shell\'s own short name for this background command. The second number is its PID, the same number that `ps` would show.'
        ),
        hint: 'Type `sleep 300`, a space and `&`, then press Enter.',
        solution: 'sleep 300 &',
        check: { line: /^\s*sleep\s+\S+\s*&\s*$/, out: /^\[\d+\] \d+/m },
      },
      {
        id: 'jobs',
        prompt: T(
          'The shell keeps a list of the commands it has running in the background. Ask for it:',
          '',
          '```',
          'jobs',
          '```',
          '',
          'Each line shows a job number in brackets, a state, and the command. Your sleep is `running`. The `+` marks the current job, the one most recently started.',
          '',
          'The job list belongs to this shell. Another terminal window has its own list and does not see these jobs, although `ps aux` there would show the process.'
        ),
        hint: 'Type `jobs`. If the list is empty, the five minutes are over: start `sleep 300 &` again first.',
        solution: 'jobs',
        testSolution: 'sleep 300 & jobs',
        check: { cmd: 'jobs', out: /^\[\d+\]\s+[+-]?\s*running\s+sleep\b/m },
      },
      {
        id: 'kill-job',
        prompt: T(
          'To end a background job, send it a signal with `kill`. A percent sign followed by a job number tells `kill` which job you mean:',
          '',
          '```',
          'kill %1',
          '```',
          '',
          'If `jobs` showed a different number in the brackets, use that number. Then run `jobs` once more: the shell reports the job as `terminated`, and after that the list is empty.',
          '',
          'Despite its name, `kill` only delivers a message. Unless you say otherwise the message is the signal `TERM`, for terminate: a request to finish. A program may react to `TERM` by saving its work and removing its temporary files before it ends, and well-written programs do.'
        ),
        hint: '`kill`, a space, then `%` and the job number that `jobs` shows.',
        solution: 'kill %1',
        testSolution: 'sleep 300 & kill %1',
        check: { cmd: 'kill', argsRe: /%\d+/, exit: 0, not: { cmd: 'kill', argsRe: KILL_SIGNAL } },
      },
      {
        id: 'kill-pid',
        prompt: T(
          'Job numbers exist only inside the shell that started the job. Everywhere else a process is known by its PID, and `kill` accepts a PID as well.',
          '',
          'Start another sleep in the background, read the PID from the line the shell prints, and end the process with `kill` followed by that PID:',
          '',
          '```',
          'sleep 600 &',
          '```',
          '',
          'The step completes when the `kill` has been delivered. This is the form you will use most, because it works on any process that belongs to you, whichever shell or program started it. Processes of other users are out of reach unless you use `sudo`.'
        ),
        hint: 'After `sleep 600 &` the shell prints something like `[1] 1304`. The second number is the PID: type `kill 1304` with your own number. The shell also keeps the PID of its latest background job in `$!`, so `kill $!` does the same.',
        solution: 'kill $!',
        testSolution: 'sleep 600 & kill $!',
        check: { cmd: 'kill', exit: 0, fn: killedJobByPid, not: { cmd: 'kill', argsRe: KILL_SIGNAL } },
      },
      {
        id: 'signals',
        prompt: T(
          '`TERM` and `INT` are two of many signals. Print their names:',
          '',
          '```',
          'kill -l',
          '```',
          '',
          'The names are listed in order of their numbers, starting at 1. `INT`, the signal behind `Ctrl-C`, is second, so it is signal 2. `TERM` is in fifteenth place.',
          '',
          'Count along the list. Which signal is number 9?'
        ),
        hint: 'The list begins `HUP INT QUIT`, which are 1, 2 and 3. Keep counting to the ninth name.',
        solution: 'KILL',
        answer: /^(sig)?kill$/i,
      },
      {
        id: 'kill-9',
        prompt: T(
          '`KILL` is different from every signal you have used so far. It is never delivered to the program at all: the kernel removes the process on the spot. Nothing can ignore it, and nothing gets the chance to tidy up, so files may be left half-written and temporary files left behind.',
          '',
          'That makes it the last resort. Send `TERM` first and give the program a few seconds. Use `KILL` only on a process that does not respond.',
          '',
          'Practice the form once. Start `sleep 900 &`, then end that job with the signal `KILL`. The signal goes between `kill` and the target, as a name or as a number: `-KILL` or `-9`.'
        ),
        hint: 'Start the job with `sleep 900 &`. Then type `kill -KILL %1`, with the job number the shell printed in brackets.',
        solution: 'kill -KILL %1',
        testSolution: 'sleep 900 & kill -KILL %1',
        check: { any: [
          { cmd: 'kill', argsRe: KILL_SIGNAL, exit: 0, all: [{ cmd: 'kill', argsRe: /%\d+\s*$/ }] },
          { cmd: 'kill', argsRe: KILL_SIGNAL, exit: 0, fn: killedJobByPid },
        ] },
      },
    ],
    quiz: [
      {
        q: '`sleep 300 &` is running in the background and you are at an empty prompt. You press `Ctrl-C`. What happens to the sleep?',
        choices: [
          'It ends, because `Ctrl-C` stops every command started from this terminal',
          'Nothing: `Ctrl-C` goes to the foreground, and the job is in the background',
          'It moves to the foreground',
          'It is paused until you press `Ctrl-C` again',
        ],
        answer: 1,
        why: '`Ctrl-C` sends `INT` to the process that holds the terminal. A background job does not, so it keeps running. To end it, use `kill` with its job number or PID.',
      },
      {
        q: 'You sent `kill 4321` to a program of yours a minute ago, and `ps` still shows PID 4321. What is the sensible next step?',
        choices: [
          'Send `kill -KILL 4321`, accepting that the program gets no chance to clean up',
          'Run `kill 4321` again and again until it works',
          'Close the terminal window',
          'Restart the machine',
        ],
        answer: 0,
        why: 'A program may ignore `TERM` or hang while handling it. `KILL` cannot be ignored, because the kernel acts on it directly. It comes second because the program can no longer save its work or remove its temporary files.',
      },
      {
        q: 'Why can a program not protect itself against the signal `KILL`?',
        choices: [
          'Because only root is allowed to send it',
          'Because it is sent many times in quick succession',
          'Because it is handled by the kernel and never reaches the code of the program',
          'It can: a carefully written program catches `KILL` like any other signal',
        ],
        answer: 2,
        why: 'A program can install its own handler for most signals, `TERM` and `INT` included. `KILL` has no handler: the kernel ends the process without asking it. Any user may send it to processes of their own.',
      },
      {
        q: 'In one terminal you start `sleep 600 &`. In a second terminal window you type `kill %1`. What happens?',
        choices: [
          'The sleep ends, because it is job 1',
          'Both shells end',
          'The sleep is moved into the second terminal',
          'The second shell reports that it has no such job: job numbers belong to the shell that started the job',
        ],
        answer: 3,
        why: 'Each shell keeps its own job list. From anywhere else, find the PID with `pgrep` or `ps` and use `kill` with the PID.',
      },
    ],
    refs: ['zshbuiltins(1), for `jobs` and `kill`', 'zshmisc(1), section JOBS', 'kill(1)', 'signal(7)', 'sleep(1)'],
  };

  K.lessons.register({
    id: 'proc',
    title: 'Processes, services and logs',
    order: 40,
    summary: 'See what is running on a system and what started it, control jobs and services, and read the logs that record what happened.',
    lessons: [psLesson, jobsLesson],
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
