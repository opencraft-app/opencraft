import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { DeviceIdentityPort, DeviceIdentityReadResult } from "../types/host-policy.ts";

type Dependencies = "appServer" | "userDirectory";

export function uuidV4(): string {
  const random = crypto.randomBytes(16);
  const variant = ((Number.parseInt(random.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${random.slice(0, 8)}-${random.slice(8, 12)}-4${random.slice(13, 16)}-${variant}${random.slice(17, 20)}-${random.slice(20, 32)}`;
}

export class DeviceIdentityService extends Service implements DeviceIdentityPort {
  static inject = ["appServer", "userDirectory"] satisfies Inject<
    Pick<HypernodeServices, Dependencies>
  >;

  declare protected ctx: HypernodeContext<Dependencies>;
  readonly installationId: string;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "deviceIdentity");
    this.installationId = policyStore.getOrInsert("deviceIdentity", "installationId", uuidV4());
    ctx.effect(() => ctx.appServer.register("hypernode/device/read", (_params, connection) =>
      this.read(connection.identity?.id)));
  }

  read(userId: string | null = null): DeviceIdentityReadResult {
    const user = userId ? this.ctx.userDirectory.find(userId) : null;
    return {
      installationId: user?.installationId ?? this.installationId,
      synthetic: true,
      persistedAt: user?.codexHome ? `${user.codexHome}/installation_id` : "/workspace/.codex/installation_id",
      userId: user?.id ?? null,
      username: user?.username ?? null,
      bindingState: user?.codexBindingState ?? "unbound",
      loginMethods: ["chatgptDeviceCode"],
    };
  }

  isBound(userId: string): boolean {
    return this.read(userId).bindingState === "bound";
  }

  setBindingState(userId: string, state: "bound" | "unbound"): void {
    if (!userId) return;
    this.ctx.userDirectory.setCodexBindingState(userId, state);
  }
}
