import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RunStreamEvent } from '../api/types.js';
import type { Clock, Sleeper } from '../core/clock.js';
import type { SessionRunOptions } from './index.js';
import { responseFilePath, type SessionPaths } from './paths.js';

export interface Framing {
  /**
   * `--append-system-prompt` text the driver hands to `claude` at spawn.
   * Teaches the agent the response-write contract.
   */
  systemPrompt(paths: SessionPaths): string;

  /**
   * Enqueue a real prompt by writing `.prompt` + `.in-request`. The next
   * stop-hook fire will inject it as the agent's next user message.
   */
  enqueuePrompt(paths: SessionPaths, prompt: string, opts: SessionRunOptions): Promise<void>;

  /**
   * Poll until the per-request response file appears (and is fully written),
   * then yield it as public events. Times out per `responseTimeoutMs`.
   */
  awaitResponse(
    paths: SessionPaths,
    opts: SessionRunOptions,
    timing: { responseTimeoutMs: number; pollIntervalMs: number },
    deps: { clock: Clock; sleeper: Sleeper },
  ): AsyncIterable<RunStreamEvent>;

  /** Clear the per-request flag files. Called after success or failure. */
  clearRequest(paths: SessionPaths, requestId: string): Promise<void>;
}

/**
 * Wraps the prompt with a per-request instruction that pins the response
 * file path. The agent has been told via system-prompt that this format
 * is mandatory; this line is just the per-turn restatement of where to
 * write.
 */
function decoratePrompt(prompt: string, responsePath: string): string {
  return `${prompt}

[claude-keepalive] When you have finished this response, atomically write the JSON line
{"text": <your complete reply as a string>}
to the file at ${responsePath}. Write nothing else to that file. Do this as the last
action of your turn.`;
}

interface ResponseFilePayload {
  text: string;
}

function parseResponse(raw: string): ResponseFilePayload {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('response file empty');
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('response not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.text !== 'string') throw new Error('response.text not a string');
  return { text: obj.text };
}

export const fileTransportFraming: Framing = {
  systemPrompt(_paths) {
    return [
      '[claude-keepalive runtime contract]',
      'You are running inside an interactive `claude` session whose stop hook',
      'feeds you prompts one at a time. Each prompt is an INDEPENDENT TASK from',
      'an unrelated caller — they happen to share this process for performance,',
      'but they have nothing to do with each other.',
      '',
      'For every prompt:',
      '',
      '  • Treat it as a fresh request from a stranger. Do NOT use any information,',
      '    context, names, numbers, files, or facts from previous turns to inform',
      '    your answer. If a previous turn mentioned "the number 17" and the',
      '    current turn asks an unrelated question, you must not reference 17.',
      '  • Do NOT acknowledge or refer to previous turns ("as I said before",',
      '    "the file you mentioned", etc.). Behave as if this were the first turn.',
      '  • Generate your response normally.',
      '  • As the very last action of the turn, write the JSON line',
      '      {"text": "<your complete reply>"}',
      '    to the path the prompt names. Write that path exactly once.',
      '  • Do not add any other content to that file.',
      '',
      'Empty turns (with content "--- TURN START ---") are idle keepalive ticks.',
      'Respond to them with a single period and do not write a response file.',
    ].join('\n');
  },

  async enqueuePrompt(paths, prompt, opts) {
    await mkdir(paths.responsesDir, { recursive: true });
    const responsePath = responseFilePath(paths, opts.requestId);
    // Ensure no stale file from a prior request id collision.
    await rm(responsePath, { force: true });
    await writeFile(paths.prompt, decoratePrompt(prompt, responsePath), 'utf8');
    await writeFile(paths.requestId, opts.requestId, 'utf8');
    // `.in-request` last: presence is the trigger the hook reads.
    await writeFile(paths.inRequest, '', 'utf8');
  },

  async *awaitResponse(paths, opts, timing, deps) {
    const responsePath = responseFilePath(paths, opts.requestId);
    const deadline = deps.clock.now() + timing.responseTimeoutMs;

    while (deps.clock.now() < deadline) {
      if (opts.signal?.aborted) {
        yield { type: 'error', error: { code: 'ABORTED', message: 'request aborted' } };
        return;
      }
      try {
        const raw = await readFile(responsePath, 'utf8');
        const payload = parseResponse(raw);
        yield { type: 'token', text: payload.text };
        yield {
          type: 'done',
          result: {
            requestId: opts.requestId,
            text: payload.text,
            usage: { inputTokens: 0, outputTokens: 0 },
            durationMs: 0,
            sessionId: '',
          },
        };
        return;
      } catch (err) {
        if (isMissing(err)) {
          await deps.sleeper.sleep(timing.pollIntervalMs, opts.signal);
          continue;
        }
        if (
          err instanceof SyntaxError ||
          (err instanceof Error && err.message.startsWith('response'))
        ) {
          // File exists but is malformed — likely mid-write or agent ignored
          // the contract. Treat as fatal so the session is evicted dirty.
          yield {
            type: 'error',
            error: {
              code: 'CLAUDE_ERROR',
              message: `malformed response file: ${err instanceof Error ? err.message : String(err)}`,
            },
          };
          return;
        }
        yield {
          type: 'error',
          error: {
            code: 'SESSION_CRASHED',
            message: err instanceof Error ? err.message : String(err),
          },
        };
        return;
      }
    }
    yield {
      type: 'error',
      error: { code: 'TIMEOUT', message: `no response file within ${timing.responseTimeoutMs}ms` },
    };
  },

  async clearRequest(paths, requestId) {
    const responsePath = responseFilePath(paths, requestId);
    await Promise.all([
      rm(paths.inRequest, { force: true }),
      rm(paths.prompt, { force: true }),
      rm(paths.requestId, { force: true }),
      rm(responsePath, { force: true }),
    ]);
    // Best-effort: ensure the responses dir exists for next time.
    await mkdir(dirname(responsePath), { recursive: true });
  },
};

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
