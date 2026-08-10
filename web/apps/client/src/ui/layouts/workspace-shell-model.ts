import {
  composerDocumentMentions,
  composerDocumentText,
  createComposerTextDocument,
  isEveryoneChannel,
  memberCanManageServer,
} from "@vela/client-core";

import {formatConversationTimestamp} from "../date-time";
import {
  buildSectionPresentationNavigation,
  type ConversationPageModel,
  type PresentationAction,
} from "../presentation";
import type {ConversationScope} from "./conversation-scope";
import type {WorkspaceShellProps} from "./workspace-shell";

export type ConversationFormMode =
  | "attach-file"
  | "attach-image"
  | "create-channel"
  | "edit-channel"
  | "manage-channel-members"
  | "new-direct"
  | "search"
  | null;

export interface ConversationSemanticState {
  closeForm(): void;
  formMode: ConversationFormMode;
  formValue: string;
  formValues: Record<string, string>;
  openForm(
    mode: Exclude<ConversationFormMode, null>,
    value?: string,
    values?: Record<string, string>,
  ): void;
  setFormField(id: string, value: string): void;
  setFormValue(value: string): void;
}

export function conversationPageModel(
  props: WorkspaceShellProps,
  semantic: ConversationSemanticState,
  scope: ConversationScope,
): ConversationPageModel {
  const {
    account,
    activeConversation,
    activeDirectConversation: activeDirect,
    activeDirectMember,
    activeDraft: draft,
    canJoinCurrentChannel: canJoin,
    currentChannel,
    currentMember,
    currentServer,
    directCandidates,
  } = scope;
  const threadActive = Boolean(
    activeConversation?.kind === "channel" &&
      props.activeThread &&
      props.threadRootMessage,
  );
  const searchActive = Boolean(
    props.searchQuery || props.searchingMessages || props.searchError,
  );
  const displayedMessages = threadActive
    ? [props.threadRootMessage!, ...(props.threadMessages ?? [])]
    : searchActive
      ? (props.searchResults ?? [])
      : props.messages;
  const draftText = composerDocumentText(draft.document);
  const mentionIds = composerDocumentMentions(draft.document).map(
    (mention) => mention.imUserId,
  );
  const navigation: PresentationAction[] = buildSectionPresentationNavigation(
    section => props.onNavigateSection?.(section),
    memberCanManageServer(currentMember),
  );
  const commands: PresentationAction[] = [];
  if (threadActive) {
    commands.push({
      id: "close-thread",
      label: "返回频道",
      run: () => props.onCloseThread?.(),
      shortcut: "Esc",
    });
  }
  if (
    !threadActive &&
    displayedMessages.length > 0 &&
    !props.historyCompleted
  ) {
    commands.push({
      disabled: props.loadingOlder,
      id: "load-older",
      label: props.loadingOlder ? "加载中" : "更早消息",
      run: () => props.onLoadOlder?.(),
      shortcut: "L",
    });
  }
  if (activeConversation && props.onSearchMessages) {
    commands.push({
      disabled: props.searchingMessages,
      id: "search",
      label: props.searchingMessages ? "搜索中" : "搜索当前会话",
      run: () => semantic.openForm("search", props.searchQuery ?? ""),
      shortcut: "/",
    });
  }
  if (searchActive) {
    commands.push({
      id: "clear-search",
      label: "返回会话",
      run: () => props.onClearMessageSearch?.(),
      shortcut: "Esc",
    });
  }
  if (props.canManageChannels && props.onCreateChannel) {
    commands.push({
      id: "create-channel",
      kind: "primary",
      label: "新建 Channel",
      run: async () => {
        await props.onOpenChannelManagement?.();
        semantic.openForm("create-channel", "", {
          name: "",
          visibility: "public",
        });
      },
      shortcut: "N",
    });
  }
  if (
    props.canManageChannels &&
    currentChannel &&
    !isEveryoneChannel(currentChannel)
  ) {
    commands.push({
      id: "edit-channel",
      label: "编辑 Channel",
      run: async () => {
        await props.onOpenChannelManagement?.();
        semantic.openForm("edit-channel", "", {
          name: currentChannel.name,
          visibility: currentChannel.visibility,
        });
      },
      shortcut: "E",
    });
    commands.push({
      id: "manage-channel-members",
      label: "管理 Channel 成员",
      run: async () => {
        await props.onOpenChannelManagement?.();
        semantic.openForm("manage-channel-members");
      },
      shortcut: "M",
    });
  }
  if (props.onSelectDirect && (props.members?.length ?? 0) > 0) {
    commands.push({
      id: "new-direct",
      label: "新建私信",
      run: () => semantic.openForm("new-direct"),
      shortcut: "D",
    });
  }
  if (canJoin && currentMember) {
    commands.push({
      id: "join-channel",
      kind: "primary",
      label: "加入频道",
      run: () => props.onAddChannelMember?.(currentMember.id),
      shortcut: "J",
    });
  }
  if (props.imStatus !== "ready" && props.onReconnect) {
    commands.push({
      id: "reconnect",
      kind: "primary",
      label: "重新连接",
      run: props.onReconnect,
      shortcut: "R",
    });
  }

  const title = searchActive
    ? `搜索 · ${props.searchQuery || "当前会话"}`
    : threadActive
      ? `话题 · ${props.threadRootMessage?.senderName ?? "消息"}`
      : activeConversation?.kind === "direct"
        ? `@ ${activeDirect?.peerDisplayName ?? activeDirectMember?.displayName ?? activeConversation.peerUserId}`
        : currentChannel
          ? `# ${currentChannel.name}`
          : "选择会话";
  const onlineAgents = (props.serverAgents ?? props.agents).filter(
    (agent) =>
      agent.availability === "online" || agent.observedState === "running",
  ).length;
  const composerDisabled = Boolean(
    props.sending ||
      props.sendingThreadReply ||
      props.imStatus !== "ready" ||
      !activeConversation ||
      (activeConversation.kind === "channel" && !currentChannel?.joined),
  );
  const composerActions: PresentationAction[] = [];
  if (props.onAttachLocalPath && !threadActive) {
    composerActions.push({
      disabled: composerDisabled,
      id: "attach-image",
      label: "添加图片",
      run: () => semantic.openForm("attach-image"),
      shortcut: "I",
    });
    composerActions.push({
      disabled: composerDisabled,
      id: "attach-file",
      label: "添加文件",
      run: () => semantic.openForm("attach-file"),
      shortcut: "F",
    });
  }

  const form =
    semantic.formMode === "search"
      ? {
          actions: [
            {
              id: "cancel",
              label: "取消",
              run: semantic.closeForm,
            },
            {
              disabled: semantic.formValue.trim().length === 0,
              id: "submit",
              kind: "primary" as const,
              label: "搜索",
              run: async () => {
                await props.onSearchMessages?.(semantic.formValue.trim());
                semantic.closeForm();
              },
            },
          ],
          fields: [
            {
              id: "query",
              label: "关键词",
              onChange: semantic.setFormValue,
              placeholder: "搜索当前会话",
              value: semantic.formValue,
            },
          ],
          title: "搜索消息",
        }
      : semantic.formMode === "attach-file" ||
          semantic.formMode === "attach-image"
        ? {
            actions: [
              {
                id: "cancel",
                label: "取消",
                run: semantic.closeForm,
              },
              {
                disabled: !semantic.formValue.trim().startsWith("/"),
                id: "submit",
                kind: "primary" as const,
                label: "发送",
                run: async () => {
                  const kind =
                    semantic.formMode === "attach-image" ? "image" : "file";
                  await props.onAttachLocalPath?.({
                    kind,
                    path: semantic.formValue.trim(),
                  });
                  semantic.closeForm();
                },
              },
            ],
            fields: [
              {
                id: "path",
                label: "本地绝对路径",
                onChange: semantic.setFormValue,
                placeholder: "/Users/name/path/to/file",
                value: semantic.formValue,
              },
            ],
            title:
              semantic.formMode === "attach-image" ? "添加图片" : "添加文件",
          }
        : semantic.formMode === "create-channel" ||
            semantic.formMode === "edit-channel"
          ? {
              actions: [
                {
                  id: "cancel",
                  label: "取消",
                  run: semantic.closeForm,
                },
                {
                  disabled: !(semantic.formValues.name ?? "").trim(),
                  id: "submit",
                  kind: "primary" as const,
                  label:
                    semantic.formMode === "create-channel" ? "创建" : "保存",
                  run: async () => {
                    const input = {
                      name: (semantic.formValues.name ?? "").trim(),
                      visibility:
                        semantic.formValues.visibility === "private"
                          ? ("private" as const)
                          : ("public" as const),
                    };
                    if (semantic.formMode === "create-channel") {
                      await props.onCreateChannel?.(input);
                    } else if (currentChannel) {
                      await props.onUpdateChannel?.(currentChannel.id, input);
                    }
                    semantic.closeForm();
                  },
                },
              ],
              fields: [
                {
                  id: "channel-name",
                  label: "Channel 名称",
                  onChange: (value: string) =>
                    semantic.setFormField("name", value),
                  placeholder: "例如：研发",
                  value: semantic.formValues.name ?? "",
                },
                {
                  id: "visibility",
                  label: "可见范围",
                  onChange: (value: string) =>
                    semantic.setFormField("visibility", value),
                  options: [
                    { label: "公开", value: "public" },
                    { label: "私密", value: "private" },
                  ],
                  value: semantic.formValues.visibility ?? "public",
                },
              ],
              title:
                semantic.formMode === "create-channel"
                  ? "新建 Channel"
                  : `编辑 #${currentChannel?.name ?? "Channel"}`,
            }
          : semantic.formMode === "manage-channel-members" && currentChannel
            ? {
                actions: [
                  {
                    id: "close",
                    label: "完成",
                    run: semantic.closeForm,
                  },
                  ...(props.members ?? []).map((member) => {
                    const joined = (props.channelMembers ?? []).some(
                      (item) => item.id === member.id,
                    );
                    return {
                      id: `${joined ? "remove" : "add"}-${member.id}`,
                      label: `${joined ? "移除" : "添加"} ${member.displayName}`,
                      run: () =>
                        joined
                          ? props.onRemoveChannelMember?.(member.id)
                          : props.onAddChannelMember?.(member.id),
                    };
                  }),
                ],
                fields: [],
                title: `管理 #${currentChannel.name} 成员`,
              }
            : semantic.formMode === "new-direct"
              ? {
                  actions: [
                    {
                      id: "cancel",
                      label: "取消",
                      run: semantic.closeForm,
                    },
                    ...directCandidates.map((member) => ({
                      id: `direct-${member.id}`,
                      label: `${member.displayName} · @${member.handle}`,
                      run: async () => {
                        await props.onSelectDirect?.(member.imUserId!);
                        semantic.closeForm();
                      },
                    })),
                  ],
                  fields: [],
                  title: "新建私信",
                }
              : undefined;

  return {
    commands,
    composer: {
      actions: composerActions,
      disabled: composerDisabled,
      onChange: (value) =>
        props.onDraftChange?.({
          ...draft,
          document: createComposerTextDocument(value),
        }),
      onSend: async () => {
        const text = draftText.trim();
        if (!text || composerDisabled) return;
        if (threadActive) {
          await props.onSendThreadReply?.({mentionedUserIds: mentionIds, text});
        } else {
          await props.onSend(draft);
        }
      },
      placeholder: activeConversation
        ? `给 ${title} 发消息`
        : "请先选择 Channel 或私信",
      value: draftText,
    },
    conversations: [
      ...props.channels.map((channel) => ({
        id: channel.id,
        kind: "channel" as const,
        onSelect: () => props.onSelectChannel(channel.id),
        selected:
          activeConversation?.kind === "channel" &&
          activeConversation.channelId === channel.id,
        status: channel.joined ? "已加入" : "可加入",
        subtitle:
          isEveryoneChannel(channel)
            ? "全体成员根群"
            : channel.visibility === "public"
              ? "公开频道"
              : "私有频道",
        title: `# ${channel.name}`,
      })),
      ...(props.directConversations ?? []).map((conversation) => ({
        id: `direct-${conversation.peerUserId}`,
        kind: "direct" as const,
        onSelect: () => props.onSelectDirect?.(conversation.peerUserId),
        selected:
          activeConversation?.kind === "direct" &&
          activeConversation.peerUserId === conversation.peerUserId,
        subtitle: conversation.lastMessagePreview || "私信",
        title: `@ ${conversation.peerDisplayName}`,
        unreadCount: conversation.unreadCount,
      })),
    ],
    empty: searchActive
      ? {
          description: props.searchError ?? "换一个关键词再试。",
          title: props.searchingMessages ? "正在搜索" : "没有找到消息",
        }
      : activeConversation
        ? {
            description: "从这里和 Human、Agent 开始协作。",
            title: "还没有消息",
          }
        : { description: "从左侧选择 Channel 或私信。", title: "选择一个会话" },
    ...(props.error ? { error: props.error } : {}),
    ...(form ? { form } : {}),
    header: {
      eyebrow: `${currentServer?.name ?? "SERVER"} / CHAT`,
      summary: `${onlineAgents} 个 Agent 在线 · ${props.imStatus === "ready" ? "消息已连接" : "消息未连接"}`,
      title,
    },
    messages: displayedMessages.map((message) => {
      const actions: PresentationAction[] = [];
      if (searchActive) {
        actions.push({
          disabled: props.locatingSearchResultId === message.id,
          id: "locate",
          label:
            props.locatingSearchResultId === message.id
              ? "定位中"
              : "在会话中查看",
          run: () => props.onLocateSearchResult?.(message.id),
        });
      }
      if (message.delivery.state === "failed" && message.delivery.retryable) {
        actions.push({
          id: "retry",
          label: "重试",
          run: () => props.onRetryMessage?.(message.id),
        });
      }
      if (!searchActive && message.delivery.state === "sent") {
        if (
          message.direction === "outgoing" &&
          !message.id.startsWith("local:") &&
          message.rawType !== "TIMRevokedElem" &&
          props.onRevokeMessage
        ) {
          actions.push({
            id: "revoke",
            kind: "danger",
            label: "撤回",
            run: () => props.onRevokeMessage?.(message.id),
          });
        }
        actions.push({
          id: "quote",
          label: "引用",
          run: () => props.onQuoteMessage?.(message.id),
        });
        if (!threadActive && activeConversation?.kind === "channel") {
          actions.push({
            id: "thread",
            label: "话题",
            run: () => props.onOpenThread?.(message.id),
          });
          actions.push({
            id: "task",
            label: "生成任务",
            run: () => props.onCreateTaskFromMessage?.(message.id),
          });
        }
        actions.push({
          id: "reaction-like",
          label: "赞",
          run: () => props.onToggleReaction?.(message.id, "👍"),
        });
      }
      const delivery =
        message.delivery.state === "failed"
          ? "发送失败"
          : message.delivery.state === "sending"
            ? "发送中"
            : message.delivery.state === "uploading"
              ? `上传 ${message.delivery.progress}%`
              : "已发送";
      return {
        actions,
        id: message.id,
        meta: [formatConversationTimestamp(message.createdAt), delivery]
          .filter(Boolean)
          .join(" · "),
        sender: message.senderName,
        text: message.text || "[不支持的消息类型]",
      };
    }),
    shell: {
      accountLabel: account?.displayName,
      activeSection: "chat",
      navigation,
      onLogout: props.onLogout,
      serverName: currentServer?.name,
      serverOptions: props.servers.map((server) => ({
        id: server.id,
        label: server.name,
        onSelect: () => props.onSelectServer(server.id),
        selected: server.id === props.currentServerId,
      })),
    },
  };
}
