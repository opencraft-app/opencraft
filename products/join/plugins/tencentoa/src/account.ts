import { createTencentOaModelDefaults } from "./model-defaults";
import { createTencentOaReadReceipts } from "./read-receipts";
import type { PlatformAccountContribution, PlatformAccountSnapshot } from "@opencraft/extension-react";
import type { TencentOaController, TencentOaSnapshot } from "./controller";

/** Per-client account presentation; retained display metadata grants no authentication. */
export function createTencentOaAccountContribution(controller: TencentOaController, fetcher?: typeof fetch): PlatformAccountContribution {
  let previous: TencentOaSnapshot | null = null;
  let projected: PlatformAccountSnapshot;
  return {
    id: "tencentoa.identity.employee",
    readReceipts: createTencentOaReadReceipts(fetcher),
    modelDefaults: createTencentOaModelDefaults(fetcher),
    viewId: "tencentoa.identity.employee-view",
    entrancePriority: 100,
    getSnapshot: () => {
      const snapshot = controller.getSnapshot();
      if (snapshot !== previous) {
        previous = snapshot;
        projected = Object.freeze({
          revision: snapshot.revision,
          identity: snapshot.identity ? { id: snapshot.identity.staffId, handle: snapshot.identity.loginName } : null,
          submissionSender: snapshot.identity ? { kind: "employee" as const, loginName: snapshot.identity.loginName } : null,
          readStateScope: snapshot.identity ? `tencentoa:${snapshot.identity.staffId}` : null,
          phase: snapshot.identity ? "authenticated" : snapshot.phase === "error" || snapshot.available === false ? "error" : snapshot.displayIdentity || snapshot.phase === "loading" ? "loading" : "anonymous",
          anonymousLabel: "员工身份",
          anonymousLabelMessage: { id: "ioa.identity.title", defaultMessage: "Employee identity" },
          name: snapshot.displayIdentity?.loginName ?? null,
          avatarUrl: snapshot.avatarUrl,
          planLabel: "员工身份",
          usageRemainingPercent: null,
          error: snapshot.phase === "error" || snapshot.available === false ? "暂时无法确认员工身份，请重试" : null,
        });
      }
      return projected;
    },
    subscribe: controller.subscribe,
    refresh: () => controller.refresh(),
  };
}
