import type { Api, Model } from '@earendil-works/pi-ai';

/**
 * Optional flag on the resolved model object: whether the model's signed
 * thinking is bound to the exact preceding conversation (system prompt, tools
 * and every earlier message). A resolver that knows the model sets it from the
 * model configuration (`capabilities.thinking_prefix_binding`).
 */
export interface ModelThinkingPrefixBinding {
  readonly thinkingPrefixBinding?: boolean;
}

// Model id marker of the Messages API model family, escaped like other vendor
// names in this repo.
const PREFIX_BOUND_MODEL_ID = /\x63\x6c\x61\x75\x64\x65/iu;

/**
 * True when changing anything before an assistant turn invalidates that turn's
 * signed thinking. Every request builder protects such a model in one of two
 * ways, both decided here:
 *
 * - Keep the request prefix unchanged: no request-only image placeholders and
 *   no compaction triggered by request bytes alone, so images leave history
 *   only when a compaction replaces it.
 * - When a request necessarily has another prefix (the isolated checkpoint
 *   request has its own system prompt and no tools), drop the thinking whose
 *   signature can no longer verify.
 *
 * The flag declared on the model wins; without one, the Messages API model
 * family is recognised by its model id (direct, Bedrock or behind a gateway).
 */
export function hasThinkingPrefixBinding(model: Pick<Model<Api>, 'id'> | undefined): boolean {
  if (model === undefined) return false;
  const declared = (model as ModelThinkingPrefixBinding).thinkingPrefixBinding;
  return typeof declared === 'boolean' ? declared : PREFIX_BOUND_MODEL_ID.test(model.id);
}
