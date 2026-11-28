import type { RuntimeTranslations } from './en.js';

export const ZH_HANS_RUNTIME_TRANSLATIONS = {
  'plan.entry.title': '进入计划模式',
  'plan.entry.question': '要为此任务进入计划模式吗？',
  'plan.entry.confirm.label': '确认',
  'plan.entry.confirm.description': '在实施前先进行调研并制定计划。',
  'plan.entry.decline.label': '拒绝',
  'plan.entry.decline.description': '继续执行，不进入计划模式。',
  'plan.implementation.display': '实施此计划',
  'questionnaire.noAnswer': '未回答',
  'questionnaire.others': '其他',
  'nestedRuntime.deleteGuard':
    '此 Agent 会话已开启删除防护（沙箱文件系统模式“delete_guard”），无法在其中嵌套启动 MiniMax Code。嵌套 Runtime 可能在工作区外创建锁和归属文件，却无法删除它们，从而留下残留锁并阻塞后续启动。本次嵌套运行已在创建任何 Runtime 状态前停止。请在该 Agent 会话之外的终端运行 MiniMax Code。',
  'update.versionedInstalled':
    'MCode {version} 已安装。新启动的 MCode 会话将使用新版本，当前运行中的会话可以继续使用。',
} as const satisfies RuntimeTranslations;
