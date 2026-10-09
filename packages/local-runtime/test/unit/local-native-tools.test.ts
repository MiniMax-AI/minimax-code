import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { resolveAgentCapabilities } from '@mavis/config';
import type { IRuntimeEvent } from '@mavis/protocol';

import {
  buildLocalNativeRuntimeTools,
  buildLocalTurnToolSources,
} from '../../src/api/local-native-tools.js';
import { withoutLocalMavisCronGuidance } from '../../src/api/local-mavis-cron-guidance.js';
import { LocalEventSink } from '../../src/events/sink.js';
import { LocalMcpService } from '../../../local-runtime-v2/src/service/mcp/index.js';
import { LocalMemoryFacade } from '../../src/memory/local-memory-facade.js';
import { initSkillService } from '../../src/skills/skill-service.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('local native turn tools', () => {
  it('exposes native web_search only when the local product owner gate is enabled', () => {
    const base = {
      workspaceRoot: '/workspace',
      agentName: 'mavis',
      webSearchAdapter: { search: vi.fn() },
    };

    expect(buildLocalNativeRuntimeTools(base).map((tool) => tool.def.name)).not.toContain(
      'web_search',
    );
    expect(
      buildLocalNativeRuntimeTools({ ...base, webSearchEnabled: true }).map(
        (tool) => tool.def.name,
      ),
    ).toContain('web_search');
  });

  it('executes native search through the authenticated gateway without a Matrix MCP server', async () => {
    vi.stubEnv('MAVIS_BUILD_ENV', 'test');
    const dataDir = await mkdtemp(join(tmpdir(), 'native-search-'));
    const mcpService = new LocalMcpService(() => dataDir);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          results: [{ title: 'Result', link: 'https://example.test', snippet: 'Evidence' }],
          total: 1,
        }),
        { status: 200 },
      ),
    );
    const input = {
      dataDir,
      workspaceRoot: dataDir,
      agentName: 'mavis',
      sessionId: 'search-session',
      toolsDisabled: false,
      nativeWebSearchEnabled: true,
      mcpService,
      emitBusEvent: vi.fn(),
      threadGoal: { runtimeToolsFor: async () => [] } as never,
      authContext: { accessToken: 'test-search-token' },
      fetchImpl,
      routingContextGetter: () => ({ bedrockLane: 'search-lane' }),
    };
    try {
      const sources = await buildLocalTurnToolSources(input);
      expect(sources.mcpEntries).toEqual([]);
      expect(await mcpService.listServers()).toEqual([]);
      const searches = sources.nativeTools.filter((tool) => tool.def.name === 'web_search');
      expect(searches).toHaveLength(1);
      const result = await searches[0]!.impl.execute(
        { sessionId: 'search-session', turnId: 'search-turn' },
        { query: 'MiniMax' },
      );
      expect(JSON.parse(result.text)).toMatchObject({ total: 1 });
      expect(result.details).toMatchObject({
        server: 'matrix',
        tool: 'web_search',
        mcp: { isError: false },
      });
      const [url, request] = fetchImpl.mock.calls[0]!;
      expect(String(url)).toMatch(/\/mavis\/api\/v1\/mcp\/web_search$/);
      expect(new Headers(request?.headers).get('authorization')).toBe('Bearer test-search-token');
      expect(new Headers(request?.headers).get('bedrock-lane')).toBe('search-lane');
      expect(JSON.parse(request!.body as string)).toEqual({ query: 'MiniMax' });

      const noTools = await buildLocalTurnToolSources({ ...input, toolsDisabled: true });
      expect(noTools.nativeTools).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await mcpService.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('omits Memory from Custom and factless tool catalogs while retaining full Mavis Memory', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-memory-scope-'));
    try {
      const facade = new LocalMemoryFacade({
        config: () => ({ dataDir, enabled: true }),
        nowMs: () => 1_700_000_000_000,
      });
      const customTools = buildLocalNativeRuntimeTools({
        dataDir,
        workspaceRoot: dataDir,
        agentName: 'writer',
        memoryFacade: facade,
        memoryAgentScopeEnabled: false,
      });
      const factlessTools = buildLocalNativeRuntimeTools({
        dataDir,
        workspaceRoot: dataDir,
        agentName: 'mavis',
        memoryFacade: facade,
      });
      expect(customTools.map((tool) => tool.def.name)).not.toContain('memory');
      expect(factlessTools.map((tool) => tool.def.name)).not.toContain('memory');
      await expect(access(join(dataDir, 'agents', 'writer', 'memory'))).rejects.toThrow();

      const primaryMemory = buildLocalNativeRuntimeTools({
        dataDir,
        workspaceRoot: dataDir,
        agentName: 'mavis',
        memoryFacade: facade,
        memoryAgentScopeEnabled: true,
        memoryReadAgentNames: ['mavis', 'main'],
      }).find((tool) => tool.def.name === 'memory');
      if (!primaryMemory) throw new Error('primary memory tool not found');
      const primaryResult = await primaryMemory.impl.execute(
        { sessionId: 'ses_mavis', turnId: 'turn_mavis', agentName: 'mavis' },
        { target: 'main', operation: 'append', content: 'PRIMARY_SENTINEL' },
      );
      expect(primaryResult.details).toMatchObject({ ok: true });
      const userResult = await primaryMemory.impl.execute(
        { sessionId: 'ses_mavis', turnId: 'turn_mavis', agentName: 'mavis' },
        {
          target: 'user',
          operation: 'append',
          content: 'shared preference',
          reason: 'requested',
        },
      );
      expect(userResult.details).toMatchObject({ ok: true });
      await expect(facade.getAgentMemory('mavis')).resolves.toMatchObject({
        content: expect.stringContaining('PRIMARY_SENTINEL'),
      });
      await expect(facade.getUserMemory()).resolves.toMatchObject({
        content: expect.stringContaining('shared preference'),
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('removes Cron from the Mavis Tool contract when the Cron adapter is absent', () => {
    const base = {
      workspaceRoot: '/workspace',
      agentName: 'mavis',
      mavisAgentAdapter: {} as never,
    };
    const withoutCron = buildLocalNativeRuntimeTools(base).find(
      (tool) => tool.def.name === 'mavis',
    );
    const withCron = buildLocalNativeRuntimeTools({
      ...base,
      mavisCronAdapter: {} as never,
    }).find((tool) => tool.def.name === 'mavis');

    expect(withoutCron?.def.description).toContain('agent — local desktop agent roster');
    expect(withoutCron?.def.description).toContain('session — local desktop conversations');
    expect(withoutCron?.def.description).not.toContain('cron — local desktop scheduled tasks');
    expect(withoutCron?.def.description).not.toContain('command: "cron');
    expect(withoutCron?.def.description).not.toMatch(/scheduled tasks/i);
    expect(JSON.stringify(withoutCron?.def.schema)).not.toMatch(/cron/i);
    expect(withCron?.def.description).toContain('cron — local desktop scheduled tasks');
  });

  it('strips Cron-only args from the model-visible Mavis schema when Cron is absent', () => {
    // Description-only stripping still leaked the capability: `cron_id`,
    // `schedule`, `every` and friends stayed in the args schema, which is
    // enough for a model to infer Cron exists and call into an error.
    const base = {
      workspaceRoot: '/workspace',
      agentName: 'mavis',
      mavisAgentAdapter: {} as never,
    };
    const argsOf = (tool: { def: { schema: unknown } } | undefined) =>
      (tool?.def.schema as { properties: { args: { properties: Record<string, unknown> } } })
        .properties.args.properties;

    const withoutCron = argsOf(
      buildLocalNativeRuntimeTools(base).find((tool) => tool.def.name === 'mavis'),
    );
    const withCron = argsOf(
      buildLocalNativeRuntimeTools({ ...base, mavisCronAdapter: {} as never }).find(
        (tool) => tool.def.name === 'mavis',
      ),
    );

    for (const field of [
      'cron_id',
      'cron_name',
      'schedule',
      'every',
      'after',
      'at',
      'active_hours',
      'quiet_on_skip',
      'timezone',
      'model',
      'prompt',
      'session',
    ]) {
      expect(withoutCron).not.toHaveProperty(field);
      expect(withCron).toHaveProperty(field);
    }

    // Session and MCP command arguments remain available.
    for (const field of ['session_id', 'mode', 'agent_name', 'limit', 'cursor', 'enabled']) {
      expect(withoutCron).toHaveProperty(field);
    }
    expect(withoutCron.enabled).toMatchObject({
      type: 'boolean',
      description: expect.stringContaining('mcp create/update'),
    });
    expect(withoutCron.agent_name).toMatchObject({
      description: expect.stringContaining('Required for agent get/update/delete'),
    });
    expect(withoutCron.transport).toMatchObject({
      anyOf: [{ const: 'stdio' }, { const: 'http' }, { const: 'streamable-http' }, { const: 'sse' }],
      description: expect.stringContaining('Do not mix stdio and remote fields.'),
    });

    // No residual Cron wording in retained field descriptions either.
    for (const field of Object.values(withoutCron)) {
      const description = (field as { description?: string }).description;
      if (typeof description === 'string') expect(description).not.toMatch(/cron/i);
    }
  });

  it('derives the Cron-less Mavis contract without mutating the frozen definition', () => {
    // `LocalMavisToolDef` is contract-frozen by a snapshot test; stripping must
    // copy rather than edit it in place, or the desktop host loses Cron too.
    const base = {
      workspaceRoot: '/workspace',
      agentName: 'mavis',
      mavisAgentAdapter: {} as never,
    };
    const withoutCron = buildLocalNativeRuntimeTools(base).find(
      (tool) => tool.def.name === 'mavis',
    );
    if (!withoutCron) throw new Error('mavis tool not found');
    expect(withoutLocalMavisCronGuidance(withoutCron).def).toEqual(withoutCron.def);
    const stillHasCron = buildLocalNativeRuntimeTools({
      ...base,
      mavisCronAdapter: {} as never,
    }).find((tool) => tool.def.name === 'mavis');

    expect(stillHasCron?.def.description).toContain('cron — local desktop scheduled tasks');
    const schema = stillHasCron?.def.schema as {
      properties: { command: { description: string }; args: { description: string; properties: Record<string, unknown> } };
    };
    expect(schema.properties.command.description).toContain('cron resolve-model');
    expect(schema.properties.args.description).toContain('cron once requires exactly one');
    expect(schema.properties.args.properties).toHaveProperty('cron_id');
    expect(schema.properties.args.properties).toHaveProperty('model');
  });

  it('keeps the Memory tool read-only when a session disables memory writes', async () => {
    const getUserMemory = vi.fn(async () => ({ content: 'saved user memory' }));
    const appendMemory = vi.fn();
    const memory = buildLocalNativeRuntimeTools({
      workspaceRoot: '/workspace',
      agentName: 'mavis',
      memoryFacade: { getUserMemory, appendMemory } as never,
      memoryEnabled: true,
      memoryReadEnabled: true,
      memoryWriteEnabled: false,
      memoryAgentScopeEnabled: true,
    }).find((tool) => tool.def.name === 'memory');

    expect(memory).toBeDefined();
    expect(memory?.def.description).toBe(
      'Read and search local memory. Supports target=user|main|topic.',
    );
    const schema = memory?.def.schema as {
      properties: {
        target: { anyOf: Array<{ const: string }> };
        operation: { anyOf: Array<{ const: string }> };
      };
    };
    expect(schema.properties.target.anyOf.map(({ const: value }) => value)).toEqual([
      'user',
      'main',
      'topic',
    ]);
    expect(schema.properties.operation.anyOf.map(({ const: value }) => value)).toEqual([
      'read',
      'search',
    ]);

    const context = { sessionId: 'read-only-memory', turnId: 'turn-1', agentName: 'mavis' };
    const read = await memory!.impl.execute(context, { target: 'user', operation: 'read' });
    const write = await memory!.impl.execute(context, {
      target: 'main',
      operation: 'append',
      content: 'blocked memory',
    });

    expect(read.text).toBe('saved user memory');
    expect(write.details).toMatchObject({
      kind: 'memory',
      ok: false,
      code: 'MEMORY_WRITE_DISABLED',
    });
    expect(appendMemory).not.toHaveBeenCalled();
  });

  it.each([
    ['no auth context (API-key / custom-provider path)', undefined, false],
    ['an auth context without an access token', { userName: 'u' }, false],
    ['a blank access token', { accessToken: '   ' }, false],
    ['a MiniMax account access token', { accessToken: 'account-token' }, true],
  ])('only offers website_deploy (and its skills) with %s', async (_label, authContext, expected) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-website-deploy-'));
    try {
      const builtinCapabilities = resolveAgentCapabilities({});
      const { nativeTools } = await buildLocalTurnToolSources({
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        sessionId: 'website-deploy-gate',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent: () => {},
        builtinCapabilities,
        ...(authContext ? { authContext } : {}),
        taskAdapter: {} as never,
        taskControlAdapter: {} as never,
        mavisAgentAdapter: {} as never,
      });
      expect(nativeTools.map((tool) => tool.def.name).includes('website_deploy')).toBe(expected);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('filters configurable built-in tools and only the delegation entry point', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-capability-tools-'));
    try {
      const { nativeTools: tools } = await buildLocalTurnToolSources({
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        eventWriter: new LocalEventSink(),
        sessionId: 'capability-session',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent: () => {},
        builtinCapabilities: resolveAgentCapabilities({
          tools: ['read', 'task_query', 'task_output', 'task_stop'],
          features: { mavis: false, delegation: false },
        }),
        taskAdapter: {} as never,
        taskControlAdapter: {} as never,
        mavisAgentAdapter: {} as never,
      });

      const names = tools.map((tool) => tool.def.name);
      expect(names).toContain('read');
      expect(names).toContain('skill');
      expect(names).toEqual(expect.arrayContaining(['task_query', 'task_output', 'task_stop']));
      for (const hidden of [
        'write',
        'edit',
        'bash',
        'grep',
        'glob',
        'todowrite',
        'web_fetch',
        'mavis',
        'website_deploy',
        'workspace_semantic_search',
        'task',
        'task_append',
      ]) {
        expect(names).not.toContain(hidden);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('removes Mavis-only guidance from task schema when Mavis is not available', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-capability-tools-'));
    try {
      const { nativeTools: tools } = await buildLocalTurnToolSources({
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        eventWriter: new LocalEventSink(),
        sessionId: 'task-without-mavis-session',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent: () => {},
        builtinCapabilities: resolveAgentCapabilities({
          tools: ['read'],
          features: { mavis: false, delegation: true },
        }),
        taskAdapter: {} as never,
      });

      const task = tools.find((tool) => tool.def.name === 'task');
      expect(task).toBeDefined();
      const schema = task!.def.schema as {
        properties: { agent_name: { description: string } };
      };
      expect(schema.properties.agent_name.description).toContain(
        'Use explore, worker, or verifier',
      );
      expect(schema.properties.agent_name.description).not.toContain('general');
      expect(schema.properties.agent_name.description).not.toContain('coder');
      expect(schema.properties.agent_name.description).toContain(
        'For a known custom Agent, use its stable `requestRef`',
      );
      expect(schema.properties.agent_name.description).toContain('agent:<stable-name>');
      expect(schema.properties.agent_name.description).toContain(
        'ordinary custom names use their raw stable name',
      );
      expect(schema.properties.agent_name.description).not.toMatch(/\bmavis\b/i);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exposes the complete task family when delegation is enabled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-delegation-tools-'));
    try {
      const { nativeTools: tools } = await buildLocalTurnToolSources({
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        eventWriter: new LocalEventSink(),
        sessionId: 'delegation-enabled',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent: () => {},
        builtinCapabilities: resolveAgentCapabilities({
          tools: ['bash', 'task_query', 'task_output', 'task_stop'],
          features: { mavis: false, delegation: true },
        }),
        taskAdapter: {} as never,
        taskControlAdapter: {} as never,
        taskAppendAdapter: {} as never,
      });

      const names = tools.map((tool) => tool.def.name);
      expect(names).toContain('bash');
      expect(names).toEqual(
        expect.arrayContaining(['task', 'task_append', 'task_query', 'task_output', 'task_stop']),
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('uses the turn reporter for todo event identity without reusing it as the message id', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-sources-'));
    const events: IRuntimeEvent[] = [];
    const nextEventId = vi.fn(() => 'evt_hosted-turn_todo_updated_39');
    const nextRuntimeSeq = vi.fn(() => 39);
    const runtimeToolsFor = vi.fn(async () => []);
    try {
      const sources = await buildLocalTurnToolSources({
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        sessionId: 'hosted-session',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor } as never,
        emitBusEvent: () => {},
      });
      const todo = sources.nativeTools.find((tool) => tool.def.name === 'todowrite');
      if (!todo) throw new Error('todowrite tool was not assembled');

      await todo.impl.execute(
        {
          sessionId: 'hosted-session',
          turnId: 'hosted-turn',
          agentName: 'mavis',
          eventWriter: {
            pushRuntime: async () => undefined,
            appendEvents: async () => {
              throw new Error('legacy writer must not own todo event identity');
            },
          },
          reporter: {
            nextEventId,
            nextRuntimeSeq,
            appendEvents: async (next) => {
              events.push(...next);
            },
          },
        },
        { todos: [{ content: 'wire host', status: 'in_progress' }] },
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_id: 'evt_hosted-turn_todo_updated_39',
        runtime_seq: 39,
      });
      expect(nextEventId).toHaveBeenCalledWith('todo_updated');
      expect(nextRuntimeSeq).toHaveBeenCalledOnce();
      const event = events[0];
      if (!event) throw new Error('todo_updated event was not emitted');
      const streamResp = JSON.parse(event.payload.stream_resp ?? '{}') as {
        agent_message?: { msg_id?: string };
      };
      expect(streamResp.agent_message?.msg_id).toMatch(/^todo_/u);
      expect(streamResp.agent_message?.msg_id).not.toBe(event.event_id);
      expect(sources.mcpEntries).toEqual([]);
      expect(sources.threadGoalTools).toEqual([]);
      expect(runtimeToolsFor).toHaveBeenCalledWith(false, 'hosted-session');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('degrades todo event emission when the turn reporter is unavailable', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-sources-'));
    const emitBusEvent = vi.fn();
    try {
      const sources = await buildLocalTurnToolSources({
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        sessionId: 'hosted-session',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent,
      });
      const todo = sources.nativeTools.find((tool) => tool.def.name === 'todowrite');
      if (!todo) throw new Error('todowrite tool was not assembled');

      const result = await todo.impl.execute(
        {
          sessionId: 'hosted-session',
          turnId: 'hosted-turn',
          agentName: 'mavis',
        },
        { todos: [{ content: 'keep working', status: 'in_progress' }] },
      );

      expect(result.details).toMatchObject({ event_emitted: false });
      expect(emitBusEvent).toHaveBeenCalledWith(
        'todo.event_emit_failed',
        expect.objectContaining({
          sessionId: 'hosted-session',
          turnId: 'hosted-turn',
          reason: 'turn_reporter_unavailable',
        }),
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('degrades a rejected todo event append even when failure diagnostics throw', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-sources-'));
    const emitBusEvent = vi.fn((type: string) => {
      if (type === 'todo.event_emit_failed') {
        throw new Error('diagnostic delivery unavailable');
      }
    });
    try {
      const sources = await buildLocalTurnToolSources({
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        sessionId: 'hosted-session',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent,
      });
      const todo = sources.nativeTools.find((tool) => tool.def.name === 'todowrite');
      if (!todo) throw new Error('todowrite tool was not assembled');

      const result = await todo.impl.execute(
        {
          sessionId: 'hosted-session',
          turnId: 'hosted-turn',
          agentName: 'mavis',
          reporter: {
            nextEventId: () => 'evt_hosted-turn_todo_updated_1',
            nextRuntimeSeq: () => 1,
            appendEvents: async () => {
              throw new Error('strict delivery rejected event');
            },
          },
        },
        { todos: [{ content: 'keep working', status: 'in_progress' }] },
      );

      expect(result.details).toMatchObject({ event_emitted: false });
      expect(emitBusEvent).toHaveBeenCalledWith(
        'todo.event_emit_failed',
        expect.objectContaining({
          sessionId: 'hosted-session',
          turnId: 'hosted-turn',
          reason: 'strict delivery rejected event',
        }),
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps task control tools available when nested task creation is disabled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-tools-'));
    try {
      const { nativeTools: tools } = await buildLocalTurnToolSources({
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        eventWriter: new LocalEventSink(),
        sessionId: 'task-session',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent: () => {},
        enableTaskTool: false,
        taskAdapter: {} as never,
        taskAppendAdapter: {} as never,
        taskControlAdapter: {
          get: async () => undefined,
          list: async () => ({ items: [] }),
          readOutput: async () => ({ content: '', nextOffset: 0 }),
          stop: async () => undefined,
        },
      });

      const toolNames = tools.map((tool) => tool.def.name);
      expect(toolNames).toEqual(expect.arrayContaining(['bash']));
      expect(toolNames).not.toContain('task');
      // A task child may neither start nor continue a delegation, so the raw
      // v1 source never injects `task_append` there either. The read/control
      // handles stay and are removed later by the final catalog gate.
      expect(toolNames).not.toContain('task_append');
      expect(toolNames).toEqual(expect.arrayContaining(['task_query', 'task_output', 'task_stop']));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('includes todowrite for regular turns (default)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-tools-'));
    try {
      const { nativeTools: tools } = await buildLocalTurnToolSources({
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        eventWriter: new LocalEventSink(),
        sessionId: 'todo-default-session',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent: () => {},
      });

      expect(tools.map((tool) => tool.def.name)).toContain('todowrite');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('drops todowrite for subagent turns (enableTodoWriteTool: false)', async () => {
    // Subagent turns run in hidden child sessions; their todowrite calls would
    // pollute the parent-facing task list stream, so the assembly gates it off
    // the same way enableTaskTool gates nested task creation.
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-tools-'));
    try {
      const { nativeTools: tools } = await buildLocalTurnToolSources({
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        eventWriter: new LocalEventSink(),
        sessionId: 'todo-gated-session',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent: () => {},
        enableTodoWriteTool: false,
      });

      const toolNames = tools.map((tool) => tool.def.name);
      expect(toolNames).not.toContain('todowrite');
      expect(toolNames).toEqual(expect.arrayContaining(['bash', 'read'])); // siblings survive
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('wires injected fetchImpl into the local web_fetch tool', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-tools-web-fetch-'));
    const fetchImpl = vi.fn(async () => {
      return new Response('hello from injected fetch', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    });
    try {
      const { nativeTools: tools } = await buildLocalTurnToolSources({
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        eventWriter: new LocalEventSink(),
        sessionId: 'web-fetch-session',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent: () => {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const webFetch = tools.find((tool) => tool.def.name === 'web_fetch');
      expect(webFetch).toBeDefined();
      const result = await webFetch!.impl.execute(
        { sessionId: 'web-fetch-session', turnId: 'turn-web-fetch', agentName: 'mavis' },
        { url: 'https://example.test/page' },
      );

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://example.test/page');
      expect(result.text).toContain('hello from injected fetch');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('wires the local mavis tool to agent, cron, session, and MCP adapters', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-tools-'));
    const cronCalls: unknown[] = [];
    const cronSessionCalls: unknown[] = [];
    const sessionCalls: unknown[] = [];
    const busEvents: unknown[] = [];
    try {
      const { nativeTools: tools } = await buildLocalTurnToolSources({
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        eventWriter: new LocalEventSink(),
        sessionId: 'session-current',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent: (type, payload) => busEvents.push({ type, payload }),
        mavisAgentAdapter: {
          listAgents: async () => ({ agents: [] }),
          createAgent: async () => ({ name: 'created' }),
          getAgent: async (req) => ({ agent: { name: req.name, displayName: req.name } }),
          updateAgent: async (req) => ({ success: true, agent: { name: req.name } }),
          deleteAgent: async () => ({ success: true }),
        },
        mavisCronAdapter: {
          listCrons: async (req) => {
            cronCalls.push(req);
            return { tasks: [{ cronId: 'cron-1', agentName: req.agentName }] };
          },
          getCron: async (req) => ({ task: { cronId: req.cronId } }),
          createCron: async (req) => ({ task: { cronId: 'created', cronName: req.cronName } }),
          updateCron: async (req) => ({ task: { cronId: req.cronId } }),
          deleteCron: async () => ({ success: true }),
          triggerCron: async () => ({ success: true }),
          listCronSessions: async (req) => {
            cronSessionCalls.push(req);
            return {
              sessions: [{ sessionId: 'sess-1', createdAt: 1700000000000 }],
              hasMore: true,
              nextCursor: 'sess-1',
            };
          },
        },
        mavisSessionAdapter: {
          listSessions: async () => ({ sessions: [] }),
          getSession: async (req) => ({
            session: { sessionId: req.sessionId, agentName: 'mavis' },
          }),
          updateSession: async (req) => ({ success: true, session: { sessionId: req.sessionId } }),
          deleteSession: async () => ({ success: true }),
          listMessages: async (req) => {
            sessionCalls.push(req);
            return { messages: [{ content: 'ok' }] };
          },
        },
      });

      const mavis = tools.find((tool) => tool.def.name === 'mavis');
      expect(mavis).toBeDefined();

      const cronResult = await mavis!.impl.execute(
        { sessionId: 'session-current', turnId: 'turn-1', agentName: 'mavis' },
        { command: 'cron list', args: { agent_name: 'me', limit: 1 } },
      );
      expect(JSON.parse(cronResult.text)).toMatchObject({
        ok: true,
        command: 'cron list',
        response: { tasks: [{ cronId: 'cron-1', agentName: 'mavis' }] },
      });
      expect(cronCalls).toEqual([{ agentName: 'mavis', limit: 1 }]);

      const cronSessionsResult = await mavis!.impl.execute(
        { sessionId: 'session-current', turnId: 'turn-1', agentName: 'mavis' },
        {
          command: 'cron sessions',
          args: { cron_id: 'cron-1', cursor: 'sess-0', limit: 1 },
        },
      );
      expect(JSON.parse(cronSessionsResult.text)).toMatchObject({
        ok: true,
        command: 'cron sessions',
        response: {
          sessions: [{ sessionId: 'sess-1', createdAt: 1700000000000 }],
          hasMore: true,
          nextCursor: 'sess-1',
        },
      });
      expect(cronSessionCalls).toEqual([{ cronId: 'cron-1', cursor: 'sess-0', limit: 1 }]);

      const sessionResult = await mavis!.impl.execute(
        { sessionId: 'session-current', turnId: 'turn-1', agentName: 'mavis' },
        { command: 'session messages', args: { session_id: 'me' } },
      );
      expect(JSON.parse(sessionResult.text)).toMatchObject({
        ok: true,
        command: 'session messages',
        response: { messages: [{ content: 'ok' }] },
      });
      expect(sessionCalls).toEqual([{ sessionId: 'session-current' }]);

      const mcpResult = await mavis!.impl.execute(
        { sessionId: 'session-current', turnId: 'turn-1', agentName: 'mavis' },
        {
          command: 'mcp create',
          args: { name: 'docs', transport: 'stdio', command: 'npx', enabled: false },
        },
      );
      expect(JSON.parse(mcpResult.text)).toMatchObject({
        ok: true,
        command: 'mcp create',
        response: { server: { name: 'docs', enabled: false } },
      });
      expect(busEvents).toContainEqual({
        type: 'mcp.settings.changed',
        payload: { operation: 'create', name: 'docs' },
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('blocks a disabled built-in Skill from known-name reads without hiding other Skills', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-disabled-skill-'));
    try {
      initSkillService({
        configGetter: () => ({ dataDir, defaultModel: 'test/model' }),
        skillRegistryRoots: [
          {
            id: 'builtin-disabled-skill-test',
            kind: 'builtin',
            rootPath: join(packageRoot, 'assets/skills'),
          },
        ],
      });
      const commonInput = {
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        eventWriter: new LocalEventSink(),
        sessionId: 'disabled-skill-session',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent: () => {},
      };
      const { nativeTools: unrestrictedTools } = await buildLocalTurnToolSources(commonInput);
      const unrestrictedSkill = unrestrictedTools.find((tool) => tool.def.name === 'skill');
      const context = {
        sessionId: 'disabled-skill-session',
        turnId: 'turn-skill',
        agentName: 'mavis',
      };

      const available = await unrestrictedSkill!.impl.execute(context, { name: 'lark-tools' });
      expect(available.text).toContain('# Feishu / Lark Tools');

      const { nativeTools: restrictedTools } = await buildLocalTurnToolSources({
        ...commonInput,
        disabledBuiltinSkillNames: ['lark-tools'],
      });
      const restrictedSkill = restrictedTools.find((tool) => tool.def.name === 'skill');
      const blocked = await restrictedSkill!.impl.execute(context, { name: 'lark-tools' });
      const unrelated = await restrictedSkill!.impl.execute(context, { name: 'skill-creator' });

      expect(blocked.text).toBe('Local skill not found: lark-tools');
      expect(unrelated.text).toContain('name: skill-creator');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('does not read a recreated Agent private skill through a frozen model tool', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-frozen-private-'));
    try {
      const root = join(dataDir, 'agents', 'deleted-agent', 'skills', 'private-skill');
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, 'SKILL.md'),
        '---\nname: private-skill\ndescription: Private skill\n---\nRECREATED AGENT',
      );
      const resolveAgentReadScope = vi.fn(async () => {
        throw new Error('Unexpected live Agent lookup');
      });
      initSkillService({
        configGetter: () => ({ dataDir, defaultModel: 'test/model' }),
        resolveAgentReadScope,
      });
      const { nativeTools } = await buildLocalTurnToolSources({
        toolsDisabled: false,
        workspaceRoot: dataDir,
        agentName: 'deleted-agent',
        dataDir,
        sessionId: 'frozen-private-session',
        skipAgentResolution: true,
        expectedAgentInstanceId: '1a28d970-1f50-488b-84c5-df039713632a',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent: () => {},
      });
      const skill = nativeTools.find((tool) => tool.def.name === 'skill');
      const context = {
        sessionId: 'frozen-private-session',
        turnId: 'turn-2',
        agentName: 'deleted-agent',
      };
      const marker = join(dataDir, 'agents', 'deleted-agent', '.agent-instance-id');
      await writeFile(marker, '1a28d970-1f50-488b-84c5-df039713632a');
      expect((await skill!.impl.execute(context, { name: 'private-skill' })).text).toContain(
        'RECREATED AGENT',
      );
      await writeFile(marker, '2a28d970-1f50-488b-84c5-df039713632a');
      const result = await skill!.impl.execute(context, { name: 'private-skill' });
      expect(result.text).toBe('Local skill not found: private-skill');
      expect(resolveAgentReadScope).not.toHaveBeenCalled();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('blocks a Skill known from historical messages when the frozen selector closes it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-frozen-skill-'));
    try {
      initSkillService({
        configGetter: () => ({ dataDir, defaultModel: 'test/model' }),
        skillRegistryRoots: [
          {
            id: 'builtin-frozen-skill-test',
            kind: 'builtin',
            rootPath: join(packageRoot, 'assets/skills'),
          },
        ],
      });
      const { nativeTools } = await buildLocalTurnToolSources({
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        eventWriter: new LocalEventSink(),
        sessionId: 'frozen-skill-session',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent: () => {},
        allowedSkillNames: [],
        allowedExtensionSkillNames: [],
      });
      const skill = nativeTools.find((tool) => tool.def.name === 'skill');

      const blocked = await skill!.impl.execute(
        { sessionId: 'frozen-skill-session', turnId: 'turn-2', agentName: 'mavis' },
        { name: 'lark-tools' },
      );

      expect(blocked.text).toBe('Local skill not found: lark-tools');
      expect(blocked.details).toMatchObject({ found: false });
      expect(blocked.text).not.toContain('SKILL.md');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('reads Plugin skill content from the capability view captured for this turn', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-tools-plugin-skill-'));
    try {
      initSkillService({
        configGetter: () => ({ dataDir, defaultModel: 'test/model' }),
        skillRegistryRoots: [],
      });
      const commonInput = {
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        eventWriter: new LocalEventSink(),
        sessionId: 'plugin-skill-session',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent: () => {},
        desktopCapabilities: {
          revision: 'plugin-r1',
          plugins: [{ name: 'notes', appProviders: [] }],
          skills: [
            {
              pluginName: 'notes',
              name: 'notes:plugin-notes',
              description: 'Plugin notes workflow',
              content: '# Captured Plugin notes body',
              location: join(dataDir, 'plugins', 'notes', 'skills', 'plugin-notes', 'SKILL.md'),
              sourceKind: 'desktop-plugin',
            },
          ],
          runtimeTools: [],
          runtimeToolBindings: [],
        },
      };
      const { nativeTools: blockedTools } = await buildLocalTurnToolSources({
        ...commonInput,
        allowedSkillNames: [],
        allowedExtensionSkillNames: ['notes:plugin-notes'],
      });
      const blockedSkill = blockedTools.find((tool) => tool.def.name === 'skill');
      const blocked = await blockedSkill!.impl.execute(
        { sessionId: 'plugin-skill-session', turnId: 'turn-1', agentName: 'mavis' },
        { name: 'notes:plugin-notes' },
      );
      expect(blocked.text).toBe('Local skill not found: notes:plugin-notes');

      const { nativeTools: tools } = await buildLocalTurnToolSources({
        ...commonInput,
        allowedSkillNames: [' NOTES:PLUGIN-NOTES '],
        allowedExtensionSkillNames: [' NOTES:PLUGIN-NOTES '],
      });
      const skill = tools.find((tool) => tool.def.name === 'skill');

      const loaded = await skill!.impl.execute(
        { sessionId: 'plugin-skill-session', turnId: 'turn-1', agentName: 'mavis' },
        { name: 'notes:plugin-notes' },
      );
      expect(loaded.text).toContain('# Captured Plugin notes body');
      expect(loaded.details).toMatchObject({
        found: true,
        source: 'desktop-plugin',
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('does not load the CU skill through the model skill tool when the turn snapshot is inactive', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-cu-skill-'));
    try {
      initSkillService({
        configGetter: () => ({
          dataDir,
          defaultModel: 'test/model',
          beta: { cuMode: true },
        }),
        skillRegistryRoots: [
          {
            id: 'builtin-cu-skill-test',
            kind: 'builtin',
            rootPath: join(packageRoot, 'assets/skills'),
          },
        ],
      });
      const commonInput = {
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        eventWriter: new LocalEventSink(),
        sessionId: 'cu-skill-session',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent: () => {},
      };
      const { nativeTools: inactiveTools } = await buildLocalTurnToolSources({
        ...commonInput,
        cuModeActive: false,
      });
      const inactiveSkill = inactiveTools.find((tool) => tool.def.name === 'skill');
      const blocked = await inactiveSkill!.impl.execute(
        { sessionId: 'cu-skill-session', turnId: 'turn-skill-off', agentName: 'mavis' },
        { name: 'cu-desktop' },
      );
      expect(blocked.text).toBe('Local skill not found: cu-desktop');

      const { nativeTools: activeTools } = await buildLocalTurnToolSources({
        ...commonInput,
        cuModeActive: true,
      });
      const activeSkill = activeTools.find((tool) => tool.def.name === 'skill');
      const loaded = await activeSkill!.impl.execute(
        { sessionId: 'cu-skill-session', turnId: 'turn-skill-on', agentName: 'mavis' },
        { name: 'cu-desktop' },
      );
      expect(loaded.text).toContain('# Computer Use — Desktop Operation Guide');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('blocks direct skill reads when the owning capability is disabled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-owned-skills-'));
    try {
      initSkillService({
        configGetter: () => ({
          dataDir,
          defaultModel: 'test/model',
        }),
        skillRegistryRoots: [
          {
            id: 'builtin-owned-skill-test',
            kind: 'builtin',
            rootPath: join(packageRoot, 'assets/skills'),
          },
          {
            id: 'agent-owned-skill-test',
            kind: 'builtin',
            scope: 'mavis',
            rootPath: join(packageRoot, '../local-runtime-v2/assets/agents/mavis/skills'),
          },
        ],
      });
      const { nativeTools: tools } = await buildLocalTurnToolSources({
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        eventWriter: new LocalEventSink(),
        sessionId: 'owned-skill-session',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent: () => {},
        builtinCapabilities: resolveAgentCapabilities({
          tools: ['read', 'write'],
          skills: ['visual-page'],
          features: { mavis: false, delegation: false },
        }),
        memoryEnabled: false,
      });
      const skill = tools.find((tool) => tool.def.name === 'skill');
      const context = {
        sessionId: 'owned-skill-session',
        turnId: 'owned-skill-turn',
        agentName: 'mavis',
      };

      for (const name of ['mavis', 'create-agent', 'mavis-team']) {
        const blocked = await skill!.impl.execute(context, { name });
        expect(blocked.text).toBe(`Local skill not found: ${name}`);
      }
      const allowed = await skill!.impl.execute(context, { name: 'visual-page' });
      expect(allowed.text).toContain('# Visual Page Skill');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps Mavis-owned skill reads when the Mavis feature owner is selected', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-mavis-skills-'));
    try {
      initSkillService({
        configGetter: () => ({
          dataDir,
          defaultModel: 'test/model',
        }),
        skillRegistryRoots: [
          {
            id: 'builtin-mavis-skill-test',
            kind: 'builtin',
            rootPath: await createSyntheticSkills(dataDir),
          },
        ],
      });
      const { nativeTools: tools } = await buildLocalTurnToolSources({
        toolsDisabled: false,
        workspaceRoot: process.cwd(),
        agentName: 'mavis',
        dataDir,
        eventWriter: new LocalEventSink(),
        sessionId: 'mavis-skill-session',
        mcpService: new LocalMcpService(() => dataDir),
        threadGoal: { runtimeToolsFor: () => [] } as never,
        emitBusEvent: () => {},
        builtinCapabilities: resolveAgentCapabilities({
          tools: [],
          skills: [],
          features: { mavis: true, delegation: false },
        }),
        memoryEnabled: false,
      });
      const skill = tools.find((tool) => tool.def.name === 'skill');
      const context = {
        sessionId: 'mavis-skill-session',
        turnId: 'mavis-skill-turn',
        agentName: 'mavis',
      };

      const mavis = await skill!.impl.execute(context, { name: 'mavis' });
      expect(mavis.text).toContain('# Mavis');
      const createAgent = await skill!.impl.execute(context, { name: 'create-agent' });
      expect(createAgent.text).toContain('# Create Agent');
      expect(createAgent.text).toContain(
        'Only proceed after the user explicitly asks for or approves creating an agent.',
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('reads miniapp-creator through the generic Skill allowlist only when Host lifecycle is available', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-native-miniapp-skill-'));
    try {
      initSkillService({
        configGetter: () => ({ dataDir, defaultModel: 'test/model' }),
        skillRegistryRoots: [
          {
            id: 'builtin-miniapp-skill-read-test',
            kind: 'builtin',
            rootPath: await createSyntheticSkills(dataDir),
          },
        ],
      });
      const buildSkill = async (miniappAvailable: boolean) => {
        const sessionId = `miniapp-skill-${miniappAvailable ? 'available' : 'unavailable'}`;
        const { nativeTools } = await buildLocalTurnToolSources({
          toolsDisabled: false,
          workspaceRoot: process.cwd(),
          agentName: 'mavis',
          dataDir,
          eventWriter: new LocalEventSink(),
          sessionId,
          mcpService: new LocalMcpService(() => dataDir),
          threadGoal: { runtimeToolsFor: () => [] } as never,
          emitBusEvent: () => {},
          builtinCapabilities: resolveAgentCapabilities({
            tools: ['read', 'write', 'edit', 'bash'],
            skills: [],
            features: { mavis: false, delegation: false, webSearch: false },
          }),
          ...(miniappAvailable ? { miniappAvailable: true } : {}),
          memoryEnabled: false,
        });
        return { sessionId, skill: nativeTools.find((tool) => tool.def.name === 'skill')! };
      };

      const available = await buildSkill(true);
      const availableResult = await available.skill.impl.execute(
        {
          sessionId: available.sessionId,
          turnId: 'miniapp-skill-available-turn',
          agentName: 'mavis',
        },
        { name: 'miniapp-creator' },
      );
      expect(availableResult.text).toContain('# Mini App Creator');

      const unavailable = await buildSkill(false);
      const unavailableResult = await unavailable.skill.impl.execute(
        {
          sessionId: unavailable.sessionId,
          turnId: 'miniapp-skill-unavailable-turn',
          agentName: 'mavis',
        },
        { name: 'miniapp-creator' },
      );
      expect(unavailableResult.text).toBe('Local skill not found: miniapp-creator');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// Exercise generic skill ownership with synthetic assets; desktop-only builtins
// are deliberately absent from the standalone distribution.
async function createSyntheticSkills(dataDir: string): Promise<string> {
  const root = join(dataDir, 'fixture-skills');
  for (const [name, title] of [['mavis', 'Mavis'], ['create-agent', 'Create Agent'], ['miniapp-creator', 'Mini App Creator']]) {
    const dir = join(root, name!);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic test skill.\n---\n# ${title}\nOnly proceed after the user explicitly asks for or approves creating an agent.\n`);
  }
  return root;
}
