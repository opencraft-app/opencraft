import { AlertTriangle, Loader2, PackageOpen } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DisplayTitle } from "@/components/ui/display-title";
import { cn } from "@/lib/utils";

type StateVariant = "loading" | "empty" | "error";

interface StatePanelProps {
  variant: StateVariant;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
  icon?: ReactNode;
}

const icons: Record<StateVariant, ReactNode> = {
  loading: <Loader2 className="size-6 animate-spin text-[var(--brand-600)]" />,
  empty: <PackageOpen className="size-6 text-[var(--text-tertiary)]" />,
  error: <AlertTriangle className="size-6 text-[var(--danger)]" />,
};

export const StatePanel = ({
  variant,
  title,
  description,
  action,
  className,
  icon,
}: StatePanelProps) => {
  return (
    <Card
      className={cn(
        "border-dashed border-[var(--border-strong)] bg-[color-mix(in_oklab,var(--surface-muted)_72%,white)] text-center shadow-none",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <CardContent className="px-5 py-10">
        <div className="mb-3 flex justify-center">{icon ?? icons[variant]}</div>
        <DisplayTitle as="h3" size="card">
          {title}
        </DisplayTitle>
        <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-secondary)]">{description}</p>
        {action ? (
          <Button variant="outline" className="mt-5" onClick={action.onClick}>
            {action.label}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
};
