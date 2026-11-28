import type { IModelCapabilities } from '@mavis/protocol';

import {
  MatrixImagesUnderstandToolDef,
  MatrixVideosUnderstandToolDef,
} from '../cloud/matrix-tools/tool-defs.js';

/**
 * Model capability → concrete tool suppression table.
 *
 * Tool authorization still starts from `agent_config.tools[]`; this table only
 * narrows redundant model-assist tools when the active model can natively
 * consume that modality. Model switches are explicit turn-level capability
 * changes, so the per-turn tool snapshot should reflect the current model's
 * real effective surface instead of keeping stale fallback tools around.
 *
 * Shared by both cloud-runtime (`packages/cloud-runtime/src/tools/index.ts`)
 * and local-runtime (`packages/harness/src/agent-host/assembly/local-turn-tool-catalog.ts`)
 * so the two runtimes apply the same gate against the same `IModelCapabilities`
 * shape.
 */
const MODEL_CAPABILITY_SUPPRESSED_TOOL_NAMES = {
  supportImage: [MatrixImagesUnderstandToolDef.name],
  supportVideo: [MatrixVideosUnderstandToolDef.name],
} as const;

export function getSuppressedToolNamesForModelCapabilities(
  capabilities: IModelCapabilities | undefined,
): Set<string> {
  const suppressed = new Set<string>();
  if (capabilities?.support_image === true) {
    for (const name of MODEL_CAPABILITY_SUPPRESSED_TOOL_NAMES.supportImage) suppressed.add(name);
  }
  if (capabilities?.support_video === true) {
    for (const name of MODEL_CAPABILITY_SUPPRESSED_TOOL_NAMES.supportVideo) suppressed.add(name);
  }
  return suppressed;
}
