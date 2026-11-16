// World content: web sites, host filesystems, Kali practice data and live logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './harness.mjs';

const http = (sim, url, o) => sim.K.net.http(sim.machine, Object.assign({ method: 'GET', url }, o));
const logOf = (sim, id, path) => sim.K.net.machineFor(id).vfs.read(path);
const lines = (text) => text.split('\n').filter(Boolean);
const NGINX_COMBINED = /^(\d+\.\d+\.\d+\.\d+) - - \[(\d\d\/[A-Z][a-z]{2}\/\d{4}:\d\d:\d\d:\d\d \+0000)\] "([A-Z]+ \S+ HTTP\/1\.1)" (\d{3}) (\d+) "([^"]*)" "([^"]*)"$/;

test('web01 intranet routes and the 403 on /backup/', async () => {
  const sim = await boot();
  const staff = http(sim, 'http://10.10.10.10/staff/');
  assert.equal(staff.status, 200);
  assert.match(staff.body, /Staff directory/);
  assert.match(staff.body, /ifarrow@halcyon\.lab/);
  assert.equal(http(sim, 'http://web01.halcyon.lab/backup/').status, 403);
  assert.equal(http(sim, 'http://web01.halcyon.lab/backup/old.zip').status, 403);
  assert.equal(http(sim, 'http://web01.halcyon.lab/backup').status, 301);
  assert.equal(http(sim, 'http://web01.halcyon.lab/nothing-here').status, 404);
  assert.equal(JSON.parse(http(sim, 'http://web01.halcyon.lab/status').body).status, 'ok');
  assert.match(http(sim, 'http://web01.halcyon.lab/robots.txt').body, /Disallow: \/backup\//);
});

test('web01 serves conditional GETs the way nginx does', async () => {
  const sim = await boot();
  const first = http(sim, 'http://web01.halcyon.lab/css/site.css');
  assert.equal(first.status, 200);
  const again = http(sim, 'http://web01.halcyon.lab/css/site.css', { headers: { 'if-none-match': first.headers.etag } });
  assert.equal(again.status, 304);
  assert.equal(again.body, '');
});

test('the staff portal is a second virtual host that falls back to the default site', async () => {
  const sim = await boot();
  const news = http(sim, 'http://intranet.halcyon.lab/news/');
  assert.equal(news.status, 200);
  assert.match(news.body, /File server maintenance/);
  assert.equal(http(sim, 'http://web01.halcyon.lab/news/').status, 404, 'the default site has no news pages');
  assert.match(http(sim, 'http://intranet.halcyon.lab/staff/').body, /Desmond Achterberg/);
  assert.equal(http(sim, 'http://intranet.halcyon.lab/backup/').status, 403);
});

test('public site, tracking site, printer, gw and dev01', async () => {
  const sim = await boot();
  const home = http(sim, 'http://halcyonfreight.example/');
  assert.equal(home.status, 200);
  assert.match(home.body, /Moving what matters/);
  assert.match(http(sim, 'https://halcyonfreight.example/.well-known/security.txt').body, /^Contact: mailto:security@halcyonfreight\.example/);
  assert.equal(http(sim, 'https://halcyonfreight.example/staging/').status, 403);
  assert.match(http(sim, 'https://halcyonfreight.example/careers').body, /Systems Administrator/);
  assert.match(http(sim, 'https://halcyon-tracking.example/robots.txt').body, /Disallow: \//);

  const status = http(sim, 'http://printer.halcyon.lab/hp/device/DeviceStatus/Index');
  assert.equal(status.status, 200);
  assert.match(status.body, /Black Cartridge/);
  assert.match(http(sim, 'http://printer.halcyon.lab/DevMgmt/ProductConfigDyn.xml').body, /SIM0000507/);

  const luci = http(sim, 'http://gw.halcyon.lab/cgi-bin/luci/');
  assert.equal(luci.status, 403);
  assert.match(luci.body, /Authorization Required/);
  assert.match(http(sim, 'http://gw.halcyon.lab/cgi-bin/luci/', { method: 'POST', body: 'luci_username=x&luci_password=y' }).body, /Invalid username and\/or password/);
  assert.equal(http(sim, 'http://gw.halcyon.lab/missing').status, 404);

  assert.equal(http(sim, 'http://dev01.halcyon.lab:3000/api/version').status, 200);
  const one = http(sim, 'http://dev01.halcyon.lab:3000/api/shipments/HF-2026-10421');
  assert.equal(JSON.parse(one.body).id, 'HF-2026-10421');
  assert.equal(http(sim, 'http://dev01.halcyon.lab:3000/api/shipments/HF-0000-00000').status, 404);
  assert.match(http(sim, 'http://dev01.halcyon.lab:3000/nope').body, /Cannot GET \/nope/);
  const ci = http(sim, 'http://dev01.halcyon.lab:8080/');
  assert.equal(ci.status, 403);
  assert.match(ci.body, /Authentication required/);
});

test('seeded files on web01, files01, db01 and dev01', async () => {
  const sim = await boot();
  const K = sim.K;
  const web = K.net.machineFor('web01').vfs;
  assert.match(web.read('/etc/nginx/sites-enabled/intranet'), /server_name intranet\.halcyon\.lab/);
  assert.equal(web.read('/var/www/html/staff/index.html'), http(sim, 'http://web01.halcyon.lab/staff/').body);
  assert.match(web.read('/home/student/README.txt'), /web01\.halcyon\.lab/);
  assert.equal(web.stat('/var/www/html/backup').isDir, true);
  assert.match(web.read('/etc/ssh/sshd_config.d/50-halcyon.conf'), /LogLevel VERBOSE/);

  const files = K.net.machineFor('files01').vfs;
  assert.match(files.read('/etc/vsftpd.conf'), /anon_root=\/srv\/ftp/);
  assert.match(files.read('/etc/samba/smb.conf'), /\[public\]/);
  assert.match(files.read('/etc/exports'), /depot-share/);

  const db = K.net.machineFor('db01').vfs;
  assert.match(db.read('/etc/mysql/mariadb.conf.d/50-server.cnf'), /bind-address\s+= 10\.10\.10\.30/);
  assert.match(db.read('/var/log/mysql/error.log'), /ready for connections/);

  const dev = K.net.machineFor('dev01').vfs;
  assert.match(dev.read('/etc/os-release'), /Ubuntu/);
  assert.match(dev.read('/etc/cron.d/intranet-status'), /web01\.halcyon\.lab\/status/);
  assert.match(dev.read('/home/student/projects/shipment-tracker/package.json'), /"name": "shipment-tracker"/);
  const shipments = JSON.parse(dev.read('/home/student/projects/shipment-tracker/data/shipments.json'));
  assert.equal(shipments[0].id, 'HF-2026-10421');
});

test('host.ftp for files01 matches /srv/ftp', async () => {
  const sim = await boot();
  const K = sim.K;
  const ftp = K.net.hostById('files01').ftp;
  assert.equal(ftp.anonymous, true);
  assert.ok(ftp.users.student, 'local accounts may log in over FTP');
  const fs = K.net.machineFor('files01').vfs;
  const paths = Object.keys(ftp.files);
  assert.ok(paths.length >= 6);
  for (const p of paths) assert.equal(fs.read('/srv/ftp' + p), ftp.files[p], p);
  assert.match(ftp.files['/pub/README.txt'], /Anonymous access is read-only/);
});

test('Kali extras: practice files and the welcome note', async () => {
  const sim = await boot();
  const r = await sim.run('cat /usr/share/kalima/README ~/Documents/README.txt');
  assert.equal(r.code, 0);
  assert.match(r.out, /logs\/access\.log/);
  assert.match(r.out, /engagement HF-LAB-2026-11/);
  assert.match(r.out, /halcyonfreight\.example, is out of\s+scope/);
  const ls = await sim.run('ls /usr/share/kalima/*');
  for (const f of ['access.log', 'auth.log', 'shipments.csv', 'fleet.txt', 'shift-log.txt']) assert.match(ls.out, new RegExp(f));
  assert.equal(sim.machine.vfs.stat('/usr/share/kalima/logs/access.log').uid, 0);
});

test('practice access log is real combined format with a handful of clients', async () => {
  const sim = await boot();
  const text = sim.machine.vfs.read('/usr/share/kalima/logs/access.log');
  const rows = lines(text);
  assert.ok(rows.length >= 300 && rows.length <= 700, 'a few hundred lines, got ' + rows.length);
  for (const l of rows) assert.match(l, NGINX_COMBINED, l);
  const times = rows.map((l) => NGINX_COMBINED.exec(l)[2]);
  assert.deepEqual(times, times.slice().sort(), 'in chronological order');
  const clients = await sim.run("cut -d' ' -f1 /usr/share/kalima/logs/access.log | sort | uniq -c | sort -rn");
  const counts = lines(clients.out).map((l) => l.trim().split(/\s+/));
  assert.ok(counts.length >= 5 && counts.length <= 10, 'distinct clients: ' + counts.length);
  assert.equal(counts[0][1], '203.0.113.99', 'the busiest client is the path scanner');
  assert.match(text, /gobuster/);
  assert.match(text, /POST \/login HTTP\/1\.1" 401/);
  for (const ip of counts.map((c) => c[1])) assert.match(ip, /^(192\.0\.2|198\.51\.100|203\.0\.113)\./, 'documentation addresses only');
});

test('practice auth log, shipments CSV and text files suit the exercises', async () => {
  const sim = await boot();
  const fs = sim.machine.vfs;
  const auth = fs.read('/usr/share/kalima/logs/auth.log');
  assert.match(auth, /Failed password for invalid user \w+ from 203\.0\.113\.99 port \d+ ssh2/);
  assert.match(auth, /Accepted publickey for deploy/);
  const failing = await sim.run("grep 'Failed password' /usr/share/kalima/logs/auth.log | grep -o 'from [0-9.]*' | sort | uniq -c | sort -rn | head -1");
  assert.match(failing.out, /203\.0\.113\.99/);

  const csv = lines(fs.read('/usr/share/kalima/data/shipments.csv'));
  assert.equal(csv[0], 'id,date,origin,destination,weight_kg,pallets,service,status,customer');
  assert.equal(csv.length, 61);
  for (const l of csv.slice(1)) assert.match(l, /^HF-2026-\d{5},2026-10-\d\d,(Manchester|Leeds|Hull),[^,]+,\d+,\d+,(next-day|economy|timed),(delivered|in_transit|delayed|returned),/);
  const byStatus = await sim.run("cut -d, -f8 /usr/share/kalima/data/shipments.csv | tail -n +2 | sort | uniq -c");
  assert.equal(lines(byStatus.out).length, 4, 'all four statuses occur');

  const fleet = lines(fs.read('/usr/share/kalima/text/fleet.txt'));
  assert.equal(fleet.length - new Set(fleet).size, 2, 'two duplicated rows for uniq');
  const shift = fs.read('/usr/share/kalima/text/shift-log.txt');
  assert.match(shift, /ERROR/);
  assert.match(shift, /\berror\b/, 'mixed case for grep -i');
  assert.ok((shift.match(/Bay 3 door sensor/g) || []).length >= 3, 'repeated messages for sort | uniq -c');
});

test('live log: an HTTP request appears in web01 access.log in combined format', async () => {
  const sim = await boot();
  const K = sim.K;
  const web = K.net.machineFor('web01');
  const before = lines(web.vfs.read('/var/log/nginx/access.log')).length;
  http(sim, 'http://web01.halcyon.lab/staff/', { headers: { 'user-agent': 'curl/8.17.0', referer: 'http://web01.halcyon.lab/' } });
  http(sim, 'http://web01.halcyon.lab/missing.html?x=1');
  const rows = lines(web.vfs.read('/var/log/nginx/access.log'));
  assert.equal(rows.length - before, 2);
  const ok = NGINX_COMBINED.exec(rows[rows.length - 2]);
  assert.ok(ok);
  assert.deepEqual([ok[1], ok[3], ok[4], ok[6], ok[7]], ['10.10.10.5', 'GET /staff/ HTTP/1.1', '200', 'http://web01.halcyon.lab/', 'curl/8.17.0']);
  assert.equal(Number(ok[5]), web.vfs.read('/var/www/html/staff/index.html').length);
  const miss = NGINX_COMBINED.exec(rows[rows.length - 1]);
  assert.deepEqual([miss[3], miss[4]], ['GET /missing.html?x=1 HTTP/1.1', '404']);
  const err = lines(web.vfs.read('/var/log/nginx/error.log')).pop();
  assert.match(err, /^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d \[error\] 812#812: \*\d+ open\(\) "\/var\/www\/html\/missing\.html" failed \(2: No such file or directory\), client: 10\.10\.10\.5, server: web01\.halcyon\.lab, request: "GET \/missing\.html\?x=1 HTTP\/1\.1", host: "web01\.halcyon\.lab"$/);
});

test('live log: forbidden and portal requests', async () => {
  const sim = await boot();
  const web = sim.K.net.machineFor('web01');
  http(sim, 'http://web01.halcyon.lab/backup/');
  http(sim, 'http://intranet.halcyon.lab/helpdesk/');
  const err = lines(web.vfs.read('/var/log/nginx/error.log'));
  assert.match(err[err.length - 1], /\[error\] 812#812: \*\d+ access forbidden by rule, client: 10\.10\.10\.5, server: web01\.halcyon\.lab, request: "GET \/backup\/ HTTP\/1\.1", host: "web01\.halcyon\.lab"$/);
  const rows = lines(web.vfs.read('/var/log/nginx/access.log'));
  assert.match(rows[rows.length - 2], /"GET \/backup\/ HTTP\/1\.1" 403 153 /);
  assert.match(rows[rows.length - 1], /"GET \/helpdesk\/ HTTP\/1\.1" 200 /);
});

test('live log: requests made before the machine exists are flushed when it is created', async () => {
  const sim = await boot();
  const K = sim.K;
  assert.equal(K.net.machines.web01, undefined, 'nobody has logged in yet');
  http(sim, 'http://web01.halcyon.lab/early-bird');
  http(sim, 'http://web01.halcyon.lab/staff/');
  const web = K.net.machineFor('web01');
  const rows = lines(web.vfs.read('/var/log/nginx/access.log'));
  const tail = rows.slice(-2);
  assert.match(tail[0], /"GET \/early-bird HTTP\/1\.1" 404 /);
  assert.match(tail[1], /"GET \/staff\/ HTTP\/1\.1" 200 /);
  assert.match(lines(web.vfs.read('/var/log/nginx/error.log')).pop(), /early-bird/);
  http(sim, 'http://web01.halcyon.lab/late');
  assert.match(lines(web.vfs.read('/var/log/nginx/access.log')).pop(), /GET \/late /, 'after creation lines go straight in');
});

test('live log: logs stay in time order across history, probes and the learner', async () => {
  const sim = await boot();
  const K = sim.K;
  K.clock.advance ? K.clock.advance(20 * 60000) : await sim.run('sleep 1200');
  http(sim, 'http://web01.halcyon.lab/');
  const rows = lines(logOf(sim, 'web01', '/var/log/nginx/access.log'));
  const mine = rows.filter((l) => l.startsWith('10.10.10.5 '));
  assert.equal(mine.length, 1);
  const probes = rows.filter((l) => l.startsWith('10.10.10.70 '));
  assert.ok(probes.length >= 3, 'the monitoring job on dev01 keeps polling /status');
  for (const l of probes) assert.match(l, /"GET \/status HTTP\/1\.1" 200 82 "-" "curl\/8\.5\.0"$/);
});

test('live log: ssh connections are logged in sshd format, both orders', async () => {
  const sim = await boot();
  const K = sim.K;
  // before the machine exists
  K.net.connect(sim.machine, '10.10.10.20', 22).close();
  K.net.tcp(sim.machine, '10.10.10.20', 22);
  const files = K.net.machineFor('files01');
  let auth = lines(files.vfs.read('/var/log/auth.log'));
  const pre = auth.filter((l) => /Connection from 10\.10\.10\.5 port/.test(l));
  assert.ok(pre.length >= 1, 'buffered connection flushed');
  // after the machine exists
  K.net.connect(sim.machine, '10.10.10.20', 22).close();
  auth = lines(files.vfs.read('/var/log/auth.log'));
  const all = auth.filter((l) => /Connection from 10\.10\.10\.5 port/.test(l));
  assert.ok(all.length > pre.length);
  const ident = /^[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d files01 (sshd|sshd-session)\[\d+\]: Connection from 10\.10\.10\.5 port \d+ on 10\.10\.10\.20 port 22 rdomain ""$/;
  for (const l of all) assert.match(l, ident);
  assert.ok(auth.some((l) => /Connection closed by 10\.10\.10\.5 port \d+ \[preauth\]$/.test(l)), 'a scan that hangs up is logged as closed');
});

test('live log: ftp connections reach vsftpd.log', async () => {
  const sim = await boot();
  const K = sim.K;
  K.net.tcp(sim.machine, '10.10.10.20', 21);
  const log = lines(logOf(sim, 'files01', '/var/log/vsftpd.log'));
  assert.match(log[log.length - 1], /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d 2026 \[pid \d+\] CONNECT: Client "10\.10\.10\.5"$/);
});

test('a second K.boot() leaves exactly one set of subscriptions', async () => {
  const sim = await boot();
  const K = sim.K;
  await K.boot({ term: new K.HeadlessTerm() });
  const web = K.net.machineFor('web01');
  const before = lines(web.vfs.read('/var/log/nginx/access.log')).length;
  K.net.http(K.kali, { method: 'GET', url: 'http://web01.halcyon.lab/once' });
  const rows = lines(web.vfs.read('/var/log/nginx/access.log'));
  assert.equal(rows.length - before, 1);
  assert.equal(rows.filter((l) => l.includes('GET /once ')).length, 1);
  K.net.tcp(K.kali, '10.10.10.20', 22);
  const files = K.net.machineFor('files01');
  const conns = lines(files.vfs.read('/var/log/auth.log')).filter((l) => /Connection from 10\.10\.10\.5 port/.test(l));
  assert.equal(conns.length, 1);
});

test('everything is fictional and adds no secrets', async () => {
  const sim = await boot();
  const K = sim.K;
  const src = (await import('node:fs')).readFileSync(new URL('../src/js/45-world-content.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\beval\(|new Function|XMLHttpRequest|\bdocument\.|\bwindow\./);
  const textFiles = (fs, dir, out = []) => {
    for (const name of fs.readdir(dir)) {
      const p = (dir === '/' ? '' : dir) + '/' + name;
      const st = fs.lstat(p);
      if (st.isDir) textFiles(fs, p, out); else if (st.isFile) out.push(p);
    }
    return out;
  };
  for (const id of ['web01', 'files01', 'db01', 'dev01']) {
    const fs = K.net.machineFor(id).vfs;
    for (const dir of ['/home/student', '/srv', '/var/www', '/etc/nginx', '/etc/mysql', '/etc/samba']) {
      if (!fs.exists(dir)) continue;
      for (const f of textFiles(fs, dir)) {
        const text = fs.read(f);
        assert.doesNotMatch(text, /BEGIN [A-Z ]*PRIVATE KEY/, f);
        assert.doesNotMatch(text, /\$[156y]\$[^\s$]*\$[^\s:]{20,}/, f + ' looks like a password hash');
        assert.doesNotMatch(text, /(password|passwd|secret|token)\s*=\s*\S+|"(password|secret|token)"\s*:/i, f + ' carries a credential');
      }
    }
  }
  // public text refers only to reserved example domains
  const site = http(sim, 'http://halcyonfreight.example/contact').body;
  const domains = site.match(/@[a-z0-9.-]+/g) || [];
  assert.ok(domains.length > 0);
  for (const d of domains) assert.match(d, /@halcyonfreight\.example$/);
  assert.doesNotMatch(K.net.machineFor('web01').vfs.read('/var/www/html/staff/index.html'), /password/i);
  // the pack grants no extra logins: only the engagement's test account
  for (const id of ['web01', 'files01', 'db01', 'dev01']) {
    const names = K.net.hostById(id).shell.users.map((u) => u.name);
    assert.deepEqual(names, ['student']);
  }
});
