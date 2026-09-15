import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { ThreadLifecyclePrincipal } from "../types/thread-lifecycle.ts";

type Dependencies = "appServer";

interface RootPrincipal extends ThreadLifecyclePrincipal {
  readonly id: string;
  readonly username: string;
  readonly role: string;
  readonly authentication: string;
  readonly isolation: string;
  readonly bootstrap: boolean;
}

const ROOT_PRINCIPAL: RootPrincipal = Object.freeze({
  id: "node:root",
  username: "root",
  role: "administrator",
  authentication: "none",
  isolation: "shared",
  bootstrap: true,
});

function persistedRootPrincipal(encoded: string): RootPrincipal {
  const decoded: unknown = JSON.parse(encoded);
  if (decoded === null || typeof decoded !== "object") {
    throw new Error("invalid bootstrap principal");
  }
  const value = decoded as Record<string, unknown>;
  if (value["id"] !== ROOT_PRINCIPAL.id || value["role"] !== ROOT_PRINCIPAL.role) {
    throw new Error("invalid bootstrap principal");
  }
  return Object.freeze({
    id: ROOT_PRINCIPAL.id,
    username: typeof value["username"] === "string"
      ? value["username"]
      : ROOT_PRINCIPAL.username,
    role: ROOT_PRINCIPAL.role,
    authentication: typeof value["authentication"] === "string"
      ? value["authentication"]
      : ROOT_PRINCIPAL.authentication,
    isolation: typeof value["isolation"] === "string"
      ? value["isolation"]
      : ROOT_PRINCIPAL.isolation,
    bootstrap: typeof value["bootstrap"] === "boolean"
      ? value["bootstrap"]
      : ROOT_PRINCIPAL.bootstrap,
  });
}

export class PrincipalService extends Service {
  static inject = ["appServer"] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  private readonly principal: RootPrincipal;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "principal");
    const encoded = policyStore.getOrInsert(
      "principal",
      "bootstrapOwner",
      JSON.stringify(ROOT_PRINCIPAL),
    );
    this.principal = persistedRootPrincipal(encoded);
    ctx.effect(() => ctx.appServer.register("hypernode/principal/read", () => ({
      principal: this.principal,
    })));
  }

  current(): RootPrincipal {
    return this.principal;
  }
}
