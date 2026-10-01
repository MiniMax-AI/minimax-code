import type {
  CanonicalHistoryEnvelope,
  CanonicalHistoryPublication,
} from '../../../../infra/file/canonical-history.js';

export type { CanonicalHistoryEnvelope, CanonicalHistoryPublication };
export {
  canonicalActiveHistoryRevision,
  canonicalHistoryRevision,
  inspectCanonicalHistorySequence,
  JsonlAppendCommitUncertainError,
  selectCanonicalHistorySource,
} from '../../../../infra/file/canonical-history.js';

export interface CanonicalHistoryFileAdapter {
  /** Existence-only migration probe; callers still validate records before using them. */
  targetExists?(path: string): Promise<boolean>;
  readTarget(path: string): Promise<readonly CanonicalHistoryEnvelope[] | undefined>;
  readTargetStrict(path: string): Promise<readonly CanonicalHistoryEnvelope[] | undefined>;
  readActive(path: string): Promise<readonly CanonicalHistoryEnvelope[]>;
  /** Internal index read: fresh source bytes and their strictly decoded, immutable records. */
  readActiveWithBytes?(path: string): Promise<{
    readonly records: readonly CanonicalHistoryEnvelope[];
    readonly bytes: Buffer;
  }>;
  readActiveStrict(path: string): Promise<readonly CanonicalHistoryEnvelope[]>;
  readEnvelopesStrict(path: string): Promise<readonly CanonicalHistoryEnvelope[]>;
  readStrict(path: string): Promise<readonly CanonicalHistoryEnvelope[]>;
  publishInitial(
    path: string,
    records: readonly CanonicalHistoryEnvelope[],
  ): Promise<CanonicalHistoryPublication>;
  /** verifiedActive must be read in the same serialized operation, never cached across writes. */
  append(
    path: string,
    records: readonly CanonicalHistoryEnvelope[],
    verifiedActive?: readonly CanonicalHistoryEnvelope[],
  ): Promise<void>;
  replace(path: string, records: readonly CanonicalHistoryEnvelope[]): Promise<void>;
  replaceActive(path: string, records: readonly CanonicalHistoryEnvelope[]): Promise<void>;
  publishSnapshot(
    snapshotPath: string,
    records: readonly CanonicalHistoryEnvelope[],
  ): Promise<'published' | 'already-exists'>;
}
