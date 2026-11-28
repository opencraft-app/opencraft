import { lazy, Suspense, useMemo } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsGroup, SettingsPageHeader, SettingsRow } from "@opencraft/extension-react";
import { useAppearanceTheme } from "../appearance-theme";
import { useValdiTouchDensity } from "./shell-navigation/valdi-sidebar-dock";
import { ModalSurface } from "./modal/modal-surface";
import { shortcutLabel, type WorkbenchShortcutCommand } from "../workbench-shortcuts";
import "./workbench-shortcut-help.scss";
import "./valdi-surfaces.scss";

const LazyValdiShortcutsSettings = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function ShortcutsSettingsMount({
    viewModel,
  }: {
    readonly viewModel: import("@opencraft/design-system-web/valdi").ShortcutsSettingsProps;
  }) {
    return (
      <mod.ValdiSurface
        component={mod.ShortcutsSettingsSurface}
        viewModel={viewModel}
        className="valdi-shortcuts-settings-surface"
        data-testid="valdi-shortcuts-settings-surface"
      />
    );
  }
  return { default: ShortcutsSettingsMount };
});

function useShortcutEntries() {
  const intl = useIntl();
  const rows = useMemo<readonly [WorkbenchShortcutCommand, string][]>(
    () => [
      ["newChat", intl.formatMessage({ id: "sidebar.newChat", defaultMessage: "New chat" })],
      ["search", intl.formatMessage({ id: "sidebar.search", defaultMessage: "Search conversations" })],
      ["settings", intl.formatMessage({ id: "settings.title", defaultMessage: "Settings" })],
      ["sidebar", intl.formatMessage({ id: "shortcuts.sidebar", defaultMessage: "Toggle sidebar" })],
      ["panel", intl.formatMessage({ id: "shortcuts.panel", defaultMessage: "Toggle tool panel" })],
      ["composer", intl.formatMessage({ id: "shortcuts.composer", defaultMessage: "Focus message input" })],
      ["agentNext", intl.formatMessage({ id: "shortcuts.agentNext", defaultMessage: "Next Agent" })],
      ["agentPrevious", intl.formatMessage({ id: "shortcuts.agentPrevious", defaultMessage: "Previous Agent" })],
      ["conversationPrevious", intl.formatMessage({ id: "shortcuts.conversationPrevious", defaultMessage: "Previous conversation" })],
      ["conversationNext", intl.formatMessage({ id: "shortcuts.conversationNext", defaultMessage: "Next conversation" })],
      ["help", intl.formatMessage({ id: "shortcuts.title", defaultMessage: "Keyboard shortcuts" })],
    ],
    [intl],
  );
  const aliasNote = intl.formatMessage(
    { id: "shortcuts.aliases", defaultMessage: "Also supported: {sidebar} for the sidebar and {panel} for the tool panel." },
    { sidebar: shortcutLabel("sidebar", navigator.platform, 1), panel: shortcutLabel("panel", navigator.platform, 1) },
  );
  return { title: intl.formatMessage({ id: "shortcuts.title", defaultMessage: "Keyboard shortcuts" }), rows, aliasNote };
}

export function ShortcutsSettingsPage() {
  const appearance = useAppearanceTheme();
  const touch = useValdiTouchDensity();
  const { title, rows, aliasNote } = useShortcutEntries();
  const viewModel = useMemo(
    (): import("@opencraft/design-system-web/valdi").ShortcutsSettingsProps => ({
      dark: appearance.resolvedTheme === "dark",
      touch,
      title,
      rows: rows.map(([id, label]) => ({ id, label, keys: shortcutLabel(id) })),
      aliasNote,
    }),
    [aliasNote, appearance.resolvedTheme, rows, title, touch],
  );
  return (
    <Suspense fallback={<SettingsPageHeader title={title} />}>
      <LazyValdiShortcutsSettings viewModel={viewModel} />
    </Suspense>
  );
}

export function WorkbenchShortcutList() {
  const { rows, aliasNote } = useShortcutEntries();
  return <div className="workbench-shortcut-list">
    <SettingsGroup>{rows.map(([command, label]) => <SettingsRow key={command} label={label} controlWidth="compact"><kbd>{shortcutLabel(command)}</kbd></SettingsRow>)}</SettingsGroup>
    <p>{aliasNote}</p>
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
