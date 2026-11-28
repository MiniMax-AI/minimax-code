import type {
  TuiAdvisor,
  TuiAdvisorSelection,
  TuiConfigurationPort,
  TuiModel,
} from '../../../runtime/port.js';
import type { Component } from '../../rendering/component.js';
import type { TuiInteractionSurface } from '../../shell/interaction-surface.js';
import { TuiModelPicker } from '../../features/model/picker.js';
import { contextWindowOptions, formatContextWindow } from '../../features/model/context-window.js';
import { normalizeTuiEffortOptions } from '../../features/model/effort.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';

type AdvisorRuntime = Pick<
  TuiConfigurationPort,
  | 'listModels'
  | 'getAccountStatus'
  | 'getAdvisor'
  | 'selectAdvisor'
  | 'selectSessionAdvisor'
  | 'getAdvisorEnabled'
  | 'setAdvisorEnabled'
>;

export interface TuiAdvisorFlowOptions {
  readonly runtime: AdvisorRuntime;
  readonly surface: Pick<TuiInteractionSurface, 'show' | 'close'>;
  readonly currentSessionId: () => string | undefined;
  readonly append: (content: string, kind?: 'warning' | 'error') => void;
  readonly onChanged: () => void;
  readonly isStopped: () => boolean;
  /** Shown for official models while no MiniMax account is signed in. */
  readonly officialModelLoginHint: string;
}

/**
 * `/advisor` and the advisor the status line shows. Like `/model`, a choice is saved as the
 * new-conversation default and applied to the current Session; Runtime never copies the default
 * into a Session it creates, so a new Session gets it here before its first Turn. `/advisor on|off`
 * writes the global switch the Desktop setting also writes; while it is off Runtime reports every
 * Session's advisor as off, so the status line shows none. Runtime lists the new-conversation
 * default as stored even then (new Sessions copy it), so the welcome screen shows it off itself.
 */
export class TuiAdvisorFlow {
  private current: TuiAdvisor | undefined;
  /** Session scope: a reset drops every in-flight load, write and open picker. */
  private generation = 0;
  /** The latest read or write owns the value on screen. */
  private sequence = 0;
  private picker: Component | undefined;
  private welcomeSettlement: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: TuiAdvisorFlowOptions) {}

  /** The current Session's advisor, or the new-conversation default before a Session exists. */
  selected(): TuiAdvisor | undefined {
    return this.current;
  }

  async refresh(sessionId = this.options.currentSessionId()): Promise<void> {
    const getAdvisor = this.options.runtime.getAdvisor;
    if (!getAdvisor || this.isStopped()) return;
    const generation = this.generation;
    const sequence = ++this.sequence;
    let advisor: TuiAdvisor;
    let switchOn: boolean | undefined;
    try {
      [advisor, switchOn] = await Promise.all([
        getAdvisor.call(this.options.runtime, sessionId),
        // Only the default is listed regardless of the switch.
        sessionId ? undefined : this.options.runtime.getAdvisorEnabled?.().catch(() => undefined),
      ]);
    } catch {
      // The value only labels the status line; keep what is on screen.
      return;
    }
    if (sequence !== this.sequence || !this.isCurrentSession(sessionId, generation)) return;
    this.current = shownAdvisor(advisor, switchOn);
    this.options.onChanged();
  }

  reset(): void {
    this.generation += 1;
    this.sequence += 1;
    this.current = undefined;
    this.welcomeSettlement = Promise.resolve();
    this.closePicker();
  }

  stop(): void {
    this.stopped = true;
    this.reset();
  }

  closePicker(): void {
    const picker = this.picker;
    this.picker = undefined;
    if (picker) this.options.surface.close(picker);
  }

  closeOwnedPanel(panel: Component | undefined): void {
    if (panel === this.picker) this.picker = undefined;
  }

  /**
   * Copies the new-conversation default into a Session this TUI just created. A default with a
   * model is copied whether or not it is on, so `/advisor on` later needs no new pick. A failure
   * never blocks the Session; an enabled default that could not be applied is reported.
   */
  async copyDefaultToSession(sessionId: string): Promise<void> {
    const { getAdvisor, selectSessionAdvisor } = this.options.runtime;
    if (!getAdvisor || !selectSessionAdvisor || this.isStopped()) return;
    // A choice made on the welcome screen is the default this Session must start from.
    await this.welcomeSettlement;
    let defaults: TuiAdvisor | undefined;
    try {
      defaults = await getAdvisor.call(this.options.runtime);
      if (!defaults.providerId || !defaults.modelId) return;
      await selectSessionAdvisor.call(this.options.runtime, storedSelection(defaults), sessionId);
    } catch (error) {
      // An unread default falls back to what the welcome screen showed.
      if (this.isStopped() || !(defaults?.enabled ?? this.current?.enabled)) return;
      // The new Session runs without the advisor the welcome screen showed.
      this.sequence += 1;
      this.current = undefined;
      this.options.onChanged();
      this.options.append(
        formatTuiActionFailure(error, {
          summary: "Couldn't apply the default advisor to this session.",
          nextStep: 'Run /advisor to choose one.',
        }),
        'warning',
      );
    }
  }

  async show(args: string): Promise<void> {
    if (this.isStopped()) return;
    this.closePicker();
    const runtime = this.options.runtime;
    if (!runtime.getAdvisor || !runtime.selectAdvisor) {
      this.options.append(
        'This Runtime does not support the advisor; update Runtime to use /advisor.',
        'warning',
      );
      return;
    }
    const action = args.trim().toLocaleLowerCase();
    if (action && action !== 'on' && action !== 'off') {
      this.options.append('Usage: /advisor [on | off]', 'warning');
      return;
    }
    const sessionId = this.options.currentSessionId();
    const generation = this.generation;
    if (action) {
      const enabled = action === 'on';
      if (!(await this.writeSwitch(enabled, sessionId, generation))) return;
      await this.refresh(sessionId);
      if (this.isCurrentSession(sessionId, generation)) {
        this.options.append(describeSwitchChange(enabled, this.current));
      }
      return;
    }

    let models: TuiModel[];
    let advisor: TuiAdvisor;
    let managedTokenPresent = false;
    let switchOn: boolean | undefined;
    try {
      const [catalog, account, stored, effective] = await Promise.all([
        runtime.listModels(sessionId),
        runtime.getAccountStatus(sessionId).catch(() => undefined),
        runtime.getAdvisor(sessionId),
        runtime.getAdvisorEnabled?.().catch(() => undefined),
      ]);
      models = catalog;
      advisor = shownAdvisor(stored, effective);
      managedTokenPresent = account?.managedTokenPresent === true;
      switchOn = effective;
    } catch (error) {
      if (this.isCurrentSession(sessionId, generation)) {
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't load the advisor.",
            nextStep: 'Retry /advisor.',
          }),
          'warning',
        );
      }
      return;
    }
    if (!this.isCurrentSession(sessionId, generation)) return;
    this.sequence += 1;
    this.current = advisor;
    this.options.onChanged();

    const isCurrentPicker = () =>
      this.picker === picker && this.isCurrentSession(sessionId, generation);
    const picker: TuiModelPicker = new TuiModelPicker(
      projectAdvisorRoster(models, advisor),
      (model, effort) => {
        if (!isCurrentPicker()) return;
        this.closePicker();
        const contextLimit =
          contextWindowOptions(model).length > 1 ? model.contextLimit : undefined;
        void this.pick(
          {
            enabled: true,
            providerId: model.providerId,
            modelId: model.modelId,
            // A pick without an effort clears the stored one, as the desktop selector does: the
            // row may run without thinking, where Runtime would drop a kept effort anyway.
            thinking: effort?.trim() ? { effort: effort.trim() } : {},
            ...(contextLimit !== undefined ? { contextLimit } : {}),
          },
          { sessionId, generation, switchOff: switchOn === false },
        );
      },
      () => {
        this.options.surface.close(picker);
        if (this.picker === picker) this.picker = undefined;
      },
      {
        title: 'Advisor',
        hideProviderActions: true,
        leadingOption: {
          label: 'Off',
          description: 'The agent works without an advisor',
          selected: !advisor.enabled,
          onSelect: () => {
            if (!isCurrentPicker()) return;
            this.closePicker();
            void this.write({ enabled: false }, sessionId, generation);
          },
        },
        isUnavailable: (model) => model.providerKind === 'minimax-managed' && !managedTokenPresent,
        onUnavailable: () => this.options.append(this.options.officialModelLoginHint, 'warning'),
        requestRender: this.options.onChanged,
        ...(!managedTokenPresent && models.some((model) => model.providerKind === 'minimax-managed')
          ? { unavailableHint: this.options.officialModelLoginHint }
          : {}),
      },
    );
    this.picker = picker;
    this.options.surface.show(picker);
  }

  /** Picking a model is an explicit choice to use the advisor, so it also turns the switch on. */
  private async pick(
    selection: TuiAdvisorSelection,
    scope: {
      readonly sessionId?: string;
      readonly generation: number;
      readonly switchOff: boolean;
    },
  ): Promise<void> {
    const { sessionId, generation } = scope;
    if (scope.switchOff) {
      if (!(await this.writeSwitch(true, sessionId, generation))) return;
      if (this.isCurrentSession(sessionId, generation)) {
        this.options.append('Advisor turned on for all sessions.');
      }
    }
    await this.write(selection, sessionId, generation);
  }

  /** Writes the global switch; false when it could not, after saying why. */
  private async writeSwitch(
    enabled: boolean,
    sessionId: string | undefined,
    generation: number,
  ): Promise<boolean> {
    const setAdvisorEnabled = this.options.runtime.setAdvisorEnabled;
    let effective: boolean | undefined;
    try {
      effective = await setAdvisorEnabled?.call(this.options.runtime, enabled);
    } catch (error) {
      if (this.isCurrentSession(sessionId, generation)) {
        this.options.append(
          formatTuiActionFailure(error, {
            summary: enabled ? "Couldn't turn the advisor on." : "Couldn't turn the advisor off.",
            nextStep: `Retry /advisor ${enabled ? 'on' : 'off'}.`,
          }),
          'error',
        );
      }
      return false;
    }
    if (effective !== undefined) return true;
    if (this.isCurrentSession(sessionId, generation)) {
      this.options.append(
        'This Runtime cannot switch the advisor on or off; update Runtime to use /advisor on|off.',
        'warning',
      );
    }
    return false;
  }

  private async write(
    selection: TuiAdvisorSelection,
    sessionId: string | undefined,
    generation: number,
  ): Promise<void> {
    const selectAdvisor = this.options.runtime.selectAdvisor;
    if (!selectAdvisor) return;
    const sequence = ++this.sequence;
    const request = selectAdvisor.call(this.options.runtime, selection, sessionId);
    if (!sessionId) {
      this.welcomeSettlement = request.then(
        () => undefined,
        () => undefined,
      );
    }
    let advisor: TuiAdvisor;
    try {
      advisor = await request;
    } catch (error) {
      if (!this.isCurrentSession(sessionId, generation)) return;
      this.options.append(
        formatTuiActionFailure(error, {
          summary: selection.enabled
            ? "Couldn't turn the advisor on."
            : "Couldn't turn the advisor off.",
          nextStep: 'Retry /advisor.',
        }),
        'error',
      );
      void this.refresh(sessionId);
      return;
    }
    if (!this.isCurrentSession(sessionId, generation)) return;
    if (sequence === this.sequence) {
      this.current = advisor;
      this.options.onChanged();
    }
    this.options.append(describeAdvisorChange(advisor, sessionId));
  }

  private isCurrentSession(sessionId: string | undefined, generation: number): boolean {
    return (
      !this.isStopped() &&
      generation === this.generation &&
      this.options.currentSessionId() === sessionId
    );
  }

  private isStopped(): boolean {
    return this.stopped || this.options.isStopped();
  }
}

/** The write that reproduces a stored advisor, e.g. the default copied into a new Session. */
function storedSelection(advisor: TuiAdvisor): TuiAdvisorSelection {
  return {
    enabled: advisor.enabled,
    ...(advisor.providerId && advisor.modelId
      ? { providerId: advisor.providerId, modelId: advisor.modelId }
      : {}),
    ...(advisor.thinking?.effort ? { thinking: { effort: advisor.thinking.effort } } : {}),
    ...(advisor.contextLimit !== undefined ? { contextLimit: advisor.contextLimit } : {}),
  };
}

/**
 * The `/model` roster seen from the advisor. Rows start from the advisor's own stored effort and
 * window rather than the main model's, the advisor's model is the selected row only while it is
 * on, and the Thinking switch is fixed at the model's default because an advisor stores effort and
 * window only.
 */
export function projectAdvisorRoster(
  models: readonly TuiModel[],
  advisor: TuiAdvisor | undefined,
): TuiModel[] {
  return models.map((model) => {
    const row: TuiModel = { ...model };
    delete row.selected;
    delete row.variant;
    delete row.supportedVariants;
    delete row.thinking;
    fixAdvisorThinking(row);
    if (advisor?.providerId !== model.providerId || advisor.modelId !== model.modelId) return row;
    if (advisor.enabled) row.selected = true;
    if (advisor.contextLimit !== undefined) row.contextLimit = advisor.contextLimit;
    const effort = advisor.thinking?.effort;
    // The picker starts a row at its default effort; for this row that is the stored one.
    if (effort && normalizeTuiEffortOptions(row.effortOptions).includes(effort)) {
      row.defaultEffort = effort;
    }
    return row;
  });
}

/**
 * The advisor request carries no variant, so the runtime runs a switchable model at its default,
 * which ListModels reports resolved: the row shows that fixed state, and offers effort only where
 * the model thinks, since the runtime drops it otherwise. The desktop advisor menu does the same.
 */
function fixAdvisorThinking(row: TuiModel): void {
  const config = row.thinkingConfig;
  if (config?.mode === 'switchable') {
    row.thinkingConfig = {
      ...config,
      mode: config.defaultValue === 'true' ? 'forced_on' : 'forced_off',
    };
  }
  if (row.thinkingConfig?.mode !== 'forced_off') return;
  delete row.effortOptions;
  delete row.defaultEffort;
}

const ADVISOR_SENDS_CONVERSATION =
  ' The full conversation, including tool results and images, is sent to this model.';

/** No advisor runs while the global switch is off, whatever the listed one says. */
function shownAdvisor(advisor: TuiAdvisor, switchOn: boolean | undefined): TuiAdvisor {
  return switchOn === false && advisor.enabled ? { ...advisor, enabled: false } : advisor;
}

function describeSwitchChange(enabled: boolean, advisor: TuiAdvisor | undefined): string {
  if (!enabled) {
    return 'Advisor turned off for all sessions. Their advisor choices are kept for /advisor on.';
  }
  if (advisor?.enabled && advisor.providerId && advisor.modelId) {
    return `Advisor turned on for all sessions. This one uses ${advisor.providerId}/${advisor.modelId}.`;
  }
  return 'Advisor turned on for all sessions. Run /advisor to choose a model for this one.';
}

function describeAdvisorChange(advisor: TuiAdvisor, sessionId: string | undefined): string {
  const scope = sessionId ? ' for this session and saved as the default' : ' as the default';
  if (!advisor.enabled || !advisor.providerId || !advisor.modelId) return `Advisor off${scope}.`;
  const effort = advisor.thinking?.effort ? ` · Effort ${advisor.thinking.effort}` : '';
  const context = advisor.contextLimit
    ? ` · Context ${formatContextWindow(advisor.contextLimit)}`
    : '';
  // Said on every enable: the advisor receives what the main model sees, not a summary.
  return `Advisor on: ${advisor.providerId}/${advisor.modelId}${effort}${context}${scope}.${ADVISOR_SENDS_CONVERSATION}`;
}
