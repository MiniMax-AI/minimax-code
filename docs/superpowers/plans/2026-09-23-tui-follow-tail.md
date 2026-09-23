# TUI Follow-Tail Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve a detached TUI transcript position during streaming while re-arming follow-tail for explicit submission and Session navigation.

**Architecture:** Keep `ScrollView.isFollowingEnd` as the single follow-tail state. Make `TuiChatLayout.followBottom()` conditional on that state, expose `forceFollowBottom()` for explicit user/Session intent, and wire only submission and Session transitions to the force path.

**Tech Stack:** TypeScript, Vitest, MiniMax Code TUI, `ScrollView`, `TuiChatLayout`, `TuiAltScreen`.

## Global Constraints

- Support Node.js `>=22.19 <23 || >=24.2 <27` and use the repository-pinned `pnpm@9.12.0` workflow.
- Reuse `ScrollView.isFollowingEnd`; do not add a second follow-tail state.
- Do not add a `followTail` configuration key or a "new output below" indicator.
- Guard ordinary assistant, bash, tool, and interaction content updates.
- Force-follow only for user submission, `/new`, and Session activation/switching.
- Preserve the existing `End` / `tui.altScreen.bottom` behavior.
- Use synthetic transcripts and temporary runtime data in tests.
- Keep new documentation and commit messages in English.
- Treat this as a streaming/rendering-path change and add the `perf:full` label to the pull request.

---

## File Structure

- Modify `packages/tui/src/tui/shell/chat-layout.ts`: own guarded content-follow and explicit force-follow behavior.
- Modify `packages/tui/src/tui/app.ts`: route user submission and Session-transition callbacks to force-follow; leave content callbacks guarded.
- Modify `packages/tui/test/unit/tui-scrollbar-interaction.test.ts`: verify observable detached-position, re-arm, and force-follow behavior through the real layout.
- Modify `packages/tui/test/unit/tui-app.test.ts`: verify application wiring invokes force-follow for submission and Session transitions.
- Modify `release/public-source.json`: regenerate after adding this public implementation-plan document.

### Task 1: Preserve detached transcript position

**Files:**
- Modify: `packages/tui/test/unit/tui-scrollbar-interaction.test.ts:22-36,279-304`
- Modify: `packages/tui/src/tui/shell/chat-layout.ts:142-144`

**Interfaces:**
- Consumes: `ScrollView.isFollowingEnd: boolean` and `ScrollView.scrollToEnd(): void` from `packages/tui/src/tui/engine/components/scroll-view.ts`.
- Produces: `TuiChatLayout.followBottom(): void` for conditional content updates and `TuiChatLayout.forceFollowBottom(): void` for explicit intent.

- [ ] **Step 1: Make the synthetic transcript appendable**

Add this method to `ScrollableLines`:

```ts
  appendLine(line: string): void {
    this.lines.push(line);
  }
```

- [ ] **Step 2: Write the failing observable behavior test**

Add the test beside the existing actual-chat-layout scrollbar test:

```ts
  it("preserves a detached transcript position until follow-tail is explicitly re-armed", async () => {
    const terminal = new VirtualTerminal(40, 15);
    const empty = { render: () => [], invalidate() {} };
    const content = new ScrollableLines(CONTENT_LINES);
    const layout = new TuiChatLayout(terminal, {
      surface: () => "conversation",
      transcript: content,
      welcome: empty,
      interaction: { ...empty, isActive: () => false },
      activity: empty,
      followUp: empty,
      composer: { render: () => ["composer"], invalidate() {} },
      status: empty,
    });
    const tui = new TuiAltScreen(terminal);
    screens.push(tui);
    tui.setLayoutRoot(layout.fullscreenLayoutRoot);
    tui.start();
    await terminal.waitForRender();

    expect(viewportText(terminal)).toContain("line-59");

    terminal.sendInput(sgrPress(37, 0));
    terminal.sendInput(sgrRelease(37, 0));
    await terminal.waitForRender();
    expect(viewportText(terminal)).toContain("line-00");

    content.appendLine("line-60");
    layout.followBottom();
    tui.requestRender();
    await terminal.waitForRender();
    expect(viewportText(terminal)).toContain("line-00");
    expect(viewportText(terminal)).not.toContain("line-60");

    layout.forceFollowBottom();
    tui.requestRender();
    await terminal.waitForRender();
    expect(viewportText(terminal)).toContain("line-60");

    content.appendLine("line-61");
    layout.followBottom();
    tui.requestRender();
    await terminal.waitForRender();
    expect(viewportText(terminal)).toContain("line-61");
  });
```

- [ ] **Step 3: Install the isolated worktree dependencies**

Run:

```bash
pnpm install --frozen-lockfile
```

Expected: install exits successfully and creates `node_modules` in the worktree without changing the lockfile.

- [ ] **Step 4: Run the focused test and verify the current failure**

Run:

```bash
pnpm exec vitest run --config vitest.oss.config.mjs packages/tui/test/unit/tui-scrollbar-interaction.test.ts
```

Expected: FAIL because the current unconditional `followBottom()` moves the detached viewport to `line-60`; the new `forceFollowBottom()` method is not yet present.

- [ ] **Step 5: Implement the minimal layout behavior**

Replace the current method with:

```ts
  followBottom(): void {
    if (this.fullscreenBodyViewport.isFollowingEnd) {
      this.fullscreenBodyViewport.scrollToEnd();
    }
  }

  forceFollowBottom(): void {
    this.fullscreenBodyViewport.scrollToEnd();
  }
```

- [ ] **Step 6: Run the focused test and verify the fix**

Run:

```bash
pnpm exec vitest run --config vitest.oss.config.mjs packages/tui/test/unit/tui-scrollbar-interaction.test.ts
```

Expected: PASS, including the existing mouse, wheel, scrollbar, and fullscreen-layout tests.

- [ ] **Step 7: Commit the behavioral fix**

```bash
git add packages/tui/src/tui/shell/chat-layout.ts packages/tui/test/unit/tui-scrollbar-interaction.test.ts
git -c user.name='hetaoBackend' -c user.email='hetao7@pku.edu.cn' commit -m 'fix(tui): preserve detached transcript position'
```

### Task 2: Force-follow explicit submission and Session intent

**Files:**
- Modify: `packages/tui/test/unit/tui-app.test.ts:15,501-548` (imports and application lifecycle tests)
- Modify: `packages/tui/src/tui/app.ts:128-131,445-450`

**Interfaces:**
- Consumes: `TuiChatLayout.forceFollowBottom(): void` from Task 1.
- Produces: application wiring where `onUserSubmissionProjected` and `TuiSessionFlow.followBottom` call `forceFollowBottom()`, while `followChatBottom` and interaction refreshes continue calling `followBottom()`.

- [ ] **Step 1: Add the failing application-wiring test**

Import the layout class:

```ts
import { TuiChatLayout } from "../../src/tui/shell/chat-layout.js";
```

Add an application lifecycle test:

```ts
  it("force-follows user submissions and Session transitions", async () => {
    const forceFollowBottom = vi.spyOn(TuiChatLayout.prototype, "forceFollowBottom");
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal: new FakeTerminal(),
      version: "test",
      workspaceDir: "/workspace",
    });
    app.start();

    try {
      await app.ready;
      await app.openSession("session-1");

      forceFollowBottom.mockClear();
      await app.submit("Continue with the next step");
      await vi.waitFor(() => expect(forceFollowBottom).toHaveBeenCalled());

      forceFollowBottom.mockClear();
      await app.openSession("session-2");
      expect(forceFollowBottom).toHaveBeenCalled();
    } finally {
      await app.stop();
      forceFollowBottom.mockRestore();
    }
  });
```

- [ ] **Step 2: Run the app test and verify the wiring failure**

Run:

```bash
pnpm exec vitest run --config vitest.oss.config.mjs packages/tui/test/unit/tui-app.test.ts
```

Expected: FAIL because the application still calls `layout.followBottom()` for both explicit-intent paths.

- [ ] **Step 3: Route user submission to force-follow**

In `onUserSubmissionProjected`, replace:

```ts
      followChatBottom();
```

with:

```ts
      layout.forceFollowBottom();
```

Leave the bash-flow callback unchanged so ordinary tool output remains guarded.

- [ ] **Step 4: Route Session transitions to force-follow**

In the `TuiSessionFlow` options, replace:

```ts
    followBottom: () => layout.followBottom(),
```

with:

```ts
    followBottom: () => layout.forceFollowBottom(),
```

This callback is used by both `startNewSession()` and `activateSessionById()`.

- [ ] **Step 5: Run focused app and viewport tests**

Run:

```bash
pnpm exec vitest run --config vitest.oss.config.mjs packages/tui/test/unit/tui-app.test.ts packages/tui/test/unit/tui-scrollbar-interaction.test.ts
```

Expected: PASS with no snapshot, lifecycle, submission, or scroll regression.

- [ ] **Step 6: Run type checking and source checks**

Run:

```bash
pnpm typecheck
pnpm check:source
git diff --check
```

Expected: all commands exit successfully; source inventory reports the committed spec and plan; no whitespace errors.

- [ ] **Step 7: Commit the application wiring**

```bash
git add packages/tui/src/tui/app.ts packages/tui/test/unit/tui-app.test.ts
git -c user.name='hetaoBackend' -c user.email='hetao7@pku.edu.cn' commit -m 'fix(tui): re-arm follow-tail on explicit navigation'
```

### Task 3: Verify and prepare the pull request

**Files:**
- Verify: all changed files
- Verify: `release/public-source.json`

**Interfaces:**
- Consumes: the complete implementation from Tasks 1 and 2.
- Produces: a verified `fix/tui-follow-tail` branch and a pull request that fixes issue #320.

- [ ] **Step 1: Verify the committed public source inventory**

Run:

```bash
pnpm check:source
git status --short
```

Expected: the approved spec and implementation-plan paths are recorded; no untracked or modified deliverable file remains before full verification.

- [ ] **Step 2: Run the full applicable verification profile**

Run:

```bash
pnpm verify
```

Expected: PASS for every macOS-applicable gate. Report any intentional platform skips and any live-service or Windows boundary that was not exercised.

- [ ] **Step 3: Verify commit identity and branch state**

Run:

```bash
git log --format=fuller origin/main..HEAD
git status --short --branch
```

Expected: every new commit uses `hetaoBackend <hetao7@pku.edu.cn>` as both author and committer; the tracked working tree is clean.

- [ ] **Step 4: Obtain confirmation immediately before publishing**

State that the next actions push `fix/tui-follow-tail` to `origin` and create a public GitHub pull request containing the issue link, user-visible behavior, tests actually run, untested platform boundaries, and the `perf:full` label.

- [ ] **Step 5: Push the feature branch**

After explicit confirmation:

```bash
git push -u origin fix/tui-follow-tail
```

Expected: the remote branch is created without modifying `main`.

- [ ] **Step 6: Create the pull request**

After the push succeeds:

```bash
PR_BODY=$(cat <<'EOF'
## Summary

- preserve a user-scrolled transcript position while assistant and tool output continues
- keep automatic follow-tail active when the viewport is already at the bottom
- force-follow after an explicit user submission or Session transition
- reuse the existing `ScrollView` follow-end state without adding configuration or UI

## Validation

- `pnpm exec vitest run --config vitest.oss.config.mjs packages/tui/test/unit/tui-app.test.ts packages/tui/test/unit/tui-scrollbar-interaction.test.ts`
- `pnpm typecheck`
- `pnpm check:source`
- `pnpm verify`

## Boundaries

- report the exact `pnpm verify` result, including intentional skips
- report that live Windows acceptance was not run unless it was actually run

Closes #320
EOF
)
gh pr create \
  --base main \
  --head fix/tui-follow-tail \
  --title 'fix(tui): preserve transcript position while reading history' \
  --body "$PR_BODY" \
  --label 'perf:full'
```

- [ ] **Step 7: Verify the created pull request**

Run:

```bash
gh pr view --json number,title,url,baseRefName,headRefName,labels,state
gh pr checks
```

Expected: the pull request targets `main`, comes from `fix/tui-follow-tail`, has the `perf:full` label, and its checks are queued or passing without an unexpected skip.
