import type { SessionCreateInput, SessionRecord } from '../contract.js';
import { normalizeSessionType } from './normalization.js';

export function recordFromCreate(input: SessionCreateInput, nowMs: number): SessionRecord {
  const sessionType = normalizeSessionType(input.sessionType ?? 'branch');
  return {
    ...recordIdentityFields(input, sessionType),
    ...recordStateFields(input),
    ...recordErrorFields(input),
    ...recordModelFields(input),
    ...recordProvenanceFields(input, nowMs),
    ...(input.toolCallMode ? { toolCallMode: input.toolCallMode } : {}),
  };
}

function recordIdentityFields(
  input: SessionCreateInput,
  sessionType: SessionRecord['sessionType'],
): Pick<
  SessionRecord,
  | 'sessionId'
  | 'agentName'
  | 'workspaceDir'
  | 'runtime'
  | 'sessionType'
  | 'sessionKind'
  | 'title'
  | 'parentSessionId'
  | 'purpose'
  | 'originCronId'
  | 'isDefaultWorkspace'
  | 'runLocation'
  | 'appMode'
> {
  return {
    sessionId: input.sessionId,
    agentName: input.agentName,
    workspaceDir: input.workspaceDir,
    runtime: input.runtime,
    sessionType,
    sessionKind: input.sessionKind ?? 'conversation',
    title: input.title ?? null,
    parentSessionId: input.parentSessionId ?? null,
    purpose: input.purpose,
    originCronId: input.originCronId,
    isDefaultWorkspace: input.isDefaultWorkspace,
    runLocation: input.runLocation,
    ...appModeFields(sessionType, input.appMode),
  };
}

function recordStateFields(
  input: SessionCreateInput,
): Pick<SessionRecord, 'status' | 'archived' | 'visibility' | 'memoryPolicy'> {
  return {
    status: input.status ?? 'idle',
    archived: input.archived ?? false,
    visibility: input.visibility ?? 'visible',
    memoryPolicy: input.memoryPolicy,
  };
}

function recordErrorFields(
  input: SessionCreateInput,
): Pick<
  SessionRecord,
  'errorMessage' | 'errorCode' | 'errorSource' | 'errorDetail' | 'errorProviderId'
> {
  return {
    errorMessage: input.errorMessage,
    errorCode: input.errorCode,
    errorSource: input.errorSource,
    errorDetail: input.errorDetail,
    errorProviderId: input.errorProviderId,
  };
}

function recordModelFields(
  input: SessionCreateInput,
): Pick<
  SessionRecord,
  | 'effectiveModel'
  | 'effectiveModelVariant'
  | 'effectiveModelThinking'
  | 'effectiveModelContextWindow'
  | 'effectiveModelMaxOutputTokens'
> {
  return {
    effectiveModel: input.effectiveModel,
    effectiveModelVariant: input.effectiveModelVariant,
    effectiveModelThinking: input.effectiveModelThinking,
    effectiveModelContextWindow: input.effectiveModelContextWindow,
    effectiveModelMaxOutputTokens: input.effectiveModelMaxOutputTokens,
  };
}

function recordProvenanceFields(
  input: SessionCreateInput,
  nowMs: number,
): Pick<
  SessionRecord,
  | 'origin'
  | 'sessionOrigin'
  | 'sessionDataVersion'
  | 'scratchpadPath'
  | 'createdAtMs'
  | 'updatedAtMs'
> {
  return {
    origin: input.origin,
    sessionOrigin: input.sessionOrigin,
    sessionDataVersion: input.sessionDataVersion,
    scratchpadPath: input.scratchpadPath,
    createdAtMs: input.createdAtMs ?? nowMs,
    updatedAtMs: input.updatedAtMs ?? nowMs,
  };
}

function appModeFields(
  sessionType: SessionRecord['sessionType'],
  appMode: SessionRecord['appMode'],
): Partial<Pick<SessionRecord, 'appMode'>> {
  if (sessionType === 'root' || appMode === undefined) return {};
  return { appMode };
}
