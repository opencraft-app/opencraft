"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bot, Check, Loader2, Plus, UserPlus, Users } from "lucide-react";
import { platformGroupId, type IMMessage, type ImGroup } from "@vela/im-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSession } from "@/contexts/session-context";
import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";
import { readStoredAuthToken } from "@/repositories/http-repositories";
import { useVelaIm, type AgentItem, type VelaImController } from "./use-vela-im";
import { VelaImPortraitContext, type VelaImPortrait } from "./vela-im-avatar";
import { VelaImChat } from "./vela-im-chat";
import { GroupSettingsDialog } from "./vela-im-dialogs";
import { isVelaImEnabled } from "./vela-im-env";
import { describeMessage, errorText, isAgentID, toMembers, type ConversationItem } from "./vela-im-model";

/** Connects the signed-in person to IM in the background; the chat page only surfaces conversations once ready. */
export function useVelaImConsole(): VelaImController {
  const { session, authReady, isAuthenticated } = useSession();
  const token = isVelaImEnabled() && authReady && isAuthenticated ? readStoredAuthToken() : null;
  return useVelaIm(token, session.user?.id, session.user?.name ?? "");
}

/** Conversations with Agents (single chats and groups) shown in the chat page's session list. */
export const agentConversations = (im: VelaImController): ConversationItem[] =>
  im.conversations.filter((c) => c.kind === "GROUP" || (c.kind === "C2C" && isAgentID(c.targetID)));

const CONTEXT_MESSAGES = 10;
const defaultGroupName = (names: string[]) => {
  const joined = names.join("、");
  return joined.length > 28 ? `${joined.slice(0, 27)}…` : joined;
};

function AgentStateBadge({ agent }: { agent: AgentItem }) {
  const t = useT();
  if (agent.state === "provisioning") return <Badge variant="warning" className="gap-1"><Loader2 className="size-3 animate-spin" />{t("启动中")}</Badge>;
  if (agent.state === "error") return <Badge variant="danger">{t("启动失败")}</Badge>;
  return null;
}

/** A LightVela bot shown in the chat page; it joins IM with its own identity the first time it is picked. */
export interface ConsoleBot {
  id: string;
  instanceId: string;
  name: string;
  /** The bot's own avatar as the host renders it elsewhere, at the given pixel size. */
  avatar?: (sizePx: number) => ReactNode;
}

interface AgentOption {
  key: string;
  name: string;
  bot: ConsoleBot;
  agent?: AgentItem;
}

const botKey = (instanceId: string, botId: string) => `${instanceId}/${botId}`;

/** Your LightVela bots, each with its IM identity when it already has one. */
const agentOptions = (im: VelaImController, bots: ConsoleBot[]): AgentOption[] => {
  const byBot = new Map(im.agents.filter((a) => a.state !== "deleted").map((a) => [botKey(a.instanceId, a.botId), a]));
  return bots.map((bot) => ({ key: botKey(bot.instanceId, bot.id), name: bot.name, bot, agent: byBot.get(botKey(bot.instanceId, bot.id)) }));
};

/** Resolves picked bots to IM identities; the backend gives a bot its own identity the first time (idempotent). */
async function resolveAgents(im: VelaImController, options: AgentOption[], keys: string[]): Promise<Array<{ id: string; name: string }>> {
  const connection = im.connection;
  if (!connection) throw new Error("IM 尚未连接");
  const out: Array<{ id: string; name: string }> = [];
  let provisioned = false;
  for (const key of keys) {
    const option = options.find((o) => o.key === key);
    if (!option) continue;
    if (option.agent?.state === "ready") { out.push({ id: option.agent.userId, name: option.name }); continue; }
    const agent = await connection.api.provisionBot({ instanceId: option.bot.instanceId, botId: option.bot.id, displayName: option.bot.name });
    out.push({ id: agent.userId, name: option.name });
    provisioned = true;
  }
  if (provisioned) await im.refreshAgents();
  return out;
}

const groupConversation = (group: ImGroup, name: string): ConversationItem => ({
  conversationID: `GROUP${group.tencentGroupId}`, kind: "GROUP", targetID: group.tencentGroupId, name, lastText: "", lastTime: 0, unread: 0, isPinned: false,
});

function AgentPicker({ options, selected, onChange, exclude = [] }: {
  options: AgentOption[];
  selected: string[];
  onChange: (keys: string[]) => void;
  exclude?: string[];
}) {
  const t = useT();
  const visible = options.filter((o) => !o.agent || !exclude.includes(o.agent.userId));
  const toggle = (key: string) => onChange(selected.includes(key) ? selected.filter((x) => x !== key) : [...selected, key]);
  return (
    <ul className="max-h-72 divide-y divide-black/[0.06] overflow-y-auto rounded-md border border-black/[0.08]">
      {visible.map((option) => {
        const checked = selected.includes(option.key);
        return (
          <li key={option.key}>
            <button
              type="button"
              role="checkbox"
              aria-checked={checked}
              onClick={() => toggle(option.key)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-black/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]"
            >
              <span className="inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#FCE0B5] text-black/70">{option.bot.avatar?.(28) ?? <Bot className="size-3.5" />}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-black/80">{option.name}</span>
              {option.agent ? <AgentStateBadge agent={option.agent} /> : null}
              <span className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-md border",
                checked ? "border-[var(--text-primary)] bg-[var(--text-primary)] text-white" : "border-black/15 bg-white text-transparent")}>
                <Check className="size-3" />
              </span>
            </button>
          </li>
        );
      })}
      {!visible.length ? <li className="px-3 py-5 text-center text-sm text-black/40">{t("没有可以拉入的 Agent")}</li> : null}
    </ul>
  );
}

/** New conversation with Agents: one Agent opens a single chat, several create a group. */
export function NewAgentChatDialog({ im, bots, open, onOpenChange, onOpened }: {
  im: VelaImController;
  bots: ConsoleBot[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpened: (conversation: ConversationItem) => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (open) { setSelected([]); setError(""); } }, [open]);
  const options = agentOptions(im, bots);
  const submit = async () => {
    if (!im.connection || !selected.length) return;
    setBusy(true);
    setError("");
    try {
      const agents = await resolveAgents(im, options, selected);
      if (agents.length === 1) {
        const agent = agents[0]!;
        onOpened({ conversationID: `C2C${agent.id}`, kind: "C2C", targetID: agent.id, name: agent.name, lastText: "", lastTime: 0, unread: 0, isPinned: false });
      } else {
        const name = defaultGroupName(agents.map((a) => a.name));
        const group = await im.connection.api.createGroup({ name, memberUserIds: agents.map((a) => a.id) });
        onOpened(groupConversation(group, name));
        void im.refreshConversations();
      }
      onOpenChange(false);
    } catch (err) {
      setError(errorText(err, t("创建群聊失败")));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t("关闭")}>
        <DialogHeader className="mb-5 pb-1 pr-8">
          <DialogTitle>{t("新建群聊")}</DialogTitle>
          <DialogDescription>{t("选择要一起聊天的 Agent。在群里 @ 谁，谁就回复。")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <AgentPicker options={options} selected={selected} onChange={setSelected} />
          {error ? <p role="alert" className="text-sm text-[var(--danger)]">{error}</p> : null}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-black/45">{selected.length > 1 ? t("将创建 {{count}} 个 Agent 的群聊", { count: selected.length }) : selected.length === 1 ? t("将开始单聊") : t("至少选择一个 Agent")}</p>
            <Button className="w-full rounded-lg sm:w-auto" disabled={busy || !selected.length || !im.connection} onClick={() => void submit()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Users className="size-4" />}{selected.length > 1 ? t("创建群聊") : t("开始聊天")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const contextText = (messages: IMMessage[], selfID: string, nameOf: (id: string) => string, intro: string) =>
  [intro, ...messages.slice(-CONTEXT_MESSAGES).flatMap((m) => {
    const view = describeMessage(m);
    if (view.kind !== "text" || !view.text.trim()) return [];
    return [`${m.from === selfID ? nameOf(selfID) : nameOf(String(m.from ?? ""))}：${view.text.trim()}`];
  })].join("\n");

/** "+" in a conversation: invite more Agents into a group, or turn a single chat into a group carrying recent context. */
function AddAgentsDialog({ im, bots, conversation, open, onOpenChange, onOpened, onInvited }: {
  im: VelaImController;
  bots: ConsoleBot[];
  conversation: ConversationItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpened: (conversation: ConversationItem) => void;
  onInvited: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isGroup = conversation.kind === "GROUP";
  const options = agentOptions(im, bots);
  useEffect(() => {
    if (!open || !im.connection) return;
    setSelected([]);
    setError("");
    if (isGroup) void im.connection.client.getGroupMembers(conversation.targetID).then((list) => setMembers(toMembers(list).map((m) => m.userID)), () => setMembers([]));
    else setMembers([conversation.targetID]);
  }, [open, conversation.targetID, isGroup, im.connection]);
  const submit = async () => {
    const connection = im.connection;
    if (!connection || !selected.length) return;
    setBusy(true);
    setError("");
    try {
      if (isGroup) {
        const groupId = platformGroupId(conversation.targetID);
        if (!groupId) throw new Error(t("这个群不是通过平台创建的，不能在这里拉人"));
        const agents = await resolveAgents(im, options, selected);
        for (const agent of agents) await connection.api.addGroupMember(groupId, agent.id);
        onInvited();
      } else {
        const agents = await resolveAgents(im, options, selected);
        const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? im.agents.find((a) => a.userId === id)?.displayName ?? (id === conversation.targetID ? conversation.name : id);
        const memberIDs = [conversation.targetID, ...agents.map((a) => a.id)];
        const name = defaultGroupName(memberIDs.map(agentName));
        // Agents see the carried context when they are @-mentioned in the new group.
        const group = await connection.api.createGroup({ name, memberUserIds: memberIDs, replyMode: "mention_context" });
        const history = await connection.client.getMessages(conversation.conversationID).catch(() => ({ messageList: [] as IMMessage[] }));
        const nameOf = (id: string) => (id === connection.selfID ? connection.selfName || t("我") : agentName(id));
        const context = contextText(history.messageList, connection.selfID, nameOf, t("【之前和 {{name}} 的对话】", { name: conversation.name }));
        if (context.includes("\n")) await connection.client.sendText(group.tencentGroupId, context, "GROUP").catch(() => undefined);
        onOpened(groupConversation(group, name));
        void im.refreshConversations();
      }
      onOpenChange(false);
    } catch (err) {
      setError(errorText(err, t("操作失败")));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t("关闭")}>
        <DialogHeader className="mb-5 pb-1 pr-8">
          <DialogTitle>{t("拉入更多 Agent")}</DialogTitle>
          <DialogDescription>
            {isGroup ? t("选中的 Agent 会加入这个群聊。") : t("会新建一个群聊，带上 {{name}} 和选中的 Agent，并附上你们最近的对话作为上下文。", { name: conversation.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <AgentPicker options={options} selected={selected} onChange={setSelected} exclude={members} />
          {error ? <p role="alert" className="text-sm text-[var(--danger)]">{error}</p> : null}
          <div className="flex justify-end">
            <Button className="w-full rounded-lg sm:w-auto" disabled={busy || !selected.length} onClick={() => void submit()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}{isGroup ? t("拉入群聊") : t("创建群聊")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Main area of the chat page when an Agent conversation is selected. */
export function VelaImConversationView({ im, bots, conversation, onOpen, onClose }: {
  im: VelaImController;
  bots: ConsoleBot[];
  conversation: ConversationItem;
  onOpen: (conversation: ConversationItem) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [dialog, setDialog] = useState<"add" | "settings" | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const connection = im.connection;
  const current = useMemo(() => im.conversations.find((c) => c.conversationID === conversation.conversationID) ?? conversation, [im.conversations, conversation]);
  const portrait = useMemo<VelaImPortrait>(() => {
    const byBot = new Map(bots.map((bot) => [botKey(bot.instanceId, bot.id), bot]));
    const byUser = new Map(im.agents.map((agent) => [agent.userId, byBot.get(botKey(agent.instanceId, agent.botId))]));
    return (userID, sizePx) => byUser.get(userID)?.avatar?.(sizePx) ?? null;
  }, [bots, im.agents]);
  if (!connection) {
    return <div className="flex h-full items-center justify-center text-sm text-black/45"><Loader2 className="mr-2 size-4 animate-spin" />{t("正在加载…")}</div>;
  }
  return (
    <VelaImPortraitContext.Provider value={portrait}>
    <div className="flex h-full min-h-0 flex-col">
      <VelaImChat
        key={current.conversationID}
        controller={im}
        client={connection.client}
        selfID={connection.selfID}
        conversation={current}
        refreshKey={refreshKey}
        onBack={onClose}
        onLeave={onClose}
        onOpenGroupSettings={() => setDialog("settings")}
        actions={(
          <Button size="sm" variant="outline" className="rounded-lg" onClick={() => setDialog("add")} aria-label={t("拉入更多 Agent")}>
            <Plus className="size-3.5" />{t("拉入 Agent")}
          </Button>
        )}
      />
      <AddAgentsDialog
        im={im}
        bots={bots}
        conversation={current}
        open={dialog === "add"}
        onOpenChange={(open) => setDialog(open ? "add" : null)}
        onOpened={onOpen}
        onInvited={() => setRefreshKey((n) => n + 1)}
      />
      {current.kind === "GROUP" ? (
        <GroupSettingsDialog
          open={dialog === "settings"}
          onOpenChange={(open) => { setDialog(open ? "settings" : null); if (!open) setRefreshKey((n) => n + 1); }}
          client={connection.client}
          api={connection.api}
          groupID={current.targetID}
          groupName={current.name}
          selfID={connection.selfID}
          candidates={im.agents.filter((a) => a.state === "ready").map((a) => ({ userID: a.userId, name: a.displayName, mine: true }))}
          onLeft={() => { onClose(); void im.refreshConversations(); }}
        />
      ) : null}
    </div>
    </VelaImPortraitContext.Provider>
  );
}

/** Agent conversations listed under the chat page's sessions. */
export function VelaImSessionItems({ items, selectedID, onSelect }: {
  items: ConversationItem[];
  selectedID: string | null;
  onSelect: (conversation: ConversationItem) => void;
}) {
  const t = useT();
  if (!items.length) return null;
  return (
    <>
      <li className="lv-agents-session-group-label">{t("Agent 群聊")}</li>
      {items.map((c) => (
        <li key={c.conversationID} className="lv-agents-session-item-wrap">
          <button
            type="button"
            aria-current={selectedID === c.conversationID ? "page" : undefined}
            onClick={() => onSelect(c)}
            className={cn("lv-agents-session-item lv-agents-nav-item w-full text-left", selectedID === c.conversationID && "is-active")}
          >
            <span className="lv-agents-session-title flex min-w-0 items-center gap-1.5" title={c.name}>
              {c.kind === "GROUP" ? <Users className="size-3.5 shrink-0 text-black/40" aria-hidden="true" /> : <Bot className="size-3.5 shrink-0 text-black/40" aria-hidden="true" />}
              <span className="truncate">{c.name}</span>
            </span>
            {c.unread ? <span className="ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[var(--danger)] px-1 text-[10px] text-white">{c.unread > 99 ? "99+" : c.unread}</span> : null}
          </button>
        </li>
      ))}
    </>
  );
}
