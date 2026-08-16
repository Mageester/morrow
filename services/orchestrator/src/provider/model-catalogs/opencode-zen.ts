import { model } from "./common.js";

export const models = [
  model("opencode-zen", "deepseek-v4-flash-free", "DeepSeek V4 Flash (free, via OpenCode Zen)", { contextWindow: 200_000, speed: "fast", cost: "low" }),
] as const;
