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

  K.lessons.register({
    id: 'perms',
    title: 'Users, permissions and privilege',
    order: 30,
    summary: 'Know who you are on the system, read and set file permissions with confidence, and use root privilege only for the commands that need it.',
    lessons: [usersLesson],
  });

  void WORK; void statOf;
})(typeof globalThis !== 'undefined' ? globalThis : this);
