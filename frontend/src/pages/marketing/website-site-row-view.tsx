import { ExternalLink, Share2, Trash2 } from "lucide-react";
import { AgentTooltip } from "@/components/agents/agent-tooltip";
import { Button } from "@/components/ui/button";

export interface WebsiteSiteRowViewProps {
  address: string;
  metadata: string;
  status: string;
  statusClassName: string;
  notice?: { message: string; tone: "error" | "info" };
  visitUrl?: string;
  canShare: boolean;
  canDelete: boolean;
  labels: { visit: string; addressPending: string; share: string; delete: string };
  onShare: () => void;
  onDelete: (trigger: HTMLButtonElement) => void;
}

/** Account-level row. Eligibility and SiteID matching are supplied by the owning panel. */
export function WebsiteSiteRowView({ address, metadata, status, statusClassName, notice, visitUrl, canShare, canDelete, labels, onShare, onDelete }: WebsiteSiteRowViewProps) {
  return (
    <div className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_112px_120px] md:items-center md:gap-4">
      <div className="min-w-0">
        <p className="break-all text-sm font-medium text-[var(--text-primary)]">{address}</p>
        <p className="mt-1 break-words text-xs text-[var(--text-secondary)]">{metadata}</p>
        {notice && <p role={notice.tone === "error" ? "alert" : "status"} className={`mt-1 text-xs ${notice.tone === "error" ? "text-[var(--danger)]" : "text-orange-700"}`}>{notice.message}</p>}
      </div>
      <div><span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ${statusClassName}`}>{status}</span></div>
      <div className="flex items-center gap-1 md:justify-end">
        {visitUrl ? (
          <AgentTooltip content={labels.visit} triggerMode="control"><Button asChild variant="ghost" size="sm" className="size-8 rounded-md p-0"><a href={visitUrl} target="_blank" rel="noopener noreferrer" aria-label={labels.visit}><ExternalLink aria-hidden="true" className="size-4" /></a></Button></AgentTooltip>
        ) : (
          <AgentTooltip content={labels.addressPending}><Button type="button" variant="ghost" size="sm" className="size-8 rounded-md p-0" aria-label={labels.addressPending} disabled><ExternalLink aria-hidden="true" className="size-4" /></Button></AgentTooltip>
        )}
        {canShare && <AgentTooltip content={labels.share} triggerMode="control"><Button type="button" variant="ghost" size="sm" className="size-8 rounded-md p-0" aria-label={labels.share} onClick={onShare}><Share2 aria-hidden="true" className="size-4" /></Button></AgentTooltip>}
        {canDelete && <AgentTooltip content={labels.delete} triggerMode="control"><Button type="button" variant="ghost" size="sm" className="size-8 rounded-md p-0" aria-label={labels.delete} onClick={(event) => onDelete(event.currentTarget)}><Trash2 aria-hidden="true" className="size-4" /></Button></AgentTooltip>}
      </div>
    </div>
  );
}
