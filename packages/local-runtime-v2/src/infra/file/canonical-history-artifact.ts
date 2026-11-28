const ARTIFACT_KEYS = new Set(['schemaVersion', 'generation', 'producedBy', 'parentSnapshot']);
const PARENT_SNAPSHOT_KEYS = new Set(['generation', 'compactionId', 'revision']);

export interface CanonicalHistoryArtifact {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly producedBy: 'tool_archive' | 'tool_trim' | 'llm_checkpoint';
  readonly parentSnapshot: {
    readonly generation: number;
    readonly compactionId: string;
    readonly revision: string;
  };
}

export function decodeCanonicalHistoryArtifact(value: unknown): CanonicalHistoryArtifact {
  const artifact = requirePlainRecord(value, 'history_artifact');
  assertExactKeys(
    artifact,
    ARTIFACT_KEYS,
    ['schemaVersion', 'generation', 'producedBy', 'parentSnapshot'],
    'history_artifact',
  );
  if (artifact['schemaVersion'] !== 1) invalidArtifact();
  const generation = requireGeneration(artifact['generation'], 1);
  const producedBy = requireProducer(artifact['producedBy']);
  const parent = requirePlainRecord(artifact['parentSnapshot'], 'history_artifact.parentSnapshot');
  assertExactKeys(
    parent,
    PARENT_SNAPSHOT_KEYS,
    ['generation', 'compactionId', 'revision'],
    'history_artifact.parentSnapshot',
  );
  const parentGeneration = requireGeneration(parent['generation'], 0);
  if (parentGeneration + 1 !== generation) invalidArtifact();
  return {
    schemaVersion: 1,
    generation,
    producedBy,
    parentSnapshot: {
      generation: parentGeneration,
      compactionId: requireCompactionId(parent['compactionId']),
      revision: requireRevision(parent['revision']),
    },
  };
}

function requirePlainRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    invalidEnvelope(`${context} must be a plain object`);
  }
  return value;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  context: string,
): void {
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) invalidEnvelope(`${context} contains unsupported key ${extra}`);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) invalidEnvelope(`${context} is missing ${missing}`);
}

function requireGeneration(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    invalidArtifact();
  }
  return value;
}

function requireProducer(value: unknown): CanonicalHistoryArtifact['producedBy'] {
  if (value !== 'tool_archive' && value !== 'tool_trim' && value !== 'llm_checkpoint') {
    invalidArtifact();
  }
  return value;
}

function requireCompactionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    invalidArtifact();
  }
  return value;
}

function requireRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) invalidArtifact();
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function invalidArtifact(): never {
  return invalidEnvelope('history_artifact is malformed');
}

function invalidEnvelope(reason: string): never {
  throw new Error(`Canonical history envelope is invalid: ${reason}`);
}
