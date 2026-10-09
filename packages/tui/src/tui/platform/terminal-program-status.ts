import type { Terminal } from '../engine/public.js';
import type { TuiAgentStatus } from '../shell/status-protocol.js';

export type TuiProgramStatus = TuiAgentStatus | 'auth';

const REPORTS: Record<TuiProgramStatus, string> = {
  ready: 'state=idle',
  run: 'state=working',
  perm: 'state=blocked:kind=permission',
  plan: 'state=blocked:kind=permission',
  ask: 'state=blocked:kind=question',
  auth: 'state=blocked:kind=auth',
  done: 'state=done',
  fail: 'state=error',
  error: 'state=error',
  cancel: 'state=idle',
};

/** Optional OSC 7501 output for the interactive TUI's root record. */
export class TuiTerminalProgramStatus {
  private active = false;
  private disposed = false;
  private lastReport?: string;

  constructor(
    private readonly terminal: Pick<Terminal, 'write'>,
    private readonly isTTY: boolean,
  ) {}

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    if (!active) {
      if (this.lastReport !== undefined) this.update('ready');
      this.lastReport = undefined;
    }
    this.active = active;
  }

  update(status: TuiProgramStatus): void {
    if (!this.active || this.disposed || !this.isTTY) return;
    const report = REPORTS[status];
    if (report === undefined || report === this.lastReport) return;
    try {
      // Detection is optional in OSC 7501 revision 0.3. Unknown OSCs are ignored.
      // Only fixed metadata is sent; prompts, output and credentials stay in the TUI.
      this.terminal.write(`\u001b]7501;${report}:app=mcode\u001b\\`);
      this.lastReport = report;
    } catch {
      // Optional status output must not interrupt a Turn or interaction.
    }
  }

  dispose(): void {
    // Completed results survive process exit. An interrupted live TUI is idle.
    if (
      this.lastReport !== undefined &&
      this.lastReport !== REPORTS.done &&
      this.lastReport !== REPORTS.error
    ) {
      this.update('ready');
    }
    this.active = false;
    this.disposed = true;
  }
}
