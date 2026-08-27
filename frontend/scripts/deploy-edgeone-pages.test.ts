import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseEdgeOneDeploymentResult, verifyEdgeOneDeployment } from "./deploy-edgeone-pages.mjs";

function response(body: string, init: ResponseInit = {}) {
  return new Response(body, init);
}

describe("deploy-edgeone-pages", () => {
  it("parses current EdgeOne CLI output without a final JSON line", () => {
    expect(parseEdgeOneDeploymentResult([
      "Created deployment with Deployment ID: dppkdoh9862k",
      "Deploy Success",
      "Deploy URL: https://preview.example.com?eo_token=token&eo_time=123",
    ].join("\n"))).toEqual({
      deploymentId: "dppkdoh9862k",
      url: "https://preview.example.com?eo_token=token&eo_time=123",
    });
  });

  it("verifies HTML, entry JS, Flight, search, and missing asset behavior", async () => {
    const root = mkdtempSync(join(tmpdir(), "edgeone-deploy-smoke-"));
    const assets = join(root, "assets");
    const entryPath = "/__releases/release-id/_next/static/chunks/main.js";
    const html = `<!doctype html><html><head><script src="${entryPath}"></script></head></html>`;
    const flight = "flight payload";
    const search = "search payload";

    try {
      mkdirSync(join(assets, "about"), { recursive: true });
      mkdirSync(join(assets, "api", "search"), { recursive: true });
      writeFileSync(join(assets, "index.html"), html);
      writeFileSync(join(assets, "about", "index.txt"), flight);
      writeFileSync(join(assets, "api", "search", "en-us"), search);

      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.searchParams.has("eo_token")) {
          return response("", {
            status: 302,
            headers: {
              location: url.origin,
              "set-cookie": "eo_token=preview-token; Path=/, eo_time=123; Path=/",
            },
          });
        }
        if (url.pathname === "/") return response(html, { status: 200, headers: { "content-type": "text/html" } });
        if (url.pathname === entryPath) return response("console.log('ok')", { status: 200, headers: { "content-type": "application/javascript" } });
        if (url.pathname === "/about.txt") return response(flight, { status: 200 });
        if (url.pathname === "/api/search/en-us") return response(search, { status: 200 });
        if (url.pathname.includes("missing-edgeone-smoke")) return response("not found", { status: 404 });
        return response("unexpected", { status: 500 });
      });

      await expect(verifyEdgeOneDeployment({
        deployUrl: "https://preview.example.com?eo_token=token&eo_time=123",
        deployDir: root,
        fetchImpl,
        retryDelayMs: 0,
      })).resolves.toBeUndefined();

      expect(fetchImpl).toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a deployment that serves HTML for its entry JS", async () => {
    const root = mkdtempSync(join(tmpdir(), "edgeone-deploy-smoke-"));
    const assets = join(root, "assets");
    const entryPath = "/_next/static/chunks/main.js";
    const html = `<!doctype html><html><head><script src="${entryPath}"></script></head></html>`;

    try {
      mkdirSync(assets, { recursive: true });
      writeFileSync(join(assets, "index.html"), html);

      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.searchParams.has("eo_token")) {
          return response("", { status: 302, headers: { "set-cookie": "eo_token=preview-token; Path=/" } });
        }
        return response(html, { status: 200, headers: { "content-type": "text/html" } });
      });

      await expect(verifyEdgeOneDeployment({
        deployUrl: "https://preview.example.com?eo_token=token",
        deployDir: root,
        fetchImpl,
        attempts: 1,
        retryDelayMs: 0,
      })).rejects.toThrow("entry JS");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
