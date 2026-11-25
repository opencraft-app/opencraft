// The production edge and InstallationCore with a test-only Client binding.
// The Client uses the real App Host wire and a synthetic Host transport; it
// does not substitute a new public protocol for the Workbench's /apphost.
import { DurableObject } from "cloudflare:workers";
import { ResumeRegistry } from "@opencraft/app-host-resume/server";
import { AppHostServer } from "@opencraft/app-host-server";
import type { SessionSocketHandler } from "@opencraft/client-session";
import { acceptAppHostClientSession } from "@opencraft/client-session/app-host";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import type {
  DeploymentEnv,
  InstallationCoreNamespace,
} from "../../../apps/headless-server/src/cloudflare/bindings.ts";
import {
  CLIENT_SOCKET_PATH,
  currentClientAttachment,
  parseClientAttachment,
  readClientAttachment,
  type ClientAttachment,
} from "../../../apps/headless-server/src/cloudflare/client-attachment.ts";

export { AccountCore, InstallationCore, default } from "../../../apps/headless-server/src/cloudflare/worker.ts";

type Env = DeploymentEnv & { CLIENT: InstallationCoreNamespace };

export class TestAdmittedClient extends DurableObject<Env> {
  #instance = "";
  readonly #sessions = new WeakMap<WebSocket, SessionSocketHandler>();
  readonly #resumes = new ResumeRegistry();
  readonly #appHost = new AppHostServer({
    createTransport: () =>
      new MemoryTransport({
        receive: (frame, peer) => {
          const request = JSON.parse(frame) as { id: string | number };
          peer.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { instance: this.#instance } }));
        },
      }),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const existing = await ctx.storage.get<string>("test-instance");
      this.#instance = existing ?? crypto.randomUUID();
      if (!existing) await ctx.storage.put("test-instance", this.#instance);
    });
  }

  #current(attachment: ClientAttachment): Promise<boolean> {
    const scope = this.env.INSTALLATION_CORE;
    return currentClientAttachment(scope.get(scope.idFromName("installation")), attachment);
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== CLIENT_SOCKET_PATH || request.headers.get("upgrade") !== "websocket")
      return new Response(null, { status: 404 });
    if (request.headers.has("cookie") || request.headers.has("authorization"))
      throw new Error("Client binding received a browser credential");
    const attachment = readClientAttachment(request);
    if (!attachment || !(await this.#current(attachment))) return new Response(null, { status: 403 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = parseClientAttachment(socket.deserializeAttachment());
    if (!attachment || !(await this.#current(attachment))) {
      socket.close(1008, "Client admission revoked");
      this.#sessions.get(socket)?.close(1008);
      this.#sessions.delete(socket);
      return;
    }
    let handler = this.#sessions.get(socket);
    if (!handler) {
      handler = acceptAppHostClientSession(
        {
          get readyState() {
            return socket.readyState;
          },
          bufferedAmount: 0,
          send(frame, done) {
            let error: Error | undefined;
            try {
              socket.send(frame);
            } catch (failure) {
              error = failure instanceof Error ? failure : new Error("Socket send failed");
            }
            done?.(error);
          },
          close: (code, reason) => socket.close(code, reason),
          terminate: () => socket.close(1012, "Socket superseded"),
        },
        {
          appHostServer: this.#appHost,
          diagnostic() {},
          resume: {
            registry: this.#resumes,
            identity: this.ctx.id.toString(),
            route: null,
            authority: { hold: () => true, release() {} },
            deadline: attachment.expiresAt,
          },
        },
      );
      this.#sessions.set(socket, handler);
    }
    const frame = typeof message === "string" ? message : new Uint8Array(message);
    handler.message(frame, typeof frame === "string" ? new TextEncoder().encode(frame).byteLength : frame.byteLength);
  }

  webSocketClose(socket: WebSocket, code: number): void {
    this.#sessions.get(socket)?.close(code);
    this.#sessions.delete(socket);
    if (socket.readyState !== WebSocket.CLOSED) socket.close();
  }

  webSocketError(socket: WebSocket): void {
    this.#sessions.get(socket)?.error();
  }
}
