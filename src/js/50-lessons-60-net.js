/* Kalima — curriculum module "net": networking fundamentals.
 *
 * Lessons: net-addresses, net-routes, net-ping, net-path, net-ports,
 * net-troubleshoot. They read the Kali machine's own configuration and send
 * ordinary client traffic (ping, traceroute, one HTTP request) to the lab and
 * to the simulated internet. Nothing is seeded: the only files written are a
 * few appended lines in ~/engagement/notes.md. Checks test what a line printed
 * or the state it left behind (interface up or down, port 22 listening or not).
 * net-troubleshoot takes eth0 down and its last step requires it to be up again.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const NOTES = '/home/kali/engagement/notes.md';
  /** Everything a line printed, without colors. */
  const outOf = (ev) => K.util.stripAnsi(ev.output || '');
  /** Does the line's output match every one of these patterns? */
  const prints = (...res) => (ev) => { const o = outOf(ev); return res.every((r) => { r.lastIndex = 0; return r.test(o); }); };
  /** The line appended to the notes file (with >> or tee -a). */
  const appendsToNotes = { any: [{ line: />>\s*\S*notes\.md/ }, { cmd: 'tee', args: ['-a'], argsRe: /notes\.md/ }] };
  /** Shown in the hint of each lesson's first step, in case an earlier exercise left the interface down. */
  const IF_DOWN = ' If `eth0` shows `DOWN`, an earlier exercise left it switched off: run `sudo ip link set eth0 up` first.';

  /* ------------------------------------------------------------- addresses */
  const addressesLesson = {
    id: 'net-addresses',
    title: 'Interfaces and addresses',
    minutes: 10,
    objectives: [
      'List your network interfaces and their state with `ip -br a` and `ip a`',
      'Read the IPv4 address, prefix length and MAC address of an interface',
      'Work out from an address such as `10.10.10.5/24` which hosts are on your local segment',
      'Print your addresses with `hostname -I` and record your source address in the engagement notes',
    ],
    intro: T(
      'Every packet your workstation sends carries a source address, and every decision about where a packet goes starts from the machine\'s own network configuration. Before you look at anyone else\'s systems you need to be able to read your own: which interfaces exist, which of them is connected, what address it has, and which other machines that address makes your direct neighbors.',
      '',
      'On an engagement this is also a safety check. The scope names networks, and your address tells you which network you are really connected to. The client will want to know which address your testing came from, so it belongs in your notes.'
    ),
    steps: [
      {
        id: 'brief',
        prompt: T(
          'The tool for network configuration on Linux is `ip`. It is followed by the kind of thing you want to see, here `a`, short for `address`. The option `-br` asks for the brief form:',
          '',
          '```',
          'ip -br a',
          '```',
          '',
          'There is one line per network interface, with three columns: the name, the state, and the addresses.',
          '',
          '- `lo` is the *loopback* interface. Every system has one. Traffic sent to it never leaves the machine. Its state `UNKNOWN` is normal, because there is no cable whose state could be reported.',
          '- `eth0` is the first Ethernet interface, the one that connects you to the lab. `UP` means it is switched on and connected. On other systems the same kind of interface may be called something like `enp0s3`.'
        ),
        hint: 'Type `ip -br a` and press Enter.' + IF_DOWN,
        solution: 'ip -br a',
        check: { cmd: 'ip', out: /^eth0\s+UP\s+10\.10\.10\.5\/24/m },
      },
      {
        id: 'address',
        prompt: T(
          'Look at the line for `eth0`. The third column holds two addresses. The one made of four numbers is the IPv4 address, and the long one that begins with `fe80` is an IPv6 address that the system gave itself.',
          '',
          'What is the IPv4 address of `eth0`? Give it as it is printed, including the slash and the number after it.'
        ),
        hint: 'It is the first entry in the third column of the `eth0` line, in the form `a.b.c.d/nn`.',
        solution: '10.10.10.5/24',
        answer: /^10\.10\.10\.5\s*\/\s*24$/,
      },
      {
        id: 'full',
        prompt: T(
          'Without `-br`, `ip` prints everything it knows. Name an interface after `show` to limit the output to that one:',
          '',
          '```',
          'ip a show eth0',
          '```',
          '',
          'Read it line by line.',
          '',
          '- The first line gives the name, then flags in angle brackets. `UP` means the interface is switched on, and `LOWER_UP` means the link under it, the cable or its virtual equivalent, is connected.',
          '- `link/ether` is followed by the *MAC address*, the hardware address of the network card. Machines on the same segment use it to deliver data to each other.',
          '- `inet` is the IPv4 address. `brd` is the broadcast address of the network, and `dynamic` says the address was handed out by a DHCP server and not typed in by hand.',
          '- `inet6` is the IPv6 address. `scope link` means it is valid on this segment only.'
        ),
        hint: 'Type `ip a show eth0`. `ip addr show eth0` is the same command with the object spelled out further.',
        solution: 'ip a show eth0',
        check: { cmd: 'ip', fn: prints(/link\/ether 08:00:27:1d:77:55/, /inet 10\.10\.10\.5\/24 brd 10\.10\.10\.255/) },
      },
      {
        id: 'mac',
        prompt: T(
          'A MAC address is written as six pairs of hexadecimal digits separated by colons. The first three pairs identify the maker of the card. The lab machine\'s card begins with `08:00:27`, which belongs to the virtual network cards of VirtualBox.',
          '',
          'What is the full MAC address of `eth0`?'
        ),
        hint: 'It follows `link/ether` on the second line. Do not confuse it with `ff:ff:ff:ff:ff:ff` after `brd`, which is the address for "everyone on this segment".',
        solution: '08:00:27:1d:77:55',
        answer: /^08[:-]00[:-]27[:-]1d[:-]77[:-]55$/i,
      },
      {
        id: 'loopback',
        prompt: T(
          'Now print the same full view for the loopback interface, and only for that one.',
          '',
          'In its output, `inet 127.0.0.1/8` is followed by `scope host`: the address is valid inside this machine only. On every computer `127.0.0.1` means "myself". A service that listens on `127.0.0.1` alone cannot be reached from any other machine, which is why administrators use it for things that should stay private.'
        ),
        hint: 'Use the command from the step before last and change the interface name to `lo`.',
        solution: 'ip a show lo',
        check: { cmd: 'ip', out: /inet 127\.0\.0\.1\/8 scope host/, not: { out: /eth0/ } },
      },
      {
        id: 'prefix',
        prompt: T(
          'Back to `10.10.10.5/24`. An IPv4 address is four numbers from 0 to 255, which is 32 bits. The number after the slash, the *prefix length*, says how many of those bits name the network. The remaining bits name one host inside it.',
          '',
          '`/24` covers the first three numbers. So your network is `10.10.10.0/24`, and it contains the addresses `10.10.10.0` to `10.10.10.255`. The first names the network itself and the last is the broadcast address you saw after `brd`, which leaves 254 addresses for hosts.',
          '',
          'Your machine treats every address in that range as a neighbor on the same segment and sends to it directly. Everything else has to go through a router.',
          '',
          'Here are two addresses: `10.10.11.5` and `10.10.10.200`. Which one is on your local segment?'
        ),
        hint: 'Compare the first three numbers of each address with `10.10.10`.',
        solution: '10.10.10.200',
        answer: /^(the\s+)?(second(\s+one)?|10\.10\.10\.200(\s*\/\s*24)?)\.?$/i,
      },
      {
        id: 'ipv4',
        prompt: T(
          '`ip` takes the options `-4` and `-6` to limit what it shows to one address family. They go before the object, next to `-br`.',
          '',
          'Print the brief listing again, this time with IPv4 addresses only. The `fe80` address should disappear from the `eth0` line.'
        ),
        hint: 'Add `-4` to the first command of this lesson: `ip -4 -br ...`',
        solution: 'ip -4 -br a',
        check: { cmd: 'ip', out: /^eth0\s+UP\s+10\.10\.10\.5\/24\s*$/m },
      },
      {
        id: 'hostname',
        prompt: T(
          'When you only want the addresses, for a note or a script, there is a shorter way:',
          '',
          '```',
          'hostname -I',
          '```',
          '',
          'It prints every address of the machine on one line and leaves out the loopback address and the `fe80` address.',
          '',
          'The capital letter matters. `hostname -i` in lower case looks up the machine\'s own name instead, and on Kali that answers `127.0.1.1`, an address that is of no use to anybody else.'
        ),
        hint: 'Type `hostname -I` with a capital I.',
        solution: 'hostname -I',
        check: { cmd: 'hostname', argsRe: /(^|\s)(-I|--all-ip-addresses)(\s|$)/, out: /^10\.10\.10\.5\s*$/m },
      },
      {
        id: 'notes',
        prompt: T(
          'At the start of an engagement, record the address you are working from. Afterwards the client can tell your traffic apart from everything else in their logs, and you can show which network you were on.',
          '',
          'Append the brief line for `eth0` to your notes in `~/engagement/notes.md`. Nothing that is already in the file may be lost.'
        ),
        hint: '`ip -br a show eth0` prints the one line. `>>` appends the output of a command to a file, where a single `>` would replace the file.',
        solution: 'ip -br a show eth0 >> ~/engagement/notes.md',
        check: { cmd: 'ip', all: [appendsToNotes], file: { path: NOTES, contains: /^eth0\s+UP\s+10\.10\.10\.5\/24/m } },
      },
    ],
    quiz: [
      {
        q: 'A machine has the address `192.168.4.17/24`. Which of these addresses is on its local segment?',
        choices: [
          '`192.168.5.17`',
          '`192.186.4.17`',
          '`192.168.4.200`',
          '`10.168.4.17`',
        ],
        answer: 2,
        why: 'With a prefix length of 24 the first three numbers name the network, so everything that starts with `192.168.4.` is local. Each of the others differs somewhere in the first three numbers.',
      },
      {
        q: '`ip -br a` shows `lo  UNKNOWN  127.0.0.1/8`. A colleague is worried about the state. What do you tell them?',
        choices: [
          'That is normal: the loopback interface has no physical link whose state could be reported, and it works',
          'The loopback interface has failed and the machine should be restarted',
          'It means that no cable is plugged into `eth0`',
          'It means that `127.0.0.1` has not been assigned yet',
        ],
        answer: 0,
        why: '`UNKNOWN` is what `ip` always shows for `lo`. The interface exists in software only, so there is no carrier to detect. The flags in the full view show that it is `UP`.',
      },
      {
        q: 'A database on a server listens on `127.0.0.1` only. You type that address into a client on your Kali machine. What do you reach?',
        choices: [
          'The database, because `127.0.0.1` is the address the server chose for it',
          'The gateway, which forwards the connection to the server',
          'Nothing at all, because `127.0.0.1` cannot be used as a destination',
          'Your own Kali machine, because `127.0.0.1` always means the machine you are on',
        ],
        answer: 3,
        why: 'Loopback addresses never leave the machine that uses them. Seen from Kali, `127.0.0.1` is Kali. The database can only be reached by programs running on the server itself.',
      },
      {
        q: 'The scope of your engagement is `10.10.10.0/24`. After reconnecting your machine, `ip -br a` shows `eth0  UP  172.16.8.31/16`. What should you conclude?',
        choices: [
          'Nothing has changed, because the interface is still `UP`',
          'You are connected to a different network from the one in scope, so stop and sort that out before you send anything',
          'The address is wrong and the quickest fix is to set `10.10.10.5` by hand',
          'The prefix length changed, so more hosts are in scope now',
        ],
        answer: 1,
        why: 'Your address shows which network you are on, and `172.16.8.31/16` is not in `10.10.10.0/24`. Whatever you send now reaches somebody else\'s systems. Find out where you are connected, and to whom the network belongs, before you do anything else.',
      },
    ],
    refs: ['ip(8)', 'ip-address(8)', 'hostname(1)', 'RFC 4632 (CIDR notation)', 'RFC 1918 (private addresses)', 'Kali Linux Revealed, ch. 5'],
  };

  /* ---------------------------------------------------------------- routes */
  const routesLesson = {
    id: 'net-routes',
    title: 'Routes and the default gateway',
    minutes: 10,
    objectives: [
      'Read the routing table with `ip route` and tell the connected route from the default route',
      'Name your default gateway and explain what it is for',
      'Ask the kernel with `ip route get` how it would reach a particular address',
      'Read the neighbor table with `ip neigh` to see which machines yours hands data to directly',
    ],
    intro: T(
      'Your address tells you who your neighbors are. The routing table tells your machine what to do with a packet for everybody else. It is a short list of rules, and on a workstation two of them matter: one for the local network and one for the rest of the world.',
      '',
      'Reading it answers practical questions quickly. Why can I reach the lab but not the internet? Which interface will this traffic leave by? A tester\'s machine often has several connections at once, for example a lab network and a VPN. The routing table shows which of them a packet for a given target would really travel over, and you can find that out before you send anything.'
    ),
    steps: [
      {
        id: 'table',
        prompt: T(
          'Print the routing table:',
          '',
          '```',
          'ip route',
          '```',
          '',
          'Each line is a rule: a destination, followed by how to reach it. Start with the second line.',
          '',
          '- `10.10.10.0/24 dev eth0` says that addresses in your own network are reached directly through `eth0`. `scope link` means "on this link, no router needed", and `proto kernel` means the kernel added the rule by itself when the interface received its address. This is the *connected route*.',
          '- `default via 10.10.10.1 dev eth0` covers every destination that no other line matches. `via` names the router such packets are handed to, the *default gateway*. `proto dhcp` says the rule arrived from the DHCP server together with your address.',
          '',
          'When several lines match a destination, the most specific one wins, which is the one with the longest prefix. `default` is the least specific rule there is.'
        ),
        hint: 'Type `ip route`, or `ip r` for short. If it prints nothing, an earlier exercise left `eth0` switched off: run `sudo ip link set eth0 up` first.',
        solution: 'ip route',
        check: { cmd: 'ip', fn: prints(/^default via 10\.10\.10\.1 dev eth0/m, /^10\.10\.10\.0\/24 dev eth0 .*scope link/m) },
      },
      {
        id: 'gateway',
        prompt: 'Which address is your default gateway?',
        hint: 'It follows the word `via` in the line that begins with `default`.',
        solution: '10.10.10.1',
        answer: /^10\.10\.10\.1$/,
      },
      {
        id: 'get-local',
        prompt: T(
          'The table lists rules. To see what the kernel would do with one particular address, ask it:',
          '',
          '```',
          'ip route get 10.10.10.20',
          '```',
          '',
          '`10.10.10.20` is the file server of the lab. The first line of the answer is the decision for that one destination: send the packet out of `eth0` (`dev eth0`) with `10.10.10.5` as its source address (`src`). There is no `via`, so the packet goes straight to the destination, as the connected route says. `uid 1000` is you, the user who asked.',
          '',
          'The command sends nothing. It only reports what would happen, so it is safe to use on any address.'
        ),
        hint: 'Type `ip route get 10.10.10.20`.',
        solution: 'ip route get 10.10.10.20',
        check: { cmd: 'ip', out: /^10\.10\.10\.20 dev eth0 src 10\.10\.10\.5/m },
      },
      {
        id: 'get-remote',
        prompt: T(
          'Ask the same question about `8.8.8.8`, a public DNS server on the internet. Before you press Enter, decide which line of the routing table you expect to apply.',
          '',
          'This time the answer contains `via 10.10.10.1`. The address is outside `10.10.10.0/24`, so only the default route matches, and the packet would be handed to the gateway.'
        ),
        hint: 'The command is the one from the last step with a different address at the end.',
        solution: 'ip route get 8.8.8.8',
        check: { cmd: 'ip', out: /^8\.8\.8\.8 via 10\.10\.10\.1 dev eth0/m },
      },
      {
        id: 'no-host',
        prompt: T(
          'A routing decision is made from the address alone. The kernel does not know, and does not check, whether a machine exists there.',
          '',
          'No machine in the lab uses the address `10.10.10.200`. Ask the kernel how it would reach it. Does the answer contain `via`? Answer yes or no.'
        ),
        hint: 'Run `ip route get 10.10.10.200` and compare the answer with the two you have seen. Is the address inside `10.10.10.0/24`?',
        solution: 'no',
        answer: /^no\b/i,
      },
      {
        id: 'traffic',
        prompt: T(
          'So what is the gateway for? Your machine can deliver data only to neighbors on its own segment. Every other packet it hands to the gateway, a router that is connected to further networks and passes the packet on toward its destination.',
          '',
          'Produce a little traffic to see this. Send two test packets to `8.8.8.8`:',
          '',
          '```',
          'ping -c 2 8.8.8.8',
          '```',
          '',
          'Two lines beginning with `64 bytes from 8.8.8.8` show that answers came back. The next lesson reads the output of `ping` in detail.'
        ),
        hint: 'Type `ping -c 2 8.8.8.8`. The option `-c 2` stops it after two packets.',
        solution: 'ping -c 2 8.8.8.8',
        check: { cmd: 'ping', out: /bytes from (\S+ \()?8\.8\.8\.8/ },
      },
      {
        id: 'neigh',
        prompt: T(
          'To put a packet on the wire, your machine needs the MAC address of the neighbor that is to receive it. It asks for that address on the segment, with a protocol called ARP, and keeps the answers in the *neighbor table*:',
          '',
          '```',
          'ip neigh',
          '```',
          '',
          'Each line gives an IP address, the interface, and after `lladdr` the MAC address learned for it. The last word is the state of the entry. `REACHABLE` means it was confirmed a moment ago. `STALE` means it has not been confirmed for a while and will be checked the next time it is used.',
          '',
          'There is a line for `10.10.10.1` and none for `8.8.8.8`. Your packets were addressed to `8.8.8.8`, but the machine they were handed to on the wire was the gateway.'
        ),
        hint: 'Type `ip neigh`. If there is no line for `10.10.10.1`, repeat the `ping` from the last step and look again.',
        solution: 'ip neigh',
        check: { any: [
          { cmd: 'ip', out: /^10\.10\.10\.1 dev eth0 lladdr [0-9a-f:]{17} [A-Z]+/m },
          { cmd: 'arp', out: /00:1b:21:8e:ba:c6/ },
        ] },
      },
      {
        id: 'neighbors',
        prompt: 'Look at the IP address at the start of each line of the neighbor table. How many of them lie outside `10.10.10.0/24`?',
        hint: 'Compare the first three numbers of every address with `10.10.10`. A neighbor is a machine your own can hand data to directly.',
        solution: '0',
        answer: /^(0|zero|none|no(ne)?(\s+of\s+them)?)\.?$/i,
      },
    ],
    quiz: [
      {
        q: 'A routing table has two lines: `default via 192.168.1.1 dev eth0` and `192.168.1.0/24 dev eth0 scope link`. Where does the machine send a packet for `192.168.1.50`?',
        choices: [
          'To the gateway `192.168.1.1`, because the default route is listed first',
          'Directly to `192.168.1.50` through `eth0`, because the more specific route wins',
          'To both, and whichever answers first is used',
          'Nowhere, because two lines match and the kernel cannot decide',
        ],
        answer: 1,
        why: 'Both lines match, and the one with the longest prefix is used. The order of the lines plays no part. `default` only applies when nothing more specific does.',
      },
      {
        q: 'On your Kali machine the `default` line disappears from the routing table and the line for `10.10.10.0/24` stays. What can you still reach?',
        choices: [
          'Everything, because the gateway `10.10.10.1` is itself inside `10.10.10.0/24`',
          'Nothing, because every packet needs a default route',
          'Hosts on the internet, but no hosts in the lab',
          'Hosts in `10.10.10.0/24`, but nothing beyond it',
        ],
        answer: 3,
        why: 'The connected route still covers the local network. For any other destination no rule matches any more, so the kernel refuses to send and programs report `Network is unreachable`.',
      },
      {
        q: 'What does `ip route get 1.1.1.1` send over the network?',
        choices: [
          'Nothing. It asks the kernel which route it would use and prints the answer',
          'One test packet to `1.1.1.1`',
          'A question to the default gateway',
          'A DNS query for the name that belongs to `1.1.1.1`',
        ],
        answer: 0,
        why: 'The command is a look at the kernel\'s own decision. No packet leaves the machine, which is why you can use it to check where traffic for a target would go before you send any.',
      },
      {
        q: 'Your machine sends a packet to `8.8.8.8` through the gateway `10.10.10.1`. On the first stretch of wire, which destination addresses does it carry?',
        choices: [
          'IP address `10.10.10.1` and the MAC address of the gateway',
          'IP address `8.8.8.8` and the MAC address of `8.8.8.8`',
          'IP address `8.8.8.8` and the MAC address of the gateway',
          'IP address `10.10.10.1` and no MAC address',
        ],
        answer: 2,
        why: 'The IP destination stays the same for the whole journey. The MAC address only says who receives the packet on the current segment, and that is the gateway. Your machine never learns the MAC address of a host on another network.',
      },
    ],
    refs: ['ip-route(8)', 'ip-neighbour(8)', 'ip(8)', 'RFC 1122, section 3.3.1 (routing outbound datagrams)', 'RFC 826 (ARP)'],
  };

  /* ------------------------------------------------------------------ ping */
  const pingLesson = {
    id: 'net-ping',
    title: 'Is it there? Reading ping',
    minutes: 12,
    objectives: [
      'Test whether a host answers with `ping -c`, and read a reply line and the statistics',
      'Tell apart three ways a ping fails: `Destination Host Unreachable`, silence, and `Name or service not known`',
      'Check with `ip neigh` whether a silent neighbor is really absent',
      'Use the TTL of a reply as a hint about the remote system and its distance',
    ],
    intro: T(
      '`ping` is the first tool most people reach for when something on a network does not respond, and it is the one most often misread. It sends a small test packet and reports whether an answer came back and how long that took.',
      '',
      'The value is in the detail. A reply tells you more than "it works". And a ping can fail in three ways that mean three different things: there is nobody at that address, there is somebody who does not answer, or the name could not be looked up. Mixing them up sends you looking for a fault in the wrong place, or puts "host is down" into a report about a machine that is running.'
    ),
    steps: [
      {
        id: 'reply',
        prompt: T(
          'Start with a host that answers, your gateway:',
          '',
          '```',
          'ping -c 4 10.10.10.1',
          '```',
          '',
          '`ping` sends a message called an ICMP *echo request*, and a host that receives one normally sends back an *echo reply*. `-c 4` is the count: stop after four requests. Without it, `ping` on Linux carries on until you press Ctrl+C.',
          '',
          'Each reply produces one line. Read one from left to right:',
          '',
          '- `64 bytes from 10.10.10.1` is the size of the reply and the address it came from',
          '- `icmp_seq=1` is the number of the request it answers. The numbers count up, so a gap means a lost packet',
          '- `ttl=64` is a counter carried in the reply. You will come back to it at the end of this lesson',
          '- `time=` is the round trip, from sending the request to receiving the reply, in milliseconds'
        ),
        hint: 'Type `ping -c 4 10.10.10.1` and wait for the four replies.' + IF_DOWN,
        solution: 'ping -c 4 10.10.10.1',
        check: { cmd: 'ping', out: /bytes from (\S+ \()?10\.10\.10\.1\)?: icmp_seq=\d+ ttl=\d+ time=/ },
      },
      {
        id: 'stats',
        prompt: T(
          'After the last reply `ping` prints a summary. The line that begins `4 packets transmitted` counts what was sent and what came back. The line below it gives the shortest, average and longest round trip, and how much the times varied (`min/avg/max/mdev`).',
          '',
          'When you only need a verdict, the summary is the place to look. What packet loss does it report for the gateway?'
        ),
        hint: 'Find the words `packet loss` in the second line from the bottom and read the percentage in front of them.',
        solution: '0%',
        answer: /^(0|zero)\s*(%|percent)?$/i,
      },
      {
        id: 'by-name',
        prompt: T(
          '`ping` accepts a name in place of an address. Send three requests to the lab\'s web server, `web01.halcyon.lab`.',
          '',
          'Look at the first line of the output: `PING web01.halcyon.lab (10.10.10.10)`. The name was looked up before anything was sent, and the address in brackets is the result. Everything after that works exactly as it did with an address.'
        ),
        hint: 'Change the count and the destination of the first command: `ping -c 3` followed by the name.',
        solution: 'ping -c 3 web01.halcyon.lab',
        check: { cmd: 'ping', fn: prints(/PING web01\.halcyon\.lab \(10\.10\.10\.10\)/, /\b3 packets transmitted, 3 received/) },
      },
      {
        id: 'unreachable',
        prompt: T(
          'Now the failures. No machine in the lab has the address `10.10.10.77`. Ping it with four requests:',
          '',
          '```',
          'ping -c 4 10.10.10.77',
          '```',
          '',
          'After about three seconds you see lines such as `From 10.10.10.5 icmp_seq=1 Destination Host Unreachable`. Notice who is speaking. `10.10.10.5` is your own machine.',
          '',
          'The address is inside your own network, so your machine tried to deliver the packet itself. It asked on the segment for the MAC address that belongs to `10.10.10.77`, nobody answered, and it gave up. For a local address this error means that no machine there is switched on. The summary counts the lines as `errors` and ends with `100% packet loss`.'
        ),
        hint: 'Type the command as shown, with four requests. The message takes about three seconds to appear.',
        solution: 'ping -c 4 10.10.10.77',
        check: { cmd: 'ping', out: /From 10\.10\.10\.5 icmp_seq=\d+ Destination Host Unreachable/ },
      },
      {
        id: 'silence',
        prompt: T(
          'Send three requests to `10.10.10.50`. In this lab that is the address of `dc01`, a Windows server.',
          '',
          'This failure looks different. Between the first line and the summary there is nothing at all, and the summary says `0 received, 100% packet loss` without counting any errors. The requests went out and no reply came back.',
          '',
          'Silence has more than one possible cause. The machine may be switched off. Or it, or a firewall on the way, may be set to ignore echo requests. Silence alone does not show that a host is down.'
        ),
        hint: '`ping -c 3` followed by the address. Wait for the summary.',
        solution: 'ping -c 3 10.10.10.50',
        check: { cmd: 'ping', fn: prints(/PING \S+ \(10\.10\.10\.50\)/, /\b0 received, 100% packet loss/), not: { out: /Unreachable/ } },
      },
      {
        id: 'neigh',
        prompt: T(
          'For a host on your own segment there is a way to tell the two cases apart. Before your machine can send anything to a neighbor it has to learn the neighbor\'s MAC address, and it keeps what it learned in the neighbor table:',
          '',
          '```',
          'ip neigh',
          '```',
          '',
          'Find the lines for the two addresses you just pinged.',
          '',
          '- `10.10.10.77` ends in `FAILED` and has no MAC address. Nobody answered the question "who has this address?".',
          '- `10.10.10.50` has a MAC address after `lladdr`, and a state of `REACHABLE` or `STALE`. Something at that address answered.',
          '',
          'A machine has to answer that question to be able to communicate at all, even if it ignores every ping.'
        ),
        hint: 'Type `ip neigh`. If one of the two addresses is missing from the list, ping it again as in the last two steps.',
        solution: 'ip neigh',
        check: { cmd: 'ip', fn: prints(/^10\.10\.10\.77 dev eth0\s+FAILED/m, /^10\.10\.10\.50 dev eth0 lladdr [0-9a-f:]{17}/m) },
      },
      {
        id: 'which',
        prompt: 'Both `10.10.10.77` and `10.10.10.50` showed 100% packet loss. Going by the neighbor table, at which of the two addresses is a machine switched on?',
        hint: 'Which of the two lines in `ip neigh` shows a MAC address after `lladdr`?',
        solution: '10.10.10.50',
        answer: /^(the\s+)?(second(\s+one)?|dc01(\.halcyon\.lab)?|10\.10\.10\.50)\.?$/i,
      },
      {
        id: 'name',
        prompt: T(
          'The third failure happens before any packet is sent. Somebody tells you that the web server is called `web1.halcyon.lab`, which is not quite right. Ping that name with two requests.',
          '',
          'There is a single line: `Name or service not known`. There is no `PING` line and no summary, because nothing was sent. The name could not be turned into an address.',
          '',
          'This message says nothing about whether any host is up or down. Check the spelling first.'
        ),
        hint: '`ping -c 2 web1.halcyon.lab`, with the name exactly as given, mistake included.',
        solution: 'ping -c 2 web1.halcyon.lab',
        check: { cmd: 'ping', out: /Name or service not known/ },
      },
      {
        id: 'ttl',
        prompt: T(
          'Back to `ttl`. Every packet starts its journey with a *time to live*, a number chosen by the system that sends it. Each router that passes the packet on lowers the number by one, and a packet that reaches zero is thrown away, so that nothing can circle forever. The `ttl=` in a reply line is what was left when the reply arrived.',
          '',
          'Systems start from a few typical values: 64 on Linux and most other Unix-like systems, 128 on Windows, 255 on a lot of network equipment. The lab hosts answered with `ttl=64`: sent with 64, and no router in between.',
          '',
          'Now ping something far away. Send three requests to `8.8.8.8`, a public DNS server. A few pings to a public server like this are ordinary client behavior.',
          '',
          'The replies show `ttl=119`. The nearest typical start value above that is 128, so the reply probably crossed 9 routers. Treat this as a hint and not as proof, because the start value can be configured. Compare the `time=` values with those of the gateway as well.'
        ),
        hint: '`ping -c 3 8.8.8.8`',
        solution: 'ping -c 3 8.8.8.8',
        check: { cmd: 'ping', out: /bytes from (\S+ \()?8\.8\.8\.8\)?: icmp_seq=\d+ ttl=\d+/ },
      },
      {
        id: 'hops',
        prompt: 'Ping `example.com` with three requests and read the `ttl` of the replies. If the replies started with a TTL of 64, how many routers did they cross on the way to you?',
        hint: 'Subtract the `ttl=` value in the reply lines from 64.',
        solution: '13',
        answer: /^13(\s+(routers?|hops?))?\.?$/i,
      },
    ],
    quiz: [
      {
        q: '`ping -c 3 10.10.10.90` prints the `PING` line and then `3 packets transmitted, 0 received, 100% packet loss`, with nothing in between. What can you conclude?',
        choices: [
          'The host is switched off',
          'The address does not exist',
          'Only that no replies came back. The host may be off, or it or a firewall may be dropping pings',
          'The name could not be looked up',
        ],
        answer: 2,
        why: 'Silence has several possible causes and `ping` cannot tell them apart. For a host on your own segment the neighbor table gives a second piece of evidence. In a report, write what you observed: "did not answer ICMP echo requests".',
      },
      {
        q: 'Your address is `10.10.10.5/24`. You ping `10.10.10.123` and see `From 10.10.10.5 icmp_seq=1 Destination Host Unreachable`. Who is reporting what?',
        choices: [
          'Your own machine reports that nobody answered when it asked for the MAC address of `10.10.10.123`',
          'The host `10.10.10.123` reports that it refuses pings',
          'The gateway reports that it has no route to `10.10.10.123`',
          'The DNS server reports that the name is unknown',
        ],
        answer: 0,
        why: 'The address after `From` is the sender of the error, and here it is your own. For an address on your own segment your machine has to find the neighbor itself. When nobody answers, it reports the failure to `ping`.',
      },
      {
        q: 'A server on your own segment answers a ping with `ttl=128`. What does that suggest?',
        choices: [
          'The reply crossed 128 routers',
          'It is probably a Windows system, and no router lies between you and it',
          'It is probably a Linux system that is 64 routers away',
          'The server will stop answering after 128 more pings',
        ],
        answer: 1,
        why: 'Windows starts with a TTL of 128, and on the same segment no router lowers it. It is a hint only, because the start value can be changed, so look for other evidence before you rely on it.',
      },
      {
        q: 'Four replies arrive with `icmp_seq=1`, `icmp_seq=2`, `icmp_seq=4` and `icmp_seq=5`. What happened?',
        choices: [
          'The host answered the third request twice',
          '`ping` skips a number after every two requests',
          'The route to the host changed after the second request',
          'The third request or its reply was lost on the way',
        ],
        answer: 3,
        why: 'Every request carries the next sequence number and each reply repeats the number of the request it answers. A missing number is a packet that did not come back, and the summary would show it as packet loss.',
      },
    ],
    refs: ['ping(8)', 'ip-neighbour(8)', 'RFC 792 (ICMP)', 'RFC 1122, section 3.2.2.6 (echo request and reply)'],
  };

  /* ------------------------------------------------------------------ path */
  /** A traceroute hop line for this hop number and address, with or without a name in front. */
  const hopLine = (n, ip) => new RegExp('^\\s*' + n + '\\s+(\\S+ \\()?' + ip.replace(/\./g, '\\.') + '\\)?\\s+[\\d.]+ ms', 'm');

  const pathLesson = {
    id: 'net-path',
    title: 'Following the path: traceroute and mtr',
    minutes: 12,
    objectives: [
      'Trace the route to a host with `traceroute` and read hops, names and times',
      'Explain how expiring TTLs make each router on a path reveal itself',
      'Interpret a silent `* * *` hop correctly',
      'Measure loss and delay at every hop with `mtr -r`',
    ],
    intro: T(
      '`ping` answers one question: did a reply come back? When it did not, or the replies are slow, the next question is where along the way the trouble lies. Between your workstation and a distant host there is a chain of routers, and each one hands your packet to the next. `traceroute` makes that chain visible, one router per line, and `mtr` measures every link in it.',
      '',
      'On an assessment a trace also shows where networks begin and end: which hop is your own gateway, and which machines along the way belong to third parties. Those are not yours to test.'
    ),
    steps: [
      {
        id: 'local',
        prompt: T(
          'Start close to home. Trace the path to the web server of the lab:',
          '',
          '```',
          'traceroute 10.10.10.10',
          '```',
          '',
          'The first line repeats the destination and states two limits: the trace gives up after 30 hops, and every probe packet is 60 bytes long.',
          '',
          'Each line after that is one *hop*, a machine on the way, in order. A hop line holds the hop number, the name and address of the machine, and three times in milliseconds. `traceroute` sends three probes to every hop and reports the round trip of each.',
          '',
          'Here there is a single hop, and it is the destination itself. `10.10.10.10` is on your own segment, so no router is involved.'
        ),
        hint: 'Type `traceroute 10.10.10.10`.' + IF_DOWN,
        solution: 'traceroute 10.10.10.10',
        check: { cmd: 'traceroute', out: hopLine(1, '10.10.10.10') },
      },
      {
        id: 'remote',
        prompt: T(
          'Now a destination on the internet. This trace takes longer and pauses for some seconds at one of its lines, which a later step explains.',
          '',
          '```',
          'traceroute 8.8.8.8',
          '```',
          '',
          'Every packet carries a counter called TTL, *time to live*. Each router that passes a packet on lowers the counter by one. A router that lowers it to zero throws the packet away and reports that to the sender with a message called ICMP *time exceeded*.',
          '',
          '`traceroute` turns this safety mechanism into a measuring tool. Its first probes start with a TTL of 1, so the first router discards them and, by reporting it, reveals its address. The next probes start with 2 and get one router further, and so on until the destination itself answers.',
          '',
          'Read the result from the top. Hop 1 is `gw.halcyon.lab (10.10.10.1)`, your default gateway. The last line is the destination, `dns.google (8.8.8.8)`. Everything between them is a router that passed your packets along, and the times grow as the hops get further away.'
        ),
        hint: 'Type `traceroute 8.8.8.8` and wait until the prompt returns. One line takes several seconds.',
        solution: 'traceroute 8.8.8.8',
        check: { cmd: 'traceroute', fn: prints(hopLine(1, '10.10.10.1'), hopLine(10, '8.8.8.8')) },
      },
      {
        id: 'length',
        prompt: T(
          'The hop number of the destination tells you how long the path is: the destination itself, plus one router for every hop before it.',
          '',
          'At which hop number does `8.8.8.8` appear in your trace?'
        ),
        hint: 'The hop number is the first thing on each line. Look at the last line.',
        solution: '10',
        answer: /^(hop\s*)?(10|ten)\.?$/i,
      },
      {
        id: 'stars',
        prompt: T(
          'One line of the trace shows `* * *` where the name and the times should be. Each star is a probe that received no answer within the time limit, which is why the trace paused there.',
          '',
          'The router at that position did its job. The probes for the later hops passed through it, or those hops could not have answered. It only declines to send the *time exceeded* message. Many routers are set up that way, or send only a limited number of such messages per second.',
          '',
          'So stars in the middle of a trace that carries on are normal. Stars that run on to hop 30 are a different matter: the trace never arrived, because the destination or a firewall in front of it ignores the probes.',
          '',
          'Which hop number shows `* * *` in your trace to `8.8.8.8`?'
        ),
        hint: 'Look for the line with three stars and read the number in front of it.',
        solution: '3',
        answer: /^(hop\s*)?(3|three)\.?$/i,
      },
      {
        id: 'numeric',
        prompt: T(
          'By default `traceroute` looks up a name for every address it finds. The option `-n` leaves that out and prints addresses only. That is quicker, and it shows you exactly what answered.',
          '',
          'Trace the path to `1.1.1.1`, another public DNS server, with addresses only.',
          '',
          'This path has 8 hops and every one of them answers.'
        ),
        hint: 'Put `-n` between `traceroute` and the address.',
        solution: 'traceroute -n 1.1.1.1',
        check: { cmd: 'traceroute', out: /^\s*8\s+1\.1\.1\.1\s+[\d.]+ ms/m },
      },
      {
        id: 'first-hop',
        prompt: T(
          'Every packet that leaves your network goes to your default gateway first, so the gateway is hop 1 of every trace to the outside. If you ever see a different address there, your traffic is leaving by another way than you think, for example through a VPN.',
          '',
          'Compare this trace with the one to `8.8.8.8` further up in your terminal. The two paths end in different places. Which address is hop 1 in both?'
        ),
        hint: 'Read the first hop line of each trace. In the trace made with `-n` it is printed as a bare address.',
        solution: '10.10.10.1',
        answer: /^(gw(\.halcyon\.lab)?\s*\(?)?10\.10\.10\.1\)?$/i,
      },
      {
        id: 'mtr',
        prompt: T(
          '`traceroute` gives every hop three probes, once. `mtr` combines it with `ping`: it finds the hops and then keeps probing each of them, so that you get loss and timing figures for every hop.',
          '',
          '```',
          'mtr -r -c 5 8.8.8.8',
          '```',
          '',
          '`-r` asks for a report: run, print a table and stop. `-c 5` sets the number of rounds to five, so the command takes about five seconds. Without `-r`, `mtr` opens a display that keeps updating until you press `q`.',
          '',
          'The table has one row per hop. `Loss%` is the share of probes that received no answer and `Snt` is the number sent. The other columns are round-trip times in milliseconds: the last one measured, the average, the best, the worst, and how much they varied. Long names are cut short in a report.'
        ),
        hint: 'Type `mtr -r -c 5 8.8.8.8` and wait about five seconds for the table.',
        solution: 'mtr -r -c 5 8.8.8.8',
        check: { cmd: 'mtr', fn: prints(/Loss%\s+Snt/, /^\s*10\.\|-- (dns\.google|8\.8\.8\.8)\s/m) },
      },
      {
        id: 'loss',
        prompt: T(
          'Row 3 is the silent router again. `mtr` shows it as `???` with a loss of 100%. That looks alarming and is not.',
          '',
          'The rule for reading the `Loss%` column: loss matters when it carries through to the last row. A hop that shows loss while the hops after it show none is only declining to answer probes addressed to itself. It still passes your traffic on.',
          '',
          'What `Loss%` does the last row, the destination, show?'
        ),
        hint: 'Find row 10 and read the first number after the name.',
        solution: '0.0%',
        answer: /^(0(\.0+)?|zero)\s*(%|percent)?$/i,
      },
      {
        id: 'far',
        prompt: T(
          'Produce the same kind of report, five rounds, for `example.com`.',
          '',
          'When it has printed, read the `Avg` column from top to bottom. Delay adds up along a path: well under a millisecond at your gateway, and many times that at the far end.'
        ),
        hint: 'Use the `mtr` command from two steps back and change the destination.',
        solution: 'mtr -r -c 5 example.com',
        check: { cmd: 'mtr', fn: prints(/Loss%\s+Snt/, /^\s*14\.\|-- (example\.com|93\.184\.215\.14)\s/m) },
      },
      {
        id: 'further',
        prompt: 'You now have a report for `8.8.8.8` and one for `example.com`. Measured in hops, which of the two destinations is further away from you?',
        hint: 'Compare the number of the last row in each report.',
        solution: 'example.com',
        answer: /^(the\s+)?(second(\s+one)?|example\.com|93\.184\.215\.14)\.?$/i,
      },
    ],
    quiz: [
      {
        q: 'A trace shows `* * *` at hop 4. Hops 5 to 9 answer normally, and hop 9 is the destination. What does hop 4 tell you?',
        choices: [
          'The connection is broken at hop 4',
          'The router at hop 4 is switched off',
          'The router at hop 4 passes traffic on but does not send *time exceeded* messages back',
          'Hop 4 is a firewall that blocks the destination',
        ],
        answer: 2,
        why: 'The later hops could only answer because their probes passed through hop 4. A router that stays silent about expired packets is common and harmless. Only stars that continue to the end mean the trace did not arrive.',
      },
      {
        q: 'How does `traceroute` find out which routers lie on the path?',
        choices: [
          'It sends probes with a TTL of 1, 2, 3 and so on, and each router at which a probe expires reports back',
          'It asks the default gateway for its routing table',
          'It asks the destination for a list of the routers its packets came through',
          'It looks the path up on the DNS server',
        ],
        answer: 0,
        why: 'No router is asked for anything. Each one simply does what it does with any packet whose TTL runs out: it discards the packet and tells the sender, and that message carries the router\'s address.',
      },
      {
        q: 'Your default gateway is `10.10.10.1`. A trace to an internet address shows `10.8.0.1` at hop 1. What is the most likely explanation?',
        choices: [
          'The gateway has changed its address',
          '`traceroute` picks a different first hop at random for each run',
          'The destination is on your own segment',
          'Your traffic is leaving by a different route, for example through a VPN, and you should read `ip route` before you go on',
        ],
        answer: 3,
        why: 'Hop 1 is the router your machine really handed the packets to. If that is not the gateway you expect, the routing table has a more specific or a different default route. Know which path your traffic takes before you send any more.',
      },
      {
        q: 'A trace to the client\'s public website passes through eleven routers that belong to internet providers. The scope of your engagement lists the client\'s lab network only. What may you do with those routers?',
        choices: [
          'Test them, because your traffic passes through them anyway',
          'Nothing beyond letting your ordinary traffic pass. They belong to third parties and are out of scope',
          'Test them, but only the ones that answered the trace',
          'Test them after telling the client',
        ],
        answer: 1,
        why: 'Scope is a list of what the owner has allowed you to test. Routers on the way belong to other organizations, and neither you nor the client can give permission for them. Seeing a machine in a trace does not put it in scope.',
      },
    ],
    refs: ['traceroute(8)', 'mtr(8)', 'RFC 792 (ICMP)', 'RFC 1812, section 5.3.1 (time to live)'],
  };

  K.lessons.register({
    id: 'net',
    title: 'Networking fundamentals',
    order: 60,
    summary: 'Read your own addresses and routes, test reachability with ping, follow the path a packet takes, see which ports are listening, and find a network fault by working upward from the cable.',
    lessons: [addressesLesson, routesLesson, pingLesson, pathLesson],
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
