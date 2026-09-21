# Web Agent Bridge

<p align="center">
  <img src="extension/icons/icon128.png" alt="Web Agent Bridge" width="80">
</p>

<p align="center">
  <strong>把网页上的 AI Agent（尤其是豆包）变成 A2A / ACP，让本地 Agent 能指挥它们操作飞书等网页能力。</strong><br>
  Bridge webpage AI agents into <a href="https://google.github.io/A2A/">A2A</a> and <a href="https://agentclientprotocol.com">ACP</a>.
</p>

<p align="center">
  <a href="#给-ai-agent-的一页纸">给 AI 的一页纸</a> ·
  <a href="#推荐路径豆包--飞书">豆包→飞书</a> ·
  <a href="#安装">安装</a> ·
  <a href="#激活与自检">激活</a> ·
  <a href="#故障排除ai-应按此顺序修">故障排除</a> ·
  <a href="#cli-参考">CLI</a>
</p>

---

## 这是干什么的？

很多能力**只有网页 Agent 能做**（豆包操作飞书文档/审批/知识库、WorkBuddy 写报告……），没有稳定 OpenAPI。

本项目在本机起一个桥：

```
本地 AI / 编辑器  ──wab / A2A / ACP──▶  本地 Server
                                         │
                    ┌────────────────────┴────────────────────┐
                    ▼                                         ▼
            Chrome 扩展 (extension)                  Playwright (browser)
                    │                                         │
                    └──────────▶ 已登录的豆包/ChatGPT/… 页面 ◀─┘
```

**主场景**：本地 Agent 用自然语言让**已登录的豆包**去操作飞书，而不是自己发明飞书 API Key。

---

## 给 AI Agent 的一页纸

读完本节即可操作。细节见后文。

### 目标状态（全部满足再发任务）

1. `which wab` 有输出，`wab --version` 正常  
2. `wab server --browser --cdp --acp` 已在跑（或等价进程）  
3. `curl -s http://127.0.0.1:9222/json/version` 成功（CDP 开着）  
4. 浏览器里已打开并**登录** https://www.doubao.com/chat/  
5. `wab health` 显示 `browser: ✅ connected`（最好 `pages` 含 `doubao`）  
6. 再执行：`wab send -b browser -a doubao "具体飞书任务…"`

### 最短激活（推荐：复用用户已登录的 Dia/Chrome）

```bash
# 在仓库根目录（首次）
npm install && npm link
npx playwright install chromium   # browser 后端需要

# 每次要用豆包前
wab cdp                                      # 给 Dia 打开 remote debugging（会短暂重启 Dia，登录态保留）
wab server --browser --cdp --acp             # 另开终端常驻
wab health                                   # 确认 browser connected
wab send -b browser -a doubao "1+1等于几？只回答数字"   # 冒烟
```

### 发飞书类任务时怎么写 prompt

对豆包说「操作说明」，不要写 API：

```bash
wab send -b browser -a doubao -T 300 \
  "打开飞书，在文档《周报》末尾追加今天三条进展，保存后把文档链接发回给我"
```

原则：指明对象（文档/群/审批名）→ 要做什么 → 要求返回可验证结果（链接/原文摘要）。一步一事；失败再拆小步。

### 失败时 AI 必须做的事

1. 把 **stderr / `wab health` / 关键错误原文** 贴给用户（或自己读）  
2. 按 [故障排除](#故障排除ai-应按此顺序修) **从上到下** 修，不要跳步重装一切  
3. 需要用户手动登录/点验证码时：**停下来请用户操作**，不要伪造 cookie  
4. 页面结构变了（选择器失效）：用 DevTools 看 DOM，改 `server/browser-adapters/doubao.ts` 与 `extension/adapters/doubao.js`，再冒烟  

Agent Skill（更细的操作手册）：[`skills/web-agent-bridge/SKILL.md`](skills/web-agent-bridge/SKILL.md)

```bash
mkdir -p ~/.agents/skills ~/.cursor/skills
ln -sfn "$(pwd)/skills/web-agent-bridge" ~/.agents/skills/web-agent-bridge
ln -sfn "$(pwd)/skills/web-agent-bridge" ~/.cursor/skills/web-agent-bridge
```

---

## 推荐路径：豆包 → 飞书

| 步骤 | 谁做 | 做什么 |
|------|------|--------|
| 1 | 用户 | Dia/Chrome 已登录豆包；豆包侧已能打开飞书（插件/企业绑定按用户日常用法） |
| 2 | AI/用户 | `wab cdp` → `wab server --browser --cdp --acp` |
| 3 | AI | `wab health` 确认 browser |
| 4 | AI | `wab send -b browser -a doubao "…飞书任务…"` |
| 5 | 豆包 | 在真实浏览器里点飞书；结果经 stdout 回到本地 Agent |

**不要**默认 `wab login` 开一个全新无登录浏览器——飞书企业能力通常绑在用户日常浏览器会话上。  
仅在没有 Dia、或明确要独立 profile 时用 `wab login doubao`。

其它 Agent：`chatgpt` / `gemini` / `workbuddy`，同样 `-a` / `-b`。

---

## 安装

### 要求

- macOS（`wab cdp` 针对 Dia；Chrome 可用手动 `--remote-debugging-port=9222`）  
- Node.js ≥ 18  
- 网络能访问豆包 / 目标站点  

### 从源码安装（开发/自用）

```bash
git clone https://github.com/IchenDEV/web-agent-bridge.git
cd web-agent-bridge
npm install
npm link                    # 注册全局命令 wab
npx playwright install chromium
wab --version
```

### 从 npm（若已发布）

```bash
npm install -g web-agent-bridge
npx playwright install chromium
```

### 可选：Chrome 扩展后端

若不用 CDP、只用扩展：

1. `chrome://extensions` → 开发者模式 →「加载已解压」→ 选仓库 `extension/`  
2. `wab server`（不要加 `--browser-only`）  
3. 打开并登录豆包页；扩展图标无 ❗  

图标：无标记=已连服务器；❗=服务器没开；…=连接中。

---

## 激活与自检

### A. CDP + Playwright（推荐）

```bash
# 1) CDP 是否已开？
curl -s http://127.0.0.1:9222/json/version || wab cdp

# 2) 是否有豆包标签？
curl -s http://127.0.0.1:9222/json/list | grep -i doubao || open "https://www.doubao.com/chat/"

# 3) 起服务
wab server --browser --cdp --acp
# 日志应类似：Attached over CDP ... — open: doubao

# 4) 健康检查
wab health
# 期望：browser: ✅ connected

# 5) 冒烟
wab send -b browser -a doubao "只回复：pong"
```

### B. 扩展后端

```bash
wab server
# 加载 extension/，打开已登录豆包页
wab health    # Extension: ✅
wab send -a doubao "只回复：pong"
```

### C. 独立 Playwright 配置（无 Dia）

```bash
wab login doubao          # 弹出浏览器，用户手动登录后关掉窗口保存状态
wab server --browser      # 无 --cdp 时用 storage-state
wab send -b browser -a doubao "只回复：pong"
```

### `wab health` 怎么读

| 输出 | 含义 | 下一步 |
|------|------|--------|
| Server not reachable | 没起服务 | `wab server ...` |
| browser not connected | 没挂上 Playwright/CDP | `wab cdp` 后重启带 `--browser --cdp` 的 server |
| extension not connected | 扩展没连上 | 加载扩展、开 Agent 页、检查扩展设置里的 URL |
| connected 但 send 超时 | 页未登录 / DOM 变了 / 网慢 | 见故障排除 |

也可用：`curl -s http://127.0.0.1:3000/health | jq`。

---

## 使用方法

### CLI（AI 首选）

```bash
wab send -b browser -a doubao "帮我……"     # stdout = 纯文本回复
wab send -j -a doubao "…"                  # JSON（含 contextId，多轮用 -c）
wab send -c <contextId> "继续"             # 多轮
wab send -T 300 -a doubao "长任务……"      # 加长超时
echo "写一首诗" | wab send
```

### ACP（编辑器）

```bash
wab acp                         # 转发到已运行的 wab server
wab acp -b browser --cdp auto   # 本进程直接 Playwright
# HTTP：wab server --acp → POST http://127.0.0.1:3000/acp
```

会话 `_meta`：`x-target-agent`、`x-backend`。斜杠：`/status` `/agent` `/backend`。

### A2A

- Card：`GET http://127.0.0.1:3000/.well-known/agent-card.json`  
- JSON-RPC：`POST /a2a`  
- 也可用 [agentalk](https://www.npmjs.com/package/agentalk)

### 支持的站点

| Agent | URL | `-a` | 典型用途 |
|-------|-----|------|----------|
| 豆包 | https://www.doubao.com/chat/ | `doubao` | **飞书操作**、对话、插件 |
| ChatGPT | https://chatgpt.com/ | `chatgpt` | 对话 |
| Gemini | https://gemini.google.com/app | `gemini` | 对话 |
| WorkBuddy | https://www.workbuddy.cn/app | `workbuddy` | 报告 / 研究 |

---

## 故障排除（AI 应按此顺序修）

每步做完再 `wab health` 或重试 `wab send`。需要人交互时**明确请用户**。

### 1. 命令不存在

```text
wab: command not found
```

```bash
cd /path/to/web-agent-bridge && npm link
hash -r && which wab
```

### 2. 服务器不可达

```text
Server not reachable at http://127.0.0.1:3000
```

- 另开终端：`wab server --browser --cdp --acp`  
- 端口占用：换 `-p 3001`，发送加 `-s http://127.0.0.1:3001`  
- 看 server 终端是否有启动报错（缺依赖则 `npm install`）

### 3. CDP / 浏览器附着失败

```text
No CDP endpoint / CDP attach failed / browser not connected
```

| 检查 | 命令 / 动作 |
|------|-------------|
| 9222 是否通 | `curl -s http://127.0.0.1:9222/json/version` |
| 不通 | `wab cdp`（会重启 Dia；保留用户数据目录） |
| 仍不通 | 用户手动：`open -a Dia --args --remote-debugging-port=9222` 或 Chrome 同理 |
| 通了但 server 仍旧 | **重启** `wab server --browser --cdp`（CDP 要在 server 启动前就绪） |
| Playwright 缺失 | `npm install` + `npx playwright install chromium` |

注意：`wab cdp` 会短暂退出 Dia；告诉用户「窗口会闪一下，登录态还在」。

### 4. 未登录 / 登录过期

症状：打开的是登录页；回复让登录；或一直超时无助手气泡。

**AI 不要自己填密码。** 请用户：

1. 在 Dia 里打开豆包，完成登录（含扫码/SSO）  
2. 确认能手动发一句聊天  
3. 若走飞书：在豆包里手动点开一次飞书/相关插件，确认有权限  
4. 再 `wab send …`

独立 profile：`wab login doubao` 后等用户在弹出窗登录。

### 5. 没有豆包标签

```text
no agent tabs / pages 不含 doubao
```

```bash
open "https://www.doubao.com/chat/"
# 等页面可输入后
wab send -b browser -a doubao "只回复：ok"
```

Backend 也可在发送时 `newPage` 打开 URL，但**新标签可能没有企业登录态**——优先复用已有标签。

### 6. 发送超时 / 无新回复

```text
Timeout: no new assistant message
Timeout after Ns
```

按概率：

1. **网慢 / 豆包回答长**：`-T 300` 或更高；任务拆短  
2. **页面还在加载**：等输入框出现再发；刷新豆包页  
3. **旧对话太乱**：用户点「新对话」再试  
4. **发不出去**：看是否卡住验证码、上传、权限弹窗 → 请用户点掉  
5. **DOM/选择器过时**（站点改版）：  
   - CDP 下用 DevTools 看输入框、发送按钮、助手消息节点  
   - 改 `server/browser-adapters/doubao.ts`（及扩展侧 `extension/adapters/doubao.js`）  
   - 本地冒烟：`LIVE=1 npm run test:acp:live`  
6. **连错后端**：显式 `-b browser -a doubao`，避免 auto 指到未就绪的 extension  

### 7. 扩展 ❗

- 先保证 `wab server`（非 `--browser-only`）在跑  
- 扩展设置里服务器 URL 与实际端口一致  
- `chrome://extensions` 重载扩展 → 刷新豆包页  

### 8. 页面/浏览器版本怪异

- 仅支持 Chromium 系（Chrome / Dia / Edge）；不要对 Safari 寄 CDP 期望  
- 企业策略禁用 remote debugging → 改用扩展后端或 `wab login`  
- 多开 Chromium 抢 9222：`lsof -i :9222`，关掉多余实例或换 `WAB_CDP_PORT`  

### 9. ACP / 协议

- stdio 日志在 **stderr**，不要当 JSON-RPC 解析  
- HTTP 下 `available_commands_update` 在**首次 prompt** 才保证到达（不是 `session/new` 当时）  
- `providers` / `nes` 为 stub；不要依赖改 LLM 供应商配置  

### 10. 仍然失败时收集的信息

请用户或 AI 汇总后重试/提 issue：

```bash
wab --version
node -v
wab health -j
curl -s http://127.0.0.1:9222/json/version
curl -s http://127.0.0.1:9222/json/list | head
# server 终端最后 50 行
# 失败命令的完整 stderr
```

---

## CLI 参考

```
wab <command> [options]

Commands:
  server              启动本地服务
  send <message>      发送并打印 AI 回复（stdout 纯文本）
  acp                 ACP（stdin/stdout，给编辑器）
  cdp                 重启 Dia 并打开 remote debugging
  login [agent]       Playwright 登录并保存 storage-state
  agent               Agent Card
  health              健康检查
  pack / publish      打包扩展 / 发布 npm

server:
  -p, --port          默认 3000
  --browser           启用 Playwright
  --browser-only      仅 Playwright
  --cdp [url|auto]    附着已开浏览器
  --acp               启用 /acp

send:
  -a, --agent         doubao|chatgpt|gemini|workbuddy
  -b, --backend       extension|browser
  -s, --server        默认 http://127.0.0.1:3000
  -c, --context       多轮 contextId
  -T, --timeout       秒，默认 180
  -j, --json

环境变量:
  WAB_SERVER  PORT  CDP_URL  WAB_USER_DATA_DIR  WAB_HEADLESS=0  WAB_CDP_PORT
```

---

## 架构与端点

| 端点 | 用途 |
|------|------|
| `GET /health` | 健康与后端状态 |
| `GET /.well-known/agent-card.json` | A2A Card |
| `POST /a2a` | A2A JSON-RPC |
| `POST /acp` · `ws://…/acp` | ACP（需 `--acp`） |
| `ws://…/ws` | 扩展通道 |

ACP v1：会话 `new/list/load/resume/close/delete/fork`、`prompt/cancel`、配置与斜杠命令。不提供 fs/terminal/工具权限（网页桥接场景）。

---

## 添加新适配器 / 开发

扩展适配器：`extension/adapters/` + `manifest.json` / `background.js`。  
Playwright 适配器：`server/browser-adapters/`（`page.evaluate` 内勿写命名内部函数，避免 tsx `__name`）。  
Agent Card：`server/agent-card.ts`。

```bash
npm run test:acp
LIVE=1 npm run test:acp:live    # 需 CDP + 已登录豆包
LIVE=1 npm run test:e2e:acp
wab pack
```

项目结构见仓库内 `server/`、`extension/`、`bin/cli.mjs`、`skills/`、`test/`。

---

## License

[MIT](LICENSE)
