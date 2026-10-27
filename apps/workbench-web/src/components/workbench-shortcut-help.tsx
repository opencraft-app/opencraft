import { useIntl } from "@opencraft/i18n/react";
import { ModalSurface } from "./modal/modal-surface";
import { shortcutLabel, type WorkbenchShortcutCommand } from "../workbench-shortcuts";
import "./workbench-shortcut-help.scss";

export function WorkbenchShortcutList() {
  const intl = useIntl();
  const rows: readonly [WorkbenchShortcutCommand, string][] = [
    ["newChat", intl.formatMessage({ id: "sidebar.newChat", defaultMessage: "New chat" })],
    ["search", intl.formatMessage({ id: "sidebar.search", defaultMessage: "Search conversations" })],
    ["settings", intl.formatMessage({ id: "settings.title", defaultMessage: "Settings" })],
    ["sidebar", intl.formatMessage({ id: "shortcuts.sidebar", defaultMessage: "Toggle sidebar" })],
    ["panel", intl.formatMessage({ id: "shortcuts.panel", defaultMessage: "Toggle tool panel" })],
    ["composer", intl.formatMessage({ id: "shortcuts.composer", defaultMessage: "Focus message input" })],
    ["help", intl.formatMessage({ id: "shortcuts.title", defaultMessage: "Keyboard shortcuts" })],
  ];
  return <div className="workbench-shortcut-list">
    <dl>{rows.map(([command, label]) => <div key={command}><dt>{label}</dt><dd><kbd>{shortcutLabel(command)}</kbd></dd></div>)}</dl>
    <p>{intl.formatMessage({ id: "shortcuts.aliases", defaultMessage: "Also supported: {sidebar} for the sidebar and {panel} for the tool panel." }, {
      sidebar: shortcutLabel("sidebar", navigator.platform, 1), panel: shortcutLabel("panel", navigator.platform, 1),
    })}</p>
  </div>;
}

export function WorkbenchShortcutHelp({ onClose }: { onClose(): void }) {
  const intl = useIntl();
  return <ModalSurface label={intl.formatMessage({ id: "shortcuts.title", defaultMessage: "Keyboard shortcuts" })}
    appearance="utility" size="compact" className="workbench-shortcut-help" onDismiss={onClose}>
    <h2>{intl.formatMessage({ id: "shortcuts.title", defaultMessage: "Keyboard shortcuts" })}</h2>
    <WorkbenchShortcutList />
  </ModalSurface>;
}
