import type { ThreadGoalAttachment } from '../types.js';

/** Fixed, readonly transcript captured before verifier dispatch. */
export interface TranscriptWindow {
  readonly messages: readonly unknown[];
  readonly truncated: boolean;
  readonly truncationNote?: string;
}

export type VerificationEvidenceMode = 'brief' | 'transcript';

export interface VerificationEvidence {
  readonly mode: VerificationEvidenceMode;
  /** One compact serialization used for both measurement and prompt rendering. */
  readonly serializedBrief: string;
  readonly briefChars: number;
  /** Exact compact serialization of the no-tools evaluator tail. */
  readonly serializedEvaluatorTail: string;
  readonly evaluatorTailTruncated: boolean;
  /** Exact compact serialization retained only for the rollback mode. */
  readonly serializedTranscript: string;
  readonly transcriptTruncated: boolean;
}

export type VerificationBackend = 'evaluator' | 'subagent';

/** Host-owned facts that explain why verification is running and when settlement occurs. */
export interface VerificationHostContext {
  readonly completionProposal: {
    readonly observed: true;
    readonly status: 'complete';
    readonly turnId: string;
  };
  readonly settlement: {
    readonly phase: 'awaiting_verifier';
    /** A completion proposal does not mutate durable state before the verdict. */
    readonly durableStatusAtDispatch: 'active';
    readonly transitionOnMet: 'complete(verifier_met)';
  };
}

export interface VerificationAttempt {
  readonly goalId: string;
  /** Runtime routing identity omitted by the design sketch but required by the existing model owner. */
  readonly sessionId: string;
  readonly goalUpdatedAt: number;
  /** Trusted lifecycle facts assembled by the host, never derived from worker transcript prose. */
  readonly hostContext: VerificationHostContext;
  readonly objective: string;
  readonly objectiveResources?: readonly ThreadGoalAttachment[];
  /** Transient, bounded image evidence loaded from durable Goal resources. */
  readonly objectiveImages?: readonly { readonly data: string; readonly mimeType: string }[];
  readonly objectiveDigest: string;
  readonly turnId: string;
  readonly transcriptWindow: TranscriptWindow;
  readonly evidence: VerificationEvidence;
  readonly finalAssistantText?: string;
  readonly completionSummary?: string;
  readonly backend: VerificationBackend;
  /** Secret-free provider/model identity captured from the settled worker Turn. */
  readonly workerModelKey: string;
  /** Optional host-owned output cap. Absent means this verification is uncapped. */
  readonly maxTokens?: number;
}

export interface TranscriptWindowReader {
  capture(sessionId: string): Promise<TranscriptWindow>;
}

export type VerificationVerdict =
  | { readonly verdict: 'met'; readonly reason: string }
  | {
      readonly verdict: 'not_met';
      readonly reason: string;
      readonly missing: readonly string[];
    }
  | {
      readonly verdict: 'impossible';
      readonly reason: string;
      readonly blocker: string;
    }
  | {
      readonly verdict: 'inconclusive';
      readonly reason: string;
      readonly code: string;
    };

export interface VerificationUsage {
  /** Null means the provider omitted usage; callers must retain incomplete=true. */
  readonly tokens: number | null;
  readonly activeSeconds: number;
  readonly childTurns?: number;
  readonly incomplete: boolean;
}

/** Secret-free pointer to a verifier execution that has its own diagnostic trajectory. */
export interface VerificationTraceRef {
  readonly sessionId: string;
  readonly turnId?: string;
}

export interface VerificationResult {
  readonly backend: VerificationBackend;
  readonly verdict: VerificationVerdict;
  readonly usage: VerificationUsage;
  readonly traceRef?: VerificationTraceRef;
}

export type VerificationDispatchFailureCode =
  | 'route_unavailable'
  | 'timeout'
  | 'api_error'
  | 'schema_error'
  | 'input_too_large'
  | 'spawn_failed'
  | 'child_crash'
  | 'child_budget_exhausted'
  | 'capability_violation'
  | 'aborted';

/** Typed verifier failure that preserves every available physical-call usage sample. */
export class VerificationDispatchError extends Error {
  override readonly name = 'VerificationDispatchError';
  readonly traceRef?: VerificationTraceRef;

  constructor(
    readonly code: VerificationDispatchFailureCode,
    message: string,
    readonly usage: VerificationUsage,
    options?: ErrorOptions & { readonly traceRef?: VerificationTraceRef },
  ) {
    super(message, options);
    this.traceRef = options?.traceRef;
  }
}

/** The only replaceable Goal verification seam. Adapters receive no Goal write authority. */
export interface VerifierPort {
  dispatch(attempt: VerificationAttempt, signal: AbortSignal): Promise<VerificationResult>;
}
