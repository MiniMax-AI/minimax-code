import { describe, expect, it } from "vitest";
import { formatTokensPerSecond } from "../../../../../src/tui/rendering/output-rate.js";
import { TuiTurnOutputRate } from "../../../../../src/tui/controller/projection/turn-output-rate.js";

describe("TuiTurnOutputRate", () => {
  it("aggregates completed model responses without counting tool wall-clock time", () => {
    const rate = new TuiTurnOutputRate();
    rate.beginTurn("turn-1");

    rate.apply("turn-1", {
      type: "delta",
      messageId: "message-1",
      content: "one",
      timestamp: 1_000,
    });
    rate.apply("turn-1", {
      type: "delta",
      messageId: "message-1",
      finish: true,
      timestamp: 3_000,
    });
    expect(
      rate.apply("turn-1", {
        type: "message",
        message: {
          id: "message-1",
          role: "assistant",
          timestamp: 8_000,
          usage: {
            outputTokens: 100,
            requestDurationMs: 7_000,
            decodeDurationMs: 2_000,
          },
        },
      }),
    ).toBe(50);

    rate.apply("turn-1", {
      type: "delta",
      messageId: "message-2",
      thinking: "two",
      timestamp: 10_000,
    });
    rate.apply("turn-1", {
      type: "delta",
      messageId: "message-2",
      finish: true,
      timestamp: 12_000,
    });
    expect(
      rate.apply("turn-1", {
        type: "message",
        message: {
          id: "message-2",
          role: "assistant",
          usage: {
            outputTokens: 152,
            requestDurationMs: 7_000,
            decodeDurationMs: 2_000,
          },
        },
      }),
    ).toBe(63);
  });

  it("uses runtime decode duration when stream chunks arrive in a compressed window", () => {
    const rate = new TuiTurnOutputRate();
    rate.beginTurn("turn-backlogged");

    rate.apply("turn-backlogged", {
      type: "delta",
      messageId: "message-backlogged",
      content: "late batch",
      timestamp: 20_900,
    });
    rate.apply("turn-backlogged", {
      type: "delta",
      messageId: "message-backlogged",
      finish: true,
      timestamp: 21_000,
    });

    expect(
      rate.apply("turn-backlogged", {
        type: "message",
        message: {
          id: "message-backlogged",
          role: "assistant",
          usage: {
            outputTokens: 1_000,
            requestDurationMs: 30_000,
            decodeDurationMs: 20_000,
          },
        },
      }),
    ).toBe(50);
    expect(rate.currentEstimated()).toBe(false);
  });

  it("does not report a rate without authoritative output tokens and positive duration", () => {
    const rate = new TuiTurnOutputRate();
    rate.beginTurn("turn-1");

    expect(
      rate.apply("turn-1", {
        type: "message",
        message: {
          id: "message-1",
          role: "assistant",
          usage: { outputTokens: 50 },
        },
      }),
    ).toBeUndefined();
    rate.apply("turn-1", {
      type: "delta",
      messageId: "message-2",
      content: "one",
      timestamp: 1_000,
    });
    rate.apply("turn-1", {
      type: "delta",
      messageId: "message-2",
      finish: true,
      timestamp: 1_000,
    });
    expect(
      rate.apply("turn-1", {
        type: "message",
        message: {
          id: "message-2",
          role: "assistant",
          usage: { outputTokens: 50 },
        },
      }),
    ).toBeUndefined();
  });

  it("does not estimate from deltas and retains confirmed samples during tool waits and replays", () => {
    const rate = new TuiTurnOutputRate();
    rate.beginTurn("turn-1");
    rate.apply("turn-1", {
      type: "delta",
      messageId: "m",
      content: "hello",
      timestamp: 1_000,
    });
    rate.apply("turn-1", {
      type: "delta",
      messageId: "m",
      content: " world",
      timestamp: 2_000,
    });
    expect(rate.finalize()).toBeUndefined();
    const event = {
      type: "message" as const,
      message: {
        id: "m",
        role: "assistant" as const,
        usage: { outputTokens: 100, decodeDurationMs: 2_000 },
      },
    };
    expect(rate.apply("turn-1", event)).toBe(50);
    expect(rate.apply("turn-1", event)).toBe(50);
    expect(
      rate.apply("turn-1", {
        type: "delta",
        messageId: "next",
        thinking: "thinking",
        timestamp: 30_000,
      }),
    ).toBe(50);
    expect(
      rate.apply("turn-1", {
        type: "message",
        message: {
          id: "legacy",
          role: "assistant",
          usage: { outputTokens: 900, requestDurationMs: 1_000 },
        },
      }),
    ).toBe(50);
    expect(rate.currentEstimated()).toBe(false);
  });

  it("includes measured zero-duration and zero-output samples in the weighted fold", () => {
    const rate = new TuiTurnOutputRate();
    rate.beginTurn("turn-1");
    const apply = (
      id: string,
      outputTokens: number,
      decodeDurationMs: number,
    ) =>
      rate.apply("turn-1", {
        type: "message",
        message: {
          id,
          role: "assistant",
          usage: { outputTokens, decodeDurationMs },
        },
      });
    expect(apply("instant", 100, 0)).toBeUndefined();
    expect(apply("normal", 200, 4_000)).toBe(75);
    expect(apply("zero-output", 0, 2_000)).toBe(50);
    for (const invalid of [-1, NaN, Infinity]) {
      expect(apply("invalid-time", 100, invalid)).toBe(50);
      expect(apply("invalid-usage", invalid, 1_000)).toBe(50);
    }
    rate.reset();
    expect(rate.finalize()).toBeUndefined();
  });

  it("ignores late events from an older turn after reset", () => {
    const rate = new TuiTurnOutputRate();
    rate.beginTurn("turn-old");
    rate.beginTurn("turn-new");

    expect(
      rate.apply("turn-old", {
        type: "message",
        message: {
          id: "message-old",
          role: "assistant",
          usage: { outputTokens: 100 },
        },
      }),
    ).toBeUndefined();
    expect(rate.current()).toBeUndefined();
  });
});

it.each([
  [0.5, "0.5"],
  [9.94, "9.9"],
  [10.4, "10"],
  [63.5, "64"],
])("formats %s token/s as %s", (speed, display) => {
  expect(formatTokensPerSecond(Number(speed))).toBe(display);
});
