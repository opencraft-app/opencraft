import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { SandboxCommand, SandboxProcess } from "@opencraft/sandbox";
import { createSandboxConversationBinding } from "../../apps/local-agent-host/src/sandbox-conversation-binding";

test("binding launches only the preinstalled Hands exec-server through its authorized bridge", async (t) => {
  const commands: SandboxCommand[] = [];
  let client: WebSocket | undefined,
    exited!: (value: { code: number }) => void,
    terminations = 0;
  const exit = new Promise<{ code: number }>((resolve) => {
    exited = resolve;
  });
  const binding = await createSandboxConversationBinding({
    cwd: "/workspace",
    authorize: async () => {},
    onLost() {},
    onCleanupUnconfirmed() {
      assert.fail("Unexpected cleanup uncertainty");
    },
    sandbox: {
      async spawn(command, output) {
        commands.push(command);
        assert.deepEqual(command.command, [
          "/opt/opencraft/runtime/codex/bin/codex",
          "exec-server",
          "--listen",
          "stdio",
        ]);
        assert.equal(command.cwd, "/workspace");
        return {
          kind: "process",
          id: "preinstalled",
          exited: exit,
          async writeStdin(data) {
            const request = JSON.parse(Buffer.from(data).toString());
            output?.({ stream: "stdout", data: Buffer.from(JSON.stringify({ id: request.id, result: {} }) + "\n") });
          },
          async closeStdin() {},
          async terminate() {
            terminations++;
            exited({ code: 0 });
          },
        } satisfies SandboxProcess;
      },
    },
    async nativeRequest(method, params) {
      assert.equal(method, "environment/add");
      client = new WebSocket(String(params.execServerUrl));
      await once(client, "open");
      const response = once(client, "message");
      client.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
      assert.deepEqual(JSON.parse(String((await response)[0])), { id: 1, result: {} });
    },
  });
  t.after(() => binding.close());
  t.after(() => client?.terminate());
  assert.equal(commands.length, 1, "No preparation, extraction or download process precedes execution");
  await binding.close();
  assert.equal(terminations, 1);
});

test("missing preinstalled exec-server retires binding without a bootstrap or host fallback", async () => {
  let attempts = 0,
    losses = 0;
  await assert.rejects(
    createSandboxConversationBinding({
      cwd: "/workspace",
      authorize: async () => {},
      onLost() {
        losses++;
      },
      onCleanupUnconfirmed() {
        assert.fail("No process was created");
      },
      sandbox: {
        async spawn(command) {
          attempts++;
          assert.equal(command.command[0], "/opt/opencraft/runtime/codex/bin/codex");
          throw Error("ENOENT");
        },
      },
      async nativeRequest(_method, params) {
        const client = new WebSocket(String(params.execServerUrl));
        try {
          await once(client, "close");
        } finally {
          client.terminate();
        }
        throw Error("Preinstalled runtime unavailable");
      },
    }),
    /Preinstalled runtime unavailable/,
  );
  assert.equal(attempts, 1);
  assert.equal(losses, 1);
});
