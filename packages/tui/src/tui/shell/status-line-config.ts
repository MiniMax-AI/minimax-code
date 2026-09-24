import path from 'node:path';
import type { TuiNotificationSettings } from '../platform/terminal-notifications.js';

import type { TuiCustomStatusLineConfig } from '../../host/custom-status-command.js';

export interface TuiPresentationConfig {
  readonly terminalTitle?: readonly string[] | null;
  readonly showTips?: boolean;
  readonly statusLineItems?: readonly string[];
  readonly notifications?: TuiNotificationSettings;
  readonly customStatusLine?: TuiCustomStatusLineConfig;
}

/**
 * Reads presentation-only TUI settings from the Runtime config in `dataDir`.
 *
 * These settings are presentation-only, so this read is best-effort: a missing,
 * unreadable, or malformed config must never block TUI startup. On any failure
 * this returns an empty object, which keeps default Tip visibility and status
 * line item order.
 *
 * Item ids are not validated here — the item catalog lives in the TUI shell and
 * ignores ids it does not recognize.
 */
export async function readTuiPresentationConfig(dataDir: string): Promise<TuiPresentationConfig> {
  try {
    const { loadConfigFromFile } = await import('@mavis/config');
    const config = loadConfigFromFile(path.join(dataDir, 'config.yaml'), { dataDir });
    const tui = config.tui;
    return {
      ...(tui?.terminalTitle !== undefined ? { terminalTitle: tui.terminalTitle } : {}),
      ...(typeof tui?.showTips === 'boolean' ? { showTips: tui.showTips } : {}),
      ...(Array.isArray(tui?.statusLine) ? { statusLineItems: tui.statusLine } : {}),
      ...(tui?.notifications ? { notifications: tui.notifications } : {}),
      // Config already validated the shape; a block without a command was dropped there.
      ...(tui?.customStatusLine?.command ? { customStatusLine: tui.customStatusLine } : {}),
    };
  } catch {
    return {};
  }
}
