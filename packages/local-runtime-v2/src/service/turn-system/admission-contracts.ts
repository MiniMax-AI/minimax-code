import type { AppDb } from '../../infra/db/client.js';
import type { UserMessageId } from '../session-system/shared/user-message-id.js';
import type { AgentHostTurnProvenance } from './agent-host/contracts.js';

export type TurnAdmissionRejectionReason =
  | 'invalid-session'
  | 'invalid-input'
  | 'active-turn'
  | 'compaction-active'
  | 'session-deleting'
  | 'session-mutating'
  | 'priority-blocked'
  | 'ingress-conflict'
  | `policy:${string}`;

/**
 * Queue ownership stays in SessionSystem/TurnSystem. AgentHost receives the
 * same immutable ingress facts without the claim identity.
 */
export interface QueueIngressIdentity {
  readonly claimId: string;
  readonly itemId: string;
  readonly userMessageId?: UserMessageId;
  readonly clientRequestId?: string;
  readonly provenance: AgentHostTurnProvenance;
}

/**
 * Durable identity of the persisted user-input wait a resume Turn continues.
 * The owning reply is only marked consumed after this admission succeeds, so
 * policies must be able to exclude exactly this request from their fences.
 */
export interface TurnAdmissionUserInputResume {
  readonly kind: 'questionnaire';
  readonly requestId: string;
  readonly owner?: {
    readonly kind: 'thread-goal';
    readonly goalId: string;
  };
}

/** Immutable facts exposed to optional product admission policy. */
export interface TurnAdmissionCandidate {
  readonly sessionId: string;
  readonly candidateCreatedAtMs: number;
  readonly genuineUserMessage?: boolean;
  readonly clientIntent?: string;
  readonly queueIngress?: QueueIngressIdentity;
  readonly userInputResume?: TurnAdmissionUserInputResume;
}

/** Product-owned policy evaluated inside the Turn admission transaction. */
export interface TurnAdmissionPolicy {
  applyInTransaction(
    db: AppDb,
    input: TurnAdmissionCandidate,
  ): TurnAdmissionRejectionReason | undefined;
}

export function composeTurnAdmissionPolicies(
  ...policies: readonly TurnAdmissionPolicy[]
): TurnAdmissionPolicy {
  return {
    applyInTransaction(db, input) {
      for (const policy of policies) {
        const rejection = policy.applyInTransaction(db, input);
        if (rejection) return rejection;
      }
      return undefined;
    },
  };
}

export interface TurnIngressReceipt {
  readonly sessionId: string;
  readonly turnId: string;
  readonly inputDigest: string;
  readonly acceptedSequence: number;
}

/** One client request id and the Turn it was durably admitted to or steered into. */
export interface TurnClientRequestBinding {
  readonly clientRequestId: string;
  readonly turnId: string;
}

export interface TurnSessionAdmissionCapability {
  rejectionInTransaction(
    db: AppDb,
    input: { readonly sessionId: string },
  ): 'invalid-session' | 'session-deleting' | 'session-mutating' | undefined;
}
