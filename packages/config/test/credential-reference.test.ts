import { describe, expect, it } from 'vitest';

import { credentialEnvReferenceName, resolveProviderCredential } from '../src/index.js';

const FIELD = 'custom_provider options.apiKey';
const PROVIDER = 'mafia';

describe('provider credential environment reference', () => {
  it('returns plaintext credentials untouched', () => {
    expect(
      resolveProviderCredential({ field: FIELD, provider: PROVIDER, value: 'sk-plaintext-value' }),
    ).toBe('sk-plaintext-value');
  });

  it('resolves a ${NAME} reference from the environment at read time', () => {
    expect(
      resolveProviderCredential({
        field: FIELD,
        provider: PROVIDER,
        value: '  ${MAFIA_API_KEY}  ',
        env: { MAFIA_API_KEY: 'sk-from-env' },
      }),
    ).toBe('sk-from-env');
  });

  it('picks up a rotated key without the config file changing', () => {
    const env = { MAFIA_API_KEY: 'sk-rotation-one' };
    expect(resolveProviderCredential({ field: FIELD, provider: PROVIDER, value: '${MAFIA_API_KEY}', env })).toBe(
      'sk-rotation-one',
    );
    env.MAFIA_API_KEY = 'sk-rotation-two';
    expect(resolveProviderCredential({ field: FIELD, provider: PROVIDER, value: '${MAFIA_API_KEY}', env })).toBe(
      'sk-rotation-two',
    );
  });

  it('names the unset variable instead of reporting a missing credential', () => {
    expect(() =>
      resolveProviderCredential({ field: FIELD, provider: PROVIDER, value: '${MISSING_KEY}', env: {} }),
    ).toThrow(/"mafia".*"MISSING_KEY"/u);
  });

  it('treats an unset variable that resolves to blanks as missing', () => {
    expect(() =>
      resolveProviderCredential({
        field: FIELD,
        provider: PROVIDER,
        value: '${BLANK_KEY}',
        env: { BLANK_KEY: '   ' },
      }),
    ).toThrow(/"BLANK_KEY"/u);
  });

  it('explains the supported forms when a nested map reaches the resolver', () => {
    // YAML reads `apiKey: {env: VAR}` into an object; the previous path called
    // `.trim()` on it and surfaced a TypeError with no mention of any field.
    expect(() =>
      resolveProviderCredential({ field: FIELD, provider: PROVIDER, value: { env: 'VAR' } }),
    ).toThrow('${NAME}');
  });

  it('treats a partial interpolation as plaintext rather than expanding it', () => {
    expect(
      resolveProviderCredential({ field: FIELD, provider: PROVIDER, value: 'Bearer ${TOKEN}' }),
    ).toBe('Bearer ${TOKEN}');
  });

  it('treats the unbraced shorthand as plaintext rather than expanding it', () => {
    expect(
      resolveProviderCredential({ field: FIELD, provider: PROVIDER, value: '$MAFIA_API_KEY' }),
    ).toBe('$MAFIA_API_KEY');
  });

  it('reports an absent credential as absent', () => {
    expect(resolveProviderCredential({ field: FIELD, provider: PROVIDER, value: undefined })).toBeUndefined();
    expect(resolveProviderCredential({ field: FIELD, provider: PROVIDER, value: '   ' })).toBeUndefined();
  });
});

describe('credentialEnvReferenceName', () => {
  it('accepts only a whole-string ${NAME} reference', () => {
    expect(credentialEnvReferenceName('${A_B}')).toBe('A_B');
    expect(credentialEnvReferenceName('${9BAD}')).toBeUndefined();
    expect(credentialEnvReferenceName('${}')).toBeUndefined();
    expect(credentialEnvReferenceName('prefix-${NAME}')).toBeUndefined();
    expect(credentialEnvReferenceName(42)).toBeUndefined();
  });
});
