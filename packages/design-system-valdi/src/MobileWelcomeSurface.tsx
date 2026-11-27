import { StatefulComponent } from "valdi_core/src/Component";
import { systemSemiboldFont } from "valdi_core/src/SystemFont";
import { Button } from "./Button";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { registerHapticHandler } from "./haptics";
import { ColorTokens, themeColors, themeMetrics } from "./tokens";

export type MobileWelcomeProps = {
  dark?: boolean;
  touch?: boolean;
  safeAreaTop?: number;
  safeAreaBottom?: number;
  themePreference?: "light" | "dark" | "system";
  hasSourceSettings?: boolean;
  brandLabel?: string;
  heroBadge?: string;
  title: string;
  subtitle: string;
  tabStart?: string;
  tabAppearance?: string;
  tabComponents?: string;
  connectGroupTitle: string;
  connectServerTitle: string;
  connectServerDetail: string;
  exploreOfflineTitle: string;
  exploreOfflineDetail: string;
  sourceSettingsTitle: string;
  sourceSettingsDetail: string;
  quickActionsBtn?: string;
  openStyleLabBtn?: string;
  appearanceModeTitle?: string;
  lightLabel?: string;
  darkLabel?: string;
  systemLabel?: string;
  physicsGroupTitle?: string;
  hapticsToggleTitle?: string;
  springSliderLabel?: string;
  bannerTitle?: string;
  bannerMessage?: string;
  cancelLabel?: string;
  onConnect: () => void;
  onExplore: () => void;
  onOpenStyleLab?: () => void;
  onOpenSourceSettings?: () => void;
  onThemePreferenceChange?: (preference: "light" | "dark" | "system") => void;
  onHaptic?: (style: string) => void;
};

/**
 * Clean OpenCraft onboarding surface shared across native iOS/iPadOS (SCValdiView)
 * and browser Web (ValdiWebRenderer) when no server host is configured yet.
 */
export class MobileWelcomeSurface extends StatefulComponent<MobileWelcomeProps, Record<string, never>> {
  state: Record<string, never> = {};

  onCreate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
  }

  onViewModelUpdate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
  }

  private get c(): ColorTokens {
    return themeColors(this.viewModel.dark);
  }

  onRender(): void {
    const vm = this.viewModel;
    const dark = !!vm.dark;
    const touch = vm.touch ?? true;
    const safeTop = vm.safeAreaTop ?? 0;
    const safeBottom = vm.safeAreaBottom ?? 0;
    const c = this.c;
    const m = themeMetrics(touch);
    const emblem = "O";

    <view width="100%" height="100%" backgroundColor={c.canvas}>
      <scroll flexGrow={1} flexBasis={0} minHeight={0}>
        <view
          width="100%"
          maxWidth={460}
          alignSelf="center"
          paddingLeft={20}
          paddingRight={20}
          paddingTop={safeTop + 36}
          paddingBottom={safeBottom + 36}
          gap={24}
        >
          {/* OpenCraft Brand Header */}
          <view gap={12}>
            <view flexDirection="row" alignItems="center" gap={9}>
              <view
                width={30}
                height={30}
                borderRadius={8}
                backgroundColor={c.primaryButton}
                alignItems="center"
                justifyContent="center"
              >
                <label value={emblem} font={systemSemiboldFont(15)} color={c.primaryButtonForeground} />
              </view>
              <label value={vm.brandLabel ?? vm.heroBadge ?? "OpenCraft"} font={systemSemiboldFont(15)} color={c.ink} />
            </view>
            <view gap={6}>
              <label
                value={vm.title}
                font={systemSemiboldFont(24)}
                color={c.ink}
                accessibilityCategory="header"
                numberOfLines={0}
              />
              <label value={vm.subtitle} font={m.fonts.pageSummary} color={c.muted} numberOfLines={3} />
            </view>
          </view>

          {/* Core Actions */}
          <SettingsGroup title={vm.connectGroupTitle} touch={touch} dark={dark}>
            <SettingsRow
              id="welcome-connect-row"
              title={vm.connectServerTitle}
              detail={vm.connectServerDetail}
              touch={touch}
              dark={dark}
              onSelect={vm.onConnect}
            />
            <SettingsRow
              id="welcome-explore-row"
              title={vm.exploreOfflineTitle}
              detail={vm.exploreOfflineDetail}
              divider={true}
              touch={touch}
              dark={dark}
              onSelect={vm.onExplore}
            />
            {vm.hasSourceSettings && vm.onOpenSourceSettings && (
              <SettingsRow
                id="welcome-source-row"
                title={vm.sourceSettingsTitle}
                detail={vm.sourceSettingsDetail}
                divider={true}
                touch={touch}
                dark={dark}
                onSelect={vm.onOpenSourceSettings}
              />
            )}
          </SettingsGroup>

          <view gap={8}>
            <Button
              id="welcome-primary-connect"
              title={vm.connectServerTitle}
              variant="primary"
              touch={touch}
              dark={dark}
              onPress={vm.onConnect}
            />
            <Button
              id="welcome-explore-btn"
              title={vm.exploreOfflineTitle}
              variant="quiet"
              touch={touch}
              dark={dark}
              onPress={vm.onExplore}
            />
          </view>
        </view>
      </scroll>
    </view>;
  }
}
