import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(resolve(process.cwd(), "public/tat-hermes-web-proxy-sw.js"), "utf8");

describe("OpenCraft versioned static cache in the existing site worker", () => {
  it("stores no-store release assets and leaves private APIs outside the worker", async () => {
    const handlers = new Map();
    const entries = new Map();
    const cache = {
      match: async request => entries.get(request.url),
      put: async (request, response) => { entries.set(request.url, response); },
      keys: async () => [...entries.keys()].map(url => new Request(url)),
      delete: async request => entries.delete(request.url),
    };
    const fetchAsset = vi.fn(async () => new Response("chunk", {
      headers: { "cache-control": "no-store", "content-type": "application/javascript" },
    }));
    runInNewContext(source, {
      self: {
        location: { origin: "https://lightvela.ai" },
        addEventListener: (type, handler) => handlers.set(type, handler),
      },
      caches: { open: async () => cache },
      fetch: fetchAsset,
      URL,
      Request,
      Response,
      Map,
      Set,
    });

    const asset = "https://lightvela.ai/__releases/build-1/_next/static/chunks/main.js";
    let prefetch;
    const acknowledgements = [];
    handlers.get("message")({
      data: { type: "OPENCRAFT_PREFETCH_STATIC", urls: [asset, "https://other.example/__releases/build-1/_next/static/private.js", "https://lightvela.ai/api/private"] },
      ports: [{ postMessage: message => acknowledgements.push(message) }],
      waitUntil: promise => { prefetch = promise; },
    });
    await prefetch;
    expect(acknowledgements).toEqual([{ type: "OPENCRAFT_STATIC_PREFETCH_ACCEPTED" }]);
    expect(fetchAsset).toHaveBeenCalledTimes(1);
    expect(entries.has(asset)).toBe(true);

    let served;
    handlers.get("fetch")({ request: new Request(asset), respondWith: promise => { served = promise; } });
    expect((await served).status).toBe(200);
    expect(fetchAsset).toHaveBeenCalledTimes(1);

    let intercepted = false;
    handlers.get("fetch")({ request: new Request("https://lightvela.ai/api/private"), respondWith: () => { intercepted = true; } });
    expect(intercepted).toBe(false);
  });

  it("loads static assets from the network when Cache Storage is unavailable", async () => {
    const handlers = new Map();
    const fetchAsset = vi.fn(async () => new Response("chunk"));
    runInNewContext(source, {
      self: {
        location: { origin: "https://lightvela.ai" },
        addEventListener: (type, handler) => handlers.set(type, handler),
      },
      caches: { open: async () => { throw new Error("storage unavailable"); } },
      fetch: fetchAsset,
      URL,
      Request,
      Response,
      Map,
      Set,
    });
    let served;
    handlers.get("fetch")({
      request: new Request("https://lightvela.ai/__releases/build-1/_next/static/chunks/main.js"),
      respondWith: promise => { served = promise; },
    });
    expect((await served).status).toBe(200);
    expect(fetchAsset).toHaveBeenCalledTimes(1);
  });
});
