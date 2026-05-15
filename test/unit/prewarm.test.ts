import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../helpers/index.js';

describe('client.prewarm', () => {
  it('spawns poolSize sessions and resolves when all are ready', async () => {
    const { fake, client } = createTestEnv({ poolSize: 3 });
    expect(fake.spawnCount).toBe(0);
    await client.prewarm();
    expect(fake.spawnCount).toBe(3);
    await client.close();
  });

  it('is idempotent — a second prewarm spawns nothing', async () => {
    const { fake, client } = createTestEnv({ poolSize: 2 });
    await client.prewarm();
    expect(fake.spawnCount).toBe(2);
    await client.prewarm();
    expect(fake.spawnCount).toBe(2);
    await client.close();
  });

  it('skips already-spawned sessions when partial pool exists', async () => {
    // Trigger one spawn via a normal run, then prewarm should top up.
    const { fake, client } = createTestEnv({ poolSize: 3 });
    await client.run('hello');
    expect(fake.spawnCount).toBe(1);
    await client.prewarm();
    expect(fake.spawnCount).toBe(3);
    await client.close();
  });

  it('runs warmupPrompt on every session when set', async () => {
    const seenPrompts: string[] = [];
    const { fake, client } = createTestEnv({
      poolSize: 2,
      warmupPrompt: 'WARMUP_TOKEN',
    });
    fake.onPrompt((ctx) => {
      seenPrompts.push(ctx.prompt);
      return [
        {
          type: 'done',
          result: {
            requestId: ctx.requestId,
            text: 'ok',
            usage: { inputTokens: 0, outputTokens: 0 },
            durationMs: 0,
            sessionId: ctx.sessionId,
          },
        },
      ];
    });

    await client.prewarm();

    // Both warm sessions must receive the warmup prompt exactly once.
    expect(seenPrompts.filter((p) => p === 'WARMUP_TOKEN')).toHaveLength(2);
    expect(fake.spawnCount).toBe(2);
    await client.close();
  });

  it('does not run warmupPrompt when option is omitted', async () => {
    const seenPrompts: string[] = [];
    const { fake, client } = createTestEnv({ poolSize: 2 });
    fake.onPrompt((ctx) => {
      seenPrompts.push(ctx.prompt);
      return [
        {
          type: 'done',
          result: {
            requestId: ctx.requestId,
            text: 'ok',
            usage: { inputTokens: 0, outputTokens: 0 },
            durationMs: 0,
            sessionId: ctx.sessionId,
          },
        },
      ];
    });

    await client.prewarm();

    expect(seenPrompts).toHaveLength(0);
    expect(fake.spawnCount).toBe(2);
    await client.close();
  });
});
