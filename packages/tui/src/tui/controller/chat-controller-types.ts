import type { TuiRunCoordinator, TuiRunRequest } from '../../application/run-coordinator.js';
import type { ExecResultV1 } from '../../application/exec-result.js';
import type {
  TuiAccountStatus,
  TuiClientIntent,
  TuiSession,
  TuiSessionUsageSummary,
  TuiContextSnapshotResponse,
} from '../../runtime/port.js';
import type { TuiTransportAttachment } from '../../types/invocation.js';
import type { TranscriptStore } from '../transcript/store.js';
import type { TuiTodoItem } from '../todo/model.js';
import type { TuiChatRuntimeLike } from './chat-controller-support.js';

export type TuiChatStatus = 'idle' | 'starting' | 'running' | 'error';

export interface TuiSettledTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly status: 'succeeded' | 'failed' | 'blocked' | 'cancelled';
}

export interface TuiChatSnapshot {
  status: TuiChatStatus;
  sessions: TuiSession[];
  session?: TuiSession;
  account?: TuiAccountStatus;
  sessionUsage?: TuiSessionUsageSummary;
  contextSnapshot?: TuiContextSnapshotResponse;
  activeTurnId?: string;
  /**
   * TUI-generated id of the latest submission that no Runtime frame has
   * confirmed yet. The Runtime may never adopt it (e.g. a queue fallback gets
   * a Runtime-generated id), so it is not a Runtime fact.
   */
  unadmittedTurnId?: string;
  cancelling?: boolean;
  retiringTurnId?: string;
  outputTokensPerSecond?: number;
  outputTokensPerSecondEstimated?: boolean;
  error?: string;
  errorRetryable?: boolean;
  /** Latest canonical turn outcome for this Session. */
  lastSettledTurn?: TuiSettledTurn;
}

export interface CreateTuiChatControllerOptions {
  runtime: TuiChatRuntimeLike;
  transcript: TranscriptStore;
  workspaceDir: string;
  version?: string;
  defaultAgentName?: string;
  createTurnId?: () => string;
  runCoordinator?: TuiRunCoordinator;
  retirementWarningTimeoutMs?: number;
  now?: () => number;
  onChange?: (snapshot: TuiChatSnapshot) => void;
  onTodoChange?: (items: readonly TuiTodoItem[]) => void;
  onTurnAccepted?: (turnId: string) => void;
  onUserSubmissionProjected?: () => void;
  onSessionLifecycle?: (sessionId?: string) => void;
  /**
   * Awaited after this controller creates a Session and before the Session is
   * returned, so it lands before the first Turn. Its failures never block the
   * Session; report them inside.
   */
  prepareCreatedSession?: (session: TuiSession) => Promise<void>;
  /** Refresh and count the current root's unsettled delegated Agents and pending reports. */
  refreshActiveDelegatedAgentCount?: () => number | Promise<number>;
  /** Optional automation result sink. */
  writeAutomationResult?: (result: ExecResultV1) => void | Promise<void>;
  /** Runs only after the optional automation result sink has completed successfully. */
  onAutomationResultPublished?: (result: ExecResultV1) => void;
}

export interface TuiSubmitOptions {
  onQueuePaused?: TuiRunRequest['onQueuePaused'];
  attachments?: readonly TuiTransportAttachment[];
  /** Visible user text when the Runtime payload contains hidden transport context. */
  displayContent?: string;
  clientIntent?: TuiClientIntent;
  reviewRequest?: { readonly scope: 'local_changes' };
  onSessionResolved?: (sessionId: string) => void;
  beforeTurnAdmission?: (sessionId: string) => void | Promise<void>;
  onRuntimeAccepted?: (sessionId: string) => void;
  optimisticRequestId?: string;
  /**
   * Fired once a new turn has been minted and projected (before the first
   * await), so the caller can retain per-turn state such as the original
   * submission snapshot. Not fired for steer paths or retry continuations.
   */
  onTurnStarted?: (turnId: string) => void;
}
