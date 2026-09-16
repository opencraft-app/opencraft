import { ChevronDown, X } from "lucide-react";
import { AgentTooltip } from "@/components/agents";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function AutomationDaysPickerView({ label, options, selected, onToggle, removeLabel, lastRemainingLabel, clearLabel, onClear }: {
  label: string;
  options: readonly { value: number; label: string }[];
  selected: readonly number[];
  onToggle: (value: number) => void;
  removeLabel: (value: number) => string;
  lastRemainingLabel: string;
  clearLabel?: string;
  onClear?: () => void;
}) {
  return <div className="flex min-h-9 w-[360px] max-w-full flex-wrap items-center gap-1 rounded-md border border-black/10 p-1">
    {selected.map((value) => <span key={value} className="inline-flex items-center gap-1 rounded-md bg-black/[0.06] px-2 py-1 text-xs text-black/75">
      {options.find((option) => option.value === value)?.label}
      {selected.length > 1 && <button type="button" aria-label={removeLabel(value)} onClick={() => onToggle(value)} className="inline-flex size-5 items-center justify-center rounded-md focus-visible:ring-2"><X className="size-3" /></button>}
    </span>)}
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="ml-auto size-7 rounded-md p-0" aria-label={label}><ChevronDown className="size-4" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent portalClassName="agents-ui" aria-label={label} className="max-h-[260px] overflow-y-auto">
        {options.map(({ value, label: optionLabel }) => {
          const checked = selected.includes(value);
          const last = checked && selected.length === 1;
          return <AgentTooltip key={value} triggerMode="control" content={last ? lastRemainingLabel : undefined}>
            <DropdownMenuCheckboxItem checked={checked} aria-disabled={last} onSelect={(event) => event.preventDefault()}
              onCheckedChange={() => { if (!last) onToggle(value); }} className={last ? "text-black/45" : undefined}>
              {optionLabel}
            </DropdownMenuCheckboxItem>
          </AgentTooltip>;
        })}
      </DropdownMenuContent>
    </DropdownMenu>
    {selected.length > 1 && onClear && <Button variant="ghost" size="sm" className="size-7 rounded-md p-0" aria-label={clearLabel} onClick={onClear}><X className="size-3.5" /></Button>}
  </div>;
}
