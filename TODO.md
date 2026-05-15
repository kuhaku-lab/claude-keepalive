# Open work / next steps

Picking up where the May 2026 session ended.

Status at last commit:
- Unit + integration tests pass (16 / 16), typecheck clean, biome clean.
- e2e smoke (`pnpm smoke:warm`) verified that the warm-keepalive trick works end-to-end against a real `claude` CLI — see `scripts/warm-smoke.mjs` and the entry in `.claude/skills/keepalive-session/SKILL.md` §"TTY is NOT required".
- Leakage smoke (`pnpm smoke:leakage`) verified that the fresh-conversation contract holds on a single warm session (TODO #1 closed).
- Three-layer test setup live (`test/unit/` + `test/integration/` + `test/e2e/`); `RUN_E2E=1` gates the real-`claude` layer.
- v0.0.1 published to npm 2026-05-15. v0.1.0 candidate: closes #1, #5, #6.

---

## ✅ #1 — fresh-conversation strategy (RESOLVED, 2026-05-15)

Strategies (b) + (c) implemented and verified:

- **(b) System-prompt instruction**: `fileTransportFraming.systemPrompt` now tells the agent that each prompt is an INDEPENDENT TASK and explicitly forbids referencing prior turns (e.g. "if a previous turn mentioned 'the number 17' and the current turn asks an unrelated question, you must not reference 17").
- **(c) Bounded recycle**: `defaultPoolOptions.maxRequestsPerSession` lowered from 100 → 50 to cap context-window drift.

Verified by `pnpm smoke:leakage`:

```
request #1: "Remember this number: 17. Reply with 'ok'."  → "ok"
request #2: "What is the capital of Japan? Answer in one word."  → "Tokyo"
both on same warm session — no "17" in response #2.
```

Strategy (a) (`/clear` injection) remains unexplored — only investigate if a future workload surfaces a leak (b)+(c) can't catch. The smoke is the regression gate; rerun it after any change to `framing.ts` or `pool.ts` defaults.

---

## ✅ #2 — `.ready` handshake wait (RESOLVED in v0.1.4)

`spawnWarmProcess` now polls for `paths.lastTick` after launching `claude` and only returns when the first stop-hook fire has completed (= claude is booted and idling). Bounded by `spawnTimeoutMs`; rejects with the new `SPAWN_TIMEOUT` error code if claude never gets there. The doomed process is SIGTERM'd on the failure path so we don't leak zombies.

This unblocked `prewarm()` (v0.1.4 #3) — without a real readiness signal, prewarm could only promise "spawn fired", not "ready to serve".

---

## ✅ v0.1.4 — prewarm() + warmupPrompt (RESOLVED)

Three changes shipped together (cf. `pnpm test:unit -- test/unit/prewarm.test.ts`):

- `Pool.prewarm()` — spawns up to `size` sessions in parallel; idempotent.
- `KeepaliveClient.prewarm()` — calls Pool.prewarm(), then (if `warmupPrompt` is set) runs that prompt on every warm session and discards the result.
- `ClientOptions.warmupPrompt?: string` — analogous to Anthropic's prompt-caching pre-warming pattern, but applied at our warm-pool layer. Without it, prewarm only zeroes out CLI spawn cost; with it, Anthropic's prompt cache is also pre-filled.

New public error code: `SPAWN_TIMEOUT`.

---

## 🟡 #3 — `mode: 'print'` opt-in

`.claude/skills/keepalive-public-api/SKILL.md` documents `ClientOptions.mode = 'interactive' | 'print'`, but the print path is not wired into `createClient` yet. The OneShot factory in `scripts/smoke.mjs` is the prototype; it should be hoisted into `src/session/` as a public-but-opt-in `printModeFactory` and selected by `createClient` when `opts.mode === 'print'`.

Reminder: setting print mode silently is forbidden ([[keepalive-invariants]] rule 9) — keep the opt-in explicit.

---

## 🟡 #4 — token-level streaming in print mode

In `mode: 'print'`, the underlying `claude -p --output-format stream-json --include-partial-messages` can emit per-token events. Today the OneShot prototype only yields one big `{type:'token'}` followed by `done`. To deliver true streaming in print mode (the documented contract in `.claude/skills/keepalive-public-api/SKILL.md` §"Stream granularity by mode"), parse the stream-json output and translate event types.

---

## ✅ #5 — integration / e2e test layers (RESOLVED, 2026-05-15)

Three-layer split implemented:

- `test/unit/` — < 50 ms each, no real process, no real fs. 5 files / 11 tests.
- `test/integration/` — real tmpdir, real bash subprocess for hook script. 2 files / 5 tests. `hook-script.test.ts` was lifted here from `test/unit/` because it always was integration-shaped; `destroy-cleanup.test.ts` (from #6) joined.
- `test/e2e/` — real `claude` CLI, gated by `RUN_E2E=1` env var (set automatically by `pnpm test:e2e`). 1 file / 2 tests (`warm.test.ts`: lifted from `scripts/warm-smoke.mjs`, covers warm-session reuse + leakage guard).

`pnpm test` runs unit + integration cheaply; e2e is opt-in to control API spend. `vitest.config.ts` excludes `test/e2e/**` unless `RUN_E2E=1` is set, with `passWithNoTests: true` so layer-specific scripts don't fail on empty dirs.

A fake-`claude` Node subprocess for the integration layer (originally planned here) is still useful but deferred — none of the bugs we've seen so far would have been caught by it; revisit when one surfaces.

---

## ✅ #6 — destroy() cleans state dir (RESOLVED, 2026-05-15)

`WarmSession.destroy()` now removes `paths.root` after SIGTERM, so a future spawn that happens to draw the same session id never inherits stale `.responded`, `.prompt`, or partial response captures. Verified by `test/integration/destroy-cleanup.test.ts` (state-dir removal + idempotency).

---

## ✅ v0.1.1 — drain + stderr tail (RESOLVED, 2026-05-15)

`WarmSession` was never reading from the child's stdout/stderr pipes, causing potential SIGPIPE on long-running claude output. Fixed by attaching passive data listeners, retaining the last 4 KB of stderr, and surfacing it via `console.error` and the new `session.evicted.detail` field. This patch was load-bearing for finding the next bug (see v0.1.2).

---

## ✅ v0.1.2 — stdin EOF for true interactive mode (RESOLVED, 2026-05-15)

The test-service smoke (examples/test-service + curl) revealed via v0.1.1's stderr-tail that claude was hitting `Warning: no stdin data received in 3s, proceeding without it.` and exiting cleanly with code 0 — the warm-keepalive trick was never engaging. Root cause: `stdio: ['pipe', 'pipe', 'pipe']` left an open-but-empty stdin pipe that claude read for input. Fixed by switching to `stdio: ['ignore', 'pipe', 'pipe']` so claude sees stdin EOF immediately and enters its interactive Stop-hook idle loop.

---

## 🟡 #7 — investigate idle-tick latency cost

Empirical observation in 2026-05 with claude 2.1.141: on a warm session, the wall time for request N+1 can exceed request N+0 (the cold spawn). Hypothesis: each idle "--- TURN START ---" tick triggers a non-trivial agent turn (claude responds with ".", Stop hook fires again). When request N+1 arrives mid-idle, framing waits for the current idle turn to complete before its prompt is injected.

If true, the warm-pool value drops: spawn savings (~5 s) are offset by idle-tick overhead (~3–5 s per tick). Mitigations to evaluate:

1. **Make idle responses cheaper**: tune the system prompt so claude responds to `--- TURN START ---` with a literal single character or empty string, ideally zero token.
2. **Tighten the idle interval**: drive Stop-hook firing only when there's work, not constantly. Today the hook fires on every stop; we could investigate whether claude needs a Stop reason on every stop or whether we can let some stops succeed (which would terminate the session — probably not what we want).
3. **Stream the prompt injection earlier**: drive `.in-request` write earlier in the request lifecycle so the next Stop-hook fire (rather than the second-next) picks it up.

Action: instrument `warm-smoke.mjs` to print timing breakdown (spawn / first-Stop-fire / response / between-requests / second-response) so we know where time is spent.

---

## 📋 Reference

- Skills (live spec): `.claude/skills/keepalive-*/SKILL.md`
- Architecture invariants: `.claude/skills/keepalive-invariants/SKILL.md`
- Verified e2e: `pnpm smoke:warm` (real `claude` round-trip; ~12s cold, ~7s warm)
