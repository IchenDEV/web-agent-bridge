/**
 * End-to-end test for Web Agent Bridge.
 *
 * Prerequisites:
 *   1. Start the A2A server:         npm run server
 *   2. Load extension in Chrome:     chrome://extensions -> developer mode -> load unpacked -> extension/
 *   3. Open https://www.doubao.com/chat/ and ensure you are logged in
 *   4. Run this script:              npm run test:e2e
 */

import { A2AClient } from "@a2a-js/sdk/client";
import { randomUUID } from "crypto";

const SERVER_URL = process.env.A2A_URL || "http://127.0.0.1:3000/a2a";
const TEST_MESSAGE = process.env.TEST_MSG || "1+1等于几？请只回答数字。";

async function main() {
  console.log("═══════════════════════════════════════");
  console.log(" Web Agent Bridge — E2E Test");
  console.log("═══════════════════════════════════════\n");

  // Step 1: Check server health
  console.log("[1/4] Checking server health...");
  const healthRes = await fetch("http://127.0.0.1:3000/health");
  const health = (await healthRes.json()) as { ok: boolean; extensionConnected: boolean };
  console.log("  Health:", health);

  if (!health.ok) {
    console.error("  ✗ Server is not healthy. Start it with: npm run server");
    process.exit(1);
  }
  if (!health.extensionConnected) {
    console.error(
      "  ✗ No browser extension connected.\n" +
      "    1. Load the extension from extension/ in chrome://extensions\n" +
      "    2. Open https://www.doubao.com/chat/\n" +
      "    3. Re-run this test"
    );
    process.exit(1);
  }
  console.log("  ✓ Server healthy, extension connected\n");

  // Step 2: Discover agent card
  console.log("[2/4] Discovering Agent Card...");
  const client = new A2AClient(SERVER_URL);
  const card = await client.getAgentCard();
  console.log(`  Agent: ${card.name}`);
  console.log(`  Skills: ${card.skills?.map((s) => s.name).join(", ")}`);
  console.log("  ✓ Agent Card loaded\n");

  // Step 3: Send message via A2A protocol
  console.log(`[3/4] Sending message: "${TEST_MESSAGE}"`);
  const messageId = randomUUID();
  const contextId = randomUUID();

  const response = await client.sendMessage({
    message: {
      role: "user",
      kind: "message",
      messageId,
      parts: [{ kind: "text", text: TEST_MESSAGE }],
      contextId,
    },
  });

  console.log("  Raw response type:", typeof response);
  console.log("  Response:", JSON.stringify(response, null, 2).slice(0, 500));

  // Step 4: Validate response
  console.log("\n[4/4] Validating response...");

  if ("error" in response) {
    console.error("  ✗ Got JSON-RPC error:", (response as any).error);
    process.exit(1);
  }

  const result = (response as any).result;
  if (!result) {
    console.error("  ✗ No result in response");
    process.exit(1);
  }

  // result can be a Task or Message
  let responseText = "";

  if (result.artifacts && result.artifacts.length > 0) {
    // Task with artifacts
    for (const artifact of result.artifacts) {
      for (const part of artifact.parts || []) {
        if (part.kind === "text") {
          responseText += part.text;
        }
      }
    }
    console.log(`  Task state: ${result.status?.state}`);
  } else if (result.parts) {
    // Direct message response
    for (const part of result.parts) {
      if (part.kind === "text") {
        responseText += part.text;
      }
    }
  }

  console.log(`  AI Response: "${responseText.slice(0, 200)}"`);

  if (responseText.length === 0) {
    console.error("  ✗ Empty response from AI");
    process.exit(1);
  }

  console.log("  ✓ Got non-empty response from Doubao!\n");
  console.log("═══════════════════════════════════════");
  console.log(" ✓ E2E TEST PASSED");
  console.log("═══════════════════════════════════════");
}

main().catch((err) => {
  console.error("\n✗ E2E test failed:", err);
  process.exit(1);
});
