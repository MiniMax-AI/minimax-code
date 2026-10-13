#!/usr/bin/env node
// Public Plugin manifest validator for the MiniMax Code Plugin format V1.
//
// This is the entry point an external author runs to check a Plugin package
// before submitting it. It validates the parts of the V1 contract that are
// fully expressible from the published JSON Schema files and the portable path
// rules, using only the repository's existing dependencies.
//
// It deliberately does not reimplement the internal Publisher or the official
// Marketplace validator. Those remain authoritative for catalog membership and
// for the checks that need the full marketplace tree (cross-file capability
// closure, archive limits, content_digest). See docs/plugins/package-format-v1.md.

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA_DIR = join(REPO_ROOT, "schemas", "plugins");

const SCHEMA_FILES = {
  "plugin-v1": "plugin-v1.schema.json",
  "mcp-v1": "mcp-v1.schema.json",
  "app-v1": "app-v1.schema.json",
  "host-binding-v1": "host-binding-v1.schema.json",
};

// V1 portable path limits, from docs/plugins/package-format-v1.md section 3.
const MAX_PATH_BYTES = 512;
const MAX_SEGMENT_BYTES = 128;
const MAX_PATH_SEGMENTS = 16;
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;
const WINDOWS_RESERVED =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

const failures = [];
const notes = [];

function fail(code, detail) {
  failures.push({ code, detail });
}

function readSchema(name) {
  const file = SCHEMA_FILES[name];
  if (!file) throw new Error(`Unknown schema: ${name}`);
  const path = join(SCHEMA_DIR, file);
  if (!existsSync(path))
    throw new Error(`Schema file is missing: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

// Minimal JSON Schema draft 2020-12 subset covering the keywords used by the
// published Plugin schemas. Unsupported keywords are reported rather than
// silently ignored, so the validator can never pass a document it did not
// actually check.
const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "minProperties",
  "maxProperties",
  "propertyNames",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "anyOf",
  "allOf",
  "oneOf",
  "not",
  "$ref",
  "$defs",
]);

// Resolve a local "$ref" against the root schema. Only same-document JSON pointers
// are supported, which is all the published Plugin schemas use.
function resolveRef(ref, rootSchema, location) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    fail("SCHEMA_UNSUPPORTED_REF", `${location}: unsupported $ref "${ref}"`);
    return undefined;
  }
  let current = rootSchema;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (current === undefined || current === null) {
      fail("SCHEMA_BAD_REF", `${location}: $ref "${ref}" does not resolve`);
      return undefined;
    }
    current = current[segment];
  }
  if (current === undefined) {
    fail("SCHEMA_BAD_REF", `${location}: $ref "${ref}" does not resolve`);
    return undefined;
  }
  return current;
}

function checkSchemaSupport(schema, location = "#", sink = notes) {
  if (typeof schema !== "object" || schema === null) return;
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => checkSchemaSupport(item, `${location}/${index}`, sink));
    return;
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" || key === "$defs") {
      for (const [name, sub] of Object.entries(value ?? {}))
        checkSchemaSupport(sub, `${location}/${key}/${name}`, sink);
      continue;
    }
    if (!SUPPORTED_KEYWORDS.has(key)) {
      sink.push(
        `${location}: schema keyword "${key}" is not checked by the public validator`,
      );
      continue;
    }
    checkSchemaSupport(value, `${location}/${key}`, sink);
  }
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

// The published Plugin schemas only use the "uri" format. Keeping this explicit
// means an unknown format is reported instead of silently passing.
function checkFormat(format, value, location) {
  if (format === "uri") {
    try {
      const url = new URL(value);
      return url.protocol.length > 1;
    } catch {
      fail("SCHEMA_FORMAT", `${location}: is not an absolute URI`);
      return false;
    }
  }
  fail("SCHEMA_UNSUPPORTED_FORMAT", `${location}: format "${format}" is not supported`);
  return false;
}

function typeMatches(expected, value) {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  if (expected === "integer") return actual === "integer";
  return actual === expected;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a))
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (a && typeof a === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    return ka.every((key, i) => key === kb[i] && deepEqual(a[key], b[key]));
  }
  return false;
}

function validate(value, schema, location, rootSchema) {
  if (schema === true) return;
  if (schema === false) {
    fail("SCHEMA_REJECTED", `${location}: schema rejects every value`);
    return;
  }
  if (typeof schema !== "object" || schema === null) return;

  if (schema.$ref !== undefined) {
    const resolved = resolveRef(schema.$ref, rootSchema, location);
    if (resolved !== undefined) validate(value, resolved, location, rootSchema);
    return;
  }

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((t) => typeMatches(t, value)))
      fail(
        "SCHEMA_TYPE",
        `${location}: expected ${expected.join(" | ")}, got ${typeOf(value)}`,
      );
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const))
    fail("SCHEMA_CONST", `${location}: must equal ${JSON.stringify(schema.const)}`);

  if (schema.enum !== undefined && !schema.enum.some((item) => deepEqual(item, value)))
    fail("SCHEMA_ENUM", `${location}: must be one of ${JSON.stringify(schema.enum)}`);

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      fail("SCHEMA_MINIMUM", `${location}: ${value} < ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      fail("SCHEMA_MAXIMUM", `${location}: ${value} > ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)
      fail("SCHEMA_EXCLUSIVE_MIN", `${location}: ${value} <= ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum)
      fail("SCHEMA_EXCLUSIVE_MAX", `${location}: ${value} >= ${schema.exclusiveMaximum}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength)
      fail("SCHEMA_MIN_LENGTH", `${location}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength)
      fail("SCHEMA_MAX_LENGTH", `${location}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value))
      fail("SCHEMA_PATTERN", `${location}: does not match ${schema.pattern}`);
    if (schema.format !== undefined && !checkFormat(schema.format, value, location))
      fail("SCHEMA_FORMAT", `${location}: is not a valid ${schema.format}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      fail("SCHEMA_MIN_ITEMS", `${location}: needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      fail("SCHEMA_MAX_ITEMS", `${location}: allows at most ${schema.maxItems} items`);
    if (schema.uniqueItems === true) {
      for (let i = 0; i < value.length; i += 1)
        for (let j = i + 1; j < value.length; j += 1)
          if (deepEqual(value[i], value[j]))
            fail("SCHEMA_UNIQUE_ITEMS", `${location}: items ${i} and ${j} are equal`);
    }
    if (schema.items !== undefined)
      value.forEach((item, index) =>
        validate(item, schema.items, `${location}/${index}`, rootSchema),
      );
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? [])
      if (!(key in value)) fail("SCHEMA_REQUIRED", `${location}: missing "${key}"`);
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties)
      fail("SCHEMA_MIN_PROPERTIES", `${location}: needs at least ${schema.minProperties} properties`);
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties)
      fail("SCHEMA_MAX_PROPERTIES", `${location}: allows at most ${schema.maxProperties} properties`);
    if (schema.propertyNames !== undefined)
      for (const key of Object.keys(value))
        validate(key, schema.propertyNames, `${location}/${key}<name>`, rootSchema);
    const properties = schema.properties ?? {};
    for (const [key, sub] of Object.entries(properties))
      if (key in value) validate(value[key], sub, `${location}/${key}`, rootSchema);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value))
        if (!(key in properties))
          fail("SCHEMA_ADDITIONAL", `${location}: unknown property "${key}"`);
    } else if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === "object") {
      const known = new Set(Object.keys(properties));
      for (const key of Object.keys(value))
        if (!known.has(key))
          validate(value[key], schema.additionalProperties, `${location}/${key}`, rootSchema);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const passed = schema.anyOf.some((sub) => {
      const before = failures.length;
      validate(value, sub, location, rootSchema);
      const passed = failures.length === before;
      if (!passed) failures.length = before;
      return passed;
    });
    if (!passed) fail("SCHEMA_ANY_OF", `${location}: matches none of the anyOf branches`);
  }
  if (Array.isArray(schema.allOf))
    schema.allOf.forEach((sub, i) => validate(value, sub, `${location}/allOf/${i}`, rootSchema));
  if (Array.isArray(schema.oneOf)) {
    const passing = schema.oneOf.filter((sub) => {
      const before = failures.length;
      validate(value, sub, location, rootSchema);
      const passed = failures.length === before;
      if (!passed) failures.length = before;
      return passed;
    }).length;
    if (passing !== 1)
      fail("SCHEMA_ONE_OF", `${location}: matched ${passing} oneOf branches, expected 1`);
  }
  if (schema.not !== undefined) {
    const before = failures.length;
    validate(value, schema.not, location, rootSchema);
    if (failures.length === before) fail("SCHEMA_NOT", `${location}: must not match "not"`);
    else failures.length = before;
  }
}

// Section 3 portable path contract.
function validatePortablePath(reference, location) {
  if (typeof reference !== "string" || reference.length === 0) {
    fail("PATH_TYPE", `${location}: path must be a non-empty string`);
    return;
  }
  if (reference.includes("\\"))
    fail("PATH_BACKSLASH", `${location}: backslash is not allowed: ${reference}`);
  if (reference.includes("\0"))
    fail("PATH_NUL", `${location}: NUL is not allowed`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(reference))
    fail("PATH_CONTROL", `${location}: control character is not allowed`);
  if (reference.startsWith("/"))
    fail("PATH_ABSOLUTE", `${location}: absolute path is not allowed: ${reference}`);
  if (/^[A-Za-z]:/u.test(reference))
    fail("PATH_DRIVE", `${location}: drive letter is not allowed: ${reference}`);
  if (reference.endsWith("/"))
    fail("PATH_TRAILING_SLASH", `${location}: trailing slash is not allowed: ${reference}`);
  if (Buffer.byteLength(reference, "utf8") > MAX_PATH_BYTES)
    fail("PATH_TOO_LONG", `${location}: exceeds ${MAX_PATH_BYTES} bytes`);

  const segments = reference.split("/");
  if (segments.length > MAX_PATH_SEGMENTS)
    fail("PATH_TOO_DEEP", `${location}: exceeds ${MAX_PATH_SEGMENTS} segments`);
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..")
      fail("PATH_SEGMENT", `${location}: illegal segment "${segment}"`);
    if (Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES)
      fail("PATH_SEGMENT_LONG", `${location}: segment exceeds ${MAX_SEGMENT_BYTES} bytes`);
    if (!SEGMENT_PATTERN.test(segment))
      fail(
        "PATH_CHARSET",
        `${location}: segment "${segment}" is not portable ASCII [A-Za-z0-9._-]`,
      );
    if (WINDOWS_RESERVED.test(segment))
      fail("PATH_RESERVED", `${location}: reserved name "${segment}"`);
  }
}

function parseJsonObject(text, location) {
  if (text.charCodeAt(0) === 0xfeff)
    fail("JSON_BOM", `${location}: UTF-8 BOM is not allowed`);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail("JSON_PARSE", `${location}: ${error.message}`);
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("JSON_OBJECT", `${location}: top-level value must be an object`);
    return undefined;
  }
  return value;
}

// The frontmatter subset a Skill needs is a flat mapping of scalar values.
// Parsing it here keeps this validator free of runtime dependencies, because
// check:source also runs it inside the exported source snapshot, which has no
// node_modules. A full YAML parser is not required to enforce the V1 contract,
// and using one would make the public validator unusable in that context.
function parseFrontmatter(text) {
  const result = {};
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    )
      value = value.slice(1, -1);
    if (Object.hasOwn(result, key)) return { error: `duplicate frontmatter key "${key}"` };
    result[key] = value;
  }
  return { result };
}

function validateSkill(skillPath, location) {
  if (!existsSync(skillPath)) {
    fail("SKILL_MISSING", `${location}: ${skillPath} does not exist`);
    return;
  }
  const text = readFileSync(skillPath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) fail("SKILL_BOM", `${location}: BOM is not allowed`);
  if (!text.startsWith("---"))
    fail("SKILL_FRONTMATTER", `${location}: must start with YAML frontmatter`);
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  if (!match) {
    fail("SKILL_FRONTMATTER", `${location}: frontmatter block is not closed`);
    return;
  }
  const parsed = parseFrontmatter(match[1]);
  if (parsed.error) {
    fail("SKILL_YAML", `${location}: ${parsed.error}`);
    return;
  }
  const frontmatter = parsed.result;
  if (typeof frontmatter.name !== "string" || frontmatter.name.trim() === "")
    fail("SKILL_NAME", `${location}: frontmatter "name" is required`);
  if (typeof frontmatter.description !== "string" || frontmatter.description.trim() === "")
    fail("SKILL_DESCRIPTION", `${location}: frontmatter "description" is required`);

  // name must match the containing directory
  const dirName = relative(join(skillPath, "..", ".."), skillPath)
    .split(sep)
    .slice(0, 1)[0];
  if (typeof frontmatter.name === "string" && dirName && frontmatter.name !== dirName)
    fail("SKILL_NAME_MISMATCH", `${location}: name "${frontmatter.name}" != directory "${dirName}"`);
}

function validatePackage(root) {
  const manifestPath = join(root, ".minimax-plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    fail("MANIFEST_MISSING", `${manifestPath} does not exist`);
    return;
  }
  const manifest = parseJsonObject(readFileSync(manifestPath, "utf8"), ".minimax-plugin/plugin.json");
  if (!manifest) return;

  const pluginSchema = readSchema("plugin-v1");
  checkSchemaSupport(pluginSchema);
  validate(manifest, pluginSchema, "plugin.json", pluginSchema);

  // name must match the package directory
  const dirName = root.split(sep).filter(Boolean).pop();
  if (typeof manifest.name === "string" && dirName && manifest.name !== dirName)
    fail("NAME_MISMATCH", `manifest name "${manifest.name}" != directory "${dirName}"`);

  for (const [field, schemaName] of [
    ["mcpServers", "mcp-v1"],
    ["apps", "app-v1"],
    ["hostBindings", "host-binding-v1"],
  ]) {
    const references = manifest[field];
    if (!Array.isArray(references)) continue;
    for (const reference of references) {
      validatePortablePath(reference, `plugin.json ${field}`);
      if (typeof reference !== "string") continue;
      const target = join(root, reference);
      if (!existsSync(target)) {
        fail("REFERENCE_MISSING", `plugin.json ${field}: ${reference} does not exist`);
        continue;
      }
      const schema = readSchema(schemaName);
      checkSchemaSupport(schema);
      const value = parseJsonObject(readFileSync(target, "utf8"), reference);
      if (value) validate(value, schema, reference, schema);
    }
  }

  if (Array.isArray(manifest.skills)) {
    for (const reference of manifest.skills) {
      validatePortablePath(reference, "plugin.json skills");
      if (typeof reference !== "string") continue;
      validateSkill(join(root, reference), `plugin.json skills: ${reference}`);
    }
  }

  if (Array.isArray(manifest.hooks))
    for (const reference of manifest.hooks) {
      validatePortablePath(reference, "plugin.json hooks");
      if (typeof reference !== "string") continue;
      if (!existsSync(join(root, reference)))
        fail("REFERENCE_MISSING", `plugin.json hooks: ${reference} does not exist`);
    }
}

function listFiles(directory, prefix = "") {
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      fail("SYMLINK", `${prefix}${entry.name}: symlinks are not allowed`);
      continue;
    }
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(directory, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

export function validatePlugin(root) {
  failures.length = 0;
  notes.length = 0;
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(`Not a directory: ${root}`);
  validatePackage(root);
  for (const file of listFiles(root)) validatePortablePath(file, "package tree");
  return { failures: [...failures], notes: [...notes] };
}

// Contract self-check used by check:source. It does not validate a Plugin
// package; it validates that the published contract assets are present, parse,
// and agree with each other, so the public validator cannot silently rot.
export function validatePluginContract(repoRoot = REPO_ROOT) {
  const problems = [];

  for (const [name, file] of Object.entries(SCHEMA_FILES)) {
    const path = join(repoRoot, "schemas", "plugins", file);
    if (!existsSync(path)) {
      problems.push(`missing schema: schemas/plugins/${file} (${name})`);
      continue;
    }
    try {
      const schema = JSON.parse(readFileSync(path, "utf8"));
      if (schema.$schema !== undefined && schema.$schema.includes("draft/2020-12")) {
        const unsupported = [];
        checkSchemaSupport(schema, "#", unsupported);
        for (const note of unsupported) problems.push(`${file}: ${note}`);
      }
    } catch (error) {
      problems.push(`unreadable schema: schemas/plugins/${file}: ${error.message}`);
    }
  }

  for (const vector of ["content-digest-v1.source.json", "content-digest-v1.expected.json"]) {
    const path = join(repoRoot, "test-vectors", "plugins", vector);
    if (!existsSync(path)) {
      problems.push(`missing reference vector: test-vectors/plugins/${vector}`);
      continue;
    }
    try {
      JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      problems.push(`unreadable reference vector: ${vector}: ${error.message}`);
    }
  }

  // Every schema referenced from the published docs must exist in the repo.
  const docsDir = join(repoRoot, "docs", "plugins");
  if (existsSync(docsDir)) {
    for (const file of readdirSync(docsDir)) {
      if (!file.endsWith(".md")) continue;
      const text = readFileSync(join(docsDir, file), "utf8");
      for (const match of text.matchAll(/\]\((\.\.\/\.\.\/[^)#]+)\)/gu)) {
        const target = join(docsDir, match[1]);
        if (!existsSync(target))
          problems.push(`docs/plugins/${file}: broken link to ${match[1]}`);
      }
    }
  }

  return problems;
}

function main(argv) {
  const target = argv[0] ?? process.cwd();
  let result;
  try {
    result = validatePlugin(target);
  } catch (error) {
    console.error(`validate-plugin: ${error.message}`);
    return 2;
  }
  for (const note of result.notes) console.log(`note: ${note}`);
  for (const { code, detail } of result.failures)
    console.error(`error: ${code}: ${detail}`);
  if (result.failures.length > 0) {
    console.error(
      `\nvalidate-plugin: ${result.failures.length} problem(s) found in ${target}`,
    );
    return 1;
  }
  console.log(`validate-plugin: ${target} passed the public Plugin V1 checks.`);
  console.log(
    "Note: catalog membership, cross-file closure, archive limits and content_digest are validated by the official Marketplace validator at submission time.",
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
