import { useRef, type RefObject } from "react";
import { MessageSquare, MoreVertical } from "lucide-react";
import { AppLink } from "@/lib/app-navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { agentButtonClassName, agentFieldClassName, agentPortalClassName } from "@/components/agents";
import { ConsoleEditDialog } from "./console-edit-dialog";

export interface ConsoleSession { id: string; title: string; canDelete: boolean }
export interface ConsoleSessionListProps {
  sessions: readonly ConsoleSession[];
  loading: boolean;
  selectedId?: string;
  href: string;
  active: boolean;
  actionsAvailable: boolean;
  menuId: string | null;
  renameId: string | null;
  renameDraft: string;
  confirmationOpen: boolean;
  actionTriggerRef: RefObject<HTMLElement | null>;
  onMenuChange: (id: string | null) => void;
  onSelect: (id: string) => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  onRenameDraftChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onNavigate: () => void;
  labels: { navigation: string; recent: string; loading: string; defaultChat: string; actions: string; rename: string; delete: string; name: string; cancel: string; confirm: string; protectedSession: string };
}

export function ConsoleSessionList({ sessions, loading, selectedId, href, active, actionsAvailable, menuId, renameId, renameDraft, confirmationOpen, actionTriggerRef, onMenuChange, onSelect, onRename, onDelete, onRenameDraftChange, onRenameCommit, onRenameCancel, onNavigate, labels }: ConsoleSessionListProps) {
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  return <>
    <nav className="lv-agents-nav" aria-label={labels.navigation}><div className="lv-agents-nav-group" role="group"><span className="lv-agents-nav-group-label">{labels.recent}</span><ul className="lv-agents-nav-group-items">
      {loading && sessions.length === 0 ? <li className="lv-agents-session-hint flex items-center gap-2" role="status" aria-busy="true"><Skeleton className="h-3.5 w-28" /><span className="sr-only">{labels.loading}</span></li> : sessions.length === 0 ? <li><AppLink to={href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={cn("lv-agents-session-item lv-agents-nav-item", active && "is-active")}><span className="lv-agents-nav-icon"><MessageSquare className="size-4" aria-hidden="true" /></span><span className="lv-agents-session-title">{labels.defaultChat}</span></AppLink></li> : sessions.map((session) => (
        <li key={session.id} className={cn("lv-agents-session-item-wrap", selectedId === session.id && "is-active")}>
          <AppLink to={href} onClick={() => { onSelect(session.id); onNavigate(); }} aria-current={selectedId === session.id ? "page" : undefined} className="lv-agents-session-item lv-agents-nav-item"><span className="lv-agents-nav-icon"><MessageSquare className="size-4" aria-hidden="true" /></span><span className="lv-agents-session-title">{session.title}</span></AppLink>
          <DropdownMenu open={menuId === session.id} onOpenChange={(open) => onMenuChange(open ? session.id : null)}>
            <DropdownMenuTrigger asChild><button type="button" ref={(node) => { if (node) triggers.current.set(session.id, node); else triggers.current.delete(session.id); }} className="lv-agents-session-menu-btn" aria-label={labels.actions}><MoreVertical className="size-4" aria-hidden="true" /></button></DropdownMenuTrigger>
            <DropdownMenuContent variant="product" align="start" portalClassName={agentPortalClassName} onCloseAutoFocus={(event) => { if (renameId !== null || confirmationOpen) event.preventDefault(); }}>
              <DropdownMenuItem disabled={!actionsAvailable} onSelect={() => { actionTriggerRef.current = triggers.current.get(session.id) ?? null; onRename(session.id); }}>{labels.rename}</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" disabled={!actionsAvailable || !session.canDelete} onSelect={() => { actionTriggerRef.current = triggers.current.get(session.id) ?? null; onDelete(session.id); }}>{labels.delete}</DropdownMenuItem>
              {!session.canDelete && <p className="px-2.5 py-2 text-pretty text-xs text-[var(--text-secondary)]">{labels.protectedSession}</p>}
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      ))}
    </ul></div></nav>
    <ConsoleEditDialog open={renameId !== null} onOpenChange={(open) => { if (!open) onRenameCancel(); }} title={labels.rename} closeLabel={labels.cancel} returnFocusRef={actionTriggerRef} className="rounded-md border border-[var(--border-subtle)] bg-white p-5 shadow-xl md:w-96">
      <label className="block space-y-2 text-sm"><span>{labels.name}</span><Input value={renameDraft} className={agentFieldClassName} onChange={(event) => onRenameDraftChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onRenameCommit(); } }} /></label>
      <div className="mt-5 flex justify-end gap-2"><Button variant="outline" className={agentButtonClassName} onClick={onRenameCancel}>{labels.cancel}</Button><Button className={agentButtonClassName} onClick={onRenameCommit}>{labels.confirm}</Button></div>
    </ConsoleEditDialog>
  </>;
}
