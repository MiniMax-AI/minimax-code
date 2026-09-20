import { describe, expect, it, vi } from 'vitest';

import type {
  TuiCustomStatusLineConfig,
  TuiCustomStatusProcessInvocation,
  TuiCustomStatusProcessResult,
} from '../../src/host/custom-status-command.js';
import type { TuiWorkspaceGitMetadata } from '../../src/runtime/port.js';
import {
  TuiWorkspaceStatusLine,
  createTuiWorkspaceStatusLine,
} from '../../src/tui/shell/workspace-status-line.js';

describe('TuiWorkspaceStatusLine', () => {
  it('starts and stops Git refreshes with the selected dependencies, including late results', async () => {
    vi.useFakeTimers();
    const resolvers: Array<(metadata: TuiWorkspaceGitMetadata) => void> = [];
    const runtime = { getWorkspaceGitMetadata: vi.fn(() => new Promise<TuiWorkspaceGitMetadata>((resolve) => { resolvers.push(resolve); })) };
    const state = { version: '0.1', workspace: '/repo', runtimeStatus: 'ready' as const };
    const status = new TuiWorkspaceStatusLine({ ...state, statusLineItems: ['model'] }, runtime, vi.fn());
    try {
      status.preview(['git-branch'], 80, 3);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(runtime.getWorkspaceGitMetadata).not.toHaveBeenCalled();
      status.setConfiguredItems(['git-branch']);
      expect(runtime.getWorkspaceGitMetadata).toHaveBeenCalledTimes(1);
      status.setConfiguredItems([]);
      resolvers[0]?.({ isGitRepo: true, branch: 'stale', detached: false, isWorktree: false });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(runtime.getWorkspaceGitMetadata).toHaveBeenCalledTimes(1);
      expect(status.render(80)).toEqual([]);
      status.setState({ ...state, workspace: '/other', busy: true });
      status.setState({ ...state, workspace: '/other', busy: false });
      expect(runtime.getWorkspaceGitMetadata).toHaveBeenCalledTimes(1);
      status.setConfiguredItems(['review-link']);
      expect(runtime.getWorkspaceGitMetadata).toHaveBeenLastCalledWith('/other');
      expect(status.preview(['git-branch'], 80, 3).lines.join('')).not.toContain('stale');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(runtime.getWorkspaceGitMetadata).toHaveBeenCalledTimes(3);
      status.dispose();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(runtime.getWorkspaceGitMetadata).toHaveBeenCalledTimes(3);
    } finally { status.dispose(); vi.useRealTimers(); }
  });

  it('applies an empty selection across projections and restores adaptive default context behavior', () => {
    const runtime = { getWorkspaceGitMetadata: vi.fn(async () => ({ isGitRepo: false, branch: '', detached: false, isWorktree: false })) };
    const state = { version: '0.1', workspace: '/repo', runtimeStatus: 'ready' as const, contextUsage: { usedTokens: 20, contextWindowTokens: 100 } };
    const status = new TuiWorkspaceStatusLine(state, runtime, vi.fn());
    try {
      status.setConfiguredItems([]);
      status.setState(state);
      expect(status.render(80)).toEqual([]);
      status.setConfiguredItems(['context-remaining']);
      const explicit = status.render(80).join('');
      expect(explicit).toContain('80%');
      status.setConfiguredItems(undefined);
      status.setState(state);
      expect(status.getConfiguredItems()).toBeUndefined();
      const restored = status.render(80).join('');
      expect(restored).toContain('80%');
      expect(restored).not.toContain('Context 100');
      expect(restored).toContain('/repo');
    } finally { status.dispose(); }
  });

  it('rejects changing machine mode in either direction', () => {
    const runtime = { getWorkspaceGitMetadata: vi.fn(async () => ({ isGitRepo: false, branch: '', detached: false, isWorktree: false })) };
    for (const items of [[], ['build-mode']] as const) {
      const status = new TuiWorkspaceStatusLine({ version: '0.1', workspace: '/repo', runtimeStatus: 'ready', statusLineItems: items }, runtime, vi.fn());
      try {
        expect(() => status.setConfiguredItems(items.length ? [] : ['build-mode'])).toThrow('startup-only');
        expect(status.getConfiguredItems()).toEqual(items);
      } finally { status.dispose(); }
    }
    expect(runtime.getWorkspaceGitMetadata).not.toHaveBeenCalled();
  });

  it('clears stale Git metadata and refreshes immediately when the Session workspace changes', async () => {
    const resolvers: Array<(metadata: TuiWorkspaceGitMetadata) => void> = [];
    const runtime = {
      getWorkspaceGitMetadata: vi.fn(
        async () =>
          await new Promise<TuiWorkspaceGitMetadata>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    };
    const initialState = {
      version: '0.1.0',
      workspace: '/repo-a',
      runtimeStatus: 'ready' as const,
    };
    const status = new TuiWorkspaceStatusLine(initialState, runtime, vi.fn());

    try {
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));
      resolvers[0]?.({
        isGitRepo: true,
        branch: 'repo-a-branch',
        detached: false,
        isWorktree: false,
      });
      await vi.waitFor(() => expect(status.render(120).join('\n')).toContain('repo-a-branch'));

      status.setState({ ...initialState, workspace: '/repo-b' });

      expect(status.render(120).join('\n')).not.toContain('repo-a-branch');
      await vi.waitFor(() => expect(resolvers).toHaveLength(2));
      expect(runtime.getWorkspaceGitMetadata).toHaveBeenLastCalledWith('/repo-b');
    } finally {
      status.dispose();
    }
  });

  it('does not let an older Git refresh replace newer branch metadata', async () => {
    const resolvers: Array<(metadata: TuiWorkspaceGitMetadata) => void> = [];
    const runtime = {
      getWorkspaceGitMetadata: vi.fn(
        async () =>
          await new Promise<TuiWorkspaceGitMetadata>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    };
    const initialState = {
      version: '0.1.0',
      workspace: '/workspace',
      runtimeStatus: 'ready' as const,
      busy: true,
    };
    const requestRender = vi.fn();
    const status = new TuiWorkspaceStatusLine(initialState, runtime, requestRender);

    try {
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));
      status.setState({ ...initialState, busy: false });
      await vi.waitFor(() => expect(resolvers).toHaveLength(2));

      resolvers[1]?.({
        isGitRepo: true,
        branch: 'new-branch',
        detached: false,
        isWorktree: false,
      });
      await vi.waitFor(() => expect(status.render(120).join('\n')).toContain('new-branch'));

      resolvers[0]?.({
        isGitRepo: true,
        branch: 'old-branch',
        detached: false,
        isWorktree: false,
      });
      await vi.waitFor(() => expect(requestRender).toHaveBeenCalledTimes(1));

      expect(status.render(120).join('\n')).toContain('new-branch');
      expect(status.render(120).join('\n')).not.toContain('old-branch');
    } finally {
      status.dispose();
    }
  });

  it('preserves the configured status line items across Runtime shell projections', async () => {
    const runtime = {
      getWorkspaceGitMetadata: vi.fn(async () => ({
        isGitRepo: true,
        branch: 'feat/pinned',
        detached: false,
        isWorktree: false,
      })),
    };
    const status = createTuiWorkspaceStatusLine(
      {
        runtime,
        workspaceDir: '/workspace',
        version: '0.1.0',
        // `workspace` is a legacy alias for `current-dir`; `nope` must be ignored.
        statusLineItems: ['workspace', 'nope'],
      },
      vi.fn(),
    );

    try {
      // The per-frame projection carries no item order, so the configured list
      // must survive a plain shell state update.
      status.setState({
        version: '0.1.0',
        workspace: '/workspace',
        runtimeStatus: 'ready',
        model: 'minimax/m2',
      });

      const line = status.render(120).join('\n');
      expect(line).toContain('/workspace');
      // Only the configured item renders: the model was not configured.
      expect(line).not.toContain('m2');
    } finally {
      status.dispose();
    }
  });

  it('preserves the configured status protocol across Runtime shell projections', () => {
    const runtime = {
      getWorkspaceGitMetadata: vi.fn(async () => ({
        isGitRepo: false,
        branch: '',
        detached: false,
        isWorktree: false,
      })),
    };
    const status = createTuiWorkspaceStatusLine(
      {
        runtime,
        workspaceDir: '/workspace',
        version: '0.1.0',
        statusLineItems: ['build-mode', 'current-dir'],
      },
      vi.fn(),
    );

    try {
      status.setState({
        version: '0.1.0',
        workspace: '/workspace',
        runtimeStatus: 'ready',
        agentStatus: 'run',
        agentRunId: 'turn_550e8400-e29b-41d4-a716-446655440000',
      });

      expect(status.render(80).join('\n').trim()).toMatch(
        /^\[V\] seq=0 state=run session=none turn=[a-z0-9]{6} request=none agents=0\/0$/u,
      );
    } finally {
      status.dispose();
    }
  });
});

describe('TuiWorkspaceStatusLine custom status command', () => {
  const quietGitRuntime = () => ({
    getWorkspaceGitMetadata: vi.fn(async () => ({
      isGitRepo: false,
      branch: '',
      detached: false,
      isWorktree: false,
    })),
  });

  function createCustomStatus(overrides?: {
    statusLineItems?: readonly string[];
    customStatusLine?: TuiCustomStatusLineConfig;
    runProcess?: (
      invocation: TuiCustomStatusProcessInvocation,
    ) => Promise<TuiCustomStatusProcessResult>;
  }) {
    const runProcess = vi.fn(
      overrides?.runProcess ??
        (async () => ({ exitCode: 0, stdout: 'Cost $1.23\nignored', timedOut: false })),
    );
    const status = createTuiWorkspaceStatusLine(
      {
        runtime: quietGitRuntime(),
        workspaceDir: '/workspace',
        version: '0.1.0',
        statusLineItems: overrides?.statusLineItems ?? ['custom-command'],
        customStatusLine: { command: 'cost-probe --fast', ...overrides?.customStatusLine },
        runCustomStatusProcess: runProcess,
      },
      vi.fn(),
    );
    return { status, runProcess };
  }

  it('runs the command at startup and renders its first stdout line', async () => {
    const { status, runProcess } = createCustomStatus();

    try {
      await vi.waitFor(() => expect(status.render(120).join('\n')).toContain('Cost $1.23'));
      expect(status.render(120).join('\n')).not.toContain('ignored');
      expect(runProcess).toHaveBeenCalledTimes(1);
      const invocation = runProcess.mock.calls[0]?.[0] as TuiCustomStatusProcessInvocation;
      expect(invocation.executable).toBe('cost-probe');
      expect(invocation.args).toEqual(['--fast']);
      expect(JSON.parse(invocation.stdin)).toMatchObject({
        protocol: 1,
        event: 'startup',
        workspace_dir: '/workspace',
        tui_version: '0.1.0',
      });
    } finally {
      status.dispose();
    }
  });

  it('never starts a command for preview and discards results after disabling and re-enabling it', async () => {
    const resolvers: Array<(result: TuiCustomStatusProcessResult) => void> = [];
    const { status, runProcess } = createCustomStatus({
      statusLineItems: ['model'],
      runProcess: () => new Promise((resolve) => { resolvers.push(resolve); }),
    });
    try {
      const preview = status.preview(['custom-command'], 80, 3);
      expect(preview.unavailable).toContain('custom-command');
      expect(runProcess).not.toHaveBeenCalled();
      status.setConfiguredItems(['custom-command']);
      expect(runProcess).toHaveBeenCalledTimes(1);
      status.setConfiguredItems(['model']);
      status.setConfiguredItems(['custom-command']);
      status.setConfiguredItems(['model']);
      status.setConfiguredItems(['custom-command']);
      expect(runProcess).toHaveBeenCalledTimes(1);
      resolvers[0]?.({ exitCode: 0, timedOut: false, stdout: 'stale-command-result' });
      await vi.waitFor(() => expect(runProcess).toHaveBeenCalledTimes(2));
      expect(status.render(80).join('')).not.toContain('stale-command-result');
      resolvers[1]?.({ exitCode: 0, timedOut: false, stdout: 'new-command-result' });
      await vi.waitFor(() => expect(status.render(80).join('')).toContain('new-command-result'));
      expect(status.render(80).join('')).toContain('new-command-result');
    } finally { status.dispose(); }
  });

  it('retains block settings across shell projections and clears on successful empty output', async () => {
    const runProcess = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'Context ready\nCI passed\nThird',
        timedOut: false,
      })
      .mockResolvedValueOnce({ exitCode: 1, stdout: 'broken', timedOut: false })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', timedOut: false });
    const { status } = createCustomStatus({
      statusLineItems: ['current-dir', 'custom-command'],
      customStatusLine: { display: 'block', maxLines: 2 },
      runProcess,
    });
    const state = { version: '0.1.0', workspace: '/workspace', runtimeStatus: 'ready' as const };
    try {
      await vi.waitFor(() => expect(status.render(120)).toHaveLength(4));
      status.setState({ ...state, busy: true });
      expect(status.render(120).join('\n')).toContain('CI passed');
      expect(status.render(120).join('\n')).not.toContain('Third');
      status.setState({ ...state, busy: false });
      await vi.waitFor(() => expect(runProcess).toHaveBeenCalledTimes(2));
      expect(status.render(120).join('\n')).toContain('CI passed');
      status.setState({ ...state, busy: true });
      status.setState({ ...state, busy: false });
      await vi.waitFor(() => expect(status.render(120)).toHaveLength(2));
      expect(status.render(120).join('\n')).toContain('/workspace');
    } finally {
      status.dispose();
    }
  });

  it.each(['session', 'workspace', 'cleared-session'] as const)(
    'discards pending block output after a %s change',
    async (change) => {
      const resolvers: Array<(result: TuiCustomStatusProcessResult) => void> = [];
      const { status, runProcess } = createCustomStatus({
        customStatusLine: { display: 'block' },
        runProcess: () => new Promise((resolve) => resolvers.push(resolve)),
      });
      const state = {
        version: '0.1.0',
        workspace: '/workspace',
        runtimeStatus: 'ready' as const,
        agentSessionId: 'session-a',
      };
      try {
        status.setState(state);
        resolvers[0]?.({ exitCode: 0, stdout: 'startup\nignored', timedOut: false });
        await vi.waitFor(() => expect(runProcess).toHaveBeenCalledTimes(2));
        status.setState({
          ...state,
          workspace: change === 'workspace' ? '/another-workspace' : state.workspace,
          agentSessionId: change === 'cleared-session' ? undefined : 'session-b',
        });
        // Returning to the old identity must not resurrect its in-flight result.
        if (change === 'session') status.setState(state);
        resolvers[1]?.({ exitCode: 0, stdout: 'stale first\nstale second', timedOut: false });
        await vi.waitFor(() => expect(runProcess).toHaveBeenCalledTimes(3));
        expect(status.render(120)).toEqual([]);
        resolvers[2]?.({ exitCode: 0, stdout: 'fresh first\nfresh second', timedOut: false });
        await vi.waitFor(() => expect(status.render(120).join('\n')).toContain('fresh second'));
      } finally {
        status.dispose();
      }
    },
  );

  it('refreshes on turn end and keeps the last text when the rerun fails', async () => {
    const results: TuiCustomStatusProcessResult[] = [
      { exitCode: 0, stdout: 'v1', timedOut: false },
      { exitCode: 1, stdout: 'broken', timedOut: false },
    ];
    const { status, runProcess } = createCustomStatus({
      runProcess: async () => results.shift() ?? { exitCode: 1, stdout: '', timedOut: false },
    });
    const baseState = {
      version: '0.1.0',
      workspace: '/workspace',
      runtimeStatus: 'ready' as const,
    };

    try {
      await vi.waitFor(() => expect(status.render(120).join('\n')).toContain('v1'));

      status.setState({ ...baseState, busy: true });
      expect(runProcess).toHaveBeenCalledTimes(1);
      status.setState({ ...baseState, busy: false });
      await vi.waitFor(() => expect(runProcess).toHaveBeenCalledTimes(2));
      const invocation = runProcess.mock.calls[1]?.[0] as TuiCustomStatusProcessInvocation;
      expect(JSON.parse(invocation.stdin)).toMatchObject({ event: 'turn-end' });

      // The failed rerun must not clear the previously rendered value.
      expect(status.render(120).join('\n')).toContain('v1');
    } finally {
      status.dispose();
    }
  });

  it('clears the cached text and reruns when the Session changes', async () => {
    const results: TuiCustomStatusProcessResult[] = [
      { exitCode: 0, stdout: 'old-session-cost', timedOut: false },
      { exitCode: 0, stdout: 'new-session-cost', timedOut: false },
    ];
    const { status, runProcess } = createCustomStatus({
      runProcess: async () => results.shift() ?? { exitCode: 1, stdout: '', timedOut: false },
    });

    try {
      await vi.waitFor(() => expect(status.render(120).join('\n')).toContain('old-session-cost'));

      status.setState({
        version: '0.1.0',
        workspace: '/workspace',
        runtimeStatus: 'ready',
        agentSessionId: 'session-2',
      });

      // Stale output disappears immediately: a wrong figure is worse than none.
      expect(status.render(120).join('\n')).not.toContain('old-session-cost');
      await vi.waitFor(() => expect(status.render(120).join('\n')).toContain('new-session-cost'));
      const invocation = runProcess.mock.calls[1]?.[0] as TuiCustomStatusProcessInvocation;
      expect(JSON.parse(invocation.stdin)).toMatchObject({
        event: 'session-change',
        session_id: 'session-2',
      });
    } finally {
      status.dispose();
    }
  });

  it.each(['inline', 'block'] as const)(
    'never spawns in build-mode with display %s',
    async (display) => {
      const { status, runProcess } = createCustomStatus({
        statusLineItems: ['build-mode', 'custom-command'],
        customStatusLine: { display, maxLines: 5, intervalSeconds: 10 },
      });

      try {
        status.setState({
          version: '0.1.0',
          workspace: '/workspace',
          runtimeStatus: 'ready',
          busy: true,
        });
        status.setState({
          version: '0.1.0',
          workspace: '/workspace',
          runtimeStatus: 'ready',
          busy: false,
        });
        await new Promise((resolve) => setImmediate(resolve));

        expect(runProcess).not.toHaveBeenCalled();
        expect(status.render(120).join('\n')).toContain('[V]');
      } finally {
        status.dispose();
      }
    },
  );

  it('never spawns when custom-command is not in the configured items', async () => {
    const { status, runProcess } = createCustomStatus({ statusLineItems: ['current-dir'] });

    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(runProcess).not.toHaveBeenCalled();
    } finally {
      status.dispose();
    }
  });

  it('stops triggering after dispose', async () => {
    const { status, runProcess } = createCustomStatus();
    await vi.waitFor(() => expect(runProcess).toHaveBeenCalledTimes(1));

    status.dispose();
    status.setState({
      version: '0.1.0',
      workspace: '/workspace',
      runtimeStatus: 'ready',
      agentSessionId: 'session-after-dispose',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(runProcess).toHaveBeenCalledTimes(1);
  });
});


describe('context meter projection', () => {
  it('previews and refreshes current usage without retaining cleared data', () => {
    const runtime = { getWorkspaceGitMetadata: vi.fn() };
    const state = {
      version: '0.1', workspace: '/repo', runtimeStatus: 'ready' as const,
      statusLineItems: ['context-meter', 'context-remaining'] as const,
      contextWindowTokens: 100,
    };
    const status = new TuiWorkspaceStatusLine(state, runtime, vi.fn());
    try {
      expect(status.preview(['context-meter'], 80, 3).unavailable).toEqual(['context-meter']);
      expect(status.render(80)).toEqual([]);
      status.setState({ ...state, contextUsage: { usedTokens: 20 } });
      const preview = status.preview(['context-meter', 'context-remaining'], 80, 3);
      expect(preview.unavailable).toEqual([]);
      expect(preview.lines.join('')).toContain('▕██████░░▏ 80% left');
      expect(status.render(80).join('').match(/80%/gu)).toHaveLength(1);
      status.setState({ ...state, contextUsage: { usedTokens: 90 } });
      expect(status.render(80).join('')).toContain('▕█░░░░░░░▏ 10% left');
      status.setState(state);
      expect(status.render(80)).toEqual([]);
      expect(runtime.getWorkspaceGitMetadata).not.toHaveBeenCalled();
    } finally {
      status.dispose();
    }
  });
});
