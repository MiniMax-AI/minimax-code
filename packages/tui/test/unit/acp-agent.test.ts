import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';

import { TUI_ACP_AVAILABLE_COMMANDS } from '../../src/acp/commands.js';
import { createTuiAcpAgent } from '../../src/acp/agent.js';
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
  const createSession = vi.fn(async ({ workspaceDir }: { workspaceDir: string }) => ({
    sessionId: 'session-1',
    workspaceDir,
  }));
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
  const getSessionForkOptions = vi.fn(async () => ({
    canFork: true,
    worktreeVisible: false,
    worktreeEligible: false,
  }));
  const forkSession = vi.fn(async () => ({
    session: { sessionId: 'session-fork', workspaceDir: '/workspace' },
  }));
  const runtime = {
    createSession,
    configureSessionMcpServers,
    clearSessionMcpServers,
    deleteSession,
    listSessionPage,
    getSession,
    listMessagePage,
    getAccountStatus: vi.fn(
      async () => options.accountStatus ?? { status: 'ready' as const, warnings: [] },
    ),
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
    createSession,
    configureSessionMcpServers,
    clearSessionMcpServers,
    deleteSession,
    listSessionPage,
    getSession,
    listMessagePage,
    sendMessage: sendMessageCall,
    abortSession,
    listModels,
    selectModel,
    selectSessionModel,
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
    getSessionForkOptions,
    forkSession,
    replyPermission: runtime.replyPermission,
    replyQuestionnaire: runtime.replyQuestionnaire,
    dismissQuestionnaire: runtime.dismissQuestionnaire,
    emitRuntimeEvent(event: TuiRuntimeEvent) {
      const deliver = deliverRuntimeEvent;
      deliverRuntimeEvent = undefined;
      if (deliver) deliver(event);
      else queuedRuntimeEvents.push(event);
    },
  };
}

describe('MiniMax Code ACP agent', () => {
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
        ).resolves.toEqual({ stopReason: 'end_turn' });
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
    expect(listModels).toHaveBeenNthCalledWith(1, 'session-1');
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
      ).resolves.toEqual({ stopReason: 'end_turn' });
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
      ).resolves.toEqual({ stopReason: 'end_turn' });
    });

    expect(listModels).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      {
        id: 'session-1',
        turnId: 'turn-unknown-command',
        content: '/not-advertised keep this',
      },
      expect.any(AbortSignal),
    );
  });

  it('negotiates truthful capabilities and runs a prompt through the local Runtime', async () => {
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
            image: false,
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
        authMethods: [
          {
            type: 'terminal',
            id: 'minimax-code-login',
            name: 'Sign in to MiniMax Code',
            args: ['login'],
          },
        ],
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
      ).resolves.toEqual({ stopReason: 'end_turn' });
    });

    expect(createSession).toHaveBeenCalledWith({ workspaceDir: '/workspace' });
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

  it('cleans up cancelled new Sessions and bounds stalled creation generations', async () => {
    const { runtime, createSession, deleteSession, listModels } = createRuntime();
    let nextSession = 0;
    createSession.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => ({
      sessionId: `session-new-${nextSession++}`,
      workspaceDir,
    }));
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
      await vi.waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(8));

      await expect(
        connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace/overflow',
          mcpServers: [],
        }),
      ).rejects.toThrow('Too many ACP Session creation operations');
      for (let index = 0; index < 8; index += 1) {
        await expect(
          connection.request(acp.methods.agent.session.close, {
            sessionId: `session-new-${index}`,
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

  it('serializes resume behind cancelled new Session deletion', async () => {
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
      await vi.waitFor(() => expect(deleteSession).toHaveBeenCalledWith('session-1'));
      await expect(resume).rejects.toThrow();
      expect(getSession).toHaveBeenCalledWith('session-1');
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
      ).resolves.toEqual({ stopReason: 'end_turn' });

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
      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
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
      const session = await connection.request(acp.methods.agent.session.new, {
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
      await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
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
      const session = await connection.request(acp.methods.agent.session.new, {
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
      const session = await connection.request(acp.methods.agent.session.new, {
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
      const session = await connection.request(acp.methods.agent.session.new, {
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
    configureSessionMcpServers.mockRejectedValueOnce(new Error('MCP configuration failed'));
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
            name: 'old-tools',
            command: '/usr/local/bin/old-tools',
            args: [],
            env: [],
          },
        ],
      });

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
    expect(configureSessionMcpServers).toHaveBeenCalledOnce();
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
        expect(initialized.authMethods).toEqual([
          {
            type: 'terminal',
            id: 'minimax-code-login',
            name: 'Sign in to MiniMax Code',
            args: ['login'],
          },
        ]);
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
    const { runtime, createSession, emitRuntimeEvent, replyPermission } = createRuntime();
    let nextSession = 0;
    createSession.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => ({
      sessionId: `session-${nextSession++}`,
      workspaceDir,
    }));
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

    await client
      .connectWith(agent, async (connection) => {
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

        await vi.waitFor(() => expect(connection.signal.aborted).toBe(true), { timeout: 3_000 });
      })
      .catch(() => undefined);

    expect(replyPermission).toHaveBeenCalledWith('mcode', 'permission-72', 'deny');
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

      await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
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

      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
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

      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
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
    });

    expect(createSession).toHaveBeenCalledWith({
      workspaceDir: '/workspace',
      mcpServers: [
        {
          name: 'client-tools',
          type: 'stdio',
          command: '/usr/local/bin/client-tools',
          args: ['serve'],
          env: { CLIENT_TOKEN: 'test-token' },
        },
      ],
    });
  });

  it('passes client-provided HTTP and SSE MCP servers into the Runtime session', async () => {
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
    });

    expect(createSession).toHaveBeenCalledWith({
      workspaceDir: '/workspace',
      mcpServers: [
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
      ],
    });
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
              thinkingConfig: { defaultValue: 'low' },
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
      const session = await connection.request(acp.methods.agent.session.new, {
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
      ).resolves.toEqual({ stopReason: 'end_turn' });
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

    await client
      .connectWith(agent, async (connection) => {
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
        await vi.waitFor(() => expect(connection.signal.aborted).toBe(true));
      })
      .catch(() => undefined);

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
      const session = await connection.request(acp.methods.agent.session.new, {
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

  it('advertises an empty selected variant when supportedVariants is omitted', async () => {
    const { runtime, selectSessionModel } = createRuntime([], {
      models: [
        {
          providerId: 'minimax',
          modelId: 'm3',
          selected: true,
          variant: '',
          effortOptions: ['low'],
          thinkingConfig: { defaultValue: 'low' },
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
          mcpServers: [],
        }),
      ).resolves.toMatchObject({ sessionId: 'session-fork' });
    });

    expect(configureSessionMcpServers).not.toHaveBeenCalled();
  });

  it('deletes a durable fork without waiting for MCP clear after configuration fails', async () => {
    const { runtime, configureSessionMcpServers, clearSessionMcpServers, deleteSession } =
      createRuntime();
    configureSessionMcpServers.mockRejectedValue(new Error('MCP startup failed'));
    clearSessionMcpServers.mockImplementation(() => new Promise(() => undefined));
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
      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
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
      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
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
      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
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
    const { runtime, createSession, dismissQuestionnaire, emitRuntimeEvent, getSession } =
      createRuntime();
    let nextSession = 0;
    createSession.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => ({
      sessionId: `session-${nextSession++}`,
      workspaceDir,
    }));
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

    await client
      .connectWith(agent, async (connection) => {
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
        await vi.waitFor(() => expect(connection.signal.aborted).toBe(true));
      })
      .catch(() => undefined);
  });

  it('closes the connection when a required Plan removal notification never settles', async () => {
    const { runtime, emitRuntimeEvent } = createRuntime();
    let releaseQuestionnaire!: (response: acp.CreateElicitationResponse) => void;
    const questionnaire = new Promise<acp.CreateElicitationResponse>((resolve) => {
      releaseQuestionnaire = resolve;
    });
    let planDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => {
      planDelivered = resolve;
    });
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      runtimeEventProjectionTimeoutMs: 10,
    });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.update.sessionUpdate === 'plan_update') planDelivered();
        if (params.update.sessionUpdate === 'plan_removed') {
          return new Promise<void>(() => undefined);
        }
      })
      .onRequest(acp.methods.client.elicitation.create, () => questionnaire);

    await client
      .connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { plan: {}, elicitation: { form: {} } },
        });
        await connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          mcpServers: [],
        });
        emitRuntimeEvent(planReviewEvent(1));
        await delivered;
        releaseQuestionnaire({ action: 'cancel' });
        await vi.waitFor(() => expect(connection.signal.aborted).toBe(true));
      })
      .catch(() => undefined);
  });

  it('closes the connection when a required Plan removal expires in the pending queue', async () => {
    const { runtime, createSession, emitRuntimeEvent, getSession } = createRuntime();
    let nextSession = 0;
    createSession.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => ({
      sessionId: `session-${nextSession++}`,
      workspaceDir,
    }));
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

    await client
      .connectWith(agent, async (connection) => {
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
        await vi.waitFor(() => expect(connection.signal.aborted).toBe(true));
      })
      .catch(() => undefined);
  });

  it('closes the connection when attachment replacement cannot confirm prior Plan delivery', async () => {
    const { runtime, emitRuntimeEvent } = createRuntime();
    let planNotificationStarted!: () => void;
    const planNotification = new Promise<void>((resolve) => {
      planNotificationStarted = resolve;
    });
    const agent = createTuiAcpAgent({
      runtime,
      version: '1.2.3',
      runtimeEventProjectionTimeoutMs: 10,
    });
    const client = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.update.sessionUpdate === 'plan_update') {
          planNotificationStarted();
          return new Promise<void>(() => undefined);
        }
      })
      .onRequest(
        acp.methods.client.elicitation.create,
        () => new Promise<acp.CreateElicitationResponse>(() => undefined),
      );

    await client
      .connectWith(agent, async (connection) => {
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { plan: {}, elicitation: { form: {} } },
        });
        const session = await connection.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          mcpServers: [],
        });
        emitRuntimeEvent(planReviewEvent(1));
        await planNotification;
        await connection.request(acp.methods.agent.session.resume, {
          sessionId: session.sessionId,
          cwd: '/workspace',
          mcpServers: [],
        });
        await vi.waitFor(() => expect(connection.signal.aborted).toBe(true));
      })
      .catch(() => undefined);
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
    const { runtime, createSession, emitRuntimeEvent, getSession } = createRuntime();
    let nextSession = 0;
    createSession.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => ({
      sessionId: `session-${nextSession++}`,
      workspaceDir,
    }));
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
    let nextSession = 1;
    createSession.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => ({
      sessionId: `session-${nextSession++}`,
      workspaceDir,
      parentSessionId: 'session-root',
    }));
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
        await connection.request(acp.methods.agent.session.new, {
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

      await firstConnection.request(acp.methods.agent.session.new, {
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

    await client
      .connectWith(agent, async (connection) => {
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
        await vi.waitFor(() => expect(connection.signal.aborted).toBe(true));
      })
      .catch(() => undefined);
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

      await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
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
      await expect(firstPrompt).resolves.toEqual({ stopReason: 'end_turn' });
      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Stay in default mode' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
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
