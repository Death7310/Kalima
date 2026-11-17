# Kalima

An offline training simulator for Kali Linux 2026.3. One HTML file gives you a
Kali-style terminal, a simulated filesystem, a fictional lab network with a
simulated internet behind it, and guided lessons that check what you actually
type. Nothing in it touches a real network.

## Run it

Open `dist/kalima.html` in a browser. That is the whole application: no
install, no server, no connection. It works on a phone as well as a desktop.

Log in is automatic as `kali` (password `kali`, used by `sudo`). Your home
directory, settings and lesson progress are kept in the browser's local storage.

## What is simulated

- **Shell.** Kali's zsh prompt with pipes, redirection, variables, globs,
  quoting, loops, conditionals, functions, scripts, job control, history and
  Tab completion.
- **Filesystem.** A Debian-style tree with owners, groups, permission bits, the
  sticky bit and `sudo`, so "Permission denied" means what it means on a real
  system.
- **Network.** Routing, ICMP, TCP and UDP, DNS and HTTP are modelled, so
  `ping`, `traceroute`, `dig` and `curl` behave as they would online: latency
  and jitter, TTLs, silent hops, unreachable hosts, NXDOMAIN, self-signed
  certificates.
- **A lab.** The fictional *Halcyon Freight* network (`10.10.10.0/24`, eleven
  hosts) with web, file, mail, DNS and database servers, a Windows server, a
  printer and a camera. Some hosts accept logins with a client-supplied test
  account, and they log what you do to them, so you can read your own activity
  from the defender's side.
- **Tools.** The everyday Linux and networking toolset with the output formats
  of the real programs. `man` pages are built in.

## What is deliberately not simulated

Kali ships more than 600 tools. Faking all of them would teach none of them
well, so the simulator goes deep on the foundations every other skill depends
on: the shell, Linux administration, networking, discovery, traffic analysis
and methodology.

Exploitation, password and wireless tooling is catalogued (`kalima atlas`) but
not simulated, and the lessons contain no attack walkthroughs. Tools that
actively probe a target work only inside the lab's engagement scope and explain
why when they refuse; authorization is taught as a habit, not a footnote.

A simulator builds command fluency and the ability to read output. It does not
replace practice on lab machines you own; treat it as the stage before that.

## How the lessons are designed

- **Worked examples, then fading.** Early steps show the exact command and
  explain each part; later steps state a goal and leave the command to you
  (Sweller & Cooper, 1985; Renkl & Atkinson, 2003).
- **Retrieval practice.** Each lesson ends with questions that ask you to
  predict and explain, because testing yourself strengthens retention more than
  rereading does (Roediger & Karpicke, 2006).
- **Reading output is the skill.** Steps ask for values you must read off the
  screen, not only for commands.
- **Methodology first.** The course follows the assessment phases of NIST
  SP 800-115 (planning, discovery, reporting) and stops before the attack phase.

Every lesson is replayed automatically in the test suite: each step's solution
is typed into a fresh simulator and must satisfy the step's check.

## Development

Requires Node 22 or later. There are no dependencies.

```
npm test            # unit and curriculum tests (headless, virtual time)
npm run build       # writes dist/kalima.html
node tests/e2e/ui.e2e.mjs   # browser tests (needs Playwright with Chromium)
```

Sources are classic scripts in `src/js/` that attach to a global `K` and load
in filename order; the build inlines them into `src/index.html`. The contract
for writing commands, world content and lessons is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

| Path | Contents |
| --- | --- |
| `src/js/00-…35-*.js` | kernel: utilities, filesystem, machines, shell, network engine, world, lesson engine |
| `src/js/40-…42-cmd-*.js` | command packs |
| `src/js/45-*.js`, `48-*.js` | lab content, tool catalogue |
| `src/js/50-lessons-*.js` | curriculum |
| `src/js/60-ui-*.js`, `src/styles/` | browser interface |
| `tests/` | `node:test` suites and the browser end-to-end script |

## References

- Hertzog, R., O'Gorman, J., & Aharoni, M. (2017). *Kali Linux Revealed: Mastering the Penetration Testing Distribution*. Offsec Press.
- Kalyuga, S., Ayres, P., Chandler, P., & Sweller, J. (2003). The expertise reversal effect. *Educational Psychologist, 38*(1), 23–31.
- Petersen, R., Santos, D., Smith, M. C., Wetzel, K. A., & Witte, G. (2020). *Workforce Framework for Cybersecurity (NICE Framework)* (NIST SP 800-181 Rev. 1). National Institute of Standards and Technology.
- Renkl, A., & Atkinson, R. K. (2003). Structuring the transition from example study to problem solving in cognitive skill acquisition. *Educational Psychologist, 38*(1), 15–22.
- Roediger, H. L., & Karpicke, J. D. (2006). Test-enhanced learning: Taking memory tests improves long-term retention. *Psychological Science, 17*(3), 249–255.
- Scarfone, K., Souppaya, M., Cody, A., & Orebaugh, A. (2008). *Technical Guide to Information Security Testing and Assessment* (NIST SP 800-115). National Institute of Standards and Technology.
- Sweller, J., & Cooper, G. A. (1985). The use of worked examples as a substitute for problem solving in learning algebra. *Cognition and Instruction, 2*(1), 59–89.

Everything in the simulated world is fictional. Kali Linux is a trademark of
OffSec Services Limited; this project is not affiliated with or endorsed by it.
