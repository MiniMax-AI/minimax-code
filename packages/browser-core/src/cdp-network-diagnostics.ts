/**
 * The per-page network request buffer behind `query kind: "network"` and
 * `wait kind: "network"`. CDPHelper feeds it Network events of the main frame
 * and decides when a new document or a new listener resets it.
 */
import {
  type BufferedNetworkDiagnosticEntry,
  MAX_NETWORK_DIAGNOSTIC_ENTRIES,
  MAX_NETWORK_DIAGNOSTIC_PAGE_BYTES,
  NetworkEvictionLedger,
  networkDroppedNotice,
  NetworkQueryRepeats,
  networkRepeatNotice,
  networkStatusMatches,
  normalizeNetworkResourceType,
  sanitizeNetworkDiagnosticUrl,
  sanitizeNetworkText,
} from './cdp-diagnostic-helpers.js';
import type {
  CDPNetworkDiagnosticEntry,
  CDPNetworkDiagnosticResourceType,
  CDPNetworkDiagnosticStatusFilter,
  CDPNetworkDiagnosticsOptions,
  CDPNetworkDiagnosticsPage,
} from './cdp-helper-contracts.js';
import { truncateConsoleValue } from './console-diagnostic-sanitizer.js';

export class CDPNetworkDiagnostics {
  /** Main frame whose requests are recorded; null until the listener knows it. */
  mainFrameId: string | null = null;
  private sequence = 0;
  private entries: BufferedNetworkDiagnosticEntry[] = [];
  private requests = new Map<string, BufferedNetworkDiagnosticEntry>();
  private evictions = new NetworkEvictionLedger();
  /** Bumped by every buffer mutation; an equal revision means an equal page. */
  private revision = 0;
  private queryRepeats = new NetworkQueryRepeats();
  /** Connection resets since the buffer last started over. */
  private resets: { count: number; lastAt: number } | undefined;

  page(options: CDPNetworkDiagnosticsOptions = {}): CDPNetworkDiagnosticsPage {
    const requestedLimit = Number.isFinite(options.limit) ? Number(options.limit) : 100;
    const limit = Math.max(1, Math.min(MAX_NETWORK_DIAGNOSTIC_ENTRIES, Math.floor(requestedLimit)));
    const requestedStatus = new Set<CDPNetworkDiagnosticStatusFilter>(options.status ?? []);
    const requestedResourceTypes = new Set<CDPNetworkDiagnosticResourceType>(
      options.resourceTypes ?? [],
    );
    const filter = options.filter ?? '';
    const requestedAfterSequence = Number.isFinite(options.afterSequence)
      ? Number(options.afterSequence)
      : 0;
    const afterSequence = Math.max(0, Math.floor(requestedAfterSequence));
    const filteredEntries = this.entries.filter(
      (entry) =>
        entry.sequence > afterSequence &&
        networkStatusMatches(entry, requestedStatus) &&
        (requestedResourceTypes.size === 0 || requestedResourceTypes.has(entry.resourceType)) &&
        (filter.length === 0 || entry.url.includes(filter)),
    );
    const totalEntries = filteredEntries.length;
    const limitedEntries = filteredEntries.slice(Math.max(0, totalEntries - limit));
    const entries: BufferedNetworkDiagnosticEntry[] = [];
    for (let index = limitedEntries.length - 1; index >= 0; index -= 1) {
      const entry = limitedEntries[index];
      if (!entry) continue;
      const candidateEntries = [entry, ...entries].map(publicEntry);
      const candidatePage: CDPNetworkDiagnosticsPage = {
        entries: candidateEntries,
        lastSequence: this.sequence,
        totalEntries,
        returnedEntries: candidateEntries.length,
        truncated: candidateEntries.length < totalEntries,
      };
      if (
        Buffer.byteLength(JSON.stringify(candidatePage), 'utf8') > MAX_NETWORK_DIAGNOSTIC_PAGE_BYTES
      ) {
        break;
      }
      entries.unshift(entry);
    }
    const resets = this.resets;
    const page: CDPNetworkDiagnosticsPage = {
      entries: entries.map(publicEntry),
      lastSequence: this.sequence,
      totalEntries,
      returnedEntries: entries.length,
      truncated: entries.length < totalEntries,
      ...(resets
        ? { resetCount: resets.count, lastResetAt: new Date(resets.lastAt).toISOString() }
        : {}),
    };
    // In evaluation a submit timed out, the connection reset, and the
    // network query then returned nothing, so the model submitted again.
    const resetNotice = resets
      ? [
          `The Browser connection to this page was reset ${resets.count === 1 ? 'once' : `${resets.count} times`} (last at ${new Date(resets.lastAt).toISOString()}) after an interrupted action. Entries from before the reset are kept, but requests sent while it reset are missing and entries marked interrupted never reported how they ended. An action started before the reset may still have reached the server: check its result on the page or site before repeating a write.`,
        ]
      : [];
    if (!options.readHints) {
      return resetNotice.length > 0 ? { ...page, notice: resetNotice.join(' ') } : page;
    }
    const droppedEntries = this.evictions.countAfter(afterSequence);
    const unchangedRepeats = this.queryRepeats.record(
      JSON.stringify([
        [...requestedStatus].sort(),
        [...requestedResourceTypes].sort(),
        filter,
        afterSequence,
        limit,
      ]),
      this.revision,
    );
    const oldestSequence = this.entries[0]?.sequence ?? this.sequence + 1;
    const notices = [
      ...resetNotice,
      ...(droppedEntries > 0 ? [networkDroppedNotice(droppedEntries, oldestSequence)] : []),
      ...(unchangedRepeats > 0 ? [networkRepeatNotice(unchangedRepeats)] : []),
    ];
    if (notices.length === 0) return page;
    return {
      ...page,
      ...(droppedEntries > 0 ? { droppedEntries, oldestSequence } : {}),
      ...(unchangedRepeats > 0 ? { unchangedRepeats } : {}),
      notice: notices.join(' '),
    };
  }

  handleMessage(method: string, payload: Record<string, unknown>): void {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    if (!requestId) return;

    if (method === 'Network.requestWillBeSent') {
      if (payload.frameId !== this.mainFrameId) return;
      const timestamp = typeof payload.timestamp === 'number' ? payload.timestamp : 0;
      const previous = this.requests.get(requestId);
      const redirectResponse = (
        payload.redirectResponse && typeof payload.redirectResponse === 'object'
          ? payload.redirectResponse
          : null
      ) as Record<string, unknown> | null;
      if (previous && redirectResponse) {
        this.applyResponse(previous, redirectResponse);
        previous.outcome = 'redirect';
        this.finish(previous, timestamp);
        this.requests.delete(requestId);
      }

      const request = (
        payload.request && typeof payload.request === 'object' ? payload.request : {}
      ) as Record<string, unknown>;
      this.sequence += 1;
      const entry: BufferedNetworkDiagnosticEntry = {
        requestId,
        startedAtMonotonic: timestamp,
        ...(typeof payload.loaderId === 'string' ? { loaderId: payload.loaderId } : {}),
        sequence: this.sequence,
        method: truncateConsoleValue(
          typeof request.method === 'string' ? request.method.toUpperCase() : 'GET',
          32,
        ),
        url: sanitizeNetworkDiagnosticUrl(
          typeof request.url === 'string' ? request.url : '<unknown>',
        ),
        resourceType: normalizeNetworkResourceType(payload.type),
        outcome: 'pending',
        timestamp:
          typeof payload.wallTime === 'number' ? Math.round(payload.wallTime * 1_000) : Date.now(),
      };
      this.requests.set(requestId, entry);
      this.append(entry);
      return;
    }

    const entry = this.requests.get(requestId);
    if (!entry) return;
    if (method === 'Network.responseReceived') {
      const response = (
        payload.response && typeof payload.response === 'object' ? payload.response : {}
      ) as Record<string, unknown>;
      this.applyResponse(entry, response);
      if (entry.status !== undefined && entry.status >= 400) entry.outcome = 'http-error';
      if (entry.resourceType === 'other') {
        entry.resourceType = normalizeNetworkResourceType(payload.type);
      }
      return;
    }
    if (method === 'Network.loadingFinished') {
      if (entry.outcome === 'pending') entry.outcome = 'success';
      this.finish(
        entry,
        typeof payload.timestamp === 'number' ? payload.timestamp : entry.startedAtMonotonic,
      );
      this.requests.delete(requestId);
      return;
    }
    if (method === 'Network.loadingFailed') {
      entry.outcome = 'failed';
      entry.failureReason = sanitizeNetworkText(
        typeof payload.errorText === 'string'
          ? payload.errorText
          : payload.canceled === true
            ? 'canceled'
            : 'request failed',
      );
      this.finish(
        entry,
        typeof payload.timestamp === 'number' ? payload.timestamp : entry.startedAtMonotonic,
      );
      this.requests.delete(requestId);
    }
  }

  /** Start over: a new page, a detached main frame, or a new listener. */
  reset(resetSequence = false): void {
    if (resetSequence) this.sequence = 0;
    this.revision += 1;
    this.entries = [];
    this.evictions.clear();
    this.requests.clear();
    this.resets = undefined;
  }

  /** A new main document: keep only the requests of its own load. */
  resetForNavigation(loaderId?: string): void {
    if (!loaderId) {
      this.reset();
      return;
    }
    this.entries = this.entries.filter((entry) => entry.loaderId === loaderId);
    // Entries of the previous document left on purpose; only cap evictions count.
    this.evictions.clear();
    this.revision += 1;
    this.requests = new Map([...this.requests].filter(([, entry]) => entry.loaderId === loaderId));
    this.resets = undefined;
  }

  /** The listener stopped: the main frame must be learned again. */
  resetScope(): void {
    this.mainFrameId = null;
    this.requests.clear();
  }

  /**
   * The connection is reset after an interrupted action. The same page keeps
   * its records; requests still in flight will never report how they ended.
   */
  markReset(at = Date.now()): void {
    this.revision += 1;
    for (const entry of this.requests.values()) {
      if (entry.outcome === 'pending') entry.interrupted = true;
    }
    this.requests.clear();
    this.resets = { count: (this.resets?.count ?? 0) + 1, lastAt: at };
  }

  private applyResponse(
    entry: BufferedNetworkDiagnosticEntry,
    response: Record<string, unknown>,
  ): void {
    this.revision += 1;
    if (typeof response.status === 'number') entry.status = response.status;
    if (typeof response.statusText === 'string' && response.statusText.length > 0) {
      entry.statusText = sanitizeNetworkText(response.statusText);
    }
    if (typeof response.mimeType === 'string' && response.mimeType.length > 0) {
      entry.mimeType = truncateConsoleValue(sanitizeNetworkText(response.mimeType), 256);
    }
  }

  private finish(entry: BufferedNetworkDiagnosticEntry, endedAtMonotonic: number): void {
    this.revision += 1;
    entry.durationMs = Math.max(
      0,
      Math.round((endedAtMonotonic - entry.startedAtMonotonic) * 1_000),
    );
  }

  private append(entry: BufferedNetworkDiagnosticEntry): void {
    this.revision += 1;
    this.entries.push(entry);
    if (this.entries.length <= MAX_NETWORK_DIAGNOSTIC_ENTRIES) return;
    const removed = this.entries.splice(0, this.entries.length - MAX_NETWORK_DIAGNOSTIC_ENTRIES);
    for (const candidate of removed) {
      this.evictions.record(candidate.sequence);
      if (this.requests.get(candidate.requestId) === candidate) {
        this.requests.delete(candidate.requestId);
      }
    }
  }
}

function publicEntry(entry: BufferedNetworkDiagnosticEntry): CDPNetworkDiagnosticEntry {
  const result: Partial<BufferedNetworkDiagnosticEntry> = { ...entry };
  delete result.requestId;
  delete result.startedAtMonotonic;
  delete result.loaderId;
  return result as CDPNetworkDiagnosticEntry;
}
