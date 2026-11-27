import { StatefulComponent } from "valdi_core/src/Component";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { registerHapticHandler } from "./haptics";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";
import { SettingsFormRow, SettingsGroup, SettingsPageHeader } from "./SettingsGroup";
import { themeColors, themeMetrics } from "./tokens";

export type VoiceInputSettingsProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly serviceGroupTitle: string;
  readonly refreshLabel: string;
  readonly refreshing?: boolean;
  readonly saving?: boolean;
  readonly methodTitle: string;
  readonly methodDescription: string;
  readonly methodValue: string;
  readonly methodOptions: readonly SelectMenuOption[];
  readonly modelTitle: string;
  readonly modelDescription: string;
  readonly modelValue: string;
  readonly modelDisabled?: boolean;
  readonly modelOptions: readonly SelectMenuOption[];
  readonly hunyuanTitle: string;
  readonly hunyuanDescription: string;
  readonly hunyuanStatus: string;
  readonly hunyuanTone?: "ready" | "loading" | "unavailable";
  readonly durationTitle: string;
  readonly durationDescription: string;
  readonly durationValue: string;
  readonly errorMessage?: string;
  readonly onRefresh: () => void;
  readonly onChangeMethod: (value: string) => void;
  readonly onChangeModel: (value: string) => void;
  readonly onHaptic?: (style: string) => void;
};

type State = {
  openMenu: "method" | "model" | null;
};

/**
 * Adaptive OpenCraft Valdi surface for Settings -> Voice Input (`/settings/opencraft.voice-input.web-settings`).
 */
export class VoiceInputSettingsSurface extends StatefulComponent<VoiceInputSettingsProps, State> {
  state: State = { openMenu: null };

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
    const menuOpen = this.state.openMenu !== null;
    const statusColor = vm.hunyuanTone === "ready" ? c.success : vm.hunyuanTone === "loading" ? c.muted : c.disabled;

    <view width="100%">
      {menuOpen && (
        <view
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          zIndex={30}
          onTap={() => this.setState({ openMenu: null })}
          accessibilityNavigation="ignored"
        />
      )}

      <view width="100%" gap={32}>
        <SettingsPageHeader title={vm.title} description={vm.subtitle} touch={vm.touch} dark={dark}>
          <Button
            id="oc-voice-refresh"
            title={vm.refreshLabel}
            variant="secondary"
            size="sm"
            disabled={vm.refreshing}
            touch={vm.touch}
            dark={dark}
            onPress={vm.onRefresh}
          />
        </SettingsPageHeader>

        <SettingsGroup
          title={vm.serviceGroupTitle}
          clip={!menuOpen}
          zIndex={menuOpen ? 50 : 1}
          touch={vm.touch}
          dark={dark}
        >
          <SettingsFormRow title={vm.methodTitle} description={vm.methodDescription} touch={vm.touch} dark={dark}>
            <SelectMenu
              id="oc-voice-method"
              label={vm.methodTitle}
              value={vm.methodValue}
              options={vm.methodOptions}
              open={this.state.openMenu === "method"}
              disabled={vm.saving}
              minWidth={168}
              align="right"
              touch={vm.touch}
              dark={dark}
              onOpenChange={(open) => this.setState({ openMenu: open ? "method" : null })}
              onChange={(val) => vm.onChangeMethod(val)}
            />
          </SettingsFormRow>

          <SettingsFormRow
            title={vm.modelTitle}
            description={vm.modelDescription}
            divider={true}
            touch={vm.touch}
            dark={dark}
          >
            <SelectMenu
              id="oc-voice-model"
              label={vm.modelTitle}
              value={vm.modelValue}
              options={vm.modelOptions}
              open={this.state.openMenu === "model"}
              disabled={vm.saving || vm.modelDisabled}
              minWidth={168}
              align="right"
              touch={vm.touch}
              dark={dark}
              onOpenChange={(open) => this.setState({ openMenu: open ? "model" : null })}
              onChange={(val) => vm.onChangeModel(val)}
            />
          </SettingsFormRow>

          <SettingsFormRow
            title={vm.hunyuanTitle}
            description={vm.hunyuanDescription}
            divider={true}
            touch={vm.touch}
            dark={dark}
          >
            <view flexDirection="row" alignItems="center" gap={6}>
              <view
                width={6}
                height={6}
                borderRadius={3}
                backgroundColor={statusColor}
                accessibilityNavigation="ignored"
              />
              <label value={vm.hunyuanStatus} font={m.fonts.controlCompact} color={c.muted} numberOfLines={1} />
            </view>
          </SettingsFormRow>

          <SettingsFormRow
            title={vm.durationTitle}
            description={vm.durationDescription}
            divider={true}
            touch={vm.touch}
            dark={dark}
          >
            <label value={vm.durationValue} font={m.fonts.controlCompact} color={c.muted} numberOfLines={1} />
          </SettingsFormRow>
        </SettingsGroup>

        {vm.errorMessage && (
          <Banner id="oc-voice-error" tone="danger" title={vm.errorMessage} touch={vm.touch} dark={dark} />
        )}
      </view>
    </view>;
  }
}
