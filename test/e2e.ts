/**
 * End-to-end test for Web Agent Bridge.
 *
 * Prerequisites:
 *   1. Start the A2A server:         npm run server
 *   2. Load extension in Chrome:     chrome://extensions -> developer mode -> load unpacked -> extension/
 *   3. Open https://www.doubao.com/chat/ and ensure you are logged in
 *   4. Run this script:              npm run test:e2e
 */

import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import type { Task, Message } from "@a2a-js/sdk";
import { Role } from "@a2a-js/sdk";
import { randomUUID } from "crypto";

const SERVER_URL = process.env.A2A_URL || "http://127.0.0.1:3000/a2a";
const TEST_MESSAGE = process.env.TEST_MSG || "1+1等于几？请只回答数字。";

function extractResponseText(result: Task | Message): string {
  if ("artifacts" in result && (result as Task).artifacts?.length > 0) {
    return (result as Task).artifacts
      .flatMap((a) => a.parts || [])
      .filter((p) => p.content?.$case === "text")
      .map((p) => (p.content as { $case: "text"; value: string }).value)
      .join("\n");
  }
  if ("parts" in result) {
    return (result as Message).parts
      .filter((p) => p.content?.$case === "text")
      .map((p) => (p.content as { $case: "text"; value: string }).value)
      .join("\n");
  }
  return "[no text]";
}

async function main() {
  console.log("═══════════════════════════════════════");
  console.log(" Web Agent Bridge — E2E Test (v1.0)");
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
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory()],
  });
  const client = await factory.createFromUrl(SERVER_URL.replace(/\/a2a$/, ""));
  const card = await client.getAgentCard();
  console.log(`  Agent: ${card.name}`);
  console.log(`  Interfaces: ${card.supportedInterfaces.map((i) => `${i.protocolBinding}@${i.protocolVersion}`).join(", ")}`);
  console.log(`  Skills: ${card.skills?.map((s) => s.name).join(", ")}`);
  console.log("  ✓ Agent Card loaded\n");

  // Step 3: Send message via A2A protocol
  console.log(`[3/4] Sending message: "${TEST_MESSAGE}"`);
  const messageId = randomUUID();
  const contextId = randomUUID();

  const result = await client.sendMessage({
    tenant: "",
    message: {
      messageId,
      contextId,
      taskId: "",
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: "text", value: TEST_MESSAGE },
          metadata: undefined,
          filename: "",
          mediaType: "text/plain",
        },
      ],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  });

  console.log("  Result type:", "id" in result ? "Task" : "Message");

  // Step 4: Validate response
  console.log("\n[4/4] Validating response...");

  const responseText = extractResponseText(result);

  if ("status" in result && result.status) {
    const task = result as Task;
    console.log(`  Task state: ${task.status!.state}`);
  }

  console.log(`  AI Response: "${responseText.slice(0, 200)}"`);

  if (responseText.length === 0) {
    console.error("  ✗ Empty response from AI");
    console.error("  Full result:", JSON.stringify(result, null, 2).slice(0, 1000));
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
