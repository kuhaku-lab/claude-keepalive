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
    const child: ChildProcess = spawn(command, [...args], {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return child as unknown as ProcessHandle;
  },
};
