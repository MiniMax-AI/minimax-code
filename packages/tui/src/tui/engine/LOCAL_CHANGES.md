# MCode TUI Engine local changes

This ledger starts at the exact Pi source baseline recorded in `BASELINE.json`. It records every
MCode-owned difference from that baseline.

| ID   | Origin                 | Scope                                                                   | Change                                                                                                                                                                                          | Behavior impact                                                                                                                                   | Evidence                                                                                   |
| ---- | ---------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| L001 | Initial import         | all upstream TypeScript files                                           | Rewrite relative `.ts` module specifiers to `.js` for NodeNext.                                                                                                                                 | none                                                                                                                                              | `BASELINE.json`; baseline verifier                                                         |
| L002 | Initial import         | source ownership                                                        | Store the adapted Pi snapshot in MCode `engine/`.                                                                                                                                               | none                                                                                                                                              | source inventory                                                                           |
| L003 | Initial import         | product import boundary                                                 | Add `public.ts` as the only product-facing engine import entry.                                                                                                                                 | none                                                                                                                                              | source boundary check                                                                      |
| L004 | Initial import         | provenance                                                              | Record upstream identity, per-file hashes and the adapted tree digest.                                                                                                                          | none                                                                                                                                              | baseline verifier                                                                          |
| L005 | Initial import         | TypeScript contract                                                     | Apply only the type-level changes required by the shared ES2022 strict MCode build.                                                                                                             | none intended                                                                                                                                     | unified typecheck/build                                                                    |
| L006 | Runtime integration    | `public.ts` utility surface                                             | Export current Pi key, text and layout utilities through the product-facing barrel so product adapters can reuse Engine behavior without importing implementation modules.                      | Product input, text layout and regular feature viewport allocation use the canonical Pi Engine implementation.                                    | key/width/Markdown/editor corpus; regular feature renderer tests                           |
| L007 | Product rendering      | `components/markdown.ts` product hooks                                  | Add compact plain fenced-code chrome and terminal `<br>` semantics so MCode can preserve its visual contract without a second Markdown implementation.                                          | MCode keeps its compact code presentation while inheriting Pi Markdown, LaTeX and terminal-image behavior.                                        | Engine Markdown corpus; code-block and Transcript focused tests                            |
| L008 | Product input          | `components/input.ts` and `components/select-list.ts` product hooks     | Add configurable prompt/paste transform/mask plus product filtering and bounded wrapped descriptions so the superseded MCode copies can be deleted.                                             | Product search, secret input and decision lists use the Pi Engine implementations without losing MCode presentation behavior.                     | Input, SelectList, decision-picker and interaction focused tests                           |
| L009 | Editor integration     | `components/editor.ts` generic adapter hooks and `index.ts` type export | Add serializable state capture/restore, range replacement, paste interception, autocomplete telemetry and undo extension state so the duplicate MCode editing state machine can be deleted.     | All generic editing behavior now executes in Pi Editor; the product wrapper owns only Draft persistence and attachment identity.                  | Complete Pi Editor corpus; Engine delta test; product Draft/attachment/failed-submit tests |
| L011 | Fullscreen interaction | `layout.ts`, `tui-alt-screen.ts` and `public.ts` mouse dispatch         | Route SGR press, drag and release events through the rendered Pi layout before Alt text selection, using layout-local coordinates and deepest-target precedence.                                | Fullscreen product interactions such as Plan Review remain mouse-operable without restoring the deleted product-owned selection or renderer path. | Alt renderer integration; Chat layout; Inline panel; Plan Review mouse tests               |
| L013 | Pi maintenance         | `components/text.ts` and `components/markdown.ts`                       | Adopt Pi post-0.84.2 fixes for adaptive narrow-width padding and wrapped table style restoration.                                                                                               | Narrow panes stay within terminal width, and wrapped links do not leak styles into table borders or adjacent cells.                               | Engine local-delta narrow-width regression; Pi Markdown corpus                             |
| L014 | Native packaging       | `native-module-path.ts`, `native-modifiers.ts` and `terminal.ts`        | Resolve native helpers from the installed `@minimax/code` package root before standalone archive fallbacks.                                                                                     | Packaged Apple Terminal and Windows modifier/VT helpers load from the actual release layout.                                                      | Native candidate unit contract; package layout inspection                                  |
| L015 | Render scheduling      | `tui.ts`                                                                | Expose Pi's existing immediate scheduler separately from the destructive `force` reset path.                                                                                                    | Product interactions schedule immediate rendering without resetting differential state or clearing native scrollback; L044 governs delivery under backpressure.                                         | Engine local-delta immediate-render regression; Surface Host focused tests                 |
| L016 | Process resilience     | `autocomplete.ts` fd child output streams                               | Handle stdout/stderr stream errors at the file-autocomplete owner, terminate the failed child and resolve the scan with no suggestions.                                                         | A broken background fd pipe cannot escalate through `uncaughtException` and stop the active TUI Session.                                          | `tui-autocomplete-process-streams.test.ts`; process-guard focused tests                    |
| L017 | Pi maintenance         | `tui-main-screen.ts`                                                    | Stream full and differential renders through Pi's bounded terminal writer instead of constructing one unbounded output string (Pi `6c4f360264397c59801f6da2bdac13e3b1fcbe91`).                  | Large regular-mode renders preserve output order without exceeding V8's maximum string length.                                                    | Pi 0.84.4 render regression; bounded-write focused test                                    |
| L018 | Pi maintenance         | `autocomplete.ts`                                                       | Search direct children separately, merge them with recursive matches, and sort equal-score results by depth, length, then path (Pi `b37ebb7f22ec1a8fbf882366dc20ae6d6010a6e2`).                 | Direct workspace paths remain visible and stable before deeply nested matches when recursive results are abundant.                                | Pi 0.84.4 autocomplete regression; autocomplete focused test                               |
| L019 | Pi maintenance         | `tui-alt-screen.ts`                                                     | Treat `/` and `-` as selectable word joiners during fullscreen double-click selection (Pi `1ac6128e66bd44668b58db773c2a76c29163ade5`).                                                          | Paths and kebab-case tokens are selected as complete words.                                                                                       | Pi 0.84.4 fullscreen selection regression; selection focused test                          |
| L020 | Pi compatibility       | `tui-alt-screen.ts`                                                     | Add `copyOnSelect`, active-selection detection and explicit active-selection clipboard helpers while keeping automatic copy enabled by default (Pi `4e494929998d6bc4fccf75e0a233f727db4b70ee`). | Hosts can opt out of clipboard side effects or trigger copy explicitly without changing the default fullscreen behavior.                          | Pi 0.84.4 fullscreen copy API; selection focused test                                      |
| L021 | Pi capability          | `terminal-image.ts` and `index.ts`                                      | Add Pi-compatible environment and host overrides for image protocol, true-color and hyperlink capability detection (Pi `e86823096c5bad39e1ca282ec24bc5eb9bec745b`).                             | QA and hosts can force deterministic terminal capability behavior while conservative auto-detection remains the default.                          | Pi 0.84.4 capability override API; capability focused test                                 |
| L022 | Product input | `components/editor.ts` | Add a display-only empty-editor placeholder using standard cursor, width, and padding rendering. | Guide initial input without writing placeholder text into the editable draft or duplicating engine layout. | Product editor behavior and focused TUI application tests |
| L023 | Terminal theme tracking | `terminal-colors.ts` and `tui.ts` | Extract OSC 11 responses and DEC 2031 reports within each chunk, then dispatch remaining input instead of dropping the whole chunk. | Detect theme changes even when reports share a read chunk with normal input, without swallowing keys. | `tui-terminal-color-sequences.test.ts`; upstream-pinned parser cases unchanged |
| L029 | Product readability | `components/markdown.ts` | Render link labels in an isolated context so inner body / heading ANSI colors cannot override link styling. | Preserve nested bold, italic, inline code, wrapping, and table link semantics; restore outer styling afterward. | `tui-markdown-readability.test.ts`; Engine Markdown corpus |
| L024 | Product input | `keys.ts` | Add the minimal legacy-terminal mapping where `Ctrl+/` and `Ctrl+_` share `0x1F`, supporting the `/btw` side-session shortcut. | Legacy terminals match `Ctrl+/`; kitty and modifyOtherKeys retain distinct sequences. | `tui-keybindings.test.ts`; baseline verifier |
| L025 | Long-session search | `alt-screen-search.ts` and `tui-alt-screen.ts` | Reuse the corpus and matches during active search; invalidate on content or width changes. | Repeated navigation does not rebuild Unicode coordinates. | `tui-search-index.test.ts` |
| L026 | Streaming display | `components/markdown.ts` | Cache stable blocks, retain two trailing blocks, and fall back to full parsing for reference definitions. | Preserve canonical per-character output while reducing repeated parsing of long replies. | `tui-markdown-stream.test.ts`; Pi Markdown corpus |
| L027 | Continuous resize | `tui.ts` and `tui-main-screen.ts` | Add a resize hook, immediately draw the visible tail, and replay history after 150ms. | Keep input visible during resize and restore ordered history after stabilization and exit. | `tui-resize-replay.test.ts`; Pi render/shrink corpus |
| L028 | Notification focus | `terminal.ts` and `tui.ts` | Record focus reports and forward them to viewport listeners; do not send focus sequences to the editor. | Product focus suppression is configurable; cmux focus remains host-owned. | `tui-terminal-focus.test.ts`; `tui-terminal-notifications.test.ts` |

| L030 | Shell completion | `autocomplete.ts` and `components/editor.ts` | Add optional `shouldAutoTriggerCompletion` and candidate `applyOnEnter` policies so providers control automatic triggering and Enter behavior. | Shell typing does not open completion automatically. Tab opens or accepts it; Enter always submits current text. Open menus keep filtering. Invalid forced-completion context immediately cancels requests and clears menus, including removal of the shell marker or an empty command prefix. `/` and `@` keep their defaults. | `tui-bash-autocomplete.test.ts`, product editor behavior, and upstream editor tests |

`L010` was retired after the ownership review. cmux owns focused-surface notification suppression
and does not provide a reliable product-level focus contract through `CSI 1004`; gating notification
emission on that signal could suppress every completion. The Engine focus changes were removed,
returning `terminal.ts` to the exact Pi baseline and leaving Pi Alt's existing focus/mouse behavior
unchanged. That historical decision still applies to cmux. L028 only adds a configurable focus policy for other terminals; cmux does not use this signal to suppress notifications.

The superseded custom Kernel, logical Main document, renderer lifecycle split, custom terminal,
custom scheduler and Engine preview Host were removed during the Pi reset. They are not part of the
fork contract and must not be reintroduced as compatibility infrastructure.

Future entries must include:

- the concrete MCode product contract that Pi cannot satisfy;
- the smallest source difference needed;
- user-visible behavior impact;
- focused evidence;
- the condition under which the difference can be removed.

Pi-specific environment variables, symbol names and package-layout assumptions remain unchanged from
the imported Pi baseline. Product integration should pass supported constructor options first. A Pi
source change is allowed only after a real MCode integration problem is demonstrated.

`L011` can be removed once the selected Pi baseline exposes equivalent layout-targeted component
mouse dispatch and MCode has migrated to that upstream contract.

`L016` can be removed once the selected Pi baseline contains equivalent child stdout/stderr error
containment for fd-backed autocomplete.

`L017` can be removed once the selected Pi baseline contains the bounded terminal writer and MCode
no longer needs the NodeNext-adapted copy of that implementation.

`L018` can be removed once the selected Pi baseline orders direct and recursive autocomplete matches
with the same depth, length and path tie-breakers.

`L019` can be removed once the selected Pi baseline treats path and kebab-case separators as word
selection joiners.

`L020` can be removed once the selected Pi baseline exposes the same fullscreen selection-copy
options and helpers used by MCode hosts.

`L021` can be removed once the selected Pi baseline exposes equivalent host and environment
capability overrides and MCode no longer needs a product-facing Engine export for them.

`L022` supports a per-frame `render(width, placeholder)` override, falling back to the constructor option when omitted. `/btw` supplies display copy only; it no longer slices and replaces rendered editor lines, avoiding truncation of the zero-width cursor marker after padding. Drafts, history, and submitted text are unchanged. Evidence: regular / fullscreen cursor regression in `tui-composer-cursor.test.ts` and the per-frame placeholder contract in `editor-behavior.test.ts`.

Remove `L022` when the selected Pi baseline provides equivalent display-only placeholders and per-frame overrides. Remove `L023` when it extracts OSC 11 / DEC 2031 within chunks and dispatches remaining input. Remove `L029` when equivalent link-style isolation is available.

Remove `L024` when the selected Pi baseline natively matches legacy-terminal `Ctrl+/` codes. Remove L025–L028 when it provides the same search-index cache, incremental Markdown, resize replay, and optional focus-report contracts. Remove `L030` when equivalent context-trigger callbacks and Enter completion policies are available.

## L031: Focused panel keyboard paging ownership

- Product contract: standalone readers such as changelog draw fixed headers and footers at actual window height and scroll their own body. Outer fullscreen handling of PgUp / PgDn would consume those keys first.
- Minimal difference: optional `handlesViewportKeys` on Component; TuiAltScreen checks the focused component before keyboard viewport navigation. Components without it retain existing behavior; mouse and global search are unchanged.
- User impact: paging scrolls fixed-frame panel content instead of being swallowed by an empty outer viewport.
- Evidence: `tui-chat-layout.test.ts` sends actual PgDn / PgUp sequences through VirtualTerminal; `tui-alt-screen.test.ts` verifies default scrolling; built CLI regular / fullscreen PTY checks at 40×12 change changelog lines from 1–5 to 5–9.
- Removal condition: the selected Pi baseline provides equivalent focused-component keyboard-navigation ownership and MCode migrates to it.

## L032: Continuous command-argument completion

- Product contract: `/plan`, `/permission`, and `/goal` arguments appear immediately after command completion. Selecting an argument only fills the draft; a space after the command must not cause file-trigger gating to block Tab.
- Minimal difference: `autocomplete.ts` marks command-name candidates with `continueCompletion` and slash results with `kind`, using `shouldAutoTriggerCompletion` for argument context. Failed or cancelled argument callbacks return empty results. `components/editor.ts` follows marked candidates, determines Enter behavior by candidate phase, and reuses provider-declared argument context for explicit Tab.
- User impact: Tab continues from command to argument; accepting arguments remains separate from submission. Commands without argument candidates, file references, and shell input keep their existing behavior.
- Focused evidence: `test/unit/tui-command-argument-autocomplete.test.ts` covers product assembly, aliases, descriptions, Tab / Enter / Esc, cursor suffixes, slash arguments, failures, and delayed results. Existing file, shell, editor, catalog, active-run-flow, and upstream editor / autocomplete tests verify compatibility.
- Removal condition: migrate back when the selected Pi baseline supports equivalent candidate phases and continuous command-argument completion. Product commands and runtime data remain product-owned.

## L033: Strip OSC 133 navigation markers in normal mode

- Product contract: OSC 133 A/B/C zones are internal navigation metadata and must not reach a normal-mode terminal.
- Change: strip leading zone prefixes before comparing screen lines, so initial frames, differential redraws, and history caches stay clean. Fullscreen behavior is unchanged.
- Evidence: `test/unit/tui-engine-local-deltas.test.ts` checks initial and differential writes.
- Removal condition: the selected Pi baseline supplies equivalent normal-mode filtering.

## L035: Fullscreen scrollbar track interaction

- Origin: adapted from [drowzeys/minimax-code commit 0b24a7778741fda335a9a2074464c69911feb1aa](https://github.com/drowzeys/minimax-code/commit/0b24a7778741fda335a9a2074464c69911feb1aa), contributed by drowzeys under the existing MIT license in [issue #216](https://github.com/MiniMax-AI/minimax-code/issues/216).
- Product contract: the fullscreen transcript enables an always-visible scrollbar with a three-column hit gutter. Track presses center the thumb and jump before dragging; thumb presses retain their grab offset without an initial jump.
- Minimal difference: `components/scroll-view.ts` accepts an optional `scrollbarGutter` for always-visible bars, defaulting to one column and retaining at least one content column on narrow terminals. `tui-alt-screen.ts` restricts wide hit targets to that reserved gutter, factors drag mapping into `dragScrollbarTo`, and cancels a drag when an overlay receives the next mouse event. Auto bars retain a one-column target. `layout.ts` stays at the Pi baseline.
- Adaptation: the original contribution widened hits over two live content columns. The reserved gutter prevents those presses from swallowing content clicks or text selection. `chat-layout.ts` opts into the three-column gutter.
- Evidence: `test/unit/tui-scrollbar-interaction.test.ts` drives SGR press, motion, release and wheel events through VirtualTerminal, covering track jumps, thumb grabs, narrow terminals, content routing, selection, overlays and the actual fullscreen ChatLayout.
- Removal condition: the selected Pi baseline provides equivalent reserved-gutter track and drag interaction and MCode migrates to it.

## L034: Regular viewport reconstruction after document changes

- Product contract: after running content or a feature panel closes, show the complete current chat viewport with its Composer and status line. Every current-session row must occur once in native history.
- Minimal difference: when a shorter document would move the viewport origin backwards, or changed visible text is already in scrollback, clear and replay the complete current projection, except for addressable text-only shrink covered by L038. Compare changed historical rows without terminal sequences so style-only updates preserve scrollback. Other updates retain differential rendering and genuine resize retains the existing delayed history replay.
- Tradeoff: structural reconstruction clears native scrollback, including shell history from before TUI startup. Initial short chat documents retain natural document placement. L038 keeps freed visible rows temporarily blank instead of reconstructing unchanged history.
- Evidence: local-delta tests assert every visible row and the complete history, while real Tasks and feature lifecycle tests cover short/long content, background growth, paging, resize, nested panels and return to chat. Queue lifecycle tests replay bracketed CJK paste, Alt+Enter, auto-drain, and history refresh through Ghostty; equal-height and growing historical edits are also covered by xterm. Virtual terminals do not establish native Windows Terminal or iTerm2 touchpad acceptance.
- Product boundary: the regular chat layout keeps rows that may still change out of native history (see L045), so this reconstruction remains for resize and for content that changes after being reported final.
- Scrolled-up readers: without recent user input, reconstruction (output-driven layout shrink, changed or removed historical text, a shrink past the previous viewport) repaints the screen in place and is deferred until the next user input (see L047); resize and input-driven reconstructions remain immediate.
- Removal condition: the selected Pi baseline provides equivalent complete viewport and unique-history behavior.

## L036: Unframed multiline paste chunks

- Product contract: a plain-text stdin chunk containing an internal CR/LF is inserted as a single paste, so its CR bytes cannot submit each line separately.
- Minimal difference: `stdin-buffer.ts` emits the existing paste event before key splitting when there is no pending escape or bracketed paste and the chunk contains only text, tabs and line endings. The existing editor paste path normalizes CR/LF and tabs and folds large payloads.
- Boundary: this is a conservative fallback, not a replacement for bracketed paste. A standalone Enter and text followed only by a final Enter retain key semantics. Unframed pastes split into line-sized or character-sized chunks cannot be distinguished from typing and are not inferred using timing. Conversely, multiple typed lines delivered in a single chunk are indistinguishable from an unframed paste and use this fallback. Control sequences retain their existing parser.
- Evidence: `test/unit/tui-terminal-text-paste.test.ts` replays ProcessTerminal input into the product Editor, including CR, LF, CRLF, Unicode, large pastes, every bracketed chunk split, Enter/shortcuts, and stop/start mode lifecycle. The CR and CRLF cases submitted three separate messages before the fix. These are synthetic input replays, not real WSL terminal acceptance.
- Removal condition: the selected Pi baseline provides equivalent unframed multiline input handling.

## L037: Commit the IME cursor with the regular-screen frame

- Product contract: a presented frame exposes the focused input's cursor position and visibility, including full redraws, differential updates, and deletion-only frames.
- Minimal difference: append cursor restoration to the bounded frame writer before ending synchronized output. Cursor-only updates retain the existing path. The product renderer separately defaults to a visible hardware cursor on Windows, where older ConPTY renderers can omit hidden cursor positions; explicit options and `PI_HARDWARE_CURSOR` remain authoritative.
- Evidence: `test/unit/tui-ime-cursor.test.ts` replays terminal sequences at each synchronized-output boundary and exercises the product renderer, Composer, Editor, focus, mode switches, CJK wrapping, resize and shrink. Native Windows IME and ConPTY transport require separate acceptance.
- Removal condition: the selected Pi baseline commits cursor restoration within the same synchronized frame.

## L038: Preserve native scrolling during visible content shrink

- Product contract: settling visible activity rows must not clear native scrollback or pin a scrolled host viewport to the top. The Composer and status remain at the bottom, and historical content remains unique.
- Minimal difference: when terminal geometry, the text already in scrollback and the declared transient layout keys are unchanged, absorb visible text-only shrink with blank rows at the current screen boundary before cursor extraction and differential rendering. L041 makes this an explicit background-content policy; unclassified layouts restore exposed rows. Subsequent output consumes the space before advancing native history. Ignore redundant same-size resize notifications without cancelling a genuine pending resize replay.
- Boundary: padding is confined to the active screen. Historical text replacement/removal, real resize, overlays and image reflow retain the structural reconstruction path (deferred to the next key without recent input, see L047). Blank rows can temporarily separate native history from the visible tail; this is preferable to clearing and replaying the terminal's scrollback during ordinary completion. No mouse capture is enabled in regular mode.
- Evidence: local-delta tests use xterm's host scroll API independently of the hardware cursor, reproduce the pre-fix jump to line zero, and verify stable scrolling, Composer position, unique history, reclaimed space, corrected-history reconstruction and resize behavior. The product queue/feature tests continue to cover canonical history replacement. Native Windows Terminal and UU Remote acceptance remain separate.
- Removal condition: the selected Pi baseline preserves host scrolling and unique history through visible shrink.

## L039: Erase regular viewport redraws in place

- Product contract: repainting the visible regular-mode screen must not append the previous transcript, Composer or status line to native history.
- Minimal difference: viewport-only full redraws home the cursor, erase each screen row with EL 2 using cursor-down movement, and return home before painting. This avoids ED 2, which saves the old screen to scrollback in Apple Terminal. Full structural reconstruction still clears and rebuilds history.
- Evidence: local-delta tests exercise xterm and a clear-to-scrollback host model, covering historical style changes, simultaneous growth, short-document shrink, subsequent differential output, host scrolling and resize preview/replay. Native Apple Terminal replay of synthetic renderer output reproduces duplicate rows before the fix and preserves the exact document afterward.
- Boundary: native replay covers synthetic output, not every live-model interaction or other terminal emulator.
- Removal condition: the selected Pi baseline supplies equivalent in-place viewport erasure without retaining stale rows in native history.

## L040: Coalesce synchronous submission renders

- Product contract: sending the next message removes the previous interrupted duration from the next presented frame, without rendering the same frame twice. When output is ready, submission generates that frame before the input callback returns; L044 permits asynchronous delivery and coalesces frames under backpressure.
- Minimal difference: queue the normal immediate input render before dispatching a focused component's key. A synchronous `renderNow()` during submission clears that queued request; ordinary keys still render on the next tick.
- User impact: the previous interrupted footer disappears with the submitted message, and the extra no-op render after Enter is avoided.
- Evidence: `tui-app.test.ts` checks every presented frame across interrupt and resend; `tui-engine-local-deltas.test.ts` checks that a synchronous input render has no second pass.
- Removal condition: the selected Pi baseline coalesces synchronous input renders while preserving immediate key rendering.

## L041: Restore chat rows after transient layout shrink

- Product contract: shrinking a transient UI region restores the conversation instead of leaving released rows blank above it. Background activity shrink with unchanged transient layout retains L038's native scrolling behavior.
- Minimal difference: components may expose the layout key of their last rendered frame. MainScreen permits L038 padding only when every root explicitly supplies the same key and no overlay was present. ChatLayout includes every transient section's height and interaction state, while SurfaceHost includes the active feature. Unknown or changed layouts use L034 reconstruction only when scrolled rows must return. Keys are captured with native render state and cleared on reset. This replaces the earlier completion-specific resize callback and full-viewport close exception.
- Evidence: application tests replay `/theme`, `/settings`, prompt-history search, image-preview dismissal, multi-line draft clearing and completion filtering. Engine tests repeatedly expand/shrink each transient section under xterm and an ED 2 clear-to-scrollback model, compare the complete viewport, verify unique history, and retain positive background-activity scroll preservation. Short documents avoid unnecessary clearing.
- Boundary: full history reconstruction retains L034's shell-scrollback tradeoff. Emulator tests do not establish native terminal or live-service acceptance.
- Timing: when an unknown or changed layout shrinks without recent user input, L047 pads first and restores the scrolled rows after the next key.
- Removal condition: the selected Pi baseline distinguishes transient UI layout shrink from ordinary background content shrink.

## L042: Preserve product mention bindings in prompt history

- Product contract: plugin labels retain their exact identities while browsing history, including restoration of the working draft.
- Minimal difference: expose a generic history-text decoder and capture/restore the existing undo extension state alongside the history draft. Plugin parsing and identity ownership stay in the product Editor.
- Evidence: `tui-plugin-mentions.test.ts` covers repeated history navigation, identical display labels with different IDs, working-draft restoration, atomic deletion and undo.
- Removal condition: the selected Pi baseline supports durable history decoding and draft extension state.

## L043: Preserve detached scrolling across layout changes

- Product contract: a detached fullscreen transcript remains detached when the viewport grows or content shrinks.
- Minimal difference: `ScrollView.updateLayout` clamps the scroll position without changing follow state. Explicit scrolling and follow requests retain their existing behavior.
- Evidence: `tui-scrollbar-interaction.test.ts` covers wheel detachment, viewport growth, footer/content shrink, temporarily fitting all content, subsequent output and re-arming with End.
- Removal condition: the selected Pi baseline preserves follow state through layout clamping.

## L044: Keep terminal backpressure off the input loop

- Product contract: slow or paused POSIX terminal output must not block input or cancellation during long Regular-mode history reconstruction.
- Minimal difference: `terminal.ts` serializes POSIX TTY output through asynchronous, bounded `fs.write` operations, preserves partial UTF-8 writes, and reports output failures through the existing stdout error path. Controls share the same queue. `tui.ts` defers subsequent frames until output drains and then renders the latest model once. Ordinary stop queues any deferred final frame before terminal cleanup; mode switches preserve their previously captured render state. Mandatory final resize replay remains ordered before cleanup.
- Host integration: the observed terminal forwards the output state; shutdown, suspension and external-editor handoff drain queued output before another process owns the terminal. Input draining starts its idle window after keyboard-disable output is sent, and editor handoff rechecks shutdown after the drain.
- Evidence: terminal-output regressions cover held/partial writes, input dispatch, control ordering, transient and permanent failures, frame coalescing, final transcript preservation, keyboard input draining and editor handoff/shutdown races; application tests cover shutdown/suspend drains. A local macOS PTY with 10,000 synthetic history rows and a paused consumer no longer blocks the input loop while reconstructing history.
- Boundary: history reconstruction still transmits the complete ordered document. A stalled connection can delay visible output; it no longer synchronously stalls the JavaScript event loop. Windows and non-TTY output retain their existing writer. Native remote SSH and native Windows acceptance remain separate.
- Removal condition: the upstream terminal writer provides ordered asynchronous POSIX TTY writes and its render scheduler observes output backpressure.

## L045: Report committed Markdown lines

- Product contract: in Regular mode a streaming reply enters native scrollback only through rows that appended text cannot change, so a table, list or other block that is still growing never rewrites history.
- Minimal difference: `components/markdown.ts` exposes `getStableLineCount()`, the number of leading lines from the latest render that come from the blocks already committed by the L026 streaming cache. Rendering output is unchanged.
- Evidence: `tui-app.test.ts` regular-mode native history cases cover widening tables, lists that become loose, long prose that streams into history during a turn, and exact history after the run.
- Removal condition: the selected Pi baseline exposes an equivalent committed-prefix contract for streaming Markdown.

## L046: Discard final rows already in native history

- Product contract: a long Regular-mode session keeps frame cost bounded without rewriting native scrollback.
- Minimal difference: `Component.takeDiscardedRows()` lets the root report leading rows it dropped since the last frame. When those rows are all above the previous viewport, `tui-main-screen.ts` drops them from its retained lines and rebases its viewport and cursor rows before diffing. Other cases keep the existing differential and reconstruction paths.
- Product boundary: the MCode Transcript only drops whole units of final rows far above the screen, so the remaining output is an exact suffix of the previous output. A later reconstruction, such as a resize, replays only the retained rows.
- Evidence: `tui-engine-local-deltas.test.ts` retained-document cases assert no scrollback erase and exact native history after trimming (failing without the rebase), and exact history without stale rows when a root reports too few or too many discarded rows.
- Removal condition: the selected Pi baseline supports discarding a committed document prefix.

## L047: Keep scrolled-up readers in place during output-driven reconstruction

- Product contract: a reader who scrolled up in native history is not moved to the top of the scrollback when the document changes without user input in a way that needs reconstruction: a transient layout region shrinks (the task list collapsing when a reply finishes), text already in native history changes or is removed, the document shrinks past the previous viewport, or a footer taller than a small screen refreshes. Tailing readers stay at the bottom, and input-driven reconstructions keep the L034 complete-viewport and unique-history behavior (#426).
- Cause: L034 clears with ED 3 and replays the document. Hosts such as xterm.js keep their scrolled state while scrollback is rebuilt, so ED 3 moves the viewport to line 0 and the replay does not move it down again. No output sequence can restore the host's scroll offset.
- Minimal difference: `tui.ts` calls a protected `onUserInput()` hook when an input chunk contains a key or paste. The chunk is split into control sequences; focus, window, cursor-position, device-attribute, device-status, kitty-flag and mode reports, OSC/DCS/APC strings, SGR mouse reports and key releases do not count, so a key sharing a chunk with reports still does. In `tui-main-screen.ts`, a shrink in an unknown or changed layout reconstructs immediately only within one second of user input, which covers input-driven closes; otherwise it uses L038 padding and marks a deferred replay. Without input in that window, the other L034 reconstructions also repaint the screen in place and mark a deferred replay: changed historical text repaints from the previous viewport origin, so growth in the same frame still enters native history, and a shrink that the padding cannot absorb (changed history, overlays, images, or no rows left in the previous viewport) paints the document's last rows. Only user input after the deferral, a settled resize replay or `stop()` runs the deferred L034 reconstruction. Resize keeps its existing delayed replay. `PI_DEBUG_REDRAW=1` log lines carry the process id, whether a reconstruction was deferred, and the first changed historical row with letters and digits masked.
- Tradeoff: after an output-driven layout shrink, blank rows can separate history from the screen until the next key. After other output-driven reconstructions, native history keeps stale, removed or duplicated rows above the screen until the next key; the screen itself is current. The one-second input window is a heuristic: a reader who scrolls up within it while a layout shrink lands can still be moved. A host that does not scroll to the bottom on input can still be moved to the top by the deferred replay. Legacy Shift+F3-style keys encoded as `CSI 1;n R` are indistinguishable from cursor position reports and do not trigger the replay. A resize that settles while the reader is scrolled up still moves the viewport to the top.
- Evidence: `tui-engine-local-deltas.test.ts` scrolls xterm up and, without input, changes a scrollback row, removes the previous run-duration note from a real append-only transcript, shrinks the document by more than a screen, and refreshes a footer taller than a five-row screen, asserting no ED 3, an unchanged scroll position and a current screen, then exact history after the next key; existing reconstruction cases deliver the next key before asserting exact history. It also scrolls xterm up, collapses the Tasks section without input, and asserts no ED 3, an unchanged scroll position and unique history, then exact history after the next key; a tailing reader stays at the bottom when output ends and the task list collapses; recent input reconstructs immediately; resize keeps its replay; each report kind and a report-only mixed chunk do not trigger the replay, while keys, Escape and a paste mixed with reports do; and the deferred replay runs before stop. The shrink and input cases emit ED 3 or fail without the change, and cursor position and mixed report chunks counted as input under whole-chunk matching. Native Windows Terminal and ConPTY acceptance remain separate.
- Product side: the transcript no longer removes one-time feedback (the run-duration note, a finished ephemeral `!` shell block, a stale run error) once settled output follows it, which was the common trigger of changed historical text; this fallback covers the remaining causes, such as the welcome header's live status on screens too small to hold the welcome surface.
- Removal condition: the selected Pi baseline preserves the host scroll position through history reconstruction, or MCode stops reconstructing native history outside user input.
