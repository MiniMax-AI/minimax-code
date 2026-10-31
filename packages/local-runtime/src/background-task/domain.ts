import { randomUUID } from 'node:crypto';

export type BackgroundTaskKind = 'bash' | 'subagent' | 'workflow' | 'custom';
export type BackgroundTaskStatus =
  | 'queued'
  | 'running'
  | 'stopping'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'lost';

export interface TaskError {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

export interface TaskUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  metadata?: Record<string, unknown>;
}

export type TaskOutputKind = 'file' | 'oss' | 'sandbox_job' | 'session_transcript' | 'memory';
export type TaskOutputStream = 'stdout' | 'stderr' | 'transcript' | 'final_result';

export interface TaskOutputRef {
  taskId: string;
  kind: TaskOutputKind;
  uri: string;
  offset?: number;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface TaskOutputChunk {
  taskId: string;
  stream?: TaskOutputStream;
  content: string;
  offset?: number;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface TaskOutputReadOptions {
  offset?: number;
  limitBytes?: number;
  stream?: TaskOutputStream;
}

export interface TaskOutputReadResult {
  content: string;
  nextOffset?: number;
  truncated?: boolean;
  summary?: string;
  outputRef?: TaskOutputRef;
}

export interface TaskOutputStore {
  append(chunk: TaskOutputChunk): Promise<TaskOutputRef>;
  read(taskId: string, options?: TaskOutputReadOptions): Promise<TaskOutputReadResult>;
  tail(taskId: string, limitBytes?: number): Promise<TaskOutputReadResult>;
  finalize(taskId: string, summary?: string): Promise<void>;
}

export interface BackgroundTask {
  taskId: string;
  kind: BackgroundTaskKind;
  status: BackgroundTaskStatus;
  ownerSessionId: string;
  description?: string;
  toolCallId?: string;
  parentMessageId?: string;
  parentTaskId?: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  /**
   * Idempotent result-delivery/consumption latch. Automatic completion notices
   * leave it unset; a committed task_output read or foreground synchronous
   * result delivery confirms consumption.
   */
  deliveredAt?: number;
  outputRef?: TaskOutputRef;
  lastError?: TaskError;
  usage?: TaskUsage;
  metadata?: Record<string, unknown>;
}

export type BackgroundTaskPatch = Partial<
  Omit<BackgroundTask, 'taskId' | 'kind' | 'ownerSessionId' | 'createdAt'>
>;

export interface TaskQuery {
  taskIds?: string[];
  ownerSessionId?: string;
  parentTaskId?: string | null;
  kinds?: BackgroundTaskKind[];
  statuses?: BackgroundTaskStatus[];
  createdAfter?: number;
  createdBefore?: number;
  updatedAfter?: number;
  updatedBefore?: number;
  limit?: number;
  cursor?: string;
  orderBy?: 'created_at' | 'updated_at' | 'completed_at';
  order?: 'asc' | 'desc';
  includeArchived?: boolean;
  undeliveredOnly?: boolean;
}

export interface TaskListResult {
  items: BackgroundTask[];
  nextCursor?: string;
}

export interface BackgroundTaskReminderSnapshot {
  readonly tasks: readonly BackgroundTask[];
  readonly undeliveredTotal: number;
  readonly terminalTotal: number;
}

export const BACKGROUND_TASK_CHECKPOINT_DETAILS_HINT =
  'Call task_query for the live task list, then task_output(task_id) for progress or results.';

export interface BackgroundTaskCheckpointItem {
  readonly taskId: string;
  readonly status: BackgroundTaskStatus;
  readonly agentName?: string;
  readonly executionMode?: 'foreground' | 'background' | 'append';
  readonly updatedAtMs: number;
  readonly delivered: boolean;
  readonly description?: string;
  readonly lastError?: string;
  readonly finalResultPreview?: string;
}

export interface BackgroundTaskCheckpointSnapshot {
  readonly capturedAtMs: number;
  readonly total: number;
  readonly counts: Readonly<Record<BackgroundTaskStatus, number>>;
  readonly omitted: number;
  readonly textFieldsAreUntrusted: true;
  readonly detailsHint: typeof BACKGROUND_TASK_CHECKPOINT_DETAILS_HINT;
  readonly items: readonly BackgroundTaskCheckpointItem[];
}

export type TaskLifecycleEventType =
  | 'created'
  | 'started'
  | 'output_updated'
  | 'stop_requested'
  | 'status_changed'
  | 'completed';

export interface TaskLifecycleEvent {
  eventId: string;
  taskId: string;
  ownerSessionId: string;
  type: TaskLifecycleEventType;
  timestamp: number;
  sequence?: number;
  payload?: Record<string, unknown>;
}

export interface TaskStore {
  create(task: BackgroundTask): Promise<BackgroundTask>;
  get(taskId: string): Promise<BackgroundTask | undefined>;
  list(query: TaskQuery): Promise<TaskListResult>;
  /** One database snapshot of all nonterminal tasks, without offset pagination. */
  snapshotPending(): Promise<BackgroundTask[]>;
  reminderSnapshot(ownerSessionId: string, limit?: number): Promise<BackgroundTaskReminderSnapshot>;
  patch(taskId: string, patch: BackgroundTaskPatch): Promise<BackgroundTask>;
  updateStatus(
    taskId: string,
    status: BackgroundTaskStatus,
    reason?: string,
  ): Promise<BackgroundTask>;
  appendEvent(event: TaskLifecycleEvent): Promise<void>;
}

export class BackgroundTaskError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BackgroundTaskError';
  }
}

export class TaskNotFoundError extends BackgroundTaskError {
  constructor(taskId: string) {
    super(`Background task not found: ${taskId}`, 'TASK_NOT_FOUND', { taskId });
    this.name = 'TaskNotFoundError';
  }
}

export class TaskAlreadyExistsError extends BackgroundTaskError {
  constructor(taskId: string) {
    super(`Background task already exists: ${taskId}`, 'TASK_ALREADY_EXISTS', { taskId });
    this.name = 'TaskAlreadyExistsError';
  }
}

export class InvalidTaskStatusTransitionError extends BackgroundTaskError {
  constructor(taskId: string, from: BackgroundTaskStatus, to: BackgroundTaskStatus) {
    super(
      `Invalid background task status transition for ${taskId}: ${from} -> ${to}`,
      'INVALID_TASK_STATUS_TRANSITION',
      { taskId, from, to },
    );
    this.name = 'InvalidTaskStatusTransitionError';
  }
}

export function createBackgroundTaskId(): string {
  return `bg_${randomUUID()}`;
}

export function createTaskLifecycleEventId(): string {
  return `bge_${randomUUID()}`;
}

export function isTerminalTaskStatus(status: BackgroundTaskStatus): boolean {
  return ['succeeded', 'failed', 'canceled', 'lost'].includes(status);
}

export function canTransitionTaskStatus(
  from: BackgroundTaskStatus,
  to: BackgroundTaskStatus,
): boolean {
  if (from === to) return true;
  if (isTerminalTaskStatus(from)) return false;
  switch (from) {
    case 'queued':
      return ['running', 'stopping', 'succeeded', 'failed', 'canceled', 'lost'].includes(to);
    case 'running':
      return ['stopping', 'succeeded', 'failed', 'canceled', 'lost'].includes(to);
    case 'stopping':
      return ['succeeded', 'failed', 'canceled', 'lost'].includes(to);
    default:
      return false;
  }
}

export function normalizeTaskError(error: unknown, fallbackCode = 'TASK_ERROR'): TaskError {
  if (error instanceof BackgroundTaskError) {
    return {
      message: error.message,
      code: error.code,
      details: error.details,
    };
  }
  if (error instanceof Error) {
    // Stack frames stay on the server log; TaskError is returned over HTTP.
    return {
      message: error.message,
      code: fallbackCode,
    };
  }
  return {
    message: String(error),
    code: fallbackCode,
  };
}
