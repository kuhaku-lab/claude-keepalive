import { join } from 'node:path';

export interface SessionPaths {
  root: string;
  pid: string;
  ready: string;
  /** Presence-only flag: real request is in flight. */
  inRequest: string;
  /** Text file: the prompt the hook should inject as `reason`. */
  prompt: string;
  /** Plain text: current request id (for log correlation). */
  requestId: string;
  /** Presence-only flag: the previous hook fire just injected a real prompt. */
  responded: string;
  /** Directory under which per-request `.response-<requestId>.json` files appear. */
  responsesDir: string;
  lastTick: string;
  counters: string;
  hookLog: string;
  hookScript: string;
}

export function sessionPaths(runtimeDir: string, sessionId: string): SessionPaths {
  const root = join(runtimeDir, 'sessions', sessionId);
  return {
    root,
    pid: join(root, '.pid'),
    ready: join(root, '.ready'),
    inRequest: join(root, '.in-request'),
    prompt: join(root, '.prompt'),
    requestId: join(root, '.request-id'),
    responded: join(root, '.responded'),
    responsesDir: join(root, '.responses'),
    lastTick: join(root, '.last-tick'),
    counters: join(root, '.counters.json'),
    hookLog: join(root, 'hook.log'),
    hookScript: join(root, 'stop-hook.sh'),
  };
}

export function responseFilePath(paths: SessionPaths, requestId: string): string {
  return join(paths.responsesDir, `.response-${requestId}.json`);
}
