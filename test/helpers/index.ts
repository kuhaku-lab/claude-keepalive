import { buildClient } from '../../src/api/client.js';
import type { ClientOptions, KeepaliveClient } from '../../src/api/types.js';
import type { SessionFactory } from '../../src/session/index.js';
import { createFakeClaude, type FakeClaude } from './fake-claude.js';
import { createTestClock, immediateSleeper, type TestClock } from './test-clock.js';

export type { FakeClaude } from './fake-claude.js';
export { createFakeClaude } from './fake-claude.js';
export type { TestClock } from './test-clock.js';
export { createTestClock, immediateSleeper } from './test-clock.js';

export interface TestPoolInputs extends ClientOptions {
  factory: SessionFactory;
  clock?: TestClock;
}

export interface TestPool extends KeepaliveClient {
  readonly clock: TestClock;
}

export function createTestPool(inputs: TestPoolInputs): TestPool {
  const clock = inputs.clock ?? createTestClock();
  let counter = 0;
  const client = buildClient(inputs, {
    factory: inputs.factory,
    clock,
    sleeper: immediateSleeper,
    random: {
      sessionId: () => `s-${counter++}`,
      requestId: () => `req-${counter++}`,
    },
  });
  return Object.assign(client, { clock });
}

export function createTestEnv(opts: ClientOptions = {}): {
  fake: FakeClaude;
  client: TestPool;
  clock: TestClock;
} {
  const clock = createTestClock();
  const fake = createFakeClaude({ clock });
  const client = createTestPool({ ...opts, factory: fake.factory, clock });
  return { fake, client, clock };
}
