import { AlertCircle, AlertTriangle, BellRing } from "lucide-react";
import type { AlertItem } from "@/domain/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelative } from "@/lib/utils";

interface AlertCardProps {
  alert: AlertItem;
}

const severityIcon = {
  critical: <AlertCircle className="size-4" />,
  warning: <AlertTriangle className="size-4" />,
  info: <BellRing className="size-4" />,
};

const severityBadge = {
  critical: "danger",
  warning: "warning",
  info: "neutral",
} as const;

export const AlertCard = ({ alert }: AlertCardProps) => {
  return (
    <Card className="border-l-4 border-l-[var(--warning)] shadow-none">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {severityIcon[alert.severity]}
            {alert.title}
          </CardTitle>
          <Badge variant={severityBadge[alert.severity]}>{alert.severity}</Badge>
        </div>
        <CardDescription>{formatRelative(alert.createdAt)}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-sm text-[var(--text-secondary)]">{alert.message}</p>
      </CardContent>
    </Card>
  );
};
