import { formatTuiDuration } from '../../rendering/duration.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { formatTuiToolSummary } from './tool-summary.js';
import type { TranscriptCell } from '../model.js';
import { normalizeToolName, resolveTranscriptToolDefinition } from '../tool-definitions.js';

export type TranscriptPresentationTone = 'neutral' | 'accent' | 'success' | 'warning' | 'error';

export interface TranscriptCellPresentation {
  readonly marker: string;
  readonly tone: TranscriptPresentationTone;
  readonly title: string;
  readonly summary?: string;
  readonly rawText: string;
  readonly searchText: string;
  readonly target?: string;
}

export function presentTranscriptCell(cell: TranscriptCell): TranscriptCellPresentation {
  const title = transcriptCellTitle(cell);
  const summary = transcriptCellSummary(cell);
  const rawText = transcriptCellRawText(cell);
  const status = statusPresentation(cell);
  const target = transcriptCellTarget(cell);
  return {
    ...status,
    title,
    ...(summary ? { summary } : {}),
    rawText,
    searchText: sanitizeTerminalText(
      [title, summary, rawText].filter(Boolean).join('\n'),
    ).toLocaleLowerCase(),
    ...(target ? { target } : {}),
  };
}

export function transcriptCellRawText(cell: TranscriptCell): string {
  const sections: string[] = [];
  if (cell.kind === 'shell' && cell.title) sections.push(sanitizeTerminalText(cell.title));
  if (cell.kind === 'tool' && cell.title)
    sections.push(`Tool: ${sanitizeTerminalText(cell.title)}`);
  if (cell.content.trim()) sections.push(sanitizeTerminalText(cell.content));
  if (cell.detail?.trim()) sections.push(sanitizeTerminalText(cell.detail));
  for (const block of cell.structuredPreview?.blocks ?? []) {
    if (block.path) sections.push(sanitizeTerminalText(block.path));
    if (block.kind === 'diff') sections.push(sanitizeTerminalText(block.diff));
    if (block.kind === 'file') sections.push(sanitizeTerminalText(block.content));
    if (block.kind === 'summary') sections.push(sanitizeTerminalText(block.message));
  }
  return sections.join('\n\n').trim();
}

function transcriptCellTitle(cell: TranscriptCell): string {
  if (cell.kind === 'shell') return 'Shell';
  if (cell.kind === 'user') return 'You';
  if (cell.kind === 'assistant') return 'Response';
  if (cell.kind === 'assistant-preamble') return 'Preamble';
  if (cell.kind === 'review') return cell.title ?? 'Code review';
  if (cell.kind === 'thinking') return cell.status === 'running' ? 'Thinking…' : 'Thinking';
  if (cell.kind === 'tool') {
    const definition = resolveTranscriptToolDefinition(cell.title);
    if (definition) {
      return cell.status === 'running' || cell.status === 'pending'
        ? definition.runningAction
        : definition.completedAction;
    }
    return titleCase(normalizeToolName(cell.title));
  }
  if (cell.kind === 'permission')
    return cell.status === 'resolved' ? 'Permission resolved' : 'Approval needed';
  if (cell.kind === 'question')
    return cell.status === 'resolved' ? 'Answers sent' : 'Agent question';
  if (cell.kind === 'turn-duration') return 'Run duration';
  if (cell.kind === 'compaction') return cell.title ?? 'Context compacted';
  if (cell.kind === 'usage') return 'Usage';
  if (cell.kind === 'inspection') return cell.inspection?.title ?? cell.title ?? 'Inspection';
  if (cell.kind === 'warning') return sanitizeTerminalText(cell.title ?? 'Warning');
  if (cell.kind === 'error') return 'Error';
  if (cell.kind === 'diff') return 'Changes';
  if (cell.kind === 'final-summary') return 'Summary';
  return cell.title ?? titleCase(cell.kind);
}

function transcriptCellSummary(cell: TranscriptCell): string | undefined {
  if (cell.kind === 'shell') return cell.title;
  if (cell.kind === 'thinking') {
    const durationMs = cell.durationMs ?? Math.max(0, cell.updatedAtMs - cell.createdAtMs);
    return durationMs > 0 ? formatDuration(durationMs) : undefined;
  }
  if (cell.kind === 'tool') return formatTuiToolSummary(cell.content) || undefined;
  if (cell.kind === 'turn-duration') return formatTuiDuration((cell.durationMs ?? 0) / 1_000);
  if (
    cell.kind === 'compaction' &&
    cell.tokensBefore !== undefined &&
    cell.tokensAfter !== undefined
  ) {
    return `${Math.round(cell.tokensBefore).toLocaleString()} → ${Math.round(cell.tokensAfter).toLocaleString()} tokens`;
  }
  if (cell.kind === 'permission') return cell.detail ?? cell.title;
  const first = sanitizeTerminalText(cell.content).split(/\r?\n/u, 1)[0]?.trim();
  if (!first || cell.kind === 'assistant' || cell.kind === 'user') return undefined;
  return first;
}

function transcriptCellTarget(cell: TranscriptCell): string | undefined {
  const previewPath = cell.structuredPreview?.blocks.find((block) => block.path)?.path;
  if (previewPath?.trim()) return sanitizeTerminalText(previewPath).trim();
  const content = sanitizeTerminalText(cell.content).trim();
  try {
    const value = JSON.parse(content) as unknown;
    if (isRecord(value)) {
      for (const key of ['path', 'filePath', 'file_path', 'url'] as const) {
        const candidate = value[key];
        if (typeof candidate === 'string' && candidate.trim())
          return sanitizeTerminalText(candidate).trim();
      }
    }
  } catch {
    const url = content.match(/https?:\/\/[^\s)\]}]+/u)?.[0];
    if (url) return url;
  }
  return undefined;
}

function statusPresentation(
  cell: TranscriptCell,
): Pick<TranscriptCellPresentation, 'marker' | 'tone'> {
  if (cell.status === 'failed') return { marker: '×', tone: 'error' };
  if (cell.status === 'blocked') return { marker: '◆', tone: 'warning' };
  if (cell.status === 'pending' || cell.status === 'running')
    return { marker: '●', tone: 'accent' };
  if (cell.status === 'cancelled') return { marker: '○', tone: 'warning' };
  if (cell.kind === 'warning') return { marker: '!', tone: 'warning' };
  if (cell.kind === 'error') return { marker: '×', tone: 'error' };
  if (cell.kind === 'user') return { marker: '●', tone: 'accent' };
  if (cell.kind === 'assistant') return { marker: '●', tone: 'neutral' };
  if (cell.kind === 'thinking') return { marker: '◆', tone: 'neutral' };
  if (cell.kind === 'assistant-preamble') return { marker: '·', tone: 'neutral' };
  if (cell.kind === 'review') return { marker: '✓', tone: 'success' };
  if (cell.kind === 'turn-duration' || cell.kind === 'usage' || cell.kind === 'compaction') {
    return { marker: '·', tone: 'neutral' };
  }
  if (cell.kind === 'diff') return { marker: '±', tone: 'success' };
  if (cell.kind === 'final-summary') return { marker: '◆', tone: 'success' };
  return { marker: '✓', tone: 'success' };
}

function titleCase(value: string): string {
  return value
    .split(/[_-]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toLocaleUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
