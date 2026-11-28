import type { ConversationModelThinkingSelection } from '@mavis/conversation-contract';

import type { SessionKind, SessionRecord } from '../repo/contract.js';
import { SessionServiceError } from '../errors.js';
import { applySessionMemoryPolicyPatch, effectiveSessionMemoryPolicy } from '../memory-policy.js';
import type { SessionMutationFields, SessionMetadataUpdateFields } from './lifecycle-contract.js';

export type SessionAppMode = NonNullable<SessionRecord['appMode']>;

export type { SessionMetadataUpdateFields } from './lifecycle-contract.js';

export function normalizeMemoryPolicyMutation(
  current: SessionRecord,
  fields: SessionMutationFields,
): SessionMetadataUpdateFields {
  const { memoryPolicy, ...rest } = fields;
  if (memoryPolicy === undefined) return rest;
  const policy = effectiveSessionMemoryPolicy(current.memoryPolicy);
  if (
    policy.recallLocked &&
    memoryPolicy.recallEnabled !== undefined &&
    memoryPolicy.recallEnabled !== policy.recallEnabled
  ) {
    throw new SessionServiceError(
      'memory-recall-locked',
      'Memory recall cannot be changed after the conversation starts',
    );
  }
  return {
    ...rest,
    memoryPolicy: applySessionMemoryPolicyPatch(current.memoryPolicy, memoryPolicy),
  };
}

export function assertTaskParent(
  sessionKind: SessionKind,
  parent: SessionRecord | undefined,
): void {
  if (sessionKind === 'task' && !parent) {
    throw new SessionServiceError('parent-required', 'task Session requires a parent Session');
  }
}

export function taskWorkspaceFor(
  sessionKind: SessionKind,
  parent: SessionRecord | undefined,
): string | undefined {
  return sessionKind === 'task' ? parent?.workspaceDir : undefined;
}

export function taskMemoryPolicyFor(
  sessionKind: SessionKind,
  parent: SessionRecord | undefined,
): SessionRecord['memoryPolicy'] | undefined {
  return sessionKind === 'task' ? effectiveSessionMemoryPolicy(parent?.memoryPolicy) : undefined;
}

export function taskAdvisorFor(
  sessionKind: SessionKind,
  parent: SessionRecord | undefined,
): NonNullable<SessionRecord['advisor']> | undefined {
  return sessionKind === 'task' ? (parent?.advisor ?? undefined) : undefined;
}

export function createDefaultWorkspaceIdentity(input: {
  readonly taskWorkspace?: string;
  readonly parent: SessionRecord | undefined;
  readonly runLocation: SessionRecord['runLocation'];
  readonly explicitWorkspaceDir: string | undefined;
  readonly requested: boolean | undefined;
}): boolean {
  if (input.taskWorkspace !== undefined) return input.parent?.isDefaultWorkspace === true;
  if (input.runLocation || input.explicitWorkspaceDir) return false;
  return input.requested ?? true;
}

export function visibilityForKind(
  kind: SessionKind,
  requested: SessionRecord['visibility'],
  parent: SessionRecord['visibility'],
): SessionRecord['visibility'] {
  if (parent === 'hidden') return 'hidden';
  if (kind === 'task') return 'visible';
  if (kind === 'peek') return 'hidden';
  return requested;
}

export function visibilityForInternalKind(
  kind: SessionKind,
  requested: SessionRecord['visibility'],
  parent: SessionRecord['visibility'],
): SessionRecord['visibility'] {
  if (kind === 'task') return 'visible';
  if (kind === 'peek') return 'hidden';
  return requested ?? parent;
}

export function assertNativeMutation(session: SessionRecord): void {
  if (session.runtime !== 'pi-agent') {
    throw new SessionServiceError(
      'runtime-unsupported',
      'Legacy opencode Session mutation is unavailable',
    );
  }
}

export function sessionNotFound(sessionId: string): SessionServiceError {
  return new SessionServiceError('session-not-found', `Session not found: ${sessionId}`);
}

export function normalizeAppMode(value: unknown): SessionAppMode {
  return value === 'work' ? 'work' : 'coding';
}

export function appModeFields(
  sessionType: SessionRecord['sessionType'],
  appMode: SessionAppMode | undefined,
): Partial<{ readonly appMode: SessionAppMode }> {
  return sessionType === 'branch' ? { appMode: appMode ?? 'coding' } : {};
}

export function modelKey(
  providerId: string | undefined,
  modelId: string | undefined,
): string | undefined {
  const provider = nonEmpty(providerId);
  const model = nonEmpty(modelId);
  return provider && model ? `${provider}/${model}` : undefined;
}

export function internalExplicitWorkspaceDir(input: {
  readonly workspaceDir?: string;
  readonly runLocation?: SessionRecord['runLocation'];
}): string | undefined {
  if (input.workspaceDir !== undefined && !nonEmpty(input.workspaceDir)) {
    throw new SessionServiceError('workspace-required', 'Session workspace directory is required');
  }
  return nonEmpty(input.workspaceDir ?? input.runLocation?.resolvedDir);
}

export function internalDefaultWorkspaceIdentity(
  input: {
    readonly preserveDefaultWorkspaceIdentity?: boolean;
    readonly isDefaultWorkspace?: boolean;
    readonly runLocation?: SessionRecord['runLocation'];
  },
  implicitDefaultWorkspace: boolean,
): boolean {
  if (input.preserveDefaultWorkspaceIdentity && input.isDefaultWorkspace !== undefined) {
    return input.isDefaultWorkspace;
  }
  if (input.runLocation) return false;
  return input.isDefaultWorkspace ?? implicitDefaultWorkspace;
}

export function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

export function optionalModelVariant(value: string | undefined): string | undefined {
  return value === '' ? '' : nonEmpty(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function whenPresent<K extends PropertyKey, V>(
  key: K,
  value: V | null | undefined,
): { [P in K]?: V } {
  return value ? ({ [key]: value } as { [P in K]?: V }) : {};
}

export function whenDefined<K extends PropertyKey, V>(
  key: K,
  value: V | null | undefined,
): { [P in K]?: V } {
  return value !== undefined && value !== null ? ({ [key]: value } as { [P in K]?: V }) : {};
}

/** Minimal in-memory record used to capture before the durable row exists. */
export function sessionCaptureCandidate(input: {
  readonly sessionId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  readonly isDefaultWorkspace: boolean;
  readonly sessionType: 'root' | 'branch';
  readonly sessionKind: SessionKind;
  readonly parentSessionId: string | null;
  readonly visibility: NonNullable<SessionRecord['visibility']>;
  readonly appMode?: SessionRecord['appMode'];
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly effectiveModelThinking?: ConversationModelThinkingSelection | null;
  readonly effectiveModelContextWindow?: number | null;
  readonly effectiveModelMaxOutputTokens?: number | null;
}): SessionRecord {
  return {
    sessionId: input.sessionId,
    agentName: input.agentName,
    workspaceDir: input.workspaceDir,
    isDefaultWorkspace: input.isDefaultWorkspace,
    runtime: 'pi-agent',
    sessionType: input.sessionType,
    sessionKind: input.sessionKind,
    archived: false,
    parentSessionId: input.parentSessionId,
    visibility: input.visibility,
    status: 'idle',
    ...(input.appMode ? { appMode: input.appMode } : {}),
    ...(input.effectiveModel ? { effectiveModel: input.effectiveModel } : {}),
    ...(input.effectiveModelVariant === undefined || input.effectiveModelVariant === null
      ? {}
      : { effectiveModelVariant: input.effectiveModelVariant }),
    ...(input.effectiveModelThinking
      ? { effectiveModelThinking: input.effectiveModelThinking }
      : {}),
    ...(input.effectiveModelContextWindow === undefined ||
    input.effectiveModelContextWindow === null
      ? {}
      : { effectiveModelContextWindow: input.effectiveModelContextWindow }),
    ...(input.effectiveModelMaxOutputTokens === undefined ||
    input.effectiveModelMaxOutputTokens === null
      ? {}
      : { effectiveModelMaxOutputTokens: input.effectiveModelMaxOutputTokens }),
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}
