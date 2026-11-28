/**
 * Turn-level timing pieces shared by the stream composition and the metrics
 * recorder: which request of its turn a model request is, the first effective
 * output of a response, the managed gateway's Server-Timing, and the
 * preparation stages between acceptance and the first request.
 *
 * Everything here is pure or per call; the recorder owns the per-turn marks.
 */

import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';

import type { PiTurnTiming, TurnVisibleTextMark } from './types.js';

/**
 * Which request of its turn a model request is: the turn's first model call
 * (and its transport retries), a later call of the same turn, or a call made by
 * automatic compaction.
 */
export type TurnRequestPhase = 'initial' | 'iteration' | 'compaction';

/** Symbol-keyed phase on stream options; object spread keeps it for every physical attempt. */
export const TURN_REQUEST_PHASE: unique symbol = Symbol('mavis.turnRequestPhase');

export function readTurnRequestPhase(options: unknown): TurnRequestPhase | undefined {
  if (!options || typeof options !== 'object') return undefined;
  const phase: unknown = Reflect.get(options, TURN_REQUEST_PHASE);
  return phase === 'initial' || phase === 'iteration' || phase === 'compaction' ? phase : undefined;
}

/**
 * Stamp every logical call of `inner` with its phase. `phaseOf` runs once per
 * call, outside the retries, so a retried initial request stays `initial`.
 * When the host names a header the phase is also sent; per-call headers win
 * over the model's configured ones, so it reaches every attempt.
 */
export function withTurnRequestPhase(
  inner: StreamFn,
  phaseOf: () => TurnRequestPhase,
  header: string | undefined,
): StreamFn {
  return ((model, context, options) => {
    const phase = phaseOf();
    const stamped = header
      ? { ...options, headers: { ...options?.headers, [header]: phase } }
      : { ...options };
    Object.defineProperty(stamped, TURN_REQUEST_PHASE, {
      value: phase,
      // Enumerable so the object spread of later wrappers keeps it; symbol keys
      // never reach JSON or provider payloads.
      enumerable: true,
    });
    return inner(model, context, stamped);
  }) as StreamFn;
}

/**
 * The first effective output of a response: a non-empty text, thinking or
 * tool-call argument fragment. Block starts never count. It is the check
 * biz-gateway applies (open_platform_direct_support.go); event-bridge
 * `firstTokenMs`, which output throughput relies on, keeps its own rule.
 */
export function isEffectiveOutputEvent(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case 'text_delta':
    case 'thinking_delta':
    case 'toolcall_delta':
      return typeof event.delta === 'string' && event.delta.length > 0;
    default:
      return false;
  }
}

/** biz-gateway time inside the gateway (`gw`) and waiting on its upstream (`up`), in ms. */
export interface GatewayServerTiming {
  readonly gwMs: number;
  readonly upMs: number;
}

const SERVER_TIMING_DURATION = /^dur=(\d+(?:\.\d+)?)$/iu;

/**
 * Parse biz-gateway's `Server-Timing: gw;dur=<ms>, up;dur=<ms>`. A request that
 * failed before reaching upstream carries only `gw`, so `up` is then 0.
 * A missing `gw`, or a `gw` or `up` without one non-negative `dur`, yields
 * undefined. Other metrics in the header are ignored.
 */
export function parseGatewayServerTiming(
  value: string | undefined,
): GatewayServerTiming | undefined {
  if (!value) return undefined;
  const durations = new Map<string, number | undefined>();
  for (const entry of value.split(',')) {
    const [rawName = '', ...params] = entry.split(';');
    const name = rawName.trim().toLowerCase();
    if ((name !== 'gw' && name !== 'up') || durations.has(name)) continue;
    const matches = params.flatMap((param) => {
      const match = SERVER_TIMING_DURATION.exec(param.trim());
      return match ? [Number(match[1])] : [];
    });
    durations.set(name, matches.length === 1 ? matches[0] : undefined);
  }
  const gwMs = durations.get('gw');
  if (gwMs === undefined || (durations.has('up') && durations.get('up') === undefined)) {
    return undefined;
  }
  return { gwMs, upMs: durations.get('up') ?? 0 };
}

/** The value of a response header, matched case-insensitively. */
export function responseHeader(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
  return key === undefined ? undefined : headers[key];
}

/**
 * Upload, network and ingress-proxy time of a managed request: the wait for
 * response headers minus what biz-gateway spent itself and waited on its
 * upstream. Undefined when the timing is missing or the result is negative.
 */
export function managedTransportMs(
  headerWaitMs: number,
  timing: GatewayServerTiming | undefined,
): number | undefined {
  if (!timing || !Number.isFinite(headerWaitMs)) return undefined;
  const transportMs = headerWaitMs - timing.gwMs - timing.upMs;
  return transportMs >= 0 ? transportMs : undefined;
}

/** A fresh {@link TurnVisibleTextMark} for one turn. */
export function createTurnVisibleTextMark(): TurnVisibleTextMark {
  let marked = false;
  let onMark: (() => void) | undefined;
  return {
    mark() {
      if (marked) return;
      marked = true;
      onMark?.();
    },
    bind(next) {
      onMark ??= next;
    },
  };
}

export type TurnPrepareStage =
  | 'accepted'
  | 'assembling'
  | 'preparing'
  | 'persisting'
  | 'dispatching';

/**
 * Contiguous runtime stages from acceptance to the first request, in order.
 * Each stage ends at its mark and the next starts there, so a missing mark
 * drops both stages around it. `dispatching` is dropped when automatic
 * compaction ran before the first request: its time belongs to
 * `compact_duration_ms{trigger="auto"}`.
 */
export function turnPrepareStages(
  timing: PiTurnTiming,
  marks: {
    readonly runningAtMs: number | undefined;
    readonly firstRequestAtMs: number;
    readonly compacted: boolean;
  },
): Array<{ readonly stage: TurnPrepareStage; readonly ms: number }> {
  const ends: ReadonlyArray<readonly [TurnPrepareStage, number | undefined]> = [
    ['accepted', timing.hostStartedAtMs],
    ['assembling', timing.assembledAtMs],
    ['preparing', timing.preparedAtMs],
    ['persisting', marks.runningAtMs],
    ['dispatching', marks.compacted ? undefined : marks.firstRequestAtMs],
  ];
  const stages: Array<{ readonly stage: TurnPrepareStage; readonly ms: number }> = [];
  let startedAtMs: number | undefined = timing.acceptedAtMs;
  for (const [stage, endedAtMs] of ends) {
    const ms =
      startedAtMs === undefined || endedAtMs === undefined ? undefined : endedAtMs - startedAtMs;
    if (ms !== undefined && Number.isFinite(ms) && ms >= 0) stages.push({ stage, ms });
    startedAtMs = endedAtMs;
  }
  return stages;
}
