import type { ReminderEmission } from '@mavis/agent-runtime';
import { LIGHTWEIGHT_SESSION_PURPOSE } from '@mavis/protocol/local';

import { CONTEXT_USAGE_PROMPT_KINDS } from '../preparation/contracts.js';
import type { SessionRecord } from '../../../session-system/index.js';
import type { LocalContextUsagePromptRange } from './contracts.js';

export const LIGHTWEIGHT_SYSTEM_PROMPT = [
  'You are MiniMax Code in lightweight mode, optimized for conversation and general knowledge questions.',
  'Answer directly and concisely. Follow explicit user language and formatting requests.',
  '',
  'This mode exposes no tools and omits the full coding prompt, workspace and project instructions, Skills catalog, memory blocks, MCP schemas, and full environment block from provider context.',
  'Do not claim to inspect or change local files. If a request needs coding or tools, explain that the user must start a new standard session with `mcode --mode standard` or `mcode exec --mode standard`; standard is also the default when `--mode` is omitted.',
].join('\n');

export const LIGHTWEIGHT_TOOL_CALL_FALLBACK =
  'This request needs tools, which are unavailable in lightweight mode. Start a new standard Session with `mcode --mode standard`; standard is also the default when `--mode` is omitted.';

export interface ProviderContext<TTool> {
  readonly systemPrompt: string;
  readonly tools: readonly TTool[];
  readonly contextUsagePromptRanges?: readonly LocalContextUsagePromptRange[];
}

export function resolveProviderContextMode<TTool>(
  session: SessionRecord,
  context: ProviderContext<TTool>,
  operation: 'turn' | 'compaction' = 'turn',
): ProviderContext<TTool> {
  if (operation === 'compaction' || !isLightweightRootSession(session)) return context;
  return {
    systemPrompt: LIGHTWEIGHT_SYSTEM_PROMPT,
    tools: [],
  };
}

export function isLightweightRootSession(session: SessionRecord): boolean {
  return (
    session.purpose === LIGHTWEIGHT_SESSION_PURPOSE &&
    session.sessionKind === 'conversation' &&
    !session.parentSessionId
  );
}

export function renderAgentRuntimeReminders(reminders: readonly ReminderEmission[]): string {
  return reminders
    .map(({ providerName, reminder }) => {
      const content = reminder.content.trim();
      if (!isCompleteSystemReminderBlock(content)) {
        throw new Error(
          `AgentRuntime reminder provider '${providerName}' must emit one non-empty complete <system-reminder> block.`,
        );
      }
      return content;
    })
    .join('\n\n');
}

export function readPreparedSystemPrompt(agentConfig: Readonly<Record<string, unknown>>): string {
  const value = agentConfig.system_prompt;
  if (typeof value !== 'string') {
    throw new TypeError('Prepared AgentConfig.system_prompt must be a string.');
  }
  return value;
}

export function readPreparedContextUsagePromptRanges(
  agentConfig: Readonly<Record<string, unknown>>,
  systemPromptPrefix: string,
  baseSystemPrompt: string,
): readonly LocalContextUsagePromptRange[] | undefined {
  const value = agentConfig.contextUsagePromptRanges;
  if (!Array.isArray(value) || baseSystemPrompt !== baseSystemPrompt.trim()) return undefined;
  const ranges = value.map((candidate) => readContextUsagePromptRange(candidate, baseSystemPrompt));
  if (!ranges.every((range): range is LocalContextUsagePromptRange => range !== undefined)) {
    return undefined;
  }
  const prefix = systemPromptPrefix.trim();
  const offset = prefix ? prefix.length + 2 : 0;
  return ranges.map((range) => ({
    ...range,
    startOffset: range.startOffset + offset,
    endOffset: range.endOffset + offset,
  }));
}

export function joinPrompt(...contributions: readonly string[]): string {
  return contributions
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n\n');
}

export function joinUserPrompt(
  prefix: string,
  runtimeReminders: string,
  hostReminders: string,
  canonicalUserText: string,
): string {
  const leading = joinPrompt(prefix, runtimeReminders, hostReminders);
  if (!leading) return canonicalUserText;
  return canonicalUserText ? `${leading}\n\n${canonicalUserText}` : leading;
}

function isCompleteSystemReminderBlock(content: string): boolean {
  const opening = '<system-reminder>';
  const closing = '</system-reminder>';
  if (!content.startsWith(opening) || !content.endsWith(closing)) return false;
  const body = content.slice(opening.length, -closing.length);
  return Boolean(body.trim()) && !/<\s*\/?\s*system-reminder(?=[\s/>])/iu.test(body);
}

function readContextUsagePromptRange(
  value: unknown,
  systemPrompt: string,
): LocalContextUsagePromptRange | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const kind = Reflect.get(value, 'kind');
  const startOffset = Reflect.get(value, 'startOffset');
  const endOffset = Reflect.get(value, 'endOffset');
  if (!isContextUsagePromptKind(kind)) return undefined;
  if (!isValidPromptRange(startOffset, endOffset, systemPrompt.length)) return undefined;
  return { kind, startOffset, endOffset };
}

function isContextUsagePromptKind(value: unknown): value is LocalContextUsagePromptRange['kind'] {
  return CONTEXT_USAGE_PROMPT_KINDS.some((kind) => kind === value);
}

function isValidPromptRange(
  startOffset: unknown,
  endOffset: unknown,
  promptLength: number,
): boolean {
  if (typeof startOffset !== 'number' || typeof endOffset !== 'number') return false;
  return (
    Number.isInteger(startOffset) &&
    Number.isInteger(endOffset) &&
    startOffset >= 0 &&
    endOffset > startOffset &&
    endOffset <= promptLength
  );
}
