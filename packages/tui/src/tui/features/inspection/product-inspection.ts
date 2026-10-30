import type {
  TuiAccountStatus,
  TuiContextSnapshotResponse,
  TuiMcpServer,
  TuiPendingPermission,
  TuiRuntimeDiagnostics,
  TuiModel,
  TuiSession,
  TuiSessionUsage,
  TuiSessionUsageSummary,
  TuiSkillList,
  TuiWorkspaceGitMetadata,
  TuiInstructionSource,
} from '../../../runtime/port.js';
import {
  formatTuiPermissionMode,
  isDangerousTuiPermissionMode,
  type TuiPermissionMode,
} from '../../../application/permission-mode.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { sanitizeTuiUrl } from '../../rendering/url.js';
import { resolveTuiThinkingChoice } from '../model/thinking.js';
import { resolveTuiEffortChoice } from '../model/effort.js';
import { resolveTuiSessionCacheMetrics } from '../../../application/session-cache-metrics.js';
import type {
  TranscriptContextVisualization,
  TranscriptInspectionReport,
  TranscriptInspectionTone,
  TranscriptUsageAccountRow,
  TranscriptUsageVisualization,
} from '../../transcript/model.js';

export type TuiSkill = NonNullable<TuiSkillList['skills']>[number];

export interface TuiStatusPresentationOptions {
  readonly version?: string;
  readonly accountLoading?: boolean;
  readonly model?: TuiModel;
  /** Session-scoped think effort; falls back to the configured default level. */
  readonly effort?: string;
  readonly workspaceDir?: string;
  readonly permissionMode?: TuiPermissionMode;
  readonly session?: TuiSession;
  readonly workspaceGit?: TuiWorkspaceGitMetadata;
  readonly instructionSources?: readonly TuiInstructionSource[];
  readonly planMode?: {
    readonly displayMode: 'default' | 'plan';
    readonly transition?: 'next-message' | 'submitting';
  };
}

export function formatTuiAccountStatus(
  account: TuiAccountStatus | undefined,
  options: TuiStatusPresentationOptions = {},
): string {
  return formatInspectionReport(createTuiAccountStatusInspection(account, options));
}

export function createTuiAccountStatusInspection(
  account: TuiAccountStatus | undefined,
  options: TuiStatusPresentationOptions = {},
): TranscriptInspectionReport {
  const sessionModel = options.model;
  const status = account?.status ?? 'unknown';
  const needsLogin = status === 'needs-login' || account?.managedTokenPresent === false;
  const identity = account?.identity?.email?.trim() || account?.identity?.name?.trim();
  const accountLabel = options.accountLoading
    ? 'Loading…'
    : needsLogin
      ? account?.modelSource === 'byok'
        ? 'Not signed in'
        : 'Sign in with /login'
      : identity
        ? safeInline(identity)
        : status === 'ready'
          ? 'Connected with MiniMax'
          : status === 'warning'
            ? 'Connected with warnings'
            : 'MiniMax account unavailable';
  const sessionEffort = sessionModel
    ? resolveTuiEffortChoice(sessionModel, options.effort)
    : undefined;
  const model = sessionModel
    ? `${safeInline(sessionModel.providerId)}/${safeInline(sessionModel.modelId)}${
        sessionModel.variant && !sessionEffort ? `#${safeInline(sessionModel.variant)}` : ''
      }`
    : safe(account?.defaultModel ?? 'not selected');
  const sections: Array<TranscriptInspectionReport['sections'][number]> = [
    {
      title: 'Account',
      rows: [
        {
          label: 'Account',
          value: accountLabel,
          tone: options.accountLoading
            ? 'neutral'
            : needsLogin
              ? 'warning'
              : accountStatusTone(status),
        },
        { label: 'Provider', value: safe(account?.providerId ?? 'not configured') },
        { label: 'Auth', value: safe(account?.authMode ?? 'unknown') },
        ...(account?.tokenPlanSummary?.tier
          ? [
              {
                label: 'Plan',
                value: safeInline(account.tokenPlanSummary.tier),
                tone: 'accent' as const,
              },
            ]
          : []),
        ...(account?.modelSource
          ? [
              {
                label: 'Model source',
                value: account.modelSource === 'byok' ? 'API key' : 'Token Plan',
              },
            ]
          : []),
      ],
    },
  ];
  sections.push({
    title: 'Model',
    rows: [
      { label: 'Model', value: model, tone: sessionModel ? 'accent' : 'neutral' },
      ...(sessionEffort
        ? [{ label: 'Think effort', value: sessionEffort }]
        : [
            {
              label: 'Thinking',
              value: formatThinkingStatus(sessionModel),
            },
          ]),
      {
        label: 'Source',
        value: sessionModel && options.session ? 'session selection' : 'configured default',
      },
    ],
  });
  if (options.workspaceDir !== undefined) {
    sections.push({
      title: 'Workspace',
      rows: [
        { label: 'Directory', value: safeInline(options.workspaceDir) },
        { label: 'Branch', value: formatWorkspaceBranch(options.workspaceGit) },
        { label: 'Worktree', value: formatWorkspaceWorktree(options.workspaceGit) },
      ],
    });
    sections.push({
      title: 'Session',
      rows: [
        { label: 'Session ID', value: safeInline(options.session?.sessionId ?? 'Not started') },
        { label: 'Title', value: safeInline(options.session?.title ?? 'Untitled') },
      ],
    });
    sections.push({
      title: 'Permissions',
      rows: [
        {
          label: 'Permissions',
          value: options.permissionMode
            ? formatTuiPermissionMode(options.permissionMode)
            : 'Unavailable',
          tone:
            options.permissionMode && isDangerousTuiPermissionMode(options.permissionMode)
              ? 'warning'
              : 'neutral',
        },
      ],
    });
    const mode = options.planMode?.displayMode ?? options.session?.interactionMode ?? 'default';
    const activeMode = options.session?.interactionMode === 'plan' ? 'Plan' : 'Default';
    const modeLabel = mode === 'plan' ? 'Plan' : 'Default';
    sections.push({
      title: 'Mode',
      rows: [
        {
          label: 'Mode',
          value: options.planMode?.transition
            ? `${activeMode} → ${modeLabel} (${options.planMode.transition === 'next-message' ? 'next message' : 'submitting'})`
            : modeLabel,
        },
      ],
    });
    sections.push({
      title: 'Instructions',
      rows: options.instructionSources?.length
        ? options.instructionSources.map((source) => ({
            label: source.scope === 'global' ? 'Global rules' : 'Project rules',
            value: safeInline(source.path),
          }))
        : [{ label: 'Instructions', value: options.instructionSources ? 'None' : 'Unavailable' }],
    });
  }
  const quotaRows = createTokenPlanQuotaRows(account).filter((row) => row.label !== 'Video');
  if (quotaRows.length > 0) sections.push({ title: 'Quota', rows: quotaRows });
  return {
    title: `MCode status${options.version ? ` · v${safeInline(options.version)}` : ''}`,
    badge: options.accountLoading
      ? { label: 'Loading account…', tone: 'neutral' }
      : accountStatusBadge(status),
    sections,
    warnings: account?.warnings.map(safe),
    footer: 'Current configuration · /usage for details',
    visualization: { kind: 'status', ...(quotaRows.length ? { quotaRows } : {}) },
  };
}

function formatThinkingStatus(model: TuiModel | undefined): string {
  if (!model) return 'Unknown';
  const thinking = resolveTuiThinkingChoice(model);
  return thinking === undefined ? 'Not configurable' : thinking === 'on' ? 'On' : 'Off';
}

function formatWorkspaceBranch(metadata: TuiWorkspaceGitMetadata | undefined): string {
  if (!metadata) return 'Unavailable';
  if (!metadata.isGitRepo) return 'Not a Git repository';
  if (metadata.detached) return 'Detached HEAD';
  return safeInline(metadata.branch || 'Unborn branch');
}

function formatWorkspaceWorktree(metadata: TuiWorkspaceGitMetadata | undefined): string {
  if (!metadata) return 'Unavailable';
  if (!metadata.isGitRepo) return 'Not applicable';
  return metadata.isWorktree ? 'Linked' : 'Primary checkout';
}

function createTokenPlanRows(
  account: TuiAccountStatus | undefined,
  needsLogin: boolean,
): TranscriptUsageAccountRow[] {
  if (needsLogin) {
    return [{ label: 'Plan', value: 'Run /login to view plan and quota', tone: 'warning' }];
  }
  const summary = account?.tokenPlanSummary;
  const hasTokenPlan =
    account?.modelSource === 'token-plan' ||
    account?.tokenPlanQuotaState !== undefined ||
    Boolean(summary);
  if (!hasTokenPlan) return [];
  return [
    { label: 'Plan', value: safe(summary?.tier ?? 'Token Plan'), tone: 'accent' },
    ...(summary?.expiresAtMs
      ? [{ label: 'Expires', value: formatLocalDate(summary.expiresAtMs) }]
      : []),
    ...(summary?.creditBalance
      ? [{ label: 'Credits', value: formatCreditAmount(summary.creditBalance) }]
      : []),
  ];
}

function createTokenPlanQuotaRows(
  account: TuiAccountStatus | undefined,
): TranscriptUsageAccountRow[] {
  if (account?.tokenPlanQuotaState === 'not-subscribed') {
    return [{ label: 'Quota', value: 'No Token Plan subscription', tone: 'warning' }];
  }
  const quota = account?.tokenPlanQuota;
  if (!quota) {
    return account?.tokenPlanQuotaState === 'unavailable'
      ? [{ label: 'Quota', value: 'Temporarily unavailable', tone: 'warning' }]
      : [];
  }
  return [
    {
      label: '5-hour',
      value: formatQuotaWindowDetail(quota.fiveHour),
      ...(quota.fiveHour.unlimited ? {} : remainingPercentRatio(quota.fiveHour.remainingPercent)),
    },
    {
      label: 'Weekly',
      value: formatQuotaWindowDetail(quota.weekly),
      ...(quota.weekly.unlimited ? {} : remainingPercentRatio(quota.weekly.remainingPercent)),
    },
    ...(quota.video
      ? [
          {
            label: 'Video',
            value: formatVideoQuotaDetail(quota.video),
            ...(quota.video.unlimited
              ? {}
              : remainingCountRatio(quota.video.remainingCount, quota.video.totalCount)),
          },
        ]
      : []),
  ];
}

function remainingPercentRatio(
  value: number | undefined,
): Pick<TranscriptUsageAccountRow, 'remainingRatio'> {
  return typeof value === 'number' && Number.isFinite(value)
    ? { remainingRatio: Math.min(1, Math.max(0, value / 100)) }
    : {};
}

function remainingCountRatio(
  remaining: number | undefined,
  total: number | undefined,
): Pick<TranscriptUsageAccountRow, 'remainingRatio'> {
  return typeof remaining === 'number' &&
    Number.isFinite(remaining) &&
    typeof total === 'number' &&
    Number.isFinite(total) &&
    total > 0
    ? { remainingRatio: Math.min(1, Math.max(0, remaining / total)) }
    : {};
}

function formatQuotaWindowDetail(
  window: NonNullable<TuiAccountStatus['tokenPlanQuota']>['fiveHour'],
): string {
  if (window.unlimited) return 'Unlimited';
  const remaining =
    typeof window.remainingPercent === 'number'
      ? `${formatNumber(window.remainingPercent)}% left`
      : '—';
  return appendResetTime(remaining, window.resetAtMs);
}

function formatVideoQuotaDetail(
  video: NonNullable<TuiAccountStatus['tokenPlanQuota']>['video'],
): string {
  if (!video) return '—';
  if (video.unlimited) return 'Unlimited';
  const remaining =
    video.remainingCount === undefined
      ? '—'
      : video.totalCount === undefined
        ? `${formatNumber(video.remainingCount)} left`
        : `${formatNumber(video.remainingCount)}/${formatNumber(video.totalCount)} left`;
  return appendResetTime(remaining, video.resetAtMs);
}

function appendResetTime(value: string, resetAtMs: number | undefined): string {
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs)) return value;
  const remainingMs = resetAtMs - Date.now();
  if (remainingMs <= 0) return `${value} · reset pending`;
  const minutes = Math.ceil(remainingMs / 60_000);
  const duration =
    minutes < 60
      ? `${minutes}m`
      : minutes < 24 * 60
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${Math.floor(minutes / (24 * 60))}d ${Math.floor((minutes % (24 * 60)) / 60)}h`;
  return `${value} · resets in ${duration}`;
}

function formatLocalDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}

export function formatTuiRuntimeDiagnostics(diagnostics: TuiRuntimeDiagnostics): string {
  return formatInspectionReport(createTuiRuntimeInspection(diagnostics));
}

export function formatTuiConfigSummary(diagnostics: TuiRuntimeDiagnostics): string {
  return formatInspectionReport(createTuiConfigInspection(diagnostics));
}

export function createTuiRuntimeInspection(
  diagnostics: TuiRuntimeDiagnostics,
): TranscriptInspectionReport {
  const status = safe(diagnostics.status ?? 'unknown');
  const statusTone = runtimeStatusTone(status);
  const valid = statusTone === 'success';
  const issues = diagnostics.warnings.map(safe);
  return {
    title: 'Configuration check',
    badge: { label: valid ? 'VALID' : 'ISSUES', tone: statusTone },
    sections: [
      {
        title: 'Config file',
        rows: [
          {
            label: 'Status',
            value: valid ? 'Valid' : 'Needs attention',
            tone: statusTone,
          },
          {
            label: 'Path',
            value: safe(diagnostics.configPath ?? 'unavailable'),
          },
          { label: 'File', value: presence(diagnostics.configPresent) },
        ],
      },
      ...(valid
        ? [
            {
              title: 'Model',
              rows: [
                {
                  label: 'Default model',
                  value: safe(diagnostics.defaultModel ?? 'not configured'),
                },
                { label: 'Provider', value: safe(diagnostics.providerId ?? 'unknown') },
              ],
            },
          ]
        : []),
      ...(issues.length > 0
        ? [
            {
              title: 'Issues',
              rows: issues.map((issue) => ({ label: 'Issue', value: issue, tone: statusTone })),
            },
          ]
        : []),
      ...(!valid
        ? [
            {
              title: 'Impact',
              rows: [
                {
                  label: 'Current run',
                  value: 'MCode may use built-in defaults until the config is fixed and restarted.',
                  tone: 'warning' as const,
                },
              ],
            },
            {
              title: 'Next step',
              rows: [
                {
                  label: 'Action',
                  value: configurationNextStep(diagnostics),
                },
              ],
            },
          ]
        : []),
    ],
    footer: 'Read only · no files changed',
  };
}

function configurationNextStep(diagnostics: TuiRuntimeDiagnostics): string {
  const path = safe(diagnostics.configPath ?? 'the config file');
  if (diagnostics.warnings.some((issue) => issue.includes('does not exist'))) {
    return `Create or restore ${path}, restart MCode, then run /doctor again.`;
  }
  if (diagnostics.warnings.some((issue) => issue.includes('cannot be read'))) {
    return `Check access to ${path}, restart MCode, then run /doctor again.`;
  }
  if (diagnostics.warnings.some((issue) => issue.includes('defaultModel'))) {
    return `Set defaultModel in ${path} to an available provider/model, restart MCode, then run /doctor again.`;
  }
  return `Fix ${path}, restart MCode, then run /doctor again.`;
}

export function createTuiConfigInspection(
  diagnostics: TuiRuntimeDiagnostics,
): TranscriptInspectionReport {
  return {
    title: 'Effective configuration',
    badge: { label: 'READ ONLY', tone: 'accent' },
    sections: [
      {
        title: 'Location',
        rows: [
          { label: 'Source', value: safe(diagnostics.configPath ?? 'Runtime default config') },
          { label: 'Config file', value: presence(diagnostics.configPresent) },
          { label: 'Data directory', value: safe(diagnostics.dataDir ?? 'unavailable') },
        ],
      },
      {
        title: 'Model',
        rows: [
          { label: 'Default', value: safe(diagnostics.defaultModel ?? 'not configured') },
          { label: 'Provider', value: safe(diagnostics.providerId ?? 'unknown') },
          { label: 'Endpoint', value: sanitizeTuiUrl(diagnostics.providerBaseUrl ?? 'default') },
        ],
      },
      {
        title: 'Credentials',
        rows: [
          { label: 'Auth mode', value: safe(diagnostics.authMode ?? 'unknown') },
          { label: 'Auth source', value: safe(diagnostics.authModeSource ?? 'unknown') },
          { label: 'Provider API key', value: presence(diagnostics.apiKeyPresent) },
          { label: 'Managed credential', value: presence(diagnostics.managedTokenPresent) },
          {
            label: 'Custom providers',
            value: formatNumber(diagnostics.customProviderCount ?? 0),
          },
        ],
      },
    ],
    footer: 'Credential values are hidden',
  };
}

export interface TuiUsagePresentationOptions {
  readonly context?: TuiContextSnapshotResponse;
  readonly model?: TuiModel;
  readonly account?: TuiAccountStatus;
  readonly scope?: 'session' | 'account';
}

export function formatTuiUsage(
  usage: TuiSessionUsage,
  options: TuiUsagePresentationOptions = {},
): string {
  const presentation = resolveTuiUsagePresentation(usage, options);
  if (!presentation) {
    return options.scope === 'account'
      ? 'No account usage is available. Sign in with /login to view plan and quota.'
      : 'No usage has been recorded for this Session.';
  }
  return formatInspectionReport({
    title: usageTitle(options),
    sections: [],
    visualization: presentation,
  });
}

export function createTuiUsageInspection(
  usage: TuiSessionUsage,
  options: TuiUsagePresentationOptions = {},
): TranscriptInspectionReport | undefined {
  const presentation = resolveTuiUsagePresentation(usage, options);
  if (!presentation) return undefined;

  return {
    title: usageTitle(options),
    sections: [],
    visualization: presentation,
  };
}

function resolveTuiUsagePresentation(
  usage: TuiSessionUsage,
  options: TuiUsagePresentationOptions,
): TranscriptUsageVisualization | undefined {
  const summary = usage.summary;
  const accountRows = createUsageAccountRows(options.account);
  if (!summary && accountRows.length === 0) return undefined;

  const contextUsage = options.context?.contextUsage;
  const contextWindow = contextUsage
    ? positiveFinite(contextUsage.contextWindowTokens)
      ? contextUsage.contextWindowTokens
      : options.context?.model?.contextWindow
    : undefined;
  const context =
    contextUsage && positiveFinite(contextWindow)
      ? {
          usedTokens: contextUsage.usedTokens,
          windowTokens: contextWindow,
          utilization: contextUsage.usedTokens / contextWindow,
        }
      : null;
  const model = options.model
    ? `${safeInline(options.model.providerId)}/${safeInline(options.model.modelId)}`
    : 'Model unavailable';
  const cacheMetrics = resolveTuiSessionCacheMetrics(summary);
  return {
    kind: 'usage',
    model,
    sessionRecorded: summary !== undefined,
    inputTokens: summary?.inputTokens ?? 0,
    outputTokens: summary?.outputTokens ?? 0,
    totalTokens: summary?.totalTokens ?? (summary ? sumTokenUsage(summary) : 0),
    ...(cacheMetrics ? { cacheMetrics } : {}),
    context,
    ...(accountRows.length > 0 ? { accountRows } : {}),
  };
}

function createUsageAccountRows(
  account: TuiAccountStatus | undefined,
): TranscriptUsageAccountRow[] {
  if (!account) return [];
  const hasPlanInspection =
    account.tokenPlanQuotaState !== undefined ||
    account.tokenPlanSummary !== undefined ||
    account.tokenPlanQuota !== undefined;
  const needsLogin =
    !hasPlanInspection &&
    (account.status === 'needs-login' || account.managedTokenPresent === false);
  return [...createTokenPlanRows(account, needsLogin), ...createTokenPlanQuotaRows(account)];
}

function usageTitle(options: TuiUsagePresentationOptions): string {
  return options.scope === 'account' ? 'Account usage' : 'Session usage';
}

export function formatTuiContextSnapshot(
  response: TuiContextSnapshotResponse,
  fallbackModel?: TuiModel,
): string {
  if (response.status === 'loading') {
    return 'Context is loading. Run /context again after the active Run starts.';
  }
  const usage = response.contextUsage;
  if (!usage || response.status === 'empty') {
    return 'No Runtime context snapshot is available for this Session yet.';
  }
  const contextWindow = positiveFinite(usage.contextWindowTokens)
    ? usage.contextWindowTokens
    : response.model?.contextWindow;
  const remaining =
    contextWindow === undefined ? undefined : Math.max(0, contextWindow - usage.usedTokens);
  const utilization =
    contextWindow === undefined ? undefined : Math.min(1, usage.usedTokens / contextWindow);
  const model = response.model
    ? `${safeInline(response.model.provider)}/${safeInline(response.model.id)}`
    : fallbackModel
      ? `${safeInline(fallbackModel.providerId)}/${safeInline(fallbackModel.modelId)}`
      : 'not selected';
  return [
    `Context · ${response.status === 'stale' ? 'stale snapshot' : 'live snapshot'}`,
    `Budget: ${formatNumber(usage.usedTokens)} used · ${remaining === undefined ? 'unknown' : `${formatNumber(remaining)} remaining`} · ${utilization === undefined ? 'unknown' : `${Math.round(utilization * 100)}%`}`,
    `Model: ${model}`,
    `Compaction: ${response.compaction?.state ?? 'never'}`,
    ...(usage.components.length > 0
      ? [
          '',
          'Components:',
          ...usage.components.map(
            (component) =>
              `- ${contextComponentLabel(component.kind)}: ${formatNumber(component.tokens)} tokens`,
          ),
        ]
      : []),
    ...(response.status === 'stale'
      ? ['', 'This snapshot belongs to the most recently completed Run.']
      : []),
  ].join('\n');
}

export function createTuiContextInspection(
  response: TuiContextSnapshotResponse,
): TranscriptInspectionReport | undefined {
  const usage = response.contextUsage;
  if (!usage || response.status === 'loading' || response.status === 'empty') return undefined;
  const contextWindow = positiveFinite(usage.contextWindowTokens)
    ? usage.contextWindowTokens
    : response.model?.contextWindow;
  const remaining =
    contextWindow === undefined ? undefined : Math.max(0, contextWindow - usage.usedTokens);
  const utilization =
    contextWindow === undefined ? undefined : Math.min(1, usage.usedTokens / contextWindow);
  const stale = response.status === 'stale';
  const visualization: TranscriptContextVisualization = {
    kind: 'context',
    model: response.model
      ? `${safeInline(response.model.provider)}/${safeInline(response.model.id)}`
      : 'not selected',
    snapshotState: stale ? 'stale' : 'live',
    usedTokens: usage.usedTokens,
    remainingTokens: remaining ?? null,
    contextWindow: contextWindow ?? null,
    utilization: utilization ?? null,
    basis:
      usage.totalCountSource === 'PROVIDER_USAGE_ANCHORED' ? 'provider-usage' : 'runtime-estimate',
    compaction: response.compaction?.state ?? 'never',
    compactionThresholdTokens: response.compactionTrigger?.effectiveTriggerTokens ?? null,
    ...(response.compactionTrigger
      ? { compactionThresholdSource: response.compactionTrigger.source }
      : {}),
    components: usage.components,
  };
  return {
    title: 'Context',
    badge: { label: stale ? 'STALE' : 'LIVE', tone: stale ? 'warning' : 'success' },
    sections: [
      {
        title: 'Runtime',
        rows: [
          {
            label: 'Model',
            value: response.model
              ? `${safeInline(response.model.provider)}/${safeInline(response.model.id)}`
              : 'not selected',
          },
          { label: 'Compaction', value: response.compaction?.state ?? 'never' },
          { label: 'Snapshot', value: stale ? 'Most recently completed Run' : 'Current context' },
        ],
      },
      {
        title: 'Budget',
        rows: [
          { label: 'Used', value: formatNumber(usage.usedTokens), tone: 'accent' },
          {
            label: 'Remaining',
            value: remaining === undefined ? 'unknown' : formatNumber(remaining),
          },
          {
            label: 'Utilization',
            value: utilization === undefined ? 'unknown' : `${Math.round(utilization * 100)}%`,
          },
          {
            label: 'Window',
            value: contextWindow === undefined ? 'unknown' : formatNumber(contextWindow),
          },
        ],
      },
      ...(usage.components.length > 0
        ? [
            {
              title: 'Components',
              rows: usage.components.map((component) => ({
                label: contextComponentLabel(component.kind),
                value: formatNumber(component.tokens),
              })),
            },
          ]
        : []),
    ],
    footer:
      usage.totalCountSource === 'PROVIDER_USAGE_ANCHORED'
        ? 'Provider usage anchored · contents redacted'
        : 'Runtime estimate · contents redacted',
    visualization,
  };
}

export function formatTuiSkills(result: TuiSkillList): string {
  const skills = result.skills ?? [];
  if (skills.length === 0) return 'No Skills matched the current Agent configuration.';
  const groups = [
    {
      label: 'Built-in Skills',
      skills: skills.filter((skill) => classifyTuiSkillSource(skill) === 'builtin'),
    },
    {
      label: 'User Skills',
      skills: skills.filter((skill) => classifyTuiSkillSource(skill) === 'user'),
    },
    {
      label: 'Other Skills',
      skills: skills.filter((skill) => classifyTuiSkillSource(skill) === 'other'),
    },
  ];
  const lines = [`Skills · ${skills.length}${result.hasMore ? '+' : ''}`];
  for (const group of groups) {
    if (group.skills.length === 0) continue;
    lines.push(
      '',
      `${group.label} · ${group.skills.length}`,
      ...group.skills.map(formatSkillSummary),
    );
  }
  if (result.hasMore) lines.push('', 'More Skills exist; narrow the list with /skills <filter>.');
  return lines.join('\n');
}

export function formatTuiMcpServers(servers: readonly TuiMcpServer[]): string {
  const ownershipNote =
    'Built-in and plugin-owned MCP servers are Runtime-managed and are not included in this list.';
  if (servers.length === 0) {
    return [
      'No user-configured MCP servers matched the current configuration.',
      ownershipNote,
    ].join('\n');
  }
  return [
    `User-configured MCP servers · ${servers.length}`,
    ...servers.map((server) => {
      const publicStatus = readTuiMcpPublicStatus(server.configJson);
      const description = server.description ? `\n  ${safe(server.description)}` : '';
      const status =
        publicStatus.status && publicStatus.status !== 'disabled'
          ? ` · ${publicStatus.status}`
          : '';
      const error = publicStatus.error ? `\n  ${publicStatus.error}` : '';
      return `${safe(server.name)} · ${server.enabled ? 'enabled' : 'disabled'} · ${safe(
        server.transport ?? 'unknown transport',
      )}${status}${description}${error}`;
    }),
    '',
    ownershipNote,
    'Configuration payloads and credential references are hidden. Retry the MCP operation, then run /mcp again.',
  ].join('\n');
}

const PUBLIC_MCP_ERRORS = new Set([
  'MCP server transport is incomplete. Configure a command or URL and retry.',
  'MCP connection support is unavailable in this Runtime.',
  'MCP server connection failed. Retry or check its configuration.',
  'MCP server connection timed out. Retry or check its configuration.',
]);

export function readTuiMcpPublicStatus(configJson: string | undefined): {
  status?: 'available' | 'configured' | 'disabled' | 'error' | 'unavailable';
  error?: string;
} {
  if (!configJson) return {};
  try {
    const value = JSON.parse(configJson) as Record<string, unknown>;
    const status =
      value['status'] === 'available' ||
      value['status'] === 'configured' ||
      value['status'] === 'disabled' ||
      value['status'] === 'error' ||
      value['status'] === 'unavailable'
        ? value['status']
        : undefined;
    const rawError = typeof value['error'] === 'string' ? value['error'] : undefined;
    return {
      ...(status ? { status } : {}),
      ...(rawError && PUBLIC_MCP_ERRORS.has(rawError)
        ? { error: rawError }
        : status === 'error' || status === 'unavailable'
          ? { error: 'MCP server is unavailable. Retry or check its configuration.' }
          : {}),
    };
  } catch {
    return {};
  }
}

export function formatTuiPermissions(requests: readonly TuiPendingPermission[]): string {
  if (requests.length === 0) {
    return ['No pending permission requests.', 'Permission policy remains owned by Runtime.'].join(
      '\n',
    );
  }
  return [
    `Pending permissions · ${requests.length}`,
    ...requests.map((request, index) => {
      const description = request.toolDescription ?? request.reason ?? 'Awaiting a decision';
      return `${index + 1}. ${safe(request.toolName ?? 'tool')} · ${safe(description)}`;
    }),
    '',
    'Choose an action above to continue.',
  ].join('\n');
}

function sumTokenUsage(summary: TuiSessionUsageSummary): number {
  return (summary.inputTokens ?? 0) + (summary.outputTokens ?? 0) + (summary.reasoningTokens ?? 0);
}

function formatInspectionReport(report: TranscriptInspectionReport): string {
  const lines = [report.title];
  for (const section of report.sections) {
    for (const row of section.rows) lines.push(`${row.label}: ${row.value}`);
  }
  if (report.warnings?.length) {
    lines.push('', 'Warnings:', ...report.warnings.map((warning) => `- ${warning}`));
  }
  if (report.footer) lines.push('', report.footer);
  return lines.join('\n');
}

function accountStatusBadge(
  status: TuiAccountStatus['status'] | 'unknown',
): NonNullable<TranscriptInspectionReport['badge']> {
  if (status === 'ready') return { label: 'READY', tone: 'success' };
  if (status === 'needs-login') return { label: 'SIGN IN', tone: 'warning' };
  if (status === 'warning') return { label: 'WARNING', tone: 'warning' };
  return { label: 'UNAVAILABLE', tone: 'error' };
}

function accountStatusTone(
  status: TuiAccountStatus['status'] | 'unknown',
): TranscriptInspectionTone {
  if (status === 'ready') return 'success';
  if (status === 'needs-login' || status === 'warning') return 'warning';
  return 'error';
}

function runtimeStatusTone(status: string): TranscriptInspectionTone {
  const normalized = status.toLowerCase();
  if (normalized === 'ok' || normalized === 'ready' || normalized === 'healthy') return 'success';
  if (normalized.includes('warn') || normalized.includes('degraded')) return 'warning';
  if (normalized === 'unknown') return 'neutral';
  return 'error';
}

function formatSkillSource(value: number | undefined): string | undefined {
  if (value === 1) return 'official';
  if (value === 2) return 'user';
  return value === undefined ? undefined : `source ${value}`;
}

export function classifyTuiSkillSource(skill: TuiSkill): 'builtin' | 'user' | 'other' {
  if (skill.sourceKind?.startsWith('builtin') || skill.sourceType === 1) return 'builtin';
  if (skill.sourceKind || skill.sourceType === 2) return 'user';
  return 'other';
}

function formatSkillSummary(skill: TuiSkill): string {
  const name = skill.displayName ?? skill.name;
  const state = skill.enabled === false ? 'disabled' : 'enabled';
  const source = skill.sourceKind ?? formatSkillSource(skill.sourceType) ?? 'unknown source';
  const description = skill.displayDescription ?? skill.description;
  return `${safe(name)} · ${state} · ${safe(source)}${
    description ? `\n  ${safe(description)}` : ''
  }`;
}

function presence(value: boolean | undefined): string {
  return value === true ? 'present' : value === false ? 'missing' : 'unknown';
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatCreditAmount(value: string): string {
  const normalized = value.replace(/,/gu, '').trim();
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(normalized);
  if (!match) return '0';
  const integer = (match[1] ?? '0').replace(/^0+(?=\d)/u, '');
  return integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

function positiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function contextComponentLabel(
  kind: NonNullable<TuiContextSnapshotResponse['contextUsage']>['components'][number]['kind'],
): string {
  if (kind === 'SYSTEM_PROMPT') return 'System prompt';
  if (kind === 'MEMORY') return 'Memory';
  if (kind === 'TOOLS') return 'Tools';
  if (kind === 'SKILLS') return 'Skills';
  if (kind === 'MESSAGES') return 'Messages';
  return 'Other';
}

function safe(value: string): string {
  return sanitizeTerminalText(value);
}

function safeInline(value: string): string {
  return safe(value).replace(/\s+/gu, ' ').trim();
}
