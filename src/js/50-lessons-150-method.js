/* Kalima — curriculum module "method": methodology, notes and reporting.
 *
 * Lessons: method-phases, method-notes, method-finding, method-next.
 * Observations only: nothing here exploits anything. Everything the lessons
 * run is discovery against in-scope lab hosts (10.10.10.0/24).
 *
 * Files written by the lessons (all by the learner, as kali):
 *   ~/engagement/notes.md                      appended (method-notes, method-finding)
 *   ~/engagement/scans/legacy-services.txt     nmap -oN output (method-notes)
 *   ~/engagement/scans/web01-headers.txt       tee (method-notes)
 *   ~/engagement/scans/cam01-telnet.txt        nmap -oN (method-finding)
 *   ~/engagement/scans/halcyon-axfr.txt        tee (method-finding)
 *   ~/engagement/findings/F-01-*.md, F-02-*.md written from the seeded template
 *   /usr/share/kalima/text/finding-template.md (seeded here, read-only)
 * Steps that open an editor give a testSolution that produces the same file.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const HOME = '/home/kali';
  const ENG = HOME + '/engagement';
  const NOTES = ENG + '/notes.md';
  const TEMPLATE = '/usr/share/kalima/text/finding-template.md';
  const F1 = ENG + '/findings/F-01-cam01-telnet.md';
  const F2 = ENG + '/findings/F-02-ns1-zone-transfer.md';

  K.fsSeeds.push((machine) => {
    if (machine.profile !== 'kali') return;
    machine.vfs.seed(TEMPLATE, T(
      '# Finding: <short title>',
      '',
      'Finding ID:    F-00',
      'Date:          <YYYY-MM-DD>',
      'Affected host: <host name and address>',
      'Severity:      <informational, low, medium or high, and why>',
      '',
      '## Observation',
      '<what you saw, in one or two sentences, without interpretation>',
      '',
      '## Evidence',
      'Command: <the exact command line>',
      'Saved output: <path of the saved output>',
      '<the relevant lines of the output>',
      '',
      '## Why it matters',
      '<the risk to the client, in plain words>',
      '',
      '## Recommendation',
      '<what the client should do, specific enough to act on>',
      ''
    ), { mode: 0o644, uid: 0, gid: 0 });
  });

  /** A file check that the document no longer contains template placeholders. */
  const filled = (path) => ({ not: { file: { path, contains: /<[a-z][^>\n]*>/ } } });

  /* ----------------------------------------------------------------- phases */
  const phases = {
    id: 'method-phases',
    title: 'The phases of an assessment',
    minutes: 10,
    objectives: [
      'Name the four phases of a penetration test in NIST SP 800-115 and what each produces',
      'Say which phases this course practised and which it only described',
      'Place a Kali tool category in its phase using kalima atlas',
    ],
    intro: T(
      'Kali contains hundreds of tools. What makes them an assessment and not a pile of programs is a method. NIST SP 800-115, the US government\'s guide to security testing, describes a penetration test in four phases: **planning**, **discovery**, **attack** and **reporting**. Planning comes first and agrees what may be tested. Discovery finds what is there and what looks weak. Attack tries to confirm a weakness within the agreed limits. Reporting runs alongside all of them and ends with a document the client can act on.',
      '',
      'Knowing the phase tells you what you are allowed to do, and what comes next.'
    ),
    steps: [
      {
        id: 'ls',
        prompt: T(
          'Your engagement folder already holds the output of the first phase. Look at it:',
          '',
          '```',
          'ls ~/engagement',
          '```',
          '',
          'Over the course you have mostly worked in the first two phases: the paperwork of planning, and discovery of hosts, ports, services and names. You have not worked in the attack phase.'
        ),
        hint: 'Type `ls ~/engagement`.',
        solution: 'ls ~/engagement',
        check: { cmd: 'ls', out: /scope\.txt/ },
      },
      {
        id: 'plan-q',
        prompt: 'Two of the files record decisions made in the planning phase: what you may test, and how you agreed to work. Type the two file names, separated by a space or a comma.',
        hint: 'One is about the range of addresses, the other about the rules. Both end in `.txt`.',
        solution: 'scope.txt rules-of-engagement.txt',
        answer: /^(scope(\.txt)?[\s,]+(and\s+)?rules-of-engagement(\.txt)?|rules-of-engagement(\.txt)?[\s,]+(and\s+)?scope(\.txt)?)$/i,
      },
      {
        id: 'atlas-info',
        prompt: T(
          'The Kali menu groups tools into categories, and `kalima atlas` lets you browse the same map. Each category page says where it sits in the method. Read the one for discovery:',
          '',
          '```',
          'kalima atlas information',
          '```',
          '',
          'The beginning of a category name is enough.'
        ),
        hint: 'Type `kalima atlas information-gathering`, or just `kalima atlas information`.',
        solution: 'kalima atlas information',
        check: { cmd: 'kalima', out: /Information Gathering/ },
      },
      {
        id: 'vuln',
        prompt: T(
          'Next, the category that compares what discovery found with known weaknesses:',
          '',
          '```',
          'kalima atlas vuln',
          '```',
          '',
          'Read its description. NIST puts vulnerability scanning at the end of discovery, not in the attack phase, because a scanner only reports what a service seems to be. It does not prove anything.'
        ),
        hint: 'Type `kalima atlas vuln`.',
        solution: 'kalima atlas vuln',
        check: { cmd: 'kalima', out: /Vulnerability Analysis/ },
      },
      {
        id: 'leads-q',
        prompt: 'The category text says that the results of vulnerability scanning have to be confirmed by hand. What does it call these results? Type one word.',
        hint: 'Read the last sentence of the description you just displayed.',
        solution: 'leads',
        answer: /^leads?$/i,
      },
      {
        id: 'attack',
        prompt: T(
          'Now the attack phase:',
          '',
          '```',
          'kalima atlas exploitation',
          '```',
          '',
          'Notice that none of its tools is simulated in this course, and that is deliberate. The attack phase needs the most careful authorization: the rules of engagement must say that confirming a weakness is allowed, on which systems, and with what limits.'
        ),
        hint: 'Type `kalima atlas exploitation`.',
        solution: 'kalima atlas exploitation',
        check: { cmd: 'kalima', out: /Exploitation Tools/ },
      },
      {
        id: 'loop-q',
        prompt: 'The description says what a confirmed finding usually leads back into. Which phase is that? Type one word.',
        hint: 'Phases are not a straight line. Read the last sentence of the description.',
        solution: 'discovery',
        answer: /^(further\s+|more\s+)?discovery$/i,
      },
      {
        id: 'report',
        prompt: T(
          'Last, the category for the phase that runs alongside the others:',
          '',
          '```',
          'kalima atlas reporting',
          '```'
        ),
        hint: 'Type `kalima atlas reporting`.',
        solution: 'kalima atlas reporting',
        check: { cmd: 'kalima', out: /Reporting Tools/ },
      },
      {
        id: 'script-q',
        prompt: 'One tool in that list makes a typescript of a terminal session: it records what you type and what appears. Which tool is it? Type its name.',
        hint: 'Read the "What it is" column of the table.',
        solution: 'script',
        answer: /^script$/i,
      },
    ],
    quiz: [
      { q: 'In which phase of NIST SP 800-115 do you agree the scope and the rules of engagement?', choices: ['Planning', 'Discovery', 'Attack', 'Reporting'], answer: 0, why: 'Planning comes first. Nothing is scanned or probed until it has produced written authorization and agreed limits.' },
      { q: 'A scanner lists a possible weakness on a host. What is the right way to treat it?', choices: ['Put it in the report as a confirmed finding', 'As a lead to confirm, if the rules of engagement allow, before it is reported as fact', 'Ignore it because scanners are unreliable', 'Run every exploit you have against the host'], answer: 1, why: 'Scanner output is a lead. Confirming it is attack-phase work that needs permission, and a finding in a report should rest on evidence.' },
      { q: 'Why is reporting not left until the last day?', choices: ['Clients prefer long engagements', 'Notes and evidence made as you go are what the report is built from, and memory is unreliable', 'Reports must be written in the attack phase', 'The tools write the report automatically'], answer: 1, why: 'NIST describes reporting as running alongside the other phases. Commands, times and saved output captured at the moment of discovery make findings reproducible.' },
    ],
    refs: ['NIST SP 800-115, section 5', 'Kali Linux Revealed', 'kalima atlas'],
  };

  /* ------------------------------------------------------------------ notes */
  const notes = {
    id: 'method-notes',
    title: 'Notes that make work reproducible',
    minutes: 10,
    objectives: [
      'Write dated notes entries that record the exact command and where its output is saved',
      'Save tool output with nmap -oN and with tee while still reading it on screen',
      'Keep one layout in ~/engagement/notes.md so that entries can be found with grep',
    ],
    intro: T(
      'A finding is only useful if someone else can check it. Three weeks later, a client asks "how did you see that?", and your memory will not do. Good notes answer the question: when you did it, the exact command, where the output is saved, and what you concluded.',
      '',
      'The method is simple. Save raw output to a file as the tool runs. Add a short dated entry to one notes file. Use the same layout every time, so a search finds everything.'
    ),
    steps: [
      {
        id: 'cat',
        prompt: T(
          'Open the notes file in your engagement folder. It has three headings, one for hosts, one for findings and one for commands:',
          '',
          '```',
          'cat ~/engagement/notes.md',
          '```'
        ),
        hint: 'Type `cat ~/engagement/notes.md`.',
        solution: 'cat ~/engagement/notes.md',
        check: { cmd: 'cat', argsRe: /notes\.md/, exit: 0 },
      },
      {
        id: 'date',
        prompt: T(
          'Every entry starts with a time. Use a format that sorts and cannot be misread: year, month, day, then hour and minute. `date` accepts a format string, where `%F` is the date and `%H:%M` the time:',
          '',
          '```',
          'date \'+%F %H:%M\'',
          '```'
        ),
        hint: 'Type `date \'+%F %H:%M\'`.',
        solution: 'date \'+%F %H:%M\'',
        check: { cmd: 'date', out: /^\d{4}-\d\d-\d\d \d\d:\d\d$/m },
      },
      {
        id: 'oN',
        prompt: T(
          'Run a check and keep its output. The options `-oN file` tell nmap to write its normal output to a file as well as printing it. These two hosts are in scope. The ports are FTP (21) and Telnet (23), and `-sV` asks each service to identify itself:',
          '',
          '```',
          'nmap -sV -p 21,23 -oN ~/engagement/scans/legacy-services.txt 10.10.10.20 10.10.10.80',
          '```',
          '',
          'The saved file starts with a comment line that records the command and the time. That line is evidence of how the scan was run.'
        ),
        hint: 'The option is `-oN` followed by a file name. Give the target addresses at the end.',
        solution: 'nmap -sV -p 21,23 -oN ~/engagement/scans/legacy-services.txt 10.10.10.20 10.10.10.80',
        check: { all: [{ cmd: 'nmap', args: ['-oN'], out: /Nmap scan report/ }, { file: { path: ENG + '/scans/legacy-services.txt', contains: /Nmap scan report/ } }] },
      },
      {
        id: 'who-q',
        prompt: 'Read the scan. Which host has Telnet open? Type its name (for example `web01`).',
        hint: 'Look for `23/tcp open telnet`, then at the name in the line above it that begins `Nmap scan report for`.',
        solution: 'cam01',
        answer: /^cam01(\.halcyon\.lab)?$|^10\.10\.10\.80$/i,
      },
      {
        id: 'tee',
        prompt: T(
          'Not every tool has an output option. `tee` copies what it reads to a file and also passes it on, so you still see it. Fetch only the response headers of web01\'s home page and save them:',
          '',
          '```',
          'curl -sI http://web01/ | tee ~/engagement/scans/web01-headers.txt',
          '```',
          '',
          '`-I` asks for the headers and not the page. Find the `Server` header in the output.'
        ),
        hint: 'Pipe `curl -sI http://web01/` into `tee` and give it the file name.',
        solution: 'curl -sI http://web01/ | tee ~/engagement/scans/web01-headers.txt',
        check: { all: [{ cmd: 'tee' }, { file: { path: ENG + '/scans/web01-headers.txt', contains: /Server: nginx/ } }] },
      },
      {
        id: 'entry',
        prompt: T(
          'Now the entry in the notes. Each one has the same four parts: a heading with the time and a title, then `Command:`, `Saved:` and `Observed:`. `printf` fills the `%s` with the time and the `\\n` marks end each line. `>>` appends, so earlier notes are kept:',
          '',
          '```',
          'printf \'\\n### %s web01 response headers\\nCommand: curl -sI http://web01/\\nSaved: scans/web01-headers.txt\\nObserved: Server header reports nginx/1.26.3\\n\' "$(date \'+%F %H:%M\')" >> ~/engagement/notes.md',
          '```',
          '',
          'The observation says what you saw, not what you think it means. Interpretation belongs in the finding.'
        ),
        hint: 'Copy the line from the prompt. If it fails, check the quotes and that you used `>>` and not `>`, which would replace the whole file.',
        solution: 'printf \'\\n### %s web01 response headers\\nCommand: curl -sI http://web01/\\nSaved: scans/web01-headers.txt\\nObserved: Server header reports nginx/1.26.3\\n\' "$(date \'+%F %H:%M\')" >> ~/engagement/notes.md',
        check: { all: [{ line: />>\s*\S*notes\.md/ }, { file: { path: NOTES, contains: /Command: curl -sI http:\/\/web01\// } }] },
      },
      {
        id: 'tail',
        prompt: T(
          'Read back what you wrote. `tail` shows the end of a file, and `-n 6` asks for six lines:',
          '',
          '```',
          'tail -n 6 ~/engagement/notes.md',
          '```'
        ),
        hint: 'Type `tail -n 6 ~/engagement/notes.md`.',
        solution: 'tail -n 6 ~/engagement/notes.md',
        check: { cmd: 'tail', argsRe: /notes\.md/, out: /Command: curl/ },
      },
      {
        id: 'append-q',
        prompt: 'Suppose you wanted `tee` to add to an existing file and not replace it. Which option makes it append? Type the option. If you are not sure, `tee --help` or `man tee` will tell you.',
        hint: 'It is a single letter after a dash. It matches the append operator you used with `>>`.',
        solution: '-a',
        answer: /^-a$|^-a,?\s*--append$|^--append$/i,
      },
      {
        id: 'grep',
        prompt: T(
          'The point of one layout is that a search finds every entry. List every command you have recorded, with line numbers:',
          '',
          '```',
          'grep -n "Command:" ~/engagement/notes.md',
          '```'
        ),
        hint: 'Use `grep -n "Command:"` on the notes file.',
        solution: 'grep -n "Command:" ~/engagement/notes.md',
        check: { cmd: 'grep', args: ['-n'], argsRe: /notes\.md/, out: /Command: curl/ },
      },
    ],
    quiz: [
      { q: 'What does `nmap -oN scan.txt 10.10.10.10` do compared with plain `nmap 10.10.10.10`?', choices: ['It scans more ports', 'It prints the same results and also saves them to scan.txt', 'It saves the results and prints nothing', 'It makes the scan quieter'], answer: 1, why: '-oN writes the normal-format output to the file while the scan still prints to the terminal.' },
      { q: 'You run `echo "note" > notes.md` by mistake instead of `>>`. What happens?', choices: ['The note is added at the end', 'The old contents of notes.md are replaced by the single line', 'The command fails because the file exists', 'Nothing, the shell ignores `>`'], answer: 1, why: 'A single `>` truncates the file first. Appending needs `>>`. This is a common way to lose notes, so check the operator before pressing Enter.' },
      { q: 'Which note will let a colleague repeat your check?', choices: ['Looked at web01, seems fine', 'Checked headers on 14 Nov', '2026-11-14 10:05, curl -sI http://web01/, output in scans/web01-headers.txt', 'Used the usual tools'], answer: 2, why: 'It has the time, the exact command and the location of the output. The others cannot be repeated or verified.' },
    ],
    refs: ['nmap(1)', 'tee(1)', 'date(1)', 'NIST SP 800-115, section 7'],
  };

  /* ---------------------------------------------------------------- finding */
  const finding = {
    id: 'method-finding',
    title: 'Writing up a finding',
    minutes: 12,
    objectives: [
      'Turn an observation into a finding with a title, affected host, evidence, why it matters and a recommendation',
      'Quote evidence by giving the exact command and the relevant lines of its output',
      'Keep a finding to what you observed, without claiming more',
    ],
    intro: T(
      'A finding is how an observation reaches the person who can fix it. It has to stand on its own: someone who was not there should understand what is affected, see the evidence, know why it matters and know what to do.',
      '',
      'In this lesson you write two findings from things you can observe in the lab with discovery tools: a clear-text service and a name server that hands out its whole zone. Nothing is exploited. You report what was visible, and say exactly that.'
    ),
    steps: [
      {
        id: 'evidence',
        prompt: T(
          'Collect the evidence first, and save it. Ask cam01 (in scope) which service listens on the Telnet port and what it calls itself:',
          '',
          '```',
          'nmap -sV -p 23 -oN ~/engagement/scans/cam01-telnet.txt 10.10.10.80',
          '```'
        ),
        hint: 'Like the last lesson: `nmap -sV -p 23 -oN FILE 10.10.10.80`.',
        solution: 'nmap -sV -p 23 -oN ~/engagement/scans/cam01-telnet.txt 10.10.10.80',
        check: { all: [{ cmd: 'nmap', args: ['-oN'], out: /23\/tcp\s+open\s+telnet/ }, { file: { path: ENG + '/scans/cam01-telnet.txt', contains: /telnet/ } }] },
      },
      {
        id: 'who-q',
        prompt: 'What does the VERSION column say the service is? Type the program name as it appears (two words).',
        hint: 'It is on the `23/tcp` line, after `telnet`.',
        solution: 'BusyBox telnetd',
        answer: /^busybox\s+telnetd$/i,
      },
      {
        id: 'template',
        prompt: T(
          'Use a template so that every finding has the same parts. One is installed at `/usr/share/kalima/text/finding-template.md`. Copy it into a findings folder in the engagement, under a name that holds the finding number, the host and the subject:',
          '',
          '```',
          'mkdir -p ~/engagement/findings',
          'cp /usr/share/kalima/text/finding-template.md ~/engagement/findings/F-01-cam01-telnet.md',
          '```',
          '',
          'Read the copy with `cat`. The parts in angle brackets are for you to replace.'
        ),
        hint: 'Make the folder with `mkdir -p`, then `cp` the template to the new file name.',
        solution: ['mkdir -p ~/engagement/findings', 'cp /usr/share/kalima/text/finding-template.md ~/engagement/findings/F-01-cam01-telnet.md'],
        check: { file: { path: F1, contains: /## Recommendation/ } },
      },
      {
        id: 'write1',
        prompt: T(
          'Open the copy in `nano` and replace every part in angle brackets. Keep to what you saw:',
          '',
          '- **Title and ID**: name the problem, for example "Telnet service enabled on camera". Set the ID to F-01 and the date.',
          '- **Affected host**: `cam01.halcyon.lab (10.10.10.80)`.',
          '- **Observation**: Telnet (BusyBox telnetd) accepts connections on port 23.',
          '- **Evidence**: the command you ran, the file where its output is saved, and the `23/tcp open telnet` line.',
          '- **Why it matters**: Telnet does not encrypt, so anyone who can observe traffic between an administrator and the device can read the login as it is typed. Say that no login was attempted.',
          '- **Recommendation**: disable Telnet and use SSH if the device supports it; if not, restrict access to the administration network.',
          '',
          'Save with Ctrl-O and Enter, and leave with Ctrl-X. The step is done when no angle-bracket placeholder is left and the file names the host, the protocol and a recommendation.'
        ),
        hint: 'Run `nano ~/engagement/findings/F-01-cam01-telnet.md`. Move with the arrow keys, delete a placeholder with Backspace, then type your text. The check wants `10.10.10.80`, `Telnet`, the word `Command:` followed by your nmap command, and no `<...>` left.',
        solution: 'nano ~/engagement/findings/F-01-cam01-telnet.md',
        testSolution: T(
          'cat > ~/engagement/findings/F-01-cam01-telnet.md <<\'EOF\'',
          '# Finding: Telnet service enabled on camera',
          '',
          'Finding ID:    F-01',
          'Date:          2026-11-13',
          'Affected host: cam01.halcyon.lab (10.10.10.80)',
          'Severity:      medium, because the protocol offers no encryption',
          '',
          '## Observation',
          'The camera accepts connections on TCP port 23 and identifies itself as BusyBox telnetd.',
          '',
          '## Evidence',
          'Command: nmap -sV -p 23 -oN ~/engagement/scans/cam01-telnet.txt 10.10.10.80',
          'Saved output: scans/cam01-telnet.txt',
          '23/tcp open  telnet  BusyBox telnetd',
          '',
          '## Why it matters',
          'Telnet sends everything unencrypted, so anyone able to observe the traffic can read an administrator login. No login was attempted.',
          '',
          '## Recommendation',
          'Disable Telnet and use SSH if the device supports it. Otherwise restrict access to the administration network.',
          'EOF'
        ),
        check: { all: [
          { file: { path: F1, contains: /10\.10\.10\.80/ } },
          { file: { path: F1, contains: /telnet/i } },
          { file: { path: F1, contains: /Command:\s*nmap/ } },
          { file: { path: F1, contains: /## Recommendation\s*\n\s*\S/ } },
          filled(F1),
        ] },
      },
      {
        id: 'axfr',
        prompt: T(
          'A second observation, this one about DNS. A **zone transfer** (AXFR) is how a secondary name server copies a whole zone from the primary. If the primary answers anyone who asks, so does it for you. Ask ns1, the lab\'s authoritative server, and save what it returns:',
          '',
          '```',
          'dig @10.10.10.53 halcyon.lab axfr | tee ~/engagement/scans/halcyon-axfr.txt',
          '```',
          '',
          'The request is a normal DNS query from an in-scope machine. Read the last lines for the number of records.'
        ),
        hint: 'Use `dig @10.10.10.53 halcyon.lab axfr` and pipe it into `tee` with a file name.',
        solution: 'dig @10.10.10.53 halcyon.lab axfr | tee ~/engagement/scans/halcyon-axfr.txt',
        check: { all: [{ cmd: 'dig', args: ['axfr'], out: /XFR size/ }, { file: { path: ENG + '/scans/halcyon-axfr.txt', contains: /XFR size/ } }] },
      },
      {
        id: 'records-q',
        prompt: 'How many records did the transfer return? The `XFR size` line at the end gives it. Type the number.',
        hint: 'Look at the line that starts with `;; XFR size:`.',
        solution: '21',
        answer: /^21(\s*records)?$/i,
      },
      {
        id: 'write2',
        prompt: T(
          'Write the second finding yourself, as `~/engagement/findings/F-02-ns1-zone-transfer.md`, starting from the template. Your own words, but each part must be there:',
          '',
          '- the affected host, `ns1.halcyon.lab (10.10.10.53)`;',
          '- the observation, in one or two sentences, that the server returned the complete zone to a request from the test machine;',
          '- the evidence: the `dig` command, the saved file and the record count;',
          '- why it matters: a zone lists every host name in it, which helps anyone who is mapping the network;',
          '- a recommendation: allow transfers only to the secondary name servers.',
          '',
          'Keep it to what you saw. You do not know whether the transfer is also allowed from outside the lab, so do not say it is.'
        ),
        hint: 'Copy the template with `cp`, then edit it with `nano`. The check wants `10.10.10.53`, the words `zone transfer` or `AXFR`, a `Command:` line with `dig`, a recommendation, and no `<...>` placeholders left.',
        solution: ['cp /usr/share/kalima/text/finding-template.md ~/engagement/findings/F-02-ns1-zone-transfer.md', 'nano ~/engagement/findings/F-02-ns1-zone-transfer.md'],
        testSolution: T(
          'cat > ~/engagement/findings/F-02-ns1-zone-transfer.md <<\'EOF\'',
          '# Finding: Zone transfer allowed from the test machine',
          '',
          'Finding ID:    F-02',
          'Date:          2026-11-13',
          'Affected host: ns1.halcyon.lab (10.10.10.53)',
          'Severity:      low to medium, because it exposes names but does not change anything',
          '',
          '## Observation',
          'The name server returned the complete halcyon.lab zone (21 records) in answer to a zone transfer request from the test machine.',
          '',
          '## Evidence',
          'Command: dig @10.10.10.53 halcyon.lab axfr',
          'Saved output: scans/halcyon-axfr.txt',
          ';; XFR size: 21 records',
          '',
          '## Why it matters',
          'A zone lists every host name in it. Anyone who can request a transfer gets a ready-made map of the network.',
          '',
          '## Recommendation',
          'Allow zone transfers only to the secondary name servers, by address or by key.',
          'EOF'
        ),
        check: { all: [
          { file: { path: F2, contains: /10\.10\.10\.53/ } },
          { file: { path: F2, contains: /zone transfer|axfr/i } },
          { file: { path: F2, contains: /Command:\s*dig/ } },
          { file: { path: F2, contains: /## Recommendation\s*\n\s*\S/ } },
          filled(F2),
        ] },
      },
      {
        id: 'log',
        prompt: T(
          'Record in the notes that the two findings exist, so that the notes and the findings folder agree:',
          '',
          '```',
          'echo "F-01 cam01 Telnet, F-02 ns1 zone transfer: see findings/" >> ~/engagement/notes.md',
          '```'
        ),
        hint: 'Append with `>>` to `~/engagement/notes.md`.',
        solution: 'echo "F-01 cam01 Telnet, F-02 ns1 zone transfer: see findings/" >> ~/engagement/notes.md',
        check: { all: [{ line: />>\s*\S*notes\.md/ }, { file: { path: NOTES, contains: /F-01.*F-02/ } }] },
      },
    ],
    quiz: [
      { q: 'Which sentence belongs in the "Observation" part of a finding?', choices: ['An attacker could take over the camera', 'The camera accepts connections on port 23 and identifies itself as BusyBox telnetd', 'The client should be embarrassed about this', 'Telnet is a bad protocol'], answer: 1, why: 'An observation states what was seen. Risk belongs in "Why it matters" and advice in "Recommendation".' },
      { q: 'You saw that a zone transfer worked from the lab. Which statement can you put in the report?', choices: ['Zone transfers work from the whole internet', 'The server answered a zone transfer request from the test machine at 10.10.10.5', 'The DNS server was compromised', 'The domain is vulnerable to takeover'], answer: 1, why: 'Report what you tested and from where. Anything beyond that is a guess that you would need to verify, within scope, before claiming it.' },
      { q: 'Why does a finding include the exact command and a saved output file?', choices: ['To make the report longer', 'So that the client or a colleague can repeat the check and see the same result', 'Because the tool requires it', 'To prove that you worked hard'], answer: 1, why: 'Evidence that can be repeated is what separates a finding from an opinion.' },
    ],
    refs: ['NIST SP 800-115, section 7', 'dig(1)', 'RFC 5936 (DNS zone transfer protocol)'],
  };

  /* ------------------------------------------------------------------- next */
  const next = {
    id: 'method-next',
    title: 'Where to go from here',
    minutes: 10,
    objectives: [
      'Describe a safe way to keep practicing and what a home lab should contain',
      'Name where the official Kali documentation lives',
      'Explain why written authorization must come before any testing of systems you do not own',
      'Look up facts in the lab on your own, from scanner and lookup output',
    ],
    intro: T(
      'You can now operate a security workstation: move around the system, read network traffic, discover hosts and services, and write up what you saw. The rest is practice, and the practice has to happen in the right place.',
      '',
      'This last lesson points you onward and then tests your ability to find things out for yourself. The capstone questions are not answered by the lesson. You answer them by running commands in the lab, the way you would on a job.'
    ),
    steps: [
      {
        id: 'scope',
        prompt: T(
          'Before the capstone, do what you do before any work: read the scope. It lists what you may test:',
          '',
          '```',
          'kalima scope',
          '```',
          '',
          'Everything you do in the capstone stays inside `10.10.10.0/24` and `*.halcyon.lab`.'
        ),
        hint: 'Type `kalima scope`.',
        solution: 'kalima scope',
        check: { cmd: 'kalima', out: /10\.10\.10\.0\/24/ },
      },
      {
        id: 'lab',
        info: true,
        prompt: T(
          '**Build a lab of machines you own.** The safest place to practice is a network that is yours. A computer with a hypervisor (VirtualBox, VMware or KVM) is enough: Kali itself in one virtual machine, and one or two target machines in others, on a private virtual network with no route to anything else. Use systems that are published for training, or systems you install and configure yourself. Keep the lab isolated, and take a snapshot before you change a machine so that you can go back.',
          '',
          'Practice what you did here, against your own machines: discovery, reading captures, writing notes and findings. Treat the lab like a client engagement, with a scope file, a notes file and findings.'
        ),
      },
      {
        id: 'docs',
        info: true,
        prompt: T(
          '**Read the official documentation.** The Kali project maintains its documentation at `kali.org/docs`, and a page for each tool at `kali.org/tools` that says which package provides it and links to its upstream project. *Kali Linux Revealed* is the project\'s own book on installing, configuring and running Kali, and it is free to read. On the machine, `man` and `--help` are always available and always match the version you have installed.',
          '',
          'Tools change between releases. When something here behaves differently on a real system, the manual page of that system is right.'
        ),
      },
      {
        id: 'auth',
        info: true,
        prompt: T(
          '**Get written authorization before touching anything else.** Testing a system without the owner\'s permission is unlawful in most countries, whatever your intentions, and "I was only looking" is not a defense. Permission must be in writing, from someone who has the authority to give it, and it must say which systems, what kinds of testing, when, and who to contact if something goes wrong. The scope file and the rules of engagement in your engagement folder are the small version of that paper.',
          '',
          'The same applies to networks you pass through every day. Capturing traffic or scanning on a network you do not run, including a workplace, a school or a public network, is not practice. It is a decision for the owner to make.'
        ),
      },
      {
        id: 'q-port',
        prompt: T(
          '**Capstone 1 of 6.** One host in the lab runs a database server on TCP port 3306. Find out which. Scan the whole lab range for that one port, and show only open ports:',
          '',
          '```',
          'nmap -p 3306 --open 10.10.10.0/24',
          '```',
          '',
          'Run it, then type the name of the host that answers (for example `web01`).'
        ),
        hint: 'Run `nmap -p 3306 --open 10.10.10.0/24` and read the line `Nmap scan report for ...` above the open port.',
        solution: 'db01',
        answer: /^db01(\.halcyon\.lab)?$|^10\.10\.10\.30$/i,
      },
      {
        id: 'q-port2',
        prompt: 'Capstone 2 of 6. Port 9100 is the raw printing port that network printers use (JetDirect). Which host answers on it? Scan the range as before and type the host name.',
        hint: 'The same scan with a different port number: `nmap -p 9100 --open 10.10.10.0/24`.',
        solution: 'printer',
        answer: /^printer(\.halcyon\.lab)?$|^10\.10\.10\.60$/i,
      },
      {
        id: 'q-server',
        prompt: 'Capstone 3 of 6. What does the web server on web01 call itself? Ask for the response headers of its home page and read the `Server` header. Type the product and version as shown, with the slash.',
        hint: 'Use `curl -sI http://web01/`; the line you need begins with `Server:`.',
        solution: 'nginx/1.26.3',
        answer: /^nginx\/1\.26\.3$/i,
      },
      {
        id: 'q-ftp',
        prompt: 'Capstone 4 of 6. When you connect to the FTP service on files01, it sends a greeting line before you type anything, and the line names the software. Connect with `nc -w 3 files01 21 </dev/null` (netcat, closing after three seconds), or ask nmap with `-sV`. Which software and version is it? Type the name and version.',
        hint: 'The banner begins with the code `220`. The software is the name in parentheses, followed by the version number.',
        solution: 'vsFTPd 3.0.5',
        answer: /^vs-?ftpd[\s_-]*3\.0\.5$/i,
      },
      {
        id: 'q-ptr',
        prompt: 'Capstone 5 of 6. The address 10.10.10.70 has a name. Look it up with a reverse lookup. `host 10.10.10.70` or `dig @10.10.10.53 -x 10.10.10.70 +short` will do. What is the host name? Type it.',
        hint: 'A reverse lookup asks the DNS for the name that belongs to an address. The answer ends in `.halcyon.lab.`',
        solution: 'dev01.halcyon.lab',
        answer: /^dev01(\.halcyon\.lab\.?)?$/i,
      },
      {
        id: 'q-ssh',
        prompt: 'Capstone 6 of 6. Every SSH server announces its software the moment you connect, in one line that begins `SSH-2.0-`. Read it from web01: `nc -w 3 10.10.10.10 22 </dev/null`. Which OpenSSH version does it name? Type the version as it appears after `OpenSSH_` (for example `9.2p1`).',
        hint: 'The banner looks like `SSH-2.0-OpenSSH_<version> <distribution>`. Type only the version part.',
        solution: '10.0p2',
        answer: /^(openssh[_ ])?10\.0p2$/i,
      },
    ],
    quiz: [
      { q: 'A friend offers to let you test their company\'s website "for practice", saying it will be fine. What do you need first?', choices: ['Nothing, they are your friend', 'Written authorization from someone with the authority to grant it, naming what may be tested', 'A faster computer', 'A newer version of Kali'], answer: 1, why: 'Permission has to come from the system owner, in writing and with defined limits. A friend who does not own the system cannot give it.' },
      { q: 'Which is the best place to practice scanning?', choices: ['The network at your school or workplace', 'A public Wi-Fi network', 'An isolated lab of virtual machines you own', 'Your neighbor\'s network'], answer: 2, why: 'In a lab you own, nobody can be harmed and nobody needs to give permission. Everything else belongs to someone else.' },
      { q: 'A tool behaves differently on your real Kali system than in this simulator. Which source is right?', choices: ['This simulator', 'The manual page and documentation of the installed system', 'A forum post from several years ago', 'Whatever the tool printed most recently'], answer: 1, why: 'The installed version\'s own manual matches the tool you are running. The simulator is a training aid and cannot follow every release.' },
    ],
    refs: ['Kali Linux Revealed', 'kali.org/docs', 'NIST SP 800-115, section 5', 'nmap(1)', 'nc(1)'],
  };

  K.lessons.register({
    id: 'method',
    title: 'Methodology, notes and reporting',
    order: 150,
    summary: 'The phases of an assessment, notes that make work reproducible, writing up findings, and where to practice next.',
    lessons: [phases, notes, finding, next],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
