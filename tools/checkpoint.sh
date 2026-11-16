#!/usr/bin/env bash
# Commit and push a set of files atomically, safe to call from several
# agents working in the same tree at once.
#   tools/checkpoint.sh "commit subject" path [path...]
# Only the named paths are committed. Push failures are tolerated (the next
# checkpoint pushes again).
set -u
msg="${1:?commit subject required}"; shift
[ "$#" -gt 0 ] || { echo "checkpoint: no paths given" >&2; exit 2; }
cd "$(git rev-parse --show-toplevel)" || exit 1
branch="$(git rev-parse --abbrev-ref HEAD)"
exec 9>"${TMPDIR:-/tmp}/kalima-checkpoint.lock"
flock -w 120 9 || { echo "checkpoint: could not get the lock" >&2; exit 1; }
existing=()
for p in "$@"; do [ -e "$p" ] && existing+=("$p"); done
[ "${#existing[@]}" -gt 0 ] || { echo "checkpoint: nothing to commit"; exit 0; }
git add -- "${existing[@]}" || exit 1
if git diff --cached --quiet -- "${existing[@]}"; then echo "checkpoint: no changes"; exit 0; fi
git commit -q -m "$msg" \
  -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01D1buvMtBPsbNpfkop6fkpv" -- "${existing[@]}" || exit 1
echo "checkpoint: committed $(git rev-parse --short HEAD) ($msg)"
for i in 1 2 3; do
  git push -q origin "HEAD:${branch}" 2>/dev/null && { echo "checkpoint: pushed"; exit 0; }
  sleep $((i * 2))
done
echo "checkpoint: push failed, will retry on the next checkpoint" >&2
exit 0
