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

  /* -------------------------------------------------------------- services */
  /** Is the SSH server unit running on the Kali machine? */
  const sshActive = () => { const u = K.sys && K.sys.unit(K.kali, 'ssh.service'); return !!u && u.active === 'active'; };
  const SSH_UNIT = /(^|\s)sshd?(\.service)?(\s|$)/;

  const servicesLesson = {
    id: 'proc-services',
    title: 'Services: systemctl and listening ports',
    minutes: 12,
    objectives: [
      'Read the state of a service from `systemctl status`',
      'Start and stop a service with `sudo systemctl start` and `stop`',
      'Tell apart *started now* and *enabled at boot*',
      'Confirm with `ss -tln` which ports are open on your machine, and explain why Kali leaves network services off',
    ],
    intro: T(
      'A *service* is a program that runs in the background with no terminal, usually from boot: the scheduler, the logging system, an SSH or web server. On Kali, as on most Linux distributions, services are managed by systemd, and `systemctl` is the command for talking to it.',
      '',
      'This matters to you in two ways. A service that listens on the network is a door into a machine. On your own workstation you decide which doors exist, and on a system you review, the list of services is the list of what it offers to others. In this lesson you start the SSH server of your Kali machine, see what that changes, and switch it off again.'
    ),
    steps: [
      {
        id: 'status',
        prompt: T(
          'Ask systemd about the SSH server. Its unit is called `ssh`:',
          '',
          '```',
          'systemctl status ssh',
          '```',
          '',
          'Read two lines.',
          '',
          '- `Loaded:` shows the file that defines the service, then whether it is started at boot. Here that is `disabled`. The last part, `preset: disabled`, is the default this distribution gives the service.',
          '- `Active:` shows what it is doing now: `inactive (dead)`, which means not running.',
          '',
          'Looking is free. Any user may ask for the status of a service.'
        ),
        hint: 'Type `systemctl status ssh`.',
        solution: 'systemctl status ssh',
        check: { cmd: ['systemctl', 'service'], argsRe: /status/, out: /ssh\.service[\s\S]*Active:/ },
      },
      {
        id: 'listen-before',
        prompt: T(
          'A network service waits for connections on a numbered *port*. `ss` shows the sockets of this machine. Ask it for the listening ones:',
          '',
          '```',
          'ss -tln',
          '```',
          '',
          '- `-t` shows TCP sockets',
          '- `-l` shows only sockets that are listening, which means waiting for someone to connect',
          '- `-n` prints port numbers instead of looking up service names',
          '',
          'On a fresh Kali the answer is a header line and nothing below it. No program on this machine is accepting connections from the network.',
          '',
          'That is deliberate. Kali is made to be taken onto networks you do not control, so it installs network services switched off, and a service you add later stays off until you start it. A machine on which nothing listens offers nothing to connect to.'
        ),
        hint: 'Type `ss -tln`: one dash, then the three letters.',
        solution: 'ss -tln',
        check: { any: [
          { cmd: 'ss', args: ['-l'], out: /Local Address:Port/ },
          { cmd: 'netstat', args: ['-l'], out: /Local Address/ },
        ] },
      },
      {
        id: 'start',
        prompt: T(
          'Now start the service. Starting and stopping services changes the machine for everyone who uses it, so it needs root:',
          '',
          '```',
          'sudo systemctl start ssh',
          '```',
          '',
          '`sudo` asks for your password, which is `kali` in this lab. After that the command prints nothing. `systemctl` reports only when something goes wrong, so silence means the service started.'
        ),
        hint: 'Put `sudo` in front of `systemctl start ssh` and type your password when asked.',
        solution: 'sudo systemctl start ssh',
        input: ['kali'],
        check: { cmd: ['systemctl', 'service'], user: 'root', argsRe: /\b(re)?start\b|--now/, fn: sshActive },
      },
      {
        id: 'status-running',
        prompt: T(
          'Do not take silence on trust. Look at the status of the unit again, with the same command you used in the first step.',
          '',
          'The `Active:` line now reads `active (running)`, with the time it started. `Main PID:` is the process that does the work, and `ps` would show it under the same number. The lines at the bottom are the latest messages the service has logged. Two of them say which addresses and which port the server is listening on.'
        ),
        hint: '`systemctl status` followed by the name of the unit.',
        solution: 'systemctl status ssh',
        check: { cmd: ['systemctl', 'service'], argsRe: /status/, out: /ssh\.service[\s\S]*Active: active \(running\)/ },
      },
      {
        id: 'listen-after',
        prompt: 'The log lines say that the server listens on port 22. Confirm it from the outside of the service: list the listening TCP sockets again, as you did before you started it.',
        hint: 'The same `ss` command as before, with `-t`, `-l` and `-n`.',
        solution: 'ss -tln',
        check: { any: [
          { cmd: 'ss', args: ['-l'], out: /^LISTEN\s.*:(22|ssh)\s/m },
          { cmd: 'netstat', args: ['-l'], out: /:(22|ssh)\s.*LISTEN/ },
        ] },
      },
      {
        id: 'address',
        prompt: T(
          'Two lines have appeared, one for IPv4 and one for IPv6. Each `LISTEN` line is an open door, and the column `Local Address:Port` says where the door is.',
          '',
          'What does that column show on the first `LISTEN` line?'
        ),
        hint: 'It is the fourth item on the line: an address, a colon and a port number.',
        solution: '0.0.0.0:22',
        answer: /^0\.0\.0\.0\s*(:\s*(22|ssh))?$/i,
      },
      {
        id: 'enabled',
        prompt: T(
          'The address `0.0.0.0` stands for every address this machine has, so the SSH server can now be reached from the network, not only from the machine itself. A service that listened on `127.0.0.1` would be reachable only locally. This is the first thing to read in any list of listening ports.',
          '',
          'The service is running. Will it be running after the next restart of the machine? That is a separate question with its own command:',
          '',
          '```',
          'systemctl is-enabled ssh',
          '```',
          '',
          'It answers `disabled`. `start` and `stop` act now and are forgotten at the next boot. `enable` and `disable` decide what happens at boot and change nothing now. The two are independent, so a service can be running but disabled, as this one is, or enabled but stopped.',
          '',
          '`sudo systemctl enable ssh` would make the server start at every boot. Do not run it here. A Kali machine that offers SSH on every network it joins, perhaps still with the well-known password `kali`, is exactly what the default is meant to prevent.'
        ),
        hint: 'Type `systemctl is-enabled ssh`. No `sudo` is needed to ask.',
        solution: 'systemctl is-enabled ssh',
        check: { cmd: 'systemctl', args: ['is-enabled'], argsRe: SSH_UNIT, out: /^(disabled|enabled)\s*$/m },
      },
      {
        id: 'stop',
        prompt: T(
          'You started the service to look at it, and the look is over. Close the door again: stop the SSH server.',
          '',
          'The command has the same shape as the one that started it.'
        ),
        hint: 'Replace `start` with `stop`. It needs `sudo` for the same reason.',
        solution: 'sudo systemctl stop ssh',
        input: ['kali'],
        check: { cmd: ['systemctl', 'service'], user: 'root', argsRe: /\bstop\b|--now/, fn: () => !sshActive() },
      },
      {
        id: 'confirm',
        prompt: T(
          'Confirm that it worked. You know three ways to ask, and any of them completes this step:',
          '',
          '- `systemctl is-active ssh` answers in one word, which is convenient in scripts',
          '- `systemctl status ssh` shows the full picture',
          '- `ss -tln` shows whether port 22 is still open',
          '',
          'Checking the result of a change, and not assuming it, is a habit worth keeping. Before you connect a testing workstation to a network that is not yours, `ss -tln` tells you in one line what that network will be able to reach on your machine.'
        ),
        hint: 'For example `systemctl is-active ssh`. The step completes when the answer shows that the service is no longer running.',
        solution: 'systemctl is-active ssh',
        check: { any: [
          { cmd: 'systemctl', args: ['is-active'], argsRe: SSH_UNIT, out: /^inactive\s*$/m },
          { cmd: ['systemctl', 'service'], argsRe: /status/, out: /ssh\.service[\s\S]*Active: inactive/ },
          { cmd: 'ss', args: ['-l'], out: /Local Address:Port/, fn: (ev) => !sshActive() && !/:(22|ssh)\s/.test(outOf(ev)) },
        ] },
      },
    ],
    quiz: [
      {
        q: 'You run `sudo systemctl start apache2` and later restart the machine. Is the web server running after the restart?',
        choices: [
          'Yes, a service that has been started stays started',
          'Only if nobody has run `systemctl stop apache2` in the meantime',
          'No: `start` acts only on the running system. Starting at boot is what `enable` is for',
          'No, because `start` needs the option `--boot`',
        ],
        answer: 2,
        why: '`start` and `stop` change the present, `enable` and `disable` change what happens at boot. To get both at once there is `sudo systemctl enable --now apache2`.',
      },
      {
        q: '`ss -tln` on a server shows `127.0.0.1:5432` on one line and `0.0.0.0:80` on another. Which of the two services can other machines on the network connect to?',
        choices: [
          'Only the one on port 80: `0.0.0.0` means every address of the machine, `127.0.0.1` means the machine itself only',
          'Only the one on port 5432',
          'Both, because both are in the state `LISTEN`',
          'Neither, until a firewall rule opens the ports',
        ],
        answer: 0,
        why: 'A service bound to `127.0.0.1` accepts connections only from programs on the same machine. One bound to `0.0.0.0` accepts them on every network interface.',
      },
      {
        q: '`systemctl is-active ssh` prints `inactive` and `systemctl is-enabled ssh` prints `enabled`. What is the situation?',
        choices: [
          'The service is broken, because the two answers contradict each other',
          'The service is not running now, and it will be started at the next boot',
          'The service is running, and it will not be started at the next boot',
          'The service is not installed',
        ],
        answer: 1,
        why: 'The two commands answer different questions: what is happening now, and what will happen at boot. Somebody stopped the service without disabling it, so it comes back after a restart.',
      },
      {
        q: 'Why does Kali install network services switched off?',
        choices: [
          'To make the machine start faster',
          'Because the services are trial versions that have to be activated',
          'Because systemd cannot start services on a desktop system',
          'Because a testing workstation is often on networks that are not trusted, and every listening service is something others can connect to',
        ],
        answer: 3,
        why: 'Kali disables network services by default, including services you install later. You start what you need, for as long as you need it, and nothing listens without your decision.',
      },
    ],
    refs: ['systemctl(1)', 'systemd.unit(5)', 'ss(8)', 'sshd(8)', 'Kali Linux Revealed, ch. 5 (Managing Services)', 'kali.org/docs/policy/kali-linux-network-service-policy'],
  };

  /* ------------------------------------------------------------------ logs */
  const logsLesson = {
    id: 'proc-logs',
    title: 'Logs: journalctl and auth.log',
    minutes: 11,
    objectives: [
      'Read the journal with `journalctl`, limiting it by unit (`-u`), count (`-n`) and priority (`-p`)',
      'Read a log line as time, host, program and message',
      'Find the record of your own `sudo` use in `/var/log/auth.log` and in the journal',
      'Explain why logs matter to administrators and to testers alike',
    ],
    intro: T(
      'A log is the diary of a system: services, logins, and every use of `sudo` leave a line with a time stamp. Administrators read logs to find out what went wrong and who did what. Testers read them for the same reason, and because every action you take on a target leaves marks that the owner can find. Working in a way you can explain afterwards starts with knowing what you leave behind.',
      '',
      'On Kali the journal, collected by systemd, is one source. Some programs also write plain text files under `/var/log`. In this lesson you read both, and you find the record of a command you run yourself.'
    ),
    steps: [
      {
        id: 'recent',
        prompt: T(
          'Print the ten most recent entries of the journal. `--no-pager` prints them straight to the screen instead of opening a scrolling viewer:',
          '',
          '```',
          'journalctl -n 10 --no-pager',
          '```',
          '',
          'Each line has the same parts: the time, the name of the machine (`kali`), the program that wrote the line with its process ID in brackets, and the message.'
        ),
        hint: 'The option `-n 10` limits the output to ten lines. Add `--no-pager`.',
        solution: 'journalctl -n 10 --no-pager',
        check: { cmd: 'journalctl', args: ['-n'], out: /\bkali \S+\[\d+\]: / },
      },
      {
        id: 'oldest',
        prompt: T(
          'Without `-n` the journal starts with its oldest entry, from the moment the machine booted. Show only that first line by piping the output to `head`:',
          '',
          '```',
          'journalctl --no-pager | head -n 1',
          '```',
          '',
          'The first line is written by the kernel, which is why the program name is `kernel` and has no process ID.'
        ),
        hint: 'Run `journalctl --no-pager` and pipe it to `head -n 1`.',
        solution: 'journalctl --no-pager | head -n 1',
        check: { cmd: 'journalctl', out: /kernel: Linux version/, fn: (ev) => outOf(ev).trim().split('\n').length === 1 },
      },
      {
        id: 'kernel-version',
        prompt: 'Read the kernel version from that line. It follows the words `Linux version`. What is it? Type the version number, for example `6.12.1`.',
        hint: 'Look for the number just after `Linux version`, before `-kali1-amd64`. Run the previous command again if you need to.',
        solution: '7.1.5',
        answer: /^7\.1\.5(-kali1(-amd64)?)?$/,
      },
      {
        id: 'unit',
        prompt: T(
          'The journal holds the messages of every service together. To read the messages of one service, name its *unit* with `-u`. The scheduler `cron` runs jobs every hour on this machine:',
          '',
          '```',
          'journalctl -u cron --no-pager',
          '```',
          '',
          'Look at the message part of the lines. `session opened` and `session closed` bracket each job, and the line between them shows the command that was run.'
        ),
        hint: 'Use `journalctl -u cron`, with `--no-pager` if you like.',
        solution: 'journalctl -u cron --no-pager',
        check: { cmd: 'journalctl', argsRe: /(-u|--unit)\W*cron/, out: /CRON\[\d+\]/ },
      },
      {
        id: 'cron-user',
        prompt: 'Look at the `CMD` line from cron. Which account runs the hourly jobs? Type the user name.',
        hint: 'The line reads `(account) CMD (...)`. The account is in the first parentheses.',
        solution: 'root',
        answer: ['root'],
      },
      {
        id: 'priority',
        prompt: T(
          'Most lines are routine. Every journal entry has a *priority*, from `debug` up through `info`, `notice`, `warning`, `err`, `crit`, `alert` and `emerg`. `-p` shows the entries at that priority or worse. To see only the trouble since boot:',
          '',
          '```',
          'journalctl -b -p warning --no-pager',
          '```',
          '',
          'On this machine the answer is `-- No entries --`: nothing at warning or worse was logged since boot. On a system with a problem, this is the first filter to try. The same command with `-p err` narrows it further.'
        ),
        hint: 'Combine `-b` (this boot) with `-p warning`.',
        solution: 'journalctl -b -p warning --no-pager',
        check: { cmd: 'journalctl', argsRe: /(-p|--priority)\W*(warning|4|err|3|crit|alert|emerg)/, exit: 0 },
      },
      {
        id: 'sudo-run',
        prompt: T(
          'Now make something happen that a log will record. Run a harmless command through `sudo`:',
          '',
          '```',
          'sudo id',
          '```',
          '',
          'Type the password `kali` when asked. Nothing appears on screen while you type it. Afterwards the output shows `uid=0(root)`: for this one command you were root.'
        ),
        hint: 'Type `sudo id` and enter the password `kali`.',
        solution: 'sudo id',
        input: ['kali'],
        check: { cmd: 'id', user: 'root', out: /uid=0\(root\)/ },
      },
      {
        id: 'authlog',
        prompt: T(
          'That command left a record. Services that handle logins and privileges write to `/var/log/auth.log`. Your account is a member of the group `adm`, which is allowed to read it. Search it for the word `COMMAND`, which `sudo` writes for every command it runs:',
          '',
          '```',
          'grep COMMAND /var/log/auth.log',
          '```',
          '',
          'Find your `sudo id`. The line says who ran sudo (`kali`), from which terminal (`TTY`), in which directory (`PWD`), as which account (`USER=root`), and what was run (`COMMAND=`).'
        ),
        hint: 'Use `grep COMMAND /var/log/auth.log`. No `sudo` is needed to read this file.',
        solution: 'grep COMMAND /var/log/auth.log',
        check: { cmd: 'grep', out: /sudo:\s+kali : TTY=\S+ ; PWD=\S+ ; USER=root ; COMMAND=\/usr\/bin\/id\b/ },
      },
      {
        id: 'who',
        prompt: 'In that line, the name after `sudo:` is the account that ran `sudo`. The `USER=` field is the account the command ran as. Which account ran `sudo`? Type the name.',
        hint: 'It is not `root`. Read the text just after `sudo:`.',
        solution: 'kali',
        answer: ['kali'],
      },
      {
        id: 'journal-sudo',
        prompt: T(
          'The same record is also in the journal. `-t` selects entries by the name of the program that wrote them, here `sudo`. Look for the same line there:',
          '',
          '```',
          'journalctl -t sudo --no-pager',
          '```',
          '',
          'A record that appears in two places is harder to lose, and a reviewer can use whichever is more convenient. Reading what your own tools log is good practice: when you write up a test, your notes should agree with what the owner finds in their logs.'
        ),
        hint: 'Use `journalctl -t sudo`, with `--no-pager`.',
        solution: 'journalctl -t sudo --no-pager',
        check: { cmd: 'journalctl', argsRe: /(-t|--identifier)\W*sudo/, out: /COMMAND=\/usr\/bin\/id\b/ },
      },
    ],
    quiz: [
      {
        q: 'You run `journalctl -u ssh -n 20`. What do you see?',
        choices: [
          'The twenty most recent entries of the SSH server unit',
          'Every entry of the last twenty minutes',
          'Entries of all services whose name contains `ssh`, from the last twenty days',
          'The twenty users who logged in most often',
        ],
        answer: 0,
        why: '`-u` limits the output to one unit and `-n` limits the number of lines, counted from the newest entry.',
      },
      {
        q: 'A server logs a failed login for the account `admin` in `/var/log/auth.log` every few seconds, from one address, for an hour. What is the most reasonable reading?',
        choices: [
          'Normal background noise that needs no attention',
          'Someone is guessing passwords, and the owner should know',
          'The log file is corrupt',
          'The account `admin` has been deleted',
        ],
        answer: 1,
        why: 'Repeated failures from one source are what an administrator looks for. As a tester you would report such a pattern if you found it unexpectedly, and you would expect your own tests to leave similar traces.',
      },
      {
        q: '`journalctl -p err` prints `-- No entries --`. What does that mean?',
        choices: [
          'The journal is empty',
          'The command is wrong',
          'Nothing at priority `err` or worse was logged in the period the command covers',
          'Only root may read the journal',
        ],
        answer: 2,
        why: 'The filter matched nothing. The journal still holds entries at lower priorities, which `journalctl` without `-p` shows.',
      },
      {
        q: 'Why do testers care that their actions appear in logs?',
        choices: [
          'Logs let the client check what the test did, and let the tester explain it afterwards',
          'Logs make the target machine faster',
          'Logs are only written when a test fails',
          'Testers should always delete logs when the test ends',
        ],
        answer: 0,
        why: 'Logs are evidence of what happened during the engagement. Altering or deleting them on a client system is outside the rules of an authorized test unless the agreement says otherwise.',
      },
    ],
    refs: ['journalctl(1)', 'systemd.journal-fields(7)', 'sudo(8)', 'Kali Linux Revealed, ch. 5', 'NIST SP 800-92'],
  };

  K.lessons.register({
    id: 'proc',
    title: 'Processes, services and logs',
    order: 40,
    summary: 'See what is running on a system and what started it, control jobs and services, and read the logs that record what happened.',
    lessons: [psLesson, jobsLesson, servicesLesson, logsLesson],
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
