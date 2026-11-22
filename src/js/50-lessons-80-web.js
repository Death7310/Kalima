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

  K.lessons.register({
    id: 'web',
    title: 'HTTP from the command line',
    order: 80,
    summary: 'Read what web servers actually say: requests, status codes, headers, TLS certificates and plain-text protocols, using curl, wget, a throwaway python web server and nc.',
    lessons: [curlLesson],
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
