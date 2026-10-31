import type {
  ConversationPluginAgentDefinition,
  ConversationTaskModelSelection,
  RuntimeConversation,
} from '@mavis/conversation-contract';
import type { MetricsClient } from '../common/metrics.js';
import type { LocalBashCompletion } from '../runtime/bash-completion-correlation.js';
import type { AgentReferenceResolver } from '../agent/port.js';
import type { SubagentTelemetryHost } from '../agent/subagent-telemetry.js';
import type { LocalBackgroundTaskService } from '../background-task/service.js';
import type { LocalRuntimeConfig } from '../config/types.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import type { LocalRuntimeApiHostOptions } from './host-helpers.js';

/** Product capabilities used by Task and background Bash adapters. */
export interface LocalTaskRunnerHost extends SubagentTelemetryHost {
  readonly agentResolver: AgentReferenceResolver;
  readonly runtimeConversation?: RuntimeConversation;
  readonly agentRoutes: {
    createSession(input: {
      agentName?: string;
      workspaceDir: string;
      sessionType?: 'root' | 'branch';
      sessionKind?: 'task';
      title?: string | null;
      parentSessionId?: string | null;
      visibility?: 'visible' | 'hidden';
      purpose?: string;
      runLocation?: LocalSessionRecord['runLocation'];
      appMode?: LocalSessionRecord['appMode'];
      isDefaultWorkspace?: LocalSessionRecord['isDefaultWorkspace'];
      effectiveModel?: LocalSessionRecord['effectiveModel'];
      effectiveModelVariant?: LocalSessionRecord['effectiveModelVariant'];
      taskModelSelection?: ConversationTaskModelSelection;
      pluginAgentDefinition?: ConversationPluginAgentDefinition;
    }): Promise<LocalSessionRecord>;
    listLocalAgents(): Promise<Array<{ name: string; displayName: string }>>;
  };
  readonly backgroundTaskService: LocalBackgroundTaskService;
  readonly metricsClient?: MetricsClient;
  readonly matrixLogger?: LocalRuntimeApiHostOptions['matrixLogger'];
  readonly recordSessionBashCompletion?: (
    sessionId: string,
    completion: LocalBashCompletion,
  ) => void;
  configGetter(): LocalRuntimeConfig;
  nowMs(): number;
  resolveDefaultWorkspaceDir(): string;
}

export interface LocalTaskRunnerHostWithSessionLookup extends LocalTaskRunnerHost {
  getSessionById(sessionId: string): Promise<LocalSessionRecord | undefined>;
}

export function requireTaskConversation(host: LocalTaskRunnerHost): RuntimeConversation {
  if (!host.runtimeConversation) {
    throw new Error('Local task execution requires the Session V2 RuntimeConversation');
  }
  return host.runtimeConversation;
}
