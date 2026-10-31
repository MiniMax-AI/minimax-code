import { describe, expect, it, vi } from 'vitest';

import { startBackgroundLocalTask } from '../../src/background-task/runner.js';
import { runForegroundLocalTask } from '../../src/api/local-task-runner.js';
import type { LocalTaskRunnerHostWithSessionLookup } from '../../src/api/local-task-host.js';
import type { LocalSessionRecord } from '../../src/sessions/controller.js';

const PLUGIN_AGENT = {
  scopedName: 'review:security',
  pluginName: 'review',
  agentName: 'security',
  sourceFormat: 'minimax' as const,
  packageDigest: 'sha256:review',
  pluginRoot: '/plugins/review',
  description: 'Reviews security-sensitive changes.',
  systemPrompt: 'You review security.',
  tools: ['read'],
};

function sessionRecord(sessionId: string, overrides: Partial<LocalSessionRecord> = {}) {
  return {
    sessionId,
    agentName: 'mavis',
    workspaceDir: '/workspace',
    runtime: 'pi-agent',
    sessionType: 'branch',
    archived: false,
    status: 'idle',
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  } as LocalSessionRecord;
}

function createHost(completion: Promise<unknown>) {
  const createInputs: Record<string, unknown>[] = [];
  const unknownAgent = async (): Promise<never> => {
    throw Object.assign(new Error('unknown agent'), { code: 'UNKNOWN_AGENT_NAME' });
  };
  const backgroundTaskService = {
    create: vi.fn(async (task: unknown) => task),
    patch: vi.fn(async () => ({})),
    patchIfNotTerminal: vi.fn(async () => ({ task: {}, patched: true })),
    appendOutput: vi.fn(async () => ({
      taskId: 'task',
      kind: 'session_transcript' as const,
      uri: 'memory://output',
    })),
    finalizeOutput: vi.fn(async () => undefined),
    markDelivered: vi.fn(async () => []),
  };
  const host = {
    agentName: 'mavis',
    agentDisplayName: 'Mavis',
    agentResolver: {
      resolveAgentReadScope: unknownAgent,
      resolveAgentWriteTarget: unknownAgent,
      requireExactAgentKey: unknownAgent,
      resolveAgentExecutionTarget: unknownAgent,
    },
    runtimeConversation: {
      ingress: {
        submit: vi.fn(async () => ({ turnId: 'turn-task', completion })),
      },
    },
    agentRoutes: {
      createSession: async (input: Record<string, unknown>) => {
        createInputs.push(input);
        return sessionRecord('child', { parentSessionId: 'parent', agentName: 'worker' });
      },
    },
    backgroundTaskService,
    nowMs: () => 2_000,
    configGetter: () => ({ dataDir: '/tmp/plugin-agent-task-data' }),
    resolveDefaultWorkspaceDir: () => '/fallback',
    acquireSessionTurnLock: async () => undefined,
  } as unknown as LocalTaskRunnerHostWithSessionLookup;
  return { host, createInputs, backgroundTaskService };
}

function toolContext(pluginAgents?: { list(): unknown[]; resolve(name: string): unknown }) {
  return {
    sessionId: 'parent',
    turnId: 'turn-parent',
    agentName: 'mavis',
    toolCallId: 'call-task',
    ...(pluginAgents ? { pluginAgents } : {}),
  };
}

const roster = {
  list: () => [PLUGIN_AGENT],
  resolve: (name: string) =>
    name.trim().toLowerCase() === PLUGIN_AGENT.scopedName ? PLUGIN_AGENT : undefined,
};

describe('Plugin Agent Task runners', () => {
  it('starts a background Plugin Agent under the worker owner with the trusted definition', async () => {
    const { host, createInputs, backgroundTaskService } = createHost(new Promise(() => undefined));
    const result = await startBackgroundLocalTask({
      host,
      parentSession: sessionRecord('parent'),
      toolCtx: toolContext(roster) as never,
      taskInput: {
        agent_name: 'Review:Security',
        description: 'Audit auth',
        prompt: 'Audit the auth change',
      },
    });

    expect(result).toMatchObject({ status: 'started', subSessionId: 'child' });
    expect(createInputs).toHaveLength(1);
    expect(createInputs[0]).toMatchObject({
      agentName: 'worker',
      sessionKind: 'task',
      parentSessionId: 'parent',
      pluginAgentDefinition: PLUGIN_AGENT,
    });
    expect(backgroundTaskService.patch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        metadata: expect.objectContaining({ agentName: 'review:security' }),
      }),
    );
  });

  it('reports the scoped name to Plugin Hooks for a foreground Plugin Agent', async () => {
    const { host, createInputs } = createHost(
      Promise.resolve({
        turnId: 'turn-task',
        status: 'failed' as const,
        messages: [],
        error: 'Conversation turn failed',
      }),
    );
    const start = vi.fn(async () => undefined);
    const result = await runForegroundLocalTask({
      host,
      parentSession: sessionRecord('parent'),
      toolCtx: {
        ...toolContext(roster),
        pluginSubagentLifecycle: { start, cancel: vi.fn(), stop: vi.fn() },
      } as never,
      taskInput: {
        agent_name: 'review:security',
        description: 'Audit auth',
        prompt: 'Audit the auth change',
      },
    });

    expect(result).toMatchObject({ resolvedAgentName: 'review:security', subSessionId: 'child' });
    expect(createInputs[0]).toMatchObject({
      agentName: 'worker',
      pluginAgentDefinition: PLUGIN_AGENT,
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ agentType: 'review:security', childSessionId: 'child' }),
      undefined,
    );
  });

  it('fails closed for a scoped name when the Turn has no Plugin Agent roster', async () => {
    const { host, createInputs } = createHost(new Promise(() => undefined));
    const result = await runForegroundLocalTask({
      host,
      parentSession: sessionRecord('parent'),
      toolCtx: toolContext() as never,
      taskInput: {
        agent_name: 'review:security',
        description: 'Audit auth',
        prompt: 'Audit the auth change',
      },
    });

    expect(result).toMatchObject({ status: 'failed', errorMessage: 'Unknown agent: review:security' });
    expect(createInputs).toHaveLength(0);
  });
});
