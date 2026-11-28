import type { ConfigIssue } from './config.js';
import { configIssueMessage } from './config-file-state.js';

/**
 * Parses one config.yaml section so that a parser rejecting its input cannot
 * take the whole config down: a single bad value would otherwise stop every
 * runtime from starting, and a restart reads the same file again. The section
 * falls back to its default and the problem is pushed onto `configIssues`.
 * `fallback` is the last resort when even the section-free input is rejected;
 * sections whose parser also reads values resolved outside `source` pass one.
 */
export function createSectionFallback(raw: Record<string, unknown>, configIssues: ConfigIssue[]) {
  return <T>(
    keys: string | readonly string[],
    parse: (source: Record<string, unknown>) => T,
    fallback?: () => T,
  ): T => {
    try {
      return parse(raw);
    } catch (error) {
      const names = typeof keys === 'string' ? [keys] : keys;
      // Keys parsed together: drop only the one at fault when that is enough.
      for (const name of names.length > 1 ? names : []) {
        try {
          const value = parse({ ...raw, [name]: undefined });
          configIssues.push({
            kind: 'invalid_section',
            section: name,
            message: configIssueMessage(error),
          });
          return value;
        } catch {
          // Another key of the group is also at fault.
        }
      }
      // The whole group falls back: report every key, each with its own error
      // when it is at fault alone, so nothing is dropped without a notice.
      const withoutSection = { ...raw };
      for (const name of names) delete withoutSection[name];
      const faulty: string[] = [];
      const issues = names.map((name): ConfigIssue => {
        try {
          parse({ ...withoutSection, [name]: raw[name] });
          return { kind: 'invalid_section', section: name, message: '' };
        } catch (keyError) {
          faulty.push(name);
          return {
            kind: 'invalid_section',
            section: name,
            message: configIssueMessage(keyError),
          };
        }
      });
      const firstFaulty = faulty[0] ?? names[0];
      for (const issue of issues) {
        configIssues.push(
          issue.message
            ? issue
            : names.length > 1 && faulty.length > 0
              ? { ...issue, message: `Reset together with ${firstFaulty}` }
              : { ...issue, message: configIssueMessage(error) },
        );
      }
      try {
        return parse(withoutSection);
      } catch {
        try {
          return parse({});
        } catch (lastError) {
          if (fallback) return fallback();
          throw lastError;
        }
      }
    }
  };
}
