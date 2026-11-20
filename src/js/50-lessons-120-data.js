/* Kalima — curriculum module "data": encoding, hashing and integrity.
 *
 * Lessons: data-encode, data-hash, data-verify. Practice files are seeded
 * read-only under /usr/share/kalima/encoding (encoded notes and a saved HTTP
 * request), /usr/share/kalima/hashing (files to fingerprint) and
 * /usr/share/kalima/release (a small "download" with its SHA256SUMS file).
 * The learner reads the first two in place and copies the third to
 * ~/practice/data/release, where it can be changed and repaired.
 *
 * The digests and encoded strings below were computed with the real
 * coreutils from exactly the text seeded here; the replay test fails if
 * either side is edited without the other.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const T = (...lines) => lines.join('\n');
  const ENCODING = '/usr/share/kalima/encoding';
  const HASHING = '/usr/share/kalima/hashing';
  const RELEASE = '/usr/share/kalima/release';
  const WORK = '/home/kali/practice/data';
  /** What a line printed, without colour codes. */
  const outOf = (ev) => K.util.stripAnsi(ev.output || '');
  const linesOf = (ev) => outOf(ev).split('\n').map((l) => l.trim()).filter(Boolean);
  /** Content of a file on the Kali machine, or null. */
  const readFile = (path) => { try { return K.kali.vfs.read(path); } catch (e) { return null; } };

  /* ------------------------------------------------------------ practice files */
  const MANIFEST = (pallets) => T(
    'Halcyon Freight - load manifest HF-2217',
    'Depot: Leeds North',
    'Trailer: TR-0412',
    'Pallets: ' + pallets,
    'Gross weight: 1840 kg',
    'Seal number: 558213',
    '');
  const AGENT_CONF = T(
    '# depot-agent 4.2 - configuration',
    'server = files01.halcyon.lab',
    'port = 8443',
    'interval = 300',
    'verify_tls = yes',
    '');
  const AGENT_SH = T(
    '#!/bin/sh',
    '# depot-agent 4.2 - reports scanner status to the depot server.',
    '# Training copy: it only prints what it would do.',
    'echo "depot-agent 4.2"',
    'echo "would report to the server named in depot-agent.conf"',
    '');
  const RELEASE_README = T(
    'depot-agent 4.2 - release files',
    '',
    'depot-agent.sh    the agent',
    'depot-agent.conf  its configuration',
    'SHA256SUMS        SHA-256 digests of the files above',
    '',
    'Verify before you install:  sha256sum -c SHA256SUMS',
    '');
  const AGENT_CONF_SHA1 = '44e27d840124242a76647996eb5fc4d3f01fb028';
  const RELEASE_SUMS = T(
    '47ddf9d64bb0fc6f6d6e51bcc72ebba0b85cb2645d27ef3fe004b90797c68662  README.txt',
    '07614b527ed30bdc4dcf3e4f63f9e28a5ee6dd53f8bc76510bc2414c406eb7d6  depot-agent.conf',
    '7cc1d2219a82c4513e16d10857910cfbcf7fa5e1a9beacb7e1b49a7bb0cd1e4b  depot-agent.sh',
    '');

  K.fsSeeds.push((machine) => {
    if (machine.profile !== 'kali') return;
    const vfs = machine.vfs;
    let mtime = Date.UTC(2026, 9, 26, 9, 12);
    try { mtime = vfs.stat('/usr/share/kalima/README').mtime; } catch (e) { /* content pack not loaded: keep the default */ }
    const file = (path, text, mode) => vfs.seed(path, text, { mode: mode || 0o644, uid: 0, gid: 0, mtime });

    // data-encode: the token is Base64 of "svc-reports:Tuesday-Depot-41" (a fictional lab account)
    file(ENCODING + '/request.txt', T(
      'GET /reports/weekly HTTP/1.1',
      'Host: intranet.halcyon.lab',
      'User-Agent: curl/8.17.0',
      'Accept: */*',
      'Authorization: Basic c3ZjLXJlcG9ydHM6VHVlc2RheS1EZXBvdC00MQ==',
      ''));
    file(ENCODING + '/sample-a.txt', '446f636b203420636c6f7365732061742031383a30300a\n');
    file(ENCODING + '/sample-b.txt', 'VGhlIGdhdGUgY29kZSBjaGFuZ2VzIGV2ZXJ5IE1vbmRheQo=\n');

    // data-hash
    file(HASHING + '/manifest.txt', MANIFEST(12));
    file(HASHING + '/manifest-copy.txt', MANIFEST(12));
    file(HASHING + '/manifest-edited.txt', MANIFEST(13));
    file(HASHING + '/agent.conf', AGENT_CONF);
    file(HASHING + '/published.txt', T(
      'depot-agent 4.2 - checksum published by the vendor',
      '',
      'file:    agent.conf',
      'digest:  ' + AGENT_CONF_SHA1,
      ''));

    // data-verify
    file(RELEASE + '/README.txt', RELEASE_README);
    file(RELEASE + '/depot-agent.conf', AGENT_CONF);
    file(RELEASE + '/depot-agent.sh', AGENT_SH, 0o755);
    file(RELEASE + '/SHA256SUMS', RELEASE_SUMS);
  });

  /* ---------------------------------------------------------------- encode */
  const encodeLesson = {
    id: 'data-encode',
    title: 'Encoding is not encryption: Base64 and hex',
    minutes: 11,
    objectives: [
      'Encode and decode text with `base64`',
      'Read a hex dump made by `xxd` and turn plain hex back into text',
      'Recognize Base64 and hexadecimal when you meet them in a file or a request',
      'Explain why encoded data is not protected',
    ],
    intro: T(
      'Data often travels in a form that looks scrambled: a long run of letters and digits in a web request, a configuration file or a log. Most of the time it is not secret at all. It is *encoded*: rewritten in a different alphabet so that it survives a channel that only carries plain text.',
      '',
      'Anyone can reverse an encoding. There is no key and no password. Two encodings account for most of what you will meet, Base64 and hexadecimal. Spotting them and reading them is a basic skill for reviewing systems, and so is the conclusion that follows: a password that is only encoded is not protected.'
    ),
    steps: [
      {
        id: 'encode',
        prompt: T(
          'Start by making some Base64 yourself. Send a line of text through `base64`:',
          '',
          '```',
          'echo "Halcyon Freight" | base64',
          '```',
          '',
          'The result is the same text written with a 64-character alphabet: `A` to `Z`, `a` to `z`, `0` to `9`, `+` and `/`. Every three bytes of input become four characters of output, so the encoded form is about a third longer. The `=` signs at the end are padding that fills the last group of four.'
        ),
        hint: 'Type the `echo` command, then `|`, then `base64`.',
        solution: 'echo "Halcyon Freight" | base64',
        check: { cmd: 'base64', exit: 0, out: /SGFsY3lvbiBGcmVpZ2h0/ },
      },
      {
        id: 'decode',
        prompt: T(
          'Now go the other way. The option `-d` decodes:',
          '',
          '```',
          'echo "SGFsY3lvbiBGcmVpZ2h0Cg==" | base64 -d',
          '```',
          '',
          'The original text is back. Notice what you did not need: a key, a password, or any knowledge of who encoded it. Everyone who sees the encoded form can do what you just did.'
        ),
        hint: 'Use `echo` with the encoded text in quotes and pipe it to `base64 -d`. Copy the text exactly, including the two `=` signs.',
        solution: 'echo "SGFsY3lvbiBGcmVpZ2h0Cg==" | base64 -d',
        check: { cmd: 'base64', exit: 0, out: /^Halcyon Freight$/m },
      },
      {
        id: 'request',
        prompt: T(
          'The practice directory holds a web request that was saved during the lab engagement. It was sent to the intranet site, which is in scope. Go there and read it:',
          '',
          '```',
          'cd /usr/share/kalima/encoding',
          'cat request.txt',
          '```',
          '',
          'Look at the last line. `Authorization: Basic` is followed by a run of letters and digits that ends in `==`. A mixed-case alphabet and `=` padding at the end are the signature of Base64.'
        ),
        hint: 'Run the two commands one after the other. Tab completion helps with the long path.',
        solution: 'cd /usr/share/kalima/encoding && cat request.txt',
        check: { cwd: ENCODING, out: /Authorization: Basic c3Zj/ },
      },
      {
        id: 'token',
        prompt: T(
          'Decode that value without retyping it. Build a pipeline that picks the line, cuts out the third word and decodes it:',
          '',
          '```',
          'grep Authorization request.txt | cut -d\' \' -f3 | base64 -d',
          '```',
          '',
          '- `grep Authorization request.txt` keeps the one line you want.',
          '- `cut -d\' \' -f3` splits it at spaces and keeps the third field, the encoded value.',
          '- `base64 -d` decodes it.',
          '',
          'The output has the form `name:password`. This is how HTTP Basic authentication works: the client joins the two with a colon and Base64-encodes them. Nothing more. Anyone who can see the request, on the network or in a log, can read the password. That is why Basic authentication over plain HTTP is a finding to report, and why a file like this one belongs with your confidential engagement notes.'
        ),
        hint: 'Type the pipeline as shown. If `grep` reports `No such file or directory`, go to the practice directory first: `cd /usr/share/kalima/encoding`.',
        solution: 'grep Authorization request.txt | cut -d\' \' -f3 | base64 -d',
        check: { cmd: 'base64', out: /svc-reports:Tuesday-Depot-41/ },
      },
      {
        id: 'user',
        prompt: 'Read the decoded text. Which user name was sent with the request? It is the part before the colon.',
        hint: 'The decoded text looks like `name:password`. Type only the name.',
        solution: 'svc-reports',
        answer: /^svc-reports:?$/i,
      },
      {
        id: 'hexdump',
        prompt: T(
          'The second encoding is hexadecimal: every byte written as two digits from `0` to `9` and `a` to `f`. `xxd` shows data that way:',
          '',
          '```',
          'echo "Halcyon" | xxd',
          '```',
          '',
          'Read the line in three parts. On the left is the position of the first byte on the line. In the middle are the bytes, two hex digits each, printed in groups of two bytes. On the right is the same data as text, with a dot for anything that cannot be printed.',
          '',
          'The first byte, `48`, is the letter `H`. The last byte, `0a`, is the line break that `echo` adds; it has no printable form, so it shows as a dot.'
        ),
        hint: 'Pipe the output of `echo "Halcyon"` into `xxd`.',
        solution: 'echo "Halcyon" | xxd',
        check: { cmd: 'xxd', exit: 0, out: /4861 6c63 796f 6e/ },
      },
      {
        id: 'hex-y',
        prompt: 'Match the bytes to the letters of `Halcyon`, one pair of hex digits per letter. Which two hex digits stand for the letter `y`?',
        hint: '`y` is the fifth letter, so it is the fifth pair of digits. Each group of four digits holds two letters.',
        solution: '79',
        answer: /^(0x)?79$/i,
      },
      {
        id: 'unhex',
        prompt: T(
          'Hex is often stored without the positions and the text column, as one unbroken run of digits. The file `sample-a.txt` is like that. Look at it with `cat` if you like, then decode it:',
          '',
          '```',
          'xxd -r -p sample-a.txt',
          '```',
          '',
          '`-p` tells `xxd` to expect plain hex, and `-r` reverses the direction: hex in, original bytes out. As with Base64, no key is involved.'
        ),
        hint: 'Type `xxd -r -p sample-a.txt` in the directory `/usr/share/kalima/encoding`.',
        solution: 'xxd -r -p sample-a.txt',
        check: { cmd: 'xxd', exit: 0, out: /Dock 4 closes at 18:00/ },
      },
      {
        id: 'identify',
        prompt: T(
          'Now decide for yourself. `sample-b.txt` holds another encoded note. Look at it with `cat`, work out which of the two encodings it is, and decode it.',
          '',
          'How to tell them apart:',
          '',
          '- Hex uses only the digits `0` to `9` and the letters `a` to `f`, and its length is always even. Ordinary text in hex is full of pairs that start with `6` or `7`.',
          '- Base64 mixes capital letters, small letters and digits, may contain `+` and `/`, and often ends in `=` or `==`.'
        ),
        hint: 'The note contains capital letters beyond `F` and ends in `=`, so it is Base64. Decode a file with `base64 -d` followed by its name.',
        solution: 'base64 -d sample-b.txt',
        check: { cmd: ['base64', 'xxd'], out: /The gate code changes every Monday/ },
      },
      {
        id: 'day',
        prompt: 'Read the note you decoded. On which day of the week does the gate code change?',
        hint: 'The decoded note is one short sentence. Type the name of the day.',
        solution: 'Monday',
        answer: /^((every|on|each)\s+)?mondays?\.?$/i,
      },
    ],
    quiz: [
      {
        q: 'A configuration file contains `password = cGFsbGV0LTc3`. A colleague says the password is safe because it is encrypted. What is the right response?',
        choices: [
          'Agreed: without the key nobody can read it',
          'It is Base64. Anyone can decode it with `base64 -d`, so it must be treated as a plain-text password',
          'It is a hash, so the password cannot be recovered',
          'It is safe as long as the file name is not obvious',
        ],
        answer: 1,
        why: 'Base64 is an encoding. It has no key, and decoding it takes one command. Encryption needs a secret key to reverse; this needs nothing.',
      },
      {
        q: 'Which of these strings is most likely to be hex-encoded text?',
        choices: [
          '`SGVsbG8gd29ybGQ=`',
          '`Uryyb jbeyq`',
          '`48656c6c6f20776f726c64`',
          '`Hello%20world`',
        ],
        answer: 2,
        why: 'It uses only the digits and the letters `a` to `f`, its length is even, and most pairs start with `6` or `7`, as lowercase letters do. The first string has the mixed alphabet and `=` padding of Base64.',
      },
      {
        q: 'You Base64-encode a file of 3,000 bytes. Roughly how large is the encoded result?',
        choices: [
          'About 1,500 bytes, because Base64 compresses',
          'About 3,000 bytes, the same as the original',
          'About 4,000 bytes, because every three bytes become four characters',
          'About 6,000 bytes, because every byte becomes two characters',
        ],
        answer: 2,
        why: 'Base64 turns each group of three bytes into four characters, so the output is about a third larger. Two characters per byte is hex, which doubles the size.',
      },
      {
        q: 'If Base64 hides nothing, why is it used so widely?',
        choices: [
          'To carry arbitrary bytes safely through channels that only handle text, such as email, JSON and HTTP headers',
          'To make files smaller',
          'To detect whether data was changed on the way',
          'To slow down anyone trying to read the data',
        ],
        answer: 0,
        why: 'Encodings exist for transport, not for secrecy. Binary data and special characters can break a text-only channel; Base64 rewrites them with characters that pass through unchanged.',
      },
    ],
    refs: ['base64(1)', 'xxd(1)', 'ascii(7)', 'RFC 4648 (Base16, Base32 and Base64 encodings)', 'RFC 7617 (HTTP Basic authentication)'],
  };

  K.lessons.register({
    id: 'data',
    title: 'Encoding, hashing and integrity',
    order: 120,
    summary: 'Read Base64 and hex for what they are, fingerprint files with cryptographic hashes, and verify that a download or a piece of evidence is exactly what it should be.',
    lessons: [encodeLesson],
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
