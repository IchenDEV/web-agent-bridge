import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from "@a2a-js/sdk";
import type { WsBridge } from "./ws-bridge.js";

/**
 * A2A AgentExecutor that bridges incoming messages to the browser extension
 * via WebSocket, waits for the AI response, and publishes it as a Task artifact.
 */
export class BridgeExecutor implements AgentExecutor {
  constructor(private bridge: WsBridge) {}

  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userText = this.extractText(ctx);
    console.log(`[BridgeExecutor] Task ${ctx.taskId} | text: "${userText.slice(0, 80)}"`);

    // Publish the initial Task object so ResultManager can track it
    const task: Task = {
      kind: "task",
      id: ctx.taskId,
      contextId: ctx.contextId,
      status: { state: "working" },
      history: [ctx.userMessage],
    };
    eventBus.publish(task);

    try {
      const responseText = await this.bridge.sendAndWait(ctx.taskId, userText);

      // Publish the AI response as an artifact
      const artifactEvent: TaskArtifactUpdateEvent = {
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        kind: "artifact-update",
        artifact: {
          artifactId: `${ctx.taskId}-reply`,
          parts: [{ kind: "text", text: responseText }],
        },
      };
      eventBus.publish(artifactEvent);

      // Publish "completed" status
      const doneEvent: TaskStatusUpdateEvent = {
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        kind: "status-update",
        status: { state: "completed" },
        final: true,
      };
      eventBus.publish(doneEvent);
    } catch (err: any) {
      const failEvent: TaskStatusUpdateEvent = {
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        kind: "status-update",
        status: {
          state: "failed",
          message: {
            kind: "message",
            messageId: `${ctx.taskId}-error`,
            role: "agent",
            parts: [{ kind: "text", text: `Error: ${err.message}` }],
          },
        },
        final: true,
      };
      eventBus.publish(failEvent);
    }

    eventBus.finished();
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const event: TaskStatusUpdateEvent = {
      taskId,
      contextId: taskId,
      kind: "status-update",
      status: { state: "canceled" },
      final: true,
    };
    eventBus.publish(event);
    eventBus.finished();
  }

  private extractText(ctx: RequestContext): string {
    for (const part of ctx.userMessage.parts) {
      if (part.kind === "text") return part.text;
    }
    throw new Error("No text part in user message");
  }
}
