---
name: keepalive-pool
description: Work on the warm-session pool in claude-keepalive — sizing, allocation strategy, eviction, isolation policy, and back-pressure. Use when the user mentions "pool", "session allocation", "eviction", "TTL", "max age", "max requests", "POOL_EXHAUSTED", "back-pressure", or asks "which warm session does this request go to". Owns the pool/session boundary; does not own the session internals (see [[keepalive-session]]).
---

# Session pool

The pool turns "N warm `claude` processes" into a usable resource for concurrent requests. It owns three decisions: **acquire**, **release**, **evict**.

## Configuration

```ts
interface PoolOptions {
  /** Target number of warm sessions. Default: 1. */
  size: number;

  /** Max requests served by a session before forced recycle. Default: 100. */
  maxRequestsPerSession: number;

  /** Max wall-clock age of a session before forced recycle. Default: 1h. */
  maxSessionAgeMs: number;

  /** Max idle time a session may sit unused before recycle. Default: 10m. */
  maxIdleMs: number;

  /** How long acquire() waits before throwing POOL_EXHAUSTED. Default: 30s. */
  acquireTimeoutMs: number;

  /** Spawn timeout for a new session before declaring it dead. Default: 30s. */
  spawnTimeoutMs: number;
}
```

These defaults are tuned for Multica-style task workloads (long-running tasks, low QPS per pool). Latency-sensitive request/response use cases will want `size` ≥ concurrency and smaller `maxIdleMs`.

## Allocation strategy

Default: **least-recently-used idle session wins**.

```
acquire():
  if any idle session:
    pick LRU idle, mark busy, return
  if pool not at size:
    spawn new session, await ready, return
  if any session can be recycled now (over age/requests):
    evict, spawn replacement, return new one
  else:
    wait up to acquireTimeoutMs for one to free
    timeout → throw POOL_EXHAUSTED
```

LRU is chosen over MRU so that long-idle sessions get a chance to surface bugs (memory leaks, stale state) before they're recycled by `maxIdleMs`.

Do not implement weighted/fair-share allocation in v1. YAGNI until a real workload demands it.

## Isolation policy (rule 2 of [[keepalive-invariants]])

Between requests on the same warm session:

1. **CWD**: Each request supplies its own `cwd`. The session chdir's at request start and chdir's back to a neutral location on release. Never inherit the previous request's `cwd`.
2. **Env**: Per-request `env` overlays the session's base env for the duration of the request and is unset on release.
3. **Conversation history**: Reset before each request. The "fresh session" semantic from [[keepalive-invariants]] rule 1 is enforced here, not in the session module.
4. **Filesystem scratch**: If the session writes scratch files, the pool issues a fresh tmpdir per request and `rm -rf`'s on release.

If any of these cannot be reset cleanly after a request, **the session is destroyed**, not released back. Better to pay one spawn than to leak state.

## Eviction triggers

A session is evicted (terminated, removed from pool, replacement spawned lazily) when **any** of:

- It crashed.
- It exceeded `maxRequestsPerSession`.
- It exceeded `maxSessionAgeMs`.
- It exceeded `maxIdleMs` while idle.
- Its last request failed in a way that left it dirty (see isolation policy).
- `close()` was called on the client.

Eviction emits `pool.session.evicted` with the reason field.

## Back-pressure

When the pool is saturated and `acquire()` is queued:

- The queue is bounded by `acquireTimeoutMs`, not by length. A request that has waited too long fails with `POOL_EXHAUSTED` and the caller decides whether to retry.
- Queue is FIFO. No priority lanes in v1.
- Spawning is **not** considered "in-flight" for queue purposes — a slow spawn doesn't block the queue; we keep waiting for an idle session in parallel.

## Sizing guidance for integrators

This goes in `docs/sizing.md`, not in code, but worth knowing for design:

| Workload                              | Recommended `size`            |
| ------------------------------------- | ----------------------------- |
| Single-user chat bot                  | 1–2                           |
| Multica-style task runner (N parallel)| N + headroom for spawn lag    |
| Latency-sensitive request/response    | ≥ p99 concurrency             |
| Batch / one-off                       | Don't use keepalive; use `claude -p` directly |

The last row matters: keepalive's overhead is only worth it when the cold-start savings exceed the idle-tick tokens. Below ~1 request/min/session, it's a wash.

## When this skill applies

- Tuning or refactoring `src/pool/`.
- Adding a new eviction trigger or allocation strategy.
- A "request returned wrong cwd" bug — isolation policy.
- A "POOL_EXHAUSTED under load" issue — sizing, back-pressure, or spawn-time regression.
- Considering priority lanes / fairness — read this skill's "do not implement" note first.

## Not this skill

- Stop-hook mechanics, idle ticks, prompt framing → [[keepalive-session]].
- Public `RunOptions` / error codes → [[keepalive-public-api]].
