/** Durable plugin identity shared by Composer history and Runtime selection. */
export function buildPluginId(name: string, source: 'official' | 'local'): string {
  return `${name.trim()}@${source}`;
}

export interface PluginMention {
  readonly pluginId: string;
  readonly label: string;
  readonly start: number;
  readonly end: number;
}

export function serializePluginMention(pluginId: string, label: string): string {
  const name = label
    .replace(/^@/u, '')
    .replace(/[\[\]\r\n\\]/gu, ' ')
    .slice(0, 256);
  return `[@${name}](plugin://${encodeURIComponent(pluginId)})`;
}

/** Linked references also work in exec and ACP text inputs. Display names never select identity. */
export function parsePluginMentions(text: string): PluginMention[] {
  const result: PluginMention[] = [];
  for (const match of text.matchAll(/\[@([^\]\r\n]{1,256})\]\(plugin:\/\/([^\s()]{1,768})\)/gu)) {
    let pluginId: string;
    try {
      pluginId = decodeURIComponent(match[2]!);
    } catch {
      continue;
    }
    if (!pluginId || pluginId.length > 512 || /[\u0000-\u001f\u007f]/u.test(pluginId)) continue;
    result.push({
      pluginId,
      label: `@${match[1]}`,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return result;
}
