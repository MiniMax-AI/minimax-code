import {
  describeMcpAuthError,
  describeMcpAuthTarget,
  describeRejectedMcpAuthRedirect,
  isSafeMcpAuthorizationUrl,
  mcpAuthAttemptResolution,
  mcpAuthCanDisconnect,
  mcpAuthConfirmationLines,
  mcpAuthErrorCode,
  mcpAuthNeedsAttention,
  mcpAuthProblemDetail,
  mcpAuthStateLabel,
  resolveMcpAuthAttempt,
  resolveMcpAuthCompletion,
  sameMcpAuthTarget,
  type McpAuthAttemptResolution,
  type McpAuthTargetLike,
} from '../../../application/mcp-auth.js';
import type {
  TuiMcpAuthAttemptOutcome,
  TuiMcpAuthConfirmation,
  TuiMcpAuthOutcome,
  TuiMcpAuthPort,
  TuiMcpAuthState,
  TuiMcpAuthStateView,
  TuiMcpServer,
} from '../../../runtime/port.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';
import { Input, Key, matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import { panelLayout } from '../../widgets/panel-frame.js';
import {
  buildMcpServerRows,
  MCP_SERVER_SECTIONS,
  pluginLabel,
  type McpCatalogStatus,
  type McpServerRow,
} from './rows.js';

const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** `manual` prints the sign-in address and accepts the pasted redirect (SSH, no browser). */
export type TuiMcpAuthBrowserMode = 'open' | 'manual';

/** A committed state change (`mcp.auth_updated`); attempt fields are set when it ended one. */
export interface TuiMcpAuthUpdate {
  readonly target: McpAuthTargetLike;
  readonly authState: TuiMcpAuthState;
  readonly reason?: string;
  readonly attemptId?: string;
  readonly attemptOutcome?: TuiMcpAuthAttemptOutcome;
  readonly errorCode?: string;
}

export interface TuiMcpManagerContent {
  readonly servers: readonly TuiMcpServer[];
  readonly authStates: readonly TuiMcpAuthStateView[];
  /** Authorization states could not be loaded; catalog rows are still shown. */
  readonly authError?: string;
}

export interface TuiMcpManagerOptions extends TuiMcpManagerContent {
  readonly filter: string;
  readonly browserMode: TuiMcpAuthBrowserMode;
  readonly auth: Pick<
    TuiMcpAuthPort,
    'startMcpAuth' | 'cancelMcpAuth' | 'completeMcpAuth' | 'clearMcpAuth'
  >;
  readonly reload: () => Promise<TuiMcpManagerContent>;
  readonly loadAuthStates: () => Promise<TuiMcpAuthStateView[]>;
  readonly openExternalTarget: (url: string) => Promise<void>;
  readonly copyText?: (text: string) => Promise<void>;
  readonly onClose: () => void;
  readonly requestRender: () => void;
  readonly maxRows: () => number;
  /** Fallback for missed `mcp.auth_updated` events while a browser sign-in is pending. */
  readonly pollIntervalMs?: number;
}

interface PendingAttempt {
  readonly attemptId: string;
  readonly authUrl: string;
  readonly confirmation?: TuiMcpAuthConfirmation;
}

type ManagerPhase =
  | { readonly kind: 'list' }
  | { readonly kind: 'busy'; readonly message: string }
  | {
      readonly kind: 'confirm';
      readonly auth: TuiMcpAuthStateView;
      readonly attempt: PendingAttempt;
    }
  | {
      readonly kind: 'waiting';
      readonly auth: TuiMcpAuthStateView;
      readonly attempt: PendingAttempt;
      readonly manual: boolean;
      readonly browserFailed: boolean;
      readonly submitting: boolean;
      readonly error?: string;
    };

type StatusTone = 'success' | 'warning' | 'error' | 'muted';

/**
 * `/mcp`: the MCP catalog merged with OAuth state for user, project, and local Plugin servers
 * (official Plugin servers don't use OAuth and are never listed as authorization targets).
 * Runtime owns attempts and callbacks; this panel confirms, opens the browser, accepts a
 * pasted redirect, and observes completion through events with a state-poll fallback.
 */
export class TuiMcpManager implements Component, Focusable {
  readonly fullscreenViewport = true;
  readonly handlesViewportKeys = true;
  focused = false;
  private rows: McpServerRow[] = [];
  private authError: string | undefined;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private phase: ManagerPhase = { kind: 'list' };
  private status: { readonly text: string; readonly tone: StatusTone } | undefined;
  private readonly callbackInput = new Input({ prompt: '' });
  private pollTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly options: TuiMcpManagerOptions) {
    this.setContent(options);
    this.callbackInput.onSubmit = (value) => {
      void this.submitCallback(value);
    };
  }

  /**
   * Applies `mcp.auth_updated`. Only an update that names the pending attempt and its outcome
   * settles it: a failed reauthorization keeps the old token and still reports `authorized`.
   */
  applyAuthUpdate(update: TuiMcpAuthUpdate): void {
    if (this.disposed) return;
    this.updateRowState(update.target, update.authState, update.reason);
    const phase = this.phase;
    if (
      phase.kind === 'waiting' &&
      !phase.submitting &&
      update.attemptOutcome &&
      update.attemptId === phase.attempt.attemptId
    ) {
      this.finish(phase.auth, mcpAuthAttemptResolution(update.attemptOutcome, update.errorCode));
    }
    this.requestRender();
  }

  /** Applies `mcp.auth_required`; a pending attempt keeps waiting for its own outcome. */
  applyAuthRequired(target: McpAuthTargetLike, reason: string): void {
    if (this.disposed) return;
    this.updateRowState(target, reason === 'auth_required' ? 'needs_auth' : 'needs_reauth', reason);
    this.requestRender();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    const cancel = matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'));
    const phase = this.phase;
    if (phase.kind === 'busy') {
      // A slow discovery must not trap the user; dispose() cancels a late pending attempt.
      if (cancel) this.options.onClose();
      return;
    }
    if (phase.kind === 'confirm') {
      if (data === 'y' || data === 'Y') {
        void this.beginWaiting(phase.auth, phase.attempt);
      } else if (cancel || data === 'n' || data === 'N') {
        void this.cancelAttempt();
      }
      return;
    }
    if (phase.kind === 'waiting') {
      if (cancel) void this.cancelAttempt();
      else if (matchesKey(data, Key.tab)) void this.copyAuthUrl(phase.attempt.authUrl);
      else if (phase.manual && !phase.submitting) {
        this.callbackInput.handleInput(data);
        this.requestRender();
      }
      return;
    }
    if (cancel) {
      this.options.onClose();
    } else if (matchesKey(data, Key.up)) {
      this.move(-1);
    } else if (matchesKey(data, Key.down)) {
      this.move(1);
    } else if (matchesKey(data, Key.enter)) {
      void this.authorize(false);
    } else if (data === 'r' || data === 'R') {
      void this.authorize(true);
    } else if (data === 'd' || data === 'D' || matchesKey(data, Key.delete)) {
      void this.disconnect();
    } else if (matchesKey(data, Key.ctrl('r'))) {
      void this.refresh();
    }
  }

  invalidate(): void {
    this.callbackInput.invalidate?.();
  }

  /** Closing the panel abandons a pending attempt so its loopback listener is released. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPolling();
    const phase = this.phase;
    if (phase.kind === 'confirm' || phase.kind === 'waiting') {
      void this.options.auth.cancelMcpAuth(phase.attempt.attemptId).catch(() => undefined);
    }
  }

  render(width: number): string[] {
    return this.renderViewport(width, Math.max(6, Math.floor(this.options.maxRows())));
  }

  renderViewport(width: number, height?: number): string[] {
    const phase = this.phase;
    if (phase.kind === 'confirm') return this.renderConfirm(phase, width, height);
    if (phase.kind === 'waiting') return this.renderWaiting(phase, width, height);
    return this.renderList(width, height);
  }

  private renderList(width: number, height?: number): string[] {
    const layout = panelLayout(
      width,
      height,
      'Enter authorize · R reauthorize · D disconnect · Ctrl+R refresh · ↑↓ select · Esc close',
    );
    const contentWidth = Math.max(1, layout.contentWidth);
    const header = [
      chalk.hex(colors.muted)(this.subtitle()),
      ...(this.authError ? [chalk.hex(colors.error)(this.authError)] : []),
      ...(this.phase.kind === 'busy'
        ? [chalk.hex(colors.accent)(this.phase.message)]
        : this.status
          ? [paintStatus(this.status.text, this.status.tone)]
          : []),
    ].flatMap((line) => wrapTextWithAnsi(line, contentWidth));
    const { lines, selectedLine } = this.renderRows(contentWidth);
    const rowsHeight = Math.max(1, layout.bodyHeight - header.length);
    this.scrollOffset = clampScroll(this.scrollOffset, selectedLine, rowsHeight, lines.length);
    const attention = this.rows.filter(
      (row) => row.auth && mcpAuthNeedsAttention(row.auth.authState),
    ).length;
    const available = this.rows.filter((row) => row.catalog?.status === 'available').length;
    return layout.render(
      {
        title: 'MCP servers',
        meta: attention
          ? chalk.bold.hex(colors.error)(`${attention} NEED AUTH`)
          : chalk.bold.hex(colors.success)(`${available}/${this.rows.length} AVAILABLE`),
        body: [...header, ...lines.slice(this.scrollOffset, this.scrollOffset + rowsHeight)],
      },
      attention ? 'warning' : 'signal',
    );
  }

  private subtitle(): string {
    const filter = this.options.filter.trim();
    return [
      'MCP servers · OAuth for user, project, and local Plugin servers',
      filter ? `Matching “${sanitizeTerminalText(filter)}”` : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  private renderRows(width: number): { lines: string[]; selectedLine: number } {
    const lines: string[] = [];
    let selectedLine = 0;
    if (this.rows.length === 0) {
      lines.push(chalk.hex(colors.muted)('No MCP servers matched the current configuration.'));
      return { lines, selectedLine };
    }
    const labelWidth = Math.min(
      Math.max(...this.rows.map((row) => visibleWidth(sanitizeTerminalText(row.name)))),
      Math.max(8, Math.floor(width * 0.35)),
    );
    let index = 0;
    for (const { section, title } of MCP_SERVER_SECTIONS) {
      const rows = this.rows.filter((row) => row.section === section);
      if (rows.length === 0) continue;
      lines.push('', chalk.bold.hex(colors.text)(`${title} · ${rows.length}`));
      for (const row of rows) {
        const selected = index === this.selectedIndex;
        if (selected) selectedLine = lines.length;
        lines.push(...renderRow(row, selected, labelWidth, width));
        index += 1;
      }
    }
    return { lines, selectedLine };
  }

  private renderConfirm(
    phase: Extract<ManagerPhase, { kind: 'confirm' }>,
    width: number,
    height?: number,
  ): string[] {
    const layout = panelLayout(width, height, 'Y continue · N cancel · Esc cancel');
    const contentWidth = Math.max(1, layout.contentWidth);
    const confirmation = phase.attempt.confirmation;
    const body = [
      `${describeMcpAuthTarget(phase.auth.target)} opens a sign-in page from a source MiniMax doesn't verify.`,
      '',
      ...(confirmation
        ? mcpAuthConfirmationLines(confirmation)
        : ['Source details are unavailable for this server.']),
      '',
      chalk.bold.hex(colors.text)('Continue only if you trust this source.'),
    ].flatMap((line) => wrapTextWithAnsi(line, contentWidth));
    return layout.render({ title: 'Confirm MCP authorization', body }, 'warning');
  }

  private renderWaiting(
    phase: Extract<ManagerPhase, { kind: 'waiting' }>,
    width: number,
    height?: number,
  ): string[] {
    const copy = this.options.copyText ? 'Tab copy link · ' : '';
    const layout = panelLayout(
      width,
      height,
      phase.manual ? `${copy}Enter submit · Esc cancel` : `${copy}Esc cancel`,
    );
    const contentWidth = Math.max(1, layout.contentWidth);
    const url = sanitizeTerminalText(phase.attempt.authUrl);
    const lines: string[] = phase.manual
      ? [
          phase.browserFailed
            ? "Couldn't open a browser. Open this address in a browser on your computer:"
            : 'Open this address in a browser on your computer:',
          chalk.hex(colors.signal)(url),
          '',
          'After you approve, the browser goes to a localhost address that may not load. Copy that full address from the address bar and paste it here:',
        ]
      : [
          'Complete authorization in your browser.',
          'If the browser did not open, visit:',
          chalk.hex(colors.signal)(url),
        ];
    const body = lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth));
    if (phase.manual) {
      this.callbackInput.focused = this.focused && !phase.submitting;
      body.push(
        `${chalk.hex(colors.muted)('> ')}${this.callbackInput.render(Math.max(1, contentWidth - 2))[0] ?? ''}`,
      );
    }
    if (phase.error)
      body.push(...wrapTextWithAnsi(paintStatus(phase.error, 'error'), contentWidth));
    if (this.status && this.status.tone === 'muted') {
      body.push(...wrapTextWithAnsi(paintStatus(this.status.text, 'muted'), contentWidth));
    }
    body.push(
      '',
      chalk.hex(colors.muted)(
        phase.submitting ? 'Completing authorization…' : 'Waiting for authorization…',
      ),
    );
    return layout.render(
      { title: `Authorize ${describeMcpAuthTarget(phase.auth.target)}`, body },
      phase.error ? 'error' : 'signal',
    );
  }

  private selectedRow(): McpServerRow | undefined {
    return this.orderedRows()[this.selectedIndex];
  }

  /** Rows in rendered (section) order, which is the selection order. */
  private orderedRows(): McpServerRow[] {
    return MCP_SERVER_SECTIONS.flatMap(({ section }) =>
      this.rows.filter((row) => row.section === section),
    );
  }

  private move(delta: number): void {
    const count = this.rows.length;
    this.selectedIndex = count ? Math.max(0, Math.min(count - 1, this.selectedIndex + delta)) : 0;
    this.status = undefined;
    this.requestRender();
  }

  private async authorize(force: boolean): Promise<void> {
    const row = this.selectedRow();
    if (!row) return;
    const auth = row.auth;
    const label = auth ? describeMcpAuthTarget(auth.target) : sanitizeTerminalText(row.name);
    if (!auth || auth.authState === 'not_required') {
      this.setStatus(`${label} doesn't use OAuth authorization.`, 'muted');
      return;
    }
    if (auth.authState === 'static') {
      this.setStatus(describeMcpAuthError('MCP_OAUTH_STATIC_AUTHORIZATION'), 'muted');
      return;
    }
    this.phase = { kind: 'busy', message: `Starting authorization for ${label}…` };
    this.status = undefined;
    this.requestRender();
    try {
      const result = await this.options.auth.startMcpAuth(
        auth.target,
        force ? { force: true } : undefined,
      );
      if (this.disposed) {
        if (result.status === 'pending') {
          await this.options.auth.cancelMcpAuth(result.attemptId).catch(() => undefined);
        }
        return;
      }
      this.phase = { kind: 'list' };
      if (result.status === 'already_authorized') {
        this.setStatus(`${label} is already authorized. Press R to reauthorize.`, 'success');
        return;
      }
      if (result.status !== 'pending') {
        this.setStatus(
          `Couldn't authorize ${label}: ${describeMcpAuthError(result.errorCode)}`,
          'error',
        );
        return;
      }
      const attempt: PendingAttempt = {
        attemptId: result.attemptId,
        authUrl: result.authUrl,
        ...(result.confirmation ? { confirmation: result.confirmation } : {}),
      };
      if (!isSafeMcpAuthorizationUrl(result.authUrl)) {
        await this.options.auth.cancelMcpAuth(result.attemptId).catch(() => undefined);
        this.setStatus(
          `The sign-in page for ${label} is not an HTTPS address, so it was not opened.`,
          'error',
        );
        return;
      }
      if (result.requiresConfirmation) {
        this.phase = { kind: 'confirm', auth, attempt };
        this.requestRender();
        return;
      }
      await this.beginWaiting(auth, attempt);
    } catch (error) {
      if (this.disposed) return;
      this.phase = { kind: 'list' };
      this.setStatus(authFailure(error, `Couldn't authorize ${label}.`), 'error');
    }
  }

  private async beginWaiting(auth: TuiMcpAuthStateView, attempt: PendingAttempt): Promise<void> {
    const manual = this.options.browserMode === 'manual';
    this.phase = {
      kind: 'waiting',
      auth,
      attempt,
      manual,
      browserFailed: false,
      submitting: false,
    };
    this.status = undefined;
    this.callbackInput.setValue('');
    this.schedulePoll();
    this.requestRender();
    if (manual) return;
    try {
      await this.options.openExternalTarget(attempt.authUrl);
    } catch {
      const phase = this.phase;
      if (this.disposed || phase.kind !== 'waiting' || phase.attempt !== attempt) return;
      this.phase = { ...phase, manual: true, browserFailed: true };
      this.requestRender();
    }
  }

  private async submitCallback(value: string): Promise<void> {
    const phase = this.phase;
    const callbackUrl = value.trim();
    if (phase.kind !== 'waiting' || phase.submitting || !callbackUrl) return;
    const pending = { ...phase, error: undefined };
    this.phase = { ...pending, submitting: true };
    this.requestRender();
    let outcome: TuiMcpAuthOutcome | undefined;
    let failure: string | undefined;
    try {
      outcome = await this.options.auth.completeMcpAuth(phase.attempt.attemptId, callbackUrl);
    } catch (error) {
      // The pasted address carries the authorization code; never echo Runtime diagnostics.
      const code = mcpAuthErrorCode(error);
      failure = code
        ? `${describeMcpAuthError(code)} Paste the full address again.`
        : "Couldn't complete authorization. Check the pasted address and retry.";
    }
    const current = this.phase;
    if (this.disposed || current.kind !== 'waiting' || current.attempt !== phase.attempt) return;
    this.callbackInput.setValue('');
    const resolution = outcome ? resolveMcpAuthCompletion(outcome) : undefined;
    if (!outcome || resolution?.status === 'pending') {
      this.phase = {
        ...pending,
        submitting: false,
        error: failure ?? describeRejectedMcpAuthRedirect(outcome?.errorCode),
      };
      this.requestRender();
      return;
    }
    this.replaceRowAuth(outcome.state);
    if (resolution) this.finish(phase.auth, resolution);
  }

  private async cancelAttempt(): Promise<void> {
    const phase = this.phase;
    if (phase.kind !== 'confirm' && phase.kind !== 'waiting') return;
    this.stopPolling();
    this.phase = { kind: 'list' };
    this.setStatus('Authorization cancelled.', 'warning');
    try {
      await this.options.auth.cancelMcpAuth(phase.attempt.attemptId);
    } catch (error) {
      if (!this.disposed) {
        this.setStatus(authFailure(error, "Couldn't cancel authorization."), 'error');
      }
    }
    await this.refreshAuthStates();
  }

  private async disconnect(): Promise<void> {
    const auth = this.selectedRow()?.auth;
    if (!auth || !mcpAuthCanDisconnect(auth.authState)) {
      this.setStatus('Nothing to disconnect: this server has no stored authorization.', 'muted');
      return;
    }
    const label = describeMcpAuthTarget(auth.target);
    this.phase = { kind: 'busy', message: `Disconnecting ${label}…` };
    this.requestRender();
    try {
      const result = await this.options.auth.clearMcpAuth(auth.target);
      if (this.disposed) return;
      this.replaceRowAuth(result.state);
      this.phase = { kind: 'list' };
      this.setStatus(
        `${label} disconnected.${result.revoked ? ' The authorization server revoked the token.' : ''}`,
        'success',
      );
    } catch (error) {
      if (this.disposed) return;
      this.phase = { kind: 'list' };
      this.setStatus(authFailure(error, `Couldn't disconnect ${label}.`), 'error');
    }
  }

  private async refresh(): Promise<void> {
    this.phase = { kind: 'busy', message: 'Refreshing MCP servers…' };
    this.requestRender();
    try {
      const content = await this.options.reload();
      if (this.disposed) return;
      this.setContent(content);
      this.phase = { kind: 'list' };
      this.setStatus('MCP servers refreshed.', 'muted');
    } catch (error) {
      if (this.disposed) return;
      this.phase = { kind: 'list' };
      this.setStatus(
        formatTuiActionFailure(error, {
          summary: "Couldn't refresh MCP servers.",
          nextStep: 'Retry with Ctrl+R.',
        }),
        'error',
      );
    }
  }

  private async refreshAuthStates(): Promise<void> {
    try {
      const states = await this.options.loadAuthStates();
      if (this.disposed) return;
      for (const state of states) this.replaceRowAuth(state);
      this.requestRender();
    } catch {
      // Best effort: rows keep the state reported by the last action or event.
    }
  }

  private schedulePoll(): void {
    this.stopPolling();
    this.pollTimer = setTimeout(() => {
      void this.poll();
    }, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async poll(): Promise<void> {
    this.pollTimer = undefined;
    const phase = this.phase;
    if (this.disposed || phase.kind !== 'waiting') return;
    try {
      const states = await this.options.loadAuthStates();
      if (this.disposed) return;
      for (const state of states) this.replaceRowAuth(state);
      const current = states.find((state) => sameMcpAuthTarget(state.target, phase.auth.target));
      const latest = this.phase;
      if (current && latest.kind === 'waiting' && latest.attempt === phase.attempt) {
        const resolution = resolveMcpAuthAttempt(current, phase.attempt.attemptId);
        if (resolution.status !== 'pending' && !latest.submitting) {
          this.finish(phase.auth, resolution);
        }
      }
    } catch {
      // A failed poll is retried; the event stream may still deliver completion.
    }
    const next = this.phase;
    if (!this.disposed && next.kind === 'waiting' && next.attempt === phase.attempt) {
      this.schedulePoll();
    }
    this.requestRender();
  }

  private finish(auth: TuiMcpAuthStateView, resolution: McpAuthAttemptResolution): void {
    this.stopPolling();
    this.phase = { kind: 'list' };
    const label = describeMcpAuthTarget(auth.target);
    if (resolution.status === 'authorized') {
      this.setStatus(`${label} authorized.`, 'success');
    } else if (resolution.status === 'failed') {
      this.setStatus(
        `Couldn't authorize ${label}: ${describeMcpAuthError(resolution.errorCode)}`,
        'error',
      );
    } else {
      this.setStatus(
        `Authorization for ${label} was not completed. Press Enter to retry.`,
        'warning',
      );
    }
  }

  private updateRowState(
    target: McpAuthTargetLike,
    authState: TuiMcpAuthState,
    reason: string | undefined,
  ): void {
    this.rows = this.rows.map((row) => {
      if (!row.auth || !sameMcpAuthTarget(row.auth.target, target)) return row;
      return { ...row, auth: { ...row.auth, authState, reason } };
    });
  }

  private replaceRowAuth(state: TuiMcpAuthStateView): void {
    this.rows = this.rows.map((row) =>
      row.auth && sameMcpAuthTarget(row.auth.target, state.target) ? { ...row, auth: state } : row,
    );
  }

  private setContent(content: TuiMcpManagerContent): void {
    const selected = this.selectedRow();
    this.rows = buildMcpServerRows(content.servers, content.authStates, this.options.filter);
    this.authError = content.authError;
    const ordered = this.orderedRows();
    const kept = selected
      ? ordered.findIndex(
          (row) =>
            row.section === selected.section &&
            row.name === selected.name &&
            pluginLabel(row) === pluginLabel(selected),
        )
      : -1;
    this.selectedIndex = Math.max(0, kept);
  }

  private async copyAuthUrl(url: string): Promise<void> {
    if (!this.options.copyText) return;
    try {
      await this.options.copyText(url);
      if (!this.disposed) this.setStatus('Sign-in link copied.', 'muted');
    } catch {
      if (!this.disposed) this.setStatus("Couldn't copy the link. Select it manually.", 'muted');
    }
  }

  private setStatus(text: string, tone: StatusTone): void {
    this.status = { text, tone };
    this.requestRender();
  }

  private requestRender(): void {
    if (!this.disposed) this.options.requestRender();
  }
}

function authFailure(error: unknown, summary: string): string {
  const code = mcpAuthErrorCode(error);
  return code
    ? `${summary.replace(/\.$/u, ':')} ${describeMcpAuthError(code)}`
    : formatTuiActionFailure(error, { summary, nextStep: 'Retry or press Ctrl+R to refresh.' });
}

function renderRow(
  row: McpServerRow,
  selected: boolean,
  labelWidth: number,
  width: number,
): string[] {
  const cursor = selected ? chalk.bold.hex(colors.signal)('›') : ' ';
  const name = truncateToWidth(sanitizeTerminalText(row.name), labelWidth, '…');
  const paddedName = `${name}${' '.repeat(Math.max(0, labelWidth - visibleWidth(name)))}`;
  const label = selected
    ? chalk.bold.hex(colors.signal)(paddedName)
    : chalk.bold.hex(colors.text)(paddedName);
  const detail = rowDetail(row);
  return [
    truncateToWidth(`${cursor} ${label}  ${rowValue(row)}`, width, '…'),
    ...(detail
      ? [
          truncateToWidth(
            `    ${chalk.hex(detail.error ? colors.error : colors.muted)(detail.text)}`,
            width,
            '…',
          ),
        ]
      : []),
  ];
}

function rowValue(row: McpServerRow): string {
  const parts: string[] = [];
  const catalog = row.catalog;
  if (catalog) {
    const marker =
      catalog.builtin && catalog.status === 'unavailable' ? '○' : statusMarker(catalog.status);
    const where = catalog.builtin
      ? `${catalog.managed ? 'runtime-managed' : 'built-in'} · ${catalog.tools.length} ${
          catalog.tools.length === 1 ? 'tool' : 'tools'
        }`
      : catalog.transport;
    parts.push(
      paintCatalog(`${marker} ${catalog.status} · ${sanitizeTerminalText(where)}`, catalog.status),
    );
  }
  if (row.auth) {
    const plugin = pluginLabel(row);
    parts.push(
      paintAuth(
        `${authMarker(row.auth.authState)} ${mcpAuthStateLabel(row.auth)}`,
        row.auth.authState,
      ),
    );
    if (plugin) parts.push(chalk.hex(colors.muted)(sanitizeTerminalText(plugin)));
  }
  return parts.join(chalk.hex(colors.dim)(' · '));
}

/** Connection error first, then the auth problem, the description, and finally the origin. */
function rowDetail(
  row: McpServerRow,
): { readonly text: string; readonly error: boolean } | undefined {
  const catalog = row.catalog;
  if (catalog?.builtin && catalog.tools.length > 0) {
    return {
      text: sanitizeTerminalText(catalog.tools.map((tool) => tool.name).join(' · ')),
      error: false,
    };
  }
  if (catalog?.error) return { text: catalog.error, error: true };
  const problem = row.auth ? mcpAuthProblemDetail(row.auth) : undefined;
  if (problem) return { text: problem, error: row.auth?.authState === 'failed' };
  if (catalog?.description) {
    return { text: sanitizeTerminalText(catalog.description).replace(/\s+/gu, ' '), error: false };
  }
  const origin = row.auth?.serverOrigin;
  return origin ? { text: sanitizeTerminalText(origin), error: false } : undefined;
}

function statusMarker(status: McpCatalogStatus): string {
  if (status === 'available') return '●';
  if (status === 'error' || status === 'unavailable') return '!';
  if (status === 'disabled') return '○';
  return '◆';
}

function paintCatalog(value: string, status: McpCatalogStatus): string {
  if (status === 'available') return chalk.hex(colors.success)(value);
  if (status === 'error' || status === 'unavailable') return chalk.hex(colors.error)(value);
  if (status === 'configured') return chalk.hex(colors.signal)(value);
  return chalk.hex(colors.text)(value);
}

function authMarker(state: TuiMcpAuthState): string {
  if (state === 'authorized') return '✓';
  if (mcpAuthNeedsAttention(state) || state === 'failed') return '!';
  if (state === 'authorizing') return '…';
  return '·';
}

function paintAuth(value: string, state: TuiMcpAuthState): string {
  if (state === 'authorized') return chalk.hex(colors.success)(value);
  if (mcpAuthNeedsAttention(state) || state === 'failed') return chalk.hex(colors.warning)(value);
  return chalk.hex(colors.muted)(value);
}

function paintStatus(text: string, tone: StatusTone): string {
  const color =
    tone === 'success'
      ? colors.success
      : tone === 'error'
        ? colors.error
        : tone === 'warning'
          ? colors.warning
          : colors.muted;
  return chalk.hex(color)(sanitizeTerminalText(text));
}

function clampScroll(offset: number, selectedLine: number, height: number, total: number): number {
  let next = offset;
  // Keep the selected row and its detail line in view; show its section title when possible.
  if (selectedLine - 1 < next) next = Math.max(0, selectedLine - 1);
  if (selectedLine + 2 > next + height) next = selectedLine + 2 - height;
  return Math.max(0, Math.min(next, Math.max(0, total - height)));
}
