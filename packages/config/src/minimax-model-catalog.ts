import type { ModelCapabilitiesConfig, ModelConfig } from "./config.js";

// Shared first-run catalog; an existing remote snapshot remains authoritative.
const MINIMAX_M3_FILE_API_CAPABILITIES: ModelCapabilitiesConfig = {
  support_files_api: true,
  files_api_upload_endpoint: "/v1/files/upload",
  max_image_bytes_inline: 10_485_760,
  max_video_bytes_inline: 52_428_800,
  max_request_body_bytes: 67_108_864,
  max_attachments_count: 4,
};

export const MINIMAX_MODELS: Record<string, ModelConfig> = {
  "MiniMax-M3": {
    name: "MiniMax-M3",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text", "image", "video"], output: ["text"] },
    limit: { context: 512000, output: 128000 },
    contextWindowOptions: [512000, 1000000],
    contextWindowOptionHints: { "1000000": "higher_usage" },
    options: { reasoningSummary: "auto" },
    thinking_config: { mode: "switchable", default_value: "true" },
    variants: {
      "none-thinking": { thinking: { type: "disabled" } },
      thinking: { thinking: { type: "adaptive" } },
    },
    capabilities: MINIMAX_M3_FILE_API_CAPABILITIES,
  },
  "MiniMax-M3.1-Flash-Preview": {
    name: "M3.1-Flash-Preview",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text", "image", "video"], output: ["text"] },
    limit: { context: 512000, output: 128000 },
    contextWindowOptions: [512000, 1000000],
    contextWindowOptionHints: { "1000000": "higher_usage" },
    options: { reasoningSummary: "auto" },
    thinking: {
      effortOptions: ["default", "low", "medium", "high", "xhigh", "max"],
      defaultEffort: "default",
    },
    thinking_config: { mode: "forced_on" },
    variants: {
      "none-thinking": { thinking: { type: "disabled" } },
      thinking: { thinking: { type: "adaptive" } },
    },
    capabilities: MINIMAX_M3_FILE_API_CAPABILITIES,
  },
  "MiniMax-M2.7-highspeed": {
    name: "MiniMax-M2.7-highspeed",
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 200000, output: 128000 },
  },
  "MiniMax-M2.7": {
    name: "MiniMax-M2.7",
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 200000, output: 128000 },
  },
};
