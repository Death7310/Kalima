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
  const TCP_NAMES = table('1 tcpmux,3 compressnet,7 echo,9 discard,13 daytime,17 qotd,19 chargen,20 ftp-data,21 ftp,22 ssh,23 telnet,24 priv-mail,' +
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

  const specHas = (spec, n) => spec.sets[0][n >>> 24] && spec.sets[1][(n >>> 16) & 255] && spec.sets[2][(n >>> 8) & 255] && spec.sets[3][n & 255];

  function* addresses(spec) {
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
    constructor(text, code) { super(text); this.text = text; this.code = code; }
  }
  const quit = (text) => new Fatal(text + '\nQUITTING!\n', 1);
  const badOption = (text) => new Fatal('nmap: ' + text + '\nSee the output of nmap -h for a summary of options.\n', 255);

  // Long options: 1 = takes an argument.
  const NMAP_LONG = { help: 0, version: 0, open: 0, reason: 0, 'top-ports': 1, exclude: 1, unprivileged: 0 };
  const NMAP_FLAGS = { n: 'noDns', R: 'alwaysDns', F: 'fast', r: 'sequential', h: 'help', V: 'version' };
  const SCAN_LETTERS = { S: 'syn', T: 'connect', n: 'pingOnly', P: 'pingOnly' };

  function nmapOptions(args) {
    const o = { targets: [], verbose: 0, timing: 3, scans: {} };
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
          if (!rest) throw quit('An option is required for -s, most common are -sT (tcp scan), -sS (SYN scan), -sF (FIN scan), -sU (UDP scan) and -sn (Ping scan)');
          for (const ch of rest) {
            if (!SCAN_LETTERS[ch]) throw quit('Scantype ' + ch + ' not supported');
            o.scans[SCAN_LETTERS[ch]] = true;
          }
          break;
        case 'P':
          if (!/^[n0N]$/.test(rest)) throw quit('Illegal Argument to -P, use -Pn, -PE, -PS, -PA, -PP, -PM, -PU, -PY, or -PO');
          o.skipPing = true;
          break;
        case 'p': [v, i] = value(i, rest, 'p'); o.portSpec = v; break;
        case 'T': [v, i] = value(i, rest, 'T'); o.timing = timingLevel(v); break;
        case 'i':
          if (rest[0] !== 'L') throw badOption("unrecognized option '" + a + "'");
          [v, i] = value(i, rest.slice(1), 'i'); o.inputFile = v;
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

  /** -p argument -> { tcp: [...], udp: [...], named: {T, U}, duplicates } with sorted, unique ports. */
  function parsePortSpec(text) {
    const lists = { tcp: [], udp: [] }; const named = {}; let into = ['tcp', 'udp']; let duplicates = false;
    for (let item of text.split(',')) {
      const pre = /^([TU]):/.exec(item);
      if (pre) { into = [pre[1] === 'T' ? 'tcp' : 'udp']; named[pre[1]] = true; item = item.slice(2); }
      let ports;
      const m = /^(\d*)(-?)(\d*)$/.exec(item);
      if (item && m) {
        const lo = m[1] === '' ? 1 : +m[1];
        const hi = !m[2] ? lo : m[3] === '' ? 65535 : +m[3];
        if (lo > 65535 || hi > 65535) throw quit('Ports specified must be between 0 and 65535 inclusive');
        if (lo > hi) throw quit(ILLEGAL_PORTS);
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
    return { tcp: lists.tcp, udp: lists.udp, named, duplicates };
  }

  /** Turn the parsed command line into a scan plan; throws Fatal for combinations Nmap refuses. */
  function nmapPlan(ctx, o) {
    o.root = ctx.isRoot && !o.unprivileged;
    if (o.scans.syn && o.scans.connect) {
      throw quit('You specified more than one type of TCP scan.  Please choose only one of -sA, -b, -sT, -sF, -sI, -sM, -sN, -sS, -sW, and -sX');
    }
    if (o.scans.pingOnly && (o.scans.syn || o.scans.connect)) throw quit('-sL and -sn (skip port scan) are not valid with any other scan types');
    if (o.scans.syn && !o.root) throw quit('You requested a scan type which requires root privileges.');
    if (o.fast && o.portSpec) {
      throw quit('You cannot use -F (fast scan) with -p (explicit port selection) but see --top-ports and --port-ratio to fast scan a range of ports');
    }
    if (o.topPorts != null && !/^[1-9]\d*$/.test(o.topPorts)) throw quit('--top-ports should be an integer 1 or greater');
    o.reason = !!o.reason || o.verbose > 1;
    o.tcp = o.scans.pingOnly ? null : o.scans.connect || !o.root ? 'connect' : 'syn';
    if (o.scans.pingOnly) return o;
    if (o.portSpec) {
      const spec = parsePortSpec(o.portSpec);
      if (spec.duplicates) o.warnings = ['WARNING: Duplicate port number(s) specified.  Are you alert enough to be using Nmap?  Have some coffee or Jolt(tm).'];
      o.tcpPorts = spec.tcp;
    } else o.tcpPorts = topPorts('tcp', o.fast ? 100 : o.topPorts ? Math.min(65535, +o.topPorts) : 1000);
    return o;
  }

  /* ---------------------------------------------------------- nmap: discovery */

  const macVendor = (host) => host.macVendor || 'Unknown';

  /** Decide whether one target is up, the way Nmap would from where it runs. Fills t.up, t.reason, t.rtt, t.mac. */
  function discoverHost(run, t) {
    const o = run.o; const machine = run.ctx.machine;
    const rt = K.net.route(machine, t.ip);
    const host = rt.host;
    t.ttl = host && !rt.self ? (host.os.ttl || 64) - rt.hops.length : 64;
    if (rt.self) {
      // A privileged Nmap recognises its own address and does not ping it, so a ping scan has no latency to show.
      const measured = !(o.root && o.scans.pingOnly);
      Object.assign(t, { method: 'self', up: true, reason: 'localhost-response', rtt: measured ? K.net.jitter(0.04, 0.03) : null });
    } else if (o.root && rt.direct) {
      // On the local Ethernet segment a privileged Nmap asks with ARP, which no host firewall can refuse.
      Object.assign(t, { method: 'arp', up: rt.ok, reason: rt.ok ? 'arp-response' : 'no-response' });
      run.raw.sent += rt.ok ? 1 : 2; run.raw.sentBytes += rt.ok ? 28 : 56;
      if (rt.ok) {
        Object.assign(t, { rtt: K.net.jitter(host.latency.base, host.latency.jitter), mac: host.mac.toUpperCase(), vendor: macVendor(host) });
        run.raw.rcvd++; run.raw.rcvdBytes += 28;
      }
    } else if (o.skipPing) {
      Object.assign(t, { method: 'none', up: true, reason: 'user-set' });
    } else if (o.root) {
      rawPing(run, t);
    } else {
      // Without raw sockets all Nmap can do is try to connect to the web ports.
      const hit = [80, 443].map((port) => K.net.tcp(machine, t.ip, port)).find((r) => r.state !== 'filtered');
      Object.assign(t, { method: 'connect', up: !!hit, reason: !hit ? 'no-response' : hit.state === 'open' ? 'syn-ack' : 'conn-refused', rtt: hit && hit.rtt });
    }
  }

  /** Privileged discovery beyond the local segment: ICMP echo, SYN to 443, ACK to 80. */
  function rawPing(run, t) {
    const machine = run.ctx.machine;
    const echo = K.net.ping(machine, t.ip, 0, { id: run.ctx.pid & 0xffff });
    const syn = K.net.tcp(machine, t.ip, 443);
    const ack = K.net.tcp(machine, t.ip, 80);
    run.raw.sent += 4; run.raw.sentBytes += 152;
    let reason = 'no-response'; let rtt;
    if (echo.status === 'reply') { reason = 'echo-reply'; rtt = echo.rtt; }
    else if (syn.state !== 'filtered') { reason = syn.state === 'open' ? 'syn-ack' : 'reset'; rtt = syn.rtt; }
    else if (ack.state !== 'filtered') { reason = 'reset'; rtt = ack.rtt; }
    const up = reason !== 'no-response';
    if (up) { run.raw.rcvd++; run.raw.rcvdBytes += 40; }
    Object.assign(t, { method: 'raw', up, reason, rtt, showTtl: up });
  }

  const PING_NAMES = { arp: 'ARP Ping Scan', raw: 'Ping Scan', connect: 'Ping Scan' };
  const PING_PROBES = { arp: 1, raw: 4, connect: 2 };

  /** Simulated duration of one discovery round: answers arrive together, silence is retried once. */
  function discoveryCost(o, hosts, method) {
    if (o.timing <= 2) return hosts.length * PING_PROBES[method] * SERIAL_DELAY[o.timing];
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
      const per = PING_PROBES[method] === 1 ? 'port' : 'ports';
      const what = hosts.length === 1 ? hosts[0].ip + ' [' + PING_PROBES[method] + ' ' + per + ']' : hosts.length + ' hosts [' + PING_PROBES[method] + ' ' + per + '/host]';
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

  const SCAN_NAMES = { syn: 'SYN Stealth Scan', connect: 'Connect Scan' };
  const CHUNK = 2048; // ports probed between two chances to press Ctrl-C

  function probePort(run, t, kind, port) {
    const r = K.net.tcp(run.ctx.machine, t.ip, port);
    const raw = kind === 'syn';
    if (raw) {
      const silent = r.state === 'filtered';
      run.raw.sent += silent ? 2 : 1; run.raw.sentBytes += silent ? 88 : 44;
      if (!silent) { run.raw.rcvd++; run.raw.rcvdBytes += r.state === 'open' ? 44 : 40; }
    }
    if (t.rtt == null && r.state !== 'filtered') t.rtt = r.rtt;
    return {
      state: r.state, service: r.state === 'open' ? r.service : null,
      reason: r.state === 'closed' && !raw ? 'conn-refused' : r.reason,
      ttl: raw && r.state !== 'filtered' ? t.ttl : 0,
    };
  }

  /** Simulated duration of probing some ports: answers come back at LAN speed, silence costs retransmissions. */
  function portScanCost(o, answered, silent, total) {
    if (o.timing <= 2) return (answered + silent * 2) * SERIAL_DELAY[o.timing];
    const quick = total <= 1000 ? 0.55 : (550 + 0.28 * (total - 1000)) / total;
    const slow = total <= 1000 ? 4.2 : (4200 + 2 * (total - 1000)) / total;
    return (answered * quick + silent * slow) * SPEED[o.timing];
  }

  async function scanHostPorts(run, t, kind, ports, share) {
    const scan = { proto: 'tcp', total: ports.length, states: {}, services: new Map() };
    t.scans.push(scan);
    for (let i = 0; i < ports.length; i += CHUNK) {
      let silent = 0; const end = Math.min(ports.length, i + CHUNK);
      for (let j = i; j < end; j++) {
        const r = probePort(run, t, kind, ports[j]);
        const group = scan.states[r.state] || (scan.states[r.state] = { state: r.state, reason: r.reason, ttl: r.ttl, ports: [] });
        group.ports.push(ports[j]);
        if (r.state === 'filtered') silent++;
        if (r.state === 'open') {
          scan.services.set(ports[j], r.service);
          run.verbose('Discovered open port ' + ports[j] + '/' + scan.proto + ' on ' + t.ip);
        }
      }
      await run.wait(portScanCost(run.o, end - i - silent, silent, ports.length) * share);
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
        else for (const port of g.ports) shown.push({ port, proto: scan.proto, state: g.state, reason: g.reason, ttl: g.ttl, service: scan.services.get(port) });
      }
      rows.push.apply(rows, shown.sort((a, b) => a.port - b.port));
    }
    hidden.sort((a, b) => b.count - a.count);
    return { rows, hidden, total };
  }

  function portTable(o, rows) {
    const cells = rows.map((r) => {
      const line = [r.port + '/' + r.proto, r.state, serviceName(r.proto, r.port)];
      if (o.reason) line.push(r.reason + (r.ttl ? ' ttl ' + r.ttl : ''));
      return line;
    });
    return alignRows([['PORT', 'STATE', 'SERVICE'].concat(o.reason ? ['REASON'] : [])].concat(cells));
  }

  /** The lines of one host's report, or [] when --open leaves nothing to say about it. */
  function hostReport(run, t) {
    const o = run.o; const label = hostLabel(o, t);
    if (!t.up) return o.verbose ? ['Nmap scan report for ' + label + ' [host down' + (o.reason ? ', received ' + t.reason : '') + ']'] : [];
    const lines = ['Nmap scan report for ' + label, hostUpLine(o, t)];
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
    if (t.scans.length) lines.push('');
    return lines;
  }

  /* --------------------------------------------------------------- nmap: main */

  function nmapTargets(run) {
    const ctx = run.ctx; const o = run.o; const specs = [];
    let words = o.targets;
    if (o.inputFile != null) {
      let text;
      if (o.inputFile === '-') text = ctx.stdin || '';
      else {
        try { text = ctx.fs.read(o.inputFile); } catch (e) {
          throw quit('Failed to open input file ' + o.inputFile + ' for reading: ' + e.message + ' (2)');
        }
      }
      words = text.replace(/#.*/g, '').split(/\s+/).filter(Boolean).concat(words);
    }
    for (const word of words) {
      const spec = parseTarget(ctx.machine, word);
      if (spec) specs.push(spec);
      else ctx.err('Failed to resolve "' + word.replace(/\/\d+$/, '') + '".\n');
    }
    const excluded = String(o.exclude || '').split(',').filter(Boolean).map((word) => parseTarget(ctx.machine, word)).filter(Boolean);
    const skip = (ip) => { const n = U.ipToInt(ip); return excluded.some((spec) => specHas(spec, n)); };
    return (function* () {
      for (const spec of specs) {
        for (const ip of guardedAddresses(ctx, spec, 'nmap', skip)) yield { ip, given: spec.name && spec.ip === ip ? spec.name : null, scans: [] };
      }
    })();
  }

  async function scanGroup(run, group) {
    const o = run.o;
    await discover(run, group);
    const up = group.filter((t) => t.up);
    await resolveNames(run, up);
    if (o.tcp && up.length) await portScan(run, up, o.tcp, o.tcpPorts);
    for (const t of group) for (const line of hostReport(run, t)) run.report(line);
    run.total += group.length; run.up += up.length;
  }

  const GROUP_SIZE = 256;

  async function nmapScan(run) {
    const o = run.o; const targets = nmapTargets(run);
    run.say('Starting Nmap ' + NMAP_VERSION + ' ( https://nmap.org ) at ' + ymd(run.started) + ' ' + hhmm(run.started) + ' UTC');
    for (const w of o.warnings || []) run.ctx.err(w + '\n');
    await run.wait(K.net.jitter(25, 20));
    let group = [];
    for (const t of targets) {
      group.push(t);
      if (group.length === GROUP_SIZE) { await scanGroup(run, group); group = []; }
    }
    if (group.length) await scanGroup(run, group);
    if (!run.total) run.ctx.err('WARNING: No targets were specified, so 0 hosts scanned.\n');
    if (run.total === 1 && !run.up && !o.skipPing) run.report('Note: Host seems down. If it is really up, but blocking our ping probes, try -Pn');
    if (o.verbose) run.say('Read data files from: /usr/share/nmap');
    run.say('Nmap done: ' + plural(run.total, 'IP address', 'IP addresses') + ' (' + plural(run.up, 'host up', 'hosts up') + ') scanned in ' + (run.elapsed / 1000).toFixed(2) + ' seconds');
    if (o.verbose && o.root) {
      const kb = (bytes) => (bytes / 1000).toFixed(3) + 'KB';
      run.say('           Raw packets sent: ' + run.raw.sent + ' (' + kb(run.raw.sentBytes) + ') | Rcvd: ' + run.raw.rcvd + ' (' + kb(run.raw.rcvdBytes) + ')');
    }
  }

  function newRun(ctx, o) {
    const run = {
      ctx, o, started: K.clock.now(), elapsed: 0, total: 0, up: 0,
      raw: { sent: 0, sentBytes: 0, rcvd: 0, rcvdBytes: 0 },
      now: () => run.started + run.elapsed,
      // Simulated time is counted here rather than read from the clock so the summary is right at any time scale.
      wait(ms) { run.elapsed += ms; return ctx.sleep(ms); },
      say(line) { ctx.out(line + '\n'); },
      report(line) { ctx.out(line + '\n'); },
      verbose(line) { if (o.verbose) ctx.out(line + '\n'); },
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
    '  -sn: Ping Scan - disable port scan',
    '  -Pn: Treat all hosts as online -- skip host discovery',
    '  -n/-R: Never do DNS resolution/Always resolve [default: sometimes]',
    'SCAN TECHNIQUES:',
    '  -sS/sT: TCP SYN/Connect() scans',
    'PORT SPECIFICATION AND SCAN ORDER:',
    '  -p <port ranges>: Only scan specified ports',
    '    Ex: -p22; -p1-65535; -p U:53,111,137,T:21-25,80,139,8080,S:9',
    '  -F: Fast mode - Scan fewer ports than the default scan',
    '  -r: Scan ports sequentially - don\'t randomize',
    '  --top-ports <number>: Scan <number> most common ports',
    'TIMING AND PERFORMANCE:',
    '  -T<0-5>: Set timing template (higher is faster)',
    'OUTPUT:',
    '  -v: Increase verbosity level (use -vv or more for greater effect)',
    '  --reason: Display the reason a port is in a particular state',
    '  --open: Only show open (or possibly open) ports',
    'MISC:',
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
    let run;
    try {
      if (!ctx.args.length) { ctx.out(NMAP_USAGE); return 255; }
      const o = nmapOptions(ctx.args);
      if (o.help) { ctx.out(NMAP_USAGE); return 0; }
      if (o.version) { ctx.out(NMAP_VERSION_TEXT); return 0; }
      run = newRun(ctx, nmapPlan(ctx, o));
      await nmapScan(run);
      return 0;
    } catch (e) {
      if (e instanceof Fatal) { ctx.err(e.text); return e.code; }
      if (e instanceof K.Interrupt) { ctx.err('caught SIGINT signal, cleaning up\n'); return 130; }
      throw e;
    }
  }

  /** Completion shared by the tools of this pack: lab host names and the networks in scope. */
  function labTargets() {
    const world = K.net.world;
    return world.hosts.filter((h) => h.fqdn).map((h) => h.fqdn).concat(world.engagement.scope).sort();
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
      'OPTIONS\n' +
      '       -sn    Ping scan: discover hosts, do not scan ports.\n' +
      '       -Pn    Skip host discovery and treat every target as up.\n' +
      '       -sS    TCP SYN scan (default for root). Requires root privileges.\n' +
      '       -sT    TCP connect scan (default without root).\n' +
      '       -p RANGES\n              Scan only these ports: -p22, -p1-1024, -p22,80,443, -p- for all 65535.\n' +
      '       -F     Fast: scan the 100 most common ports.\n' +
      '       --top-ports N\n              Scan the N most common ports.\n' +
      '       --open Show only open ports.\n' +
      '       --reason\n              Show why each port is in its state (syn-ack, reset, conn-refused, no-response).\n' +
      '       -n, -R Never, or always, look up reverse DNS names.\n' +
      '       -T0 ... -T5\n              Timing template, from paranoid (very slow) to insane. -T3 is the default.\n' +
      '       -v     More detail while the scan runs. May be given twice.\n' +
      '       -h, -V Print the option summary, or the version.\n\n' +
      'EXAMPLES\n' +
      '       nmap -sn 10.10.10.0/24\n              Which hosts of the lab network are up?\n' +
      '       sudo nmap -p 22,80,443 --reason web01.halcyon.lab\n              Check three ports on one host and show the evidence for each state.',
    run: nmapRun,
    complete: (info) => (info.cur[0] === '-' ? [] : labTargets()),
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
