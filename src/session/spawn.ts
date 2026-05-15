import { chmod, mkdir, writeFile } from 'node:fs/promises';
import type { Clock, Sleeper } from '../core/clock.js';
import type { ProcessHandle, ProcessLauncher } from '../core/proc.js';
import type { Framing } from './framing.js';
import { renderHookScript } from './hook.js';
import { type SessionPaths, sessionPaths } from './paths.js';

export interface SpawnInputs {
  sessionId: string;
  runtimeDir: string;
  claudeBinary: string;
  spawnTimeoutMs: number;
  launcher: ProcessLauncher;
  clock: Clock;
  sleeper: Sleeper;
  framing: Framing;
  model?: string;
  /** Initial prompt fed at launch. Defaults to a no-op idle nudge. */
  initialPrompt?: string;
}

export interface SpawnedProcess {
  proc: ProcessHandle;
  paths: SessionPaths;
}

/**
 * Spawn one warm `claude` process in **interactive mode** with the stop-hook
 * installed and the response-capture system prompt appended.
 *
 * - The hook script is written to `<sessionDir>/stop-hook.sh` and made
 *   executable. It must be referenced from a per-session settings file so
 *   `claude` picks it up; how that's done depends on the CLI version
 *   (`.claude/settings.json` in the session cwd is the canonical path).
 * - `--append-system-prompt` carries the response-write contract the
 *   framing layer enforces ([[keepalive-session]] §"Response capture").
 * - `--dangerously-skip-permissions` is required because the agent will be
 *   writing per-request response files without an interactive prompt.
 *
 * The `.ready` handshake (claude has booted and read CLAUDE.md) is signalled
 * by the first idle tick landing — which the hook records by writing
 * `.last-tick`. TODO: actually wait on `.last-tick` here.
 */
export async function spawnWarmProcess(inputs: SpawnInputs): Promise<SpawnedProcess> {
  const paths = sessionPaths(inputs.runtimeDir, inputs.sessionId);
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.responsesDir, { recursive: true });

  // Per-session .claude/settings.json wires the stop hook to our script.
  const settingsDir = `${paths.root}/.claude`;
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    `${settingsDir}/settings.json`,
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [{ type: 'command', command: paths.hookScript, timeout: 30 }],
            },
          ],
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  await writeFile(paths.hookScript, renderHookScript(paths), 'utf8');
  await chmod(paths.hookScript, 0o755);

  const systemPromptText = inputs.framing.systemPrompt(paths);
  const args: string[] = ['--dangerously-skip-permissions'];
  if (inputs.model) args.push('--model', inputs.model);
  args.push('--append-system-prompt', systemPromptText);
  args.push(inputs.initialPrompt ?? 'Ready. Awaiting tasks via the stop-hook channel.');

  const proc = inputs.launcher.launch(inputs.claudeBinary, args, {
    cwd: paths.root,
    env: { CLAUDE_KEEPALIVE_SESSION_DIR: paths.root },
  });

  // TODO: wait for `paths.lastTick` to appear (first idle tick), or reject
  // after spawnTimeoutMs. For now we return immediately; the first real
  // request will block on the response-file poll until claude is ready.
  return { proc, paths };
}
