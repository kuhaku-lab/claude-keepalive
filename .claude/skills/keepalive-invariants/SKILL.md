---
name: keepalive-invariants
description: Architectural rules that must never be broken in the claude-keepalive codebase. Invoke before writing or reviewing code that touches the public API, session pool, warm-session lifecycle, or anything that sees a user prompt. Use when the user asks about "the rules", "invariants", "drop-in semantics", or when a change feels like it might leak state across requests.
---

# claude-keepalive invariants

This project's value proposition is one sentence:

> **A drop-in replacement for `claude -p` that eliminates cold-start by reusing warm `claude` processes — without leaking state across requests.**

Every invariant below exists to protect that sentence. Violating any of them turns the product into "fast but unsafe", which is worse than slow-and-safe (= the `claude -p` users are leaving behind).

## Hard invariants

1. **A warm session is process-warm, not conversation-warm.**
   The stop-hook keepalive trick keeps the `claude` *process* alive. Each real request starts a **fresh conversation** — same as `claude -p`. Never reuse conversation history across requests. If you find yourself writing "continue from last turn", you have built a different product.

2. **No cross-request state leaks.**
   Files written by request A under a warm session must not be visible to request B on the same session. This means: clean CWD policy, env scrubbed of per-request secrets, no shared scratch dirs, no caching of tool results between requests. The pool's allocation strategy is responsible for this; sessions trust the pool.

3. **The public API is the product.**
   The synchronous request/response signature is what consumers (Multica et al.) couple to. Breaking it breaks every integrator. Treat it as frozen from v1.0. New capabilities arrive as new methods or opt-in fields, never as silent semantic changes to the existing signature. See [[keepalive-public-api]].

4. **Pool decisions are local; sessions are dumb.**
   The pool picks which session handles a request, evicts stale ones, and enforces isolation policy. Sessions only know how to send a prompt and stream a response. A session that decides anything about routing is off-pattern.

5. **Every wait is bounded.**
   No `await` without a timeout — pool acquisition, session spawn, request dispatch, response stream, shutdown drain. A wedged `claude` must surface as a timeout error, never an indefinite hang. This is the difference between "fast" and "fast and operable".

6. **Per-request abort works.**
   Every public method accepts an `AbortSignal`. Aborting must cancel the request *and* return the session to a clean state for the next request (or destroy it, if cleaning would be unsafe). Consumers like Multica need to honor user-side cancellation.

7. **Failure isolation.**
   A crashed warm session takes down at most itself. The pool detects, evicts, replaces. The caller sees an error for the in-flight request only; sibling requests on other sessions are unaffected. No `process.exit()` on session error.

8. **Observability is mandatory, not optional.**
   Every session spawn, recycle, eviction, timeout, and crash emits a structured log + counter. If something weird happens in production at 3am, the operator must be able to tell whether it was the pool, the session, or the consumer.

9. **Interactive mode is the default; `print` is opt-in.**
   By default, every warm session runs `claude` in interactive mode and injects prompts via the stop-hook `{decision:'block', reason: <prompt>}` channel — that mechanism is what makes a single process serve many requests without cold-start each time. A `mode: 'print'` opt-in exists for integrators who need token-level streaming, which the interactive transport cannot provide (see [[keepalive-session]] §"What runStream looks like in interactive mode"). Print mode spawns a fresh `claude -p` per request and has no warmth or pool semantics. Because the two modes differ in stream granularity, idle-tick behavior, and `RunStreamEvent` shape, the choice must be explicit at `createClient` time — a silent fallback would change observable behavior consumers may couple to. See [[keepalive-session]] §"The trick" for the interactive-mode mechanism.

## Mental model

```
caller ──request(prompt, opts)──▶ Pool ──pick warm──▶ Session ──exec──▶ claude (warm)
            ▲                       │                    │
            └────response/error─────┴────recycle/evict───┘
```

Three layers, narrow contracts between them. Don't smear responsibility.

## Module responsibility table

| Module       | Owns                                                  | Forbidden to know about         |
| ------------ | ----------------------------------------------------- | ------------------------------- |
| `api`        | public request/response contract                      | pool internals, process spawn   |
| `pool`       | session selection, eviction, sizing, isolation policy | prompt content, stream framing  |
| `session`    | one warm `claude` process + stop-hook keepalive       | other sessions, request routing |
| `session/io` | prompt-in / response-out framing for one session      | pool, public API                |
| `metrics`    | counters + histograms                                 | business logic                  |
| `clock` / `proc` | injectable boundaries for tests                   | business logic                  |

## When this skill applies

- Reviewing any PR that touches the public API surface.
- Adding shared state inside `pool` or `session` — check rules 1, 2, 4.
- Adding a feature that "remembers" anything between calls — almost always violates rule 1.
- Diagnosing a "request returned someone else's data" bug — start with rule 2 and the pool's allocation policy.
- Adding a `setTimeout` without an `AbortSignal` wired in — rule 5/6.
