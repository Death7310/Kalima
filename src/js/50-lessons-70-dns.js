/* Kalima — curriculum module "dns": names, DNS and WHOIS.
 *
 * Lessons: dns-resolve, dns-dig, dns-servers, dns-records. They use the lab
 * resolver (10.10.10.53, authoritative for halcyon.lab), the simulated public
 * resolvers and the fictional public domain halcyonfreight.example. No practice
 * files are seeded: the material is the lab network itself. Checks test what a
 * line printed or the state it left behind (/etc/hosts, ~/engagement/notes.md).
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const HOSTS = '/etc/hosts';
  /** Content of a file on the Kali machine, or null when it cannot be read. */
  const readFile = (path) => { try { return K.kali.vfs.read(path); } catch (e) { return null; } };
  /** Does /etc/hosts still hold the standard loopback line? */
  const hostsIntact = () => /^127\.0\.0\.1\s+localhost\b/m.test(readFile(HOSTS) || '');
  /** The practice entry of dns-resolve: any hosts line that names example.com. */
  const OVERRIDE = /^[ \t]*[0-9a-fA-F.:]+[ \t]+(\S+[ \t]+)*example\.com([ \t]|$)/m;

  /* ----------------------------------------------------------- dns-resolve */
  const resolveLesson = {
    id: 'dns-resolve',
    title: 'How a name becomes an address',
    minutes: 12,
    objectives: [
      'Read `/etc/hosts` and `/etc/resolv.conf` and say what each contributes to a lookup',
      'Look a name up the way programs do with `getent hosts`, and explain why a short name such as `web01` works',
      'Add an entry to `/etc/hosts` with `sudo`, predict which answer wins, and remove the entry again',
    ],
    intro: T(
      'Almost every command you aim at another machine starts with a name: `ping web01`, `ssh db01`, a URL. Before anything is sent, your workstation has to turn that name into an address, and it follows fixed rules to do so. When a tool reaches the wrong machine, or none at all, the cause is often here and not on the network.',
      '',
      'In this lesson you read the two files that steer the process, look names up the way programs do, and then change the answer for one name on purpose to see which source wins. This matters twice on an engagement: your own lookups have to be trustworthy, and the same files on a system you review show where it has been told to look.'
    ),
    steps: [
      {
        id: 'hosts',
        prompt: T(
          'The oldest source of names is a plain file on the machine itself. Print it:',
          '',
          '```',
          'cat /etc/hosts',
          '```',
          '',
          'Each line is an address followed by one or more names for it. `127.0.0.1 localhost` is the machine talking to itself. `127.0.1.1 kali` gives this machine\'s own host name an address, which is how Debian-based systems set it up. The lines that contain colons do the same for IPv6.',
          '',
          'Nothing in the file mentions the lab servers, so those names must come from somewhere else.'
        ),
        hint: 'Type `cat /etc/hosts` and press Enter.',
        solution: 'cat /etc/hosts',
        check: { line: /\/etc\/hosts/, out: /127\.0\.0\.1\s+localhost/ },
      },
      {
        id: 'resolv',
        prompt: T(
          'Somewhere else is the Domain Name System, DNS: servers that answer questions about names. Which server this machine asks is written in a second file:',
          '',
          '```',
          'cat /etc/resolv.conf',
          '```',
          '',
          'Read it line by line. The first line is a comment that says NetworkManager wrote the file, which it does each time the network connection comes up. `nameserver` gives the address of a DNS server to send questions to. `search` names a domain, and the next steps show what it is for.'
        ),
        hint: 'The same command as before, with the path `/etc/resolv.conf`.',
        solution: 'cat /etc/resolv.conf',
        check: { line: /resolv\.conf/, out: /nameserver\s+10\.10\.10\.53/ },
      },
      {
        id: 'server',
        prompt: 'Read the `nameserver` line again. To which address does this machine send its DNS questions?',
        hint: 'It is the address after the word `nameserver` in the output of `cat /etc/resolv.conf`.',
        solution: '10.10.10.53',
        answer: /^10\.10\.10\.53(#53)?$/,
      },
      {
        id: 'getent',
        prompt: T(
          'Now look a name up. `getent hosts` asks the system the same question that `ping`, `ssh` or a browser would ask, and prints the answer:',
          '',
          '```',
          'getent hosts web01.halcyon.lab',
          '```',
          '',
          'The reply has the format of a line from `/etc/hosts`: the address, then the name. The name is not in that file, so the answer came from the DNS server you just read about.',
          '',
          'If a name cannot be found, `getent` prints nothing at all. The only sign is its exit status, which is 2.'
        ),
        hint: '`getent` takes the name of a database, here `hosts`, and then the thing to look up.',
        solution: 'getent hosts web01.halcyon.lab',
        check: { cmd: 'getent', args: ['hosts'], argsRe: /web01\.halcyon\.lab/, out: /^10\.10\.10\.10\s+web01\.halcyon\.lab/m },
      },
      {
        id: 'short',
        prompt: T(
          'Typing `.halcyon.lab` every time would be tedious. Look up the short name `web01` in the same way and compare the reply with the last one.',
          '',
          'It is identical, and the `search` line is the reason. When a name contains no dot, the resolver adds each search domain to it and asks for that instead: `web01` becomes `web01.halcyon.lab`. The name with the domain attached is called the *fully qualified* name, and it is the one to write in your notes, because a short name means something different on every network.'
        ),
        hint: 'Use `getent hosts` again and give it only `web01`.',
        solution: 'getent hosts web01',
        check: { cmd: 'getent', args: ['hosts'], argsRe: /(^|\s)web01(\s|$)/, out: /^10\.10\.10\.10\s+web01\.halcyon\.lab/m },
      },
      {
        id: 'order',
        prompt: T(
          'You have seen two sources of names, the file and DNS. A third file decides in which order they are consulted. Print its line for host names:',
          '',
          '```',
          'grep hosts /etc/nsswitch.conf',
          '```',
          '',
          'Read the sources from left to right. `files` means `/etc/hosts` and comes first. `dns` means the servers in `/etc/resolv.conf` and comes last. The entry between them only concerns names that end in `.local` and plays no part here.',
          '',
          'The first source that knows the name wins, so a line in `/etc/hosts` beats whatever DNS would have said.'
        ),
        hint: '`grep` prints the lines of a file that contain a word. The word is `hosts` and the file is `/etc/nsswitch.conf`.',
        solution: 'grep hosts /etc/nsswitch.conf',
        check: { line: /nsswitch\.conf/, out: /hosts:\s+files\b.*\bdns\b/ },
      },
      {
        id: 'add',
        prompt: T(
          'Put that rule to the test. `example.com` is a public name that DNS knows. Give this machine a different answer for it by adding a line to `/etc/hosts`. The file belongs to root, so the write needs `sudo`, which asks for your password (`kali`):',
          '',
          '```',
          'echo "10.10.10.10 example.com" | sudo tee -a /etc/hosts',
          '```',
          '',
          '`echo` produces the line, and `tee`, running as root, appends it to the file and also shows it on screen. The `-a` matters: without it `tee` would replace the whole file with your one line.',
          '',
          'A plain `sudo echo ... >> /etc/hosts` is refused. The `>>` is carried out by your own shell, which is not root. Only the `echo` would run as root.'
        ),
        hint: 'Type the command exactly, including `-a`. If you left `-a` out, the file now holds only your line: open it with `sudo nano /etc/hosts` and put `127.0.0.1 localhost` and `127.0.1.1 kali` back above it.',
        solution: 'echo "10.10.10.10 example.com" | sudo tee -a /etc/hosts',
        input: ['kali'],
        check: { fn: () => /^[ \t]*10\.10\.10\.10[ \t]+example\.com[ \t]*$/m.test(readFile(HOSTS) || '') && hostsIntact() },
      },
      {
        id: 'wins',
        prompt: T(
          'Ask the system for `example.com` now, the way a program would.',
          '',
          'The answer is the lab address from your new line. No DNS server was asked: the file knew the name, and the lookup stopped there. From this moment every program on this machine that is given the name `example.com` will connect to 10.10.10.10, and none of them will tell you so.'
        ),
        hint: 'It is the lookup command from earlier in this lesson: `getent hosts` followed by the name.',
        solution: 'getent hosts example.com',
        check: { cmd: 'getent', args: ['hosts'], argsRe: /example\.com/, out: /^10\.10\.10\.10\s+example\.com/m },
      },
      {
        id: 'dns-view',
        prompt: T(
          'DNS itself has not changed. `dig` is a tool that sends its question straight to the DNS server and never reads `/etc/hosts`. The next lesson covers it properly. For now run:',
          '',
          '```',
          'dig +short example.com',
          '```',
          '',
          'Which address does DNS still give for `example.com`?',
          '',
          'Two tools, two different answers for one name: when you meet that on a real system, `/etc/hosts` is the first place to look.'
        ),
        hint: 'Run the `dig` command and type the address it prints. It is a public address, not one that starts with 10.',
        solution: '93.184.215.14',
        answer: /^93\.184\.215\.14$/,
      },
      {
        id: 'remove',
        prompt: T(
          'An override that has been forgotten will mislead you for weeks, so remove yours now. Open the file as root in the editor:',
          '',
          '```',
          'sudo nano /etc/hosts',
          '```',
          '',
          '- Move the cursor down to the line `10.10.10.10 example.com`.',
          '- Press Ctrl-K, which cuts the whole line.',
          '- Press Ctrl-O and then Enter to write the file, and Ctrl-X to exit.',
          '',
          'The step completes when the line is gone and the rest of the file is still in place. Check the result with `getent hosts example.com`: the public address is back.',
          '',
          'The same file deserves a look on any system you are asked to review. An unexpected line in it redirects a name for every program on that machine.'
        ),
        hint: 'Only the line you added should go. If you removed too much, the file needs its first two lines again: `127.0.0.1 localhost` and `127.0.1.1 kali`. Remember to save with Ctrl-O before you leave with Ctrl-X.',
        solution: 'sudo nano /etc/hosts',
        testSolution: 'grep -v example.com /etc/hosts > /tmp/hosts.clean && sudo cp /tmp/hosts.clean /etc/hosts',
        input: ['kali'],
        check: { fn: () => { const text = readFile(HOSTS); return text != null && !OVERRIDE.test(text) && hostsIntact(); } },
      },
    ],
    quiz: [
      {
        q: 'A machine has the line `10.10.10.20 files.halcyon.lab` in `/etc/hosts`, and its DNS server has never heard of that name. What happens when you run `ping files.halcyon.lab` there?',
        choices: [
          'It fails, because DNS answers that the name does not exist',
          'It pings 10.10.10.20, because the file is consulted first and knows the name',
          'It asks you which of the two sources to believe',
          'It adds the search domain and looks up `files.halcyon.lab.halcyon.lab`',
        ],
        answer: 1,
        why: 'The `hosts:` line in `/etc/nsswitch.conf` lists `files` before `dns`. The file has an answer, so the lookup ends there and DNS is never asked.',
      },
      {
        q: 'You type `ssh db01` and reach `db01.halcyon.lab`. Which setting made the short name work?',
        choices: [
          'The line `127.0.1.1 kali` in `/etc/hosts`',
          'The `nameserver` line in `/etc/resolv.conf`',
          'The `search halcyon.lab` line in `/etc/resolv.conf`',
          'Nothing: every DNS server completes short names by itself',
        ],
        answer: 2,
        why: 'The resolver on your own machine adds each search domain to a name that has no dot and asks for the result. The DNS server only ever sees the full name.',
      },
      {
        q: 'On one workstation, `dig +short` gives the correct address for a site, yet `curl` on the same workstation connects somewhere else. What do you check first?',
        choices: [
          'Whether the DNS server has been restarted recently',
          'Whether `curl` needs to be reinstalled',
          'The `search` line in `/etc/resolv.conf`',
          '`/etc/hosts` on that workstation',
        ],
        answer: 3,
        why: '`dig` asks the DNS server directly, while `curl` uses the system resolver, which reads `/etc/hosts` first. A different answer from the two points at an entry in that file.',
      },
      {
        q: 'Why is `sudo echo "10.10.10.10 test" >> /etc/hosts` refused with "permission denied"?',
        choices: [
          'The redirection is done by your own shell, which is not root, before `sudo` even starts',
          '`sudo` may not be combined with `echo`',
          '`/etc/hosts` can only be changed with an editor',
          'The line is missing a fully qualified name',
        ],
        answer: 0,
        why: 'The shell opens the file for `>>` itself, with your permissions. `sudo` raises the privileges of `echo` only. Piping into `sudo tee -a` moves the writing into a program that runs as root.',
      },
    ],
    refs: ['hosts(5)', 'resolv.conf(5)', 'nsswitch.conf(5)', 'getent(1)', 'tee(1)', 'The Debian Administrator\'s Handbook, section 8.3 (Setting the Hostname and Configuring the Name Service)'],
  };

  K.lessons.register({
    id: 'dns',
    title: 'Names: DNS and WHOIS',
    order: 70,
    summary: 'How a name becomes an address on your workstation, how to question DNS servers with dig, host and nslookup, and what public records such as WHOIS and a zone reveal about a network.',
    lessons: [resolveLesson],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
