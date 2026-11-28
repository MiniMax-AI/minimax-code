import type { ConfigIssue } from './config.js';

export type ConfigIssueLanguage = 'zh' | 'en';

/** A whole-file fallback that failed closed also limits plugins; say so. */
function withPluginsNote(issue: ConfigIssue, zh: boolean, line: string): string {
  if (!issue.failClosed) return line;
  return zh
    ? `${line}；插件禁用名单读不出来，本次只加载官方插件`
    : `${line}; the plugin deny-list could not be read, so only official plugins load this time`;
}

function describeFailClosed(issue: ConfigIssue, zh: boolean): string {
  switch (issue.section) {
    case 'plugins':
      return zh
        ? `plugins 无法读取，本次只加载官方插件（能读出的禁用名单仍然生效）：${issue.message}`
        : `plugins could not be read, so only official plugins are loaded this time (readable forbidden names still apply): ${issue.message}`;
    case 'skillEvolve':
      return zh
        ? `skillEvolve 配置有误，本次已关闭：${issue.message}`
        : `skillEvolve is invalid and is off this time: ${issue.message}`;
    default:
      return zh
        ? `${issue.section ?? '部分配置'} 配置有误，本次已停用：${issue.message}`
        : `${issue.section ?? 'A setting'} is invalid and is off this time: ${issue.message}`;
  }
}

/**
 * One user-facing line for a config.yaml problem. Desktop and the TUI share this
 * wording so both hosts tell the user the same thing; each adds its own framing.
 */
export function describeConfigIssue(issue: ConfigIssue, language: ConfigIssueLanguage): string {
  const zh = language === 'zh';
  switch (issue.kind) {
    case 'invalid_section':
      // Only what config resolution reported as applied: never claim a
      // stricter fallback by section name alone.
      if (issue.failClosed) return describeFailClosed(issue, zh);
      return zh
        ? `${issue.section ?? '部分配置'} 已改用默认值：${issue.message}`
        : `${issue.section ?? 'A setting'} was reset to its default: ${issue.message}`;
    case 'invalid_yaml': {
      const where = issue.line ? (zh ? `（第 ${issue.line} 行）` : ` (line ${issue.line})`) : '';
      return withPluginsNote(
        issue,
        zh,
        zh
          ? `文件不是合法的 YAML${where}，全部配置已改用默认值`
          : `The file is not valid YAML${where}; all settings use defaults`,
      );
    }
    case 'invalid_root':
      return withPluginsNote(
        issue,
        zh,
        zh
          ? '文件顶层不是键值映射，全部配置已改用默认值'
          : 'The file is not a key-value mapping; all settings use defaults',
      );
    case 'unreadable':
      return withPluginsNote(
        issue,
        zh,
        zh
          ? `无法读取文件${issue.code ? `（${issue.code}）` : ''}，全部配置已改用默认值`
          : `The file could not be read${issue.code ? ` (${issue.code})` : ''}; all settings use defaults`,
      );
    case 'missing':
      if (issue.fileInUse) {
        return zh
          ? '文件曾被删除，当前使用的是之后重新写入的配置；删除前的其他设置（如自定义模型、默认模型）可能需要重新配置'
          : 'The file was deleted and the one written afterwards is in use; other settings it held before, such as custom models, may need to be set up again';
      }
      return zh
        ? '文件曾被删除，其中的设置（如自定义模型、默认模型）已丢失，需要重新配置'
        : 'The file was deleted; the settings it held, such as custom models, are lost and need to be set up again';
    case 'empty':
      return zh
        ? '文件内容为空，全部配置已改用默认值'
        : 'The file is empty; all settings use defaults';
  }
}

/** The one place that lists which kinds mean config.yaml's settings were lost. */
const LOST_SETTINGS_KINDS = ['missing', 'empty'] as const;
type LostSettingsKind = (typeof LOST_SETTINGS_KINDS)[number];

function isLostSettingsIssue(
  issue: ConfigIssue,
): issue is ConfigIssue & { kind: LostSettingsKind } {
  return (LOST_SETTINGS_KINDS as readonly string[]).includes(issue.kind);
}

/** The lost-settings issues a host acknowledges once it has shown them. */
export function configIssuesLostKinds(
  issues: readonly ConfigIssue[],
): Partial<Record<LostSettingsKind, true>> {
  const kinds: Partial<Record<LostSettingsKind, true>> = {};
  for (const issue of issues) if (isLostSettingsIssue(issue)) kinds[issue.kind] = true;
  return kinds;
}

/**
 * Whether config.yaml's content is gone and defaults are in use. A lost file
 * whose replacement is in use (`fileInUse`) is the one exception.
 */
export function configIssuesLostFile(issues: readonly ConfigIssue[]): boolean {
  return issues.some((issue) => isLostSettingsIssue(issue) && !issue.fileInUse);
}

/**
 * The full notice both hosts show: Desktop puts it in a dialog, the TUI in a
 * transcript warning. Only the bullet and layout differ between them.
 */
export function describeConfigNotice(
  issues: readonly ConfigIssue[],
  language: ConfigIssueLanguage,
  configPath: string,
): { title: string; summary: string; lines: string[]; footer: string } {
  const zh = language === 'zh';
  const lost = configIssuesLostFile(issues);
  const replaced = !lost && configIssuesLostKinds(issues).missing === true;
  return {
    title: zh ? '配置文件有误' : 'Configuration problem',
    summary: replaced
      ? zh
        ? 'config.yaml 曾被删除，MiniMax Code 正在使用之后重新写入的配置。'
        : 'config.yaml was deleted earlier; MiniMax Code uses the file written afterwards.'
      : lost
        ? zh
          ? 'config.yaml 中的配置已丢失，MiniMax Code 已改用默认值启动。'
          : 'Settings in config.yaml were lost. MiniMax Code started with defaults.'
        : zh
          ? 'config.yaml 中有配置无法使用，MiniMax Code 已对这些配置改用默认值启动（原文件未被修改）。'
          : 'Some settings in config.yaml could not be used. MiniMax Code started with defaults for them (the file was not changed).',
    lines: issues.map((issue) => describeConfigIssue(issue, language)),
    footer:
      lost || replaced
        ? zh
          ? `可以在 ${configPath} 或设置中重新配置。`
          : `Set them up again in ${configPath} or in Settings.`
        : zh
          ? `修正 ${configPath} 并保存后重启即可生效。`
          : `Fix ${configPath}, save it, and restart to apply it.`,
  };
}
