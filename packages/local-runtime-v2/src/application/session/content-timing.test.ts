import { expect, it } from "vitest";
import { toSessionMessageView } from "./content-application.js";

it.each(["request_duration_ms", "decode_duration_ms"])(
  "preserves %s in history without context usage",
  (field) => {
    const usage = { output_tokens: 200, [field]: 4_000 };
    const result = toSessionMessageView({
      msg_id: "message-test",
      role: "assistant",
      msg_content: "done",
      usage,
    });
    expect(JSON.parse(result.rawJson ?? "{}").usage).toEqual(usage);
  },
);
