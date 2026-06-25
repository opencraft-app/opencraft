import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { VelaLocalTracer } from "../../../../packages/vela-observability-client/src";
import { VeladRuntimeManager } from "./velad-runtime-manager";
import {
  parseVeladReadyLine,
  VELACHAT_API_PROTOCOL,
  VELAD_LOCAL_RUNTIME_PROTOCOL,
} from "./velad-runtime-state";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill() {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

class MemoryLogger {
  lines: string[] = [];

  write(source: string, message: string) {
    this.lines.push(`${source} ${message}`);
  }
}

function createManager(options: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  observability?: VelaLocalTracer;
  onSpawn?: (child: FakeChild, command: string, args: string[], options: unknown) => void;
}) {
  const logger = new MemoryLogger();
  let child: FakeChild | null = null;
  const manager = new VeladRuntimeManager({
    host: {
      getPath(name) {
        return name === "home" ? "/tmp/home" : "/tmp/user-data";
      },
    },
    resourcesPath: "/tmp/resources",
    env: options.env,
    logger,
    fetchImpl: options.fetchImpl ?? fetch,
    observability: options.observability,
    readyTimeoutMs: options.readyTimeoutMs ?? 100,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 100,
    requestTimeoutMs: 100,
    resolveBundledVeladPath: () => "/tmp/velad",
    spawnImpl: ((command: string, args: string[], spawnOptions: unknown) => {
      child = new FakeChild();
      options.onSpawn?.(child, command, args, spawnOptions);
      return child;
    }) as never,
  });
  return { manager, logger, getChild: () => child };
}

function readyLine(overrides: Record<string, unknown> = {}) {
  return `${JSON.stringify({
    type: "velad.ready",
    runtime_protocol: VELAD_LOCAL_RUNTIME_PROTOCOL,
    api_protocol: VELACHAT_API_PROTOCOL,
    pid: 123,
    listen_addr: "127.0.0.1:49321",
    api_base_url: "http://127.0.0.1:49321/api/v1",
    otel_protocol: "otlp.http.json",
    otel_base_url: "http://127.0.0.1:49321",
    observability_base_url: "http://127.0.0.1:49321/api/v1/observability",
    version: "0.1.0",
    ...overrides,
  })}\n`;
}

test("manager resolves local startup from stdout velad.ready", async () => {
  let spawnedArgs: string[] = [];
  const { manager, getChild } = createManager({
    onSpawn(child, _command, args) {
      spawnedArgs = args;
      queueMicrotask(() => child.stdout.write(readyLine()));
    },
  });

  const info = await manager.ensureReady();

  assert.equal(info.apiBaseUrl, "http://127.0.0.1:49321/api/v1");
  assert.equal(info.listenAddr, "127.0.0.1:49321");
  assert.deepEqual(spawnedArgs.slice(0, 2), ["--listen", "127.0.0.1:0"]);
  assert.equal(getChild()?.killed, false);
});

test("manager exports local startup span to velad OTLP endpoint", async () => {
  const traceRequests: any[] = [];
  const observability = new VelaLocalTracer({
    serviceName: "vela-desktop-electron-test",
    tracerName: "vela.desktop.electron.test",
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      traceRequests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ accepted: true, spans: 1, logs: 0 });
    }) as typeof fetch,
  });
  const { manager } = createManager({
    observability,
    onSpawn(child) {
      queueMicrotask(() => child.stdout.write(readyLine()));
    },
  });

  await manager.ensureReady();

  assert.equal(traceRequests.length, 1);
  assert.equal(traceRequests[0].url, "http://127.0.0.1:49321/v1/traces");
  const span = traceRequests[0].body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.name, "electron.velad.start");
  assert.deepEqual(
    span.attributes.find((attribute: any) => attribute.key === "velad.runtime.mode"),
    { key: "velad.runtime.mode", value: { stringValue: "local" } },
  );
  assert.deepEqual(
    span.attributes.find((attribute: any) => attribute.key === "velad.otel_base_url"),
    { key: "velad.otel_base_url", value: { stringValue: "http://127.0.0.1:49321" } },
  );
});

test("manager preserves runtime PATH precedence when spawning local velad", async () => {
  let spawnedOptions: { env?: NodeJS.ProcessEnv } | null = null;
  const { manager } = createManager({
    env: {
      HOME: "/tmp/home",
      PATH: "/login/bin:/opt/homebrew/bin:/usr/bin",
      RUST_LOG: "debug",
    },
    onSpawn(child, _command, _args, options) {
      spawnedOptions = options as { env?: NodeJS.ProcessEnv };
      queueMicrotask(() => child.stdout.write(readyLine()));
    },
  });

  await manager.ensureReady();

  assert.equal(spawnedOptions?.env?.RUST_LOG, "debug");
  assert.match(spawnedOptions?.env?.PATH ?? "", /^\/login\/bin:\/opt\/homebrew\/bin:\/usr\/bin/);
});

test("non-json stdout is logged but does not trigger ready", async () => {
  const { manager, logger } = createManager({
    readyTimeoutMs: 5,
    onSpawn(child) {
      queueMicrotask(() => child.stdout.write("plain log line\n"));
    },
  });

  await assert.rejects(manager.ensureReady(), /ready event timed out/);
  assert.match(logger.lines.join("\n"), /plain log line/);
});

test("wrong ready protocol fails startup", async () => {
  const { manager } = createManager({
    onSpawn(child) {
      queueMicrotask(() => child.stdout.write(readyLine({ runtime_protocol: "wrong.v1" })));
    },
  });

  await assert.rejects(manager.ensureReady(), /unsupported velad runtime protocol/);
});

test("manager ignores legacy listen env and spawns local velad", async () => {
  let spawnedCommand = "";
  const requested: string[] = [];
  const legacyListenEnv = ["VELA", "DESKTOP", "VELAD", "LISTEN", "ADDR"].join("_");
  const { manager } = createManager({
    env: {
      [legacyListenEnv]: "127.0.0.1:3857",
      VELA_DESKTOP_VELAD_PATH: "/tmp/dev-velad",
    },
    fetchImpl: (async (url: RequestInfo | URL) => {
      requested.push(String(url));
      return Response.json(JSON.parse(readyLine()));
    }) as typeof fetch,
    onSpawn(child, command) {
      spawnedCommand = command;
      queueMicrotask(() => child.stdout.write(readyLine()));
    },
  });

  await manager.ensureReady();

  assert.equal(spawnedCommand, "/tmp/dev-velad");
  assert.deepEqual(requested, []);
});

test("shutdown posts runtime endpoint and waits for child exit", async () => {
  const requests: string[] = [];
  const { manager, getChild } = createManager({
    fetchImpl: (async (url: RequestInfo | URL) => {
      requests.push(String(url));
      queueMicrotask(() => getChild()?.emit("exit", 0, null));
      return Response.json({ accepted: true });
    }) as typeof fetch,
    onSpawn(child) {
      queueMicrotask(() => child.stdout.write(readyLine()));
    },
  });
  await manager.ensureReady();

  await manager.stop();

  assert.deepEqual(requests, ["http://127.0.0.1:49321/api/v1/runtime/shutdown"]);
  assert.equal(getChild()?.killed, false);
});

test("shutdown fallback uses child.kill without shelling out", async () => {
  const { manager, getChild } = createManager({
    shutdownTimeoutMs: 5,
    fetchImpl: (async () => Response.json({ accepted: true })) as typeof fetch,
    onSpawn(child) {
      queueMicrotask(() => child.stdout.write(readyLine()));
    },
  });
  await manager.ensureReady();

  await manager.stop();

  assert.equal(getChild()?.killed, true);
});

test("ready parser returns null for unrelated stdout", () => {
  assert.equal(parseVeladReadyLine("not json"), null);
});
