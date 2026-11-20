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

  K.lessons.register({
    id: 'net',
    title: 'Networking fundamentals',
    order: 60,
    summary: 'Read your own addresses and routes, test reachability with ping, follow the path a packet takes, see which ports are listening, and find a network fault by working upward from the cable.',
    lessons: [addressesLesson, routesLesson],
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
