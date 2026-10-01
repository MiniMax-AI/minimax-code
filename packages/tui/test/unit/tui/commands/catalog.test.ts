import { describe, expect, it, vi } from "vitest";
import {
  createTuiCommandCatalog,
  type TuiCommandContext,
} from "../../../../src/tui/commands/catalog.js";

describe("MiniMax Code TUI command catalog in side conversations", () => {
  const sideContext: TuiCommandContext = {
    hasSession: true,
    hasParentSession: true,
    managedTokenPresent: true,
    queueEnabled: true,
    hasLiveRun: false,
    hasPendingInteraction: false,
    queuedCount: 0,
    canRetry: false,
    sideMode: true,
  };

  it("lets a side conversation run diagnostics and send feedback in place", async () => {
    const doctorHandler = vi.fn();
    const feedbackHandler = vi.fn();
    const quitHandler = vi.fn();
    const catalog = createTuiCommandCatalog(
      [],
      { doctor: doctorHandler, feedback: feedbackHandler, quit: quitHandler },
      () => sideContext,
    );

    await expect(catalog.dispatch("/doctor")).resolves.toMatchObject({ status: "handled" });
    await expect(catalog.dispatch("/feedback side reply failed")).resolves.toMatchObject({
      status: "handled",
    });
    expect(doctorHandler).toHaveBeenCalledOnce();
    expect(feedbackHandler).toHaveBeenCalledOnce();

    // /quit stays blocked: leaving from the side view would abort only the
    // side Turn and skip side cleanup, unlike quitting from the main view.
    await expect(catalog.dispatch("/quit")).resolves.toMatchObject({ status: "unavailable" });
    expect(quitHandler).not.toHaveBeenCalled();
  });

  it("keeps commands that mutate Sessions unavailable in a side conversation", async () => {
    const sessionsHandler = vi.fn();
    const catalog = createTuiCommandCatalog([], { sessions: sessionsHandler }, () => sideContext);

    await expect(catalog.dispatch("/sessions")).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("unavailable in side conversations"),
    });
    expect(sessionsHandler).not.toHaveBeenCalled();
  });
});
