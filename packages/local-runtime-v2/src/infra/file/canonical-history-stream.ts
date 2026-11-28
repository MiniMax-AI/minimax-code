import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  decodeCanonicalHistoryEnvelope,
  newSequenceState,
  sequenceError,
  sequenceInspection,
  validateSequenceRecord,
  type CanonicalHistoryEnvelope,
  type CanonicalHistorySequenceInspection,
} from './canonical-history-jsonl.js';
import { createRevisionHasher } from './canonical-history-revision.js';
import { forEachJsonlRecord, publishFileCopyIfAbsent } from './jsonl.js';

export interface CanonicalHistoryFileStream {
  readonly revision: string;
  readonly messageCount: number;
  readonly inspection: CanonicalHistorySequenceInspection;
}

/**
 * Reads a canonical history file one record at a time. Decoding, sequence checks and the
 * revision match readStrict (`settled`) or readActiveStrict (`pending-allowed`) followed by
 * canonicalHistoryRevision, but only the record being visited is held unless `visit` keeps it.
 */
export async function streamCanonicalHistoryFile(
  filePath: string,
  options: {
    readonly sequence: 'settled' | 'pending-allowed';
    readonly visit?: (envelope: CanonicalHistoryEnvelope, index: number) => void | Promise<void>;
  },
): Promise<CanonicalHistoryFileStream> {
  const state = newSequenceState();
  const hasher = createRevisionHasher();
  const messageCount = await forEachJsonlRecord(
    filePath,
    decodeCanonicalHistoryEnvelope,
    async (envelope, index) => {
      validateSequenceRecord(envelope, index, state);
      hasher.add(envelope);
      await options.visit?.(envelope, index);
    },
  );
  const inspection = sequenceInspection(state, messageCount);
  if (options.sequence === 'settled' && inspection.status !== 'settled') {
    sequenceError(
      messageCount,
      `history ends before tool results: ${inspection.pendingToolCallIds.join(',')}`,
    );
  }
  return { revision: hasher.digest(), messageCount, inspection };
}

/**
 * Streams a snapshot file, visiting each record, and fails with code
 * `artifact-revision-mismatch` unless the file still has the expected revision. A file that did
 * not change while it was read is remembered as verified, so a later copy of it can skip hashing.
 */
export async function verifyCanonicalHistorySnapshotFile(
  filePath: string,
  expectedRevision: string,
  visit?: (envelope: CanonicalHistoryEnvelope, index: number) => void | Promise<void>,
): Promise<CanonicalHistoryFileStream> {
  const before = await fingerprintIfPresent(filePath);
  const streamed = await streamCanonicalHistoryFile(filePath, {
    sequence: 'settled',
    ...(visit ? { visit } : {}),
  });
  if (streamed.revision !== expectedRevision) {
    forgetVerifiedSnapshot(filePath);
    throw revisionChanged(filePath);
  }
  const after = await fingerprintIfPresent(filePath);
  if (before !== undefined && before === after) {
    rememberVerifiedSnapshot(filePath, { revision: expectedRevision, fingerprint: before });
  } else {
    forgetVerifiedSnapshot(filePath);
  }
  return streamed;
}

/**
 * Publishes a byte copy of a snapshot file. An existing target must already hold the same
 * revision. A copy becomes visible only after it is checked against the expected revision:
 * when this process already verified the source for that exact revision and the source file
 * has not changed since, the copy is compared with the source byte for byte; otherwise the copy
 * is streamed and hashed. Either way a wrong revision or a changed source fails before the copy
 * is visible.
 */
export async function copyCanonicalHistorySnapshotFile(
  sourcePath: string,
  targetPath: string,
  expectedRevision: string,
): Promise<'published' | 'already-exists'> {
  const status = await publishFileCopyIfAbsent(sourcePath, targetPath, async (temporaryPath) => {
    const verified = await verifiedSnapshot(sourcePath, expectedRevision);
    if (!verified) {
      await verifyCanonicalHistorySnapshotFile(temporaryPath, expectedRevision);
      return;
    }
    const identical = await sameFileBytes(sourcePath, temporaryPath);
    // The source must still be the file that was verified once the comparison is done.
    if (!identical || (await fingerprintIfPresent(sourcePath)) !== verified.fingerprint) {
      forgetVerifiedSnapshot(sourcePath);
      throw revisionChanged(sourcePath);
    }
  });
  if (status === 'already-exists') {
    await assertExistingSnapshotRevision(targetPath, expectedRevision);
  }
  return status;
}

interface VerifiedSnapshot {
  readonly revision: string;
  readonly fingerprint: string;
}

/** Bounded, most recently verified last; snapshot files are immutable once published. */
const VERIFIED_SNAPSHOT_LIMIT = 4096;
const verifiedSnapshots = new Map<string, VerifiedSnapshot>();

function rememberVerifiedSnapshot(filePath: string, snapshot: VerifiedSnapshot): void {
  const key = resolve(filePath);
  verifiedSnapshots.delete(key);
  verifiedSnapshots.set(key, snapshot);
  while (verifiedSnapshots.size > VERIFIED_SNAPSHOT_LIMIT) {
    const oldest = verifiedSnapshots.keys().next().value;
    if (oldest === undefined) break;
    verifiedSnapshots.delete(oldest);
  }
}

function forgetVerifiedSnapshot(filePath: string): void {
  verifiedSnapshots.delete(resolve(filePath));
}

async function verifiedSnapshot(
  filePath: string,
  expectedRevision: string,
): Promise<VerifiedSnapshot | undefined> {
  const known = verifiedSnapshots.get(resolve(filePath));
  if (!known || known.revision !== expectedRevision) return undefined;
  if ((await fingerprintIfPresent(filePath)) !== known.fingerprint) {
    forgetVerifiedSnapshot(filePath);
    return undefined;
  }
  return known;
}

/** Identity and change times of a regular file; any write or replacement changes it. */
async function fingerprintIfPresent(filePath: string): Promise<string | undefined> {
  try {
    const info = await lstat(filePath, { bigint: true });
    if (!info.isFile()) return undefined;
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  } catch {
    return undefined;
  }
}

function revisionChanged(filePath: string): Error {
  return Object.assign(new Error(`Canonical snapshot revision changed: ${filePath}`), {
    code: 'artifact-revision-mismatch',
  });
}

const COMPARE_CHUNK_BYTES = 1024 * 1024;

async function sameFileBytes(leftPath: string, rightPath: string): Promise<boolean> {
  const [left, right] = await Promise.all([open(leftPath, 'r'), open(rightPath, 'r')]);
  try {
    const [leftInfo, rightInfo] = await Promise.all([left.stat(), right.stat()]);
    if (leftInfo.size !== rightInfo.size) return false;
    const leftBuffer = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
    const rightBuffer = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
    for (let position = 0; position < leftInfo.size; ) {
      const length = Math.min(COMPARE_CHUNK_BYTES, leftInfo.size - position);
      const [leftRead, rightRead] = await Promise.all([
        left.read(leftBuffer, 0, length, position),
        right.read(rightBuffer, 0, length, position),
      ]);
      if (leftRead.bytesRead !== length || rightRead.bytesRead !== length) return false;
      if (!leftBuffer.subarray(0, length).equals(rightBuffer.subarray(0, length))) return false;
      position += length;
    }
    return true;
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
}

async function assertExistingSnapshotRevision(
  targetPath: string,
  expectedRevision: string,
): Promise<void> {
  try {
    await verifyCanonicalHistorySnapshotFile(targetPath, expectedRevision);
  } catch (error) {
    throw new Error(`Canonical history snapshot conflict: ${targetPath}`, { cause: error });
  }
}
