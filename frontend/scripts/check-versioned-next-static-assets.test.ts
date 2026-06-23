import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("check-versioned-next-static-assets", () => {
  const script = resolve("scripts/check-versioned-next-static-assets.mjs");
  const releaseId = "20260623120000-test-cn";
  const env = {
    ...process.env,
    NEXT_VERSION_STATIC_ASSETS: "1",
    NEXT_PUBLIC_RELEASE_ID: releaseId,
    NEXT_PUBLIC_ASSET_PREFIX: `/__releases/${releaseId}`,
  };

  it("passes when emitted HTML points at existing versioned assets", () => {
    const root = mkdtempSync(join(tmpdir(), "next-check-versioned-assets-"));
    const out = join(root, "out");

    try {
      mkdirSync(join(out, "__releases", releaseId, "_next", "static", "chunks"), { recursive: true });
      writeFileSync(join(out, "__releases", releaseId, "_next", "static", "chunks", "main.js"), "main");
      writeFileSync(
        join(out, "index.html"),
        `<script src="/__releases/${releaseId}/_next/static/chunks/main.js"></script>`,
      );

      expect(() => execFileSync(process.execPath, [script], { cwd: root, env, stdio: "pipe" })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails on unversioned Next static script references", () => {
    const root = mkdtempSync(join(tmpdir(), "next-check-unversioned-assets-"));
    const out = join(root, "out");

    try {
      mkdirSync(join(out, "__releases", releaseId, "_next", "static"), { recursive: true });
      writeFileSync(join(out, "index.html"), '<script src="/_next/static/chunks/main.js"></script>');

      expect(() => execFileSync(process.execPath, [script], { cwd: root, env, stdio: "pipe" })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
