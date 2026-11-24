// HTTP exchange services in workerd (docs/architecture/platform/gateway-split.md
// §4.2, G4). One SQLite-backed Durable Object runs the unchanged Headless
// `serverInformationHttp` handler over `ServerInformationStore` on the object's
// own state document storage, through the production Fetch adapter
// (`@opencraft/http-exchange/fetch`). `/__stream` returns a web-stream body to
// prove streamed responses pass through the same adapter. Test-only: the
// authority is a fixture that trusts `x-fixture-*` headers.
import { DurableObject } from "cloudflare:workers";
import { serveFetchHttpExchange } from "@opencraft/http-exchange/fetch";
import type { DurableObjectStorage } from "@opencraft/storage-cloudflare/bindings";
import { durableObjectStateDocumentStore } from "@opencraft/storage-cloudflare/state";
import {
  ServerInformationStore,
  serverInformationHttp,
} from "../../../apps/headless-server/src/server-information.mjs";
import { fixtureAuthority, streamedHandler } from "./http-exchange-fixture.ts";

interface Env {
  readonly ORIGIN: string;
  readonly CORE: {
    idFromName(name: string): unknown;
    get(id: unknown): ExchangeCore;
  };
}

export class ExchangeCore extends DurableObject<Env> {
  readonly #handler;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const store = new ServerInformationStore(
      durableObjectStateDocumentStore(ctx.storage as unknown as DurableObjectStorage),
    );
    this.#handler = serverInformationHttp(
      store,
      fixtureAuthority(() => env.ORIGIN),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const handler = new URL(request.url).pathname === "/__stream" ? streamedHandler : this.#handler;
    const response = await serveFetchHttpExchange(request, handler, {
      clientAddress: request.headers.get("cf-connecting-ip"),
    });
    // Bytes, so Response adds no implicit content-type (the node:http fallback sends none).
    return (
      response ??
      new Response(new TextEncoder().encode('{"error":"unowned"}'), { status: 404, headers: { "x-unowned": "1" } })
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const object = request.headers.get("x-test-object") ?? "exchange";
    return env.CORE.get(env.CORE.idFromName(object)).fetch(request);
  },
};
