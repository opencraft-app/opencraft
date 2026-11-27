import { StatefulComponent } from "valdi_core/src/Component";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { registerHapticHandler, triggerHaptic } from "./haptics";
import { SettingsFormRow, SettingsGroup, SettingsPageHeader, SettingsRow } from "./SettingsGroup";
import { Toggle } from "./Toggle";

export type ChatSettingsProps = {
  dark?: boolean;
  touch?: boolean;
  badgeLabel: string;
  title: string;
  subtitle: string;
  behaviorGroupTitle: string;
  followUpTitle: string;
  followUpDescription: string;
  immediateFollowUp: boolean;
  savingFollowUp?: boolean;
  rightPanelTitle: string;
  rightPanelDescription: string;
  openPagesInRightPanel: boolean;
  savingRightPanel?: boolean;
  externalNotificationsOwner?: boolean;
  notificationsGroupTitle: string;
  notifyTitle: string;
  notifyDescription: string;
  notifyEnabled: boolean;
  notifyDisabled?: boolean;
  notifyBusy?: boolean;
  showTestNotification?: boolean;
  testNotifyLabel: string;
  testNotifyActionLabel: string;
  connectImLabel?: string;
  errorMessage?: string;
  onChangeImmediateFollowUp: (enabled: boolean) => void;
  onChangeOpenPagesInRightPanel: (enabled: boolean) => void;
  onChangeNotifyEnabled: (enabled: boolean) => void;
  onTestNotification: () => void;
  onOpenImSettings?: () => void;
  onHaptic?: (style: string) => void;
};

/**
 * Adaptive OpenCraft Valdi surface for Settings -> Chat.
 * Matches `.settings-control-page-header`, `.settings-control-section`, and `.settings-control-row`
 * across macOS desktop compact density and iPadOS touch density.
 */
export class ChatSettingsSurface extends StatefulComponent<ChatSettingsProps, Record<string, never>> {
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

    <view width="100%">
      <view width="100%" gap={40}>
        {/* Canonical OpenCraft SettingsPageHeader */}
        <SettingsPageHeader title={vm.title} description={vm.subtitle} touch={vm.touch} dark={dark} />

        {vm.errorMessage && (
          <Banner id="oc-chat-settings-error" tone="danger" title={vm.errorMessage} touch={vm.touch} dark={dark} />
        )}

        {/* Response & Browsing Section */}
        <SettingsGroup title={vm.behaviorGroupTitle} touch={vm.touch} dark={dark}>
          <SettingsFormRow title={vm.followUpTitle} description={vm.followUpDescription} touch={vm.touch} dark={dark}>
            <Toggle
              id="oc-chat-followup-toggle"
              label={vm.followUpTitle}
              value={vm.immediateFollowUp}
              touch={vm.touch}
              disabled={vm.savingFollowUp}
              dark={dark}
              onChange={(next) => vm.onChangeImmediateFollowUp(next)}
            />
          </SettingsFormRow>

          <SettingsFormRow
            title={vm.rightPanelTitle}
            description={vm.rightPanelDescription}
            divider={true}
            touch={vm.touch}
            dark={dark}
          >
            <Toggle
              id="oc-chat-rightpanel-toggle"
              label={vm.rightPanelTitle}
              value={vm.openPagesInRightPanel}
              touch={vm.touch}
              disabled={vm.savingRightPanel}
              dark={dark}
              onChange={(next) => vm.onChangeOpenPagesInRightPanel(next)}
            />
          </SettingsFormRow>
        </SettingsGroup>

        {/* Completion Notifications Section */}
        {!vm.externalNotificationsOwner && (
          <SettingsGroup title={vm.notificationsGroupTitle} touch={vm.touch} dark={dark}>
            <SettingsFormRow title={vm.notifyTitle} description={vm.notifyDescription} touch={vm.touch} dark={dark}>
              <Toggle
                id="oc-chat-notify-toggle"
                label={vm.notifyTitle}
                value={vm.notifyEnabled}
                touch={vm.touch}
                disabled={vm.notifyDisabled}
                dark={dark}
                onChange={(next) => vm.onChangeNotifyEnabled(next)}
              />
            </SettingsFormRow>

            {vm.showTestNotification && (
              <SettingsFormRow title={vm.testNotifyLabel} divider={true} touch={vm.touch} dark={dark}>
                <Button
                  id="oc-chat-notify-test"
                  title={vm.testNotifyActionLabel}
                  variant="secondary"
                  size="sm"
                  loading={vm.notifyBusy}
                  touch={vm.touch}
                  disabled={vm.notifyBusy}
                  dark={dark}
                  onPress={() => {
                    triggerHaptic("selection");
                    vm.onTestNotification();
                  }}
                />
              </SettingsFormRow>
            )}

            {vm.connectImLabel && vm.onOpenImSettings && (
              <SettingsRow
                id="oc-chat-open-im"
                title={vm.connectImLabel}
                divider={true}
                touch={vm.touch}
                dark={dark}
                onSelect={() => {
                  triggerHaptic("selection");
                  vm.onOpenImSettings?.();
                }}
              />
            )}
          </SettingsGroup>
        )}
      </view>
    </view>;
  }
}
