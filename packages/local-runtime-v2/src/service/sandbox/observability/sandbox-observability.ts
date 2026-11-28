import { randomUUID } from 'node:crypto';
import type {
  SandboxFilesystemPolicy,
  SandboxLocalAccess,
  SandboxNetworkPolicy,
} from '@mavis/config';
import type { LocalSandboxInvocationIdentity } from '@mavis/agent-tools/desktop';

import type { SandboxApplyResult } from '../config-commit.js';
import type {
  SandboxBackendHooks,
  SandboxBackendId,
  SandboxBackendViolation,
} from '../backend/types.js';
import type { SandboxErrorCode } from '../sandbox-errors.js';
import { SandboxInvocationTrace } from './invocation-trace.js';
import type {
  SanitizedSandboxViolation,
  SandboxViolationOperation,
  SandboxViolationSource,
  SandboxViolationTarget,
  SandboxEventSink,
  SandboxObservation,
  SandboxRuntimeEvent,
  SandboxInvocationOutcome,
} from './contracts.js';

export interface LocalSandboxStatus {
  readonly surface: 'bash-only';
  readonly state: 'disabled' | 'initializing' | 'ready' | 'failed' | 'closing' | 'closed';
  readonly desiredBackend?: SandboxBackendId;
  readonly effectiveBackend?: SandboxBackendId;
  readonly backendVersion?: string;
  readonly upstreamVersion?: string;
  readonly effectiveGeneration: number;
  readonly activation?: SandboxApplyResult['activation'];
  readonly activeInvocations: number;
  readonly retiringInvocations: number;
  readonly filesystemMode?: SandboxFilesystemPolicy['mode'];
  readonly networkMode?: SandboxNetworkPolicy['mode'];
  readonly localAccess?: SandboxLocalAccess;
  readonly deniedDomainRuleCount?: number;
  readonly denyReadRuleCount?: number;
  readonly lastErrorCode?: string;
}

export type { SanitizedSandboxViolation } from './contracts.js';

export interface SandboxMetricsClient {
  counter(name: string, delta?: number, labels?: Readonly<Record<string, string>>): void;
  histogram(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
}

export interface SandboxObservabilityOptions {
  readonly metrics?: SandboxMetricsClient;
  readonly violationLimit?: number;
  readonly violationSink?: (violation: SanitizedSandboxViolation) => void;
  readonly eventSink?: SandboxEventSink;
  readonly log?: (event: SandboxRuntimeEvent) => void;
  readonly nowMs?: () => number;
  readonly monotonicNow?: () => number;
  readonly resolveViolationAttribution?: (commandId: string) =>
    | {
        readonly identity: LocalSandboxInvocationIdentity;
        readonly effectiveGeneration: number;
      }
    | undefined;
}

export type SandboxConfigRejectionStage =
  | 'product-parser'
  | 'policy-compile'
  | 'backend-select'
  | 'backend-schema'
  | 'capability';

export class SandboxObservability {
  readonly #metrics?: SandboxMetricsClient;
  readonly #violationLimit: number;
  readonly #violationSink?: (violation: SanitizedSandboxViolation) => void;
  readonly #resolveViolationAttribution?: SandboxObservabilityOptions['resolveViolationAttribution'];
  readonly #violations: SanitizedSandboxViolation[] = [];
  #nextSequence = 1;
  readonly #runtimeId = randomUUID();
  readonly #options: SandboxObservabilityOptions;
  readonly #attribution = new Map<
    string,
    {
      trace: SandboxInvocationTrace;
      generation: number;
      retiredAt?: number;
    }
  >();
  #urgentWindow = 0;
  #urgentCount = 0;

  constructor(options: SandboxObservabilityOptions = {}) {
    this.#options = options;
    this.#metrics = options.metrics;
    this.#violationLimit = Math.max(1, options.violationLimit ?? 100);
    this.#violationSink = options.violationSink;
    this.#resolveViolationAttribution = options.resolveViolationAttribution;
  }

  event(
    type: string,
    payload: SandboxObservation,
    options: {
      identity?: Partial<LocalSandboxInvocationIdentity>;
      urgent?: boolean;
      localOnly?: boolean;
    } = {},
  ): void {
    const now = this.now();
    const sequence = this.#nextSequence++;
    const event: SandboxRuntimeEvent = {
      schema: 'mavis.sandbox_runtime_event.v1',
      runtime_instance_id: this.#runtimeId,
      event_id: `${this.#runtimeId}:${sequence}`,
      sequence,
      event_type: type,
      event_at_ms: now,
      ...eventIdentity(options.identity),
      payload,
    };
    const result = this.deliver(event, options);
    try {
      this.#options.log?.({ ...event, payload: { ...payload, delivery_status: result } });
    } catch {
      /* best effort */
    }
    if (!options.localOnly && event.session_id)
      this.safeMetric(() =>
        this.#metrics?.counter('local_sandbox_observation_delivery_total', 1, { result }),
      );
  }

  private deliver(
    event: SandboxRuntimeEvent,
    options: { urgent?: boolean; localOnly?: boolean },
  ): string {
    if (options.localOnly || !event.session_id) return 'local_only';
    if (!this.#options.eventSink) return 'unavailable';
    if (event.event_at_ms - this.#urgentWindow >= 60_000) {
      this.#urgentWindow = event.event_at_ms;
      this.#urgentCount = 0;
    }
    const delivery = options.urgent && this.#urgentCount++ < 32 ? 'immediate' : 'batched';
    try {
      return this.#options.eventSink(event, delivery) ?? 'queued';
    } catch {
      return 'failure';
    }
  }

  startInvocation(
    identity: LocalSandboxInvocationIdentity,
    snapshot: SandboxObservation,
  ): SandboxInvocationTrace {
    this.pruneAttribution();
    const attemptId = randomUUID();
    const frozenIdentity = Object.freeze({ ...identity });
    const trace = new SandboxInvocationTrace(
      frozenIdentity,
      this.#options.monotonicNow ?? (() => performance.now()),
      {
        emit: (type, payload, urgent, localOnly) =>
          this.event(
            type,
            { attempt_id: attemptId, ...payload },
            { identity: frozenIdentity, urgent, localOnly },
          ),
        completed: (outcome, duration) => {
          this.invocation(
            identity.operationClass,
            invocationMetricResult(outcome),
            duration,
            outcome.errorCode,
          );
          for (const entry of this.#attribution.values())
            if (entry.trace === trace) entry.retiredAt = this.now();
          this.pruneAttribution();
        },
      },
    );
    this.event(
      'sandbox.invocation.started',
      { attempt_id: attemptId, ...snapshot },
      { identity: frozenIdentity },
    );
    return trace;
  }

  bindInvocation(commandId: string, generation: number, trace: SandboxInvocationTrace): void {
    this.#attribution.set(commandId, { trace, generation });
  }

  runtimeChange(type: string, payload: SandboxObservation, urgent = false): void {
    this.event(type, payload, { urgent });
    const sessions = new Set<string>();
    for (const entry of this.#attribution.values()) {
      const identity = entry.trace.identity;
      if (entry.retiredAt !== undefined || sessions.has(identity.sessionId)) continue;
      sessions.add(identity.sessionId);
      this.event(type, payload, { identity: { sessionId: identity.sessionId }, urgent });
    }
  }

  close(): void {
    for (const entry of this.#attribution.values()) entry.trace.flushLate();
    this.#attribution.clear();
  }

  private now(): number {
    return this.#options.nowMs?.() ?? Date.now();
  }
  private pruneAttribution(): void {
    const retired = [...this.#attribution.entries()].filter(
      ([, entry]) => entry.retiredAt !== undefined,
    );
    let retained = retired.length;
    for (const [key, entry] of retired) {
      if (this.now() - entry.retiredAt! < 120_000 && retained <= 256) continue;
      entry.trace.flushLate();
      this.#attribution.delete(key);
      retained -= 1;
    }
  }
  private safeMetric(write: () => void): void {
    try {
      write();
    } catch {
      /* diagnostics cannot affect execution */
    }
  }

  backendHooks(): SandboxBackendHooks {
    return Object.freeze({
      reportViolation: (violation: SandboxBackendViolation) => this.#recordViolation(violation),
    });
  }

  listViolations(): readonly SanitizedSandboxViolation[] {
    return this.#violations.map((violation) => Object.freeze({ ...violation }));
  }

  initialization(result: 'success' | 'failure', errorCode?: SandboxErrorCode): void {
    this.safeMetric(() =>
      this.#metrics?.counter('local_sandbox_init_total', 1, {
        result,
        error_code: errorCode ?? 'none',
      }),
    );
  }

  reconfigure(
    activation: SandboxApplyResult['activation'] | 'unknown',
    result: 'success' | 'failure',
  ): void {
    this.safeMetric(() =>
      this.#metrics?.counter('local_sandbox_reconfigure_total', 1, { activation, result }),
    );
  }

  configRejected(stage: SandboxConfigRejectionStage): void {
    this.safeMetric(() =>
      this.#metrics?.counter('local_sandbox_config_rejected_total', 1, { stage }),
    );
  }

  invocation(
    kind: 'direct_foreground' | 'managed_foreground' | 'explicit_background',
    result: 'success' | 'failure' | 'aborted',
    durationMs: number,
    errorCode?: SandboxErrorCode,
  ): void {
    this.safeMetric(() =>
      this.#metrics?.counter('local_sandbox_invocation_total', 1, {
        kind,
        result,
        error_code: errorCode ?? 'none',
      }),
    );
    this.safeMetric(() =>
      this.#metrics?.histogram('local_sandbox_operation_duration_ms', durationMs, { kind }),
    );
  }

  #recordViolation(raw: SandboxBackendViolation): void {
    this.pruneAttribution();
    const entry = raw.commandId ? this.#attribution.get(raw.commandId) : undefined;
    let attribution = raw.commandId
      ? this.#resolveViolationAttribution?.(raw.commandId)
      : undefined;
    if (entry)
      attribution = { identity: entry.trace.identity, effectiveGeneration: entry.generation };
    const violation = Object.freeze({
      sequence: this.#nextSequence++,
      timestampMs: Number.isFinite(raw.timestampMs) ? raw.timestampMs : Date.now(),
      ...(attribution
        ? {
            invocationId: attribution.identity.invocationId,
            sessionId: attribution.identity.sessionId,
            turnId: attribution.identity.turnId,
            ...(attribution.identity.toolCallId
              ? { toolCallId: attribution.identity.toolCallId }
              : {}),
            ...(attribution.identity.taskId ? { taskId: attribution.identity.taskId } : {}),
            effectiveGeneration: attribution.effectiveGeneration,
          }
        : {}),
      operation: normalizeOperation(raw),
      source: normalizeSource(raw.category),
      target: normalizeTarget(raw.category),
    });
    this.#violations.push(violation);
    if (this.#violations.length > this.#violationLimit) this.#violations.shift();
    this.safeMetric(() =>
      this.#metrics?.counter('local_sandbox_violation_total', 1, {
        operation: violation.operation,
        source: violation.source,
      }),
    );
    entry?.trace.violation(violation);
    try {
      this.#violationSink?.(violation);
    } catch {
      /* best effort */
    }
  }
}

function normalizeOperation(raw: SandboxBackendViolation): SandboxViolationOperation {
  const value = `${raw.category} ${raw.operation ?? ''}`.toLowerCase();
  if (/unlink|delete|rename|remove/.test(value)) return 'delete_denied';
  if (/write|create|truncate/.test(value)) return 'write_denied';
  if (/read/.test(value)) return 'read_denied';
  if (/network|connect|domain|proxy/.test(value)) return 'network_denied';
  if (/local|socket|mach|bind|security/.test(value)) return 'local_access_denied';
  return 'unknown';
}

function normalizeSource(category: string): SandboxViolationSource {
  const value = category.toLowerCase();
  if (/profile|seatbelt|sbpl/.test(value)) return 'profile';
  if (/proxy|network/.test(value)) return 'proxy';
  if (/runtime|service/.test(value)) return 'runtime';
  return 'backend';
}

function normalizeTarget(category: string): SandboxViolationTarget {
  const value = category.toLowerCase();
  if (/workspace/.test(value)) return 'workspace';
  if (/git/.test(value)) return 'git';
  if (/runtime.?data|data.?dir/.test(value)) return 'runtime-data';
  if (/session.?temp|temp/.test(value)) return 'session-temp';
  if (/network|connect|domain|proxy/.test(value)) return 'network';
  if (/local|socket|mach|bind|security/.test(value)) return 'local-service';
  if (/file|read|write|unlink|delete|rename|profile|seatbelt|sbpl/.test(value)) {
    return 'filesystem-other';
  }
  return 'unknown';
}

function eventIdentity(
  identity?: Partial<LocalSandboxInvocationIdentity>,
): Partial<SandboxRuntimeEvent> {
  return {
    session_id: identity?.sessionId,
    turn_id: identity?.turnId,
    tool_call_id: identity?.toolCallId,
    invocation_id: identity?.invocationId,
    operation_class: identity?.operationClass,
    task_id: identity?.taskId,
  };
}

function invocationMetricResult(
  outcome: SandboxInvocationOutcome,
): 'success' | 'failure' | 'aborted' {
  if (outcome.termination === 'aborted') return 'aborted';
  if (outcome.termination === 'exited_zero' && outcome.cleanup !== 'failure') return 'success';
  return 'failure';
}
