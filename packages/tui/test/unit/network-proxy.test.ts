import { describe, expect, it } from 'vitest';
import {
  resolveTuiProxyConfiguration,
  shouldBypassTuiProxy,
} from '../../src/cli/network-proxy.js';

const PROXY_URL = 'http://proxy.example.invalid:8080';

describe('NO_PROXY environment precedence', () => {
  it.each([undefined, '', ' \t\n '])(
    'falls back to no_proxy when NO_PROXY is %j',
    (noProxy) => {
      const configuration = resolveTuiProxyConfiguration({
        HTTPS_PROXY: PROXY_URL,
        NO_PROXY: noProxy,
        no_proxy: ' internal.example.invalid ',
      });

      expect(configuration.mode).toBe('proxy');
      if (configuration.mode !== 'proxy') throw new Error('Expected proxy configuration');
      expect(
        shouldBypassTuiProxy(new URL('https://internal.example.invalid/v1'), configuration.noProxy),
      ).toBe(true);
      expect(
        shouldBypassTuiProxy(new URL('https://external.example.invalid/v1'), configuration.noProxy),
      ).toBe(false);
      for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        expect(shouldBypassTuiProxy(new URL(`http://${host}/`), configuration.noProxy)).toBe(true);
      }
    },
  );

  it('prefers a nonblank NO_PROXY over no_proxy', () => {
    const configuration = resolveTuiProxyConfiguration({
      HTTPS_PROXY: PROXY_URL,
      NO_PROXY: ' upper.example.invalid ',
      no_proxy: 'lower.example.invalid',
    });

    expect(configuration.mode).toBe('proxy');
    if (configuration.mode !== 'proxy') throw new Error('Expected proxy configuration');
    expect(shouldBypassTuiProxy(new URL('https://upper.example.invalid/'), configuration.noProxy)).toBe(
      true,
    );
    expect(shouldBypassTuiProxy(new URL('https://lower.example.invalid/'), configuration.noProxy)).toBe(
      false,
    );
  });

  it.each([undefined, '', ' \t '])(
    'preserves the loopback defaults when both spellings are %j',
    (noProxy) => {
      const configuration = resolveTuiProxyConfiguration({
        HTTPS_PROXY: PROXY_URL,
        NO_PROXY: noProxy,
        no_proxy: noProxy,
      });

      expect(configuration.mode).toBe('proxy');
      if (configuration.mode !== 'proxy') throw new Error('Expected proxy configuration');
      expect(configuration.noProxy).toBe('localhost,127.0.0.1,::1');
    },
  );

  it('stays direct when only a bypass list is configured', () => {
    expect(resolveTuiProxyConfiguration({ NO_PROXY: '', no_proxy: 'internal.example.invalid' })).toEqual(
      { mode: 'direct' },
    );
  });
});
