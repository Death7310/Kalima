/* Kalima — network discovery pack: nmap, arp-scan, fping, arping.
 *
 * Everything here talks to K.net only. Each target passes K.net.guard() before a probe is
 * "sent", so the tools work inside the engagement scope and explain themselves outside it.
 * The output is informational (which hosts answer, which ports are open, what a service says
 * it is) and follows the formats of Nmap 7.98, arp-scan 1.10.0, fping 5.4 and arping 2.26.
 */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;

  /* ------------------------------------------------------------------ port data */

  function parseRanges(text) {
    const out = [];
    for (const part of text.split(',')) {
      const ends = part.split('-').map(Number);
      for (let p = ends[0]; p <= (ends.length > 1 ? ends[1] : ends[0]); p++) out.push(p);
    }
    return out;
  }

  /** Sorted port numbers -> "21-23,80,443". */
  function formatRanges(ports) {
    const out = [];
    for (let i = 0; i < ports.length; i++) {
      let j = i;
      while (j + 1 < ports.length && ports[j + 1] === ports[j] + 1) j++;
      out.push(j > i ? ports[i] + '-' + ports[j] : String(ports[i]));
      i = j;
    }
    return out.join(',');
  }

  // The 100 most common TCP ports in nmap-services, most frequent first.
  const TOP_TCP_100 = [80, 23, 443, 21, 22, 25, 3389, 110, 445, 139, 143, 53, 135, 3306, 8080, 1723, 111, 995, 993, 5900, 1025, 587, 8888, 199,
    1720, 465, 548, 113, 81, 6001, 10000, 514, 5060, 179, 1026, 2000, 8443, 8000, 32768, 554, 26, 1433, 49152, 2001, 515, 8008, 49154, 1027,
    5666, 646, 5000, 5631, 631, 49153, 8081, 2049, 88, 79, 5800, 106, 2121, 1110, 49155, 6000, 513, 990, 5357, 427, 49156, 543, 544, 5101, 144,
    7, 389, 8009, 3128, 444, 9999, 5009, 7070, 5190, 3000, 5432, 1900, 3986, 13, 1029, 9, 5051, 6646, 49157, 1028, 873, 1755, 2717, 4899, 9100,
    119, 37];
  // The sets --top-ports 200 and the default scan cover. Past the first hundred the order inside
  // each set is by port number, which is close enough for a simulator.
  const TOP_TCP_200 = '1,3,7,9,13,17,19,21-23,25-26,37,53,79-82,88,100,106,110-111,113,119,135,139,143-144,179,199,254-255,280,311,389,427,' +
    '443-445,464-465,497,513-515,543-544,548,554,587,593,625,631,636,646,787,808,873,902,990,993,995,1000,1022,1024-1033,1035-1041,1044,' +
    '1048-1050,1053-1054,1056,1058-1059,1064-1066,1069,1071,1074,1080,1110,1234,1433,1494,1521,1720,1723,1755,1761,1801,1900,1935,1998,' +
    '2000-2003,2005,2049,2103,2105,2107,2121,2161,2301,2383,2401,2601,2717,2869,2967,3000-3001,3128,3268,3306,3389,3689-3690,3703,3986,' +
    '4000-4001,4045,4899,5000-5001,5003,5009,5050-5051,5060,5101,5120,5190,5357,5432,5555,5631,5666,5800,5900-5901,6000-6002,6004,6112,6646,' +
    '6666,7000,7070,7937-7938,8000,8002,8008-8010,8031,8080-8081,8443,8888,9000-9001,9090,9100,9102,9999-10001,10010,32768,32771,49152-49157,50000';
  // Nmap's default 1000 ports, with one change: 5985 (used by the lab's Windows server) takes the place of 5987.
  const TOP_TCP_1000 = '1,3-4,6-7,9,13,17,19-26,30,32-33,37,42-43,49,53,70,79-85,88-90,99-100,106,109-111,113,119,125,135,139,143-144,146,161,' +
    '163,179,199,211-212,222,254-256,259,264,280,301,306,311,340,366,389,406-407,416-417,425,427,443-445,458,464-465,481,497,500,512-515,524,' +
    '541,543-545,548,554-555,563,587,593,616-617,625,631,636,646,648,666-668,683,687,691,700,705,711,714,720,722,726,749,765,777,783,787,' +
    '800-801,808,843,873,880,888,898,900-903,911-912,981,987,990,992-993,995,999-1002,1007,1009-1011,1021-1100,1102,1104-1108,1110-1114,1117,' +
    '1119,1121-1124,1126,1130-1132,1137-1138,1141,1145,1147-1149,1151-1152,1154,1163-1166,1169,1174-1175,1183,1185-1187,1192,1198-1199,1201,' +
    '1213,1216-1218,1233-1234,1236,1244,1247-1248,1259,1271-1272,1277,1287,1296,1300-1301,1309-1311,1322,1328,1334,1352,1417,1433-1434,1443,' +
    '1455,1461,1494,1500-1501,1503,1521,1524,1533,1556,1580,1583,1594,1600,1641,1658,1666,1687-1688,1700,1717-1721,1723,1755,1761,1782-1783,' +
    '1801,1805,1812,1839-1840,1862-1864,1875,1900,1914,1935,1947,1971-1972,1974,1984,1998-2010,2013,2020-2022,2030,2033-2035,2038,2040-2043,' +
    '2045-2049,2065,2068,2099-2100,2103,2105-2107,2111,2119,2121,2126,2135,2144,2160-2161,2170,2179,2190-2191,2196,2200,2222,2251,2260,2288,' +
    '2301,2323,2366,2381-2383,2393-2394,2399,2401,2492,2500,2522,2525,2557,2601-2602,2604-2605,2607-2608,2638,2701-2702,2710,2717-2718,2725,' +
    '2800,2809,2811,2869,2875,2909-2910,2920,2967-2968,2998,3000-3001,3003,3005-3007,3011,3013,3017,3030-3031,3052,3071,3077,3128,3168,3211,' +
    '3221,3260-3261,3268-3269,3283,3300-3301,3306,3322-3325,3333,3351,3367,3369-3372,3389-3390,3404,3476,3493,3517,3527,3546,3551,3580,3659,' +
    '3689-3690,3703,3737,3766,3784,3800-3801,3809,3814,3826-3828,3851,3869,3871,3878,3880,3889,3905,3914,3918,3920,3945,3971,3986,3995,3998,' +
    '4000-4006,4045,4111,4125-4126,4129,4224,4242,4279,4321,4343,4443-4446,4449,4550,4567,4662,4848,4899-4900,4998,5000-5004,5009,5030,5033,' +
    '5050-5051,5054,5060-5061,5080,5087,5100-5102,5120,5190,5200,5214,5221-5222,5225-5226,5269,5280,5298,5357,5405,5414,5431-5432,5440,5500,' +
    '5510,5544,5550,5555,5560,5566,5631,5633,5666,5678-5679,5718,5730,5800-5802,5810-5811,5815,5822,5825,5850,5859,5862,5877,5900-5904,' +
    '5906-5907,5910-5911,5915,5922,5925,5950,5952,5959-5963,5985,5988-5989,5998-6007,6009,6025,6059,6100-6101,6106,6112,6123,6129,6156,6346,' +
    '6389,6502,6510,6543,6547,6565-6567,6580,6646,6666-6669,6689,6692,6699,6779,6788-6789,6792,6839,6881,6901,6969,7000-7002,7004,7007,7019,' +
    '7025,7070,7100,7103,7106,7200-7201,7402,7435,7443,7496,7512,7625,7627,7676,7741,7777-7778,7800,7911,7920-7921,7937-7938,7999-8002,' +
    '8007-8011,8021-8022,8031,8042,8045,8080-8090,8093,8099-8100,8180-8181,8192-8194,8200,8222,8254,8290-8292,8300,8333,8383,8400,8402,8443,' +
    '8500,8600,8649,8651-8652,8654,8701,8800,8873,8888,8899,8994,9000-9003,9009-9011,9040,9050,9071,9080-9081,9090-9091,9099-9103,9110-9111,' +
    '9200,9207,9220,9290,9415,9418,9485,9500,9502-9503,9535,9575,9593-9595,9618,9666,9876-9878,9898,9900,9917,9929,9943-9944,9968,9998-10004,' +
    '10009-10010,10012,10024-10025,10082,10180,10215,10243,10566,10616-10617,10621,10626,10628-10629,10778,11110-11111,11967,12000,12174,' +
    '12265,12345,13456,13722,13782-13783,14000,14238,14441-14442,15000,15002-15004,15660,15742,16000-16001,16012,16016,16018,16080,16113,' +
    '16992-16993,17877,17988,18040,18101,18988,19101,19283,19315,19350,19780,19801,19842,20000,20005,20031,20221-20222,20828,21571,22939,' +
    '23502,24444,24800,25734-25735,26214,27000,27352-27353,27355-27356,27715,28201,30000,30718,30951,31038,31337,32768-32785,33354,33899,' +
    '34571-34573,35500,38292,40193,40911,41511,42510,44176,44442-44443,44501,45100,48080,49152-49161,49163,49165,49167,49175-49176,49400,' +
    '49999-50003,50006,50300,50389,50500,50636,50800,51103,51493,52673,52822,52848,52869,54045,54328,55055-55056,55555,55600,56737-56738,' +
    '57294,57797,58080,60020,60443,61532,61900,62078,63331,64623,64680,65000,65129,65389';
  // The most common UDP ports, most frequent first. The default UDP scan fills up to 1000 with the lowest remaining numbers.
  const TOP_UDP_100 = [631, 161, 137, 123, 138, 1434, 445, 135, 67, 53, 139, 500, 68, 520, 1900, 4500, 514, 49152, 162, 69, 5353, 111, 49154,
    1701, 998, 996, 997, 999, 3283, 49153, 1812, 136, 2222, 2049, 32768, 5060, 1025, 1433, 3456, 80, 20031, 1026, 7, 1646, 1645, 593, 518,
    2048, 626, 1027, 177, 1719, 427, 497, 4444, 1023, 65024, 19, 9, 49193, 1029, 49, 88, 1028, 17185, 1718, 49186, 2000, 31337, 49201, 49192,
    515, 2223, 443, 49181, 1813, 120, 158, 49200, 3703, 32815, 17, 5000, 32771, 33281, 1030, 1022, 623, 32769, 5632, 10000, 49194, 49191,
    49182, 49156, 9200, 30718, 49211, 49190, 49188];

  /** Port ranking for one protocol: the known most-common ports first, then every other port by number. */
  function ranking(tiers) {
    const order = []; const seen = new Uint8Array(65536);
    const add = (p) => { if (!seen[p]) { seen[p] = 1; order.push(p); } };
    tiers.forEach((tier) => tier.forEach(add));
    for (let p = 1; p <= 65535; p++) add(p);
    return order;
  }
  const rankings = {};
  function topPorts(proto, n) {
    if (!rankings[proto]) {
      rankings[proto] = proto === 'udp' ? ranking([TOP_UDP_100])
        : ranking([TOP_TCP_100, parseRanges(TOP_TCP_200), parseRanges(TOP_TCP_1000)]);
    }
    return rankings[proto].slice(0, n).sort((a, b) => a - b);
  }

  // nmap-services subset: the name Nmap prints for a port when it has not asked the service itself.
  const TCP_NAMES = table('1 tcpmux,2 compressnet,3 compressnet,5 rje,7 echo,9 discard,11 systat,13 daytime,15 netstat,17 qotd,18 msp,19 chargen,20 ftp-data,21 ftp,22 ssh,23 telnet,24 priv-mail,' +
    '25 smtp,26 rsftp,33 dsp,37 time,42 nameserver,43 whois,49 tacacs,53 domain,70 gopher,79 finger,80 http,81 hosts2-ns,82 xfer,83 mit-ml-dev,' +
    '84 ctf,85 mit-ml-dev,88 kerberos-sec,89 su-mit-tg,90 dnsix,99 metagram,100 newacct,106 pop3pw,109 pop2,110 pop3,111 rpcbind,113 ident,' +
    '119 nntp,125 locus-map,135 msrpc,139 netbios-ssn,143 imap,144 news,146 iso-tp0,161 snmp,163 cmip-man,179 bgp,199 smux,211 914c-g,212 anet,' +
    '222 rsh-spx,256 fw1-secureremote,259 esro-gen,264 bgmp,280 http-mgmt,311 asip-webadmin,366 odmr,389 ldap,406 imsp,407 timbuktu,' +
    '416 silverplatter,417 onmux,425 icad-el,427 svrloc,443 https,444 snpp,445 microsoft-ds,458 appleqtc,464 kpasswd5,465 smtps,481 dvs,' +
    '497 retrospect,500 isakmp,512 exec,513 login,514 shell,515 printer,524 ncp,541 uucp-rlogin,543 klogin,544 kshell,545 ekshell,548 afp,' +
    '554 rtsp,555 dsf,563 snews,587 submission,593 http-rpc-epmap,616 sco-sysmgr,617 sco-dtmgr,625 apple-xsrvr-admin,631 ipp,636 ldapssl,' +
    '646 ldp,648 rrp,666 doom,667 disclose,668 mecomm,683 corba-iiop,687 asipregistry,691 resvc,700 epp,705 agentx,711 cisco-tdp,714 iris-xpcs,' +
    '749 kerberos-adm,765 webster,777 multiling-http,783 spamassassin,787 qsc,800 mdbs_daemon,801 device,808 ccproxy-http,873 rsync,' +
    '888 accessbuilder,898 sun-manageconsole,900 omginitialrefs,901 samba-swat,902 iss-realsecure,903 iss-console-mgr,911 xact-backup,' +
    '912 apex-mesh,990 ftps,992 telnets,993 imaps,995 pop3s,999 garcon,1000 cadlock,1001 webpush,1002 windows-icfw,1010 surf,1021 exp1,1022 exp2,' +
    '1023 netvenuechat,1024 kdm,1025 NFS-or-IIS,1026 LSA-or-nterm,1027 IIS,1029 ms-lsa,1030 iad1,1031 iad2,1032 iad3,1033 netinfo,1080 socks,' +
    '1099 rmiregistry,1110 nfsd-status,1234 hotline,1352 lotusnotes,1433 ms-sql-s,1434 ms-sql-m,1494 citrix-ica,1500 vlsi-lm,1521 oracle,' +
    '1524 ingreslock,1720 h323q931,1723 pptp,1755 wms,1801 msmq,1812 radius,1900 upnp,1935 rtmp,2000 cisco-sccp,2001 dc,2002 globe,2049 nfs,' +
    '2121 ccproxy-ftp,2222 EtherNetIP-1,2301 compaqdiag,2323 3d-nfsd,2381 compaq-https,2401 cvspserver,2601 zebra,2717 pn-requester,3000 ppp,' +
    '3001 nessus,3128 squid-http,3268 globalcatLDAP,3269 globalcatLDAPssl,3306 mysql,3389 ms-wbt-server,3690 svn,3986 mapper-ws_ethd,' +
    '4000 remoteanything,4444 krb524,4899 radmin,5000 upnp,5001 commplex-link,5009 airport-admin,5050 mmcc,5051 ida-agent,5060 sip,5061 sip-tls,' +
    '5101 admdog,5190 aol,5222 xmpp-client,5269 xmpp-server,5357 wsdapi,5432 postgresql,5555 freeciv,5631 pcanywheredata,5666 nrpe,' +
    '5800 vnc-http,5900 vnc,5901 vnc-1,5985 wsman,5986 wsmans,6000 X11,6001 X11:1,6379 redis,6666 irc,6667 irc,7000 afs3-fileserver,' +
    '7070 realserver,8000 http-alt,8008 http,8009 ajp13,8080 http-proxy,8081 blackice-icecap,8443 https-alt,8888 sun-answerbook,9000 cslistener,' +
    '9090 zeus-admin,9100 jetdirect,9200 wap-wsp,9999 abyss,10000 snet-sensor-mgmt,27017 mongod,32768 filenet-tms,50000 ibm-db2');
  // UDP names that differ from the TCP entry for the same number.
  const UDP_NAMES = table('67 dhcps,68 dhcpc,69 tftp,120 cfdptkt,123 ntp,136 profile,137 netbios-ns,138 netbios-dgm,158 pcmail-srv,162 snmptrap,' +
    '177 xdmcp,514 syslog,518 ntalk,520 route,623 asf-rmcp,626 serialnumberd,996 vsinet,997 maitrd,998 puparp,999 applix,1645 radius,1646 radacct,' +
    '1701 L2TP,1718 h225gatedisc,1719 h323gatestat,1813 radacct,2048 dls-monitor,2222 msantipiracy,2223 rockwell-csp2,3283 netassistant,' +
    '3456 IISrpc-or-vat,3703 adobeserver-3,4500 nat-t-ike,5353 zeroconf,5632 pcanywherestat,9200 wap-wsp,17185 wdbrpc,20031 bakbonenetvault,' +
    '31337 BackOrifice,32768 omad,32769 filenet-rpc,32771 sometimes-rpc6,32815 unknown,33281 unknown,49152 unknown');

  function table(text) {
    const out = Object.create(null);
    for (const entry of text.split(',')) { const sp = entry.indexOf(' '); out[entry.slice(0, sp)] = entry.slice(sp + 1); }
    return out;
  }
  const serviceName = (proto, port) => (proto === 'udp' && UDP_NAMES[port]) || TCP_NAMES[port] || 'unknown';

  /* -------------------------------------------------------------- small helpers */

  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  /** Nmap's num_to_string_sigdigits: 0.000523 -> "0.00052". */
  function sigDigits(x, digits) {
    if (x === 0) return x.toFixed(digits);
    const shift = Math.floor(Math.log10(Math.abs(x))) - digits + 1;
    const rounded = Math.round(x / Math.pow(10, shift)) * Math.pow(10, shift);
    return rounded.toFixed(Math.max(0, -shift));
  }

  const hhmm = (ms) => { const d = new Date(ms); return U.pad2(d.getUTCHours()) + ':' + U.pad2(d.getUTCMinutes()); };
  const ymd = (ms) => { const d = new Date(ms); return d.getUTCFullYear() + '-' + U.pad2(d.getUTCMonth() + 1) + '-' + U.pad2(d.getUTCDate()); };

  /** Cells padded to the widest entry of each column, as Nmap's output table does. */
  function alignRows(rows) {
    const widths = rows[0].map((h, i) => Math.max.apply(null, rows.map((r) => r[i].length)));
    return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join(' ').replace(/ +$/, ''));
  }

  /** Everything on standard input: the pipe, or lines typed at the terminal until Ctrl-D. */
  async function stdinText(ctx) {
    if (ctx.stdin != null) return ctx.stdin;
    let text = '';
    for (let line = await ctx.readLine(''); line != null; line = await ctx.readLine('')) text += line + '\n';
    return text;
  }

  /* ---------------------------------------------------- target specifications */

  /** One octet of a target: "7", "1-20", "1,5,9", "-" or "*". Returns a 256-entry membership table or null. */
  function octetSet(text) {
    const has = new Uint8Array(256);
    for (const part of (text === '*' ? '-' : text).split(',')) {
      const m = /^(\d*)(-?)(\d*)$/.exec(part);
      if (!m || (m[1] === '' && !m[2])) return null;
      const lo = m[1] === '' ? 0 : +m[1];
      const hi = !m[2] ? lo : m[3] === '' ? 255 : +m[3];
      if (lo > 255 || hi > 255 || lo > hi) return null;
      for (let v = lo; v <= hi; v++) has[v] = 1;
    }
    return has;
  }

  function specFromSets(text, sets, name, ip) {
    const vals = sets.map((has) => { const v = []; for (let i = 0; i < 256; i++) if (has[i]) v.push(i); return v; });
    return { text, sets, vals, name, ip, count: vals.reduce((n, v) => n * v.length, 1) };
  }

  /**
   * Parse one target the way Nmap does: address, octet ranges, CIDR block or host name
   * (optionally with /bits). Returns a specification, or null when a name does not resolve.
   */
  function parseTarget(machine, text) {
    if (/^[\d*,-]+(\.[\d*,-]+){3}$/.test(text)) {
      const sets = text.split('.').map(octetSet);
      if (sets.every(Boolean)) return specFromSets(text, sets, null, null);
    }
    const m = /^(.*?)(?:\/(\d+))?$/.exec(text);
    const bits = m[2] == null ? 32 : Math.min(32, +m[2]);
    const res = K.net.resolve(machine, m[1]);
    if (!res) return null;
    const block = U.parseCidr(res.ip + '/' + bits);
    const sets = [24, 16, 8, 0].map((shift) => {
      const has = new Uint8Array(256);
      for (let v = (block.network >>> shift) & 255; v <= ((block.broadcast >>> shift) & 255); v++) has[v] = 1;
      return has;
    });
    return specFromSets(text, sets, U.isIPv4(m[1]) ? null : m[1], res.ip);
  }

  /** A run of consecutive addresses (arp-scan's START-END, fping -g), usable wherever a parsed target is. */
  const rangeSpec = (text, lo, hi) => ({ text, range: [lo, hi], count: Math.max(0, hi - lo + 1), name: null, ip: null });

  function specHas(spec, n) {
    if (spec.range) return n >= spec.range[0] && n <= spec.range[1];
    return spec.sets[0][n >>> 24] && spec.sets[1][(n >>> 16) & 255] && spec.sets[2][(n >>> 8) & 255] && spec.sets[3][n & 255];
  }

  function* addresses(spec) {
    if (spec.range) { for (let n = spec.range[0]; n <= spec.range[1]; n++) yield U.intToIp(n); return; }
    const v = spec.vals;
    for (const a of v[0]) for (const b of v[1]) for (const c of v[2]) for (const d of v[3]) yield a + '.' + b + '.' + c + '.' + d;
  }

  /** What an active tool may touch while the scope guard is on: the engagement networks, this machine, loopback. */
  function allowedRanges(ctx) {
    const ranges = [[U.ipToInt('127.0.0.0'), U.ipToInt('127.255.255.255')]];
    for (const cidr of K.net.world.engagement.scope) { const p = U.parseCidr(cidr); if (p) ranges.push([p.network, p.broadcast]); }
    for (const i of ctx.machine.ifaces) if (i.ip) ranges.push([U.ipToInt(i.ip), U.ipToInt(i.ip)]);
    return ranges.sort((x, y) => x[0] - y[0]);
  }

  /**
   * The addresses of a specification that pass K.net.guard(), in order. The guard explains a
   * refusal once per specification; after that only the allowed ranges are walked, so a block
   * like 8.8.8.0/24 prints one notice instead of 256 and a huge block does not stall.
   */
  function* guardedAddresses(ctx, spec, tool, skip) {
    let passed = 0; let refusedAt = null;
    for (const ip of addresses(spec)) {
      if (skip && skip(ip)) { passed++; continue; }
      if (!K.net.guard(ctx, ip, tool)) { refusedAt = U.ipToInt(ip); break; }
      passed++;
      yield ip;
    }
    if (refusedAt == null) return;
    let cursor = refusedAt;
    for (const range of allowedRanges(ctx)) {
      for (let n = Math.max(range[0], cursor + 1); n <= range[1]; n++) {
        if (!specHas(spec, n)) continue;
        const ip = U.intToIp(n);
        passed++;
        if (!(skip && skip(ip)) && K.net.guard(ctx, ip, tool)) yield ip;
      }
      cursor = Math.max(cursor, range[1]);
    }
    const others = spec.count - passed - 1;
    if (others > 0) ctx.err('[kalima] ' + plural(others, 'more address', 'more addresses') + ' of ' + spec.text + ' outside the scope: skipped.\n');
  }

  /* ------------------------------------------------------------ nmap: options */

  const NMAP_VERSION = '7.98';
  const TEMPLATES = ['paranoid', 'sneaky', 'polite', 'normal', 'aggressive', 'insane'];
  const SERIAL_DELAY = [300000, 15000, 400]; // -T0..-T2 probe one port at a time and wait this long (ms) in between
  const SPEED = [1, 1, 1, 1, 0.6, 0.4];

  class Fatal extends Error {
    constructor(text, code, usage) { super(text); this.text = text; this.code = code; this.usage = !!usage; }
  }
  const quit = (text) => new Fatal(text + '\nQUITTING!\n', 1);
  const badOption = (text) => new Fatal('nmap: ' + text + '\nSee the output of nmap -h for a summary of options.\n', 255);
  /** A scan type Nmap does not know: it prints the whole usage summary first, then the complaint. */
  const badScanType = (text) => new Fatal(text + '\n', 255, true);

  // Long options: 1 = takes an argument.
  const NMAP_LONG = {
    help: 0, version: 0, open: 0, reason: 0, 'top-ports': 1, exclude: 1, unprivileged: 0, traceroute: 0, script: 1,
    'disable-arp-ping': 0, 'min-rate': 1,
  };
  const NMAP_FLAGS = { n: 'noDns', R: 'alwaysDns', F: 'fast', r: 'sequential', h: 'help', V: 'version', O: 'os', A: 'aggressive' };
  const SCAN_LETTERS = { S: 'syn', T: 'connect', U: 'udp', V: 'detect', C: 'scripts', n: 'pingOnly', P: 'pingOnly', L: 'list' };
  // -P letters: the kind of discovery probe each one asks for (B is the old spelling of "echo and ACK").
  const PING_LETTERS = { E: ['icmp'], I: ['icmp'], P: ['icmp'], M: ['icmp'], S: ['syn'], A: ['ack'], T: ['ack'], B: ['icmp', 'ack'], U: ['udp'] };
  const PING_DEFAULT_PORT = { syn: 80, ack: 80, udp: 40125 };
  const PING_ONCE = { syn: '-PS', ack: '-PB, -PA, or -PT', udp: '-PU' };
  const OUTPUT_KINDS = { N: ['normal'], G: ['grepable'], X: ['xml'], A: ['normal', 'grepable', 'xml'] };
  const OUTPUT_SUFFIX = { normal: '.nmap', grepable: '.gnmap', xml: '.xml' };

  function nmapOptions(args) {
    const o = { targets: [], verbose: 0, timing: 3, scans: {}, files: {}, notices: [] }; // notices: what -v adds about the options themselves
    const value = (i, attached, letter) => {
      if (attached) return [attached, i];
      if (i + 1 >= args.length) throw badOption("option requires an argument -- '" + letter + "'");
      return [args[i + 1], i + 1];
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { o.targets.push.apply(o.targets, args.slice(i + 1)); break; }
      if (a[0] !== '-' || a === '-') { o.targets.push(a); continue; }
      if (a.startsWith('--')) { i = longOption(o, args, i); continue; }
      const rest = a.slice(2); let v;
      switch (a[1]) {
        case 's':
          if (!rest) throw badScanType('An option is required for -s, most common are -sT (tcp scan), -sS (SYN scan), -sF (FIN scan), -sU (UDP scan) and -sn (Ping scan)');
          for (const ch of rest) {
            if (!SCAN_LETTERS[ch]) throw badScanType('Scantype ' + ch + ' not supported\n');
            o.scans[SCAN_LETTERS[ch]] = true;
          }
          break;
        case 'P': [v, i] = value(i, rest, 'P'); pingOption(o, v); break;
        case 'p': [v, i] = value(i, rest, 'p'); o.portSpec = v; break;
        case 'T': [v, i] = value(i, rest, 'T'); o.timing = timingLevel(v); break;
        case 'i':
          if (rest[0] !== 'L') throw badOption("unrecognized option '" + a + "'");
          [v, i] = value(i, rest.slice(1), 'i'); o.inputFile = v;
          break;
        case 'o':
          if (!OUTPUT_KINDS[rest[0]]) throw badOption("unrecognized option '" + a + "'");
          [v, i] = value(i, rest.slice(1), 'o');
          for (const kind of OUTPUT_KINDS[rest[0]]) o.files[kind] = rest[0] === 'A' ? v + OUTPUT_SUFFIX[kind] : v;
          break;
        case 'v': o.verbose += /^\d+$/.test(rest) ? +rest : /^v*$/.test(rest) ? 1 + rest.length : NaN; if (isNaN(o.verbose)) throw badOption("unrecognized option '" + a + "'"); break;
        default:
          for (const ch of a.slice(1)) {
            if (!NMAP_FLAGS[ch]) throw badOption(a.length === 2 ? "invalid option -- '" + ch + "'" : "unrecognized option '" + a + "'");
            o[NMAP_FLAGS[ch]] = true;
          }
      }
    }
    return o;
  }

  /** One -P option: -Pn, or a kind of discovery probe with an optional port list (-PS22,445). */
  function pingOption(o, arg) {
    if (/^[n0ND]/.test(arg)) {
      o.skipPing = true;
      o.notices.push("Host discovery disabled (-Pn). All addresses will be marked 'up' and scan times may be slower.");
    } else if (arg[0] === 'R') {
      o.notices.push('The -PR option is deprecated. ARP scan is always done when possible.');
    } else if (PING_LETTERS[arg[0]]) {
      o.pings = o.pings || {};
      for (const kind of PING_LETTERS[arg[0]]) {
        if (kind === 'icmp') { o.pings.icmp = true; continue; }
        if (o.pings[kind]) throw quit('Only one ' + PING_ONCE[kind] + ' option is allowed. Combine port ranges with commas.');
        const ports = arg.length > 1 && /^[\d,-]+$/.test(arg.slice(1)) ? parseRanges(arg.slice(1)).filter((p) => p >= 1 && p <= 65535) : [];
        if (arg.length > 1 && !ports.length) throw quit('Bogus argument to -P' + arg[0] + ': ' + arg.slice(1));
        o.pings[kind] = ports.length ? ports : [PING_DEFAULT_PORT[kind]];
      }
    } else throw quit('Illegal Argument to -P, use -Pn, -PE, -PS, -PA, -PP, -PM, -PU, -PY, or -PO');
  }

  function longOption(o, args, i) {
    const eq = args[i].indexOf('=');
    const typed = eq < 0 ? args[i].slice(2) : args[i].slice(2, eq);
    const names = NMAP_LONG[typed] != null ? [typed] : Object.keys(NMAP_LONG).filter((k) => k.startsWith(typed));
    if (names.length > 1) throw badOption("option '--" + typed + "' is ambiguous; possibilities: " + names.map((n) => "'--" + n + "'").join(' '));
    if (!names.length) throw badOption("unrecognized option '--" + typed + "'");
    const name = names[0]; let val = true;
    if (NMAP_LONG[name]) {
      if (eq >= 0) val = args[i].slice(eq + 1);
      else if (i + 1 < args.length) val = args[++i];
      else throw badOption("option '--" + name + "' requires an argument");
    } else if (eq >= 0) throw badOption("option '--" + name + "' doesn't allow an argument");
    o[name.replace(/-(.)/g, (x, c) => c.toUpperCase())] = val;
    return i;
  }

  function timingLevel(text) {
    const level = /^[0-5]$/.test(text) ? +text : TEMPLATES.indexOf(String(text).toLowerCase());
    if (level < 0) {
      throw quit('Unknown timing mode (-T argument).  Use either "Paranoid", "Sneaky", "Polite", "Normal", "Aggressive", "Insane" or a number from 0 (Paranoid) to 5 (Insane)');
    }
    return level;
  }

  const ILLEGAL_PORTS = 'Your port specifications are illegal.  Example of proper form: "-100,200-1024,T:3000-4000,U:60000-"';

  /** -p argument -> { tcp: [...], udp: [...], named: {T, U}, duplicates, zero } with sorted, unique ports. */
  function parsePortSpec(text) {
    const lists = { tcp: [], udp: [] }; const named = {}; let into = ['tcp', 'udp']; let duplicates = false; let zero = false;
    for (let item of text.split(',')) {
      const pre = /^([TU]):/.exec(item);
      if (pre) { into = [pre[1] === 'T' ? 'tcp' : 'udp']; named[pre[1]] = true; item = item.slice(2); }
      let ports;
      const m = /^(\d*)(-?)(\d*)$/.exec(item);
      if (item && m) {
        const lo = m[1] === '' ? 1 : +m[1];
        const hi = !m[2] ? lo : m[3] === '' ? 65535 : +m[3];
        if (lo > 65535 || hi > 65535) throw quit('Ports specified must be between 0 and 65535 inclusive');
        if (lo > hi) throw quit('Your port range ' + lo + '-' + hi + ' is backwards. Did you mean ' + hi + '-' + lo + '?');
        if (lo === 0) zero = true;
        ports = []; for (let p = lo; p <= hi; p++) ports.push(p);
      } else if (/^[a-z][\w*.-]*$/i.test(item)) {
        const want = U.globToRe(item);
        ports = Object.keys(TCP_NAMES).filter((p) => want.test(TCP_NAMES[p])).map(Number);
        if (!ports.length) throw quit("Found no matches for the service mask '" + item + "' and your specified protocols");
      } else throw quit(ILLEGAL_PORTS);
      for (const proto of into) lists[proto].push.apply(lists[proto], ports);
    }
    for (const proto of ['tcp', 'udp']) {
      const unique = Array.from(new Set(lists[proto])).sort((a, b) => a - b);
      if (unique.length !== lists[proto].length) duplicates = true;
      lists[proto] = unique;
    }
    return { tcp: lists.tcp, udp: lists.udp, named, duplicates, zero };
  }

  /**
   * The host discovery probes of a run. By default a privileged Nmap sends an ICMP echo, a SYN to 443 and
   * an ACK to 80; without raw sockets every probe becomes a plain connect(), by default to 80 and 443.
   */
  function pingProbes(o) {
    const asked = o.pings;
    if (o.root) return asked ? { icmp: !!asked.icmp, syn: asked.syn || [], ack: asked.ack || [], udp: asked.udp || [] } : { icmp: true, syn: [443], ack: [80], udp: [] };
    if (!asked) return { connect: [80, 443] };
    if (asked.udp) throw quit('Sorry, UDP Ping (-PU) only works if you are root (because we need to read raw responses off the wire)');
    if (asked.icmp) o.warnings.push('Warning:  You are not root -- using TCP pingscan rather than ICMP');
    const ports = Array.from(new Set((asked.syn || []).concat(asked.ack || [])));
    return { connect: ports.length ? ports : [PING_DEFAULT_PORT.syn] };
  }

  /** What Nmap checks while it reads its options, before it prints anything. Throws Fatal. */
  function checkOptions(ctx, o) {
    o.root = ctx.isRoot && !o.unprivileged;
    if (o.topPorts != null && !/^[1-9]\d*$/.test(o.topPorts)) throw quit('--top-ports should be an integer 1 or greater');
    if (o.minRate != null && !(/^\d+(\.\d+)?$/.test(o.minRate) && +o.minRate > 0)) throw quit('Argument to --min-rate must be a positive floating-point number');
    if (o.scans.syn && o.scans.connect) {
      throw quit('You specified more than one type of TCP scan.  Please choose only one of -sA, -b, -sT, -sF, -sI, -sM, -sN, -sS, -sW, and -sX');
    }
    o.noPorts = !!(o.scans.pingOnly || o.scans.list);
    if (o.noPorts && (o.scans.syn || o.scans.connect || o.scans.udp)) throw quit('-sL and -sn (skip port scan) are not valid with any other scan types');
    if ((o.scans.syn || o.scans.udp) && !o.root) throw quit('You requested a scan type which requires root privileges.');
    if (o.os && !o.root) throw quit('TCP/IP fingerprinting (for OS scan) requires root privileges.');
    if (o.aggressive) Object.assign(o, { os: o.root, traceroute: o.root }); // -A quietly leaves out what needs root
    o.detect = !!(o.scans.detect || o.aggressive);
    o.reason = !!o.reason || o.verbose > 1;
    o.arp = o.root && !o.disableArpPing;
  }

  /**
   * The rest of the plan: ports and discovery probes. Nmap works these out after its opening
   * line, so a Fatal thrown here follows "Starting Nmap". Warnings are collected in o.warnings.
   */
  function planScan(o) {
    o.warnings = [];
    if (o.traceroute && !o.root) throw quit('Traceroute has to be run as root');
    if (o.noPorts && (o.portSpec || o.fast)) throw quit('You cannot use -F (fast scan) or -p (explicit port selection) when not doing a port scan');
    if (o.fast && o.portSpec) {
      throw quit('You cannot use -F (fast scan) with -p (explicit port selection) but see --top-ports and --port-ratio to fast scan a range of ports');
    }
    if (!o.noPorts) {
      o.tcp = o.scans.connect ? 'connect' : o.scans.syn ? 'syn' : o.scans.udp ? null : o.root ? 'syn' : 'connect';
      o.udp = !!o.scans.udp;
      const spec = o.portSpec ? parsePortSpec(o.portSpec) : null;
      const amount = o.fast ? 100 : o.topPorts ? Math.min(65535, +o.topPorts) : 1000;
      if (spec && spec.zero) o.warnings.push('WARNING: Scanning "port 0" is supported, but unusual.');
      if (spec && spec.duplicates) o.warnings.push('WARNING: Duplicate port number(s) specified.  Are you alert enough to be using Nmap?  Have some coffee or Jolt(tm).');
      if (spec && spec.named.U && !o.udp) o.warnings.push('WARNING: Your ports include "U:" but you haven\'t specified UDP scan with -sU.');
      o.tcpPorts = spec ? spec.tcp : topPorts('tcp', amount);
      o.udpPorts = spec ? spec.udp : topPorts('udp', amount);
      if (o.tcp && !o.tcpPorts.length) { o.warnings.push('WARNING: a TCP scan type was requested, but no tcp ports were specified.  Skipping this scan type.'); o.tcp = null; }
      if (o.udp && !o.udpPorts.length) { o.warnings.push('WARNING: UDP scan was requested, but no udp ports were specified.  Skipping this scan type.'); o.udp = false; }
    }
    o.probes = pingProbes(o);
  }

  /* ---------------------------------------------------------- nmap: discovery */

  const macVendor = (host) => host.macVendor || 'Unknown';

  /** Decide whether one target is up, the way Nmap would from where it runs. Fills t.up, t.reason, t.rtt, t.mac. */
  function discoverHost(run, t) {
    const o = run.o; const machine = run.ctx.machine;
    const rt = K.net.route(machine, t.ip);
    const host = rt.host;
    Object.assign(t, { route: rt, host: host || null });
    t.ttl = host && !rt.self ? (host.os.ttl || 64) - rt.hops.length : 64;
    if (rt.self) {
      // A privileged Nmap recognises its own address and does not ping it, so a ping scan has no latency to show.
      const measured = !(o.root && o.scans.pingOnly);
      Object.assign(t, { method: 'self', up: true, reason: 'localhost-response', rtt: measured ? K.net.jitter(0.04, 0.03) : null });
    } else if (o.arp && rt.direct) {
      // On the local Ethernet segment a privileged Nmap asks with ARP, which no host firewall can refuse.
      Object.assign(t, { method: 'arp', up: rt.ok, reason: rt.ok ? 'arp-response' : 'no-response' });
      run.sent(rt.ok ? 1 : 2, 28);
      if (rt.ok) {
        Object.assign(t, { rtt: K.net.jitter(host.latency.base, host.latency.jitter), mac: host.mac.toUpperCase(), vendor: macVendor(host) });
        run.received(1, 28);
      }
    } else if (o.skipPing) {
      Object.assign(t, { method: 'none', up: true, reason: 'user-set' });
    } else if (o.root) {
      rawPing(run, t);
    } else {
      // Without raw sockets all Nmap can do is try to connect.
      const hit = o.probes.connect.map((port) => K.net.tcp(machine, t.ip, port)).find((r) => r.state !== 'filtered');
      Object.assign(t, { method: 'connect', up: !!hit, reason: !hit ? 'no-response' : hit.state === 'open' ? 'syn-ack' : 'conn-refused', rtt: hit && hit.rtt });
    }
  }

  /** Privileged discovery without ARP: the first probe that draws any answer shows the host is there. */
  function rawPing(run, t) {
    const machine = run.ctx.machine; const probes = run.o.probes;
    const answers = [];
    if (probes.icmp) {
      const echo = K.net.ping(machine, t.ip, 0, { id: run.ctx.pid & 0xffff });
      if (echo.status === 'reply') answers.push({ reason: 'echo-reply', rtt: echo.rtt });
    }
    for (const port of probes.syn) {
      const r = K.net.tcp(machine, t.ip, port);
      if (r.state !== 'filtered') answers.push({ reason: r.state === 'open' ? 'syn-ack' : 'reset', rtt: r.rtt });
    }
    for (const port of probes.ack) {
      const r = K.net.tcp(machine, t.ip, port);
      if (r.state !== 'filtered') answers.push({ reason: 'reset', rtt: r.rtt });
    }
    for (const port of probes.udp) {
      const r = K.net.udp(machine, t.ip, port);
      if (r.state === 'open' || r.state === 'closed') answers.push({ reason: r.reason, rtt: r.rtt });
    }
    run.sent(pingProbeCount(run.o, 'raw'), 38);
    const up = answers.length > 0;
    if (up) run.received(1, 40);
    Object.assign(t, { method: 'raw', up, reason: up ? answers[0].reason : 'no-response', rtt: up ? answers[0].rtt : undefined, showTtl: up });
  }

  const PING_NAMES = { arp: 'ARP Ping Scan', raw: 'Ping Scan', connect: 'Ping Scan' };

  /** How many probes one host gets in a discovery round (the default privileged set includes an ICMP timestamp request). */
  function pingProbeCount(o, method) {
    if (method === 'arp') return 1;
    if (method === 'connect') return o.probes.connect.length;
    const p = o.probes;
    return (p.icmp ? (o.pings ? 1 : 2) : 0) + p.syn.length + p.ack.length + p.udp.length;
  }

  /** Simulated duration of one discovery round: answers arrive together, silence is retried once. */
  function discoveryCost(o, hosts, method) {
    if (o.timing <= 2) return hosts.length * pingProbeCount(o, method) * SERIAL_DELAY[o.timing];
    const down = hosts.filter((t) => !t.up).length;
    const slowest = hosts.reduce((ms, t) => Math.max(ms, t.up ? t.rtt : 0), 0);
    let ms = 25 + slowest * 2 + hosts.length * 0.4;
    if (down) ms += (method === 'arp' ? 1350 : 3000) + down * (method === 'arp' ? 3 : 4);
    return ms * SPEED[o.timing] + K.net.jitter(10, 20);
  }

  async function discover(run, group) {
    for (const t of group) discoverHost(run, t);
    for (const method of ['arp', 'raw', 'connect']) {
      const hosts = group.filter((t) => t.method === method);
      if (!hosts.length) continue;
      const probes = plural(pingProbeCount(run.o, method), 'port', 'ports');
      const what = hosts.length === 1 ? hosts[0].ip + ' [' + probes + ']' : hosts.length + ' hosts [' + probes + '/host]';
      await phase(run, PING_NAMES[method], what, () => run.wait(discoveryCost(run.o, hosts, method)), () => plural(hosts.length, 'total hosts', 'total hosts'));
    }
  }

  /** Run one scan phase, framed by the "Initiating" and "Completed" lines of -v. */
  async function phase(run, name, what, work, tally) {
    const began = run.elapsed;
    run.verbose('Initiating ' + name + ' at ' + hhmm(run.now()));
    if (what) run.verbose('Scanning ' + what);
    await work();
    run.verbose('Completed ' + name + ' at ' + hhmm(run.now()) + ', ' + ((run.elapsed - began) / 1000).toFixed(2) + 's elapsed' + (tally ? ' (' + tally() + ')' : ''));
  }

  /** Reverse names for the hosts that answered (Nmap's default; -n turns it off). */
  async function resolveNames(run, hosts) {
    if (run.o.noDns || !hosts.length) return;
    const title = 'Parallel DNS resolution of ' + plural(hosts.length, 'host.', 'hosts.');
    await phase(run, title, null, async () => {
      for (const t of hosts) t.ptr = K.net.reverse(run.ctx.machine, t.ip);
      await run.wait(8 + hosts.length * 0.6 + K.net.jitter(4, 8));
    });
  }

  /* ---------------------------------------------------------- nmap: port scan */

  const SCAN_NAMES = { syn: 'SYN Stealth Scan', connect: 'Connect Scan', udp: 'UDP Scan' };
  const SCAN_TYPES = { syn: 'syn', connect: 'connect', udp: 'udp' };
  const CHUNK = 2048; // ports probed between two chances to press Ctrl-C
  const UDP_BURST = 6;       // ICMP port-unreachable replies a Linux host sends before it starts rate limiting
  const UDP_LIMITED = 900;   // ms per closed UDP port once the target limits its ICMP errors

  function probePort(run, t, kind, port) {
    const machine = run.ctx.machine;
    if (kind === 'udp') {
      const r = K.net.udp(machine, t.ip, port);
      const answered = r.state === 'open' || r.state === 'closed';
      run.sent(answered ? 1 : 2, 28);
      if (answered) run.received(1, r.state === 'open' ? 60 : 56);
      return { state: r.state, reason: r.reason, answered, ttl: answered ? t.ttl : 0, service: r.state === 'open' ? r.service : null };
    }
    const r = K.net.tcp(machine, t.ip, port);
    const raw = kind === 'syn'; const answered = r.state !== 'filtered';
    if (raw) {
      run.sent(answered ? 1 : 2, 44);
      if (answered) run.received(1, r.state === 'open' ? 44 : 40);
    }
    if (t.rtt == null && answered) t.rtt = r.rtt;
    return {
      state: r.state, answered, service: r.state === 'open' ? r.service : null,
      reason: r.state === 'closed' && !raw ? 'conn-refused' : r.reason,
      ttl: raw && answered ? t.ttl : 0,
    };
  }

  /** Simulated duration of probing some ports: answers come back at LAN speed, silence costs retransmissions. */
  function portScanCost(o, answered, silent, total) {
    const packets = answered + silent * 2;
    const quick = total <= 1000 ? 0.55 : (550 + 0.28 * (total - 1000)) / total;
    const slow = total <= 1000 ? 4.2 : (4200 + 2 * (total - 1000)) / total;
    const cost = o.timing <= 2 ? packets * SERIAL_DELAY[o.timing] : (answered * quick + silent * slow) * SPEED[o.timing];
    // --min-rate keeps Nmap sending at least that many packets a second, whatever the template says.
    return o.minRate ? Math.min(cost, (packets / +o.minRate) * 1000) : cost;
  }

  async function scanHostPorts(run, t, kind, ports, share) {
    const scan = { kind, proto: kind === 'udp' ? 'udp' : 'tcp', total: ports.length, states: {}, services: new Map(), versions: new Map(), scripts: new Map() };
    let unreachables = 0;
    t.scans.push(scan);
    for (let i = 0; i < ports.length; i += CHUNK) {
      let silent = 0; let limited = 0; const end = Math.min(ports.length, i + CHUNK);
      for (let j = i; j < end; j++) {
        const r = probePort(run, t, kind, ports[j]);
        const group = scan.states[r.state] || (scan.states[r.state] = { state: r.state, reason: r.reason, ttl: r.ttl, ports: [] });
        group.ports.push(ports[j]);
        if (!r.answered) silent++;
        if (kind === 'udp' && r.state === 'closed' && ++unreachables > UDP_BURST) limited++;
        if (r.state === 'open') {
          scan.services.set(ports[j], r.service);
          run.verbose('Discovered open port ' + ports[j] + '/' + scan.proto + ' on ' + t.ip);
        }
      }
      const waitForErrors = run.o.timing > 2 ? limited * UDP_LIMITED : 0;
      await run.wait((portScanCost(run.o, end - i - silent, silent, ports.length) + waitForErrors) * share);
    }
  }

  async function portScan(run, hosts, kind, ports) {
    const name = SCAN_NAMES[kind];
    const what = hosts.length === 1 ? hostLabel(run.o, hosts[0]) + ' [' + plural(ports.length, 'port', 'ports') + ']' : hosts.length + ' hosts [' + plural(ports.length, 'port', 'ports') + '/host]';
    await phase(run, name, what, async () => {
      const share = hosts.length > 1 ? 0.4 : 1; // the hosts of a group are scanned side by side
      for (let h = 0; h < hosts.length; h++) {
        const began = run.elapsed;
        await scanHostPorts(run, hosts[h], kind, ports, share);
        await run.wait(K.net.jitter(60, 80) * SPEED[run.o.timing] * share);
        if (h < hosts.length - 1) {
          run.verbose('Completed ' + name + ' against ' + hosts[h].ip + ' in ' + ((run.elapsed - began) / 1000).toFixed(2) + 's (' + plural(hosts.length - 1 - h, 'host', 'hosts') + ' left)');
        }
      }
    }, () => ports.length * hosts.length + ' total ports');
  }

  /* ------------------------------------------- nmap: service and OS detection */

  const TLS_BASE = { https: 'http', imaps: 'imap', pop3s: 'pop3', smtps: 'smtp', ldaps: 'ldap', ftps: 'ftp', 'domain-s': 'domain' };

  /** What -sV learns from a service record: the SERVICE cell and the VERSION text. */
  function versionInfo(svc, proto, port) {
    const extra = svc.tls && svc.extra === 'ssl' ? '' : svc.extra || '';
    const known = !!(svc.product || svc.version || extra) || svc.name === 'tcpwrapped';
    const core = [svc.product, svc.version].filter(Boolean).join(' ');
    return {
      // An unidentified service keeps its nmap-services name with a question mark.
      name: (svc.tls ? 'ssl/' : '') + (known ? (svc.tls && TLS_BASE[svc.name]) || svc.name : serviceName(proto, port) + '?'),
      known, product: svc.product || '', version: svc.version || '', extra, tunnel: svc.tls ? 'ssl' : '',
      text: core + (extra ? (core ? ' ' : '') + '(' + extra + ')' : ''),
    };
  }

  // What identified services give away about the machine behind them.
  const SERVICE_HINTS = [
    { match: /OpenSSH.*(Debian|Ubuntu)|Debian Linux|\((Debian|Ubuntu)\)/, os: 'Linux', cpe: 'cpe:/o:linux:linux_kernel' },
    { match: /^vsftpd/, os: 'Unix' },
    { match: /^Microsoft /, os: 'Windows', cpe: 'cpe:/o:microsoft:windows' },
    { match: /LaserJet|JetDirect/, device: 'printer' },
    { match: /rtspd|IP Camera/i, device: 'webcam' },
  ];

  /** The "Service Info:" summary line for a host, or '' when the services say nothing about it. */
  function serviceInfo(t, services) {
    const found = { host: [], os: [], device: [], cpe: [] };
    const note = (kind, value) => { if (value && found[kind].indexOf(value) < 0) found[kind].push(value); };
    for (const svc of services) {
      const text = [svc.product, svc.version, svc.extra].filter(Boolean).join(' ');
      const greeting = /^220 (\S+) ESMTP/.exec(svc.banner || '');
      if (greeting) note('host', greeting[1]);
      if (/Active Directory|Samba smbd/.test(text) && t.host) note('host', t.host.hostname.toUpperCase());
      for (const hint of SERVICE_HINTS) {
        if (!hint.match.test(text)) continue;
        note('os', hint.os); note('device', hint.device); note('cpe', hint.cpe);
      }
    }
    const part = (kind, one, many) => (found[kind].length ? [(found[kind].length > 1 ? many : one) + ': ' + found[kind].join(', ')] : []);
    return part('host', 'Host', 'Hosts').concat(part('os', 'OS', 'OSs'), part('device', 'Device', 'Devices'), part('cpe', 'CPE', 'CPE')).join('; ');
  }

  const openPorts = (t) => t.scans.reduce((all, scan) => all.concat(((scan.states.open || {}).ports || []).map((port) => ({ scan, port, service: scan.services.get(port) }))), []);

  async function serviceScan(run, hosts) {
    const work = hosts.map((t) => ({ t, open: openPorts(t) })).filter((w) => w.open.length);
    if (!work.length) return;
    const count = plural(work.reduce((n, w) => n + w.open.length, 0), 'service', 'services');
    const where = work.length === 1 ? hostLabel(run.o, work[0].t) : work.length + ' hosts';
    await phase(run, 'Service scan', count + ' on ' + where, async () => {
      let quiet = false; let unknown = false;
      for (const w of work) {
        for (const entry of w.open) {
          const info = versionInfo(entry.service, entry.scan.proto, entry.port);
          entry.scan.versions.set(entry.port, info);
          if (!entry.service.banner) quiet = true;
          if (!info.known) unknown = true;
        }
        w.t.serviceInfo = serviceInfo(w.t, w.open.map((e) => e.service));
      }
      // A service that does not greet is only asked after Nmap has listened for six seconds;
      // one that matches nothing costs another round of probes.
      const ms = (quiet ? 6000 : 250) + (unknown ? 5000 : 0) + parseInt(count, 10) * 110 + K.net.jitter(40, 80);
      await run.wait(ms * SPEED[run.o.timing]);
    }, () => count + ' on ' + plural(work.length, 'host', 'hosts'));
  }

  /** What -O concludes about a host from host.os, and how sure it may be given the ports it found. */
  function osGuess(t) {
    const tcp = t.scans.find((scan) => scan.proto === 'tcp') || { states: {} };
    const info = t.host && t.host.os && t.host.os.details ? t.host.os : null;
    return {
      info, open: !!tcp.states.open, ideal: !!(tcp.states.open && tcp.states.closed),
      accuracy: 86 + (U.hash32('os:' + t.ip) % 10),
      distance: t.method === 'self' ? 0 : t.route.hops.length + 1,
    };
  }

  function osRunning(info) {
    return (info.vendor === info.family ? info.vendor : info.vendor + ' ' + info.family) + (info.gen ? ' ' + info.gen : '');
  }

  function osLines(os) {
    const lines = []; const info = os.info;
    if (!os.ideal) lines.push('Warning: OSScan results may be unreliable because we could not find at least 1 open and 1 closed port');
    if (!info || !os.open) lines.push('Too many fingerprints match this host to give specific OS details');
    else if (os.ideal) lines.push('Device type: ' + info.type, 'Running: ' + osRunning(info), 'OS CPE: ' + info.cpe, 'OS details: ' + info.details);
    else {
      lines.push('Device type: ' + info.type, 'Running (JUST GUESSING): ' + osRunning(info) + ' (' + os.accuracy + '%)', 'OS CPE: ' + info.cpe,
        'Aggressive OS guesses: ' + info.details + ' (' + os.accuracy + '%)', 'No exact OS matches for host (test conditions non-ideal).');
    }
    lines.push('Network Distance: ' + plural(os.distance, 'hop', 'hops'));
    return lines;
  }

  async function osScan(run, hosts) {
    const share = hosts.length > 1 ? 0.4 : 1;
    for (const t of hosts) {
      run.verbose('Initiating OS detection (try #1) against ' + hostLabel(run.o, t));
      t.os = osGuess(t);
      run.sent(16, 60); if (t.os.open) run.received(12, 52);
      await run.wait(K.net.jitter(t.os.ideal ? 1500 : 3200, 500) * SPEED[run.o.timing] * share);
    }
  }

  /** --traceroute: the hop table of each host, built from the route the engine reports. */
  async function traceroute(run, hosts) {
    await phase(run, 'Traceroute', null, async () => {
      for (const t of hosts) {
        if (t.method === 'self') continue;
        const hops = t.route.hops.map((hop) => (hop.silent ? null : { rtt: K.net.jitter(hop.rtt, hop.rtt * 0.1), label: hop.name ? hop.name + ' (' + hop.ip + ')' : hop.ip }));
        hops.push({ rtt: t.rtt == null ? t.route.rtt : t.rtt, label: hostLabel(run.o, t) });
        const rows = [['HOP', 'RTT', 'ADDRESS']];
        for (let i = 0; i < hops.length; i++) {
          if (hops[i]) { rows.push([String(i + 1), hops[i].rtt.toFixed(2) + ' ms', hops[i].label]); continue; }
          let j = i;
          while (!hops[j + 1]) j++;
          rows.push([String(i + 1), '...', j > i ? String(j + 1) : '']);
          i = j;
        }
        const open = openPorts(t).find((e) => e.scan.proto === 'tcp');
        t.trace = [t.route.direct ? 'TRACEROUTE' : 'TRACEROUTE (using port ' + (open ? open.port : 80) + '/tcp)'].concat(alignRows(rows));
      }
      await run.wait(K.net.jitter(30, 30) * hosts.length);
    });
  }

  /* -------------------------------------------------------- nmap: script scan */

  const NSE_AGENT = 'Mozilla/5.0 (compatible; Nmap Scripting Engine; https://nmap.org/book/nse.html)';
  const DN_NAMES = { C: 'countryName', ST: 'stateOrProvinceName', L: 'localityName', O: 'organizationName', OU: 'organizationalUnitName', CN: 'commonName' };
  // The validity K.net.http reports for a host without its own certificate data.
  const DEFAULT_VALIDITY = { notBefore: 'Sep  1 00:00:00 2026 GMT', notAfter: 'Nov 30 23:59:59 2026 GMT' };

  const isHttp = (svc) => svc.handler === 'http' || /^https?$/.test(svc.name);

  /** One HTTP request as the http library of NSE makes it; null when the server does not answer. */
  function nseGet(run, t, e, path) {
    const url = (e.service.tls ? 'https' : 'http') + '://' + (t.given || t.ip) + ':' + e.port + path;
    try { return K.net.http(run.ctx.machine, { url, ip: t.ip, headers: { 'User-Agent': NSE_AGENT, Host: (t.given || t.ip) + ':' + e.port } }); }
    catch (err) { if (err instanceof K.NetError) return null; throw err; }
  }

  /** The front page of a web port, fetched once and shared by the scripts that read it. */
  function frontPage(run, t, e) {
    if (e.front === undefined) e.front = nseGet(run, t, e, '/');
    return e.front;
  }

  /** A short conversation with a line-based service: returns { greeting, ask(line) } or null. */
  function dialogue(run, t, e) {
    let session;
    try { session = K.net.connect(run.ctx.machine, t.ip, e.port); }
    catch (err) { if (err instanceof K.NetError) return null; throw err; }
    return { session, greeting: session.greeting, ask: (line) => session.send(line + '\r\n') };
  }

  function simulatedFingerprint(seed) {
    const next = U.prng('nse-hostkey:' + seed);
    return Array.from({ length: 16 }, () => Math.floor(next() * 256).toString(16).padStart(2, '0')).join(':');
  }

  const certDate = (text) => {
    const m = /^(\w{3}) +(\d+) (\d\d:\d\d:\d\d) (\d{4})/.exec(text);
    return m[4] + '-' + U.pad2(U.MONTHS.indexOf(m[1]) + 1) + '-' + U.pad2(+m[2]) + 'T' + m[3];
  };

  // The informational scripts of this simulation: which ports each one looks at and what it reports.
  const NSE_SCRIPTS = {
    banner: {
      on: (e) => e.scan.proto === 'tcp',
      run(run, t, e) {
        const talk = dialogue(run, t, e);
        if (!talk) return null;
        talk.session.close();
        const text = talk.greeting.trim().replace(/\r/g, '\\x0D').replace(/\n/g, '\\x0A');
        return text ? [text] : null;
      },
    },
    'ftp-anon': {
      on: (e) => e.service.name === 'ftp',
      run(run, t, e) {
        const talk = dialogue(run, t, e);
        if (!talk) return null;
        talk.ask('USER anonymous');
        const login = /^230/.test(talk.ask('PASS IEUser@'));
        let listing = [];
        if (login) {
          talk.session.state.data = ''; // the data connection of the simulated FTP server
          talk.ask('PASV');
          if (/^150/.test(talk.ask('LIST'))) listing = talk.session.state.data.split('\r\n').filter(Boolean).slice(0, 20);
        }
        talk.ask('QUIT');
        talk.session.close();
        return login ? ['Anonymous FTP login allowed (FTP code 230)'].concat(listing) : null;
      },
    },
    'http-robots.txt': {
      on: (e) => isHttp(e.service),
      run(run, t, e) {
        const res = nseGet(run, t, e, '/robots.txt');
        if (!res || res.status !== 200) return null;
        const paths = res.body.split(/\r?\n/).map((line) => /^\s*disallow:\s*(\S+)/i.exec(line)).filter(Boolean).map((m) => m[1]);
        return paths.length ? [plural(paths.length, 'disallowed entry', 'disallowed entries') + ' ', paths.join(' ')] : null;
      },
    },
    'http-server-header': {
      on: (e) => isHttp(e.service),
      run(run, t, e) {
        const res = frontPage(run, t, e);
        return res && res.headers.server ? [res.headers.server] : null;
      },
    },
    'http-title': {
      on: (e) => isHttp(e.service),
      run(run, t, e) {
        let res = frontPage(run, t, e); let moved = null;
        if (!res) return null;
        // NSE follows a redirect only when it stays on the host it was asked to look at.
        for (let hops = 0; res.status >= 301 && res.status <= 308 && res.headers.location && hops < 5; hops++) {
          const where = /^(?:https?:\/\/([^/:]+)(?::\d+)?)?(\/.*)?$/.exec(res.headers.location);
          if (!where || (where[1] && where[1] !== t.given && where[1] !== t.ip)) return ['Did not follow redirect to ' + res.headers.location];
          moved = res.headers.location;
          res = nseGet(run, t, e, where[2] || '/');
          if (!res) return null;
        }
        const title = /<title[^>]*>([^<]*)<\/title>/i.exec(res.body);
        const text = title ? title[1].replace(/\s+/g, ' ').trim() : "Site doesn't have a title" + (res.headers['content-type'] ? ' (' + res.headers['content-type'] + ').' : '.');
        return [text].concat(moved ? ['Requested resource was ' + moved] : []);
      },
    },
    'smtp-commands': {
      on: (e) => /^(smtp|smtps|submission)$/.test(e.service.name),
      run(run, t, e) {
        const talk = dialogue(run, t, e);
        if (!talk) return null;
        const words = talk.ask('EHLO nmap.scanme.org').split(/\r?\n/).map((line) => /^250[- ](.*)$/.exec(line)).filter(Boolean).map((m) => m[1]);
        talk.ask('QUIT');
        talk.session.close();
        return words.length ? [words.join(', ')] : null;
      },
    },
    'ssh-hostkey': {
      on: (e) => e.service.name === 'ssh',
      run(run, t) {
        const id = t.host ? t.host.id : t.ip;
        return [''].concat([[3072, 'RSA'], [256, 'ECDSA'], [256, 'ED25519']].map((k) => '  ' + k[0] + ' ' + simulatedFingerprint(id + ':' + k[1]) + ' (' + k[1] + ')'));
      },
    },
    'ssl-cert': {
      on: (e) => !!e.service.tls,
      run(run, t) {
        const name = (t.host && t.host.fqdn) || t.given || t.ip;
        const cert = Object.assign({ subject: 'CN=' + name }, DEFAULT_VALIDITY, t.host && t.host.web && t.host.web.tls);
        const subject = cert.subject.split(/,\s*/).map((part) => { const kv = part.split('='); return (DN_NAMES[kv[0]] || kv[0]) + '=' + kv.slice(1).join('='); }).reverse().join('/');
        const names = [name].concat((t.host && t.host.aliases) || []).filter((n) => !U.isIPv4(n));
        return ['Subject: ' + subject].concat(names.length ? ['Subject Alternative Name: ' + names.map((n) => 'DNS:' + n).join(', ')] : [],
          ['Not valid before: ' + certDate(cert.notBefore), 'Not valid after:  ' + certDate(cert.notAfter)]);
      },
    },
  };
  const NSE_DEFAULT = ['ftp-anon', 'http-robots.txt', 'http-title', 'smtp-commands', 'ssh-hostkey', 'ssl-cert'];

  /** The scripts a command line asks for. Anything outside this simulation is named once and left out. */
  function chosenScripts(ctx, o) {
    const chosen = new Set(o.scans.scripts || o.aggressive ? NSE_DEFAULT : []);
    for (const word of String(o.script || '').split(',').map((w) => w.trim().replace(/\.nse$/, '')).filter(Boolean)) {
      const matches = word === 'default' ? NSE_DEFAULT : Object.keys(NSE_SCRIPTS).filter((id) => U.globToRe(word).test(id));
      if (!matches.length) ctx.err("NSE: '" + word + "' is not part of this simulation, which only has these informational scripts: " + Object.keys(NSE_SCRIPTS).join(', ') + '.\n');
      matches.forEach((id) => chosen.add(id));
    }
    // http-server-header belongs to the "version" category: it comes along when -sV and the default scripts meet.
    if (o.detect && NSE_DEFAULT.every((id) => chosen.has(id))) chosen.add('http-server-header');
    return Array.from(chosen).sort();
  }

  async function scriptScan(run, hosts) {
    for (const t of hosts) run.verbose('NSE: Script scanning ' + t.ip + '.');
    await phase(run, 'NSE', null, async () => {
      let results = 0;
      for (const t of hosts) {
        for (const e of openPorts(t)) {
          const found = [];
          for (const id of run.o.scripts) {
            const lines = NSE_SCRIPTS[id].on(e) ? NSE_SCRIPTS[id].run(run, t, e) : null;
            if (lines) found.push({ id, lines });
          }
          if (found.length) e.scan.scripts.set(e.port, found);
          results += found.length;
        }
      }
      await run.wait((120 + results * 70 + K.net.jitter(40, 60)) * SPEED[run.o.timing]);
    });
  }

  /* ------------------------------------------------------------- nmap: report */

  /** "name (address)" as Nmap prints a host: the name typed on the command line, else its PTR record. */
  function hostLabel(o, t) {
    const name = t.given || (o.noDns ? null : t.ptr);
    return name ? name + ' (' + t.ip + ')' : t.ip;
  }

  function hostUpLine(o, t) {
    const why = o.reason ? ', received ' + t.reason + (t.showTtl ? ' ttl ' + t.ttl : '') : '';
    return 'Host is up' + why + (t.rtt == null ? '' : ' (' + sigDigits(t.rtt / 1000, 2) + 's latency)') + '.';
  }

  /** The IPv6 addresses /etc/hosts gives a name: Nmap scans one address and mentions the rest. */
  function otherAddresses(machine, name) {
    let hosts = '';
    try { hosts = machine.vfs.read('/etc/hosts'); } catch (e) { /* no hosts file, no other addresses */ }
    return hosts.split('\n').map((line) => line.replace(/#.*/, '').trim().split(/\s+/))
      .filter((words) => words[0].indexOf(':') >= 0 && words.slice(1).some((w) => w.toLowerCase() === name.toLowerCase())).map((words) => words[0]);
  }

  const isOpenish = (state) => state === 'open' || state === 'open|filtered';

  /** Split a host's results into the rows Nmap prints and the states it only counts ("Not shown"). */
  function portSummary(o, t) {
    const counts = {};
    for (const scan of t.scans) for (const g of Object.values(scan.states)) counts[g.state] = (counts[g.state] || 0) + g.ports.length;
    const limit = 25 * (o.verbose + 1);
    const ignored = (state) => state !== 'open' && (counts[state] > limit || (o.open && !isOpenish(state)));
    const rows = []; const hidden = []; let total = 0;
    for (const scan of t.scans) {
      total += scan.total;
      const shown = [];
      for (const g of Object.values(scan.states)) {
        if (ignored(g.state)) hidden.push({ count: g.ports.length, state: g.state, proto: scan.proto, reason: g.reason, ports: g.ports });
        else {
          for (const port of g.ports) {
            shown.push({ port, proto: scan.proto, state: g.state, reason: g.reason, ttl: g.ttl, version: scan.versions.get(port), scripts: scan.scripts.get(port) || [] });
          }
        }
      }
      rows.push.apply(rows, shown.sort((a, b) => a.port - b.port));
    }
    hidden.sort((a, b) => b.count - a.count);
    return { rows, hidden, total };
  }

  const rowService = (r) => (r.version ? r.version.name : serviceName(r.proto, r.port));

  function portTable(o, rows) {
    const cells = rows.map((r) => {
      const line = [r.port + '/' + r.proto, r.state, rowService(r)];
      if (o.reason) line.push(r.reason + (r.ttl ? ' ttl ' + r.ttl : ''));
      if (o.detect) line.push(r.version ? r.version.text : '');
      return line;
    });
    const lines = alignRows([['PORT', 'STATE', 'SERVICE'].concat(o.reason ? ['REASON'] : [], o.detect ? ['VERSION'] : [])].concat(cells));
    return rows.reduce((out, r, i) => out.concat(lines[i + 1], scriptLines(r.scripts)), [lines[0]]);
  }

  /** NSE output under a port: every line of a result starts with "| ", its last one with "|_". */
  function scriptLines(results) {
    const out = [];
    for (const result of results) {
      const text = [result.id + ': ' + result.lines[0]].concat(result.lines.slice(1));
      text.forEach((line, i) => out.push((i === text.length - 1 ? '|_' : '| ') + line));
    }
    return out;
  }

  /** The lines of one host's report, or [] when --open leaves nothing to say about it. */
  function hostReport(run, t) {
    const o = run.o; const label = hostLabel(o, t);
    if (!t.up) return o.verbose ? ['Nmap scan report for ' + label + ' [host down' + (o.reason ? ', received ' + t.reason : '') + ']'] : [];
    const lines = ['Nmap scan report for ' + label, hostUpLine(o, t)];
    const others = t.given ? otherAddresses(run.ctx.machine, t.given) : [];
    if (others.length) lines.push('Other addresses for ' + t.given + ' (not scanned): ' + others.join(' '));
    if (t.given && t.ptr && t.ptr !== t.given && !o.noDns) lines.push('rDNS record for ' + t.ip + ': ' + t.ptr);
    if (t.scans.length) {
      const sum = portSummary(o, t);
      if (o.open && !sum.rows.length) return [];
      if (o.verbose > 1) lines.push('Scanned at ' + ymd(run.started) + ' ' + new Date(run.started).toISOString().slice(11, 19) + ' UTC for ' + Math.round(run.elapsed / 1000) + 's');
      if (!sum.rows.length) lines.push('All ' + sum.total + ' scanned ports on ' + label + ' are in ignored states.');
      if (sum.hidden.length) {
        lines.push('Not shown: ' + sum.hidden.map((h) => h.count + ' ' + h.state + ' ' + h.proto + ' ' + (h.count === 1 ? 'port' : 'ports') + ' (' + h.reason + ')').join(', '));
      }
      if (sum.rows.length) lines.push.apply(lines, portTable(o, sum.rows));
    }
    if (t.mac) lines.push('MAC Address: ' + t.mac + ' (' + t.vendor + ')');
    if (t.os) lines.push.apply(lines, osLines(t.os));
    if (t.serviceInfo) lines.push('Service Info: ' + t.serviceInfo);
    if (t.trace) lines.push.apply(lines, [''].concat(t.trace));
    if (t.scans.length) lines.push('');
    return lines;
  }

  /* ------------------------------------------------------- nmap: output files */

  /** C's ctime() without the newline: "Fri Nov 13 14:30:00 2026". */
  function ctime(ms) {
    const d = new Date(ms);
    return U.DAYS[d.getUTCDay()] + ' ' + U.MONTHS[d.getUTCMonth()] + ' ' + String(d.getUTCDate()).padStart(2) + ' ' +
      d.toISOString().slice(11, 19) + ' ' + d.getUTCFullYear();
  }

  const xmlText = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/\n/g, '&#xa;');
  /** attrs({a: 1, b: null}) -> ' a="1"' (attributes without a value are left out). */
  const attrs = (o) => Object.keys(o).filter((k) => o[k] != null && o[k] !== '').map((k) => ' ' + k + '="' + xmlText(o[k]) + '"').join('');

  const scanStats = (run) => plural(run.total, 'IP address', 'IP addresses') + ' (' + plural(run.up, 'host up', 'hosts up') + ') scanned in ' + (run.elapsed / 1000).toFixed(2) + ' seconds';
  const commandLine = (run) => run.ctx.argv.join(' ');
  const initiated = (run) => 'Nmap ' + NMAP_VERSION + ' scan initiated ' + ctime(run.started) + ' as: ' + commandLine(run);
  /** The protocols a run scanned, as [{proto, kind, ports}]. */
  const scansOf = (o) => (o.tcp ? [{ proto: 'tcp', kind: o.tcp, ports: o.tcpPorts }] : []).concat(o.udp ? [{ proto: 'udp', kind: 'udp', ports: o.udpPorts }] : []);

  function normalOutput(run) {
    return ['# ' + initiated(run)].concat(run.normal, ['# Nmap done at ' + ctime(run.now()) + ' -- ' + scanStats(run)]).join('\n') + '\n';
  }

  /** -oG: one "Status" line per host and one "Ports" line when ports were scanned. */
  function grepableOutput(run) {
    const o = run.o; const lines = ['# ' + initiated(run)];
    if (o.verbose) {
      const list = (proto) => { const s = scansOf(o).find((x) => x.proto === proto); return '(' + (s ? s.ports.length + ';' + formatRanges(s.ports) : '0;') + ')'; };
      lines.push('# Ports scanned: TCP' + list('tcp') + ' UDP' + list('udp') + ' SCTP(0;) PROTOCOLS(0;)');
    }
    for (const t of run.hosts) {
      const host = 'Host: ' + t.ip + ' (' + (t.given || t.ptr || '') + ')';
      lines.push(host + '\tStatus: ' + (t.listed ? 'Unknown' : t.up ? 'Up' : 'Down'));
      if (!t.up || !t.scans.length) continue;
      const sum = portSummary(o, t);
      if (o.open && !sum.rows.length) continue;
      const ports = sum.rows.map((r) => [r.port, r.state, r.proto, '', rowService(r).replace(/\?$/, ''), '', r.version ? r.version.text.replace(/\//g, '|') : '', ''].join('/'));
      const counts = {};
      for (const h of sum.hidden) counts[h.state] = (counts[h.state] || 0) + h.count;
      lines.push(host + (ports.length ? '\tPorts: ' + ports.join(', ') : '') + Object.keys(counts).map((state) => '\tIgnored State: ' + state + ' (' + counts[state] + ')').join('') +
        (t.os && t.os.info && t.os.open ? '\tOS: ' + t.os.info.details : ''));
    }
    lines.push('# Nmap done at ' + ctime(run.now()) + ' -- ' + scanStats(run));
    return lines.join('\n') + '\n';
  }

  function xmlPorts(o, t) {
    const sum = portSummary(o, t); const out = [];
    const states = Array.from(new Set(sum.hidden.map((h) => h.state)));
    for (const state of states) {
      const parts = sum.hidden.filter((h) => h.state === state);
      out.push('<extraports' + attrs({ state, count: parts.reduce((n, h) => n + h.count, 0) }) + '>');
      for (const h of parts) out.push('<extrareasons' + attrs({ reason: h.reason, count: h.count, proto: h.proto, ports: formatRanges(h.ports) }) + '/>');
      out.push('</extraports>');
    }
    for (const r of sum.rows) {
      const v = r.version;
      const service = v
        ? attrs({ name: v.name.replace(/^ssl\/|\?$/g, ''), product: v.product, version: v.version, extrainfo: v.extra, tunnel: v.tunnel, method: v.known ? 'probed' : 'table', conf: v.known ? 10 : 3 })
        : attrs({ name: serviceName(r.proto, r.port), method: 'table', conf: 3 });
      const scripts = r.scripts.map((sc) => '<script' + attrs({ id: sc.id, output: sc.lines.join('\n') }) + '/>').join('');
      out.push('<port' + attrs({ protocol: r.proto, portid: r.port }) + '><state' + attrs({ state: r.state, reason: r.reason, reason_ttl: r.ttl }) + '/><service' + service + '/>' + scripts + '</port>');
    }
    out[0] = '<ports>' + (out[0] || '');
    return out.concat('</ports>');
  }

  function xmlOs(os) {
    const out = ['<os>'];
    if (os.info && os.open) {
      const accuracy = os.ideal ? 100 : os.accuracy;
      out.push('<osmatch' + attrs({ name: os.info.details, accuracy, line: 60000 + (U.hash32(os.info.details) % 40000) }) + '>',
        '<osclass' + attrs({ type: os.info.type, vendor: os.info.vendor, osfamily: os.info.family, osgen: os.info.gen, accuracy }) + '><cpe>' + xmlText(os.info.cpe) + '</cpe></osclass>',
        '</osmatch>');
    }
    return out.concat('</os>', '<distance' + attrs({ value: os.distance }) + '/>');
  }

  function xmlHost(run, t) {
    const status = '<status' + attrs({ state: t.listed ? 'unknown' : t.up ? 'up' : 'down', reason: t.listed ? 'user-set' : t.reason, reason_ttl: t.showTtl ? t.ttl : 0 }) + '/>';
    const out = [(t.up ? '<host' + attrs({ starttime: Math.floor(run.started / 1000), endtime: Math.floor(t.finished / 1000) }) + '>' : '<host>') + status,
      '<address' + attrs({ addr: t.ip, addrtype: 'ipv4' }) + '/>'];
    if (t.mac) out.push('<address' + attrs({ addr: t.mac, addrtype: 'mac', vendor: t.vendor === 'Unknown' ? null : t.vendor }) + '/>');
    out.push('<hostnames>');
    if (t.given) out.push('<hostname' + attrs({ name: t.given, type: 'user' }) + '/>');
    if (t.ptr) out.push('<hostname' + attrs({ name: t.ptr, type: 'PTR' }) + '/>');
    out.push('</hostnames>');
    if (t.up && t.scans.length) out.push.apply(out, xmlPorts(run.o, t));
    if (t.os) out.push.apply(out, xmlOs(t.os));
    if (t.trace) {
      out.push('<trace>');
      for (const row of t.trace.slice(2)) {
        const m = /^(\d+) +([\d.]+) ms +(?:(\S+) \()?([\d.]+)\)?$/.exec(row);
        if (m) out.push('<hop' + attrs({ ttl: m[1], ipaddr: m[4], rtt: m[2], host: m[3] }) + '/>');
      }
      out.push('</trace>');
    }
    if (t.up && t.rtt != null) out.push('<times' + attrs({ srtt: Math.round(t.rtt * 1000), rttvar: Math.round(t.rtt * 400) + 20, to: 100000 }) + '/>');
    return out.concat('</host>');
  }

  /** -oX: the nmaprun document Nmap 7.98 writes (xmloutputversion 1.05). */
  function xmlOutput(run) {
    const o = run.o; const end = run.now(); const stats = scanStats(run);
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE nmaprun>', '<?xml-stylesheet href="file:///usr/share/nmap/nmap.xsl" type="text/xsl"?>',
      '<!-- ' + initiated(run) + ' -->',
      '<nmaprun' + attrs({ scanner: 'nmap', args: commandLine(run), start: Math.floor(run.started / 1000), startstr: ctime(run.started), version: NMAP_VERSION, xmloutputversion: '1.05' }) + '>'];
    for (const scan of scansOf(o)) out.push('<scaninfo' + attrs({ type: SCAN_TYPES[scan.kind], protocol: scan.proto, numservices: scan.ports.length, services: formatRanges(scan.ports) }) + '/>');
    out.push('<verbose level="' + o.verbose + '"/>', '<debugging level="0"/>');
    for (const t of run.hosts) out.push.apply(out, xmlHost(run, t));
    out.push('<runstats><finished' + attrs({ time: Math.floor(end / 1000), timestr: ctime(end), summary: 'Nmap done at ' + ctime(end) + '; ' + stats, elapsed: (run.elapsed / 1000).toFixed(2), exit: 'success' }) +
      '/><hosts' + attrs({ up: run.up, down: run.total - run.up, total: run.total }) + '/>', '</runstats>', '</nmaprun>');
    return out.join('\n') + '\n';
  }

  const OUTPUTS = { normal: normalOutput, grepable: grepableOutput, xml: xmlOutput };
  const LOG_NAMES = { normal: 'normal', grepable: 'machine', xml: 'XML' };

  /** Nmap opens its output files before it scans, so a path that cannot be written stops the run early. */
  function openOutputs(ctx, o) {
    for (const kind of Object.keys(o.files)) {
      if (o.files[kind] === '-') continue;
      try { ctx.fs.write(o.files[kind], ''); } catch (e) {
        throw quit('Failed to open ' + LOG_NAMES[kind] + ' output file ' + o.files[kind] + ' for writing');
      }
    }
  }

  function writeOutputs(run) {
    for (const kind of Object.keys(run.o.files)) {
      const text = OUTPUTS[kind](run);
      if (run.o.files[kind] === '-') run.ctx.out(text);
      else run.ctx.fs.write(run.o.files[kind], text);
    }
  }

  /* --------------------------------------------------------------- nmap: main */

  /** The text of the -iL file. Nmap opens it while it reads its options; "-" (standard input) is read later. */
  function inputFileText(ctx, o) {
    if (o.inputFile == null || o.inputFile === '-') return '';
    try { return ctx.fs.read(o.inputFile); } catch (e) {
      throw quit('Failed to open input file ' + o.inputFile + ' for reading: ' + e.message + ' (' + (e.code === 'EACCES' ? 13 : 2) + ')');
    }
  }

  function nmapTargets(run, words) {
    const ctx = run.ctx; const o = run.o; const specs = [];
    for (const word of words) {
      const spec = parseTarget(ctx.machine, word);
      if (spec) specs.push(spec);
      else ctx.err('Failed to resolve "' + word.replace(/\/\d+$/, '') + '".\n');
    }
    const excluded = String(o.exclude || '').split(',').filter(Boolean).map((word) => parseTarget(ctx.machine, word)).filter(Boolean);
    const skip = (ip) => { const n = U.ipToInt(ip); return excluded.some((spec) => specHas(spec, n)); };
    return (function* () {
      for (const spec of specs) {
        for (const ip of guardedAddresses(ctx, spec, 'nmap', skip)) {
          yield { ip, given: spec.name && spec.ip === ip ? spec.name : null, scans: [] };
        }
      }
    })();
  }

  /** -sL: name the targets and send them nothing. */
  async function listGroup(run, group) {
    await resolveNames(run, group);
    for (const t of group) {
      t.listed = true;
      run.report('Nmap scan report for ' + hostLabel(run.o, t));
      run.hosts.push(t);
    }
    run.total += group.length;
  }

  async function scanGroup(run, group) {
    const o = run.o;
    if (o.scans.list) return listGroup(run, group);
    await discover(run, group);
    const up = group.filter((t) => t.up);
    await resolveNames(run, o.alwaysDns ? group : up);
    if (up.length) {
      if (o.tcp) await portScan(run, up, o.tcp, o.tcpPorts);
      if (o.udp) await portScan(run, up, 'udp', o.udpPorts);
      if (o.detect) await serviceScan(run, up);
      if (o.os) await osScan(run, up);
      if (o.traceroute) await traceroute(run, up);
      if (o.scripts.length) await scriptScan(run, up);
    }
    for (const t of group) {
      t.finished = run.now();
      for (const line of hostReport(run, t)) run.report(line);
      if (t.up || o.verbose) run.hosts.push(t);
    }
    run.total += group.length; run.up += up.length;
  }

  const GROUP_SIZE = 256;

  /** Nmap's format_bytecount: 28B, 44.000KB, 2.880MB. */
  const byteCount = (n) => (n < 1000 ? n + 'B' : n < 1e6 ? (n / 1000).toFixed(3) + 'KB' : (n / 1e6).toFixed(3) + 'MB');

  async function nmapScan(run) {
    const o = run.o; const ctx = run.ctx;
    let listed = inputFileText(ctx, o);
    openOutputs(ctx, o);
    if (o.verbose) for (const notice of o.notices) ctx.err(notice + '\n');
    run.say('Starting Nmap ' + NMAP_VERSION + ' ( https://nmap.org ) at ' + ymd(run.started) + ' ' + hhmm(run.started) + ' UTC');
    planScan(o);
    for (const w of o.warnings) ctx.err(w + '\n');
    o.scripts = o.noPorts ? [] : chosenScripts(ctx, o);
    if (o.inputFile === '-') listed = await stdinText(ctx);
    const targets = nmapTargets(run, listed.replace(/#.*/g, '').split(/\s+/).filter(Boolean).concat(o.targets));
    if (o.scripts.length) run.verbose('NSE: Loaded ' + plural(o.scripts.length, 'script', 'scripts') + ' for scanning.');
    await run.wait(K.net.jitter(25, 20));
    let group = [];
    for (const t of targets) {
      group.push(t);
      if (group.length === GROUP_SIZE) { await scanGroup(run, group); group = []; }
    }
    if (group.length) await scanGroup(run, group);
    if (o.verbose) run.report('Read data files from: /usr/share/nmap');
    if (!run.total) run.ctx.err('WARNING: No targets were specified, so 0 hosts scanned.\n');
    const detected = [o.os && 'OS', o.detect && 'Service'].filter(Boolean).join(' and ');
    // The hint is for the screen only; Nmap leaves it out of the -oN file.
    if (run.total === 1 && !run.up && !o.skipPing && !o.scans.list) run.say('Note: Host seems down. If it is really up, but blocking our ping probes, try -Pn');
    else if (detected && run.up) run.report(detected + ' detection performed. Please report any incorrect results at https://nmap.org/submit/ .');
    run.say('Nmap done: ' + scanStats(run));
    writeOutputs(run);
    if (o.verbose && o.root) {
      run.say('           Raw packets sent: ' + run.raw.sent + ' (' + byteCount(run.raw.sentBytes) + ') | Rcvd: ' + run.raw.rcvd + ' (' + byteCount(run.raw.rcvdBytes) + ')');
    }
  }

  function newRun(ctx, o) {
    // "-oG -" and friends put that format on standard output in place of the interactive text.
    const quiet = Object.keys(o.files).some((kind) => o.files[kind] === '-');
    const run = {
      ctx, o, started: K.clock.now(), elapsed: 0, total: 0, up: 0, hosts: [], normal: [],
      raw: { sent: 0, sentBytes: 0, rcvd: 0, rcvdBytes: 0 },
      sent(packets, bytes) { run.raw.sent += packets; run.raw.sentBytes += packets * bytes; },
      received(packets, bytes) { run.raw.rcvd += packets; run.raw.rcvdBytes += packets * bytes; },
      now: () => run.started + run.elapsed,
      // Simulated time is counted here rather than read from the clock so the summary is right at any time scale.
      wait(ms) { run.elapsed += ms; return ctx.sleep(ms); },
      say(line) { if (!quiet) ctx.out(line + '\n'); },
      report(line) { run.normal.push(line); run.say(line); },
      verbose(line) { if (o.verbose) run.say(line); },
    };
    return run;
  }

  const NMAP_USAGE = [
    'Nmap ' + NMAP_VERSION + ' ( https://nmap.org )',
    'Usage: nmap [Scan Type(s)] [Options] {target specification}',
    'TARGET SPECIFICATION:',
    '  Can pass hostnames, IP addresses, networks, etc.',
    '  Ex: scanme.nmap.org, microsoft.com/24, 192.168.0.1; 10.0.0-255.1-254',
    '  -iL <inputfilename>: Input from list of hosts/networks',
    '  --exclude <host1[,host2][,host3],...>: Exclude hosts/networks',
    'HOST DISCOVERY:',
    '  -sL: List Scan - simply list targets to scan',
    '  -sn: Ping Scan - disable port scan',
    '  -Pn: Treat all hosts as online -- skip host discovery',
    '  -PS/PA/PU[portlist]: TCP SYN, TCP ACK or UDP discovery to given ports',
    '  -PE/PP/PM: ICMP echo, timestamp, and netmask request discovery probes',
    '  -n/-R: Never do DNS resolution/Always resolve [default: sometimes]',
    '  --traceroute: Trace hop path to each host',
    'SCAN TECHNIQUES:',
    '  -sS/sT: TCP SYN/Connect() scans',
    '  -sU: UDP Scan',
    'PORT SPECIFICATION AND SCAN ORDER:',
    '  -p <port ranges>: Only scan specified ports',
    '    Ex: -p22; -p1-65535; -p U:53,111,137,T:21-25,80,139,8080,S:9',
    '  -F: Fast mode - Scan fewer ports than the default scan',
    '  -r: Scan ports sequentially - don\'t randomize',
    '  --top-ports <number>: Scan <number> most common ports',
    'SERVICE/VERSION DETECTION:',
    '  -sV: Probe open ports to determine service/version info',
    'SCRIPT SCAN:',
    '  -sC: equivalent to --script=default',
    '  --script=<Lua scripts>: <Lua scripts> is a comma separated list of',
    '           directories, script-files or script-categories',
    'OS DETECTION:',
    '  -O: Enable OS detection',
    'TIMING AND PERFORMANCE:',
    '  -T<0-5>: Set timing template (higher is faster)',
    '  --min-rate <number>: Send packets no slower than <number> per second',
    'OUTPUT:',
    '  -oN/-oX/-oG <file>: Output scan in normal, XML,',
    '     and Grepable format, respectively, to the given filename.',
    '  -oA <basename>: Output in the three major formats at once',
    '  -v: Increase verbosity level (use -vv or more for greater effect)',
    '  --reason: Display the reason a port is in a particular state',
    '  --open: Only show open (or possibly open) ports',
    'MISC:',
    '  -A: Enable OS detection, version detection, script scanning, and traceroute',
    '  --unprivileged: Assume the user lacks raw socket privileges',
    '  -V: Print version number',
    '  -h: Print this help summary page.',
    'EXAMPLES:',
    '  nmap -v -A scanme.nmap.org',
    '  nmap -v -sn 192.168.0.0/16 10.0.0.0/8',
    '  nmap -v -iR 10000 -Pn -p 80',
    'SEE THE MAN PAGE (https://nmap.org/book/man.html) FOR MORE OPTIONS AND EXAMPLES',
  ].join('\n') + '\n';

  const NMAP_VERSION_TEXT = 'Nmap version ' + NMAP_VERSION + ' ( https://nmap.org )\nPlatform: x86_64-pc-linux-gnu\n' +
    'Compiled with: liblua-5.4.8 openssl-3.5.4 libssh2-1.11.1 libz-1.3.1 libpcre2-10.46 libpcap-1.10.5 nmap-libdnet-1.18.0 ipv6\n' +
    'Compiled without:\nAvailable nsock engines: epoll poll select\n';

  async function nmapRun(ctx) {
    try {
      if (!ctx.args.length) { ctx.out(NMAP_USAGE); return 255; }
      const o = nmapOptions(ctx.args);
      if (o.help) { ctx.out(NMAP_USAGE); return 0; }
      if (o.version) { ctx.out(NMAP_VERSION_TEXT); return 0; }
      checkOptions(ctx, o);
      await nmapScan(newRun(ctx, o));
      return 0;
    } catch (e) {
      if (e instanceof Fatal) { if (e.usage) ctx.out(NMAP_USAGE); ctx.err(e.text); return e.code; }
      if (e instanceof K.Interrupt) { ctx.err('caught SIGINT signal, cleaning up\n'); return 1; }
      throw e;
    }
  }

  /** Completion shared by the tools of this pack: lab host names and the networks in scope. */
  function labTargets() {
    const world = K.net.world;
    return world.hosts.filter((h) => h.fqdn).map((h) => h.fqdn).concat(world.engagement.scope).sort();
  }

  function nmapComplete(info) {
    const before = info.words[info.index - 1] || '';
    if (before === '--script') return Object.keys(NSE_SCRIPTS).concat('default');
    if (/^-(iL|o[NGXA])$/.test(before)) return []; // a file name: leave it to path completion
    if (info.cur.startsWith('--')) return Object.keys(NMAP_LONG).map((name) => '--' + name);
    return info.cur[0] === '-' ? [] : labTargets();
  }

  K.cmd.register({
    name: 'nmap', pkg: 'nmap', section: 1, only: 'kali',
    summary: 'Network exploration tool and security / port scanner',
    synopsis: 'nmap [Scan Type...] [Options] {target specification}',
    man: 'DESCRIPTION\n' +
      '       Nmap ("Network Mapper") is a tool for network exploration and security auditing. It finds out which hosts on a network answer, ' +
      'which ports they have open and what the services behind those ports say they are. A scan has two stages: host discovery (is the address ' +
      'in use?) and, for every host that is up, a port scan. By default Nmap scans the 1000 most common TCP ports.\n\n' +
      '       How Nmap discovers hosts depends on who runs it. As root on the local Ethernet segment it asks with ARP, which every host must ' +
      'answer, and it reports the MAC address. Without root it can only try to connect to ports 80 and 443, so a host that filters both looks ' +
      'down. Likewise the port scan is a SYN scan (-sS) for root and a full connect scan (-sT) otherwise.\n\n' +
      '       A port is reported as open (a service accepted the connection), closed (the host answered that nothing listens there) or ' +
      'filtered (no answer at all, usually a firewall).\n\n' +
      '       Scan only systems you are authorized to test. In this lab the engagement scope is 10.10.10.0/24; see ~/engagement.\n\n' +
      'TARGET SPECIFICATION\n' +
      '       Targets are host names, addresses, CIDR blocks (10.10.10.0/24) or octet ranges (10.10.10.1-20, 10.10.10.1,10,20).\n' +
      '       -iL FILE\n              Read targets from FILE (- for standard input).\n' +
      '       --exclude HOST[,HOST...]\n              Leave these hosts or networks out.\n\n' +
      'HOST DISCOVERY\n' +
      '       -sL    List scan: name the targets and send them nothing.\n' +
      '       -sn    Ping scan: discover hosts, do not scan ports.\n' +
      '       -Pn    Skip host discovery and treat every target as up.\n' +
      '       -PS[PORTS], -PA[PORTS], -PU[PORTS], -PE\n' +
      '              Discover hosts with TCP SYN, TCP ACK, UDP or ICMP echo probes instead of the default set. Without root every TCP ' +
      'probe is a connect() and the others are not available.\n' +
      '       --disable-arp-ping\n              Do not use ARP on the local network; use the IP-level probes there too.\n' +
      '       -n, -R Never, or always, look up reverse DNS names.\n' +
      '       --traceroute\n              Show the hops to each host (root).\n\n' +
      'SCAN TECHNIQUES AND PORTS\n' +
      '       -sS    TCP SYN scan (default for root). Requires root privileges.\n' +
      '       -sT    TCP connect scan (default without root).\n' +
      '       -sU\n              UDP scan. Requires root privileges. Slow, because hosts limit how fast they report closed ports.\n' +
      '       -p RANGES\n              Scan only these ports: -p22, -p1-1024, -p22,80,443, -p- for all 65535, -p U:53,T:22 per protocol.\n' +
      '       -F     Fast: scan the 100 most common ports.\n' +
      '       --top-ports N\n              Scan the N most common ports.\n\n' +
      'SERVICE, OS AND SCRIPT DETECTION\n' +
      '       -sV\n              Ask the open ports what they are and show product and version in a VERSION column.\n' +
      '       -O     Guess the operating system from how the host answers (root).\n' +
      '       -sC    Run the default scripts; the same as --script=default.\n' +
      '       --script NAMES\n              Run the named scripts. This simulation has these informational ones: banner, ftp-anon, ' +
      'http-robots.txt, http-server-header, http-title, smtp-commands, ssh-hostkey, ssl-cert.\n' +
      '       -A     Aggressive: -sV, -sC and, as root, -O and --traceroute.\n\n' +
      'TIMING\n' +
      '       -T0 ... -T5\n              Timing template, from paranoid (very slow) to insane. -T3 is the default.\n' +
      '       --min-rate N\n              Send at least N packets per second.\n\n' +
      'OUTPUT\n' +
      '       -oN FILE, -oG FILE, -oX FILE\n              Also write the results to FILE in normal, grepable or XML format (- for standard output).\n' +
      '       -oA BASENAME\n              Write all three: BASENAME.nmap, BASENAME.gnmap and BASENAME.xml.\n' +
      '       --open Show only open ports.\n' +
      '       --reason\n              Show why each port is in its state (syn-ack, reset, conn-refused, no-response).\n' +
      '       -v     More detail while the scan runs. May be given twice.\n' +
      '       -h, -V Print the option summary, or the version.\n\n' +
      'EXAMPLES\n' +
      '       nmap -sn 10.10.10.0/24\n              Which hosts of the lab network are up?\n' +
      '       sudo nmap -p 22,80,443 --reason web01.halcyon.lab\n              Check three ports on one host and show the evidence for each state.\n' +
      '       sudo nmap -sV -O -oA files01 files01.halcyon.lab\n              Services, versions and operating system of one host, saved in all three formats.',
    run: nmapRun,
    complete: nmapComplete,
  });

  /* ------------------------------------------------------------------ arp-scan */

  const ARPSCAN_VERSION = '1.10.0';
  const ARPSCAN_URL = 'https://github.com/royhills/arp-scan';
  const ARPSCAN_USAGE = [
    'Usage: arp-scan [options] [hosts...]', '',
    'Target hosts must be specified on the command line unless the --file or',
    '--localnet option is used.', '',
    'arp-scan uses raw sockets, which requires privileges on some systems:', '',
    'Linux with POSIX.1e capabilities support using libcap:',
    '       arp-scan is capabilities aware. It requires CAP_NET_RAW in the permitted',
    '       set and only enables that capability for the required functions.',
    'BSD and macOS:',
    '       You need read/write access to /dev/bpf*',
    'Any operating system:',
    '       Running as root or SUID root will work on any OS but other methods',
    '       are preferable where possible.', '',
  ];
  const ARPSCAN_FOOTER = ['Report bugs or send suggestions at ' + ARPSCAN_URL, 'See the arp-scan homepage at ' + ARPSCAN_URL];
  const ARPSCAN_BRIEF = ARPSCAN_USAGE.concat(['use "arp-scan --help" for detailed information on the available options.', ''], ARPSCAN_FOOTER).join('\n') + '\n';
  const ARPSCAN_HELP = ARPSCAN_USAGE.concat([
    'The target hosts can be specified as IP addresses or hostnames. You can also',
    'specify the target as IPnetwork/bits (e.g. 192.168.1.0/24) to specify all hosts',
    'in the given network (network and broadcast addresses included), or',
    'IPstart-IPend (e.g. 192.168.1.3-192.168.1.27) to specify all hosts in the',
    'inclusive range, or IPnetwork:NetMask (e.g. 192.168.1.0:255.255.255.0) to',
    'specify all hosts in the given network and mask.', '',
    'Options:', '',
    '--help or -h\t\tDisplay this usage message and exit.', '',
    '--localnet or -l\tGenerate addresses from network interface configuration.',
    '\t\t\tUse the network interface IP address and network mask',
    '\t\t\tto generate the list of target host addresses.', '',
    '--interface=<s> or -I <s> Use network interface <s>.',
    '\t\t\tIf this option is not specified, arp-scan will search',
    '\t\t\tthe system interface list for the lowest numbered,',
    '\t\t\tconfigured up interface (excluding loopback).', '',
    '--retry=<i> or -r <i>\tSet total number of attempts per host to <i>,',
    '\t\t\tdefault=2.', '',
    '--timeout=<i> or -t <i>\tSet initial per host timeout to <i> ms, default=500.', '',
    '--quiet or -q\t\tOnly display minimal output. No protocol decoding.',
    '\t\t\tOnly the IP address and MAC address are displayed.', '',
    '--plain or -x\t\tDisplay plain output showing only responding hosts.',
    '\t\t\tThis option suppresses the printing of the header and',
    '\t\t\tfooter text.', '',
    '--version or -V\t\tDisplay program version and exit.', '',
  ], ARPSCAN_FOOTER).join('\n') + '\n';
  const ARPSCAN_VERSION_TEXT = 'arp-scan ' + ARPSCAN_VERSION + '\n\nCopyright (C) 2005-2022 Roy Hills\n' +
    'License GPLv3+: GNU GPL version 3 or later <http://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\n' +
    'There is NO WARRANTY, to the extent permitted by law.\n\nlibpcap version 1.10.5 (with TPACKET_V3)\nBuilt with libcap POSIX.1e capability support.\n';
  // arp-scan names vendors from the IEEE registry, which spells some of them differently from Nmap.
  const IEEE_NAMES = { VMware: 'VMware, Inc.', Microsoft: 'Microsoft Corporation', 'Axis Communications': 'Axis Communications AB', 'Oracle VirtualBox virtual NIC': 'PCS Systemtechnik GmbH' };
  const ARPSCAN_PACKET_MS = 2.56; // gap between two requests at the default bandwidth
  const ARPSCAN_BACKOFF = 1.5;    // each further attempt waits this much longer for its answer

  /** Time arp-scan spends on hosts that stay silent: every retry pass, then the last timeout. */
  function arpScanSilence(silent, firstPass, retry, timeout) {
    let ms = 0; let pass = firstPass;
    for (let attempt = 1; attempt < retry; attempt++) {
      ms += Math.max(0, timeout - pass);
      pass = silent * ARPSCAN_PACKET_MS;
      ms += pass;
      timeout *= ARPSCAN_BACKOFF;
    }
    return ms + timeout;
  }

  const etherIface = (machine, name) => (name ? machine.ifaces.find((i) => i.name === name) : machine.primaryIface());
  /** The lab host that answers ARP for this address on the interface's segment, if any. */
  function arpNeighbour(iface, ip) {
    const host = K.net.knownHost(ip);
    return host && host.up && !host.inet && iface.ip && ip !== iface.ip && U.inCidr(ip, iface.ip + '/' + iface.bits) ? host : null;
  }

  /** One arp-scan target: address, name, NET/BITS, NET:MASK or START-END. Returns null when a name does not resolve. */
  function arpScanTarget(machine, word) {
    const range = /^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+)$/.exec(word);
    if (range && U.isIPv4(range[1]) && U.isIPv4(range[2])) return rangeSpec(word, U.ipToInt(range[1]), U.ipToInt(range[2]));
    const masked = /^(\d+\.\d+\.\d+\.\d+):(\d+\.\d+\.\d+\.\d+)$/.exec(word);
    if (masked && U.isIPv4(masked[1]) && U.isIPv4(masked[2])) {
      const bits = U.ipToInt(masked[2]).toString(2).replace(/0+$/, '').length;
      return Object.assign(parseTarget(machine, masked[1] + '/' + bits), { text: word });
    }
    return /^[\d.]+(\/\d+)?$/.test(word) && !U.isIPv4(word.replace(/\/\d+$/, '')) ? null : parseTarget(machine, word);
  }

  async function arpScanRun(ctx) {
    const g = ctx.getopt({
      short: 'lI:r:t:qxVh', long: ['localnet', 'interface=', 'retry=', 'timeout=', 'quiet', 'plain', 'version', 'help'],
      alias: { localnet: 'l', interface: 'I', retry: 'r', timeout: 't', quiet: 'q', plain: 'x', version: 'V', help: 'h' },
    });
    if (g.err) { ctx.err('arp-scan: ' + g.err + '\n' + ARPSCAN_BRIEF); return 1; }
    if (g.opts.h) { ctx.out(ARPSCAN_HELP); return 0; }
    if (g.opts.V) { ctx.out(ARPSCAN_VERSION_TEXT); return 0; }
    if (!g.rest.length && !g.opts.l) { ctx.err(ARPSCAN_BRIEF); return 1; }
    const iface = etherIface(ctx.machine, g.opts.I);
    if (!iface) { ctx.err('ioctl: No such device\n'); return 1; }
    if (!ctx.isRoot) {
      ctx.err('pcap_activate: ' + iface.name + ": You don't have permission to perform this capture on that device (socket: Operation not permitted)\n");
      return 1;
    }
    if (g.opts.l && g.rest.length) { ctx.err('ERROR: You can not specify targets with the --localnet option\n'); return 1; }
    const retry = Math.max(1, parseInt(g.opts.r, 10) || 2); const timeout = parseInt(g.opts.t, 10) || 500;
    const specs = [];
    for (const word of g.opts.l ? [iface.ip + '/' + iface.bits] : g.rest) {
      const spec = arpScanTarget(ctx.machine, word);
      if (spec) specs.push(spec);
      else ctx.err('WARNING: get_host_address failed for "' + word + '": Name or service not known - target ignored\n');
    }
    if (!specs.length) { ctx.err('ERROR: No hosts to process.\n'); return 1; }
    const say = (line) => { if (!g.opts.x) ctx.out(line + '\n'); };
    say('Interface: ' + iface.name + ', type: EN10MB, MAC: ' + iface.mac + ', IPv4: ' + (iface.ip || '(none)'));
    say('Starting arp-scan ' + ARPSCAN_VERSION + ' with ' + specs.reduce((n, sp) => n + sp.count, 0) + ' hosts (' + ARPSCAN_URL + ')');
    let hosts = 0; let responded = 0; let elapsed = 0; let batch = 0;
    const wait = (ms) => { elapsed += ms; return ctx.sleep(ms); };
    const sendBatch = () => { const ms = batch * ARPSCAN_PACKET_MS; batch = 0; return wait(ms); };
    for (const spec of specs) {
      for (const ip of guardedAddresses(ctx, spec, 'arp-scan')) {
        hosts++;
        const host = arpNeighbour(iface, ip);
        if (host) {
          responded++;
          ctx.out(ip + '\t' + host.mac + (g.opts.q ? '' : '\t' + (IEEE_NAMES[host.macVendor] || host.macVendor || '(Unknown)')) + '\n');
        }
        if (++batch === 64) await sendBatch();
      }
    }
    await sendBatch();
    const silent = hosts - responded;
    await wait((silent ? arpScanSilence(silent, elapsed, retry, timeout) : 0) + K.net.jitter(40, 40));
    say('');
    say(responded + ' packets received by filter, 0 packets dropped by kernel');
    const secs = elapsed / 1000;
    say('Ending arp-scan ' + ARPSCAN_VERSION + ': ' + hosts + ' hosts scanned in ' + secs.toFixed(3) + ' seconds (' + (hosts / secs).toFixed(2) + ' hosts/sec). ' + responded + ' responded');
    return 0;
  }

  K.cmd.register({
    name: 'arp-scan', path: '/usr/sbin/arp-scan', pkg: 'arp-scan', section: 1, only: 'kali',
    summary: 'Send ARP requests to target hosts and display responses',
    synopsis: 'arp-scan [options] [hosts...]',
    man: 'DESCRIPTION\n' +
      '       arp-scan sends ARP requests to the target hosts and displays every response: the IP address, the MAC address and the vendor ' +
      'that the MAC address prefix is registered to. ARP works below IP, so a host firewall cannot hide a machine from it, but it only reaches ' +
      'hosts on the local network segment. It needs raw access to the network interface, so it must be run as root.\n\n' +
      '       Targets are IP addresses or host names, a network as NET/BITS (10.10.10.0/24) or NET:MASK, or a range as START-END ' +
      '(10.10.10.1-10.10.10.50). Network and broadcast addresses are included.\n\n' +
      'OPTIONS\n' +
      '       -l, --localnet\n              Scan the network the interface is configured for.\n' +
      '       -I NAME, --interface=NAME\n              Use this network interface instead of the first configured one.\n' +
      '       -r N, --retry=N\n              Total number of attempts per host (default 2).\n' +
      '       -t MS, --timeout=MS\n              Initial per-host timeout in milliseconds (default 500).\n' +
      '       -q, --quiet\n              Show only the IP and MAC address.\n' +
      '       -x, --plain\n              Show only responding hosts, without header and footer.\n' +
      '       -h, --help; -V, --version\n              Display the usage message or the version and exit.\n\n' +
      'EXAMPLES\n' +
      '       sudo arp-scan -l\n              Every host on the lab network that answers ARP.\n' +
      '       sudo arp-scan -I eth0 10.10.10.1-10.10.10.60\n              Ask a range of addresses on a named interface.',
    run: arpScanRun,
    complete: (info) => (info.words[info.index - 1] === '-I' ? info.machine.ifaces.map((i) => i.name) : info.cur[0] === '-' ? [] : labTargets()),
  });

  /* --------------------------------------------------------------------- fping */

  const FPING_USAGE = [
    'Usage: fping [options] [targets...]', '',
    'Probing options:',
    '   -c, --count=N      count mode: send N pings to each target and report stats',
    '   -f, --file=FILE    read list of targets from a file ( - means stdin)',
    '   -g, --generate     generate target list (only if no -f specified),',
    '                      limited to at most 131072 targets',
    '                      (give start and end IP in the target list, or a CIDR address)',
    '                      (ex. fping -g 192.168.1.0 192.168.1.255 or fping -g 192.168.1.0/24)',
    '   -h, --help         show this page',
    '   -i, --interval=MSEC  interval between sending ping packets (default: 10 ms)',
    '   -p, --period=MSEC  interval between ping packets to one target (in ms)',
    '                      (in loop and count modes, default: 1000 ms)',
    '   -r, --retry=N      number of retries (default: 3)',
    '   -t, --timeout=MSEC individual target initial timeout (default: 500 ms,',
    "                      except with -l/-c/-C, where it's the -p period up to 2000 ms)", '',
    'Output options:',
    '   -a, --alive        show targets that are alive',
    '   -A, --addr         show targets by address',
    '   -d, --rdns         show targets by name (force reverse-DNS lookup)',
    '   -e, --elapsed      show elapsed time on return packets',
    '   -n, --name         show targets by name (reverse-DNS lookup for target IPs)',
    "   -q, --quiet        quiet (don't show per-target/per-ping results)",
    '   -s, --stats        print final stats',
    '   -u, --unreach      show targets that are unreachable',
    '   -v, --version      show version',
  ].join('\n') + '\n';
  const FPING_MAX_GENERATE = 131072;

  /** fping's sprint_tm: three significant digits of a time in ms. */
  function fpingTime(ms) {
    return ms < 1 ? ms.toFixed(3) : ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : ms.toFixed(0);
  }

  /**
   * The address list of fping -g: a CIDR block without its network and broadcast address, or START END.
   * Returns a specification, { fail } with fping's message, or null when the usage text is due.
   */
  function fpingGenerate(args) {
    const unparsable = (sep, addr) => ({ fail: 'fping' + sep + " can't parse address " + addr + ': Name or service not known\n' });
    let lo; let hi;
    if (args.length === 1) {
      const slash = args[0].lastIndexOf('/');
      if (slash < 0) return null;
      const addr = args[0].slice(0, slash); const mask = args[0].slice(slash + 1);
      if (!U.isIPv4(addr)) return unparsable(',', addr);
      if (!/^\d+$/.test(mask) || +mask < 1 || +mask > 32) return { fail: 'fping: netmask must be between 1 and 32 (is: ' + mask + ')\n' };
      const block = U.parseCidr(args[0]); const whole = block.bits >= 31;
      lo = block.network + (whole ? 0 : 1); hi = block.broadcast - (whole ? 0 : 1);
    } else if (args.length === 2) {
      const bad = args.find((a) => !U.isIPv4(a));
      if (bad) return unparsable(':', bad);
      lo = U.ipToInt(args[0]); hi = U.ipToInt(args[1]);
    } else return null;
    if (hi - lo + 1 > FPING_MAX_GENERATE) return { fail: 'fping: -g parameter generates too many addresses\n' };
    return rangeSpec(args.join(' '), lo, hi);
  }

  /** K.getopt words its errors like GNU getopt; fping's own option parser words them like this. */
  function fpingOptionError(err) {
    const long = /'--([^']+)'/.exec(err);
    if (!long) return err;
    const what = /requires an argument/.test(err) ? 'option requires an argument' : /allow an argument/.test(err) ? 'option takes no arguments' : 'invalid option';
    return what + " -- '" + long[1] + "'";
  }


  /** Resolve fping's target words; returns { targets: [{ip, label}], unknown } after the scope guard. */
  function fpingTargets(ctx, o, words) {
    const machine = ctx.machine; const targets = []; let unknown = 0;
    const label = (ip, given) => (o.byAddr ? ip : o.byName ? K.net.reverse(machine, ip) || given : given);
    if (o.generate) {
      for (const ip of guardedAddresses(ctx, o.generate, 'fping')) targets.push({ ip, label: label(ip, ip) });
      return { targets, unknown };
    }
    for (const word of words) {
      const res = K.net.resolve(machine, word);
      if (!res) { ctx.err(word + ': Name or service not known\n'); unknown++; continue; }
      if (K.net.guard(ctx, res.ip, 'fping')) targets.push({ ip: res.ip, label: label(res.ip, word) });
    }
    return { targets, unknown };
  }

  function fpingOptions(ctx) {
    const g = ctx.getopt({
      short: 'aAc:def:ghi:np:qr:st:uv',
      long: ['alive', 'addr', 'count=', 'rdns', 'elapsed', 'file=', 'generate', 'help', 'interval=', 'name', 'period=', 'quiet', 'retry=', 'stats', 'timeout=', 'unreach', 'version'],
      alias: { alive: 'a', addr: 'A', count: 'c', rdns: 'd', elapsed: 'e', file: 'f', generate: 'g', help: 'h', interval: 'i', name: 'n', period: 'p', quiet: 'q', retry: 'r', stats: 's', timeout: 't', unreach: 'u', version: 'v' },
    });
    if (g.err) return { fail: 'fping: ' + fpingOptionError(g.err) + "\nsee 'fping -h' for usage information\n" };
    const o = { opts: g.opts, words: g.rest, alive: g.opts.a, unreach: g.opts.u, quiet: g.opts.q, stats: g.opts.s, elapsed: g.opts.e, byAddr: g.opts.A, byName: g.opts.n || g.opts.d };
    const number = (key, fallback, min) => {
      if (g.opts[key] == null) return fallback;
      const n = Number(g.opts[key]);
      return /^\d+(\.\d+)?$/.test(g.opts[key]) && n >= min ? n : NaN;
    };
    Object.assign(o, { count: number('c', 0, 1), interval: number('i', 10, 1), period: number('p', 1000, 10), retry: number('r', 3, 0), timeout: number('t', 500, 1) });
    if ([o.count, o.interval, o.period, o.retry, o.timeout].some(isNaN)) return { fail: FPING_USAGE };
    if (o.alive && o.unreach) return { fail: 'fping: specify only one of a, u\n' };
    return o;
  }

  /** The default mode: every target is asked until it answers or the retries run out. */
  async function fpingOnce(ctx, o, targets, st) {
    let pending = targets.slice(); let timeout = o.timeout;
    for (let attempt = 0; attempt <= o.retry && pending.length; attempt++) {
      if (attempt) { await st.wait(Math.max(0, timeout - pending.length * o.interval)); timeout *= 1.5; }
      const waiting = [];
      for (const t of pending) {
        const r = K.net.ping(ctx.machine, t.ip, attempt, { id: ctx.pid & 0xffff });
        st.sent++;
        if (r.status === 'reply') {
          st.replies.push(r.rtt); t.alive = true;
          if (!o.unreach && !o.quiet) ctx.out(t.label + (o.alive ? '' : ' is alive') + (o.elapsed ? ' (' + fpingTime(r.rtt) + ' ms)' : '') + '\n');
        } else {
          waiting.push(t);
          if (r.status === 'unreachable' && attempt < o.retry) {
            st.other++;
            if (!o.quiet) ctx.err('ICMP Host Unreachable from ' + r.from + ' for ICMP Echo sent to ' + t.label + (U.isIPv4(t.label) ? '' : ' (' + r.from + ')') + '\n');
          }
        }
        await st.wait(o.interval);
      }
      pending = waiting;
    }
    if (pending.length) await st.wait(timeout);
    st.timeouts += pending.length;
    for (const t of pending) if (!o.alive && !o.quiet) ctx.out(t.label + (o.unreach ? '' : ' is unreachable') + '\n');
  }

  /** Count mode (-c): N pings per target, one line per ping and a summary per target on stderr. */
  async function fpingCount(ctx, o, targets, st) {
    const width = targets.reduce((w, t) => Math.max(w, t.label.length), 0);
    for (const t of targets) Object.assign(t, { xmt: 0, times: [] });
    const loss = (t) => Math.floor(((t.xmt - t.times.length) * 100) / t.xmt);
    const avg = (t) => (t.times.length ? fpingTime(t.times.reduce((a, b) => a + b, 0) / t.times.length) : 'NaN');
    try {
      for (let seq = 0; seq < o.count; seq++) {
        for (const t of targets) {
          const r = K.net.ping(ctx.machine, t.ip, seq, { id: ctx.pid & 0xffff });
          st.sent++; t.xmt++;
          if (r.status === 'reply') { t.times.push(r.rtt); st.replies.push(r.rtt); t.alive = true; } else st.timeouts++;
          const what = r.status === 'reply' ? '64 bytes, ' + fpingTime(r.rtt) + ' ms' : 'timed out';
          if (!o.quiet) ctx.out(t.label.padEnd(width) + ' : [' + seq + '], ' + what + ' (' + avg(t) + ' avg, ' + loss(t) + '% loss)\n');
          await st.wait(o.interval);
        }
        if (seq < o.count - 1) await st.wait(Math.max(0, o.period - targets.length * o.interval));
      }
    } finally {
      if (!o.quiet) ctx.err('\n');
      for (const t of targets) {
        const rtt = t.times.length ? ', min/avg/max = ' + [Math.min.apply(null, t.times), t.times.reduce((a, b) => a + b, 0) / t.times.length, Math.max.apply(null, t.times)].map(fpingTime).join('/') : '';
        ctx.err(t.label.padEnd(width) + ' : xmt/rcv/%loss = ' + t.xmt + '/' + t.times.length + '/' + (t.xmt ? loss(t) : 0) + '%' + rtt + '\n');
      }
    }
  }

  function fpingStats(ctx, targets, unknown, st) {
    const n = (v) => String(v).padStart(8);
    const alive = targets.filter((t) => t.alive).length;
    const rtt = (v) => ' ' + fpingTime(st.replies.length ? v : 0) + ' ms';
    const sum = st.replies.reduce((a, b) => a + b, 0);
    ctx.err(['', n(targets.length) + ' targets', n(alive) + ' alive', n(targets.length - alive) + ' unreachable', n(unknown) + ' unknown addresses', '',
      n(st.timeouts) + ' timeouts (waiting for response)', n(st.sent) + ' ICMP Echos sent', n(st.replies.length) + ' ICMP Echo Replies received', n(st.other) + ' other ICMP received', '',
      rtt(Math.min.apply(null, st.replies)) + ' (min round trip time)', rtt(sum / st.replies.length) + ' (avg round trip time)', rtt(Math.max.apply(null, st.replies)) + ' (max round trip time)',
      ' ' + (st.elapsed / 1000).toFixed(3).padStart(12) + ' sec (elapsed real time)', '', ''].join('\n'));
  }

  async function fpingRun(ctx) {
    const o = fpingOptions(ctx);
    if (o.fail) { ctx.err(o.fail); return 1; }
    if (o.opts.h) { ctx.out(FPING_USAGE); return 0; }
    if (o.opts.v) { ctx.out('fping: Version 5.4\n'); return 0; }
    let words = o.words; const file = o.opts.f;
    if ((file != null && (words.length || o.opts.g)) || (o.opts.g && !words.length)) { ctx.err(FPING_USAGE); return 1; }
    if (o.opts.g) {
      o.generate = fpingGenerate(words);
      if (!o.generate || o.generate.fail) { ctx.err(o.generate ? o.generate.fail : FPING_USAGE); return 1; }
    } else if (!words.length) {
      // Without targets fping reads them from a file, by default standard input.
      let text;
      if (file == null || file === '-') text = await stdinText(ctx);
      else {
        try { text = ctx.fs.read(file); } catch (e) { ctx.err('fping: fopen : ' + e.message + '\n'); return 4; }
      }
      words = text.split('\n').map((line) => line.replace(/#.*/, '').trim().split(/\s+/)[0]).filter(Boolean);
    }
    const found = fpingTargets(ctx, o, words);
    if (!found.targets.length) return found.unknown ? 2 : 1;
    const st = { sent: 0, replies: [], timeouts: 0, other: 0, elapsed: 0, wait(ms) { st.elapsed += ms; return ctx.sleep(ms); } };
    try {
      if (o.count) await fpingCount(ctx, o, found.targets, st);
      else await fpingOnce(ctx, o, found.targets, st);
    } catch (e) {
      if (!(e instanceof K.Interrupt)) throw e; // Ctrl-C ends the run early; the summary and the exit status still follow
    }
    if (o.stats) fpingStats(ctx, found.targets, found.unknown, st);
    return found.unknown ? 2 : found.targets.every((t) => t.alive) ? 0 : 1;
  }

  K.cmd.register({
    name: 'fping', pkg: 'fping', section: 8, only: 'kali',
    summary: 'send ICMP ECHO_REQUEST packets to network hosts',
    synopsis: 'fping [ options ] [ systems... ]',
    man: 'DESCRIPTION\n' +
      '       fping is a program like ping which uses the Internet Control Message Protocol (ICMP) echo request to determine if a target host is ' +
      'responding. fping differs from ping in that you can specify any number of targets on the command line, or specify a file containing the ' +
      'lists of targets to ping. Instead of sending to one target until it times out or replies, fping will send out a ping packet and move on ' +
      'to the next target in a round-robin fashion. A target that replies is noted as alive; one that does not answer within the retry limit ' +
      'is reported as unreachable. Hosts that drop ICMP look unreachable even though they are up.\n\n' +
      'OPTIONS\n' +
      '       -a, --alive\n              Show systems that are alive.\n' +
      '       -u, --unreach\n              Show targets that are unreachable.\n' +
      '       -g, --generate ADDR/MASK | START END\n              Generate the target list from a CIDR block (without its network and broadcast address) or a range.\n' +
      '       -c N, --count=N\n              Send N pings to each target and report statistics for each.\n' +
      '       -q, --quiet\n              Do not show per-probe results and ICMP error messages, only the final summary.\n' +
      '       -s, --stats\n              Print cumulative statistics upon exit.\n' +
      '       -e, --elapsed\n              Show elapsed (round-trip) time of packets.\n' +
      '       -A, --addr; -n, --name\n              Display targets by address, or by their reverse DNS name.\n' +
      '       -f FILE, --file=FILE\n              Read the list of targets from FILE (- means standard input).\n' +
      '       -r N, -t MSEC, -i MSEC, -p MSEC\n              Retry limit (3), initial timeout (500), interval between packets (10) and per-target period in count mode (1000).\n\n' +
      'EXIT STATUS\n       0 if all the hosts are reachable, 1 if some hosts were unreachable, 2 if any IP addresses were not found.\n\n' +
      'EXAMPLES\n' +
      '       fping -a -g 10.10.10.0/24 2>/dev/null\n              List the addresses of the lab network that answer a ping.\n' +
      '       fping -c 3 web01.halcyon.lab db01.halcyon.lab\n              Three pings to each host, with loss and round-trip statistics.',
    run: fpingRun,
    complete: (info) => (info.cur[0] === '-' ? [] : labTargets()),
  });

  /* -------------------------------------------------------------------- arping */

  const ARPING_USAGE = 'ARPing 2.26, by Thomas Habets <thomas@habets.se>\n' +
    'usage: arping [ -qr ] [ -c <count> ] [ -i <interface> ] <host/ip>\nFor complete usage info, use --help or check the manpage.\n';

  const ARPING_INTERVAL = 1000;
  const arpingTime = (ms) => (ms < 1 ? (ms * 1000).toFixed(3) + ' usec' : ms < 1000 ? ms.toFixed(3) + ' msec' : (ms / 1000).toFixed(3) + ' sec');

  function arpingStats(ctx, ip, sent, times) {
    const lost = sent ? ((sent - times.length) * 100) / sent : 0;
    ctx.out('\n--- ' + ip + ' statistics ---\n' + sent + ' packets transmitted, ' + times.length + ' packets received, ' + lost.toFixed(0).padStart(3) + '% unanswered (0 extra)\n');
    if (!times.length) { ctx.out('\n'); return; }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const dev = Math.sqrt(times.reduce((a, b) => a + (b - avg) * (b - avg), 0) / times.length);
    ctx.out('rtt min/avg/max/std-dev = ' + [Math.min.apply(null, times), avg, Math.max.apply(null, times), dev].map((v) => v.toFixed(3)).join('/') + ' ms\n');
  }

  async function arpingRun(ctx) {
    const g = ctx.getopt({ short: 'c:i:I:qrh', long: ['help'], alias: { I: 'i', help: 'h' } });
    if (g.err) { ctx.err('arping: ' + g.err + '\n' + ARPING_USAGE); return 1; }
    if (g.opts.h) { ctx.out(ARPING_USAGE); return 0; }
    if (g.rest.length !== 1) { ctx.err(ARPING_USAGE); return 1; }
    const count = g.opts.c == null ? Infinity : parseInt(g.opts.c, 10);
    if (!(count > 0)) { ctx.err('arping: invalid count: ' + g.opts.c + '\n'); return 1; }
    if (!ctx.isRoot) {
      ctx.err('arping: libnet_init(LIBNET_LINK, ' + (g.opts.i || '<null>') + '): libnet_open_link(): UID/EUID 0 or capability CAP_NET_RAW required\n');
      return 1;
    }
    if (g.opts.i && !etherIface(ctx.machine, g.opts.i)) {
      ctx.err('arping: libnet_init(LIBNET_LINK, ' + g.opts.i + '): libnet_check_iface() ioctl: No such device\n');
      return 1;
    }
    const res = K.net.resolve(ctx.machine, g.rest[0]);
    if (!res) { ctx.err("arping: Can't resolve " + g.rest[0] + ', or ' + g.rest[0] + ' is broadcast: libnet_name2addr4(): hostname must be specified\n'); return 1; }
    if (!K.net.guard(ctx, res.ip, 'arping')) return 1;
    const local = ctx.machine.ifaces.find((i) => i.kind !== 'loopback' && i.ip && U.inCidr(res.ip, i.ip + '/' + i.bits));
    const iface = g.opts.i ? etherIface(ctx.machine, g.opts.i) : local || ctx.machine.primaryIface();
    if (!g.opts.i && !local) {
      ctx.err('arping: Unable to automatically find interface to use. Is it on the local LAN?\narping: Use -i to manually specify interface. Guessing interface ' + iface.name + '.\n');
    }
    const say = (line) => { if (!g.opts.q) ctx.out(line + '\n'); };
    const host = arpNeighbour(iface, res.ip);
    const times = []; let sent = 0;
    if (!g.opts.r) say('ARPING ' + res.ip);
    try {
      while (sent < count) {
        if (host) {
          const rtt = K.net.jitter(host.latency.base, host.latency.jitter);
          times.push(rtt);
          say(g.opts.r ? host.mac : '60 bytes from ' + host.mac + ' (' + res.ip + '): index=' + sent + ' time=' + arpingTime(rtt));
        }
        sent++;
        // The next request goes out a second later; a missing answer is only known by then.
        if (sent < count || !host) await ctx.sleep(ARPING_INTERVAL);
        if (!host && !g.opts.r) say('Timeout');
      }
    } catch (e) {
      if (!(e instanceof K.Interrupt)) throw e; // like ping, Ctrl-C ends the run with the statistics
    }
    if (!g.opts.q && !g.opts.r) arpingStats(ctx, res.ip, sent, times);
    return times.length ? 0 : 1;
  }

  K.cmd.register({
    name: 'arping', path: '/usr/sbin/arping', pkg: 'arping', section: 8, only: 'kali',
    summary: 'sends arp and/or ip pings to a given host',
    synopsis: 'arping [-qr] [-c count] [-i interface] <host | ip>',
    man: 'DESCRIPTION\n' +
      '       The arping utility sends ARP requests to the given host and shows the replies with the MAC address that answered and the ' +
      'round-trip time, much as ping does with ICMP. Because every host on an Ethernet segment has to answer ARP, arping reaches machines ' +
      'that drop pings, but only on the local network. It needs raw access to the interface and must be run as root.\n\n' +
      'OPTIONS\n' +
      '       -c count\n              Only send count requests. Without it arping continues until interrupted.\n' +
      '       -i interface\n              Use the specified interface (-I is accepted as well).\n' +
      '       -q     Does not display messages, except error messages.\n' +
      '       -r     Raw output: only the MAC address is displayed for each reply.\n' +
      '       -h, --help\n              Displays a help message and exits.\n\n' +
      'EXIT STATUS\n       0 when at least one reply was received, 1 otherwise.\n\n' +
      'EXAMPLES\n' +
      '       sudo arping -c 3 10.10.10.50\n              Is the domain controller there, even though it ignores ping?\n' +
      '       sudo arping -r -c 1 gw.halcyon.lab\n              Print just the MAC address of the gateway.',
    run: arpingRun,
    complete: (info) => (/^-[iI]$/.test(info.words[info.index - 1]) ? info.machine.ifaces.map((i) => i.name) : info.cur[0] === '-' ? [] : labTargets()),
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
