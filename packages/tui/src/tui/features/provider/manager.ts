import { getKeybindings, Key, matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { sanitizeTuiUrl } from '../../rendering/url.js';
import { Input } from '../../widgets/input.js';
import {
  renderTuiActionHint,
  tuiChalk as chalk,
  tuiColors as colors,
} from '../../theme/runtime.js';
import type {
  McodeProviderSnapshot,
  McodeProviderTestResult,
  McodeProviderView,
  McodeSaveProviderCandidateInput,
  McodeSaveProviderCandidateResult,
} from '../../../provider/contract.js';
import { TuiProviderEditor } from './editor.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';

/**
 * `/provider` owns the independent Codex connect action and MiniMax credential
 * source. The MiniMax API Key can be replaced and OAuth can start a fresh
 * sign-in. Custom connections are edited through revision-checked candidate saves
 * and deleted here; `/model` only picks models.
 */
type ProviderManagerMode =
  | { readonly kind: 'list' }
  | { readonly kind: 'minimax-key'; readonly replacing: boolean }
  | { readonly kind: 'confirm-delete'; readonly provider: McodeProviderView };

export interface TuiProviderManagerOptions {
  snapshot: McodeProviderSnapshot;
  onRefresh(): Promise<McodeProviderSnapshot>;
  onRefreshModels?(provider: McodeProviderView): Promise<number>;
  onTest(providerId: string, modelId?: string): Promise<McodeProviderTestResult>;
  onConnectCodex?(): void;
  onSaveCustom?(input: McodeSaveProviderCandidateInput): Promise<McodeSaveProviderCandidateResult>;
  /** Removes a custom connection with its credentials and models. */
  onDelete?(providerId: string): Promise<void>;
  onSetMiniMaxApiKey(apiKey: string): Promise<void>;
  onSetMiniMaxSource(source: 'token_plan' | 'minimax_api_key'): Promise<void>;
  /** Starts the same sign-in flow as `/login`; absent when the host has no auth. */
  onReLogin?(): void;
  onCancel(): void;
  requestRender(): void;
}

export class TuiProviderManager implements Component, Focusable {
  private editor?: TuiProviderEditor;
  private snapshotValue: McodeProviderSnapshot;
  private selectedIndex = 0;
  private mode: ProviderManagerMode = { kind: 'list' };
  private readonly secretInput = new Input({ mask: '•' });
  private busy = false;
  private status?: { readonly tone: 'info' | 'error'; readonly text: string };
  private _focused = false;
  private disposed = false;

  constructor(private readonly options: TuiProviderManagerOptions) {
    this.snapshotValue = options.snapshot;
    const activeIndex = this.providers().findIndex((provider) => provider.active);
    this.selectedIndex = Math.max(0, activeIndex);
    this.secretInput.onSubmit = (value) => this.submitMiniMaxKey(value);
    this.secretInput.onEscape = () => this.exitMode();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncFocus();
  }

  handleInput(data: string): void {
    if (this.busy || this.disposed) return;
    if (this.editor) {
      this.editor.handleInput(data);
      return;
    }
    if (this.mode.kind === 'minimax-key') {
      this.secretInput.handleInput(data);
      this.requestRender();
      return;
    }
    if (this.mode.kind === 'confirm-delete') {
      // Only an explicit y deletes. Enter is the list's "use" key, so a
      // reflexive Enter after a stray d must back out instead of confirming.
      if (data.toLowerCase() === 'y') void this.deleteConfirmed(this.mode.provider);
      else this.exitMode();
      return;
    }
    if (getKeybindings().matches(data, 'tui.select.cancel')) {
      this.options.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.move(1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      void this.useSelected();
      return;
    }
    const key = data.toLowerCase();
    if (key === 'r') void this.refreshSelectedModels();
    else if (key === 't') void this.testSelected();
    else if (key === 'e') this.editSelected();
    else if (key === 'd') this.armDelete();
    else if (key === ' ') void this.useSelected();
  }

  invalidate(): void {
    this.secretInput.invalidate();
    this.editor?.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.editor?.dispose();
    this.secretInput.focused = false;
    this.secretInput.setValue('');
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth === 0) return [];
    if (this.editor) return this.editor.render(safeWidth);
    const lines =
      this.mode.kind === 'minimax-key'
        ? this.renderMiniMaxKey(safeWidth)
        : this.mode.kind === 'confirm-delete'
          ? this.renderDeleteConfirmation(this.mode.provider, safeWidth)
          : this.renderList(safeWidth);
    return lines.map((line) => truncateToWidth(line, safeWidth, chalk.hex(colors.dim)('…')));
  }

  private renderList(width: number): string[] {
    const providers = this.providers();
    const lines = [
      frameTop(width),
      frameRow(
        composeLine(
          chalk.bold.hex(colors.signal)('Providers'),
          chalk.hex(colors.muted)('Model sources and credentials'),
          Math.max(1, width - 4),
        ),
        width,
      ),
      frameRow(
        chalk.hex(colors.dim)('Choose a source or edit a connection; keys stay masked.'),
        width,
      ),
      frameDivider(width),
    ];
    for (const [index, provider] of providers.entries()) {
      const selected = index === this.selectedIndex;
      const sourceInUse = isSelectedSource(provider);
      const label = `${selected ? chalk.bold.hex(colors.signal)('›') : ' '} ${chalk.hex(
        sourceInUse ? colors.signal : colors.text,
      )(`${markerFor(provider)} ${sanitizeTerminalText(provider.name)}`)}`;
      lines.push(
        frameRow(
          composeLine(label, renderTuiActionHint(providerSummary(provider)), width - 4),
          width,
        ),
      );
    }
    const provider = this.selectedProvider();
    if (provider) {
      lines.push(frameDivider(width));
      lines.push(frameRow(renderTuiActionHint(providerDetail(provider)), width));
      if (provider.kind === 'custom') {
        if (provider.baseUrl) {
          lines.push(frameRow(chalk.hex(colors.dim)(sanitizeTuiUrl(provider.baseUrl)), width));
        }
        const models = providerModelList(provider);
        if (models) lines.push(frameRow(chalk.hex(colors.dim)(models), width));
      }
    }
    if (this.status) {
      lines.push(
        frameRow(
          this.status.tone === 'error'
            ? chalk.hex(colors.error)(`! ${this.status.text}`)
            : chalk.hex(colors.accent)(`✓ ${this.status.text}`),
          width,
        ),
      );
    }
    lines.push(
      frameDivider(width),
      frameRow(
        renderTuiActionHint(
          this.busy
            ? 'Working…'
            : '↑↓ move · Space use · r refresh models · e edit · t test · d delete · Esc close',
        ),
        width,
      ),
      frameRow(
        chalk.hex(colors.dim)('Select a custom connection and press r to fetch its latest models.'),
        width,
      ),
      frameBottom(width),
    );
    return lines;
  }

  private renderMiniMaxKey(width: number): string[] {
    const replacing = this.mode.kind === 'minimax-key' && this.mode.replacing;
    return [
      frameTop(width),
      frameRow(
        chalk.bold.hex(colors.signal)(
          replacing ? 'Replace MiniMax API Key' : 'Configure MiniMax API Key',
        ),
        width,
      ),
      frameRow(
        chalk.hex(colors.muted)(
          replacing
            ? 'The saved key is overwritten once you submit.'
            : 'Saved locally and used instead of Token Plan.',
        ),
        width,
      ),
      frameDivider(width),
      frameRow(this.secretInput.render(Math.max(1, width - 8))[0] ?? '', width),
      ...(this.status ? [frameRow(chalk.hex(colors.error)(`! ${this.status.text}`), width)] : []),
      frameDivider(width),
      frameRow(renderTuiActionHint('Enter save and use · Esc cancel'), width),
      frameBottom(width),
    ];
  }

  private renderDeleteConfirmation(provider: McodeProviderView, width: number): string[] {
    const count = provider.models.length;
    return [
      frameTop(width),
      frameRow(
        chalk.bold.hex(colors.warning)(`Delete ${sanitizeTerminalText(provider.name)}?`),
        width,
      ),
      frameRow(
        chalk.hex(colors.muted)(
          `This removes its saved API Key and all ${count} configured model${count === 1 ? '' : 's'}.`,
        ),
        width,
      ),
      frameDivider(width),
      frameRow(renderTuiActionHint('y delete · any other key cancel'), width),
      frameBottom(width),
    ];
  }

  private providers(): readonly McodeProviderView[] {
    return this.snapshotValue.providers;
  }

  private selectedProvider(): McodeProviderView | undefined {
    return this.providers()[this.selectedIndex];
  }

  private move(delta: number): void {
    this.selectedIndex = Math.max(
      0,
      Math.min(this.providers().length - 1, this.selectedIndex + delta),
    );
    this.status = undefined;
    this.requestRender();
  }

  private async refreshSelectedModels(): Promise<void> {
    const provider = this.selectedProvider();
    const refreshModels = this.options.onRefreshModels;
    if (!provider || provider.kind !== 'custom' || provider.readOnly || !refreshModels) {
      this.status = { tone: 'info', text: 'Select a custom connection to refresh its models.' };
      this.requestRender();
      return;
    }
    await this.perform(async () => {
      const count = await refreshModels(provider);
      try {
        await this.refresh(
          count
            ? `Added ${count} new model(s). Choose one with /model.`
            : 'Models are already up to date.',
        );
      } catch {
        this.setStatus(
          'Models were refreshed, but the list could not be reloaded. Reopen /provider.',
          'error',
        );
      }
    });
  }

  /** Custom rows open an editor; selecting them never silently changes credentials. */
  private async useSelected(): Promise<void> {
    const provider = this.selectedProvider();
    if (!provider) return;
    if (provider.kind === 'codex-oauth') {
      await this.connectCodex(provider);
      return;
    }
    if (provider.kind === 'minimax-oauth') {
      await this.setMiniMaxSource('token_plan');
      return;
    }
    if (provider.kind === 'minimax-api-key') {
      if (!provider.hasApiKey) {
        this.startMiniMaxKey();
        return;
      }
      await this.setMiniMaxSource('minimax_api_key');
      return;
    }
    this.editSelected();
  }

  /**
   * `e` edits the credential behind the highlighted MiniMax row. OAuth has no
   * local secret to type, so it hands off to the same sign-in flow as
   * `/login`; the API Key row opens the masked input, replacing any saved key.
   */
  private editSelected(): void {
    const provider = this.selectedProvider();
    if (!provider) return;
    if (provider.kind === 'minimax-api-key') {
      this.startMiniMaxKey(provider.hasApiKey);
      return;
    }
    if (provider.kind === 'minimax-oauth') {
      if (!this.options.onReLogin) {
        this.setStatus('MiniMax sign-in is unavailable in this host.', 'error');
        return;
      }
      this.options.onReLogin();
      return;
    }
    if (provider.kind === 'codex-oauth') {
      this.setStatus('Use Enter or Space on the Codex row to start sign-in.', 'info');
      return;
    }
    if (provider.readOnly || !this.options.onSaveCustom) {
      this.setStatus('This connection cannot be edited in this host.', 'info');
      return;
    }
    if (!provider.configRevision || !provider.baseUrl) {
      this.setStatus('Connection details are stale. Reopen /provider.', 'error');
      return;
    }
    this.editor = new TuiProviderEditor({
      provider,
      onSave: this.options.onSaveCustom,
      onSaved: (keyChanged) => {
        this.closeEditor();
        void this.perform(
          () =>
            this.refresh(
              keyChanged
                ? 'Connection saved. All its models now use the new API Key.'
                : 'Connection changes saved.',
            ),
          {
            summary: 'Connection saved, but the list could not refresh.',
            nextStep: 'Reopen /provider.',
          },
        );
      },
      onCancel: () => this.closeEditor(),
      requestRender: () => this.requestRender(),
    });
    this.syncFocus();
    this.requestRender();
  }

  private armDelete(): void {
    const provider = this.selectedProvider();
    if (!provider) return;
    if (provider.kind !== 'custom' || provider.readOnly) {
      this.setStatus('Only custom connections can be deleted.', 'info');
      return;
    }
    if (!this.options.onDelete) {
      this.setStatus('This connection cannot be deleted in this host.', 'info');
      return;
    }
    this.mode = { kind: 'confirm-delete', provider };
    this.status = undefined;
    this.requestRender();
  }

  private async deleteConfirmed(provider: McodeProviderView): Promise<void> {
    const onDelete = this.options.onDelete;
    this.mode = { kind: 'list' };
    if (!onDelete) return;
    const count = provider.models.length;
    let deleted = false;
    await this.perform(
      async () => {
        await onDelete(provider.providerId);
        deleted = true;
      },
      {
        summary: `Couldn't delete ${provider.name}.`,
        nextStep: 'The connection and its models are unchanged.',
      },
    );
    if (!deleted || this.disposed) return;
    // A failed reload must not claim the deletion failed: the credentials and
    // models are already gone, only the list is stale.
    await this.perform(
      () =>
        this.refresh(`Deleted ${provider.name} and its ${count} model${count === 1 ? '' : 's'}.`),
      {
        summary: `Deleted ${provider.name}, but the list could not refresh.`,
        nextStep: 'Reopen /provider.',
      },
    );
  }

  private closeEditor(): void {
    this.editor?.dispose();
    this.editor = undefined;
    this.syncFocus();
    this.requestRender();
  }

  private async connectCodex(provider: McodeProviderView): Promise<void> {
    const state = provider.status?.state;
    if (state === 'connected') {
      this.setStatus('OpenAI Codex is already connected.', 'info');
      return;
    }
    if (!this.options.onConnectCodex) {
      this.setStatus('Codex sign-in is unavailable in this host.', 'error');
      return;
    }
    this.options.onConnectCodex();
  }

  private startMiniMaxKey(replacing = false): void {
    this.mode = { kind: 'minimax-key', replacing };
    this.status = undefined;
    this.secretInput.setValue('');
    this.secretInput.moveCursorToEnd();
    this.syncFocus();
    this.requestRender();
  }

  private submitMiniMaxKey(value: string): void {
    if (this.mode.kind !== 'minimax-key') return;
    const replacing = this.mode.replacing;
    if (!value.trim()) {
      this.setStatus('API key is required.', 'error');
      return;
    }
    void this.perform(async () => {
      await this.options.onSetMiniMaxApiKey(value.trim());
      if (this.disposed) return;
      await this.refresh(
        replacing
          ? 'MiniMax API Key replaced and selected.'
          : 'MiniMax API Key saved and selected.',
      );
      if (this.disposed) return;
      this.mode = { kind: 'list' };
    });
  }

  private async testSelected(): Promise<void> {
    const provider = this.selectedProvider();
    if (!provider) return;
    if (provider.kind === 'codex-oauth') {
      this.setStatus('Codex OAuth connectivity is managed by its sign-in flow.', 'info');
      return;
    }
    if (provider.kind === 'minimax-oauth') {
      this.setStatus('MiniMax OAuth sign-in and connectivity are managed by /login.', 'info');
      return;
    }
    await this.perform(async () => {
      const result = await this.options.onTest(provider.providerId);
      if (this.disposed) return;
      await this.refresh(
        result.success
          ? `${provider.name} connection is available.`
          : formatTuiActionFailure(result.status.lastErrorMessage ?? result.status.state, {
              summary: `${provider.name} connection test failed.`,
              nextStep: 'Check the URL, credentials, and model ID, then retry.',
            }),
        result.success ? 'info' : 'error',
      );
    });
  }

  private async setMiniMaxSource(source: 'token_plan' | 'minimax_api_key'): Promise<void> {
    await this.perform(async () => {
      await this.options.onSetMiniMaxSource(source);
      if (this.disposed) return;
      await this.refresh(
        source === 'token_plan' ? 'Using MiniMax Token Plan.' : 'Using MiniMax API Key.',
      );
    });
  }

  private async refresh(message: string, tone: 'info' | 'error' = 'info'): Promise<void> {
    const snapshot = await this.options.onRefresh();
    if (this.disposed) return;
    this.snapshotValue = snapshot;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.providers().length - 1));
    this.setStatus(message, tone);
  }

  private async perform(
    operation: () => Promise<void>,
    failure: { readonly summary: string; readonly nextStep: string } = {
      summary: 'The provider source was not changed.',
      nextStep: 'Retry, or manage providers in Settings.',
    },
  ): Promise<void> {
    this.busy = true;
    this.status = undefined;
    this.requestRender();
    try {
      await operation();
    } catch (error) {
      if (this.disposed) return;
      this.setStatus(
        formatTuiActionFailure(error, {
          summary: failure.summary,
          nextStep: failure.nextStep,
        }),
        'error',
      );
    } finally {
      if (!this.disposed) {
        this.busy = false;
        this.syncFocus();
        this.requestRender();
      }
    }
  }

  private exitMode(): void {
    this.mode = { kind: 'list' };
    this.status = undefined;
    this.syncFocus();
    this.requestRender();
  }

  private setStatus(text: string, tone: 'info' | 'error'): void {
    this.status = { text: sanitizeTerminalText(text), tone };
    this.requestRender();
  }

  private syncFocus(): void {
    this.secretInput.focused = this._focused && this.mode.kind === 'minimax-key' && !this.editor;
    if (this.editor) this.editor.focused = this._focused;
  }

  private requestRender(): void {
    if (!this.disposed) this.options.requestRender();
  }
}

/**
 * `●` answers one question only: which MiniMax credential source is in use.
 * A custom provider holding the selected model is a different fact, so it
 * never claims the glyph — rendering both made two rows look simultaneously
 * selected.
 */
function isSelectedSource(provider: McodeProviderView): boolean {
  return (
    (provider.kind === 'minimax-oauth' || provider.kind === 'minimax-api-key') && provider.active
  );
}

function markerFor(provider: McodeProviderView): string {
  if (provider.kind === 'codex-oauth') {
    return provider.status?.state === 'connected' ? '✓' : '○';
  }
  if (provider.kind === 'custom') return provider.enabled ? '○' : '–';
  return provider.active ? '●' : '○';
}

function providerModelList(provider: McodeProviderView): string | undefined {
  if (provider.models.length === 0) return undefined;
  return sanitizeTerminalText(
    provider.models.map((model) => model.displayName ?? model.modelId).join(', '),
  );
}

function providerDetail(provider: McodeProviderView): string {
  if (provider.kind === 'codex-oauth') {
    if (provider.status?.state === 'connected') return 'Connected with OpenAI OAuth';
    if (provider.status?.state === 'pending') {
      return 'Sign-in pending · Enter or Space to continue';
    }
    if (provider.status?.state === 'failed') {
      return `${provider.status.lastErrorMessage ?? 'Sign-in failed'} · Enter or Space to retry`;
    }
    return 'Not connected · Enter or Space to connect';
  }
  if (provider.kind === 'minimax-oauth') {
    return 'Sign-in managed by /login · Space to use · e to sign in again';
  }
  if (provider.kind === 'minimax-api-key') {
    return provider.hasApiKey
      ? `${provider.maskedApiKey ?? 'key saved'} · Space to use · e to replace`
      : 'No API key saved · Space or e to add one';
  }
  return [
    provider.enabled ? 'Enabled' : 'Disabled',
    provider.apiFormat ?? 'anthropic-messages',
    provider.hasApiKey ? (provider.maskedApiKey ?? 'key saved') : 'no key',
    `${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`,
  ].join(' · ');
}

function providerSummary(provider: McodeProviderView): string {
  if (provider.kind === 'codex-oauth') {
    if (provider.status?.state === 'connected') return 'Connected';
    if (provider.status?.state === 'pending') return 'Waiting for sign-in';
    if (provider.status?.state === 'failed') return 'Sign-in failed';
    return 'Not connected';
  }
  if (provider.kind === 'minimax-oauth') {
    return provider.active ? 'Active · Token Plan' : 'Token Plan';
  }
  if (provider.kind === 'minimax-api-key') {
    return provider.hasApiKey
      ? provider.active
        ? 'Active · Key saved'
        : 'Key saved'
      : 'Not configured';
  }
  return `${provider.enabled ? 'Enabled' : 'Disabled'} · ${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`;
}

function composeLine(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap >= 2 ? `${left}${' '.repeat(gap)}${right}` : truncateToWidth(left, width, '…');
}

function frameTop(width: number): string {
  if (width < 2) return '─'.repeat(Math.max(0, width));
  return chalk.hex(colors.line)(`╭${'─'.repeat(Math.max(0, width - 2))}╮`);
}

function frameDivider(width: number): string {
  if (width < 2) return '─'.repeat(Math.max(0, width));
  return chalk.hex(colors.line)(`├${'─'.repeat(Math.max(0, width - 2))}┤`);
}

function frameBottom(width: number): string {
  if (width < 2) return '─'.repeat(Math.max(0, width));
  return chalk.hex(colors.line)(`╰${'─'.repeat(Math.max(0, width - 2))}╯`);
}

function frameRow(content: string, width: number): string {
  if (width < 4) return truncateToWidth(content, width, '…');
  const innerWidth = width - 4;
  const fitted = truncateToWidth(content, innerWidth, '…');
  return `${chalk.hex(colors.line)('│')} ${fitted}${' '.repeat(
    Math.max(0, innerWidth - visibleWidth(fitted)),
  )} ${chalk.hex(colors.line)('│')}`;
}
