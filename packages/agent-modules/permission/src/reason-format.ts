/**
 * Localized DecisionReason formatter — produces the human-readable `reason`
 * strings emitted at the wire by `LocalPermissionFacade`.
 *
 * Templates are keyed by `'en' | 'zh'`. Default mode (no LLM) and auto mode
 * (with LLM prefix) MUST go through the same table so the two pipelines stay
 * in sync. When adding a new DecisionReason variant, add its template here
 * too — missing keys surface as a TypeScript error.
 */

import type { UserLocaleHint } from './locale-detect.js';
import type {
  PermissionBehavior,
  PermissionMode,
  PermissionRule,
  PermissionRuleSource,
  DecisionReason,
  SubcommandResult,
} from './types.js';

export type Lang = 'en' | 'zh';

export function localeOrDefault(locale: UserLocaleHint): Lang {
  return locale === 'zh' ? 'zh' : 'en';
}

const ACTION_LABEL: Record<Lang, Record<PermissionBehavior, string>> = {
  en: { allow: 'Allowed', ask: 'Needs confirmation', deny: 'Blocked' },
  zh: { allow: '已允许', ask: '需要确认', deny: '已拒绝' },
};

const BEHAVIOR_LABEL: Record<Lang, Record<PermissionBehavior, string>> = {
  en: { allow: 'allow', ask: 'ask', deny: 'deny' },
  zh: { allow: '允许', ask: '询问', deny: '拒绝' },
};

const SOURCE_LABEL: Record<Lang, Record<PermissionRuleSource, string>> = {
  en: { global: 'global', agent: 'agent', session: 'session' },
  zh: { global: '全局', agent: 'agent', session: '会话' },
};

const MODE_OFF_REASON: Record<Lang, string> = {
  en: 'Allowed: permission mode is off; permission review was skipped.',
  zh: '已允许：权限模式为 off，已跳过权限审查。',
};

const MODE_BYPASS_REASON: Record<Lang, string> = {
  en: 'Allowed: permission mode is bypassPermissions and no bypass-immune safety rule matched.',
  zh: '已允许：权限模式为 bypassPermissions，且未命中任何强制安全规则。',
};

function formatMode(lang: Lang, mode: PermissionMode): string {
  return lang === 'zh' ? `已允许：权限模式 ${mode} 放行。` : `Allowed by permission mode: ${mode}.`;
}

function formatWorkingDirectoryReason(
  behavior: PermissionBehavior | undefined,
  fsPath: string,
  lang: Lang,
): string {
  if (behavior === 'allow') {
    return lang === 'zh'
      ? `已允许：文件路径在已批准的读写边界内。路径：${fsPath}`
      : `Allowed: filesystem path is within an approved read/write boundary. Path: ${fsPath}`;
  }
  if (behavior === 'ask') {
    return lang === 'zh'
      ? `需要确认：文件路径在工作区或允许路径之外。路径：${fsPath}`
      : `Needs confirmation: filesystem path is outside the workspace or configured allow paths. Path: ${fsPath}`;
  }
  return lang === 'zh'
    ? `已拒绝：文件路径在工作区或允许路径之外。路径：${fsPath}`
    : `Blocked: filesystem path is outside the workspace or configured allow paths. Path: ${fsPath}`;
}

function formatInternalWhitelistReason(fsPath: string, lang: Lang): string {
  return lang === 'zh'
    ? `已允许：Mavis 内部托管路径。路径：${fsPath}`
    : `Allowed: internal Mavis-managed path. Path: ${fsPath}`;
}

function formatSessionOwnedReadablePathReason(fsPath: string, lang: Lang): string {
  return lang === 'zh'
    ? `已允许：当前会话自有的运行时产物路径。路径：${fsPath}`
    : `Allowed: runtime artifact path owned by the current session. Path: ${fsPath}`;
}

function formatTrustedExactWriteReason(fsPath: string, lang: Lang): string {
  return lang === 'zh'
    ? `已允许：当前 Turn 已授权写入精确路径。路径：${fsPath}`
    : `Allowed: the current turn allows writing the exact path. Path: ${fsPath}`;
}

function formatTempDirectoryReason(fsPath: string, lang: Lang): string {
  return lang === 'zh'
    ? `已允许：文件路径在临时目录内。路径：${fsPath}`
    : `Allowed: filesystem path is inside a temporary directory. Path: ${fsPath}`;
}

const SANDBOX_REASON: Record<Lang, string> = {
  en: 'Allowed: path is covered by the sandbox allow-list.',
  zh: '已允许：路径在 sandbox 允许列表内。',
};

function formatPathValidationReason(error: string, lang: Lang): string {
  return lang === 'zh'
    ? `已拒绝：文件路径非法。${error}`
    : `Blocked: invalid filesystem path. ${error}`;
}

function formatDangerousRemovalReason(fsPath: string, lang: Lang): string {
  return lang === 'zh'
    ? `已拒绝：危险删除目标。路径：${fsPath}`
    : `Blocked: dangerous removal target. Path: ${fsPath}`;
}

function formatRmRewriteReason(rewrittenCommand: string, lang: Lang): string {
  return lang === 'zh'
    ? `已允许：rm 命令已改写为 mavis-trash 以便恢复。原命令：${rewrittenCommand}`
    : `Allowed: rm command was rewritten to mavis-trash for recoverable deletion. Original command: ${rewrittenCommand}`;
}

const UNKNOWN_REASON: Record<Lang, string> = {
  en: 'Unknown reason',
  zh: '原因未知',
};

const EMPTY_BASH_REASON: Record<Lang, string> = {
  en: 'Allowed: empty bash command.',
  zh: '已允许：空的 bash 命令。',
};

function formatSubcommandSummary(
  prefix: string,
  command: string,
  detail: string,
  lang: Lang,
): string {
  return lang === 'zh'
    ? `${prefix}：bash 子命令 "${command}" 的判定。${detail}`
    : `${prefix}: bash subcommand decision for "${command}". ${detail}`;
}

function formatRuleDecisionReason(rule: PermissionRule, lang: Lang): string {
  const behavior = rule.ruleBehavior;
  const action = ACTION_LABEL[lang][behavior];
  const source = SOURCE_LABEL[lang][rule.source];
  const behaviorWord = BEHAVIOR_LABEL[lang][behavior];
  const scope = rule.ruleValue.ruleContent
    ? `${rule.ruleValue.toolName}(${rule.ruleValue.ruleContent})`
    : rule.ruleValue.toolName;
  return lang === 'zh'
    ? `${action}：命中 ${source} ${behaviorWord} 权限规则，作用域 ${scope}。`
    : `${action}: matched ${source} ${behaviorWord} permission rule for ${scope}.`;
}

function formatSafetyDecisionReason(
  description: string,
  behavior: PermissionBehavior | undefined,
  lang: Lang,
): string {
  if (
    /^(<system-reminder|Allowed|Blocked|Needs confirmation|Auto classifier|LLM classifier|No LLM client|⚠️|已允许|已拒绝|需要确认|⚠️ )/.test(
      description,
    )
  ) {
    return description;
  }
  if (behavior === 'allow') {
    return lang === 'zh' ? `已允许：${description}` : `Allowed: ${description}`;
  }
  if (behavior === 'deny') {
    return lang === 'zh' ? `已拒绝：${description}` : `Blocked: ${description}`;
  }
  return lang === 'zh' ? `需要确认：${description}` : `Needs confirmation: ${description}`;
}

function formatSubcommandDecisionReason(
  reasons: Map<string, SubcommandResult>,
  lang: Lang = 'en',
): string {
  if (reasons.size === 0) return EMPTY_BASH_REASON[lang];
  const priority: Record<PermissionBehavior, number> = { deny: 0, ask: 1, allow: 2 };
  const entries = [...reasons.entries()].sort(
    ([, a], [, b]) => priority[a.behavior] - priority[b.behavior],
  );
  const first = entries[0];
  if (!first) return EMPTY_BASH_REASON[lang];
  const [command, result] = first;
  const detail = formatDecisionReason(result.reason, result.behavior, lang);
  const prefix = ACTION_LABEL[lang][result.behavior];
  return formatSubcommandSummary(prefix, command, detail, lang);
}

/**
 * Render a `DecisionReason` (or bare `PermissionRule`) into a user-facing
 * string.
 */
export function formatDecisionReason(
  reason: PermissionRule | DecisionReason,
  behavior?: PermissionBehavior,
  locale: UserLocaleHint | Lang = 'en',
): string {
  const lang = localeOrDefault(locale as UserLocaleHint);
  if ('type' in reason) {
    switch (reason.type) {
      case 'rule':
        return formatRuleDecisionReason(reason.rule, lang);
      case 'safetyCheck':
        return formatSafetyDecisionReason(reason.description, behavior, lang);
      case 'mode':
        if (reason.mode === 'off') {
          return MODE_OFF_REASON[lang];
        }
        if (reason.mode === 'bypassPermissions') {
          return MODE_BYPASS_REASON[lang];
        }
        return formatMode(lang, reason.mode);
      case 'workingDirectory':
        return formatWorkingDirectoryReason(behavior, reason.path, lang);
      case 'internalWhitelist':
        return formatInternalWhitelistReason(reason.path, lang);
      case 'sessionOwnedReadablePath':
        return formatSessionOwnedReadablePathReason(reason.path, lang);
      case 'trustedExactWrite':
        return formatTrustedExactWriteReason(reason.path, lang);
      case 'tempDirectory':
        return formatTempDirectoryReason(reason.path, lang);
      case 'sandbox':
        return SANDBOX_REASON[lang];
      case 'pathValidation':
        return formatPathValidationReason(reason.error, lang);
      case 'dangerousRemoval':
        return formatDangerousRemovalReason(reason.path, lang);
      case 'subcommandResults':
        return formatSubcommandDecisionReason(reason.reasons, lang);
      case 'rmRewrite':
        return formatRmRewriteReason(reason.rewrittenCommand, lang);
      case 'recoverableDeleteRewrite':
        return formatRmRewriteReason(reason.targets.join(' '), lang);
      default:
        return UNKNOWN_REASON[lang];
    }
  }
  // Bare PermissionRule.
  return formatRuleDecisionReason(reason, lang);
}

// ---------------------------------------------------------------------------
// Auto-mode classifier prefixes (used by the LocalPermissionFacade
// cloud-gateway branch).
// ---------------------------------------------------------------------------

const AUTO_CLASSIFIER_ALLOW_PREFIX: Record<Lang, string> = {
  en: 'Auto classifier',
  zh: '自动判定',
};

const AUTO_CLASSIFIER_BLOCK_PREFIX: Record<Lang, string> = {
  en: '⚠️ Blocked by auto classifier; explicit confirmation required to continue',
  zh: '⚠️ 自动判定已阻止，需用户显式确认才能继续',
};

const AUTO_CLASSIFIER_CONFIRM_PREFIX: Record<Lang, string> = {
  en: 'Needs confirmation',
  zh: '需要确认',
};

const AUTO_CLASSIFIER_TIMEOUT_TEMPLATE: Record<Lang, (suffix: string) => string> = {
  en: (suffix) => `⚠️ Auto classifier timed out${suffix}; asking user to confirm.`,
  zh: (suffix) => `⚠️ 自动 classifier 超时${suffix}，请用户手动确认。`,
};

export function formatAutoClassifierReason(
  verdict: 'allow' | 'block' | 'confirm' | 'timeout',
  reasonText: string,
  locale: UserLocaleHint,
): string {
  const lang = localeOrDefault(locale);
  const sep = lang === 'zh' ? '：' : ': ';
  switch (verdict) {
    case 'allow':
      return `${AUTO_CLASSIFIER_ALLOW_PREFIX[lang]}${sep}${reasonText}`;
    case 'block':
      return `${AUTO_CLASSIFIER_BLOCK_PREFIX[lang]}${sep}${reasonText}`;
    case 'timeout':
      return AUTO_CLASSIFIER_TIMEOUT_TEMPLATE[lang](reasonText);
    case 'confirm':
    default:
      return `${AUTO_CLASSIFIER_CONFIRM_PREFIX[lang]}${sep}${reasonText}`;
  }
}

// ---------------------------------------------------------------------------
// Blocked-tool reason — the string handed to the LLM when a tool call is
// denied at `beforeToolCall`. The model reads this to decide how to recover
// (try another approach / explain to the user / drop a blocked rule), so the
// source is surfaced as a machine-readable tag.
// ---------------------------------------------------------------------------

/**
 * Where a tool-call denial originated. Surfaced to the LLM so it can tell a
 * user veto apart from a configured rule apart from a built-in safety wall.
 *
 *   - `user`          — the user rejected the call in the confirmation dialog
 *                       (includes auto-mode cloud `block` that was downgraded
 *                       to ask and then rejected).
 *   - `rule`          — matched a user-configured `deny` permission rule.
 *   - `safety`        — matched a built-in safety boundary (HARD final-deny,
 *                       dangerous removal, invalid path, …).
 *   - `safety-immune` — bypass-immune safety deny (UNC / network share,
 *                       `rm -rf /`, `rm -rf ~`). Cannot be relaxed by any mode.
 */
export type ToolDenialSource = 'user' | 'rule' | 'safety' | 'safety-immune';

export interface BlockedToolReasonInput {
  source: ToolDenialSource;
  toolName: string;
  /**
   * Already-localized decision reason for non-user denials — the engine /
   * facade output from {@link formatDecisionReason}. Rendered as the body.
   */
  detail?: string;
  /**
   * Already-localized reason the confirmation was raised in the first place
   * (original safety / cloud-classifier text), carried through on a `user`
   * denial so the model knows what the user vetoed.
   */
  trigger?: string;
}

/**
 * Render the LLM-facing denial string. The leading `[permission:denied
 * source=<source>]` tag is intentionally fixed English so the model (and log
 * greps) can parse the origin regardless of the user's locale; the trailing
 * body reuses the already-localized `detail` / `trigger` text verbatim.
 */
export function formatBlockedToolReason(input: BlockedToolReasonInput): string {
  const { source, toolName, detail, trigger } = input;
  const tag = `[permission:denied source=${source}]`;
  if (source === 'user') {
    const base = `${tag} User rejected the \`${toolName}\` call in the confirmation dialog.`;
    return trigger ? `${base} Trigger: ${trigger}` : base;
  }
  const body = detail && detail.trim().length > 0 ? detail : `\`${toolName}\` call was denied.`;
  return `${tag} ${body}`;
}
