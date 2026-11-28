/**
 * count_tokens request-body builder + CJK-aware char fallback for
 * {@link RemoteTokenCounter}.
 *
 * Why flatten to alternating text
 * -------------------------------
 * The remote `count_tokens` endpoint is Messages-compatible-shaped. Faithfully
 * reconstructing `tool_use` / `tool_result` pairing (matching `tool_use_id`s
 * across messages) is fragile — a single mismatch makes the provider reject the
 * body with a 4xx, which would defeat the whole point of asking it for a count.
 *
 * Since we only need a token *count*, we degrade every non-text block to text:
 * tool calls become `name(args-json)`, tool results become a labelled text
 * block, thinking is inlined, images become a short placeholder. The result is
 * always a valid alternating user/assistant transcript. This slightly
 * over-counts thinking and under-counts image binary; both directions are
 * absorbed by the manager's `safetyMarginTokens` / `reserveTokens` headroom.
 */

import { convertToLlm } from '@earendil-works/pi-coding-agent/messages';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model, Tool } from '@earendil-works/pi-ai';

/** Temperature is required by the gateway body but ignored for counting. */
const COUNT_TOKENS_TEMPERATURE = 1;
/** Placeholder so image binary does not bloat the request; count is approximate. */
const IMAGE_PLACEHOLDER = '[image]';
/** Messages-compatible endpoints reject empty content blocks; substitute a marker. */
const EMPTY_TEXT_PLACEHOLDER = '(empty)';
/** Per-message structural overhead used by the char-count fallback. */
const FALLBACK_MESSAGE_OVERHEAD = 4;

export interface CountTokensTextBlock {
  type: 'text';
  text: string;
}

export interface CountTokensMessage {
  role: 'user' | 'assistant';
  content: CountTokensTextBlock[];
}

export interface CountTokensRequestBody {
  model: string;
  max_tokens: number;
  stream: false;
  temperature: number;
  messages: CountTokensMessage[];
  system?: CountTokensTextBlock[];
  /** 参与计数的工具声明；缺省表示本次请求不带工具。 */
  tools?: CountTokensTool[];
}

/**
 * Messages-compatible count_tokens 端点的工具声明形状。工具声明是真实 LLM 请求
 * payload 的一部分（MCP 重的会话可达数万 token），计数请求必须带上同样的
 * 声明，否则计出来的值系统性偏低。`input_schema` 即工具参数的 JSON Schema。
 */
export interface CountTokensTool {
  name: string;
  description: string;
  input_schema: unknown;
}

type PiContentBlock = { type: string; [key: string]: unknown };

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as PiContentBlock[]) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'image') {
      parts.push(IMAGE_PLACEHOLDER);
    }
  }
  return parts.join('\n');
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}

function assistantText(content: unknown): string {
  if (!Array.isArray(content)) return textFromContent(content);
  const parts: string[] = [];
  for (const block of content as PiContentBlock[]) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      parts.push(block.thinking);
    } else if (block.type === 'toolCall') {
      const name = typeof block.name === 'string' ? block.name : 'tool';
      parts.push(`${name}(${safeJsonStringify(block.arguments)})`);
    }
  }
  return parts.join('\n');
}

/**
 * Map normalized pi-ai messages to an alternating user/assistant text
 * transcript. Consecutive same-role messages are merged; if the transcript
 * would start with `assistant`, a synthetic leading user turn is prepended
 * (The endpoint requires the first message to be `user`).
 */
function flattenToAlternatingText(messages: ReturnType<typeof convertToLlm>): CountTokensMessage[] {
  const out: CountTokensMessage[] = [];
  for (const m of messages) {
    let role: 'user' | 'assistant';
    let text: string;
    if (m.role === 'assistant') {
      role = 'assistant';
      text = assistantText(m.content);
    } else if (m.role === 'toolResult') {
      role = 'user';
      const label = `[tool_result ${m.toolName}]`;
      const body = textFromContent(m.content);
      text = body ? `${label}\n${body}` : label;
    } else {
      role = 'user';
      text = textFromContent(m.content);
    }
    if (!text) text = EMPTY_TEXT_PLACEHOLDER;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content[0]!.text += `\n${text}`;
    } else {
      out.push({ role, content: [{ type: 'text', text }] });
    }
  }
  if (out[0]?.role === 'assistant') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '(context)' }] });
  }
  return out;
}

/**
 * Build a count_tokens request body from the active transcript and the
 * SessionController-composed system prompt.
 */
export function buildCountTokensRequestBody(
  messages: AgentMessage[],
  systemPrompt: string | undefined,
  model: Model<Api>,
  tools?: Tool[],
): CountTokensRequestBody {
  const llm = convertToLlm(messages);
  const turns = flattenToAlternatingText(llm);
  // 归一化而不是过滤：真实 LLM 请求会带上所有已注册工具，哪怕 description
  // 为空、schema 缺失；在这里悄悄丢掉这类工具会系统性低估 payload。所以只
  // 剔除连 name 都没有的非法项，缺失字段补上合法默认值。
  const countTools = tools
    ?.filter((tool) => tool.name)
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.parameters ?? { type: 'object', properties: {} },
    }));
  return {
    model: model.id,
    max_tokens: model.maxTokens > 0 ? model.maxTokens : 1,
    stream: false,
    temperature: COUNT_TOKENS_TEMPERATURE,
    messages: turns,
    ...(systemPrompt?.trim() ? { system: [{ type: 'text', text: systemPrompt }] } : {}),
    ...(countTools && countTools.length > 0 ? { tools: countTools } : {}),
  };
}

/**
 * CJK / fullwidth ranges that consume roughly one BPE token per character.
 * Expressed as \u code-point escapes to avoid source-encoding ambiguity.
 * Covers: CJK symbols & punctuation, Hiragana/Katakana, CJK Ext-A, CJK
 * Unified Ideographs, CJK Compatibility Ideographs, halfwidth/fullwidth forms,
 * Hangul syllables, and CJK Ext-B+ (astral).
 */
const CJK_RE =
  /[\u{3000}-\u{303F}\u{3040}-\u{30FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}\u{FF00}-\u{FFEF}\u{AC00}-\u{D7AF}\u{20000}-\u{2FA1F}]/u;

/**
 * CJK-aware char→token estimate. CJK / fullwidth code points consume roughly
 * one token each; other (mostly ASCII) text averages ~4 chars per token. This
 * is the fallback when the remote endpoint times out or fails — far closer to
 * truth for Chinese than the legacy `chars/4` which under-counts CJK 4-8x.
 */
export function estimateCharsToTokensCjkAware(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/**
 * Fallback total-token estimate from the same body the remote call would send,
 * so the trigger sees a consistent shape whether or not the network succeeded.
 */
export function cjkFallbackTokens(
  messages: AgentMessage[],
  systemPrompt: string | undefined,
  model: Model<Api>,
  tools?: Tool[],
): number {
  return cjkFallbackTokensForBody(
    buildCountTokensRequestBody(messages, systemPrompt, model, tools),
  );
}

/**
 * {@link cjkFallbackTokens} 的 body 版变体：调用方（如 local-runtime 的
 * `HttpRemoteTokenCounter`）为发远程请求已经构建过一次 count_tokens body，
 * 远程失败走 fallback 时直接复用该 body 估算，避免把全量转录再
 * convert + flatten 一遍。两条路径基于同一个 body，保证 trigger 看到的
 * 形状与远程计数一致。
 */
export function cjkFallbackTokensForBody(body: CountTokensRequestBody): number {
  let total = body.system ? estimateCharsToTokensCjkAware(body.system[0]!.text) : 0;
  for (const m of body.messages) {
    total += FALLBACK_MESSAGE_OVERHEAD + estimateCharsToTokensCjkAware(m.content[0]!.text);
  }
  // 工具声明同样计入 fallback 估算，与远程端点看到的 body 保持同一口径。
  for (const tool of body.tools ?? []) {
    total +=
      FALLBACK_MESSAGE_OVERHEAD +
      estimateCharsToTokensCjkAware(tool.name) +
      estimateCharsToTokensCjkAware(tool.description) +
      estimateCharsToTokensCjkAware(safeJsonStringify(tool.input_schema));
  }
  return total;
}
