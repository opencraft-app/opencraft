import type { VirtualSkillInputItem } from "../types/virtual-skill.ts";

export const BUILTIN_VIRTUAL_SKILL_ALIASES: ReadonlySet<string> = new Set([
  "users", "user-list", "members",
  "accounts", "account-list", "list-accounts",
  "shared-codex", "codex-share", "public-codex", "共享Codex",
  "models", "model-providers", "model-gateway",
  "sessions", "active-sessions", "thread-activity", "leases",
  "codex-account", "account", "bind-codex", "account-add",
  "evolution", "policy-status", "hot-upgrade",
  "search", "search-conversations", "global-search", "conversation-search",
  "calculator", "calc", "currency-converter", "fx-calculator",
  "private-thread", "thread-privacy", "make-private", "private-conversation",
  "thread-visibility", "share-thread", "make-shared", "public-thread", "visibility",
  "set-visibility",
  "session-status", "current-session", "thread-status", "engine-status", "model-status",
]);

export function hasExplicitBuiltinVirtualSkill(
  input: VirtualSkillInputItem[] = [],
): boolean {
  const candidates: string[] = [];
  for (const item of input) {
    if (typeof item.name === "string") candidates.push(item.name);
    if (typeof item.path === "string") {
      const pathName = item.path.match(/\/skills\/([^/]+)\/SKILL\.md(?:$|[?#])/i)?.[1];
      if (pathName) candidates.push(pathName);
    }
    if (item.type !== "text" || typeof item.text !== "string") continue;
    const text = item.text.replaceAll("&#x20;", " ");
    for (const match of text.matchAll(/\[\$([^\]]+)\]\(([^)]+)\)/g)) {
      const name = match[1];
      if (name) candidates.push(name);
      const target = match[2];
      const pathName = target?.match(/\/skills\/([^/]+)\/SKILL\.md(?:$|[?#])/i)?.[1];
      if (pathName) candidates.push(pathName);
    }
    const mention = text.match(/(?:^|\s)\$([\w-]+)/)?.[1];
    if (mention) candidates.push(mention);
  }
  return candidates.some((candidate) => BUILTIN_VIRTUAL_SKILL_ALIASES.has(candidate));
}
