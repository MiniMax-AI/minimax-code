/**
 * Turn-local, in-process view of what each tool call of a turn actually carried: the argument
 * object the agent issued and the result the model receives. {@link EventBridge} records into it
 * before any display sanitization; a host reads it lazily after it has committed the frame that
 * names the call. It holds references only, copies nothing, and never enters a RuntimeEvent,
 * snapshot, persistence or telemetry.
 */

/** The tool result as the model receives it. */
export interface ToolCallModelOutput {
  /** The result's text blocks joined with `\n`; absent when it has none. */
  readonly text?: string;
  /**
   * Every content block of the result in order, inline binary (base64) included. Present only
   * when the model also received a non-text block, such as an image.
   */
  readonly result?: readonly unknown[];
}

export interface ToolCallContentAccessor {
  /** The argument object exactly as the agent issued it; no redaction or truncation. */
  input(): unknown;
  /** The final result; `undefined` until the call has ended. */
  output(): ToolCallModelOutput | undefined;
}

interface ToolCallRecord {
  readonly args: unknown;
  ended: boolean;
  result?: unknown;
}

/**
 * Created by the host when a turn starts and closed when it ends or aborts; after `close` every
 * lookup misses and further records are ignored. One registry spans every attempt of the turn.
 */
export class TurnToolCallContent {
  private records: Map<string, ToolCallRecord> | undefined = new Map();

  /** Called by the bridge at `tool_execution_start`. */
  recordStart(toolCallId: string, args: unknown): void {
    this.records?.set(toolCallId, { args, ended: false });
  }

  /** Called by the bridge once the call has its final (post-hook) result. */
  recordEnd(toolCallId: string, result: unknown): void {
    const record = this.records?.get(toolCallId);
    if (!record) return;
    record.ended = true;
    record.result = result;
  }

  get(toolCallId: string): ToolCallContentAccessor | undefined {
    const record = this.records?.get(toolCallId);
    if (!record) return undefined;
    return {
      input: () => record.args,
      output: () => (record.ended ? modelOutput(record.result) : undefined),
    };
  }

  release(toolCallId: string): void {
    this.records?.delete(toolCallId);
  }

  close(): void {
    this.records = undefined;
  }
}

function modelOutput(result: unknown): ToolCallModelOutput {
  const content = isRecord(result) ? result['content'] : undefined;
  if (!Array.isArray(content)) return {};
  const texts: string[] = [];
  let hasNonText = false;
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      texts.push(block['text']);
    } else {
      hasNonText = true;
    }
  }
  return {
    ...(texts.length > 0 ? { text: texts.join('\n') } : {}),
    ...(hasNonText ? { result: content as readonly unknown[] } : {}),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}
