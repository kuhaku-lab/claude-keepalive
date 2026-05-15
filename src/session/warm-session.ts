import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import type { RunStreamEvent } from '../api/types.js';
import type { Clock, Sleeper } from '../core/clock.js';
import type { ProcessHandle } from '../core/proc.js';
import type { Framing } from './framing.js';
import type { Session, SessionRunOptions } from './index.js';
import type { SessionPaths } from './paths.js';

export interface WarmSessionInputs {
  id: string;
  proc: ProcessHandle;
  paths: SessionPaths;
  framing: Framing;
  clock: Clock;
  sleeper: Sleeper;
  responseTimeoutMs: number;
  pollIntervalMs: number;
}

/**
 * Production Session backed by a real `claude` process running in interactive
 * mode. Prompt injection is via the stop-hook `{decision:'block', reason}`
 * channel (see [[keepalive-session]] §"The trick"), and response capture is
 * via the per-request `.responses/.response-<requestId>.json` file written
 * by the agent under the system-prompt contract.
 *
 * Sessions are dumb: they expose `run` + `destroy` + a `'crash'` event and
 * nothing else. Pool decisions live in the pool ([[keepalive-invariants]]
 * rule 4).
 */
export class WarmSession implements Session {
  readonly id: string;
  readonly spawnedAt: number;
  private served = 0;
  private destroyed = false;
  private readonly emitter = new EventEmitter();

  constructor(private readonly inputs: WarmSessionInputs) {
    this.id = inputs.id;
    this.spawnedAt = inputs.clock.now();
    inputs.proc.on('exit', (code: number | null) => {
      if (!this.destroyed) {
        this.emitter.emit('crash', { reason: `exit:${code ?? 'unknown'}` });
      }
    });
  }

  get requestsServed(): number {
    return this.served;
  }

  async *run(prompt: string, opts: SessionRunOptions): AsyncIterable<RunStreamEvent> {
    if (this.destroyed) throw new Error('session destroyed');
    this.served += 1;
    const { framing, paths, clock, sleeper, responseTimeoutMs, pollIntervalMs } = this.inputs;

    try {
      await framing.enqueuePrompt(paths, prompt, opts);
      for await (const ev of framing.awaitResponse(
        paths,
        opts,
        { responseTimeoutMs, pollIntervalMs },
        { clock, sleeper },
      )) {
        if (ev.type === 'done') {
          yield {
            type: 'done',
            result: { ...ev.result, sessionId: this.id },
          };
          return;
        }
        yield ev;
      }
    } finally {
      await framing.clearRequest(paths, opts.requestId).catch(() => {
        /* best-effort cleanup */
      });
    }
  }

  on(event: 'crash', listener: (info: { reason: string }) => void): void {
    this.emitter.on(event, listener);
  }

  off(event: 'crash', listener: (info: { reason: string }) => void): void {
    this.emitter.off(event, listener);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.inputs.proc.kill('SIGTERM');
    } catch {
      /* best-effort */
    }
    // Clear the per-session state dir so a future spawn that happens to draw
    // the same session id never sees stale flag files (.responded, .prompt,
    // partial response captures, etc.). claude is being terminated anyway,
    // so any in-flight writes it loses are by definition discardable.
    try {
      await rm(this.inputs.paths.root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
