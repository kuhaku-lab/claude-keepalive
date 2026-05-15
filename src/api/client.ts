import { EventEmitter } from 'node:events';
import type { Clock, Sleeper } from '../core/clock.js';
import type { Random } from '../core/random.js';
import { defaultPoolOptions, Pool, type PoolOptions } from '../pool/index.js';
import type { Session, SessionFactory } from '../session/index.js';
import { KeepaliveError } from './errors.js';
import type {
  ClientEvents,
  ClientOptions,
  KeepaliveClient,
  KeepaliveErrorCode,
  RunOptions,
  RunResult,
  RunStreamEvent,
  TokenUsage,
} from './types.js';

export interface ClientDeps {
  factory: SessionFactory;
  clock: Clock;
  sleeper: Sleeper;
  random: Random;
}

export function buildClient(opts: ClientOptions, deps: ClientDeps): KeepaliveClient {
  const poolOpts: PoolOptions = {
    ...defaultPoolOptions,
    ...(opts.poolSize !== undefined ? { size: opts.poolSize } : {}),
    ...(opts.maxRequestsPerSession !== undefined
      ? { maxRequestsPerSession: opts.maxRequestsPerSession }
      : {}),
    ...(opts.maxSessionAgeMs !== undefined ? { maxSessionAgeMs: opts.maxSessionAgeMs } : {}),
    ...(opts.maxIdleMs !== undefined ? { maxIdleMs: opts.maxIdleMs } : {}),
    ...(opts.acquireTimeoutMs !== undefined ? { acquireTimeoutMs: opts.acquireTimeoutMs } : {}),
    ...(opts.spawnTimeoutMs !== undefined ? { spawnTimeoutMs: opts.spawnTimeoutMs } : {}),
  };
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 5 * 60_000;

  const pool = new Pool(poolOpts, deps);
  const emitter = new EventEmitter();

  pool.on('session.spawned', (info) => emitter.emit('session.spawned', info));
  pool.on('session.evicted', (info) => emitter.emit('session.evicted', info));

  const client: KeepaliveClient = {
    async run(prompt, runOpts) {
      const events: RunStreamEvent[] = [];
      for await (const ev of executeRequest(prompt, runOpts, {
        pool,
        random: deps.random,
        clock: deps.clock,
        defaultTimeoutMs,
        emitter,
        sleeper: deps.sleeper,
      })) {
        events.push(ev);
      }
      const done = events.find((e) => e.type === 'done');
      if (done && done.type === 'done') return done.result;
      const errEv = events.find((e) => e.type === 'error');
      const code: KeepaliveErrorCode = errEv?.type === 'error' ? errEv.error.code : 'CLAUDE_ERROR';
      const msg = errEv?.type === 'error' ? errEv.error.message : 'stream ended without done';
      throw new KeepaliveError(code, msg, runOpts?.requestId ?? '');
    },
    runStream(prompt, runOpts) {
      return executeRequest(prompt, runOpts, {
        pool,
        random: deps.random,
        clock: deps.clock,
        defaultTimeoutMs,
        emitter,
        sleeper: deps.sleeper,
      });
    },
    async prewarm() {
      // (1) spawn every pool slot and wait until each session is ready
      await pool.prewarm();
      // (2) optional: run warmupPrompt on every session to also warm
      // Anthropic's prompt cache (cf. the public docs on pre-warming).
      const wp = opts.warmupPrompt;
      if (wp) {
        const poolSize = poolOpts.size;
        await Promise.all(
          Array.from({ length: poolSize }, (_, i) =>
            client
              .run(wp, { requestId: `warmup-${deps.random.requestId()}-${i}` })
              .then(() => undefined),
          ),
        );
      }
    },
    async close() {
      await pool.close();
    },
    on<E extends keyof ClientEvents>(event: E, listener: ClientEvents[E]) {
      emitter.on(event, listener as (...args: unknown[]) => void);
      return client;
    },
    off<E extends keyof ClientEvents>(event: E, listener: ClientEvents[E]) {
      emitter.off(event, listener as (...args: unknown[]) => void);
      return client;
    },
  };

  return client;
}

interface RequestCtx {
  pool: Pool;
  random: Random;
  clock: Clock;
  sleeper: Sleeper;
  defaultTimeoutMs: number;
  emitter: EventEmitter;
}

function executeRequest(
  prompt: string,
  runOpts: RunOptions | undefined,
  ctx: RequestCtx,
): AsyncIterable<RunStreamEvent> {
  const requestId = runOpts?.requestId ?? ctx.random.requestId();
  const timeoutMs = runOpts?.timeoutMs ?? ctx.defaultTimeoutMs;
  const startedAt = ctx.clock.now();

  return {
    [Symbol.asyncIterator]() {
      return runIterator(prompt, runOpts, ctx, { requestId, timeoutMs, startedAt });
    },
  };
}

async function* runIterator(
  prompt: string,
  runOpts: RunOptions | undefined,
  ctx: RequestCtx,
  meta: { requestId: string; timeoutMs: number; startedAt: number },
): AsyncGenerator<RunStreamEvent> {
  const ac = new AbortController();
  const onUserAbort = () => ac.abort(runOpts?.signal?.reason);
  if (runOpts?.signal) {
    if (runOpts.signal.aborted) ac.abort(runOpts.signal.reason);
    else runOpts.signal.addEventListener('abort', onUserAbort, { once: true });
  }
  const timer = setTimeout(() => {
    ac.abort(new KeepaliveError('TIMEOUT', `request exceeded ${meta.timeoutMs}ms`, meta.requestId));
  }, meta.timeoutMs);

  let session: Session;
  try {
    session = await ctx.pool.acquire({ requestId: meta.requestId, signal: ac.signal });
  } catch (err) {
    clearTimeout(timer);
    runOpts?.signal?.removeEventListener('abort', onUserAbort);
    const code: KeepaliveErrorCode = err instanceof KeepaliveError ? err.code : 'POOL_EXHAUSTED';
    const message = err instanceof Error ? err.message : 'acquire failed';
    ctx.emitter.emit('request.error', { requestId: meta.requestId, code });
    yield { type: 'error', error: { code, message } };
    return;
  }

  let dirty = false;
  let collected = '';
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  try {
    for await (const ev of session.run(prompt, {
      requestId: meta.requestId,
      ...(runOpts?.cwd !== undefined ? { cwd: runOpts.cwd } : {}),
      ...(runOpts?.env !== undefined ? { env: runOpts.env } : {}),
      ...(runOpts?.allowedTools !== undefined ? { allowedTools: runOpts.allowedTools } : {}),
      ...(runOpts?.model !== undefined ? { model: runOpts.model } : {}),
      signal: ac.signal,
    })) {
      if (ac.signal.aborted) {
        dirty = true;
        const reason = ac.signal.reason;
        const code: KeepaliveErrorCode = reason instanceof KeepaliveError ? reason.code : 'ABORTED';
        const message = reason instanceof Error ? reason.message : 'aborted';
        ctx.emitter.emit('request.error', { requestId: meta.requestId, code });
        yield { type: 'error', error: { code, message } };
        return;
      }
      if (ev.type === 'token') collected += ev.text;
      if (ev.type === 'done') {
        usage = ev.result.usage;
        const result: RunResult = {
          requestId: meta.requestId,
          text: collected || ev.result.text,
          usage,
          durationMs: ctx.clock.now() - meta.startedAt,
          sessionId: session.id,
        };
        ctx.emitter.emit('request.done', {
          requestId: meta.requestId,
          sessionId: session.id,
          durationMs: result.durationMs,
        });
        yield { type: 'done', result };
        return;
      }
      if (ev.type === 'error') {
        dirty = true;
        ctx.emitter.emit('request.error', { requestId: meta.requestId, code: ev.error.code });
        yield ev;
        return;
      }
      yield ev;
    }
    // Stream ended without done — treat as session crash.
    dirty = true;
    ctx.emitter.emit('request.error', {
      requestId: meta.requestId,
      code: 'SESSION_CRASHED',
    });
    yield {
      type: 'error',
      error: { code: 'SESSION_CRASHED', message: 'stream ended without done event' },
    };
  } catch (err) {
    dirty = true;
    const code: KeepaliveErrorCode = err instanceof KeepaliveError ? err.code : 'SESSION_CRASHED';
    const message = err instanceof Error ? err.message : String(err);
    ctx.emitter.emit('request.error', { requestId: meta.requestId, code });
    yield { type: 'error', error: { code, message } };
  } finally {
    clearTimeout(timer);
    runOpts?.signal?.removeEventListener('abort', onUserAbort);
    ctx.pool.release(session, { dirty });
  }
}
