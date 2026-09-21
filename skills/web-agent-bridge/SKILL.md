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

Primary use case: **local coding agent → `wab` → Doubao (豆包) webpage → Feishu/Lark**.

Doubao runs in the user's logged-in browser and can operate Feishu (docs, messenger, approvals, knowledge base). Send **natural-language operator instructions** via `wab`; do not invent Doubao/Feishu API keys.

Full install / activation / failure playbook: repo [`README.md`](../../README.md)（给 AI Agent 的一页纸 + 故障排除）.

## When to use

- 「用豆包改飞书文档 / 发消息 / 审批 / 查知识库」
- Need Doubao's browser session (plugins, 企业知识), not pure `lark-cli`
- Mentions `wab`, web-agent-bridge, CDP, ACP for editors

Prefer **Lark skill / `lark-cli`** for pure Feishu API. Prefer **this skill** for Doubao UI automation.

## Activate (checklist)

Before any Feishu task, verify:

```bash
which wab && wab --version
curl -s http://127.0.0.1:9222/json/version || wab cdp
wab server --browser --cdp --acp    # long-running terminal
wab health                          # browser: ✅ ; preferably pages=[doubao]
open "https://www.doubao.com/chat/" # if no doubao tab; user must be logged in
wab send -b browser -a doubao "只回复：pong"
```

First-time install:

```bash
npm install && npm link
npx playwright install chromium
mkdir -p ~/.agents/skills ~/.cursor/skills
ln -sfn "$(pwd)/skills/web-agent-bridge" ~/.agents/skills/web-agent-bridge
ln -sfn "$(pwd)/skills/web-agent-bridge" ~/.cursor/skills/web-agent-bridge
```

## Doubao → 飞书

```bash
wab send -b browser -a doubao -T 300 \
  "打开飞书，在文档《周报》末尾追加今天三条进展，保存后把链接发回给我"
```

Prompt rules: name the object → action → require verifiable output (link/quote). One step per send. Split on timeout.

## Failure playbook (do in order)

1. **Read the error** (`wab health`, stderr). Do not reinstall blindly.
2. **Server down** → start `wab server --browser --cdp --acp`.
3. **CDP down** → `wab cdp`; confirm `:9222/json/version`; restart server after CDP is up.
4. **Not logged in** → ask user to log into Doubao (and Feishu inside Doubao) manually. Never invent cookies.
5. **No doubao tab** → open `https://www.doubao.com/chat/`.
6. **Timeout** → `-T 300`; shorter task; new chat; dismiss captchas/modals; if DOM changed, update `server/browser-adapters/doubao.ts`.
7. **Extension ❗** → only if using extension path; reload extension + match server URL.
8. Still stuck → collect `wab --version`, `wab health -j`, CDP `json/version`, server log tail (see README).

## Agent rules

1. Prefer CDP attach over `wab login` for Feishu-via-Doubao.
2. Never kill the user's Dia window; detach only.
3. Auth = browser login only.
4. ACP stdio logs on **stderr**.
5. Stop and ask the user when login/captcha/SSO is required.

## Quick map

| Goal | Command |
|------|---------|
| CDP | `wab cdp` |
| Server | `wab server --browser --cdp --acp` |
| Feishu via Doubao | `wab send -b browser -a doubao "..."` |
| Status | `wab health` |
