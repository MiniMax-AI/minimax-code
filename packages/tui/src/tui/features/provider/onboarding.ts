import type {
  McodeProviderApiFormat,
  McodeProviderView,
  McodeProviderTemplate,
  McodeSaveProviderCandidateInput,
  McodeSaveProviderCandidateResult,
} from '../../../provider/contract.js';
import { additiveProviderModels, matchesProviderTemplate } from './connections.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';
import { getKeybindings, Input, matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { tuiChalk as chalk, tuiColors as colors, tuiSelectListTheme } from '../../theme/runtime.js';
import { SelectList } from '../../widgets/select-list.js';

const CUSTOM_PROVIDER_VALUE = '\u0000custom-provider';
const CUSTOM_FORMATS: readonly {
  readonly value: McodeProviderApiFormat;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    value: 'openai-completions',
    label: 'OpenAI Compatible',
    description: '/chat/completions',
  },
  { value: 'openai-responses', label: 'OpenAI Responses', description: '/responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages', description: '/v1/messages' },
];

type OnboardingMode =
  | 'provider'
  | 'connection'
  | 'alias'
  | 'model'
  | 'custom-name'
  | 'preset-url'
  | 'custom-url'
  | 'custom-format'
  | 'custom-model'
  | 'api-key';

type ModelFocus = 'models' | 'api-key';

export interface TuiProviderOnboardingResult {
  readonly providerId?: string;
  readonly providerName: string;
  readonly reused?: boolean;
  readonly modelId: string;
}

export interface TuiProviderOnboardingOptions {
  readonly templates: readonly McodeProviderTemplate[];
  readonly providers?: readonly McodeProviderView[];
  readonly catalogWarning?: string;
  readonly onSave: (
    input: McodeSaveProviderCandidateInput,
  ) => Promise<McodeSaveProviderCandidateResult>;
  readonly onComplete: (result: TuiProviderOnboardingResult) => void | Promise<void>;
  readonly onCancel: () => void;
  readonly requestRender: () => void;
}

export class TuiProviderOnboarding implements Component, Focusable {
  private mode: OnboardingMode = 'provider';
  private list: SelectList;
  private readonly searchInput = new Input({ prompt: '' });
  private readonly textInput = new Input({ prompt: '' });
  private readonly secretInput = new Input({ prompt: '', mask: '•' });
  private template?: McodeProviderTemplate;
  private connection?: McodeProviderView;
  private alias = '';
  private selectedModelId = '';
  private modelFocus: ModelFocus = 'models';
  private editingModelApiKey = false;
  private modelApiKeyDraft = '';
  private presetBaseUrl = '';
  private customName = '';
  private customBaseUrl = '';
  private customApiFormat: McodeProviderApiFormat = 'openai-completions';
  private customModelId = '';
  private busy = false;
  private status = '';
  private _focused = false;

  constructor(private readonly options: TuiProviderOnboardingOptions) {
    this.list = this.createProviderList();
    this.textInput.onSubmit = (value) => this.submitText(value);
    this.textInput.onEscape = () => this.back();
    this.secretInput.onSubmit = (value) =>
      this.editingModelApiKey ? this.commitModelApiKey(value) : this.submitApiKey(value);
    this.secretInput.onEscape = () =>
      this.editingModelApiKey ? this.cancelModelApiKeyEdit() : this.back();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncFocus();
  }

  handleInput(data: string): void {
    if (this.busy) return;
    if (this.mode === 'model') {
      this.handleModelInput(data);
      return;
    }
    if (getKeybindings().matches(data, 'tui.select.cancel')) {
      this.back();
      return;
    }
    if (this.mode === 'provider') {
      this.handleSearchableListInput(data);
      return;
    }
    if (this.mode === 'custom-format' || this.mode === 'connection') {
      this.list.handleInput(data);
      return;
    }
    const input = this.mode === 'api-key' ? this.secretInput : this.textInput;
    input.handleInput(data);
    this.options.requestRender();
  }

  invalidate(): void {
    this.list.invalidate();
    this.searchInput.invalidate();
    this.textInput.invalidate();
    this.secretInput.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (!safeWidth) return [];
    const lines = [
      chalk.bold.hex(colors.signal)('Add 3rd-party provider'),
      chalk.hex(colors.muted)(this.subtitle()),
      ...(this.mode === 'provider' && this.options.catalogWarning
        ? [chalk.hex(colors.warning)(sanitizeTerminalText(this.options.catalogWarning))]
        : []),
      '',
      ...this.renderBody(safeWidth),
      ...(this.status
        ? ['', chalk.hex(colors.error)(`! ${sanitizeTerminalText(this.status)}`)]
        : []),
      '',
      chalk.hex(colors.dim)(this.footer()),
    ];
    return lines.map((line) => truncateToWidth(line, safeWidth, chalk.hex(colors.dim)('…')));
  }

  private handleSearchableListInput(data: string): void {
    const keybindings = getKeybindings();
    if (
      keybindings.matches(data, 'tui.select.up') ||
      keybindings.matches(data, 'tui.select.down') ||
      keybindings.matches(data, 'tui.select.confirm')
    ) {
      this.list.handleInput(data);
      this.options.requestRender();
      return;
    }
    const previous = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (this.searchInput.getValue() !== previous) {
      if (this.mode === 'model') this.closeModelDetails();
      this.rebuildList();
    }
    this.options.requestRender();
  }

  private handleModelInput(data: string): void {
    const keybindings = getKeybindings();
    if (this.editingModelApiKey) {
      if (keybindings.matches(data, 'tui.select.down')) {
        const apiKey = this.secretInput.getValue().trim();
        if (apiKey) this.modelApiKeyDraft = apiKey;
        this.editingModelApiKey = false;
        this.modelFocus = 'models';
        this.status = '';
        this.secretInput.setValue('');
        this.syncFocus();
        this.options.requestRender();
        return;
      }
      this.secretInput.handleInput(data);
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, 'ctrl+e')) {
      this.enterTextMode(
        'preset-url',
        this.presetBaseUrl || this.connection?.baseUrl || this.template?.baseUrl || '',
      );
      return;
    }
    if (
      this.modelFocus === 'models' &&
      keybindings.matches(data, 'tui.select.up') &&
      this.list.getSelectedItem()?.value === this.filteredModels()[0]?.modelId
    ) {
      this.modelFocus = 'api-key';
      this.status = '';
      this.syncFocus();
      this.options.requestRender();
      return;
    }
    if (keybindings.matches(data, 'tui.input.tab')) {
      this.modelFocus = this.modelFocus === 'models' ? 'api-key' : 'models';
      this.status = '';
      this.syncFocus();
      this.options.requestRender();
      return;
    }
    if (keybindings.matches(data, 'tui.select.cancel')) {
      if (this.modelFocus === 'api-key') {
        this.modelFocus = 'models';
        this.status = '';
        this.syncFocus();
        this.options.requestRender();
        return;
      }
      if (this.selectedModelId) {
        this.closeModelDetails();
        this.options.requestRender();
        return;
      }
      this.back();
      return;
    }
    if (this.modelFocus === 'api-key') {
      if (keybindings.matches(data, 'tui.select.down')) {
        this.modelFocus = 'models';
        this.status = '';
        this.syncFocus();
        this.options.requestRender();
        return;
      }
      if (keybindings.matches(data, 'tui.select.confirm')) this.startModelApiKeyEdit();
      return;
    }
    this.handleSearchableListInput(data);
  }

  private renderBody(width: number): string[] {
    if (this.mode === 'model') {
      const prompt = chalk.hex(colors.muted)('Search: ');
      const input = this.searchInput.render(Math.max(1, width - visibleWidth(prompt)))[0] ?? '';
      return [
        chalk.hex(colors.text)(
          `Base URL: ${sanitizeTerminalText(this.presetBaseUrl || this.connection?.baseUrl || this.template?.baseUrl || '')}`,
        ),
        chalk.hex(colors.dim)('ctrl+e edit URL · match the endpoint to your API plan'),
        ...this.renderModelApiKey(width),
        '',
        `${prompt}${input}`,
        ...this.list.render(width),
        ...this.renderModelDetails(),
      ];
    }
    if (this.mode === 'provider') {
      const prompt = chalk.hex(colors.muted)('Search: ');
      const input = this.searchInput.render(Math.max(1, width - visibleWidth(prompt)))[0] ?? '';
      return [`${prompt}${input}`, ...this.list.render(width)];
    }
    if (this.mode === 'custom-format' || this.mode === 'connection') return this.list.render(width);
    const label = this.inputLabel();
    const input = this.mode === 'api-key' ? this.secretInput : this.textInput;
    return [chalk.hex(colors.text)(label), input.render(width)[0] ?? ''];
  }

  private renderModelApiKey(width: number): string[] {
    const prefix = this.modelFocus === 'api-key' ? '→ ' : '  ';
    const configured = this.modelApiKeyDraft || this.connection?.hasApiKey;
    const state = this.modelApiKeyDraft
      ? 'Ready for test'
      : this.connection?.hasApiKey
        ? 'Saved key (unchanged)'
        : 'Not configured';
    const action = this.editingModelApiKey
      ? 'Enter to keep'
      : this.modelFocus === 'api-key'
        ? `Enter to ${configured ? 'edit' : 'configure'}`
        : `Tab to ${configured ? 'edit' : 'configure'}`;
    const status = `${prefix}API Key: ${state} · ${action}`;
    if (!this.editingModelApiKey) return [chalk.hex(colors.text)(status)];
    const prompt = chalk.hex(colors.muted)('  Edit: ');
    const input = this.secretInput.render(Math.max(1, width - visibleWidth(prompt)))[0] ?? '';
    return [chalk.hex(colors.text)(status), `${prompt}${input}`];
  }

  private renderModelDetails(): string[] {
    const model = this.selectedModel();
    if (!model) return [];
    const limits = [
      model.limit?.context ? `context ${model.limit.context.toLocaleString('en-US')}` : '',
      model.limit?.output ? `output ${model.limit.output.toLocaleString('en-US')}` : '',
    ].filter(Boolean);
    const modalities = [
      model.modalities?.input?.length
        ? `input ${model.modalities.input.map(sanitizeTerminalText).join(', ')}`
        : '',
      model.modalities?.output?.length
        ? `output ${model.modalities.output.map(sanitizeTerminalText).join(', ')}`
        : '',
    ].filter(Boolean);
    const capabilities = [
      model.attachment ? 'attachments' : '',
      model.reasoning ? 'reasoning' : '',
      model.toolCall ? 'tools' : '',
      model.temperature ? 'temperature' : '',
    ].filter(Boolean);
    return [
      '',
      chalk.bold.hex(colors.signal)('Model details'),
      chalk.hex(colors.text)(`Model ID: ${sanitizeTerminalText(model.modelId)}`),
      chalk.hex(colors.text)(`Limits: ${limits.join(' · ') || 'Not specified'}`),
      chalk.hex(colors.text)(`Modalities: ${modalities.join(' · ') || 'Not specified'}`),
      chalk.hex(colors.text)(`Capabilities: ${capabilities.join(', ') || 'None listed'}`),
    ];
  }

  private createProviderList(): SelectList {
    const query = this.searchInput.getValue().trim().toLocaleLowerCase();
    const templates = this.options.templates.filter((template) =>
      `${template.providerId} ${template.name}`.toLocaleLowerCase().includes(query),
    );
    const items = templates.map((template) => ({
      value: template.providerId,
      label: sanitizeTerminalText(template.name),
      description: `${sanitizeTerminalText(template.apiFormat)} · ${template.models.length} models`,
      groupLabel: 'Known providers',
    }));
    if (!query || 'custom provider'.includes(query)) {
      items.push({
        value: CUSTOM_PROVIDER_VALUE,
        label: 'Custom provider',
        description: 'Enter URL, protocol, model ID, and API key',
        groupLabel: 'Manual',
      });
    }
    const list = this.createList(items);
    list.onSelect = (item) => this.selectProvider(item.value);
    return list;
  }

  private createModelList(): SelectList {
    const models = this.filteredModels();
    const list = this.createList(
      models.map((model) => ({
        value: model.modelId,
        label: sanitizeTerminalText(model.displayName ?? model.modelId),
        description: sanitizeTerminalText(model.modelId),
      })),
    );
    list.onSelectionChange = () => {
      this.closeModelDetails();
    };
    list.onSelect = (item) => {
      if (this.selectedModelId !== item.value) {
        this.selectedModelId = item.value;
        this.status = '';
        return;
      }
      if (!this.modelApiKeyDraft && !this.connection?.hasApiKey) {
        this.startModelApiKeyEdit();
        return;
      }
      void this.save(this.modelApiKeyDraft);
    };
    return list;
  }

  private filteredModels(): McodeProviderTemplate['models'] {
    const query = this.searchInput.getValue().trim().toLocaleLowerCase();
    return (this.template?.models ?? []).filter((model) =>
      `${model.modelId} ${model.displayName ?? ''}`.toLocaleLowerCase().includes(query),
    );
  }

  private createFormatList(): SelectList {
    const list = this.createList([...CUSTOM_FORMATS]);
    list.onSelect = (item) => {
      this.customApiFormat = item.value as McodeProviderApiFormat;
      this.enterTextMode('custom-model', this.customModelId);
    };
    return list;
  }

  private createList(
    items: Array<{ value: string; label: string; description?: string; groupLabel?: string }>,
  ): SelectList {
    return new SelectList(items, Math.min(Math.max(items.length, 1), 10), tuiSelectListTheme, {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 40,
    });
  }

  private selectProvider(value: string): void {
    this.status = '';
    if (value === CUSTOM_PROVIDER_VALUE) {
      this.resetKnownProviderDraft();
      this.template = undefined;
      this.enterTextMode('custom-name', this.customName);
      return;
    }
    this.template = this.options.templates.find((template) => template.providerId === value);
    if (!this.template) return;
    this.resetKnownProviderDraft();
    this.enterMode(this.matchingConnections().length ? 'connection' : 'model');
  }

  private matchingConnections(): readonly McodeProviderView[] {
    const template = this.template;
    return template
      ? (this.options.providers ?? []).filter(
          (provider) => matchesProviderTemplate(provider, template) && provider.configRevision,
        )
      : [];
  }

  private createConnectionList(): SelectList {
    const connections = this.matchingConnections();
    const list = this.createList([
      ...connections.map((provider) => ({
        value: provider.providerId,
        label: `Use existing connection: ${sanitizeTerminalText(provider.name)}`,
        description: `${provider.providerId} · keep saved key · select or add models`,
      })),
      {
        value: CUSTOM_PROVIDER_VALUE,
        label: 'Add another account',
        description: 'Create a separate connection with an alias and API Key',
      },
    ]);
    list.onSelect = (item) => {
      if (item.value === CUSTOM_PROVIDER_VALUE) {
        this.connection = undefined;
        this.enterTextMode('alias', '');
      } else {
        this.connection = connections.find((provider) => provider.providerId === item.value);
        this.enterMode('model');
      }
    };
    return list;
  }

  private startModelApiKeyEdit(): void {
    this.editingModelApiKey = true;
    this.modelFocus = 'api-key';
    this.status = '';
    this.secretInput.setValue('');
    this.secretInput.moveCursorToEnd();
    this.syncFocus();
    this.options.requestRender();
  }

  private commitModelApiKey(value: string): void {
    const apiKey = value.trim();
    if (!apiKey && !this.modelApiKeyDraft && !this.connection?.hasApiKey) {
      this.status = 'API Key is required.';
      this.options.requestRender();
      return;
    }
    if (apiKey) this.modelApiKeyDraft = apiKey;
    this.editingModelApiKey = false;
    this.modelFocus = 'models';
    this.status = '';
    this.secretInput.setValue('');
    this.syncFocus();
    this.options.requestRender();
  }

  private cancelModelApiKeyEdit(): void {
    this.editingModelApiKey = false;
    this.status = '';
    this.secretInput.setValue('');
    this.syncFocus();
    this.options.requestRender();
  }

  private submitText(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) {
      this.status = `${this.inputLabel()} is required.`;
      this.options.requestRender();
      return;
    }
    if (this.mode === 'alias') {
      this.alias = trimmed;
      this.enterMode('model');
      return;
    }
    if (this.mode === 'custom-name') {
      this.customName = trimmed;
      this.enterTextMode('custom-url', this.customBaseUrl);
      return;
    }
    if (this.mode === 'custom-url' || this.mode === 'preset-url') {
      if (!isHttpUrl(trimmed)) {
        this.status = 'Base URL must use http or https.';
        this.options.requestRender();
        return;
      }
      if (this.mode === 'preset-url') {
        this.presetBaseUrl = trimmed;
        // Return without rebuilding the model list or discarding the key/model draft.
        this.mode = 'model';
        this.status = '';
        this.syncFocus();
        this.options.requestRender();
        return;
      }
      this.customBaseUrl = trimmed;
      this.enterMode('custom-format');
      return;
    }
    if (this.mode === 'custom-model') {
      this.customModelId = trimmed;
      this.enterMode('api-key');
    }
  }

  private submitApiKey(value: string): void {
    const apiKey = value.trim();
    if (!apiKey) {
      this.status = 'API Key is required.';
      this.options.requestRender();
      return;
    }
    void this.save(apiKey);
  }

  private async save(apiKey: string): Promise<void> {
    const input = this.saveInput(apiKey);
    if (!input) return;
    this.busy = true;
    this.status = '';
    this.options.requestRender();
    try {
      const result = await this.options.onSave(input);
      if (!result.success) {
        this.status = `Changes were not saved. ${result.status?.lastErrorMessage ?? 'Connection test failed.'}`;
        return;
      }
      await this.options.onComplete({
        ...(result.provider?.providerId ? { providerId: result.provider.providerId } : {}),
        providerName: input.name ?? 'Custom provider',
        modelId: input.modelId,
        ...(this.connection ? { reused: true } : {}),
      });
      if (this.template) this.resetKnownProviderDraft();
    } catch (error) {
      this.status = formatTuiActionFailure(error, {
        summary: "Couldn't save the provider.",
        nextStep: 'Check the URL, API key, and model, then retry.',
      });
    } finally {
      if (apiKey) this.status = this.status.split(apiKey).join('[redacted]');
      this.busy = false;
      this.options.requestRender();
    }
  }

  private saveInput(apiKey: string): McodeSaveProviderCandidateInput | undefined {
    if (this.template) {
      if (!this.selectedModelId) return undefined;
      return {
        ...(this.connection
          ? {
              providerId: this.connection.providerId,
              expectedRevision: this.connection.configRevision,
            }
          : {}),
        name: this.connection?.name ?? (this.alias || this.template.name),
        baseUrl: this.presetBaseUrl || this.connection?.baseUrl || this.template.baseUrl,
        ...(apiKey ? { apiKey } : {}),
        apiFormat: this.template.apiFormat,
        models: this.connection
          ? additiveProviderModels(this.connection, this.template.models)
          : this.template.models,
        modelId: this.selectedModelId,
        saveAndUse: true,
      };
    }
    if (!this.customName || !this.customBaseUrl || !this.customModelId) return undefined;
    return {
      name: this.customName,
      baseUrl: this.customBaseUrl,
      apiKey,
      apiFormat: this.customApiFormat,
      models: [
        {
          modelId: this.customModelId,
          displayName: this.customModelId,
          configurationSource: 'manual',
          toolCall: true,
        },
      ],
      modelId: this.customModelId,
      saveAndUse: true,
    };
  }

  private enterMode(mode: OnboardingMode): void {
    this.mode = mode;
    this.status = '';
    this.searchInput.setValue('');
    this.searchInput.moveCursorToEnd();
    if (
      mode === 'provider' ||
      mode === 'model' ||
      mode === 'custom-format' ||
      mode === 'connection'
    )
      this.rebuildList();
    if (mode === 'api-key') {
      this.secretInput.setValue('');
      this.secretInput.moveCursorToEnd();
    }
    this.syncFocus();
    this.options.requestRender();
  }

  private enterTextMode(
    mode: 'custom-name' | 'custom-url' | 'custom-model' | 'alias' | 'preset-url',
    value: string,
  ): void {
    this.mode = mode;
    this.status = '';
    this.textInput.setValue(value);
    this.textInput.moveCursorToEnd();
    this.syncFocus();
    this.options.requestRender();
  }

  private rebuildList(): void {
    this.list =
      this.mode === 'connection'
        ? this.createConnectionList()
        : this.mode === 'provider'
          ? this.createProviderList()
          : this.mode === 'model'
            ? this.createModelList()
            : this.createFormatList();
  }

  private selectedModel(): McodeProviderTemplate['models'][number] | undefined {
    return this.template?.models.find((model) => model.modelId === this.selectedModelId);
  }

  private closeModelDetails(): void {
    this.selectedModelId = '';
    this.status = '';
  }

  private resetKnownProviderDraft(): void {
    this.presetBaseUrl = '';
    this.connection = undefined;
    this.alias = '';
    this.selectedModelId = '';
    this.modelFocus = 'models';
    this.editingModelApiKey = false;
    this.modelApiKeyDraft = '';
    this.secretInput.setValue('');
  }

  private back(): void {
    if (this.mode === 'preset-url') {
      this.mode = 'model';
      this.status = '';
      this.syncFocus();
      this.options.requestRender();
      return;
    }
    if (this.mode === 'provider') {
      this.resetKnownProviderDraft();
      return this.options.onCancel();
    }
    if (this.mode === 'model') {
      this.resetKnownProviderDraft();
      return this.enterMode('provider');
    }
    if (this.mode === 'connection') return this.enterMode('provider');
    if (this.mode === 'alias') return this.enterMode('connection');
    if (this.mode === 'custom-name') return this.enterMode('provider');
    if (this.mode === 'custom-url') return this.enterTextMode('custom-name', this.customName);
    if (this.mode === 'custom-format') return this.enterTextMode('custom-url', this.customBaseUrl);
    if (this.mode === 'custom-model') return this.enterMode('custom-format');
    if (this.template) return this.enterMode('model');
    this.enterTextMode('custom-model', this.customModelId);
  }

  private subtitle(): string {
    if (this.mode === 'connection')
      return 'This provider is already configured. Use the saved connection or add another account.';
    if (this.mode === 'preset-url') return 'Confirm the endpoint before testing with your API key';
    if (this.mode === 'alias') return 'Give the additional account a recognizable name';
    if (this.mode === 'provider') return 'Choose a known provider or enter a custom endpoint';
    if (this.mode === 'model')
      return `Choose a ${sanitizeTerminalText(this.template?.name ?? '')} model`;
    if (this.mode === 'api-key') return 'The key is stored locally and never shown in output';
    return 'Custom provider';
  }

  private inputLabel(): string {
    if (this.mode === 'alias') return 'Account alias';
    if (this.mode === 'custom-name') return 'Provider name';
    if (this.mode === 'custom-url' || this.mode === 'preset-url') return 'Base URL';
    if (this.mode === 'custom-model') return 'Model ID';
    return 'API Key';
  }

  private footer(): string {
    if (this.busy) return 'Testing and saving…';
    if (this.mode === 'model') {
      if (this.editingModelApiKey) return 'enter keep for setup · ↓ models · esc cancel edit';
      if (this.modelFocus === 'api-key') return 'enter edit API Key · ↓/tab models · esc models';
      if (this.selectedModelId)
        return 'enter test, save, and use · tab API Key · esc close details';
      return '↑↓ select · type to search · tab API Key · enter details · esc back';
    }
    if (this.mode === 'api-key') return 'enter test, save, and use · esc back';
    if (
      this.mode === 'preset-url' ||
      this.mode === 'custom-name' ||
      this.mode === 'custom-url' ||
      this.mode === 'custom-model' ||
      this.mode === 'alias'
    ) {
      return 'enter continue · esc back';
    }
    return '↑↓ select · type to search · enter continue · esc back';
  }

  private syncFocus(): void {
    this.searchInput.focused =
      this._focused &&
      (this.mode === 'provider' ||
        (this.mode === 'model' && this.modelFocus === 'models' && !this.editingModelApiKey));
    this.textInput.focused =
      this._focused &&
      (this.mode === 'preset-url' ||
        this.mode === 'custom-name' ||
        this.mode === 'custom-url' ||
        this.mode === 'custom-model' ||
        this.mode === 'alias');
    this.secretInput.focused =
      this._focused &&
      (this.mode === 'api-key' || (this.mode === 'model' && this.editingModelApiKey));
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
