import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { AppServerRpcError, type ExecutionEngineClient, type ExecutionEngineProvider } from "@opencraft/appserver-client";

interface Attachment { resolveWebsocketUrl(): Promise<string>; close(): Promise<void> }
type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Aggregation attaches to a separately supervised owner. Closing this proxy
 * releases only observation sockets, never the native engine or its tasks. */
export class RemoteEngineProvider implements ExecutionEngineProvider {
  private readonly clients = new Map<ExecutionEngineClient, { socket: WebSocket; ready: Promise<void>; pending: Map<string, Pending> }>();
  private readonly listeners = new Set<(method: string, params: Record<string, any>) => void>();
  private unknown = false;
  private callbacks = 0;
  handoffObservation() { return { coverage: this.unknown ? "unknown" : "complete", activeCount: this.callbacks + [...this.clients.values()].reduce((n, row) => n + row.pending.size, 0) }; }
  private capabilities: Readonly<Record<string, unknown>> = {};
  private readonly control: ExecutionEngineClient = { request: async () => { throw new Error("No platform tool owner"); }, notify() {} };
  constructor(readonly id: string, readonly label: string, readonly threadPrefix: string, readonly modelPrefix: string, private readonly attachment: Attachment) {}
  get extensions() { return this.capabilities; }
  ownsThread(id: string) { return id.startsWith(this.threadPrefix); }
  ownsModel(id: string) { return id.startsWith(this.modelPrefix); }
  async start() {
    const initialized = await this.request("initialize", { clientInfo: { name: "opencraft-engine-attachment", version: "1" }, capabilities: { experimentalApi: true } }, this.control);
    this.capabilities = initialized.capabilities?.extensions ?? {};
  }
  subscribe(listener: (method: string, params: Record<string, any>) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async request(method: string, params: Record<string, any>, client: ExecutionEngineClient): Promise<any> {
    let state = this.clients.get(client);
    if (!state) {
      const url = await this.attachment.resolveWebsocketUrl();
      state = this.clients.get(client);
      if (!state) {
        const socket = new WebSocket(url), pending = new Map<string, Pending>();
        const ready = new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); socket.once("close", () => reject(new Error("Independent engine connection closed"))); });
        state = { socket, ready, pending }; this.clients.set(client, state);
        const current = state;
        socket.on("message", data => {
          let message; try { message = JSON.parse(data.toString()); } catch { socket.close(1002); return; }
          if (message.method) {
            if (message.id !== undefined) {
              this.callbacks++;
              void client.request(message.method, message.params ?? {}).then(result => {
                if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
              }, () => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Platform owner unavailable" } })); }).finally(() => { this.callbacks--; });
            } else client.notify(message.method, message.params ?? {});
            return;
          }
          const call = pending.get(String(message.id)); if (!call) return;
          pending.delete(String(message.id)); clearTimeout(call.timer);
          message.error ? call.reject(new AppServerRpcError(message.error)) : call.resolve(message.result);
        });
        const stop = () => {
          if (this.clients.get(client) === current) this.clients.delete(client);
          if (pending.size) this.unknown = true;
          for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("Independent engine outcome unknown")); } pending.clear();
        };
        socket.on("close", stop); socket.on("error", stop);
      }
    }
    await state.ready;
    if (this.clients.get(client) !== state || state.socket.readyState !== WebSocket.OPEN) throw new Error("Independent engine connection changed");
    const current = state, id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.unknown = true; current.pending.delete(id); reject(new Error("Independent engine outcome unknown")); }, 35_000);
      current.pending.set(id, { resolve, reject, timer }); current.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
  disconnect(client: ExecutionEngineClient) { const state = this.clients.get(client); state?.socket.close(); }
  async close() { for (const state of this.clients.values()) state.socket.close(); await this.attachment.close(); this.listeners.clear(); }
}
