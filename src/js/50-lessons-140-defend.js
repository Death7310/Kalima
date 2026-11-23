/* Kalima — curriculum module "defend": the defender's view.
 *
 * Lessons: defend-weblog, defend-authlog, defend-analysis, defend-habits.
 * The first two read the live logs on web01 (/var/log/nginx/access.log and
 * /var/log/auth.log) after the learner has generated some traffic; the third
 * reads the practice logs under /usr/share/kalima/logs in place (they are
 * read-only and the lesson never needs to change them). Evidence the learner
 * collects is saved under ~/engagement/scans.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  /** ssh answers: host key question (when asked), then the test account's password. */
  const SSHIN = ['yes', 'student'];
  const PASS = ['student'];
  const SCANS = '/home/kali/engagement/scans';
  const LOGS = '/usr/share/kalima/logs';
  /** What a line printed, without colour codes. */
  const outOf = (ev) => K.util.stripAnsi(ev.output || '');

  /* --------------------------------------------------------------- weblog */
  const weblogLesson = {
    id: 'defend-weblog',
    title: 'Your requests in the web server log',
    minutes: 11,
    objectives: [
      'Generate a few web requests and find them in the web server\'s access log',
      'Name the fields of an nginx log line: address, time, request, status code and user agent',
      'Explain what the server\'s owner can tell about you from that line',
    ],
    intro: T(
      'Everything you send to a web server is written down by the server. The defenders who run it read those records to spot problems, and they will read yours. Seeing your own traffic from their side is the quickest way to understand what a tool reveals about you, and why an engagement keeps records of its own.',
      '',
      'You will make a few requests to `web01`, log in with the test account the client supplied and find your requests in `/var/log/nginx/access.log`.'
    ),
    steps: [
      {
        id: 'plain',
        prompt: T(
          'Your address on the lab network is `10.10.10.5` (`ip -br addr` shows it). Start with an ordinary request to the web server on `web01`:',
          '',
          '```',
          'curl -s -o /dev/null http://web01.halcyon.lab/',
          '```',
          '',
          '`-s` hides the progress meter and `-o /dev/null` throws the page away, so nothing is printed. The server saw the request all the same.'
        ),
        hint: 'Type `curl -s -o /dev/null` followed by the address `http://web01.halcyon.lab/`.',
        solution: 'curl -s -o /dev/null http://web01.halcyon.lab/',
        check: { cmd: 'curl', line: /web01\.halcyon\.lab/, exit: 0 },
      },
      {
        id: 'missing',
        prompt: T(
          'Now ask for a page that does not exist, and give the tool your own name with `-A` (the *user agent*, which is a label a client sends about itself). `-w` makes curl print the status code after the transfer:',
          '',
          '```',
          'curl -s -o /dev/null -A "tester-kali/1.0" -w "%{http_code}\\n" http://web01.halcyon.lab/no-such-page.html',
          '```',
          '',
          'The server answers `404`, "not found". That answer is a normal part of the web, but a log full of them tells a defender that someone is looking for pages.'
        ),
        hint: 'Add `-A "tester-kali/1.0"` and `-w "%{http_code}\\n"` to the curl command, and end the address with `/no-such-page.html`.',
        solution: 'curl -s -o /dev/null -A "tester-kali/1.0" -w "%{http_code}\\n" http://web01.halcyon.lab/no-such-page.html',
        check: { cmd: 'curl', args: ['-A'], out: /^404$/m },
      },
      {
        id: 'creds',
        prompt: T(
          'The server writes the log, so you read it on the server. The client supplied a test account for exactly this kind of review. Look at the file in your engagement folder:',
          '',
          '```',
          'cat ~/engagement/credentials.txt',
          '```',
          '',
          'The account is valid for SSH on `web01`. It belongs to the group `adm`, which is what allows it to read the logs. Without that, the log files (owner `www-data`, group `adm`, mode `640`) would be closed to it.'
        ),
        hint: 'Just `cat` the file named above.',
        solution: 'cat ~/engagement/credentials.txt',
        check: { cmd: 'cat', out: /username: student/ },
      },
      {
        id: 'fetch',
        prompt: T(
          'Log in to `web01` as `student` and pull out the lines that came from your address. Saving the output on your own machine keeps it as evidence:',
          '',
          '```',
          'ssh student@web01.halcyon.lab "grep \'^10\\.10\\.10\\.5 \' /var/log/nginx/access.log" > ~/engagement/scans/web01-access-mine.log',
          '```',
          '',
          'If ssh asks whether to continue connecting, answer `yes`. Then type the password `student` (nothing is shown while you type). The `grep` pattern means "a line that starts with my address followed by a space"; the `\\.` makes each dot literal. The text between the quotes runs on `web01`, and the `>` saves what it prints into a file on your machine, in `scans`.'
        ),
        hint: 'The form is `ssh student@web01.halcyon.lab "grep PATTERN /var/log/nginx/access.log" > FILE`.',
        solution: 'ssh student@web01.halcyon.lab "grep \'^10\\.10\\.10\\.5 \' /var/log/nginx/access.log" > ~/engagement/scans/web01-access-mine.log',
        input: SSHIN,
        check: { cmd: 'grep', host: 'web01', line: /web01-access-mine\.log/, file: { path: SCANS + '/web01-access-mine.log', exists: true, contains: /no-such-page\.html/ } },
      },
      {
        id: 'read',
        prompt: T(
          'Read your own trail:',
          '',
          '```',
          'cat ~/engagement/scans/web01-access-mine.log',
          '```',
          '',
          'Each line is one request, in the *combined* log format:',
          '',
          '```',
          '10.10.10.5 - - [13/Nov/2026:14:30:00 +0000] "GET /index.html HTTP/1.1" 200 1495 "-" "curl/8.18.0"',
          '```',
          '',
          'In order: the client address, two fields that are usually `-` (identity and logged-in user), the time in brackets with its time zone offset, the request in quotes (method, path, protocol), the status code, the size of the reply in bytes, the referring page, and the user agent. Find the line for `/no-such-page.html`. Lines from earlier work of yours may be there too.'
        ),
        hint: 'Use `cat` on the file you saved.',
        solution: 'cat ~/engagement/scans/web01-access-mine.log',
        check: { cmd: 'cat', out: /"(GET|HEAD) \/no-such-page\.html HTTP\/1\.1" 404 / },
      },
      {
        id: 'status-q',
        prompt: 'In the line for `/no-such-page.html`, which status code did the server record? Answer with the number.',
        hint: 'It is the number right after the closing quote of the request.',
        solution: '404',
        answer: '404',
      },
      {
        id: 'zone-q',
        prompt: 'The time in the line is followed by a time zone offset such as `+0000`. What does `+0000` tell you about the clock the server used? Answer with one word or phrase; `UTC` is the standard answer.',
        hint: 'An offset of zero from the world reference time means the server logs in that time.',
        solution: 'UTC',
        answer: /^(utc|gmt|utc time|zero|no offset|\+?0000)$/i,
      },
      {
        id: 'fields',
        prompt: T(
          'You can pull individual fields out of a log line with `awk`, which splits each line at spaces. Field 1 is the address, field 4 the start of the time, field 7 the path and field 9 the status:',
          '',
          '```',
          'awk \'{print $1, $4, $7, $9}\' ~/engagement/scans/web01-access-mine.log',
          '```',
          '',
          'One line per request, four columns. This is the view a defender builds first when they look for a pattern.'
        ),
        hint: 'Use `awk` with a print command naming fields 1, 4, 7 and 9, then the file.',
        solution: 'awk \'{print $1, $4, $7, $9}\' ~/engagement/scans/web01-access-mine.log',
        check: { cmd: 'awk', out: /10\.10\.10\.5 \[\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2} \/no-such-page\.html 404/ },
      },
      {
        id: 'agents',
        prompt: T(
          'The user agent is the last quoted field. Splitting at double quotes makes it field 6, because the quotes divide the line into parts:',
          '',
          '```',
          'awk -F\'"\' \'{print $6}\' ~/engagement/scans/web01-access-mine.log',
          '```',
          '',
          'You will see `tester-kali/1.0` for the request where you set it, and the default name for your plain request. Tools announce themselves unless told otherwise. A user agent is chosen by the client, so it is a clue and never proof, but it is often the first thing a defender notices.'
        ),
        hint: 'Set the field separator with `-F\'"\'` and print `$6`.',
        solution: 'awk -F\'"\' \'{print $6}\' ~/engagement/scans/web01-access-mine.log',
        check: { cmd: 'awk', out: /^tester-kali\/1\.0$/m },
      },
      {
        id: 'agent-q',
        prompt: 'Which tool name does the user agent of your plain request (the first one, where you did not use `-A`) show? Answer with the name, without the version.',
        hint: 'It is the default user agent that the command-line client sends. Look at the output above.',
        solution: 'curl',
        answer: /^curl(\/[\d.]+)?$/i,
      },
    ],
    quiz: [
      {
        q: 'Which part of an nginx access log line would show a defender that a client was asking for pages that do not exist?',
        choices: [
          'The size of the reply',
          'The status code `404` repeated across many requests',
          'The time zone offset',
          'The two `-` fields after the address',
        ],
        answer: 1,
        why: 'A `404` means the page was not found. One is normal; a long run of them from one address in a short time is the classic trace of someone probing for pages.',
      },
      {
        q: 'You run `curl -A "Mozilla/5.0" http://web01.halcyon.lab/` to look like a browser. What can the defender still see in the log?',
        choices: [
          'Nothing, because the user agent hides the address',
          'Your source address, the exact time, the request and the status code',
          'Only the user agent',
          'Your user name on Kali',
        ],
        answer: 1,
        why: 'The user agent is one field among many. The address, the time, the path and the status are recorded whatever name the client uses, and the tool\'s behavior (what it asks for, how fast) is visible too.',
      },
      {
        q: 'Why can the account `student` read `/var/log/nginx/access.log` on web01?',
        choices: [
          'Every account can read every log',
          'It is a member of the `adm` group, which the file\'s group permissions allow to read',
          'It is the web server\'s owner',
          'Because it logged in with ssh',
        ],
        answer: 1,
        why: 'The file is owned by `www-data`, group `adm`, with mode `640`. Members of `adm` may read it. The client added the test account to that group for the log review.',
      },
    ],
    refs: ['curl(1)', 'awk(1)', 'nginx documentation, log_format combined', 'NIST SP 800-92, Guide to Computer Security Log Management'],
  };

  /* -------------------------------------------------------------- authlog */
  const MINE = SCANS + '/web01-auth-mine.log';
  const authlogLesson = {
    id: 'defend-authlog',
    title: 'Your SSH logins in the auth log',
    minutes: 11,
    objectives: [
      'Find your own SSH connections in `/var/log/auth.log` on `web01`',
      'Tell an accepted login from a refused one and name the fields that matter',
      'Explain why a log is readable only by some accounts',
    ],
    intro: T(
      'Every SSH login, successful or not, leaves a record on the server. Administrators read the authentication log to answer one question: who logged in, from where, and did they get in? A refused attempt is as interesting to them as an accepted one.',
      '',
      'You will connect to `web01` twice, once correctly and once with a deliberate mistake, and then read what the server wrote about you. The password mistake is made on the test account the client supplied for this purpose. A real engagement never involves guessing passwords on accounts you were not given.'
    ),
    steps: [
      {
        id: 'accepted',
        prompt: T(
          'First a normal login that runs one harmless command:',
          '',
          '```',
          'ssh student@web01.halcyon.lab hostname',
          '```',
          '',
          'If ssh asks whether to continue connecting, answer `yes`. The password is `student`. The output is the name of the server, `web01`.'
        ),
        hint: 'Type `ssh student@web01.halcyon.lab hostname` and answer the prompts.',
        solution: 'ssh student@web01.halcyon.lab hostname',
        input: SSHIN,
        check: { cmd: 'hostname', host: 'web01', out: /^web01\s*$/m, exit: 0 },
      },
      {
        id: 'refused',
        prompt: T(
          'Now the same login with a wrong password. `-o NumberOfPasswordPrompts=1` limits ssh to a single try, so the server records one refusal and not three:',
          '',
          '```',
          'ssh -o NumberOfPasswordPrompts=1 student@web01.halcyon.lab hostname',
          '```',
          '',
          'When it asks for the password, type anything other than `student`. ssh ends with `Permission denied`. From the server\'s side, this is a failed authentication from your address.'
        ),
        hint: 'Use the option shown and type a wrong password at the prompt.',
        solution: 'ssh -o NumberOfPasswordPrompts=1 student@web01.halcyon.lab hostname',
        input: ['wrong'],
        check: { cmd: 'ssh', out: /Permission denied \(publickey,password\)/ },
      },
      {
        id: 'fetch',
        prompt: T(
          'Fetch the records that mention your address and save them as evidence. The pattern `10\\.10\\.10\\.5 ` has a trailing space on purpose, so that it cannot match `10.10.10.50`:',
          '',
          '```',
          'ssh student@web01.halcyon.lab "grep \'10\\.10\\.10\\.5 \' /var/log/auth.log" > ~/engagement/scans/web01-auth-mine.log',
          '```',
          '',
          'Enter the password `student` when asked. Reading `/var/log/auth.log` works because the account is in the `adm` group.'
        ),
        hint: 'Same shape as the web log step: `ssh student@web01.halcyon.lab "grep PATTERN /var/log/auth.log" > FILE`.',
        solution: 'ssh student@web01.halcyon.lab "grep \'10\\.10\\.10\\.5 \' /var/log/auth.log" > ~/engagement/scans/web01-auth-mine.log',
        input: PASS,
        check: { cmd: 'grep', host: 'web01', line: /web01-auth-mine\.log/, file: { path: MINE, exists: true, contains: /Accepted password for student from 10\.10\.10\.5/ } },
      },
      {
        id: 'read',
        prompt: T(
          'Read the records:',
          '',
          '```',
          'cat ~/engagement/scans/web01-auth-mine.log',
          '```',
          '',
          'Each line begins with the date and time, the server name and the process, such as `sshd-session[2207]`. The number in brackets identifies one connection, so all lines with the same number belong together. A good login reads like this:',
          '',
          '```',
          'Connection from 10.10.10.5 port 39383 on 10.10.10.10 port 22 ...',
          'Accepted password for student from 10.10.10.5 port 39383 ssh2',
          'Received disconnect from 10.10.10.5 port 39383:11: disconnected by user',
          '```',
          '',
          'A refused login has `Failed password` where `Accepted password` would be, and a closing line that says the connection ended while the user was still authenticating.'
        ),
        hint: 'Use `cat` on the saved file.',
        solution: 'cat ~/engagement/scans/web01-auth-mine.log',
        check: { cmd: 'cat', out: /Accepted password for student from 10\.10\.10\.5/ },
      },
      {
        id: 'failed-q',
        prompt: 'Which word at the start of the message marks the record of your wrong password? Answer with that one word.',
        hint: 'It is the word in the message that appears where `Accepted` appears in a good login.',
        solution: 'Failed',
        answer: /^failed( password)?$/i,
      },
      {
        id: 'summary',
        prompt: T(
          'The fields you care about are in fixed positions on the `Accepted` and `Failed` lines: field 1 to 3 are the date and time, field 6 is the result, field 9 the account and field 11 the source address. Print just those and you have one clear line per attempt:',
          '',
          '```',
          'awk \'/Accepted|Failed/ {print $1, $2, $3, $6, $9, $11}\' ~/engagement/scans/web01-auth-mine.log',
          '```',
          '',
          'The expression between the slashes selects the lines to act on, and the braces say what to print for them.'
        ),
        hint: 'Use `awk` with a pattern in slashes, then `{print ...}` listing fields 1, 2, 3, 6, 9 and 11.',
        solution: 'awk \'/Accepted|Failed/ {print $1, $2, $3, $6, $9, $11}\' ~/engagement/scans/web01-auth-mine.log',
        check: { cmd: 'awk', out: /Accepted student 10\.10\.10\.5/, fn: (ev) => /Failed student 10\.10\.10\.5/.test(outOf(ev)) },
      },
      {
        id: 'perms',
        prompt: T(
          'Why were you able to read this file? Ask `web01` who owns it and which groups your account belongs to:',
          '',
          '```',
          'ssh student@web01.halcyon.lab "ls -l /var/log/auth.log; id"',
          '```',
          '',
          'The file belongs to `root` and group `adm`, and its mode `-rw-r-----` allows the owner to write and the group to read. Everyone else is shut out, because an authentication log holds user names and addresses, and an attacker who can edit it can hide.'
        ),
        hint: 'Two commands in one quoted string: `ls -l /var/log/auth.log; id`.',
        solution: 'ssh student@web01.halcyon.lab "ls -l /var/log/auth.log; id"',
        input: PASS,
        check: { cmd: 'id', host: 'web01', out: /root adm .*auth\.log/, fn: (ev) => /groups=.*\badm\b/.test(outOf(ev)) },
      },
      {
        id: 'group-q',
        prompt: 'Which group lets `student` read the file? Type the group name.',
        hint: 'It is the group shown in `ls -l` and in the `groups=` part of the `id` output.',
        solution: 'adm',
        answer: /^adm$/i,
      },
      {
        id: 'others',
        prompt: T(
          'The log is not only about you. The server has been running for days, and every accepted login is in the file:',
          '',
          '```',
          'ssh student@web01.halcyon.lab "grep Accepted /var/log/auth.log"',
          '```',
          '',
          'Some of these lines come from your address. Look for a different source address, and for the earlier dates. A defender would know which of these addresses belong to colleagues and which do not; you do not, and it is not your job to investigate them.'
        ),
        hint: 'Search for the word `Accepted` in `/var/log/auth.log` on web01.',
        solution: 'ssh student@web01.halcyon.lab "grep Accepted /var/log/auth.log"',
        input: PASS,
        check: { cmd: 'grep', host: 'web01', out: /Accepted password for student from 10\.10\.20\.14/ },
      },
      {
        id: 'others-q',
        prompt: 'Apart from your own address, which source address appears in the accepted logins? Type it.',
        hint: 'It starts with `10.10.20.`. It also logged in on November 10 and 11.',
        solution: '10.10.20.14',
        answer: /^10\.10\.20\.14$/,
      },
    ],
    quiz: [
      {
        q: 'In the auth log, two lines carry the same number in brackets, `sshd-session[2207]`. What does that mean?',
        choices: [
          'They are two different servers',
          'They belong to the same connection',
          'The second one is an error',
          'They happened at the same second',
        ],
        answer: 1,
        why: 'The number is the process id of the sshd process that handled that connection, so all records with it tell one connection\'s story from first packet to disconnect.',
      },
      {
        q: 'What does a defender conclude from five `Failed password` lines from one address followed by an `Accepted password` line from the same address?',
        choices: [
          'Nothing; failed logins are normal',
          'Someone may have guessed the password, and the account deserves a closer look',
          'The address is the server itself',
          'The server restarted',
        ],
        answer: 1,
        why: 'A run of failures and then a success from the same source is a recognized pattern of password guessing. It is worth reviewing, though a person who mistyped a few times looks the same, so context decides.',
      },
      {
        q: 'Why is `/var/log/auth.log` readable only by root and the `adm` group?',
        choices: [
          'Because it is a binary file',
          'Because it names accounts and addresses, and someone who can change it could erase their tracks',
          'Because the file is too large for ordinary users',
          'It is not; any user can read it',
        ],
        answer: 1,
        why: 'Logs are evidence. Restricting them protects what they reveal about users and keeps the record trustworthy.',
      },
    ],
    refs: ['sshd(8)', 'ssh(1), the -o option and NumberOfPasswordPrompts', 'NIST SP 800-92, Guide to Computer Security Log Management'],
  };

  /* ------------------------------------------------------------- analysis */
  const WEB = LOGS + '/access.log';
  const AUTH = LOGS + '/auth.log';
  const analysisLesson = {
    id: 'defend-analysis',
    title: 'Reading logs like an analyst',
    minutes: 12,
    objectives: [
      'Count requests and failures per client address with `awk`, `sort` and `uniq -c`',
      'Spot the clients that stand out: the noisiest, the one producing most errors, the one failing logins',
      'Decide what to flag for a closer look, and say why it is a lead and not a verdict',
    ],
    intro: T(
      'A log of a few hundred lines can be read by eye. A real one holds millions, so analysts do not read it: they count it. The method is always the same. Pick one field, count how often each value occurs, sort, and look at what stands out. This lesson applies it to two practice logs from a fictional shop server, a web access log and an SSH log.',
      '',
      'The addresses in them come from ranges reserved for documentation (RFC 5737), so they point at no real system. The logs are read-only in `/usr/share/kalima/logs`, and you never need to change them.'
    ),
    steps: [
      {
        id: 'clients',
        prompt: T(
          'The web log is in nginx\'s combined format, with the client address in field 1. Count how many requests each address made:',
          '',
          '```',
          'awk \'{print $1}\' /usr/share/kalima/logs/access.log | sort | uniq -c | sort -rn',
          '```',
          '',
          '`awk` prints field 1 of every line, `sort` groups equal addresses together, `uniq -c` counts each group and `sort -rn` puts the biggest count first. Each output line is a count followed by an address.'
        ),
        hint: 'Four commands joined by pipes: `awk`, `sort`, `uniq -c`, `sort -rn`.',
        solution: 'awk \'{print $1}\' ' + WEB + ' | sort | uniq -c | sort -rn',
        check: { cmd: 'uniq', args: ['-c'], out: /^\s*110 203\.0\.113\.99$/m },
      },
      {
        id: 'clients-q',
        prompt: 'Which address made the most requests? Type the address.',
        hint: 'It is on the first line of the output.',
        solution: '203.0.113.99',
        answer: /^203\.0\.113\.99$/,
      },
      {
        id: 'status',
        prompt: T(
          'Volume alone proves little: a monitoring probe is noisy by design. Add the status code, field 9, to the picture and count each pair of status and address:',
          '',
          '```',
          'awk \'{print $9, $1}\' /usr/share/kalima/logs/access.log | sort | uniq -c | sort -rn',
          '```',
          '',
          'Most pairs are `200`, a successful page. Look for the ones that are not: `404` is "not found", `401` is "unauthorized": the credentials were missing or refused.'
        ),
        hint: 'Like the last command, but print `$9, $1` so that each line holds a status and an address.',
        solution: 'awk \'{print $9, $1}\' ' + WEB + ' | sort | uniq -c | sort -rn',
        check: { cmd: 'uniq', out: /^\s*108 404 203\.0\.113\.99$/m, fn: (ev) => /^\s*24 401 198\.51\.100\.150$/m.test(outOf(ev)) },
      },
      {
        id: 'status-q',
        prompt: 'How many `404` responses did `203.0.113.99` receive? Answer with the number.',
        hint: 'Find the line that holds `404 203.0.113.99`; the count is the first number.',
        solution: '108',
        answer: '108',
      },
      {
        id: 'timing',
        prompt: T(
          'When did it happen, and how fast? Print the first and the last request of that address. `sed -n \'1p;$p\'` prints line 1 and the last line (`$`):',
          '',
          '```',
          'grep \'^203\\.0\\.113\\.99 \' /usr/share/kalima/logs/access.log | sed -n \'1p;$p\'',
          '```',
          '',
          'Compare the two times. Read the end of each line too: the user agent names the tool that made the requests. It is a label the client chose, so it is a clue, but a plain one.'
        ),
        hint: 'Filter with `grep` on the address at the start of the line, then pipe to `sed -n \'1p;$p\'`.',
        solution: 'grep \'^203\\.0\\.113\\.99 \' ' + WEB + ' | sed -n \'1p;$p\'',
        check: { cmd: 'sed', out: /03:12:00 [\s\S]*03:12:44 /, fn: (ev) => /gobuster/.test(outOf(ev)) },
      },
      {
        id: 'timing-q',
        prompt: 'The first of those requests was at `03:12:00` and the last at `03:12:44`. About how many seconds did the whole run take? Answer with the number.',
        hint: 'Subtract the two times.',
        solution: '44',
        answer: /^(44|45)( seconds?)?$/i,
      },
      {
        id: 'failed',
        prompt: T(
          'Now the SSH log. A failed password is recorded as `Failed password for ... from ADDRESS port ...`. `grep -o` prints only the part that matches, here the word `from` and the address, and the rest of the pipeline counts them as before:',
          '',
          '```',
          'grep "Failed password" /usr/share/kalima/logs/auth.log | grep -o "from [0-9.]*" | sort | uniq -c | sort -rn',
          '```',
          '',
          'Four addresses failed to log in, with very different totals.'
        ),
        hint: 'Select the `Failed password` lines, extract `from` plus the address with `grep -o`, then `sort | uniq -c | sort -rn`.',
        solution: 'grep "Failed password" ' + AUTH + ' | grep -o "from [0-9.]*" | sort | uniq -c | sort -rn',
        check: { cmd: 'uniq', out: /^\s*64 from 203\.0\.113\.99$/m },
      },
      {
        id: 'failed-q',
        prompt: 'One address is at the top of both counts: the busiest web client and the source of most failed SSH logins. Which address is it?',
        hint: 'Compare the first line of this output with the answer to the first question.',
        solution: '203.0.113.99',
        answer: /^203\.0\.113\.99$/,
      },
      {
        id: 'accepted',
        prompt: T(
          'Did any of those sources get in? Look at the successful logins:',
          '',
          '```',
          'grep Accepted /usr/share/kalima/logs/auth.log',
          '```',
          '',
          'There are only four lines. They are logins by the account `deploy` with a *public key*, from two addresses that are not among the four that failed. That does not prove nothing happened, but it shows no sign that the guesses worked. Analysts write down both facts: what was seen and what was not.'
        ),
        hint: 'Search the file for the word `Accepted`.',
        solution: 'grep Accepted ' + AUTH,
        check: { cmd: 'grep', out: /Accepted publickey for deploy from 198\.51\.100\.23/ },
      },
      {
        id: 'flag',
        prompt: T(
          'End the way an analyst does: write down what deserves a closer look, with the reason, in your notes. Append two lines to `~/engagement/notes.md`, one naming `203.0.113.99` and one naming `198.51.100.150`. The second one made 24 requests to `/login` that were all refused (`401`) and 31 failed SSH logins. For example:',
          '',
          '```',
          'echo "REVIEW 203.0.113.99: 108 not-found requests in 44 s (gobuster), 64 failed SSH logins" >> ~/engagement/notes.md',
          'echo "REVIEW 198.51.100.150: 24 refused /login requests, 31 failed SSH logins" >> ~/engagement/notes.md',
          '```',
          '',
          'Write these as leads. The logs show what happened, not who was behind it or why. Passing them to the owner of the system is the next step, not acting on them yourself.'
        ),
        hint: 'Use `echo "..." >> ~/engagement/notes.md` twice, once per address. You can put both on one line with a semicolon.',
        solution: 'echo "REVIEW 203.0.113.99: 108 not-found requests in 44 s (gobuster), 64 failed SSH logins" >> ~/engagement/notes.md; echo "REVIEW 198.51.100.150: 24 refused /login requests, 31 failed SSH logins" >> ~/engagement/notes.md',
        check: { line: /notes\.md/, file: { path: '/home/kali/engagement/notes.md', exists: true, contains: /203\.0\.113\.99[\s\S]*198\.51\.100\.150|198\.51\.100\.150[\s\S]*203\.0\.113\.99/ } },
      },
    ],
    quiz: [
      {
        q: 'An address made 96 requests, all to `/status`, exactly every fifteen minutes, with the user agent `UptimeProbe/1.4`. What is the most likely explanation?',
        choices: [
          'A password guessing attack',
          'A monitoring service checking that the site is up',
          'A person browsing the shop',
          'A compromised account',
        ],
        answer: 1,
        why: 'Regular timing, one path and a tool name that says what it is point to a health check. High volume alone does not make a client suspicious; the pattern does.',
      },
      {
        q: 'Why is a user agent such as `gobuster/3.8` a clue and not proof of who or what made the requests?',
        choices: [
          'Because user agents are encrypted',
          'Because the client chooses the text it sends, so it can be changed or faked',
          'Because only browsers send user agents',
          'Because the server adds it itself',
        ],
        answer: 1,
        why: 'The header is whatever the client sends. Here its behavior agrees with the label, which makes it a strong lead; a different name on the same traffic would not change what the traffic did.',
      },
      {
        q: 'The failed-login count for one address is high, and no `Accepted` line from it appears in the log. What do you report?',
        choices: [
          'That the account was compromised',
          'That there were many failed logins from that address and no sign of success in this log, recommending review and blocking at the owner\'s discretion',
          'Nothing, because failed logins do not matter',
          'That the address belongs to an attacker, by name',
        ],
        answer: 1,
        why: 'Report what the evidence shows and what it does not, and leave the decisions about response to the system\'s owner. Attribution from a log alone is not possible.',
      },
      {
        q: 'In the pipeline `sort | uniq -c | sort -rn`, why does `sort` come before `uniq -c`?',
        choices: [
          '`uniq` only counts equal lines that sit next to each other, so the input must be sorted first',
          '`uniq` needs numbers',
          'To make the output shorter',
          'It does not matter; they can be swapped',
        ],
        answer: 0,
        why: '`uniq` compares each line only with the one before it. Sorting brings identical lines together so that each value is counted once.',
      },
    ],
    refs: ['awk(1)', 'uniq(1)', 'sort(1)', 'RFC 5737', 'NIST SP 800-92, Guide to Computer Security Log Management'],
  };

  const lessons = [weblogLesson, authlogLesson, analysisLesson];

  K.lessons.register({
    id: 'defend',
    title: 'The defender\'s view',
    order: 140,
    summary: 'See your own activity the way the client\'s defenders do: web and SSH logs on a server, how an analyst reads a log, and what that means for careful testing.',
    lessons,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
