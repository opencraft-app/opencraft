import { createContext, useContext } from "react";
import type { ConversationScheduleSummary, ConversationSchedulesRequestPort, OpenCraftPermissionProfile } from "@opencraft/appserver-protocol";

export interface HostScheduleCatalog {
  readonly hostId: string;
  readonly hostLabel: string;
  readonly scope: string;
  readonly schedules: readonly ConversationScheduleSummary[];
  readonly titleByThreadId?: Readonly<Record<string, string>>;
  readonly phase: "loading" | "ready" | "offline" | "error" | "unsupported";
  readonly cached: boolean;
  readonly port: ConversationSchedulesRequestPort | null;
  readonly creation?: {
    readonly calendar: boolean;
    options(): Promise<{ permissions: OpenCraftPermissionProfile[]; skills: { name: string; description: string }[] }>;
    createConversation(): Promise<string>;
    nameConversation(threadId: string, name: string): Promise<void>;
  };
  retry(): Promise<void>;
}
export interface ScheduledTaskCatalog {
  readonly scheduleCatalogs: readonly HostScheduleCatalog[];
  readonly threads: readonly { readonly id: string; readonly connectionHostId: string; readonly title: string }[];
  readonly discovery: "loading" | "error" | null;
  retryDiscovery(): Promise<void>;
  openConversation(hostId: string, threadId: string): Promise<boolean>;
}
/** The App owns one Host projection; lazy tool pages consume it without new readers. */
export const ScheduledTaskCatalogContext = createContext<ScheduledTaskCatalog | null>(null);
export function useScheduledTaskCatalog(): ScheduledTaskCatalog {
  const value = useContext(ScheduledTaskCatalogContext);
  if (!value) throw new Error("Scheduled task catalog provider is missing");
  return value;
}
