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
  /**
   * Optional prompt run on each warm session at `prewarm()` time. The
   * response is discarded. Use a prompt whose prefix matches your real
   * workload to pre-fill Anthropic's prompt cache too — analogous to the
   * warmup-request pattern at
   * https://platform.claude.com/docs/en/build-with-claude/prompt-caching
   * but applied at the warm-pool layer. If omitted, prewarm() only
   * amortises CLI process startup; spawn cost is the only thing eliminated.
   */
  warmupPrompt?: string;
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
  | 'SPAWN_TIMEOUT'
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

  /**
   * Spawn up to `poolSize` warm sessions, waiting until each is in the idle
   * stop-hook loop. If `ClientOptions.warmupPrompt` is set, also run that
   * prompt on every session (response discarded) to populate Anthropic's
   * prompt cache. Resolves when all warmups complete; rejects with
   * `SPAWN_TIMEOUT` if any session fails to reach ready in `spawnTimeoutMs`.
   *
   * Idempotent. Safe to call from a SIGUSR1 handler or before a known
   * traffic burst.
   */
  prewarm(): Promise<void>;

  /** Idempotent. Drains in-flight requests, then force-kills. */
  close(): Promise<void>;

  on<E extends keyof ClientEvents>(event: E, listener: ClientEvents[E]): this;
  off<E extends keyof ClientEvents>(event: E, listener: ClientEvents[E]): this;
}
