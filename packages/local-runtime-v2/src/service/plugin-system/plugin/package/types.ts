import type { ResolvedMcpServer } from '@mavis/mcp';
import type { PluginHookCommandHandler } from '@mavis/plugin-hooks';

export const MARKETPLACE_CATEGORY_NAMES = [
  'Office',
  'Studio',
  'Design & Sites',
  'Code',
  'Business',
  'Sales',
  'Productivity',
  'Science & Healthcare',
  'Education',
  'Other',
] as const;

export type MarketplaceCategoryName = (typeof MARKETPLACE_CATEGORY_NAMES)[number];
export type PluginPackageSource =
  | 'OFFICIAL'
  | 'LOCAL_MINIMAX'
  | 'LOCAL_AGENT_PLUGIN'
  | 'LOCAL_\u0043\u004c\u0041\u0055\u0044\u0045'
  | 'LOCAL_CODEX';
type PluginManifestKind =
  | 'MINIMAX'
  | 'AGENT_PLUGINS_V1'
  | '\u0043\u004c\u0041\u0055\u0044\u0045_CODE'
  | 'CODEX';

export interface PluginReaderDiagnostic {
  readonly code: string;
  readonly capability?: 'MCP' | 'SKILL' | 'APP' | 'HOOK' | 'AGENT';
  readonly name?: string;
}

export interface PluginAppReference {
  readonly provider: string;
}

export interface PluginDeclaredTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface PluginMcpServer {
  readonly name: string;
  readonly description?: string;
  readonly resolvedServer: ResolvedMcpServer;
  readonly declaredTools: readonly PluginDeclaredTool[];
  readonly configJson: string;
}

export interface PluginSkill {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly skillFilePath: string;
  readonly skillRoot: string;
}

export type PluginAgentSourceFormat = 'MINIMAX' | '\u0043\u004c\u0041\u0055\u0044\u0045';

/**
 * Markdown subagent accepted from an official or LOCAL package. Selector fields keep the
 * Custom Agent encoding: `undefined` inherits, `[]` explicitly disables.
 */
export interface PluginAgent {
  /** Segments after the Plugin name, e.g. `reviewer` or `review:security`. */
  readonly name: string;
  /** Task target `<plugin>:<name>`. */
  readonly scopedName: string;
  readonly sourceFormat: PluginAgentSourceFormat;
  readonly description: string;
  readonly displayName?: string;
  /** Complete Markdown file, including frontmatter. */
  readonly content: string;
  /** Markdown body; Plugin path variables are substituted only when a Task captures it. */
  readonly systemPrompt: string;
  readonly agentFilePath: string;
  readonly model?: string;
  readonly effort?: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly skills?: readonly string[];
  /** Same-Plugin Skills are addressed by their runtime name `<plugin>:<skill>`. */
  readonly extensionSkills?: readonly string[];
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

export type PluginHostBindingSurface = 'interactive';

interface PluginHostCapabilityReference {
  readonly id: string;
  readonly version: number;
}

/**
 * Declarative request for a MiniMax Plugin to reuse a Host-owned capability.
 * The package supplies no executable implementation and receives no permission
 * by declaring this record; resolution remains a Host policy decision.
 */
export interface PluginHostBinding {
  readonly schemaVersion: 1;
  readonly bindingId: string;
  readonly logicalToolName: string;
  readonly hostCapability: PluginHostCapabilityReference;
  readonly requiredSkills: readonly string[];
  readonly allowedSurfaces: readonly PluginHostBindingSurface[];
  readonly sourcePath: string;
}

export interface MiniAppArtifacts {
  readonly client: readonly string[];
  readonly node: readonly string[];
}

export interface MiniAppProcessRuntime {
  readonly kind: 'process';
  readonly entry: string;
  readonly lifecycle: 'on-demand';
}

export interface MiniAppMcpEndpoint {
  readonly server: string;
  readonly path: string;
}

export interface MiniAppContribution {
  readonly manifestPath: string;
  readonly artifacts: MiniAppArtifacts;
  readonly runtime: MiniAppProcessRuntime;
  readonly surface: { readonly path: string };
  readonly mcpEndpoints: readonly MiniAppMcpEndpoint[];
  readonly hostConnectorAccess?: { readonly providers: readonly string[] };
}

type ScannedMiniAppContribution = MiniAppContribution & {
  readonly contentDigest: string;
  readonly clientDigest: string;
  readonly nodeDigest: string;
};

export interface ReadPluginPackage {
  readonly source: PluginPackageSource;
  readonly manifestKind: PluginManifestKind;
  readonly rootPath: string;
  readonly manifestPath: string;
  readonly name: string;
  readonly displayName?: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: string;
  readonly iconPath?: string;
  readonly darkIconPath?: string;
  readonly category: MarketplaceCategoryName;
  readonly exampleQueries: readonly string[];
  readonly apps: readonly PluginAppReference[];
  readonly mcpServers: readonly PluginMcpServer[];
  readonly skills: readonly PluginSkill[];
  readonly hostBindings?: readonly PluginHostBinding[];
  readonly hooks?: readonly PluginHookCommandHandler[];
  /** MiniMax (official and local) and compatible-format packages carry subagents. */
  readonly agents?: readonly PluginAgent[];
  readonly miniapp?: MiniAppContribution;
  readonly diagnostics: readonly PluginReaderDiagnostic[];
}

type ScannedPluginPackageBase = Omit<ReadPluginPackage, 'miniapp'>;

export type RuntimeEligibleScannedReadPluginPackage = ScannedPluginPackageBase & {
  readonly miniapp?: ScannedMiniAppContribution;
};

export type ScannedReadPluginPackage = RuntimeEligibleScannedReadPluginPackage;

export interface LocalPluginScanResult {
  readonly plugins: readonly ScannedLocalPluginPackage[];
  readonly diagnostics: readonly LocalPluginScanDiagnostic[];
}

export interface ScannedLocalPluginPackage {
  readonly plugin: ScannedReadPluginPackage;
  readonly contentDigest: string;
}

export interface LocalPluginScanDiagnostic {
  readonly code: string;
  readonly directoryName: string;
}
