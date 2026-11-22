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

  /* --------------------------------------------------------------- dns-dig */
  const digLesson = {
    id: 'dns-dig',
    title: 'Asking DNS with dig',
    minutes: 12,
    objectives: [
      'Find the status, the question, the answer, the query time and the answering server in the output of `dig`',
      'Tell a name that does not exist (`NXDOMAIN`) from a name that has no record of the type you asked for',
      'Query the record types A, CNAME, MX, NS, TXT and SOA, and shorten the output with `+short`',
      'Look up the name that belongs to an address with `dig -x`',
    ],
    intro: T(
      'A lookup with `getent` tells you which address your machine would use. `dig` shows what a DNS server actually said: the records it holds, whether the query succeeded, which server replied and how long it took. It is the standard tool for reading DNS, and its output is dense until you know the parts.',
      '',
      'DNS is usually the first thing you read about a network. It tells you which names exist, which machine handles the mail and who runs the zone, in reply to ordinary questions that any client may ask. In this lesson you query the lab zone `halcyon.lab`, one record type at a time.'
    ),
    steps: [
      {
        id: 'first',
        prompt: T(
          'Ask for the address of the intranet server:',
          '',
          '```',
          'dig web01.halcyon.lab',
          '```',
          '',
          'Lines that start with `;` are commentary from `dig`. Work through the output from the top:',
          '',
          '- The header line holds `status: NOERROR`: the query succeeded. The line below it counts what came back, here `ANSWER: 1`.',
          '- **QUESTION SECTION** repeats what was asked: the name, the class `IN` (Internet) and the record type `A`, an IPv4 address.',
          '- **ANSWER SECTION** holds the record itself: name, `3600`, `IN`, `A`, and the address. The number is the *time to live*: for that many seconds a resolver may reuse the answer without asking again.',
          '- At the bottom, `Query time` says how long the answer took and `SERVER` says who gave it.',
          '',
          'Names are printed with a final dot. The dot stands for the root of the DNS tree and marks the name as complete.'
        ),
        hint: 'Type `dig`, a space, and the full name `web01.halcyon.lab`.',
        solution: 'dig web01.halcyon.lab',
        check: { cmd: 'dig', out: /status: NOERROR[\s\S]*ANSWER SECTION:\s*\nweb01\.halcyon\.lab\.\s+\d+\s+IN\s+A\s+10\.10\.10\.10/ },
      },
      {
        id: 'server',
        prompt: 'Look at the `;; SERVER:` line near the end of that output. Which address answered the query?',
        hint: 'The line reads `;; SERVER:` followed by an address, `#53` for the port, and the address again in brackets. Type only the address.',
        solution: '10.10.10.53',
        answer: /^10\.10\.10\.53(#53)?(\s*\(10\.10\.10\.53\))?$/,
      },
      {
        id: 'nx',
        prompt: T(
          'Now ask for a name that does not exist, `nosuch.halcyon.lab`, and find the status before you read on.',
          '',
          'It says `NXDOMAIN`, short for *non-existent domain*: the server is certain there is no such name. The count shows `ANSWER: 0`, and there is no answer section. In its place the **AUTHORITY SECTION** shows a record of type `SOA` for `halcyon.lab`, which identifies the zone that gave the verdict.',
          '',
          'Notice that `dig` itself did not fail. It asked, it was answered, and the answer was no.'
        ),
        hint: 'The command has the same form as the first one, with the name `nosuch.halcyon.lab`.',
        solution: 'dig nosuch.halcyon.lab',
        check: { cmd: 'dig', out: /status: NXDOMAIN/ },
      },
      {
        id: 'short',
        prompt: T(
          'When you only want the data, `+short` drops everything else:',
          '',
          '```',
          'dig +short web01.halcyon.lab',
          '```',
          '',
          'One line, the address. This is the form to use inside pipelines and scripts.',
          '',
          'It has a cost. `+short` prints nothing for a name that does not exist, and also nothing for a name that exists but has no record of the type you asked for. When the output is empty, run the query again without `+short` and read the status.'
        ),
        hint: 'Options of `dig` that begin with `+` can stand before or after the name.',
        solution: 'dig +short web01.halcyon.lab',
        check: { cmd: 'dig', argsRe: /\+short/, out: /^10\.10\.10\.10\s*$/m, not: { out: /QUESTION SECTION/ } },
      },
      {
        id: 'mx',
        prompt: T(
          'An address is only one kind of record. To ask for another kind, name the type after the domain. `MX` records say which machine accepts mail for a domain:',
          '',
          '```',
          'dig halcyon.lab MX',
          '```',
          '',
          'The answer section reads `10 mail01.halcyon.lab.` The name is the mail server. The number in front is a preference: when a domain lists several mail servers, senders try the lowest number first.'
        ),
        hint: 'The query is for the domain `halcyon.lab` itself, not for one of its hosts, and the type `MX` follows the name.',
        solution: 'dig halcyon.lab MX',
        check: { cmd: 'dig', argsRe: /\bmx\b/i, out: /10 mail01\.halcyon\.lab\./ },
      },
      {
        id: 'ns',
        prompt: T(
          '`NS` records name the servers that hold a zone, its *name servers*. Find the name server of `halcyon.lab`, and use `+short` so that only its name is printed.',
          '',
          'A public domain normally lists at least two name servers, so that one of them can fail. This lab zone has a single one, and it is the same server that answers all your queries.'
        ),
        hint: 'Take the `MX` query, replace the type with `NS`, and add `+short`.',
        solution: 'dig +short halcyon.lab NS',
        check: { cmd: 'dig', argsRe: /\bns\b/i, out: /ns1\.halcyon\.lab\./ },
      },
      {
        id: 'txt',
        prompt: T(
          '`TXT` records hold free text. Administrators use them to publish statements about a domain that other systems can look up.',
          '',
          'Query the `TXT` record of `halcyon.lab`. What text does it hold?',
          '',
          'The text is an SPF policy, which states who may send mail in the name of the domain. This one allows the domain\'s own mail servers and nobody else. Receiving mail servers look the policy up to judge whether a message is forged.'
        ),
        hint: 'Run `dig +short halcyon.lab TXT` and type the text that appears between the quotation marks.',
        solution: 'v=spf1 mx -all',
        answer: /^["'`]?v=spf1\s+mx\s+-all["'`]?$/i,
      },
      {
        id: 'cname',
        prompt: T(
          'Some names are only aliases. Ask for the address of `www.halcyon.lab` with the full output, and count the records in the answer section.',
          '',
          'There are two. The first has the type `CNAME`, for *canonical name*: it says that `www.halcyon.lab` is another name for `web01.halcyon.lab`. The server then adds the `A` record of that real name, so one question gets you all the way to an address.',
          '',
          'Aliases let an administrator move a service to another machine by changing one record. For you, a CNAME is a statement that two names lead to the same host.'
        ),
        hint: 'Run `dig www.halcyon.lab` without `+short`, so that the record types are shown.',
        solution: 'dig www.halcyon.lab',
        check: { cmd: 'dig', argsRe: /\bwww\.halcyon\.lab/, out: /www\.halcyon\.lab\.\s+\d+\s+IN\s+CNAME\s+web01\.halcyon\.lab\./ },
      },
      {
        id: 'soa',
        prompt: T(
          'Every zone has exactly one `SOA` record, the *start of authority*. It describes the zone itself. Run:',
          '',
          '```',
          'dig +short halcyon.lab SOA',
          '```',
          '',
          'The first field is the primary name server. The second is the mailbox of the person responsible, written with a dot where the `@` would be. The third is the serial number, which the administrator raises with every change to the zone. Many administrators build it from the date of the change and a two-digit counter.',
          '',
          'What is the serial number of `halcyon.lab`?'
        ),
        hint: 'It is the long number that follows `hostmaster.halcyon.lab.` in the output.',
        solution: '2026111201',
        answer: /^2026111201$/,
      },
      {
        id: 'reverse',
        prompt: T(
          'DNS also answers the opposite question: which name belongs to an address? The option `-x` builds that query for you. Find the name of 10.10.10.40.',
          '',
          'If you ran it without `+short`, look at the question section. `dig` asked for a `PTR` record under the odd-looking name `40.10.10.10.in-addr.arpa.`, the address written backwards inside a special zone.',
          '',
          'Reverse records are kept separately from the forward ones, and nothing forces the two to agree. Treat a reverse name as a useful hint, and confirm it with a forward lookup before it goes into your notes as fact.'
        ),
        hint: 'Write `dig -x` followed by the address. `+short` works here as well.',
        solution: 'dig -x 10.10.10.40',
        check: { cmd: 'dig', args: ['-x'], argsRe: /10\.10\.10\.40/, out: /mail01\.halcyon\.lab\./ },
      },
    ],
    quiz: [
      {
        q: '`dig halcyon.lab` asks for an `A` record and comes back with `status: NOERROR` and `ANSWER: 0`. What does that tell you?',
        choices: [
          'The DNS server could not be reached',
          'The name `halcyon.lab` does not exist',
          'The name exists, but it has no record of the type that was asked for',
          'The answer was removed because it is confidential',
        ],
        answer: 2,
        why: 'A name that does not exist is reported as `NXDOMAIN`. `NOERROR` with an empty answer means the name is there, in this case with MX, NS and TXT records, but without an address record of its own.',
      },
      {
        q: 'A domain has the records `MX 10 mail-a` and `MX 20 mail-b`. Where does a sending mail server deliver first?',
        choices: [
          'To `mail-a`, because the lower preference number is tried first',
          'To `mail-b`, because the higher preference number is tried first',
          'To both at the same time',
          'To whichever of the two answered a ping faster',
        ],
        answer: 0,
        why: 'The number in an MX record is a preference, and the lowest value wins. `mail-b` is the fallback for when `mail-a` cannot be reached.',
      },
      {
        q: '`dig +short portal.halcyon.lab` prints nothing at all. What can you conclude?',
        choices: [
          'The name certainly does not exist',
          'The DNS server is switched off',
          'The name exists, and its address is being kept from you',
          'Nothing yet: run it again without `+short` and read the status',
        ],
        answer: 3,
        why: '`+short` shows only record data, so a missing name and a missing record type look the same. The status in the full output tells the cases apart.',
      },
      {
        q: '`www.halcyon.lab` is a CNAME for `web01.halcyon.lab`. The administrator moves web01 to a new address and updates its `A` record. What has to change for `www`?',
        choices: [
          'Its own `A` record must be updated as well',
          'Nothing: the alias points at the name, so it follows to the new address',
          'The CNAME has to be deleted and created again',
          'The serial number of the reverse zone',
        ],
        answer: 1,
        why: 'A CNAME holds a name, not an address. Whoever looks up `www` is referred to `web01` and receives whatever address that name has at the time.',
      },
    ],
    refs: ['dig(1)', 'RFC 1034', 'RFC 1035', 'RFC 7208 (SPF)'],
  };

  /* ----------------------------------------------------------- dns-servers */
  /** Public resolvers of the simulated internet, as a server argument (address or name). */
  const PUBLIC = '(?:8\\.8\\.8\\.8|8\\.8\\.4\\.4|1\\.1\\.1\\.1|9\\.9\\.9\\.9|dns\\.google|one\\.one\\.one\\.one|dns9\\.quad9\\.net)';
  const AT_PUBLIC = new RegExp('(^|\\s)@' + PUBLIC + '(\\s|$)');
  const AT_LAB = /(^|\s)@(10\.10\.10\.53|ns1(\.halcyon\.lab)?)(\s|$)/;
  /** Everything a line printed, without colour codes. */
  const outOf = (ev) => K.util.stripAnsi(ev.output || '');

  const serversLesson = {
    id: 'dns-servers',
    title: 'Choosing which server to ask',
    minutes: 12,
    objectives: [
      'Send a query to a particular DNS server with `dig @server`',
      'Explain why an internal name resolves on the lab server and is `NXDOMAIN` on a public resolver',
      'Tell an authoritative answer from a non-authoritative one by the `aa` flag',
      'Ask the same questions with `host` and `nslookup`',
    ],
    intro: T(
      'So far every question went to one server, the one named in `/etc/resolv.conf`. DNS is not one database, though. Different servers know different things, and the same name can get different answers depending on whom you ask. The names of internal machines usually exist only on an organization\'s own servers.',
      '',
      'Being able to pick the server, and to read whether an answer is first-hand, lets you explain the puzzle "it resolves here and fails there", which you will meet on almost every network. This lesson also introduces `host` and `nslookup`, two tools that ask the same questions with less detail.'
    ),
    steps: [
      {
        id: 'at',
        prompt: T(
          'To send a query to a server of your choice, put `@` and the server in front of the name. Start with the server you have been using all along, this time named explicitly:',
          '',
          '```',
          'dig @10.10.10.53 web01.halcyon.lab',
          '```',
          '',
          'Two things in the output confirm where the question went. Near the top `dig` reports `(1 server found)`, and the `;; SERVER:` line at the bottom shows 10.10.10.53.',
          '',
          'The answer is the one you would get without the `@`, because `/etc/resolv.conf` names the same server. The `@` only replaces that default for one query.'
        ),
        hint: 'There is no space between `@` and the address, and the name to look up comes after it.',
        solution: 'dig @10.10.10.53 web01.halcyon.lab',
        check: { cmd: 'dig', argsRe: AT_LAB, out: /web01\.halcyon\.lab\.\s+\d+\s+IN\s+A\s+10\.10\.10\.10[\s\S]*SERVER: 10\.10\.10\.53/ },
      },
      {
        id: 'public',
        prompt: T(
          'Now put the same question to a public resolver. 8.8.8.8 is one that anybody on the internet may use:',
          '',
          '```',
          'dig @8.8.8.8 web01.halcyon.lab',
          '```',
          '',
          'The status is `NXDOMAIN`. The server that answered this time is 8.8.8.8, and as far as it can tell the name does not exist.',
          '',
          'Both servers are right. `halcyon.lab` is an *internal zone*: it is held on Halcyon\'s own server, and nothing in the public DNS leads there. A public resolver follows the public tree down from the root and finds no such branch. This is how organizations keep the names of internal machines out of public view.',
          '',
          'One caution for real work. Whoever runs a public resolver sees the questions it is sent, so think before you send a client\'s internal names to a third party. Here everything stays inside the simulation.'
        ),
        hint: 'Change only the address after the `@`.',
        solution: 'dig @8.8.8.8 web01.halcyon.lab',
        check: { cmd: 'dig', argsRe: AT_PUBLIC, out: /status: NXDOMAIN/ },
      },
      {
        id: 'root',
        prompt: T(
          'The reply from 8.8.8.8 shows where the search ended. Its **AUTHORITY SECTION** holds one `SOA` record. The record belongs to `.`, a single dot, which is the root of the DNS tree, and the first name after `SOA` is the root\'s primary server.',
          '',
          'What is that name?'
        ),
        hint: 'In the output of `dig @8.8.8.8 web01.halcyon.lab`, find the line with `IN SOA`. The answer is the first name to the right of `SOA`.',
        solution: 'a.root-servers.net',
        answer: /^a\.root-servers\.net\.?$/i,
      },
      {
        id: 'public-ok',
        prompt: T(
          'A public resolver does its job for public names. Ask 8.8.8.8 for the address of `example.com`.',
          '',
          'The status is `NOERROR` and there is an answer. Now read the line that starts `;; flags:`. It shows `qr rd ra`:',
          '',
          '- `qr` marks the message as a reply.',
          '- `rd`, *recursion desired*, repeats your request that the server should find the answer for you, wherever it is kept.',
          '- `ra`, *recursion available*, says the server is willing to do that.',
          '',
          'A server that hunts down answers on behalf of its clients is called a *resolver*.'
        ),
        hint: 'The command has the same shape as the previous one, with the name `example.com`.',
        solution: 'dig @8.8.8.8 example.com',
        check: { cmd: 'dig', argsRe: AT_PUBLIC, out: /status: NOERROR[\s\S]*example\.com\.\s+\d+\s+IN\s+A\s+\d/ },
      },
      {
        id: 'aa',
        prompt: T(
          'Compare that with a reply from the lab server about its own zone. Run this again and read its flags line:',
          '',
          '```',
          'dig @10.10.10.53 web01.halcyon.lab',
          '```',
          '',
          'It has one flag that the reply from 8.8.8.8 did not have. Which one?'
        ),
        hint: 'The reply from 8.8.8.8 had the flags `qr rd ra`. This one has four flags. Type the one that is new.',
        solution: 'aa',
        answer: /^aa$/i,
      },
      {
        id: 'nonauth',
        prompt: T(
          '`aa` stands for *authoritative answer*. A server sets it when it holds the zone itself, so the answer is first-hand. The lab server holds `halcyon.lab`, and that is why the flag was there.',
          '',
          '8.8.8.8 does not hold the zone `example.com`. It collected the answer from the servers that do and passed it on, perhaps from its memory of an earlier query. Such an answer is called *non-authoritative*. It is usually correct, and it can be as old as the time to live allows.',
          '',
          'The lab server is a resolver as well. Predict what its flags will be for a name outside its own zone, then check: ask 10.10.10.53 for `example.com`.'
        ),
        hint: 'Use `dig @10.10.10.53` with the name `example.com`, and look for `aa` on the flags line.',
        solution: 'dig @10.10.10.53 example.com',
        check: { cmd: 'dig', argsRe: /example\.com/, fn: (ev) => { const o = outOf(ev); return /status: NOERROR/.test(o) && /SERVER: 10\.10\.10\.53/.test(o) && /;; flags: [a-z ]*;/.test(o) && !/;; flags: [a-z ]*\baa\b/.test(o); } },
      },
      {
        id: 'host',
        prompt: T(
          'There was no `aa`: for `example.com` the lab server is only a messenger.',
          '',
          '`dig` shows everything, which is more than you need for a quick check. `host` asks the same kind of question and answers in a sentence:',
          '',
          '```',
          'host web01.halcyon.lab',
          '```',
          '',
          'One line: the name *has address* 10.10.10.10. `host` words each record type in this way. An alias is reported as `is an alias for`, and a mail server as `mail is handled by`.',
          '',
          'Unlike `dig`, `host` applies the search domain from `/etc/resolv.conf`, so `host web01` works as well.'
        ),
        hint: 'Type `host` followed by the full name.',
        solution: 'host web01.halcyon.lab',
        check: { cmd: 'host', out: /web01\.halcyon\.lab has address 10\.10\.10\.10/ },
      },
      {
        id: 'host-public',
        prompt: T(
          '`host` has no `@`. It takes the server to ask as a second argument, after the name. Use `host` to ask 8.8.8.8 about `web01.halcyon.lab`.',
          '',
          'The first lines name the server that was used. The last line gives the verdict, `not found: 3(NXDOMAIN)`. The 3 is the number that stands for NXDOMAIN inside a DNS message.'
        ),
        hint: 'The order is `host`, the name, then the address of the server.',
        solution: 'host web01.halcyon.lab 8.8.8.8',
        check: { cmd: 'host', argsRe: new RegExp('web01\\S*\\s+' + PUBLIC + '$'), out: /not found: 3\(NXDOMAIN\)/ },
      },
      {
        id: 'nslookup',
        prompt: T(
          'The third tool is `nslookup`. It is worth knowing because it is also present on Windows, where `dig` and `host` are usually missing. Try it on a public name:',
          '',
          '```',
          'nslookup example.com',
          '```',
          '',
          'The first two lines show the server that was asked. The answer follows under the heading `Non-authoritative answer:`, which is how `nslookup` tells you that the reply did not carry the `aa` flag.'
        ),
        hint: 'Type `nslookup` followed by the name. Like `host`, it accepts a server as a second argument, but none is needed here.',
        solution: 'nslookup example.com',
        check: { cmd: 'nslookup', argsRe: /example\.com/, out: /Non-authoritative answer:/ },
      },
      {
        id: 'nslookup-auth',
        prompt: T(
          'Predict first, then check. Run:',
          '',
          '```',
          'nslookup web01.halcyon.lab',
          '```',
          '',
          'Does the heading `Non-authoritative answer:` appear in the output this time? Answer `yes` or `no`.'
        ),
        hint: 'Think about which server is asked by default, and whether it holds the zone `halcyon.lab` itself. Then run the command and look.',
        solution: 'no',
        answer: /^(no|n)\.?$/i,
      },
    ],
    quiz: [
      {
        q: 'At home, with a public resolver configured on your laptop, you run `dig intranet.halcyon.lab`. What do you expect?',
        choices: [
          'The address 10.10.10.10, because DNS answers are the same everywhere',
          '`NXDOMAIN`, because the zone exists only on the organization\'s internal server',
          'A timeout, because public resolvers block names that end in `.lab`',
          'A request for a password',
        ],
        answer: 1,
        why: 'An internal zone is known only to the servers inside the organization. A public resolver searches the public tree, finds no such name and reports that it does not exist.',
      },
      {
        q: 'A reply shows `flags: qr rd ra` and no `aa`. What does that mean?',
        choices: [
          'The answer is wrong and should be discarded',
          'The query was refused',
          'The server that replied holds the zone itself',
          'The server passed the answer on from elsewhere or from its cache; it does not hold the zone',
        ],
        answer: 3,
        why: 'Only a server that holds the zone sets `aa`. A resolver without that flag is relaying what it learned. That is normally accurate, but it may be a stored copy.',
      },
      {
        q: 'A site moved to a new address an hour ago. The domain\'s own name server returns the new address, while a public resolver still returns the old one. What is the most likely reason?',
        choices: [
          'The resolver is reusing a stored answer until its time to live runs out',
          'The public resolver has been compromised',
          'The two servers use different versions of the DNS protocol',
          'Public resolvers only update their records once a year',
        ],
        answer: 0,
        why: 'A resolver may reuse an answer for as many seconds as its TTL says. Until then it does not ask again, so it cannot know about the change. The authoritative server always has the current record.',
      },
      {
        q: 'On the Kali machine, `dig web01.halcyon.lab` and `dig @10.10.10.53 web01.halcyon.lab` print the same answer. Why?',
        choices: [
          'Every DNS server in the world holds a copy of every zone',
          '`dig` ignores the `@` when the name is internal',
          '`/etc/resolv.conf` already names 10.10.10.53, so both queries go to the same server',
          'The answer comes from `/etc/hosts` in both cases',
        ],
        answer: 2,
        why: 'Without `@`, `dig` uses the servers listed in `/etc/resolv.conf`. Naming the same server explicitly changes nothing. `dig` never reads `/etc/hosts`.',
      },
    ],
    refs: ['dig(1)', 'host(1)', 'nslookup(1)', 'resolv.conf(5)', 'RFC 1034', 'RFC 9499 (DNS Terminology)'],
  };

  /* ----------------------------------------------------------- dns-records */
  const NOTES = '/home/kali/engagement/notes.md';
  /** A notes line that records the transfer: it names the operation and the server. */
  const TRANSFER_NOTE = /^(?=.*(axfr|transfer))(?=.*(10\.10\.10\.53|ns1)).+$/im;

  const recordsLesson = {
    id: 'dns-records',
    title: 'Public records and zone transfers',
    minutes: 12,
    objectives: [
      'Read a WHOIS record for a domain: registrar, dates, name servers, organization and redacted fields',
      'Find out which network an address belongs to with `whois`',
      'Explain why looking up public records is passive, and where your scope draws the line',
      'Say what a zone transfer is for, recognize one that is allowed and one that is refused, and record the observation in your notes',
    ],
    intro: T(
      'Some of the most useful facts about an organization\'s network are published on purpose: who registered its domain, which servers hold its DNS zone, which block of addresses its servers sit in. Reading these records is the usual first step of an assessment, and it is *passive*: you consult registries, and the organization\'s own systems are left alone.',
      '',
      'The second half of this lesson looks at how a DNS zone is copied between the servers that publish it. A zone transfer hands over every record in one reply. You will see the lab server allow one, see what a refusal looks like, and write the observation into your engagement notes.'
    ),
    steps: [
      {
        id: 'whois',
        prompt: T(
          'DNS says where a name leads. WHOIS says who registered it. Halcyon Freight\'s public website lives under the domain `halcyonfreight.example`. Ask for its registration record:',
          '',
          '```',
          'whois halcyonfreight.example',
          '```',
          '',
          'The record is long, so scroll back to its start and look for these fields:',
          '',
          '- `Registrar` is the company through which the domain was registered.',
          '- `Creation Date` and `Registry Expiry Date` show how long the domain has existed and when the registration runs out.',
          '- `Name Server` lists the servers that hold the DNS zone, the same names an `NS` query returns.',
          '- Many contact fields read `REDACTED FOR PRIVACY`.',
          '',
          'Names that end in `.example` are reserved for documentation, so this record is invented. Its layout is the one a real registry uses.'
        ),
        hint: 'Type `whois` followed by the domain name, without `www` and without `http://`.',
        solution: 'whois halcyonfreight.example',
        check: { cmd: 'whois', argsRe: /halcyonfreight\.example/i, out: /Registrar:|Registry Expiry Date:/ },
      },
      {
        id: 'expiry',
        prompt: T(
          'Find the `Registry Expiry Date` in the record. On which date does the registration run out? Give the date in the form YYYY-MM-DD.',
          '',
          'The date is worth reading. A domain that is allowed to lapse can be registered by somebody else, who then receives its web traffic and its mail.'
        ),
        hint: 'The field holds a date, the letter `T` and a time. Type only the date part before the `T`.',
        solution: '2027-03-14',
        answer: /^(2027-03-14(T[\d:]+Z?)?|14(th)? (of )?march,? 2027|march 14(th)?,? 2027)$/i,
      },
      {
        id: 'ns',
        prompt: T(
          'You rarely need all sixty lines. Print only the lines of the record that name the name servers, by sending the output of `whois` through `grep`.',
          '',
          'WHOIS records are plain text made of `Field: value` lines, which makes `grep` the natural way to pull out the part you want.'
        ),
        hint: 'Pipe the `whois` command into `grep -i "name server"`. The `-i` makes the match ignore upper and lower case.',
        solution: 'whois halcyonfreight.example | grep -i "name server"',
        check: { cmd: 'whois', argsRe: /halcyonfreight\.example/i, fn: (ev) => { const o = outOf(ev); return /Name Server: NS1\.HALCYONFREIGHT\.EXAMPLE/i.test(o) && !/Registrar:/.test(o); } },
      },
      {
        id: 'org',
        prompt: T(
          'Since 2018 most registries hide the personal details of the people behind a domain, which is why the registrant\'s name, street and email are all redacted. Some fields usually stay visible all the same.',
          '',
          'Look at the lines that begin with `Registrant`. Which organization is named as the registrant?'
        ),
        hint: 'Run `whois halcyonfreight.example | grep Registrant` and read the `Registrant Organization` line.',
        solution: 'Halcyon Freight Ltd.',
        answer: /^halcyon freight(,? (ltd\.?|limited))?$/i,
      },
      {
        id: 'whois-ip',
        prompt: T(
          'Addresses are registered as well. They are handed out in blocks by five regional registries, and `whois` finds the right one by itself. The public website resolves to 203.0.113.10. Ask who holds that address:',
          '',
          '```',
          'whois 203.0.113.10',
          '```',
          '',
          'The reply has a different layout, because it comes from an address registry. `inetnum` is the block the address belongs to, and `netname` and `descr` say who holds it. Here the block is `TEST-NET-3`, a range set aside for documentation, as you would expect of a fictional company.',
          '',
          'In real work this lookup tells you whether a server stands in the organization\'s own network or at a hosting company. That decides whose permission a test of it would need.'
        ),
        hint: 'Give `whois` the address in place of a domain name.',
        solution: 'whois 203.0.113.10',
        check: { cmd: 'whois', argsRe: /203\.0\.113\.\d+/, out: /netname:\s+TEST-NET-3/i },
      },
      {
        id: 'scope',
        prompt: T(
          'Everything so far was *passive*. Your questions went to registries, and the answers are public records that anyone may read. Nothing was sent to a machine that Halcyon Freight runs, and nobody there can tell that you looked.',
          '',
          'Your scope file draws the line in the same place. Read what it says:',
          '',
          '```',
          'grep -i passive ~/engagement/scope.txt',
          '```',
          '',
          'Lookups of public records are permitted. *Active* testing, where you send something to a system to see how it reacts, is limited to the addresses and names listed as in scope. The public domain `halcyonfreight.example` is not among them.'
        ),
        hint: 'Type the `grep` command as shown. `cat ~/engagement/scope.txt` shows the whole file, which is short.',
        solution: 'grep -i passive ~/engagement/scope.txt',
        check: { line: /scope\.txt/, out: /Passive lookups/ },
      },
      {
        id: 'axfr',
        prompt: T(
          'Now return to the lab, which is in scope. Until now you asked DNS for one record at a time. There is also an operation that hands over a whole zone at once: the *zone transfer*, query type `AXFR`. It exists so that the secondary name servers of a zone can copy its data from the primary.',
          '',
          'Request a transfer of the lab zone from its name server:',
          '',
          '```',
          'dig axfr halcyon.lab @10.10.10.53',
          '```',
          '',
          'The reply is the complete zone. It opens and closes with the `SOA` record, and between them is every record there is: an `A` record for each host, the aliases, the mail server. The lab server gives this to any machine on the lab network that asks.',
          '',
          'Read the host names as a description of the network. `db01`, `backup01`, `dc01` and `printer` each say what a machine is for.'
        ),
        hint: 'The word `axfr` takes the place of a record type such as `MX`. The `@` names the server to ask, as in the previous lesson.',
        solution: 'dig axfr halcyon.lab @10.10.10.53',
        check: { any: [
          { cmd: 'dig', argsRe: /\baxfr\b/i, out: /XFR size: \d+ records|backup01\.halcyon\.lab\.\s+\d+\s+IN\s+A\s/ },
          { cmd: 'host', args: ['-l'], out: /backup01\.halcyon\.lab has address/ },
        ] },
      },
      {
        id: 'count',
        prompt: 'The last comment line of the transfer begins `;; XFR size:`. How many records did the server send?',
        hint: 'Run the transfer again if it has scrolled away. The number stands between `XFR size:` and the word `records`.',
        solution: '21',
        answer: /^21(\s*records)?$/i,
      },
      {
        id: 'refused',
        prompt: T(
          'A name server gives out a transfer only to those it has been told to trust. To see a refusal, send the same request to the public resolver 8.8.8.8, which gives zone transfers to nobody:',
          '',
          '```',
          'dig axfr halcyon.lab @8.8.8.8',
          '```',
          '',
          '`; Transfer failed.` is all you get. A carefully run name server gives the same reply to everyone except its own secondary servers. Administrators restrict transfers because the full zone is a ready-made inventory of the network. Single lookups keep working for everybody, since a restriction only stops the wholesale copy.',
          '',
          'The lab server allows transfers to the whole lab network, which is more than its job requires. That is worth reporting to the client.',
          '',
          'Do not try this against the name servers of `halcyonfreight.example`. A transfer request goes to the client\'s own server, so it is not a passive lookup, and those servers are out of scope.'
        ),
        hint: 'Keep the command and change only the server after the `@`.',
        solution: 'dig axfr halcyon.lab @8.8.8.8',
        check: { all: [{ cmd: 'dig', argsRe: /\baxfr\b/i }, { cmd: 'dig', argsRe: AT_PUBLIC }], out: /Transfer failed/ },
      },
      {
        id: 'note',
        prompt: T(
          'An observation that is not written down is lost by the time the report is due. Record this one in your engagement notes: what you asked, which server you asked, and what came back.',
          '',
          '```',
          'echo "- dig axfr halcyon.lab @10.10.10.53: zone transfer allowed from the lab network, 21 records" >> ~/engagement/notes.md',
          '```',
          '',
          'Use `>>`, which appends. A single `>` would replace all your notes with this one line. You may word the note differently, as long as it mentions the transfer and the server.',
          '',
          'Check the result with `tail -n 3 ~/engagement/notes.md`. With the command and the outcome on record, you or a colleague can repeat the observation later, and the client can verify it.'
        ),
        hint: 'Type the `echo` command with two `>` characters. The step looks for a line in `~/engagement/notes.md` that contains `axfr` or `transfer` together with `10.10.10.53` or `ns1`.',
        solution: 'echo "- dig axfr halcyon.lab @10.10.10.53: zone transfer allowed from the lab network, 21 records" >> ~/engagement/notes.md',
        check: { line: /notes\.md/, fn: (ev) => TRANSFER_NOTE.test(readFile(NOTES) || '') && !/(^|[^>])>\s*\S*notes\.md/.test(ev.line || '') },
      },
    ],
    quiz: [
      {
        q: 'Why does a WHOIS lookup of a client\'s public domain count as passive?',
        choices: [
          'Because `whois` sends its packets more slowly than other tools',
          'Because the query goes to a registry\'s database and not to any system the client runs',
          'Because the client is notified and can object',
          'Because WHOIS data is encrypted',
        ],
        answer: 1,
        why: 'The record is held by the registry or registrar, and that is where your query goes. The client\'s servers receive nothing, so the lookup cannot affect them or be noticed by them.',
      },
      {
        q: 'Your scope lists 10.10.10.0/24 and `*.halcyon.lab`. While reading public records you learn that the company\'s public name server is `ns1.halcyonfreight.example`. What is the right way to proceed?',
        choices: [
          'Request a zone transfer from it, because DNS is a public service',
          'Scan it, because it belongs to the same company',
          'Note it, and ask the client whether it should be added to the scope before sending it anything unusual',
          'Remove it from your notes, because it is out of scope',
        ],
        answer: 2,
        why: 'Belonging to the client does not put a system in scope. Only the written scope does. What you learned from public records belongs in your notes, and extending the scope is the client\'s decision.',
      },
      {
        q: 'An administrator restricts zone transfers to the zone\'s secondary servers. What changes for an ordinary user who looks up `www` in that zone?',
        choices: [
          'Nothing: single lookups are answered as before',
          'The lookup now fails with `NXDOMAIN`',
          'The lookup now requires a password',
          'The answer arrives without a time to live',
        ],
        answer: 0,
        why: 'The restriction applies only to requests for the complete zone. Questions about individual names are still answered, which is why restricting transfers costs nothing in normal use.',
      },
      {
        q: 'Why is a zone transfer to anyone who asks regarded as a weakness, when every record in it could also be looked up one at a time?',
        choices: [
          'Because a transfer changes the records on the server',
          'Because a transfer stops the server from answering other clients',
          'Because the transferred records are more accurate than the individual ones',
          'Because looking records up one at a time requires knowing the names first, and the transfer hands over the full list',
        ],
        answer: 3,
        why: 'To look up a name you have to know it or guess it. A transfer removes the guessing: it lists every host, including the ones nobody was meant to find.',
      },
    ],
    refs: ['whois(1)', 'dig(1)', 'RFC 3912 (WHOIS)', 'RFC 5936 (AXFR)', 'RFC 5737', 'NIST SP 800-115, section 4.1 (Network Discovery)'],
  };

  K.lessons.register({
    id: 'dns',
    title: 'Names: DNS and WHOIS',
    order: 70,
    summary: 'How a name becomes an address on your workstation, how to question DNS servers with dig, host and nslookup, and what public records such as WHOIS and a zone reveal about a network.',
    lessons: [resolveLesson, digLesson, serversLesson, recordsLesson],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
