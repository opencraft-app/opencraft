import { CheckIcon as Check } from "@opencraft/design-system-web/action-icons";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";

import { useIntl } from "@opencraft/i18n/react";
import type { ThreadListGroupingContribution, ThreadListGroupingSnapshot, ThreadListLabel } from "@opencraft/extension-react";

export function ThreadListModeItems({ contribution, snapshot, kind, onSelect }: {
  contribution: ThreadListGroupingContribution | null; snapshot: ThreadListGroupingSnapshot;
  kind: "context" | "dropdown"; onSelect?: () => void;
}) {
  const intl = useIntl();
  const Menu = kind === "context" ? ContextMenu : DropdownMenu;
  const label = (value: ThreadListLabel) => typeof value === "string" ? value : intl.formatMessage(value);
  const defaultLabel = intl.formatMessage({ id: "sidebar.displayMode.default", defaultMessage: "Task flow" });
  return <>
    <Menu.Label className="sidebar-display-mode-label">{intl.formatMessage({ id: "sidebar.displayMode", defaultMessage: "Display mode" })}</Menu.Label>
    <Menu.RadioGroup value={snapshot.mode ?? ""} onValueChange={value => { contribution?.setMode(value || null); onSelect?.(); }}>
      {[{ id: "", label: defaultLabel }, ...snapshot.modes].map(mode => <Menu.RadioItem className="sidebar-list-mode-item" key={mode.id} value={mode.id}>
        <Menu.ItemIndicator className="sidebar-list-mode-indicator"><Check size={13} aria-hidden="true" /></Menu.ItemIndicator><span className="sidebar-list-mode-text">{label(mode.label)}</span>
      </Menu.RadioItem>)}
    </Menu.RadioGroup>
    {snapshot.filter && contribution?.setFilterEnabled ? <>
      <Menu.Separator />
      <Menu.Label className="sidebar-display-mode-label">{intl.formatMessage({ id: "sidebar.filters", defaultMessage: "Filters" })}</Menu.Label>
      <Menu.CheckboxItem className="sidebar-list-mode-item" checked={snapshot.filter.enabled} onCheckedChange={enabled => { contribution.setFilterEnabled!(enabled === true); onSelect?.(); }}>
        <Menu.ItemIndicator className="sidebar-list-mode-indicator"><Check size={13} aria-hidden="true" /></Menu.ItemIndicator>
        <span className="sidebar-list-mode-text">{intl.formatMessage({ id: "sidebar.onlyMine", defaultMessage: "Only my conversations" })}</span>
      </Menu.CheckboxItem>
    </> : null}
  </>;
}
