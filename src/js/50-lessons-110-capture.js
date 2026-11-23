/* Kalima — curriculum module "capture": watching the wire with tcpdump.
 *
 * Lessons: cap-first, cap-filters, cap-cleartext, cap-files.
 * Everything is captured on the lab segment (eth0) from traffic the learner
 * generates against web01, which is in scope. Files written: text captures
 * under ~/practice/capture/ and one binary capture under ~/engagement/captures/.
 *
 * Replay note: a background capture needs a moment to start before the traffic
 * it should see is generated, so every solution that generates traffic starts
 * with `sleep 1;`. Background captures use -c with a count the following
 * commands produce, so `wait` returns by itself. `sudo -v` comes first because
 * a background job cannot ask for a password.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const HOME = '/home/kali';
  const PRACTICE = HOME + '/practice/capture';
  const PW = ['kali'];

  /* ------------------------------------------------------------------ first */
  const first = {
    id: 'cap-first',
    title: 'Your first packet capture',
    minutes: 9,
    objectives: [
      'Explain why capturing packets needs root and run tcpdump with sudo',
      'Stop a capture after a fixed number of packets with -c',
      'Read one packet line: time, protocol, addresses and detail',
      'Turn off name lookups with -n and read the summary at the end',
    ],
    intro: T(
      'A packet capture is a recording of what crosses a network interface. It is how you check what a tool really sent, why a connection fails, and which services talk in the clear. On a security workstation it is one of the first things you reach for.',
      '',
      'Capturing is also sensitive. A capture can contain other people\'s traffic, so the operating system only lets root do it, and you only do it on networks you are authorized to monitor. In this lab that is the Halcyon Freight segment, `10.10.10.0/24`.'
    ),
    steps: [
      {
        id: 'denied',
        prompt: T(
          'Start with what happens when you are not root. `tcpdump` is the standard command-line capture tool. The option `-i eth0` names the interface to listen on, and `-c 3` stops after three packets:',
          '',
          '```',
          'tcpdump -c 3 -i eth0',
          '```',
          '',
          'Read the error. Opening a raw socket on an interface is a privileged operation.'
        ),
        hint: 'Type `tcpdump -c 3 -i eth0` without sudo.',
        solution: 'tcpdump -c 3 -i eth0',
        check: { cmd: 'tcpdump', out: /permission to perform this packet capture/ },
      },
      {
        id: 'sudo',
        prompt: T(
          'Run the same capture with `sudo`, which runs one command as root. It asks for your password the first time (`kali`) and remembers it for a few minutes:',
          '',
          '```',
          'sudo tcpdump -c 5 -i eth0',
          '```',
          '',
          'The lab is quiet, but the machines on it still talk to each other: name lookups, clock synchronization, address resolution. Wait for the five packets to arrive.'
        ),
        input: PW,
        hint: 'Put `sudo` in front of the command that failed, and use `-c 5`.',
        solution: 'sudo tcpdump -c 5 -i eth0',
        check: { cmd: 'tcpdump', user: 'root', args: ['-c'], out: /5 packets captured/ },
      },
      {
        id: 'header-q',
        prompt: T(
          'Two lines come before the packets. The first says verbose output is suppressed. The second begins `listening on eth0, link-type EN10MB (Ethernet), snapshot length ...`.',
          '',
          'The **snapshot length** is how many bytes of each packet tcpdump keeps. Find it in your output and type the number.'
        ),
        hint: 'Scroll up to the line that starts with `listening on eth0`. The number ends the line, before `bytes`.',
        solution: '262144',
        answer: /^262144(\s*bytes)?$/i,
      },
      {
        id: 'read-q',
        prompt: T(
          'Now read one packet line. Each line begins with the time of capture, then the protocol, then the two ends of the conversation with `>` between them, then detail that depends on the protocol. Here is a line like the ones you saw:',
          '',
          '```',
          '14:30:03.519481 IP files01.halcyon.lab.48451 > ns1.halcyon.lab.domain: 57746+ A? files01.halcyon.lab. (33)',
          '```',
          '',
          'Which host sent this packet, and which service did it ask? Type the two names, sender first, separated by a space (for example `web01 http`).'
        ),
        hint: 'The name before `>` is the sender. The word after the dot at the end of the receiver\'s name is the port, shown by its service name: `domain` is DNS.',
        solution: 'files01 domain',
        answer: /^files01(\.halcyon\.lab)?\s+(domain|dns)$/i,
      },
      {
        id: 'numeric',
        prompt: T(
          'tcpdump turned addresses and ports into names, which means it asked the resolver about every address it saw. That slows a capture and adds its own lookups to the traffic you are trying to watch. The option `-n` prints numbers instead:',
          '',
          '```',
          'sudo tcpdump -n -c 5 -i eth0',
          '```',
          '',
          'Compare with the last capture. Addresses such as `10.10.10.40` replace the host names. The port still shows as a service name; `-nn` would show it as a number too.'
        ),
        hint: 'Add `-n` to the command you ran before.',
        solution: 'sudo tcpdump -n -c 5 -i eth0',
        check: { all: [{ cmd: 'tcpdump', args: ['-n'], user: 'root' }, { out: /5 packets captured/ }, { not: { out: /halcyon\.lab/ } }] },
      },
      {
        id: 'count',
        prompt: T(
          'Build it yourself. Capture **eight** packets on `eth0` with no name lookups. Then look at the three lines at the end:',
          '',
          '- `packets captured` is how many tcpdump printed.',
          '- `packets received by filter` is how many matched your filter before it stopped.',
          '- `packets dropped by kernel` counts packets the system had no room to hand over. On a busy link that number rising means your capture is missing traffic.'
        ),
        hint: 'The option for the count is `-c`, as before; the lab\'s interface is `eth0`.',
        solution: 'sudo tcpdump -n -c 8 -i eth0',
        check: { all: [{ cmd: 'tcpdump', args: ['-n', '-c'], user: 'root' }, { out: /8 packets captured/ }] },
      },
      {
        id: 'list',
        prompt: T(
          'You chose `eth0` because you knew it. To see what a machine offers, list the capture interfaces. Listing needs no root:',
          '',
          '```',
          'tcpdump -D',
          '```',
          '',
          'Note the number in front of `eth0`.'
        ),
        hint: 'The option is a capital `-D`. The number is at the start of each line.',
        solution: ['tcpdump -D'],
        check: { cmd: 'tcpdump', args: ['-D'], out: /1\.eth0/ },
      },
    ],
    quiz: [
      { q: 'You run `tcpdump -i eth0` as kali and get "You don\'t have permission to perform this packet capture". What is the usual fix?', choices: ['Run it with sudo', 'Add -n to stop name lookups', 'Run it on the loopback interface lo', 'Wait and try again'], answer: 0, why: 'Reading packets from an interface needs raw socket access, which only root (or a process with the right capability) has.' },
      { q: 'Why is -n worth using during an assessment?', choices: ['It makes the capture encrypted', 'It avoids reverse lookups that slow the capture and add traffic of their own', 'It hides your own packets', 'It captures only one packet'], answer: 1, why: 'Without -n tcpdump asks the resolver for a name for every address. That costs time and puts extra DNS queries on the wire.' },
      { q: 'You run `sudo tcpdump -c 5` and nothing prints for a long time. What is the most likely reason?', choices: ['Five matching packets have not arrived yet', 'The count was ignored', 'tcpdump crashed', 'sudo blocked the output'], answer: 0, why: 'With -c the capture runs until that many packets arrive. On a quiet link it waits. Ctrl-C stops it and still prints the summary.' },
    ],
    refs: ['tcpdump(8)', 'pcap-filter(7)', 'Kali Linux Revealed, ch. 5'],
  };

  /* ---------------------------------------------------------------- filters */
  const filters = {
    id: 'cap-filters',
    title: 'Filtering what you capture',
    minutes: 12,
    objectives: [
      'Limit a capture with filter expressions such as icmp, host and port',
      'Combine filters with and, or and not',
      'Capture your own traffic by starting a capture in the background and then generating the traffic',
      'Recognize the three packets of a TCP handshake in the flag column',
    ],
    intro: T(
      'On a real network an unfiltered capture fills the screen in seconds. A **filter expression** tells tcpdump which packets to keep, and it is applied before anything is printed or saved. Writing a precise filter is the difference between a capture you can read and one you cannot.',
      '',
      'This lesson captures traffic you create yourself. That is the safest way to learn: you know what you sent, so you can check that the capture shows it.'
    ),
    steps: [
      {
        id: 'sudo-v',
        prompt: T(
          'You will run a capture in the background while you generate traffic in the foreground. A background command cannot stop and ask for a password, so refresh sudo\'s memory first. `sudo -v` asks for your password and extends the time sudo remembers it, without running anything:',
          '',
          '```',
          'sudo -v',
          '```'
        ),
        input: PW,
        hint: 'Type `sudo -v` and enter `kali` when asked.',
        solution: 'sudo -v',
        check: { cmd: 'sudo', args: ['-v'], exit: 0 },
      },
      {
        id: 'mkdir',
        prompt: T(
          'Captures you want to read later go in a file. Make a working folder under your home directory:',
          '',
          '```',
          'mkdir -p ~/practice/capture',
          '```'
        ),
        hint: 'Use `mkdir -p ~/practice/capture`.',
        solution: 'mkdir -p ~/practice/capture',
        check: { file: { path: PRACTICE, type: 'dir' } },
      },
      {
        id: 'bg-icmp',
        prompt: T(
          'Start a capture that keeps only ICMP, the protocol `ping` uses, and stops after four packets. The filter `icmp` goes at the end of the command, after the options. The `> file 2>&1` part sends everything it prints (messages included) to a file, and the final `&` runs the command in the background so you get your prompt back:',
          '',
          '```',
          'sudo tcpdump -n -c 4 -i eth0 icmp > ~/practice/capture/ping.txt 2>&1 &',
          '```',
          '',
          'The shell prints a job number such as `[1]` and a process id.'
        ),
        hint: 'Copy the line from the prompt: options first, then the filter `icmp`, then the redirect, then `&`.',
        solution: 'sudo tcpdump -n -c 4 -i eth0 icmp > ~/practice/capture/ping.txt 2>&1 &',
        check: { all: [{ cmd: 'tcpdump', args: ['icmp', '-c'] }, { line: /&\s*$/ }] },
      },
      {
        id: 'ping',
        prompt: T(
          'Now generate the traffic. Two pings to web01 make four ICMP packets: two requests and two replies. Pausing a second first gives the capture time to start listening:',
          '',
          '```',
          'sleep 1; ping -c 2 web01',
          '```'
        ),
        hint: 'Use `ping -c 2 web01`. A `sleep 1;` in front is optional but safe.',
        solution: 'sleep 1; ping -c 2 web01',
        check: { cmd: 'ping', args: ['-c'], out: /2 received/ },
      },
      {
        id: 'read-ping',
        prompt: T(
          '`wait` pauses until background jobs finish. When the capture has its four packets it ends, and you can read what it wrote:',
          '',
          '```',
          'wait',
          'cat ~/practice/capture/ping.txt',
          '```',
          '',
          'Find the two echo requests and two echo replies. Each pair has the same `id` and a `seq` number that counts up.'
        ),
        hint: 'Run `wait`, then `cat` the file. Until the capture has finished the file has no packets in it.',
        solution: ['wait', 'cat ~/practice/capture/ping.txt'],
        check: { cmd: 'cat', argsRe: /ping\.txt/, out: /ICMP echo request[\s\S]*ICMP echo reply/ },
      },
      {
        id: 'not',
        prompt: T(
          'Filters combine. `and`, `or` and `not` work as you would expect, and `host`, `port`, `tcp`, `udp`, `icmp` and `arp` are the building blocks. This capture keeps everything except address-resolution (ARP) traffic. You have no traffic of your own running, so it shows the background chatter of the lab:',
          '',
          '```',
          'sudo tcpdump -n -c 5 -i eth0 not arp',
          '```',
          '',
          'Read the protocol column. None of the lines may start with `ARP`.'
        ),
        hint: 'Put `not arp` as the expression at the end.',
        solution: 'sudo tcpdump -n -c 5 -i eth0 not arp',
        check: { all: [{ cmd: 'tcpdump', args: ['not', 'arp', '-n'], user: 'root' }, { out: /5 packets captured/ }, { not: { out: /\bARP,/ } }] },
      },
      {
        id: 'bg-tcp',
        prompt: T(
          'Now a more selective filter. `host web01 and tcp port 80` keeps only TCP packets to or from web01 on port 80, which is web traffic. `-nn` shows ports as numbers too. Start the capture in the background; the count of five is what a single web request produces here:',
          '',
          '```',
          'sudo tcpdump -nn -c 5 -i eth0 host web01 and tcp port 80 > ~/practice/capture/web.txt 2>&1 &',
          '```'
        ),
        hint: 'Same shape as the ICMP capture: options, then the filter, then `> file 2>&1 &`. Use `-nn`.',
        solution: 'sudo tcpdump -nn -c 5 -i eth0 host web01 and tcp port 80 > ~/practice/capture/web.txt 2>&1 &',
        check: { all: [{ cmd: 'tcpdump', args: ['-nn', 'host', 'port', 'and'] }, { line: /&\s*$/ }] },
      },
      {
        id: 'curl',
        prompt: T(
          'Make one web request. `curl` fetches the page; `-s` keeps its progress meter quiet, and the output goes to `/dev/null` because you want the capture, not the page:',
          '',
          '```',
          'sleep 1; curl -s http://web01/ > /dev/null',
          '```'
        ),
        hint: 'Use `curl -s http://web01/ > /dev/null`.',
        solution: 'sleep 1; curl -s http://web01/ > /dev/null',
        check: { cmd: 'curl', argsRe: /web01/ },
      },
      {
        id: 'handshake',
        prompt: T(
          'Wait for the capture and read it:',
          '',
          '```',
          'wait',
          'cat ~/practice/capture/web.txt',
          '```',
          '',
          'The `Flags` field shows TCP control bits. Before any data moves, the two ends perform a **three-way handshake**: the client sends `[S]` (SYN, "I want to connect"), the server answers `[S.]` (SYN and ACK, "agreed"), and the client confirms with `[.]` (ACK). Then comes the first data packet, `[P.]`, which carries the request line `GET / HTTP/1.1`.'
        ),
        hint: 'Run `wait`, then `cat` the file `~/practice/capture/web.txt`.',
        solution: ['wait', 'cat ~/practice/capture/web.txt'],
        check: { cmd: 'cat', argsRe: /web\.txt/, out: /Flags \[S\][\s\S]*Flags \[S\.\][\s\S]*Flags \[P\./ },
      },
      {
        id: 'hs-q',
        prompt: 'In the capture you just read, which flags does the **second** packet carry? That is the server\'s answer to the connection request. Type them, with or without the brackets.',
        hint: 'Look at the `Flags` field of the second packet line. The answer has a dot in it.',
        solution: 'S.',
        answer: /^\[?s\.\]?$/i,
      },
    ],
    quiz: [
      { q: 'What does `sudo tcpdump -n icmp and not host 10.10.10.10` capture?', choices: ['Only ICMP packets involving 10.10.10.10', 'ICMP packets except those to or from 10.10.10.10', 'All packets except ICMP', 'Nothing, because the expression is invalid'], answer: 1, why: 'The expression is read as: the protocol is icmp, and the packet does not involve that host.' },
      { q: 'In a TCP handshake, which flag combination is the server\'s answer to the first packet?', choices: ['[S]', '[S.]', '[.]', '[F.]'], answer: 1, why: 'The server answers a SYN with SYN and ACK, which tcpdump writes as [S.]. The dot stands for ACK.' },
      { q: 'You start a capture with a filter and count it will never satisfy, then wait. What happens?', choices: ['wait returns immediately', 'The capture waits until you stop it with Ctrl-C or kill', 'tcpdump fills in the missing packets', 'The shell kills it after five seconds'], answer: 1, why: 'A capture with -c ends only when it has that many matching packets. Choose a count your traffic will reach, or stop it yourself.' },
      { q: 'Why generate traffic yourself when learning to filter?', choices: ['Because tcpdump only sees traffic you generate', 'Because you know what should appear, so you can tell whether the filter works', 'Because it is faster than reading a manual', 'Because ping needs a capture to run'], answer: 1, why: 'With known traffic you can compare what you expected with what the filter kept. Capture on real networks only where you are authorized.' },
    ],
    refs: ['tcpdump(8)', 'pcap-filter(7)', 'RFC 9293 (TCP)', 'RFC 792 (ICMP)'],
  };

  /* -------------------------------------------------------------- cleartext */
  const cleartext = {
    id: 'cap-cleartext',
    title: 'Clear text on the wire',
    minutes: 11,
    objectives: [
      'Show that an HTTP request and response can be read in a capture with -A',
      'Find a credential in a capture and decode it',
      'Compare with HTTPS, where the capture shows only addresses, sizes and unreadable data',
      'Explain why clear-text protocols appear as findings in an assessment',
    ],
    intro: T(
      'Anyone who can see packets between two machines can read a clear-text protocol. HTTP, FTP and Telnet send everything, passwords included, exactly as typed. HTTPS wraps the same conversation in TLS, so a capture shows who talked to whom and how much, but not what was said.',
      '',
      'This is why assessments report services that use clear-text protocols. In this lesson you read a login travel across the lab network. It uses the test account the client supplied in `credentials.txt`, against a host that is in scope.'
    ),
    steps: [
      {
        id: 'sudo-v',
        prompt: T(
          'Refresh sudo\'s password memory so the background capture will not stop at a prompt:',
          '',
          '```',
          'sudo -v',
          '```'
        ),
        input: PW,
        hint: 'Type `sudo -v` and enter `kali`.',
        solution: 'sudo -v',
        check: { cmd: 'sudo', args: ['-v'], exit: 0 },
      },
      {
        id: 'mkdir',
        prompt: 'Make sure the working folder exists. `-p` makes this safe to repeat:\n\n```\nmkdir -p ~/practice/capture\n```',
        hint: 'Use `mkdir -p ~/practice/capture`.',
        solution: 'mkdir -p ~/practice/capture',
        check: { file: { path: PRACTICE, type: 'dir' } },
      },
      {
        id: 'bg-http',
        prompt: T(
          'Start a background capture of web traffic. The new option is `-A`, which prints each packet\'s payload as ASCII text under its header line. Eight packets cover one request here:',
          '',
          '```',
          'sudo tcpdump -nn -A -c 8 -i eth0 tcp port 80 > ~/practice/capture/http.txt 2>&1 &',
          '```'
        ),
        hint: 'Like the last lesson, plus `-A` for the ASCII payload.',
        solution: 'sudo tcpdump -nn -A -c 8 -i eth0 tcp port 80 > ~/practice/capture/http.txt 2>&1 &',
        check: { all: [{ cmd: 'tcpdump', args: ['-A', '-c'] }, { line: /&\s*$/ }] },
      },
      {
        id: 'curl-u',
        prompt: T(
          'Request the web01 home page as the client\'s test user. `-u student:student` makes curl log in with HTTP Basic authentication, which sends the user name and password in a request header:',
          '',
          '```',
          'sleep 1; curl -s -u student:student http://web01/ > /dev/null',
          '```',
          '',
          'The test account exists for this kind of check. Never reuse real credentials in an exercise.'
        ),
        hint: 'Use `curl -s -u student:student http://web01/ > /dev/null`.',
        solution: 'sleep 1; curl -s -u student:student http://web01/ > /dev/null',
        check: { cmd: 'curl', args: ['-u'], argsRe: /web01/ },
      },
      {
        id: 'grep-auth',
        prompt: T(
          'Wait for the capture, then search it for the request header. The capture file contains the whole conversation, so `grep` finds a line in it as it would in any text file:',
          '',
          '```',
          'wait',
          'grep Authorization ~/practice/capture/http.txt',
          '```',
          '',
          'Look at the value after `Basic`. It is not encrypted, only encoded.'
        ),
        hint: 'Run `wait`, then `grep Authorization` on the capture file.',
        solution: ['wait', 'grep Authorization ~/practice/capture/http.txt'],
        check: { cmd: 'grep', argsRe: /http\.txt/, out: /Authorization: Basic c3R1ZGVudDpzdHVkZW50/ },
      },
      {
        id: 'decode',
        prompt: T(
          'Basic authentication joins the user name and password with a colon and encodes them with Base64. Base64 is a way to write bytes as text, with no key and no secret, so anyone can reverse it. Decode the value you found:',
          '',
          '```',
          'echo c3R1ZGVudDpzdHVkZW50 | base64 -d',
          '```'
        ),
        hint: 'Pipe the string into `base64 -d` (decode).',
        solution: 'echo c3R1ZGVudDpzdHVkZW50 | base64 -d',
        check: { cmd: 'base64', args: ['-d'], out: /student:student/ },
      },
      {
        id: 'bg-https',
        prompt: T(
          'Now the same request over HTTPS, which web01 also offers on port 443. Start a background capture of that port. The only changes from before are the port and the file name:',
          '',
          '```',
          'sudo tcpdump -nn -A -c 8 -i eth0 tcp port 443 > ~/practice/capture/https.txt 2>&1 &',
          '```'
        ),
        hint: 'Copy the last capture command and change `80` to `443` and `http.txt` to `https.txt`.',
        solution: 'sudo tcpdump -nn -A -c 8 -i eth0 tcp port 443 > ~/practice/capture/https.txt 2>&1 &',
        check: { all: [{ cmd: 'tcpdump', args: ['-A', '-c', '443'] }, { line: /&\s*$/ }] },
      },
      {
        id: 'curl-https',
        prompt: T(
          'Repeat the request over HTTPS. `-k` tells curl to accept the lab server\'s self-signed certificate, which is fine for a lab and a bad habit anywhere else:',
          '',
          '```',
          'sleep 1; curl -sk -u student:student https://web01/ > /dev/null',
          '```'
        ),
        hint: 'Same command as before, with `https://` and `-k` added.',
        solution: 'sleep 1; curl -sk -u student:student https://web01/ > /dev/null',
        check: { cmd: 'curl', args: ['-u'], argsRe: /https:\/\/web01/ },
      },
      {
        id: 'grep-count',
        prompt: T(
          'Wait, then count how many lines of the HTTPS capture contain the word `Authorization`. `grep -c` prints a count instead of the lines:',
          '',
          '```',
          'wait',
          'grep -c Authorization ~/practice/capture/https.txt',
          '```',
          '',
          'Open the file with `cat` as well. You will see the handshake, the sizes of the packets and unreadable data. The same login is in there, but it is encrypted.'
        ),
        hint: 'Run `wait`, then `grep -c Authorization` on `https.txt`. A count of 0 is the result you want to see.',
        solution: ['wait', 'grep -c Authorization ~/practice/capture/https.txt'],
        check: { all: [{ cmd: 'grep', args: ['-c'], argsRe: /https\.txt/ }, { out: /^0$/m }, { file: { path: PRACTICE + '/https.txt', contains: /Flags \[P\./ } }] },
      },
    ],
    quiz: [
      { q: 'A colleague says a Basic authentication header is safe because it looks like random text. What is wrong with that?', choices: ['Nothing, Base64 is encryption', 'Base64 is a reversible encoding, so anyone who sees the header can decode it', 'The header is never sent', 'Only root can decode Base64'], answer: 1, why: 'Base64 has no key. Decoding it takes one command, as you just did.' },
      { q: 'What can an observer still learn from a capture of an HTTPS connection?', choices: ['The pages visited and the passwords', 'Which hosts talk, on which ports, when, and roughly how much data moves', 'Nothing at all', 'Only the server\'s operating system'], answer: 1, why: 'TLS protects the content. Addresses, ports, timing and packet sizes remain visible.' },
      { q: 'Why does an assessment report list a service that uses FTP or Telnet, even if nobody was seen attacking it?', choices: ['They are old and slow', 'Anyone able to capture traffic on the path can read the credentials and data', 'They cannot be used on Linux', 'They use too many ports'], answer: 1, why: 'The risk is exposure on the network, not an attack in progress. The recommendation is usually an encrypted replacement such as SFTP or SSH.' },
      { q: 'You capture traffic on a client\'s network and find real staff passwords. What is the careful thing to do?', choices: ['Post them in the report so the client sees the impact', 'Record that clear-text credentials were observed, store the capture securely, and avoid copying the secrets themselves', 'Try them on other systems to see how far they work', 'Delete the capture and say nothing'], answer: 1, why: 'The finding is that credentials are exposed. The report needs that fact and the evidence, not the secrets, and everything you see belongs to the client.' },
    ],
    refs: ['tcpdump(8)', 'base64(1)', 'RFC 7617 (HTTP Basic authentication)', 'RFC 8446 (TLS 1.3)'],
  };

  /* ------------------------------------------------------------------ files */
  const files = {
    id: 'cap-files',
    title: 'Saving and reading capture files',
    minutes: 11,
    objectives: [
      'Save a capture to a file with -w under the engagement folder',
      'Read a saved capture back with -r and narrow it with a filter',
      'Restrict access to a capture file and say why',
      'Record a capture in the engagement notes',
    ],
    intro: T(
      'Reading packets live is fine for a quick look. For evidence you save the capture to a file. A saved capture can be read again and again, filtered differently each time, handed to a graphical analyzer such as Wireshark and attached to a finding.',
      '',
      'A capture file is also client data. It can hold credentials, names and internal addresses. It belongs in the engagement folder, with permissions that keep other users out, and it is deleted or handed over at the end of the engagement as agreed.'
    ),
    steps: [
      {
        id: 'sudo-v',
        prompt: 'Refresh sudo\'s password memory first:\n\n```\nsudo -v\n```',
        input: PW,
        hint: 'Type `sudo -v` and enter `kali`.',
        solution: 'sudo -v',
        check: { cmd: 'sudo', args: ['-v'], exit: 0 },
      },
      {
        id: 'mkdir',
        prompt: T(
          'Captures go in the engagement folder, in their own subfolder:',
          '',
          '```',
          'mkdir -p ~/engagement/captures',
          '```'
        ),
        hint: 'Use `mkdir -p ~/engagement/captures`.',
        solution: 'mkdir -p ~/engagement/captures',
        check: { file: { path: HOME + '/engagement/captures', type: 'dir' } },
      },
      {
        id: 'bg-write',
        prompt: T(
          'The option `-w file` writes the raw packets to a file instead of printing them. Start a background capture of everything to or from web01 and stop after six packets:',
          '',
          '```',
          'sudo tcpdump -nn -c 6 -i eth0 -w ~/engagement/captures/web01.pcap host web01 &',
          '```',
          '',
          'tcpdump prints nothing but its status lines while writing. They appear in your terminal, since this time they are not redirected.'
        ),
        hint: 'Options `-nn -c 6 -i eth0 -w FILE`, then the filter `host web01`, then `&`.',
        solution: 'sudo tcpdump -nn -c 6 -i eth0 -w ~/engagement/captures/web01.pcap host web01 &',
        check: { all: [{ cmd: 'tcpdump', args: ['-w', 'host', '-c'] }, { line: /&\s*$/ }] },
      },
      {
        id: 'traffic',
        prompt: T(
          'Generate the traffic to record. One web request to web01 produces six packets that match:',
          '',
          '```',
          'sleep 1; curl -s http://web01/ > /dev/null',
          '```'
        ),
        hint: 'Use `curl -s http://web01/ > /dev/null`.',
        solution: 'sleep 1; curl -s http://web01/ > /dev/null',
        check: { cmd: 'curl', argsRe: /web01/ },
      },
      {
        id: 'ls',
        prompt: T(
          'Wait for the capture to finish, then list the folder with details:',
          '',
          '```',
          'wait',
          'ls -l ~/engagement/captures',
          '```',
          '',
          'Look at the owner column. sudo ran tcpdump, so root created the file, and your normal account may not be able to change it.'
        ),
        hint: 'Run `wait`, then `ls -l` on the captures folder.',
        solution: ['wait', 'ls -l ~/engagement/captures'],
        check: { cmd: 'ls', args: ['-l'], out: /web01\.pcap/, file: { path: HOME + '/engagement/captures/web01.pcap', contains: /"dport":80/ } },
      },
      {
        id: 'protect',
        prompt: T(
          'Give the file to yourself and allow only the owner to read and write it. `chown` changes the owner and needs sudo; `chmod 600` sets the mode to read and write for the owner and nothing for anyone else:',
          '',
          '```',
          'sudo chown kali:kali ~/engagement/captures/web01.pcap && chmod 600 ~/engagement/captures/web01.pcap',
          '```'
        ),
        hint: 'Use `sudo chown kali:kali FILE`, then `chmod 600 FILE`. `&&` runs the second only if the first worked.',
        solution: 'sudo chown kali:kali ~/engagement/captures/web01.pcap && chmod 600 ~/engagement/captures/web01.pcap',
        check: { all: [{ cmd: 'chmod', args: ['600'] }, { file: { path: HOME + '/engagement/captures/web01.pcap', mode: '600' } }] },
      },
      {
        id: 'read',
        prompt: T(
          'Read the capture back with `-r`. This needs no root, because you are reading a file and not an interface. The packets are the same as when they were captured, with their original timestamps:',
          '',
          '```',
          'tcpdump -nn -r ~/engagement/captures/web01.pcap',
          '```',
          '',
          'The first line says `reading from file`. There is no summary at the end this time.'
        ),
        hint: 'Use `tcpdump -nn -r` and the file name.',
        solution: 'tcpdump -nn -r ~/engagement/captures/web01.pcap',
        check: { cmd: 'tcpdump', args: ['-r'], out: /reading from file[\s\S]*Flags \[S\]/ },
      },
      {
        id: 'filter',
        prompt: T(
          'A filter after `-r` selects from the saved packets, and the file is not changed. Show only what the web server sent. `src port 80` means the source port is 80:',
          '',
          '```',
          'tcpdump -nn -r ~/engagement/captures/web01.pcap src port 80',
          '```'
        ),
        hint: 'The same command as before with the expression `src port 80` at the end.',
        solution: 'tcpdump -nn -r ~/engagement/captures/web01.pcap src port 80',
        check: { all: [{ cmd: 'tcpdump', args: ['-r', 'src', 'port', '80'] }, { out: /Flags \[S\.\]/ }, { not: { out: /10\.10\.10\.5\.\d+ > 10\.10\.10\.10\.80/ } }] },
      },
      {
        id: 'count-q',
        prompt: 'How many packets in your capture came from the web server? Count the lines your last command printed after the `reading from file` line. Type the number.',
        hint: 'Run the filtered read again if the output has scrolled away, and count the packet lines.',
        solution: '3',
        answer: /^3$/,
      },
      {
        id: 'notes',
        prompt: T(
          'A capture nobody can find again is of little use. Add a line to your notes that says what the file is and when you made it. `date` gives the time, and `>>` appends:',
          '',
          '```',
          'echo "$(date +%F) capture of web01 HTTP traffic: captures/web01.pcap" >> ~/engagement/notes.md',
          '```'
        ),
        hint: 'Append with `>>` to `~/engagement/notes.md`, and mention `web01.pcap` in the text.',
        solution: 'echo "$(date +%F) capture of web01 HTTP traffic: captures/web01.pcap" >> ~/engagement/notes.md',
        check: { file: { path: HOME + '/engagement/notes.md', contains: /web01\.pcap/ }, line: />>/ },
      },
    ],
    quiz: [
      { q: 'You captured with `sudo tcpdump -w out.pcap`. Which command reads the file back?', choices: ['tcpdump -w out.pcap', 'tcpdump -r out.pcap', 'cat out.pcap', 'sudo tcpdump -i out.pcap'], answer: 1, why: '-r reads packets from a file. It needs no root because it does not open an interface.' },
      { q: 'What is the effect of adding a filter such as `port 80` to a -r read?', choices: ['It deletes the other packets from the file', 'It prints only the matching packets and leaves the file unchanged', 'It captures new packets', 'It encrypts the file'], answer: 1, why: 'Filters select what is displayed. The saved file stays as it was, so you can read it again with another filter.' },
      { q: 'Why set the mode of a capture file to 600?', choices: ['So tcpdump can read it', 'It may hold client credentials and personal data, so only the owner should read it', 'It makes the file smaller', 'It is required for Wireshark'], answer: 1, why: 'Captures are client data. Limiting access is a basic part of handling them.' },
    ],
    refs: ['tcpdump(8)', 'chmod(1)', 'pcap(3pcap)', 'NIST SP 800-115, section 3'],
  };

  K.lessons.register({
    id: 'capture',
    title: 'Watching the wire',
    order: 110,
    summary: 'Capture and read network traffic with tcpdump: filters, clear text versus HTTPS, and saving captures as evidence.',
    lessons: [first, filters, cleartext, files],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
