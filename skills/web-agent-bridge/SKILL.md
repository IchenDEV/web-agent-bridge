---
name: web-agent-bridge
description: >-
  Operate web AI agents (Doubao, ChatGPT, Gemini, WorkBuddy) through the wab CLI
  over A2A or ACP, using a Chrome extension or Playwright CDP. Use when the user
  mentions wab, web-agent-bridge, Doubao/豆包 browser automation, driving a logged-in
  Dia/Chrome tab, ACP stdio/HTTP for editors, or bridging webpage AI into local agents.
metadata:
  requires:
    bins: ["wab"]
---

# Web Agent Bridge (`wab`)

Drive webpage AI agents from the terminal. Prefer the **browser/CDP** path when the user already has Dia/Chrome open and logged in (especially Doubao).

## Prerequisites

```bash
# From this repo (dev) or after publish
npm install -g .
# or: npm link   (inside a clone)
# or: npm install -g web-agent-bridge

# Playwright Chromium (browser backend only)
npx playwright install chromium

wab --version
wab health
```

Install this skill (pick one):

```bash
# Global agent skills (Codex / multi-agent)
mkdir -p ~/.agents/skills
ln -sfn "$(pwd)/skills/web-agent-bridge" ~/.agents/skills/web-agent-bridge

# Cursor personal skills
mkdir -p ~/.cursor/skills
ln -sfn "$(pwd)/skills/web-agent-bridge" ~/.cursor/skills/web-agent-bridge
```

## Default workflow (Doubao via open browser)

```bash
# 1) Attach Dia/Chrome with remote debugging (keeps login)
wab cdp

# 2) Start server: Playwright + ACP
wab server --browser --cdp --acp

# 3) Send (stdout = plain reply text)
wab send -b browser -a doubao "1+1等于几？"
```

Check before sending:

```bash
wab health
# Expect backends.browser.connected=true; pages may list doubao
```

## Backend choice

| Backend | When | Setup |
|---------|------|--------|
| `browser` | User's Dia/Chrome already logged in | `wab cdp` then `--cdp` |
| `browser` | Headless / no Dia | `wab login doubao` then `wab server --browser` |
| `extension` | Chrome extension loaded | load `extension/`, `wab server` |

```bash
wab send -b browser -a doubao "..."
wab send -b extension -a workbuddy "..."
wab send -a chatgpt "..."          # auto backend
```

Agents: `doubao` | `chatgpt` | `gemini` | `workbuddy`.

## ACP (editors)

```bash
# Proxy prompts to a running wab server (extension or browser backend already up)
wab acp

# Local Playwright only (no separate server)
wab acp -b browser --cdp auto
```

Server also serves HTTP ACP when started with `--acp` → `http://127.0.0.1:3000/acp`.

Session `_meta` / config:

- `x-target-agent`: `doubao` | `chatgpt` | `gemini` | `workbuddy`
- `x-backend`: `extension` | `browser`

Slash commands inside a session: `/status`, `/agent <name>`, `/backend <name>`.

## Agent rules

1. Prefer **CDP attach** over `wab login` when the user already has Doubao open.
2. Never kill the user's Dia window on disconnect; `BrowserBackend` detaches only.
3. Before long prompts: `wab health`. If browser disconnected, run `wab cdp` again.
4. For multi-turn A2A, reuse `-c <contextId>` from prior JSON (`wab send -j`).
5. Timeouts: `-T 180` default; raise for WorkBuddy / long research.
6. Logs for ACP stdio go to **stderr**; do not parse stderr as JSON-RPC.
7. Do not invent API keys — auth is the webpage login session.

## Quick command map

| Goal | Command |
|------|---------|
| Start (extension) | `wab server` |
| Start (CDP + ACP) | `wab server --browser --cdp --acp` |
| Ask Doubao | `wab send -b browser -a doubao "..."` |
| Status | `wab health` |
| Agent card | `wab agent` |
| Enable CDP on Dia | `wab cdp` |
| Save Playwright cookies | `wab login doubao` |
| ACP stdio | `wab acp` / `wab acp -b browser` |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `wab: command not found` | `npm link` or `npm install -g .` from repo |
| browser not connected | `wab cdp`; confirm `http://127.0.0.1:9222/json/version` |
| no Doubao tab | open https://www.doubao.com/chat/ while logged in |
| extension ! badge | start `wab server`; check extension settings URL |
| `__name is not defined` in page | fixed in adapters — update package; avoid named helpers inside `page.evaluate` |
| empty ACP commands on `session/new` | normal on HTTP; commands arrive on first `prompt` / `load` / `resume` |

## Repo pointers

- CLI: `bin/cli.mjs`
- ACP agent: `server/acp-agent.ts`
- Playwright backend: `server/browser-backend.ts`
- Tests: `npm run test:acp`, `LIVE=1 npm run test:acp:live`
