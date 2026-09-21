import type {
  DisplayMessageRecord,
  SessionRecord,
  SessionRunLocation,
  UserMessageId,
} from '../../service/session-system/index.js';

export interface ForkRequest {
  readonly operationId: string;
  readonly sourceSessionId: string;
  readonly assistantDisplayMessageId?: string;
  readonly title?: string | null;
  readonly useSuggestedTitle?: boolean;
  readonly isolatedWorktree?: boolean;
  /**
   * Internal presentation policy for an ephemeral side fork. The public
   * DesktopService Fork request remains unchanged; createSession selects this
   * path through its existing parentSessionId + purpose fields.
   */
  readonly sidePresentation?: {
    readonly parentSessionId: string;
    readonly purpose: string;
  };
  /** Application-owned policy captured before the durable Fork starts. */
  readonly planState?: {
    readonly interactionMode: 'default' | 'plan';
  };
}

export type ResolvedForkRequest = ForkRequest & {
  /** Frozen inclusive history boundary for a side conversation; may be a tool result. */
  readonly sideHistoryMessageId?: string;
  readonly assistantDisplayMessageId: string;
};

export interface ForkOperationManifest {
  readonly schemaVersion: 1;
  readonly request: ResolvedForkRequest;
  readonly source: {
    readonly sessionId: string;
    readonly assistantDisplayMessageId: string;
    readonly sourceRevision?: string;
    readonly sourceFingerprint?: string;
  };
  readonly childSessionId?: string;
  readonly worktree?: {
    readonly workspaceDir: string;
    readonly runLocation?: SessionRunLocation;
    readonly ownershipToken?: string;
    readonly fingerprint?: string;
  };
  readonly assets?: {
    /** Missing only on durable manifests created before copy modes existed. */
    readonly mode?: 'records-only' | 'workspace-copy';
    readonly targetRoot?: string;
    readonly copiedPaths: readonly string[];
  };
  readonly forkOrigin?: {
    readonly sourceDisplayMessageId: string;
    readonly operationId: string;
  };
  readonly historyRevision?: string;
  readonly lastError?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface ForkResult {
  readonly status: 'created' | 'duplicate';
  readonly child: SessionRecord;
  readonly sourceDisplayMessageId?: string;
  readonly historyRevision?: string;
}

export interface ForkResumeResult {
  readonly result: ForkResult;
  readonly manifest: ForkOperationManifest;
}

export interface ForkBoundary {
  /** Inclusive complete-prefix boundary selected for a side conversation. */
  readonly sideHistoryMessageId?: string;
  readonly messages: readonly DisplayMessageRecord[];
  readonly assistant: DisplayMessageRecord;
  readonly assistantIndex: number;
  /** Preferred stable boundary owned by the selected canonical Assistant. */
  readonly assistantCanonicalMessageId?: string;
  /** Compatibility boundary for Display rows written before Assistant anchors existed. */
  readonly beforeUserMessageId?: UserMessageId;
  /** False when no Display-derived candidate is reachable in canonical history. */
  readonly canonicalBoundaryReachable: boolean;
  readonly isLatestConversationMessage: boolean;
}

export interface ForkBoundaryPort {
  resolve(input: {
    readonly sideHistory?: { readonly throughMessageId?: string };
    readonly sessionId: string;
    readonly assistantDisplayMessageId?: string;
  }): Promise<ForkBoundary | undefined>;
}

export interface ForkSessionPort {
  get(sessionId: string): Promise<SessionRecord | undefined>;
  titleExists?(input: { readonly agentName: string; readonly title: string }): Promise<boolean>;
  probe?(input: {
    readonly sessionId: string;
    readonly visibility: 'hidden' | 'visible';
  }): Promise<SessionRecord | undefined>;
  create(input: {
    /** Source id lets Task child creation resolve its frozen V2 definition. */
    readonly sourceSessionId: string;
    readonly agentName: string;
    readonly workspaceDir: string;
    readonly isDefaultWorkspace?: SessionRecord['isDefaultWorkspace'];
    readonly title: string;
    readonly appMode?: SessionRecord['appMode'];
    readonly runLocation?: SessionRecord['runLocation'];
    readonly effectiveModel?: SessionRecord['effectiveModel'];
    readonly effectiveModelVariant?: SessionRecord['effectiveModelVariant'];
    readonly effectiveModelThinking?: SessionRecord['effectiveModelThinking'];
    readonly effectiveModelContextWindow?: SessionRecord['effectiveModelContextWindow'];
    readonly effectiveModelMaxOutputTokens?: SessionRecord['effectiveModelMaxOutputTokens'];
    readonly parentSessionId?: string;
    readonly visibility?: 'hidden' | 'visible';
    readonly purpose?: string;
    readonly sessionKind?: SessionRecord['sessionKind'];
  }): Promise<SessionRecord>;
  update(
    sessionId: string,
    fields: { readonly visibility?: 'hidden' | 'visible' },
  ): Promise<SessionRecord | undefined>;
  delete(sessionId: string): Promise<void>;
}

export interface ForkDisplayPort {
  list(sessionId: string): Promise<readonly DisplayMessageRecord[]>;
  probePrefix?(input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly throughMessageId: string;
  }): Promise<boolean>;
  copyPrefix(input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly throughMessageId: string;
  }): Promise<void>;
  copyPrefixAndAppendForkOrigin?(input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly throughMessageId: string;
  }): Promise<void>;
  appendForkOrigin(input: {
    readonly targetSessionId: string;
    readonly sourceSessionId: string;
  }): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface ForkHistoryPort {
  fork(input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly targetWorkspaceDir: string;
    readonly throughAssistantMessageId?: string;
    readonly throughMessageId?: string;
    readonly beforeUserMessageId?: UserMessageId;
    readonly rewindTargetWorkspace?: boolean;
    readonly operationId: string;
    readonly continuation?: {
      readonly previousWorkspaceDir: string;
      readonly currentWorkspaceDir: string;
      readonly currentBranch: string;
    };
    readonly hiddenContextBoundary?: {
      readonly kind: string;
      readonly content: string;
    };
  }): Promise<{ readonly historyRevision: string }>;
}

export interface ForkAssetPort {
  copyPrefix(
    input: {
      readonly sourceSessionId: string;
      readonly targetSessionId: string;
      readonly messageIds: readonly string[];
    } & (
      | { readonly mode: 'records-only' }
      | {
          readonly mode: 'workspace-copy';
          readonly sourceWorkspaceDir: string;
          readonly targetWorkspaceDir: string;
        }
    ),
  ): Promise<{
    readonly mode: 'records-only' | 'workspace-copy';
    readonly targetRoot?: string;
    readonly copiedPaths: readonly string[];
  }>;
  probe?(input: {
    readonly targetSessionId: string;
    /** Missing only for recovery of manifests written before copy modes existed. */
    readonly mode?: 'records-only' | 'workspace-copy';
    readonly targetRoot?: string;
    readonly copiedPaths: readonly string[];
  }): Promise<boolean>;
  compensate(input: {
    readonly targetSessionId: string;
    /** Missing only for recovery of manifests written before copy modes existed. */
    readonly mode?: 'records-only' | 'workspace-copy';
    readonly targetRoot?: string;
    readonly copiedPaths?: readonly string[];
  }): Promise<void>;
}

export interface ForkSessionStatePort {
  copy(input: {
    readonly operationId: string;
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly latestBoundary: boolean;
    readonly planState?: ForkRequest['planState'];
  }): Promise<void>;
  compensate(input: { readonly targetSessionId: string }): Promise<void>;
}

export interface ForkOperationPort {
  get(operationId: string, request?: ForkRequest): Promise<ForkResult | undefined>;
  getPending?(operationId: string): Promise<
    | {
        readonly status: string;
        readonly stage: string | null;
        readonly intent: ForkOperationManifest | undefined;
      }
    | undefined
  >;
  listPending?(): Promise<
    readonly {
      readonly operationId: string;
      readonly status: string;
      readonly stage: string | null;
      readonly intent: ForkOperationManifest | undefined;
      readonly revision: number;
    }[]
  >;
  claim?(input: {
    readonly operationId: string;
    readonly owner: string;
    readonly leaseMs: number;
  }): Promise<
    | {
        readonly operationId: string;
        readonly status: string;
        readonly stage: string | null;
        readonly intent: ForkOperationManifest | undefined;
        readonly revision: number;
      }
    | undefined
  >;
  advance?(input: {
    readonly operationId: string;
    readonly status: string;
    readonly stage: string;
    readonly intent?: ForkOperationManifest;
  }): Promise<void>;
  advanceClaimed?(input: {
    readonly operationId: string;
    readonly owner: string;
    readonly expectedRevision: number;
    readonly status: string;
    readonly stage: string;
    readonly intent?: ForkOperationManifest;
    readonly result?: ForkResult;
    readonly error?: { readonly code: string; readonly message: string };
    readonly leaseMs?: number;
  }): Promise<{ readonly revision: number } | undefined>;
  /** Required recovery fallback: reaches a terminal row even after a claimed CAS is lost. */
  failRecovery?(input: {
    readonly operationId: string;
    readonly stage: 'compensated' | 'recovery-failed';
    readonly intent?: ForkOperationManifest;
    readonly error: { readonly code: string; readonly message: string };
  }): Promise<void>;
  put(operationId: string, result: ForkResult): Promise<void>;
}

export interface ForkWorktreePort {
  /** Read-only structural probe used before offering the isolated-worktree choice. */
  isEligible(source: SessionRecord): Promise<boolean>;
  prepare(input: {
    readonly operationId: string;
    readonly source: SessionRecord;
    readonly allowTargetMutation?: boolean;
  }): Promise<{
    readonly workspaceDir: string;
    readonly runLocation: SessionRecord['runLocation'];
    readonly ownershipToken?: string;
    readonly fingerprint?: string;
  }>;
  /** Proves persisted ownership before a cross-process recovery continues. */
  probe?(input: {
    readonly operationId: string;
    readonly workspaceDir: string;
    readonly ownershipToken?: string;
    readonly fingerprint?: string;
    readonly runLocation?: SessionRecord['runLocation'];
  }): Promise<{
    readonly workspaceDir: string;
    readonly runLocation?: SessionRecord['runLocation'];
  }>;
  cleanup(input: {
    readonly operationId: string;
    readonly workspaceDir: string;
    readonly ownershipToken?: string;
  }): Promise<void>;
}

export class ForkServiceError extends Error {
  constructor(
    readonly code:
      | 'source-not-found'
      | 'unsupported-session'
      | 'assistant-not-found'
      | 'assistant-not-settled'
      | 'invalid-boundary'
      | 'busy'
      | 'request-conflict'
      | 'worktree-unavailable'
      | 'worktree-source-changed'
      | 'recovery-failed'
      | 'fork-failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ForkServiceError';
  }
}
