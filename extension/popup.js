/**
 * Popup script — queries background for connection status
 * and scans open tabs for supported AI agent pages.
 */

const AGENT_TAB_PATTERNS = [
  { name: "豆包 (Doubao)", pattern: "*://www.doubao.com/chat*" },
  { name: "WorkBuddy", pattern: "*://www.workbuddy.cn/app*" },
  { name: "ChatGPT", pattern: "*://chatgpt.com/*" },
  { name: "Gemini", pattern: "*://gemini.google.com/*" },
  { name: "Perplexity", pattern: "*://www.perplexity.ai/*" },
  { name: "Kimi", pattern: "*://www.kimi.com/*" },
  { name: "Kimi (moonshot)", pattern: "*://kimi.moonshot.cn/*" },
  { name: "通义千问", pattern: "*://www.qianwen.com/*" },
  { name: "Qwen Chat", pattern: "*://chat.qwen.ai/*" },
];

const DEFAULT_SERVER = "http://127.0.0.1:3000";

document.addEventListener("DOMContentLoaded", async () => {
  // ── Version ──
  const manifest = chrome.runtime.getManifest();
  document.getElementById("version").textContent = `v${manifest.version}`;

  // ── Server URL from storage ──
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  const url = serverUrl || DEFAULT_SERVER;
  document.getElementById("server-url").textContent = url;

  // ── Options button ──
  document.getElementById("btn-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // ── WebSocket status ──
  checkServerConnection(url);

  // ── Detect agent tabs ──
  detectAgentTabs();
});

async function checkServerConnection(baseUrl) {
  const el = document.getElementById("ws-status");
  const detail = document.getElementById("ws-detail");

  try {
    const resp = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();

    if (data.ok && data.extensionConnected) {
      el.innerHTML = `<span class="dot green"></span><span class="status-text">已连接</span>`;
      detail.textContent = `WebSocket ↔ A2A 服务器正常`;
    } else if (data.ok) {
      el.innerHTML = `<span class="dot yellow"></span><span class="status-text">服务器运行中</span>`;
      detail.textContent = "扩展尚未连接到服务器 WebSocket";
    } else {
      el.innerHTML = `<span class="dot red"></span><span class="status-text">异常</span>`;
      detail.textContent = "服务器返回异常状态";
    }
  } catch (e) {
    el.innerHTML = `<span class="dot red"></span><span class="status-text">未连接</span>`;
    detail.textContent = `无法连接 ${baseUrl}，请确认服务器已启动`;
  }
}

async function detectAgentTabs() {
  const container = document.getElementById("agents");
  const found = [];

  for (const { name, pattern } of AGENT_TAB_PATTERNS) {
    try {
      const tabs = await chrome.tabs.query({ url: pattern });
      if (tabs.length > 0) {
        found.push({ name, tab: tabs[0] });
      }
    } catch (_) {
      // Permission not granted for this pattern
    }
  }

  if (found.length === 0) {
    container.innerHTML = `
      <div style="font-size:12px; color:#6b7280; line-height:1.6">
        未检测到已打开的 AI Agent 页面。<br>
        请打开以下任一页面：<br>
        · <a href="https://www.doubao.com/chat/" target="_blank" style="color:#6366f1">doubao.com/chat</a><br>
        · <a href="https://chatgpt.com/" target="_blank" style="color:#6366f1">chatgpt.com</a><br>
        · <a href="https://gemini.google.com/app" target="_blank" style="color:#6366f1">gemini.google.com</a><br>
        · <a href="https://www.workbuddy.cn/app" target="_blank" style="color:#6366f1">workbuddy.cn/app</a><br>
        · <a href="https://www.perplexity.ai/" target="_blank" style="color:#6366f1">perplexity.ai</a><br>
        · <a href="https://www.kimi.com/" target="_blank" style="color:#6366f1">kimi.com</a><br>
        · <a href="https://www.qianwen.com/" target="_blank" style="color:#6366f1">qianwen.com</a>
      </div>`;
    return;
  }

  container.innerHTML = "";
  for (const { name, tab } of found) {
    const item = document.createElement("div");
    item.className = "agent-item";
    item.innerHTML = `
      <span class="dot green"></span>
      <span class="name">${name}</span>
      <span class="url">${new URL(tab.url).hostname}</span>`;
    container.appendChild(item);
  }
}
