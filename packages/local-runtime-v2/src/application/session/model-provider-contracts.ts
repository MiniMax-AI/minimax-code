import type { GlobalEventPublisher } from '../events.js';
import type { ConversationModelThinkingSelection } from '@mavis/conversation-contract';
import type { FrozenAgentExecutionDefinition } from '../../service/session-system/index.js';
import type {
  AdvisorModelSelectionInput,
  LocalDefaultAdvisorConfig,
  LocalModelProviderService,
  LocalRuntimeConfig,
  ManagedModelParameterSnapshot,
} from '../../service/model-system/index.js';

export interface ModelProviderSessionView {
  /** Trusted persisted definition, omitted from public model projections. */
  readonly frozenModel?: FrozenAgentExecutionDefinition['model'];
  readonly sessionKind?: string;
  readonly effectiveModelContextWindow?: number | null;
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly effectiveModelThinking?: ConversationModelThinkingSelection | null;
  readonly advisor?: AdvisorModelSelectionInput | null;
}

export interface ModelProviderSessionPort {
  get(sessionId: string): Promise<ModelProviderSessionView | undefined>;
  update(
    sessionId: string,
    fields: {
      readonly modelParameterSnapshot?: ManagedModelParameterSnapshot;
      readonly effectiveModelContextWindow?: number | null;
      readonly effectiveModelMaxOutputTokens?: number | null;
      readonly effectiveModel: string;
      readonly effectiveModelVariant: string | null;
      readonly effectiveModelThinking?: ConversationModelThinkingSelection | null;
    },
  ): Promise<unknown>;
  updateAdvisor(sessionId: string, advisor: AdvisorModelSelectionInput): Promise<unknown>;
}

export interface ModelProviderApplicationDeps {
  readonly publish?: GlobalEventPublisher;
  readonly config: () => LocalRuntimeConfig;
  readonly providers: LocalModelProviderService;
  readonly sessions: ModelProviderSessionPort;
  readonly setDefaultModel: (
    modelKey: string,
    variant?: string,
    selection?: {
      readonly contextLimit?: number;
      readonly thinking?: ConversationModelThinkingSelection;
    },
  ) => Promise<void>;
  readonly setDefaultAdvisor: (selection: LocalDefaultAdvisorConfig) => Promise<void>;
  readonly refreshOfficialModels?: () => Promise<void>;
  readonly implicitCustomProviderThinking?: boolean;
  readonly tuiProductPolicy?: boolean;
}

export interface SelectRuntimeModelInput {
  readonly reasoning?: boolean;
  readonly replaceSelection?: boolean;
  readonly contextLimit?: number;
  readonly sessionId?: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly thinking?: ConversationModelThinkingSelection | null;
}

export interface SelectAdvisorInput {
  readonly enabled: boolean;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly sessionId?: string;
  readonly thinking?: { readonly effort: string } | null;
  readonly contextLimit?: number;
}

export interface AdvisorSelectionView {
  readonly enabled: boolean;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly thinking?: { readonly effort: string };
  readonly contextLimit?: number;
}
