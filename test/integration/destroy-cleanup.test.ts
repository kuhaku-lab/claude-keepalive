/**
 * Verifies WarmSession.destroy() removes the per-session state dir so a
 * future spawn never inherits stale flag files. Uses a real tmpdir + a
 * minimal fake ProcessHandle (no real claude process).
 */
import { EventEmitter } from 'node:events';
import { mkdir, stat, writeFile } from 'node:fs/promises';
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
  readonly stdout = null;
  readonly stderr = null;
  killed = false;
  kill(_signal?: NodeJS.Signals): boolean {
    this.killed = true;
    return true;
  }
}

function buildSession(runtime: string, id: string) {
  const paths = sessionPaths(runtime, id);
  const proc = new FakeProc() as unknown as ProcessHandle;
  const session = new WarmSession({
    id,
    proc,
    paths,
    framing: fileTransportFraming,
    clock: systemClock,
    sleeper: systemSleeper,
    responseTimeoutMs: 1_000,
    pollIntervalMs: 10,
  });
  return { paths, proc, session };
}

describe('integration: WarmSession.destroy cleans state dir', () => {
  test('removes paths.root and all child flag files', async ({ runtime }) => {
    const { paths, proc, session } = buildSession(runtime, 's-destroy');
    await mkdir(paths.responsesDir, { recursive: true });
    // Plant stale artifacts that a previous request might have left behind.
    await writeFile(paths.responded, '', 'utf8');
    await writeFile(paths.inRequest, '', 'utf8');
    await writeFile(paths.prompt, 'stale prompt', 'utf8');

    await session.destroy();

    expect((proc as unknown as FakeProc).killed).toBe(true);
    await expect(stat(paths.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('is idempotent — calling destroy twice does not throw', async ({ runtime }) => {
    const { paths, session } = buildSession(runtime, 's-idem');
    await mkdir(paths.responsesDir, { recursive: true });

    await session.destroy();
    await expect(session.destroy()).resolves.toBeUndefined();
  });
});
