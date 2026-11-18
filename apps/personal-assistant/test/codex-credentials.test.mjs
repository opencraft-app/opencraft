import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NativeCodexSession } from "../src/adapters/codex/native-session.mjs";

const binary =
  process.env.SUPERAPP_TEST_CODEX_BINARY ??
  "/opt/opencraft/runtime/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
for (const managed of [false, true]) test(
  `real persistent native ${managed ? "managed" : "file"} session authenticates without persisting its provider key`,
  { skip: !existsSync(binary), timeout: 20000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "sa-native-auth-")),
      key = "synthetic-provider-key-" + crypto.randomUUID(),
      home = join(root, "home");
    await writeFile(join(root, "credential"), key, { mode: 0o600 });
    let authorized = true, resolutions = 0;
    let authenticated = false,
      session,
      resolveTurn,
      rejectTurn;
    const done = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    done.catch(() => {});
    const server = http.createServer(async (req, res) => {
      try {
        assert.equal(req.headers.authorization, `Bearer ${key}`);
        authenticated = true;
        for await (const _ of req) {
          /* Consume request. */
        }
        // Allow the native snapshot capture to run during an actual provider exchange.
        await delay(400);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          [
            { type: "response.created", response: { id: "credential-test" } },
            {
              type: "response.output_item.done",
              item: {
                type: "message",
                role: "assistant",
                id: "message-test",
                content: [{ type: "output_text", text: "done" }],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "credential-test",
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ]
            .map((x) => "data: " + JSON.stringify(x) + "\n\n")
            .join(""),
        );
      } catch (error) {
        rejectTurn(error);
        res.writeHead(500).end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      session = await NativeCodexSession.open(
        {
          binary,
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          modelId: "gpt-5.4",
          ...(managed ? {managed:true,providerId:"test",baseUrl:undefined} : {credentialFile: join(root, "credential")}),
        },
        {
          ...(managed ? {resolveModel:async config=>{resolutions++;assert.equal(config.providerId,"test");if(!authorized)throw Error("model revoked");return {baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:key};}} : {}),
          home,
          cwd: join(root, "empty"),
          signal: AbortSignal.timeout(15000),
          onFailure: rejectTurn,
          onNotification: (p) => {
            if (p.method === "turn/completed")
              p.params.turn.status === "completed"
                ? resolveTurn()
                : rejectTurn(new Error("Native test turn failed"));
          },
        },
      );
      const { thread } = await session.rpc("thread/start", {
        model: "gpt-5.4",
        cwd: join(root, "empty"),
        ephemeral: false,
        approvalPolicy: "never",
        sandbox: "read-only",
        baseInstructions: "Return done only.",
        dynamicTools: [],
      });
      await session.rpc("thread/name/set", {
        threadId: thread.id,
        name: "synthetic-credential-check",
      });
      await session.rpc("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: "Return done.", text_elements: [] }],
      });
      await done;
      if(managed){
        assert.ok(resolutions>=2);authorized=false;
        await assert.rejects(session.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"blocked",text_elements:[]}]}),/model revoked/);
      }
      await session.close();
      session = undefined;
      assert.equal(
        authenticated,
        true,
        "Explicit credentials must still authenticate",
      );
      const leaks = [];
      async function scan(path) {
        for (const file of await readdir(path, { withFileTypes: true })) {
          const target = join(path, file.name);
          if (file.isDirectory()) await scan(target);
          else if (
            file.isFile() &&
            (await readFile(target)).includes(Buffer.from(key))
          )
            leaks.push(target.slice(home.length));
        }
      }
      await scan(home);
      assert.deepEqual(
        leaks,
        [],
        "Native home must not retain provider credentials",
      );
    } finally {
      await session?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  },
);
