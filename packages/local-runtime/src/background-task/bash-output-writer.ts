import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';
import type { TaskOutputReadResult, TaskOutputRef } from './domain.js';
import type { LocalBackgroundBashExecutorResult } from './bash-executor.js';

const OUTPUT_READ_CHUNK_BYTES = 64 * 1024;
const ERROR_OUTPUT_PREFIX_CHARS = 64 * 1024;
const INITIAL_RECOVERY_RETRY_MS = 100;
const MAX_RECOVERY_RETRY_MS = 5_000;
const MAX_RECOVERY_CHARS = 1024 * 1024;
const TERMINAL_REPAIR_ATTEMPTS = 3;
const TERMINAL_REPAIR_DELAY_MS = 25;

export class BackgroundBashOutputWriter {
  outputBytes = 0;
  streamedOutput = false;
  streamedTextForError = '';

  private lastOutputRef: TaskOutputRef | undefined;
  private pendingContent = '';
  private drainPromise: Promise<void> | undefined;
  private rawOutputAccounting = false;
  private persistenceIncomplete = false;
  private recoveryOffset = 0;
  private recoveryContent = '';
  private droppedRecoveryBytes = 0;
  private omittedBytes = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryDelayMs = INITIAL_RECOVERY_RETRY_MS;
  private settling = false;

  constructor(
    private readonly host: LocalTaskRunnerHostWithSessionLookup,
    private readonly ownerSessionId: string,
    private readonly taskId: string,
  ) {}

  readonly push = (content: string, byteLength?: number): void => {
    if (byteLength !== undefined) this.rawOutputAccounting = true;
    this.outputBytes += byteLength ?? Buffer.byteLength(content, 'utf8');
    if (!content) return;
    this.streamedOutput = true;
    if (this.streamedTextForError.length < ERROR_OUTPUT_PREFIX_CHARS) {
      this.streamedTextForError += content.slice(
        0,
        ERROR_OUTPUT_PREFIX_CHARS - this.streamedTextForError.length,
      );
    }
    if (this.persistenceIncomplete) this.queueRecovery(content);
    else this.pendingContent += content;
    this.startDrain();
  };

  async settleSuccess(
    result: LocalBackgroundBashExecutorResult,
  ): Promise<TaskOutputRef | undefined> {
    this.beginSettlement();
    await this.flush();
    if (!this.streamedOutput && !this.rawOutputAccounting) {
      const facts = result.details?.output as { rawBytes?: number } | undefined;
      this.outputBytes = facts?.rawBytes ?? Buffer.byteLength(result.text, 'utf8');
    }
    if (!this.persistenceIncomplete) {
      return this.lastOutputRef ?? (await this.appendTerminalOutput(result.text));
    }
    try {
      return await this.repairPendingOutput();
    } catch (error) {
      this.warn('repair', error);
      return this.lastOutputRef;
    }
  }

  async settleFailure(content: string): Promise<TaskOutputRef | undefined> {
    this.beginSettlement();
    await this.flush();
    if (this.persistenceIncomplete) {
      try {
        const repaired = await this.repairPendingOutput();
        return (await this.appendTerminalOutput(content)) ?? repaired;
      } catch (error) {
        this.warn('repair', error);
        return this.lastOutputRef;
      }
    }
    return this.appendTerminalOutput(content);
  }

  describePersistence(outputRef?: TaskOutputRef): {
    rawBytes: number;
    persistence: 'complete' | 'incomplete';
    omittedBytes: number;
  } {
    return {
      rawBytes: this.outputBytes,
      persistence:
        !this.persistenceIncomplete && this.omittedBytes === 0 && outputRef
          ? 'complete'
          : 'incomplete',
      omittedBytes: this.omittedBytes,
    };
  }

  private startDrain(): void {
    // Once the bounded window overflows, defer its omission marker until the
    // executor settles. This freezes the byte count while it is persisted and
    // keeps ambiguous "append succeeded, response failed" retries prefix-safe.
    if (this.drainPromise || this.retryTimer || (!this.settling && this.droppedRecoveryBytes > 0))
      return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined;
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.persistenceIncomplete) {
        if (!this.settling && this.droppedRecoveryBytes > 0) return;
        try {
          const outputRef = await this.repairPendingOutput();
          if (outputRef) this.lastOutputRef = outputRef;
        } catch (error) {
          this.warn('repair', error);
          this.scheduleRetry();
          return;
        }
        continue;
      }
      if (!this.pendingContent) return;
      const content = this.pendingContent;
      this.pendingContent = '';
      const outputRef = await this.tryAppend(content, 'stdout');
      if (outputRef) this.lastOutputRef = outputRef;
      else {
        this.persistenceIncomplete = true;
        this.recoveryOffset = this.lastOutputRef?.offset ?? 0;
        this.queueRecovery(content);
        this.queueRecovery(this.pendingContent);
        this.pendingContent = '';
      }
    }
  }

  private async flush(): Promise<void> {
    this.startDrain();
    await this.drainPromise;
  }

  private beginSettlement(): void {
    this.settling = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private scheduleRetry(): void {
    if (this.settling || this.retryTimer || this.droppedRecoveryBytes > 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.startDrain();
    }, this.retryDelayMs);
    this.retryTimer.unref?.();
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RECOVERY_RETRY_MS);
  }

  private queueRecovery(content: string): void {
    if (!content) return;
    const availableChars =
      this.droppedRecoveryBytes > 0
        ? 0
        : Math.max(0, MAX_RECOVERY_CHARS - this.recoveryContent.length);
    let retained = content.slice(0, availableChars);
    if (retained && isHighSurrogate(retained.charCodeAt(retained.length - 1))) {
      retained = retained.slice(0, -1);
    }
    this.recoveryContent += retained;
    const droppedBytes = Math.max(
      0,
      Buffer.byteLength(content, 'utf8') - Buffer.byteLength(retained, 'utf8'),
    );
    this.droppedRecoveryBytes += droppedBytes;
    this.omittedBytes += droppedBytes;
  }

  warn(operation: string, error: unknown): void {
    try {
      this.host.matrixLogger?.warn(
        { sessionId: this.ownerSessionId, turnId: this.taskId },
        `Failed to ${operation} background bash output: ${formatError(error)}`,
      );
    } catch {
      // Diagnostics must not turn a recoverable persistence failure into a
      // runner failure after the command has already settled.
    }
  }

  private async repairPendingOutput(): Promise<TaskOutputRef | undefined> {
    const recoveryContent = this.recoveryContent;
    const droppedRecoveryBytes = this.droppedRecoveryBytes;
    const expectedContent = recoveryContent + formatDroppedOutputMarker(droppedRecoveryBytes);
    const persisted = await readAllTaskOutput(this.host, this.taskId, this.recoveryOffset);
    let repaired = persisted.outputRef ?? this.lastOutputRef;
    if (!expectedContent.startsWith(persisted.content)) {
      throw new Error('persisted output is not a prefix of the pending bash output');
    }
    if (persisted.content !== expectedContent) {
      repaired = await this.tryAppend(
        expectedContent.slice(persisted.content.length),
        'final_result',
      );
      if (!repaired) {
        const afterRetry = await readAllTaskOutput(this.host, this.taskId, this.recoveryOffset);
        if (afterRetry.content !== expectedContent) {
          throw new Error('pending bash output suffix could not be persisted');
        }
        repaired = afterRetry.outputRef ?? this.lastOutputRef;
      }
    }
    this.recoveryContent = this.recoveryContent.slice(recoveryContent.length);
    this.droppedRecoveryBytes = Math.max(0, this.droppedRecoveryBytes - droppedRecoveryBytes);
    this.lastOutputRef = repaired ?? this.lastOutputRef;
    this.recoveryOffset =
      repaired?.offset ?? this.recoveryOffset + Buffer.byteLength(expectedContent, 'utf8');
    this.persistenceIncomplete = this.recoveryContent.length > 0 || this.droppedRecoveryBytes > 0;
    this.retryDelayMs = INITIAL_RECOVERY_RETRY_MS;
    return this.lastOutputRef;
  }

  private async appendTerminalOutput(content: string): Promise<TaskOutputRef | undefined> {
    const appended = await this.tryAppend(content, 'final_result');
    if (appended) {
      this.lastOutputRef = appended;
      return appended;
    }

    this.persistenceIncomplete = true;
    this.recoveryOffset = this.lastOutputRef?.offset ?? this.recoveryOffset;
    this.recoveryContent = content;
    this.droppedRecoveryBytes = 0;
    for (let attempt = 0; attempt < TERMINAL_REPAIR_ATTEMPTS; attempt += 1) {
      try {
        return await this.repairPendingOutput();
      } catch (error) {
        this.warn('repair terminal', error);
        if (attempt + 1 < TERMINAL_REPAIR_ATTEMPTS) {
          await delay(TERMINAL_REPAIR_DELAY_MS * 2 ** attempt);
        }
      }
    }
    return this.lastOutputRef;
  }

  private async tryAppend(
    content: string,
    stream: 'stdout' | 'final_result',
  ): Promise<TaskOutputRef | undefined> {
    try {
      return await this.host.backgroundTaskService.appendOutput({
        taskId: this.taskId,
        stream,
        content,
        timestamp: this.host.nowMs(),
      });
    } catch (error) {
      this.warn('persist', error);
      return undefined;
    }
  }
}

async function readAllTaskOutput(
  host: LocalTaskRunnerHostWithSessionLookup,
  taskId: string,
  initialOffset = 0,
): Promise<Pick<TaskOutputReadResult, 'content' | 'outputRef'>> {
  const chunks: string[] = [];
  let offset = initialOffset;
  let outputRef: TaskOutputRef | undefined;
  for (;;) {
    const read = await host.backgroundTaskService.readOutput(taskId, {
      offset,
      limitBytes: OUTPUT_READ_CHUNK_BYTES,
    });
    chunks.push(read.content);
    outputRef = read.outputRef ?? outputRef;
    const nextOffset = read.nextOffset ?? offset + Buffer.byteLength(read.content, 'utf8');
    if (!read.truncated || nextOffset <= offset) return { content: chunks.join(''), outputRef };
    offset = nextOffset;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDroppedOutputMarker(droppedBytes: number): string {
  return droppedBytes > 0
    ? `\n<bash_status>Output persistence was unavailable; omitted ${droppedBytes} bytes.</bash_status>\n`
    : '';
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
