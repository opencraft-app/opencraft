import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEEPSEEK_HARNESS_INSTALLER_SHA256,
  DEEPSEEK_HARNESS_PROVIDER_HELPER_BASE64,
} from "../src/lib/generated/deepseek-harness-runtime-assets";

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maxDebugExecCommandBytes = 64 * 1024;

describe("DeepSeek Harness runtime assets", () => {
  it("matches the provider helper source", () => {
    expect(() => execFileSync(
      process.execPath,
      ["scripts/generate-deepseek-harness-runtime-assets.mjs", "--check"],
      { cwd: frontendDir, stdio: "pipe" },
    )).not.toThrow();
  });

  it("does not bundle the remotely downloaded installer into the frontend", () => {
    const generated = readFileSync(
      path.join(frontendDir, "src/lib/generated/deepseek-harness-runtime-assets.ts"),
      "utf8",
    );
    expect(generated).not.toContain("DEEPSEEK_HARNESS_INSTALL_PAYLOAD");
    expect(generated).not.toContain("install-deepseek-harness.sh");
  });

  it("pins the remotely downloaded installer to the reviewed repository source", () => {
    const installer = readFileSync(
      path.join(frontendDir, "../images/helpers/install-deepseek-harness.sh"),
    );

    expect(DEEPSEEK_HARNESS_INSTALLER_SHA256)
      .toBe(createHash("sha256").update(installer).digest("hex"));
  });

  it("keeps the provider helper below the backend command limit", () => {
    const providerCommandOverhead = 512;

    expect(Buffer.byteLength(DEEPSEEK_HARNESS_PROVIDER_HELPER_BASE64) + providerCommandOverhead)
      .toBeLessThan(maxDebugExecCommandBytes);
  });
});
