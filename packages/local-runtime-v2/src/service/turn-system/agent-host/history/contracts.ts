import type { PiAgentMessage, PiHistoryChangedHookInput } from '@mavis/agent-core/pi-turn-runner';
import type { TurnAssemblyCtx } from '@mavis/agent-runtime';

interface MinimalNativeCompactionSummary extends Readonly<Record<string, unknown>> {
  readonly role: 'compactionSummary';
  readonly summary: string;
  readonly timestamp?: never;
  readonly tokensBefore?: never;
}

export type CanonicalHistoryMessage = PiAgentMessage | MinimalNativeCompactionSummary;
export type CanonicalHistoryMessages = readonly CanonicalHistoryMessage[];

export type EnvelopeReplacementEntry =
  | {
      readonly message: CanonicalHistoryMessage;
      readonly identity: { readonly kind: 'preserve'; readonly messageId: string };
    }
  | {
      readonly message: CanonicalHistoryMessage;
      readonly identity: {
        readonly kind: 'external-user';
        readonly messageId: `msg-user-v1-${string}`;
      };
    }
  | {
      readonly message: CanonicalHistoryMessage;
      readonly identity: { readonly kind: 'new'; readonly seed: string };
    };

/** Canonical envelope message_id values in the same order as the history messages. */
export type HistoryIdentityVector = readonly string[];

export interface CanonicalMessageIdentityHint {
  readonly index: number;
  readonly messageId: string;
  readonly source: 'display-user' | 'preserved' | 'internal-new';
}

/**
 * Optional canonical-history reconcile intent produced by the runtime port.
 *
 * It never changes the terminal `status`; the terminal three-way match keeps
 * using `status` alone. AgentHost maps the intent to a Session-owned semantic
 * history operation after the Turn settles.
 */
export type HistoryReconcileIntent =
  | {
      readonly kind: 'output-recall';
      readonly source?: 'input-review' | 'output-review';
      readonly variant: 'content' | 'network' | 'auth';
      readonly slowNetworkRead?: true;
    }
  | {
      readonly kind: 'network-reconcile';
      readonly approvedContent: string;
      readonly slowNetworkRead?: true;
    }
  | { readonly kind: 'safety-reconcile'; readonly approvedContent: string }
  | { readonly kind: 'abort-reconcile'; readonly approvedContent: string };

export type HistoryCommitOperationKind =
  | 'append'
  | 'replace'
  | 'compaction'
  | 'output-recall'
  | 'turn-retraction'
  | 'network-reconcile'
  | 'safety-reconcile'
  | 'abort-reconcile';

export interface HistoryCommitOperation {
  /**
   * Non-empty idempotency identity. Reuse is valid only for a semantically
   * identical callback-entry snapshot; an id collision fails closed.
   */
  readonly id: string;
  readonly kind: HistoryCommitOperationKind;
  readonly variant?: 'content' | 'network' | 'auth';
}

export type CanonicalHistoryChange = Omit<
  PiHistoryChangedHookInput,
  'messages' | 'previousMessages'
> & {
  readonly messages: CanonicalHistoryMessages;
  readonly previousMessages?: CanonicalHistoryMessages;
  readonly operation?: HistoryCommitOperation;
  readonly identityHints?: readonly CanonicalMessageIdentityHint[];
  readonly replacementEntries?: readonly EnvelopeReplacementEntry[];
};

export type CommittedHistoryChange = CanonicalHistoryChange & {
  readonly operation: HistoryCommitOperation;
  readonly committedRevision: string;
  readonly committedMessages: CanonicalHistoryMessages;
  readonly committedIdentityVector?: HistoryIdentityVector;
};

export interface CanonicalHistorySnapshot {
  readonly revision: string;
  readonly messages: CanonicalHistoryMessages;
  readonly identityVector?: HistoryIdentityVector;
}

export interface CanonicalHistoryCommit {
  readonly revision: string;
  readonly messages: CanonicalHistoryMessages;
  readonly identityVector?: HistoryIdentityVector;
}

type RetractTurnReason =
  | { readonly kind: 'input-safety-recall' }
  | { readonly kind: 'output-attempt-recall'; readonly attempt: number }
  | { readonly kind: 'output-final-recall' }
  | { readonly kind: 'fatal' };

export interface SettleTurnTailMutation {
  readonly kind: 'settle-turn-tail';
  readonly sessionId: string;
  readonly turnId: string;
  readonly mode: 'abort' | 'network' | 'safety';
  readonly approvedContent: string;
  readonly operation: HistoryCommitOperation;
}

export interface RetractTurnMutation {
  readonly kind: 'retract-turn';
  readonly sessionId: string;
  readonly turnId: string;
  readonly reason: RetractTurnReason;
  readonly operation: HistoryCommitOperation;
}

export type TurnHistoryMutation = SettleTurnTailMutation | RetractTurnMutation;

export interface TurnHistoryMutationCommit extends CanonicalHistoryCommit {
  readonly status: 'committed' | 'unchanged' | 'already-retracted';
  readonly deletedMessageIds: readonly string[];
}

export interface CanonicalHistoryCompactionChange extends CanonicalHistoryChange {
  readonly operation: HistoryCommitOperation & { readonly kind: 'compaction' };
}

export interface CanonicalHistoryStore {
  read(sessionId: string): Promise<CanonicalHistorySnapshot>;
  /**
   * Both mutations return the full committed snapshot reread inside the same
   * per-Session ordering lane as the durable write.
   */
  append(change: CanonicalHistoryChange): Promise<CanonicalHistoryCommit>;
  replace(change: CanonicalHistoryChange): Promise<CanonicalHistoryCommit>;
  compact?(change: CanonicalHistoryCompactionChange): Promise<CanonicalHistoryCommit>;
  settleTurnTail?(mutation: SettleTurnTailMutation): Promise<TurnHistoryMutationCommit>;
  retractTurn?(mutation: RetractTurnMutation): Promise<TurnHistoryMutationCommit>;
}

/**
 * Best-effort usage/token projection scheduled by the committed History writer
 * after a fresh append and its required projection succeed.
 */
export interface CommittedUsageProjector {
  record(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly model: TurnAssemblyCtx['model'] | undefined;
    readonly messages: readonly unknown[];
  }): Promise<void>;
}

export interface AgentHostUsageProjection {
  readonly projector: CommittedUsageProjector;
  readonly onFailure?: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly error: unknown;
  }) => void;
}

export interface AgentHostHistoryFailure {
  fail(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly metadata?: unknown;
  }): Promise<void>;
}
