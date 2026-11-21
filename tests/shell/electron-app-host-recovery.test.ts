import assert from "node:assert/strict";
import test from "node:test";
import type { MessagePortAppHostClient } from "@opencraft/app-host-client";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { connectRecoveringElectronAppHost } from "../../apps/workbench-web/src/runtime/electron-app-host.ts";

/** A Host channel on one physical port: open while the port lives, failed once it is terminated. */
class PortChannel implements DuplexTransport {
  status: TransportStatus = { state: "idle" };
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  constructor(private readonly port: FakePort) { port.channels.add(this); }
  async connect(): Promise<void> {
    // As the real client: a Host channel opens only after its port is ready.
    await this.port.waitUntilReady().catch(() => undefined);
    if (this.port.isClosed) { this.publish({ state: "failed", reason: "App Host port terminated" }); throw new Error("App Host port terminated"); }
    this.publish({ state: "open" });
  }
  async send(): Promise<void> {}
  subscribeMessage(): () => void { return () => undefined; }
  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener); return () => this.statusListeners.delete(listener);
  }
  async close(): Promise<void> { this.publish({ state: "closed" }); }
  publish(status: TransportStatus) { this.status = status; for (const listener of [...this.statusListeners]) listener(status); }
}

class FakePort {
  isClosed = false;
  readonly channels = new Set<PortChannel>();
  waitUntilReady() { return this.isClosed ? Promise.reject(new Error("terminated")) : Promise.resolve(); }
  createTransport() { return new PortChannel(this); }
  close() { this.isClosed = true; }
  /** Main reports that the daemon connection closed. */
  terminate() { this.isClosed = true; for (const channel of this.channels) channel.publish({ state: "failed", reason: "DAEMON_CONNECTION_CLOSED" }); }
}

test("a terminated Electron port is replaced on a backoff, not retried in a tight loop", async () => {
  const ports: FakePort[] = [];
  const appHost = connectRecoveringElectronAppHost({
    connect: () => { const port = new FakePort(); ports.push(port); return port as unknown as MessagePortAppHostClient; },
    retryDelaysMs: [150],
  });
  try {
    const transport = appHost.createTransport("local");
    const statuses: TransportStatus[] = [];
    transport.subscribeStatus(status => statuses.push(status));
    await transport.connect();
    assert.equal(transport.status.state, "open");
    assert.equal(ports.length, 1);

    // The daemon goes away: the port is terminated and the Host channel fails.
    ports[0]!.terminate();
    assert.equal(transport.status.state, "failed");

    // Consumers reconnect at once (as the channel watchers do). Every one of them
    // joins the same waiting attempt; no new port is requested before the delay.
    const started = Date.now();
    const reconnects = Array.from({ length: 20 }, () => transport.connect());
    assert.equal(transport.status.state, "connecting");
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(ports.length, 1, "no port is requested inside the backoff window");
    assert.ok(statuses.some(status => status.state === "connecting" && status.connectionStage === "retry"));

    await Promise.all(reconnects);
    assert.ok(Date.now() - started >= 140, "the replacement waited for the backoff");
    assert.equal(ports.length, 2, "exactly one replacement port");
    assert.equal(transport.status.state, "open");
  } finally { appHost.close(); }
});

test("closing the recovering App Host closes its transports and the current port", async () => {
  const ports: FakePort[] = [];
  const appHost = connectRecoveringElectronAppHost({
    connect: () => { const port = new FakePort(); ports.push(port); return port as unknown as MessagePortAppHostClient; },
  });
  const transport = appHost.createTransport("local");
  await transport.connect();
  appHost.close();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ports[0]!.isClosed, true);
  assert.equal(transport.status.state, "closed");
  assert.throws(() => appHost.createTransport("local"), /closed/u);
});
