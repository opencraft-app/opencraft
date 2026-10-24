import type { Page } from "playwright";

/** Diagnostic logical client, using the same trusted AppHost lease protocol as the UI. */
export async function connectFixtureAppHost(page: Page) {
  await page.evaluate("window.__name=value=>value");
  await page.evaluate(async () => {
    const rendererId = "diagnostic-" + crypto.randomUUID(), leaseId = rendererId + ":lease", channel = new MessageChannel();
    const outer = new Map(), rpc = new Map(); let sequence = 0, generation = 0;
    const port = channel.port1;
    port.onmessage = event => {
      const message = event.data;
      if (message.type === "response") {
        const pending = outer.get(message.requestId); outer.delete(message.requestId);
        message.ok ? pending?.resolve(message.result) : pending?.reject(new Error(message.error.message));
      } else if (message.type === "host/frame") {
        const frame = JSON.parse(message.frame), pending = rpc.get(frame.id);
        if (pending) { rpc.delete(frame.id); frame.error ? pending.reject(new Error(frame.error.message)) : pending.resolve(frame.result); }
      } else if (message.type === "ready") outer.get("ready")?.resolve();
    }; port.start();
    const ready = new Promise<void>((resolve, reject) => outer.set("ready", { resolve, reject }));
    window.postMessage({ type: "opencraft:connect-app-host", protocolVersion: 2, rendererId }, location.origin, [channel.port2]);
    port.postMessage({ type: "hello", protocolVersion: 2, rendererId }); await ready;
    const envelope = (body: any) => new Promise<any>((resolve, reject) => {
      const requestId = "diagnostic-envelope:" + ++sequence; outer.set(requestId, { resolve, reject }); port.postMessage({ ...body, requestId });
    });
    generation = (await envelope({ type: "host/connect", hostId: "local", leaseId })).generation;
    const request = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => {
      const id = "diagnostic-rpc:" + ++sequence; rpc.set(id, { resolve, reject });
      void envelope({ type: "host/send", hostId: "local", leaseId, generation, frame: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }).catch(reject);
    });
    (window as any).__diagnosticAppHost = { request };
    await request("initialize", { clientInfo: { name: "isolated-diagnostic", version: "1" }, capabilities: { experimentalApi: true } });
  });
  return (method: string, params: any = {}) => page.evaluate(({ method, params }) => (window as any).__diagnosticAppHost.request(method, params), { method, params });
}
