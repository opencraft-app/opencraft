import { Plus } from "lucide-react";
import type { ReactNode } from "react";

import type { OpenClawBot } from "@/contexts/agent-context";
import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";
import { GeometricAvatar } from "@/pages/marketing/agent-avatar-shapes";
import { getBotStatusColor, getBotStatusLabel } from "@/pages/marketing/agent-bot-status";
import { useBuddyProfile } from "@/pages/marketing/agent-buddy-profile";
import type { SetupExec } from "@/pages/marketing/agent-buddy-setup-runner";
import { resolveAgentDisplayName } from "@/pages/marketing/agent-provider-locale";
import { ModelActionTooltip } from "@/pages/marketing/agent-model-config/model-action-tooltip";

type AgentBotRailProps = {
  bots: OpenClawBot[];
  activeBotId?: string;
  mobile?: boolean;
  canCreate: boolean;
  createLimitMessage: string;
  profileRevision?: number;
  restartingBotIds: ReadonlySet<string>;
  execDebugCommand: SetupExec;
  onSelect: (botId: string) => void;
  onCreate: () => void;
  manageActions?: ReactNode;
};

const avatarColor = (id: string) => {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 38% 48%)`;
};

function AgentBotRailItem({ bot, active, mobile, restarting, execDebugCommand, onSelect }: { bot: OpenClawBot; active: boolean; mobile: boolean; restarting: boolean; execDebugCommand: SetupExec; onSelect: (botId: string) => void }) {
  const t = useT();
  const fallbackName = resolveAgentDisplayName(bot.name, t);
  const profile = useBuddyProfile({ botId: bot.status === "running" ? bot.id : undefined, profileId: bot.profileId, fallbackName, exec: execDebugCommand });
  const name = profile.hasBuddyConfig ? profile.profile.name : fallbackName;
  const accentColor = profile.hasBuddyConfig ? profile.profile.color : avatarColor(bot.id);
  const statusLabel = getBotStatusLabel(bot.status, restarting);
  return (
      <ModelActionTooltip content={`${name} · ${statusLabel}`} side={mobile ? "auto" : "right"} focusable={false}>
        <button
          type="button"
          className={cn("lv-agent-bot-rail-button", active && "is-active")}
          aria-label={`${t("切换到")} ${name}，${statusLabel}`}
          aria-current={active ? "true" : undefined}
          style={active && !mobile ? {
            backgroundColor: `color-mix(in srgb, ${accentColor} 8%, white)`,
          } : undefined}
          onClick={() => onSelect(bot.id)}
        >
          <span className="lv-agent-bot-rail-avatar-wrap">
            {profile.hasBuddyConfig ? (
              <GeometricAvatar shapeId={profile.profile.shapeId} color={profile.profile.color} size={34} />
            ) : (
              <span className="lv-agent-bot-rail-avatar" style={{ backgroundColor: avatarColor(bot.id) }} aria-hidden="true">
                {Array.from(name)[0] ?? "B"}
              </span>
            )}
            <span
              className={cn("lv-agent-avatar-status", !restarting && ["provisioning", "deleting", "draft"].includes(bot.status) && "lv-agent-avatar-status--blinking")}
              aria-hidden="true"
              style={{ background: getBotStatusColor(bot.status, restarting) }}
            />
          </span>
        </button>
      </ModelActionTooltip>
  );
}

export function AgentBotRail({ bots, activeBotId, mobile = false, canCreate, createLimitMessage, profileRevision = 0, restartingBotIds, execDebugCommand, onSelect, onCreate, manageActions }: AgentBotRailProps) {
  const t = useT();
  const items = bots.map((bot) => <AgentBotRailItem key={`${bot.id}:${profileRevision}`} bot={bot} active={bot.id === activeBotId} mobile={mobile} restarting={restartingBotIds.has(bot.id)} execDebugCommand={execDebugCommand} onSelect={onSelect} />);
  const create = (
    <ModelActionTooltip content={createLimitMessage || t("新建 Bot")} side={mobile ? "auto" : "right"}>
      <button type="button" className="lv-agent-bot-rail-button lv-agent-bot-rail-create" aria-label={t("新建 Bot")} disabled={!canCreate} onClick={onCreate}>
        <Plus className="size-5" aria-hidden="true" />
      </button>
    </ModelActionTooltip>
  );

  return mobile ? (
    <div className="lv-agent-bot-strip" role="group" aria-label={t("切换 Bot")}>
      {items}{create}
    </div>
  ) : (
    <aside className="lv-agent-bot-rail" aria-label={t("切换 Bot")}>
      <div className="lv-agent-bot-rail-list">{items}{create}</div>
      {manageActions && <div className="lv-agent-bot-rail-management">{manageActions}</div>}
    </aside>
  );
}
