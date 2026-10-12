"use client";

import { FormEvent, useState } from "react";
import { Ban, RefreshCw, ShieldCheck, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { PageHeader } from "@/components/shared/page-header";
import {
  IM_ADMIN_PAGE_SIZE,
  IM_DISMISS_REASON_MAX,
  type ImAdminGroup,
  type ImAdminIdentity,
  imAdminErrorMessage,
  useDisableImBot,
  useDismissImGroup,
  useImAdminGroup,
  useImAdminGroups,
  useImAdminIdentities,
  useImAdminSummary,
  useImTencentCheck,
  useRestrictImIdentity,
} from "@/lib/queries/use-im-admin";
import { formatDateTime, formatNumber } from "@/lib/utils";

const REPLY_MODE: Record<string, string> = { mention: "@ 时回复", mention_context: "@ 时回复并参考上下文", all: "每条都回复" };

const DISMISSED_BY: Record<string, string> = { admin: "管理员解散", owner: "群主解散", tencent: "在腾讯侧被解散" };

const dismissalText = (group: ImAdminGroup) => {
  const by = DISMISSED_BY[group.dismissedBy ?? ""] ?? "已解散";
  return group.dismissReason ? `${by}：${group.dismissReason}` : by;
};

type PendingAction =
  | { kind: "restrict"; identity: ImAdminIdentity }
  | { kind: "disable"; identity: ImAdminIdentity }
  | { kind: "dismiss"; group: ImAdminGroup };

function Filter<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  return (
    <div className="flex gap-1">
      {options.map(([option, label]) => (
        <Button key={option || "all"} type="button" size="sm" variant={value === option ? "default" : "outline"} onClick={() => onChange(option)}>
          {label}
        </Button>
      ))}
    </div>
  );
}

function Pager({ page, total, onChange }: { page: number; total: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / IM_ADMIN_PAGE_SIZE));
  return (
    <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
      <span>共 {formatNumber(total)} 条 · 第 {page + 1}/{pages} 页</span>
      <Button size="sm" variant="outline" disabled={page === 0} onClick={() => onChange(page - 1)}>上一页</Button>
      <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => onChange(page + 1)}>下一页</Button>
    </div>
  );
}

function SummaryTab() {
  const summary = useImAdminSummary();
  const check = useImTencentCheck();
  const data = summary.data;
  const cards: Array<[string, number | undefined, string]> = [
    ["人类 IM 账号", data?.humansReady, data ? `另有 ${data.humansPending} 个开通中` : ""],
    ["Bot IM 身份", data?.bots.ready, data ? `开通中 ${data.bots.provisioning} · 异常 ${data.bots.error} · 已停用 ${data.bots.deleted}` : ""],
    ["平台群", data?.groupsActive, data ? `已解散 ${data.groupsDismissed}` : ""],
    ["被限制的身份", data?.restrictedIdentities, ""],
    ["占用腾讯账号", data?.estimatedTencentAccounts, "就绪与开通中的人类，加上未停用的 Bot"],
  ];
  return (
    <div className="space-y-4">
      {summary.error ? <p className="text-sm text-destructive">{imAdminErrorMessage(summary.error)}</p> : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map(([title, value, hint]) => (
          <Card key={title}>
            <CardHeader className="pb-2"><CardDescription>{title}</CardDescription></CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{value === undefined ? "—" : formatNumber(value)}</div>
              {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>与腾讯核对</CardTitle>
          <CardDescription>腾讯账号只能由平台后台创建和删除，数量以平台记录为准。这里逐个向腾讯确认这些账号的实际状态，用来发现异常：比如后台调腾讯成功但写库失败，或有人绕过平台直接在腾讯侧删了账号。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={() => check.mutate(undefined, { onError: (e) => toast.error(imAdminErrorMessage(e)) })} disabled={check.isPending}>
            <RefreshCw className={check.isPending ? "size-4 animate-spin" : "size-4"} />开始核对
          </Button>
          {check.data ? (
            <div className="space-y-2">
              <p className="text-sm">核对 {formatNumber(check.data.checked)} 个账号，腾讯侧存在 {formatNumber(check.data.imported)} 个，不一致 {formatNumber(check.data.mismatches.length)} 个。</p>
              {check.data.mismatches.length ? (
                <Table>
                  <TableHeader><TableRow><TableHead>IM UserID</TableHead><TableHead>类型</TableHead><TableHead>平台状态</TableHead><TableHead>预期</TableHead><TableHead>腾讯</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {check.data.mismatches.map((m) => (
                      <TableRow key={m.userId}>
                        <TableCell className="font-mono text-xs">{m.userId}</TableCell>
                        <TableCell>{m.kind === "human" ? "人类" : "Bot"}</TableCell>
                        <TableCell>{m.state}</TableCell>
                        <TableCell>{m.expected === "present" ? "应存在" : "应已删除"}</TableCell>
                        <TableCell><Badge variant="destructive">{m.tencent === "imported" ? "存在" : "不存在"}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function IdentitiesTab({ onAction }: { onAction: (action: PendingAction) => void }) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"" | "human" | "bot">("");
  const [page, setPage] = useState(0);
  const restrict = useRestrictImIdentity();
  const identities = useImAdminIdentities(query, kind, page);
  const search = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setQuery(input.trim()); setPage(0); };
  return (
    <Card>
      <CardHeader>
        <CardTitle>IM 账号</CardTitle>
        <CardDescription>平台为人类和 Bot 创建的腾讯 IM 账号。可按 IM UserID、LightVela 用户 ID（usr_）、账号 ID 或名称查找。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <form onSubmit={search} className="flex gap-2">
            <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="IM UserID / usr_… / 名称" className="w-72" />
            <Button type="submit" variant="outline">查找</Button>
          </form>
          <Filter value={kind} onChange={(value) => { setKind(value); setPage(0); }} options={[["", "全部"], ["human", "人类"], ["bot", "Bot"]]} />
        </div>
        {identities.error ? <p className="text-sm text-destructive">{imAdminErrorMessage(identities.error)}</p> : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead><TableHead>类型</TableHead><TableHead>IM UserID</TableHead><TableHead>LightVela 用户</TableHead>
              <TableHead>状态</TableHead><TableHead>创建时间</TableHead><TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(identities.data?.items ?? []).map((identity) => (
              <TableRow key={identity.userId}>
                <TableCell>
                  <div className="font-medium">{identity.displayName}</div>
                  {identity.kind === "bot" ? <div className="font-mono text-xs text-muted-foreground">{identity.instanceId}/{identity.botId}</div> : null}
                </TableCell>
                <TableCell>{identity.kind === "human" ? "人类" : "Bot"}</TableCell>
                <TableCell className="font-mono text-xs">{identity.userId}</TableCell>
                <TableCell className="font-mono text-xs">{identity.lightvelaUserId ?? "—"}</TableCell>
                <TableCell className="space-x-1">
                  <Badge variant={identity.state === "ready" ? "default" : "secondary"}>{identity.state}</Badge>
                  {identity.restricted ? <Badge variant="destructive">已限制</Badge> : null}
                </TableCell>
                <TableCell className="text-xs">{identity.createdAt ? formatDateTime(identity.createdAt) : "—"}</TableCell>
                <TableCell className="space-x-1 text-right">
                  {identity.restricted ? (
                    <Button size="sm" variant="outline" disabled={restrict.isPending}
                      onClick={() => restrict.mutate({ userId: identity.userId, restricted: false }, {
                        onSuccess: () => toast.success("已解除限制"), onError: (e) => toast.error(imAdminErrorMessage(e)),
                      })}>
                      <ShieldCheck className="size-4" />解除限制
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => onAction({ kind: "restrict", identity })}><Ban className="size-4" />限制</Button>
                  )}
                  {identity.kind === "bot" && identity.state !== "deleted" && identity.accountId && identity.botAgentId ? (
                    <Button size="sm" variant="outline" onClick={() => onAction({ kind: "disable", identity })}><Trash2 className="size-4" />停用</Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
            {identities.data && !identities.data.items.length ? (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">没有匹配的账号</TableCell></TableRow>
            ) : null}
          </TableBody>
        </Table>
        <Pager page={page} total={identities.data?.total ?? 0} onChange={setPage} />
      </CardContent>
    </Card>
  );
}

function GroupsTab({ onAction }: { onAction: (action: PendingAction) => void }) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [state, setState] = useState<"" | "active" | "dismissed">("active");
  const [page, setPage] = useState(0);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const groups = useImAdminGroups(query, state, page);
  const detail = useImAdminGroup(openGroup);
  const search = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setQuery(input.trim()); setPage(0); };
  return (
    <Card>
      <CardHeader>
        <CardTitle>平台群</CardTitle>
        <CardDescription>用户在 LightVela 里创建的人机群。可按群名、群 ID、腾讯 GroupId 或群主 usr_ 查找。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <form onSubmit={search} className="flex gap-2">
            <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="群名 / 群 ID / usr_…" className="w-72" />
            <Button type="submit" variant="outline">查找</Button>
          </form>
          <Filter value={state} onChange={(value) => { setState(value); setPage(0); }} options={[["active", "进行中"], ["dismissed", "已解散"], ["", "全部"]]} />
        </div>
        {groups.error ? <p className="text-sm text-destructive">{imAdminErrorMessage(groups.error)}</p> : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>群名</TableHead><TableHead>群主</TableHead><TableHead>成员</TableHead><TableHead>回复规则</TableHead>
              <TableHead>状态</TableHead><TableHead>创建时间</TableHead><TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(groups.data?.items ?? []).map((group) => (
              <TableRow key={group.id}>
                <TableCell>
                  <div className="font-medium">{group.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">{group.tencentGroupId}</div>
                </TableCell>
                <TableCell className="font-mono text-xs">{group.ownerLightvelaUserId ?? group.ownerAccountId}</TableCell>
                <TableCell>{group.memberCount}</TableCell>
                <TableCell className="text-xs">{REPLY_MODE[group.replyMode] ?? group.replyMode}</TableCell>
                <TableCell className="max-w-64">
                  <Badge variant={group.state === "active" ? "default" : "secondary"}>{group.state}</Badge>
                  {group.state === "dismissed" ? <div className="mt-1 text-xs whitespace-pre-wrap break-words text-muted-foreground">{dismissalText(group)}</div> : null}
                </TableCell>
                <TableCell className="text-xs">{group.createdAt ? formatDateTime(group.createdAt) : "—"}</TableCell>
                <TableCell className="space-x-1 text-right">
                  <Button size="sm" variant="outline" onClick={() => setOpenGroup(group.id)}><Users className="size-4" />成员</Button>
                  {group.state !== "dismissed" ? (
                    <Button size="sm" variant="outline" onClick={() => onAction({ kind: "dismiss", group })}><Trash2 className="size-4" />解散</Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
            {groups.data && !groups.data.items.length ? (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">没有匹配的群</TableCell></TableRow>
            ) : null}
          </TableBody>
        </Table>
        <Pager page={page} total={groups.data?.total ?? 0} onChange={setPage} />
      </CardContent>
      <Dialog open={!!openGroup} onOpenChange={(open) => { if (!open) setOpenGroup(null); }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{detail.data?.group.name ?? "群成员"}</DialogTitle>
            <DialogDescription>{detail.data ? `${detail.data.group.tencentGroupId} · ${REPLY_MODE[detail.data.group.replyMode] ?? ""}` : "加载中…"}</DialogDescription>
            {detail.data?.group.state === "dismissed" ? <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">{dismissalText(detail.data.group)}</p> : null}
          </DialogHeader>
          {detail.error ? <p className="text-sm text-destructive">{imAdminErrorMessage(detail.error)}</p> : null}
          <Table>
            <TableHeader><TableRow><TableHead>名称</TableHead><TableHead>类型</TableHead><TableHead>IM UserID</TableHead><TableHead>角色</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
            <TableBody>
              {(detail.data?.members ?? []).map((member) => (
                <TableRow key={member.userId}>
                  <TableCell>{member.displayName ?? "—"}</TableCell>
                  <TableCell>{member.kind === "human" ? "人类" : "Bot"}</TableCell>
                  <TableCell className="font-mono text-xs">{member.userId}</TableCell>
                  <TableCell>{member.role === "owner" ? "群主" : member.role === "admin" ? "管理员" : "成员"}</TableCell>
                  <TableCell>{member.state}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function ImAdminPage() {
  const [action, setAction] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState("");
  const restrict = useRestrictImIdentity();
  const disable = useDisableImBot();
  const dismiss = useDismissImGroup();
  const loading = restrict.isPending || disable.isPending || dismiss.isPending;
  const done = (message: string) => ({ onSuccess: () => { toast.success(message); setAction(null); }, onError: (e: unknown) => toast.error(imAdminErrorMessage(e)) });
  const confirm = () => {
    if (!action) return;
    if (action.kind === "restrict") restrict.mutate({ userId: action.identity.userId, restricted: true }, done("已限制，并已使其登录态失效"));
    if (action.kind === "disable") disable.mutate({ accountId: action.identity.accountId!, botAgentId: action.identity.botAgentId! }, done("已停用 Bot 的 IM 身份"));
    if (action.kind === "dismiss") dismiss.mutate({ groupId: action.group.id, reason: reason.trim() }, done("已解散"));
  };
  const copy = action === null ? null
    : action.kind === "restrict" ? { title: `限制 ${action.identity.displayName}？`, description: "立即使其腾讯 IM 登录态失效，并不再签发新的登录凭证；可随时解除。", label: "限制" }
      : action.kind === "disable" ? { title: `停用 Bot「${action.identity.displayName}」的 IM 身份？`, description: "与用户删除相同：下线、删除腾讯账号、吊销实例上的凭据。用户之后可以重新开通。", label: "停用" }
        : { title: `解散群「${action.group.name}」？`, description: "腾讯群会被解散，成员无法再发消息。请填写原因，群成员会在聊天页看到它。", label: "解散" };
  return (
    <div className="space-y-6">
      <PageHeader title="IM 群聊" description="LightVela 人机群聊的账号、Bot 与平台群运营" />
      <Tabs defaultValue="summary">
        <TabsList>
          <TabsTrigger value="summary">概览</TabsTrigger>
          <TabsTrigger value="identities">IM 账号</TabsTrigger>
          <TabsTrigger value="groups">群聊</TabsTrigger>
        </TabsList>
        <TabsContent value="summary" className="mt-4"><SummaryTab /></TabsContent>
        <TabsContent value="identities" className="mt-4"><IdentitiesTab onAction={setAction} /></TabsContent>
        <TabsContent value="groups" className="mt-4"><GroupsTab onAction={setAction} /></TabsContent>
      </Tabs>
      {copy ? (
        <ConfirmDialog open={!!action} onOpenChange={(open) => { if (!open) { setAction(null); setReason(""); } }} title={copy.title} description={copy.description}
          confirmLabel={copy.label} variant="destructive" onConfirm={confirm} loading={loading}
          confirmDisabled={action?.kind === "dismiss" && !reason.trim()}>
          {action?.kind === "dismiss" ? (
            <div className="space-y-1.5">
              <Label htmlFor="im-dismiss-reason">解散原因（必填，展示给群成员）</Label>
              <Textarea id="im-dismiss-reason" value={reason} maxLength={IM_DISMISS_REASON_MAX} placeholder="例如：群内容违反社区规范"
                onChange={(e) => setReason(e.target.value)} />
              <p className="text-right text-xs text-muted-foreground">{reason.trim().length}/{IM_DISMISS_REASON_MAX}</p>
            </div>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
