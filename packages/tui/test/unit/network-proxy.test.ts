import { describe, expect, it } from 'vitest';
import {
  redactProxyUrl,
  resolveTuiProxyConfiguration,
  shouldBypassTuiProxy,
  withoutSocks5ExperimentalWarning,
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

describe('proxy URL protocol classification', () => {
  function resolveWithWarnings(environment: NodeJS.ProcessEnv) {
    const warnings: string[] = [];
    const configuration = resolveTuiProxyConfiguration(environment, {
      writeWarning: (message) => warnings.push(message),
    });
    return { configuration, warnings };
  }

  it.each([
    ['ALL_PROXY', 'socks5://127.0.0.1:7891'],
    ['all_proxy', 'socks5://127.0.0.1:7891'],
    ['ALL_PROXY', '  socks5://127.0.0.1:7891 \t'],
    ['all_proxy', ' socks://127.0.0.1:7891\n'],
    ['ALL_PROXY', 'socks5h://127.0.0.1:7891'],
    ['all_proxy', ' socks5h://user:secret@127.0.0.1:7891 '],
  ])('uses %s=%j as the fallback for both schemes', (name, value) => {
    const { configuration, warnings } = resolveWithWarnings({ [name]: value });

    expect(warnings).toEqual([]);
    expect(configuration).toEqual({
      mode: 'proxy',
      httpProxy: value.trim(),
      httpsProxy: value.trim(),
      noProxy: 'localhost,127.0.0.1,::1',
    });
  });

  it.each([
    ['HTTPS_PROXY', 'socks5://127.0.0.1:7891'],
    ['https_proxy', ' socks5://user:secret@127.0.0.1:7891 '],
    ['HTTP_PROXY', 'socks://127.0.0.1:7891'],
    ['http_proxy', 'socks5://127.0.0.1:7891'],
    ['HTTPS_PROXY', 'socks5h://127.0.0.1:7891'],
    ['https_proxy', ' socks5h://user:secret@127.0.0.1:7891 '],
    ['HTTP_PROXY', 'socks5h://127.0.0.1:7891'],
    ['http_proxy', 'socks5h://127.0.0.1:7891'],
  ])('accepts an explicit %s=%j SOCKS5 proxy', (name, value) => {
    const { configuration, warnings } = resolveWithWarnings({ [name]: value });

    expect(warnings).toEqual([]);
    expect(configuration.mode).toBe('proxy');
    if (configuration.mode !== 'proxy') throw new Error('Expected proxy configuration');
    expect(configuration.httpsProxy).toBe(value.trim());
  });

  it('prefers explicit HTTP(S)_PROXY values over ALL_PROXY', () => {
    const { configuration } = resolveWithWarnings({
      http_proxy: ' http://127.0.0.1:7890 ',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      ALL_PROXY: 'socks5://127.0.0.1:7891',
    });

    expect(configuration).toMatchObject({
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
    });
  });

  it.each([
    [
      'all_proxy',
      ' socks4://127.0.0.1:7891 ',
      'socks4:// proxies are not supported (use http://, https://, socks5://, or socks5h://)',
    ],
    ['ALL_PROXY', 'socks4a://127.0.0.1:7891', 'socks4a:// proxies are not supported'],
    ['ALL_PROXY', '127.0.0.1:7891', 'it is not a valid proxy URL'],
    ['all_proxy', 'http://', 'it is not a valid proxy URL'],
  ])(
    'ignores unsupported %s=%j with one warning instead of failing startup',
    (name, value, reason) => {
      const { configuration, warnings } = resolveWithWarnings({ [name]: value });

      expect(configuration).toEqual({ mode: 'direct' });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`Warning: ignoring ${name}`);
      expect(warnings[0]).toContain(reason);
      expect(warnings[0]).toContain(
        "Set HTTPS_PROXY and HTTP_PROXY to your proxy app's http:// port",
      );
    },
  );

  it('keeps explicit proxies when an unsupported ALL_PROXY is ignored', () => {
    const { configuration, warnings } = resolveWithWarnings({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      ALL_PROXY: 'socks4://127.0.0.1:7891',
    });

    expect(warnings).toHaveLength(1);
    expect(configuration).toMatchObject({
      mode: 'proxy',
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
    });
  });

  it('discards warnings when no sink is provided', () => {
    expect(resolveTuiProxyConfiguration({ ALL_PROXY: 'socks4://127.0.0.1:1080' })).toEqual({
      mode: 'direct',
    });
  });

  it.each([
    ['HTTPS_PROXY', 'socks4://127.0.0.1:1080'],
    ['https_proxy', 'ftp://proxy.example.invalid'],
    ['HTTP_PROXY', 'not a url'],
    ['http_proxy', ' 127.0.0.1:7890 '],
  ])('still rejects an explicit invalid %s=%j', (name, value) => {
    expect(() => resolveTuiProxyConfiguration({ [name]: value })).toThrow(
      `${name} must be an http://, https://, socks5://, or socks5h:// URL.`,
    );
  });

  it('redacts proxy credentials from warnings and errors', () => {
    const { warnings } = resolveWithWarnings({
      ALL_PROXY: 'socks4://alice:s3cr3t@127.0.0.1:1080',
    });
    expect(warnings[0]).toContain('ALL_PROXY=socks4://***:***@127.0.0.1:1080');

    let message = '';
    try {
      resolveTuiProxyConfiguration({ https_proxy: 'socks4://alice:s3cr3t@127.0.0.1:1080' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('https_proxy must be an http://, https://, socks5://, or socks5h:// URL.');

    for (const text of [warnings[0], message]) {
      expect(text).not.toContain('alice');
      expect(text).not.toContain('s3cr3t');
    }
  });

  it.each([
    ['ALL_PROXY', 'socks5://user:50%off@127.0.0.1:1080', 'socks5://***:***@127.0.0.1:1080'],
    ['all_proxy', ' http://user:50%off@127.0.0.1:7890 ', 'http://***:***@127.0.0.1:7890'],
    ['ALL_PROXY', 'socks5h://bad%zzname:pw@127.0.0.1:1080', 'socks5h://***:***@127.0.0.1:1080'],
  ])('ignores %s=%j with malformed credentials and one warning', (name, value, redacted) => {
    const { configuration, warnings } = resolveWithWarnings({ [name]: value });

    expect(configuration).toEqual({ mode: 'direct' });
    expect(warnings).toEqual([
      `Warning: ignoring ${name}=${redacted} because its user name or password is not valid percent-encoding (encode % as %25); it will not be used. Set HTTPS_PROXY and HTTP_PROXY to your proxy app's http:// port, or set ALL_PROXY to a socks5:// or socks5h:// URL.`,
    ]);
  });

  it.each([
    ['HTTPS_PROXY', 'socks5://user:50%off@127.0.0.1:1080', 'socks5://***:***@127.0.0.1:1080'],
    ['https_proxy', 'http://user:50%off@127.0.0.1:7890', 'http://***:***@127.0.0.1:7890'],
    ['HTTP_PROXY', 'socks5h://bad%zzname@127.0.0.1:1080', 'socks5h://***@127.0.0.1:1080'],
  ])('rejects explicit %s=%j with malformed credentials', (name, value, redacted) => {
    let message = '';
    try {
      resolveTuiProxyConfiguration({ [name]: value });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      `${name}=${redacted} has a user name or password that is not valid percent-encoding. Encode reserved characters, for example % as %25.`,
    );
    expect(message).not.toContain('50%off');
    expect(message).not.toContain('bad%zz');
  });

  it('accepts correctly percent-encoded credentials', () => {
    expect(
      resolveTuiProxyConfiguration({ ALL_PROXY: 'socks5://us%40er:50%25off@127.0.0.1:1080' }),
    ).toMatchObject({ mode: 'proxy' });
  });

  it.each([
    ['socks5://alice:s3cr3t@127.0.0.1:1080', 'socks5://***:***@127.0.0.1:1080'],
    ['socks5://alice@127.0.0.1:1080', 'socks5://***@127.0.0.1:1080'],
    ['socks5h://alice:s3cr3t@127.0.0.1:1080', 'socks5h://***:***@127.0.0.1:1080'],
    ['http://127.0.0.1:7890/', 'http://127.0.0.1:7890'],
    ['http://user%40corp:p%3Ass@proxy.example.invalid', 'http://***:***@proxy.example.invalid'],
  ])('redactProxyUrl(%j) masks credentials', (value, expected) => {
    expect(redactProxyUrl(value)).toBe(expected);
  });

  it('does not echo an unparseable proxy value', () => {
    expect(redactProxyUrl('user:secret@@ bad')).toBeUndefined();
    const { warnings } = resolveWithWarnings({ ALL_PROXY: 'user:secret@@ bad' });
    expect(warnings[0]).not.toContain('secret');
  });
});

describe('SOCKS5 experimental warning filter', () => {
  const SOCKS5_WARNING = 'SOCKS5 proxy support is experimental and subject to change';

  function createTarget() {
    const emitted: unknown[][] = [];
    const original = ((...args: unknown[]) => {
      emitted.push(args);
    }) as typeof process.emitWarning;
    return { target: { emitWarning: original }, original, emitted };
  }

  it('drops only the SOCKS5 ExperimentalWarning and restores the emitter', () => {
    const { target, original, emitted } = createTarget();

    const result = withoutSocks5ExperimentalWarning(() => {
      target.emitWarning(SOCKS5_WARNING, 'ExperimentalWarning');
      target.emitWarning(SOCKS5_WARNING, { type: 'ExperimentalWarning' });
      target.emitWarning('Another feature is experimental', 'ExperimentalWarning');
      target.emitWarning(SOCKS5_WARNING, 'DeprecationWarning');
      target.emitWarning(SOCKS5_WARNING);
      target.emitWarning('Unrelated warning');
      return 'created';
    }, target);

    expect(result).toBe('created');
    expect(emitted).toEqual([
      ['Another feature is experimental', 'ExperimentalWarning'],
      [SOCKS5_WARNING, 'DeprecationWarning'],
      [SOCKS5_WARNING],
      ['Unrelated warning'],
    ]);
    expect(target.emitWarning).toBe(original);
  });

  it('drops an Error-shaped SOCKS5 ExperimentalWarning', () => {
    const { target, emitted } = createTarget();
    const warning = new Error(SOCKS5_WARNING);
    warning.name = 'ExperimentalWarning';

    withoutSocks5ExperimentalWarning(() => target.emitWarning(warning), target);

    expect(emitted).toEqual([]);
  });

  it('restores the emitter when creation throws', () => {
    const { target, original } = createTarget();

    expect(() =>
      withoutSocks5ExperimentalWarning(() => {
        throw new Error('construction failed');
      }, target),
    ).toThrow('construction failed');
    expect(target.emitWarning).toBe(original);
    target.emitWarning('after');
  });
});
