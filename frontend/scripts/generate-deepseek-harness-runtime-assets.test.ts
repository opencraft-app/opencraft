import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  DEEPSEEK_HARNESS_INSTALL_PAYLOAD_CHUNKS,
  DEEPSEEK_HARNESS_INSTALL_PAYLOAD_SHA256,
  DEEPSEEK_HARNESS_PROVIDER_HELPER_BASE64,
} from "../src/lib/generated/deepseek-harness-runtime-assets";

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maxDebugExecCommandBytes = 64 * 1024;

describe("DeepSeek Harness runtime payload", () => {
  it("matches the standalone installer and provider helper sources", () => {
    expect(() => execFileSync(
      process.execPath,
      ["scripts/generate-deepseek-harness-runtime-assets.mjs", "--check"],
      { cwd: frontendDir, stdio: "pipe" },
    )).not.toThrow();
  });

  it("reconstructs a checksummed payload with only safe relative files", () => {
    const compressed = Buffer.from(DEEPSEEK_HARNESS_INSTALL_PAYLOAD_CHUNKS.join(""), "base64");
    expect(createHash("sha256").update(compressed).digest("hex"))
      .toBe(DEEPSEEK_HARNESS_INSTALL_PAYLOAD_SHA256);

    const payload = JSON.parse(gunzipSync(compressed).toString("utf8")) as {
      schemaVersion: number;
      files: Array<{ path: string; mode: number; content: string }>;
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.files.map((file) => file.path)).toEqual([
      "installer/install-deepseek-harness.sh",
    ]);
    expect(payload.files.every((file) => (
      !file.path.startsWith("/")
      && !file.path.split("/").includes("..")
      && [0o644, 0o755].includes(file.mode)
      && Buffer.from(file.content, "base64").length > 0
    ))).toBe(true);
  });

  it("keeps every real-time debug/exec payload below the backend command limit", () => {
    const uploadCommandOverhead = 256;
    const providerCommandOverhead = 512;

    expect(Math.max(...DEEPSEEK_HARNESS_INSTALL_PAYLOAD_CHUNKS.map(
      (chunk) => Buffer.byteLength(chunk) + uploadCommandOverhead,
    ))).toBeLessThan(maxDebugExecCommandBytes);
    expect(Buffer.byteLength(DEEPSEEK_HARNESS_PROVIDER_HELPER_BASE64) + providerCommandOverhead)
      .toBeLessThan(maxDebugExecCommandBytes);
  });
});
