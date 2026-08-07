import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("fix-next-static-html-lang", () => {
  it("writes compact EdgeOne routes without intercepting ordinary text assets", () => {
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
        { src: "^/\\.txt$", dest: "/index.txt", headers: { "cache-control": "no-cache" } },
        { handle: "filesystem" },
        { src: "^/([^.]+[^/.])/?$", dest: "/$1/index.html", headers: { "cache-control": "no-cache" } },
      ]));

      const flightRoutes = config.routes.filter((route) => route.dest === "/$1/index.txt");
      for (const path of ["/about.txt", "/docs/overview.txt", "/agents/diagnostics.txt"]) {
        expect(flightRoutes.some((route) => new RegExp(route.src).test(path))).toBe(true);
      }
      for (const path of ["/robots.txt", "/llms.txt", "/about/__next._tree.txt"]) {
        expect(flightRoutes.some((route) => new RegExp(route.src).test(path))).toBe(false);
      }

      const textHeaderIndex = config.routes.findIndex((route) => route.src === "^/(.*)\\.txt$");
      const filesystemIndex = config.routes.findIndex((route) => route.handle === "filesystem");
      const htmlFallbackIndex = config.routes.findIndex((route) => route.dest === "/$1/index.html");
      expect(Math.max(...flightRoutes.map((route) => config.routes.indexOf(route)))).toBeLessThan(textHeaderIndex);
      expect(textHeaderIndex).toBeLessThan(filesystemIndex);
      expect(filesystemIndex).toBeLessThan(htmlFallbackIndex);
      expect(config.routes).toHaveLength(8);
      expect(Buffer.byteLength(JSON.stringify(config))).toBeLessThan(16 * 1024);
      expect(Math.max(...config.routes.filter((route) => route.src).map((route) => Buffer.byteLength(route.src)))).toBeLessThanOrEqual(480);
      expect(existsSync(join(out, ".edgeone", "assets", "docs", "overview", "index.txt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the EdgeOne route config bounded as localized pages grow", () => {
    const root = mkdtempSync(join(tmpdir(), "next-edgeone-route-budget-"));
    const out = join(root, "out");
    const script = resolve("scripts/fix-next-static-html-lang.mjs");

    try {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "index.html"), '<html lang="en"><body></body></html>');
      writeFileSync(join(out, "index.txt"), "root flight");
      for (const locale of ["en-us", "zh-hant", "zh-sg"]) {
        for (let index = 0; index < 120; index += 1) {
          const dir = join(out, locale, "docs", `page-${index.toString().padStart(3, "0")}`);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "index.html"), '<html lang="en"><body></body></html>');
          writeFileSync(join(dir, "index.txt"), "flight");
        }
      }

      execFileSync(process.execPath, [script], { cwd: root, stdio: "pipe" });

      const configPath = join(out, ".edgeone", "cloud-functions", "ssr-node", "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const flightRoutes = config.routes.filter((route) => route.dest === "/$1/index.txt");
      expect(config.routes.length).toBeLessThan(40);
      expect(Buffer.byteLength(JSON.stringify(config))).toBeLessThan(16 * 1024);
      expect(Math.max(...flightRoutes.map((route) => Buffer.byteLength(route.src)))).toBeLessThanOrEqual(480);
      expect(flightRoutes.some((route) => new RegExp(route.src).test("/zh-hant/docs/page-119.txt"))).toBe(true);
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
