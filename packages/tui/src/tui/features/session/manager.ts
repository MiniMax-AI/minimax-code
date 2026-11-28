import {
  panelLayout,
  renderPanelFrame,
  renderPanelHeader,
  renderPanelFooter,
  renderPanelRow as frameRow,
  renderPanelDivider as frameDivider,
  renderPanelBottom as frameBottom,
} from '../../widgets/panel-frame.js';
// Keyboard-first durable Session management over the Runtime projection.
import { formatProductTime } from '@mavis/shared/product-time';
import { getKeybindings, Key, matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import { Input } from '../../widgets/input.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import type { TuiSession } from '../../../runtime/port.js';
import {
  isTuiDelegatedSession,
  isTuiInternalSubagentSession,
} from '../../../runtime/delegation.js';
import { isSurfaceableHiddenBranch } from '../../../runtime/session-visibility.js';
import { workspacePathKey } from '../../../runtime/workspace-path.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';

type SessionManagerView = 'active' | 'archived';
type SessionManagerScope = 'workspace' | 'all';
type SessionManagerMode = 'list' | 'rename' | 'confirm-archive';
type SessionRecencySection = 'today' | 'yesterday' | 'previous-7-days' | 'older';
const SESSION_LIST_VISIBLE_LIMIT = 10;
const SESSION_SEARCH_DEBOUNCE_MS = 200;

export interface TuiSessionManagerOptions {
  sessions: readonly TuiSession[];
  hasMore?: boolean;
  activeSessionId?: string;
  workspaceDir: string;
  initialQuery?: string;
  initialRenameSessionId?: string;
  onLoadMore?(): Promise<{
    sessions: readonly TuiSession[];
    hasMore: boolean;
  }>;
  onScopeChange?(scope: SessionManagerScope): Promise<{
    sessions: readonly TuiSession[];
    hasMore: boolean;
  }>;
  onSelect(sessionId: string, archived: boolean): Promise<void> | void;
  onNew(): Promise<void> | void;
  onRename(sessionId: string, title: string): Promise<TuiSession>;
  onSetArchived(sessionId: string, archived: boolean): Promise<void> | void;
  onCancel(): void;
  requestRender(): void;
  now?: () => number;
  /** Available interaction rows; re-read on every render for live resize. */
  maxRows?: number | (() => number);
}

export class TuiSessionManager implements Component, Focusable {
  private sessions: TuiSession[];
  private readonly searchInput = new Input();
  private readonly actionInput = new Input();
  private readonly now: () => number;
  private activeSessionId?: string;
  private view: SessionManagerView = 'active';
  private scope: SessionManagerScope = 'workspace';
  private mode: SessionManagerMode = 'list';
  private selectedIndex = 0;
  private selectedSessionId?: string;
  private actionTargetId?: string;
  private busy = false;
  private hasMore: boolean;
  private loadingMore = false;
  private pageLoad?: Promise<boolean>;
  private searchLoadTimer?: ReturnType<typeof setTimeout>;
  private status?: { tone: 'info' | 'error'; text: string };
  private _focused = false;
  private disposed = false;

  constructor(private readonly options: TuiSessionManagerOptions) {
    this.sessions = sortSessions(options.sessions);
    this.hasMore = Boolean(options.hasMore && options.onLoadMore);
    this.now = options.now ?? Date.now;
    this.activeSessionId = options.activeSessionId;
    this.searchInput.setValue(options.initialQuery?.trim() ?? '');
    this.searchInput.onSubmit = () => this.openSelected();
    this.actionInput.onSubmit = (value) => this.submitActionInput(value);
    this.actionInput.onEscape = () => this.exitActionMode();
    this.clampSelection();
    if (this.searchInput.getValue()) this.scheduleRemainingSearchLoad();
    if (options.initialRenameSessionId) {
      this.startRename(options.initialRenameSessionId);
    }
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncInputFocus();
  }

  setSessions(sessions: readonly TuiSession[]): void {
    if (this.disposed) return;
    this.sessions = sortSessions(sessions);
    this.clampSelection();
    this.requestRender();
  }

  /** Select a visible Session and open its inline rename editor. */
  startRename(sessionId: string): boolean {
    const index = this.visibleSessions().findIndex((session) => session.sessionId === sessionId);
    if (index < 0) {
      this.status = {
        tone: 'error',
        text: 'The current Session is not available here. Use /rename <title> to rename it directly.',
      };
      this.requestRender();
      return false;
    }
    this.selectedIndex = index;
    this.selectedSessionId = sessionId;
    this.enterTextMode('rename');
    return true;
  }

  handleInput(data: string): void {
    if (this.busy || this.disposed) return;
    if (this.mode === 'rename') {
      this.actionInput.handleInput(data);
      this.requestRender();
      return;
    }
    if (this.mode === 'confirm-archive') {
      if (matchesKey(data, Key.enter)) this.confirmArchive();
      else if (getKeybindings().matches(data, 'tui.select.cancel')) this.exitActionMode();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.moveSelection(-SESSION_LIST_VISIBLE_LIMIT);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.moveSelection(SESSION_LIST_VISIBLE_LIMIT);
      return;
    }
    if (matchesKey(data, Key.ctrl('l'))) {
      this.loadMore();
      return;
    }
    const searchActive = this.searchInput.getValue().length > 0;
    if (!searchActive && matchesKey(data, Key.ctrl('a'))) {
      void this.changeScope();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.view = this.view === 'active' ? 'archived' : 'active';
      this.resetSelection();
      return;
    }
    if (matchesKey(data, Key.ctrl('n'))) {
      void this.options.onNew();
      return;
    }
    if (matchesKey(data, Key.ctrl('r'))) {
      this.enterTextMode('rename');
      return;
    }
    if (!searchActive && matchesKey(data, Key.ctrl('d'))) {
      this.toggleSelectedArchived();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.openSelected();
      return;
    }
    if (getKeybindings().matches(data, 'tui.select.cancel')) {
      if (this.searchInput.getValue()) {
        this.searchInput.setValue('');
        this.resetSelection();
      } else {
        this.options.onCancel();
      }
      return;
    }

    const previousQuery = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (this.searchInput.getValue() !== previousQuery) {
      this.resetSelection();
      this.scheduleRemainingSearchLoad();
    } else this.requestRender();
  }

  invalidate(): void {
    this.searchInput.invalidate();
    this.actionInput.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    if (this.searchLoadTimer) clearTimeout(this.searchLoadTimer);
    this.searchLoadTimer = undefined;
    this.searchInput.focused = false;
    this.actionInput.focused = false;
  }

  readonly fullscreenViewport = true;
  readonly handlesViewportKeys = true;

  render(width: number): string[] {
    return this.renderViewport(width, this.currentMaxRows() ?? Infinity);
  }

  renderViewport(width: number, height: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth === 0) return [];
    const maxRows = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : undefined;
    if (this.mode === 'rename') {
      return this.fitLines(
        this.fitToRows(this.renderTextMode(safeWidth, maxRows), maxRows),
        safeWidth,
      );
    }
    if (this.mode === 'confirm-archive') {
      return this.fitLines(
        this.fitToRows(this.renderArchiveConfirmation(safeWidth, maxRows), maxRows),
        safeWidth,
      );
    }
    return this.fitLines(this.fitToRows(this.renderList(safeWidth, maxRows), maxRows), safeWidth);
  }

  private renderList(width: number, maxRows?: number): string[] {
    const visible = this.visibleSessions();
    this.clampSelection(visible);
    const selected = this.selectedSession(visible);
    const scoped = this.scopedSessions();
    const activeCount = scoped.filter((session) => !session.archived).length;
    const archivedCount = scoped.length - activeCount;
    const viewLabel = this.view === 'active' ? 'Recent' : 'Archived';
    const scopeLabel = this.scope === 'workspace' ? 'This workspace' : 'All sessions';
    const searchLine = this.searchInput.render(Math.max(1, width - 12))[0] ?? '';
    if (maxRows !== undefined && maxRows <= 8) {
      return this.renderInlineCompactList(width, maxRows, visible, viewLabel, searchLine);
    }
    const compact = width < 40 || (maxRows !== undefined && maxRows <= 18);
    const narrow = width < 40;
    const showSecondaryFooter = !compact && !narrow;
    const listPosition = visible.length > 1 ? ` · ${this.selectedIndex + 1}/${visible.length}` : '';
    const primaryFooter = `${
      narrow
        ? width < 30
          ? '↑↓ · Enter · Esc · Ctrl+A all'
          : `↑↓ · Enter · Esc · Ctrl+A ${this.scope === 'workspace' ? 'all' : 'current'}${
              this.hasMore ? ' · Ctrl+L' : ''
            }`
        : compact
          ? `↑↓ · Enter ${this.view === 'active' ? 'switch' : 'restore'} · Ctrl+A ${
              this.scope === 'workspace' ? 'all' : 'current'
            }${this.hasMore ? ' · Ctrl+L more' : ''} · Tab ${
              this.view === 'active' ? 'archived' : 'recent'
            } · Esc`
          : `↑↓ move · Enter ${this.view === 'active' ? 'switch' : 'restore'} · Tab ${
              this.view === 'active' ? 'archived' : 'recent'
            }`
    }${listPosition}`;
    const secondaryFooter = !showSecondaryFooter
      ? undefined
      : `Ctrl+A ${this.scope === 'workspace' ? 'all' : 'current'} · Ctrl+N new · Ctrl+R rename · Ctrl+D ${
          this.view === 'active' ? 'archive' : 'restore'
        }${this.hasMore ? ' · More sessions available · Ctrl+L more' : ''} · Esc close`;
    const footerRows = renderPanelFooter(
      [primaryFooter, ...(secondaryFooter ? [secondaryFooter] : [])],
      Math.max(1, width - 4),
    );
    const lines: string[] = [
      renderPanelHeader(
        narrow ? `Sessions · ${viewLabel}` : 'Sessions',
        `${viewLabel} · ${scopeLabel}`,
        width,
      ),
      frameRow(
        chalk.hex(colors.muted)(
          narrow
            ? `${this.scope === 'workspace' ? 'Workspace' : scopeLabel} · ${visible.length} ${viewLabel.toLowerCase()}`
            : `${activeCount} active · ${archivedCount} archived`,
        ),
        width,
      ),
    ];
    if (!compact && (this.loadingMore || (this.searchInput.getValue().trim() && this.hasMore))) {
      lines.push(
        frameRow(
          chalk.hex(colors.accent)(
            this.searchInput.getValue().trim()
              ? 'Searching saved sessions…'
              : 'Loading more sessions…',
          ),
          width,
        ),
      );
    }
    lines.push(frameRow(`${chalk.hex(colors.muted)('Search')} ${searchLine}`, width));
    if (!compact) {
      lines.push(
        frameRow(
          chalk.hex(colors.dim)('Filter title, ID, workspace, model, status, or branch'),
          width,
        ),
      );
    }

    if (visible.length === 0) {
      lines.push(
        frameRow(
          chalk.hex(colors.warning)(
            this.searchInput.getValue()
              ? this.loadingMore || this.hasMore
                ? 'Searching saved sessions…'
                : 'No matching sessions.'
              : `No ${viewLabel.toLowerCase()} sessions in this workspace.`,
          ),
          width,
        ),
      );
    } else {
      const reservedFooterRows = footerRows.length + 2;
      const statusRows = this.status ? 1 : 0;
      const detailRows = this.detailRowBudget(width, maxRows);
      const showSections =
        !this.searchInput.getValue().trim() &&
        width >= 48 &&
        (maxRows === undefined || maxRows >= 20);
      const listBudget = Math.max(
        1,
        (maxRows ?? Number.POSITIVE_INFINITY) -
          lines.length -
          reservedFooterRows -
          statusRows -
          detailRows,
      );
      const window = this.sessionWindow(visible, listBudget, showSections);
      lines.push(...this.renderSessionWindow(window.sessions, width, listBudget, showSections));
    }

    const detailRowBudget = this.detailRowBudget(width, maxRows);
    if (selected && detailRowBudget > 0) {
      lines.push(
        frameDivider(width),
        frameRow(
          composeLine(
            chalk.bold.hex(colors.text)(
              truncateToWidth(
                sanitizeTerminalText(selected.title?.trim() || 'Untitled session'),
                Math.max(1, width - 28),
                '…',
              ),
            ),
            chalk.hex(colors.accent)(
              selected.sessionId === this.activeSessionId ? '● current' : '○ selected',
            ),
            Math.max(1, width - 4),
          ),
          width,
        ),
      );
      if (detailRowBudget >= 3) {
        lines.push(
          frameRow(
            chalk.hex(colors.muted)(
              `ID ${sanitizeTerminalText(selected.sessionId)}${
                isTuiDelegatedSession(selected)
                  ? ` · Sub-agent · Parent ${sanitizeTerminalText(selected.parentSessionId)}`
                  : selected.parentSessionId
                    ? ' · child Session'
                    : ''
              }`,
            ),
            width,
          ),
        );
      }
      if (detailRowBudget >= 4) {
        lines.push(
          frameRow(
            chalk.hex(colors.muted)(
              `Path ${truncatePath(
                shortenHome(sanitizeTerminalText(selected.workspaceDir ?? 'Unknown workspace')),
                Math.max(1, width - 10),
              )}`,
            ),
            width,
          ),
        );
      }
      if (detailRowBudget >= 5) {
        const model = formatSessionModel(selected);
        const mode = selected.interactionMode === 'plan' ? 'Plan' : undefined;
        const identity = [formatSessionKind(selected), model, mode].filter(Boolean).join(' · ');
        if (identity) {
          lines.push(frameRow(chalk.hex(colors.muted)(identity), width));
        }
      }
      if (detailRowBudget >= 6) {
        const updated = formatSessionTime(selected.updatedAt, this.now());
        const created = formatSessionTime(selected.createdAt, this.now());
        const timestamps = [
          updated ? `Updated ${updated}` : undefined,
          created ? `Created ${created}` : undefined,
        ]
          .filter(Boolean)
          .join(' · ');
        if (timestamps) lines.push(frameRow(chalk.hex(colors.dim)(timestamps), width));
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
      ...footerRows.map((line) => frameRow(line, width)),
      frameBottom(width),
    );
    return lines;
  }

  private renderInlineCompactList(
    width: number,
    maxRows: number,
    visible: readonly TuiSession[],
    viewLabel: string,
    searchLine: string,
  ): string[] {
    this.clampSelection(visible);
    const selected = this.selectedSession(visible);
    const query = sanitizeTerminalText(this.searchInput.getValue().trim());
    const header = query ? `Sessions · /${query}` : `Sessions · ${viewLabel}`;
    const emptyMessage = query
      ? this.loadingMore || this.hasMore
        ? 'Searching saved sessions…'
        : 'No matching sessions.'
      : `No ${viewLabel.toLowerCase()} sessions in this workspace.`;
    const selectedLine = selected
      ? this.renderSessionLine(selected, true, width - 4)
      : chalk.hex(colors.warning)(emptyMessage);

    const layout = panelLayout(width, maxRows, '↑↓ · Enter · Tab · Ctrl+A · Esc');
    const content = [
      ...(layout.bodyHeight >= 2 ? [`${chalk.hex(colors.muted)('Search')} ${searchLine}`] : []),
      selected ? this.renderSessionLine(selected, true, layout.contentWidth) : selectedLine,
    ];
    return layout.render({ title: header, body: content });
  }

  private detailRowBudget(width: number, maxRows?: number): number {
    if (width < 30 || (maxRows !== undefined && maxRows <= 18)) return 0;
    if (width < 60) return 4;
    return 6;
  }

  private renderSessionLine(session: TuiSession, selected: boolean, width: number): string {
    const isCurrent = session.sessionId === this.activeSessionId;
    const prefix = selected ? chalk.bold.hex(colors.signal)('› ') : chalk.hex(colors.dim)('  ');
    const currentMark = isCurrent ? chalk.hex(colors.success)('● ') : '';
    const title = sanitizeTerminalText(session.title?.trim() || 'Untitled session');
    const delegated = isTuiDelegatedSession(session);
    const identity = delegated
      ? `↳ Sub-agent${session.agentName ? ` · ${sanitizeTerminalText(session.agentName)}` : ''} · ${title}`
      : title;
    const status = formatSessionStatus(session.status);
    const suffix = [
      formatSessionTime(session.updatedAt, this.now()),
      isCurrent ? 'current' : undefined,
      status,
    ]
      .filter((value): value is string => Boolean(value))
      .join(' · ');
    const titleBudget = Math.max(1, width - visibleWidth(prefix) - visibleWidth(currentMark) - 4);
    const line = `${prefix}${currentMark}${truncateToWidth(identity, titleBudget, '…')}`;
    return composeLine(
      selected ? chalk.bold.hex(colors.signal)(line) : line,
      chalk.hex(colors.muted)(suffix),
      width,
    );
  }

  private sessionWindow(
    visible: readonly TuiSession[],
    rowBudget: number,
    showSections: boolean,
  ): { readonly sessions: readonly TuiSession[]; readonly start: number } {
    if (visible.length === 0) return { sessions: [], start: 0 };
    let count = Math.max(1, Math.min(SESSION_LIST_VISIBLE_LIMIT, rowBudget, visible.length));
    for (;;) {
      const start = Math.max(
        0,
        Math.min(this.selectedIndex - Math.floor(count / 2), Math.max(0, visible.length - count)),
      );
      const sessions = visible.slice(start, start + count);
      if (count === 1 || this.sessionWindowRowCount(sessions, showSections) <= rowBudget) {
        return { sessions, start };
      }
      count -= 1;
    }
  }

  private sessionWindowRowCount(sessions: readonly TuiSession[], showSections: boolean): number {
    if (!showSections) return sessions.length;
    let rows = 0;
    let section: SessionRecencySection | undefined;
    for (const session of sessions) {
      const nextSection = this.sessionSection(session);
      if (nextSection !== section) {
        rows += 1;
        section = nextSection;
      }
      rows += 1;
    }
    return rows;
  }

  private renderSessionWindow(
    sessions: readonly TuiSession[],
    width: number,
    rowBudget: number,
    showSections: boolean,
  ): string[] {
    const rows: string[] = [];
    let section: SessionRecencySection | undefined;
    for (const session of sessions) {
      const nextSection = this.sessionSection(session);
      if (showSections && nextSection !== section && rows.length < rowBudget - 1) {
        rows.push(frameRow(chalk.bold.hex(colors.text)(sessionSectionLabel(nextSection)), width));
      }
      section = nextSection;
      if (rows.length >= rowBudget) break;
      rows.push(
        frameRow(
          this.renderSessionLine(session, session.sessionId === this.selectedSessionId, width - 4),
          width,
        ),
      );
    }
    return rows;
  }

  private sessionSection(session: TuiSession): SessionRecencySection {
    const parent = session.parentSessionId
      ? this.sessions.find((candidate) => candidate.sessionId === session.parentSessionId)
      : undefined;
    return getSessionRecencySection(
      toTimestamp(parent?.updatedAt ?? session.updatedAt),
      this.now(),
    );
  }

  private renderTextMode(width: number, height?: number): string[] {
    const layout = panelLayout(width, height, 'Ctrl+U clear · Enter save · Esc cancel');
    return layout.render({
      title: 'Sessions / Rename session',
      body: [
        this.actionInput.render(Math.max(1, layout.contentWidth))[0] ?? '',
        ...(this.status
          ? [
              chalk.hex(this.status.tone === 'error' ? colors.error : colors.accent)(
                this.status.text,
              ),
            ]
          : []),
      ],
    });
  }

  private renderArchiveConfirmation(width: number, height?: number): string[] {
    const target = this.findActionTarget();
    return renderPanelFrame(
      {
        title: 'Archive session?',
        body: [
          sanitizeTerminalText(target?.title?.trim() || target?.sessionId || 'Unknown session'),
          chalk.hex(colors.muted)('History stays available under Archived.'),
        ],
        footer: 'Enter archive · Esc cancel',
      },
      width,
      height,
      'warning',
    );
  }

  private visibleSessions(): TuiSession[] {
    const queryTokens = this.searchInput
      .getValue()
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/u)
      .filter(Boolean);
    return this.scopedSessions().filter((session) => {
      if (Boolean(session.archived) !== (this.view === 'archived')) return false;
      if (queryTokens.length === 0) return true;
      const fields = sessionSearchFields(session);
      return queryTokens.every((token) => matchesSessionQueryToken(fields, token));
    });
  }

  private scopedSessions(): TuiSession[] {
    const visibleCatalog = this.sessions.filter(
      (session) =>
        !isTuiInternalSubagentSession(session) &&
        (session.visibility !== 'hidden' || isSurfaceableHiddenBranch(session)),
    );
    if (this.scope === 'all') return visibleCatalog;
    const workspace = workspacePathKey(this.options.workspaceDir);
    return visibleCatalog.filter((session) => workspacePathKey(session.workspaceDir) === workspace);
  }

  private moveSelection(delta: number): void {
    const sessions = this.visibleSessions();
    if (sessions.length === 0) return;
    this.clampSelection(sessions);
    if (delta > 0 && this.selectedIndex === sessions.length - 1 && this.hasMore) {
      this.loadMore();
      return;
    }
    this.selectedIndex =
      (this.selectedIndex +
        delta +
        sessions.length * Math.ceil(Math.abs(delta) / sessions.length)) %
      sessions.length;
    this.selectedSessionId = sessions[this.selectedIndex]?.sessionId;
    this.status = undefined;
    this.requestRender();
  }

  private loadMore(): void {
    void this.loadNextPage(true);
  }

  private async changeScope(): Promise<void> {
    const nextScope = this.scope === 'workspace' ? 'all' : 'workspace';
    if (!this.options.onScopeChange) {
      this.scope = nextScope;
      this.resetSelection();
      return;
    }
    this.busy = true;
    this.status = {
      tone: 'info',
      text: nextScope === 'all' ? 'Loading all sessions…' : 'Loading this workspace…',
    };
    this.requestRender();
    try {
      if (this.pageLoad) await this.pageLoad;
      if (this.disposed) return;
      const page = await this.options.onScopeChange(nextScope);
      if (this.disposed) return;
      this.scope = nextScope;
      this.sessions = sortSessions(page.sessions);
      this.hasMore = Boolean(page.hasMore && this.options.onLoadMore);
      this.selectedIndex = 0;
      this.selectedSessionId = undefined;
      this.status = undefined;
      this.clampSelection();
      this.scheduleRemainingSearchLoad();
    } catch (error) {
      if (this.disposed) return;
      this.status = {
        tone: 'error',
        text: formatTuiActionFailure(error, {
          summary: "Couldn't change the session scope.",
          nextStep: 'Retry.',
          preservation: 'The current session list is unchanged.',
        }),
      };
    } finally {
      if (!this.disposed) {
        this.busy = false;
        this.requestRender();
      }
    }
  }

  private scheduleRemainingSearchLoad(): void {
    if (this.searchLoadTimer) clearTimeout(this.searchLoadTimer);
    this.searchLoadTimer = undefined;
    if (!this.searchInput.getValue().trim() || !this.hasMore) return;
    this.searchLoadTimer = setTimeout(() => {
      this.searchLoadTimer = undefined;
      this.loadRemainingForSearch();
    }, SESSION_SEARCH_DEBOUNCE_MS);
  }

  private loadRemainingForSearch(): void {
    if (!this.searchInput.getValue().trim() || !this.hasMore) return;
    void this.loadNextPage(false).then((loaded) => {
      if (!this.disposed && loaded) this.loadRemainingForSearch();
    });
  }

  private loadNextPage(announce: boolean): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.pageLoad) return this.pageLoad;
    if (!this.hasMore || !this.options.onLoadMore) return Promise.resolve(false);
    this.loadingMore = true;
    if (announce) this.status = undefined;
    this.requestRender();
    const pageLoad = this.options
      .onLoadMore()
      .then((page) => {
        if (this.disposed) return false;
        const previousSize = this.sessions.length;
        const previousScopedSize = this.scopedSessions().length;
        this.sessions = mergeSessions(this.sessions, page.sessions);
        this.hasMore = page.hasMore;
        const added = this.sessions.length - previousSize;
        const scopedAdded = this.scopedSessions().length - previousScopedSize;
        if (announce) {
          this.status = {
            tone: 'info',
            text:
              this.scope === 'workspace' && scopedAdded === 0
                ? page.hasMore
                  ? `${added} session${added === 1 ? '' : 's'} loaded · none in this workspace · Ctrl+A show all.`
                  : 'All sessions loaded · none new in this workspace.'
                : page.hasMore
                  ? `${scopedAdded} more session${scopedAdded === 1 ? '' : 's'}${
                      this.scope === 'workspace' ? ' in this workspace' : ''
                    } loaded.`
                  : 'All matching sessions loaded.',
          };
        }
        this.clampSelection();
        return true;
      })
      .catch((error: unknown) => {
        if (this.disposed) return false;
        this.status = {
          tone: 'error',
          text: formatTuiActionFailure(error, {
            summary: "Couldn't load more sessions.",
            nextStep: 'Retry.',
          }),
        };
        return false;
      })
      .finally(() => {
        if (this.pageLoad === pageLoad) this.pageLoad = undefined;
        if (!this.disposed) {
          this.loadingMore = false;
          this.requestRender();
        }
      });
    this.pageLoad = pageLoad;
    return pageLoad;
  }

  private resetSelection(): void {
    this.selectedIndex = 0;
    this.selectedSessionId = this.visibleSessions()[0]?.sessionId;
    this.status = undefined;
    this.requestRender();
  }

  private clampSelection(sessions: readonly TuiSession[] = this.visibleSessions()): void {
    if (sessions.length === 0) {
      this.selectedIndex = 0;
      this.selectedSessionId = undefined;
      return;
    }
    const anchoredIndex = this.selectedSessionId
      ? sessions.findIndex((session) => session.sessionId === this.selectedSessionId)
      : -1;
    this.selectedIndex =
      anchoredIndex >= 0
        ? anchoredIndex
        : Math.max(0, Math.min(this.selectedIndex, sessions.length - 1));
    this.selectedSessionId = sessions[this.selectedIndex]?.sessionId;
  }

  private selectedSession(
    sessions: readonly TuiSession[] = this.visibleSessions(),
  ): TuiSession | undefined {
    if (this.selectedSessionId) {
      const selected = sessions.find((session) => session.sessionId === this.selectedSessionId);
      if (selected) return selected;
    }
    return sessions[this.selectedIndex];
  }

  private openSelected(): void {
    const session = this.selectedSession();
    if (!session) return;
    void this.runAction(async () => {
      await this.options.onSelect(session.sessionId, Boolean(session.archived));
    });
  }

  private enterTextMode(mode: Extract<SessionManagerMode, 'rename'>): void {
    const session = this.selectedSession();
    if (!session) return;
    this.mode = mode;
    this.actionTargetId = session.sessionId;
    this.actionInput.setValue(session.title?.trim() ?? '');
    this.actionInput.moveCursorToEnd();
    this.status = undefined;
    this.syncInputFocus();
    this.requestRender();
  }

  private submitActionInput(value: string): void {
    const target = this.findActionTarget();
    if (!target) {
      this.exitActionMode();
      return;
    }
    if (this.mode === 'rename') {
      const title = value.trim();
      if (!title) {
        this.setStatus('Session title cannot be empty.', 'error');
        return;
      }
      if (title === (target.title?.trim() ?? '')) {
        this.exitActionMode(false);
        this.setStatus('Session title unchanged.', 'info');
        return;
      }
      void this.runAction(async () => {
        const renamed = await this.options.onRename(target.sessionId, title);
        if (this.disposed) return;
        this.replaceSession(renamed);
        this.exitActionMode(false);
        this.setStatus(`Renamed to ${sanitizeTerminalText(renamed.title ?? title)}.`, 'info');
      });
    }
  }

  private toggleSelectedArchived(): void {
    const target = this.selectedSession();
    if (!target) return;
    if (!target.archived) {
      this.mode = 'confirm-archive';
      this.actionTargetId = target.sessionId;
      this.status = undefined;
      this.syncInputFocus();
      this.requestRender();
      return;
    }
    void this.runAction(async () => {
      await this.options.onSetArchived(target.sessionId, false);
      if (this.disposed) return;
      this.replaceSession({ ...target, archived: false });
      this.clampSelection();
      this.setStatus('Session restored.', 'info');
    });
  }

  private confirmArchive(): void {
    const target = this.findActionTarget();
    if (!target) {
      this.exitActionMode();
      return;
    }
    void this.runAction(async () => {
      await this.options.onSetArchived(target.sessionId, true);
      if (this.disposed) return;
      this.replaceSession({ ...target, archived: true });
      if (this.activeSessionId === target.sessionId) this.activeSessionId = undefined;
      this.exitActionMode(false);
      this.clampSelection();
      this.setStatus('Session archived.', 'info');
    });
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.status = { tone: 'info', text: 'Working…' };
    this.requestRender();
    try {
      await action();
    } catch (error) {
      if (this.disposed) return;
      this.status = {
        tone: 'error',
        text: formatTuiActionFailure(error, {
          summary: 'Session changes were not saved.',
          nextStep: 'Retry.',
          preservation: 'The existing session is unchanged.',
        }),
      };
    } finally {
      if (!this.disposed) {
        this.busy = false;
        this.requestRender();
      }
    }
  }

  private exitActionMode(requestRender = true): void {
    this.mode = 'list';
    this.actionTargetId = undefined;
    this.actionInput.setValue('');
    this.syncInputFocus();
    if (requestRender) this.requestRender();
  }

  private findActionTarget(): TuiSession | undefined {
    return this.sessions.find((session) => session.sessionId === this.actionTargetId);
  }

  private replaceSession(session: TuiSession): void {
    this.sessions = sortSessions([
      session,
      ...this.sessions.filter((item) => item.sessionId !== session.sessionId),
    ]);
  }

  private setStatus(text: string, tone: 'info' | 'error'): void {
    if (this.disposed) return;
    this.status = { text, tone };
    this.requestRender();
  }

  private syncInputFocus(): void {
    this.searchInput.focused = this._focused && this.mode === 'list';
    this.actionInput.focused = this._focused && this.mode === 'rename';
  }

  private fitLines(lines: string[], width: number): string[] {
    return lines.map((line) => truncateToWidth(line, width, chalk.hex(colors.dim)('…')));
  }

  private fitToRows(lines: string[], maxRows?: number): string[] {
    if (maxRows === undefined || lines.length <= maxRows) return lines;
    if (maxRows <= 3) return lines.slice(-maxRows);
    const stickyTail = lines.slice(-3);
    return [...lines.slice(0, maxRows - stickyTail.length), ...stickyTail];
  }

  private currentMaxRows(): number | undefined {
    const maxRows =
      typeof this.options.maxRows === 'function' ? this.options.maxRows() : this.options.maxRows;
    return maxRows === undefined ? undefined : Math.max(1, Math.floor(maxRows));
  }

  private requestRender(): void {
    if (!this.disposed) this.options.requestRender();
  }
}

function sortSessions(sessions: readonly TuiSession[]): TuiSession[] {
  const sorted = [...sessions].sort(
    (left, right) => toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt),
  );
  const children = new Map<string, TuiSession[]>();
  for (const session of sorted) {
    if (!session.parentSessionId) continue;
    const siblings = children.get(session.parentSessionId) ?? [];
    siblings.push(session);
    children.set(session.parentSessionId, siblings);
  }
  const result: TuiSession[] = [];
  const visited = new Set<string>();
  const append = (session: TuiSession) => {
    if (visited.has(session.sessionId)) return;
    visited.add(session.sessionId);
    result.push(session);
    for (const child of children.get(session.sessionId) ?? []) append(child);
  };
  for (const session of sorted) {
    if (!session.parentSessionId) append(session);
  }
  for (const session of sorted) append(session);
  return result;
}

function mergeSessions(
  current: readonly TuiSession[],
  incoming: readonly TuiSession[],
): TuiSession[] {
  const byId = new Map(current.map((session) => [session.sessionId, session]));
  for (const session of incoming) byId.set(session.sessionId, session);
  return sortSessions([...byId.values()]);
}

function toTimestamp(value: number | string | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function formatSessionTime(value: number | string | undefined, now: number): string | undefined {
  const timestamp = toTimestamp(value);
  if (timestamp <= 0) return undefined;
  return (
    formatProductTime(timestamp, {
      preset: 'social-compact',
      nowMs: now,
      locale: 'en',
    }) || undefined
  );
}

function getSessionRecencySection(timestampMs: number, nowMs: number): SessionRecencySection {
  if (timestampMs <= 0 || !Number.isFinite(timestampMs) || !Number.isFinite(nowMs)) return 'older';
  const timestamp = new Date(timestampMs);
  const now = new Date(nowMs);
  const timestampDay = Date.UTC(timestamp.getFullYear(), timestamp.getMonth(), timestamp.getDate());
  const nowDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const dayDelta = Math.round((nowDay - timestampDay) / 86_400_000);
  if (dayDelta <= 0) return 'today';
  if (dayDelta === 1) return 'yesterday';
  if (dayDelta < 7) return 'previous-7-days';
  return 'older';
}

function sessionSectionLabel(section: SessionRecencySection): string {
  if (section === 'today') return 'Today';
  if (section === 'yesterday') return 'Yesterday';
  if (section === 'previous-7-days') return 'Previous 7 days';
  return 'Older';
}

function formatSessionKind(session: TuiSession): string | undefined {
  if (session.sessionType === 'branch') return 'Branch';
  if (session.sessionType === 'root') return 'Root';
  return undefined;
}

function formatSessionModel(session: TuiSession): string | undefined {
  const model = [session.model?.providerId, session.model?.modelId].filter(Boolean).join('/');
  const effort = session.model?.thinking?.effort?.trim();
  return [model || undefined, effort].filter(Boolean).join(' · ') || undefined;
}

interface SessionSearchFields {
  readonly all: string;
  readonly id: string;
  readonly path: string;
  readonly type: string;
  readonly status: string;
  readonly model: string;
}

function sessionSearchFields(session: TuiSession): SessionSearchFields {
  const model = formatSessionModel(session)?.toLocaleLowerCase() ?? '';
  const type = session.sessionType ?? (session.parentSessionId ? 'branch' : '');
  const values = [
    session.title,
    session.sessionId,
    session.workspaceDir,
    session.parentSessionId,
    session.agentName,
    session.purpose,
    type,
    session.status,
    model,
    session.interactionMode,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLocaleLowerCase();
  return {
    all: values,
    id: session.sessionId.toLocaleLowerCase(),
    path: (session.workspaceDir ?? '').toLocaleLowerCase(),
    type: type.toLocaleLowerCase(),
    status: (session.status ?? '').toLocaleLowerCase(),
    model,
  };
}

function matchesSessionQueryToken(fields: SessionSearchFields, token: string): boolean {
  const separator = token.indexOf(':');
  if (separator <= 0) return fields.all.includes(token);
  const name = token.slice(0, separator);
  const value = token.slice(separator + 1);
  if (!value) return fields.all.includes(token);
  if (name === 'id') return fields.id.includes(value);
  if (name === 'path') return fields.path.includes(value);
  if (name === 'type') return fields.type.includes(value);
  if (name === 'status') return fields.status.includes(value);
  if (name === 'model') return fields.model.includes(value);
  return fields.all.includes(token);
}

function formatSessionStatus(status: string | undefined): string | undefined {
  if (!status) return undefined;
  if (status === 'started' || status === 'running') return 'running';
  if (status === 'error' || status === 'failed') return 'error';
  return undefined;
}

function shortenHome(value: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return value;
  const normalizedHome = workspacePathKey(home);
  const normalizedValue = workspacePathKey(value);
  return normalizedValue === normalizedHome || normalizedValue.startsWith(`${normalizedHome}/`)
    ? `~${normalizedValue.slice(normalizedHome.length)}`
    : value;
}

function truncatePath(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  const characters = [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
  ].map(({ segment }) => segment);
  let suffix = '';
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const candidate = `${characters[index]}${suffix}`;
    if (visibleWidth(candidate) > Math.max(1, width - 1)) break;
    suffix = candidate;
  }
  return `…${suffix}`;
}

function composeLine(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap >= 2 ? `${left}${' '.repeat(gap)}${right}` : truncateToWidth(left, width, '…');
}
