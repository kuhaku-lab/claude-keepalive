import { describe, expect, it } from 'vitest';
import type { EvictionReason } from '../../src/index.js';
import { createTestEnv } from '../helpers/index.js';

describe('pool: eviction by age (fake clock)', () => {
  it('evicts a session past maxSessionAgeMs and respawns', async () => {
    const { fake, client, clock } = createTestEnv({
      poolSize: 1,
      maxSessionAgeMs: 60_000,
    });

    const evictions: EvictionReason[] = [];
    client.on('session.evicted', ({ reason }) => evictions.push(reason));

    const a = await client.run('first');
    clock.advance(60_001);
    const b = await client.run('second');

    expect(fake.spawnCount).toBe(2);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(evictions).toContain('max_age');

    await client.close();
  });

  it('evicts after maxRequestsPerSession', async () => {
    const { fake, client } = createTestEnv({
      poolSize: 1,
      maxRequestsPerSession: 2,
    });

    const evictions: EvictionReason[] = [];
    client.on('session.evicted', ({ reason }) => evictions.push(reason));

    await client.run('one');
    await client.run('two');
    await client.run('three');

    expect(fake.spawnCount).toBe(2);
    expect(evictions).toContain('max_requests');

    await client.close();
  });
});
