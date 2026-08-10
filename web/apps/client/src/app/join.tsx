import {Redirect, useRouter, type Href} from "expo-router";
import {
  memberCanManageServer,
  selectCurrentHumanMember,
} from "@vela/client-core";
import {useEffect, useMemo, useState} from "react";

import {LoadingScreen, RouteStatusScreen} from "@/ui";
import {currentBrowserHref} from "../features/navigation/browser-navigation";
import {
  authRouteHref,
  serverSetupHref,
  workspaceSectionHref,
} from "../features/workspace/section-navigation";
import {useAppRuntime, useAppState} from "../runtime/app-runtime";
import {browserHostname} from "../runtime/browser-location";
import {SessionJoinIntentStore} from "../storage/session-join-intent-store";

type JoinStatus = "idle" | "processing" | "failed" | "missing";

export default function JoinRoute() {
  const router = useRouter();
  const {store} = useAppRuntime();
  const authStatus = useAppState((state) => state.authStatus);
  const error = useAppState((state) => state.error);
  const joinLinkErrorKind = useAppState((state) => state.joinLinkErrorKind);
  const [prepared, setPrepared] = useState(false);
  const [status, setStatus] = useState<JoinStatus>("idle");
  const intentStore = useMemo(createBrowserJoinIntentStore, []);

  useEffect(() => {
    if (!intentStore) {
      setStatus("missing");
      setPrepared(true);
      return;
    }
    const location = browserLocation();
    if (location?.hash) {
      intentStore.capture(location.hash);
      globalThis.history?.replaceState(
        {},
        "",
        `${location.pathname}${location.search}`,
      );
    }
    setPrepared(true);
  }, [intentStore]);

  useEffect(() => {
    if (
      !prepared ||
      authStatus !== "signed_in" ||
      status !== "idle" ||
      !intentStore
    ) {
      return;
    }
    const token = intentStore.load();
    if (!token) {
      setStatus("missing");
      return;
    }
    setStatus("processing");
    void store.getState().acceptJoinLink(token).then((joined) => {
      if (!joined) {
        if (store.getState().joinLinkErrorKind === "terminal") {
          intentStore.clear();
          setStatus("missing");
        } else {
          setStatus("failed");
        }
        return;
      }
      intentStore.clear();
      const state = store.getState();
      const currentMember = selectCurrentHumanMember(state.members, {
        accountId: state.account?.id,
        imUserId: state.account?.imUserId,
      });
      const needsAdministratorSetup =
        memberCanManageServer(currentMember) &&
        !state.agents.some((agent) => agent.observedState === "running");
      router.replace(
        currentBrowserHref(
          needsAdministratorSetup
            ? serverSetupHref(joined.serverSlug)
            : workspaceSectionHref(
                joined.serverSlug,
                "chat",
                joined.landingChannelId,
              ),
        ) as Href,
      );
    });
  }, [
    authStatus,
    intentStore,
    joinLinkErrorKind,
    prepared,
    router,
    status,
    store,
  ]);

  if (!prepared || authStatus === "checking" || authStatus === "signing_in") {
    return <LoadingScreen />;
  }
  if (authStatus === "signed_out") {
    return (
      <Redirect
        href={authRouteHref("login", "/join", browserHostname()) as Href}
      />
    );
  }
  if (status === "missing") {
    return (
      <RouteStatusScreen
        actionLabel="返回首页"
        description="加入链接不存在、格式错误或已超过 30 分钟。"
        onAction={() => router.replace("/")}
        title="加入链接无效"
      />
    );
  }
  if (status === "failed") {
    return (
      <RouteStatusScreen
        actionLabel="重试"
        description={error ?? "暂时无法加入 Server，请检查网络后重试。"}
        onAction={() => setStatus("idle")}
        title="暂时无法加入"
      />
    );
  }
  return <LoadingScreen />;
}

function createBrowserJoinIntentStore(): SessionJoinIntentStore | null {
  const storage = (
    globalThis as typeof globalThis & {sessionStorage?: Storage}
  ).sessionStorage;
  return storage ? new SessionJoinIntentStore(storage) : null;
}

function browserLocation():
  | {hash: string; pathname: string; search: string}
  | undefined {
  return (
    globalThis as typeof globalThis & {
      location?: {hash?: string; pathname?: string; search?: string};
    }
  ).location as
    | {hash: string; pathname: string; search: string}
    | undefined;
}
