import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { convertResponsesMessages } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, Model, TextContent } from '@earendil-works/pi-ai';
import { convertMessages } from '@earendil-works/pi-ai/openai-completions';

import { createDefaultTokenEstimator } from './token-estimator.js';
import { countMessagesWithVisualPricing } from './visual-token-pricing.js';

/**
 * Estimate replay text after the caller's model projection, never generation usage.
 * This is a local estimate, not exact provider billing: opaque reasoning occupancy
 * cannot be inferred from ciphertext length. Signatures, IDs and encrypted payloads
 * are deliberately excluded; images retain the shared dimension-based pricing.
 */
export function countProjectedReplayMessages(
  messages: readonly AgentMessage[],
  model: Model<Api>,
): number {
  let total = 0;
  for (const message of messages) {
    total +=
      message.role === 'assistant'
        ? countAssistantReplay(message, model)
        : countMessagesWithVisualPricing([message], model);
  }
  return total;
}

function countAssistantReplay(message: AssistantMessage, model: Model<Api>): number {
  const estimator = createDefaultTokenEstimator();
  const content: TextContent[] = [];
  const addText = (text: string): void => {
    content.push({ type: 'text', text });
  };
  let retained = false;
  try {
    if (model.api === 'openai-completions') {
      const items = convertMessages(model as Model<'openai-completions'>, { messages: [message] });
      for (const item of items) {
        // transformMessages may synthesize tool results; the caller counts real results.
        if (item.role !== 'assistant') continue;
        retained = true;
        if (typeof item.content === 'string') addText(item.content);
        else if (Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === 'text') addText(part.text);
          }
        }
        for (const call of item.tool_calls ?? []) {
          if (call.type !== 'function') continue;
          addText(call.function.name);
          addText(call.function.arguments);
        }
        // The converter emits thinking under a dynamic signature key (including
        // provider aliases). Read its string value once, excluding standard fields
        // already counted above and metadata; never serialize reasoning_details.
        for (const [key, value] of Object.entries(item)) {
          if (key === 'role' || key === 'content' || key === 'name' || key === 'refusal') continue;
          if (typeof value === 'string') addText(value);
        }
      }
    } else if (
      model.api === 'openai-responses' ||
      model.api === 'openai-codex-responses' ||
      model.api === 'azure-openai-responses'
    ) {
      // This set only controls tool ID normalization; IDs do not enter the estimate.
      const items = convertResponsesMessages(
        model,
        { messages: [message] },
        new Set([model.provider]),
      );
      for (const item of items) {
        if (item.type === 'function_call') {
          retained = true;
          addText(item.name);
          addText(item.arguments);
        } else if (item.type === 'reasoning') {
          retained = true;
          for (const summary of item.summary ?? []) {
            if (summary.type === 'summary_text') addText(summary.text);
          }
          for (const part of item.content ?? []) {
            if (part.type === 'reasoning_text') addText(part.text);
          }
        } else if ('role' in item && item.role === 'assistant') {
          retained = true;
          if (typeof item.content === 'string') addText(item.content);
          else if (Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part.type === 'output_text' || part.type === 'input_text') addText(part.text);
            }
          }
        }
      }
    } else {
      return countLocalAssistant(message);
    }
    // Reuse the estimator's per-assistant structure cost, even for an opaque-only
    // retained reasoning item, but charge nothing when conversion drops the turn.
    return retained ? estimator.estimateMessage({ ...message, content }) : 0;
  } catch {
    // Malformed persisted signatures / arguments must not make estimation block a send.
    return countLocalAssistant(message);
  }
}

function countLocalAssistant(message: AssistantMessage): number {
  const content = message.content.flatMap((block): AssistantMessage['content'] => {
    if (block.type === 'thinking') {
      if (block.redacted) {
        return block.thinkingSignature ? [{ ...block, thinking: '' }] : [];
      }
      return block.thinking.trim() ? [block] : [];
    }
    return block.type === 'text' && !block.text ? [] : [block];
  });
  return content.length > 0
    ? createDefaultTokenEstimator().estimateMessage({ ...message, content })
    : 0;
}
