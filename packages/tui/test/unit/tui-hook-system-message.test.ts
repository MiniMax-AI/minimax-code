import { describe, expect, it } from 'vitest';
import {
  normalizeTuiMessage,
  projectTuiSessionStreamFrame,
} from '../../src/runtime/stream-events.js';
import { TuiTurnProjection } from '../../src/tui/controller/projection/turn-projection.js';
import { TranscriptStore } from '../../src/tui/transcript/store.js';
import {
  formatTuiSessionMarkdown,
  formatTuiTranscriptMarkdown,
  latestAssistantReply,
} from '../../src/tui/transcript/export.js';

const marker = 'HOOK_DISPLAY_ONLY_SENTINEL';
function notice(id = 'notice-1', data: Record<string, unknown> = {}) {
  return {
    msg_id: id,
    turn_id: 'turn-1',
    timestamp: 123,
    msg_type: 3,
    msg_content: JSON.stringify({
      eventType: 'runtime.warning',
      source: 'plugin-hook',
      category: 'system-message',
      hookEvent: 'Stop',
      message: marker,
      ...data,
    }),
  };
}
function harness() {
  const transcript = new TranscriptStore();
  const projection = new TuiTurnProjection({
    transcript,
    now: () => 999,
    onChange: () => {},
  });
  return { transcript, projection };
}
function stream(message: ReturnType<typeof notice>) {
  return projectTuiSessionStreamFrame(
    { dataJson: JSON.stringify({ type: 2, agent_message: message }) },
    'fallback-turn',
  )!;
}

describe('Hook-only TUI messages', () => {
  it('preserves source identity, time and turn through the live transport', () => {
    expect(stream(notice())).toMatchObject({
      type: 'generic',
      eventType: 'runtime.warning',
      messageId: 'notice-1',
      turnId: 'turn-1',
      timestamp: 123,
    });
  });

  it.each(['live-first', 'history-first'])(
    'deduplicates %s delivery and history refresh',
    (order) => {
      const { transcript, projection } = harness();
      const live = () => projection.applyStreamEvent('fallback-turn', stream(notice()));
      const hydrate = () => projection.hydrateHistory([normalizeTuiMessage(notice())]);
      if (order === 'live-first') {
        live();
        hydrate();
      } else {
        hydrate();
        live();
      }
      live();
      expect(transcript.snapshot()).toEqual([
        expect.objectContaining({
          id: 'hook-message:notice-1',
          kind: 'warning',
          status: 'succeeded',
          content: marker,
          title: 'Hook · Stop',
          turnId: 'turn-1',
          sourceMessageId: 'notice-1',
          createdAtMs: 123,
        }),
      ]);
      expect(transcript.snapshot()[0].ephemeral).toBeUndefined();
      transcript.replaceDurableProjection(hydrate);
      live();
      expect(transcript.length).toBe(1);
      projection.applyStreamEvent('turn-1', stream(notice('notice-2')));
      expect(transcript.length).toBe(2);
    },
  );

  it.each([
    { category: undefined },
    { category: 'diagnostic' },
    { category: 'terminal-control' },
    { category: 'runtime-message' },
    { source: 'other' },
    { message: '' },
    { message: 42 },
    { message: '\u0007\u001b[31m' },
  ])('keeps unsupported or empty payloads hidden: %j', (data) => {
    const { transcript, projection } = harness();
    projection.applyStreamEvent('turn-1', stream(notice('invalid', data)));
    projection.hydrateHistory([normalizeTuiMessage(notice('invalid', data))]);
    expect(transcript.length).toBe(0);
  });

  it('requires a real message ID for live and history projection', () => {
    const { transcript, projection } = harness();
    projection.applyStreamEvent('turn-1', {
      type: 'generic',
      eventType: 'runtime.warning',
      data: {
        source: 'plugin-hook',
        category: 'system-message',
        message: marker,
      },
    });
    projection.hydrateHistory([{ role: 'system', content: notice().msg_content }]);
    expect(transcript.length).toBe(0);
  });

  it('sanitizes text and titles before exposing them to transcript consumers', () => {
    const { transcript, projection } = harness();
    projection.applyStreamEvent(
      'turn-1',
      stream(
        notice('safe', {
          hookEvent: '\u001b]0;unsafe-title\u0007Stop',
          message: '\u001b]52;c;clipboard\u0007中文\nsecond line\u0007',
        }),
      ),
    );
    expect(transcript.snapshot()[0]).toMatchObject({
      title: 'Hook · Stop',
      content: '中文\nsecond line',
    });
  });

  it('removes notices when their turn is rewound or replaced', () => {
    const { transcript, projection } = harness();
    projection.applyStreamEvent('turn-1', stream(notice()));
    projection.applyStreamEvent('turn-1', {
      type: 'messages-rewound',
      messageIds: ['notice-1'],
      turnId: 'turn-1',
    });
    expect(transcript.length).toBe(0);
    projection.applyStreamEvent('turn-1', stream(notice()));
    projection.applyStreamEvent('turn-1', {
      type: 'messages-replaced',
      messages: [],
      turnId: 'turn-1',
    });
    expect(transcript.length).toBe(0);
  });

  it('excludes durable notices from both exporters and final-answer extraction', () => {
    const { transcript, projection } = harness();
    const answer = {
      id: 'answer-1',
      role: 'assistant' as const,
      content: 'OK',
      turnId: 'turn-1',
    };
    const messages = [answer, normalizeTuiMessage(notice())];
    projection.hydrateHistory(messages);
    expect(transcript.length).toBe(2);
    expect(latestAssistantReply(transcript)).toBe('OK');
    expect(formatTuiTranscriptMarkdown(transcript)).not.toContain(marker);
    expect(
      formatTuiSessionMarkdown(messages, {
        sessionId: 'session-1',
        exportedAtMs: 1,
      }),
    ).not.toContain(marker);
  });
});
