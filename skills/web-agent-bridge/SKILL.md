---
name: web-agent-bridge
description: >-
  Drive Doubao (豆包) and other webpage AI agents via the wab CLI so a local agent
  can operate Feishu/Lark, docs, approvals, and similar site workflows that have
  no public API. Use when the user wants 豆包操作飞书, Doubao browser automation,
  wab/web-agent-bridge, CDP Dia/Chrome, or bridging webpage AI into A2A/ACP.
metadata:
  requires:
    bins: ["wab"]
---

# Web Agent Bridge (`wab`)

Primary use case: **local coding agent → `wab` → Doubao (豆包) webpage → Feishu/Lark (and other tools Doubao can use)**.

Doubao is already logged into the user's browser and can click around Feishu (docs, messenger, approvals, knowledge base, etc.). There is often no usable Doubao/Feishu API for that path — so the agent sends **natural-language task prompts** through `wab`, and Doubao executes them in the open tab.

Same pattern applies to other sites behind adapters (`chatgpt`, `gemini`, `workbuddy`).

## When to use this skill

- 「用豆包帮我改飞书文档 / 发消息 / 走审批 / 查知识库」
- Local agent needs Feishu work but should go through **Doubao's browser session**, not `lark-cli` alone
- User already has Dia/Chrome + Doubao open and logged in
- Mentions `wab`, web-agent-bridge, ACP for editors, or CDP attach

Prefer **`lark-cli` / Lark skill** when the task is pure Feishu API and Doubao is not needed. Prefer **this skill** when the user wants Doubao's agent UI (plugins, 云电脑, 企业知识, multi-step browser ops).

## Core workflow (Doubao → 飞书)

```bash
# 1) Reuse the user's Dia/Chrome login (do NOT start a fresh anonymous browser)
wab cdp

# 2) Server attaches via CDP + optional ACP
wab server --browser --cdp --acp

# 3) Give Doubao a concrete Feishu task in natural language
wab send -b browser -a doubao "打开飞书，在文档《周报》末尾追加今天的三条进展，保存后把链接发回给我"
```

Prompt tips for Feishu-style tasks:

- Be specific: **which doc / chat / approval**, what to write, what to return
- Ask Doubao to **confirm success** (link, screenshot description, or quoted result)
- One task per `wab send` when possible; follow up with another send for the next step
- Raise timeout for long ops: `-T 300`

Examples:

```bash
wab send -b browser -a doubao "在飞书知识库里找到《报销规范》，总结成五条发给我"
wab send -b browser -a doubao "帮我创建一个飞书审批：主题「差旅报销」，金额 1280，事由出差上海"
wab send -b browser -a doubao "把飞书群「项目同步」里今天未读里和 deadline 相关的消息列出来"
```

## Setup (once)

```bash
npm install -g .          # or: npm link / npm install -g web-agent-bridge
npx playwright install chromium   # only if using Playwright backend

# Install this skill
mkdir -p ~/.agents/skills ~/.cursor/skills
ln -sfn "$(pwd)/skills/web-agent-bridge" ~/.agents/skills/web-agent-bridge
ln -sfn "$(pwd)/skills/web-agent-bridge" ~/.cursor/skills/web-agent-bridge

wab --version
wab health
```

Before sending: open https://www.doubao.com/chat/ in Dia/Chrome and ensure Doubao can already reach Feishu (same account / enterprise bindings the user uses manually).

## Backend choice

| Backend | When | Setup |
|---------|------|--------|
| `browser` + CDP | **Default for Doubao→飞书** (reuse login) | `wab cdp` then `wab server --browser --cdp` |
| `browser` + login profile | No Dia / CI | `wab login doubao` then `wab server --browser` |
| `extension` | Extension injected into tabs | load `extension/`, `wab server` |

```bash
wab send -b browser -a doubao "..."     # preferred for Feishu via Doubao
wab send -b extension -a doubao "..."
wab send -a workbuddy "生成一份竞品研究报告"   # other agents
```

Agents: `doubao` | `chatgpt` | `gemini` | `workbuddy`.

## Agent rules

1. For Feishu-via-Doubao, always prefer **CDP attach** (`wab cdp`) over a new headless profile.
2. Never close/kill the user's Dia window; detach only.
3. `wab health` before long Feishu tasks; if browser dropped, re-run `wab cdp`.
4. Write prompts as **operator instructions to Doubao**, not as Feishu API calls.
5. Multi-turn: reuse `-c <contextId>` from `wab send -j` when continuing the same Doubao thread.
6. Timeouts: default 180s; Feishu multi-step often needs `-T 300`+.
7. Auth is the **browser login** — do not invent Doubao/Feishu tokens.
8. ACP stdio logs go to **stderr**; do not parse stderr as protocol.

## ACP (editors)

```bash
wab acp                         # proxy to running wab server
wab acp -b browser --cdp auto   # local Playwright
```

HTTP ACP: `wab server --acp` → `http://127.0.0.1:3000/acp`.

`_meta`: `x-target-agent=doubao`, `x-backend=browser`. Slash: `/status`, `/agent`, `/backend`.

## Quick command map

| Goal | Command |
|------|---------|
| Enable CDP on Dia | `wab cdp` |
| Start for Doubao+飞书 | `wab server --browser --cdp --acp` |
| Run a Feishu task via Doubao | `wab send -b browser -a doubao "..."` |
| Status | `wab health` |
| ACP stdio | `wab acp -b browser` |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `wab` not found | `npm link` / `npm install -g .` |
| browser disconnected | `wab cdp`; check `:9222/json/version` |
| Doubao can't open Feishu | user must log into Feishu inside Doubao/plugins first (manual once) |
| task times out | `-T 300`; split into smaller steps |
| no Doubao tab | open `https://www.doubao.com/chat/` while logged in |

## Repo pointers

- CLI: `bin/cli.mjs`
- Doubao adapter: `server/browser-adapters/doubao.ts`
- ACP: `server/acp-agent.ts`
- Live check: `LIVE=1 npm run test:acp:live`
