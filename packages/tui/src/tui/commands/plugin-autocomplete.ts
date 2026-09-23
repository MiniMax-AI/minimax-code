import type { McodePluginRuntimeAccess } from '../../plugin/contract.js';
import type { AutocompleteItem, AutocompleteProvider } from '../widgets/autocomplete.js';
import { truncateToWidth } from '../engine/public.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';

export interface PluginAutocompleteItem extends AutocompleteItem {
  readonly pluginId: string;
  readonly groupLabel: string;
}

/** Product-level plugin candidates share @ with files; plugin state stays in Runtime. */
export class TuiPluginAutocomplete implements AutocompleteProvider {
  readonly triggerCharacters = ['@'];

  constructor(
    private readonly base: AutocompleteProvider,
    private readonly plugins?: Partial<Pick<McodePluginRuntimeAccess, 'listInstalledPlugins'>>,
  ) {}

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ) {
    const before = (lines[cursorLine] ?? '').slice(0, cursorCol);
    const prefix = /(?:^|\s)(@[^\s"/]*)$/u.exec(before)?.[1];
    if (
      !prefix ||
      lines.join('\n').trimStart().startsWith('!') ||
      !this.plugins?.listInstalledPlugins
    ) {
      return this.base.getSuggestions(lines, cursorLine, cursorCol, options);
    }
    const [files, plugins] = await Promise.allSettled([
      this.base.getSuggestions(lines, cursorLine, cursorCol, options),
      this.plugins.listInstalledPlugins(),
    ]);
    if (options.signal.aborted) return null;
    const fileSuggestions = files.status === 'fulfilled' ? files.value : null;
    const query = prefix.slice(1).normalize('NFKC').toLocaleLowerCase();
    const items: PluginAutocompleteItem[] =
      plugins.status === 'fulfilled'
        ? plugins.value
            .filter(
              (plugin) =>
                plugin.installed &&
                plugin.enabled &&
                [plugin.name, plugin.displayName, plugin.pluginId].some((text) =>
                  text.normalize('NFKC').toLocaleLowerCase().includes(query),
                ),
            )
            .sort(
              (a, b) =>
                a.displayName.localeCompare(b.displayName) || a.pluginId.localeCompare(b.pluginId),
            )
            .map((plugin) => {
              const name =
                sanitizeTerminalText(plugin.displayName)
                  .replace(/[[\]\\]/gu, ' ')
                  .replace(/\s+/gu, ' ')
                  .trim()
                  .slice(0, 256) || plugin.name;
              return {
                value: `@${name}`,
                label: `@${name}`,
                pluginId: plugin.pluginId,
                groupLabel: '  Plugins',
                description: `${plugin.marketplace} · ${truncateToWidth(
                  sanitizeTerminalText(plugin.description ?? plugin.name)
                    .replace(/\s+/gu, ' ')
                    .trim(),
                  64,
                  '…',
                )}`,
              };
            })
        : [];
    const combined = [
      ...items,
      ...(fileSuggestions?.items ?? []).map((item) => ({
        ...item,
        ...(items.length > 0 ? { groupLabel: '  Files' } : {}),
      })),
    ];
    return combined.length ? { prefix, items: combined } : null;
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ) {
    if (!('pluginId' in item))
      return this.base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    const line = lines[cursorLine] ?? '';
    const start = cursorCol - prefix.length;
    const insertion = `${item.value} `;
    const next = [...lines];
    next[cursorLine] = line.slice(0, start) + insertion + line.slice(cursorCol);
    return { lines: next, cursorLine, cursorCol: start + insertion.length };
  }

  shouldAutoTriggerCompletion(lines: string[], cursorLine: number, cursorCol: number) {
    return this.base.shouldAutoTriggerCompletion?.(lines, cursorLine, cursorCol);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number) {
    return this.base.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
  }
}
