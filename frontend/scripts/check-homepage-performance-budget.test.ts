import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];
const scriptPath = path.resolve("scripts/check-homepage-performance-budget.mjs");

function createFixture({ legacy = false, scriptCount = 1 }: { legacy?: boolean; scriptCount?: number } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "homepage-performance-budget-"));
  fixtures.push(root);
  const chunksRoot = path.join(root, "_next/static/chunks");
  mkdirSync(chunksRoot, { recursive: true });

  const scriptTags: string[] = [];
  for (let index = 0; index < scriptCount; index += 1) {
    const name = `chunk-${index}.js`;
    writeFileSync(path.join(chunksRoot, name), index === 0 && legacy ? "PublicHomePage" : "export{};");
    scriptTags.push(`<script src="/_next/static/chunks/${name}"></script>`);
  }

  writeFileSync(
    path.join(root, "index.html"),
    `<!doctype html><main>首页</main>${scriptTags.join("")}<script>self.__next_f.push([1,"首页"])</script>`,
  );
  return root;
}

function runBudget(outDir: string) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, LIGHTVELA_HOMEPAGE_OUT_DIR: outDir },
  });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe("homepage performance budget", () => {
  it("accepts a lightweight exported homepage", () => {
    const result = runBudget(createFixture());

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("homepage budget passed");
  });

  it("rejects a root route that brings back the legacy homepage chunk", () => {
    const result = runBudget(createFixture({ legacy: true }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("legacy homepage code");
  });

  it("rejects too many initial Next scripts", () => {
    const result = runBudget(createFixture({ scriptCount: 23 }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Next script count");
  });
});
