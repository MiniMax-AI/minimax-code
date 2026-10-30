import type { UserModelSelection } from './config/model-selection-input.js';
import type {
  AgentBuiltinMcpToolId,
  AgentBuiltinSkillId,
  AgentBuiltinToolId,
  ResolvedAgentCapabilities,
} from '@mavis/config';
import type { PromptReadScope } from '@mavis/agent-runtime';
import type { InputSafetyDecision } from '../../../content-safety/index.js';
import type { LocalResolvedModelConfig } from '../../../model-system/index.js';
import type {
  SessionRecord,
  TaskSessionBinding,
  UserMessageId,
} from '../../../session-system/index.js';
import type { CanonicalHistorySnapshot } from '../history/contracts.js';
import type { AgentHostTurnCapabilityView } from '../assembly/turn-capability-lifecycle.js';

export interface AgentHostInputAttachment {
  readonly type?: string;
  readonly filePath?: string;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly desktopPath?: string;
  readonly dataUrl?: string;
  readonly assetId?: string;
  readonly error?: string;
}

/** Materialized native attachment identity exposed only to Turn-scoped tool policy. */
export interface AgentHostBrowserAsset {
  readonly filePath: string;
  readonly fileName: string;
  readonly mimeType: string;
}

export interface AgentHostChannelContext {
  readonly platform: string;
  readonly chatType?: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly clientName?: string;
  readonly threadId?: string;
  readonly sourceMessageId?: string;
  readonly contextToken?: string;
  readonly channel?: string;
  readonly channel_id?: string;
}

interface AgentHostBackgroundTaskInputOrigin {
  readonly kind: 'background-task-terminal';
  readonly taskIds: readonly string[];
  /** Absent only for a legacy automatic delivery row. */
  readonly observedTerminalCount?: number;
}

export type AgentHostInputOrigin = AgentHostBackgroundTaskInputOrigin;

export interface AgentHostQueuedUserInput {
  readonly text: string;
  readonly attachments?: readonly AgentHostInputAttachment[];
  readonly origin?: AgentHostInputOrigin;
  readonly quotedMessage?: {
    readonly text: string;
    readonly senderName?: string;
  };
  readonly channelContext?: AgentHostChannelContext;
}

/**
 * Host-owned admitted input. `queuedMessages` remains outside AgentRuntime;
 * AgentHost renders it once into the secret-free `TurnAssemblyCtx.userInput`.
 */
export interface AgentHostUserInput extends AgentHostQueuedUserInput {
  readonly queuedMessages?: readonly AgentHostQueuedUserInput[];
  readonly model?: UserModelSelection & {
    readonly parameterSnapshot?: {
      readonly context: 'default' | 'selection' | 'legacy';
      readonly effort: 'default' | 'selection' | 'legacy';
    };
  };
}

export interface AgentHostCanonicalUserInput {
  readonly text: string;
  readonly messages: readonly AgentHostQueuedUserInput[];
}

export interface AgentHostTurnProvenance {
  readonly source: string;
  readonly sourceContext?: Readonly<Record<string, unknown>>;
  readonly routingFingerprint: string;
}

export type TurnOutputContract =
  | { readonly type: 'json_object' }
  | {
      readonly type: 'json_schema';
      readonly schema: Readonly<Record<string, unknown>>;
    };

export interface AgentHostExecutionRequest {
  readonly immediateSendBatch?: {
    readonly id: string;
    readonly members: readonly {
      readonly input: AgentHostQueuedUserInput;
      readonly genuineUserQueryText: string;
      readonly userMessageId: UserMessageId;
      readonly messageKey: string;
      readonly createdAt: number;
      readonly provenance: AgentHostTurnProvenance;
    }[];
  };
  readonly input: AgentHostUserInput;
  readonly outputContract?: TurnOutputContract;
  /** Advisory Unix-ms deadline from the process-local cancellation owner. */
  readonly executionDeadlineAtMs?: number;
  readonly genuineUserQueryText: string;
  readonly inputSafetyDecision?: InputSafetyDecision;
  /** Set only for a committed, visible user query; hidden continuations skip input review. */
  readonly requiresInputReview?: boolean;
  readonly provenance: AgentHostTurnProvenance;
  readonly clientRequestId?: string;
  readonly userMessageId?: UserMessageId;
  readonly queueItemIds?: readonly string[];
  readonly clientIntent?: string;
  /** Re-enter the current canonical agent loop without appending another user message. */
  readonly executionMode?: 'continuation';
}

export interface TurnRuntimeFactSource {
  snapshot(): {
    readonly cuModeActive: boolean;
  };
}

export interface AgentExecutionSnapshot {
  readonly agentName: string;
  /**
   * Internal behaviour owner frozen for the whole Turn. For the primary family
   * `agentName` stays the persisted storage owner (`main` on upgraded
   * installs) while this field pins persona / profile / identity / config /
   * capability ceiling / skill policy to the canonical row. Absent for callers
   * that predate the split; consumers fall back to `agentName`.
   */
  readonly executionOwnerName?: string;
  /** Physical Agent resource owner; differs for migrated `main` -> `mavis` aliases. */
  readonly resourceAgentName?: string;
  readonly displayName?: string;
  readonly agentRole?: string;
  readonly agentConfigDir?: string;
  readonly persona?: string;
  readonly systemPrompt: string;
  /** The supplied system prompt already owns the common base layer. */
  readonly systemPromptIncludesBase?: boolean;
  readonly builtinCapabilities?: ResolvedAgentCapabilities;
  readonly builtinSkillNames?: readonly string[];
  readonly cuModeActive?: boolean;
  readonly model?: Readonly<Record<string, unknown>>;
  readonly tools?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LocalAgentCapabilityCeiling {
  readonly personaEnabled: boolean;
  readonly tools?: readonly AgentBuiltinToolId[];
  readonly builtinTools?: readonly AgentBuiltinMcpToolId[];
  readonly skills?: readonly AgentBuiltinSkillId[];
  readonly features: Readonly<{
    mavis: boolean;
    delegation: boolean;
    webSearch: boolean;
  }>;
}

export interface LocalAgentExecutionProfile {
  readonly excludeAgentResources?: boolean;
  readonly skipAgentResolution?: boolean;
  readonly expectedAgentInstanceId?: string;
  readonly requestRef: string;
  readonly resourceReadRef: string;
  readonly exactOwnerName: string;
  readonly canonicalViewName: string;
  readonly resolvedAgentName: string;
  readonly agentRole: string;
  readonly creationSource: 'manual' | 'auto' | 'builtin';
  readonly surface: 'interactive' | 'task-child' | 'cli';
  /** Session-derived task classification; authorization requires separate host-owned provenance. */
  readonly taskExecutionMode?: 'foreground' | 'background' | 'team';
  readonly memoryReadAgentNames: readonly string[];
  readonly persona?: string;
  /** Canonical Agent-owned prompt, before Runtime shared/surface layers. */
  readonly agentSystemPrompt?: string;
  readonly promptMetadata?: Readonly<Record<string, unknown>>;
  readonly corePrompt: string;
  readonly surfacePrompt: string;
  /** Raw canonical selectors; ready-runtime inventory still forms the upper bound. */
  readonly configSelection?: LocalAgentConfigurationSelection;
  readonly capabilityCeiling: LocalAgentCapabilityCeiling;
  readonly provenance: Readonly<{
    source: 'builtin' | 'custom' | 'legacy-read-through';
    assetAgentName: string;
    locale: string;
    appMode?: 'coding' | 'work';
    promptChannel?: 'online' | 'internal';
  }>;
}

export interface LocalAgentConfigurationSelection {
  readonly model?: string;
  readonly effort?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly skills?: readonly string[];
  readonly extensionSkills?: readonly string[];
}

/** Neutral profile renderer supplied by the Agent owner at composition time. */
export interface LocalAgentProfileSource {
  render(input: {
    readonly session: SessionRecord;
    readonly agent: AgentExecutionSnapshot;
    readonly isSessionFirstTurn: boolean;
    readonly agentBinding?: TaskSessionBinding;
    readonly promptRead?: PromptReadScope;
    /**
     * The Session's `toolCallMode` is `ptc` and the turn intent is
     * `desktop-ptc`. The Agent profile still applies the role and surface rules
     * before rendering the PTC prompt section.
     */
    readonly ptcRequested?: boolean;
  }): Promise<LocalAgentExecutionProfile>;
}

export interface AgentExecutionSource<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> {
  getExecutionSnapshot(
    agentName: string,
    context?: {
      readonly sessionId?: string;
      readonly appMode?: SessionRecord['appMode'];
      /** Task snapshots must not consume mutable Custom-Agent files. */
      readonly sessionKind?: SessionRecord['sessionKind'];
    },
  ): Promise<TAgent | undefined>;
}

export const CONTEXT_USAGE_PROMPT_KINDS = ['MEMORY', 'SKILLS', 'OTHER'] as const;

export interface ContextUsagePromptRange {
  readonly kind: (typeof CONTEXT_USAGE_PROMPT_KINDS)[number];
  readonly startOffset: number;
  readonly endOffset: number;
}

/** Resolved v2-owned AgentConfig and credential-bearing runner model. */
export interface LocalTurnPreparation {
  readonly agentConfig: Readonly<Record<string, unknown>>;
  readonly llm: LocalResolvedModelConfig;
  /** Frozen during normal-turn preparation with the same Prompt snapshot as System Prompt. */
  readonly outputRevisionInstruction?: string;
  /** Replaces the persisted retry fallback only for this model call. */
  readonly retryContinuationPrompt?: string;
  readonly promptRead?: PromptReadScope;
}

export interface LocalTurnPreparationInput<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> {
  readonly turnId: string;
  readonly request: AgentHostExecutionRequest;
  readonly session: SessionRecord;
  readonly agent: TAgent;
  readonly history: CanonicalHistorySnapshot;
  readonly desktopCapabilities?: AgentHostTurnCapabilityView;
  /** Ephemeral internal scope carried by Greeting delivery; never persisted with the request. */
  readonly promptRead?: PromptReadScope;
}

/**
 * V2 conversation-preparation owner shared by AgentHost and later compaction /
 * title / context-debug callers.
 */
export interface LocalTurnPreparationSource<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> {
  prepare(input: LocalTurnPreparationInput<TAgent>): Promise<LocalTurnPreparation>;
}

export interface ContextCompactionPreparationInput<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> {
  readonly turnId: string;
  readonly session: SessionRecord;
  readonly agent: TAgent;
  readonly history: CanonicalHistorySnapshot;
  readonly desktopCapabilities?: AgentHostTurnCapabilityView;
}

export interface ContextCompactionPreparationSource<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> {
  prepareCompaction(
    input: ContextCompactionPreparationInput<TAgent>,
  ): Promise<LocalTurnPreparation>;
}
