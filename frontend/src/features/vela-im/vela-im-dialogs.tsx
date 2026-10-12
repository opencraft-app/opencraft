"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Loader2, Search, UserMinus, UserPlus } from "lucide-react";
import { platformGroupId, type GroupReplyMode, type ImGroup, type VelaHumanAPI } from "@vela/im-client";
import type { VelaBrowserClient } from "@vela/im-client/browser";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";
import { VelaImAvatar } from "./vela-im-avatar";
import { errorText, isAgentID, toMembers } from "./vela-im-model";

export interface Person {
  userID: string;
  name: string;
  /** One of your own Agents. */
  mine?: boolean;
}

const buttonClass = "rounded-lg";
const inputClass = "h-10 rounded-md";
const IM_ID = /^[A-Za-z0-9_-]{3,32}$/;

function KindBadge({ userID }: { userID: string }) {
  const t = useT();
  return <Badge variant={isAgentID(userID) ? "warning" : "neutral"}>{isAgentID(userID) ? "Agent" : t("人类")}</Badge>;
}

function InlineError({ message }: { message: string }) {
  return message ? <p role="alert" className="text-sm text-[var(--danger)]">{message}</p> : null;
}

function PersonRow({ person, children }: { person: Person; children: ReactNode }) {
  const t = useT();
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <VelaImAvatar name={person.name} seed={person.userID} kind={isAgentID(person.userID) ? "agent" : "human"} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-black/80">{person.name}</span>
          <KindBadge userID={person.userID} />
        </span>
        <span className="block truncate text-xs text-black/40">{person.mine ? `${t("我的 Agent")} · ` : ""}{person.userID}</span>
      </span>
      {children}
    </li>
  );
}

/** Multi-select over your Agents; anyone else is added by their exact IM ID. */
export function PeoplePicker({ candidates, selected, onChange, exclude = [] }: {
  candidates: Person[];
  selected: string[];
  onChange: (ids: string[]) => void;
  exclude?: string[];
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const excluded = useMemo(() => new Set(exclude), [exclude]);
  const q = query.trim();
  const people = candidates.filter((p) => !excluded.has(p.userID) && (!q || `${p.name} ${p.userID}`.toLowerCase().includes(q.toLowerCase())));
  if (IM_ID.test(q) && !excluded.has(q) && !people.some((p) => p.userID === q)) people.push({ userID: q, name: q });
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="space-y-2">
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-black/35" />
        <Input className={cn(inputClass, "pl-9")} placeholder={t("搜索我的 Agent，或输入 IM ID")} value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <ul className="max-h-64 divide-y divide-black/[0.06] overflow-y-auto rounded-md border border-black/[0.08]">
        {people.map((person) => {
          const checked = selected.includes(person.userID);
          return (
            <PersonRow key={person.userID} person={person}>
              <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                aria-label={t("选择 {{name}}", { name: person.name })}
                onClick={() => toggle(person.userID)}
                className={cn("inline-flex size-6 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                  checked ? "border-[var(--text-primary)] bg-[var(--text-primary)] text-white" : "border-black/15 bg-white text-transparent hover:border-black/30")}
              >
                <Check className="size-3.5" />
              </button>
            </PersonRow>
          );
        })}
        {!people.length ? <li className="px-3 py-6 text-center text-sm text-black/40">{t("没有匹配的人或 Agent")}</li> : null}
      </ul>
      {selected.length ? <p className="text-xs text-black/45">{t("已选择 {{count}} 位", { count: selected.length })}</p> : null}
    </div>
  );
}

/** Group members, Agent reply rules and membership changes, all kept by the platform. */
export function GroupSettingsDialog({ open, onOpenChange, client, api, groupID, groupName, selfID, candidates, onLeft }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: VelaBrowserClient;
  api: VelaHumanAPI | null;
  groupID: string;
  groupName: string;
  selfID: string;
  candidates: Person[];
  onLeft: () => void;
}) {
  const t = useT();
  const platformID = platformGroupId(groupID);
  const [group, setGroup] = useState<ImGroup | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const load = async () => {
    if (!platformID || !api) return;
    const [platform, list] = await Promise.all([api.group(platformID), client.getGroupMembers(groupID).catch(() => [])]);
    setGroup(platform);
    setNames(Object.fromEntries(toMembers(list).map((m) => [m.userID, m.name])));
  };
  useEffect(() => {
    if (!open) return;
    setAdding([]);
    setError("");
    setConfirmDismiss(false);
    void load().catch((e: unknown) => setError(errorText(e, t("读取群信息失败"))));
  }, [open, groupID]);
  const role = group?.viewerRole ?? "member";
  const canManage = role !== "member";
  const act = async (key: string, action: () => Promise<unknown>, reload = true) => {
    setBusy(key);
    setError("");
    try {
      await action();
      if (reload) await load();
    } catch (e) {
      setError(errorText(e, t("操作失败")));
    } finally {
      setBusy("");
    }
  };
  const nameOf = (userID: string) => names[userID] || candidates.find((c) => c.userID === userID)?.name || userID;
  const members = [...(group?.members ?? [])].sort((a, b) => ["owner", "admin", "member"].indexOf(a.role) - ["owner", "admin", "member"].indexOf(b.role));
  const botOnly = !!members.length && members.every((m) => m.kind === "bot");
  if (!platformID) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent closeLabel={t("关闭")}>
          <DialogHeader className="mb-5 pb-1 pr-8">
            <DialogTitle>{groupName}</DialogTitle>
            <DialogDescription>{t("这个群不是通过平台创建的，成员和 Agent 回复规则不能在这里管理。")}</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t("关闭")} className="max-h-[calc(100dvh-2rem)] overflow-y-auto md:w-[40rem]">
        <DialogHeader className="mb-5 pb-1 pr-8">
          <DialogTitle>{group?.name ?? groupName}</DialogTitle>
          <DialogDescription>
            {botOnly ? t("纯 Agent 群") : t("人机群")} · {t("{{count}} 位成员", { count: members.length })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-black/80">{t("Agent 回复规则")}</h3>
            <p className="text-xs leading-5 text-black/50">
              {botOnly
                ? t("群里都是 Agent 时，每条消息都会触发其他 Agent，无需 @。有人类加入后按下面的规则执行。")
                : t("多个 Agent 各自独立判断是否回复；Agent 之间的连续对话受跳数限制。")}
            </p>
            <Select
              value={group?.replyMode ?? "mention"}
              disabled={!canManage || !group || busy === "policy"}
              onValueChange={(mode) => void act("policy", async () => setGroup(await api!.updateGroup(platformID, { replyMode: mode as GroupReplyMode })), false)}
            >
              <SelectTrigger className="h-10 rounded-md" aria-label={t("Agent 回复规则")}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="mention">{t("仅在被 @ 时回复")}</SelectItem>
                <SelectItem value="mention_context">{t("被 @ 时回复，并参考前 10 条消息")}</SelectItem>
                <SelectItem value="all">{t("回复每条消息")}</SelectItem>
              </SelectContent>
            </Select>
            {!canManage ? <p className="text-xs text-black/40">{t("只有群主和管理员可以修改。")}</p> : null}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-black/80">{t("成员")}</h3>
            <ul className="max-h-72 divide-y divide-black/[0.06] overflow-y-auto rounded-md border border-black/[0.08]">
              {members.map((m) => (
                <PersonRow key={m.userId} person={{ userID: m.userId, name: m.userId === selfID ? `${nameOf(m.userId)}（${t("我")}）` : nameOf(m.userId) }}>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="text-xs text-black/45">{m.role === "owner" ? t("群主") : m.role === "admin" ? t("管理员") : t("成员")}</span>
                    {canManage && m.userId !== selfID && m.role !== "owner" && !(role === "admin" && m.role === "admin") ? (
                      <Button size="sm" variant="ghost" className={buttonClass} style={{ color: "var(--danger)" }} disabled={!!busy} aria-label={t("移出 {{name}}", { name: nameOf(m.userId) })}
                        onClick={() => void act(`kick:${m.userId}`, () => api!.removeGroupMember(platformID, m.userId))}>
                        {busy === `kick:${m.userId}` ? <Loader2 className="size-3.5 animate-spin" /> : <UserMinus className="size-3.5" />}{t("移出")}
                      </Button>
                    ) : null}
                  </div>
                </PersonRow>
              ))}
            </ul>
          </section>

          {canManage ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-black/80">{t("邀请成员")}</h3>
              <PeoplePicker candidates={candidates} selected={adding} onChange={setAdding} exclude={members.map((m) => m.userId)} />
              <div className="flex justify-end">
                <Button className={buttonClass} disabled={!adding.length || !!busy}
                  onClick={() => void act("add", async () => { for (const userID of adding) await api!.addGroupMember(platformID, userID); setAdding([]); })}>
                  {busy === "add" ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}{t("邀请")}
                </Button>
              </div>
            </section>
          ) : null}

          <InlineError message={error} />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-black/[0.06] pt-4">
            {role === "owner" ? (
              confirmDismiss ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-black/60">{t("解散后所有成员都会失去这个群。")}</span>
                  <Button size="sm" variant="destructive" className={buttonClass} disabled={!!busy}
                    onClick={() => void act("dismiss", async () => { await api!.dismissGroup(platformID); onOpenChange(false); onLeft(); }, false)}>{t("确认解散")}</Button>
                  <Button size="sm" variant="ghost" className={buttonClass} onClick={() => setConfirmDismiss(false)}>{t("取消")}</Button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" className={buttonClass} style={{ color: "var(--danger)" }} onClick={() => setConfirmDismiss(true)}>{t("解散群聊")}</Button>
              )
            ) : (
              <Button size="sm" variant="ghost" className={buttonClass} style={{ color: "var(--danger)" }} disabled={!!busy}
                onClick={() => void act("quit", async () => { await api!.removeGroupMember(platformID, selfID); onOpenChange(false); onLeft(); }, false)}>{t("退出群聊")}</Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
