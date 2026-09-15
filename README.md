# Web Agent Bridge

**通过浏览器扩展，将在线 AI Agent（豆包、WorkBuddy 等）桥接为标准 A2A 协议端点。**

Bridge online AI agents (Doubao, WorkBuddy, etc.) into standard [A2A (Agent-to-Agent)](https://google.github.io/A2A/) protocol endpoints via a Chrome extension.

---

## 为什么需要这个？

很多强大的 AI Agent 只能通过网页使用（比如豆包能操作飞书、WorkBuddy 能生成报告），没有开放 API。Web Agent Bridge 通过浏览器扩展 + 本地 A2A 服务器，让你可以：

- 🤖 用任何 A2A 客户端远程操控在线 AI Agent
- 🔗 让本地 Agent 与在线 Agent 协作完成任务
- 🛠️ 比如：让本地 Agent 通过 A2A 协议指挥豆包去操作飞书
- 🏢 通过 WorkBuddy 让 Agent 生成 PPT、数据分析报告等办公成果

## 架构概览

```
┌──────────────────────────────────────────────────────────────┐
│                        Your Machine                          │
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
│  │  │  │ Worker (WS)  │    │  DOM Adapter         │  │    │   │
│  │  │  └─────────────┘    └──────────┬───────────┘  │    │   │
│  │  └────────────────────────────────┼──────────────┘    │   │
│  │                                   │ DOM Manipulation  │   │
│  │  ┌────────────────────────────────▼──────────────┐    │   │
│  │  │  doubao.com / workbuddy.cn / ...              │    │   │
│  │  │  (Online AI Agent)                            │    │   │
│  │  └───────────────────────────────────────────────┘    │   │
│  └───────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

## 已支持的 AI Agent

| Agent | 网站 | 技能 ID | 说明 |
|-------|------|---------|------|
| 豆包 (Doubao) | [doubao.com/chat](https://www.doubao.com/chat/) | `doubao-chat` | 对话、飞书操作等 |
| WorkBuddy | [workbuddy.cn/app](https://www.workbuddy.cn/app) | `workbuddy-task` | 文档生成、数据分析、深度研究等 |

## 快速开始

### 环境要求

- **Node.js** ≥ 18
- **Chrome** / Chromium 浏览器
- 一个已登录的 AI Agent 账号（[豆包](https://www.doubao.com/chat/) 或 [WorkBuddy](https://www.workbuddy.cn/app)）

### 第一步：安装依赖

```bash
git clone https://github.com/IchenDEV/web-agent-bridge.git
cd web-agent-bridge
npm install
```

### 第二步：启动 A2A 服务器

```bash
npm run server
```

服务器默认监听 `http://127.0.0.1:3000`：

| 端点 | 用途 |
|------|------|
| `GET /health` | 健康检查（含扩展连接状态） |
| `GET /.well-known/agent-card.json` | A2A Agent Card |
| `POST /a2a` | A2A JSON-RPC 端点 |
| `ws://127.0.0.1:3000/ws` | 浏览器扩展 ↔ 服务器 WebSocket |

### 第三步：安装浏览器扩展

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序** → 选择项目中的 `extension/` 目录
4. 确认扩展列表中出现 **"Web Agent Bridge"**

### 第四步：打开 AI Agent 页面

打开以下任一页面并确保已登录：

- **豆包**: https://www.doubao.com/chat/
- **WorkBuddy**: https://www.workbuddy.cn/app

> 💡 扩展会自动连接服务器。你可以通过 `curl http://127.0.0.1:3000/health` 查看连接状态：
> ```json
> {"ok": true, "extensionConnected": true}
> ```

### 第五步：发送消息

#### 使用测试脚本

```bash
# 快速测试（向豆包发送一条消息）
npx tsx test/quick-test.ts

# 完整 E2E 测试
npm run test:e2e

# A2A 协议合规验证（91项检查）
npx tsx test/a2a-protocol-verify.ts
```

#### 使用 A2A 客户端 SDK

```typescript
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role } from "@a2a-js/sdk";

// 创建 A2A 客户端
const factory = new ClientFactory({
  transports: [new JsonRpcTransportFactory()],
});
const client = await factory.createFromUrl("http://127.0.0.1:3000");

// 发送消息
const result = await client.sendMessage({
  tenant: "",
  message: {
    messageId: crypto.randomUUID(),
    contextId: crypto.randomUUID(),
    taskId: "",
    role: Role.ROLE_USER,
    parts: [{
      content: { $case: "text", value: "帮我写一首关于秋天的诗" },
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

// 提取回复
const task = result.result;
if (task?.artifacts?.[0]) {
  const replyPart = task.artifacts[0].parts[0];
  if (replyPart.content?.$case === "text") {
    console.log("AI 回复:", replyPart.content.value);
  }
}
```

#### 使用 curl（直接 JSON-RPC）

```bash
curl -X POST http://127.0.0.1:3000/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "SendMessage",
    "params": {
      "message": {
        "messageId": "msg-001",
        "contextId": "ctx-001",
        "taskId": "",
        "role": "ROLE_USER",
        "parts": [{"text": "1+1等于几？", "mediaType": "text/plain"}]
      }
    }
  }'
```

## A2A 协议

本项目实现了 [A2A v1.0](https://google.github.io/A2A/) 协议，使用 [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) v1.1.0。

### 已实现的能力

| 能力 | 状态 | 说明 |
|------|------|------|
| Agent Card Discovery | ✅ | `/.well-known/agent-card.json` |
| SendMessage | ✅ | 发送消息并等待完整回复 |
| GetTask | ✅ | 按 ID 查询任务 |
| ListTasks | ✅ | 按 contextId 列出任务 |
| CancelTask | ✅ | 取消运行中的任务 |
| Task 生命周期 | ✅ | WORKING → COMPLETED/FAILED/CANCELED |
| Artifact 输出 | ✅ | 文本回复作为 artifact 返回 |
| Message 历史 | ✅ | 保留 user message 和 error message |
| contextId 共享 | ✅ | 多任务共享上下文 |
| metadata 透传 | ✅ | 自定义元数据支持 |
| JSON-RPC 错误处理 | ✅ | 标准错误码 (-32601 等) |
| A2A-Version 协商 | ✅ | 支持版本头 |
| Streaming (SSE) | 🚧 | WS 层已就绪，adapter 层开发中 |
| Push Notifications | ❌ | 暂未实现 |
| File Parts | 🚧 | 架构已设计，开发中 |

### Agent Card

```json
{
  "name": "Web Agent Bridge",
  "version": "0.3.0",
  "supportedInterfaces": [{
    "url": "http://localhost:3000/a2a",
    "protocolBinding": "JSONRPC",
    "protocolVersion": "1.0"
  }],
  "skills": [
    { "id": "doubao-chat", "name": "Doubao Chat" },
    { "id": "workbuddy-task", "name": "WorkBuddy Task" }
  ]
}
```

## 项目结构

```
web-agent-bridge/
├── server/                    # A2A 服务器 (TypeScript)
│   ├── index.ts               #   入口：Express + WS 服务器
│   ├── agent-card.ts          #   A2A Agent Card 定义
│   ├── bridge-executor.ts     #   AgentExecutor: A2A ↔ WS 桥接
│   └── ws-bridge.ts           #   WebSocket 桥接层（支持流式）
├── extension/                 # Chrome 扩展 (Manifest V3)
│   ├── manifest.json          #   扩展配置（多站点支持）
│   ├── background.js          #   Service Worker: WS 连接 + 多站点路由
│   ├── content.js             #   Content Script: 适配器自动检测
│   └── adapters/
│       ├── doubao.js          #   豆包 DOM 适配器
│       └── workbuddy.js       #   WorkBuddy DOM 适配器
├── test/                      # 测试脚本
│   ├── quick-test.ts          #   快速连通性测试
│   ├── e2e.ts                 #   完整 E2E 测试
│   ├── feishu-test.ts         #   飞书操作测试
│   └── a2a-protocol-verify.ts #   A2A v1.0 协议合规验证（91项）
├── package.json
├── tsconfig.json
├── LICENSE                    # MIT
└── CONTRIBUTING.md
```

## 添加新的 Web Agent 适配器

要支持新的在线 AI Agent，只需三步：

### 1. 创建适配器

在 `extension/adapters/` 下创建 `your-agent.js`：

```javascript
const YourAgentAdapter = (() => {
  // 必须实现以下公开方法：
  async function sendMessage(text) {
    // 找到输入框 → 输入文本 → 点击发送
  }

  async function waitForResponse(prevCount, timeoutSec = 120) {
    // 等待新的 AI 回复出现 → 等待内容稳定 → 提取文本
  }

  async function sendAndWaitForResponse(text, timeoutSec = 120) {
    const prevCount = /* 当前已有的回复数量 */;
    await sendMessage(text);
    return waitForResponse(prevCount, timeoutSec);
  }

  return { sendMessage, waitForResponse, sendAndWaitForResponse };
})();
```

### 2. 更新扩展配置

**`extension/manifest.json`** — 添加 `host_permissions` 和 `content_scripts`：

```json
{
  "host_permissions": [
    "*://your-agent.com/*"
  ],
  "content_scripts": [
    {
      "matches": ["*://your-agent.com/*"],
      "js": ["adapters/your-agent.js", "content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

**`extension/background.js`** — 在 `AGENT_TAB_PATTERNS` 中添加：

```javascript
{
  name: "your-agent",
  pattern: "*://your-agent.com/*",
  scripts: ["adapters/your-agent.js", "content.js"],
}
```

### 3. 添加技能

**`server/agent-card.ts`** — 在 `skills` 数组中添加：

```typescript
{
  id: "your-agent-skill",
  name: "Your Agent",
  description: "...",
  tags: ["..."],
  examples: ["..."],
  inputModes: [],
  outputModes: [],
  securityRequirements: [],
}
```

参考 `extension/adapters/doubao.js` 和 `extension/adapters/workbuddy.js` 的实现。

## 故障排除

### 扩展未连接

```bash
curl http://127.0.0.1:3000/health
# 如果 extensionConnected: false
```

**解决方案**：
1. 确认服务器已启动（`npm run server`）
2. 在 `chrome://extensions` 中检查扩展是否启用
3. 点击扩展的"重新加载"按钮
4. 刷新 AI Agent 页面

### 内容脚本未加载

错误信息：`Content script unreachable`

**解决方案**：
1. 扩展更新后需要在 `chrome://extensions` 中**重新加载**
2. 然后**刷新** AI Agent 页面
3. 扩展会自动尝试注入内容脚本

### DOM 选择器失效

如果 AI Agent 网站更新了页面结构，可能需要更新对应的适配器文件中的选择器。通过浏览器 DevTools 检查新的 DOM 结构并修改 `adapters/*.js`。

### MV3 Service Worker 休眠

Chrome Manifest V3 的 Service Worker 可能被浏览器暂停。本项目通过 `chrome.alarms` 实现了 keepalive 机制（每 20 秒 ping 一次），大幅降低了这种情况的发生。

## 已知限制

- ⚠️ DOM 选择器依赖网页结构，网站更新后可能需要调整
- ⚠️ 流式响应（streaming）尚在开发中，目前等待完整回复后返回
- ⚠️ 单次对话模式，暂不支持多轮上下文关联
- ⚠️ 每次只能处理一个任务（串行执行）

## 开发

```bash
# 启动开发服务器
npm run server

# TypeScript 类型检查
npx tsc --noEmit

# 快速测试
npx tsx test/quick-test.ts

# A2A 协议验证
npx tsx test/a2a-protocol-verify.ts
```

## License

[MIT](LICENSE)
