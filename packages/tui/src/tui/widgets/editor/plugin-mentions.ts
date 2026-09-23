import {
  parsePluginMentions,
  serializePluginMention,
  type PluginMention,
} from '@mavis/shared/plugin-mention';

export type EditorPluginMention = PluginMention;

/** Decode durable history links into visible labels with exact identity bindings. */
export function decodePluginMentions(text: string): {
  text: string;
  mentions: EditorPluginMention[];
} {
  const mentions: EditorPluginMention[] = [];
  let offset = 0;
  let previousEnd = 0;
  let output = '';
  for (const mention of parsePluginMentions(text)) {
    output += text.slice(previousEnd, mention.start) + mention.label;
    const start = mention.start + offset;
    mentions.push({ ...mention, start, end: start + mention.label.length });
    offset += mention.label.length - (mention.end - mention.start);
    previousEnd = mention.end;
  }
  return { text: output + text.slice(previousEnd), mentions };
}

export function encodePluginMentions(
  text: string,
  mentions: readonly EditorPluginMention[],
): string {
  let output = text;
  for (const mention of [...mentions].sort((a, b) => b.start - a.start)) {
    if (text.slice(mention.start, mention.end) !== mention.label) continue;
    output =
      output.slice(0, mention.start) +
      serializePluginMention(mention.pluginId, mention.label) +
      output.slice(mention.end);
  }
  return output;
}

export function validPluginMentions(
  text: string,
  value: unknown,
): value is readonly EditorPluginMention[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const ranges: Array<{ start: number; end: number }> = [];
  return value.every((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.pluginId !== 'string' ||
      !item.pluginId ||
      item.pluginId.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(item.pluginId) ||
      typeof item.label !== 'string' ||
      !item.label.startsWith('@') ||
      item.label.length > 257 ||
      !Number.isInteger(item.start) ||
      !Number.isInteger(item.end) ||
      item.start < 0 ||
      item.end <= item.start ||
      item.end > text.length ||
      text.slice(item.start, item.end) !== item.label ||
      ranges.some((range) => item.start < range.end && item.end > range.start)
    )
      return false;
    ranges.push(item);
    return true;
  });
}

/** Edits inside a mention remove its binding; edits outside only move its range. */
export function transformPluginMentions(
  previous: string,
  next: string,
  mentions: readonly EditorPluginMention[],
): EditorPluginMention[] {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let oldEnd = previous.length;
  let newEnd = next.length;
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return mentions.flatMap((mention) => {
    if (mention.end <= start) return [{ ...mention }];
    if (mention.start < oldEnd) return [];
    const delta = newEnd - oldEnd;
    return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
  });
}
