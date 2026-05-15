# Integration tests

This layer sits between `test/unit/` (no real process, no real fs) and
`test/e2e/` (real `claude` CLI, real API tokens). Tests here:

- May use a **real `tmpdir`** for session state directories.
- May spawn **real bash / shell subprocesses** to exercise scripts we ship
  (e.g. `stop-hook.sh` from `renderHookScript`).
- May NOT spawn a real `claude`. For that, see `test/e2e/`.
- Should run in **< 2 seconds each**.

The goal: catch bugs that only surface when our code meets the filesystem
or a real subprocess, without paying the API cost of `claude` itself.

## What lives here today

- `hook-script.test.ts` — runs `renderHookScript`'s output through real
  bash with real flag files to verify each branch of the stop-hook script.

## What should live here later

- A fake-`claude` subprocess (a small Node script that mimics the hook
  payload contract) exercised through `WarmSession` end-to-end. This is
  the natural target for testing crash recovery, response file races, and
  spawn-timeout error paths without API spend. Tracked in TODO.md.
