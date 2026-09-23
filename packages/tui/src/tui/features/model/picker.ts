import { panelLayout, renderPanelFrame } from '../../widgets/panel-frame.js';
import { getKeybindings, Input, Key, matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { visibleWidth } from '../../rendering/text.js';
import { SelectList } from '../../widgets/select-list.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import type { TuiModel } from '../../../runtime/port.js';
import type { McodeCodexOAuthState } from '../../../provider/contract.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';
import {
  tuiChalk as chalk,
  tuiColors as colors,
  tuiSelectListTheme as baseTheme,
} from '../../theme/runtime.js';
import {
  applyTuiThinkingChoice,
  resolveTuiThinkingChoice,
  type TuiThinkingChoice,
} from './thinking.js';
import {
  cycleTuiEffort,
  normalizeTuiEffortOptions,
  resolveTuiEffortChoice,
  supportsTuiEffort,
} from './effort.js';

import { contextWindowOptions, formatContextWindow } from './context-window.js';

const modelPickerTheme = {
  ...baseTheme,
  groupLabel: (text: string) => chalk.bold.hex(colors.text)(text),
  noMatch: () => chalk.hex(colors.dim)('  No matching models'),
};
const MODEL_CONTROL_ROWS = 3;

type ModelKey = string;
const CONNECT_CODEX_ITEM_VALUE = '\u0000connect-codex';
const ADD_PROVIDER_ITEM_VALUE = '\u0000add-provider';
/** Favorite rows repeat a provider row, so they need a distinct list value. */
const FAVORITE_ROW_PREFIX = '\u0000favorite\u0000';
const FAVORITE_UPDATE_FAILED = "Couldn't update favorites. Press ctrl+s to retry.";

interface ModelGroup {
  readonly label: string;
  readonly models: readonly TuiModel[];
}

export class TuiModelPicker implements Component, Focusable {
  readonly fullscreenViewport = true;
  readonly handlesViewportKeys = true;
  private list: SelectList;
  private focusedModelKey: ModelKey | undefined;
  private readonly selectedModelKey: ModelKey | undefined;
  private focusBeforeSearchKey: ModelKey | undefined;
  private readonly searchInput = new Input({ prompt: '' });
  private readonly thinkingDrafts = new Map<ModelKey, TuiThinkingChoice>();
  private readonly contextDrafts = new Map<ModelKey, number>();
  private readonly effortDrafts = new Map<ModelKey, string>();
  private readonly modelByKey = new Map<ModelKey, TuiModel>();
  /** Starred models in the order they were added; new favorites go last. */
  private favoriteKeys: ModelKey[];
  private favoriteStatus: string | undefined;
  private deletingProviderId: string | undefined;
  private deleteStatus: { readonly tone: 'info' | 'error'; readonly text: string } | undefined;
  private busy = false;
  private _focused = false;

  constructor(
    private readonly models: readonly TuiModel[],
    private readonly onSelectModel: (model: TuiModel, effort?: string) => void,
    private readonly onCancel: () => void,
    private readonly availability: {
      isUnavailable?: (model: TuiModel) => boolean;
      onUnavailable?: (model: TuiModel) => void;
      unavailableHint?: string;
      codexOAuth?: {
        readonly state: Exclude<McodeCodexOAuthState, 'hidden'>;
        readonly onConnect: () => void;
      };
      onAddProvider?: () => void;
      onDeleteProvider?: (providerId: string) => Promise<void>;
      /** Persists a favorite toggle; `false` or a rejection rolls the row back. */
      onToggleFavorite?: (model: TuiModel, favorite: boolean) => Promise<boolean | void> | boolean | void;
      requestRender?: () => void;
    } = {},
    /** Think effort already stored for the current Session, when known. */
    private readonly selectedEffort?: string,
    initialQuery = '',
  ) {
    this.favoriteKeys = models
      .filter((model) => model.favorite)
      .sort((a, b) => (a.favoriteOrder ?? Infinity) - (b.favoriteOrder ?? Infinity))
      .map(modelKey);
    const selectedModel = models.find((model) => model.selected);
    this.selectedModelKey = selectedModel ? modelKey(selectedModel) : undefined;
    this.focusBeforeSearchKey = this.selectedModelKey;
    this.searchInput.setValue(initialQuery.trim());
    this.searchInput.moveCursorToEnd();
    this.list = this.createList();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  handleInput(data: string): void {
    if (this.busy) return;
    const keybindings = getKeybindings();
    if (this.deletingProviderId) {
      if (keybindings.matches(data, 'tui.select.cancel')) this.cancelProviderDeletion();
      else if (keybindings.matches(data, 'tui.select.confirm')) void this.deleteProvider();
      return;
    }
    if (keybindings.matches(data, 'tui.select.cancel')) {
      this.onCancel();
      return;
    }

    const model = this.focusedModel();
    if (model && this.availability.onToggleFavorite && matchesKey(data, Key.ctrl('s'))) {
      this.toggleFavorite(model);
      return;
    }
    if (
      model &&
      isCustomProviderModel(model) &&
      this.availability.onDeleteProvider &&
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.deletingProviderId = model.providerId;
      this.deleteStatus = undefined;
      this.availability.requestRender?.();
      return;
    }
    if (
      model &&
      contextWindowOptions(model).length > 1 &&
      (matchesKey(data, 'tab') || matchesKey(data, Key.shift('tab')))
    ) {
      const options = contextWindowOptions(model);
      const index = options.indexOf(this.contextChoice(model) ?? 0);
      const direction = matchesKey(data, Key.shift('tab')) ? -1 : 1;
      const next = options[(index + direction + options.length) % options.length];
      if (next !== undefined) this.contextDrafts.set(modelKey(model), next);
      this.list = this.createList();
      return;
    }
    const query = this.searchInput.getValue();
    if (
      model &&
      query.trim().length === 0 &&
      (matchesKey(data, 'left') || matchesKey(data, 'right'))
    ) {
      if (supportsTuiEffort(model)) {
        this.moveEffort(model, matchesKey(data, 'left') ? -1 : 1);
        return;
      }
      if (model.thinkingConfig?.mode === 'switchable') {
        this.toggleThinking(model);
        return;
      }
    }

    if (
      keybindings.matches(data, 'tui.select.up') ||
      keybindings.matches(data, 'tui.select.down') ||
      keybindings.matches(data, 'tui.select.confirm')
    ) {
      this.list.handleInput(data);
      return;
    }

    const previousQuery = query;
    this.searchInput.handleInput(data);
    if (this.searchInput.getValue() !== previousQuery) {
      const nextQuery = this.searchInput.getValue();
      if (previousQuery.trim().length === 0 && nextQuery.trim().length > 0) {
        this.focusBeforeSearchKey = this.focusedModelKey ?? this.selectedModelKey;
      } else if (previousQuery.trim().length > 0 && nextQuery.trim().length === 0) {
        this.focusedModelKey = this.focusBeforeSearchKey ?? this.focusedModelKey;
        this.focusBeforeSearchKey = undefined;
      }
      this.list = this.createList();
    }
  }

  invalidate(): void {
    this.list.invalidate();
    this.searchInput.invalidate();
  }

  render(width: number): string[] {
    return this.renderViewport(width, 24);
  }

  renderViewport(width: number, height: number): string[] {
    if (this.deletingProviderId) return this.renderDeleteConfirmation(width, height);
    const layout = panelLayout(width, height, this.renderHint());
    const searchPrompt = chalk.hex(colors.muted)('Search: ');
    const search =
      this.searchInput.render(Math.max(1, layout.contentWidth - visibleWidth(searchPrompt)))[0] ??
      '';
    const header = [
      ...(layout.bodyHeight >= 10 ? [chalk.hex(colors.muted)('Available models')] : []),
      ...(layout.bodyHeight >= 3 && this.availability.unavailableHint
        ? [chalk.hex(colors.warning)(sanitizeTerminalText(this.availability.unavailableHint))]
        : []),
      ...(layout.bodyHeight >= 3 && this.favoriteStatus
        ? [chalk.hex(colors.warning)(this.favoriteStatus)]
        : []),
      ...(layout.bodyHeight >= 2 ? [`${searchPrompt}${search}`] : []),
      ...(layout.bodyHeight >= 4 &&
      this.visibleModels().length === 0 &&
      (this.availability.onAddProvider || this.availability.codexOAuth)
        ? [chalk.hex(colors.muted)('No matching models')]
        : []),
    ];
    const controls = this.renderModelControl().slice(
      0,
      Math.max(0, layout.bodyHeight - header.length - 1),
    );
    return layout.render({
      title: 'Models',
      body: [
        ...header,
        ...(this.visibleModels().length === 0 &&
        !this.availability.onAddProvider &&
        !this.availability.codexOAuth
          ? [chalk.hex(colors.muted)('No matching models')]
          : this.list.renderViewport(
              layout.contentWidth,
              Math.max(1, layout.bodyHeight - header.length - controls.length),
            )),
        ...controls,
      ],
    });
  }

  private focusedModel(): TuiModel | undefined {
    const item = this.list.getSelectedItem();
    return item ? this.modelByKey.get(rowModelKey(item.value)) : undefined;
  }

  private isFavorite(model: TuiModel): boolean {
    return this.favoriteKeys.includes(modelKey(model));
  }

  private toggleFavorite(model: TuiModel): void {
    const onToggle = this.availability.onToggleFavorite;
    if (!onToggle) return;
    const key = modelKey(model);
    const previousIndex = this.favoriteKeys.indexOf(key);
    const favorite = previousIndex < 0;
    this.favoriteKeys = favorite
      ? [...this.favoriteKeys, key]
      : this.favoriteKeys.filter((candidate) => candidate !== key);
    this.favoriteStatus = undefined;
    // Unstarring from the Favorites group keeps focus on the same model.
    if (!favorite && this.focusedModelKey === favoriteRowValue(key)) this.focusedModelKey = key;
    this.list = this.createList();
    this.availability.requestRender?.();

    const rollback = () => {
      const current = this.favoriteKeys.filter((candidate) => candidate !== key);
      if (!favorite) current.splice(Math.min(previousIndex, current.length), 0, key);
      this.favoriteKeys = current;
      this.favoriteStatus = FAVORITE_UPDATE_FAILED;
      this.list = this.createList();
      this.availability.requestRender?.();
    };
    let result: ReturnType<typeof onToggle>;
    try {
      result = onToggle(model, favorite);
    } catch {
      rollback();
      return;
    }
    void Promise.resolve(result).then(
      (saved) => {
        if (saved === false) rollback();
      },
      rollback,
    );
  }

  private contextChoice(model: TuiModel): number | undefined {
    return this.contextDrafts.get(modelKey(model)) ?? model.contextLimit;
  }

  private renderContextControl(): string[] {
    const model = this.focusedModel();
    if (!model) return [];
    const options = contextWindowOptions(model);
    if (options.length < 2) return [];
    const choice = this.contextChoice(model);
    const labels = options.map((value) =>
      value === choice
        ? chalk.bold.hex(colors.signal)(`[ ${formatContextWindow(value)} ]`)
        : chalk.hex(colors.text)(formatContextWindow(value)),
    );
    const higherUsage = model.contextWindowOptionHints?.[String(choice)] === 'higher_usage';
    return [
      `${chalk.hex(colors.muted)('Context')} ${labels.join('  ')} ${chalk.hex(colors.dim)('(Tab to switch)')}`,
      ...(higherUsage ? [chalk.hex(colors.warning)('Higher usage with this context window.')] : []),
    ];
  }

  private moveEffort(model: TuiModel, direction: -1 | 1): void {
    const next = cycleTuiEffort(model.effortOptions, this.effortChoice(model), direction);
    if (next) this.effortDrafts.set(modelKey(model), next);
  }

  private toggleThinking(model: TuiModel): void {
    const current = this.thinkingChoice(model) ?? 'off';
    this.thinkingDrafts.set(modelKey(model), current === 'on' ? 'off' : 'on');
  }

  private thinkingChoice(model: TuiModel): TuiThinkingChoice | undefined {
    return this.thinkingDrafts.get(modelKey(model)) ?? resolveTuiThinkingChoice(model);
  }

  private effortChoice(model: TuiModel): string | undefined {
    const draft = this.effortDrafts.get(modelKey(model));
    if (draft) return draft;
    const thinking = this.thinkingDrafts.get(modelKey(model));
    const candidate = thinking ? applyTuiThinkingChoice(model, thinking) : model;
    // Only the selected row carries saved effort; every other row
    // starts from the configured default.
    return resolveTuiEffortChoice(candidate, model.selected ? this.selectedEffort : undefined);
  }

  private createList(): SelectList {
    const visible = this.visibleModels();
    const groups = groupModels(visible);
    this.modelByKey.clear();
    for (const model of this.models) this.modelByKey.set(modelKey(model), model);

    const row = (model: TuiModel, value: string, groupLabel: string, star: boolean) => {
      const unavailable = Boolean(this.availability.isUnavailable?.(model));
      return {
        value,
        label: `${model.selected ? '● ' : ''}${star ? '★ ' : ''}${unavailable ? '[login] ' : ''}${sanitizeTerminalText(model.displayName ?? model.modelId)}`,
        description: formatModelDescription(
          { ...model, contextLimit: this.contextChoice(model) },
          unavailable,
        ),
        groupLabel,
      };
    };
    const visibleKeys = new Set(visible.map(modelKey));
    const favorites = this.favoriteKeys.flatMap((key) => {
      const model = visibleKeys.has(key) ? this.modelByKey.get(key) : undefined;
      return model ? [model] : [];
    });
    const items = [
      ...favorites.map((model) =>
        row(
          model,
          favoriteRowValue(modelKey(model)),
          `★ Favorites · ${favorites.length}`,
          false,
        ),
      ),
      ...groups.flatMap((group) =>
        group.models.map((model) =>
          row(
            model,
            modelKey(model),
            `${sanitizeTerminalText(group.label)} · ${group.models.length}`,
            this.isFavorite(model),
          ),
        ),
      ),
    ];
    items.push({
      value: ADD_PROVIDER_ITEM_VALUE,
      label: '+ Add 3rd-party provider…',
      description: 'Configure an API Key provider and add its models',
      groupLabel: 'Providers',
    });
    if (this.availability.codexOAuth) {
      items.push({
        value: CONNECT_CODEX_ITEM_VALUE,
        ...codexOAuthAction(this.availability.codexOAuth.state),
        groupLabel: 'Providers',
      });
    }

    const list = new SelectList(items, Math.min(Math.max(items.length, 1), 10), modelPickerTheme, {
      minPrimaryColumnWidth: 26,
      maxPrimaryColumnWidth: 42,
    });
    list.onSelectionChange = (item) => {
      this.focusedModelKey = item.value;
    };
    list.onSelect = (item) => {
      if (item.value === CONNECT_CODEX_ITEM_VALUE) {
        this.availability.codexOAuth?.onConnect();
        return;
      }
      if (item.value === ADD_PROVIDER_ITEM_VALUE) {
        this.availability.onAddProvider?.();
        return;
      }
      const model = this.modelByKey.get(rowModelKey(item.value));
      if (!model) return;
      if (this.availability.isUnavailable?.(model)) {
        this.availability.onUnavailable?.(model);
        return;
      }
      const effort = this.effortChoice(model);
      const choice =
        this.thinkingDrafts.get(modelKey(model)) ??
        (effort ? undefined : this.thinkingChoice(model));
      const contextLimit = this.contextDrafts.get(modelKey(model));
      const withContext = contextLimit === undefined ? model : { ...model, contextLimit };
      const applied = choice ? applyTuiThinkingChoice(withContext, choice) : withContext;
      // Models without effort levels keep the single-argument contract.
      if (effort) this.onSelectModel(applied, effort);
      else this.onSelectModel(applied);
    };
    list.onCancel = this.onCancel;

    // Explicit focus is tracked by row value. Otherwise use the model's first
    // row, so the selected favorite opens on its Favorites row at the top.
    const modelRows = items.filter((item) => this.modelByKey.has(rowModelKey(item.value)));
    const target = this.focusedModelKey ?? this.selectedModelKey;
    let preferredIndex = this.focusedModelKey
      ? modelRows.findIndex((item) => item.value === this.focusedModelKey)
      : -1;
    if (preferredIndex < 0 && target) {
      preferredIndex = modelRows.findIndex(
        (item) => rowModelKey(item.value) === rowModelKey(target),
      );
    }
    if (preferredIndex >= 0) {
      list.setSelectedIndex(preferredIndex);
      this.focusedModelKey = modelRows[preferredIndex]?.value;
    } else if (modelRows[0]) {
      this.focusedModelKey = modelRows[0].value;
    }
    return list;
  }

  private visibleModels(): TuiModel[] {
    const query = this.searchInput.getValue().trim().toLocaleLowerCase();
    if (!query) return [...this.models];
    return this.models.filter((model) => searchableModelText(model).includes(query));
  }

  private renderHint(): string {
    if (this.list.getSelectedItem()?.value === CONNECT_CODEX_ITEM_VALUE) {
      return '↑↓ select · type to search · enter connect Codex · esc cancel';
    }
    if (this.list.getSelectedItem()?.value === ADD_PROVIDER_ITEM_VALUE) {
      return '↑↓ select · type to search · enter add provider · esc cancel';
    }
    const model = this.focusedModel();
    const switchable = model?.thinkingConfig?.mode === 'switchable';
    const contextHint = model && contextWindowOptions(model).length > 1 ? ' · tab context' : '';
    const deleteHint =
      (model && this.availability.onToggleFavorite
        ? this.isFavorite(model)
          ? ' · ctrl+s unfavorite'
          : ' · ctrl+s favorite'
        : '') +
      (model && isCustomProviderModel(model) && this.availability.onDeleteProvider
        ? ' · ctrl+d delete provider'
        : '');
    if (supportsTuiEffort(model)) {
      return `↑↓ select · type to search · ←/→ effort · enter apply${contextHint}${deleteHint} · esc cancel`;
    }
    return switchable
      ? `↑↓ select · type to search · ←/→ thinking · enter apply${contextHint}${deleteHint} · esc cancel`
      : `↑↓ select · type to search · enter apply${contextHint}${deleteHint} · esc cancel`;
  }

  private renderDeleteConfirmation(width: number, height?: number): string[] {
    const providerId = this.deletingProviderId;
    const providerModels = this.models.filter((model) => model.providerId === providerId);
    const providerName =
      providerModels[0]?.providerName?.trim() || providerId || 'Unknown provider';
    const modelCount = providerModels.length;
    return renderPanelFrame(
      {
        title: 'Delete provider?',
        body: [
          sanitizeTerminalText(providerName),
          chalk.hex(colors.muted)(
            `This removes its saved credentials and all ${modelCount} configured model${modelCount === 1 ? '' : 's'}.`,
          ),
          ...(this.deleteStatus
            ? [
                this.deleteStatus.tone === 'error'
                  ? chalk.hex(colors.error)(`! ${this.deleteStatus.text}`)
                  : chalk.hex(colors.accent)(this.deleteStatus.text),
              ]
            : []),
        ],
        footer: 'Enter delete provider · Esc cancel',
      },
      width,
      height,
      'warning',
    );
  }

  private cancelProviderDeletion(): void {
    this.deletingProviderId = undefined;
    this.deleteStatus = undefined;
    this.availability.requestRender?.();
  }

  private async deleteProvider(): Promise<void> {
    const providerId = this.deletingProviderId;
    if (!providerId || !this.availability.onDeleteProvider) return;
    this.busy = true;
    this.deleteStatus = { tone: 'info', text: 'Deleting provider…' };
    this.availability.requestRender?.();
    try {
      await this.availability.onDeleteProvider(providerId);
      this.deletingProviderId = undefined;
      this.deleteStatus = undefined;
    } catch (error) {
      this.deleteStatus = {
        tone: 'error',
        text: formatTuiActionFailure(error, {
          summary: "Couldn't delete provider.",
          nextStep: 'Retry, or press Esc to cancel.',
          preservation: 'The provider and its models are unchanged.',
        }),
      };
    } finally {
      this.busy = false;
      this.availability.requestRender?.();
    }
  }

  private renderEffortControl(): string[] {
    const model = this.focusedModel();
    if (!model) return [];
    const options = normalizeTuiEffortOptions(model.effortOptions);
    const choice = this.effortChoice(model);
    if (options.length === 0) {
      return choice ? ['', chalk.hex(colors.muted)(`Effort ${choice} (fixed)`)] : [];
    }
    return [
      '',
      `${chalk.hex(colors.muted)('Think effort')} ${chalk.hex(colors.dim)('(←/→ to switch)')}`,
      options
        .map((option) =>
          option === choice
            ? chalk.bold.hex(colors.signal)(`[ ${option} ]`)
            : chalk.hex(colors.text)(option),
        )
        .join('  '),
    ];
  }

  private renderModelControl(): string[] {
    const hasModelControls = this.models.some(
      (model) =>
        contextWindowOptions(model).length > 1 ||
        supportsTuiEffort(model) ||
        resolveTuiEffortChoice(model) !== undefined ||
        resolveTuiThinkingChoice(model) !== undefined,
    );
    if (!hasModelControls) return [];
    const control = [
      ...this.renderContextControl(),
      ...this.renderEffortControl(),
      ...this.renderThinkingControl(),
    ];
    return [
      ...control,
      ...Array.from({ length: Math.max(0, MODEL_CONTROL_ROWS - control.length) }, () => ''),
    ];
  }

  private renderThinkingControl(): string[] {
    const model = this.focusedModel();
    if (!model) return [];
    if (supportsTuiEffort(model)) return [];
    if (model.thinkingConfig?.mode !== 'switchable' && this.effortChoice(model)) return [];
    const choice = this.thinkingChoice(model);
    if (!choice) return [];
    if (model.thinkingConfig?.mode !== 'switchable') {
      return ['', chalk.hex(colors.muted)(`Thinking ${choice === 'on' ? 'On' : 'Off'}`)];
    }
    const option = (value: TuiThinkingChoice, label: string) =>
      value === choice
        ? chalk.bold.hex(colors.signal)(`[ ${label} ]`)
        : chalk.hex(colors.text)(label);
    return [
      '',
      `${chalk.hex(colors.muted)('Thinking')} ${chalk.hex(colors.dim)('(←/→ to switch)')}`,
      `${option('on', 'On')}  ${option('off', 'Off')}`,
    ];
  }
}

function codexOAuthAction(state: Exclude<McodeCodexOAuthState, 'hidden'>): {
  readonly label: string;
  readonly description: string;
} {
  if (state === 'connected') {
    return { label: '✓ OpenAI Codex connected', description: 'OAuth credentials are ready' };
  }
  if (state === 'pending') {
    return {
      label: '↻ Continue OpenAI Codex sign-in…',
      description: 'Open the browser sign-in again',
    };
  }
  if (state === 'failed') {
    return {
      label: '↻ Retry OpenAI Codex sign-in…',
      description: 'The previous sign-in failed',
    };
  }
  return { label: '+ Connect OpenAI Codex…', description: 'Sign in with OpenAI OAuth' };
}

function modelKey(model: TuiModel): ModelKey {
  return `${model.providerId}\u0000${model.modelId}`;
}

function favoriteRowValue(key: ModelKey): string {
  return `${FAVORITE_ROW_PREFIX}${key}`;
}

function rowModelKey(value: string): ModelKey {
  return value.startsWith(FAVORITE_ROW_PREFIX) ? value.slice(FAVORITE_ROW_PREFIX.length) : value;
}

function isCustomProviderModel(model: TuiModel): boolean {
  return model.providerSource === 'custom_provider';
}

function searchableModelText(model: TuiModel): string {
  return [
    model.providerId,
    model.providerName,
    model.modelId,
    model.displayName,
    model.variant,
    `${model.providerId}/${model.modelId}`,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLocaleLowerCase();
}

function groupModels(models: readonly TuiModel[]): ModelGroup[] {
  const groups = new Map<string, TuiModel[]>();
  for (const model of models) {
    const label = model.providerName?.trim() || model.providerId;
    const group = groups.get(label);
    if (group) group.push(model);
    else groups.set(label, [model]);
  }
  return Array.from(groups, ([label, group]) => ({ label, models: group }));
}

function formatModelDescription(model: TuiModel, unavailable: boolean): string {
  const efforts = normalizeTuiEffortOptions(model.effortOptions);
  return [
    sanitizeTerminalText(`${model.providerId}/${model.modelId}`),
    unavailable ? 'Login required' : undefined,
    model.variant && model.variant !== 'thinking' ? sanitizeTerminalText(model.variant) : undefined,
    efforts.length > 0 ? `${String(efforts.length)} efforts` : undefined,
    model.contextLimit ? `${formatContextWindow(model.contextLimit)} ctx` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
}
