import { describe, expect, it } from 'vitest';
import { KeepaliveError } from '../../src/index.js';
import { createTestEnv } from '../helpers/index.js';

describe('pool: crash recovery (invariants rule 7)', () => {
  it('respawns after SESSION_CRASHED', async () => {
    const { fake, client } = createTestEnv({ poolSize: 1 });

    fake.crashNextRequest();
    await expect(client.run('p')).rejects.toBeInstanceOf(KeepaliveError);

    // Yield so the queued microtask emitting 'crash' fires before next acquire.
    await new Promise((r) => setImmediate(r));

    const r = await client.run('p');
    expect(r.text).toBe('p');
    expect(fake.spawnCount).toBe(2);

    await client.close();
  });
});
