/**
 * Verifies WarmSession's pipe-drain + stderr-tail behavior:
 *   - data on stdout is consumed (no back-pressure that would block claude)
 *   - data on stderr is buffered up to STDERR_TAIL_BYTES and attached as the
 *     reason of the crash event when the process exits
 *
 * Uses a fake ProcessHandle (EventEmitter with Readable streams) — no real
 * subprocess, so the test runs in milliseconds.
 */
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { describe, expect } from 'vitest';
import { systemClock, systemSleeper } from '../../src/core/clock.js';
import type { ProcessHandle } from '../../src/core/proc.js';
import { fileTransportFraming } from '../../src/session/framing.js';
import { sessionPaths } from '../../src/session/paths.js';
import { WarmSession } from '../../src/session/warm-session.js';
import { test } from '../helpers/fixtures.js';

class FakeProc extends EventEmitter {
  readonly pid = 99999;
  readonly stdin = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  kill(_signal?: NodeJS.Signals): boolean {
    this.killed = true;
    return true;
  }
}

function newSession(
  runtime: string,
  id: string,
): {
  proc: FakeProc;
  session: WarmSession;
} {
  const paths = sessionPaths(runtime, id);
  const proc = new FakeProc();
  const session = new WarmSession({
    id,
    proc: proc as unknown as ProcessHandle,
    paths,
    framing: fileTransportFraming,
    clock: systemClock,
    sleeper: systemSleeper,
    responseTimeoutMs: 1_000,
    pollIntervalMs: 10,
  });
  return { proc, session };
}

describe('integration: WarmSession drains pipes and surfaces stderr on crash', () => {
  test('consumes stdout without back-pressure (no listener leak)', async ({ runtime }) => {
    const { proc, session } = newSession(runtime, 's-stdout');
    // Writing a large blob to stdout would block claude in production if the
    // pipe were not drained. Here, write-then-end must complete synchronously
    // because PassThrough delivers to listeners eagerly.
    const big = Buffer.alloc(128 * 1024, 'x');
    proc.stdout.write(big);
    proc.stdout.end();
    // No assertion error or hang means the data listener is attached.
    expect(proc.stdout.listenerCount('data')).toBeGreaterThan(0);
    await session.destroy();
  });

  test('attaches stderr tail to crash reason on unexpected exit', async ({ runtime }) => {
    const { proc, session } = newSession(runtime, 's-stderr');
    await mkdir(sessionPaths(runtime, 's-stderr').responsesDir, { recursive: true });

    const crashes: { reason: string }[] = [];
    session.on('crash', (info) => crashes.push(info));

    proc.stderr.write('claude: bootstrap failed\n');
    proc.stderr.write('Error: settings.json invalid at line 3\n');
    // Simulate the child exiting unexpectedly.
    proc.emit('exit', 1);

    // The data listeners are synchronous; the exit emit calls the crash
    // handler synchronously too.
    expect(crashes).toHaveLength(1);
    const reason = crashes[0]?.reason ?? '';
    expect(reason).toContain('exit:1');
    expect(reason).toContain('claude: bootstrap failed');
    expect(reason).toContain('settings.json invalid');

    await session.destroy();
  });

  test('caps stderr tail length so we never grow unbounded', async ({ runtime }) => {
    const { proc, session } = newSession(runtime, 's-tail-cap');

    const crashes: { reason: string }[] = [];
    session.on('crash', (info) => crashes.push(info));

    // Pump 100 KB of stderr in many small writes. We retain at most
    // STDERR_TAIL_BYTES (4096) bytes of tail — assert that the recorded
    // reason payload is bounded.
    for (let i = 0; i < 1024; i++) {
      proc.stderr.write(`line-${i}: ${'x'.repeat(96)}\n`);
    }
    proc.emit('exit', 137);

    const reason = crashes[0]?.reason ?? '';
    // The "stderr tail: " slice in the crash reason caps at 1024 bytes
    // (per WarmSession), so the whole reason should be < 2 KB even though
    // we wrote ~100 KB. The exact cutoff isn't important — sanity bound.
    expect(reason.length).toBeLessThan(2048);
    expect(reason).toContain('exit:137');

    await session.destroy();
  });

  test('no stderr tail emitted when stderr is silent', async ({ runtime }) => {
    const { proc, session } = newSession(runtime, 's-silent');

    const crashes: { reason: string }[] = [];
    session.on('crash', (info) => crashes.push(info));

    proc.emit('exit', 0);

    expect(crashes[0]?.reason).toBe('exit:0');
    await session.destroy();
  });

  test('no crash event after destroy()', async ({ runtime }) => {
    const { proc, session } = newSession(runtime, 's-after-destroy');
    const crashes: { reason: string }[] = [];
    session.on('crash', (info) => crashes.push(info));

    await session.destroy();
    proc.emit('exit', 0);

    expect(crashes).toHaveLength(0);
  });
});
