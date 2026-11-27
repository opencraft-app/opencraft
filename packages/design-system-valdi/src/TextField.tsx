import { Component } from "valdi_core/src/Component";
import type { TextFieldAutocapitalization, TextFieldContentType } from "valdi_tsx/src/NativeTemplateElements";
import { Icon, type IconName } from "./Icon";
import { themeColors, themeMetrics } from "./tokens";

type Props = {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  clearTitle?: string;
  leadingIcon?: IconName;
  hideLabel?: boolean;
  inline?: boolean;
  touch?: boolean;
  disabled?: boolean;
  dark?: boolean;
  contentType?: TextFieldContentType;
  autocapitalization?: TextFieldAutocapitalization;
  rightActionTitle?: string;
  rightActionDisabled?: boolean;
  onRightAction?(): void;
  onChange(value: string): void;
  onSubmit?(): void;
};

/** Adaptive OpenCraft text field matching `.settings-control-input` (34px 8px-radius desktop, 40px 10px-radius touch). */
export class TextField extends Component<Props> {
  onRender(): void {
    const {
      id,
      label,
      value,
      placeholder,
      hint,
      error,
      clearTitle,
      leadingIcon,
      hideLabel,
      inline,
      touch,
      disabled,
      dark,
      contentType = "noSuggestions",
      autocapitalization = "sentences",
      rightActionTitle,
      rightActionDisabled,
      onRightAction,
      onChange,
      onSubmit,
    } = this.viewModel;
    const c = themeColors(dark);
    const m = themeMetrics(touch);
    const inputHeight = m.sizes.inputHeight;
    const radius = m.radii.control;

    if (inline) {
      <view paddingLeft={16} paddingRight={16} paddingTop={11} paddingBottom={11} gap={6} minWidth={0} flexShrink={1}>
        {!hideLabel && <label value={label} color={c.ink} font={m.fonts.rowTitle} numberOfLines={0} />}
        <view
          borderRadius={radius}
          borderWidth={0.5}
          borderColor={error ? c.danger : c.border}
          backgroundColor={disabled ? c.trackSoft : c.recessed}
          paddingLeft={10}
          paddingRight={rightActionTitle ? 8 : 6}
          flexDirection="row"
          alignItems="center"
          gap={6}
          minWidth={0}
          flexShrink={1}
        >
          {leadingIcon && <Icon name={leadingIcon} size={15} color={c.muted} />}
          <textfield
            accessibilityId={id}
            accessibilityLabel={label}
            value={value}
            placeholder={placeholder}
            placeholderColor={c.disabled}
            height={inputHeight}
            flexGrow={1}
            flexShrink={1}
            flexBasis={0}
            minWidth={0}
            color={c.ink}
            font={m.fonts.body}
            enabled={!disabled}
            contentType={contentType}
            autocapitalization={autocapitalization}
            autocorrection="none"
            onChange={(event) => onChange(event.text)}
            onReturn={onSubmit}
          />
          {!disabled && value.length > 0 && clearTitle && (
            <view
              accessibilityId={`${id}-clear`}
              accessibilityLabel={clearTitle}
              accessibilityCategory="button"
              onTap={() => onChange("")}
              width={28}
              height={28}
              alignItems="center"
              justifyContent="center"
            >
              <Icon name="close" size={12} color={c.muted} />
            </view>
          )}
          {rightActionTitle && onRightAction && (
            <view
              accessibilityId={`${id}-action`}
              accessibilityLabel={rightActionTitle}
              accessibilityCategory="button"
              accessibilityStateDisabled={rightActionDisabled}
              onTap={rightActionDisabled ? undefined : onRightAction}
              minHeight={28}
              paddingLeft={6}
              paddingRight={6}
              alignItems="center"
              justifyContent="center"
              opacity={rightActionDisabled ? 0.45 : 1}
            >
              <label value={rightActionTitle} font={m.fonts.detail} color={c.ink} />
            </view>
          )}
        </view>
        {(error || hint) && (
          <label
            accessibilityId={`${id}-${error ? "error" : "hint"}`}
            value={error ?? hint}
            accessibilityStateLiveRegion={!!error}
            color={error ? c.danger : c.muted}
            font={m.fonts.detail}
            numberOfLines={0}
          />
        )}
      </view>;
      return;
    }

    <view gap={5} minWidth={0} flexShrink={1}>
      {!hideLabel && <label value={label} color={c.ink} font={m.fonts.rowTitle} numberOfLines={0} />}
      <view
        borderRadius={radius}
        borderWidth={0.5}
        borderColor={error ? c.danger : c.border}
        backgroundColor={disabled ? c.trackSoft : c.recessed}
        paddingLeft={10}
        paddingRight={rightActionTitle ? 8 : 6}
        flexDirection="row"
        alignItems="center"
        gap={6}
        minWidth={0}
        flexShrink={1}
      >
        {leadingIcon && <Icon name={leadingIcon} size={15} color={c.muted} />}
        <textfield
          accessibilityId={id}
          accessibilityLabel={label}
          value={value}
          placeholder={placeholder}
          placeholderColor={c.disabled}
          height={inputHeight}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minWidth={0}
          color={c.ink}
          font={m.fonts.body}
          enabled={!disabled}
          contentType={contentType}
          autocapitalization={autocapitalization}
          autocorrection="none"
          onChange={(event) => onChange(event.text)}
          onReturn={onSubmit}
        />
        {!disabled && value.length > 0 && clearTitle && (
          <view
            accessibilityId={`${id}-clear`}
            accessibilityLabel={clearTitle}
            accessibilityCategory="button"
            onTap={() => onChange("")}
            width={28}
            height={28}
            alignItems="center"
            justifyContent="center"
          >
            <Icon name="close" size={12} color={c.muted} />
          </view>
        )}
        {rightActionTitle && onRightAction && (
          <view
            accessibilityId={`${id}-action`}
            accessibilityLabel={rightActionTitle}
            accessibilityCategory="button"
            accessibilityStateDisabled={rightActionDisabled}
            onTap={rightActionDisabled ? undefined : onRightAction}
            minHeight={28}
            paddingLeft={6}
            paddingRight={6}
            alignItems="center"
            justifyContent="center"
            opacity={rightActionDisabled ? 0.45 : 1}
          >
            <label value={rightActionTitle} font={m.fonts.detail} color={c.ink} />
          </view>
        )}
      </view>
      {(error || hint) && (
        <label
          accessibilityId={`${id}-${error ? "error" : "hint"}`}
          value={error ?? hint}
          accessibilityStateLiveRegion={!!error}
          color={error ? c.danger : c.muted}
          font={m.fonts.detail}
          numberOfLines={0}
        />
      )}
    </view>;
  }
}
