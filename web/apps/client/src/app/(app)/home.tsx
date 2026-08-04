import { Redirect, type Href } from "expo-router";
import { LoadingScreen, RouteStatusScreen } from "@/ui";
import { FirstWorkspaceScreen } from "../../features/onboarding/first-workspace-screen";
import {
  authRouteHref,
  serverRootHref,
} from "../../features/workspace/section-navigation";
import {
  useAppRuntime,
  useAppState,
} from "../../runtime/app-runtime";
import {browserHostname} from "../../runtime/browser-location";
import {currentBrowserHref} from "../../features/navigation/browser-navigation";

export default function HomeRoute() {
  const { store } = useAppRuntime();
  const authStatus = useAppState((state) => state.authStatus);
  const error = useAppState((state) => state.error);
  const provisioningStage = useAppState(
    (state) => state.provisioningStage,
  );
  const provisioningWorkspace = useAppState(
    (state) => state.provisioningWorkspace,
  );
  const servers = useAppState((state) => state.servers);
  const serversStatus = useAppState((state) => state.serversStatus);

  if (authStatus === "checking" || authStatus === "signing_in") {
    return <LoadingScreen />;
  }
  if (authStatus === "signed_out") {
    return (
      <Redirect
        href={authRouteHref("login", "/home", browserHostname()) as Href}
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
  if (serversStatus === "idle" || serversStatus === "loading") {
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
  if (servers[0]) {
    return (
      <Redirect
        href={currentBrowserHref(serverRootHref(servers[0].slug)) as Href}
      />
    );
  }
  return (
    <FirstWorkspaceScreen
      error={error}
      loading={provisioningWorkspace}
      onLogout={() => void store.getState().logout()}
      onSubmit={(input) => store.getState().createWorkspace(input)}
      stage={provisioningStage}
    />
  );
}
