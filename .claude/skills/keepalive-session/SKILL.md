---
name: keepalive-session
description: Work on the warm-session internals of claude-keepalive — the actual stop-hook + idle-tick mechanism that keeps a single `claude` process alive between requests. Use when the user mentions "stop hook", "idle tick", "warm session", "session spawn", "session crash", "prompt framing", or asks "how does the keepalive actually work". Does not own pool decisions (see [[keepalive-pool]]) or public API (see [[keepalive-public-api]]).
---

# Warm session internals

One warm session = one long-lived `claude` interactive process + the stop-hook trick that prevents it from exiting between requests.

## The trick

`claude` exits when it produces a "stop" response. The stop hook can **block** the stop by writing a structured JSON line to stdout that contains the next message to feed back into claude. The shape is:

```json
{"decision":"block","reason":"<text that becomes the next user message>"}
```

When claude sees this, it does NOT stop. Instead it ingests `reason` as the next user message and produces another response — so the stop hook is the channel through which the session driver injects **both** idle keepalive ticks **and** real user prompts.

```
┌──────────────────────────────────────────────────────────────────────┐
│ claude (interactive)                                                 │
│                                                                      │
│   on idle (no .in-request flag):                                     │
│     stop hook → {"decision":"block","reason":"--- TURN START ---"}  │
│     ~20 tokens round-trip, process stays alive                       │
│                                                                      │
│   on real request (.in-request flag + .prompt file present):         │
│     stop hook → reads .prompt, emits                                 │
│                 {"decision":"block","reason":<prompt text>}          │
│     claude runs the turn, writes response to .response-<reqid> via   │
│     the append-system-prompt contract (see "Response capture")       │
│                                                                      │
│   on response complete (.responded flag set by the hook after        │
│     injecting a real prompt):                                        │
│     stop hook → {"decision":"block","reason":"--- TURN START ---"}  │
│     (returns to idle; the session is again warm and ready)           │
└──────────────────────────────────────────────────────────────────────┘
```

There is **no stdin injection.** The session driver never writes to the child's stdin after spawn. The only protocol between the driver and the running `claude` is the per-session state directory: the driver writes `.in-request` + `.prompt`, the hook reads them and produces the block JSON, claude generates a response, and the response is captured by the agent itself (see below).

### TTY is NOT required (empirical, verified 2026-05)

A reasonable-sounding assumption is that `claude` requires a real pty for this trick to work — `claude --help` describes "non-interactive mode" detection based on whether stdout is a TTY, and a naive smoke (`claude --dangerously-skip-permissions "..." < /dev/null > out.txt`) exits in seconds.

That assumption is **wrong** for our case. The actual rule observed empirically:

| stdio environment        | stop hook configured? | behavior                                  |
| ------------------------ | --------------------- | ----------------------------------------- |
| non-TTY                  | no                    | runs prompt, exits (`-p`-equivalent)      |
| non-TTY                  | **yes, blocking**     | **stays in idle loop, hook fires**        |
| TTY                      | either                | stays in idle loop                        |

What matters is whether a Stop hook is wired in `<cwd>/.claude/settings.json` and emits `{decision:"block", ...}` on every fire. If yes, `claude` keeps running regardless of TTY-ness. If no, `claude` exits after the first response in non-TTY contexts.

Implication for our code: `src/session/spawn.ts` writes the per-session `.claude/settings.json` AND launches with `cwd: paths.root`, so claude reads our hook config. We can therefore launch with `stdio: ['pipe','pipe','pipe']` (Node's default piped stdio, no pty allocation) and the warm-keepalive trick still works. **`node-pty` is not a required dependency.**

Verified by `scripts/warm-smoke.mjs` (run via `pnpm smoke:warm`): a real `claude` CLI launched with `stdio: ['pipe','pipe','pipe']` (no pty allocation) stays in the idle loop and serves multiple requests off the same warm session, because the per-session `.claude/settings.json` wires the Stop hook to our blocking script.

## Response capture

Because interactive mode does not expose `--output-format stream-json` (that's a `--print`-only flag), we cannot read structured response events off stdout. The session driver must instead instruct the running agent — via `--append-system-prompt` injected at spawn time — to write each response to a known per-session file. The capture flow:

```
1. driver writes runtime/sessions/<sid>/.prompt with the prompt text + a
   per-request response path (e.g. .response-<requestId>.json)
2. driver creates runtime/sessions/<sid>/.in-request to flip the hook
3. hook fires (from previous idle tick), reads .prompt, emits
   {"decision":"block","reason":"<prompt>\n\nWhen done, write your reply\
   as JSON {\"requestId\":..,\"text\":..} to <response path>."}
4. claude generates the response, writes the JSON file as instructed
5. driver polls (or fs-watches) the response file, reads it, yields
   {type:'done', result:...} to the public API layer
6. driver clears .in-request and .prompt
7. hook fires (claude's turn ended), sees .responded → emits idle block
   to return the session to warm-idle
```

The append-system-prompt is constructed by `framing.ts` at spawn time and never changes for the life of the session. It is the contract between the library and the agent for response capture.

### What runStream looks like in interactive mode

The interactive transport is a **batch transport** from the consumer's perspective: there is no stream of tokens, only "done with full response" once the response file is written. `runStream` therefore yields exactly one `{type:'token', text}` (with the full text) followed by `{type:'done', result}`. Token-level streaming is a `mode: 'print'` opt-in and is documented as such on the public API ([[keepalive-public-api]] §"Stream granularity by mode").

### Failure modes specific to this transport

- **Agent ignores the response-write instruction.** Detected by `.response-*` file not appearing within `responseTimeoutMs`. Surface as `CLAUDE_ERROR`. The session is dirty; the pool will evict.
- **Agent writes malformed JSON.** Same — `CLAUDE_ERROR`, dirty, evict.
- **Stop hook never fires after prompt injection.** Typically means claude is producing the response right now; we wait. If `responseStallMs` elapses with no file growth and no hook fire, surface `SESSION_CRASHED`.

## Module layout

```
src/session/
  index.ts            # Session class, public to pool
  spawn.ts            # spawn + ready-handshake + crash watcher
  hook.ts             # the stop-hook script claude calls
  framing.ts          # prompt injection + response framing
  idle.ts             # idle tick accounting + summary log
  paths.ts            # per-session state dir layout (under runtime/)
```

`src/session/` is the only module that knows the stop-hook trick exists. The pool sees a `Session` interface: `run(prompt, opts) -> AsyncIterable<event>`.

## Per-session state layout

Each session gets its own state dir, isolated from siblings:

```
runtime/sessions/<session-id>/   # absolute path — runtimeDir is resolve()'d
                                 # at createClient time so settings.json's
                                 # `command` and the hook script's flag-file
                                 # checks are cwd-independent (v0.1.3 fix).
  .pid                 # claude process pid
  .in-request          # presence = a real request is in flight (hook reads this)
  .prompt              # the prompt text the hook should inject as `reason`
  .request-id          # current request id (for log correlation)
  .responded           # presence = hook just injected a real prompt; next
                       #   hook fire is the response turn, not idle
  .responses/          # directory of per-request response files written by
                       #   the agent (one .response-<requestId>.json per request,
                       #   removed by the driver after read)
  .last-tick           # epoch ms of the LAST idle tick. Also acts as the
                       #   readiness signal — its first appearance proves
                       #   claude booted and a stop-hook fire completed.
                       #   spawnWarmProcess polls for this, bounded by
                       #   spawnTimeoutMs, rejecting with SPAWN_TIMEOUT.
  .counters.json       # per-session counters, flushed periodically
  hook.log             # stop-hook stderr log (debug aid)
  stop-hook.sh         # the rendered stop-hook script claude calls
```

These are implementation detail. Never expose them on the public API.

## Lifecycle

```
spawn():
  1. mkdir runtime/sessions/<id>/ (absolute path)
  2. write .claude/settings.json + stop-hook.sh into the session dir
  3. launch claude with cwd=<session-dir>, --append-system-prompt,
     --dangerously-skip-permissions, stdio: ['ignore', 'pipe', 'pipe']
  4. wait for .last-tick to appear (= first stop hook fired = ready).
     bounded by spawnTimeoutMs; reject with SPAWN_TIMEOUT and SIGTERM
     the doomed process if exceeded.
  5. mark idle in pool

run(prompt):
  1. set .in-request, .request-id
  2. inject prompt via stdin framing
  3. stream response events until done sentinel
  4. clear .in-request, .request-id
  5. return to idle

evict():
  1. SIGTERM, wait up to 5s
  2. SIGKILL if still alive
  3. rm -rf runtime/sessions/<id>/
```

## Idle tick accounting

- A tick happens every time the stop-hook fires with no real request in flight.
- **Do not log each tick.** Aggregate: emit `session.idle.summary` every 60s with `{ ticks, estimatedTokens }`.
- `estimatedTokens = ticks * idleTickTokenEstimate` (default 20, configurable). Documented as an estimate.
- Counter `idle.ticks` flushes to `.counters.json` at most once per 10s.

## Prompt framing

The transport is **file-driven, not stdin-driven** (see "The trick" and "Response capture" above). The framing module owns:

- Generating the `--append-system-prompt` text that teaches the agent the response-write contract (where to write, what JSON shape).
- Writing `.prompt` + `.in-request` to the session state dir to enqueue a real prompt.
- Polling (or fs-watching) the per-request response file under `.responses/` until it appears or `responseTimeoutMs` elapses.
- Parsing the JSON the agent wrote, validating shape, and translating into the public `RunStreamEvent` shape ([[keepalive-public-api]]).
- Owning the per-request done detection: response file present + parseable = done.

The interactive `claude` CLI's terminal rendering on stdout is **ignored** by the framing layer. Stdout is consumed only to keep the pipe drained; it carries no protocol meaning to us.

If a new `claude` version changes hook payload shape or the `--append-system-prompt` flag, this is the only file that needs updating. Keep it isolated.

## Crash handling

The session has a `'crash'` event emitter. The pool listens and evicts.

- Triggers: stdout pipe closed, exit code non-zero, response stream stalled past `responseStallMs` (default 60s).
- A crash during an in-flight request rejects that request with `SESSION_CRASHED`. Sibling sessions are unaffected ([[keepalive-invariants]] rule 7).
- `process.exit()` is never called from a session — only the parent process owns exit.

## Permissions & tools

`allowedTools` and similar per-request flags are injected on prompt, not on spawn. Sessions start with the **most permissive** configuration the integrator allowed at `createClient`, and each request narrows it down. Widening per-request is forbidden — surface as `INVALID_OPTIONS`.

If an integrator needs strict per-request isolation that can't be expressed via in-protocol flags, the pool will spawn a fresh session for that request rather than reusing. That's a pool decision ([[keepalive-pool]]), not a session decision.

## When this skill applies

- Touching anything under `src/session/`.
- Upgrading the supported `claude` CLI version (framing changes).
- A "stop hook fires too often / not enough" bug.
- A "session never returns to idle after request" bug — almost always `.in-request` flag not cleared on error path.
- Adding a new stream event type — coordinate with [[keepalive-public-api]].

## Not this skill

- Which session a request lands on, pool sizing → [[keepalive-pool]].
- The exported `run` / `runStream` signatures → [[keepalive-public-api]].
- Cross-request leak prevention policy → [[keepalive-pool]] + [[keepalive-invariants]] rule 2.
