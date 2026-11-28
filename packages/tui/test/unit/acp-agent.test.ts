import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as acp from '@agentclientprotocol/sdk';
import { SessionActivityKind, SessionActivityState } from '@mavis/local-runtime-v2/cli-service';
import { describe, expect, it, vi } from 'vitest';

import { TUI_ACP_AVAILABLE_COMMANDS } from '../../src/acp/commands.js';
import { createTuiAcpAgent } from '../../src/acp/agent.js';
import { TuiFailure } from '../../src/failure.js';
import { TuiAcpPromptContinuation } from '../../src/acp/prompt-continuation.js';
import type { TuiAcpRuntime } from '../../src/acp/runtime.js';
import type { TuiContextSnapshotResponse, TuiRuntimeDiagnostics } from '../../src/runtime/port.js';
import type { TuiStreamEvent } from '../../src/runtime/stream-events.js';
import type {
  TuiMcpServer,
  TuiModel,
  TuiSessionUsage,
  TuiSkillList,
} from '../../src/types/runtime-models.js';
import type { TuiRuntimeEvent } from '../../src/types/runtime-events.js';

const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const ACP_AUTH_METHODS = [
  {
    type: 'terminal',
    id: 'minimax-code-login',
    name: 'Sign in to MiniMax Code (Mainland China)',
    args: ['login', '--region', 'cn'],
  },
  {
    type: 'terminal',
    id: 'minimax-code-login-global',
    name: 'Sign in to MiniMax Code (Global)',
    args: ['login', '--region', 'global'],
  },
  {
    type: 'env_var',
    id: 'minimax-code-api-key',
    name: 'Use a MiniMax API key (Mainland China)',
    vars: [{ name: 'MCODE_PROVIDER_API_KEY', label: 'MiniMax API key', secret: true }],
  },
  {
    type: 'env_var',
    id: 'minimax-code-api-key-global',
    name: 'Use a MiniMax API key (Global)',
    vars: [{ name: 'MCODE_PROVIDER_API_KEY', label: 'MiniMax API key', secret: true }],
  },
];

type AcpTestConnection = Parameters<
  Parameters<ReturnType<typeof acp.client>['connectWith']>[1]
>[0];

/**
 * session/new only reserves an ID. A local command is the first use that writes the Runtime
 * Session without starting an Agent turn, for tests that need Runtime-backed Session state.
 */
async function newRuntimeSession(
  connection: AcpTestConnection,
  params: acp.NewSessionRequest,
): Promise<acp.NewSessionResponse> {
  const session = await connection.request(acp.methods.agent.session.new, params);
  await connection.request(acp.methods.agent.session.prompt, {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: '/help' }],
  });
  return session;
}

function createRuntime(
  events: readonly TuiStreamEvent[] = [],
  options: {
    holdRunUntilAbort?: boolean;
    holdRunAfterEvents?: boolean;
    accountStatus?: {
      status: 'ready' | 'needs-login' | 'warning' | 'unknown';
      modelSource?: 'token-plan' | 'byok';
      authMode?: string;
      managedTokenPresent?: boolean;
      warnings: string[];
    };
    models?: readonly TuiModel[];
    runtimeDiagnostics?: TuiRuntimeDiagnostics;
    contextSnapshot?: TuiContextSnapshotResponse;
    sessionUsage?: TuiSessionUsage;
    skills?: TuiSkillList;
    mcpServers?: readonly TuiMcpServer[];
    goalEnabled?: boolean;
  } = {},
) {
  const queuedRuntimeEvents: TuiRuntimeEvent[] = [];
  let deliverRuntimeEvent: ((event: TuiRuntimeEvent | undefined) => void) | undefined;
  let aborted = false;
  let releaseRun: (() => void) | undefined;
  const runGate =
    options.holdRunUntilAbort || options.holdRunAfterEvents
      ? new Promise<void>((resolve) => {
          releaseRun = resolve;
        })
      : Promise.resolve();
  const nextRuntimeEvent = (signal: AbortSignal): Promise<TuiRuntimeEvent | undefined> => {
    const queued = queuedRuntimeEvents.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      deliverRuntimeEvent = resolve;
      signal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
  };
  let sessionSequence = 0;
  const newSessionId = vi.fn(() => `session-${String(++sessionSequence)}`);
  const createSession = vi.fn(
    async ({ workspaceDir, sessionId }: { workspaceDir: string; sessionId?: string }) => ({
      sessionId: sessionId ?? 'session-1',
      workspaceDir,
    }),
  );
  const clearSessionMcpServers = vi.fn(async () => undefined);
  const configureSessionMcpServers = vi.fn(async () => undefined);
  const deleteSession = vi.fn(async () => undefined);
  const listSessionPage = vi.fn(async () => ({ sessions: [], hasMore: false }));
  const getSession = vi.fn(async (sessionId: string) => ({
    sessionId,
    workspaceDir: '/workspace',
  }));
  const listMessagePage = vi.fn(async () => ({ messages: [], hasMore: false }));
  const sendMessageCall = vi.fn(async () => undefined);
  const abortSession = vi.fn(async () => {
    aborted = true;
    releaseRun?.();
    return true;
  });
  const listModels = vi.fn(async () => [...(options.models ?? [])]);
  const selectModel = vi.fn(async () => true);
  const selectSessionModel = vi.fn(async () => true);
  const upsertMiniMaxApiKey = vi.fn(async () => undefined);
  const getAccountStatus = vi.fn(
    async () => options.accountStatus ?? { status: 'ready' as const, warnings: [] },
  );
  const getContextSnapshot = vi.fn(async () =>
    Promise.resolve(options.contextSnapshot ?? { status: 'empty' as const }),
  );
  const getSessionUsage = vi.fn(async () => options.sessionUsage ?? {});
  const listSkills = vi.fn<TuiAcpRuntime['listSkills']>(async () => options.skills ?? {});
  const listMcpServers = vi.fn(async () => [...(options.mcpServers ?? [])]);
  const requestCompaction = vi.fn(async () => ({ success: true }));
  const getPlanModeCapabilities = vi.fn(async () => ({ entryEnabled: true }));
  const getPermissionMode = vi.fn(async () => 'default' as const);
  const setPermissionMode = vi.fn(
    async (mode: 'default' | 'auto' | 'bypassPermissions' | 'off') => mode,
  );
  const steer = vi.fn(async (input: Parameters<TuiAcpRuntime['steer']>[0]) => {
    const result = { turnId: 'turn-active', mode: 'steered' as const };
    await input.preDelivery?.accept(result);
    return result;
  });
  const listQueuedMessages = vi.fn(async () => []);
  const enqueueMessage = vi.fn(async () => ({ itemId: 'queue-1', position: 1 }));
  const updateQueuedMessageContent = vi.fn(async () => undefined);
  const deleteQueuedMessage = vi.fn(async () => undefined);
  const steerQueuedMessage = vi.fn(async () => ({ queueItemId: 'queue-1', turnId: 'turn-2' }));
  const getGoal = vi.fn(async () => undefined);
  const createGoal = vi.fn(async ({ sessionId, objective, tokenBudget }) => ({
    goalId: 'goal-1',
    sessionId,
    objective,
    status: 'active' as const,
    createdAt: 1,
    updatedAt: 1,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    tokenBudget: tokenBudget ?? null,
    hasKickoffAttachments: false,
  }));
  const patchGoal = vi.fn(async (sessionId, patch) => ({
    goalId: 'goal-1',
    sessionId,
    objective: patch.objective ?? 'Ship ACP',
    status: patch.status ?? ('active' as const),
    createdAt: 1,
    updatedAt: 2,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    tokenBudget: patch.tokenBudget ?? null,
    hasKickoffAttachments: false,
  }));
  const clearGoal = vi.fn(async () => true);
  const getDelegationSnapshot = vi.fn(async (rootSessionId: string) => ({
    schemaVersion: 1 as const,
    rootSessionId,
    members: [],
  }));
  const stopDelegation = vi.fn(async (rootSessionId: string) => ({
    schemaVersion: 1 as const,
    rootSessionId,
    rootStopped: true,
    stoppedSessionIds: [],
    activeSessionIds: [],
    failedSessionIds: [],
  }));
  const getActiveRun = vi.fn(async (sessionId: string) => ({
    schemaVersion: 1 as const,
    sessionId,
    state: sessionId === 'session-1' ? ('idle' as const) : ('running' as const),
    ...(sessionId === 'session-1' ? {} : { turnId: 'turn-active' }),
    actions: { steer: sessionId !== 'session-1' },
  }));
  const getSessionForkOptions = vi.fn(async () => ({
    canFork: true,
    worktreeVisible: false,
    worktreeEligible: false,
  }));
  const forkSession = vi.fn(async () => ({
    session: { sessionId: 'session-fork', workspaceDir: '/workspace' },
  }));
  const runtime = {
    newSessionId,
    createSession,
    configureSessionMcpServers,
    clearSessionMcpServers,
    deleteSession,
    listSessionPage,
    getSession,
    listMessagePage,
    getAccountStatus,
    getRuntimeDiagnostics: vi.fn(async () => options.runtimeDiagnostics ?? { warnings: [] }),
    getContextSnapshot,
    getSessionUsage,
    listSkills,
    listMcpServers,
    requestCompaction,
    getPlanModeCapabilities,
    getPermissionMode,
    setPermissionMode,
    steer,
    listQueuedMessages,
    enqueueMessage,
    updateQueuedMessageContent,
    deleteQueuedMessage,
    steerQueuedMessage,
    isGoalEnabled: vi.fn(() => options.goalEnabled ?? true),
    getGoal,
    createGoal,
    patchGoal,
    clearGoal,
    getDelegationSnapshot,
    stopDelegation,
    getActiveRun,
    getSessionForkOptions,
    forkSession,
    sendMessage: vi.fn(async function* sendMessage(req, signal) {
      await sendMessageCall(req, signal);
      if (!options.holdRunAfterEvents) {
        await runGate;
        if (aborted) {
          yield { type: 'session-status', status: 'aborted', turnId: req.turnId } as const;
          return;
        }
      }
      for (const event of events) yield event;
      if (options.holdRunAfterEvents) {
        await runGate;
        if (aborted) {
          yield { type: 'session-status', status: 'aborted', turnId: req.turnId } as const;
        }
      }
    }),
    abortSession,
    listModels,
    selectModel,
    selectSessionModel,
    upsertMiniMaxApiKey,
    replyPermission: vi.fn(async () => true),
    replyQuestionnaire: vi.fn(async () => true),
    dismissQuestionnaire: vi.fn(async () => true),
    watchEvents: vi.fn((signal: AbortSignal) =>
      (async function* runtimeEvents() {
        while (!signal.aborted) {
          const event = await nextRuntimeEvent(signal);
          if (!event) return;
          yield event;
        }
      })(),
    ),
    watchSessionTurn: vi.fn(() =>
      (async function* sessionEvents() {
        yield { type: 'session-status', status: 'finished' } as const;
      })(),
    ),
  };
  return {
    runtime: runtime as unknown as TuiAcpRuntime,
    newSessionId,
    createSession,
    configureSessionMcpServers,
    clearSessionMcpServers,
    deleteSession,
    listSessionPage,
    getSession,
    listMessagePage,
    getAccountStatus,
    sendMessage: sendMessageCall,
    abortSession,
    listModels,
    selectModel,
    selectSessionModel,
    upsertMiniMaxApiKey,
    getContextSnapshot,
    getSessionUsage,
    listSkills,
    listMcpServers,
    requestCompaction,
    getPlanModeCapabilities,
    getPermissionMode,
    setPermissionMode,
    steer,
    listQueuedMessages,
    enqueueMessage,
    updateQueuedMessageContent,
    deleteQueuedMessage,
    steerQueuedMessage,
    getGoal,
    createGoal,
    patchGoal,
    clearGoal,
    getDelegationSnapshot,
    stopDelegation,
    getActiveRun,
    getSessionForkOptions,
    forkSession,
    replyPermission: runtime.replyPermission,
    replyQuestionnaire: runtime.replyQuestionnaire,
    dismissQuestionnaire: runtime.dismissQuestionnaire,
    watchEvents: runtime.watchEvents,
    emitRuntimeEvent(event: TuiRuntimeEvent) {
      const deliver = deliverRuntimeEvent;
      deliverRuntimeEvent = undefined;
      if (deliver) deliver(event);
      else queuedRuntimeEvents.push(event);
    },
  };
}

/** The Runtime direct-send rejection while another Turn holds the Session lock. */
function sessionBusyFailure(): TuiFailure {
  return new TuiFailure(
    'runtime',
    'Session already has an active Turn. Use queue send to deliver the message after it.',
    { code: 'local_session_busy', retryable: true },
  );
}

/** Resolves with the request error, or wraps a success so a missing rejection shows in the diff. */
function settledOutcome(request: Promise<unknown>): Promise<unknown> {
  return request.then(
    (resolved) => ({ resolved }),
    (rejection: unknown) => rejection,
  );
}

/** Races a request against a wall-clock bound so a hang fails the assertion instead of the run. */
function outcomeWithin(request: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    settledOutcome(request),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), ms)),
  ]);
}

describe('MiniMax Code ACP agent', () => {
  it('advertises explicit Mainland China and Global sign-in and API key choices', async () => {
    const { runtime } = createRuntime();
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      const initialized = await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { auth: { terminal: true } },
      });

      expect(initialized.authMethods).toEqual(ACP_AUTH_METHODS);
    });
  });

  it('uses the API key auth method without exposing the key in ACP responses', async () => {
    const { runtime, upsertMiniMaxApiKey } = createRuntime({
      accountStatus: { status: 'ready', modelSource: 'byok', warnings: [] },
    });
    const previousKey = process.env.MCODE_PROVIDER_API_KEY;
    const previousRegion = process.env.MAVIS_REGION;
    process.env.MCODE_PROVIDER_API_KEY = 'sk-test-only';
    // The Mainland China key method needs no Runtime switch in a Mainland China process.
    process.env.MAVIS_REGION = 'cn';
    try {
      const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
      const client = acp.client({ name: 'test-client' });
      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { auth: { terminal: true } },
        });
        await expect(
          connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-api-key',
          }),
        ).resolves.toEqual({});
      });
      expect(upsertMiniMaxApiKey).toHaveBeenCalledWith({
        apiKey: 'sk-test-only',
        saveAndUse: true,
      });
    } finally {
      if (previousKey === undefined) delete process.env.MCODE_PROVIDER_API_KEY;
      else process.env.MCODE_PROVIDER_API_KEY = previousKey;
      if (previousRegion === undefined) delete process.env.MAVIS_REGION;
      else process.env.MAVIS_REGION = previousRegion;
    }
  });

  it('rejects API key authentication when the process environment is missing the key', async () => {
    const previousKey = process.env.MCODE_PROVIDER_API_KEY;
    delete process.env.MCODE_PROVIDER_API_KEY;
    try {
      const { runtime, upsertMiniMaxApiKey } = createRuntime();
      const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
      const client = acp.client({ name: 'test-client' });

      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { auth: { terminal: true } },
        });
        await expect(
          connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-api-key',
          }),
        ).rejects.toThrow('MCODE_PROVIDER_API_KEY');
      });

      expect(upsertMiniMaxApiKey).not.toHaveBeenCalled();
    } finally {
      if (previousKey === undefined) delete process.env.MCODE_PROVIDER_API_KEY;
      else process.env.MCODE_PROVIDER_API_KEY = previousKey;
    }
  });

  it('removes the API key from the process environment once authenticate reads it', async () => {
    const { runtime, upsertMiniMaxApiKey } = createRuntime({
      accountStatus: { status: 'ready', modelSource: 'byok', warnings: [] },
    });
    const previousKey = process.env.MCODE_PROVIDER_API_KEY;
    const previousRegion = process.env.MAVIS_REGION;
    const previousSibling = process.env.MCODE_ACP_TEST_SIBLING;
    process.env.MCODE_PROVIDER_API_KEY = 'sk-env-test-only';
    process.env.MAVIS_REGION = 'cn';
    process.env.MCODE_ACP_TEST_SIBLING = 'kept';
    try {
      const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
      const client = acp.client({ name: 'test-client' });
      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { auth: { terminal: true } },
        });
        await expect(
          connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-api-key',
          }),
        ).resolves.toEqual({});
      });

      // Bash subprocesses inherit this process environment, so the key must not stay there.
      expect('MCODE_PROVIDER_API_KEY' in process.env).toBe(false);
      expect(process.env.MCODE_ACP_TEST_SIBLING).toBe('kept');
      expect(upsertMiniMaxApiKey).toHaveBeenCalledWith({
        apiKey: 'sk-env-test-only',
        saveAndUse: true,
      });
    } finally {
      if (previousKey === undefined) delete process.env.MCODE_PROVIDER_API_KEY;
      else process.env.MCODE_PROVIDER_API_KEY = previousKey;
      if (previousRegion === undefined) delete process.env.MAVIS_REGION;
      else process.env.MAVIS_REGION = previousRegion;
      if (previousSibling === undefined) delete process.env.MCODE_ACP_TEST_SIBLING;
      else process.env.MCODE_ACP_TEST_SIBLING = previousSibling;
    }
  });

  it('retries a failed Global key switch with the key kept in memory, not in the environment', async () => {
    const previousKey = process.env.MCODE_PROVIDER_API_KEY;
    const previousRegion = process.env.MAVIS_REGION;
    process.env.MCODE_PROVIDER_API_KEY = 'sk-retry-test-only';
    process.env.MAVIS_REGION = 'cn';
    try {
      const initial = createRuntime();
      const switched = createRuntime({
        accountStatus: { status: 'ready', modelSource: 'byok', warnings: [] },
      });
      let attempts = 0;
      const switchRegion = vi.fn(async (region: 'cn' | 'en') => {
        process.env.MAVIS_REGION = region;
        attempts += 1;
        if (attempts === 1) throw new Error('Runtime storage is still locked.');
        return switched.runtime;
      });
      const agent = createTuiAcpAgent({ runtime: initial.runtime, version: '1.2.3', switchRegion });
      const client = acp.client({ name: 'test-client' });
      let keyLeftAfterFailedSwitch: boolean | undefined;

      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { auth: { terminal: true } },
        });
        await expect(
          connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-api-key-global',
          }),
        ).rejects.toThrow();
        keyLeftAfterFailedSwitch = 'MCODE_PROVIDER_API_KEY' in process.env;
        await expect(
          connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-api-key-global',
          }),
        ).resolves.toEqual({});
      });

      expect(keyLeftAfterFailedSwitch).toBe(false);
      expect(switched.upsertMiniMaxApiKey).toHaveBeenCalledWith({
        apiKey: 'sk-retry-test-only',
        saveAndUse: true,
      });
    } finally {
      if (previousKey === undefined) delete process.env.MCODE_PROVIDER_API_KEY;
      else process.env.MCODE_PROVIDER_API_KEY = previousKey;
      if (previousRegion === undefined) delete process.env.MAVIS_REGION;
      else process.env.MAVIS_REGION = previousRegion;
    }
  });

  it('authenticates with the API key the ACP command took from the environment at start', async () => {
    const previousKey = process.env.MCODE_PROVIDER_API_KEY;
    const previousRegion = process.env.MAVIS_REGION;
    delete process.env.MCODE_PROVIDER_API_KEY;
    process.env.MAVIS_REGION = 'cn';
    try {
      const { runtime, upsertMiniMaxApiKey } = createRuntime({
        accountStatus: { status: 'ready', modelSource: 'byok', warnings: [] },
      });
      const agent = createTuiAcpAgent({
        runtime,
        version: '1.2.3',
        authApiKey: 'sk-startup-test-only',
      });
      const client = acp.client({ name: 'test-client' });
      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { auth: { terminal: true } },
        });
        await expect(
          connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-api-key',
          }),
        ).resolves.toEqual({});
      });

      expect(upsertMiniMaxApiKey).toHaveBeenCalledWith({
        apiKey: 'sk-startup-test-only',
        saveAndUse: true,
      });
    } finally {
      if (previousKey === undefined) delete process.env.MCODE_PROVIDER_API_KEY;
      else process.env.MCODE_PROVIDER_API_KEY = previousKey;
      if (previousRegion === undefined) delete process.env.MAVIS_REGION;
      else process.env.MAVIS_REGION = previousRegion;
    }
  });

  it('rejects a blank API key without switching region, saving a key or remembering a region', async () => {
    const previousKey = process.env.MCODE_PROVIDER_API_KEY;
    const previousRegion = process.env.MAVIS_REGION;
    process.env.MCODE_PROVIDER_API_KEY = '   ';
    process.env.MAVIS_REGION = 'cn';
    try {
      const initial = createRuntime();
      const switchRegion = vi.fn(async () => initial.runtime);
      const rememberRegion = vi.fn();
      const agent = createTuiAcpAgent({
        runtime: initial.runtime,
        version: '1.2.3',
        switchRegion,
        rememberRegion,
      });
      const client = acp.client({ name: 'test-client' });

      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { auth: { terminal: true } },
        });
        await expect(
          connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-api-key-global',
          }),
        ).rejects.toThrow('MCODE_PROVIDER_API_KEY');
      });

      expect(switchRegion).not.toHaveBeenCalled();
      expect(initial.upsertMiniMaxApiKey).not.toHaveBeenCalled();
      expect(rememberRegion).not.toHaveBeenCalled();
    } finally {
      if (previousKey === undefined) delete process.env.MCODE_PROVIDER_API_KEY;
      else process.env.MCODE_PROVIDER_API_KEY = previousKey;
      if (previousRegion === undefined) delete process.env.MAVIS_REGION;
      else process.env.MAVIS_REGION = previousRegion;
    }
  });

  it('keeps the default terminal login on Mainland China when no region is set', async () => {
    const previousRegion = process.env.MAVIS_REGION;
    delete process.env.MAVIS_REGION;
    try {
      const { runtime, getAccountStatus } = createRuntime();
      const switchRegion = vi.fn(async () => runtime);
      const agent = createTuiAcpAgent({ runtime, version: '1.2.3', switchRegion });
      const client = acp.client({ name: 'test-client' });

      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { auth: { terminal: true } },
        });
        await expect(
          connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-login',
          }),
        ).resolves.toEqual({});
      });

      expect(switchRegion).not.toHaveBeenCalled();
      expect(getAccountStatus).toHaveBeenCalled();
    } finally {
      if (previousRegion === undefined) delete process.env.MAVIS_REGION;
      else process.env.MAVIS_REGION = previousRegion;
    }
  });

  it('switches the Runtime to the Global region before Global authentication checks', async () => {
    const previousRegion = process.env.MAVIS_REGION;
    process.env.MAVIS_REGION = 'cn';
    try {
      const initial = createRuntime();
      const switched = createRuntime();
      const switchRegion = vi.fn(async (region: 'cn' | 'en') => {
        process.env.MAVIS_REGION = region;
        return switched.runtime;
      });
      const agent = createTuiAcpAgent({
        runtime: initial.runtime,
        version: '1.2.3',
        switchRegion,
      });
      const client = acp.client({ name: 'test-client' });

      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { auth: { terminal: true } },
        });
        await expect(
          connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-login-global',
          }),
        ).resolves.toEqual({});
      });

      expect(switchRegion).toHaveBeenCalledWith('en');
      expect(initial.getAccountStatus).not.toHaveBeenCalled();
      expect(switched.getAccountStatus).toHaveBeenCalled();
      expect(process.env.MAVIS_REGION).toBe('en');
    } finally {
      if (previousRegion === undefined) delete process.env.MAVIS_REGION;
      else process.env.MAVIS_REGION = previousRegion;
    }
  });

  it('retries the Global Runtime switch after a failed rebuild instead of checking the stopped Runtime', async () => {
    const previousRegion = process.env.MAVIS_REGION;
    process.env.MAVIS_REGION = 'cn';
    try {
      const initial = createRuntime();
      const switched = createRuntime();
      let attempts = 0;
      const switchRegion = vi.fn(async (region: 'cn' | 'en') => {
        // The ACP command updates the process region before the replacement Runtime starts.
        process.env.MAVIS_REGION = region;
        attempts += 1;
        if (attempts === 1) throw new Error('Runtime storage is still locked.');
        return switched.runtime;
      });
      const agent = createTuiAcpAgent({
        runtime: initial.runtime,
        version: '1.2.3',
        switchRegion,
      });
      const client = acp.client({ name: 'test-client' });

      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { auth: { terminal: true } },
        });
        await expect(
          connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-login-global',
          }),
        ).rejects.toThrow();
        await expect(
          connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-login-global',
          }),
        ).resolves.toEqual({});
      });

      expect(switchRegion.mock.calls).toEqual([['en'], ['en']]);
      expect(initial.getAccountStatus).not.toHaveBeenCalled();
      expect(switched.getAccountStatus).toHaveBeenCalled();
    } finally {
      if (previousRegion === undefined) delete process.env.MAVIS_REGION;
      else process.env.MAVIS_REGION = previousRegion;
    }
  });

  it.each([
    { methodId: 'minimax-code-api-key-global', startRegion: 'cn', keyRegion: 'en' },
    { methodId: 'minimax-code-api-key', startRegion: 'en', keyRegion: 'cn' },
  ] as const)(
    'saves the $methodId key in its own region and remembers that region',
    async ({ methodId, startRegion, keyRegion }) => {
      const previousRegion = process.env.MAVIS_REGION;
      const previousKey = process.env.MCODE_PROVIDER_API_KEY;
      process.env.MAVIS_REGION = startRegion;
      process.env.MCODE_PROVIDER_API_KEY = 'sk-region-test-only';
      try {
        const initial = createRuntime();
        const switched = createRuntime({
          accountStatus: { status: 'ready', modelSource: 'byok', warnings: [] },
        });
        const switchRegion = vi.fn(async (region: 'cn' | 'en') => {
          process.env.MAVIS_REGION = region;
          return switched.runtime;
        });
        const rememberRegion = vi.fn();
        const agent = createTuiAcpAgent({
          runtime: initial.runtime,
          version: '1.2.3',
          switchRegion,
          rememberRegion,
        });
        const client = acp.client({ name: 'test-client' });

        await client.connectWith(agent, async (connection) => {
          await connection.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { auth: { terminal: true } },
          });
          await expect(
            connection.request(acp.methods.agent.authenticate, { methodId }),
          ).resolves.toEqual({});
        });

        expect(switchRegion.mock.calls).toEqual([[keyRegion]]);
        // The key only works against its own region's API host, so the old Runtime never saves it.
        expect(initial.upsertMiniMaxApiKey).not.toHaveBeenCalled();
        expect(switched.upsertMiniMaxApiKey).toHaveBeenCalledWith({
          apiKey: 'sk-region-test-only',
          saveAndUse: true,
        });
        expect(rememberRegion.mock.calls).toEqual([[keyRegion]]);
        expect(switchRegion.mock.invocationCallOrder[0]).toBeLessThan(
          switched.upsertMiniMaxApiKey.mock.invocationCallOrder[0] ?? 0,
        );
        expect(switched.upsertMiniMaxApiKey.mock.invocationCallOrder[0]).toBeLessThan(
          rememberRegion.mock.invocationCallOrder[0] ?? 0,
        );
      } finally {
        if (previousRegion === undefined) delete process.env.MAVIS_REGION;
        else process.env.MAVIS_REGION = previousRegion;
        if (previousKey === undefined) delete process.env.MCODE_PROVIDER_API_KEY;
        else process.env.MCODE_PROVIDER_API_KEY = previousKey;
      }
    },
  );

  it('checks for a Global API key before switching the Runtime region', async () => {
    const previousRegion = process.env.MAVIS_REGION;
    const previousKey = process.env.MCODE_PROVIDER_API_KEY;
    process.env.MAVIS_REGION = 'cn';
    delete process.env.MCODE_PROVIDER_API_KEY;
    try {
      const initial = createRuntime();
      const switchRegion = vi.fn(async () => initial.runtime);
      const rememberRegion = vi.fn();
      const agent = createTuiAcpAgent({
        runtime: initial.runtime,
        version: '1.2.3',
        switchRegion,
        rememberRegion,
      });
      const client = acp.client({ name: 'test-client' });

      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { auth: { terminal: true } },
        });
        await expect(
          connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-api-key-global',
          }),
        ).rejects.toThrow('MCODE_PROVIDER_API_KEY');
      });

      expect(switchRegion).not.toHaveBeenCalled();
      expect(initial.upsertMiniMaxApiKey).not.toHaveBeenCalled();
      expect(rememberRegion).not.toHaveBeenCalled();
    } finally {
      if (previousRegion === undefined) delete process.env.MAVIS_REGION;
      else process.env.MAVIS_REGION = previousRegion;
      if (previousKey === undefined) delete process.env.MCODE_PROVIDER_API_KEY;
      else process.env.MCODE_PROVIDER_API_KEY = previousKey;
    }
  });

  it('saves no Global API key and remembers no region when the Global Runtime cannot start', async () => {
    const previousRegion = process.env.MAVIS_REGION;
    const previousKey = process.env.MCODE_PROVIDER_API_KEY;
    process.env.MAVIS_REGION = 'cn';
    process.env.MCODE_PROVIDER_API_KEY = 'sk-region-test-only';
    try {
      const initial = createRuntime();
      const switchRegion = vi.fn(async (region: 'cn' | 'en') => {
        process.env.MAVIS_REGION = region;
        throw new Error('Runtime storage is still locked.');
      });
      const rememberRegion = vi.fn();
      const agent = createTuiAcpAgent({
        runtime: initial.runtime,
        version: '1.2.3',
        switchRegion,
        rememberRegion,
      });
      const client = acp.client({ name: 'test-client' });

      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { auth: { terminal: true } },
        });
        await expect(
          connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-api-key-global',
          }),
        ).rejects.toThrow();
      });

      expect(switchRegion.mock.calls).toEqual([['en']]);
      expect(initial.upsertMiniMaxApiKey).not.toHaveBeenCalled();
      expect(rememberRegion).not.toHaveBeenCalled();
    } finally {
      if (previousRegion === undefined) delete process.env.MAVIS_REGION;
      else process.env.MAVIS_REGION = previousRegion;
      if (previousKey === undefined) delete process.env.MCODE_PROVIDER_API_KEY;
      else process.env.MCODE_PROVIDER_API_KEY = previousKey;
    }
  });

  it('rejects an unknown ACP authentication method instead of accepting an arbitrary region', async () => {
    const { runtime } = createRuntime();
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { auth: { terminal: true } },
      });
      await expect(
        connection.request(acp.methods.agent.authenticate, {
          methodId: 'minimax-code-login-mars',
        }),
      ).rejects.toThrow('Unknown authentication method.');
    });
  });

  describe('deferred Runtime Session creation', () => {
    it('keeps a new ACP Session out of the Runtime until its first prompt', async () => {
      const { runtime, createSession, configureSessionMcpServers, sendMessage, deleteSession } =
        createRuntime([{ type: 'session-status', status: 'finished' }]);
      const agent = createTuiAcpAgent({ runtime, version: '1.2.3', createTurnId: () => 'turn-1' });
      const client = acp.client({ name: 'ait' });

      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          mcpServers: [{ name: 'docs', command: 'docs-mcp', args: [], env: [] }],
        });
        expect(session.sessionId).toBe('session-1');
        expect(createSession).not.toHaveBeenCalled();
        expect(configureSessionMcpServers).not.toHaveBeenCalled();

        await connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Hello' }],
        });
      });

      expect(createSession).toHaveBeenCalledOnce();
      expect(createSession).toHaveBeenCalledWith({ workspaceDir: '/workspace', sessionId: 'session-1' });
      expect(configureSessionMcpServers).toHaveBeenCalledWith('session-1', [
        { type: 'stdio', name: 'docs', command: 'docs-mcp', args: [] },
      ]);
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'session-1', turnId: 'turn-1', content: 'Hello' }),
        expect.any(AbortSignal),
      );
      expect(deleteSession).not.toHaveBeenCalled();
    });

    it('never writes a Runtime Session when the client closes it before prompting', async () => {
      const { runtime, createSession, clearSessionMcpServers, deleteSession } = createRuntime();
      const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
      const client = acp.client({ name: 'ait' });

      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          mcpServers: [],
        });
        await connection.request(acp.methods.agent.session.close, {
          sessionId: session.sessionId,
        });
        await expect(
          connection.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'Too late' }],
          }),
        ).rejects.toThrow();
      });

      expect(createSession).not.toHaveBeenCalled();
      expect(clearSessionMcpServers).not.toHaveBeenCalled();
      expect(deleteSession).not.toHaveBeenCalled();
    });

    it('answers extension reads from a reserved Session without creating it', async () => {
      const { runtime, createSession, listQueuedMessages, getGoal, getDelegationSnapshot } =
        createRuntime();
      const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
      const client = acp.client({ name: 'ide' });

      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const { sessionId } = await connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          mcpServers: [],
        });
        await expect(
          connection.request<{ items: unknown[] }, { sessionId: string }>(
            'mcode/session/queue/list',
            { sessionId },
          ),
        ).resolves.toEqual({ items: [] });
        await expect(
          connection.request<{ goal: unknown }, { sessionId: string }>('mcode/session/goal/get', {
            sessionId,
          }),
        ).resolves.toEqual({ goal: null });
        await expect(
          connection.request<{ snapshot: unknown }, { sessionId: string }>(
            'mcode/session/delegation/get',
            { sessionId },
          ),
        ).resolves.toEqual({ snapshot: { schemaVersion: 1, rootSessionId: sessionId, members: [] } });
        expect(createSession).not.toHaveBeenCalled();

        await connection.request<unknown, { sessionId: string; objective: string }>(
          'mcode/session/goal/create',
          { sessionId, objective: 'Ship it' },
        );
      });

      expect(listQueuedMessages).not.toHaveBeenCalled();
      expect(getGoal).not.toHaveBeenCalled();
      expect(getDelegationSnapshot).not.toHaveBeenCalled();
      expect(createSession).toHaveBeenCalledOnce();
      expect(createSession).toHaveBeenCalledWith({ workspaceDir: '/workspace', sessionId: 'session-1' });
    });

    it('rolls back a Session whose MCP setup failed so the next prompt can create it again', async () => {
      const { runtime, createSession, configureSessionMcpServers, deleteSession, sendMessage } =
        createRuntime([{ type: 'session-status', status: 'finished' }]);
      const written = new Set<string>();
      createSession.mockImplementation(async ({ workspaceDir, sessionId }) => {
        const id = sessionId ?? 'session-1';
        if (written.has(id)) throw new Error(`Session ${id} already exists`);
        written.add(id);
        return { sessionId: id, workspaceDir };
      });
      deleteSession.mockImplementation(async (sessionId: string) => {
        written.delete(sessionId);
      });
      configureSessionMcpServers.mockRejectedValueOnce(new Error('MCP overlay rejected'));
      const agent = createTuiAcpAgent({ runtime, version: '1.2.3', createTurnId: () => 'turn-1' });
      const client = acp.client({ name: 'ait' });

      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const { sessionId } = await connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          mcpServers: [{ name: 'docs', command: 'docs-mcp', args: [], env: [] }],
        });
        await expect(
          connection.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: 'Hello' }],
          }),
        ).rejects.toThrow();
        expect(deleteSession).toHaveBeenCalledWith('session-1');
        expect(written.size).toBe(0);

        await expect(
          connection.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: 'Hello' }],
          }),
        ).resolves.toMatchObject({ stopReason: 'end_turn' });
      });

      expect(createSession).toHaveBeenCalledTimes(2);
      expect(configureSessionMcpServers).toHaveBeenCalledTimes(2);
      expect(written).toEqual(new Set(['session-1']));
      expect(sendMessage).toHaveBeenCalledOnce();
    });

    it('removes a Session written after the client closed it mid-creation', async () => {
      const { runtime, createSession, deleteSession, sendMessage } = createRuntime();
      let releaseCreate!: () => void;
      createSession.mockImplementationOnce(
        async ({ workspaceDir, sessionId }: { workspaceDir: string; sessionId?: string }) => {
          await new Promise<void>((resolve) => {
            releaseCreate = resolve;
          });
          return { sessionId: sessionId ?? 'session-1', workspaceDir };
        },
      );
      const agent = createTuiAcpAgent({ runtime, version: '1.2.3', createTurnId: () => 'turn-1' });
      const client = acp.client({ name: 'ait' });

      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const { sessionId } = await connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          mcpServers: [],
        });
        const prompt = connection.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'Hello' }],
        });
        void prompt.catch(() => undefined);
        await vi.waitFor(() => expect(createSession).toHaveBeenCalledOnce());
        await connection.request(acp.methods.agent.session.close, { sessionId });
        releaseCreate();
        await prompt.catch(() => undefined);
        await vi.waitFor(() => expect(deleteSession).toHaveBeenCalledWith('session-1'));
      });

      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('finishes a written Session on retry when rolling it back failed', async () => {
      const { runtime, createSession, configureSessionMcpServers, deleteSession, getSession } =
        createRuntime([{ type: 'session-status', status: 'finished' }]);
      configureSessionMcpServers.mockRejectedValueOnce(new Error('MCP overlay rejected'));
      deleteSession.mockRejectedValueOnce(new Error('delete failed'));
      const agent = createTuiAcpAgent({ runtime, version: '1.2.3', createTurnId: () => 'turn-1' });
      const client = acp.client({ name: 'ait' });

      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const { sessionId } = await connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          mcpServers: [{ name: 'docs', command: 'docs-mcp', args: [], env: [] }],
        });
        await expect(
          connection.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: 'Hello' }],
          }),
        ).rejects.toThrow();
        await expect(
          connection.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: 'Hello' }],
          }),
        ).resolves.toMatchObject({ stopReason: 'end_turn' });
      });

      // The second attempt reads the Session the first one wrote instead of colliding with it.
      expect(createSession).toHaveBeenCalledOnce();
      expect(getSession).toHaveBeenCalledWith('session-1');
      expect(configureSessionMcpServers).toHaveBeenCalledTimes(2);
    });

    it('does not lose a model chosen while an extension write is creating the Session', async () => {
      const models = [
        { providerId: 'minimax', modelId: 'm3', selected: true },
        { providerId: 'minimax', modelId: 'm3-flash' },
        { providerId: 'minimax', modelId: 'm3-pro' },
      ];
      const { runtime, selectSessionModel, getSession } = createRuntime([], { models });
      let releaseFirstSelection!: () => void;
      selectSessionModel.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            releaseFirstSelection = () => resolve(true);
          }),
      );
      const persistedModel: { providerId: string; modelId: string }[] = [];
      selectSessionModel.mockImplementation(async (selection) => {
        persistedModel.push(selection);
        return true;
      });
      getSession.mockImplementation(async (sessionId: string) => ({
        sessionId,
        workspaceDir: '/workspace',
        ...(persistedModel.length > 0 ? { model: persistedModel.at(-1) } : {}),
      }));
      const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
      const client = acp.client({ name: 'ide' });

      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const { sessionId } = await connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          mcpServers: [],
        });
        await connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'model',
          value: 'm:minimax:m3-flash:u',
        });
        const enqueue = connection.request<unknown, { sessionId: string; text: string }>(
          'mcode/session/queue/enqueue',
          { sessionId, text: 'later' },
        );
        await vi.waitFor(() => expect(selectSessionModel).toHaveBeenCalledOnce());
        const switched = connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'model',
          value: 'm:minimax:m3-pro:u',
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        releaseFirstSelection();
        await enqueue;
        await expect(switched).resolves.toMatchObject({
          configOptions: expect.arrayContaining([
            expect.objectContaining({ id: 'model', currentValue: 'm:minimax:m3-pro:u' }),
          ]),
        });
      });

      expect(selectSessionModel.mock.calls.map(([selection]) => selection.modelId)).toEqual([
        'm3-flash',
        'm3-pro',
      ]);
    });

    it('applies a model chosen before the first prompt once the Session is created', async () => {
      const models = [
        { providerId: 'minimax', modelId: 'm3', selected: true, effortOptions: ['low', 'high'] },
        { providerId: 'minimax', modelId: 'm3-flash', effortOptions: ['low', 'high'] },
      ];
      const { runtime, createSession, selectSessionModel, getSession } = createRuntime(
        [{ type: 'session-status', status: 'finished' }],
        { models },
      );
      const agent = createTuiAcpAgent({ runtime, version: '1.2.3', createTurnId: () => 'turn-1' });
      const client = acp.client({ name: 'ait' });

      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          mcpServers: [],
        });
        expect(session.configOptions).toContainEqual(
          expect.objectContaining({ id: 'model', currentValue: 'm:minimax:m3:u' }),
        );
        const changed = await connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId: session.sessionId,
          configId: 'model',
          value: 'm:minimax:m3-flash:u',
        });
        expect(changed.configOptions).toContainEqual(
          expect.objectContaining({ id: 'model', currentValue: 'm:minimax:m3-flash:u' }),
        );
        const effort = await connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId: session.sessionId,
          configId: 'thinkingEffort',
          value: 'low',
        });
        expect(effort.configOptions).toContainEqual(
          expect.objectContaining({ id: 'thinkingEffort', currentValue: 'low' }),
        );
        expect(createSession).not.toHaveBeenCalled();
        expect(selectSessionModel).not.toHaveBeenCalled();
        expect(getSession).not.toHaveBeenCalled();

        await connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Hello' }],
        });
      });

      expect(createSession).toHaveBeenCalledOnce();
      expect(selectSessionModel).toHaveBeenCalledOnce();
      expect(selectSessionModel).toHaveBeenCalledWith(
        { providerId: 'minimax', modelId: 'm3-flash', thinking: { effort: 'low' } },
        'session-1',
      );
      expect(createSession.mock.invocationCallOrder[0]).toBeLessThan(
        selectSessionModel.mock.invocationCallOrder[0] ?? 0,
      );
    });
  });

  describe('Runtime event subscription across a region switch', () => {
    const withCnRegion = async (run: () => Promise<void>) => {
      const previousRegion = process.env.MAVIS_REGION;
      process.env.MAVIS_REGION = 'cn';
      try {
        await run();
      } finally {
        if (previousRegion === undefined) delete process.env.MAVIS_REGION;
        else process.env.MAVIS_REGION = previousRegion;
      }
    };

    it('forwards permission requests from the Runtime the Global switch started', async () => {
      await withCnRegion(async () => {
        const initial = createRuntime();
        const switched = createRuntime();
        const switchRegion = vi.fn(async (region: 'cn' | 'en') => {
          process.env.MAVIS_REGION = region;
          return switched.runtime;
        });
        const permissionRequests: acp.RequestPermissionRequest[] = [];
        const agent = createTuiAcpAgent({
          runtime: initial.runtime,
          version: '1.2.3',
          switchRegion,
        });
        const client = acp
          .client({ name: 'test-client' })
          .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
            permissionRequests.push(params);
            return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
          });

        await client.connectWith(agent, async (connection) => {
          await connection.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { auth: { terminal: true } },
          });
          await connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-login-global',
          });
          await connection.request(acp.methods.agent.session.new, {
            cwd: '/workspace',
            mcpServers: [],
          });
          switched.emitRuntimeEvent(permissionEvent('permission-after-switch'));

          await vi.waitFor(() => expect(switched.replyPermission).toHaveBeenCalledOnce());
          // The stopped Runtime's subscription is released while the connection stays open.
          expect(initial.watchEvents.mock.calls[0]?.[0].aborted).toBe(true);
        });

        expect(permissionRequests).toEqual([
          expect.objectContaining({
            sessionId: 'session-1',
            toolCall: expect.objectContaining({ toolCallId: 'permission-after-switch' }),
          }),
        ]);
        // The decision goes back to the Runtime that asked, never to the stopped one.
        expect(switched.replyPermission).toHaveBeenCalledWith(
          'mcode',
          'permission-after-switch',
          'allowOnce',
        );
        expect(initial.replyPermission).not.toHaveBeenCalled();
      });
    });

    it('forwards questionnaires from the Runtime the Global switch started', async () => {
      await withCnRegion(async () => {
        const initial = createRuntime();
        const switched = createRuntime();
        const switchRegion = vi.fn(async (region: 'cn' | 'en') => {
          process.env.MAVIS_REGION = region;
          return switched.runtime;
        });
        const permissionRequests: acp.RequestPermissionRequest[] = [];
        const agent = createTuiAcpAgent({
          runtime: initial.runtime,
          version: '1.2.3',
          switchRegion,
        });
        const client = acp
          .client({ name: 'test-client' })
          .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
            permissionRequests.push(params);
            return {
              outcome: {
                outcome: 'selected',
                optionId: 'questionnaire:questionnaire-after-switch:safe',
              },
            };
          });

        await client.connectWith(agent, async (connection) => {
          await connection.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { auth: { terminal: true } },
          });
          await connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-login-global',
          });
          await connection.request(acp.methods.agent.session.new, {
            cwd: '/workspace',
            mcpServers: [],
          });
          switched.emitRuntimeEvent(questionnaireEvent('questionnaire-after-switch'));

          await vi.waitFor(() => expect(switched.replyQuestionnaire).toHaveBeenCalledOnce());
        });

        expect(permissionRequests).toEqual([
          expect.objectContaining({
            sessionId: 'session-1',
            toolCall: expect.objectContaining({ toolCallId: 'questionnaire-after-switch' }),
          }),
        ]);
        expect(switched.replyQuestionnaire).toHaveBeenCalledWith(
          'mcode',
          'questionnaire-after-switch',
          [{ stepId: 'approach', selectedOptionIds: ['safe'] }],
        );
        expect(initial.replyQuestionnaire).not.toHaveBeenCalled();
      });
    });

    it('denies a pending permission of the replaced Runtime on that Runtime, not the new one', async () => {
      await withCnRegion(async () => {
        const initial = createRuntime();
        const switched = createRuntime();
        const switchRegion = vi.fn(async (region: 'cn' | 'en') => {
          process.env.MAVIS_REGION = region;
          return switched.runtime;
        });
        const permissionRequests: acp.RequestPermissionRequest[] = [];
        const agent = createTuiAcpAgent({
          runtime: initial.runtime,
          version: '1.2.3',
          switchRegion,
        });
        const client = acp
          .client({ name: 'test-client' })
          .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
            permissionRequests.push(params);
            // The user has not answered yet when the region switch completes.
            return new Promise<acp.RequestPermissionResponse>(() => undefined);
          });

        await client.connectWith(agent, async (connection) => {
          await connection.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { auth: { terminal: true } },
          });
          await connection.request(acp.methods.agent.session.new, {
            cwd: '/workspace',
            mcpServers: [],
          });
          initial.emitRuntimeEvent(permissionEvent('permission-before-switch'));
          await vi.waitFor(() => expect(permissionRequests).toHaveLength(1));

          await connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-login-global',
          });

          await vi.waitFor(() =>
            expect(initial.replyPermission).toHaveBeenCalledWith(
              'mcode',
              'permission-before-switch',
              'deny',
            ),
          );
        });

        const decisions = (
          initial.replyPermission.mock.calls as unknown as ReadonlyArray<readonly unknown[]>
        ).map((call) => call[2]);
        expect(new Set(decisions)).toEqual(new Set(['deny']));
        expect(switched.replyPermission).not.toHaveBeenCalled();
      });
    });

    it('keeps forwarding the current Runtime permission requests after a failed switch', async () => {
      await withCnRegion(async () => {
        const initial = createRuntime();
        const switchRegion = vi.fn(async () => {
          throw new Error('Runtime storage is still locked.');
        });
        const permissionRequests: acp.RequestPermissionRequest[] = [];
        const agent = createTuiAcpAgent({
          runtime: initial.runtime,
          version: '1.2.3',
          switchRegion,
        });
        const client = acp
          .client({ name: 'test-client' })
          .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
            permissionRequests.push(params);
            return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
          });

        await client.connectWith(agent, async (connection) => {
          await connection.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { auth: { terminal: true } },
          });
          await expect(
            connection.request(acp.methods.agent.authenticate, {
              methodId: 'minimax-code-login-global',
            }),
          ).rejects.toThrow();
          await connection.request(acp.methods.agent.session.new, {
            cwd: '/workspace',
            mcpServers: [],
          });
          initial.emitRuntimeEvent(permissionEvent('permission-after-failed-switch'));

          await vi.waitFor(() => expect(initial.replyPermission).toHaveBeenCalledOnce());
          // The failed switch neither replaced nor re-opened the original subscription.
          expect(initial.watchEvents).toHaveBeenCalledOnce();
          expect(initial.watchEvents.mock.calls[0]?.[0].aborted).toBe(false);
        });

        expect(switchRegion).toHaveBeenCalledOnce();
        expect(permissionRequests).toEqual([
          expect.objectContaining({
            toolCall: expect.objectContaining({ toolCallId: 'permission-after-failed-switch' }),
          }),
        ]);
        expect(initial.replyPermission).toHaveBeenCalledWith(
          'mcode',
          'permission-after-failed-switch',
          'allowOnce',
        );
      });
    });

    // The fence reads the Runtime that owns the Session now. The stopped Runtime fails every
    // read, and a failed read is fail-open, so a fence still bound to it would admit the
    // prompt into the Turn the new Runtime reports blocked on a decision.
    const switchToGlobalWithStoppedInitial = () => {
      const initial = createRuntime();
      initial.getActiveRun.mockRejectedValue(new Error('Runtime is closed.'));
      const switched = createRuntime([{ type: 'session-status', status: 'finished' }]);
      const switchRegion = vi.fn(async (region: 'cn' | 'en') => {
        process.env.MAVIS_REGION = region;
        return switched.runtime;
      });
      return { initial, switched, switchRegion };
    };

    it('runs the admission fence on the Runtime the Global switch started', async () => {
      await withCnRegion(async () => {
        const { initial, switched, switchRegion } = switchToGlobalWithStoppedInitial();
        let pendingDecision = false;
        switched.getActiveRun.mockImplementation(async (sessionId: string) => ({
          schemaVersion: 1 as const,
          sessionId,
          state: pendingDecision ? ('decision-blocked' as const) : ('idle' as const),
          ...(pendingDecision ? { turnId: 'turn-hidden' } : {}),
          actions: { steer: false },
        }));
        const agent = createTuiAcpAgent({
          runtime: initial.runtime,
          version: '1.2.3',
          switchRegion,
          promptAdmission: { maxWaitMs: 60_000 },
        });
        const client = acp.client({ name: 'test-client' });

        await client.connectWith(agent, async (connection) => {
          await connection.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { auth: { terminal: true } },
          });
          await connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-login-global',
          });
          const session = await connection.request(acp.methods.agent.session.new, {
            cwd: '/workspace',
            mcpServers: [],
          });
          await connection.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'First' }],
          });
          pendingDecision = true;
          const next = connection.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'Follow up' }],
          });
          const outcome = await outcomeWithin(next, 1_000);
          if (outcome === 'still waiting') {
            await connection.notify(acp.methods.agent.session.cancel, {
              sessionId: session.sessionId,
            });
            await next.catch(() => undefined);
          }
          expect(outcome).toMatchObject({
            code: -32603,
            data: { code: 'local_session_busy', retryable: false, reason: 'turn-awaiting-decision' },
          });
        });

        expect(switched.sendMessage).toHaveBeenCalledOnce();
        expect(initial.getActiveRun).not.toHaveBeenCalled();
      });
    });

    it('runs the busy retry wait on the Runtime the Global switch started', async () => {
      await withCnRegion(async () => {
        const { initial, switched, switchRegion } = switchToGlobalWithStoppedInitial();
        let pendingDecision = false;
        switched.getActiveRun.mockImplementation(async (sessionId: string) => ({
          schemaVersion: 1 as const,
          sessionId,
          state: pendingDecision ? ('decision-blocked' as const) : ('idle' as const),
          ...(pendingDecision ? { turnId: 'turn-hidden' } : {}),
          actions: { steer: false },
        }));
        const attempts: string[] = [];
        vi.mocked(switched.runtime.sendMessage).mockImplementation((request) =>
          (async function* promptEvents() {
            attempts.push(`${request.content}`);
            if (request.content === 'Follow up') {
              // A Runtime Turn took the lock after the fence read idle, then asked a questionnaire.
              pendingDecision = true;
              throw sessionBusyFailure();
            }
            yield { type: 'session-status', status: 'finished', turnId: request.turnId } as const;
          })(),
        );
        const agent = createTuiAcpAgent({
          runtime: initial.runtime,
          version: '1.2.3',
          switchRegion,
          promptAdmission: { maxWaitMs: 60_000 },
        });
        const client = acp.client({ name: 'test-client' });

        await client.connectWith(agent, async (connection) => {
          await connection.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { auth: { terminal: true } },
          });
          await connection.request(acp.methods.agent.authenticate, {
            methodId: 'minimax-code-login-global',
          });
          const session = await connection.request(acp.methods.agent.session.new, {
            cwd: '/workspace',
            mcpServers: [],
          });
          await connection.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'First' }],
          });
          const next = connection.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'Follow up' }],
          });
          const outcome = await outcomeWithin(next, 1_000);
          if (outcome === 'still waiting') {
            await connection.notify(acp.methods.agent.session.cancel, {
              sessionId: session.sessionId,
            });
            await next.catch(() => undefined);
          }
          expect(outcome).toMatchObject({
            code: -32603,
            data: { code: 'local_session_busy', retryable: false, reason: 'turn-awaiting-decision' },
          });
        });

        // One rejected send and no retry into the Turn that waits for a decision.
        expect(attempts).toEqual(['First', 'Follow up']);
        expect(initial.getActiveRun).not.toHaveBeenCalled();
      });
    });
  });

  it.each(['new', 'load', 'resume', 'fork'] as const)(
    'advertises session Skills on %s and forwards Skill instructions to the Runtime',
    async (method) => {
      const { runtime, listSkills, sendMessage, getSession, forkSession } = createRuntime(
        [{ type: 'session-status', status: 'finished' }],
        {
          skills: {
            skills: [
              {
                name: 'matt:review',
                description: 'Review changes',
                enabled: true,
              },
              { name: 'repo-test', displayDescription: 'Test the project' },
              { name: 'MATT:REVIEW', description: 'Duplicate' },
              {
                name: 'Compact',
                description: 'Must not replace a native command',
              },
              { name: 'disabled', enabled: false },
              { name: 'invalid/name' },
              { name: 'invalid name' },
              { name: '' },
              { name: 'x'.repeat(129) },
              { name: 'bad\u001b[31m' },
            ],
          },
        },
      );
      getSession.mockImplementation(async (sessionId) => ({
        sessionId,
        workspaceDir: '/project',
        agentName: 'reviewer',
      }));
      forkSession.mockResolvedValue({
        session: {
          sessionId: 'session-fork',
          workspaceDir: '/project',
          agentName: 'reviewer',
        },
      });
      const updates: acp.SessionNotification[] = [];
      const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
      const client = acp
        .client({ name: 'zed' })
        .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));
      await client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const response = await connection.request(acp.methods.agent.session[method], {
          sessionId: 'session-1',
          cwd: '/project',
          mcpServers: [],
        });
        const sessionId = 'sessionId' in response ? response.sessionId : 'session-1';
        const roster = () =>
          updates
            .filter(
              (update) =>
                update.sessionId === sessionId &&
                update.update.sessionUpdate === 'available_commands_update',
            )
            .at(-1)?.update;
        const expected = {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            ...TUI_ACP_AVAILABLE_COMMANDS,
            {
              name: 'matt:review',
              description: '[Skill] Review changes',
              input: { hint: '[instructions]' },
            },
            {
              name: 'repo-test',
              description: '[Skill] Test the project',
              input: { hint: '[instructions]' },
            },
          ],
        };
        await vi.waitFor(() => expect(roster()).toEqual(expected));
        expect(listSkills).toHaveBeenCalledWith(
          method === 'new' ? undefined : 'reviewer',
          undefined,
          '/project',
        );
        // A delayed listener retry must retain the complete Skill roster.
        await new Promise((resolve) => setTimeout(resolve, 130));
        expect(roster()).toEqual(expected);
        await expect(
          connection.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: '/matt:review focus on error handling' }],
          }),
        ).resolves.toMatchObject({ stopReason: 'end_turn' });
        expect(sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            id: sessionId,
            content: '/matt:review focus on error handling',
          }),
          expect.any(AbortSignal),
        );
      });
    },
  );

  it.each(['reject', 'stall'] as const)(
    'keeps native commands available when Skill discovery can %s',
    async (failure) => {
      const { runtime, listSkills } = createRuntime();
      if (failure === 'reject') listSkills.mockRejectedValue(new Error('Unavailable'));
      else listSkills.mockImplementation(() => new Promise(() => undefined));
      const updates: acp.SessionNotification[] = [];
      const client = acp
        .client({ name: 'zed' })
        .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));
      await client.connectWith(
        createTuiAcpAgent({ runtime, version: '1.2.3' }),
        async (connection) => {
          await connection.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const { sessionId } = await connection.request(acp.methods.agent.session.new, {
            cwd: '/workspace',
            mcpServers: [],
          });
          await vi.waitFor(() =>
            expect(updates).toContainEqual({
              sessionId,
              update: {
                sessionUpdate: 'available_commands_update',
                availableCommands: TUI_ACP_AVAILABLE_COMMANDS,
              },
            }),
          );
          await expect(
            connection.request(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: 'text', text: '/help' }],
            }),
          ).resolves.toEqual({ stopReason: 'end_turn' });
        },
      );
    },
  );

  it.each(['close', 'resume'] as const)(
    'ignores late Skill discovery after session %s',
    async (method) => {
      const { runtime, listSkills } = createRuntime([], {
        skills: { skills: [{ name: 'current' }] },
      });
      let resolveSkills!: (skills: TuiSkillList) => void;
      listSkills.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSkills = resolve;
          }),
      );
      const updates: acp.SessionNotification[] = [];
      const client = acp
        .client({ name: 'zed' })
        .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));
      await client.connectWith(
        createTuiAcpAgent({ runtime, version: '1.2.3' }),
        async (connection) => {
          await connection.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const { sessionId } = await connection.request(acp.methods.agent.session.new, {
            cwd: '/workspace',
            mcpServers: [],
          });
          await vi.waitFor(() => expect(listSkills).toHaveBeenCalledOnce());
          await connection.request(acp.methods.agent.session[method], {
            sessionId,
            cwd: '/workspace',
            mcpServers: [],
          });
          if (method === 'resume') {
            await vi.waitFor(() =>
              expect(updates).toContainEqual({
                sessionId,
                update: {
                  sessionUpdate: 'available_commands_update',
                  availableCommands: [
                    ...TUI_ACP_AVAILABLE_COMMANDS,
                    {
                      name: 'current',
                      description: '[Skill]',
                      input: { hint: '[instructions]' },
                    },
                  ],
                },
              }),
            );
          }
          resolveSkills({ skills: [{ name: 'stale' }] });
          const count = updates.length;
          await new Promise((resolve) => setTimeout(resolve, 130));
          const rosters = updates.flatMap(({ update }) =>
            update.sessionUpdate === 'available_commands_update' ? update.availableCommands : [],
          );
          expect(rosters.some((command) => command.name === 'stale')).toBe(false);
          if (method === 'close') expect(updates).toHaveLength(count);
        },
      );
    },
  );

  it('advertises and executes native help and model commands without starting an Agent turn', async () => {
    const { runtime, sendMessage, listModels, selectModel } = createRuntime([], {
      models: [
        {
          providerId: 'minimax',
          modelId: 'm3',
          displayName: 'MiniMax M3',
          selected: true,
        },
        { providerId: 'custom', modelId: 'coder', displayName: 'Coder' },
      ],
    });
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'zed' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });

      await vi.waitFor(() =>
        expect(updates).toContainEqual({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              {
                name: 'help',
                description: 'Show available commands',
              },
              {
                name: 'new',
                description: 'Start a fresh session in the current workspace',
              },
              {
                name: 'model',
                description: 'Choose a model',
                input: { hint: '[provider/model[#variant]]' },
              },
              {
                name: 'status',
                description: 'Show account and model status',
              },
              {
                name: 'doctor',
                description: 'Check the local config file',
              },
              {
                name: 'context',
                description: 'Show the Runtime-owned context snapshot',
              },
              {
                name: 'skills',
                description: 'List built-in and user Skills',
                input: { hint: '[filter]' },
              },
              {
                name: 'mcp',
                description: 'Inspect MCP capabilities and project configuration',
                input: { hint: '[filter]' },
              },
              {
                name: 'usage',
                description: 'Show session usage',
              },
              {
                name: 'compact',
                description: 'Shorten the active conversation',
                input: { hint: '[instructions]' },
              },
            ],
          },
        }),
      );

      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '/help' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '/model' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '/model custom/coder' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
    });

    expect(listModels).toHaveBeenCalledTimes(3);
    // session/new reads the global roster: the reserved Session is not in the Runtime yet.
    expect(listModels).toHaveBeenNthCalledWith(1);
    expect(listModels).toHaveBeenNthCalledWith(2, 'session-1');
    expect(listModels).toHaveBeenNthCalledWith(3, 'session-1');
    expect(selectModel).toHaveBeenCalledWith(
      { providerId: 'custom', modelId: 'coder' },
      'session-1',
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(updates).toEqual(
      expect.arrayContaining([
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: [
                'Available commands:',
                '- /help — Show available commands',
                '- /new — Start a fresh session in the current workspace',
                '- /model [provider/model[#variant]] — Choose a model',
                '- /status — Show account and model status',
                '- /doctor — Check the local config file',
                '- /context — Show the Runtime-owned context snapshot',
                '- /skills [filter] — List built-in and user Skills',
                '- /mcp [filter] — Inspect MCP capabilities and project configuration',
                '- /usage — Show session usage',
                '- /compact [instructions] — Shorten the active conversation',
              ].join('\n'),
            },
          },
        },
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: [
                'Available models:',
                '- minimax/m3 (MiniMax M3) [selected]',
                '- custom/coder (Coder)',
                '',
                'Use `/model <provider/model[#variant]>` to switch.',
              ].join('\n'),
            },
          },
        },
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Model selected: custom/coder' },
          },
        },
      ]),
    );
  });

  it('compacts the Runtime session and reports unchanged conversations locally', async () => {
    const { runtime, sendMessage, requestCompaction } = createRuntime();
    requestCompaction
      .mockResolvedValueOnce({ success: false, code: 'NOTHING_TO_COMPACT' })
      .mockResolvedValueOnce({
        success: true,
        messagesBefore: 20,
        messagesAfter: 8,
        tokensBefore: 12_000,
        tokensAfter: 5_000,
      });
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'zed' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      for (const text of ['/compact', '/compact keep decisions']) {
        await expect(
          connection.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });
      }
    });

    expect(requestCompaction).toHaveBeenNthCalledWith(1, 'session-1', undefined, undefined);
    expect(requestCompaction).toHaveBeenNthCalledWith(2, 'session-1', undefined, 'keep decisions');
    expect(sendMessage).not.toHaveBeenCalled();
    const texts = updates.flatMap((notification) =>
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text'
        ? [notification.update.content.text]
        : [],
    );
    expect(texts).toEqual(
      expect.arrayContaining([
        'No compaction is needed for this conversation yet.',
        ['Compaction completed.', 'Messages: 20 → 8', 'Tokens: 12,000 → 5,000'].join('\n'),
      ]),
    );
  });

  it('renders Runtime-backed context, skills, MCP, and usage inspections', async () => {
    const {
      runtime,
      sendMessage,
      getContextSnapshot,
      getSessionUsage,
      listSkills,
      listMcpServers,
    } = createRuntime([], {
      contextSnapshot: {
        status: 'live',
        model: { provider: 'minimax', id: 'm3', contextWindow: 10_000 },
        contextUsage: {
          contextWindowTokens: 10_000,
          usedTokens: 4_000,
          totalCountSource: 'LOCAL_ESTIMATE',
          components: [
            { kind: 'SYSTEM_PROMPT', tokens: 1_000 },
            { kind: 'MESSAGES', tokens: 3_000 },
          ],
        },
        compaction: { state: 'never' },
      },
      sessionUsage: {
        summary: {
          inputTokens: 100,
          outputTokens: 25,
          reasoningTokens: 5,
          cacheReadTokens: 20,
          totalTokens: 150,
          turns: 2,
          costUsd: 0.0123,
        },
      },
      skills: {
        skills: [
          { name: 'repo-review', description: 'Review repository changes' },
          { name: 'tdd', displayName: 'TDD', displayDescription: 'Develop test-first' },
        ],
        hasMore: true,
      },
      mcpServers: [
        { name: 'github', enabled: true, transport: 'stdio', description: 'GitHub tools' },
        { name: 'disabled-one', enabled: false, transport: 'http' },
      ],
    });
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'zed' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      for (const text of ['/context', '/skills review', '/mcp git', '/usage']) {
        await expect(
          connection.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });
      }
    });

    expect(getContextSnapshot).toHaveBeenCalledWith('session-1');
    expect(listSkills).toHaveBeenCalledWith(undefined, 'review', '/workspace');
    expect(listMcpServers).toHaveBeenCalledWith('git', 'session-1');
    expect(getSessionUsage).toHaveBeenCalledWith('session-1');
    expect(sendMessage).not.toHaveBeenCalled();
    const texts = updates.flatMap((notification) =>
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text'
        ? [notification.update.content.text]
        : [],
    );
    expect(texts).toEqual(
      expect.arrayContaining([
        [
          'Context: live',
          'Model: minimax/m3',
          'Budget: 4,000 / 10,000 tokens (40%)',
          'Compaction: never',
          'Components:',
          '- System prompt: 1,000 tokens',
          '- Messages: 3,000 tokens',
        ].join('\n'),
        [
          'Skills · 2+',
          '- repo-review — Review repository changes',
          '- TDD — Develop test-first',
          'More Skills exist; narrow the list with /skills <filter>.',
        ].join('\n'),
        [
          'MCP servers · 2',
          '- github — enabled · stdio — GitHub tools',
          '- disabled-one — disabled · http',
        ].join('\n'),
        [
          'Session usage:',
          'Input tokens: 100',
          'Output tokens: 25',
          'Reasoning tokens: 5',
          'Cache read tokens: 20',
          'Cache write tokens: 0',
          'Total tokens: 150',
          'Turns: 2',
          'Cost: $0.0123',
        ].join('\n'),
      ]),
    );
  });

  it('shows Runtime diagnostics for /doctor without exposing credential values', async () => {
    const { runtime, sendMessage } = createRuntime([], {
      runtimeDiagnostics: {
        status: 'ready',
        configPath: '/workspace/config.yaml',
        configPresent: true,
        defaultModel: 'minimax/m3',
        providerId: 'minimax',
        authMode: 'managed-login',
        managedTokenPresent: true,
        apiKeyPresent: false,
        warnings: [],
      },
    });
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'zed' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '/doctor' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(updates).toContainEqual({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: [
            'Configuration status: ready',
            'Config path: /workspace/config.yaml',
            'Config file: present',
            'Default model: minimax/m3',
            'Provider: minimax',
            'Authentication: managed-login',
            'Managed token: present',
            'API key: missing',
            'Warnings: none',
          ].join('\n'),
        },
      },
    });
  });

  it('shows account and model status from Runtime without starting an Agent turn', async () => {
    const { runtime, sendMessage, listModels } = createRuntime([], {
      accountStatus: {
        status: 'ready',
        modelSource: 'token-plan',
        authMode: 'managed-login',
        managedTokenPresent: true,
        warnings: [],
      },
      models: [
        {
          providerId: 'minimax',
          modelId: 'm3',
          displayName: 'MiniMax M3',
          selected: true,
        },
      ],
    });
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'zed' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });

      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '/status' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
    });

    expect(listModels).toHaveBeenCalledWith('session-1');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(updates).toContainEqual({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: [
            'Account status: ready',
            'Model: minimax/m3 (MiniMax M3)',
            'Model source: token-plan',
            'Authentication: managed-login',
            'Managed token: present',
            'Warnings: none',
          ].join('\n'),
        },
      },
    });
  });

  it('keeps the Runtime session identity stable when /new asks for a client thread', async () => {
    const { runtime, createSession, sendMessage } = createRuntime([
      {
        type: 'delta',
        messageId: 'message-after-new',
        role: 'assistant',
        content: 'Same session.',
      },
      { type: 'session-status', status: 'finished' },
    ]);
    createSession.mockResolvedValueOnce({ sessionId: 'session-1', workspaceDir: '/workspace' });
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-after-new',
    });
    const client = acp
      .client({ name: 'zed' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      expect(session.sessionId).toBe('session-1');

      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '/new later' }],
        }),
      ).rejects.toThrow('Use `/new` without arguments.');

      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '/new' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Continue in the existing session' }],
        }),
      ).resolves.toMatchObject({ stopReason: 'end_turn' });
    });

    expect(createSession).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      {
        id: 'session-1',
        turnId: 'turn-after-new',
        content: 'Continue in the existing session',
      },
      expect.any(AbortSignal),
    );
    expect(updates).toContainEqual({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Start a new thread in your ACP client to begin a fresh session.',
        },
      },
    });
  });

  it('rejects an unknown model locally without starting an Agent turn', async () => {
    const { runtime, sendMessage, selectModel } = createRuntime([], {
      models: [{ providerId: 'minimax', modelId: 'm3' }],
    });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'zed' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });

      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '/model custom/missing' }],
        }),
      ).rejects.toThrow('Unknown model custom/missing');
    });

    expect(selectModel).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejects an unsupported model variant locally', async () => {
    const { runtime, sendMessage, selectModel } = createRuntime([], {
      models: [
        {
          providerId: 'minimax',
          modelId: 'm3',
          supportedVariants: ['low', 'high'],
        },
      ],
    });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'zed' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });

      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '/model minimax/m3#turbo' }],
        }),
      ).rejects.toThrow('Unknown variant turbo for minimax/m3');
    });

    expect(selectModel).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps unadvertised slash text as an ordinary Runtime prompt', async () => {
    const { runtime, sendMessage, listModels } = createRuntime([
      {
        type: 'delta',
        messageId: 'message-unknown-command',
        role: 'assistant',
        content: 'Handled as a prompt.',
      },
      { type: 'session-status', status: 'finished' },
    ]);
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-unknown-command',
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });

      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '/not-advertised keep this' }],
        }),
      ).resolves.toMatchObject({ stopReason: 'end_turn' });
    });

    // Session control and Prompt result facts read the catalog; no /model command handler ran.
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(
      {
        id: 'session-1',
        turnId: 'turn-unknown-command',
        content: '/not-advertised keep this',
      },
      expect.any(AbortSignal),
    );
  });

  it('keeps ACP Session creation in standard mode and runs a prompt through the local Runtime', async () => {
    const { runtime, createSession, sendMessage } = createRuntime([
      {
        type: 'delta',
        messageId: 'message-1',
        role: 'assistant',
        content: 'Done.',
      },
      { type: 'session-status', status: 'finished' },
    ]);
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-1',
    });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      });

    await client.connectWith(agent, async (connection) => {
      const initialized = await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { auth: { terminal: true } },
        clientInfo: { name: 'test-client', version: '0.1.0' },
      });
      expect(initialized).toEqual({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: {
            http: true,
            sse: true,
          },
          promptCapabilities: {
            image: true,
            audio: false,
            embeddedContext: false,
          },
          sessionCapabilities: {
            list: {},
            fork: {},
            resume: {},
            close: {},
          },
        },
        authMethods: ACP_AUTH_METHODS,
        agentInfo: { name: 'minimax-code', title: 'MiniMax Code', version: '1.2.3' },
        _meta: {
          'minimax-code/extensions': {
            version: 1,
            methods: expect.arrayContaining([
              'session/activate',
              'mcode/session/steer',
              'mcode/session/goal/create',
              'mcode/session/delegation/get',
            ]),
            notifications: [
              'mcode/session/current_session_update',
              'mcode/session/queue_update',
              'mcode/session/goal_update',
              'mcode/session/delegation_update',
            ],
          },
        },
      });

      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      expect(session).toMatchObject({
        sessionId: 'session-1',
        modes: { currentModeId: 'default' },
        configOptions: expect.arrayContaining([expect.objectContaining({ id: 'permissionMode' })]),
      });

      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [
            { type: 'text', text: 'Fix it' },
            {
              type: 'resource_link',
              name: 'README',
              uri: 'file:///workspace/README.md',
            },
          ],
        }),
      ).resolves.toMatchObject({ stopReason: 'end_turn' });
    });

    expect(createSession).toHaveBeenCalledWith({ workspaceDir: '/workspace', sessionId: 'session-1' });
    expect(sendMessage).toHaveBeenCalledWith(
      {
        id: 'session-1',
        turnId: 'turn-1',
        content: 'Fix it\n\nReferenced resource: README (file:///workspace/README.md)',
      },
      expect.any(AbortSignal),
    );
    expect(updates).toEqual([
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'message-1',
          content: { type: 'text', text: 'Done.' },
        },
      },
    ]);
  });

  it('keeps the Prompt open for a delivery Turn that starts after the admitted Turn', async () => {
    // Defect measured on 0.7.4 with acpx 0.11.2: a background Task finished after the
    // admitted Turn, the Runtime steered a delivery Turn into the session 33-40 s later, and
    // `session/prompt` had already returned `end_turn` at 5.8 s with only "STARTED".
    const harness = createRuntime([
      { type: 'delta', messageId: 'message-1', role: 'assistant', content: 'STARTED' },
      { type: 'session-status', status: 'finished' },
    ]);
    let deliveryFollowed = false;
    let reads = 0;
    const getSessionActivity = vi.fn(async (rootSessionId: string) => {
      reads += 1;
      if (deliveryFollowed) return { state: SessionActivityState.Idle, items: [] };
      // The background sub-Agent first waits on a permission the Client is answering.
      if (reads === 1) {
        return {
          state: SessionActivityState.WaitingForUser,
          items: [
            {
              kind: SessionActivityKind.BackgroundTask,
              sessionId: rootSessionId,
              refId: 'task-1',
              status: 'running',
              detail: 'subagent:background',
            },
            {
              kind: SessionActivityKind.Permission,
              sessionId: 'session-child',
              refId: 'permission-1',
            },
          ],
        };
      }
      return {
        state: SessionActivityState.Running,
        items: [
          {
            kind: SessionActivityKind.Turn,
            sessionId: rootSessionId,
            refId: 'turn-delivery',
            status: 'turn',
          },
        ],
      };
    });
    const watchSessionTurn = vi.fn((_sessionId: string, turnId: string) =>
      (async function* deliveryEvents() {
        deliveryFollowed = turnId === 'turn-delivery';
        yield {
          type: 'delta',
          messageId: 'message-2',
          role: 'assistant',
          content: 'Background task finished.',
        } as const;
        yield { type: 'session-status', status: 'finished' } as const;
      })(),
    );
    Object.assign(harness.runtime, { getSessionActivity, watchSessionTurn });
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({
      runtime: harness.runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-1',
      settle: { pollMs: 1 },
    });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const response = await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Start it in the background' }],
      });
      expect(response).toMatchObject({
        stopReason: 'end_turn',
        _meta: { 'minimax-code/turn': { continuationTurnIds: ['turn-delivery'] } },
      });
    });

    expect(watchSessionTurn).toHaveBeenCalledWith(
      'session-1',
      'turn-delivery',
      expect.any(AbortSignal),
    );
    expect(
      updates.map((notification) =>
        notification.update.sessionUpdate === 'agent_message_chunk' &&
        notification.update.content.type === 'text'
          ? notification.update.content.text
          : undefined,
      ),
    ).toEqual(expect.arrayContaining(['STARTED', 'Background task finished.']));
  });

  it('keeps the Prompt open while a delivery Turn question is answered and its continuation admitted', async () => {
    // The Runtime records an answer before it admits the continuation Turn, so for that
    // moment the activity snapshot reads Idle; ending there would drop the continuation.
    const { runtime, emitRuntimeEvent, replyQuestionnaire } = createRuntime([
      { type: 'delta', messageId: 'message-1', role: 'assistant', content: 'STARTED' },
      { type: 'session-status', status: 'finished' },
    ]);
    let deliveryFollowed = false;
    let answered = false;
    let idleReads = 0;
    let idleTwice: (() => void) | undefined;
    const readIdleTwice = new Promise<void>((resolve) => {
      idleTwice = resolve;
    });
    const getSessionActivity = vi.fn(async (rootSessionId: string) => {
      if (!deliveryFollowed) {
        return {
          state: SessionActivityState.Running,
          items: [
            {
              kind: SessionActivityKind.Turn,
              sessionId: rootSessionId,
              refId: 'turn-delivery',
              status: 'turn',
            },
          ],
        };
      }
      if (!answered) {
        return {
          state: SessionActivityState.WaitingForUser,
          items: [
            {
              kind: SessionActivityKind.Questionnaire,
              sessionId: rootSessionId,
              refId: 'questionnaire-delivery',
            },
          ],
        };
      }
      idleReads += 1;
      if (idleReads === 2) idleTwice?.();
      return { state: SessionActivityState.Idle, items: [] };
    });
    const watchSessionTurn = vi.fn((_sessionId: string, turnId: string) =>
      (async function* followedTurnEvents() {
        if (turnId === 'turn-delivery') {
          deliveryFollowed = true;
          emitRuntimeEvent({
            type: 'questionnaire.ask',
            timestampMs: 1,
            source: 'runtime',
            sessionId: 'session-1',
            agentName: 'mcode',
            request: {
              schemaVersion: 1,
              id: 'questionnaire-delivery',
              title: 'Choose an approach',
              requester: { sessionId: 'session-1', agentName: 'mcode' },
              presentation: {
                replaceComposer: false,
                showProgress: false,
                allowBackNavigation: false,
              },
              steps: [
                {
                  id: 'approach',
                  question: 'Which approach?',
                  selectionMode: 'single',
                  options: [{ id: 'safe', label: 'Safe' }],
                  allowOther: false,
                  otherPlaceholder: '',
                  required: true,
                },
              ],
            },
          });
        } else {
          yield {
            type: 'delta',
            messageId: 'continued-tool',
            role: 'assistant',
            toolCalls: [
              {
                id: 'continued-edit',
                name: 'edit_file',
                input: { path: 'README.md' },
                status: 'completed',
              },
            ],
          } as const;
          yield {
            type: 'delta',
            messageId: 'message-3',
            role: 'assistant',
            content: 'Continuing after your answer.',
          } as const;
        }
        yield { type: 'session-status', status: 'finished' } as const;
      })(),
    );
    vi.mocked(replyQuestionnaire).mockImplementation(async () => {
      answered = true;
      // Admit the continuation only after the Prompt has read the Idle gap twice.
      await readIdleTwice;
      emitRuntimeEvent({
        type: 'session.start',
        timestampMs: 2,
        source: 'runtime',
        sessionId: 'session-1',
        turnId: 'turn-continued',
        queueItemIds: [],
      });
      return true;
    });
    Object.assign(runtime, { getSessionActivity, watchSessionTurn });
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-1',
      settle: { pollMs: 1 },
    });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params))
      .onRequest(acp.methods.client.elicitation.create, () => ({
        action: 'accept',
        content: { approach: 'safe' },
      }));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { elicitation: { form: {} } },
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Start it in the background' }],
        }),
      ).resolves.toMatchObject({
        stopReason: 'end_turn',
        _meta: {
          'minimax-code/turn': { continuationTurnIds: ['turn-delivery', 'turn-continued'] },
        },
      });
    });

    expect(replyQuestionnaire).toHaveBeenCalledOnce();
    expect(updates).toContainEqual({
      sessionId: 'session-1',
      update: expect.objectContaining({
        sessionUpdate: 'tool_call',
        toolCallId: 'continued-edit',
        name: 'edit_file',
        status: 'completed',
      }),
    });
    expect(updates).toContainEqual({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-3',
        content: { type: 'text', text: 'Continuing after your answer.' },
      },
    });
  });

  it('waits for a hidden continuation Turn before admitting the next ACP prompt', async () => {
    const { runtime, getActiveRun, steer } = createRuntime([
      {
        type: 'delta',
        messageId: 'message-initial',
        role: 'assistant',
        content: 'Initial answer.',
      },
      { type: 'session-status', status: 'finished' },
    ]);
    let hiddenActive = false;
    let hiddenWatchStarted = false;
    let releaseHiddenContinuation!: () => void;
    const hiddenContinuationGate = new Promise<void>((resolve) => {
      releaseHiddenContinuation = resolve;
    });
    let turnSequence = 0;
    getActiveRun.mockImplementation(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      state: hiddenActive ? ('running' as const) : ('idle' as const),
      ...(hiddenActive ? { turnId: 'turn-hidden' } : {}),
      actions: { steer: hiddenActive },
    }));
    vi.mocked(runtime.sendMessage).mockImplementation((request) =>
      (async function* promptEvents() {
        if (hiddenActive && request.content === 'After the questionnaire') {
          throw new TuiFailure('runtime', 'Session already has an active Turn.', {
            code: 'local_session_busy',
            retryable: true,
          });
        }
        yield {
          type: 'delta',
          messageId:
            request.content === 'After the questionnaire' ? 'message-next' : 'message-initial',
          role: 'assistant',
          content:
            request.content === 'After the questionnaire' ? 'Next answer.' : 'Initial answer.',
        } as const;
        yield { type: 'session-status', status: 'finished', turnId: request.turnId } as const;
      })(),
    );
    vi.mocked(runtime.watchSessionTurn).mockImplementation((_sessionId, turnId) =>
      (async function* hiddenContinuation() {
        expect(turnId).toBe('turn-hidden');
        hiddenWatchStarted = true;
        await hiddenContinuationGate;
        hiddenActive = false;
        yield {
          type: 'delta',
          messageId: 'hidden-tool',
          role: 'assistant',
          toolCalls: [
            {
              id: 'hidden-edit',
              name: 'edit_file',
              input: { path: 'README.md' },
              status: 'completed',
            },
          ],
        } as const;
        yield { type: 'session-status', status: 'finished', turnId } as const;
      })(),
    );
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => `turn-prompt-${++turnSequence}`,
    });
    const updates: acp.SessionNotification[] = [];
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Initial prompt' }],
      });
      hiddenActive = true;

      let nextPromptSettled = false;
      const nextPrompt = connection
        .request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'After the questionnaire' }],
        })
        .then((response) => {
          nextPromptSettled = true;
          return response;
        });
      await vi.waitFor(() => expect(hiddenWatchStarted).toBe(true));
      expect(nextPromptSettled).toBe(false);
      releaseHiddenContinuation();
      await expect(nextPrompt).resolves.toMatchObject({ stopReason: 'end_turn' });
    });

    expect(runtime.watchSessionTurn).toHaveBeenCalledWith(
      'session-1',
      'turn-hidden',
      expect.any(AbortSignal),
    );
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(steer).not.toHaveBeenCalled();
  });

  it('rejects steer sent while the cancelled prompt is stopping with a retryable error instead of queueing', async () => {
    const { runtime, getActiveRun, abortSession, enqueueMessage, steer } = createRuntime();
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    // session/cancel stops the Turn with user_stop; the run stays open until the test releases it,
    // so the ACP prompt is deterministically in its stopping state when the steer arrives.
    abortSession.mockImplementation(async () => true);
    getActiveRun.mockResolvedValue({
      schemaVersion: 1,
      sessionId: 'session-1',
      state: 'running',
      turnId: 'turn-1',
      actions: { steer: false },
    });
    const sent: string[] = [];
    vi.mocked(runtime.sendMessage).mockImplementation((request) =>
      (async function* promptEvents() {
        sent.push(request.content);
        yield {
          type: 'delta',
          messageId: 'message-running',
          role: 'assistant',
          content: 'Working.',
        } as const;
        await runGate;
        yield { type: 'session-status', status: 'aborted', turnId: request.turnId } as const;
      })(),
    );
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-1',
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const prompt = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Keep working' }],
      });
      await vi.waitFor(() => expect(sent).toEqual(['Keep working']));
      await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      await vi.waitFor(() => expect(abortSession).toHaveBeenCalled());
      const outcome = await settledOutcome(
        connection.request('mcode/session/steer', {
          sessionId: session.sessionId,
          text: 'Preserve this follow-up',
        }),
      );
      releaseRun();
      await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });

      expect(outcome).toMatchObject({
        code: -32603,
        data: { code: 'local_session_busy', retryable: true, reason: 'prompt-turn-stopping' },
      });
      expect(String((outcome as Error).message)).toContain('Session already has an active Turn');
    });

    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
  });

  it('keeps the questionnaire Prompt open until its continuation Turn ends and streams that Turn', async () => {
    const { runtime, emitRuntimeEvent, replyQuestionnaire } = createRuntime();
    vi.mocked(runtime.sendMessage).mockImplementation(() =>
      (async function* questionnaireRunEvents() {
        yield {
          type: 'generic',
          eventType: 'runtime.action-required',
          data: { kind: 'questionnaire' },
          turnId: 'turn-1',
        } as const;
      })(),
    );
    vi.mocked(replyQuestionnaire).mockImplementation(async () => {
      emitRuntimeEvent({
        type: 'session.start',
        timestampMs: 2,
        source: 'runtime',
        sessionId: 'session-1',
        turnId: 'turn-2',
        queueItemIds: [],
      });
      return true;
    });
    let releaseContinuation!: () => void;
    const continuationGate = new Promise<void>((resolve) => {
      releaseContinuation = resolve;
    });
    vi.mocked(runtime.watchSessionTurn).mockImplementation((_sessionId, turnId) =>
      (async function* continuedTurnEvents() {
        expect(turnId).toBe('turn-2');
        yield {
          type: 'delta',
          messageId: 'continued-tool',
          role: 'assistant',
          toolCalls: [
            {
              id: 'continued-edit',
              name: 'edit_file',
              input: { path: 'README.md' },
              status: 'running',
            },
          ],
        } as const;
        // The continuation Turn is still executing its tool here.
        await continuationGate;
        yield {
          type: 'delta',
          messageId: 'continued-tool',
          role: 'assistant',
          toolCalls: [
            {
              id: 'continued-edit',
              name: 'edit_file',
              input: { path: 'README.md' },
              output: 'edited',
              status: 'completed',
            },
          ],
        } as const;
        emitRuntimeEvent({
          type: 'session.finish',
          timestampMs: 3,
          source: 'runtime',
          sessionId: 'session-1',
          turnId: 'turn-2',
          queueItemIds: [],
        });
        yield { type: 'session-status', status: 'finished' } as const;
      })(),
    );
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-1',
    });
    const timeline: string[] = [];
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        const update = params.update;
        if (
          (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
          update.toolCallId === 'continued-edit'
        ) {
          timeline.push(`${update.sessionUpdate}:${update.status ?? ''}`);
        }
      })
      .onRequest(acp.methods.client.elicitation.create, () => ({
        action: 'accept',
        content: { approach: 'safe' },
      }));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { elicitation: { form: {} } },
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      let promptSettled = false;
      const prompt = connection
        .request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Ask me before editing' }],
        })
        .then((response) => {
          promptSettled = true;
          timeline.push('prompt-response');
          return response;
        });
      await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledOnce());
      emitRuntimeEvent({
        type: 'questionnaire.ask',
        timestampMs: 1,
        source: 'runtime',
        sessionId: 'session-1',
        agentName: 'mcode',
        request: {
          schemaVersion: 1,
          id: 'questionnaire-before-edit',
          title: 'Choose an approach',
          requester: { sessionId: 'session-1', agentName: 'mcode' },
          presentation: {
            replaceComposer: false,
            showProgress: false,
            allowBackNavigation: false,
          },
          steps: [
            {
              id: 'approach',
              question: 'Which approach?',
              selectionMode: 'single',
              options: [{ id: 'safe', label: 'Safe' }],
              allowOther: false,
              otherPlaceholder: '',
              required: true,
            },
          ],
        },
      });

      // The answered questionnaire admitted the continuation Turn and its tool call reached the
      // client, but that Turn has not ended, so the original Prompt must still be open.
      await vi.waitFor(() => expect(timeline).toContain('tool_call:in_progress'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(promptSettled).toBe(false);

      releaseContinuation();
      await expect(prompt).resolves.toMatchObject({
        stopReason: 'end_turn',
        _meta: { 'minimax-code/turn': { turnId: 'turn-1', continuationTurnIds: ['turn-2'] } },
      });
    });

    expect(replyQuestionnaire).toHaveBeenCalledOnce();
    expect(timeline).toEqual([
      'tool_call:in_progress',
      'tool_call_update:completed',
      'prompt-response',
    ]);
  });

  it('retries a prompt once after local_session_busy once the Turn holding the lock settles', async () => {
    const { runtime, getActiveRun } = createRuntime();
    let hiddenActive = false;
    let hiddenWatchStarted = false;
    let releaseHiddenTurn!: () => void;
    const hiddenTurnGate = new Promise<void>((resolve) => {
      releaseHiddenTurn = resolve;
    });
    getActiveRun.mockImplementation(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      state: hiddenActive ? ('running' as const) : ('idle' as const),
      ...(hiddenActive ? { turnId: 'turn-hidden' } : {}),
      actions: { steer: hiddenActive },
    }));
    const attempts: string[] = [];
    vi.mocked(runtime.sendMessage).mockImplementation((request) =>
      (async function* promptEvents() {
        attempts.push(`${request.turnId}:${request.content}`);
        if (request.content === 'Follow up' && attempts.length === 2) {
          // A Runtime-owned Turn took the Session lock after the admission read saw it idle.
          hiddenActive = true;
        }
        if (hiddenActive) {
          throw sessionBusyFailure();
        }
        yield { type: 'session-status', status: 'finished', turnId: request.turnId } as const;
      })(),
    );
    vi.mocked(runtime.watchSessionTurn).mockImplementation((_sessionId, turnId) =>
      (async function* hiddenTurnEvents() {
        expect(turnId).toBe('turn-hidden');
        hiddenWatchStarted = true;
        await hiddenTurnGate;
        hiddenActive = false;
        yield { type: 'session-status', status: 'finished', turnId } as const;
      })(),
    );
    let turnSequence = 0;
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => `turn-prompt-${++turnSequence}`,
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'First' }],
      });

      let followUpSettled = false;
      const followUp = connection
        .request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Follow up' }],
        })
        .then((response) => {
          followUpSettled = true;
          return response;
        });
      await vi.waitFor(() => expect(hiddenWatchStarted).toBe(true));
      expect(followUpSettled).toBe(false);
      expect(attempts).toEqual(['turn-prompt-1:First', 'turn-prompt-2:Follow up']);

      releaseHiddenTurn();
      await expect(followUp).resolves.toMatchObject({ stopReason: 'end_turn' });
    });

    // The rejected admission recorded nothing, so the retry reuses the same Turn id.
    expect(attempts).toEqual([
      'turn-prompt-1:First',
      'turn-prompt-2:Follow up',
      'turn-prompt-2:Follow up',
    ]);
  });

  it('surfaces local_session_busy after one bounded retry instead of retrying forever', async () => {
    const { runtime } = createRuntime();
    const attempts: string[] = [];
    vi.mocked(runtime.sendMessage).mockImplementation((request) =>
      (async function* promptEvents() {
        attempts.push(`${request.turnId}:${request.content}`);
        if (request.content === 'Follow up') {
          // The Runtime keeps rejecting although its active-run view reads idle.
          throw sessionBusyFailure();
        }
        yield { type: 'session-status', status: 'finished', turnId: request.turnId } as const;
      })(),
    );
    let turnSequence = 0;
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => `turn-prompt-${++turnSequence}`,
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'First' }],
      });
      const error = await connection
        .request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Follow up' }],
        })
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
      expect(error).toMatchObject({
        code: -32603,
        data: { code: 'local_session_busy', retryable: true, reason: 'runtime-busy' },
      });
      expect(String((error as Error).message)).toContain('Session already has an active Turn');
    });

    expect(attempts).toEqual([
      'turn-prompt-1:First',
      'turn-prompt-2:Follow up',
      'turn-prompt-2:Follow up',
    ]);
    expect(runtime.watchSessionTurn).not.toHaveBeenCalled();
  });

  it('answers session/cancel for a prompt still waiting for a Runtime Turn to settle', async () => {
    const { runtime, sendMessage, getActiveRun, abortSession } = createRuntime([
      { type: 'session-status', status: 'finished' },
    ]);
    let hiddenActive = false;
    let hiddenWatchStarted = false;
    let releaseHiddenTurn!: () => void;
    const hiddenTurnGate = new Promise<void>((resolve) => {
      releaseHiddenTurn = resolve;
    });
    getActiveRun.mockImplementation(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      state: hiddenActive ? ('running' as const) : ('idle' as const),
      ...(hiddenActive ? { turnId: 'turn-hidden' } : {}),
      actions: { steer: hiddenActive },
    }));
    vi.mocked(runtime.watchSessionTurn).mockImplementation((_sessionId, turnId, signal) =>
      (async function* hiddenTurnEvents() {
        hiddenWatchStarted = true;
        await new Promise<void>((resolve) => {
          void hiddenTurnGate.then(resolve);
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        if (signal.aborted) return;
        hiddenActive = false;
        yield { type: 'session-status', status: 'finished', turnId } as const;
      })(),
    );
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Initial prompt' }],
      });
      hiddenActive = true;

      const waiting = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'After the questionnaire' }],
      });
      await vi.waitFor(() => expect(hiddenWatchStarted).toBe(true));
      await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });

      await expect(waiting).resolves.toEqual({ stopReason: 'cancelled' });
      // Withdrawing the waiting Prompt does not stop the Runtime-owned Turn.
      expect(hiddenActive).toBe(true);
      releaseHiddenTurn();
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(abortSession).not.toHaveBeenCalled();
  });

  it('admits a prompt sent right after cancellation once the Runtime finishes aborting the cancelled Turn', async () => {
    const { runtime, getActiveRun, abortSession } = createRuntime();
    let abortSettling = false;
    let settlementWatched = false;
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let releaseAbortSettlement!: () => void;
    const abortSettlement = new Promise<void>((resolve) => {
      releaseAbortSettlement = resolve;
    });
    abortSession.mockImplementation(async () => {
      // ACP answers `cancelled` once its local run stops; the Runtime keeps the Session lock
      // until the aborted Turn settles (t3code#28383 measured 635 ms).
      abortSettling = true;
      releaseRun();
      return true;
    });
    getActiveRun.mockImplementation(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      state: abortSettling ? ('running' as const) : ('idle' as const),
      ...(abortSettling ? { turnId: 'turn-prompt-1' } : {}),
      actions: { steer: false },
    }));
    const sent: string[] = [];
    vi.mocked(runtime.sendMessage).mockImplementation((request) =>
      (async function* promptEvents() {
        sent.push(request.content);
        if (abortSettling) {
          throw sessionBusyFailure();
        }
        if (request.content === 'Keep working') {
          yield {
            type: 'delta',
            messageId: 'message-running',
            role: 'assistant',
            content: 'Working.',
          } as const;
          await runGate;
          yield { type: 'session-status', status: 'aborted', turnId: request.turnId } as const;
          return;
        }
        yield {
          type: 'delta',
          messageId: 'message-steered',
          role: 'assistant',
          content: 'Using the other approach.',
        } as const;
        yield { type: 'session-status', status: 'finished', turnId: request.turnId } as const;
      })(),
    );
    vi.mocked(runtime.watchSessionTurn).mockImplementation((_sessionId, turnId) =>
      (async function* abortSettlementEvents() {
        expect(turnId).toBe('turn-prompt-1');
        settlementWatched = true;
        await abortSettlement;
        abortSettling = false;
        yield { type: 'session-status', status: 'aborted', turnId } as const;
      })(),
    );
    let turnSequence = 0;
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => `turn-prompt-${++turnSequence}`,
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const cancelled = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Keep working' }],
      });
      await vi.waitFor(() => expect(sent).toEqual(['Keep working']));
      await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      await expect(cancelled).resolves.toMatchObject({ stopReason: 'cancelled' });
      expect(abortSettling).toBe(true);

      // The client steers by sending the next prompt immediately after `cancelled`.
      let steeredSettled = false;
      const steered = connection
        .request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Use the other approach' }],
        })
        .then((response) => {
          steeredSettled = true;
          return response;
        });
      await vi.waitFor(() => expect(settlementWatched).toBe(true));
      expect(steeredSettled).toBe(false);
      expect(sent).toEqual(['Keep working']);

      releaseAbortSettlement();
      await expect(steered).resolves.toMatchObject({ stopReason: 'end_turn' });
    });

    expect(sent).toEqual(['Keep working', 'Use the other approach']);
    expect(abortSession).toHaveBeenCalledWith({
      id: 'session-1',
      turnId: 'turn-prompt-1',
      reason: 'user_stop',
    });
  });

  it('keeps later prompts running after cancel + steer: the settlement gap never pauses the Runtime queue', async () => {
    const { runtime, getActiveRun, abortSession, enqueueMessage, steer } = createRuntime();
    // Minimal model of the Runtime rule: a foreground Turn that settles aborted by user_stop pauses
    // the queue when any item is pending (execution.coordinator.ts terminalQueuePauseCause +
    // turn-priority-fence.ts settledInTransaction), and a paused queue rejects plain direct sends.
    let pendingQueueItems = 0;
    let queuePaused = false;
    let abortSettling = false;
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    enqueueMessage.mockImplementation(async () => {
      pendingQueueItems += 1;
      return { itemId: 'queue-1', position: 1 };
    });
    abortSession.mockImplementation(async () => {
      abortSettling = true;
      releaseRun();
      return true;
    });
    getActiveRun.mockImplementation(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      state: abortSettling ? ('running' as const) : ('idle' as const),
      ...(abortSettling ? { turnId: 'turn-prompt-1' } : {}),
      actions: { steer: false },
    }));
    const settleCancelledTurn = () => {
      abortSettling = false;
      if (pendingQueueItems > 0) queuePaused = true;
    };
    const sent: string[] = [];
    vi.mocked(runtime.sendMessage).mockImplementation((request) =>
      (async function* promptEvents() {
        sent.push(request.content);
        if (queuePaused) {
          throw new TuiFailure('runtime', 'The Session queue is paused.', {
            code: 'local_session_queue_paused',
          });
        }
        if (abortSettling) throw sessionBusyFailure();
        if (request.content === 'Keep working') {
          yield {
            type: 'delta',
            messageId: 'message-running',
            role: 'assistant',
            content: 'Working.',
          } as const;
          await runGate;
          yield { type: 'session-status', status: 'aborted', turnId: request.turnId } as const;
          return;
        }
        yield { type: 'session-status', status: 'finished', turnId: request.turnId } as const;
      })(),
    );
    let turnSequence = 0;
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => `turn-prompt-${++turnSequence}`,
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const cancelled = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Keep working' }],
      });
      await vi.waitFor(() => expect(sent).toEqual(['Keep working']));
      await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      await expect(cancelled).resolves.toMatchObject({ stopReason: 'cancelled' });
      expect(abortSettling).toBe(true);

      // The prompt already answered `cancelled`, but the Runtime still settles its Turn.
      const steerOutcome = await settledOutcome(
        connection.request('mcode/session/steer', {
          sessionId: session.sessionId,
          text: 'Use the other approach',
        }),
      );
      settleCancelledTurn();
      const followUps: unknown[] = [];
      for (const text of ['Use the other approach', 'And keep going']) {
        followUps.push(
          await settledOutcome(
            connection.request(acp.methods.agent.session.prompt, {
              sessionId: session.sessionId,
              prompt: [{ type: 'text', text }],
            }),
          ),
        );
      }

      // Before the fix every later prompt failed with -32603 local_session_queue_paused.
      expect(followUps).toEqual([
        { resolved: expect.objectContaining({ stopReason: 'end_turn' }) },
        { resolved: expect.objectContaining({ stopReason: 'end_turn' }) },
      ]);
      expect(steerOutcome).toMatchObject({
        code: -32603,
        data: { code: 'local_session_busy', retryable: true, reason: 'prompt-turn-settling' },
      });
    });

    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(queuePaused).toBe(false);
    expect(steer).not.toHaveBeenCalled();
    expect(sent).toEqual(['Keep working', 'Use the other approach', 'And keep going']);
  });

  it('does not queue steer behind a running Turn that no ACP prompt of this Session started', async () => {
    const { runtime, getActiveRun, enqueueMessage, steer } = createRuntime([
      { type: 'session-status', status: 'finished' },
    ]);
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-prompt-1',
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'First' }],
      });
      // Another entry (e.g. the desktop app) now runs its own Turn on the same Session.
      getActiveRun.mockResolvedValue({
        schemaVersion: 1,
        sessionId: 'session-1',
        state: 'running',
        turnId: 'turn-desktop',
        actions: { steer: true },
      });
      const outcome = await settledOutcome(
        connection.request('mcode/session/steer', {
          sessionId: session.sessionId,
          text: 'Not part of any ACP prompt',
        }),
      );
      expect(outcome).toMatchObject({ code: -32602 });
    });

    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
  });

  it('does not queue steer when the Runtime runs a different Turn than the active prompt', async () => {
    const { runtime, getActiveRun, enqueueMessage, steer } = createRuntime(
      [{ type: 'delta', messageId: 'message-running', role: 'assistant', content: 'Working.' }],
      { holdRunAfterEvents: true },
    );
    getActiveRun.mockResolvedValue({
      schemaVersion: 1,
      sessionId: 'session-1',
      state: 'running',
      turnId: 'turn-desktop',
      actions: { steer: false },
    });
    steer.mockImplementation(async (input) => {
      const result = { turnId: 'turn-desktop', mode: 'steered' as const };
      await input.preDelivery?.accept(result);
      return result;
    });
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-1',
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const prompt = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Keep working' }],
      });
      await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledOnce());
      const outcome = await settledOutcome(
        connection.request('mcode/session/steer', {
          sessionId: session.sessionId,
          text: 'Belongs to the ACP prompt only',
        }),
      );
      await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });
      expect(outcome).toMatchObject({ code: -32602 });
    });

    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  it('bounds the admission wait for a Runtime Turn and then fails with a retryable busy error', async () => {
    const { runtime, getActiveRun, sendMessage } = createRuntime([
      { type: 'session-status', status: 'finished' },
    ]);
    let hiddenActive = false;
    getActiveRun.mockImplementation(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      state: hiddenActive ? ('running' as const) : ('idle' as const),
      ...(hiddenActive ? { turnId: 'turn-hidden' } : {}),
      actions: { steer: false },
    }));
    // The Runtime Turn never ends while the test runs.
    vi.mocked(runtime.watchSessionTurn).mockImplementation((_sessionId, turnId, signal) =>
      (async function* endlessTurn() {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        if (signal.aborted) return;
        yield { type: 'session-status', status: 'finished', turnId } as const;
      })(),
    );
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      promptAdmission: { maxWaitMs: 50 },
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'First' }],
      });
      hiddenActive = true;
      const next = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Follow up' }],
      });
      const outcome = await outcomeWithin(next, 1_000);
      if (outcome === 'still waiting') {
        await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
        await next.catch(() => undefined);
      }
      expect(outcome).toMatchObject({
        code: -32603,
        data: { code: 'local_session_busy', retryable: true, reason: 'turn-wait-timeout' },
      });
      expect(String((outcome as Error).message)).toContain('Session already has an active Turn');
    });

    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('fails a prompt fast instead of waiting when another MCode process runs the Session Turn', async () => {
    const { runtime, getActiveRun, sendMessage } = createRuntime([
      { type: 'session-status', status: 'finished' },
    ]);
    let foreignActive = false;
    getActiveRun.mockImplementation(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      state: foreignActive ? ('running' as const) : ('idle' as const),
      ...(foreignActive ? { turnId: 'turn-desktop', runningElsewhere: true as const } : {}),
      actions: { steer: false },
    }));
    vi.mocked(runtime.watchSessionTurn).mockImplementation((_sessionId, turnId, signal) =>
      (async function* endlessTurn() {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        if (signal.aborted) return;
        yield { type: 'session-status', status: 'finished', turnId } as const;
      })(),
    );
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'First' }],
      });
      foreignActive = true;
      const next = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Follow up' }],
      });
      const outcome = await outcomeWithin(next, 1_000);
      if (outcome === 'still waiting') {
        await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
        await next.catch(() => undefined);
      }
      expect(outcome).toMatchObject({
        code: -32603,
        data: { code: 'local_session_busy', retryable: true, reason: 'turn-running-elsewhere' },
      });
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(runtime.watchSessionTurn).not.toHaveBeenCalled();
  });

  it('reports a Runtime queue paused by another entry as a recognizable, non-retried prompt error', async () => {
    const { runtime, sendMessage } = createRuntime();
    vi.mocked(runtime.sendMessage).mockImplementation((request) =>
      (async function* promptEvents() {
        await sendMessage(request, new AbortController().signal);
        if (request.content === 'Follow up') {
          // A desktop stop paused the queue over its own pending items; ACP cannot Continue it.
          throw new TuiFailure('runtime', 'The Session queue is paused.', {
            code: 'local_session_queue_paused',
          });
        }
        yield { type: 'session-status', status: 'finished', turnId: request.turnId } as const;
      })(),
    );
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'First' }],
      });
      const outcome = await settledOutcome(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Follow up' }],
        }),
      );
      expect(outcome).toMatchObject({
        code: -32603,
        data: { code: 'local_session_queue_paused', retryable: false },
      });
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('answers cancelled, not a retryable busy error, when session/cancel arrives during the busy retry wait', async () => {
    const { runtime, getActiveRun, abortSession } = createRuntime();
    let hiddenActive = false;
    let retryWaitStarted = false;
    getActiveRun.mockImplementation(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      state: hiddenActive ? ('running' as const) : ('idle' as const),
      ...(hiddenActive ? { turnId: 'turn-hidden' } : {}),
      actions: { steer: false },
    }));
    const sent: string[] = [];
    vi.mocked(runtime.sendMessage).mockImplementation((request) =>
      (async function* promptEvents() {
        sent.push(request.content);
        if (request.content === 'Follow up') {
          // A Runtime-owned Turn took the lock after the fence read the Session idle.
          hiddenActive = true;
          throw sessionBusyFailure();
        }
        yield { type: 'session-status', status: 'finished', turnId: request.turnId } as const;
      })(),
    );
    vi.mocked(runtime.watchSessionTurn).mockImplementation((_sessionId, turnId, signal) =>
      (async function* hiddenTurnEvents() {
        retryWaitStarted = true;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        if (signal.aborted) return;
        yield { type: 'session-status', status: 'finished', turnId } as const;
      })(),
    );
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'First' }],
      });
      const followUp = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Follow up' }],
      });
      // The first send was rejected busy; the prompt now waits for that Turn before retrying.
      await vi.waitFor(() => expect(retryWaitStarted).toBe(true));
      await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      const outcome = await outcomeWithin(followUp, 1_000);
      expect(outcome).toEqual({ resolved: expect.objectContaining({ stopReason: 'cancelled' }) });
    });

    // The cancelled content is not sent again, and the Runtime Turn is not stopped.
    expect(sent).toEqual(['First', 'Follow up']);
    expect(abortSession).not.toHaveBeenCalled();
  });

  it('does not accumulate abort listeners across Runtime Turn re-reads while a prompt waits', async () => {
    const { runtime, getActiveRun, sendMessage } = createRuntime([
      { type: 'session-status', status: 'finished' },
    ]);
    const STALE_READS = 8;
    let waiting = false;
    let reads = 0;
    getActiveRun.mockImplementation(async (sessionId: string) => {
      const running = waiting && ++reads <= STALE_READS;
      return {
        schemaVersion: 1 as const,
        sessionId,
        state: running ? ('running' as const) : ('idle' as const),
        ...(running ? { turnId: 'turn-hidden' } : {}),
        actions: { steer: false },
      };
    });
    // Abort listeners still registered on the wait signal when each re-read round starts.
    const outstandingAtRound: number[] = [];
    let outstanding = 0;
    const instrumented = new WeakSet<AbortSignal>();
    vi.mocked(runtime.watchSessionTurn).mockImplementation((_sessionId, turnId, signal) => {
      if (!instrumented.has(signal)) {
        instrumented.add(signal);
        const add = signal.addEventListener.bind(signal);
        const remove = signal.removeEventListener.bind(signal);
        signal.addEventListener = ((type, listener, listenerOptions) => {
          if (type === 'abort') outstanding += 1;
          add(type, listener, listenerOptions);
        }) as AbortSignal['addEventListener'];
        signal.removeEventListener = ((type, listener, listenerOptions) => {
          if (type === 'abort') outstanding -= 1;
          remove(type, listener, listenerOptions);
        }) as AbortSignal['removeEventListener'];
      }
      outstandingAtRound.push(outstanding);
      // The watch ends at a terminal frame although the Runtime still reports the Turn running.
      return (async function* staleTerminal() {
        yield { type: 'session-status', status: 'finished', turnId } as const;
      })();
    });
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      promptAdmission: { pollIntervalMs: 1, maxPollIntervalMs: 2 },
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'First' }],
      });
      waiting = true;
      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Follow up' }],
        }),
      ).resolves.toMatchObject({ stopReason: 'end_turn' });
    });

    expect(outstandingAtRound).toEqual(Array.from({ length: STALE_READS }, () => 0));
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('spaces Runtime Turn re-reads instead of spinning while a stale Turn stays active', async () => {
    const { runtime, getActiveRun, sendMessage } = createRuntime([
      { type: 'session-status', status: 'finished' },
    ]);
    let waiting = false;
    let readsWhileWaiting = 0;
    getActiveRun.mockImplementation(async (sessionId: string) => {
      if (waiting) readsWhileWaiting += 1;
      return {
        schemaVersion: 1 as const,
        sessionId,
        state: waiting ? ('running' as const) : ('idle' as const),
        ...(waiting ? { turnId: 'turn-hidden' } : {}),
        actions: { steer: false },
      };
    });
    vi.mocked(runtime.watchSessionTurn).mockImplementation((_sessionId, turnId) =>
      (async function* staleTerminal() {
        yield { type: 'session-status', status: 'finished', turnId } as const;
      })(),
    );
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      promptAdmission: { maxWaitMs: 300 },
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'First' }],
      });
      waiting = true;
      const outcome = await settledOutcome(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Follow up' }],
        }),
      );
      expect(outcome).toMatchObject({
        code: -32603,
        data: { code: 'local_session_busy', retryable: true, reason: 'turn-wait-timeout' },
      });
    });

    // Backoff from 25 ms fits about five reads into 300 ms; a 0 ms re-read spins hundreds of times.
    expect(readsWhileWaiting).toBeGreaterThanOrEqual(2);
    expect(readsWhileWaiting).toBeLessThan(15);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('ends a prompt wait promptly when session/cancel arrives between Runtime Turn re-reads', async () => {
    const { runtime, getActiveRun, sendMessage, abortSession } = createRuntime([
      { type: 'session-status', status: 'finished' },
    ]);
    let waiting = false;
    let watchClosed = false;
    getActiveRun.mockImplementation(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      state: waiting ? ('running' as const) : ('idle' as const),
      ...(waiting ? { turnId: 'turn-hidden' } : {}),
      actions: { steer: false },
    }));
    // The watch closes without a terminal frame, so the wait sleeps before its next read.
    vi.mocked(runtime.watchSessionTurn).mockImplementation(() =>
      (async function* closedWatch() {
        watchClosed = true;
        yield { type: 'delta', messageId: 'hidden', role: 'assistant', content: '' } as const;
      })(),
    );
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      promptAdmission: { pollIntervalMs: 10_000, maxPollIntervalMs: 10_000 },
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'First' }],
      });
      waiting = true;
      const followUp = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Follow up' }],
      });
      await vi.waitFor(() => expect(watchClosed).toBe(true));
      await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      await expect(outcomeWithin(followUp, 500)).resolves.toEqual({
        resolved: { stopReason: 'cancelled' },
      });
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(abortSession).not.toHaveBeenCalled();
  });

  it('fails a prompt at once, without waiting for the bound, while the Runtime Turn awaits a decision', async () => {
    const { runtime, getActiveRun, sendMessage } = createRuntime([
      { type: 'session-status', status: 'finished' },
    ]);
    let pendingDecision = false;
    getActiveRun.mockImplementation(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      // A questionnaire or permission request is pending; ACP has no prompt to forward it through.
      state: pendingDecision ? ('decision-blocked' as const) : ('idle' as const),
      ...(pendingDecision ? { turnId: 'turn-hidden' } : {}),
      actions: { steer: false },
    }));
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      promptAdmission: { maxWaitMs: 60_000 },
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'First' }],
      });
      pendingDecision = true;
      const next = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Follow up' }],
      });
      // The bound is 60 s; an answer within 1 s proves the fence did not wait for it.
      const outcome = await outcomeWithin(next, 1_000);
      if (outcome === 'still waiting') {
        await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
        await next.catch(() => undefined);
      }
      expect(outcome).toMatchObject({
        code: -32603,
        data: { code: 'local_session_busy', retryable: false, reason: 'turn-awaiting-decision' },
      });
      expect(String((outcome as Error).message)).toContain(
        'pending question or permission request',
      );
      expect(String((outcome as Error).message)).not.toContain(
        'Session already has an active Turn',
      );
    });

    expect(runtime.watchSessionTurn).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('does not retry a busy prompt once the Turn holding the lock turns out to await a decision', async () => {
    const { runtime, getActiveRun } = createRuntime();
    let pendingDecision = false;
    getActiveRun.mockImplementation(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      state: pendingDecision ? ('decision-blocked' as const) : ('idle' as const),
      ...(pendingDecision ? { turnId: 'turn-hidden' } : {}),
      actions: { steer: false },
    }));
    const attempts: string[] = [];
    vi.mocked(runtime.sendMessage).mockImplementation((request) =>
      (async function* promptEvents() {
        attempts.push(`${request.turnId}:${request.content}`);
        if (request.content === 'Follow up') {
          // A Runtime Turn took the lock after the fence read idle, then asked a questionnaire.
          pendingDecision = true;
          throw sessionBusyFailure();
        }
        yield { type: 'session-status', status: 'finished', turnId: request.turnId } as const;
      })(),
    );
    vi.mocked(runtime.watchSessionTurn).mockImplementation((_sessionId, turnId, signal) =>
      (async function* undecidedTurn() {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        if (signal.aborted) return;
        yield { type: 'session-status', status: 'finished', turnId } as const;
      })(),
    );
    let turnSequence = 0;
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => `turn-prompt-${++turnSequence}`,
      promptAdmission: { maxWaitMs: 60_000 },
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'First' }],
      });
      const next = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Follow up' }],
      });
      const outcome = await outcomeWithin(next, 1_000);
      if (outcome === 'still waiting') {
        await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
        await next.catch(() => undefined);
      }
      expect(outcome).toMatchObject({
        code: -32603,
        data: { code: 'local_session_busy', retryable: false, reason: 'turn-awaiting-decision' },
      });
    });

    // One rejected send and no retry: the Client cannot answer the pending decision.
    expect(attempts).toEqual(['turn-prompt-1:First', 'turn-prompt-2:Follow up']);
    expect(runtime.watchSessionTurn).not.toHaveBeenCalled();
  });

  it('stops waiting for a running Turn as soon as it asks a questionnaire the Client cannot see', async () => {
    const { runtime, getActiveRun, sendMessage } = createRuntime([
      { type: 'session-status', status: 'finished' },
    ]);
    let waiting = false;
    let asked = false;
    getActiveRun.mockImplementation(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      state: !waiting
        ? ('idle' as const)
        : asked
          ? ('decision-blocked' as const)
          : ('running' as const),
      ...(waiting ? { turnId: 'turn-hidden' } : {}),
      actions: { steer: false },
    }));
    // The Turn is running when the fence starts, then asks a questionnaire and never ends.
    vi.mocked(runtime.watchSessionTurn).mockImplementation((_sessionId, turnId, signal) =>
      (async function* turnAsksQuestionnaire() {
        asked = true;
        yield {
          type: 'generic',
          eventType: 'runtime.action-required',
          data: { kind: 'questionnaire' },
          turnId,
        } as const;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      })(),
    );
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      promptAdmission: { maxWaitMs: 60_000 },
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'First' }],
      });
      waiting = true;
      const next = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Follow up' }],
      });
      const outcome = await outcomeWithin(next, 1_000);
      if (outcome === 'still waiting') {
        await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
        await next.catch(() => undefined);
      }
      expect(outcome).toMatchObject({
        code: -32603,
        data: { code: 'local_session_busy', retryable: false, reason: 'turn-awaiting-decision' },
      });
    });

    // The running Turn was watched (it is not treated like a decision from the start).
    expect(runtime.watchSessionTurn).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('stops waiting within one poll round once a running Turn asks a permission request mid-watch', async () => {
    const { runtime, getActiveRun, sendMessage } = createRuntime([
      { type: 'session-status', status: 'finished' },
    ]);
    let waiting = false;
    let watching = false;
    let watchSignal: AbortSignal | undefined;
    getActiveRun.mockImplementation(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      // A permission request has no Turn stream frame: only the Runtime state shows it.
      state: !waiting
        ? ('idle' as const)
        : watching
          ? ('decision-blocked' as const)
          : ('running' as const),
      ...(waiting ? { turnId: 'turn-hidden' } : {}),
      actions: { steer: false },
    }));
    // The Turn is running when the watch starts, then asks a permission request and never ends.
    vi.mocked(runtime.watchSessionTurn).mockImplementation((_sessionId, turnId, signal) =>
      (async function* turnAsksPermission() {
        watching = true;
        watchSignal = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        if (signal.aborted) return;
        yield { type: 'session-status', status: 'finished', turnId } as const;
      })(),
    );
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      promptAdmission: { maxWaitMs: 60_000, pollIntervalMs: 10, maxPollIntervalMs: 50 },
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'First' }],
      });
      waiting = true;
      const next = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Follow up' }],
      });
      // The bound is 60 s and the re-read gap 50 ms; an answer within 1 s proves a re-read saw it.
      const outcome = await outcomeWithin(next, 1_000);
      if (outcome === 'still waiting') {
        await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
        await next.catch(() => undefined);
      }
      expect(outcome).toMatchObject({
        code: -32603,
        data: { code: 'local_session_busy', retryable: false, reason: 'turn-awaiting-decision' },
      });
    });

    // One watch, ended by a Runtime re-read rather than a frame, and torn down afterwards.
    expect(runtime.watchSessionTurn).toHaveBeenCalledOnce();
    expect(watchSignal?.aborted).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('leaves mcode/session/steer to the Runtime instead of queueing while a decision blocks the prompt Turn', async () => {
    const { runtime, getActiveRun, enqueueMessage, steer } = createRuntime(
      [
        {
          type: 'delta',
          messageId: 'message-running',
          role: 'assistant',
          content: 'Waiting for approval.',
        },
      ],
      { holdRunAfterEvents: true },
    );
    // A pending permission or questionnaire makes the Runtime report the Turn
    // decision-blocked, which also closes actions.steer. That is not abort settlement.
    getActiveRun.mockResolvedValue({
      schemaVersion: 1,
      sessionId: 'session-1',
      state: 'decision-blocked',
      turnId: 'turn-1',
      actions: { steer: false },
    });
    steer.mockImplementation(async (input) => {
      const result = { turnId: 'turn-1', mode: 'steered' as const };
      await input.preDelivery?.accept(result);
      return result;
    });
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-1',
    });
    const updates: acp.SessionNotification[] = [];
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const prompt = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Edit the config' }],
      });
      await vi.waitFor(() =>
        expect(updates).toContainEqual({
          sessionId: 'session-1',
          update: expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
        }),
      );
      await expect(
        connection.request('mcode/session/steer', {
          sessionId: session.sessionId,
          text: 'Also update the docs',
        }),
      ).resolves.toEqual({ turnId: 'turn-1', mode: 'steered' });
      await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });
    });

    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(steer).toHaveBeenCalledOnce();
  });

  it('admits consecutive prompts without waiting when the Runtime reports the Session idle', async () => {
    const { runtime, sendMessage } = createRuntime([
      { type: 'delta', messageId: 'message-1', role: 'assistant', content: 'Done.' },
      { type: 'session-status', status: 'finished' },
    ]);
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      for (const text of ['First', 'Second']) {
        await expect(
          connection.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text }],
          }),
        ).resolves.toMatchObject({ stopReason: 'end_turn' });
      }
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(runtime.watchSessionTurn).not.toHaveBeenCalled();
  });

  it('reports Turn usage and MCode Turn facts in the session/prompt response', async () => {
    const message = {
      id: 'assistant-usage',
      turnId: 'turn-usage',
      role: 'assistant' as const,
      content: 'Done',
      finishReason: 'stop',
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        reasoningTokens: 10,
        cacheReadTokens: 80,
        cacheWriteTokens: 5,
      },
    };
    const { runtime, listMessagePage } = createRuntime(
      [
        { type: 'message', message },
        { type: 'session-status', status: 'finished' },
      ],
      {
        models: [
          {
            providerId: 'minimax',
            modelId: 'MiniMax-M3',
            selected: true,
            providerKind: 'builtin',
            apiFormat: 'anthropic',
          },
        ],
      },
    );
    listMessagePage.mockResolvedValue({ messages: [message], hasMore: false } as never);
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-usage',
    });
    await acp.client({ name: 'python-sdk' }).connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });

      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Fix it' }],
        }),
      ).resolves.toEqual({
        stopReason: 'end_turn',
        usage: {
          // ACP total sums every token type: input + output + cache read + cache write.
          totalTokens: 235,
          inputTokens: 120,
          outputTokens: 30,
          thoughtTokens: 10,
          cachedReadTokens: 80,
          cachedWriteTokens: 5,
        },
        _meta: {
          'minimax-code/turn': {
            runId: 'acp_turn-usage',
            turnId: 'turn-usage',
            model: {
              providerId: 'minimax',
              modelId: 'MiniMax-M3',
              providerKind: 'builtin',
              protocol: 'anthropic',
            },
            durationMs: expect.any(Number),
            usageIncomplete: false,
          },
        },
      });
    });
  });

  it('omits ACP usage instead of fabricating token counts the Runtime did not report', async () => {
    const { runtime } = createRuntime(
      [
        {
          type: 'message',
          message: {
            id: 'assistant-partial',
            turnId: 'turn-partial',
            role: 'assistant',
            content: 'Done',
            usage: { inputTokens: 5 },
          },
        },
        { type: 'session-status', status: 'finished' },
      ],
      { models: [{ providerId: 'minimax', modelId: 'MiniMax-M3', selected: true }] },
    );
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-partial',
    });
    await acp.client({ name: 'python-sdk' }).connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });

      const response = await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Fix it' }],
      });
      expect(response).not.toHaveProperty('usage');
      expect(response).toEqual({
        stopReason: 'end_turn',
        _meta: {
          'minimax-code/turn': {
            runId: 'acp_turn-partial',
            turnId: 'turn-partial',
            model: { providerId: 'minimax', modelId: 'MiniMax-M3' },
            durationMs: expect.any(Number),
            usageIncomplete: true,
          },
        },
      });
    });
  });

  it('forwards prompt images to the Runtime as attachments and removes the temporary copies', async () => {
    const { runtime, sendMessage } = createRuntime([
      { type: 'session-status', status: 'finished' },
    ]);
    const png = Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64');
    let deliveredBytes: Buffer | undefined;
    sendMessage.mockImplementationOnce(async () => {
      const [request] = sendMessage.mock.lastCall as unknown as [
        { attachments: [{ local: { filePath: string } }] },
      ];
      deliveredBytes = await readFile(request.attachments[0].local.filePath);
    });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3', createTurnId: () => 'turn-1' });

    await acp.client({ name: 'test-client' }).connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [
            { type: 'text', text: 'Describe this.' },
            { type: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 },
          ],
        }),
      ).resolves.toMatchObject({ stopReason: 'end_turn' });
    });

    expect(sendMessage).toHaveBeenCalledWith(
      {
        id: 'session-1',
        turnId: 'turn-1',
        content: 'Describe this.',
        attachments: [
          {
            meta: {
              attachmentType: 'image',
              fileName: 'image-1.png',
              mimeType: 'image/png',
              sizeBytes: png.byteLength,
            },
            local: { filePath: expect.stringContaining('minimax-code-acp-prompt-') },
          },
        ],
      },
      expect.any(AbortSignal),
    );
    expect(deliveredBytes).toEqual(png);
    const [request] = sendMessage.mock.lastCall as unknown as [
      { attachments: [{ local: { filePath: string } }] },
    ];
    await expect(stat(request.attachments[0].local.filePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    {
      name: 'an unsupported image MIME type',
      block: { type: 'image' as const, mimeType: 'image/svg+xml', data: ONE_PIXEL_PNG_BASE64 },
      message: 'Prompt image MIME type image/svg+xml is not supported',
    },
    {
      name: 'malformed image data',
      block: { type: 'image' as const, mimeType: 'image/png', data: 'not base64!' },
      message: 'Prompt image 1 is not valid base64 data.',
    },
    {
      name: 'more images than the attachment limit',
      blocks: Array.from({ length: 21 }, () => ({
        type: 'image' as const,
        mimeType: 'image/png',
        data: ONE_PIXEL_PNG_BASE64,
      })),
      message: 'A prompt can include at most 20 images.',
    },
    {
      name: 'an audio block',
      block: { type: 'audio' as const, mimeType: 'audio/wav', data: 'AAAA' },
      message: 'Prompt content type audio is not supported.',
    },
  ])('rejects $name without starting a Runtime turn', async (testCase) => {
    const { message } = testCase;
    const blocks: acp.ContentBlock[] = 'blocks' in testCase ? testCase.blocks : [testCase.block];
    const { runtime, sendMessage } = createRuntime();
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3', createTurnId: () => 'turn-1' });

    await acp.client({ name: 'test-client' }).connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Look.' }, ...blocks],
        }),
      ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining(message) });
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('cancels new Sessions without Runtime writes and bounds stalled creation generations', async () => {
    const { runtime, createSession, deleteSession, listModels } = createRuntime();
    listModels.mockImplementation(() => new Promise(() => undefined));
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const cancellations = Array.from({ length: 8 }, () => new AbortController());
      const creations = cancellations.map((cancellation, index) =>
        connection.request(
          acp.methods.agent.session.new,
          { cwd: `/workspace/${index}`, mcpServers: [] },
          { cancellationSignal: cancellation.signal },
        ),
      );
      for (const creation of creations) void creation.catch(() => undefined);
      await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(8));
      for (const cancellation of cancellations) cancellation.abort();
      await Promise.all(creations.map((creation) => expect(creation).rejects.toThrow('cancel')));
      expect(createSession).not.toHaveBeenCalled();
      expect(deleteSession).not.toHaveBeenCalled();

      await expect(
        connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace/overflow',
          mcpServers: [],
        }),
      ).rejects.toThrow('Too many ACP Session creation operations');
      for (let index = 0; index < 8; index += 1) {
        await expect(
          connection.request(acp.methods.agent.session.close, {
            sessionId: `session-${index + 1}`,
          }),
        ).rejects.toThrow();
      }
    });
  });

  it('does not publish a new Session attachment before control initialization commits', async () => {
    const { runtime, deleteSession, listModels } = createRuntime();
    let releaseModels!: () => void;
    listModels.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseModels = () => resolve([]);
        }),
    );
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const creation = connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await vi.waitFor(() => expect(listModels).toHaveBeenCalledOnce());
      await expect(
        connection.request(acp.methods.agent.session.close, { sessionId: 'session-1' }),
      ).rejects.toThrow();

      releaseModels();
      await expect(creation).resolves.toMatchObject({ sessionId: 'session-1' });
      await expect(
        connection.request(acp.methods.agent.session.close, { sessionId: 'session-1' }),
      ).resolves.toEqual({});
    });

    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('serializes resume behind a cancelled new Session reservation', async () => {
    const { runtime, deleteSession, getSession, listModels } = createRuntime();
    listModels.mockImplementationOnce(() => new Promise(() => undefined));
    getSession.mockRejectedValueOnce(new Error('deleted'));
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const cancellation = new AbortController();
      const creation = connection.request(
        acp.methods.agent.session.new,
        { cwd: '/workspace', mcpServers: [] },
        { cancellationSignal: cancellation.signal },
      );
      void creation.catch(() => undefined);
      await vi.waitFor(() => expect(listModels).toHaveBeenCalledOnce());
      const resume = connection.request(acp.methods.agent.session.resume, {
        sessionId: 'session-1',
        cwd: '/workspace',
        mcpServers: [],
      });
      void resume.catch(() => undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(getSession).not.toHaveBeenCalled();

      cancellation.abort();
      await expect(creation).rejects.toThrow('cancel');
      await expect(resume).rejects.toThrow();
      expect(getSession).toHaveBeenCalledWith('session-1');
      // The reservation was never written, so there is nothing to delete.
      expect(deleteSession).not.toHaveBeenCalled();
    });
  });

  it('lists, loads, resumes, and closes persisted Runtime sessions', async () => {
    const {
      runtime,
      configureSessionMcpServers,
      clearSessionMcpServers,
      listSessionPage,
      getSession,
      listMessagePage,
      sendMessage,
    } = createRuntime([
      {
        type: 'delta',
        messageId: 'message-new',
        role: 'assistant',
        content: 'Continued.',
      },
      { type: 'session-status', status: 'finished' },
    ]);
    listSessionPage.mockResolvedValueOnce({
      sessions: [
        {
          sessionId: 'session-existing',
          workspaceDir: '/workspace',
          title: 'Existing chat',
          updatedAt: 1_725_000_000_000,
        },
      ],
      hasMore: true,
      nextCursor: 'cursor-next',
    });
    getSession.mockResolvedValue({
      sessionId: 'session-existing',
      agentName: 'mcode',
      workspaceDir: '/workspace',
    });
    listMessagePage
      .mockResolvedValueOnce({
        messages: [
          {
            id: 'message-assistant',
            role: 'assistant',
            content: 'Earlier answer.',
          },
        ],
        hasMore: true,
        nextCursor: 'message-assistant',
      })
      .mockResolvedValueOnce({
        messages: [
          {
            id: 'message-user',
            role: 'user',
            content: 'Earlier question.',
          },
        ],
        hasMore: false,
      });

    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-loaded',
    });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      await expect(
        connection.request(acp.methods.agent.session.list, {
          cwd: '/workspace',
          cursor: 'cursor-current',
        }),
      ).resolves.toEqual({
        sessions: [
          {
            sessionId: 'session-existing',
            cwd: '/workspace',
            title: 'Existing chat',
            updatedAt: '2024-08-30T06:40:00.000Z',
          },
        ],
        nextCursor: 'cursor-next',
      });

      await expect(
        connection.request(acp.methods.agent.session.load, {
          sessionId: 'session-existing',
          cwd: '/workspace',
          mcpServers: [
            {
              name: 'client-tools',
              command: '/usr/local/bin/client-tools',
              args: ['serve'],
              env: [],
            },
          ],
        }),
      ).resolves.toMatchObject({
        modes: { currentModeId: 'default' },
        configOptions: expect.arrayContaining([expect.objectContaining({ id: 'permissionMode' })]),
      });

      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: 'session-existing',
          prompt: [{ type: 'text', text: 'Continue' }],
        }),
      ).resolves.toMatchObject({ stopReason: 'end_turn' });

      await expect(
        connection.request(acp.methods.agent.session.close, {
          sessionId: 'session-existing',
        }),
      ).resolves.toEqual({});
      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: 'session-existing',
          prompt: [{ type: 'text', text: 'After close' }],
        }),
      ).rejects.toThrow();

      updates.length = 0;
      await expect(
        connection.request(acp.methods.agent.session.resume, {
          sessionId: 'session-existing',
          cwd: '/workspace',
          mcpServers: [],
        }),
      ).resolves.toMatchObject({
        modes: { currentModeId: 'default' },
        configOptions: expect.arrayContaining([expect.objectContaining({ id: 'permissionMode' })]),
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        updates.filter(({ update }) => update.sessionUpdate.endsWith('message_chunk')),
      ).toEqual([]);
    });

    expect(listSessionPage).toHaveBeenCalledWith({
      cursor: 'cursor-current',
      includeArchived: true,
      workspaceDir: '/workspace',
    });
    expect(getSession).toHaveBeenCalledWith('session-existing');
    expect(listMessagePage).toHaveBeenNthCalledWith(1, 'session-existing', { limit: 100 });
    expect(listMessagePage).toHaveBeenNthCalledWith(2, 'session-existing', {
      before: 'message-assistant',
      limit: 100,
    });
    expect(clearSessionMcpServers).toHaveBeenCalledWith('session-existing');
    expect(configureSessionMcpServers).toHaveBeenCalledWith('session-existing', [
      {
        name: 'client-tools',
        type: 'stdio',
        command: '/usr/local/bin/client-tools',
        args: ['serve'],
      },
    ]);
    expect(sendMessage).toHaveBeenCalledWith(
      {
        id: 'session-existing',
        turnId: 'turn-loaded',
        content: 'Continue',
      },
      expect.any(AbortSignal),
    );
  });

  it('replays loaded history in chronological order before advertising commands', async () => {
    const { runtime, getSession, listMessagePage } = createRuntime();
    getSession.mockResolvedValue({
      sessionId: 'session-existing',
      workspaceDir: '/workspace',
    });
    listMessagePage
      .mockResolvedValueOnce({
        messages: [
          { id: 'user-2', role: 'user', content: 'Newest question.' },
          { id: 'assistant-2', role: 'assistant', content: 'Newest answer.' },
        ],
        hasMore: true,
        nextCursor: 'user-2',
      })
      .mockResolvedValueOnce({
        messages: [
          { id: 'user-1', role: 'user', content: 'Oldest question.' },
          { id: 'assistant-1', role: 'assistant', content: 'Oldest answer.' },
        ],
        hasMore: false,
      });
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await connection.request(acp.methods.agent.session.load, {
        sessionId: 'session-existing',
        cwd: '/workspace',
        mcpServers: [],
      });
    });

    expect(
      updates
        .filter(({ update }) => update.sessionUpdate.endsWith('message_chunk'))
        .map(({ update }) => ({
          kind: update.sessionUpdate,
          text: 'content' in update && update.content.type === 'text' ? update.content.text : '',
        })),
    ).toEqual([
      { kind: 'user_message_chunk', text: 'Oldest question.' },
      { kind: 'agent_message_chunk', text: 'Oldest answer.' },
      { kind: 'user_message_chunk', text: 'Newest question.' },
      { kind: 'agent_message_chunk', text: 'Newest answer.' },
    ]);
  });

  it('replays image attachments of loaded user messages and keeps unavailable images visible', async () => {
    const { runtime, getSession, listMessagePage } = createRuntime();
    const assetDirectory = await mkdtemp(join(tmpdir(), 'acp-history-image-'));
    const imagePath = join(assetDirectory, 'image-1.png');
    await writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));
    const image = { type: 'image' as const, fileName: 'image-1.png', mimeType: 'image/png' };
    getSession.mockResolvedValue({ sessionId: 'session-existing', workspaceDir: '/workspace' });
    listMessagePage.mockResolvedValue({
      messages: [
        {
          id: 'image-only',
          role: 'user',
          content: '',
          attachments: [{ ...image, filePath: imagePath }],
        },
        {
          id: 'image-caption',
          role: 'user',
          content: 'Describe this.',
          attachments: [
            { ...image, filePath: imagePath },
            { ...image, fileName: 'gone.png', filePath: join(assetDirectory, 'gone.png') },
          ],
        },
      ],
      hasMore: false,
    });
    const updates: acp.SessionNotification[] = [];
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    try {
      await client.connectWith(
        createTuiAcpAgent({ runtime, version: '1.2.3' }),
        async (connection) => {
          await connection.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          await connection.request(acp.methods.agent.session.load, {
            sessionId: 'session-existing',
            cwd: '/workspace',
            mcpServers: [],
          });
        },
      );
    } finally {
      await rm(assetDirectory, { recursive: true, force: true });
    }

    const pngImage = { type: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 };
    expect(
      updates
        .map(({ update }) => update)
        .filter((update) => update.sessionUpdate === 'user_message_chunk'),
    ).toEqual([
      { sessionUpdate: 'user_message_chunk', messageId: 'image-only', content: pngImage },
      {
        sessionUpdate: 'user_message_chunk',
        messageId: 'image-caption',
        content: { type: 'text', text: 'Describe this.' },
      },
      { sessionUpdate: 'user_message_chunk', messageId: 'image-caption', content: pngImage },
      {
        sessionUpdate: 'user_message_chunk',
        messageId: 'image-caption',
        content: { type: 'text', text: '[Image: gone.png]' },
      },
    ]);
  });

  it('stops old history work after close and reattachment', async () => {
    const { runtime, listMessagePage } = createRuntime();
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    listMessagePage
      .mockResolvedValueOnce({
        messages: [{ id: 'old-2', role: 'user', content: 'Second old message.' }],
        hasMore: true,
        nextCursor: 'older',
      })
      .mockImplementationOnce(async () => {
        await historyGate;
        return {
          messages: [{ id: 'old-1', role: 'user', content: 'First old message.' }],
          hasMore: false,
        };
      });
    const replayed: string[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, async ({ params }) => {
        if (
          params.update.sessionUpdate !== 'user_message_chunk' ||
          params.update.content.type !== 'text'
        ) {
          return;
        }
        replayed.push(params.update.content.text);
      });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const load = connection.request(acp.methods.agent.session.load, {
        sessionId: 'session-existing',
        cwd: '/workspace',
        mcpServers: [],
      });
      void load.catch(() => undefined);
      await vi.waitFor(() => expect(listMessagePage).toHaveBeenCalledTimes(2));
      await connection.request(acp.methods.agent.session.close, {
        sessionId: 'session-existing',
      });
      await connection.request(acp.methods.agent.session.resume, {
        sessionId: 'session-existing',
        cwd: '/workspace',
        mcpServers: [],
      });
      releaseHistory();
      await expect(load).rejects.toThrow('cancelled');
    });

    expect(replayed).toEqual([]);
  });

  it('cancels active work and releases session-scoped resources on close', async () => {
    const { runtime, sendMessage, abortSession, clearSessionMcpServers } = createRuntime([], {
      holdRunUntilAbort: true,
    });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const prompt = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Keep working' }],
      });
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

      await expect(
        connection.request(acp.methods.agent.session.close, {
          sessionId: session.sessionId,
        }),
      ).resolves.toEqual({});
      await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });
    });

    expect(abortSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1', reason: 'user_stop' }),
    );
    expect(clearSessionMcpServers).toHaveBeenCalledWith('session-1');
  });

  it('serializes close, resume, and prompt admission for the same Session', async () => {
    const { runtime, clearSessionMcpServers, getSession, sendMessage } = createRuntime([
      { type: 'delta', messageId: 'message-1', role: 'assistant', content: 'Attached.' },
      { type: 'session-status', status: 'finished' },
    ]);
    let releaseCloseCleanup!: () => void;
    const closeCleanup = new Promise<void>((resolve) => {
      releaseCloseCleanup = resolve;
    });
    clearSessionMcpServers.mockImplementationOnce(() => closeCleanup).mockResolvedValue(undefined);
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await newRuntimeSession(connection, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const close = connection.request(acp.methods.agent.session.close, {
        sessionId: session.sessionId,
      });
      await vi.waitFor(() => expect(clearSessionMcpServers).toHaveBeenCalledOnce());

      const resume = connection.request(acp.methods.agent.session.resume, {
        sessionId: session.sessionId,
        cwd: '/workspace',
        mcpServers: [],
      });
      const prompt = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Use the replacement attachment' }],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(getSession).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();

      releaseCloseCleanup();
      await expect(close).resolves.toEqual({});
      await expect(resume).resolves.toMatchObject({ modes: { currentModeId: 'default' } });
      await expect(prompt).resolves.toMatchObject({ stopReason: 'end_turn' });
    });

    expect(clearSessionMcpServers).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('consumes cancel while a Prompt is waiting for Session admission', async () => {
    const { runtime, getSession, sendMessage } = createRuntime();
    let releaseConfiguration!: (session: {
      sessionId: string;
      workspaceDir: string;
      interactionMode: 'default';
    }) => void;
    getSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseConfiguration = resolve;
        }),
    );
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await newRuntimeSession(connection, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const configuration = connection.request(acp.methods.agent.session.setMode, {
        sessionId: session.sessionId,
        modeId: 'plan',
      });
      await vi.waitFor(() => expect(getSession).toHaveBeenCalledOnce());
      const prompt = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Do not start after cancellation' }],
      });
      await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      await new Promise<void>((resolve) => setImmediate(resolve));

      releaseConfiguration({
        sessionId: 'session-1',
        workspaceDir: '/workspace',
        interactionMode: 'default',
      });
      await expect(configuration).resolves.toEqual({
        _meta: { 'minimax-code/transition': 'next_prompt' },
      });
      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('consumes JSON-RPC cancellation while a Prompt is waiting for Session admission', async () => {
    const { runtime, getSession, requestCompaction, sendMessage } = createRuntime();
    let releaseConfiguration!: (session: {
      sessionId: string;
      workspaceDir: string;
      interactionMode: 'default';
    }) => void;
    getSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseConfiguration = resolve;
        }),
    );
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await newRuntimeSession(connection, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const configuration = connection.request(acp.methods.agent.session.setMode, {
        sessionId: session.sessionId,
        modeId: 'plan',
      });
      await vi.waitFor(() => expect(getSession).toHaveBeenCalledOnce());
      const cancellation = new AbortController();
      const prompt = connection.request(
        acp.methods.agent.session.prompt,
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '/compact' }],
        },
        { cancellationSignal: cancellation.signal },
      );
      cancellation.abort();
      releaseConfiguration({
        sessionId: 'session-1',
        workspaceDir: '/workspace',
        interactionMode: 'default',
      });

      await expect(configuration).resolves.toEqual({
        _meta: { 'minimax-code/transition': 'next_prompt' },
      });
      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
    });

    expect(requestCompaction).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('lets close clean up MCP state while a loaded history page is stalled', async () => {
    const { runtime, clearSessionMcpServers, getSession, listMessagePage } = createRuntime();
    getSession.mockResolvedValue({
      sessionId: 'session-existing',
      workspaceDir: '/workspace',
    });
    listMessagePage.mockImplementation(() => new Promise(() => undefined));
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const load = connection.request(acp.methods.agent.session.load, {
        sessionId: 'session-existing',
        cwd: '/workspace',
        mcpServers: [],
      });
      void load.catch(() => undefined);
      await vi.waitFor(() => expect(listMessagePage).toHaveBeenCalledOnce());

      await expect(
        connection.request(acp.methods.agent.session.close, {
          sessionId: 'session-existing',
        }),
      ).resolves.toEqual({});
      await vi.waitFor(() => expect(clearSessionMcpServers).toHaveBeenCalledTimes(2));
    });
  });

  it('bounds repeatedly detached lifecycle generations for one Session', async () => {
    const { runtime, listMessagePage } = createRuntime();
    listMessagePage.mockImplementation(() => new Promise(() => undefined));
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      for (let generation = 0; generation < 2; generation += 1) {
        const load = connection.request(acp.methods.agent.session.load, {
          sessionId: 'session-existing',
          cwd: '/workspace',
          mcpServers: [],
        });
        void load.catch(() => undefined);
        await vi.waitFor(() => expect(listMessagePage).toHaveBeenCalledTimes(generation + 1));
        await connection.request(acp.methods.agent.session.close, {
          sessionId: 'session-existing',
        });
      }

      await expect(
        connection.request(acp.methods.agent.session.load, {
          sessionId: 'session-existing',
          cwd: '/workspace',
          mcpServers: [],
        }),
      ).rejects.toThrow('Too many cancelled ACP Session operations');
    });

    expect(listMessagePage).toHaveBeenCalledTimes(2);
  });

  it('bounds normally queued lifecycle operations for one stalled Session', async () => {
    const { runtime, getSession } = createRuntime();
    getSession.mockImplementation(() => new Promise(() => undefined));
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await newRuntimeSession(connection, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const admitted = Array.from({ length: 64 }, () =>
        connection.request(acp.methods.agent.session.setMode, {
          sessionId: session.sessionId,
          modeId: 'plan',
        }),
      );
      for (const request of admitted) void request.catch(() => undefined);
      await vi.waitFor(() => expect(getSession).toHaveBeenCalledOnce());

      await expect(
        connection.request(acp.methods.agent.session.setMode, {
          sessionId: session.sessionId,
          modeId: 'plan',
        }),
      ).rejects.toThrow('Too many ACP Session operations');
      await connection.request(acp.methods.agent.session.close, {
        sessionId: session.sessionId,
      });
    });
  });

  it('lets close return while an ACP command is stalled before Prompt admission', async () => {
    const { runtime, requestCompaction } = createRuntime();
    requestCompaction.mockImplementation(() => new Promise(() => undefined));
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const command = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '/compact' }],
      });
      void command.catch(() => undefined);
      await vi.waitFor(() => expect(requestCompaction).toHaveBeenCalledOnce());

      await expect(
        connection.request(acp.methods.agent.session.close, {
          sessionId: session.sessionId,
        }),
      ).resolves.toEqual({});
    });
  });

  it('detaches a Session when replacing its MCP overlay fails', async () => {
    const { runtime, getSession, configureSessionMcpServers, clearSessionMcpServers } =
      createRuntime();
    getSession.mockResolvedValue({
      sessionId: 'session-1',
      workspaceDir: '/workspace',
    });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await newRuntimeSession(connection, {
        cwd: '/workspace',
        mcpServers: [
          {
            name: 'old-tools',
            command: '/usr/local/bin/old-tools',
            args: [],
            env: [],
          },
        ],
      });
      configureSessionMcpServers.mockRejectedValueOnce(new Error('MCP configuration failed'));

      await expect(
        connection.request(acp.methods.agent.session.resume, {
          sessionId: session.sessionId,
          cwd: '/workspace',
          mcpServers: [
            {
              name: 'new-tools',
              command: '/usr/local/bin/new-tools',
              args: [],
              env: [],
            },
          ],
        }),
      ).rejects.toThrow();
      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Must remain detached' }],
        }),
      ).rejects.toThrow();
    });

    expect(clearSessionMcpServers).toHaveBeenCalledTimes(2);
    // Once when the Session was created, once for the failed resume overlay.
    expect(configureSessionMcpServers).toHaveBeenCalledTimes(2);
  });

  it('detaches immediately when MCP recovery cleanup remains stalled', async () => {
    const {
      runtime,
      configureSessionMcpServers,
      clearSessionMcpServers,
      emitRuntimeEvent,
      replyPermission,
    } = createRuntime();
    configureSessionMcpServers.mockRejectedValueOnce(new Error('MCP configuration failed'));
    clearSessionMcpServers
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise(() => undefined));
    const permissionRequest = vi.fn(() => ({
      outcome: { outcome: 'selected' as const, optionId: 'allow-once' },
    }));
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onRequest(acp.methods.client.session.requestPermission, permissionRequest);

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const resume = connection.request(acp.methods.agent.session.resume, {
        sessionId: session.sessionId,
        cwd: '/workspace',
        mcpServers: [
          {
            name: 'broken-tools',
            command: '/usr/local/bin/broken-tools',
            args: [],
            env: [],
          },
        ],
      });
      void resume.catch(() => undefined);
      await vi.waitFor(() => expect(clearSessionMcpServers).toHaveBeenCalledTimes(2));

      await expect(
        connection.request<{ sessionId: string }, { sessionId: string }>('session/activate', {
          sessionId: session.sessionId,
        }),
      ).rejects.toThrow();
      emitRuntimeEvent(permissionEvent('permission-after-mcp-failure'));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(permissionRequest).not.toHaveBeenCalled();
    expect(replyPermission).not.toHaveBeenCalled();
  });

  it('detaches immediately when initial MCP clear recovery remains stalled', async () => {
    const { runtime, clearSessionMcpServers, configureSessionMcpServers } = createRuntime();
    clearSessionMcpServers
      .mockRejectedValueOnce(new Error('MCP clear failed'))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const resume = connection.request(acp.methods.agent.session.resume, {
        sessionId: session.sessionId,
        cwd: '/workspace',
        mcpServers: [],
      });
      void resume.catch(() => undefined);
      await vi.waitFor(() => expect(clearSessionMcpServers).toHaveBeenCalledTimes(2));

      await expect(
        connection.request<{ sessionId: string }, { sessionId: string }>('session/activate', {
          sessionId: session.sessionId,
        }),
      ).rejects.toThrow();
    });

    expect(configureSessionMcpServers).not.toHaveBeenCalled();
  });

  it('rejects existing-session cwd mismatches and unsupported additional directories', async () => {
    const { runtime, getSession } = createRuntime();
    getSession.mockResolvedValue({
      sessionId: 'session-existing',
      workspaceDir: '/workspace',
    });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await expect(
        connection.request(acp.methods.agent.session.resume, {
          sessionId: 'session-existing',
          cwd: '/other',
          mcpServers: [],
        }),
      ).rejects.toThrow('does not match');
      await expect(
        connection.request(acp.methods.agent.session.load, {
          sessionId: 'session-existing',
          cwd: '/workspace',
          additionalDirectories: ['/other'],
          mcpServers: [],
        }),
      ).rejects.toThrow('Additional directories are not supported');
      await expect(
        connection.request(acp.methods.agent.session.list, {
          cwd: 'relative/workspace',
        }),
      ).rejects.toThrow('must be absolute');
    });
  });

  it('does not expose or attach internal sub-agent sessions', async () => {
    const { runtime, listSessionPage, getSession, clearSessionMcpServers } = createRuntime();
    const internalSession = {
      sessionId: 'session-worker',
      workspaceDir: '/workspace',
      sessionType: 'branch' as const,
      parentSessionId: 'session-root',
      sessionKind: 'task',
      visibility: 'hidden' as const,
    };
    listSessionPage.mockResolvedValue({
      sessions: [
        internalSession,
        { sessionId: 'session-root', workspaceDir: '/workspace', title: 'Public session' },
      ],
      hasMore: false,
    });
    getSession.mockResolvedValue(internalSession);
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await expect(
        connection.request(acp.methods.agent.session.list, { cwd: '/workspace' }),
      ).resolves.toEqual({
        sessions: [{ sessionId: 'session-root', cwd: '/workspace', title: 'Public session' }],
      });
      await expect(
        connection.request(acp.methods.agent.session.load, {
          sessionId: 'session-worker',
          cwd: '/workspace',
          mcpServers: [],
        }),
      ).rejects.toThrow('Sub-agent Sessions are internal');
      await expect(
        connection.request(acp.methods.agent.session.resume, {
          sessionId: 'session-worker',
          cwd: '/workspace',
          mcpServers: [],
        }),
      ).rejects.toThrow('Sub-agent Sessions are internal');
    });

    expect(clearSessionMcpServers).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'standard terminal authentication capability',
      clientCapabilities: { auth: { terminal: true } },
      advertisesTerminalAuth: true,
    },
    {
      name: 'legacy Registry terminal authentication metadata',
      clientCapabilities: { _meta: { 'terminal-auth': true } },
      advertisesTerminalAuth: true,
    },
    {
      name: 'generic terminal capability without an authentication declaration',
      clientCapabilities: { terminal: true },
      advertisesTerminalAuth: false,
    },
    {
      name: 'no authentication capability',
      clientCapabilities: {},
      advertisesTerminalAuth: false,
    },
  ] satisfies readonly {
    readonly name: string;
    readonly clientCapabilities: acp.ClientCapabilities;
    readonly advertisesTerminalAuth: boolean;
  }[])('advertises terminal authentication for $name', async (testCase) => {
    const { runtime } = createRuntime();
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      const initialized = await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: testCase.clientCapabilities,
      });

      if (testCase.advertisesTerminalAuth) {
        expect(initialized.authMethods).toEqual(ACP_AUTH_METHODS);
      } else {
        expect(initialized.authMethods).toBeUndefined();
      }
    });
  });

  it('bridges Runtime permission requests to the ACP client and returns its decision', async () => {
    const { runtime, emitRuntimeEvent, replyPermission } = createRuntime();
    const permissionRequests: acp.RequestPermissionRequest[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        permissionRequests.push(params);
        return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
      });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent({
        type: 'permission.ask',
        timestampMs: 1,
        source: 'runtime',
        sessionId: 'session-1',
        request: {
          requestId: 'permission-1',
          sessionId: 'session-1',
          agentName: 'mcode',
          toolName: 'edit_file',
          toolDescription: 'Edit C:\\workspace\\a.ts',
          toolInput: '{"path":"C:\\\\workspace\\\\a.ts"}',
          allowAlwaysSupported: true,
        },
      });

      await vi.waitFor(() => expect(replyPermission).toHaveBeenCalledOnce());
    });

    expect(permissionRequests).toEqual([
      {
        sessionId: 'session-1',
        toolCall: {
          toolCallId: 'permission-1',
          title: 'Edit C:\\workspace\\a.ts',
          name: 'edit_file',
          kind: 'edit',
          status: 'pending',
          rawInput: { path: 'C:\\workspace\\a.ts' },
          locations: [{ path: 'C:\\workspace\\a.ts' }],
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      },
    ]);
    expect(replyPermission).toHaveBeenCalledWith('mcode', 'permission-1', 'allowOnce');
  });

  it('denies a forged allow-always decision when Runtime did not offer it', async () => {
    const { runtime, emitRuntimeEvent, replyPermission } = createRuntime();
    const permissionRequests: acp.RequestPermissionRequest[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        permissionRequests.push(params);
        return { outcome: { outcome: 'selected', optionId: 'allow-always' } };
      });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent(permissionEvent('permission-forged-always'));

      await vi.waitFor(() => expect(replyPermission).toHaveBeenCalledOnce());
    });

    expect(permissionRequests[0]?.options).not.toContainEqual(
      expect.objectContaining({ optionId: 'allow-always' }),
    );
    expect(replyPermission).toHaveBeenCalledWith('mcode', 'permission-forged-always', 'deny');
  });

  it('routes descendant interactions to their attached root and ignores unrelated Sessions', async () => {
    const { runtime, emitRuntimeEvent, replyPermission, dismissQuestionnaire } = createRuntime();
    const permissionRequests: acp.RequestPermissionRequest[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        permissionRequests.push(params);
        return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
      });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent({
        type: 'session.created',
        timestampMs: 1,
        source: 'runtime',
        sessionId: 'session-child',
        agentName: 'worker',
        sessionType: 'branch',
        parentSessionId: 'session-1',
      });
      emitRuntimeEvent(permissionEvent('permission-child', 'session-child'));
      emitRuntimeEvent(permissionEvent('permission-unrelated', 'session-unrelated'));
      const unrelatedQuestionnaire = questionnaireEvent('questionnaire-unrelated');
      emitRuntimeEvent({
        ...unrelatedQuestionnaire,
        sessionId: 'session-unrelated',
        request: {
          ...unrelatedQuestionnaire.request,
          requester: { sessionId: 'session-unrelated', agentName: 'mcode' },
        },
      });

      await vi.waitFor(() =>
        expect(replyPermission).toHaveBeenCalledWith('mcode', 'permission-child', 'allowOnce'),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]?.sessionId).toBe('session-1');
    expect(replyPermission).not.toHaveBeenCalledWith(
      'mcode',
      'permission-unrelated',
      expect.anything(),
    );
    expect(dismissQuestionnaire).not.toHaveBeenCalledWith('mcode', 'questionnaire-unrelated');
  });

  it('hydrates existing descendant ownership when attaching a persisted root Session', async () => {
    const { runtime, emitRuntimeEvent, getDelegationSnapshot, replyPermission } = createRuntime();
    getDelegationSnapshot.mockResolvedValue({
      schemaVersion: 1,
      rootSessionId: 'session-root',
      members: [
        {
          sessionId: 'session-child',
          parentSessionId: 'session-root',
          agentName: 'worker',
          status: 'running',
        },
      ],
    });
    const permissionRequests: acp.RequestPermissionRequest[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        permissionRequests.push(params);
        return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
      });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await connection.request(acp.methods.agent.session.resume, {
        sessionId: 'session-root',
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent(permissionEvent('permission-existing-child', 'session-child'));

      await vi.waitFor(() =>
        expect(replyPermission).toHaveBeenCalledWith(
          'mcode',
          'permission-existing-child',
          'allowOnce',
        ),
      );
    });

    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]?.sessionId).toBe('session-root');
  });

  it('fails a pending permission closed with its ACP attachment instead of applying a late grant', async () => {
    const { runtime, emitRuntimeEvent, replyPermission } = createRuntime();
    let markPermissionRequested!: () => void;
    const permissionRequested = new Promise<void>((resolve) => {
      markPermissionRequested = resolve;
    });
    let answerPermission: ((response: acp.RequestPermissionResponse) => void) | undefined;
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' }).onRequest(
      acp.methods.client.session.requestPermission,
      () =>
        new Promise<acp.RequestPermissionResponse>((answer) => {
          answerPermission = answer;
          markPermissionRequested();
        }),
    );

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent(permissionEvent('permission-close-race'));
      await permissionRequested;
      await connection.request(acp.methods.agent.session.close, { sessionId: session.sessionId });
      answerPermission?.({
        outcome: { outcome: 'selected', optionId: 'allow-always' },
      });
      await vi.waitFor(() => expect(replyPermission).toHaveBeenCalledOnce());
    });

    expect(replyPermission).toHaveBeenCalledWith('mcode', 'permission-close-race', 'deny');
  });

  it('keeps ingesting another Session while one permission request is unanswered', async () => {
    const { runtime, createSession, emitRuntimeEvent, replyPermission } = createRuntime();
    let nextSession = 1;
    createSession.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => ({
      sessionId: `session-${nextSession++}`,
      workspaceDir,
    }));
    const permissionRequests: string[] = [];
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params))
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        permissionRequests.push(params.sessionId);
        if (params.sessionId === 'session-1') {
          return new Promise<acp.RequestPermissionResponse>(() => undefined);
        }
        return { outcome: { outcome: 'selected', optionId: 'deny' } };
      });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace/one',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace/two',
        mcpServers: [],
      });
      emitRuntimeEvent(permissionEvent('permission-a', 'session-1'));
      await vi.waitFor(() => expect(permissionRequests).toEqual(['session-1']));
      emitRuntimeEvent({
        type: 'session.title_updated',
        timestampMs: 2,
        source: 'runtime',
        sessionId: 'session-2',
        title: 'Still responsive',
      });
      emitRuntimeEvent(permissionEvent('permission-b', 'session-2'));

      await vi.waitFor(() =>
        expect(replyPermission).toHaveBeenCalledWith('mcode', 'permission-b', 'deny'),
      );
      await vi.waitFor(() =>
        expect(updates).toContainEqual({
          sessionId: 'session-2',
          update: {
            sessionUpdate: 'session_info_update',
            title: 'Still responsive',
            updatedAt: new Date(2).toISOString(),
          },
        }),
      );
    });
  });

  it('bounds concurrent fail-closed replies before closing an overflowing interaction stream', async () => {
    // permission-8 never answers; drive the bounded cancel timeout instead of sleeping 1s.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { runtime, newSessionId, emitRuntimeEvent, replyPermission } = createRuntime();
      let nextSession = 0;
      newSessionId.mockImplementation(() => `session-${nextSession++}`);
      replyPermission.mockImplementation(async (_agentName, requestId) => {
        if (requestId === 'permission-8') await new Promise(() => undefined);
        return true;
      });
      const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
      const client = acp
        .client({ name: 'test-client' })
        .onRequest(
          acp.methods.client.session.requestPermission,
          () => new Promise<acp.RequestPermissionResponse>(() => undefined),
        );

      const operation = client.connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        for (let index = 0; index < 73; index += 1) {
          await connection.request(acp.methods.agent.session.new, {
            cwd: `/workspace/${index}`,
            mcpServers: [],
          });
        }
        for (let index = 0; index < 73; index += 1) {
          emitRuntimeEvent(permissionEvent(`permission-${index}`, `session-${index}`));
        }

        // Only the Agent closing the connection may settle this operation.
        await new Promise<never>(() => undefined);
      });
      const closed = expect(operation).rejects.toThrow('ACP connection closed');
      await vi.waitFor(() =>
        expect(replyPermission).toHaveBeenCalledWith('mcode', 'permission-8', 'deny'),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await closed;

      expect(replyPermission).toHaveBeenCalledWith('mcode', 'permission-72', 'deny');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps watching interactions after one Runtime permission reply fails', async () => {
    const { runtime, emitRuntimeEvent, replyPermission } = createRuntime();
    replyPermission.mockRejectedValueOnce(new Error('permission reply unavailable'));
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onRequest(acp.methods.client.session.requestPermission, () => ({
        outcome: { outcome: 'selected', optionId: 'deny' },
      }));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent(permissionEvent('permission-1'));
      await vi.waitFor(() => expect(replyPermission).toHaveBeenCalledTimes(1));

      emitRuntimeEvent(permissionEvent('permission-2'));
      await vi.waitFor(() => expect(replyPermission).toHaveBeenCalledTimes(2));
    });

    expect(replyPermission).toHaveBeenLastCalledWith('mcode', 'permission-2', 'deny');
  });

  it('bridges Runtime questionnaires through ACP form elicitation when the client supports it', async () => {
    const { runtime, emitRuntimeEvent, replyQuestionnaire } = createRuntime();
    const elicitationRequests: acp.CreateElicitationRequest[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onRequest(acp.methods.client.elicitation.create, ({ params }) => {
        elicitationRequests.push(params);
        return {
          action: 'accept',
          content: {
            approach: 'safe',
            checks: ['unit'],
            checks__other: 'Manual smoke',
            note: 'keep it small',
          },
        };
      });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { elicitation: { form: {} } },
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent({
        type: 'questionnaire.ask',
        timestampMs: 1,
        source: 'runtime',
        sessionId: 'session-1',
        agentName: 'mcode',
        request: {
          schemaVersion: 1,
          id: 'questionnaire-1',
          title: 'Choose settings',
          requester: { sessionId: 'session-1', agentName: 'mcode' },
          presentation: {
            replaceComposer: false,
            showProgress: false,
            allowBackNavigation: false,
          },
          steps: [
            {
              id: 'approach',
              question: 'Which approach?',
              selectionMode: 'single',
              options: [
                { id: 'safe', label: 'Safe' },
                { id: 'fast', label: 'Fast', description: 'Less verification' },
              ],
              allowOther: false,
              otherPlaceholder: '',
              required: true,
            },
            {
              id: 'checks',
              question: 'Which checks?',
              selectionMode: 'multiple',
              options: [
                { id: 'unit', label: 'Unit' },
                { id: 'integration', label: 'Integration' },
              ],
              allowOther: true,
              otherPlaceholder: 'Other check',
              required: false,
            },
            {
              id: 'note',
              question: 'Anything else?',
              selectionMode: 'single',
              allowOther: true,
              otherPlaceholder: 'Notes',
              required: false,
            },
          ],
        },
      });

      await vi.waitFor(() => expect(replyQuestionnaire).toHaveBeenCalledOnce());
    });

    expect(elicitationRequests).toEqual([
      {
        mode: 'form',
        sessionId: 'session-1',
        message: 'Choose settings',
        requestedSchema: {
          type: 'object',
          properties: {
            approach: {
              type: 'string',
              title: 'Which approach?',
              oneOf: [
                { const: 'safe', title: 'Safe' },
                { const: 'fast', title: 'Fast', description: 'Less verification' },
              ],
            },
            checks: {
              type: 'array',
              title: 'Which checks?',
              items: {
                anyOf: [
                  { const: 'unit', title: 'Unit' },
                  { const: 'integration', title: 'Integration' },
                ],
              },
            },
            checks__other: {
              type: 'string',
              title: 'Which checks? — Other',
              description: 'Other check',
            },
            note: {
              type: 'string',
              title: 'Anything else?',
              description: 'Notes',
            },
          },
          required: ['approach'],
        },
      },
    ]);
    expect(replyQuestionnaire).toHaveBeenCalledWith('mcode', 'questionnaire-1', [
      { stepId: 'approach', selectedOptionIds: ['safe'] },
      {
        stepId: 'checks',
        selectedOptionIds: ['unit'],
        selectedOther: true,
        otherText: 'Manual smoke',
      },
      { stepId: 'note', selectedOther: true, otherText: 'keep it small' },
    ]);
  });

  it('preserves option identities and Other fields across normalized questionnaire shapes', async () => {
    const { runtime, emitRuntimeEvent, replyQuestionnaire } = createRuntime();
    const requests: acp.CreateElicitationRequest[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onRequest(acp.methods.client.elicitation.create, ({ params }) => {
        requests.push(params);
        return {
          action: 'accept',
          content: {
            channel: 'Shared',
            delivery: 'safe',
            delivery__other: 'Custom delivery',
            legacy: 'Shared',
            tags: 'Manual tag',
          },
        };
      });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { elicitation: { form: {} } },
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent({
        type: 'questionnaire.ask',
        timestampMs: 1,
        source: 'runtime',
        sessionId: 'session-1',
        agentName: 'mcode',
        request: {
          schemaVersion: 1,
          id: 'questionnaire-identities',
          requester: { sessionId: 'session-1', agentName: 'mcode' },
          presentation: {
            replaceComposer: false,
            showProgress: false,
            allowBackNavigation: false,
          },
          steps: [
            {
              id: 'channel',
              question: 'Channel?',
              selectionMode: 'single',
              options: [
                { id: 'stable', label: 'Shared' },
                { id: 'Shared', label: 'Preview' },
              ],
              allowOther: true,
              otherPlaceholder: 'Another channel',
              required: true,
            },
            {
              id: 'delivery',
              question: 'Delivery?',
              selectionMode: 'single',
              options: [{ id: 'safe', label: 'Safe' }],
              allowOther: true,
              otherPlaceholder: 'Another delivery',
              required: true,
            },
            {
              id: 'legacy',
              question: 'Legacy collision?',
              selectionMode: 'single',
              options: [
                { id: 'first', label: 'Shared' },
                { id: 'second', label: 'Shared' },
              ],
              allowOther: true,
              otherPlaceholder: 'Explicit legacy Other',
              required: false,
            },
            {
              id: 'tags',
              question: 'Tags?',
              selectionMode: 'multiple',
              options: [],
              allowOther: true,
              otherPlaceholder: 'Custom tags',
              required: true,
            },
          ],
        },
      });

      await vi.waitFor(() => expect(replyQuestionnaire).toHaveBeenCalledOnce());
    });

    expect(requests[0]?.requestedSchema.properties).toEqual({
      channel: {
        type: 'string',
        title: 'Channel?',
        oneOf: [
          { const: 'stable', title: 'Shared' },
          { const: 'Shared', title: 'Preview' },
        ],
      },
      channel__other: {
        type: 'string',
        title: 'Channel? — Other',
        description: 'Another channel',
      },
      delivery: {
        type: 'string',
        title: 'Delivery?',
        oneOf: [{ const: 'safe', title: 'Safe' }],
      },
      delivery__other: {
        type: 'string',
        title: 'Delivery? — Other',
        description: 'Another delivery',
      },
      legacy: {
        type: 'string',
        title: 'Legacy collision?',
        oneOf: [
          { const: 'first', title: 'Shared' },
          { const: 'second', title: 'Shared' },
        ],
      },
      legacy__other: {
        type: 'string',
        title: 'Legacy collision? — Other',
        description: 'Explicit legacy Other',
      },
      tags: {
        type: 'string',
        title: 'Tags?',
        description: 'Custom tags',
      },
    });
    expect(replyQuestionnaire).toHaveBeenCalledWith('mcode', 'questionnaire-identities', [
      { stepId: 'channel', selectedOptionIds: ['Shared'] },
      { stepId: 'delivery', selectedOther: true, otherText: 'Custom delivery' },
      { stepId: 'legacy', skipped: true },
      { stepId: 'tags', selectedOther: true, otherText: 'Manual tag' },
    ]);
  });

  it('dismisses a pending questionnaire when its ACP attachment closes', async () => {
    const { runtime, emitRuntimeEvent, replyQuestionnaire, dismissQuestionnaire } = createRuntime();
    let markQuestionnaireRequested!: () => void;
    const questionnaireRequested = new Promise<void>((resolve) => {
      markQuestionnaireRequested = resolve;
    });
    let answerQuestionnaire: ((response: acp.CreateElicitationResponse) => void) | undefined;
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' }).onRequest(
      acp.methods.client.elicitation.create,
      () =>
        new Promise<acp.CreateElicitationResponse>((answer) => {
          answerQuestionnaire = answer;
          markQuestionnaireRequested();
        }),
    );

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { elicitation: { form: {} } },
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent(questionnaireEvent('questionnaire-close-race'));
      await questionnaireRequested;
      await connection.request(acp.methods.agent.session.close, { sessionId: session.sessionId });
      answerQuestionnaire?.({ action: 'accept', content: { approach: 'Safe' } });
      await vi.waitFor(() =>
        expect(dismissQuestionnaire).toHaveBeenCalledWith('mcode', 'questionnaire-close-race'),
      );
    });

    expect(replyQuestionnaire).not.toHaveBeenCalled();
  });

  it('continues a questionnaire-blocked prompt after the ACP client answers', async () => {
    const { runtime, emitRuntimeEvent, replyQuestionnaire, steer } = createRuntime([
      {
        type: 'delta',
        toolCalls: [
          {
            id: 'ask-user-call-1',
            name: 'ask_user',
            input: { mode: 'questionnaire' },
            output: 'Questionnaire is waiting for the local user.',
            status: 'completed',
          },
        ],
      },
      { type: 'session-status', status: 'finished' },
    ]);
    let releaseBlockedRun: (() => void) | undefined;
    const blockedRunGate = new Promise<void>((resolve) => {
      releaseBlockedRun = resolve;
    });
    vi.mocked(runtime.sendMessage).mockImplementation(() =>
      (async function* blockedRunEvents() {
        await blockedRunGate;
        yield {
          type: 'generic',
          eventType: 'runtime.action-required',
          data: { kind: 'questionnaire' },
          turnId: 'turn-1',
        } as const;
      })(),
    );
    vi.mocked(runtime.replyQuestionnaire).mockImplementation(async () => {
      emitRuntimeEvent({
        type: 'session.start',
        timestampMs: 3,
        source: 'runtime',
        sessionId: 'session-1',
        turnId: 'turn-2',
        queueItemIds: [],
      });
      return true;
    });
    vi.mocked(runtime.watchSessionTurn).mockImplementation((_sessionId, turnId) =>
      (async function* continuedTurnEvents() {
        expect(turnId).toBe('turn-2');
        yield {
          type: 'delta',
          messageId: 'message-continued',
          role: 'assistant',
          content: 'Continuing after your answer.',
        } as const;
        emitRuntimeEvent({
          type: 'session.finish',
          timestampMs: 4,
          source: 'runtime',
          sessionId: 'session-1',
          turnId: 'turn-2',
          queueItemIds: [],
        });
        yield { type: 'session-status', status: 'finished' } as const;
      })(),
    );

    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-1',
    });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params))
      .onRequest(acp.methods.client.elicitation.create, () => ({
        action: 'accept',
        content: { approach: 'safe' },
      }));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { elicitation: { form: {} } },
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const prompt = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Ask me a question' }],
      });
      await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledOnce());

      emitRuntimeEvent({
        type: 'questionnaire.ask',
        timestampMs: 1,
        source: 'runtime',
        sessionId: 'session-1',
        agentName: 'mcode',
        request: {
          schemaVersion: 1,
          id: 'questionnaire-continuation',
          title: 'Choose an approach',
          requester: { sessionId: 'session-1', agentName: 'mcode' },
          presentation: {
            replaceComposer: false,
            showProgress: false,
            allowBackNavigation: false,
          },
          steps: [
            {
              id: 'approach',
              question: 'Which approach?',
              selectionMode: 'single',
              options: [{ id: 'safe', label: 'Safe' }],
              allowOther: false,
              otherPlaceholder: '',
              required: true,
            },
          ],
        },
      });
      await vi.waitFor(() => expect(replyQuestionnaire).toHaveBeenCalledOnce());
      await expect(
        connection.request('mcode/session/steer', {
          sessionId: session.sessionId,
          text: 'Do not activate another turn',
        }),
      ).rejects.toThrow('admitted, active ACP prompt Turn');
      expect(steer).not.toHaveBeenCalled();
      releaseBlockedRun?.();

      await expect(prompt).resolves.toMatchObject({
        stopReason: 'end_turn',
        _meta: {
          'minimax-code/turn': {
            runId: 'acp_turn-1',
            turnId: 'turn-1',
            continuationTurnIds: ['turn-2'],
          },
        },
      });
    });

    expect(updates).toContainEqual({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-continued',
        content: { type: 'text', text: 'Continuing after your answer.' },
      },
    });
  });

  it('falls back to an ACP permission choice when form elicitation fails', async () => {
    const { runtime, emitRuntimeEvent, replyQuestionnaire } = createRuntime();
    const permissionRequests: acp.RequestPermissionRequest[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onRequest(acp.methods.client.elicitation.create, () => {
        throw new Error('elicitation method unavailable');
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        permissionRequests.push(params);
        return {
          outcome: {
            outcome: 'selected',
            optionId: 'questionnaire:questionnaire-form-fallback:safe',
          },
        };
      });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { elicitation: { form: {} } },
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent({
        type: 'questionnaire.ask',
        timestampMs: 1,
        source: 'runtime',
        sessionId: 'session-1',
        agentName: 'mcode',
        request: {
          schemaVersion: 1,
          id: 'questionnaire-form-fallback',
          requester: { sessionId: 'session-1', agentName: 'mcode' },
          presentation: {
            replaceComposer: false,
            showProgress: false,
            allowBackNavigation: false,
          },
          steps: [
            {
              id: 'approach',
              question: 'Which approach?',
              selectionMode: 'single',
              options: [{ id: 'safe', label: 'Safe' }],
              allowOther: false,
              otherPlaceholder: '',
              required: true,
            },
          ],
        },
      });

      await vi.waitFor(() => expect(replyQuestionnaire).toHaveBeenCalledOnce());
    });

    expect(permissionRequests).toHaveLength(1);
    expect(replyQuestionnaire).toHaveBeenCalledWith('mcode', 'questionnaire-form-fallback', [
      { stepId: 'approach', selectedOptionIds: ['safe'] },
    ]);
  });

  it('falls back to the first ACP permission choice for a multi-step questionnaire', async () => {
    const { runtime, emitRuntimeEvent, replyQuestionnaire, dismissQuestionnaire } = createRuntime();
    const permissionRequests: acp.RequestPermissionRequest[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        permissionRequests.push(params);
        return {
          outcome: {
            outcome: 'selected',
            optionId: 'questionnaire:questionnaire-2:fast',
          },
        };
      });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent({
        type: 'questionnaire.ask',
        timestampMs: 1,
        source: 'runtime',
        sessionId: 'session-1',
        agentName: 'mcode',
        request: {
          schemaVersion: 1,
          id: 'questionnaire-2',
          requester: { sessionId: 'session-1', agentName: 'mcode' },
          presentation: {
            replaceComposer: false,
            showProgress: false,
            allowBackNavigation: false,
          },
          steps: [
            {
              id: 'approach',
              question: 'Which approach?',
              selectionMode: 'single',
              options: [
                { id: 'safe', label: 'Safe' },
                { id: 'fast', label: 'Fast' },
              ],
              allowOther: false,
              otherPlaceholder: '',
              required: true,
            },
            {
              id: 'depth',
              question: 'How deep should the review go?',
              selectionMode: 'single',
              options: [
                { id: 'overview', label: 'Overview' },
                { id: 'deep', label: 'Deep' },
              ],
              allowOther: false,
              otherPlaceholder: '',
              required: true,
            },
          ],
        },
      });

      await vi.waitFor(() => expect(replyQuestionnaire).toHaveBeenCalledOnce());
    });

    expect(permissionRequests).toEqual([
      {
        sessionId: 'session-1',
        toolCall: {
          toolCallId: 'questionnaire-2',
          title: 'Which approach?',
          kind: 'other',
          status: 'pending',
        },
        options: [
          {
            optionId: 'questionnaire:questionnaire-2:safe',
            name: 'Safe',
            kind: 'allow_once',
          },
          {
            optionId: 'questionnaire:questionnaire-2:fast',
            name: 'Fast',
            kind: 'allow_once',
          },
          { optionId: 'questionnaire:questionnaire-2:cancel', name: 'Cancel', kind: 'reject_once' },
        ],
      },
    ]);
    expect(replyQuestionnaire).toHaveBeenCalledWith('mcode', 'questionnaire-2', [
      { stepId: 'approach', selectedOptionIds: ['fast'] },
      { stepId: 'depth', skipped: true },
    ]);
    expect(dismissQuestionnaire).not.toHaveBeenCalled();
  });

  it('cancels an active prompt when the client sends session/cancel', async () => {
    const { runtime, sendMessage, abortSession } = createRuntime([], { holdRunUntilAbort: true });
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-1',
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const prompt = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Keep running' }],
      });
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

      await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });

      await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });
    });

    expect(abortSession).toHaveBeenCalledWith({
      id: 'session-1',
      turnId: 'turn-1',
      reason: 'user_stop',
    });
  });

  it('rejects managed login when the account is warning but the token is missing', async () => {
    const { runtime, createSession } = createRuntime([], {
      accountStatus: {
        status: 'warning',
        modelSource: 'token-plan',
        authMode: 'managed-login',
        managedTokenPresent: false,
        warnings: ['Managed token is missing.'],
      },
    });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { auth: { terminal: true } },
      });

      await expect(
        connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          mcpServers: [],
        }),
      ).rejects.toThrow('mcode login');
    });

    expect(createSession).not.toHaveBeenCalled();
  });

  it('honors JSON-RPC request cancellation for session/prompt', async () => {
    const { runtime, sendMessage, abortSession } = createRuntime([], { holdRunUntilAbort: true });
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-1',
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const cancellation = new AbortController();
      const prompt = connection.request(
        acp.methods.agent.session.prompt,
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Keep running' }],
        },
        { cancellationSignal: cancellation.signal },
      );
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

      cancellation.abort();

      await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });
    });

    expect(abortSession).toHaveBeenCalledWith({
      id: 'session-1',
      turnId: 'turn-1',
      reason: 'user_stop',
    });
  });

  it('suppresses command output when JSON-RPC cancellation arrives during command execution', async () => {
    const { runtime, requestCompaction, sendMessage } = createRuntime();
    let releaseCompaction!: () => void;
    requestCompaction.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCompaction = () => resolve({ success: true });
        }),
    );
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const cancellation = new AbortController();
      const prompt = connection.request(
        acp.methods.agent.session.prompt,
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '/compact' }],
        },
        { cancellationSignal: cancellation.signal },
      );
      await vi.waitFor(() => expect(requestCompaction).toHaveBeenCalledOnce());
      cancellation.abort();
      releaseCompaction();

      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(updates).not.toContainEqual(
      expect.objectContaining({
        update: expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
      }),
    );
  });

  it('passes client-provided stdio MCP servers into the Runtime session', async () => {
    const { runtime, createSession, configureSessionMcpServers } = createRuntime();
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await expect(
        connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          mcpServers: [
            {
              name: 'client-tools',
              command: '/usr/local/bin/client-tools',
              args: ['serve'],
              env: [{ name: 'CLIENT_TOKEN', value: 'test-token' }],
            },
          ],
        }),
      ).resolves.toMatchObject({
        sessionId: 'session-1',
        modes: { currentModeId: 'default' },
        configOptions: expect.arrayContaining([expect.objectContaining({ id: 'permissionMode' })]),
      });
      expect(createSession).not.toHaveBeenCalled();
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: '/help' }],
      });
    });

    expect(createSession).toHaveBeenCalledWith({ workspaceDir: '/workspace', sessionId: 'session-1' });
    expect(configureSessionMcpServers).toHaveBeenCalledWith('session-1', [
      {
        name: 'client-tools',
        type: 'stdio',
        command: '/usr/local/bin/client-tools',
        args: ['serve'],
        env: { CLIENT_TOKEN: 'test-token' },
      },
    ]);
  });

  it('passes client-provided HTTP and SSE MCP servers into the Runtime session', async () => {
    const { runtime, createSession, configureSessionMcpServers } = createRuntime();
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await expect(
        connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          mcpServers: [
            {
              name: 'http-tools',
              type: 'http',
              url: 'https://example.com/mcp',
              headers: [{ name: 'Authorization', value: 'Bearer http-token' }],
            },
            {
              name: 'sse-tools',
              type: 'sse',
              url: 'https://example.com/sse',
              headers: [{ name: 'X-Client', value: 'acp' }],
            },
          ],
        }),
      ).resolves.toMatchObject({
        sessionId: 'session-1',
        modes: { currentModeId: 'default' },
        configOptions: expect.arrayContaining([expect.objectContaining({ id: 'permissionMode' })]),
      });
      expect(createSession).not.toHaveBeenCalled();
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: '/help' }],
      });
    });

    expect(createSession).toHaveBeenCalledWith({ workspaceDir: '/workspace', sessionId: 'session-1' });
    expect(configureSessionMcpServers).toHaveBeenCalledWith('session-1', [
      {
        name: 'http-tools',
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer http-token' },
      },
      {
        name: 'sse-tools',
        type: 'sse',
        url: 'https://example.com/sse',
        headers: { 'X-Client': 'acp' },
      },
    ]);
  });

  it('applies mode intent to the next prompt and exposes Runtime-backed configuration', async () => {
    const { runtime, getSession, sendMessage, setPermissionMode, selectSessionModel } =
      createRuntime(
        [
          { type: 'delta', messageId: 'message-1', role: 'assistant', content: 'Planned.' },
          { type: 'session-status', status: 'finished' },
        ],
        {
          models: [
            {
              providerId: 'minimax',
              modelId: 'm3',
              displayName: 'MiniMax M3',
              selected: true,
              effortOptions: ['low', 'high'],
              defaultEffort: 'low',
            },
          ],
        },
      );
    getSession
      .mockResolvedValueOnce({ sessionId: 'session-1', workspaceDir: '/workspace' })
      .mockResolvedValueOnce({ sessionId: 'session-1', workspaceDir: '/workspace' })
      .mockResolvedValueOnce({ sessionId: 'session-1', workspaceDir: '/workspace' })
      .mockResolvedValueOnce({
        sessionId: 'session-1',
        workspaceDir: '/workspace',
        model: { providerId: 'minimax', modelId: 'm3', thinking: { effort: 'low' } },
      })
      .mockResolvedValueOnce({
        sessionId: 'session-1',
        workspaceDir: '/workspace',
        model: { providerId: 'minimax', modelId: 'm3', thinking: { effort: 'high' } },
      })
      .mockResolvedValue({
        sessionId: 'session-1',
        workspaceDir: '/workspace',
        interactionMode: 'plan',
        model: { providerId: 'minimax', modelId: 'm3', thinking: { effort: 'low' } },
      });
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3', createTurnId: () => 'turn-1' });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await newRuntimeSession(connection, {
        cwd: '/workspace',
        mcpServers: [],
      });
      expect(session.configOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'permissionMode', currentValue: 'default' }),
          expect.objectContaining({ id: 'model' }),
          expect.objectContaining({ id: 'thinkingEffort', currentValue: 'low' }),
        ]),
      );

      await expect(
        connection.request(acp.methods.agent.session.setMode, {
          sessionId: session.sessionId,
          modeId: 'plan',
        }),
      ).resolves.toEqual({ _meta: { 'minimax-code/transition': 'next_prompt' } });
      await expect(
        connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId: session.sessionId,
          configId: 'permissionMode',
          value: 'auto',
        }),
      ).resolves.toEqual(expect.objectContaining({ configOptions: expect.any(Array) }));
      await expect(
        connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId: session.sessionId,
          configId: 'model',
          value: 'm:minimax:m3:u',
        }),
      ).resolves.toEqual(expect.objectContaining({ configOptions: expect.any(Array) }));
      await expect(
        connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId: session.sessionId,
          configId: 'thinkingEffort',
          value: 'high',
        }),
      ).resolves.toEqual(expect.objectContaining({ configOptions: expect.any(Array) }));

      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Make a plan' }],
        }),
      ).resolves.toMatchObject({ stopReason: 'end_turn' });
    });

    expect(setPermissionMode).toHaveBeenCalledWith('auto');
    expect(selectSessionModel).toHaveBeenCalledWith(
      { providerId: 'minimax', modelId: 'm3' },
      'session-1',
    );
    expect(selectSessionModel).toHaveBeenCalledWith(
      {
        providerId: 'minimax',
        modelId: 'm3',
        thinking: { effort: 'high' },
      },
      'session-1',
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1', clientIntent: 'plan-entry' }),
      expect.any(AbortSignal),
    );
    expect(updates).toContainEqual({
      sessionId: 'session-1',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
    });
  });

  it('returns a successful permission-mode change when a background Session broadcast stalls', async () => {
    const { runtime, getPermissionMode, setPermissionMode } = createRuntime();
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      runtimeEventProjectionTimeoutMs: 10,
    });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, () => undefined);

    const operation = client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      getPermissionMode
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValue('auto');

      await expect(
        connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId: session.sessionId,
          configId: 'permissionMode',
          value: 'auto',
        }),
      ).resolves.toEqual(expect.objectContaining({ configOptions: expect.any(Array) }));
      // Only the Agent closing the connection may settle this operation.
      await new Promise<never>(() => undefined);
    });
    await expect(operation).rejects.toThrow('ACP connection closed');

    expect(setPermissionMode).toHaveBeenCalledWith('auto');
  });

  it('serializes process permission writes across close and another Session', async () => {
    const { runtime, createSession, setPermissionMode } = createRuntime();
    let nextSession = 1;
    createSession.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => ({
      sessionId: `session-${nextSession++}`,
      workspaceDir,
    }));
    let releaseOldWrite!: () => void;
    const applied: string[] = [];
    setPermissionMode
      .mockImplementationOnce(
        (mode) =>
          new Promise((resolve) => {
            releaseOldWrite = () => {
              applied.push(mode);
              resolve(mode);
            };
          }),
      )
      .mockImplementation(async (mode) => {
        applied.push(mode);
        return mode;
      });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const first = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace/first',
        mcpServers: [],
      });
      const second = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace/second',
        mcpServers: [],
      });
      const oldWrite = connection.request(acp.methods.agent.session.setConfigOption, {
        sessionId: first.sessionId,
        configId: 'permissionMode',
        value: 'bypassPermissions',
      });
      void oldWrite.catch(() => undefined);
      await vi.waitFor(() => expect(setPermissionMode).toHaveBeenCalledOnce());
      await connection.request(acp.methods.agent.session.close, { sessionId: first.sessionId });
      const newWrite = connection.request(acp.methods.agent.session.setConfigOption, {
        sessionId: second.sessionId,
        configId: 'permissionMode',
        value: 'default',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(setPermissionMode).toHaveBeenCalledOnce();

      releaseOldWrite();
      await expect(oldWrite).rejects.toThrow('cancelled');
      await expect(newWrite).resolves.toEqual(
        expect.objectContaining({ configOptions: expect.any(Array) }),
      );
    });

    expect(applied).toEqual(['bypassPermissions', 'default']);
  });

  it('broadcasts a committed permission write even when its initiating Session closes', async () => {
    const { runtime, createSession, getPermissionMode, setPermissionMode } = createRuntime();
    let nextSession = 1;
    createSession.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => ({
      sessionId: `session-${nextSession++}`,
      workspaceDir,
    }));
    let currentMode: 'default' | 'auto' | 'bypassPermissions' = 'default';
    let releaseWrite!: () => void;
    setPermissionMode.mockImplementation(
      (mode) =>
        new Promise((resolve) => {
          releaseWrite = () => {
            currentMode = mode === 'off' ? 'default' : mode;
            resolve(mode);
          };
        }),
    );
    getPermissionMode.mockImplementation(async () => currentMode);
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const first = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace/first',
        mcpServers: [],
      });
      const second = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace/second',
        mcpServers: [],
      });
      const write = connection.request(acp.methods.agent.session.setConfigOption, {
        sessionId: first.sessionId,
        configId: 'permissionMode',
        value: 'bypassPermissions',
      });
      void write.catch(() => undefined);
      await vi.waitFor(() => expect(setPermissionMode).toHaveBeenCalledOnce());
      await connection.request(acp.methods.agent.session.close, { sessionId: first.sessionId });
      releaseWrite();
      await expect(write).rejects.toThrow('cancelled');
      await vi.waitFor(() =>
        expect(updates).toContainEqual({
          sessionId: second.sessionId,
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: expect.arrayContaining([
              expect.objectContaining({
                id: 'permissionMode',
                currentValue: 'bypassPermissions',
              }),
            ]),
          },
        }),
      );
    });
  });

  it('omits unknown permission state and rejects unadvertised model configuration values', async () => {
    const { runtime, getPermissionMode, getSession, selectSessionModel } = createRuntime([], {
      models: [
        {
          providerId: 'minimax',
          modelId: 'm3',
          selected: true,
          effortOptions: ['low', 'high'],
        },
      ],
    });
    getPermissionMode.mockRejectedValue(new Error('permission config unavailable'));
    getSession.mockResolvedValue({
      sessionId: 'session-1',
      workspaceDir: '/workspace',
      model: { providerId: 'minimax', modelId: 'm3', thinking: { effort: 'low' } },
    });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      expect(session.configOptions).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'permissionMode' })]),
      );

      await expect(
        connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId: session.sessionId,
          configId: 'model',
          value: 'm:minimax:unknown:u',
        }),
      ).rejects.toThrow('Model selection is not advertised');
      await expect(
        connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId: session.sessionId,
          configId: 'thinkingEffort',
          value: 'ultra',
        }),
      ).rejects.toThrow('Thinking effort is not advertised');
    });

    expect(selectSessionModel).not.toHaveBeenCalled();
  });

  it('round-trips an explicitly empty advertised model variant', async () => {
    const { runtime, selectSessionModel } = createRuntime([], {
      models: [
        {
          providerId: 'minimax',
          modelId: 'm3',
          selected: true,
          variant: '',
          supportedVariants: ['', 'thinking'],
        },
      ],
    });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await newRuntimeSession(connection, {
        cwd: '/workspace',
        mcpServers: [],
      });
      expect(session.configOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'model',
            currentValue: 'm:minimax:m3:v:',
            options: expect.arrayContaining([
              expect.objectContaining({ value: 'm:minimax:m3:v:' }),
              expect.objectContaining({ value: 'm:minimax:m3:v:thinking' }),
            ]),
          }),
        ]),
      );

      await expect(
        connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId: session.sessionId,
          configId: 'model',
          value: 'm:minimax:m3:v:',
        }),
      ).resolves.toEqual(expect.objectContaining({ configOptions: expect.any(Array) }));
    });

    expect(selectSessionModel).toHaveBeenCalledWith(
      { providerId: 'minimax', modelId: 'm3', variant: '' },
      'session-1',
    );
  });

  it('advertises the catalog default effort before the middle one, as Runtime resolves it', async () => {
    const { runtime } = createRuntime([], {
      models: [
        {
          providerId: 'minimax',
          modelId: 'm3',
          selected: true,
          effortOptions: ['low', 'high'],
          defaultEffort: 'high',
        },
      ],
    });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      expect(session.configOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'thinkingEffort', currentValue: 'high' }),
        ]),
      );
    });
  });

  it('advertises an empty selected variant when supportedVariants is omitted', async () => {
    const { runtime, selectSessionModel } = createRuntime([], {
      models: [
        {
          providerId: 'minimax',
          modelId: 'm3',
          selected: true,
          variant: '',
          effortOptions: ['low'],
          defaultEffort: 'low',
        },
      ],
    });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await newRuntimeSession(connection, {
        cwd: '/workspace',
        mcpServers: [],
      });
      expect(session.configOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'model', currentValue: 'm:minimax:m3:v:' }),
          expect.objectContaining({ id: 'thinkingEffort', currentValue: 'low' }),
        ]),
      );
      await connection.request(acp.methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: 'model',
        value: 'm:minimax:m3:v:',
      });
    });

    expect(selectSessionModel).toHaveBeenCalledWith(
      { providerId: 'minimax', modelId: 'm3', variant: '' },
      'session-1',
    );
  });

  it('forks an attached Runtime session through the standard ACP method', async () => {
    const { runtime, configureSessionMcpServers, getSessionForkOptions, forkSession } =
      createRuntime();
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [
          {
            name: 'client-tools',
            command: '/usr/local/bin/client-tools',
            args: ['serve'],
            env: [],
          },
        ],
      });
      await expect(
        connection.request(acp.methods.agent.session.fork, {
          sessionId: session.sessionId,
          cwd: '/workspace',
        }),
      ).resolves.toMatchObject({
        sessionId: 'session-fork',
        modes: { currentModeId: 'default' },
      });
    });

    expect(getSessionForkOptions).toHaveBeenCalledWith('session-1');
    expect(configureSessionMcpServers).toHaveBeenCalledWith('session-fork', [
      {
        name: 'client-tools',
        type: 'stdio',
        command: '/usr/local/bin/client-tools',
        args: ['serve'],
      },
    ]);
    expect(forkSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        useSuggestedTitle: true,
        createIsolatedWorktree: false,
      }),
    );
  });

  it('bounds concurrent durable fork operations', async () => {
    const { runtime, forkSession } = createRuntime();
    forkSession.mockImplementation(() => new Promise(() => undefined));
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const cancellations = Array.from({ length: 8 }, () => new AbortController());
      const admitted = cancellations.map((cancellation) =>
        connection.request(
          acp.methods.agent.session.fork,
          {
            sessionId: session.sessionId,
            cwd: '/workspace',
            mcpServers: [],
          },
          { cancellationSignal: cancellation.signal },
        ),
      );
      for (const request of admitted) void request.catch(() => undefined);
      await vi.waitFor(() => expect(forkSession).toHaveBeenCalledTimes(8));
      for (const cancellation of cancellations) cancellation.abort();
      await Promise.all(admitted.map((request) => expect(request).rejects.toThrow('cancel')));

      await expect(
        connection.request(acp.methods.agent.session.fork, {
          sessionId: session.sessionId,
          cwd: '/workspace',
          mcpServers: [],
        }),
      ).rejects.toThrow('Too many ACP Session fork operations');
    });
  });

  it('deletes a durable fork when its ACP request is cancelled', async () => {
    const { runtime, deleteSession, forkSession } = createRuntime();
    let releaseFork!: () => void;
    forkSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFork = () =>
            resolve({ session: { sessionId: 'session-fork', workspaceDir: '/workspace' } });
        }),
    );
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const cancellation = new AbortController();
      const fork = connection.request(
        acp.methods.agent.session.fork,
        { sessionId: session.sessionId, cwd: '/workspace', mcpServers: [] },
        { cancellationSignal: cancellation.signal },
      );
      await vi.waitFor(() => expect(forkSession).toHaveBeenCalledOnce());
      cancellation.abort();
      releaseFork();

      await expect(fork).rejects.toThrow('cancelled');
    });

    expect(deleteSession).toHaveBeenCalledWith('session-fork');
  });

  it('treats an explicit empty MCP list as a complete fork overlay replacement', async () => {
    const { runtime, configureSessionMcpServers } = createRuntime();
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await newRuntimeSession(connection, {
        cwd: '/workspace',
        mcpServers: [
          {
            name: 'client-tools',
            command: '/usr/local/bin/client-tools',
            args: ['serve'],
            env: [],
          },
        ],
      });
      configureSessionMcpServers.mockClear();
      await expect(
        connection.request(acp.methods.agent.session.fork, {
          sessionId: session.sessionId,
          cwd: '/workspace',
          mcpServers: [],
        }),
      ).resolves.toMatchObject({ sessionId: 'session-fork' });
    });

    expect(configureSessionMcpServers).not.toHaveBeenCalled();
  });

  it('deletes a durable fork without waiting for MCP clear after configuration fails', async () => {
    const { runtime, configureSessionMcpServers, clearSessionMcpServers, deleteSession } =
      createRuntime();
    clearSessionMcpServers.mockImplementation(() => new Promise(() => undefined));
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await newRuntimeSession(connection, {
        cwd: '/workspace',
        mcpServers: [
          {
            name: 'client-tools',
            command: '/usr/local/bin/client-tools',
            args: ['serve'],
            env: [],
          },
        ],
      });
      configureSessionMcpServers.mockRejectedValue(new Error('MCP startup failed'));
      await expect(
        connection.request(acp.methods.agent.session.fork, {
          sessionId: session.sessionId,
          cwd: '/workspace',
        }),
      ).rejects.toThrow('Internal error');
      await expect(
        connection.request(acp.methods.agent.session.close, { sessionId: 'session-fork' }),
      ).rejects.toThrow();
    });

    expect(clearSessionMcpServers).not.toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith('session-fork');
  });

  it('exposes steer, queue, Goal, and delegation control through ACP extensions', async () => {
    const {
      runtime,
      sendMessage,
      abortSession,
      steer,
      listQueuedMessages,
      enqueueMessage,
      updateQueuedMessageContent,
      deleteQueuedMessage,
      steerQueuedMessage,
      getGoal,
      createGoal,
      patchGoal,
      clearGoal,
      getDelegationSnapshot,
      stopDelegation,
    } = createRuntime(
      [
        {
          type: 'delta',
          messageId: 'message-active',
          role: 'assistant',
          content: 'Working',
          turnId: 'turn-active',
        },
      ],
      { holdRunAfterEvents: true },
    );
    updateQueuedMessageContent.mockResolvedValueOnce({
      itemId: 'queue-1',
      sessionId: 'session-1',
      content: 'Run focused checks',
      status: 'queued',
    });
    deleteQueuedMessage.mockResolvedValueOnce({
      itemId: 'queue-1',
      sessionId: 'session-1',
      content: 'Run focused checks',
      status: 'deleted',
    });
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-active',
    });
    const activeUpdates: acp.SessionNotification[] = [];
    const currentSessionUpdates: unknown[] = [];
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => activeUpdates.push(params))
      .onNotification(
        'mcode/session/current_session_update',
        (value) => value as { sessionId: string | null },
        ({ params }) => currentSessionUpdates.push(params),
      );

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          _meta: { 'minimax-code/extensions': { version: 1, notifications: true } },
        },
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await expect(
        connection.request<{ sessionId: string }, { sessionId: string }>('session/activate', {
          sessionId: session.sessionId,
        }),
      ).resolves.toEqual({ sessionId: 'session-1' });
      await expect(
        connection.request<{ sessionId: string }, { sessionId: string }>('mcode/session/activate', {
          sessionId: session.sessionId,
        }),
      ).resolves.toEqual({ sessionId: 'session-1' });

      await expect(
        connection.request<
          { itemId: string; position: number },
          { sessionId: string; text: string }
        >('mcode/session/queue/enqueue', {
          sessionId: session.sessionId,
          text: '\n  Run checks next  \n',
        }),
      ).resolves.toEqual({ itemId: 'queue-1', position: 1 });
      await expect(
        connection.request<{ items: unknown[] }, { sessionId: string }>(
          'mcode/session/queue/list',
          { sessionId: session.sessionId },
        ),
      ).resolves.toEqual({ items: [] });
      await expect(
        connection.request<
          { item: { content: string } },
          { sessionId: string; itemId: string; text: string }
        >('mcode/session/queue/update', {
          sessionId: session.sessionId,
          itemId: 'queue-1',
          text: '\n    Run focused checks  \n',
        }),
      ).resolves.toMatchObject({ item: { content: 'Run focused checks' } });
      await expect(
        connection.request<{ item: { status: string } }, { sessionId: string; itemId: string }>(
          'mcode/session/queue/delete',
          {
            sessionId: session.sessionId,
            itemId: 'queue-1',
          },
        ),
      ).resolves.toMatchObject({ item: { status: 'deleted' } });
      await expect(
        connection.request<
          { queueItemId: string; turnId: string },
          { sessionId: string; itemId: string }
        >('mcode/session/queue/steer', {
          sessionId: session.sessionId,
          itemId: 'queue-1',
        }),
      ).resolves.toEqual({ queueItemId: 'queue-1', turnId: 'turn-2' });
      await expect(
        connection.request<{ goal: unknown | null }, { sessionId: string }>(
          'mcode/session/goal/get',
          {
            sessionId: session.sessionId,
          },
        ),
      ).resolves.toEqual({ goal: null });
      await expect(
        connection.request<
          { goal: { goalId: string; objective: string } },
          { sessionId: string; objective: string; tokenBudget: number }
        >('mcode/session/goal/create', {
          sessionId: session.sessionId,
          objective: 'Ship ACP',
          tokenBudget: 8_000,
        }),
      ).resolves.toMatchObject({ goal: { goalId: 'goal-1', objective: 'Ship ACP' } });
      await expect(
        connection.request<{ goal: { status: string } }, { sessionId: string; status: string }>(
          'mcode/session/goal/patch',
          {
            sessionId: session.sessionId,
            status: 'paused',
          },
        ),
      ).resolves.toMatchObject({ goal: { status: 'paused' } });
      await expect(
        connection.request<{ cleared: boolean }, { sessionId: string }>(
          'mcode/session/goal/clear',
          { sessionId: session.sessionId },
        ),
      ).resolves.toEqual({ cleared: true });
      await expect(
        connection.request<{ snapshot: { rootSessionId: string } }, { sessionId: string }>(
          'mcode/session/delegation/get',
          { sessionId: session.sessionId },
        ),
      ).resolves.toMatchObject({ snapshot: { rootSessionId: 'session-1' } });
      await expect(
        connection.request<{ receipt: { rootStopped: boolean } }, { sessionId: string }>(
          'mcode/session/delegation/stop',
          { sessionId: session.sessionId },
        ),
      ).resolves.toMatchObject({ receipt: { rootStopped: true } });

      const prompt = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Start working' }],
      });
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(activeUpdates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              update: expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
            }),
          ]),
        ),
      );
      await expect(
        connection.request<
          { turnId: string; mode: string },
          { sessionId: string; text: string; clientRequestId: string }
        >('mcode/session/steer', {
          sessionId: session.sessionId,
          text: '\n  Prioritize protocol tests  \n',
          clientRequestId: 'client-steer-1',
        }),
      ).resolves.toEqual({ turnId: 'turn-active', mode: 'steered' });
      await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });
      await expect(
        connection.request(acp.methods.agent.session.close, { sessionId: session.sessionId }),
      ).resolves.toEqual({});
    });

    expect(enqueueMessage).toHaveBeenCalledWith('session-1', '\n  Run checks next  \n');
    expect(listQueuedMessages).toHaveBeenCalledWith('session-1');
    expect(updateQueuedMessageContent).toHaveBeenCalledWith(
      'session-1',
      'queue-1',
      '\n    Run focused checks  \n',
    );
    expect(deleteQueuedMessage).toHaveBeenCalledWith('session-1', 'queue-1');
    expect(steerQueuedMessage).toHaveBeenCalledWith('session-1', 'queue-1');
    expect(getGoal).toHaveBeenCalledWith('session-1');
    expect(createGoal).toHaveBeenCalledWith({
      sessionId: 'session-1',
      objective: 'Ship ACP',
      tokenBudget: 8_000,
    });
    expect(patchGoal).toHaveBeenCalledWith('session-1', { status: 'paused' });
    expect(clearGoal).toHaveBeenCalledWith('session-1');
    expect(getDelegationSnapshot).toHaveBeenCalledWith('session-1');
    expect(stopDelegation).toHaveBeenCalledWith('session-1');
    expect(currentSessionUpdates).toEqual([
      { sessionId: 'session-1' },
      { sessionId: 'session-1' },
      { sessionId: null },
    ]);
    expect(steer).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        source: 'api',
        message: { content: '\n  Prioritize protocol tests  \n' },
        producerId: 'mcode-acp',
        idempotencyKey: 'client-steer-1',
        preDelivery: { accept: expect.any(Function) },
      }),
    );
    expect(abortSession).toHaveBeenCalled();
  });

  it('addresses one delegated agent by targetSessionId without acting on its parent', async () => {
    const { runtime, steer, listMessagePage, getDelegationSnapshot, stopDelegation, abortSession } =
      createRuntime();
    getDelegationSnapshot.mockImplementation(async (rootSessionId: string) => ({
      schemaVersion: 1 as const,
      rootSessionId,
      members: [
        { sessionId: 'child-1', parentSessionId: rootSessionId, status: 'running' as const },
        { sessionId: 'grandchild-1', parentSessionId: 'child-1', status: 'running' as const },
        { sessionId: 'child-2', parentSessionId: rootSessionId, status: 'running' as const },
      ],
    }));
    stopDelegation.mockImplementation(async (rootSessionId: string, options?: unknown) => ({
      schemaVersion: 1 as const,
      rootSessionId,
      ...(options as { targetSessionId?: string }),
      rootStopped: false,
      stoppedSessionIds: ['child-1', 'grandchild-1'],
      activeSessionIds: [],
      failedSessionIds: [],
    }));
    listMessagePage.mockResolvedValueOnce({
      messages: [
        { id: 'message-user', role: 'user', content: 'Review the CLI' },
        { id: 'message-final', role: 'assistant', content: 'Review done', turnId: 'turn-child' },
      ],
      hasMore: true,
      nextCursor: 'cursor-older',
    } as never);
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      const initialized = await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      expect(initialized._meta?.['minimax-code/extensions']).toMatchObject({
        methods: expect.arrayContaining([
          'mcode/session/delegation/message',
          'mcode/session/delegation/transcript',
        ]),
      });
      const session = await newRuntimeSession(connection, {
        cwd: '/workspace',
        mcpServers: [],
      });

      await expect(
        connection.request('mcode/session/delegation/stop', {
          sessionId: session.sessionId,
          targetSessionId: 'child-1',
        }),
      ).resolves.toEqual({
        receipt: {
          schemaVersion: 1,
          rootSessionId: 'session-1',
          targetSessionId: 'child-1',
          rootStopped: false,
          stoppedSessionIds: ['child-1', 'grandchild-1'],
          activeSessionIds: [],
          failedSessionIds: [],
        },
      });
      await expect(
        connection.request('mcode/session/delegation/stop', {
          sessionId: session.sessionId,
          childSessionId: 'child-1',
        }),
      ).rejects.toThrow('childSessionId is not supported');
      await expect(
        connection.request('mcode/session/delegation/get', {
          sessionId: session.sessionId,
          targetSessionId: 'child-1',
        }),
      ).rejects.toThrow('targetSessionId is not supported');
      await expect(
        connection.request('mcode/session/delegation/stop', {
          sessionId: session.sessionId,
          targetSessionId: 'unrelated-session',
        }),
      ).rejects.toThrow('not a delegated agent');
      await expect(
        connection.request('mcode/session/delegation/stop', {
          sessionId: session.sessionId,
          targetSessionId: 'session-1',
        }),
      ).rejects.toThrow('not a delegated agent');

      await expect(
        connection.request('mcode/session/delegation/message', {
          sessionId: session.sessionId,
          targetSessionId: 'grandchild-1',
          text: 'Also check Windows paths',
          clientRequestId: 'client-message-1',
        }),
      ).resolves.toEqual({
        targetSessionId: 'grandchild-1',
        turnId: 'turn-active',
        mode: 'steered',
      });

      await expect(
        connection.request('mcode/session/delegation/transcript', {
          sessionId: session.sessionId,
          targetSessionId: 'child-1',
          limit: 20,
        }),
      ).resolves.toEqual({
        targetSessionId: 'child-1',
        updates: [
          {
            sessionUpdate: 'user_message_chunk',
            messageId: 'message-user',
            content: { type: 'text', text: 'Review the CLI' },
          },
          expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Review done' },
          }),
        ],
        hasMore: true,
        nextCursor: 'cursor-older',
      });
    });

    expect(stopDelegation).toHaveBeenCalledOnce();
    expect(stopDelegation).toHaveBeenCalledWith('session-1', { targetSessionId: 'child-1' });
    expect(abortSession).not.toHaveBeenCalled();
    expect(steer).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'grandchild-1',
        source: 'api',
        message: { content: 'Also check Windows paths' },
        producerId: 'mcode-acp',
        idempotencyKey: 'client-message-1',
        preDelivery: { accept: expect.any(Function) },
      }),
    );
    expect(listMessagePage).toHaveBeenCalledWith('child-1', { limit: 20 });
  });

  it('validates delegated-agent transcript paging and accepts _meta', async () => {
    const { runtime, listMessagePage, getDelegationSnapshot } = createRuntime();
    getDelegationSnapshot.mockImplementation(async (rootSessionId: string) => ({
      schemaVersion: 1 as const,
      rootSessionId,
      members: [
        { sessionId: 'child-1', parentSessionId: rootSessionId, status: 'running' as const },
      ],
    }));
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await newRuntimeSession(connection, {
        cwd: '/workspace',
        mcpServers: [],
      });
      for (const limit of [0, 101, 1.5, '10']) {
        await expect(
          connection.request('mcode/session/delegation/transcript', {
            sessionId: session.sessionId,
            targetSessionId: 'child-1',
            limit,
          }),
        ).rejects.toThrow('limit must be an integer from 1 to 100');
      }
      await expect(
        connection.request('mcode/session/delegation/transcript', {
          sessionId: session.sessionId,
          targetSessionId: 'child-1',
          before: 'cursor-older',
          _meta: { trace: 'client-1' },
        }),
      ).resolves.toEqual({ targetSessionId: 'child-1', updates: [], hasMore: false });
    });

    expect(listMessagePage).toHaveBeenCalledOnce();
    expect(listMessagePage).toHaveBeenCalledWith('child-1', { limit: 50, before: 'cursor-older' });
  });

  it('rejects a message to an idle delegated agent without asking the Runtime to steer it', async () => {
    const { runtime, steer, getActiveRun, getDelegationSnapshot } = createRuntime();
    getDelegationSnapshot.mockImplementation(async (rootSessionId: string) => ({
      schemaVersion: 1 as const,
      rootSessionId,
      members: [
        { sessionId: 'child-idle', parentSessionId: rootSessionId, status: 'completed' as const },
      ],
    }));
    getActiveRun.mockImplementation(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      state: 'idle',
      turnId: undefined,
      actions: { steer: false },
    }));
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await newRuntimeSession(connection, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await expect(
        connection.request('mcode/session/delegation/message', {
          sessionId: session.sessionId,
          targetSessionId: 'child-idle',
          text: 'Start over',
        }),
      ).rejects.toThrow('no running Turn');
    });

    expect(getActiveRun).toHaveBeenCalledWith('child-idle');
    // Steering an idle Session would admit a Turn first, and withdrawing it afterwards leaves
    // a persisted terminal on the agent; the precheck must keep the Runtime out of it.
    expect(steer).not.toHaveBeenCalled();
  });

  it('withdraws a delegated-agent message as a cancellation when its Turn ends before delivery', async () => {
    const { runtime, steer, getDelegationSnapshot } = createRuntime();
    getDelegationSnapshot.mockImplementation(async (rootSessionId: string) => ({
      schemaVersion: 1 as const,
      rootSessionId,
      members: [
        { sessionId: 'child-racing', parentSessionId: rootSessionId, status: 'running' as const },
      ],
    }));
    let withdrawal: unknown;
    steer.mockImplementationOnce(async (input) => {
      try {
        await input.preDelivery?.accept({ mode: 'activated', turnId: 'turn-new' });
      } catch (error) {
        withdrawal = error;
        throw error;
      }
      return {
        turnId: 'turn-new',
        mode: 'activated',
        completion: new Promise(() => undefined),
      } as never;
    });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await newRuntimeSession(connection, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await expect(
        connection.request('mcode/session/delegation/message', {
          sessionId: session.sessionId,
          targetSessionId: 'child-racing',
          text: 'Too late',
        }),
      ).rejects.toThrow('no running Turn');
    });

    // The Runtime projects only an AbortError from pre-delivery as a withdrawn delivery;
    // any other error is recorded as a failed Turn on the agent's Session.
    expect(withdrawal).toMatchObject({ name: 'AbortError' });
  });
  it('rejects ACP steering before the Runtime admits the prompt Turn', async () => {
    const { runtime, sendMessage, steer } = createRuntime([], { holdRunUntilAbort: true });
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-pending',
    });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const prompt = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Wait for admission' }],
      });
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

      await expect(
        connection.request('mcode/session/steer', {
          sessionId: session.sessionId,
          text: 'Must not become a new Turn',
        }),
      ).rejects.toThrow('admitted, active ACP prompt Turn');
      expect(steer).not.toHaveBeenCalled();

      await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });
    });
  });

  it('rejects ACP steering when Runtime admission activates or targets another Turn', async () => {
    const { runtime, sendMessage, steer } = createRuntime(
      [
        {
          type: 'delta',
          messageId: 'message-admitted',
          role: 'assistant',
          content: 'Working',
          turnId: 'turn-admitted',
        },
      ],
      { holdRunAfterEvents: true },
    );
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-admitted',
    });
    const updates: acp.SessionNotification[] = [];
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const prompt = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Start admitted work' }],
      });
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(updates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              update: expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
            }),
          ]),
        ),
      );

      steer.mockImplementationOnce(async (input) => {
        await input.preDelivery?.accept({ mode: 'activated', turnId: 'turn-new' });
        return { turnId: 'turn-new', mode: 'steered' };
      });
      await expect(
        connection.request('mcode/session/steer', {
          sessionId: session.sessionId,
          text: 'Do not activate',
        }),
      ).rejects.toThrow('active ACP prompt Turn changed');

      steer.mockImplementationOnce(async (input) => {
        await input.preDelivery?.accept({ mode: 'steered', turnId: 'turn-other' });
        return { turnId: 'turn-other', mode: 'steered' };
      });
      await expect(
        connection.request('mcode/session/steer', {
          sessionId: session.sessionId,
          text: 'Do not steer another Turn',
        }),
      ).rejects.toThrow('active ACP prompt Turn changed');

      await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });
    });
  });

  it('omits and rejects Goal extensions when the Runtime feature gate is disabled', async () => {
    const { runtime, emitRuntimeEvent, createGoal, getGoal, patchGoal, clearGoal } = createRuntime(
      [],
      { goalEnabled: false },
    );
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const goalUpdates: unknown[] = [];
    const client = acp.client({ name: 'test-client' }).onNotification(
      'mcode/session/goal_update',
      (value) => value as { sessionId: string; goal: unknown },
      ({ params }) => goalUpdates.push(params),
    );

    await client.connectWith(agent, async (connection) => {
      const initialized = await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          _meta: { 'minimax-code/extensions': { version: 1, notifications: true } },
        },
      });
      const extensions = initialized._meta?.['minimax-code/extensions'] as {
        methods: string[];
        notifications: string[];
      };
      expect(extensions.methods).not.toEqual(
        expect.arrayContaining([
          'mcode/session/goal/get',
          'mcode/session/goal/create',
          'mcode/session/goal/patch',
          'mcode/session/goal/clear',
        ]),
      );
      expect(extensions.notifications).not.toContain('mcode/session/goal_update');

      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await expect(
        connection.request('mcode/session/goal/create', {
          sessionId: session.sessionId,
          objective: 'Should not persist',
        }),
      ).rejects.toThrow('Goal extensions are disabled');
      const goalGateChecks = vi.mocked(runtime.isGoalEnabled).mock.calls.length;
      emitRuntimeEvent({
        type: 'thread_goal.updated',
        timestampMs: 1,
        source: 'runtime',
        sessionId: 'session-1',
        goal: {
          goalId: 'goal-1',
          sessionId: 'session-1',
          objective: 'Must stay hidden',
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          tokenBudget: null,
          hasKickoffAttachments: false,
        },
      });
      emitRuntimeEvent({
        type: 'thread_goal.cleared',
        timestampMs: 2,
        source: 'runtime',
        sessionId: 'session-1',
        goalId: 'goal-1',
      });
      await vi.waitFor(() =>
        expect(runtime.isGoalEnabled).toHaveBeenCalledTimes(goalGateChecks + 2),
      );
      expect(goalUpdates).toEqual([]);
    });

    expect(getGoal).not.toHaveBeenCalled();
    expect(createGoal).not.toHaveBeenCalled();
    expect(patchGoal).not.toHaveBeenCalled();
    expect(clearGoal).not.toHaveBeenCalled();
  });

  it('projects session info, usage, plans, and opted-in extension notifications', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { runtime, emitRuntimeEvent, listQueuedMessages } = createRuntime([], {
      contextSnapshot: {
        status: 'live',
        model: { provider: 'minimax', id: 'm3', contextWindow: 10_000 },
        contextUsage: {
          contextWindowTokens: 10_000,
          usedTokens: 4_000,
          totalCountSource: 'LOCAL_ESTIMATE',
          components: [],
        },
        compaction: { state: 'never' },
      },
      sessionUsage: { summary: { costUsd: 0.25 } },
    });
    listQueuedMessages.mockResolvedValueOnce([
      {
        itemId: 'queue-1',
        sessionId: 'session-1',
        content: 'Run checks',
        status: 'queued',
        createdAt: 1,
      },
    ]);
    const updates: acp.SessionNotification[] = [];
    const queueUpdates: unknown[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.update.sessionUpdate === 'plan_removed') {
          throw new Error('client disconnected while removing plan');
        }
        updates.push(params);
      })
      .onNotification(
        'mcode/session/queue_update',
        (value) => value as { sessionId: string; items: unknown[] },
        ({ params }) => queueUpdates.push(params),
      )
      .onRequest(acp.methods.client.elicitation.create, () => ({ action: 'cancel' }));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          plan: {},
          elicitation: { form: {} },
          _meta: {
            'minimax-code/extensions': { version: 1, notifications: true },
          },
        },
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent({
        type: 'session.title_updated',
        timestampMs: 1_725_000_000_000,
        source: 'runtime',
        sessionId: 'session-1',
        title: 'ACP control plane',
      });
      emitRuntimeEvent({
        type: 'session.finish',
        timestampMs: 1_725_000_000_001,
        source: 'runtime',
        sessionId: 'session-1',
        queueItemIds: [],
      });
      emitRuntimeEvent({
        type: 'session.queue.updated',
        timestampMs: 1_725_000_000_002,
        source: 'runtime',
        sessionId: 'session-1',
        queuedCount: 1,
      });
      emitRuntimeEvent({
        type: 'questionnaire.ask',
        timestampMs: 1_725_000_000_003,
        source: 'runtime',
        sessionId: 'session-1',
        request: {
          schemaVersion: 1,
          id: 'plan-review-1',
          title: 'Review the plan',
          requester: { sessionId: 'session-1', agentName: 'mcode' },
          presentation: {
            replaceComposer: false,
            showProgress: false,
            allowBackNavigation: false,
          },
          steps: [],
          mode: 'plan',
          modePayload: {
            planReview: { markdown: '# Plan\n\n1. Add ACP controls', path: '/plan.md' },
          },
        },
      });

      await vi.waitFor(() => {
        expect(queueUpdates).toHaveLength(1);
        expect(updates).toContainEqual({
          sessionId: 'session-1',
          update: expect.objectContaining({
            sessionUpdate: 'usage_update',
            used: 4_000,
            size: 10_000,
          }),
        });
        expect(updates).toContainEqual({
          sessionId: 'session-1',
          update: expect.objectContaining({ sessionUpdate: 'plan_update' }),
        });
      });
    });

    expect(updates).toContainEqual({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'session_info_update',
        title: 'ACP control plane',
        updatedAt: '2024-08-30T06:40:00.000Z',
      },
    });
    expect(updates).toContainEqual({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'plan_update',
        plan: {
          type: 'markdown',
          planId: 'plan-review-1',
          content: '# Plan\n\n1. Add ACP controls',
        },
      },
    });
    expect(queueUpdates).toEqual([
      {
        sessionId: 'session-1',
        items: [
          {
            itemId: 'queue-1',
            sessionId: 'session-1',
            content: 'Run checks',
            status: 'queued',
            createdAt: 1,
          },
        ],
      },
    ]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('closes the connection instead of dropping required Plan removals', async () => {
    const { runtime, newSessionId, dismissQuestionnaire, emitRuntimeEvent, getSession } =
      createRuntime();
    let nextSession = 0;
    newSessionId.mockImplementation(() => `session-${nextSession++}`);
    const answerQuestionnaires: Array<(response: acp.CreateElicitationResponse) => void> = [];
    let planUpdates = 0;
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.update.sessionUpdate === 'plan_update') planUpdates += 1;
      })
      .onRequest(
        acp.methods.client.elicitation.create,
        () =>
          new Promise<acp.CreateElicitationResponse>((resolve) => {
            answerQuestionnaires.push(resolve);
          }),
      );

    const operation = client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { plan: {}, elicitation: { form: {} } },
      });
      for (let index = 0; index < 65; index += 1) {
        await connection.request(acp.methods.agent.session.new, {
          cwd: `/workspace/${index}`,
          mcpServers: [],
        });
        emitRuntimeEvent(planReviewEvent(index));
      }
      await vi.waitFor(() => expect(planUpdates).toBe(65));
      await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(65));
      await vi.waitFor(() => expect(answerQuestionnaires).toHaveLength(8));

      const priorSessionReads = getSession.mock.calls.length;
      getSession.mockImplementation(() => new Promise(() => undefined));
      for (let index = 0; index < 8; index += 1) {
        emitRuntimeEvent({
          type: 'session.start',
          timestampMs: 100 + index,
          source: 'runtime',
          sessionId: `session-${index}`,
          turnId: `turn-${index}`,
          queueItemIds: [],
        });
      }
      await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(priorSessionReads + 8));

      for (let settled = 0; settled < 64; ) {
        const nextSettled = Math.min(settled + 8, 64);
        await vi.waitFor(() =>
          expect(answerQuestionnaires.length).toBeGreaterThanOrEqual(nextSettled),
        );
        for (let index = settled; index < nextSettled; index += 1) {
          answerQuestionnaires[index]?.({ action: 'cancel' });
        }
        settled = nextSettled;
        await vi.waitFor(() => expect(dismissQuestionnaire).toHaveBeenCalledTimes(settled));
      }
      await vi.waitFor(() => expect(answerQuestionnaires).toHaveLength(65));
      answerQuestionnaires[64]?.({ action: 'cancel' });
      // Only the Agent closing the connection may settle this operation.
      await new Promise<never>(() => undefined);
    });
    await expect(operation).rejects.toThrow('ACP connection closed');
  });

  it('closes the connection when a required Plan removal expires in the pending queue', async () => {
    const { runtime, newSessionId, emitRuntimeEvent, getSession } = createRuntime();
    let nextSession = 0;
    newSessionId.mockImplementation(() => `session-${nextSession++}`);
    let settlePlan!: (response: acp.CreateElicitationResponse) => void;
    let planDelivered!: () => void;
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      runtimeEventProjectionTimeoutMs: 10,
    });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.update.sessionUpdate === 'plan_update') planDelivered();
      })
      .onRequest(
        acp.methods.client.elicitation.create,
        () =>
          new Promise<acp.CreateElicitationResponse>((resolve) => {
            settlePlan = resolve;
          }),
      );
    const delivered = new Promise<void>((resolve) => {
      planDelivered = resolve;
    });

    const operation = client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { plan: {}, elicitation: { form: {} } },
      });
      for (let index = 0; index < 8; index += 1) {
        await connection.request(acp.methods.agent.session.new, {
          cwd: `/workspace/${index}`,
          mcpServers: [],
        });
      }
      emitRuntimeEvent(planReviewEvent(0));
      await delivered;
      const priorSessionReads = getSession.mock.calls.length;
      getSession.mockImplementation(() => new Promise(() => undefined));
      for (let index = 0; index < 8; index += 1) {
        emitRuntimeEvent({
          type: 'session.start',
          timestampMs: 10 + index,
          source: 'runtime',
          sessionId: `session-${index}`,
          turnId: `turn-${index}`,
          queueItemIds: [],
        });
      }
      await vi.waitFor(() =>
        expect(getSession.mock.calls.length).toBeGreaterThanOrEqual(priorSessionReads + 8),
      );
      settlePlan({ action: 'cancel' });
      // Only the Agent closing the connection may settle this operation.
      await new Promise<never>(() => undefined);
    });
    await expect(operation).rejects.toThrow('ACP connection closed');
  });

  it('does not let a stalled control projection block questionnaire handling', async () => {
    const { runtime, emitRuntimeEvent, getSession, replyQuestionnaire } = createRuntime();
    let resolveStalledProjection:
      | ((session: { sessionId: string; workspaceDir: string; interactionMode: 'plan' }) => void)
      | undefined;
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      runtimeEventProjectionTimeoutMs: 0,
    });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params))
      .onRequest(acp.methods.client.elicitation.create, () => ({
        action: 'accept',
        content: { approach: 'Safe' },
      }));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { elicitation: { form: {} } },
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      getSession.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveStalledProjection = resolve;
          }),
      );
      emitRuntimeEvent({
        type: 'questionnaire.ask',
        timestampMs: 1,
        source: 'runtime',
        sessionId: 'session-1',
        agentName: 'mcode',
        request: {
          schemaVersion: 1,
          id: 'questionnaire-with-stalled-projection',
          title: 'Choose settings',
          requester: { sessionId: 'session-1', agentName: 'mcode' },
          presentation: {
            replaceComposer: false,
            showProgress: false,
            allowBackNavigation: false,
          },
          steps: [
            {
              id: 'approach',
              question: 'Which approach?',
              selectionMode: 'single',
              options: [{ id: 'safe', label: 'Safe' }],
              allowOther: false,
              otherPlaceholder: '',
              required: true,
            },
          ],
        },
      });

      await vi.waitFor(() =>
        expect(replyQuestionnaire).toHaveBeenCalledWith(
          'mcode',
          'questionnaire-with-stalled-projection',
          [{ stepId: 'approach', selectedOptionIds: ['safe'] }],
        ),
      );
      emitRuntimeEvent({
        type: 'session.title_updated',
        timestampMs: 2,
        source: 'runtime',
        sessionId: 'session-1',
        title: 'Projection recovered',
      });
      await vi.waitFor(() =>
        expect(updates).toContainEqual({
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'session_info_update',
            title: 'Projection recovered',
            updatedAt: new Date(2).toISOString(),
          },
        }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      resolveStalledProjection?.({
        sessionId: 'session-1',
        workspaceDir: '/workspace',
        interactionMode: 'plan',
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(updates).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            update: expect.objectContaining({ sessionUpdate: 'current_mode_update' }),
          }),
        ]),
      );
    });
  });

  it('isolates stalled projection lanes and coalesces repeated events within a lane', async () => {
    const { runtime, emitRuntimeEvent, getSession, listQueuedMessages, replyQuestionnaire } =
      createRuntime();
    getSession.mockImplementation(() => new Promise(() => undefined));
    listQueuedMessages.mockImplementation(() => new Promise(() => undefined));
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      runtimeEventProjectionTimeoutMs: 0,
    });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params))
      .onRequest(acp.methods.client.elicitation.create, () => ({
        action: 'accept',
        content: { approach: 'Safe' },
      }));
    const event = (id: string): TuiRuntimeEvent => ({
      type: 'questionnaire.ask',
      timestampMs: 1,
      source: 'runtime',
      sessionId: 'session-1',
      agentName: 'mcode',
      request: {
        schemaVersion: 1,
        id,
        title: 'Choose settings',
        requester: { sessionId: 'session-1', agentName: 'mcode' },
        presentation: {
          replaceComposer: false,
          showProgress: false,
          allowBackNavigation: false,
        },
        steps: [
          {
            id: 'approach',
            question: 'Which approach?',
            selectionMode: 'single',
            options: [{ id: 'safe', label: 'Safe' }],
            allowOther: false,
            otherPlaceholder: '',
            required: true,
          },
        ],
      },
    });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          elicitation: { form: {} },
          _meta: { 'minimax-code/extensions': { version: 1, notifications: true } },
        },
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent(event('stalled-1'));
      emitRuntimeEvent(event('stalled-2'));
      emitRuntimeEvent(event('stalled-3'));
      emitRuntimeEvent({
        type: 'session.queue.updated',
        timestampMs: 2,
        source: 'runtime',
        sessionId: 'session-1',
        queuedCount: 1,
      });
      emitRuntimeEvent({
        type: 'session.title_updated',
        timestampMs: 3,
        source: 'runtime',
        sessionId: 'session-1',
        title: 'Independent projection lane',
      });

      await vi.waitFor(() => expect(replyQuestionnaire).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expect(getSession).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(listQueuedMessages).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(updates).toContainEqual({
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'session_info_update',
            title: 'Independent projection lane',
            updatedAt: new Date(3).toISOString(),
          },
        }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(getSession).toHaveBeenCalledOnce();
      expect(listQueuedMessages).toHaveBeenCalledOnce();
    });
  });

  it('drops a delayed projection after its ACP Session attachment closes', async () => {
    const { runtime, emitRuntimeEvent, getSession } = createRuntime();
    let resolveProjection:
      | ((session: { sessionId: string; workspaceDir: string; interactionMode: 'plan' }) => void)
      | undefined;
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      getSession.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveProjection = resolve;
          }),
      );
      emitRuntimeEvent({
        type: 'session.start',
        timestampMs: 1,
        source: 'runtime',
        sessionId: 'session-1',
        turnId: 'turn-closing',
        queueItemIds: [],
      });
      await vi.waitFor(() => expect(getSession).toHaveBeenCalledOnce());
      await connection.request(acp.methods.agent.session.close, { sessionId: session.sessionId });

      resolveProjection?.({
        sessionId: 'session-1',
        workspaceDir: '/workspace',
        interactionMode: 'plan',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(updates).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            update: expect.objectContaining({ sessionUpdate: 'current_mode_update' }),
          }),
        ]),
      );
    });
  });

  it('does not rebind a pending projection to a replacement attachment', async () => {
    const { runtime, emitRuntimeEvent, getSession } = createRuntime();
    let resolveFirstProjection:
      | ((session: { sessionId: string; workspaceDir: string; interactionMode: 'plan' }) => void)
      | undefined;
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      getSession
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirstProjection = resolve;
            }),
        )
        .mockResolvedValueOnce({
          sessionId: 'session-1',
          workspaceDir: '/workspace',
          interactionMode: 'default',
        });
      emitRuntimeEvent({
        type: 'session.start',
        timestampMs: 1,
        source: 'runtime',
        sessionId: 'session-1',
        turnId: 'turn-old',
        queueItemIds: [],
      });
      await vi.waitFor(() => expect(getSession).toHaveBeenCalledOnce());
      emitRuntimeEvent({
        type: 'questionnaire.dismiss',
        timestampMs: 2,
        source: 'runtime',
        sessionId: 'session-1',
        requestId: 'question-old',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await connection.request(acp.methods.agent.session.resume, {
        sessionId: session.sessionId,
        cwd: '/workspace',
        mcpServers: [],
      });
      expect(getSession).toHaveBeenCalledTimes(2);
      resolveFirstProjection?.({
        sessionId: 'session-1',
        workspaceDir: '/workspace',
        interactionMode: 'plan',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(updates).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            update: expect.objectContaining({ sessionUpdate: 'current_mode_update' }),
          }),
        ]),
      );
      expect(getSession).toHaveBeenCalledTimes(2);
    });
  });

  it('projects finish usage independently when its mode refresh is stalled and superseded', async () => {
    const { runtime, emitRuntimeEvent, getSession } = createRuntime([], {
      contextSnapshot: {
        status: 'live',
        model: { provider: 'minimax', id: 'm3', contextWindow: 10_000 },
        contextUsage: {
          contextWindowTokens: 10_000,
          usedTokens: 2_000,
          totalCountSource: 'LOCAL_ESTIMATE',
          components: [],
        },
        compaction: { state: 'never' },
      },
    });
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      getSession.mockImplementation(() => new Promise(() => undefined));
      emitRuntimeEvent({
        type: 'session.finish',
        timestampMs: 1,
        source: 'runtime',
        sessionId: 'session-1',
        turnId: 'turn-finished',
        queueItemIds: [],
      });
      emitRuntimeEvent({
        type: 'session.start',
        timestampMs: 2,
        source: 'runtime',
        sessionId: 'session-1',
        turnId: 'turn-newer',
        queueItemIds: [],
      });

      await vi.waitFor(() => expect(getSession).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(updates).toContainEqual({
          sessionId: 'session-1',
          update: expect.objectContaining({
            sessionUpdate: 'usage_update',
            used: 2_000,
            size: 10_000,
          }),
        }),
      );
    });
  });

  it('does not coalesce a title update away behind Session activity', async () => {
    const { runtime, emitRuntimeEvent } = createRuntime();
    let releaseActivity!: () => void;
    const activityGate = new Promise<void>((resolve) => {
      releaseActivity = resolve;
    });
    let blockFirstActivity = true;
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, async ({ params }) => {
        updates.push(params);
        if (
          blockFirstActivity &&
          params.update.sessionUpdate === 'session_info_update' &&
          !('title' in params.update)
        ) {
          blockFirstActivity = false;
          await activityGate;
        }
      });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent({
        type: 'session.start',
        timestampMs: 1,
        source: 'runtime',
        sessionId: 'session-1',
        turnId: 'turn-1',
        queueItemIds: [],
      });
      await vi.waitFor(() =>
        expect(updates).toContainEqual({
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'session_info_update',
            updatedAt: new Date(1).toISOString(),
          },
        }),
      );
      emitRuntimeEvent({
        type: 'session.title_updated',
        timestampMs: 2,
        source: 'runtime',
        sessionId: 'session-1',
        title: 'Durable title',
      });
      emitRuntimeEvent({
        type: 'session.finish',
        timestampMs: 3,
        source: 'runtime',
        sessionId: 'session-1',
        turnId: 'turn-1',
        queueItemIds: [],
      });

      await vi.waitFor(() =>
        expect(updates).toContainEqual({
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'session_info_update',
            title: 'Durable title',
            updatedAt: new Date(2).toISOString(),
          },
        }),
      );
      releaseActivity();
    });
  });

  it('serializes mode projections across Runtime event types for one Session', async () => {
    const { runtime, emitRuntimeEvent, getSession } = createRuntime();
    let resolveOlder:
      | ((session: { sessionId: string; workspaceDir: string; interactionMode: 'plan' }) => void)
      | undefined;
    const updates: acp.SessionNotification[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      getSession
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveOlder = resolve;
            }),
        )
        .mockResolvedValueOnce({
          sessionId: 'session-1',
          workspaceDir: '/workspace',
          interactionMode: 'default',
        });
      emitRuntimeEvent({
        type: 'session.start',
        timestampMs: 1,
        source: 'runtime',
        sessionId: 'session-1',
        turnId: 'turn-older',
        queueItemIds: [],
      });
      emitRuntimeEvent({
        type: 'questionnaire.dismiss',
        timestampMs: 2,
        source: 'runtime',
        sessionId: 'session-1',
        requestId: 'question-newer',
      });
      await vi.waitFor(() => expect(getSession).toHaveBeenCalledOnce());
      resolveOlder?.({
        sessionId: 'session-1',
        workspaceDir: '/workspace',
        interactionMode: 'plan',
      });
      await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(
          updates
            .filter(({ update }) => update.sessionUpdate === 'current_mode_update')
            .map(({ update }) =>
              update.sessionUpdate === 'current_mode_update' ? update.currentModeId : undefined,
            ),
        ).toEqual(['plan', 'default']),
      );
    });
  });

  it('caps globally active projection lanes when unique Runtime reads never settle', async () => {
    const { runtime, newSessionId, emitRuntimeEvent, getSession } = createRuntime();
    let nextSession = 0;
    newSessionId.mockImplementation(() => `session-${nextSession++}`);
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, () => undefined);

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      for (let index = 0; index < 12; index += 1) {
        await connection.request(acp.methods.agent.session.new, {
          cwd: `/workspace/${index}`,
          mcpServers: [],
        });
      }
      getSession.mockImplementation(() => new Promise(() => undefined));
      for (let index = 0; index < 12; index += 1) {
        emitRuntimeEvent({
          type: 'session.start',
          timestampMs: index,
          source: 'runtime',
          sessionId: `session-${index}`,
          turnId: `turn-${index}`,
          queueItemIds: [],
        });
      }

      await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(8));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(getSession).toHaveBeenCalledTimes(8);
    });
  });

  it('serializes delegation fan-out and reuses one snapshot for a shared root', async () => {
    const { runtime, createSession, emitRuntimeEvent, getSession, getDelegationSnapshot } =
      createRuntime();
    createSession.mockImplementation(
      async ({ workspaceDir, sessionId }: { workspaceDir: string; sessionId?: string }) => ({
        sessionId: sessionId ?? 'session-1',
        workspaceDir,
        parentSessionId: 'session-root',
      }),
    );
    getSession.mockResolvedValue({ sessionId: 'session-root', workspaceDir: '/workspace' });
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let activeSnapshots = 0;
    let peakSnapshots = 0;
    getDelegationSnapshot.mockImplementation(async (rootSessionId: string) => {
      activeSnapshots += 1;
      peakSnapshots = Math.max(peakSnapshots, activeSnapshots);
      await snapshotGate;
      activeSnapshots -= 1;
      return { schemaVersion: 1, rootSessionId, members: [] };
    });
    const delegationUpdates: unknown[] = [];
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' }).onNotification(
      'mcode/session/delegation_update',
      (params) => params,
      ({ params }) => delegationUpdates.push(params),
    );

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          _meta: { 'minimax-code/extensions': { version: 1, notifications: true } },
        },
      });
      for (let index = 0; index < 3; index += 1) {
        await newRuntimeSession(connection, {
          cwd: `/workspace/${index}`,
          mcpServers: [],
        });
      }
      emitRuntimeEvent({
        type: 'session.created',
        timestampMs: 1,
        source: 'runtime',
        sessionId: 'session-child',
        agentName: 'worker',
        sessionType: 'branch',
        parentSessionId: 'session-root',
      });

      await vi.waitFor(() => expect(getDelegationSnapshot).toHaveBeenCalledOnce());
      expect(activeSnapshots).toBe(1);
      releaseSnapshot();
      await vi.waitFor(() => expect(delegationUpdates).toHaveLength(3));
    });

    expect(getDelegationSnapshot).toHaveBeenCalledOnce();
    expect(peakSnapshots).toBe(1);
  });

  it('rejects a second Client connection to preserve connection-owned ACP state', async () => {
    const { runtime, createSession } = createRuntime();
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const firstClient = acp.client({ name: 'first-client' });
    const secondClient = acp.client({ name: 'second-client' });

    await firstClient.connectWith(agent, async (firstConnection) => {
      await firstConnection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await expect(
        secondClient.connectWith(agent, (secondConnection) =>
          secondConnection.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          }),
        ),
      ).rejects.toThrow('ACP connection closed');

      await newRuntimeSession(firstConnection, {
        cwd: '/workspace',
        mcpServers: [],
      });
      expect(createSession).toHaveBeenCalledOnce();
    });
  });

  it('cancels a stale ACP permission prompt when Runtime resolves the request', async () => {
    const { runtime, emitRuntimeEvent, replyPermission } = createRuntime();
    let firstRequested!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      firstRequested = resolve;
    });
    const client = acp
      .client({ name: 'test-client' })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        if (params.toolCall.toolCallId === 'permission-stale') {
          firstRequested();
          return new Promise<acp.RequestPermissionResponse>(() => undefined);
        }
        return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
      });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent(permissionEvent('permission-stale'));
      await firstRequest;
      emitRuntimeEvent({
        type: 'permission.resolved',
        timestampMs: 2,
        source: 'runtime',
        sessionId: 'session-1',
        requestId: 'permission-stale',
        decision: 'deny',
      });
      emitRuntimeEvent(permissionEvent('permission-next'));
      await vi.waitFor(() =>
        expect(replyPermission).toHaveBeenCalledWith('mcode', 'permission-next', 'allowOnce'),
      );
    });

    expect(replyPermission).not.toHaveBeenCalledWith(
      'mcode',
      'permission-stale',
      expect.anything(),
    );
  });

  it('closes the connection when terminated Client interactions ignore cancellation', async () => {
    const { runtime, emitRuntimeEvent } = createRuntime();
    const requested: string[] = [];
    const client = acp
      .client({ name: 'test-client' })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        requested.push(params.toolCall.toolCallId);
        return new Promise<acp.RequestPermissionResponse>(() => undefined);
      });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });

    const operation = client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      for (let index = 0; index < 3; index += 1) {
        const requestId = `permission-detached-${index}`;
        emitRuntimeEvent(permissionEvent(requestId));
        await vi.waitFor(() => expect(requested).toContain(requestId));
        emitRuntimeEvent({
          type: 'permission.resolved',
          timestampMs: 2 + index,
          source: 'runtime',
          sessionId: 'session-1',
          requestId,
          decision: 'deny',
        });
      }
      // Only the Agent closing the connection may settle this operation.
      await new Promise<never>(() => undefined);
    });
    await expect(operation).rejects.toThrow('ACP connection closed');
  });

  it('does not let an old attachment terminal event terminate a reused request id', async () => {
    const { runtime, emitRuntimeEvent, replyPermission } = createRuntime();
    const answers: Array<(response: acp.RequestPermissionResponse) => void> = [];
    const client = acp.client({ name: 'test-client' }).onRequest(
      acp.methods.client.session.requestPermission,
      () =>
        new Promise<acp.RequestPermissionResponse>((resolve) => {
          answers.push(resolve);
        }),
    );
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent(permissionEvent('permission-reused'));
      await vi.waitFor(() => expect(answers).toHaveLength(1));
      await connection.request(acp.methods.agent.session.resume, {
        sessionId: session.sessionId,
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent(permissionEvent('permission-reused'));
      await vi.waitFor(() => expect(answers).toHaveLength(2));

      emitRuntimeEvent({
        type: 'permission.resolved',
        timestampMs: 2,
        source: 'runtime',
        sessionId: 'session-1',
        requestId: 'permission-reused',
        decision: 'deny',
      });
      answers[1]?.({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
      await vi.waitFor(() =>
        expect(replyPermission).toHaveBeenCalledWith('mcode', 'permission-reused', 'allowOnce'),
      );
    });
  });

  it('consumes duplicate request terminals one interaction at a time', async () => {
    const { runtime, emitRuntimeEvent, replyPermission } = createRuntime();
    const answers: Array<(response: acp.RequestPermissionResponse) => void> = [];
    const client = acp.client({ name: 'test-client' }).onRequest(
      acp.methods.client.session.requestPermission,
      () =>
        new Promise<acp.RequestPermissionResponse>((resolve) => {
          answers.push(resolve);
        }),
    );
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent(permissionEvent('permission-duplicate'));
      emitRuntimeEvent(permissionEvent('permission-duplicate'));
      await vi.waitFor(() => expect(answers).toHaveLength(1));
      emitRuntimeEvent({
        type: 'permission.resolved',
        timestampMs: 2,
        source: 'runtime',
        sessionId: 'session-1',
        requestId: 'permission-duplicate',
        decision: 'deny',
      });
      await vi.waitFor(() => expect(answers).toHaveLength(2));
      answers[1]?.({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
      await vi.waitFor(() =>
        expect(replyPermission).toHaveBeenCalledWith('mcode', 'permission-duplicate', 'allowOnce'),
      );
    });
  });

  it('settles a blocked Prompt when Runtime dismisses its Questionnaire', async () => {
    const { runtime, emitRuntimeEvent, dismissQuestionnaire } = createRuntime();
    let releaseBlockedRun!: () => void;
    const blockedRun = new Promise<void>((resolve) => {
      releaseBlockedRun = resolve;
    });
    let markRunStarted!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    vi.mocked(runtime.sendMessage).mockImplementation(() =>
      (async function* blockedRunEvents() {
        markRunStarted();
        await blockedRun;
        yield {
          type: 'generic',
          eventType: 'runtime.action-required',
          data: { kind: 'questionnaire' },
          turnId: 'turn-dismissed',
        } as const;
      })(),
    );
    let questionnaireRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      questionnaireRequested = resolve;
    });
    const client = acp
      .client({ name: 'test-client' })
      .onRequest(acp.methods.client.elicitation.create, () => {
        questionnaireRequested();
        return new Promise<acp.CreateElicitationResponse>(() => undefined);
      });
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      createTurnId: () => 'turn-dismissed',
    });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { elicitation: { form: {} } },
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const prompt = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Ask and then expire' }],
      });
      await runStarted;
      emitRuntimeEvent(questionnaireEvent('questionnaire-expired'));
      await requested;
      emitRuntimeEvent({
        type: 'questionnaire.dismiss',
        timestampMs: 2,
        source: 'runtime',
        sessionId: 'session-1',
        requestId: 'questionnaire-expired',
      });
      releaseBlockedRun();

      await expect(prompt).resolves.toMatchObject({ stopReason: 'end_turn' });
    });

    expect(dismissQuestionnaire).not.toHaveBeenCalledWith('mcode', 'questionnaire-expired');
  });

  it('stops a Questionnaire continuation when Runtime aborts its Turn', async () => {
    const continuation = new TuiAcpPromptContinuation('session-1', 'turn-aborted');
    continuation.observe(questionnaireEvent('questionnaire-aborted'));
    continuation.observe({
      type: 'session.abort',
      timestampMs: 2,
      source: 'runtime',
      sessionId: 'session-1',
      turnId: 'turn-aborted',
      queueItemIds: [],
    });

    await expect(
      continuation.waitForTransition('turn-aborted', new AbortController().signal, {
        requireQuestion: true,
      }),
    ).resolves.toEqual({ kind: 'cancelled' });
  });

  it('preserves the last mode selection made while a Prompt is running', async () => {
    const { runtime, getSession } = createRuntime();
    getSession.mockResolvedValue({
      sessionId: 'session-1',
      workspaceDir: '/workspace',
      interactionMode: 'default',
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const requests: Array<{ clientIntent?: string }> = [];
    vi.mocked(runtime.sendMessage).mockImplementation((request) =>
      (async function* modeRuns() {
        requests.push(request);
        if (requests.length === 1) await firstGate;
        yield { type: 'session-status', status: 'finished', turnId: request.turnId } as const;
      })(),
    );
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.setMode, {
        sessionId: session.sessionId,
        modeId: 'plan',
      });
      const firstPrompt = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Plan first' }],
      });
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      await expect(
        connection.request(acp.methods.agent.session.setMode, {
          sessionId: session.sessionId,
          modeId: 'default',
        }),
      ).resolves.toEqual({ _meta: { 'minimax-code/transition': 'next_prompt' } });
      releaseFirst();
      await expect(firstPrompt).resolves.toMatchObject({ stopReason: 'end_turn' });
      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Stay in default mode' }],
        }),
      ).resolves.toMatchObject({ stopReason: 'end_turn' });
    });

    expect(requests.map(({ clientIntent }) => clientIntent)).toEqual(['plan-entry', 'plan-exit']);
  });

  it('removes a delivered Plan when the Session attachment is replaced', async () => {
    const { runtime, emitRuntimeEvent } = createRuntime();
    const updates: acp.SessionNotification[] = [];
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params))
      .onRequest(
        acp.methods.client.elicitation.create,
        () => new Promise<acp.CreateElicitationResponse>(() => undefined),
      );
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { plan: {}, elicitation: { form: {} } },
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      emitRuntimeEvent(planReviewEvent(1));
      await vi.waitFor(() =>
        expect(updates).toContainEqual({
          sessionId: 'session-1',
          update: expect.objectContaining({
            sessionUpdate: 'plan_update',
            plan: expect.objectContaining({ planId: 'plan-1' }),
          }),
        }),
      );
      await connection.request(acp.methods.agent.session.resume, {
        sessionId: session.sessionId,
        cwd: '/workspace',
        mcpServers: [],
      });
      await vi.waitFor(() =>
        expect(updates).toContainEqual({
          sessionId: 'session-1',
          update: { sessionUpdate: 'plan_removed', planId: 'plan-1' },
        }),
      );
    });
  });

  it('serializes fork MCP initialization with a concurrent resume', async () => {
    const { runtime, clearSessionMcpServers, configureSessionMcpServers } = createRuntime();
    let releaseForkMcp!: () => void;
    const forkMcpGate = new Promise<void>((resolve) => {
      releaseForkMcp = resolve;
    });
    configureSessionMcpServers.mockImplementation(async (_sessionId, servers) => {
      if (servers[0]?.name === 'fork-tools') await forkMcpGate;
    });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      clearSessionMcpServers.mockClear();
      const fork = connection.request(acp.methods.agent.session.fork, {
        sessionId: session.sessionId,
        cwd: '/workspace',
        mcpServers: [{ name: 'fork-tools', command: '/bin/fork', args: [], env: [] }],
      });
      await vi.waitFor(() =>
        expect(configureSessionMcpServers).toHaveBeenCalledWith(
          'session-fork',
          expect.arrayContaining([expect.objectContaining({ name: 'fork-tools' })]),
        ),
      );
      const resume = connection.request(acp.methods.agent.session.resume, {
        sessionId: 'session-fork',
        cwd: '/workspace',
        mcpServers: [{ name: 'resume-tools', command: '/bin/resume', args: [], env: [] }],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(clearSessionMcpServers).not.toHaveBeenCalled();
      releaseForkMcp();
      await expect(fork).resolves.toMatchObject({ sessionId: 'session-fork' });
      await expect(resume).resolves.toMatchObject({ modes: { currentModeId: 'default' } });
    });

    expect(configureSessionMcpServers.mock.calls.map(([, servers]) => servers[0]?.name)).toEqual([
      'fork-tools',
      'resume-tools',
    ]);
  });

  it('finishes failed fork cleanup before admitting a resume for the fork target', async () => {
    const { runtime, clearSessionMcpServers, configureSessionMcpServers, deleteSession } =
      createRuntime();
    let failForkMcp!: () => void;
    const forkMcpGate = new Promise<void>((resolve) => {
      failForkMcp = resolve;
    });
    configureSessionMcpServers.mockImplementation(async (_sessionId, servers) => {
      if (servers[0]?.name === 'fork-tools') {
        await forkMcpGate;
        throw new Error('fork MCP failed');
      }
    });
    let finishDelete!: () => void;
    deleteSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const source = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      clearSessionMcpServers.mockClear();
      const fork = connection.request(acp.methods.agent.session.fork, {
        sessionId: source.sessionId,
        cwd: '/workspace',
        mcpServers: [{ name: 'fork-tools', command: '/bin/fork', args: [], env: [] }],
      });
      void fork.catch(() => undefined);
      await vi.waitFor(() => expect(configureSessionMcpServers).toHaveBeenCalledOnce());
      const resume = connection.request(acp.methods.agent.session.resume, {
        sessionId: 'session-fork',
        cwd: '/workspace',
        mcpServers: [{ name: 'resume-tools', command: '/bin/resume', args: [], env: [] }],
      });
      failForkMcp();
      await vi.waitFor(() => expect(deleteSession).toHaveBeenCalledWith('session-fork'));
      expect(clearSessionMcpServers).not.toHaveBeenCalled();
      finishDelete();
      await expect(fork).rejects.toThrow();
      await expect(resume).resolves.toMatchObject({ modes: { currentModeId: 'default' } });
    });

    expect(clearSessionMcpServers).toHaveBeenCalledWith('session-fork');
  });

  it('fails a cancelled load immediately when its history read never returns', async () => {
    const { runtime, clearSessionMcpServers, listMessagePage } = createRuntime();
    listMessagePage.mockImplementation(() => new Promise(() => undefined));
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      clearSessionMcpServers.mockClear();
      const cancellation = new AbortController();
      const load = connection.request(
        acp.methods.agent.session.load,
        { sessionId: session.sessionId, cwd: '/workspace', mcpServers: [] },
        { cancellationSignal: cancellation.signal },
      );
      await vi.waitFor(() => expect(listMessagePage).toHaveBeenCalledOnce());
      cancellation.abort();
      await expect(load).rejects.toThrow('cancel');
      await vi.waitFor(() => expect(clearSessionMcpServers).toHaveBeenCalledTimes(2));
      await expect(
        connection.request(acp.methods.agent.session.close, { sessionId: session.sessionId }),
      ).rejects.toThrow();
    });
  });

  it('does not commit a first attachment when cancellation wins the final MCP boundary', async () => {
    const { runtime, clearSessionMcpServers, configureSessionMcpServers } = createRuntime();
    const cancellation = new AbortController();
    configureSessionMcpServers.mockImplementationOnce(async () => {
      cancellation.abort();
    });
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const resume = connection.request(
        acp.methods.agent.session.resume,
        {
          sessionId: 'session-existing',
          cwd: '/workspace',
          mcpServers: [{ name: 'client-tools', command: '/bin/client-tools', args: [], env: [] }],
        },
        { cancellationSignal: cancellation.signal },
      );

      await expect(resume).rejects.toThrow('cancel');
      await vi.waitFor(() => expect(clearSessionMcpServers.mock.calls.length).toBeGreaterThan(1));
      await expect(
        connection.request(acp.methods.agent.session.close, {
          sessionId: 'session-existing',
        }),
      ).rejects.toThrow();
    });
  });

  it('fails closed for unsupported additional directories', async () => {
    const { runtime, createSession } = createRuntime();
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3' });
    const client = acp.client({ name: 'test-client' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await expect(
        connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          additionalDirectories: ['/other'],
          mcpServers: [],
        }),
      ).rejects.toThrow('Additional directories are not supported by MiniMax Code ACP');
    });

    expect(createSession).not.toHaveBeenCalled();
  });
});

function permissionEvent(requestId: string, sessionId = 'session-1'): TuiRuntimeEvent {
  return {
    type: 'permission.ask',
    timestampMs: 1,
    source: 'runtime',
    sessionId,
    request: {
      requestId,
      sessionId,
      agentName: 'mcode',
      toolName: 'edit_file',
      allowAlwaysSupported: false,
    },
  };
}

function questionnaireEvent(requestId: string): TuiRuntimeEvent {
  return {
    type: 'questionnaire.ask',
    timestampMs: 1,
    source: 'runtime',
    sessionId: 'session-1',
    agentName: 'mcode',
    request: {
      schemaVersion: 1,
      id: requestId,
      requester: { sessionId: 'session-1', agentName: 'mcode' },
      presentation: {
        replaceComposer: false,
        showProgress: false,
        allowBackNavigation: false,
      },
      steps: [
        {
          id: 'approach',
          question: 'Which approach?',
          selectionMode: 'single',
          options: [{ id: 'safe', label: 'Safe' }],
          allowOther: false,
          otherPlaceholder: '',
          required: true,
        },
      ],
    },
  };
}

function planReviewEvent(index: number): TuiRuntimeEvent {
  const sessionId = `session-${index}`;
  return {
    type: 'questionnaire.ask',
    timestampMs: index,
    source: 'runtime',
    sessionId,
    agentName: 'mcode',
    request: {
      schemaVersion: 1,
      id: `plan-${index}`,
      requester: { sessionId, agentName: 'mcode' },
      presentation: {
        replaceComposer: false,
        showProgress: false,
        allowBackNavigation: false,
      },
      steps: [],
      mode: 'plan',
      modePayload: {
        planReview: { markdown: `# Plan ${index}`, path: `/plan-${index}.md` },
      },
    },
  };
}
