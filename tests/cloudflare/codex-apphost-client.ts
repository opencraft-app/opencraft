// Exercise the same AppHost handshake and Codex RPCs in workerd and Cloudflare.
import assert from "node:assert/strict";
import { APP_HOST_PROTOCOL_VERSION } from "@opencraft/app-host-protocol/version";
import { APP_HOST_CLIENT_INSTANCE_PARAMETER } from "@opencraft/app-host-protocol/routing";
import type { TestWebSocket, WorkerInstance, WorkerRuntime } from "./worker-runtime.ts";
import { until } from "./worker-wire.ts";

type Frame = {
  id?: string;
  type?: string;
  requestId?: string;
  ok?: boolean;
  result?: any;
  error?: any;
  frame?: string;
};

export function frameQueue(runtime: Pick<WorkerRuntime, "patience">, socket: TestWebSocket) {
  const observed: Array<{ frame: Frame; receivedAt: number }> = [];
  socket.addEventListener("message", ({ data }) => {
    observed.push({ frame: JSON.parse(String(data)), receivedAt: performance.now() });
  });
  let disconnect: number | undefined;
  socket.addEventListener("close", ({ code }) => {
    disconnect = code;
  });
  return async (select: (frame: Frame) => boolean, description = "frame", timeoutMs = 3000) => {
    const find = () => {
      const index = observed.findIndex(({ frame }) => select(frame));
      if (index === -1 && disconnect !== undefined)
        throw new Error(`Socket closed (${disconnect}) before ${description}`);
      return index;
    };
    const index = await until(runtime, find, (index) => index !== -1, timeoutMs);
    assert.notEqual(index, -1, `Timed out waiting for ${description}`);
    const { frame, receivedAt } = observed.splice(index, 1)[0]!;
    return { ...frame, receivedAt };
  };
}

export async function connectCodex(
  runtime: Pick<WorkerRuntime, "patience">,
  instance: WorkerInstance,
  browser: { cookies: ReadonlyMap<string, string> },
  sockets: TestWebSocket[],
  execution = "unavailable",
  clientInstanceId = "workspace-codex-reader",
) {
  const target = new URL("/apphost", instance.origin);
  target.searchParams.set(APP_HOST_CLIENT_INSTANCE_PARAMETER, clientInstanceId);
  const cookie = [...browser.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  const upgrade = await instance.upgrade(target.href, { origin: instance.origin, cookie });
  assert.equal(upgrade.status, 101, upgrade.text ?? "AppHost upgrade failed");
  const socket = upgrade.socket!;
  sockets.push(socket);
  const take = frameQueue(runtime, socket);
  const send = (frame: object) => socket.send(JSON.stringify(frame));
  send({ type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: "workbench" });
  await take((frame) => frame.type === "ready", "AppHost ready");
  const route = { hostId: "local-codex", leaseId: "workbench-lease" };
  send({ type: "host/connect", requestId: "connect", ...route });
  const host = await take((frame) => frame.requestId === "connect", "Codex host connection");
  assert.equal(host.ok, true, JSON.stringify(host.error));
  assert.equal(host.result.execution, execution);
  let sequence = 0;
  const rpc = async (method: string, params?: unknown, id?: string): Promise<Frame> => {
    const requestId = String(++sequence);
    id ??= requestId;
    send({
      type: "host/send",
      requestId,
      ...route,
      generation: host.result.generation,
      frame: JSON.stringify({ id, method, params }),
    });
    const frame = await take(
      (entry) => entry.type === "host/frame" && JSON.parse(entry.frame!).id === id,
      `Codex reply to ${method}`,
    );
    return JSON.parse(frame.frame!);
  };
  const initialization = await rpc("initialize", {});
  assert.ok(initialization.result, JSON.stringify(initialization.error));
  const initialized = initialization.result;
  assert.match(initialized.userAgent, /OpenCraft/);
  const event = async (method: string, select: (params: any) => boolean = () => true, timeoutMs?: number) => {
    const frame = await take(
      (entry) => {
        if (entry.type !== "host/frame") return false;
        const parsed = JSON.parse(entry.frame!);
        return parsed.method === method && select(parsed.params);
      },
      `Codex event ${method}`,
      timeoutMs,
    );
    return { ...JSON.parse(frame.frame!), receivedAt: frame.receivedAt };
  };
  return { socket, rpc, initialized, event };
}
