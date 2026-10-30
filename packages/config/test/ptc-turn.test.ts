import { describe, expect, it } from 'vitest';

import { isPtcTurnEnabled } from '../src/index.js';

describe('isPtcTurnEnabled', () => {
  it('follows the Session mode alone', () => {
    expect(isPtcTurnEnabled({ requested: false })).toBe(false);
    expect(isPtcTurnEnabled({ requested: true })).toBe(true);
  });
});
