import type {
  Account,
  DirectConversationResource,
  Member,
} from "@lightvela/vela-chat-client-core";
import type { ExtensionSettingsViewProps } from "@opencraft/extension-react";
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

function isSelf(member: Member, account: Account | null): boolean {
  if (account === null) return false;
  return member.accountId === account.id || (
    Boolean(account.imUserId) && member.imUserId === account.imUserId
  );
}

function directPeer(
  conversation: DirectConversationResource,
  account: Account | null,
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
  }: ExtensionSettingsViewProps) {
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

    const serverId = route.kind === "home" ? null : route.serverId;
    const activeServer = workspace.servers.find((server) => server.id === serverId) ?? null;
	const computers = serverId === null ? [] : (workspace.computersByServer[serverId] ?? []);
	const attachedInstanceIds = new Set(computers.map((computer) => computer.instanceId));
	const attachableInstances = workspace.availableInstances.filter(
	  (instance) => !attachedInstanceIds.has(instance.instanceId),
	);
    const selectedComputer = route.kind === "computer"
	  ? computers.find((computer) => computer.id === route.computerId) ?? null
      : null;
    const selectedChannel = route.kind === "channel" || route.kind === "im-thread"
      ? directory.channels.find((channel) => channel.id === route.channelId) ?? null
      : null;
    const selectedDirect = route.kind === "direct"
      ? directory.directConversations.find(
          (conversation) => conversation.id === route.directConversationId,
        ) ?? null
      : null;
    const selectedMember = route.kind === "member"
      ? directory.members.find((member) => member.id === route.memberId) ?? null
      : null;

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
      return <div className="collaboration-status" role="alert">{workspace.error}</div>;
    }
    if (workspace.servers.length === 0) {
      return <div className="collaboration-status">还没有 Server。</div>;
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
            value={serverId ?? ""}
            onChange={(event) => navigate({ kind: "chat", serverId: event.currentTarget.value })}
          >
            {workspace.servers.map((server) => (
              <option key={server.id} value={server.id}>{server.name}</option>
            ))}
          </select>
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
              <section>
                <h2>Channels</h2>
                {directory.channels.map((channel) => (
                  <button
                    className={selectedChannel?.id === channel.id ? "is-selected" : undefined}
                    disabled={!channel.joined || channel.imState !== "ready"}
                    key={channel.id}
                    type="button"
                    onClick={() => serverId && navigate({ kind: "channel", serverId, channelId: channel.id })}
                  ># {channel.name}</button>
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
              <>
                <header>
                  <span>{route.kind === "direct" ? "Private message" : "Channel"}</span>
                  <h1>{selectedChannel?.name ?? (selectedDirect ? directPeer(selectedDirect, workspace.account).displayName : "Conversation")}</h1>
                </header>
                {chat.error ? <div role="alert">{chat.error}</div> : null}
                <ol className="collaboration-messages" aria-live="polite">
                  {chat.messages.map((message) => (
                    <li key={message.id}>
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
                    disabled={chat.phase === "loading"}
                    placeholder="发送消息"
                    value={chat.draft}
                    onChange={(event) => services.chat.setDraft(event.currentTarget.value)}
                  />
                  <button disabled={!chat.draft.trim() || chat.phase === "sending"} type="submit">
                    {chat.phase === "sending" ? "发送中…" : "发送"}
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
                <h1>{chatActive ? "选择一个 Channel 或成员" : "选择一台 Computer"}</h1>
                <p>{chatActive ? "群聊和私聊共用同一套腾讯 IM 体验。" : "从已有 LightVela 实例中选择 Computer。"}</p>
              </section>
            )}
          </main>
        </div>
      </div>
    );
  };
}
