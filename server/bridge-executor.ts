import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { AgentEvent } from "@a2a-js/sdk/server";
import { TaskState, Role } from "@a2a-js/sdk";
import type { Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from "@a2a-js/sdk";
import type { WsBridge } from "./ws-bridge.js";

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * A2A AgentExecutor that bridges incoming messages to the browser extension
 * via WebSocket, waits for the AI response, and publishes it as a Task artifact.
 */
export class BridgeExecutor implements AgentExecutor {
  constructor(private bridge: WsBridge) {}

  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userText = this.extractText(ctx);
    const targetAgent = this.extractTargetAgent(ctx);
    console.log(`[BridgeExecutor] Task ${ctx.taskId} | agent: ${targetAgent || "auto"} | text: "${userText.slice(0, 80)}"`);

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
      const responseText = await this.bridge.sendAndWait(ctx.taskId, userText, 180_000, targetAgent);

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
   * Extract optional target agent from request metadata.
   * CLI passes this via `metadata: { "x-target-agent": "doubao" }`.
   */
  private extractTargetAgent(ctx: RequestContext): string | undefined {
    const meta = (ctx as any).metadata;
    if (meta && typeof meta === "object") {
      return meta["x-target-agent"] || undefined;
    }
    return undefined;
  }
}
