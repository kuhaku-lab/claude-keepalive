// Manual smoke against the real `claude` CLI.
// Run after `pnpm build`:
//   node scripts/smoke.mjs
//
// NOTE: This uses a OneShot session factory (spawns `claude -p` per request).
// The warm stop-hook trick is not yet wired — this verifies the API/Pool
// layer end-to-end with the real binary.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { _internal_buildClient } from '../dist/index.js';
import { systemClock, systemSleeper } from '../dist/core/clock.js';
import { systemRandom } from '../dist/core/random.js';

class OneShotSession extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.spawnedAt = Date.now();
    this._served = 0;
    this._destroyed = false;
  }
  get requestsServed() {
    return this._served;
  }
  async *run(prompt, opts) {
    if (this._destroyed) throw new Error('session destroyed');
    this._served += 1;
    const args = ['-p', prompt];
    if (opts.model) args.push('--model', opts.model);
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push('--allowedTools', opts.allowedTools.join(','));
    }
    const child = spawn('claude', args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    const onAbort = () => child.kill('SIGTERM');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 0)));
    opts.signal?.removeEventListener('abort', onAbort);
    const text = Buffer.concat(out).toString('utf8').trim();
    if (code !== 0) {
      yield {
        type: 'error',
        error: {
          code: 'CLAUDE_ERROR',
          message: `claude exited ${code}: ${Buffer.concat(err).toString('utf8').trim()}`,
        },
      };
      return;
    }
    yield { type: 'token', text };
    yield {
      type: 'done',
      result: {
        requestId: opts.requestId,
        text,
        usage: { inputTokens: 0, outputTokens: 0 },
        durationMs: 0,
        sessionId: this.id,
      },
    };
  }
  async destroy() {
    this._destroyed = true;
  }
}

const oneShotFactory = {
  async spawn() {
    return new OneShotSession(systemRandom.sessionId());
  },
};

async function main() {
  console.log('[smoke] mode=one-shot (real `claude -p` per request)');
  console.log('[smoke] building client poolSize=1');

  const client = _internal_buildClient(
    { poolSize: 1, defaultTimeoutMs: 120_000 },
    { factory: oneShotFactory, clock: systemClock, sleeper: systemSleeper, random: systemRandom },
  );

  client.on('session.spawned', ({ sessionId }) =>
    console.log(`[smoke] session.spawned id=${sessionId}`),
  );
  client.on('session.evicted', ({ sessionId, reason }) =>
    console.log(`[smoke] session.evicted id=${sessionId} reason=${reason}`),
  );

  try {
    console.log('\n[smoke] --- request #1 ---');
    const t1 = Date.now();
    const r1 = await client.run('Reply with exactly the word: ALIVE', { requestId: 'smoke-1' });
    console.log(`[smoke] r1.text       = ${JSON.stringify(r1.text)}`);
    console.log(`[smoke] r1.sessionId  = ${r1.sessionId}`);
    console.log(`[smoke] r1.wall       = ${Date.now() - t1}ms`);

    console.log('\n[smoke] --- request #2 (should reuse pool slot) ---');
    const t2 = Date.now();
    const r2 = await client.run('Reply with exactly the word: WARM', { requestId: 'smoke-2' });
    console.log(`[smoke] r2.text       = ${JSON.stringify(r2.text)}`);
    console.log(`[smoke] r2.sessionId  = ${r2.sessionId}`);
    console.log(`[smoke] r2.wall       = ${Date.now() - t2}ms`);
    console.log(
      `[smoke] session reuse = ${r1.sessionId === r2.sessionId ? 'YES (pool slot reused)' : 'NO'}`,
    );

    console.log('\n[smoke] --- request #3 (streaming) ---');
    for await (const ev of client.runStream('Reply with exactly the word: STREAM', {
      requestId: 'smoke-3',
    })) {
      if (ev.type === 'token') process.stdout.write(`  token: ${JSON.stringify(ev.text)}\n`);
      if (ev.type === 'done')
        console.log(
          `  done. sessionId=${ev.result.sessionId} text=${JSON.stringify(ev.result.text)}`,
        );
      if (ev.type === 'error') console.log(`  error: ${ev.error.code}: ${ev.error.message}`);
    }
  } finally {
    console.log('\n[smoke] closing client');
    await client.close();
  }
  console.log('[smoke] done');
}

main().catch((err) => {
  console.error('[smoke] FAILED', err);
  process.exit(1);
});
