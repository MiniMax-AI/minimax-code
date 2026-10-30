import type { McodePluginView } from '../../../plugin/contract.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';
import { Input, matchesKey, VStack } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import type { TuiFeatureScreen } from '../../shell/surface-host.js';
import {
  renderTuiActionHint,
  tuiChalk as chalk,
  tuiColors as colors,
} from '../../theme/runtime.js';
import { TuiSelectionScrollView } from '../../widgets/selection-scroll-view.js';

type PluginTab = 'all' | 'installed' | 'official' | 'local';
const TABS: readonly PluginTab[] = ['all', 'installed', 'official', 'local'];

export interface TuiPluginManagerOptions {
  readonly plugins: readonly McodePluginView[];
  readonly initialQuery?: string;
  readonly onInstall: (plugin: McodePluginView) => Promise<McodePluginView>;
  readonly onRemove: (plugin: McodePluginView) => Promise<McodePluginView>;
  readonly onSetEnabled: (plugin: McodePluginView, enabled: boolean) => Promise<McodePluginView>;
  readonly onRefresh: () => Promise<readonly McodePluginView[]>;
  readonly onCancel: () => void;
  readonly requestRender: () => void;
}

export class TuiPluginManager implements TuiFeatureScreen, Component, Focusable {
  readonly id = 'plugins';
  readonly layoutRoot: Component;
  focused = false;
  private plugins: McodePluginView[];
  private tab: PluginTab = 'all';
  private readonly searchInput = new Input({ prompt: '' });
  private readonly bodyViewport: TuiSelectionScrollView;
  private selectedIndex = 0;
  private busy = false;
  private status = '';
  private disposed = false;

  constructor(private readonly options: TuiPluginManagerOptions) {
    this.plugins = [...options.plugins];
    this.searchInput.setValue(options.initialQuery?.trim() ?? '');
    this.searchInput.moveCursorToEnd();
    const header: Component = {
      render: (width) => this.renderHeader(width),
      invalidate: () => undefined,
    };
    const body: Component = {
      render: (width) => this.renderBody(width),
      invalidate: () => undefined,
    };
    const footer: Component = {
      render: (width) => this.renderFooter(width),
      invalidate: () => undefined,
    };
    this.bodyViewport = new TuiSelectionScrollView(body, {
      primary: true,
      overscroll: 'contain',
    });
    this.bodyViewport.setActiveRow(0, true);
    this.layoutRoot = new VStack([
      { component: header, basis: 'auto', shrink: 1, minSize: 1 },
      { component: this.bodyViewport, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: footer, basis: 'auto', shrink: 1, minSize: 1 },
    ]);
  }

  handleInput(data: string): void {
    if (this.busy || this.disposed) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      if (this.searchInput.getValue()) {
        this.searchInput.setValue('');
        this.resetSelection();
        this.requestRender();
      } else this.options.onCancel();
      return;
    }
    if (matchesKey(data, 'tab')) {
      this.cycleTab(1);
      return;
    }
    if (matchesKey(data, 'shift+tab')) {
      this.cycleTab(-1);
      return;
    }
    if (matchesKey(data, 'up')) return this.move(-1);
    if (matchesKey(data, 'down')) return this.move(1);
    if (matchesKey(data, 'enter')) {
      const plugin = this.selected();
      if (plugin && !plugin.installed)
        void this.mutate(plugin, () => this.options.onInstall(plugin));
      return;
    }
    if (matchesKey(data, 'space')) {
      const plugin = this.selected();
      if (plugin?.installed) {
        void this.mutate(plugin, () => this.options.onSetEnabled(plugin, !plugin.enabled));
      }
      return;
    }
    if (
      this.searchInput.getValue().length === 0 &&
      (matchesKey(data, 'delete') || matchesKey(data, 'ctrl+d'))
    ) {
      const plugin = this.selected();
      if (plugin?.installed) void this.mutate(plugin, () => this.options.onRemove(plugin));
      return;
    }
    if (matchesKey(data, 'ctrl+r')) {
      void this.refresh();
      return;
    }
    const previousQuery = this.searchInput.getValue();
    this.searchInput.handleInput(matchesKey(data, 'shift+space') ? ' ' : data);
    if (this.searchInput.getValue() === previousQuery) return;
    this.resetSelection();
    this.requestRender();
  }

  dispose(): void {
    this.disposed = true;
  }

  invalidate(): void {
    this.layoutRoot.invalidate();
  }

  render(width: number): string[] {
    return [...this.renderHeader(width), ...this.renderBody(width), ...this.renderFooter(width)];
  }

  private renderHeader(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (!safeWidth) return [];
    const installedCount = this.plugins.filter((plugin) => plugin.installed).length;
    this.searchInput.focused = this.focused;
    const searchPrompt = chalk.hex(colors.muted)('Search: ');
    const searchWidth = Math.max(0, safeWidth - visibleWidth(searchPrompt));
    const searchLine = `${searchPrompt}${this.searchInput.render(searchWidth)[0] ?? ''}`;
    return [
      chalk.bold.hex(colors.signal)('Plugins'),
      chalk.hex(colors.muted)(
        `Browse MiniMax Official and Local plugins · Installed ${installedCount} of ${this.plugins.length}`,
      ),
      renderTabs(this.tab, installedCount),
      searchLine,
      chalk.hex(colors.line)('─'.repeat(safeWidth)),
    ].map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private renderBody(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (!safeWidth) return [];
    const rows = this.visiblePlugins();
    this.selectedIndex = rows.length ? Math.min(this.selectedIndex, rows.length - 1) : 0;
    this.bodyViewport.setActiveRow(this.selectedIndex);
    if (rows.length === 0) return [chalk.hex(colors.muted)('No matching plugins')];
    return rows.map((plugin, index) =>
      truncateToWidth(
        renderPluginRow(plugin, index === this.selectedIndex, safeWidth),
        safeWidth,
        '…',
      ),
    );
  }

  private renderFooter(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (!safeWidth) return [];
    return [
      this.status
        ? chalk.hex(colors.accent)(this.status)
        : renderTuiActionHint(
            'Enter install · Space enable/disable · Delete remove · Ctrl+R refresh',
          ),
      renderTuiActionHint(
        '↑↓ select · PgUp/PgDn scroll · Tab source · ←→ edit search · Esc clear/close',
      ),
    ].map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private visiblePlugins(): McodePluginView[] {
    const query = this.searchInput.getValue().trim().toLocaleLowerCase();
    return this.plugins.filter((plugin) => {
      const inTab =
        this.tab === 'all' ||
        (this.tab === 'installed' ? plugin.installed : plugin.marketplace === this.tab);
      if (!inTab) return false;
      if (!query) return true;
      return [plugin.name, plugin.displayName, plugin.description, plugin.author]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(query));
    });
  }

  private selected(): McodePluginView | undefined {
    return this.visiblePlugins()[this.selectedIndex];
  }

  private move(delta: number): void {
    const count = this.visiblePlugins().length;
    this.selectedIndex = count ? Math.max(0, Math.min(count - 1, this.selectedIndex + delta)) : 0;
    this.bodyViewport.setActiveRow(this.selectedIndex, true);
    this.status = '';
    this.requestRender();
  }

  private cycleTab(delta: number): void {
    const current = TABS.indexOf(this.tab);
    this.tab = TABS[(current + delta + TABS.length) % TABS.length] ?? 'all';
    this.resetSelection();
    this.requestRender();
  }

  private resetSelection(): void {
    this.selectedIndex = 0;
    this.bodyViewport.setActiveRow(0, true);
    this.status = '';
  }

  private async mutate(
    plugin: McodePluginView,
    operation: () => Promise<McodePluginView>,
  ): Promise<void> {
    this.busy = true;
    this.status = `Updating ${plugin.displayName}…`;
    this.requestRender();
    try {
      const next = await operation();
      if (this.disposed) return;
      this.plugins = this.plugins.map((candidate) =>
        candidate.pluginId === next.pluginId ? next : candidate,
      );
      this.status = `${next.displayName}: ${next.installed ? (next.enabled ? 'enabled' : 'disabled') : 'removed'}`;
    } catch (error) {
      if (this.disposed) return;
      this.status = formatTuiActionFailure(error, {
        summary: `Couldn't update ${plugin.displayName}.`,
        nextStep: isPluginAuthRequired(error)
          ? 'Run /login, then retry.'
          : 'Retry or run mcode plugin for details.',
      });
    } finally {
      if (!this.disposed) {
        this.busy = false;
        this.requestRender();
      }
    }
  }

  private async refresh(): Promise<void> {
    this.busy = true;
    this.status = 'Refreshing Plugin catalogs…';
    this.requestRender();
    try {
      const plugins = await this.options.onRefresh();
      if (this.disposed) return;
      this.plugins = [...plugins];
      this.resetSelection();
      this.status = 'Plugin catalogs refreshed.';
    } catch (error) {
      if (this.disposed) return;
      this.status = formatTuiActionFailure(error, {
        summary: "Couldn't refresh Plugins.",
        nextStep: 'Retry or run mcode plugin marketplace upgrade.',
      });
    } finally {
      if (!this.disposed) {
        this.busy = false;
        this.requestRender();
      }
    }
  }

  private requestRender(): void {
    if (!this.disposed) this.options.requestRender();
  }
}

function isPluginAuthRequired(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? error.code : undefined;
  return code === 'PLUGIN_AUTH_REQUIRED';
}

function renderTabs(tab: PluginTab, installedCount: number): string {
  const entries: ReadonlyArray<readonly [PluginTab, string]> = [
    ['all', 'All Plugins'],
    ['installed', `Installed (${installedCount})`],
    ['official', 'MiniMax Official'],
    ['local', 'Local'],
  ];
  return entries
    .map(([id, label]) =>
      id === tab ? chalk.bold.hex(colors.signal)(`[${label}]`) : chalk.hex(colors.muted)(label),
    )
    .join('  ');
}

function renderPluginRow(plugin: McodePluginView, selected: boolean, width: number): string {
  const marker = plugin.enabled ? '[*]' : plugin.installed ? '[-]' : '[ ]';
  const state = plugin.installed ? (plugin.enabled ? 'Enabled' : 'Disabled') : 'Available';
  const left = `${selected ? '›' : ' '} ${marker} ${sanitizeTerminalText(plugin.displayName)}`;
  const detail = `${state} · ${plugin.marketplace} · ${sanitizeTerminalText(plugin.description ?? capabilitySummary(plugin))}`;
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(detail));
  return `${selected ? chalk.bold.hex(colors.signal)(left) : chalk.hex(colors.text)(left)}${' '.repeat(gap)}${chalk.hex(colors.muted)(detail)}`;
}

function capabilitySummary(plugin: McodePluginView): string {
  const { appCount, mcpServerCount, skillCount, agentCount } = plugin.capabilities;
  const agents = agentCount ? ` · ${agentCount} subagents` : '';
  return `${appCount} apps · ${mcpServerCount} MCP · ${skillCount} skills${agents}`;
}
