import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import type { Task, Message } from "@a2a-js/sdk";
import { Role } from "@a2a-js/sdk";
import { randomUUID } from "crypto";

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

async function sendA2A(
  client: InstanceType<typeof import("@a2a-js/sdk/client").Client>,
  text: string
): Promise<Task | Message> {
  return client.sendMessage({
    tenant: "",
    message: {
      messageId: randomUUID(),
      contextId: randomUUID(),
      taskId: "",
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: "text", value: text },
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
}

async function main() {
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory()],
  });
  const client = await factory.createFromUrl("http://127.0.0.1:3000");

  // Step 1: 简单问题确认链路
  console.log("=== Step 1: 确认链路 (简单问题) ===");
  const r1 = await sendA2A(client, "1+1等于几？请只回答数字");
  const t1 = extractResponseText(r1);
  const isTask1 = "status" in r1;
  const state1 = isTask1 ? (r1 as Task).status?.state : "message";
  console.log(`  类型: ${isTask1 ? "Task" : "Message"}`);
  console.log(`  状态: ${state1}`);
  console.log(`  回复: "${t1}"`);
  if (isTask1 && (r1 as Task).status?.state !== 3 /* COMPLETED */) {
    console.error("  ✗ 失败:", JSON.stringify(r1, null, 2).slice(0, 500));
    process.exit(1);
  }
  console.log("  ✓ 链路通畅\n");

  // Step 2: 让豆包操作飞书
  console.log("=== Step 2: 操作飞书 ===");
  const feishuPrompt =
    "请帮我在飞书上创建一个文档，标题叫「A2A 协议测试」，" +
    "内容写：这是通过 Web Agent Bridge 的 A2A 协议远程指挥豆包创建的飞书文档。测试时间：" +
    new Date().toLocaleString("zh-CN");

  console.log(`  指令: ${feishuPrompt}\n`);
  const r2 = await sendA2A(client, feishuPrompt);
  const t2 = extractResponseText(r2);
  const isTask2 = "status" in r2;
  const state2 = isTask2 ? (r2 as Task).status?.state : "message";
  console.log(`  类型: ${isTask2 ? "Task" : "Message"}`);
  console.log(`  状态: ${state2}`);
  console.log(`  回复: "${t2.slice(0, 300)}"`);

  console.log("\n=== 完整响应 ===");
  console.log(JSON.stringify(r2, null, 2).slice(0, 2000));
}

main().catch(console.error);
