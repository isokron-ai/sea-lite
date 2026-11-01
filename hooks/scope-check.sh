#!/usr/bin/env bash
# PreToolUse hook for Claude Code (matcher: Edit|Write|MultiEdit|NotebookEdit).
#
# `sea-lite scope-check --hook` is the whole hook: it reads the hook JSON on
# stdin (tool_input.file_path, session_id), finds the identity this Claude
# Code session's sea-lite server claims under (docs/THREAT-MODEL.md
# "Identity"), and exits 2 with the holder / ticket / expiry on stderr when
# the file lies inside someone else's live claim. Claude Code blocks the
# edit and shows the agent that reason. A file outside any git repository,
# or a tool call without a file, is let through.
#
# This hook only sees file-editing tools. Edits made through the Bash tool
# (sed -i, redirects, formatters, codegen) bypass it; `sea-lite precommit`
# catches those at commit time.
#
# Env (all optional):
#   SEA_LITE_BIN            command to run (default: sea-lite on PATH, else
#                           npx -y sea-lite@0.4.0 — pin what you install)
#   KRONICLE_LITE_DATA_DIR  the shared store, if not ~/.kronicle-lite
#   SEA_LITE_HOOK_FAIL_OPEN set to 1 to let the edit through when sea-lite
#                           itself fails (default: block)
set -u
if [ -n "${SEA_LITE_BIN:-}" ]; then
  # shellcheck disable=SC2086 # SEA_LITE_BIN may be a command with arguments
  exec $SEA_LITE_BIN scope-check --hook
elif command -v sea-lite >/dev/null 2>&1; then
  exec sea-lite scope-check --hook
else
  exec npx -y sea-lite@0.4.0 scope-check --hook
fi
