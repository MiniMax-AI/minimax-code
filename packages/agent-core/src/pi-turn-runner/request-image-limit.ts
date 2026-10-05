import type { Api, Message, Model } from '@earendil-works/pi-ai';

/**
 * Default ceiling on images in one provider request when the model declares
 * none (`capabilities.max_images_per_request`).
 *
 * Inline images live in persisted history and every request re-sends the whole
 * provider-visible history, so without a request-level ceiling a long session
 * eventually exceeds the provider's per-request image limit. Every following
 * request then fails the same way and the session cannot recover (#425: a
 * gateway rejected `Too many images in request: 31 > 30`).
 *
 * 20 stays below the smallest general-purpose limit seen in practice — the
 * gateway in #425 rejects more than 30 — with headroom for gateways that count
 * images differently, and far below Anthropic (100 per request) and OpenAI
 * (500). It still keeps the attachments of the last five turns (at most four
 * inline images per user message) in view. Providers with a smaller limit set
 * `max_images_per_request` on the model; Mistral's API (8) is recognized by
 * host, see `knownMaxImagesPerRequestForBaseUrl`.
 */
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 20;

/**
 * Optional request limit carried on the resolved model object, so every
 * request builder that receives the model (agent turns, compaction
 * checkpoints, footprint measurement) applies the same ceiling.
 */
export interface ModelRequestImageLimit {
  readonly maxImagesPerRequest?: number;
}

/** Normalize a configured image ceiling; anything but a positive integer is ignored. */
export function normalizeMaxImagesPerRequest(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Documented per-request image limits for first-party API hosts whose limit is
 * below the default. Matched on the exact hostname so gateways that merely
 * proxy these models keep the default unless they declare their own.
 */
const KNOWN_HOST_IMAGE_LIMITS: ReadonlyMap<string, number> = new Map([
  // Mistral Vision FAQ (docs.mistral.ai/capabilities/vision): "The maximum number
  // images per request via API is 8."
  ['api.mistral.ai', 8],
]);

/** Known image ceiling for a first-party API base URL, if it is below the default. */
export function knownMaxImagesPerRequestForBaseUrl(baseUrl: string | undefined): number | undefined {
  if (!baseUrl) return undefined;
  try {
    return KNOWN_HOST_IMAGE_LIMITS.get(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return undefined;
  }
}

/** Image ceiling for requests to `model`: its declared limit, else the default. */
export function resolveMaxImagesPerRequest(model: Model<Api> | undefined): number {
  const declared = normalizeMaxImagesPerRequest(
    (model as (Model<Api> & ModelRequestImageLimit) | undefined)?.maxImagesPerRequest,
  );
  return declared ?? DEFAULT_MAX_IMAGES_PER_REQUEST;
}

export interface RequestImageLimitResult {
  readonly messages: Message[];
  /** Number of image blocks replaced by a placeholder in this request copy. */
  readonly omittedCount: number;
}

/**
 * Keep only the newest `maxImages` image blocks across the whole request
 * (user messages and tool results) and replace older ones with a short text
 * placeholder naming the original file when it is known.
 *
 * Operates on the temporary provider request copy only; canonical history is
 * never rewritten, so raising the limit (or switching to a model with a higher
 * one) brings the images back.
 */
export function limitRequestImages(
  messages: readonly Message[],
  maxImages: number,
): RequestImageLimitResult {
  const limit = Math.max(0, Math.floor(maxImages));
  let total = 0;
  for (const message of messages) total += imageBlockCount(message);
  if (total <= limit) return { messages: [...messages], omittedCount: 0 };

  let toOmit = total - limit;
  const toolCallPaths = collectToolCallPaths(messages);
  const projected = messages.map((message) => {
    if (toOmit === 0) return message;
    const count = imageBlockCount(message);
    if (count === 0) return message;
    const paths = imagePathsForMessage(message, count, toolCallPaths);
    let imageIndex = 0;
    const content = (message.content as Array<{ type?: unknown }>).map((block) => {
      if (!isImageBlock(block)) return block;
      const path = paths[imageIndex];
      imageIndex += 1;
      if (toOmit === 0) return block;
      toOmit -= 1;
      return { type: 'text' as const, text: omittedImageText(limit, path) };
    });
    return { ...message, content } as Message;
  });
  return { messages: projected, omittedCount: total - limit };
}

function omittedImageText(limit: number, path: string | undefined): string {
  const scope = `this request keeps only the ${limit} most recent images`;
  return path
    ? `[Earlier image omitted: ${scope}. Original file: ${path}]`
    : `[Earlier image omitted: ${scope}.]`;
}

function isImageBlock(block: unknown): boolean {
  return Boolean(block) && typeof block === 'object' && (block as { type?: unknown }).type === 'image';
}

function imageBlockCount(message: Message): number {
  if (!Array.isArray(message.content)) return 0;
  let count = 0;
  for (const block of message.content as unknown[]) if (isImageBlock(block)) count += 1;
  return count;
}

const ATTACHMENT_TAG_OPEN = '<attachment';
const PATH_ARGUMENT_KEYS = ['path', 'file_path', 'filePath'] as const;

function imagePathsForMessage(
  message: Message,
  imageCount: number,
  toolCallPaths: ReadonlyMap<string, string>,
): Array<string | undefined> {
  if (message.role === 'toolResult') {
    const path = toolCallPaths.get(message.toolCallId);
    return imageCount === 1 && path ? [path] : [];
  }
  if (message.role !== 'user' || !Array.isArray(message.content)) return [];
  // Attachment reminders list every attachment of the message in order; inline
  // images are the ones sent as image blocks. Only trust the mapping when the
  // counts agree, otherwise fall back to a placeholder without a path.
  const inlineImagePaths: string[] = [];
  for (const block of message.content) {
    if (block.type !== 'text') continue;
    for (const attributes of attachmentTagAttributes(block.text)) {
      const path = attributes.get('path');
      if (attributes.get('inline') !== 'true' || !path) continue;
      const kind = attributes.get('kind');
      const mime = attributes.get('mime') ?? '';
      if (kind === 'image' || (kind === undefined && mime.startsWith('image/'))) {
        inlineImagePaths.push(path);
      }
    }
  }
  return inlineImagePaths.length === imageCount ? inlineImagePaths : [];
}

function collectToolCallPaths(messages: readonly Message[]): Map<string, string> {
  const paths = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== 'toolCall' || !block.arguments || typeof block.arguments !== 'object') {
        continue;
      }
      for (const key of PATH_ARGUMENT_KEYS) {
        const value: unknown = block.arguments[key];
        if (typeof value === 'string' && value.trim()) {
          paths.set(block.id, value.trim());
          break;
        }
      }
    }
  }
  return paths;
}

/**
 * Attributes of each `<attachment …>` tag in `text`. A linear scan rather than
 * a regular expression, because message text is user-controlled and nested
 * quantifiers over it can backtrack polynomially.
 */
function attachmentTagAttributes(text: string): Array<Map<string, string>> {
  const tags: Array<Map<string, string>> = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(ATTACHMENT_TAG_OPEN, from);
    if (start < 0) break;
    const end = text.indexOf('>', start);
    // No later tag can be closed either.
    if (end < 0) break;
    const next = text.charAt(start + ATTACHMENT_TAG_OPEN.length);
    if (next === '>' || next === '/' || /\s/u.test(next)) {
      tags.push(parseTagAttributes(text.slice(start + ATTACHMENT_TAG_OPEN.length, end)));
    }
    from = end + 1;
  }
  return tags;
}

function parseTagAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let position = 0;
  while (position < source.length) {
    const equals = source.indexOf('="', position);
    if (equals < 0) break;
    const close = source.indexOf('"', equals + 2);
    if (close < 0) break;
    let nameStart = equals;
    while (nameStart > position && isAttributeNameChar(source.charCodeAt(nameStart - 1))) {
      nameStart -= 1;
    }
    if (nameStart < equals) {
      attributes.set(source.slice(nameStart, equals), unescapeAttribute(source.slice(equals + 2, close)));
    }
    position = close + 1;
  }
  return attributes;
}

/** `[a-z_]`, matching the attribute names the attachment reminder writes. */
function isAttributeNameChar(code: number): boolean {
  return (code >= 97 && code <= 122) || code === 95;
}

function unescapeAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
