import type { SessionPaths } from './paths.js';

/**
 * The stop-hook script that `claude` invokes when it's about to stop.
 *
 * Behavior (per [[keepalive-session]] §"The trick"):
 *
 *   1. If `.responded` flag is present, the previous hook fire injected a
 *      real prompt and the response we just observed is its answer. Clear
 *      the flag and emit an idle block so claude stays warm.
 *
 *   2. If `.in-request` flag is present (and `.responded` is not), the
 *      driver has a real prompt queued in `.prompt`. Set `.responded` so
 *      we recognise the next stop as a response-complete, then emit a
 *      block whose `reason` is the prompt content.
 *
 *   3. Otherwise this is a plain idle stop. Bump the tick counter and
 *      emit a tiny keepalive sentinel.
 *
 * Kept deliberately small: 100% branch coverage is the gate (per
 * keepalive-testing).
 */
export function renderHookScript(paths: SessionPaths): string {
  const idleTick = '--- TURN START ---\\n--- TURN END ---';
  return `#!/usr/bin/env bash
# claude-keepalive stop-hook. Do not edit by hand.
set -u

emit_block() {
  # $1 = reason payload (already JSON-escaped if needed by caller)
  printf '{"decision":"block","reason":%s}\\n' "$1"
  exit 0
}

json_escape() {
  # POSIX-portable JSON string escape via python3, falling back to a
  # minimal sed pipeline. Python is preferred because claude's runtime
  # ships it on every platform we care about.
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))'
  else
    # Minimal escape: backslash, double-quote, newline, carriage return, tab.
    sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' \\
        -e ':a;N;$!ba;s/\\n/\\\\n/g' \\
        -e 's/\\r/\\\\r/g' -e 's/\\t/\\\\t/g' \\
      | awk 'BEGIN{printf "\\""} {printf "%s",$0} END{printf "\\""}'
  fi
}

now_ms() {
  # epoch ms. BSD date (macOS) doesn't support %3N — it silently outputs
  # the literal "%3N", so we can't rely on exit status. Prefer python3.
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time; print(int(time.time()*1000))'
  else
    # GNU date supports %3N; on BSD this returns "<epoch>%3N" which still
    # parses to a number with the suffix stripped, but we prefer a clean
    # number, so multiply seconds by 1000 as a portable fallback.
    awk 'BEGIN{srand(); print srand()*1000}'
  fi
}

# (1) Did we just inject a real prompt? Then this is the response turn.
if [ -f "${paths.responded}" ]; then
  rm -f "${paths.responded}"
  reason=$(printf '%s' "${idleTick}" | json_escape)
  emit_block "$reason"
fi

# (2) Real request queued?
if [ -f "${paths.inRequest}" ] && [ -f "${paths.prompt}" ]; then
  : > "${paths.responded}"
  reason=$(cat "${paths.prompt}" | json_escape)
  emit_block "$reason"
fi

# (3) Idle tick.
now_ms > "${paths.lastTick}"
reason=$(printf '%s' "${idleTick}" | json_escape)
emit_block "$reason"
`;
}
