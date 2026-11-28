export type MiniAppFailureStage = 'workspace' | 'runtime' | 'mcp' | 'connector' | 'host';

export type MiniAppFailureRecovery = 'edit_workspace' | 'retry' | 'user_action';

export interface MiniAppFailureDiagnostic {
  readonly stage: MiniAppFailureStage;
  readonly reasonCode: MiniAppFailureReasonCode;
  readonly recovery: MiniAppFailureRecovery;
  readonly hint: string;
}

export interface MiniAppInspectDiagnostics {
  readonly scope: 'host';
  readonly retention: 'runtime-memory';
  readonly failure?: { readonly code: string; readonly message: string };
  readonly run?: {
    readonly runId: string;
    readonly current: boolean;
    readonly preparationStartedAtMs: number;
    readonly readyAtMs?: number;
    readonly exitedAtMs?: number;
    readonly exit?: {
      readonly code: number | null;
      readonly signal: string | null;
      readonly shutdownRequested: boolean;
    };
    readonly failure?: { readonly code: string; readonly message: string };
  };
  readonly logs: {
    readonly entries: readonly {
      readonly sequence: number;
      readonly atMs: number;
      readonly code: string;
      readonly message: string;
    }[];
    readonly truncated: boolean;
    /** Plugin log events excluded from this Host-only view, including raw stdout and stderr. */
    readonly omittedCount: number;
  };
}

interface MiniAppFailureCatalogEntry {
  readonly lifecycleCode: 'PREPARATION_FAILED' | 'PLUGIN_ALREADY_EXISTS';
  readonly stage: MiniAppFailureStage;
  readonly recovery: MiniAppFailureRecovery;
  readonly message: string;
  readonly hint: string;
}

const MINIAPP_FAILURE_CATALOG = {
  OFFICIAL_PLUGIN_READ_ONLY: {
    lifecycleCode: 'PLUGIN_ALREADY_EXISTS',
    stage: 'workspace',
    recovery: 'user_action',
    message: 'Official Plugins do not support local editing or republishing.',
    hint: "Leave the official installation and cache unchanged. With the user's agreement, use a new pluginId and the local Creator workflow to save a local copy.",
  },
  MINIAPP_WORKSPACE_CANDIDATE_MISSING: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'user_action',
    message: 'The Mini App package was not found in the current workspace.',
    hint: 'For a finished package directory, publish with its sourcePath. Use init only when creating or binding a workspace package.',
  },
  MINIAPP_SOURCE_UNAVAILABLE: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'user_action',
    message: 'The supplied Mini App source is missing or cannot be read.',
    hint: 'Check sourcePath and access to the supplied local directory. The workspace package was not used as a fallback.',
  },
  MINIAPP_SOURCE_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'user_action',
    message: 'The supplied source is not a valid, complete Mini App package.',
    hint: 'Provide the complete package directory with its declared runtime files. Report package problems before changing the supplied files.',
  },
  MINIAPP_SOURCE_IDENTITY_MISMATCH: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'user_action',
    message: 'The supplied Mini App package does not match pluginId.',
    hint: 'Use the name declared in the supplied package manifest as pluginId, or select the intended package. Do not rename its manifest to make it match.',
  },
  MINIAPP_SOURCE_OVERLAP: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'user_action',
    message: 'The supplied source overlaps the Mini App installation directory.',
    hint: 'Select a separate directory outside the installed package so publication can preserve the source. To restart the installed version, use restart.',
  },
  WORKSPACE_PLUGIN_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'edit_workspace',
    message: 'The workspace Plugin package is invalid.',
    hint: 'Check .minimax-plugin/plugin.json and the required package files, then publish again.',
  },
  MINIAPP_REFERENCE_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'edit_workspace',
    message: 'package.json does not reference the Mini App manifest correctly.',
    hint: 'For a new package, use mcode.schemaVersion 2 with mcode.miniApp set to ./miniapp/miniapp.json. Preserve an existing V1 mcode.liveboard declaration or transitional V2 mcode.miniApp declaration when it points to ./liveboard/liveboard.json.',
  },
  MINIAPP_MANIFEST_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'edit_workspace',
    message: 'The Mini App manifest is missing, invalid, or uses an unsupported schema.',
    hint: 'Fix the referenced miniapp/miniapp.json or legacy liveboard/liveboard.json and keep its schemaVersion and fields valid.',
  },
  MINIAPP_ARTIFACTS_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'edit_workspace',
    message: 'The Mini App artifact roots are invalid.',
    hint: "Declare existing client and Node artifact roots under the package's declared payload.",
  },
  MINIAPP_RUNTIME_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'runtime',
    recovery: 'edit_workspace',
    message: 'The Mini App runtime declaration is invalid.',
    hint: 'Use a process runtime with a JavaScript entry and a supported lifecycle.',
  },
  MINIAPP_RUNTIME_ENTRY_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'runtime',
    recovery: 'edit_workspace',
    message: 'The Mini App runtime entry is not covered by its Node artifacts.',
    hint: 'Move the entry under a declared artifacts.node root or update artifacts.node.',
  },
  MINIAPP_SURFACE_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'edit_workspace',
    message: 'The Mini App surface declaration is invalid.',
    hint: 'Use a canonical Host-relative path such as /dashboard and, if present, a window block with only the documented whitelisted keys.',
  },
  MINIAPP_MCP_ENDPOINTS_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'mcp',
    recovery: 'edit_workspace',
    message: 'The Mini App MCP endpoint declarations are invalid.',
    hint: 'Use unique Host-relative paths and reference MCP servers declared by the Plugin.',
  },
  MINIAPP_CONNECTOR_ACCESS_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'connector',
    recovery: 'edit_workspace',
    message: 'The Mini App Connector access declaration is invalid.',
    hint: 'Use unique lowercase provider identifiers in permissions.connector (the older hostConnectorAccess.providers reads the same).',
  },
  MINIAPP_AGENT_ACCESS_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'edit_workspace',
    message: 'The Mini App Agent access declaration is invalid.',
    hint: 'Declare the older field as ["session.run", "session.read"] only. The current spelling is permissions: { "agent": ["run"], "session": ["read"] } — run drives the Mini App\'s own Agent turns, read lists and reads the user\'s conversations. Do not mix the two fields.',
  },
  MINIAPP_PERMISSIONS_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'edit_workspace',
    message: 'The Mini App permissions declaration is invalid.',
    hint: 'Declare permissions as one object: { "agent": ["run"], "session": ["read"], "tool": ["call"], "device": ["microphone"], "host": ["navigation.read"], "connector": ["notion"] }. Every key is optional and takes a plain array. Each group names the namespace it opens. Do not combine permissions with the older agentAccess / toolAccess / deviceAccess / hostAccess / hostConnectorAccess fields.',
  },
  MINIAPP_AGENT_CONCURRENCY_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'edit_workspace',
    message: 'The Mini App Agent concurrency declaration is invalid.',
    hint: 'Declare agentConcurrency as an integer from 1 to 32, or omit it for the default of 4.',
  },
  MINIAPP_HOST_ACCESS_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'edit_workspace',
    message: 'The Mini App Host access declaration is invalid.',
    hint: 'Declare hostAccess as a string array containing only navigation.read.',
  },
  MINIAPP_DEVICE_ACCESS_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'edit_workspace',
    message: 'The Mini App device access declaration is invalid.',
    hint: 'Declare deviceAccess as a string array that contains only microphone, camera or notifications.',
  },
  MINIAPP_FILE_HANDLERS_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'edit_workspace',
    message: 'The Mini App file handlers declaration is invalid.',
    hint: 'Declare fileHandlers as a non-empty array of { id, path, extensions }: id matches [a-z0-9-]{1,32} and is unique, path follows the surface.path rules, and each extension looks like ".stl" and appears in only one handler.',
  },
  MINIAPP_MANIFEST_FIELD_UNSUPPORTED: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'edit_workspace',
    message: 'The Mini App manifest uses a field this MCode version does not support.',
    hint: 'Update MCode to a version that supports the field, or remove it from miniapp.json. Compare the top-level keys of miniapp.json with the documented fields to find it.',
  },
  MINIAPP_ENGINES_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'edit_workspace',
    message: 'The Mini App engines declaration is invalid.',
    hint: 'Declare engines as { "mcode": ">=MAJOR.MINOR.PATCH" }; only a >= lower bound with three numeric segments is accepted.',
  },
  MINIAPP_TOOL_ACCESS_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'edit_workspace',
    message: 'The Mini App tool access declaration is invalid.',
    hint: 'Declare toolAccess as ["call"]; it is the only accepted value.',
  },
  MINIAPP_HOST_TOO_OLD: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'user_action',
    message: 'This MCode version is older than the Mini App requires.',
    hint: 'Ask the user to update MCode to a version that satisfies engines.mcode, or lower the requirement if the package does not need newer Host features.',
  },
  WORKSPACE_CHANGED: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'workspace',
    recovery: 'retry',
    message: 'The Mini App workspace changed while it was being prepared.',
    hint: 'Finish writing the package and publish it again without changing files concurrently.',
  },
  WORKSPACE_INSTALL_FAILED: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'host',
    recovery: 'user_action',
    message: 'The Host could not stage the workspace Mini App package.',
    hint: 'Check local Plugin collisions and filesystem access, then retry the publish.',
  },
  RUNTIME_START_FAILED: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'runtime',
    recovery: 'edit_workspace',
    message: 'The Mini App Node entry failed during startup.',
    hint: 'Check that the entry loads, exports start(context), and does not throw during startup.',
  },
  RUNTIME_START_EXPORT_MISSING: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'runtime',
    recovery: 'edit_workspace',
    message: 'The Mini App Node entry does not export start(context).',
    hint: 'Export a named start function from the configured runtime entry.',
  },
  RUNTIME_LIFECYCLE_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'runtime',
    recovery: 'edit_workspace',
    message: 'The Mini App start function returned an invalid lifecycle object.',
    hint: 'Return void or an object with dispose(), and make dispose safe to await once.',
  },
  RUNTIME_NOT_READY: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'runtime',
    recovery: 'edit_workspace',
    message: 'The Mini App runtime did not become ready before the deadline.',
    hint: 'Bind the server to context.listen and complete startup without blocking.',
  },
  MCP_INVENTORY_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'mcp',
    recovery: 'edit_workspace',
    message: 'A Mini App MCP endpoint returned an invalid tool inventory.',
    hint: 'Return a valid MCP tools inventory with bounded JSON schemas from every endpoint.',
  },
  MCP_INVENTORY_MISMATCH: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'mcp',
    recovery: 'edit_workspace',
    message: 'The Mini App MCP inventory does not match the published package.',
    hint: 'Keep the declared endpoints and their generated inventory stable during publish.',
  },
  MCP_PUBLICATION_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'mcp',
    recovery: 'edit_workspace',
    message: 'The Mini App MCP runtime could not be published safely.',
    hint: 'Check that every declared MCP endpoint is ready and matches its runtime inventory.',
  },
  MCP_ENDPOINT_UNREACHABLE: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'mcp',
    recovery: 'edit_workspace',
    message: 'A Mini App MCP endpoint could not be reached during startup.',
    hint: 'Start every declared MCP endpoint from the Mini App runtime and keep it reachable until publication completes.',
  },
  MCP_PROTOCOL_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'mcp',
    recovery: 'edit_workspace',
    message: 'A Mini App MCP endpoint returned an invalid protocol response.',
    hint: 'Serve valid MCP responses from every declared endpoint and keep application output off the MCP transport.',
  },
  HOST_CONNECTOR_UNAVAILABLE: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'connector',
    recovery: 'user_action',
    message: 'The Host Connector bridge required by this Mini App is unavailable.',
    hint: 'Ensure the Desktop Connector bridge is available or remove unused Connector access.',
  },
  HOST_CONNECTOR_PROTOCOL_INVALID: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'connector',
    recovery: 'edit_workspace',
    message: 'The Mini App violated the Host Connector transport contract.',
    hint: 'Use context.connector for Connector operations and keep its Host transport messages valid.',
  },
  HOST_CAPACITY_UNAVAILABLE: {
    lifecycleCode: 'PREPARATION_FAILED',
    stage: 'host',
    recovery: 'retry',
    message: 'The Host has no capacity available for this Mini App runtime.',
    hint: 'Stop an unused Mini App or wait for an in-progress runtime operation, then retry.',
  },
} as const satisfies Readonly<Record<string, MiniAppFailureCatalogEntry>>;

export type MiniAppFailureReasonCode = keyof typeof MINIAPP_FAILURE_CATALOG;

export interface MiniAppFailureProjection {
  readonly message: string;
  readonly retryable: boolean;
  readonly diagnostic: MiniAppFailureDiagnostic;
}

export function projectMiniAppFailure(
  lifecycleCode: string,
  reasonCode: unknown,
): MiniAppFailureProjection | undefined {
  if (
    typeof reasonCode !== 'string' ||
    !Object.prototype.hasOwnProperty.call(MINIAPP_FAILURE_CATALOG, reasonCode)
  ) {
    return undefined;
  }
  const stableReason = reasonCode as MiniAppFailureReasonCode;
  const entry = MINIAPP_FAILURE_CATALOG[stableReason];
  if (entry.lifecycleCode !== lifecycleCode) return undefined;
  return {
    message: entry.message,
    retryable: entry.recovery === 'retry',
    diagnostic: {
      stage: entry.stage,
      reasonCode: stableReason,
      recovery: entry.recovery,
      hint: entry.hint,
    },
  };
}
