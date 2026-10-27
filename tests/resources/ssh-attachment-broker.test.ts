import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { OPENCRAFT_ATTACHMENT_STAGING_EXTENSION, OPENCRAFT_THREAD_QUEUE_EXTENSION, OPENCRAFT_METHOD_ACCESS_EXTENSION } from "@opencraft/appserver-protocol";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { SshCodexTransport } from "../../apps/opencraft-daemon/src/ssh-codex-transport.js";
import { fixtureFiles } from "../fixtures/ssh-files.js";

test("SSH broker uploads, sends model-readable remote refs, persists history/forks and protects sent files", async t => {
  const root = await mkdtemp(join(tmpdir(), "ssh-attachments-broker-"));
  const remoteHome = join(root, "remote"), history = join(root, "hub");
  await mkdir(remoteHome);
  const calls: any[] = [];
  let adapter: CodexEngineAdapter;
  let sequence = 0;
  const create = () => {
    const transport = new SshCodexTransport({ hostname: "fixture.invalid", port: 22, username: "fixture", knownHostsFile: "/synthetic/known_hosts", authentication: { kind: "agent" },
      spawnSsh: (args, env) => {
        const child = spawn(process.execPath, [new URL("../fixtures/fake-codex-ssh-proxy.mjs", import.meta.url).pathname, args.at(-1)!], {
          stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...env, FIXTURE_ATTACHMENT_ROOT: remoteHome },
        });
        child.on("message", value => calls.push(value)); return child;
      },
    });
    return new CodexEngineAdapter({ kind: "remote", transport, logDiagnostic: () => undefined,
      attachmentHistoryDirectory: history, attachments: { directory: join(history, "attachments"), namespace: "b".repeat(64), files: fixtureFiles() },
    });
  };
  const rpc = async (method: string, params: unknown = {}, clientId = "client-a") => {
    const id = `request-${++sequence}`;
    const reply = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { dispose(); reject(new Error(`Timeout ${method}`)); }, 15000);
      const dispose = adapter.subscribeMessage(frame => {
        const value = JSON.parse(frame); if (value.id !== id) return;
        clearTimeout(timer); dispose(); assert.equal(value[LOGICAL_CLIENT_FIELD], clientId); resolve(value);
      });
    });
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
    return reply;
  };
  adapter = create();
  t.after(async () => { await adapter.close(); await rm(root, { recursive: true, force: true }); });
  await adapter.connect();
  const init = (await rpc("initialize")).result;
  const extensions = init.capabilities.extensions;
  assert.equal(extensions[OPENCRAFT_ATTACHMENT_STAGING_EXTENSION].maxBytes, 1024 * 1024 * 1024);
  assert.equal(extensions[OPENCRAFT_THREAD_QUEUE_EXTENSION], undefined, "Staging must not advertise Local queue/goals/desktop");
  assert.equal(extensions["opencraft/desktop"], undefined);
  assert.ok(extensions[OPENCRAFT_METHOD_ACCESS_EXTENSION].methods.includes("attachment/stage"));
  const input = { clientAttachmentId: "remote-document", name: "开业.pdf", mimeType: "application/pdf", size: 5,
    source: { kind: "client-bytes", dataBase64: Buffer.from("hello").toString("base64") } };
  assert.ok((await rpc("attachment/stage", input, "uninitialized")).error);
  const staged = (await rpc("attachment/stage", input)).result;
  const path = staged.ref.location.path;
  assert.ok(path.startsWith(remoteHome + "/")); assert.ok(!path.startsWith(history + "/"));
  assert.equal((await readFile(path)).toString(), "hello");
  assert.deepEqual((await rpc("attachment/stage", input)).result, staged);
  assert.ok((await rpc("attachment/stage", { ...input, source: { kind: "client-bytes", dataBase64: Buffer.from("other").toString("base64") } })).error);
  await rpc("thread/start");
  const sent = await rpc("turn/start", { threadId: "attachment-thread", clientUserMessageId: "message-with-file", input: [{ type: "mention", name: input.name, path }] });
  assert.equal(sent.error, undefined);
  const physical = calls.find(frame => frame.method === "turn/start");
  assert.ok(physical.params.input[0].text.includes(path));
  assert.equal(physical.params.input[0].text_elements[0].placeholder, "opencraft:staged-file:v1");
  assert.ok(!calls.some(frame => frame.method.startsWith("attachment/")), "Extensions terminate at our broker");
  const items = (await rpc("thread/items/list", { threadId: "attachment-thread" })).result;
  assert.equal(items.data[0].item.attachments[0].name, input.name);
  assert.ok((await rpc("attachment/remove", { id: input.clientAttachmentId })).error);
  await rpc("thread/fork", { threadId: "attachment-thread" });
  const fork = (await rpc("thread/items/list", { threadId: "attachment-fork" })).result;
  assert.deepEqual(fork.data[0].item.attachments, items.data[0].item.attachments);
  await adapter.close(); adapter = create(); await adapter.connect(); await rpc("initialize");
  const restored = (await rpc("thread/items/list", { threadId: "attachment-thread" })).result;
  assert.deepEqual(restored.data[0].item.attachments, items.data[0].item.attachments);
  assert.ok((await rpc("attachment/remove", { id: input.clientAttachmentId })).error);
  const unsent = (await rpc("attachment/stage", { ...input, clientAttachmentId: "unsent-file" })).result;
  assert.deepEqual((await rpc("attachment/remove", { id: "unsent-file" })).result, { removed: true });
  await assert.rejects(readFile(unsent.ref.location.path));
  const stale = await rpc("turn/start", { threadId: "attachment-thread", clientUserMessageId: "stale-file",
    input: [{ type: "mention", name: input.name, path: unsent.ref.location.path }] });
  assert.ok(stale.error);
});
