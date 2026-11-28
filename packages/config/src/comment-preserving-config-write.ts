import { isDeepStrictEqual } from 'node:util';

import yaml from 'js-yaml';
import {
  isMap,
  isNode,
  isScalar,
  parseDocument,
  visit,
  type Alias,
  type Document,
  type Node,
  type YAMLMap,
} from 'yaml';

/**
 * Runtime rewrites of config.yaml must not throw away what the user wrote.
 *
 * The previous path parsed the file, mutated a plain object, and dumped that
 * object back, which dropped every comment and re-indented the whole file. Start
 * from the original document — which keeps comments and original formatting on
 * every node we do not touch — and write only the paths that actually changed.
 *
 * The diff is bounded: nested plain objects are walked key by key so comments
 * survive inside them, while anything else — a changed node kind, or a list — is
 * replaced as one value. That keeps the rewrite narrow instead of inventing a
 * merge rule for shapes this file does not use.
 */

type ConfigEdit =
  | { readonly kind: 'set'; readonly path: string[]; readonly value: unknown }
  | { readonly kind: 'delete'; readonly path: string[] }
  | { readonly kind: 'reorder'; readonly path: string[]; readonly keys: string[] };

/**
 * Parses config text into the plain-object "before" state used for the diff.
 * Callers keep this separate from the object they mutate, because several write
 * paths hand that mutable object to a callback that aliases into it.
 */
export function parseConfigText(text: string): Record<string, unknown> {
  return inspectConfigText(text).raw;
}

export type ConfigTextProblem = { kind: 'invalid_yaml'; line?: number } | { kind: 'invalid_root' };

/**
 * The rule parseConfigText and getConfig() share for turning config.yaml text
 * into a config object (file-loader and local-runtime-v2 still keep their own
 * stricter readers for explicit files and writes): invalid
 * YAML or a root that is not a mapping yields `{}` plus the reason. The reason
 * carries a line number only, never source text, which may contain credentials.
 */
export function inspectConfigText(text: string): {
  raw: Record<string, unknown>;
  problem?: ConfigTextProblem;
} {
  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (error) {
    const zeroBasedLine = (error as { mark?: { line?: unknown } } | undefined)?.mark?.line;
    return {
      raw: {},
      problem: {
        kind: 'invalid_yaml',
        ...(typeof zeroBasedLine === 'number' ? { line: zeroBasedLine + 1 } : {}),
      },
    };
  }
  if (parsed == null) return { raw: {} };
  return isPlainRecord(parsed) ? { raw: parsed } : { raw: {}, problem: { kind: 'invalid_root' } };
}

/**
 * Serializes `next` over `previous` while keeping comments and formatting from
 * `originalText`. Falls back to a full dump when the original cannot be parsed
 * into a document, so a hand-broken file still round-trips instead of vanishing.
 */
export function serializeConfigPreservingComments(
  originalText: string,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): string {
  const document = parseDocument(originalText, {
    schema: 'core',
    compat: 'yaml-1.1',
    customTags: ['timestamp'],
    merge: true,
  });
  if (document.errors.length > 0 || (!isMap(document.contents) && originalText.trim() !== '')) {
    return dumpConfig(next);
  }

  try {
    const edits = collectConfigEdits(previous, next);
    if (edits.length === 0) return originalText;
    reconcileConfigLoaderScalarValues(document);
    materializeConfigReferences(document);
    restoreCustomModelOrder(document, parseConfigText(originalText));
    for (const edit of edits) {
      const path = existingConfigPath(document, edit.path);
      if (edit.kind === 'delete') {
        document.deleteIn(path);
      } else if (edit.kind === 'reorder') {
        reorderConfigMap(document, path, edit.keys);
      } else {
        document.setIn(path, edit.value);
      }
    }
    const serialized = document.toString({ indent: 2, lineWidth: -1 });
    // The application loader is the final authority. Reject an invalid or
    // semantically different result before the atomic writer replaces the file.
    const loaded = yaml.load(serialized);
    const intended = yaml.load(dumpConfig(next));
    if (
      !isDeepStrictEqual(loaded, intended) ||
      collectConfigEdits(loaded, intended).some((edit) => edit.kind === 'reorder')
    ) {
      throw new Error('The serialized configuration does not match the intended values');
    }
    return serialized;
  } catch (error) {
    // A self-referential anchor (`&a { self: *a }`) makes the emitter recurse
    // without bound. That input cannot be written back in any form, so report
    // it as a config problem instead of letting a stack overflow escape.
    throw new Error(
      `config.yaml could not be rewritten: ${
        error instanceof Error ? error.message : String(error)
      }${error instanceof RangeError ? '. Remove the self-referential YAML anchor and retry.' : ''}`,
    );
  }
}

/** Keep alias expansion independent of the AST parser's implicit scalar rules. */
function reconcileConfigLoaderScalarValues(document: Document): void {
  visit(document, {
    Scalar(_key, node) {
      if (node.addToJSMap || typeof node.source !== 'string') return;
      if (node.type !== 'PLAIN' && !node.tag) return;
      // A mapping wrapper keeps values such as "---" from becoming directives.
      // node.source already contains YAML's folded multiline value. Quote it
      // before reparsing so its line breaks keep their meaning and indentation.
      // Explicit tags still apply to quoted values.
      const source =
        node.type === 'PLAIN' && !node.source.includes('\n')
          ? node.source
          : JSON.stringify(node.source);
      const tag = node.tag ? `!<${node.tag}> ` : '';
      const value = (yaml.load(`value: ${tag}${source}`) as { value: unknown }).value;
      if (!isDeepStrictEqual(node.value, value)) {
        node.value = value;
        delete node.format;
      }
    },
  });
}

/** JavaScript config keys are strings, while YAML keeps numeric/boolean keys typed. */
function existingConfigKey(map: YAMLMap, key: string): unknown {
  return map.items.find((pair) => isScalar(pair.key) && String(pair.key.value) === key)?.key ?? key;
}

function existingConfigPath(document: Document, path: readonly string[]): unknown[] {
  const resolved: unknown[] = [];
  let parent: unknown = document.contents;
  for (const key of path) {
    resolved.push(isMap(parent) ? existingConfigKey(parent, key) : key);
    parent = document.getIn(resolved, true);
  }
  return resolved;
}

/**
 * Provider updates can replace one options object while leaving its former
 * aliases unchanged. Snapshot references before editing their sources, so YAML
 * sharing cannot reintroduce coupling the application has already removed.
 * Materialize merge fields too: deleting an inherited key must not expose the
 * value again through `<<`. Explicit nodes retain their comments and styles.
 */
function materializeConfigReferences(document: Document): void {
  const aliases = new Map<Alias, Node>();
  visit(document, {
    Alias(_key, alias) {
      const value: unknown = alias.toJS(document);
      const node = createConfigNode(document, value);
      node.comment = alias.comment;
      node.commentBefore = alias.commentBefore;
      node.spaceBefore = alias.spaceBefore;
      aliases.set(alias, node);
    },
  });
  visit(document, { Alias: (_key, alias) => aliases.get(alias) });
  visit(document, {
    Map(_key, map) {
      const merges = map.items.filter((pair) => isScalar(pair.key) && pair.key.addToJSMap);
      if (merges.length === 0) return;
      const values = map.toJS(document) as Record<string, unknown>;
      const comments = merges.flatMap((pair) =>
        [pair.key, pair.value].flatMap((node) =>
          isNode(node) ? [node.commentBefore, node.comment] : [],
        ),
      );
      map.commentBefore = [map.commentBefore, ...comments].filter(Boolean).join('\n') || undefined;
      map.items = map.items.filter((pair) => !merges.includes(pair));
      for (const [key, value] of Object.entries(values)) {
        if (!map.has(existingConfigKey(map, key))) {
          map.set(key, createConfigNode(document, value));
        }
      }
    },
  });
  // All merge pairs are gone. Disable merge emission, and quote strings that
  // either scalar schema could interpret (including the loader's 0b integers).
  document.setSchema(document.directives?.yaml.version ?? '1.2', {
    schema: 'core',
    compat: 'yaml-1.1',
    customTags: ['timestamp'],
    merge: false,
  });
}

function createConfigNode(document: Document, value: unknown): Node {
  const node = document.createNode(value, { aliasDuplicateObjects: false });
  // A resolved object's literal "<<" property has already lost its YAML quote
  // metadata. Quote it again so materialization cannot turn it into a merge.
  visit(node, {
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === '<<') pair.key.type = 'QUOTE_DOUBLE';
    },
  });
  return node;
}

function restoreCustomModelOrder(document: Document, previous: Record<string, unknown>): void {
  if (!isPlainRecord(previous.custom_provider)) return;
  for (const [providerId, provider] of Object.entries(previous.custom_provider)) {
    if (!isPlainRecord(provider) || !isPlainRecord(provider.models)) continue;
    // Expanding YAML merges appends inherited pairs after explicit ones. Restore
    // the loader's original order before applying mutations, even for unrelated writes.
    const path = existingConfigPath(document, ['custom_provider', providerId, 'models']);
    reorderConfigMap(document, path, Object.keys(provider.models));
  }
}

function reorderConfigMap(document: Document, path: unknown[], keys: string[]): void {
  const map = document.getIn(path, true);
  if (!isMap(map)) throw new Error('Expected a model mapping when applying config order');
  const pairs = new Map(
    map.items.map((pair) => [isScalar(pair.key) ? String(pair.key.value) : pair.key, pair]),
  );
  // Move existing pairs rather than recreating nodes, so model comments and styles survive.
  map.items = keys.map((key) => {
    const pair = pairs.get(key);
    if (!pair) throw new Error('Expected an existing model when applying config order');
    return pair;
  });
}

function collectConfigEdits(previous: unknown, next: unknown, path: string[] = []): ConfigEdit[] {
  if (!isPlainRecord(previous) || !isPlainRecord(next)) {
    return valuesEqual(previous, next) ? [] : [{ kind: 'set', path, value: next }];
  }
  const edits: ConfigEdit[] = [];
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const childPath = [...path, key];
    // A caller that assigns undefined is removing the value; writing it back
    // would emit `key: null`, which reads as a configured-but-empty field.
    if (!(key in next) || next[key] === undefined) {
      edits.push({ kind: 'delete', path: childPath });
    } else if (!(key in previous)) {
      edits.push({ kind: 'set', path: childPath, value: next[key] });
    } else {
      edits.push(...collectConfigEdits(previous[key], next[key], childPath));
    }
  }
  // BYOK model catalogs use mapping insertion order as their display order.
  // Apply this after child edits so added/removed models are included correctly.
  if (path.length === 3 && path[0] === 'custom_provider' && path[2] === 'models') {
    const keys = Object.keys(next).filter((key) => next[key] !== undefined);
    if (!isDeepStrictEqual(Object.keys(previous), keys)) {
      edits.push({ kind: 'reorder', path, keys });
    }
  }
  return edits;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function dumpConfig(next: Record<string, unknown>): string {
  return yaml.dump(next, { indent: 2, lineWidth: -1, noRefs: true });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
