import type { PlatformAccountContribution, PlatformAccountSnapshot } from "@opencraft/extension-react";
import type { TencentOaController, TencentOaSnapshot } from "./controller";

/** Projects the same verified, per-client identity used by the settings page. */
export function createTencentOaAccountContribution(controller: TencentOaController): PlatformAccountContribution {
  let previous: TencentOaSnapshot | null = null;
  let projected: PlatformAccountSnapshot;
  return {
    id: "tencentoa.identity.employee",
    viewId: "tencentoa.identity.employee-view",
    entrancePriority: 100,
    getSnapshot: () => {
      const snapshot = controller.getSnapshot();
      if (snapshot !== previous) {
        previous = snapshot;
        projected = Object.freeze({
          revision: snapshot.revision,
          phase: snapshot.identity ? "authenticated" : "anonymous",
          anonymousLabel: "员工身份",
          name: snapshot.identity?.loginName ?? null,
          avatarUrl: snapshot.avatarUrl,
          planLabel: "员工身份",
          usageRemainingPercent: null,
          error: snapshot.phase === "error" ? "暂时无法确认员工身份，请重试" : null,
        });
      }
      return projected;
    },
    subscribe: controller.subscribe,
    refresh: () => controller.refresh(),
  };
}
