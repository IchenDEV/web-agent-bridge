/**
 * Relaunch Dia with --remote-debugging-port so Playwright can attach
 * to the already-logged-in Doubao tab.
 *
 *   WAB_CDP_PORT=9222 node --import tsx server/cdp-attach-dia.ts
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { diaAppPath, diaUserDataDir, resolveCdpEndpoint } from "./cdp-discover.js";

const port = Number(process.env.WAB_CDP_PORT || 9222);
const existing = await resolveCdpEndpoint("auto");
if (existing) {
  console.error(`CDP already available at ${existing.endpoint} (${existing.source})`);
  console.log(existing.endpoint);
  process.exit(0);
}

console.error(`Quitting Dia so it can reopen with --remote-debugging-port=${port}...`);
console.error(`Profile: ${diaUserDataDir()}`);

await new Promise<void>((resolve) => {
  const child = spawn("osascript", ["-e", 'tell application "Dia" to quit'], {
    stdio: "ignore",
  });
  child.on("exit", () => resolve());
});
await delay(2000);

const diaBin = `${diaAppPath()}/Contents/MacOS/Dia`;
console.error(`Launching: ${diaBin} --remote-debugging-port=${port}`);
spawn(diaBin, [`--remote-debugging-port=${port}`], {
  detached: true,
  stdio: "ignore",
}).unref();

const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  const found = await resolveCdpEndpoint(`http://127.0.0.1:${port}`);
  if (found) {
    console.error(`✓ Dia CDP ready: ${found.endpoint}`);
    // Give pages a moment to restore
    await delay(2500);
    try {
      const list = await fetch(`${found.endpoint}/json/list`, { signal: AbortSignal.timeout(2000) });
      const tabs = (await list.json()) as Array<{ url?: string; title?: string }>;
      const doubao = tabs.filter((t) => t.url?.includes("doubao.com"));
      console.error(`  tabs: ${tabs.length}, doubao: ${doubao.length}`);
      for (const t of doubao.slice(0, 5)) {
        console.error(`    • ${t.title || "(no title)"} — ${t.url}`);
      }
    } catch {
      /* ignore */
    }
    console.log(found.endpoint);
    process.exit(0);
  }
  await delay(500);
}

console.error("✗ Timed out waiting for Dia CDP. Open Dia manually with:");
console.error(`  open -a Dia --args --remote-debugging-port=${port}`);
process.exit(1);
