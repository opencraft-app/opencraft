import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { APP_HOST_PROTOCOL_VERSION } from "@opencraft/app-host-protocol/version";
import { APP_HOST_CLIENT_INSTANCE_PARAMETER } from "@opencraft/app-host-protocol/routing";
import { RESUME_PROTOCOL_VERSION } from "@opencraft/app-host-resume";
import {
  CLIENT_ADMISSION_PATH,
  CLIENT_ATTACHMENT_HEADER,
  CLIENT_CURRENT_PATH,
  CLIENT_SOCKET_PATH,
} from "../../apps/headless-server/src/cloudflare/client-attachment.ts";
import { miniflareRuntime } from "../cloudflare/miniflare-runtime.ts";
import type { TestWebSocket, WorkerInstance, WorkerSpec } from "../cloudflare/worker-runtime.ts";
import {
  LOCAL_ORIGIN,
  OWNER_PASSWORD,
  PROOF,
  Browser,
  login,
  type Backend,
} from "../storage/workerd/installation-core-do.scenarios.ts";

const spec: WorkerSpec = {
  id: "admitted-client-do",
  entry: resolve(import.meta.dirname, "workerd/admitted-client-worker.ts"),
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { INSTALLATION_CORE: "InstallationCore", ACCOUNT_CORE: "AccountCore", CLIENT: "TestAdmittedClient" },
  externalNode: true,
};

const clientId = "customer-workbench-client";
function socketUrl(attempt: string, id = clientId): string {
  return `${LOCAL_ORIGIN}/apphost?${APP_HOST_CLIENT_INSTANCE_PARAMETER}=${id}&attempt=${attempt}`;
}

function cookie(browser: Browser): string {
  return [...browser.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function frames(socket: TestWebSocket) {
  const buffered: Record<string, any>[] = [];
  let notify: (() => void) | null = null;
  socket.addEventListener("message", ({ data }) => {
    assert.equal(typeof data, "string");
    buffered.push(JSON.parse(data as string));
    notify?.();
  });
  return {
    send(frame: object) {
      socket.send(JSON.stringify(frame));
    },
    async take(predicate: (frame: Record<string, any>) => boolean = () => true) {
      const started = Date.now();
      while (Date.now() - started < 5000) {
        while (buffered.length) {
          const frame = buffered.shift()!;
          if (predicate(frame)) return frame;
        }
        await new Promise<void>((done) => {
          const timer = setTimeout(done, 100);
          notify = () => {
            clearTimeout(timer);
            done();
          };
        });
      }
      throw new Error("App Host response did not arrive");
    },
  };
}

test(
  "real InstallationCore admission isolates Client attachments and rechecks membership and exact login",
  { timeout: 25_000 },
  async (t) => {
    const runtime = miniflareRuntime();
    t.after(() => runtime.dispose());
    const start = () =>
      runtime.start(spec, {
        persist: "admitted-client",
        localOrigin: LOCAL_ORIGIN,
        vars: {
          OPENCRAFT_HUMAN_AUTH: JSON.stringify({ origin: LOCAL_ORIGIN, local: true, oidc: [] }),
          OPENCRAFT_SETUP_TOKEN: PROOF,
        },
      });
    let worker: WorkerInstance = await start();
    const backend: Backend = {
      origin: LOCAL_ORIGIN,
      fetch: (path, init) => worker.fetch(LOCAL_ORIGIN + path, init),
      async restart() {
        await runtime.stop(worker);
        worker = await start();
      },
      close: () => runtime.stop(worker),
    };
    const { owner, member, memberId } = await login(backend);
    const headers = (browser: Browser) => ({ origin: LOCAL_ORIGIN, cookie: cookie(browser) });
    const privateAdmission = `${CLIENT_ADMISSION_PATH}?${APP_HOST_CLIENT_INSTANCE_PARAMETER}=${clientId}`;
    assert.equal((await backend.fetch(privateAdmission, { headers: headers(owner) })).status, 404);
    assert.equal((await backend.fetch(CLIENT_CURRENT_PATH, { method: "POST", headers: headers(owner) })).status, 404);
    assert.equal((await worker.upgrade(LOCAL_ORIGIN + CLIENT_SOCKET_PATH, headers(owner))).status, 404);
    assert.equal((await worker.upgrade(socketUrl("anonymous"), { origin: LOCAL_ORIGIN })).status, 401);
    assert.equal(
      (await worker.upgrade(socketUrl("cross-origin"), { ...headers(owner), origin: "https://wrong.example" })).status,
      403,
    );
    assert.equal(
      (await worker.upgrade(socketUrl("forged"), { origin: LOCAL_ORIGIN, [CLIENT_ATTACHMENT_HEADER]: "{}" })).status,
      401,
    );
    assert.equal((await worker.upgrade(socketUrl("invalid-id", "too-short"), headers(owner))).status, 400);
    assert.equal(
      (
        await worker.upgrade(
          socketUrl("duplicate") + `&${APP_HOST_CLIENT_INSTANCE_PARAMETER}=${clientId}`,
          headers(owner),
        )
      ).status,
      400,
    );

    const open = async (browser: Browser, attempt: string, options: { id?: string; resume?: object } = {}) => {
      const upgrade = await worker.upgrade(socketUrl(attempt, options.id), {
        ...headers(browser),
        [CLIENT_ATTACHMENT_HEADER]: "{}",
      });
      assert.equal(upgrade.status, 101, upgrade.text);
      const socket = upgrade.socket!;
      const wire = frames(socket);
      wire.send({
        type: "hello",
        protocolVersion: APP_HOST_PROTOCOL_VERSION,
        rendererId: clientId,
        ...(options.resume ? { resume: options.resume } : {}),
      });
      return { socket, wire };
    };
    const identify = async (wire: ReturnType<typeof frames>, sequence?: number, expectedGeneration?: number) => {
      let generation = expectedGeneration;
      const seq = (offset: number) => (sequence === undefined ? {} : { seq: sequence + offset });
      if (generation === undefined) {
        wire.send({ type: "host/connect", requestId: "connect", hostId: "fixture", leaseId: "lease", ...seq(0) });
        const connected = await wire.take((frame) => frame.requestId === "connect");
        assert.equal(connected.ok, true);
        generation = connected.result.generation;
      }
      wire.send({
        type: "host/send",
        requestId: "identify",
        hostId: "fixture",
        leaseId: "lease",
        generation,
        frame: JSON.stringify({ jsonrpc: "2.0", id: "fixture-identity", method: "fixture/identity" }),
        ...seq(expectedGeneration === undefined ? 1 : 0),
      });
      const reply = await wire.take((frame) => frame.type === "host/frame");
      const value = JSON.parse(reply.frame).result.instance as string;
      assert.match(value, /^[0-9a-f-]{36}$/u);
      return { value, generation, received: reply.seq as number };
    };

    const first = await open(owner, "first", { resume: { v: RESUME_PROTOCOL_VERSION } });
    const ready = await first.wire.take();
    assert.equal(ready.type, "ready");
    const original = await identify(first.wire, 1);
    const grant = ready.capabilities.resume;
    const resume = {
      v: RESUME_PROTOCOL_VERSION,
      sessionId: grant.sessionId,
      token: grant.token,
      received: original.received,
    };
    const replacement = await open(owner, "replacement", { resume });
    const resumed = await replacement.wire.take();
    assert.deepEqual(resumed, { type: "connection/resumed", received: 2 });
    assert.equal((await identify(replacement.wire, 3, original.generation)).value, original.value);

    const otherClient = await open(owner, "other-client", { id: "another-workbench-client" });
    assert.equal((await otherClient.wire.take()).type, "ready");
    assert.notEqual((await identify(otherClient.wire)).value, original.value);
    otherClient.socket.close();

    const memberClient = await open(member, "other-account");
    assert.equal((await memberClient.wire.take()).type, "ready");
    assert.notEqual((await identify(memberClient.wire)).value, original.value);
    const revoked = new Promise<number>((resolveCode) =>
      memberClient.socket.addEventListener("close", ({ code }) => resolveCode(code)),
    );
    assert.equal(
      (await owner.call("/__opencraft_access/members", { actorId: memberId, role: "member", enabled: false })).status,
      200,
    );
    memberClient.wire.send({ type: "connection/probe", requestId: "revoked" });
    assert.equal(await revoked, 1008);
    assert.equal((await worker.upgrade(socketUrl("revoked"), headers(member))).status, 403);

    replacement.socket.close();
    await backend.restart();
    const coldResume = await open(owner, "transport-buffer-lost", { resume });
    assert.deepEqual(await coldResume.wire.take(), { type: "connection/resume-failed", reason: "unknown-session" });
    const restored = await open(owner, "after-eviction");
    assert.equal((await restored.wire.take()).type, "ready");
    assert.equal((await identify(restored.wire)).value, original.value, "the Client object survived a runtime restart");

    const oldCookie = cookie(owner);
    const loggedOut = new Promise<number>((resolveCode) =>
      restored.socket.addEventListener("close", ({ code }) => resolveCode(code)),
    );
    assert.equal((await owner.call("/__opencraft_auth/logout", {})).status, 200);
    restored.wire.send({ type: "connection/probe", requestId: "logged-out" });
    assert.equal(await loggedOut, 1008);
    assert.equal(
      (await worker.upgrade(socketUrl("old-login"), { origin: LOCAL_ORIGIN, cookie: oldCookie })).status,
      401,
    );
    assert.equal(
      (await owner.call("/__opencraft_auth/local", { mode: "login", username: "owner", password: OWNER_PASSWORD }))
        .status,
      200,
    );
    const wrongLogin = await open(owner, "resume-under-new-login", { resume });
    assert.deepEqual(await wrongLogin.wire.take(), { type: "connection/resume-failed", reason: "unknown-session" });
    const reissued = await open(owner, "new-login");
    assert.equal((await reissued.wire.take()).type, "ready");
    assert.notEqual(
      (await identify(reissued.wire)).value,
      original.value,
      "a replacement login receives a new Client object",
    );
    reissued.socket.close();
  },
);
