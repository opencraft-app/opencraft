import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("fix-next-static-html-lang", () => {
  it("writes EdgeOne routes for every static HTML page and Next flight sidecar", () => {
    const root = mkdtempSync(join(tmpdir(), "next-edgeone-output-"));
    const out = join(root, "out");
    const script = resolve("scripts/fix-next-static-html-lang.mjs");

    try {
      for (const route of ["", "about", "docs/overview", "agents/diagnostics"]) {
        const dir = join(out, route);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "index.html"), '<html lang="en"><body></body></html>');
        writeFileSync(join(dir, "index.txt"), "flight");
      }

      execFileSync(process.execPath, [script], { cwd: root, stdio: "pipe" });

      const config = JSON.parse(readFileSync(join(out, ".edgeone", "cloud-functions", "ssr-node", "config.json"), "utf8"));
      expect(config.routes).toEqual(expect.arrayContaining([
        { src: "^/__releases/([^/]+)/_next/static/(.*)$", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true },
        { src: "^/(.*)\\.html$", headers: { "cache-control": "no-cache" }, continue: true },
        { src: "^/(.*)\\.txt$", headers: { "cache-control": "no-cache" }, continue: true },
        { src: "^/$", dest: "/index.html", headers: { "cache-control": "no-cache" } },
        { src: "^/about/?$", dest: "/about/index.html", headers: { "cache-control": "no-cache" } },
        { src: "^/docs/overview/?$", dest: "/docs/overview/index.html", headers: { "cache-control": "no-cache" } },
        { src: "^/agents/diagnostics/?$", dest: "/agents/diagnostics/index.html", headers: { "cache-control": "no-cache" } },
        { src: "^/\\.txt$", dest: "/index.txt", headers: { "cache-control": "no-cache" } },
        { src: "^/about\\.txt$", dest: "/about/index.txt", headers: { "cache-control": "no-cache" } },
        { src: "^/docs/overview\\.txt$", dest: "/docs/overview/index.txt", headers: { "cache-control": "no-cache" } },
        { src: "^/agents/diagnostics\\.txt$", dest: "/agents/diagnostics/index.txt", headers: { "cache-control": "no-cache" } },
      ]));
      expect(config.routes.indexOf(config.routes.find((route) => route.handle === "filesystem")))
        .toBeGreaterThan(config.routes.findIndex((route) => route.src === "^/__releases/([^/]+)/_next/static/(.*)$"));
      expect(existsSync(join(out, ".edgeone", "assets", "docs", "overview", "index.txt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("can skip EdgeOne Build Output for StaticPages previews", () => {
    const root = mkdtempSync(join(tmpdir(), "next-staticpages-output-"));
    const out = join(root, "out");
    const script = resolve("scripts/fix-next-static-html-lang.mjs");

    try {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "index.html"), '<html lang="en"><body></body></html>');
      execFileSync(process.execPath, [script], {
        cwd: root,
        env: { ...process.env, NEXT_WRITE_EDGEONE_BUILD_OUTPUT: "0" },
        stdio: "pipe",
      });

      expect(existsSync(join(out, ".edgeone"))).toBe(false);
      expect(readFileSync(join(out, "index.html"), "utf8")).toContain('<html lang="zh-CN"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks unprefixed HTML as English for global Next builds", () => {
    const root = mkdtempSync(join(tmpdir(), "next-global-lang-output-"));
    const out = join(root, "out");
    const script = resolve("scripts/fix-next-static-html-lang.mjs");

    try {
      mkdirSync(join(out, "about"), { recursive: true });
      mkdirSync(join(out, "zh-cn", "about"), { recursive: true });
      writeFileSync(join(out, "about", "index.html"), '<html lang="zh-CN"><body></body></html>');
      writeFileSync(join(out, "zh-cn", "about", "index.html"), '<html lang="en"><body></body></html>');
      execFileSync(process.execPath, [script], {
        cwd: root,
        env: { ...process.env, NEXT_PUBLIC_REGION: "global", NEXT_WRITE_EDGEONE_BUILD_OUTPUT: "0" },
        stdio: "pipe",
      });

      expect(readFileSync(join(out, "about", "index.html"), "utf8")).toContain('<html lang="en-US"');
      expect(readFileSync(join(out, "zh-cn", "about", "index.html"), "utf8")).toContain('<html lang="zh-CN"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes copied docs images when emitted output no longer references them", () => {
    const root = mkdtempSync(join(tmpdir(), "next-prune-docs-images-"));
    const out = join(root, "out");
    const script = resolve("scripts/fix-next-static-html-lang.mjs");

    try {
      mkdirSync(join(out, "docs-images"), { recursive: true });
      writeFileSync(join(out, "index.html"), '<html lang="en"><body><img src="/_next/static/media/example.png"></body></html>');
      writeFileSync(join(out, "docs-images", "example.png"), "unused source copy");

      execFileSync(process.execPath, [script], {
        cwd: root,
        env: { ...process.env, NEXT_WRITE_EDGEONE_BUILD_OUTPUT: "0" },
        stdio: "pipe",
      });

      expect(existsSync(join(out, "docs-images"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps copied docs images when emitted output still references them", () => {
    const root = mkdtempSync(join(tmpdir(), "next-keep-docs-images-"));
    const out = join(root, "out");
    const script = resolve("scripts/fix-next-static-html-lang.mjs");

    try {
      mkdirSync(join(out, "docs-images"), { recursive: true });
      writeFileSync(join(out, "index.html"), '<html lang="en"><body><img src="/docs-images/example.png"></body></html>');
      writeFileSync(join(out, "docs-images", "example.png"), "referenced source copy");

      execFileSync(process.execPath, [script], {
        cwd: root,
        env: { ...process.env, NEXT_WRITE_EDGEONE_BUILD_OUTPUT: "0" },
        stdio: "pipe",
      });

      expect(existsSync(join(out, "docs-images", "example.png"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
