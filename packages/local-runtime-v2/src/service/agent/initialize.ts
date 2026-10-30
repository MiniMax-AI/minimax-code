import type { AppDb } from '../../infra/db/client.js';
import { DrizzleAgentRepository } from './storage/agent.repository.js';
import {
  LocalAgentService,
  type LegacyCustomAgentMaterializationEvent,
} from './application/agent.service.js';
import type { LegacyIdentityDetachEvent } from './application/_migration-legacy-identity-detach.js';
import type { BuiltinAgentConfigRepairReporter } from './application/config/builtin-canonical-files.js';
import type { AgentSystemFactCallbacks } from './contracts.js';
import { LocalPromptFileReader } from '../prompt-config/index.js';

export interface AgentRuntimeOwner {
  readonly service: LocalAgentService;
  /** Shared encrypted-template cache; PromptConfigService reuses this instance. */
  readonly promptFileReader: LocalPromptFileReader;
  close(): void;
}

export function createAgentRuntimeOwner(input: {
  readonly database: AppDb;
  readonly promptMode?: 'tui' | 'coding' | 'work';
  readonly promptVersion?: string;
  readonly dataDir: string;
  readonly nowMs?: () => number;
  readonly facts?: AgentSystemFactCallbacks;
  readonly reportIdentityDetach?: (event: LegacyIdentityDetachEvent) => void;
  readonly reportLegacyCustomMaterialization?: (
    event: LegacyCustomAgentMaterializationEvent,
  ) => void;
  readonly reportBuiltinConfigRepair?: BuiltinAgentConfigRepairReporter;
}): AgentRuntimeOwner {
  const promptFileReader = new LocalPromptFileReader();
  const repository = new DrizzleAgentRepository({
    db: input.database,
    dataDir: input.dataDir,
    facts: input.facts,
  });
  const service = new LocalAgentService({
    repository,
    promptFileReader,
    ...(input.promptMode
      ? { promptMode: input.promptMode, promptVersion: input.promptVersion }
      : {}),
    ...(input.nowMs ? { nowMs: input.nowMs } : {}),
    ...(input.facts ? { facts: input.facts } : {}),
    ...(input.reportIdentityDetach ? { reportIdentityDetach: input.reportIdentityDetach } : {}),
    ...(input.reportLegacyCustomMaterialization
      ? { reportLegacyCustomMaterialization: input.reportLegacyCustomMaterialization }
      : {}),
    ...(input.reportBuiltinConfigRepair
      ? { reportBuiltinConfigRepair: input.reportBuiltinConfigRepair }
      : {}),
  });
  let closed = false;
  return {
    service,
    promptFileReader,
    close: () => {
      if (closed) return;
      closed = true;
      service.close();
    },
  };
}
