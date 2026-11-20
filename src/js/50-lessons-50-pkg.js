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

  K.lessons.register({
    id: 'pkg',
    title: 'Packages and keeping Kali current',
    order: 50,
    summary: 'Know where Kali\'s software comes from, keep the system up to date, install and remove tools cleanly, and find out which package any file belongs to.',
    lessons: [updateLesson],
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
