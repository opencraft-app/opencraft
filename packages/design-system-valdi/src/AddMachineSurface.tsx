import { AnimationCurve } from "valdi_core/src/AnimationOptions";
import { StatefulComponent } from "valdi_core/src/Component";
import { systemFont } from "valdi_core/src/SystemFont";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { registerHapticHandler, triggerHaptic } from "./haptics";
import { Icon } from "./Icon";
import { SegmentedControl } from "./SegmentedControl";
import { SettingsGroup } from "./SettingsGroup";
import { themeColors, themeMetrics, type ColorTokens } from "./tokens";

export type PendingMachineSummary = {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
};

export type AddMachineProps = {
  dark?: boolean;
  touch?: boolean;
  badgeLabel: string;
  title: string;
  subtitle: string;
  closeLabel: string;
  platformLabel: string;
  macosLabel: string;
  linuxLabel: string;
  macosHint: string;
  linuxHint: string;
  commandGroupTitle: string;
  commandHint: string;
  generatingLabel: string;
  noEntranceTitle: string;
  noEntranceMessage: string;
  copyLabel: string;
  copiedLabel: string;
  regenerateLabel: string;
  statusGroupTitle: string;
  waitingTitle: string;
  waitingDetail: string;
  connectedTitle: string;
  connectedMessage?: string;
  doneLabel: string;
  revokeLabel: string;
  command: string;
  generating?: boolean;
  copied?: boolean;
  hasEntrance: boolean;
  error?: string;
  pendingMachines?: readonly PendingMachineSummary[];
  connectedMachineName?: string;
  onCopy: () => void;
  onRegenerate: () => void;
  onRevoke?: (id: string) => void;
  onClose: () => void;
  onHaptic?: (style: string) => void;
};

type State = {
  platformTab: "macos" | "linux";
  entered: boolean;
};

/**
 * Adaptive OpenCraft utility modal surface for enrolling personal Mac & Linux machines.
 */
export class AddMachineSurface extends StatefulComponent<AddMachineProps, State> {
  state: State = {
    platformTab: "macos",
    entered: false,
  };

  onCreate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
    setTimeout(() => {
      if (this.isDestroyed()) return;
      this.animate({ duration: 0.18, curve: AnimationCurve.EaseOut }, () => {
        this.setState({ entered: true });
      });
    }, 16);
  }

  onViewModelUpdate(previous?: Readonly<AddMachineProps>): void {
    registerHapticHandler(this.viewModel.onHaptic);
    if (this.viewModel.connectedMachineName && !previous?.connectedMachineName) {
      triggerHaptic("medium");
    }
  }

  private get c(): ColorTokens {
    return themeColors(this.viewModel.dark);
  }

  onRender(): void {
    const vm = this.viewModel;
    const dark = Boolean(vm.dark);
    const c = this.c;
    const m = themeMetrics(vm.touch);
    const entered = this.state.entered;
    const glassClass = dark ? "oc-liquid-glass oc-dark" : "oc-liquid-glass";
    const pendingList = vm.pendingMachines ?? [];
    const osHint = this.state.platformTab === "macos" ? vm.macosHint : vm.linuxHint;

    <view width="100%" padding={4} opacity={entered ? 1 : 0} scaleX={entered ? 1 : 0.98} scaleY={entered ? 1 : 0.98}>
      <glass
        class={glassClass}
        accessibilityId="add-machine-modal-dialog"
        accessibilityLabel={vm.title}
        width="100%"
        borderRadius={m.radii.modal}
        glassStyle="regular"
        backgroundColor={c.alert}
        glassTintColor={c.glassTint}
        borderWidth={0.5}
        borderColor={c.glassBorder}
        boxShadow={dark ? "complex 0 16 40 rgba(0, 0, 0, 0.38)" : "complex 0 12 34 rgba(24, 24, 28, 0.14)"}
        padding={20}
        gap={16}
      >
        {/* Modal Header */}
        <view flexDirection="row" alignItems="flex-start" justifyContent="space-between" gap={12}>
          <view flexGrow={1} flexShrink={1} minWidth={0} gap={4}>
            <label
              value={vm.title}
              font={m.fonts.sectionTitle}
              color={c.ink}
              accessibilityCategory="header"
              numberOfLines={0}
            />
            <label value={vm.subtitle} font={m.fonts.detail} color={c.muted} numberOfLines={0} />
          </view>
          <view
            class="oc-pill-button"
            accessibilityId="add-machine-modal-dialog-cancel"
            accessibilityLabel={vm.closeLabel}
            accessibilityCategory="button"
            onTap={() => {
              triggerHaptic("selection");
              vm.onClose();
            }}
            width={28}
            height={28}
            borderRadius={m.radii.control - 1}
            backgroundColor={c.trackSoft}
            borderWidth={0.5}
            borderColor={c.border}
            alignItems="center"
            justifyContent="center"
          >
            <Icon name="close" size={13} color={c.muted} />
          </view>
        </view>

        {/* Target OS Segmented Control */}
        <view gap={6}>
          <SegmentedControl
            id="oc-add-machine-os"
            label={vm.platformLabel}
            value={this.state.platformTab}
            options={[
              { id: "macos", title: vm.macosLabel },
              { id: "linux", title: vm.linuxLabel },
            ]}
            compact={!m.touch}
            touch={vm.touch}
            dark={dark}
            onChange={(next) => this.setState({ platformTab: next as "macos" | "linux" })}
          />
          <label value={osHint} font={m.fonts.detail} color={c.muted} numberOfLines={0} />
        </view>

        {/* One-time Enrollment Command */}
        {!vm.hasEntrance ? (
          <Banner
            id="oc-add-machine-no-entrance"
            tone="warning"
            title={vm.noEntranceTitle}
            message={vm.noEntranceMessage}
            touch={vm.touch}
            dark={dark}
          />
        ) : (
          <SettingsGroup title={vm.commandGroupTitle} touch={vm.touch} dark={dark}>
            <view padding={14} gap={10}>
              <view
                borderRadius={m.radii.control}
                backgroundColor={c.recessed}
                borderWidth={0.5}
                borderColor={c.border}
                paddingLeft={11}
                paddingRight={11}
                paddingTop={10}
                paddingBottom={10}
                flexDirection="row"
                alignItems="flex-start"
                gap={8}
              >
                <view paddingTop={2} accessibilityNavigation="ignored">
                  <Icon name="terminal" size={14} color={c.muted} />
                </view>
                <label
                  class="oc-mono"
                  accessibilityId="oc-add-machine-command-text"
                  value={vm.command ? vm.command : vm.generating ? vm.generatingLabel : "—"}
                  font={systemFont(12)}
                  color={vm.command ? c.ink : c.muted}
                  flexGrow={1}
                  flexShrink={1}
                  minWidth={0}
                  numberOfLines={4}
                />
              </view>
              <label value={vm.commandHint} font={m.fonts.detail} color={c.muted} numberOfLines={0} />
              <view flexDirection="row" justifyContent="flex-end" gap={8}>
                <Button
                  id="oc-add-machine-regenerate"
                  title={vm.regenerateLabel}
                  variant="quiet"
                  touch={vm.touch}
                  disabled={Boolean(vm.generating)}
                  dark={dark}
                  onPress={() => {
                    triggerHaptic("light");
                    vm.onRegenerate();
                  }}
                />
                <Button
                  id="oc-add-machine-copy"
                  title={vm.copied ? vm.copiedLabel : vm.copyLabel}
                  variant="primary"
                  touch={vm.touch}
                  disabled={!vm.command || Boolean(vm.generating)}
                  dark={dark}
                  onPress={() => {
                    triggerHaptic("selection");
                    vm.onCopy();
                  }}
                />
              </view>
            </view>
          </SettingsGroup>
        )}

        {vm.error && <Banner id="oc-add-machine-error" tone="danger" title={vm.error} touch={vm.touch} dark={dark} />}

        {/* Live Enrollment Status */}
        {vm.connectedMachineName ? (
          <Banner
            id="oc-add-machine-connected"
            tone="success"
            title={`${vm.connectedTitle} · ${vm.connectedMachineName}`}
            message={vm.connectedMessage}
            actionTitle={vm.doneLabel}
            onAction={() => {
              triggerHaptic("selection");
              vm.onClose();
            }}
            touch={vm.touch}
            dark={dark}
          />
        ) : pendingList.length > 0 ? (
          <SettingsGroup title={vm.statusGroupTitle} touch={vm.touch} dark={dark}>
            {pendingList.forEach((item, index) => {
              <view key={item.id}>
                {index > 0 && <view height={0.5} marginLeft={16} marginRight={16} backgroundColor={c.border} />}
                <view
                  minHeight={46}
                  paddingLeft={14}
                  paddingRight={12}
                  paddingTop={8}
                  paddingBottom={8}
                  flexDirection="row"
                  alignItems="center"
                  gap={10}
                >
                  <view
                    width={7}
                    height={7}
                    borderRadius={3.5}
                    backgroundColor={c.accent}
                    accessibilityNavigation="ignored"
                  />
                  <view flexGrow={1} flexShrink={1} minWidth={0} gap={2}>
                    <label value={item.label || vm.waitingTitle} font={m.fonts.body} color={c.ink} numberOfLines={1} />
                    <label
                      value={item.detail || vm.waitingDetail}
                      font={m.fonts.detail}
                      color={c.muted}
                      numberOfLines={1}
                    />
                  </view>
                  {vm.onRevoke && (
                    <Button
                      id={`oc-add-machine-revoke-${item.id}`}
                      title={vm.revokeLabel}
                      variant="danger"
                      size="sm"
                      touch={vm.touch}
                      dark={dark}
                      onPress={() => {
                        triggerHaptic("light");
                        vm.onRevoke?.(item.id);
                      }}
                    />
                  )}
                </view>
              </view>;
            })}
          </SettingsGroup>
        ) : null}
      </glass>
    </view>;
  }
}
