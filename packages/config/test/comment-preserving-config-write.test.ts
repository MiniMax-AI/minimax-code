import { describe, expect, it } from 'vitest';

import {
  parseConfigText,
  serializeConfigPreservingComments,
} from '../src/comment-preserving-config-write.js';

function apply(originalText: string, mutate: (config: Record<string, unknown>) => void): string {
  const previous = parseConfigText(originalText);
  const next = structuredClone(previous);
  mutate(next);
  return serializeConfigPreservingComments(originalText, previous, next);
}

const ORIGINAL = `# my providers
logLevel: info

custom_provider:
  # third party, owned by platform team
  mafia:
    options:
      baseURL: https://api.example.com/v1
      apiKey: "\${MAFIA_API_KEY}"  # keep this note
    models:
      gpt-x:
        limit:
          context: 128000
`;

describe('comment-preserving config serialization', () => {
  it('keeps reference syntax unchanged when no configuration values change', () => {
    const original = 'first: &options { apiKey: placeholder }\nsecond: *options\n';
    const previous = parseConfigText(original);

    expect(serializeConfigPreservingComments(original, previous, structuredClone(previous))).toBe(
      original,
    );
  });

  it('keeps an alias value when its anchor owner is removed', () => {
    const original =
      'first: &options { apiKey: placeholder }\nsecond: *options # retained provider\n';
    const previous = parseConfigText(original);
    const next = { second: previous.second };

    const written = serializeConfigPreservingComments(original, previous, next);

    expect(parseConfigText(written)).toEqual(next);
    expect(written).toContain('# retained provider');
  });

  it.each(['primary', 'secondary'])(
    'isolates edits to the %s provider with shared options',
    (key) => {
      const original = `# provider settings
custom_provider:
  primary:
    options: &options
      baseURL: https://original.example/v1 # original endpoint
      apiKey: shared-placeholder
  secondary:
    options: *options # secondary settings
`;
      const previous = parseConfigText(original);
      const next = structuredClone(previous);
      const providers = next.custom_provider as Record<
        string,
        { options: Record<string, unknown> }
      >;
      providers[key].options = { ...providers[key].options, baseURL: 'https://updated.example/v1' };

      const written = serializeConfigPreservingComments(original, previous, next);

      expect(parseConfigText(written)).toEqual(next);
      expect(written).toContain('# provider settings');
      expect(written).toContain('# original endpoint');
      expect(written).toContain('# secondary settings');
    },
  );

  it.each(['', '      apiKey: override-placeholder\n'])(
    'clears a merged credential with local override %j',
    (override) => {
      const original = `defaults: &defaults
  apiKey: inherited-placeholder
  baseURL: https://original.example/v1
custom_provider:
  work:
    options:
      <<: *defaults # inherited connection settings
${override}      authMode: api-key # preserve local settings
`;
      const previous = parseConfigText(original);
      const next = structuredClone(previous);
      const providers = next.custom_provider as Record<
        string,
        { options: Record<string, unknown> }
      >;
      providers.work.options = { ...providers.work.options };
      delete providers.work.options.apiKey;

      const written = serializeConfigPreservingComments(original, previous, next);

      expect(parseConfigText(written)).toEqual(next);
      expect(written).toContain('# inherited connection settings');
      expect(written).toContain('# preserve local settings');
    },
  );

  it('keeps merge precedence, nested aliases and quoted merge-like keys when clearing a key', () => {
    const original = `first: &first
  apiKey: first-placeholder
  baseURL: https://first.example
second: &second
  apiKey: second-placeholder
  authMode: api-key
options: &options
  <<: [*first, *second]
literal: &literal
  "<<": literal
custom_provider:
  work:
    options: *options
copiedLiteral: *literal
`;
    const previous = parseConfigText(original);
    const next = structuredClone(previous);
    const providers = next.custom_provider as Record<string, { options: Record<string, unknown> }>;
    providers.work.options = { ...providers.work.options };
    delete providers.work.options.apiKey;

    const written = serializeConfigPreservingComments(original, previous, next);

    expect(parseConfigText(written)).toEqual(next);
  });

  it('keeps comments and formatting while changing one leaf', () => {
    const next = apply(ORIGINAL, (config) => {
      const provider = config.custom_provider as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      provider.mafia.options.baseURL = 'https://api.new.example.com/v1';
    });

    expect(next).toContain('# my providers');
    expect(next).toContain('# third party, owned by platform team');
    expect(next).toContain('# keep this note');
    expect(next).toContain('https://api.new.example.com/v1');
    expect(next).not.toContain('api.example.com/v1');
    // Untouched siblings keep their original shape.
    expect(next).toContain('logLevel: info');
    expect(next).toContain('context: 128000');
  });

  it('does not re-serialize an untouched reference into a nested map', () => {
    const next = apply(ORIGINAL, (config) => {
      config.defaultModel = 'mafia/gpt-x';
    });

    // The old dump-then-write path round-tripped the reference through the
    // parser and wrote a nested map here; the file must keep the reference.
    expect(next).toContain(['$', '{MAFIA_API_KEY}'].join(''));
    expect(next).not.toMatch(/env:/u);
  });

  it('deletes a removed key without disturbing its siblings', () => {
    const next = apply(ORIGINAL, (config) => {
      const provider = config.custom_provider as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      delete provider.mafia.options.baseURL;
    });

    expect(next).not.toContain('baseURL');
    // The emitter normalises the spaces before a trailing comment; the comment
    // itself is what has to survive.
    expect(next).toMatch(/apiKey: "\$\{MAFIA_API_KEY\}"\s+# keep this note/u);
    expect(next).toContain('# my providers');
  });

  it('adds a missing key under an existing parent', () => {
    const next = apply(ORIGINAL, (config) => {
      const provider = config.custom_provider as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      provider.mafia.options.authMode = 'api-key';
    });

    expect(next).toContain('authMode: api-key');
    expect(next).toContain('# keep this note');
  });

  it('produces a parseable document', () => {
    const next = apply(ORIGINAL, (config) => {
      config.defaultModel = 'mafia/gpt-x';
    });

    expect(parseConfigText(next)).toMatchObject({ defaultModel: 'mafia/gpt-x' });
  });

  it('falls back to a full dump when the original is unparseable', () => {
    const broken = 'custom_provider: [unclosed\n';
    const next = apply(broken, (config) => {
      config.defaultModel = 'mafia/gpt-x';
    });

    expect(parseConfigText(next)).toMatchObject({ defaultModel: 'mafia/gpt-x' });
  });

  it('preserves changes the caller made through a shared object', () => {
    const aliased = 'a: &p\n  x: 1\nb: *p\n';
    const next = apply(aliased, (config) => {
      (config.b as Record<string, number>).x = 2;
    });

    expect(parseConfigText(next)).toEqual({ a: { x: 2 }, b: { x: 2 } });
  });

  it('writes when the alias sits in the middle of the path', () => {
    // `mafia: *d` puts the alias above the leaf being written, so resolving
    // only the final node left getIn unable to descend past it.
    const midAlias = 'defaults: &d\n  baseURL: https://a\ncustom_provider:\n  mafia: *d\n';
    const next = apply(midAlias, (config) => {
      (config.custom_provider as Record<string, Record<string, unknown>>).mafia.apiKey = 'sk-x';
    });

    expect(parseConfigText(next)).toEqual({
      defaults: { baseURL: 'https://a', apiKey: 'sk-x' },
      custom_provider: { mafia: { baseURL: 'https://a', apiKey: 'sk-x' } },
    });
  });

  it('follows a merge-key alias', () => {
    const merged = 'a: &a\n  x: 1\nb: &b\n  <<: *a\n  y: 2\n';
    const next = apply(merged, (config) => {
      (config.b as Record<string, number>).x = 5;
    });

    expect(next).toContain('x: 5');
  });

  it('reports a self-referential anchor instead of overflowing the stack', () => {
    // The edit is on an unrelated key, so the circular anchor is emitted
    // untouched and the writer recurses through it.
    const circular = 'a: &s\n  self: *s\n  x: 1\nc: 1\n';
    const previous = parseConfigText(circular);
    const next = { ...previous, c: 2 };

    expect(() => serializeConfigPreservingComments(circular, previous, next)).toThrow(
      /self-referential YAML anchor/u,
    );
  });

  it('writes through a nested alias node', () => {
    const aliased = 'a: &p\n  x: 1\nc:\n  d: *p\n';
    const next = apply(aliased, (config) => {
      const c = config.c as { d: Record<string, number> };
      c.d.x = 5;
    });

    expect(next).toContain('x: 5');
  });

  it('removes a key a caller set to undefined instead of writing a null', () => {
    const next = apply(ORIGINAL, (config) => {
      const provider = config.custom_provider as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      provider.mafia.options.apiKey = undefined;
    });

    // `apiKey: null` reads as a configured-but-empty credential.
    expect(next).not.toContain('apiKey');
    expect(next).not.toContain('null');
  });

  it('handles an empty config file', () => {
    const next = apply('', (config) => {
      config.defaultModel = 'mafia/gpt-x';
    });

    expect(parseConfigText(next)).toMatchObject({ defaultModel: 'mafia/gpt-x' });
  });
});
