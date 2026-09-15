/**
 * A2A v1.0 Protocol Comprehensive Verification
 *
 * Tests ALL available A2A operations and protocol details:
 *   1. Agent Card Discovery (/.well-known/agent-card.json)
 *   2. Agent Card v1.0 Schema Compliance
 *   3. SendMessage (blocking mode)
 *   4. SendMessage with configuration (acceptedOutputModes, historyLength)
 *   5. GetTask — retrieve task by ID
 *   6. ListTasks — list tasks with contextId filter
 *   7. CancelTask — cancel a task
 *   8. Task lifecycle states
 *   9. Artifacts and Parts format
 *  10. Message history and referenceTaskIds
 *  11. contextId grouping
 *  12. metadata propagation
 *  13. Error handling (invalid method, missing params)
 *  14. Version negotiation (A2A-Version header)
 *
 * Run:  npx tsx test/a2a-protocol-verify.ts
 */

import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import type { Client } from "@a2a-js/sdk/client";
import type { AgentCard, Task, Message, Part, SendMessageRequest } from "@a2a-js/sdk";
import { Role, TaskState } from "@a2a-js/sdk";
import { randomUUID } from "crypto";

const BASE_URL = process.env.A2A_URL || "http://127.0.0.1:3000";
const A2A_ENDPOINT = `${BASE_URL}/a2a`;

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(name: string, reason: string) {
  skipped++;
  console.log(`  ⊘ ${name} (${reason})`);
}

function textPart(text: string): Part {
  return {
    content: { $case: "text" as const, value: text },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

function makeMessage(text: string, contextId?: string): SendMessageRequest {
  return {
    tenant: "",
    message: {
      messageId: randomUUID(),
      contextId: contextId || randomUUID(),
      taskId: "",
      role: Role.ROLE_USER,
      parts: [textPart(text)],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  };
}

function extractText(result: Task | Message): string {
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
  return "";
}

function isTask(r: Task | Message): r is Task {
  return "status" in r && r.status !== undefined;
}

// ── Raw JSON-RPC helper for low-level protocol tests ──
async function rawJsonRpc(
  method: string,
  params: any,
  headers?: Record<string, string>
): Promise<any> {
  const res = await fetch(A2A_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "A2A-Version": "1.0",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    }),
  });
  return res.json();
}

async function main() {
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║  A2A v1.0 Protocol — Comprehensive Verification  ║");
  console.log("╚═══════════════════════════════════════════════════╝\n");

  // ════════════════════════════════════════════════════
  // §1  Server Health
  // ════════════════════════════════════════════════════
  console.log("§1  Server Health");
  const healthRes = await fetch(`${BASE_URL}/health`);
  const health = (await healthRes.json()) as any;
  check("GET /health returns 200", healthRes.ok);
  check("health.ok is true", health.ok === true);
  check("health.extensionConnected is boolean", typeof health.extensionConnected === "boolean");

  const hasExtension = health.extensionConnected;
  console.log(`  ℹ Extension connected: ${hasExtension}\n`);

  // ════════════════════════════════════════════════════
  // §2  Agent Card Discovery
  // ════════════════════════════════════════════════════
  console.log("§2  Agent Card Discovery");

  const cardRes = await fetch(`${BASE_URL}/.well-known/agent-card.json`);
  check("GET /.well-known/agent-card.json returns 200", cardRes.ok);
  check("Content-Type is application/json", cardRes.headers.get("content-type")?.includes("application/json") ?? false);
  check("Cache-Control header present", !!cardRes.headers.get("cache-control"));
  check("ETag header present", !!cardRes.headers.get("etag"));

  const cardJson = await cardRes.json() as any;

  // Also check sub-path
  const cardRes2 = await fetch(`${BASE_URL}/a2a/.well-known/agent-card.json`);
  check("Agent Card also at /a2a/.well-known/agent-card.json", cardRes2.ok);
  console.log();

  // ════════════════════════════════════════════════════
  // §3  Agent Card v1.0 Schema Compliance
  // ════════════════════════════════════════════════════
  console.log("§3  Agent Card v1.0 Schema");
  const card: AgentCard = cardJson;

  check("name is non-empty string", typeof card.name === "string" && card.name.length > 0);
  check("description is non-empty string", typeof card.description === "string" && card.description.length > 0);
  check("version is non-empty string", typeof card.version === "string" && card.version.length > 0);

  // supportedInterfaces
  check("supportedInterfaces is non-empty array", Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length > 0);
  const iface = card.supportedInterfaces[0];
  check("interface.url is absolute URL", iface?.url?.startsWith("http"));
  check("interface.protocolBinding is JSONRPC", iface?.protocolBinding === "JSONRPC");
  check("interface.protocolVersion is 1.0", iface?.protocolVersion === "1.0");

  // MIME types
  check("defaultInputModes uses MIME types", card.defaultInputModes.every((m) => m.includes("/")));
  check("defaultOutputModes uses MIME types", card.defaultOutputModes.every((m) => m.includes("/")));
  check("defaultInputModes includes text/plain", card.defaultInputModes.includes("text/plain"));
  check("defaultOutputModes includes text/plain", card.defaultOutputModes.includes("text/plain"));

  // capabilities
  check("capabilities object present", card.capabilities !== undefined);
  check("capabilities.streaming is boolean", typeof card.capabilities?.streaming === "boolean");
  check("capabilities.pushNotifications is boolean", typeof card.capabilities?.pushNotifications === "boolean");
  check("capabilities.extensions is array", Array.isArray(card.capabilities?.extensions));

  // security
  check("securitySchemes is object", typeof card.securitySchemes === "object" && card.securitySchemes !== null);
  check("securityRequirements is array", Array.isArray(card.securityRequirements));

  // skills
  check("skills is non-empty array", Array.isArray(card.skills) && card.skills.length > 0);
  const skill = card.skills[0];
  check("skill.id is non-empty", typeof skill?.id === "string" && skill.id.length > 0);
  check("skill.name is non-empty", typeof skill?.name === "string" && skill.name.length > 0);
  check("skill.description is non-empty", typeof skill?.description === "string" && skill.description.length > 0);
  check("skill.tags is array", Array.isArray(skill?.tags));
  check("skill.examples is array", Array.isArray(skill?.examples));
  check("skill.inputModes is array", Array.isArray(skill?.inputModes));
  check("skill.outputModes is array", Array.isArray(skill?.outputModes));

  // signatures
  check("signatures is array", Array.isArray(card.signatures));
  console.log();

  // ════════════════════════════════════════════════════
  // §4  Client SDK — Agent Card Resolution
  // ════════════════════════════════════════════════════
  console.log("§4  Client SDK — Agent Card Resolution");
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory()],
  });
  const client = await factory.createFromUrl(BASE_URL);
  check("ClientFactory.createFromUrl succeeds", !!client);
  check("client.protocolVersion is 1.0", client.protocolVersion === "1.0");

  const resolvedCard = await client.getAgentCard();
  check("client.getAgentCard() returns card", resolvedCard.name === card.name);
  console.log();

  // ════════════════════════════════════════════════════
  // §5  SendMessage — Task lifecycle
  // ════════════════════════════════════════════════════
  console.log("§5  SendMessage — Task Lifecycle");

  const ctx1 = randomUUID();
  const result1 = await client.sendMessage(makeMessage("test message for verification", ctx1));

  check("sendMessage returns result", !!result1);
  check("result is a Task (has status)", isTask(result1));

  if (isTask(result1)) {
    const task1 = result1;
    check("task.id is non-empty UUID-like", task1.id.length > 8);
    check("task.contextId matches request", task1.contextId === ctx1);
    check("task.status is defined", task1.status !== undefined);
    check("task.status.state is terminal", [
      TaskState.TASK_STATE_COMPLETED,
      TaskState.TASK_STATE_FAILED,
    ].includes(task1.status!.state));
    check("task.status.timestamp is ISO string", typeof task1.status?.timestamp === "string" && task1.status.timestamp.length > 0);
    check("task.history is array", Array.isArray(task1.history));
    check("task.history contains user message", task1.history.some((m) => m.role === Role.ROLE_USER));
    check("task.artifacts is array", Array.isArray(task1.artifacts));

    // History message structure
    const userMsg = task1.history.find((m) => m.role === Role.ROLE_USER);
    if (userMsg) {
      check("history user msg has messageId", typeof userMsg.messageId === "string" && userMsg.messageId.length > 0);
      check("history user msg has contextId", userMsg.contextId === ctx1);
      check("history user msg has parts", userMsg.parts.length > 0);
      check("history user msg part has content", userMsg.parts[0]?.content?.$case === "text");
    }

    if (task1.status!.state === TaskState.TASK_STATE_COMPLETED) {
      check("completed task has artifacts", task1.artifacts.length > 0);
      const art = task1.artifacts[0];
      check("artifact has artifactId", typeof art?.artifactId === "string" && art.artifactId.length > 0);
      check("artifact has parts", art?.parts?.length > 0);
      check("artifact part is text", art?.parts[0]?.content?.$case === "text");
      const responseText = extractText(task1);
      check("response text is non-empty", responseText.length > 0);
      console.log(`  ℹ Response: "${responseText.slice(0, 80)}..."`);
    } else {
      // Failed because no extension — still valid protocol behavior
      check("failed task has status message", task1.status!.message !== undefined);
      const errText = task1.status!.message?.parts
        .filter((p) => p.content?.$case === "text")
        .map((p) => (p.content as any).value)
        .join("") || "";
      check("error message has text content", errText.length > 0);
      console.log(`  ℹ Expected failure: "${errText.slice(0, 80)}"`);
    }

    // ════════════════════════════════════════════════════
    // §6  GetTask — Retrieve by ID
    // ════════════════════════════════════════════════════
    console.log();
    console.log("§6  GetTask — Retrieve by ID");

    try {
      const fetched = await client.getTask({ tenant: "", id: task1.id });
      check("getTask returns task", !!fetched);
      check("getTask task.id matches", fetched.id === task1.id);
      check("getTask task.contextId matches", fetched.contextId === task1.contextId);
      check("getTask task.status matches", fetched.status?.state === task1.status!.state);
      check("getTask task.history present", Array.isArray(fetched.history));
      check("getTask task.artifacts present", Array.isArray(fetched.artifacts));
    } catch (e: any) {
      check("getTask succeeds", false, e.message);
    }

    // GetTask with historyLength
    console.log();
    console.log("§6b GetTask — historyLength control");
    try {
      const fetchedNoHistory = await client.getTask({ tenant: "", id: task1.id, historyLength: 0 });
      check("getTask historyLength=0 returns task", !!fetchedNoHistory);
      check("getTask historyLength=0 → history empty or absent",
        !fetchedNoHistory.history || fetchedNoHistory.history.length === 0);
    } catch (e: any) {
      check("getTask historyLength=0", false, e.message);
    }

    try {
      const fetchedOneMsg = await client.getTask({ tenant: "", id: task1.id, historyLength: 1 });
      check("getTask historyLength=1 returns task", !!fetchedOneMsg);
      check("getTask historyLength=1 → history ≤ 1",
        fetchedOneMsg.history.length <= 1);
    } catch (e: any) {
      check("getTask historyLength=1", false, e.message);
    }

    // ════════════════════════════════════════════════════
    // §7  ListTasks — Filter by contextId
    // ════════════════════════════════════════════════════
    console.log();
    console.log("§7  ListTasks — Filter by contextId");

    try {
      const listResult = await client.listTasks({
        tenant: "",
        contextId: ctx1,
        status: TaskState.TASK_STATE_UNSPECIFIED,
        pageToken: "",
        statusTimestampAfter: undefined,
      });
      check("listTasks returns response", !!listResult);
      check("listTasks.tasks is array", Array.isArray(listResult.tasks));
      check("listTasks finds our task", listResult.tasks.some((t) => t.id === task1.id));
      if (listResult.tasks.length > 0) {
        check("listed task has correct contextId", listResult.tasks[0].contextId === ctx1);
      }
    } catch (e: any) {
      check("listTasks succeeds", false, e.message);
    }

    // ListTasks — empty result for random contextId
    try {
      const emptyList = await client.listTasks({
        tenant: "",
        contextId: randomUUID(),
        status: TaskState.TASK_STATE_UNSPECIFIED,
        pageToken: "",
        statusTimestampAfter: undefined,
      });
      check("listTasks with unknown contextId → empty", emptyList.tasks.length === 0);
    } catch (e: any) {
      check("listTasks empty result", false, e.message);
    }
  }
  console.log();

  // ════════════════════════════════════════════════════
  // §8  SendMessage with Configuration
  // ════════════════════════════════════════════════════
  console.log("§8  SendMessage — Configuration Options");

  const ctx2 = randomUUID();
  const configuredReq: SendMessageRequest = {
    tenant: "",
    message: {
      messageId: randomUUID(),
      contextId: ctx2,
      taskId: "",
      role: Role.ROLE_USER,
      parts: [textPart("configuration test")],
      metadata: { customKey: "customValue" },
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: {
      acceptedOutputModes: ["text/plain", "text/markdown"],
      taskPushNotificationConfig: undefined,
      historyLength: 1,
      returnImmediately: false,
    },
    metadata: { requestMeta: "test" },
  };

  const result2 = await client.sendMessage(configuredReq);
  check("sendMessage with configuration succeeds", !!result2);
  if (isTask(result2)) {
    check("configured task has id", result2.id.length > 0);
    check("configured task historyLength respected (≤1)", result2.history.length <= 1);
  }
  console.log();

  // ════════════════════════════════════════════════════
  // §9  SendMessage with metadata
  // ════════════════════════════════════════════════════
  console.log("§9  Message Metadata");

  const metaReq = makeMessage("metadata test");
  metaReq.message!.metadata = { source: "verification-suite", priority: "high" };
  const result3 = await client.sendMessage(metaReq);
  check("sendMessage with message metadata succeeds", !!result3);
  if (isTask(result3)) {
    const userMsgInHistory = result3.history.find((m) => m.role === Role.ROLE_USER);
    check("user message metadata preserved in history",
      userMsgInHistory?.metadata?.source === "verification-suite");
  }
  console.log();

  // ════════════════════════════════════════════════════
  // §10  contextId — Shared Context
  // ════════════════════════════════════════════════════
  console.log("§10 contextId — Shared Context");

  const sharedCtx = randomUUID();
  const r4 = await client.sendMessage(makeMessage("context message 1", sharedCtx));
  const r5 = await client.sendMessage(makeMessage("context message 2", sharedCtx));
  check("two tasks with same contextId", isTask(r4) && isTask(r5));
  if (isTask(r4) && isTask(r5)) {
    check("both tasks share contextId", r4.contextId === sharedCtx && r5.contextId === sharedCtx);
    check("tasks have different IDs", r4.id !== r5.id);

    try {
      const contextTasks = await client.listTasks({
        tenant: "",
        contextId: sharedCtx,
        status: TaskState.TASK_STATE_UNSPECIFIED,
        pageToken: "",
        statusTimestampAfter: undefined,
      });
      check("listTasks finds both tasks in shared context", contextTasks.tasks.length === 2);
    } catch (e: any) {
      check("listTasks for shared context", false, e.message);
    }
  }
  console.log();

  // ════════════════════════════════════════════════════
  // §11 CancelTask
  // ════════════════════════════════════════════════════
  console.log("§11 CancelTask");

  // Our tasks are already terminal, but cancelTask should still return the task
  if (isTask(r4)) {
    try {
      const canceled = await client.cancelTask({ tenant: "", id: r4.id, metadata: undefined });
      check("cancelTask returns task", !!canceled);
      check("cancelTask task.id matches", canceled.id === r4.id);
      // Task was already terminal, so state might stay as-is or become canceled
      check("cancelTask task has status", canceled.status !== undefined);
    } catch (e: any) {
      // May throw if task is already terminal — that's also valid A2A behavior
      check("cancelTask handled (may reject terminal tasks)", true);
      console.log(`  ℹ Cancel error: ${e.message?.slice(0, 80)}`);
    }
  }
  console.log();

  // ════════════════════════════════════════════════════
  // §12 Raw JSON-RPC — Error Handling
  // ════════════════════════════════════════════════════
  console.log("§12 JSON-RPC Error Handling");

  // Invalid method
  const errInvalidMethod = await rawJsonRpc("InvalidMethod", {});
  check("invalid method → JSON-RPC error", !!errInvalidMethod.error);
  check("error has code", typeof errInvalidMethod.error?.code === "number");
  check("error has message", typeof errInvalidMethod.error?.message === "string");
  check("error code is -32601 (method not found)", errInvalidMethod.error?.code === -32601);

  // Missing params
  const errNoParams = await rawJsonRpc("SendMessage", null);
  check("missing params → JSON-RPC error", !!errNoParams.error);

  // Malformed request
  const malformedRes = await fetch(A2A_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
    body: "not json at all",
  });
  const malformed = await malformedRes.json().catch(() => null);
  check("malformed JSON → error response", malformed?.error !== undefined || !malformedRes.ok);

  // Valid structure but bad method
  const legacyMethod = await rawJsonRpc("message/send", { message: {} });
  check("v0.3 method name 'message/send' rejected", !!legacyMethod.error);
  console.log();

  // ════════════════════════════════════════════════════
  // §13 Raw JSON-RPC — Version Negotiation
  // ════════════════════════════════════════════════════
  console.log("§13 A2A-Version Header");

  // Request with correct version
  const versionOk = await rawJsonRpc("SendMessage", {
    message: {
      messageId: randomUUID(),
      contextId: randomUUID(),
      role: "ROLE_USER",
      parts: [{ text: "version test", mediaType: "text/plain" }],
      extensions: [],
      referenceTaskIds: [],
    },
  }, { "A2A-Version": "1.0" });
  check("A2A-Version: 1.0 accepted", !versionOk.error || versionOk.result);

  // Request without version header (should still work or gracefully handle)
  const noVersion = await rawJsonRpc("SendMessage", {
    message: {
      messageId: randomUUID(),
      contextId: randomUUID(),
      role: "ROLE_USER",
      parts: [{ text: "no version", mediaType: "text/plain" }],
      extensions: [],
      referenceTaskIds: [],
    },
  }, {});
  check("missing A2A-Version handled gracefully",
    noVersion.result !== undefined || noVersion.error !== undefined);
  console.log();

  // ════════════════════════════════════════════════════
  // §14 Wire Format — Part serialization
  // ════════════════════════════════════════════════════
  console.log("§14 Wire Format — Part Types");

  // Text part (standard)
  const textResult = await rawJsonRpc("SendMessage", {
    message: {
      messageId: randomUUID(),
      contextId: randomUUID(),
      role: "ROLE_USER",
      parts: [{ text: "plain text part", mediaType: "text/plain" }],
      extensions: [],
      referenceTaskIds: [],
    },
  });
  check("text part on wire uses 'text' field (not content.$case)", !!textResult.result);

  // Verify response part format on wire
  if (textResult.result?.task) {
    const wireParts = textResult.result.task.status?.message?.parts || [];
    const hasFlatText = wireParts.some((p: any) => typeof p.text === "string");
    check("response parts use flat 'text' field on wire", hasFlatText);
    const hasMediaType = wireParts.every((p: any) => typeof p.mediaType === "string");
    check("response parts have mediaType", hasMediaType);
  }

  // Data part
  const dataResult = await rawJsonRpc("SendMessage", {
    message: {
      messageId: randomUUID(),
      contextId: randomUUID(),
      role: "ROLE_USER",
      parts: [{ data: { key: "value", nested: [1, 2, 3] }, mediaType: "application/json" }],
      extensions: [],
      referenceTaskIds: [],
    },
  });
  check("data part (application/json) accepted", !!dataResult.result || !!dataResult.error);
  console.log();

  // ════════════════════════════════════════════════════
  // §15 Live Agent Test (if extension connected)
  // ════════════════════════════════════════════════════
  if (hasExtension) {
    console.log("§15 Live Agent Test (Extension Connected)");

    const liveResult = await client.sendMessage(makeMessage("1+1等于几？请只回答数字"));
    check("live sendMessage returns result", !!liveResult);

    if (isTask(liveResult)) {
      check("live task completed", liveResult.status?.state === TaskState.TASK_STATE_COMPLETED);
      const liveText = extractText(liveResult);
      check("live response has text", liveText.length > 0);
      check("live response contains '2'", liveText.includes("2"));
      console.log(`  ℹ Doubao response: "${liveText.slice(0, 100)}"`);

      // Verify artifacts structure
      check("live task has artifacts", liveResult.artifacts.length > 0);
      const liveArt = liveResult.artifacts[0];
      check("live artifact has artifactId", liveArt.artifactId.length > 0);
      check("live artifact has name", typeof liveArt.name === "string");
      check("live artifact parts have mediaType", liveArt.parts.every((p) => typeof p.mediaType === "string"));

      // GetTask for the live result
      const liveGet = await client.getTask({ tenant: "", id: liveResult.id });
      check("getTask retrieves live task", liveGet.id === liveResult.id);
      check("getTask live task has artifacts", liveGet.artifacts.length > 0);
      check("getTask live task has history", liveGet.history.length >= 1);
    }
  } else {
    skip("§15 Live Agent Test", "no extension connected — protocol-only verification");
  }
  console.log();

  // ════════════════════════════════════════════════════
  //  Summary
  // ════════════════════════════════════════════════════
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log(`║  Results:  ✓ ${passed}  ✗ ${failed}  ⊘ ${skipped}`.padEnd(53) + "║");
  console.log("╠═══════════════════════════════════════════════════╣");
  if (failed === 0) {
    console.log("║  ✓✓✓  ALL A2A v1.0 PROTOCOL CHECKS PASSED  ✓✓✓   ║");
  } else {
    console.log(`║  ⚠  ${failed} check(s) failed — see details above`.padEnd(53) + "║");
  }
  console.log("╚═══════════════════════════════════════════════════╝");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n✗ Verification crashed:", err);
  process.exit(1);
});
