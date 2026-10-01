import { describe, expect, it, vi } from 'vitest';

import { TuiSessionFlow } from '../../../../src/tui/controller/session-flow.js';
import type { TuiSession } from '../../../../src/runtime/port.js';
import {
  BTW_REJECT_NESTED,
  BTW_REJECT_NO_BOUNDARY,
  BTW_SIDE_SESSION_PURPOSE,
} from '../../../../src/tui/commands/side-session.js';

const PARENT_ID = 'sess-parent';
const SIDE_ID = 'sess-side';

function createFlow(options: {
  current: Partial<TuiSession> & { sessionId: string };
  canFork?: boolean;
  omitForkProbe?: boolean;
  createSession?: ReturnType<typeof vi.fn>;
  deleteSession?: ReturnType<typeof vi.fn>;
  abortForegroundRun?: ReturnType<typeof vi.fn>;
  loadSessionProjection?: ReturnType<typeof vi.fn>;
  activeRunState?: 'running' | 'decision-blocked' | 'terminal' | 'idle';
  hasLiveRun?: boolean;
}) {
  const records: Record<string, TuiSession> = {
    [PARENT_ID]: { sessionId: PARENT_ID } as TuiSession,
    [SIDE_ID]: { sessionId: SIDE_ID, parentSessionId: PARENT_ID } as TuiSession,
    // The session under test wins over the defaults above.
    [options.current.sessionId]: options.current as TuiSession,
  };
  let activeSessionId = options.current.sessionId;

  const createSession =
    options.createSession ??
    vi.fn(async () => ({ sessionId: SIDE_ID, parentSessionId: PARENT_ID }) as TuiSession);
  const deleteSession = options.deleteSession ?? vi.fn(async () => undefined);
  const getSessionForkOptions = vi.fn(async () => ({ canFork: options.canFork !== false }));
  const loadSessionProjection =
    options.loadSessionProjection ??
    vi.fn(async (sessionId: string) => {
      activeSessionId = sessionId;
    });
  const append = vi.fn();
  const recordSideSessionFailure = vi.fn();
  const abortForegroundRun = options.abortForegroundRun ?? vi.fn(async () => true);
  const abortSessionRun = vi.fn(async () => true);
  const onSideSessionOpened = vi.fn();
  const onSideSessionClosed = vi.fn();
  const onSideConversationChanged = vi.fn();

  const runtime = {
    listSessionPage: vi.fn(async () => ({ sessions: [], hasMore: false })),
    getSession: vi.fn(async (sessionId: string) => records[sessionId]),
    createSession,
    deleteSession,
    getActiveRun: vi.fn(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      state: options.activeRunState ?? ('terminal' as const),
      actions: { steer: false },
    })),
    ...(options.omitForkProbe ? {} : { getSessionForkOptions }),
  };

  const flow = new TuiSessionFlow({
    observability: { recordSideSessionFailure },
    runtime: runtime as never,
    controller: {
      snapshot: vi.fn(() => ({
        session: records[activeSessionId] ?? { sessionId: activeSessionId },
        sessions: [],
      })),
      loadSessionProjection,
      whenIdle: vi.fn(async () => undefined),
      refreshSessionList: vi.fn(async () => undefined),
    } as never,
    stateStore: { dispatch: vi.fn() } as never,
    composerDraft: { discard: vi.fn(async () => undefined) } as never,
    interactionFlow: { deactivate: vi.fn(), recover: vi.fn(async () => undefined) } as never,
    featureFlow: {
      resetSessionState: vi.fn(),
      refreshSelectedModel: vi.fn(async () => undefined),
    } as never,
    queueFlow: { reset: vi.fn(), refresh: vi.fn(async () => []) } as never,
    delegationFlow: { reset: vi.fn(), refresh: vi.fn(async () => undefined) } as never,
    activeRunFlow: { refresh: vi.fn(async () => undefined) },
    runProjection: { markRecoveredTurn: vi.fn() } as never,
    append,
    onChanged: vi.fn(),
    requestWelcomeRebuild: vi.fn(),
    hasLiveRun: () => options.hasLiveRun === true,
    abortForegroundRun,
    currentRunId: () => (options.hasLiveRun ? 'turn-side' : undefined),
    abortSessionRun,
    onSideSessionOpened,
    onSideSessionClosed,
    onSideConversationChanged,
  });

  return {
    recordSideSessionFailure,
    flow,
    append,
    createSession,
    deleteSession,
    loadSessionProjection,
    abortForegroundRun,
    abortSessionRun,
    onSideSessionOpened,
    onSideSessionClosed,
    onSideConversationChanged,
  };
}

describe('parent navigation during a live Turn', () => {
  it('still rejects an ordinary child Session while its Turn is live', async () => {
    const { flow, append, loadSessionProjection } = createFlow({
      current: { sessionId: 'sess-child', parentSessionId: PARENT_ID },
      hasLiveRun: true,
    });

    await flow.activateParentSession();

    expect(loadSessionProjection).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith('Stop the running turn before using /parent.', 'warning');
  });
});

describe('startSideSession', () => {
  it('creates a hidden Runtime fork child and presents it as the side view', async () => {
    const { flow, createSession, loadSessionProjection, onSideSessionOpened } = createFlow({
      current: { sessionId: PARENT_ID, workspaceDir: '/repo' },
    });

    const side = await flow.startSideSession({ workspaceDir: '/fallback' });

    expect(side?.sessionId).toBe(SIDE_ID);
    expect(createSession).toHaveBeenCalledWith({
      workspaceDir: '/repo',
      parentSessionId: PARENT_ID,
      visibility: 'hidden',
      purpose: BTW_SIDE_SESSION_PURPOSE,
      title: expect.any(String),
    });
    expect(loadSessionProjection).toHaveBeenCalledWith(SIDE_ID);
    expect(onSideSessionOpened).toHaveBeenCalledWith({
      parentSessionId: PARENT_ID,
      sideSessionId: SIDE_ID,
    });
    expect(flow.isSideModeActive()).toBe(true);
    expect(flow.sideConversationSnapshot()).toEqual({
      parentSessionId: PARENT_ID,
      sideSessionId: SIDE_ID,
      activeView: 'side',
    });
  });

  it('replaces an existing side conversation instead of resuming it from the parent view', async () => {
    const { flow, createSession, deleteSession, abortSessionRun, onSideSessionClosed } = createFlow(
      {
        current: { sessionId: PARENT_ID, workspaceDir: '/repo' },
      },
    );

    await flow.startSideSession({ workspaceDir: '/repo' });
    await flow.toggleSideConversation();
    expect(flow.isSideModeActive()).toBe(false);

    await flow.startSideSession({ workspaceDir: '/repo' });

    // Codex semantics: the stale side conversation is discarded (interrupt +
    // delete) and a fresh fork starts from the current committed boundary.
    expect(abortSessionRun).toHaveBeenCalledWith(SIDE_ID);
    expect(deleteSession).toHaveBeenCalledWith(SIDE_ID);
    expect(onSideSessionClosed).toHaveBeenCalledWith(
      expect.objectContaining({ sideSessionId: SIDE_ID, exitReason: 'replaced' }),
    );
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(flow.isSideModeActive()).toBe(true);
  });

  it('rejects a nested start from inside the side view instead of stacking pairs', async () => {
    const { flow, createSession, append } = createFlow({
      current: { sessionId: PARENT_ID, workspaceDir: '/repo' },
    });

    await flow.startSideSession({ workspaceDir: '/repo' });
    expect(flow.isSideModeActive()).toBe(true);

    await flow.startSideSession({ workspaceDir: '/repo' });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(
      'A side conversation is already open. Press Ctrl+C to return before starting another.',
      'warning',
    );
  });

  it('opens the side view while the parent turn is still running', async () => {
    // The parent Turn must not be aborted: activation only swaps the
    // foreground observer.
    const { flow, loadSessionProjection } = createFlow({
      current: { sessionId: PARENT_ID, workspaceDir: '/repo' },
      hasLiveRun: true,
    });

    await flow.startSideSession({ workspaceDir: '/repo' });

    expect(loadSessionProjection).toHaveBeenCalledWith(SIDE_ID);
  });

  it('refuses instead of creating a blank branch when no committed boundary exists', async () => {
    const { flow, append, createSession } = createFlow({
      current: { sessionId: PARENT_ID, workspaceDir: '/repo' },
      canFork: false,
    });

    const side = await flow.startSideSession({ workspaceDir: '/repo' });

    expect(side).toBeUndefined();
    expect(createSession).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(BTW_REJECT_NO_BOUNDARY, 'warning');
  });

  it('refuses to nest a side session inside a side session', async () => {
    const { flow, append, createSession } = createFlow({
      current: {
        sessionId: SIDE_ID,
        sessionKind: 'peek',
        purpose: BTW_SIDE_SESSION_PURPOSE,
        workspaceDir: '/repo',
      },
    });

    await flow.startSideSession({ workspaceDir: '/repo' });

    expect(createSession).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(BTW_REJECT_NESTED, 'warning');
  });

  it('reports a capability gap when Runtime cannot probe the boundary', async () => {
    const { flow, append, createSession } = createFlow({
      current: { sessionId: PARENT_ID, workspaceDir: '/repo' },
      omitForkProbe: true,
    });

    await flow.startSideSession({ workspaceDir: '/repo' });

    expect(createSession).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(expect.stringContaining('does not support'), 'warning');
  });

  it('cleans up the hidden side session when foreground activation fails', async () => {
    const deleteSession = vi.fn(async () => undefined);
    const { flow, append } = createFlow({
      current: { sessionId: PARENT_ID, workspaceDir: '/repo' },
      deleteSession,
      loadSessionProjection: vi.fn(async () => {
        throw new Error('projection failed');
      }),
    });

    const side = await flow.startSideSession({ workspaceDir: '/repo' });

    expect(side).toBeUndefined();
    expect(deleteSession).toHaveBeenCalledWith(SIDE_ID);
    expect(flow.sideConversationSnapshot()).toBeUndefined();
    expect(append).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('stays in the parent session when creation fails', async () => {
    const { flow, append, loadSessionProjection } = createFlow({
      current: { sessionId: PARENT_ID, workspaceDir: '/repo' },
      createSession: vi.fn(async () => {
        throw new Error('runtime down');
      }),
    });

    const side = await flow.startSideSession({ workspaceDir: '/repo' });

    expect(side).toBeUndefined();
    expect(loadSessionProjection).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(expect.any(String), 'error');
  });
});

describe('toggleSideConversation', () => {
  it('switches between the parent and side projections without ending either', async () => {
    const { flow, deleteSession, loadSessionProjection, onSideConversationChanged } = createFlow({
      current: { sessionId: PARENT_ID, workspaceDir: '/repo' },
    });

    await flow.startSideSession({ workspaceDir: '/repo' });
    expect(await flow.toggleSideConversation()).toBe(true);
    expect(loadSessionProjection).toHaveBeenLastCalledWith(PARENT_ID);
    expect(flow.isSideModeActive()).toBe(false);

    expect(await flow.toggleSideConversation()).toBe(true);
    expect(loadSessionProjection).toHaveBeenLastCalledWith(SIDE_ID);
    expect(flow.isSideModeActive()).toBe(true);

    expect(deleteSession).not.toHaveBeenCalled();
    expect(onSideConversationChanged).toHaveBeenLastCalledWith({
      parentSessionId: PARENT_ID,
      sideSessionId: SIDE_ID,
      activeView: 'side',
    });
  });

  it('is a no-op without an open side conversation', async () => {
    const { flow, loadSessionProjection } = createFlow({ current: { sessionId: PARENT_ID } });

    expect(await flow.toggleSideConversation()).toBe(false);
    expect(loadSessionProjection).not.toHaveBeenCalled();
  });
});

describe('ordinary session navigation with an open side conversation', () => {
  it('disposes the hidden side session instead of leaking it', async () => {
    const { flow, deleteSession, abortSessionRun, onSideSessionClosed, onSideConversationChanged } =
      createFlow({
        current: { sessionId: PARENT_ID, workspaceDir: '/repo' },
      });

    await flow.startSideSession({ workspaceDir: '/repo' });
    await flow.activateSessionById(PARENT_ID, { allowDuringLiveRun: true });

    // Mirrors Codex's background discard: interrupt any detached side Turn
    // first, keep telemetry open/close paired, then delete the Session.
    expect(abortSessionRun).toHaveBeenCalledWith(SIDE_ID);
    expect(onSideSessionClosed).toHaveBeenCalledWith(
      expect.objectContaining({ sideSessionId: SIDE_ID, exitReason: 'navigation' }),
    );
    expect(deleteSession).toHaveBeenCalledWith(SIDE_ID);
    expect(flow.sideConversationSnapshot()).toBeUndefined();
    expect(onSideConversationChanged).toHaveBeenLastCalledWith(undefined);
  });
});

describe('closeSideConversation', () => {
  it('restores the parent view and then destroys the side session', async () => {
    const { flow, deleteSession, loadSessionProjection, onSideSessionClosed } = createFlow({
      current: {
        sessionId: SIDE_ID,
        sessionKind: 'peek',
        purpose: BTW_SIDE_SESSION_PURPOSE,
        parentSessionId: PARENT_ID,
      },
    });

    const left = await flow.leaveSideSession();

    expect(left).toBe(true);
    expect(loadSessionProjection).toHaveBeenCalledWith(PARENT_ID);
    expect(deleteSession).toHaveBeenCalledWith(SIDE_ID);
    expect(onSideSessionClosed).toHaveBeenCalledWith({
      parentSessionId: PARENT_ID,
      sideSessionId: SIDE_ID,
      exitReason: 'ctrl_c',
    });
  });

  it('records Ctrl+D as its own exit reason', async () => {
    const { flow, onSideSessionClosed } = createFlow({
      current: {
        sessionId: SIDE_ID,
        sessionKind: 'peek',
        purpose: BTW_SIDE_SESSION_PURPOSE,
        parentSessionId: PARENT_ID,
      },
    });

    expect(await flow.leaveSideSession('ctrl_d')).toBe(true);
    expect(onSideSessionClosed).toHaveBeenCalledWith(
      expect.objectContaining({ exitReason: 'ctrl_d' }),
    );
  });

  it('is a no-op outside a side session', async () => {
    const { flow, deleteSession } = createFlow({ current: { sessionId: PARENT_ID } });

    expect(await flow.leaveSideSession()).toBe(false);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('stops a live side Turn before restoring the parent and deleting the side session', async () => {
    const { flow, abortForegroundRun, loadSessionProjection, deleteSession, onSideSessionClosed } =
      createFlow({
        current: {
          sessionId: SIDE_ID,
          sessionKind: 'peek',
          purpose: BTW_SIDE_SESSION_PURPOSE,
          parentSessionId: PARENT_ID,
        },
        hasLiveRun: true,
      });

    await flow.leaveSideSession();

    expect(abortForegroundRun).toHaveBeenCalledOnce();
    const abortOrder = abortForegroundRun.mock.invocationCallOrder[0] ?? 0;
    const switchOrder = loadSessionProjection.mock.invocationCallOrder[0] ?? 0;
    const deleteOrder = deleteSession.mock.invocationCallOrder[0] ?? 0;
    expect(switchOrder).toBeGreaterThan(abortOrder);
    expect(deleteOrder).toBeGreaterThan(switchOrder);
    expect(onSideSessionClosed).toHaveBeenCalledWith({
      parentSessionId: PARENT_ID,
      sideSessionId: SIDE_ID,
      sideRunId: 'turn-side',
      exitReason: 'ctrl_c',
    });
  });

  it('stays in the side session when Runtime still reports its Turn running', async () => {
    const { flow, append, loadSessionProjection, deleteSession } = createFlow({
      current: {
        sessionId: SIDE_ID,
        sessionKind: 'peek',
        purpose: BTW_SIDE_SESSION_PURPOSE,
        parentSessionId: PARENT_ID,
      },
      hasLiveRun: true,
      activeRunState: 'running',
    });

    expect(await flow.leaveSideSession()).toBe(false);
    expect(loadSessionProjection).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(expect.stringContaining('did not confirm'), 'warning');
  });

  it('stays in the side session when abort is not confirmed', async () => {
    const abortForegroundRun = vi.fn(async () => false);
    const { flow, append, loadSessionProjection, deleteSession } = createFlow({
      current: {
        sessionId: SIDE_ID,
        sessionKind: 'peek',
        purpose: BTW_SIDE_SESSION_PURPOSE,
        parentSessionId: PARENT_ID,
      },
      hasLiveRun: true,
      abortForegroundRun,
    });

    expect(await flow.leaveSideSession()).toBe(false);
    expect(loadSessionProjection).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(expect.stringContaining('did not confirm'), 'warning');
  });

  it('retries one transient cleanup failure after restoring the parent', async () => {
    const deleteSession = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined);
    const { flow, loadSessionProjection } = createFlow({
      current: {
        sessionId: SIDE_ID,
        sessionKind: 'peek',
        purpose: BTW_SIDE_SESSION_PURPOSE,
        parentSessionId: PARENT_ID,
      },
      deleteSession,
    });

    expect(await flow.leaveSideSession()).toBe(true);
    expect(loadSessionProjection).toHaveBeenCalledWith(PARENT_ID);
    expect(deleteSession).toHaveBeenCalledTimes(2);
  });

  it('reports persistent cleanup failure after restoring the parent', async () => {
    const deleteSession = vi.fn(async () => {
      throw new Error('delete failed');
    });
    const { flow, append, loadSessionProjection } = createFlow({
      current: {
        sessionId: SIDE_ID,
        sessionKind: 'peek',
        purpose: BTW_SIDE_SESSION_PURPOSE,
        parentSessionId: PARENT_ID,
      },
      deleteSession,
    });

    expect(await flow.leaveSideSession()).toBe(true);
    expect(loadSessionProjection).toHaveBeenCalledWith(PARENT_ID);
    expect(deleteSession).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledWith(expect.stringContaining('cleanup failed'), 'error');
  });
});

describe('side conversation failure diagnostics', () => {
  it('records the create cause without exposing its raw text in the transcript', async () => {
    const cause = Object.assign(new Error('History fork target prefix is not settled'), {
      code: 'boundary-invalid',
    });
    const error = Object.assign(new Error('Fork failed', { cause }), { code: 'fork-failed' });
    const fixture = createFlow({
      current: { sessionId: PARENT_ID },
      createSession: vi.fn(async () => {
        throw error;
      }),
    });
    await fixture.flow.startSideSession({ workspaceDir: '/repo' });
    expect(fixture.recordSideSessionFailure).toHaveBeenCalledWith({
      stage: 'create',
      parentSessionId: PARENT_ID,
      error,
    });
    expect(fixture.append).toHaveBeenCalledWith(
      "Couldn't open a side conversation. Try again.",
      'error',
    );
  });
  it('shows a readiness warning when the committed boundary disappeared', async () => {
    const error = Object.assign(new Error('missing boundary'), { code: 'assistant-not-found' });
    const fixture = createFlow({
      current: { sessionId: PARENT_ID },
      createSession: vi.fn(async () => {
        throw error;
      }),
    });
    await fixture.flow.startSideSession({ workspaceDir: '/repo' });
    expect(fixture.append).toHaveBeenCalledWith(BTW_REJECT_NO_BOUNDARY, 'warning');
  });
  it('records activation failure and removes the created side session', async () => {
    const error = new Error('projection read failed');
    const fixture = createFlow({
      current: { sessionId: PARENT_ID },
      loadSessionProjection: vi.fn(async () => {
        throw error;
      }),
    });
    await fixture.flow.startSideSession({ workspaceDir: '/repo' });
    expect(fixture.recordSideSessionFailure).toHaveBeenCalledWith({
      stage: 'activate',
      parentSessionId: PARENT_ID,
      sideSessionId: SIDE_ID,
      error,
    });
    expect(fixture.deleteSession).toHaveBeenCalledWith(SIDE_ID);
  });
});
