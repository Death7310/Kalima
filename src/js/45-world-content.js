/* Kalima — lab content: what the Halcyon Freight lab looks like from the inside.
 *
 *   World data (K.worldExtensions)  fuller web sites for web01, gw, the printer, dev01 and the
 *                                   client's public presence, plus the FTP tree of files01.
 *   Host filesystems (K.fsSeeds)    configuration, documents and log history on the hosts that
 *                                   allow logins; practice data on the Kali box (/usr/share/kalima).
 *   Live logs                       requests and connections made during a session are appended
 *                                   to the target's own logs in the real formats, so a learner
 *                                   can read their activity the way a defender would.
 *
 * Everything here is invented. This pack is scenery: it adds no weaknesses and no secrets.
 */
;(function (root) {
  'use strict';
  const K = root.K;
  const U = K.util;

  const MIN = 60000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const IMAGE_BUILT = Date.UTC(2026, 9, 26, 9, 12, 0); // the date the base filesystem carries
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  /* ------------------------------------------------------------------ helpers */

  /** Text block from a template literal: removes the indentation that comes from sitting at code depth. */
  function doc(s) {
    const lines = s.replace(/^\n/, '').replace(/\n[ \t]*$/, '').split('\n');
    const depth = Math.min.apply(null, lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)[0].length));
    return lines.map((l) => l.slice(depth)).join('\n') + '\n';
  }
  const indent = (text, by) => text.replace(/^(?=.)/gm, by);
  const pick = (rand, list) => list[Math.floor(rand() * list.length)];
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const startOfDay = (ms) => ms - (ms % DAY);
  const noise = (seed, length) => { const r = U.prng(seed); let s = ''; while (s.length < length) s += B64[Math.floor(r() * 64)]; return s; };

  const hms = (ms) => U.isoDate(ms).slice(11);
  /** nginx access log time: 13/Nov/2026:14:30:05 +0000 */
  const clfDate = (ms) => { const d = new Date(ms); return U.pad2(d.getUTCDate()) + '/' + U.MONTHS[d.getUTCMonth()] + '/' + d.getUTCFullYear() + ':' + hms(ms) + ' +0000'; };
  /** nginx error log time: 2026/11/13 14:30:05 */
  const nginxDate = (ms) => U.isoDate(ms).replace(/-/g, '/');
  /** vsftpd log time: Fri Nov 13 14:30:05 2026 */
  const ctimeDate = (ms) => { const d = new Date(ms); return U.DAYS[d.getUTCDay()] + ' ' + U.MONTHS[d.getUTCMonth()] + ' ' + U.padStart(d.getUTCDate(), 2) + ' ' + hms(ms) + ' ' + d.getUTCFullYear(); };
  /** MariaDB error log time: 2026-11-13  6:25:01 (the hour is space padded) */
  const mariaDate = (ms) => U.isoDate(ms).replace(/ 0(\d:)/, '  $1');

  /* ------------------------------------------------------------------- people */

  const STAFF = [
    ['Imogen Farrow', 'Managing Director', 'Executive', 4001],
    ['Tobias Renner', 'Operations Director', 'Operations', 4002],
    ['Priya Nandakumar', 'Finance Manager', 'Finance', 4010],
    ['Fatima El-Amin', 'HR Manager', 'People', 4020],
    ['Desmond Achterberg', 'Head of IT', 'IT Operations', 4100],
    ['Lucia Marchetti', 'Systems Administrator', 'IT Operations', 4101],
    ['Kwame Boateng', 'Network Engineer', 'IT Operations', 4102],
    ['Hana Kobayashi', 'Software Developer', 'IT Development', 4110],
    ['Oskar Lindqvist', 'Software Developer', 'IT Development', 4111],
    ['Gareth Pollard', 'Warehouse Supervisor', 'Warehouse', 4200],
    ['Mei-Ling Zhou', 'Customer Service Lead', 'Customer Service', 4300],
    ['Rosalind Whitcombe', 'Dispatch Coordinator', 'Dispatch', 4310],
  ];
  /** Internal mailbox name: first initial plus surname (ifarrow). */
  const mailbox = (name) => { const p = name.toLowerCase().split(' '); return p[0][0] + p[p.length - 1].replace(/[^a-z]/g, ''); };

  /* ------------------------------------------------------------ nginx sites */

  function nginxErrorPage(status, server) {
    const title = status + ' ' + K.net.STATUS[status];
    return '<html>\r\n<head><title>' + title + '</title></head>\r\n<body>\r\n<center><h1>' + title + '</h1></center>\r\n<hr><center>' + server + '</center>\r\n</body>\r\n</html>\r\n';
  }

  /** A static file the way nginx serves it: validators and conditional GET. */
  function nginxFile(file) {
    const etag = '"' + (file.mtime / 1000).toString(16) + '-' + U.byteLen(file.body).toString(16) + '"';
    const validators = { 'last-modified': new Date(file.mtime).toUTCString(), etag };
    const headers = Object.assign({ 'accept-ranges': 'bytes' }, validators);
    return function (request) {
      const unchanged = request.headers['if-none-match'] === etag || Date.parse(request.headers['if-modified-since']) === file.mtime;
      return unchanged ? { status: 304, headers: validators, body: '' } : { status: 200, type: file.type, headers, body: file.body };
    };
  }

  /**
   * Routes for an nginx document root.
   *   files   { '/path': { type, body, mtime } }; a directory is served through its index.html
   *   o       { server, denied: [location prefixes answered 403], alias: { '/url': '/file' } }
   */
  function nginxSite(files, o) {
    const routes = {};
    for (const p of Object.keys(files)) {
      routes[p] = nginxFile(files[p]);
      if (p.endsWith('/index.html')) routes[p.slice(0, -'index.html'.length)] = routes[p];
    }
    for (const url of Object.keys(o.alias || {})) routes[url] = routes[o.alias[url]];
    const denied = o.denied || [];
    const fallback = function (request) {
      const dir = request.path + '/';
      if (denied.some((d) => request.path.startsWith(d))) return { status: 403, body: nginxErrorPage(403, o.server) };
      if (routes[dir] || denied.indexOf(dir) >= 0) return { status: 301, headers: { location: request.scheme + '://' + request.host + dir }, body: nginxErrorPage(301, o.server) };
      return null; // the engine answers 404 in nginx's own words
    };
    return { routes, fallback };
  }

  /** A 16x16 single-colour .ico. Every byte is below 0x80, so the string is the file byte for byte. */
  function favicon(r, g, b) {
    const le = (n, width) => { let s = ''; for (let i = 0; i < width; i++) s += String.fromCharCode((n >> (8 * i)) & 255); return s; };
    const bitmap = String.fromCharCode(b, g, r).repeat(256) + '\0'.repeat(64); // colour rows, then the transparency mask
    return le(0, 2) + le(1, 2) + le(1, 2) +                                                          // ICONDIR: one image
      le(16, 1) + le(16, 1) + le(0, 2) + le(1, 2) + le(24, 2) + le(40 + bitmap.length, 4) + le(22, 4) + // ICONDIRENTRY
      le(40, 4) + le(16, 4) + le(32, 4) + le(1, 2) + le(24, 2) + le(0, 4) + le(bitmap.length, 4) + le(0, 16) + bitmap;
  }

  /* --------------------------------------------- web01: intranet and staff portal */

  const WEB01 = 'web01.halcyon.lab';
  const PORTAL = 'intranet.halcyon.lab';
  const WEB01_SERVER = 'nginx/1.26.3';
  const SITE_UPDATED = Date.UTC(2026, 10, 2, 9, 41, 17);
  const htmlFile = (body, mtime) => ({ type: 'text/html; charset=utf-8', body, mtime: mtime || SITE_UPDATED });
  const INTRANET_NAV = [['/', 'Home'], ['/staff/', 'Staff directory'], ['/docs/', 'Policies'], ['/status', 'Service status']];
  const PORTAL_NAV = [['/', 'Portal home'], ['/news/', 'News'], ['/helpdesk/', 'IT helpdesk'], ['/staff/', 'Staff directory'], ['/docs/', 'Policies']];

  function intranetPage(o, main) {
    return doc(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <title>${o.title}</title>
        <link rel="stylesheet" href="/css/site.css">
        <link rel="icon" href="/favicon.ico">
      </head>
      <body>
        <header>
          <h1>${o.heading || 'Halcyon Freight Intranet'}</h1>
          <nav>${(o.nav || INTRANET_NAV).map((l) => '<a href="' + l[0] + '">' + l[1] + '</a>').join(' ')}</nav>
        </header>
        <main>
      `) + indent(doc(main), '    ') + doc(`
        </main>
        <footer>Halcyon Freight Ltd. Internal use only.</footer>
        <!-- maintained by it-ops@halcyon.lab -->
      </body>
      </html>
      `);
  }

  const STAFF_ROWS = STAFF.map((p) => {
    const mail = mailbox(p[0]) + '@halcyon.lab';
    return '  <tr><td>' + p[0] + '</td><td>' + p[1] + '</td><td>' + p[2] + '</td><td><a href="mailto:' + mail + '">' + mail + '</a></td><td>' + p[3] + '</td></tr>';
  }).join('\n');

  const INTRANET_FILES = {
    '/index.html': htmlFile(intranetPage({ title: 'Halcyon Freight Intranet' }, `
      <p>Welcome. Use the links below to reach internal services.</p>
      <ul>
        <li><a href="/staff/">Staff directory</a></li>
        <li><a href="/docs/">Policies and guidance</a></li>
        <li><a href="/status">Service status</a></li>
        <li><a href="http://intranet.halcyon.lab/">Staff portal</a>: company news and the IT helpdesk</li>
      </ul>
      <h2>Other internal systems</h2>
      <table>
        <tr><th>System</th><th>Where</th><th>Looked after by</th></tr>
        <tr><td>Email</td><td>mail.halcyon.lab</td><td>IT Operations</td></tr>
        <tr><td>File shares</td><td>files01.halcyon.lab</td><td>IT Operations</td></tr>
        <tr><td>Shipment Tracker (development)</td><td>dev01.halcyon.lab:3000</td><td>IT Development</td></tr>
        <tr><td>Build server</td><td>dev01.halcyon.lab:8080</td><td>IT Development</td></tr>
        <tr><td>Dispatch office printer</td><td>printer.halcyon.lab</td><td>IT Operations</td></tr>
      </table>
      `)),
    '/staff/index.html': htmlFile(intranetPage({ title: 'Staff directory | Halcyon Freight Intranet' }, `
      <h2>Staff directory</h2>
      <p>Head office and Manchester depot. Extensions can be dialled from any desk phone.</p>
      <table>
        <tr><th>Name</th><th>Role</th><th>Department</th><th>Email</th><th>Ext.</th></tr>
      ` + STAFF_ROWS + `
      </table>
      <p>Missing or out of date? Tell <a href="mailto:hr@halcyon.lab">hr@halcyon.lab</a>.</p>
      `), Date.UTC(2026, 10, 9, 16, 4, 52)),
    '/docs/index.html': htmlFile(intranetPage({ title: 'Policies | Halcyon Freight Intranet' }, `
      <h2>Policies and guidance</h2>
      <ul>
        <li><a href="/docs/acceptable-use.html">IT Acceptable Use Policy</a> (version 3.1)</li>
        <li><a href="/docs/remote-working.html">Remote Working Policy</a> (version 2.0)</li>
      </ul>
      <p>Policies are reviewed every September. The owner of each document is named at the top of its page.</p>
      `)),
    '/docs/acceptable-use.html': htmlFile(intranetPage({ title: 'IT Acceptable Use Policy | Halcyon Freight Intranet' }, `
      <h2>IT Acceptable Use Policy</h2>
      <p class="meta">Version 3.1. Approved 14 September 2026. Owner: Desmond Achterberg, Head of IT.</p>
      <p>This policy applies to everyone who uses Halcyon Freight computers, handheld scanners, email or network services.</p>
      <ol>
        <li>Company systems are provided for company business. Limited personal use during breaks is fine provided it does not get in the way of work.</li>
        <li>Your account is yours alone. Never share a password, and lock your screen when you leave your desk.</li>
        <li>Install only software that IT Operations has approved.</li>
        <li>Customer and shipment data stays on company systems. Do not copy it to personal devices or personal cloud storage.</li>
        <li>Report lost equipment, suspicious email or anything unusual to the IT helpdesk straight away.</li>
        <li>Systems are monitored and logged to keep the network secure. Security testing takes place only with written authorisation from the Head of IT.</li>
      </ol>
      <p>Questions about this policy: <a href="mailto:it-ops@halcyon.lab">it-ops@halcyon.lab</a>.</p>
      `), Date.UTC(2026, 8, 14, 11, 20, 3)),
    '/docs/remote-working.html': htmlFile(intranetPage({ title: 'Remote Working Policy | Halcyon Freight Intranet' }, `
      <h2>Remote Working Policy</h2>
      <p class="meta">Version 2.0. Approved 14 September 2026. Owner: Fatima El-Amin, HR Manager.</p>
      <p>Office staff may work from home for up to two days a week by agreement with their manager.</p>
      <ol>
        <li>Use only a company laptop. Connect through the company VPN before opening email or file shares.</li>
        <li>Work somewhere private. Do not leave equipment or printed paperwork unattended.</li>
        <li>Keep your normal working hours and stay reachable on your desk extension, which forwards to your laptop.</li>
        <li>Depot, warehouse and dispatch roles are site based and are not covered by this policy.</li>
      </ol>
      <p>Requests go to your line manager first, then to <a href="mailto:hr@halcyon.lab">hr@halcyon.lab</a>.</p>
      `), Date.UTC(2026, 8, 14, 11, 24, 40)),
    '/css/site.css': { type: 'text/css', mtime: Date.UTC(2026, 8, 14, 10, 2, 11), body: doc(`
      /* Halcyon Freight intranet */
      body { margin: 0; font: 16px/1.5 "Segoe UI", Arial, sans-serif; color: #1c2733; background: #f4f6f8; }
      header { background: #1e3c5a; color: #fff; padding: 12px 24px; }
      header h1 { margin: 0; font-size: 22px; }
      nav a { color: #cfe0f1; margin-right: 16px; text-decoration: none; }
      nav a:hover { text-decoration: underline; }
      main { max-width: 960px; margin: 24px auto; padding: 0 24px; }
      table { border-collapse: collapse; width: 100%; background: #fff; }
      th, td { border: 1px solid #d5dce3; padding: 6px 10px; text-align: left; }
      th { background: #e8eef4; }
      .meta { color: #5b6876; font-size: 14px; }
      footer { max-width: 960px; margin: 32px auto; padding: 0 24px; color: #5b6876; font-size: 13px; }
      `) },
    '/favicon.ico': { type: 'image/x-icon', mtime: Date.UTC(2026, 8, 14, 10, 2, 11), body: favicon(0x1e, 0x3c, 0x5a) },
    '/robots.txt': { type: 'text/plain; charset=utf-8', mtime: Date.UTC(2026, 8, 14, 10, 5, 37), body: 'User-agent: *\nDisallow: /staff/\nDisallow: /backup/\n' },
    '/status.json': { type: 'application/json', mtime: Date.UTC(2026, 10, 9, 6, 30, 2), body: '{"status":"ok","services":{"web":"up","db":"up","mail":"up"},"build":"2026.11.2"}\n' },
    '/sitemap.xml': { type: 'text/xml; charset=utf-8', mtime: SITE_UPDATED, body: doc(`
      <?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>http://www.halcyon.lab/</loc><lastmod>2026-11-02</lastmod></url>
        <url><loc>http://www.halcyon.lab/docs/</loc><lastmod>2026-11-02</lastmod></url>
        <url><loc>http://www.halcyon.lab/docs/acceptable-use.html</loc><lastmod>2026-09-14</lastmod></url>
        <url><loc>http://www.halcyon.lab/docs/remote-working.html</loc><lastmod>2026-09-14</lastmod></url>
      </urlset>
      `) },
  };

  const portalPage = (title, main) => intranetPage({ title: title + ' | Halcyon Freight Intranet', heading: 'Halcyon Freight Staff Portal', nav: PORTAL_NAV }, main);
  const PORTAL_FILES = {
    '/index.html': htmlFile(portalPage('Staff Portal', `
      <p>Company news, the IT helpdesk and everything on the main intranet in one place.</p>
      <h2>Latest announcements</h2>
      <ul>
        <li><strong>9 November</strong>: Planned maintenance on the file server, Saturday 14 November from 22:00. <a href="/news/">Details</a></li>
        <li><strong>4 November</strong>: New handheld scanners arrive at the Manchester depot this month.</li>
        <li><strong>28 October</strong>: Fire drill at head office on Thursday 5 November at 10:30.</li>
      </ul>
      <h2>Quick links</h2>
      <ul>
        <li><a href="/staff/">Staff directory</a></li>
        <li><a href="/docs/">Policies and guidance</a></li>
        <li><a href="/helpdesk/">IT helpdesk</a></li>
        <li><a href="/status">Service status</a></li>
      </ul>
      `), Date.UTC(2026, 10, 9, 8, 15, 44)),
    '/news/index.html': htmlFile(portalPage('News', `
      <h2>News</h2>
      <h3>File server maintenance on Saturday 14 November</h3>
      <p class="meta">Posted 9 November 2026 by Lucia Marchetti, IT Operations</p>
      <p>files01 will be unavailable from 22:00 to midnight while storage is expanded. Shared drives and the public FTP area are affected. Save your work and close open documents before you leave on Friday.</p>
      <h3>New handheld scanners for the Manchester depot</h3>
      <p class="meta">Posted 4 November 2026 by Gareth Pollard, Warehouse</p>
      <p>Forty new scanners replace the oldest units on the loading bays. Training runs in the canteen every morning at 07:30 during the week of 16 November.</p>
      <h3>Fire drill at head office</h3>
      <p class="meta">Posted 28 October 2026 by Fatima El-Amin, People</p>
      <p>A planned drill takes place on Thursday 5 November at 10:30. Leave by the nearest exit and gather at assembly point B in the visitor car park.</p>
      `), Date.UTC(2026, 10, 9, 8, 14, 9)),
    '/helpdesk/index.html': htmlFile(portalPage('IT helpdesk', `
      <h2>IT helpdesk</h2>
      <p>IT Operations looks after accounts, laptops, phones, printers and the network.</p>
      <table>
        <tr><th>How</th><th>Details</th></tr>
        <tr><td>Email</td><td><a href="mailto:it-ops@halcyon.lab">it-ops@halcyon.lab</a></td></tr>
        <tr><td>Phone</td><td>Extension 4100, Monday to Friday, 07:30 to 17:30</td></tr>
        <tr><td>In person</td><td>Head office, first floor, room 1.04</td></tr>
      </table>
      <h3>Before you get in touch</h3>
      <ul>
        <li>Forgotten password: IT will confirm who you are with your line manager before resetting it. Nobody from IT will ever ask you for your current password.</li>
        <li>Printer problems: note the message on the printer display and which printer it is.</li>
        <li>Suspicious email: forward it as an attachment and do not click anything in it.</li>
      </ul>
      `), Date.UTC(2026, 9, 21, 13, 37, 26)),
  };

  /** URL path -> file for the portal host name: its own pages first, then everything on the default site. */
  function portalFile(path) {
    const p = path === '/status' ? '/status.json' : path.endsWith('/') ? path + 'index.html' : path;
    return PORTAL_FILES[p] || INTRANET_FILES[p] || null;
  }

  /* -------------------------------------------------- public site (out of scope) */

  const PUBLIC_UPDATED = Date.UTC(2026, 9, 28, 7, 52, 30);
  function publicPage(title, main) {
    return doc(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <title>${title}</title>
        <meta name="generator" content="Hugo 0.148.2">
        <link rel="stylesheet" href="/css/main.css">
      </head>
      <body>
        <header><h1>Halcyon Freight</h1><nav><a href="/about">About</a> <a href="/news">News</a> <a href="/careers">Careers</a> <a href="/contact">Contact</a></nav></header>
        <main>
      `) + indent(doc(main), '    ') + doc(`
        </main>
        <footer>&copy; 2026 Halcyon Freight Ltd.</footer>
      </body>
      </html>
      `);
  }
  const publicHtml = (title, main) => htmlFile(publicPage(title, main), PUBLIC_UPDATED);
  const pressRelease = (title, date, main) => publicHtml(title + ' | Halcyon Freight', `
      <article>
        <h2>${title}</h2>
        <p class="date">${date}</p>
      ` + main + `
        <p>Press contact: <a href="mailto:press@halcyonfreight.example">press@halcyonfreight.example</a></p>
      </article>
      `);

  const PUBLIC_FILES = {
    '/index.html': publicHtml('Halcyon Freight | Moving what matters', `
      <p>Regional freight and logistics since 1987.</p>
      <p>From single pallets to full loads, we move goods across the north of England every night from depots in Manchester, Leeds and Hull.</p>
      <ul>
        <li><a href="https://halcyon-tracking.example/">Track a shipment</a></li>
        <li><a href="/contact">Request a quote</a></li>
        <li><a href="/careers">Work with us</a></li>
      </ul>
      `),
    '/about': publicHtml('About | Halcyon Freight', `
      <h2>About us</h2>
      <p>Halcyon Freight is a fictional company used for training.</p>
      <p>The story goes that it started in 1987 with two vans and a rented unit beside the ship canal. Today it runs 60 vehicles and employs around 140 people.</p>
      <h3>Leadership team</h3>
      <ul>
        <li><strong>Imogen Farrow</strong>, Managing Director</li>
        <li><strong>Tobias Renner</strong>, Operations Director</li>
        <li><strong>Priya Nandakumar</strong>, Finance Manager</li>
        <li><strong>Desmond Achterberg</strong>, Head of IT</li>
      </ul>
      <p>Media enquiries: Imogen Farrow, <a href="mailto:imogen.farrow@halcyonfreight.example">imogen.farrow@halcyonfreight.example</a></p>
      `),
    '/contact': publicHtml('Contact | Halcyon Freight', `
      <h2>Contact</h2>
      <p>General enquiries: info@halcyonfreight.example</p>
      <p>Careers: careers@halcyonfreight.example</p>
      <p>Customer service: customer.service@halcyonfreight.example</p>
      <p>Press: press@halcyonfreight.example</p>
      <p>Telephone: 0161 496 0143 (Monday to Friday, 08:00 to 18:00)</p>
      <address>Halcyon Freight Ltd.<br>Unit 4, Wharfside Trade Park<br>Greater Manchester<br>United Kingdom</address>
      `),
    '/careers': publicHtml('Careers | Halcyon Freight', `
      <h2>Careers</h2>
      <p>We are a growing team. Current vacancies:</p>
      <h3>Systems Administrator (Linux)</h3>
      <p>You will join the IT Operations team of three at head office and help look after our Debian servers (nginx, MariaDB, Samba and Postfix), a Windows Server Active Directory domain and the depot networks. Experience with Jenkins and Node.js is welcome but not essential.</p>
      <h3>HGV Class 1 Driver (nights)</h3>
      <p>Trunking between our Manchester, Leeds and Hull depots, four nights on and four off. Digital tachograph card and Driver CPC required.</p>
      <p>To apply, send a CV to <a href="mailto:careers@halcyonfreight.example">careers@halcyonfreight.example</a>. Fatima El-Amin, HR Manager, replies to every application.</p>
      `),
    '/news': publicHtml('News | Halcyon Freight', `
      <h2>News</h2>
      <ul>
        <li><a href="/news/2026/leeds-depot-extension">Leeds depot extension opens</a> (12 October 2026)</li>
        <li><a href="/news/2026/electric-vans">First electric vans join the fleet</a> (3 August 2026)</li>
        <li><a href="/news/2026/apprenticeships">IT and logistics apprenticeships for 2026</a> (18 May 2026)</li>
      </ul>
      `),
    '/news/2026/leeds-depot-extension': pressRelease('Leeds depot extension opens', '12 October 2026', `
        <p>Halcyon Freight has opened a 2,000 square metre extension to its Leeds depot, adding eight loading bays.</p>
        <p>"The extra bays take an hour off our evening turnaround," said Tobias Renner, Operations Director.</p>
      `),
    '/news/2026/electric-vans': pressRelease('First electric vans join the fleet', '3 August 2026', `
        <p>Six electric vans have started work on city-centre collections in Manchester.</p>
        <p>"Customers ask about emissions on almost every tender now," said Imogen Farrow, Managing Director.</p>
      `),
    '/news/2026/apprenticeships': pressRelease('IT and logistics apprenticeships for 2026', '18 May 2026', `
        <p>Four apprentices start in September: two in the warehouse and two with the IT team.</p>
        <p>"Our apprentices work on real systems from the first week," said Desmond Achterberg, Head of IT.</p>
      `),
    '/css/main.css': { type: 'text/css', mtime: Date.UTC(2026, 5, 16, 14, 8, 55), body: doc(`
      body{margin:0;font:17px/1.6 Georgia,serif;color:#222}
      header{background:#1e3c5a;color:#fff;padding:16px 32px}
      header h1{margin:0}
      nav a{color:#cfe0f1;margin-right:18px}
      main{max-width:820px;margin:32px auto;padding:0 24px}
      footer{text-align:center;color:#666;margin:48px 0}
      `) },
    '/robots.txt': { type: 'text/plain', mtime: Date.UTC(2026, 5, 16, 14, 8, 55), body: 'User-agent: *\nDisallow: /staging/\nSitemap: https://halcyonfreight.example/sitemap.xml\n' },
    '/sitemap.xml': { type: 'text/xml', mtime: PUBLIC_UPDATED, body: doc(`
      <?xml version="1.0" encoding="utf-8" standalone="yes"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://halcyonfreight.example/</loc><lastmod>2026-10-28</lastmod></url>
        <url><loc>https://halcyonfreight.example/about</loc><lastmod>2026-06-16</lastmod></url>
        <url><loc>https://halcyonfreight.example/contact</loc><lastmod>2026-06-16</lastmod></url>
        <url><loc>https://halcyonfreight.example/careers</loc><lastmod>2026-10-28</lastmod></url>
        <url><loc>https://halcyonfreight.example/news</loc><lastmod>2026-10-12</lastmod></url>
        <url><loc>https://halcyonfreight.example/news/2026/leeds-depot-extension</loc><lastmod>2026-10-12</lastmod></url>
        <url><loc>https://halcyonfreight.example/news/2026/electric-vans</loc><lastmod>2026-08-03</lastmod></url>
        <url><loc>https://halcyonfreight.example/news/2026/apprenticeships</loc><lastmod>2026-05-18</lastmod></url>
      </urlset>
      `) },
    '/.well-known/security.txt': { type: 'text/plain', mtime: Date.UTC(2026, 5, 16, 14, 8, 55), body: doc(`
      Contact: mailto:security@halcyonfreight.example
      Expires: 2027-06-30T23:59:59Z
      Preferred-Languages: en
      Canonical: https://halcyonfreight.example/.well-known/security.txt
      `) },
  };

  const TRACKING_FILES = {
    '/index.html': htmlFile(doc(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <title>Track a shipment | Halcyon Freight</title>
      </head>
      <body>
        <h1>Track a shipment</h1>
        <p>Customer tracking for Halcyon Freight consignments.</p>
        <p>The tracking service is not part of this simulation. Consignment references look like HF-2026-10421.</p>
        <p><a href="https://halcyonfreight.example/">Back to halcyonfreight.example</a></p>
      </body>
      </html>
      `), Date.UTC(2026, 2, 3, 10, 11, 12)),
    '/robots.txt': { type: 'text/plain', mtime: Date.UTC(2026, 2, 3, 10, 11, 12), body: 'User-agent: *\nDisallow: /\n' },
  };

  /* ---------------------------------------------------------------- gw (LuCI) */

  const LUCI_HEADERS = { 'cache-control': 'no-cache', expires: '0', 'x-frame-options': 'SAMEORIGIN', 'x-xss-protection': '1; mode=block', 'x-content-type-options': 'nosniff' };
  const LUCI_CSS = { type: 'text/css', mtime: Date.UTC(2026, 8, 20, 21, 3, 44), body: doc(`
      body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 13px; margin: 0; background: #fff; color: #404040; }
      header { background: #222; color: #fff; padding: 10px 20px; }
      header .brand { color: #fff; font-size: 20px; text-decoration: none; }
      .container { width: 940px; margin: 20px auto; }
      .alert-message { background: #fcf8e3; border: 1px solid #fbeed5; padding: 8px 14px; }
      .cbi-button-positive { background: #0069d6; color: #fff; border: 0; padding: 5px 14px; }
      footer { text-align: center; color: #bfbfbf; margin: 20px; }
      `) };
  function luciLogin(request) {
    const failed = request.method === 'POST' ? '\t\t\t<div class="alert-message warning"><p>Invalid username and/or password! Please try again.</p></div>\n' : '';
    return { status: 403, headers: LUCI_HEADERS, body:
      '<!DOCTYPE html>\n<html lang="en">\n\t<head>\n\t\t<meta charset="utf-8">\n\t\t<title>gw - LuCI</title>\n\t\t<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '\t\t<link rel="stylesheet" href="/luci-static/bootstrap/cascade.css">\n\t</head>\n\t<body class="lang_en">\n\t\t<header><a class="brand" href="/">gw</a></header>\n\t\t<div id="maincontent" class="container">\n' + failed +
      '\t\t\t<form method="post" class="cbi-map">\n\t\t\t\t<div class="cbi-section">\n\t\t\t\t\t<h2>Authorization Required</h2>\n\t\t\t\t\t<div class="cbi-map-descr">Please enter your username and password.</div>\n' +
      '\t\t\t\t\t<div class="cbi-value"><label class="cbi-value-title" for="luci_username">Username</label><div class="cbi-value-field"><input name="luci_username" id="luci_username" type="text" autocomplete="username"></div></div>\n' +
      '\t\t\t\t\t<div class="cbi-value"><label class="cbi-value-title" for="luci_password">Password</label><div class="cbi-value-field"><input name="luci_password" id="luci_password" type="password" autocomplete="current-password"></div></div>\n' +
      '\t\t\t\t</div>\n\t\t\t\t<div class="cbi-page-actions"><button class="btn cbi-button-positive important">Log in</button></div>\n\t\t\t</form>\n\t\t</div>\n' +
      '\t\t<footer><a href="https://github.com/openwrt/luci">Powered by LuCI openwrt-24.10 branch (25.288.41802~f1c2a9e)</a> / OpenWrt 24.10.3 (r28960-a8c1b2d3e4)</footer>\n\t</body>\n</html>\n' };
  }
  /** uhttpd validators are inode-size-mtime; its own 404 is a bare fragment. */
  function uhttpdFile(file, inode) {
    return { status: 200, type: file.type, body: file.body, headers: {
      'last-modified': new Date(file.mtime).toUTCString(),
      etag: '"' + inode.toString(16) + '-' + U.byteLen(file.body).toString(16) + '-' + (file.mtime / 1000).toString(16) + '"' } };
  }
  function uhttpdFallback(request) {
    if (request.path.startsWith('/cgi-bin/luci/')) return luciLogin(request);
    return { status: 404, type: 'text/html', body: '<h1>Not Found</h1>The requested URL ' + escapeHtml(request.path) + ' was not found on this server.' };
  }

  /* ------------------------------------------------------------------ printer */

  const PRINTER_HEADERS = { 'cache-control': 'no-cache, no-store, must-revalidate', pragma: 'no-cache', 'x-frame-options': 'SAMEORIGIN', 'x-content-type-options': 'nosniff' };
  const printerPage = (heading, rows) => ({ status: 200, headers: PRINTER_HEADERS, body:
    '<html><head><title>HP LaserJet M507 &nbsp; printer.halcyon.lab</title></head>\n<body><h1>HP LaserJet Enterprise M507</h1>\n<h2>' + heading + '</h2>\n<table>\n' +
    rows.map((r) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>\n').join('') + '</table>\n' +
    '<p><a href="/hp/device/DeviceStatus/Index">Device Status</a> | <a href="/hp/device/DeviceInformation/View">Device Information</a> | <a href="/hp/device/InternalPages/Index?id=ConfigurationPage">Configuration Page</a></p>\n</body></html>\n' });
  const PRINTER_ROUTES = {
    '/hp/device/DeviceStatus/Index': printerPage('Device Status', [
      ['Status', 'Ready'], ['Black Cartridge', '62%'], ['Tray 1', 'Empty'], ['Tray 2', 'OK, A4, Plain'], ['Tray 3', 'OK, A4, Plain']]),
    '/hp/device/DeviceInformation/View': printerPage('Device Information', [
      ['Product Name', 'HP LaserJet Enterprise M507'], ['Device Name', 'printer'], ['Model Number', '1PV87A'], ['Serial Number', 'SIM0000507'],
      ['Firmware Datecode', '20260318'], ['Device Location', 'Dispatch office, head office ground floor'], ['Contact Person', 'IT Operations, ext. 4100']]),
    '/hp/device/InternalPages/Index': printerPage('Configuration Page', [
      ['Host Name', 'printer'], ['IPv4 Address', '10.10.10.60'], ['Subnet Mask', '255.255.255.0'], ['Default Gateway', '10.10.10.1'],
      ['Config By', 'Manual'], ['Total Pages Printed', '48213'], ['Installed Memory', '512 MB']]),
    '/DevMgmt/ProductConfigDyn.xml': { status: 200, type: 'text/xml', headers: PRINTER_HEADERS, body: doc(`
      <?xml version="1.0" encoding="UTF-8"?>
      <!-- THIS DATA SUBJECT TO DISCLAIMER(S) INCLUDED WITH THE PRODUCT OF ORIGIN. -->
      <prdcfgdyn2:ProductConfigDyn xmlns:dd="http://www.hp.com/schemas/imaging/con/dictionaries/1.0/" xmlns:prdcfgdyn="http://www.hp.com/schemas/imaging/con/ledm/productconfigdyn/2007/11/05" xmlns:prdcfgdyn2="http://www.hp.com/schemas/imaging/con/ledm/productconfigdyn/2009/03/16">
        <prdcfgdyn:ProductInformation>
          <dd:Version>
            <dd:Revision>2411209_066021</dd:Revision>
            <dd:Date>2026-03-18</dd:Date>
          </dd:Version>
          <dd:MakeAndModel>HP LaserJet Enterprise M507</dd:MakeAndModel>
          <dd:SerialNumber>SIM0000507</dd:SerialNumber>
          <dd:ProductNumber>1PV87A</dd:ProductNumber>
          <dd:DeviceLocation>Dispatch office, head office ground floor</dd:DeviceLocation>
        </prdcfgdyn:ProductInformation>
      </prdcfgdyn2:ProductConfigDyn>
      `) },
  };

  /* --------------------------------------------- dev01: Shipment Tracker and CI */

  const DEPOTS = ['Manchester', 'Leeds', 'Hull'];
  const TOWNS = ['Liverpool', 'Sheffield', 'Bradford', 'Preston', 'York', 'Newcastle', 'Carlisle', 'Stoke-on-Trent', 'Lincoln', 'Chester', 'Doncaster', 'Blackpool'];
  const CUSTOMERS = ['Northgate Ceramics', 'Pennine Print Works', 'Albion Tool Hire', 'Mersey Marine Supplies', 'Calder Valley Foods', 'Ridgeway Garden Centres',
    'Harbour Lane Furniture', 'Tyne Electrical Wholesale', 'Wharfedale Brewing', 'Fellside Outdoor'];
  const SHIPMENT_COLUMNS = ['id', 'date', 'origin', 'destination', 'weight_kg', 'pallets', 'service', 'status', 'customer'];
  /** Sixty fictional consignments over October 2026, shared by the practice CSV, the dev project and its API. */
  const SHIPMENTS = (function () {
    const r = U.prng('halcyon-shipments');
    const rows = [];
    for (let i = 0; i < 60; i++) {
      const day = 1 + Math.floor(i / 2);
      const pallets = 1 + Math.floor(r() * 12);
      const roll = r();
      rows.push({
        id: 'HF-2026-' + (10421 + i), date: '2026-10-' + U.pad2(day), origin: pick(r, DEPOTS), destination: pick(r, TOWNS),
        weight_kg: pallets * (180 + Math.floor(r() * 420)), pallets, service: pick(r, ['next-day', 'next-day', 'economy', 'timed']),
        status: roll < 0.7 ? 'delivered' : roll < 0.82 ? 'in_transit' : roll < 0.92 ? 'delayed' : 'returned', customer: pick(r, CUSTOMERS),
      });
    }
    return rows;
  })();
  const API_SHIPMENTS = SHIPMENTS.slice(0, 8);

  const EXPRESS = { 'x-powered-by': 'Express' };
  /** Express answers JSON with a weak validator: W/"<length in hex>-<digest>" (the digest here is filler). */
  function expressJson(value, status) {
    const body = JSON.stringify(value) + '\n';
    return { status: status || 200, type: 'application/json; charset=utf-8', server: false, body,
      headers: Object.assign({ etag: 'W/"' + U.byteLen(body).toString(16) + '-' + noise('etag:' + body, 27) + '"' }, EXPRESS) };
  }
  function expressFallback(request) {
    const m = /^\/api\/shipments\/([^/]+)$/.exec(request.path);
    if (m) {
      const found = API_SHIPMENTS.find((s) => s.id === m[1]);
      return found ? expressJson(found) : expressJson({ error: 'shipment not found' }, 404);
    }
    return { status: 404, server: false, headers: Object.assign({ 'content-security-policy': "default-src 'none'", 'x-content-type-options': 'nosniff' }, EXPRESS),
      body: '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot ' + request.method + ' ' + escapeHtml(request.path) + '</pre>\n</body>\n</html>\n' };
  }
  const JENKINS = { 'x-content-type-options': 'nosniff', 'x-hudson': '1.395', 'x-jenkins': '2.528.1', 'x-jenkins-session': '6f1c2a9e' };
  /** Jenkins sends every anonymous request to the sign-in page, remembering where it was going. */
  function jenkinsFallback(request) {
    return { status: 403, headers: JENKINS, body: '<html><head><meta http-equiv="refresh" content="1;url=/login?from=' + encodeURIComponent(request.path) +
      '"/></head><body style="background-color:white; color:white;">\nAuthentication required\n</body></html>\n' };
  }

  /* ------------------------------------------------------ files01: public FTP */

  const FTP_FILES = {
    '/pub/README.txt': doc(`
      Halcyon Freight public FTP
      ==========================

      This server holds the documents that customers and hauliers ask for most often.
      Anonymous access is read-only.

        pub/forms/       blank forms (delivery note, vehicle inspection)
        pub/schedules/   depot opening hours and collection routes
        pub/rates/       the current rate card

      Files are refreshed from head office on the first working day of each month.
      Something missing? Email customer.service@halcyonfreight.example
      `),
    '/pub/forms/delivery-note-template.txt': doc(`
      HALCYON FREIGHT LTD.                                   DELIVERY NOTE
      ---------------------------------------------------------------------
      Consignment ref:  HF-____-_____          Date: ____/____/________
      Collected from:   ______________________________________________
      Deliver to:       ______________________________________________
      Pallets: ______   Gross weight (kg): ________   Service: __________

      Goods received in good condition unless noted below.
      Notes: ________________________________________________________

      Received by (print): ______________________  Signature: __________
      `),
    '/pub/forms/vehicle-inspection-checklist.txt': doc(`
      DAILY VEHICLE INSPECTION CHECKLIST
      Complete before the first journey of every shift. Report defects to the depot office.

      [ ] Tyres and wheel fixings        [ ] Lights and indicators
      [ ] Brakes and air lines           [ ] Mirrors and glass
      [ ] Fuel, oil and coolant levels   [ ] Horn, wipers and washers
      [ ] Load security and curtains     [ ] Tachograph and driver card
      [ ] Number plates and markers      [ ] Fire extinguisher and first aid kit

      Vehicle: __________  Odometer: __________  Driver: ____________________
      `),
    '/pub/schedules/depot-opening-hours.txt': doc(`
      DEPOT OPENING HOURS (from 1 October 2026)

      Depot        Mon-Fri        Saturday       Sunday
      Manchester   06:00-22:00    06:00-14:00    closed
      Leeds        06:00-20:00    07:00-12:00    closed
      Hull         07:00-19:00    closed         closed

      Collections booked before 15:00 leave the same evening.
      `),
    '/pub/schedules/collection-routes-2026.csv': doc(`
      route,depot,days,first_collection,last_collection,areas
      M1,Manchester,Mon-Fri,07:30,16:30,"Salford, Trafford, Stretford"
      M2,Manchester,Mon-Fri,08:00,17:00,"Stockport, Tameside, Oldham"
      M3,Manchester,Mon-Sat,07:00,15:30,"Bolton, Bury, Rochdale"
      L1,Leeds,Mon-Fri,07:30,16:30,"Bradford, Shipley, Pudsey"
      L2,Leeds,Mon-Fri,08:00,17:00,"Wakefield, Castleford, Pontefract"
      H1,Hull,Mon-Fri,08:00,16:00,"Beverley, Hessle, Cottingham"
      `),
    '/pub/rates/rate-card-2026.csv': doc(`
      service,pallets_from,pallets_to,price_per_pallet_gbp,delivery
      economy,1,4,46.00,2-3 working days
      economy,5,12,39.50,2-3 working days
      next-day,1,4,58.00,next working day
      next-day,5,12,49.00,next working day
      timed,1,12,74.00,next working day before 10:00
      `),
  };

  /* ---------------------------------------------------------- world extension */

  K.worldExtensions.push(function (world) {
    const host = (id) => world.hosts.find((h) => h.id === id);
    const site = (name) => world.internet.sites.find((s) => s.name === name);

    // web01: the default site, and the staff portal as a second name-based virtual host that
    // serves its own pages and falls back to the default site's files (try_files ... @shared).
    const web01 = host('web01');
    const intranet = nginxSite(INTRANET_FILES, { server: WEB01_SERVER, denied: ['/backup/'], alias: { '/status': '/status.json' } });
    const portal = nginxSite(Object.assign({}, INTRANET_FILES, PORTAL_FILES), { server: WEB01_SERVER, denied: ['/backup/'], alias: { '/status': '/status.json' } });
    Object.assign(web01.web, { routes: intranet.routes, sites: { default: intranet, portal }, vhosts: { [PORTAL]: 'portal' } });

    const gw = host('gw');
    Object.assign(gw.web.routes, { '/cgi-bin/luci': luciLogin, '/luci-static/bootstrap/cascade.css': uhttpdFile(LUCI_CSS, 0x2f1) });
    gw.web.fallback = uhttpdFallback;

    Object.assign(host('printer').web.routes, PRINTER_ROUTES);

    const dev = host('dev01').web.sites;
    dev.app.routes['/api/health'].server = false; // Express sends no Server header
    Object.assign(dev.app.routes, {
      '/api/shipments': expressJson(API_SHIPMENTS),
      '/api/version': expressJson({ name: 'shipment-tracker', version: '0.4.2', node: 'v22.20.0', env: 'development' }),
    });
    dev.app.fallback = expressFallback;
    dev.ci.routes['/robots.txt'] = { status: 200, type: 'text/plain', headers: JENKINS, body: '# we don\'t want robots to click "build" links\nUser-agent: *\nDisallow: /\n' };
    dev.ci.fallback = jenkinsFallback;

    const files01 = host('files01');
    const users = {};
    for (const u of files01.shell.users) users[u.name] = u.password; // vsftpd local_enable: system accounts may log in
    files01.ftp = { anonymous: true, users, files: Object.assign({}, FTP_FILES) };

    Object.assign(site('halcyonfreight.example').web, nginxSite(PUBLIC_FILES, { server: 'nginx', denied: ['/staging/'] }));
    world.internet.sites.push({
      name: 'halcyon-tracking.example', aliases: ['www.halcyon-tracking.example'], ip: '203.0.113.80', latency: { base: 38.4, jitter: 3.5 }, hops: 11,
      firewall: { default: 'filtered' }, web: Object.assign({ server: 'nginx' }, nginxSite(TRACKING_FILES, { server: 'nginx' })),
    });
    world.internet.whois['halcyon-tracking.example'] = {
      registrar: 'Simulated Registrar, Inc.', created: '2021-06-08T13:40:12Z', updated: '2026-05-30T09:02:47Z', expires: '2027-06-08T13:40:12Z',
      ns: ['NS1.HALCYONFREIGHT.EXAMPLE', 'NS2.HALCYONFREIGHT.EXAMPLE'], org: 'Halcyon Freight Ltd.', country: 'GB', state: 'Greater Manchester',
      abuse: 'abuse@simulated-registrar.example',
    };

    worlds.set(world, newLiveState());
    subscribe();
  });

  /* ---------------------------------------------------------------- live logs
   * Requests and connections reach a lab host whether or not anyone has logged in to it yet,
   * but its Machine (and so its filesystem) only exists after the first login. Entries wait in
   * a per-host queue until K.events announces the machine, then go straight into the files.
   */

  const NGINX_WORKER = 812;
  const DOCROOT = '/var/www/html';
  const PROBE_EVERY = 5 * MIN;        // dev01's cron job asks web01 for /status
  const CONNECTIONS_AT_BOOT = 6000;   // nginx numbers connections; history counts back from here
  const QUEUE_LIMIT = 5000;

  const worlds = new WeakMap(); // world -> its live-log state, so a rebuilt world starts clean
  const live = () => (K.net.world ? worlds.get(K.net.world) : undefined);
  function newLiveState() {
    const epoch = K.clock.now();
    let probe = Math.ceil(epoch / PROBE_EVERY) * PROBE_EVERY;
    while (probeTime(probe - PROBE_EVERY) >= epoch) probe -= PROBE_EVERY;
    return { epoch, nextProbe: probe, connections: CONNECTIONS_AT_BOOT, sshPid: 2200, rand: U.prng('world-content'), queued: Object.create(null) };
  }

  let unsubscribe = [];
  /** (Re)attach the handlers; called for every world so a second boot never doubles them up. */
  function subscribe() {
    for (const off of unsubscribe) off();
    unsubscribe = [K.net.bus.on('http', onHttp), K.net.bus.on('conn', onConn), K.events.on('machine-created', onMachine)];
  }

  function writeEntry(machine, entry) {
    if (entry.file) { try { machine.vfs.write(entry.file, entry.text, { append: true }); } catch (e) { /* the log directory is gone */ } }
    else authLog(machine, entry);
  }
  function hostLog(state, host, entry) {
    const machine = K.net.machines[host.id];
    if (machine) return writeEntry(machine, entry);
    const queue = (state.queued[host.id] = state.queued[host.id] || []);
    queue.push(entry);
    if (queue.length > QUEUE_LIMIT) queue.shift();
  }
  function onMachine(machine) {
    const state = live();
    const host = state && K.net.hostById(machine.hostId);
    if (!host || !host.shell) return;
    for (const entry of state.queued[host.id] || []) writeEntry(machine, entry);
    delete state.queued[host.id];
    if (host.id === 'web01') statusProbes(state, host, K.clock.now());
  }

  /** One auth-facility message, through the system pack's K.syslog when it is loaded. */
  function authLog(machine, entry) {
    const line = U.syslogDate(entry.ts) + ' ' + machine.hostname + ' ' + entry.ident + '[' + entry.pid + ']: ' + entry.msg + '\n';
    if (typeof K.syslog === 'function') {
      try { K.syslog(machine, { facility: 'auth', severity: 'info', ident: entry.ident, pid: entry.pid, msg: entry.msg, ts: entry.ts }); } catch (e) { /* fall through to the file */ }
      if (readOr(machine.vfs, AUTH_LOG, '').indexOf(entry.msg) >= 0) return;
    }
    try { machine.vfs.write(AUTH_LOG, line, { append: true }); } catch (e) { /* /var/log is gone */ }
  }

  /* nginx */
  const quoted = (s) => String(s).replace(/[\\"]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).toUpperCase());
  /** Combined log format. ev: { ts, ip, method, uri, status, bytes, referer, ua } */
  function accessLine(ev) {
    return ev.ip + ' - - [' + clfDate(ev.ts) + '] "' + quoted(ev.method + ' ' + ev.uri + ' HTTP/1.1') + '" ' + ev.status + ' ' + ev.bytes +
      ' "' + quoted(ev.referer || '-') + '" "' + quoted(ev.ua || '-') + '"';
  }
  /** What nginx writes to error.log for a refused or missing file (nothing for other statuses). */
  function errorLine(ev) {
    const path = ev.uri.split('?')[0];
    let what;
    if (ev.status === 403) what = 'access forbidden by rule';
    else if (ev.status === 404 && path.endsWith('/')) what = '"' + DOCROOT + path + 'index.html" is not found (2: No such file or directory)';
    else if (ev.status === 404) what = 'open() "' + DOCROOT + path + '" failed (2: No such file or directory)';
    else return null;
    return nginxDate(ev.ts) + ' [error] ' + NGINX_WORKER + '#' + NGINX_WORKER + ': *' + ev.conn + ' ' + what + ', client: ' + ev.ip + ', server: ' + (ev.host === PORTAL ? PORTAL : WEB01) +
      ', request: "' + ev.method + ' ' + ev.uri + ' HTTP/1.1", host: "' + ev.host + '"' + (ev.referer ? ', referrer: "' + ev.referer + '"' : '');
  }
  function webLog(state, host, ev) {
    hostLog(state, host, { file: '/var/log/nginx/access.log', text: accessLine(ev) + '\n' });
    const err = errorLine(ev);
    if (err) hostLog(state, host, { file: '/var/log/nginx/error.log', text: err + '\n' });
  }

  const probeTime = (mark) => mark + 1000 + (U.hash32('probe:' + mark) % 900);
  const probeEvent = (mark, conn) => ({ ts: probeTime(mark), ip: '10.10.10.70', method: 'GET', uri: '/status', status: 200, bytes: U.byteLen(INTRANET_FILES['/status.json'].body), ua: 'curl/8.5.0', host: WEB01, conn });
  /** The monitoring job keeps running while the learner works: log the probes that fell due. */
  function statusProbes(state, host, until) {
    for (; probeTime(state.nextProbe) <= until; state.nextProbe += PROBE_EVERY) webLog(state, host, probeEvent(state.nextProbe, ++state.connections));
  }

  function onHttp(e) {
    const state = live();
    if (!state || !e.host || e.host.id !== 'web01') return;
    const q = e.request; const res = e.response || {};
    statusProbes(state, e.host, e.ts);
    webLog(state, e.host, {
      ts: e.ts, ip: q.client, method: q.method, uri: q.path + (q.query ? '?' + q.query : ''), status: res.status || 200,
      bytes: q.method === 'HEAD' || res.body == null ? 0 : U.byteLen(res.body), referer: q.headers.referer, ua: q.headers['user-agent'], host: q.host, conn: ++state.connections,
    });
  }

  /* sshd and vsftpd */
  const AUTH_LOG = '/var/log/auth.log';
  /** OpenSSH 9.8 moved per-connection work (and its log lines) into sshd-session. */
  function sshIdent(host) {
    const svc = host.services.find((s) => s.port === 22 && s.name === 'ssh');
    return svc && parseFloat(svc.version) >= 9.8 ? 'sshd-session' : 'sshd';
  }
  function onConn(e) {
    const state = live();
    const host = e.host;
    if (!state || !host || !host.shell || e.proto !== 'tcp') return;
    if (e.port === 22) {
      const from = e.src + ' port ' + (32768 + Math.floor(state.rand() * 28232));
      const entry = (msg) => ({ ts: e.ts, ident: sshIdent(host), pid: state.sshPid, msg });
      state.sshPid += 1 + Math.floor(state.rand() * 6);
      hostLog(state, host, entry('Connection from ' + from + ' on ' + host.ip + ' port 22 rdomain ""'));
      // A client that stays connected (ssh, nc) is still talking; anything else was a probe that hung up.
      if (e.kind !== 'connect') hostLog(state, host, entry('Connection closed by ' + from + ' [preauth]'));
    } else if (e.port === 21 && host.ftp) {
      hostLog(state, host, { file: '/var/log/vsftpd.log', text: ctimeDate(e.ts) + ' [pid 2] CONNECT: Client "' + e.src + '"\n' });
    }
  }

  /* ------------------------------------------------------------- log history */

  const UA = {
    firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0',
    chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
    safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15',
  };
  // Office workstations live on 10.10.20.0/24, which the lab segment cannot reach.
  const WORKSTATIONS = [['10.10.20.14', UA.firefox], ['10.10.20.21', UA.chrome], ['10.10.20.22', UA.edge], ['10.10.20.31', UA.edge], ['10.10.20.37', UA.chrome], ['10.10.20.45', UA.safari]];
  const IT_WORKSTATION = '10.10.20.14';
  const VISITS = [
    ['/', '/css/site.css', '/favicon.ico', '/staff/'],
    ['/', '/css/site.css', '/news/', '/helpdesk/'],
    ['/staff/', '/css/site.css'],
    ['/docs/', '/css/site.css', '/docs/acceptable-use.html'],
    ['/docs/remote-working.html', '/css/site.css'],
    ['/', '/css/site.css', '/phone-list'],
    ['/helpdesk/', '/css/site.css', '/favicon.ico'],
  ];

  /** One day of web01 traffic in [from, to): the status probe, and office staff using the portal in working hours. */
  function webDay(from, to, epoch) {
    const events = [];
    for (let mark = Math.ceil(from / PROBE_EVERY) * PROBE_EVERY; probeTime(mark) < to; mark += PROBE_EVERY) events.push(probeEvent(mark));
    const r = U.prng('web01-visits:' + from);
    const cached = {};
    for (let t = from + r() * 20 * MIN; t < to; t += (4 + r() * 22) * MIN) {
      const hour = new Date(t).getUTCHours();
      const who = pick(r, WORKSTATIONS); const visit = pick(r, VISITS);
      if (hour < 7 || hour >= 18) continue;
      let ts = t; let page = null;
      for (const path of visit) {
        const asset = /\.(css|ico)$/.test(path);
        if (page) ts += asset ? 40 + r() * 400 : 4000 + r() * 30000;
        const file = portalFile(path); const key = who[0] + path;
        const status = !file ? 404 : asset && cached[key] ? 304 : 200;
        if (ts < to) events.push({ ts, ip: who[0], method: 'GET', uri: path, ua: who[1], host: PORTAL, status, referer: page && 'http://' + PORTAL + page,
          bytes: status === 404 ? U.byteLen(nginxErrorPage(404, WEB01_SERVER)) : status === 304 ? 0 : U.byteLen(file.body) });
        cached[key] = true;
        if (!asset) page = path;
      }
    }
    events.sort((a, b) => a.ts - b.ts);
    for (const ev of events) ev.conn = CONNECTIONS_AT_BOOT - Math.round((epoch - ev.ts) / 45000);
    return events;
  }
  function webLogs(from, to, epoch) {
    const events = webDay(from, to, epoch);
    const reopened = nginxDate(from + 2000) + ' [notice] ' + (3000 + (U.hash32('rotate:' + from) % 900)) + '#0: signal process started\n';
    return { access: events.map((ev) => accessLine(ev) + '\n').join(''), error: reopened + events.map(errorLine).filter(Boolean).map((l) => l + '\n').join(''), last: events.length ? events[events.length - 1].ts : from };
  }

  /** auth.log up to `epoch`: the test account being set up and tried out, then the hourly cron session. */
  function authHistory(host, epoch) {
    const u = host.shell.users[0]; const ident = sshIdent(host);
    const pidBase = 1400 + (U.hash32('auth:' + host.id) % 300);
    const lines = [];
    const add = (ts, tag, msg) => lines.push([ts, U.syslogDate(ts) + ' ' + host.hostname + ' ' + tag + ': ' + msg]);
    const t0 = startOfDay(epoch) - 3 * DAY + 9 * HOUR + 12 * MIN + (U.hash32('setup:' + host.id) % 600) * 1000;
    add(t0, 'groupadd[' + pidBase + ']', 'new group: name=' + u.name + ', GID=' + u.gid);
    add(t0, 'useradd[' + (pidBase + 4) + ']', 'new user: name=' + u.name + ', UID=' + u.uid + ', GID=' + u.gid + ', home=' + u.home + ', shell=' + u.shell + ', from=none');
    add(t0 + 7000, 'passwd[' + (pidBase + 11) + ']', 'pam_unix(passwd:chauthtok): password changed for ' + u.name);
    for (const g of u.groups || []) add(t0 + 16000, 'usermod[' + (pidBase + 15) + ']', "add '" + u.name + "' to group '" + g + "'");

    const login = (ts, pid, port, mistyped) => {
      const from = IT_WORKSTATION + ' port ' + port; const tag = ident + '[' + pid + ']';
      add(ts, tag, 'Connection from ' + from + ' on ' + host.ip + ' port 22 rdomain ""');
      if (mistyped) {
        add(ts + 6000, tag, 'pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=' + IT_WORKSTATION + '  user=' + u.name);
        add(ts + 8000, tag, 'Failed password for ' + u.name + ' from ' + from + ' ssh2');
        ts += 9000;
      }
      add(ts + 5000, tag, 'Accepted password for ' + u.name + ' from ' + from + ' ssh2');
      add(ts + 5000, tag, 'pam_unix(sshd:session): session opened for user ' + u.name + '(uid=' + u.uid + ') by ' + u.name + '(uid=0)');
      const end = ts + 5000 + (3 + (pid % 9)) * MIN;
      add(end, ident + '[' + (pid + 6) + ']', 'Received disconnect from ' + from + ':11: disconnected by user');
      add(end, ident + '[' + (pid + 6) + ']', 'Disconnected from user ' + u.name + ' ' + from);
      add(end, tag, 'pam_unix(sshd:session): session closed for user ' + u.name);
    };
    login(t0 + 2 * MIN, pidBase + 31, 50308, true);
    login(t0 + DAY + 5 * HOUR, pidBase + 412, 61544, false);

    for (let t = startOfDay(epoch - 30 * HOUR) + 17 * MIN + 1000; t < epoch; t += HOUR) {
      if (t < epoch - 30 * HOUR) continue;
      const tag = 'CRON[' + (pidBase + 500 + Math.round((t - t0) / HOUR) * 23) + ']';
      add(t, tag, 'pam_unix(cron:session): session opened for user root(uid=0) by root(uid=0)');
      add(t, tag, 'pam_unix(cron:session): session closed for user root');
    }
    return lines.filter((l) => l[0] < epoch).sort((a, b) => a[0] - b[0]).map((l) => l[1] + '\n').join('');
  }

  /* ------------------------------------------------------- host filesystems */

  const readOr = (fs, path, fallback) => { try { return fs.read(path); } catch (e) { return fallback; } };
  /** Seed { '/relative/path': text } under `base`. */
  function seedTree(fs, base, tree, o) { for (const p of Object.keys(tree)) fs.seed(base + p, tree[p], o); }
  /** Seed a document root from a site's file table, keeping each file's modification time. */
  function seedSite(fs, base, files) { for (const p of Object.keys(files)) fs.seed(base + p, files[p].body, { mtime: files[p].mtime }); }

  const SSHD_DROPIN = '# Halcyon Freight baseline: log every connection so that sessions can be traced.\nLogLevel VERBOSE\n';

  function welcomeNote(c, role, pointers) {
    const width = Math.max.apply(null, pointers.map((p) => p[0].length));
    return doc(`
      Welcome to ${c.host.fqdn}
      ${'='.repeat(11 + c.host.fqdn.length)}

      This is ${role}. You are logged in with the test account
      that Halcyon Freight created for engagement ${c.world.engagement.id}. It is an ordinary
      user: it has no sudo rights and cannot change the system. It belongs to the adm
      group, so it can read the logs under /var/log.

      Worth a look on this host
      -------------------------
      `) + pointers.map((p) => '  ' + U.padEnd(p[0], width + 3) + p[1] + '\n').join('') + doc(`

      Leave the host as you found it. Type exit to return to the Kali box.
      `);
  }

  const HOSTS = {
    web01(c) {
      const fs = c.fs; const configured = Date.UTC(2026, 8, 14, 9, 48, 30);
      const conf = { mtime: configured };
      fs.seed('/etc/nginx/nginx.conf', NGINX_CONF, conf);
      fs.seed('/etc/nginx/mime.types', NGINX_MIME, conf);
      fs.seed('/etc/nginx/sites-available/default', NGINX_DEFAULT_SITE, conf);
      fs.seed('/etc/nginx/sites-available/intranet', NGINX_PORTAL_SITE, { mtime: Date.UTC(2026, 9, 21, 13, 30, 5) });
      fs.seedLink('/etc/nginx/sites-enabled/default', '/etc/nginx/sites-available/default', conf);
      fs.seedLink('/etc/nginx/sites-enabled/intranet', '/etc/nginx/sites-available/intranet', { mtime: Date.UTC(2026, 9, 21, 13, 30, 5) });
      fs.seedDir('/etc/nginx/conf.d', conf); fs.seedDir('/etc/nginx/modules-enabled', conf);
      fs.seed('/etc/logrotate.d/nginx', NGINX_LOGROTATE, conf);
      fs.seed('/etc/ssl/certs/web01.halcyon.lab.pem', '-----BEGIN CERTIFICATE-----\nMIID' + noise('web01-cert', 1212).replace(/(.{64})/g, '$1\n').slice(4) + '=\n-----END CERTIFICATE-----\n', conf);
      fs.seedDir('/etc/ssl/private', { mode: 0o700, mtime: configured });

      seedSite(fs, DOCROOT, INTRANET_FILES);
      fs.seedDir(DOCROOT + '/backup', { mode: 0o750, gid: 33, mtime: configured });
      seedSite(fs, '/var/www/intranet', PORTAL_FILES);

      const midnight = startOfDay(c.epoch);
      const log = { mode: 0o640, uid: 33, gid: 4 };
      const yesterday = webLogs(midnight - DAY, midnight, c.epoch); const today = webLogs(midnight, c.epoch, c.epoch);
      fs.seedDir('/var/log/nginx', { gid: 4 });
      fs.seed('/var/log/nginx/access.log.1', yesterday.access, Object.assign({ mtime: yesterday.last }, log));
      fs.seed('/var/log/nginx/error.log.1', yesterday.error, Object.assign({ mtime: yesterday.last }, log));
      fs.seed('/var/log/nginx/access.log', today.access, Object.assign({ mtime: today.last }, log));
      fs.seed('/var/log/nginx/error.log', today.error, Object.assign({ mtime: today.last }, log));

      return welcomeNote(c, 'the intranet web server', [
        ['/etc/nginx/', 'web server configuration (two sites: default and intranet)'],
        [DOCROOT + '/', 'the files behind http://' + WEB01 + '/'],
        ['/var/www/intranet/', 'extra pages served only for the name ' + PORTAL],
        ['/var/log/nginx/access.log', 'one line for every HTTP request, yours included'],
        ['/var/log/nginx/error.log', 'requests the server refused or could not find'],
        [AUTH_LOG, 'SSH connections and logins'],
      ]);
    },

    files01(c) {
      const fs = c.fs; const configured = Date.UTC(2026, 7, 3, 15, 22, 10); const refreshed = Date.UTC(2026, 10, 2, 8, 5, 0);
      c.machine.addUser({ name: 'ftp', uid: 102, gid: 103, gecos: 'ftp daemon,,,', home: '/srv/ftp', shell: '/usr/sbin/nologin' });
      fs.seed('/etc/vsftpd.conf', VSFTPD_CONF, { mtime: configured });
      fs.seed('/etc/exports', EXPORTS, { mtime: configured });
      fs.seed('/etc/samba/smb.conf', SMB_CONF, { mtime: configured });
      seedTree(fs, '/srv/ftp', FTP_FILES, { mtime: refreshed });
      fs.seedDir('/srv/ftp', { gid: 103, mtime: refreshed });
      seedTree(fs, '/srv/samba/public', SAMBA_PUBLIC, { mtime: Date.UTC(2026, 10, 6, 12, 40, 18) });
      seedTree(fs, '/srv/nfs/depot-share', NFS_SHARE, { mtime: Date.UTC(2026, 10, 9, 5, 55, 2) });

      const morning = startOfDay(c.epoch) - DAY + 8 * HOUR;
      const transfer = (ts, ip, path) => ctimeDate(ts) + ' [pid 2] CONNECT: Client "' + ip + '"\n' + ctimeDate(ts + 1000) + ' [pid 1] [ftp] OK LOGIN: Client "' + ip + '", anon password "?"\n' +
        ctimeDate(ts + 6000) + ' [pid 3] [ftp] OK DOWNLOAD: Client "' + ip + '", "' + path + '", ' + U.byteLen(FTP_FILES[path]) + ' bytes, ' + (40 + (U.hash32(path) % 400)) + '.' + U.pad2(ts % 97) + 'Kbyte/sec\n';
      fs.seed('/var/log/vsftpd.log', transfer(morning + 2 * MIN, '10.10.20.31', '/pub/rates/rate-card-2026.csv') + transfer(morning + 3 * HOUR, '10.10.20.45', '/pub/forms/delivery-note-template.txt') +
        transfer(morning + 7 * HOUR + 26 * MIN, '10.10.20.22', '/pub/schedules/depot-opening-hours.txt'), { mode: 0o640, gid: 4, mtime: morning + 7 * HOUR + 26 * MIN });

      return welcomeNote(c, 'the file server (FTP, Samba and NFS)', [
        ['/etc/vsftpd.conf', 'FTP server settings'],
        ['/srv/ftp/', 'what anonymous FTP users see'],
        ['/etc/samba/smb.conf', 'Windows file sharing: the [public] share is ' + '/srv/samba/public'],
        ['/etc/exports', 'directories offered over NFS'],
        ['/var/log/vsftpd.log', 'FTP connections and downloads'],
        [AUTH_LOG, 'SSH connections and logins'],
      ]);
    },

    db01(c) {
      const fs = c.fs; const installed = Date.UTC(2026, 7, 3, 16, 2, 41);
      const version = c.host.services.find((s) => s.name === 'mysql').version + '-MariaDB-0+deb13u1';
      c.machine.addUser({ name: 'mysql', uid: 102, gid: 103, gecos: 'MariaDB Server,,,', home: '/nonexistent', shell: '/bin/false' });
      fs.seed('/etc/mysql/mariadb.cnf', MARIADB_CNF, { mtime: installed });
      fs.seedLink('/etc/mysql/my.cnf', '/etc/mysql/mariadb.cnf', { mtime: installed });
      fs.seed('/etc/mysql/mariadb.conf.d/50-server.cnf', MARIADB_SERVER_CNF.replace('BIND_ADDRESS', c.host.ip), { mtime: Date.UTC(2026, 7, 4, 9, 14, 7) });
      fs.seed('/etc/mysql/mariadb.conf.d/50-client.cnf', MARIADB_CLIENT_CNF, { mtime: installed });
      fs.seedDir('/etc/mysql/conf.d', { mtime: installed });
      fs.seedDir('/var/lib/mysql', { mode: 0o700, uid: 102, gid: 103, mtime: c.epoch });

      const started = startOfDay(c.epoch) - 3 * DAY + 6 * HOUR + 25 * MIN + 14000;
      const note = (ts, id, level, msg) => mariaDate(ts) + ' ' + id + ' [' + level + '] ' + msg + '\n';
      const boot = ['Starting MariaDB ' + version + ' source revision 4f8f1d2c0a61e7b9d3a5c8e2f6071b9a4d3c2e1f server_uid Kq2mYc0cJrX1v9u7T3b5nA== as process 742',
        'InnoDB: Compressed tables use zlib 1.3.1', 'InnoDB: Number of transaction pools: 1', 'InnoDB: Using crc32 + pclmulqdq instructions', 'InnoDB: Using liburing',
        'InnoDB: Initializing buffer pool, total size = 128.000MiB, chunk size = 2.000MiB', 'InnoDB: Completed initialization of buffer pool',
        'InnoDB: File system buffers for log disabled (block size=512 bytes)', 'InnoDB: End of log at LSN=1284516', 'InnoDB: Opened 3 undo tablespaces',
        'InnoDB: 128 rollback segments in 3 undo tablespaces are active.', "InnoDB: Setting file './ibtmp1' size to 12.000MiB. Physically writing the file full; Please wait ...",
        "InnoDB: File './ibtmp1' size is now 12.000MiB.", 'InnoDB: log sequence number 1284516; transaction id 2217', 'InnoDB: Loading buffer pool(s) from /var/lib/mysql/ib_buffer_pool',
        "Plugin 'FEEDBACK' is disabled.", "Server socket created on IP: '" + c.host.ip + "', port: '3306'.",
        'InnoDB: Buffer pool(s) load completed at ' + U.isoDate(started).slice(2, 10).replace(/-/g, '') + mariaDate(started).slice(10),
        "/usr/sbin/mariadbd: ready for connections.\nVersion: '" + version + "'  socket: '/run/mysqld/mysqld.sock'  port: 3306  Debian 13"];
      const aborted = (ts, id) => note(ts, id, 'Warning', "Aborted connection " + id + " to db: 'tracker' user: 'tracker_app' host: '10.10.10.70' (Got an error reading communication packets)");
      fs.seedDir('/var/log/mysql', { mode: 0o2750, uid: 102, gid: 4 });
      fs.seed('/var/log/mysql/error.log', boot.map((msg) => note(started, 0, 'Note', msg)).join('') + aborted(started + DAY + 7 * HOUR + 37 * MIN, 31) + aborted(started + 2 * DAY + 2 * HOUR + 3 * MIN, 58),
        { mode: 0o640, uid: 102, gid: 4, mtime: started + 2 * DAY + 2 * HOUR + 3 * MIN });

      return welcomeNote(c, 'the database server (MariaDB)', [
        ['/etc/mysql/', 'MariaDB configuration; start with mariadb.conf.d/50-server.cnf'],
        ['/var/log/mysql/error.log', 'the server log: start-up messages and dropped connections'],
        ['/var/lib/mysql/', 'the data directory, readable only by the mysql user'],
        [AUTH_LOG, 'SSH connections and logins'],
      ]);
    },

    dev01(c) {
      const fs = c.fs; const installed = Date.UTC(2026, 7, 11, 10, 30, 0);
      c.machine.addUser({ name: 'postgres', uid: 110, gid: 110, gecos: 'PostgreSQL administrator,,,', home: '/var/lib/postgresql', shell: '/bin/bash' });
      c.machine.addUser({ name: 'jenkins', uid: 111, gid: 111, gecos: 'Jenkins,,,', home: '/var/lib/jenkins', shell: '/bin/bash' });
      seedTree(fs, '/etc', UBUNTU_ETC, { mtime: installed });
      fs.seed('/etc/cron.d/intranet-status', '# Check the intranet every five minutes; cron mails root if the request fails.\n*/5 * * * * root curl -fsS -o /dev/null http://' + WEB01 + '/status\n', { mtime: Date.UTC(2026, 8, 14, 10, 12, 0) });

      const project = c.student.home + '/projects/shipment-tracker';
      const committed = Date.UTC(2026, 10, 6, 15, 48, 21);
      seedTree(fs, project, TRACKER_PROJECT, { mtime: committed });
      fs.seed(project + '/public/index.html', c.host.web.sites.app.routes['/'].body, { mtime: committed });
      fs.seed(project + '/data/shipments.json', JSON.stringify(API_SHIPMENTS, null, 2) + '\n', { mtime: committed });
      fs.seedOwn(c.student.home + '/projects', c.student.uid, c.student.gid);

      return welcomeNote(c, 'the development and build server', [
        ['~/projects/shipment-tracker/', 'source of the Shipment Tracker that answers on port 3000'],
        ['/etc/cron.d/intranet-status', 'the job behind the regular /status requests in web01\'s access log'],
        ['/etc/os-release', 'this host runs Ubuntu; the other servers run Debian'],
        [AUTH_LOG, 'SSH connections and logins'],
      ]);
    },
  };

  K.fsSeeds.push(function (machine) {
    if (machine.profile === 'kali') return seedKali(machine);
    const world = K.net.world;
    const host = world && K.net.hostById(machine.hostId);
    const seed = host && host.shell && HOSTS[host.id];
    const student = machine.userByName('student');
    if (!seed || !student) return;
    const fs = machine.vfs;
    const state = worlds.get(world);
    const c = { machine, fs, host, world, student, epoch: state ? state.epoch : K.clock.now() };

    const note = seed(c);
    fs.seed(student.home + '/README.txt', note, { uid: student.uid, gid: student.gid, mtime: c.epoch - 3 * DAY });
    fs.seed('/etc/ssh/sshd_config.d/50-halcyon.conf', SSHD_DROPIN, { mtime: Date.UTC(2026, 7, 3, 15, 2, 9) });
    // another pack may have started the file already: history goes in front of what is there
    fs.seed(AUTH_LOG, authHistory(host, c.epoch) + readOr(fs, AUTH_LOG, ''), { mode: 0o640, gid: 4, mtime: c.epoch });
  });

  /* ---------------------------------------------- configuration file contents */

  const NGINX_CONF = doc(`
    user www-data;
    worker_processes auto;
    pid /run/nginx.pid;
    error_log /var/log/nginx/error.log;
    include /etc/nginx/modules-enabled/*.conf;

    events {
    	worker_connections 768;
    	# multi_accept on;
    }

    http {

    	##
    	# Basic Settings
    	##

    	sendfile on;
    	tcp_nopush on;
    	types_hash_max_size 2048;
    	# server_tokens off;

    	# server_names_hash_bucket_size 64;
    	# server_name_in_redirect off;

    	include /etc/nginx/mime.types;
    	default_type application/octet-stream;

    	##
    	# SSL Settings
    	##

    	ssl_protocols TLSv1.2 TLSv1.3;
    	ssl_prefer_server_ciphers on;

    	##
    	# Logging Settings
    	##

    	access_log /var/log/nginx/access.log;

    	##
    	# Gzip Settings
    	##

    	gzip on;

    	# gzip_vary on;
    	# gzip_proxied any;
    	# gzip_comp_level 6;
    	# gzip_buffers 16 8k;
    	# gzip_http_version 1.1;
    	# gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

    	##
    	# Virtual Host Configs
    	##

    	include /etc/nginx/conf.d/*.conf;
    	include /etc/nginx/sites-enabled/*;
    }
    `);

  const NGINX_MIME = doc(`

    types {
        text/html                                        html htm shtml;
        text/css                                         css;
        text/xml                                         xml;
        image/gif                                        gif;
        image/jpeg                                       jpeg jpg;
        application/javascript                           js;
        application/atom+xml                             atom;
        application/rss+xml                              rss;

        text/plain                                       txt;

        image/avif                                       avif;
        image/png                                        png;
        image/svg+xml                                    svg svgz;
        image/webp                                       webp;
        image/x-icon                                     ico;

        font/woff                                        woff;
        font/woff2                                       woff2;

        application/json                                 json;
        application/pdf                                  pdf;
        application/zip                                  zip;

        application/octet-stream                         bin exe dll;
        application/octet-stream                         deb;
        application/octet-stream                         iso img;
    }
    `);

  const NGINX_DEFAULT_SITE = doc(`
    ##
    # Halcyon Freight intranet: the default site.
    # Managed by IT Operations <it-ops@halcyon.lab>.
    ##

    server {
    	listen 80 default_server;
    	listen 443 ssl default_server;

    	server_name web01.halcyon.lab www.halcyon.lab;

    	ssl_certificate     /etc/ssl/certs/web01.halcyon.lab.pem;
    	ssl_certificate_key /etc/ssl/private/web01.halcyon.lab.key;

    	root /var/www/html;
    	index index.html;
    	charset utf-8;

    	location / {
    		# First attempt to serve request as file, then
    		# as directory, then fall back to displaying a 404.
    		try_files $uri $uri/ =404;
    	}

    	# Machine-readable status for the monitoring job on dev01
    	location = /status {
    		try_files /status.json =404;
    	}

    	# Scratch space for site exports; never served
    	location /backup/ {
    		deny all;
    	}
    }
    `);

  const NGINX_PORTAL_SITE = doc(`
    ##
    # Staff portal: a second site on the same address, chosen by host name.
    ##

    server {
    	listen 80;
    	listen 443 ssl;

    	server_name intranet.halcyon.lab;

    	ssl_certificate     /etc/ssl/certs/web01.halcyon.lab.pem;
    	ssl_certificate_key /etc/ssl/private/web01.halcyon.lab.key;

    	root /var/www/intranet;
    	index index.html;
    	charset utf-8;

    	# Portal pages live in /var/www/intranet. Everything else (staff
    	# directory, policies, stylesheet) comes from the default site.
    	location / {
    		try_files $uri $uri/index.html @shared;
    	}

    	location @shared {
    		root /var/www/html;
    	}

    	location = /status {
    		root /var/www/html;
    		try_files /status.json =404;
    	}

    	location /backup/ {
    		deny all;
    	}
    }
    `);

  const NGINX_LOGROTATE = [
    '/var/log/nginx/*.log {', '\tdaily', '\tmissingok', '\trotate 14', '\tcompress', '\tdelaycompress', '\tnotifempty', '\tcreate 0640 www-data adm', '\tsharedscripts',
    '\tprerotate', '\t\tif [ -d /etc/logrotate.d/httpd-prerotate ]; then \\', '\t\t\trun-parts /etc/logrotate.d/httpd-prerotate; \\', '\t\tfi \\', '\tendscript',
    '\tpostrotate', '\t\tinvoke-rc.d nginx rotate >/dev/null 2>&1', '\tendscript', '}', '',
  ].join('\n');

  const VSFTPD_CONF = doc(`
    # /etc/vsftpd.conf - Halcyon Freight public document server
    # Please see vsftpd.conf.5 for all compiled in defaults.
    #
    # Run standalone, listening on IPv4.
    listen=YES
    listen_ipv6=NO
    #
    # Allow anonymous FTP? Customers and hauliers fetch forms and schedules.
    anonymous_enable=YES
    anon_root=/srv/ftp
    no_anon_password=YES
    #
    # Allow local users to log in.
    local_enable=YES
    #
    # Uncomment this to enable any form of FTP write command.
    #write_enable=YES
    #
    # Uncomment this to allow the anonymous FTP user to upload files.
    #anon_upload_enable=YES
    #
    # Activate directory messages - messages given to remote users when they
    # go into a certain directory.
    dirmessage_enable=YES
    #
    # Display directory listings with the time in the local time zone.
    use_localtime=YES
    #
    # Activate logging of connections, uploads and downloads.
    xferlog_enable=YES
    vsftpd_log_file=/var/log/vsftpd.log
    #
    # Make sure PORT transfer connections originate from port 20 (ftp-data).
    connect_from_port_20=YES
    #
    # This option should be the name of a directory which is empty.  Also, the
    # directory should not be writable by the ftp user.
    secure_chroot_dir=/var/run/vsftpd/empty
    #
    # This string is the name of the PAM service vsftpd will use.
    pam_service_name=vsftpd
    #
    ssl_enable=NO
    `);

  const EXPORTS = doc(`
    # /etc/exports: the access control list for filesystems which may be exported
    #		to NFS clients.  See exports(5).
    #
    # Example for NFSv2 and NFSv3:
    # /srv/homes       hostname1(rw,sync,no_subtree_check) hostname2(ro,sync,no_subtree_check)
    #
    # Example for NFSv4:
    # /srv/nfs4        gss/krb5i(rw,sync,fsid=0,crossmnt,no_subtree_check)
    # /srv/nfs4/homes  gss/krb5i(rw,sync,no_subtree_check)
    #
    /srv/nfs/depot-share 10.10.10.0/24(ro,sync,no_subtree_check,root_squash)
    `);

  const SMB_CONF = doc(`
    #
    # Samba configuration for files01 (Halcyon Freight)
    #
    [global]
       workgroup = HALCYON
       server string = %h server (Samba)
       server role = standalone server
       log file = /var/log/samba/log.%m
       max log size = 1000
       logging = file
       panic action = /usr/share/samba/panic-action %d
       obey pam restrictions = yes
       unix password sync = yes
       map to guest = bad user
       usershare allow guests = yes

    [public]
       comment = Notices and forms for all staff
       path = /srv/samba/public
       browseable = yes
       read only = yes
       guest ok = yes
    `);

  const SAMBA_PUBLIC = {
    '/Canteen menu week 46.txt': doc(`
      CANTEEN MENU, WEEK 46 (9 to 13 November)

      Monday      Leek and potato soup / Chicken and mushroom pie
      Tuesday     Tomato soup / Vegetable chilli with rice
      Wednesday   Minestrone / Roast pork with apple sauce
      Thursday    Carrot and coriander soup / Lamb hotpot
      Friday      Pea and mint soup / Fish and chips

      A vegetarian option is available every day. Serving 11:45 to 13:30.
      `),
    '/fire-assembly-points.txt': doc(`
      FIRE ASSEMBLY POINTS, HEAD OFFICE AND MANCHESTER DEPOT

      A   Staff car park, by the cycle shelter    Offices, ground floor
      B   Visitor car park                        Offices, first floor
      C   Gatehouse lawn                          Warehouse and loading bays

      Do not stop to collect belongings. Fire wardens wear yellow vests.
      `),
    '/forms/holiday-request.txt': doc(`
      HOLIDAY REQUEST

      Name: ______________________   Department: ______________________
      First day of leave: ____/____/______   Last day: ____/____/______
      Working days requested: ______

      Give this form to your line manager at least two weeks before the first day.
      `),
  };

  const NFS_SHARE = {
    '/README': 'Read-only copy of the depot rota, exported to machines on the server network.\nUpdated every Monday at 06:00.\n',
    '/rota/week-46.txt': doc(`
      MANCHESTER DEPOT ROTA, WEEK 46

      Shift     Bays 1-4          Bays 5-8          Yard
      Early     team Pollard      team Whitcombe    team A
      Late      team B            team C            team D
      Night     team E            team E            security only
      `),
  };

  const MARIADB_CNF = doc(`
    # The MariaDB configuration file
    #
    # The MariaDB/MySQL tools read configuration files in the following order:
    # 0. "/etc/mysql/my.cnf" symlinks to this file, reason why all the rest is read.
    # 1. "/etc/mysql/mariadb.cnf" (this file) to set global defaults,
    # 2. "/etc/mysql/conf.d/*.cnf" to set global options.
    # 3. "/etc/mysql/mariadb.conf.d/*.cnf" to set MariaDB-only options.
    # 4. "~/.my.cnf" to set user-specific options.
    #
    # If the same option is defined multiple times, the last one will apply.
    #
    # One can use all long options that the program supports.
    # Run program with --help to get a list of available options and with
    # --print-defaults to see which it would actually understand and use.

    #
    # This group is read both by the client and the server
    # use it for options that affect everything
    #
    [client-server]
    # Port or socket location where to connect
    # port = 3306
    socket = /run/mysqld/mysqld.sock

    # Import all .cnf files from configuration directory
    !includedir /etc/mysql/conf.d/
    !includedir /etc/mysql/mariadb.conf.d/
    `);

  const MARIADB_SERVER_CNF = doc(`
    #
    # These groups are read by MariaDB server.
    # Use it for options that only the server (but not clients) should see

    # this is read by the standalone daemon and embedded servers
    [server]

    # this is only for the mariadbd daemon
    [mariadbd]

    #
    # * Basic Settings
    #

    #user                    = mysql
    pid-file                = /run/mysqld/mysqld.pid
    basedir                 = /usr
    #datadir                 = /var/lib/mysql
    #tmpdir                  = /tmp

    # Broken reverse DNS slows down connections considerably and name resolve is
    # safe to skip if there are no "host by domain name" access grants
    skip-name-resolve

    # The Shipment Tracker on dev01 connects over the server network.
    bind-address            = BIND_ADDRESS

    #
    # * Fine Tuning
    #

    #key_buffer_size        = 128M
    #max_allowed_packet     = 1G
    #thread_stack           = 192K
    #thread_cache_size      = 8
    #max_connections        = 100
    #table_cache            = 64

    #
    # * Logging and Replication
    #

    # Enable this if you want to have error logging into a separate file
    log_error = /var/log/mysql/error.log
    # Enable the slow query log to see queries with especially long duration
    #log_slow_query_file    = /var/log/mysql/mariadb-slow.log
    #log_slow_query_time    = 10

    #
    # * Character sets
    #

    # MySQL/MariaDB default is Latin1, but in Debian we rather default to the full
    # utf8 4-byte character set. See also client.cnf
    character-set-server  = utf8mb4
    collation-server      = utf8mb4_general_ci
    `);

  const MARIADB_CLIENT_CNF = doc(`
    #
    # This group is read by the client library
    # Use it for options that affect all clients, but not the server
    #

    [client]
    # Example of client certificate usage
    #ssl-cert = /etc/mysql/client-cert.pem
    #ssl-key  = /etc/mysql/client-key.pem

    # This group is not read by mysql client library,
    # If you use the same .cnf file for MySQL and MariaDB,
    # use it for MariaDB-only client options
    [client-mariadb]
    `);

  // dev01 is the one Ubuntu host; the base image describes Debian.
  const UBUNTU_ETC = {
    '/os-release': doc(`
      PRETTY_NAME="Ubuntu 24.04.3 LTS"
      NAME="Ubuntu"
      VERSION_ID="24.04"
      VERSION="24.04.3 LTS (Noble Numbat)"
      VERSION_CODENAME=noble
      ID=ubuntu
      ID_LIKE=debian
      HOME_URL="https://www.ubuntu.com/"
      SUPPORT_URL="https://help.ubuntu.com/"
      BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"
      PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"
      UBUNTU_CODENAME=noble
      LOGO=ubuntu-logo
      `),
    '/lsb-release': 'DISTRIB_ID=Ubuntu\nDISTRIB_RELEASE=24.04\nDISTRIB_CODENAME=noble\nDISTRIB_DESCRIPTION="Ubuntu 24.04.3 LTS"\n',
    '/debian_version': 'trixie/sid\n',
    '/issue': 'Ubuntu 24.04.3 LTS \\n \\l\n\n',
    '/apt/sources.list': '# Ubuntu sources have moved to /etc/apt/sources.list.d/ubuntu.sources\n',
    '/apt/sources.list.d/ubuntu.sources': doc(`
      Types: deb
      URIs: http://archive.ubuntu.com/ubuntu/
      Suites: noble noble-updates noble-backports
      Components: main restricted universe multiverse
      Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

      Types: deb
      URIs: http://security.ubuntu.com/ubuntu/
      Suites: noble-security
      Components: main restricted universe multiverse
      Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
      `),
  };

  const TRACKER_PROJECT = {
    '/README.md': doc(`
      # Shipment Tracker

      Internal service that answers "where is consignment HF-2026-NNNNN?".
      This checkout is the development build that runs on dev01, port 3000.

      ## Running

          npm install
          npm start          # listens on PORT (default 3000)
          npm test

      ## Endpoints

      | Method | Path                 | Returns                          |
      | ------ | -------------------- | -------------------------------- |
      | GET    | /                    | landing page                     |
      | GET    | /api/health          | liveness check used by Jenkins   |
      | GET    | /api/version         | name, version and Node release   |
      | GET    | /api/shipments       | sample consignments              |
      | GET    | /api/shipments/:id   | one consignment, or 404          |

      The development build serves the sample data in data/shipments.json.
      Production reads from the tracker database on db01 instead.

      Maintainers: Hana Kobayashi and Oskar Lindqvist (IT Development).
      `),
    '/package.json': doc(`
      {
        "name": "shipment-tracker",
        "version": "0.4.2",
        "description": "Internal shipment tracking service for Halcyon Freight (development build)",
        "private": true,
        "main": "server.js",
        "scripts": {
          "start": "node server.js",
          "dev": "node --watch server.js",
          "test": "node --test test/"
        },
        "engines": {
          "node": ">=22"
        },
        "dependencies": {
          "express": "^5.1.0"
        },
        "license": "UNLICENSED"
      }
      `),
    '/server.js': doc(`
      'use strict';

      const path = require('node:path');
      const express = require('express');
      const pkg = require('./package.json');
      const shipments = require('./routes/shipments');

      const app = express();
      const port = Number(process.env.PORT) || 3000;
      const env = process.env.NODE_ENV || 'development';

      app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
      });

      app.get('/api/health', (req, res) => {
        res.json({ ok: true, env });
      });

      app.get('/api/version', (req, res) => {
        res.json({ name: pkg.name, version: pkg.version, node: process.version, env });
      });

      app.use('/api/shipments', shipments);

      app.listen(port, () => {
        console.log(pkg.name + ' ' + pkg.version + ' listening on port ' + port + ' (' + env + ')');
      });
      `),
    '/routes/shipments.js': doc(`
      'use strict';

      const express = require('express');
      const shipments = require('../data/shipments.json');

      const router = express.Router();

      // GET /api/shipments
      router.get('/', (req, res) => {
        res.json(shipments);
      });

      // GET /api/shipments/HF-2026-10421
      router.get('/:id', (req, res) => {
        const found = shipments.find((s) => s.id === req.params.id);
        if (!found) return res.status(404).json({ error: 'shipment not found' });
        res.json(found);
      });

      module.exports = router;
      `),
    '/test/health.test.js': doc(`
      'use strict';

      const test = require('node:test');
      const assert = require('node:assert/strict');

      const base = process.env.TRACKER_URL || 'http://localhost:3000';

      test('health endpoint reports ok', async () => {
        const res = await fetch(base + '/api/health');
        assert.equal(res.status, 200);
        assert.equal((await res.json()).ok, true);
      });

      test('unknown consignment is a 404', async () => {
        const res = await fetch(base + '/api/shipments/HF-0000-00000');
        assert.equal(res.status, 404);
      });
      `),
    '/.env.example': '# Copy to .env and adjust. Never commit a real .env file.\nPORT=3000\nNODE_ENV=development\n',
    '/.gitignore': 'node_modules/\n.env\nnpm-debug.log*\ncoverage/\n',
  };

  /* ----------------------------------------------------------- Kali extras */

  const PRACTICE = '/usr/share/kalima';

  /** One day on a fictional web shop: regular visitors, a crawler, an uptime check, a path scanner and a login guesser. */
  function sampleAccessLog() {
    const r = U.prng('kalima-sample-access');
    const day = Date.UTC(2026, 10, 12);
    const NOT_FOUND = 146; // nginx's 404 page with server_tokens off
    const PAGES = { '/': 5120, '/products/': 8344, '/products/pallet-wrap': 6021, '/products/ratchet-straps': 6377, '/products/load-bars': 5893, '/about': 3310, '/contact': 2874, '/cart': 4102 };
    const ASSETS = { '/static/app.css': 18230, '/static/app.js': 46112, '/favicon.ico': 1150 };
    const events = [];
    const add = (ts, ip, request, status, bytes, referer, ua) =>
      events.push([ts, ip + ' - - [' + clfDate(ts) + '] "' + request + ' HTTP/1.1" ' + status + ' ' + bytes + ' "' + referer + '" "' + ua + '"']);

    for (let t = day; t < day + DAY; t += 15 * MIN) add(t + 2000 + r() * 800, '192.0.2.44', 'GET /status', 200, 17, '-', 'UptimeProbe/1.4');

    const visitors = [['198.51.100.23', UA.firefox, 16], ['198.51.100.77', UA.chrome, 13], ['203.0.113.45', UA.safari, 9]];
    for (const v of visitors) {
      for (let i = 0; i < v[2]; i++) {
        let ts = day + 7 * HOUR + r() * 14 * HOUR; let from = '-';
        for (let n = 1 + Math.floor(r() * 3); n > 0; n--) {
          const page = pick(r, Object.keys(PAGES));
          add(ts, v[0], 'GET ' + page, 200, PAGES[page], from, v[1]);
          if (from === '-') for (const a of Object.keys(ASSETS)) add(ts + 90 + r() * 300, v[0], 'GET ' + a, r() < 0.3 ? 304 : 200, ASSETS[a], 'https://shop.example' + page, v[1]);
          from = 'https://shop.example' + page; ts += 5000 + r() * 60000;
        }
      }
    }
    const crawl = ['/robots.txt', '/sitemap.xml'].concat(Object.keys(PAGES));
    for (let i = 0; i < 40; i++) {
      const path = crawl[i % crawl.length];
      add(day + 1 * HOUR + i * 31 * MIN + r() * MIN, '192.0.2.10', 'GET ' + path, 200, PAGES[path] || 412, '-', 'Mozilla/5.0 (compatible; ExampleBot/2.1; +http://crawler.example/bot.html)');
    }
    const guesses = ['admin', 'administrator', 'login', 'backup', 'backups', 'config', 'old', 'test', 'dev', 'staging', 'tmp', 'private', 'db', 'sql', 'uploads', 'files', 'cgi-bin', 'server-status',
      '.git/HEAD', '.env', 'phpinfo.php', 'wp-login.php', 'phpmyadmin', 'portal', 'api', 'console', 'manager', 'secret', 'data', 'export'];
    for (let i = 0; i < 110; i++) {
      const word = guesses[i % guesses.length] + (i >= guesses.length ? ['.php', '.bak', '.zip', '.txt'][Math.floor(i / guesses.length)] : '');
      const hit = word === 'login' || word === 'api';
      add(day + 3 * HOUR + 12 * MIN + i * 410 + r() * 200, '203.0.113.99', 'GET /' + word, hit ? 200 : 404, hit ? 2210 : NOT_FOUND, '-', 'gobuster/3.8');
    }
    for (let i = 0; i < 24; i++) add(day + 21 * HOUR + 40 * MIN + i * 14000 + r() * 3000, '198.51.100.150', 'POST /login', 401, 1187, 'https://shop.example/login', 'python-requests/2.32.5');
    for (let i = 0; i < 5; i++) add(day + 10 * HOUR + i * 95000, '203.0.113.7', 'HEAD /', 200, 0, '-', 'curl/8.17.0');

    return events.sort((a, b) => a[0] - b[0]).map((e) => e[1] + '\n').join('');
  }

  /** Two days of sshd on an internet-facing host: password guessing from four addresses among normal logins. */
  function sampleAuthLog() {
    const r = U.prng('kalima-sample-auth');
    const start = Date.UTC(2026, 10, 11);
    const names = ['root', 'admin', 'test', 'oracle', 'ubuntu', 'postgres', 'git', 'guest', 'ftpuser', 'pi', 'user', 'support'];
    const lines = [];
    let pid = 18200;
    const add = (ts, tag, msg) => lines.push([ts, U.syslogDate(ts) + ' bastion ' + tag + ': ' + msg]);
    for (const guesser of [['203.0.113.99', 64, 2], ['198.51.100.150', 31, 9], ['192.0.2.201', 17, 20], ['203.0.113.12', 6, 31]]) {
      let t = start + guesser[2] * HOUR;
      for (let i = 0; i < guesser[1]; i++) {
        t += 2500 + r() * 9000; pid += 1 + Math.floor(r() * 3);
        const name = pick(r, names); const from = guesser[0] + ' port ' + (32768 + Math.floor(r() * 28000)); const tag = 'sshd[' + pid + ']';
        if (name === 'root') {
          add(t, tag, 'Failed password for root from ' + from + ' ssh2');
          add(t + 600, tag, 'Connection closed by authenticating user root ' + from + ' [preauth]');
        } else {
          add(t, tag, 'Invalid user ' + name + ' from ' + from);
          add(t + 1900, tag, 'Failed password for invalid user ' + name + ' from ' + from + ' ssh2');
          add(t + 2500, tag, 'Connection closed by invalid user ' + name + ' ' + from + ' [preauth]');
        }
      }
    }
    for (const session of [[8.5, '198.51.100.23', 51022], [13.2, '198.51.100.23', 51987], [32.4, '198.51.100.23', 49731], [34.1, '198.51.100.77', 60233]]) {
      const t = start + session[0] * HOUR; pid += 7; const tag = 'sshd[' + pid + ']'; const from = session[1] + ' port ' + session[2];
      add(t, tag, 'Accepted publickey for deploy from ' + from + ' ssh2: ED25519 SHA256:' + noise('key:' + session[1], 43));
      add(t, tag, 'pam_unix(sshd:session): session opened for user deploy(uid=1001) by deploy(uid=0)');
      add(t + 11 * MIN, tag, 'pam_unix(sshd:session): session closed for user deploy');
    }
    for (let t = start + 17 * MIN + 1000; t < start + 2 * DAY; t += HOUR) {
      const tag = 'CRON[' + (17000 + Math.round((t - start) / HOUR) * 41) + ']';
      add(t, tag, 'pam_unix(cron:session): session opened for user root(uid=0) by root(uid=0)');
      add(t, tag, 'pam_unix(cron:session): session closed for user root');
    }
    return lines.sort((a, b) => a[0] - b[0]).map((l) => l[1] + '\n').join('');
  }

  function fleetList() {
    const r = U.prng('kalima-fleet');
    const rows = [];
    for (let i = 0; i < 24; i++) {
      const type = pick(r, ['artic', 'artic', 'rigid', 'rigid', 'van', 'flatbed']);
      const year = 2014 + Math.floor(r() * 12);
      rows.push('HF-V' + String(1 + Math.floor(r() * 60)).padStart(3, '0') + '  ' + U.padEnd(type, 9) + U.padEnd(pick(r, DEPOTS), 12) + year + '  ' +
        U.padStart((2026 - year) * (type === 'van' ? 21000 : 54000) + Math.floor(r() * 30000), 7));
    }
    rows.splice(9, 0, rows[2]); rows.splice(20, 0, rows[5]); // two vehicles were entered twice
    return rows.join('\n') + '\n';
  }

  const SHIFT_LOG = doc(`
    Depot shift log - Manchester - Thursday 12 November 2026
    time   level  message
    06:02  INFO   Gate opened, 14 vehicles on site
    06:15  INFO   Scanner SC-07 docked and charging
    06:31  WARN   Scanner SC-14 battery at 9%
    06:48  ERROR  Label printer LP-2 offline (paper jam)
    07:05  INFO   Trunk from Leeds arrived, 22 pallets
    07:06  info   pallet count confirmed by G. Pollard
    07:20  ERROR  Scanner SC-14 failed to sync: timeout contacting 10.10.10.70
    07:41  WARN   Bay 3 door sensor intermittent
    08:00  INFO   Shift handover: nights to days
    08:12  INFO   Email sent to it-ops@halcyon.lab about SC-14
    08:30  error  forklift FL-3 failed pre-use check
    08:55  INFO   Collection booked, ref HF-2026-10431
    09:02  INFO   Label printer LP-2 back online
    09:40  WARN   Bay 3 door sensor intermittent
    10:15  INFO   Trunk to Hull departed, 18 pallets
    10:16  INFO   Trunk to Leeds departed, 26 pallets
    11:03  ERROR  Scanner SC-14 failed to sync: timeout contacting 10.10.10.70
    11:30  INFO   Scanner SC-14 swapped for spare SC-21
    12:00  INFO   Canteen break, bays 1-4
    12:45  INFO   Canteen break, bays 5-8
    13:20  WARN   Pallet HF-2026-10447 wrapped loosely, rewrapped
    14:02  INFO   Visitor signed in: Tyne Electrical Wholesale
    14:30  ERROR  Weighbridge reading rejected: 0 kg
    14:31  INFO   Weighbridge reading accepted: 7420 kg
    15:10  INFO   Email sent to dispatch@halcyon.lab: late collection M2
    15:55  WARN   Bay 3 door sensor intermittent
    16:00  INFO   Shift handover: days to lates
    16:20  INFO   Forklift FL-3 repaired and signed off
    17:45  INFO   Trunk from Hull arrived, 15 pallets
    18:30  Error  Gate barrier stuck open, security informed
    19:05  INFO   Gate barrier reset
    21:50  INFO   Last collection vehicle back on site
    22:00  INFO   Gate closed, 16 vehicles on site
    `);

  let practice = null; // generated once and shared by every Kali machine built from this load
  function practiceFiles() {
    if (practice) return practice;
    const csv = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
    practice = {
      '/README': doc(`
        Kalima practice data
        ====================

        Sample files for the lessons. Everything in them is invented. They are read-only;
        copy a file to your home directory if you want to change it.

        logs/access.log      One day of requests to a fictional web shop, in nginx's
                             "combined" format. A handful of clients; not all of them
                             are ordinary visitors.
        logs/auth.log        Two days of SSH logins on a fictional internet-facing host.
                             Most of the noise is password guessing.
        data/shipments.csv   Sixty Halcyon Freight consignments from October 2026.
                             Comma separated, with a header row.
        text/fleet.txt       The vehicle list: id, type, depot, year, mileage. Columns
                             are separated by spaces and two rows were entered twice.
        text/shift-log.txt   A depot shift log for searching: times, levels and
                             free-text messages.
        `),
      '/logs/access.log': sampleAccessLog(),
      '/logs/auth.log': sampleAuthLog(),
      '/data/shipments.csv': [SHIPMENT_COLUMNS].concat(SHIPMENTS.map((s) => SHIPMENT_COLUMNS.map((k) => s[k]))).map((row) => row.map(csv).join(',') + '\n').join(''),
      '/text/fleet.txt': fleetList(),
      '/text/shift-log.txt': SHIFT_LOG,
    };
    return practice;
  }

  function seedKali(machine) {
    const fs = machine.vfs;
    seedTree(fs, PRACTICE, practiceFiles(), { mtime: IMAGE_BUILT });
    const kali = machine.userByName('kali'); const e = K.net.world && K.net.world.engagement;
    if (!kali || !e) return;
    fs.seed(kali.home + '/Documents/README.txt', doc(`
      Welcome to the Kalima training lab
      ==================================

      You are logged in as kali on a simulated Kali Linux ${K.distro.release} workstation. Nothing
      here touches a real network: every host, every reply and every log line is
      simulated, so you can experiment freely.

      Where things are
      ----------------
      ~/engagement/        the paperwork for engagement ${e.id}: scope, rules of
                           engagement, the client's test account and your notes
      ~/engagement/scans/  somewhere to keep tool output
      ${PRACTICE}/   practice files used by the lessons (start with its README)

      The lab
      -------
      Client    ${e.client}
      In scope  ${e.scope.concat(e.domains.map((d) => '*.' + d)).join(' and ')}
      You are   ${machine.primaryIp()} (${machine.ifaces.filter((i) => i.kind !== 'loopback').map((i) => i.name).join(', ')})

      Good habits
      -----------
      - Read ~/engagement/rules-of-engagement.txt before you scan anything.
      - Stay in scope. The client's public website, halcyonfreight.example, is out of
        scope: look at what it publishes, but do not test it.
      - Keep notes as you go in ~/engagement/notes.md.
      - The test account in ~/engagement/credentials.txt lets you log in to some of the
        servers over SSH. Once there you can read the server's own logs and see your
        activity the way a defender does.
      - Every tool has a manual. Try: man <tool>, or <tool> --help
      `), { uid: kali.uid, gid: kali.gid, mtime: IMAGE_BUILT });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
