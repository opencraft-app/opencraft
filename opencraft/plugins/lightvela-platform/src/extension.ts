import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import type { PlatformAccountContribution } from "@opencraft/extension-react";
import {
  AUTHENTICATION_PROVIDER_CHANNEL,
  ENVIRONMENT_SOURCE_CHANNEL,
  type AuthenticationProvider,
} from "@opencraft/workbench-runtime";

import {
  LightVelaAccountService,
  type LightVelaAccountServiceOptions,
} from "./account/lightvela-account-service";
import { createLightVelaAccountView } from "./account/lightvela-account-view";
import { createLightVelaSignInView } from "./account/lightvela-sign-in-view";
import { LightVelaEnvironmentSource } from "./environment-directory";
import { LightVelaEnvironmentService } from "./environments/lightvela-environment-service";
import { createLightVelaEnvironmentView } from "./environments/lightvela-environment-view";

export interface LightVelaPlatformExtensionOptions extends LightVelaAccountServiceOptions {
  /** Application-owned account shared by every first-party LightVela extension. */
  readonly account?: LightVelaAccountService;
}

export function createLightVelaPlatformExtension(
  options: LightVelaPlatformExtensionOptions = {},
): TrustedExtensionDefinition {
  const ownsAccount = options.account === undefined;
  const { account: injectedAccount, ...accountOptions } = options;
  const account = injectedAccount ?? new LightVelaAccountService(accountOptions);
  const AccountView = createLightVelaAccountView(account);
  const SignInView = createLightVelaSignInView(account);
  let environmentSource: LightVelaEnvironmentSource | null = null;
  const environments = new LightVelaEnvironmentService(account, {
    onInstanceReady: async (instanceId) => {
      const source = environmentSource;
      if (source === null) throw new Error("Environment source unavailable");
      await source.refresh();
      if (!source.getSnapshot().entries.some((entry) => (
        entry.profile.providerConfig as Record<string, unknown>
      ).instanceId === instanceId)) {
        throw new Error("Environment discovery pending");
      }
    },
  });
  const EnvironmentView = createLightVelaEnvironmentView(account, environments);
  return {
    manifest: {
      manifestVersion: 1,
      id: "lightvela.platform",
      name: "LightVela Platform",
      description: "Owns the shared LightVela account and authenticated platform transport.",
      version: "0.1.0",
      apiVersion: 1,
      trust: "trusted",
      platforms: ["web", "electron"],
      activationEvents: ["onStartupFinished"],
    },
    activate(api) {
      api.internal.register(AUTHENTICATION_PROVIDER_CHANNEL, {
        id: "lightvela.platform.account",
        getSession: () => account.getSnapshot().session,
        subscribe: account.subscribe,
        signIn: (optionId) => {
          if (optionId !== undefined) {
            if (optionId !== "cn" && optionId !== "intl") {
              throw new Error("Invalid sign-in option");
            }
            account.selectRegion(optionId);
          }
          return account.signIn();
        },
        cancelSignIn: () => account.cancelSignIn(),
      } satisfies AuthenticationProvider);
      api.views.register({
        id: "lightvela.platform.sign-in",
        title: "Sign in",
        viewType: "lightvela.platform.sign-in",
        platforms: ["web", "electron"],
      });
      api.internal.register("platformViewRenderer", {
        viewType: "lightvela.platform.sign-in",
        Component: SignInView,
      });
      environmentSource = new LightVelaEnvironmentSource(account);
      const source = environmentSource;
      api.subscriptions.add(() => {
        source.dispose();
        if (environmentSource === source) environmentSource = null;
      });
      api.internal.register(ENVIRONMENT_SOURCE_CHANNEL, source);
      api.subscriptions.add(() => environments.dispose());
      api.views.register({
        id: "lightvela.platform.environment-create",
        title: "添加环境",
        viewType: "lightvela.platform.environment-create",
        platforms: ["web", "electron"],
      });
      api.internal.register("platformViewRenderer", {
        viewType: "lightvela.platform.environment-create",
        Component: EnvironmentView,
      });
      const refreshAuthenticatedAccount = (): void => {
        if (!account.bootstrapOAuthFragment()) return;
        void account.refreshBots().catch(() => undefined);
        void account.refreshAccountDetails().catch(() => undefined);
      };
      refreshAuthenticatedAccount();
      if (account.hasStoredSession()) {
        void account.refreshBots().catch(() => undefined);
        void account.refreshAccountDetails().catch(() => undefined);
      } else {
        void account.restoreDesktopSession().then((restored) => {
          if (!restored) return;
          void account.refreshBots().catch(() => undefined);
          void account.refreshAccountDetails().catch(() => undefined);
        }).catch(() => undefined);
      }
      globalThis.addEventListener?.("hashchange", refreshAuthenticatedAccount);
      api.subscriptions.add(() => {
        globalThis.removeEventListener?.("hashchange", refreshAuthenticatedAccount);
      });
      api.views.register({
        id: "lightvela.platform.account-view",
        title: "Account Settings",
        viewType: "lightvela.platform.account",
        icon: "user",
        platforms: ["web", "electron"],
      });
      api.internal.register("platformViewRenderer", {
        viewType: "lightvela.platform.account",
        Component: AccountView,
      });
      let accountSourceRevision = -1;
      let environmentSourceRevision = -1;
      let contributionRevision = 0;
      let projected: ReturnType<PlatformAccountContribution["getSnapshot"]> | null = null;
      api.internal.register("platformAccount", {
        id: "lightvela.platform.account",
        viewId: "lightvela.platform.account-view",
        authenticationProviderId: "lightvela.platform.account",
        signInViewId: "lightvela.platform.sign-in",
        signInOptions: [
          { id: "cn", label: "国内账号登录", description: "lightvela.com" },
          { id: "intl", label: "国际账号登录", description: "lightvela.ai" },
        ],
        environmentCreation: {
          label: "添加环境",
          viewId: "lightvela.platform.environment-create",
        },
        getSnapshot: () => {
          const snapshot = account.getSnapshot();
          const environment = environments.getSnapshot();
          if (
            snapshot.revision === accountSourceRevision &&
            environment.revision === environmentSourceRevision &&
            projected !== null
          ) return projected;
          const details = snapshot.details;
          const total = details.pass?.creditsTotal ?? 0;
          const available = details.pass?.creditsAvailable ?? 0;
          accountSourceRevision = snapshot.revision;
          environmentSourceRevision = environment.revision;
          projected = Object.freeze({
            revision: ++contributionRevision,
            environmentRequests: environment.request && environment.phase !== "complete" ? [{
              id: environment.request.hostId,
              name: environment.request.name,
              status: environment.phase === "submitting"
                ? "正在提交…"
                : environment.phase === "creating"
                  ? "正在创建…"
                  : "需要检查状态",
            }] : [],
            phase: snapshot.session.status,
            name: details.profile?.pendingName || details.profile?.name || null,
            avatarUrl: details.profile?.avatarUrl ?? null,
            planLabel: details.pass?.bundleName || details.subscription?.code || null,
            usageRemainingPercent: total > 0
              ? Math.max(0, Math.min(100, Math.round((available / total) * 100)))
              : null,
            error: details.error ?? snapshot.error,
            applicationIntervention: null,
          });
          return projected;
        },
        subscribe: (listener) => {
          const accountSubscription = account.subscribe(listener);
          const environmentSubscription = environments.subscribe(listener);
          return () => {
            accountSubscription();
            environmentSubscription();
          };
        },
        refresh: () => account.refreshAccountDetails(),
        signOut: () => account.signOut(),
      } satisfies PlatformAccountContribution);
      if (ownsAccount) api.subscriptions.add(() => account.dispose());
    },
  };
}
