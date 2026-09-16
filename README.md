# Web Agent Bridge

<p align="center">
  <img src="extension/icons/icon128.png" alt="Web Agent Bridge" width="80">
</p>

<p align="center">
  <strong>把网页上的 AI Agent 变成标准 A2A 协议端点，让任何 Agent 都能调用它们。</strong><br>
  Bridge online AI agents into standard <a href="https://google.github.io/A2A/">A2A</a> protocol endpoints via a Chrome extension.
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#支持的-ai-agent">支持的 Agent</a> ·
  <a href="#使用方法">使用方法</a> ·
  <a href="#添加新适配器">添加新适配器</a> ·
  <a href="#开发">开发</a>
</p>

---

## 为什么需要这个？

很多强大的 AI Agent 只能通过网页操作（比如豆包能操作飞书、WorkBuddy 能生成报告），没有开放 API。

Web Agent Bridge 通过**浏览器扩展 + 本地服务器**，让你可以：

- 🤖 用任何 A2A 客户端远程操控在线 AI Agent
- 🔗 让本地 Agent 与在线 Agent 协作完成任务
- 🛠️ 例如：让本地 Agent 通过 A2A 协议指挥豆包去操作飞书

## 架构

```
A2A Client ──JSON-RPC──▶ Local Server ──WebSocket──▶ Chrome Extension ──DOM──▶ Online AI Agent
```

## 支持的 AI Agent

| Agent | 网站 | 说明 |
|-------|------|------|
| 🫘 豆包 (Doubao) | [doubao.com/chat](https://www.doubao.com/chat/) | 对话、飞书操作等 |
| 💼 WorkBuddy | [workbuddy.cn/app](https://www.workbuddy.cn/app) | 文档生成、数据分析、深度研究 |

> 添加新 Agent 只需写一个 JS 适配器，参见 [添加新适配器](#添加新适配器)。

## 快速开始

### 1. 安装 & 启动服务器

```bash
git clone https://github.com/IchenDEV/web-agent-bridge.git
cd web-agent-bridge
npm install
npm link          # 注册 wab 命令（可选）
wab server        # 或 npm run server
```

> 服务器默认在 `http://127.0.0.1:3000` 启动。可以用 `wab server -p 8080` 更改端口。

### 2. 安装浏览器扩展

1. Chrome 地址栏输入 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点击 **「加载已解压的扩展程序」** → 选择项目中的 `extension/` 目录
4. 确认扩展列表中出现 **Web Agent Bridge**，图标旁无 ❗ 标记

> 💡 **图标提示**：扩展图标上的标记代表连接状态
> - 无标记 = ✅ 已连接
> - **!** 红色 = ❌ 服务器未运行或断开
> - **…** 黄色 = 🔄 正在连接中

### 3. 打开 AI Agent 页面

打开以下任一页面并**确保已登录**：

- 豆包: https://www.doubao.com/chat/
- WorkBuddy: https://www.workbuddy.cn/app

### 4. 发送消息

#### 方式一：`wab` CLI（推荐，AI 可直接调用）

```bash
# 直接发问，stdout 返回纯文本
wab send "1+1等于几？"
# → 2

# 指定目标 Agent
wab send -a doubao "帮我操作飞书"
wab send -a workbuddy "写一份周报"

# 管道输入
echo "写一首关于秋天的诗" | wab send

# 多轮对话
wab send -c ctx-abc "继续说"

# JSON 输出（供程序解析）
wab send --json "hello"
```

> 💡 `wab send` 输出纯文本，AI Agent 可以直接解析 stdout，无需构造 HTTP 请求。

#### 方式二：使用 agentalk（通用 A2A CLI 客户端）

```bash
# 安装
npm install -g agentalk

# 查看 Agent 能力
agentalk agent http://127.0.0.1:3000

# 发送消息
agentalk send http://127.0.0.1:3000 -m "帮我写一首诗"

# 流式响应
agentalk stream http://127.0.0.1:3000 -m "生成一份分析报告"
```

> [agentalk](https://www.npmjs.com/package/agentalk) 是通用 A2A 协议 CLI 工具，支持流式响应、任务管理等完整功能。

#### 方式三：curl / HTTP

```bash
curl -X POST http://127.0.0.1:3000/a2a \
  -H "Content-Type: application/json" \
  -H "A2A-Version: 1.0" \
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

### 确认连接状态

```bash
wab health
# 或
curl http://127.0.0.1:3000/health
```

或点击 Chrome 工具栏的扩展图标，在弹出面板中查看连接状态。

## CLI 命令参考

```
wab <command> [options]

Commands:
  server              启动 A2A 服务器
  send <message>      发送消息并输出 AI 回复（纯文本）
  agent               显示 Agent Card（能力 & 技能）
  health              检查服务器和扩展连接状态
  pack                打包扩展为 ZIP
  publish [--dry-run] 类型检查 + 打包 + 发布到 npm

Options (send):
  -a, --agent <name>  目标 Agent: doubao | workbuddy（默认自动检测）
  -m, --message <msg> 消息文本
  -s, --server <url>  服务器地址 (默认 http://127.0.0.1:3000)
  -c, --context <id>  上下文 ID（多轮对话）
  -T, --timeout <sec> 超时秒数 (默认 180)
  -j, --json          输出原始 JSON

环境变量:
  WAB_SERVER              默认服务器 URL
  PORT                    服务器端口
```

## 扩展设置

点击扩展图标 → **「设置」** 按钮，可以修改：

- **服务器地址**：默认 `http://127.0.0.1:3000`，修改后扩展自动重连

### A2A 端点

| 端点 | 用途 |
|------|------|
| `GET /health` | 健康检查（含扩展连接状态） |
| `GET /.well-known/agent-card.json` | A2A Agent Card |
| `POST /a2a` | A2A JSON-RPC 端点 |
| `ws://127.0.0.1:3000/ws` | 扩展 ↔ 服务器 WebSocket |

## 添加新适配器

支持新的在线 AI Agent 只需 3 步：

### 1. 创建适配器文件

在 `extension/adapters/` 下创建 `your-agent.js`：

```javascript
const YourAgentAdapter = (() => {
  async function sendAndWaitForResponse(text, timeoutSec = 120) {
    // 1. 找到输入框
    // 2. 清空 → 输入文本 → 点击发送
    // 3. 等待新的 AI 回复出现
    // 4. 等待回复文本稳定（流式输出结束）
    // 5. 提取并返回文本
  }

  return { sendAndWaitForResponse };
})();
```

### 2. 注册到扩展

**`manifest.json`** — 添加 host_permissions 和 content_scripts

**`background.js`** — 在 `AGENT_TAB_PATTERNS` 中添加匹配规则

**`content.js`** — adapter 变量会自动检测全局对象（如 `YourAgentAdapter`）

### 3. 添加 Agent Card 技能

**`server/agent-card.ts`** — 在 `skills` 数组中添加新技能描述

> 参考 `extension/adapters/doubao.js` 和 `workbuddy.js` 的实现。

## 项目结构

```
web-agent-bridge/
├── server/                    # A2A 服务器 (TypeScript)
│   ├── index.ts               #   入口：Express + WS
│   ├── agent-card.ts          #   Agent Card
│   ├── bridge-executor.ts     #   A2A ↔ WS 桥接
│   └── ws-bridge.ts           #   WebSocket 桥接层
├── extension/                 # Chrome 扩展 (Manifest V3)
│   ├── manifest.json          #   扩展配置
│   ├── background.js          #   Service Worker
│   ├── content.js             #   Content Script
│   ├── popup.html / popup.js  #   状态弹窗
│   ├── options.html / options.js  # 设置页
│   ├── icons/                 #   扩展图标
│   └── adapters/
│       ├── doubao.js          #   豆包适配器
│       └── workbuddy.js       #   WorkBuddy 适配器
├── test/                      # 测试脚本
├── bin/cli.mjs                # CLI 入口 (send/agent/health/server)
├── package.json
└── LICENSE                    # MIT
```

## 故障排除

### 扩展图标显示 ❗

服务器未运行。运行 `npm run server` 后扩展会自动重连。

### 发送消息后超时

1. 确认 AI Agent 页面已打开并**已登录**
2. 确认页面不是空白/加载中状态
3. 在 `chrome://extensions` 中重新加载扩展，然后刷新 AI Agent 页面
4. 打开一个**新的对话**（旧对话消息太多可能影响检测）

### DOM 选择器失效

AI Agent 网站更新后可能需要调整适配器中的选择器。用 DevTools 检查新的 DOM 结构，修改 `adapters/*.js` 中的 `SELECTORS`。

## 开发

```bash
wab server                              # 启动开发服务器
wab health                              # 检查连接
wab send "test"                         # 快速测试
wab send -a doubao "test"               # 指定 Agent
npx tsx test/stress-test.ts             # 鲁棒性压力测试 (5 条连发)
npx tsx test/a2a-protocol-verify.ts     # A2A 协议合规 (91 项)
wab pack                                # 打包扩展
wab publish --dry-run                   # 试跑发布流程
```

## License

[MIT](LICENSE)
