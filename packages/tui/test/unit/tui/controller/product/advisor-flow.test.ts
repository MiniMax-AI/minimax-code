import { describe, expect, it, vi } from 'vitest';

import type { TuiAdvisor, TuiAdvisorSelection, TuiModel } from '../../../../../src/runtime/port.js';
import {
  projectAdvisorRoster,
  TuiAdvisorFlow,
} from '../../../../../src/tui/controller/product/advisor-flow.js';
import { stripAnsi } from '../../../../../src/tui/rendering/text.js';
import { waitFor } from '../../../../helpers/wait-for.js';

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const ENTER = '\r';

const critic: TuiModel = {
  providerId: 'custom_provider:acme',
  modelId: 'critic',
  displayName: 'Acme Critic',
  effortOptions: ['low', 'medium', 'high'],
  contextLimit: 200_000,
};
/** The main model: the roster projects the main Session's effort and window onto its row. */
const main: TuiModel = {
  providerId: 'minimax',
  modelId: 'MiniMax-M3',
  displayName: 'MiniMax-M3',
  selected: true,
  variant: 'thinking',
  thinking: { effort: 'max' },
  thinkingConfig: { mode: 'switchable', defaultValue: 'true' },
  effortOptions: ['low', 'high', 'max'],
  contextLimit: 1_000_000,
  contextWindowOptions: [512_000, 1_000_000],
};

interface Picker {
  handleInput(data: string): void;
  render(width: number): string[];
}

function createHarness(
  options: {
    readonly advisor?: TuiAdvisor;
    readonly sessionId?: string | null;
    /** The global switch; Runtime reports every advisor as off while it is off. */
    readonly switchOn?: boolean;
  } = {},
) {
  const sessionId = options.sessionId === null ? undefined : (options.sessionId ?? 'session-a');
  const shown: Picker[] = [];
  const append = vi.fn();
  const view = (selection: TuiAdvisorSelection): TuiAdvisor => ({
    enabled: selection.enabled,
    ...(selection.providerId ? { providerId: selection.providerId } : {}),
    ...(selection.modelId ? { modelId: selection.modelId } : {}),
    ...(selection.thinking?.effort ? { thinking: { effort: selection.thinking.effort } } : {}),
    ...(selection.contextLimit ? { contextLimit: selection.contextLimit } : {}),
  });
  let switchOn = options.switchOn ?? true;
  const runtime = {
    listModels: vi.fn(async () => [critic, main]),
    getAccountStatus: vi.fn(async () => ({
      status: 'ready' as const,
      managedTokenPresent: true,
      warnings: [],
    })),
    // Runtime lists a Session's advisor as off while the switch is off, and the
    // new-conversation default as stored, since new Sessions copy it.
    getAdvisor: vi.fn(
      async (forSession?: string): Promise<TuiAdvisor> =>
        switchOn || !forSession ? (options.advisor ?? { enabled: false }) : { enabled: false },
    ),
    selectAdvisor: vi.fn(async (selection: TuiAdvisorSelection) => view(selection)),
    selectSessionAdvisor: vi.fn(async (selection: TuiAdvisorSelection) => view(selection)),
    getAdvisorEnabled: vi.fn(async (): Promise<boolean | undefined> => switchOn),
    setAdvisorEnabled: vi.fn(async (enabled: boolean): Promise<boolean | undefined> => {
      switchOn = enabled;
      return enabled;
    }),
  };
  const flow = new TuiAdvisorFlow({
    runtime,
    surface: { show: (panel) => shown.push(panel as unknown as Picker), close: () => true },
    currentSessionId: () => sessionId,
    append,
    onChanged: vi.fn(),
    isStopped: () => false,
    officialModelLoginHint: 'Sign in with /login to use official MiniMax models.',
  });
  return { append, flow, runtime, shown };
}

function render(picker: Picker | undefined): string {
  return stripAnsi(picker?.render(100).join('\n') ?? '');
}

describe('TuiAdvisorFlow', () => {
  it('turns the advisor on for the first time only through a model pick', async () => {
    const harness = createHarness();

    await harness.flow.show('');
    const picker = harness.shown[0];
    const rendered = render(picker);
    expect(rendered).toContain('Advisor');
    expect(rendered).toContain('● Off');
    // The advisor only chooses among configured models.
    expect(rendered).not.toContain('Add 3rd-party provider');

    picker?.handleInput(DOWN);
    picker?.handleInput(ENTER);

    await waitFor(() =>
      expect(harness.runtime.selectAdvisor).toHaveBeenCalledWith(
        {
          enabled: true,
          providerId: 'custom_provider:acme',
          modelId: 'critic',
          thinking: { effort: 'medium' },
        },
        'session-a',
      ),
    );
    await waitFor(() =>
      expect(harness.append).toHaveBeenCalledWith(
        'Advisor on: custom_provider:acme/critic · Effort medium for this session and saved as the default. The full conversation, including tool results and images, is sent to this model.',
      ),
    );
    expect(harness.flow.selected()).toMatchObject({ enabled: true, modelId: 'critic' });
    // The switch was already on, so the pick leaves it alone.
    expect(harness.runtime.setAdvisorEnabled).not.toHaveBeenCalled();
  });

  it('turns the global switch off and on with `/advisor off` and `/advisor on`', async () => {
    const harness = createHarness({
      advisor: { enabled: true, providerId: 'custom_provider:acme', modelId: 'critic' },
    });

    await harness.flow.show('off');

    expect(harness.runtime.setAdvisorEnabled).toHaveBeenCalledWith(false);
    expect(harness.runtime.selectAdvisor).not.toHaveBeenCalled();
    expect(harness.shown).toHaveLength(0);
    expect(harness.append).toHaveBeenCalledWith(
      'Advisor turned off for all sessions. Their advisor choices are kept for /advisor on.',
    );
    // Runtime reports the advisor off, so the status line drops it.
    expect(harness.flow.selected()).toEqual({ enabled: false });

    await harness.flow.show('on');

    expect(harness.runtime.setAdvisorEnabled).toHaveBeenLastCalledWith(true);
    expect(harness.runtime.selectAdvisor).not.toHaveBeenCalled();
    expect(harness.append).toHaveBeenCalledWith(
      'Advisor turned on for all sessions. This one uses custom_provider:acme/critic.',
    );
    expect(harness.flow.selected()).toMatchObject({ enabled: true, modelId: 'critic' });
  });

  it('points `/advisor on` at the picker when this session has no advisor model', async () => {
    const harness = createHarness({ switchOn: false });

    await harness.flow.show('on');

    expect(harness.runtime.setAdvisorEnabled).toHaveBeenCalledWith(true);
    expect(harness.append).toHaveBeenCalledWith(
      'Advisor turned on for all sessions. Run /advisor to choose a model for this one.',
    );
  });

  it('turns the switch on first when a model is picked while it is off', async () => {
    const harness = createHarness({ switchOn: false });

    await harness.flow.show('');
    const picker = harness.shown[0];
    // Runtime reports the advisor off while the switch is off.
    expect(render(picker)).toContain('● Off');
    picker?.handleInput(DOWN);
    picker?.handleInput(ENTER);

    await waitFor(() =>
      expect(harness.runtime.selectAdvisor).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true, modelId: 'critic' }),
        'session-a',
      ),
    );
    expect(harness.runtime.setAdvisorEnabled).toHaveBeenCalledWith(true);
    expect(harness.runtime.setAdvisorEnabled.mock.invocationCallOrder[0]).toBeLessThan(
      harness.runtime.selectAdvisor.mock.invocationCallOrder[0]!,
    );
    expect(harness.append).toHaveBeenCalledWith('Advisor turned on for all sessions.');
  });

  it('reports a Runtime that cannot write the switch', async () => {
    const harness = createHarness();
    harness.runtime.setAdvisorEnabled.mockResolvedValueOnce(undefined);

    await harness.flow.show('off');

    expect(harness.append).toHaveBeenCalledWith(
      'This Runtime cannot switch the advisor on or off; update Runtime to use /advisor on|off.',
      'warning',
    );
  });

  it('switches only this session and the default off from the Off row', async () => {
    const harness = createHarness({
      advisor: { enabled: true, providerId: 'custom_provider:acme', modelId: 'critic' },
    });

    await harness.flow.show('');
    const picker = harness.shown[0];
    const rendered = render(picker);
    expect(rendered).toContain('● Acme Critic');
    expect(rendered).not.toContain('● Off');
    picker?.handleInput(UP);
    picker?.handleInput(ENTER);

    await waitFor(() =>
      expect(harness.runtime.selectAdvisor).toHaveBeenCalledWith({ enabled: false }, 'session-a'),
    );
    await waitFor(() =>
      expect(harness.append).toHaveBeenCalledWith(
        'Advisor off for this session and saved as the default.',
      ),
    );
    expect(harness.runtime.setAdvisorEnabled).not.toHaveBeenCalled();
    expect(harness.flow.selected()).toEqual({ enabled: false });
  });

  it("starts the advisor's row from its own saved effort and window, not the main model's", async () => {
    const harness = createHarness({
      advisor: {
        enabled: true,
        providerId: 'minimax',
        modelId: 'MiniMax-M3',
        thinking: { effort: 'low' },
        contextLimit: 512_000,
      },
    });
    harness.runtime.selectAdvisor.mockImplementationOnce(async (selection) => ({
      ...selection,
      enabled: true,
      thinking: { effort: 'low' },
    }));

    await harness.flow.show('');
    const picker = harness.shown[0];
    // An advisor stores effort and window only, so the main model's Thinking switch is gone.
    expect(render(picker)).not.toContain('Thinking');
    picker?.handleInput(ENTER);

    await waitFor(() =>
      expect(harness.runtime.selectAdvisor).toHaveBeenCalledWith(
        {
          enabled: true,
          providerId: 'minimax',
          modelId: 'MiniMax-M3',
          thinking: { effort: 'low' },
          contextLimit: 512_000,
        },
        'session-a',
      ),
    );
    await waitFor(() =>
      expect(harness.append).toHaveBeenCalledWith(
        'Advisor on: minimax/MiniMax-M3 · Effort low · Context 512K for this session and saved as the default. The full conversation, including tool results and images, is sent to this model.',
      ),
    );
  });

  it('copies a default that has a model into a new Session and never fails Session creation', async () => {
    const saved = {
      enabled: false,
      providerId: 'custom_provider:acme',
      modelId: 'critic',
      thinking: { effort: 'high' },
      contextLimit: 200_000,
    };
    const withModel = createHarness({ advisor: saved });
    await withModel.flow.copyDefaultToSession('session-new');
    expect(withModel.runtime.getAdvisor).toHaveBeenCalledWith();
    expect(withModel.runtime.selectSessionAdvisor).toHaveBeenCalledWith(saved, 'session-new');
    expect(withModel.runtime.selectAdvisor).not.toHaveBeenCalled();

    const noModel = createHarness({ advisor: { enabled: false } });
    await noModel.flow.copyDefaultToSession('session-new');
    expect(noModel.runtime.selectSessionAdvisor).not.toHaveBeenCalled();

    const failing = createHarness({ advisor: { ...saved, enabled: true } });
    await failing.flow.refresh();
    failing.runtime.selectSessionAdvisor.mockRejectedValueOnce(new Error('model unavailable'));
    await expect(failing.flow.copyDefaultToSession('session-new')).resolves.toBeUndefined();
    expect(failing.append).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't apply the default advisor to this session"),
      'warning',
    );
    // The new Session has no advisor, so the welcome value leaves the status line.
    expect(failing.flow.selected()).toBeUndefined();
  });

  it('copies the welcome choice that is still being saved when the first Session is created', async () => {
    const harness = createHarness({ sessionId: null });
    let finishDefaultWrite: (() => void) | undefined;
    harness.runtime.selectAdvisor.mockImplementationOnce(
      (selection) =>
        new Promise((resolve) => {
          finishDefaultWrite = () => resolve({ ...selection, enabled: false });
        }),
    );

    // The welcome screen's Off row: a default write still in flight.
    await harness.flow.show('');
    harness.shown[0]?.handleInput(ENTER);
    const copy = harness.flow.copyDefaultToSession('session-new');
    await Promise.resolve();
    // Only the picker has read the default so far.
    expect(harness.runtime.getAdvisor).toHaveBeenCalledOnce();

    finishDefaultWrite?.();
    await copy;
    expect(harness.runtime.selectAdvisor).toHaveBeenCalledWith({ enabled: false }, undefined);
    expect(harness.runtime.getAdvisor).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(harness.append).toHaveBeenCalledWith('Advisor off as the default.'));
  });
});

describe('advisor defaults and one-step enable', () => {
  it('shows a stored default off on the welcome screen while the switch is off', async () => {
    const harness = createHarness({
      sessionId: null,
      switchOn: false,
      advisor: { enabled: true, providerId: critic.providerId, modelId: critic.modelId },
    });

    await harness.flow.refresh();
    expect(harness.flow.selected()?.enabled).toBe(false);

    await harness.flow.show('');
    expect(render(harness.shown[0])).toContain('● Off');
    expect(harness.flow.selected()?.enabled).toBe(false);
  });

  it('reports a shown default it could not read while creating a Session', async () => {
    const harness = createHarness({
      advisor: { enabled: true, providerId: 'custom_provider:acme', modelId: 'critic' },
    });
    await harness.flow.refresh();
    expect(harness.flow.selected()).toMatchObject({ enabled: true });
    harness.runtime.getAdvisor.mockRejectedValueOnce(new Error('runtime offline'));

    await harness.flow.copyDefaultToSession('session-new');

    // The welcome screen showed the advisor on; the new Session runs without it.
    expect(harness.append).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't apply the default advisor to this session"),
      'warning',
    );
    expect(harness.flow.selected()).toBeUndefined();
  });
});

describe('advisor pick without effort', () => {
  it('clears a stored effort when the picked model runs without thinking', async () => {
    const lite: TuiModel = {
      providerId: 'minimax',
      modelId: 'MiniMax-Lite',
      displayName: 'MiniMax-Lite',
      thinkingConfig: { mode: 'switchable', defaultValue: 'false' },
      effortOptions: ['low', 'high'],
    };
    // Stored by an earlier client that still offered an effort for this model.
    const harness = createHarness({
      advisor: {
        enabled: true,
        providerId: 'minimax',
        modelId: 'MiniMax-Lite',
        thinking: { effort: 'high' },
      },
    });
    harness.runtime.listModels.mockResolvedValue([critic, main, lite]);

    await harness.flow.show('');
    harness.shown[0]?.handleInput(ENTER);

    await waitFor(() =>
      expect(harness.runtime.selectAdvisor).toHaveBeenCalledWith(
        { enabled: true, providerId: 'minimax', modelId: 'MiniMax-Lite', thinking: {} },
        'session-a',
      ),
    );
    await waitFor(() =>
      expect(harness.append).toHaveBeenCalledWith(
        'Advisor on: minimax/MiniMax-Lite for this session and saved as the default. The full conversation, including tool results and images, is sent to this model.',
      ),
    );
  });
});

describe('projectAdvisorRoster', () => {
  it('shows a switchable model at the default the runtime runs, with effort only where it thinks', () => {
    const lite: TuiModel = {
      providerId: 'minimax',
      modelId: 'MiniMax-Lite',
      displayName: 'MiniMax-Lite',
      thinkingConfig: { mode: 'switchable', defaultValue: 'false' },
      effortOptions: ['low', 'high'],
      defaultEffort: 'high',
    };
    const [on, off] = projectAdvisorRoster([main, lite], {
      enabled: true,
      providerId: 'minimax',
      modelId: 'MiniMax-Lite',
      thinking: { effort: 'high' },
    });

    expect(on).toMatchObject({
      thinkingConfig: { mode: 'forced_on' },
      effortOptions: ['low', 'high', 'max'],
    });
    // The advisor request carries no variant, so the runtime runs this model without thinking and
    // drops any effort: the row offers none, even though one is stored.
    expect(off?.thinkingConfig?.mode).toBe('forced_off');
    expect(off).not.toHaveProperty('effortOptions');
    expect(off).not.toHaveProperty('defaultEffort');
  });
});
