import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileTransportFraming } from '../../src/session/framing.js';
import { responseFilePath, type SessionPaths, sessionPaths } from '../../src/session/paths.js';
import { createTestClock, immediateSleeper } from '../helpers/test-clock.js';

describe('fileTransportFraming', () => {
  let dir: string;
  let paths: SessionPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kalive-framing-'));
    paths = sessionPaths(dir, 'sess-1');
    await mkdir(paths.responsesDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('enqueuePrompt writes .prompt + .in-request with response path embedded', async () => {
    await fileTransportFraming.enqueuePrompt(paths, 'hello', { requestId: 'req-1' });

    const promptContent = await readFile(paths.prompt, 'utf8');
    expect(promptContent).toContain('hello');
    expect(promptContent).toContain(responseFilePath(paths, 'req-1'));

    const flag = await readFile(paths.inRequest, 'utf8');
    expect(flag).toBe('');

    const rid = await readFile(paths.requestId, 'utf8');
    expect(rid).toBe('req-1');
  });

  it('awaitResponse yields token + done when response file appears', async () => {
    await fileTransportFraming.enqueuePrompt(paths, 'hi', { requestId: 'req-2' });
    const responsePath = responseFilePath(paths, 'req-2');
    await writeFile(responsePath, JSON.stringify({ text: 'world' }), 'utf8');

    const clock = createTestClock(0);
    const events = [];
    for await (const ev of fileTransportFraming.awaitResponse(
      paths,
      { requestId: 'req-2' },
      { responseTimeoutMs: 5_000, pollIntervalMs: 10 },
      { clock, sleeper: immediateSleeper },
    )) {
      events.push(ev);
    }

    expect(events.map((e) => e.type)).toEqual(['token', 'done']);
    const done = events[1];
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.result.text).toBe('world');
    expect(done.result.requestId).toBe('req-2');
  });

  it('awaitResponse times out when no response file appears', async () => {
    const clock = createTestClock(0);
    const events = [];
    let polls = 0;
    const sleeper = {
      sleep: async (ms: number) => {
        polls++;
        clock.advance(ms);
      },
    };

    for await (const ev of fileTransportFraming.awaitResponse(
      paths,
      { requestId: 'req-3' },
      { responseTimeoutMs: 50, pollIntervalMs: 10 },
      { clock, sleeper },
    )) {
      events.push(ev);
    }

    expect(events).toHaveLength(1);
    const err = events[0];
    if (err?.type !== 'error') throw new Error('expected error');
    expect(err.error.code).toBe('TIMEOUT');
    expect(polls).toBeGreaterThan(0);
  });

  it('awaitResponse yields CLAUDE_ERROR on malformed response JSON', async () => {
    const responsePath = responseFilePath(paths, 'req-4');
    await writeFile(responsePath, 'not json at all', 'utf8');

    const clock = createTestClock(0);
    const events = [];
    for await (const ev of fileTransportFraming.awaitResponse(
      paths,
      { requestId: 'req-4' },
      { responseTimeoutMs: 5_000, pollIntervalMs: 10 },
      { clock, sleeper: immediateSleeper },
    )) {
      events.push(ev);
    }

    expect(events).toHaveLength(1);
    const err = events[0];
    if (err?.type !== 'error') throw new Error('expected error');
    expect(err.error.code).toBe('CLAUDE_ERROR');
  });

  it('clearRequest removes all per-request artifacts', async () => {
    await fileTransportFraming.enqueuePrompt(paths, 'hi', { requestId: 'req-5' });
    const responsePath = responseFilePath(paths, 'req-5');
    await writeFile(responsePath, JSON.stringify({ text: 'x' }), 'utf8');

    await fileTransportFraming.clearRequest(paths, 'req-5');

    for (const p of [paths.inRequest, paths.prompt, paths.requestId, responsePath]) {
      await expect(readFile(p, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
