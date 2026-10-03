import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { AgentEvent } from "@a2a-js/sdk/server";
import { TaskState, Role } from "@a2a-js/sdk";
import type { Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from "@a2a-js/sdk";
import type { MessageBackend } from "./message-backend.js";

function isoNow(): string {
  return new Date().toISOString();
}

function textPart(value: string) {
  return {
    content: { $case: "text" as const, value },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

/**
 * A2A AgentExecutor that bridges incoming messages to a message backend
 * (extension or Playwright), streams the AI response as task artifacts and
 * reports terminal status.
 *
 * Streaming strategy: publish the *complete snapshot* of the answer on every
 * chunk with `append: false`, only the last chunk carries `lastChunk: true`.
 * This keeps the stored artifact a single well-formed part for non-streaming
 * clients (`wab send`), while streaming clients receive progressive updates.
 */
export class BridgeExecutor implements AgentExecutor {
  /** Tasks cancelled via `tasks/cancel` before their execute() finished. */
  private cancelledTasks = new Set<string>();

  constructor(private bridge: MessageBackend) {}

  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userText = this.extractText(ctx);
    const targetAgent = this.extractMetaValue(ctx, "x-target-agent");
    const backendName = this.extractMetaValue(ctx, "x-backend");
    const timeoutMs = this.extractTimeoutMs(ctx);
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

    let publishedText: string | null = null;
    let accumulated = "";

    const publishArtifact = (text: string, lastChunk: boolean) => {
      // Skip redundant snapshots (final text equal to the last snapshot).
      if (!lastChunk && text === publishedText) return;
      publishedText = text;
      const artifactEvent: TaskArtifactUpdateEvent = {
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        artifact: {
          artifactId: `${ctx.taskId}-reply`,
          name: "response",
          description: "AI assistant response",
          parts: [textPart(text)],
          metadata: undefined,
          extensions: [],
        },
        append: false,
        lastChunk,
        metadata: undefined,
      };
      eventBus.publish(AgentEvent.artifactUpdate(artifactEvent));
    };

    try {
      const stream = this.bridge.sendAndStream({
        taskId: ctx.taskId,
        text: userText,
        timeoutMs,
        target: targetAgent,
        backend: backendName,
      });

      for await (const chunk of stream) {
        if (this.cancelledTasks.has(ctx.taskId)) {
          this.cancelledTasks.delete(ctx.taskId);
          this.publishCancelled(ctx, eventBus);
          return;
        }
        if (chunk.error) throw new Error(chunk.error);
        if (chunk.done) {
          // Final chunk carries the complete text — prefer it over deltas.
          const finalText = chunk.text || accumulated;
          publishArtifact(finalText, true);
          break;
        }
        if (chunk.text) {
          accumulated += chunk.text;
          publishArtifact(accumulated, false);
        }
      }

      if (this.cancelledTasks.has(ctx.taskId)) {
        this.cancelledTasks.delete(ctx.taskId);
        this.publishCancelled(ctx, eventBus);
        return;
      }

      const doneEvent: TaskStatusUpdateEvent = {
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: isoNow() },
        metadata: undefined,
      };
      eventBus.publish(AgentEvent.statusUpdate(doneEvent));
    } catch (err: any) {
      if (this.cancelledTasks.has(ctx.taskId)) {
        // cancelTask() already published CANCELED for this task.
        this.cancelledTasks.delete(ctx.taskId);
        return;
      }
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
            parts: [textPart(`Error: ${err.message}`)],
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
    this.cancelledTasks.add(taskId);
    // Best-effort: stop the backend work (extension page / browser tab).
    try {
      this.bridge.cancel(taskId);
    } catch (err: any) {
      console.warn(`[BridgeExecutor] Backend cancel failed: ${err?.message ?? err}`);
    }
    this.publishCancelled({ taskId, contextId: taskId }, eventBus);
  }

  private publishCancelled(
    ctx: { taskId: string; contextId: string },
    eventBus: ExecutionEventBus,
  ): void {
    const event: TaskStatusUpdateEvent = {
      taskId: ctx.taskId,
      contextId: ctx.contextId,
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

  /** Optional `x-timeout-ms` / `x-timeout-sec` routing hint from metadata. */
  private extractTimeoutMs(ctx: RequestContext): number | undefined {
    const rawMs = this.extractMetaValue(ctx, "x-timeout-ms");
    if (rawMs) {
      const n = Number(rawMs);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const rawSec = this.extractMetaValue(ctx, "x-timeout-sec");
    if (rawSec) {
      const n = Number(rawSec);
      if (Number.isFinite(n) && n > 0) return n * 1000;
    }
    return undefined;
  }
}