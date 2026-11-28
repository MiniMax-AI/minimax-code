import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import yaml from 'yaml';
import {
  BROWSER_PROGRAM_API,
  BROWSER_PROGRAM_EXAMPLES,
  CONTROL_IN_APP_BROWSER_SKILL_NAME,
} from '@mavis/agent-tools/desktop';

import type { BrowserUseBuiltinSkillDescriptor } from '../contracts.js';

/** The Skill's part that `run_script` makes untrue on a Browser program turn. */
const SCRIPT_SECTION_HEADING = '## Scripted Input With run_script\n';
const AFTER_SCRIPT_SECTION_HEADING = '## Screenshot Visibility Boundary\n';
const PROGRAM_SECTION_BEFORE_HEADING = '## Start With Inspect\n';
/**
 * The end of the program section: the library declarations and examples, from
 * the constants the guest library is checked against. The Browser description
 * leaves them to this Skill.
 */
const PROGRAM_LIBRARY_REFERENCE = `### Library Declarations

\`\`\`ts
${BROWSER_PROGRAM_API}
\`\`\`

### Short Examples

\`\`\`js
${BROWSER_PROGRAM_EXAMPLES}
\`\`\`
`;
const PROGRAM_JAVASCRIPT_RULE =
  '- Page JavaScript runs only through a program\'s `page.evaluate` family under "Page JavaScript"\n  above. Never simulate JavaScript execution through another tool.\n';
const PROGRAM_TEXT_REPLACEMENTS: readonly (readonly [string, string])[] = [
  [
    'Read page data with `query`, not a `run_script` that reads the DOM:\n',
    'A single step reads page data with `query`; a program reads with its locators:\n',
  ],
  [
    `- Arbitrary JavaScript execution is unavailable outside \`run_script\`: when the active provider
  exposes \`run_script\`, page JavaScript runs only through its \`page.evaluate\` under the evidence
  rules above; otherwise it is unavailable entirely. Never simulate JavaScript execution through
  another tool.\n`,
    PROGRAM_JAVASCRIPT_RULE,
  ],
  [
    `When this turn exposes Browser only inside \`run_code\`, "one at a time" means awaiting each Browser
call in order inside the program, not one model response per action. Put one whole bounded step in a
single program: fill the related fields, type a search term with \`observe.waitForText\`, click the
matching option from that observation, and read the form back. Check`,
    `Single-step Browser calls inside \`run_code\` run one at a time; Browser Programs above says what
belongs in one program. Check`,
  ],
  // The Mini App section: on a program turn run_script is the program, not the page script API.
  [
    'Use [run_script](#scripted-input-with-run_script)\nfor multi-step input or page checks.',
    'Use a `run_script` program (Browser Programs below)\nfor multi-step input or page checks.',
  ],
  // Tab control: a program takes control of its own pages by writing them (Browser Programs says how).
  [
    'including\nthe writes of a Browser program)',
    'including\nthe writes of a Browser program; a program takes control as "Pages And Control" in\nBrowser Programs says)',
  ],
  [
    'On Electron, `run_script` works on your current HTTP(S) web page or Mini App tab. It uses the same\n`page` API, real keyboard/mouse input, screenshots, timeout and input release as the headless provider.\n',
    'On Electron, a `run_script` program works on your current HTTP(S) web page or Mini App tab. A\nprogram cannot open a Mini App: open it with the single-step `open_tab` first (it becomes the\ntab you control), then use `browser.page()`.\n',
  ],
];

/**
 * The Browser Use Plugin's Skill rule that a program turn's page JavaScript
 * makes untrue (Plugin 1.0.11, in production, carries it). A Plugin Skill
 * without it is left as is.
 */
const PLUGIN_NO_JAVASCRIPT_RULE =
  '- Arbitrary JavaScript execution is unavailable and must not be simulated through another tool.\n';

/**
 * Appended to the Browser Use Plugin's Skill (desktop): the Plugin-bound Browser
 * loads on demand, and Plugin Skills before 1.0.16 say it is listed in `tools[]`,
 * that control is unavailable when it is not, or that the client must be updated.
 *
 * @internal Exported only for focused tests.
 */
export const BROWSER_PLUGIN_ON_DEMAND_NOTE =
  'Host note for this app: `mcp_browser` is loaded on demand and is not in your tool list. Load it with `tool_search` using the exact name `mcp_browser`, then call it through `mcp_invoke` (inside `run_code`: `await tools.mcp_browser({ action, input })`). This note overrides any statement above that `mcp_browser` is in `tools[]`, that Browser control is unavailable when it is not listed, or that the client must be updated.';

let cached: BrowserUseBuiltinSkillDescriptor | undefined;
let cachedShort: BrowserUseBuiltinSkillDescriptor | undefined;
let cachedProgram: BrowserUseBuiltinSkillDescriptor | undefined;
let cachedShortProgram: BrowserUseBuiltinSkillDescriptor | undefined;
let cachedProgramSection: string | undefined;

/** Reads the package-owned Browser Skill and fails closed when packaging is incomplete. */
export function readBrowserUseBuiltinSkillAsset(): BrowserUseBuiltinSkillDescriptor {
  cached ??= loadBrowserUseBuiltinSkillAsset();
  return cached;
}

/**
 * `browser.compactInspect`: the same Skill in its short form, for the
 * compact page format: SKILL.md with the sections `references/skill-short.md`
 * words differently. `references/browser-details.md` holds what it left out.
 */
export function readBrowserUseShortSkillAsset(): BrowserUseBuiltinSkillDescriptor {
  cachedShort ??= loadBrowserUseShortSkillAsset();
  return cachedShort;
}

/**
 * The same Skill for a turn whose `run_script` is a Browser program. Only the
 * content differs: the program section, with the library declarations and
 * examples, stands in for the page script section, so the other turns keep
 * SKILL.md byte for byte. `short` starts from the short Skill.
 */
export function readBrowserUseProgramSkillAsset(short = false): BrowserUseBuiltinSkillDescriptor {
  if (short) {
    cachedShortProgram ??= loadBrowserUseProgramSkillAsset(readBrowserUseShortSkillAsset());
    return cachedShortProgram;
  }
  cachedProgram ??= loadBrowserUseProgramSkillAsset(readBrowserUseBuiltinSkillAsset());
  return cachedProgram;
}

/**
 * The Browser Use Plugin's Skill (desktop) on a Browser program turn: the
 * program section goes before its "Start With Inspect" section (else at the
 * end), and its no-JavaScript rule, when it has one, names the program's page
 * JavaScript. The Plugin Skill has no page script section. The section's calls
 * name `toolName`, the tool the Plugin-bound Browser is listed as. Missing
 * assets fail the load instead of returning an incomplete program guide.
 */
export function withBrowserProgramSection(content: string, toolName: string): string {
  const section = readBrowserProgramSection()
    .replaceAll('`browser({', `\`${toolName}({`)
    .replaceAll('tools.browser(', `tools.${toolName}(`)
    .replaceAll('"query": "browser"', `"query": "${toolName}"`);
  const insertAt = content.indexOf(PROGRAM_SECTION_BEFORE_HEADING);
  const withProgram =
    insertAt < 0
      ? `${content.trimEnd()}\n\n${section}`
      : `${content.slice(0, insertAt)}${section}\n${content.slice(insertAt)}`;
  return withProgram.replace(PLUGIN_NO_JAVASCRIPT_RULE, PROGRAM_JAVASCRIPT_RULE);
}

/** The Plugin's Skill (desktop) with {@link BROWSER_PLUGIN_ON_DEMAND_NOTE} at its end. */
export function withBrowserOnDemandNote(content: string): string {
  return `${content.trimEnd()}\n\n${BROWSER_PLUGIN_ON_DEMAND_NOTE}\n`;
}

/** `references/browser-programs.md` followed by the library declarations and examples. */
function readBrowserProgramSection(): string {
  cachedProgramSection ??= `${readFileSync(
    join(dirname(resolveBrowserUseSkillAssetPath()), 'references', 'browser-programs.md'),
    'utf8',
  ).trimEnd()}\n\n${PROGRAM_LIBRARY_REFERENCE}`;
  return cachedProgramSection;
}

function loadBrowserUseShortSkillAsset(): BrowserUseBuiltinSkillDescriptor {
  const skill = readBrowserUseBuiltinSkillAsset();
  const shortSections = readFileSync(
    join(dirname(resolveBrowserUseSkillAssetPath()), 'references', 'skill-short.md'),
    'utf8',
  )
    .split(/^(?=## )/mu)
    .filter((section) => section.startsWith('## '));
  const content = shortSections.reduce((text, section) => {
    const heading = section.slice(0, section.indexOf('\n') + 1);
    const start = requiredIndex(text, `\n${heading}`) + 1;
    // Every replaced section has a next one, so the blank line before it stays SKILL.md's.
    const end = requiredIndex(text.slice(start), '\n## ') + start;
    return `${text.slice(0, start)}${section.trimEnd()}\n${text.slice(end)}`;
  }, skill.content);
  return Object.freeze({ ...skill, content });
}

function loadBrowserUseProgramSkillAsset(
  skill: BrowserUseBuiltinSkillDescriptor,
): BrowserUseBuiltinSkillDescriptor {
  const programSection = readBrowserProgramSection();
  const scriptStart = requiredIndex(skill.content, SCRIPT_SECTION_HEADING);
  const scriptEnd = requiredIndex(skill.content, AFTER_SCRIPT_SECTION_HEADING);
  const withoutScript = skill.content.slice(0, scriptStart) + skill.content.slice(scriptEnd);
  const insertAt = requiredIndex(withoutScript, PROGRAM_SECTION_BEFORE_HEADING);
  const withProgram = `${withoutScript.slice(0, insertAt)}${programSection}\n${withoutScript.slice(insertAt)}`;
  const content = PROGRAM_TEXT_REPLACEMENTS.reduce((text, [from, to]) => {
    requiredIndex(text, from);
    return text.replace(from, to);
  }, withProgram);
  return Object.freeze({ ...skill, content });
}

function requiredIndex(content: string, text: string): number {
  const index = content.indexOf(text);
  if (index < 0) throw new Error(`Browser Use built-in Skill has no "${text.trim()}".`);
  return index;
}

function loadBrowserUseBuiltinSkillAsset(): BrowserUseBuiltinSkillDescriptor {
  const location = resolveBrowserUseSkillAssetPath();
  const content = readFileSync(location, 'utf8');
  const frontmatter = parseFrontmatter(content);
  if (frontmatter.name !== CONTROL_IN_APP_BROWSER_SKILL_NAME) {
    throw new Error('Browser Use built-in Skill has an invalid name.');
  }
  const description =
    typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!description) throw new Error('Browser Use built-in Skill has no description.');
  return Object.freeze({
    name: CONTROL_IN_APP_BROWSER_SKILL_NAME,
    description,
    content,
    location: pathToFileURL(location).href.replace(/^file:/u, 'files:'),
    sourceKind: 'builtin',
  });
}

function resolveBrowserUseSkillAssetPath(): string {
  const relative = join('mavis', 'skills', CONTROL_IN_APP_BROWSER_SKILL_NAME, 'SKILL.md');
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Both src/service/browser-use/assets and dist/service/browser-use/assets
    // sit four levels below the package root.
    resolve(here, '../../../../assets/agents', relative),
    resolve(here, 'assets/agents', relative),
    resolve(process.cwd(), 'packages/local-runtime-v2/assets/agents', relative),
    resolve(process.cwd(), 'assets/agents', relative),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // Continue through source, compiled package, and bundled package layouts.
    }
  }
  throw new Error('Browser Use built-in Skill asset is missing.');
}

function parseFrontmatter(content: string): Readonly<Record<string, unknown>> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) throw new Error('Browser Use built-in Skill has no frontmatter.');
  const value: unknown = yaml.parse(match[1] ?? '');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Browser Use built-in Skill frontmatter is invalid.');
  }
  return value as Readonly<Record<string, unknown>>;
}
