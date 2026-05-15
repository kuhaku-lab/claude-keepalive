import type { RunStreamEvent } from '../api/types.js';

export interface SessionRunOptions {
  requestId: string;
  cwd?: string;
  env?: Record<string, string>;
  allowedTools?: string[];
  model?: string;
  signal?: AbortSignal;
}

/**
 * Pool-facing interface for one warm `claude` process. Sessions are dumb —
 * they know how to run a single prompt at a time and surface crash/done.
 * Routing decisions live in the pool ([[keepalive-invariants]] rule 4).
 */
export interface Session {
  readonly id: string;
  readonly spawnedAt: number;
  readonly requestsServed: number;

  /** Streams events for one request. Must not be called concurrently on the same session. */
  run(prompt: string, opts: SessionRunOptions): AsyncIterable<RunStreamEvent>;

  /** Subscribe to lifecycle events. */
  on(event: 'crash', listener: (info: { reason: string }) => void): void;
  off(event: 'crash', listener: (info: { reason: string }) => void): void;

  /** Terminate the underlying process. Idempotent. */
  destroy(): Promise<void>;
}

export interface SessionFactory {
  spawn(): Promise<Session>;
}

export { WarmSession } from './warm-session.js';
