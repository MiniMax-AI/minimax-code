<!-- Only the sections the short Skill words differently. browser-skill-asset.ts builds the short
Skill from SKILL.md, putting each section below in place of SKILL.md's section of the same heading. -->

## Start With Inspect

This Skill is the short form. Long examples and rarely needed details are in
`references/browser-details.md`, next to this Skill's `Location` (drop the `files://` prefix to get
the path). Read that file when a task needs a part named below; do not read it up front.

Follow the active-provider navigation policy stated by the Browser tool. With native headless
Chrome, use fully qualified absolute HTTP(S) URLs; `navigate` replaces the page of the tab you
control, so keep searching and following intermediate pages there, and use `open_tab` only to
preserve a page or when the user asks for another tab (`继续打开`、`再打开`、`另开` and `新开` count).
Do not call `inspect` solely to choose between `navigate` and `open_tab`.

On both providers, page-changing actions (navigate, click, type, run_script and similar, including
the writes of a Browser program) work only on the one tab you control in this turn; reads such as
`inspect` may use any tab of this session. A new turn starts with no controlled tab.
`TAB_NOT_CONTROLLED` means you have no tab yet: `list_tabs` (it lists `tabId`, URL, owner and
`controlled`; on Electron also `visible`, and `<in-app-browser-context>` lists them as the turn
starts; without that list this turn, `list_tabs` first). Before `open_tab`, reuse a tab already on the site you need: `select_tab { tabId }` it and
work inside it (its search box, its links); otherwise open a new background tab with
`open_tab { url }`. Neither changes the page the user is viewing. On the user's own tab or the page the user is
viewing, navigate to another URL only when they asked to change that page.
A tab a click opens becomes the tab you control; if it closes itself, control returns to the tab
that opened it (`leaseReturnedTo`). To leave it yourself, `close_tab` it, then `select_tab` the
result's `previousTabId`. Pages you opened close at turn end unless the user used them or you
mark them: `mark_tab { tabId, retention: "deliverable" }` only when the live page itself is the
user-facing result (a page the user asked to look at themselves, something you created or edited,
a submitted form's result) or the user asked to keep it open; `"carryover"` only when your work must continue from this page in a later turn
(one turn: next turn it is listed as `temporary` again and closes at that turn's end unless marked
again). A request to keep a page for the next turn is carryover. Mark
no research, search, source or intermediate page. On Electron the panel never opens by itself;
`show_tab { tabId }` or `open_tab { url, show: true }` only when the request is mainly to put that
page in front of the user, not when it only helps you answer (`pending: true`: it opens when the
user returns to this chat). A page the user asked to look at themselves is also marked
`deliverable`; opening a page to read or check something in it is a lookup, neither shown nor
kept. On Electron, when the schema offers `release_tab` and the user must act in the page
(sign-in, verification), `show_tab` it, `release_tab` so their input is not blocked (it also keeps
your page through this turn's end), then `ask_user`; afterwards `select_tab` and `inspect` it
before writing. Headless providers have neither: see Authentication And User Takeover. Before
asking about a page you will keep working on, mark it `carryover`. `close_tab { tabId }` closes a tab
and releases control when it was the one you control; on a running Mini App it stops the app.
Intermediate tabs close at turn end by themselves; mention a `deliverable` tab in your reply.

If a Browser call returns `BROWSER_USER_TAKEOVER`, the user took over the page you control: stop all
Browser actions for this turn (no retry, no other tab, no `ask_user` to ask whether to continue),
say in plain words which step you stopped at and what the user can do next, and end the turn. Next
turn `list_tabs` reports the taken-over tab; inspect it again before acting. Mini App pages are never
taken over: the user may keep using them, so inspect again before each write.

`back` and `forward` traverse the current tab's history. Prefer `back` over re-`navigate` when the
previous page's state may not be reconstructable from its URL; re-navigating may replay server-side
effects.

If the user says the page is already or currently open in the Browser, inspect that page first,
with `browser({ action: "inspect", input: {} })` (on Electron the tab `list_tabs` reports as
`visible`). Do not navigate or reload it merely because the request also mentions its URL or domain,
and do not ask for the URL or a screenshot before trying `inspect`. Ask the user for the URL only
when neither the context nor an available tool can provide it. Use `screenshot` when visual layout
matters, not as a substitute for `inspect` or `query`.

`inspect` and `query` with `kind: "semantic"` list the page in `elements`, one line per element in
document order:

```text
<ref> <role> <name> [state] [state]
browser-element:<n>-<id> link Sign in [href=/account/login]
browser-element:<n>-<id> textbox Email [value=ada@example.com]
```

A ref is only ever copied from a result this session returned; the lines above show the shape, not
usable refs. Copy a ref whole. States: `value=`, `selected`, `checked`, `unchecked`, `expanded`, `disabled`,
`required` and other control states, `type=` (an input that is not text), `href=` (where a link goes:
a path on the page's own site, to be joined to the result's `url` for `navigate`, or a whole address),
`frame=` (in a different frame from most of the page's elements), `not-actionable` (Chromium does not treat it as interactable),
`offscreen` (its box lies outside the area the page scrolls through, such as an item of a closed
drawer: open what holds it before acting on it) and `no-pointer` (its coordinates are
unavailable: `click`, `double_click`, `triple_click`, `hover`, `drag`, `check` and `uncheck` are not
safe on it, while `fill`, `type`, `select_option`, `paste` and `upload_files` may still use the ref).
A line without a ref (a heading, a column header) is context. `omittedElements` counts elements left
out because they say nothing or only repeat a neighbour; their refs stay valid. Coordinates are not
listed: take them from a `screenshot` when a target is not a DOM element.

If the result has `truncated: true` and a `continuation`, that is the complete next Browser input;
copy it unchanged and continue the same snapshot until it is exhausted or the page changes.

## Read Page Content With Query

`query` reads page content the element lines do not hold. It always requires an explicit
`input.kind`; never call it with an empty input.

- `kind: "text"`: visible text; narrow the selector when possible.
  `browser({ action: "query", input: { kind: "text", selector: "main", maxChars: 20000 } })`
- `kind: "dom"`: markup, only when it is required.
- `kind: "editable"`: editable targets. A truncated result continues with its `continuation`
  unchanged; restarting it without that `snapshotId` invalidates earlier refs.
- `kind: "semantic"` with `text`: the refs of an exact visible identifier in a long or ambiguous
  list, without clicking anything. It takes no selector.
- `kind: "rows"`: tables and repeated lists, one record per element matching the required row
  `selector`. `fields` maps an output name to a CSS selector relative to the row, `"selector@attribute"`,
  `"@attribute"` of the row, or `"text"` for the whole row. When the first page cannot hold every row,
  it also returns `fullOutputPath`, a JSON file of up to 5000 rows.
  `browser({ action: "query", input: { kind: "rows", selector: "table tbody tr", fields: { sku: "td.sku", link: "a@href", row: "text" } } })`
- `kind: "console"` and `kind: "network"`: diagnosis of the current page load, see
  `references/browser-details.md`.

Read page data with `query`, not a `run_script` that reads the DOM:

- Every match of a selector: add `all: true` to `kind: "text"` or `"dom"`. It returns `matches[]`
  and `totalMatches`; `offset` and `limit` count matches and `maxChars` caps each match.
- Long content: a `text`/`dom` read cut by `maxChars` returns `truncated: true` and a `continuation`;
  pass it unchanged. `OFFSET_OUT_OF_RANGE` means the content changed: read again without `offset`.
- Current form values appear only when the result carries them; a missing value is not an empty
  field. Password fields never return a value; do not try to read them another way.

A selector miss returns `candidates`: the page's closest elements. Use a candidate's `ref` or
`selector` instead of guessing another selector; a candidate with a `count` is a repeated structure,
so read it with `all: true` or `kind: "rows"`.

To read a single-page app only after its data arrived, wait for the request that loads it or for the
element that shows it, then read:

```text
browser({ action: "wait", input: { kind: "network", filter: "/api/orders", timeout: 15000 } })
browser({ action: "wait", input: { kind: "selector", selector: "#orders tbody tr" } })
```

## Operation Loop

Call one Browser action at a time and wait for its result before issuing the next action. Browser
actions share page, snapshot, frame, and navigation state; never emit parallel Browser calls. For a
single Browser workflow, do not create or update a `todowrite` list only to mirror Browser progress;
Browser tool calls already show that progress.

Page-changing actions accept a top-level `observe` next to `action` and `input`, in a direct call
and inside `run_code` alike. After a successful action, the same call reads the page and returns it
as `result.observation`: `{ kind: "inspect" }` gives fresh refs, `{ kind: "text", selector? }` gives
visible text, and `waitForText` first waits for text you expect the action to produce (a search
suggestion, a confirmation). It also runs when a click navigates (`UNEXPECTED_NAVIGATION`), so the
observation is the new page. Prefer `observe` to a separate `inspect` or `query` after an action:

```text
browser({ action: "click", input: { ref: "<opaque-ref>" }, observe: { kind: "text", selector: "[role=dialog]", waitForText: "Saved" } })
```

The observation is evidence for your judgment; it does not turn `effect.verified: false` into a
verified effect.

When this turn exposes Browser only inside `run_code`, "one at a time" means awaiting each Browser
call in order inside the program, not one model response per action. Put one whole bounded step in a
single program: fill the related fields, type a search term with `observe.waitForText`, click the
matching option from that observation, and read the form back. Check `r.isError` after every call
and handle it. After a write fails or a call times out (`BROWSER_OPERATION_TIMEOUT`), the host
refuses the program's remaining Browser calls
(`BROWSER_PTC_STOPPED`); a read that fails does not stop the program. An irreversible or externally visible commit (submit, send, save, pay,
delete, share) is the last Browser call of its program, made only after the program read back what
it commits; give the commit `observe` so its result already shows the outcome.
`safety.requiredNextTool` still means returning from the program and making that call directly.

A click or key press that submits reports the server's answer in `navigation.requestMethod`,
`navigation.redirectStatus` and `navigation.httpStatus`; a failed or timed-out submit says when the
server already answered it. Inspect the page instead of submitting again.

A submit, save, send or other commit that times out, hits a connection reset, or ends with an
unclear result may already have taken effect. Check its result on the page or site before repeating
it: read the page back, or open the list or record the commit would change. Never repeat a commit
just to find out whether the first one landed. Any write (click, fill, type, select_option, check,
press_key, upload_files, drag) whose outcome is uncertain says so in `uncertainWrite`; writing to
the same target again before a read of the page returns `writeRetryWarning`, or is refused with
`UNVERIFIED_WRITE_RETRY`. Read the page first; pass `confirmRetry: true` in the input only when you
decided to repeat the write on purpose.

1. `inspect` the current tab.
2. Choose an opaque element ref or an action supported by the compact Browser schema.
3. Call `browser` with the selected `action` and only that action's `input` fields.
4. When the action result includes `visualObservation.available: true`, inspect that attached image
   first. Call `inspect`, `query`, or explicit `screenshot` only when the automatic visual is absent
   or does not contain the state needed for the next decision.

Navigation, clicks, effective scrolling, drag/drop, uploads, and non-native editors may include one
compressed post-action visual automatically, at most four per turn. Native `input` and `textarea`
writes normally do not, because their structured value/effect verification is cheaper. It is
supplemental evidence: it never changes the action's `success`, authorizes a sensitive action, or
turns `effect.verified: false` into a verified postcondition.

Once an inspect, query, or action result already contains the requested fact, result, or evidence,
stop reading and answer or continue to the next required operation. Do not chain inspect, query, DOM
reads, or screenshots after sufficient evidence is already available. Verification is for a state
change or a genuinely missing fact, not a second way to reread the same successful result.

If an action fails, reports no effect, or verification shows the same page state, inspect once to
refresh the target. Do not repeat the same action with the same target and input after that single
recovery attempt. Stop and explain the blocker or ask the user for help; never bypass a missing or
stale ref by guessing coordinates.

For `scroll`, the returned `effect` is the postcondition: `moved: true` means it moved; `moved: false`
with `atStart` or `atEnd` is a successful boundary no-op. `NO_SCROLL_EFFECT` and
`SCROLL_EFFECT_UNVERIFIED` mean inspect once, then choose a newly observed target; do not repeat the
same scroll or claim that it scrolled.

For forms, choose an option only when its meaning matches the user's stated intent. If none of the
available options is semantically valid, stop and ask the user instead of choosing the closest or a
known-wrong answer. An instruction to skip unknown fields does not authorize an incorrect answer. If
inspect already lists the complete available options and none matches the user's intent, do not call
screenshot, query, or inspect again to seek a second opinion; stop and ask the user. Do not search
the workspace, local files, test metadata, or unrelated tools to reinterpret the page or resolve the
mismatch; report the visible choices and ask the user directly.

An ordinary `click` result means the input was dispatched, but the page effect is not verified
(`effect.verified: false`): use `observe`, `inspect`, `query`, or `screenshot` and see the expected
state before claiming it worked. When it navigates, `navigation.detected: true` says so and every
earlier ref is invalid; read the new page before the next interaction.

When a link or control is expected to navigate the main document, use
`browser({ action: "click_and_wait_for_navigation", input: { ref: "<opaque-ref>", timeout: 30000 } })`
instead of separate `click` and `wait` calls. A click that does not navigate returns `ACTION_TIMEOUT`;
inspect before deciding what to do. Search, filter, autocomplete and other in-page buttons stay on
plain `click`.

Every element action (`click`, `double_click`, `triple_click`, `hover`, `fill`, `type`, `check`,
`uncheck`, `select_option`) and `scroll` takes `ref`, `selector`, `position`, or `normalized_position`
directly in `input`; prefer the latest opaque ref and never combine them. Only `drag` nests `source`
and `target`. `paste` and `upload_files` require an opaque ref. `fill` always clears first. Icon
controls without a name, coordinates of non-DOM targets and `paste`: see
`references/browser-details.md`.

## Scripted Input With run_script

Use `run_script` only when the active provider advertises it and single-step actions cannot express
the check: holding keys, modifier plus mouse combinations, timed or repeated input, or a loop that
reads page state before choosing where to act. Ordinary forms, links and one-off key presses stay on
the single-step actions. Its input is an async function body in `code`, or a saved workspace `.js`
`path`, with an optional `timeout`. Drive the behavior under test with `page.keyboard` and
`page.mouse`; `page.evaluate` only reads state or arranges a precondition. Refs from earlier
`inspect` calls are invalid afterwards. The API, an example and the evidence rules are in
`references/browser-details.md`: read that part before writing a script.
