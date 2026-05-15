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

## 🟡 #2 — `.ready` handshake wait in `spawn.ts`

`src/session/spawn.ts::spawnWarmProcess` returns immediately after `launch()`. There's a TODO marker in the code. Today the first request just polls the response file until claude finishes booting (~5–10s) and writes a response, so the slow boot manifests as a slow first request rather than a clean error. Two problems:

- If claude fails to boot (bad binary, settings.json malformed), the first request will silently TIMEOUT with no diagnostic about boot vs runtime.
- We can't distinguish "spawn in flight" from "spawn complete" at the pool level, which makes accurate metrics hard.

**Fix.** Wait for the first `.last-tick` write (proof the stop hook fired at least once = claude is booted and idling). Bound by `spawnTimeoutMs`. Reject with a structured error if exceeded.

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

## 📋 Reference

- Skills (live spec): `.claude/skills/keepalive-*/SKILL.md`
- Architecture invariants: `.claude/skills/keepalive-invariants/SKILL.md`
- Verified e2e: `pnpm smoke:warm` (real `claude` round-trip; ~12s cold, ~7s warm)
