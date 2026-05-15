import { type ChildProcess, spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

export interface ProcessHandle extends EventEmitter {
  readonly pid: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ProcessLaunchOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface ProcessLauncher {
  launch(command: string, args: readonly string[], opts?: ProcessLaunchOptions): ProcessHandle;
}

export const systemProcessLauncher: ProcessLauncher = {
  launch(command, args, opts) {
    // stdin = 'ignore' is the load-bearing detail here. claude detects an
    // open-but-empty stdin pipe as "data still coming, wait" and after a
    // short timeout falls back to a one-shot (-p-equivalent) execution path
    // where Stop hooks never fire — defeating the warm-keepalive trick.
    // Wiring stdin to /dev/null (which 'ignore' does on POSIX) makes claude
    // see immediate EOF and enter the idle stop-hook loop properly. stdout
    // and stderr stay piped so WarmSession can drain them.
    const child: ChildProcess = spawn(command, [...args], {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return child as unknown as ProcessHandle;
  },
};
