import { ArrowUpRight, CalendarClock, Copy, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useOpenClaw, type OpenClawBot } from "@/contexts/agent-context";
import { useRepositories } from "@/contexts/repository-context";
import { resolveAgentDisplayName } from "@/pages/marketing/agent-provider-locale";
import { useCurrentLocale, useT } from "@/i18n/t";
import type { AgentSettingsSectionId } from "@/lib/agent-routes";
import { cn } from "@/lib/utils";
import { buildProfileMetaWriteCommand } from "@/lib/hermes-profile-meta";
import { GeometricAvatar } from "@/pages/marketing/agent-avatar-shapes";
import { useBuddyProfile } from "@/pages/marketing/agent-buddy-profile";
import { isSetupCommandSucceeded } from "@/pages/marketing/agent-buddy-setup-runner";
import { useHeroStats } from "@/pages/marketing/agent-hero-stats";
import { HeroBanner, LatestNewsSection } from "@/pages/marketing/agent-overview-panel";
import { sumBotAutomationCounts, useFleetAutomationCounts } from "@/pages/marketing/agent-fleet-stats";

const compactButton = "cursor-pointer rounded-md transition-none hover:translate-y-0";
type Action = { kind: "rename" | "delete"; bot: OpenClawBot };

export type FleetOverviewProps = {
  bots: OpenClawBot[];
  canCreate: boolean;
  createLimitMessage: string;
  onCreate: (sourceBotId?: string) => void;
  onOpen: (botId: string, section?: AgentSettingsSectionId) => void;
  onChanged: () => void;
};

function FleetBotCard({ bot, count, busy, canCreate, onOpen, onCreate, onAction, onRepair }: {
  bot: OpenClawBot;
  count: number | null | undefined;
  busy: boolean;
  canCreate: boolean;
  onOpen: FleetOverviewProps["onOpen"];
  onCreate: FleetOverviewProps["onCreate"];
  onAction: (action: Action) => void;
  onRepair: (bot: OpenClawBot) => Promise<void>;
}) {
  const t = useT();
  const repositories = useRepositories();
  const profile = useBuddyProfile({
    botId: bot.status === "running" ? bot.id : undefined,
    profileId: bot.profileId,
    fallbackName: resolveAgentDisplayName(bot.name, t),
    exec: repositories.bots.execDebugCommand,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const name = profile.profile.name;
  const status = {
    running: t("运行中"), paused: t("已暂停"), draft: t("草稿"),
    provisioning: t("创建中"), failed: t("创建失败"), deleting: t("删除中"),
  }[bot.status];
  const transitioning = bot.status === "provisioning" || bot.status === "deleting";
  const configurable = bot.status === "running" && Boolean(bot.profileId?.trim());
  const menuAction = (kind: Action["kind"]) => { setMenuOpen(false); onAction({ kind, bot }); };

  return (
    <Card className="min-w-0 rounded-md border border-black/[0.06] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
      <div className="flex items-start gap-3">
        <GeometricAvatar shapeId={profile.profile.shapeId} color={profile.profile.color} size={48} />
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-balance text-base font-semibold text-[var(--text-primary)]">{name}</h3>
          <p className="mt-1 line-clamp-2 text-pretty text-sm text-[var(--text-secondary)]">
            {profile.profile.description || bot.description || bot.intro || t("你的智能助手")}
          </p>
        </div>
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className={cn(compactButton, "size-9 shrink-0 p-0")} aria-label={t("管理 {{name}}", { name })} disabled={busy || transitioning}>
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-48 rounded-md p-1.5" align="end">
            <Button variant="ghost" size="sm" className={cn(compactButton, "w-full justify-start")} onClick={() => menuAction("rename")} disabled={!configurable}>
              <Pencil className="size-4" aria-hidden="true" />{t("重命名")}
            </Button>
            <Button variant="ghost" size="sm" className={cn(compactButton, "w-full justify-start")} disabled={!canCreate || !configurable} onClick={() => { setMenuOpen(false); onCreate(bot.id); }}>
              <Copy className="size-4" aria-hidden="true" />{t("复制 Bot")}
            </Button>
            <Button variant="ghost" size="sm" className={cn(compactButton, "w-full justify-start")} onClick={() => menuAction("delete")}>
              <Trash2 className="size-4" aria-hidden="true" />{bot.isDefault ? t("删除整个 Agent") : t("删除 Bot")}
            </Button>
          </PopoverContent>
        </Popover>
      </div>
      <p className="mt-5 flex items-center gap-2 text-xs text-[var(--text-secondary)]">
        <span className={cn("size-1.5 rounded-full", bot.status === "running" ? "bg-emerald-500" : bot.status === "failed" ? "bg-red-500" : "bg-amber-500")} aria-hidden="true" />{status}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--text-secondary)]">
        <Button variant="ghost" size="sm" className={cn(compactButton, "h-auto px-0")} disabled={!configurable} onClick={() => onOpen(bot.id, "channel")}>{t("配置通道")}</Button>
        <Button variant="ghost" size="sm" className={cn(compactButton, "h-auto px-0 tabular-nums")} disabled={!configurable} onClick={() => onOpen(bot.id, "automations")}>
          <CalendarClock className="size-3.5" aria-hidden="true" />{t("定时任务")} · {count ?? "—"}
        </Button>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-black/[0.06] pt-3">
        {bot.status === "failed" ? (
          <Button variant="outline" size="sm" className={compactButton} disabled={busy} onClick={async () => {
            setRepairError(null);
            try { await onRepair(bot); } catch (error) { setRepairError(error instanceof Error ? error.message : t("Bot 修复失败，请稍后重试。")); }
          }}><RefreshCw className="size-3.5" aria-hidden="true" />{t("修复 Bot")}</Button>
        ) : (
          <Button variant="ghost" size="sm" className={compactButton} disabled={transitioning || busy} onClick={() => onOpen(bot.id)}>
            {bot.status === "draft" ? t("继续配置") : t("打开 Bot")}<ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>
      {repairError && <p role="alert" className="mt-2 text-pretty text-xs text-red-700">{repairError}</p>}
    </Card>
  );
}

export function AgentFleetOverview({ bots, canCreate, createLimitMessage, onCreate, onOpen, onChanged }: FleetOverviewProps) {
  const t = useT();
  const locale = useCurrentLocale();
  const repositories = useRepositories();
  const { activePass, deleteBot, refreshBots, botsError, botsLoading } = useOpenClaw();
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState<Action | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const errorId = useId();
  const limitId = useId();
  const accountStats = useHeroStats({ activePass, locale, botId: undefined, profileId: undefined });
  const counts = useFleetAutomationCounts(bots, revision);
  const siblingBlock = action?.kind === "delete" && action.bot.isDefault && bots.some((bot) => bot.id !== action.bot.id && (bot.instanceId ?? bot.id) === (action.bot.instanceId ?? action.bot.id));
  const stats = { ...accountStats, automations: botsError ? null : sumBotAutomationCounts(bots, counts) };
  const changed = async () => { await refreshBots(); setRevision((v) => v + 1); onChanged(); };
  const begin = (next: Action) => { setInput(next.kind === "rename" ? next.bot.name : ""); setError(null); setAction(next); };
  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await operation(); } finally { busyRef.current = false; setBusy(false); }
  };
  const submit = async () => {
    if (!action || siblingBlock || busyRef.current) return;
    const target = action;
    const name = input.trim();
    if (target.kind === "rename" ? !name : input !== target.bot.name) return;
    await run(async () => {
      setError(null);
      try {
        if (target.kind === "rename") {
          if (!target.bot.profileId?.trim()) return;
          await repositories.bots.renameBot(target.bot.id, name);
          // Profile metadata owns the display name. Preserve all other profile fields.
          const result = await repositories.bots.execDebugCommand(
            target.bot.id,
            buildProfileMetaWriteCommand({ displayName: name }, target.bot.profileId),
            { timeoutMs: 30_000 },
          );
          if (!isSetupCommandSucceeded(result) || !result.output?.includes("__LV_META_OK__")) {
            throw new Error(t("Bot 名称已更新，资料同步失败，请重试。"));
          }
        }
        else await deleteBot(target.bot.id);
        await changed();
        setAction(null);
      } catch (err) { setError(err instanceof Error ? err.message : t("操作失败，请稍后重试。")); }
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-10">
      <h2 className="-mb-4 text-balance text-lg font-semibold text-[var(--text-primary)]">{t("总览")}</h2>
      <HeroBanner stats={stats} globalOverview />
      <section id="overview-bots" aria-labelledby="overview-bots-title">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 id="overview-bots-title" className="flex items-center gap-2 text-balance text-base font-semibold">{t("我的 Bots")}<span className="rounded bg-black/[0.04] px-2 py-0.5 text-xs tabular-nums">{bots.length}</span></h3>
            <p className="mt-1 text-pretty text-sm text-[var(--text-secondary)]">{t("在这里查看和管理你的所有 Bot")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className={compactButton} disabled={busy} onClick={() => void run(async () => { try { await changed(); setError(null); } catch { setError(t("刷新失败，请稍后重试。")); } })} aria-label={t("刷新 Bot 列表")}><RefreshCw className="size-4" aria-hidden="true" /></Button>
            <Button className={compactButton} disabled={!canCreate || busy || botsError || botsLoading} aria-describedby={createLimitMessage ? limitId : undefined} onClick={() => onCreate()}><Plus className="size-4" aria-hidden="true" />{t("创建 Bot")}</Button>
          </div>
        </div>
        {createLimitMessage && <p id={limitId} className="mb-4 text-pretty text-sm text-[var(--text-secondary)]">{createLimitMessage}</p>}
        {error && !action && <p className="mb-4 text-sm text-red-700" role="alert">{error}</p>}
        {botsError && <p role="alert" className="mb-4 text-sm text-red-700">{t("Bot 列表加载失败，请刷新重试。")}</p>}
        {bots.length === 0 && !botsError && <p className="mb-4 text-sm text-[var(--text-secondary)]">{t("还没有 Bot，创建你的第一个助手")}</p>}
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          {bots.map((bot) => <FleetBotCard key={`${bot.id}:${revision}`} bot={bot} count={counts[bot.id]} busy={busy} canCreate={canCreate} onOpen={onOpen} onCreate={onCreate} onAction={begin} onRepair={(target) => run(async () => { await repositories.bots.retryBot(target.id); await changed(); })} />)}
          {bots.length > 0 && <button type="button" disabled={!canCreate || busy || botsError || botsLoading} aria-describedby={createLimitMessage ? limitId : undefined} className="flex min-h-52 cursor-pointer flex-col items-center justify-center gap-3 rounded-md border border-dashed border-black/15 bg-black/[0.01] p-6 text-center hover:bg-black/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50" onClick={() => onCreate()}>
            <Plus className="size-6 text-[var(--text-secondary)]" aria-hidden="true" /><span className="text-sm font-medium">{t("再创建一个 Bot")}</span><span className="text-pretty text-xs text-[var(--text-secondary)]">{t("为不同的事情安排专属助手")}</span>
          </button>}
        </div>
      </section>
      <LatestNewsSection />
      <Dialog open={action !== null} onOpenChange={(open) => { if (!open && !busyRef.current) setAction(null); }}>
        <DialogContent role={action?.kind === "delete" ? "alertdialog" : "dialog"} closeLabel={t("关闭")} onInteractOutside={(event) => event.preventDefault()} onEscapeKeyDown={(event) => { if (busyRef.current) event.preventDefault(); }}>
          <DialogHeader className="mb-5">
            <DialogTitle>{action?.kind === "delete" ? (action.bot.isDefault ? t("删除整个 Agent") : t("删除 Bot")) : t("重命名")}</DialogTitle>
            <DialogDescription>{action?.kind === "delete" ? t("此操作不可撤销，请输入 Bot 名称确认删除。") : t("修改所选 Bot 的名称")}</DialogDescription>
          </DialogHeader>
          {action && <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            {action.kind === "delete" && <p className="mb-3 break-words text-sm font-semibold">{action.bot.name}</p>}
            {siblingBlock && <p className="mb-3 text-sm text-amber-800" role="status">{t("请先删除其他 Bot，再删除主 Bot")}</p>}
            <label htmlFor={fieldId} className="mb-2 block text-sm">{t("Bot 名称")}</label>
            <Input id={fieldId} value={input} onChange={(event) => setInput(event.target.value)} disabled={busy || siblingBlock} required aria-describedby={error ? errorId : undefined} aria-invalid={Boolean(error)} />
            {error && <p id={errorId} role="alert" className="mt-3 text-pretty text-sm text-red-700">{error}</p>}
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" className={compactButton} type="button" disabled={busy} onClick={() => setAction(null)}>{t("取消")}</Button>
              <Button variant={action.kind === "delete" ? "destructive" : "default"} className={compactButton} type="submit" disabled={busy || siblingBlock || (action.kind === "delete" ? input !== action.bot.name : !input.trim())}>{busy ? t("处理中...") : action.kind === "delete" ? t("确认删除") : t("保存")}</Button>
            </div>
          </form>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
