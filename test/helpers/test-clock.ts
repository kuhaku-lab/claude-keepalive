import type { Clock, Sleeper } from '../../src/core/clock.js';

export interface TestClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

export function createTestClock(initial = 0): TestClock {
  let t = initial;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
    set(ms) {
      t = ms;
    },
  };
}

export const immediateSleeper: Sleeper = {
  sleep: async () => undefined,
};
