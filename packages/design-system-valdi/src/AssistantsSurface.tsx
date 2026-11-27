import { StatefulComponent } from "valdi_core/src/Component";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { registerHapticHandler } from "./haptics";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";
import { SettingsFormRow, SettingsGroup, SettingsListItem, SettingsPageHeader } from "./SettingsGroup";
import { themeColors, themeMetrics } from "./tokens";

export type ManagedBotItem = {
  readonly id: string;
  readonly title: string;
  readonly statusText: string;
  readonly openLabel: string;
  readonly settingsLabel?: string;
  readonly pauseLabel?: string;
  readonly busy?: boolean;
};

export type AssistantsSurfaceProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly managedTitle?: string;
  readonly managedDescription?: string;
  readonly managedCreateLabel?: string;
  readonly managedCreateDisabled?: boolean;
  readonly managedLoading?: boolean;
  readonly managedError?: string;
  readonly managedEmptyText?: string;
  readonly managedBots?: readonly ManagedBotItem[];
  readonly onCreateManagedBot?: () => void;
  readonly onRetryManagedBots?: () => void;
  readonly onSettingsManagedBot?: (id: string) => void;
  readonly onTogglePauseManagedBot?: (id: string) => void;
  readonly loading?: boolean;
  readonly loadingText: string;
  readonly failedText?: string;
  readonly myAgentsTitle: string;
  readonly availableTitle: string;
  readonly personalTitle: string;
  readonly personalAbout: string;
  readonly assistantPresent: boolean;
  readonly claimed: boolean;
  readonly phaseText: string;
  readonly configRequired?: boolean;
  readonly unavailable?: boolean;
  readonly detailsOpen: boolean;
  readonly memoryOpen: boolean;
  readonly confirmStop: boolean;
  readonly pending?: boolean;
  readonly modelSaving?: boolean;
  readonly activeAction?: string | null;
  readonly reclaimLabel: string;
  readonly chooseModelLabel: string;
  readonly openLabel: string;
  readonly memoryLabel: string;
  readonly manageLabel: string;
  readonly closeDetailsLabel: string;
  readonly hireLabel: string;
  readonly modelLabel: string;
  readonly modelDescription?: string;
  readonly selectedModel: string;
  readonly modelOptions: readonly SelectMenuOption[];
  readonly modelDisabled?: boolean;
  readonly retryLabel: string;
  readonly stopLabel: string;
  readonly stopConfirmText: string;
  readonly cancelLabel: string;
  readonly stopConfirmActionLabel: string;
  readonly onOpenManagedBot?: (id: string) => void;
  readonly onClaim: () => void;
  readonly onOpenChat: () => void;
  readonly onToggleMemory: () => void;
  readonly onToggleDetails: () => void;
  readonly onSelectModel: (value: string) => void;
  readonly onRetry: () => void;
  readonly onRequestStop: () => void;
  readonly onCancelStop: () => void;
  readonly onConfirmStop: () => void;
  readonly onHaptic?: (style: string) => void;
};

/**
 * Adaptive OpenCraft Valdi surface for Assistants (`/views/opencraft.im.agents`).
 */
export class AssistantsSurface extends StatefulComponent<AssistantsSurfaceProps, Record<string, never>> {
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
      <SettingsPageHeader title={vm.title} description={vm.subtitle} touch={vm.touch} dark={dark} />

      {vm.managedTitle ? (
        <SettingsGroup title={vm.managedTitle} description={vm.managedDescription} touch={vm.touch} dark={dark}>
          {vm.managedCreateLabel && vm.onCreateManagedBot ? (
            <view
              width="100%"
              padding={16}
              flexDirection="row"
              alignItems="center"
              justifyContent="space-between"
              gap={12}
            >
              <view flexGrow={1} flexShrink={1} minWidth={0}>
                {vm.managedEmptyText &&
                (!vm.managedBots || vm.managedBots.length === 0) &&
                !vm.managedLoading &&
                !vm.managedError ? (
                  <label value={vm.managedEmptyText} font={m.fonts.detail} color={c.muted} numberOfLines={0} />
                ) : null}
              </view>
              <Button
                id="oc-assistant-managed-create"
                title={vm.managedCreateLabel}
                variant="primary"
                size="sm"
                disabled={vm.managedCreateDisabled}
                touch={vm.touch}
                dark={dark}
                onPress={vm.onCreateManagedBot}
              />
            </view>
          ) : null}

          {vm.managedError ? (
            <Banner id="oc-assistant-managed-error" tone="danger" title={vm.managedError} touch={vm.touch} dark={dark}>
              {vm.onRetryManagedBots ? (
                <Button
                  id="oc-assistant-managed-retry"
                  title={vm.retryLabel}
                  variant="secondary"
                  size="sm"
                  touch={vm.touch}
                  dark={dark}
                  onPress={vm.onRetryManagedBots}
                />
              ) : null}
            </Banner>
          ) : vm.managedLoading && (!vm.managedBots || vm.managedBots.length === 0) ? (
            <view
              class="oc-cold-skeleton"
              width="100%"
              minHeight={52}
              paddingLeft={16}
              paddingRight={16}
              justifyContent="center"
            >
              <view width={180} height={12} borderRadius={6} backgroundColor={c.recessed} />
            </view>
          ) : null}

          {vm.managedBots && vm.managedBots.length > 0
            ? vm.managedBots.forEach((bot, idx) => {
                <SettingsListItem
                  key={bot.id}
                  id={`oc-assistant-managed-${bot.id}`}
                  icon="bot"
                  title={bot.title}
                  description={bot.statusText}
                  divider={idx > 0 || Boolean(vm.managedCreateLabel)}
                  touch={vm.touch}
                  dark={dark}
                >
                  <view flexDirection="row" alignItems="center" flexWrap="wrap" justifyContent="flex-end" gap={6}>
                    <Button
                      id={`oc-assistant-managed-open-${bot.id}`}
                      title={bot.openLabel}
                      variant="secondary"
                      size="sm"
                      disabled={bot.busy}
                      touch={vm.touch}
                      dark={dark}
                      onPress={() => vm.onOpenManagedBot?.(bot.id)}
                    />
                    {bot.settingsLabel && vm.onSettingsManagedBot ? (
                      <Button
                        id={`oc-assistant-managed-settings-${bot.id}`}
                        title={bot.settingsLabel}
                        variant="secondary"
                        size="sm"
                        disabled={bot.busy}
                        touch={vm.touch}
                        dark={dark}
                        onPress={() => vm.onSettingsManagedBot?.(bot.id)}
                      />
                    ) : null}
                    {bot.pauseLabel && vm.onTogglePauseManagedBot ? (
                      <Button
                        id={`oc-assistant-managed-pause-${bot.id}`}
                        title={bot.pauseLabel}
                        variant="secondary"
                        size="sm"
                        disabled={bot.busy}
                        touch={vm.touch}
                        dark={dark}
                        onPress={() => vm.onTogglePauseManagedBot?.(bot.id)}
                      />
                    ) : null}
                  </view>
                </SettingsListItem>;
              })
            : null}
        </SettingsGroup>
      ) : null}

      {vm.failedText ? (
        <Banner id="oc-assistants-error" tone="danger" title={vm.failedText} touch={vm.touch} dark={dark} />
      ) : vm.loading ? (
        <view class="oc-cold-skeleton" width="100%">
          <SettingsGroup title={vm.availableTitle} touch={vm.touch} dark={dark}>
            <view
              width="100%"
              minHeight={64}
              padding={16}
              flexDirection="row"
              alignItems="center"
              justifyContent="space-between"
              gap={12}
            >
              <view gap={6} flexGrow={1}>
                <view width={96} height={13} borderRadius={6} backgroundColor={c.recessed} />
                <view width={220} height={11} borderRadius={5} backgroundColor={c.recessed} />
              </view>
              <view width={56} height={28} borderRadius={8} backgroundColor={c.recessed} />
            </view>
          </SettingsGroup>
        </view>
      ) : null}

      {vm.assistantPresent ? (
        <SettingsGroup title={vm.myAgentsTitle} clip={false} touch={vm.touch} dark={dark}>
          <SettingsListItem
            id="oc-assistant-personal"
            icon="bot"
            title={vm.personalTitle}
            description={vm.phaseText}
            touch={vm.touch}
            dark={dark}
          >
            <view flexDirection="row" alignItems="center" flexWrap="wrap" justifyContent="flex-end" gap={8}>
              {!vm.claimed ? (
                <Button
                  id="oc-assistant-reclaim"
                  title={vm.reclaimLabel}
                  variant="primary"
                  size="sm"
                  loading={vm.activeAction === "claim"}
                  disabled={vm.pending}
                  touch={vm.touch}
                  dark={dark}
                  onPress={vm.onClaim}
                />
              ) : vm.configRequired && !vm.detailsOpen && !vm.memoryOpen ? (
                <Button
                  id="oc-assistant-choose-model"
                  title={vm.chooseModelLabel}
                  variant="primary"
                  size="sm"
                  touch={vm.touch}
                  dark={dark}
                  onPress={vm.onToggleDetails}
                />
              ) : (
                <Button
                  id="oc-assistant-open"
                  title={vm.openLabel}
                  variant="secondary"
                  size="sm"
                  loading={vm.activeAction === "open"}
                  disabled={vm.pending || vm.modelSaving}
                  touch={vm.touch}
                  dark={dark}
                  onPress={vm.onOpenChat}
                />
              )}

              {vm.claimed ? (
                <Button
                  id="oc-assistant-memory"
                  title={vm.memoryLabel}
                  variant={vm.memoryOpen ? "primary" : "secondary"}
                  size="sm"
                  touch={vm.touch}
                  dark={dark}
                  onPress={vm.onToggleMemory}
                />
              ) : null}

              {vm.claimed ? (
                <Button
                  id="oc-assistant-settings"
                  title={vm.detailsOpen ? vm.closeDetailsLabel : vm.manageLabel}
                  variant={vm.detailsOpen ? "primary" : "secondary"}
                  size="sm"
                  touch={vm.touch}
                  dark={dark}
                  onPress={vm.onToggleDetails}
                />
              ) : null}
            </view>
          </SettingsListItem>

          {vm.detailsOpen && vm.claimed ? (
            <view width="100%">
              <SettingsFormRow
                title={vm.modelLabel}
                description={vm.modelDescription}
                divider
                touch={vm.touch}
                dark={dark}
              >
                <SelectMenu
                  id="oc-assistant-model-select"
                  label={vm.modelLabel}
                  value={vm.selectedModel}
                  options={vm.modelOptions}
                  disabled={vm.modelDisabled}
                  minWidth={180}
                  align="right"
                  touch={vm.touch}
                  dark={dark}
                  onChange={vm.onSelectModel}
                />
              </SettingsFormRow>

              {vm.confirmStop ? (
                <view width="100%" padding={16} gap={12} borderWidth={0.5} borderColor={c.border}>
                  <label value={vm.stopConfirmText} font={m.fonts.body} color={c.ink} numberOfLines={0} />
                  <view flexDirection="row" alignItems="center" justifyContent="flex-end" gap={8}>
                    <Button
                      id="oc-assistant-stop-cancel"
                      title={vm.cancelLabel}
                      variant="secondary"
                      size="sm"
                      disabled={vm.pending}
                      touch={vm.touch}
                      dark={dark}
                      onPress={vm.onCancelStop}
                    />
                    <Button
                      id="oc-assistant-stop-confirm"
                      title={vm.stopConfirmActionLabel}
                      variant="danger"
                      size="sm"
                      loading={vm.activeAction === "revoke"}
                      disabled={vm.pending || vm.modelSaving}
                      touch={vm.touch}
                      dark={dark}
                      onPress={vm.onConfirmStop}
                    />
                  </view>
                </view>
              ) : (
                <view
                  width="100%"
                  padding={16}
                  flexDirection="row"
                  alignItems="center"
                  justifyContent="flex-end"
                  gap={8}
                >
                  {vm.unavailable ? (
                    <Button
                      id="oc-assistant-retry"
                      title={vm.retryLabel}
                      variant="secondary"
                      size="sm"
                      disabled={vm.pending || vm.modelSaving}
                      touch={vm.touch}
                      dark={dark}
                      onPress={vm.onRetry}
                    />
                  ) : null}
                  <Button
                    id="oc-assistant-stop"
                    title={vm.stopLabel}
                    variant="secondary"
                    size="sm"
                    disabled={vm.pending || vm.modelSaving}
                    touch={vm.touch}
                    dark={dark}
                    onPress={vm.onRequestStop}
                  />
                </view>
              )}
            </view>
          ) : null}
        </SettingsGroup>
      ) : !vm.loading && !vm.failedText ? (
        <SettingsGroup title={vm.availableTitle} touch={vm.touch} dark={dark}>
          <SettingsListItem
            id="oc-assistant-hire-row"
            icon="bot"
            title={vm.personalTitle}
            description={vm.personalAbout}
            touch={vm.touch}
            dark={dark}
          >
            <Button
              id="oc-assistant-hire"
              title={vm.hireLabel}
              variant="primary"
              size="sm"
              loading={vm.activeAction === "claim"}
              disabled={vm.pending}
              touch={vm.touch}
              dark={dark}
              onPress={vm.onClaim}
            />
          </SettingsListItem>
        </SettingsGroup>
      ) : null}
    </view>;
  }
}
