import type { Clock } from '../core/clock.js';

export interface IdleSummary {
  ticks: number;
  estimatedTokens: number;
  windowStartedAt: number;
  windowEndedAt: number;
}

/**
 * Aggregates idle stop-hook ticks into 60-second windows. Per
 * [[keepalive-session]] §"Idle tick accounting": don't log every tick;
 * emit a summary periodically.
 */
export class IdleTicker {
  private ticks = 0;
  private windowStartedAt: number;

  constructor(
    private readonly clock: Clock,
    private readonly tokensPerTick: number = 20,
    private readonly windowMs: number = 60_000,
  ) {
    this.windowStartedAt = clock.now();
  }

  tick(): void {
    this.ticks += 1;
  }

  shouldFlush(): boolean {
    return this.clock.now() - this.windowStartedAt >= this.windowMs;
  }

  flush(): IdleSummary {
    const endedAt = this.clock.now();
    const summary: IdleSummary = {
      ticks: this.ticks,
      estimatedTokens: this.ticks * this.tokensPerTick,
      windowStartedAt: this.windowStartedAt,
      windowEndedAt: endedAt,
    };
    this.ticks = 0;
    this.windowStartedAt = endedAt;
    return summary;
  }
}
