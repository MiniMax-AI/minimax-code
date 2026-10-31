/**
 * What the mavis `session messages` command returns to the model and to
 * run_code programs, for the local and the cloud source alike.
 *
 * A stored message keeps every tool result in full, and one run_code child
 * result can be megabytes, so a page is projected field by field before
 * anything serializes or token-counts it: message text stays whole, each tool
 * call becomes a summary, and an opt-in body is copied only as a prefix of at
 * most `max_output_chars`. The desktop UI reads its own message API, not
 * this one.
 */

export const SESSION_MESSAGES_DEFAULT_OUTPUT_CHARS = 2_000;
export const SESSION_MESSAGES_MAX_OUTPUT_CHARS = 20_000;
const ARGS_PREVIEW_CHARS = 200;

export interface SessionMessagesView {
  readonly includeToolOutputs: boolean;
  readonly includeThinking: boolean;
  /** Cap for each returned tool args, tool result and thinking text. */
  readonly maxOutputChars: number;
}

export function sessionMessagesView(args: {
  readonly include_tool_outputs?: boolean;
  readonly include_thinking?: boolean;
  readonly max_output_chars?: number;
}): SessionMessagesView {
  return {
    includeToolOutputs: args.include_tool_outputs === true,
    includeThinking: args.include_thinking === true,
    maxOutputChars: Math.min(
      args.max_output_chars ?? SESSION_MESSAGES_DEFAULT_OUTPUT_CHARS,
      SESSION_MESSAGES_MAX_OUTPUT_CHARS,
    ),
  };
}

/** Copied as stored: local display rows use snake_case, the cloud reader camelCase. */
const MESSAGE_FIELDS = [
  'msg_id',
  'msgId',
  'parent_msg_id',
  'parentMsgId',
  'turn_id',
  'turnId',
  'role',
  'msg_type',
  'msgType',
  'kind',
  'timestamp',
  'msg_content',
  'msgContent',
  'msg_content_source',
  'finish_reason',
  'source',
  'source_message_id',
  'origin',
  // Failure reasons: a preparation_error row has empty msg_content, and a
  // compaction_failed row says why only in error.
  'preparation_error',
  'error',
] as const;
/** Why an undelivered message failed; its input copy (text, attachments) stays out. */
const UNDELIVERED_FIELDS = ['reason', 'failure', 'failed_at_ms'] as const;
/**
 * Attachment metadata only; inline data (data_url / dataUrl, any data: URL)
 * never leaves. A row holds the flat shape (snake_case, camelCase on an
 * undelivered copy) or the structured { meta, local, cloud } shape the desktop
 * composer writes (user-message-commit-service toStructuredDisplayAttachment).
 */
const FLAT_ATTACHMENT_FIELDS = [
  'type',
  'file_name',
  'file_path',
  'mime_type',
  'desktop_path',
  'asset_id',
  'fileName',
  'filePath',
  'mimeType',
  'desktopPath',
  'assetId',
] as const;
const STRUCTURED_ATTACHMENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  meta: ['attachmentType', 'fileName', 'mimeType', 'sizeBytes'],
  local: ['assetId', 'filePath', 'desktopPath', 'driveNodeId', 'drivePath'],
  cloud: ['uploadId', 'driveNodeId', 'url', 'objectKey'],
};
const TOOL_CALL_FIELDS = ['tool_name', 'tool_call_id', 'parent_tool_call_id'] as const;
/** ToolCallStatus (agent-core protocol) as words. */
const TOOL_CALL_STATUS: Readonly<Record<number, string>> = {
  1: 'running',
  2: 'completed',
  3: 'failed',
  4: 'preparing',
  5: 'prepared',
};

type JsonRecord = Record<string, unknown>;

export function projectSessionMessagesPage<T extends { readonly messages?: readonly unknown[] }>(
  page: T,
  view: SessionMessagesView,
): Omit<T, 'messages'> & { messages?: JsonRecord[] } {
  const { messages, ...rest } = page;
  if (!Array.isArray(messages)) return rest;
  return {
    messages: messages.filter(isRecord).map((message) => projectMessage(message, view)),
    ...rest,
  };
}

function projectMessage(message: JsonRecord, view: SessionMessagesView): JsonRecord {
  const projected = pick(message, MESSAGE_FIELDS);
  if (view.includeThinking) {
    const thinking = storedText(message.thinking_content);
    if (thinking)
      Object.assign(projected, cut(thinking, view.maxOutputChars, 'thinking_content', 'thinking'));
  }
  const attachments = records(message.attachments).map(projectAttachment);
  if (attachments.length > 0) projected.attachments = attachments;
  const toolCalls = records(message.tool_calls).map((call) => projectToolCall(call, view));
  if (toolCalls.length > 0) projected.tool_calls = toolCalls;
  const undelivered = isRecord(message.undelivered)
    ? pick(message.undelivered, UNDELIVERED_FIELDS)
    : {};
  if (Object.keys(undelivered).length > 0) projected.undelivered = undelivered;
  return projected;
}

function projectAttachment(attachment: JsonRecord): JsonRecord {
  const projected = pickMetadata(attachment, FLAT_ATTACHMENT_FIELDS);
  for (const [part, keys] of Object.entries(STRUCTURED_ATTACHMENT_FIELDS)) {
    const value = attachment[part];
    if (!isRecord(value)) continue;
    const metadata = pickMetadata(value, keys);
    if (Object.keys(metadata).length > 0) projected[part] = metadata;
  }
  return projected;
}

function projectToolCall(call: JsonRecord, view: SessionMessagesView): JsonRecord {
  const projected = pick(call, TOOL_CALL_FIELDS);
  const status = toolCallStatus(call.tool_call_status);
  if (status !== undefined) projected.status = status;
  const args = storedText(call.tool_call_args);
  if (args !== undefined) {
    Object.assign(
      projected,
      view.includeToolOutputs
        ? cut(args, view.maxOutputChars, 'args', 'args')
        : { args_preview: prefix(args, ARGS_PREVIEW_CHARS), args_chars: args.length },
    );
  }
  const result = storedText(call.tool_call_result_data);
  if (result !== undefined) {
    Object.assign(
      projected,
      view.includeToolOutputs
        ? cut(result, view.maxOutputChars, 'result', 'result')
        : { result_chars: result.length },
    );
  }
  return projected;
}

/** The text, its full length, and a truncated flag when only a prefix fits. */
function cut(text: string, max: number, field: string, name: string): JsonRecord {
  if (text.length <= max) return { [field]: text, [`${name}_chars`]: text.length };
  return {
    [field]: prefix(text, max),
    [`${name}_chars`]: text.length,
    [`${name}_truncated`]: true,
  };
}

/** At most max UTF-16 units, never ending inside a surrogate pair. */
function prefix(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * Display rows store args and results as JSON text. A row that kept an
 * object (older writers) is serialized on its own, one field at a time.
 */
function storedText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value);
}

function toolCallStatus(value: unknown): string | undefined {
  if (typeof value === 'number') return TOOL_CALL_STATUS[value] ?? String(value);
  return typeof value === 'string' ? value : undefined;
}

function pick(source: JsonRecord, keys: readonly string[]): JsonRecord {
  const picked: JsonRecord = {};
  for (const key of keys) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

/** Scalar metadata only: a nested object or a data: URL could carry inline content. */
function pickMetadata(source: JsonRecord, keys: readonly string[]): JsonRecord {
  const picked: JsonRecord = {};
  for (const key of keys) {
    const value = source[key];
    if (isMetadataValue(value)) picked[key] = value;
  }
  return picked;
}

function isMetadataValue(value: unknown): boolean {
  if (typeof value === 'string') return !/^data:/iu.test(value.trimStart());
  return typeof value === 'number' || typeof value === 'boolean';
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
