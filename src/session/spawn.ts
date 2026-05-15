import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { KeepaliveError } from '../api/errors.js';
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
 *   executable. It is referenced from a per-session `.claude/settings.json`
 *   so `claude` picks it up when launched with `cwd = paths.root`.
 * - `--append-system-prompt` carries the response-write contract the
 *   framing layer enforces ([[keepalive-session]] §"Response capture").
 * - `--dangerously-skip-permissions` is required because the agent will be
 *   writing per-request response files without an interactive prompt.
 *
 * The `.ready` handshake (claude has booted and the stop hook has fired
 * at least once) is signalled by the first `.last-tick` write. We poll for
 * its appearance and reject with SPAWN_TIMEOUT if it never lands.
 */
const READY_POLL_INTERVAL_MS = 100;

async function waitForReady(
  paths: SessionPaths,
  spawnTimeoutMs: number,
  clock: Clock,
  sleeper: Sleeper,
): Promise<void> {
  const deadline = clock.now() + spawnTimeoutMs;
  while (clock.now() < deadline) {
    try {
      await stat(paths.lastTick);
      return; // `.last-tick` exists → at least one stop-hook fire completed
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await sleeper.sleep(READY_POLL_INTERVAL_MS);
  }
  throw new KeepaliveError(
    'SPAWN_TIMEOUT',
    `claude did not reach ready (no .last-tick within ${spawnTimeoutMs}ms)`,
    '',
  );
}

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

  // Block until claude has booted, fired its first stop hook, and our
  // hook script has written `.last-tick`. Reject as SPAWN_TIMEOUT if
  // claude never gets there in spawnTimeoutMs. If we returned without
  // waiting, callers that call prewarm() (or rely on the first request
  // being fast) would still pay the boot cost.
  try {
    await waitForReady(paths, inputs.spawnTimeoutMs, inputs.clock, inputs.sleeper);
  } catch (err) {
    // Clean up the doomed process; the caller will not get a Session.
    try {
      proc.kill('SIGTERM');
    } catch {
      /* best-effort */
    }
    throw err;
  }
  return { proc, paths };
}
