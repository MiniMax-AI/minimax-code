import { lstat, readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

import {
  canonicalActiveHistoryRevision,
  canonicalHistoryRevision,
  type CanonicalHistoryEnvelope,
} from '../../../sessions/representation/canonical-history-contract.js';
import { createCanonicalHistoryFileAdapter } from '../../../sessions/representation/canonical-history.js';

const SNAPSHOT_NAME = /^g(\d{12})--([A-Za-z0-9][A-Za-z0-9._-]*)\.jsonl$/u;
const EXTERNAL_USER_ID = /^msg-user-v1-.+$/u;

type HistoryArtifactKind = 'snapshot' | 'active';

export interface HistoryCatalogArtifactV1 {
  readonly generation: number;
  readonly kind: HistoryArtifactKind;
  readonly fileName: string;
  readonly revision: string;
  readonly byteLength: number;
  readonly messageCount: number;
}

export interface HistoryCatalogV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly activeGeneration: number;
  readonly activeRevision: string;
  readonly artifacts: readonly HistoryCatalogArtifactV1[];
}

export interface UserMessageLocatorV1 {
  readonly schemaVersion: 1;
  readonly messageId: `msg-user-v1-${string}`;
  readonly generation: number;
  readonly lineNumber: number;
  readonly byteOffset: number;
  readonly artifactRevision: string;
}

export interface CanonicalHistoryScannerPaths {
  readonly activePath: string;
  readonly snapshotsPath: string;
  readonly sessionId: string;
}

export interface CanonicalHistoryScannerResult {
  readonly catalog: HistoryCatalogV1;
  readonly locators: readonly UserMessageLocatorV1[];
  readonly orphans: readonly string[];
}

export class HistoryScannerError extends Error {
  constructor(
    readonly code: HistoryScannerErrorCode,
    cause?: unknown,
  ) {
    super(`Canonical history scan failed: ${code}`, { cause });
    this.name = 'HistoryScannerError';
  }
}

export type HistoryScannerErrorCode =
  | 'external-user-lineage-conflict'
  | 'artifact-revision-mismatch'
  | 'parent-mismatch'
  | 'parent-snapshot-missing'
  | 'invalid-generation-marker'
  | 'malformed-jsonl'
  | 'sequence-corruption'
  | 'unsafe-artifact';

/** Session provider reuse is bounded to the last active file, never a freshness check. */
export function createCanonicalHistoryScanner() {
  let cached:
    | {
        path: string;
        bytes: Buffer;
        locations: readonly LineLocation[];
        nextLine: number;
        nextOffset: number;
      }
    | undefined;
  const locate: LocateLines = (path, bytes) => {
    const previous = cached?.path === path ? cached : undefined;
    if (previous && bytes.equals(previous.bytes)) return previous.locations;
    const reuse =
      previous &&
      previous.bytes.at(-1) === 10 &&
      bytes.length >= previous.bytes.length &&
      bytes.subarray(0, previous.bytes.length).equals(previous.bytes);
    const locations: LineLocation[] = reuse ? [...previous.locations] : [];
    const prefix = reuse ? previous.bytes.length : 0;
    // Match the original decoded UTF-8 offset convention, including replacement characters.
    let byteOffset = reuse ? previous.nextOffset : 0;
    let lineNumber = reuse ? previous.nextLine : 0;
    const lines = bytes.toString('utf8', prefix).split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) {
      lineNumber++;
      const nextByteOffset = byteOffset + Buffer.byteLength(line, 'utf8') + 1;
      if (line.length > 0) locations.push({ lineNumber, byteOffset });
      byteOffset = nextByteOffset;
    }
    // Keep only one bounded active file. Large files retain no additional byte buffer.
    cached =
      bytes.length <= 4 * 1024 * 1024
        ? {
            path,
            bytes,
            locations,
            nextLine: lineNumber,
            nextOffset: byteOffset,
          }
        : undefined;
    return locations;
  };
  return (
    paths: CanonicalHistoryScannerPaths,
    files: ReturnType<typeof createCanonicalHistoryFileAdapter>,
  ) => scanCanonicalHistoryArtifacts(paths, files, locate);
}

interface LineLocation {
  readonly lineNumber: number;
  readonly byteOffset: number;
}
type LocateLines = (path: string, bytes: Buffer) => readonly LineLocation[];

export async function scanCanonicalHistoryArtifacts(
  paths: CanonicalHistoryScannerPaths,
  files = createCanonicalHistoryFileAdapter(),
  locate?: LocateLines,
): Promise<CanonicalHistoryScannerResult> {
  let activeBytes: Buffer | undefined;
  const activeRead =
    locate && files.readActiveWithBytes
      ? files.readActiveWithBytes(paths.activePath).then(({ records, bytes }) => {
          activeBytes = bytes;
          return records;
        })
      : files.readActiveStrict(paths.activePath);
  const activeBase = await readArtifact(activeRead, paths.activePath, 'active');
  const activeGeneration = inferActiveGeneration(activeBase.records);
  const active = { ...activeBase, generation: activeGeneration };
  const activeMarker = readV2Marker(active.records, activeGeneration);
  const names = await listSnapshotNames(paths.snapshotsPath);
  const chain = await scanReachableSnapshots(files, active.generation, activeMarker, names);
  const reachable = [...chain.artifacts];
  const activeScanned = {
    ...active,
    generation: active.generation,
    fileName: 'messages.jsonl',
  };
  reachable.push(activeScanned);
  const locators = await collectUserMessageLocators(reachable, locate, activeBytes);
  return {
    catalog: {
      schemaVersion: 1,
      sessionId: paths.sessionId,
      activeGeneration: active.generation,
      activeRevision: active.revision,
      artifacts: reachable.map(({ path: _path, records: _records, ...artifact }) => artifact),
    },
    locators,
    orphans: names
      .filter((entry) => !chain.reachedNames.has(entry.fileName))
      .map((entry) => entry.fileName),
  };
}

type SnapshotName = Awaited<ReturnType<typeof listSnapshotNames>>[number];

async function scanReachableSnapshots(
  files: ReturnType<typeof createCanonicalHistoryFileAdapter>,
  activeGeneration: number,
  activeMarker: Marker | undefined,
  names: readonly SnapshotName[],
): Promise<{
  readonly artifacts: readonly ScannedArtifact[];
  readonly reachedNames: Set<string>;
}> {
  const byGeneration = groupSnapshotsByGeneration(names);
  const artifacts: ScannedArtifact[] = [];
  const reachedNames = new Set<string>();
  let generation = activeGeneration;
  let marker = activeMarker;
  while (generation > 0) {
    const parent = await readReachableParent({
      files,
      generation,
      marker,
      byGeneration,
      reachedNames,
    });
    artifacts.unshift(parent.artifact);
    generation = parent.artifact.generation;
    marker = parent.marker;
  }
  return { artifacts, reachedNames };
}

function groupSnapshotsByGeneration(
  names: readonly SnapshotName[],
): ReadonlyMap<number, readonly SnapshotName[]> {
  const grouped = new Map<number, SnapshotName[]>();
  for (const entry of names) {
    const entries = grouped.get(entry.generation) ?? [];
    entries.push(entry);
    grouped.set(entry.generation, entries);
  }
  return grouped;
}

async function readReachableParent(input: {
  readonly files: ReturnType<typeof createCanonicalHistoryFileAdapter>;
  readonly generation: number;
  readonly marker: Marker | undefined;
  readonly byGeneration: ReadonlyMap<number, readonly SnapshotName[]>;
  readonly reachedNames: Set<string>;
}): Promise<{
  readonly artifact: ScannedArtifact;
  readonly marker: Marker | undefined;
}> {
  const { files, generation, marker, byGeneration, reachedNames } = input;
  if (!marker) throw new HistoryScannerError('invalid-generation-marker');
  const parent = marker.parentSnapshot;
  if (parent.generation !== generation - 1) throw new HistoryScannerError('parent-mismatch');
  const snapshot = byGeneration
    .get(parent.generation)
    ?.find((entry) => entry.compactionId === parent.compactionId);
  if (!snapshot) throw new HistoryScannerError('parent-snapshot-missing');
  if (!snapshot.regular) throw new HistoryScannerError('unsafe-artifact');
  if (reachedNames.has(snapshot.fileName)) {
    throw new HistoryScannerError('invalid-generation-marker');
  }
  reachedNames.add(snapshot.fileName);
  const scanned = await readArtifact(files.readStrict(snapshot.path), snapshot.path, 'snapshot');
  if (scanned.revision !== parent.revision) {
    throw new HistoryScannerError('artifact-revision-mismatch');
  }
  return {
    artifact: {
      ...scanned,
      generation: snapshot.generation,
      fileName: snapshot.fileName,
    },
    marker: readV2Marker(scanned.records, snapshot.generation),
  };
}

async function collectUserMessageLocators(
  artifacts: readonly ScannedArtifact[],
  locate?: LocateLines,
  activeBytes?: Buffer,
): Promise<readonly UserMessageLocatorV1[]> {
  const lineage = new Map<
    string,
    { readonly fingerprint: string; readonly lastGeneration: number }
  >();
  const locators: UserMessageLocatorV1[] = [];
  for (const artifact of artifacts) {
    if (locate && artifact.kind === 'active') {
      const bytes = activeBytes ?? (await readFile(artifact.path));
      const locations = locate(artifact.path, bytes);
      for (const [index, location] of locations.entries()) {
        collectRecordLocator(artifact, artifact.records[index], location, lineage, locators);
      }
    } else {
      const raw = await readFile(artifact.path, 'utf8');
      collectArtifactLocators(artifact, raw, lineage, locators);
    }
  }
  return locators;
}

function collectArtifactLocators(
  artifact: ScannedArtifact,
  raw: string,
  lineage: Map<string, { readonly fingerprint: string; readonly lastGeneration: number }>,
  locators: UserMessageLocatorV1[],
): void {
  let offset = 0;
  let recordIndex = 0;
  raw.split('\n').forEach((line, index) => {
    if (line.length > 0) {
      const parsed = artifact.records[recordIndex];
      recordIndex += 1;
      collectRecordLocator(
        artifact,
        parsed,
        { lineNumber: index + 1, byteOffset: offset },
        lineage,
        locators,
      );
    }
    offset += Buffer.byteLength(line, 'utf8') + 1;
  });
}

function collectRecordLocator(
  artifact: ScannedArtifact,
  parsed: CanonicalHistoryEnvelope | undefined,
  location: { readonly lineNumber: number; readonly byteOffset: number },
  lineage: Map<string, { readonly fingerprint: string; readonly lastGeneration: number }>,
  locators: UserMessageLocatorV1[],
): void {
  if (parsed && isExternalUserId(parsed.message_id)) {
    if (parsed.message.role !== 'user') {
      throw new HistoryScannerError('external-user-lineage-conflict');
    }
    const fingerprint = externalUserFingerprint(parsed);
    const previous = lineage.get(parsed.message_id);
    if (
      previous &&
      (previous.fingerprint !== fingerprint || previous.lastGeneration + 1 !== artifact.generation)
    ) {
      throw new HistoryScannerError('external-user-lineage-conflict');
    }
    lineage.set(parsed.message_id, {
      fingerprint,
      lastGeneration: artifact.generation,
    });
    if (!previous) {
      locators.push({
        schemaVersion: 1,
        messageId: parsed.message_id,
        generation: artifact.generation,
        lineNumber: location.lineNumber,
        byteOffset: location.byteOffset,
        artifactRevision: artifact.revision,
      });
    }
  }
}

function externalUserFingerprint(envelope: CanonicalHistoryEnvelope): string {
  const semanticEnvelope: CanonicalHistoryEnvelope = {
    message_id: envelope.message_id,
    turn_id: envelope.turn_id,
    message: envelope.message,
    ...(envelope.turn_config ? { turn_config: envelope.turn_config } : {}),
  };
  return canonicalHistoryRevision([semanticEnvelope]);
}

type ScannedArtifact = {
  readonly path: string;
  readonly records: readonly CanonicalHistoryEnvelope[];
  readonly revision: string;
  readonly generation: number;
  readonly kind: HistoryArtifactKind;
  readonly fileName: string;
  readonly byteLength: number;
  readonly messageCount: number;
};

async function readArtifact(
  promise: Promise<readonly CanonicalHistoryEnvelope[]>,
  path: string,
  kind: HistoryArtifactKind,
): Promise<ScannedArtifact> {
  let records: readonly CanonicalHistoryEnvelope[];
  try {
    records = await promise;
  } catch (error) {
    throw new HistoryScannerError(
      error instanceof Error && /sequence|tool|history ends/iu.test(error.message)
        ? 'sequence-corruption'
        : 'malformed-jsonl',
      error,
    );
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new HistoryScannerError('unsafe-artifact');
  const byteLength = info.size;
  return {
    path,
    records,
    revision:
      kind === 'active'
        ? canonicalActiveHistoryRevision(records)
        : canonicalHistoryRevision(records),
    generation: 0,
    kind,
    fileName: '',
    byteLength,
    messageCount: records.length,
  };
}

async function listSnapshotNames(path: string): Promise<
  Array<{
    generation: number;
    compactionId: string;
    fileName: string;
    path: string;
    regular: boolean;
  }>
> {
  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const result: Array<{
    generation: number;
    compactionId: string;
    fileName: string;
    path: string;
    regular: boolean;
  }> = [];
  for (const entry of entries) {
    const fileName = entry.name;
    const match = SNAPSHOT_NAME.exec(fileName);
    if (!match) continue;
    const generationText = match[1];
    const compactionId = match[2];
    if (generationText === undefined || compactionId === undefined) continue;
    result.push({
      generation: Number(generationText),
      compactionId,
      fileName,
      path: join(path, fileName),
      regular: entry.isFile() && !entry.isSymbolicLink(),
    });
  }
  return result.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function readV2Marker(
  records: readonly CanonicalHistoryEnvelope[],
  generation: number,
): Marker | undefined {
  const artifact = records[0]?.history_artifact;
  if (artifact !== undefined) {
    if (artifact.generation !== generation) {
      throw new HistoryScannerError('invalid-generation-marker');
    }
    return artifact;
  }
  const value = records[0]?.message.archonCompaction;
  if (value === undefined) {
    if (generation > 0) throw new HistoryScannerError('invalid-generation-marker');
    return undefined;
  }
  if (isLegacyCompactionMarker(value)) {
    if (generation > 0 || records[0]?.message.role !== 'user') {
      throw new HistoryScannerError('invalid-generation-marker');
    }
    return undefined;
  }
  if (!isMarker(value, generation) || records[0]?.message.role !== 'user') {
    throw new HistoryScannerError('invalid-generation-marker');
  }
  return value;
}

function isMarker(value: unknown, generation: number): value is Marker {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.generation !== generation) {
    return false;
  }
  const parent = value.parentSnapshot;
  return (
    isRecord(parent) &&
    isNonNegativeInteger(parent.generation) &&
    typeof parent.compactionId === 'string' &&
    parent.compactionId.length > 0 &&
    typeof parent.revision === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(parent.revision)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function inferActiveGeneration(records: readonly CanonicalHistoryEnvelope[]): number {
  const artifact = records[0]?.history_artifact;
  if (artifact !== undefined) return artifact.generation;
  const value = records[0]?.message.archonCompaction;
  if (value === undefined) return 0;
  if (isLegacyCompactionMarker(value)) return 0;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    typeof value.generation !== 'number' ||
    !Number.isInteger(value.generation) ||
    value.generation < 1
  )
    throw new HistoryScannerError('invalid-generation-marker');
  return value.generation;
}

function isLegacyCompactionMarker(value: unknown): boolean {
  return isRecord(value) && value.schemaVersion === 1 && typeof value.summary === 'string';
}

type Marker = {
  readonly generation: number;
  readonly parentSnapshot: {
    readonly generation: number;
    readonly compactionId: string;
    readonly revision: string;
  };
};
function isExternalUserId(value: string): value is `msg-user-v1-${string}` {
  return EXTERNAL_USER_ID.test(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
