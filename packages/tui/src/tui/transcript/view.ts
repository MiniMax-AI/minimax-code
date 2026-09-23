import { Markdown, Text } from '../engine/public.js';
import { projectAssistantContentForTerminal } from '../../application/assistant-content.js';
import { formatTuiDuration } from '../rendering/duration.js';
import type { Component } from '../rendering/component.js';
import { stripAnsi, truncateToWidth, visibleWidth } from '../rendering/text.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import type { TranscriptAttachment, TranscriptCell } from './model.js';
import { resolveTranscriptCellDisplayMode } from './model.js';
import {
  TranscriptPresentationController,
  type TranscriptDisplayModeResolver,
  type TranscriptMainMode,
} from './presentation/state.js';
import {
  TranscriptProjectionWindow,
  type TranscriptProjectionSource,
} from './projection-window.js';
import {
  formatTranscriptToolIdentity,
  normalizeToolName,
  resolveTranscriptToolDefinition,
  resolveTranscriptToolFailedAction,
} from './tool-definitions.js';
import { isBackgroundBashTranscriptCell, presentTranscriptToolEvidence } from './tool-evidence.js';
import { formatTuiToolSummary } from './presentation/tool-summary.js';
import { renderTuiAgentTeamSummary } from '../agent-team/summary.js';
import { renderTuiStructuredPreview } from './presentation/structured-preview.js';
import { renderTranscriptInspection } from './inspection.js';
import { renderDeliveredAssets } from './delivered-assets.js';
import {
  tuiChalk as chalk,
  tuiColors as colors,
  tuiMarkdownTheme as markdownTheme,
  tuiStreamingMarkdownTheme as streamingMarkdownTheme,
} from '../theme/runtime.js';
import { highlightTuiShellCommand } from '../theme/shell-command.js';
import { renderShellBlock } from './shell-block.js';

const ASSISTANT_ANCHOR_WIDTH = 2;
const ASSISTANT_ANCHOR_MARKER = '●';
const OSC133_ZONE_START = '\x1b]133;A\x07';
const OSC133_ZONE_END = '\x1b]133;B\x07';
const OSC133_ZONE_FINAL = '\x1b]133;C\x07';
/** Width of the `└ ` / `├ ` connector rendered before every tool row. */
const TOOL_ROW_CONNECTOR_WIDTH = 2;
/** Below this the command is too clipped to identify, so keep the row uniform instead. */
const MIN_SHELL_COMMAND_WIDTH = 12;

export class TranscriptView implements Component {
  private readonly unitCache = new Map<
    string,
    {
      signature: string;
      width: number;
      lines: readonly string[];
    }
  >();
  private readonly markdownComponents = new Map<string, Markdown>();
  private readonly markdownStreaming = new Map<string, boolean>();
  private frameCache:
    | {
        signature: string;
        width: number;
        lines: string[];
        source?: TranscriptProjectionSource;
        sourceRevision?: number;
        presentationRevision: number;
      }
    | undefined;
  private performanceSnapshot = {
    sourceUnits: 0,
    projectedCells: 0,
    projectedUnits: 0,
    renderedUnits: 0,
    hiddenTurns: 0,
    foldedCells: 0,
    projectionVisitedCells: 0,
    windowRolls: 0,
    unitCacheEntries: 0,
    unitCacheHits: 0,
    unitCacheMisses: 0,
  };
  private frameUnitCacheHits = 0;
  private frameUnitCacheMisses = 0;
  private readonly projectionWindow: TranscriptProjectionWindow;

  private readonly displayModes: TranscriptDisplayModeResolver;
  private readonly workspaceDir: string;

  constructor(
    private readonly cells:
      | (() => readonly TranscriptCell[] | TranscriptProjectionSource)
      | TranscriptProjectionSource,
    options: {
      maxInitialTurns?: number;
      maxCellsPerTurn?: number;
      maxProjectedTurns?: number;
      maxProjectedCells?: number;
      displayModes?: TranscriptDisplayModeResolver;
      workspaceDir?: string;
    } = {},
  ) {
    this.displayModes = options.displayModes ?? new TranscriptPresentationController();
    this.workspaceDir = options.workspaceDir ?? process.cwd();
    this.projectionWindow = new TranscriptProjectionWindow(
      options.maxInitialTurns ?? 30,
      options.maxCellsPerTurn ?? 120,
      options.maxProjectedTurns ?? (options.maxInitialTurns ?? 30) * 2,
      options.maxProjectedCells ?? 1_000,
    );
  }

  invalidate(): void {
    this.unitCache.clear();
    for (const markdown of this.markdownComponents.values()) markdown.invalidate();
    this.frameCache = undefined;
  }

  dispose(): void {
    this.unitCache.clear();
    this.markdownComponents.clear();
    this.markdownStreaming.clear();
    this.frameCache = undefined;
    this.projectionWindow.reset();
  }

  render(width: number): string[] {
    const sourceCells = this.resolveCells();
    const normalizedWidth = Math.max(0, Math.floor(width));
    const source = Array.isArray(sourceCells)
      ? undefined
      : (sourceCells as TranscriptProjectionSource);
    const sourceRevision = source?.revision;
    if (this.frameCache && this.frameCache.source !== source) this.invalidate();
    const presentationRevision = this.displayModes.revision;
    if (
      source &&
      sourceRevision !== undefined &&
      this.frameCache?.source === source &&
      this.frameCache.sourceRevision === sourceRevision &&
      this.frameCache.presentationRevision === presentationRevision &&
      this.frameCache.width === normalizedWidth
    ) {
      return this.frameCache.lines;
    }

    const projection = this.projectionWindow.project(sourceCells);
    const units = createRenderUnits(projection.cells);
    const unitSignatures = units.map((unit) => renderUnitSignature(unit, source));
    const frameSignature = `${presentationRevision}\u001C${
      projection.hiddenTurns
    }\u001C${unitSignatures.join('\u001F')}`;
    if (
      this.frameCache?.width === normalizedWidth &&
      this.frameCache.signature === frameSignature
    ) {
      return this.frameCache.lines;
    }

    this.resetFrameCacheMetrics();
    const activeUnitKeys = new Set<string>();
    const lines: string[] =
      projection.hiddenTurns > 0
        ? [
            chalk.hex(colors.muted)(
              `↑ ${projection.hiddenTurns} earlier turns omitted from live projection`,
            ),
            ' ',
          ]
        : [];
    units.forEach((unit, index) => {
      const next = units[index + 1];
      const key = renderUnitKey(unit);
      activeUnitKeys.add(key);
      const rendered = this.renderUnit(unit, next, normalizedWidth, unitSignatures[index] ?? '');
      const connectedToNext = isConnectedRenderUnit(unit, next);
      lines.push(...rendered);
      if (next && rendered.length > 0 && !connectedToNext && !isPendingSteerUnit(next)) {
        lines.push(' ');
      }
    });
    this.pruneUnitCaches(activeUnitKeys);
    this.frameCache = {
      signature: frameSignature,
      width: normalizedWidth,
      lines,
      source,
      sourceRevision,
      presentationRevision,
    };
    this.performanceSnapshot = {
      sourceUnits: sourceCells.length,
      projectedCells: projection.cells.length,
      projectedUnits: units.length,
      renderedUnits: units.length,
      hiddenTurns: projection.hiddenTurns,
      foldedCells: projection.foldedCells,
      projectionVisitedCells: projection.visitedCells,
      windowRolls: projection.windowRolls,
      unitCacheEntries: this.unitCache.size,
      unitCacheHits: this.frameUnitCacheHits,
      unitCacheMisses: this.frameUnitCacheMisses,
    };
    return lines;
  }

  getPerformanceSnapshot(): {
    sourceUnits: number;
    projectedCells: number;
    projectedUnits: number;
    renderedUnits: number;
    hiddenTurns: number;
    foldedCells: number;
    projectionVisitedCells: number;
    windowRolls: number;
    unitCacheEntries: number;
    unitCacheHits: number;
    unitCacheMisses: number;
  } {
    return { ...this.performanceSnapshot };
  }

  toggleDetailMode(): TranscriptMainMode {
    const mode = this.displayModes.toggleMainMode?.() ?? 'compact';
    this.frameCache = undefined;
    return mode;
  }

  private renderUnit(
    unit: TranscriptRenderUnit,
    next: TranscriptRenderUnit | undefined,
    width: number,
    dataSignature: string,
  ): readonly string[] {
    const connectedToNext = isConnectedRenderUnit(unit, next);
    const key = renderUnitKey(unit);
    const presentationSignature = this.presentationSignature(unit);
    const signature = `${presentationSignature}:${dataSignature}:${
      connectedToNext ? 'connected' : 'closed'
    }`;
    const cached = this.unitCache.get(key);
    if (cached?.width === width && cached.signature === signature) {
      this.frameUnitCacheHits += 1;
      return cached.lines;
    }
    this.frameUnitCacheMisses += 1;
    const content =
      unit.kind === 'cell' &&
      (unit.cell.kind === 'assistant' || unit.cell.kind === 'assistant-preamble')
        ? this.renderAssistant(unit.cell, width)
        : unit.kind === 'read-group'
          ? renderReadGroup(unit.cells, width, connectedToNext, (cell) =>
              this.resolveDisplayMode(cell),
            )
          : renderCell(
              unit.cell,
              width,
              connectedToNext,
              (cell) => this.resolveDisplayMode(cell),
              this.workspaceDir,
            );
    const rendered = content;
    this.unitCache.set(key, {
      signature,
      width,
      lines: rendered,
    });
    return rendered;
  }

  private renderAssistant(cell: TranscriptCell, width: number): readonly string[] {
    const key = `cell:${cell.id}`;
    const theme = isMutableCell(cell) ? streamingMarkdownTheme : markdownTheme;
    const content = projectAssistantContentForTerminal(cell.content);
    const normalizedWidth = Math.max(0, Math.floor(width));
    if (normalizedWidth === 0) return [];
    let markdown = this.markdownComponents.get(key);
    if (!markdown || this.markdownStreaming.get(key) !== isMutableCell(cell)) {
      markdown = new Markdown(content.text, 0, 0, theme, {
        color: (text) => chalk.hex(colors.text)(text),
      });
      this.markdownComponents.set(key, markdown);
      this.markdownStreaming.set(key, isMutableCell(cell));
    } else {
      markdown.setText(content.text);
    }
    const contentWidth = Math.max(1, normalizedWidth - ASSISTANT_ANCHOR_WIDTH);
    const prose = markdown.render(contentWidth);
    const assets = renderDeliveredAssets(content.assets, contentWidth, this.workspaceDir);
    return wrapSemanticMessageZone(
      anchorAssistantLines(
        prose.length > 0 && assets.length > 0 ? [...prose, '', ...assets] : [...prose, ...assets],
        normalizedWidth,
      ),
    );
  }

  private resolveCells(): readonly TranscriptCell[] | TranscriptProjectionSource {
    return typeof this.cells === 'function' ? this.cells() : this.cells;
  }

  private resolveDisplayMode(cell: TranscriptCell) {
    return this.displayModes.resolveMainDisplayMode(cell);
  }

  private presentationSignature(unit: TranscriptRenderUnit): string {
    const cells = unit.kind === 'cell' ? [unit.cell] : unit.cells;
    return cells.map((cell) => this.resolveDisplayMode(cell)).join(':');
  }

  private resetFrameCacheMetrics(): void {
    this.frameUnitCacheHits = 0;
    this.frameUnitCacheMisses = 0;
  }

  private pruneUnitCaches(activeUnitKeys: ReadonlySet<string>): void {
    for (const key of this.unitCache.keys()) {
      if (activeUnitKeys.has(key)) continue;
      this.unitCache.delete(key);
      this.markdownComponents.delete(key);
      this.markdownStreaming.delete(key);
    }
  }
}

type TranscriptRenderUnit =
  | { kind: 'cell'; cell: TranscriptCell }
  | { kind: 'read-group'; cells: TranscriptCell[] };

function renderUnitKey(unit: TranscriptRenderUnit): string {
  return unit.kind === 'cell'
    ? `cell:${unit.cell.id}`
    : `read-group:${unit.cells[0]?.id ?? 'empty'}`;
}

function renderUnitSignature(
  unit: TranscriptRenderUnit,
  source?: TranscriptProjectionSource,
): string {
  const cells = unit.kind === 'cell' ? [unit.cell] : unit.cells;
  return cells
    .map((cell) => {
      const revision = source?.cellRevision?.(cell);
      if (revision !== undefined) return JSON.stringify([cell.id, revision]);
      return JSON.stringify([
        cell.id,
        cell.kind,
        cell.status,
        cell.title,
        cell.content,
        cell.contentFormat,
        cell.detail,
        cell.durationMs,
        cell.updatedAtMs,
        cell.turnId,
        cell.expanded,
        cell.displayMode,
        cell.structuredPreview,
        cell.inspection,
        cell.todoItems,
        cell.agentTeam,
        cell.attachments,
        cell.userPresentation,
      ]);
    })
    .join('\u001D');
}

function isMutableCell(cell: TranscriptCell): boolean {
  return cell.status === 'pending' || cell.status === 'running' || cell.status === 'blocked';
}

function createRenderUnits(cells: readonly TranscriptCell[]): TranscriptRenderUnit[] {
  const units: TranscriptRenderUnit[] = [];
  let index = 0;
  while (index < cells.length) {
    const cell = cells[index];
    if (!cell || !isReadToolCell(cell)) {
      if (cell) units.push({ kind: 'cell', cell });
      index += 1;
      continue;
    }

    const group = [cell];
    let cursor = index + 1;
    while (cursor < cells.length) {
      const next = cells[cursor];
      if (!next || !isReadToolCell(next) || !isSameExecutionTurn(cell, next)) break;
      group.push(next);
      cursor += 1;
    }
    if (group.length >= 2) units.push({ kind: 'read-group', cells: group });
    else units.push({ kind: 'cell', cell });
    index = cursor;
  }
  return units;
}

function renderReadGroup(
  cells: readonly TranscriptCell[],
  width: number,
  connectedToNext: boolean,
  resolveDisplayMode: (cell: TranscriptCell) => ReturnType<typeof resolveTranscriptCellDisplayMode>,
): string[] {
  const entries = groupedToolEntries(cells);
  const running = entries.filter(
    ({ cell }) => cell.status === 'pending' || cell.status === 'running',
  ).length;
  const failed = entries.filter(({ cell }) => cell.status === 'failed').length;
  const marker =
    running > 0
      ? chalk.hex(colors.accent)('•')
      : failed === entries.length
        ? chalk.hex(colors.error)('×')
        : failed > 0
          ? chalk.hex(colors.warning)('!')
          : chalk.hex(colors.success)('•');
  const action = renderGroupAction(cells, running > 0);
  const failure =
    failed === entries.length
      ? chalk.hex(colors.error)(' · failed')
      : failed > 0
        ? chalk.hex(colors.error)(` · ${failed} failed`)
        : '';
  const operationCount = new Set(
    cells.map((cell) => JSON.stringify([normalizeToolName(cell.title), cell.content])),
  ).size;
  const groupLabel = groupNoun(cells);
  const noun =
    operationCount === 1
      ? groupLabel === 'searches'
        ? 'search'
        : groupLabel.slice(0, -1)
      : groupLabel;
  const attempts =
    cells.length > operationCount ? chalk.hex(colors.muted)(` · ${cells.length} calls`) : '';
  const header = `${marker} ${chalk.bold.hex(colors.text)(`${action} ${operationCount} ${noun}`)}${failure}${attempts}`;
  const lines = renderToolRow(connectedToNext ? '├' : '└', header, width);
  const groupRail = connectedToNext ? '│ ' : '  ';

  entries.forEach(({ cell, target }, index) => {
    const displayMode = resolveDisplayMode(cell);
    if (displayMode === 'collapsed') return;

    const isLast = index === entries.length - 1;
    const tail =
      cell.status === 'pending' || cell.status === 'running'
        ? chalk.hex(colors.muted)(` · ${renderGroupedToolProgress(cell)}`)
        : cell.status === 'failed'
          ? chalk.hex(colors.error)(' · failed')
          : '';
    const prefix = chalk.hex(colors.dim)(`${groupRail}${isLast ? '└' : '├'} `);
    lines.push(
      truncateToWidth(
        `${prefix}${chalk.hex(colors.text)(target)}${tail}`,
        Math.max(0, width),
        chalk.hex(colors.muted)('…'),
      ),
    );
    if (cell.detail) {
      const detailRail = `${groupRail}${isLast ? '  ' : '│ '}  `;
      const evidence = presentTranscriptToolEvidence(
        cell,
        resolveTranscriptToolDefinition(cell.title),
        {
          width,
          prefix: detailRail,
          displayMode,
        },
      );
      lines.push(
        ...(evidence.handlesDetail
          ? evidence.lines
          : displayMode === 'expanded'
            ? renderExecutionDetail(cell.detail, width, detailRail)
            : renderExecutionDetailPreview(
                cell.detail,
                width,
                detailRail,
                previewLineLimit(cell),
                undefined,
                cell.status === 'succeeded' ? 'head' : 'tail',
              )),
      );
    }
  });
  return lines;
}

function groupedToolEntries(
  cells: readonly TranscriptCell[],
): Array<{ readonly cell: TranscriptCell; readonly target: string }> {
  return cells.map((cell) => {
    const target = formatTuiToolSummary(cell.content) || 'file';
    return { cell, target };
  });
}

function renderCell(
  cell: TranscriptCell,
  width: number,
  connectedToNext: boolean,
  resolveDisplayMode: (cell: TranscriptCell) => ReturnType<typeof resolveTranscriptCellDisplayMode>,
  workspaceDir: string,
): string[] {
  if (cell.kind === 'shell') return renderShellBlock(cell, width);
  if (cell.kind === 'user') {
    return wrapSemanticMessageZone(
      cell.userPresentation === 'pending-steer'
        ? renderPendingSteerMessage(cell, width)
        : renderUserMessage(cell, width),
    );
  }

  if (cell.kind === 'assistant' || cell.kind === 'assistant-preamble') {
    const normalizedWidth = Math.max(0, Math.floor(width));
    if (normalizedWidth === 0) return [];
    const content = projectAssistantContentForTerminal(cell.content);
    const contentWidth = Math.max(1, normalizedWidth - ASSISTANT_ANCHOR_WIDTH);
    const prose = new Markdown(content.text, 0, 0, markdownTheme, {
      color: (text) => chalk.hex(colors.text)(text),
    }).render(contentWidth);
    const assets = renderDeliveredAssets(content.assets, contentWidth, workspaceDir);
    return wrapSemanticMessageZone(
      anchorAssistantLines(
        prose.length > 0 && assets.length > 0 ? [...prose, '', ...assets] : [...prose, ...assets],
        normalizedWidth,
      ),
    );
  }

  if (cell.kind === 'review') {
    const running = cell.status === 'pending' || cell.status === 'running';
    const failed = cell.status === 'failed';
    const cancelled = cell.status === 'cancelled';
    const marker = failed
      ? chalk.hex(colors.error)('×')
      : cancelled
        ? chalk.hex(colors.warning)('○')
        : chalk.hex(running ? colors.accent : colors.success)(running ? '•' : '✓');
    const heading = chalk.bold.hex(
      failed ? colors.error : cancelled ? colors.warning : colors.text,
    )(sanitizeTerminalText(cell.title ?? 'Code review'));
    const lines = [...new Text(`${marker} ${heading}`, 2, 0).render(width)];
    if (cell.content.trim()) {
      lines.push(
        ...new Text(chalk.hex(colors.text)(sanitizeTerminalText(cell.content)), 4, 0).render(width),
      );
    }
    return wrapSemanticMessageZone(lines);
  }

  if (cell.kind === 'compaction') {
    const running = cell.status === 'pending' || cell.status === 'running';
    const failed = cell.status === 'failed';
    const marker = failed ? chalk.hex(colors.error)('×') : chalk.hex(colors.accent)('•');
    const label = chalk.bold.hex(failed ? colors.error : colors.muted)(
      cell.title ??
        (running
          ? 'Compacting context'
          : failed
            ? 'Context compaction failed'
            : 'Context compacted'),
    );
    const tokenDelta =
      cell.status === 'succeeded' &&
      isNonNegativeFinite(cell.tokensBefore) &&
      isNonNegativeFinite(cell.tokensAfter)
        ? chalk.hex(colors.muted)(
            ` · ${formatCompactTokenCount(cell.tokensBefore)} → ${formatCompactTokenCount(
              cell.tokensAfter,
            )} tokens`,
          )
        : '';
    return renderToolRow(connectedToNext ? '├' : '└', `${marker} ${label}${tokenDelta}`, width);
  }

  if (cell.kind === 'turn-duration') {
    const label = cell.status === 'cancelled' ? 'Interrupted after' : 'Completed in';
    const outputRate = isPositiveFinite(cell.outputTokensPerSecond)
      ? ` · ⚡ ${cell.outputTokensPerSecondEstimated === true ? '~' : ''}${cell.outputTokensPerSecond.toFixed(1)} tok/s`
      : '';
    const summary = chalk.hex(colors.muted)(
      `  └ ${label} ${formatTuiDuration((cell.durationMs ?? 0) / 1_000)}${outputRate}`,
    );
    return [truncateToWidth(summary, Math.max(0, width), chalk.hex(colors.muted)('…'))];
  }

  if (cell.kind === 'thinking') {
    const running = cell.status === 'pending' || cell.status === 'running';
    const failed = cell.status === 'failed';
    const marker = failed ? chalk.hex(colors.error)('×') : chalk.hex(colors.accent)('•');
    const label = running
      ? chalk.bold.hex(colors.muted)('Thinking…')
      : chalk.bold.hex(failed ? colors.error : colors.muted)(formatThinkingSummary(cell));
    const lines = renderToolRow(connectedToNext ? '├' : '└', `${marker} ${label}`, width);
    const displayMode = resolveDisplayMode(cell);
    if (displayMode === 'collapsed') return lines;
    const edge = running || failed ? 'tail' : 'head';
    const detail =
      displayMode === 'preview' ? boundThinkingPreview(cell.content, edge) : cell.content;
    const sourceTruncated = detail.length < cell.content.length;
    if (detail.trim() || sourceTruncated) {
      const prefix = connectedToNext ? '│   ' : '    ';
      lines.push(
        ...(displayMode === 'expanded'
          ? renderExecutionDetail(detail, width, prefix)
          : renderExecutionDetailPreview(
              detail,
              width,
              prefix,
              3,
              undefined,
              edge,
              sourceTruncated,
            )),
      );
    }
    return lines;
  }

  if (cell.kind === 'todo') {
    return renderTodoCell(cell, width, connectedToNext);
  }

  if (cell.kind === 'tool') {
    const definition = resolveTranscriptToolDefinition(cell.title);
    const marker =
      cell.status === 'failed'
        ? chalk.hex(colors.error)('×')
        : chalk.hex(cell.status === 'succeeded' ? colors.success : colors.accent)(
            cell.status === 'succeeded' && definition?.succeededMarker === 'check' ? '✓' : '•',
          );
    const displayMode = resolveDisplayMode(cell);
    const detailPrefix = connectedToNext ? '│   ' : '    ';
    const evidence = presentTranscriptToolEvidence(cell, definition, {
      width,
      prefix: detailPrefix,
      displayMode,
    });
    const backgroundBash = isBackgroundBashTranscriptCell(cell);
    const title = styleToolAction(
      backgroundBash
        ? formatBackgroundBashAction(cell.status)
        : formatToolAction(cell.title, cell.status, cell.content, cell.toolErrorCode),
      definition?.accentLabel,
      cell.status,
    );
    const rawSummary = formatTuiToolSummary(cell.content);
    const isShellTool = definition?.family === 'shell';
    const toolSummary = isShellTool ? evidence.summary : rawSummary || evidence.summary;
    const target = toolSummary
      ? isShellTool
        ? `  ${styleShellSummary(
            toolSummary,
            width,
            visibleWidth(`${marker} ${title}`),
            !backgroundBash,
          )}`
        : chalk.hex(colors.muted)(
            definition?.summaryStyle === 'dot' ? ` · ${toolSummary}` : ` (${toolSummary})`,
          )
      : '';
    const summary = `${marker} ${title}${target}`;
    const lines = renderToolRow(connectedToNext ? '├' : '└', summary, width);
    if (displayMode !== 'collapsed' && cell.structuredPreview) {
      lines.push(
        ...renderTuiStructuredPreview(cell.structuredPreview, width, {
          prefix: connectedToNext ? '│ ' : '  ',
          maxBodyLines: displayMode === 'expanded' ? 30 : 3,
        }),
      );
    }
    if (
      displayMode !== 'collapsed' &&
      evidence.lines.length > 0 &&
      (!cell.structuredPreview || cell.status === 'failed')
    ) {
      lines.push(...evidence.lines);
    } else if (
      displayMode !== 'collapsed' &&
      cell.detail &&
      !evidence.handlesDetail &&
      (!cell.structuredPreview || cell.status === 'failed')
    ) {
      lines.push(
        ...(displayMode === 'expanded'
          ? renderExecutionDetail(cell.detail, width, detailPrefix)
          : renderExecutionDetailPreview(
              cell.detail,
              width,
              detailPrefix,
              previewLineLimit(cell),
              undefined,
              cell.status === 'succeeded' ? 'head' : 'tail',
            )),
      );
    }
    return lines;
  }

  if (cell.kind === 'delegation') {
    return renderDelegatedAgent(cell, width, connectedToNext);
  }

  if (cell.kind === 'agent-team' && cell.agentTeam) {
    return renderTuiAgentTeamSummary(cell.agentTeam, cell.status, width);
  }

  if (cell.kind === 'question') {
    if (cell.status !== 'resolved' && !cell.content.trim()) return [];
    return renderQuestionReceipt(cell, width);
  }

  if (cell.kind === 'permission') {
    return renderPermissionReceipt(cell, width);
  }

  if (cell.kind === 'inspection' && cell.inspection) {
    return renderTranscriptInspection(cell.inspection, width);
  }

  if (cell.kind === 'error') {
    return [...new Text(chalk.hex(colors.error)(`× Error  ${cell.content}`), 2, 0).render(width)];
  }

  if (cell.kind === 'warning') {
    return [
      ...new Text(chalk.hex(colors.warning)(`! Warning  ${cell.content}`), 2, 0).render(width),
    ];
  }

  return [...new Text(cell.content, 2, 0).render(width)];
}

function anchorAssistantLines(lines: readonly string[], width: number): string[] {
  if (lines.length === 0 || width <= 0) return [];
  const marker = chalk.hex(colors.text)(ASSISTANT_ANCHOR_MARKER);
  return lines.map((line, index) => {
    const prefix =
      index === 0
        ? width === 1
          ? marker
          : `${marker} `
        : ' '.repeat(Math.min(ASSISTANT_ANCHOR_WIDTH, width));
    return truncateToWidth(`${prefix}${line}`, width, '');
  });
}

function wrapSemanticMessageZone(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const lastIndex = lines.length - 1;
  if (lastIndex === 0) {
    lines[0] = `${OSC133_ZONE_START}${OSC133_ZONE_END}${OSC133_ZONE_FINAL}${lines[0] ?? ''}`;
    return lines;
  }
  lines[0] = `${OSC133_ZONE_START}${lines[0] ?? ''}`;
  lines[lastIndex] = `${OSC133_ZONE_END}${OSC133_ZONE_FINAL}${lines[lastIndex] ?? ''}`;
  return lines;
}

function renderDelegatedAgent(
  cell: TranscriptCell,
  width: number,
  connectedToNext: boolean,
): string[] {
  const presentation =
    cell.status === 'running' || cell.status === 'pending'
      ? { marker: chalk.hex(colors.accent)('●'), label: 'Running' }
      : cell.status === 'succeeded'
        ? { marker: chalk.hex(colors.success)('✓'), label: 'Done' }
        : cell.status === 'cancelled'
          ? { marker: chalk.hex(colors.muted)('■'), label: 'Stopped' }
          : { marker: chalk.hex(colors.error)('×'), label: 'Failed' };
  const agent = sanitizeDelegationLabel(cell.title, 'sub-agent');
  const task = sanitizeDelegationLabel(cell.content, 'Delegated task');
  const summary = `${presentation.marker} ${chalk.bold.hex(colors.text)(agent)} ${chalk.hex(
    colors.muted,
  )(presentation.label)}${task ? chalk.hex(colors.muted)(` · ${task}`) : ''}`;
  const lines = renderToolRow(connectedToNext ? '├' : '└', summary, width);
  if ((cell.status === 'failed' || cell.status === 'cancelled') && cell.detail?.trim()) {
    lines.push(
      ...renderExecutionDetailPreview(cell.detail, width, connectedToNext ? '│   ' : '    ', 2),
    );
  }
  return lines;
}

function sanitizeDelegationLabel(value: string | undefined, fallback: string): string {
  const sanitized = value?.replace(/[\r\n\t]+/gu, ' ').trim();
  return sanitized || fallback;
}

function renderUserIntent(content: string, width: number): string[] {
  const normalizedWidth = Math.max(0, Math.floor(width));
  if (normalizedWidth === 0) return [];
  const verticalPadding = renderUserBandLine('', normalizedWidth);
  const bodyWidth = Math.max(1, normalizedWidth - 4);
  const body = new Markdown(content, 0, 0, markdownTheme, {
    color: (text) => chalk.hex(colors.text)(text),
  }).render(bodyWidth);
  if (body.length === 0) {
    return [
      verticalPadding,
      renderUserBandLine(` ${chalk.bold.hex(colors.signal)('›')}`, normalizedWidth),
      verticalPadding,
    ];
  }
  return [
    verticalPadding,
    ...body.map((line, index) =>
      renderUserBandLine(
        `${index === 0 ? ` ${chalk.bold.hex(colors.signal)('› ')}` : '   '}${line}`,
        normalizedWidth,
      ),
    ),
    verticalPadding,
  ];
}

function renderUserMessage(cell: TranscriptCell, width: number): string[] {
  const attachments = renderUserAttachments(cell, width);
  const body = cell.content.trim() ? renderUserIntent(cell.content, width) : [];
  const rows =
    attachments.length > 0 && body.length > 0
      ? [...attachments, ' ', ...body]
      : [...attachments, ...body];
  // A cancelled user row (prompt restored to the composer on abort) stays in
  // the history with a muted marker, matching the cancelled-todo precedent.
  if (cell.status === 'cancelled') {
    return [chalk.hex(colors.muted)('× Cancelled'), ...rows];
  }
  return rows;
}

function renderPendingSteerMessage(cell: TranscriptCell, width: number): string[] {
  const normalizedWidth = Math.max(0, Math.floor(width));
  if (normalizedWidth === 0) return [];
  const presentation = pendingSteerPresentation(cell.status);
  const railIndent = ' '.repeat(Math.min(2, Math.max(0, normalizedWidth - 1)));
  const marker = chalk.hex(presentation.color)(presentation.marker);
  const label = chalk.bold.hex(presentation.color)(presentation.label);
  const heading = `${railIndent}${marker} ${label}`;
  const headingWidth = visibleWidth(heading);
  const contentWidth = Math.max(1, normalizedWidth - headingWidth - 3);
  const body = cell.content.trim()
    ? new Markdown(cell.content, 0, 0, markdownTheme, {
        color: (text) => chalk.hex(colors.text)(text),
      })
        .render(contentWidth)
        .map(trimTerminalLineEnd)
    : [];
  const attachments = (cell.attachments ?? []).map((attachment) => {
    const kind = transcriptAttachmentKind(attachment);
    return chalk.hex(colors.muted)(`${kind} · ${sanitizeTerminalText(attachment.fileName)}`);
  });
  const contentLines = [...attachments, ...body];
  if (contentLines.length === 0) {
    return [truncateToWidth(heading, normalizedWidth, '')];
  }

  const prefix = `${heading}${chalk.hex(colors.dim)(' · ')}`;
  const continuation = ' '.repeat(Math.min(normalizedWidth, visibleWidth(prefix)));
  return contentLines.map((line, index) =>
    truncateToWidth(
      `${index === 0 ? prefix : continuation}${line}`,
      normalizedWidth,
      chalk.hex(colors.muted)('…'),
    ),
  );
}

function pendingSteerPresentation(status: TranscriptCell['status']): {
  marker: '↳' | '×';
  label: string;
  color: string;
} {
  if (status === 'pending' || status === 'running') {
    return { marker: '↳', label: 'Next', color: colors.signal };
  }
  if (status === 'failed') {
    return { marker: '×', label: 'May not have applied', color: colors.error };
  }
  return { marker: '×', label: 'Not applied', color: colors.muted };
}

function trimTerminalLineEnd(line: string): string {
  const trimmedWidth = visibleWidth(stripAnsi(line).trimEnd());
  return truncateToWidth(line, trimmedWidth, '');
}

function renderUserAttachments(cell: TranscriptCell, width: number): string[] {
  const normalizedWidth = Math.max(0, Math.floor(width));
  if (normalizedWidth === 0 || !cell.attachments?.length) return [];
  return cell.attachments.flatMap((attachment) => {
    const kind = transcriptAttachmentKind(attachment);
    const name = sanitizeTerminalText(attachment.fileName) || 'attachment';
    const mime = sanitizeTerminalText(attachment.mimeType) || 'application/octet-stream';
    const size =
      attachment.sizeBytes === undefined ? '' : ` · ${formatAttachmentBytes(attachment.sizeBytes)}`;
    return [
      truncateToWidth(
        `${chalk.hex(colors.border)('┌')} ${chalk.bold.hex(colors.text)(kind)}  ${chalk.hex(colors.text)(name)}`,
        normalizedWidth,
        chalk.hex(colors.muted)('…'),
      ),
      truncateToWidth(
        `${chalk.hex(colors.border)('└')} ${chalk.hex(colors.muted)(`${mime}${size}`)}`,
        normalizedWidth,
        chalk.hex(colors.muted)('…'),
      ),
    ];
  });
}

function transcriptAttachmentKind(attachment: TranscriptAttachment): 'Image' | 'Video' | 'File' {
  if (attachment.type === 'image') return 'Image';
  if (attachment.mimeType.startsWith('video/')) return 'Video';
  return 'File';
}

function formatAttachmentBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${String(sizeBytes)} B`;
  if (sizeBytes < 1024 * 1024) return `${formatAttachmentUnit(sizeBytes / 1024)} KB`;
  if (sizeBytes < 1024 * 1024 * 1024) {
    return `${formatAttachmentUnit(sizeBytes / (1024 * 1024))} MB`;
  }
  return `${formatAttachmentUnit(sizeBytes / (1024 * 1024 * 1024))} GB`;
}

function formatAttachmentUnit(value: number): string {
  return value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function renderUserBandLine(content: string, width: number): string {
  const clipped = truncateToWidth(content, width, '');
  const padded = `${clipped}${' '.repeat(Math.max(0, width - visibleWidth(clipped)))}`;
  return chalk.bgHex(colors.userMessageBg)(padded);
}

function renderToolRow(connector: '├' | '└', content: string, width: number): string[] {
  const prefix = chalk.hex(colors.dim)(`${connector} `);
  return [truncateToWidth(`${prefix}${content}`, Math.max(0, width), chalk.hex(colors.muted)('…'))];
}

/**
 * Fit a shell execution summary into the remaining row width.
 *
 * The trailing output count is the cheapest signal to keep intact, so the
 * command is trimmed first instead of letting the row truncation drop the
 * count off the end.
 */
function fitShellSummary(summary: string, width: number, usedWidth: number): string {
  const available = Math.max(0, width - usedWidth - TOOL_ROW_CONNECTOR_WIDTH - 2);
  if (available <= 0 || visibleWidth(summary) <= available) return summary;
  const index = shellOutputSummaryIndex(summary);
  if (index <= 0) return truncateToWidth(summary, available, '…');
  const command = summary.slice(0, index);
  const tail = summary.slice(index);
  const commandWidth = available - visibleWidth(tail);
  if (commandWidth < MIN_SHELL_COMMAND_WIDTH) return truncateToWidth(summary, available, '…');
  return `${truncateToWidth(command, commandWidth, '…')}${tail}`;
}

function styleShellSummary(
  summary: string,
  width: number,
  usedWidth: number,
  highlightCommand: boolean,
): string {
  const fitted = fitShellSummary(summary, width, usedWidth);
  if (!highlightCommand) return chalk.hex(colors.muted)(fitted);

  const index = shellOutputSummaryIndex(fitted);
  if (index <= 0) return highlightTuiShellCommand(fitted);
  return `${highlightTuiShellCommand(fitted.slice(0, index))}${chalk.hex(colors.muted)(
    fitted.slice(index),
  )}`;
}

function shellOutputSummaryIndex(summary: string): number {
  return / · (?:\d+ output lines?|no output)$/u.exec(summary)?.index ?? -1;
}

// Bound work before ANSI styling, wrapping and width measurement. The cell retains
// the full text for expanded details and the Transcript inspector.
const THINKING_PREVIEW_MAX_CHARS = 2_000;

function boundThinkingPreview(detail: string, edge: 'head' | 'tail'): string {
  if (detail.length <= THINKING_PREVIEW_MAX_CHARS) return detail;
  // Do not leave half of a UTF-16 surrogate pair at the cut boundary.
  return edge === 'head'
    ? detail.slice(0, THINKING_PREVIEW_MAX_CHARS).replace(/[\uD800-\uDBFF]$/u, '')
    : detail.slice(-THINKING_PREVIEW_MAX_CHARS).replace(/^[\uDC00-\uDFFF]/u, '');
}

function renderExecutionDetail(detail: string, width: number, rawPrefix = '  │ '): string[] {
  const prefix = chalk.hex(colors.dim)(rawPrefix);
  const contentWidth = Math.max(1, width - visibleLength(rawPrefix));
  return new Text(chalk.hex(colors.muted)(sanitizeTerminalText(detail)), 0, 0)
    .render(contentWidth)
    .map((line) => truncateToWidth(`${prefix}${line}`, Math.max(0, width), ''));
}

function renderExecutionDetailPreview(
  detail: string,
  width: number,
  rawPrefix: string,
  maxLines: number,
  expandHint?: string,
  edge: 'head' | 'tail' = 'tail',
  sourceTruncated = false,
): string[] {
  const rendered = renderExecutionDetail(detail, width, rawPrefix);
  if (rendered.length <= maxLines && !sourceTruncated) return rendered;

  const omitted = rendered.length - maxLines;
  const prefix = chalk.hex(colors.dim)(rawPrefix);
  const direction = edge === 'head' ? 'more' : 'earlier';
  const omission = sourceTruncated
    ? `${direction} content`
    : `${omitted} ${direction} ${omitted === 1 ? 'line' : 'lines'}`;
  const hint = chalk.hex(colors.muted)(`… ${omission}${expandHint ? ` · ${expandHint}` : ''}`);
  const hintLine = truncateToWidth(
    `${prefix}${hint}`,
    Math.max(0, width),
    chalk.hex(colors.muted)('…'),
  );
  return edge === 'head'
    ? [...rendered.slice(0, maxLines), hintLine]
    : [hintLine, ...rendered.slice(-maxLines)];
}

function renderTodoCell(cell: TranscriptCell, width: number, connectedToNext: boolean): string[] {
  const items = cell.todoItems ?? [];
  const completed = items.filter((item) => item.status === 'completed').length;
  const cancelled = items.filter((item) => item.status === 'cancelled').length;
  const active = items.some((item) => item.status === 'in_progress');
  const pending = items.some((item) => item.status === 'pending');
  const marker = chalk.hex(active || pending ? colors.accent : colors.success)('•');
  const cancelledLabel = cancelled > 0 ? chalk.hex(colors.muted)(` · ${cancelled} cancelled`) : '';
  const header = `${marker} ${chalk.bold.hex(colors.text)(`Todo list ${completed}/${items.length}`)}${cancelledLabel}`;
  const lines = renderToolRow(connectedToNext ? '├' : '└', header, width);
  const rail = connectedToNext ? '│   ' : '    ';

  for (const item of items) {
    const presentation = todoItemPresentation(item.status);
    const firstPrefix = `${rail}${presentation.marker} `;
    const nextPrefix = `${rail}  `;
    const contentWidth = Math.max(1, width - visibleLength(firstPrefix));
    const wrapped = new Text(presentation.text(item.content), 0, 0).render(contentWidth);
    wrapped.forEach((line, index) => {
      const prefix = chalk.hex(colors.dim)(index === 0 ? firstPrefix : nextPrefix);
      lines.push(truncateToWidth(`${prefix}${line}`, Math.max(0, width), ''));
    });
  }
  return lines;
}

function todoItemPresentation(status: NonNullable<TranscriptCell['todoItems']>[number]['status']): {
  marker: string;
  text: (content: string) => string;
} {
  if (status === 'completed') {
    return {
      marker: chalk.hex(colors.success)('✓'),
      text: (content) => chalk.hex(colors.muted).strikethrough(content),
    };
  }
  if (status === 'in_progress') {
    return {
      marker: chalk.hex(colors.accent)('●'),
      text: (content) => chalk.hex(colors.text)(content),
    };
  }
  if (status === 'cancelled') {
    return {
      marker: chalk.hex(colors.muted)('×'),
      text: (content) => chalk.hex(colors.muted).strikethrough(content),
    };
  }
  return {
    marker: chalk.hex(colors.muted)('○'),
    text: (content) => chalk.hex(colors.muted)(content),
  };
}

function previewLineLimit(cell: TranscriptCell): number {
  const definition = resolveTranscriptToolDefinition(cell.title);
  if (definition?.previewLines) {
    if (cell.status === 'failed') return definition.previewLines.failed;
    if (cell.status === 'succeeded') return definition.previewLines.completed;
    return definition.previewLines.running;
  }
  return cell.status === 'failed' ? 8 : 3;
}

function visibleLength(value: string): number {
  return Array.from(value).length;
}

function renderPermissionReceipt(cell: TranscriptCell, width: number): string[] {
  if (cell.status !== 'resolved') return [];
  const denied = cell.detail?.startsWith('Denied') ?? false;
  const color = denied ? colors.error : resolveTuiDecisionColor('permission', true);
  const marker = denied ? '×' : '✓';
  const title = cell.detail ?? `Resolved: ${cell.title ?? 'tool action'}`;
  const heading = truncateToWidth(
    `${chalk.bold.hex(color)(marker)} ${chalk.bold.hex(colors.text)(title)}`,
    Math.max(0, width),
    '',
  );
  return [heading];
}

function renderQuestionReceipt(cell: TranscriptCell, width: number): string[] {
  const contentWidth = Math.max(1, width - 2);
  const detail = cell.detail
    ? new Text(chalk.hex(colors.muted)(cell.detail), 0, 0)
        .render(contentWidth)
        .map((line) => truncateToWidth(`  ${line}`, Math.max(0, width), ''))
    : [];

  // Plan Review surfaces the frozen plan as readable Markdown so the terminal's
  // native scrollback owns reading it; the decision panel below stays compact.
  if (cell.contentFormat === 'markdown') {
    const resolved = cell.status === 'resolved';
    const marker = resolved ? '✓' : '◆';
    const color = resolved ? colors.success : colors.signal;
    const heading = truncateToWidth(
      `${chalk.bold.hex(color)(marker)} ${chalk.bold.hex(colors.text)(cell.title ?? 'Plan Review')}`,
      Math.max(0, width),
      '',
    );
    const body = new Markdown(cell.content, 0, 0, markdownTheme, {
      color: (text) => chalk.hex(colors.text)(text),
    })
      .render(contentWidth)
      .map((line) => truncateToWidth(`  ${line}`, Math.max(0, width), ''));
    return [heading, ...body, ...detail];
  }

  const presentation =
    cell.status === 'resolved'
      ? { marker: '✓', title: cell.title ?? 'Answers sent', color: colors.success }
      : cell.status === 'pending'
        ? { marker: '●', title: 'Sending answers…', color: colors.accent }
        : { marker: '◆', title: 'Answers so far', color: colors.signal };
  const heading = truncateToWidth(
    `${chalk.bold.hex(presentation.color)(presentation.marker)} ${chalk.bold.hex(colors.text)(presentation.title)}`,
    Math.max(0, width),
    '',
  );
  const content = new Text(chalk.hex(colors.text)(cell.content), 0, 0)
    .render(contentWidth)
    .map((line) => truncateToWidth(`  ${line}`, Math.max(0, width), ''));
  return [heading, ...content, ...detail];
}

export function resolveTuiDecisionColor(
  kind: 'permission' | 'question',
  resolved: boolean,
): string {
  if (resolved) return colors.success;
  return kind === 'permission' ? colors.warning : colors.signal;
}

function isConnectedExecution(cell: TranscriptCell, next: TranscriptCell | undefined): boolean {
  if (!next || !isExecutionCell(cell) || !isExecutionCell(next)) return false;
  if (cell.turnId && next.turnId) return cell.turnId === next.turnId;
  return !cell.turnId && !next.turnId;
}

function isExecutionCell(cell: TranscriptCell): boolean {
  return cell.kind === 'thinking' || cell.kind === 'todo' || cell.kind === 'tool';
}

function isReadToolCell(cell: TranscriptCell): boolean {
  if (cell.kind !== 'tool') return false;
  const title = cell.title?.trim().toLocaleLowerCase().replaceAll('-', '_');
  return (
    title === 'read' ||
    title === 'read_file' ||
    title === 'readfile' ||
    title === 'grep' ||
    title === 'search' ||
    title === 'glob' ||
    title === 'list' ||
    title === 'list_files'
  );
}

function groupNoun(cells: readonly TranscriptCell[]): string {
  const titles = new Set(
    cells
      .map((cell) => cell.title?.trim().toLocaleLowerCase().replaceAll('-', '_'))
      .filter((title): title is string => Boolean(title)),
  );
  if (readGroupCategories(titles).size > 1) return 'operations';
  if (titles.has('grep') || titles.has('search')) return 'searches';
  if (titles.has('glob') || titles.has('list') || titles.has('list_files')) return 'paths';
  return 'files';
}

function renderGroupAction(cells: readonly TranscriptCell[], running: boolean): string {
  const titles = new Set(
    cells
      .map((cell) => cell.title?.trim().toLocaleLowerCase().replaceAll('-', '_'))
      .filter((title): title is string => Boolean(title)),
  );
  if (readGroupCategories(titles).size > 1) return running ? 'Exploring' : 'Explored';
  if (titles.has('grep') || titles.has('search')) return running ? 'Searching' : 'Searched';
  if (titles.has('glob') || titles.has('list') || titles.has('list_files')) {
    return running ? 'Listing' : 'Listed';
  }
  return running ? 'Reading' : 'Read';
}

function readGroupCategories(titles: ReadonlySet<string>): Set<'read' | 'search' | 'list'> {
  const categories = new Set<'read' | 'search' | 'list'>();
  titles.forEach((title) => {
    if (title === 'grep' || title === 'search') categories.add('search');
    else if (title === 'glob' || title === 'list' || title === 'list_files') {
      categories.add('list');
    } else {
      categories.add('read');
    }
  });
  return categories;
}

function renderGroupedToolProgress(cell: TranscriptCell): string {
  const title = cell.title?.trim().toLocaleLowerCase().replaceAll('-', '_');
  if (title === 'grep' || title === 'search') return 'searching';
  if (title === 'glob' || title === 'list' || title === 'list_files') return 'listing';
  return 'reading';
}

function isSameExecutionTurn(left: TranscriptCell, right: TranscriptCell): boolean {
  if (left.turnId && right.turnId) return left.turnId === right.turnId;
  return !left.turnId && !right.turnId;
}

function isConnectedRenderUnit(
  unit: TranscriptRenderUnit,
  next: TranscriptRenderUnit | undefined,
): boolean {
  if (!next) return false;
  const last = unit.kind === 'read-group' ? unit.cells[unit.cells.length - 1] : unit.cell;
  const first = next.kind === 'read-group' ? next.cells[0] : next.cell;
  return Boolean(last && first && isConnectedExecution(last, first));
}

function isPendingSteerUnit(unit: TranscriptRenderUnit): boolean {
  return unit.kind === 'cell' && unit.cell.userPresentation === 'pending-steer';
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}` : value;
}

function formatToolAction(
  title: string | undefined,
  status: TranscriptCell['status'],
  content?: string,
  toolErrorCode?: string,
): string {
  const normalized = normalizeToolName(title);
  const running = status === 'pending' || status === 'running';
  const definition = resolveTranscriptToolDefinition(normalized);
  if (definition) {
    if (definition.family === 'read' && isImageReadContent(content)) {
      if (status === 'failed') return 'Image read failed';
      return running ? 'Reading Image' : 'Read Image';
    }
    const action =
      status === 'failed'
        ? resolveTranscriptToolFailedAction(definition, toolErrorCode)
        : running
          ? definition.runningAction
          : definition.completedAction;
    const identity = formatTranscriptToolIdentity(normalized, definition);
    return identity ? `${action} ${identity}` : action;
  }
  return normalized.split('_').filter(Boolean).map(capitalize).join(' ');
}

const IMAGE_READ_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/iu;

function isImageReadContent(content: string | undefined): boolean {
  if (!content) return false;
  let path = content.trim();
  if (path.startsWith('{')) {
    try {
      const input = JSON.parse(path) as { path?: unknown; file_path?: unknown };
      const candidate = input.path ?? input.file_path;
      if (typeof candidate !== 'string') return false;
      path = candidate;
    } catch {
      return false;
    }
  }
  return IMAGE_READ_EXTENSION.test(path.split(/[?#]/u, 1)[0] ?? '');
}

function formatBackgroundBashAction(status: TranscriptCell['status']): string {
  if (status === 'failed') return 'Background task failed';
  if (status === 'pending' || status === 'running') return 'Starting background task';
  return 'Started background task';
}

function styleToolAction(
  action: string,
  accentLabel: string | undefined,
  status: TranscriptCell['status'],
): string {
  if (status === 'failed') return chalk.bold.hex(colors.error)(action);
  if (!accentLabel) return chalk.bold.hex(colors.text)(action);
  const accentStart = action.indexOf(accentLabel);
  if (accentStart < 0) return chalk.bold.hex(colors.text)(action);
  const before = action.slice(0, accentStart);
  const after = action.slice(accentStart + accentLabel.length);
  return `${chalk.bold.hex(colors.text)(before)}${chalk.bold.hex(colors.signal)(accentLabel)}${chalk.bold.hex(colors.text)(after)}`;
}

function formatThinkingSummary(cell: TranscriptCell): string {
  const durationMs =
    cell.durationMs ?? Math.max(0, Math.floor(cell.updatedAtMs - cell.createdAtMs));
  const duration = durationMs > 0 ? ` for ${formatDuration(durationMs)}` : '';
  if (cell.status === 'cancelled') return `Thought${duration} before interruption`;
  if (cell.status === 'failed') return `Thought${duration} before failure`;
  return `Thought${duration}`;
}

function formatDuration(durationMs: number): string {
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function formatCompactTokenCount(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  })
    .format(Math.round(value))
    .replace(/[KMBT]/g, (unit) => unit.toLowerCase());
}
