import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { decideOutputLimitRecovery } from '../src/index.js';

type Block =
  | { type: 'thinking'; thinking: string }
  | { type: 'text'; text: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };

const thinking: Block = { type: 'thinking', thinking: 'long reasoning…' };
const toolCall: Block = { type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'a' } };
const text = (value: string): Block => ({ type: 'text', text: value });

function response(stopReason: string, content: Block[]): AssistantMessage {
  return { role: 'assistant', content, stopReason, timestamp: 0 } as unknown as AssistantMessage;
}

const userMessage = { role: 'user', content: [{ type: 'text', text: 'do it' }], timestamp: 0 };
const toolResult = {
  role: 'toolResult',
  toolCallId: 'call-0',
  toolName: 'read',
  content: [{ type: 'text', text: 'ok' }],
  isError: false,
  timestamp: 0,
};

/** Decides for `current` appended to `history`, as the turn runner presents it. */
function decide(current: AssistantMessage, history: unknown[] = [userMessage], maxRetries?: number) {
  return decideOutputLimitRecovery(
    current,
    [...history, current] as unknown as AgentMessage[],
    maxRetries,
  );
}

/** The user message a retry decision appends to the transcript. */
function hintFor(content: Block[]) {
  const decision = decide(response('length', content));
  if (decision.kind !== 'retry') throw new Error('expected a retry decision');
  return { role: 'user', content: [{ type: 'text', text: decision.prompt }], timestamp: 0 };
}

describe('decideOutputLimitRecovery', () => {
  it('retries a reasoning-only response cut off by the output limit', () => {
    const decision = decide(response('length', [thinking]));

    expect(decision).toMatchObject({ kind: 'retry', attempts: 1, truncatedToolCall: false });
    const prompt = (decision as { prompt: string }).prompt;
    expect(prompt.startsWith('<system-reminder>\n')).toBe(true);
    expect(prompt.endsWith('\n</system-reminder>')).toBe(true);
    expect(prompt).toContain('while you were still reasoning');
    expect(prompt).toContain('reason much more briefly');
  });

  it('uses the tool-call hint when the cut happened inside a tool call', () => {
    const decision = decide(response('length', [thinking, toolCall]));

    expect(decision).toMatchObject({ kind: 'retry', truncatedToolCall: true });
    expect((decision as { prompt: string }).prompt).toContain('that tool call was not run');
  });

  it('treats whitespace-only text as no visible reply', () => {
    expect(decide(response('length', [thinking, text('  \n')]))).toMatchObject({ kind: 'retry' });
  });

  it.each([
    ['text only', [thinking, text('partial answer')]],
    ['text and a tool call', [thinking, text('let me write'), toolCall]],
  ])('leaves a cut-off response with visible text alone (%s)', (_label, content) => {
    expect(decide(response('length', content))).toEqual({ kind: 'none' });
  });

  it.each(['stop', 'toolUse', 'error', 'aborted'])('ignores responses that ended with %s', (reason) => {
    expect(decide(response(reason, [thinking]))).toEqual({ kind: 'none' });
  });

  it('is exhausted after three consecutive retries', () => {
    const hint = hintFor([thinking]);

    expect(decide(response('length', [thinking]), [userMessage, hint])).toMatchObject({
      kind: 'retry',
      attempts: 2,
    });
    expect(decide(response('length', [thinking]), [userMessage, hint, hint])).toMatchObject({
      kind: 'retry',
      attempts: 3,
    });
    expect(
      decide(response('length', [thinking, toolCall]), [userMessage, hint, hint, hint]),
    ).toEqual({ kind: 'exhausted', attempts: 3, truncatedToolCall: true });
  });

  it('counts both hint variants toward the same limit', () => {
    const reasoningHint = hintFor([thinking]);
    const toolHint = hintFor([thinking, toolCall]);

    expect(
      decide(response('length', [thinking]), [userMessage, reasoningHint, toolHint, reasoningHint]),
    ).toMatchObject({ kind: 'exhausted', attempts: 3 });
  });

  it('honors a configured retry limit', () => {
    const hint = hintFor([thinking]);

    expect(decide(response('length', [thinking]), [userMessage, hint], 1)).toMatchObject({
      kind: 'exhausted',
      attempts: 1,
    });
  });

  it('starts counting again once a step completes in between', () => {
    const hint = hintFor([thinking]);
    const recoveredStep = response('toolUse', [thinking, toolCall]);

    expect(
      decide(response('length', [thinking]), [
        userMessage,
        hint,
        hint,
        hint,
        recoveredStep,
        toolResult,
      ]),
    ).toMatchObject({ kind: 'retry', attempts: 1 });
  });

  it('starts counting again after a real user message', () => {
    const hint = hintFor([thinking]);

    expect(
      decide(response('length', [thinking]), [hint, hint, hint, userMessage]),
    ).toMatchObject({ kind: 'retry', attempts: 1 });
  });

  it('reports recovery for a normal response that follows the hints', () => {
    const hint = hintFor([thinking]);

    expect(
      decide(response('stop', [thinking, text('done')]), [userMessage, hint, hint]),
    ).toEqual({ kind: 'recovered', attempts: 2 });
    expect(decide(response('length', [text('partial')]), [userMessage, hint])).toEqual({
      kind: 'recovered',
      attempts: 1,
    });
  });

  it('does not report recovery for a provider error or abort after the hints', () => {
    const hint = hintFor([thinking]);

    expect(decide(response('error', []), [userMessage, hint])).toEqual({ kind: 'none' });
    expect(decide(response('aborted', []), [userMessage, hint])).toEqual({ kind: 'none' });
  });

  it('tolerates transcripts it does not recognize', () => {
    const hint = hintFor([thinking]);
    const odd = [
      null,
      'not a message',
      { role: 'user', content: 'plain string content' },
      { role: 'user', content: [] },
      { role: 'user', content: [{ type: 'image', data: 'x' }] },
      { role: 'user', content: [hint.content[0], hint.content[0]] },
    ];

    expect(decide(response('length', [thinking]), odd)).toMatchObject({
      kind: 'retry',
      attempts: 1,
    });
    expect(
      decide(response('length', [thinking]), [userMessage, { ...hint, content: hint.content[0]!.text }]),
    ).toMatchObject({ kind: 'retry', attempts: 2 });
  });

  it('counts from the end of the transcript when the response is not in it', () => {
    const hint = hintFor([thinking]);
    const current = response('length', [thinking]);

    expect(
      decideOutputLimitRecovery(current, [userMessage, hint, hint] as unknown as AgentMessage[]),
    ).toMatchObject({ kind: 'retry', attempts: 3 });
  });
});
