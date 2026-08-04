import { Redirect, useRouter, type Href } from "expo-router";
import { useEffect } from "react";
import {useShallow} from "zustand/react/shallow";
import { LoadingScreen, RouteStatusScreen } from "@/ui";

import { mentionableAgents } from "../../application/app-store";
import {selectConversationScreenState} from "../../application/app-selectors";
import {
  pickFileAttachment,
  pickImageAttachment,
} from "../chat/attachment-picker";
import {
  activeConversationMatches,
  authRouteHref,
  directConversationHref,
  newDirectConversationHref,
  serverRootHref,
  type ConversationRouteTarget,
  workspaceSectionHref,
} from "./section-navigation";
import { WorkspaceShell } from "./workspace-shell";
import { useAppRuntime, useAppState } from "../../runtime/app-runtime";
import { browserHostname } from "../../runtime/browser-location";
import { currentBrowserHref } from "../navigation/browser-navigation";
import { RouteTitle } from "../navigation/route-title";

export function WorkspaceConversationScreen({
  serverSlug,
  target,
}: {
  serverSlug?: string;
  target: ConversationRouteTarget;
}) {
  const router = useRouter();
  const { store } = useAppRuntime();
  const state = useAppState(useShallow(selectConversationScreenState));
  const targetChannelId =
    target.kind === "channel" ? target.channelId : undefined;
  const targetDirectConversation =
    target.kind === "direct"
      ? state.directConversations.find(
          (conversation) =>
            conversation.directConversationId === target.directConversationId,
        )
      : undefined;
  const targetDirectMember =
    target.kind === "direct_new"
      ? state.members.find((member) => member.id === target.peerMemberId)
      : targetDirectConversation
        ? state.members.find(
            (member) => member.id === targetDirectConversation.peerMemberId,
          )
        : undefined;
  const targetPeerUserId =
    targetDirectConversation?.peerUserId ?? targetDirectMember?.imUserId ?? undefined;
  const targetServerId =
    target.kind === "channel" ? target.serverId : undefined;
  const targetIdentity =
    target.kind === "channel"
      ? target.channelId
      : target.kind === "direct"
        ? target.directConversationId
        : target.peerMemberId;
  const activeServerSlug =
    serverSlug ??
    state.servers.find((server) => server.id === state.currentServerId)?.slug;

  useEffect(() => {
    if (state.authStatus !== "signed_in") return;
    let cancelled = false;
    void (async () => {
      if (targetServerId) {
        const active = store.getState().activeConversation;
        if (
          !cancelled &&
          targetChannelId &&
          (active?.kind !== "channel" || active.channelId !== targetChannelId)
        ) {
          await store.getState().selectChannel(targetChannelId);
        }
      } else {
        if (
          store.getState().currentServerId &&
          target.kind === "direct_new" &&
          store.getState().members.length === 0
        ) {
          await store.getState().refreshOrganization();
        }
        const latest = store.getState();
        const conversation =
          target.kind === "direct"
            ? latest.directConversations.find(
                (item) =>
                  item.directConversationId === target.directConversationId,
              )
            : undefined;
        const member =
          target.kind === "direct_new"
            ? latest.members.find((item) => item.id === target.peerMemberId)
            : conversation
              ? latest.members.find((item) => item.id === conversation.peerMemberId)
              : undefined;
        const peerUserId = conversation?.peerUserId ?? member?.imUserId;
        if (!peerUserId) return;
        const active = store.getState().activeConversation;
        if (
          !cancelled &&
          (active?.kind !== "direct" ||
            active.peerMemberId !== (conversation?.peerMemberId ?? member?.id))
        ) {
          await store.getState().selectDirectConversation(peerUserId);
        }
      }
      if (!cancelled && store.getState().currentServerId) {
        await store.getState().refreshOrganization();
      }
    })();
    return () => {
      cancelled = true;
      store.getState().cancelOperationPolling();
    };
  }, [
    state.authStatus,
    state.currentServerId,
    state.members.length,
    store,
    targetChannelId,
    targetPeerUserId,
    targetServerId,
    target.kind,
    targetIdentity,
  ]);

  useEffect(() => {
    if (!targetChannelId && !targetServerId) return;
    for (const item of Object.values(state.operationsById)) {
      if (
        (item.resourceId === targetChannelId ||
          item.resourceId === targetServerId) &&
        item.pollingState === "idle"
      ) {
        void store.getState().continueOperationPolling(item.operation.id);
      }
    }
  }, [state.operationsById, store, targetChannelId, targetServerId]);

  if (state.authStatus === "checking") return <LoadingScreen />;
  if (state.authStatus === "signed_out") {
    const returnTo = currentBrowserHref(
      target.kind === "direct"
        ? directConversationHref(target.directConversationId, serverSlug ?? "")
        : target.kind === "direct_new"
          ? newDirectConversationHref(target.peerMemberId, serverSlug ?? "")
        : workspaceSectionHref(
            serverSlug ?? target.serverId,
            "chat",
            target.channelId,
          ),
    );
    return (
      <Redirect
        href={authRouteHref("login", returnTo, browserHostname()) as Href}
      />
    );
  }
  if (
    target.kind === "channel" &&
    state.currentServerId === target.serverId &&
    !state.channels.some((channel) => channel.id === target.channelId)
  ) {
    return (
      <RouteStatusScreen
        description="这个 Channel 不存在，或你当前没有访问权限。链接会保留，不会被自动改到其他频道。"
        title="Channel 不可用"
      />
    );
  }
  if (
    target.kind === "direct" &&
    state.directConversationSync === "complete" &&
    !state.directConversations.some(
      (conversation) =>
        conversation.directConversationId === target.directConversationId,
    )
  ) {
    return (
      <RouteStatusScreen
        description="这条私信尚未出现在会话列表中。请先进入一个 Server，从成员列表发起私信。"
        title="私信暂不可用"
      />
    );
  }
  if (
    target.kind === "direct_new" &&
    state.serverContextStatus === "ready" &&
    !state.members.some(
      (member) =>
        member.id === target.peerMemberId &&
        member.status === "active" &&
        member.imState === "ready",
    )
  ) {
    return (
      <RouteStatusScreen
        description="这个成员不存在、已离开 Server，或 IM 身份尚未就绪。"
        title="无法发起私信"
      />
    );
  }
  if (!activeConversationMatches(state.activeConversation, target)) {
    return <LoadingScreen />;
  }
  const currentMember = state.members.find(
    (member) =>
      member.kind === "human" && member.accountId === state.account?.id,
  );
  const canManageChannels =
    currentMember?.role === "owner" || currentMember?.role === "admin";
  const currentChannel =
    target.kind === "channel"
      ? state.channels.find((channel) => channel.id === target.channelId)
      : undefined;
  const directName =
    target.kind !== "channel"
      ? (targetDirectConversation?.peerDisplayName ??
        targetDirectMember?.displayName ??
        targetPeerUserId ??
        "私信")
      : undefined;

  return (
    <>
      <RouteTitle
        title={
          currentChannel
            ? `# ${currentChannel.name} · ${activeServerSlug ?? "RAFT"}`
            : directName
              ? `@ ${directName} · ${activeServerSlug ?? "RAFT"}`
              : "RAFT"
        }
      />
      <WorkspaceShell
        account={state.account}
        activeConversation={state.activeConversation}
        activeSection="chat"
        activeThread={state.activeThread}
        agents={mentionableAgents(state)}
        canManageChannels={canManageChannels}
        channelHref={(channel) =>
          activeServerSlug
            ? workspaceSectionHref(activeServerSlug, "chat", channel.id)
            : "/home"
        }
        channelMembers={state.channelMembers}
        channels={state.channels}
        conversationSummaries={state.conversationSummaries}
        currentChannelId={state.currentChannelId}
        {...(state.account?.imUserId
          ? { currentImUserId: state.account.imUserId }
          : {})}
        currentServerId={state.currentServerId}
        directConversations={state.directConversations}
        directHref={(peerUserId) => {
          if (!activeServerSlug) return "/home";
          const conversation = state.directConversations.find(
            (item) => item.peerUserId === peerUserId,
          );
          if (conversation) {
            return directConversationHref(
              conversation.directConversationId,
              activeServerSlug,
            );
          }
          const member = state.members.find(
            (item) => item.imUserId === peerUserId,
          );
          return member
            ? newDirectConversationHref(member.id, activeServerSlug)
            : "/home";
        }}
        directConversationSync={state.directConversationSync}
        error={state.error}
        historyCompleted={state.historyCompleted}
        initializingMessages={state.loadingChannel}
        imStatus={state.imState.status}
        imStatusMessage={state.imState.message}
        loadingOlder={state.loadingOlderMessages}
        locatingSearchResultId={state.locatingSearchResultId}
        members={state.members}
        messageFocusRequest={state.messageFocusRequest}
        messages={state.messages}
        onAddChannelMember={(memberId) =>
          store.getState().addChannelMember(memberId)
        }
        onAttachFile={async () => {
          const source = await pickFileAttachment();
          if (source) {
            await store.getState().sendAttachment({
              kind: "file",
              source,
            });
          }
        }}
        onAttachImage={async () => {
          const source = await pickImageAttachment();
          if (source) {
            await store.getState().sendAttachment({
              kind: "image",
              source,
            });
          }
        }}
        onClearQuote={() => store.getState().clearQuote()}
        onCloseThread={() => store.getState().closeThread()}
        onCreateTaskFromMessage={(messageId) =>
          store.getState().createTaskFromMessage(messageId)
        }
        onCreateChannel={async (input) => {
          const result = await store.getState().createChannel(input);
          const nextServerId = store.getState().currentServerId;
          const nextChannelId = store.getState().currentChannelId;
          if (result && nextServerId && nextChannelId) {
            const nextServerSlug =
              store
                .getState()
                .servers.find((server) => server.id === nextServerId)?.slug ??
              serverSlug ??
              nextServerId;
            router.push(
              currentBrowserHref(
                workspaceSectionHref(nextServerSlug, "chat", nextChannelId),
              ) as Href,
            );
          }
          return result;
        }}
        onContinueOperation={(operationId) =>
          store.getState().continueOperationPolling(operationId)
        }
        onLoadMoreSearchResults={() => store.getState().loadMoreSearchResults()}
        onLocateSearchResult={(messageId) =>
          store.getState().locateSearchResult(messageId)
        }
        onLoadMoreThreadReplies={() => store.getState().loadMoreThreadReplies()}
        onLoadOlder={() => store.getState().loadOlderMessages()}
        onLogout={() => store.getState().logout()}
        onNavigateSection={(section) => {
          const serverReference =
            serverSlug ?? store.getState().currentServerId;
          if (!serverReference) return;
          router.push(
            currentBrowserHref(
              workspaceSectionHref(
                serverReference,
                section,
                store.getState().currentChannelId,
              ),
            ) as Href,
          );
        }}
        onOpenChannelManagement={() => store.getState().refreshOrganization()}
        onOpenThread={(messageId) => store.getState().openThread(messageId)}
        onQuoteMessage={(messageId) => store.getState().quoteMessage(messageId)}
        onReconnect={() => store.getState().reconnectIm()}
        onRevokeMessage={(messageId) => store.getState().revokeMessage(messageId)}
        onRemoveChannelMember={(memberId) =>
          store.getState().removeChannelMember(memberId)
        }
        onRetryMessage={(messageId) => store.getState().retryMessage(messageId)}
        onRetryThreadReplyIndex={(messageId) =>
          store.getState().retryThreadReplyIndex(messageId)
        }
        onClearMessageSearch={() => store.getState().clearMessageSearch()}
        onDraftChange={(text) => store.getState().updateConversationDraft(text)}
        onSearchMessages={(query) => store.getState().searchMessages(query)}
        onSelectChannel={async (channelId) => {
          await store.getState().selectChannel(channelId);
          const serverReference =
            serverSlug ?? store.getState().currentServerId;
          if (serverReference) {
            router.push(
              currentBrowserHref(
                workspaceSectionHref(serverReference, "chat", channelId),
              ) as Href,
            );
          }
        }}
        onSelectDirect={async (peerUserId) => {
          await store.getState().selectDirectConversation(peerUserId);
          const active = store.getState().activeConversation;
          if (active?.kind === "direct" && active.peerUserId === peerUserId) {
            if (!activeServerSlug) return;
            router.push(
              currentBrowserHref(
                active.directConversationId
                  ? directConversationHref(
                      active.directConversationId,
                      activeServerSlug,
                    )
                  : newDirectConversationHref(
                      active.peerMemberId,
                      activeServerSlug,
                    ),
              ) as Href,
            );
          }
        }}
        onSelectServer={async (serverId) => {
          const nextServer = store
            .getState()
            .servers.find((server) => server.id === serverId);
          router.push(
            currentBrowserHref(
              nextServer
                ? workspaceSectionHref(nextServer.slug, "chat", null)
                : "/home",
            ) as Href,
          );
        }}
        onSend={async (input) => {
          const before = store.getState().activeConversation;
          await store.getState().sendMessage(input);
          const after = store.getState().activeConversation;
          if (
            before?.kind === "direct" &&
            after?.kind === "direct" &&
            after.directConversationId &&
            activeServerSlug &&
            (target.kind === "direct_new" ||
              target.kind === "direct" &&
                target.directConversationId !== after.directConversationId)
          ) {
            router.replace(
              currentBrowserHref(
                directConversationHref(
                  after.directConversationId,
                  activeServerSlug,
                ),
              ) as Href,
            );
          }
        }}
        onSendThreadReply={(input) => store.getState().sendThreadReply(input)}
        onToggleReaction={(messageId, reactionId) =>
          store.getState().toggleReaction(messageId, reactionId)
        }
        onUpdateChannel={(channelId, input) =>
          store.getState().updateChannel(channelId, input)
        }
        pendingAction={state.pendingAction}
        operations={
          target.kind === "channel"
            ? Object.values(state.operationsById).filter(
                (item) =>
                  item.resourceId === target.channelId ||
                  item.resourceId === target.serverId,
              )
            : []
        }
        pendingThreadIndexMessageIds={state.pendingThreadIndexMessageIds}
        conversationDrafts={state.conversationDrafts}
        searchCompleted={state.searchCompleted}
        searchError={state.searchError}
        searchLocateError={state.searchLocateError}
        searchQuery={state.searchQuery}
        searchResults={state.searchResults}
        searchingMessages={state.searchingMessages}
        selectedQuote={state.selectedQuote}
        sending={state.sendingMessage}
        sendingThreadReply={state.sendingThreadReply}
        serverAgents={state.agents}
        sectionHref={(section) =>
          activeServerSlug
            ? workspaceSectionHref(
                activeServerSlug,
                section,
                state.currentChannelId,
              )
            : "/home"
        }
        serverHref={(server) => serverRootHref(server.slug)}
        servers={state.servers}
        threadCompleted={state.threadCompleted}
        threadLoading={state.threadLoading}
        threadMessages={state.threadMessages}
        threadRootMessage={state.threadRootMessage}
      />
    </>
  );
}
