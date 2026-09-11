import { Blocks, Bot, Cloud, Database, Folder, HardDrive, MessageSquare, Server } from "lucide-react";

export interface NavigationAction {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly active?: boolean;
  readonly onInvoke: () => void;
}

/** Shared by contributed catalogs, application lists and their entrance preview. */
export function NavigationIcon({ name, size = 15 }: { name?: string; size?: number }) {
  switch (name) {
    case "chat": return <MessageSquare size={size} />;
    case "cloud": return <Cloud size={size} />;
    case "database": return <Database size={size} />;
    case "folder": return <Folder size={size} />;
    case "hard-drive": return <HardDrive size={size} />;
    case "server": return <Server size={size} />;
    case "bot": return <Bot size={size} />;
    default: return <Blocks size={size} />;
  }
}
