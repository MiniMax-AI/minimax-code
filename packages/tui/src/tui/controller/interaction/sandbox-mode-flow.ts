import { describeSandboxMode, type EffectiveSandboxMode, type SandboxMode } from '@mavis/config';

import type { TuiConfigurationPort } from '../../../runtime/port.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';

export interface TuiSandboxModeSnapshot {
  readonly effective: EffectiveSandboxMode | undefined;
  readonly updating: boolean;
}

export interface TuiSandboxModeFlowOptions {
  readonly runtime: Pick<TuiConfigurationPort, 'getSandboxMode' | 'setSandboxMode'>;
  readonly append: (content: string, kind?: 'final-summary' | 'warning' | 'error') => void;
  readonly setHint: (message: string | undefined) => void;
  readonly onChanged: () => void;
  readonly isStopped?: () => boolean;
}

/** Owns `/sandbox` independently from the permission/approval policy. */
export class TuiSandboxModeFlow {
  private effectiveValue: EffectiveSandboxMode | undefined;
  private updatingValue = false;
  private refreshSequence = 0;
  private mutationSequence = 0;
  private stopped = false;

  constructor(private readonly options: TuiSandboxModeFlowOptions) {}

  snapshot(): TuiSandboxModeSnapshot {
    return { effective: this.effectiveValue, updating: this.updatingValue };
  }

  async refresh(): Promise<void> {
    const refreshSequence = ++this.refreshSequence;
    const mutationSequence = this.mutationSequence;
    const effective = await this.options.runtime.getSandboxMode();
    if (
      this.isStopped() ||
      refreshSequence !== this.refreshSequence ||
      mutationSequence !== this.mutationSequence ||
      this.updatingValue
    ) {
      return;
    }
    this.effectiveValue = effective;
    this.options.onChanged();
  }

  async set(nextMode: SandboxMode): Promise<void> {
    if (this.isStopped() || this.updatingValue) return;
    this.updatingValue = true;
    const mutationSequence = ++this.mutationSequence;
    this.refreshSequence += 1;
    this.options.setHint(`Switching sandbox to ${nextMode}…`);
    this.options.onChanged();
    try {
      const effective = await this.options.runtime.setSandboxMode(nextMode);
      if (this.isStopped() || mutationSequence !== this.mutationSequence) return;
      this.effectiveValue = effective;
      this.options.setHint(undefined);
      this.options.append(`Sandbox mode: ${describeSandboxMode(effective)}.`);
    } catch (error) {
      if (this.isStopped() || mutationSequence !== this.mutationSequence) return;
      this.options.append(
        formatTuiActionFailure(error, {
          summary: `Sandbox mode was not changed to ${nextMode}.`,
          nextStep: 'Retry /sandbox, or check whether this platform supports the sandbox.',
        }),
        'warning',
      );
      this.options.setHint('Sandbox mode unchanged');
    } finally {
      if (!this.isStopped() && mutationSequence === this.mutationSequence) {
        this.updatingValue = false;
        this.options.onChanged();
      }
    }
  }

  showStatus(): void {
    this.options.append(
      this.effectiveValue
        ? `Sandbox mode: ${describeSandboxMode(this.effectiveValue)}.`
        : 'Sandbox mode is unavailable in this host.',
    );
  }

  stop(): void {
    this.stopped = true;
    this.refreshSequence += 1;
    this.mutationSequence += 1;
    this.updatingValue = false;
  }

  private isStopped(): boolean {
    return this.stopped || Boolean(this.options.isStopped?.());
  }
}
