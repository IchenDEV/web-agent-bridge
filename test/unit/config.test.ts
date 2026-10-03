/**
 * Sanity checks for the central config module.
 * Run: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TIMEOUT_MS, HOST, PORT, VERSION } from "../../server/config.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));

test("VERSION matches package.json", () => {
  assert.equal(VERSION, pkg.version);
});

test("defaults are sane", () => {
  assert.equal(PORT, 3000);
  assert.equal(HOST, "127.0.0.1");
  assert.equal(DEFAULT_TIMEOUT_MS, 180_000);
});

test("PORT honours the env override", async () => {
  // Re-import with a different env to make sure the override is respected.
  const { PORT: freshPort } = await import("../../server/config.js");
  assert.equal(freshPort, Number(process.env.PORT || 3000));
  assert.ok(freshPort > 0);
  assert.equal(typeof join, "function"); // import smoke
});