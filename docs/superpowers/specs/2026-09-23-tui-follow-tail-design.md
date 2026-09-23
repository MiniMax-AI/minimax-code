# TUI Follow-Tail Preservation Design

Date: 2026-09-23
Issue: https://github.com/MiniMax-AI/minimax-code/issues/320

## Summary

The chat TUI currently scrolls to the transcript bottom whenever assistant output, tool output, or an interaction update changes. This overrides a user's deliberate attempt to read earlier output. The change makes automatic scrolling conditional on the existing `ScrollView` follow-end state, while preserving explicit bottom navigation and intentionally re-arming follow-tail after a submission or Session transition.

## Problem

`TuiChatLayout.followBottom()` currently calls `ScrollView.scrollToEnd()` unconditionally. `ScrollView` already tracks whether it is following the end, but the chat layout bypasses that state for every update. The result is that a user who scrolls upward is pulled back to the newest output as soon as the next token or tool result arrives.

## Goals

- Preserve the user's reading position while output continues to stream or tool output changes.
- Continue following new output while the viewport is at the bottom.
- Re-arm follow-tail when the user explicitly navigates to the bottom.
- Re-arm follow-tail after the user submits a message.
- Re-arm follow-tail when creating or activating a Session.
- Reuse the existing `ScrollView.isFollowingEnd` state without introducing a second source of truth.

## Non-goals

- Do not add a `followTail` configuration setting in this change.
- Do not add a "new output below" indicator or overlay.
- Do not change `ScrollView` scrollbar behavior, search behavior, or general keyboard bindings.
- Do not change prompt history or queued-message restoration behavior.

## Design

### Conditional content follow

`TuiChatLayout.followBottom()` will inspect the primary transcript viewport's existing `isFollowingEnd` state. It will call `scrollToEnd()` only when the viewport is still following the end. This keeps the method safe for repeated content-update callbacks without duplicating user-scroll state in `TuiChatLayout`.

The ordinary guarded path covers:

- assistant streaming and transcript updates;
- bash and tool output;
- interaction or composition refreshes that can change visible content;
- any future content-update caller that uses the default method.

### Explicit force-follow operations

`TuiChatLayout` exposes an explicit `forceFollowBottom()` method. It calls `scrollToEnd()` regardless of the prior follow-end state.

Force-follow applies only to user or Session intent:

1. the user submits a new message;
2. `/new` resets the current Session;
3. the user activates or switches Sessions.

The application will pass the force-follow callback only to these explicit intent paths. Session-flow callbacks used for reset and activation will always force the new Session's transcript to the bottom.

### Re-arming through existing navigation

Scrolling back to the bottom, including the existing `tui.altScreen.bottom` / `End` path, continues to call `ScrollView.scrollToEnd()`. That operation already sets `isFollowingEnd` to true, so no separate toggle state or synchronization callback is required.

When the content is shorter than the viewport, `ScrollView` continues to consider itself at the end, preserving the current compact-transcript behavior.

## Data flow

1. The user scrolls upward; `ScrollView.isFollowingEnd` becomes false.
2. Assistant, bash, tool, or interaction content changes.
3. The existing update callback invokes the guarded `followBottom()` path.
4. `TuiChatLayout` sees `isFollowingEnd === false` and leaves `scrollTop` unchanged.
5. The next layout pass updates the content height while preserving the current position.
6. The user presses `End` or navigates to the bottom; `ScrollView.scrollToEnd()` sets `isFollowingEnd` to true.
7. Subsequent content changes once again follow the end.

Submission and Session-transition flows instead invoke the force-follow callback before rendering the new state, so the viewport is always at the bottom for the new user or Session context.

## Edge cases

- A user who scrolls up during streaming remains detached until returning to the bottom.
- Content growth cannot re-arm follow-tail by itself.
- Content shrink continues to use the existing `ScrollView` clamping behavior.
- Empty or short transcripts remain logically at the end.
- Multiple updates before a render remain safe because the follow decision reads the current viewport state.
- A Session transition is not treated as ordinary streaming; it always shows the new Session's bottom.

## Testing

Focused tests will cover the `TuiChatLayout` and existing scroll/viewport regression surfaces:

- while following the end, content growth continues to move to the newest output;
- after scrolling upward, content growth preserves `scrollTop`;
- after returning to the bottom, later content growth follows again;
- the force-follow path moves to the end after the user has scrolled upward;
- force-follow is used for user submission, Session reset, and Session activation call sites;
- ordinary bash, tool, and interaction update call sites use the guarded path;
- existing `End` / `tui.altScreen.bottom` behavior remains unchanged.

Tests will use synthetic transcripts and temporary runtime data only.

## Acceptance criteria

- Scrolling upward to read earlier output is not overridden by new assistant or tool output.
- A viewport already at the bottom continues to follow streaming output.
- `End` or the existing bottom-navigation binding re-arms follow-tail.
- Submitting a message returns to the bottom and resumes following.
- Creating, resetting, or switching Sessions shows the bottom of the selected Session.
- No new configuration key, status indicator, or duplicate follow state is introduced.
