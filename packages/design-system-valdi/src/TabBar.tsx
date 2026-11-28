import { StatefulComponent } from "valdi_core/src/Component";
import { systemFont, systemSemiboldFont } from "valdi_core/src/SystemFont";
import { Icon, IconName } from "./Icon";
import { themeColors, themeMetrics } from "./tokens";

export type TabBarItem = {
  id: string;
  title: string;
  icon: IconName;
  badge?: string;
};

type Props = {
  id: string;
  label: string;
  items: readonly TabBarItem[];
  value: string;
  touch?: boolean;
  dark?: boolean;
  onChange(id: string): void;
};

type State = { displayedIndex: number };

/** Adaptive OpenCraft segmented tab bar (macOS rounded-rect + iPadOS touch density). */
export class TabBar extends StatefulComponent<Props, State> {
  state: State = { displayedIndex: 0 };

  private resolveIndex(): number {
    return Math.max(
      0,
      this.viewModel.items.findIndex((item) => item.id === this.viewModel.value),
    );
  }

  onCreate(): void {
    this.setState({ displayedIndex: this.resolveIndex() });
  }

  onViewModelUpdate(previousViewModel?: Readonly<Props>): void {
    const nextIndex = this.resolveIndex();
    if (
      !previousViewModel ||
      (previousViewModel.value !== this.viewModel.value && nextIndex !== this.state.displayedIndex)
    ) {
      this.setState({ displayedIndex: nextIndex });
    }
  }

  private selectTab(index: number, id: string): void {
    if (index !== this.state.displayedIndex) {
      this.animate({ stiffness: 360, damping: 32, beginFromCurrentState: true }, () => {
        this.setState({ displayedIndex: index });
      });
    }
    this.viewModel.onChange(id);
  }

  onRender(): void {
    const { id, label, items, value, touch, dark } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);
    const tabWidth = items.length ? 100 / items.length : 0;
    const barHeight = m.touch ? 54 : 44;
    const outerRadius = m.touch ? 14 : 11;
    const innerRadius = m.touch ? 11 : 8;

    <glass
      class={dark ? "oc-liquid-glass oc-dark" : "oc-liquid-glass"}
      accessibilityId={id}
      accessibilityLabel={label}
      width="100%"
      height={barHeight}
      padding={3}
      borderRadius={outerRadius}
      glassStyle="regular"
      glassTintColor={c.glassTint}
      borderWidth={0.5}
      borderColor={c.glassBorder}
      boxShadow={dark ? "complex 0 6 18 rgba(0, 0, 0, 0.24)" : "complex 0 4 14 rgba(24, 24, 28, 0.06)"}
    >
      <view width="100%" height="100%" flexDirection="row" alignItems="center">
        {items.length > 0 && (
          <view
            class="oc-tab-indicator"
            position="absolute"
            top={0}
            bottom={0}
            left={`${this.state.displayedIndex * tabWidth}%`}
            width={`${tabWidth}%`}
            borderRadius={innerRadius}
            backgroundColor={c.segmentThumb}
            borderWidth={0.5}
            borderColor={c.border}
            boxShadow={dark ? "complex 0 1 2 rgba(0, 0, 0, 0.24)" : "complex 0 1 2 rgba(0, 0, 0, 0.06)"}
            accessibilityNavigation="ignored"
          />
        )}
        {items.forEach((item, index) => {
          const selected = item.id === value;
          const tint = selected ? c.ink : c.muted;
          <view
            key={item.id}
            class="oc-pill-button"
            accessibilityId={`${id}-${item.id}`}
            accessibilityLabel={item.title}
            accessibilityCategory="button"
            accessibilityStateSelected={selected}
            onTap={() => this.selectTab(index, item.id)}
            flexGrow={1}
            flexBasis={0}
            minWidth={0}
            height={barHeight - 6}
            borderRadius={innerRadius}
            justifyContent="center"
            alignItems="center"
            gap={2}
          >
            <view width={22} height={20} justifyContent="center" alignItems="center">
              <Icon name={item.icon} size={m.touch ? 19 : 17} color={tint} />
              {item.badge && (
                <view
                  position="absolute"
                  top={-2}
                  right={-7}
                  paddingLeft={3.5}
                  paddingRight={3.5}
                  minWidth={14}
                  height={14}
                  borderRadius={7}
                  backgroundColor={c.accent}
                  justifyContent="center"
                  alignItems="center"
                >
                  <label value={item.badge} font={systemSemiboldFont(9)} color={c.accentForeground} />
                </view>
              )}
            </view>
            <label
              value={item.title}
              font={selected ? systemSemiboldFont(10.5) : systemFont(10.5)}
              color={tint}
              numberOfLines={1}
            />
          </view>;
        })}
      </view>
    </glass>;
  }
}
