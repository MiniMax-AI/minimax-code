import type { sessions } from '../../../../../infra/db/schema/sessions.js';
import type { ConversationModelThinkingSelection } from '@mavis/conversation-contract';
import { canonicalProjectWorkspaceDir } from '../../../shared/workspace.js';
import {
  SESSION_KINDS,
  SESSION_RUN_LOCATION_MODES,
  SESSION_RUNTIMES,
  SESSION_STATUSES,
  SESSION_VISIBILITIES,
  type AppMode,
  type SessionToolCallMode,
  type SessionDataOrigin,
  type SessionOrigin,
  type SessionInteractionMode,
  type SessionRecord,
  type SessionRunLocation,
  type SessionWriteRecord,
} from '../contract.js';
import { normalizePersistedSessionKind, normalizeSessionType } from './normalization.js';
import { readSessionMemoryPolicy, type SessionMemoryPolicy } from '../../memory-policy.js';

export const CURRENT_SESSION_COLUMNAR_VERSION = 3;

export type SessionStorageRow = typeof sessions.$inferSelect;

export interface SessionExtraData {
  readonly runLocation?: SessionRunLocation;
  readonly appMode?: AppMode;
  readonly toolCallMode?: SessionToolCallMode;
  readonly interactionMode?: SessionInteractionMode;
  readonly memoryPolicy?: SessionMemoryPolicy;
  readonly errorSource?: string;
  readonly errorDetail?: string;
  readonly errorProviderId?: string;
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly effectiveModelThinking?: ConversationModelThinkingSelection | null;
  readonly effectiveModelContextWindow?: number | null;
  readonly effectiveModelMaxOutputTokens?: number | null;
  readonly scratchpadPath?: string;
  readonly origin?: SessionOrigin;
  readonly sessionDataVersion?: number;
  readonly sessionOrigin?: SessionDataOrigin;
}

export function encodeSessionRow(
  record: SessionWriteRecord,
  options?: {
    readonly preservedRecordJson?: string;
    readonly projectId?: number | null;
  },
): SessionStorageRow {
  const sessionType = normalizeSessionType(record.sessionType, 'Session.sessionType');
  validateSessionRecord({ ...record, sessionType });
  return {
    sessionId: record.sessionId,
    recordJson: preservedRecordJson({ ...record, sessionType }, options),
    updatedAtMs: record.updatedAtMs,
    columnarVersion: CURRENT_SESSION_COLUMNAR_VERSION,
    agentName: record.agentName,
    runtime: record.runtime,
    sessionType,
    status: record.status,
    archived: booleanBit(record.archived),
    visibility: valueOr(record.visibility, 'visible'),
    sessionKind: record.sessionKind,
    purpose: nullable(record.purpose),
    purposeKind: '',
    originCronId: nullable(record.originCronId),
    parentSessionId: nullable(record.parentSessionId),
    workspaceDir: record.workspaceDir,
    projectWorkspaceDir: nullable(
      canonicalProjectWorkspaceDir(record.workspaceDir, record.runLocation),
    ),
    isDefaultWorkspace: booleanBit(record.isDefaultWorkspace === true),
    title: nullable(record.title),
    createdAtMs: record.createdAtMs,
    errorMessage: nullable(record.errorMessage),
    errorCode: nullable(record.errorCode),
    extraDataJson: serializeSessionExtraData(
      sessionExtraDataFromRecord({ ...record, sessionType }),
    ),
    projectId: projectId(options),
    historyRelativeDir: nullable(record.historyRelativeDir),
  };
}

export function decodeSessionRow(row: SessionStorageRow): SessionRecord {
  if (row.columnarVersion !== CURRENT_SESSION_COLUMNAR_VERSION) {
    throw new Error(
      `Session ${row.sessionId}.columnar_version must be ${String(CURRENT_SESSION_COLUMNAR_VERSION)}`,
    );
  }
  const updatedAtMs = requireSafeInteger(row.updatedAtMs, `Session ${row.sessionId}.updated_at_ms`);
  const extra = parseSessionExtraData(row.extraDataJson);
  const sessionType = normalizeSessionType(
    row.sessionType,
    `Session ${row.sessionId}.session_type`,
  );
  const visibility = requireEnum(
    row.visibility,
    SESSION_VISIBILITIES,
    `Session ${row.sessionId}.visibility`,
  );
  const sessionKind = normalizePersistedSessionKind({
    sessionKind: requireEnum(
      row.sessionKind,
      SESSION_KINDS,
      `Session ${row.sessionId}.session_kind`,
    ),
    sessionType,
    parentSessionId: row.parentSessionId,
    visibility,
    ...(row.purpose !== null ? { purpose: row.purpose } : {}),
    ...(row.originCronId !== null ? { originCronId: row.originCronId } : {}),
  });
  return withoutRootAppMode({
    sessionId: row.sessionId,
    agentName: requireString(row.agentName, `Session ${row.sessionId}.agent_name`),
    workspaceDir: requireString(row.workspaceDir, `Session ${row.sessionId}.workspace_dir`),
    isDefaultWorkspace:
      requireBit(row.isDefaultWorkspace, `Session ${row.sessionId}.is_default_workspace`) === 1,
    runtime: requireEnum(row.runtime, SESSION_RUNTIMES, `Session ${row.sessionId}.runtime`),
    sessionType,
    sessionKind,
    archived: requireBit(row.archived, `Session ${row.sessionId}.archived`) === 1,
    title: row.title,
    parentSessionId: row.parentSessionId,
    visibility,
    ...(row.purpose !== null ? { purpose: row.purpose } : {}),
    ...(row.originCronId !== null ? { originCronId: row.originCronId } : {}),
    ...extra,
    status: requireEnum(row.status, SESSION_STATUSES, `Session ${row.sessionId}.status`),
    ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
    ...(row.errorCode !== null
      ? {
          errorCode: requireSafeInteger(row.errorCode, `Session ${row.sessionId}.error_code`),
        }
      : {}),
    ...(row.historyRelativeDir !== null ? { historyRelativeDir: row.historyRelativeDir } : {}),
    createdAtMs:
      row.createdAtMs === null
        ? updatedAtMs
        : requireSafeInteger(row.createdAtMs, `Session ${row.sessionId}.created_at_ms`),
    updatedAtMs,
  });
}

export function sessionExtraDataFromRecord(record: SessionRecord): SessionExtraData {
  return compactExtraData({
    runLocation: record.runLocation,
    appMode: record.sessionType === 'branch' ? record.appMode : undefined,
    toolCallMode: record.toolCallMode,
    interactionMode: record.interactionMode,
    memoryPolicy: record.memoryPolicy,
    errorSource: record.errorSource,
    errorDetail: record.errorDetail,
    errorProviderId: record.errorProviderId,
    effectiveModel: record.effectiveModel,
    effectiveModelVariant: record.effectiveModelVariant,
    effectiveModelThinking: record.effectiveModelThinking,
    effectiveModelContextWindow: record.effectiveModelContextWindow,
    effectiveModelMaxOutputTokens: record.effectiveModelMaxOutputTokens,
    scratchpadPath: record.scratchpadPath,
    origin: record.origin,
    sessionDataVersion: record.sessionDataVersion,
    sessionOrigin: record.sessionOrigin,
  });
}

export function withoutRootAppMode(record: SessionRecord): SessionRecord {
  if (record.sessionType !== 'root' || record.appMode === undefined) return record;
  const normalized = { ...record };
  delete normalized.appMode;
  return normalized;
}

export function serializeSessionExtraData(data: SessionExtraData): string {
  validateExtraData(data);
  return JSON.stringify(compactExtraData(data));
}

export function parseSessionExtraData(raw: string): SessionExtraData {
  const record = parseJsonObject(raw, 'extra_data_json');
  const runLocation = readRunLocation(record);
  return compactExtraData({
    runLocation,
    appMode: readOptionalEnum(record, 'appMode', ['coding', 'work'], 'extra_data_json'),
    interactionMode: readOptionalEnum(
      record,
      'interactionMode',
      ['plan', 'goal'],
      'extra_data_json',
    ),
    memoryPolicy: readOptionalSessionMemoryPolicy(record, 'memoryPolicy', 'extra_data_json'),
    errorSource: readOptionalString(record, 'errorSource', 'extra_data_json'),
    errorDetail: readOptionalString(record, 'errorDetail', 'extra_data_json'),
    errorProviderId: readOptionalString(record, 'errorProviderId', 'extra_data_json'),
    effectiveModel: readOptionalNullableString(record, 'effectiveModel', 'extra_data_json'),
    effectiveModelVariant: readOptionalNullableString(
      record,
      'effectiveModelVariant',
      'extra_data_json',
    ),
    effectiveModelThinking: readOptionalModelThinkingSelection(
      record,
      'effectiveModelThinking',
      'extra_data_json',
    ),
    effectiveModelContextWindow: readOptionalPositiveSafeInteger(
      record,
      'effectiveModelContextWindow',
      'extra_data_json',
    ),
    effectiveModelMaxOutputTokens: readOptionalPositiveSafeInteger(
      record,
      'effectiveModelMaxOutputTokens',
      'extra_data_json',
    ),
    scratchpadPath: readOptionalString(record, 'scratchpadPath', 'extra_data_json'),
    origin: readOptionalEnum(record, 'origin', ['user', 'root-repair'], 'extra_data_json'),
    sessionDataVersion: readOptionalSafeInteger(record, 'sessionDataVersion', 'extra_data_json'),
    sessionOrigin: readOptionalEnum(
      record,
      'sessionOrigin',
      ['local-runtime', 'legacy-opencode', 'unknown'],
      'extra_data_json',
    ),
    toolCallMode: readToolCallMode(record.toolCallMode),
  });
}

/**
 * Lenient: a value this build does not know (written by a newer client) reads as absent,
 * i.e. `native`, instead of making the whole Session undecodable.
 */
function readToolCallMode(value: unknown): SessionToolCallMode | undefined {
  return value === 'native' || value === 'ptc' ? value : undefined;
}

function validateExtraData(data: SessionExtraData): void {
  if (data.runLocation) {
    assertSafeInteger(data.runLocation.createdAt, 'extra_data_json.runLocation.createdAt');
  }
  if (data.sessionDataVersion !== undefined) {
    assertSafeInteger(data.sessionDataVersion, 'extra_data_json.sessionDataVersion');
  }
  if (data.effectiveModelThinking) {
    validateModelThinkingSelection(
      data.effectiveModelThinking,
      'extra_data_json.effectiveModelThinking',
    );
  }
  assertOptionalPositiveSafeInteger(
    data.effectiveModelContextWindow,
    'extra_data_json.effectiveModelContextWindow',
  );
  assertOptionalPositiveSafeInteger(
    data.effectiveModelMaxOutputTokens,
    'extra_data_json.effectiveModelMaxOutputTokens',
  );
  if (data.memoryPolicy) {
    readSessionMemoryPolicy(data.memoryPolicy, 'extra_data_json.memoryPolicy');
  }
}

function readOptionalSessionMemoryPolicy(
  record: Record<string, unknown>,
  key: string,
  field: string,
): SessionMemoryPolicy | undefined {
  const value = record[key];
  return value === undefined || value === null
    ? undefined
    : readSessionMemoryPolicy(value, `${field}.${key}`);
}

function readOptionalModelThinkingSelection(
  record: Record<string, unknown>,
  key: string,
  field: string,
): ConversationModelThinkingSelection | null | undefined {
  const value = record[key];
  if (value === undefined || value === null) return value;
  if (!isPlainObject(value)) throw new Error(`${field}.${key} must be an object or null`);
  const selection = {
    ...optionalThinkingString(value, 'effort', `${field}.${key}`),
    ...optionalThinkingString(value, 'off_behavior', `${field}.${key}`),
    ...optionalThinkingBudgets(value, `${field}.${key}`),
  } satisfies ConversationModelThinkingSelection;
  return Object.keys(selection).length > 0 ? selection : null;
}

function validateModelThinkingSelection(
  selection: ConversationModelThinkingSelection,
  field: string,
): void {
  if (selection.effort !== undefined && typeof selection.effort !== 'string') {
    throw new Error(`${field}.effort must be a string`);
  }
  if (selection.off_behavior !== undefined && typeof selection.off_behavior !== 'string') {
    throw new Error(`${field}.off_behavior must be a string`);
  }
  if (selection.budgets) {
    for (const key of ['minimal', 'low', 'medium', 'high'] as const) {
      const value = selection.budgets[key];
      if (value !== undefined && typeof value !== 'string' && typeof value !== 'number') {
        throw new Error(`${field}.budgets.${key} must be a string or number`);
      }
    }
  }
}

function optionalThinkingString(
  record: Record<string, unknown>,
  key: 'effort' | 'off_behavior',
  field: string,
): Partial<Pick<ConversationModelThinkingSelection, typeof key>> {
  const value = readOptionalString(record, key, field);
  return value === undefined ? {} : { [key]: value };
}

function optionalThinkingBudgets(
  record: Record<string, unknown>,
  field: string,
): Pick<ConversationModelThinkingSelection, 'budgets'> | Record<never, never> {
  const value = record.budgets;
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw new Error(`${field}.budgets must be an object`);
  const budgets: {
    minimal?: number | string;
    low?: number | string;
    medium?: number | string;
    high?: number | string;
  } = {};
  for (const key of ['minimal', 'low', 'medium', 'high'] as const) {
    const budget = value[key];
    if (budget === undefined || budget === null) continue;
    if (typeof budget !== 'string' && typeof budget !== 'number') {
      throw new Error(`${field}.budgets.${key} must be a string or number`);
    }
    budgets[key] = budget;
  }
  return Object.keys(budgets).length > 0 ? { budgets } : {};
}

function readRunLocation(record: Record<string, unknown>): SessionRunLocation | undefined {
  const value = readOptionalObject(record, 'runLocation', 'extra_data_json');
  if (!value) return undefined;
  const resolvedBranch = readOptionalString(value, 'resolvedBranch', 'extra_data_json.runLocation');
  const parentRepoDir = readOptionalString(value, 'parentRepoDir', 'extra_data_json.runLocation');
  return {
    mode: requireEnum(
      readRequiredString(value, 'mode', 'extra_data_json.runLocation'),
      SESSION_RUN_LOCATION_MODES,
      'extra_data_json.runLocation.mode',
    ),
    resolvedDir: readRequiredString(value, 'resolvedDir', 'extra_data_json.runLocation'),
    ...(resolvedBranch !== undefined ? { resolvedBranch } : {}),
    ...(parentRepoDir !== undefined ? { parentRepoDir } : {}),
    createdAt: requireSafeInteger(value.createdAt, 'extra_data_json.runLocation.createdAt'),
  };
}

function validateSessionRecord(record: SessionRecord): void {
  assertSafeInteger(record.createdAtMs, 'Session.createdAtMs');
  assertSafeInteger(record.updatedAtMs, 'Session.updatedAtMs');
  if (record.errorCode !== undefined) assertSafeInteger(record.errorCode, 'Session.errorCode');
}

function preservedRecordJson(
  record: SessionRecord,
  options: { readonly preservedRecordJson?: string } | undefined,
): string {
  return options?.preservedRecordJson ?? v1InertRecordJson(record);
}

function v1InertRecordJson(record: SessionRecord): string {
  return JSON.stringify({
    sessionId: record.sessionId,
    agentName: '__local_runtime_v2__',
    workspaceDir: record.workspaceDir,
    runtime: record.runtime,
    sessionType: record.sessionType,
    archived: true,
    visibility: 'hidden',
    status: 'idle',
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
  });
}

function projectId(options: { readonly projectId?: number | null } | undefined): number | null {
  return options?.projectId ?? null;
}

function booleanBit(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function nullable<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

function valueOr<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback;
}

function compactExtraData(data: SessionExtraData): SessionExtraData {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  ) as SessionExtraData;
}

function parseJsonObject(raw: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${field} is not valid JSON`, { cause: error });
  }
  if (!isPlainObject(parsed)) throw new Error(`${field} must be an object`);
  return parsed;
}

function readRequiredString(record: Record<string, unknown>, key: string, field: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`${field}.${key} must be a string`);
  return value;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field}.${key} must be a string`);
  return value;
}

function readOptionalNullableString(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string | null | undefined {
  const value = record[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') throw new Error(`${field}.${key} must be a string or null`);
  return value;
}

function readOptionalSafeInteger(
  record: Record<string, unknown>,
  key: string,
  field: string,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  return requireSafeInteger(value, `${field}.${key}`);
}

function readOptionalPositiveSafeInteger(
  record: Record<string, unknown>,
  key: string,
  field: string,
): number | null | undefined {
  const raw = record[key];
  if (raw === undefined || raw === null) return raw;
  const value = requireSafeInteger(raw, `${field}.${key}`);
  if (value <= 0) {
    throw new Error(`${field}.${key} must be a positive safe integer`);
  }
  return value;
}

function readOptionalObject(
  record: Record<string, unknown>,
  key: string,
  field: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw new Error(`${field}.${key} must be an object`);
  return value;
}

function readOptionalEnum<const T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  field: string,
): T | undefined {
  const value = readOptionalString(record, key, field);
  return value === undefined ? undefined : requireEnum(value, allowed, `${field}.${key}`);
}

function requireString(value: string | null, field: string): string {
  if (value === null) throw new Error(`${field} must be a string`);
  return value;
}

function requireEnum<const T extends string>(
  value: string | null,
  allowed: readonly T[],
  field: string,
): T {
  const result = allowed.find((candidate) => candidate === value);
  if (result === undefined) throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  return result;
}

function requireBit(value: number, field: string): 0 | 1 {
  if (value !== 0 && value !== 1) throw new Error(`${field} must be 0 or 1`);
  return value;
}

function assertSafeInteger(value: number, field: string): void {
  requireSafeInteger(value, field);
}

function assertOptionalPositiveSafeInteger(value: number | null | undefined, field: string): void {
  if (value === undefined || value === null) return;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

function requireSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a safe integer`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
