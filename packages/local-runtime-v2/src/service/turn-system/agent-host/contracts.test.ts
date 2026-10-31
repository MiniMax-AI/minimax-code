import { describe, expect, it } from "vitest";

import {
  parseBackgroundTaskDeliveryOrigin,
  parseBackgroundTaskOriginMetadata,
} from "./contracts.js";

describe("parseBackgroundTaskDeliveryOrigin", () => {
  const execution = {
    kind: "background-task-terminal" as const,
    taskIds: ["task-1"],
    observedTerminalCount: 2,
  };
  const displaySnapshot = [{ taskId: "task-1", name: "Build", status: "succeeded" }];

  it("keeps the execution origin when the delivery carries a Bash display snapshot", () => {
    expect(
      parseBackgroundTaskDeliveryOrigin({ ...execution, tasks: displaySnapshot }),
    ).toEqual(execution);
  });

  it("reads a plain execution origin exactly like the metadata parser", () => {
    expect(parseBackgroundTaskDeliveryOrigin(execution)).toEqual(
      parseBackgroundTaskOriginMetadata(execution),
    );
    expect(
      parseBackgroundTaskDeliveryOrigin({
        kind: "background-task-terminal",
        taskIds: ["task-1"],
      }),
    ).toEqual({ kind: "background-task-terminal", taskIds: ["task-1"] });
  });

  it("still refuses an origin that is not background-task delivery metadata", () => {
    for (const value of [
      undefined,
      null,
      "background-task-terminal",
      { kind: "user" },
      { kind: "background-task-terminal", taskIds: [] },
      { kind: "background-task-terminal", taskIds: [""] },
      { kind: "background-task-terminal", taskIds: ["task-1"], extra: 1 },
    ]) {
      expect(parseBackgroundTaskDeliveryOrigin(value)).toBeUndefined();
    }
  });
});
