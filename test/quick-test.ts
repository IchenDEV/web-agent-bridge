import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role } from "@a2a-js/sdk";
import { randomUUID } from "crypto";

async function main() {
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory()],
  });
  const client = await factory.createFromUrl("http://127.0.0.1:3000");

  console.log("Sending test message to Doubao via A2A...");
  const result = await client.sendMessage({
    tenant: "",
    message: {
      messageId: randomUUID(),
      contextId: randomUUID(),
      taskId: "",
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: "text", value: "你好，请用一句话简短回复你是谁" },
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

  console.log("\n=== Response ===");
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
