import { Clock3 } from "lucide-react";
import type { AuditEvent } from "@/domain/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelative } from "@/lib/utils";

interface EventFeedProps {
  events: AuditEvent[];
}

export const EventFeed = ({ events }: EventFeedProps) => {
  return (
    <Card>
      <CardHeader>
        <CardTitle>事件流</CardTitle>
        <CardDescription>最新配置改动与执行记录</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {events.map((event) => (
          <Card key={event.id} className="rounded-2xl shadow-none">
            <CardContent className="p-4">
              <p className="text-sm font-medium text-[var(--text-primary)]">
                {event.actor} {event.action} {event.target}
              </p>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">{event.detail}</p>
              <p className="mt-2 flex items-center gap-1 text-xs text-[var(--text-tertiary)]">
                <Clock3 className="size-3" /> {formatRelative(event.timestamp)}
              </p>
            </CardContent>
          </Card>
        ))}
      </CardContent>
    </Card>
  );
};
