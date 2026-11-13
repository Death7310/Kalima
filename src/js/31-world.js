/* Kalima — the simulated world: a fictional training lab plus a small
 * simulated internet. Everything here is invented. Addresses outside the lab
 * use documentation ranges where a specific address matters.
 *
 * K.makeWorld() returns a fresh world object (boot calls it once).
 * Content packs may extend it with K.worldExtensions.push((world) => {...}).
 */
;(function (root) {
  'use strict';
  const K = root.K;

  K.worldExtensions = [];

  K.makeWorld = function () {
    const linux = (details) => ({ family: 'Linux', vendor: 'Linux', gen: '6.X', type: 'general purpose', details: details || 'Linux 6.1 - 6.12', cpe: 'cpe:/o:linux:linux_kernel:6', ttl: 64 });
    const ssh = (ver) => ({ port: 22, proto: 'tcp', name: 'ssh', product: 'OpenSSH', version: ver || '10.0p2 Debian 7', extra: 'protocol 2.0', banner: 'SSH-2.0-OpenSSH_' + (ver || '10.0p2 Debian 7').replace(/ (Debian|Ubuntu) /, ' $1-'), handler: 'ssh' });
    const labUser = { name: 'student', uid: 1001, gid: 1001, gecos: 'Lab Student,,,', home: '/home/student', shell: '/bin/bash', password: 'student', groups: ['adm'] };

    const world = {
      engagement: {
        id: 'HF-LAB-2026-11',
        name: 'Halcyon Freight internal network assessment (training lab)',
        client: 'Halcyon Freight Ltd. (fictional)',
        scope: ['10.10.10.0/24'],
        domains: ['halcyon.lab'],
        exclude: [],
        window: 'Any time. This is a self-contained simulation.',
        contact: 'IT Operations, it-ops@halcyon.lab',
      },
      nets: [
        { id: 'lab', cidr: '10.10.10.0/24', name: 'Halcyon Freight lab LAN', gateway: '10.10.10.1' },
      ],
      hosts: [
        {
          id: 'kali', hostname: 'kali', ip: '10.10.10.5', dynamic: true, oui: '08:00:27', macVendor: 'Oracle VirtualBox virtual NIC',
          os: linux('Linux 7.1'), kind: 'workstation', latency: { base: 0.04, jitter: 0.02 },
        },
        {
          id: 'gw', hostname: 'gw', fqdn: 'gw.halcyon.lab', ip: '10.10.10.1', oui: '00:1b:21', macVendor: 'Intel Corporate',
          kind: 'router', os: linux('Linux 5.15 - 6.8 (OpenWrt)'), latency: { base: 0.38, jitter: 0.25 },
          services: [
            { port: 53, proto: 'tcp', name: 'domain', product: 'dnsmasq', version: '2.90', state: 'filtered' },
            { port: 80, proto: 'tcp', name: 'http', product: 'uhttpd', handler: 'http' },
            { port: 443, proto: 'tcp', name: 'https', product: 'uhttpd', handler: 'http', tls: true },
          ],
          firewall: { default: 'filtered', filtered: [22] },
          web: { server: 'uhttpd', routes: { '/': { status: 200, body: '<!DOCTYPE html>\n<html><head><title>gw - LuCI</title></head>\n<body><h1>Halcyon Freight Gateway</h1><p>Authorization Required</p>\n<form method="post" action="/cgi-bin/luci"><input name="luci_username"><input type="password" name="luci_password"></form>\n</body></html>\n' } } },
        },
        {
          id: 'web01', hostname: 'web01', fqdn: 'web01.halcyon.lab', aliases: ['www.halcyon.lab', 'intranet.halcyon.lab'], ip: '10.10.10.10',
          oui: '00:0c:29', macVendor: 'VMware', kind: 'server', os: linux('Linux 6.1 - 6.12'), latency: { base: 0.52, jitter: 0.3 },
          services: [
            ssh(),
            { port: 80, proto: 'tcp', name: 'http', product: 'nginx', version: '1.26.3', handler: 'http' },
            { port: 443, proto: 'tcp', name: 'https', product: 'nginx', version: '1.26.3', handler: 'http', tls: true, extra: 'ssl' },
          ],
          web: {
            server: 'nginx/1.26.3',
            routes: {
              '/': { status: 200, body: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>Halcyon Freight Intranet</title>\n</head>\n<body>\n  <h1>Halcyon Freight Intranet</h1>\n  <p>Welcome. Use the links below to reach internal services.</p>\n  <ul>\n    <li><a href="/staff/">Staff directory</a></li>\n    <li><a href="/status">Service status</a></li>\n  </ul>\n  <!-- maintained by it-ops@halcyon.lab -->\n</body>\n</html>\n' },
              '/robots.txt': { status: 200, type: 'text/plain', body: 'User-agent: *\nDisallow: /staff/\nDisallow: /backup/\n' },
              '/status': { status: 200, type: 'application/json', body: '{"status":"ok","services":{"web":"up","db":"up","mail":"up"},"build":"2026.11.2"}\n' },
            },
          },
          shell: { users: [labUser], os: { pretty: 'Debian GNU/Linux 13 (trixie)', kernel: '6.12.48+deb13-amd64', kernelBuild: '#1 SMP PREEMPT_DYNAMIC Debian 6.12.48-1 (2026-09-20)' } },
        },
        {
          id: 'files01', hostname: 'files01', fqdn: 'files01.halcyon.lab', ip: '10.10.10.20', oui: '00:0c:29', macVendor: 'VMware',
          kind: 'server', os: linux('Linux 6.1 - 6.12'), latency: { base: 0.61, jitter: 0.3 },
          services: [
            { port: 21, proto: 'tcp', name: 'ftp', product: 'vsftpd', version: '3.0.5', banner: '220 (vsFTPd 3.0.5)', handler: 'ftp' },
            ssh(),
            { port: 111, proto: 'tcp', name: 'rpcbind', version: '2-4', extra: 'RPC #100000' },
            { port: 139, proto: 'tcp', name: 'netbios-ssn', product: 'Samba smbd', version: '4' },
            { port: 445, proto: 'tcp', name: 'netbios-ssn', product: 'Samba smbd', version: '4' },
            { port: 2049, proto: 'tcp', name: 'nfs', version: '3-4', extra: 'RPC #100003' },
            { port: 111, proto: 'udp', name: 'rpcbind' }, { port: 137, proto: 'udp', name: 'netbios-ns', product: 'Samba nmbd' },
          ],
          shell: { users: [labUser] },
        },
        {
          id: 'db01', hostname: 'db01', fqdn: 'db01.halcyon.lab', ip: '10.10.10.30', oui: '00:0c:29', macVendor: 'VMware',
          kind: 'server', os: linux('Linux 6.1 - 6.12'), latency: { base: 0.57, jitter: 0.3 },
          services: [
            ssh(),
            { port: 3306, proto: 'tcp', name: 'mysql', product: 'MariaDB', version: '11.8.3', extra: 'unauthorized', handler: 'generic' },
          ],
          shell: { users: [labUser] },
        },
        {
          id: 'mail01', hostname: 'mail01', fqdn: 'mail01.halcyon.lab', aliases: ['mail.halcyon.lab'], ip: '10.10.10.40', oui: '00:0c:29', macVendor: 'VMware',
          kind: 'server', os: linux('Linux 6.1 - 6.12'), latency: { base: 0.66, jitter: 0.35 },
          services: [
            ssh(),
            { port: 25, proto: 'tcp', name: 'smtp', product: 'Postfix smtpd', banner: '220 mail01.halcyon.lab ESMTP Postfix (Debian/GNU)', handler: 'smtp' },
            { port: 110, proto: 'tcp', name: 'pop3', product: 'Dovecot pop3d', banner: '+OK Dovecot (Debian) ready.', handler: 'pop3' },
            { port: 143, proto: 'tcp', name: 'imap', product: 'Dovecot imapd', banner: '* OK [CAPABILITY IMAP4rev1 SASL-IR LOGIN-REFERRALS ID ENABLE IDLE LITERAL+ STARTTLS AUTH=PLAIN] Dovecot (Debian) ready.', handler: 'generic' },
            { port: 587, proto: 'tcp', name: 'submission', product: 'Postfix smtpd', banner: '220 mail01.halcyon.lab ESMTP Postfix (Debian/GNU)', handler: 'smtp' },
            { port: 993, proto: 'tcp', name: 'imaps', product: 'Dovecot imapd', tls: true, extra: 'ssl' },
          ],
        },
        {
          id: 'dc01', hostname: 'dc01', fqdn: 'dc01.halcyon.lab', ip: '10.10.10.50', oui: '00:15:5d', macVendor: 'Microsoft',
          kind: 'server', latency: { base: 0.71, jitter: 0.4 },
          os: { family: 'Windows', vendor: 'Microsoft', gen: '2022', type: 'general purpose', details: 'Microsoft Windows Server 2022', cpe: 'cpe:/o:microsoft:windows_server_2022', ttl: 128 },
          firewall: { default: 'filtered', icmp: false },
          services: [
            { port: 53, proto: 'tcp', name: 'domain', product: 'Simple DNS Plus' },
            { port: 88, proto: 'tcp', name: 'kerberos-sec', product: 'Microsoft Windows Kerberos' },
            { port: 135, proto: 'tcp', name: 'msrpc', product: 'Microsoft Windows RPC' },
            { port: 139, proto: 'tcp', name: 'netbios-ssn', product: 'Microsoft Windows netbios-ssn' },
            { port: 389, proto: 'tcp', name: 'ldap', product: 'Microsoft Windows Active Directory LDAP', extra: 'Domain: halcyon.lab' },
            { port: 445, proto: 'tcp', name: 'microsoft-ds' },
            { port: 464, proto: 'tcp', name: 'kpasswd5' },
            { port: 593, proto: 'tcp', name: 'ncacn_http', product: 'Microsoft Windows RPC over HTTP', version: '1.0' },
            { port: 636, proto: 'tcp', name: 'tcpwrapped' },
            { port: 3268, proto: 'tcp', name: 'ldap', product: 'Microsoft Windows Active Directory LDAP', extra: 'Domain: halcyon.lab' },
            { port: 3389, proto: 'tcp', name: 'ms-wbt-server', product: 'Microsoft Terminal Services' },
            { port: 5985, proto: 'tcp', name: 'http', product: 'Microsoft HTTPAPI httpd', version: '2.0', extra: 'SSDP/UPnP', handler: 'http' },
            { port: 53, proto: 'udp', name: 'domain' }, { port: 88, proto: 'udp', name: 'kerberos-sec' }, { port: 123, proto: 'udp', name: 'ntp' },
          ],
        },
        {
          id: 'ns1', hostname: 'ns1', fqdn: 'ns1.halcyon.lab', ip: '10.10.10.53', oui: '00:0c:29', macVendor: 'VMware',
          kind: 'server', os: linux('Linux 6.1 - 6.12'), latency: { base: 0.44, jitter: 0.25 },
          services: [
            ssh(),
            { port: 53, proto: 'tcp', name: 'domain', product: 'ISC BIND', version: '9.20.11', extra: 'Debian Linux' },
            { port: 53, proto: 'udp', name: 'domain', product: 'ISC BIND', version: '9.20.11' },
          ],
        },
        {
          id: 'printer', hostname: 'printer', fqdn: 'printer.halcyon.lab', ip: '10.10.10.60', oui: '00:1e:0b', macVendor: 'Hewlett Packard',
          kind: 'printer', latency: { base: 1.9, jitter: 1.2 },
          os: { family: 'embedded', vendor: 'HP', type: 'printer', details: 'HP LaserJet printer (JetDirect)', cpe: 'cpe:/h:hp:laserjet', ttl: 64 },
          services: [
            { port: 80, proto: 'tcp', name: 'http', product: 'HP-ChaiSOE', version: '1.0', extra: 'HP LaserJet http config', handler: 'http' },
            { port: 443, proto: 'tcp', name: 'https', product: 'HP-ChaiSOE', version: '1.0', handler: 'http', tls: true },
            { port: 515, proto: 'tcp', name: 'printer' },
            { port: 631, proto: 'tcp', name: 'ipp', product: 'HP-ChaiSOE', handler: 'http' },
            { port: 9100, proto: 'tcp', name: 'jetdirect' },
            { port: 161, proto: 'udp', name: 'snmp', product: 'SNMPv1 server', extra: 'public' },
          ],
          web: { server: 'HP-ChaiSOE/1.0', routes: { '/': { status: 200, body: '<html><head><title>HP LaserJet M507 &nbsp; printer.halcyon.lab</title></head>\n<body><h1>HP LaserJet Enterprise M507</h1><p>Status: Ready</p><p>Toner: 62%</p></body></html>\n' } } },
        },
        {
          id: 'dev01', hostname: 'dev01', fqdn: 'dev01.halcyon.lab', ip: '10.10.10.70', oui: '00:0c:29', macVendor: 'VMware',
          kind: 'server', os: linux('Linux 6.1 - 6.12'), latency: { base: 0.49, jitter: 0.3 },
          firewall: { default: 'closed', filtered: [5432] },
          services: [
            ssh('9.6p1 Ubuntu 3ubuntu13.14'),
            { port: 3000, proto: 'tcp', name: 'http', product: 'Node.js Express framework', handler: 'http' },
            { port: 8080, proto: 'tcp', name: 'http', product: 'Jetty', version: '12.0.25', handler: 'http' },
            { port: 5432, proto: 'tcp', name: 'postgresql', state: 'filtered' },
          ],
          web: {
            server: 'Jetty(12.0.25)',
            ports: { 3000: 'app', 8080: 'ci' },
            sites: {
              app: { routes: { '/': { status: 200, headers: { 'x-powered-by': 'Express' }, server: false, body: '<!DOCTYPE html>\n<html><head><title>Shipment Tracker (dev)</title></head>\n<body><h1>Shipment Tracker</h1><p>Development build. Not for production use.</p></body></html>\n' },
                '/api/health': { status: 200, type: 'application/json', headers: { 'x-powered-by': 'Express' }, body: '{"ok":true,"env":"development"}\n' } } },
              ci: { routes: { '/': { status: 403, headers: { 'x-jenkins': '2.528.1' }, body: '<html><head><meta http-equiv="refresh" content="1;url=/login?from=%2F"/></head><body style="background-color:white; color:white;">\nAuthentication required\n</body></html>\n' },
                '/login': { status: 200, headers: { 'x-jenkins': '2.528.1' }, body: '<!DOCTYPE html><html><head><title>Sign in [Jenkins]</title></head><body><h1>Welcome to Jenkins!</h1><form method="post" action="j_spring_security_check"><input name="j_username"><input name="j_password" type="password"></form></body></html>\n' } } },
            },
          },
          shell: { users: [labUser], os: { pretty: 'Ubuntu 24.04.3 LTS', kernel: '6.8.0-86-generic', kernelBuild: '#87-Ubuntu SMP PREEMPT_DYNAMIC' } },
        },
        {
          id: 'cam01', hostname: 'cam01', fqdn: 'cam01.halcyon.lab', ip: '10.10.10.80', oui: '00:40:8c', macVendor: 'Axis Communications',
          kind: 'iot', latency: { base: 2.6, jitter: 1.8 }, loss: 0.04,
          os: { family: 'Linux', vendor: 'Linux', gen: '3.X', type: 'webcam', details: 'Linux 3.2 - 4.14 (embedded)', cpe: 'cpe:/o:linux:linux_kernel:3', ttl: 64 },
          services: [
            { port: 23, proto: 'tcp', name: 'telnet', product: 'BusyBox telnetd', banner: '\r\ncam01 login: ', handler: 'generic' },
            { port: 80, proto: 'tcp', name: 'http', product: 'Boa HTTPd', version: '0.94.14rc21', handler: 'http' },
            { port: 554, proto: 'tcp', name: 'rtsp', product: 'Dahua rtspd' },
          ],
          web: { server: 'Boa/0.94.14rc21', routes: { '/': { status: 401, headers: { 'www-authenticate': 'Basic realm="IP Camera"' }, body: '<HTML><HEAD><TITLE>401 Unauthorized</TITLE></HEAD>\n<BODY><H1>401 Unauthorized</H1>\nYour client does not have permission to get URL / from this server.\n</BODY></HTML>\n' } } },
        },
        {
          id: 'backup01', hostname: 'backup01', fqdn: 'backup01.halcyon.lab', ip: '10.10.10.90', oui: '00:0c:29', macVendor: 'VMware',
          kind: 'server', os: linux('Linux 6.1 - 6.12'), latency: { base: 0.58, jitter: 0.3 },
          firewall: { default: 'filtered', icmp: false },
          services: [
            { port: 873, proto: 'tcp', name: 'rsync', extra: 'protocol version 31', banner: '@RSYNCD: 31.0 sha512 sha256 sha1 md5 md4', handler: 'generic' },
          ],
        },
      ],

      dns: {
        lab: '10.10.10.53',
        servers: {
          '10.10.10.53': { name: 'ns1.halcyon.lab', zones: ['halcyon.lab'], recursive: true },
          '10.10.10.50': { name: 'dc01.halcyon.lab', zones: ['halcyon.lab'], recursive: false },
          '8.8.8.8': { name: 'dns.google', recursive: true, public: true },
          '8.8.4.4': { name: 'dns.google', recursive: true, public: true },
          '1.1.1.1': { name: 'one.one.one.one', recursive: true, public: true },
          '1.0.0.1': { name: 'one.one.one.one', recursive: true, public: true },
          '9.9.9.9': { name: 'dns9.quad9.net', recursive: true, public: true },
          '203.0.113.53': { name: 'ns1.halcyonfreight.example', zones: ['halcyonfreight.example'], recursive: false, public: true },
        },
        zones: {
          'halcyon.lab': {
            internal: true, ttl: 3600, axfr: ['10.10.10.0/24'],
            soa: { mname: 'ns1.halcyon.lab', rname: 'hostmaster.halcyon.lab', serial: 2026111201 },
            records: [
              { name: '@', type: 'NS', data: 'ns1.halcyon.lab' },
              { name: '@', type: 'MX', prio: 10, data: 'mail01.halcyon.lab' },
              { name: '@', type: 'TXT', data: '"v=spf1 mx -all"' },
              { name: 'gw', type: 'A', data: '10.10.10.1' },
              { name: 'web01', type: 'A', data: '10.10.10.10' },
              { name: 'www', type: 'CNAME', data: 'web01.halcyon.lab', ptr: false },
              { name: 'intranet', type: 'CNAME', data: 'web01.halcyon.lab', ptr: false },
              { name: 'files01', type: 'A', data: '10.10.10.20' },
              { name: 'db01', type: 'A', data: '10.10.10.30' },
              { name: 'mail01', type: 'A', data: '10.10.10.40' },
              { name: 'mail', type: 'CNAME', data: 'mail01.halcyon.lab', ptr: false },
              { name: 'dc01', type: 'A', data: '10.10.10.50' },
              { name: 'ns1', type: 'A', data: '10.10.10.53' },
              { name: 'printer', type: 'A', data: '10.10.10.60' },
              { name: 'dev01', type: 'A', data: '10.10.10.70' },
              { name: 'cam01', type: 'A', data: '10.10.10.80' },
              { name: 'backup01', type: 'A', data: '10.10.10.90' },
              { name: '_ldap._tcp', type: 'SRV', data: '0 100 389 dc01.halcyon.lab' },
              { name: '_kerberos._tcp', type: 'SRV', data: '0 100 88 dc01.halcyon.lab' },
            ],
          },
          'halcyonfreight.example': {
            ttl: 300,
            soa: { mname: 'ns1.halcyonfreight.example', rname: 'hostmaster.halcyonfreight.example', serial: 2026102801 },
            records: [
              { name: '@', type: 'A', data: '203.0.113.10' },
              { name: '@', type: 'NS', data: 'ns1.halcyonfreight.example' },
              { name: '@', type: 'NS', data: 'ns2.halcyonfreight.example' },
              { name: '@', type: 'MX', prio: 10, data: 'mail.halcyonfreight.example' },
              { name: '@', type: 'TXT', data: '"v=spf1 mx ip4:203.0.113.25 -all"' },
              { name: 'www', type: 'CNAME', data: 'halcyonfreight.example', ptr: false },
              { name: 'mail', type: 'A', data: '203.0.113.25' },
              { name: 'ns1', type: 'A', data: '203.0.113.53' },
              { name: 'ns2', type: 'A', data: '203.0.113.54' },
              { name: 'vpn', type: 'A', data: '203.0.113.44' },
              { name: '_dmarc', type: 'TXT', data: '"v=DMARC1; p=quarantine; rua=mailto:dmarc@halcyonfreight.example"' },
            ],
          },
        },
      },

      internet: {
        sites: [
          { name: 'dns.google', ip: '8.8.8.8', ips: ['8.8.4.4'], latency: { base: 11.4, jitter: 2.2 }, hops: 8, os: { family: 'Linux', ttl: 128 },
            services: [{ port: 53, proto: 'udp', name: 'domain' }, { port: 53, proto: 'tcp', name: 'domain' }, { port: 443, proto: 'tcp', name: 'https', tls: true, handler: 'http' }, { port: 853, proto: 'tcp', name: 'domain-s', tls: true }],
            firewall: { default: 'filtered' } },
          { name: 'one.one.one.one', ip: '1.1.1.1', ips: ['1.0.0.1'], latency: { base: 6.8, jitter: 1.6 }, hops: 6,
            services: [{ port: 53, proto: 'udp', name: 'domain' }, { port: 53, proto: 'tcp', name: 'domain' }, { port: 80, proto: 'tcp', name: 'http', product: 'cloudflare', handler: 'http' }, { port: 443, proto: 'tcp', name: 'https', product: 'cloudflare', tls: true, handler: 'http' }, { port: 853, proto: 'tcp', name: 'domain-s', tls: true }],
            firewall: { default: 'filtered' } },
          { name: 'dns9.quad9.net', aliases: ['dns.quad9.net'], ip: '9.9.9.9', latency: { base: 13.9, jitter: 2.4 }, hops: 9,
            services: [{ port: 53, proto: 'udp', name: 'domain' }, { port: 53, proto: 'tcp', name: 'domain' }, { port: 443, proto: 'tcp', name: 'https', tls: true, handler: 'http' }],
            firewall: { default: 'filtered' } },
          { name: 'example.com', aliases: ['www.example.com', 'example.org', 'www.example.org', 'example.net', 'www.example.net'], ip: '93.184.215.14', latency: { base: 86.2, jitter: 4.5 }, hops: 12,
            firewall: { default: 'filtered' },
            web: { server: 'ECAcc (dcd/7D5A)', routes: { '/': { status: 200, body: '<!doctype html>\n<html>\n<head>\n    <title>Example Domain</title>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n</head>\n<body>\n<div>\n    <h1>Example Domain</h1>\n    <p>This domain is for use in illustrative examples in documents. You may use this\n    domain in literature without prior coordination or asking for permission.</p>\n    <p><a href="https://www.iana.org/domains/example">More information...</a></p>\n</div>\n</body>\n</html>\n' } } } },
          { name: 'kali.org', aliases: ['www.kali.org'], ip: '104.18.4.159', ips: ['104.18.5.159'], latency: { base: 9.6, jitter: 2 }, hops: 7, firewall: { default: 'filtered' },
            web: { server: 'cloudflare', routes: { '/': { status: 200, body: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>Kali Linux | Penetration Testing and Ethical Hacking Linux Distribution</title>\n</head>\n<body>\n  <h1>Kali Linux</h1>\n  <p>Simulated copy served by Kalima. The real site is https://www.kali.org/</p>\n</body>\n</html>\n' } } } },
          { name: 'http.kali.org', aliases: ['kali.download', 'archive.kali.org'], ip: '192.99.200.113', latency: { base: 24.1, jitter: 3 }, hops: 10, firewall: { default: 'filtered' },
            web: { server: 'nginx', routes: { '/': { status: 302, headers: { location: 'https://www.kali.org/' }, body: '' } } } },
          { name: 'halcyonfreight.example', aliases: ['www.halcyonfreight.example'], ip: '203.0.113.10', latency: { base: 41.5, jitter: 3.5 }, hops: 11, firewall: { default: 'filtered' },
            web: { server: 'nginx', routes: {
              '/': { status: 200, body: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>Halcyon Freight | Moving what matters</title>\n  <meta name="generator" content="Hugo 0.148.2">\n</head>\n<body>\n  <header><h1>Halcyon Freight</h1><nav><a href="/about">About</a> <a href="/contact">Contact</a></nav></header>\n  <main><p>Regional freight and logistics since 1987.</p></main>\n  <footer>&copy; 2026 Halcyon Freight Ltd.</footer>\n</body>\n</html>\n' },
              '/about': { status: 200, body: '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>About | Halcyon Freight</title></head>\n<body><h1>About us</h1><p>Halcyon Freight is a fictional company used for training.</p></body></html>\n' },
              '/contact': { status: 200, body: '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>Contact | Halcyon Freight</title></head>\n<body><h1>Contact</h1><p>General enquiries: info@halcyonfreight.example</p><p>Careers: careers@halcyonfreight.example</p></body></html>\n' },
              '/robots.txt': { status: 200, type: 'text/plain', body: 'User-agent: *\nDisallow: /staging/\nSitemap: https://halcyonfreight.example/sitemap.xml\n' },
            } } },
          { name: 'mail.halcyonfreight.example', ip: '203.0.113.25', latency: { base: 42.7, jitter: 3.5 }, hops: 11, firewall: { default: 'filtered' },
            services: [{ port: 25, proto: 'tcp', name: 'smtp', product: 'Postfix smtpd', banner: '220 mail.halcyonfreight.example ESMTP Postfix', handler: 'smtp' }] },
          { name: 'ns1.halcyonfreight.example', ip: '203.0.113.53', ips: ['203.0.113.54'], latency: { base: 40.9, jitter: 3.5 }, hops: 11, firewall: { default: 'filtered' },
            services: [{ port: 53, proto: 'udp', name: 'domain' }, { port: 53, proto: 'tcp', name: 'domain' }] },
        ],
        whois: {
          'halcyonfreight.example': {
            registrar: 'Simulated Registrar, Inc.', created: '2009-03-14T10:22:31Z', updated: '2026-02-11T08:15:02Z', expires: '2027-03-14T10:22:31Z',
            ns: ['NS1.HALCYONFREIGHT.EXAMPLE', 'NS2.HALCYONFREIGHT.EXAMPLE'], org: 'Halcyon Freight Ltd.', country: 'GB', state: 'Greater Manchester',
            abuse: 'abuse@simulated-registrar.example',
          },
        },
      },
    };
    for (const ext of K.worldExtensions) { try { ext(world); } catch (e) { if (K.debug) console.error('world extension failed', e); } }
    return world;
  };

  /* Engagement paperwork in the Kali user's home directory. */
  K.fsSeeds.push(function (m) {
    if (m.profile !== 'kali') return;
    const w = K.net.world; if (!w) return;
    const e = w.engagement; const h = '/home/kali/engagement';
    const fs = m.vfs;
    fs.seed(h + '/scope.txt',
      '# Engagement scope: ' + e.id + '\n# ' + e.name + '\n#\n# IN SCOPE\n' + e.scope.join('\n') + '\n' + e.domains.map((d) => '*.' + d).join('\n') +
      '\n\n# OUT OF SCOPE\n# Everything else, including the public internet and halcyonfreight.example.\n# Passive lookups (DNS, WHOIS) of public records are permitted; active testing is not.\n');
    fs.seed(h + '/rules-of-engagement.txt', [
      'RULES OF ENGAGEMENT', '===================', '',
      'Engagement:  ' + e.id, 'Client:      ' + e.client, 'Tester:      kali (you)', 'Window:      ' + e.window, 'Contact:     ' + e.contact, '',
      '1. Authorization. You hold written permission from the system owner to test the',
      '   addresses listed in scope.txt and nothing else. Permission is what separates a',
      '   security assessment from a crime.',
      '2. Scope. Active testing (scanning, probing beyond normal client use) is limited to',
      '   the in-scope ranges. If a target is not in scope.txt, do not touch it.',
      '3. Do no harm. Prefer the least intrusive technique that answers the question. Do not',
      '   degrade availability, alter data, or access more than is needed to show a finding.',
      '4. Handle data with care. Anything you see belongs to the client. Record only what the',
      '   report needs and keep your notes inside ~/engagement.',
      '5. Record what you do. Keep commands and timestamps so every finding can be reproduced.',
      '6. Stop and report. If you find evidence of a real incident or something outside the',
      '   agreed scope, stop and contact the client.', '',
      'This document is part of a simulation. In real work these terms are a signed contract.', '',
    ].join('\n'));
    fs.seed(h + '/credentials.txt',
      '# Test account supplied by the client for authenticated checks and log review.\n# Valid on: web01, files01, db01, dev01 (SSH)\n\nusername: student\npassword: student\n');
    fs.seed(h + '/notes.md', '# Engagement notes: ' + e.id + '\n\n## Hosts\n\n## Findings\n\n## Commands run\n');
    fs.seedDir(h + '/scans');
    fs.seedOwn(h, 1000, 1000);
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
