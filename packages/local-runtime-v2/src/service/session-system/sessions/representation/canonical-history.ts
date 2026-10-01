import { access } from 'node:fs/promises';

import { CanonicalHistoryJsonlDataSource } from '../../../../infra/file/canonical-history.js';
import type {
  CanonicalHistoryEnvelope,
  CanonicalHistoryJsonlDataSourceOptions,
} from '../../../../infra/file/canonical-history.js';
import type { CanonicalHistoryFileAdapter } from './canonical-history-contract.js';

export interface CreateCanonicalHistoryFileAdapterOptions {
  /** Internal provider only: returned records remain private and immutable. */
  readonly reuseDecodedRecords?: boolean;
  readonly onMalformedLine?: CanonicalHistoryJsonlDataSourceOptions['onMalformedLine'];
}

export function createCanonicalHistoryFileAdapter(
  options: CreateCanonicalHistoryFileAdapterOptions = {},
): CanonicalHistoryFileAdapter {
  return new JsonlCanonicalHistoryFileAdapter(options);
}

class JsonlCanonicalHistoryFileAdapter implements CanonicalHistoryFileAdapter {
  private cachedSource?: {
    path: string;
    source: CanonicalHistoryJsonlDataSource;
  };

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
    return this.source(path).readActiveStrict();
  }
  async readActive(path: string) {
    return this.source(path).readActive();
  }
  async readActiveWithBytes(path: string) {
    return this.source(path).readActiveWithBytes();
  }
  async readActiveStrict(path: string) {
    return this.source(path).readActiveStrict();
  }
  async readEnvelopesStrict(path: string) {
    return this.source(path).readEnvelopesStrict();
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
    return this.source(snapshotPath).publishSnapshot(snapshotPath, records);
  }
  private source(path: string) {
    if (this.options.reuseDecodedRecords && this.cachedSource?.path === path) {
      return this.cachedSource.source;
    }
    const source = new CanonicalHistoryJsonlDataSource({
      activePath: path,
      reuseDecodedRecords: this.options.reuseDecodedRecords,
      ...(this.options.onMalformedLine ? { onMalformedLine: this.options.onMalformedLine } : {}),
    });
    if (this.options.reuseDecodedRecords) this.cachedSource = { path, source };
    return source;
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
