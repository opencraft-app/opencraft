import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import { HostInteractions } from "../../../packages/app-host-server/src/interactions";
import { SHARED_INTERACTIONS_CHANGED, SHARED_INTERACTIONS_EXTENSION, SHARED_INTERACTIONS_READ, SHARED_INTERACTIONS_RESPOND } from "@opencraft/appserver-protocol";

const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-shared-interactions";
await mkdir(output, { recursive: true });
const interactions = new HostInteractions(), ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => ws.once("listening", resolve));
let writes = 0, failWrite = false, holdNext = false, failedResponses = 0, revokeInValidation = false;
let rejectHeld!: (error: Error) => void;
const unlisten = interactions.subscribe(() => { for (const socket of ws.clients) if (socket.readyState === WebSocket.OPEN)
  socket.send(JSON.stringify({ method: SHARED_INTERACTIONS_CHANGED, params: interactions.snapshot("thread", true) })); });
ws.on("connection", socket => socket.on("message", async raw => {
  const request = JSON.parse(String(raw));
  if (!request.method || request.id === undefined) return;
  try {
    let result: unknown;
    if (request.method === "initialize") result = { userAgent: "fixture", capabilities: { extensions: { [SHARED_INTERACTIONS_EXTENSION]: { version: 1 } } } };
    else if (request.method === SHARED_INTERACTIONS_READ) result = interactions.snapshot("thread", true);
    else if (request.method === SHARED_INTERACTIONS_RESPOND) {
      const p = request.params;
      const disposition = await interactions.respond(p.threadId, p.interactionId, p.submissionId, p.result, async () => {
        writes++; if (failWrite) throw Error("fixture write failure");
        if (holdNext) { holdNext = false; await new Promise<void>((_resolve, reject) => { rejectHeld = reject; }); }
      }, () => { if (revokeInValidation) { revokeInValidation = false; interactions.markSourceUnavailable("thread"); } });
      result = { disposition, snapshot: interactions.snapshot("thread", true) };
    } else throw Error("Unexpected method");
    socket.send(JSON.stringify({ id: request.id, result }));
  } catch { failedResponses++; socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: "Fixture response delivery failed" } })); }
}));
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-shared-interactions",
  optimizeDeps: { entries: ["tests/fixtures/shared-interactions.tsx"], include: ["react", "react-dom/client", "react/jsx-runtime", "react-intl"] },
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "shared-interaction-smoke", configureServer(server) {
    server.middlewares.use((request, response, next) => { if (request.url?.split("?")[0] !== "/") return next();
      response.setHeader("content-type", "text/html"); response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/shared-interactions.tsx"></script>');
    });
  } }],
});
let browser: any;
try {
  await vite.listen(); browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?ws=${encodeURIComponent(`ws://127.0.0.1:${(ws.address() as any).port}`)}`;
  const errors: string[] = [];
  const open = async (width: number, theme = "light") => {
    const page = await browser.newPage({ viewport: { width, height: 850 } }); page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(url + `&theme=${theme}`);
    try { await page.waitForFunction(() => (window as any).ready); }
    catch (cause) { console.error(JSON.stringify({ browserErrors: errors })); throw cause; }
    return page;
  };
  const a = await open(390), b = await open(1280, "dark");
  const pending = (id: number) => interactions.capture({ id, method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn", itemId: `item-${id}`, command: "echo safe" } });
  pending(1);
  for (const page of [a, b]) await page.getByRole("button", { name: /Allow once/ }).waitFor();
  interactions.markSourceUnavailable("thread");
  for (const page of [a, b]) { await page.getByText("This request cannot be answered from this view right now.", { exact: true }).waitFor(); assert.equal(await page.getByRole("button", { name: /Allow once/ }).isDisabled(), true); }
  pending(1);
  for (const page of [a, b]) await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent?.includes("Allow once") && !button.disabled));
  await a.screenshot({ path: `${output}/pending-mobile.png` });
  await a.getByRole("button", { name: /Allow once/ }).click();
  for (const page of [a, b]) { await page.getByText("A response was submitted. Waiting for the server to confirm…", { exact: true }).waitFor(); assert.equal(await page.getByRole("button", { name: /Allow once/ }).isDisabled(), true); }
  assert.equal(writes, 1);
  const late = await open(390); await late.getByText("A response was submitted. Waiting for the server to confirm…", { exact: true }).waitFor();
  await a.close(); interactions.resolveNative(1, "thread");
  for (const page of [b, late]) await page.locator(".thread-approval-request").waitFor({ state: "detached" });
  failWrite = true; pending(2); await late.getByRole("button", { name: /Allow once/ }).click();
  for (const page of [b, late]) { await page.getByText("Response delivery is unconfirmed. Reconnecting will check its status.", { exact: true }).waitFor(); assert.equal(await page.getByRole("button", { name: /Allow once/ }).isDisabled(), true); }
  await late.screenshot({ path: `${output}/unconfirmed-mobile.png` }); await b.screenshot({ path: `${output}/unconfirmed-desktop.png` });
  assert.equal(writes, 2);
  interactions.resolveNative(2, "thread"); failWrite = false; holdNext = true;
  const replay = (id: number, state: "pending" | "responding") => interactions.capture({ id, method: "item/commandExecution/requestApproval",
    params: { threadId: "thread", turnId: "turn", itemId: "reply-owner", command: "echo safe" },
    __opencraftInteractionKey: "reply-owner-lifetime", __opencraftInteractionState: state });
  replay(3, "pending");
  await late.getByRole("button", { name: /Allow once/ }).click();
  for (const page of [b, late]) await page.getByText("A response was submitted. Waiting for the server to confirm…", { exact: true }).waitFor();
  replay(4, "pending");
  await b.getByRole("button", { name: /Allow once/ }).click();
  for (const page of [b, late]) await page.getByText("A response was submitted. Waiting for the server to confirm…", { exact: true }).waitFor();
  const revision = interactions.snapshot("thread", true).revision, errorsBefore = failedResponses;
  rejectHeld(Error("retired writer failed"));
  await assert.doesNotReject(async () => {
    for (let attempt = 0; failedResponses === errorsBefore && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(failedResponses, errorsBefore + 1, "the old caller still receives its failure");
  });
  assert.equal(interactions.snapshot("thread", true).revision, revision, "old failure cannot publish to the new answer");
  assert.equal(writes, 4);
  for (const page of [b, late]) {
    await page.getByText("A response was submitted. Waiting for the server to confirm…", { exact: true }).waitFor();
    assert.equal(await page.getByText("Response delivery is unconfirmed. Reconnecting will check its status.", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /Allow once/ }).isDisabled(), true);
  }
  await late.screenshot({ path: `${output}/late-failure-mobile.png` }); await b.screenshot({ path: `${output}/late-failure-desktop.png` });
  interactions.resolveNative(4, "thread");
  for (const page of [b, late]) await page.locator(".thread-approval-request").waitFor({ state: "detached" });
  pending(5); revokeInValidation = true;
  const beforeRevocation = interactions.snapshot("thread", true).revision;
  await b.getByRole("button", { name: /Allow once/ }).click();
  for (const page of [b, late]) {
    await page.getByText("This request cannot be answered from this view right now.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /Allow once/ }).isDisabled(), true);
  }
  assert.equal(writes, 4, "validation revocation never reaches native write");
  assert.equal(interactions.snapshot("thread", true).requests[0]!.state, "pending", "revoked validation must not occupy an answer slot");
  assert.equal(interactions.snapshot("thread", true).revision, beforeRevocation + 1, "only the source revocation publishes");
  await late.screenshot({ path: `${output}/validation-revoked-mobile.png` });
  pending(5); // Producer re-offers the route without inventing a new pending phase.
  for (const page of [b, late]) await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent?.includes("Allow once") && !button.disabled));
  await late.getByRole("button", { name: /Allow once/ }).click();
  for (const page of [b, late]) await page.getByText("A response was submitted. Waiting for the server to confirm…", { exact: true }).waitFor();
  assert.equal(writes, 5, "producer restoration admits exactly one real answer");
  await late.screenshot({ path: `${output}/validation-recovered-mobile.png` }); await b.screenshot({ path: `${output}/validation-recovered-desktop.png` });
  interactions.resolveNative(5, "thread");
  for (const page of [b, late]) await page.locator(".thread-approval-request").waitFor({ state: "detached" });
  for (const page of [b, late]) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []); console.log(JSON.stringify({ result: "passed", subscribers: 3, realBroker: true, realCard: true, settlement: true, uncertainDelivery: true, lateFailurePreserved: true, oldCallerRejected: true, validationRevocation: true, producerRestoration: true, mobile: true, desktop: true, output }));
} finally { await browser?.close(); await vite.close(); unlisten(); for (const socket of ws.clients) socket.terminate(); await new Promise<void>(resolve => ws.close(() => resolve())); }
