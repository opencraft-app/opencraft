import { describe, expect, it } from "vitest";
import { isHermesWebTextResponse, rewriteHermesWebTextPayload, rewriteTatWebTextPayload } from "@/lib/tat-hermes-web-proxy-rewrite";

const proxyBase = "/__tat_hermes_proxy/ins-demo";

describe("Hermes WebUI proxy rewrite", () => {
  it("injects a proxy base and rewrites root-relative HTML resources", () => {
    const html = [
      "<!doctype html>",
      "<html><head><title>Hermes</title></head><body>",
      '<script src="/assets/app.js"></script>',
      '<link href="/assets/app.css" rel="stylesheet">',
      '<form action="/api/jobs"></form>',
      "</body></html>",
    ].join("");

    const rewritten = rewriteHermesWebTextPayload(html, "text/html; charset=utf-8", proxyBase);

    expect(rewritten).toContain(`<base href="${proxyBase}/">`);
    expect(rewritten).toContain('src="/__tat_hermes_proxy/ins-demo/assets/app.js"');
    expect(rewritten).toContain('href="/__tat_hermes_proxy/ins-demo/assets/app.css"');
    expect(rewritten).toContain('action="/__tat_hermes_proxy/ins-demo/api/jobs"');
    expect(rewritten).toContain("window.fetch");
    expect(rewritten).toContain("XMLHttpRequest.prototype.open");
  });

  it("rewrites CSS and JavaScript root paths without touching external URLs", () => {
    const css = [
      ".logo { background: url(/assets/logo.png); }",
      ".cdn { background: url(//cdn.example.com/logo.png); }",
    ].join("\n");
    const js = 'fetch("/api/status"); const ws = "/socket/events"; const external = "https://example.com/api";';

    expect(rewriteHermesWebTextPayload(css, "text/css", proxyBase)).toContain(
      `url(${proxyBase}/assets/logo.png)`,
    );
    const rewrittenJs = rewriteHermesWebTextPayload(js, "application/javascript", proxyBase);
    expect(rewrittenJs).toContain(`"${proxyBase}/api/status"`);
    expect(rewrittenJs).toContain('"/socket/events"');
    expect(rewrittenJs).toContain('"https://example.com/api"');
  });

  it("rewrites Hermes local absolute URLs to the current proxy base", () => {
    const html = [
      "<!doctype html>",
      "<html><head></head><body>",
      '<script src="http://127.0.0.1:9119/assets/app.js"></script>',
      '<link href="http://localhost:9119/assets/app.css" rel="stylesheet">',
      '<img src="http://0.0.0.0:9119/favicon.ico">',
      '<a href="https://example.com/assets/app.js">external</a>',
      "</body></html>",
    ].join("");
    const js = [
      'fetch("http://127.0.0.1:9119/api/status?x=1");',
      'const asset = "http://localhost:9119/static/chunk.js";',
      'const socket = "ws://127.0.0.1:9119/ws";',
      'const external = "http://example.com/assets/app.js";',
    ].join("");

    const rewrittenHtml = rewriteHermesWebTextPayload(html, "text/html", proxyBase);
    expect(rewrittenHtml).toContain(`src="${proxyBase}/assets/app.js"`);
    expect(rewrittenHtml).toContain(`href="${proxyBase}/assets/app.css"`);
    expect(rewrittenHtml).toContain(`src="${proxyBase}/favicon.ico"`);
    expect(rewrittenHtml).toContain('href="https://example.com/assets/app.js"');

    const rewrittenJs = rewriteHermesWebTextPayload(js, "application/javascript", proxyBase);
    expect(rewrittenJs).toContain(`fetch("${proxyBase}/api/status?x=1")`);
    expect(rewrittenJs).toContain(`const asset = "${proxyBase}/static/chunk.js"`);
    expect(rewrittenJs).toContain('const socket = "ws://127.0.0.1:9119/ws"');
    expect(rewrittenJs).toContain('const external = "http://example.com/assets/app.js"');
  });

  it("injects runtime rewrite rules for fetch, XHR, dynamic resources, and Request URLs without patching WebSocket", () => {
    const rewritten = rewriteHermesWebTextPayload("<html><head></head><body></body></html>", "text/html", proxyBase);

    expect(rewritten).toContain("absoluteTargetPattern");
    expect(rewritten).toContain("input instanceof Request");
    expect(rewritten).toContain("XMLHttpRequest.prototype.open");
    expect(rewritten).toContain("Element.prototype.setAttribute");
    expect(rewritten).toContain("patchUrlProperty(HTMLScriptElement.prototype");
    expect(rewritten).not.toContain("history.pushState");
    expect(rewritten).not.toContain("history.replaceState");
    expect(rewritten).toContain("window.EventSource");
    expect(rewritten).not.toContain("window.WebSocket");
    expect(rewritten).toContain("parsed.origin === window.location.origin");
  });

  it("keeps JSON payloads out of rewrite processing", () => {
    expect(isHermesWebTextResponse("application/json")).toBe(false);
    expect(isHermesWebTextResponse("text/html; charset=utf-8")).toBe(true);
    expect(isHermesWebTextResponse("text/css")).toBe(true);
    expect(isHermesWebTextResponse("application/javascript")).toBe(true);
  });

  it("rewrites DeepSeek Harness loopback URLs with its own port and proxy base", () => {
    const proxyBase = "/__tat_hermes_proxy/dsh--ins-1";
    const html = '<html><head></head><body><script src="http://127.0.0.1:3080/assets/app.js"></script></body></html>';
    const rewritten = rewriteTatWebTextPayload(html, "text/html", proxyBase, 3080);

    expect(rewritten).toContain(`${proxyBase}/assets/app.js`);
    expect(rewritten).toContain(`const base = "${proxyBase}/";`);
    expect(rewritten).toContain(":3080(?=/|$)");
    expect(rewritten).not.toContain(":9119(?=/|$)");
  });
});
