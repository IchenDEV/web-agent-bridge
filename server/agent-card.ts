import type { AgentCard } from "@a2a-js/sdk";

export const PORT = Number(process.env.PORT || 3000);

export const agentCard: AgentCard = {
  name: "Web Agent Bridge",
  description:
    "Bridges online web AI agents (Doubao, ChatGPT, Gemini, WorkBuddy, Perplexity, Kimi, Qianwen) to A2A. " +
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
  version: "3.21.0",
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
      id: "chatgpt-chat",
      name: "ChatGPT Chat",
      description:
        "Send a message to OpenAI ChatGPT and receive the assistant's response.",
      tags: ["chat", "chatgpt", "openai", "gpt"],
      examples: ["Explain quantum computing in simple terms", "Write a Python function to sort a list"],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    },
    {
      id: "gemini-chat",
      name: "Gemini Chat",
      description:
        "Send a message to Google Gemini and receive the assistant's response.",
      tags: ["chat", "gemini", "google"],
      examples: ["What is the capital of France?", "Help me plan a trip to Tokyo"],
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
    {
      id: "perplexity-search",
      name: "Perplexity Search",
      description:
        "Send a query to Perplexity web search and receive a cited research-style answer.",
      tags: ["chat", "perplexity", "search", "research"],
      examples: ["What happened in AI this week?", "Compare Claude and GPT for coding"],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    },
    {
      id: "kimi-chat",
      name: "Kimi Chat",
      description:
        "Send a message to Kimi (月之暗面) web chat and receive the assistant's response.",
      tags: ["chat", "kimi", "moonshot", "月之暗面"],
      examples: ["总结这篇长文档的要点", "帮我做一个调研大纲"],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    },
    {
      id: "qianwen-chat",
      name: "Qianwen Chat",
      description:
        "Send a message to 通义千问 (Qianwen / Qwen) web chat and receive the assistant's response.",
      tags: ["chat", "qianwen", "qwen", "tongyi", "通义千问"],
      examples: ["用中文解释量子计算", "帮我写一封商务邮件"],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    },
  ],
  signatures: [],
};
