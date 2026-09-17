import { useId, useRef, type ReactNode } from "react";
import { AgentTabsList, AgentTabsTrigger } from "@/components/agents";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { ConsoleTooltip } from "./console-tooltip";
import { cn } from "@/lib/utils";

// Keep the sidebar treatment local; other AgentTabs retain their own borders.
const sidebarTriggerClassName = "min-w-0 border-0 bg-transparent px-3 py-0 text-sm transition-none focus-visible:ring-offset-2 data-[state=active]:shadow-sm";

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
    <AgentTabsList variant="segmented" aria-label={label} className="mb-3 grid h-10 w-full grid-cols-2 gap-1 border-0 p-1">
      <AgentTabsTrigger variant="segmented" value="settings" className={sidebarTriggerClassName} {...triggerEvents("settings")}>{settingsLabel}</AgentTabsTrigger>
      <ConsoleTooltip content={canChat ? undefined : unavailableLabel} className="h-full min-h-0 min-w-0" label={unavailableLabel}>
        <AgentTabsTrigger variant="segmented" value="chat" disabled={!canChat} aria-describedby={canChat ? undefined : unavailableId} className={cn(sidebarTriggerClassName, "w-full")} {...triggerEvents("chat")}>{chatLabel}</AgentTabsTrigger>
      </ConsoleTooltip>
    </AgentTabsList>
    {!canChat && <span id={unavailableId} className="sr-only">{unavailableLabel}</span>}
    <TabsContent value={value} className="mt-0 min-h-0">{children}</TabsContent>
  </Tabs>;
}
