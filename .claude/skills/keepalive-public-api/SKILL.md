---
name: keepalive-public-api
description: Design or modify the public TypeScript API of claude-keepalive — the surface that drop-in replaces `claude -p` for consumers like Multica. Use when the user mentions "API", "drop-in", "public surface", "request signature", "streaming response", "AbortSignal", "options", or anything that integrator code couples to. Includes the v1 signature and the rules for additive vs breaking changes.
---

# Public API contract

This is the product. Everything else is implementation detail.

## v1 signature (proposed; freeze at v1.0)

```ts
import type { KeepaliveClient, RunOptions, RunResult, RunStreamEvent } from 'claude-keepalive';

declare function createClient(opts: ClientOptions): KeepaliveClient;

interface KeepaliveClient {
  /** Synchronous-style: returns when claude has finished. */
  run(prompt: string, opts?: RunOptions): Promise<RunResult>;

  /** Streaming: yields incremental events. Completion event closes the iterator. */
  runStream(prompt: string, opts?: RunOptions): AsyncIterable<RunStreamEvent>;

  /**
   * Proactively spawn up to `poolSize` warm sessions and wait until each
   * has reached idle-ready (its first stop-hook fire has completed). If
   * `ClientOptions.warmupPrompt` is set, also run that prompt on every
   * warm session and discard the result so Anthropic's prompt cache is
   * pre-filled. Rejects with `SPAWN_TIMEOUT` if any spawn exceeds
   * `spawnTimeoutMs`. Idempotent.
   *
   * Warm-pool-layer analogue of the prompt-cache pre-warming pattern at
   * platform.claude.com/docs/en/build-with-claude/prompt-caching.
   */
  prewarm(): Promise<void>;

  /** Idempotent. Drains in-flight requests up to `opts.drainTimeoutMs`, then force-kills. */
  close(): Promise<void>;
}

interface RunOptions {
  signal?: AbortSignal;
  cwd?: string;
  env?: Record<string, string>;
  allowedTools?: string[];
  model?: string;
  timeoutMs?: number;
  /** Opaque request id surfaced in logs/metrics. Auto-generated if omitted. */
  requestId?: string;
}

interface ClientOptions {
  poolSize?: number;
  /**
   * Execution mode. 'interactive' (default) uses warm `claude` processes and
   * serves many requests off the same session via the stop-hook injection
   * channel. 'print' spawns `claude -p` per request and emits token-level
   * stream events but has no warmth. The two modes differ in stream
   * granularity, idle-tick behavior, and warm-pool semantics, so this option
   * must be explicit — silent fallback would change observable behavior
   * consumers may couple to. See keepalive-invariants rule 9.
   */
  mode?: 'interactive' | 'print';
  /**
   * Optional prompt run on every warm session at `prewarm()` time. Response
   * discarded. Use a prompt whose prefix matches your real workload to also
   * pre-fill Anthropic's prompt cache — analogous to the warmup-request
   * pattern at platform.claude.com/docs/en/build-with-claude/prompt-caching.
   * If omitted, prewarm only amortises CLI spawn cost.
   */
  warmupPrompt?: string;
  // ...remaining options unchanged
}

interface RunResult {
  requestId: string;
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
  sessionId: string;     // which warm session served it (for debugging only)
}

type RunStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; ok: boolean }
  | { type: 'done'; result: RunResult }
  | { type: 'error'; error: { code: string; message: string } };
```

## Mapping from `claude -p`

| `claude -p` invocation | keepalive equivalent |
| ---------------------- | -------------------- |
| `claude -p "hello"`    | `await client.run('hello')` |
| `claude -p --output-format stream-json` | `for await (const ev of client.runStream(prompt)) ...` |
| `--cwd /repo`          | `run(prompt, { cwd: '/repo' })` |
| `--allowedTools Read,Edit` | `run(prompt, { allowedTools: ['Read', 'Edit'] })` |
| `--model sonnet`       | `run(prompt, { model: 'sonnet' })` |
| `^C` (process kill)    | `controller.abort()` via `signal` |

If a `claude -p` flag has no equivalent here, that is either an intentional omission (document why) or a v1.x backlog item. Never silently ignore options.

## Change policy

The API surface follows **strict semver from v1.0**.

| Change kind                                  | Allowed in     | Notes                                                     |
| -------------------------------------------- | -------------- | --------------------------------------------------------- |
| New optional field on `RunOptions`           | minor          | Default must preserve v1 behavior                         |
| New event type on `RunStreamEvent`           | minor          | Consumers must already ignore unknown `type`              |
| New method on `KeepaliveClient`              | minor          | Cannot reuse a v1 name with different semantics           |
| New required field on `RunOptions`           | major          | Avoid — make it optional with a default instead           |
| Changing default of an existing option       | major          | Even "harmless" defaults break replayed traffic           |
| Renaming a field in `RunResult`              | major          | Provide alias for one major version                       |
| Changing `Promise<RunResult>` to async iter  | major          | Don't — add a new method                                  |

In v0.x, breaking changes are allowed but each one **must** appear in CHANGELOG with a migration line.

## Stream granularity by mode

`runStream` yields different event granularity depending on `mode`:

| Mode          | `token` events                                        | Notes                                  |
| ------------- | ----------------------------------------------------- | -------------------------------------- |
| `interactive` | one `token` event with the full text, then `done`     | Interactive transport is batch; see [[keepalive-session]] §"Response capture" |
| `print`       | many `token` events as they arrive, then `done`       | Same shape `claude -p --output-format stream-json` produces |

Both modes always end with exactly one `done` (or `error`). Consumers MUST NOT couple correctness to the number of `token` events received — only to the final text in `done.result.text` (or the concatenation of all `token.text` values up to `done`).

## Error contract

`run` rejects with a structured error:

```ts
interface KeepaliveError extends Error {
  code:
    | 'TIMEOUT'              // exceeded RunOptions.timeoutMs
    | 'ABORTED'              // signal aborted
    | 'POOL_EXHAUSTED'       // no session available within acquireTimeoutMs
    | 'SESSION_CRASHED'      // warm session died mid-request
    | 'SPAWN_TIMEOUT'        // claude did not reach ready (.last-tick) within spawnTimeoutMs
    | 'CLAUDE_ERROR'         // claude reported an error
    | 'INVALID_OPTIONS';     // zod validation failed
  requestId: string;
  cause?: unknown;
}
```

Consumers route on `code`, not on `message`. Adding a new code is **minor**; renaming an existing one is **major**.

## Drop-in shim convention

Integrators replacing `claude -p` typically write a 20-line shim:

```ts
import { createClient } from 'claude-keepalive';

const client = createClient({ poolSize: 4 });

export async function runClaude(prompt: string, opts: { cwd: string; tools: string[] }) {
  const result = await client.run(prompt, {
    cwd: opts.cwd,
    allowedTools: opts.tools,
    timeoutMs: 5 * 60_000,
  });
  return result.text;
}
```

That shim is the entire integration. If the shim grows past ~40 lines, the API is missing something — file an issue rather than working around it in user code.

## When this skill applies

- Adding, renaming, or removing anything in the exports listed above.
- Reviewing a PR whose diff touches `src/api/` or `src/index.ts`.
- A consumer asks "can I do X?" — first check whether X already maps to an option above before extending.
- Bumping the major version — audit every export against the change policy table.
- Writing migration notes for `claude -p` users — keep the mapping table in sync.
