import { Copy, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useOpenClaw, type OpenClawBot } from "@/contexts/agent-context";
import { useRepositories } from "@/contexts/repository-context";
import { useReferralEnabled } from "@/contexts/runtime-config-context";
import { resolveAgentDisplayName } from "@/pages/marketing/agent-provider-locale";
import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";
import { useBuddyProfile, type BuddyProfile } from "@/pages/marketing/agent-buddy-profile";
import { HeroBanner, LatestNewsSection, RecommendedAutomationsSection, ProfileEditDialog, BuddyProfileAvatar, useOverviewProfileEditor, type HeroStats } from "@/pages/marketing/agent-overview-panel";

import { CreatingLoadingView } from "@/pages/marketing/agent-creating-loading";

const compactButton = "cursor-pointer rounded-md transition-none hover:translate-y-0";
type Action = { bot: OpenClawBot; name: string; profile: BuddyProfile };

export type FleetOverviewProps = {
  bots: OpenClawBot[];
  currentBotId?: string;
  heroStats: HeroStats;
  canCreate: boolean;
  createLimitMessage: string;
  onCreate: (sourceBotId?: string) => void;
  onOpenChat: (botId: string) => void;
  onChanged: (botId: string) => void;
  onDelete: (bot: OpenClawBot) => void;
  getAvatarForBot: (botId: string) => string | undefined;
};

function FleetBotCard({ bot, isCurrent, canDelete, fallbackAvatarUrl, canCreate, onCreate, onOpenChat, onAction, onDelete }: {
  bot: OpenClawBot;
  isCurrent: boolean;
  canDelete: boolean;
  fallbackAvatarUrl: string;
  onDelete: FleetOverviewProps["onDelete"];
  canCreate: boolean;
  onCreate: FleetOverviewProps["onCreate"];
  onOpenChat: FleetOverviewProps["onOpenChat"];
  onAction: (action: Action) => void;
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
  const name = profile.profile.name;
  const description = profile.soulExists !== null ? profile.profile.description : bot.description || bot.intro || "";
  const status = {
    running: t("在线"), paused: t("离线"), draft: t("草稿"),
    provisioning: t("创建中"), failed: t("创建失败"), deleting: t("删除中"),
  }[bot.status];
  const transitioning = bot.status === "provisioning" || bot.status === "deleting";
  const configurable = bot.status === "running" && Boolean(bot.profileId?.trim());
  const canEdit = configurable && !profile.loading && profile.soulExists !== null;
  const editProfile = () => { setMenuOpen(false); onAction({ bot, name, profile: { ...profile.profile, description } }); };

  return (
    <Card className="relative min-w-0 snap-start rounded-[8px] border border-black/[0.06] bg-white p-5 pt-8 shadow-none">
      {isCurrent && <span className="pointer-events-none absolute left-0 top-0 rounded-br-[4px] rounded-tl-[8px] bg-black px-2 py-0.5 text-xs leading-4 text-white">{t("当前 Bot")}</span>}
      <button
        type="button"
        aria-label={`${t("新建对话")}: ${name}`}
        disabled={transitioning}
        onClick={() => onOpenChat(bot.id)}
        className="absolute inset-0 rounded-[8px] enabled:cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/30 focus-visible:ring-offset-2"
      />
      <div className="pointer-events-none flex items-start gap-3">
        <BuddyProfileAvatar profile={profile.profile} hasCustomAvatar={profile.hasBuddyConfig === true} fallbackAvatarUrl={fallbackAvatarUrl} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 pr-5">
            <h3 className="min-w-0 truncate text-base font-semibold text-[var(--text-primary)]" title={name}>{name}</h3>
            <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-[var(--text-secondary)]">
              <span className={cn("size-1.5 rounded-full", bot.status === "running" ? "bg-emerald-500" : bot.status === "failed" ? "bg-red-500" : "bg-amber-500")} aria-hidden="true" />{status}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-pretty text-sm text-[var(--text-secondary)]">
            {description || t("你的智能助手")}
          </p>
        </div>
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className={cn(compactButton, "pointer-events-auto absolute right-2 top-3 z-10 size-7 p-0")} aria-label={t("管理 {{name}}", { name })} disabled={transitioning}>
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="pointer-events-auto w-48 rounded-md p-1.5" align="end">
            <Button variant="ghost" size="sm" className={cn(compactButton, "w-full justify-start")} onClick={() => editProfile()} disabled={!canEdit}>
              <Pencil className="size-4" aria-hidden="true" />{t("修改资料")}
            </Button>
            <Button variant="ghost" size="sm" className={cn(compactButton, "w-full justify-start")} disabled={!canCreate || !configurable} onClick={() => { setMenuOpen(false); onCreate(bot.id); }}>
              <Copy className="size-4" aria-hidden="true" />{t("复制 Bot")}
            </Button>
            <Button variant="ghost" size="sm" className={cn(compactButton, "w-full justify-start")} disabled={!canDelete} title={!canDelete ? t("请先删除其他 Bot，再删除主 Bot") : undefined} onClick={() => { setMenuOpen(false); onDelete(bot); }}>
              <Trash2 className="size-4" aria-hidden="true" />{t("删除")}
            </Button>
          </PopoverContent>
        </Popover>
      </div>
    </Card>
  );
}

export function AgentFleetOverview({ bots, currentBotId, heroStats, canCreate, createLimitMessage, onCreate, onOpenChat, onChanged, onDelete, getAvatarForBot }: FleetOverviewProps) {
  const t = useT();
  const repositories = useRepositories();
  const { refreshBots, botsError, botsLoading } = useOpenClaw();
  const referralEnabled = useReferralEnabled();
  const [invitedFriends, setInvitedFriends] = useState<number | null>(null);
  useEffect(() => {
    setInvitedFriends(null);
    if (!referralEnabled) return;
    let cancelled = false;
    void repositories.auth.getReferralStats().then((stats) => {
      if (!cancelled) setInvitedFriends(stats.successfulReferrals ?? 0);
    }).catch(() => {
      if (!cancelled) setInvitedFriends(null);
    });
    return () => { cancelled = true; };
  }, [referralEnabled, repositories.auth]);
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState<Action | null>(null);
  const limitId = useId();
  const changed = () => { void refreshBots(); setRevision((v) => v + 1); if (action) onChanged(action.bot.id); setAction(null); };
  const { steps, writeError, isReadingSoul, applyProfile } = useOverviewProfileEditor({
    botId: action?.bot.id ?? "",
    profileId: action?.bot.profileId,
    execDebugCommand: repositories.bots.execDebugCommand,
    onProfileChanged: changed,
  });
  const savingProfile = steps !== null;
  const scrollable = bots.length > 3;
  const stripRef = useRef<HTMLDivElement>(null);
  const stripId = useId();
  const [pagination, setPagination] = useState<{ positions: number[]; active: number }>({ positions: [], active: 0 });
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !scrollable) return;
    const updatePagination = () => {
      if (!strip.clientWidth) return;
      const gap = Number.parseFloat(getComputedStyle(strip).columnGap) || 0;
      const step = strip.clientWidth + gap;
      const maxScroll = Math.max(0, strip.scrollWidth - strip.clientWidth);
      const pageCount = Math.ceil(Math.max(0, maxScroll - 1) / step) + 1;
      const positions = Array.from({ length: pageCount }, (_, index) => Math.min(index * step, maxScroll));
      // The final page can overlap the previous one; select its nearest stop.
      const active = positions.reduce((nearest, position, index) => (
        Math.abs(position - strip.scrollLeft) < Math.abs(positions[nearest]! - strip.scrollLeft) ? index : nearest
      ), 0);
      setPagination((previous) => previous.active === active && previous.positions.length === positions.length
        && previous.positions.every((position, index) => position === positions[index])
        ? previous : { positions, active });
    };
    updatePagination();
    strip.addEventListener("scroll", updatePagination, { passive: true });
    const observer = new ResizeObserver(updatePagination);
    observer.observe(strip);
    return () => { strip.removeEventListener("scroll", updatePagination); observer.disconnect(); };
  }, [scrollable, bots.length, savingProfile]);
  if (steps) return <CreatingLoadingView errorMessage={writeError} steps={steps} />;

  return (
    <div className="flex min-w-0 flex-col gap-10">
      <h2 className="-mb-4 text-[18px] font-semibold leading-6 tracking-normal text-black/[0.95]">{t("总览")}</h2>
      <HeroBanner stats={heroStats} botCount={botsLoading || botsError ? null : bots.length} invitedFriends={referralEnabled ? invitedFriends : undefined} />
      <section id="overview-bots" aria-labelledby="overview-bots-title">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 id="overview-bots-title" className="flex items-center gap-2 text-balance text-base font-semibold">{t("我的 Bots")}<span className="rounded bg-black/[0.04] px-2 py-0.5 text-xs tabular-nums">{bots.length}</span></h3>
            {scrollable && <p className="mt-1 text-pretty text-sm text-[var(--text-secondary)]">{t("左右滑动查看更多 Bot")}</p>}
          </div>
          <div className="flex items-center gap-2">
            <Button className={cn(compactButton, "rounded-full")} disabled={!canCreate || botsError || botsLoading} aria-describedby={createLimitMessage ? limitId : undefined} onClick={() => onCreate()}><Plus className="size-4" aria-hidden="true" />{t("创建 Bot")}</Button>
          </div>
        </div>
        {createLimitMessage && <p id={limitId} className="mb-4 text-pretty text-sm text-[var(--text-secondary)]">{createLimitMessage}</p>}
        {botsError && <p role="alert" className="mb-4 text-sm text-red-700">{t("Bot 列表加载失败，请刷新重试。")}</p>}
        {bots.length === 0 && !botsError && <p className="mb-4 text-sm text-[var(--text-secondary)]">{t("还没有 Bot，创建你的第一个助手")}</p>}
        <div
          ref={stripRef}
          id={stripId}
          role={scrollable ? "region" : undefined}
          aria-label={scrollable ? t("我的 Bots") : undefined}
          tabIndex={scrollable ? 0 : undefined}
          className={cn("grid min-w-0 gap-4", scrollable
            ? "grid-flow-col auto-cols-[100%] overflow-x-auto overscroll-x-contain snap-x snap-proximity [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:auto-cols-[calc((100%-1rem)/2)] lg:auto-cols-[calc((100%-2rem)/3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/30"
            : bots.length <= 1
              ? "grid-cols-1"
              : bots.length === 2
                ? "grid-cols-1 md:grid-cols-2"
                : "md:grid-cols-2 lg:grid-cols-3")}
        >
          {bots.map((bot) => <FleetBotCard key={`${bot.id}:${revision}`} bot={bot} isCurrent={bot.id === currentBotId} canDelete={!bot.isDefault || !bots.some((other) => other.id !== bot.id && (other.instanceId ?? other.id) === (bot.instanceId ?? bot.id))} fallbackAvatarUrl={getAvatarForBot(bot.id) ?? ""} canCreate={canCreate} onCreate={onCreate} onOpenChat={onOpenChat} onAction={setAction} onDelete={onDelete} />)}
        </div>
        {scrollable && pagination.positions.length > 1 && <div className="mt-2 flex items-center justify-center gap-0">
          {pagination.positions.map((position, index) => (
            <button
              key={index}
              type="button"
              aria-label={t("第 {{page}} 页，共 {{total}} 页", { page: String(index + 1), total: String(pagination.positions.length) })}
              aria-current={pagination.active === index ? "page" : undefined}
              aria-controls={stripId}
              className={cn("flex h-7 cursor-pointer items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/30", pagination.active === index ? "w-6" : "w-3")}
              onClick={() => stripRef.current?.scrollTo({ left: position, behavior: "auto" })}
            >
              <span aria-hidden="true" className={cn("h-1.5 rounded-full", pagination.active === index ? "w-5 bg-black" : "w-1.5 bg-black/20")} />
            </button>
          ))}
        </div>}
      </section>
      <LatestNewsSection />
      <RecommendedAutomationsSection />
      {action && <ProfileEditDialog
        key={action.bot.id}
        profile={action.profile}
        errorMessage={writeError}
        saving={isReadingSoul}
        onClose={() => setAction(null)}
        onSave={(next) => void applyProfile(next)}
      />}
    </div>
  );
}
