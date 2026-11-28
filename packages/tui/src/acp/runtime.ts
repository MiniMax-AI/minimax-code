import type {
  TuiActiveRunControlPort,
  TuiConfigurationPort,
  TuiConversationPort,
  TuiDelegationPort,
  TuiGoalPort,
  TuiInteractionPort,
  TuiInspectionPort,
  TuiQueuePort,
  TuiRuntimeEventPort,
  TuiSessionActivityPort,
  TuiSessionForkPort,
  TuiSessionPort,
  TuiSessionTurnPort,
} from '../runtime/port.js';

/** Runtime capabilities consumed by the ACP adapter. */
export type TuiAcpRuntime = TuiSessionPort &
  TuiConfigurationPort &
  TuiInspectionPort &
  TuiConversationPort &
  TuiSessionTurnPort &
  TuiInteractionPort &
  TuiRuntimeEventPort &
  TuiQueuePort &
  TuiGoalPort &
  TuiDelegationPort &
  TuiSessionActivityPort &
  TuiSessionForkPort &
  Pick<TuiActiveRunControlPort, 'getActiveRun'>;
