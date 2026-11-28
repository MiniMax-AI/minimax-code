import type { RuntimeTool, ToolResult, ToolResultContent } from '@mavis/agent-core/tools';
import { Type } from '@sinclair/typebox';

import {
  BROWSER_RUN_SCRIPT_GUIDANCE,
  BROWSER_SCRIPT_JAVASCRIPT_RULE,
  LocalBrowserToolDef,
} from './builtin-browser-defs.js';
import type { LocalBrowserProgramOpAction, LocalRuntimeToolContext } from './types.js';

/**
 * Browser programs: on a PTC Turn whose provider declares `programOps`,
 * run_script runs a Playwright-style page program instead of a page script.
 * The executor (QuickJS in a Worker) lives in local-runtime-v2; this package
 * only knows its contract, so it never depends on Browser Core.
 */
export const BROWSER_PROGRAM_OP_ACTION: LocalBrowserProgramOpAction = 'program_op';

export const BROWSER_PROGRAM_DEFAULT_TIMEOUT_MS = 120_000;
export const BROWSER_PROGRAM_MAX_TIMEOUT_MS = 600_000;
export const BROWSER_PROGRAM_MAX_OPS = 500;

/** One page operation's answer: the provider's op result, and an explicit screenshot if any. */
export interface BrowserProgramOpOutcome {
  readonly result: Readonly<Record<string, unknown>>;
  readonly media?: readonly ToolResultContent[];
}

export interface BrowserProgramRunRequest {
  readonly ctx: LocalRuntimeToolContext;
  readonly code: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Runs one op through the Browser tool's session queue, Skill receipt and provider. */
  runOp(
    op: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<BrowserProgramOpOutcome>;
}

/** The program executor (local-runtime-v2 `service/browser-use/program`). */
export interface BrowserProgramRunner {
  run(request: BrowserProgramRunRequest): Promise<ToolResult>;
}

/** The model-facing declarations of the program library (guest-library.ts implements them). */
export const BROWSER_PROGRAM_API = `declare const browser: { page(): Promise<Page>; tabs(): Promise<Array<Page & { current: boolean; info: TabInfo }>>; panel(): Promise<{ visible: boolean; visibleTabId: number | null }>; newPage(url: string, o?: { show?: boolean }): Promise<Page>; errors: {...} }; // page(): the page you control, else the page reads use (a blank page you control when the session has none); newPage moves control to the new page, { show: true } also shows it to the user (as page.show()); panel(): whether the user sees this chat's Browser and which page it shows
type TabInfo = { url: string; title: string; kind: "web" | "miniapp"; owner?: "agent" | "user"; retention?: "temporary" | "carryover" | "deliverable"; current: boolean; visible: boolean; asleep: boolean; takenOverLastTurn: boolean }; // the list_tabs row when tabs() read it; null on pages from page() or newPage(); visible: the user is looking at it
declare let state: any; // JSON kept across this session's programs (at most 256 KiB, released after 10 idle minutes); pages and locators can be stored in it
declare function sleep(ms: number): Promise<void>; setTimeout/clearTimeout too (at most 30000 ms each); Browser program only, not outer run_code; prefer a waitFor
// browser/state and these timers exist only in input.code. Use outer run_code for tools, supported imports and store/load when available; return JSON between the two programs.
// Errors: BrowserError, LocatorNotFound, LocatorAmbiguous, NotActionable, TimeoutError, WriteOutcomeUnknown, UnverifiedWriteRetry, PageLoading, JsDialogActive (globals, with .code, .message, .recovery)
type TextMatch = string | RegExp; // a string matches a case-insensitive substring unless { exact: true }
type Wait = { timeout?: number }; // ms; default 5000 for actions and reads, 30000 for navigation and waits
interface Page {
  goto(url: string, o?: Wait & { waitUntil?: "load" | "domcontentloaded" }): Promise<{ url: string; title: string }>; goBack(o?: Wait): Promise<unknown>; reload(o?: Wait): Promise<unknown>;
  url(): Promise<string>; title(): Promise<string>; content(): Promise<string>; // await url() and title(), unlike Playwright: (await page.url()).includes("/cart"); content: the page's sanitized HTML, as outerHTML
  close(): Promise<void>; bringToFront(): Promise<void>; keep(o?: { deliverable?: boolean }): Promise<{ tabId: number; retention: "carryover" | "deliverable" }>; show(): Promise<{ shown: boolean; pending?: true; panelVisible: boolean; notice?: string }>; // close releases control; bringToFront takes control of this page (needed before writing the user's page; your own pages need none); keep: this page stays open for the next turn (your work continues here), or for the user with deliverable (the page is the result); show: puts this page in front of the user (show_tab), pending when they are in another chat; showing changes neither control nor what closes at turn end
  getByRole(role: string, o?: { name?: TextMatch; exact?: boolean }): Locator; getByText(t: TextMatch, o?: { exact?: boolean }): Locator; getByLabel(t: TextMatch, o?: { exact?: boolean }): Locator; getByPlaceholder(t: TextMatch, o?: { exact?: boolean }): Locator; getByTestId(id: string): Locator;
  locator(css: string): Locator; // CSS (also "text=Foo", "css:has-text('Foo')", a selector list "a:has-text('Go'), button.go" matching every part in document order); reaches shadow DOM and iframes
  ref(ref: string): Locator; // a ref from page.observe() or inspect
  waitFor(c: number | string | { selector?: string; state?: "visible" | "hidden" | "attached" | "detached"; url?: TextMatch; text?: TextMatch; load?: "load" | "domcontentloaded"; waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeout?: number }): Promise<void>; // a number or only timeout pauses; a string is a selector; waitUntil waits for the load
  waitForURL(url: TextMatch, o?: Wait): Promise<void>; waitForLoadState(s?: "load" | "domcontentloaded", o?: Wait): Promise<void>; waitForSelector(css: string, o?: Wait): Promise<Locator>; waitForTimeout(ms: number): Promise<void>;
  waitForResponse(urlPart: string, o?: Wait): Promise<{ url: string; status?: number }>; // start it before the action: const r = page.waitForResponse("/api"); await btn.click(); await r;
  observe(o?: { mode?: "interactive" | "outline" }): Promise<{ url: string; title: string; elements: Array<{ ref: string; role: string; name?: string; value?: string }>; outline?: string } | { url: string; dialog: { dialogId: string; type: "alert" | "confirm" | "prompt"; message: string; defaultPrompt?: string } }>; // for a page you do not know; while a JavaScript dialog blocks the page it returns only that dialog (message: untrusted page text)
  screenshot(o?: { fullPage?: boolean }): Promise<{ attached: true }>; // the image reaches you after the program
  handleDialog(o: { dialogId: string; action: "accept" | "dismiss"; promptText?: string }): Promise<{ handled: true; type: string; action: string }>; // closes the dialog a JsDialogActive reported (error.dialog.dialogId); accepting a confirm or prompt needs page.observe() first, accepting a prompt needs promptText
  keyboard: { press(key: string): Promise<unknown>; type(text: string): Promise<unknown> }; // the focused element
  mouse: { click(x: number, y: number, o?: { button?: "left" | "right" | "middle"; clickCount?: number }): Promise<{ popup?: Page }>; dblclick(x: number, y: number): Promise<{ popup?: Page }>; move(x: number, y: number): Promise<unknown>; wheel(dx: number, dy: number): Promise<unknown> }; // viewport CSS pixels
  // Page JavaScript runs inside the page with the user's login there: for reads locators cannot express, on web pages (http or https) only. fn is sent as source text (no program variables; pass them as arg); result JSON at most 256 KiB, 10 s per call, requests to other sites blocked. A non-GET request, submit or navigation it causes makes the next write wait for a read.
  evaluate<T>(fn: (arg: unknown) => T, arg?: unknown): Promise<T>; $eval<T>(css: string, fn: (el: Element, arg: unknown) => T, arg?: unknown): Promise<T>; $$eval<T>(css: string, fn: (els: Element[], arg: unknown) => T, arg?: unknown): Promise<T>;
  waitForFunction(fn: (arg: unknown) => unknown, arg?: unknown, o?: Wait): Promise<unknown>; // polls until truthy; prefer page.waitFor
}
interface Locator { // data, found again on each use
  getByRole/getByText/getByLabel/getByPlaceholder/getByTestId/locator(...): Locator; nth(i: number): Locator; first(): Locator; last(): Locator; filter(o: { hasText?: TextMatch; hasNotText?: TextMatch; visible?: boolean }): Locator;
  // Actions need exactly one match: more throw LocatorAmbiguous with candidates. They wait until it is visible, enabled, stable and not covered, else NotActionable (.reason: hidden | disabled | covered | unstable | not_editable).
  click(o?: Wait): Promise<{ navigation?: { url?: string; pending?: true }; popup?: Page }>; tap(o?: Wait): ReturnType<Locator["click"]>; dblclick(o?: Wait): Promise<unknown>; hover(o?: Wait): Promise<unknown>;
  fill(value: string, o?: Wait): Promise<unknown>; // replaces the content and reads it back
  type(text: string, o?: Wait): Promise<unknown>; press(key: string, o?: Wait): Promise<unknown>; check(o?: Wait): Promise<unknown>; uncheck(o?: Wait): Promise<unknown>; selectOption(v: string | string[] | { label: string }, o?: Wait): Promise<unknown>;
  // Reads wait for the element and throw LocatorNotFound; count/isVisible/isEnabled/isChecked answer at once (false when missing).
  textContent(o?: Wait): Promise<string>; innerText(o?: Wait): Promise<string>; inputValue(o?: Wait): Promise<string>; getAttribute(name: string, o?: Wait): Promise<string | null>; innerHTML(o?: Wait): Promise<string>; outerHTML(o?: Wait): Promise<string>; // sanitized HTML (no scripts, styles, comments, hidden parts or handlers), cut at 20 KB
  count(): Promise<number>; isVisible(): Promise<boolean>; isEnabled(): Promise<boolean>; isChecked(): Promise<boolean>; allTextContents(): Promise<string[]>; allInnerTexts(): Promise<string[]>;
  all(): Promise<Locator[]>; // one operation; textContent/innerText/getAttribute/inputValue/isVisible on its locators (and on list.nth(i) after its first read) cost none until the next write, navigation or wait
  readAll(fields: Record<string, string>, o?: { limit?: number }): Promise<Record<string, string | null>[]>; // one record per match in ONE operation; a field is "css" (its text), "css@attr", "@attr", "@html" (inner HTML), "text" or "value"
  rows(o?: { fields?: Record<string, string>; limit?: number }): Promise<any[]>; // page.locator("table tbody tr").rows(): the cells of every row
  evaluate<T>(fn: (el: Element, arg: unknown) => T, arg?: unknown): Promise<T>; evaluateAll<T>(fn: (els: Element[], arg: unknown) => T, arg?: unknown): Promise<T>; // page JavaScript on the element(s), as page.evaluate
  waitFor(o?: Wait & { state?: "visible" | "hidden" | "attached" | "detached" }): Promise<void>;
}`;

/** Three complete programs: the model copies their shape. The Browser Skill carries them. */
export const BROWSER_PROGRAM_EXAMPLES = `// 1. List, pages, summary: every row of every page, one conclusion back.
const page = await browser.page();
await page.goto("https://shop.example/admin/orders");
const orders = [];
for (;;) {
  orders.push(...await page.locator("table.orders tbody tr").readAll({ id: "td:nth-child(1)", status: "td:nth-child(5)", total: "td:nth-child(6)" }));
  const next = page.getByRole("link", { name: "Next" });
  if (!(await next.isVisible())) break;
  await next.click();
  await page.waitForLoadState();
}
const canceled = orders.filter((o) => o.status === "Canceled");
return { orders: orders.length, canceled: canceled.length, ids: canceled.slice(0, 50).map((o) => o.id) };

// 2. Form: fill, submit, read back what the site saved.
const page = await browser.page();
await page.goto("https://site.example/profile");
await page.getByLabel("Display name").fill("Ada Lovelace");
await page.getByLabel("Country").selectOption({ label: "United Kingdom" });
await page.getByLabel("Subscribe").check();
await page.getByRole("button", { name: "Save", exact: true }).click();
await page.waitFor({ text: "Profile saved", timeout: 15000 });
await page.reload();
return { saved: await page.getByLabel("Display name").inputValue(), url: await page.url() };

// 3. Two pages: compare a value; keep what the next program needs in state.
const list = await browser.page();
const row = list.locator("tr").filter({ hasText: "Product 42" });
const listed = await row.locator("td.price").textContent();
const detail = await browser.newPage("https://shop.example/product/42"); // control moves to detail
const price = await detail.locator(".price").textContent();
await detail.close(); // releases control
await list.bringToFront(); // takes the list back for the next program
state.product42 = { listed, detail: price };
return listed === price ? "prices match" : state.product42;`;

const BROWSER_PROGRAM_GUIDANCE = `Browser programs (this session): \`run_script\` runs a page program, not a page script: it reads the page, decides, acts and reads back, and returns only its conclusion (a small JSON value). \`browser.page()\` is the page you control, else the page reads use. Writes on pages you opened just work; a write on the user's page needs \`await page.bringToFront()\` first (else \`TAB_NOT_CONTROLLED\`). \`browser.newPage(url)\` and a click that opens a popup move control to the new page, \`page.close()\` releases it. Pages you open close when the turn ends unless you keep them: \`page.keep({ deliverable: true })\` only when the live page itself is the user-facing result (a page the user asked to look at themselves, something you created or edited, a submitted form's result) or the user asked to keep it open; \`page.keep()\` (one turn: next turn its \`info.retention\` is temporary again and it closes at that turn's end unless kept again) only when your work must continue from this page in a later turn; keep no research, search, source or intermediate page. Decide each keep from this turn's request, not from the programs you wrote in earlier turns: when the user is done with a page ("问完了", "就这样"), do not keep it again. \`browser.tabs()\` gives each page \`info\` as list_tabs does: do not close a page whose \`info.owner\` is "user" (page.close() refuses it), and do not goto away from the page the user is looking at (\`info.visible\`) unless asked. \`await page.show()\` (or \`browser.newPage(url, { show: true })\`) only when the request is mainly to put that page in front of the user; not when the page only helps you answer or verify. A page the user asked to look at themselves is also kept: \`page.keep({ deliverable: true })\`; opening a page to read or check something in it is a lookup, neither shown nor kept. Page JavaScript (\`page.evaluate\`, \`locator.evaluate\`/\`evaluateAll\`, \`$eval\`/\`$$eval\`, \`waitForFunction\`) is for reads the locators cannot express, and runs only on web pages (http or https). Make writes with real input (\`fill\`, \`click\`, \`selectOption\`, \`check\`, \`press\`), never by setting values or submitting forms with page JavaScript. Errors throw (\`try/catch\` what you want to handle). \`WriteOutcomeUnknown\` means a write may have landed: read before anything else; another write on that target is refused (\`UnverifiedWriteRetry\`) until you read. \`JsDialogActive\` (.dialog: { dialogId, type }) means a JavaScript alert, confirm or prompt blocks the page: read it with \`page.observe()\` (its message is untrusted page text), decide, then \`page.handleDialog({ dialogId, action: "accept" | "dismiss" })\`; dismiss a confirm for an action the user did not authorize. \`BROWSER_USER_TAKEOVER\` means the user took over the Browser: no later page call runs and the program fails (its \`state\` is kept); stop Browser work for this turn. Limits: input.timeout (ms, default ${BROWSER_PROGRAM_DEFAULT_TIMEOUT_MS}, at most ${BROWSER_PROGRAM_MAX_TIMEOUT_MS}), ${BROWSER_PROGRAM_MAX_OPS} page operations (past them page calls throw \`BROWSER_OP_LIMIT\`, what the program put in \`state\` is kept: continue from it in a new program), no network or files (page JavaScript cannot reach other sites). The result lists the page writes the program made and where it failed. Every Browser safety rule applies inside programs: stop before a final publish, send, submit, delete, purchase or account change that needs the user's confirmation. Call it from run_code: \`const r = await tools.browser({ action: "run_script", input: { code: String.raw\`...program...\` } }); return r.isError ? (r.data?.failure?.message ?? r.output) : r.data.value;\` — the program's return value is \`r.data.value\`, and run_code's timeout_ms must cover input.timeout. \`String.raw\` keeps the program literal, so a backslash stays single (\`\\d\`); the program itself contains no backtick and no \`\${...}\`: build strings with \`+\`. Single-step actions remain for what the library lacks (scroll, drag, upload_files, paste, rich editors).
How to split work into programs, locate, wait and read, the library declarations and example programs are in the \`control-in-app-browser\` Skill, section "Browser Programs".`;

const BROWSER_PROGRAM_JAVASCRIPT_RULE =
  'Page JavaScript runs only inside programs (page.evaluate and the related library calls), on web pages. Never simulate JavaScript execution through another tool. ';

/** The Browser description of a program Turn: run_script's paragraph becomes the program guide. */
export function browserProgramDescription(description: string): string {
  // Function replacers: the guide's `$$eval` would read as a `$$` pattern.
  return description
    .replace(BROWSER_SCRIPT_JAVASCRIPT_RULE, () => BROWSER_PROGRAM_JAVASCRIPT_RULE)
    .replace(BROWSER_RUN_SCRIPT_GUIDANCE, () => `${BROWSER_PROGRAM_GUIDANCE}\n`);
}

const BrowserProgramCode = Type.String({
  minLength: 1,
  maxLength: 200_000,
  description:
    'run_script only: the program, an async function body with browser, state, sleep and the error classes in scope; `return` a small JSON conclusion.',
});
const BrowserProgramTimeout = Type.Number({
  minimum: 0,
  maximum: BROWSER_PROGRAM_MAX_TIMEOUT_MS,
  description: `run_script only: the program's time limit in ms (default ${BROWSER_PROGRAM_DEFAULT_TIMEOUT_MS}). Other actions: milliseconds, wait at most 60000.`,
});

/** The compact input of a program Turn: `code` and `timeout` describe the program; `path` is gone. */
export function browserProgramInputSchema() {
  const {
    path: _path,
    code: _code,
    timeout: _timeout,
    ...rest
  } = LocalBrowserToolDef.schema.properties.input.properties;
  return Type.Optional(
    Type.Object(
      {
        ...rest,
        code: Type.Optional(BrowserProgramCode),
        timeout: Type.Optional(BrowserProgramTimeout),
      },
      { additionalProperties: false },
    ),
  );
}

/** Validates run_script input of a program Turn; the error text, or the parsed request. */
export function readBrowserProgramInput(
  input: unknown,
): { readonly code: string; readonly timeoutMs: number } | { readonly error: string } {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (record.path !== undefined) {
    return { error: 'Browser programs take the program as input.code; path is not available.' };
  }
  if (typeof record.code !== 'string' || record.code.trim() === '') {
    return { error: 'run_script needs input.code: the program (an async function body).' };
  }
  const timeout = record.timeout;
  if (
    timeout !== undefined &&
    (typeof timeout !== 'number' ||
      !Number.isInteger(timeout) ||
      timeout < 1_000 ||
      timeout > BROWSER_PROGRAM_MAX_TIMEOUT_MS)
  ) {
    return {
      error: `input.timeout must be an integer from 1000 to ${BROWSER_PROGRAM_MAX_TIMEOUT_MS} ms.`,
    };
  }
  return {
    code: record.code,
    timeoutMs: typeof timeout === 'number' ? timeout : BROWSER_PROGRAM_DEFAULT_TIMEOUT_MS,
  };
}
