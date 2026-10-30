import type { LocalSandboxBashExecutionPort } from '@mavis/agent-tools/desktop';
import type { RuntimeConversation } from '@mavis/conversation-contract';
import type { PromptSnapshotSource } from '@mavis/agent-core';
import type { PromptSuggestionRemotePolicy } from '@mavis/config';

import type { AgentReferenceResolver } from '../agent/port.js';
import type { LocalAgentRuntimePort } from '../agent/runtime-port.js';
import type { LocalRuntimeApiHost, LocalRuntimeApiHostOptions } from '../api/host.js';
import type { WeChatRuntimeSdk } from '../channels/wechat-sdk-contract.js';
import type { MetricsBatchReporter, MetricsClient } from '../common/metrics.js';
import type { LocalRuntimeConfig } from '../config/types.js';
import type { LocalConfigUpdateResult } from '../config/update.js';
import type {
  LocalEvalReporterFactoryLike,
  LocalEvalReporterFactoryOptions,
} from '../eval/types.js';
import type { LocalMcpRuntimeCapability } from './mcp-capability.js';
import type { McpRuntimeLogger } from '@mavis/mcp/runtime/types';
import type { LocalHostDiagnosticsProvider } from '../observability/diagnostics-provider.js';
import type { ObservabilityLogger } from '../observability/index.js';
import type { LocalSessionController } from '../sessions/controller.js';
import type { LocalRuntimeTelemetrySink } from '../sessions/router.js';
import type { LocalRuntimeCapabilities, LocalRuntimeMode } from './mode.js';
import type { LocalModelResolverLike, LocalRuntimeAuthContext } from './model-resolver.js';
import type { LocalRuntimeRoutingContext } from './routing-headers.js';
import type { LocalRuntimeStartupExecutionPolicy } from './startup-execution-policy.js';

/** Product-facing options consumed by Local Runtime V2 before compat wiring. */
export interface LocalRuntimeProductHostOptions {
  /** Builtin Review resource directory; overridden by the packaging entry point, not user configuration. */
  readonly reviewPromptDir?: string;
  dataDir: string;
  runtimeOwnerKind: 'electron' | 'cli' | 'tui' | string;
  /** Client capability ceiling. Omitted hosts retain the shared Desktop/legacy surface. */
  capabilityProfile?: 'cli';
  /**
   * Cold-start execution policy for state already present on disk. Test data
   * clones use `quarantined` so copied Cron/channel state cannot execute
   * merely because the clone was opened.
   */
  startupExecutionPolicy?: LocalRuntimeStartupExecutionPolicy;
  runtimeMode?: LocalRuntimeMode;
  /**
   * Product/app version for metric labels. Electron passes `app.getVersion()`;
   * CLI passes its build define; dev/test hosts fall back to `'unknown'`.
   */
  appVersion?: string;
  capabilities?: Partial<LocalRuntimeCapabilities>;
  /**
   * Shell family actually used by the local command executor. Omit when the
   * owner cannot prove it; Windows native delete then remains fail-closed.
   */
  shellFamily?: LocalRuntimeApiHostOptions['shellFamily'];
  mavisCronAdapterProvider?: LocalRuntimeApiHostOptions['mavisCronAdapterProvider'];
  deleteAgentCronTasks?: LocalRuntimeApiHostOptions['deleteAgentCronTasks'];
  cronConsumerEnabled?: LocalRuntimeApiHostOptions['cronConsumerEnabled'];
  /** Owner-injected write-only publisher; pure v1 keeps its local event source. */
  globalEventPublisher?: LocalRuntimeApiHostOptions['globalEventPublisher'];
  /** Neutral Agent resolver supplied by Local Runtime V2's owner. */
  agentResolver?: AgentReferenceResolver;
  /** Agent management/reference port supplied by Local Runtime V2's owner. */
  agentRuntimePort?: LocalAgentRuntimePort;
  /** V2-owned Bash operations factory; V1 only forwards this capability. */
  sandboxOperationsFactory?: LocalSandboxBashExecutionPort;
  /** Read-only prompt source supplied by the V2 prompt-config owner. */
  promptSnapshots?: PromptSnapshotSource;
  /** Prevent legacy conversation writers from serving production paths. */
  disableLegacyConversation?: boolean;
  /** Owner runtime will bind typed Plan actions before explicitly recovering Questionnaires. */
  deferQuestionnaireRecovery?: boolean;
  runLegacyImCredentialMigration?: LocalRuntimeApiHostOptions['runLegacyImCredentialMigration'];
  telemetry?: LocalRuntimeTelemetrySink;
  configGetter?: () => LocalRuntimeConfig;
  modelResolver?: LocalModelResolverLike;
  authContextGetter?: () => LocalRuntimeAuthContext | undefined;
  /** Owner-side generation-aware recovery for rejected managed OAuth requests. */
  authContextInvalidator?: (
    rejectedAccessToken?: string,
    loginEpoch?: string,
  ) => void | Promise<void>;
  routingContextGetter?: () => LocalRuntimeRoutingContext | undefined;
  isContextWindowUsageEnabled?: () => boolean;
  fetchImpl?: typeof fetch;
  /** Optional fail-open eval capture transport supplied by packaged Electron builds. */
  evalCapture?: LocalEvalReporterFactoryOptions;
  configUpdater?: (body: Record<string, unknown>) => Promise<LocalConfigUpdateResult>;
  /** Live remote policy whose default fills `promptSuggestion.enabled` when the user has not chosen. */
  readonly getPromptSuggestionPolicy?: () => PromptSuggestionRemotePolicy | undefined;
  hostDiagnosticsProvider?: LocalHostDiagnosticsProvider;
  skillRegistryDiagnostics?: LocalRuntimeApiHostOptions['skillRegistryDiagnostics'];
  skillEnabledState?: LocalRuntimeApiHostOptions['skillEnabledState'];
  cliSunsetNotice?: LocalRuntimeApiHostOptions['cliSunsetNotice'];
  defaultWorkspaceDir?: string;
  runtimeStartupToken?: string;
  legacyOpencodeEnabled?: boolean;
  nowMs?: () => number;
  enableLiveMcp?: boolean;
  mcpLogger?: McpRuntimeLogger;
  observability?: ObservabilityLogger;
  wechatRuntimeSdk?: WeChatRuntimeSdk;
  metricsClient?: MetricsClient;
  metricsReporter?: MetricsBatchReporter;
}

/** Compatibility-shell options. Non-owner diagnostics may omit Conversation capability. */
export interface CreateLocalRuntimeHostOptions extends LocalRuntimeProductHostOptions {
  /** @internal Bound by V2 services before accepting MCP or turn requests. */
  readonly mcpRuntime?: LocalMcpRuntimeCapability;
  readonly runtimeConversation?: RuntimeConversation;
  /**
   * @internal Local Runtime V2 sets this so the V1 shell builds stores, APIs,
   * runner and registries without touching any transport; V2 then runs the
   * single `apiHost.startChannelSubsystem()` pass once its services are ready.
   */
  readonly deferChannelStartup?: boolean;
}

/** Owner-host options after V2 has injected its deferred Conversation bridge. */
export interface CreateConversationCompatibilityHostOptions extends LocalRuntimeProductHostOptions {
  readonly runtimeConversation: RuntimeConversation;
}

export interface CreatedLocalRuntimeHost {
  apiHost: LocalRuntimeApiHost;
  controller: LocalSessionController;
  dataDir: string;
  ready: Promise<void>;
  metricsClient: MetricsClient;
  /** Shared diagnostic event sink; preserves the host context and file writer identity. */
  observability: ObservabilityLogger;
  /** Eval reporter used by the runtime host; exposed for graceful shutdown flushing. */
  evalReporterFactory?: LocalEvalReporterFactoryLike;
  /** V2-only non-blocking identity lifecycle hook; absent on direct legacy hosts. */
  notifyAuthContextChanged?: (
    authState?: 'pending' | 'authenticated' | 'logged_out',
  ) => void | Promise<void>;
}
