/**
 * Stress test: send 5 messages in rapid succession
 * to verify robustness under dense message sequences.
 */
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role, TaskState } from "@a2a-js/sdk";

const BASE = "http://127.0.0.1:3000";

async function main() {
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory()] });
  const client = await factory.createFromUrl(BASE);

  const messages = [
    "1+1等于几？只回答数字",
    "中国的首都是哪里？只回答城市名",
    "水的化学式是什么？只回答化学式",
    "一年有多少天？只回答数字",
    "太阳系有几大行星？只回答数字",
  ];

  let passed = 0;
  let failed = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    console.log(`\n[${i + 1}/${messages.length}] Sending: "${msg}"`);

    try {
      const task = await client.sendMessage({
        tenant: "",
        message: {
          messageId: crypto.randomUUID(),
          contextId: crypto.randomUUID(),
          taskId: "",
          role: Role.ROLE_USER,
          parts: [
            {
              content: { $case: "text" as const, value: msg },
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

      const state = task?.status?.state;
      const textPart = task?.artifacts?.[0]?.parts?.[0]?.content;
      const responseText = textPart?.$case === "text" ? textPart.value : "(no text)";

      if (state === TaskState.TASK_STATE_COMPLETED && responseText !== "(no text)") {
        console.log(`  ✓ Response: "${responseText.slice(0, 80)}"`);
        passed++;
      } else {
        const errPart = task?.status?.message?.parts?.[0]?.content;
        const errText = errPart?.$case === "text" ? errPart.value : "";
        console.log(`  ✗ State: ${state}, Error: ${errText.slice(0, 100)}`);
        failed++;
      }
    } catch (e: any) {
      console.log(`  ✗ Exception: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`  Stress test:  ✓ ${passed}  ✗ ${failed}  / ${messages.length} total`);
  if (failed === 0) {
    console.log(`  ✓✓✓  ALL PASSED — robustness OK  ✓✓✓`);
  } else {
    console.log(`  ⚠️  ${failed} failed — check logs above`);
  }
  console.log(`${"═".repeat(50)}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
