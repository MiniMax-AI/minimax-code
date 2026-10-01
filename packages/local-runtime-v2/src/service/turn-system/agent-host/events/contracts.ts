import type { RuntimeEvent } from '@mavis/agent-core/protocol';
import type { TurnAssemblyCtx } from '@mavis/agent-runtime';

import type { CommittedHistoryChange } from '../history/contracts.js';
import type { AgentHostTurnProvenance } from '../preparation/contracts.js';
import type { AgentHostTurnOutcome } from '../runner/contracts.js';

export interface AgentEventContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnSequence: number;
  /** Queue-owned delivery identity retained only for provenance routing. */
  readonly queueItemIds?: readonly string[];
  /**
   * Secret-free model projection from the resolved Agent execution snapshot.
   * It is absent only when failure happens before AgentHost completes preflight.
   */
  readonly executionModel?: TurnAssemblyCtx['model'];
  /** Frozen physical Agent resource owner from successful preflight. */
  readonly resourceAgentName?: string;
  readonly clientRequestId?: string;
  readonly provenance?: AgentHostTurnProvenance;
}

export type AgentEventResult =
  | { readonly terminal: false }
  | {
      readonly terminal: true;
      readonly outcome: AgentHostTurnOutcome['status'];
    };

export interface AgentEventDelivery {
  handleRuntimeEvent(
    context: AgentEventContext,
    event: RuntimeEvent,
    signal?: AbortSignal,
  ): Promise<AgentEventResult>;
  handleHistoryCommitted(context: AgentEventContext, change: CommittedHistoryChange): Promise<void>;
}
