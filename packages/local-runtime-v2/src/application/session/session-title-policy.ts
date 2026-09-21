import {
  SAFETY_SCENE,
  type ContentSafetyService,
} from "../../service/content-safety/index.js";
import type { LocalRuntimeConfig } from "../../service/model-system/index.js";
import type {
  SessionAgentDefinition,
  SessionRecord,
  SessionRecordServiceDeps,
} from "../../service/session-system/index.js";
import { isUnmanagedConfigModel } from "../config-field-review-policy.js";

/** Local CLI metadata follows the selected provider, without requiring inference credentials. */
export function createSessionTitlePolicy(input: {
  readonly runtimeOwnerKind?: string;
  readonly config: () => LocalRuntimeConfig;
  readonly safety: ContentSafetyService;
  readonly readDefinition: (
    sessionId: string,
  ) => Promise<SessionAgentDefinition | undefined>;
}): SessionRecordServiceDeps["titlePolicy"] {
  return {
    blocks: async (title, session) => {
      if (!title.trim()) return false;
      if (
        input.runtimeOwnerKind === "tui" ||
        input.runtimeOwnerKind === "cli"
      ) {
        const config = input.config();
        const model = await selectedModel(
          session,
          config,
          input.readDefinition,
        );
        if (isUnmanagedConfigModel(config, model)) return false;
      }
      // Missing/ambiguous provider context retains the existing gate, as do all
      // managed routes. In particular, auth and local errors still block.
      return input.safety.blocks(title, SAFETY_SCENE.ConfigField);
    },
  };
}

async function selectedModel(
  session: SessionRecord,
  config: LocalRuntimeConfig,
  readDefinition: (
    sessionId: string,
  ) => Promise<SessionAgentDefinition | undefined>,
): Promise<string | undefined> {
  if (session.sessionKind === "task") {
    const binding = await readDefinition(session.sessionId);
    if (binding?.definition.definitionVersion !== 2) return undefined;
    const { providerId, modelId } = binding.definition.model;
    return `${providerId}/${modelId}`;
  }
  return session.effectiveModel ?? config.defaultModel;
}
