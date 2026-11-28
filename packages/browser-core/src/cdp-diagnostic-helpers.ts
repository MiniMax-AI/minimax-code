import type {
  CDPConsoleDiagnosticEntry,
  CDPNetworkDiagnosticEntry,
  CDPNetworkDiagnosticResourceType,
  CDPNetworkDiagnosticStatusFilter,
} from './cdp-helper-contracts.js';
import {
  sanitizeConsoleDiagnosticUrl,
  sanitizeConsoleMessage,
  truncateConsoleValue,
} from './console-diagnostic-sanitizer.js';

export const MAX_CONSOLE_DIAGNOSTIC_ENTRIES = 200;
export const MAX_CONSOLE_DIAGNOSTIC_PAGE_BYTES = 48 * 1024;
export const MAX_NETWORK_DIAGNOSTIC_ENTRIES = 200;
export const MAX_NETWORK_DIAGNOSTIC_PAGE_BYTES = 48 * 1024;

const MAX_CONSOLE_STACK_FRAMES = 8;
const MAX_NETWORK_TEXT_CHARS = 1_024;

export const browserInputDiagnosticLogger = {
  info(fields: Record<string, unknown>): void {
    // eslint-disable-next-line no-console -- opt-in local browser diagnostics
    if (process.env.MAVIS_BROWSER_DEBUG === '1') console.info(fields);
  },
  warn(fields: Record<string, unknown>): void {
    // eslint-disable-next-line no-console -- opt-in local browser diagnostics
    if (process.env.MAVIS_BROWSER_DEBUG === '1') console.warn(fields);
  },
};

export interface CDPRemoteObjectSummary {
  type?: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

export interface CDPConsoleCallFrame {
  functionName?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

export interface CDPConsoleStackTrace {
  callFrames?: CDPConsoleCallFrame[];
}

export interface BufferedConsoleDiagnosticEntry extends CDPConsoleDiagnosticEntry {
  exceptionId?: number;
}

export interface BufferedNetworkDiagnosticEntry extends CDPNetworkDiagnosticEntry {
  requestId: string;
  startedAtMonotonic: number;
  loaderId?: string;
}

export function sanitizeNetworkDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'data:') return 'data:[REDACTED]';
    if (url.protocol === 'blob:') {
      return `blob:${sanitizeConsoleDiagnosticUrl(value.slice('blob:'.length))}`;
    }
  } catch {
    // The common sanitizer still applies bounded best-effort credential/query removal.
  }
  return sanitizeConsoleDiagnosticUrl(value);
}

export function sanitizeNetworkText(value: string): string {
  return truncateConsoleValue(
    sanitizeConsoleMessage(value).replace(/\bdata:[^\s<>"']+/giu, 'data:[REDACTED]'),
    MAX_NETWORK_TEXT_CHARS,
  );
}

const NETWORK_RESOURCE_TYPES = new Set<CDPNetworkDiagnosticResourceType>([
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'xhr',
  'fetch',
  'eventsource',
  'manifest',
  'preflight',
  'other',
]);

export function normalizeNetworkResourceType(value: unknown): CDPNetworkDiagnosticResourceType {
  const normalized = typeof value === 'string' ? value.toLowerCase() : 'other';
  return NETWORK_RESOURCE_TYPES.has(normalized as CDPNetworkDiagnosticResourceType)
    ? (normalized as CDPNetworkDiagnosticResourceType)
    : 'other';
}

export function networkStatusMatches(
  entry: CDPNetworkDiagnosticEntry,
  filters: ReadonlySet<CDPNetworkDiagnosticStatusFilter>,
): boolean {
  if (filters.size === 0) return true;
  if (filters.has('pending') && entry.outcome === 'pending') return true;
  if (filters.has('failed') && entry.outcome === 'failed') return true;
  if (filters.has('success') && entry.outcome === 'success') return true;
  if (typeof entry.status !== 'number') return false;
  const statusClass = `${Math.floor(entry.status / 100)}xx` as CDPNetworkDiagnosticStatusFilter;
  return filters.has(statusClass);
}

/**
 * Sequences the network buffer evicted to stay within
 * MAX_NETWORK_DIAGNOSTIC_ENTRIES, kept as ascending runs of consecutive
 * sequences. Evictions leave from the front of an ascending buffer, so a run
 * breaks only where a navigation filter left a gap; the ledger is cleared with
 * the buffer, so runs never outnumber the entries the buffer held.
 */
export class NetworkEvictionLedger {
  private runs: Array<{ first: number; last: number }> = [];

  record(sequence: number): void {
    const run = this.runs.at(-1);
    if (run && sequence === run.last + 1) run.last = sequence;
    else this.runs.push({ first: sequence, last: sequence });
  }

  /** Evicted entries whose sequence is greater than `afterSequence`. */
  countAfter(afterSequence: number): number {
    let count = 0;
    for (const run of this.runs) {
      if (run.last > afterSequence) count += run.last - Math.max(run.first, afterSequence + 1) + 1;
    }
    return count;
  }

  clear(): void {
    this.runs = [];
  }
}

/**
 * A model re-ran the same network query until its call budget ran
 * out, looking for a request the buffer had already evicted. Say it is gone.
 */
export function networkDroppedNotice(droppedEntries: number, oldestSequence: number): string {
  return `${droppedEntries} earlier network ${droppedEntries === 1 ? 'entry was' : 'entries were'} dropped: each tab keeps only the newest ${MAX_NETWORK_DIAGNOSTIC_ENTRIES} requests, so entries before sequence ${oldestSequence} are gone and repeating this query will not return them. To capture a request, keep lastSequence as a checkpoint, repeat the page action that sends it, then query with that afterSequence and a narrow filter.`;
}

/**
 * The one repeated read Browser Core can prove made no progress: the same
 * network query over a buffer no request event has touched since returns the
 * same page. D9 keeps no per-call REPEATED_READ error for other reads; this
 * only counts and says so. `revision` changes on every buffer mutation.
 */
export class NetworkQueryRepeats {
  private last: { key: string; revision: number; repeats: number } | undefined;

  /** Identical queries in a row over the same revision before this one. */
  record(key: string, revision: number): number {
    const last = this.last;
    const repeats = last && last.key === key && last.revision === revision ? last.repeats + 1 : 0;
    this.last = { key, revision, repeats };
    return repeats;
  }
}

export function networkRepeatNotice(repeats: number): string {
  return `No request started, finished or failed since the previous identical query (${repeats} unchanged ${repeats === 1 ? 'repeat' : 'repeats'} in a row), so this page is the same and querying again will not change it. Act on the page first, or wait with kind "network" and a filter until the request finishes.`;
}

export function summarizeRemoteObject(remote: CDPRemoteObjectSummary): string {
  if (remote.value !== undefined) {
    if (typeof remote.value === 'string') return remote.value;
    if (remote.value === null) return 'null';
    return String(remote.value);
  }
  if (remote.unserializableValue) return remote.unserializableValue;
  if (remote.description) return remote.description;
  if (remote.subtype === 'null') return 'null';
  return remote.className || remote.subtype || remote.type || '';
}

export function formatConsoleStack(stackTrace?: CDPConsoleStackTrace): string[] | undefined {
  const frames = stackTrace?.callFrames?.slice(0, MAX_CONSOLE_STACK_FRAMES) ?? [];
  if (frames.length === 0) return undefined;
  return frames.map((frame) => {
    const fn = truncateConsoleValue(
      sanitizeConsoleMessage(frame.functionName || '<anonymous>'),
      256,
    );
    const url = sanitizeConsoleDiagnosticUrl(frame.url || '<unknown>');
    const line = Math.max(0, Number(frame.lineNumber ?? 0)) + 1;
    const column = Math.max(0, Number(frame.columnNumber ?? 0)) + 1;
    return `${fn} (${url}:${line}:${column})`;
  });
}
