import {Redirect, useRouter, type Href} from "expo-router";
import {
  memberCanManageServer,
  selectCurrentHumanMember,
  type JoinResult,
} from "@vela/client-core";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";

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

type JoinStatus =
  | "accepted_chat_unavailable"
  | "failed"
  | "idle"
  | "missing"
  | "processing"
  | "waiting_identity";

const identityRetryDelaysMs = [500, 1_000, 2_000] as const;
const identityRetryWindowMs = 30_000;

export default function JoinRoute() {
  const router = useRouter();
  const {store} = useAppRuntime();
  const authStatus = useAppState((state) => state.authStatus);
  const error = useAppState((state) => state.error);
  const [prepared, setPrepared] = useState(false);
  const [status, setStatus] = useState<JoinStatus>("idle");
  const [acceptedJoin, setAcceptedJoin] = useState<JoinResult | null>(null);
  const [retryWindow, setRetryWindow] = useState(0);
  const retryGeneration = useRef(0);
  const intentStore = useMemo(createBrowserJoinIntentStore, []);
  const navigateToJoined = useCallback((joined: JoinResult) => {
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
  }, [router, store]);

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
      !intentStore
    ) {
      return;
    }
    const token = intentStore.load();
    if (!token) {
      setStatus("missing");
      return;
    }
    const generation = ++retryGeneration.current;
    const startedAt = Date.now();
    let retryIndex = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const current = () => retryGeneration.current === generation;
    const wait = (delay: number) =>
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, delay);
      });

    void (async () => {
      while (current()) {
        setStatus("processing");
        const joined = await store.getState().acceptJoinLink(token);
        if (!current()) return;
        if (joined) {
          intentStore.clear();
          if (store.getState().imState.status !== "ready") {
            setAcceptedJoin(joined);
            setStatus("accepted_chat_unavailable");
            return;
          }
          navigateToJoined(joined);
          return;
        }
        const errorKind = store.getState().joinLinkErrorKind;
        if (errorKind === "terminal") {
          intentStore.clear();
          setStatus("missing");
          return;
        }
        if (
          errorKind !== "identity_pending" ||
          Date.now() - startedAt >= identityRetryWindowMs
        ) {
          setStatus("failed");
          return;
        }
        setStatus("waiting_identity");
        await wait(
          identityRetryDelaysMs[
            Math.min(retryIndex, identityRetryDelaysMs.length - 1)
          ]!,
        );
        timer = null;
        retryIndex += 1;
      }
    })();

    return () => {
      if (retryGeneration.current === generation) {
        retryGeneration.current += 1;
      }
      if (timer) clearTimeout(timer);
    };
  }, [
    authStatus,
    intentStore,
    navigateToJoined,
    prepared,
    retryWindow,
    router,
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
        onAction={() => {
          setStatus("idle");
          setRetryWindow((value) => value + 1);
        }}
        title="暂时无法加入"
      />
    );
  }
  if (status === "accepted_chat_unavailable" && acceptedJoin) {
    return (
      <RouteStatusScreen
        actionLabel="重新连接聊天"
        description={error ?? "你已成功加入协作空间，可以重新连接聊天后继续。"}
        onAction={() => {
          const generation = retryGeneration.current;
          setStatus("processing");
          void store.getState().reconnectIm().then(async () => {
            if (retryGeneration.current !== generation) return;
            if (store.getState().imState.status !== "ready") {
              setStatus("accepted_chat_unavailable");
              return;
            }
            await store.getState().selectChannel(acceptedJoin.landingChannelId);
            if (retryGeneration.current !== generation) return;
            navigateToJoined(acceptedJoin);
          }).catch(() => {
            if (retryGeneration.current === generation) {
              setStatus("accepted_chat_unavailable");
            }
          });
        }}
        title="已加入协作空间，但聊天尚未连接"
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
