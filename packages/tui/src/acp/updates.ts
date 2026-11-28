import type * as acp from '@agentclientprotocol/sdk';

import {
  buildTuiMessageParts,
  type TuiStreamEvent,
  type TuiToolCall,
} from '../runtime/stream-events.js';
import type { TuiStructuredPreviewBlock } from '../types/runtime-models.js';
import { isTuiAcpAbsolutePath } from './paths.js';

interface AnonymousToolCall {
  toolCallId: string;
  name: string;
  parentToolCallId?: string;
  identityKey?: string;
}

export class TuiAcpUpdateProjector {
  private readonly toolIds = new Map<string, string>();
  private readonly anonymousToolCalls = new Map<string, AnonymousToolCall>();
  private readonly anonymousToolCallIdsByIdentity = new Map<string, string>();
  private readonly completedToolIds = new Set<string>();
  private readonly streamedMessageIds = new Set<string>();
  private nextAnonymousToolId = 1;

  project(event: TuiStreamEvent): acp.SessionUpdate[] {
    if (event.type === 'message') return this.projectMessage(event.message);
    if (event.type === 'messages-replaced') {
      return event.messages.flatMap((message) => this.projectMessage(message));
    }
    if (event.type === 'generic') return this.projectGeneric(event);
    if (event.type !== 'delta') return [];
    const updates: acp.SessionUpdate[] = [];
    if (event.messageId && (event.thinking || event.content)) {
      this.streamedMessageIds.add(event.messageId);
    }
    if (event.thinking) {
      updates.push({
        sessionUpdate: 'agent_thought_chunk',
        ...(event.messageId ? { messageId: event.messageId } : {}),
        content: { type: 'text', text: event.thinking },
      });
    }
    if (event.content) {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        ...(event.messageId ? { messageId: event.messageId } : {}),
        content: { type: 'text', text: event.content },
      });
    }
    for (const tool of event.toolCalls ?? []) {
      const update = this.projectTool(tool);
      if (update) updates.push(update);
    }
    return updates;
  }

  private projectMessage(
    message: Extract<TuiStreamEvent, { type: 'message' }>['message'],
  ): acp.SessionUpdate[] {
    if (message.role !== 'assistant') return [];
    if (message.id && this.streamedMessageIds.has(message.id)) return [];
    if (message.id) this.streamedMessageIds.add(message.id);
    return buildTuiMessageParts(message).flatMap((part): acp.SessionUpdate[] => {
      if (part.type === 'thinking') {
        return [
          {
            sessionUpdate: 'agent_thought_chunk',
            ...(message.id ? { messageId: message.id } : {}),
            content: { type: 'text', text: part.content },
          },
        ];
      }
      if (part.type === 'text') {
        return [
          {
            sessionUpdate: 'agent_message_chunk',
            ...(message.id ? { messageId: message.id } : {}),
            content: { type: 'text', text: part.content },
          },
        ];
      }
      const update = this.projectTool(part.toolCall);
      return update ? [update] : [];
    });
  }

  private projectGeneric(event: Extract<TuiStreamEvent, { type: 'generic' }>): acp.SessionUpdate[] {
    if (event.eventType !== 'model_replacement') return [];
    const notice = formatModelReplacementNotice(event.data);
    if (!notice) return [];
    // ACP has no warning update kind, so the notice rides the agent message channel.
    return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: notice } }];
  }

  private projectTool(tool: TuiToolCall): acp.SessionUpdate | undefined {
    if (tool.id && this.completedToolIds.has(tool.id)) return undefined;
    const status = toolStatus(tool.status);
    const content = toolContent(tool);
    const locations = toolLocations(tool);
    const rawOutput = tool.output ?? (tool.error === undefined ? undefined : { error: tool.error });
    const start = (toolCallId: string) =>
      compact({
        sessionUpdate: 'tool_call' as const,
        toolCallId,
        title: tool.name,
        name: tool.name,
        kind: tuiAcpToolKind(tool.name),
        status,
        rawInput: tool.input,
        rawOutput,
        content,
        locations,
      });
    const update = (toolCallId: string) =>
      compact({
        sessionUpdate: 'tool_call_update' as const,
        toolCallId,
        status,
        rawInput: tool.input,
        rawOutput,
        content,
        locations,
      });

    if (!tool.id) {
      const resolved = this.resolveAnonymousTool(tool, status);
      if (!resolved.existing) return start(resolved.toolCallId);
      if (isTerminalToolStatus(status)) this.forgetAnonymousTool(resolved.toolCallId);
      return update(resolved.toolCallId);
    }

    const key = `id:${tool.id}`;
    const existingId = this.toolIds.get(key);
    const toolCallId = existingId ?? tool.id;
    if (!existingId) {
      if (isTerminalToolStatus(status)) {
        this.completedToolIds.add(tool.id);
      } else {
        this.toolIds.set(key, toolCallId);
      }
      return start(toolCallId);
    }

    if (isTerminalToolStatus(status)) {
      this.toolIds.delete(key);
      this.completedToolIds.add(tool.id);
    }
    return update(toolCallId);
  }

  private resolveAnonymousTool(
    tool: TuiToolCall,
    status: acp.ToolCallStatus | undefined,
  ): { toolCallId: string; existing: boolean } {
    const identityKey = anonymousToolIdentity(tool);
    if (identityKey !== undefined) {
      const existingId = this.anonymousToolCallIdsByIdentity.get(identityKey);
      if (existingId) return { toolCallId: existingId, existing: true };
    }

    if (isTerminalToolStatus(status) || hasAnonymousToolUpdatePayload(tool)) {
      const candidates = [...this.anonymousToolCalls.values()].filter(
        (candidate) =>
          candidate.name === tool.name && candidate.parentToolCallId === tool.parentToolCallId,
      );
      const [candidate] = candidates;
      if (candidates.length === 1 && candidate) {
        return { toolCallId: candidate.toolCallId, existing: true };
      }
    }

    const toolCallId = `minimax-code-tool-${this.nextAnonymousToolId++}`;
    if (!isTerminalToolStatus(status)) {
      const candidate: AnonymousToolCall = {
        toolCallId,
        name: tool.name,
        ...(tool.parentToolCallId ? { parentToolCallId: tool.parentToolCallId } : {}),
        ...(identityKey !== undefined ? { identityKey } : {}),
      };
      this.anonymousToolCalls.set(toolCallId, candidate);
      if (identityKey !== undefined) {
        this.anonymousToolCallIdsByIdentity.set(identityKey, toolCallId);
      }
    }
    return { toolCallId, existing: false };
  }

  private forgetAnonymousTool(toolCallId: string): void {
    const candidate = this.anonymousToolCalls.get(toolCallId);
    if (!candidate) return;
    this.anonymousToolCalls.delete(toolCallId);
    if (
      candidate.identityKey &&
      this.anonymousToolCallIdsByIdentity.get(candidate.identityKey) === toolCallId
    ) {
      this.anonymousToolCallIdsByIdentity.delete(candidate.identityKey);
    }
  }
}

/**
 * Runtime replaced the requested model, so the client has to learn which model
 * actually answered this Turn.
 */
function formatModelReplacementNotice(data: Readonly<Record<string, unknown>>): string | undefined {
  const requested = readModelReference(data.requestedModel);
  const actual = readModelReference(data.actualModel);
  if (!requested || !actual) return undefined;
  const tier = readText(data.tier);
  const reason = readText(data.reason);
  const detail = [tier, reason].filter((value) => value !== undefined).join(': ');
  return `Model replacement: requested ${requested}, served by ${actual}${
    detail ? ` (${detail})` : ''
  }.`;
}

function readModelReference(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const providerId = readText(record.providerId);
  const modelId = readText(record.modelId);
  if (!providerId || !modelId) return undefined;
  return `${providerId}/${modelId}`;
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function tuiAcpToolKind(name: string): acp.ToolKind {
  const normalized = name.toLowerCase();
  if (normalized.includes('read') || normalized.includes('view')) return 'read';
  if (normalized.includes('edit') || normalized.includes('write') || normalized.includes('patch')) {
    return 'edit';
  }
  if (normalized.includes('delete') || normalized.includes('remove')) return 'delete';
  if (normalized.includes('move') || normalized.includes('rename')) return 'move';
  if (normalized.includes('search') || normalized.includes('find') || normalized.includes('grep')) {
    return 'search';
  }
  if (normalized.includes('fetch') || normalized.includes('http') || normalized.includes('web')) {
    return 'fetch';
  }
  if (normalized.includes('think') || normalized.includes('plan')) return 'think';
  if (
    normalized.includes('shell') ||
    normalized.includes('bash') ||
    normalized.includes('terminal') ||
    normalized.includes('exec') ||
    normalized.includes('command')
  ) {
    return 'execute';
  }
  return 'other';
}

function toolStatus(status: TuiToolCall['status']): acp.ToolCallStatus | undefined {
  if (status === undefined) return undefined;
  const normalized = String(status).toLowerCase();
  if (normalized === 'pending') return 'pending';
  if (
    normalized === '1' ||
    normalized === 'started' ||
    normalized === 'running' ||
    normalized === 'in_progress'
  ) {
    return 'in_progress';
  }
  if (
    normalized === '2' ||
    normalized === 'completed' ||
    normalized === 'succeeded' ||
    normalized === 'success'
  ) {
    return 'completed';
  }
  if (normalized === '3' || normalized === 'failed' || normalized === 'error') return 'failed';
  return undefined;
}

function isTerminalToolStatus(status: acp.ToolCallStatus | undefined): boolean {
  return status === 'completed' || status === 'failed';
}

function hasAnonymousToolUpdatePayload(tool: TuiToolCall): boolean {
  return tool.output !== undefined || tool.error !== undefined || tool.durationMs !== undefined;
}

function anonymousToolIdentity(tool: TuiToolCall): string | undefined {
  const inputKey = stableSerialize(tool.input);
  if (inputKey === undefined) return undefined;
  return [tool.parentToolCallId ?? '', tool.name, inputKey].join('\u0000');
}

function stableSerialize(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item) ?? 'undefined').join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, entry]) => {
      const serialized = stableSerialize(entry);
      return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
    });
  return `{${entries.join(',')}}`;
}

function toolContent(tool: TuiToolCall): acp.ToolCallContent[] | undefined {
  const blocks = tool.structuredPreview?.blocks.flatMap(projectPreviewBlock) ?? [];
  return blocks.length > 0 ? blocks : undefined;
}

function projectPreviewBlock(block: TuiStructuredPreviewBlock): acp.ToolCallContent[] {
  if (block.kind === 'diff' && block.path) {
    const texts = parseUnifiedDiff(block.diff);
    return [
      compact({
        type: 'diff' as const,
        path: block.path,
        oldText: texts.oldText,
        newText: texts.newText,
      }),
    ];
  }
  if (block.kind === 'file') {
    return [
      {
        type: 'content',
        content: { type: 'text', text: block.content },
      },
    ];
  }
  if (block.kind === 'summary') {
    return [
      {
        type: 'content',
        content: { type: 'text', text: block.message },
      },
    ];
  }
  return [];
}

function toolLocations(tool: TuiToolCall): acp.ToolCallLocation[] | undefined {
  const paths = new Set<string>();
  for (const block of tool.structuredPreview?.blocks ?? []) {
    if (block.path && isTuiAcpAbsolutePath(block.path)) paths.add(block.path);
  }
  for (const inputPath of readInputPaths(tool.input)) {
    if (isTuiAcpAbsolutePath(inputPath)) paths.add(inputPath);
  }
  return paths.size > 0 ? [...paths].map((path) => ({ path })) : undefined;
}

function readInputPaths(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  return ['path', 'filePath', 'file_path'].flatMap((key) =>
    typeof record[key] === 'string' ? [record[key]] : [],
  );
}

function parseUnifiedDiff(diff: string): { oldText?: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('-')) oldLines.push(line.slice(1));
    else if (line.startsWith('+')) newLines.push(line.slice(1));
    else {
      const content = line.startsWith(' ') ? line.slice(1) : line;
      oldLines.push(content);
      newLines.push(content);
    }
  }
  return {
    ...(oldLines.length > 0 ? { oldText: oldLines.join('\n') } : {}),
    newText: newLines.join('\n'),
  };
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
