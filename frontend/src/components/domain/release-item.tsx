import { GitBranch, RotateCcw } from "lucide-react";
import type { BotVersion } from "@/domain/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelative } from "@/lib/utils";

interface ReleaseItemProps {
  version: BotVersion;
}

export const ReleaseItem = ({ version }: ReleaseItemProps) => {
  return (
    <Card className="rounded-2xl shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <GitBranch className="size-4 text-[var(--brand-600)]" /> {version.label}
        </CardTitle>
        <CardDescription>
          {version.actor} · {formatRelative(version.createdAt)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-[var(--text-secondary)]">{version.notes}</p>
        </div>
        <Button variant="outline" size="sm" disabled={!version.rollbackAvailable}>
          <RotateCcw className="size-3.5" /> 回滚
        </Button>
      </CardContent>
    </Card>
  );
};
