import { A2AClient } from "@a2a-js/sdk/client";
import { randomUUID } from "crypto";

async function main() {
  const client = new A2AClient("http://127.0.0.1:3000/a2a");

  console.log("Sending test message to Doubao via A2A...");
  const response = await client.sendMessage({
    message: {
      role: "user",
      kind: "message",
      messageId: randomUUID(),
      parts: [{ kind: "text", text: "你好，请用一句话简短回复你是谁" }],
      contextId: randomUUID(),
    },
  });

  console.log("\n=== Response ===");
  console.log(JSON.stringify(response, null, 2));
}

main().catch(console.error);
