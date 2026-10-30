import { Type, type Static, type TSchema } from '@sinclair/typebox';

import type { ToolDefinition } from '@mavis/agent-core/tools';

const BrowserTargetProps = {} as const;

const BrowserElementFocusProps = {
  ref: Type.Optional(
    Type.String({ description: 'Opaque element reference from the latest browser inspect/query.' }),
  ),
  selector: Type.Optional(
    Type.String({
      description:
        'Standard CSS selector for the target element. Playwright selectors such as :has-text() and text=, and XPath expressions, are unsupported. For visible-text reading use query kind="text"; for an exact item-to-actionable-ref lookup in a long or ambiguous rendered list use query kind="semantic". For actions prefer an opaque ref returned by inspect/query.',
    }),
  ),
  index: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: 'Element index from browser_inspect / browser output.',
    }),
  ),
  frame: Type.Optional(
    Type.String({
      description: 'Opaque frame reference returned with the same inspected element.',
    }),
  ),
} as const;

const CompactBrowserElementFocusProps = {
  ref: BrowserElementFocusProps.ref,
  selector: BrowserElementFocusProps.selector,
  frame: BrowserElementFocusProps.frame,
} as const;

const BrowserFocusProps = {
  ...BrowserElementFocusProps,
  normalized_position: Type.Optional(
    Type.Object({
      x: Type.Number({
        minimum: 0,
        maximum: 1,
        description: 'Normalized x position, from 0 to 1.',
      }),
      y: Type.Number({
        minimum: 0,
        maximum: 1,
        description: 'Normalized y position, from 0 to 1.',
      }),
    }),
  ),
} as const;

const BrowserPositionProps = {
  position: Type.Optional(
    Type.Object({
      x: Type.Number({
        minimum: 0,
        description:
          'Absolute CSS-pixel x coordinate in the current main-frame viewport; must be less than its width.',
      }),
      y: Type.Number({
        minimum: 0,
        description:
          'Absolute CSS-pixel y coordinate in the current main-frame viewport; must be less than its height.',
      }),
    }),
  ),
} as const;

const CompactBrowserFocusProps = {
  ...CompactBrowserElementFocusProps,
  normalized_position: BrowserFocusProps.normalized_position,
} as const;

const BrowserPointerFocusProps = {
  ...BrowserFocusProps,
  ...BrowserPositionProps,
} as const;

const CompactBrowserPointerFocusProps = {
  ...CompactBrowserFocusProps,
  ...BrowserPositionProps,
} as const;

const BrowserEmptyInput = Type.Object({}, { additionalProperties: false });
const BrowserFocusInput = Type.Object(CompactBrowserPointerFocusProps, {
  additionalProperties: false,
});
// Hover shares click's `delay` as a pointer hold: the flat provider schema
// advertises delay action-wide, and eval 766011 rejected hover { delay } that
// only asked for "keep hovering while the tooltip fades in".
const BrowserHoverInput = Type.Object(
  {
    ...CompactBrowserPointerFocusProps,
    delay: Type.Optional(Type.Number({ minimum: 0, maximum: 5_000 })),
  },
  { additionalProperties: false },
);
const BrowserClickInput = Type.Object(
  {
    ...CompactBrowserPointerFocusProps,
    button: Type.Optional(
      Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Literal('middle')]),
    ),
    delay: Type.Optional(Type.Number({ minimum: 0, maximum: 5_000 })),
  },
  { additionalProperties: false },
);
const BrowserClickAndWaitForNavigationInput = Type.Object(
  {
    ...CompactBrowserPointerFocusProps,
    button: Type.Optional(
      Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Literal('middle')]),
    ),
    delay: Type.Optional(Type.Number({ minimum: 0, maximum: 5_000 })),
    timeout: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 60_000,
        description: 'Maximum time to wait for the resulting main-document navigation.',
      }),
    ),
  },
  { additionalProperties: false },
);
// Every element-targeting action accepts the same locator family (ref, selector,
// position, normalized_position). Narrower per-action subsets were a pure
// contract trap: models generalize locators across sibling actions, and eval
// 761096 lost 13 calls to "unsupported field(s): position" on fill/type/check/
// select_option. Coordinates resolve to the control under that point.
const BrowserFillInput = Type.Object(
  {
    ...CompactBrowserPointerFocusProps,
    text: Type.String({ description: 'Text to enter after clearing the target.' }),
    delay: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000 })),
  },
  { additionalProperties: false },
);
const BrowserTypeInput = Type.Object(
  {
    ...CompactBrowserPointerFocusProps,
    text: Type.String({ description: 'Text to enter.' }),
    clear: Type.Optional(Type.Boolean({ description: 'Clear the target before entering text.' })),
    delay: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000 })),
  },
  { additionalProperties: false },
);
const BrowserPasteInput = Type.Object(
  {
    ref: Type.String({
      minLength: 1,
      description: 'Opaque editable-element reference from the latest browser inspect/query.',
    }),
    frame: BrowserElementFocusProps.frame,
    text: Type.String({
      minLength: 1,
      description: 'Explicit non-empty plain text to paste into the selected target.',
    }),
    clear: Type.Optional(Type.Boolean({ description: 'Clear the target before pasting.' })),
  },
  { additionalProperties: false },
);
const BrowserWaitInput = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('timeout'),
      timeout: Type.Number({ minimum: 0, maximum: 60_000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('selector'),
      selector: Type.String(),
      state: Type.Optional(
        Type.Union([
          Type.Literal('attached'),
          Type.Literal('detached'),
          Type.Literal('visible'),
          Type.Literal('hidden'),
        ]),
      ),
      timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 60_000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('text'),
      text: Type.String(),
      timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 60_000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('url'),
      url: Type.String(),
      timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 60_000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('load'),
      timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 60_000 })),
    },
    { additionalProperties: false },
  ),
]);

const BrowserScreenshotInput = Type.Union([
  Type.Object(
    {
      scope: Type.Optional(Type.Union([Type.Literal('viewport'), Type.Literal('fullPage')])),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      scope: Type.Literal('clip'),
      clip: Type.Object(
        {
          x: Type.Number(),
          y: Type.Number(),
          width: Type.Number({ minimum: 1 }),
          height: Type.Number({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);

const BrowserInspectInput = Type.Object(
  {
    includeDom: Type.Optional(Type.Boolean()),
    snapshotId: Type.Optional(
      Type.String({
        minLength: 1,
        description: 'Continue paging the latest inspect snapshot returned by the browser.',
      }),
    ),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          'Zero-based element offset within snapshotId. Pass the snapshotId returned by the previous inspect together with its nextOffset.',
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 200,
        description: 'Maximum elements to return in this page. Defaults to 100.',
      }),
    ),
  },
  { additionalProperties: false },
);
const BrowserConsoleLevel = Type.Union([
  Type.Literal('debug'),
  Type.Literal('info'),
  Type.Literal('log'),
  Type.Literal('warn'),
  Type.Literal('warning'),
  Type.Literal('error'),
]);
const BrowserNetworkStatus = Type.Union([
  Type.Literal('pending'),
  Type.Literal('success'),
  Type.Literal('failed'),
  Type.Literal('2xx'),
  Type.Literal('3xx'),
  Type.Literal('4xx'),
  Type.Literal('5xx'),
]);
const BrowserNetworkResourceType = Type.Union([
  Type.Literal('document'),
  Type.Literal('stylesheet'),
  Type.Literal('image'),
  Type.Literal('media'),
  Type.Literal('font'),
  Type.Literal('script'),
  Type.Literal('xhr'),
  Type.Literal('fetch'),
  Type.Literal('eventsource'),
  Type.Literal('manifest'),
  Type.Literal('preflight'),
  Type.Literal('other'),
]);

// MiniMax constrained decoding treats nested string-literal unions as ordered
// alternatives and can repeatedly emit the first item even when its reasoning
// selected another value. Keep the exact action contracts below, but expose
// compact provider enums in the same flat shape already used by `action`.
const BrowserProviderQueryOrWaitKind = Type.String({
  enum: [
    'text',
    'semantic',
    'dom',
    'editable',
    'console',
    'network',
    'snapshot',
    'timeout',
    'selector',
    'url',
    'load',
  ],
  pattern: '^(?:text|semantic|dom|editable|console|network|snapshot|timeout|selector|url|load)$',
  description:
    'Required by query and wait. For normal query page reading choose text; use semantic with exact visible identity text to look up the associated actionable opaque ref in a long or ambiguous rendered list, and use dom/editable/console/network only for their specific purposes. Never choose snapshot to search or recover a list: it remains a legacy compatibility mode, and new inspect pagination must use action="inspect" with snapshotId/offset. Wait uses timeout/selector/text/url/load.',
});
const BrowserProviderConsoleLevel = Type.String({
  enum: ['debug', 'info', 'log', 'warn', 'warning', 'error'],
  pattern: '^(?:debug|info|log|warn|warning|error)$',
});
const BrowserProviderNetworkStatus = Type.String({
  enum: ['pending', 'success', 'failed', '2xx', '3xx', '4xx', '5xx'],
  pattern: '^(?:pending|success|failed|2xx|3xx|4xx|5xx)$',
});
const BrowserProviderNetworkResourceType = Type.String({
  enum: [
    'document',
    'stylesheet',
    'image',
    'media',
    'font',
    'script',
    'xhr',
    'fetch',
    'eventsource',
    'manifest',
    'preflight',
    'other',
  ],
  pattern:
    '^(?:document|stylesheet|image|media|font|script|xhr|fetch|eventsource|manifest|preflight|other)$',
});
const BrowserProviderPointerButton = Type.String({
  enum: ['left', 'right', 'middle'],
  pattern: '^(?:left|right|middle)$',
});
const BrowserProviderModifier = Type.String({
  enum: ['Control', 'Shift', 'Alt', 'Meta'],
  pattern: '^(?:Control|Shift|Alt|Meta)$',
});
const BrowserProviderScrollDirection = Type.String({
  enum: ['up', 'down', 'left', 'right'],
  pattern: '^(?:up|down|left|right)$',
});
const BrowserProviderWaitState = Type.String({
  enum: ['attached', 'detached', 'visible', 'hidden'],
  pattern: '^(?:attached|detached|visible|hidden)$',
});
const BrowserProviderScreenshotScope = Type.String({
  enum: ['viewport', 'fullPage', 'clip'],
  pattern: '^(?:viewport|fullPage|clip)$',
});

const BrowserQueryInput = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('text'),
      selector: Type.Optional(Type.String()),
      maxChars: Type.Optional(Type.Number({ minimum: 1, maximum: 50_000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('semantic'),
      text: Type.String({
        minLength: 1,
        maxLength: 500,
        description:
          'Exact visible identifier or label fragment to match case-insensitively in the shared DOM/AX semantic tree. Returns the matching item context and actionable opaque refs without opening candidates.',
      }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 50,
          description: 'Maximum matching semantic item contexts to return.',
        }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('dom'),
      selector: Type.Optional(Type.String()),
      maxChars: Type.Optional(Type.Number({ minimum: 1, maximum: 50_000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('snapshot', {
        description:
          'Legacy compatibility only. Start and page new actionable snapshots with inspect; preserve the returned snapshotId and offset instead of restarting or filtering this query.',
      }),
      snapshotId: Type.Optional(
        Type.String({
          minLength: 1,
          description: 'Snapshot to page when kind="snapshot".',
        }),
      ),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('editable'),
      snapshotId: Type.Optional(
        Type.String({
          minLength: 1,
          description: 'Continue paging the same editable-target snapshot.',
        }),
      ),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('console'),
      levels: Type.Optional(
        Type.Array(BrowserConsoleLevel, {
          minItems: 1,
          maxItems: 6,
          uniqueItems: true,
          description: 'Console levels to include. "warning" is accepted as an alias for "warn".',
        }),
      ),
      filter: Type.Optional(
        Type.String({
          maxLength: 1_000,
          description: 'Case-sensitive substring filter applied to the rendered log message.',
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          description: 'Maximum newest console and uncaught-exception entries to return.',
        }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('network'),
      status: Type.Optional(
        Type.Array(BrowserNetworkStatus, {
          minItems: 1,
          maxItems: 7,
          uniqueItems: true,
          description: 'Request outcomes or HTTP status classes to include.',
        }),
      ),
      resourceTypes: Type.Optional(
        Type.Array(BrowserNetworkResourceType, {
          minItems: 1,
          maxItems: 12,
          uniqueItems: true,
          description: 'Browser resource categories to include.',
        }),
      ),
      filter: Type.Optional(
        Type.String({
          maxLength: 1_000,
          description: 'Case-sensitive substring filter applied to the sanitized request URL.',
        }),
      ),
      afterSequence: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            'Return only requests observed after this sequence. Obtain the checkpoint from lastSequence in an earlier Network query.',
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          description: 'Maximum newest Network entries to return.',
        }),
      ),
    },
    { additionalProperties: false },
  ),
]);
const BrowserNavigateInput = Type.Object(
  {
    url: Type.String({
      description:
        'Destination URL accepted by the active Browser provider; follow its URL policy in the Browser tool description.',
    }),
    replaceCurrentTab: Type.Optional(
      Type.Boolean({
        description:
          'Set true only when the user explicitly asked to replace or reuse the currently loaded Browser tab. Omit it for blank tabs and use open_tab to preserve a loaded page.',
      }),
    ),
  },
  { additionalProperties: false },
);
const BrowserOpenTabInput = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      description:
        'Destination URL accepted by the active Browser provider, opened in a newly created Browser tab.',
    }),
  },
  { additionalProperties: false },
);
const BrowserDragInput = Type.Object(
  { source: BrowserFocusInput, target: BrowserFocusInput },
  { additionalProperties: false },
);
const BrowserPressKeyInput = Type.Object(
  {
    // Optional element target: Core focuses it before dispatching the key.
    ...CompactBrowserElementFocusProps,
    key: Type.String(),
    modifiers: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal('Control'),
          Type.Literal('Shift'),
          Type.Literal('Alt'),
          Type.Literal('Meta'),
        ]),
        { maxItems: 4, uniqueItems: true },
      ),
    ),
  },
  { additionalProperties: false },
);
const BrowserSelectOptionInput = Type.Object(
  {
    ...CompactBrowserPointerFocusProps,
    values: Type.Array(
      Type.String({
        description:
          'Option value, or the exact visible option label when no option has that value.',
      }),
      { minItems: 1, maxItems: 20 },
    ),
  },
  { additionalProperties: false },
);
const BrowserScrollInput = Type.Object(
  {
    // Core dispatches the wheel at position, so the owning nested container scrolls.
    ...CompactBrowserPointerFocusProps,
    direction: Type.Optional(
      Type.Union([
        Type.Literal('up'),
        Type.Literal('down'),
        Type.Literal('left'),
        Type.Literal('right'),
      ]),
    ),
    distance: Type.Optional(Type.Number({ minimum: 1, maximum: 100_000 })),
  },
  { additionalProperties: false },
);
const BrowserUploadFilesInput = Type.Object(
  {
    ...CompactBrowserElementFocusProps,
    paths: Type.Array(
      Type.String({
        minLength: 1,
        description:
          'Exact current-turn attachment path or active-workspace file path. local-runtime validates every path before Electron receives it.',
      }),
      { minItems: 1, maxItems: 20 },
    ),
    timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 120_000 })),
  },
  { additionalProperties: false },
);
const BrowserRunScriptInput = Type.Object(
  {
    code: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200_000,
        description:
          'Async function body run against the current Browser tab. In scope: page (keyboard.down/up/press/type, mouse.move/down/up/click/wheel, waitForTimeout, waitForFunction, evaluate, screenshot, consoleMessages, url, title, viewportSize), assert (ok/equal/deepEqual/notEqual/fail) and console. `return` a JSON value. Provide exactly one of code or path.',
      }),
    ),
    path: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          'Active-workspace .js file containing the same function body, so the script can be kept and re-run. Provide exactly one of code or path.',
      }),
    ),
    timeout: Type.Optional(
      Type.Integer({
        minimum: 1_000,
        maximum: 120_000,
        description: 'Script deadline in milliseconds. Defaults to 30000.',
      }),
    ),
  },
  { additionalProperties: false },
);

// Keep the provider-facing input as one concrete object. Exact action/input pairing
// remains a runtime concern below; exposing every contract as an object union makes
// empty alternatives indistinguishable to providers and models.
const BrowserProviderInput = Type.Object(
  {
    ...CompactBrowserPointerFocusProps,
    selector: Type.Optional(
      Type.String({
        description:
          'Standard CSS selector only. Playwright selectors such as :has-text() and text=, and XPath expressions, are unsupported. For query it is accepted only with kind="text"/"dom"; use kind="text" for visible-text lookup and kind="semantic" with input.text for exact item-to-ref lookup. For wait it is accepted only with kind="selector". For actions prefer an opaque ref returned by inspect/query.',
      }),
    ),
    includeDom: Type.Optional(Type.Boolean()),
    kind: Type.Optional(BrowserProviderQueryOrWaitKind),
    maxChars: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 50_000,
        description: 'Maximum query characters; valid only for query kind="text"/"dom".',
      }),
    ),
    levels: Type.Optional(
      Type.Array(BrowserProviderConsoleLevel, {
        minItems: 1,
        maxItems: 6,
        uniqueItems: true,
        description: 'Console levels accepted only by query kind="console".',
      }),
    ),
    filter: Type.Optional(
      Type.String({
        maxLength: 1_000,
        description:
          'Console message or sanitized request URL substring accepted only by query kind="console"/"network".',
      }),
    ),
    status: Type.Optional(
      Type.Array(BrowserProviderNetworkStatus, {
        minItems: 1,
        maxItems: 7,
        uniqueItems: true,
        description: 'Request status filters accepted only by query kind="network".',
      }),
    ),
    resourceTypes: Type.Optional(
      Type.Array(BrowserProviderNetworkResourceType, {
        minItems: 1,
        maxItems: 12,
        uniqueItems: true,
        description: 'Resource type filters accepted only by query kind="network".',
      }),
    ),
    afterSequence: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          'Network sequence checkpoint accepted only by query kind="network"; return entries with a larger sequence.',
      }),
    ),
    snapshotId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          'Snapshot ID returned by inspect/query. Preserve it when continuing truncated inspect or editable-query results.',
      }),
    ),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 200,
        description:
          'Maximum entries for query kind="console"/"network"/"semantic", or elements for inspect/snapshot/editable pagination.',
      }),
    ),
    url: Type.Optional(
      Type.String({
        description:
          'Navigation URL or URL wait condition; follow the active Browser provider URL policy for navigation.',
      }),
    ),
    replaceCurrentTab: Type.Optional(
      Type.Boolean({
        description:
          'Valid only for navigate. Set true only when the user explicitly asked to replace or reuse the currently loaded Browser tab; otherwise use open_tab.',
      }),
    ),
    source: Type.Optional(
      Type.Object(CompactBrowserPointerFocusProps, {
        additionalProperties: false,
        description: 'Drag start point; valid only for action="drag".',
      }),
    ),
    target: Type.Optional(
      Type.Object(CompactBrowserPointerFocusProps, {
        additionalProperties: false,
        description:
          'Drag drop point; valid only for action="drag". Every other action, including scroll, takes ref/selector/frame/position/normalized_position directly inside input, never wrapped in target.',
      }),
    ),
    paths: Type.Optional(
      Type.Array(
        Type.String({
          minLength: 1,
          description:
            'Current-turn attachment paths or active-workspace file paths accepted only by upload_files.',
        }),
        { minItems: 1, maxItems: 20 },
      ),
    ),
    button: Type.Optional(BrowserProviderPointerButton),
    text: Type.Optional(
      Type.String({
        description:
          'Text to enter, wait for, or explicitly paste, or exact visible identity text for query kind="semantic".',
      }),
    ),
    clear: Type.Optional(
      Type.Boolean({
        description:
          'Clear the target before typing or pasting. Valid only for action="type" or action="paste"; fill always clears (clear:true is accepted as a no-op; use type to append instead of clear:false).',
      }),
    ),
    delay: Type.Optional(Type.Number({ minimum: 0, maximum: 5_000 })),
    key: Type.Optional(Type.String({ description: 'Keyboard key to press.' })),
    modifiers: Type.Optional(
      Type.Array(BrowserProviderModifier, { maxItems: 4, uniqueItems: true }),
    ),
    values: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 20 })),
    direction: Type.Optional(BrowserProviderScrollDirection),
    distance: Type.Optional(Type.Number({ minimum: 1, maximum: 100_000 })),
    state: Type.Optional(BrowserProviderWaitState),
    timeout: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 120_000,
        description:
          'Milliseconds. wait accepts at most 60000; run_script accepts 1000-120000 (default 30000).',
      }),
    ),
    code: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200_000,
        description:
          'run_script only: async function body with page, assert and console in scope. Exactly one of code or path.',
      }),
    ),
    path: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          'run_script only: active-workspace .js file with the same function body. Exactly one of code or path.',
      }),
    ),
    scope: Type.Optional(BrowserProviderScreenshotScope),
    clip: Type.Optional(
      Type.Object(
        {
          x: Type.Number(),
          y: Type.Number(),
          width: Type.Number({ minimum: 1 }),
          height: Type.Number({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  {
    additionalProperties: false,
    description:
      'Known Browser action fields. The runtime validates the exact fields required by the selected action.',
  },
);

export const LOCAL_BROWSER_ACTION_INPUT_CONTRACTS = {
  inspect: { schema: BrowserInspectInput, optional: true },
  query: { schema: BrowserQueryInput, optional: false },
  navigate: { schema: BrowserNavigateInput, optional: false },
  open_tab: { schema: BrowserOpenTabInput, optional: false },
  return_to_previous_tab: { schema: BrowserEmptyInput, optional: true },
  back: { schema: BrowserEmptyInput, optional: true },
  forward: { schema: BrowserEmptyInput, optional: true },
  reload: { schema: BrowserEmptyInput, optional: true },
  click: { schema: BrowserClickInput, optional: false },
  click_and_wait_for_navigation: {
    schema: BrowserClickAndWaitForNavigationInput,
    optional: false,
  },
  double_click: { schema: BrowserClickInput, optional: false },
  triple_click: { schema: BrowserClickInput, optional: false },
  drag: { schema: BrowserDragInput, optional: false },
  hover: { schema: BrowserHoverInput, optional: false },
  fill: { schema: BrowserFillInput, optional: false },
  type: { schema: BrowserTypeInput, optional: false },
  paste: { schema: BrowserPasteInput, optional: false },
  press_key: { schema: BrowserPressKeyInput, optional: false },
  check: { schema: BrowserFocusInput, optional: false },
  uncheck: { schema: BrowserFocusInput, optional: false },
  select_option: { schema: BrowserSelectOptionInput, optional: false },
  scroll: { schema: BrowserScrollInput, optional: false },
  wait: { schema: BrowserWaitInput, optional: false },
  screenshot: { schema: BrowserScreenshotInput, optional: true },
  upload_files: { schema: BrowserUploadFilesInput, optional: false },
  run_script: { schema: BrowserRunScriptInput, optional: false },
} as const satisfies Record<string, { schema: TSchema; optional: boolean }>;

export const LOCAL_BROWSER_ACTION_NAMES = [
  'inspect',
  'query',
  'navigate',
  'open_tab',
  'return_to_previous_tab',
  'back',
  'forward',
  'reload',
  'click',
  'click_and_wait_for_navigation',
  'double_click',
  'triple_click',
  'drag',
  'hover',
  'fill',
  'type',
  'paste',
  'press_key',
  'check',
  'uncheck',
  'select_option',
  'scroll',
  'wait',
  'screenshot',
  'upload_files',
  'run_script',
] as const;

const BrowserActionName = Type.String({
  enum: [...LOCAL_BROWSER_ACTION_NAMES],
  pattern: `^(?:${LOCAL_BROWSER_ACTION_NAMES.join('|')})$`,
});

const BROWSER_POST_ACTION_VISUAL_GUIDANCE =
  'Selected navigation and interaction results may include `visualObservation.available: true` plus one compressed image, with at most four automatic images per turn. Inspect that image before another read, and do not call `screenshot` solely to repeat visual evidence that already answers the next question. The image is supplemental evidence only: it does not change the action success, authorize a sensitive action, or make an unverified click runtime-verified. Native input and textarea writes normally skip automatic visuals because their structured effect verification is cheaper. ';

/** Actions whose page effect `observe` reads back in the same call. */
export const BROWSER_OBSERVABLE_ACTIONS = [
  'navigate',
  'back',
  'forward',
  'reload',
  'click',
  'click_and_wait_for_navigation',
  'double_click',
  'fill',
  'type',
  'paste',
  'press_key',
  'check',
  'uncheck',
  'select_option',
  'scroll',
] as const;

/**
 * The read folded into a page-changing action. Declared only by the Browser
 * definition a PTC Turn lists inside run_code (`withLocalBrowserObserve`), so
 * a program can act and verify in one call instead of returning to the model
 * for a separate inspect. `LocalBrowserToolDef` does not declare it: a Turn
 * that lists Browser as a top-level tool keeps its definition unchanged, and
 * its `additionalProperties: false` still rejects `observe`.
 */
export const LocalBrowserObserveInput = Type.Object(
  {
    kind: Type.Union([Type.Literal('inspect'), Type.Literal('text')], {
      description:
        'inspect returns the actionable elements with fresh refs (same shape as action="inspect"); text returns visible text (same as query kind="text").',
    }),
    selector: Type.Optional(
      Type.String({
        maxLength: 500,
        description:
          'For kind="text": CSS selector to read instead of the whole page, e.g. "[role=dialog]".',
      }),
    ),
    waitForText: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 500,
        description:
          'Wait until this text is visible before reading, e.g. a search suggestion or a confirmation toast. A timeout is reported in observation.waitTimedOut and the page is read anyway.',
      }),
    ),
    timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 15_000 })),
    maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 20_000 })),
  },
  {
    additionalProperties: false,
    description:
      'Read the page after a successful action in the same call and return it as observation. Skipped when the action fails or needs user takeover. It never makes an unverified click verified: judge the effect from the observation yourself.',
  },
);

export const LocalBrowserToolDef = {
  name: 'browser',
  executionMode: 'sequential',
  description: [
    'HARD PREREQUISITE: SESSION-SCOPED. Before the first Browser action in a session, load `control-in-app-browser` with the `skill` tool as the only tool call in that assistant step and wait for its complete result. If a system reminder explicitly says that the complete Browser Skill was already loaded for this session, the prerequisite remains satisfied and you must not reload it solely to use Browser. Context compaction invalidates that receipt; if Browser returns `SKILL_REQUIRED`, reload the complete Skill once before retrying. Never probe Browser before either condition is satisfied. The Browser rejects an unprepared call with `SKILL_REQUIRED`. Operate the Browser provider attached to the current chat session. Electron presents it in the right-side FilePanel; native headless Chrome uses an isolated profile without a visible panel. Terms such as "in-app browser", "embedded browser", "right-side browser", "current browser", "browser use", "内置浏览器", "右侧浏览器", and "当前浏览器" all mean this same session-scoped browser, not a separate remote browser. For a linked resource without explicit Browser intent, do not call this tool first: check available skills for an applicable purpose-built connector, API, or CLI, and when `tool_search` is available query deferred integration tools too. Earlier Browser use or an open Browser tab is context, not a reason to make later semantic work Browser-first. Use this tool for that operation only when the user explicitly selected this Browser, no applicable non-Browser path exists, that path cannot access the resource or perform the requested operation, or UI work remains. For a single Browser workflow, do not create or update a `todowrite` list only to mirror Browser progress; Browser tool calls already expose that progress. When the user says a page is already or currently open in this Browser, inspect that existing page first; do not navigate or reload it merely because the request also mentions its URL or domain. Choose between `navigate` and `open_tab` according to the active Browser provider guidance appended to this tool. When the user explicitly requests a new tab, asks to preserve the current page, or uses cues such as new tab, another tab, 继续打开, 再打开, 另开, or 新开, use `open_tab` whenever the active provider exposes it. Do not inspect solely to choose between `navigate` and `open_tab`; use the Browser state already present in the conversation or tool result. When the user refers to a page, link, or content already open there after Browser is selected, call `inspect` first to read its URL, title, and page state; do not ask them to provide the link or screenshot again. Call one Browser action at a time and wait for its result; Browser calls are stateful and must not be parallel. If any Browser result contains `safety.requiredNextTool` and that named tool is available, the very next assistant action MUST be exactly one actual call to that tool: emit no prose and call no other tool first. For `ask_user`, let the user take over the same Browser tab only when the active provider exposes a visible interactive surface; a headless provider has no takeover surface, so follow the `authentication_credential_prompt` safety instruction and sign in yourself; otherwise never request a password, verification code, or other secret in chat. Set `action` to exactly one supported enum value and never include quotes, XML, Markdown, or other markup in the action name. Put every action argument inside `input`; for example, fill is exactly `{ "action": "fill", "input": { "ref": "<opaque-ref>", "text": "<text>" } }`. A `screenshot` image is model-visible inspection evidence and is not shown to the user by default. Do not proactively claim it was sent, shared, shown, or attached, and do not emit delivery markup unless the user explicitly asks to see or receive that screenshot. When explicitly asked, emit `userDelivery.mediaMarkup` exactly once only if `userDelivery.available` is true. Never expose Base64 or a data URL, and never fabricate a path or markup when delivery is unavailable. Once inspect, query, or an action result contains the requested fact, result, or evidence, stop reading and answer or continue to the next required operation; do not chain inspect, query, DOM reads, or screenshot after sufficient evidence is already available. If inspect already lists the complete available options and none matches the user\'s intent, do not call screenshot, query, or inspect again; stop and ask the user. When a click is expected to navigate the main document, use `click_and_wait_for_navigation` so navigation listeners are registered before the click; keep ordinary non-navigation interactions on `click`. An ordinary `click` result proves only that input was dispatched; the requested page effect is not verified. Use `inspect`, `query`, or `screenshot` after it and confirm the expected state before claiming that the click achieved the user\'s goal. `upload_files` uses `input: { ref, paths }` with the opaque upload ref and exact current-turn attachment or active-workspace file paths; do not wrap them in a target object. `upload_files` is the only file validation call for this workflow; do not preflight with shell/read/stat/test/ls. Final publish, send, delete, purchase, or other externally visible actions require explicit user confirmation immediately before the action; broad initial requests or vague continuation messages do not count. Do not create a reminder, automation, scheduled task, background monitor, or follow-up merely to wait for confirmation. To read page text or DOM, use query with an explicit input.kind. Query `selector` is supported only for `text` and `dom`; `snapshot` and `editable` reject it. Reuse opaque element refs only for the snapshot that returned them. Continue truncated inspect results with action `inspect`, and truncated editable-query results with action `query`; in both cases preserve the returned snapshotId and nextOffset inside input. Arbitrary JavaScript execution is not available outside `run_script`: when the active provider exposes `run_script`, page JavaScript runs only through its `page.evaluate`; otherwise it is not available at all. Never simulate JavaScript execution through another tool. ',
    '`scroll` fields are flat inside input, for example `{ "action": "scroll", "input": { "ref": "<opaque-ref>", "direction": "down", "distance": 600 } }`; put ref, selector, frame, position, or normalized_position directly in input. Only `drag` nests its endpoints as `source` and `target`; never copy that wrapper into scroll or any other action. ',
    'To look up the opaque ref of an element by its visible text, use action `query` with `input: { kind: "semantic", text }`; there is no separate lookup action. ',
    'When the active provider exposes `paste`, it accepts only an opaque `ref`, non-empty plain `text`, and optional `frame` or `clear`; it never reads the host operating-system clipboard. ',
    'When the active provider exposes `return_to_previous_tab`, use it to close the current headless tab and resume the page most recently preserved by `open_tab`. `back` and `forward` only traverse history inside the active tab and never return to a preserved tab. Prefer `back` over re-`navigate` when returning to the previous page in the same tab and its state may not be reconstructable from its URL, such as form drafts, one-time or session-scoped results, or post-redirect pages; re-navigating rebuilds the page and may replay server-side effects. After `back`, use `forward` to return instead of re-navigating. ',
    "Query kind `console` is available by default whenever this Browser tool is present; it needs no developer mode or experimental flag. Use it only for the active tab's current top-level page-load console and uncaught-exception diagnosis. Results are bounded, per-tab, reset on top-level navigation, redact URL query/fragment and common credential-shaped values, and accept optional `levels`, message `filter`, and `limit` fields to reduce unrelated tool output. ",
    "Query kind `network` is available by default whenever this Browser tool is present; it needs no developer mode or experimental flag. Use it for the active tab's current top-level page-load request diagnosis. Results are bounded, per-tab, reset on top-level navigation, omit headers, bodies, cookies, and URL query/fragment/credentials, and accept optional `status`, `resourceTypes`, sanitized-URL `filter`, `afterSequence`, and `limit`. `lastSequence` is a temporal checkpoint: entries returned with `afterSequence` were observed later, which does not by itself prove that an action caused them. ",
    'When the active provider exposes `run_script`, use it for input the single-step actions cannot express: holding keys (game movement), modifier+mouse combinations, timed or repeated sequences, and checks that read page state before deciding where to act. The script body runs in an isolated worker with no Node, filesystem or network APIs against the current tab; page.keyboard/page.mouse send real input, every held key and mouse button is released when the script ends, fails, times out or is cancelled, and refs from earlier inspect calls are invalidated afterwards. page.evaluate runs JavaScript inside the page with its full capabilities (including fetch with the page cookies) and is reported per call site in `pageEvaluate`; do not use it to set the state you are trying to verify. Script screenshots (at most four, plus one on failure) are returned as images. Prefer single-step actions for ordinary form and link interaction. ',
    BROWSER_POST_ACTION_VISUAL_GUIDANCE,
  ].join(''),
  schema: Type.Object(
    {
      action: BrowserActionName,
      input: Type.Optional(BrowserProviderInput),
    },
    {
      additionalProperties: false,
      description:
        "Choose one Browser action and provide only that action's input fields. Query requires input.kind; inspect, back, forward, reload, and screenshot may omit input.",
    },
  ),
} as const satisfies ToolDefinition;
export type LocalBrowserToolInput = Static<typeof LocalBrowserToolDef.schema>;

export const LocalBrowserInspectToolDef = {
  name: 'browser_inspect',
  executionMode: 'sequential',
  description: 'Inspect the active session-scoped Browser tab and return page state.',
  schema: Type.Object({
    ...BrowserTargetProps,
    includeDom: Type.Optional(Type.Boolean({ description: 'Whether to include DOM details.' })),
  }),
} as const satisfies ToolDefinition;
export type LocalBrowserInspectToolInput = Static<typeof LocalBrowserInspectToolDef.schema>;

export const LocalBrowserNavigateToolDef = {
  name: 'browser_navigate',
  executionMode: 'sequential',
  description: 'Navigate the active session-scoped Browser tab to a URL.',
  schema: Type.Object({
    ...BrowserTargetProps,
    url: Type.String({ description: 'URL to open in the embedded browser.' }),
    replaceCurrentTab: Type.Optional(
      Type.Boolean({
        description:
          'Set true only when the user explicitly asked to replace or reuse the currently loaded Browser tab.',
      }),
    ),
  }),
} as const satisfies ToolDefinition;
export type LocalBrowserNavigateToolInput = Static<typeof LocalBrowserNavigateToolDef.schema>;

export const LocalBrowserClickToolDef = {
  name: 'browser_click',
  executionMode: 'sequential',
  description:
    'Click an element center or an explicit viewport position in the active session-scoped Browser.',
  schema: Type.Object({
    ...BrowserTargetProps,
    ...BrowserPointerFocusProps,
    button: Type.Optional(
      Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Literal('middle')]),
    ),
    click_count: Type.Optional(Type.Number({ minimum: 1, maximum: 3 })),
    delay: Type.Optional(Type.Number({ minimum: 0, maximum: 5_000 })),
  }),
} as const satisfies ToolDefinition;
export type LocalBrowserClickToolInput = Static<typeof LocalBrowserClickToolDef.schema>;

export const LocalBrowserTypeToolDef = {
  name: 'browser_type',
  executionMode: 'sequential',
  description:
    'Type text into the focused or selected target in the active session-scoped Browser.',
  schema: Type.Object({
    ...BrowserTargetProps,
    ...BrowserFocusProps,
    text: Type.String({ description: 'Text to type.' }),
    clear: Type.Optional(Type.Boolean({ description: 'Clear the target before typing.' })),
    delay: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000 })),
  }),
} as const satisfies ToolDefinition;
export type LocalBrowserTypeToolInput = Static<typeof LocalBrowserTypeToolDef.schema>;

export const LocalBrowserPressKeyToolDef = {
  name: 'browser_press_key',
  executionMode: 'sequential',
  description: 'Press a key in the active session-scoped Browser.',
  schema: Type.Object({
    ...BrowserTargetProps,
    key: Type.String({ description: 'Key to press, for example Enter, Escape, A, or Backspace.' }),
    modifiers: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Optional modifiers such as Meta, Control, Shift.',
      }),
    ),
  }),
} as const satisfies ToolDefinition;
export type LocalBrowserPressKeyToolInput = Static<typeof LocalBrowserPressKeyToolDef.schema>;

export const LocalBrowserScrollToolDef = {
  name: 'browser_scroll',
  executionMode: 'sequential',
  description:
    'Scroll the active session-scoped Browser tab and report whether the resolved scroll owner actually moved or was already at its boundary.',
  schema: Type.Object({
    ...BrowserTargetProps,
    direction: Type.Optional(
      Type.Union(
        [Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right')],
        { description: 'Scroll direction.' },
      ),
    ),
    distance: Type.Optional(Type.Number({ description: 'Scroll distance in pixels.' })),
  }),
} as const satisfies ToolDefinition;
export type LocalBrowserScrollToolInput = Static<typeof LocalBrowserScrollToolDef.schema>;

export const LocalBrowserHoverToolDef = {
  name: 'browser_hover',
  executionMode: 'sequential',
  description:
    'Hover an element center or an explicit viewport position in the active session-scoped Browser. For an inspected ref, the result may recover a semantic name from newly visible tooltip content.',
  schema: Type.Object({
    ...BrowserTargetProps,
    ...BrowserPointerFocusProps,
    delay: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 5_000,
        description:
          'Hold the pointer on the target for this many milliseconds before reading the hover effect. Use it for tooltips that fade in slowly; sampling continues for the whole hold.',
      }),
    ),
  }),
} as const satisfies ToolDefinition;
export type LocalBrowserHoverToolInput = Static<typeof LocalBrowserHoverToolDef.schema>;

export const LocalBrowserWaitForToolDef = {
  name: 'browser_wait_for',
  executionMode: 'sequential',
  description: 'Wait for time, text, or selector state in the active session-scoped Browser.',
  schema: Type.Object({
    ...BrowserTargetProps,
    selector: Type.Optional(Type.String({ description: 'CSS selector to wait for.' })),
    text: Type.Optional(Type.String({ description: 'Text to wait for.' })),
    state: Type.Optional(
      Type.Union([
        Type.Literal('attached'),
        Type.Literal('detached'),
        Type.Literal('visible'),
        Type.Literal('hidden'),
      ]),
    ),
    timeout: Type.Optional(Type.Number({ description: 'Timeout in milliseconds.' })),
  }),
} as const satisfies ToolDefinition;
export type LocalBrowserWaitForToolInput = Static<typeof LocalBrowserWaitForToolDef.schema>;

export const LocalBrowserGetDomToolDef = {
  name: 'browser_get_dom',
  executionMode: 'sequential',
  description: 'Read DOM metadata from the active session-scoped Browser tab.',
  schema: Type.Object({
    ...BrowserTargetProps,
    selector: Type.Optional(Type.String({ description: 'Optional CSS selector to inspect.' })),
  }),
} as const satisfies ToolDefinition;
export type LocalBrowserGetDomToolInput = Static<typeof LocalBrowserGetDomToolDef.schema>;

export const LocalBrowserScreenshotToolDef = {
  name: 'browser_screenshot',
  executionMode: 'sequential',
  description:
    'Capture a screenshot from the active session-scoped Browser tab as model-visible inspection evidence that is not shown to the user by default. Do not proactively claim it was sent, shared, shown, or attached, and do not emit delivery markup unless the user explicitly asks to see or receive that screenshot. When explicitly asked, emit `userDelivery.mediaMarkup` exactly once only if `userDelivery.available` is true. Never expose Base64 or a data URL, and never fabricate a path or markup when delivery is unavailable.',
  schema: Type.Object({
    ...BrowserTargetProps,
    scope: Type.Optional(
      Type.Union([Type.Literal('viewport'), Type.Literal('fullPage'), Type.Literal('clip')]),
    ),
    clip: Type.Optional(
      Type.Object({
        x: Type.Number(),
        y: Type.Number(),
        width: Type.Number({ minimum: 1 }),
        height: Type.Number({ minimum: 1 }),
      }),
    ),
  }),
} as const satisfies ToolDefinition;
export type LocalBrowserScreenshotToolInput = Static<typeof LocalBrowserScreenshotToolDef.schema>;

export const LocalBrowserPasteToolDef = {
  name: 'browser_paste',
  executionMode: 'sequential',
  description: 'Paste plain text or HTML into the focused or selected browser target.',
  schema: Type.Object({
    ...BrowserTargetProps,
    ...BrowserFocusProps,
    text: Type.Optional(Type.String({ description: 'Plain text to paste.' })),
    html: Type.Optional(Type.String({ description: 'HTML content to paste.' })),
    clear: Type.Optional(Type.Boolean({ description: 'Clear the target before pasting.' })),
    waitMs: Type.Optional(Type.Number({ description: 'Post-paste wait time in milliseconds.' })),
  }),
} as const satisfies ToolDefinition;
export type LocalBrowserPasteToolInput = Static<typeof LocalBrowserPasteToolDef.schema>;

export const LocalBrowserVerifyTextToolDef = {
  name: 'browser_verify_text',
  executionMode: 'sequential',
  description: 'Verify that text is present in the active session-scoped Browser tab.',
  schema: Type.Object({
    ...BrowserTargetProps,
    selector: Type.Optional(Type.String({ description: 'Optional root CSS selector.' })),
    text: Type.Optional(Type.String({ description: 'Text to verify.' })),
    texts: Type.Optional(Type.Array(Type.String(), { description: 'Texts to verify.' })),
    exact: Type.Optional(Type.Boolean({ description: 'Require exact text match.' })),
    caseSensitive: Type.Optional(Type.Boolean({ description: 'Use case-sensitive matching.' })),
  }),
} as const satisfies ToolDefinition;
export type LocalBrowserVerifyTextToolInput = Static<typeof LocalBrowserVerifyTextToolDef.schema>;

export const LocalBrowserInspectEditableTargetsToolDef = {
  name: 'browser_inspect_editable_targets',
  executionMode: 'sequential',
  description: 'List visible editable targets in the active session-scoped Browser tab.',
  schema: Type.Object({
    ...BrowserTargetProps,
    selector: Type.Optional(Type.String({ description: 'Optional root CSS selector.' })),
    limit: Type.Optional(Type.Number({ description: 'Maximum number of targets to return.' })),
  }),
} as const satisfies ToolDefinition;
export type LocalBrowserInspectEditableTargetsToolInput = Static<
  typeof LocalBrowserInspectEditableTargetsToolDef.schema
>;
