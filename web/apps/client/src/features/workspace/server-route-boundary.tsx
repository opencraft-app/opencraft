import type {Server} from "@vela/client-core";
import {Redirect, useRouter, type Href} from "expo-router";
import {useEffect, useRef, type ReactNode} from "react";
import {LoadingScreen, RouteStatusScreen} from "@/ui";

import {useAppRuntime, useAppState} from "../../runtime/app-runtime";
import {browserHostname} from "../../runtime/browser-location";
import {currentBrowserHref} from "../navigation/browser-navigation";
import {
  authRouteHref,
  resolveServerRouteReference,
} from "./section-navigation";

export function ServerRouteBoundary({
  canonicalHref,
  children,
  serverReference,
}: {
  canonicalHref: (serverSlug: string) => string;
  children: (server: Server) => ReactNode;
  serverReference: string | undefined;
}) {
  const router = useRouter();
  const {store} = useAppRuntime();
  const authStatus = useAppState(state => state.authStatus);
  const currentServerId = useAppState(state => state.currentServerId);
  const error = useAppState(state => state.error);
  const serverContextStatus = useAppState(state => state.serverContextStatus);
  const servers = useAppState(state => state.servers);
  const serversStatus = useAppState(state => state.serversStatus);
  const targetServerId = useAppState(state => state.targetServerId);
  const canonicalizedHref = useRef<string | null>(null);
  const resolution = serverReference
    ? resolveServerRouteReference(servers, serverReference)
    : {status: "unavailable" as const};

  useEffect(() => {
    if (
      authStatus !== "signed_in" ||
      serversStatus !== "ready" ||
      resolution.status !== "ready"
    ) {
      return;
    }

    if (resolution.legacyReference) {
      const href = currentBrowserHref(
        canonicalHref(resolution.canonicalSlug),
      );
      if (canonicalizedHref.current !== href) {
        canonicalizedHref.current = href;
        router.replace(href as Href);
      }
    }

    if (
      currentServerId === resolution.server.id &&
      serverContextStatus === "ready"
    ) {
      return;
    }
    if (
      targetServerId === resolution.server.id &&
      (serverContextStatus === "loading" ||
        serverContextStatus === "error")
    ) {
      return;
    }
    void store.getState().selectServer(resolution.server.id);
  }, [
    canonicalHref,
    resolution,
    router,
    authStatus,
    currentServerId,
    serverContextStatus,
    serversStatus,
    targetServerId,
    store,
  ]);

  if (
    authStatus === "checking" ||
    authStatus === "signing_in"
  ) {
    return <LoadingScreen />;
  }
  if (authStatus === "signed_out") {
    const returnTo = currentBrowserHref(
      serverReference ? canonicalHref(serverReference) : "/home",
    );
    return (
      <Redirect
        href={authRouteHref("login", returnTo, browserHostname()) as Href}
      />
    );
  }
  if (authStatus === "recovery_error") {
    return (
      <RouteStatusScreen
        actionLabel="重新连接"
        description={error ?? "无法恢复登录状态，请检查网络后重试。"}
        onAction={() => void store.getState().retryInitialization()}
        title="连接平台失败"
      />
    );
  }
  if (
    serversStatus === "idle" ||
    serversStatus === "loading"
  ) {
    return <LoadingScreen />;
  }
  if (serversStatus === "error") {
    return (
      <RouteStatusScreen
        actionLabel="重新加载 Server 列表"
        description={error ?? "Server 列表暂时无法加载。"}
        onAction={() => void store.getState().retryServers()}
        title="无法加载 Server"
      />
    );
  }
  if (resolution.status === "unavailable") {
    return (
      <RouteStatusScreen
        description="这个 Server 不存在，或你当前没有访问权限。链接会保留，方便确认后重试。"
        title="Server 不可用"
      />
    );
  }
  if (
    targetServerId === resolution.server.id &&
    serverContextStatus === "error"
  ) {
    return (
      <RouteStatusScreen
        actionLabel="重新加载 Server"
        description={error ?? "Server 内容暂时无法加载。"}
        onAction={() => void store.getState().selectServer(resolution.server.id)}
        title="Server 加载失败"
      />
    );
  }
  if (
    currentServerId !== resolution.server.id ||
    serverContextStatus !== "ready"
  ) {
    return <LoadingScreen />;
  }
  return <>{children(resolution.server)}</>;
}
