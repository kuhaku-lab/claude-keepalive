// Example: dropping claude-keepalive into a Multica-style task runtime.
// This is the shim layer that replaces `spawn('claude', ['-p', ...])`.

import { createClient, type KeepaliveClient, type RunStreamEvent } from 'claude-keepalive';

export interface TaskInput {
  taskId: string;
  prompt: string;
  cwd: string;
  allowedTools: string[];
  abortSignal: AbortSignal;
  onEvent?: (ev: RunStreamEvent) => void;
}

export interface TaskOutput {
  text: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export class ClaudeRuntime {
  private client: KeepaliveClient;

  constructor(opts: { poolSize: number }) {
    this.client = createClient({
      poolSize: opts.poolSize,
      defaultTimeoutMs: 5 * 60_000,
    });

    this.client.on('session.spawned', ({ sessionId }) => {
      console.log(JSON.stringify({ event: 'claude.session.spawned', sessionId }));
    });
    this.client.on('session.evicted', ({ sessionId, reason }) => {
      console.log(JSON.stringify({ event: 'claude.session.evicted', sessionId, reason }));
    });
  }

  async run(input: TaskInput): Promise<TaskOutput> {
    if (input.onEvent) {
      let result: TaskOutput | undefined;
      for await (const ev of this.client.runStream(input.prompt, {
        cwd: input.cwd,
        allowedTools: input.allowedTools,
        signal: input.abortSignal,
        requestId: input.taskId,
      })) {
        input.onEvent(ev);
        if (ev.type === 'done') {
          result = {
            text: ev.result.text,
            durationMs: ev.result.durationMs,
            inputTokens: ev.result.usage.inputTokens,
            outputTokens: ev.result.usage.outputTokens,
          };
        }
        if (ev.type === 'error') {
          throw Object.assign(new Error(ev.error.message), { code: ev.error.code });
        }
      }
      if (!result) throw new Error('claude-keepalive stream ended without a done event');
      return result;
    }

    const r = await this.client.run(input.prompt, {
      cwd: input.cwd,
      allowedTools: input.allowedTools,
      signal: input.abortSignal,
      requestId: input.taskId,
    });
    return {
      text: r.text,
      durationMs: r.durationMs,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
