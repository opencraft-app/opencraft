import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { requestLoopback } from "../apps/local-agent-host/src/loopback-http.js";
test("loopback transport strips credentials and rejects public/control targets and redirected escape", async () => {
  let headers: any;
  const server = createServer((req, res) => {
    headers = req.headers;
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://example.com/" }); res.end(); return; }
    res.setHeader("set-cookie", "private=test");
    res.end("fixture");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as {port:number}).port;
  const signal = new AbortController().signal;
  try {
    const result = await requestLoopback({ url: `http://127.0.0.1:${port}/`, headers: { cookie: "x", authorization: "x" } }, signal, []);
    assert.equal(Buffer.from(result.bodyBase64,"base64").toString(),"fixture");
    assert.equal(headers.cookie,undefined); assert.equal(headers.authorization,undefined);
    assert.equal(result.headers["set-cookie"],undefined);
    await assert.rejects(requestLoopback({url:`http://127.0.0.1:${port}/`},signal,[port]),/control/);
    await assert.rejects(requestLoopback({url:"http://example.com/"},signal,[]),/loopback/);
    await assert.rejects(requestLoopback({url:`http://127.0.0.1:${port}/redirect`},signal,[]),/loopback/);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
