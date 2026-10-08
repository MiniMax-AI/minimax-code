import type { RunawayGuardOverride } from '@mavis/config';
import type {
  CreateLocalRuntimeHostOptions as V1CreateLocalRuntimeHostOptions,
  CreatedLocalRuntimeHost as V1CreatedLocalRuntimeHost,
  LocalRuntimeProductHostOptions as V1LocalRuntimeProductHostOptions,
} from '@mavis/local-runtime';
import type { LocalBrowserAdapter, LocalBrowserToolExposure } from '@mavis/agent-tools/desktop';
import type {
  MiniAppPresenter,
  LocalRuntimeApplication,
  LocalRuntimePendingPermission,
} from '../application/session/process-local-application-contract.js';

export type { LocalRuntimeAuthContext, LocalRuntimeConfig } from '@mavis/local-runtime';

/** Process-local DTO; runtime.ts checks compatibility with the DB-owned observation. */
type DatabaseMigrationObservation = {
  readonly startedAtEpochMs: number;
  readonly pendingMigrationCount: number;
} & (
  | { readonly phase: 'started' }
  | { readonly phase: 'completed' | 'failed'; readonly durationMs: number }
);

/** Process-local DTO for durable ToolResult compaction thresholds. */
interface ToolResultCompactionConfig {
  readonly enabled?: boolean;
  /** Per-result pre-History safety fuse. Independent from enabled. */
  readonly maxInlineBytes?: number;
  /** Raw MCP detail fuse applied after Plugin hooks and before History. */
  readonly mcpDetailsMaxInlineBytes?: number;
  readonly watermarkBytes?: number;
  readonly minSavingsBytes?: number;
  readonly minCandidateBytes?: number;
  readonly keepRecentRounds?: number;
}

/** `customPrompt` replaces the main-Agent identity prompt; `appendSystemPrompt` follows it. */
interface LocalRuntimeSystemPromptOverrides {
  readonly customPrompt?: string;
  readonly appendSystemPrompt?: string;
}

/** Product-facing options owned by the Runtime V2 process-local host. */
interface LocalRuntimeProductHostOptions extends V1LocalRuntimeProductHostOptions {
  /** Best-effort DB upgrade observations; never awaited by startup. */
  onDatabaseMigration?: (event: DatabaseMigrationObservation) => undefined;
  configSource?: 'default' | 'explicit';
  miniAppSurface?: MiniAppPresenter;
  /** Raw product provider consumed directly by the V2 Browser Use owner. */
  browserAdapter?: LocalBrowserAdapter;
  browserToolExposure?: LocalBrowserToolExposure;
  /** Optional live config source; missing/invalid fields retain runtime defaults. */
  readonly getRunawayGuardConfig?: () => RunawayGuardOverride | undefined;
  getToolResultCompactionConfig?: () => ToolResultCompactionConfig | undefined;
  promptConfigKey?: Uint8Array;
  /** Selects a complete package-local mode template and freezes prompt assets for this process. */
  promptMode?: 'tui' | 'coding' | 'work';
  /** Launch-scoped main-Agent prompt overrides; held in process memory and never persisted. */
  systemPromptOverrides?: LocalRuntimeSystemPromptOverrides;
}

/** Runtime V2 host options after process-local compatibility wiring. */
interface CreateLocalRuntimeHostOptions extends V1CreateLocalRuntimeHostOptions {
  /** Best-effort DB upgrade observations; never awaited by startup. */
  onDatabaseMigration?: (event: DatabaseMigrationObservation) => undefined;
  configSource?: 'default' | 'explicit';
  miniAppSurface?: MiniAppPresenter;
  browserAdapter?: LocalBrowserAdapter;
  browserToolExposure?: LocalBrowserToolExposure;
  /** Optional live config source; missing/invalid fields retain runtime defaults. */
  readonly getRunawayGuardConfig?: () => RunawayGuardOverride | undefined;
  getToolResultCompactionConfig?: () => ToolResultCompactionConfig | undefined;
  promptConfigKey?: Uint8Array;
  /** Selects a complete package-local mode template and freezes prompt assets for this process. */
  promptMode?: 'tui' | 'coding' | 'work';
  /** Launch-scoped main-Agent prompt overrides; held in process memory and never persisted. */
  systemPromptOverrides?: LocalRuntimeSystemPromptOverrides;
}

/** Runtime V2 owner host with its process-local application facade. */
interface CreatedLocalRuntimeHost extends V1CreatedLocalRuntimeHost {
  application?: LocalRuntimeApplication;
  cliService?: import('./cli-service.js').CliService;
}

export type {
  CreateLocalRuntimeHostOptions,
  CreatedLocalRuntimeHost,
  LocalRuntimeApplication,
  LocalRuntimePendingPermission,
  LocalRuntimeProductHostOptions,
  ToolResultCompactionConfig,
};
