// leakage-smoke.mjs — proves the system-prompt contract is honored:
// information from request N must NOT leak into the response of request N+1
// on the same warm session.
//
// Method:
//   1. Spawn a warm session (poolSize=1, so both requests hit the same claude).
//   2. Request #1 plants a specific token ("the number 17") in the conversation.
//   3. Request #2 asks a topically-unrelated question.
//   4. Assert that "17" does not appear in the response to #2.
//
// If this passes: the system-prompt "each turn is independent" instruction is
// effective and TODO #1's strategy (b) is doing its job.
//
// If this fails: claude is leaking context; we need to investigate strategy (a)
// (e.g. injecting /clear before each real prompt).
//
// Run after `pnpm build`:
//   node scripts/leakage-smoke.mjs
//
// Costs 2 real claude turns. Bounded to ~3 minutes total.

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient } from '../dist/index.mjs';

const RUNTIME = join(process.cwd(), 'runtime-smoke');
const SECRET_TOKEN = '17';
const SECRET_PROMPT = `Remember this number: ${SECRET_TOKEN}. Reply with "ok".`;
const PROBE_PROMPT =
  'What is the capital of Japan? Answer in one word.';

async function main() {
  await rm(RUNTIME, { recursive: true, force: true });

  const client = createClient({
    poolSize: 1,
    runtimeDir: RUNTIME,
    defaultTimeoutMs: 90_000,
    // Force both requests onto the same warm session — that's the failure
    // condition we are testing for. The default poolSize=1 already does this,
    // but we make it explicit.
  });

  client.on('session.spawned', ({ sessionId }) =>
    console.log(`[leakage-smoke] session.spawned id=${sessionId}`),
  );

  let r1Session, r2Session;
  try {
    console.log('\n[leakage-smoke] --- request #1: plant SECRET_TOKEN ---');
    console.log(`  prompt: ${JSON.stringify(SECRET_PROMPT)}`);
    const r1 = await client.run(SECRET_PROMPT, { requestId: 'leak-1' });
    r1Session = r1.sessionId;
    console.log(`  response: ${JSON.stringify(r1.text)}`);
    console.log(`  sessionId: ${r1.sessionId}`);

    console.log('\n[leakage-smoke] --- request #2: probe with UNRELATED prompt ---');
    console.log(`  prompt: ${JSON.stringify(PROBE_PROMPT)}`);
    const r2 = await client.run(PROBE_PROMPT, { requestId: 'leak-2' });
    r2Session = r2.sessionId;
    console.log(`  response: ${JSON.stringify(r2.text)}`);
    console.log(`  sessionId: ${r2.sessionId}`);

    console.log('\n[leakage-smoke] --- analysis ---');
    console.log(`  same session: ${r1Session === r2Session ? 'YES (worst case)' : 'NO (recycled)'}`);

    const r2Text = r2.text.toLowerCase();
    const leaked = r2Text.includes(SECRET_TOKEN);

    if (leaked) {
      console.log(`  ❌ LEAK DETECTED — response #2 contains "${SECRET_TOKEN}"`);
      console.log(`     → system-prompt contract is NOT sufficient; consider /clear injection (TODO #1 strategy (a))`);
      process.exitCode = 1;
    } else {
      console.log(`  ✅ no leak — response #2 did not reference "${SECRET_TOKEN}"`);
      console.log(`     → system-prompt contract holds (strategy (b)) at this prompt difficulty`);
    }
  } catch (err) {
    console.error('[leakage-smoke] FAILED:', err?.message ?? err);
    if (err?.code) console.error('[leakage-smoke] err.code =', err.code);
    process.exitCode = 1;
  } finally {
    console.log('\n[leakage-smoke] closing client');
    await client.close();
  }
}

main();
