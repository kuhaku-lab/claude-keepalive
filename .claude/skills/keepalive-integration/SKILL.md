---
name: keepalive-integration
description: Help an integrator (Multica, custom task runner, internal platform) replace `claude -p` calls with claude-keepalive. Use when the user mentions "integrate", "drop-in", "replace claude -p", "Multica", "migrate from claude -p", "how do I use this", or wants to understand the consumer-side wrapper. Includes a copy-paste shim under `examples/`.
---

# Integrating claude-keepalive

claude-keepalive's job is to be invisible. A well-integrated consumer keeps using the same task model they had with `claude -p`; the only difference is that **latency drops** — the binary boots once per warm session, not once per request, because the library keeps a pool of warm interactive `claude` processes and routes requests through the stop-hook injection channel.

If an integrator needs token-level streaming (which the interactive transport cannot provide — see [[keepalive-session]] §"What runStream looks like in interactive mode"), `mode: 'print'` is available as an explicit opt-in. Default behavior is interactive.

## The mental model for integrators

You had:

```ts
// Before
const result = await execClaudeP(prompt, { cwd, allowedTools });
```

You have:

```ts
// After
const result = await client.run(prompt, { cwd, allowedTools });
```

The contract is the same: send a prompt, get a result, isolated per call. The pool, the warm sessions, the stop hook — none of that should leak into integrator code. If it does, file an issue.

## Migration steps

### 1. Add the dependency

```bash
pnpm add claude-keepalive
```

### 2. Create one client per process

A `KeepaliveClient` owns a pool. Create it once at process startup, reuse it for every request, `close()` on shutdown. Do **not** create a client per request — that defeats the entire product.

```ts
import { createClient } from 'claude-keepalive';

export const claudeClient = createClient({
  poolSize: 4,
  defaultTimeoutMs: 5 * 60_000,
});

process.on('SIGTERM', async () => {
  await claudeClient.close();
});
```

### 3. Replace `claude -p` call sites

```ts
// Before: spawn(claude, ['-p', prompt, '--cwd', repoDir, ...])
// After:
const result = await claudeClient.run(prompt, {
  cwd: repoDir,
  allowedTools: ['Read', 'Edit', 'Bash'],
  signal: task.abortSignal,
  requestId: task.id,
});
return result.text;
```

`requestId` should mirror the integrator's task id — that's what shows up in keepalive logs/metrics, making correlation trivial.

### 4. Forward streaming progress (optional)

If your platform shows live progress (Multica's WebSocket activity stream is the canonical case):

```ts
for await (const ev of claudeClient.runStream(prompt, opts)) {
  switch (ev.type) {
    case 'token':       broadcast({ kind: 'token', text: ev.text }); break;
    case 'tool_use':    broadcast({ kind: 'tool', name: ev.name }); break;
    case 'done':        return ev.result;
    case 'error':       throw new KeepaliveError(ev.error);
  }
}
```

### 5. Pool sizing

See [[keepalive-pool]] for guidance. The short version for task-runner platforms: `poolSize = expected_parallel_tasks + small_headroom`. Under-sized pools throw `POOL_EXHAUSTED` under burst; over-sized pools burn idle-tick tokens on sessions that aren't being used.

## Mode selection

| Mode                    | Execution                                              | Streaming                          | Use when                                       |
| ----------------------- | ------------------------------------------------------ | ---------------------------------- | ---------------------------------------------- |
| `interactive` (default) | warm pool; same `claude` process serves many requests  | batch (full text on `done`)        | task runners replacing `claude -p`; default    |
| `print` (opt-in)        | fresh `claude -p` per request; no warmth               | true token-level                   | UIs that need live token streams                |

```ts
const client = createClient({ poolSize: 4 });                 // interactive (default)
const client = createClient({ poolSize: 4, mode: 'print' });  // one-shot per request, token-level streaming
```

Setting `mode: 'print'` silently is forbidden — it must come from a deliberate `createClient` argument or a documented env var. The two modes differ in stream granularity, idle-tick behavior, and warm-pool semantics. See [[keepalive-invariants]] rule 9.

## What NOT to do

- **Don't create a client per request.** The pool's value is amortization across requests.
- **Don't share a client across processes** via filesystem state. Each `KeepaliveClient` owns its own warm sessions; running two clients pointed at the same runtime dir is undefined behavior.
- **Don't catch `SESSION_CRASHED` and retry forever.** Bounded retry (≤2) is fine; the pool already evicted and respawned, but a deterministic crash will loop.
- **Don't try to "reuse conversation history" across calls.** That's not what this is. See [[keepalive-invariants]] rule 1.
- **Don't tail keepalive's internal logs as your application log.** Use the structured events on `client` (see "Observability" below).

## Observability for integrators

The client emits events you can route to your own logger/metrics:

```ts
client.on('session.spawned', ({ sessionId }) => metrics.inc('claude.spawn'));
client.on('session.evicted', ({ sessionId, reason }) => metrics.inc('claude.evict', { reason }));
client.on('request.done', ({ requestId, durationMs }) => metrics.observe('claude.duration', durationMs));
client.on('request.error', ({ requestId, code }) => metrics.inc('claude.error', { code }));
```

Event names are stable from v1.0 ([[keepalive-public-api]] change policy).

## Multica-specific notes

- The `cwd` per request maps to Multica's workspace clone directory.
- `allowedTools` maps to the task's allowed action set.
- `requestId` should be the Multica issue/task id for correlation in shared dashboards.
- `signal` should be wired to Multica's task abort (user-side cancellation).
- One Multica daemon → one `KeepaliveClient`. Multi-workspace daemons may want one client per workspace if isolation requirements demand it.

A worked example is in `examples/multica-runtime.ts` in this skill directory.

## When this skill applies

- Onboarding a new integrator.
- Reviewing a PR in a consumer codebase that wraps `claude-keepalive`.
- Diagnosing "it's no faster than `claude -p` was" — almost always step 2 (client created per request) or step 5 (pool sized at 1).
- Writing docs/integration guides — keep this skill and the docs in sync.

## Not this skill

- Internals of how warmth works → [[keepalive-session]].
- Pool tuning → [[keepalive-pool]].
- API contract details → [[keepalive-public-api]].
