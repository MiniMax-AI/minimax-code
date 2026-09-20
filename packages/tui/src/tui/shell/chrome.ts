import type { TuiCustomStatusLineConfig } from '@mavis/config';
import { formatContextWindow } from '../../application/context-window.js';
import type { Component } from '../rendering/component.js';
import { stripAnsi, truncateToWidth, visibleWidth } from '../rendering/text.js';
import {
  formatTuiPermissionMode,
  formatTuiPermissionModeCompact,
  isDangerousTuiPermissionMode,
} from '../../application/permission-mode.js';
import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';
import { getCapabilities, hyperlink } from '../engine/public.js';
import type { TuiTokenPlanQuota, TuiWorkspaceGitMetadata } from '../../runtime/port.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import type { TuiShellState } from './contracts.js';
import { fitFirstStatusCandidate, fitLine, normalizeWidth } from './frame.js';
import { formatTuiAgentStatusLine, type TuiAgentStatus } from './status-protocol.js';
import { TUI_STATUS_LINE_DEFAULT_ITEMS, type TuiStatusLineItem } from './status-line-items.js';
import { renderCustomStatusLines } from './custom-status-text.js';

export { type TuiRuntimeStatus, type TuiShellState } from './contracts.js';
export { TuiWelcome } from './welcome/component.js';

export class TuiUpdateNotice implements Component {
  private availableVersion: string | undefined;

  setAvailableVersion(version: string | undefined): void {
    this.availableVersion = version?.trim() || undefined;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = normalizeWidth(width);
    if (!this.availableVersion || safeWidth === 0) return [];

    const headline = fitFirstStatusCandidate(
      [
        ` ${chalk.bold.hex(colors.signal)('✦ A new version of MCode is available')} ${chalk.hex(
          colors.text,
        )('— update for the latest improvements')}`,
        ` ${chalk.bold.hex(colors.signal)(`✦ MCode ${this.availableVersion} is available`)}`,
        ` ${chalk.bold.hex(colors.signal)('✦ MCode update available')}`,
      ],
      safeWidth,
    );
    const action = fitFirstStatusCandidate(
      [
        ` ${chalk.hex(colors.muted)("Run '")}${chalk.bold.hex(colors.signal)(
          '/update',
        )}${chalk.hex(colors.muted)(`' to install MCode ${this.availableVersion}`)}`,
        ` ${chalk.hex(colors.muted)('Run ')}${chalk.bold.hex(colors.signal)(
          '/update',
        )}${chalk.hex(colors.muted)(` to install ${this.availableVersion}`)}`,
        ` ${chalk.bold.hex(colors.signal)('/update')}${chalk.hex(colors.muted)(
          ' · review and install',
        )}`,
        ` ${chalk.bold.hex(colors.signal)('/update')}${chalk.hex(colors.muted)(' · install')}`,
      ],
      safeWidth,
    );

    return [fitLine(headline, safeWidth), fitLine(action, safeWidth)];
  }
}

export class TuiStatusLine implements Component {
  constructor(
    private state: TuiShellState,
    private readonly customStatusConfig?: TuiCustomStatusLineConfig,
  ) {}

  setState(state: TuiShellState): void {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.renderViewport(width, Number.POSITIVE_INFINITY);
  }

  /** Only custom block rows yield to the viewport; the original line keeps its contract. */
  renderViewport(width: number, height: number): string[] {
    const safeWidth = normalizeWidth(width);
    if (safeWidth === 0) return [];

    const items = resolveStatusLineItems(this.state);
    // A deliberately blanked status line (`tui.statusLine: []`) renders nothing at all — not a
    // pair of empty strings. Returning zero lines lets the frame reclaim the row instead of
    // reserving a blank one.
    if (items.length === 0) return [];

    const block = this.customStatusConfig?.display === 'block' && items.includes('custom-command');
    const segments = items
      .filter((item) => !block || item !== 'custom-command')
      .map((item) => buildStatusSegment(item, this.state, this.customStatusConfig))
      .filter((segment): segment is StatusSegment => segment !== undefined);

    const line = fitStatusSegments(segments, safeWidth);
    const originalLines = stripAnsi(line).trim() ? [line] : [];
    const customLines = block
      ? this.renderCustomBlock(safeWidth, height - originalLines.length - 1)
      : [];
    if (originalLines.length === 0 && customLines.length === 0) return [];
    return this.customStatusConfig?.position === 'below'
      ? ['', ...originalLines, ...customLines]
      : ['', ...customLines, ...originalLines];
  }

  private renderCustomBlock(width: number, availableRows: number): string[] {
    const configured = this.customStatusConfig?.maxLines;
    const maxLines =
      typeof configured === 'number' && Number.isFinite(configured)
        ? Math.min(5, Math.max(1, Math.floor(configured)))
        : 3;
    const rowLimit = Math.min(maxLines, Math.max(0, Math.floor(availableRows) || 0));
    if (rowLimit === 0) return [];
    return renderCustomStatusLines(
      this.state.customStatusText ?? '',
      width,
      this.customStatusConfig?.colorMode,
    ).slice(0, rowLimit);
  }
}

/**
 * Resolves which items to render, in order.
 *
 * The machine-readable status protocol is opt-in through configuration: it
 * renders only when `tui.statusLine` names `build-mode` explicitly, so the
 * default line never leaks the marker regardless of how the bundle was built.
 * When configured, `build-mode` owns the line; an empty list renders nothing.
 */
function resolveStatusLineItems(state: TuiShellState): readonly TuiStatusLineItem[] {
  const items = state.statusLineItems ?? TUI_STATUS_LINE_DEFAULT_ITEMS;
  if (!items.includes('build-mode')) {
    if (state.statusLineItems !== undefined) {
      // The opt-in meter replaces the percentage at the meter's configured position.
      return items.includes('context-meter')
        ? items.filter((item) => item !== 'context-remaining')
        : items;
    }
    const remaining = contextRemainingPercent(state);
    return items.filter((item) =>
      remaining === undefined ? item !== 'context-remaining' : item !== 'context-window',
    );
  }
  return ['build-mode'];
}

/**
 * Maps one item id to its rendered segment.
 *
 * Shrink and drop priorities stay attached to the item rather than to the
 * configured position, so reordering items does not change which segment yields
 * space first on a narrow terminal.
 */
function buildStatusSegment(
  item: TuiStatusLineItem,
  state: TuiShellState,
  customStatusConfig?: TuiCustomStatusLineConfig,
): StatusSegment | undefined {
  switch (item) {
    case 'build-mode':
      return createStatusSegment([renderBuildMode(state)], {
        shrinkPriority: 70,
        preserveWhenNarrow: true,
      });
    case 'current-dir': {
      const workspace = formatWorkspace(state.workspace, state.homeDir);
      const workspaceVariants = formatWorkspaceVariants(workspace);
      return createStatusSegment(
        [
          workspaceVariants.full,
          workspaceVariants.medium,
          workspaceVariants.compact,
          workspaceVariants.base,
        ].map((value) => chalk.hex(colors.muted)(value)),
        { shrinkPriority: 10, dropPriority: 30 },
      );
    }
    case 'session-title':
      return createStatusSegment(
        [renderSessionTitle(state), renderSessionTitle(state, 18), renderSessionTitle(state, 10)],
        { shrinkPriority: 15, dropPriority: 60 },
      );
    case 'git-branch':
      return createStatusSegment(
        [
          renderGitContext(state.workspaceGit),
          renderGitContext(state.workspaceGit, 'compact'),
          renderGitContext(state.workspaceGit, 'minimal'),
        ],
        { shrinkPriority: 20, dropPriority: 30 },
      );
    case 'review-link':
      return createStatusSegment(
        [
          renderReviewLink(state.workspaceGit),
          renderReviewLink(state.workspaceGit, 'compact'),
          renderReviewLink(state.workspaceGit, 'minimal'),
        ],
        { shrinkPriority: 25, dropPriority: 35 },
      );
    case 'plan-mode':
      return createStatusSegment([renderPlanMode(state), renderPlanMode(state, true)], {
        shrinkPriority: 55,
        dropPriority: 55,
      });
    case 'approval-mode':
      return createStatusSegment([renderStatusMode(state), renderStatusMode(state, true)], {
        shrinkPriority: 60,
      });
    case 'model-with-reasoning':
      return createStatusSegment(
        [
          renderStatusIdentity(state, 'full'),
          renderStatusIdentity(state, 'compact'),
          renderStatusIdentity(state, 'minimal'),
        ],
        { shrinkPriority: 30, dropPriority: 65 },
      );
    case 'model':
      return createStatusSegment([renderStatusIdentity(state, 'minimal')], {
        shrinkPriority: 30,
        dropPriority: 20,
      });
    case 'context-window':
      return createStatusSegment([renderContextWindow(state), renderContextWindow(state, true)], {
        shrinkPriority: 35,
        dropPriority: 64,
      });
    case 'subagent':
      return createStatusSegment(
        [renderSubagentIdentity(state), renderSubagentIdentity(state, true)],
        { shrinkPriority: 40, dropPriority: 60 },
      );
    case 'token-quota':
      return createStatusSegment(
        [
          renderTokenPlanAlert(state.tokenPlanQuota, state.tokenPlanQuotaState),
          renderTokenPlanAlert(state.tokenPlanQuota, state.tokenPlanQuotaState, 'compact'),
          renderTokenPlanAlert(state.tokenPlanQuota, state.tokenPlanQuotaState, 'minimal'),
        ],
        { shrinkPriority: 45, dropPriority: 70 },
      );
    case 'cache-read-ratio':
      return createStatusSegment(
        [
          renderCacheReadRatio(state, 'full'),
          renderCacheReadRatio(state, 'compact'),
          renderCacheReadRatio(state, 'minimal'),
        ],
        { shrinkPriority: 48, dropPriority: 10 },
      );
    case 'context-remaining':
    case 'context-meter':
      return createStatusSegment(
        [
          renderContextRemaining(state, 'full', item === 'context-meter'),
          renderContextRemaining(state, 'compact', item === 'context-meter'),
          renderContextRemaining(state, 'minimal', item === 'context-meter'),
        ],
        { shrinkPriority: 50, dropPriority: 80 },
      );
    case 'custom-command':
      return createStatusSegment(
        [
          renderCustomStatus(state, 60, customStatusConfig?.colorMode),
          renderCustomStatus(state, 24, customStatusConfig?.colorMode),
          renderCustomStatus(state, 12, customStatusConfig?.colorMode),
        ],
        { shrinkPriority: 35, dropPriority: 50 },
      );
  }
}

/**
 * Renders the latest custom status command output.
 *
 * Only the first stdout line belongs to inline display. Share color filtering,
 * width handling and style isolation with block display.
 */
function renderCustomStatus(
  state: TuiShellState,
  maxWidth: number,
  colorMode?: TuiCustomStatusLineConfig['colorMode'],
): string {
  const firstLine = (state.customStatusText ?? '').split(/\r?\n/u, 1)[0] ?? '';
  return renderCustomStatusLines(firstLine, maxWidth, colorMode)[0] ?? '';
}

function renderCacheReadRatio(
  state: TuiShellState,
  density: 'full' | 'compact' | 'minimal' = 'full',
): string {
  const ratio = state.sessionCacheReadRatio;
  if (ratio === undefined || !Number.isFinite(ratio)) return '';
  const percent = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  const label =
    density === 'full'
      ? `Cache ${percent}%`
      : density === 'compact'
        ? `C ${percent}%`
        : `${percent}%`;
  return chalk.hex(colors.muted)(label);
}

function renderBuildMode(state: TuiShellState): string {
  return formatTuiAgentStatusLine({
    seq: state.agentSeq ?? '0',
    status: resolveAgentStatus(state),
    sessionId: state.agentSessionId,
    turnId: state.agentRunId,
    requestId: state.agentRequestId,
    activeAgents: state.agentActiveCount,
    totalAgents: state.agentTotalCount,
  });
}

function resolveAgentStatus(state: TuiShellState): TuiAgentStatus {
  if (state.agentStatus) return state.agentStatus;
  if (state.runtimeStatus === 'error') return 'error';
  return state.busy || state.runtimeStatus === 'starting' ? 'run' : 'ready';
}

interface StatusSegment {
  variants: readonly string[];
  shrinkPriority: number;
  dropPriority?: number;
  preserveWhenNarrow?: boolean;
}

function createStatusSegment(
  variants: readonly string[],
  priorities: Pick<StatusSegment, 'shrinkPriority' | 'dropPriority' | 'preserveWhenNarrow'>,
): StatusSegment | undefined {
  const visibleVariants = variants.filter(Boolean).filter((variant, index, values) => {
    const plain = stripAnsi(variant);
    return values.findIndex((candidate) => stripAnsi(candidate) === plain) === index;
  });
  if (visibleVariants.length === 0) return undefined;
  return { variants: visibleVariants, ...priorities };
}

function fitStatusSegments(segments: readonly StatusSegment[], width: number): string {
  const active = segments.map((segment) => ({ segment, variant: 0 }));
  const render = () =>
    joinStatusGroups(active.map(({ segment, variant }) => segment.variants[variant] ?? ''));

  while (visibleWidth(render()) > width) {
    const shrinkable = active
      .filter(({ segment, variant }) => variant + 1 < segment.variants.length)
      .sort((left, right) => left.segment.shrinkPriority - right.segment.shrinkPriority)[0];
    if (shrinkable) {
      shrinkable.variant += 1;
      continue;
    }

    const droppable = active
      .filter(({ segment }) => segment.dropPriority !== undefined)
      .sort(
        (left, right) =>
          (left.segment.dropPriority ?? Number.POSITIVE_INFINITY) -
          (right.segment.dropPriority ?? Number.POSITIVE_INFINITY),
      )[0];
    if (droppable) {
      active.splice(active.indexOf(droppable), 1);
      continue;
    }

    if (!active.some(({ segment }) => segment.preserveWhenNarrow)) break;

    const fallbackDroppable = active
      .slice()
      .reverse()
      .find(({ segment }) => !segment.preserveWhenNarrow);
    if (!fallbackDroppable) break;
    active.splice(active.indexOf(fallbackDroppable), 1);
  }

  return fitLine(render(), width);
}

function renderSessionTitle(state: TuiShellState, maxWidth?: number): string {
  if (state.sessionRole === 'subagent') return '';
  const title = sanitizeTerminalText(state.sessionTitle?.trim() ?? '');
  if (!title || title.toLocaleLowerCase() === 'new session') return '';
  const visible = maxWidth ? truncateToWidth(title, maxWidth, '…') : title;
  return `${chalk.hex(colors.signal)('◇')} ${chalk.hex(colors.muted)(visible)}`;
}

function renderStatusIdentity(
  state: TuiShellState,
  density: 'full' | 'compact' | 'minimal',
): string {
  const model = formatStatusContextLabel(state.model ?? 'no model');
  const thinking =
    density === 'minimal' || !state.thinking || state.effort
      ? undefined
      : density === 'compact'
        ? `Think ${state.thinking === 'on' ? 'On' : 'Off'}`
        : `Thinking ${state.thinking === 'on' ? 'On' : 'Off'}`;
  const effort =
    density === 'minimal' || !state.effort
      ? undefined
      : density === 'compact'
        ? `Eff ${state.effort}`
        : `Effort ${state.effort}`;
  const detail = [thinking, effort]
    .filter((part): part is string => Boolean(part))
    .map((part) => `${statusDot()}${chalk.hex(colors.muted)(part)}`)
    .join('');
  return `${chalk.hex(colors.accent)('✦')} ${chalk.hex(colors.accent)(model)}${detail}`;
}

function contextWindowTokens(state: TuiShellState): number | undefined {
  const usageWindow = state.contextUsage?.contextWindowTokens;
  const contextWindow =
    typeof usageWindow === 'number' && Number.isFinite(usageWindow) && usageWindow > 0
      ? usageWindow
      : state.contextWindowTokens;
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }
  return contextWindow;
}

function renderContextWindow(state: TuiShellState, compact = false): string {
  const window = contextWindowTokens(state);
  if (window === undefined) return '';
  return chalk.hex(colors.muted)(`${compact ? 'Ctx' : 'Context'} ${formatContextWindow(window)}`);
}

/**
 * Renders remaining context headroom as a percentage.
 *
 * The window falls back to the model's advertised context window when the
 * snapshot does not carry one, matching how `/context` reports the same budget.
 * Returns an empty string when no usage is known, so the segment is dropped
 * rather than showing a misleading 100%.
 */
function contextRemainingPercent(state: TuiShellState): number | undefined {
  const usage = state.contextUsage;
  if (!usage || !Number.isFinite(usage.usedTokens)) return undefined;
  const contextWindow = contextWindowTokens(state);
  if (contextWindow === undefined) return undefined;
  const used = Math.max(0, Math.min(usage.usedTokens, contextWindow));
  return Math.round(((contextWindow - used) / contextWindow) * 100);
}

/** Both presentations share usage, fallback, thresholds and the minimal label. */
function renderContextRemaining(
  state: TuiShellState,
  density: 'full' | 'compact' | 'minimal' = 'full',
  meter = false,
): string {
  const remaining = contextRemainingPercent(state);
  if (remaining === undefined) return '';
  const color = remaining <= 10 ? colors.error : remaining <= 25 ? colors.warning : colors.muted;
  let gauge = '';
  if (meter && density !== 'minimal') {
    const cells = density === 'full' ? 8 : 6;
    const filled = Math.round((remaining / 100) * cells);
    gauge = `▕${'█'.repeat(filled)}${'░'.repeat(cells - filled)}▏ `;
  }
  const label =
    density === 'full'
      ? `Context ${gauge}${remaining}% left`
      : `Ctx ${gauge}${remaining}%`;
  return chalk.hex(color)(label);
}

function renderSubagentIdentity(state: TuiShellState, compact = false): string {
  if (state.sessionRole !== 'subagent') return '';
  const agent = formatStatusContextLabel(state.sessionAgentName?.trim() || 'sub-agent');
  const label = compact ? `Sub:${agent}` : `Sub: ${agent}`;
  return chalk.hex(colors.muted)(label);
}

function renderGitContext(
  metadata: TuiWorkspaceGitMetadata | undefined,
  density: 'full' | 'compact' | 'minimal' = 'full',
): string {
  if (!metadata?.isGitRepo) return '';
  const ref = metadata.detached ? 'detached' : metadata.branch || 'unborn';
  const label =
    density === 'full' ? ref : stripAnsi(truncateToWidth(ref, density === 'minimal' ? 7 : 12));
  const worktree = metadata.isWorktree ? (density === 'full' ? 'worktree' : 'wt') : undefined;
  return `${chalk.hex(colors.accent)('⎇')} ${chalk.hex(colors.muted)(label)}${
    worktree ? `${statusDot()}${chalk.hex(colors.muted)(worktree)}` : ''
  }`;
}

/**
 * Renders the pull request / merge request the current branch belongs to.
 *
 * Renders nothing when no review was recorded for the branch, which is the
 * common case: the link only exists once an agent turn has run `gh pr` or
 * `glab mr` on this machine. The vendor prefix (`#` / `!`) matches each host's
 * own shorthand so the number reads the way it does everywhere else.
 *
 * The whole segment is wrapped in an OSC 8 hyperlink so the review can be
 * opened straight from the status line, but only where the terminal forwards
 * them — `getCapabilities()` already answers that for tmux and screen, which
 * would otherwise show the escape as garbage. Width maths is unaffected either
 * way: `visibleWidth` skips OSC sequences, and `truncateToWidth` closes an open
 * hyperlink when it cuts.
 */
function renderReviewLink(
  metadata: TuiWorkspaceGitMetadata | undefined,
  density: 'full' | 'compact' | 'minimal' = 'full',
): string {
  const review = metadata?.reviewLink;
  if (!metadata?.isGitRepo || !review) return '';
  const isMergeRequest = review.vendor === 'gitlab';
  const number = chalk.hex(colors.muted)(`${isMergeRequest ? '!' : '#'}${review.number}`);
  const rendered =
    density === 'full'
      ? `${chalk.hex(colors.accent)(isMergeRequest ? 'MR' : 'PR')} ${number}`
      : number;
  return getCapabilities().hyperlinks ? hyperlink(rendered, review.url) : rendered;
}

function renderTokenPlanAlert(
  quota: TuiTokenPlanQuota | undefined,
  quotaState: TuiShellState['tokenPlanQuotaState'],
  density: 'full' | 'compact' | 'minimal' = 'full',
): string {
  if (quotaState !== 'available' || !quota) return '';
  const constrained = [
    quotaAlertWindow('5h', '5h', quota.fiveHour),
    quotaAlertWindow('Week', 'W', quota.weekly),
  ].filter((window): window is TokenPlanAlertWindow => window !== undefined);
  if (constrained.length === 0) return '';

  const lowest = Math.min(...constrained.map(({ remaining }) => remaining));
  const color = lowest <= 10 ? colors.error : lowest <= 30 ? colors.warning : colors.success;
  const visible =
    density === 'minimal'
      ? [
          constrained.reduce((lowestWindow, window) =>
            window.remaining < lowestWindow.remaining ? window : lowestWindow,
          ),
        ]
      : constrained;
  const label = visible
    .map(({ label: fullLabel, compactLabel, remaining }) =>
      density === 'full' ? `${fullLabel} ${remaining}%` : `${compactLabel}${remaining}%`,
    )
    .join(density === 'full' ? ' · ' : '/');
  return chalk.hex(color)(label);
}

interface TokenPlanAlertWindow {
  label: string;
  compactLabel: string;
  remaining: number;
}

function quotaAlertWindow(
  label: string,
  compactLabel: string,
  window: TuiTokenPlanQuota['fiveHour'],
): TokenPlanAlertWindow | undefined {
  if (window.unlimited) return undefined;
  if (typeof window.remainingPercent !== 'number' || !Number.isFinite(window.remainingPercent)) {
    return undefined;
  }
  const remaining = Math.round(Math.min(100, Math.max(0, window.remainingPercent)));
  return remaining <= 30 ? { label, compactLabel, remaining } : undefined;
}

function joinStatusGroups(groups: readonly string[]): string {
  return groups.filter(Boolean).join(chalk.hex(colors.dim)(' │ '));
}

function statusDot(): string {
  return chalk.hex(colors.dim)(' · ');
}

function renderPlanMode(state: TuiShellState, compact = false): string {
  if (state.planMode !== 'plan' && !state.planModeTransition) return '';
  const label = state.planMode === 'plan' ? 'PLAN' : 'DEFAULT';
  const suffix =
    state.planModeTransition === 'next-message'
      ? compact
        ? '…'
        : ' next'
      : state.planModeTransition === 'submitting'
        ? compact
          ? '…'
          : ' submitting'
        : '';
  return chalk.bold.hex(colors.accent)(`${label}${suffix}`);
}

function renderPermissionMode(state: TuiShellState, compact = false): string {
  const label = state.permissionMode
    ? compact
      ? formatTuiPermissionModeCompact(state.permissionMode)
      : formatTuiPermissionMode(state.permissionMode)
    : 'Permissions';
  const suffix = state.permissionModeUpdating ? '…' : '';
  const renderedMode = chalk.bold.hex(
    state.permissionMode && isDangerousTuiPermissionMode(state.permissionMode)
      ? colors.error
      : colors.signal,
  )(`${label}${suffix}`);
  return renderedMode;
}

function renderStatusMode(state: TuiShellState, compact = false): string {
  return renderPermissionMode(state, compact);
}

function formatWorkspace(workspace: string, homeDir: string | undefined): string {
  if (!homeDir) return workspace;
  if (workspace === homeDir) return '~';
  if (workspace.startsWith(`${homeDir}/`) || workspace.startsWith(`${homeDir}\\`)) {
    return `~${workspace.slice(homeDir.length)}`;
  }
  return workspace;
}

function formatWorkspaceVariants(workspace: string): {
  full: string;
  medium: string;
  compact: string;
  base: string;
} {
  const normalized = workspace.replaceAll('\\', '/').replace(/\/+$/u, '') || workspace;
  const segments = normalized.split('/').filter(Boolean);
  const base = segments.at(-1) || normalized;
  return {
    full: normalized,
    medium: compactWorkspacePath(segments, 3, base),
    compact: compactWorkspacePath(segments, 2, base),
    base,
  };
}

function compactWorkspacePath(
  segments: readonly string[],
  count: number,
  fallback: string,
): string {
  if (segments.length <= count) return segments.join('/') || fallback;
  return `…/${segments.slice(-count).join('/')}`;
}

function formatStatusContextLabel(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/u, '');
  return normalized.split('/').at(-1) || value;
}
