import type { AuditEvent } from "@/domain/types";
import { formatRelative } from "@/lib/utils";

interface AuditLogTableProps {
  events: AuditEvent[];
}

export const AuditLogTable = ({ events }: AuditLogTableProps) => {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)]">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-[var(--surface-muted)] text-[var(--text-secondary)]">
          <tr>
            <th className="px-3 py-2 font-medium">Actor</th>
            <th className="px-3 py-2 font-medium">Action</th>
            <th className="px-3 py-2 font-medium">Target</th>
            <th className="px-3 py-2 font-medium">Time</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id} className="border-t border-[var(--border-subtle)]">
              <td className="px-3 py-2 text-[var(--text-primary)]">{event.actor}</td>
              <td className="px-3 py-2 text-[var(--text-secondary)]">{event.action}</td>
              <td className="px-3 py-2 text-[var(--text-secondary)]">{event.target}</td>
              <td className="px-3 py-2 text-[var(--text-tertiary)]">{formatRelative(event.timestamp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
