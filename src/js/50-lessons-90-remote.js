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

  /* ------------------------------------------------------------ remote-keys */
  const KEY = '~/.ssh/halcyon_ed25519';
  const keysLesson = {
    id: 'remote-keys',
    title: 'SSH keys instead of passwords',
    minutes: 11,
    objectives: [
      'Create an ed25519 key pair and say which half is secret',
      'Install the public half on a server with `ssh-copy-id`',
      'Log in without typing the account password',
      'Explain what a passphrase adds and why keys are preferred to passwords',
    ],
    intro: T(
      'A password can be guessed, reused, or typed into the wrong window. An SSH key pair avoids most of that. You keep a *private* key that never leaves your machine, and give servers the matching *public* key. To log in, you prove that you hold the private key without ever sending it.',
      '',
      'Administrators use keys for their own accounts, and scripts use them because nobody has to type anything. For you, a key for each engagement is also tidy bookkeeping: when the engagement ends, the key can be deleted and removed from the servers. This lesson creates one for the lab.'
    ),
    steps: [
      {
        id: 'generate',
        prompt: T(
          'Create a key pair for this engagement:',
          '',
          '```',
          'ssh-keygen -t ed25519 -f ~/.ssh/halcyon_ed25519 -N ""',
          '```',
          '',
          '- `-t ed25519` selects the key type, a modern and compact one',
          '- `-f` names the file for the private key; the public key gets the same name plus `.pub`',
          '- `-N ""` sets an empty passphrase',
          '',
          'The empty passphrase keeps this lab simple. Without `-N`, ssh-keygen asks you for a passphrase, and on a real workstation you should give one. If the file already exists from an earlier attempt, ssh-keygen asks whether to overwrite it: answer `y`.',
          '',
          'The output shows the *fingerprint* of the new key and its randomart picture.'
        ),
        hint: 'Run `ssh-keygen` with `-t ed25519`, `-f ~/.ssh/halcyon_ed25519` and `-N ""`.',
        solution: 'ssh-keygen -t ed25519 -f ~/.ssh/halcyon_ed25519 -N ""',
        input: ['y'],
        check: { cmd: 'ssh-keygen', args: ['-t'], file: { path: '/home/kali/.ssh/halcyon_ed25519.pub', exists: true } },
      },
      {
        id: 'perms',
        prompt: T(
          'Two files were created. List them:',
          '',
          '```',
          'ls -l ~/.ssh/halcyon_ed25519*',
          '```',
          '',
          'Compare the permission columns. The private key is `-rw-------`: only you can read or write it. The public key is `-rw-r--r--`: anyone may read it, which is fine, because it is meant to be handed out. If a private key is readable by others, ssh refuses to use it.'
        ),
        hint: 'Use `ls -l` with the pattern `~/.ssh/halcyon_ed25519*`.',
        solution: 'ls -l ~/.ssh/halcyon_ed25519*',
        check: { cmd: 'ls', out: /-rw------- .*halcyon_ed25519\n[\s\S]*-rw-r--r-- .*halcyon_ed25519\.pub/ },
      },
      {
        id: 'perms-q',
        prompt: 'Which file is the secret one: the one with the name `halcyon_ed25519` or the one ending in `.pub`? Type the file name.',
        hint: 'Look at which of the two has permissions for the owner only.',
        solution: 'halcyon_ed25519',
        answer: /^(~\/\.ssh\/|\/home\/kali\/\.ssh\/)?halcyon_ed25519$/,
      },
      {
        id: 'pub',
        prompt: T(
          'Read the public key. It is one line of text:',
          '',
          '```',
          'cat ~/.ssh/halcyon_ed25519.pub',
          '```',
          '',
          'The line has three fields: the key type, the key itself, and a comment. By default the comment is `user@host` of the machine that made it, here `kali@kali`. The comment is only a label, so that you and the server\'s administrator can tell keys apart.',
          '',
          'Printing the *private* key would show the text `BEGIN OPENSSH PRIVATE KEY`. Never paste it into a chat, a ticket or a report.'
        ),
        hint: 'Use `cat` on the file that ends in `.pub`.',
        solution: 'cat ~/.ssh/halcyon_ed25519.pub',
        check: { cmd: 'cat', out: /^ssh-ed25519 \S+ kali@kali\s*$/m },
      },
      {
        id: 'copy-id',
        prompt: T(
          'Install the public key on the server, in the account you can already log in to. `ssh-copy-id` logs in with the password one last time and appends the key to `~/.ssh/authorized_keys` there:',
          '',
          '```',
          'ssh-copy-id -i ~/.ssh/halcyon_ed25519.pub student@web01.halcyon.lab',
          '```',
          '',
          '`-i` names the key to install. Answer the host key question with `yes` if it appears, and give the password `student`. The output ends with `Number of key(s) added: 1`.'
        ),
        hint: 'Use `ssh-copy-id -i` with the public key file and `student@web01.halcyon.lab`.',
        solution: 'ssh-copy-id -i ~/.ssh/halcyon_ed25519.pub student@web01.halcyon.lab',
        input: SSHIN,
        check: { cmd: 'ssh-copy-id', out: /Number of key\(s\) added: 1|already exist on the remote system/ },
      },
      {
        id: 'login-key',
        prompt: T(
          'Now log in with the key. `-i` says which private key to offer, and `-o PasswordAuthentication=no` forbids falling back to the password, so a success proves that the key worked:',
          '',
          '```',
          'ssh -i ~/.ssh/halcyon_ed25519 -o PasswordAuthentication=no student@web01.halcyon.lab hostname',
          '```',
          '',
          'No password prompt appears. The server checked that you hold the private key that belongs to the public key in `authorized_keys`.'
        ),
        hint: 'Add `-i` with the private key file, and `-o PasswordAuthentication=no`, before the `student@...` part.',
        solution: 'ssh -i ~/.ssh/halcyon_ed25519 -o PasswordAuthentication=no student@web01.halcyon.lab hostname',
        check: { cmd: 'hostname', host: 'web01', out: /^web01\s*$/m, exit: 0, fn: (ev) => !/password:/i.test(outOf(ev)) },
      },
      {
        id: 'authorized',
        prompt: T(
          'Look at what the server holds. Print the file that `ssh-copy-id` appended to:',
          '',
          '```',
          'ssh -i ~/.ssh/halcyon_ed25519 student@web01.halcyon.lab "cat ~/.ssh/authorized_keys"',
          '```',
          '',
          'Your public key is there, with its `kali@kali` comment. This is all the server stores: nothing in it lets anyone log in as you. If someone copied this file, they would only get your public key. If you want to revoke access, remove the line.'
        ),
        hint: 'Run `cat ~/.ssh/authorized_keys` on web01 through ssh, with the quotes as in the lesson text.',
        solution: 'ssh -i ~/.ssh/halcyon_ed25519 student@web01.halcyon.lab "cat ~/.ssh/authorized_keys"',
        check: { cmd: 'cat', host: 'web01', out: /^ssh-ed25519 \S+ kali@kali\s*$/m },
      },
      {
        id: 'authorized-q',
        prompt: 'Which file, in the home directory of the account on the server, lists the public keys that may log in? Type its name.',
        hint: 'It was in the command you just ran.',
        solution: 'authorized_keys',
        answer: /^(~\/\.ssh\/|\.ssh\/)?authorized_keys$/,
      },
      {
        id: 'fingerprint',
        prompt: T(
          'Last, learn to identify a key without printing it. A fingerprint is a short digest of the key:',
          '',
          '```',
          'ssh-keygen -l -f ~/.ssh/halcyon_ed25519.pub',
          '```',
          '',
          'The output has the key size in bits, the fingerprint beginning `SHA256:`, the comment, and the type. Fingerprints are what you compare when you want to know that two keys are the same, or when you note in a report which key you used.'
        ),
        hint: 'Use `ssh-keygen -l -f` with the public key file.',
        solution: 'ssh-keygen -l -f ~/.ssh/halcyon_ed25519.pub',
        check: { cmd: 'ssh-keygen', args: ['-l'], out: /^256 SHA256:\S+ kali@kali \(ED25519\)/m },
      },
    ],
    quiz: [
      {
        q: 'Which of the two files may be copied to a server, posted in a ticket or sent by email?',
        choices: [
          'Only the private key',
          'Both, because they are encrypted',
          'Only the public key, the one ending in `.pub`',
          'Neither; a key never leaves the machine that made it',
        ],
        answer: 2,
        why: 'The public key is designed to be shared. Whoever holds the private key can log in wherever the public key is installed, so that file stays on your machine.',
      },
      {
        q: 'Someone copies your private key file, which has a good passphrase. What is true?',
        choices: [
          'They can log in at once, because a passphrase only protects the public key',
          'They still need the passphrase to use the key, which buys you time to remove the key from the servers',
          'Nothing; a passphrase makes the file impossible to copy',
          'They can use it only from your machine',
        ],
        answer: 1,
        why: 'The passphrase encrypts the private key file. A copy of the file is not usable without it, though a weak passphrase can be guessed offline, so revoke the key anyway.',
      },
      {
        q: 'Why are keys preferred to passwords for logging in to servers?',
        choices: [
          'Keys are faster to type',
          'A key is long and random and is never sent to the server, so there is nothing to guess, reuse or capture',
          'Servers do not support passwords any more',
          'A key can be shared safely among colleagues',
        ],
        answer: 1,
        why: 'A password is a secret that crosses the network and can be guessed or reused. With a key the server only learns that you hold the secret. Sharing a private key among people is poor practice, since you cannot tell who used it.',
      },
      {
        q: 'You run `ssh -o PasswordAuthentication=no student@web01.halcyon.lab` and get `Permission denied (publickey,password)`. What does it tell you?',
        choices: [
          'The server is down',
          'Your password is wrong',
          'No key you offered is accepted for that account, and you forbade the password',
          'The host key changed',
        ],
        answer: 2,
        why: 'The list in parentheses is what the server accepts. With the password turned off, only a key could succeed, and none was accepted. Check which key ssh offered and whether it is in `authorized_keys`.',
      },
    ],
    refs: ['ssh-keygen(1)', 'ssh-copy-id(1)', 'ssh(1)', 'sshd(8), AUTHORIZED_KEYS FILE FORMAT', 'RFC 4253', 'Kali Linux Revealed, ch. 5'],
  };

  /* ------------------------------------------------------------ remote-scp */
  const SCPDIR = '/home/kali/practice/remote/scp';
  const hashes = (ev) => (outOf(ev).match(/^[0-9a-f]{64}(?=\s)/gm) || []);
  const scpLesson = {
    id: 'remote-scp',
    title: 'Copying files with scp',
    minutes: 11,
    objectives: [
      'Copy a file to a server and back with `scp`',
      'Copy a whole directory with `scp -r`',
      'Confirm that a copy is identical by comparing `sha256sum` on both ends',
    ],
    intro: T(
      '`scp` copies files over the same encrypted channel as ssh, with the same accounts and the same host key checks. You use it to put a tool or a script on a server and to bring back logs and output for your notes.',
      '',
      'Moving a file is not the same as knowing it arrived intact. A checksum answers that: if the SHA-256 of two files is equal, their contents are equal. On an engagement it also lets you show that the evidence you report is the file you collected. In this lesson you send a file to `web01` and back, and compare.'
    ),
    steps: [
      {
        id: 'workdir',
        prompt: T(
          'Make a working directory for this lesson and go into it:',
          '',
          '```',
          'mkdir -p ~/practice/remote/scp && cd ~/practice/remote/scp',
          '```'
        ),
        hint: 'Use `mkdir -p` and `cd`, joined with `&&`.',
        solution: 'mkdir -p ~/practice/remote/scp && cd ~/practice/remote/scp',
        check: { cwd: SCPDIR },
      },
      {
        id: 'sample',
        prompt: T(
          'Take a sample file to send. Copy the practice shift log into your working directory:',
          '',
          '```',
          'cp /usr/share/kalima/text/shift-log.txt .',
          '```'
        ),
        hint: 'Use `cp` with the source file and `.` as the destination.',
        solution: 'cp /usr/share/kalima/text/shift-log.txt .',
        check: { file: { path: SCPDIR + '/shift-log.txt', exists: true, type: 'file' } },
      },
      {
        id: 'upload',
        prompt: T(
          'Copy it to `web01`:',
          '',
          '```',
          'scp shift-log.txt student@web01.halcyon.lab:/tmp/shift-log.txt',
          '```',
          '',
          'The argument order is *source*, then *destination*, as with `cp`. A colon after the host separates it from the path on that host. Here the destination is `/tmp/shift-log.txt` on `web01`, a directory every user can write to. Answer the host key question and give the password if asked.',
          '',
          'scp prints one progress line per file: its name, the percentage, the size, the speed and the time.'
        ),
        hint: 'Syntax: `scp SOURCE USER@HOST:DESTINATION`.',
        solution: 'scp shift-log.txt student@web01.halcyon.lab:/tmp/shift-log.txt',
        input: SSHIN,
        check: { cmd: 'scp', argsRe: /shift-log\.txt\s+\S+@web01\S*:/, out: /shift-log\.txt\s+100%/, exit: 0 },
      },
      {
        id: 'download',
        prompt: T(
          'Now bring it back under a different name. Put the remote file first and the local name last:',
          '',
          '```',
          'scp student@web01.halcyon.lab:/tmp/shift-log.txt returned.txt',
          '```'
        ),
        hint: 'Same syntax, with source and destination swapped: the remote path comes first.',
        solution: 'scp student@web01.halcyon.lab:/tmp/shift-log.txt returned.txt',
        input: SSHIN,
        check: { cmd: 'scp', out: /shift-log\.txt\s+100%/, exit: 0, file: { path: SCPDIR + '/returned.txt', exists: true, type: 'file' } },
      },
      {
        id: 'local-hash',
        prompt: T(
          'Compare the two local files by their SHA-256 checksums:',
          '',
          '```',
          'sha256sum shift-log.txt returned.txt',
          '```',
          '',
          'Each line is a 64-character checksum followed by the file name. The checksums are equal when the files are identical, and a one-bit difference gives a completely different checksum.'
        ),
        hint: 'Give `sha256sum` both file names.',
        solution: 'sha256sum shift-log.txt returned.txt',
        check: { cmd: 'sha256sum', out: /returned\.txt/, fn: (ev) => { const h = hashes(ev); return h.length === 2; } },
      },
      {
        id: 'remote-hash',
        prompt: T(
          'That shows the file survived the round trip. To see what actually sits on the server, run `sha256sum` there:',
          '',
          '```',
          'ssh student@web01.halcyon.lab sha256sum /tmp/shift-log.txt',
          '```',
          '',
          'Compare the first characters of this checksum with the ones above.'
        ),
        hint: 'Use the `ssh user@host command` form with `sha256sum /tmp/shift-log.txt`.',
        solution: 'ssh student@web01.halcyon.lab sha256sum /tmp/shift-log.txt',
        input: SSHIN,
        check: { cmd: 'sha256sum', host: 'web01', out: /^[0-9a-f]{64}\s+\/tmp\/shift-log\.txt/m },
      },
      {
        id: 'same',
        prompt: 'Are the checksum on `web01` and the checksums of your two local files identical? Type yes or no.',
        hint: 'Compare the 64 characters of each. A copy that went wrong would show different checksums.',
        solution: 'yes',
        answer: ['yes', 'y', 'identical', 'they are identical', 'the same'],
      },
      {
        id: 'mkdir',
        prompt: T(
          'To copy a directory you need `-r`, for recursive. Prepare one first, with the log inside:',
          '',
          '```',
          'mkdir -p reports && cp shift-log.txt reports/',
          '```'
        ),
        hint: 'Create the directory `reports`, then copy `shift-log.txt` into it.',
        solution: 'mkdir -p reports && cp shift-log.txt reports/',
        check: { file: { path: SCPDIR + '/reports/shift-log.txt', exists: true, type: 'file' } },
      },
      {
        id: 'recursive',
        prompt: T(
          'Send the whole directory to `/tmp` on the server:',
          '',
          '```',
          'scp -r reports student@web01.halcyon.lab:/tmp/',
          '```',
          '',
          'Without `-r`, scp refuses to copy a directory and says `not a regular file`. When it works it lists every file inside. The trailing slash on `/tmp/` says that the destination is a directory, so `reports` is created inside it.'
        ),
        hint: 'Add `-r` before the source: `scp -r reports ...`.',
        solution: 'scp -r reports student@web01.halcyon.lab:/tmp/',
        input: SSHIN,
        check: { cmd: 'scp', args: ['-r'], out: /shift-log\.txt\s+100%/, exit: 0 },
      },
    ],
    quiz: [
      {
        q: 'What does `scp notes.txt student@web01.halcyon.lab:` do?',
        choices: [
          'Copies the file to the home directory of `student` on web01',
          'Copies it to `/tmp` on web01',
          'Fails, because a destination path is required',
          'Copies it to your own home directory',
        ],
        answer: 0,
        why: 'After the colon an empty path means the home directory of the account on the remote side.',
      },
      {
        q: 'You copy a 2 GB evidence file from a server and the checksum of your copy differs from the checksum on the server. What do you do?',
        choices: [
          'Use it anyway; one differing byte does not matter',
          'Copy it again and compare again, and do not report from the damaged copy',
          'Delete the file on the server',
          'Compare file sizes instead; they are the same thing',
        ],
        answer: 1,
        why: 'A different checksum means the contents differ, even if the size is equal. Evidence you cannot show to be intact is not evidence. Repeat the transfer.',
      },
      {
        q: 'Which command copies the file `/var/log/app.log` from web01 to your current directory?',
        choices: [
          'scp /var/log/app.log student@web01.halcyon.lab:.',
          'scp student@web01.halcyon.lab:/var/log/app.log .',
          'scp -r student@web01.halcyon.lab /var/log/app.log',
          'scp . student@web01.halcyon.lab:/var/log/app.log',
        ],
        answer: 1,
        why: 'The source comes first. The remote path has the `host:` prefix, and the local destination `.` is the current directory.',
      },
    ],
    refs: ['scp(1)', 'sha256sum(1)', 'ssh(1)', 'NIST SP 800-115', 'Kali Linux Revealed, ch. 5'],
  };

  /* ------------------------------------------------------------ remote-ftp */
  const FTPDIR = '/home/kali/practice/remote/ftp';
  const ftpLesson = {
    id: 'remote-ftp',
    title: 'Anonymous FTP, and why it is no longer trusted',
    minutes: 10,
    objectives: [
      'Log in to an anonymous FTP service, browse it and download a file',
      'Show that FTP commands and passwords travel as readable text',
      'Record a clear-text protocol as a finding in your engagement notes',
    ],
    intro: T(
      'FTP is one of the oldest file transfer protocols, and you will still meet it on printers, scanners, old servers and public download areas. A public FTP area that serves documents to anyone is a legitimate use of anonymous access.',
      '',
      'The protocol itself, however, sends everything unencrypted: commands, file contents and, on a normal login, the password. Anyone on the network path can read it. That is why SSH-based transfer (`scp`, `sftp`) replaced FTP for anything private. When an assessor finds FTP in use, it is written down. In this lesson you visit `files01.halcyon.lab`, which is within the scope in `~/engagement/scope.txt`, and look at what the protocol really says.'
    ),
    steps: [
      {
        id: 'workdir',
        prompt: T(
          'Make a working directory and go into it. Files you download land in the directory you were in when you started `ftp`:',
          '',
          '```',
          'mkdir -p ~/practice/remote/ftp && cd ~/practice/remote/ftp',
          '```'
        ),
        hint: 'Use `mkdir -p` and `cd`, joined with `&&`.',
        solution: 'mkdir -p ~/practice/remote/ftp && cd ~/practice/remote/ftp',
        check: { cwd: FTPDIR },
      },
      {
        id: 'session',
        prompt: T(
          'Start the FTP client:',
          '',
          '```',
          'ftp files01.halcyon.lab',
          '```',
          '',
          'The server greets you with a `220` line that names its software. Numbers at the start of a line are FTP reply codes: `331` means a password is needed, `230` means you are logged in.',
          '',
          'At `Name` type `anonymous`. At `Password` press Enter, or type any e-mail address, by convention. Then, at the `ftp>` prompt, type these commands one at a time:',
          '',
          '- `ls` to list the server\'s directory',
          '- `cd pub` to go into `pub`, the public area, and `ls` again',
          '- `get README.txt` to download a file into your current local directory',
          '- `bye` to leave',
          '',
          'You are done when `README.txt` is in `~/practice/remote/ftp`.'
        ),
        hint: 'Log in as `anonymous` with an empty password, `cd pub`, `get README.txt`, `bye`.',
        solution: 'ftp files01.halcyon.lab',
        input: ['anonymous', '', 'ls', 'cd pub', 'ls', 'get README.txt', 'bye'],
        check: { cmd: 'ftp', file: { path: FTPDIR + '/README.txt', exists: true, contains: /Halcyon Freight public FTP/ } },
      },
      {
        id: 'read',
        prompt: T(
          'Read what you downloaded:',
          '',
          '```',
          'cat README.txt',
          '```'
        ),
        hint: 'Use `cat README.txt` in the directory where you ran `ftp`.',
        solution: 'cat README.txt',
        check: { cmd: 'cat', out: /Anonymous access is read-only/ },
      },
      {
        id: 'readonly',
        prompt: 'The file names three directories under `pub/`. One of them holds the current rate card. Type its name.',
        hint: 'Look at the list in the file; the names are descriptive.',
        solution: 'rates',
        answer: /^(pub\/)?rates\/?$/,
      },
      {
        id: 'raw',
        prompt: T(
          'Now see what the client was saying. FTP commands are plain text lines, so you can talk to the server by hand with `nc` (netcat), which connects and passes through whatever you type. Control connections use port 21:',
          '',
          '```',
          'nc files01.halcyon.lab 21',
          '```',
          '',
          'Type these lines, pressing Enter after each:',
          '',
          '```',
          'USER anonymous',
          'PASS guest@example.com',
          'QUIT',
          '```',
          '',
          'Those are the very bytes the `ftp` client sent. The `PASS` line carries the password in the clear. For an anonymous login that costs nothing, but with a real account the password would be visible to everyone on the path, on every login.'
        ),
        hint: 'Connect with `nc files01.halcyon.lab 21`, then type the three lines. `QUIT` ends the session.',
        solution: 'nc -w 3 files01.halcyon.lab 21',
        input: ['USER anonymous', 'PASS guest@example.com', 'QUIT'],
        check: { cmd: ['nc', 'ncat', 'netcat'], out: /230 Login successful/ },
      },
      {
        id: 'which',
        prompt: 'In that exchange, which line did you type that would reveal a real user\'s secret if the account were not anonymous: `USER`, `PASS` or `QUIT`? Type the word.',
        hint: 'One of them carries the password.',
        solution: 'PASS',
        answer: ['pass', 'pass line'],
      },
      {
        id: 'note',
        prompt: T(
          'Write it down. A note records a finding while you remember the details, and it is what you will turn into a line of the report. Add one line to the engagement notes:',
          '',
          '```',
          'echo "files01 21/tcp FTP: anonymous read access, clear-text protocol" >> ~/engagement/notes.md',
          '```',
          '',
          '`>>` appends to the file instead of replacing it. A fuller note also records the date and the exact commands, so that anyone can repeat what you did. What you would recommend is moving any private transfer to SFTP or SCP and keeping FTP only for public, read-only content.'
        ),
        hint: 'Append a line mentioning `files01` and `FTP` to `~/engagement/notes.md` with `>>`.',
        solution: 'echo "files01 21/tcp FTP: anonymous read access, clear-text protocol" >> ~/engagement/notes.md',
        check: { line: />>\s*~?\/?\S*notes\.md/, file: { path: '/home/kali/engagement/notes.md', contains: /files01.*ftp/i } },
      },
    ],
    quiz: [
      {
        q: 'Why is anonymous FTP on a public download server less worrying than FTP with a login on an internal server?',
        choices: [
          'Anonymous FTP is encrypted',
          'Nothing secret crosses the wire: no real password and only public files',
          'FTP is safe when it uses port 21',
          'Anonymous users cannot read files',
        ],
        answer: 1,
        why: 'Plain text is the problem only when the content is sensitive. A real password or private file sent over FTP can be read by anyone who can capture the traffic. Public documents and an e-mail address as password cannot hurt.',
      },
      {
        q: 'An assessor finds a server where staff log in with FTP. What goes in the notes?',
        choices: [
          'Nothing, because FTP is a normal service',
          'The host, the port, the observation that logins are in clear text, and the commands used to see it',
          'The staff passwords, so the client can check them',
          'A recommendation to disable the firewall',
        ],
        answer: 1,
        why: 'A finding needs the evidence and the way to reproduce it. Passwords are handled with care and normally not copied into a report. The fix is to move to an encrypted protocol such as SFTP.',
      },
      {
        q: 'Which tools replace FTP for private file transfer?',
        choices: [
          '`telnet` and `nc`',
          '`scp` and `sftp`, which run over SSH',
          '`ping` and `traceroute`',
          '`ftp` with the option `-p`',
        ],
        answer: 1,
        why: 'Both run inside the encrypted SSH channel, so commands, passwords and file contents are protected, and the server is authenticated by its host key.',
      },
    ],
    refs: ['ftp(1)', 'nc(1)', 'RFC 959', 'RFC 4251', 'NIST SP 800-115'],
  };

  K.lessons.register({
    id: 'remote',
    title: 'Remote access and file transfer',
    order: 90,
    summary: 'Log in to servers with ssh, use keys instead of passwords, copy files with scp, and recognize the clear-text FTP protocol for what it is.',
    lessons: [sshLesson, keysLesson, scpLesson, ftpLesson],
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
