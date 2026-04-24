import type { InviteCodeValidation } from "@/domain/types";
import { GrammarPanel } from "@/components/site/homepage-grammar";
import { Badge } from "@/components/ui/badge";

interface InviteStatusCardProps {
  result: InviteCodeValidation;
}

const badgeByState = {
  idle: "neutral",
  valid: "success",
  invalid: "danger",
  expired: "warning",
  used: "warning",
} as const;

const labelByState = {
  idle: "未校验",
  valid: "可用",
  invalid: "无效",
  expired: "已过期",
  used: "已使用",
} as const;

export const InviteStatusCard = ({ result }: InviteStatusCardProps) => {
  return (
    <GrammarPanel className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-[-0.04em]" style={{ color: "var(--lw-fg)" }}>邀请码状态</h2>
          <Badge variant={badgeByState[result.state]}>{labelByState[result.state]}</Badge>
        </div>
        <p className="text-sm leading-7 text-[var(--text-secondary)]">Lightclaw 内测资格校验结果</p>
      </div>
      <div>
        <p className="text-sm text-[var(--text-secondary)]">{result.message}</p>
      </div>
    </GrammarPanel>
  );
};
