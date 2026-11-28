import { getConfig, getConfigPath, resetConfig, type ConfigIssue } from './config.js';
import { acknowledgeConfigResetAt } from './config-file-state.js';
import { configIssuesLostKinds } from './config-issue-copy.js';

/**
 * Called by a host after it told the user that config.yaml's settings were
 * lost. Until then every reader keeps reporting it. Afterwards the current
 * file, generated defaults, empty or none, counts as a fresh start.
 */
export function acknowledgeConfigReset(
  configPath = getConfigPath(),
  shown: { missing?: boolean; empty?: boolean } = { missing: true },
): void {
  acknowledgeConfigResetAt(configPath, shown);
  // The cached Config still carries the notice; the next read must not repeat it.
  resetConfig();
}

/**
 * The profile config.yaml's problems for an interactive host (Desktop window,
 * TUI transcript). Call `acknowledge` after showing them: it marks lost settings
 * as told, and does nothing for problems that remain until the file is fixed.
 */
export function readProfileConfigNotice(): {
  issues: readonly ConfigIssue[];
  configPath: string;
  acknowledge: () => void;
} {
  const configPath = getConfigPath();
  const issues = getConfig().configIssues;
  return {
    issues,
    configPath,
    acknowledge: () => {
      const shown = configIssuesLostKinds(issues);
      if (shown.missing || shown.empty) acknowledgeConfigReset(configPath, shown);
    },
  };
}
