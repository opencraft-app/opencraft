import { Component } from "valdi_core/src/Component";
import { SettingsFormRow, SettingsGroup, SettingsPageHeader } from "./SettingsGroup";
import { themeColors, themeMetrics } from "./tokens";

export type ShortcutRowItem = {
  readonly id: string;
  readonly label: string;
  readonly keys: string;
};

export type ShortcutsSettingsProps = {
  readonly dark?: boolean;
  readonly touch?: boolean;
  readonly title: string;
  readonly rows: readonly ShortcutRowItem[];
  readonly aliasNote?: string;
};

/**
 * Adaptive OpenCraft Valdi surface for Settings -> Keyboard Shortcuts (`/settings/shortcuts`).
 */
export class ShortcutsSettingsSurface extends Component<ShortcutsSettingsProps> {
  onRender(): void {
    const vm = this.viewModel;
    const dark = Boolean(vm.dark);
    const c = themeColors(dark);
    const m = themeMetrics(vm.touch);

    <view width="100%" gap={24}>
      <SettingsPageHeader title={vm.title} touch={vm.touch} dark={dark} />

      <SettingsGroup title="" touch={vm.touch} dark={dark}>
        {vm.rows.forEach((row, idx) => {
          <SettingsFormRow key={row.id} title={row.label} divider={idx > 0} touch={vm.touch} dark={dark}>
            <view
              class="oc-mono"
              paddingLeft={8}
              paddingRight={8}
              paddingTop={4}
              paddingBottom={4}
              borderRadius={6}
              backgroundColor={c.recessed}
              borderWidth={0.5}
              borderColor={c.border}
              alignItems="center"
              justifyContent="center"
            >
              <label value={row.keys} font={m.fonts.controlCompact} color={c.ink} numberOfLines={1} />
            </view>
          </SettingsFormRow>;
        })}
      </SettingsGroup>

      {vm.aliasNote ? <label value={vm.aliasNote} font={m.fonts.detail} color={c.muted} numberOfLines={0} /> : null}
    </view>;
  }
}
