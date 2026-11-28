/**
 * `buildMessagesVideoPatcher` — pi-ai `onPayload` hook that flips
 * `image` content blocks whose source MIME starts with `video/` into
 * `video` content blocks before the HTTP request leaves local-runtime.
 *
 * **Why this exists**
 *
 * pi-ai's modality enum is `('text' | 'image')[]` — there is no `video`
 * input slot. Local-runtime carries video attachments (either
 * user-attached in the inbound message or produced by the `read` tool
 * on a video file) as `ImageContent` records with `mimeType=video/*` so
 * they ride the same multimodal codepath as images; pi-ai then
 * serializes them into the Messages API as standard `image` content
 * blocks (`{type:'image', source:{media_type:'video/...'}}`).
 *
 * The official endpoint rejects video media types in image blocks (HTTP 400).
 * DashScope and other Messages-compatible providers
 * accept a `video` block with the same `source` shape but `type:'video'`.
 * This patcher rewrites just the `type` discriminator on blocks whose
 * `source.media_type` starts with `video/`, leaving everything else
 * untouched.
 *
 * **Relation to cloud-runtime**
 *
 * This is a byte-for-byte functional twin of
 * `packages/cloud-runtime/src/host/pi-session/messages-video-patcher.ts`.
 * The two runtimes do not currently share a runtime-patcher package (the
 * openplatform-thinking-patcher pair has already diverged), so we keep
 * a local copy instead of reaching across package boundaries. If you
 * change the payload rewrite rule, update both files.
 *
 * **Wire safety**
 *
 * - Patcher returns the (mutated) payload only when at least one block
 *   actually changed; otherwise returns `undefined` so pi-ai keeps the
 *   original reference (no copy on the no-op path).
 * - `model` argument is read for `api` identification — the patcher
 *   only fires when the resolved model uses the fixed Messages-compatible API discriminator.
 *   Other providers (openai-chat, ...) pass through unchanged.
 * - Failure-open: if the payload doesn't match the expected Messages
 *   shape, patcher returns undefined without throwing — better to ship
 *   the unmodified payload than to crash the LLM call.
 *
 * **Capability gate**
 *
 * Caller installs this patcher only when the active model declares
 * `support_video=true` on its capabilities. Without that gate, a model
 * may receive video blocks and return HTTP 400; with it,
 * the gate ensures the model is one of the providers (DashScope, etc.)
 * that accept the rewritten `video` block.
 */

import type { Api, Model } from '@earendil-works/pi-ai';
import { isRecord } from './payload-shape.js';

/**
 * Build a payload patcher that flips Messages image blocks with
 * `video/*` media type into `video` blocks.
 *
 * Returned function shape matches pi-ai `SimpleStreamOptions['onPayload']`:
 * `(payload: unknown, model: Model<Api>) => unknown | undefined`.
 *
 * Returns `undefined` on:
 *   - non-Messages api
 *   - payload that doesn't match `{messages: [...]}` shape
 *   - no `image` block has a `video/*` source (no-op turn)
 */
export function buildMessagesVideoPatcher() {
  return function patchMessagesVideoBlocks(
    payload: unknown,
    model: Model<Api>,
  ): unknown | undefined {
    if (model.api !== 'anthropic-messages') return undefined;
    if (!isMessagesPayload(payload)) return undefined;

    let mutated = false;
    for (const message of payload.messages) {
      if (!message || !Array.isArray(message.content)) continue;
      mutated = patchContentBlocks(message.content) || mutated;
    }
    return mutated ? payload : undefined;
  };
}

function patchContentBlocks(blocks: unknown[]): boolean {
  let mutated = false;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const b = block;
    if (b.type === 'image' && isVideoSource(b.source)) {
      // flip image -> video; source / media_type / data left untouched
      // (DashScope and similar Messages-compatible providers accept this shape)
      b.type = 'video';
      mutated = true;
    }
    if (Array.isArray(b.content)) {
      mutated = patchContentBlocks(b.content) || mutated;
    }
  }
  return mutated;
}

function isVideoSource(source: unknown): boolean {
  if (!isRecord(source)) return false;
  const mediaType = source.media_type;
  return typeof mediaType === 'string' && mediaType.startsWith('video/');
}

/**
 * Defensive runtime shape check — pi-ai gives us `unknown`, so refuse
 * any payload that doesn't look like the Messages request body.
 */
function isMessagesPayload(
  payload: unknown,
): payload is { messages: Array<{ content?: unknown[] } | null> } {
  if (!isRecord(payload)) return false;
  const messages = payload.messages;
  return Array.isArray(messages);
}
