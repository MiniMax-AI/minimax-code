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
