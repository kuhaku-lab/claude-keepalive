import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHookScript } from '../../src/session/hook.js';
import { type SessionPaths, sessionPaths } from '../../src/session/paths.js';

describe('stop-hook script (renderHookScript)', () => {
  let dir: string;
  let paths: SessionPaths;
  let scriptPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kalive-hook-'));
    paths = sessionPaths(dir, 'sess-1');
    await mkdir(paths.root, { recursive: true });
    scriptPath = paths.hookScript;
    await writeFile(scriptPath, renderHookScript(paths), 'utf8');
    await chmod(scriptPath, 0o755);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function runHook(): { stdout: string; status: number | null } {
    const r = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
    return { stdout: r.stdout, status: r.status };
  }

  it('idle branch: emits block + writes lastTick', async () => {
    const { stdout, status } = runHook();
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.decision).toBe('block');
    expect(typeof json.reason).toBe('string');
    expect(json.reason).toContain('TURN START');
    const tick = await readFile(paths.lastTick, 'utf8');
    expect(Number(tick)).toBeGreaterThan(0);
  });

  it('real-request branch: reads .prompt, sets .responded, emits prompt as reason', async () => {
    await writeFile(paths.prompt, 'Summarize the diff\nbe brief', 'utf8');
    await writeFile(paths.inRequest, '', 'utf8');

    const { stdout, status } = runHook();
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.decision).toBe('block');
    expect(json.reason).toBe('Summarize the diff\nbe brief');

    // hook should have set .responded so next fire is treated as response turn
    const responded = await readFile(paths.responded, 'utf8');
    expect(responded).toBe('');
  });

  it('response-turn branch: clears .responded, emits idle block', async () => {
    await writeFile(paths.responded, '', 'utf8');

    const { stdout, status } = runHook();
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.decision).toBe('block');
    expect(json.reason).toContain('TURN START');

    await expect(readFile(paths.responded, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
