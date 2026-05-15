export interface ClientOptions {
  poolSize?: number;
  maxRequestsPerSession?: number;
  maxSessionAgeMs?: number;
  maxIdleMs?: number;
  acquireTimeoutMs?: number;
  spawnTimeoutMs?: number;
  defaultTimeoutMs?: number;
  /** Path to the `claude` binary. Defaults to `claude` on PATH. */
  claudeBinary?: string;
  /** Base directory for per-session state. Defaults to `./runtime`. */
  runtimeDir?: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  cwd?: string;
  env?: Record<string, string>;
  allowedTools?: string[];
  model?: string;
  timeoutMs?: number;
  /** Opaque request id surfaced in logs/metrics. Auto-generated if omitted. */
  requestId?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RunResult {
  requestId: string;
  text: string;
  usage: TokenUsage;
  durationMs: number;
  /** Which warm session served it (for debugging only). */
  sessionId: string;
}

export type RunStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; ok: boolean }
  | { type: 'done'; result: RunResult }
  | { type: 'error'; error: { code: KeepaliveErrorCode; message: string } };

export type KeepaliveErrorCode =
  | 'TIMEOUT'
  | 'ABORTED'
  | 'POOL_EXHAUSTED'
  | 'SESSION_CRASHED'
  | 'CLAUDE_ERROR'
  | 'INVALID_OPTIONS';

export interface ClientEvents {
  'session.spawned': (info: { sessionId: string }) => void;
  /**
   * Emitted when a warm session is evicted from the pool. `detail` is an
   * optional, free-form diagnostic string — when `reason === 'crashed'` it
   * typically carries an exit code plus a tail of the underlying claude
   * process's stderr, suitable for operator triage.
   */
  'session.evicted': (info: { sessionId: string; reason: EvictionReason; detail?: string }) => void;
  'request.done': (info: { requestId: string; sessionId: string; durationMs: number }) => void;
  'request.error': (info: { requestId: string; code: KeepaliveErrorCode }) => void;
}

export type EvictionReason =
  | 'crashed'
  | 'max_requests'
  | 'max_age'
  | 'max_idle'
  | 'dirty'
  | 'closed';

export interface KeepaliveClient {
  /** Synchronous-style: returns when claude has finished. */
  run(prompt: string, opts?: RunOptions): Promise<RunResult>;

  /** Streaming: yields incremental events. `done` or `error` closes the iterator. */
  runStream(prompt: string, opts?: RunOptions): AsyncIterable<RunStreamEvent>;

  /** Idempotent. Drains in-flight requests, then force-kills. */
  close(): Promise<void>;

  on<E extends keyof ClientEvents>(event: E, listener: ClientEvents[E]): this;
  off<E extends keyof ClientEvents>(event: E, listener: ClientEvents[E]): this;
}
