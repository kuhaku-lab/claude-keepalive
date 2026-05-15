/**
 * Shared vitest fixtures. Use these to avoid repeating `beforeEach`/
 * `afterEach` boilerplate across integration and e2e tests.
 *
 * Import as `test` (not `it`) to get the extended context:
 *
 *   import { test } from '../helpers/fixtures.js';
 *
 *   test('does X', async ({ runtime }) => { ... });
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base } from 'vitest';
import { type ClientOptions, createClient, type KeepaliveClient } from '../../src/index.js';

interface Fixtures {
  /** A fresh tmpdir, auto-cleaned at end of test. */
  runtime: string;
  /**
   * A KeepaliveClient pre-configured with `runtimeDir: runtime` and
   * `poolSize: 1`. Closed automatically at end of test. Override knobs
   * via `clientOptions` (see below).
   */
  client: KeepaliveClient;
  /** Per-test override of the ClientOptions used by `client`. */
  clientOptions: ClientOptions;
}

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: vitest test.extend API requires the destructured arg
  runtime: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'kalive-'));
    await use(dir);
    await rm(dir, { recursive: true, force: true });
  },
  // Default to no overrides; individual tests can do
  //   test.extend({ clientOptions: { poolSize: 2 } })('foo', ...)
  clientOptions: {},
  client: async ({ runtime, clientOptions }, use) => {
    const c = createClient({
      poolSize: 1,
      runtimeDir: runtime,
      defaultTimeoutMs: 90_000,
      ...clientOptions,
    });
    await use(c);
    await c.close();
  },
});
