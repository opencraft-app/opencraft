import type {Channel, Server} from "@raft-platform/client-core";
import {Redirect, type Href} from "expo-router";
import {RouteStatusScreen} from "@/ui";

import {currentBrowserHref} from "../navigation/browser-navigation";
import {RouteTitle} from "../navigation/route-title";
import {
  firstRoutableChannelId,
  workspaceSectionHref,
} from "./section-navigation";

export function ServerRoot({
  channels,
  server,
}: {
  channels: Channel[];
  server: Server;
}) {
  const channelId = firstRoutableChannelId(channels);
  if (channelId) {
    return (
      <>
        <RouteTitle title={`${server.name} · RAFT`} />
        <Redirect
          href={currentBrowserHref(
            workspaceSectionHref(server.slug, "chat", channelId),
          ) as Href}
        />
      </>
    );
  }
  return (
    <>
      <RouteTitle title={`${server.name} · RAFT`} />
      <RouteStatusScreen
        description="Server 已打开，频道仍在消息服务中准备。同步完成后重新打开此链接即可进入。"
        title="频道正在同步"
      />
    </>
  );
}
