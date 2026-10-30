import type {
  SessionAgentDefinitionCreate,
  FrozenAgentExecutionDefinition,
  TaskSessionBindingCreate,
} from '../repo/agent-binding.js';
import type {
  SessionInteractionMode,
  SessionRecord,
  SessionKind,
  SessionOrigin,
  SessionModelSnapshot,
} from '../repo/contract.js';
import type { ConversationModelThinkingSelection } from '@mavis/conversation-contract';
import type { SessionMemoryPolicyPatch } from '../memory-policy.js';

export interface SessionMutationFields {
  /** Internal selection receipt; stored only in the frozen definition JSON. */
  readonly modelParameterSnapshot?: FrozenAgentExecutionDefinition['model']['parameterSnapshot'];
  readonly title?: string | null;
  readonly visibility?: 'visible' | 'hidden';
  readonly purpose?: string;
  readonly workspaceDir?: string;
  readonly isDefaultWorkspace?: boolean;
  readonly sessionType?: 'root' | 'branch';
  readonly parentSessionId?: string | null;
  readonly archived?: boolean;
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly effectiveModelThinking?: ConversationModelThinkingSelection | null;
  readonly interactionMode?: SessionInteractionMode;
  readonly effectiveModelContextWindow?: number | null;
  readonly effectiveModelMaxOutputTokens?: number | null;
  readonly memoryPolicy?: SessionMemoryPolicyPatch;
}

export interface SessionToolLifecycleCapability {
  mutateSession(sessionId: string, fields: SessionMutationFields): Promise<SessionRecord>;
  deleteSessionById(sessionId: string): Promise<void>;
}

export type SessionMetadataUpdateFields = Omit<SessionMutationFields, 'memoryPolicy'> & {
  readonly memoryPolicy?: SessionRecord['memoryPolicy'];
};

export interface SessionMetadataCreateInput {
  readonly sessionId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  readonly isDefaultWorkspace: boolean;
  readonly sessionType: 'root' | 'branch';
  readonly sessionKind: SessionKind;
  readonly title: string | null;
  readonly parentSessionId: string | null;
  readonly visibility?: 'visible' | 'hidden';
  readonly purpose?: string;
  readonly originCronId?: string;
  readonly runLocation?: SessionRecord['runLocation'];
  readonly appMode?: NonNullable<SessionRecord['appMode']>;
  readonly toolCallMode?: SessionRecord['toolCallMode'];
  readonly effectiveModel?: string;
  readonly effectiveModelVariant?: string;
  readonly effectiveModelThinking?: ConversationModelThinkingSelection | null;
  readonly effectiveModelContextWindow?: number;
  readonly effectiveModelMaxOutputTokens?: number;
  readonly memoryPolicy?: SessionRecord['memoryPolicy'];
  readonly agentDefinition?: SessionAgentDefinitionCreate;
  readonly taskAgentBinding?: TaskSessionBindingCreate;
  readonly origin: SessionOrigin;
}

export interface SessionMetadataWriter {
  create(input: SessionMetadataCreateInput): Promise<SessionRecord>;
  update(
    sessionId: string,
    fields: SessionMetadataUpdateFields,
    expectedModel?: SessionModelSnapshot,
    expectedTitle?: string | null,
  ): Promise<SessionRecord | undefined>;
  delete(sessionId: string): Promise<void>;
}
