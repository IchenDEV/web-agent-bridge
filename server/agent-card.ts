import type { AgentCard } from "@a2a-js/sdk";

export const PORT = Number(process.env.PORT || 3000);

export const agentCard: AgentCard = {
  name: "Web Agent Bridge",
  description:
    "Bridges online web AI agents (Doubao, WorkBuddy, etc.) to A2A. " +
    "Send a message and receive the AI assistant's reply via browser automation.",
  supportedInterfaces: [
    {
      url: `http://localhost:${PORT}/a2a`,
      protocolBinding: "JSONRPC",
      tenant: "",
      protocolVersion: "1.0",
    },
  ],
  provider: undefined,
  version: "0.3.0",
  capabilities: {
    streaming: false,
    pushNotifications: false,
    extensions: [],
  },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "doubao-chat",
      name: "Doubao Chat",
      description:
        "Send a text message to the Doubao (豆包) web chat and receive the assistant's response.",
      tags: ["chat", "doubao", "豆包"],
      examples: ["1+1等于几？", "帮我写一首诗"],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    },
    {
      id: "workbuddy-task",
      name: "WorkBuddy Task",
      description:
        "Send a task to Tencent WorkBuddy AI workspace and receive the result. " +
        "Supports document generation, data analysis, deep research, and more.",
      tags: ["task", "workbuddy", "tencent", "office", "腾讯"],
      examples: [
        "帮我写一份项目周报",
        "分析这份数据并生成图表",
        "深度研究 AI Agent 行业趋势",
      ],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    },
  ],
  signatures: [],
};
