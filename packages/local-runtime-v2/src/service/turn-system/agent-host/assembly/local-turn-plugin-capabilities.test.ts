import { buildLocalTurnToolCatalog } from './local-turn-tool-catalog.js';
import { Type } from '@sinclair/typebox';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeTool } from '@mavis/agent-core/tools';
import {
  detectPluginReferencesForMessages,
  buildPluginReferenceReminder,
} from '@mavis/system-reminder';
import {
  mergeAgentHostTurnCapabilities,
  renderPluginAgentRoster,
  type MergeAgentHostTurnCapabilitiesInput,
} from './local-turn-plugin-capabilities.js';

function tool(name: string): RuntimeTool {
  return {
    def: { name, description: 'Synthetic test tool', schema: Type.Object({}) },
    impl: {
      execute: vi.fn(async () => ({
        tool_name: name,
        text: 'ok',
        content: [{ type: 'text' as const, text: 'ok' }],
      })),
    },
  };
}
function input(
  userText = '[@My Notes](plugin://notes%40local) summarize',
): MergeAgentHostTurnCapabilitiesInput {
  const mcp = tool('mcp__notes__read');
  const app = tool('app_notes_search');
  return {
    tools: [],
    plan: { deferred: false, inlineTools: [] },
    model: { provider: 'synthetic', id: 'offline', contextWindow: 128000 },
    options: {
      enabled: true,
      modelWhitelist: [],
      thresholdPct: 10,
      minDeferCount: 1,
      topKDefault: 5,
      topKMax: 10,
      systemHint: true,
      maxSchemaTextLen: 1000,
    },
    effectivePluginSkills: [{ pluginName: 'notes', name: 'notes:organize' }],
    capabilities: {
      revision: 'r1',
      plugins: [{ name: 'notes', source: 'local', appProviders: ['notes-app'] }],
      skills: [],
      runtimeTools: [mcp, app],
      runtimeToolBindings: [
        { kind: 'mcp', source: 'notes-server', pluginName: 'notes', tool: mcp },
        { kind: 'app', source: 'notes-app', toolMode: 'tool_search', tool: app },
      ],
    },
    userText,
  };
}

describe('Plugin identity selection at the final Runtime capability boundary', () => {
  it('selects exact IDs independently of aliases and never substitutes a same-named source', () => {
    const local = {
      name: 'notes',
      pluginId: 'notes@local',
      skills: ['notes:organize'],
      appTools: [],
      mcpTools: [],
    };
    const official = { ...local, pluginId: 'notes@official' };
    expect(
      detectPluginReferencesForMessages([], '[@Alias](plugin://notes%40local)', [official, local]),
    ).toEqual([local]);
    expect(
      detectPluginReferencesForMessages([], '[@notes](plugin://notes%40missing)', [local]),
    ).toEqual([]);
    expect(detectPluginReferencesForMessages([], '@notes summarize', [official, local])).toEqual(
      [],
    );
    expect(detectPluginReferencesForMessages([], '@notes summarize', [local])).toEqual([local]);
  });

  it('advertises only effective skills, direct MCP and searchable App tools, preserving callable implementations', async () => {
    const request = input();
    const result = mergeAgentHostTurnCapabilities(request);
    expect(result.reminder).toContain('notes:organize');
    expect(result.reminder).toContain('mcp__notes__read');
    expect(result.reminder).toContain('app_notes_search');
    expect(result.reminder).toContain('tool_search');
    expect(result.plan.deferred).toBe(true);
    const mcp = result.tools.find((tool) => tool.def.name === 'mcp__notes__read')!;
    await expect(mcp.impl.execute({ sessionId: 's', turnId: 't' }, {})).resolves.toMatchObject({
      text: 'ok',
    });
    expect(mcp.toolCallProvenanceResolver?.({ phase: 'start', toolName: mcp.def.name })).toEqual([
      expect.objectContaining({ plugin_name: 'notes' }),
    ]);
  });

  it('discovers and invokes deferred MCP and App tools through the final catalog', async () => {
    const request = input();
    const mcp = request.capabilities!.runtimeTools[0]!;
    const result = buildLocalTurnToolCatalog({
      sessionId: 's',
      llmModel: request.model,
      sources: {
        nativeTools: [],
        mcpEntries: [{ tool: mcp, source: 'configured', serverName: 'notes-server' }],
        threadGoalTools: [],
        cuRuntimeAvailable: false,
      },
      config: { ...request.options, modelWhitelist: ['*'], thresholdPct: 0 },
      desktopCapabilities: request.capabilities,
      effectivePluginSkills: request.effectivePluginSkills,
      userText: request.userText,
    });
    expect(result.tools.map((tool) => tool.def.name)).not.toContain(mcp.def.name);
    expect(result.userPromptPrefix).toContain(
      'server `notes-server` via `tool_search` + `mcp_invoke`',
    );
    const search = result.tools.find((tool) => tool.def.name === 'tool_search')!;
    const invoke = result.tools.find((tool) => tool.def.name === 'mcp_invoke')!;
    for (const name of ['mcp__notes__read', 'app_notes_search']) {
      const found = await search.impl.execute({ sessionId: 's', turnId: 't' }, { query: name });
      expect(JSON.stringify(found)).toContain(name);
      await expect(
        invoke.impl.execute({ sessionId: 's', turnId: 't' }, { tool_name: name, arguments: {} }),
      ).resolves.toMatchObject({ text: 'ok' });
    }
  });

  it('reports a plugin disabled before this turn and does not activate it or use another source', () => {
    const request = input();
    const result = mergeAgentHostTurnCapabilities({
      ...request,
      effectivePluginSkills: [],
      capabilities: {
        revision: 'r2',
        plugins: [],
        runtimeTools: [],
        runtimeToolBindings: [],
        skills: [],
      },
    });
    expect(result.reminder).toContain('notes@local');
    expect(result.reminder).toContain('unavailable for this turn');
    expect(result.tools).toEqual([]);
    expect(
      mergeAgentHostTurnCapabilities({ ...request, capabilities: undefined }).reminder,
    ).toContain('unavailable');
    expect(
      mergeAgentHostTurnCapabilities(input('[@notes](plugin://notes%40official)')).reminder,
    ).toContain('notes@official` is unavailable');
  });

  it('bounds capability instructions even for large inventories', () => {
    const result = buildPluginReferenceReminder(
      Array.from({ length: 40 }, (_, index) => ({
        name: `plugin-${index}`,
        pluginId: `plugin-${index}@local`,
        skills: Array.from({ length: 200 }, (_, i) => `plugin-${index}:skill-${i}`),
        appTools: [],
        mcpTools: [],
      })),
    );
    expect(result!.length).toBeLessThan(16384);
    expect(result).toContain('omitted');
    expect(result).toContain('</system-reminder>');
  });
});

function baseInput(userText: string): MergeAgentHostTurnCapabilitiesInput {
  return {
    tools: [],
    plan: { deferred: false, inlineTools: [] },
    model: { provider: "minimax", id: "model", contextWindow: 100_000 },
    options: {
      enabled: true,
      modelWhitelist: [],
      thresholdPct: 0.15,
      minDeferCount: 1,
      topKDefault: 5,
      topKMax: 20,
      systemHint: true,
      maxSchemaTextLen: 4_096,
    },
    effectivePluginSkills: [{ pluginName: "demo", name: "demo:skill" }],
    userText,
  };
}

function view(overrides: Record<string, unknown>) {
  return {
    revision: "revision-1",
    plugins: [
      { name: "demo", version: "1.0.0", source: "local", appProviders: ["notion"] },
    ],
    skills: [],
    runtimeTools: [],
    runtimeToolBindings: [],
    ...overrides,
  } as never;
}

describe('Plugin Agent roster reminder', () => {
  const agent = (scopedName: string, description: string) => ({
    scopedName,
    pluginName: scopedName.split(':')[0]!,
    agentName: scopedName.split(':').slice(1).join(':'),
    sourceFormat: 'minimax' as const,
    packageDigest: 'sha256:demo',
    pluginRoot: '/plugins/demo',
    description,
    systemPrompt: 'Body',
  });

  it('lists sorted scoped names with flattened, bounded descriptions when task is present', () => {
    const result = mergeAgentHostTurnCapabilities({
      ...baseInput('inspect'),
      tools: [tool('read'), tool('task')],
      capabilities: view({
        agents: [
          agent('zeta:writer', 'Writes <docs>\nand notes'),
          agent('alpha:review', 'x'.repeat(300)),
        ],
      }),
    });

    expect(result.reminder).toContain('<plugin-agents>');
    const roster = result.reminder!.slice(result.reminder!.indexOf('<plugin-agents>'));
    expect(roster.indexOf('`alpha:review`')).toBeLessThan(roster.indexOf('`zeta:writer`'));
    expect(roster).toContain('- `zeta:writer`: Writes &lt;docs&gt; and notes');
    expect(roster).toContain(`- \`alpha:review\`: ${'x'.repeat(199)}…`);
  });

  it('omits the roster when this Turn cannot call task', () => {
    expect(
      renderPluginAgentRoster([agent('demo:review', 'Review')], [tool('read')]),
    ).toBeUndefined();
    expect(renderPluginAgentRoster([], [tool('task')])).toBeUndefined();
  });

  it('treats a mentioned Subagent-only Plugin as available only when task can delegate', () => {
    const input = {
      ...baseInput('[@Agents](plugin://agents-only%40local) review this'),
      capabilities: view({ agents: [agent('agents-only:reviewer', 'Reviews')] }),
    };
    const delegable = mergeAgentHostTurnCapabilities({
      ...input,
      tools: [tool('read'), tool('task')],
    });
    expect(delegable.reminder).not.toContain('is unavailable for this turn');
    expect(delegable.reminder).toContain('`agents-only:reviewer`');

    const noTask = mergeAgentHostTurnCapabilities({ ...input, tools: [tool('read')] });
    expect(noTask.reminder).toContain('agents-only@local` is unavailable for this turn');
  });
});
