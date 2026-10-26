import {
  compactionTriggerAtForSetting,
  isValidAutoCompactWindowTokens,
  updateLocalAutoCompactWindow,
  type AutoCompactWindowSetting,
} from '@mavis/config';

import {
  formatModelKey,
  readCompactionTriggerSetting,
  type LocalConversationRuntimeConfig,
} from '../../service/model-system/index.js';
import type { SessionRecord } from '../../service/session-system/index.js';
import {
  describeCompactionTrigger,
  readCompactionModelSelection,
  readSessionAgentExecutionSnapshot,
  type ProductionAgentPreparation,
  type ProductionAgentProductCapabilities,
} from '../../service/turn-system/index.js';
import type { LocalRuntimeCompactionTrigger } from './process-local-application-contract.js';

export interface CompactionTriggerApplicationOptions {
  readonly sessions: {
    getExecutionSnapshot(sessionId: string): Promise<SessionRecord | undefined>;
  };
  readonly agents: ProductionAgentProductCapabilities['agents'];
  readonly preparation: Pick<ProductionAgentPreparation, 'buildAgentConfig' | 'resolveModel'>;
  readonly config: () => LocalConversationRuntimeConfig;
}

/**
 * Reads and saves a Session model's automatic compaction trigger. The model and
 * its limits come from the same Agent/model preparation as the next Turn, and
 * the trigger from the same config selection and budget as the compactor.
 */
export function createCompactionTriggerApplication(options: CompactionTriggerApplicationOptions) {
  const describe = (model: SessionCompactionModel): LocalRuntimeCompactionTrigger => {
    // The same setting reader and budget the automatic compactor probes with.
    const setting = readCompactionTriggerSetting(options.config(), model.selection);
    return {
      ...model.selection,
      contextWindow: model.llm.model.contextWindow,
      ...describeCompactionTrigger({
        compactionTriggerAt: compactionTriggerAtForSetting(setting),
        llm: model.llm,
      }),
      source: setting.source,
      ...(setting.source === 'model' ? { saved: setting.value } : {}),
      ...(setting.source === 'model-auto' ? { saved: 'auto' as const } : {}),
    };
  };
  return {
    getCompactionTrigger: async ({ sessionId }: { readonly sessionId: string }) =>
      describe(await resolveSessionCompactionModel(options, sessionId)),
    setCompactionTrigger: async (input: {
      readonly sessionId: string;
      readonly value: AutoCompactWindowSetting;
    }) => {
      if (input.value !== 'auto' && !isValidAutoCompactWindowTokens(input.value)) {
        throw new Error('autoCompactWindow must be an integer token count above 1 or "auto".');
      }
      const model = await resolveSessionCompactionModel(options, input.sessionId);
      await updateLocalAutoCompactWindow({
        modelKey: formatModelKey(model.selection.providerId, model.selection.modelId),
        value: input.value,
      });
      return describe(model);
    },
  };
}

interface SessionCompactionModel {
  readonly selection: NonNullable<ReturnType<typeof readCompactionModelSelection>>;
  readonly llm: Awaited<ReturnType<ProductionAgentPreparation['resolveModel']>>;
}

async function resolveSessionCompactionModel(
  options: CompactionTriggerApplicationOptions,
  sessionId: string,
): Promise<SessionCompactionModel> {
  const session = await options.sessions.getExecutionSnapshot(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const agent = await readSessionAgentExecutionSnapshot(options.agents, session);
  if (!agent) throw new Error(`Agent not found: ${session.agentName}`);
  const agentConfig = await options.preparation.buildAgentConfig({
    session,
    agent,
    isSessionFirstTurn: false,
  });
  const selection = readCompactionModelSelection(agentConfig);
  if (!selection) throw new Error(`Session ${sessionId} has no resolved model.`);
  const llm = await options.preparation.resolveModel({
    sessionId,
    turnId: `${sessionId}:compaction-trigger`,
    agentConfig,
  });
  return { selection, llm };
}
