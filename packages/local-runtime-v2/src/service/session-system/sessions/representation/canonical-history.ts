import { access } from 'node:fs/promises';

import { CanonicalHistoryJsonlDataSource } from '../../../../infra/file/canonical-history.js';
import type {
  CanonicalHistoryEnvelope,
  CanonicalHistoryJsonlDataSourceOptions,
} from '../../../../infra/file/canonical-history.js';
import type { CanonicalHistoryFileAdapter } from './canonical-history-contract.js';

/**
 * Decoded history kept across reads, summed over every Session this adapter serves. The budget
 * counts file bytes; line-by-line decoding keeps the records at about 1.1x that on real histories.
 */
const DEFAULT_DECODED_HISTORY_CACHE_BYTES = 256 * 1024 * 1024;
/** Bounds bookkeeping for Sessions whose history is tiny or was never read. */
const MAX_CACHED_HISTORY_FILES = 256;

export interface CreateCanonicalHistoryFileAdapterOptions {
  /** Internal provider only: returned records remain private and immutable. */
  readonly reuseDecodedRecords?: boolean;
  /** Byte budget for reused decoded records; least recently read files are dropped first. */
  readonly decodedCacheBytes?: number;
  readonly onMalformedLine?: CanonicalHistoryJsonlDataSourceOptions['onMalformedLine'];
}

export function createCanonicalHistoryFileAdapter(
  options: CreateCanonicalHistoryFileAdapterOptions = {},
): CanonicalHistoryFileAdapter {
  return new JsonlCanonicalHistoryFileAdapter(options);
}

class JsonlCanonicalHistoryFileAdapter implements CanonicalHistoryFileAdapter {
  /** Insertion order is recency order: every access moves the file to the end. */
  private readonly cachedSources = new Map<string, CanonicalHistoryJsonlDataSource>();

  constructor(private readonly options: CreateCanonicalHistoryFileAdapterOptions) {}

  async targetExists(path: string) {
    return exists(path);
  }
  async readTarget(path: string) {
    if (!(await exists(path))) return undefined;
    return this.source(path).readActive();
  }
  async readTargetStrict(path: string) {
    if (!(await exists(path))) return undefined;
    return this.cachedRead(path, (source) => source.readActiveStrict());
  }
  async readActive(path: string) {
    return this.source(path).readActive();
  }
  async readActiveStrict(path: string) {
    return this.cachedRead(path, (source) => source.readActiveStrict());
  }
  async readEnvelopesStrict(path: string) {
    return this.cachedRead(path, (source) => source.readEnvelopesStrict());
  }
  async readStrict(path: string) {
    return this.source(path).readStrict();
  }
  async publishInitial(path: string, records: readonly CanonicalHistoryEnvelope[]) {
    return this.source(path).publishInitial(records);
  }
  async append(
    path: string,
    records: readonly CanonicalHistoryEnvelope[],
    verifiedActive?: readonly CanonicalHistoryEnvelope[],
  ) {
    await this.source(path).append(records, verifiedActive);
  }
  async replace(path: string, records: readonly CanonicalHistoryEnvelope[]) {
    await this.source(path).replace(records);
  }
  async replaceActive(path: string, records: readonly CanonicalHistoryEnvelope[]) {
    await this.source(path).replaceActive(records);
  }
  async publishSnapshot(snapshotPath: string, records: readonly CanonicalHistoryEnvelope[]) {
    // Snapshots are written once and never read through the cache.
    return this.createSource(snapshotPath).publishSnapshot(snapshotPath, records);
  }

  forget(path: string) {
    this.cachedSources.delete(path);
  }

  private async cachedRead(
    path: string,
    read: (source: CanonicalHistoryJsonlDataSource) => Promise<CanonicalHistoryEnvelope[]>,
  ): Promise<CanonicalHistoryEnvelope[]> {
    try {
      return await read(this.source(path));
    } finally {
      this.trimCachedSources(path);
    }
  }

  private source(path: string): CanonicalHistoryJsonlDataSource {
    if (!this.options.reuseDecodedRecords) return this.createSource(path);
    const cached = this.cachedSources.get(path) ?? this.createSource(path);
    this.cachedSources.delete(path);
    this.cachedSources.set(path, cached);
    return cached;
  }

  private createSource(path: string): CanonicalHistoryJsonlDataSource {
    return new CanonicalHistoryJsonlDataSource({
      activePath: path,
      reuseDecodedRecords: this.options.reuseDecodedRecords,
      ...(this.options.onMalformedLine ? { onMalformedLine: this.options.onMalformedLine } : {}),
    });
  }

  /** Drops least recently read files until the decoded records fit the budget. */
  private trimCachedSources(keepPath: string): void {
    const budget = this.options.decodedCacheBytes ?? DEFAULT_DECODED_HISTORY_CACHE_BYTES;
    let total = 0;
    for (const source of this.cachedSources.values()) total += source.cachedBytes();
    for (const [path, source] of this.cachedSources) {
      if (total <= budget && this.cachedSources.size <= MAX_CACHED_HISTORY_FILES) return;
      if (path === keepPath) continue;
      total -= source.cachedBytes();
      this.cachedSources.delete(path);
    }
  }
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
function isMissing(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
