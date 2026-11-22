/* Kalima — curriculum module "remote": remote access and file transfer.
 *
 * Lessons: remote-ssh, remote-keys, remote-scp, remote-ftp. They talk to the
 * lab servers web01 and files01 through the simulated network. The test
 * account (student / student) is read from ~/engagement/credentials.txt.
 *
 * Passwords and host key answers are typed input. A step that connects lists
 * ['yes', 'student'] in `input`: on a first connection the first item answers
 * the host key question; when the host is already trusted the first item is
 * refused as a password and ssh asks again, so the same list works either way.
 * Working files live under ~/practice/remote/.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const outOf = (ev) => K.util.stripAnsi(ev.output || '');
  const WEB = 'student@web01.halcyon.lab';
  const SSHIN = ['yes', 'student'];

  /* ------------------------------------------------------------- remote-ssh */
  const sshLesson = {
    id: 'remote-ssh',
    title: 'Logging in with ssh',
    minutes: 11,
    objectives: [
      'Log in to a server with the account the client supplied and run commands there',
      'Explain the host key question and what `known_hosts` is for',
      'Use the form `ssh user@host command` and tell which machine answered',
    ],
    intro: T(
      'SSH is the normal way to work on a remote Linux machine: the login, the commands and the files all travel in an encrypted channel. On an engagement it is how you read a server the way its administrators do, with the account the client gave you for that purpose.',
      '',
      'The first time you connect to a server, SSH asks you to confirm its *host key*. That question is the protection against talking to an impostor, and answering it carelessly defeats it. In this lesson you connect to `web01.halcyon.lab`, which is inside the scope in `~/engagement/scope.txt`, and you learn what the question means.'
    ),
    steps: [
      {
        id: 'creds',
        prompt: T(
          'The client supplied a test account for authenticated checks. Read the file that records it:',
          '',
          '```',
          'cat ~/engagement/credentials.txt',
          '```',
          '',
          'Lines that start with `#` are comments. The two lines that matter are `username:` and `password:`. The comment says which servers accept the account.'
        ),
        hint: 'Use `cat` on `~/engagement/credentials.txt`.',
        solution: 'cat ~/engagement/credentials.txt',
        check: { cmd: 'cat', out: /username: student/ },
      },
      {
        id: 'creds-q',
        prompt: 'How many servers does the comment say the account is valid on? Type the number.',
        hint: 'Count the names after `Valid on:`.',
        solution: '4',
        answer: ['4', 'four'],
      },
      {
        id: 'login',
        prompt: T(
          'Connect to `web01` and run one command there. The form is `ssh user@host command`: ssh logs in, runs the command, prints its output and returns to your own shell.',
          '',
          '```',
          'ssh student@web01.halcyon.lab hostname',
          '```',
          '',
          'If you have not connected to this server before, ssh stops and prints a message that begins `The authenticity of host ... can\'t be established.` It shows the server\'s *fingerprint*, a short identifier of its host key, and asks whether to continue. Type `yes` and press Enter. Then it asks for the password: type `student`. Nothing appears while you type a password.',
          '',
          'The output of the command is the name of the machine that ran it: `web01`.'
        ),
        hint: 'Type `ssh student@web01.halcyon.lab hostname`. Answer `yes` to the host key question if it appears, then enter the password.',
        solution: 'ssh student@web01.halcyon.lab hostname',
        input: SSHIN,
        check: { cmd: 'hostname', host: 'web01', out: /^web01\s*$/m, exit: 0 },
      },
      {
        id: 'known-hosts',
        prompt: T(
          'When you answered `yes`, ssh stored the host key in `~/.ssh/known_hosts`. Look at it:',
          '',
          '```',
          'cat ~/.ssh/known_hosts',
          '```',
          '',
          'Each line is one server: the name, then the key type, then the key itself. Debian and Kali hash the host name (the part that starts with `|1|`), so a stolen file does not list the machines you work with.',
          '',
          'From now on ssh compares the key the server presents with this line. If they ever differ, ssh refuses to continue and warns you. That is the point: the question is asked once, and every later connection is checked against your answer.'
        ),
        hint: 'Use `cat ~/.ssh/known_hosts`.',
        solution: 'cat ~/.ssh/known_hosts',
        check: { cmd: 'cat', out: /ssh-ed25519 / },
      },
      {
        id: 'keytype',
        prompt: 'Read the line again. What is the key type stored there? Type the word that follows the hashed name.',
        hint: 'It starts with `ssh-`.',
        solution: 'ssh-ed25519',
        answer: ['ssh-ed25519', 'ed25519'],
      },
      {
        id: 'several',
        prompt: T(
          'A command line can hold several commands separated by semicolons. Quote them so your own shell passes the whole text to the server, and run three of them there:',
          '',
          '```',
          'ssh student@web01.halcyon.lab "hostname; whoami; uptime"',
          '```',
          '',
          'The three lines of output come from `web01`: its name, the account you logged in as, and how long it has been up with its load averages. Note that `whoami` says `student`: you are an ordinary user there, not `kali`.'
        ),
        hint: 'Put the three commands in double quotes after `student@web01.halcyon.lab`, separated by semicolons.',
        solution: 'ssh student@web01.halcyon.lab "hostname; whoami; uptime"',
        input: SSHIN,
        check: { cmd: 'uptime', host: 'web01', out: /load average/, exit: 0, fn: (ev) => /^student\s*$/m.test(outOf(ev)) },
      },
      {
        id: 'compare',
        prompt: T(
          'When a lot of terminals are open it is easy to forget which machine a command ran on, and a command run on the wrong machine is a classic mistake. A habit that prevents it: ask. Run `hostname` on your own machine, then on `web01`, in one line:',
          '',
          '```',
          'hostname; ssh student@web01.halcyon.lab hostname',
          '```'
        ),
        hint: 'Two commands separated by a semicolon: `hostname`, then the `ssh` command you used before.',
        solution: 'hostname; ssh student@web01.halcyon.lab hostname',
        input: SSHIN,
        check: { cmd: 'hostname', host: 'web01', out: /^web01\s*$/m, fn: (ev) => /^kali\s*$/m.test(outOf(ev)) },
      },
      {
        id: 'interactive',
        info: true,
        prompt: T(
          'Without a command at the end, `ssh student@web01.halcyon.lab` opens an interactive shell on the server. The prompt changes to `student@web01:~$`, and every command you type runs there until you leave with `exit` or Ctrl-D. You can try it yourself after this lesson. The form with a command is better for notes and scripts, because the line you type shows exactly what ran where.'
        ),
      },
      {
        id: 'forget',
        prompt: T(
          'Servers get rebuilt, and then their host key legitimately changes. ssh then refuses to connect and tells you which line of `known_hosts` conflicts. After you have confirmed with the owner that the change is expected, you remove the old entry. Practice the command that does it:',
          '',
          '```',
          'ssh-keygen -R web01.halcyon.lab',
          '```',
          '',
          'It reports the line it found and keeps a copy of the old file as `known_hosts.old`. The next connection to `web01` asks the host key question again. A changed key that you cannot explain is something to report to the client, not to delete.'
        ),
        hint: 'Use `ssh-keygen -R` followed by the host name.',
        solution: 'ssh-keygen -R web01.halcyon.lab',
        check: { cmd: 'ssh-keygen', args: ['-R'], out: /known_hosts updated/ },
      },
    ],
    quiz: [
      {
        q: 'ssh prints "The authenticity of host ... can\'t be established" and a fingerprint. What is the careful response?',
        choices: [
          'Answer `yes` at once; the message appears for every server',
          'Compare the fingerprint with one the owner gave you through another channel when you can, and answer `yes` only if it matches',
          'Answer `no`, then connect again until the message disappears',
          'Delete `known_hosts` so that ssh stops asking',
        ],
        answer: 1,
        why: 'The first connection cannot prove the server is the real one. A fingerprint from a second, independent source can. Trust on first use is only as good as that check.',
      },
      {
        q: 'What does `ssh student@web01.halcyon.lab "uptime"` print?',
        choices: [
          'The uptime of your Kali machine',
          'The uptime of web01, and then you are back at your own prompt',
          'Nothing; `uptime` is not allowed over ssh',
          'The uptime of web01, and you stay logged in there',
        ],
        answer: 1,
        why: 'ssh runs the command on the server, prints what it writes, and exits. Without a command you would stay in a shell on the server.',
      },
      {
        q: 'A server you have logged in to before now triggers a warning that the remote host identification has changed. Which is the right next step?',
        choices: [
          'Remove the line from `known_hosts` and connect again',
          'Add `-o StrictHostKeyChecking=no` and continue',
          'Stop and find out why: a rebuilt server explains it, an attacker in the path would too',
          'Ignore it; the warning is cosmetic',
        ],
        answer: 2,
        why: 'The warning means the key differs from the one you recorded. Most often the server was reinstalled, but you should confirm that with its owner before you trust the new key.',
      },
    ],
    refs: ['ssh(1)', 'ssh-keygen(1)', 'sshd(8)', 'known_hosts format in sshd(8)', 'RFC 4251', 'Kali Linux Revealed, ch. 5'],
  };

  K.lessons.register({
    id: 'remote',
    title: 'Remote access and file transfer',
    order: 90,
    summary: 'Log in to servers with ssh, use keys instead of passwords, copy files with scp, and recognize the clear-text FTP protocol for what it is.',
    lessons: [sshLesson],
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
