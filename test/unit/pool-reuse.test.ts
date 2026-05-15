import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../helpers/index.js';

describe('pool: warm session reuse', () => {
  it('reuses a warm session for the second request', async () => {
    const { fake, client } = createTestEnv({ poolSize: 1 });

    const a = await client.run('hello');
    const b = await client.run('world');

    expect(fake.spawnCount).toBe(1);
    expect(a.sessionId).toBe(b.sessionId);
    expect(a.text).toBe('hello');
    expect(b.text).toBe('world');

    await client.close();
  });

  it('spawns up to size when concurrent', async () => {
    const { fake, client } = createTestEnv({ poolSize: 2 });

    let releaseA: () => void = () => {};
    let releaseB: () => void = () => {};
    const gateA = new Promise<void>((r) => (releaseA = r));
    const gateB = new Promise<void>((r) => (releaseB = r));
    let i = 0;

    fake.onPrompt(async (ctx) => {
      if (i++ === 0) await gateA;
      else await gateB;
      return [
        {
          type: 'done',
          result: {
            requestId: ctx.requestId,
            text: ctx.prompt,
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: 0,
            sessionId: ctx.sessionId,
          },
        },
      ];
    });

    const p1 = client.run('one');
    const p2 = client.run('two');

    // Let both acquire+enter the responder.
    await new Promise((r) => setImmediate(r));
    releaseA();
    releaseB();
    const [a, b] = await Promise.all([p1, p2]);

    expect(fake.spawnCount).toBe(2);
    expect(a.sessionId).not.toBe(b.sessionId);

    await client.close();
  });
});
