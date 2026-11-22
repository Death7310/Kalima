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
  /** The step's check also demands that the printed output does NOT match this. */
  const without = (re) => (ev) => !re.test(outOf(ev));
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

  K.lessons.register({
    id: 'discovery',
    title: 'Discovering the lab network',
    order: 100,
    summary: 'Find the hosts and services on the authorized lab range, read the results, and turn them into an inventory.',
    lessons: [scope, hosts],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
