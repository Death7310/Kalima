/* Kalima — curriculum module "perms": users, permissions and privilege.
 *
 * Lessons: perms-users, perms-read, perms-change, perms-sudo. Practice files
 * are seeded read-only under /usr/share/kalima/perms (files and directories
 * with a spread of modes and owners, for reading) and
 * /usr/share/kalima/templates (files the learner copies to ~/practice/perms
 * and changes). Checks test what a line printed or the state it left behind.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const PERMS = '/usr/share/kalima/perms';
  const TEMPLATES = '/usr/share/kalima/templates';
  const WORK = '/home/kali/practice/perms';
  /** What a line printed, as trimmed non-empty lines. */
  const linesOf = (ev) => K.util.stripAnsi(ev.output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  /** stat of a path on the Kali machine, or null. */
  const statOf = (path) => { try { return K.kali.vfs.stat(path); } catch (e) { return null; } };

  /* ------------------------------------------------------------ practice files */
  K.fsSeeds.push((machine) => {
    if (machine.profile !== 'kali') return;
    const vfs = machine.vfs;
    let mtime = Date.UTC(2026, 9, 26, 9, 12);
    try { mtime = vfs.stat('/usr/share/kalima/README').mtime; } catch (e) { /* content pack not loaded: keep the default */ }
    const adm = machine.groupByName && machine.groupByName('adm');
    const admGid = adm ? adm.gid : 4;
    const file = (path, text, mode, gid) => vfs.seed(path, text, { mode, uid: 0, gid: gid || 0, mtime });

    vfs.seedDir(PERMS, { mode: 0o755, mtime });
    file(PERMS + '/handbook.txt', T(
      'Halcyon Freight - depot handbook (extract)',
      '',
      '1. Sign in at the gatehouse at the start of every shift.',
      '2. Scanners go back on their docks before handover.',
      '3. Report a damaged pallet to the shift lead before it is moved.',
      ''), 0o644);
    file(PERMS + '/audit.log', T(
      '2026-11-12 06:02:11 gate opened by badge 0417',
      '2026-11-12 07:20:45 scanner SC-14 sync failed',
      '2026-11-12 08:30:02 forklift FL-3 locked out after failed pre-use check',
      '2026-11-12 16:20:31 forklift FL-3 released by badge 0288',
      '2026-11-12 22:00:09 gate closed by badge 0417',
      ''), 0o640, admGid);
    file(PERMS + '/payroll.csv', T(
      'employee,grade,monthly_gbp',
      'G. Pollard,3,2450',
      'R. Okafor,4,2710',
      'S. Whitlock,2,2180',
      ''), 0o600);
    file(PERMS + '/backup.sh', T(
      '#!/bin/sh',
      '# Nightly copy of the depot records. In the training lab it only prints a message.',
      'echo "backup: nothing to copy in the training lab"',
      ''), 0o755);
    file(PERMS + '/lobby/welcome.txt', T(
      'Welcome to the depot office share.',
      'Ask the shift lead for the name of the file you need.',
      ''), 0o644);
    vfs.seedDir(PERMS + '/lobby', { mode: 0o711, mtime });
    file(PERMS + '/archive/rota-2025.csv', T(
      'week,shift_lead',
      '2025-W51,G. Pollard',
      '2025-W52,R. Okafor',
      ''), 0o644);
    vfs.seedDir(PERMS + '/archive', { mode: 0o700, mtime });

    vfs.seedDir(TEMPLATES, { mode: 0o755, mtime });
    file(TEMPLATES + '/checklist.sh', T(
      '#!/bin/sh',
      '# Pre-flight check: run it before any testing and read what it prints.',
      'echo "Operator: $(whoami) on $(hostname)"',
      'echo "Scope file: $HOME/engagement/scope.txt"',
      'echo "Test only what the scope file lists."',
      ''), 0o644);
    file(TEMPLATES + '/findings.txt', T(
      'Engagement HF-LAB-2026-11 - working notes (draft)',
      '',
      '- 10.10.10.10 web01: the web server banner shows its version',
      '- 10.10.10.20 files01: file shares to review with the client',
      '',
      'Client-confidential. Do not share outside the engagement team.',
      ''), 0o644);
  });

  /* ----------------------------------------------------------------- users */
  const usersLesson = {
    id: 'perms-users',
    title: 'Who you are: users and groups',
    minutes: 10,
    objectives: [
      'Find out which user you are and which groups you belong to with `whoami`, `id` and `groups`',
      'Read the seven fields of a line in `/etc/passwd`',
      'Tell accounts for people from system accounts by their UID and login shell',
      'Look up users and groups by name or number with `getent`',
    ],
    intro: T(
      'Every file and every running program on Linux belongs to a user. What you may read, change or run is decided by who you are and which groups you are in. Before you can make sense of a permission, or of a command that was refused, you need to know how the system identifies you.',
      '',
      'The same knowledge works in the other direction. The account list of a machine tells you who and what is meant to be on it, which makes it one of the first things to read on a system you have been asked to review.'
    ),
    steps: [
      {
        id: 'whoami',
        prompt: T(
          'Start with the simplest question. Ask the system which user you are:',
          '',
          '```',
          'whoami',
          '```',
          '',
          'It prints one word, your user name. The prompt shows the same name, but a prompt is only decoration and can be configured to show anything. `whoami` asks the system.'
        ),
        hint: 'Type `whoami` and press Enter.',
        solution: 'whoami',
        check: { cmd: ['whoami', 'id', 'logname'], out: /^kali\s*$/m },
      },
      {
        id: 'id',
        prompt: T(
          'A name is for people. The system works with numbers, and with groups as well as users. `id` shows all of it:',
          '',
          '```',
          'id',
          '```',
          '',
          'Read the line in three parts. `uid=1000(kali)` is your user id with the name in brackets. `gid=1000(kali)` is your primary group, which new files you create will belong to. `groups=` lists every group you are a member of, each as a number with its name.'
        ),
        hint: 'Type `id` with no arguments.',
        solution: 'id',
        check: { cmd: 'id', out: /uid=1000\(kali\) gid=1000\(kali\) groups=/ },
      },
      {
        id: 'sudo-gid',
        prompt: 'Look at the `groups=` part of that output. What is the numeric id of the group `sudo`?',
        hint: 'Each group is written as a number followed by the name in brackets. Find `(sudo)` and read the number in front of it.',
        solution: '27',
        answer: /^(gid\s*=?\s*)?27$/i,
      },
      {
        id: 'groups',
        prompt: T(
          'When you only want the names, `groups` is shorter:',
          '',
          '```',
          'groups',
          '```',
          '',
          'Group membership is how Linux hands out abilities without sharing passwords. Two of these matter soon: members of `sudo` may run commands as the administrator, and members of `adm` may read many of the system logs.'
        ),
        hint: 'Type `groups` with no arguments.',
        solution: 'groups',
        check: { cmd: ['groups', 'id'], out: /^(kali : )?kali\b.*\bsudo\b/m },
      },
      {
        id: 'passwd-line',
        prompt: T(
          'User accounts are listed in the text file `/etc/passwd`, one account per line. Print the line for your own account. The `^` ties the pattern to the start of the line, where the name is:',
          '',
          '```',
          'grep \'^kali:\' /etc/passwd',
          '```',
          '',
          'The line has seven fields separated by colons:',
          '',
          '- the user name',
          '- `x`, a placeholder: the password hash is kept in `/etc/shadow`, which ordinary users cannot read',
          '- the user id (UID)',
          '- the id of the primary group (GID)',
          '- a comment, usually the full name',
          '- the home directory',
          '- the login shell, the program started when the user logs in'
        ),
        hint: 'Type the command as shown, with the pattern in single quotes.',
        solution: 'grep \'^kali:\' /etc/passwd',
        check: { fn: (ev) => { const l = linesOf(ev); return l.length === 1 && /^kali:x:1000:1000:/.test(l[0]); } },
      },
      {
        id: 'shell-field',
        prompt: 'Read the last field of the line you just printed. What is the login shell of the user `kali`? Give the full path.',
        hint: 'The seventh field is everything after the last colon.',
        solution: '/usr/bin/zsh',
        answer: /^\/usr\/bin\/zsh$/,
      },
      {
        id: 'all-accounts',
        prompt: T(
          'Now look at the whole file:',
          '',
          '```',
          'cat /etc/passwd',
          '```',
          '',
          'Scroll through it: more than a dozen accounts, and almost none of them is a person. Most are *system accounts* such as `www-data` or `sshd`. They exist so that each service runs under its own identity with its own, limited rights. Nobody logs in as them: their shell is `/usr/sbin/nologin`, a program that refuses politely and exits.',
          '',
          'The numbers follow a convention. `root`, the administrator, is always UID 0. System accounts get UIDs below 1000, and accounts for people start at 1000. The account `nobody`, at 65534, is a deliberate exception: an identity with as few rights as possible.'
        ),
        hint: '`cat` followed by the path of the file.',
        solution: 'cat /etc/passwd',
        check: { fn: (ev) => { const l = linesOf(ev); return l.length >= 17 && l.some((x) => /^root:x:0:0:/.test(x)) && l.some((x) => /^www-data:x:33:/.test(x)) && l.some((x) => /^kali:x:1000:/.test(x)); } },
      },
      {
        id: 'shells',
        prompt: T(
          'A quick way to see who could log in is to count the login shells. The shell is field 7, and the fields are separated by colons.',
          '',
          'Build a pipeline that prints each login shell found in `/etc/passwd` with the number of accounts that use it: cut the field out, sort the result, and count the groups with `uniq -c`.'
        ),
        hint: 'Three stages joined by `|`: `cut -d : -f 7 /etc/passwd`, then `sort`, then `uniq -c`.',
        solution: 'cut -d : -f 7 /etc/passwd | sort | uniq -c',
        check: { fn: (ev) => { const l = linesOf(ev); return l.filter((x) => /^\d+ \/usr\/sbin\/nologin$/.test(x)).length === 1 && l.filter((x) => /^\d+ \/usr\/bin\/zsh$/.test(x)).length === 1; } },
      },
      {
        id: 'getent',
        prompt: T(
          'File listings and logs sometimes show a number where you expect a name. `getent` looks an entry up in the system\'s account database, by name or by number. Find out which account has UID 33:',
          '',
          '```',
          'getent passwd 33',
          '```',
          '',
          'The answer has the same seven fields as a line of `/etc/passwd`. The difference is where it comes from: `getent` asks the same lookup service the system itself uses. On this workstation that is the local file, but in an organization it often includes a central directory, and `getent` then finds accounts that are in no local file at all.'
        ),
        hint: 'The first argument names the database, `passwd`. The second is the name or number to look up.',
        solution: 'getent passwd 33',
        check: { cmd: 'getent', fn: (ev) => { const l = linesOf(ev); return l.length === 1 && /^www-data:x:33:33:/.test(l[0]); } },
      },
      {
        id: 'group-sudo',
        prompt: T(
          'Groups have a database of their own, called `group`. Its lines have four fields: the group name, a placeholder, the group id, and the list of members.',
          '',
          'Use `getent` to print the entry for the group `sudo`, and read off who is allowed to act as administrator on this machine.'
        ),
        hint: 'Same shape as the previous command, with `group` as the database and `sudo` as the key.',
        solution: 'getent group sudo',
        check: { fn: (ev) => { const l = linesOf(ev); return l.length === 1 && /^sudo:x:27:(.*,)?kali(,.*)?$/.test(l[0]); } },
      },
    ],
    quiz: [
      {
        q: 'A line in `/etc/passwd` reads `backup:x:34:34:backup:/var/backups:/usr/sbin/nologin`. What does the last field tell you?',
        choices: [
          'The account has no password',
          'Nobody can open a login session as this account: its shell refuses and exits',
          'The account was locked after too many failed logins',
          'It is the program that makes the backups',
        ],
        answer: 1,
        why: 'The seventh field is the login shell. `nologin` prints a short refusal and exits, so the account can own files and run a service but cannot be used to log in.',
      },
      {
        q: 'What does the `x` in the second field of an `/etc/passwd` line mean?',
        choices: [
          'The account is disabled',
          'The password is the letter x',
          'The password hash is stored elsewhere, in `/etc/shadow`',
          'The account has no password',
        ],
        answer: 2,
        why: '`/etc/passwd` must be readable by everyone so that programs can turn ids into names. The hashes were moved to `/etc/shadow`, which only root and the group `shadow` may read.',
      },
      {
        q: 'On Kali, as on Debian, you create a second account for a colleague with `adduser`. Which UID will it most likely get?',
        choices: ['0', '101', '1001', '65534'],
        answer: 2,
        why: 'Accounts for people are numbered from 1000 upward, and 1000 is already taken by `kali`. UID 0 is root, numbers below 1000 are for system accounts, and 65534 is `nobody`.',
      },
      {
        q: 'A log file can be read only by its owner `root` and by the group `adm`. Which command tells you whether your account can read it?',
        choices: ['`whoami`', '`id`', '`getent passwd 0`', '`cat /etc/passwd`'],
        answer: 1,
        why: '`id` lists every group you belong to, and membership of `adm` is what decides here. `whoami` gives only your name, and `/etc/passwd` records only each user\'s primary group.',
      },
    ],
    refs: ['id(1)', 'groups(1)', 'passwd(5)', 'group(5)', 'getent(1)', 'Kali Linux Revealed, ch. 3'],
  };

  /* ------------------------------------------------------------------ read */
  const READERS = ['cat', 'head', 'tail', 'less', 'more', 'grep', 'nl', 'tac'];

  const readLesson = {
    id: 'perms-read',
    title: 'Reading permissions',
    minutes: 10,
    objectives: [
      'Read the type, permissions, owner and group of a file from `ls -l`',
      'Work out which of the three permission classes applies to you, and predict whether an access will be allowed',
      'Convert between the letter form and the octal form of a mode, and read both from `stat`',
      'Explain what read, write and execute mean on a directory',
    ],
    intro: T(
      'Permissions decide which accounts may read, change or run each file. They are the reason a web server cannot read your notes, and the reason you cannot read its private key.',
      '',
      'On a security workstation you read permissions all the time: to understand why a command was refused, to check that your own notes and keys are private, and to judge whether a system you are reviewing protects what it should. This lesson is about reading only. Nothing in it changes a file.'
    ),
    steps: [
      {
        id: 'list',
        prompt: T(
          'Move to a practice directory that holds files with a spread of permissions, and list it in long format:',
          '',
          '```',
          'cd /usr/share/kalima/perms',
          'ls -l',
          '```',
          '',
          'Skip the `total` line. Every other line describes one entry. Take `audit.log` and read it from left to right:',
          '',
          '- `-rw-r-----` is the type and the permissions',
          '- `1` is the number of names the file has, which rarely matters',
          '- `root` is the owner, a user',
          '- `adm` is the group',
          '- then come the size in bytes, the time of the last change, and the name',
          '',
          'The very first character is the type: `-` for an ordinary file, `d` for a directory.',
          '',
          'The commands in this lesson assume you stay in this directory.'
        ),
        hint: 'Run the two commands in order. The option is a lower-case L, for *long*.',
        solution: 'cd /usr/share/kalima/perms; ls -l',
        check: { cmd: 'ls', out: /-rw-r-----\s+\d+\s+root\s+adm\s.*audit\.log/, all: [{ out: /drwx--x--x\s.*lobby/ }, { out: /payroll\.csv/ }] },
      },
      {
        id: 'types',
        prompt: 'Look at the first character of each line in that listing. How many of the six entries are directories?',
        hint: 'Count the lines that begin with `d`.',
        solution: '2',
        answer: /^(2|two)(\s+(directories|entries))?\.?$/i,
      },
      {
        id: 'classes',
        prompt: T(
          'After the type come nine characters, in three groups of three. The first group is for the **owner**, the second for members of the file\'s **group**, and the third for everyone else, called **other**.',
          '',
          'In each group the positions mean `r` read, `w` write and `x` execute, always in that order. A `-` means that permission is not granted. So for `audit.log`, `rw-` lets the owner `root` read and write, `r--` lets members of `adm` read, and `---` gives everyone else nothing.',
          '',
          'Now read `handbook.txt` the same way. Which one of the three classes may change its contents: owner, group or other?'
        ),
        hint: 'Find the `w` in `-rw-r--r--`. It appears in only one of the three groups.',
        solution: 'owner',
        answer: /^(the\s+)?(owner|user|root|u)\.?$/i,
      },
      {
        id: 'group-read',
        prompt: T(
          'Which group of three applies to *you*? The system takes the first that fits. If you are the owner, the owner permissions apply. If not, and you are a member of the file\'s group, the group permissions apply. Otherwise the permissions for other apply.',
          '',
          'You are `kali`, not `root`, so the owner permissions of `audit.log` are not yours. But `kali` is a member of `adm`, so the group permissions `r--` apply, and reading should be allowed. Check the prediction:',
          '',
          '```',
          'cat audit.log',
          '```',
          '',
          'The file prints. Nothing about the file itself says `kali`. Membership of a group was enough.'
        ),
        hint: '`cat` followed by the file name. Run it as yourself, without `sudo`.',
        solution: 'cat audit.log',
        check: { cmd: READERS, user: 'kali', out: /gate opened by badge 0417/, exit: 0 },
      },
      {
        id: 'denied',
        prompt: T(
          'Now a file where no class helps you. `payroll.csv` shows `-rw-------`, with owner `root` and group `root`. You are not the owner and not in that group, so the last three characters apply to you: `---`. Predict what happens, then try:',
          '',
          '```',
          'cat payroll.csv',
          '```',
          '',
          '`Permission denied` is not a malfunction. It is the system doing its job, and it tells you something: the file is there, and your account is not meant to read it.'
        ),
        hint: 'Run it as shown and read the error message. The step completes when the refusal appears.',
        solution: 'cat payroll.csv',
        check: { user: 'kali', out: /payroll\.csv.*Permission denied/ },
      },
      {
        id: 'octal',
        prompt: T(
          'Permissions are often written as three digits instead of nine letters. Each permission has a value: `r` is 4, `w` is 2 and `x` is 1. Add up the values in each group of three and you get one digit for the owner, one for the group and one for other.',
          '',
          'For `audit.log`: `rw-` is 4+2 = 6, `r--` is 4, and `---` is 0, so the mode is `640`.',
          '',
          '`backup.sh` shows `rwxr-xr-x`. What is that as three digits?'
        ),
        hint: '`rwx` is 4+2+1. `r-x` is 4+1.',
        solution: '755',
        answer: /^0?755$/,
      },
      {
        id: 'stat',
        prompt: T(
          '`stat` prints everything the system records about a file, including the mode in both forms:',
          '',
          '```',
          'stat audit.log',
          '```',
          '',
          'Find the line that starts with `Access: (`. It reads `0640/-rw-r-----`, the digits and the letters side by side, followed by the owner as `Uid:` and the group as `Gid:`, each with its number and its name. The extra `0` in front of `640` is a fourth digit for special permissions, which you will meet in a later lesson.'
        ),
        hint: '`stat` followed by the file name.',
        solution: 'stat audit.log',
        check: { cmd: 'stat', out: /Access: \(0640\/-rw-r-----\)\s+Uid: \(\s*0\/\s*root\)\s+Gid: \(\s*4\/\s*adm\)/ },
      },
      {
        id: 'shadow',
        prompt: T(
          'Apply this to a real system file. `/etc/shadow` holds the password hashes of every account on the machine, so its permissions matter.',
          '',
          'Run `stat` on `/etc/shadow` and read the `Access:` line. Apart from the owner, which group is allowed to read the file?'
        ),
        hint: '`stat /etc/shadow`. The group is the name inside the brackets after `Gid:`.',
        solution: 'shadow',
        answer: /^(the\s+)?(group\s+)?shadow(\s+group)?\.?$/i,
      },
      {
        id: 'dir',
        prompt: T(
          'Directories have the same nine characters, but they mean something a little different, because a directory is a list of names:',
          '',
          '- `r` lets you list the names in it',
          '- `w` lets you create, delete and rename entries in it',
          '- `x` lets you enter it and reach the things inside',
          '',
          'When you name a directory, `ls -l` lists what is inside it. To see the line for the directory itself, add `-d`:',
          '',
          '```',
          'ls -ld lobby archive',
          '```',
          '',
          'Compare the two. For other, `archive` grants nothing at all, while `lobby` grants `x` without `r`.'
        ),
        hint: 'Add `d` to the options: `ls -ld` followed by the two directory names.',
        solution: 'ls -ld lobby archive',
        check: { cmd: 'ls', args: ['-d'], out: /drwx--x--x\s.*lobby/, all: [{ out: /drwx------\s.*archive/ }] },
      },
      {
        id: 'through',
        prompt: T(
          'What can you do with `x` but not `r` on a directory? You cannot list it: `ls lobby` is refused, and you may try it to see. But `x` lets you pass *through* the directory to a name you already know.',
          '',
          'The directory `lobby` contains a file called `welcome.txt`. Print it.'
        ),
        hint: 'Give `cat` the path through the directory: `lobby/welcome.txt`. No `sudo` is needed.',
        solution: 'cat lobby/welcome.txt',
        check: { cmd: READERS, user: 'kali', out: /Welcome to the depot office share/, exit: 0 },
      },
    ],
    quiz: [
      {
        q: 'The directory `archive` shows `drwx------ root root`. Inside it is `rota-2025.csv` with mode `-rw-r--r--`. What happens when `kali` runs `cat archive/rota-2025.csv`?',
        choices: [
          'The file prints, because its own mode lets everyone read it',
          'Permission denied, because without `x` on the directory nothing inside it can be reached',
          'No such file or directory',
          'It prints nothing and reports success',
        ],
        answer: 1,
        why: 'To open a file you need `x` on every directory along its path. The file\'s own permissions are only considered once you can get to it.',
      },
      {
        q: 'A file has mode `640`, owner `root` and group `adm`. The user `maya` is a member of `adm`. What may she do with the file?',
        choices: ['Nothing', 'Read it, but not change it', 'Read it and change it', 'Read it, change it and run it'],
        answer: 1,
        why: 'She is not the owner but is in the group, so the middle digit applies. 4 is read only.',
      },
      {
        q: 'Which octal mode is the same as `rw-rw-r--`?',
        choices: ['`644`', '`664`', '`662`', '`774`'],
        answer: 1,
        why: '`rw-` is 4+2 = 6 for the owner and again for the group, and `r--` is 4 for other.',
      },
      {
        q: 'A file belongs to user `kali` and group `kali` and shows `----rw----`. Can `kali` read it?',
        choices: [
          'Yes, through the group permissions',
          'Yes, an owner can always read their own files',
          'No: `kali` is the owner, so only the owner permissions `---` are used',
          'Only after logging out and in again',
        ],
        answer: 2,
        why: 'The system uses the first class that fits and looks no further. The owner could change the mode to get access back, but as it stands the read is refused.',
      },
    ],
    refs: ['ls(1)', 'stat(1)', 'path_resolution(7)', 'The Linux Command Line (W. Shotts), ch. 9'],
  };

  /* ---------------------------------------------------------------- change */
  const KALI_UID = 1000;
  const modeOf = (name) => { const st = statOf(WORK + '/' + name); return st ? st.mode & 0o7777 : -1; };
  const ownedBy = (name, uid, gid) => { const st = statOf(WORK + '/' + name); return !!st && st.uid === uid && (gid == null || st.gid === gid); };

  const changeLesson = {
    id: 'perms-change',
    title: 'Changing permissions and ownership',
    minutes: 12,
    objectives: [
      'Make a script executable and run it',
      'Set permissions with `chmod` in both the symbolic and the octal form',
      'Change the owner and group of a file with `chown` and `chgrp`, and say when that needs root',
      'Explain how the umask decides the permissions of new files',
    ],
    intro: T(
      'Reading permissions tells you what is allowed. Changing them is how you make a script runnable, keep client notes away from other accounts, and take back files that a tool running as root left behind. All three come up in the first week of real work.',
      '',
      'You will practice on copies in `~/practice/perms`. One rule runs through the whole lesson: grant what the task needs, to the accounts that need it, and nothing more.'
    ),
    steps: [
      {
        id: 'setup',
        prompt: T(
          'Set up a working directory with two practice files in it:',
          '',
          '```',
          'mkdir -p ~/practice/perms',
          'cd ~/practice/perms',
          'rm -f checklist.sh findings.txt scan.txt',
          'cp /usr/share/kalima/templates/* .',
          '```',
          '',
          'The `rm -f` clears away leftovers from an earlier run of this lesson and stays silent if there are none. Then `cp` copies a small script and a file of notes. Run `ls -l` and you will see that both copies belong to you and start as `-rw-r--r--`.',
          '',
          'Because you own them, you may change their permissions. Only the owner of a file, or root, can do that.'
        ),
        hint: 'Run the four commands in order. The step completes when fresh copies of both files are in `~/practice/perms` and you are in that directory.',
        solution: 'mkdir -p ~/practice/perms && cd ~/practice/perms && rm -f checklist.sh findings.txt scan.txt && cp /usr/share/kalima/templates/* .',
        check: {
          cwd: WORK,
          fn: () => ownedBy('checklist.sh', KALI_UID) && (modeOf('checklist.sh') & 0o111) === 0 &&
            ownedBy('findings.txt', KALI_UID) && (modeOf('findings.txt') & 0o077) !== 0 && !statOf(WORK + '/scan.txt'),
        },
      },
      {
        id: 'refused',
        prompt: T(
          '`checklist.sh` is a short shell script. To run a program that is not in one of the system\'s program directories, you give its path. `./` means *in the current directory*:',
          '',
          '```',
          './checklist.sh',
          '```',
          '',
          'The shell refuses with `permission denied`. The content of the file is fine. What is missing is the execute permission: `-rw-r--r--` has no `x` in any of its three groups, so nobody may run this file as a program.'
        ),
        hint: 'Type `./checklist.sh` exactly, with the dot and the slash. The step completes when you see the refusal.',
        solution: './checklist.sh',
        check: { out: /permission denied.*checklist\.sh|checklist\.sh.*permission denied/i, fn: () => (modeOf('checklist.sh') & 0o100) === 0 },
      },
      {
        id: 'exec',
        prompt: T(
          '`chmod` changes permissions. Its symbolic form reads like a short sentence with three parts: *who* (`u` for the owner, `g` for the group, `o` for other, `a` for all three), an *operator* (`+` adds, `-` removes, `=` sets exactly), and the *permission* (`r`, `w` or `x`).',
          '',
          'Give the owner, and only the owner, the right to execute the script. Then run it again:',
          '',
          '```',
          'chmod u+x checklist.sh',
          './checklist.sh',
          '```',
          '',
          'This time the script runs and prints three lines. `ls -l checklist.sh` now shows `-rwxr--r--`.'
        ),
        hint: '`u+x` means: for the user who owns the file, add execute. Run `chmod` first, then the script.',
        solution: 'chmod u+x checklist.sh && ./checklist.sh',
        check: { out: /Operator: kali on /, exit: 0, fn: () => (modeOf('checklist.sh') & 0o100) !== 0 },
      },
      {
        id: 'private',
        prompt: T(
          '`findings.txt` holds working notes about a client. With `-rw-r--r--`, every account on this machine can read them. Take the read permission away from the group and from other in one command:',
          '',
          '```',
          'chmod go-r findings.txt',
          '```',
          '',
          'Check with `ls -l findings.txt`: the mode is now `-rw-------`. The symbolic form changed only what you named. The owner\'s `rw-` was left as it was.'
        ),
        hint: '`go-r` means: for group and other, remove read.',
        solution: 'chmod go-r findings.txt',
        check: { cmd: 'chmod', fn: () => (modeOf('findings.txt') & 0o077) === 0 && (modeOf('findings.txt') & 0o600) === 0o600 },
      },
      {
        id: 'octal',
        prompt: T(
          'The octal form states all nine permissions at once, as the three digits you learned to read: 4 for `r`, 2 for `w`, 1 for `x`, added up for owner, group and other.',
          '',
          'Suppose your team lead decides that members of your group should be able to read the notes after all. Owner read and write is 6, group read is 4, other nothing is 0:',
          '',
          '```',
          'chmod 640 findings.txt',
          '```',
          '',
          '`ls -l findings.txt` shows `-rw-r-----`. Unlike the symbolic form, the octal form replaces everything, so you never need to know what the mode was before.'
        ),
        hint: 'Three digits, then the file name.',
        solution: 'chmod 640 findings.txt',
        check: { cmd: 'chmod', fn: () => modeOf('findings.txt') === 0o640 },
      },
      {
        id: 'octal-own',
        prompt: T(
          'Now work out a mode yourself. Set `checklist.sh` so that:',
          '',
          '- the owner may read, write and run it',
          '- members of the group may read and run it',
          '- everyone else may do nothing',
          '',
          'Use the octal form, then confirm the result with `ls -l checklist.sh`.'
        ),
        hint: 'Add up 4, 2 and 1 for the owner, 4 and 1 for the group, and use 0 for other.',
        solution: 'chmod 750 checklist.sh',
        check: { cmd: 'chmod', fn: () => modeOf('checklist.sh') === 0o750 },
      },
      {
        id: 'root-file',
        prompt: T(
          'Ownership is the other half of the picture. Many security tools need root and are started with `sudo`, which runs one command as root after asking for *your* password (in this lab it is `kali`). Any file such a command creates belongs to root. See it happen:',
          '',
          '```',
          'sudo touch scan.txt',
          'ls -l scan.txt',
          '```',
          '',
          'The new file shows `root root`. For you it is read-only: you are neither its owner nor in its group, so `r--` for other applies. This is a common surprise after running a tool with `sudo` in your own directory.'
        ),
        hint: 'Run both commands. If `ls -l` shows that `scan.txt` already belongs to `kali`, it is left over from an earlier run: remove it with `rm scan.txt` and start this step again.',
        solution: 'sudo touch scan.txt && ls -l scan.txt',
        input: ['kali'],
        check: { fn: () => ownedBy('scan.txt', 0) },
      },
      {
        id: 'chown',
        prompt: T(
          '`chown` changes the owner of a file. Only root may do that, even for a file in your own directory, so it needs `sudo` as well. Take the file back:',
          '',
          '```',
          'sudo chown kali scan.txt',
          '```',
          '',
          'Look at it again with `ls -l scan.txt`. The owner is now `kali`, but the group is still `root`.'
        ),
        hint: 'The new owner comes first, then the file. `sudo` goes in front of the whole command.',
        solution: 'sudo chown kali scan.txt',
        input: ['kali'],
        check: { cmd: ['chown', 'chgrp'], fn: () => ownedBy('scan.txt', KALI_UID) },
      },
      {
        id: 'chgrp',
        prompt: T(
          '`chgrp` changes the group of a file and is used the same way: the new group, then the file. The owner of a file may hand it to any group they are a member of, so now that the file is yours you do not need `sudo` for this.',
          '',
          'Set the group of `scan.txt` to `kali`.',
          '',
          'For next time: `sudo chown kali:kali scan.txt` would have set the owner and the group in one command.'
        ),
        hint: '`chgrp`, the group name, the file name.',
        solution: 'chgrp kali scan.txt',
        check: { cmd: ['chgrp', 'chown'], fn: () => ownedBy('scan.txt', KALI_UID, KALI_UID) },
      },
      {
        id: 'umask',
        prompt: T(
          'One question is left: why did all your new files start as `-rw-r--r--`? A new file starts from `666` and a new directory from `777`, and the shell\'s *umask* names the permissions to leave out. Print it:',
          '',
          '```',
          'umask',
          '```',
          '',
          'The value is `022`, which some shells print with an extra zero in front as `0022`. The digits line up with owner, group and other: leave out nothing for the owner, and `w` (2) for group and for other. That turns `666` into `644` for files and `777` into `755` for directories.'
        ),
        hint: 'Type `umask` with no arguments.',
        solution: 'umask',
        check: { cmd: 'umask', out: /^0?[0-7]{3}\s*$/m },
      },
    ],
    quiz: [
      {
        q: 'A file in your directory `~/practice/perms` (`drwxr-xr-x kali kali`) belongs to root and has mode `644`. Can `kali` delete it without `sudo`?',
        choices: [
          'No, only the owner of a file may delete it',
          'No, deleting needs write permission on the file',
          'Yes, deleting changes the directory, and `kali` has write permission on the directory',
          'Yes, but only after `chmod 777` on the file',
        ],
        answer: 2,
        why: 'A directory is a list of names, and removing a name needs `w` and `x` on the directory, not on the file. `rm` asks for confirmation first, because the file is write-protected.',
      },
      {
        q: 'Which command has the same effect as `chmod 644 notes.txt`?',
        choices: [
          '`chmod u+rw notes.txt`',
          '`chmod u=rw,go=r notes.txt`',
          '`chmod a+r notes.txt`',
          '`chmod go-w notes.txt`',
        ],
        answer: 1,
        why: 'The octal form sets all nine permissions, and `=` does the same for the classes it names. The other three only add or remove something and leave the rest as it was.',
      },
      {
        q: 'With a umask of `077`, which mode does a newly created file get?',
        choices: ['`600`', '`644`', '`700`', '`077`'],
        answer: 0,
        why: 'A new file starts from `666`, and the umask removes every permission for group and other, which leaves `600`. A umask like this suits accounts that handle confidential material.',
      },
      {
        q: 'Your script answers `permission denied` when you run `./tidy.sh`, and `ls -l` shows `-rw-r--r-- kali kali`. Which fix grants the least?',
        choices: [
          '`chmod 777 tidy.sh`',
          '`sudo ./tidy.sh`',
          '`chmod u+x tidy.sh`',
          '`sudo chown root tidy.sh`',
        ],
        answer: 2,
        why: '`u+x` adds exactly the missing permission for exactly one account. `777` would also let every account rewrite the script, and `sudo` does not help because no execute permission is set for anyone.',
      },
    ],
    refs: ['chmod(1)', 'chown(1)', 'chgrp(1)', 'umask(2)', 'The Linux Command Line (W. Shotts), ch. 9'],
  };

  K.lessons.register({
    id: 'perms',
    title: 'Users, permissions and privilege',
    order: 30,
    summary: 'Know who you are on the system, read and set file permissions with confidence, and use root privilege only for the commands that need it.',
    lessons: [usersLesson, readLesson, changeLesson],
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
