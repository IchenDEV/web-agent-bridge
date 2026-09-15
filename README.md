# Web Agent Bridge

**通过浏览器扩展，将在线 AI Agent（如豆包）桥接为标准 A2A 协议端点。**

Bridge online AI agents (Doubao, etc.) into standard [A2A (Agent-to-Agent)](https://google.github.io/A2A/) protocol endpoints via a Chrome extension.

---

## 为什么需要这个？

很多强大的 AI Agent 只能通过网页使用（比如豆包能操作飞书），没有开放 API。Web Agent Bridge 通过浏览器扩展 + 本地 A2A 服务器，让你可以：

- 🤖 用任何 A2A 客户端远程操控在线 AI Agent
- 🔗 让本地 Agent 与在线 Agent 协作完成任务
- 🛠️ 比如：让本地 Agent 通过 A2A 协议指挥豆包去操作飞书

```
┌──────────────────────────────────────────────────────────────┐
│                     Your Machine                             │
│                                                              │
│  ┌─────────────┐    A2A v1.0    ┌────────────────────────┐   │
│  │  A2A Client  │──────────────▶│   Local A2A Server     │   │
│  │  (any agent) │  JSON-RPC     │   (Node.js + Express)  │   │
│  └─────────────┘                └───────────┬────────────┘   │
│                                         WebSocket            │
│                                             │                │
│  ┌──────────────────────────────────────────┼────────────┐   │
│  │  Chrome Browser                          ▼            │   │
│  │  ┌───────────────────────────────────────────────┐    │   │
│  │  │  Extension (Manifest V3)                      │    │   │
│  │  │  ┌─────────────┐    ┌──────────────────────┐  │    │   │
│  │  │  │ Service      │◀──▶│  Content Script +    │  │    │   │
│  │  │  │ Worker (WS)  │    │  Doubao Adapter      │  │    │   │
│  │  │  └─────────────┘    └──────────┬───────────┘  │    │   │
│  │  └────────────────────────────────┼──────────────┘    │   │
│  │                                   │ DOM Manipulation  │   │
│  │  ┌────────────────────────────────▼──────────────┐    │   │
│  │  │  doubao.com/chat                              │    │   │
│  │  │  (Online AI Agent)                            │    │   │
│  │  └───────────────────────────────────────────────┘    │   │
│  └───────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

## 快速开始

### 环境要求

- Node.js ≥ 18
- Chrome / Chromium 浏览器
- 一个已登录的 [豆包](https://www.doubao.com/chat/) 账号

### 1. 安装依赖

```bash
git clone https://github.com/anthropic-lab/web-agent-bridge.git
cd web-agent-bridge
npm install
```

### 2. 启动 A2A 服务器

```bash
npm run server
```

服务器默认监听 `http://127.0.0.1:3000`：

| 端点 | 用途 |
|------|------|
| `GET /health` | 健康检查 |
| `GET /.well-known/agent-card.json` | A2A Agent Card |
| `POST /a2a` | A2A JSON-RPC 端点 |
| `ws://127.0.0.1:3000/ws` | Extension ↔ Server WebSocket |

### 3. 加载浏览器扩展

1. 打开 Chrome → `chrome://extensions`
2. 开启 **开发者模式**
3. 点击 **加载已解压的扩展程序** → 选择 `extension/` 目录
4. 打开 https://www.doubao.com/chat/ 并确保已登录

### 4. 测试

```bash
# 快速测试
npx tsx test/quick-test.ts

# 完整 E2E 测试
npm run test:e2e

# 测试豆包操作飞书
npx tsx test/feishu-test.ts
```

## A2A 协议

本项目实现了 [A2A v1.0](https://google.github.io/A2A/) 协议，使用 [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) v1.1.0。

### Agent Card

```json
{
  "name": "Web Agent Bridge – Doubao",
  "supportedInterfaces": [{
    "url": "http://localhost:3000/a2a",
    "protocolBinding": "JSONRPC",
    "protocolVersion": "1.0"
  }],
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [{
    "id": "doubao-chat",
    "name": "Doubao Chat",
    "description": "Send a text message to the Doubao web chat and receive the assistant's response."
  }]
}
```

### 用 A2A 客户端调用

```typescript
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role } from "@a2a-js/sdk";

const factory = new ClientFactory({
  transports: [new JsonRpcTransportFactory()],
});
const client = await factory.createFromUrl("http://127.0.0.1:3000");

const result = await client.sendMessage({
  tenant: "",
  message: {
    messageId: crypto.randomUUID(),
    contextId: crypto.randomUUID(),
    taskId: "",
    role: Role.ROLE_USER,
    parts: [{
      content: { $case: "text", value: "帮我在飞书上创建一个文档" },
      metadata: undefined,
      filename: "",
      mediaType: "text/plain",
    }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  },
  configuration: undefined,
  metadata: undefined,
});
```

## 项目结构

```
web-agent-bridge/
├── server/                    # A2A 服务器 (TypeScript)
│   ├── index.ts               #   入口：Express + WS 服务器
│   ├── agent-card.ts          #   A2A Agent Card 定义
│   ├── bridge-executor.ts     #   AgentExecutor: A2A ↔ WS 桥接
│   └── ws-bridge.ts           #   WebSocket 桥接层
├── extension/                 # Chrome 扩展 (Manifest V3)
│   ├── manifest.json          #   扩展配置
│   ├── background.js          #   Service Worker: WS 连接管理
│   ├── content.js             #   Content Script: 消息路由
│   └── adapters/
│       └── doubao.js          #   豆包 DOM 适配器
├── test/                      # 测试脚本
│   ├── e2e.ts                 #   完整 E2E 测试
│   ├── feishu-test.ts         #   飞书操作测试
│   └── quick-test.ts          #   快速连通性测试
├── package.json
└── tsconfig.json
```

## 添加新的 Web Agent 适配器

要支持新的在线 AI Agent，只需要：

1. **创建适配器** `extension/adapters/your-agent.js`，导出：
   - `sendMessage(text)` — 将文本输入到网页的输入框并发送
   - `waitForResponse(prevCount, timeoutSec)` — 等待 AI 回复并提取文本
   - `sendAndWaitForResponse(text, timeoutSec)` — 组合方法

2. **更新 `manifest.json`** 添加新的 `content_scripts` 匹配规则

3. **更新 `agent-card.ts`** 添加新的 skill

参考 `extension/adapters/doubao.js` 的实现。

## 已知限制

- ⚠️ 不支持流式响应（streaming），等待完整回复后返回
- ⚠️ DOM 选择器依赖网页结构，网站更新后可能需要调整
- ⚠️ Manifest V3 Service Worker 可能被浏览器暂停，已通过 `chrome.alarms` keepalive 缓解
- ⚠️ 单次对话模式，暂不支持多轮上下文关联

## 开发

```bash
# 启动开发服务器
npm run server

# TypeScript 类型检查
npx tsc --noEmit

# 构建
npm run build
```

## License

[MIT](LICENSE)
