import { AnimationCurve } from "valdi_core/src/AnimationOptions";
import { Component, StatefulComponent } from "valdi_core/src/Component";
import { systemFont, systemSemiboldFont } from "valdi_core/src/SystemFont";
import { registerHapticHandler, triggerHaptic } from "./haptics";
import { Icon, type IconName } from "./Icon";
import { ProgressBar } from "./ProgressBar";
import { SegmentedControl } from "./SegmentedControl";
import { themeColors, themeMetrics } from "./tokens";

export type SidebarDockTabItem = {
  readonly id: string;
  readonly title: string;
  readonly icon: IconName;
  readonly badge?: string;
};

export type SidebarDockProps = {
  dark?: boolean;
  touch?: boolean;
  label: string;
  items: readonly SidebarDockTabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onHaptic?: (style: string) => void;
};

type DockState = {
  displayedIndex: number;
};

/**
 * Adaptive OpenCraft sidebar footer navigation dock:
 * - macOS / desktop (`touch = false`): quiet borderless rail with a 9px rounded-square
 *   spring-sliding & drag-scrubbable selection indicator matching OpenCraft's native rail.
 * - iPadOS / touch (`touch = true`): 42px subtle translucent bar with spacious touch targets.
 */
export class SidebarDockSurface extends StatefulComponent<SidebarDockProps, DockState> {
  state: DockState = { displayedIndex: 0 };

  private resolveIndex(): number {
    if (!this.viewModel.activeId) return -1;
    return this.viewModel.items.findIndex((item) => item.id === this.viewModel.activeId);
  }

  onCreate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
    const idx = this.resolveIndex();
    if (idx >= 0) this.setState({ displayedIndex: idx });
  }

  onViewModelUpdate(previous?: Readonly<SidebarDockProps>): void {
    registerHapticHandler(this.viewModel.onHaptic);
    const nextIndex = this.resolveIndex();
    if (
      nextIndex >= 0 &&
      (!previous || (previous.activeId !== this.viewModel.activeId && nextIndex !== this.state.displayedIndex))
    ) {
      this.animate({ stiffness: 360, damping: 30, beginFromCurrentState: true }, () => {
        this.setState({ displayedIndex: nextIndex });
      });
    }
  }

  private selectItem(index: number, id: string): void {
    triggerHaptic("selection");
    if (index >= 0 && index !== this.state.displayedIndex) {
      this.animate({ stiffness: 360, damping: 30, beginFromCurrentState: true }, () => {
        this.setState({ displayedIndex: index });
      });
    }
    this.viewModel.onSelect(id);
  }

  onRender(): void {
    const vm = this.viewModel;
    const dark = Boolean(vm.dark);
    const c = themeColors(dark);
    const m = themeMetrics(vm.touch);
    const count = vm.items.length;
    const itemSize = m.sizes.dockHeight;
    const itemGap = 8;
    const thumbRadius = m.sizes.dockRadius;
    const activeIndex = this.resolveIndex();
    const hasActive = activeIndex >= 0;
    const thumbIndex = Math.max(0, Math.min(count - 1, this.state.displayedIndex));
    const thumbOffset = thumbIndex * (itemSize + itemGap);
    const iconSize = m.touch ? 23 : 20;

    <view width="100%">
      <view
        class="oc-dock-track"
        accessibilityId="oc-sidebar-dock"
        accessibilityLabel={vm.label}
        height={itemSize}
        flexDirection="row"
        alignItems="center"
        gap={itemGap}
      >
        {count > 0 && (
          <view
            class="oc-dock-thumb"
            position="absolute"
            top={0}
            left={0}
            width={itemSize}
            height={itemSize}
            translationX={thumbOffset}
            borderRadius={thumbRadius}
            backgroundColor={c.navCurrent}
            opacity={hasActive ? 1 : 0}
            scaleX={hasActive ? 1 : 0.88}
            scaleY={hasActive ? 1 : 0.88}
            accessibilityNavigation="ignored"
          />
        )}
        {vm.items.forEach((item, index) => {
          const selected = item.id === vm.activeId;
          const iconColor = selected ? c.ink : c.muted;
          <view
            key={item.id}
            class="oc-dock-item"
            accessibilityId={`oc-sidebar-dock-${item.id}`}
            accessibilityLabel={item.title}
            accessibilityCategory="button"
            accessibilityStateSelected={selected}
            onTap={() => this.selectItem(index, item.id)}
            width={itemSize}
            height={itemSize}
            borderRadius={thumbRadius}
            justifyContent="center"
            alignItems="center"
          >
            <view width={24} height={24} justifyContent="center" alignItems="center">
              <Icon name={item.icon} size={iconSize} color={iconColor} />
              {item.badge && (
                <view
                  position="absolute"
                  top={-3}
                  right={-5}
                  paddingLeft={3.5}
                  paddingRight={3.5}
                  minWidth={13}
                  height={13}
                  borderRadius={7}
                  backgroundColor={c.accent}
                  justifyContent="center"
                  alignItems="center"
                >
                  <label value={item.badge} font={systemSemiboldFont(8.5)} color={c.accentForeground} />
                </view>
              )}
            </view>
          </view>;
        })}
      </view>
    </view>;
  }
}

export type SidebarOrbProps = {
  dark?: boolean;
  touch?: boolean;
  chromeless?: boolean;
  icon: IconName;
  active?: boolean;
  badgeDot?: boolean;
};

/**
 * Matching companion entrance button (Settings / Updates) sharing the exact
 * quiet rounded-square geometry of the OpenCraft sidebar footer.
 */
export class SidebarOrbSurface extends Component<SidebarOrbProps> {
  onRender(): void {
    const { dark = false, touch, chromeless = false, icon, active = false, badgeDot = false } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);
    const iconSize = m.touch ? 23 : 20;
    const iconColor = active ? c.ink : c.muted;

    if (chromeless) {
      const slot = m.touch ? 26 : 22;
      <view width={slot} height={slot} alignItems="center" justifyContent="center" accessibilityNavigation="ignored">
        <Icon name={icon} size={iconSize} color={iconColor} />
        {badgeDot && (
          <view
            position="absolute"
            top={0}
            right={0}
            width={6.5}
            height={6.5}
            borderRadius={3.5}
            backgroundColor={c.accent}
            accessibilityNavigation="ignored"
          />
        )}
      </view>;
      return;
    }

    const size = m.sizes.dockHeight;
    const radius = m.sizes.dockRadius;
    const bg = active ? c.navCurrent : m.touch ? c.trackSubtle : undefined;

    <view width={size} height={size} accessibilityNavigation="ignored">
      <view
        width={size}
        height={size}
        borderRadius={radius}
        backgroundColor={bg}
        borderWidth={m.touch && !active ? 0.5 : 0}
        borderColor={c.border}
        alignItems="center"
        justifyContent="center"
        accessibilityNavigation="ignored"
      >
        <view width={24} height={24} alignItems="center" justifyContent="center" accessibilityNavigation="ignored">
          <Icon name={icon} size={iconSize} color={iconColor} />
          {badgeDot && (
            <view
              position="absolute"
              top={0}
              right={0}
              width={6.5}
              height={6.5}
              borderRadius={3.5}
              backgroundColor={c.accent}
              accessibilityNavigation="ignored"
            />
          )}
        </view>
      </view>
    </view>;
  }
}

export type TokenUsageWindowItem = {
  readonly id: string;
  readonly label: string;
  readonly progress: number;
  readonly percentText: string;
  readonly resetText: string;
  readonly costText?: string;
  readonly warning?: boolean;
};

export type TokenUsageMetricItem = {
  readonly label: string;
  readonly value: string;
};

export type TokenUsageProps = {
  dark?: boolean;
  touch?: boolean;
  open: boolean;
  title: string;
  summary: string;
  machineLabel?: string;
  machines?: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  selectedMachineId?: string;
  providerLabel: string;
  providers: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  selectedProviderId: string;
  planText?: string;
  accountText?: string;
  refreshLabel: string;
  refreshDisabled?: boolean;
  statusMessage?: string;
  windows: readonly TokenUsageWindowItem[];
  conversationHeading: string;
  conversationProvider?: string;
  contextLabel?: string;
  contextDetail?: string;
  contextProgress?: number;
  conversationFallback?: string;
  metrics: readonly TokenUsageMetricItem[];
  observedAtText?: string;
  onToggleOpen: () => void;
  onSelectMachine?: (id: string) => void;
  onSelectProvider: (id: string) => void;
  onRefresh: () => void;
  onHaptic?: (style: string) => void;
};

/**
 * Quiet OpenCraft sidebar Token Usage disclosure row + expandable inspector card.
 */
export class TokenUsageSurface extends StatefulComponent<TokenUsageProps, { cardVisible: boolean }> {
  state = { cardVisible: false };

  onCreate(): void {
    registerHapticHandler(this.viewModel.onHaptic);
    this.setState({ cardVisible: this.viewModel.open });
  }

  onViewModelUpdate(previous?: Readonly<TokenUsageProps>): void {
    registerHapticHandler(this.viewModel.onHaptic);
    if (previous?.open !== this.viewModel.open) {
      this.animate({ duration: 0.16, curve: AnimationCurve.EaseOut }, () => {
        this.setState({ cardVisible: this.viewModel.open });
      });
    }
  }

  onRender(): void {
    const vm = this.viewModel;
    const dark = Boolean(vm.dark);
    const c = themeColors(dark);
    const m = themeMetrics(vm.touch);
    const glassClass = dark ? "oc-liquid-glass oc-dark" : "oc-liquid-glass";

    <view width="100%" paddingLeft={8} paddingRight={8} paddingTop={2} paddingBottom={2} gap={6}>
      {vm.open && (
        <glass
          class={glassClass}
          width="100%"
          borderRadius={m.radii.card - 2}
          glassStyle="regular"
          glassTintColor={c.glassTint}
          borderWidth={0.5}
          borderColor={c.glassBorder}
          boxShadow={dark ? "complex 0 8 22 rgba(0, 0, 0, 0.30)" : "complex 0 6 18 rgba(24, 24, 28, 0.08)"}
          padding={10}
          gap={9}
          opacity={this.state.cardVisible ? 1 : 0}
        >
          {vm.machines && vm.machines.length > 1 && vm.selectedMachineId && vm.onSelectMachine && (
            <SegmentedControl
              id="oc-usage-machines"
              label={vm.machineLabel ?? vm.title}
              value={vm.selectedMachineId}
              options={vm.machines}
              compact={true}
              touch={vm.touch}
              dark={dark}
              onChange={(id) => vm.onSelectMachine?.(id)}
            />
          )}

          <view flexDirection="row" alignItems="center" gap={6}>
            <view flexGrow={1} flexBasis={0} minWidth={0}>
              <SegmentedControl
                id="oc-usage-providers"
                label={vm.providerLabel}
                value={vm.selectedProviderId}
                options={vm.providers}
                compact={true}
                touch={vm.touch}
                dark={dark}
                onChange={(id) => vm.onSelectProvider(id)}
              />
            </view>
            <view
              class="oc-pill-button"
              accessibilityId="oc-usage-refresh"
              accessibilityLabel={vm.refreshLabel}
              accessibilityCategory="button"
              accessibilityStateDisabled={vm.refreshDisabled}
              onTap={
                vm.refreshDisabled
                  ? undefined
                  : () => {
                      triggerHaptic("light");
                      vm.onRefresh();
                    }
              }
              width={m.touch ? 32 : 28}
              height={m.touch ? 32 : 28}
              borderRadius={m.radii.control - 1}
              backgroundColor={c.trackSoft}
              borderWidth={0.5}
              borderColor={c.border}
              opacity={vm.refreshDisabled ? 0.45 : 1}
              alignItems="center"
              justifyContent="center"
            >
              <Icon name="refresh" size={13} color={c.muted} />
            </view>
          </view>

          {(vm.planText || vm.accountText) && (
            <view
              flexDirection="row"
              alignItems="center"
              justifyContent="space-between"
              gap={8}
              paddingLeft={2}
              paddingRight={2}
            >
              {vm.planText && (
                <view
                  paddingLeft={6}
                  paddingRight={6}
                  height={18}
                  borderRadius={5}
                  backgroundColor={c.trackSoft}
                  alignItems="center"
                  justifyContent="center"
                >
                  <label value={vm.planText} font={systemSemiboldFont(10.5)} color={c.ink} />
                </view>
              )}
              {vm.accountText && (
                <label value={vm.accountText} font={systemFont(11)} color={c.muted} flexShrink={1} numberOfLines={1} />
              )}
            </view>
          )}

          {vm.statusMessage && (
            <label
              value={vm.statusMessage}
              font={m.fonts.detail}
              color={c.muted}
              marginLeft={2}
              marginRight={2}
              numberOfLines={0}
            />
          )}

          {vm.windows.forEach((win) => {
            <view key={win.id} gap={3} paddingLeft={2} paddingRight={2}>
              <ProgressBar
                id={`oc-usage-win-${win.id}`}
                label={win.label}
                progress={win.progress}
                detail={win.percentText}
                tone={win.warning ? "warning" : "accent"}
                touch={vm.touch}
                dark={dark}
              />
              <view flexDirection="row" justifyContent="space-between" gap={6}>
                <label value={win.resetText} font={systemFont(10.5)} color={c.muted} numberOfLines={1} />
                {win.costText && (
                  <label value={win.costText} font={systemFont(10.5)} color={c.muted} numberOfLines={1} />
                )}
              </view>
            </view>;
          })}

          <view
            borderRadius={m.radii.control}
            backgroundColor={c.trackSubtle}
            borderWidth={0.5}
            borderColor={c.border}
            padding={8}
            gap={5}
          >
            <view flexDirection="row" alignItems="center" justifyContent="space-between" gap={6}>
              <label value={vm.conversationHeading} font={systemSemiboldFont(11.5)} color={c.ink} />
              {vm.conversationProvider && (
                <label value={vm.conversationProvider} font={systemFont(10.5)} color={c.muted} />
              )}
            </view>
            {vm.contextProgress !== undefined && vm.contextLabel ? (
              <ProgressBar
                id="oc-usage-context"
                label={vm.contextLabel}
                progress={vm.contextProgress}
                detail={vm.contextDetail}
                touch={vm.touch}
                dark={dark}
              />
            ) : vm.conversationFallback ? (
              <label value={vm.conversationFallback} font={systemFont(11)} color={c.muted} numberOfLines={0} />
            ) : null}

            {vm.metrics.length > 0 && (
              <view gap={3} marginTop={2}>
                {vm.metrics.forEach((metric) => {
                  <view key={metric.label} flexDirection="row" justifyContent="space-between" gap={8}>
                    <label value={metric.label} font={systemFont(11)} color={c.muted} />
                    <label value={metric.value} font={systemSemiboldFont(11)} color={c.ink} />
                  </view>;
                })}
              </view>
            )}
            {vm.observedAtText && (
              <label value={vm.observedAtText} font={systemFont(10)} color={c.muted} marginTop={2} />
            )}
          </view>
        </glass>
      )}

      {/* Quiet OpenCraft Sidebar Entrance Row */}
      <view
        class="oc-settings-row"
        accessibilityId="oc-token-usage-disclosure"
        accessibilityLabel={`${vm.title} ${vm.summary}`}
        accessibilityCategory="button"
        accessibilityStateSelected={vm.open}
        onTap={() => {
          triggerHaptic("selection");
          vm.onToggleOpen();
        }}
        width="100%"
        minHeight={m.touch ? 38 : 32}
        paddingLeft={8}
        paddingRight={8}
        borderRadius={m.radii.control}
        backgroundColor={vm.open ? c.navCurrent : undefined}
        flexDirection="row"
        alignItems="center"
        gap={7}
      >
        <Icon name="gauge" size={14} color={vm.open ? c.ink : c.muted} />
        <label
          value={vm.title}
          font={systemFont(m.touch ? 13.5 : 13)}
          color={vm.open ? c.ink : c.muted}
          flexGrow={1}
          flexShrink={1}
          numberOfLines={1}
        />
        <label value={vm.summary} font={systemFont(12)} color={c.muted} />
        <Icon name={vm.open ? "chevronDown" : "chevronUp"} size={12} color={c.muted} />
      </view>
    </view>;
  }
}
