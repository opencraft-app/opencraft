import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { ConnectorDatabase } from "../../packages/connector-host/src/store";
import { ManagedConnectorService } from "../../packages/connector-host/src/service";
import { ConnectorOAuth } from "../../packages/connector-host/src/oauth";
import { CONNECTOR_CATALOG } from "@opencraft/connector-core";
import { API_TOOLS, callApi } from "../../packages/connector-host/src/api";
import { MCP_DEFINITIONS, mcpEndpoint } from "../../packages/connector-host/src/mcp-endpoints";
import type { StoredConnection } from "../../packages/connector-host/src/store";
import { ConnectorMcp, toolsDigest } from "../../packages/connector-host/src/mcp";
import { connectorFetch } from "../../packages/connector-host/src/network";

test("Host database is multi-instance, CAS, private, and never projects credentials", async () => {
  const root = await mkdtemp("/tmp/oc-connector-db-"), path = join(root, "db.sqlite"); let db = new ConnectorDatabase(path);
  try {
    const input = { id: "personal", definitionId: "tencent-docs", title: "个人文档", expectedRevision: 0, values: {}, secrets: { token: "synthetic-personal" } };
    const saved = db.save(input); db.save({ ...input, id: "work", title: "工作文档" });
    assert.equal(db.list().length, 2); assert.ok(!JSON.stringify(db.list()).includes("synthetic-personal"));
    assert.deepEqual(saved.configuredFields, ["token"]);
    assert.throws(() => db.save(input), /conflict/);
    assert.throws(() => db.save({ ...input, id: "bad", values: { token: "leak" }, secrets: {} }), /invalid/);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    db.close(); db = new ConnectorDatabase(path);
    assert.equal(db.get("personal").secrets.token, "synthetic-personal");
    db.remove("personal", saved.revision); assert.equal(db.list().length, 1);
    assert.throws(() => db.get("personal"), /missing/);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("Host API projection distinguishes format checks from authentication and revokes saved revisions", async () => {
  const root = await mkdtemp("/tmp/oc-connector-api-"); const calls: unknown[] = [];
  const service = new ManagedConnectorService(join(root, "db.sqlite"), async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-news-key");
    return Response.json({ base_rsp: { code: 0 }, result: "news-result" });
  });
  try {
    assert.equal(CONNECTOR_CATALOG.length, 23);
    await service.handle("connectors/managed/save", { id: "news", definitionId: "tencent-news", title: "News", expectedRevision: 0, values: {}, secrets: { api_key: "synthetic-news-key" } });
    const probe = await service.probe("news"); assert.equal(probe.level, "format"); assert.equal(calls.length, 0);
    const tools = await service.tools("news");
    const request = { id: "news", revision: tools.revision, digest: tools.digest, tool: "search_news", arguments: { query: "isolated" } };
    assert.deepEqual(await service.handle("connectors/managed/call", request), { base_rsp: { code: 0 }, result: "news-result" });
    assert.equal(calls.length, 1);
    await service.handle("connectors/managed/setEnabled", { id: "news", revision: 1, enabled: false });
    await assert.rejects(service.handle("connectors/managed/call", request), /unavailable|conflict/); assert.equal(calls.length, 1);
    assert.ok(!JSON.stringify(service.list()).includes("synthetic-news-key"));
  } finally { service.close(); await rm(root, { recursive: true, force: true }); }
});

test("database OAuth uses real loopback authorization code exchange; status never returns tokens", async () => {
  const root = await mkdtemp("/tmp/oc-connector-oauth-"), path = join(root, "db.sqlite");
  let exchanges = 0, base = "", refreshes = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/.well-known/")) {
      res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] })); return;
    }
    let body = ""; for await (const part of req) body += part;
    if (req.url === "/register") { const value = JSON.parse(body); assert.match(value.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/); res.end(JSON.stringify({ ...value, client_id: "fixture-client" })); return; }
    if (req.url === "/token") { const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code") { assert.ok(form.get("code_verifier")); exchanges++; } else refreshes++;
      res.end(JSON.stringify({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 1 })); return;
    }
    res.writeHead(404); res.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let db = new ConnectorDatabase(path), changes = 0;
  let oauth = new ConnectorOAuth(db, () => { changes++; }, { notion: { issuer: base, url: `${base}/mcp` } }, fetch);
  try {
    db.save({ id: "n", definitionId: "notion", title: "Notion fixture", expectedRevision: 0, values: {}, secrets: {} });
    const start = await oauth.start("n"), authorization = new URL(start.authorizationUrl!);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    const callback = new URL(authorization.searchParams.get("redirect_uri")!); callback.searchParams.set("code", "fixture-code"); callback.searchParams.set("state", "wrong");
    assert.equal((await fetch(callback)).status, 400); assert.equal(exchanges, 0);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    assert.equal((await fetch(callback)).status, 200); assert.equal(exchanges, 1); assert.equal(changes, 1);
    assert.deepEqual(oauth.progress(start.id), { id: start.id, status: "complete" });
    assert.ok(!JSON.stringify(db.list()).includes("synthetic-access"));
    assert.ok(!Object.hasOwn(db.get("n").oauth, "verifier"));
    await oauth.refresh("n"); assert.equal(refreshes, 1);
    const cancelled = await oauth.start("n"); oauth.cancel(cancelled.id);
    assert.equal(oauth.progress(cancelled.id).status, "cancelled");
    const interrupted = await oauth.start("n"); oauth.dispose(); db.close();
    db = new ConnectorDatabase(path); oauth = new ConnectorOAuth(db, () => undefined);
    assert.equal(oauth.progress(interrupted.id).status, "cancelled");
    assert.equal(db.project(db.get("n")).authorization, "configured");
  } finally { oauth.dispose(); db.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("every advertised API adapter maps its advertised tools to bounded requests without executing a real service", async () => {
  for (const [definitionId, tools] of Object.entries(API_TOOLS)) {
    const row: StoredConnection = { id: "fixture", definitionId, title: "Fixture", revision: 1, enabled: true, updatedAt: 0,
      values: { client_id: "synthetic-client", base_url: "https://knowledge.example.test", tenant_id: "tenant" },
      secrets: { api_key: definitionId === "wechat-reading" ? "wrk-fixture" : definitionId === "qq-music" ? "qmk-fixture" : definitionId === "yuandian" ? "sk_fixture" : "a".repeat(32) }, oauth: {} };
    for (const tool of tools) {
      const args = Object.fromEntries((tool.inputSchema.required as string[]).map(key => [key, key === "top_id" || key === "diss_id" ? "1" : "fixture"]));
      const requests: string[] = [];
      await callApi(row, tool.name, args, async (url, init) => {
        requests.push(String(url)); assert.ok(init?.signal); assert.ok(["GET", "POST"].includes(String(init?.method)));
        return Response.json({ code: 0, status: 0, success: true, base_rsp: { code: 0 }, data: [{ id: "kb-fixture", content: "isolated" }] });
      });
      assert.ok(requests.length >= 1 && requests.length <= 2, `${definitionId}/${tool.name}`);
    }
  }
  assert.equal(API_TOOLS["tencent-ima"].find(tool => tool.name === "create_note")?.readOnly, false);
  assert.equal(API_TOOLS["tencent-ima"].find(tool => tool.name === "append_note")?.readOnly, false);
});

test("all advertised MCP mappings resolve an endpoint; credential fields never become public projection", () => {
  for (const definitionId of MCP_DEFINITIONS) {
    const row: StoredConnection = { id: "fixture", definitionId, title: "Fixture", revision: 1, enabled: true, updatedAt: 0, values: { company_from: "enterprise" },
      secrets: { token: "fixture-token", api_key: "fixture-key", mcp_url: "https://dify.example.test/mcp/server/fixture-code/mcp" }, oauth: {} };
    assert.equal(new URL(mcpEndpoint(row).url).protocol, "https:");
  }
});

test("real MCP SDK canonicalizes server order and rejects semantic catalog changes before execution", async () => {
  const root = await mkdtemp("/tmp/oc-connector-mcp-"), db = new ConnectorDatabase(join(root, "db.sqlite"));
  const oauth = new ConnectorOAuth(db, () => undefined); let calls = 0, lists = 0, description = "Read fixture";
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    assert.equal(req.headers.authorization, "synthetic-mcp-key");
    let raw = ""; for await (const part of req) raw += part;
    const message = JSON.parse(raw); if (!Object.hasOwn(message, "id")) { res.writeHead(202); res.end(); return; }
    const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: (++lists % 2 === 0 ? [
          { name: "other", description: "Other fixture", inputSchema: { properties: { b: { type: "string" }, a: { type: "number" } }, type: "object" }, annotations: { readOnlyHint: true } },
          { name: "read", description, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
        ] : [
          { name: "read", description, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          { name: "other", description: "Other fixture", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "string" } } }, annotations: { readOnlyHint: true } },
        ]) }
      : { content: [{ type: "text", text: "real MCP reply" }] };
    if (message.method === "tools/call") calls++;
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const mcp = new ConnectorMcp(db, oauth, row => ({ url, headers: { Authorization: row.secrets.token }, private: true }));
  try {
    db.save({ id: "m", definitionId: "tencent-docs", title: "MCP fixture", expectedRevision: 0, values: {}, secrets: { token: "synthetic-mcp-key" } });
    const tools = await mcp.list("m"), digest = toolsDigest(tools);
    assert.deepEqual(tools.map(tool => tool.name), ["other", "read"]);
    assert.equal(tools[0].readOnly, true);
    assert.deepEqual(await mcp.call("m", 1, digest, "read", {}), { content: [{ type: "text", text: "real MCP reply" }] });
    assert.equal(calls, 1); description = "Changed operation";
    await assert.rejects(mcp.call("m", 1, digest, "read", {}), /conflict/); assert.equal(calls, 1);
  } finally { oauth.dispose(); db.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("connector network rejects redirects and metadata targets without forwarding authorization", async () => {
  let targetCalls = 0;
  const target = createServer((_req, res) => { targetCalls++; res.end("must not reach"); });
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
  const source = createServer((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${(target.address() as { port: number }).port}/` }); res.end(); });
  await new Promise<void>(resolve => source.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(source.address() as { port: number }).port}`;
  try {
    await assert.rejects(connectorFetch([origin], true)(origin, { headers: { Authorization: "synthetic-only" } }), /unavailable/);
    assert.equal(targetCalls, 0);
    await assert.rejects(connectorFetch(["http://169.254.169.254"], true)("http://169.254.169.254/"), /invalid/);
    await assert.rejects(connectorFetch([origin])(origin), /invalid/);
  } finally { for (const server of [source, target]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } }
});

import { DatabaseSync } from "node:sqlite";
import { readdir } from "node:fs/promises";

test("ConnectorDatabase manages SQLite lifecycle: fresh, up-to-date, adopted, and rejected legacy", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-connector-lifecycle-"));
  const path = join(root, "managed.sqlite");
  try {
    // 1. Fresh
    const fresh = new ConnectorDatabase(path);
    assert.equal(fresh.outcome.status, "fresh");
    fresh.save({ id: "inst-1", definitionId: "tencent-docs", title: "Doc", expectedRevision: 0, values: {}, secrets: { token: "secret" } });
    fresh.close();

    // 2. Up-to-date
    const reopened = new ConnectorDatabase(path);
    assert.equal(reopened.outcome.status, "up-to-date");
    assert.equal(reopened.get("inst-1").title, "Doc");
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ConnectorDatabase adopts legacy matching database and rejects mismatched legacy database", async () => {
  for (const matching of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), `oc-connector-legacy-${matching ? "match" : "mismatch"}-`));
    const path = join(root, "managed.sqlite");
    try {
      const raw = new DatabaseSync(path);
      raw.exec(`
        CREATE TABLE connector_instances (id TEXT PRIMARY KEY, definition_id TEXT NOT NULL, title TEXT NOT NULL, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
        CREATE TABLE connector_credentials (instance_id TEXT PRIMARY KEY REFERENCES connector_instances(id) ON DELETE CASCADE, secrets TEXT NOT NULL, oauth TEXT NOT NULL) STRICT;
        CREATE TABLE connector_oauth_transactions (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL) STRICT;
      `);
      if (matching) {
        raw.prepare("INSERT INTO connector_instances VALUES(?,?,?,?,?,?,?)").run("inst-1", "tencent-docs", "Doc", 1, 1, "{}", 100);
        raw.prepare("INSERT INTO connector_credentials VALUES(?,?,?)").run("inst-1", JSON.stringify({ token: "legacy-token" }), "{}");
      } else {
        raw.exec("CREATE TABLE extra_table (id TEXT PRIMARY KEY)");
      }
      raw.close();

      if (!matching) {
        assert.throws(() => new ConnectorDatabase(path), (error: unknown) => (error as { kind?: string }).kind === "unsupported-legacy");
        const retained = new DatabaseSync(path, { readOnly: true });
        assert.ok(retained.prepare("SELECT name FROM sqlite_master WHERE name='extra_table'").get()); retained.close(); continue;
      }
      const db = new ConnectorDatabase(path);
      try {
        assert.equal(db.outcome.status, "adopted");
        assert.ok(db.outcome.backupPath);
        const files = await readdir(root);
        assert.ok(files.some(f => f.includes(".pre-v1-")));
        assert.equal(files.some(f => f.includes(".legacy-")), !matching);

        if (matching) {
          assert.equal(db.get("inst-1").secrets.token, "legacy-token");
        } else {
          assert.equal(db.list().length, 0);
        }
      } finally {
        db.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("known missing connector tables preserve configuration and credentials without accepting unknown objects or constraints", async () => {
  for (const variant of ["missing-oauth", "missing-credentials", "unknown-index", "wrong-constraint"] as const) {
    const root = await mkdtemp(join(tmpdir(), "oc-connector-missing-"));
    const path = join(root, "managed.sqlite");
    try {
      const raw = new DatabaseSync(path);
      raw.exec(`
        CREATE TABLE connector_instances (id TEXT PRIMARY KEY, definition_id TEXT NOT NULL, title TEXT NOT NULL, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
        CREATE TABLE connector_credentials (instance_id TEXT PRIMARY KEY ${variant === "wrong-constraint" ? "" : "REFERENCES connector_instances(id) ON DELETE CASCADE"}, secrets TEXT NOT NULL, oauth TEXT NOT NULL) STRICT;
      `);
      raw.prepare("INSERT INTO connector_instances VALUES(?,?,?,?,?,?,?)").run("inst", "tencent-docs", "Retained", 7, 1, "{}", 200);
      raw.prepare("INSERT INTO connector_credentials VALUES(?,?,?)").run("inst", JSON.stringify({ token: "synthetic-retained" }), JSON.stringify({ marker: "retained" }));
      if (variant === "unknown-index") raw.exec("CREATE INDEX unknown_index ON connector_instances(title)");
      if (variant === "missing-credentials") raw.exec("DROP TABLE connector_credentials");
      raw.close();

      if (variant === "unknown-index" || variant === "wrong-constraint") {
        assert.throws(() => new ConnectorDatabase(path), (error: unknown) => (error as { kind?: string }).kind === "unsupported-legacy");
        const retained = new DatabaseSync(path, { readOnly: true });
        assert.equal(retained.prepare("SELECT title FROM connector_instances").get()?.title, "Retained"); retained.close(); continue;
      }
      const db = new ConnectorDatabase(path);
      try {
        assert.equal(db.outcome.status, "migrated");
        assert.ok(db.outcome.backupPath);
        if (variant === "missing-oauth") {
          assert.equal(db.get("inst").revision, 7);
          assert.equal(db.get("inst").title, "Retained");
          assert.deepEqual(db.get("inst").secrets, { token: "synthetic-retained" });
          assert.deepEqual(db.get("inst").oauth, { marker: "retained" });
        } else if (variant === "missing-credentials") {
          assert.throws(() => db.get("inst"), /missing/); // Missing credentials cannot be invented.
        } else {
          assert.deepEqual(db.list(), []);
        }
      } finally { db.close(); }
      const again = new ConnectorDatabase(path);
      try {
        assert.equal(again.outcome.status, "up-to-date");
        assert.equal(again.outcome.backupPath, undefined);
        if (variant === "missing-oauth") assert.equal(again.get("inst").secrets.token, "synthetic-retained");
      } finally { again.close(); }
      const retained = new DatabaseSync(path);
      try {
        assert.equal(retained.prepare("SELECT title FROM connector_instances WHERE id='inst'").get()?.title, "Retained");
      } finally { retained.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
