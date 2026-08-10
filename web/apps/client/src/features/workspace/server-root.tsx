import type {Channel, Server} from "@vela/client-core";
import {Redirect, type Href} from "expo-router";
import {RouteStatusScreen} from "@/ui";

import {currentBrowserHref} from "../navigation/browser-navigation";
import {RouteTitle} from "../navigation/route-title";
import {
  firstRoutableChannelId,
  workspaceSectionHref,
} from "./section-navigation";

/**
 * Server index content under the shared WorkspaceChrome. Status / redirect
 * fill the stage slot; the rail and bottom bar stay mounted from the layout.
 */
export function ServerRoot({
  channels,
  onRetry,
  server,
}: {
  channels: Channel[];
  onRetry: () => void;
  server: Server;
}) {
  const channelId = firstRoutableChannelId(channels);
  if (channelId) {
    return (
      <>
        <RouteTitle title={`${server.name} · VELA`} />
        <Redirect
          href={currentBrowserHref(
            workspaceSectionHref(server.slug, "chat", channelId),
          ) as Href}
        />
      </>
    );
  }
  const provisioning = channels.some(
    (channel) => channel.joined && channel.imState === "provisioning",
  );
  const failed = channels.some(
    (channel) => channel.joined && channel.imState === "error",
  );
  const title = provisioning
    ? "频道正在同步"
    : failed
      ? "频道同步失败"
      : "暂无可用频道";
  const description = provisioning
    ? "Server 已打开，频道仍在消息服务中准备。可以重新检查就绪状态。"
    : failed
      ? "消息服务未能完成频道准备。请重新检查；如果仍然失败，请联系管理员。"
      : "当前没有已加入且可用的频道。可以重新检查 Server 的频道状态。";
  return (
    <>
      <RouteTitle title={`${server.name} · VELA`} />
      <RouteStatusScreen
        actionLabel="重新检查"
        description={description}
        onAction={onRetry}
        title={title}
      />
    </>
  );
}
