"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowUp, Check, Copy, Loader2, MoreHorizontal, Paperclip, Pin, Quote, Settings2, Trash2, Undo2, Users, X } from "lucide-react";
import { defaultGroupPolicy, platformGroupId, policyFromGroup, type GroupReplyPolicy, type IMMessage, type MessageInput } from "@vela/im-client";
import type { VelaBrowserClient } from "@vela/im-client/browser";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChatBubble } from "@/components/ui/chat-bubble";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";
import { VelaImAvatar } from "./vela-im-avatar";
import { VelaImMessageContent } from "./vela-im-message";
import {
  applyRevoked,
  describeMessage,
  errorText,
  formatTime,
  fullTime,
  isAgentID,
  mergeMessages,
  messageAbstract,
  quoteCustomData,
  quotedMessage,
  resolveMentions,
  timeDivider,
  toMembers,
  type QuotedMessage,
  type ConversationItem,
  type MemberItem,
  type MessageView,
} from "./vela-im-model";
import type { VelaImController } from "./use-vela-im";

const REVOKE_WINDOW_SECONDS = 120;
/** Picker entry for @everyone; inserting `@所有人` is what resolveMentions turns into Tencent's @all. */
const MENTION_ALL_ID = "@all";
const MENTION_ALL_TEXT = "所有人";

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
  const [copiedID, setCopiedID] = useState<string | null>(null);
  const [highlightID, setHighlightID] = useState<string | null>(null);
  const [dismissedMention, setDismissedMention] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [policy, setPolicy] = useState<GroupReplyPolicy | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
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
    void client.getMessages(conversationID).then(async (page) => {
      if (cancelled) return;
      setMessages(mergeMessages([], page.messageList));
      setNextPage(page.nextReqMessageID);
      setComplete(page.isCompleted);
      await client.markRead(conversationID).catch(() => undefined);
    }, (e: unknown) => { if (!cancelled) setError(errorText(e, t("读取消息失败"))); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, conversationID, t]);

  useEffect(() => {
    if (!isGroup) { setMembers([]); setPolicy(null); return; }
    let cancelled = false;
    const api = controller.connection?.api;
    const groupId = platformGroupId(conversation.targetID);
    const rules = groupId && api
      ? api.group(groupId).then(policyFromGroup, () => defaultGroupPolicy(conversation.targetID))
      : Promise.resolve(defaultGroupPolicy(conversation.targetID));
    void Promise.all([client.getGroupMembers(conversation.targetID), rules]).then(([list, reply]) => {
      if (cancelled) return;
      setMembers(toMembers(list));
      setPolicy(reply);
    }, () => undefined);
    return () => { cancelled = true; };
  }, [client, controller.connection, conversation.targetID, isGroup, refreshKey]);

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

  const loadEarlier = async () => {
    try {
      const page = await client.getMessages(conversationID, { nextReqMessageID: nextPage });
      setMessages((old) => mergeMessages(old, page.messageList));
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

  const insertMention = useCallback((name: string) => {
    const before = text.slice(0, caret).replace(/@[^\s@]*$/, `@${name} `);
    const next = before + text.slice(caret);
    setText(next);
    setCaret(before.length);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(before.length, before.length);
    });
  }, [caret, text]);

  const deliver = async (input: MessageInput) => {
    setSending(true);
    setError("");
    try {
      const result = await client.send(input);
      const sent = (result as { data?: { message?: IMMessage } }).data?.message;
      if (sent) setMessages((old) => mergeMessages(old, [sent]));
      return true;
    } catch (e) {
      setError(errorText(e, t("发送失败")));
      return false;
    } finally {
      setSending(false);
    }
  };

  const sendText = async () => {
    const body = text.trim();
    if (!body || sending) return;
    const atUserList = isGroup ? resolveMentions(body, others) : [];
    const ok = await deliver({
      to: conversation.targetID,
      conversationType: conversation.kind === "GROUP" ? "GROUP" : "C2C",
      type: atUserList.length ? "textAt" : "text",
      payload: atUserList.length ? { text: body, atUserList } : { text: body },
      ...(quoting ? { cloudCustomData: quoteCustomData(quoting) } : {}),
    });
    if (ok) {
      setText("");
      setQuoting(null);
    }
  };

  const sendFile = async (file: File) => {
    await deliver({ to: conversation.targetID, conversationType: isGroup ? "GROUP" : "C2C", type: attachmentKind(file), payload: { file } });
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
        insertMention(mentionText(active));
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
      void sendText();
    }
  };

  const revoke = async (message: IMMessage) => {
    try {
      await client.revokeMessage(message);
      setMessages((old) => old.map((m) => (m.ID === message.ID ? { ...m, isRevoked: true } : m)));
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
    if (isGroup && message.from && isAgentID(message.from) && !text.includes(`@${sender}`)) setText((v) => `@${sender} ${v}`);
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
  const peerIsAgent = !isGroup && isAgentID(conversation.targetID);
  const botOnly = !!policy?.members.length && policy.members.every((m) => m.kind === "bot");
  const subtitle = isGroup
    ? [botOnly ? t("纯 Agent 群") : t("人机群"), t("{{count}} 位成员", { count: policy?.members.length || members.length }),
      policy ? ({ mention: t("@ 时回复"), mention_context: t("@ 时回复并参考上下文"), all: t("每条消息回复") }[policy.effectiveMode]) : ""].filter(Boolean).join(" · ")
    : peerIsAgent ? "Agent" : t("人类");

  return (
    <div className="flex h-full min-h-0 flex-col">
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

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-[color-mix(in_oklab,var(--surface-muted)_45%,white)] px-4 py-5">
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
        {messages.map((m, index) => {
          const mine = m.from === selfID;
          const view = describeMessage(m);
          const divider = timeDivider(messages[index - 1], m);
          const dividerLine = divider ? <p className="text-center text-[11px] text-black/35">{divider}</p> : null;
          if (view.kind === "event" || view.kind === "tip") {
            return <Fragment key={m.ID}>{dividerLine}<p className="px-6 text-center text-xs leading-5 text-black/40">{systemLine(view)}</p></Fragment>;
          }
          const at = Number(m.time ?? 0);
          const canRevoke = mine && !m.isRevoked && now - at < REVOKE_WINDOW_SECONDS;
          const quoted = m.isRevoked ? null : quotedMessage(m);
          const copyText = m.isRevoked ? "" : view.kind === "text" ? view.text : view.kind === "custom" ? view.description : "";
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
                  <ChatBubble tone={mine ? "user" : "assistant"}
                    className={cn("max-w-full px-3.5 py-2 transition-shadow", mine && "ml-0", highlightID === m.ID && "ring-2 ring-[var(--ring)]")}>
                    {quoted ? (
                      <button type="button" onClick={() => jumpTo(quoted.messageID)}
                        className={cn("mb-1.5 block w-full max-w-full rounded-md border-l-2 px-2 py-1 text-left text-xs",
                          mine ? "border-white/50 bg-white/10 text-white/80" : "border-black/20 bg-black/[0.04] text-black/55")}>
                        <span className="font-medium">{quoted.sender}</span>：<span className="break-words">{quoted.abstract}</span>
                      </button>
                    ) : null}
                    <VelaImMessageContent message={m} mine={mine} />
                  </ChatBubble>
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
                      <button type="button" onClick={() => void revoke(m)} className={action}>
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

      <div className="border-t border-black/[0.06] bg-white p-3">
        {isGroup && others.some((m) => isAgentID(m.userID)) ? (
          <div className="mb-2 flex flex-wrap gap-1.5" aria-label={t("快速 @ Agent")}>
            {others.length > 1 ? (
              <button type="button" onClick={() => { setText((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}@${MENTION_ALL_TEXT} `); textareaRef.current?.focus(); }}
                className="inline-flex h-7 items-center rounded-full border border-black/[0.08] px-2.5 text-xs text-black/60 hover:border-black/15 hover:text-black/80">
                @{t("所有人")}
              </button>
            ) : null}
            {others.filter((m) => isAgentID(m.userID)).map((m) => (
              <button key={m.userID} type="button" onClick={() => { setText((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}@${m.name} `); textareaRef.current?.focus(); }}
                className="inline-flex h-7 items-center rounded-full border border-black/[0.08] px-2.5 text-xs text-black/60 hover:border-black/15 hover:text-black/80">
                @{m.name}
              </button>
            ))}
          </div>
        ) : null}
        {quoting ? (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-black/[0.04] px-3 py-2 text-xs text-black/60">
            <Quote className="size-3.5 shrink-0 text-black/40" />
            <span className="min-w-0 flex-1 truncate"><span className="font-medium">{quoting.sender}</span>：{quoting.abstract}</span>
            <button type="button" onClick={() => setQuoting(null)} aria-label={t("取消引用")} className="inline-flex size-6 items-center justify-center rounded-md text-black/45 hover:bg-black/[0.06] hover:text-black/70">
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}
        <div className="relative">
          {suggestions.length ? (
            <ul id="vela-im-mentions" role="listbox" aria-label={t("提及成员")} className="absolute bottom-[calc(100%+6px)] left-0 z-10 w-64 rounded-xl border border-black/10 bg-white p-1.5 shadow-xl">
              {suggestions.map((m, index) => (
                <li key={m.userID}>
                  <button id={`vela-im-mention-${index}`} type="button" role="option" aria-selected={index === activeMention} tabIndex={-1}
                    onMouseEnter={() => setActiveMention(index)} onMouseDown={(e) => { e.preventDefault(); insertMention(mentionText(m)); }}
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
          <div className="flex items-end gap-2">
            <input ref={fileRef} type="file" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void sendFile(file); }} />
            <Button type="button" variant="ghost" size="sm" className="h-10 w-10 shrink-0 rounded-lg p-0" aria-label={t("发送图片、语音、视频或文件")} disabled={!ready || sending} onClick={() => fileRef.current?.click()}>
              <Paperclip className="size-4" />
            </Button>
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
              placeholder={isGroup ? t("输入消息，@ 提及 Agent 或成员") : t("输入消息")}
              onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onKeyDown={onKeyDown}
              className="max-h-40 min-h-10 resize-none rounded-md py-2 leading-6"
            />
            <Button type="button" className="h-10 w-10 shrink-0 rounded-lg p-0" aria-label={t("发送")} disabled={!ready || sending || !text.trim()} onClick={() => void sendText()}>
              {sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
            </Button>
          </div>
        </div>
        {error ? <p role="alert" className="mt-2 text-xs text-[var(--danger)]">{error}</p> : null}
      </div>
    </div>
  );
}
