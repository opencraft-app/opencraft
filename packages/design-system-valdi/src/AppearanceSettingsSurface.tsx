import { StatefulComponent } from "valdi_core/src/Component";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { registerHapticHandler, triggerHaptic } from "./haptics";
import { SegmentedControl } from "./SegmentedControl";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";
import { SettingsFormRow, SettingsGroup, SettingsPageHeader } from "./SettingsGroup";
import { themeColors, themeMetrics } from "./tokens";

export type AppearanceThemeCardItem = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly sidebarBg: string;
  readonly headerBg: string;
  readonly canvasBg: string;
  readonly pillBg: string;
  readonly previewBorder: string;
};

export type AppearanceSettingsProps = {
  dark?: boolean;
  touch?: boolean;
  narrow?: boolean;
  title: string;
  subtitle: string;
  errorMessage?: string;
  interfaceGroupTitle: string;
  interfaceGroupDescription: string;
  languageTitle: string;
  languageValue: string;
  languageOptions: readonly SelectMenuOption[];
  touchTitle: string;
  touchDescription: string;
  touchValue: string;
  touchOptions: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  showMobileSource?: boolean;
  mobileSourceTitle?: string;
  mobileSourceDescription?: string;
  mobileSourceActionLabel?: string;
  modeTitle: string;
  modeDescription: string;
  modeValue: string;
  modeOptions: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  themeTitle: string;
  themeDescription: string;
  themeId: string;
  themes: readonly AppearanceThemeCardItem[];
  showUiKit?: boolean;
  uiKitTitle: string;
  uiKitDescription: string;
  uiKitActionLabel: string;
  onChangeLanguage: (locale: string) => void;
  onChangeTouch: (value: string) => void;
  onOpenMobileSource?: () => void;
  onChangeMode: (mode: string) => void;
  onChangeTheme: (themeId: string) => void;
  onOpenUiKit: () => void;
  onHaptic?: (style: string) => void;
};

type State = {
  languageMenuOpen: boolean;
};

/**
 * Adaptive OpenCraft Valdi surface for Settings -> Appearance (`/settings/appearance`).
 * Unifies Language, Touch Density, Light/Dark/System Mode, Theme Palette Grid, and Valdi UI Kit entry.
 */
export class AppearanceSettingsSurface extends StatefulComponent<AppearanceSettingsProps, State> {
  state: State = { languageMenuOpen: false };

  onCreate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
  }

  onViewModelUpdate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
  }

  private renderThemeCard(item: AppearanceThemeCardItem, selected: boolean, dark: boolean, touch?: boolean): void {
    const c = themeColors(dark);
    const m = themeMetrics(touch);

    <view
      key={item.id}
      class="oc-settings-row"
      accessibilityId={`oc-theme-card-${item.id}`}
      accessibilityLabel={item.description ? `${item.label}, ${item.description}` : item.label}
      accessibilityCategory="button"
      accessibilityStateSelected={selected}
      onTap={() => {
        triggerHaptic("selection");
        if (this.state.languageMenuOpen) this.setState({ languageMenuOpen: false });
        if (!selected) this.viewModel.onChangeTheme(item.id);
      }}
      flexGrow={1}
      flexBasis={0}
      minWidth={0}
      padding={12}
      borderRadius={14}
      backgroundColor={selected ? c.trackSoft : c.surface}
      borderWidth={selected ? 1.5 : 0.5}
      borderColor={selected ? c.accent : c.border}
      flexDirection="row"
      alignItems="center"
      gap={12}
    >
      {/* Mini Workbench Window Preview (86x56) */}
      <view
        width={86}
        height={56}
        flexShrink={0}
        borderRadius={9}
        borderWidth={0.5}
        borderColor={item.previewBorder}
        backgroundColor={item.canvasBg}
        flexDirection="row"
        slowClipping={true}
        accessibilityNavigation="ignored"
      >
        <view width={25} height="100%" backgroundColor={item.sidebarBg} />
        <view width={0.5} height="100%" backgroundColor={item.previewBorder} />
        <view flexGrow={1} height="100%" justifyContent="space-between">
          <view width="100%" height={14} backgroundColor={item.headerBg} justifyContent="flex-end">
            <view width="100%" height={0.5} backgroundColor={item.previewBorder} />
          </view>
          <view width="100%" paddingBottom={8} alignItems="center">
            <view width={31} height={8} borderRadius={4} backgroundColor={item.pillBg} />
          </view>
        </view>
      </view>

      {/* Theme Name & Optional Description */}
      <view flexGrow={1} flexShrink={1} minWidth={0} gap={3}>
        <label value={item.label} font={m.fonts.controlCompact} color={c.ink} numberOfLines={1} />
        {item.description ? (
          <label value={item.description} font={m.fonts.caption} color={c.muted} numberOfLines={2} />
        ) : null}
      </view>

      {/* Radio Selection Ring */}
      <view
        width={16}
        height={16}
        flexShrink={0}
        borderRadius={8}
        borderWidth={selected ? 1.5 : 1}
        borderColor={selected ? c.accent : c.border}
        alignItems="center"
        justifyContent="center"
        accessibilityNavigation="ignored"
      >
        {selected && <view width={8} height={8} borderRadius={4} backgroundColor={c.accent} />}
      </view>
    </view>;
  }

  onRender(): void {
    const vm = this.viewModel;
    const dark = Boolean(vm.dark);
    const singleColumn = Boolean(vm.narrow);
    const rows: Array<readonly AppearanceThemeCardItem[]> = [];
    if (singleColumn) {
      for (const item of vm.themes) rows.push([item]);
    } else {
      for (let i = 0; i < vm.themes.length; i += 2) {
        rows.push(vm.themes.slice(i, i + 2));
      }
    }

    <view width="100%">
      {this.state.languageMenuOpen && (
        <view
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          zIndex={30}
          onTap={() => this.setState({ languageMenuOpen: false })}
          accessibilityNavigation="ignored"
        />
      )}

      <view width="100%" gap={40}>
        <SettingsPageHeader title={vm.title} description={vm.subtitle} touch={vm.touch} dark={dark} />

        {vm.errorMessage && (
          <Banner id="oc-appearance-error" tone="danger" title={vm.errorMessage} touch={vm.touch} dark={dark} />
        )}

        <SettingsGroup
          title={vm.interfaceGroupTitle}
          description={vm.interfaceGroupDescription}
          clip={!this.state.languageMenuOpen}
          zIndex={this.state.languageMenuOpen ? 50 : 1}
          touch={vm.touch}
          dark={dark}
        >
          {/* Language Selector */}
          <SettingsFormRow title={vm.languageTitle} touch={vm.touch} dark={dark}>
            <SelectMenu
              id="oc-appearance-language"
              label={vm.languageTitle}
              value={vm.languageValue}
              options={vm.languageOptions}
              open={this.state.languageMenuOpen}
              minWidth={156}
              align="right"
              touch={vm.touch}
              dark={dark}
              onOpenChange={(open) => this.setState({ languageMenuOpen: open })}
              onChange={(locale) => vm.onChangeLanguage(locale)}
            />
          </SettingsFormRow>

          {/* Touch Experience */}
          <SettingsFormRow
            title={vm.touchTitle}
            description={vm.touchDescription}
            divider={true}
            touch={vm.touch}
            dark={dark}
          >
            <SegmentedControl
              id="oc-appearance-touch"
              label={vm.touchTitle}
              value={vm.touchValue}
              options={vm.touchOptions}
              compact={true}
              touch={vm.touch}
              dark={dark}
              onChange={(val) => vm.onChangeTouch(val)}
            />
          </SettingsFormRow>

          {/* Optional Mobile Workspace Source */}
          {vm.showMobileSource && vm.mobileSourceTitle && vm.mobileSourceActionLabel && vm.onOpenMobileSource && (
            <SettingsFormRow
              title={vm.mobileSourceTitle}
              description={vm.mobileSourceDescription}
              divider={true}
              touch={vm.touch}
              dark={dark}
            >
              <Button
                id="oc-appearance-mobile-source"
                title={vm.mobileSourceActionLabel}
                variant="secondary"
                size="sm"
                touch={vm.touch}
                dark={dark}
                onPress={vm.onOpenMobileSource}
              />
            </SettingsFormRow>
          )}

          {/* Appearance Mode (Light / Dark / System) */}
          <SettingsFormRow
            title={vm.modeTitle}
            description={vm.modeDescription}
            divider={true}
            touch={vm.touch}
            dark={dark}
          >
            <SegmentedControl
              id="oc-appearance-mode"
              label={vm.modeTitle}
              value={vm.modeValue}
              options={vm.modeOptions}
              compact={true}
              touch={vm.touch}
              dark={dark}
              onChange={(mode) => vm.onChangeMode(mode)}
            />
          </SettingsFormRow>

          {/* Theme Palette Grid */}
          <SettingsFormRow
            title={vm.themeTitle}
            description={vm.themeDescription}
            divider={true}
            stacked={true}
            touch={vm.touch}
            dark={dark}
          >
            <view width="100%" gap={10}>
              {rows.forEach((pair, rowIndex) => {
                <view key={`theme-row-${rowIndex}`} width="100%" flexDirection="row" gap={12}>
                  {pair.forEach((item) => {
                    this.renderThemeCard(item, item.id === vm.themeId, dark, vm.touch);
                  })}
                  {!singleColumn && pair.length === 1 && (
                    <view flexGrow={1} flexBasis={0} minWidth={0} accessibilityNavigation="ignored" />
                  )}
                </view>;
              })}
            </view>
          </SettingsFormRow>

          {/* Valdi Style Lab Entry (Developer Mode only) */}
          {vm.showUiKit && (
            <SettingsFormRow
              title={vm.uiKitTitle}
              description={vm.uiKitDescription}
              divider={true}
              touch={vm.touch}
              dark={dark}
            >
              <Button
                id="oc-appearance-open-uikit"
                title={vm.uiKitActionLabel}
                variant="primary"
                size="sm"
                touch={vm.touch}
                dark={dark}
                onPress={vm.onOpenUiKit}
              />
            </SettingsFormRow>
          )}
        </SettingsGroup>
      </view>
    </view>;
  }
}
