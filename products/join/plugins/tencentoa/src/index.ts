import { registerMobileGuide } from './mobile-guide-browser';
import { employeePhotoUrl } from "./photo";
import { THREAD_LIST_GROUPING_CHANNEL, THREAD_BADGE_CHANNEL, THREAD_PARTICIPATION_CHANNEL, IDENTITY_AVATAR_CHANNEL, type IdentityAvatarContribution } from "@opencraft/extension-react";
import type { ParticipantsClient } from "./participants-controller";
import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import { AUTHENTICATION_PROVIDER_CHANNEL, type AuthenticationProvider } from "@opencraft/workbench-runtime";
import { TENCENTOA_PROVIDER_ID } from "./contract";
import { TencentOaController } from "./controller";
import { createTencentOaAccountContribution } from "./account";
import { createDeferredView } from '@opencraft/extension-react';

export { TencentOaController } from "./controller";
export type { TencentOaSnapshot } from "./controller";
export type { TencentOaIdentity } from "./contract";
export { createTencentOaAccountContribution } from "./account";

export function createTencentOaExtension(controller = new TencentOaController(), options?: { getClient(hostId: string): ParticipantsClient | undefined; fetcher?: typeof fetch; required?: boolean }): TrustedExtensionDefinition {
  return {
    manifest: { manifestVersion: 1, id: "tencentoa.identity", name: "Tencent OA", description: "Recognizes the current employee through the site's TAI authentication.",
      version: "0.1.0", apiVersion: 1, trust: "trusted", platforms: ["web"], activationEvents: ["onStartupFinished"] },
    async activate(api) {
      api.subscriptions.add(() => controller.dispose());
      if (options?.required) {
        // Join retains its employee entrance while the server is being verified.
        void controller.refresh();
      } else {
        await controller.refresh();
        if (api.signal.aborted) return;
        if (controller.getSnapshot().phase === "error") throw new Error("Employee identity service unavailable");
        if (controller.getSnapshot().available !== true) return;
      }
      api.internal.register(AUTHENTICATION_PROVIDER_CHANNEL, {
        id: TENCENTOA_PROVIDER_ID, getSession: controller.getSession, subscribe: controller.subscribe,
        signIn: () => controller.signIn(), cancelSignIn: controller.cancelSignIn,
      } satisfies AuthenticationProvider);
      api.views.register({ id: "tencentoa.identity.employee-view", title: "开发者选项", titleMessage: { id: "ioa.identity.developerOptions", defaultMessage: "Developer options" }, viewType: "tencentoa.identity.employee", platforms: ["web"] });
      api.settings.registerPage({ id: "tencentoa.identity.employee", title: "Developer options", titleMessage: { id: "ioa.identity.developerOptions", defaultMessage: "Developer options" }, viewId: "tencentoa.identity.employee-view", group: "General", groupMessage: { id: "settings.groups.general", defaultMessage: "General" }, icon: "terminal", platforms: ["web"], order: 45 });
      api.internal.register("platformViewRenderer", { viewType: "tencentoa.identity.employee", Component: createDeferredView(async () => (await import('./view')).createEmployeeIdentityView(controller)) });
      if (options?.fetcher) {
        api.views.register({ id: 'tencentoa.identity.assets', title: 'Assets', titleMessage: { id: 'assets.title', defaultMessage: 'Assets' }, viewType: 'tencentoa.identity.assets', platforms: ['web'], keepConversationSidebar: true });
        api.views.register({ id: 'tencentoa.identity.assets.entry', title: 'Assets', viewType: 'tencentoa.identity.assets.entry', platforms: ['web'] });
        api.sidebar.registerCatalog({ id: 'tencentoa.identity.assets.catalog', title: 'Assets', titleMessage: { id: 'assets.title', defaultMessage: 'Assets' }, viewId: 'tencentoa.identity.assets.entry', presentation: 'entry', order: 36 });
        api.internal.register('platformViewRenderer', { viewType: 'tencentoa.identity.assets.entry', Component: createDeferredView(async () => (await import('../../../assets/entry')).AssetsEntry) });
        api.internal.register('platformViewRenderer', { viewType: 'tencentoa.identity.assets', Component: createDeferredView(async () => (await import('../../../assets/view')).createAssetsView(controller, options.fetcher!)) });
      }
      if (options?.fetcher) {
        api.views.register({ id: 'tencentoa.identity.environment.view', title: 'Personal credentials ENV', viewType: 'tencentoa.identity.environment', platforms: ['web'] });
        // Preserve old view IDs without a second Settings destination or redirect.
        api.internal.register('platformViewRenderer', { viewType: 'tencentoa.identity.environment', Component: createDeferredView(async () =>
          (await import('../../../assets/view')).createAssetsView(controller, options.fetcher!, true)) });
      }
      if (options?.fetcher) {
        const { EmployeeAdmissionController } = await import('./admission-controller');
        const admission = new EmployeeAdmissionController(options.fetcher);
        api.subscriptions.add(() => admission.dispose());
        api.views.register({ id: 'tencentoa.identity.access.view', title: 'Access policy', viewType: 'tencentoa.identity.access', platforms: ['web'] });
        api.settings.registerPage({ id: 'tencentoa.identity.access', title: 'Access policy', titleMessage: { id: 'ioa.access.policy', defaultMessage: 'Access policy' }, viewId: 'tencentoa.identity.access.view', placement: 'extension', platforms: ['web'] });
        api.internal.register('platformViewRenderer', { viewType: 'tencentoa.identity.access', Component: createDeferredView(async () => (await import('./admission-settings')).createEmployeeAdmissionSettings(admission)) });
      }
      api.internal.register("platformAccount", createTencentOaAccountContribution(controller, options?.fetcher));
      api.internal.register(IDENTITY_AVATAR_CHANNEL, { id: "tencentoa.identity.photos",
        resolve: (kind, name) => (kind === "employee" || kind === "human") ? employeePhotoUrl(name) : null,
      } satisfies IdentityAvatarContribution);
      if (options) {
        const [{ createParticipantsBadge }, { TencentOaParticipantsController }, { TencentOaCreatorGrouping }, { createParticipationOverview }] = await Promise.all([
          import("./participants-view"), import("./participants-controller"),
          import("./creator-grouping"), import("./participation-overview"),
        ]);
        if (api.signal.aborted) return;
        const participants = new TencentOaParticipantsController(options.getClient);
        api.subscriptions.add(() => { participants.dispose(); });
        const accountKey = () => { const value = controller.getSnapshot().displayIdentity; return value ? JSON.stringify([value.staffId, value.loginName]) : null; };
        api.internal.register(THREAD_PARTICIPATION_CHANNEL, createParticipationOverview(options.getClient, accountKey));
        let account = accountKey();
        api.subscriptions.add(controller.subscribe(() => {
          const next = accountKey();
          if (next !== account) { account = next; participants.clear(); }
        }));
        api.internal.register(THREAD_BADGE_CHANNEL, createParticipantsBadge(participants));
        const grouping = new TencentOaCreatorGrouping(controller, participants, api.localPreferences ?? null);
        api.subscriptions.add(() => grouping.dispose());
        api.internal.register(THREAD_LIST_GROUPING_CHANNEL, grouping);
      }
      registerMobileGuide(api, controller);
      const onVisible = () => { if (document.visibilityState === "visible") void controller.refreshIfNeeded(); };
      const onOnline = () => { void controller.refresh(); };
      document.addEventListener("visibilitychange", onVisible);
      globalThis.addEventListener?.("online", onOnline);
      api.subscriptions.add(() => {
        document.removeEventListener("visibilitychange", onVisible);
        globalThis.removeEventListener?.("online", onOnline);
      });
    },
  };
}
