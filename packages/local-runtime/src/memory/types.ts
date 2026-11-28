export const LOCAL_MEMORY_TOPIC_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface LocalMemoryConfig {
  dataDir: string;
  enabled?: boolean;
}

export type LocalMemoryScope = 'user' | 'agent';

/**
 * How a local-runtime memory call is addressed. Local agents have no i64
 * snowflake — only their on-disk directory name — so agent scope is keyed by
 * `agentName` (the `agents/<agentName>/` directory) rather than a numeric id.
 */
export type LocalMemoryTarget = { scope: 'user' } | { scope: 'agent'; agentName: string };

export interface LocalMemoryLocation {
  scope: LocalMemoryScope;
  agentName?: string;
  memoryDir: string;
  mainPath: string;
}

export interface LocalMemoryReadResult {
  content: string;
  sizeBytes: number;
  updatedAt?: string;
  brief?: string;
}

export interface LocalMemorySearchResult {
  lineNumber: number;
  line: string;
  context?: string[];
}

export interface LocalMemoryTopicEntry {
  name: string;
  description: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface LocalMemoryDailyEntry {
  date: string;
  sizeBytes: number;
  brief?: string;
  archived: boolean;
}

export interface LocalMemoryArchiveEntry {
  snapshotDate: string;
  fileName: string;
  sizeBytes: number;
}

export interface LocalMemoryUnremindedEntry {
  sessionId: string;
  agentName: string;
  wroteMemory: boolean;
  reminded: boolean;
  checkedAt: string;
  lastReflectedAt?: string;
}

export class LocalMemoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LocalMemoryError';
  }
}

export type LocalMemoryEventEmitter = (type: string, payload: Record<string, unknown>) => void;
