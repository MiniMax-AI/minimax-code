import { decodePluginMentions } from '../../widgets/editor/plugin-mentions.js';
import { Input, matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import {
  renderTuiActionHint,
  tuiChalk as chalk,
  tuiColors as colors,
} from '../../theme/runtime.js';

export interface TuiHistorySearchPanelOptions {
  readonly entries: readonly string[];
  readonly initialQuery?: string;
  readonly onSelect: (entry: string) => void;
  readonly onCancel: () => void;
  readonly requestRender: () => void;
}

export class TuiHistorySearchPanel implements Component, Focusable {
  focused = false;
  private readonly searchInput = new Input({ prompt: '' });
  private selectedIndex = 0;

  constructor(private readonly options: TuiHistorySearchPanelOptions) {
    this.searchInput.setValue(options.initialQuery ?? '');
    this.searchInput.moveCursorToEnd();
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || matchesKey(data, 'ctrl+r')) {
      this.options.onCancel();
      return;
    }
    if (matchesKey(data, 'up')) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, 'down')) {
      this.move(1);
      return;
    }
    if (matchesKey(data, 'enter')) {
      const selected = this.matches()[this.selectedIndex];
      if (selected) this.options.onSelect(selected);
      return;
    }
    const previousQuery = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (this.searchInput.getValue() === previousQuery) return;
    this.selectedIndex = 0;
    this.options.requestRender();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const matches = this.matches();
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, matches.length - 1));
    this.searchInput.focused = this.focused;
    const title = chalk.bold.hex(colors.signal)('Search prompt history');
    const searchWidth = Math.max(1, safeWidth - visibleWidth(title) - 2);
    const search = this.searchInput.render(searchWidth)[0] ?? '';
    const visible = matches.slice(0, 6);
    const rows = visible.length
      ? visible.map((entry, index) => {
          const selected = index === this.selectedIndex;
          const prefix = selected ? chalk.bold.hex(colors.signal)('› ') : '  ';
          const value = selected
            ? chalk.bold.hex(colors.text)(sanitizeTerminalText(decodePluginMentions(entry).text))
            : chalk.hex(colors.muted)(sanitizeTerminalText(decodePluginMentions(entry).text));
          return fit(`${prefix}${value}`, safeWidth);
        })
      : [fit(chalk.hex(colors.muted)('  No matching prompts'), safeWidth)];
    return [
      fit(`${title}  ${search}`, safeWidth),
      ...rows,
      fit(renderTuiActionHint('↑↓ select · Enter restore · Esc keep draft'), safeWidth),
    ];
  }

  private matches(): string[] {
    const query = this.searchInput.getValue().trim().toLocaleLowerCase();
    if (!query) return [...this.options.entries];
    return this.options.entries.filter((entry) => decodePluginMentions(entry).text.toLocaleLowerCase().includes(query));
  }

  private move(direction: -1 | 1): void {
    const count = this.matches().length;
    if (count === 0) return;
    this.selectedIndex = (this.selectedIndex + direction + count) % count;
    this.options.requestRender();
  }
}

function fit(value: string, width: number): string {
  return truncateToWidth(value, width, chalk.hex(colors.dim)('…'));
}
