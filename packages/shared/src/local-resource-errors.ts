/**
 * Local machine resource exhaustion, as reported in the `errorKind` label of
 * `pi_turn_failure_total` and `pi_llm_logical_call_total`.
 *
 * The kind is decided by the underlying Node.js system error code, never by
 * message text, so the same exhaustion reports the same value whether it
 * surfaced on the LLM path or while persisting a turn.
 */
export const LOCAL_RESOURCE_ERROR_KINDS = [
  'local_disk_full',
  'local_fd_exhausted',
  'local_out_of_memory',
] as const;

export type LocalResourceErrorKind = (typeof LOCAL_RESOURCE_ERROR_KINDS)[number];

const LOCAL_RESOURCE_ERROR_KIND_BY_CODE: ReadonlyMap<string, LocalResourceErrorKind> = new Map([
  ['ENOSPC', 'local_disk_full'],
  ['EDQUOT', 'local_disk_full'],
  ['EMFILE', 'local_fd_exhausted'],
  ['ENFILE', 'local_fd_exhausted'],
  ['ENOMEM', 'local_out_of_memory'],
]);

const MAX_ERROR_DEPTH = 4;
const MAX_ERRORS_VISITED = 32;

export function isLocalResourceErrorKind(value: string): value is LocalResourceErrorKind {
  return (LOCAL_RESOURCE_ERROR_KINDS as readonly string[]).includes(value);
}

/**
 * The local resource an error ran out of, read from the system error `code`
 * of the error, its `cause` / `error` chain, or the `errors` of an
 * AggregateError. Bounded, never throws, and reads own data properties only,
 * so it never runs a getter.
 */
export function classifyLocalResourceError(error: unknown): LocalResourceErrorKind | undefined {
  const queue: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: error, depth: 0 },
  ];
  const seen = new Set<object>();
  while (seen.size < MAX_ERRORS_VISITED) {
    const item = queue.shift();
    if (!item) break;
    const { value, depth } = item;
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    const code = ownDataProperty(value, 'code');
    const kind = typeof code === 'string' ? LOCAL_RESOURCE_ERROR_KIND_BY_CODE.get(code) : undefined;
    if (kind) return kind;
    if (depth >= MAX_ERROR_DEPTH) continue;
    for (const next of nestedErrors(value)) queue.push({ value: next, depth: depth + 1 });
  }
  return undefined;
}

function nestedErrors(value: object): unknown[] {
  const errors = ownDataProperty(value, 'errors');
  return [
    ownDataProperty(value, 'cause'),
    ownDataProperty(value, 'error'),
    ...(Array.isArray(errors) ? errors.slice(0, MAX_ERRORS_VISITED) : []),
  ];
}

function ownDataProperty(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
