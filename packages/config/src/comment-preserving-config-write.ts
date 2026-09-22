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
  | { readonly kind: 'delete'; readonly path: string[] };

/**
 * Parses config text into the plain-object "before" state used for the diff.
 * Callers keep this separate from the object they mutate, because several write
 * paths hand that mutable object to a callback that aliases into it.
 */
export function parseConfigText(text: string): Record<string, unknown> {
  try {
    const parsed = yaml.load(text);
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
    useConfigLoaderScalarValues(document);
    materializeConfigReferences(document);
    for (const edit of edits) {
      const path = existingConfigPath(document, edit.path);
      if (edit.kind === 'delete') {
        document.deleteIn(path);
      } else {
        document.setIn(path, edit.value);
      }
    }
    const serialized = document.toString({ indent: 2, lineWidth: -1 });
    // The application loader is the final authority. Reject an invalid or
    // semantically different result before the atomic writer replaces the file.
    if (!isDeepStrictEqual(yaml.load(serialized), yaml.load(dumpConfig(next)))) {
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
function useConfigLoaderScalarValues(document: Document): void {
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
