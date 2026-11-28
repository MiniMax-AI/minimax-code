import type { AssistantMessage } from '@earendil-works/pi-ai';

type AssistantContent = AssistantMessage['content'];

/**
 * Puts `text` in place of an assistant message's text, keeping every other
 * block where it was.
 *
 * The replacement takes the position of the first text block and the other
 * text blocks are dropped. Without text it goes in front of the first tool
 * call, or at the end when there is none. A message whose only text block
 * already holds `text` is returned as the same array.
 *
 * The order matters beyond display: the message is persisted and sent back as
 * is, and text placed after a tool call reaches the provider in that order.
 */
export function replaceAssistantText(content: AssistantContent, text: string): AssistantContent {
  const textBlocks = content.filter((block) => block.type === 'text');
  if (textBlocks.length === 1 && textBlocks[0]?.text === text) return content;

  const replacement = { type: 'text' as const, text };
  const firstText = content.findIndex((block) => block.type === 'text');
  if (firstText !== -1) {
    return content.flatMap((block, index): AssistantContent => {
      if (index === firstText) return [replacement];
      return block.type === 'text' ? [] : [block];
    });
  }
  const firstToolCall = content.findIndex((block) => block.type === 'toolCall');
  if (firstToolCall !== -1) {
    return [...content.slice(0, firstToolCall), replacement, ...content.slice(firstToolCall)];
  }
  return [...content, replacement];
}
