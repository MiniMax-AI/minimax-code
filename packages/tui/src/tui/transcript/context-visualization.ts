import type { Component } from '../rendering/component.js';
import { truncateToWidth } from '../rendering/text.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';
import { compactionTriggerSourceLabel } from '../../application/auto-compact-command.js';
import type {
  TranscriptContextComponent,
  TranscriptContextComponentKind,
  TranscriptContextVisualization,
} from './model.js';

const COMPONENT_KINDS: readonly TranscriptContextComponentKind[] = [
  'SYSTEM_PROMPT',
  'MEMORY',
  'TOOLS',
  'SKILLS',
  'MESSAGES',
  'OTHER',
];
const COMPONENT_LABELS: Record<TranscriptContextComponentKind, string> = {
  SYSTEM_PROMPT: 'System prompt',
  MEMORY: 'Memory',
  TOOLS: 'Tools',
  SKILLS: 'Skills',
  MESSAGES: 'Messages',
  OTHER: 'Other',
};
const MAX_CONTENT_WIDTH = 128;
const WIDE_GRID_MIN_WIDTH = 80;
const SIDE_BY_SIDE_MIN_WIDTH = 48;
const GRID_GUTTER = 3;
const GRID_FILLED = '⛁';
const GRID_PARTIAL = '⛀';
const GRID_FREE = '⛶';
const GRID_COMPACTION = '⛝';

interface ContextGridCategory {
  readonly label: string;
  readonly tokens: number;
  readonly color: string;
}

interface ContextGridCell {
  readonly glyph: string;
  readonly color: string;
}

/** Transcript-native, width-safe visualization of Runtime-owned context tokens. */
export class ContextVisualization implements Component {
  constructor(private readonly data: TranscriptContextVisualization) {}

  invalidate(): void {}

  render(rawWidth: number): string[] {
    const width = Math.min(MAX_CONTENT_WIDTH, Math.max(0, Math.floor(rawWidth)));
    if (width === 0) return [];
    if (width < 8) return [truncateToWidth('Context', width, '…')];

    const components = normalizeComponents(this.data.components, this.data.usedTokens);
    const lines = [...this.header(), ''];
    if (hasContextWindow(this.data)) {
      lines.push(...this.contextMap(components, width));
    } else {
      lines.push(...this.unavailableContext(components));
    }
    lines.push('', ...this.compactionRows());
    return lines.map((line) => truncateToWidth(line, width, chalk.hex(colors.dim)('…')));
  }

  private header(): string[] {
    const title = chalk.bold.hex(colors.text)('Context');
    const health = contextHealth(this.data.utilization);
    const healthLabel = chalk.bold.hex(health.color)(health.label);
    const heading = `${title}${chalk.hex(colors.dim)(' · ')}${healthLabel}`;
    const stateLabel = this.data.snapshotState === 'stale' ? 'Last completed run' : 'Live now';
    const stateColor = this.data.snapshotState === 'stale' ? colors.warning : colors.success;
    const marker = this.data.snapshotState === 'stale' ? '○' : '●';
    const metadata = `${chalk.bold.hex(stateColor)(marker)} ${chalk.hex(stateColor)(
      stateLabel,
    )} · ${chalk.hex(colors.dim)(safeInline(this.data.model))} · ${chalk.hex(colors.dim)(
      formatBasis(this.data.basis),
    )}`;
    return [heading, metadata];
  }

  private contextMap(components: readonly TranscriptContextComponent[], width: number): string[] {
    const contextWindow = this.data.contextWindow as number;
    const gridColumns =
      width >= WIDE_GRID_MIN_WIDTH ? 10 : Math.min(5, Math.max(1, Math.floor((width + 1) / 2)));
    const gridRows = width >= WIDE_GRID_MIN_WIDTH ? 10 : 5;
    const totalCells = gridColumns * gridRows;
    const categories = gridCategories(components, this.data.usedTokens);
    const reserveTokens = compactionReserveTokens(this.data);
    const cells = planGridCells(
      categories,
      this.data.usedTokens,
      contextWindow,
      reserveTokens,
      totalCells,
    );
    const grid = renderGrid(cells, gridColumns, gridRows);
    const legend = renderLegend(
      categories,
      this.data.usedTokens,
      contextWindow,
      reserveTokens,
      components.length > 0,
    );

    if (width < SIDE_BY_SIDE_MIN_WIDTH) return [...grid, '', ...legend];

    const gridWidth = gridColumns * 2 - 1;
    const lines: string[] = [];
    const lineCount = Math.max(grid.length, legend.length);
    for (let index = 0; index < lineCount; index += 1) {
      const gridLine = grid[index] ?? ' '.repeat(gridWidth);
      const legendLine = legend[index] ?? '';
      lines.push(
        legendLine.length > 0 ? `${gridLine}${' '.repeat(GRID_GUTTER)}${legendLine}` : gridLine,
      );
    }
    return lines;
  }

  private unavailableContext(components: readonly TranscriptContextComponent[]): string[] {
    const lines = [
      chalk.bold.hex(colors.text)(`${formatCompact(this.data.usedTokens)} counted`),
      chalk.hex(colors.dim)('The context window size is unavailable.'),
    ];
    if (components.length === 0) return lines;

    lines.push('', chalk.italic.hex(colors.muted)('Usage by category'));
    for (const component of components) {
      if (component.tokens <= 0) continue;
      const color = componentColor(component.kind);
      lines.push(
        `${chalk.hex(color)(GRID_FILLED)} ${chalk.hex(colors.text)(COMPONENT_LABELS[component.kind])}: ${chalk.hex(
          colors.dim,
        )(`${formatCompact(component.tokens)} tokens`)}`,
      );
    }
    return lines;
  }

  private compactionRows(): string[] {
    const lifecycle = formatCompaction(this.data.compaction);
    const threshold = this.data.compactionThresholdTokens;
    const window = this.data.contextWindow;
    if (
      threshold === null ||
      window === null ||
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      !Number.isFinite(window) ||
      window <= 0
    ) {
      return [
        `${chalk.bold.hex(colors.muted)('Auto-compact')}${chalk.hex(colors.dim)(' · ')}${paintCompaction(
          lifecycle,
          this.data.compaction,
        )}`,
      ];
    }

    const thresholdPercent = Math.round((threshold / window) * 100);
    const distance = formatCompact(Math.max(0, threshold - this.data.usedTokens));
    const heading = `${chalk.bold.hex(colors.muted)('Auto-compact')}${chalk.hex(colors.dim)(
      ' · ',
    )}${paintCompaction(lifecycle, this.data.compaction)}`;
    const source = this.data.compactionThresholdSource;
    const detail = `Starts at ${formatCompact(threshold)} · ${thresholdPercent}% of window · ${distance} away${
      source ? ` · ${compactionTriggerSourceLabel(source)}` : ''
    }`;
    return [heading, paintCompaction(detail, this.data.compaction)];
  }
}

function normalizeComponents(
  components: readonly TranscriptContextComponent[],
  usedTokens: number,
): TranscriptContextComponent[] {
  if (components.length !== COMPONENT_KINDS.length) return [];
  const normalized = components.flatMap((component, index) =>
    component.kind === COMPONENT_KINDS[index] &&
    Number.isFinite(component.tokens) &&
    component.tokens >= 0
      ? [{ kind: component.kind, tokens: Math.floor(component.tokens) }]
      : [],
  );
  return normalized.length === COMPONENT_KINDS.length &&
    normalized.reduce((sum, component) => sum + component.tokens, 0) === Math.floor(usedTokens)
    ? normalized
    : [];
}

function contextHealth(utilization: number | null): { label: string; color: string } {
  if (utilization === null || !Number.isFinite(utilization)) {
    return { label: 'Window unavailable', color: colors.dim };
  }
  const ratio = clampRatio(utilization);
  if (ratio >= 0.95) return { label: 'Nearly full', color: colors.error };
  if (ratio >= 0.85) return { label: 'Running low', color: colors.error };
  if (ratio >= 0.7) return { label: 'Keep an eye on it', color: colors.warning };
  if (ratio >= 0.45) return { label: 'Comfortable', color: colors.signal };
  return { label: 'Plenty of room', color: colors.success };
}

function formatBasis(basis: TranscriptContextVisualization['basis']): string {
  return basis === 'provider-usage' ? 'Provider count' : 'Runtime estimate';
}

function formatCompaction(state: TranscriptContextVisualization['compaction']): string {
  if (state === 'never') return 'Not needed yet';
  if (state === 'completed') return 'Last pass completed';
  if (state === 'running') return 'Compacting now';
  return 'Last pass failed';
}

function paintCompaction(
  value: string,
  state: TranscriptContextVisualization['compaction'],
): string {
  const color =
    state === 'failed'
      ? colors.error
      : state === 'running'
        ? colors.signal
        : state === 'completed'
          ? colors.success
          : colors.dim;
  return chalk.hex(color)(value);
}

function safeInline(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, ' ').trim();
}

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function formatCompact(value: number): string {
  const amount = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (amount >= 1_000_000) return `${formatDecimal(amount / 1_000_000)}m`;
  if (amount >= 1_000) return `${formatDecimal(amount / 1_000)}k`;
  return String(Math.floor(amount));
}

function formatDecimal(value: number): string {
  return value >= 100 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function hasContextWindow(
  data: TranscriptContextVisualization,
): data is TranscriptContextVisualization & { contextWindow: number; utilization: number } {
  return (
    data.contextWindow !== null &&
    Number.isFinite(data.contextWindow) &&
    data.contextWindow > 0 &&
    data.utilization !== null &&
    Number.isFinite(data.utilization)
  );
}

function gridCategories(
  components: readonly TranscriptContextComponent[],
  usedTokens: number,
): ContextGridCategory[] {
  if (components.length === 0) {
    return usedTokens > 0
      ? [{ label: 'Used context', tokens: usedTokens, color: colors.accent }]
      : [];
  }
  return components.flatMap((component) =>
    component.tokens > 0
      ? [
          {
            label: COMPONENT_LABELS[component.kind],
            tokens: component.tokens,
            color: componentColor(component.kind),
          },
        ]
      : [],
  );
}

function componentColor(kind: TranscriptContextComponentKind): string {
  if (kind === 'SYSTEM_PROMPT') return colors.wordmarkHighlight;
  if (kind === 'MEMORY') return colors.orbit;
  if (kind === 'TOOLS') return colors.accent;
  if (kind === 'SKILLS') return colors.success;
  if (kind === 'MESSAGES') return colors.wordmarkShadow;
  return colors.muted;
}

function compactionReserveTokens(data: TranscriptContextVisualization): number {
  const window = data.contextWindow;
  const threshold = data.compactionThresholdTokens;
  if (
    window === null ||
    !Number.isFinite(window) ||
    window <= 0 ||
    threshold === null ||
    !Number.isFinite(threshold) ||
    threshold < 0
  ) {
    return 0;
  }
  const remaining = Math.max(0, window - Math.min(window, data.usedTokens));
  return Math.min(remaining, Math.max(0, window - threshold));
}

function planGridCells(
  categories: readonly ContextGridCategory[],
  usedTokens: number,
  contextWindow: number,
  reserveTokens: number,
  totalCells: number,
): ContextGridCell[] {
  const exactUsedCells = clampRatio(usedTokens / contextWindow) * totalCells;
  const usedCells = Math.min(totalCells, exactUsedCells > 0 ? Math.ceil(exactUsedCells) : 0);
  const allocations = allocateCells(categories, usedCells);
  const cells: ContextGridCell[] = [];
  for (const [index, category] of categories.entries()) {
    const count = allocations[index] ?? 0;
    for (let cell = 0; cell < count; cell += 1) {
      cells.push({ glyph: GRID_FILLED, color: category.color });
    }
  }

  const partial = exactUsedCells - Math.floor(exactUsedCells);
  if (cells.length > 0 && partial > 0 && partial < 0.7) {
    const last = cells[cells.length - 1];
    if (last) cells[cells.length - 1] = { ...last, glyph: GRID_PARTIAL };
  }

  const availableCells = totalCells - cells.length;
  const reserveCells = Math.min(
    availableCells,
    Math.max(0, Math.round(clampRatio(reserveTokens / contextWindow) * totalCells)),
  );
  const freeCells = Math.max(0, availableCells - reserveCells);
  for (let index = 0; index < freeCells; index += 1) {
    cells.push({ glyph: GRID_FREE, color: colors.dim });
  }
  for (let index = 0; index < reserveCells; index += 1) {
    cells.push({ glyph: GRID_COMPACTION, color: colors.warning });
  }
  return cells;
}

function allocateCells(categories: readonly ContextGridCategory[], cellCount: number): number[] {
  if (categories.length === 0 || cellCount <= 0) return categories.map(() => 0);
  const totalTokens = categories.reduce((sum, category) => sum + category.tokens, 0);
  if (totalTokens <= 0) return categories.map(() => 0);

  const exact = categories.map((category) => (category.tokens / totalTokens) * cellCount);
  const allocated = exact.map(Math.floor);
  let remainder = cellCount - allocated.reduce((sum, count) => sum + count, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (const entry of order) {
    if (remainder <= 0) break;
    allocated[entry.index] = (allocated[entry.index] ?? 0) + 1;
    remainder -= 1;
  }
  return allocated;
}

function renderGrid(cells: readonly ContextGridCell[], columns: number, rows: number): string[] {
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const rowCells = cells.slice(row * columns, (row + 1) * columns);
    lines.push(rowCells.map((cell) => chalk.hex(cell.color)(cell.glyph)).join(' '));
  }
  return lines;
}

function renderLegend(
  categories: readonly ContextGridCategory[],
  usedTokens: number,
  contextWindow: number,
  reserveTokens: number,
  hasBreakdown: boolean,
): string[] {
  const clampedUsed = Math.min(contextWindow, Math.max(0, usedTokens));
  const freeTokens = Math.max(0, contextWindow - clampedUsed - reserveTokens);
  const lines = [
    `${chalk.bold.hex(colors.text)(formatCompact(clampedUsed))}${chalk.hex(colors.dim)(
      `/${formatCompact(contextWindow)} tokens (${formatPercent(clampedUsed, contextWindow)} used)`,
    )}`,
    '',
    chalk.italic.hex(colors.muted)('Usage by category'),
  ];

  for (const category of categories) {
    lines.push(
      `${chalk.hex(category.color)(GRID_FILLED)} ${chalk.hex(colors.text)(category.label)}: ${chalk.hex(
        colors.dim,
      )(
        `${formatCompact(category.tokens)} tokens (${formatPercent(category.tokens, contextWindow)})`,
      )}`,
    );
  }
  lines.push(
    `${chalk.hex(colors.dim)(GRID_FREE)} ${chalk.hex(colors.text)('Free space')}: ${chalk.hex(
      colors.dim,
    )(`${formatCompact(freeTokens)} (${formatPercent(freeTokens, contextWindow)})`)}`,
  );
  if (reserveTokens > 0) {
    lines.push(
      `${chalk.hex(colors.warning)(GRID_COMPACTION)} ${chalk.hex(colors.muted)(
        'Auto-compact buffer',
      )}: ${chalk.hex(colors.dim)(
        `${formatCompact(reserveTokens)} tokens (${formatPercent(reserveTokens, contextWindow)})`,
      )}`,
    );
  }
  if (!hasBreakdown) {
    lines.push('', chalk.hex(colors.dim)('Breakdown by category is not ready yet.'));
  }
  return lines;
}

function formatPercent(part: number, whole: number): string {
  if (!Number.isFinite(whole) || whole <= 0) return '0%';
  const percentage = (Math.max(0, part) / whole) * 100;
  if (percentage > 0 && percentage < 0.1) return '<0.1%';
  return `${percentage.toFixed(1).replace(/\.0$/u, '')}%`;
}
