import { useEffect, useState } from "react";
import {
  SettingsActions,
  SettingsButton,
  SettingsGroup,
  SettingsListItem,
  SettingsNotice,
} from "@opencraft/extension-react";
import { ImClient } from "./client";
import "./sources.scss";
export function ImSources({
  fetcher,
  hostId,
  threadId,
  onOpenSettings,
  reportError,
}: {
  fetcher: typeof fetch;
  hostId: string;
  threadId: string;
  onOpenSettings(): void;
  reportError(message: string): void;
}) {
  const [sources, setSources] = useState<
      | {
          channelId: string;
          name: string;
          provider: string;
          source: {
            chatId: string;
            chatType?: string;
            threadId?: string;
            senderId: string;
          };
          revision: number;
          lastSeen: number;
        }[]
      | null
    >(null),
    [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  const [reference, setReference] = useState("");
  useEffect(() => {
    let active = true;
    setFailed(false);
    setSources(null);
    setReference("");
    void new ImClient(fetcher)
      .request<{
        sources: NonNullable<typeof sources>;
        reference: string;
      }>({ action: "sources", hostId, threadId })
      .then(
        (value) => {
          if (active) {
            setSources(value.sources);
            setReference(value.reference);
          }
        },
        () => {
          if (active) setFailed(true);
        },
      );
    return () => {
      active = false;
    };
  }, [fetcher, hostId, threadId, retry]);
  return (
    <div className="im-sources">
      <p className="im-sources__intro">来自聊天工具的消息，可以在这个会话中处理。</p>
      <div className="im-sources__records" aria-live="polite" aria-busy={sources === null && !failed}>
        {failed ? (
          <SettingsNotice>
            暂时无法读取聊天来源，请重试。
            <SettingsButton onClick={() => setRetry((v) => v + 1)}>
              重试
            </SettingsButton>
          </SettingsNotice>
        ) : sources === null ? (
          <SettingsNotice>正在读取来源…</SettingsNotice>
        ) : (
          <SettingsGroup appearance="plain">
            {sources.length ? (
              sources.map((s) => (
                <SettingsListItem
                  key={JSON.stringify([s.channelId, s.source.chatId, s.source.threadId, s.source.senderId])}
                  label={`${s.source.chatType === "direct" ? "私聊" : s.source.chatType === "group" ? "群聊" : "聊天"} · ${s.source.chatId}`}
                  description={`${s.provider === "wecom" ? "企业微信" : s.provider === "slack" ? "Slack" : s.provider} · ${s.name}`}
                  metadata={
                    ["最近收到于 " + new Date(s.lastSeen).toLocaleString(document.documentElement.lang || undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }),
                      s.source.threadId && "话题 " + s.source.threadId,
                      s.source.chatType === "group" && "发言人 " + s.source.senderId]
                      .filter(Boolean).join(" · ") || undefined
                  }
                  actions={
                    <SettingsButton onClick={onOpenSettings}>
                      渠道设置
                    </SettingsButton>
                  }
                />
              ))
            ) : (
              <SettingsNotice className="im-sources__empty">
                <strong>暂无近期聊天来源</strong>
                <p>收到企业微信、Slack 等消息后，会在这里显示对应的聊天。</p>
              </SettingsNotice>
            )}
          </SettingsGroup>
        )}
      </div>
      <SettingsActions>
        <SettingsButton variant="primary" onClick={onOpenSettings}>
          接入聊天
        </SettingsButton>
      </SettingsActions>
      <p className="im-sources__help">
        回复会发回收到这条消息的聊天。<br />
        多个聊天接入这里时，会共用本会话的历史记录。
      </p>
      <details className="im-sources__advanced">
        <summary className="ui-native-disclosure">自定义路由</summary>
        <p>复制此会话引用，在渠道的路由函数中使用。</p>
        {reference ? <pre>{reference}</pre> : <p>读取来源后可获取会话引用。</p>}
        <SettingsActions>
          <SettingsButton
            disabled={!reference}
            onClick={() =>
              void navigator.clipboard
                .writeText(reference)
                .catch(() => reportError("暂时无法复制，请手动选择会话引用。"))
            }
          >
            复制会话引用
          </SettingsButton>
        </SettingsActions>
      </details>
    </div>
  );
}
