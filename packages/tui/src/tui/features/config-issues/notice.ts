import { describeConfigNotice, type ConfigIssue } from '@mavis/config';
import { getRuntimeLocaleLanguage } from '@mavis/shared/runtime-i18n';

/** Transcript warning for config.yaml problems, or undefined when it loaded cleanly. */
export function formatConfigIssueNotice(
  issues: readonly ConfigIssue[],
  configPath: string | undefined,
  locale?: string,
): string | undefined {
  if (issues.length === 0) return undefined;
  const language =
    getRuntimeLocaleLanguage(locale ?? Intl.DateTimeFormat().resolvedOptions().locale) === 'zh'
      ? 'zh'
      : 'en';
  const notice = describeConfigNotice(issues, language, configPath ?? 'config.yaml');
  return [notice.summary, ...notice.lines.map((line) => `- ${line}`), notice.footer].join('\n');
}
