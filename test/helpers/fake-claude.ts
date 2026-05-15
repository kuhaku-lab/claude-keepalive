import { EventEmitter } from 'node:events';
import type { RunStreamEvent } from '../../src/api/types.js';
import type { Clock } from '../../src/core/clock.js';
import type { Session, SessionFactory, SessionRunOptions } from '../../src/session/index.js';

export interface PromptContext {
  prompt: string;
  cwd: string | undefined;
  allowedTools: readonly string[] | undefined;
  requestId: string;
  sessionId: string;
}

export type FakeResponder = (ctx: PromptContext) => RunStreamEvent[] | Promise<RunStreamEvent[]>;

export interface FakeClaudeOptions {
  /** Tokens-or-events to return for each prompt. Default echoes the prompt. */
  responder?: FakeResponder;
  clock: Clock;
}

export interface FakeClaude {
  readonly factory: SessionFactory;
  readonly spawnCount: number;
  /** Make the next spawned session crash when it receives its next request. */
  crashNextRequest(): void;
  /** Override the responder. */
  onPrompt(responder: FakeResponder): void;
}

class FakeSession implements Session {
  readonly id: string;
  readonly spawnedAt: number;
  private served = 0;
  private destroyed = false;
  private readonly emitter = new EventEmitter();

  constructor(
    id: string,
    clock: Clock,
    private readonly state: FakeClaudeState,
  ) {
    this.id = id;
    this.spawnedAt = clock.now();
  }

  get requestsServed(): number {
    return this.served;
  }

  async *run(prompt: string, opts: SessionRunOptions): AsyncIterable<RunStreamEvent> {
    if (this.destroyed) throw new Error('session destroyed');
    this.served += 1;

    if (this.state.crashNext) {
      this.state.crashNext = false;
      // Yield the SESSION_CRASHED error and emit crash for the pool to evict.
      yield {
        type: 'error',
        error: { code: 'SESSION_CRASHED', message: 'fake crash' },
      };
      queueMicrotask(() => this.emitter.emit('crash', { reason: 'fake_crash' }));
      return;
    }

    const ctx: PromptContext = {
      prompt,
      cwd: opts.cwd,
      allowedTools: opts.allowedTools,
      requestId: opts.requestId,
      sessionId: this.id,
    };
    const events = await this.state.responder(ctx);
    for (const ev of events) {
      yield ev;
    }
  }

  on(event: 'crash', listener: (info: { reason: string }) => void): void {
    this.emitter.on(event, listener);
  }

  off(event: 'crash', listener: (info: { reason: string }) => void): void {
    this.emitter.off(event, listener);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

interface FakeClaudeState {
  responder: FakeResponder;
  crashNext: boolean;
}

export function createFakeClaude(opts: FakeClaudeOptions): FakeClaude {
  const state: FakeClaudeState = {
    responder: opts.responder ?? defaultResponder,
    crashNext: false,
  };
  let spawnCount = 0;
  let nextId = 0;

  const factory: SessionFactory = {
    async spawn(): Promise<Session> {
      spawnCount += 1;
      const id = `fake-s${nextId++}`;
      return new FakeSession(id, opts.clock, state);
    },
  };

  return {
    factory,
    get spawnCount() {
      return spawnCount;
    },
    crashNextRequest() {
      state.crashNext = true;
    },
    onPrompt(responder) {
      state.responder = responder;
    },
  };
}

function defaultResponder(ctx: PromptContext): RunStreamEvent[] {
  return [
    { type: 'token', text: ctx.prompt },
    {
      type: 'done',
      result: {
        requestId: ctx.requestId,
        text: ctx.prompt,
        usage: { inputTokens: 1, outputTokens: 1 },
        durationMs: 0,
        sessionId: ctx.sessionId,
      },
    },
  ];
}
