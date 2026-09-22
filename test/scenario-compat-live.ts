/**
 * Live scenario suite: long prompt, long document, tool-like work.
 * Requires: wab server --browser --cdp on :3000
 *
 *   npx tsx test/scenario-compat-live.ts
 */
import { spawn } from "node:child_process";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role, TaskState } from "@a2a-js/sdk";
import type { Task } from "@a2a-js/sdk";

const BASE = process.env.A2A_URL || "http://127.0.0.1:3000";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function extractText(task: Task): string {
  const part = task.artifacts?.[0]?.parts?.[0]?.content;
  if (part && "$case" in part && part.$case === "text") return part.value;
  const flat = task.artifacts?.[0]?.parts?.[0] as { text?: string } | undefined;
  return flat?.text || "";
}

function longDoc(paragraphs = 40): string {
  const lines: string[] = [];
  for (let i = 1; i <= paragraphs; i++) {
    lines.push(
      `第${i}段：Web Agent Bridge 通过 A2A 与 ACP 把网页 AI（豆包、Kimi、Perplexity、通义千问等）桥接到本地 Agent。` +
        `本段用于验证长上下文投递与回复抽取稳定性。关键=${i} checksum=${(i * 97) % 1000}。`,
    );
  }
  return lines.join("\n");
}

/** Route via CLI so -a / -b are authoritative. */
function wabSend(agent: string, message: string, timeoutSec = 300): Promise<{ code: number; out: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(
      "wab",
      ["send", "-b", "browser", "-a", agent, "-T", String(timeoutSec), "-m", message],
      { env: process.env },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => {
      out += b.toString();
    });
    child.stderr.on("data", (b) => {
      err += b.toString();
    });
    child.on("close", (code) => {
      const text = (out || err).trim();
      resolve({ code: code ?? 1, out: text, ms: Date.now() - t0 });
    });
  });
}

async function a2aSend(text: string): Promise<{ task: Task; text: string; ms: number }> {
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory()] });
  const client = await factory.createFromUrl(BASE);
  const t0 = Date.now();
  const task = (await client.sendMessage({
    tenant: "",
    message: {
      messageId: crypto.randomUUID(),
      contextId: crypto.randomUUID(),
      taskId: "",
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: "text" as const, value: text },
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
  })) as unknown as Task;
  return { task, text: extractText(task), ms: Date.now() - t0 };
}

async function main() {
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║  Live scenarios — long text / tools / multi-agent ║");
  console.log("╚═══════════════════════════════════════════════════╝\n");

  const health = (await fetch(`${BASE}/health`).then((r) => r.json())) as {
    ok?: boolean;
    backends?: { browser?: { connected?: boolean; pages?: string[] } };
  };
  check("server healthy", health.ok === true);
  check(
    "browser CDP connected",
    health.backends?.browser?.connected === true,
    JSON.stringify(health.backends?.browser?.pages),
  );

  // ── A2A path (auto-routed) long instruction ──
  console.log("\n§A A2A long instruction (auto agent)");
  {
    const prompt = [
      "你是严谨的测试助手。请严格按下面要求输出，不要额外解释：",
      "1) 第一行只写：OK",
      "2) 第二行写 red,green,blue",
      "3) 第三行写数字 42",
      "4) 不要使用 markdown，不要加标题",
    ].join("\n");
    const { task, text, ms } = await a2aSend(prompt);
    check("A2A task completed", task.status?.state === TaskState.TASK_STATE_COMPLETED, `${ms}ms`);
    check("A2A reply non-empty", text.trim().length > 0, text.slice(0, 160));
    check("A2A has OK and 42", /OK/i.test(text) && /42/.test(text), text.slice(0, 200));
  }

  // ── Long document via kimi ──
  console.log("\n§B Long document → kimi (CLI/browser)");
  {
    const doc = longDoc(45);
    const prompt =
      `下面是一份约 ${doc.length} 字的测试文档。请用中文写不超过 5 条要点摘要，` +
      `最后一行单独输出 TOKEN_COUNT_APPROX=<整数>。\n\n` +
      doc;
    const { code, out, ms } = await wabSend("kimi", prompt, 300);
    check("kimi exit 0", code === 0 && !out.startsWith("❌"), `code=${code} ${ms}ms`);
    check("kimi reply substantial", out.length > 40, out.slice(0, 200));
    check("kimi mentions bridge/摘要", /Bridge|要点|摘要|豆包|A2A|ACP|Web Agent/i.test(out), out.slice(0, 220));
  }

  // ── Perplexity research ──
  console.log("\n§C Research → perplexity");
  {
    const prompt =
      "What is the Agent Client Protocol (ACP) for AI coding agents? " +
      "Give 3 short bullet points and name one related protocol if relevant. Under 120 words.";
    const { code, out, ms } = await wabSend("perplexity", prompt, 300);
    check("perplexity exit 0", code === 0 && !out.startsWith("❌"), `code=${code} ${ms}ms`);
    check("perplexity substantial", out.length > 60, out.slice(0, 220));
    check("perplexity topical", /ACP|Agent Client|protocol|MCP|A2A|agent/i.test(out), out.slice(0, 220));
  }

  // ── Doubao tool / Feishu ──
  console.log("\n§D Tool/Feishu → doubao");
  {
    const prompt =
      "请尽量使用你可用的飞书或搜索工具：" +
      "查看是否有与「会议」相关的日程或文档线索。" +
      "若工具不可用/无权限，第一行写 TOOL_UNAVAILABLE，第二行一句话原因。" +
      "若有结果，用不超过 5 行概括，勿粘贴敏感原文。";
    const { code, out, ms } = await wabSend("doubao", prompt, 600);
    check("doubao-tool exit 0", code === 0 && !out.startsWith("❌"), `code=${code} ${ms}ms`);
    check("doubao-tool non-empty", out.length > 8, out.slice(0, 260));
    check(
      "doubao-tool feishu/tool language",
      /TOOL_UNAVAILABLE|飞书|会议|日历|文档|搜索|工具|权限|未能|没有|找到|日程/i.test(out),
      out.slice(0, 280),
    );
  }

  // ── Qianwen long CN format ──
  console.log("\n§E Long CN instruction → qianwen");
  {
    const prompt = [
      "请完成格式化输出测试。约束：",
      "- 只用简体中文",
      "- 输出恰好包含「通过」与「通义千问」",
      "- 并给出一个两位素数",
      "尽量简短。",
    ].join("\n");
    const { code, out, ms } = await wabSend("qianwen", prompt, 180);
    check("qianwen exit 0", code === 0 && !out.startsWith("❌"), `code=${code} ${ms}ms`);
    check("qianwen keywords", /通过/.test(out) && /通义/.test(out), out.slice(0, 160));
  }

  console.log("\n╔═══════════════════════════════════════════════════╗");
  console.log(`║  Results:  ✓ ${passed}  ✗ ${failed}`.padEnd(53) + "║");
  console.log("╚═══════════════════════════════════════════════════╝");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("✗ scenario suite crashed:", err);
  process.exit(1);
});
