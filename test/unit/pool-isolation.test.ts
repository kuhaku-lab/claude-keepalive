import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../helpers/index.js';

describe('pool: per-request isolation (invariants rule 2)', () => {
  it('does not leak cwd between requests on the same session', async () => {
    const { fake, client } = createTestEnv({ poolSize: 1 });

    fake.onPrompt((ctx) => [
      {
        type: 'done',
        result: {
          requestId: ctx.requestId,
          text: ctx.cwd ?? '<no-cwd>',
          usage: { inputTokens: 1, outputTokens: 1 },
          durationMs: 0,
          sessionId: ctx.sessionId,
        },
      },
    ]);

    const a = await client.run('p1', { cwd: '/repo-a' });
    const b = await client.run('p2', { cwd: '/repo-b' });

    expect(a.text).toBe('/repo-a');
    expect(b.text).toBe('/repo-b');
    expect(a.sessionId).toBe(b.sessionId);

    await client.close();
  });
});
