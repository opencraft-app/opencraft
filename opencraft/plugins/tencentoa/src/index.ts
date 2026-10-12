import { THREAD_BADGE_CHANNEL } from "@opencraft/extension-react";
import { TencentOaParticipantsController, type ParticipantsClient } from "./participants-controller";
import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import { AUTHENTICATION_PROVIDER_CHANNEL, type AuthenticationProvider } from "@opencraft/workbench-runtime";
import { TENCENTOA_PROVIDER_ID } from "./contract";
import { TencentOaController } from "./controller";
import { createEmployeeIdentityView } from "./view";
import { createTencentOaAccountContribution } from "./account";

export { TencentOaController } from "./controller";
export type { TencentOaSnapshot } from "./controller";
export type { TencentOaIdentity } from "./contract";
export { createTencentOaAccountContribution } from "./account";

export function createTencentOaExtension(controller = new TencentOaController(), options?: { getClient(hostId: string): ParticipantsClient | undefined }): TrustedExtensionDefinition {
  return {
    manifest: { manifestVersion: 1, id: "tencentoa.identity", name: "Tencent OA", description: "Recognizes the current employee through the site's TAI authentication.",
      version: "0.1.0", apiVersion: 1, trust: "trusted", platforms: ["web"], activationEvents: ["onStartupFinished"] },
    async activate(api) {
      api.subscriptions.add(() => controller.dispose());
      await controller.refresh();
      if (api.signal.aborted) return;
      if (controller.getSnapshot().phase === "error") throw new Error("Employee identity service unavailable");
      if (controller.getSnapshot().available !== true) return;
      api.internal.register(AUTHENTICATION_PROVIDER_CHANNEL, {
        id: TENCENTOA_PROVIDER_ID, getSession: controller.getSession, subscribe: controller.subscribe,
        signIn: () => controller.signIn(), cancelSignIn: controller.cancelSignIn,
      } satisfies AuthenticationProvider);
      api.views.register({ id: "tencentoa.identity.employee-view", title: "员工身份", viewType: "tencentoa.identity.employee", platforms: ["web"] });
      api.settings.registerPage({ id: "tencentoa.identity.employee", title: "员工身份", viewId: "tencentoa.identity.employee-view", group: "通用", icon: "user", platforms: ["web"], order: 45 });
      api.internal.register("platformViewRenderer", { viewType: "tencentoa.identity.employee", Component: createEmployeeIdentityView(controller) });
      api.internal.register("platformAccount", createTencentOaAccountContribution(controller));
      if (options) {
        const { createParticipantsBadge } = await import("./participants-view");
        if (api.signal.aborted) return;
        const participants = new TencentOaParticipantsController(options.getClient);
        api.subscriptions.add(() => participants.dispose());
        let account = controller.getSnapshot().identity?.loginName ?? null;
        api.subscriptions.add(controller.subscribe(() => {
          const next = controller.getSnapshot().identity?.loginName ?? null;
          if (next !== account) { account = next; participants.clear(); }
        }));
        api.internal.register(THREAD_BADGE_CHANNEL, createParticipantsBadge(participants));
      }
      const onVisible = () => { if (document.visibilityState === "visible") void controller.refresh(); };
      document.addEventListener("visibilitychange", onVisible);
      api.subscriptions.add(() => document.removeEventListener("visibilitychange", onVisible));
    },
  };
}
