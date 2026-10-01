import type { TuiStreamEvent } from '../../../runtime/stream-events.js';

interface OutputSample {
  outputTokens: number;
  decodeDurationMs: number;
}

/** Provider output divided by summed decode time, matching DeepSeek Harness turn metrics. */
export class TuiTurnOutputRate {
  private turnId: string | undefined;
  private readonly samples = new Map<string, OutputSample>();
  private value: number | undefined;

  beginTurn(turnId: string): void {
    this.reset();
    this.turnId = turnId;
  }

  apply(turnId: string, event: TuiStreamEvent): number | undefined {
    if (
      turnId !== this.turnId ||
      event.type !== 'message' ||
      event.message.role !== 'assistant' ||
      !event.message.id ||
      event.message.kind
    )
      return this.value;
    const outputTokens = event.message.usage?.outputTokens;
    const decodeDurationMs = event.message.usage?.decodeDurationMs;
    // Missing timing is not a zero-duration sample and must not use the full request duration.
    if (!nonnegativeFinite(outputTokens) || !nonnegativeFinite(decodeDurationMs)) return this.value;
    this.samples.set(event.message.id, { outputTokens, decodeDurationMs });
    let tokens = 0;
    let duration = 0;
    for (const sample of this.samples.values()) {
      tokens += sample.outputTokens;
      duration += sample.decodeDurationMs;
    }
    const rate = duration > 0 ? tokens / (duration / 1_000) : undefined;
    this.value = nonnegativeFinite(rate) && rate > 0 ? rate : undefined;
    return this.value;
  }

  finalize(): number | undefined {
    return this.value;
  }

  current(): number | undefined {
    return this.value;
  }

  currentEstimated(): boolean | undefined {
    return this.value === undefined ? undefined : false;
  }

  reset(): void {
    this.turnId = undefined;
    this.samples.clear();
    this.value = undefined;
  }
}

function nonnegativeFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
