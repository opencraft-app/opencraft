import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import {
  CodexHostServices,
  codexAccountsService,
  codexTasksService,
} from "../../apps/opencraft-daemon/src/codex-host-services.ts";

function routing() {
  const sent: any[] = [],
    listeners = new Set<(frame: string) => void>();
  let closed = false;
  const transport = {
    status: { state: "open" as const },
    async connect() {},
    subscribeStatus() {
      return () => {};
    },
    subscribeMessage(listener: (frame: string) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(raw: string) {
      const frame = JSON.parse(raw);
      sent.push(frame);
      if (frame.id !== undefined) {
        const result =
          frame.method === "initialize"
            ? { userAgent: "codex", capabilities: { extensions: { "opencraft/thread-queue": { version: 2 } } } }
            : { routed: frame.method };
        for (const listener of listeners)
          listener(JSON.stringify({ id: frame.id, result, [LOGICAL_CLIENT_FIELD]: frame[LOGICAL_CLIENT_FIELD] }));
      }
    },
    async close() {
      closed = true;
    },
  };
  return {
    transport,
    sent,
    get closed() {
      return closed;
    },
  };
}

test("Host-wide duties are answered by the front; Thread work goes to routing untouched", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-host-services-"));
  const inner = routing(),
    frames: any[] = [];
  let opened = 0,
    serviceClosed = false;
  const services = new CodexHostServices(inner.transport as any, (clients) => [
    {
      ...codexTasksService(join(directory, "tasks.sqlite"), clients, () => {
        opened++;
      }),
    },
    {
      handles: (method) => method === "fixture/boom",
      request: () => {
        throw Object.assign(new Error("boom"), { code: -32042 });
      },
      capabilities: () => ({ "fixture/front": { version: 1 } }),
      close: () => {
        serviceClosed = true;
      },
    },
  ]);
  services.subscribeMessage((frame) => frames.push(JSON.parse(frame)));
  const send = async (id: number | undefined, method: string, params: unknown = {}, client = "a") => {
    await services.send(
      JSON.stringify({ ...(id === undefined ? {} : { id }), method, params, [LOGICAL_CLIENT_FIELD]: client }),
    );
    return frames.find((frame) => frame.id === id);
  };
  try {
    assert.equal(
      (await send(90, "opencraft/tasks/list", {}, "early")).error.code,
      -32600,
      "an uninitialized client is refused, as before",
    );
    const init = await send(1, "initialize", { clientInfo: { name: "t", version: "1" } });
    assert.deepEqual(
      init.result.capabilities.extensions,
      { "opencraft/thread-queue": { version: 2 }, "fixture/front": { version: 1 } },
      "routing capabilities kept, front ones added",
    );
    await send(2, "initialize", {}, "b");
    const task = (id: string, title: string) => ({
      id,
      title,
      description: "",
      projectServerId: null,
      projectId: null,
      status: "todo",
    });
    const created = await send(3, "opencraft/tasks/create", task("task-1", "Write the plan"));
    assert.equal(created.error, undefined, JSON.stringify(created.error));
    assert.equal(created[LOGICAL_CLIENT_FIELD], "a");
    assert.ok(existsSync(join(directory, "tasks.sqlite")));
    assert.equal(opened, 1, "the store opening is reported once");
    assert.deepEqual(
      services.storage().map((row) => row.name),
      ["tasks"],
    );
    assert.equal(
      frames
        .filter((f) => f.method === "opencraft/tasks/changed")
        .map((f) => f[LOGICAL_CLIENT_FIELD])
        .sort()
        .join(),
      "a,b",
      "every initialized client hears the change",
    );
    assert.ok(
      !inner.sent.some((frame) => String(frame.method).startsWith("opencraft/tasks/")),
      "tasks never reach Thread routing",
    );
    assert.deepEqual((await send(4, "thread/list")).result, { routed: "thread/list" });
    assert.deepEqual((await send(5, "fixture/boom")).error, { code: -32042, message: "boom" });
    assert.equal((await send(6, "opencraft/tasks/frobnicate")).error.code !== undefined, true);
    await send(undefined, "runtime/client/disconnect", {}, "b");
    const before = frames.filter((f) => f.method === "opencraft/tasks/changed").length;
    await send(7, "opencraft/tasks/create", task("task-2", "Second"));
    assert.equal(
      frames.filter((f) => f.method === "opencraft/tasks/changed").length,
      before + 1,
      "a disconnected client hears nothing",
    );
    assert.ok(
      inner.sent.some((frame) => frame.method === "runtime/client/disconnect"),
      "disconnect still reaches routing",
    );
  } finally {
    await services.close();
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(inner.closed, true);
  assert.equal(serviceClosed, true);
});

test("Core-backed accounts are relayed by the front, before initialize too, with the account failure shape", async () => {
  const calls: unknown[] = [];
  const control = {
    async accountRequest(method: string, params: Record<string, unknown>) {
      calls.push([method, params]);
      if (method.endsWith("/remove")) throw new Error("Core refused");
      return { accounts: [{ id: "a1" }] };
    },
  };
  const inner = routing(),
    frames: any[] = [];
  const services = new CodexHostServices(inner.transport as any, () => [codexAccountsService(control)]);
  services.subscribeMessage((frame) => frames.push(JSON.parse(frame)));
  const send = async (id: number, method: string, params: unknown = {}) => {
    await services.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "early" }));
    return frames.find((frame) => frame.id === id);
  };
  try {
    assert.deepEqual(
      (await send(1, "opencraft/codex/accounts/list")).result,
      { accounts: [{ id: "a1" }] },
      "no initialize needed, as before",
    );
    const failed = (await send(2, "opencraft/codex/accounts/remove", { accountId: "a1" })).error;
    assert.equal(failed.code, -32020);
    assert.ok(failed.data.codexAccountFailure);
    assert.equal((await send(3, "opencraft/codex/accounts/personal/start")).error.code, -32020);
    assert.deepEqual(
      calls.map((call: any) => call[0]),
      ["opencraft/codex/accounts/list", "opencraft/codex/accounts/remove"],
      "personal subscriptions never reach Core here",
    );
    assert.ok(!inner.sent.some((frame) => String(frame.method).startsWith("opencraft/codex/accounts/")));
  } finally {
    await services.close();
  }
});
