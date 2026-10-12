"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowUp, Ban, Check, ChevronDown, Copy, Loader2, MoreHorizontal, Pin, Plus, Quote, Settings2, Sparkles, Trash2, Undo2, Users, X } from "lucide-react";
import { defaultGroupPolicy, platformGroupId, policyFromGroup, type GroupReplyPolicy, type IMMessage, type MessageInput } from "@vela/im-client";
import type { VelaBrowserClient } from "@vela/im-client/browser";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChatBubble } from "@/components/ui/chat-bubble";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";
import { VelaImAvatar } from "./vela-im-avatar";
import { FileTypeIcon, formatBytes } from "./vela-im-files";
import { VelaImMessageContent } from "./vela-im-message";
import {
  agentStatus,
  applyRevoked,
  bundleOf,
  describeMessage,
  errorText,
  formatTime,
  fullTime,
  groupDismissal,
  isAgentID,
  isGroupGoneError,
  mergeMessages,
  messageAbstract,
  quoteData,
  quotedMessage,
  resolveMentions,
  timeDivider,
  toMembers,
  type GroupDismissal,
  type QuotedMessage,
  type ConversationItem,
  type MemberItem,
  type MessageView,
} from "./vela-im-model";
import type { VelaImController } from "./use-vela-im";

const REVOKE_WINDOW_SECONDS = 120;

const dismissalTitle = (dismissal: GroupDismissal, t: ReturnType<typeof useT>) =>
  dismissal.by === "admin" ? t("该群聊已被管理员解散") : dismissal.by === "owner" ? t("该群聊已被群主解散") : t("该群聊已解散");

/** Takes the composer's place once the group is gone; an admin's reason is shown to every member. */
function GroupDismissedNotice({ dismissal }: { dismissal: GroupDismissal }) {
  const t = useT();
  return (
    <div role="status" className="flex items-start gap-3 rounded-2xl border border-black/[0.08] bg-black/[0.02] px-4 py-3 text-sm">
      <Ban className="mt-0.5 size-4 shrink-0 text-black/40" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-black/75">{dismissalTitle(dismissal, t)}</p>
        {dismissal.reason ? <p className="whitespace-pre-wrap break-words text-black/60">{t("原因：{{reason}}", { reason: dismissal.reason })}</p> : null}
        <p className="text-xs text-black/45">{t("无法继续发送消息，历史消息仍可查看。如有疑问，请联系管理员。")}</p>
      </div>
    </div>
  );
}
/** Picker entry for @everyone; inserting `@所有人` is what resolveMentions turns into Tencent's @all. */
const MENTION_ALL_ID = "@all";
const MENTION_ALL_TEXT = "所有人";
const MAX_ATTACHMENTS = 9;
/** Hermes commands offered by the command menu, the same set as the Agent's direct chat. */
const COMMANDS = ["new", "compress", "status", "usage", "stop", "help"] as const;

interface PendingAttachment {
  id: string;
  file: File;
  /** Object URL for image thumbnails; revoked once the attachment leaves the composer. */
  preview?: string;
}

const attachmentKind = (file: File): MessageInput["type"] =>
  file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "file";

/** The `@token` being typed at the caret, if any. */
const mentionQuery = (text: string, caret: number): string | null => {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return match ? match[1] ?? "" : null;
};

export function VelaImChat({ controller, client, selfID, conversation, onBack, onOpenGroupSettings, onLeave, refreshKey, actions }: {
  controller: VelaImController;
  client: VelaBrowserClient;
  selfID: string;
  conversation: ConversationItem;
  onBack: () => void;
  onOpenGroupSettings: () => void;
  onLeave: () => void;
  refreshKey: number;
  /** Extra header actions, e.g. pulling more Agents in. */
  actions?: ReactNode;
}) {
  const t = useT();
  const isGroup = conversation.kind === "GROUP";
  const [messages, setMessages] = useState<IMMessage[]>([]);
  const [nextPage, setNextPage] = useState<string | undefined>();
  const [complete, setComplete] = useState(true);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [activeMention, setActiveMention] = useState(0);
  const [quoting, setQuoting] = useState<QuotedMessage | null>(null);
  /** Who each inserted `@name` means; members can share a display name. */
  const [picked, setPicked] = useState<Array<{ userID: string; name: string }>>([]);
  const [copiedID, setCopiedID] = useState<string | null>(null);
  const [highlightID, setHighlightID] = useState<string | null>(null);
  const [dismissedMention, setDismissedMention] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [policy, setPolicy] = useState<GroupReplyPolicy | null>(null);
  const [dismissal, setDismissal] = useState<GroupDismissal | null>(null);
  const [dismissalOpen, setDismissalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const pendingRef = useRef<PendingAttachment[]>([]);
  pendingRef.current = pending;
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const conversationID = conversation.conversationID;
  const ready = controller.status === "ready";

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setLoading(true);
    setError("");
    setText("");
    setQuoting(null);
    setPicked([]);
    setPending((old) => { old.forEach((item) => item.preview && URL.revokeObjectURL(item.preview)); return []; });
    void client.getMessages(conversationID).then(async (page) => {
      if (cancelled) return;
      setMessages(mergeMessages([], page.messageList.filter((m) => !agentStatus(m))));
      setNextPage(page.nextReqMessageID);
      setComplete(page.isCompleted);
      await client.markRead(conversationID).catch(() => undefined);
    }, (e: unknown) => { if (!cancelled) setError(errorText(e, t("读取消息失败"))); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, conversationID, t]);

  const loadGroup = useCallback(() => {
    const api = controller.connection?.api;
    const groupId = platformGroupId(conversation.targetID);
    return groupId && api ? api.group(groupId).catch(() => null) : Promise.resolve(null);
  }, [controller.connection, conversation.targetID]);

  useEffect(() => {
    setDismissal(null);
    if (!isGroup) { setMembers([]); setPolicy(null); return; }
    let cancelled = false;
    // A dismissed group is gone from Tencent, so its member list fails while the platform still knows why.
    void Promise.all([client.getGroupMembers(conversation.targetID).catch(() => []), loadGroup()]).then(([list, group]) => {
      if (cancelled) return;
      setMembers(toMembers(list));
      setPolicy(group ? policyFromGroup(group) : defaultGroupPolicy(conversation.targetID));
      setDismissal(groupDismissal(group));
    });
    return () => { cancelled = true; };
  }, [client, loadGroup, conversation.targetID, isGroup, refreshKey]);

  useEffect(() => {
    controller.events.current = {
      onMessages: (incoming) => {
        const mine = incoming.filter((m) => m.conversationID === conversationID);
        if (!mine.length) return;
        setMessages((old) => mergeMessages(old, mine));
        void client.markRead(conversationID).catch(() => undefined);
      },
      onModified: (changed) => setMessages((old) => old.map((m) => changed.find((n) => n.ID === m.ID) ?? m)),
      onRevoked: (revoked) => setMessages((old) => applyRevoked(old, revoked)),
    };
    return () => { controller.events.current = {}; };
  }, [client, controller.events, conversationID]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }); }, [messages.length, conversationID]);
  useEffect(() => () => { pendingRef.current.forEach((item) => item.preview && URL.revokeObjectURL(item.preview)); }, []);
  const working = controller.working[conversationID] ?? {};
  const anyWorking = Object.keys(working).length > 0;

  const loadEarlier = async () => {
    try {
      const page = await client.getMessages(conversationID, { nextReqMessageID: nextPage });
      setMessages((old) => mergeMessages(old, page.messageList.filter((m) => !agentStatus(m))));
      setNextPage(page.nextReqMessageID);
      setComplete(page.isCompleted);
    } catch (e) {
      setError(errorText(e, t("读取消息失败")));
    }
  };

  const others = useMemo(() => members.filter((m) => m.userID !== selfID), [members, selfID]);
  const query = isGroup ? mentionQuery(text, caret) : null;
  const mentionKey = query === null ? null : `${caret}:${query}`;
  useEffect(() => { setActiveMention(0); }, [mentionKey]);
  const mentionAll = others.length > 1 && query !== null && `${MENTION_ALL_TEXT} all ${t("所有人")}`.toLowerCase().includes(query.toLowerCase());
  const suggestions = query === null || mentionKey === dismissedMention ? [] : [
    ...(mentionAll ? [{ userID: MENTION_ALL_ID, name: t("所有人") }] : []),
    ...others.filter((m) => `${m.name} ${m.userID}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(isAgentID(b.userID)) - Number(isAgentID(a.userID))).slice(0, 6),
  ];
  const mentionText = (m: { userID: string; name: string }) => (m.userID === MENTION_ALL_ID ? MENTION_ALL_TEXT : m.name);

  const pick = (userID: string | undefined, name: string) => {
    if (userID && userID !== MENTION_ALL_ID) setPicked((old) => [...old.filter((p) => p.userID !== userID), { userID, name }]);
  };
  const insertMention = useCallback((name: string, userID?: string) => {
    if (userID && userID !== MENTION_ALL_ID) setPicked((old) => [...old.filter((p) => p.userID !== userID), { userID, name }]);
    const before = text.slice(0, caret).replace(/@[^\s@]*$/, `@${name} `);
    const next = before + text.slice(caret);
    setText(next);
    setCaret(before.length);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(before.length, before.length);
    });
  }, [caret, text]);

  const deliver = async (input: MessageInput): Promise<IMMessage | undefined> => {
    const result = await client.send(input);
    const sent = (result as { data?: { message?: IMMessage } }).data?.message;
    if (sent) setMessages((old) => mergeMessages(old, [sent]));
    return sent;
  };

  const addFiles = (files: File[]) => {
    if (!files.length) return;
    setPending((old) => {
      const room = Math.max(0, MAX_ATTACHMENTS - old.length);
      if (files.length > room) setError(t("一次最多发送 {{count}} 个附件", { count: MAX_ATTACHMENTS }));
      return [...old, ...files.slice(0, room).map((file) => ({
        id: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`,
        file,
        ...(file.type.startsWith("image/") ? { preview: URL.createObjectURL(file) } : {}),
      }))];
    });
  };
  const removePending = (id: string) => setPending((old) => old.filter((item) => {
    if (item.id === id && item.preview) URL.revokeObjectURL(item.preview);
    return item.id !== id;
  }));

  /** Attachments go first, each as its own message, then the text; a failure keeps what was not sent. */
  const submit = async () => {
    const body = text.trim();
    if ((!body && !pending.length) || sending) return;
    setSending(true);
    setError("");
    const conversationType = isGroup ? "GROUP" : "C2C";
    // Tencent's web SDK sends one element per message, so attachments typed with text share a bundle id.
    const bundle = body && pending.length ? crypto.randomUUID() : null;
    const parts: string[] = [];
    try {
      for (const item of pending) {
        const sent = await deliver({
          to: conversation.targetID, conversationType, type: attachmentKind(item.file), payload: { file: item.file },
          ...(bundle ? { cloudCustomData: JSON.stringify({ velaBundle: bundle }) } : {}),
        });
        if (sent?.ID) parts.push(sent.ID);
        removePending(item.id);
      }
      if (body) {
        const atUserList = isGroup ? resolveMentions(body, others, picked) : [];
        const custom = { ...(quoting ? quoteData(quoting) : {}), ...(bundle ? { velaBundle: bundle, velaBundleParts: parts } : {}) };
        await deliver({
          to: conversation.targetID,
          conversationType,
          type: atUserList.length ? "textAt" : "text",
          payload: atUserList.length ? { text: body, atUserList } : { text: body },
          ...(Object.keys(custom).length ? { cloudCustomData: JSON.stringify(custom) } : {}),
        });
        setText("");
        setQuoting(null);
        setPicked([]);
      }
    } catch (e) {
      if (isGroup && isGroupGoneError(e)) {
        setDismissal(groupDismissal(await loadGroup()) ?? { by: null, reason: "" });
        setDismissalOpen(true);
      } else {
        setError(errorText(e, t("发送失败")));
      }
    } finally {
      setSending(false);
    }
  };

  const commandLabels: Record<(typeof COMMANDS)[number], string> = {
    new: t("新建会话"), compress: t("压缩上下文"), status: t("查看状态"), usage: t("查看用量"), stop: t("停止当前任务"), help: t("全部指令"),
  };
  const insertCommand = (name: string) => {
    setCommandsOpen(false);
    const command = `/${name} `;
    // In a group a command goes to one Agent: open the @ picker in front of it first.
    if (isGroup && !resolveMentions(text, others, picked).some(isAgentID)) {
      setText(`@ ${command}`);
      setCaret(1);
      setDismissedMention(null);
      requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(1, 1); });
      return;
    }
    const next = text.trim() ? `${text.trimEnd()} ${command}` : command;
    setText(next);
    setCaret(next.length);
    requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(next.length, next.length); });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length && !e.nativeEvent.isComposing) {
      const active = suggestions[Math.min(activeMention, suggestions.length - 1)];
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActiveMention((i) => (i + step + suggestions.length) % suggestions.length);
        return;
      }
      if (active && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
        e.preventDefault();
        insertMention(mentionText(active), active.userID);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedMention(mentionKey);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const revoke = async (message: IMMessage, attachments: IMMessage[] = []) => {
    try {
      for (const part of attachments) if (!part.isRevoked) await client.revokeMessage(part);
      await client.revokeMessage(message);
      const gone = new Set([message.ID, ...attachments.map((part) => part.ID)]);
      setMessages((old) => old.map((m) => (gone.has(m.ID) ? { ...m, isRevoked: true } : m)));
    } catch (e) {
      setError(errorText(e, t("撤回失败")));
    }
  };

  const copy = (message: IMMessage, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedID(message.ID);
      setTimeout(() => setCopiedID((id) => (id === message.ID ? null : id)), 1500);
    }, () => setError(t("复制失败")));
  };
  const quote = (message: IMMessage) => {
    const sender = message.from === selfID ? t("我") : nameOf(message);
    setQuoting({ messageID: message.ID, sender, abstract: messageAbstract(message) });
    // In a group the quoted Agent only answers when it is mentioned.
    if (isGroup && message.from && isAgentID(message.from) && !picked.some((p) => p.userID === message.from)) {
      pick(message.from, sender);
      setText((v) => `@${sender} ${v}`);
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const jumpTo = (messageID: string) => {
    const element = document.getElementById(`vela-im-msg-${messageID}`);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightID(messageID);
    setTimeout(() => setHighlightID((id) => (id === messageID ? null : id)), 1600);
  };

  const memberName = (id: string) => members.find((x) => x.userID === id)?.name || id;
  const who = (id: string) => (id === selfID ? t("你") : `“${memberName(id)}”`);
  /** Group notices read like a chat app's system line, e.g. “你 邀请 “A”、“B” 加入了群聊”. */
  const systemLine = (view: Extract<MessageView, { kind: "event" | "tip" }>): string => {
    if (view.kind === "tip") return view.text || t("群成员有变动");
    const targets = view.targets.map(who).join("、");
    switch (view.event) {
      case "created": return t("{{who}} 创建了群聊", { who: who(view.operator) });
      case "joined": return view.operator && !view.targets.includes(view.operator)
        ? t("{{who}} 邀请 {{targets}} 加入了群聊", { who: who(view.operator), targets })
        : t("{{targets}} 加入了群聊", { targets });
      case "quit": return t("{{targets}} 退出了群聊", { targets });
      case "kicked": return t("{{who}} 将 {{targets}} 移出了群聊", { who: who(view.operator), targets });
      case "admin_set": return t("{{targets}} 成为管理员", { targets });
      case "admin_canceled": return t("{{targets}} 不再是管理员", { targets });
      case "reply_mode_changed": return t("Agent 回复规则已改为：{{mode}}", {
        mode: ({ mention: t("仅在被 @ 时回复"), mention_context: t("被 @ 时回复，并参考前 10 条消息"), all: t("回复每条消息") } as Record<string, string>)[view.operator] ?? view.operator,
      });
      default: return t("{{who}} 修改了群资料", { who: who(view.operator) });
    }
  };
  const nameOf = (m: IMMessage) => {
    const member = members.find((x) => x.userID === m.from);
    return member?.name || String(m.nick || m.from || "");
  };
  const now = Math.floor(Date.now() / 1000);
  /** Attachments shown inside the text they were sent with, keyed by that text's message ID. */
  const { visible, attachmentsOf } = useMemo(() => {
    const byID = new Map(messages.map((m) => [m.ID, m]));
    const owned = new Map<string, IMMessage[]>();
    const hidden = new Set<string>();
    for (const m of messages) {
      const parts = bundleOf(m)?.parts?.map((id) => byID.get(id)).filter((part): part is IMMessage => !!part) ?? [];
      if (!parts.length) continue;
      owned.set(m.ID, parts);
      parts.forEach((part) => hidden.add(part.ID));
    }
    return { visible: messages.filter((m) => !hidden.has(m.ID)), attachmentsOf: owned };
  }, [messages]);
  const peerIsAgent = !isGroup && isAgentID(conversation.targetID);
  const botOnly = !!policy?.members.length && policy.members.every((m) => m.kind === "bot");
  const subtitle = isGroup
    ? [botOnly ? t("纯 Agent 群") : t("人机群"), t("{{count}} 位成员", { count: policy?.members.length || members.length }),
      policy ? ({ mention: t("@ 时回复"), mention_context: t("@ 时回复并参考上下文"), all: t("每条消息回复") }[policy.effectiveMode]) : ""].filter(Boolean).join(" · ")
    : peerIsAgent ? "Agent" : t("人类");

  return (
    <div className="relative flex h-full min-h-0 flex-col"
      onDragOver={(e) => { if (ready && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}>
      {dragging ? (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-black/20 bg-white/80 text-sm font-medium text-black/55">
          {t("松开即可添加附件")}
        </div>
      ) : null}
      <header className="flex items-center gap-3 border-b border-black/[0.06] px-4 py-3">
        <button type="button" onClick={onBack} aria-label={t("返回会话列表")} className="-ml-1 inline-flex size-9 items-center justify-center rounded-lg text-black/55 hover:bg-black/[0.04] md:hidden">
          <ArrowLeft className="size-4" />
        </button>
        <VelaImAvatar name={conversation.name} seed={conversation.targetID} kind={isGroup ? "group" : peerIsAgent ? "agent" : "human"} />
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 truncate text-[15px] font-semibold text-black/85">
            <span className="truncate">{conversation.name}</span>
            {peerIsAgent ? <Badge variant="warning">Agent</Badge> : null}
          </h2>
          <p className="truncate text-xs text-black/45">{subtitle}</p>
        </div>
        {actions}
        {isGroup ? (
          <Button size="sm" variant="outline" className="rounded-lg" onClick={onOpenGroupSettings}>
            <Settings2 className="size-3.5" />{t("群管理")}
          </Button>
        ) : null}
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <button type="button" aria-label={t("会话操作")} className="inline-flex size-9 items-center justify-center rounded-lg text-black/55 hover:bg-black/[0.04]">
              <MoreHorizontal className="size-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-48 rounded-xl border border-black/10 p-1.5 shadow-xl">
            <button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-black/75 hover:bg-black/[0.04]"
              onClick={() => { setMenuOpen(false); void client.pinConversation(conversationID, !conversation.isPinned).then(() => controller.refreshConversations()).catch((e: unknown) => setError(errorText(e, t("操作失败")))); }}>
              <Pin className="size-4" />{conversation.isPinned ? t("取消置顶") : t("置顶会话")}
            </button>
            <button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[var(--danger)] hover:bg-black/[0.04]"
              onClick={() => { setMenuOpen(false); void client.deleteConversation(conversationID).then(() => { onLeave(); void controller.refreshConversations(); }).catch((e: unknown) => setError(errorText(e, t("操作失败")))); }}>
              <Trash2 className="size-4" />{t("从列表移除")}
            </button>
          </PopoverContent>
        </Popover>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[color-mix(in_oklab,var(--surface-muted)_45%,white)] px-4 py-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        {!complete && messages.length ? (
          <div className="flex justify-center">
            <button type="button" onClick={() => void loadEarlier()} className="inline-flex h-8 min-w-28 items-center justify-center gap-1.5 rounded-full border border-black/[0.08] bg-transparent px-3 text-xs font-semibold text-black/60 transition-colors hover:border-black/15 hover:text-black/80">
              {t("加载更早的消息")}
            </button>
          </div>
        ) : null}
        {loading ? <p role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-black/45"><Loader2 className="size-4 animate-spin" />{t("正在加载消息…")}</p> : null}
        {!loading && !messages.length ? (
          <div className="py-16 text-center">
            <p className="text-sm font-medium text-black/70">{t("说声你好吧")}</p>
            <p className="mt-1 text-xs text-black/45">{isGroup ? t("在群里输入 @ 可以点名某个 Agent 或成员。") : peerIsAgent ? t("Agent 会像真人一样回复你。") : t("消息会实时送达对方的所有设备。")}</p>
          </div>
        ) : null}
        {visible.map((m, index) => {
          const mine = m.from === selfID;
          const view = describeMessage(m);
          const divider = timeDivider(visible[index - 1], m);
          const attachments = attachmentsOf.get(m.ID) ?? [];
          const dividerLine = divider ? <p className="text-center text-[11px] text-black/35">{divider}</p> : null;
          if (view.kind === "event" || view.kind === "tip") {
            return <Fragment key={m.ID}>{dividerLine}<p className="px-6 text-center text-xs leading-5 text-black/40">{systemLine(view)}</p></Fragment>;
          }
          const at = Number(m.time ?? 0);
          const canRevoke = mine && !m.isRevoked && now - at < REVOKE_WINDOW_SECONDS;
          const quoted = m.isRevoked ? null : quotedMessage(m);
          const copyText = m.isRevoked ? "" : view.kind === "text" ? view.text : view.kind === "custom" ? view.description : "";
          const bare = !quoted && (view.kind === "image" || view.kind === "video" || view.kind === "file");
          const action = "inline-flex items-center gap-1 rounded px-1 opacity-0 transition-opacity hover:text-black/70 focus-visible:opacity-100 group-hover:opacity-100";
          return (
            <Fragment key={m.ID}>
              {dividerLine}
              <div id={`vela-im-msg-${m.ID}`} className={cn("group flex items-start gap-2.5", mine && "flex-row-reverse")}>
                {!mine ? <VelaImAvatar name={nameOf(m)} seed={m.from} kind={isAgentID(m.from) ? "agent" : "human"} size="sm" /> : null}
                <div className={cn("flex min-w-0 max-w-[78%] flex-col gap-1", mine && "items-end")}>
                  {!mine ? (
                    <span className="flex h-7 items-center gap-1.5 px-1 text-xs text-black/45">
                      <span className="font-medium text-black/60">{nameOf(m)}</span>
                      {isAgentID(m.from) ? <Badge variant="warning" className="px-1.5 py-0.5 text-[10px]">Agent</Badge> : null}
                      <time title={fullTime(at)}>{formatTime(at)}</time>
                    </span>
                  ) : null}
                  {attachments.length ? (
                    <div className={cn("flex max-w-full flex-col gap-1.5", mine && "items-end")}>
                      {attachments.map((part) => (
                        <div key={part.ID} id={`vela-im-msg-${part.ID}`} className="max-w-full"><VelaImMessageContent message={part} /></div>
                      ))}
                    </div>
                  ) : null}
                  {bare ? (
                    <div className={cn("max-w-full rounded-xl transition-shadow", highlightID === m.ID && "ring-2 ring-[var(--ring)]")}>
                      <VelaImMessageContent message={m} />
                    </div>
                  ) : (
                  <ChatBubble tone={mine ? "system" : "assistant"}
                    className={cn("max-w-full px-3.5 py-2 transition-shadow", mine && "ml-0 border-[#dbe3fb] bg-[#eef2fe] text-black/80", highlightID === m.ID && "ring-2 ring-[var(--ring)]")}>
                    {quoted ? (
                      <button type="button" onClick={() => jumpTo(quoted.messageID)}
                        className="mb-1.5 block w-full max-w-full rounded-md border-l-2 border-black/20 bg-black/[0.04] px-2 py-1 text-left text-xs text-black/55">
                        <span className="font-medium">{quoted.sender}</span>：<span className="break-words">{quoted.abstract}</span>
                      </button>
                    ) : null}
                    <VelaImMessageContent message={m} />
                  </ChatBubble>
                  )}
                  <span className={cn("flex items-center gap-1.5 px-1 text-[11px] text-black/40", mine && "flex-row-reverse")}>
                    {mine ? <time title={fullTime(at)}>{formatTime(at)}</time> : null}
                    {mine && !isGroup && !peerIsAgent && !m.isRevoked ? <span>{m.isPeerRead ? t("已读") : t("未读")}</span> : null}
                    {copyText ? (
                      <button type="button" onClick={() => copy(m, copyText)} className={action} aria-label={t("复制")}>
                        {copiedID === m.ID ? <Check className="size-3" /> : <Copy className="size-3" />}{copiedID === m.ID ? t("已复制") : t("复制")}
                      </button>
                    ) : null}
                    {!m.isRevoked ? (
                      <button type="button" onClick={() => quote(m)} className={action} aria-label={t("引用")}>
                        <Quote className="size-3" />{t("引用")}
                      </button>
                    ) : null}
                    {canRevoke ? (
                      <button type="button" onClick={() => void revoke(m, attachments)} className={action}>
                        <Undo2 className="size-3" />{t("撤回")}
                      </button>
                    ) : null}
                  </span>
                </div>
              </div>
            </Fragment>
          );
        })}
        <div ref={bottomRef} />
      </div>
      </div>

      <div className="bg-[color-mix(in_oklab,var(--surface-muted)_45%,white)] px-4 pb-4 pt-1">
      <div className="mx-auto w-full max-w-3xl">
        {anyWorking ? (
          <p role="status" aria-live="polite" className="mb-2 flex items-center gap-2 px-1 text-xs text-black/50">
            <span aria-hidden="true" className="inline-flex items-end gap-[3px] text-[var(--brand-600,#4f46e5)]">
              <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-current" />
            </span>
            {t("{{names}} 正在处理…", { names: Object.keys(working).map((id) => (isGroup ? memberName(id) : conversation.name)).join("、") })}
          </p>
        ) : null}
        {dismissal ? <GroupDismissedNotice dismissal={dismissal} /> : (<>
        {isGroup && others.some((m) => isAgentID(m.userID)) ? (
          <div className="mb-2 flex flex-wrap gap-1.5" aria-label={t("快速 @ Agent")}>
            {others.length > 1 ? (
              <button type="button" onClick={() => { setText((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}@${MENTION_ALL_TEXT} `); textareaRef.current?.focus(); }}
                className="inline-flex h-7 items-center rounded-full border border-black/[0.08] bg-white px-2.5 text-xs text-black/60 hover:border-black/15 hover:text-black/80">
                @{t("所有人")}
              </button>
            ) : null}
            {others.filter((m) => isAgentID(m.userID)).map((m) => (
              <button key={m.userID} type="button" onClick={() => { pick(m.userID, m.name); setText((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}@${m.name} `); textareaRef.current?.focus(); }}
                className="inline-flex h-7 items-center rounded-full border border-black/[0.08] bg-white px-2.5 text-xs text-black/60 hover:border-black/15 hover:text-black/80">
                @{m.name}
              </button>
            ))}
          </div>
        ) : null}
        <div className="relative rounded-2xl border border-black/[0.08] bg-white shadow-[0_1px_1px_rgba(0,0,0,0.04),0_9px_30px_-14px_rgba(0,0,0,0.34)]">
          {suggestions.length ? (
            <ul id="vela-im-mentions" role="listbox" aria-label={t("提及成员")} className="absolute bottom-[calc(100%+6px)] left-0 z-10 w-64 rounded-xl border border-black/10 bg-white p-1.5 shadow-xl">
              {suggestions.map((m, index) => (
                <li key={m.userID}>
                  <button id={`vela-im-mention-${index}`} type="button" role="option" aria-selected={index === activeMention} tabIndex={-1}
                    onMouseEnter={() => setActiveMention(index)} onMouseDown={(e) => { e.preventDefault(); insertMention(mentionText(m), m.userID); }}
                    className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-black/75", index === activeMention && "bg-black/[0.05]")}>
                    {m.userID === MENTION_ALL_ID ? (
                      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-black/[0.06] text-black/60"><Users className="size-4" /></span>
                    ) : <VelaImAvatar name={m.name} seed={m.userID} kind={isAgentID(m.userID) ? "agent" : "human"} size="sm" />}
                    <span className="truncate">{m.name}</span>
                    {m.userID === MENTION_ALL_ID ? <span className="ml-auto text-xs text-black/40">{t("{{count}} 位成员", { count: others.length })}</span>
                      : isAgentID(m.userID) ? <Badge variant="warning" className="ml-auto">Agent</Badge> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {quoting ? (
            <div className="mx-2 mt-2 flex items-center gap-2 rounded-lg bg-black/[0.04] px-3 py-2 text-xs text-black/60">
              <Quote className="size-3.5 shrink-0 text-black/40" />
              <span className="min-w-0 flex-1 truncate"><span className="font-medium">{quoting.sender}</span>：{quoting.abstract}</span>
              <button type="button" onClick={() => setQuoting(null)} aria-label={t("取消引用")} className="inline-flex size-6 items-center justify-center rounded-md text-black/45 hover:bg-black/[0.06] hover:text-black/70">
                <X className="size-3.5" />
              </button>
            </div>
          ) : null}
          {pending.length ? (
            <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label={t("待发送的附件")}>
              {pending.map((item) => (
                <li key={item.id} className="group/att relative">
                  {item.preview ? (
                    <img src={item.preview} alt={item.file.name} className="size-16 rounded-lg border border-black/[0.08] object-cover" />
                  ) : (
                    <span className="flex h-16 w-52 items-center gap-2.5 rounded-lg border border-black/[0.08] bg-black/[0.02] px-2.5">
                      <FileTypeIcon name={item.file.name} />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-black/75" title={item.file.name}>{item.file.name}</span>
                        <span className="block text-[11px] text-black/40">{formatBytes(item.file.size)}</span>
                      </span>
                    </span>
                  )}
                  <button type="button" onClick={() => removePending(item.id)} aria-label={t("移除 {{name}}", { name: item.file.name })}
                    className="absolute -right-1.5 -top-1.5 inline-flex size-5 items-center justify-center rounded-full bg-black/70 text-white opacity-90 hover:bg-black">
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <Textarea
            ref={textareaRef}
            aria-label={t("消息内容")}
            aria-autocomplete="list"
            aria-controls={suggestions.length ? "vela-im-mentions" : undefined}
            aria-expanded={suggestions.length > 0}
            aria-activedescendant={suggestions.length ? `vela-im-mention-${Math.min(activeMention, suggestions.length - 1)}` : undefined}
            rows={1}
            value={text}
            disabled={!ready}
            placeholder={isGroup ? t("告诉我们想做什么") : t("告诉我接下来想做点什么")}
            onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            onPaste={(e) => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); addFiles(files); } }}
            className="max-h-48 min-h-11 resize-none border-0 bg-transparent px-3.5 pb-1 pt-3 leading-6 shadow-none [field-sizing:content] focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <div className="flex items-center gap-1.5 px-2 pb-2">
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; addFiles(files); }} />
            <button type="button" aria-label={t("添加图片或文件")} disabled={!ready || sending} onClick={() => fileRef.current?.click()}
              className="inline-flex size-7 items-center justify-center rounded-full text-black/55 transition-colors hover:bg-black/[0.05] hover:text-black/80 disabled:opacity-40">
              <Plus className="size-4" />
            </button>
            <Popover open={commandsOpen} onOpenChange={setCommandsOpen}>
              <PopoverTrigger asChild>
                <button type="button" disabled={!ready} aria-label={t("指令库")}
                  className="inline-flex h-7 items-center gap-1 rounded-full border border-black/[0.08] px-2 text-xs text-black/60 transition-colors hover:border-black/15 hover:text-black/80 disabled:opacity-40">
                  <Sparkles className="size-3.5" />{t("指令库")}<ChevronDown className="size-3" />
                </button>
              </PopoverTrigger>
              <PopoverContent side="top" align="start" className="w-60 rounded-xl border border-black/10 p-1.5 shadow-xl">
                {COMMANDS.map((command) => (
                  <button key={command} type="button" onClick={() => insertCommand(command)}
                    className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-black/[0.04]">
                    <span className="w-20 shrink-0 font-mono text-[13px] text-black/80">/{command}</span>
                    <span className="truncate text-black/50">{commandLabels[command]}</span>
                  </button>
                ))}
              </PopoverContent>
            </Popover>
            <Button type="button" className="ml-auto size-8 shrink-0 rounded-full p-0" aria-label={t("发送")}
              disabled={!ready || sending || (!text.trim() && !pending.length)} onClick={() => void submit()}>
              {sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
            </Button>
          </div>
        </div>
        </>)}
        {error ? <p role="alert" className="mt-2 text-xs text-[var(--danger)]">{error}</p> : null}
      </div>
      </div>
      {dismissal ? (
        <Dialog open={dismissalOpen} onOpenChange={setDismissalOpen}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>{dismissalTitle(dismissal, t)}</DialogTitle>
              <DialogDescription className="space-y-1">
                {dismissal.reason ? <span className="block whitespace-pre-wrap break-words">{t("原因：{{reason}}", { reason: dismissal.reason })}</span> : null}
                <span className="block">{t("消息没有发出。如有疑问，请联系管理员。")}</span>
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end">
              <Button type="button" className="rounded-lg" onClick={() => setDismissalOpen(false)}>{t("我知道了")}</Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
