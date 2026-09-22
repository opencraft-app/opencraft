import { Activity, CircleDot, Gauge, Timer } from "lucide-react";
import type { ReactNode } from "react";
import type { BotRuntime } from "@/domain/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelative } from "@/lib/utils";

interface BotStatusCardProps {
  runtime: BotRuntime;
}

const healthVariant = {
  healthy: "success",
  degraded: "warning",
  offline: "danger",
} as const;

export const BotStatusCard = ({ runtime }: BotStatusCardProps) => {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-4 text-[var(--brand-600)]" /> 运行状态
            </CardTitle>
            <CardDescription>实时执行与健康指标</CardDescription>
          </div>
          <Badge variant={healthVariant[runtime.health]}>{runtime.health}</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <Metric label="延迟 p95" value={`${runtime.latencyMs}ms`} icon={<Timer className="size-4" />} />
        <Metric label="吞吐" value={`${runtime.throughputPerMinute}/min`} icon={<Gauge className="size-4" />} />
        <Metric label="活跃会话" value={`${runtime.activeSessions}`} icon={<CircleDot className="size-4" />} />
        <Card className="rounded-2xl bg-[color-mix(in_oklab,var(--surface-base)_92%,white)] shadow-none sm:col-span-2">
          <CardContent className="p-4 text-xs text-[var(--text-secondary)]">
            最近心跳：{formatRelative(runtime.lastHeartbeatAt)}
          </CardContent>
        </Card>
      </CardContent>
    </Card>
  );
};

const Metric = ({ label, value, icon }: { label: string; value: string; icon: ReactNode }) => (
  <Card className="rounded-2xl bg-[color-mix(in_oklab,var(--surface-base)_92%,white)] shadow-none">
    <CardContent className="p-4">
      <p className="flex items-center gap-2 text-xs uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
        {icon}
        {label}
      </p>
      <p className="mt-2 text-lg font-semibold text-[var(--text-primary)]">{value}</p>
    </CardContent>
  </Card>
);
