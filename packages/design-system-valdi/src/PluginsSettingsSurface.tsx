import { StatefulComponent } from "valdi_core/src/Component";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { registerHapticHandler, triggerHaptic } from "./haptics";
import { Icon, type IconName } from "./Icon";
import { SegmentedControl } from "./SegmentedControl";
import { SettingsGroup, SettingsListItem, SettingsPageHeader } from "./SettingsGroup";
import { TextField } from "./TextField";
import { Toggle } from "./Toggle";
import { themeColors, themeMetrics } from "./tokens";

export type PluginCatalogItem = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly source: "builtin" | "installed";
  readonly sourceLabel: string;
  readonly statusTone: "active" | "inactive" | "warning" | "danger";
  readonly statusLabel: string;
  readonly description: string;
  readonly metadata: string;
  readonly icon: IconName;
  readonly enabled: boolean;
  readonly canManage: boolean;
  readonly busy?: boolean;
  readonly error?: string;
  readonly toggleLabel: string;
  readonly openDetailLabel: string;
};

export type PluginDetailModel = {
  readonly id: string;
  readonly name: string;
  readonly versionMetadata: string;
  readonly statusLabel: string;
  readonly statusTone: "active" | "inactive" | "warning" | "danger";
  readonly statusError?: string;
  readonly intentLabel: string;
  readonly capabilitiesText: string;
  readonly sourceUrl?: string;
  readonly updateError?: string;
  readonly actionError?: string;
  readonly canManage: boolean;
  readonly canReload: boolean;
  readonly canRemove: boolean;
  readonly enabled: boolean;
  readonly busy?: boolean;
  readonly icon: IconName;
};

export type PluginsSettingsProps = {
  dark?: boolean;
  touch?: boolean;
  showHeader?: boolean;
  badgeLabel: string;
  title: string;
  subtitle: string;
  searchLabel: string;
  searchPlaceholder: string;
  clearLabel: string;
  sourceFilterLabel: string;
  sourceAllLabel: string;
  sourceBuiltinLabel: string;
  sourceInstalledLabel: string;
  listGroupTitle: string;
  emptyTitle: string;
  noMatchTitle: string;
  backLabel: string;
  detailGroupTitle: string;
  statusRowTitle: string;
  intentRowTitle: string;
  capabilitiesRowTitle: string;
  sourceUrlRowTitle: string;
  updateFailedRowTitle: string;
  updateFailedRowDetail: string;
  enableActionLabel: string;
  disableActionLabel: string;
  reloadActionLabel: string;
  removeActionLabel: string;
  builtinManagedTitle: string;
  builtinManagedMessage: string;
  developerMode?: boolean;
  installGroupTitle: string;
  installUrlLabel: string;
  installUrlPlaceholder: string;
  installActionLabel: string;
  installBusy?: boolean;
  installError?: string;
  confirmRemoveTitle: string;
  confirmRemoveMessage: string;
  confirmRemoveConfirmLabel: string;
  confirmRemoveCancelLabel: string;
  alerts: readonly string[];
  items: readonly PluginCatalogItem[];
  detail?: PluginDetailModel;
  onSelectPlugin: (id: string | null) => void;
  onTogglePlugin: (id: string, enabled: boolean) => void;
  onReloadPlugin: (id: string) => void;
  onRequestRemovePlugin: (id: string) => void;
  onInstallUrl: (url: string) => void;
  confirmingRemoveId?: string | null;
  onConfirmRemove: (id: string) => void;
  onCancelRemove: () => void;
  onHaptic?: (style: string) => void;
};

type State = {
  query: string;
  sourceFilter: "all" | "builtin" | "installed";
  installUrl: string;
};

/**
 * Adaptive OpenCraft Valdi surface for Settings -> Plugins (ExtensionLibrary).
 * Aligns with `.settings-control-list-item`, `.settings-control-pair`, and macOS/iPadOS dual density.
 */
export class PluginsSettingsSurface extends StatefulComponent<PluginsSettingsProps, State> {
  state: State = {
    query: "",
    sourceFilter: "all",
    installUrl: "",
  };

  onCreate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
  }

  onViewModelUpdate(previous?: Readonly<PluginsSettingsProps>): void {
    registerHapticHandler(this.viewModel.onHaptic);
    if (previous?.installBusy && !this.viewModel.installBusy && !this.viewModel.installError && this.state.installUrl) {
      this.setState({ installUrl: "" });
    }
  }

  private statusDotColor(tone: PluginCatalogItem["statusTone"], dark: boolean): string {
    const c = themeColors(dark);
    if (tone === "active") return c.success;
    if (tone === "danger") return c.danger;
    if (tone === "warning") return c.warning;
    return c.disabled;
  }

  private submitInstall(): void {
    const trimmed = this.state.installUrl.trim();
    if (!trimmed || this.viewModel.installBusy) return;
    triggerHaptic("medium");
    this.viewModel.onInstallUrl(trimmed);
  }

  onRender(): void {
    const vm = this.viewModel;
    const dark = Boolean(vm.dark);
    const showHeader = vm.showHeader !== false;
    const c = themeColors(dark);
    const m = themeMetrics(vm.touch);
    const detail = vm.detail;

    const normalizedQuery = this.state.query.trim().toLowerCase();
    const filteredItems = vm.items.filter((item) => {
      if (this.state.sourceFilter !== "all" && item.source !== this.state.sourceFilter) return false;
      if (!normalizedQuery) return true;
      return `${item.name} ${item.id} ${item.version} ${item.description}`.toLowerCase().includes(normalizedQuery);
    });

    <view width="100%">
      <view width="100%" gap={28}>
        {showHeader && !detail && (
          <SettingsPageHeader title={vm.title} description={vm.subtitle} touch={vm.touch} dark={dark} />
        )}

        {vm.alerts.forEach((alert, idx) => {
          <Banner
            key={`alert-${idx}`}
            id={`oc-plugins-alert-${idx}`}
            tone="danger"
            title={alert}
            touch={vm.touch}
            dark={dark}
          />;
        })}

        {detail ? (
          <view gap={24}>
            {/* Canonical SettingsMachineIdentity-style Back Action + Subject Header */}
            <view gap={14}>
              <view flexDirection="row" alignItems="center" marginLeft={-8}>
                <view
                  class="oc-ghost-button"
                  accessibilityId="oc-plugins-back"
                  accessibilityLabel={vm.backLabel}
                  accessibilityCategory="button"
                  onTap={() => {
                    triggerHaptic("selection");
                    vm.onSelectPlugin(null);
                  }}
                  minHeight={m.sizes.buttonSmHeight}
                  paddingLeft={8}
                  paddingRight={10}
                  borderRadius={m.radii.control - 1}
                  flexDirection="row"
                  alignItems="center"
                  gap={6}
                >
                  <Icon name="arrowLeft" size={14} color={c.muted} />
                  <label value={vm.backLabel} font={m.fonts.body} color={c.muted} />
                </view>
              </view>

              <view flexDirection="row" alignItems="center" gap={12}>
                <view
                  width={44}
                  height={44}
                  borderRadius={12}
                  backgroundColor={c.recessed}
                  alignItems="center"
                  justifyContent="center"
                  accessibilityNavigation="ignored"
                >
                  <Icon name={detail.icon} size={20} color={c.muted} />
                </view>
                <view flexGrow={1} flexShrink={1} minWidth={0} gap={4}>
                  <label
                    value={detail.name}
                    font={m.fonts.pageTitle}
                    color={c.ink}
                    accessibilityCategory="header"
                    numberOfLines={0}
                  />
                  <label
                    value={`${detail.id} · ${detail.versionMetadata}`}
                    font={m.fonts.detail}
                    color={c.muted}
                    numberOfLines={2}
                  />
                </view>
                <view flexDirection="row" alignItems="center" gap={6}>
                  <view
                    width={7}
                    height={7}
                    borderRadius={3.5}
                    backgroundColor={this.statusDotColor(detail.statusTone, dark)}
                    accessibilityNavigation="ignored"
                  />
                  <label value={detail.statusLabel} font={m.fonts.detail} color={c.muted} />
                </view>
              </view>
            </view>

            <SettingsGroup title={vm.detailGroupTitle} touch={vm.touch} dark={dark}>
              <view
                minHeight={m.sizes.rowMinHeight}
                paddingLeft={16}
                paddingRight={16}
                paddingTop={12}
                paddingBottom={12}
                gap={4}
              >
                <view flexDirection="row" justifyContent="space-between" alignItems="center" gap={16}>
                  <label value={vm.statusRowTitle} font={m.fonts.rowTitle} color={c.ink} />
                  <label value={detail.statusLabel} font={m.fonts.body} color={c.muted} />
                </view>
                {detail.statusError && (
                  <label value={detail.statusError} font={m.fonts.detail} color={c.danger} numberOfLines={0} />
                )}
              </view>

              <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />
              <view
                minHeight={m.sizes.rowMinHeight}
                paddingLeft={16}
                paddingRight={16}
                paddingTop={12}
                paddingBottom={12}
                flexDirection="row"
                justifyContent="space-between"
                alignItems="center"
                gap={16}
              >
                <label value={vm.intentRowTitle} font={m.fonts.rowTitle} color={c.ink} />
                <label value={detail.intentLabel} font={m.fonts.body} color={c.muted} />
              </view>

              <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />
              <view
                minHeight={m.sizes.rowMinHeight}
                paddingLeft={16}
                paddingRight={16}
                paddingTop={12}
                paddingBottom={12}
                flexDirection="row"
                justifyContent="space-between"
                alignItems="center"
                gap={16}
              >
                <label value={vm.capabilitiesRowTitle} font={m.fonts.rowTitle} color={c.ink} />
                <label
                  value={detail.capabilitiesText}
                  font={m.fonts.body}
                  color={c.muted}
                  maxWidth="65%"
                  flexShrink={1}
                  textAlign="right"
                  numberOfLines={0}
                />
              </view>

              {detail.sourceUrl && (
                <view>
                  <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />
                  <view
                    minHeight={m.sizes.rowMinHeight}
                    paddingLeft={16}
                    paddingRight={16}
                    paddingTop={12}
                    paddingBottom={12}
                    flexDirection="row"
                    justifyContent="space-between"
                    alignItems="center"
                    gap={16}
                  >
                    <label value={vm.sourceUrlRowTitle} font={m.fonts.rowTitle} color={c.ink} />
                    <label
                      value={detail.sourceUrl}
                      font={m.fonts.detail}
                      color={c.muted}
                      maxWidth="65%"
                      flexShrink={1}
                      textAlign="right"
                      numberOfLines={0}
                    />
                  </view>
                </view>
              )}

              {detail.updateError && (
                <view>
                  <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />
                  <view paddingLeft={16} paddingRight={16} paddingTop={12} paddingBottom={12} gap={4}>
                    <label value={vm.updateFailedRowTitle} font={m.fonts.rowTitle} color={c.ink} />
                    <label value={vm.updateFailedRowDetail} font={m.fonts.detail} color={c.muted} numberOfLines={0} />
                    <label value={detail.updateError} font={m.fonts.detail} color={c.danger} numberOfLines={0} />
                  </view>
                </view>
              )}
            </SettingsGroup>

            {detail.actionError && (
              <Banner
                id="oc-plugins-detail-error"
                tone="danger"
                title={detail.actionError}
                touch={vm.touch}
                dark={dark}
              />
            )}

            {detail.canManage ? (
              <view flexDirection="row" flexWrap="wrap" gap={8}>
                <Button
                  id="oc-plugins-detail-toggle"
                  title={detail.enabled ? vm.disableActionLabel : vm.enableActionLabel}
                  variant="primary"
                  size="sm"
                  touch={vm.touch}
                  disabled={detail.busy}
                  dark={dark}
                  onPress={() => {
                    triggerHaptic("selection");
                    vm.onTogglePlugin(detail.id, !detail.enabled);
                  }}
                />
                {detail.canReload && (
                  <Button
                    id="oc-plugins-detail-reload"
                    title={vm.reloadActionLabel}
                    variant="quiet"
                    size="sm"
                    touch={vm.touch}
                    disabled={detail.busy}
                    dark={dark}
                    onPress={() => {
                      triggerHaptic("light");
                      vm.onReloadPlugin(detail.id);
                    }}
                  />
                )}
                {detail.canRemove && (
                  <Button
                    id="oc-plugins-detail-remove"
                    title={vm.removeActionLabel}
                    variant="danger"
                    size="sm"
                    touch={vm.touch}
                    disabled={detail.busy}
                    dark={dark}
                    onPress={() => {
                      triggerHaptic("medium");
                      vm.onRequestRemovePlugin(detail.id);
                    }}
                  />
                )}
              </view>
            ) : (
              <label value={vm.builtinManagedMessage} font={m.fonts.detail} color={c.muted} numberOfLines={0} />
            )}
          </view>
        ) : (
          <view gap={20}>
            {/* SettingsControlPair Toolbar: Search + Source Filter */}
            <view flexDirection="row" flexWrap="wrap" alignItems="center" gap={8}>
              <view flexGrow={1} minWidth={200}>
                <TextField
                  id="oc-plugins-search"
                  label={vm.searchLabel}
                  hideLabel={true}
                  leadingIcon="search"
                  value={this.state.query}
                  placeholder={vm.searchPlaceholder}
                  clearTitle={vm.clearLabel}
                  touch={vm.touch}
                  dark={dark}
                  autocapitalization="none"
                  onChange={(query) => this.setState({ query })}
                />
              </view>
              <view minWidth={210}>
                <SegmentedControl
                  id="oc-plugins-source"
                  label={vm.sourceFilterLabel}
                  value={this.state.sourceFilter}
                  options={[
                    { id: "all", title: vm.sourceAllLabel },
                    { id: "builtin", title: vm.sourceBuiltinLabel },
                    { id: "installed", title: vm.sourceInstalledLabel },
                  ]}
                  compact={!m.touch}
                  touch={vm.touch}
                  dark={dark}
                  onChange={(next) => this.setState({ sourceFilter: next as State["sourceFilter"] })}
                />
              </view>
            </view>

            {/* Plugin List matching `.settings-control-list-item` */}
            {filteredItems.length === 0 ? (
              <EmptyState
                id="oc-plugins-empty"
                icon="puzzle"
                title={vm.items.length > 0 ? vm.noMatchTitle : vm.emptyTitle}
                description={vm.subtitle}
                touch={vm.touch}
                dark={dark}
              />
            ) : (
              <SettingsGroup title={vm.listGroupTitle} touch={vm.touch} dark={dark}>
                {filteredItems.forEach((item, index) => {
                  <SettingsListItem
                    key={item.id}
                    id={`oc-plugin-open-${item.id}`}
                    title={item.name}
                    openLabel={item.openDetailLabel}
                    description={item.description}
                    metadata={item.metadata}
                    error={item.error}
                    icon={item.icon}
                    statusTone={item.statusTone}
                    divider={index > 0}
                    touch={vm.touch}
                    dark={dark}
                    onOpen={() => vm.onSelectPlugin(item.id)}
                  >
                    {item.canManage && (
                      <Toggle
                        id={`oc-plugin-toggle-${item.id}`}
                        label={item.toggleLabel}
                        value={item.enabled}
                        touch={vm.touch}
                        disabled={item.busy}
                        dark={dark}
                        onChange={(next) => vm.onTogglePlugin(item.id, next)}
                      />
                    )}
                    <view
                      class="oc-pill-button"
                      accessibilityId={`oc-plugin-chevron-${item.id}`}
                      accessibilityLabel={item.openDetailLabel}
                      accessibilityCategory="button"
                      onTap={() => {
                        triggerHaptic("selection");
                        vm.onSelectPlugin(item.id);
                      }}
                      width={28}
                      height={28}
                      borderRadius={m.radii.control}
                      alignItems="center"
                      justifyContent="center"
                    >
                      <Icon name="chevronRight" size={14} color={c.disabled} />
                    </view>
                  </SettingsListItem>;
                })}
              </SettingsGroup>
            )}

            {/* Developer Mode Trusted URL Installer */}
            {vm.developerMode && (
              <SettingsGroup title={vm.installGroupTitle} touch={vm.touch} dark={dark}>
                <TextField
                  id="oc-plugins-install-url"
                  label={vm.installUrlLabel}
                  value={this.state.installUrl}
                  placeholder={vm.installUrlPlaceholder}
                  clearTitle={vm.clearLabel}
                  inline={true}
                  touch={vm.touch}
                  disabled={vm.installBusy}
                  dark={dark}
                  contentType="url"
                  autocapitalization="none"
                  onChange={(installUrl) => this.setState({ installUrl })}
                  onSubmit={() => this.submitInstall()}
                />
                <view paddingLeft={16} paddingRight={16} paddingBottom={12} gap={8} alignItems="flex-end">
                  <Button
                    id="oc-plugins-install-submit"
                    title={vm.installActionLabel}
                    variant="primary"
                    touch={vm.touch}
                    disabled={!this.state.installUrl.trim() || Boolean(vm.installBusy)}
                    dark={dark}
                    onPress={() => this.submitInstall()}
                  />
                  {vm.installError && (
                    <view width="100%">
                      <Banner
                        id="oc-plugins-install-error"
                        tone="danger"
                        title={vm.installError}
                        touch={vm.touch}
                        dark={dark}
                      />
                    </view>
                  )}
                </view>
              </SettingsGroup>
            )}
          </view>
        )}
      </view>

      {vm.confirmingRemoveId && (
        <ConfirmDialog
          id="plugins-remove-modal-dialog"
          title={vm.confirmRemoveTitle}
          message={vm.confirmRemoveMessage}
          confirmTitle={vm.confirmRemoveConfirmLabel}
          cancelTitle={vm.confirmRemoveCancelLabel}
          destructive={true}
          touch={vm.touch}
          dark={dark}
          onConfirm={() => vm.onConfirmRemove(vm.confirmingRemoveId!)}
          onCancel={() => vm.onCancelRemove()}
        />
      )}
    </view>;
  }
}
