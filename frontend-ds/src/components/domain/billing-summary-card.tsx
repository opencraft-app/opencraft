import { Coins, Gauge, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import type { BillingSummary } from "@/domain/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

interface BillingSummaryCardProps {
  summary: BillingSummary;
}

export const BillingSummaryCard = ({ summary }: BillingSummaryCardProps) => {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="size-4 text-[var(--brand-600)]" /> 成本摘要
        </CardTitle>
        <CardDescription>当前消耗与月度预算预测</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        <Metric icon={<Coins className="size-4" />} label="本月成本" value={formatCurrency(summary.monthCost)} />
        <Metric icon={<Gauge className="size-4" />} label="月末预测" value={formatCurrency(summary.estimatedMonthEnd)} />
        <Metric icon={<Wallet className="size-4" />} label="预算上限" value={formatCurrency(summary.budgetLimit)} />
      </CardContent>
    </Card>
  );
};

const Metric = ({ icon, label, value }: { icon: ReactNode; label: string; value: string }) => (
  <Card className="rounded-2xl bg-[color-mix(in_oklab,var(--surface-base)_92%,white)] shadow-none">
    <CardContent className="p-4">
      <p className="flex items-center gap-1 text-xs uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
        {icon}
        {label}
      </p>
      <p className="mt-2 text-lg font-semibold text-[var(--text-primary)]">{value}</p>
    </CardContent>
  </Card>
);
