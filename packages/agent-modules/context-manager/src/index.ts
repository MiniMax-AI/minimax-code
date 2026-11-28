export { ContextManager } from './manager.js';
export { countProjectedReplayMessages } from './replay-token-counting.js';
export { computeCompactionTriggerAt, DEFAULT_CONTEXT_MANAGER_SETTINGS } from './settings.js';
export {
  isValidCompactionTriggerSetting,
  resolveCompactionTokenBudget,
  resolveConfiguredCompactionTrigger,
  resolveSegmentCompactionBudget,
  type SegmentCompactionTokenBudget,
  type SegmentForegroundBudget,
  type SegmentRebuildShares,
  resolveDynamicMaxTokens,
} from './provider-budget.js';
export {
  BpeTokenEstimator,
  createDefaultContextTokenEstimator,
  createDefaultTokenEstimator,
  type ContextTokenEstimate,
  type EncodeFn,
  type TokenEstimator,
} from './token-estimator.js';
export {
  countMessagesWithVisualPricing,
  estimateImageBlockTokens,
  estimateMiniMaxMVisualTokensForDimensions,
  estimateVisualTokensForDimensions,
  FALLBACK_IMAGE_TOKENS,
  messagesContainImageData,
  parseImageDimensionsFromBase64,
  type ImageTokenEstimateOptions,
  type VisualPricingModel,
} from './visual-token-pricing.js';
export {
  measureSkillCatalogDescriptionTokens,
  normalizeSkillCatalogDescription,
  normalizeSkillUsageKey,
  renderLocalSkillsCatalogResult,
  resolveSkillCatalogBudgetTokens,
  SKILL_NAME_ONLY_NOTICE,
  skillCatalogDescription,
  type LocalSkillCatalogTokenEstimator,
  type LocalSkillsCatalogEntry,
  type LocalSkillsCatalogRenderOptions,
  type LocalSkillsCatalogRenderResult,
  type SkillCatalogUsage,
  type SkillCatalogUsageMap,
} from './skill-catalog.js';
export {
  buildCountTokensRequestBody,
  cjkFallbackTokens,
  cjkFallbackTokensForBody,
  estimateCharsToTokensCjkAware,
  type CountTokensRequestBody,
  type CountTokensTool,
} from './count-tokens-body.js';
export {
  estimatePreparedContextUsage,
  readContextWindowTokens,
  type PreparedContextUsageEstimate,
} from './context-usage-estimator.js';
export type {
  ContextCompactionDecision,
  ContextCompactionFailedEvent,
  ContextCompactionPlan,
  ContextCompactionSkippedEvent,
  ContextCompactionCommittedEvent,
  ContextManagerLock,
  ContextManagerCheckpointOptions,
  ContextManagerObserver,
  ContextManagerOptions,
  ContextManagerSettings,
  ContextSummaryGenerator,
  ContextTokenCount,
  ContextTokenCounter,
  ContextTriggerEvaluatedEvent,
} from './types.js';
export {
  acquireImageDecode,
  configureImageDecoding,
  IMAGE_DECODE_DEFER_REASONS,
  IMAGE_DECODE_SKIP_REASONS,
  imageDecodeLimits,
  imageDecodeStats,
  isImageDecodeDeferral,
  recordImageDecodeSkipped,
  type ImageDecodeDeferReason,
  type ImageDecodeDeferral,
  type ImageDecodeLease,
  type ImageDecodeLimits,
  type ImageDecodeSkipReason,
  type ImageDecodeStats,
} from './image-decode-gate.js';
export {
  boundRequestMedia,
  checkpointImageText,
  DEFAULT_REQUEST_IMAGE_ENCODING,
  encodeRequestImage,
  encodeRequestImageBlocks,
  encodeRequestImageDetails,
  isRequestMediaRejection,
  omittedRequestImageText,
  PROVIDER_IMAGE_MAX_BASE64_BYTES,
  resolveRequestMediaBudget,
  selectRequestImages,
  type EncodedRequestImage,
  type EncodedRequestImageDetails,
  type RequestImageEncoding,
  type RequestMediaBudget,
  withoutThinking,
} from './request-media.js';
export {
  decideOutputLimitRecovery,
  DEFAULT_OUTPUT_LIMIT_MAX_RETRIES,
  OUTPUT_LIMIT_EXHAUSTED_REASON,
  OUTPUT_LIMIT_RETRY_REASON,
  type OutputLimitRecoveryDecision,
} from './output-limit.js';

export function archivedImageText(mimeType = 'image'): string {
  return `[Archived image (${mimeType}) omitted during compaction]`;
}
