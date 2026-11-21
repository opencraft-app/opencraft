#!/usr/bin/env node
// Checks the engine runtime a packaged desktop carries, outside the checkout:
// the pinned native Codex runs from the package, and no DSH runtime is shipped
// (OpenCraft bridges a user-installed DSH but does not distribute it).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const [resources, arch = process.arch] = process.argv.slice(2);
if (!resources)
  throw new Error("Usage: node scripts/smoke/desktop/smoke-packaged-runtime.mjs <resources directory> [arch]");
const pinned = JSON.parse(await readFile(new URL("../../../runtime/codex/package.json", import.meta.url), "utf8"))
  .dependencies["@openai/codex"];
const codex = resolve(resources, `runtime/codex-${arch}/bin`, process.platform === "win32" ? "codex.exe" : "codex");
const { stdout } = await promisify(execFile)(codex, ["--version"], { timeout: 30_000 });
assert.match(stdout, new RegExp(`\\b${pinned.replaceAll(".", "\\.")}\\b`), `bundled Codex reports ${stdout.trim()}`);
await assert.rejects(access(resolve(resources, "runtime/dsh/node_modules")), "the package must not ship a DSH runtime");
console.log(`Packaged runtime smoke passed: bundled Codex ${pinned} runs; no DSH runtime is shipped.`);
