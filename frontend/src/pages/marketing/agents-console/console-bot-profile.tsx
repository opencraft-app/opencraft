import type { ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { agentPortalClassName } from "@/components/agents";

export interface ConsoleBotProfileProps {
  name: string;
  avatarUrl?: string;
  status: ReactNode;
  actions?: ReactNode;
  renewal?: ReactNode;
  error?: ReactNode;
  createAction?: ReactNode;
  options: readonly { id: string; label: string }[];
  selectedId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
}

export function ConsoleBotProfile({ name, avatarUrl, status, actions, renewal, error, createAction, options, selectedId, open, onOpenChange, onSelect }: ConsoleBotProfileProps) {
  const identity = <><img src={avatarUrl} alt="" className="size-9 shrink-0 object-contain" /><span className="min-w-0 flex-1 truncate text-left text-sm font-semibold">{name}</span></>;
  return <div className="lv-agent-profile-wrap">
    <div className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        {options.length > 1 ? (
          <DropdownMenu open={open} onOpenChange={onOpenChange}>
            <DropdownMenuTrigger asChild><button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-[var(--text-primary)] hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">{identity}<ChevronDown className="size-4 shrink-0" aria-hidden="true" /></button></DropdownMenuTrigger>
            <DropdownMenuContent align="start" portalClassName={agentPortalClassName} className="min-w-56">
              {options.map((bot) => <DropdownMenuItem key={bot.id} onSelect={() => onSelect(bot.id)} aria-current={bot.id === selectedId ? "true" : undefined}><span className="min-w-0 flex-1 truncate">{bot.label}</span>{bot.id === selectedId && <Check className="size-4 shrink-0" aria-hidden="true" />}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : <div className="flex min-w-0 items-center gap-2 px-1 py-1">{identity}</div>}
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 px-1 text-xs text-[var(--text-secondary)]">{status}{renewal}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1 pt-1">{actions}</div>
    </div>
    {error && <div role="alert" className="mt-2 text-pretty text-xs leading-5 text-red-600">{error}</div>}
    {createAction && <div className="mt-3">{createAction}</div>}
  </div>;
}
