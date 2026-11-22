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

  /* ------------------------------------------------------------------ hash */
  const hashLesson = {
    id: 'data-hash',
    title: 'Hashing: a fingerprint for data',
    minutes: 11,
    objectives: [
      'Compute MD5 and SHA-256 digests of files and of text with `md5sum` and `sha256sum`',
      'Show that identical content gives an identical digest and that a one-character change gives a completely different one',
      'Compare a computed digest with a published one',
      'Explain why MD5 and SHA-1 are no longer trusted for security and SHA-256 is',
    ],
    intro: T(
      'A cryptographic hash function reads any amount of data and produces a short, fixed-length digest. The same input always gives the same digest, and changing even one character gives a completely different one. That makes a digest a fingerprint: a way to tell whether two files are identical, or whether a file changed, without comparing them byte by byte.',
      '',
      'On a security workstation you use digests to check downloads, to record that evidence was not altered, and to recognize known files. Unlike an encoding, a digest cannot be turned back into the original data. You practice on small files under `' + HASHING + '`. Nothing here changes any file.'
    ),
    steps: [
      {
        id: 'md5',
        prompt: T(
          'Start with the older tool. Move to the practice folder and fingerprint the load manifest with `md5sum`:',
          '',
          '```',
          'cd ' + HASHING,
          'md5sum manifest.txt',
          '```',
          '',
          'The output has two columns: the digest, then the file name. An MD5 digest is 32 hexadecimal characters. You will use the digest of this file again in a moment.'
        ),
        hint: 'Change into the folder with `cd`, then give `md5sum` the file name. `&&` lets you do both on one line.',
        solution: 'cd ' + HASHING + ' && md5sum manifest.txt',
        check: { cmd: 'md5sum', out: /da65ee49163377b7264cd0390999fd02\s+manifest\.txt/ },
      },
      {
        id: 'sha256',
        prompt: T(
          'Now the same file with `sha256sum`, the algorithm you should prefer today:',
          '',
          '```',
          'sha256sum manifest.txt',
          '```',
          '',
          'Same layout, but a longer digest. The digest length depends on the algorithm and never on the size of the file: a one-line file and a four-gigabyte image both produce a digest of the same length.'
        ),
        hint: 'Use the same pattern as before with `sha256sum` instead of `md5sum`.',
        solution: 'sha256sum manifest.txt',
        check: { cmd: 'sha256sum', out: /6071f1dff00e87b5ca3f26e5144c93520bb00e5ec7def7cbbb2dc79c1e111c2c\s+manifest\.txt/ },
      },
      {
        id: 'length',
        prompt: 'Count the hexadecimal characters in the SHA-256 digest on your screen. How many are there?',
        hint: 'MD5 gave 32 characters. SHA-256 is twice as long, because its name states its size in bits and every hex character is 4 bits.',
        solution: '64',
        answer: /^64( characters| hex characters| hex digits)?$/i,
      },
      {
        id: 'same',
        prompt: T(
          'Two files can have different names and the same content. `manifest-copy.txt` is a copy of `manifest.txt`. Fingerprint both with one command:',
          '',
          '```',
          'sha256sum manifest.txt manifest-copy.txt',
          '```',
          '',
          'Compare the first column of the two lines. The digest depends only on the content, never on the file name, the date or the owner. This is how you confirm that a copy is exact.'
        ),
        hint: 'Give `sha256sum` both file names, separated by a space.',
        solution: 'sha256sum manifest.txt manifest-copy.txt',
        check: { cmd: ['sha256sum', 'md5sum'], argsRe: /manifest-copy\.txt/, out: /\b([0-9a-f]{32,64})\s+manifest\.txt\s+\1\s+manifest-copy\.txt/ },
      },
      {
        id: 'diff',
        prompt: T(
          '`manifest-edited.txt` is a third version in which someone changed one character. Find out which with `diff`, which lists the lines that differ:',
          '',
          '```',
          'diff manifest.txt manifest-edited.txt',
          '```',
          '',
          '`<` marks the line in the first file and `>` the line in the second. Only the pallet count changed, from 12 to 13: a single character in a file of about a hundred.'
        ),
        hint: 'Give `diff` the original file first and the edited one second.',
        solution: 'diff manifest.txt manifest-edited.txt',
        check: { cmd: 'diff', out: /Pallets: 12[\s\S]*Pallets: 13/ },
      },
      {
        id: 'avalanche',
        prompt: T(
          'Now fingerprint the original and the edited file together:',
          '',
          '```',
          'sha256sum manifest.txt manifest-edited.txt',
          '```',
          '',
          'One character changed, and the two digests look unrelated. They are not a little different; they differ almost everywhere, with no way to see from the digests where or how much the files differ. Any change at all, from one character to one byte in a large image, gives a new digest. That is what makes a digest useful as a seal.'
        ),
        hint: 'List the original file and the edited one after `sha256sum`.',
        solution: 'sha256sum manifest.txt manifest-edited.txt',
        check: { cmd: 'sha256sum', out: /6071f1df[0-9a-f]{56}\s+manifest\.txt\s+90f4dbb0[0-9a-f]{56}\s+manifest-edited\.txt/ },
      },
      {
        id: 'newline',
        prompt: T(
          'A common trap when you hash text typed on the command line: `echo` adds a newline at the end, and the newline is part of the data. Run both forms and compare:',
          '',
          '```',
          'echo "hello" | md5sum; echo -n "hello" | md5sum',
          '```',
          '',
          'The option `-n` leaves the newline out. The two digests differ because the two inputs differ by one byte. When your digest does not match a published one, check the invisible characters first.',
          '',
          'Digests also cannot be reversed. Nothing can turn `5d41402a...` back into `hello` except guessing inputs and hashing them to see which matches, which is why short, guessable inputs such as simple passwords are weak even when hashed.'
        ),
        hint: 'Put both pipelines on one line with `;` between them. `echo -n` suppresses the newline.',
        solution: 'echo "hello" | md5sum; echo -n "hello" | md5sum',
        check: { cmd: 'md5sum', out: /b1946ac92492d2347c6235b4d2611184[\s\S]*5d41402abc4b2a76b9719d911017c592/ },
      },
      {
        id: 'published',
        prompt: T(
          'Vendors often publish a digest next to a download so you can check what you received. `agent.conf` came with a note, `published.txt`. Compute the SHA-1 digest of the file and read the published value in the same command:',
          '',
          '```',
          'sha1sum agent.conf && cat published.txt',
          '```',
          '',
          'SHA-1 digests are 40 hex characters. Compare them carefully: with a digest, a match must be complete, character for character.'
        ),
        hint: '`sha1sum` takes a file name just like the other tools. Join it to `cat published.txt` with `&&`.',
        solution: 'sha1sum agent.conf && cat published.txt',
        check: { cmd: 'sha1sum', out: /44e27d840124242a76647996eb5fc4d3f01fb028\s+agent\.conf[\s\S]*digest:\s+44e27d84/ },
      },
      {
        id: 'match',
        prompt: 'Does the digest you computed match the published one? Answer `yes` or `no`.',
        hint: 'Both lines start with `44e27d84`. Compare them to the end.',
        solution: 'yes',
        answer: /^(yes|match(es)?|they match|same|identical)\.?$/i,
      },
    ],
    quiz: [
      {
        q: 'You hash a 2 GB disk image with SHA-256. How long is the digest?',
        choices: [
          'About 2 GB, a complete copy',
          'About 64 characters, the same length as for a one-line file',
          'It grows with the file, a few kilobytes for 2 GB',
          'It depends on the file type',
        ],
        answer: 1,
        why: 'A hash function compresses any input to a fixed length. For SHA-256 that is 256 bits, written as 64 hexadecimal characters.',
      },
      {
        q: 'Two files have exactly the same SHA-256 digest but different names and dates. What do you conclude?',
        choices: [
          'They are different files that happen to be related',
          'Their contents are identical, and the name and date do not matter',
          'One of them has been encrypted',
          'The digest is broken and cannot be trusted',
        ],
        answer: 1,
        why: 'The digest is computed from the content alone. With a trusted algorithm such as SHA-256, equal digests mean equal content in practice.',
      },
      {
        q: 'Someone changes one letter in a 500 MB file and hashes it again. What does the new digest look like next to the old one?',
        choices: [
          'Almost identical, with a few characters changed',
          'The same length but completely different, with no resemblance to the old one',
          'Longer by one character',
          'Identical, because one letter is too small to matter',
        ],
        answer: 1,
        why: 'Hash functions are built so that any change spreads through the whole digest. That is why a digest detects even the smallest alteration.',
      },
      {
        q: 'Why should you use SHA-256 rather than MD5 or SHA-1 to protect against tampering?',
        choices: [
          'MD5 and SHA-1 digests are too short to store',
          'Practical collisions, two different inputs with the same digest, have been demonstrated for MD5 and SHA-1, so an attacker could craft a changed file with a matching digest',
          'MD5 and SHA-1 can be decoded back to the original file',
          'SHA-256 is faster than the others',
        ],
        answer: 1,
        why: 'Collision attacks against MD5 and SHA-1 are practical, so they no longer prove a file is the intended one against an attacker. They still catch accidental corruption. Hashes cannot be decoded at all, and SHA-256 is slower, not faster.',
      },
    ],
    refs: ['md5sum(1)', 'sha256sum(1)', 'sha1sum(1)', 'diff(1)', 'NIST FIPS 180-4 (Secure Hash Standard)', 'RFC 6151 (updated security considerations for MD5)'],
  };

  /* ----------------------------------------------------------------- verify */
  const verifyLesson = {
    id: 'data-verify',
    title: 'Verifying a download',
    minutes: 11,
    objectives: [
      'Verify files against a checksum file with `sha256sum -c` and read `OK` and `FAILED`',
      'Tell a damaged or altered file from a good one and recover from it',
      'Check only the files you actually have with `--ignore-missing`',
      'Explain why Kali publishes a signed `SHA256SUMS` file and what the signature adds',
    ],
    intro: T(
      'You will download disk images, tools and updates for as long as you do this work, and a download can be damaged on the way or replaced by someone who wants you to run their version. A checksum is how you tell: the publisher lists the expected digest of every file, and you compute the digest of what you received and compare.',
      '',
      '`sha256sum -c` does the comparing for you. In this lesson you check a small training release, damage one file, and read the failure. The last step explains the part a checksum cannot do alone, which is why real Kali images are checked against a signed file.'
    ),
    steps: [
      {
        id: 'copy',
        prompt: T(
          'The release is stored read-only in `' + RELEASE + '`. Copy it into your own practice folder so that you can change files without touching the original:',
          '',
          '```',
          'mkdir -p ~/practice/data',
          'cp -r ' + RELEASE + ' ~/practice/data/',
          '```',
          '',
          '`mkdir -p` creates the folder and does not complain if it exists. `cp -r` copies a folder and everything in it. Repeating this step later restores the originals.'
        ),
        hint: 'Create `~/practice/data` with `mkdir -p`, then use `cp -r` with the release folder as the source and `~/practice/data/` as the destination.',
        solution: 'mkdir -p ~/practice/data && cp -r ' + RELEASE + ' ~/practice/data/',
        check: { file: { path: WORK + '/release/SHA256SUMS', exists: true, type: 'file' } },
      },
      {
        id: 'sums',
        prompt: T(
          'Go into the copy and read the checksum file that came with it:',
          '',
          '```',
          'cd ~/practice/data/release',
          'cat SHA256SUMS',
          '```',
          '',
          'Each line is a digest, two spaces, then a file name: exactly the format that `sha256sum` prints, which is what lets `sha256sum` read it back.'
        ),
        hint: 'Change into `~/practice/data/release`, then print `SHA256SUMS` with `cat`.',
        solution: 'cd ~/practice/data/release && cat SHA256SUMS',
        check: { cmd: 'cat', cwd: WORK + '/release', out: /depot-agent\.sh/ },
      },
      {
        id: 'count',
        prompt: 'How many files does `SHA256SUMS` list?',
        hint: 'Count the lines in the output. Each line is one file.',
        solution: '3',
        answer: /^(3|three)( files)?$/i,
      },
      {
        id: 'check',
        prompt: T(
          'Now let the tool do the comparison. The option `-c` (*check*) reads the digests from the file, computes each digest again and reports:',
          '',
          '```',
          'sha256sum -c SHA256SUMS',
          '```',
          '',
          'Each file is reported as `OK` when its digest matches. The exit status is 0 only when every file matched, which makes the command easy to use in scripts.'
        ),
        hint: 'Run `sha256sum` with `-c` and the name of the checksum file.',
        solution: 'sha256sum -c SHA256SUMS',
        check: { cmd: 'sha256sum', args: ['-c'], exit: 0, out: /depot-agent\.conf: OK/ },
      },
      {
        id: 'tamper',
        prompt: T(
          'Now simulate a bad copy. Real causes are a broken transfer or a file replaced on the way; here you add one line to the configuration yourself:',
          '',
          '```',
          'echo "# edited" >> depot-agent.conf',
          '```',
          '',
          '`>>` appends to the file. One short comment line, which would not change how the program works, is enough to change its digest.'
        ),
        hint: 'Use `echo` with `>>` to append text to `depot-agent.conf`.',
        solution: 'echo "# edited" >> depot-agent.conf',
        check: { file: { path: WORK + '/release/depot-agent.conf', contains: /# edited/ } },
      },
      {
        id: 'failed',
        prompt: T(
          'Run the same check again:',
          '',
          '```',
          'sha256sum -c SHA256SUMS',
          '```',
          '',
          'Read the result line by line. Files that still match say `OK`; the changed one says `FAILED`. At the end `sha256sum` prints a warning counting the mismatches, and the exit status is 1.'
        ),
        hint: 'The command is the same as in the earlier check step.',
        solution: 'sha256sum -c SHA256SUMS',
        check: { cmd: 'sha256sum', args: ['-c'], exit: 1, out: /depot-agent\.conf: FAILED/ },
      },
      {
        id: 'which',
        prompt: 'Which file failed the check? Type its name.',
        hint: 'Look for the line that ends in `FAILED`.',
        solution: 'depot-agent.conf',
        answer: /^(\.\/)?depot-agent\.conf$/i,
      },
      {
        id: 'restore',
        prompt: T(
          'A `FAILED` file is not to be installed or run. The correct response is to get a fresh copy from the source and check it again, not to edit the file until it passes. Here the original is in `' + RELEASE + '`, so copy the configuration back and verify:',
          '',
          '```',
          'cp ' + RELEASE + '/depot-agent.conf . && sha256sum -c SHA256SUMS',
          '```',
          '',
          'All three lines should read `OK` again. If a fresh copy still failed, the problem would be at the source, and that is worth reporting.'
        ),
        hint: 'Copy `depot-agent.conf` from the release folder to the current directory (`.`), then run the check again.',
        solution: 'cp ' + RELEASE + '/depot-agent.conf . && sha256sum -c SHA256SUMS',
        check: { cmd: 'sha256sum', args: ['-c'], exit: 0, out: /depot-agent\.conf: OK/ },
      },
      {
        id: 'missing',
        prompt: T(
          'A checksum file often lists more files than you downloaded. The Kali `SHA256SUMS` lists every image, and you only fetch one. Simulate this by deleting one file and checking again with `--ignore-missing`:',
          '',
          '```',
          'rm README.txt && sha256sum -c --ignore-missing SHA256SUMS',
          '```',
          '',
          'Without the option, the missing file is reported as `FAILED open or read`. With it, files that are not present are skipped and the ones you have are checked. Run the `cp -r` step again whenever you want the full release back.'
        ),
        hint: 'Remove `README.txt` with `rm`, then add `--ignore-missing` to the check.',
        solution: 'rm README.txt && sha256sum -c --ignore-missing SHA256SUMS',
        check: { cmd: 'sha256sum', args: ['--ignore-missing'], exit: 0, out: /depot-agent\.sh: OK/, not: { out: /FAILED/ } },
      },
      {
        id: 'signed',
        info: true,
        prompt: T(
          'A checksum proves that your file equals the one the checksum describes. It does not prove that the checksum itself is genuine. If an attacker can replace the image on a mirror, they can replace the `SHA256SUMS` next to it, and everything will report `OK`.',
          '',
          'That is why Kali publishes a signature for its `SHA256SUMS` file, `SHA256SUMS.gpg`. A digital signature is made with a private key that only the Kali team holds, and anyone can check it with the matching public key. Checking it, with a tool such as `gpg`, tells you that the checksum file came from the holder of that key and was not altered. You then trust the images through the chain: signature, then checksum file, then image.',
          '',
          'The public key has to come from somewhere you trust. The Kali project publishes its key fingerprint on its website, and the documentation describes the exact steps. The training simulator does not include `gpg`, so you read about this step instead of running it; on a real download, do it every time.'
        ),
      },
    ],
    quiz: [
      {
        q: 'You download an image and its `SHA256SUMS` from the same mirror, and the check says `OK`. What have you shown?',
        choices: [
          'That the image is genuine, whoever published it',
          'That the image matches the checksum file, which is only meaningful if that file is genuine',
          'That the image contains no malware',
          'That the mirror is Kali\'s own server',
        ],
        answer: 1,
        why: 'The check compares two things from the same place. Someone who controlled the mirror could change both. The signature on the checksum file is what links it to the publisher.',
      },
      {
        q: '`sha256sum -c SHA256SUMS` prints `FAILED` for one file. What is the right next step?',
        choices: [
          'Edit the checksum file so that it matches',
          'Use the file anyway, since one file in three is fine',
          'Discard the file and download it again from the source, then check again',
          'Run the check again until it says `OK`',
        ],
        answer: 2,
        why: 'The file is not what the publisher described. Changing the checksum defeats the purpose, and repeating the check on the same bytes gives the same answer.',
      },
      {
        q: 'What does the exit status of `sha256sum -c` tell a script?',
        choices: [
          '0 when every listed file matched, non-zero when any did not',
          'The number of files checked',
          '0 only when the checksum file is signed',
          'It is always 0 unless the command is mistyped',
        ],
        answer: 0,
        why: 'The status summarizes the whole run, so a script can stop with `sha256sum -c SHA256SUMS || exit 1` before installing anything.',
      },
      {
        q: 'Which addition to the checksum workflow protects against an attacker who replaces both the image and the `SHA256SUMS` file on a mirror?',
        choices: [
          'Using MD5 as well as SHA-256',
          'Downloading the checksum file twice',
          'Verifying the publisher\'s digital signature of the checksum file with a key you obtained separately',
          'Renaming the image',
        ],
        answer: 2,
        why: 'Only the publisher can create a valid signature, so a replaced checksum file fails the signature check. Extra hashes and repeated downloads from the same place prove nothing about who published them.',
      },
    ],
    refs: ['sha256sum(1)', 'cp(1)', 'gpg(1)', 'Kali Linux Revealed, ch. 2 (downloading and verifying the image)'],
  };

  K.lessons.register({
    id: 'data',
    title: 'Encoding, hashing and integrity',
    order: 120,
    summary: 'Read Base64 and hex for what they are, fingerprint files with cryptographic hashes, and verify that a download or a piece of evidence is exactly what it should be.',
    lessons: [encodeLesson, hashLesson, verifyLesson],
  });

})(typeof globalThis !== 'undefined' ? globalThis : this);
