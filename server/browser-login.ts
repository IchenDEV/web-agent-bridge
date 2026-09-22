/**
 * Open a headed browser so the user can log in to an AI agent.
 * Saves cookies to storage-state.json for `wab server --browser`.
 *
 *   WAB_LOGIN_AGENT=doubao|chatgpt|gemini|workbuddy|perplexity|kimi|qianwen   (optional, default: all)
 */
import { mkdirSync } from "node:fs";
import readline from "node:readline";
import { ADAPTERS, adapterNames, getAdapter } from "./browser-adapters/index.js";
import { storageStatePath, userDataDir } from "./browser-backend.js";

const requested = process.env.WAB_LOGIN_AGENT || "";
const targets = requested
  ? (() => {
      const adapter = getAdapter(requested);
      if (!adapter) {
        console.error(`Unknown agent "${requested}". Available: ${adapterNames()}`);
        process.exit(1);
      }
      return [adapter];
    })()
  : ADAPTERS;

mkdirSync(userDataDir(), { recursive: true });

const { chromium } = await import("playwright");
const browser = await chromium.launch({
  headless: false,
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext();

console.error(`Storage will be saved to: ${storageStatePath()}`);
console.error("Log in to the opened page(s), then press Enter here to save the session.");

for (const adapter of targets) {
  const page = await context.newPage();
  await page.goto(adapter.url, { waitUntil: "domcontentloaded" });
  console.error(`  opened ${adapter.name}: ${adapter.url}`);
}

await new Promise<void>((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  rl.question("", () => {
    rl.close();
    resolve();
  });
});

await context.storageState({ path: storageStatePath() });
await browser.close();
console.error(`Session saved to ${storageStatePath()}`);
