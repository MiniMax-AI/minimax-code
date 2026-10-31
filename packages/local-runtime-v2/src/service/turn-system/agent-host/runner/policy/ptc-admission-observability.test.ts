import { describe, expect, it, vi } from 'vitest';

import { observePtcAdmission } from './ptc-admission-observability.js';
import { resetPtcPrefixBaseline } from './ptc-prefix-fingerprint.js';

type AdmissionInput = Parameters<typeof observePtcAdmission>[0];
type Prefix = Parameters<typeof observePtcAdmission>[3];

const READ = { def: { name: 'read', description: 'Read a file.', schema: { type: 'object' } } };
const RUN_CODE = {
  def: { name: 'run_code', description: 'Run a program.', schema: { type: 'object' } },
};
const PTC_PREFIX: Prefix = {
  systemPrompt: '# Tool calls in this turn (PTC)\nUse run_code.\n\n# Harness\n- rules',
  tools: [RUN_CODE],
  nativeCatalog: [READ],
};
const NATIVE_PREFIX: Prefix = { systemPrompt: '# Harness', tools: [READ], nativeCatalog: [READ] };
const FINGERPRINT_FIELDS = [
  'native_catalog_sha',
  'system_prompt_sha',
  'ptc_section_sha',
  'tools_sha',
  'run_code_sha',
];

let sessionCounter = 0;

function admissionInput(
  overrides: {
    readonly beta?: boolean;
    readonly source?: string;
    readonly sessionKind?: string;
    readonly sessionId?: string;
    readonly turnId?: string;
    readonly noProvenance?: boolean;
  } = {},
): AdmissionInput {
  return {
    lease: { sessionId: overrides.sessionId ?? 'session-1', turnId: overrides.turnId ?? 'turn-1' },
    request: overrides.noProvenance
      ? {}
      : { provenance: { source: overrides.source ?? 'api', routingFingerprint: 'fp' } },
    session: { sessionKind: overrides.sessionKind ?? 'conversation', parentSessionId: null },
    assemblyContext: {
      agentConfig: overrides.beta === false ? {} : { ptc_enabled: true },
    },
  } as unknown as AdmissionInput;
}

function admissionLine(
  input: AdmissionInput,
  admitted: boolean,
  surface?: 'desktop' | 'tui',
  prefix: Prefix = admitted ? PTC_PREFIX : NATIVE_PREFIX,
) {
  const info = vi.fn();
  observePtcAdmission(
    input,
    admitted,
    { logger: { info, warn: vi.fn() }, ...(surface ? { ptcSurface: surface } : {}) },
    prefix,
  );
  // At most one line per call; callers destructure it or compare with [].
  return info.mock.calls as unknown as [[Record<string, unknown>, string]];
}

function withoutFingerprint(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([key]) => !FINGERPRINT_FIELDS.includes(key)),
  );
}

function freshSession(): string {
  sessionCounter += 1;
  return `prefix-session-${sessionCounter}`;
}

describe('observePtcAdmission', () => {
  it('writes nothing on a Turn of a native-mode Session', () => {
    expect(admissionLine(admissionInput({ beta: false }), false)).toEqual([]);
  });

  it('records an admitted Turn with its surface, source and Session kind', () => {
    const [[fields, message]] = admissionLine(admissionInput(), true, 'desktop');
    expect(message).toBe('ptc admission');
    expect(withoutFingerprint(fields)).toEqual({
      session_id: 'session-1',
      turn_id: 'turn-1',
      admitted: true,
      reason: 'enabled',
      surface: 'desktop',
      source: 'api',
      session_kind: 'conversation',
    });
  });

  it.each([
    ['a cron Turn of a cron Session', { source: 'cron', sessionKind: 'cron' }],
    ['a Task child Turn', { source: 'task', sessionKind: 'task' }],
    ['a background completion', { source: 'background-task', sessionKind: 'conversation' }],
    ['a Goal continuation', { source: 'thread-goal', sessionKind: 'conversation' }],
    ['a code review', { source: 'code_review', sessionKind: 'task' }],
    ['an IM message', { source: 'channel:feishu', sessionKind: 'channel' }],
    ['a Peek question', { source: 'api', sessionKind: 'peek' }],
  ] as const)('admits %s the same way and names where it came from', (_case, facts) => {
    const [[fields]] = admissionLine(admissionInput(facts), true, 'desktop');
    expect(fields).toMatchObject({
      admitted: true,
      reason: 'enabled',
      source: facts.source,
      session_kind: facts.sessionKind,
    });
  });

  it('reports other when a PTC-mode Turn has no run_code', () => {
    const [[fields]] = admissionLine(admissionInput({ source: 'cron' }), false, 'tui');
    expect(withoutFingerprint(fields)).toEqual({
      session_id: 'session-1',
      turn_id: 'turn-1',
      admitted: false,
      reason: 'other',
      surface: 'tui',
      source: 'cron',
      session_kind: 'conversation',
    });
  });

  it('reports only internal enum values for source and Session kind', () => {
    const [[unknown]] = admissionLine(
      admissionInput({ source: 'user typed text', sessionKind: 'invented' }),
      true,
    );
    expect(unknown).toMatchObject({ source: 'other', session_kind: 'unknown' });
    const [[missing]] = admissionLine(admissionInput({ noProvenance: true }), true);
    expect(missing).toMatchObject({ source: 'other' });
  });

  it('carries the prefix fingerprints as truncated digests and no content', () => {
    const [[fields]] = admissionLine(admissionInput(), true);
    for (const key of [
      'native_catalog_sha',
      'system_prompt_sha',
      'ptc_section_sha',
      'tools_sha',
      'run_code_sha',
    ]) {
      expect(fields[key], key).toMatch(/^[0-9a-f]{16}$/u);
    }
    const values = JSON.stringify(Object.values(fields));
    for (const content of ['Use run_code', 'Run a program', 'Read a file', 'Harness']) {
      expect(values).not.toContain(content);
    }
    const [[native]] = admissionLine(admissionInput({ sessionId: freshSession() }), false);
    expect(native).toMatchObject({ run_code_sha: 'none', ptc_section_sha: 'none' });
    expect(native.native_catalog_sha).toBe(native.tools_sha);
  });

  it('never lets a throwing logger reach the Turn', () => {
    const info = vi.fn(() => {
      throw new Error('sink down');
    });
    expect(() =>
      observePtcAdmission(admissionInput(), true, { logger: { info, warn: info } }, PTC_PREFIX),
    ).not.toThrow();
  });

  it('still writes the line and the count, without hashes, when the fingerprint fails', () => {
    const sessionId = freshSession();
    const info = vi.fn();
    const warn = vi.fn();
    const metrics = metricsRecorder();
    const options = {
      logger: { info, warn },
      metricsClient: metrics.client,
      ptcSurface: 'desktop' as const,
    };
    // A catalog the fingerprint cannot read makes it throw.
    const unreadable = { ...PTC_PREFIX, nativeCatalog: null } as unknown as Prefix;

    expect(() =>
      observePtcAdmission(admissionInput({ sessionId }), true, options, unreadable),
    ).not.toThrow();

    expect(info.mock.calls).toEqual([
      [
        {
          session_id: sessionId,
          turn_id: 'turn-1',
          admitted: true,
          reason: 'enabled',
          surface: 'desktop',
          source: 'api',
          session_kind: 'conversation',
        },
        'ptc admission',
      ],
    ]);
    expect(metrics.calls).toEqual([
      expect.objectContaining({
        name: 'ptc_turn_total',
        labels: expect.objectContaining({ admitted: 'true' }),
      }),
    ]);
    // That Turn set no baseline, so the next one only starts it and the one after compares.
    observePtcAdmission(admissionInput({ sessionId, turnId: 'turn-2' }), true, options, PTC_PREFIX);
    expect(warn).not.toHaveBeenCalled();
    observePtcAdmission(admissionInput({ sessionId, turnId: 'turn-3' }), true, options, {
      ...PTC_PREFIX,
      tools: [RUN_CODE, READ],
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ turn_id: 'turn-3', previous_turn_id: 'turn-2' }),
      'ptc prefix changed',
    );
  });
});

describe('PTC prefix change warning', () => {
  function observe(sessionId: string, turnId: string, prefix: Prefix, source = 'api') {
    const info = vi.fn();
    const warn = vi.fn();
    observePtcAdmission(
      admissionInput({ sessionId, turnId, source }),
      true,
      { logger: { info, warn } },
      prefix,
    );
    return warn.mock.calls as [Record<string, unknown>, string][];
  }

  it('stays quiet while the prefix is unchanged, whatever starts the Turn', () => {
    const sessionId = freshSession();
    expect(observe(sessionId, 'turn-1', PTC_PREFIX)).toEqual([]);
    for (const [index, source] of [
      'cron',
      'background-task',
      'thread-goal',
      'code_review',
    ].entries()) {
      expect(observe(sessionId, `turn-${index + 2}`, PTC_PREFIX, source)).toEqual([]);
    }
  });

  it.each([
    [
      'the PTC section',
      {
        ...PTC_PREFIX,
        systemPrompt: '# Tool calls in this turn (PTC)\nChanged.\n\n# Harness\n- rules',
      },
      ['ptc_section'],
    ],
    [
      'the run_code declaration and the tools',
      {
        ...PTC_PREFIX,
        tools: [{ def: { ...RUN_CODE.def, description: 'Run another program.' } }],
      },
      ['tools', 'run_code'],
    ],
    ['the tools only', { ...PTC_PREFIX, tools: [RUN_CODE, READ] }, ['tools']],
    [
      'the whole catalog (PTC switched off)',
      { ...NATIVE_PREFIX, nativeCatalog: [READ] },
      ['ptc_section', 'tools', 'run_code'],
    ],
  ] as const)('warns when %s changes under the same native catalog', (_case, next, changed) => {
    const sessionId = freshSession();
    observe(sessionId, 'turn-1', PTC_PREFIX);
    expect(observe(sessionId, 'turn-2', next, 'cron')).toEqual([
      [
        {
          session_id: sessionId,
          turn_id: 'turn-2',
          previous_turn_id: 'turn-1',
          source: 'cron',
          changed,
        },
        'ptc prefix changed',
      ],
    ]);
  });

  it('stays quiet when the native catalog changed too, as native mode would change', () => {
    const sessionId = freshSession();
    observe(sessionId, 'turn-1', PTC_PREFIX);
    const grep = { def: { name: 'grep', description: 'Search.', schema: { type: 'object' } } };
    expect(
      observe(sessionId, 'turn-2', {
        systemPrompt: PTC_PREFIX.systemPrompt,
        tools: [{ def: { ...RUN_CODE.def, description: 'Run a program with grep.' } }],
        nativeCatalog: [READ, grep],
      }),
    ).toEqual([]);
  });

  it('stays quiet when only text outside the PTC section changed', () => {
    const sessionId = freshSession();
    observe(sessionId, 'turn-1', PTC_PREFIX);
    expect(
      observe(sessionId, 'turn-2', {
        ...PTC_PREFIX,
        systemPrompt: `${PTC_PREFIX.systemPrompt}\n- more`,
      }),
    ).toEqual([]);
  });

  it('starts a new baseline after a committed compaction', () => {
    const sessionId = freshSession();
    observe(sessionId, 'turn-1', PTC_PREFIX);
    resetPtcPrefixBaseline(sessionId);
    expect(observe(sessionId, 'turn-2', NATIVE_PREFIX)).toEqual([]);
    expect(observe(sessionId, 'turn-3', NATIVE_PREFIX)).toEqual([]);
  });

  it('compares each Session with its own previous Turn only', () => {
    const first = freshSession();
    const second = freshSession();
    observe(first, 'turn-1', PTC_PREFIX);
    expect(observe(second, 'turn-1', { ...PTC_PREFIX, tools: [RUN_CODE, READ] })).toEqual([]);
    expect(observe(first, 'turn-2', PTC_PREFIX)).toEqual([]);
  });

  it('swallows a throwing warn logger', () => {
    const sessionId = freshSession();
    const warn = vi.fn(() => {
      throw new Error('sink down');
    });
    const options = { logger: { info: vi.fn(), warn } };
    observePtcAdmission(admissionInput({ sessionId }), true, options, PTC_PREFIX);
    expect(() =>
      observePtcAdmission(admissionInput({ sessionId, turnId: 'turn-2' }), true, options, {
        ...PTC_PREFIX,
        tools: [RUN_CODE, READ],
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });
});

interface RecordedMetric {
  readonly type: 'counter' | 'histogram';
  readonly name: string;
  readonly value: number;
  readonly labels: Readonly<Record<string, string>>;
}

function metricsRecorder() {
  const calls: RecordedMetric[] = [];
  return {
    calls,
    client: {
      counter: vi.fn((name: string, value = 1, labels: Record<string, string> = {}) => {
        calls.push({ type: 'counter', name, value, labels });
      }),
      histogram: vi.fn((name: string, value: number, labels: Record<string, string> = {}) => {
        calls.push({ type: 'histogram', name, value, labels });
      }),
    },
  };
}

/** Every `ptc_turn_total` label with the full set of values it may take. */
const TURN_TOTAL_LABEL_VALUES: Readonly<Record<string, readonly string[]>> = {
  admitted: ['true', 'false'],
  reason: ['enabled', 'other'],
  surface: ['desktop', 'tui', 'other'],
  source: [
    'api',
    'cron',
    'task',
    'background-task',
    'team',
    'thread-goal',
    'questionnaire',
    'communication',
    'code_review',
    'greeting',
    'channel:wechat',
    'channel:feishu',
    'channel:telegram',
    'miniapp',
    'turn-continuation',
    'conversation-mutation',
    'other',
  ],
  session_kind: ['conversation', 'task', 'peek', 'channel', 'cron', 'unknown'],
};

function expectLabelsInEnums(calls: readonly RecordedMetric[]): void {
  for (const call of calls) {
    expect(call.name).toBe('ptc_turn_total');
    expect(Object.keys(call.labels).sort()).toEqual(Object.keys(TURN_TOTAL_LABEL_VALUES).sort());
    for (const [label, value] of Object.entries(call.labels)) {
      expect(typeof value, `${call.name}.${label}`).toBe('string');
      expect(TURN_TOTAL_LABEL_VALUES[label], `${call.name}.${label}=${value}`).toContain(value);
    }
  }
}

describe('PTC admission metrics', () => {
  it('reports nothing for a Turn of a native-mode Session', () => {
    const metrics = metricsRecorder();
    observePtcAdmission(
      admissionInput({ beta: false }),
      false,
      { metricsClient: metrics.client },
      NATIVE_PREFIX,
    );
    expect(metrics.client.counter).not.toHaveBeenCalled();
    expect(metrics.client.histogram).not.toHaveBeenCalled();
  });

  it('counts each PTC-mode Turn once with reason, surface, source and Session kind', () => {
    const metrics = metricsRecorder();
    observePtcAdmission(
      admissionInput({ sessionId: freshSession() }),
      true,
      { metricsClient: metrics.client, ptcSurface: 'desktop' },
      PTC_PREFIX,
    );
    observePtcAdmission(
      admissionInput({ sessionId: freshSession(), source: 'cron', sessionKind: 'cron' }),
      false,
      { metricsClient: metrics.client, ptcSurface: 'tui' },
      NATIVE_PREFIX,
    );
    observePtcAdmission(
      admissionInput({ sessionId: freshSession(), source: 'free text', sessionKind: 'odd' }),
      true,
      { metricsClient: metrics.client },
      PTC_PREFIX,
    );
    expect(metrics.calls).toEqual([
      {
        type: 'counter',
        name: 'ptc_turn_total',
        value: 1,
        labels: {
          admitted: 'true',
          reason: 'enabled',
          surface: 'desktop',
          source: 'api',
          session_kind: 'conversation',
        },
      },
      {
        type: 'counter',
        name: 'ptc_turn_total',
        value: 1,
        labels: {
          admitted: 'false',
          reason: 'other',
          surface: 'tui',
          source: 'cron',
          session_kind: 'cron',
        },
      },
      {
        type: 'counter',
        name: 'ptc_turn_total',
        value: 1,
        labels: {
          admitted: 'true',
          reason: 'enabled',
          surface: 'other',
          source: 'other',
          session_kind: 'unknown',
        },
      },
    ]);
    expectLabelsInEnums(metrics.calls);
  });

  it('keeps the log line when the metrics client throws, and the reverse', () => {
    const info = vi.fn();
    const throwing = {
      counter: () => {
        throw new Error('metrics down');
      },
      histogram: () => {
        throw new Error('metrics down');
      },
    };
    expect(() =>
      observePtcAdmission(
        admissionInput({ sessionId: freshSession() }),
        true,
        { logger: { info, warn: vi.fn() }, metricsClient: throwing },
        PTC_PREFIX,
      ),
    ).not.toThrow();
    expect(info).toHaveBeenCalledOnce();
    const metrics = metricsRecorder();
    observePtcAdmission(
      admissionInput({ sessionId: freshSession() }),
      true,
      {
        logger: {
          info: () => {
            throw new Error('sink down');
          },
          warn: vi.fn(),
        },
        metricsClient: metrics.client,
      },
      PTC_PREFIX,
    );
    expect(metrics.calls).toHaveLength(1);
  });
});
