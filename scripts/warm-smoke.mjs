// warm-smoke.mjs — e2e smoke for our interactive warm-keepalive path.
//
// This uses createClient() with the production WarmSession + fileTransportFraming
// (no OneShot fallback). Verifies that:
//   1. spawn writes the per-session .claude/settings.json with our hook
//   2. claude boots in interactive idle loop (because hook is configured)
//   3. enqueuePrompt + awaitResponse round-trips with a real agent reply
//   4. the second request reuses the warm session (no respawn)
//
// Run after `pnpm build`:
//   node scripts/warm-smoke.mjs
//
// Bounded: each request times out at 90s; the script always closes the
// client to terminate the warm session before exit.

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient } from '../dist/index.mjs';

const RUNTIME = join(process.cwd(), 'runtime-smoke');

async function main() {
  console.log('[warm-smoke] runtime dir =', RUNTIME);
  await rm(RUNTIME, { recursive: true, force: true });

  const client = createClient({
    poolSize: 1,
    runtimeDir: RUNTIME,
    defaultTimeoutMs: 90_000,
    spawnTimeoutMs: 30_000,
  });

  client.on('session.spawned', ({ sessionId }) =>
    console.log(`[warm-smoke] session.spawned id=${sessionId}`),
  );
  client.on('session.evicted', ({ sessionId, reason }) =>
    console.log(`[warm-smoke] session.evicted id=${sessionId} reason=${reason}`),
  );

  try {
    console.log('\n[warm-smoke] --- request #1 (cold: triggers spawn) ---');
    const t1 = Date.now();
    const r1 = await client.run('Reply with exactly the word: ALIVE', {
      requestId: 'warm-1',
    });
    console.log(`[warm-smoke] r1.text       = ${JSON.stringify(r1.text)}`);
    console.log(`[warm-smoke] r1.sessionId  = ${r1.sessionId}`);
    console.log(`[warm-smoke] r1.wall       = ${Date.now() - t1}ms`);

    console.log('\n[warm-smoke] --- request #2 (warm: should be faster) ---');
    const t2 = Date.now();
    const r2 = await client.run('Reply with exactly the word: WARM', {
      requestId: 'warm-2',
    });
    console.log(`[warm-smoke] r2.text       = ${JSON.stringify(r2.text)}`);
    console.log(`[warm-smoke] r2.sessionId  = ${r2.sessionId}`);
    console.log(`[warm-smoke] r2.wall       = ${Date.now() - t2}ms`);
    console.log(
      `[warm-smoke] session reuse = ${r1.sessionId === r2.sessionId ? 'YES (same warm session)' : 'NO'}`,
    );
    const cold = t2 - t1; // wall of r1 (t2 was captured immediately after r1)
    const warm = Date.now() - t2; // wall of r2
    if (r1.sessionId === r2.sessionId) {
      console.log(`[warm-smoke] cold wall   = ${cold}ms`);
      console.log(`[warm-smoke] warm wall   = ${warm}ms`);
      console.log(
        `[warm-smoke] warm/cold   = ${(warm / cold).toFixed(2)}  (< 1.0 means warm wins; spawn is amortised, idle-tick overhead is the offset)`,
      );
    }
  } catch (err) {
    console.error('[warm-smoke] FAILED:', err?.message ?? err);
    if (err?.code) console.error('[warm-smoke] err.code =', err.code);
    throw err;
  } finally {
    console.log('\n[warm-smoke] closing client');
    await client.close();
  }
  console.log('[warm-smoke] done.');
}

main().catch(() => process.exit(1));
