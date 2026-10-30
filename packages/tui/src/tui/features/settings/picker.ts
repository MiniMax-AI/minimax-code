import { getKeybindings, type TuiMode } from '../../engine/public.js';
import type { Component } from '../../rendering/component.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import {
  questionnaireFrameContentWidth,
  renderQuestionnaireFrame,
} from '../interaction/decision-frame.js';

const TUI_MODES = ['regular', 'fullscreen'] as const satisfies readonly TuiMode[];

const TUI_MODE_DESCRIPTIONS: Record<TuiMode, string> = {
  regular: 'Uses terminal scrollback, selection, and copy.',
  fullscreen: 'Keeps MCode in a fixed viewport with in-app scrolling.',
};

/** What a switch shows after a read or write. */
export interface TuiSettingsSwitchState {
  readonly enabled: boolean;
  /** Extra line under the row, for example where a change applies. */
  readonly note?: string;
}

/**
 * An on/off preference shown in /settings. Its value lives in the Runtime, so
 * reads and writes are async; resolving undefined means this host has none.
 */
export interface TuiSettingsSwitch {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Short tag after the label, such as `Beta`. */
  readonly tag?: string;
  read(): Promise<TuiSettingsSwitchState | undefined>;
  write(enabled: boolean): Promise<TuiSettingsSwitchState | undefined>;
  /** One-line failure text for a rejected read or write. */
  describeFailure(action: 'read' | 'write'): string;
}

type SwitchView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly state: TuiSettingsSwitchState }
  | { readonly kind: 'saving'; readonly state: TuiSettingsSwitchState }
  | { readonly kind: 'failed'; readonly message: string; readonly state?: TuiSettingsSwitchState };

type SettingsRow =
  | { readonly kind: 'mode'; readonly mode: TuiMode }
  | { readonly kind: 'switch'; readonly item: TuiSettingsSwitch };

export class TuiSettingsPicker implements Component {
  private selectedIndex: number;
  private readonly switches: readonly TuiSettingsSwitch[];
  private readonly views = new Map<string, SwitchView>();
  private readonly hidden = new Set<string>();
  private readonly onChanged: () => void;
  private readonly onClosedFailure: ((message: string) => void) | undefined;
  private closed = false;

  constructor(
    private currentMode: TuiMode,
    private readonly onTuiModeChange: (mode: TuiMode) => boolean,
    private readonly onClose: () => void,
    options: {
      readonly switches?: readonly TuiSettingsSwitch[];
      /** Called when an async read or write changed what the picker shows. */
      readonly onChanged?: () => void;
      /** Reports a write that failed after the picker closed, where no row can show it. */
      readonly onClosedFailure?: (message: string) => void;
    } = {},
  ) {
    this.selectedIndex = TUI_MODES.indexOf(currentMode);
    this.switches = options.switches ?? [];
    this.onChanged = options.onChanged ?? (() => undefined);
    this.onClosedFailure = options.onClosedFailure;
    for (const item of this.switches) {
      this.views.set(item.id, { kind: 'loading' });
      void this.load(item);
    }
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    const rows = this.rows();
    if (keybindings.matches(data, 'tui.select.up')) {
      this.selectedIndex = this.selectedIndex === 0 ? rows.length - 1 : this.selectedIndex - 1;
      return;
    }
    if (keybindings.matches(data, 'tui.select.down')) {
      this.selectedIndex = (this.selectedIndex + 1) % rows.length;
      return;
    }
    if (keybindings.matches(data, 'tui.select.confirm') || data === ' ') {
      const row = rows[this.selectedIndex];
      if (row?.kind === 'switch') {
        void this.toggle(row.item);
        return;
      }
      if (data === ' ') return;
      this.applyMode(row?.mode);
      return;
    }
    if (keybindings.matches(data, 'tui.select.cancel')) this.close();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [];
    const contentWidth = questionnaireFrameContentWidth(safeWidth);
    const compact = contentWidth < 56;
    const currentMode = formatTuiMode(this.currentMode);
    const rows = this.rows();
    const switchRows = rows.flatMap((row, index) =>
      row.kind === 'switch'
        ? renderSwitch(row.item, this.views.get(row.item.id) ?? { kind: 'loading' }, {
            focused: index === this.selectedIndex,
            width: contentWidth,
          })
        : [],
    );
    return renderQuestionnaireFrame(
      {
        title: safeWidth < 42 ? `Settings · ${currentMode}` : 'Settings',
        ...(safeWidth >= 42 ? { meta: `TUI mode · ${currentMode}` } : {}),
        body: [
          chalk.hex(colors.muted)(
            compact
              ? 'Choose how MCode fills this terminal.'
              : 'Choose how MCode uses this terminal.',
          ),
          '',
          ...rows.flatMap((row, index) =>
            row.kind === 'mode'
              ? renderMode(row.mode, {
                  active: row.mode === this.currentMode,
                  focused: index === this.selectedIndex,
                  compact,
                  width: contentWidth,
                })
              : [],
          ),
          ...(switchRows.length > 0
            ? ['', chalk.hex(colors.muted)('Preferences'), ...switchRows]
            : []),
        ],
        footer: footerText(safeWidth, switchRows.length > 0),
      },
      safeWidth,
      'signal',
    );
  }

  private rows(): SettingsRow[] {
    return [
      ...TUI_MODES.map((mode) => ({ kind: 'mode' as const, mode })),
      ...this.switches
        .filter((item) => !this.hidden.has(item.id))
        .map((item) => ({ kind: 'switch' as const, item })),
    ];
  }

  private applyMode(selectedMode: TuiMode | undefined): void {
    if (!selectedMode || selectedMode === this.currentMode) {
      this.close();
      return;
    }
    if (this.onTuiModeChange(selectedMode)) {
      this.currentMode = selectedMode;
      this.close();
    } else {
      this.selectedIndex = TUI_MODES.indexOf(this.currentMode);
    }
  }

  private close(): void {
    this.closed = true;
    this.onClose();
  }

  private async load(item: TuiSettingsSwitch): Promise<void> {
    let view: SwitchView | undefined;
    try {
      const state = await item.read();
      view = state ? { kind: 'ready', state } : undefined;
    } catch {
      view = { kind: 'failed', message: item.describeFailure('read') };
    }
    if (!view) {
      this.hide(item.id);
    } else {
      this.views.set(item.id, view);
    }
    this.notify();
  }

  private async toggle(item: TuiSettingsSwitch): Promise<void> {
    const view = this.views.get(item.id);
    // A switch whose value is unknown or being saved cannot be flipped safely.
    if (!view || view.kind === 'loading' || view.kind === 'saving' || !view.state) {
      if (view?.kind === 'failed' && !view.state) {
        this.views.set(item.id, { kind: 'loading' });
        this.notify();
        await this.load(item);
      }
      return;
    }
    const previous = view.state;
    this.views.set(item.id, { kind: 'saving', state: previous });
    this.notify();
    let next: SwitchView | undefined;
    try {
      const state = await item.write(!previous.enabled);
      next = state ? { kind: 'ready', state } : undefined;
    } catch {
      next = { kind: 'failed', message: item.describeFailure('write'), state: previous };
      if (this.closed) this.onClosedFailure?.(`${item.label}: ${next.message}`);
    }
    if (!next) {
      this.hide(item.id);
    } else {
      this.views.set(item.id, next);
    }
    this.notify();
  }

  private hide(id: string): void {
    const selected = rowKey(this.rows()[this.selectedIndex]);
    this.hidden.add(id);
    const remaining = this.rows();
    // rows() builds fresh objects, so the focused row is found again by identity key.
    const kept = selected ? remaining.findIndex((row) => rowKey(row) === selected) : -1;
    this.selectedIndex =
      kept >= 0 ? kept : Math.min(this.selectedIndex, Math.max(0, remaining.length - 1));
  }

  private notify(): void {
    if (!this.closed) this.onChanged();
  }
}

function rowKey(row: SettingsRow | undefined): string | undefined {
  if (!row) return undefined;
  return row.kind === 'mode' ? `mode:${row.mode}` : `switch:${row.item.id}`;
}

function footerText(width: number, hasSwitches: boolean): string {
  if (width < 42) return '↑/↓ move · Enter · Esc close';
  return hasSwitches
    ? '↑/↓ select · Enter apply or switch · Esc close'
    : '↑/↓ select · Enter apply · Esc cancel';
}

function renderMode(
  mode: TuiMode,
  options: {
    readonly active: boolean;
    readonly focused: boolean;
    readonly compact: boolean;
    readonly width: number;
  },
): string[] {
  const prefix = options.focused ? chalk.bold.hex(colors.signal)('›') : ' ';
  const label = (options.focused ? chalk.bold.hex(colors.signal) : chalk.hex(colors.text))(
    formatTuiMode(mode).padEnd(10),
  );
  const status = options.active ? chalk.hex(colors.signal)('● current') : '';
  const description = chalk.hex(colors.muted)(TUI_MODE_DESCRIPTIONS[mode]);
  const heading = `${prefix} ${label}`;

  if (options.compact) {
    return [
      fitWithRightMeta(heading, status, options.width),
      truncateToWidth(`  ${description}`, options.width, ''),
    ];
  }
  return [fitWithRightMeta(`${heading}  ${description}`, status, options.width)];
}

function renderSwitch(
  item: TuiSettingsSwitch,
  view: SwitchView,
  options: { readonly focused: boolean; readonly width: number },
): string[] {
  const prefix = options.focused ? chalk.bold.hex(colors.signal)('›') : ' ';
  const labelText = item.tag ? `${item.label} (${item.tag})` : item.label;
  const label = (options.focused ? chalk.bold.hex(colors.signal) : chalk.hex(colors.text))(
    labelText,
  );
  const state = 'state' in view ? view.state : undefined;
  const value =
    view.kind === 'loading'
      ? chalk.hex(colors.muted)('…')
      : view.kind === 'saving'
        ? chalk.hex(colors.muted)('saving…')
        : state
          ? state.enabled
            ? chalk.hex(colors.signal)('● on')
            : chalk.hex(colors.muted)('○ off')
          : chalk.hex(colors.error)('unavailable');
  const lines = [fitWithRightMeta(`${prefix} ${label}`, value, options.width)];
  const indent = '    ';
  if (view.kind === 'failed') {
    lines.push(
      truncateToWidth(`${indent}${chalk.hex(colors.error)(view.message)}`, options.width, '…'),
    );
  }
  // The description explains the focused row; a note (where a change applies) always shows.
  const detail = [
    ...(options.focused ? [item.description] : []),
    ...(state?.note ? [state.note] : []),
  ];
  for (const text of detail) {
    lines.push(truncateToWidth(`${indent}${chalk.hex(colors.muted)(text)}`, options.width, '…'));
  }
  return lines;
}

function formatTuiMode(mode: TuiMode): string {
  return mode === 'regular' ? 'Regular' : 'Fullscreen';
}

function fitWithRightMeta(content: string, meta: string, width: number): string {
  if (!meta) return truncateToWidth(content, width, '');
  const gap = width - visibleWidth(content) - visibleWidth(meta);
  if (gap >= 2) return `${content}${' '.repeat(gap)}${meta}`;
  const contentWidth = Math.max(0, width - visibleWidth(meta) - 2);
  return `${truncateToWidth(content, contentWidth, '')}  ${meta}`;
}
