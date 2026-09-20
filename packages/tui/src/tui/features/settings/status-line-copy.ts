import { getRuntimeLocaleLanguage } from '@mavis/shared/runtime-i18n';
import type { TuiStatusLineItem } from '../../shell/status-line-items.js';

const en = {
  title: 'Status Line',
  search: 'Search',
  preview: 'Preview',
  defaults: 'Defaults',
  unavailable: 'No current data; hidden until available.',
  empty: 'Status line hidden',
  noMatches: 'No matching items',
  saving: 'Saving…',
  failed: 'Could not save. Check config.yaml syntax and permissions; previous settings kept.',
  locked: 'build-mode is startup-only. Edit config.yaml and restart to change it.',
  help: 'Space toggle · ←/→ reorder · Enter save · Esc cancel',
  compactHelp: 'Space · ←→ · Enter · Esc',
  reset: 'Ctrl+R restores defaults; type to search',
  filtered: 'Clear search before reordering',
  custom: 'Uses the saved command. Starts only after saving; preview never runs it.',
  close: 'Enter / Esc close',
} as const;
const zh: Record<keyof typeof en, string> = {
  title: '状态栏',
  search: '搜索',
  preview: '预览',
  defaults: '默认配置',
  unavailable: '当前无数据，有数据时才显示。',
  empty: '状态栏已隐藏',
  noMatches: '没有匹配项',
  saving: '正在保存…',
  failed: '保存失败，请检查 config.yaml 语法和权限；原设置已保留。',
  locked: 'build-mode 仅在启动时生效，请修改 config.yaml 后重启。',
  help: 'Space 勾选 · ←/→ 排序 · Enter 保存 · Esc 取消',
  compactHelp: 'Space · ←→ · Enter · Esc',
  reset: 'Ctrl+R 恢复默认；输入文字搜索',
  filtered: '清空搜索后才能排序',
  custom: '使用已配置的命令，保存后才启动；预览不会执行命令。',
  close: 'Enter / Esc 关闭',
};

const descriptions: Record<Exclude<TuiStatusLineItem, 'build-mode'>, readonly [string, string]> = {
  'current-dir': ['Current working directory', '当前工作目录'],
  'session-title': ['Current session title', '当前会话标题'],
  'git-branch': ['Current Git branch', '当前 Git 分支'],
  'review-link': ['Current branch PR / MR link', '当前分支的 PR / MR 链接'],
  'plan-mode': ['Plan mode', '计划模式'],
  'approval-mode': ['Current permission mode', '当前权限模式'],
  'model-with-reasoning': ['Model and reasoning', '模型和推理配置'],
  model: ['Model name', '模型名称'],
  'context-window': ['Context window capacity', '上下文总容量'],
  subagent: ['Subagent identity', '子 Agent 身份'],
  'token-quota': ['Account token quota', '账户额度'],
  'cache-read-ratio': ['Session cache read ratio', '会话缓存读取比例'],
  'context-remaining': ['Remaining context window', '剩余上下文窗口'],
  'context-meter': ['Remaining context gauge', '剩余上下文刻度条'],
  'custom-command': ['Configured custom command output', '已配置的自定义命令输出'],
};

function isChinese(locale?: string): boolean {
  return (
    getRuntimeLocaleLanguage(locale ?? Intl.DateTimeFormat().resolvedOptions().locale) === 'zh'
  );
}

export function statusLineText(key: keyof typeof en, locale?: string): string {
  return isChinese(locale) ? zh[key] : en[key];
}

export function statusLineItemDescription(
  item: Exclude<TuiStatusLineItem, 'build-mode'>,
  locale?: string,
): string {
  return descriptions[item][isChinese(locale) ? 1 : 0];
}
