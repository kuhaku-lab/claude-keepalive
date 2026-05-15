export interface Clock {
  now(): number;
}

export interface Sleeper {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export const systemSleeper: Sleeper = {
  sleep(ms, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
};

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
