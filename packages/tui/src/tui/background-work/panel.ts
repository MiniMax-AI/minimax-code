import {
  panelContentWidth,
  renderPanelHeader,
  renderPanelRow,
  renderPanelFooter,
  renderPanelDivider,
  renderPanelBottom,
} from '../widgets/panel-frame.js';
import { decodePrintableKey, matchesKey, VStack, type Component } from '../engine/public.js';
import type { TuiBackgroundTask } from '../../runtime/port.js';
import type { TuiFeatureScreen } from '../shell/surface-host.js';
import {
  tuiAgentTeamElapsedMs,
  tuiAgentTeamMemberLabel,
  type TuiAgentTeamMember,
  type TuiAgentTeamSnapshot,
} from '../agent-team/model.js';
import { truncateToWidth, wrapTextWithAnsi } from '../rendering/text.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';
import { TuiSelectionScrollView } from '../widgets/selection-scroll-view.js';

export interface TuiBackgroundWorkPanelOptions {
  readonly agentTeam: () => TuiAgentTeamSnapshot;
  readonly backgroundTasks: () => readonly TuiBackgroundTask[];
  readonly activeSessionId: () => string | undefined;
  readonly onOpenAgent: (sessionId: string) => void | Promise<void>;
  /**
   * Switch the TUI into the Agent's own Session so its questions can be answered there.
   * Absent when the host cannot open Sessions, which also hides the key hint.
   */
  readonly onEnterSession?: (sessionId: string) => void | Promise<void>;
  readonly onCancel: () => void;
  readonly requestRender: () => void;
}

type BackgroundWorkEntry =
  | { readonly key: string; readonly kind: 'agent'; readonly member: TuiAgentTeamMember }
  | { readonly key: string; readonly kind: 'runtime-task'; readonly task: TuiBackgroundTask };

interface BackgroundWorkView {
  readonly agentTeam: TuiAgentTeamSnapshot;
  readonly entries: readonly BackgroundWorkEntry[];
}

/** Unified, read-only detail surface for mutable work owned by Runtime. */
export class TuiBackgroundWorkPanel implements TuiFeatureScreen {
  readonly id = 'background-work';
  readonly layoutRoot: Component;
  private readonly bodyViewport: TuiSelectionScrollView;
  private selectedIndex = 0;
  private selectedKey: string | undefined;
  private detailTaskId: string | undefined;

  constructor(private readonly options: TuiBackgroundWorkPanelOptions) {
    const header: Component = {
      render: (width) => this.renderHeader(width),
      invalidate: () => undefined,
    };
    const body: Component = {
      render: (width) => this.renderFramedBody(width),
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
    this.layoutRoot = new VStack([
      { component: header, basis: 'auto', shrink: 1, minSize: 1 },
      { component: this.bodyViewport, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: footer, basis: 'auto', shrink: 1, minSize: 1 },
    ]);
  }

  invalidate(): void {
    this.layoutRoot.invalidate();
  }

  handleInput(data: string): void {
    const printable = decodePrintableKey(data) ?? data;
    if (printable === 'q' || printable === 'Q') {
      this.options.onCancel();
      return;
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      if (this.detailTaskId) {
        this.detailTaskId = undefined;
        this.bodyViewport.setActiveRow(this.selectedIndex, true);
        this.options.requestRender();
      } else {
        this.options.onCancel();
      }
      return;
    }
    if (this.detailTaskId) return;

    const entries = this.view().entries;
    this.syncSelection(entries);
    if (entries.length === 0) return;
    if (matchesKey(data, 'up')) {
      this.select(entries, this.selectedIndex === 0 ? entries.length - 1 : this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, 'down')) {
      this.select(entries, (this.selectedIndex + 1) % entries.length);
      return;
    }
    const selected = entries[this.selectedIndex];
    if (!selected) return;
    // Enter stays the read-only transcript so the existing habit keeps working; `o` is
    // the one that hands the Session over to the chat surface.
    if (selected.kind === 'agent' && (printable === 'o' || printable === 'O')) {
      void this.options.onEnterSession?.(selected.member.sessionId);
      return;
    }
    if (!matchesKey(data, 'enter')) return;
    if (selected.kind === 'agent') {
      void this.options.onOpenAgent(selected.member.sessionId);
      return;
    }
    this.detailTaskId = selected.task.taskId;
    this.bodyViewport.setActiveRow(0, true);
    this.options.requestRender();
  }


  render(width: number): string[] {
    const view = this.view();
    return [
      ...this.renderHeader(width, view),
      ...this.renderFramedBody(width, view),
      ...this.renderFooter(width, view),
    ];
  }

  private renderHeader(rawWidth: number, view = this.view()): string[] {
    const width = normalizeWidth(rawWidth);
    if (width === 0) return [];
    const { entries } = view;
    const active = entries.filter(isActiveEntry).length;
    const waiting = entries.filter(isWaitingEntry).length;
    const failed = entries.filter(isFailedEntry).length;
    // `N waiting` is counted apart from `active` on purpose: a member blocked on the user
    // is not making progress, and burying it in the active count is how a stalled task
    // goes unnoticed.
    const counts = [
      `${String(entries.length)} total`,
      active > 0 ? `${String(active)} active` : undefined,
      waiting > 0 ? `${String(waiting)} waiting` : undefined,
      failed > 0 ? `${String(failed)} failed` : undefined,
    ].filter((value): value is string => Boolean(value));
    return [renderPanelHeader('Tasks', counts.join(' · '), width)].map((line) =>
      truncateToWidth(line, width, ''),
    );
  }

  private renderFramedBody(width: number, view = this.view()): string[] {
    const body = this.renderBody(panelContentWidth(width, width >= 4), view);
    while (body.length < this.bodyViewport.viewportHeight) body.push('');
    return body.map((line) => renderPanelRow(line, width));
  }

  private renderBody(rawWidth: number, view = this.view()): string[] {
    const width = normalizeWidth(rawWidth);
    if (width === 0) return [];
    if (this.detailTaskId) return this.renderTaskDetail(this.detailTaskId, width);

    const { agentTeam, entries } = view;
    this.syncSelection(entries);
    this.bodyViewport.setActiveRowPreservingScroll(this.selectedIndex);
    if (entries.length === 0) {
      return [truncateToWidth(chalk.hex(colors.dim)('No background work'), width, '')];
    }
    return entries.map((entry, index) =>
      truncateToWidth(
        renderEntry(entry, index === this.selectedIndex, agentTeam, width),
        width,
        chalk.hex(colors.dim)('…'),
      ),
    );
  }

  private renderTaskDetail(taskId: string, width: number): string[] {
    const task = this.options.backgroundTasks().find((candidate) => candidate.taskId === taskId);
    if (!task) {
      return [
        truncateToWidth(chalk.bold.hex(colors.error)('Background task unavailable'), width, ''),
        truncateToWidth(
          chalk.hex(colors.muted)('The Runtime task list changed. Press Esc to return.'),
          width,
          '',
        ),
      ];
    }
    return [
      ...wrapTextWithAnsi(
        chalk.bold.hex(statusColor(task.status))(`Background task · ${statusLabel(task.status)}`),
        width,
      ),
      '',
      ...renderDetailField('Task ID', task.taskId, width),
      ...(task.lastError
        ? ['', ...renderDetailField('Error', task.lastError, width, colors.error)]
        : []),
      '',
      ...renderDetailField(
        task.command !== undefined ? 'Command' : 'Description',
        task.command ?? task.description ?? task.kind,
        width,
      ),
    ];
  }


  private renderFooter(rawWidth: number, view = this.view()): string[] {
    const width = normalizeWidth(rawWidth);
    if (width === 0) return [];
    let hint: string;
    if (this.detailTaskId) {
      hint = 'PgUp/PgDn scroll · Esc back · Q close';
    } else {
      this.syncSelection(view.entries);
      const selected = view.entries[this.selectedIndex];
      const actions: string[] = [];
      if (selected?.kind === 'agent') {
        actions.push('Enter open transcript');
        if (this.options.onEnterSession) actions.push('o open session');
      } else if (selected?.kind === 'runtime-task') {
        actions.push('Enter inspect');
      }
      hint = ['↑↓ select', 'PgUp/PgDn scroll', ...actions, 'Esc return'].join(' · ');
    }
    return [
      renderPanelDivider(width),
      ...renderPanelFooter(hint, panelContentWidth(width)).map((line) =>
        renderPanelRow(line, width),
      ),
      renderPanelBottom(width),
    ];
  }

  private view(): BackgroundWorkView {
    const agentTeam = this.options.agentTeam();
    return { agentTeam, entries: this.entries(agentTeam) };
  }

  private entries(agentTeam: TuiAgentTeamSnapshot): readonly BackgroundWorkEntry[] {
    const agents = agentTeam.members.map(
      (member): BackgroundWorkEntry => ({
        key: `agent:${member.sessionId}`,
        kind: 'agent',
        member,
      }),
    );
    const tasks = this.options.backgroundTasks().map(
      (task): BackgroundWorkEntry => ({
        key: `task:${task.taskId}`,
        kind: 'runtime-task',
        task,
      }),
    );
    return [...agents, ...tasks];
  }

  private syncSelection(entries: readonly BackgroundWorkEntry[]): void {
    if (entries.length === 0) {
      this.selectedIndex = 0;
      this.selectedKey = undefined;
      return;
    }
    const previousIndex = this.selectedIndex;
    const preferredKey = this.selectedKey ?? this.activeAgentKey(entries);
    const selectedIndex = preferredKey
      ? entries.findIndex((entry) => entry.key === preferredKey)
      : -1;
    this.selectedIndex =
      selectedIndex >= 0 ? selectedIndex : Math.min(this.selectedIndex, entries.length - 1);
    this.selectedKey = entries[this.selectedIndex]?.key;
    if (this.selectedIndex !== previousIndex) {
      this.bodyViewport.setActiveRow(this.selectedIndex, true);
    }
  }

  private activeAgentKey(entries: readonly BackgroundWorkEntry[]): string | undefined {
    const sessionId = this.options.activeSessionId();
    return sessionId && entries.some((entry) => entry.key === `agent:${sessionId}`)
      ? `agent:${sessionId}`
      : undefined;
  }

  private select(entries: readonly BackgroundWorkEntry[], index: number): void {
    this.selectedIndex = index;
    this.selectedKey = entries[index]?.key;
    this.bodyViewport.setActiveRow(index, true);
    this.options.requestRender();
  }
}

function renderDetailField(
  label: string,
  value: string,
  width: number,
  color = colors.text,
): string[] {
  return [
    ...wrapTextWithAnsi(chalk.hex(colors.muted)(label), width),
    ...wrapTextWithAnsi(
      chalk.hex(color)(sanitizeTerminalText(value).replaceAll('\t', '    ')),
      width,
    ),
  ];
}


function renderEntry(
  entry: BackgroundWorkEntry,
  selected: boolean,
  snapshot: TuiAgentTeamSnapshot,
  width: number,
): string {
  const rail = selected ? chalk.bold.hex(colors.signal)('›') : ' ';
  if (entry.kind === 'agent') {
    const member = entry.member;
    const label = tuiAgentTeamMemberLabel(member, snapshot);
    const elapsed = formatElapsed(tuiAgentTeamElapsedMs(member, snapshot.capturedAtMs));
    const details = [member.activity, member.task, `${String(member.toolCount)} tools`, elapsed]
      .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index)
      .join(' · ');
    return `${rail} ${entryMarker(member.status)} ${chalk.hex(colors.dim)('[Agent]')} ${chalk.bold.hex(selected ? colors.signal : colors.text)(label)} ${chalk.hex(colors.muted)(details)}`;
  }

  const task = entry.task;
  const category = `[${task.kind === 'bash' ? 'Bash' : capitalize(task.kind)}]`;
  const description = oneLine(task.description ?? task.kind);
  const details = [statusLabel(task.status), abbreviateTaskId(task.taskId)].join(' · ');
  const text = `${rail} ${entryMarker(task.status)} ${chalk.hex(colors.dim)(category)} ${chalk.bold.hex(selected ? colors.signal : colors.text)(description)} ${chalk.hex(colors.muted)(details)}`;
  return width < 48 ? text.replace(` ${abbreviateTaskId(task.taskId)}`, '') : text;
}

function isActiveEntry(entry: BackgroundWorkEntry): boolean {
  if (entry.kind === 'agent') {
    return (
      entry.member.status === 'queued' ||
      entry.member.status === 'running' ||
      entry.member.status === 'waiting'
    );
  }
  return isActiveTask(entry.task.status);
}

function isWaitingEntry(entry: BackgroundWorkEntry): boolean {
  return entry.kind === 'agent' && entry.member.status === 'waiting';
}

function isFailedEntry(entry: BackgroundWorkEntry): boolean {
  return entry.kind === 'agent'
    ? entry.member.status === 'failed'
    : entry.task.status === 'failed' || entry.task.status === 'lost';
}

function isActiveTask(status: TuiBackgroundTask['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'stopping';
}

function entryMarker(status: TuiAgentTeamMember['status'] | TuiBackgroundTask['status']): string {
  if (status === 'failed' || status === 'lost') return chalk.hex(colors.error)('×');
  if (status === 'waiting' || status === 'stopping') return chalk.hex(colors.warning)('◉');
  if (status === 'done' || status === 'succeeded') return chalk.hex(colors.success)('✓');
  if (status === 'stopped' || status === 'canceled') return chalk.hex(colors.muted)('■');
  return chalk.hex(colors.accent)('●');
}

function statusColor(status: TuiBackgroundTask['status']): string {
  if (status === 'failed' || status === 'lost') return colors.error;
  if (status === 'stopping') return colors.warning;
  if (status === 'succeeded') return colors.success;
  if (status === 'canceled') return colors.muted;
  return colors.accent;
}

function statusLabel(status: TuiBackgroundTask['status']): string {
  if (status === 'canceled') return 'Cancelled';
  return capitalize(status);
}

function capitalize(value: string): string {
  return `${value.charAt(0).toLocaleUpperCase()}${value.slice(1)}`;
}

function oneLine(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, ' ').trim();
}

function abbreviateTaskId(taskId: string): string {
  return taskId.length > 16 ? `${taskId.slice(0, 15)}…` : taskId;
}

function formatElapsed(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  return `${String(Math.floor(minutes / 60))}h`;
}

function normalizeWidth(rawWidth: number): number {
  return Number.isFinite(rawWidth) ? Math.max(0, Math.floor(rawWidth)) : 0;
}
