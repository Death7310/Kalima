/* Kalima — curriculum module "discovery": discovering the lab network.
 *
 * Lessons: disc-scope, disc-hosts, disc-ports, disc-services, disc-inventory.
 * Everything here is discovery inside the authorized range 10.10.10.0/24:
 * which hosts exist, which ports and services they offer. No vulnerability
 * testing. Files written, all under ~/engagement: notes.md (appended),
 * scans/sweep.txt (written by sudo, so owned by root: its steps use sudo again
 * on a repeat), scans/lab-fast.gnmap and scans/web01.gnmap (written as kali).
 * Checks read command output or the state a line left behind.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const HOME = '/home/kali';
  const NOTES = HOME + '/engagement/notes.md';
  const SCANS = HOME + '/engagement/scans/';
  const appendsToNotes = { any: [{ line: />>\s*\S*notes\.md/ }, { cmd: 'tee', args: ['-a'], argsRe: /notes\.md/ }] };
  const outOf = (ev) => K.util.stripAnsi(ev.output || '');
  const PW = ['kali'];

  /* ------------------------------------------------------------------ scope */
  const scope = {
    id: 'disc-scope',
    title: 'Before you scan: scope and permission',
    minutes: 9,
    objectives: [
      'Confirm the engagement scope before running any scanner',
      'Explain the difference between active and passive discovery and why active discovery needs permission',
      'Read the explanation the simulator gives when a target is out of scope',
      'Record the start time of a testing session in the engagement notes',
    ],
    intro: T(
      'Discovery means finding out what is on a network. **Passive** discovery listens or looks at public records and sends nothing to the target: a DNS lookup of a public name, or a WHOIS query. **Active** discovery sends packets to the target to see how it answers: a ping sweep, a port scan. Active discovery is the kind that needs permission, because the target can see it, log it and in the worst case be disturbed by it.',
      '',
      'So the first step of any scan is not a scan. It is reading the scope.'
    ),
    steps: [
      {
        id: 'scope',
        prompt: T(
          'Read the scope file again. Do this every time before you scan, because you will often be working from notes you wrote days ago:',
          '',
          '```',
          'cat ~/engagement/scope.txt',
          '```',
          '',
          'Find the in-scope range and the sentence about passive and active testing.'
        ),
        hint: 'Use `cat ~/engagement/scope.txt`.',
        solution: 'cat ~/engagement/scope.txt',
        check: { cmd: 'cat', argsRe: /scope\.txt/, out: /10\.10\.10\.0\/24/ },
      },
      {
        id: 'scope-q',
        prompt: 'The scope file says passive lookups of public records are permitted but one kind of testing is not. Which kind? Type one word.',
        hint: 'Read the last comment line of the file.',
        solution: 'active',
        answer: /^(active|active testing)$/i,
      },
      {
        id: 'guard',
        prompt: T(
          'This simulator has a **scope guard**. Active tools such as `nmap` check each target against the scope before they send anything. Real tools have no such guard: they scan whatever you point them at, so the responsibility is yours. See what the guard does. The client\'s public website, `halcyonfreight.example`, is named as out of scope. Ask nmap to ping it (`-sn` means "host discovery only, no port scan"):',
          '',
          '```',
          'nmap -sn halcyonfreight.example',
          '```',
          '',
          'Nothing is sent. Read the message the guard prints.'
        ),
        hint: 'Type `nmap -sn halcyonfreight.example`.',
        solution: 'nmap -sn halcyonfreight.example',
        check: { cmd: 'nmap', out: /Out-of-scope target blocked/ },
      },
      {
        id: 'guard-q',
        prompt: 'The name resolved to an address before the guard blocked it. Which address does the message name as the blocked target?',
        hint: 'Look for the line that starts with `[kalima] Out-of-scope target blocked:`.',
        solution: '203.0.113.10',
        answer: /^203\.0\.113\.10$/,
      },
      {
        id: 'inscope',
        prompt: T(
          'Now run the same kind of check against a host that is in scope, `web01` at `10.10.10.10`:',
          '',
          '```',
          'nmap -sn 10.10.10.10',
          '```',
          '',
          'This time the guard says nothing and nmap reports the host. `Host is up` means it answered the probe.'
        ),
        hint: 'Type `nmap -sn 10.10.10.10`.',
        solution: 'nmap -sn 10.10.10.10',
        check: { cmd: 'nmap', args: ['-sn'], out: /Host is up/ },
      },
      {
        id: 'time',
        prompt: T(
          'Scans leave traces in the target\'s logs. If the client sees odd traffic at 14:32 and asks whether it was you, your notes should answer. Record when you began. Append a line with the date and time to the notes:',
          '',
          '```',
          'echo "$(date \'+%F %H:%M\') discovery started, scope 10.10.10.0/24" >> ~/engagement/notes.md',
          '```',
          '',
          '`date \'+%F %H:%M\'` prints the date and the time in hours and minutes. Use `>>` so you add to the file rather than replace it.'
        ),
        hint: 'Use `echo` with `$(date ...)` inside the text and `>>` to append to `~/engagement/notes.md`.',
        solution: 'echo "$(date \'+%F %H:%M\') discovery started, scope 10.10.10.0/24" >> ~/engagement/notes.md',
        check: { all: [appendsToNotes, { any: [{ line: /date/ }, { line: /\d{1,2}:\d{2}/ }] }, { file: { path: NOTES, contains: /\d{4}-\d{2}-\d{2} \d{2}:\d{2}|\d{1,2}:\d{2}/ } }] },
      },
      {
        id: 'verify',
        prompt: T(
          'Confirm the entry:',
          '',
          '```',
          'tail -3 ~/engagement/notes.md',
          '```'
        ),
        hint: 'Use `tail -3 ~/engagement/notes.md`.',
        solution: 'tail -3 ~/engagement/notes.md',
        check: { cmd: ['tail', 'cat'], argsRe: /notes\.md/, out: /discovery started|\d{1,2}:\d{2}/ },
      },
    ],
    quiz: [
      {
        q: 'Which of these is passive discovery?',
        choices: [
          'Running a ping sweep of `10.10.10.0/24`',
          'Looking up the public DNS records of a company\'s domain',
          'Connecting to every port of a server to see which answer',
          'Sending a probe to each address in a range',
        ],
        answer: 1,
        why: 'A DNS lookup of a public record asks a public server about public data and sends nothing to the target network. The other three send packets to the targets themselves.',
      },
      {
        q: 'The scope guard blocks your scan of an address. What is the right response?',
        choices: [
          'Find another tool that has no guard',
          'Check the scope; if the target should be tested, ask the client to update it in writing',
          'Scan it anyway from a different machine',
          'Scan a smaller number of ports',
        ],
        answer: 1,
        why: 'The guard reflects the agreement. Only the client can widen it. Working around it, as real tools make easy, is exactly what the rules of engagement forbid.',
      },
      {
        q: 'Why note the time a scan started?',
        choices: [
          'Scans only work at certain times',
          'So the client can match your activity against their logs and alerts, and you can reproduce findings',
          'Because nmap requires it',
          'To make the scan faster',
        ],
        answer: 1,
        why: 'Scans are visible in the target\'s logs. A timestamped note tells the client which traffic was you and lets you reconstruct what you did.',
      },
    ],
    refs: ['nmap(1)', 'NIST SP 800-115, section 2', 'date(1)'],
  };

  /* ------------------------------------------------------------------ hosts */
  const hosts = {
    id: 'disc-hosts',
    title: 'Finding hosts: ping sweeps and ARP',
    minutes: 11,
    objectives: [
      'Run a host-discovery scan of a /24 with `nmap -sn`',
      'Explain why the same scan finds more hosts when run as root on the local segment',
      'Read `Host is up`, the latency and the MAC address vendor line',
      'Save scan output to a file with `-oN`',
    ],
    intro: T(
      'Before you ask what a host offers, you need to know which hosts exist. A *host discovery* scan, also called a ping sweep, sends probes to each address in a range and lists the ones that answer. The result is the first draft of your inventory.',
      '',
      'It is also a lesson in how much a scan result depends on how you ask. The same range gives different answers to an ordinary user and to root, and understanding why is the foundation of reading any scan.'
    ),
    steps: [
      {
        id: 'sweep',
        prompt: T(
          'Run a host-discovery scan of the whole lab range as yourself, without `sudo`:',
          '',
          '```',
          'nmap -sn 10.10.10.0/24',
          '```',
          '',
          '- `-sn` means host discovery only: no port scan.',
          '- `10.10.10.0/24` is every address from `.0` to `.255`, 256 in total.',
          '',
          'It takes a few seconds. Each answering host gets a `Nmap scan report` line and a `Host is up` line with the latency, the time the probe took to be answered. The last line summarizes how many hosts were up.'
        ),
        hint: 'Type `nmap -sn 10.10.10.0/24` with no `sudo`.',
        solution: 'nmap -sn 10.10.10.0/24',
        check: { cmd: 'nmap', args: ['-sn'], out: /256 IP addresses \(10 hosts up\)/ },
      },
      {
        id: 'sweep-q',
        prompt: 'How many hosts did the scan say were up? Type the number from the last line.',
        hint: 'It is in the parentheses on the `Nmap done` line.',
        solution: '10',
        answer: /^10$/,
      },
      {
        id: 'sudo-sweep',
        prompt: T(
          'Now repeat the scan as root with `sudo`. It asks for your password, `kali`. The password is not shown as you type:',
          '',
          '```',
          'sudo nmap -sn 10.10.10.0/24',
          '```',
          '',
          'On the local segment, root can send **ARP** requests: "who has 10.10.10.50?" Every host on the segment must answer ARP if it wants to be reachable at all, whatever its firewall says about ping. An ordinary user cannot craft those packets, so nmap falls back on connection attempts and misses hosts that ignore them.'
        ),
        input: PW,
        hint: 'Put `sudo` in front of the same command. The password is `kali`.',
        solution: 'sudo nmap -sn 10.10.10.0/24',
        check: { cmd: 'nmap', args: ['-sn'], user: 'root', out: /256 IP addresses \(12 hosts up\)/ },
      },
      {
        id: 'sudo-q',
        prompt: 'Two hosts appeared that the first scan missed. Name one of them (a host name such as `web01`, or its address).',
        hint: 'Compare the two lists. Look for `.50` and `.90`.',
        solution: 'dc01',
        answer: /^(dc01(\.halcyon\.lab)?|10\.10\.10\.50|backup01(\.halcyon\.lab)?|10\.10\.10\.90)$/i,
      },
      {
        id: 'mac-q',
        prompt: T(
          'The root scan adds a `MAC Address` line under each host. The MAC address is the hardware address of the network card, and the part in parentheses names the vendor from the first half of the address. It is a clue about what kind of device you are looking at.',
          '',
          'Which host\'s vendor is `Microsoft`? Give its name or address.'
        ),
        hint: 'Scroll up in the terminal, or run the scan again, and find `(Microsoft)`.',
        solution: 'dc01',
        answer: /^(dc01(\.halcyon\.lab)?|10\.10\.10\.50)$/i,
      },
      {
        id: 'caveat',
        info: true,
        prompt: T(
          'A vendor name is a hint, not proof. Virtual machines show the virtualization product (`VMware`, and here `Microsoft` for Hyper-V), and a MAC address can be changed. Use it to form a guess, then confirm with other evidence.',
          '',
          'Next, save a scan. Results you only saw on a screen are results you cannot put in a report.'
        ),
      },
      {
        id: 'save',
        prompt: T(
          'The option `-oN` writes the normal, human-readable output to a file. Save the root scan into your engagement\'s `scans` folder:',
          '',
          '```',
          'sudo nmap -sn 10.10.10.0/24 -oN ~/engagement/scans/sweep.txt',
          '```',
          '',
          'The scan still prints on screen as well as going to the file.'
        ),
        input: PW,
        hint: 'Add `-oN ~/engagement/scans/sweep.txt` to the `sudo nmap -sn` command. (Use `sudo` even if you did this lesson before: the earlier file belongs to root.)',
        solution: 'sudo nmap -sn 10.10.10.0/24 -oN ~/engagement/scans/sweep.txt',
        check: { all: [{ cmd: 'nmap', args: ['-sn', '-oN'] }, { file: { path: SCANS + 'sweep.txt', contains: /12 hosts up/ } }] },
      },
      {
        id: 'owner',
        prompt: T(
          'Look at the file you made, with a long listing (`-l` shows owner, group and size):',
          '',
          '```',
          'ls -l ~/engagement/scans',
          '```',
          '',
          'Read the owner column. The file was written by `nmap` running as root, so root owns it. That is why you could not overwrite it later without `sudo`. Files made with `sudo` surprise people in just this way.'
        ),
        hint: 'Type `ls -l ~/engagement/scans`.',
        solution: 'ls -l ~/engagement/scans',
        check: { cmd: 'ls', args: ['-l'], out: /sweep\.txt/ },
      },
      {
        id: 'count',
        prompt: T(
          'Count the hosts in the saved file instead of trusting your eyes. `grep -c` prints how many lines match a pattern:',
          '',
          '```',
          'grep -c "Host is up" ~/engagement/scans/sweep.txt',
          '```',
          '',
          'The count includes your own machine, `kali`, which is why it matches the scan\'s total.'
        ),
        hint: 'Use `grep -c "Host is up"` followed by the file name.',
        solution: 'grep -c "Host is up" ~/engagement/scans/sweep.txt',
        check: { cmd: 'grep', args: ['-c'], out: /^12$/m },
      },
    ],
    quiz: [
      {
        q: 'dc01 ignores ping, yet root\'s `nmap -sn` on the local segment still found it. Why?',
        choices: [
          'Root scans are more aggressive and force the host to answer',
          'On the same segment nmap can use ARP, and a host has to answer ARP to be reachable at all',
          'nmap guessed it from the host names',
          'The host answered once the password was typed',
        ],
        answer: 1,
        why: 'Firewalls usually filter ICMP or TCP, but ARP is how hosts on one network segment find each other\'s hardware address, so a host that is up cannot ignore it.',
      },
      {
        q: 'A scan from a different network, behind a router, reports 10 hosts up. A scan from the lab segment as root reports 12. What do you conclude?',
        choices: [
          'Two hosts went down in between',
          'Nothing: scan results never depend on where or how you scan',
          'The two hosts probably do not answer the probes that reach across a router, so one result is not the whole truth',
          'The second scan is wrong',
        ],
        answer: 2,
        why: 'ARP works only inside the segment. From elsewhere you depend on ICMP or TCP probes that a firewall may drop. A scan result describes what answered a particular probe from a particular place.',
      },
      {
        q: 'What does `Host is up (0.00067s latency)` tell you?',
        choices: [
          'The host has been running for 0.67 milliseconds',
          'It answered the probe, and it took about 0.67 milliseconds',
          'The host is vulnerable',
          'The host answered 67 probes',
        ],
        answer: 1,
        why: 'The number is the delay before the answer came back. A small value is normal on a local segment.',
      },
    ],
    refs: ['nmap(1), section HOST DISCOVERY', 'arp(8)', 'RFC 826 (ARP)', 'Nmap Network Scanning, ch. 3'],
  };

  /* ------------------------------------------------------------------ ports */
  const ports = {
    id: 'disc-ports',
    title: 'Open, closed and filtered ports',
    minutes: 11,
    objectives: [
      'Explain what open, closed and filtered mean in terms of the packets exchanged',
      'Scan a host with the default port list, with `-p` and with `-F`, and read the port table',
      'Recognize a host that blocks ping probes and scan it with `-Pn`',
    ],
    intro: T(
      'A port is a number that tells a host which service an incoming connection is for: 22 for SSH, 80 for web pages. A port scan asks, for each port, whether anything is listening. The answer is more subtle than yes or no, and the way it is subtle tells you something about the network, not only about the host.',
      '',
      'Scan only what you are authorized to scan, and read the output before you run the next command. A table you misread is worse than no table.'
    ),
    steps: [
      {
        id: 'web01',
        prompt: T(
          'Scan `web01`, the company web server, with no options other than the target:',
          '',
          '```',
          'nmap 10.10.10.10',
          '```',
          '',
          'By default nmap tries the 1000 ports that are most commonly used. The output has a table with three columns: `PORT` (number and protocol), `STATE` and `SERVICE`. The service name comes from a list of well-known port numbers; it is a guess from the number, not something nmap confirmed. A line such as `Not shown: 997 closed tcp ports` summarizes the ports not worth listing.'
        ),
        hint: 'Type `nmap 10.10.10.10`.',
        solution: 'nmap 10.10.10.10',
        check: { cmd: 'nmap', out: /22\/tcp\s+open\s+ssh/ },
      },
      {
        id: 'p',
        prompt: T(
          'Often you only need to know about particular ports. The `-p` option takes a list. Scan only the two web ports of web01:',
          '',
          '```',
          'nmap -p 80,443 10.10.10.10',
          '```',
          '',
          'Asking about fewer ports sends fewer packets and finishes sooner. `-p 1-1024` would mean a range, and `-p-` all 65535 ports, which is a big request for a client\'s server.'
        ),
        hint: 'Use `-p` followed by the port numbers separated by a comma, then the address.',
        solution: 'nmap -p 80,443 10.10.10.10',
        check: { all: [{ cmd: 'nmap', argsRe: /-p\s*80/, out: /80\/tcp\s+open/ }, { fn: (ev) => !/22\/tcp/.test(outOf(ev)) }] },
      },
      {
        id: 'fast',
        prompt: T(
          '`-F` ("fast") scans only the 100 most common ports instead of 1000. For a quick look at a host it is often enough:',
          '',
          '```',
          'nmap -F 10.10.10.10',
          '```',
          '',
          'Compare the `Not shown` line with the previous full scan: 97 closed plus 3 open makes the 100 ports examined.'
        ),
        hint: 'Type `nmap -F 10.10.10.10`.',
        solution: 'nmap -F 10.10.10.10',
        check: { cmd: 'nmap', args: ['-F'], out: /Not shown: 97/ },
      },
      {
        id: 'dev01',
        prompt: T(
          'Now scan `dev01`, a development server, with the default port list:',
          '',
          '```',
          'nmap 10.10.10.70',
          '```',
          '',
          'The three states you will meet most:',
          '',
          '- **open**: something is listening. The host answered the connection attempt as a service would (for TCP, the handshake went through).',
          '- **closed**: the host is reachable and the port has no listener, so the host answers "no" (a TCP reset).',
          '- **filtered**: nmap got no usable answer, usually because a firewall drops the packets. It cannot tell whether anything is listening.'
        ),
        hint: 'Type `nmap 10.10.10.70`.',
        solution: 'nmap 10.10.10.70',
        check: { cmd: 'nmap', out: /5432\/tcp\s+filtered/ },
      },
      {
        id: 'filtered-q',
        prompt: 'Which port number does dev01 show as `filtered`?',
        hint: 'Look at the STATE column of the table.',
        solution: '5432',
        answer: /^(5432|5432\/tcp)$/,
      },
      {
        id: 'reason',
        prompt: T(
          'Why does nmap say what it says? The `--reason` option adds a column with the evidence. Compare a closed port with the filtered one:',
          '',
          '```',
          'nmap --reason -p 80,5432 10.10.10.70',
          '```',
          '',
          'Port 80 is closed because the host refused the connection, so something answered. Port 5432 is filtered because nothing came back. Silence is how filtering looks from outside, and it is the reason scans against firewalled hosts take longer: nmap waits and retries before it gives up.'
        ),
        hint: 'Type `nmap --reason -p 80,5432 10.10.10.70`.',
        solution: 'nmap --reason -p 80,5432 10.10.10.70',
        check: { cmd: 'nmap', args: ['--reason'], out: /no-response/ },
      },
      {
        id: 'reason-q',
        prompt: 'What reason does nmap give for the filtered port 5432? Type it as it appears in the REASON column.',
        hint: 'It is two words joined by a hyphen.',
        solution: 'no-response',
        answer: /^no[- ]response$/i,
      },
      {
        id: 'dc01-plain',
        prompt: T(
          'Some hosts do not answer the probes nmap sends first to decide whether a host is up. Try `dc01`, the domain controller:',
          '',
          '```',
          'nmap 10.10.10.50',
          '```',
          '',
          'It takes a few seconds and ends with a note: the host *seems* down. nmap gave up before scanning any port. A host that is up but silent to ping looks exactly like a host that is off.'
        ),
        hint: 'Type `nmap 10.10.10.50`.',
        solution: 'nmap 10.10.10.50',
        check: { cmd: 'nmap', out: /Host seems down/ },
      },
      {
        id: 'dc01-pn',
        prompt: T(
          'The note suggests the remedy. `-Pn` means "treat the host as up, skip the ping check, and scan the ports anyway":',
          '',
          '```',
          'nmap -Pn 10.10.10.50',
          '```',
          '',
          'Now the ports are scanned. Windows domain controllers have many: look for 88 (Kerberos), 389 (LDAP) and 445 (SMB). The long `Not shown: 988 filtered` line says a firewall answers for nearly all other ports with silence.'
        ),
        hint: 'Add `-Pn` to the command.',
        solution: 'nmap -Pn 10.10.10.50',
        check: { cmd: 'nmap', args: ['-Pn'], out: /445\/tcp\s+open/ },
      },
      {
        id: 'backup01',
        prompt: T(
          '`backup01` at `10.10.10.90` also ignores ping, and it filters almost everything. Scan it so nmap treats it as up and reads its port table.',
          '',
          'It will take several seconds, because most ports do not answer and nmap waits for each. Read the table when it finishes.'
        ),
        hint: 'You need the option you just used, plus the address `10.10.10.90`.',
        solution: 'nmap -Pn 10.10.10.90',
        check: { cmd: 'nmap', args: ['-Pn'], out: /873\/tcp\s+open\s+rsync/ },
      },
      {
        id: 'backup-q',
        prompt: 'Which single port is open on backup01, and what service name does nmap show for it? Type the port number.',
        hint: 'It is the only line in the table. Most ports are filtered and not listed.',
        solution: '873',
        answer: /^(873|873\/tcp|rsync)$/i,
      },
    ],
    quiz: [
      {
        q: 'A port scan reports `5432/tcp filtered`. What does that tell you?',
        choices: [
          'Nothing is listening on the port',
          'A service is listening, but it is protected by a password',
          'Probes got no usable answer, so a firewall is probably dropping them and you cannot tell if anything listens',
          'The port is open but slow',
        ],
        answer: 2,
        why: 'Closed ports answer with a reset. Filtered means no answer came back, so the scan could not decide. Do not read it as closed.',
      },
      {
        q: 'You scan a host that is on and healthy, and nmap reports "Host seems down". What is the most likely explanation?',
        choices: [
          'The host is powered off',
          'The host does not answer the probes nmap used to check whether it is up',
          'nmap does not support that address',
          'The host has no open ports',
        ],
        answer: 1,
        why: 'The "is it up" check depends on probes that firewalls often drop. `-Pn` skips it, at the cost of spending time on hosts that really are down.',
      },
      {
        q: 'How many ports does `nmap -F` examine on a host, compared with the default scan?',
        choices: ['100, against 1000', '1000, against 65535', '10, against 100', 'All of them, in both cases'],
        answer: 0,
        why: 'The default is the 1000 most common ports and `-F` the 100 most common. Neither covers all 65535, so a service on an unusual port can be missed.',
      },
    ],
    refs: ['nmap(1), sections PORT SCANNING BASICS and SPECIFYING PORTS', 'RFC 9293 (TCP)', 'Nmap Network Scanning, ch. 4'],
  };

  /* --------------------------------------------------------------- services */
  const services = {
    id: 'disc-services',
    title: 'What is listening: services and systems',
    minutes: 11,
    objectives: [
      'Use `nmap -sV` to identify the software behind an open port and read the version column',
      'Run `sudo nmap -O` and read an operating-system guess with its confidence',
      'Use the TTL in a ping reply as a rough hint about the operating system',
      'Explain why banners and fingerprints are claims to check, not proof',
    ],
    intro: T(
      'An open port number is a weak clue. Port 80 is usually a web server, but which one, and which version? That is what an inventory needs, because later decisions (what to patch, what to report) depend on the software, not on the number.',
      '',
      'Service detection connects to the port and asks, then reads the answer. It is more intrusive than a port scan because it talks to the service, so run it on ports you already know are open.'
    ),
    steps: [
      {
        id: 'sv',
        prompt: T(
          'Add `-sV` ("service version") to a scan of web01:',
          '',
          '```',
          'nmap -sV 10.10.10.10',
          '```',
          '',
          'It takes longer, because nmap now talks to each open port. There is a new column, `VERSION`, with the product and version the service reported. `ssl/http` on 443 means a web server speaking TLS.'
        ),
        hint: 'Type `nmap -sV 10.10.10.10`.',
        solution: 'nmap -sV 10.10.10.10',
        check: { cmd: 'nmap', args: ['-sV'], out: /nginx 1\.26/ },
      },
      {
        id: 'sv-q',
        prompt: 'What product and version does web01 report on port 80? Type both, as in the VERSION column.',
        hint: 'The product name comes first, then the version number.',
        solution: 'nginx 1.26.3',
        answer: /^nginx\s*(\/\s*)?1\.26\.3$/i,
      },
      {
        id: 'db01',
        prompt: 'Now build the command yourself. Find out which SSH software db01 (`10.10.10.30`) runs, scanning only port 22 with service detection.',
        hint: 'Combine `-sV` with `-p 22` and the address.',
        solution: 'nmap -sV -p 22 10.10.10.30',
        check: { all: [{ cmd: 'nmap', args: ['-sV', '-p'], out: /OpenSSH/ }, { line: /10\.10\.10\.30|db01/ }] },
      },
      {
        id: 'printer',
        prompt: T(
          'Not every answer is confident. Scan two ports on the printer, `10.10.10.60`:',
          '',
          '```',
          'nmap -sV -p 631,9100 10.10.10.60',
          '```',
          '',
          'Port 631 is identified as `ipp`, the internet printing protocol. Port 9100 shows `jetdirect?`. A question mark means nmap is guessing from the port number: the service did not give an answer nmap recognized.'
        ),
        hint: 'Use `nmap -sV -p 631,9100 10.10.10.60`.',
        solution: 'nmap -sV -p 631,9100 10.10.10.60',
        check: { cmd: 'nmap', args: ['-sV'], out: /9100\/tcp\s+open\s+jetdirect\?/ },
      },
      {
        id: 'os',
        prompt: T(
          'Now the operating system. `-O` compares how the host\'s network stack behaves with a database of known systems. It needs raw packets, so it requires root:',
          '',
          '```',
          'sudo nmap -O 10.10.10.10',
          '```',
          '',
          'Read the lines `Running` and `OS details`. They give a family and a range, such as a kernel from one version to another, not an exact version.'
        ),
        input: PW,
        hint: 'Use `sudo`; the password is `kali`.',
        solution: 'sudo nmap -O 10.10.10.10',
        check: { cmd: 'nmap', args: ['-O'], user: 'root', out: /OS details: Linux/ },
      },
      {
        id: 'ping',
        prompt: T(
          'A cheaper hint is already in an ordinary ping. Every packet carries a **TTL** (time to live) that each router lowers by one. Systems start it at different values, commonly 64 for Linux, 128 for Windows and 255 for many network devices. On your own segment no router lowers it, so the TTL in a reply is close to the starting value:',
          '',
          '```',
          'ping -c 1 10.10.10.10',
          '```'
        ),
        hint: 'Type `ping -c 1 10.10.10.10` and look for `ttl=` in the reply line.',
        solution: 'ping -c 1 10.10.10.10',
        check: { cmd: 'ping', out: /ttl=\d+/ },
      },
      {
        id: 'ttl-q',
        prompt: 'What TTL did web01 reply with? Type the number. Does it agree with the OS guess you just got?',
        hint: 'It follows `ttl=` in the reply line.',
        solution: '64',
        answer: /^64$/,
      },
      {
        id: 'dc01-os',
        prompt: T(
          'dc01 does not answer ping, so TTL cannot help. Ask nmap for an OS guess anyway. You have to add `-Pn`, as before:',
          '',
          '```',
          'sudo nmap -O -Pn 10.10.10.50',
          '```',
          '',
          'Read the warning above the guess. nmap says its result may be unreliable because it could not find both an open and a closed port to compare. Most of dc01\'s ports are filtered, so it has little to work with.'
        ),
        input: PW,
        hint: 'Use `sudo nmap -O -Pn` and the address.',
        solution: 'sudo nmap -O -Pn 10.10.10.50',
        check: { cmd: 'nmap', args: ['-O', '-Pn'], user: 'root', out: /Windows/ },
      },
      {
        id: 'conf-q',
        prompt: 'What confidence, in percent, does nmap give for its first Windows guess? Type the number.',
        hint: 'It is in parentheses after the guess.',
        solution: '87',
        answer: /^87\s*%?$/,
      },
      {
        id: 'limits',
        info: true,
        prompt: T(
          'Hold every result here as a **claim**.',
          '',
          '- A version string is what the service chose to say. Administrators can change or hide it, and some software reports an older or newer name than it really is.',
          '- Distributions often patch software without changing the number. `OpenSSH 10.0p2 Debian 7` is a Debian build, so security fixes may be in it that the upstream number does not show.',
          '- An OS guess is a statistical match, and a confidence figure of 87 percent means "most similar", not "87 percent likely".',
          '',
          'In notes and reports, write what you observed and how (for example "nmap -sV reported nginx 1.26.3"), not what you concluded. If something matters, confirm it a second way before you rely on it.'
        ),
      },
    ],
    quiz: [
      {
        q: 'Why is `nmap -sV` more intrusive than a plain port scan?',
        choices: [
          'It scans more ports',
          'It talks to the services on open ports to elicit a response, rather than only noting that the port answered',
          'It disables the target\'s firewall',
          'It runs as root',
        ],
        answer: 1,
        why: 'A plain scan notes whether a port answers. Version detection sends service-specific requests and reads the reply, so it is more visible in logs and can stress fragile devices.',
      },
      {
        q: 'A server reports `Apache/2.4.1` but the administrator says it is fully patched. Which is the most reasonable reading?',
        choices: [
          'The administrator is lying',
          'The banner may show the upstream version while the distribution has backported fixes, so the number alone does not decide',
          'Nmap made the number up',
          'Banners are always accurate',
        ],
        answer: 1,
        why: 'Distributions backport fixes without changing the visible version. A banner is evidence to check, not a verdict.',
      },
      {
        q: 'You ping a host on your own network segment and the reply shows `ttl=127`. What is the best conclusion?',
        choices: [
          'It is almost certainly Linux',
          'It is probably a Windows host that started at 128 and a hop lowered it by one, a hint to confirm',
          'The host is 127 hops away',
          'The host is broken',
        ],
        answer: 1,
        why: 'TTL starts at a value that depends on the system (commonly 128 for Windows) and drops by one per router. The value suggests a family, and it can be changed.',
      },
      {
        q: 'Why does `nmap -O` need `sudo` while `nmap -sV` does not?',
        choices: [
          'OS detection sends and reads specially built packets, which needs root privileges',
          '`-O` writes to system files',
          'It connects to more ports',
          'It does not need it; sudo only speeds it up',
        ],
        answer: 0,
        why: 'Fingerprinting depends on the details of packets that ordinary programs cannot craft. Version detection uses normal connections.',
      },
    ],
    refs: ['nmap(1), sections SERVICE AND VERSION DETECTION and OS DETECTION', 'ping(8)', 'RFC 791 (time to live)', 'Nmap Network Scanning, ch. 7 and 8'],
  };

  /* -------------------------------------------------------------- inventory */
  const GN = SCANS + 'lab-fast.gnmap';
  const inventory = {
    id: 'disc-inventory',
    title: 'From scan output to an inventory',
    minutes: 11,
    objectives: [
      'Save a scan in grepable format with `-oG`',
      'Pick hosts with a given port open using `grep` and `cut`',
      'Write a host and service entry into the engagement notes',
      'Scan considerately and expect your scans to appear in the targets\' logs',
    ],
    intro: T(
      'A scan on the screen disappears. A scan in a file, turned into a short table, becomes evidence and a starting point for the report. Turning output into something you can question is half of discovery.',
      '',
      'nmap offers a grepable format designed for exactly this: one line per host, easy to filter with ordinary text tools. In this lesson you save one, ask it questions, and put the answer in your notes.'
    ),
    steps: [
      {
        id: 'og',
        prompt: T(
          'Scan the whole lab range for its 100 most common ports and save the result in grepable format. `-oG` writes the file, and `--open` hides ports that are not open from the screen output:',
          '',
          '```',
          'nmap -F --open -oG ~/engagement/scans/lab-fast.gnmap 10.10.10.0/24',
          '```',
          '',
          'It scans 256 addresses, so it takes some seconds. Only the questions you need answered should be scanned: that is why this uses `-F`, not all ports.'
        ),
        hint: 'Combine `-F`, `--open` and `-oG` followed by the file name, and the range.',
        solution: 'nmap -F --open -oG ~/engagement/scans/lab-fast.gnmap 10.10.10.0/24',
        check: { all: [{ cmd: 'nmap', args: ['-oG'] }, { file: { path: GN, contains: /Ports:/ } }] },
      },
      {
        id: 'cat',
        prompt: T(
          'Open the file and look at its structure:',
          '',
          '```',
          'cat ~/engagement/scans/lab-fast.gnmap',
          '```',
          '',
          'Each host has a `Status: Up` line and, if any port is open, a `Ports:` line. In `Ports:`, each entry is `port/state/protocol//service///`, separated by commas. Because everything for a host is on one line, `grep` can select hosts.'
        ),
        hint: 'Use `cat` on the file you just created.',
        solution: 'cat ~/engagement/scans/lab-fast.gnmap',
        check: { cmd: 'cat', argsRe: /lab-fast\.gnmap/, out: /Ports:/ },
      },
      {
        id: 'mysql-q',
        prompt: 'Which service name is listed for port 3306 on db01 (`10.10.10.30`)? Type the word between the slashes.',
        hint: 'Find the `Ports:` line of `10.10.10.30` and the entry that starts with `3306/open/tcp//`.',
        solution: 'mysql',
        answer: /^(mysql|mariadb)$/i,
      },
      {
        id: 'ssh',
        prompt: T(
          'Which hosts offer SSH? Filter the file with `grep` for the entry `22/open`, then keep only the second field (the address) with `cut`. Fields are separated by spaces, so `-d\' \'` sets the delimiter and `-f2` picks field 2:',
          '',
          '```',
          'grep \' 22/open\' ~/engagement/scans/lab-fast.gnmap | cut -d\' \' -f2',
          '```',
          '',
          'The space before `22` matters. The next step shows why.'
        ),
        hint: 'Pipe `grep \' 22/open\' FILE` into `cut -d\' \' -f2`.',
        solution: 'grep \' 22/open\' ~/engagement/scans/lab-fast.gnmap | cut -d\' \' -f2',
        check: { all: [{ cmd: 'grep' }, { cmd: 'cut' }, { out: /^10\.10\.10\.10$/m }, { fn: (ev) => !/Ports:/.test(outOf(ev)) }] },
      },
      {
        id: 'ssh-q',
        prompt: 'How many hosts offer SSH?',
        hint: 'Count the addresses the command printed, or add `| wc -l` to count them.',
        solution: '6',
        answer: /^(6|six)$/i,
      },
      {
        id: 'web',
        prompt: T(
          'Now work it out on your own. List the addresses that have **port 80** open, and only those. Careful: `dev01` has port 8080 open, and the text `80/open` is also inside `8080/open`. A pattern that is too loose gives a wrong inventory, so make the pattern start with the space that precedes the port.',
          '',
          'Print just the addresses.'
        ),
        hint: 'Same pipeline as before, with the pattern `\' 80/open\'`.',
        solution: 'grep \' 80/open\' ~/engagement/scans/lab-fast.gnmap | cut -d\' \' -f2',
        check: { all: [{ cmd: 'grep' }, { cmd: 'cut' }, { out: /^10\.10\.10\.80$/m }, { fn: (ev) => !/10\.10\.10\.70/.test(outOf(ev)) && !/Ports:/.test(outOf(ev)) }] },
      },
      {
        id: 'web-q',
        prompt: 'How many hosts have port 80 open?',
        hint: 'Count the addresses from the previous command.',
        solution: '4',
        answer: /^(4|four)$/i,
      },
      {
        id: 'notes',
        prompt: T(
          'Write what you learned into the notes, in a form the report can reuse. Add a line for web01 giving its address and open ports with their services, appended to `~/engagement/notes.md`. A Markdown table row works well:',
          '',
          '```',
          'echo "| web01 | 10.10.10.10 | 22 ssh, 80 http, 443 https |" >> ~/engagement/notes.md',
          '```',
          '',
          'Take the ports from your own scan, not from this example, and check them before you write them. You could add the other hosts the same way.'
        ),
        hint: 'Use `echo` and append with `>>` to `~/engagement/notes.md`. Include the address `10.10.10.10` and ports 22, 80 and 443.',
        solution: 'echo "| web01 | 10.10.10.10 | 22 ssh, 80 http, 443 https |" >> ~/engagement/notes.md',
        check: { all: [appendsToNotes, { file: { path: NOTES, contains: /10\.10\.10\.10[^\n]*\b443\b/ } }] },
      },
      {
        id: 'footprint',
        info: true,
        prompt: T(
          'Scanning considerately is a habit, not an extra.',
          '',
          '- Scan what the question needs. A fast scan for an inventory; a wider one only where there is a reason.',
          '- Prefer the gentle option. Service detection and OS detection are noisier than a port scan; use them on hosts you already have reason to look at.',
          '- Expect to be seen. Every connection your scan makes may be logged by the target, and intrusion detection systems may alert. That is normal, and it is one more reason your notes carry times: the client\'s team can match your activity against their logs.',
          '- Keep the raw output. The `scans` folder holds the evidence behind every line of your inventory.'
        ),
      },
    ],
    quiz: [
      {
        q: 'You run `grep "80/open" file` and `dev01` appears in the output, though it has no web server on port 80. Why?',
        choices: [
          'dev01 does have port 80 open',
          'The text `80/open` also occurs inside `8080/open`',
          'grep matches host names only',
          'The scan is wrong',
        ],
        answer: 1,
        why: 'grep matches text, not port numbers. Anchoring the pattern with the preceding space, or using a stricter pattern, avoids matching the tail of a longer number.',
      },
      {
        q: 'Why save scan output to a file instead of only reading it on screen?',
        choices: [
          'Files make scans faster',
          'It lets you search it again, keep it as evidence and rebuild the notes without scanning twice',
          'Screen output is not accurate',
          'The scope requires nothing else',
        ],
        answer: 1,
        why: 'A saved scan is reusable evidence. Re-scanning to answer a new question means more traffic to the client\'s systems.',
      },
      {
        q: 'Why does the target\'s own log matter to a tester who is scanning with permission?',
        choices: [
          'It does not matter',
          'The client can match the entries against your notes, so they can tell your testing from a real attack',
          'It reduces the time a scan takes',
          'It shows the target\'s passwords',
        ],
        answer: 1,
        why: 'Scans leave traces. With timestamps in your notes the client\'s team can tell which traffic was authorized testing and which was not.',
      },
    ],
    refs: ['nmap(1), section OUTPUT', 'grep(1)', 'cut(1)', 'NIST SP 800-115, section 4.1', 'Nmap Network Scanning, ch. 13'],
  };

  K.lessons.register({
    id: 'discovery',
    title: 'Discovering the lab network',
    order: 100,
    summary: 'Find the hosts and services on the authorized lab range, read the results, and turn them into an inventory.',
    lessons: [scope, hosts, ports, services, inventory],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
