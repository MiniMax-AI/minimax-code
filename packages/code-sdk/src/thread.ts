import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildExecArgs, validateRunOptions } from './args.js';
import { buildSpawnCommand, type ResolvedCli } from './cli-resolver.js';
import { errorForResult, MCodeAbortError, MCodeProtocolError, ThreadBusyError } from './errors.js';
import { ExecProcess, trackTempDir, untrackTempDir } from './exec-process.js';
import { ItemAccumulator } from './items.js';
import type {
  ExecResult,
  RunOptions,
  StreamedTurn,
  ThreadEvent,
  ThreadOptions,
  Turn,
} from './types.js';

/** What a Thread needs from its owning {@link MCode} client. */
export interface ThreadHost {
  readonly configPath?: string;
  childEnv(): Record<string, string | undefined>;
  prepareCli(): Promise<ResolvedCli>;
}

interface StartedTurn {
  readonly process: ExecProcess;
  readonly items: ItemAccumulator;
  /** Resolves after the process exited, temp files are removed and the Thread is free. */
  readonly released: Promise<void>;
}

/**
 * A conversation with the Agent. The SDK only holds the Session id; every Turn starts a new
 * `mcode exec` process and continues the Session with `--session`.
 */
export class Thread {
  private sessionId: string | null;
  private busy = false;

  constructor(
    private readonly host: ThreadHost,
    private readonly options: ThreadOptions,
    id: string | null,
  ) {
    this.sessionId = id;
  }

  /** Session id. Available after the first event of the first Turn, even if that Turn fails. */
  get id(): string | null {
    return this.sessionId;
  }

  /** Runs one Turn. Resolves only when it succeeds; otherwise rejects with an `MCodeError`. */
  async run(input: string, options: RunOptions = {}): Promise<Turn> {
    const started = await this.start(input, options);
    const { process, items } = started;
    let result: ExecResult | undefined;
    for await (const event of this.stream(started)) {
      if (event.type === 'exec.completed') result = event.result;
    }
    if (!result) throw new MCodeProtocolError('mcode finished without exec.completed.');
    const finalItems = items.items();
    if (result.status !== 'succeeded') {
      throw errorForResult(result, finalItems, {
        exitCode: process.exitCode,
        stderr: process.stderr,
      });
    }
    return {
      status: 'succeeded',
      finalResponse: finalResponseOf(result.output),
      items: finalItems,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.model ? { model: result.model } : {}),
      sessionId: result.sessionId,
      turnId: result.turnId,
      durationMs: result.durationMs,
      result,
    };
  }

  /**
   * Runs one Turn and yields CLI events as they arrive. `turn.failed` is an ordinary event; the
   * iterator throws only for process or protocol failures. Breaking out of the loop cancels the
   * Turn and waits for the CLI to exit.
   */
  async runStreamed(input: string, options: RunOptions = {}): Promise<StreamedTurn> {
    return { events: this.stream(await this.start(input, options)) };
  }

  /** Ends (normally, by error or by `return()`) only after the Turn's resources are released. */
  private async *stream(started: StartedTurn): AsyncGenerator<ThreadEvent, void, undefined> {
    try {
      yield* started.process.events();
    } finally {
      await started.released;
    }
  }

  private async start(input: string, options: RunOptions): Promise<StartedTurn> {
    if (this.busy) throw new ThreadBusyError(this.sessionId);
    this.busy = true;
    let tempDir: string | undefined;
    const release = async (): Promise<void> => {
      this.busy = false;
      if (!tempDir) return;
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      untrackTempDir(tempDir);
    };
    try {
      if (typeof input !== 'string') throw new TypeError('input must be a string.');
      validateRunOptions(options);
      throwIfAborted(options.signal, this.sessionId);
      const cli = await this.host.prepareCli();
      throwIfAborted(options.signal, this.sessionId);
      const promptFiles: { systemPromptFile?: string; appendSystemPromptFile?: string } = {};
      if (
        this.options.systemPrompt !== undefined ||
        this.options.appendSystemPrompt !== undefined
      ) {
        tempDir = await mkdtemp(join(tmpdir(), 'mcode-sdk-'));
        trackTempDir(tempDir);
        if (this.options.systemPrompt !== undefined) {
          promptFiles.systemPromptFile = await writePrivate(
            join(tempDir, 'system-prompt.txt'),
            this.options.systemPrompt,
          );
        }
        if (this.options.appendSystemPrompt !== undefined) {
          promptFiles.appendSystemPromptFile = await writePrivate(
            join(tempDir, 'append-system-prompt.txt'),
            this.options.appendSystemPrompt,
          );
        }
      }
      // The signal may fire while temporary prompt files are written.
      throwIfAborted(options.signal, this.sessionId);
      const env = this.host.childEnv();
      const args = buildExecArgs({
        ...(this.host.configPath === undefined ? {} : { configPath: this.host.configPath }),
        thread: this.options,
        sessionId: this.sessionId,
        run: options,
        ...promptFiles,
      });
      const items = new ItemAccumulator();
      const process = new ExecProcess({
        command: buildSpawnCommand(cli, args),
        env,
        prompt: input,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        onEvent: (event: ThreadEvent) => {
          this.sessionId ??= event.sessionId;
          return items.apply(event);
        },
        items: () => items.items(),
        ...(this.sessionId === null ? {} : { sessionId: this.sessionId }),
      });
      // Started eagerly so an unconsumed runStreamed() still frees the Thread on exit.
      const released = process.done.then(release);
      return { process, items, released };
    } catch (error) {
      // release() never rejects, so the original error is preserved.
      await release();
      throw error;
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined, sessionId: string | null): void {
  if (signal?.aborted) {
    throw new MCodeAbortError('The MCode run was cancelled before it started.', {
      cause: signal.reason,
      ...(sessionId === null ? {} : { sessionId }),
    });
  }
}

async function writePrivate(path: string, content: string): Promise<string> {
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
  return path;
}

function finalResponseOf(output: unknown): string {
  if (typeof output === 'string') return output;
  return output === undefined || output === null ? '' : JSON.stringify(output);
}
