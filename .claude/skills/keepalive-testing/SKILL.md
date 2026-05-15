---
name: keepalive-testing
description: Write or debug tests for claude-keepalive. Covers the unit / integration / e2e layering, the injectable Clock / ProcessLauncher boundaries, and how to fake a `claude` process without actually spawning one. Use when the user mentions "tests", "vitest", "coverage", "flaky", "fake claude", "stub session", or wants to test code that involves time, child processes, or pool concurrency.
---

# Testing claude-keepalive

Framework: `vitest` (native TS, ESM, fast).

## Why testing is hard here, and why we still demand it

We sit between two systems we don't control: the `claude` CLI on one side, a stranger's task runner on the other. The product is "fast and won't leak state". Both halves are easy to lie about in production. Tests are how we don't lie to ourselves.

## Layered structure

```
test/
  unit/         # < 50ms each. No real process, no real fs (or only tmpdir).
  integration/  # < 2s each. Real tmpdir, fake claude binary, real pool.
  e2e/          # < 30s each. Real claude binary. Smoke only.
```

## Injectable boundaries

| Boundary          | Replaces             | Injected at                  |
| ----------------- | -------------------- | ---------------------------- |
| `Clock`           | `Date.now()`         | `core/clock.ts`              |
| `Sleeper`         | `setTimeout` / sleep | `core/clock.ts`              |
| `ProcessLauncher` | `child_process.spawn`| `core/proc.ts`               |
| `Random`          | session id generation| `core/random.ts`             |

A test for the 10-minute idle eviction must run in <50ms. If it sleeps, you missed an injection point.

## Faking the `claude` process

Most tests should never spawn a real `claude`. We ship a **`FakeClaude`** helper that:

- Implements the same stdin/stdout framing the real binary uses.
- Has scripted response sequences (`fake.onPrompt(p => stream(['tok', 'tok', done]))`).
- Can simulate crashes, stalls, slow startup.
- Optionally tracks how many idle ticks were observed, so pool/session tests can assert keepalive behavior without burning real seconds.

```ts
import { createFakeClaude, createTestPool } from '../helpers';

it('reuses a warm session for the second request', async () => {
  const fake = createFakeClaude();
  const pool = createTestPool({ launcher: fake.launcher, size: 1 });

  const a = await pool.run('hello');
  const b = await pool.run('world');

  expect(fake.spawnCount).toBe(1);
  expect(a.sessionId).toBe(b.sessionId);
});
```

`FakeClaude` lives under `test/helpers/` and is internal — never shipped as a public API.

## Patterns

### Test isolation per request

```ts
it('does not leak cwd between requests on the same session', async () => {
  const fake = createFakeClaude();
  fake.onPrompt((p, ctx) => stream([{ type: 'token', text: ctx.cwd }, { type: 'done' }]));
  const pool = createTestPool({ launcher: fake.launcher, size: 1 });

  const a = await pool.run('p1', { cwd: '/repo-a' });
  const b = await pool.run('p2', { cwd: '/repo-b' });

  expect(a.text).toBe('/repo-a');
  expect(b.text).toBe('/repo-b');  // not '/repo-a' — would mean cwd leaked
});
```

This is the test that protects [[keepalive-invariants]] rule 2. Treat it as load-bearing.

### Test pool eviction by age (fake clock)

```ts
const clock = createTestClock({ now: 0 });
const pool = createTestPool({ clock, size: 1, maxSessionAgeMs: 60_000 });

await pool.run('first');
clock.advance(60_001);
await pool.run('second');

expect(metrics.get('pool.session.evicted')).toBe(1);
```

### Test crash recovery

```ts
const fake = createFakeClaude();
const pool = createTestPool({ launcher: fake.launcher, size: 1 });

fake.crashNextRequest();
await expect(pool.run('p')).rejects.toMatchObject({ code: 'SESSION_CRASHED' });

const r = await pool.run('p');     // pool should have respawned
expect(r.text).toBeDefined();
expect(fake.spawnCount).toBe(2);
```

## Coverage gates

- `src/api`, `src/pool`, `src/session`, `src/core`: **85% lines minimum**.
- `src/session/hook.ts` (the stop-hook script itself): **100% branch** — it's tiny and load-bearing.

## Anti-patterns

- **Spawning real `claude` in unit/integration.** The only `claude`-real layer is e2e and only for smoke.
- **`vi.useFakeTimers()` on session code.** Fights `child_process` timing and produces flakes. Use injected `Clock`/`Sleeper`.
- **`setTimeout(done, 5000)` to "let it warm up".** Use the deterministic `.ready` signal from session spawn.
- **Asserting on log lines as a behavioral contract.** Logs are operator-facing. Assert on returned values, emitted client events, or metric counters instead.
- **One mega-test that drives 5 requests through the pool.** Split it. Concurrency bugs hide in monoliths.

## When this skill applies

- Adding tests for new pool/session/API behavior.
- A test runs >100ms unit, >2s integration, >30s e2e — refactor or move layers.
- A test is flaky — almost always a real timer or a race. Find the injection.
- Coverage drops below the gate on a core file.
- Adding a new fault mode to `FakeClaude` — coordinate with whichever skill describes the production behavior.

## Not this skill

- Whether a behavior should exist → the relevant production skill.
- CI workflow / publish pipeline → out of scope for v0 (revisit at release setup).
