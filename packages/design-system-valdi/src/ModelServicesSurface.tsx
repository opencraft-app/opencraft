import { StatefulComponent } from "valdi_core/src/Component";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { registerHapticHandler } from "./haptics";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";
import { SettingsFormRow, SettingsGroup, SettingsListItem, SettingsPageHeader } from "./SettingsGroup";
import { TextField } from "./TextField";
import { Toggle } from "./Toggle";
import { themeColors, themeMetrics } from "./tokens";

export type ModelServiceConnectionItem = {
  readonly id: string;
  readonly name: string;
  readonly scopeLabel: string;
  readonly owned: boolean;
  readonly selected?: boolean;
};

export type ModelServiceModelItem = {
  readonly id: string;
  readonly name: string;
  readonly statusLabel: string;
};

export type ModelServicesSurfaceProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly hideHeader?: boolean;
  readonly title: string;
  readonly subtitle?: string;
  readonly addLabel: string;
  readonly addDisabled?: boolean;
  readonly managePlatformLabel?: string;
  readonly showManagePlatform?: boolean;
  readonly loading?: boolean;
  readonly loadingText: string;
  readonly tryAgainLabel: string;
  readonly errorMessage?: string;
  readonly statusMessage?: string;
  readonly busy?: boolean;
  readonly savingText: string;
  readonly searchQuery: string;
  readonly searchPlaceholder: string;
  readonly clearSearchLabel?: string;
  readonly myModelsTitle: string;
  readonly noPersonalConnectionsText: string;
  readonly platformModelsTitle: string;
  readonly personalConnections: readonly ModelServiceConnectionItem[];
  readonly platformConnections: readonly ModelServiceConnectionItem[];
  readonly adding: boolean;
  readonly addTitle: string;
  readonly subscriptionAvailable?: boolean;
  readonly connectionMethodLabel: string;
  readonly connectionType: "api-key" | "subscription";
  readonly connectionTypeOptions: readonly SelectMenuOption[];
  readonly subscriptionTitle: string;
  readonly subscriptionDescription: string;
  readonly subscriptionLoginCode?: string;
  readonly subscriptionLoginHint?: string;
  readonly signInAndConnectLabel: string;
  readonly nameLabel: string;
  readonly namePlaceholder: string;
  readonly nameValue: string;
  readonly urlRegisterMode?: boolean;
  readonly baseUrlLabel?: string;
  readonly baseUrlPlaceholder?: string;
  readonly baseUrlValue?: string;
  readonly recognizedVendorText?: string;
  readonly protocolLabel?: string;
  readonly protocolValue?: string;
  readonly protocolOptions?: readonly SelectMenuOption[];
  readonly discoverLabel?: string;
  readonly discovering?: boolean;
  readonly discoverHint?: string;
  readonly modelIdLabel?: string;
  readonly modelIdPlaceholder?: string;
  readonly modelIdValue?: string;
  readonly contextWindowLabel?: string;
  readonly contextWindowPlaceholder?: string;
  readonly contextWindowValue?: string;
  readonly serviceLabel: string;
  readonly serviceValue: string;
  readonly serviceOptions: readonly SelectMenuOption[];
  readonly modelLabel: string;
  readonly modelValue: string;
  readonly modelOptions: readonly SelectMenuOption[];
  readonly apiKeyLabel: string;
  readonly apiKeyBaseUrl?: string;
  readonly apiKeyValue: string;
  readonly availableToLabel: string;
  readonly availableToHint: string;
  readonly onlyMeLabel: string;
  readonly saveLabel: string;
  readonly saveDisabled?: boolean;
  readonly cancelLabel: string;
  readonly hasSelectedConnection: boolean;
  readonly selectedConnectionName?: string;
  readonly selectedConnectionStatus?: string;
  readonly selectedConnectionOwned?: boolean;
  readonly selectedConnectionSubscription?: boolean;
  readonly selectedConnectionScopeText?: string;
  readonly scopeOpen?: boolean;
  readonly scopeDraft?: "personal" | "team";
  readonly scopeOptions?: readonly SelectMenuOption[];
  readonly scopeConsent?: boolean;
  readonly scopeTeamWarning?: string;
  readonly scopeAllowOthersLabel?: string;
  readonly scopeSaveDisabled?: boolean;
  readonly changeLabel: string;
  readonly modelsTitle: string;
  readonly selectedModels: readonly ModelServiceModelItem[];
  readonly advancedTitle: string;
  readonly endpointLabel: string;
  readonly endpointValue?: string;
  readonly disableLabel: string;
  readonly disableDescription?: string;
  readonly disableActionLabel: string;
  readonly emptyDirectoryText: string;
  readonly usageTitle: string;
  readonly usedThisMonthLabel: string;
  readonly usedThisMonthValue: string;
  readonly heldTokensLabel: string;
  readonly heldTokensValue?: string;
  readonly usageLimitLabel: string;
  readonly usageLimitDescription: string;
  readonly usageLimitValue: string;
  readonly canEditLimit?: boolean;
  readonly limitOpen?: boolean;
  readonly limitDraft?: string;
  readonly limitMaxLabel?: string;
  readonly limitSaveLabel?: string;
  readonly limitSaveDisabled?: boolean;
  readonly onSearchChange: (query: string) => void;
  readonly onStartAdd: () => void;
  readonly onCancelAdd: () => void;
  readonly onManagePlatform?: () => void;
  readonly onRefresh: () => void;
  readonly onSelectConnection: (id: string) => void;
  readonly onConnectionTypeChange: (value: "api-key" | "subscription") => void;
  readonly onStartSubscription?: () => void;
  readonly onNameChange: (value: string) => void;
  readonly onBaseUrlChange?: (value: string) => void;
  readonly onProtocolChange?: (value: string) => void;
  readonly onDiscoverModels?: () => void;
  readonly onModelIdChange?: (value: string) => void;
  readonly onContextWindowChange?: (value: string) => void;
  readonly onServiceChange: (value: string) => void;
  readonly onModelChange: (value: string) => void;
  readonly onApiKeyChange: (value: string) => void;
  readonly onSaveConnection: () => void;
  readonly onToggleScope: () => void;
  readonly onScopeDraftChange: (value: "personal" | "team") => void;
  readonly onScopeConsentChange: (checked: boolean) => void;
  readonly onSaveScope: () => void;
  readonly onDisableConnection: () => void;
  readonly onToggleLimit: () => void;
  readonly onLimitDraftChange: (value: string) => void;
  readonly onSaveLimit: () => void;
  readonly onHaptic?: (style: string) => void;
};

/**
 * Adaptive OpenCraft Valdi surface for Hub Model Services (`/settings/opencraft.headless-model-services`).
 */
export class ModelServicesSurface extends StatefulComponent<ModelServicesSurfaceProps, Record<string, never>> {
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

    <view width="100%" gap={24}>
      {!vm.hideHeader ? (
        <SettingsPageHeader title={vm.title} description={vm.subtitle} touch={vm.touch} dark={dark}>
          <view flexDirection="row" alignItems="center" flexWrap="wrap" gap={8}>
            {vm.showManagePlatform && vm.managePlatformLabel && vm.onManagePlatform ? (
              <Button
                id="oc-model-gw-manage-platform"
                title={vm.managePlatformLabel}
                variant="secondary"
                size="sm"
                disabled={vm.busy}
                touch={vm.touch}
                dark={dark}
                onPress={vm.onManagePlatform}
              />
            ) : null}
            <Button
              id="oc-model-gw-add"
              title={vm.addLabel}
              variant="primary"
              size="sm"
              disabled={vm.addDisabled}
              touch={vm.touch}
              dark={dark}
              onPress={vm.onStartAdd}
            />
          </view>
        </SettingsPageHeader>
      ) : null}

      {vm.errorMessage ? (
        <Banner id="oc-model-gw-error" tone="danger" title={vm.errorMessage} touch={vm.touch} dark={dark}>
          <Button
            id="oc-model-gw-retry"
            title={vm.tryAgainLabel}
            variant="secondary"
            size="sm"
            disabled={vm.busy}
            touch={vm.touch}
            dark={dark}
            onPress={vm.onRefresh}
          />
        </Banner>
      ) : null}

      {vm.statusMessage || vm.busy ? (
        <Banner
          id="oc-model-gw-status"
          tone="info"
          title={vm.busy ? vm.savingText : (vm.statusMessage ?? "")}
          touch={vm.touch}
          dark={dark}
        />
      ) : null}

      {vm.loading ? (
        <view
          class="oc-cold-skeleton"
          width="100%"
          minHeight={160}
          borderRadius={m.radii.card}
          backgroundColor={c.surface}
          borderWidth={0.5}
          borderColor={c.border}
          padding={20}
          gap={14}
        >
          <view width={120} height={14} borderRadius={6} backgroundColor={c.recessed} />
          <view width="75%" height={12} borderRadius={6} backgroundColor={c.recessed} />
        </view>
      ) : null}

      {!vm.loading ? (
        <TextField
          id="oc-model-gw-search"
          label={vm.searchPlaceholder}
          hideLabel
          value={vm.searchQuery}
          placeholder={vm.searchPlaceholder}
          clearTitle={vm.clearSearchLabel}
          leadingIcon="search"
          touch={vm.touch}
          dark={dark}
          onChange={vm.onSearchChange}
        />
      ) : null}

      {!vm.loading && vm.adding ? (
        <SettingsGroup title={vm.addTitle} clip={false} touch={vm.touch} dark={dark}>
          {vm.subscriptionAvailable ? (
            <SettingsFormRow title={vm.connectionMethodLabel} touch={vm.touch} dark={dark}>
              <SelectMenu
                id="oc-model-gw-method"
                label={vm.connectionMethodLabel}
                value={vm.connectionType}
                options={vm.connectionTypeOptions}
                disabled={vm.busy || Boolean(vm.subscriptionLoginCode)}
                touch={vm.touch}
                dark={dark}
                onChange={(v) => vm.onConnectionTypeChange(v as "api-key" | "subscription")}
              />
            </SettingsFormRow>
          ) : null}

          {vm.connectionType === "subscription" && vm.subscriptionAvailable ? (
            <view width="100%">
              <SettingsListItem
                id="oc-model-gw-sub-info"
                icon="sparkle"
                title={vm.subscriptionTitle}
                description={vm.subscriptionDescription}
                divider
                touch={vm.touch}
                dark={dark}
              />
              {vm.subscriptionLoginCode ? (
                <view width="100%" paddingLeft={16} paddingRight={16} paddingBottom={12}>
                  <Banner
                    id="oc-model-gw-sub-code"
                    tone="info"
                    title={`${vm.subscriptionLoginCode}${vm.subscriptionLoginHint ? ` · ${vm.subscriptionLoginHint}` : ""}`}
                    touch={vm.touch}
                    dark={dark}
                  />
                </view>
              ) : null}
              <view width="100%" padding={16} flexDirection="row" alignItems="center" justifyContent="flex-end" gap={8}>
                <Button
                  id="oc-model-gw-sub-cancel"
                  title={vm.cancelLabel}
                  variant="secondary"
                  size="sm"
                  disabled={vm.busy}
                  touch={vm.touch}
                  dark={dark}
                  onPress={vm.onCancelAdd}
                />
                {vm.onStartSubscription ? (
                  <Button
                    id="oc-model-gw-sub-start"
                    title={vm.signInAndConnectLabel}
                    variant="primary"
                    size="sm"
                    disabled={vm.busy || Boolean(vm.subscriptionLoginCode)}
                    touch={vm.touch}
                    dark={dark}
                    onPress={vm.onStartSubscription}
                  />
                ) : null}
              </view>
            </view>
          ) : vm.urlRegisterMode ? (
            <view width="100%">
              <TextField
                id="oc-model-gw-baseurl"
                label={vm.baseUrlLabel ?? ""}
                value={vm.baseUrlValue ?? ""}
                placeholder={vm.baseUrlPlaceholder ?? ""}
                hint={vm.recognizedVendorText}
                inline
                disabled={vm.busy}
                touch={vm.touch}
                dark={dark}
                onChange={(value) => vm.onBaseUrlChange?.(value)}
              />
              <TextField
                id="oc-model-gw-name"
                label={vm.nameLabel}
                value={vm.nameValue}
                placeholder={vm.namePlaceholder}
                inline
                disabled={vm.busy}
                touch={vm.touch}
                dark={dark}
                onChange={vm.onNameChange}
              />
              {vm.protocolOptions && vm.protocolOptions.length > 0 ? (
                <SettingsFormRow
                  title={vm.protocolLabel ?? vm.connectionMethodLabel}
                  divider
                  touch={vm.touch}
                  dark={dark}
                >
                  <SelectMenu
                    id="oc-model-gw-protocol"
                    label={vm.protocolLabel ?? vm.connectionMethodLabel}
                    value={vm.protocolValue ?? "openai-completions"}
                    options={vm.protocolOptions}
                    disabled={vm.busy}
                    touch={vm.touch}
                    dark={dark}
                    onChange={(v) => vm.onProtocolChange?.(v)}
                  />
                </SettingsFormRow>
              ) : null}
              <TextField
                id="oc-model-gw-key"
                label={vm.apiKeyLabel}
                hint={vm.discoverHint}
                value={vm.apiKeyValue}
                inline
                disabled={vm.busy}
                rightActionTitle={vm.discoverLabel}
                rightActionDisabled={vm.busy || vm.discovering || !(vm.baseUrlValue ?? "").trim()}
                onRightAction={vm.onDiscoverModels}
                touch={vm.touch}
                dark={dark}
                onChange={vm.onApiKeyChange}
              />
              {vm.modelOptions.length > 0 ? (
                <SettingsFormRow title={vm.modelLabel} divider touch={vm.touch} dark={dark}>
                  <SelectMenu
                    id="oc-model-gw-discovered-model"
                    label={vm.modelLabel}
                    value={vm.modelValue}
                    options={vm.modelOptions}
                    disabled={vm.busy}
                    touch={vm.touch}
                    dark={dark}
                    onChange={vm.onModelChange}
                  />
                </SettingsFormRow>
              ) : null}
              <TextField
                id="oc-model-gw-model-id"
                label={vm.modelIdLabel ?? vm.modelLabel}
                value={vm.modelIdValue ?? ""}
                placeholder={vm.modelIdPlaceholder ?? ""}
                inline
                disabled={vm.busy}
                touch={vm.touch}
                dark={dark}
                onChange={(value) => vm.onModelIdChange?.(value)}
              />
              <TextField
                id="oc-model-gw-context-window"
                label={vm.contextWindowLabel ?? ""}
                value={vm.contextWindowValue ?? ""}
                placeholder={vm.contextWindowPlaceholder ?? ""}
                inline
                disabled={vm.busy}
                touch={vm.touch}
                dark={dark}
                onChange={(value) => vm.onContextWindowChange?.(value)}
              />
              <view width="100%" padding={16} flexDirection="row" alignItems="center" justifyContent="flex-end" gap={8}>
                <Button
                  id="oc-model-gw-cancel"
                  title={vm.cancelLabel}
                  variant="secondary"
                  size="sm"
                  disabled={vm.busy}
                  touch={vm.touch}
                  dark={dark}
                  onPress={vm.onCancelAdd}
                />
                <Button
                  id="oc-model-gw-save"
                  title={vm.saveLabel}
                  variant="primary"
                  size="sm"
                  disabled={vm.saveDisabled}
                  touch={vm.touch}
                  dark={dark}
                  onPress={vm.onSaveConnection}
                />
              </view>
            </view>
          ) : (
            <view width="100%">
              <TextField
                id="oc-model-gw-name"
                label={vm.nameLabel}
                value={vm.nameValue}
                placeholder={vm.namePlaceholder}
                inline
                disabled={vm.busy}
                touch={vm.touch}
                dark={dark}
                onChange={vm.onNameChange}
              />
              <SettingsFormRow title={vm.serviceLabel} divider touch={vm.touch} dark={dark}>
                <SelectMenu
                  id="oc-model-gw-service"
                  label={vm.serviceLabel}
                  value={vm.serviceValue}
                  options={vm.serviceOptions}
                  disabled={vm.busy}
                  touch={vm.touch}
                  dark={dark}
                  onChange={vm.onServiceChange}
                />
              </SettingsFormRow>
              <SettingsFormRow title={vm.modelLabel} divider touch={vm.touch} dark={dark}>
                <SelectMenu
                  id="oc-model-gw-model"
                  label={vm.modelLabel}
                  value={vm.modelValue}
                  options={vm.modelOptions}
                  disabled={vm.busy}
                  touch={vm.touch}
                  dark={dark}
                  onChange={vm.onModelChange}
                />
              </SettingsFormRow>
              <TextField
                id="oc-model-gw-key"
                label={vm.apiKeyLabel}
                hint={vm.apiKeyBaseUrl}
                value={vm.apiKeyValue}
                inline
                disabled={vm.busy}
                touch={vm.touch}
                dark={dark}
                onChange={vm.onApiKeyChange}
              />
              <SettingsListItem
                id="oc-model-gw-avail"
                title={vm.availableToLabel}
                description={vm.availableToHint}
                metadata={vm.onlyMeLabel}
                divider
                touch={vm.touch}
                dark={dark}
              />
              <view width="100%" padding={16} flexDirection="row" alignItems="center" justifyContent="flex-end" gap={8}>
                <Button
                  id="oc-model-gw-cancel"
                  title={vm.cancelLabel}
                  variant="secondary"
                  size="sm"
                  disabled={vm.busy}
                  touch={vm.touch}
                  dark={dark}
                  onPress={vm.onCancelAdd}
                />
                <Button
                  id="oc-model-gw-save"
                  title={vm.saveLabel}
                  variant="primary"
                  size="sm"
                  disabled={vm.saveDisabled}
                  touch={vm.touch}
                  dark={dark}
                  onPress={vm.onSaveConnection}
                />
              </view>
            </view>
          )}
        </SettingsGroup>
      ) : null}

      {!vm.loading && !vm.adding ? (
        <view width="100%" gap={20}>
          <SettingsGroup title={vm.myModelsTitle} touch={vm.touch} dark={dark}>
            {vm.personalConnections.length > 0 ? (
              vm.personalConnections.forEach((conn, idx) => {
                <SettingsListItem
                  key={conn.id}
                  id={`oc-model-gw-conn-${conn.id}`}
                  icon="sparkle"
                  title={conn.name}
                  description={conn.scopeLabel}
                  statusTone={conn.selected ? "active" : undefined}
                  divider={idx > 0}
                  touch={vm.touch}
                  dark={dark}
                  onOpen={() => vm.onSelectConnection(conn.id)}
                />;
              })
            ) : (
              <view width="100%" padding={16}>
                <label value={vm.noPersonalConnectionsText} font={m.fonts.detail} color={c.muted} numberOfLines={0} />
              </view>
            )}
          </SettingsGroup>

          {vm.platformConnections.length > 0 ? (
            <SettingsGroup title={vm.platformModelsTitle} touch={vm.touch} dark={dark}>
              {vm.platformConnections.forEach((conn, idx) => {
                <SettingsListItem
                  key={conn.id}
                  id={`oc-model-gw-plat-${conn.id}`}
                  icon="server"
                  title={conn.name}
                  description={conn.scopeLabel}
                  statusTone={conn.selected ? "active" : undefined}
                  divider={idx > 0}
                  touch={vm.touch}
                  dark={dark}
                  onOpen={() => vm.onSelectConnection(conn.id)}
                />;
              })}
            </SettingsGroup>
          ) : null}

          {vm.hasSelectedConnection && vm.selectedConnectionName ? (
            <view width="100%" gap={20}>
              <SettingsGroup
                title={vm.selectedConnectionName}
                description={vm.selectedConnectionStatus}
                clip={false}
                touch={vm.touch}
                dark={dark}
              >
                {vm.selectedConnectionOwned ? (
                  <view width="100%">
                    <SettingsListItem
                      id="oc-model-gw-selected-scope"
                      title={vm.availableToLabel}
                      description={vm.selectedConnectionScopeText}
                      touch={vm.touch}
                      dark={dark}
                    >
                      {!vm.selectedConnectionSubscription ? (
                        <Button
                          id="oc-model-gw-change-scope"
                          title={vm.changeLabel}
                          variant="secondary"
                          size="sm"
                          disabled={vm.busy}
                          touch={vm.touch}
                          dark={dark}
                          onPress={vm.onToggleScope}
                        />
                      ) : null}
                    </SettingsListItem>

                    {vm.scopeOpen && vm.scopeOptions ? (
                      <view width="100%" padding={16} gap={12}>
                        <SettingsFormRow title={vm.availableToLabel} touch={vm.touch} dark={dark}>
                          <SelectMenu
                            id="oc-model-gw-scope-select"
                            label={vm.availableToLabel}
                            value={vm.scopeDraft ?? "personal"}
                            options={vm.scopeOptions}
                            disabled={vm.busy}
                            touch={vm.touch}
                            dark={dark}
                            onChange={(v) => vm.onScopeDraftChange(v as "personal" | "team")}
                          />
                        </SettingsFormRow>
                        {vm.scopeDraft === "team" && vm.scopeAllowOthersLabel ? (
                          <SettingsFormRow
                            title={vm.scopeAllowOthersLabel}
                            description={vm.scopeTeamWarning}
                            divider
                            touch={vm.touch}
                            dark={dark}
                          >
                            <Toggle
                              id="oc-model-gw-scope-consent"
                              label={vm.scopeAllowOthersLabel}
                              value={Boolean(vm.scopeConsent)}
                              disabled={vm.busy}
                              touch={vm.touch}
                              dark={dark}
                              onChange={vm.onScopeConsentChange}
                            />
                          </SettingsFormRow>
                        ) : null}
                        <view flexDirection="row" alignItems="center" justifyContent="flex-end" gap={8}>
                          <Button
                            id="oc-model-gw-scope-cancel"
                            title={vm.cancelLabel}
                            variant="secondary"
                            size="sm"
                            disabled={vm.busy}
                            touch={vm.touch}
                            dark={dark}
                            onPress={vm.onToggleScope}
                          />
                          <Button
                            id="oc-model-gw-scope-save"
                            title={vm.saveLabel}
                            variant="primary"
                            size="sm"
                            disabled={vm.scopeSaveDisabled}
                            touch={vm.touch}
                            dark={dark}
                            onPress={vm.onSaveScope}
                          />
                        </view>
                      </view>
                    ) : null}
                  </view>
                ) : null}

                {vm.endpointValue ? (
                  <SettingsListItem
                    id="oc-model-gw-endpoint"
                    title={vm.endpointLabel}
                    description={vm.endpointValue}
                    divider={vm.selectedConnectionOwned}
                    touch={vm.touch}
                    dark={dark}
                  />
                ) : null}

                {vm.selectedConnectionOwned ? (
                  <SettingsListItem
                    id="oc-model-gw-disable"
                    title={vm.disableLabel}
                    description={vm.disableDescription}
                    divider
                    touch={vm.touch}
                    dark={dark}
                  >
                    <Button
                      id="oc-model-gw-disable-btn"
                      title={vm.disableActionLabel}
                      variant="danger"
                      size="sm"
                      disabled={vm.busy}
                      touch={vm.touch}
                      dark={dark}
                      onPress={vm.onDisableConnection}
                    />
                  </SettingsListItem>
                ) : null}
              </SettingsGroup>

              {vm.selectedModels.length > 0 ? (
                <SettingsGroup title={vm.modelsTitle} touch={vm.touch} dark={dark}>
                  {vm.selectedModels.forEach((model, idx) => {
                    <SettingsListItem
                      key={model.id}
                      id={`oc-model-gw-model-${model.id}`}
                      icon="bot"
                      title={model.name}
                      description={model.id}
                      metadata={model.statusLabel}
                      divider={idx > 0}
                      touch={vm.touch}
                      dark={dark}
                    />;
                  })}
                </SettingsGroup>
              ) : null}
            </view>
          ) : (
            <EmptyState icon="sparkle" title={vm.emptyDirectoryText} description="" dark={dark} />
          )}

          <SettingsGroup title={vm.usageTitle} touch={vm.touch} dark={dark}>
            <SettingsListItem
              id="oc-model-gw-used"
              title={vm.usedThisMonthLabel}
              metadata={vm.usedThisMonthValue}
              touch={vm.touch}
              dark={dark}
            />
            {vm.heldTokensValue ? (
              <SettingsListItem
                id="oc-model-gw-held"
                title={vm.heldTokensLabel}
                metadata={vm.heldTokensValue}
                divider
                touch={vm.touch}
                dark={dark}
              />
            ) : null}
            <SettingsListItem
              id="oc-model-gw-limit"
              title={vm.usageLimitLabel}
              description={vm.usageLimitDescription}
              metadata={vm.usageLimitValue}
              divider
              touch={vm.touch}
              dark={dark}
            >
              {vm.canEditLimit ? (
                <Button
                  id="oc-model-gw-edit-limit"
                  title={vm.changeLabel}
                  variant="secondary"
                  size="sm"
                  disabled={vm.busy}
                  touch={vm.touch}
                  dark={dark}
                  onPress={vm.onToggleLimit}
                />
              ) : null}
            </SettingsListItem>
            {vm.limitOpen && vm.limitMaxLabel && vm.limitSaveLabel ? (
              <view width="100%" padding={16} gap={12}>
                <TextField
                  id="oc-model-gw-limit-input"
                  label={vm.limitMaxLabel}
                  value={vm.limitDraft ?? ""}
                  inline
                  disabled={vm.busy}
                  touch={vm.touch}
                  dark={dark}
                  onChange={vm.onLimitDraftChange}
                />
                <view flexDirection="row" alignItems="center" justifyContent="flex-end" gap={8}>
                  <Button
                    id="oc-model-gw-limit-cancel"
                    title={vm.cancelLabel}
                    variant="secondary"
                    size="sm"
                    disabled={vm.busy}
                    touch={vm.touch}
                    dark={dark}
                    onPress={vm.onToggleLimit}
                  />
                  <Button
                    id="oc-model-gw-limit-save"
                    title={vm.limitSaveLabel}
                    variant="primary"
                    size="sm"
                    disabled={vm.limitSaveDisabled}
                    touch={vm.touch}
                    dark={dark}
                    onPress={vm.onSaveLimit}
                  />
                </view>
              </view>
            ) : null}
          </SettingsGroup>
        </view>
      ) : null}
    </view>;
  }
}
