import { DurableObject } from "cloudflare:workers";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { sealedText } from "@opencraft/secret-storage/sealed";
import { SessionCapabilities } from "@opencraft/session-capabilities";
import { capabilityResultToMcp } from "@opencraft/session-capabilities/content";
import { CapabilitySessionAuthority } from "@opencraft/session-capabilities/session-authority";
import { createWebCapabilityCredentials } from "@opencraft/session-capabilities/credential-wire";

interface Env {
  CAPABILITY: DurableObjectNamespace;
  TEST_CAPABILITY_KEY: string;
}

const scope = { serverId: "fixture-server", threadId: "fixture-thread" };
const tool = { name: "probe", description: "Local synthetic capability", inputSchema: { type: "object" as const } };

export class TestCapability extends DurableObject<Env> {
  private readonly capabilities = new SessionCapabilities();
  private readonly authority = new CapabilitySessionAuthority(this.capabilities);
  private readonly credentials = createWebCapabilityCredentials(sealedText.decode(this.env.TEST_CAPABILITY_KEY));
  private readonly reservation = this.authority.prepareExecution({ memoryOnly: true });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.reservation.bindThread(scope);
    this.capabilities.register({
      id: "fixture",
      tools: (session) => (session.execution?.inputId === "first-input" ? [tool] : []),
      async call(session) {
        return { execution: session.execution };
      },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const credentials = await this.credentials;
    if (pathname === "/fixture/reserve")
      return Response.json({ token: await credentials.sign(this.reservation.claims) });
    if (pathname === "/fixture/bind") {
      try {
        this.reservation.bind({ ...scope, ...((await request.json()) as object) });
      } catch {
        return new Response(null, { status: 409 });
      }
      return new Response(null, { status: 204 });
    }
    if (pathname === "/fixture/revoke") {
      this.reservation.cancel();
      return new Response(null, { status: 204 });
    }
    if (pathname !== "/thread-cli" && pathname !== "/mcp") return new Response(null, { status: 404 });
    const token = request.headers.get("authorization");
    const claims = token?.startsWith("Bearer ") ? await credentials.verify(token.slice(7)) : null;
    const authenticate = () => this.authority.authenticate(pathname === "/mcp" ? "mcp" : "execution-cli", claims);
    const auth = authenticate();
    if (!auth) return new Response(null, { status: 401 });
    if (pathname === "/thread-cli") return Response.json(auth.session);
    const server = new Server({ name: "workerd-capability-fixture", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, (_, extra) => this.authority.list(auth, extra.signal));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      try {
        return capabilityResultToMcp(
          await this.authority.call(auth, authenticate, params.name, params.arguments ?? {}, extra.signal),
        );
      } catch {
        return { isError: true, content: [{ type: "text", text: "Capability unavailable" }] };
      }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  }
}

export default {
  fetch(request: Request, env: Env) {
    return env.CAPABILITY.get(env.CAPABILITY.idFromName("fixture")).fetch(request);
  },
};
