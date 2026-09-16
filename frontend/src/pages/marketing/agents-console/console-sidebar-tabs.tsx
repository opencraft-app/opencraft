import { useId, useRef, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConsoleTooltip } from "./console-tooltip";
import { cn } from "@/lib/utils";

export interface ConsoleSidebarTabsProps {
  value: "settings" | "chat";
  canChat: boolean;
  label: string;
  settingsLabel: string;
  chatLabel: string;
  unavailableLabel: string;
  onSettings: () => void;
  onChat: () => void;
  children: ReactNode;
}

export function ConsoleSidebarTabs({ value, canChat, label, settingsLabel, chatLabel, unavailableLabel, onSettings, onChat, children }: ConsoleSidebarTabsProps) {
  const repeatedPointerTab = useRef<string | null>(null);
  const unavailableId = useId();
  const intent = (tab: string) => { if (tab === "settings") onSettings(); else if (canChat) onChat(); };
  const triggerEvents = (tab: "settings" | "chat") => ({
    onPointerDown: () => { repeatedPointerTab.current = value === tab ? tab : null; },
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      if (repeatedPointerTab.current === tab || event.detail === 0) intent(tab);
      repeatedPointerTab.current = null;
    },
  });
  return <Tabs value={value} onValueChange={intent} className={cn("flex flex-col", value === "settings" ? "shrink-0" : "min-h-0")}>
    <TabsList aria-label={label} className="mb-3 grid h-10 w-full grid-cols-2 rounded-md bg-[var(--surface-muted)] p-1 shadow-none">
      <TabsTrigger value="settings" className="min-w-0 rounded-sm px-3 text-sm" {...triggerEvents("settings")}>{settingsLabel}</TabsTrigger>
      <ConsoleTooltip content={canChat ? undefined : unavailableLabel} className="h-full min-h-0 min-w-0" label={unavailableLabel}>
        <TabsTrigger value="chat" disabled={!canChat} aria-describedby={canChat ? undefined : unavailableId} className="w-full min-w-0 rounded-sm px-3 text-sm" {...triggerEvents("chat")}>{chatLabel}</TabsTrigger>
      </ConsoleTooltip>
    </TabsList>
    {!canChat && <span id={unavailableId} className="sr-only">{unavailableLabel}</span>}
    <TabsContent value={value} className="mt-0 min-h-0">{children}</TabsContent>
  </Tabs>;
}
