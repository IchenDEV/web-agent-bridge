/**
 * Options page — configure server URL for the extension.
 */

const DEFAULT_SERVER = "http://127.0.0.1:3000";

const serverInput = document.getElementById("server-url");
const wsInput = document.getElementById("ws-url");
const toast = document.getElementById("toast");

function deriveWsUrl(httpUrl) {
  try {
    const u = new URL(httpUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/ws";
    return u.toString();
  } catch {
    return "";
  }
}

function updateWsPreview() {
  wsInput.value = deriveWsUrl(serverInput.value || DEFAULT_SERVER);
}

serverInput.addEventListener("input", updateWsPreview);

// Load saved settings
chrome.storage.local.get(["serverUrl"], (result) => {
  serverInput.value = result.serverUrl || DEFAULT_SERVER;
  updateWsPreview();
});

// Save
document.getElementById("btn-save").addEventListener("click", async () => {
  const url = serverInput.value.trim() || DEFAULT_SERVER;
  serverInput.value = url;
  updateWsPreview();

  await chrome.storage.local.set({ serverUrl: url });

  // Notify background to reconnect
  try {
    chrome.runtime.sendMessage({ type: "settings-changed", serverUrl: url });
  } catch (_) {}

  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2000);
});

// Reset
document.getElementById("btn-reset").addEventListener("click", async () => {
  serverInput.value = DEFAULT_SERVER;
  updateWsPreview();
  await chrome.storage.local.set({ serverUrl: DEFAULT_SERVER });

  try {
    chrome.runtime.sendMessage({ type: "settings-changed", serverUrl: DEFAULT_SERVER });
  } catch (_) {}

  toast.textContent = "✓ 已恢复默认";
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
    toast.textContent = "✓ 已保存";
  }, 2000);
});
