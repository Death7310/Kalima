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
        check: { cmd: 'curl', args: ['-A'], out: /> User-Agent: \S+/, fn: (ev) => !/> User-Agent: curl\//.test(ev.output || '') },
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
        check: { cmd: 'curl', args: ['-I'], out: /^Server: nginx/m, fn: (ev) => !/HTTP\/1\.1/.test(ev.output || '') },
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

  K.lessons.register({
    id: 'web',
    title: 'HTTP from the command line',
    order: 80,
    summary: 'Read what web servers actually say: requests, status codes, headers, TLS certificates and plain-text protocols, using curl, wget, a throwaway python web server and nc.',
    lessons: [curlLesson, headersLesson],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
