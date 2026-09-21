import { Service, type Inject } from "@deepseek-ai/cordis";
import { uuidV4 } from "./device-identity.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";

type Dependencies = "appServer";

interface AccountRecord {
  type: "chatgpt";
  email: string | null;
  planType: "pro";
}

interface LoginRecord {
  status: "pending" | "completed" | "canceled";
}

export class AccountService extends Service {
  static inject = ["appServer"] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  private account: AccountRecord | null = {
    type: "chatgpt",
    email: null,
    planType: "pro",
  };
  private readonly logins = new Map<string, LoginRecord>();

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "account");
    ctx.effect(() => ctx.appServer.register("getAuthStatus", () => ({
      authMethod: this.account === null ? null : "chatgpt",
      authToken: null,
      requiresOpenaiAuth: true,
    })));
    ctx.effect(() => ctx.appServer.register("account/read", () => ({
      account: this.account,
      requiresOpenaiAuth: true,
    })));
    ctx.effect(() => ctx.appServer.register("account/login/start", (params, connection) => {
      if (params["type"] !== "chatgptDeviceCode") {
        throw new Error(
          "Hypernode credential-bearing login is disabled; " +
          "use chatgptDeviceCode with a test identity",
        );
      }
      const loginId = uuidV4();
      this.logins.set(loginId, { status: "completed" });
      this.account = { type: "chatgpt", email: null, planType: "pro" };
      ctx.appServer.notifyAfter(connection, "account/login/completed", {
        loginId,
        success: true,
        error: null,
        onboardingEntrypoint: null,
      });
      ctx.appServer.notifyAfter(connection, "account/updated", {
        authMode: "chatgpt",
        planType: "pro",
      });
      return {
        type: "chatgptDeviceCode",
        loginId,
        verificationUrl: "https://hypernode.invalid/device",
        userCode: "Q7KM-4P2R",
      };
    }));
    ctx.effect(() => ctx.appServer.register("account/login/cancel", (params) => ({
      status: this.logins.get(String(params["loginId"] ?? ""))?.status === "pending"
        ? "canceled"
        : "notFound",
    })));
    ctx.effect(() => ctx.appServer.register("account/logout", (_params, connection) => {
      this.account = null;
      ctx.appServer.notifyAfter(connection, "account/updated", {
        authMode: null,
        planType: null,
      });
      return {};
    }));
  }
}
