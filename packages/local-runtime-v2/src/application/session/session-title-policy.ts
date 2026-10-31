import { resolveProviderAuthMode } from "@mavis/config";

import {
  SAFETY_SCENE,
  type ContentSafetyService,
} from "../../service/content-safety/index.js";
import {
  isLegacyMinimaxProvider,
  parseSourceQualifiedModelKey,
  type LocalRuntimeConfig,
} from "../../service/model-system/index.js";
import type {
  SessionAgentDefinition,
  SessionRecord,
  SessionRecordServiceDeps,
} from "../../service/session-system/index.js";

/**
 * Whether a Session title goes to content review follows the Session's selected model:
 * a BYOK model skips it, the same as Desktop, TUI and CLI, without requiring inference
 * credentials.
 */
export function createSessionTitlePolicy(input: {
  readonly config: () => LocalRuntimeConfig;
  readonly safety: ContentSafetyService;
  readonly readDefinition: (
    sessionId: string,
  ) => Promise<SessionAgentDefinition | undefined>;
}): SessionRecordServiceDeps["titlePolicy"] {
  return {
    blocks: async (title, session) => {
      if (!title.trim()) return false;
      const config = input.config();
      const model = await selectedModel(
        session,
        config,
        input.readDefinition,
      );
      if (model && isUnmanagedProvider(config, model)) return false;
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
): Promise<ReturnType<typeof parseSourceQualifiedModelKey>> {
  // A channel (IM) Session follows its bound Agent's model, which is not recorded on the
  // Session; the exact model is unknown here, so it keeps going through review.
  if (session.sessionKind === "channel") return undefined;
  if (session.sessionKind === "task") {
    const binding = await readDefinition(session.sessionId);
    if (binding?.definition.definitionVersion !== 2) return undefined;
    const { providerId, modelId } = binding.definition.model;
    return parseSourceQualifiedModelKey(`${providerId}/${modelId}`);
  }
  return parseSourceQualifiedModelKey(
    session.effectiveModel ?? config.defaultModel,
  );
}

function isUnmanagedProvider(
  config: LocalRuntimeConfig,
  model: NonNullable<ReturnType<typeof parseSourceQualifiedModelKey>>,
): boolean {
  if (isLegacyMinimaxProvider(config, model.providerId)) return false;
  if (model.source === "minimax_api") return true;
  if (model.source === "custom_provider") {
    const provider = config.custom_provider?.[model.providerKey];
    return provider !== undefined && provider.enabled !== false;
  }
  if (
    model.providerId === "minimax" &&
    config.minimaxModelSource === "minimax_api_key"
  )
    return true;
  const provider = config.provider?.[model.providerId];
  return (
    provider !== undefined &&
    resolveProviderAuthMode(provider.options).authMode !== "managed-login"
  );
}
