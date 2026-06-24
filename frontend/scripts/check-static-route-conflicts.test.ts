import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = join(process.cwd(), "scripts", "check-static-route-conflicts.mjs");

const createFixture = (publicDirs: string[], routerSource: string) => {
  const root = mkdtempSync(join(tmpdir(), "static-route-conflicts-"));
  const publicDir = join(root, "public");
  const routerDir = join(root, "src", "router");
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(routerDir, { recursive: true });
  for (const dir of publicDirs) {
    mkdirSync(join(publicDir, dir), { recursive: true });
  }
  writeFileSync(join(routerDir, "index.tsx"), routerSource);
  return root;
};

const runCheck = (fixtureRoot: string) =>
  spawnSync(process.execPath, [scriptPath, fixtureRoot], {
    encoding: "utf8",
  });

describe("check-static-route-conflicts", () => {
  it("passes when public directories do not overlap BrowserRouter routes", () => {
    const root = createFixture(["assets", "login"], `
      export const router = createBrowserRouter([
        { path: "/", children: [{ path: "changelog" }, { path: "about" }] },
      ]);
    `);
    try {
      const result = runCheck(root);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("passed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips Next-only projects without a BrowserRouter entry", () => {
    const root = mkdtempSync(join(tmpdir(), "static-route-conflicts-next-"));
    try {
      mkdirSync(join(root, "public", "agents"), { recursive: true });
      mkdirSync(join(root, "src", "app"), { recursive: true });

      const result = runCheck(root);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("skipped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a public top-level directory matching a BrowserRouter route", () => {
    const root = createFixture(["changelog"], `
      export const router = createBrowserRouter([
        { path: "/", children: [{ path: "changelog" }] },
      ]);
    `);
    try {
      const result = runCheck(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("public/changelog/ conflicts with BrowserRouter route /changelog");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
