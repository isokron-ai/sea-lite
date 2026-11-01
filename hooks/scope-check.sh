#!/usr/bin/env bash
# PreToolUse hook for Claude Code (matcher: Edit|Write|MultiEdit).
#
# Reads the hook event from stdin, takes the file the agent is about to
# edit, makes it repo-relative, and asks sea-lite whether another actor's
# live claim scope covers it. A conflict exits 2, which blocks the edit and
# feeds the holder / ticket / expiry back to the agent so it can claim the
# path, pick other work, or wait.
#
# Env (all optional):
#   SEA_LITE_ACTOR          your actor label (must match the one your
#                           sea-lite MCP server runs with, or your own
#                           claims will read as conflicts)
#   KRONICLE_LITE_DATA_DIR  the shared store
#   SEA_LITE_BIN            command to run (default: npx -y sea-lite)
#   SEA_LITE_HOOK_FAIL_OPEN set to 1 to let the edit through when sea-lite
#                           itself cannot be reached (default: block)
set -u

input="$(cat)"
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# Node does the path work so Windows paths (C:\repo\src\x.ts, mixed
# separators, drive-letter case) relativize the same way POSIX ones do.
# Prints the repo-relative path with forward slashes, or nothing when the
# event is not a file edit or the file is outside the repo.
rel="$(printf '%s' "$input" | node -e '
  const path = require("path"); const root = process.argv[1];
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const t = JSON.parse(s).tool_input || {};
      const f = t.file_path || t.notebook_path || "";
      if (!f) return;
      const rel = path.relative(root, path.resolve(root, f));
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return; // outside the repo: not ours to fence
      process.stdout.write(rel.split(path.sep).join("/"));
    } catch { /* not JSON: nothing to check */ }
  });' "$root")"
[ -z "$rel" ] && exit 0

bin="${SEA_LITE_BIN:-npx -y sea-lite}"
out="$($bin scope-check --paths "$rel" ${SEA_LITE_ACTOR:+--actor "$SEA_LITE_ACTOR"} 2>&1)"
code=$?
case $code in
  0) exit 0 ;;
  1)
    printf 'sea-lite scope conflict on %s:\n%s\nClaim the path (sea_claim / sea_next with scope.paths), wait for the lease to lapse, or take other work.\n' "$rel" "$out" >&2
    exit 2 ;;
  *)
    if [ "${SEA_LITE_HOOK_FAIL_OPEN:-0}" = "1" ]; then
      printf 'sea-lite scope-check unavailable (%s); allowing edit\n' "$out" >&2
      exit 0
    fi
    printf 'sea-lite scope-check failed (exit %s): %s\n' "$code" "$out" >&2
    exit 2 ;;
esac
