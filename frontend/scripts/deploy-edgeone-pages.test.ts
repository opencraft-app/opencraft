import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  parseEdgeOneDeploymentResult,
  resolvePreviewDeploymentUrl,
  verifyEdgeOneDeployment,
} from "./deploy-edgeone-pages.mjs";

function response(body: string, init: ResponseInit = {}) {
  return new Response(body, init);
}

describe("deploy-edgeone-pages", () => {
  it("parses current EdgeOne CLI output without a final JSON line", () => {
    expect(parseEdgeOneDeploymentResult([
      "Using Project ID: pages-project-id",
      "Created deployment with Deployment ID: dppkdoh9862k",
      "Deploy Success",
      "Deploy URL: https://preview.example.com?eo_token=token&eo_time=123",
    ].join("\n"))).toEqual({
      deploymentId: "dppkdoh9862k",
      projectId: "pages-project-id",
      url: "https://preview.example.com?eo_token=token&eo_time=123",
    });
  });

  it("normalizes the signed previewUrl from EdgeOne CLI JSON output", () => {
    expect(parseEdgeOneDeploymentResult(JSON.stringify({
      deploymentId: "dppkdoh9862k",
      projectId: "pages-project-id",
      previewUrl: "https://preview.example.com?eo_token=token&eo_time=123",
    }))).toEqual({
      deploymentId: "dppkdoh9862k",
      projectId: "pages-project-id",
      url: "https://preview.example.com?eo_token=token&eo_time=123",
    });
  });

  it("keeps a complete signed Preview URL returned by the CLI", async () => {
    const makersClientFactory = vi.fn();

    await expect(resolvePreviewDeploymentUrl({
      deployment: {
        deploymentId: "dppkdoh9862k",
        projectId: "pages-project-id",
        url: "https://preview.example.com?eo_token=token&eo_time=123",
      },
      token: "edgeone-api-token",
      makersClientFactory,
    })).resolves.toBe("https://preview.example.com?eo_token=token&eo_time=123");

    expect(makersClientFactory).not.toHaveBeenCalled();
  });

  it("resolves a signed Preview URL through Makers SDK when the CLI returns a bare URL", async () => {
    const wait = vi.fn().mockResolvedValue({
      previewUrl: "https://preview.example.com?eo_token=signed-token&eo_time=456",
    });
    const makersClientFactory = vi.fn().mockResolvedValue({ deployments: { wait } });

    await expect(resolvePreviewDeploymentUrl({
      deployment: {
        deploymentId: "dppkdoh9862k",
        projectId: "pages-project-id",
        url: "https://preview.example.com",
      },
      token: "edgeone-api-token",
      makersClientFactory,
    })).resolves.toBe("https://preview.example.com?eo_token=signed-token&eo_time=456");

    expect(makersClientFactory).toHaveBeenCalledWith({ token: "edgeone-api-token" });
    expect(wait).toHaveBeenCalledWith({
      projectId: "pages-project-id",
      deploymentId: "dppkdoh9862k",
      timeout: 120,
      pollInterval: 2,
    });
  });

  it("rejects a bare Preview URL when deployment identifiers are unavailable", async () => {
    await expect(resolvePreviewDeploymentUrl({
      deployment: { url: "https://preview.example.com" },
      token: "edgeone-api-token",
    })).rejects.toThrow("projectId and deploymentId");
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

  it("verifies every JS/CSS asset referenced by the HTML, not just the entry script", async () => {
    const root = mkdtempSync(join(tmpdir(), "edgeone-deploy-smoke-"));
    const assets = join(root, "assets");
    const entryPath = "/__releases/rel/_next/static/chunks/main.js";
    const otherPath = "/__releases/rel/_next/static/chunks/other.js";
    const cssPath = "/__releases/rel/_next/static/css/main.css";
    const html = `<!doctype html><html><head>`
      + `<link rel="stylesheet" href="${cssPath}"/>`
      + `<script src="${entryPath}"></script>`
      + `<script src="${otherPath}"></script>`
      + `</head></html>`;

    try {
      mkdirSync(assets, { recursive: true });
      writeFileSync(join(assets, "index.html"), html);

      const served = new Set([entryPath, otherPath, cssPath]);
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.searchParams.has("eo_token")) {
          return response("", { status: 302, headers: { "set-cookie": "eo_token=t; Path=/" } });
        }
        if (url.pathname === "/") return response(html, { status: 200, headers: { "content-type": "text/html" } });
        if (served.has(url.pathname)) return response("asset", { status: 200 });
        return response("missing", { status: 404 });
      });

      await expect(verifyEdgeOneDeployment({
        deployUrl: "https://preview.example.com?eo_token=t",
        deployDir: root,
        fetchImpl,
        retryDelayMs: 0,
      })).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a deployment missing any non-entry chunk referenced by the HTML", async () => {
    const root = mkdtempSync(join(tmpdir(), "edgeone-deploy-smoke-"));
    const assets = join(root, "assets");
    const entryPath = "/__releases/rel/_next/static/chunks/main.js";
    const missingPath = "/__releases/rel/_next/static/chunks/missing.js";
    const html = `<!doctype html><html><head>`
      + `<script src="${entryPath}"></script>`
      + `<script src="${missingPath}"></script>`
      + `</head></html>`;

    try {
      mkdirSync(assets, { recursive: true });
      writeFileSync(join(assets, "index.html"), html);

      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.searchParams.has("eo_token")) {
          return response("", { status: 302, headers: { "set-cookie": "eo_token=t; Path=/" } });
        }
        if (url.pathname === "/") return response(html, { status: 200, headers: { "content-type": "text/html" } });
        if (url.pathname === entryPath) return response("ok", { status: 200 });
        return response("missing", { status: 404 });
      });

      await expect(verifyEdgeOneDeployment({
        deployUrl: "https://preview.example.com?eo_token=t",
        deployDir: root,
        fetchImpl,
        attempts: 1,
        retryDelayMs: 0,
      })).rejects.toThrow(missingPath);
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
