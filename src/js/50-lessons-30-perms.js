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

  /* ------------------------------------------------------------------ sudo */
  const sudoLesson = {
    id: 'perms-sudo',
    title: 'Privilege: sudo, su and special permissions',
    minutes: 12,
    objectives: [
      'Read `Permission denied` as information, and find its cause before asking for more privilege',
      'Run one command as root with `sudo`, and list what you are allowed to do with `sudo -l`',
      'Explain how `su` differs from `sudo`, and what the setuid and sticky permissions are for',
      'Work with least privilege: borrow root for the command that needs it and give it back',
    ],
    intro: T(
      'The account `root` may do anything on a Linux system: read every file, stop every program, erase the disk. Kali used to log you in as root. Since 2020 it starts you as an ordinary user, `kali`, for the reason every other system does: a typing mistake made as root can destroy the machine, and a faulty or hostile program run as root gets the whole system instead of one account.',
      '',
      'This lesson shows how privilege is meant to be used: borrowed for one command when a task needs it, and handed back straight away.'
    ),
    steps: [
      {
        id: 'denied',
        prompt: T(
          'Begin with a refusal. `/etc/shadow` stores the password hashes of every account. Try to read it as yourself:',
          '',
          '```',
          'cat /etc/shadow',
          '```',
          '',
          '`Permission denied`. Read the message as information, not as an obstacle: the file exists, and the account you are using is not meant to read it. The reflex to repeat the command with more privilege is one to unlearn. First find out why you were refused.'
        ),
        hint: 'Run the command as shown, without `sudo`. The step completes when the refusal appears.',
        solution: 'cat /etc/shadow',
        check: { user: 'kali', out: /\/etc\/shadow.*Permission denied/ },
      },
      {
        id: 'why',
        prompt: T(
          'The reason is in the long listing:',
          '',
          '```',
          'ls -l /etc/shadow',
          '```',
          '',
          'It shows `-rw-r-----` with owner `root` and group `shadow`. The owner may read and write, members of `shadow` may read, and everyone else gets nothing. You are `kali`, and `shadow` is not one of your groups, so the last class applies to you.',
          '',
          'The system is working as designed. Password hashes are exactly what should stay out of reach of everyday accounts and of the programs they run.'
        ),
        hint: '`ls -l` followed by the path of the file.',
        solution: 'ls -l /etc/shadow',
        check: { any: [
          { cmd: 'ls', out: /-rw-r-----\s+\d+\s+root\s+shadow\s.*\/etc\/shadow/ },
          { cmd: 'stat', out: /0640\/-rw-r-----\)[^\n]*root\)[^\n]*shadow\)/ },
        ] },
      },
      {
        id: 'sudo',
        prompt: T(
          'When a task really does need root, borrow root\'s identity for that one command. `sudo` runs the command that follows it as root. It asks for *your* password, not root\'s. In this lab your password is `kali`.',
          '',
          '```',
          'sudo whoami',
          '```',
          '',
          'The answer is `root`: for the length of that one command you were the administrator. Run `whoami` on its own and you are `kali` again.',
          '',
          'sudo also records each use in the system log, with your name and the command, so there is a trace of what was done with root\'s power and by whom.'
        ),
        hint: 'Put `sudo` in front of the command. Type your own password when it asks.',
        solution: 'sudo whoami',
        input: ['kali'],
        check: { cmd: ['whoami', 'id'], user: 'root', out: /^root\s*$|uid=0\(root\)/m },
      },
      {
        id: 'shadow-line',
        prompt: T(
          'Now use `sudo` for the task that was refused, and ask for no more than you need: print only the first line of `/etc/shadow`, not the whole file.',
          '',
          'When it works, look at the second field of the line, between the first two colons. For `root` it holds `!` where a password hash would be, and no password can ever match that. On this machine nobody can log in as root with a password.'
        ),
        hint: '`head -n 1` prints the first line of a file. Put `sudo` in front of the whole command.',
        solution: 'sudo head -n 1 /etc/shadow',
        input: ['kali'],
        check: { cmd: READERS, user: 'root', fn: (ev) => { const l = linesOf(ev); return l.some((x) => /^root:[^:]*:\d+:\d*:\d*:\d*:/.test(x)) && !l.some((x) => /^(daemon|kali):/.test(x)); } },
      },
      {
        id: 'list',
        prompt: T(
          'What exactly are you allowed to do with sudo? Ask it to list your privileges:',
          '',
          '```',
          'sudo -l',
          '```',
          '',
          'Read the last line: `(ALL : ALL) ALL`. The part in brackets names the users and groups you may act as, and the final `ALL` names the commands you may run. This account may do anything, because it is a member of the group `sudo`.',
          '',
          'On a well-run server you will often find the opposite: an account that may run one or two named commands as root and nothing else.'
        ),
        hint: 'The option is a lower-case L, for *list*.',
        solution: 'sudo -l',
        input: ['kali'],
        check: { cmd: 'sudo', out: /may run the following commands/ },
      },
      {
        id: 'su',
        prompt: T(
          'There is an older tool, `su`, short for *substitute user*. With no name after it, it means root. Try it, and type `kali` when it asks for a password:',
          '',
          '```',
          'su',
          '```',
          '',
          '`Authentication failure`. The difference from sudo is whose password is wanted: `su` asks for the password of the account you are switching *to*, and you have just seen that root has none here.',
          '',
          'Where `su` does work, it also behaves differently. It starts a new shell in which every command runs as root until you type `exit`. sudo limits privilege to one command and leaves one log entry for it, which is why Kali and most current systems are built around sudo.'
        ),
        hint: 'Type `su`, press Enter, then type `kali` at the `Password:` prompt. The refusal is the expected result.',
        solution: 'su',
        input: ['kali'],
        check: { cmd: 'su', out: /Authentication failure/ },
      },
      {
        id: 'setuid',
        prompt: T(
          'How can sudo make you root at all, when it is a program that you start as `kali`? Look at its permissions, and at those of `passwd`, the program for changing your own password:',
          '',
          '```',
          'ls -l /usr/bin/sudo /usr/bin/passwd',
          '```',
          '',
          'Both show `-rwsr-xr-x` and belong to root. The `s` in the place of the owner\'s `x` is the *setuid* permission: whoever starts the program, it runs with the identity of the file\'s owner. That is how `passwd` can update `/etc/shadow`, a file you cannot even read.',
          '',
          'This is a design, not a loophole. Instead of opening the file to everyone, the system lets everyone run one carefully written program that makes only the change it should. Because such a program acts as root for anybody, a system should have few of them, and listing them is a routine part of a security review.'
        ),
        hint: '`ls -l` followed by the two paths.',
        solution: 'ls -l /usr/bin/sudo /usr/bin/passwd',
        check: { cmd: 'ls', out: /^-rwsr-xr-x\s+\d+\s+root\s+root\s.*\bpasswd\s*$/m, all: [{ out: /^-rwsr-xr-x\s+\d+\s+root\s+root\s.*\bsudo\s*$/m }] },
      },
      {
        id: 'setuid-octal',
        prompt: T(
          'In octal, special permissions such as setuid are written as a fourth digit in front of the usual three.',
          '',
          '`stat` has a format option, `-c %a`, that prints nothing but the octal mode. Use it on `/usr/bin/passwd`. What does it print?'
        ),
        hint: '`stat -c %a /usr/bin/passwd`. The first digit of the answer stands for setuid.',
        solution: '4755',
        answer: /^0?4755$/,
      },
      {
        id: 'sticky',
        prompt: T(
          'One more special permission protects shared space. `/tmp` is a directory in which every account may create files. Look at the directory itself:',
          '',
          '```',
          'ls -ld /tmp',
          '```',
          '',
          'It shows `drwxrwxrwt`: read, write and execute for everyone, with a `t` in the last position. Write permission on a directory normally lets you delete any entry in it, which here would let every account delete the temporary files of every other account.',
          '',
          'The `t`, the *sticky* permission, closes that gap. In a sticky directory only the owner of a file, the owner of the directory, or root may delete or rename it. In octal it is the leading 1 of `1777`.'
        ),
        hint: 'Use `-d` so that `ls` shows the directory itself and not its contents.',
        solution: 'ls -ld /tmp',
        check: { any: [
          { cmd: 'ls', out: /drwxrwxrwt\s.*\btmp\/?\s*$/m },
          { cmd: 'stat', out: /1777\/drwxrwxrwt/ },
        ] },
      },
      {
        id: 'forget',
        prompt: T(
          'After a successful sudo, further sudo commands in the same terminal do not ask for your password again for a few minutes. That is convenient, and it also means that an unattended terminal has root within reach. When you have finished the privileged part of a job, or before you step away, tell sudo to forget:',
          '',
          '```',
          'sudo -k',
          '```',
          '',
          'It prints nothing. The next sudo command will ask for your password again.',
          '',
          'The habits of this lesson fit in four lines:',
          '',
          '- work as yourself, and add `sudo` only to the command that needs it',
          '- when you are refused, find out why before you reach for more privilege',
          '- never widen permissions, for example with `chmod 777`, to make an error go away',
          '- do not keep a root shell open for convenience'
        ),
        hint: 'The option is a lower-case `k`.',
        solution: 'sudo -k',
        check: { cmd: 'sudo', exit: 0, fn: () => !K.kali.sudoStamp || K.kali.sudoStamp.kali == null },
      },
    ],
    quiz: [
      {
        q: '`cat /etc/shadow` answers `Permission denied`. What is the best first reaction?',
        choices: [
          'Put `sudo` in front of every command from now on, to avoid further errors',
          'Look at the owner, group and mode of the file with `ls -l`, and decide whether the task really needs root',
          'Run `sudo chmod 644 /etc/shadow` so that the file can be read',
          'Assume the file is damaged and restore it from a backup',
        ],
        answer: 1,
        why: 'The refusal is the system protecting something. Understanding why tells you whether root is really needed, and then one command with `sudo` is enough. Loosening the mode of `/etc/shadow` would expose every password hash to every account.',
      },
      {
        q: 'Which password does each tool ask for?',
        choices: [
          '`su` asks for your own password, `sudo` for the password of root',
          '`su` asks for the password of the account you switch to, `sudo` for your own',
          'Both ask for the password of root',
          'Both ask for your own password',
        ],
        answer: 1,
        why: '`su` needs the target account\'s password, so everyone who uses it must know the root password. `sudo` checks who you are and what you are permitted, so no root password has to be shared, or even to exist.',
      },
      {
        q: 'root creates `/tmp/report.txt` with mode `644`. `/tmp` shows `drwxrwxrwt`. Can `kali` delete the file?',
        choices: [
          'Yes, because everyone has write permission on `/tmp`',
          'Yes, but only with `rm -f`',
          'No: in a sticky directory only the owner of the file, the owner of the directory or root may delete it',
          'No, because the file itself is not writable by `kali`',
        ],
        answer: 2,
        why: 'Without the `t`, write permission on the directory would be enough to delete any entry. The sticky permission restricts deleting and renaming to the owners and root. The file\'s own mode plays no part in deletion.',
      },
      {
        q: '`/usr/bin/passwd` shows `-rwsr-xr-x root root`. What does the `s` mean when `kali` runs the program?',
        choices: [
          '`kali` becomes root in that terminal until logging out',
          'The program runs with the identity of its owner, root, which lets it update `/etc/shadow`',
          'Only root is allowed to run the program',
          'The program will ask for the password of root',
        ],
        answer: 1,
        why: 'Setuid applies to that one program for as long as it runs. `passwd` uses root\'s rights to change one entry in `/etc/shadow` and then exits. Your shell stays what it was.',
      },
    ],
    refs: ['sudo(8)', 'sudoers(5)', 'su(1)', 'shadow(5)', 'chmod(1)', 'NIST SP 800-53 Rev. 5, AC-6 (Least Privilege)'],
  };

  K.lessons.register({
    id: 'perms',
    title: 'Users, permissions and privilege',
    order: 30,
    summary: 'Know who you are on the system, read and set file permissions with confidence, and use root privilege only for the commands that need it.',
    lessons: [usersLesson, readLesson, changeLesson, sudoLesson],
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
