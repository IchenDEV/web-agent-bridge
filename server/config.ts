/**
 * Central configuration for the Web Agent Bridge server.
 *
 * Single source of truth for values that were previously hard-coded across
 * modules (timeouts, ports, version). Import from here instead of repeating
 * literals.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the package root relative to this module.
 *
 * Layouts to support:
 *   - tsx dev run:      <root>/server/config.ts      → <root> is ".."
 *   - tsc build output: <root>/dist/server/config.js → <root> is "../.."
 */
function findPackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, ".."), join(here, "..", "..")]) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return here;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(findPackageRoot(), "package.json"), "utf-8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

/** Server package version, kept in sync with package.json automatically. */
export const VERSION = readVersion();

/** Host the HTTP/WS server binds to. Local-only by design. */
export const HOST = process.env.WAB_HOST || "127.0.0.1";

/** Default server port (`PORT` env wins; agent-card URLs are derived from it). */
export const PORT = Number(process.env.PORT || 3000);

/**
 * Default timeout for one agent turn, in milliseconds.
 *
 * Applies to A2A requests, ACP prompts and backend send operations unless the
 * caller overrides it (e.g. `wab send -T 600`). Long-running web tasks such as
 * Doubao reading Feishu documents need a much larger value — the default is
 * deliberately generous because web agents run tool loops.
 */
export const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Safety timeout used by the extension content script when the server did not
 * send one (see `extension/content.js`). The extension layer adds its own
 * guard on top: the safety alarm in `background.js` fires slightly later.
 */
export const CONTENT_SCRIPT_DEFAULT_TIMEOUT_MS = 80_000;

/** Extra slack the extension safety alarm adds over the content-script timeout. */
export const SAFETY_ALARM_SLACK_MS = 10_000;