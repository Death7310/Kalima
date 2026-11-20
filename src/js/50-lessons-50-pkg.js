/* Kalima — curriculum module "pkg": packages and keeping Kali current.
 *
 * Lessons: pkg-update, pkg-install, pkg-inspect. They use the simulated apt
 * and dpkg and need no practice files. Because the app does not reset the
 * machine between lessons, every check tests the state a step leaves behind
 * (what is installed, what is still waiting to be upgraded) or what the line
 * printed, and the one question whose answer depends on that state reads the
 * state instead of assuming a fresh machine.
 *
 * Steps where apt asks "Continue? [Y/n]" after sudo give a testSolution that
 * runs `sudo -k` first: the headless replay cannot know whether sudo still
 * remembers the password, and the answer to the wrong prompt would abort.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const APT = ['apt', 'apt-get'];
  /** What a line printed, without colour codes. */
  const outOf = (ev) => K.util.stripAnsi(ev.output || '');

  /** Number of installed packages with a newer version waiting, or null before the machine exists. */
  const pending = () => {
    const m = K.kali;
    if (!m || !m.packages || !m.state || !m.state.admin) return null;
    const up = m.state.admin.upgradable || {};
    return Object.keys(up).filter((n) => { const p = m.packages.get(n); return !!p && p.status === 'installed' && up[n] !== p.version; }).length;
  };
  const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

  /* ---------------------------------------------------------------- update */
  const updateLesson = {
    id: 'pkg-update',
    title: 'Keeping Kali current',
    minutes: 10,
    objectives: [
      'Read `/etc/apt/sources.list.d/kali.sources` and say where this system gets its packages',
      'Refresh the package lists with `sudo apt update` and read its summary line',
      'List the upgrades that are waiting with `apt list --upgradable`',
      'Upgrade with `sudo apt full-upgrade` and explain why Kali documents that command',
    ],
    intro: T(
      'Kali is a *rolling* distribution based on Debian testing. There is no big yearly release to wait for: new versions of tools and security fixes flow into one suite, `kali-rolling`, all the time. A version such as 2026.3 only names the installer image, a snapshot of that suite on the day the image was built.',
      '',
      'A workstation that has fallen weeks behind is missing fixes, and its tools may behave differently from the documentation you are reading. Updating takes two commands, and each tells you what it is about to do before it does it. A good habit is to update before an engagement starts and not in the middle of one, so that your tools stay the same from the first result to the last.'
    ),
    steps: [
      {
        id: 'release',
        prompt: T(
          'First confirm what you are sitting at. Every modern Linux system describes itself in one small file:',
          '',
          '```',
          'cat /etc/os-release',
          '```',
          '',
          'Three lines matter here. `PRETTY_NAME` says *Rolling*. `VERSION_ID` is the image this machine was installed from. `ID_LIKE=debian` tells you the family: Kali is built on Debian, so software arrives as Debian packages and is managed with `apt`.'
        ),
        hint: 'Print the file `/etc/os-release` with `cat`.',
        solution: 'cat /etc/os-release',
        check: { any: [{ out: /VERSION_CODENAME=kali-rolling/ }, { cmd: 'lsb_release', out: /kali-rolling/ }] },
      },
      {
        id: 'sources',
        prompt: T(
          'Where do those packages come from? `apt` reads the answer from a file:',
          '',
          '```',
          'cat /etc/apt/sources.list.d/kali.sources',
          '```',
          '',
          'Each line is a field name, a colon and a value:',
          '',
          '- `Types: deb` asks for ready-built packages.',
          '- `URIs` is the address of the Kali mirror service.',
          '- `Suites: kali-rolling` is the stream of packages this system follows.',
          '- `Components` are sections of the archive, sorted by license.',
          '- `Signed-By` names the key file `apt` uses to check that what it downloads really was published by Kali.',
          '',
          'The address begins with plain `http`. That is deliberate: `apt` does not trust the connection, it trusts the signature.'
        ),
        hint: 'Use `cat` on `/etc/apt/sources.list.d/kali.sources`. Tab completion saves typing the long path.',
        solution: 'cat /etc/apt/sources.list.d/kali.sources',
        check: { out: /Suites:\s*kali-rolling/ },
      },
      {
        id: 'components',
        prompt: 'Look at the `Components` line again. How many components does it list?',
        hint: 'Count the words after `Components:`. They are separated by spaces, and `non-free-firmware` is one word.',
        solution: '4',
        answer: /^(4|four)( components?)?\.?$/i,
      },
      {
        id: 'update',
        prompt: T(
          'Your system keeps its own copy of the list of packages the mirror offers. That copy goes stale. Refresh it:',
          '',
          '```',
          'sudo apt update',
          '```',
          '',
          'It needs `sudo` because the lists are stored in a system directory; without it you get `Permission denied`. The password is `kali`.',
          '',
          'Read the output from the top. A line that starts with `Get:` is a list that was downloaded, and `Hit:` means your copy was already current. The last line is the summary: how many installed packages have a newer version waiting.',
          '',
          '`apt update` installs nothing. It only learns what is available.'
        ),
        hint: 'Type `sudo apt update` and give the password `kali` when asked.',
        solution: 'sudo apt update',
        input: ['kali'],
        check: { cmd: APT, args: ['update'], user: 'root', exit: 0, out: /Reading package lists/ },
      },
      {
        id: 'count',
        prompt: 'Read the last line that `sudo apt update` printed. How many packages can be upgraded? If the line says that all packages are up to date, answer `0`.',
        hint: 'The last line reads either `N packages can be upgraded. Run \'apt list --upgradable\' to see them.` or `All packages are up to date.` Run `sudo apt update` again if it has scrolled away.',
        // the right number depends on whether this machine has been upgraded already
        get solution() { const n = pending(); return String(n == null ? 7 : n); },
        answer: {
          test(text) {
            const n = pending(); const want = n == null ? 7 : n;
            const t = String(text).trim().toLowerCase().replace(/\s+packages?\.?$/, '').replace(/\.$/, '');
            if (/^\d+$/.test(t)) return parseInt(t, 10) === want;
            if (want === 0 && /^(none|no)$/.test(t)) return true;
            return NUMBER_WORDS.indexOf(t) === want;
          },
        },
      },
      {
        id: 'list',
        prompt: T(
          'The summary gave you a number. Now see the names:',
          '',
          '```',
          'apt list --upgradable',
          '```',
          '',
          'No `sudo` this time, because looking changes nothing. Each line reads: package name, a slash and the suite, the **new** version, the architecture, and in brackets the version you have now. Comparing the two versions tells you how big the step is.',
          '',
          'If this machine is already up to date, you see only `Listing... Done`.'
        ),
        hint: 'The command is `apt list` with the option `--upgradable`.',
        solution: 'apt list --upgradable',
        check: { cmd: 'apt', args: ['list', '--upgradable'], exit: 0, out: /Listing/ },
      },
      {
        id: 'upgrade',
        prompt: T(
          'Now install the new versions:',
          '',
          '```',
          'sudo apt full-upgrade',
          '```',
          '',
          'Before it changes anything, `apt` shows its plan. Read the `Summary` lines: how many packages it will upgrade, install and remove, and how much it will download. Then it asks `Continue? [Y/n]`. Answer `y`. If nothing is waiting, the summary shows zeros and `apt` simply finishes.',
          '',
          'Why `full-upgrade` and not `upgrade`? In a rolling distribution packages are sometimes renamed, split or replaced. `apt upgrade` never removes a package, so it holds back every upgrade that would need a removal and can leave you with a mix of old and new. `full-upgrade` is allowed to remove a package when the upgrade requires it. That is the command the Kali documentation gives, and it is why you read the `Removing` count before you say yes.'
        ),
        hint: 'Type `sudo apt full-upgrade`, read the summary, and answer `y` at the `Continue?` question.',
        solution: 'sudo apt full-upgrade',
        testSolution: ['sudo -k', 'sudo apt full-upgrade'],
        input: ['kali', 'y'],
        check: { cmd: APT, argsRe: /(^|\s)(full|dist)-upgrade(\s|$)/, user: 'root', exit: 0, fn: () => pending() === 0 },
      },
      {
        id: 'confirm',
        prompt: T(
          'Check the result instead of assuming it. Ask `apt` once more whether anything is waiting to be upgraded. You have used two commands in this lesson that can tell you; either one will do.',
          '',
          'You are looking for `All packages are up to date.` or for a list with no packages in it.'
        ),
        hint: '`apt list --upgradable` prints the waiting upgrades, and `sudo apt update` ends with a summary line.',
        solution: 'apt list --upgradable',
        input: ['kali'],
        check: {
          any: [
            { cmd: 'apt', args: ['list', '--upgradable'], exit: 0, fn: (ev) => /Listing/.test(outOf(ev)) && !/upgradable from/.test(outOf(ev)) },
            { cmd: APT, args: ['update'], user: 'root', exit: 0, out: /All packages are up to date/ },
          ],
        },
      },
      {
        id: 'history',
        prompt: T(
          '`apt` keeps a record of every change it makes. Read the end of it:',
          '',
          '```',
          'tail /var/log/apt/history.log',
          '```',
          '',
          'Each entry has the start time, the exact command line, who requested it, what was upgraded (old version, then new) and the end time. When a tool behaves differently from last week, this file tells you whether it changed and when. It is worth a line in your engagement notes whenever you upgrade during a job.'
        ),
        hint: 'Use `tail` on the file `/var/log/apt/history.log`.',
        solution: 'tail /var/log/apt/history.log',
        check: { cmd: ['tail', 'cat', 'less', 'more', 'head', 'grep', 'tac'], argsRe: /\/var\/log\/apt\/history\.log|(^|\s)history\.log/, exit: 0 },
      },
    ],
    quiz: [
      {
        q: 'You run `sudo apt update` and its last line says that 12 packages can be upgraded. What has changed on the system at this point?',
        choices: [
          'The 12 packages have been upgraded',
          'The 12 packages have been downloaded and will be installed at the next restart',
          'Only the local lists of available packages were refreshed; nothing was installed',
          'Nothing at all; `apt update` only prints a report',
        ],
        answer: 2,
        why: '`apt update` downloads fresh package lists and compares them with what is installed. Installing the new versions is a separate step, `sudo apt full-upgrade`.',
      },
      {
        q: 'Why does the Kali documentation tell you to upgrade with `apt full-upgrade` and not with `apt upgrade`?',
        choices: [
          '`apt upgrade` only works on Debian stable',
          '`full-upgrade` may remove a package when an upgrade requires it, while `upgrade` holds such upgrades back and can leave the system half-updated',
          '`full-upgrade` also refreshes the package lists first',
          '`full-upgrade` is faster because it skips the confirmation question',
        ],
        answer: 1,
        why: 'In a rolling distribution packages are regularly renamed or replaced. `apt upgrade` never removes anything, so it skips those upgrades; `full-upgrade` carries them out. Neither command refreshes the lists, and both ask before they act.',
      },
      {
        q: 'You have not run `apt update` for a month. `apt list --upgradable` prints only `Listing... Done`. Can you conclude that the system is current?',
        choices: [
          'Yes, an empty list always means there is nothing newer',
          'No. The list is compared with the local copy of the package lists, and that copy is a month old',
          'No, because `apt list` needs `sudo` to see upgrades',
          'Yes, because `apt list` contacts the mirror by itself',
        ],
        answer: 1,
        why: '`apt list` reads only the lists stored on your machine. Until `sudo apt update` refreshes them, `apt` cannot know what the mirror has published since.',
      },
      {
        q: 'A colleague types `apt update` and gets `Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)`. What is the cause?',
        choices: [
          'The mirror is unreachable',
          'Another package manager is running',
          'The command was run without `sudo`, and an ordinary user may not write the package lists',
          'The file `kali.sources` is damaged',
        ],
        answer: 2,
        why: 'The package lists live under `/var/lib/apt/lists`, which only root may write. Error 13, permission denied, points to missing privilege, not to the network.',
      },
    ],
    refs: ['apt(8)', 'sources.list(5)', 'apt-secure(8)', 'os-release(5)', 'Kali Linux Revealed, ch. 8 (Debian Package Management)'],
  };

  /* --------------------------------------------------------------- install */
  /** 'installed', 'config-files' (removed, configuration kept) or 'none' for a package on the Kali machine. */
  const pkgState = (name) => {
    const p = K.kali && K.kali.packages ? K.kali.packages.get(name) : null;
    return p ? p.status : 'none';
  };
  const hasFile = (path) => { try { return !!K.kali.vfs.stat(path); } catch (e) { return false; } };

  const installLesson = {
    id: 'pkg-install',
    title: 'Finding, installing and removing software',
    minutes: 12,
    objectives: [
      'Find a package with `apt search` and read its record with `apt show`',
      'Install and remove a package with `sudo apt install` and `sudo apt remove`, reading the plan before you confirm',
      'Explain what `purge` deletes that `remove` leaves behind, and what `autoremove` cleans up',
      'Recognize what the shell tells you when a command is not installed',
    ],
    intro: T(
      'On Kali you do not download installers from websites. Software comes as *packages* from the Kali repository, and one tool, `apt`, finds them, installs them together with everything they need, and removes them again without leaving loose ends. Because every package is signed by Kali, this is also the safe way to add a tool.',
      '',
      'In this lesson you take one small, harmless package, `tree`, through its whole life: look it up, remove it, see what the shell says when it is missing, and put it back. The workstation ends the lesson as it started.'
    ),
    steps: [
      {
        id: 'search',
        prompt: T(
          'You want a tool that prints a folder as a tree, to paste into your engagement notes. Ask `apt` what it has:',
          '',
          '```',
          'apt search tree',
          '```',
          '',
          '`apt search` looks for your word in package names and descriptions. Each hit takes two lines. The first is the package name, a slash and the suite, the version and the architecture; `[installed]` at the end means you already have it. The second line is a one-line description.',
          '',
          'A real mirror holds tens of thousands of packages, so real searches return long lists. Add a second word to narrow them down: `apt` shows only packages that match every word.'
        ),
        hint: 'Type `apt search` followed by the word `tree`. Searching needs no `sudo`.',
        solution: 'apt search tree',
        check: { cmd: ['apt', 'apt-cache'], args: ['search'], exit: 0, out: /^tree(\/| - )/m },
      },
      {
        id: 'show',
        prompt: T(
          'A one-line description is not much to go on. Read the full record before you install anything:',
          '',
          '```',
          'apt show tree',
          '```',
          '',
          'The fields worth reading every time:',
          '',
          '- `Version` is what you would get.',
          '- `Depends` lists the other packages this one needs. `apt` installs them for you.',
          '- `Download-Size` and `Installed-Size` say what it costs in bandwidth and disk.',
          '- `APT-Sources` shows which repository it comes from.',
          '- `Description` says what it does.'
        ),
        hint: '`apt show` takes a package name: `apt show tree`.',
        solution: 'apt show tree',
        check: { cmd: ['apt', 'apt-cache'], args: ['show', 'tree'], exit: 0, out: /^Package: tree$/m },
      },
      {
        id: 'remove',
        prompt: T(
          'This workstation already has `tree`, so begin the cycle at the other end and remove it:',
          '',
          '```',
          'sudo apt remove tree',
          '```',
          '',
          'The password is `kali`. `apt` does not act straight away. It prints its plan: the packages under `REMOVING`, a `Summary` line with the counts, and the disk space that will be freed. Then it asks `Continue? [Y/n]`. Read the plan first, every time, and answer `y` only if it lists what you expect. A capital letter in `[Y/n]` marks the answer you get by pressing Enter.',
          '',
          'If `apt` answers that `tree` is not installed, an earlier visit to this lesson left it removed. Carry on with the next step.'
        ),
        hint: 'Type `sudo apt remove tree`, check that the plan lists only `tree`, then answer `y`.',
        solution: 'sudo apt remove tree',
        testSolution: ['sudo -k', 'sudo apt remove tree'],
        input: ['kali', 'y'],
        check: {
          any: [
            { cmd: APT, argsRe: /(^|\s)(remove|purge)\s(.*\s)?tree(\s|$)/, user: 'root', exit: 0, fn: () => pkgState('tree') !== 'installed' && !hasFile('/usr/bin/tree') },
            { cmd: 'dpkg', argsRe: /(^|\s)(-r|--remove|-P|--purge)\s(.*\s)?tree(\s|$)/, user: 'root', exit: 0, fn: () => pkgState('tree') !== 'installed' && !hasFile('/usr/bin/tree') },
          ],
        },
      },
      {
        id: 'missing',
        prompt: T(
          'Now run the program you just removed:',
          '',
          '```',
          'tree',
          '```',
          '',
          'The shell cannot find it, and on Kali it does more than say so: it looks the name up and tells you which package provides the command and how to install it. You will meet this message whenever a guide uses a tool your system does not have.',
          '',
          'A name that no package provides gets only a plain `command not found`. That usually means a typing mistake.'
        ),
        hint: 'Type `tree` on its own and press Enter. An error message is the expected result here.',
        solution: 'tree',
        check: { exit: 127, out: /Command 'tree' not found, but can be installed with/ },
      },
      {
        id: 'purge',
        prompt: T(
          '`remove` deletes the program but keeps the package\'s system-wide configuration files, so that your settings are still there if you install it again. `purge` deletes those as well:',
          '',
          '```',
          'sudo apt purge tree',
          '```',
          '',
          'Look for the line `Purging configuration files for tree`. That is the part `remove` left behind.',
          '',
          'Use `remove` when you may want the tool back as you had it, and `purge` when you want a clean slate, for example before reinstalling something you have misconfigured. Neither touches files in your home directory.'
        ),
        hint: 'The same shape as before, with `purge` in place of `remove`: `sudo apt purge tree`.',
        solution: 'sudo apt purge tree',
        testSolution: ['sudo -k', 'sudo apt purge tree'],
        input: ['kali', 'y'],
        check: {
          any: [
            { cmd: APT, argsRe: /(^|\s)(purge|autopurge|--purge)(\s|$)/, user: 'root', exit: 0, fn: () => pkgState('tree') === 'none' },
            { cmd: 'dpkg', argsRe: /(^|\s)(-P|--purge)\s(.*\s)?tree(\s|$)/, user: 'root', exit: 0, fn: () => pkgState('tree') === 'none' },
          ],
        },
      },
      {
        id: 'install',
        prompt: T(
          'Put `tree` back. The shell gave you the command two steps ago.',
          '',
          'Read the plan as you did before. This time the package is under `Installing`, and the summary shows the download size and the disk space needed. If `apt` asks whether to continue, answer `y`. Then watch it work: `Get:` downloads the package, `Unpacking` puts its files in place and `Setting up` configures it.'
        ),
        hint: 'Installing is `sudo apt install` followed by the package name.',
        solution: 'sudo apt install tree',
        testSolution: ['sudo -k', 'sudo apt install tree'],
        input: ['kali', 'y'],
        check: { cmd: APT, args: ['install'], user: 'root', exit: 0, fn: () => pkgState('tree') === 'installed' && hasFile('/usr/bin/tree') },
      },
      {
        id: 'run',
        prompt: 'Check that the installation worked by using the tool: print your engagement folder, `~/engagement`, as a tree. The last line of its output counts the directories and files.',
        hint: 'Give `tree` the folder as its argument: `tree ~/engagement`.',
        solution: 'tree ~/engagement',
        check: { cmd: 'tree', exit: 0, out: /\d+ director(y|ies), \d+ files?/ },
      },
      {
        id: 'simulate',
        prompt: T(
          'You can ask `apt` for its plan without letting it act. The option `-s` means *simulate*:',
          '',
          '```',
          'apt install -s nginx',
          '```',
          '',
          '`nginx` is a web server that is not installed here. Nothing is downloaded or changed, which is why this works without `sudo`.',
          '',
          'The plan has a section you have not seen yet, `Installing dependencies`: packages you did not ask for but that `nginx` needs. The lines that start with `Inst` and `Conf` are the steps `apt` would carry out. Simulating first is a careful way to find out how much a package would pull in.'
        ),
        hint: 'Type `apt install -s nginx`. There is no `sudo` and no question to answer.',
        solution: 'apt install -s nginx',
        check: { cmd: APT, args: ['install'], exit: 0, out: /^Inst nginx /m, fn: () => pkgState('nginx') !== 'installed' },
      },
      {
        id: 'dependency',
        prompt: 'Read the plan from the last step. Which package would be installed as a dependency of `nginx`?',
        hint: 'Look at the line under the heading `Installing dependencies:`.',
        solution: 'nginx-common',
        answer: /^nginx-common\.?$/i,
      },
      {
        id: 'autoremove',
        prompt: T(
          'Packages that arrive as dependencies are marked *automatic*. When you later remove the package that needed them, they stay behind. One command finds automatic packages that nothing needs any more and offers to remove them:',
          '',
          '```',
          'sudo apt autoremove',
          '```',
          '',
          'Read the `Summary` line. On a tidy system it says `Removing: 0` and `apt` stops there. When it does list packages, read the names before you agree: you are confirming a removal like any other.'
        ),
        hint: 'Type `sudo apt autoremove` and read the `Removing` count in the summary.',
        solution: 'sudo apt autoremove',
        testSolution: ['sudo -k', 'sudo apt autoremove'],
        input: ['kali', 'y'],
        check: { cmd: APT, argsRe: /(^|\s)(autoremove|autopurge|--auto-remove|--autoremove)(\s|$)/, user: 'root', exit: 0, out: /Removing: \d+|\d+ to remove/ },
      },
    ],
    quiz: [
      {
        q: 'You installed a web server package, which brought two dependencies with it, and later ran `sudo apt remove` on the web server. What is still on the system?',
        choices: [
          'Nothing: `remove` also deletes dependencies and configuration',
          'The web server\'s system-wide configuration files, and the two dependencies until you run `sudo apt autoremove`',
          'Only the two dependencies; the configuration files are deleted',
          'The whole package, switched off but still installed',
        ],
        answer: 1,
        why: '`remove` deletes the program and keeps its configuration; `purge` would delete that too. Dependencies that were installed automatically stay until `autoremove` clears those that nothing needs.',
      },
      {
        q: 'On a freshly installed machine you type `nmap` and the shell answers `Command \'nmap\' not found, but can be installed with: sudo apt install nmap`. What does that tell you?',
        choices: [
          'The `nmap` package is installed but damaged',
          '`nmap` may only be run with `sudo`',
          'No program of that name is installed, and a package called `nmap` provides it',
          'The network is down, so `nmap` cannot start',
        ],
        answer: 2,
        why: 'The shell found no program called `nmap` in the directories it searches. Kali then looked the name up in its package lists and named the package that would provide it.',
      },
      {
        q: 'As the ordinary user `kali`, without `sudo`, you run `apt install -s wireshark`. What happens?',
        choices: [
          'Permission denied, because installing needs root',
          '`apt` prints the plan, including dependencies, and changes nothing',
          'The package is downloaded but not installed',
          'The package is installed for the user `kali` only',
        ],
        answer: 1,
        why: '`-s` asks for a simulation. `apt` works out and prints what it would do, then stops. Since nothing is changed, no root privilege is needed.',
      },
      {
        q: 'You used a tool for a while and it saved its settings in `~/.config`. Then you run `sudo apt purge` on its package. What happens to those settings?',
        choices: [
          'They are deleted, because `purge` removes all configuration',
          'They are moved to `/etc`',
          'They stay: `purge` removes the package\'s system-wide configuration, never files in a home directory',
          'They are kept only if you answer `n` at the prompt',
        ],
        answer: 2,
        why: 'The package manager only manages files the package itself installed or registered. What a program writes into your home directory while you use it is yours, and you delete it yourself.',
      },
    ],
    refs: ['apt(8)', 'apt-get(8)', 'apt-cache(8)', 'dpkg(1)', 'Kali Linux Revealed, ch. 8 (Debian Package Management)'],
  };

  /* --------------------------------------------------------------- inspect */
  const DPKG = ['dpkg', 'dpkg-query'];
  const linesOf = (ev) => outOf(ev).split('\n').map((l) => l.trim()).filter(Boolean);

  const inspectLesson = {
    id: 'pkg-inspect',
    title: 'Which package is this? Inspecting what is installed',
    minutes: 12,
    objectives: [
      'List installed packages and their versions with `dpkg -l`',
      'Find the package that owns a file with `dpkg -S`, and the files a package installed with `dpkg -L`',
      'Compare the installed version of a package with the version on offer using `apt-cache policy`',
      'Explain what a metapackage is and how Kali uses metapackages to group its tools',
    ],
    intro: T(
      'Everything `apt` installs is recorded in a database kept by `dpkg`, the lower-level tool that `apt` drives. That database can answer questions you will ask on every system you work on: which version of this tool do I have, where did this file come from, and what did that package put on my disk.',
      '',
      'The answers matter for more than housekeeping. A result is only reproducible if your notes say which version of the tool produced it. And on a machine you are asked to review, being able to tell the files that belong to the distribution from the ones somebody added by hand is the start of many findings. All of these commands only read, so none of them needs `sudo`.'
    ),
    steps: [
      {
        id: 'list',
        prompt: T(
          '`dpkg -l` lists packages. On its own it prints every package on the system, so give it a pattern:',
          '',
          '```',
          'dpkg -l \'openssh*\'',
          '```',
          '',
          'The quotes hand the `*` to `dpkg` instead of letting the shell try to match it against file names.',
          '',
          'The first three lines are a legend for the two letters that start each row. The first letter is what was *asked for* and the second is the *current state*. `ii` means asked to be installed, and installed: the normal case. `rc` would mean removed, with configuration files left behind. After the letters come the name, the version, the architecture and a description cut to fit the screen.'
        ),
        hint: 'Type `dpkg -l` followed by the pattern in single quotes: `\'openssh*\'`.',
        solution: 'dpkg -l \'openssh*\'',
        check: { cmd: DPKG, exit: 0, argsRe: /(^|\s)(-l|--list)(\s|$)/, out: /^ii\s+openssh-server\s/m },
      },
      {
        id: 'version',
        prompt: 'Read the row for `openssh-server`. Which version is installed? Type it exactly as the `Version` column shows it.',
        hint: 'The version is the third thing on the row, after `ii` and the name. It contains a colon, and it ends before `amd64`.',
        solution: '1:10.0p1-7',
        answer: /^(1:)?10\.0p1-7$/,
      },
      {
        id: 'owner',
        prompt: T(
          'Now turn the question around. You have a file, and you want to know which package it belongs to. `-S` searches the database for a path:',
          '',
          '```',
          'dpkg -S /usr/bin/ssh',
          '```',
          '',
          'The answer has the package name before the colon and the path after it. Notice that the package is not called `ssh`. Package names and command names often differ, which is exactly why this lookup is useful.'
        ),
        hint: 'Type `dpkg -S` followed by the full path `/usr/bin/ssh`. The `S` is a capital letter.',
        solution: 'dpkg -S /usr/bin/ssh',
        check: { cmd: DPKG, exit: 0, out: /^openssh-client: \/usr\/bin\/ssh$/m },
      },
      {
        id: 'owner-dig',
        prompt: T(
          'Your turn. Find out which package the command `dig` came from.',
          '',
          '`dpkg -S` wants a path, and you only have a command name. `which dig` prints the path of the program that runs when you type `dig`.'
        ),
        hint: 'Run `which dig` to get the path, then give that path to `dpkg -S`. You can also do it in one line: `dpkg -S $(which dig)`.',
        solution: 'dpkg -S /usr/bin/dig',
        check: { cmd: DPKG, exit: 0, out: /^bind9-dnsutils: \/usr\/bin\/dig$/m },
      },
      {
        id: 'unowned',
        prompt: T(
          'Not every file belongs to a package. Ask about the file that holds this machine\'s name:',
          '',
          '```',
          'dpkg -S /etc/hostname',
          '```',
          '',
          '`no path found` is the answer, not a failure of the tool: no package installed this file. It was written when the system was set up. Files you create, and software installed by hand, give the same reply.',
          '',
          'On a system you are reviewing, this is a quick test. A program in `/usr/bin` that no package owns did not come from the distribution, and it is worth asking who put it there.'
        ),
        hint: 'The same command as before with a different path: `dpkg -S /etc/hostname`.',
        solution: 'dpkg -S /etc/hostname',
        check: { cmd: DPKG, exit: 1, argsRe: /\/etc\/hostname/, out: /no path found matching pattern/ },
      },
      {
        id: 'files',
        prompt: T(
          'The opposite lookup starts from a package and lists every file it installed. That is `-L`:',
          '',
          '```',
          'dpkg -L openssh-client',
          '```',
          '',
          'Read the list by directory. Paths under `/usr/bin` are the programs you can run, so this one package gives you `ssh`, `scp` and two more. Paths under `/usr/share/man` are their manual pages, and `/usr/share/doc` holds the license. When you have installed something and do not know what it is called on the command line, this list tells you.'
        ),
        hint: 'Type `dpkg -L openssh-client`, with a capital `L` this time.',
        solution: 'dpkg -L openssh-client',
        check: { cmd: DPKG, exit: 0, argsRe: /(^|\s)(-L|--listfiles)(\s|$)/, out: /^\/usr\/bin\/ssh-keygen$/m },
      },
      {
        id: 'programs',
        prompt: T(
          'Usually you only want the programs. List the files of the package `iproute2`, and keep only the lines that contain `bin/`.',
          '',
          'You know the tool that keeps matching lines, and the `|` that connects two commands.'
        ),
        hint: 'Send the output of `dpkg -L iproute2` through `grep bin/`.',
        solution: 'dpkg -L iproute2 | grep bin/',
        check: {
          cmd: DPKG, argsRe: /iproute2/, exit: 0,
          fn: (ev) => { const l = linesOf(ev); return l.length > 0 && l.every((x) => /\/s?bin(\/|$)/.test(x)) && l.indexOf('/usr/bin/ip') >= 0 && l.indexOf('/usr/bin/ss') >= 0; },
        },
      },
      {
        id: 'policy',
        prompt: T(
          '`dpkg` knows what is installed. `apt` also knows what the repository offers, and one command shows both side by side:',
          '',
          '```',
          'apt-cache policy kali-linux-default',
          '```',
          '',
          '`Installed` is the version on this machine, `Candidate` is the version `apt` would install if you asked now, and the line with the address shows which repository the candidate comes from. When the two versions differ, an upgrade is waiting.',
          '',
          'Run this before you install something unfamiliar: it tells you whether you already have it, and where it would come from.'
        ),
        hint: 'Type `apt-cache policy` followed by the package name `kali-linux-default`.',
        solution: 'apt-cache policy kali-linux-default',
        check: { cmd: ['apt-cache', 'apt'], args: ['policy'], exit: 0, out: /^kali-linux-default:\n\s+Installed:/m },
      },
      {
        id: 'installed',
        prompt: 'Read the `Installed` line of that output. What does it say about `kali-linux-default` on this machine? Type the value shown after `Installed:`.',
        hint: 'The value is a word in round brackets. It means the package is not installed here.',
        solution: '(none)',
        answer: /^\(?none\)?\.?$/i,
      },
      {
        id: 'meta',
        prompt: T(
          '`kali-linux-default` is a *metapackage*. It contains no programs of its own. It is a named list: installing it installs everything it depends on. Kali groups its tools this way. `kali-linux-default` is the tool set of the standard desktop image, `kali-linux-headless` is the same idea without the tools that need a graphical desktop, and the `kali-tools-*` family groups tools by subject. Look inside two of them:',
          '',
          '```',
          'apt-cache depends kali-linux-default kali-tools-top10',
          '```',
          '',
          'Each name is followed by its `Depends` lines. Metapackages can point at other metapackages, which is how a single name can stand for a whole tool set. This workstation was built from the small `kali-linux-core` set, with individual tools added one by one.'
        ),
        hint: 'Type `apt-cache depends` followed by both package names.',
        solution: 'apt-cache depends kali-linux-default kali-tools-top10',
        check: {
          all: [
            { cmd: ['apt-cache', 'apt'], exit: 0, out: /Depends:.*\bkali-tools-top10\b/ },
            { out: /Depends:.*\bnmap\b/ },
          ],
        },
      },
    ],
    quiz: [
      {
        q: 'On a server you are reviewing, `dpkg -S /usr/local/bin/sync-reports` answers `no path found matching pattern`. What have you learned?',
        choices: [
          'The file does not exist',
          'The package that owns the file is damaged',
          'No installed package put that file there: it was added by hand or by some other installer',
          'You need `sudo` to search the package database',
        ],
        answer: 2,
        why: '`dpkg -S` searches the lists of files that installed packages own. A file nobody registered there did not come from a package. In `/usr/local` that is normal for locally installed software, and it tells you where to ask next.',
      },
      {
        q: 'You have just installed the package `bind9-dnsutils` and want to know which commands it gave you. Which line answers that?',
        choices: [
          '`dpkg -S bind9-dnsutils`',
          '`dpkg -L bind9-dnsutils | grep bin/`',
          '`dpkg -l bind9-dnsutils`',
          '`apt search bind9-dnsutils`',
        ],
        answer: 1,
        why: '`-L` lists the files a package installed, and its programs are the paths in a `bin` directory. `-S` goes the other way, from a path to a package, and `-l` shows only the version and state.',
      },
      {
        q: 'For the package `curl`, `apt-cache policy` shows `Installed: 8.17.0-1` and `Candidate: 8.17.0-2`. What will `sudo apt full-upgrade` do with `curl`?',
        choices: [
          'Nothing, because `curl` is already installed',
          'Replace version 8.17.0-1 with 8.17.0-2',
          'Remove `curl`, because the versions do not match',
          'Install both versions side by side',
        ],
        answer: 1,
        why: 'The candidate is the version `apt` would install now. When it is newer than the installed version, the package is upgradable and the next upgrade brings it to the candidate.',
      },
      {
        q: 'What does installing the package `kali-linux-headless` put on a system?',
        choices: [
          'A kernel without graphics drivers',
          'Kali\'s default tools that work without a graphical desktop, pulled in as dependencies of a package that is itself almost empty',
          'Only documentation about Kali',
          'A setting that switches the desktop off',
        ],
        answer: 1,
        why: 'It is a metapackage: a list of dependencies with a name. Asking for it makes `apt` install every tool on the list, which is why one short command can set up a whole tool set.',
      },
    ],
    refs: ['dpkg(1)', 'dpkg-query(1)', 'apt-cache(8)', 'apt_preferences(5)', 'Kali Linux Revealed, ch. 8 (Debian Package Management)'],
  };

  K.lessons.register({
    id: 'pkg',
    title: 'Packages and keeping Kali current',
    order: 50,
    summary: 'Know where Kali\'s software comes from, keep the system up to date, install and remove tools cleanly, and find out which package any file belongs to.',
    lessons: [updateLesson, installLesson, inspectLesson],
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
