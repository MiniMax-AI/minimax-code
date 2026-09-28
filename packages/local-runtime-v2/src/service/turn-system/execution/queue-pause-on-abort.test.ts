import { describe, expect, it } from 'vitest';

import { pausesQueueOnAbort } from './queue-pause-on-abort.js';

describe('pausesQueueOnAbort', () => {
  it.each(['user_stop', 'session_leave'])('pauses the queue after a %s abort', (reason) => {
    expect(pausesQueueOnAbort(reason)).toBe(true);
  });

  // Runtime-driven aborts and raw, un-normalized reasons never pause: only the user
  // stopping or leaving the conversation means pending work must wait for them.
  it.each([
    'immediate_send',
    'input_safety',
    'output_safety',
    'lifecycle',
    'runtime-shutdown',
    'user-stop',
    undefined,
  ])('leaves the queue running after %s', (reason) => {
    expect(pausesQueueOnAbort(reason)).toBe(false);
  });
});
