/* Kalima — curriculum module "web": HTTP from the command line.
 *
 * Lessons: web-curl, web-headers, web-tls, web-transfer. They use the intranet
 * on web01 (10.10.10.10, nginx, http and https with a self-signed certificate),
 * the SSH and SMTP banners of web01 and mail01, and a python3 web server that
 * the learner starts and stops on the Kali machine. Work goes under
 * ~/practice/web/. Checks test what a line printed or the state it left behind.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const HOME = '/home/kali';
  const WEB = HOME + '/practice/web';
  const fileState = (path) => { try { return K.kali.vfs.read(path); } catch (e) { return null; } };

  /* -------------------------------------------------------------- web-curl */
  const curlLesson = {
    id: 'web-curl',
    title: 'Talking to a web server with curl',
    minutes: 10,
    objectives: [
      'Fetch a page, show only its headers, and save it to a file with `curl`',
      'Read the status code of a response and say what 200, 301, 403 and 404 mean',
      'Follow a redirect on purpose with `-L`',
    ],
    intro: T(
      'A web browser hides almost everything that happens between you and a server. `curl` hides nothing: it sends one request and prints what comes back, so you can see the status code, the headers and the page exactly as the server sent them.',
      '',
      'On a security workstation you use it to check whether a service is up, to read what a server says about itself, and to save evidence you can attach to your notes. In this lesson you will talk to the intranet on web01, a server in your lab scope.'
    ),
    steps: [
      {
        id: 'fetch',
        prompt: T(
          'The intranet web server is `web01.halcyon.lab`. Ask it for its home page:',
          '',
          '```',
          'curl http://web01.halcyon.lab/',
          '```',
          '',
          '`curl` is the program, and `http://web01.halcyon.lab/` is the URL: the scheme (`http`), the server name and the path (`/`, the top of the site). With no other options, `curl` sends a `GET` request and prints the body of the reply. A browser would draw this HTML as a page. Here you see the source.'
        ),
        hint: 'Type `curl` followed by the full URL, starting with `http://`.',
        solution: 'curl http://web01.halcyon.lab/',
        check: { cmd: 'curl', argsRe: /web01\.halcyon\.lab|10\.10\.10\.10/, out: /<title>Halcyon Freight Intranet<\/title>/ },
      },
      {
        id: 'title',
        prompt: 'Look near the top of the output for the `<title>` element. This is the text a browser shows on the tab. What is the title of the page?',
        hint: 'Find the line that starts with `<title>` and type the text between the tags.',
        solution: 'Halcyon Freight Intranet',
        answer: /^halcyon freight intranet$/i,
      },
      {
        id: 'head',
        prompt: T(
          'A reply has two parts: headers, then the body. To see only the headers, ask for them with `-I` (capital i). `curl` then sends a `HEAD` request, which tells the server to answer without the body:',
          '',
          '```',
          'curl -I http://web01.halcyon.lab/',
          '```',
          '',
          'The first line is the *status line*: the protocol version, a three-digit status code and its reason phrase. The lines after it are headers, each in the form `Name: value`.'
        ),
        hint: 'The option is `-I`, with a capital letter. A lowercase `-i` does something different, which you will meet shortly.',
        solution: 'curl -I http://web01.halcyon.lab/',
        check: { cmd: 'curl', args: ['-I'], argsRe: /web01\.halcyon\.lab|10\.10\.10\.10/, out: /^HTTP\/1\.1 200 OK/m },
      },
      {
        id: 'length',
        prompt: 'Read the headers. The `Content-Length` header says how many bytes the body has. How long is the home page?',
        hint: 'Look for the line that begins with `Content-Length:`. The value is a number of bytes.',
        solution: '1495',
        answer: /^1495( bytes)?$/,
      },
      {
        id: 'save',
        prompt: T(
          'Printing a page is fine for reading, but evidence belongs in a file. Two options help:',
          '',
          '- `-s` (silent) hides the progress meter and error messages.',
          '- `-o file` writes the body to `file` instead of the terminal.',
          '',
          'Create your working folder and save the home page as `intranet.html` in it:',
          '',
          '```',
          'mkdir -p ~/practice/web',
          'curl -s -o ~/practice/web/intranet.html http://web01.halcyon.lab/',
          '```',
          '',
          'Run the two commands on one line with `&&` between them if you like. Afterwards `ls -l ~/practice/web/intranet.html` shows a file of 1495 bytes, the same number as the `Content-Length` you just read.'
        ),
        hint: 'Create the directory with `mkdir -p`, then use `curl -s -o` with the file name before the URL.',
        solution: 'mkdir -p ~/practice/web && curl -s -o ~/practice/web/intranet.html http://web01.halcyon.lab/',
        check: { cmd: 'curl', file: { path: WEB + '/intranet.html', exists: true, type: 'file', contains: /Halcyon Freight Intranet/ } },
      },
      {
        id: 'forbidden',
        prompt: T(
          'Now look at a page the server will not give you. Request `/backup/` and show the headers together with the body, using `-i` (lowercase) instead of `-I`:',
          '',
          '```',
          'curl -i http://web01.halcyon.lab/backup/',
          '```',
          '',
          'Status codes are grouped by their first digit: 2xx means success, 3xx a redirect, 4xx a problem with the request, 5xx a problem on the server. This one is `403 Forbidden`: the server understood the request and refuses to answer it. A path that answers 403 instead of 404 is worth a line in your notes, because it shows that the server has a rule about it.'
        ),
        hint: 'Use `curl -i` and put `/backup/` after the host name in the URL.',
        solution: 'curl -i http://web01.halcyon.lab/backup/',
        check: { cmd: 'curl', args: ['-i'], argsRe: /\/backup\//, out: /^HTTP\/1\.1 403 Forbidden/m },
      },
      {
        id: 'missing',
        prompt: T(
          'To check only a status code, ask `curl` to print just that. The option `-w` (write-out) prints a formatted line after the transfer, and `%{http_code}` is the variable that holds the status. Combine it with `-o /dev/null` to throw the body away:',
          '',
          '```',
          'curl -s -o /dev/null -w \'%{http_code}\\n\' http://web01.halcyon.lab/missing-page',
          '```',
          '',
          'Run it on a page that does not exist. You should see `404`, which means the server found nothing at that path. Compare that with the 403 you just saw: 404 says "nothing here", 403 says "not for you".'
        ),
        hint: 'Quote the `-w` format so the shell leaves `%{http_code}` alone, and send the body to `/dev/null` with `-o`.',
        solution: 'curl -s -o /dev/null -w \'%{http_code}\\n\' http://web01.halcyon.lab/missing-page',
        check: { cmd: 'curl', args: ['-w'], out: /^404\s*$/m },
      },
      {
        id: 'redirect',
        prompt: T(
          'A 3xx status tells the client to look somewhere else. Ask for `/docs`, without a trailing slash, and show only the headers:',
          '',
          '```',
          'curl -I http://web01.halcyon.lab/docs',
          '```',
          '',
          'The status is `301 Moved Permanently`, and the `Location` header gives the new address: `/docs/` with a slash. `curl` does not follow it by itself.'
        ),
        hint: 'Use `curl -I` with the URL `http://web01.halcyon.lab/docs`, with no slash at the end.',
        solution: 'curl -I http://web01.halcyon.lab/docs',
        check: { cmd: 'curl', args: ['-I'], argsRe: /\/docs(\s|$)/, out: /^HTTP\/1\.1 301 /m },
      },
      {
        id: 'follow',
        prompt: T(
          'To follow redirects, add `-L` (location). Repeat the request with `-L` and with `-I` so you see the headers of every response in the chain:',
          '',
          '```',
          'curl -L -I http://web01.halcyon.lab/docs',
          '```',
          '',
          'You should see two status lines: the 301 first, then the 200 from `/docs/`. Following redirects is convenient, but it also means `curl` may end up on a server you did not name. In scope-limited work, check where a redirect leads before you follow it.'
        ),
        hint: 'Add `-L` to the command from the last step.',
        solution: 'curl -L -I http://web01.halcyon.lab/docs',
        check: { cmd: 'curl', args: ['-L'], out: /HTTP\/1\.1 301[\s\S]*HTTP\/1\.1 200 OK/ },
      },
    ],
    quiz: [
      {
        q: 'You run `curl -I http://web01.halcyon.lab/` and the first line is `HTTP/1.1 200 OK`. What does that tell you?',
        choices: [
          'The server is up and returned the page successfully',
          'The server redirected you to another address',
          'The page does not exist',
          'The server refused the request',
        ],
        answer: 0,
        why: '200 is the success code. A redirect is 3xx, a missing page is 404, and a refusal is 403.',
      },
      {
        q: 'What is the difference between a 403 and a 404 response?',
        choices: [
          'A 403 is a server fault and a 404 is a client fault',
          'A 403 means the server refuses to serve the path, and a 404 means it found nothing there',
          'They are the same, and servers pick one at random',
          'A 403 means the page moved and a 404 means it was deleted',
        ],
        answer: 1,
        why: 'Both are 4xx client-side codes, but 403 is a deliberate refusal while 404 says nothing was found. A moved page is a 3xx redirect.',
      },
      {
        q: 'You run `curl -s -o page.html http://web01.halcyon.lab/` and nothing appears on the screen. What happened?',
        choices: [
          'The request failed silently',
          'The server sent an empty page',
          'The body was written to page.html, and `-s` hid the progress meter',
          'curl is waiting for you to press Enter',
        ],
        answer: 2,
        why: '`-o` sends the body to a file, so the terminal stays quiet, and `-s` removes the progress display. Check the file with `ls -l` or `cat`.',
      },
      {
        q: 'You request a URL that answers `301` with a `Location` header. What does `curl -L` change?',
        choices: [
          'It lists every redirect on the server',
          'It repeats the request until the server answers 200',
          'It follows the Location header and makes a second request to the new address',
          'It saves the redirect to a file',
        ],
        answer: 2,
        why: 'Without `-L`, curl stops at the 301 and shows it to you. With `-L` it sends the next request to the address in `Location`.',
      },
    ],
    refs: ['curl(1)', 'RFC 9110 (HTTP Semantics), section 15 (status codes)'],
  };

  /* ----------------------------------------------------------- web-headers */
  const headersLesson = {
    id: 'web-headers',
    title: 'Anatomy of a request and a response',
    minutes: 10,
    objectives: [
      'Read a request and a response side by side with `curl -v`',
      'Say what the Host, User-Agent and Server headers carry, and what the Server header gives away',
      'Find the files a site publishes for crawlers, `robots.txt` and `sitemap.xml`, and say what they are and are not',
    ],
    intro: T(
      'HTTP is a text conversation. The client sends a request line and some headers, and the server answers with a status line, headers and a body. Once you can read both sides, a lot of web troubleshooting and reconnaissance becomes plain reading.',
      '',
      'Headers also leak. A server that announces its exact software version has told every visitor which software to look up. In this lesson you will watch a whole exchange with `curl -v` and then read two public files that sites publish for search engines. Reading them sends ordinary requests to a server in your scope.'
    ),
    steps: [
      {
        id: 'verbose',
        prompt: T(
          'Add `-v` (verbose) to see the whole exchange, not only the reply:',
          '',
          '```',
          'curl -v http://web01.halcyon.lab/status',
          '```',
          '',
          'Lines are marked by their first character:',
          '',
          '- `*` is `curl` talking about itself: the name lookup and the connection.',
          '- `>` is what `curl` sent. The first `>` line is the *request line*: method, path and protocol version.',
          '- `<` is what the server sent back. The first `<` line is the status line.',
          '',
          'The body, a small JSON status message, appears at the end without a marker.'
        ),
        hint: 'Use `curl -v` followed by the URL `http://web01.halcyon.lab/status`.',
        solution: 'curl -v http://web01.halcyon.lab/status',
        check: { cmd: 'curl', args: ['-v'], out: /> GET \/status HTTP\/1\.1[\s\S]*< HTTP\/1\.1 200 OK/ },
      },
      {
        id: 'host',
        prompt: T(
          'Look at the request headers, the lines after the request line that start with `>`. One of them tells the server which site you want. That matters because one server and one address can host many sites.',
          '',
          'What is the name of that header?'
        ),
        hint: 'The header whose value is `web01.halcyon.lab`.',
        solution: 'Host',
        answer: /^host( header)?$/i,
      },
      {
        id: 'useragent',
        prompt: T(
          'The `User-Agent` header says which program is asking. `curl` announces itself by name and version. Any client can put anything there, so servers cannot trust it, but they do log it.',
          '',
          'During an assessment that makes it useful to be honest. Send your own label with `-A` and watch it appear in the request:',
          '',
          '```',
          'curl -v -A \'kalima-lab/1.0\' http://web01.halcyon.lab/status',
          '```',
          '',
          'Someone reading the web01 access log can now tell your requests from everyone else\'s.'
        ),
        hint: 'Use `-A` followed by a quoted label, together with `-v`.',
        solution: 'curl -v -A \'kalima-lab/1.0\' http://web01.halcyon.lab/status',
        check: { cmd: 'curl', args: ['-A'], out: /> User-Agent: \S+/, not: { out: /> User-Agent: curl\// } },
      },
      {
        id: 'server-grep',
        prompt: T(
          'Now the response side. The `Server` header names the software that answered. Print only that line, by sending the headers through `grep`:',
          '',
          '```',
          'curl -sI http://web01.halcyon.lab/ | grep -i \'^server\'',
          '```',
          '',
          'The `-i` in `grep` ignores case, because header names may be written in any case.'
        ),
        hint: 'Combine `curl -sI` and `grep -i server` with a pipe.',
        solution: 'curl -sI http://web01.halcyon.lab/ | grep -i \'^server\'',
        check: { cmd: 'curl', args: ['-I'], out: /^Server: nginx/m, not: { out: /^HTTP\/1\.1|^Date:/m } },
      },
      {
        id: 'server-read',
        prompt: T(
          'Which software and which version does web01 announce?',
          '',
          'That is more than the visitor needs. Anyone can now look up the release notes and known problems of that exact version. Administrators often switch the version off, so the header says only `nginx`. Either way, the header is something a client is told, not proof, so treat it as a lead to confirm.'
        ),
        hint: 'Read the value of the `Server` header from the last step, name and number together.',
        solution: 'nginx/1.26.3',
        answer: /^nginx( ?\/ ?|\s+)1\.26\.3$/i,
      },
      {
        id: 'robots',
        prompt: T(
          'Sites publish two files for automated visitors, and both live at fixed paths. The first is `robots.txt`, which asks search-engine crawlers to stay out of certain paths. Fetch it:',
          '',
          '```',
          'curl -s http://web01.halcyon.lab/robots.txt',
          '```',
          '',
          'Each `Disallow` line is a request, not a lock. A well-behaved crawler obeys it, and anyone else can read the same file. A `robots.txt` that lists sensitive paths therefore advertises them. Access to a path has to be enforced by the server, with a login or a rule, not by a polite note.'
        ),
        hint: 'The file is at `/robots.txt` on the same server. Add `-s` to keep the output clean.',
        solution: 'curl -s http://web01.halcyon.lab/robots.txt',
        check: { cmd: 'curl', argsRe: /robots\.txt/, out: /Disallow: \/backup\// },
      },
      {
        id: 'robots-read',
        prompt: 'The file lists two paths that the owner would rather keep out of search results. Type both paths.',
        hint: 'Read the two `Disallow:` lines. Each path starts and ends with a slash.',
        solution: '/staff/ /backup/',
        answer: /^(\/?staff\/?[ ,;and&]+\/?backup\/?|\/?backup\/?[ ,;and&]+\/?staff\/?)$/i,
      },
      {
        id: 'sitemap',
        prompt: T(
          'The second file is `sitemap.xml`, the opposite of `robots.txt`: a list of the pages the owner *wants* indexed. Fetch it:',
          '',
          '```',
          'curl -s http://web01.halcyon.lab/sitemap.xml',
          '```',
          '',
          'Each `<loc>` element is one address. Notice that the addresses use `www.halcyon.lab`, another name for web01. Both files are public by design. Reading them is ordinary browsing, and they are a quick way to learn how a site is laid out. Note what you found in `~/engagement/notes.md` when it matters for your report.'
        ),
        hint: 'Same pattern as the last step, with the path `/sitemap.xml`.',
        solution: 'curl -s http://web01.halcyon.lab/sitemap.xml',
        check: { cmd: 'curl', argsRe: /sitemap\.xml/, out: /<urlset[\s\S]*<loc>/ },
      },
    ],
    quiz: [
      {
        q: 'In `curl -v` output, which lines show what curl sent to the server?',
        choices: [
          'Lines that start with `*`',
          'Lines that start with `<`',
          'Lines that start with `>`',
          'Lines that start with `HTTP`',
        ],
        answer: 2,
        why: '`>` marks the request curl sent, `<` marks the response received, and `*` marks curl\'s own notes about the connection.',
      },
      {
        q: 'Why does a request need a `Host` header when it is already being sent to a specific IP address?',
        choices: [
          'Because the address might change during the request',
          'Because one server can host many sites on one address, and the header says which one you want',
          'Because the header encrypts the request',
          'Because curl would otherwise refuse to send it',
        ],
        answer: 1,
        why: 'Name-based virtual hosting puts many sites behind one address. The server chooses a site by the Host header.',
      },
      {
        q: 'A `robots.txt` file contains `Disallow: /backup/`. What does that actually do?',
        choices: [
          'It blocks every visitor from the path',
          'It asks well-behaved crawlers not to index the path, and it also tells anyone who reads it that the path exists',
          'It deletes the path from the server',
          'It encrypts the contents of the path',
        ],
        answer: 1,
        why: 'The file is a request that crawlers may honor. It enforces nothing, and because it is public it can point readers to the paths it lists.',
      },
      {
        q: 'What is a sensible way to treat a `Server: nginx/1.26.3` header in your notes?',
        choices: [
          'As proof that the server has no known weaknesses',
          'As an observation of what the server announces, to confirm by other means before you rely on it',
          'As an error that you must fix on your own workstation',
          'As a password',
        ],
        answer: 1,
        why: 'A banner is what the server chooses to say. It is a useful lead, and a header can be changed or misleading, so confirm before you report it as fact.',
      },
    ],
    refs: ['curl(1)', 'RFC 9110 (HTTP Semantics), sections 7.2, 10.1.5 and 10.2.4', 'RFC 9309 (Robots Exclusion Protocol)', 'sitemaps.org protocol'],
  };

  /* --------------------------------------------------------------- web-tls */
  const tlsLesson = {
    id: 'web-tls',
    title: 'HTTPS and certificate errors',
    minutes: 9,
    objectives: [
      'Explain what a certificate verification error means and read the reason `curl` gives',
      'Inspect the certificate details a server presents with `curl -v`',
      'Use `-k` as a deliberate, recorded exception in a lab, and say why it is not a habit for the internet',
    ],
    intro: T(
      'HTTPS is HTTP inside an encrypted channel, and it does two jobs. It hides the traffic from anyone on the path, and it lets the client check that it reached the server it asked for. The second job is done with certificates, and it is the one people skip when a certificate error gets in the way.',
      '',
      'The lab web server offers HTTPS on port 443 with a certificate that your workstation does not trust. That is a safe place to learn what the error says, what the override does, and what you give up when you use it.'
    ),
    steps: [
      {
        id: 'fail',
        prompt: T(
          'Plain HTTP uses port 80. HTTPS uses port 443, and `curl` picks it from the `https://` scheme. Try the intranet over HTTPS:',
          '',
          '```',
          'curl https://web01.halcyon.lab/status',
          '```',
          '',
          'It fails. No page is printed, only an error, and that is the right behavior. Read the message before you do anything about it.'
        ),
        hint: 'Type `curl` followed by the `https://` URL for `/status`.',
        solution: 'curl https://web01.halcyon.lab/status',
        check: { cmd: 'curl', argsRe: /^https:\/\//, out: /SSL certificate problem/ },
      },
      {
        id: 'errno',
        prompt: 'The error starts with `curl:` and a number in parentheses. `curl` documents every exit code, and that number is the exit code. Which number is it?',
        hint: 'Look at the first line of the error, `curl: (NN) SSL certificate problem`.',
        solution: '60',
        answer: /^(60|\(60\)|curl: \(60\))$/,
      },
      {
        id: 'reason',
        prompt: T(
          'After `SSL certificate problem:` comes the reason. Type the two words that name the problem.',
          '',
          'The server did present a certificate. `curl` could not trace it back to an authority that the workstation trusts, so it refused to continue. A certificate that nobody trusted vouches only for itself, and anyone can make one.'
        ),
        hint: 'The words are hyphenated: the certificate signed itself.',
        solution: 'self-signed certificate',
        answer: /^self[- ]signed( certificate)?$/i,
      },
      {
        id: 'inspect',
        prompt: T(
          'You can look at the certificate without trusting it. With `-v` and `-k` (more on `-k` in a moment) the handshake details are printed. Filter them for the lines you need:',
          '',
          '```',
          'curl -vk https://web01.halcyon.lab/status 2>&1 | grep -E \'subject|expire date|verify result\'',
          '```',
          '',
          '`2>&1` sends error output, where `-v` writes, into the pipe so `grep` sees it. The `subject` line says whom the certificate was issued to, here `web01.halcyon.lab`. The `expire date` line says when it stops being valid. The `verify result` line is the verdict that `curl` would have enforced without `-k`.'
        ),
        hint: 'Use `curl -vk`, the HTTPS URL, then `2>&1 | grep -E` with the three words separated by `|`.',
        solution: 'curl -vk https://web01.halcyon.lab/status 2>&1 | grep -E \'subject|expire date|verify result\'',
        check: { cmd: 'curl', args: ['-k'], out: /subject: CN=web01\.halcyon\.lab[\s\S]*expire date:[\s\S]*verify result/, not: { out: /Trying 10\.10\.10\.10|TLSv1\.3 \(/ } },
      },
      {
        id: 'expiry',
        prompt: 'On which date does the certificate expire? Type the month, day and year in any common form, for example `Dec 5 2026`.',
        hint: 'Read the `expire date` line from the last step.',
        solution: 'Nov 30 2026',
        answer: /^(nov(ember)?\.? 30,? 2026|30 nov(ember)?,? 2026|2026-11-30)$/i,
      },
      {
        id: 'insecure',
        prompt: T(
          'The option `-k` (long form `--insecure`) tells `curl` to carry on when verification fails. The traffic is still encrypted. What you give up is the check of *who* is on the other end, so anyone able to intercept the connection could present their own certificate and `curl -k` would accept it.',
          '',
          'Inside this lab that is an understood exception: you know the host, it is in scope, and the network is yours. Use it knowingly:',
          '',
          '```',
          'curl -k https://web01.halcyon.lab/status',
          '```',
          '',
          'On the internet, and with anything secret, the answer to a certificate error is to find out why. The proper fix is to trust the lab authority\'s certificate with `--cacert file`, or to have the server given a certificate your workstation trusts. Never put `-k` into a script you will reuse.'
        ),
        hint: 'Repeat the plain `curl` command from the first step and add `-k`.',
        solution: 'curl -k https://web01.halcyon.lab/status',
        check: { cmd: 'curl', args: ['-k'], out: /"status":"ok"/ },
      },
      {
        id: 'note',
        prompt: T(
          'An exception you do not write down will be forgotten. Add a line to your engagement notes saying what you did and why, using `echo` and `>>` to append:',
          '',
          '```',
          'echo "web01 https: self-signed lab certificate, used curl -k deliberately (lab network, in scope)" >> ~/engagement/notes.md',
          '```',
          '',
          'Use your own wording if you like, but name the host, the self-signed certificate and the use of `-k`. Then `tail -3 ~/engagement/notes.md` shows the line at the end of the file.'
        ),
        hint: 'Append with `>>` so you do not overwrite the notes. Mention web01 and the self-signed certificate in the text.',
        solution: 'echo "web01 https: self-signed lab certificate, used curl -k deliberately (lab network, in scope)" >> ~/engagement/notes.md',
        check: { file: { path: HOME + '/engagement/notes.md', contains: /web01[^\n]*self-signed|self-signed[^\n]*web01/i } },
      },
    ],
    quiz: [
      {
        q: 'What does `curl: (60) SSL certificate problem: self-signed certificate` tell you?',
        choices: [
          'The server is down',
          'The server presented a certificate that does not chain to an authority your workstation trusts',
          'Your password was wrong',
          'The connection was not encrypted',
        ],
        answer: 1,
        why: 'The connection reached the server and the handshake began. Verification failed because the certificate could not be tied to a trusted authority.',
      },
      {
        q: 'You run `curl -k https://web01.halcyon.lab/`. Which statement is true?',
        choices: [
          'The traffic is sent unencrypted',
          'The traffic is still encrypted, but curl no longer verifies the server\'s identity',
          'The server is now trusted by your whole workstation',
          'curl checks the certificate twice as carefully',
        ],
        answer: 1,
        why: '`-k` skips verification only. Encryption still happens, but you no longer know who holds the other end.',
      },
      {
        q: 'Why is `-k` acceptable here and a bad habit on the internet?',
        choices: [
          'In the lab you know the host and control the network, so an impostor is not a realistic risk; on the internet you do not',
          'It runs faster in a lab',
          'Internet servers reject requests that use `-k`',
          'It is not acceptable in the lab either, since it should never be used',
        ],
        answer: 0,
        why: 'The risk is that someone else answers in the server\'s place. On a network you control that risk is small and known, and you record the exception. On the internet it is not.',
      },
      {
        q: 'What is the right long-term fix for a lab server whose certificate is signed by your own authority?',
        choices: [
          'Add `-k` to every command',
          'Disable HTTPS and use plain HTTP',
          'Give curl the authority\'s certificate with `--cacert`, or install it as trusted on the workstation',
          'Ignore the error message',
        ],
        answer: 2,
        why: 'Trusting the authority that signed the certificate restores verification, so the check keeps working and the error disappears for the right reason.',
      },
    ],
    refs: ['curl(1)', 'RFC 8446 (TLS 1.3)', 'RFC 5280 (X.509 certificates)'],
  };

  /* ----------------------------------------------------------- web-transfer */
  const transferLesson = {
    id: 'web-transfer',
    title: 'Moving files and speaking protocols by hand',
    minutes: 12,
    objectives: [
      'Download a file with `curl -O` and with `wget`',
      'Share a directory over HTTP with `python3 -m http.server`, fetch from it, and stop it',
      'Read the greeting of an SSH and an SMTP server with `nc` and explain why protocols that are plain text can be spoken by hand',
    ],
    intro: T(
      'Moving files between machines is routine work: tool output to your notes, a script from a lab server, evidence to a teammate. Three small tools cover most of it. `curl` and `wget` download, and Python can serve a folder over HTTP in one command.',
      '',
      'The last part shows why all of this works. Many network protocols are lines of text, so with `nc` (netcat) you can connect to a service and read what it says, the same words a mail program or SSH client sees first. Only connect to hosts that are in your scope. Everything here is in the lab.'
    ),
    steps: [
      {
        id: 'dirs',
        prompt: T(
          'Make a folder for downloads and one for sharing, then move into the download folder:',
          '',
          '```',
          'mkdir -p ~/practice/web/downloads ~/practice/web/share',
          'cd ~/practice/web/downloads',
          '```',
          '',
          'Keeping fetched files in one place makes them easy to find, list and delete when the work is done. You can type both commands on one line, joined with `&&`.'
        ),
        hint: '`mkdir -p` accepts several directory names at once. Then use `cd`.',
        solution: 'mkdir -p ~/practice/web/downloads ~/practice/web/share && cd ~/practice/web/downloads',
        check: { cwd: WEB + '/downloads', file: { path: WEB + '/share', exists: true, type: 'dir' } },
      },
      {
        id: 'curl-o',
        prompt: T(
          'Earlier you chose a file name with `-o`. The option `-O` (capital letter) saves the file under the name it has on the server. Download the intranet\'s `robots.txt` into the current folder:',
          '',
          '```',
          'curl -O http://web01.halcyon.lab/robots.txt',
          '```',
          '',
          'Because the output goes to a file, `curl` draws a progress table instead of printing the content. Check the result with `ls -l` and `cat robots.txt`.'
        ),
        hint: 'Use a capital `-O`, followed by the URL that ends in `robots.txt`.',
        solution: 'curl -O http://web01.halcyon.lab/robots.txt',
        check: { cmd: 'curl', args: ['-O'], file: { path: WEB + '/downloads/robots.txt', exists: true, type: 'file', contains: /Disallow/ } },
      },
      {
        id: 'wget',
        prompt: T(
          '`wget` is the other common downloader. Its default is to save to a file named after the URL, and it prints a short report about the transfer. Download the sitemap:',
          '',
          '```',
          'wget http://web01.halcyon.lab/sitemap.xml',
          '```',
          '',
          'Look at the report. `Resolving` shows the name lookup, `Connecting` the connection, `200 OK` the status, and `Saving to` the file name. Pick `wget` for downloading several files or a whole directory tree, and `curl` when you want control over the request itself, such as headers and methods.'
        ),
        hint: 'Type `wget` followed by the URL. No options are needed.',
        solution: 'wget http://web01.halcyon.lab/sitemap.xml',
        check: { cmd: 'wget', out: /200 OK/, file: { path: WEB + '/downloads/sitemap.xml', exists: true, type: 'file', contains: /<urlset/ } },
      },
      {
        id: 'make-share',
        prompt: T(
          'Now the other direction. Python includes a small web server that publishes the current directory. Put a file in the sharing folder first:',
          '',
          '```',
          'cd ~/practice/web/share',
          'echo "shared by kali" > note.txt',
          '```'
        ),
        hint: 'Change into the `share` folder, then redirect the output of `echo` into `note.txt`.',
        solution: 'cd ~/practice/web/share && echo "shared by kali" > note.txt',
        check: { cwd: WEB + '/share', file: { path: WEB + '/share/note.txt', exists: true, contains: /shared by kali/ } },
      },
      {
        id: 'serve',
        prompt: T(
          'Start the server on port 8000 and put it in the background with `&`, so you keep the prompt:',
          '',
          '```',
          'python3 -m http.server 8000 &',
          '```',
          '',
          '`-m http.server` runs the standard-library module as a program. The shell prints a job number such as `[1]` and a process id. From now on the server prints one log line for each request it receives, and those lines may appear between your commands.',
          '',
          'The server has no login and publishes every file in the folder it was started in, to everyone who can reach the port. Use it only for the files you mean to share, and stop it when you are finished.'
        ),
        hint: 'Run the module with `python3 -m http.server 8000`, and end the line with `&`.',
        solution: 'python3 -m http.server 8000 &',
        check: { line: /python3\s+(-\w+\s+)*-m\s+http\.server\b.*&\s*$/, out: /^\[\d+\] \d+/m },
      },
      {
        id: 'fetch-local',
        prompt: T(
          'Fetch the file from your own server. The address is `localhost`, which always means this machine, and the port goes after a colon:',
          '',
          '```',
          'curl http://localhost:8000/note.txt',
          '```',
          '',
          'You should see the text you wrote. A request line from the server, such as `GET /note.txt HTTP/1.1" 200`, may print next to it. That is the same status code you read in the first lesson of this module. Fetching `http://localhost:8000/` alone returns a directory listing.'
        ),
        hint: 'Use `curl` with the URL `http://localhost:8000/note.txt`.',
        solution: 'curl http://localhost:8000/note.txt',
        check: { cmd: 'curl', argsRe: /localhost:8000|127\.0\.0\.1:8000/, out: /shared by kali/ },
      },
      {
        id: 'stop',
        prompt: T(
          'Stop the server. `jobs` lists the background jobs of this shell, and `kill %1` ends job number 1. Use the number that `jobs` shows for your server. The special variable `$!` always holds the process id of the most recent background job, so this also works right after you started it:',
          '',
          '```',
          'jobs',
          'kill %1',
          '```'
        ),
        hint: 'Run `jobs` to find the number, then `kill %N`. As an alternative, `kill $!` stops the most recent background job.',
        solution: 'kill $!',
        check: { cmd: 'kill', exit: 0 },
      },
      {
        id: 'confirm',
        prompt: T(
          'Confirm that the server is gone. Ask for the file again. This time the connection should be refused, because nothing is listening on port 8000:',
          '',
          '```',
          'curl http://localhost:8000/note.txt',
          '```',
          '',
          '`curl` exits with status 7, "failed to connect". Checking that a service you started has really stopped is part of cleaning up after yourself.'
        ),
        hint: 'Repeat the command from the earlier step.',
        solution: 'curl http://localhost:8000/note.txt',
        check: { cmd: 'curl', argsRe: /localhost:8000|127\.0\.0\.1:8000/, exit: 7 },
      },
      {
        id: 'nc-ssh',
        prompt: T(
          'HTTP is text, and so are many other protocols. `nc` (netcat) opens a TCP connection and connects it to your terminal. Connect to the SSH port of web01 and send nothing:',
          '',
          '```',
          'nc -w 3 10.10.10.10 22 < /dev/null',
          '```',
          '',
          '`-w 3` gives up after three seconds, and `< /dev/null` sends an empty input. The server speaks first. Its one line, `SSH-2.0-OpenSSH_...`, is the SSH *banner*: the protocol version, then the software name and version. The same line is what scanners record when they identify a service.'
        ),
        hint: 'Give `nc` the address and the port number 22, and send it nothing with `< /dev/null`.',
        solution: 'nc -w 3 10.10.10.10 22 < /dev/null',
        check: { cmd: 'nc', args: ['22'], out: /^SSH-2\.0-OpenSSH/m },
      },
      {
        id: 'nc-smtp',
        prompt: T(
          'Mail is text as well. The mail server `mail01` accepts mail on port 25 with SMTP. Send two commands, a greeting and a quit, through a pipe from `printf`. The `\\r\\n` at the end of each line is the line ending that SMTP expects:',
          '',
          '```',
          'printf \'HELO kali.lab\\r\\nQUIT\\r\\n\' | nc -w 3 mail01.halcyon.lab 25',
          '```',
          '',
          'Each line of the reply starts with a three-digit code. `220` is the greeting, `250` means a command was accepted, and `221` means the server is closing the connection. These are the same kinds of numbers you saw in HTTP, because many text protocols were designed this way. You sent no mail: `HELO` only introduces you and `QUIT` ends the session.'
        ),
        hint: 'Pipe `printf` into `nc -w 3`, with the host name `mail01.halcyon.lab` and port 25.',
        solution: 'printf \'HELO kali.lab\\r\\nQUIT\\r\\n\' | nc -w 3 mail01.halcyon.lab 25',
        check: { cmd: 'nc', args: ['25'], out: /^220 mail01\.halcyon\.lab[\s\S]*^221 /m },
      },
    ],
    quiz: [
      {
        q: 'You run `curl -O http://web01.halcyon.lab/robots.txt`. Where does the content go?',
        choices: [
          'To the terminal',
          'Into a file named robots.txt in the current directory',
          'Into a file named index.html',
          'Nowhere, because `-O` discards the body',
        ],
        answer: 1,
        why: 'Capital `-O` saves the body under the file name taken from the URL. Lowercase `-o` lets you pick the name yourself.',
      },
      {
        q: 'You start `python3 -m http.server 8000 &` in your home directory and leave it running. What is the risk?',
        choices: [
          'None, because it only serves files you have chosen',
          'It serves the whole directory, with no login, to anyone who can reach port 8000',
          'It deletes files as they are downloaded',
          'It stops by itself after one request',
        ],
        answer: 1,
        why: 'The server publishes everything under the directory it was started in and has no authentication. Start it in a dedicated folder and stop it when done.',
      },
      {
        q: 'After `kill %1`, what does `curl http://localhost:8000/` do, and why?',
        choices: [
          'It still returns the directory listing from memory',
          'It fails with a connection error, because nothing is listening on the port',
          'It returns a 404 status',
          'It starts the server again',
        ],
        answer: 1,
        why: 'Once the process ends, the port is closed and connection attempts are refused, so curl exits with status 7.',
      },
      {
        q: 'Why can you read the banner of an SSH or SMTP server with just `nc`?',
        choices: [
          'Because nc contains a copy of the SSH and SMTP software',
          'Because these protocols send plain text lines, so a raw connection is enough to see and type them',
          'Because nc decrypts the traffic',
          'Because the servers send their banners only to nc',
        ],
        answer: 1,
        why: 'The first line from both services is ordinary text. A plain TCP connection reads it, and an SMTP session can be typed by hand. Later parts of SSH are encrypted, but the banner is not.',
      },
    ],
    refs: ['curl(1)', 'wget(1)', 'nc(1)', 'RFC 5321 (SMTP)', 'RFC 4253, section 4.2 (SSH protocol version exchange)'],
  };

  K.lessons.register({
    id: 'web',
    title: 'HTTP from the command line',
    order: 80,
    summary: 'Read what web servers actually say: requests, status codes, headers, TLS certificates and plain-text protocols, using curl, wget, a throwaway python web server and nc.',
    lessons: [curlLesson, headersLesson, tlsLesson, transferLesson],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
