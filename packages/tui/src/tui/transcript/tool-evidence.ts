import type { TranscriptCell, TranscriptDisplayMode } from './model.js';
import { normalizeToolName, type TranscriptToolDefinition } from './tool-definitions.js';
import { Text } from '../engine/public.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import { truncateToWidth, visibleWidth } from '../rendering/text.js';
import { highlightFileLines, highlightSyntaxLines } from './presentation/syntax-highlight.js';
import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';
import { highlightTuiShellCommandLines, resolveTuiShellCommand } from '../theme/shell-command.js';

export interface TranscriptToolEvidenceOptions {
  readonly width: number;
  readonly prefix: string;
  readonly displayMode: TranscriptDisplayMode;
}

export interface TranscriptToolEvidence {
  readonly summary?: string;
  readonly lines: readonly string[];
  readonly handlesDetail: boolean;
}

interface ToolArguments {
  readonly description?: string;
  readonly path?: string;
  readonly query?: string;
  readonly taskId?: string;
  readonly offset?: number;
  readonly runInBackground?: boolean;
}

const BASH_BACKGROUND_RESULT_PATTERN = /<bash_background\b/iu;
const BASH_BACKGROUND_TASK_ID_PATTERN = /<bash_background\b[^>]*\btask_id=["']([^"']+)["']/iu;

/**
 * Reduce a shell command to a single summary-safe line.
 *
 * The execution summary row must stay on one line, so only the first line of a
 * multiline command (heredocs, commit messages) is kept and an ellipsis marks
 * the omitted remainder.
 */
export function summarizeShellCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const sanitized = sanitizeTerminalText(command);
  const lines = sanitized.split(/\r\n?|\n/u);
  const first = lines[0]?.trim() ?? '';
  if (!first) return undefined;
  const hasMore = lines.slice(1).some((line) => line.trim().length > 0);
  return hasMore ? `${first}…` : first;
}

/**
 * Join the shell command with its output summary for the collapsed row.
 *
 * The command is the subject and leads, matching how read/search summaries put
 * their path or query first.
 */
export function composeShellSummary(
  command: string | undefined,
  outputSummary: string | undefined,
): string | undefined {
  const subject = summarizeShellCommand(command);
  return [subject, outputSummary].filter(Boolean).join(' · ') || undefined;
}

export function isBackgroundBashTranscriptCell(cell: TranscriptCell): boolean {
  return isBackgroundBashToolPayload(cell.title, cell.content, cell.detail);
}

export function isBackgroundBashToolPayload(
  title: string | undefined,
  content: string,
  detail: string | undefined,
): boolean {
  if (normalizeToolName(title) !== 'bash') return false;
  return (
    isExplicitBackgroundBashToolPayload(title, content) ||
    BASH_BACKGROUND_RESULT_PATTERN.test(detail ?? '')
  );
}

export function isExplicitBackgroundBashToolPayload(
  title: string | undefined,
  content: string,
): boolean {
  return (
    normalizeToolName(title) === 'bash' && parseToolArguments(content).runInBackground === true
  );
}

export function presentTranscriptToolEvidence(
  cell: TranscriptCell,
  definition: TranscriptToolDefinition | undefined,
  options: TranscriptToolEvidenceOptions,
): TranscriptToolEvidence {
  const args = parseToolArguments(cell.content);
  const family = definition?.family;
  if (isBackgroundBashTranscriptCell(cell)) {
    return presentBackgroundBashEvidence(cell, options);
  }
  if (family === 'shell') return presentShellEvidence(cell, options);
  if (family === 'read') return presentReadEvidence(cell, args, options);
  if (family === 'search') return presentSearchEvidence(cell, args, options);
  if (family === 'task-control') return presentTaskControlEvidence(cell, args, options);
  return presentGenericEvidence(cell, options);
}

function presentTaskControlEvidence(
  cell: TranscriptCell,
  args: ToolArguments,
  options: TranscriptToolEvidenceOptions,
): TranscriptToolEvidence {
  const name = normalizeToolName(cell.title);
  const summary =
    name === 'task_output'
      ? [abbreviateTaskId(args.taskId), taskOutputFailureSummary(cell)].filter(Boolean).join(' · ')
      : summarizeTaskQuery(cell.detail, args.taskId);
  if (cell.status === 'failed') return presentFailureEvidence(cell.detail, summary, options);
  return { ...presentGenericEvidence(cell, options), ...(summary ? { summary } : {}) };
}

function taskOutputFailureSummary(cell: TranscriptCell): string | undefined {
  if (cell.status !== 'failed') return undefined;
  const detail = cell.detail ?? '';
  if (/\b(?:local\s+)?background\s+task\s+not\s+found\b/iu.test(detail)) {
    return 'task not found';
  }
  if (/\bowned\s+by\s+another\s+session\b/iu.test(detail)) return 'access denied';
  return 'failed';
}

function summarizeTaskQuery(detail: string | undefined, taskId: string | undefined): string {
  const statuses = [
    ...(detail ?? '').matchAll(
      /\[[^/\]\s]+\/(queued|running|stopping|succeeded|failed|canceled|lost)\]/giu,
    ),
  ].map((match) => match[1]?.toLocaleLowerCase());
  if (statuses.length > 0) {
    const done = statuses.filter(
      (status) =>
        status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'lost',
    ).length;
    return done === statuses.length ? `${done} done` : `${done}/${statuses.length} done`;
  }
  if (/\bno\s+local\s+background\s+tasks\b/iu.test(detail ?? '')) return 'no tasks';
  return abbreviateTaskId(taskId) ?? '';
}

function abbreviateTaskId(taskId: string | undefined): string | undefined {
  if (!taskId) return undefined;
  return taskId.length > 7 ? `${taskId.slice(0, 6)}…` : taskId;
}

function presentBackgroundBashEvidence(
  cell: TranscriptCell,
  options: TranscriptToolEvidenceOptions,
): TranscriptToolEvidence {
  const commandEvidence = presentShellEvidence(
    { ...cell, status: 'running', detail: undefined },
    options,
  );
  const failureEvidence =
    cell.status === 'failed'
      ? presentFailureEvidence(cell.detail, undefined, options)
      : { lines: [] as readonly string[] };
  const taskId = BASH_BACKGROUND_TASK_ID_PATTERN.exec(cell.detail ?? '')?.[1];
  return {
    summary: [parseToolArguments(cell.content).description, taskId].filter(Boolean).join(' · '),
    lines: [...commandEvidence.lines, ...failureEvidence.lines],
    handlesDetail: true,
  };
}

function presentShellEvidence(
  cell: TranscriptCell,
  options: TranscriptToolEvidenceOptions,
): TranscriptToolEvidence {
  const output = cleanLines(cell.detail);
  const command = resolveTuiShellCommand(cell.content)?.trim();
  const lines: string[] = [];
  if (options.displayMode !== 'collapsed' && command) {
    const highlighted = highlightTuiShellCommandLines(command);
    const commandLimit = options.displayMode === 'expanded' ? highlighted.length : 2;
    highlighted.slice(0, commandLimit).forEach((line, index) => {
      const prompt = index === 0 ? chalk.bold.hex(colors.signal)('$ ') : '  ';
      lines.push(toolLine(`${prompt}${line}`, options));
    });
    if (highlighted.length > commandLimit) {
      lines.push(
        toolLine(
          chalk.hex(colors.muted)(`… ${highlighted.length - commandLimit} more command lines`),
          options,
        ),
      );
    }
  }

  if (options.displayMode !== 'collapsed') {
    if (output.length > 0) {
      const outputLimit =
        options.displayMode === 'expanded' ? output.length : cell.status === 'failed' ? 6 : 3;
      const selection = selectOutputLines(
        output,
        outputLimit,
        cell.status === 'running' || cell.status === 'pending' || cell.status === 'failed'
          ? 'tail'
          : 'head-tail',
      );
      selection.forEach((entry) => {
        if (entry.kind === 'omitted') {
          lines.push(toolLine(chalk.hex(colors.muted)(entry.label), options));
          return;
        }
        const rail = chalk.hex(colors.dim)('│ ');
        const outputLine =
          cell.status === 'failed'
            ? chalk.hex(colors.error)(entry.value)
            : chalk.hex(colors.muted)(entry.value);
        lines.push(toolLine(`${rail}${outputLine}`, options));
      });
    } else if (cell.status === 'succeeded') {
      lines.push(toolLine(chalk.hex(colors.dim)('(no output)'), options));
    }
  }

  return {
    summary: composeShellSummary(
      parseToolArguments(cell.content).description || command,
      shellOutputSummary(output.length, cell.status),
    ),
    lines,
    handlesDetail: true,
  };
}

function shellOutputSummary(
  outputLength: number,
  status: TranscriptCell['status'],
): string | undefined {
  if (outputLength > 0) {
    return `${outputLength} output ${outputLength === 1 ? 'line' : 'lines'}`;
  }
  return status === 'succeeded' ? 'no output' : undefined;
}

function presentReadEvidence(
  cell: TranscriptCell,
  args: ToolArguments,
  options: TranscriptToolEvidenceOptions,
): TranscriptToolEvidence {
  const path = args.path ?? (looksLikeJson(cell.content) ? undefined : cell.content.trim());
  if (cell.status === 'failed') return presentFailureEvidence(cell.detail, path, options);
  const parsed = parseReadLines(cell.detail, args.offset ?? 1);
  const lines: string[] = [];
  if (options.displayMode !== 'collapsed' && parsed.length > 0) {
    const numberWidth = String(parsed.at(-1)?.number ?? parsed.length).length;
    const highlighted = highlightFileLines(parsed.map((entry) => entry.code).join('\n'), path);
    const visualLines = parsed.flatMap((entry, index) => {
      const gutter = `${chalk.hex(colors.dim)(String(entry.number).padStart(numberWidth))} ${chalk.hex(
        colors.line,
      )('│')} `;
      const continuation = `${' '.repeat(numberWidth)} ${chalk.hex(colors.line)('│')} `;
      return wrapToolCodeLine(highlighted[index] ?? entry.code, gutter, continuation, options);
    });
    const limit = options.displayMode === 'expanded' ? visualLines.length : 3;
    const selection = selectOutputLines(
      visualLines,
      limit,
      cell.status === 'running' || cell.status === 'pending' ? 'tail' : 'head-tail',
    );
    selection.forEach((entry) => {
      lines.push(
        entry.kind === 'line'
          ? entry.value
          : toolLine(chalk.hex(colors.muted)(entry.label), options),
      );
    });
  }

  const count = parsed.length;
  return {
    summary: [path, count > 0 ? `${count} ${count === 1 ? 'line' : 'lines'}` : undefined]
      .filter(Boolean)
      .join(' · '),
    lines,
    handlesDetail: true,
  };
}

function presentSearchEvidence(
  cell: TranscriptCell,
  args: ToolArguments,
  options: TranscriptToolEvidenceOptions,
): TranscriptToolEvidence {
  const results = cleanLines(cell.detail);
  if (cell.status === 'failed') return presentFailureEvidence(cell.detail, args.query, options);
  const normalizedName = normalizeToolName(cell.title);
  const isList =
    normalizedName === 'glob' || normalizedName === 'list' || normalizedName === 'list_files';
  const noun = isList ? 'file' : 'match';
  const lines: string[] = [];
  if (options.displayMode !== 'collapsed') {
    const limit = options.displayMode === 'expanded' ? results.length : 3;
    results.slice(0, limit).forEach((result) => {
      lines.push(toolLine(`${chalk.hex(colors.dim)('│')} ${colorSearchResult(result)}`, options));
    });
    if (results.length > limit) {
      const remaining = results.length - limit;
      lines.push(
        toolLine(
          chalk.hex(colors.muted)(`… ${remaining} more ${remaining === 1 ? noun : `${noun}es`}`),
          options,
        ),
      );
    }
  }
  const countLabel = `${results.length} ${results.length === 1 ? noun : `${noun}es`}`;
  return {
    summary: [args.query, countLabel].filter(Boolean).join(' · '),
    lines,
    handlesDetail: true,
  };
}

function presentGenericEvidence(
  cell: TranscriptCell,
  options: TranscriptToolEvidenceOptions,
): TranscriptToolEvidence {
  if (options.displayMode === 'collapsed' || !cell.detail?.trim()) {
    return { lines: [], handlesDetail: false };
  }
  const normalized = normalizeJson(cell.detail);
  if (!normalized) return { lines: [], handlesDetail: false };
  const source = cleanLines(normalized);
  const limit =
    options.displayMode === 'expanded' ? source.length : cell.status === 'failed' ? 8 : 3;
  const highlighted = highlightSyntaxLines(source.slice(0, limit).join('\n'), 'json');
  const lines = highlighted.map((line) =>
    toolLine(`${chalk.hex(colors.dim)('│')} ${line}`, options),
  );
  if (source.length > limit) {
    lines.push(toolLine(chalk.hex(colors.muted)(`… ${source.length - limit} more lines`), options));
  }
  return { lines, handlesDetail: true };
}

function presentFailureEvidence(
  detail: string | undefined,
  summary: string | undefined,
  options: TranscriptToolEvidenceOptions,
): TranscriptToolEvidence {
  if (options.displayMode === 'collapsed') {
    return { summary, lines: [], handlesDetail: true };
  }
  const source = cleanLines(detail);
  const limit = options.displayMode === 'expanded' ? source.length : 6;
  const selection = selectOutputLines(source, limit, 'tail');
  const lines = selection.map((entry) =>
    entry.kind === 'line'
      ? toolLine(
          `${chalk.bold.hex(colors.error)('×')} ${chalk.hex(colors.error)(entry.value)}`,
          options,
        )
      : toolLine(chalk.hex(colors.muted)(entry.label), options),
  );
  return { summary, lines, handlesDetail: true };
}

function parseToolArguments(content: string): ToolArguments {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Readonly<Record<string, unknown>>;
  return {
    description: summarizeShellCommand(stringValue(record.description)),
    path: stringValue(record.path) ?? stringValue(record.filePath) ?? stringValue(record.file_path),
    query: stringValue(record.query) ?? stringValue(record.pattern),
    taskId: stringValue(record.task_id),
    offset: numberValue(record.offset),
    runInBackground:
      typeof record.run_in_background === 'boolean' ? record.run_in_background : undefined,
  };
}

function parseReadLines(
  detail: string | undefined,
  fallbackStart: number,
): Array<{ number: number; code: string }> {
  const lines = cleanLines(detail);
  const numbered = lines.map((line) => /^\s*(\d+)\s*[|│]\s?(.*)$/u.exec(line));
  const numberedCount = numbered.filter(Boolean).length;
  if (numberedCount > 0 && numberedCount >= Math.ceil(lines.length / 2)) {
    return lines.flatMap((line, index) => {
      const match = numbered[index];
      return match ? [{ number: Number(match[1]), code: match[2] ?? '' }] : [];
    });
  }
  return lines.map((code, index) => ({ number: fallbackStart + index, code }));
}

function cleanLines(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return sanitizeTerminalText(value).replace(/\r\n?/gu, '\n').replace(/\n+$/u, '').split('\n');
}

type OutputSelection =
  | { readonly kind: 'line'; readonly value: string }
  | { readonly kind: 'omitted'; readonly label: string };

function selectOutputLines(
  lines: readonly string[],
  limit: number,
  edge: 'tail' | 'head-tail',
): OutputSelection[] {
  if (lines.length <= limit) return lines.map((value) => ({ kind: 'line', value }));
  const omitted = lines.length - limit;
  if (edge === 'tail') {
    return [
      { kind: 'omitted', label: `… ${omitted} earlier ${omitted === 1 ? 'line' : 'lines'}` },
      ...lines.slice(-limit).map((value) => ({ kind: 'line' as const, value })),
    ];
  }
  const headCount = Math.max(1, limit - 1);
  return [
    ...lines.slice(0, headCount).map((value) => ({ kind: 'line' as const, value })),
    { kind: 'omitted', label: `… ${omitted} ${omitted === 1 ? 'line' : 'lines'} hidden` },
    ...lines.slice(-1).map((value) => ({ kind: 'line' as const, value })),
  ];
}

function colorSearchResult(result: string): string {
  const match = /^(.*?)(:\d+(?::\d+)?:)(.*)$/u.exec(result);
  if (!match) return chalk.hex(colors.muted)(result);
  return `${chalk.hex(colors.text)(match[1] ?? '')}${chalk.hex(colors.accent)(match[2] ?? '')}${chalk.hex(
    colors.muted,
  )(match[3] ?? '')}`;
}

function normalizeJson(value: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(value) as unknown, undefined, 2);
  } catch {
    return undefined;
  }
}

function toolLine(value: string, options: TranscriptToolEvidenceOptions): string {
  const normalizedWidth = Math.max(0, Math.floor(options.width));
  if (normalizedWidth === 0) return '';
  const prefix = chalk.hex(colors.dim)(options.prefix);
  const available = Math.max(1, normalizedWidth - visibleWidth(options.prefix));
  return `${prefix}${truncateToWidth(value, available, chalk.hex(colors.muted)('…'))}`;
}

function wrapToolCodeLine(
  value: string,
  firstGutter: string,
  continuationGutter: string,
  options: TranscriptToolEvidenceOptions,
): string[] {
  const normalizedWidth = Math.max(0, Math.floor(options.width));
  if (normalizedWidth === 0) return [];
  const prefixWidth = visibleWidth(options.prefix);
  const gutterWidth = Math.max(visibleWidth(firstGutter), visibleWidth(continuationGutter));
  const contentWidth = Math.max(1, normalizedWidth - prefixWidth - gutterWidth);
  const wrapped = new Text(value, 0, 0).render(contentWidth);
  return wrapped.map((line, index) =>
    toolLine(`${index === 0 ? firstGutter : continuationGutter}${line}`, options),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : undefined;
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}
