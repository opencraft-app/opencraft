import { Blocks, Bot, Cloud, Columns3, Database, Folder, HardDrive, LayoutGrid, MessageCircle, MessageSquare, Server, Settings, SquarePen, type LucideIcon } from "lucide-react";
import { createElement } from "react";

export interface NavigationAction {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly active?: boolean;
  readonly onInvoke: () => void;
}

/** Semantic glyph mapping is platform-owned; CSS tokens own the physical scale. */
export function NavigationIcon({ name, size = 15, selected = false }: {
  name?: string;
  size?: number;
  selected?: boolean;
}) {
  let icon: LucideIcon;
  // Only closed silhouettes can be filled. A server's lights, a Bot's face or
  // a gear's hub must not disappear under a generic `svg { fill }` rule.
  let silhouette = false;
  switch (name) {
    case "chat": icon = MessageSquare; silhouette = true; break;
    case "write": icon = SquarePen; break;
    case "message-circle": icon = MessageCircle; silhouette = true; break;
    case "cloud": icon = Cloud; silhouette = true; break;
    case "database": icon = Database; break;
    case "folder": icon = Folder; silhouette = true; break;
    case "hard-drive": icon = HardDrive; break;
    case "server": icon = Server; break;
    case "bot": icon = Bot; break;
    case "settings": icon = Settings; break;
    case "applications": icon = LayoutGrid; silhouette = true; break;
    case "columns": icon = Columns3; break;
    default: icon = Blocks; break;
  }
  const props = {
    size,
    "aria-hidden": true,
    focusable: false,
    "data-navigation-glyph-variant": selected ? "selected" : "outline",
    fill: selected && silhouette ? "currentColor" : "none",
    strokeWidth: selected && !silhouette ? 2.5 : 2,
  };
  return createElement(icon, props);
}
