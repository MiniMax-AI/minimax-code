import { createLocalTurnOutcomeTracker } from '../runner/turn-outcome.js';

import type { RuntimeEvent } from '@mavis/agent-core/protocol';
import type { PiEventWriter } from '@mavis/agent-core/pi-turn-runner';

import type { AgentExecutionSnapshot } from '../preparation/contracts.js';
import type { LocalTurnExecutionInput } from '../runner/contracts.js';

export interface LocalTurnEventWriter extends PiEventWriter {
  readonly events: readonly RuntimeEvent[];
  /** Present only for a runner that explicitly accepts incremental outcomes. */
  readonly outcome?: Pick<ReturnType<typeof createLocalTurnOutcomeTracker>, 'eventCount' | 'read'>;
}

export type RuntimeEventProjector = (input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly event: RuntimeEvent;
}) => RuntimeEvent | undefined | Promise<RuntimeEvent | undefined>;

export function createLocalTurnEventWriter<TAgent extends AgentExecutionSnapshot>(
  input: LocalTurnExecutionInput<TAgent>,
  projectRuntimeEvent?: RuntimeEventProjector,
  options: { readonly retainEvents?: boolean } = {},
): LocalTurnEventWriter {
  const recorded: RuntimeEvent[] = [];
  const outcome = options.retainEvents === false ? createLocalTurnOutcomeTracker() : undefined;
  const project = async (event: RuntimeEvent): Promise<RuntimeEvent | undefined> =>
    projectRuntimeEvent
      ? projectRuntimeEvent({
          sessionId: input.lease.sessionId,
          turnId: input.lease.turnId,
          event,
        })
      : event;

  const push = async (event: RuntimeEvent): Promise<void> => {
    const projected = await project(event);
    if (!projected) return;
    if (outcome) outcome.observe(projected);
    else recorded.push(projected);
    await input.onRuntimeEvent(projected);
  };

  return {
    events: recorded,
    ...(outcome ? { outcome } : {}),
    pushRuntime: push,
    appendEvents: async (events) => {
      for (const event of events) await push(event);
    },
  };
}
