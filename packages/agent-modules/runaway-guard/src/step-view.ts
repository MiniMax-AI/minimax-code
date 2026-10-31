import type { PiStepEndHookInput } from '@mavis/agent-core/pi-turn-runner';
import type {
  RunawayGuardChildStep,
  RunawayGuardProgressProjection,
  RunawayGuardToolPolicy,
  RunawayGuardToolPolicyKind,
  RunawayGuardToolStep,
  RunawayGuardTrustedToolProvenance,
  RunawayGuardVerifiedToolProgress,
} from './contracts.js';
import type { ShadowState } from './state.js';
import { fingerprint, fingerprintWithinBudget, isRecord } from './fingerprint.js';

export interface StepView {
  readonly detectActionKeys: readonly string[];
  readonly pollingActionKeys: readonly string[];
  readonly detectResultKeys: readonly string[];
  readonly errorFamilyKeys: readonly string[];
  readonly remindableErrorFamilyKeys: ReadonlySet<string>;
  readonly progress: readonly ProgressView[];
  readonly detectActionBatchKey?: string;
}

export type ProgressView = ProgressObservationView | ProgressResetView | ProgressInterruptView;

interface ProgressObservationView {
  readonly type: 'observation';
  readonly kind: Exclude<RunawayGuardToolPolicyKind, 'exempt'>;
  readonly loopKey: string;
  readonly progressKey: string;
  readonly verifiedProgress: boolean;
  readonly continuousPolling: boolean;
  readonly reminderEligible: boolean;
}

interface ProgressResetView {
  readonly type: 'reset';
  readonly loopKey: string;
}

interface ProgressInterruptView {
  readonly type: 'interrupt';
}

interface ToolResultProjection {
  readonly toolName: string;
  readonly content: unknown;
  readonly details?: unknown;
  readonly isError: boolean;
}

export function projectStep(
  message: PiStepEndHookInput['message'],
  toolResults: PiStepEndHookInput['toolResults'],
  state: ShadowState,
  policies: ReadonlyMap<string, RunawayGuardToolPolicy>,
  maxBytes: number,
  verifiedProgressByCallId: ReadonlyMap<string, RunawayGuardVerifiedToolProgress>,
  trustedToolProvenanceByCallId: ReadonlyMap<string, RunawayGuardTrustedToolProvenance>,
  blockedToolCalls: PiStepEndHookInput['blockedToolCalls'] = [],
): StepView {
  const excludedCallIds = new Set(
    blockedToolCalls
      .filter((call) => call.blockedBy === 'permission')
      .map((call) => call.toolCallId),
  );
  const detectActionKeys: string[] = [];
  const pollingActionKeys: string[] = [];
  const detectResultKeys: string[] = [];
  const errorFamilyKeys: string[] = [];
  const remindableErrorFamilyKeys = new Set<string>();
  const progress: ProgressView[] = [];
  const resultsByCallId = new Map(toolResults.map((result) => [result.toolCallId, result]));
  const actionKeysByCallId = new Map<string, string>();
  const expectedResultCallIds = new Set<string>();

  if (message.role === 'assistant') {
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue;
      const excluded = excludedCallIds.has(block.id);
      const configuredPolicy = policies.get(block.name);
      const policy = configuredPolicy?.kind ?? 'detect';
      const result = resultsByCallId.get(block.id);
      const projectedResult = excluded ? undefined : result;
      const verifiedProgress = excluded ? undefined : verifiedProgressByCallId.get(block.id);
      const trustedToolProvenance = trustedToolProvenanceByCallId.get(block.id);
      const toolStep: RunawayGuardToolStep = {
        toolCallId: block.id,
        toolName: block.name,
        arguments: block.arguments,
        ...(projectedResult
          ? {
              result: {
                toolName: projectedResult.toolName,
                content: projectedResult.content,
                ...(projectedResult.details === undefined
                  ? {}
                  : { details: projectedResult.details }),
                isError: projectedResult.isError,
              },
            }
          : {}),
        ...(verifiedProgress ? { verifiedProgress } : {}),
        ...(trustedToolProvenance ? { trustedToolProvenance } : {}),
      };
      const progressProjection = projectProgressBestEffort(configuredPolicy, toolStep);
      if (toolStep.result) {
        projectChildSteps(configuredPolicy, toolStep, policies, state, maxBytes, {
          detectActionKeys,
          pollingActionKeys,
          detectResultKeys,
          errorFamilyKeys,
          remindableErrorFamilyKeys,
        });
      }
      const pollingControl = policy === 'polling' ? progressProjection?.polling : undefined;
      appendPollingControl(
        progress,
        pollingControl,
        progressProjection,
        block.name,
        state,
        maxBytes,
      );
      if (!pollingControl) progress.push({ type: 'interrupt' });
      // Permission rejection stays excluded from the old detectors, but its
      // trusted task identity must still reset the new polling continuity.
      if (excluded || policy === 'exempt') continue;
      if (result?.isError && isExpectedResultBestEffort(configuredPolicy, toolStep)) {
        expectedResultCallIds.add(block.id);
      }
      let observedChange = false;
      if (progressProjection && pollingControl?.mode !== 'reset') {
        const loopKey = fingerprintWithinBudget(
          state.secret,
          { toolName: block.name, loopKey: progressProjection.loopKey },
          maxBytes,
        );
        const progressKey = fingerprintWithinBudget(
          state.secret,
          { toolName: block.name, progressKey: progressProjection.progressKey },
          maxBytes,
        );
        if (loopKey && progressKey) {
          observedChange =
            hasPositiveProgress(progressProjection) ||
            (pollingControl?.mode === 'continuous' && hasPositiveProgress(verifiedProgress));
          progress.push({
            type: 'observation',
            kind: policy,
            loopKey,
            progressKey,
            verifiedProgress: observedChange,
            continuousPolling: pollingControl?.mode === 'continuous',
            reminderEligible:
              pollingControl?.mode === 'continuous' && pollingControl.reminderEligible === true,
          });
        } else {
          state.fingerprintSkippedCount += Number(!loopKey) + Number(!progressKey);
          if (pollingControl?.mode === 'continuous') progress.push({ type: 'interrupt' });
        }
      }
      const actionValue = projectActionKeyBestEffort(configuredPolicy, block.arguments);
      const actionKey = fingerprintWithinBudget(
        state.secret,
        { toolName: block.name, actionKey: actionValue },
        maxBytes,
      );
      if (!actionKey) {
        state.fingerprintSkippedCount += 1;
        continue;
      }
      actionKeysByCallId.set(block.id, actionKey);
      if (observedChange) {
        // A real change invalidates a mechanical no-change hypothesis for this call only.
        expectedResultCallIds.add(block.id);
      } else if (policy === 'polling') {
        if (!progressProjection) pollingActionKeys.push(actionKey);
      } else {
        detectActionKeys.push(actionKey);
      }
    }
  }

  for (const result of toolResults) {
    if (excludedCallIds.has(result.toolCallId)) continue;
    const policy = policies.get(result.toolName)?.kind ?? 'detect';
    const projected: ToolResultProjection = {
      toolName: result.toolName,
      content: result.content,
      isError: result.isError,
      ...(result.details === undefined ? {} : { details: result.details }),
    };
    if (policy === 'detect') {
      const resultKey = fingerprintWithinBudget(state.secret, projected, maxBytes);
      if (resultKey) detectResultKeys.push(resultKey);
      else state.fingerprintSkippedCount += 1;
    }
    if (result.isError && policy !== 'exempt' && !expectedResultCallIds.has(result.toolCallId)) {
      const family = errorFamily(result.toolName, result.details, result.content);
      if (family) {
        const actionKey = actionKeysByCallId.get(result.toolCallId);
        const key = fingerprintWithinBudget(
          state.secret,
          { family, actionKey: actionKey ?? null },
          maxBytes,
        );
        if (!key) {
          state.fingerprintSkippedCount += 1;
          continue;
        }
        errorFamilyKeys.push(key);
        if (policy === 'detect' && actionKey) {
          remindableErrorFamilyKeys.add(key);
        }
      }
    }
  }

  detectActionKeys.sort();
  pollingActionKeys.sort();
  detectResultKeys.sort();
  errorFamilyKeys.sort();
  return {
    detectActionKeys,
    pollingActionKeys,
    detectResultKeys,
    errorFamilyKeys,
    remindableErrorFamilyKeys,
    progress,
    detectActionBatchKey:
      detectActionKeys.length > 0
        ? fingerprint(state.secret, `action-batch\u0000${detectActionKeys.join('\u0000')}`)
        : undefined,
  };
}

interface StepKeySinks {
  readonly detectActionKeys: string[];
  readonly pollingActionKeys: string[];
  readonly detectResultKeys: string[];
  readonly errorFamilyKeys: string[];
  readonly remindableErrorFamilyKeys: Set<string>;
}

/**
 * A program's child calls are invisible as top-level calls, and a failed child
 * does not fail run_code, so they are projected as calls of the same step
 * under their own policies. Identical keys from one program count once: an
 * ordinary loop inside a program (one read per file, waiting on a task) is not
 * a repeat, while the same call in consecutive programs accumulates exactly
 * like consecutive steps.
 */
function projectChildSteps(
  policy: RunawayGuardToolPolicy | undefined,
  step: RunawayGuardToolStep,
  policies: ReadonlyMap<string, RunawayGuardToolPolicy>,
  state: ShadowState,
  maxBytes: number,
  sinks: StepKeySinks,
): void {
  const children = childStepsBestEffort(policy, step);
  state.childStepsProjected += children.length;
  const detectActions = new Set<string>();
  const pollingActions = new Set<string>();
  const detectResults = new Set<string>();
  const errorFamilies = new Set<string>();
  for (const child of children) {
    const childPolicy = policies.get(child.toolName);
    const kind = childPolicy?.kind ?? 'detect';
    if (kind === 'exempt') continue;
    const keys = childActionKeys(child, childPolicy, kind, state, maxBytes);
    if (keys) {
      (kind === 'polling' ? pollingActions : detectActions).add(keys.actionKey);
      if (keys.resultKey) detectResults.add(keys.resultKey);
    }
    const familyKey = childErrorFamilyKey(child, childPolicy, keys?.actionKey, state, maxBytes);
    if (!familyKey) continue;
    errorFamilies.add(familyKey);
    if (kind === 'detect') sinks.remindableErrorFamilyKeys.add(familyKey);
  }
  sinks.detectActionKeys.push(...detectActions);
  sinks.pollingActionKeys.push(...pollingActions);
  sinks.detectResultKeys.push(...detectResults);
  sinks.errorFamilyKeys.push(...errorFamilies);
}

/**
 * The parent keeps arguments for only a few tools; a child without them is
 * indistinguishable from any other call of the same tool, so it gets no action
 * or result identity rather than a false "same arguments" repeat.
 */
function childActionKeys(
  child: RunawayGuardChildStep,
  policy: RunawayGuardToolPolicy | undefined,
  kind: Exclude<RunawayGuardToolPolicyKind, 'exempt'>,
  state: ShadowState,
  maxBytes: number,
): { readonly actionKey: string; readonly resultKey?: string } | undefined {
  if (child.arguments === undefined) return undefined;
  const actionValue = projectActionKeyBestEffort(policy, child.arguments);
  const actionKey = fingerprintWithinBudget(
    state.secret,
    { toolName: child.toolName, actionKey: actionValue },
    maxBytes,
  );
  if (!actionKey) {
    state.fingerprintSkippedCount += 1;
    return undefined;
  }
  if (kind !== 'detect') return { actionKey };
  // A child record has no result content, so the result identity is the
  // action plus its outcome; otherwise every successful child would match.
  const resultKey = fingerprintWithinBudget(
    state.secret,
    {
      toolName: child.toolName,
      childResult: {
        actionKey: actionValue,
        isError: child.isError,
        errorCode: child.toolErrorCode ?? child.errorCode ?? null,
      },
    },
    maxBytes,
  );
  if (!resultKey) state.fingerprintSkippedCount += 1;
  return resultKey ? { actionKey, resultKey } : { actionKey };
}

/**
 * A child with kept arguments uses the native key (tool, code, action), so a
 * model probing different paths one by one is not flagged while the same
 * failing call still is. Without arguments only a code the tool itself
 * reported can tell "different tools hitting the same error" (several
 * computer_* tools stopped the same way), so it groups failures across tools;
 * the parent's generic code only groups failures of one tool. A tool with an
 * expected-failure rule (search no-match) never starts an error streak from a
 * child: that rule needs the result text, which a child record lacks.
 */
function childErrorFamilyKey(
  child: RunawayGuardChildStep,
  policy: RunawayGuardToolPolicy | undefined,
  actionKey: string | undefined,
  state: ShadowState,
  maxBytes: number,
): string | undefined {
  if (!child.isError || policy?.isExpectedResult) return undefined;
  const toolErrorCode = boundedErrorCode(child.toolErrorCode);
  const errorCode = boundedErrorCode(child.errorCode);
  let family: Readonly<Record<string, string>> | undefined;
  if (child.arguments !== undefined) {
    const code = toolErrorCode ?? errorCode;
    // An unfingerprintable action was already counted as skipped.
    if (!code || !actionKey) return undefined;
    family = { family: `${child.toolName}\u0000code:${code}`, actionKey };
  } else if (toolErrorCode) family = { childToolErrorCode: toolErrorCode };
  else if (errorCode) family = { childToolName: child.toolName, childErrorCode: errorCode };
  if (!family) return undefined;
  const key = fingerprintWithinBudget(state.secret, family, maxBytes);
  if (!key) state.fingerprintSkippedCount += 1;
  return key;
}

function boundedErrorCode(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 && value.length <= 128 ? value : undefined;
}

function childStepsBestEffort(
  policy: RunawayGuardToolPolicy | undefined,
  step: RunawayGuardToolStep,
): readonly RunawayGuardChildStep[] {
  if (!policy?.projectChildSteps) return [];
  try {
    const children = policy.projectChildSteps(step);
    return Array.isArray(children) ? children.filter(validChildStep) : [];
  } catch {
    return [];
  }
}

function validChildStep(value: unknown): value is RunawayGuardChildStep {
  return (
    isRecord(value) &&
    typeof value.toolName === 'string' &&
    value.toolName.length > 0 &&
    typeof value.isError === 'boolean' &&
    (value.errorCode === undefined || typeof value.errorCode === 'string') &&
    (value.toolErrorCode === undefined || typeof value.toolErrorCode === 'string')
  );
}

function appendPollingControl(
  progress: ProgressView[],
  control: RunawayGuardProgressProjection['polling'] | undefined,
  projection: RunawayGuardProgressProjection | undefined,
  toolName: string,
  state: ShadowState,
  maxBytes: number,
): void {
  if (control?.mode !== 'reset' || !projection) return;
  const loopKey = fingerprintWithinBudget(
    state.secret,
    { toolName, loopKey: projection.loopKey },
    maxBytes,
  );
  if (!loopKey) {
    state.fingerprintSkippedCount += 1;
    progress.push({ type: 'interrupt' });
    return;
  }
  progress.push({ type: 'reset', loopKey });
}

function hasPositiveProgress(projection: RunawayGuardProgressProjection | undefined): boolean {
  return (
    projection?.stateChanged === true ||
    projection?.artifactChanged === true ||
    (projection?.newFacts ?? 0) > 0
  );
}

function projectActionKeyBestEffort(
  policy: RunawayGuardToolPolicy | undefined,
  argumentsValue: unknown,
): unknown {
  if (!policy?.projectActionKey) return argumentsValue;
  try {
    return policy.projectActionKey(argumentsValue) ?? argumentsValue;
  } catch {
    return argumentsValue;
  }
}

function projectProgressBestEffort(
  policy: RunawayGuardToolPolicy | undefined,
  step: RunawayGuardToolStep,
): RunawayGuardProgressProjection | undefined {
  if (policy?.projectProgress) {
    try {
      const projection = policy.projectProgress(step);
      if (projection && validProgressProjection(projection)) return projection;
    } catch {
      // Fall through to independently verified host progress.
    }
  }
  if (!step.verifiedProgress || !validProgressProjection(step.verifiedProgress)) return undefined;
  // Host facts may veto a trusted polling observation, but cannot independently
  // create one: only the configured tool policy may opt into polling continuity.
  const { loopKey, progressKey, newFacts, stateChanged, artifactChanged } = step.verifiedProgress;
  return {
    loopKey,
    progressKey,
    ...(newFacts === undefined ? {} : { newFacts }),
    ...(stateChanged === undefined ? {} : { stateChanged }),
    ...(artifactChanged === undefined ? {} : { artifactChanged }),
  };
}

function isExpectedResultBestEffort(
  policy: RunawayGuardToolPolicy | undefined,
  step: RunawayGuardToolStep,
): boolean {
  if (!policy?.isExpectedResult) return false;
  try {
    return policy.isExpectedResult(step) === true;
  } catch {
    return false;
  }
}

export function toolCallIdsFromMessage(message: PiStepEndHookInput['message']): readonly string[] {
  if (message.role !== 'assistant') return [];
  return message.content.flatMap((block) => (block.type === 'toolCall' ? [block.id] : []));
}

export function verifiedProgressMap(
  values: readonly RunawayGuardVerifiedToolProgress[],
  expected: ReadonlySet<string>,
): ReadonlyMap<string, RunawayGuardVerifiedToolProgress> {
  const valid = values.filter(
    (value) =>
      isRecord(value) &&
      expected.has(value.toolCallId) &&
      typeof value.toolCallId === 'string' &&
      validProgressProjection(value),
  );
  return new Map(valid.map((value) => [value.toolCallId, value]));
}

export function verifiedProgressMapBestEffort(
  values: readonly RunawayGuardVerifiedToolProgress[],
  expected: ReadonlySet<string>,
): ReadonlyMap<string, RunawayGuardVerifiedToolProgress> {
  try {
    return verifiedProgressMap(values, expected);
  } catch {
    return new Map();
  }
}

export function trustedToolProvenanceMap(
  values: readonly RunawayGuardTrustedToolProvenance[],
  expected: ReadonlySet<string>,
): ReadonlyMap<string, RunawayGuardTrustedToolProvenance> {
  const valid = values.filter(
    (value) =>
      isRecord(value) &&
      expected.has(value.toolCallId) &&
      typeof value.toolCallId === 'string' &&
      typeof value.toolName === 'string' &&
      value.toolName.length > 0 &&
      (value.source === 'builtin' || value.source === 'captured-compatibility'),
  );
  return new Map(valid.map((value) => [value.toolCallId, value]));
}

export function trustedToolProvenanceMapBestEffort(
  values: readonly RunawayGuardTrustedToolProvenance[],
  expected: ReadonlySet<string>,
): ReadonlyMap<string, RunawayGuardTrustedToolProvenance> {
  try {
    return trustedToolProvenanceMap(values, expected);
  } catch {
    return new Map();
  }
}

function validProgressProjection(projection: RunawayGuardProgressProjection): boolean {
  return (
    isRecord(projection) &&
    projection.loopKey !== undefined &&
    projection.loopKey !== null &&
    projection.progressKey !== undefined &&
    projection.progressKey !== null &&
    (projection.newFacts === undefined ||
      (Number.isSafeInteger(projection.newFacts) && projection.newFacts >= 0)) &&
    (projection.stateChanged === undefined || typeof projection.stateChanged === 'boolean') &&
    (projection.artifactChanged === undefined || typeof projection.artifactChanged === 'boolean') &&
    validPollingControl(projection.polling)
  );
}

function validPollingControl(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      (value.mode === 'continuous' || value.mode === 'reset') &&
      (value.reminderEligible === undefined || typeof value.reminderEligible === 'boolean'))
  );
}

function errorFamily(toolName: string, details: unknown, content: unknown): string | undefined {
  const structured = structuredErrorCode(details);
  if (structured) return `${toolName}\u0000code:${structured}`;
  const text = firstText(content);
  if (!text) return undefined;
  const normalized = text.toLowerCase();
  const category = ERROR_CATEGORIES.find(({ pattern }) => pattern.test(normalized))?.name;
  if (category) return `${toolName}\u0000category:${category}`;
  const bounded = normalized.replace(/\s+/g, ' ').trim().slice(0, 1_024);
  return bounded ? `${toolName}\u0000text:${bounded}` : undefined;
}

const ERROR_CATEGORIES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'timeout', pattern: /timeout|timed out|deadline exceeded/ },
  { name: 'rate_limit', pattern: /rate.?limit|too many requests|\b429\b/ },
  { name: 'network', pattern: /network|econn|socket|dns|connection reset/ },
  { name: 'auth', pattern: /unauth|invalid api key|\b401\b/ },
  { name: 'permission', pattern: /permission|forbidden|access denied|\b403\b/ },
  { name: 'not_found', pattern: /not found|enoent|\b404\b/ },
  { name: 'invalid_argument', pattern: /invalid argument|validation failed|bad request|\b400\b/ },
  { name: 'process_exit', pattern: /exit code|non-zero|process failed/ },
];

function structuredErrorCode(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  for (const key of ['error_code', 'errorCode', 'code', 'status']) {
    const value = details[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 128) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'text') continue;
    const text = block['text'];
    if (typeof text === 'string' && text.length > 0 && text.length <= 4_096) return text;
  }
  return undefined;
}
