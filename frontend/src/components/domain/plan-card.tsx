import { Check } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { PlanOption } from "@/domain/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/t";

interface PlanCardProps {
  plan: PlanOption;
  selected?: boolean;
  loading?: boolean;
  onSelect?: () => void;
}

const onCardKeyDown =
  (handler?: () => void) =>
  (event: KeyboardEvent<HTMLDivElement>) => {
    if (!handler) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handler();
    }
  };

export const PlanCard = ({ plan, selected = false, loading = false, onSelect }: PlanCardProps) => {
  const t = useT();
  const interactive = plan.available && !!onSelect;

  return (
    <Card
      className={cn(
        "flex h-full flex-col transition-all duration-200",
        selected
          ? "border-[var(--text-primary)] bg-[color-mix(in_oklab,var(--surface-contrast)_38%,white)] ring-2 ring-[color-mix(in_oklab,var(--brand-500)_28%,white)]"
          : "bg-white",
        interactive && "cursor-pointer hover:-translate-y-[1px] hover:border-[var(--border-strong)]",
        !plan.available && "opacity-90",
      )}
      onClick={interactive ? onSelect : undefined}
      onKeyDown={interactive ? onCardKeyDown(onSelect) : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
    >
      <CardHeader className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>{plan.name}</CardTitle>
            <CardDescription>{plan.description}</CardDescription>
          </div>
          <Badge variant={plan.available ? (selected ? "success" : "neutral") : "warning"}>
            {plan.available ? (selected ? t("当前可用") : t("可选择")) : t("即将推出")}
          </Badge>
        </div>

        <div className="space-y-1">
          <p className="text-3xl font-semibold tracking-[-0.04em] text-[var(--text-primary)]">{plan.priceLabel}</p>
          <p className="text-sm text-[var(--text-secondary)]">{plan.priceNote}</p>
        </div>
      </CardHeader>

      <CardContent className="flex-1">
        <ul className="space-y-3 text-sm text-[var(--text-secondary)]">
          {plan.features.map((feature) => (
            <li key={feature} className="flex items-start gap-2">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--text-primary)]">
                <Check className="size-3.5" />
              </span>
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </CardContent>

      <CardFooter className="mt-auto">
        <Button
          variant={selected && plan.available ? "default" : "outline"}
          className="w-full"
          disabled={!plan.available || loading}
          onClick={(event) => {
            event.stopPropagation();
            onSelect?.();
          }}
        >
          {loading && plan.available ? t("确认中...") : plan.ctaLabel}
        </Button>
      </CardFooter>
    </Card>
  );
};
