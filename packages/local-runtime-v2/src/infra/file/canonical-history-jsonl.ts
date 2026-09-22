import { createHash, type Hash } from 'node:crypto';

import {
  appendJsonl,
  publishJsonlIfAbsent,
  readJsonl,
  writeJsonlAtomically,
  type JsonlMalformedLine,
  type JsonlReadCache,
} from './jsonl.js';
import {
  decodeCanonicalHistoryArtifact,
  type CanonicalHistoryArtifact,
} from './canonical-history-artifact.js';
import {
  assertJsonCompatible,
  canonicalJson,
  isPlainRecord,
} from './canonical-history-json-value.js';

export { selectCanonicalHistorySource } from './canonical-history-source.js';
export type {
  CanonicalHistorySourceReaders,
  CanonicalHistorySourceSelection,
} from './canonical-history-source.js';
export type { CanonicalHistoryArtifact } from './canonical-history-artifact.js';

// Only records decoded from file contents and recursively frozen here are trusted.
const ownedEnvelopeJson = new WeakMap<CanonicalHistoryEnvelope, string | undefined>();
const ownedRecordArrays = new WeakSet<readonly CanonicalHistoryEnvelope[]>();
const ownedRevisions = new WeakMap<readonly CanonicalHistoryEnvelope[], string>();
// SHA state before the closing bracket; weak keys do not retain old histories.
const ownedRevisionPrefixes = new WeakMap<readonly CanonicalHistoryEnvelope[], Hash>();
const ownedSequences = new WeakMap<
  readonly CanonicalHistoryEnvelope[],
  CanonicalHistorySequenceInspection
>();

const ENVELOPE_KEYS = new Set([
  'message_id',
  'turn_id',
  'message',
  'turn_config',
  'history_artifact',
]);
const TURN_CONFIG_KEYS = new Set(['system_prompt', 'model', 'tools']);
const TURN_CONFIG_TOOL_KEYS = new Set(['tool_name', 'description', 'schema']);
const SENSITIVE_COMPACT_KEYS = new Set([
  'access',
  'apikey',
  'apikeys',
  'authorization',
  'token',
  'tokens',
  'accesstoken',
  'accesstokens',
  'refreshtoken',
  'refreshtokens',
  'idtoken',
  'idtokens',
  'authtoken',
  'authtokens',
  'authentication',
  'bearer',
  'bearertoken',
  'bearertokens',
  'sessiontoken',
  'sessiontokens',
  'secret',
  'secrets',
  'clientsecret',
  'clientsecrets',
  'cookie',
  'cookies',
  'accesskeysecret',
  'secretaccesskey',
  'password',
  'passwords',
  'passwd',
  'pwd',
  'credential',
  'credentials',
  'headers',
  'jwt',
  'privatekey',
  'privatekeys',
  'signingkey',
  'signingkeys',
  'accesskey',
  'accesskeys',
  'requestsk',
  'refresh',
  'sk',
]);
const SENSITIVE_COMPACT_SUFFIXES = [
  'apikey',
  'apikeys',
  'authorization',
  'accesstoken',
  'accesstokens',
  'refreshtoken',
  'refreshtokens',
  'token',
  'tokens',
  'idtoken',
  'authtoken',
  'bearertoken',
  'sessiontoken',
  'clientsecret',
  'clientsecrets',
  'accesskeysecret',
  'secretaccesskey',
  'privatekey',
  'privatekeys',
  'signingkey',
  'signingkeys',
  'accesskey',
  'accesskeys',
  'secrets',
  'passwords',
  'requestsk',
] as const;
const SENSITIVE_KEY_WORDS = new Set([
  'auth',
  'authentication',
  'authorization',
  'bearer',
  'cookie',
  'cookies',
  'headers',
  'jwt',
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwords',
  'passwd',
  'pwd',
  'credential',
  'credentials',
]);
const SENSITIVE_KEY_WORD_SEQUENCES = [
  ['api', 'key'],
  ['api', 'keys'],
  ['private', 'key'],
  ['private', 'keys'],
  ['access', 'key'],
  ['access', 'keys'],
  ['client', 'secret'],
  ['access', 'token'],
  ['refresh', 'token'],
  ['id', 'token'],
  ['auth', 'token'],
  ['bearer', 'token'],
  ['session', 'token'],
  ['access', 'key', 'secret'],
  ['secret', 'access', 'key'],
  ['signing', 'key'],
  ['signing', 'keys'],
  ['request', 'sk'],
] as const;
const PUBLIC_TOKEN_METRIC_QUALIFIER_WORDS = new Set([
  'accepted',
  'argument',
  'audio',
  'budget',
  'cached',
  'completion',
  'completions',
  'content',
  'delta',
  'estimated',
  'generated',
  'image',
  'input',
  'lifecycle',
  'max',
  'original',
  'output',
  'overlap',
  'prompt',
  'prediction',
  'read',
  'recent',
  'reasoning',
  'rejected',
  'remaining',
  'remote',
  'reserve',
  'result',
  'shown',
  'size',
  'text',
  'tool',
  'total',
  'trained',
  'write',
]);
const PUBLIC_TOKEN_METRIC_COMPACT_KEYS = new Set([
  ...[...PUBLIC_TOKEN_METRIC_QUALIFIER_WORDS].map((qualifier) => `${qualifier}tokens`),
  'fullvalidmeantokenaccuracy',
  'maxtokenstosample',
  'modelgradertokenusagepermodel',
  'pillmfirsttokenms',
  'trainmeantokenaccuracy',
  'validmeantokenaccuracy',
]);
const TOKEN_METRIC_WORDS = new Set(['token', 'tokens']);
const TOKEN_METRIC_TRAILING_QUALIFIERS = new Set(['details', 'used']);
const PUBLIC_CREDENTIAL_METADATA_SUFFIX_WORDS = new Set([
  'id',
  'ids',
  'url',
  'uri',
  'endpoint',
  'name',
  'type',
  'mode',
  'source',
  'version',
  'count',
  'limit',
  'budget',
  'usage',
  'quota',
  'window',
  'price',
  'cost',
  'rate',
  'length',
  'size',
  'ttl',
  'policy',
  'scope',
  'status',
  'plan',
  'algorithm',
  'expires',
  'expiry',
  'expiration',
  'enabled',
  'supported',
]);

interface TimestampedCanonicalHistoryMessage extends Record<string, unknown> {
  readonly role: string;
  readonly timestamp: number;
}

interface MinimalNativeCompactionSummary extends Record<string, unknown> {
  readonly role: 'compactionSummary';
  readonly summary: string;
  readonly timestamp?: never;
  readonly tokensBefore?: never;
}

export type CanonicalHistoryMessage =
  TimestampedCanonicalHistoryMessage | MinimalNativeCompactionSummary;

export interface CanonicalTurnConfigTool extends Record<string, unknown> {
  readonly tool_name: string;
  readonly description: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface CanonicalTurnConfig extends Record<string, unknown> {
  readonly system_prompt: string;
  readonly model: Readonly<Record<string, unknown>>;
  readonly tools?: readonly CanonicalTurnConfigTool[];
}

export interface CanonicalHistoryEnvelope {
  readonly message_id: string;
  readonly turn_id: string;
  readonly message: CanonicalHistoryMessage;
  readonly turn_config?: CanonicalTurnConfig;
  readonly history_artifact?: CanonicalHistoryArtifact;
}

export interface CanonicalHistoryJsonlDataSourceOptions {
  readonly activePath: string;
  /** Internal readers may share frozen records; public readers retain detached values. */
  readonly reuseDecodedRecords?: boolean;
  readonly onMalformedLine?: (line: JsonlMalformedLine) => void;
}

export interface CanonicalHistoryPublication {
  readonly status: 'published' | 'already-exists';
  readonly records: readonly CanonicalHistoryEnvelope[];
}

interface HistorySequenceState {
  readonly messageIds: Set<string>;
  readonly toolCallIds: Set<string>;
  readonly userTurnIds: Set<string>;
  pendingToolCallIds?: Set<string>;
  pendingToolCallStartIndex?: number;
  boundarySeen: boolean;
}

export type CanonicalHistorySequenceInspection =
  | { readonly status: 'settled' }
  | {
      readonly status: 'pending-tool-results';
      readonly settledPrefixLength: number;
      readonly pendingToolCallIds: readonly string[];
    };

export function decodeCanonicalHistoryEnvelope(value: unknown): CanonicalHistoryEnvelope {
  if (ownedEnvelopeJson.has(value as CanonicalHistoryEnvelope)) {
    return value as CanonicalHistoryEnvelope;
  }
  const envelope = requirePlainRecord(value, 'envelope');
  assertExactKeys(envelope, ENVELOPE_KEYS, ['message_id', 'turn_id', 'message'], 'envelope');
  assertJsonCompatible(envelope, 'envelope');

  const messageId = envelope['message_id'];
  if (typeof messageId !== 'string' || !/^(?:msg-.+|\d+)$/u.test(messageId)) {
    invalidEnvelope('message_id must match msg-.+ or contain only digits');
  }
  const turnId = requireNonEmptyString(envelope['turn_id'], 'turn_id');
  const message = decodeMessage(envelope['message']);
  const turnConfigValue = envelope['turn_config'];
  let turnConfig: CanonicalTurnConfig | undefined;
  if (turnConfigValue !== undefined) {
    if (message.role !== 'user') invalidEnvelope('turn_config is allowed only on user messages');
    turnConfig = decodeTurnConfig(turnConfigValue, true);
  }
  const artifactValue = envelope['history_artifact'];
  const historyArtifact =
    artifactValue === undefined ? undefined : decodeCanonicalHistoryArtifact(artifactValue);
  return {
    message_id: messageId,
    turn_id: turnId,
    message,
    ...(turnConfig ? { turn_config: turnConfig } : {}),
    ...(historyArtifact ? { history_artifact: historyArtifact } : {}),
  };
}

/** Returns a deep, non-mutating Turn config with credential-bearing keys removed. */
export function sanitizeCanonicalTurnConfig(value: unknown): CanonicalTurnConfig {
  const config = requirePlainRecord(value, 'turn_config');
  assertJsonCompatible(config, 'turn_config');
  const model = requirePlainRecord(config['model'], 'turn_config.model');
  return decodeTurnConfig({ ...config, model: sanitizeModelValue(model, new Set()) }, false);
}

/** Stable semantic revision: SHA-256 over recursively key-sorted JSON. */
export function canonicalHistoryRevision(records: readonly CanonicalHistoryEnvelope[]): string {
  const normalized = normalizeRecords(records);
  return revisionOfNormalized(normalized);
}

/** Stable semantic revision for an otherwise-valid active history with a legal pending tool tail. */
export function canonicalActiveHistoryRevision(
  records: readonly CanonicalHistoryEnvelope[],
): string {
  const normalized = normalizeActiveRecords(records);
  return revisionOfNormalized(normalized);
}

/** Enforces Pi boundaries, complete tool pairing, and unique message/tool-call identities. */
export function assertCanonicalHistorySequence(records: readonly CanonicalHistoryEnvelope[]): void {
  const inspection = inspectCanonicalHistorySequence(records);
  if (inspection.status === 'settled') return;
  sequenceError(
    records.length,
    `history ends before tool results: ${inspection.pendingToolCallIds.join(',')}`,
  );
}

/** Validates settled boundaries while exposing one legal pending tail of tool results. */
export function inspectCanonicalHistorySequence(
  records: readonly CanonicalHistoryEnvelope[],
): CanonicalHistorySequenceInspection {
  const cached = ownedSequences.get(records);
  if (cached) return copyInspection(cached);
  const state: HistorySequenceState = {
    messageIds: new Set(),
    toolCallIds: new Set(),
    userTurnIds: new Set(),
    boundarySeen: false,
  };
  for (let index = 0; index < records.length; index += 1) {
    if (!Object.hasOwn(records, index)) sequenceError(index, 'sparse history record');
    const envelope = records[index];
    if (!envelope) sequenceError(index, 'missing history record');
    validateSequenceRecord(envelope, index, state);
  }

  const inspection: CanonicalHistorySequenceInspection =
    state.pendingToolCallIds && state.pendingToolCallIds.size > 0
      ? {
          status: 'pending-tool-results',
          settledPrefixLength: state.pendingToolCallStartIndex ?? records.length,
          pendingToolCallIds: [...state.pendingToolCallIds],
        }
      : { status: 'settled' };
  if (ownedRecordArrays.has(records)) ownedSequences.set(records, copyInspection(inspection));
  return inspection;
}

function copyInspection(value: CanonicalHistorySequenceInspection): CanonicalHistorySequenceInspection {
  return value.status === 'settled'
    ? { status: 'settled' }
    : { ...value, pendingToolCallIds: [...value.pendingToolCallIds] };
}

/**
 * Path-only canonical history data source. It never opens SQLite or resolves a data directory;
 * migration markers remain caller-owned audit data.
 *
 * The caller must serialize all writes in a per-session lane. These primitives deliberately do
 * not provide a cross-process writer lock.
 */
export class CanonicalHistoryJsonlDataSource {
  private readonly readCache: JsonlReadCache<CanonicalHistoryEnvelope> = { bytes: Buffer.alloc(0), records: [] };

  constructor(private readonly options: CanonicalHistoryJsonlDataSourceOptions) {}

  async readActive(): Promise<CanonicalHistoryEnvelope[]> {
    return readJsonl(this.options.activePath, decodeCanonicalHistoryEnvelope, (line) =>
      reportActiveMalformedLine(line, this.options.onMalformedLine),
    );
  }

  async readActiveStrict(filePath = this.options.activePath): Promise<CanonicalHistoryEnvelope[]> {
    const records = await this.readEnvelopesStrict(filePath);
    inspectCanonicalHistorySequence(records);
    return records;
  }

  /** Decodes every envelope strictly while leaving sequence repair to the Session owner. */
  async readEnvelopesStrict(
    filePath = this.options.activePath,
  ): Promise<CanonicalHistoryEnvelope[]> {
    if (!this.options.reuseDecodedRecords) return readStrictEnvelopeFile(filePath);
    const previous = this.readCache.records;
    const records = await readJsonl(filePath, decodeOwnedEnvelope, undefined, this.readCache);
    rememberOwnedRecords(records, previous);
    return records;
  }

  /** Index scans consume positions and records from the same fresh file read. */
  async readActiveWithBytes(filePath = this.options.activePath): Promise<{
    readonly records: readonly CanonicalHistoryEnvelope[];
    readonly bytes: Buffer;
  }> {
    let bytes!: Buffer;
    const cache = this.options.reuseDecodedRecords
      ? this.readCache
      : { bytes: Buffer.alloc(0), records: [] };
    const previous = cache.records;
    const records = await readJsonl(filePath, decodeOwnedEnvelope, undefined, cache, (read) => {
      bytes = read;
    });
    rememberOwnedRecords(records, previous);
    inspectCanonicalHistorySequence(records);
    return { records, bytes };
  }

  async readStrict(filePath = this.options.activePath): Promise<CanonicalHistoryEnvelope[]> {
    return readStrictHistory(filePath);
  }

  async publishInitial(
    records: readonly CanonicalHistoryEnvelope[],
  ): Promise<CanonicalHistoryPublication> {
    const normalized = normalizeRecords(records);
    const revision = revisionOfNormalized(normalized);
    const status = await publishJsonlIfAbsent(
      this.options.activePath,
      normalized,
      async (temporaryPath) => {
        await assertFileRevision(temporaryPath, revision, 'initial history');
      },
    );
    if (status === 'published') return { status, records: normalized };
    return { status, records: await this.readActive() };
  }

  async append(
    records: readonly CanonicalHistoryEnvelope[],
    verifiedActive?: readonly CanonicalHistoryEnvelope[],
  ): Promise<void> {
    const appended = decodeRecords(records);
    if (appended.length === 0) return;
    // The Session owner may pass its strict read from this same write lane.
    // Other callers keep the existing disk read; no history survives between operations.
    const active = verifiedActive ?? (await this.readActive());
    assertCanonicalHistoryAppend(active, appended);
    await appendJsonl(this.options.activePath, appended);
  }

  async replace(records: readonly CanonicalHistoryEnvelope[]): Promise<void> {
    const replacement = normalizeRecords(records);
    const revision = revisionOfNormalized(replacement);
    await writeJsonlAtomically(this.options.activePath, replacement, async (temporaryPath) => {
      await assertFileRevision(temporaryPath, revision, 'replacement history');
    });
  }

  async replaceActive(records: readonly CanonicalHistoryEnvelope[]): Promise<void> {
    const replacement = normalizeActiveRecords(records);
    const revision = revisionOfNormalized(replacement);
    await writeJsonlAtomically(this.options.activePath, replacement, async (temporaryPath) => {
      await assertActiveFileRevision(temporaryPath, revision, 'active replacement history');
    });
  }

  async publishSnapshot(
    snapshotPath: string,
    records: readonly CanonicalHistoryEnvelope[],
  ): Promise<'published' | 'already-exists'> {
    // Active reads are line-tolerant and may expose a sequence made incomplete by a dropped line.
    // A pre-compaction snapshot must preserve every surviving authoritative envelope verbatim;
    // only the replacement is required to satisfy the complete semantic sequence contract.
    const snapshot = decodeRecords(records);
    const revision = revisionOfNormalized(snapshot);
    const status = await publishJsonlIfAbsent(snapshotPath, snapshot, async (temporaryPath) => {
      await assertSnapshotFileRevision(temporaryPath, revision);
    });
    if (status === 'published') return status;

    try {
      const existing = await readStrictEnvelopeFile(snapshotPath);
      if (revisionOfNormalized(existing) !== revision) throw new Error('revision differs');
    } catch (error) {
      throw new Error(`Canonical history snapshot conflict: ${snapshotPath}`, {
        cause: error,
      });
    }
    return status;
  }

  async compact(
    snapshotPath: string,
    replacement: readonly CanonicalHistoryEnvelope[],
  ): Promise<void> {
    const normalizedReplacement = normalizeRecords(replacement);
    const active = await this.readActive();
    await this.publishSnapshot(snapshotPath, active);
    await this.replace(normalizedReplacement);
  }
}

async function readStrictHistory(filePath: string): Promise<CanonicalHistoryEnvelope[]> {
  const records = await readStrictEnvelopeFile(filePath);
  assertCanonicalHistorySequence(records);
  return records;
}

async function readStrictEnvelopeFile(filePath: string): Promise<CanonicalHistoryEnvelope[]> {
  return readJsonl(filePath, decodeCanonicalHistoryEnvelope);
}

async function assertFileRevision(
  filePath: string,
  expectedRevision: string,
  description: string,
): Promise<void> {
  const staged = await readStrictHistory(filePath);
  if (revisionOfNormalized(staged) !== expectedRevision) {
    throw new Error(`Canonical ${description} verification failed`);
  }
}

async function assertActiveFileRevision(
  filePath: string,
  expectedRevision: string,
  description: string,
): Promise<void> {
  const staged = await readStrictEnvelopeFile(filePath);
  inspectCanonicalHistorySequence(staged);
  if (revisionOfNormalized(staged) !== expectedRevision) {
    throw new Error(`Canonical ${description} verification failed`);
  }
}

async function assertSnapshotFileRevision(
  filePath: string,
  expectedRevision: string,
): Promise<void> {
  const staged = await readStrictEnvelopeFile(filePath);
  if (revisionOfNormalized(staged) !== expectedRevision) {
    throw new Error('Canonical snapshot verification failed');
  }
}

function normalizeRecords(
  records: readonly CanonicalHistoryEnvelope[],
): CanonicalHistoryEnvelope[] {
  const normalized = decodeRecords(records);
  assertCanonicalHistorySequence(normalized);
  return normalized;
}

function normalizeActiveRecords(
  records: readonly CanonicalHistoryEnvelope[],
): CanonicalHistoryEnvelope[] {
  const normalized = decodeRecords(records);
  inspectCanonicalHistorySequence(normalized);
  return normalized;
}

function decodeRecords(records: readonly CanonicalHistoryEnvelope[]): CanonicalHistoryEnvelope[] {
  if (ownedRecordArrays.has(records)) return records as CanonicalHistoryEnvelope[];
  const decoded: CanonicalHistoryEnvelope[] = [];
  for (let index = 0; index < records.length; index += 1) {
    if (!Object.hasOwn(records, index)) invalidEnvelope(`records[${String(index)}] is sparse`);
    decoded.push(decodeCanonicalHistoryEnvelope(records[index]));
  }
  return decoded;
}

function revisionOfNormalized(records: readonly CanonicalHistoryEnvelope[]): string {
  const cached = ownedRevisions.get(records);
  if (cached !== undefined) return cached;
  // Preserve the canonical JSON array bytes without building a sorted copy and
  // serialized string of the entire history at once.
  let hash = ownedRevisionPrefixes.get(records);
  if (!hash) {
    hash = createHash('sha256').update('[');
    updateRevisionPrefix(hash, records, 0);
    if (ownedRecordArrays.has(records)) ownedRevisionPrefixes.set(records, hash);
  }
  const revision = `sha256:${hash.copy().update(']').digest('hex')}`;
  if (ownedRecordArrays.has(records)) ownedRevisions.set(records, revision);
  return revision;
}

function rememberOwnedRecords(
  records: readonly CanonicalHistoryEnvelope[],
  previous: readonly CanonicalHistoryEnvelope[],
): void {
  Object.freeze(records);
  ownedRecordArrays.add(records);
  if (records === previous) return;
  const prefix = ownedRevisionPrefixes.get(previous);
  // Fresh bytes have already been checked by readJsonl. Only its unchanged,
  // module-owned record prefix can continue a previous SHA state.
  if (!prefix || previous.length > records.length ||
      !previous.every((record, index) => record === records[index])) return;
  const hash = prefix.copy();
  updateRevisionPrefix(hash, records, previous.length);
  ownedRevisionPrefixes.set(records, hash);
}

function updateRevisionPrefix(
  hash: Hash,
  records: readonly CanonicalHistoryEnvelope[],
  start: number,
): void {
  for (let index = start; index < records.length; index += 1) {
    if (index > 0) hash.update(',');
    const record = records[index]!;
    let serialized = ownedEnvelopeJson.get(record);
    if (serialized === undefined) {
      serialized = canonicalJson(record);
      if (ownedEnvelopeJson.has(record)) ownedEnvelopeJson.set(record, serialized);
    }
    hash.update(serialized, 'utf8');
  }
}

function decodeOwnedEnvelope(value: unknown): CanonicalHistoryEnvelope {
  const record = decodeCanonicalHistoryEnvelope(value);
  freezeDecodedJson(record);
  ownedEnvelopeJson.set(record, undefined);
  return record;
}

function freezeDecodedJson(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeDecodedJson(child);
  Object.freeze(value);
}

function decodeMessage(value: unknown): CanonicalHistoryMessage {
  const message = requirePlainRecord(value, 'message');
  const role = requireNonEmptyString(message['role'], 'message.role');
  if (role === 'compactionSummary') return decodeCompactionSummary(message);
  const timestamp = message['timestamp'];
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    invalidEnvelope('message.timestamp must be finite');
  }
  return { ...message, role, timestamp } as CanonicalHistoryMessage;
}

function decodeCompactionSummary(
  message: Readonly<Record<string, unknown>>,
): CanonicalHistoryMessage {
  if (typeof message['summary'] !== 'string') {
    invalidEnvelope('message.compactionSummary.summary must be a string');
  }
  const hasTokens = Object.hasOwn(message, 'tokensBefore');
  const hasTimestamp = Object.hasOwn(message, 'timestamp');
  if (!hasTokens && !hasTimestamp) return decodeMinimalCompactionSummary(message);
  return decodeFullCompactionSummary(message, hasTokens, hasTimestamp);
}

function decodeMinimalCompactionSummary(
  message: Readonly<Record<string, unknown>>,
): MinimalNativeCompactionSummary {
  if (Object.keys(message).some((key) => key !== 'role' && key !== 'summary')) {
    invalidEnvelope('minimal message.compactionSummary must contain only role and summary');
  }
  return { role: 'compactionSummary', summary: message['summary'] as string };
}

function decodeFullCompactionSummary(
  message: Readonly<Record<string, unknown>>,
  hasTokens: boolean,
  hasTimestamp: boolean,
): TimestampedCanonicalHistoryMessage {
  const tokensBefore = message['tokensBefore'];
  const timestamp = message['timestamp'];
  if (
    hasTokens !== hasTimestamp ||
    typeof tokensBefore !== 'number' ||
    !Number.isSafeInteger(tokensBefore) ||
    tokensBefore < 0
  ) {
    invalidEnvelope('message.compactionSummary.tokensBefore must be a non-negative safe integer');
  }
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    invalidEnvelope('message.compactionSummary.timestamp must be finite');
  }
  return { ...message, role: 'compactionSummary', tokensBefore, timestamp };
}

function decodeTurnConfig(value: unknown, rejectCredentials: boolean): CanonicalTurnConfig {
  const config = requirePlainRecord(value, 'turn_config');
  assertExactKeys(config, TURN_CONFIG_KEYS, ['system_prompt', 'model'], 'turn_config');
  const systemPrompt = config['system_prompt'];
  if (typeof systemPrompt !== 'string')
    invalidEnvelope('turn_config.system_prompt must be a string');
  const model = requirePlainRecord(config['model'], 'turn_config.model');
  if (rejectCredentials) assertNoCredentialKeys(model, 'turn_config.model');
  const toolsValue = config['tools'];
  let tools: CanonicalTurnConfigTool[] | undefined;
  if (toolsValue !== undefined) {
    if (!Array.isArray(toolsValue)) invalidEnvelope('turn_config.tools must be an array');
    tools = toolsValue.map((tool, index) => decodeTurnConfigTool(tool, index));
  }
  assertJsonCompatible(config, 'turn_config');
  return {
    system_prompt: systemPrompt,
    model,
    ...(tools ? { tools } : {}),
  };
}

function decodeTurnConfigTool(value: unknown, index: number): CanonicalTurnConfigTool {
  const tool = requirePlainRecord(value, `turn_config.tools[${index}]`);
  assertExactKeys(
    tool,
    TURN_CONFIG_TOOL_KEYS,
    ['tool_name', 'description', 'schema'],
    `turn_config.tools[${index}]`,
  );
  const toolName = requireNonEmptyString(
    tool['tool_name'],
    `turn_config.tools[${index}].tool_name`,
  );
  const description = tool['description'];
  if (typeof description !== 'string') {
    invalidEnvelope(`turn_config.tools[${index}].description must be a string`);
  }
  const schema = requirePlainRecord(tool['schema'], `turn_config.tools[${index}].schema`);
  return { tool_name: toolName, description, schema };
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  context: string,
): void {
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) invalidEnvelope(`${context} contains unsupported key ${extra}`);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) invalidEnvelope(`${context} is missing ${missing}`);
}

function assertNoCredentialKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoCredentialKeys(value[index], `${path}[${String(index)}]`);
    }
    return;
  }
  if (!isPlainRecord(value)) return;
  Object.entries(value).forEach(([key, entry]) => {
    if (isSensitiveKey(key)) {
      throw new Error(
        `Canonical history envelope contains an unsanitized credential key: ${path}.${key}`,
      );
    }
    assertNoCredentialKeys(entry, `${path}.${key}`);
  });
}

function sanitizeModelValue(value: unknown, ancestors: Set<object>): unknown {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) invalidEnvelope('turn_config contains a cycle');
    ancestors.add(value);
    try {
      return Array.from(value, (entry) => sanitizeModelValue(entry, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isPlainRecord(value)) return value;
  if (ancestors.has(value)) invalidEnvelope('turn_config contains a cycle');
  ancestors.add(value);
  try {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isSensitiveKey(key))
        .map(([key, entry]) => [key, sanitizeModelValue(entry, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function isSensitiveKey(key: string): boolean {
  const words = canonicalizeSensitiveKeyWords(key);
  const compact = words.join('');
  if (hasPublicCredentialMetadataSuffix(words, compact)) return false;
  return hasSensitiveKeyShape(words, compact);
}

function hasSensitiveKeyShape(words: readonly string[], compact: string): boolean {
  if (SENSITIVE_COMPACT_KEYS.has(compact)) return true;
  if (SENSITIVE_COMPACT_SUFFIXES.some((suffix) => compact.endsWith(suffix))) return true;
  if (words.some((word) => SENSITIVE_KEY_WORDS.has(word))) return true;
  return SENSITIVE_KEY_WORD_SEQUENCES.some((sequence) => containsWordSequence(words, sequence));
}

function hasPublicCredentialMetadataSuffix(words: readonly string[], compact: string): boolean {
  const lastWord = words[words.length - 1];
  if (lastWord !== undefined && PUBLIC_CREDENTIAL_METADATA_SUFFIX_WORDS.has(lastWord)) return true;
  if (isPublicTokenMetric(words, compact)) return true;
  return lastWord === 'at' && words[words.length - 2] === 'expires';
}

function isPublicTokenMetric(words: readonly string[], compact: string): boolean {
  if (PUBLIC_TOKEN_METRIC_COMPACT_KEYS.has(compact)) return true;
  const { metricWords, trailingQualifier } = tokenMetricShape(words);
  const tokenWord = metricWords.at(-1);
  if (!isTokenMetricWord(tokenWord)) return false;

  const prefixWords = metricWords.slice(0, -1);
  if (hasSensitiveKeyShape(prefixWords, prefixWords.join(''))) return false;
  if (prefixWords.length === 0) return isBareTokensUsed(tokenWord, trailingQualifier);
  if (isSingularTokenWithoutDetails(tokenWord, trailingQualifier)) return false;
  return isPublicTokenMetricQualifier(prefixWords.at(-1));
}

function tokenMetricShape(words: readonly string[]): {
  readonly metricWords: readonly string[];
  readonly trailingQualifier: string | undefined;
} {
  const trailingQualifier = words.at(-1);
  if (TOKEN_METRIC_TRAILING_QUALIFIERS.has(trailingQualifier ?? '')) {
    return { metricWords: words.slice(0, -1), trailingQualifier };
  }
  return { metricWords: words, trailingQualifier };
}

function isTokenMetricWord(word: string | undefined): word is 'token' | 'tokens' {
  return TOKEN_METRIC_WORDS.has(word ?? '');
}

function isBareTokensUsed(tokenWord: 'token' | 'tokens', trailingQualifier: string | undefined) {
  return tokenWord === 'tokens' && trailingQualifier === 'used';
}

function isSingularTokenWithoutDetails(
  tokenWord: 'token' | 'tokens',
  trailingQualifier: string | undefined,
) {
  return tokenWord === 'token' && trailingQualifier !== 'details';
}

function isPublicTokenMetricQualifier(word: string | undefined): boolean {
  return word !== undefined && PUBLIC_TOKEN_METRIC_QUALIFIER_WORDS.has(word);
}

function canonicalizeSensitiveKeyWords(key: string): string[] {
  return key
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0);
}

function containsWordSequence(words: readonly string[], sequence: readonly string[]): boolean {
  for (let start = 0; start <= words.length - sequence.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (words[start + offset] !== sequence[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function validateSequenceRecord(
  envelope: CanonicalHistoryEnvelope,
  index: number,
  state: HistorySequenceState,
): void {
  if (envelope.history_artifact !== undefined && index !== 0) {
    sequenceError(index, 'history artifact marker must be attached only to the first envelope');
  }
  validateMessageIdentity(envelope.message_id, index, state.messageIds);
  validateTurnConfigAnchor(envelope, index, state.userTurnIds);
  validateCompactionBoundary(envelope.message, index, state);
  if (consumeToolResult(envelope.message, index, state)) return;
  assertNoPendingToolResults(index, state.pendingToolCallIds);
  if (envelope.message.role === 'assistant') {
    state.pendingToolCallIds = readAssistantToolCalls(envelope.message, index, state.toolCallIds);
    state.pendingToolCallStartIndex = state.pendingToolCallIds ? index : undefined;
  }
}

/**
 * Append validates the new suffix without reclassifying tolerated active anomalies as write
 * blockers. Only an otherwise-valid trailing tool call is carried forward as pending, because
 * tool results are durably committed after the assistant tool-call message.
 */
function assertCanonicalHistoryAppend(
  active: readonly CanonicalHistoryEnvelope[],
  appended: readonly CanonicalHistoryEnvelope[],
): void {
  const state = deriveAppendState(active);
  appended.forEach((envelope, index) =>
    validateSequenceRecord(envelope, active.length + index, state),
  );
}

function deriveAppendState(active: readonly CanonicalHistoryEnvelope[]): HistorySequenceState {
  const state: HistorySequenceState = {
    messageIds: new Set(),
    toolCallIds: new Set(),
    userTurnIds: new Set(),
    boundarySeen: false,
  };
  for (const envelope of active) updateAppendStateFromActive(envelope, state);
  return state;
}

function updateAppendStateFromActive(
  envelope: CanonicalHistoryEnvelope,
  state: HistorySequenceState,
): void {
  state.messageIds.add(envelope.message_id);
  if (envelope.message.role === 'user') state.userTurnIds.add(envelope.turn_id);
  if (
    envelope.message.role === 'compactionSummary' ||
    Object.hasOwn(envelope.message, 'archonCompaction')
  ) {
    state.boundarySeen = true;
  }

  const toolCallIds = tolerantAssistantToolCallIds(envelope.message);
  toolCallIds.forEach((id) => state.toolCallIds.add(id));
  if (envelope.message.role === 'toolResult') {
    consumeActiveToolResultTolerantly(envelope.message, state);
    return;
  }
  if (state.pendingToolCallIds && state.pendingToolCallIds.size > 0) {
    state.pendingToolCallIds = undefined;
    state.pendingToolCallStartIndex = undefined;
  }
  if (toolCallIds.length > 0) {
    state.pendingToolCallIds = new Set(toolCallIds);
  }
}

function tolerantAssistantToolCallIds(message: CanonicalHistoryMessage): string[] {
  if (message.role !== 'assistant' || !Array.isArray(message['content'])) return [];
  return message['content'].flatMap((block) => {
    if (!isPlainRecord(block) || block['type'] !== 'toolCall') return [];
    const id = nonEmptyString(block['id']);
    return id ? [id] : [];
  });
}

function consumeActiveToolResultTolerantly(
  message: CanonicalHistoryMessage,
  state: HistorySequenceState,
): void {
  const toolCallId = nonEmptyString(message['toolCallId']);
  if (!toolCallId || !state.pendingToolCallIds?.has(toolCallId)) {
    state.pendingToolCallIds = undefined;
    state.pendingToolCallStartIndex = undefined;
    return;
  }
  state.pendingToolCallIds.delete(toolCallId);
  if (state.pendingToolCallIds.size === 0) {
    state.pendingToolCallIds = undefined;
    state.pendingToolCallStartIndex = undefined;
  }
}

function validateTurnConfigAnchor(
  envelope: CanonicalHistoryEnvelope,
  index: number,
  userTurnIds: Set<string>,
): void {
  if (envelope.message.role !== 'user') return;
  const firstUserForTurn = !userTurnIds.has(envelope.turn_id);
  if (envelope.turn_config !== undefined && !firstUserForTurn) {
    sequenceError(
      index,
      `turn_config must be attached only to the first user message of turn ${envelope.turn_id}`,
    );
  }
  userTurnIds.add(envelope.turn_id);
}

function validateMessageIdentity(messageId: string, index: number, seen: Set<string>): void {
  if (seen.has(messageId)) sequenceError(index, `duplicate message identity ${messageId}`);
  seen.add(messageId);
}

function validateCompactionBoundary(
  message: CanonicalHistoryMessage,
  index: number,
  state: HistorySequenceState,
): void {
  if (!isCompactionBoundary(message, index)) return;
  if (state.boundarySeen || index !== 0) {
    sequenceError(index, 'compaction boundary must be the unique first message');
  }
  state.boundarySeen = true;
}

function consumeToolResult(
  message: CanonicalHistoryMessage,
  index: number,
  state: HistorySequenceState,
): boolean {
  if (message.role !== 'toolResult') return false;
  const toolCallId = nonEmptyString(message['toolCallId']);
  if (!toolCallId || !state.pendingToolCallIds?.has(toolCallId)) {
    sequenceError(index, `orphan or out-of-order tool result ${toolCallId ?? '<missing>'}`);
  }
  state.pendingToolCallIds.delete(toolCallId);
  if (state.pendingToolCallIds.size === 0) {
    state.pendingToolCallIds = undefined;
    state.pendingToolCallStartIndex = undefined;
  }
  return true;
}

function assertNoPendingToolResults(
  index: number,
  pendingToolCallIds: ReadonlySet<string> | undefined,
): void {
  if (!pendingToolCallIds || pendingToolCallIds.size === 0) return;
  sequenceError(
    index,
    `tool results must immediately follow their assistant call: ${[...pendingToolCallIds].join(',')}`,
  );
}

function readAssistantToolCalls(
  message: CanonicalHistoryMessage,
  index: number,
  seen: Set<string>,
): Set<string> | undefined {
  const content = message['content'];
  if (!Array.isArray(content)) sequenceError(index, 'assistant content must be an array');
  const ids = content.flatMap((block, blockIndex) =>
    readToolCallId(block, blockIndex, index, seen),
  );
  return ids.length > 0 ? new Set(ids) : undefined;
}

function readToolCallId(
  block: unknown,
  blockIndex: number,
  messageIndex: number,
  seen: Set<string>,
): string[] {
  if (!isPlainRecord(block) || block['type'] !== 'toolCall') return [];
  const id = nonEmptyString(block['id']);
  if (!id) sequenceError(messageIndex, `tool call ${blockIndex + 1} has no identity`);
  if (seen.has(id)) sequenceError(messageIndex, `duplicate tool call identity ${id}`);
  seen.add(id);
  return [id];
}

function isCompactionBoundary(message: CanonicalHistoryMessage, index: number): boolean {
  if (message.role === 'compactionSummary') {
    if (!isNativeCompactionSummary(message)) {
      sequenceError(index, 'legacy compaction summary is malformed');
    }
    return true;
  }
  if (!Object.hasOwn(message, 'archonCompaction')) return false;
  const marker = message['archonCompaction'];
  if (message.role !== 'user' || !isPlainRecord(marker)) {
    sequenceError(index, 'Archon compaction boundary is malformed');
  }
  if (marker['schemaVersion'] === 2) {
    assertGenerationCompactionMarker(marker, index);
    return true;
  }
  if (!isArchonCompactionMarker(marker)) {
    sequenceError(index, 'Archon compaction boundary is malformed');
  }
  return true;
}

function assertGenerationCompactionMarker(marker: Record<string, unknown>, index: number): void {
  const generation = safeInteger(marker['generation'], 1);
  const parent = marker['parentSnapshot'];
  if (
    marker['schemaVersion'] !== 2 ||
    generation === undefined ||
    !isPlainRecord(parent) ||
    !isValidParentSnapshot(parent)
  ) {
    sequenceError(index, 'Archon compaction boundary is malformed');
  }
  const parentGeneration = safeInteger(parent['generation'], 0);
  if (parentGeneration === undefined || parentGeneration + 1 !== generation) {
    sequenceError(index, 'Archon compaction generation chain is malformed');
  }
}

function isValidParentSnapshot(parent: Record<string, unknown>): boolean {
  return (
    safeInteger(parent['generation'], 0) !== undefined &&
    typeof parent['compactionId'] === 'string' &&
    parent['compactionId'].length > 0 &&
    typeof parent['revision'] === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(parent['revision'])
  );
}

function safeInteger(value: unknown, minimum: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
    ? value
    : undefined;
}

function isNativeCompactionSummary(message: CanonicalHistoryMessage): boolean {
  if (typeof message['summary'] !== 'string') return false;
  const hasTokens = Object.hasOwn(message, 'tokensBefore');
  const hasTimestamp = Object.hasOwn(message, 'timestamp');
  if (!hasTokens && !hasTimestamp) return true;
  const tokensBefore = message['tokensBefore'];
  return (
    hasTokens === hasTimestamp &&
    typeof tokensBefore === 'number' &&
    Number.isSafeInteger(tokensBefore) &&
    tokensBefore >= 0 &&
    typeof message['timestamp'] === 'number' &&
    Number.isFinite(message['timestamp'])
  );
}

function isArchonCompactionMarker(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value['summary'] !== 'string') return false;
  if (value['schemaVersion'] === 1) return true;
  if (value['version'] !== 2 || !Array.isArray(value['recentUserQueries'])) return false;
  const queriesValid = value['recentUserQueries'].every(
    (query) =>
      isPlainRecord(query) &&
      typeof query['text'] === 'string' &&
      query['text'].trim().length > 0 &&
      (query['timestampMs'] === undefined ||
        (typeof query['timestampMs'] === 'number' && Number.isFinite(query['timestampMs']))),
  );
  if (!queriesValid || value['todoState'] === undefined) return queriesValid;
  return (
    Array.isArray(value['todoState']) &&
    value['todoState'].every(
      (item) =>
        isPlainRecord(item) &&
        nonEmptyString(item['content']) !== undefined &&
        nonEmptyString(item['status']) !== undefined &&
        nonEmptyString(item['priority']) !== undefined,
    )
  );
}

function requirePlainRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isPlainRecord(value)) invalidEnvelope(`${context} must be a plain object`);
  return value;
}

function requireNonEmptyString(value: unknown, context: string): string {
  const text = nonEmptyString(value);
  if (!text) invalidEnvelope(`${context} must be a non-empty string`);
  return text;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function invalidEnvelope(reason: string): never {
  throw new Error(`Canonical history envelope is invalid: ${reason}`);
}

function sequenceError(index: number, reason: string): never {
  throw new Error(`Canonical history sequence is invalid at record ${index + 1}: ${reason}`);
}

function ignoreMalformedLine(_line: JsonlMalformedLine): void {
  // Active history is intentionally tolerant. Callers can install an observer for diagnostics.
}

function reportActiveMalformedLine(
  line: JsonlMalformedLine,
  observer: CanonicalHistoryJsonlDataSourceOptions['onMalformedLine'],
): void {
  (observer ?? ignoreMalformedLine)(line);
}
