import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("version-next-static-assets", () => {
  it("moves current _next/static and removes timestamped releases older than ttl", () => {
    const root = mkdtempSync(join(tmpdir(), "next-version-assets-"));
    const out = join(root, "out");
    const script = resolve("scripts/version-next-static-assets.mjs");
    const releaseId = "20260623120000-test-cn";

    try {
      mkdirSync(join(out, "_next", "static", "chunks"), { recursive: true });
      writeFileSync(join(out, "_next", "static", "chunks", "main.js"), "main");
      mkdirSync(join(out, "__releases", "20260620120000-old-cn", "_next", "static"), { recursive: true });
      mkdirSync(join(out, "__releases", "20260623110000-recent-cn", "_next", "static"), { recursive: true });
      mkdirSync(join(out, "__releases", "manual-release", "_next", "static"), { recursive: true });

      execFileSync(process.execPath, [script], {
        cwd: root,
        env: {
          ...process.env,
          NEXT_VERSION_STATIC_ASSETS: "1",
          NEXT_PUBLIC_RELEASE_ID: releaseId,
          NEXT_PUBLIC_ASSET_PREFIX: `/__releases/${releaseId}`,
          NEXT_STATIC_RELEASE_TTL_HOURS: "48",
          NEXT_STATIC_RELEASE_NOW: "2026-06-23T12:30:00Z",
        },
        stdio: "pipe",
      });

      expect(existsSync(join(out, "_next", "static"))).toBe(false);
      expect(existsSync(join(out, "__releases", releaseId, "_next", "static", "chunks", "main.js"))).toBe(true);
      expect(existsSync(join(out, "__releases", "20260620120000-old-cn"))).toBe(false);
      expect(existsSync(join(out, "__releases", "20260623110000-recent-cn"))).toBe(true);
      expect(existsSync(join(out, "__releases", "manual-release"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
