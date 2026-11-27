import { StatefulComponent } from "valdi_core/src/Component";
import { systemSemiboldFont } from "valdi_core/src/SystemFont";
import { triggerHaptic } from "./haptics";
import { themeColors, themeMetrics } from "./tokens";

export type ActionSheetAction = {
  id: string;
  title: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress(): void;
};

type Props = {
  id: string;
  title?: string;
  message?: string;
  actions: readonly ActionSheetAction[];
  cancelTitle: string;
  bottomInset?: number;
  touch?: boolean;
  dark?: boolean;
  onCancel(): void;
};

type State = { entered: boolean };

/** Adaptive OpenCraft modal action sheet (macOS + iPadOS/mobile). */
export class ActionSheet extends StatefulComponent<Props, State> {
  state: State = { entered: false };

  onCreate(): void {
    setTimeout(() => {
      if (this.isDestroyed()) return;
      this.animate({ stiffness: 360, damping: 32 }, () => {
        this.setState({ entered: true });
      });
    }, 16);
  }

  onRender(): void {
    const { id, title, message, actions, cancelTitle, bottomInset = 20, touch, dark, onCancel } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);
    const entered = this.state.entered;
    const glassBorder = c.glassBorder;
    const sheetBg = c.alert;
    const sheetTint = c.glassTint;
    const glassClass = dark ? "oc-liquid-glass oc-dark" : "oc-liquid-glass";
    const isTouch = m.touch;
    const rowHeight = isTouch ? 48 : 40;

    <view
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      zIndex={10}
      justifyContent={isTouch ? "flex-end" : "center"}
      alignItems="center"
      padding={16}
      paddingBottom={isTouch ? bottomInset : 16}
    >
      <view
        position="absolute"
        top={0}
        left={0}
        right={0}
        bottom={0}
        backgroundColor={c.overlay}
        opacity={entered ? 1 : 0}
        onTap={onCancel}
        accessibilityNavigation="ignored"
      />
      <view
        accessibilityId={id}
        accessibilityLabel={title ?? cancelTitle}
        width="100%"
        maxWidth={380}
        gap={8}
        translationY={entered ? 0 : isTouch ? 96 : 10}
        scaleX={entered ? 1 : isTouch ? 1 : 0.97}
        scaleY={entered ? 1 : isTouch ? 1 : 0.97}
        opacity={entered ? 1 : 0}
      >
        <glass
          class={glassClass}
          borderRadius={m.radii.modal}
          glassStyle="regular"
          backgroundColor={sheetBg}
          glassTintColor={sheetTint}
          borderWidth={0.5}
          borderColor={glassBorder}
          boxShadow={dark ? "complex 0 14 34 rgba(0, 0, 0, 0.36)" : "complex 0 12 30 rgba(24, 24, 28, 0.14)"}
          slowClipping={true}
        >
          {(title || message) && (
            <view paddingLeft={16} paddingRight={16} paddingTop={12} paddingBottom={12} alignItems="center" gap={3}>
              {title && (
                <label
                  value={title}
                  font={m.fonts.control}
                  color={c.ink}
                  textAlign="center"
                  accessibilityCategory="header"
                />
              )}
              {message && (
                <label value={message} font={m.fonts.detail} color={c.muted} textAlign="center" numberOfLines={0} />
              )}
            </view>
          )}
          {actions.forEach((action, index) => {
            const showDivider = Boolean(title || message) || index > 0;
            const color = action.disabled ? c.disabled : action.destructive ? c.danger : c.ink;
            <view key={action.id}>
              {showDivider && <view height={0.5} backgroundColor={c.border} />}
              <view paddingLeft={5} paddingRight={5} paddingTop={3} paddingBottom={3}>
                <view
                  class="oc-settings-row"
                  accessibilityId={`${id}-${action.id}`}
                  accessibilityLabel={action.title}
                  accessibilityCategory="button"
                  accessibilityStateDisabled={action.disabled}
                  onTap={
                    action.disabled
                      ? undefined
                      : () => {
                          triggerHaptic("light");
                          action.onPress();
                        }
                  }
                  minHeight={rowHeight - 6}
                  paddingLeft={12}
                  paddingRight={12}
                  borderRadius={m.radii.control + 2}
                  justifyContent="center"
                  alignItems="center"
                >
                  <label
                    value={action.title}
                    font={action.destructive ? systemSemiboldFont(m.touch ? 15 : 14) : m.fonts.body}
                    color={color}
                    textAlign="center"
                  />
                </view>
              </view>
            </view>;
          })}
        </glass>
        <glass
          class={`${glassClass} oc-pill-button`}
          accessibilityId={`${id}-cancel`}
          accessibilityLabel={cancelTitle}
          accessibilityCategory="button"
          onTap={() => {
            triggerHaptic("selection");
            onCancel();
          }}
          minHeight={rowHeight}
          borderRadius={m.radii.modal - 2}
          glassStyle="regular"
          backgroundColor={sheetBg}
          glassTintColor={sheetTint}
          borderWidth={0.5}
          borderColor={glassBorder}
          boxShadow={dark ? "complex 0 8 22 rgba(0, 0, 0, 0.30)" : "complex 0 6 18 rgba(24, 24, 28, 0.10)"}
          justifyContent="center"
          alignItems="center"
        >
          <label value={cancelTitle} font={m.fonts.control} color={c.ink} />
        </glass>
      </view>
    </view>;
  }
}
