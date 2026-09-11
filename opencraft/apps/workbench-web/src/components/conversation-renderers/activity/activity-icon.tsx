import type { ToolActivityIcon } from "@opencraft/chat-core";
import { Bot, ImageIcon, Monitor, Wrench } from "lucide-react";
import type { ReactNode } from "react";

import {
  CodexFilesActivityIcon,
  CodexGlobeActivityIcon,
  CodexPatchActivityIcon,
  CodexReadActivityIcon,
  CodexSearchActivityIcon,
  CodexStopActivityIcon,
  CodexTerminalActivityIcon,
} from "../../codex-activity-icons";

export function activityIcon(icon: ToolActivityIcon): ReactNode {
  if (icon === "none") return null;
  if (icon === "terminal") return <CodexTerminalActivityIcon aria-hidden="true" data-codex-activity-icon="terminal" />;
  if (icon === "patch") return <CodexPatchActivityIcon aria-hidden="true" data-codex-activity-icon="patch" />;
  if (icon === "search") return <CodexSearchActivityIcon aria-hidden="true" data-codex-activity-icon="search" />;
  if (icon === "read") return <CodexReadActivityIcon aria-hidden="true" data-codex-activity-icon="read" />;
  if (icon === "files") return <CodexFilesActivityIcon aria-hidden="true" data-codex-activity-icon="files" />;
  if (icon === "stop") return <CodexStopActivityIcon aria-hidden="true" data-codex-activity-icon="stop" />;
  if (icon === "image") return <ImageIcon size={14} />;
  if (icon === "agent") return <Bot size={14} />;
  if (icon === "browser") return <CodexGlobeActivityIcon aria-hidden="true" data-codex-activity-icon="browser" />;
  if (icon === "computer") return <Monitor size={14} />;
  return <Wrench size={14} />;
}
