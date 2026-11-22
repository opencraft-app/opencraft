import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

/** Synthetic remote only: no managed GitHub credential or real account is read. */
export async function githubApiFixture() {
  const calls: { path: string; method: string }[] = [];
  const keys: { id: number; key: string }[] = [];
  let mode: "registered" | "manual" | "unknown" = "registered";
  let block: { path: string; reached(): void; gate: Promise<void> } | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url!, "http://fixture.invalid").pathname;
      calls.push({ path, method: req.method! });
      assert.equal(req.headers.authorization, "Bearer synthetic-github-api-token");
      if (block?.path === path) {
        const current = block;
        current.reached();
        await current.gate;
      }
      res.setHeader("content-type", "application/json");
      if (path === "/user") res.end(JSON.stringify({ login: "fixture", id: 42 }));
      else if (path === "/user/emails") res.end(JSON.stringify([{ email: "fixture@example.test", verified: true }]));
      else if (path === "/user/ssh_signing_keys") {
        if (mode === "manual") {
          res.statusCode = 403;
          res.end("{}");
          return;
        }
        if (req.method === "GET") res.end(JSON.stringify(keys));
        else {
          const parts = [];
          for await (const part of req) parts.push(part);
          const input = JSON.parse(Buffer.concat(parts).toString("utf8"));
          const key = { id: keys.length + 1, key: input.key };
          keys.push(key);
          // The remote persisted it, but the response did not reach our owner.
          if (mode === "unknown") {
            res.destroy();
            return;
          }
          res.end(JSON.stringify(key));
        }
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    })().catch(() => {
      res.statusCode = 500;
      res.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    calls,
    keys,
    setMode(value: typeof mode) {
      mode = value;
    },
    pause(path: string) {
      let release!: () => void, reached!: () => void;
      const entered = new Promise<void>((r) => {
          reached = r;
        }),
        gate = new Promise<void>((r) => {
          release = r;
        });
      block = { path, reached, gate };
      return {
        entered,
        release() {
          block = undefined;
          release();
        },
      };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
