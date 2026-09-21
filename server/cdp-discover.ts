import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PORTS = [9222, 9223, 9229, 9333];

const PROFILE_CANDIDATES = [
  // Dia (ArcCore) — the browser currently open on this machine
  join(homedir(), "Library/Application Support/Dia/User Data"),
  join(homedir(), "Library/Application Support/Google/Chrome"),
  join(homedir(), "Library/Application Support/Chromium"),
  join(homedir(), "Library/Application Support/Microsoft Edge"),
  join(homedir(), "Library/Application Support/BraveSoftware/Brave-Browser"),
  join(homedir(), "Library/Application Support/Arc/User Data"),
];

/**
 * Resolve a CDP endpoint.
 * - Absolute URL / ws URL → returned as-is
 * - "auto" / empty → probe common ports + DevToolsActivePort files
 */
export async function resolveCdpEndpoint(
  preferred?: string,
): Promise<{ endpoint: string; source: string } | null> {
  if (preferred && preferred !== "auto") {
    const ok = await probeHttpEndpoint(preferred);
    if (ok) return { endpoint: preferred, source: "explicit" };
    // Still return ws:// endpoints even if HTTP probe fails (Chrome M144+)
    if (preferred.startsWith("ws://") || preferred.startsWith("wss://")) {
      return { endpoint: preferred, source: "explicit-ws" };
    }
  }

  for (const port of DEFAULT_PORTS) {
    const endpoint = `http://127.0.0.1:${port}`;
    if (await probeHttpEndpoint(endpoint)) {
      return { endpoint, source: `port:${port}` };
    }
  }

  for (const profile of PROFILE_CANDIDATES) {
    const fromFile = readDevToolsActivePort(profile);
    if (!fromFile) continue;
    if (await probeHttpEndpoint(fromFile.http) || fromFile.ws) {
      return {
        endpoint: (await probeHttpEndpoint(fromFile.http)) ? fromFile.http : fromFile.ws,
        source: `DevToolsActivePort:${profile}`,
      };
    }
  }

  return null;
}

function readDevToolsActivePort(userDataDir: string): { http: string; ws: string } | null {
  const file = join(userDataDir, "DevToolsActivePort");
  if (!existsSync(file)) return null;
  try {
    const lines = readFileSync(file, "utf8").trim().split(/\r?\n/);
    const port = Number(lines[0]);
    const path = lines[1] || "";
    if (!Number.isFinite(port) || port <= 0) return null;
    return {
      http: `http://127.0.0.1:${port}`,
      ws: path.startsWith("/")
        ? `ws://127.0.0.1:${port}${path}`
        : `ws://127.0.0.1:${port}/${path}`,
    };
  } catch {
    return null;
  }
}

async function probeHttpEndpoint(endpoint: string): Promise<boolean> {
  if (endpoint.startsWith("ws://") || endpoint.startsWith("wss://")) return false;
  try {
    const base = endpoint.replace(/\/$/, "");
    const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

export function diaAppPath(): string {
  return "/Applications/Dia.app";
}

export function diaUserDataDir(): string {
  return join(homedir(), "Library/Application Support/Dia/User Data");
}
