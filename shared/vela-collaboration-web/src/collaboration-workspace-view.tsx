import type {
  HumanProfile,
  DirectConversationResource,
  Member,
} from "@lightvela/vela-chat-client-core";
import { channelAddress, directAddress } from "@lightvela/vela-chat-client-core/messaging/conversation";
export interface CollaborationWorkspaceViewProps {
  readonly activation: { readonly viewId: string; readonly resourceUri: string | null };
  readonly host: {
    replaceViewResource(viewId: string, resourceUri: string): void;
    pushViewResource(viewId: string, resourceUri: string): void;
  };
}
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { CollaborationWorkspaceController } from "./collaboration-workspace-controller";
import type { CollaborationWorkspaceService } from "./collaboration-workspace-service";
import type { ImChatService } from "./im-chat-service";
import type { ImDirectoryService } from "./im-directory-service";
import {
  parseCollaborationWorkspaceRoute,
  serializeCollaborationWorkspaceRoute,
  type CollaborationWorkspaceRoute,
} from "./workspace-route";

export interface CollaborationWorkspaceViewServices {
  readonly workspace: CollaborationWorkspaceService;
  readonly directory: ImDirectoryService;
  readonly chat: ImChatService;
  readonly controller: CollaborationWorkspaceController;
	readonly computersEnabled: boolean;
}

function isSelf(member: Member, account: HumanProfile | null): boolean {
  if (account === null) return false;
  return member.accountId === account.id || (
    Boolean(account.imUserId) && member.imUserId === account.imUserId
  );
}

function directPeer(
  conversation: DirectConversationResource,
  account: HumanProfile | null,
): Member {
  if (isSelf(conversation.memberA, account)) return conversation.memberB;
  if (isSelf(conversation.memberB, account)) return conversation.memberA;
  return conversation.memberB;
}

export function createCollaborationWorkspaceView(
  services: CollaborationWorkspaceViewServices,
) {
  return function CollaborationWorkspaceView({
    activation,
    host,
  }: CollaborationWorkspaceViewProps) {
    const workspace = useSyncExternalStore(
      services.workspace.subscribe,
      services.workspace.getSnapshot,
      services.workspace.getSnapshot,
    );
    const directory = useSyncExternalStore(
      services.directory.subscribe,
      services.directory.getSnapshot,
      services.directory.getSnapshot,
    );
    const chat = useSyncExternalStore(
      services.chat.subscribe,
      services.chat.getSnapshot,
      services.chat.getSnapshot,
    );
    const route = useMemo<CollaborationWorkspaceRoute>(
      () => parseCollaborationWorkspaceRoute(activation.resourceUri) ?? { kind: "home" },
      [activation.resourceUri],
    );
    const [activationError, setActivationError] = useState<string | null>(null);
	const [serverName, setServerName] = useState("");
	const [creationError, setCreationError] = useState<string | null>(null);
	const [creatingServer, setCreatingServer] = useState(false);
	const [joinToken, setJoinToken] = useState("");
	const [joiningServer, setJoiningServer] = useState(false);
	const [joinError, setJoinError] = useState<string | null>(null);
	const [inviteSecret, setInviteSecret] = useState<{ serverId: string; token: string } | null>(null);
	const [creatingInvite, setCreatingInvite] = useState(false);
	const [inviteError, setInviteError] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [instanceToAttach, setInstanceToAttach] = useState("");
	const [attaching, setAttaching] = useState(false);

    useEffect(() => {
      setActivationError(null);
      void services.controller.activate(route).catch((error: unknown) => {
        setActivationError(error instanceof Error ? error.message : String(error));
      });
    }, [route]);

    useEffect(() => {
      if (route.kind !== "home" || workspace.phase !== "ready") return;
      const first = workspace.servers[0];
      if (first === undefined) return;
      host.replaceViewResource(
        activation.viewId,
        serializeCollaborationWorkspaceRoute({ kind: "chat", serverId: first.id }),
      );
    }, [activation.viewId, host, route.kind, workspace.phase, workspace.servers]);

    useEffect(() => {
      if (route.kind !== "chat" || directory.phase !== "ready" ||
        directory.serverId !== route.serverId) return;
      const first = directory.channels.find((channel) => channel.joined && channel.imState === "ready");
      if (first === undefined) return;
      host.replaceViewResource(
        activation.viewId,
        serializeCollaborationWorkspaceRoute({
          kind: "channel",
          serverId: route.serverId,
          channelId: first.id,
        }),
      );
    }, [activation.viewId, directory.channels, directory.phase, directory.serverId, host, route]);

    const serverId = route.kind === "home" ? null : route.serverId;
    const activeServer = workspace.servers.find((server) => server.id === serverId) ?? null;
	const ownMember = directory.serverId === serverId
	  ? directory.members.find((member) => isSelf(member, workspace.account))
	  : undefined;
	const canInvite = ownMember?.role === "owner" || ownMember?.role === "admin";

	useEffect(() => {
	  setInviteSecret(null);
	  setInviteError(null);
	}, [serverId]);
	const computers = serverId === null ? [] : (workspace.computersByServer[serverId] ?? []);
	const attachedInstanceIds = new Set(computers.map((computer) => computer.instanceId));
	const attachableInstances = workspace.availableInstances.filter(
	  (instance) => !attachedInstanceIds.has(instance.instanceId),
	);
    const selectedComputer = route.kind === "computer"
	  ? computers.find((computer) => computer.id === route.computerId) ?? null
      : null;
    const selectedChannel = route.kind === "channel" || route.kind === "im-thread"
      ? directory.serverId === serverId
        ? directory.channels.find((channel) => channel.id === route.channelId) ?? null
        : null
      : null;
    const selectedDirect = route.kind === "direct"
      ? directory.serverId === serverId ? directory.directConversations.find(
          (conversation) => conversation.id === route.directConversationId,
        ) ?? null : null
      : null;
    const selectedMember = route.kind === "member"
      ? directory.serverId === serverId
        ? directory.members.find((member) => member.id === route.memberId) ?? null
        : null
      : null;
    const selectedAddress = route.kind === "channel" || route.kind === "im-thread"
      ? selectedChannel === null ? null : channelAddress(selectedChannel)
      : route.kind === "direct" && selectedDirect !== null
        ? directAddress({
            directConversationId: selectedDirect.id,
            imGroupId: selectedDirect.imGroupId,
            imState: selectedDirect.imState,
          })
        : null;
    const chatMatchesRoute = selectedAddress !== null &&
      chat.address?.conversationId === selectedAddress.conversationId;
    const chatPreparing = activeServer?.imState !== "ready" ||
      (directory.phase === "ready" && directory.serverId === serverId &&
        !directory.channels.some((channel) => channel.joined && channel.imState === "ready"));
    const chatFailed = activeServer?.imState === "error" ||
      (directory.serverId === serverId && directory.channels.some(
        (channel) => channel.joined && channel.systemKey === "all" && channel.imState === "error",
      ));

    const navigate = (next: CollaborationWorkspaceRoute) => {
      host.pushViewResource(
        activation.viewId,
        serializeCollaborationWorkspaceRoute(next),
      );
    };

    if (workspace.phase === "idle" || workspace.phase === "loading") {
      return <div className="collaboration-status" role="status">正在加载 Collaboration…</div>;
    }
    if (workspace.phase === "error") {
      const signedOut = workspace.errorKind === "authentication";
      return (
        <div className="collaboration-status collaboration-status--error" role="alert">
          <h1>{signedOut ? "登录后开始协作" : "暂时无法打开协作空间"}</h1>
          <p>{signedOut
            ? "请从左下角登录 LightVela，完成后点击重试。"
            : "检查连接后重试，已输入的内容会保留。"}</p>
          <button
            type="button"
            onClick={() => {
              void services.controller.activate(route).catch(() => {
                setActivationError("重试失败，请稍后再试。");
              });
            }}
          >重试</button>
        </div>
      );
    }
    if (workspace.servers.length === 0) {
      return (
        <main className="collaboration-onboarding">
          <div className="collaboration-onboarding__intro">
            <span>LIGHTVELA · COLLABORATION</span>
            <h1>从一个 Server 开始协作</h1>
            <p>Server 会自动准备全员频道。之后，你可以在这里与成员或 Agent 聊天。</p>
          </div>
          <div className="collaboration-onboarding__actions">
          <form
            className="collaboration-onboarding__form"
            onSubmit={(event) => {
              event.preventDefault();
              if (creatingServer || !serverName.trim()) return;
              setCreatingServer(true);
              setCreationError(null);
              void services.workspace.createServer(serverName)
                .then((createdServerId) => navigate({ kind: "chat", serverId: createdServerId }))
                .catch(() => setCreationError("暂时无法确认创建结果，请重试。"))
                .finally(() => setCreatingServer(false));
            }}
          >
            <label htmlFor="collaboration-server-name">Server 名称</label>
            <input
              id="collaboration-server-name"
              autoComplete="off"
              disabled={creatingServer}
              maxLength={100}
              placeholder="例如：项目协作"
              required
              value={serverName}
              onChange={(event) => setServerName(event.currentTarget.value)}
            />
            {creationError ? <p role="alert">{creationError}</p> : null}
            <button disabled={!serverName.trim() || creatingServer} type="submit">
              {creatingServer ? "创建中…" : "创建 Server"}
            </button>
          </form>
          <form
            className="collaboration-onboarding__form"
            onSubmit={(event) => {
              event.preventDefault();
              if (joiningServer || !joinToken.trim()) return;
              setJoiningServer(true);
              setJoinError(null);
              void services.workspace.acceptJoinLink(joinToken)
                .then((joinedServerId) => {
                  setJoinToken("");
                  navigate({ kind: "chat", serverId: joinedServerId });
                })
                .catch(() => setJoinError("暂时无法确认加入结果，请保留令牌并重试。"))
                .finally(() => setJoiningServer(false));
            }}
          >
            <h2>加入已有 Server</h2>
            <label htmlFor="collaboration-join-token">邀请令牌</label>
            <input
              id="collaboration-join-token"
              autoComplete="off"
              disabled={joiningServer}
              required
              spellCheck={false}
              type="password"
              value={joinToken}
              onChange={(event) => setJoinToken(event.currentTarget.value)}
            />
            {joinError ? <p role="alert">{joinError}</p> : null}
            <button disabled={!joinToken.trim() || joiningServer} type="submit">
              {joiningServer ? "加入中…" : "加入 Server"}
            </button>
          </form>
          </div>
        </main>
      );
    }
	if (!services.computersEnabled && (route.kind === "computers" || route.kind === "computer")) {
	  return <div className="collaboration-status">Computer 功能尚未启用。</div>;
	}

	const chatActive = !services.computersEnabled || (route.kind !== "computers" && route.kind !== "computer");
    return (
      <div className="collaboration-workspace">
        <header className="collaboration-workspace__header">
          <div>
            <span>LightVela</span>
            <strong>{activeServer?.name ?? "Collaboration"}</strong>
          </div>
          <select
            aria-label="选择 Server"
            value={activeServer?.id ?? workspace.servers[0]?.id ?? ""}
            onChange={(event) => navigate({ kind: "chat", serverId: event.currentTarget.value })}
          >
            {workspace.servers.map((server) => (
              <option key={server.id} value={server.id}>{server.name}</option>
            ))}
          </select>
          <button
            className="collaboration-workspace__refresh"
            disabled={refreshing}
            type="button"
            onClick={() => {
              setRefreshing(true);
              setActivationError(null);
              void services.controller.activate(route)
                .catch(() => setActivationError("刷新失败，请稍后重试。"))
                .finally(() => setRefreshing(false));
            }}
          >{refreshing ? "刷新中…" : "刷新"}</button>
          <nav aria-label="Collaboration sections">
			<button
              className={chatActive ? "is-active" : undefined}
              type="button"
              onClick={() => serverId && navigate({ kind: "chat", serverId })}
            >Chat</button>
			{services.computersEnabled ? <button
              className={!chatActive ? "is-active" : undefined}
              type="button"
              onClick={() => serverId && navigate({ kind: "computers", serverId })}
			>Computers</button> : null}
          </nav>
        </header>

        {activationError ? <div className="collaboration-workspace__error" role="alert">{activationError}</div> : null}

        <div className="collaboration-workspace__body">
          {chatActive ? (
            <aside className="collaboration-directory">
              {directory.phase === "loading" && directory.serverId === serverId
                ? <p role="status">正在加载频道…</p> : null}
              {directory.phase === "error" && directory.serverId === serverId
                ? <p role="alert">频道加载失败，请刷新重试。</p> : null}
              <section>
                <h2>Channels</h2>
                {directory.channels.map((channel) => (
                  <button
                    className={selectedChannel?.id === channel.id ? "is-selected" : undefined}
                    disabled={!channel.joined || channel.imState !== "ready"}
                    key={channel.id}
                    type="button"
                    onClick={() => serverId && navigate({ kind: "channel", serverId, channelId: channel.id })}
                  ><span># {channel.name}</span>
                    {channel.imState !== "ready"
                      ? <small>{channel.imState === "error" ? "初始化失败" : "准备中"}</small>
                      : null}
                  </button>
                ))}
              </section>
              <section>
                <h2>Private messages</h2>
                {directory.directConversations.map((conversation) => {
                  const peer = directPeer(conversation, workspace.account);
                  return (
                    <button
                      className={selectedDirect?.id === conversation.id ? "is-selected" : undefined}
                      key={conversation.id}
                      type="button"
                      onClick={() => serverId && navigate({
                        kind: "direct",
                        serverId,
                        directConversationId: conversation.id,
                      })}
                    >{peer.displayName}</button>
                  );
                })}
              </section>
              <section>
                <h2>Members</h2>
                {canInvite && serverId ? (
                  <div className="collaboration-directory__invite">
                    <button
                      disabled={creatingInvite}
                      type="button"
                      onClick={() => {
                        setCreatingInvite(true);
                        setInviteSecret(null);
                        setInviteError(null);
                        void services.workspace.createInvite(serverId)
                          .then((token) => setInviteSecret({ serverId, token }))
                          .catch(() => setInviteError("邀请创建失败，请稍后重试。"))
                          .finally(() => setCreatingInvite(false));
                      }}
                    >{creatingInvite ? "生成中…" : "生成一次性邀请"}</button>
                    {inviteSecret?.serverId === serverId ? (
                      <div className="collaboration-directory__invite-secret">
                        <label htmlFor="collaboration-invite-token">邀请令牌（仅显示一次，24 小时内有效）</label>
                        <input id="collaboration-invite-token" readOnly value={inviteSecret.token} />
                      </div>
                    ) : null}
                    {inviteError ? <p role="alert">{inviteError}</p> : null}
                  </div>
                ) : null}
                {directory.members.map((member) => (
                  <button
                    className={selectedMember?.id === member.id ? "is-selected" : undefined}
                    key={member.id}
                    type="button"
                    onClick={() => serverId && navigate({ kind: "member", serverId, memberId: member.id })}
                  >
                    <span>{member.displayName}</span>
                    <small>{member.kind === "agent" ? "Agent" : isSelf(member, workspace.account) ? "你" : "成员"}</small>
                  </button>
                ))}
              </section>
            </aside>
          ) : (
            <aside className="collaboration-directory">
              <section>
                <h2>Computers</h2>
                {computers.map((computer) => (
                  <button
					className={selectedComputer?.id === computer.id ? "is-selected" : undefined}
					key={computer.id}
                    type="button"
					onClick={() => serverId && navigate({ kind: "computer", serverId, computerId: computer.id })}
                  >
                    <span>{computer.name}</span>
					<small>{computer.observedState}</small>
                  </button>
                ))}
                {computers.length === 0 ? <p>这个 Server 还没有 Computer。</p> : null}
				<label htmlFor="collaboration-instance-picker">加入已有实例</label>
				<select
				  id="collaboration-instance-picker"
				  value={instanceToAttach}
				  onChange={(event) => setInstanceToAttach(event.currentTarget.value)}
				>
				  <option value="">选择 LightVela 实例</option>
				  {attachableInstances.map((instance) => (
					<option key={instance.instanceId} value={instance.instanceId}>
					  {instance.name} · {instance.status}
					</option>
				  ))}
				</select>
				<button
				  disabled={serverId === null || instanceToAttach === "" || attaching}
				  type="button"
				  onClick={() => {
					if (serverId === null || instanceToAttach === "") return;
					setAttaching(true);
					setActivationError(null);
					void services.workspace.attachComputer(serverId, instanceToAttach)
					  .then((computer) => {
						setInstanceToAttach("");
						navigate({ kind: "computer", serverId, computerId: computer.id });
					  })
					  .catch((error: unknown) => {
						setActivationError(error instanceof Error ? error.message : String(error));
					  })
					  .finally(() => setAttaching(false));
				  }}
				>{attaching ? "正在加入…" : "加入 Server"}</button>
              </section>
            </aside>
          )}

          <main className="collaboration-stage">
            {route.kind === "channel" || route.kind === "direct" || route.kind === "im-thread" ? (
              selectedAddress === null ? (
                <section className="collaboration-detail collaboration-detail--empty">
                  <h1>{directory.phase === "loading" ? "正在打开聊天" : "此聊天暂不可用"}</h1>
                  <p>{directory.phase === "loading"
                    ? "正在同步频道和成员。"
                    : "请刷新频道列表后重试。"}</p>
                </section>
              ) : <>
                <header>
                  <span>{route.kind === "direct" ? "Private message" : "Channel"}</span>
                  <h1>{selectedChannel?.name ?? (selectedDirect ? directPeer(selectedDirect, workspace.account).displayName : "Conversation")}</h1>
                </header>
                <ol className="collaboration-messages" aria-live="polite">
                  {chatMatchesRoute && (chat.error || chat.sendResolution === "uncertain")
                    ? <li className="collaboration-messages__error" role="alert">
                        {chat.sendResolution === "uncertain"
                          ? "发送结果待确认，请先确认状态。"
                          : "消息处理失败，请重试。"}
                      </li>
                    : null}
                  {chatMatchesRoute && !chat.historyCompleted && chat.historyCursor !== null
                    ? <li className="collaboration-messages__older">
                        <button
                          disabled={chat.historyLoading}
                          type="button"
                          onClick={() => { void services.chat.loadOlder(); }}
                        >{chat.historyLoading ? "加载中…" : "查看更早消息"}</button>
                      </li>
                    : null}
                  {!chatMatchesRoute || chat.phase === "loading"
                    ? <li className="collaboration-messages__state" role="status">正在加载消息…</li>
                    : chat.messages.length === 0
                      ? <li className="collaboration-messages__state">还没有消息，发出第一条吧。</li>
                      : chat.messages.map((message) => (
                    <li
                      className={message.direction === "outgoing" ? "is-outgoing" : undefined}
                      key={message.id}
                    >
                      <strong>{message.senderName}</strong>
                      <p>{message.text}</p>
                    </li>
                  ))}
                </ol>
                <form
                  className="collaboration-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void services.chat.sendDraft();
                  }}
                >
                  <textarea
                    aria-label="发送消息"
                    disabled={!chatMatchesRoute || chat.phase === "loading"}
                    placeholder="发送消息"
                    value={chat.draft}
                    onChange={(event) => services.chat.setDraft(event.currentTarget.value)}
                  />
                  <button
                    disabled={!chatMatchesRoute ||
                      (chat.sendResolution !== "uncertain" && !chat.draft.trim()) ||
                      chat.phase === "loading" ||
                      chat.phase === "sending"}
                    type="submit"
                  >
                    {chat.phase === "sending"
                      ? chat.sendResolution === "uncertain" ? "确认中…" : "发送中…"
                      : chat.sendResolution === "uncertain" ? "确认状态" : "发送"}
                  </button>
                </form>
              </>
            ) : route.kind === "member" ? (
              <section className="collaboration-detail">
                <span>Member</span>
                <h1>{selectedMember?.displayName ?? "成员不可用"}</h1>
                {selectedMember ? (
                  <>
                    <dl>
                      <div><dt>类型</dt><dd>{selectedMember.kind}</dd></div>
                      <div><dt>角色</dt><dd>{selectedMember.role}</dd></div>
                      <div><dt>状态</dt><dd>{selectedMember.status}</dd></div>
                    </dl>
                    {!isSelf(selectedMember, workspace.account) ? (
                      <button
                        className="collaboration-detail__primary-action"
                        type="button"
                        onClick={() => {
                          void services.directory.startPrivateConversation(selectedMember.id)
                            .then((directConversationId) => {
                              if (directConversationId === null || serverId === null) {
                                setActivationError("私聊正在建立，请稍后重试。");
                                return;
                              }
                              navigate({ kind: "direct", serverId, directConversationId });
                            })
                            .catch((error: unknown) => {
                              setActivationError(error instanceof Error ? error.message : String(error));
                            });
                        }}
                      >发起私聊</button>
                    ) : null}
                  </>
                ) : null}
              </section>
            ) : route.kind === "computer" ? (
              <section className="collaboration-detail">
                <span>Computer</span>
                <h1>{selectedComputer?.name ?? "Computer 不可用"}</h1>
                {selectedComputer ? (
                  <dl>
                      <div><dt>实例</dt><dd>{selectedComputer.instanceId}</dd></div>
					  <div><dt>状态</dt><dd>{selectedComputer.observedState}</dd></div>
                      <div><dt>创建时间</dt><dd>{selectedComputer.createdAt}</dd></div>
                  </dl>
                ) : null}
              </section>
            ) : (
              <section className="collaboration-detail collaboration-detail--empty">
                <h1>{chatActive
                  ? chatFailed ? "聊天初始化失败" : chatPreparing ? "正在准备聊天" : "选择一个频道或成员"
                  : "选择一台 Computer"}</h1>
                <p>{chatActive
                  ? chatFailed
                    ? "全员频道暂时无法使用，请稍后刷新或联系 Server 管理员。"
                    : chatPreparing
                    ? "Server 准备完成后，点击刷新即可进入全员频道。"
                    : "群聊和私聊在这里统一管理。"
                  : "从已有 LightVela 实例中选择 Computer。"}</p>
              </section>
            )}
          </main>
        </div>
      </div>
    );
  };
}
