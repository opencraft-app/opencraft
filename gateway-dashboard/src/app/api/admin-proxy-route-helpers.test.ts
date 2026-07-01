import test from "node:test";
import assert from "node:assert/strict";

process.env.ADMIN_SESSION_SECRET = "test-session-secret";

// @ts-expect-error Node test runner requires explicit extension here.
const { createAdminSessionValue } = await import("../../lib/admin-session.ts");
// @ts-expect-error Node test runner requires explicit extension here.
const { buildModuleAdminProxyRequest, buildAdminProxyResponse, proxyModuleAdminRequest } = await import("./admin-proxy-route-helpers.ts");

test("buildModuleAdminProxyRequest maps ai-gateway module to backend admin API", async () => {
  const req = new Request("https://admin.example.com/admin/api/ai-gateway/users?page=2", {
    headers: {
      "x-admin-token": "browser-token",
    },
  });

  const built = await buildModuleAdminProxyRequest(req, {
    module: "ai-gateway",
    path: ["users"],
    upstreamBaseURL: "https://gateway.internal",
  });

  assert.equal(built.url.toString(), "https://gateway.internal/api/admin/users?page=2");
  assert.equal(built.init.headers.get("authorization"), "Bearer browser-token");
  assert.equal(built.init.method, "GET");
  assert.equal(built.init.cache, "no-store");
});

test("buildModuleAdminProxyRequest reads browser token from the session cookie", async () => {
  const sessionValue = createAdminSessionValue("browser-token", Math.floor(Date.now() / 1000));
  const req = new Request("https://admin.example.com/admin/api/ai-gateway/users", {
    headers: {
      cookie: `admin_session=${sessionValue}`,
    },
  });

  const built = await buildModuleAdminProxyRequest(req, {
    module: "ai-gateway",
    path: ["users"],
    upstreamBaseURL: "https://gateway.internal",
  });

  assert.equal(built.init.headers.get("authorization"), "Bearer browser-token");
});

test("buildModuleAdminProxyRequest uses module token before browser token", async () => {
  const req = new Request("https://admin.example.com/admin/api/auth/users", {
    headers: {
      "x-admin-token": "browser-token",
    },
  });

  const built = await buildModuleAdminProxyRequest(req, {
    module: "auth",
    path: ["users"],
    upstreamBaseURL: "https://auth.internal",
    upstreamToken: "module-token",
  });

  assert.equal(built.url.toString(), "https://auth.internal/admin/users");
  assert.equal(built.init.headers.get("authorization"), "Bearer module-token");
  assert.equal(built.usedBrowserToken, false);
});

test("buildModuleAdminProxyRequest maps sandbox module to internal API and forwards body", async () => {
  const req = new Request("https://admin.example.com/admin/api/sandbox/pools", {
    method: "POST",
    headers: {
      authorization: "Bearer browser-token",
    },
    body: JSON.stringify({ pool_id: "default" }),
  });

  const built = await buildModuleAdminProxyRequest(req, {
    module: "sandbox",
    path: ["pools"],
    upstreamBaseURL: "https://sandbox.internal",
  });

  assert.equal(built.url.toString(), "https://sandbox.internal/internal/pools");
  assert.equal(built.init.headers.get("authorization"), "Bearer browser-token");
  assert.equal(await new Response(built.init.body).text(), JSON.stringify({ pool_id: "default" }));
});

test("buildModuleAdminProxyRequest maps ctl-admin module to ctl admin API", async () => {
  const req = new Request("https://admin.example.com/admin/api/ctl/admin/passes/user-pass-1/refund", {
    method: "POST",
    headers: {
      authorization: "Bearer browser-token",
    },
    body: JSON.stringify({ reason: "manual refund" }),
  });

  const built = await buildModuleAdminProxyRequest(req, {
    module: "ctl-admin",
    path: ["passes", "user-pass-1", "refund"],
    upstreamBaseURL: "https://ctl.internal",
    forwardBrowserToken: false,
  });

  assert.equal(built.url.toString(), "https://ctl.internal/admin/api/ctl/passes/user-pass-1/refund");
  assert.equal(built.init.headers.get("authorization"), null);
  assert.equal(await new Response(built.init.body).text(), JSON.stringify({ reason: "manual refund" }));
});

test("buildModuleAdminProxyRequest maps sandbox PUT binding replacements to internal API", async () => {
  const body = JSON.stringify([{ sku_id: "sku-hermes-2c4g", priority: 1, weight: 100 }]);
  const req = new Request("https://admin.example.com/admin/api/sandbox/template-classes/hermes/skus", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer browser-token",
    },
    body,
  });

  const built = await buildModuleAdminProxyRequest(req, {
    module: "sandbox",
    path: ["template-classes", "hermes", "skus"],
    upstreamBaseURL: "https://sandbox.internal",
  });

  assert.equal(built.url.toString(), "https://sandbox.internal/internal/template-classes/hermes/skus");
  assert.equal(built.init.method, "PUT");
  assert.equal(built.init.headers.get("content-type"), "application/json");
  assert.equal(await new Response(built.init.body).text(), body);
});

test("buildModuleAdminProxyRequest maps sandbox PUT pool binding replacements to internal API", async () => {
  const body = JSON.stringify([{ pool_id: "pool-1", priority: 1, weight: 100, role: "primary" }]);
  const req = new Request("https://admin.example.com/admin/api/sandbox/template-classes/hermes/bindings", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer browser-token",
    },
    body,
  });

  const built = await buildModuleAdminProxyRequest(req, {
    module: "sandbox",
    path: ["template-classes", "hermes", "bindings"],
    upstreamBaseURL: "https://sandbox.internal",
  });

  assert.equal(built.url.toString(), "https://sandbox.internal/internal/template-classes/hermes/bindings");
  assert.equal(built.init.method, "PUT");
  assert.equal(built.init.headers.get("content-type"), "application/json");
  assert.equal(await new Response(built.init.body).text(), body);
});

test("buildModuleAdminProxyRequest preserves binary request bodies and content type", async () => {
  const bytes = new Uint8Array([0, 255, 128, 64]);
  const req = new Request("https://admin.example.com/admin/api/ai-gateway/upload", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-admin-token": "browser-token",
    },
    body: bytes,
  });

  const built = await buildModuleAdminProxyRequest(req, {
    module: "ai-gateway",
    path: ["upload"],
    upstreamBaseURL: "https://gateway.internal",
  });

  assert.equal(built.init.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(
    new Uint8Array(await new Response(built.init.body).arrayBuffer()),
    bytes
  );
});

test("buildAdminProxyResponse preserves empty 204 responses", async () => {
  const response = await buildAdminProxyResponse(
    new Response(null, {
      status: 204,
      headers: {
        "content-type": "application/json",
      },
    })
  );

  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("content-type"), "application/json");
});

test("buildAdminProxyResponse preserves binary response bodies", async () => {
  const bytes = new Uint8Array([0, 1, 255, 127]);

  const response = await buildAdminProxyResponse(
    new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
      },
    })
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("buildAdminProxyResponse can clear the admin session", async () => {
  const response = await buildAdminProxyResponse(
    new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
      },
    }),
    true
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("X-Admin-Session-Invalid"), "1");
  assert.match(response.headers.get("Set-Cookie") || "", /admin_session=/);
});

test("proxyModuleAdminRequest returns 500 when upstream is not configured", async () => {
  const response = await proxyModuleAdminRequest(
    new Request("https://admin.example.com/admin/api/ctl/bots"),
    { path: ["bots"] },
    { module: "ctl", serviceName: "CTL" }
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "CTL upstream is not configured",
  });
});

test("proxyModuleAdminRequest returns 502 when upstream fetch fails", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  });
  globalThis.fetch = (() => Promise.reject(new Error("dial failed"))) as typeof fetch;
  console.error = (() => undefined) as typeof console.error;

  const response = await proxyModuleAdminRequest(
    new Request("https://admin.example.com/admin/api/ctl/bots"),
    { path: ["bots"] },
    {
      module: "ctl",
      upstreamBaseURL: "https://ctl.internal",
      serviceName: "CTL",
    }
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "CTL backend is unreachable",
  });
});

test("proxyModuleAdminRequest rejects sandbox requests without dashboard admin token", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls++;
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  const response = await proxyModuleAdminRequest(
    new Request("https://admin.example.com/admin/api/sandbox/pools"),
    { path: ["pools"] },
    {
      module: "sandbox",
      upstreamBaseURL: "https://sandbox.internal",
      serviceName: "Sandbox",
      requireAdminTokenValidation: true,
      validationBaseURL: "https://gateway.internal",
    }
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "missing admin token" });
  assert.equal(fetchCalls, 0);
});

test("proxyModuleAdminRequest returns validation failure before internal upstream fetch", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls: string[] = [];
  globalThis.fetch = ((input) => {
    calls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    );
  }) as typeof fetch;

  const response = await proxyModuleAdminRequest(
    new Request("https://admin.example.com/admin/api/ctl/bots", {
      headers: { "x-admin-token": "bad-token" },
    }),
    { path: ["bots"] },
    {
      module: "ctl",
      upstreamBaseURL: "https://ctl.internal",
      serviceName: "CTL",
      requireAdminTokenValidation: true,
      validationBaseURL: "https://gateway.internal",
    }
  );

  assert.equal(response.status, 403);
  assert.equal(await response.text(), JSON.stringify({ error: "unauthorized" }));
  assert.deepEqual(calls, ["https://gateway.internal/api/admin/stats"]);
});

test("proxyModuleAdminRequest validates token then proxies internal request without Authorization", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = ((input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), authorization: headers.get("authorization") });
    if (String(input) === "https://gateway.internal/api/admin/stats") {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  const response = await proxyModuleAdminRequest(
    new Request("https://admin.example.com/admin/api/sandbox/pools", {
      headers: { authorization: "Bearer valid-token" },
    }),
    { path: ["pools"] },
    {
      module: "sandbox",
      upstreamBaseURL: "https://sandbox.internal",
      serviceName: "Sandbox",
      requireAdminTokenValidation: true,
      validationBaseURL: "https://gateway.internal",
      forwardBrowserToken: false,
    }
  );

  assert.equal(response.status, 204);
  assert.deepEqual(calls, [
    { url: "https://gateway.internal/api/admin/stats", authorization: "Bearer valid-token" },
    { url: "https://sandbox.internal/internal/pools", authorization: null },
  ]);
});

test("proxyModuleAdminRequest validates token before sandbox PUT and does not forward Authorization", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls: Array<{ url: string; method: string | undefined; authorization: string | null; body: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method,
      authorization: headers.get("authorization"),
      body: init?.body ? await new Response(init.body).text() : "",
    });
    if (String(input) === "https://gateway.internal/api/admin/stats") {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify([{ sku_id: "sku-hermes-2c4g" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }) as typeof fetch;

  const response = await proxyModuleAdminRequest(
    new Request("https://admin.example.com/admin/api/sandbox/template-classes/hermes/skus", {
      method: "PUT",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify([{ sku_id: "sku-hermes-2c4g" }]),
    }),
    { path: ["template-classes", "hermes", "skus"] },
    {
      module: "sandbox",
      upstreamBaseURL: "https://sandbox.internal",
      serviceName: "Sandbox",
      requireAdminTokenValidation: true,
      validationBaseURL: "https://gateway.internal",
      forwardBrowserToken: false,
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    {
      url: "https://gateway.internal/api/admin/stats",
      method: "GET",
      authorization: "Bearer valid-token",
      body: "",
    },
    {
      url: "https://sandbox.internal/internal/template-classes/hermes/skus",
      method: "PUT",
      authorization: null,
      body: JSON.stringify([{ sku_id: "sku-hermes-2c4g" }]),
    },
  ]);
});

test("proxyModuleAdminRequest proxies sandbox pool binding PUT through internal API", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls: Array<{ url: string; method: string | undefined; authorization: string | null; body: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method,
      authorization: headers.get("authorization"),
      body: init?.body ? await new Response(init.body).text() : "",
    });
    if (String(input) === "https://gateway.internal/api/admin/stats") {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify([{ pool_id: "pool-1" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }) as typeof fetch;

  const response = await proxyModuleAdminRequest(
    new Request("https://admin.example.com/admin/api/sandbox/template-classes/hermes/bindings", {
      method: "PUT",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify([{ pool_id: "pool-1" }]),
    }),
    { path: ["template-classes", "hermes", "bindings"] },
    {
      module: "sandbox",
      upstreamBaseURL: "https://sandbox.internal",
      serviceName: "Sandbox",
      requireAdminTokenValidation: true,
      validationBaseURL: "https://gateway.internal",
      forwardBrowserToken: false,
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    {
      url: "https://gateway.internal/api/admin/stats",
      method: "GET",
      authorization: "Bearer valid-token",
      body: "",
    },
    {
      url: "https://sandbox.internal/internal/template-classes/hermes/bindings",
      method: "PUT",
      authorization: null,
      body: JSON.stringify([{ pool_id: "pool-1" }]),
    },
  ]);
});

test("proxyModuleAdminRequest does not clear browser session when module upstream token fails", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    )) as typeof fetch;

  const response = await proxyModuleAdminRequest(
    new Request("https://admin.example.com/admin/api/auth/users", {
      headers: {
        cookie: `admin_session=${createAdminSessionValue("browser-token", Math.floor(Date.now() / 1000))}`,
      },
    }),
    { path: ["users"] },
    {
      module: "auth",
      upstreamBaseURL: "https://auth.internal",
      upstreamToken: "module-token",
      serviceName: "Auth admin",
    }
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("X-Admin-Session-Invalid"), null);
  assert.equal(response.headers.get("Set-Cookie"), null);
});
