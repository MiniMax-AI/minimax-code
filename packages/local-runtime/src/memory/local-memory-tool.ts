import type { LocalMemoryToolInput, LocalRuntimeToolContext } from '@mavis/agent-tools/desktop';

import type { ModuleMetricsReporter } from '../common/metrics.js';
import { LocalMemoryFacade } from './local-memory-facade.js';
import { formatLocalDate } from './local-memory-store-utils.js';
import { LocalMemoryError, type LocalMemoryScope } from './types.js';
import { emitResourceAmbiguityTelemetry } from '../agent/subagent-telemetry.js';

const VALID = new Set([
  'user:read',
  'user:search',
  'user:append',
  'main:read',
  'main:search',
  'main:append',
  'main:edit',
  'main:write',
  'topic:read',
  'topic:search',
  'topic:append',
  'topic:edit',
  'topic:create',
  'topic:delete',
  'summary:write',
]);

const READ_OPERATIONS = new Set([
  'user:read',
  'user:search',
  'main:read',
  'main:search',
  'topic:read',
  'topic:search',
]);

export interface LocalMemoryToolAccess {
  readEnabled?: boolean;
  writeEnabled?: boolean;
  agentScopeEnabled?: boolean;
}

export async function executeLocalMemoryTool(
  facade: LocalMemoryFacade,
  ctx: LocalRuntimeToolContext,
  input: LocalMemoryToolInput,
  emitBusEvent?: (type: string, payload: Record<string, unknown>) => void,
  metrics?: ModuleMetricsReporter,
  readAgentNames?: readonly string[],
  access?: LocalMemoryToolAccess | boolean,
) {
  const resolvedAccess = typeof access === 'boolean' ? { agentScopeEnabled: access } : access;
  const result = await runLocalMemoryTool(
    facade,
    ctx,
    input,
    emitBusEvent,
    metrics,
    readAgentNames,
    resolvedAccess,
  );
  const key = `${input.target}:${input.operation}`;
  // Bounded label guard: only the VALID enum reaches the metric; anything else
  // (user-supplied strings) collapses to 'invalid'.
  metrics?.incr('memory_tool_call_total', {
    operation: VALID.has(key) ? key : 'invalid',
    status: result.details.ok === false ? 'error' : 'ok',
  });
  return result;
}

async function runLocalMemoryTool(
  facade: LocalMemoryFacade,
  ctx: LocalRuntimeToolContext,
  input: LocalMemoryToolInput,
  emitBusEvent?: (type: string, payload: Record<string, unknown>) => void,
  metrics?: ModuleMetricsReporter,
  readAgentNames?: readonly string[],
  access?: LocalMemoryToolAccess,
) {
  const mark = (scope: LocalMemoryScope, text: string) =>
    markMemoryWritten(facade, ctx, scope, text, emitBusEvent);
  try {
    const key = `${input.target}:${input.operation}`;
    if (!VALID.has(key))
      throw new LocalMemoryError('INVALID_OPERATION', `invalid memory operation ${key}`);
    if (input.target !== 'user' && access?.agentScopeEnabled !== true) {
      throw new LocalMemoryError(
        'AGENT_SCOPE_DISABLED',
        'Agent-scoped Memory is unavailable for this Agent profile.',
      );
    }
    if (input.target !== 'user' && READ_OPERATIONS.has(key) && access?.readEnabled === false) {
      throw new LocalMemoryError(
        'MEMORY_READ_DISABLED',
        'Memory reads are disabled for this session.',
      );
    }
    if (!READ_OPERATIONS.has(key) && access?.writeEnabled === false) {
      throw new LocalMemoryError(
        'MEMORY_WRITE_DISABLED',
        'Memory writes are disabled for this session.',
      );
    }
    // user target → user scope; main/topic/summary → agent scope addressed by the
    // session's agent directory name. Local agents have no numeric id, so the
    // schema's optional `agentId` is ignored here.
    const scope: LocalMemoryScope = input.target === 'user' ? 'user' : 'agent';
    const agentName = scope === 'agent' ? requireAgentName(ctx.agentName) : '';
    const memoryReadNames =
      scope === 'agent' ? normalizeReadAgentNames(agentName, readAgentNames) : [];
    switch (key) {
      case 'user:read':
        return ok((await facade.getUserMemory()).content, { target: input.target });
      case 'main:read':
        return await readMainMemory(facade, memoryReadNames, input.target);
      case 'user:search':
        return ok(
          JSON.stringify(
            await facade.searchUserMemory(requireString(input.query, 'query')),
            null,
            2,
          ),
        );
      case 'main:search':
        return ok(
          JSON.stringify(
            await searchMainMemory(facade, memoryReadNames, requireString(input.query, 'query')),
            null,
            2,
          ),
        );
      case 'user:append':
        return ok(
          `Appended user memory (${(await facade.appendUserMemory(requireString(input.content, 'content'), input.reason)).sizeBytes} bytes).`,
        );
      case 'main:append':
        return mark(
          scope,
          `Appended memory (${(await facade.appendMemory(agentName, requireString(input.content, 'content'))).sizeBytes} bytes).`,
        );
      case 'main:edit': {
        const result = await facade.editMemory(
          agentName,
          requireString(input.oldString, 'oldString'),
          requireString(input.newString, 'newString'),
          input.replaceAll,
        );
        return mark(scope, `Edited memory: ${result.replacements} replacement(s).`);
      }
      case 'main:write':
        return mark(
          scope,
          `Wrote memory (${(await facade.writeMemory(agentName, requireString(input.content, 'content'))).sizeBytes} bytes).`,
        );
      case 'topic:read':
        return await readTopicMemory(
          facade,
          memoryReadNames,
          requireString(input.topicName, 'topicName'),
          emitBusEvent,
          metrics,
        );
      case 'topic:search':
        return ok(
          JSON.stringify(
            await searchTopicMemory(facade, memoryReadNames, requireString(input.query, 'query')),
            null,
            2,
          ),
        );
      case 'topic:append':
        return mark(
          scope,
          `Appended topic (${(await facade.appendTopic(agentName, requireString(input.topicName, 'topicName'), requireString(input.content, 'content'))).newSizeBytes} bytes).`,
        );
      case 'topic:edit': {
        const result = await facade.editTopic(
          agentName,
          requireString(input.topicName, 'topicName'),
          requireString(input.oldString, 'oldString'),
          requireString(input.newString, 'newString'),
          input.replaceAll,
        );
        return mark(scope, `Edited topic: ${result.replacements} replacement(s).`);
      }
      case 'topic:create':
        await facade.writeTopic(
          agentName,
          requireString(input.topicName, 'topicName'),
          input.description ?? '',
          requireString(input.content, 'content'),
        );
        return mark(scope, 'Created topic memory.');
      case 'topic:delete':
        return mark(
          scope,
          `Deleted topic: ${await facade.deleteTopic(agentName, requireString(input.topicName, 'topicName'))}.`,
        );
      case 'summary:write': {
        const content = requireString(input.content, 'content');
        await facade.writeMemorySummary(agentName, content);
        return mark(scope, 'Wrote memory summary.');
      }
      default:
        throw new LocalMemoryError('INVALID_OPERATION', `invalid memory operation ${key}`);
    }
  } catch (err) {
    const code = err instanceof LocalMemoryError ? err.code : 'LOCAL_MEMORY_TOOL_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    // The failure is already returned to the model as the tool result text, but
    // emit a memory-domain event too so "which memory operation failed for which
    // agent and why" is one queryable bus event, not a parse of tool-result text.
    // Metadata only — never the memory content.
    emitBusEvent?.('memory.tool_failed', {
      operation: `${input.target}:${input.operation}`,
      sessionId: ctx.sessionId,
      agentName: ctx.agentName,
      code,
      message,
    });
    return { text: `memory tool failed [${code}]: ${message}`, details: { ok: false, code } };
  }
}

async function markMemoryWritten(
  facade: LocalMemoryFacade,
  ctx: LocalRuntimeToolContext,
  scope: LocalMemoryScope,
  text: string,
  emitBusEvent?: (type: string, payload: Record<string, unknown>) => void,
) {
  if (ctx.sessionId && scope === 'agent' && ctx.agentName) {
    await facade.markSession(today(), ctx.sessionId, ctx.agentName, true).catch((err) => {
      // Memory write succeeded but tracking did not — without this the session's
      // wroteMemory/reflection state silently drifts and "why was this session not
      // flagged as having written memory" is only inferable by absence.
      emitBusEvent?.('memory.tool_tracking_failed', {
        sessionId: ctx.sessionId,
        agentName: ctx.agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return ok(text);
}

interface MemoryReadSource<T> {
  sourceAgent: string;
  value: T;
}

function normalizeReadAgentNames(
  executionTarget: string,
  readAgentNames: readonly string[] | undefined,
): string[] {
  const names = [executionTarget, ...(readAgentNames ?? [])]
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

async function readMainMemory(
  facade: LocalMemoryFacade,
  sourceNames: readonly string[],
  target: string,
) {
  const entries = await readSources(sourceNames, (sourceAgent) =>
    facade.getAgentMemory(sourceAgent),
  );
  const nonEmpty = entries.filter(({ value }) => value.content.trim().length > 0);
  const text =
    sourceNames.length <= 1
      ? (entries[0]?.value.content ?? '')
      : JSON.stringify(
          nonEmpty.map(({ sourceAgent, value }) => ({ sourceAgent, content: value.content })),
          null,
          2,
        );
  return ok(text, {
    target,
    ...(sourceNames.length > 1
      ? { sourceAgents: nonEmpty.map(({ sourceAgent }) => sourceAgent) }
      : {}),
  });
}

async function searchMainMemory(
  facade: LocalMemoryFacade,
  sourceNames: readonly string[],
  query: string,
) {
  const entries = await readSources(sourceNames, (sourceAgent) =>
    facade.searchMemory(sourceAgent, query),
  );
  if (sourceNames.length <= 1) return entries[0]?.value ?? [];
  return entries.flatMap(({ sourceAgent, value }) =>
    value.map((result) => ({ ...result, sourceAgent })),
  );
}

async function readTopicMemory(
  facade: LocalMemoryFacade,
  sourceNames: readonly string[],
  topicName: string,
  emitBusEvent?: (type: string, payload: Record<string, unknown>) => void,
  metrics?: ModuleMetricsReporter,
) {
  const candidates = (
    await readSources(sourceNames, async (sourceAgent) => {
      const topics = await facade.listTopics(sourceAgent);
      if (!topics.some((topic) => topic.name === topicName)) return undefined;
      return facade.getTopic(sourceAgent, topicName);
    })
  ).flatMap(({ sourceAgent, value }) => (value ? [{ sourceAgent, value }] : []));
  if (sourceNames.length <= 1) return ok(candidates[0]?.value.body ?? '');
  if (candidates.length === 0) return ok('');
  const canonical = candidates.find(({ sourceAgent }) => sourceAgent === sourceNames[0]);
  if (!canonical && candidates.length > 1) {
    emitResourceAmbiguityTelemetry({ emitBusEvent, metrics }, 'memory', candidates.length);
    throw new LocalMemoryError(
      'AMBIGUOUS_AGENT_RESOURCE',
      `Memory topic:${topicName} is ambiguous across sources: ${candidates
        .map(({ sourceAgent }) => sourceAgent)
        .join(', ')}`,
    );
  }
  const selected = canonical ?? candidates[0];
  return ok(JSON.stringify({ sourceAgent: selected!.sourceAgent, ...selected!.value }, null, 2));
}

async function searchTopicMemory(
  facade: LocalMemoryFacade,
  sourceNames: readonly string[],
  query: string,
) {
  const entries = await readSources(sourceNames, (sourceAgent) =>
    facade.searchTopics(sourceAgent, query),
  );
  if (sourceNames.length <= 1) return entries[0]?.value ?? [];
  return entries.flatMap(({ sourceAgent, value }) =>
    value.map((result) => ({ ...result, sourceAgent })),
  );
}

async function readSources<T>(
  sourceNames: readonly string[],
  read: (sourceAgent: string) => Promise<T>,
): Promise<Array<MemoryReadSource<T>>> {
  return Promise.all(
    sourceNames.map(async (sourceAgent) => ({
      sourceAgent,
      value: await read(sourceAgent),
    })),
  );
}

function requireAgentName(agentName: string | undefined): string {
  const normalized = agentName?.trim();
  if (!normalized) throw new LocalMemoryError('AGENT_NAME_REQUIRED', 'agent_name is required');
  return normalized;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new LocalMemoryError('MISSING_FIELD', `${name} is required`);
  return value;
}

function ok(text: string, details: Record<string, unknown> = {}) {
  return { text, details: { ok: true, ...details } };
}

function today(): string {
  return formatLocalDate();
}
