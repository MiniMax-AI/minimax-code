import type { ContextCompactionLifecycleMetadata } from './contracts.js';
import { isRecord, readCompactionLifecycleMetadata } from './context-compaction.js';

type CompactionCommitMetadata =
  | {
      readonly compactionId: string;
      readonly method: 'tool_archive' | 'tool_trim';
      readonly summary: string;
      readonly replacementSourceIndexes: readonly number[];
      readonly currentUserSourceIndex?: number;
      readonly placedMarkerCount?: number;
    }
  | {
      readonly compactionId: string;
      readonly method: 'llm_checkpoint';
      readonly summary: string;
      readonly currentUserSourceIndex?: number;
      readonly placedMarkerCount?: number;
    };

/** Placement-owned current-user tail: source lineage plus the hidden markers before it. */
interface CurrentUserTailMetadata {
  readonly currentUserSourceIndex: number;
  readonly placedMarkerCount: number;
}

export function readCompactionCommitMetadata(value: unknown): CompactionCommitMetadata | undefined {
  const lifecycle = readCompactionLifecycleMetadata(value);
  if (!lifecycle || !isRecord(value)) return undefined;
  const summary = Reflect.get(value, 'summary');
  if (typeof summary !== 'string') return undefined;
  const tail = readOptionalCurrentUserTail(value, lifecycle);
  if (tail === null) return undefined;
  return lifecycle.method === 'llm_checkpoint'
    ? readCheckpointCommitMetadata(lifecycle, summary, tail)
    : readToolResultCommitMetadata(value, lifecycle, summary, tail);
}

function readCheckpointCommitMetadata(
  lifecycle: ContextCompactionLifecycleMetadata,
  summary: string,
  tail: CurrentUserTailMetadata | undefined,
): CompactionCommitMetadata | undefined {
  // Native summary, optional owned mode, then the exact markers + external user tail.
  if (
    tail !== undefined &&
    lifecycle.messagesAfter !== 2 + tail.placedMarkerCount &&
    lifecycle.messagesAfter !== 3 + tail.placedMarkerCount
  )
    return undefined;
  return Object.freeze({
    compactionId: lifecycle.compactionId,
    method: 'llm_checkpoint',
    summary,
    ...currentUserTailFields(tail),
  });
}

function readToolResultCommitMetadata(
  value: Readonly<Record<PropertyKey, unknown>>,
  lifecycle: ContextCompactionLifecycleMetadata,
  summary: string,
  tail: CurrentUserTailMetadata | undefined,
): CompactionCommitMetadata | undefined {
  if (lifecycle.method === 'llm_checkpoint') return undefined;
  const replacementSourceIndexes = Reflect.get(value, 'replacementSourceIndexes');
  const expectedSourceCount =
    tail === undefined
      ? lifecycle.messagesAfter
      : lifecycle.messagesAfter - 1 - tail.placedMarkerCount;
  if (
    !Array.isArray(replacementSourceIndexes) ||
    expectedSourceCount < 0 ||
    replacementSourceIndexes.length !== expectedSourceCount ||
    !replacementSourceIndexes.every(
      (index, position) =>
        Number.isSafeInteger(index) &&
        index >= 0 &&
        index < lifecycle.messagesBefore &&
        index !== tail?.currentUserSourceIndex &&
        (position === 0 || index > replacementSourceIndexes[position - 1]),
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    compactionId: lifecycle.compactionId,
    method: lifecycle.method,
    summary,
    replacementSourceIndexes: Object.freeze([...replacementSourceIndexes]) as readonly number[],
    ...currentUserTailFields(tail),
  });
}

function currentUserTailFields(
  tail: CurrentUserTailMetadata | undefined,
): Partial<CurrentUserTailMetadata> {
  return tail === undefined
    ? {}
    : {
        currentUserSourceIndex: tail.currentUserSourceIndex,
        placedMarkerCount: tail.placedMarkerCount,
      };
}

/**
 * Reads the placement-owned tail lineage. `placedMarkerCount` defaults to 1 so
 * metadata persisted before multi-marker placement stays readable; it is
 * invalid without `currentUserSourceIndex`. Returns null for invalid input.
 */
function readOptionalCurrentUserTail(
  value: Readonly<Record<PropertyKey, unknown>>,
  lifecycle: { readonly messagesBefore: number },
): CurrentUserTailMetadata | undefined | null {
  const hasMarkerCount = Object.hasOwn(value, 'placedMarkerCount');
  if (!Object.hasOwn(value, 'currentUserSourceIndex')) return hasMarkerCount ? null : undefined;
  const index = Reflect.get(value, 'currentUserSourceIndex');
  if (!isSourceIndexInRange(index, lifecycle.messagesBefore)) return null;
  if (!hasMarkerCount) return { currentUserSourceIndex: index, placedMarkerCount: 1 };
  const count = Reflect.get(value, 'placedMarkerCount');
  return isPositiveSafeInteger(count)
    ? { currentUserSourceIndex: index, placedMarkerCount: count }
    : null;
}

function isSourceIndexInRange(value: unknown, messagesBefore: number): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < messagesBefore
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
