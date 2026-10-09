import type { RuntimeTool } from '@mavis/agent-core/tools';
import type { McpToolEntry } from '@mavis/agent-tools';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GOAL_VERIFIER_READONLY_PROFILE, resolveAgentCapabilities } from '@mavis/config';
import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import { GoalVerifierChildCoordinator } from '../../../src/application/agent/goal-subagent-coordinator.js';
import { renderGoalVerifierReminder } from '../../../src/application/agent/goal-verifier-reminder.js';
import { BuiltinAgentCatalog } from '../../../src/service/agent/builtin/catalog.js';
import { createLocalTurnToolCatalogInput } from '../../../src/service/turn-system/agent-host/assembly/local-turn-tool-catalog-source.js';
import { buildLocalTurnToolCatalog } from '../../../src/service/turn-system/agent-host/assembly/local-turn-tool-catalog.js';

const HOST_PROVIDER = 'worker-provider';
const VIOLATION = 'GOAL_VERIFIER_CAPABILITY_VIOLATION';

function register(
  coordinator: GoalVerifierChildCoordinator,
  options: { readonly maxTurns?: number } = {},
): void {
  coordinator.register({
    runId: 'run-1',
    workerRouteProvider: HOST_PROVIDER,
    hostContext: { settlement: {} } as never,
    ...options,
  });
}

/** Minimal `before_tool_call` context: the guard only reads the tool name. */
function toolCall(name: string): never {
  return { toolCall: { name } } as never;
}

/** Starts the next child turn and asserts the host let it run. */
function nextTurn(coordinator: GoalVerifierChildCoordinator): void {
  expect(coordinator.beforeLlm('run-1', HOST_PROVIDER)).toBeUndefined();
}

describe('Goal verifier child network tool guard', () => {
  it('refuses a network tool once without aborting the run', () => {
    const coordinator = new GoalVerifierChildCoordinator();
    register(coordinator);
    nextTurn(coordinator);

    const refused = coordinator.beforeTool('run-1', toolCall('web_fetch'));

    expect(refused?.block).toBe(true);
    expect(refused?.reason).not.toContain(VIOLATION);
    expect(refused?.reason).toContain('offline');
    expect(refused?.reason).toContain('local evidence');
    expect(refused?.reason).toContain('PARTIAL');
    // Before the fix the refusal latched a violation and this turn was aborted,
    // which surfaced as `paused(verifier_capability)`.
    nextTurn(coordinator);
    expect(coordinator.release('run-1')?.issue).toBeUndefined();
  });

  it('counts parallel network calls from one model response as one turn', () => {
    const coordinator = new GoalVerifierChildCoordinator();
    register(coordinator);
    nextTurn(coordinator);

    for (const name of ['web_fetch', 'web_search', 'web_fetch', 'web_search']) {
      const refused = coordinator.beforeTool('run-1', toolCall(name));
      expect(refused?.block).toBe(true);
      expect(refused?.reason).not.toContain(VIOLATION);
    }

    nextTurn(coordinator);
    expect(coordinator.release('run-1')?.issue).toBeUndefined();
  });

  it('latches a capability violation when network tools are called in consecutive turns', () => {
    const coordinator = new GoalVerifierChildCoordinator();
    register(coordinator);
    nextTurn(coordinator);
    coordinator.beforeTool('run-1', toolCall('web_fetch'));
    nextTurn(coordinator);

    const latched = coordinator.beforeTool('run-1', toolCall('web_search'));

    expect(latched).toEqual({ block: true, reason: expect.stringContaining(VIOLATION) });
    expect(coordinator.beforeLlm('run-1', HOST_PROVIDER)).toEqual({
      type: 'abort',
      reason: expect.stringContaining(VIOLATION),
    });
    expect(coordinator.release('run-1')?.issue?.code).toBe('capability_violation');
  });

  it('bounds network calls that alternate with local work', () => {
    const coordinator = new GoalVerifierChildCoordinator();
    register(coordinator);
    const refusalPerTurn: (string | undefined)[] = [];
    for (let turn = 0; turn < 5; turn += 1) {
      nextTurn(coordinator);
      expect(coordinator.beforeTool('run-1', toolCall('read'))).toBeUndefined();
      if (turn % 2 === 0) {
        refusalPerTurn.push(coordinator.beforeTool('run-1', toolCall('web_fetch'))?.reason);
      }
    }

    expect(refusalPerTurn[0]).not.toContain(VIOLATION);
    expect(refusalPerTurn[1]).not.toContain(VIOLATION);
    expect(refusalPerTurn[2]).toContain(VIOLATION);
    expect(coordinator.release('run-1')?.issue?.code).toBe('capability_violation');
  });

  it.each(['write', 'edit', 'todowrite', 'task', 'memory', 'desktop_click'])(
    'still stops the run on the first call to non-network tool %s',
    (name) => {
      const coordinator = new GoalVerifierChildCoordinator();
      register(coordinator);
      nextTurn(coordinator);

      expect(coordinator.beforeTool('run-1', toolCall(name))).toEqual({
        block: true,
        reason: expect.stringContaining(VIOLATION),
      });
      expect(coordinator.beforeLlm('run-1', HOST_PROVIDER)).toEqual({
        type: 'abort',
        reason: expect.stringContaining(VIOLATION),
      });
      expect(coordinator.release('run-1')?.issue?.code).toBe('capability_violation');
    },
  );

  it('leaves the read-only verifier tools untouched', () => {
    const coordinator = new GoalVerifierChildCoordinator();
    register(coordinator);
    for (let turn = 0; turn < 3; turn += 1) {
      nextTurn(coordinator);
      for (const name of ['read', 'grep', 'glob', 'bash', 'task_query', 'task_output']) {
        expect(coordinator.beforeTool('run-1', toolCall(name))).toBeUndefined();
      }
    }
    expect(coordinator.release('run-1')?.issue).toBeUndefined();
  });

  it('still refuses every tool for an unknown run', () => {
    const coordinator = new GoalVerifierChildCoordinator();

    expect(coordinator.beforeTool('missing-run', toolCall('web_fetch'))).toEqual({
      block: true,
      reason: expect.stringContaining('no longer active'),
    });
  });

  it('still aborts a route mismatch immediately', () => {
    const coordinator = new GoalVerifierChildCoordinator();
    register(coordinator);

    expect(coordinator.beforeLlm('run-1', 'some-other-provider')).toEqual({
      type: 'abort',
      reason: expect.stringContaining('settled worker data route'),
    });
    expect(coordinator.release('run-1')?.issue?.code).toBe('route_unavailable');
  });

  it('still aborts at the host turn cap', () => {
    const coordinator = new GoalVerifierChildCoordinator();
    register(coordinator, { maxTurns: 1 });
    nextTurn(coordinator);

    expect(coordinator.beforeLlm('run-1', HOST_PROVIDER)).toEqual({
      type: 'abort',
      reason: expect.stringContaining('execution cap'),
    });
    expect(coordinator.release('run-1')?.issue?.code).toBe('child_budget_exhausted');
  });

  it('tells the child up front that verification is offline', () => {
    const reminder = renderGoalVerifierReminder({
      completionProposal: { turnId: 'turn-1' },
      settlement: { durableStatusAtDispatch: 'active', transitionOnMet: 'complete' },
    } as never);

    expect(reminder).toContain('This run is also offline');
    expect(reminder).toContain('`web_fetch` and `web_search` are not available');
  });
});

describe('Goal verifier child tool catalog', () => {
  const VERIFIER_INTENT = {
    kind: 'goal-verifier',
    attributes: { runId: 'run-1', profile: GOAL_VERIFIER_READONLY_PROFILE },
  };
  const TOOL_CONTEXT = { sessionId: 'child-session', turnId: 'child-turn' };

  function tool(name: string): RuntimeTool {
    return {
      def: { name, description: `Synthetic ${name} tool`, schema: Type.Object({}) },
      impl: {
        execute: async () => ({
          tool_name: name,
          text: 'ok',
          content: [{ type: 'text' as const, text: 'ok' }],
        }),
      },
    };
  }

  /** The builtin Matrix MCP server contributes `web_search` under the same name. */
  function matrixWebSearch(): McpToolEntry {
    return { tool: tool('web_search'), source: 'builtin-matrix' } as never;
  }

  function catalogInput(turnIntent?: { kind: string; attributes?: Record<string, string> }) {
    return createLocalTurnToolCatalogInput({
      sessionId: 'child-session',
      turnId: 'child-turn',
      agentName: 'verifier',
      workspaceDir: '/workspace',
      agentConfig: {},
      model: { provider: HOST_PROVIDER, model_id: 'offline', context_window: 128_000 },
      history: [] as never,
      ...(turnIntent ? { turnIntent } : {}),
    });
  }

  function buildCatalog(input: {
    readonly nativeTools: readonly string[];
    readonly mcpEntries: readonly McpToolEntry[];
    readonly withheldToolNames?: readonly string[];
    readonly deferMcp?: boolean;
  }) {
    return buildLocalTurnToolCatalog({
      sessionId: 'child-session',
      llmModel: { provider: HOST_PROVIDER, id: 'offline', contextWindow: 128_000 },
      sources: {
        nativeTools: input.nativeTools.map(tool),
        mcpEntries: input.mcpEntries,
        threadGoalTools: [],
        cuRuntimeAvailable: false,
      },
      env: {},
      ...(input.deferMcp ? { config: { modelWhitelist: ['*'], thresholdPct: 0 } } : {}),
      ...(input.withheldToolNames ? { withheldToolNames: input.withheldToolNames } : {}),
    });
  }

  function toolNames(catalog: ReturnType<typeof buildLocalTurnToolCatalog>): string[] {
    return catalog.tools.map((entry) => entry.def.name);
  }

  it('derives the offline tool names only for the readonly Goal verifier intent', () => {
    expect(catalogInput(VERIFIER_INTENT).withheldToolNames).toEqual(['web_fetch', 'web_search']);
    expect(catalogInput().withheldToolNames).toBeUndefined();
    expect(
      catalogInput({ kind: 'goal-verifier', attributes: { runId: 'run-1', profile: 'other' } })
        .withheldToolNames,
    ).toBeUndefined();
  });

  it('withholds native network tools from a Goal verifier child turn', () => {
    const nativeTools = ['read', 'grep', 'glob', 'bash', 'web_fetch', 'web_search'];
    const withheld = toolNames(
      buildCatalog({
        nativeTools,
        mcpEntries: [],
        withheldToolNames: catalogInput(VERIFIER_INTENT).withheldToolNames,
      }),
    );

    expect(withheld).toEqual(expect.arrayContaining(['read', 'grep', 'glob', 'bash']));
    expect(withheld).not.toContain('web_fetch');
    expect(withheld).not.toContain('web_search');
    expect(toolNames(buildCatalog({ nativeTools, mcpEntries: [] }))).toEqual(
      expect.arrayContaining(['web_fetch', 'web_search']),
    );
  });

  it('withholds the builtin Matrix MCP web_search when it is offered inline', () => {
    const withheld = buildCatalog({
      nativeTools: ['read'],
      mcpEntries: [matrixWebSearch()],
      withheldToolNames: catalogInput(VERIFIER_INTENT).withheldToolNames,
    });
    const offered = buildCatalog({ nativeTools: ['read'], mcpEntries: [matrixWebSearch()] });

    expect(toolNames(offered)).toContain('web_search');
    expect(toolNames(withheld)).toEqual(['read']);
  });

  it('keeps the builtin Matrix MCP web_search out of a deferred MCP catalog', async () => {
    const notes = {
      tool: tool('mcp__notes__read'),
      source: 'configured',
      serverName: 'notes-server',
    } as never as McpToolEntry;
    const deferredCatalog = (withheldToolNames?: readonly string[]) =>
      buildCatalog({
        nativeTools: ['read'],
        mcpEntries: [matrixWebSearch(), notes],
        deferMcp: true,
        ...(withheldToolNames ? { withheldToolNames } : {}),
      });

    // Ordinary turns keep Matrix web_search while other MCP tools are deferred.
    const offered = toolNames(deferredCatalog());
    expect(offered).toEqual(expect.arrayContaining(['web_search', 'tool_search', 'mcp_invoke']));
    expect(offered).not.toContain('mcp__notes__read');

    const withheld = deferredCatalog(catalogInput(VERIFIER_INTENT).withheldToolNames);
    expect(toolNames(withheld)).toEqual(expect.arrayContaining(['tool_search', 'mcp_invoke']));
    expect(toolNames(withheld)).not.toContain('web_search');
    // Nor can the deferred path reach it by name.
    const invoke = withheld.tools.find((entry) => entry.def.name === 'mcp_invoke');
    if (!invoke) throw new Error('mcp_invoke is missing from the deferred catalog.');
    const result = await invoke.impl
      .execute(TOOL_CONTEXT, { tool_name: 'web_search', arguments: {} })
      .catch((error: unknown) => error);
    expect(result).not.toMatchObject({ text: 'ok' });
    await expect(
      invoke.impl.execute(TOOL_CONTEXT, { tool_name: 'mcp__notes__read', arguments: {} }),
    ).resolves.toMatchObject({ text: 'ok' });
  });

  it.each([{ promptProfile: 'tui' }, { promptProfile: 'desktop' }])(
    'renders no web-search guidance into the verifier task-child prompt (%o)',
    async (profile) => {
      const assetsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../assets/agents');
      const rendered = await new BuiltinAgentCatalog({ assetsDir }).render({
        agentName: 'verifier',
        surface: 'task-child',
        appMode: 'work',
        locale: 'en',
        promptChannel: 'online',
        // The verifier role's own grant: webSearch stays on at the role level.
        capabilities: resolveAgentCapabilities({ features: { webSearch: true } }),
        ...profile,
      } as never);
      const prompt = [rendered.persona ?? '', rendered.corePrompt, rendered.surfacePrompt].join(
        '\n',
      );

      expect(prompt).not.toContain('Factual Freshness And Search');
      expect(prompt).not.toContain('web_search');
      expect(prompt).not.toContain('web_fetch');
    },
  );
});
