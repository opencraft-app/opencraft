// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { useRef } from "react";
import { CheckCircle2, Copy, EllipsisVertical, Eye, Loader2, Pause, Pencil, Play, Trash2, X, Zap } from "lucide-react";
import { AgentTooltip } from "../../components/agents/index";
import { Button } from "../../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";

export function AutomationCardActionsView({ terminal, paused, busy, testState, labels, actions }: {
  terminal: boolean;
  paused: boolean;
  busy: boolean;
  testState: "idle" | "running" | "ok" | "fail";
  labels: { edit: string; pause: string; resume: string; remove: string; menu: string; test: string; view: string; copy: string };
  actions: { edit: () => void; pause: () => void; resume: () => void; remove: () => void; test: () => void; view: (trigger: HTMLButtonElement | null) => void; copy: (trigger: HTMLButtonElement | null) => void };
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const handoff = useRef(false);
  const openDialog = (action: (trigger: HTMLButtonElement | null) => void) => {
    handoff.current = true;
    // The menu still owns focus here; pass its stable trigger explicitly.
    action(triggerRef.current);
  };
  const buttons = terminal ? [] : [
    { label: labels.edit, action: actions.edit, Icon: Pencil },
    { label: paused ? labels.resume : labels.pause, action: paused ? actions.resume : actions.pause, Icon: paused ? Play : Pause },
  ];
  return <div className="ml-auto flex shrink-0 items-center gap-1">
    {buttons.map(({ label, action, Icon }, index) => <AgentTooltip key={index} content={label} triggerMode="control">
      <Button variant="ghost" size="sm" className="size-8 rounded-md p-0" aria-label={label} disabled={busy} onClick={action}><Icon className="size-3.5" /></Button>
    </AgentTooltip>)}
    <AgentTooltip content={labels.remove} triggerMode="control">
      <Button variant="ghost" size="sm" className="size-8 rounded-md p-0" aria-label={labels.remove} disabled={busy} onClick={actions.remove}><Trash2 className="size-3.5" /></Button>
    </AgentTooltip>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button ref={triggerRef} variant="ghost" size="sm" className="size-8 rounded-md p-0" aria-label={labels.menu}><EllipsisVertical className="size-4" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent variant="product" portalClassName="agents-ui" align="end" onCloseAutoFocus={(event) => {
        if (handoff.current) { event.preventDefault(); handoff.current = false; }
      }}>
        {!terminal && <DropdownMenuItem disabled={busy || testState === "running"} onSelect={actions.test}>{testState === "running" ? <Loader2 className="size-4 animate-spin" /> : testState === "ok" ? <CheckCircle2 className="size-4 text-[#0F8A4B]" /> : testState === "fail" ? <X className="size-4 text-[#B91C1C]" /> : <Zap className="size-4" />}{labels.test}</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => openDialog(actions.view)}><Eye className="size-4" />{labels.view}</DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onSelect={() => openDialog(actions.copy)}><Copy className="size-4" />{labels.copy}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}
