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

  K.lessons.register({
    id: 'net',
    title: 'Networking fundamentals',
    order: 60,
    summary: 'Read your own addresses and routes, test reachability with ping, follow the path a packet takes, see which ports are listening, and find a network fault by working upward from the cable.',
    lessons: [addressesLesson],
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
