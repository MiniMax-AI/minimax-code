import { describe, expect, it, vi } from 'vitest';
import { LocalBashToolDef } from '../../src/desktop/builtin-defs.js';
import { createLocalBashToolDefinition } from '../../src/desktop/local-bash-contract.js';
import { LocalBashTool } from '../../src/desktop/local-pi-tools.js';
import { resolveLocalBashTiming } from '../../src/desktop/local-bash-timing.js';
import {
  DEFAULT_BACKGROUND_BASH_MAX_RUN_MS,
  resolveBackgroundBashMaxRunMs,
} from '../../../local-runtime/src/background-task/bash-runner-limits.js';

const context = { sessionId: 'test-session', turnId: 'test-turn', canConsumeBackgroundBashOutput: true };

describe('managed Bash timeout admission', () => {
  it.each([
    [undefined, 3600], [7, 7], [3600, 3600], [7200, 3600],
    [3_000_000, 3600], [0, 3600], [-5, 3600], [NaN, 3600], [Infinity, 3600],
  ])('forwards the effective timeout for %s to the running command', async (timeout, effective) => {
    const runManagedForeground = vi.fn(async () => ({ status: 'completed' as const, taskId: 'task', text: 'ok' }));
    const tool = new LocalBashTool('/tmp/test-workspace', { startBackground: vi.fn(), runManagedForeground }, { mode: 'off' });
    const result = await tool.execute(context, { command: 'echo ok', timeout });
    expect(runManagedForeground).toHaveBeenCalledWith(
      context, { command: 'echo ok', description: 'echo ok', timeout: effective }, 60_000, undefined,
    );
    expect(result.details?.timing).toMatchObject({ commandTimeoutSeconds: effective });
  });

  it('preserves the task identity after automatic promotion', async () => {
    const startBackground = vi.fn();
    const tool = new LocalBashTool('/tmp/test-workspace', {
      startBackground,
      runManagedForeground: vi.fn(async () => ({ status: 'auto_promoted' as const, taskId: 'original-task' })),
    }, { mode: 'off' });
    const result = await tool.execute(context, { command: 'sleep 65' });
    expect(result.details).toMatchObject({ task_id: 'original-task', timing: { commandTimeoutSeconds: 3600 } });
    expect(startBackground).not.toHaveBeenCalled();
    expect(result.text).toContain('without restarting it');
  });

  it('keeps explicit background timeout input separate from the runtime watchdog', async () => {
    const startBackground = vi.fn(async () => ({ status: 'started' as const, taskId: 'explicit-task' }));
    const tool = new LocalBashTool('/tmp/test-workspace', { startBackground }, { mode: 'off' });
    await tool.execute(context, { command: 'echo ok', run_in_background: true });
    expect(startBackground.mock.calls[0]?.[1]).not.toHaveProperty('timeout');
    expect(DEFAULT_BACKGROUND_BASH_MAX_RUN_MS).toBe(3_600_000);
    expect(resolveBackgroundBashMaxRunMs(undefined)).toBe(3_600_000);
    expect(resolveBackgroundBashMaxRunMs(7)).toBe(3_600_000);
    expect(resolveBackgroundBashMaxRunMs(7200)).toBe(7_200_000);
    expect(resolveLocalBashTiming(7, 'explicit_background').commandTimeoutSeconds).toBe(7);
  });

  it('retains direct foreground limits and rejects invalid explicit background timeouts', () => {
    expect(resolveLocalBashTiming(undefined, 'direct_foreground').commandTimeoutSeconds).toBe(120);
    expect(resolveLocalBashTiming(7200, 'direct_foreground').commandTimeoutSeconds).toBe(300);
    for (const mode of ['direct_foreground', 'explicit_background'] as const) {
      for (const timeout of [0, -5, NaN, Infinity]) expect(() => resolveLocalBashTiming(timeout, mode)).toThrow();
    }
  });

  it('advertises the same limits to the model', () => {
    expect(LocalBashToolDef.schema.properties.timeout.description).toContain('3600s');
    expect(createLocalBashToolDefinition({ background: true, shell: 'bash' }).schema.properties.timeout.description).toContain('1-hour');
  });
});
