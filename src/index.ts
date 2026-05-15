import { resolve } from 'node:path';
import { buildClient } from './api/client.js';
import type { ClientOptions, KeepaliveClient } from './api/types.js';
import { systemClock, systemSleeper } from './core/clock.js';
import { systemProcessLauncher } from './core/proc.js';
import { systemRandom } from './core/random.js';
import { fileTransportFraming } from './session/framing.js';
import type { Session, SessionFactory } from './session/index.js';
import { spawnWarmProcess } from './session/spawn.js';
import { WarmSession } from './session/warm-session.js';

export { KeepaliveError } from './api/errors.js';
export type {
  ClientEvents,
  ClientOptions,
  EvictionReason,
  KeepaliveClient,
  KeepaliveErrorCode,
  RunOptions,
  RunResult,
  RunStreamEvent,
  TokenUsage,
} from './api/types.js';

export function createClient(opts: ClientOptions = {}): KeepaliveClient {
  // Resolve runtimeDir to an absolute path here, at the single entry point.
  // All paths derived from it (settings.json `command`, hook script's
  // relative-path file checks, framing's writeFile calls) must be absolute
  // because claude resolves the Stop-hook `command` against the project /
  // git root, not against the driver's CWD. If we left runtimeDir relative,
  // the hook command path would resolve to a non-existent file whenever the
  // driver's CWD differs from the git root, the hook would never run, and
  // claude would exit cleanly without ever entering the keepalive loop.
  const runtimeDir = resolve(opts.runtimeDir ?? 'runtime');
  const claudeBinary = opts.claudeBinary ?? 'claude';
  const spawnTimeoutMs = opts.spawnTimeoutMs ?? 30_000;
  const responseTimeoutMs = opts.defaultTimeoutMs ?? 5 * 60_000;
  const pollIntervalMs = 100;

  const factory: SessionFactory = {
    async spawn(): Promise<Session> {
      const id = systemRandom.sessionId();
      const { proc, paths } = await spawnWarmProcess({
        sessionId: id,
        runtimeDir,
        claudeBinary,
        spawnTimeoutMs,
        launcher: systemProcessLauncher,
        clock: systemClock,
        sleeper: systemSleeper,
        framing: fileTransportFraming,
      });
      return new WarmSession({
        id,
        proc,
        paths,
        framing: fileTransportFraming,
        clock: systemClock,
        sleeper: systemSleeper,
        responseTimeoutMs,
        pollIntervalMs,
      });
    },
  };

  return buildClient(opts, {
    factory,
    clock: systemClock,
    sleeper: systemSleeper,
    random: systemRandom,
  });
}
