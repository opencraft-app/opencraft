import { StatefulComponent } from "valdi_core/src/Component";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { registerHapticHandler } from "./haptics";
import { SegmentedControl } from "./SegmentedControl";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";
import { ModelServicesSurface, type ModelServicesSurfaceProps } from "./ModelServicesSurface";
import { SettingsGroup, SettingsListItem, SettingsPageHeader } from "./SettingsGroup";
import { TextField } from "./TextField";
import { themeColors, themeMetrics } from "./tokens";

export type AssetTabId = "libraries" | "environments" | "models" | "connections";

export type AssetLibraryItem = {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly compatibleText: string;
  readonly verifiedText: string;
};

export type AssetEnvironmentItem = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: "platform" | "personal";
  readonly editable?: boolean;
};

export type AssetConnectionItem = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly kind: "git" | "cloud";
  readonly disabled?: boolean;
};

export type AssetsSurfaceProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly activeTab: AssetTabId;
  readonly librariesLabel: string;
  readonly environmentsLabel: string;
  readonly modelsLabel?: string;
  readonly modelsTab?: ModelServicesSurfaceProps;
  readonly connectionsLabel: string;
  readonly refreshLabel: string;
  readonly refreshing?: boolean;
  readonly primaryActionLabel?: string;
  readonly primaryActionDisabled?: boolean;
  readonly errorMessage?: string;
  readonly noticeMessage?: string;
  readonly draftRetainedMessage?: string;
  readonly continueEditingLabel?: string;
  readonly editingHere?: boolean;
  readonly loading?: boolean;
  readonly loadingLabel: string;
  readonly searchQuery: string;
  readonly searchPlaceholder: string;
  readonly showEnvironmentSearch?: boolean;
  readonly showConnectionSearch?: boolean;
  readonly providerFilter?: string;
  readonly providerFilterOptions?: readonly SelectMenuOption[];
  readonly libraries: readonly AssetLibraryItem[];
  readonly libraryEmptyText: string;
  readonly libraryBoundaryText: string;
  readonly libraryDetailsTitle: string;
  readonly platformTitle: string;
  readonly localLabel: string;
  readonly localDescription: string;
  readonly personalEnvironmentsTitle: string;
  readonly environments: readonly AssetEnvironmentItem[];
  readonly emptyEnvironmentText: string;
  readonly noResultsText: string;
  readonly createEnvironmentLabel: string;
  readonly createEnvironmentDisabled?: boolean;
  readonly clearFiltersLabel: string;
  readonly environmentSaveHint: string;
  readonly viewAssistantsLabel: string;
  readonly connectionsTitle: string;
  readonly connections: readonly AssetConnectionItem[];
  readonly emptyConnectionsText: string;
  readonly providerAboutText: string;
  readonly addAccountLabel: string;
  readonly addAccountDisabled?: boolean;
  readonly codeAccountFooter?: string;
  readonly envVariablesTitle?: string;
  readonly envVariablesLabel?: string;
  readonly envVariablesDescription?: string;
  readonly onTabChange: (tab: AssetTabId) => void;
  readonly onRefresh: () => void;
  readonly onPrimaryAction?: () => void;
  readonly onContinueEditing?: () => void;
  readonly onSearchChange: (query: string) => void;
  readonly onProviderFilterChange?: (value: string) => void;
  readonly onClearFilters: (tab: "environments" | "connections") => void;
  readonly onOpenLibrary: (id: string) => void;
  readonly onOpenEnvironment: (id: string) => void;
  readonly onCreateEnvironment: () => void;
  readonly onViewAssistants: () => void;
  readonly onOpenConnection: (key: string) => void;
  readonly onAddAccount: () => void;
  readonly onOpenVariables?: () => void;
  readonly onHaptic?: (style: string) => void;
};

/**
 * Adaptive OpenCraft Valdi surface for Assets (`/views/opencraft.assets`).
 */
export class AssetsSurface extends StatefulComponent<AssetsSurfaceProps, Record<string, never>> {
  state: Record<string, never> = {};

  onCreate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
  }

  onViewModelUpdate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
  }

  onRender(): void {
    const vm = this.viewModel;
    const dark = Boolean(vm.dark);
    const c = themeColors(dark);
    const m = themeMetrics(vm.touch);

    const platformEnvironments = vm.environments.filter((item) => item.source === "platform");
    const personalEnvironments = vm.environments.filter((item) => item.source === "personal");
    const hasFilter = Boolean(vm.searchQuery.trim() || (vm.providerFilter && vm.providerFilter !== "all"));

    <view width="100%" gap={24}>
      <SettingsPageHeader title={vm.title} description={vm.subtitle} touch={vm.touch} dark={dark}>
        <view flexDirection="row" alignItems="center" flexWrap="wrap" gap={8}>
          <Button
            id="oc-assets-refresh"
            title={vm.refreshLabel}
            variant="secondary"
            size="sm"
            loading={vm.refreshing}
            touch={vm.touch}
            dark={dark}
            onPress={vm.onRefresh}
          />
          {vm.primaryActionLabel && vm.onPrimaryAction ? (
            <Button
              id="oc-assets-primary-action"
              title={vm.primaryActionLabel}
              variant="primary"
              size="sm"
              disabled={vm.primaryActionDisabled}
              touch={vm.touch}
              dark={dark}
              onPress={vm.onPrimaryAction}
            />
          ) : null}
        </view>
      </SettingsPageHeader>

      <SegmentedControl
        id="oc-assets-tabs"
        label={vm.title}
        value={vm.activeTab}
        options={[
          { id: "libraries", title: vm.librariesLabel },
          { id: "environments", title: vm.environmentsLabel },
          ...(vm.modelsLabel ? [{ id: "models", title: vm.modelsLabel }] : []),
          { id: "connections", title: vm.connectionsLabel },
        ]}
        touch={vm.touch}
        dark={dark}
        onChange={(value) => vm.onTabChange(value as AssetTabId)}
      />

      {vm.errorMessage ? (
        <Banner id="oc-assets-error" tone="danger" title={vm.errorMessage} touch={vm.touch} dark={dark} />
      ) : null}

      {vm.noticeMessage ? (
        <Banner id="oc-assets-notice" tone="info" title={vm.noticeMessage} touch={vm.touch} dark={dark} />
      ) : null}

      {vm.draftRetainedMessage && vm.onContinueEditing && vm.continueEditingLabel ? (
        <Banner id="oc-assets-draft" tone="info" title={vm.draftRetainedMessage} touch={vm.touch} dark={dark}>
          <Button
            id="oc-assets-continue-edit"
            title={vm.continueEditingLabel}
            variant="secondary"
            size="sm"
            touch={vm.touch}
            dark={dark}
            onPress={vm.onContinueEditing}
          />
        </Banner>
      ) : null}

      {!vm.editingHere && vm.activeTab === "libraries" ? (
        <view width="100%" gap={20}>
          {vm.libraries.length > 0 ? (
            <SettingsGroup title={vm.librariesLabel} description={vm.libraryBoundaryText} touch={vm.touch} dark={dark}>
              {vm.libraries.forEach((library, idx) => {
                <SettingsListItem
                  key={library.id}
                  id={`oc-assets-lib-${library.id}`}
                  icon="server"
                  title={library.name}
                  description={`${library.summary}\n${vm.libraryDetailsTitle}: ${library.compatibleText} · ${library.verifiedText}`}
                  divider={idx > 0}
                  touch={vm.touch}
                  dark={dark}
                  onOpen={() => vm.onOpenLibrary(library.id)}
                />;
              })}
            </SettingsGroup>
          ) : (
            <SettingsGroup title={vm.librariesLabel} description={vm.libraryBoundaryText} touch={vm.touch} dark={dark}>
              <EmptyState icon="server" title={vm.libraryEmptyText} description="" dark={dark} />
            </SettingsGroup>
          )}
        </view>
      ) : null}

      {!vm.editingHere && vm.activeTab === "environments" ? (
        <view width="100%" gap={20}>
          {vm.showEnvironmentSearch ? (
            <TextField
              id="oc-assets-env-search"
              label={vm.searchPlaceholder}
              hideLabel
              value={vm.searchQuery}
              placeholder={vm.searchPlaceholder}
              clearTitle={vm.clearFiltersLabel}
              leadingIcon="search"
              touch={vm.touch}
              dark={dark}
              onChange={vm.onSearchChange}
            />
          ) : null}

          <SettingsGroup title={vm.platformTitle} touch={vm.touch} dark={dark}>
            <SettingsListItem
              id="oc-assets-env-local"
              icon="server"
              title={vm.localLabel}
              description={vm.localDescription}
              touch={vm.touch}
              dark={dark}
            />
            {platformEnvironments.forEach((env) => {
              <SettingsListItem
                key={env.id}
                id={`oc-assets-env-${env.id}`}
                icon="server"
                title={env.name}
                description={env.description}
                divider
                touch={vm.touch}
                dark={dark}
                onOpen={env.editable ? () => vm.onOpenEnvironment(env.id) : undefined}
              />;
            })}
          </SettingsGroup>

          <SettingsGroup title={vm.personalEnvironmentsTitle} touch={vm.touch} dark={dark}>
            {vm.loading ? (
              <view
                class="oc-cold-skeleton"
                width="100%"
                minHeight={96}
                padding={16}
                justifyContent="center"
                alignItems="center"
                gap={10}
              >
                <view width={140} height={13} borderRadius={6} backgroundColor={c.recessed} />
                <view width={96} height={28} borderRadius={8} backgroundColor={c.recessed} />
              </view>
            ) : personalEnvironments.length > 0 ? (
              personalEnvironments.forEach((env, idx) => {
                <SettingsListItem
                  key={env.id}
                  id={`oc-assets-env-${env.id}`}
                  icon="laptop"
                  title={env.name}
                  description={env.description}
                  divider={idx > 0}
                  touch={vm.touch}
                  dark={dark}
                  onOpen={env.editable ? () => vm.onOpenEnvironment(env.id) : undefined}
                />;
              })
            ) : (
              <EmptyState
                icon="laptop"
                title={vm.searchQuery.trim() ? vm.noResultsText : vm.emptyEnvironmentText}
                description=""
                actionTitle={vm.searchQuery.trim() ? vm.clearFiltersLabel : vm.createEnvironmentLabel}
                dark={dark}
                onAction={
                  vm.searchQuery.trim()
                    ? () => vm.onClearFilters("environments")
                    : !vm.createEnvironmentDisabled
                      ? vm.onCreateEnvironment
                      : undefined
                }
              />
            )}
          </SettingsGroup>

          <view width="100%" flexDirection="row" alignItems="center" justifyContent="space-between" gap={12}>
            <view flexGrow={1} flexShrink={1} minWidth={0}>
              <label value={vm.environmentSaveHint} font={m.fonts.detail} color={c.muted} numberOfLines={0} />
            </view>
            <Button
              id="oc-assets-view-assistants"
              title={vm.viewAssistantsLabel}
              variant="secondary"
              size="sm"
              touch={vm.touch}
              dark={dark}
              onPress={vm.onViewAssistants}
            />
          </view>
        </view>
      ) : null}

      {!vm.editingHere && vm.activeTab === "models" && vm.modelsTab ? (
        <ModelServicesSurface {...vm.modelsTab} hideHeader touch={vm.touch} dark={dark} />
      ) : null}

      {!vm.editingHere && vm.activeTab === "connections" ? (
        <view width="100%" gap={20}>
          {vm.showConnectionSearch ? (
            <view width="100%" flexDirection="row" alignItems="center" gap={10}>
              <view flexGrow={1} flexShrink={1} minWidth={0}>
                <TextField
                  id="oc-assets-conn-search"
                  label={vm.searchPlaceholder}
                  hideLabel
                  value={vm.searchQuery}
                  placeholder={vm.searchPlaceholder}
                  clearTitle={vm.clearFiltersLabel}
                  leadingIcon="search"
                  touch={vm.touch}
                  dark={dark}
                  onChange={vm.onSearchChange}
                />
              </view>
              {vm.providerFilterOptions && vm.providerFilterOptions.length > 0 && vm.onProviderFilterChange ? (
                <SelectMenu
                  id="oc-assets-provider-filter"
                  label={vm.connectionsTitle}
                  value={vm.providerFilter ?? "all"}
                  options={vm.providerFilterOptions}
                  minWidth={140}
                  align="right"
                  touch={vm.touch}
                  dark={dark}
                  onChange={vm.onProviderFilterChange}
                />
              ) : null}
            </view>
          ) : null}

          <SettingsGroup title={vm.connectionsTitle} description={vm.codeAccountFooter} touch={vm.touch} dark={dark}>
            {vm.loading ? (
              <view
                class="oc-cold-skeleton"
                width="100%"
                minHeight={96}
                padding={16}
                justifyContent="center"
                alignItems="center"
                gap={10}
              >
                <view width={140} height={13} borderRadius={6} backgroundColor={c.recessed} />
                <view width={96} height={28} borderRadius={8} backgroundColor={c.recessed} />
              </view>
            ) : vm.connections.length > 0 ? (
              vm.connections.forEach((conn, idx) => {
                <SettingsListItem
                  key={conn.key}
                  id={`oc-assets-conn-${conn.id}`}
                  icon={conn.kind === "git" ? "link" : "server"}
                  title={conn.name}
                  description={conn.description}
                  divider={idx > 0}
                  touch={vm.touch}
                  dark={dark}
                  onOpen={conn.disabled ? undefined : () => vm.onOpenConnection(conn.key)}
                />;
              })
            ) : (
              <EmptyState
                icon="link"
                title={hasFilter ? vm.noResultsText : vm.emptyConnectionsText}
                description={hasFilter ? "" : vm.providerAboutText}
                actionTitle={hasFilter ? vm.clearFiltersLabel : vm.addAccountLabel}
                dark={dark}
                onAction={
                  hasFilter
                    ? () => vm.onClearFilters("connections")
                    : !vm.addAccountDisabled
                      ? vm.onAddAccount
                      : undefined
                }
              />
            )}
          </SettingsGroup>

          {vm.envVariablesLabel && vm.onOpenVariables ? (
            <SettingsGroup title={vm.envVariablesTitle ?? vm.envVariablesLabel} touch={vm.touch} dark={dark}>
              <SettingsListItem
                id="oc-assets-env-vars"
                icon="terminal"
                title={vm.envVariablesLabel}
                description={vm.envVariablesDescription}
                touch={vm.touch}
                dark={dark}
                onOpen={vm.onOpenVariables}
              />
            </SettingsGroup>
          ) : null}
        </view>
      ) : null}
    </view>;
  }
}
