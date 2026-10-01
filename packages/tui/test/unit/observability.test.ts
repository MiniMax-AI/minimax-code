import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTuiObservability,
  resolveTuiObservabilityDirectory,
} from '../../src/observability/local-observability.js';

describe('Minimax Code observability', () => {
  it('persists typed local-only events and deduplicates stable access decisions', async () => {
    let nowMs = 1_000;
    const writes: Array<{ path: string; content: string }> = [];
    const observability = createTuiObservability('/data', {
      surface: 'tui',
      pid: 42,
      startedAtMs: 900,
      now: () => nowMs,
      append: vi.fn(async (path: string, content: string) => {
        writes.push({ path, content });
      }),
      ensureDirectory: vi.fn(async () => undefined),
      prune: vi.fn(async () => undefined),
    });

    observability.recordStartup({
      phase: 'tui.first-frame',
      outcome: 'succeeded',
      durationMs: 12,
    });
    observability.recordAccess({
      operation: 'session.list',
      source: 'process-local',
    });
    observability.recordAccess({
      operation: 'session.list',
      source: 'process-local',
    });
    nowMs += 10;
    observability.recordEventStream({
      state: 'retry-scheduled',
      attempt: 1,
      retryDelayMs: 250,
      errorKind: 'Error',
    });
    observability.recordProcessStop({
      source: 'terminal.write.sync',
      terminalDead: true,
      bytes: 64,
      error: {
        name: 'Error',
        message: 'write EOF',
        code: 'EOF',
        errno: -4095,
        syscall: 'write',
        stack: 'Error: write EOF\n    at ProcessTerminal.write ([workspace]/terminal.js:1:1)',
      },
      runtime: {
        nodeVersion: 'v22.19.0',
        uvVersion: '1.51.0',
        platform: 'win32',
        arch: 'x64',
        pid: 36500,
      },
      stdout: {
        constructorName: 'WriteStream',
        isTTY: true,
        writable: true,
        destroyed: false,
        writableEnded: false,
        writableFinished: false,
        writableNeedDrain: false,
      },
      stderr: {
        constructorName: 'WriteStream',
        isTTY: true,
        writable: true,
        destroyed: false,
        writableEnded: false,
        writableFinished: false,
        writableNeedDrain: false,
      },
    });
    await observability.flush();

    expect(resolveTuiObservabilityDirectory('/data')).toBe('/data/v2/observability/mcode');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('/data/v2/observability/mcode/mcode-observability-900-42.jsonl');
    const events = writes
      .flatMap((write) => write.content.trim().split('\n'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        observedAtMs: 1_000,
        surface: 'tui',
        type: 'startup',
        phase: 'tui.first-frame',
        outcome: 'succeeded',
        durationMs: 12,
      }),
      expect.objectContaining({
        type: 'runtime.access',
        operation: 'session.list',
        source: 'process-local',
      }),
      expect.objectContaining({
        type: 'event.stream',
        state: 'retry-scheduled',
        attempt: 1,
        retryDelayMs: 250,
        errorKind: 'Error',
      }),
      expect.objectContaining({
        type: 'process.stop',
        source: 'terminal.write.sync',
        terminalDead: true,
        bytes: 64,
        error: expect.objectContaining({
          code: 'EOF',
          errno: -4095,
          syscall: 'write',
        }),
        runtime: expect.objectContaining({
          platform: 'win32',
          pid: 36500,
        }),
      }),
    ]);
    expect(observability.snapshot()).toMatchObject({
      eventCounts: {
        startup: 1,
        runtimeAccess: 1,
        eventStream: 1,
        processStop: 1,
      },
      accessSources: {
        'session.list': 'process-local',
      },
      reconnects: 1,
    });
  });

  it('keeps bounded render latency aggregates and emits a final summary', async () => {
    const writes: string[] = [];
    const observability = createTuiObservability('/data', {
      surface: 'tui',
      pid: 7,
      startedAtMs: 1,
      now: () => 2,
      append: vi.fn(async (_path: string, content: string) => {
        writes.push(content);
      }),
      ensureDirectory: vi.fn(async () => undefined),
      prune: vi.fn(async () => undefined),
    });

    for (let frame = 1; frame <= 130; frame += 1) {
      observability.observeRender({
        durationMs: frame === 77 ? 25 : 2,
        width: 120,
        height: 40,
        changedLines: 1,
        fullRedraw: frame === 1,
      });
    }
    await observability.flush();

    const events = writes
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const samples = events.filter((event) => event.type === 'render.latency');
    expect(samples).toHaveLength(5);
    expect(samples.map((sample) => sample.frame)).toEqual([1, 2, 3, 77, 120]);
    expect(events.at(-1)).toMatchObject({
      type: 'render.summary',
      frames: 130,
      averageDurationMs: expect.any(Number),
      maxDurationMs: 25,
      p95DurationMs: 2,
    });
    expect(observability.snapshot().render).toMatchObject({
      frames: 130,
      maxDurationMs: 25,
      p95DurationMs: 2,
    });
  });

  it('flushes startup observations without waiting for process shutdown', async () => {
    vi.useFakeTimers();
    try {
      const append = vi.fn(async () => undefined);
      const observability = createTuiObservability('/data', {
        surface: 'headless',
        append,
        ensureDirectory: vi.fn(async () => undefined),
        prune: vi.fn(async () => undefined),
      });

      observability.recordStartup({
        phase: 'runtime.initialize',
        outcome: 'started',
      });
      expect(append).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(append).toHaveBeenCalledWith(
        expect.stringContaining('/v2/observability/mcode/'),
        expect.stringContaining('"phase":"runtime.initialize"'),
      );
      await observability.flush();
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes a per-process JSONL file through the real cross-platform filesystem path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcode-observability-'));
    try {
      const observability = createTuiObservability(dataDir, {
        surface: 'tui',
        pid: 99,
        startedAtMs: 123,
        now: () => 456,
      });
      observability.recordTerminal({
        terminalId: 'unknown',
        platform: process.platform,
        isTTY: true,
        transport: 'ssh',
        multiplexer: 'tmux',
        color: true,
        colorLevel: 3,
        columns: 120,
        rows: 40,
      });
      observability.recordTheme?.({
        appearance: 'light',
        source: 'osc11',
        detail: 'OSC 11 background rgb(255, 255, 255)',
        colorLevel: 3,
      });
      await observability.flush();

      const directory = resolveTuiObservabilityDirectory(dataDir);
      expect(await readdir(directory)).toEqual(['mcode-observability-123-99.jsonl']);
      const content = await readFile(join(directory, 'mcode-observability-123-99.jsonl'), 'utf8');
      const events = content
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events[0]).toMatchObject({
        schemaVersion: 1,
        observedAtMs: 456,
        surface: 'tui',
        type: 'terminal.capability',
        transport: 'ssh',
        multiplexer: 'tmux',
      });
      expect(events[1]).toMatchObject({
        type: 'terminal.theme',
        appearance: 'light',
        source: 'osc11',
        colorLevel: 3,
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('side conversation local diagnostics', () => {
  it('persists bounded, redacted causes and the failure stage', async () => {
    const writes: string[] = [];
    const observability = createTuiObservability('/data', {
      surface: 'tui',
      append: async (_path, text) => {
        writes.push(text);
      },
      ensureDirectory: async () => undefined,
      prune: async () => undefined,
    });
    const cause = Object.assign(
      new Error('token=secret-value History fork target prefix is not settled'),
      { code: 'boundary-invalid' },
    );
    const error = Object.assign(new Error('Fork failed', { cause }), { code: 'fork-failed' });
    observability.recordSideSessionFailure?.({ stage: 'create', parentSessionId: 'parent', error });
    await observability.flush();
    const text = writes.join('');
    expect(text).not.toContain('secret-value');
    const event = JSON.parse(text.trim());
    expect(event).toMatchObject({
      type: 'session.side.failed',
      stage: 'create',
      parentSessionId: 'parent',
      errors: [
        { code: 'fork-failed' },
        {
          code: 'boundary-invalid',
          message: expect.stringContaining('History fork target prefix is not settled'),
        },
      ],
    });
  });
});
