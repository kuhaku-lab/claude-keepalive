# Open work / next steps

Picking up where the May 2026 session ended.

Status at last commit:
- Unit tests pass (14 / 14), typecheck clean, biome clean.
- e2e smoke (`pnpm smoke:warm`) verified that the warm-keepalive trick works end-to-end against a real `claude` CLI — see `scripts/warm-smoke.mjs` and the entry in `.claude/skills/keepalive-session/SKILL.md` §"TTY is NOT required".

---

## 🔴 #1 — fresh-conversation strategy (BLOCKING)

**The problem.** [[keepalive-invariants]] rule 1 says "process-warm, not conversation-warm". Today, our `WarmSession` keeps `claude` running across requests, which means request N+1 sees request N's conversation history. The Phase B smoke happened to give correct answers because the prompts ("ALIVE", "WARM") were unrelated, but a real workload — e.g. a Multica task runner — will leak context across tasks. That breaks the isolation guarantee consumers depend on and must be fixed before calling this v0.1.

**Where it surfaces in the code.**
- `src/session/framing.ts::enqueuePrompt` — currently just writes the prompt text. Doesn't issue a conversation reset.
- `src/session/warm-session.ts::run` — owns the per-request lifecycle, the natural place to call a "reset" before `enqueuePrompt`.

**Three candidate strategies.**

### (a) Inject `/clear` (or equivalent) as a prompt before each real request

The CLI has a `/clear` slash command for the interactive REPL. If the agent receives `/clear` as the `reason` of a `{decision:'block', ...}`, does it act on it the same way it does when typed at the prompt? **Unknown — empirically untested.** Slash commands may be parsed by the CLI front-end before reaching the agent, in which case injecting `/clear` via the hook does nothing.

- **Cost:** 1 extra round-trip per request (~6–10s with the warm latencies we measured).
- **Risk:** mechanism may not work — needs a smoke before we commit.
- **Reversibility:** easy to add/remove from framing.

### (b) Tell the agent in `--append-system-prompt` to treat each turn as independent

Extend the system-prompt contract: *"Each prompt you receive is a fresh, independent task. Ignore the content of all previous turns when forming your response."* The agent self-enforces.

- **Cost:** zero extra round-trips.
- **Risk:** relies on agent compliance. Strong models follow this well in practice but it's not a hard guarantee. Conversation history still grows in claude's context window → eventual context overflow at ~200K tokens.
- **Reversibility:** trivial — it's one string.

### (c) Recycle the process every N requests

Keep the warm session for N requests (configurable, default e.g. 50), then evict and respawn. Already supported by `maxRequestsPerSession` in `PoolOptions`. We just need to set a sensible default.

- **Cost:** one cold-start every N requests. With N=50 and 12s cold-start, that's 0.24s amortised per request.
- **Risk:** none — uses existing eviction machinery.
- **Reversibility:** trivial.

### Recommended path

**Combine (b) + (c)**: agent-side instruction (b) covers most cases at zero cost; periodic recycle (c) bounds context-window blowup. Add (a) only if we observe leakage in workloads that (b) can't handle.

Next concrete steps:
1. Add the "each turn is independent" sentence to `fileTransportFraming.systemPrompt` in `src/session/framing.ts`.
2. Set `defaultPoolOptions.maxRequestsPerSession = 50` (currently 100; pick after measuring context drift).
3. Write a smoke that proves leakage is bounded: send "remember the number 17" then a different unrelated request, assert the response of #2 doesn't mention 17.
4. Only if #3 fails: investigate (a) — try `/clear` injection and observe whether claude honors it via hook channel.

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

## 🟢 #5 — integration / e2e test layers

`vitest.config.ts` declares `test/integration` and `test/e2e` directories but only `test/unit` exists today. Layer plan:

- `test/integration/` — real tmpdir, real bash hook script, fake `claude` binary (a script that pretends to be claude and exercises the framing protocol). < 2s each.
- `test/e2e/` — real `claude` binary; smoke only; off by default in CI to control API spend.

`scripts/warm-smoke.mjs` is essentially an e2e test wearing a smoke costume — it could be lifted into `test/e2e/warm.test.ts` behind an env gate (`RUN_E2E=1`).

---

## 🟢 #6 — `.responded` cleanup on hard kill

After `pnpm smoke:warm`, the session dir leaves a stale `.responded` flag (claude was killed by `close()` between response and the next stop-hook fire). On a *next* spawn under the same session id, the leftover flag would trick the hook into thinking a request was just answered. Today this isn't a practical problem because `random.sessionId()` generates fresh ids and `destroy()` runs `rm -rf` on the dir, but verify the destroy path actually deletes the dir (the current `WarmSession.destroy()` only `SIGTERM`s the process — it doesn't rm the state dir).

---

## 📋 Reference

- Skills (live spec): `.claude/skills/keepalive-*/SKILL.md`
- Architecture invariants: `.claude/skills/keepalive-invariants/SKILL.md`
- Verified e2e: `pnpm smoke:warm` (real `claude` round-trip; ~12s cold, ~7s warm)
