import type { IntlShape } from "@opencraft/i18n";
import type { NavigationAction } from "./navigation-action";

// Only Shell-owned destinations select renderer copy by ID. Extension labels
// are resolved from their declarations before reaching the Shell.
const labels = {
  "shell.home": { full: { id: "navigation.home", defaultMessage: "Home" }, short: { id: "navigation.home", defaultMessage: "Home" } },
  "shell.start": { full: { id: "sidebar.rail.start", defaultMessage: "Start" }, short: { id: "sidebar.rail.start.short", defaultMessage: "Start" } },
  "shell.chat": { full: { id: "sidebar.rail.chat", defaultMessage: "Chats" }, short: { id: "sidebar.rail.chat.short", defaultMessage: "Chats" } },
};

export function shellNavigationLabels(action: NavigationAction, intl: IntlShape) {
  const copy = labels[action.id as keyof typeof labels];
  return copy ? { full: intl.formatMessage(copy.full), short: intl.formatMessage(copy.short) }
    : { full: action.title, short: action.shortTitle ?? action.title };
}
