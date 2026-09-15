import { A2AClient } from "@a2a-js/sdk/client";
import { randomUUID } from "crypto";

function extractResponseText(response: any): string {
  const result = response.result;
  if (!result) return "[no result]";

  if (result.artifacts?.length > 0) {
    return result.artifacts
      .flatMap((a: any) => a.parts || [])
      .filter((p: any) => p.kind === "text")
      .map((p: any) => p.text)
      .join("\n");
  }
  if (result.parts) {
    return result.parts
      .filter((p: any) => p.kind === "text")
      .map((p: any) => p.text)
      .join("\n");
  }
  return "[no text]";
}

async function sendA2A(client: any, text: string): Promise<any> {
  return client.sendMessage({
    message: {
      role: "user",
      kind: "message",
      messageId: randomUUID(),
      parts: [{ kind: "text", text }],
      contextId: randomUUID(),
    },
  });
}

async function main() {
  const client = new A2AClient("http://127.0.0.1:3000/a2a");

  // Step 1: 简单问题确认链路
  console.log("=== Step 1: 确认链路 (简单问题) ===");
  const r1 = await sendA2A(client, "1+1等于几？请只回答数字");
  const t1 = extractResponseText(r1);
  const state1 = r1.result?.status?.state;
  console.log(`  状态: ${state1}`);
  console.log(`  回复: "${t1}"`);
  if (state1 !== "completed") {
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
  const state2 = r2.result?.status?.state;
  console.log(`  状态: ${state2}`);
  console.log(`  回复: "${t2.slice(0, 300)}"`);

  console.log("\n=== 完整响应 ===");
  console.log(JSON.stringify(r2, null, 2));
}

main().catch(console.error);
