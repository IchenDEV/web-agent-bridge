import type { AgentCard } from "@a2a-js/sdk";

export const PORT = Number(process.env.PORT || 3000);

export const agentCard: AgentCard = {
  name: "Web Agent Bridge – Doubao",
  description:
    "Bridges the Doubao (豆包) web chat to A2A. " +
    "Send a message and receive the AI assistant's reply.",
  supportedInterfaces: [
    {
      url: `http://localhost:${PORT}/a2a`,
      protocolBinding: "JSONRPC",
      tenant: "",
      protocolVersion: "1.0",
    },
  ],
  provider: undefined,
  version: "0.2.0",
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
        "Send a text message to the Doubao web chat and receive the assistant's response.",
      tags: ["chat", "doubao", "豆包"],
      examples: ["1+1等于几？", "帮我写一首诗"],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    },
  ],
  signatures: [],
};
