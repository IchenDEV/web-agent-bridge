import type { BrowserAdapter } from "./base.js";
import { chatgptAdapter } from "./chatgpt.js";
import { doubaoAdapter } from "./doubao.js";
import { geminiAdapter } from "./gemini.js";
import { kimiAdapter } from "./kimi.js";
import { perplexityAdapter } from "./perplexity.js";
import { qianwenAdapter } from "./qianwen.js";
import { workbuddyAdapter } from "./workbuddy.js";

export type { BrowserAdapter } from "./base.js";

export const ADAPTERS: BrowserAdapter[] = [
  doubaoAdapter,
  workbuddyAdapter,
  chatgptAdapter,
  geminiAdapter,
  perplexityAdapter,
  kimiAdapter,
  qianwenAdapter,
];

export function getAdapter(name: string): BrowserAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.name === name);
}

export function adapterNames(): string {
  return ADAPTERS.map((adapter) => adapter.name).join(", ");
}
