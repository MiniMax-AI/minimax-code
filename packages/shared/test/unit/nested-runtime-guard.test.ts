import { describe, expect, it } from 'vitest';

import {
  NESTED_RUNTIME_DELETE_GUARD_ENV,
  NESTED_RUNTIME_DELETE_GUARD_ERROR_CODE,
  NestedRuntimeUnsupportedError,
  assertNestedRuntimeAllowed,
  nestedRuntimeGuardEnv,
} from '../../src/nested-runtime-guard.js';
import { stripRuntimeBoundaryKeysFrom } from '../../src/runtime-boundary-env.js';

describe('nested Runtime guard marker', () => {
  it('is stripped by the runtime boundary before a managed spawn re-injects it', () => {
    const inherited: NodeJS.ProcessEnv = {
      [NESTED_RUNTIME_DELETE_GUARD_ENV]: 'forged',
      PATH: '/usr/bin',
    };

    expect(stripRuntimeBoundaryKeysFrom(inherited, 'agent-runtime')).toContain(
      NESTED_RUNTIME_DELETE_GUARD_ENV,
    );
    expect(inherited).toEqual({ PATH: '/usr/bin' });

    const injected = { ...inherited, ...nestedRuntimeGuardEnv() };
    expect(injected).toEqual({
      PATH: '/usr/bin',
      [NESTED_RUNTIME_DELETE_GUARD_ENV]: '1',
    });
  });
});

describe('assertNestedRuntimeAllowed', () => {
  it('refuses every nested Runtime under delete_guard with a stable error code', () => {
    let thrown: unknown;
    try {
      assertNestedRuntimeAllowed(nestedRuntimeGuardEnv(), 'en-US');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NestedRuntimeUnsupportedError);
    expect(thrown).toMatchObject({ code: NESTED_RUNTIME_DELETE_GUARD_ERROR_CODE });
    const message = (thrown as Error).message;
    expect(message).toContain('Deletion protection is enabled');
    expect(message).toContain('sandbox filesystem mode "delete_guard"');
    expect(message).toContain('outside the workspace');
    expect(message).toContain('unable to remove them');
    expect(message).toContain('stopped before it created any Runtime state');
    expect(message).toContain('terminal outside this agent session');
  });

  it('presents the guard reason in Chinese for a Chinese runtime locale', () => {
    expect(() => assertNestedRuntimeAllowed(nestedRuntimeGuardEnv(), 'zh-CN')).toThrow(
      /已开启删除防护.*delete_guard.*无法在其中嵌套启动 MiniMax Code/u,
    );
  });

  it('allows a direct terminal start without the trusted marker', () => {
    expect(() => assertNestedRuntimeAllowed({}, 'zh-CN')).not.toThrow();
    expect(() =>
      assertNestedRuntimeAllowed({ [NESTED_RUNTIME_DELETE_GUARD_ENV]: '  ' }, 'en-US'),
    ).not.toThrow();
    expect(() =>
      assertNestedRuntimeAllowed({ [NESTED_RUNTIME_DELETE_GUARD_ENV]: 'forged' }, 'en-US'),
    ).not.toThrow();
  });
});
