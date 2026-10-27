import { CONNECTOR_CATALOG, type ConnectorDefinition } from "@opencraft/connector-core";
import type { ComponentType } from "react";
import type { ActionIconProps } from "@opencraft/design-system-web/action-icons";
import { BookIcon as BookOpen, BriefcaseIcon as BriefcaseBusiness, TasksIcon as ListTodo, LocationIcon as MapPin, PlayIcon as Play, PlugIcon as Plug, BalanceIcon as Scale, ServerIcon as Server } from "@opencraft/design-system-web/action-icons";
import { createElement } from "react";

// These describe service categories, not third-party brands. Service names
// remain visible in the owning card, setup heading or quick-picker row.
const categoryIcons: Readonly<Record<ConnectorDefinition["category"], ComponentType<ActionIconProps>>> = {
  "办公": BriefcaseBusiness,
  "知识": BookOpen,
  "效率": ListTodo,
  "媒体": Play,
  "出行": MapPin,
  "专业": Scale,
  "自托管": Server,
};

export function ConnectorIcon({ id }: { readonly id: string }) {
  const category = CONNECTOR_CATALOG.find(entry => entry.id === id)?.category;
  const Icon = category === undefined ? Plug : categoryIcons[category];
  return createElement("span", { className: "connector-icon", "aria-hidden": true }, createElement(Icon, { size: 22 }));
}
