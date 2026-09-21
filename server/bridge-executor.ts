import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { AgentEvent } from "@a2a-js/sdk/server";
import { TaskState, Role } from "@a2a-js/sdk";
import type { Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from "@a2a-js/sdk";
import { BackendRouter, type MessageBackend } from "./message-backend.js";

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * A2A AgentExecutor that bridges incoming messages to the browser extension
 * via WebSocket, waits for the AI response, and publishes it as a Task artifact.
 */
export class BridgeExecutor implements AgentExecutor {
  constructor(private bridge: MessageBackend) {}

  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userText = this.extractText(ctx);
    const targetAgent = this.extractMetaValue(ctx, "x-target-agent");
    const backendName = this.extractMetaValue(ctx, "x-backend");
    console.log(
      `[BridgeExecutor] Task ${ctx.taskId} | backend: ${backendName || "auto"} | agent: ${targetAgent || "auto"} | text: "${userText.slice(0, 80)}"`,
    );

    const task: Task = {
      id: ctx.taskId,
      contextId: ctx.contextId,
      status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: isoNow() },
      artifacts: [],
      history: [ctx.userMessage],
      metadata: undefined,
    };
    eventBus.publish(AgentEvent.task(task));

    try {
      const responseText =
        this.bridge instanceof BackendRouter
          ? await this.bridge.sendAndWaitVia(backendName, ctx.taskId, userText, 180_000, targetAgent)
          : await this.bridge.sendAndWait(ctx.taskId, userText, 180_000, targetAgent);

      const artifactEvent: TaskArtifactUpdateEvent = {
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        artifact: {
          artifactId: `${ctx.taskId}-reply`,
          name: "response",
          description: "AI assistant response",
          parts: [
            {
              content: { $case: "text", value: responseText },
              metadata: undefined,
              filename: "",
              mediaType: "text/plain",
            },
          ],
          metadata: undefined,
          extensions: [],
        },
        append: false,
        lastChunk: true,
        metadata: undefined,
      };
      eventBus.publish(AgentEvent.artifactUpdate(artifactEvent));

      const doneEvent: TaskStatusUpdateEvent = {
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: isoNow() },
        metadata: undefined,
      };
      eventBus.publish(AgentEvent.statusUpdate(doneEvent));
    } catch (err: any) {
      const failEvent: TaskStatusUpdateEvent = {
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: {
          state: TaskState.TASK_STATE_FAILED,
          message: {
            messageId: `${ctx.taskId}-error`,
            contextId: ctx.contextId,
            taskId: ctx.taskId,
            role: Role.ROLE_AGENT,
            parts: [
              {
                content: { $case: "text", value: `Error: ${err.message}` },
                metadata: undefined,
                filename: "",
                mediaType: "text/plain",
              },
            ],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
          },
          timestamp: isoNow(),
        },
        metadata: undefined,
      };
      eventBus.publish(AgentEvent.statusUpdate(failEvent));
    }

    eventBus.finished();
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const event: TaskStatusUpdateEvent = {
      taskId,
      contextId: taskId,
      status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: isoNow() },
      metadata: undefined,
    };
    eventBus.publish(AgentEvent.statusUpdate(event));
    eventBus.finished();
  }

  private extractText(ctx: RequestContext): string {
    for (const part of ctx.userMessage.parts) {
      if (part.content?.$case === "text") return part.content.value;
    }
    throw new Error("No text part in user message");
  }

  /**
   * Read an optional routing field from message metadata, then request metadata.
   */
  private extractMetaValue(ctx: RequestContext, key: string): string | undefined {
    const msgMeta = ctx.userMessage.metadata as Record<string, unknown> | undefined;
    if (msgMeta?.[key] != null && msgMeta[key] !== "") {
      return String(msgMeta[key]);
    }

    const reqMeta = (ctx as { metadata?: Record<string, unknown> }).metadata;
    if (reqMeta?.[key] != null && reqMeta[key] !== "") {
      return String(reqMeta[key]);
    }

    return undefined;
  }
}
