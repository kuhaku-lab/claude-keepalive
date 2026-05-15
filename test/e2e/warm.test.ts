/**
 * E2E test for the interactive warm-keepalive path. Runs only when
 * `RUN_E2E=1` is set (see vitest.config.ts) because it spawns a real
 * `claude` CLI and consumes real API tokens.
 *
 * Equivalent of `pnpm smoke:warm` but assertable from CI.
 */
import { describe, expect } from 'vitest';
import { test } from '../helpers/fixtures.js';

describe('e2e: warm interactive session against real `claude`', () => {
  test('serves two requests off the same warm session and the second is faster', {
    timeout: 120_000,
  }, async ({ client }) => {
    const t1 = Date.now();
    const r1 = await client.run('Reply with exactly the word: ALIVE', {
      requestId: 'e2e-warm-1',
    });
    const cold = Date.now() - t1;

    const t2 = Date.now();
    const r2 = await client.run('Reply with exactly the word: WARM', {
      requestId: 'e2e-warm-2',
    });
    const warm = Date.now() - t2;

    expect(r1.text.trim()).toBe('ALIVE');
    expect(r2.text.trim()).toBe('WARM');
    expect(r2.sessionId).toBe(r1.sessionId);
    // Warm request must be measurably faster than cold (no respawn cost).
    // We don't pick a tight ratio because LLM inference dominates both
    // anyway; the assertion catches the worst regressions.
    expect(warm).toBeLessThan(cold);
  });

  test('does not leak prior-turn content on the same warm session', { timeout: 120_000 }, async ({
    client,
  }) => {
    const r1 = await client.run('Remember this number: 17. Reply with "ok".', {
      requestId: 'e2e-leak-1',
    });
    const r2 = await client.run('What is the capital of Japan? Answer in one word.', {
      requestId: 'e2e-leak-2',
    });

    expect(r1.text.toLowerCase()).toContain('ok');
    expect(r2.sessionId).toBe(r1.sessionId);
    // Strategy (b)+(c) from TODO #1: the system-prompt contract must
    // prevent the "17" from showing up in an unrelated response.
    expect(r2.text).not.toMatch(/17/);
  });
});
