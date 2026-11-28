import { AnimationCurve } from "valdi_core/src/AnimationOptions";
import { StatefulComponent } from "valdi_core/src/Component";
import { Button } from "./Button";
import { triggerHaptic } from "./haptics";
import { themeColors, themeMetrics } from "./tokens";

type Props = {
  id: string;
  title: string;
  message?: string;
  cancelTitle: string;
  confirmTitle: string;
  destructive?: boolean;
  touch?: boolean;
  disabled?: boolean;
  dark?: boolean;
  onCancel(): void;
  onConfirm(): void;
};

type State = { entered: boolean };

/** OpenCraft utility confirmation modal matching `.modal-confirmation` (macOS + iPadOS adaptive). */
export class ConfirmDialog extends StatefulComponent<Props, State> {
  state: State = { entered: false };

  onCreate(): void {
    setTimeout(() => {
      if (this.isDestroyed()) return;
      this.animate({ duration: 0.18, curve: AnimationCurve.EaseOut }, () => {
        this.setState({ entered: true });
      });
    }, 16);
  }

  onRender(): void {
    const { id, title, message, cancelTitle, confirmTitle, destructive, touch, disabled, dark, onCancel, onConfirm } =
      this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);
    const entered = this.state.entered;

    <view
      position="absolute"
      left={0}
      top={0}
      right={0}
      bottom={0}
      zIndex={10}
      justifyContent="center"
      alignItems="center"
      padding={20}
    >
      <view
        position="absolute"
        left={0}
        top={0}
        right={0}
        bottom={0}
        backgroundColor={c.overlay}
        opacity={entered ? 1 : 0}
        onTap={disabled ? undefined : onCancel}
        accessibilityNavigation="ignored"
      />
      <glass
        class={dark ? "oc-liquid-glass oc-dark" : "oc-liquid-glass"}
        accessibilityId={id}
        accessibilityLabel={title}
        width="100%"
        maxWidth={380}
        padding={20}
        borderRadius={m.radii.modal}
        glassStyle="regular"
        backgroundColor={c.alert}
        glassTintColor={c.glassTint}
        borderWidth={0.5}
        borderColor={c.glassBorder}
        gap={16}
        opacity={entered ? 1 : 0}
        scaleX={entered ? 1 : 0.97}
        scaleY={entered ? 1 : 0.97}
        boxShadow={dark ? "complex 0 14 36 rgba(0, 0, 0, 0.38)" : "complex 0 12 32 rgba(24, 24, 28, 0.14)"}
      >
        <view gap={6}>
          <label
            value={title}
            color={c.ink}
            font={m.fonts.sectionTitle}
            accessibilityCategory="header"
            numberOfLines={0}
          />
          {message && (
            <label
              accessibilityId={`${id}-message`}
              value={message}
              color={c.muted}
              font={m.fonts.body}
              numberOfLines={0}
            />
          )}
        </view>
        <view flexDirection="row" justifyContent="flex-end" gap={8}>
          <Button
            id={`${id}-cancel`}
            title={cancelTitle}
            variant="quiet"
            touch={touch}
            disabled={disabled}
            dark={dark}
            onPress={() => {
              triggerHaptic("selection");
              onCancel();
            }}
          />
          <Button
            id={`${id}-confirm`}
            title={confirmTitle}
            variant={destructive ? "danger" : "primary"}
            touch={touch}
            disabled={disabled}
            dark={dark}
            onPress={() => {
              triggerHaptic("medium");
              onConfirm();
            }}
          />
        </view>
      </glass>
    </view>;
  }
}
