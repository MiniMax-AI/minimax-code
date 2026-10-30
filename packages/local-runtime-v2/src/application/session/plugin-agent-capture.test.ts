import { resolve } from 'node:path';

import { defineRuntimeTool } from '@mavis/agent-core/tools';
import type { McpToolEntry } from '@mavis/agent-tools';
import type { ConversationPluginAgentDefinition } from '@mavis/conversation-contract';
import { Type } from '@sinclair/typebox';
import { describe, expect, it, vi } from 'vitest';

import type { AgentExecutionProfile, LocalAgentService } from '../../service/agent/index.js';
import type { LocalConversationRuntimeConfig } from '../../service/model-system/index.js';
import {
  decodeSessionAgentDefinition,
  serializeSessionAgentDefinition,
  type FrozenAgentExecutionDefinition,
  type SessionRecord,
} from '../../service/session-system/index.js';
import type { AgentHostTurnCapabilityView } from '../../service/turn-system/index.js';
import { expandPluginAgentPlaceholders } from './plugin-agent-capture.js';
import { createTaskAgentBindingCaptureCoordinator } from './task-agent-binding-capture.js';

const CONFIG: LocalConversationRuntimeConfig = {
  dataDir: '/data',
  defaultModel: 'runtime/default',
  provider: {
    runtime: { models: { default: { limit: { context: 128_000, output: 8_192 } } } },
    parent: {
      models: {
        inherited: {
          limit: { context: 64_000, output: 4_096 },
          thinking: { effortOptions: ['low', 'high'] },
        },
      },
    },
    target: {
      models: {
        replacement: {
          limit: { context: 32_000, output: 2_048 },
          thinking: { effortOptions: ['minimal', 'medium'] },
        },
      },
    },
  },
};

const ROOT_TOKEN = (name: string) => ['$', `{${name}}`].join('');
const COMPATIBLE = '\u0063\u006c\u0061\u0075\u0064\u0065' as const;

function pluginAgent(
  overrides: Partial<ConversationPluginAgentDefinition> = {},
): ConversationPluginAgentDefinition {
  return {
    scopedName: 'review:security',
    pluginName: 'review',
    agentName: 'security',
    sourceFormat: 'minimax',
    packageDigest: 'sha256:review',
    pluginRoot: '/plugins/review',
    description: 'Reviews security.',
    systemPrompt: `Run ${ROOT_TOKEN('PLUGIN_ROOT')}/scan.sh`,
    ...overrides,
  };
}

describe('expandPluginAgentPlaceholders', () => {
  it('expands every Hook-compatible Plugin root and data alias and keeps other tokens', () => {
    const dataDir = resolve('/plugins/review', '..', '.plugin-data', 'review');
    const body = [
      'MINIMAX_PLUGIN_ROOT',
      '\u0043LAUDE_PLUGIN_ROOT',
      'CODEX_PLUGIN_ROOT',
      'PLUGIN_ROOT',
      '\u0043LAUDE_PLUGIN_DATA',
      'PLUGIN_DATA',
      'HOME',
    ]
      .map(ROOT_TOKEN)
      .join(' ');

    expect(expandPluginAgentPlaceholders(pluginAgent({ systemPrompt: body }))).toBe(
      [
        '/plugins/review',
        '/plugins/review',
        '/plugins/review',
        '/plugins/review',
        dataDir,
        dataDir,
        ROOT_TOKEN('HOME'),
      ].join(' '),
    );
  });
});

describe('Plugin Agent Task capture', () => {
  it('freezes the Plugin body, scoped owner and Plugin source without reading an Agent row', async () => {
    const fixture = createFixture();
    const captured = await fixture.capture(pluginAgent({ tools: ['read'], skills: [] }));
    const definition = captured.agentDefinition.definition as FrozenAgentExecutionDefinition;

    expect(fixture.agentService.renderProfile).not.toHaveBeenCalled();
    expect(fixture.agentService.getConfigDocument).not.toHaveBeenCalled();
    expect(fixture.agentService.renderFrozenProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        exactOwnerName: 'review:security',
        requestRef: 'review:security',
        surface: 'task-child',
        promptProfile: 'desktop',
      }),
      {
        systemPrompt: 'Run /plugins/review/scan.sh',
        capabilities: { tools: ['read'], skills: [] },
      },
    );
    expect(definition).toMatchObject({
      definitionVersion: 2,
      exactOwnerName: 'review:security',
      systemPrompt: 'Run /plugins/review/scan.sh',
      pluginSource: {
        kind: 'plugin',
        pluginName: 'review',
        format: 'minimax',
        agentName: 'security',
        scopedName: 'review:security',
        packageDigest: 'sha256:review',
      },
      capabilities: { tools: ['read'], skills: [] },
    });
    expect(definition).not.toHaveProperty('ownerInstanceId');
    const roundTrip = decodeSessionAgentDefinition({
      sessionId: 'task-session',
      ...serializeSessionAgentDefinition(captured.agentDefinition),
    });
    expect(roundTrip.definition).toEqual(definition);
  });

  it('inherits the parent model unless the Plugin Agent declares one', async () => {
    const parent = session({
      effectiveModel: 'parent/inherited',
      effectiveModelThinking: { effort: 'high' },
    });
    await expect(createFixture({ parent }).capture(pluginAgent())).resolves.toMatchObject({
      effectiveModel: 'parent/inherited',
    });
    await expect(
      createFixture({ parent }).capture(
        pluginAgent({ model: 'target/replacement', effort: 'medium', maxOutputTokens: 1_024 }),
      ),
    ).resolves.toMatchObject({
      effectiveModel: 'target/replacement',
      effectiveModelThinking: { effort: 'medium' },
      effectiveModelMaxOutputTokens: 1_024,
    });
  });

  it('fails Task creation when the declared Plugin Agent model is unavailable', async () => {
    await expect(
      createFixture().capture(pluginAgent({ model: 'missing/model' })),
    ).rejects.toThrow();
  });

  it('binds compatible MCP allowlists to this Plugin aliases, not a same-named configured server', async () => {
    const captured = await collidingMcpFixture().capture(
      pluginAgent({ sourceFormat: COMPATIBLE, tools: ['read', 'mcp__docs__search'] }),
    );
    const { capabilities } = captured.agentDefinition.definition as FrozenAgentExecutionDefinition;

    expect(capabilities.tools).toContain('mcp__docs_2__search');
    expect(capabilities.tools).not.toContain('mcp__docs__search');
  });

  it('binds compatible MCP denylists to this Plugin aliases', async () => {
    const captured = await collidingMcpFixture().capture(
      pluginAgent({ sourceFormat: COMPATIBLE, disallowedTools: ['mcp__docs__search'] }),
    );
    const { capabilities } = captured.agentDefinition.definition as FrozenAgentExecutionDefinition;

    expect(capabilities.disallowedTools).toEqual(['mcp__docs_2__search']);
    expect(capabilities.tools).not.toContain('mcp__docs_2__search');
    expect(capabilities.tools).toContain('mcp__docs__search');
  });

  it('never grants a same-named configured server when this Plugin server published no tools', async () => {
    const captured = await createFixture({
      mcpEntries: [{ tool: tool('mcp__docs__search'), source: 'configured', serverName: 'docs' }],
    }).capture(
      pluginAgent({
        sourceFormat: COMPATIBLE,
        tools: ['read', 'mcp__docs__search'],
        declaredMcpServers: ['docs'],
      }),
    );
    const { capabilities } = captured.agentDefinition.definition as FrozenAgentExecutionDefinition;

    expect(capabilities.tools).toEqual(['read']);
  });

  it('leaves an own alias out of the allowlist when it differs from another owner only by case', async () => {
    const fixture = () => pluginMcpFixture({ server: 'Docs', alias: 'mcp__Docs__search' });
    const allowed = await fixture().capture(
      pluginAgent({ sourceFormat: COMPATIBLE, tools: ['read', 'mcp__Docs__search'] }),
    );
    const denied = await fixture().capture(
      pluginAgent({ sourceFormat: COMPATIBLE, disallowedTools: ['mcp__Docs__search'] }),
    );

    expect(
      (allowed.agentDefinition.definition as FrozenAgentExecutionDefinition).capabilities.tools,
    ).toEqual(['read']);
    expect(
      (denied.agentDefinition.definition as FrozenAgentExecutionDefinition).capabilities
        .disallowedTools,
    ).toEqual(['mcp__Docs__search']);
  });

  it('binds selectors for Plugin servers whose names contain the MCP delimiter', async () => {
    const fixture = () =>
      pluginMcpFixture({ server: 'docs__internal', alias: 'mcp__docs_internal__search' });
    const allowed = await fixture().capture(
      pluginAgent({ sourceFormat: COMPATIBLE, tools: ['mcp__docs__internal__search'] }),
    );
    const denied = await fixture().capture(
      pluginAgent({ sourceFormat: COMPATIBLE, disallowedTools: ['mcp__docs__internal__search'] }),
    );

    expect(
      (allowed.agentDefinition.definition as FrozenAgentExecutionDefinition).capabilities.tools,
    ).toEqual(['mcp__docs_internal__search']);
    expect(
      (denied.agentDefinition.definition as FrozenAgentExecutionDefinition).capabilities
        .disallowedTools,
    ).toEqual(['mcp__docs_internal__search']);
  });

  it('claims undiscovered delimiter-named Plugin servers by their declared prefix', async () => {
    const captured = await createFixture({
      mcpEntries: [{ tool: tool('mcp__docs__search'), source: 'configured', serverName: 'docs' }],
    }).capture(
      pluginAgent({
        sourceFormat: COMPATIBLE,
        tools: ['read', 'mcp__docs__internal__search'],
        declaredMcpServers: ['docs__internal'],
      }),
    );
    const { capabilities } = captured.agentDefinition.definition as FrozenAgentExecutionDefinition;

    expect(capabilities.tools).toEqual(['read']);
  });

  it('keeps MCP selectors for servers this Plugin does not declare', async () => {
    const captured = await createFixture({
      mcpEntries: [{ tool: tool('mcp__docs__search'), source: 'configured', serverName: 'docs' }],
    }).capture(
      pluginAgent({
        sourceFormat: COMPATIBLE,
        tools: ['mcp__docs__search'],
        declaredMcpServers: ['wiki'],
      }),
    );
    const { capabilities } = captured.agentDefinition.definition as FrozenAgentExecutionDefinition;

    expect(capabilities.tools).toEqual(['mcp__docs__search']);
  });

  it('captures Plugin Agents only for new Task Sessions with a parent', async () => {
    const fixture = createFixture();
    await expect(
      fixture.coordinator.capture({
        agentName: 'worker',
        session: session({ sessionId: 'child', sessionKind: 'conversation' }),
        parent: session(),
        pluginAgent: pluginAgent(),
      }),
    ).rejects.toThrow('Plugin Agent definitions are captured only for new Task Sessions.');
    await expect(
      fixture.coordinator.captureSessionDefinition({
        agentName: 'worker',
        session: taskSession(),
        parent: session(),
        pluginAgent: pluginAgent(),
      }),
    ).rejects.toThrow('Plugin Agent definitions are captured only for new Task Sessions.');
  });
});

function createFixture(
  input: {
    readonly parent?: SessionRecord;
    readonly mcpEntries?: readonly McpToolEntry[];
    readonly desktopCapabilities?: AgentHostTurnCapabilityView;
  } = {},
) {
  const parent = input.parent ?? session();
  const agentService = {
    renderProfile: vi.fn(),
    getConfigDocument: vi.fn(),
    renderFrozenProfile: vi.fn(
      async (
        request: { readonly exactOwnerName: string },
        definition: { readonly systemPrompt: string; readonly capabilities: object },
      ): Promise<AgentExecutionProfile> => profile(request.exactOwnerName, definition),
    ),
  };
  const coordinator = createTaskAgentBindingCaptureCoordinator({
    agentService: agentService as unknown as LocalAgentService,
    config: () => CONFIG,
    inventory: {
      capture: async () => ({
        sources: {
          nativeTools: [tool('read'), tool('write')],
          mcpEntries: input.mcpEntries ?? [],
          threadGoalTools: [],
          cuRuntimeAvailable: false,
        },
        skills: [{ name: 'global-skill', sourceType: 2 }],
        ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
      }),
    },
  });
  return {
    agentService,
    coordinator,
    capture: (agent: ConversationPluginAgentDefinition) =>
      coordinator.capture({
        agentName: 'worker',
        session: taskSession(),
        parent,
        pluginAgent: agent,
      }),
  };
}

/** A configured `docs` server owns `mcp__docs__search`; the Plugin's own `docs` gets `_2`. */
function collidingMcpFixture() {
  return pluginMcpFixture({ server: 'docs', alias: 'mcp__docs_2__search' });
}

function pluginMcpFixture(plugin: { readonly server: string; readonly alias: string }) {
  const pluginTool = tool(plugin.alias);
  return createFixture({
    mcpEntries: [{ tool: tool('mcp__docs__search'), source: 'configured', serverName: 'docs' }],
    desktopCapabilities: {
      revision: 'r1',
      runtimeTools: [pluginTool],
      runtimeToolBindings: [
        {
          kind: 'mcp',
          source: plugin.server,
          pluginName: 'review',
          mcpToolName: 'search',
          tool: pluginTool,
        },
      ],
      skills: [],
    } as unknown as AgentHostTurnCapabilityView,
  });
}

function profile(
  exactOwnerName: string,
  definition: { readonly systemPrompt: string; readonly capabilities: object },
): AgentExecutionProfile {
  return {
    requestRef: exactOwnerName,
    resourceReadRef: exactOwnerName,
    exactOwnerName,
    canonicalViewName: exactOwnerName,
    resolvedAgentName: exactOwnerName,
    agentRole: 'worker',
    creationSource: 'manual',
    surface: 'task-child',
    memoryReadAgentNames: [],
    excludeAgentResources: true,
    agentSystemPrompt: definition.systemPrompt,
    corePrompt: '',
    surfacePrompt: '',
    configSelection: { ...definition.capabilities },
    capabilityCeiling: {
      personaEnabled: true,
      features: { mavis: true, delegation: false, webSearch: true },
    },
    provenance: { source: 'custom', assetAgentName: exactOwnerName, locale: 'en-US' },
  };
}

function taskSession(): SessionRecord {
  return session({
    sessionId: 'child',
    agentName: 'worker',
    sessionType: 'branch',
    sessionKind: 'task',
    parentSessionId: 'parent-session',
    workspaceDir: '/workspace/parent',
  });
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 'parent-session',
    agentName: 'mavis',
    workspaceDir: '/workspace/parent',
    runtime: 'pi-agent',
    sessionType: 'root',
    sessionKind: 'conversation',
    archived: false,
    status: 'idle',
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function tool(name: string) {
  return defineRuntimeTool({
    name,
    description: name,
    schema: Type.Object({}),
    execute: async () => ({
      tool_name: name,
      text: name,
      content: [{ type: 'text' as const, text: name }],
    }),
  });
}
