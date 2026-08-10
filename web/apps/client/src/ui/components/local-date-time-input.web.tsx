import type {CSSProperties} from "react";
import {useMemo, useRef, useState} from "react";
import {
  Calendar,
  CalendarCell,
  CalendarGrid,
} from "react-aria-components/Calendar";
import {
  Button as AriaButton,
} from "react-aria-components/Button";
import {
  Dialog,
  DialogTrigger,
} from "react-aria-components/Dialog";
import {Heading} from "react-aria-components/Heading";
import {I18nProvider} from "react-aria-components/I18nProvider";
import {
  Popover,
} from "react-aria-components/Popover";
import {
  CalendarDate,
  CalendarDateTime,
} from "@internationalized/date";
import CalendarDays from "lucide-react-native/icons/calendar-days";
import ChevronLeft from "lucide-react-native/icons/chevron-left";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import Clock3 from "lucide-react-native/icons/clock-3";
import {
  StyleSheet as NativeStyleSheet,
  useWindowDimensions,
} from "react-native";
import {useUnistyles} from "react-native-unistyles";

import type {LocalDateTimeInputProps} from "./local-date-time-input.types";
import {
  clampCalendarDateTime,
  formatDateTimeDisplay,
  formatInstantAsLocalDateTime,
  normalizedMinuteStep,
  parseLocalDateTimeValue,
  replaceDate,
  serializeLocalDateTimeValue,
} from "./local-date-time-model";

import {deviceTimezone} from "../date-time";
import {breakpoints, type VelaTheme} from "../tokens";

export type {
  LocalDateTimeInputConfig,
  LocalDateTimeInputProps,
  LocalDateTimePreset,
} from "./local-date-time-input.types";

export function LocalDateTimeInput({
  accessibilityLabel,
  disabled = false,
  maxValue,
  minValue,
  minuteStep,
  onChangeText,
  placeholder,
  presets = [],
  style,
  timezone = deviceTimezone(),
  value,
}: LocalDateTimeInputProps) {
  const {theme} = useUnistyles();
  const window = useWindowDimensions();
  const styles = dateTimeStyles(theme);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const calendarRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CalendarDateTime | null>(null);
  const parsedValue = useMemo(() => parseLocalDateTimeValue(value), [value]);
  const parsedMin = useMemo(() => parseLocalDateTimeValue(minValue), [minValue]);
  const parsedMax = useMemo(() => parseLocalDateTimeValue(maxValue), [maxValue]);
  const step = normalizedMinuteStep(minuteStep);
  const phone = window.width < breakpoints.medium;
  const color = theme.semantic.color;
  const motion = theme.semantic.motion.transition.control;
  const selectedPresetId = draft
    ? presets.find(item => item.value === serializeLocalDateTimeValue(draft))?.id
    : undefined;
  const triggerStyle = NativeStyleSheet.flatten(style) as CSSProperties | undefined;
  const restingBorderColor = typeof triggerStyle?.borderColor === "string"
    ? triggerStyle.borderColor
    : color.borderControl;

  const safeDraft = () => {
    const fallback = parseLocalDateTimeValue(
      formatInstantAsLocalDateTime(new Date(), timezone, step, "ceil"),
    )!;
    return clampCalendarDateTime(parsedValue ?? parsedMin ?? fallback, parsedMin, parsedMax);
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setDraft(safeDraft());
    else setDraft(null);
    setOpen(nextOpen);
  };
  const dismiss = () => handleOpenChange(false);
  const apply = () => {
    if (!draft) return;
    onChangeText(serializeLocalDateTimeValue(draft));
    handleOpenChange(false);
  };
  const focusCalendar = () => {
    const selected = calendarRef.current?.querySelector<HTMLElement>(
      "[role='gridcell'][aria-selected='true']",
    );
    selected?.focus();
  };

  return (
    <I18nProvider locale="zh-CN">
      <DialogTrigger isOpen={open} onOpenChange={handleOpenChange}>
        <AriaButton
          aria-label={accessibilityLabel}
          isDisabled={disabled}
          ref={triggerRef}
          style={({isFocusVisible, isHovered, isPressed}) => ({
            ...triggerStyle,
            alignItems: "center",
            appearance: "none",
            background: color.fieldSurface,
            borderColor: isFocusVisible
              ? color.borderFocus
              : isHovered
                ? color.borderFieldHover
                : restingBorderColor,
            borderRadius: theme.semantic.radius.control,
            borderStyle: "solid",
            borderWidth: theme.semantic.stroke.hairline,
            boxShadow: isFocusVisible
              ? `0 0 0 3px ${color.fieldFocusGlow}`
              : "none",
            color: parsedValue ? color.textPrimary : color.fieldPlaceholder,
            cursor: disabled ? "not-allowed" : "pointer",
            display: "flex",
            justifyContent: "space-between",
            opacity: disabled ? theme.semantic.interaction.disabledOpacity : 1,
            outline: "none",
            textAlign: "left",
            transform: isPressed ? "scale(0.995)" : "none",
            width: "100%",
            ...motion,
          })}
          type="button"
        >
          <span>{parsedValue ? formatDateTimeDisplay(parsedValue) : value || placeholder}</span>
          <span style={styles.triggerMeta}>
            <span style={{...theme.semantic.typography.caption, color: color.textMuted}}>{timezone}</span>
            <CalendarDays
              color={color.iconMuted}
              size={theme.semantic.icon.size.small}
              strokeWidth={theme.semantic.icon.stroke.regular}
            />
          </span>
        </AriaButton>
        <Popover
          offset={8}
          placement={phone ? "top" : "bottom start"}
          shouldFlip
          style={({isEntering, isExiting}) => ({
            background: color.overlaySurface,
            borderColor: color.borderOverlay,
            borderRadius: theme.semantic.radius.overlay,
            borderStyle: "solid",
            borderWidth: theme.semantic.stroke.hairline,
            bottom: phone ? theme.spacing.lg : undefined,
            boxShadow: cssBoxShadow(theme.shadows.overlay),
            boxSizing: "border-box",
            left: phone ? theme.spacing.lg : undefined,
            opacity: isEntering || isExiting ? 0 : 1,
            outline: "none",
            padding: theme.spacing.xl,
            position: phone ? "fixed" : undefined,
            right: phone ? theme.spacing.lg : undefined,
            top: phone ? "auto" : undefined,
            transform: isEntering || isExiting ? "translateY(4px)" : "translateY(0)",
            ...theme.semantic.motion.transition.surface,
            width: phone ? "auto" : 360,
            zIndex: theme.semantic.layer.popover,
          })}
        >
          <Dialog aria-label={`${accessibilityLabel}选择器`} style={styles.dialog}>
            {draft ? (
              <>
                {presets.length ? (
                  <div style={styles.presetGrid}>
                    {presets.map(preset => (
                      <PickerButton
                        key={preset.id}
                        label={preset.label}
                        onPress={() => {
                          const next = parseLocalDateTimeValue(preset.value);
                          if (next) setDraft(clampCalendarDateTime(next, parsedMin, parsedMax));
                        }}
                        selected={selectedPresetId === preset.id}
                      />
                    ))}
                    <PickerButton
                      label="自定义"
                      onPress={focusCalendar}
                      selected={!selectedPresetId}
                    />
                  </div>
                ) : null}
                <Calendar
                  aria-label={`${accessibilityLabel}日期`}
                  maxValue={parsedMax ? calendarDate(parsedMax) : undefined}
                  minValue={parsedMin ? calendarDate(parsedMin) : undefined}
                  onChange={date => setDraft(current => current
                    ? clampCalendarDateTime(replaceDate(current, date), parsedMin, parsedMax)
                    : current)}
                  ref={calendarRef}
                  style={styles.calendar}
                  value={calendarDate(draft)}
                >
                  <div style={styles.monthHeader}>
                    <AriaButton
                      aria-label="上个月"
                      slot="previous"
                      style={iconButtonStyle(theme)}
                    >
                      <ChevronLeft
                        color={color.iconSecondary}
                        size={theme.semantic.icon.size.small}
                        strokeWidth={theme.semantic.icon.stroke.regular}
                      />
                    </AriaButton>
                    <Heading style={{...theme.semantic.typography.bodyCompactEmphasis, color: color.textPrimary, margin: 0}} />
                    <AriaButton
                      aria-label="下个月"
                      slot="next"
                      style={iconButtonStyle(theme)}
                    >
                      <ChevronRight
                        color={color.iconSecondary}
                        size={theme.semantic.icon.size.small}
                        strokeWidth={theme.semantic.icon.stroke.regular}
                      />
                    </AriaButton>
                  </div>
                  <CalendarGrid style={{borderCollapse: "separate", borderSpacing: theme.spacing.xxs, width: "100%"}} weekdayStyle="short">
                    {date => (
                      <CalendarCell
                        date={date}
                        style={({isDisabled, isFocusVisible, isOutsideMonth, isSelected, isToday}) => ({
                          background: isSelected
                            ? color.actionPrimarySurface
                            : isToday
                              ? color.actionTonalSurface
                              : color.surfaceTransparent,
                          borderColor: isFocusVisible ? color.borderFocus : color.borderTransparent,
                          borderRadius: theme.semantic.radius.compactControl,
                          borderStyle: "solid",
                          borderWidth: theme.semantic.stroke.hairline,
                          color: isSelected
                            ? color.actionPrimaryText
                            : isOutsideMonth || isDisabled
                              ? color.fieldPlaceholder
                              : color.textPrimary,
                          cursor: isDisabled ? "not-allowed" : "pointer",
                          ...(isSelected || isToday
                            ? theme.semantic.typography.bodySmallEmphasis
                            : theme.semantic.typography.bodySmall),
                          height: theme.recipes.control.height,
                          opacity: isDisabled ? 0.45 : 1,
                          outline: "none",
                          padding: 0,
                          textAlign: "center",
                          width: theme.recipes.control.height,
                        })}
                      />
                    )}
                  </CalendarGrid>
                </Calendar>
                <TimeControls
                  maxValue={parsedMax}
                  minValue={parsedMin}
                  minuteStep={step}
                  onChange={setDraft}
                  value={draft}
                />
                <div style={{...styles.footer, borderTopColor: color.separator}}>
                  <AriaButton onPress={dismiss} style={quietButtonStyle(theme)}>
                    取消
                  </AriaButton>
                  <AriaButton onPress={apply} style={primaryButtonStyle(theme)}>
                    确认
                  </AriaButton>
                </div>
              </>
            ) : null}
          </Dialog>
        </Popover>
      </DialogTrigger>
    </I18nProvider>
  );
}

function PickerButton({
  label,
  onPress,
  selected,
}: {
  label: string;
  onPress(): void;
  selected: boolean;
}) {
  const {theme} = useUnistyles();
  const color = theme.semantic.color;
  const styles = dateTimeStyles(theme);
  return (
    <AriaButton
      aria-pressed={selected}
      onPress={onPress}
      style={({isFocusVisible, isHovered, isPressed}) => ({
        ...styles.presetButton,
        ...theme.semantic.motion.transition.control,
        background: selected
          ? color.actionTonalSurface
          : isPressed
            ? color.interactivePressedSurface
            : isHovered
              ? color.interactiveHoverSurface
              : color.actionQuietSurface,
        ...theme.semantic.typography.bodySmallEmphasis,
        borderColor: isFocusVisible || selected
          ? color.borderFocus
          : color.borderTransparent,
        color: selected ? color.actionTonalText : color.textMuted,
        outline: "none",
      })}
    >
      {label}
    </AriaButton>
  );
}

function TimeControls({
  maxValue,
  minValue,
  minuteStep,
  onChange,
  value,
}: {
  maxValue: CalendarDateTime | null;
  minValue: CalendarDateTime | null;
  minuteStep: number;
  onChange(value: CalendarDateTime): void;
  value: CalendarDateTime;
}) {
  const {theme} = useUnistyles();
  const color = theme.semantic.color;
  const styles = dateTimeStyles(theme);
  const minutes = Array.from({length: Math.ceil(60 / minuteStep)}, (_, index) => index * minuteStep)
    .filter(minute => minute < 60);
  const candidate = (hour: number, minute: number) => new CalendarDateTime(
    value.year,
    value.month,
    value.day,
    hour,
    minute,
  );
  const allowed = (hour: number, minute: number) => {
    const next = candidate(hour, minute);
    return (!minValue || next.compare(minValue) >= 0) &&
      (!maxValue || next.compare(maxValue) <= 0);
  };
  const hourAllowed = (hour: number) => minutes.some(minute => allowed(hour, minute));
  const selectStyle: CSSProperties = {
    appearance: "none",
    background: color.fieldSurface,
    borderColor: color.borderControl,
    borderRadius: theme.semantic.radius.control,
    borderStyle: "solid",
    borderWidth: theme.semantic.stroke.hairline,
    color: color.textPrimary,
    cursor: "pointer",
    ...theme.semantic.typography.bodySmall,
    height: theme.recipes.control.height,
    minWidth: 70,
    outline: "none",
    padding: `0 ${theme.spacing.xxl}px 0 ${theme.spacing.md}px`,
  };
  return (
    <div style={{...styles.timeRow, borderTopColor: color.separator}}>
      <span style={styles.timeLabel}>
        <Clock3
          color={color.iconMuted}
          size={theme.semantic.icon.size.small}
          strokeWidth={theme.semantic.icon.stroke.regular}
        />
        时间
      </span>
      <div style={styles.timeFields}>
        <select
          aria-label="小时"
          onChange={event => {
            const hour = Number(event.target.value);
            const minute = allowed(hour, value.minute)
              ? value.minute
              : minutes.find(item => allowed(hour, item)) ?? value.minute;
            onChange(clampCalendarDateTime(candidate(hour, minute), minValue, maxValue));
          }}
          style={selectStyle}
          value={value.hour}
        >
          {Array.from({length: 24}, (_, hour) => (
            <option disabled={!hourAllowed(hour)} key={hour} value={hour}>
              {String(hour).padStart(2, "0")} 时
            </option>
          ))}
        </select>
        <span style={{color: color.textMuted}}>:</span>
        <select
          aria-label="分钟"
          onChange={event => onChange(clampCalendarDateTime(
            candidate(value.hour, Number(event.target.value)),
            minValue,
            maxValue,
          ))}
          style={selectStyle}
          value={value.minute}
        >
          {minutes.map(minute => (
            <option disabled={!allowed(value.hour, minute)} key={minute} value={minute}>
              {String(minute).padStart(2, "0")} 分
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function calendarDate(value: CalendarDateTime): CalendarDate {
  return new CalendarDate(value.year, value.month, value.day);
}

function iconButtonStyle(theme: VelaTheme) {
  const color = theme.semantic.color;
  return ({isFocusVisible, isHovered, isPressed}: {
    isFocusVisible: boolean;
    isHovered: boolean;
    isPressed: boolean;
  }): CSSProperties => ({
    ...dateTimeStyles(theme).iconButton,
    ...theme.semantic.motion.transition.control,
    background: isPressed
      ? color.interactivePressedSurface
      : isHovered
        ? color.interactiveHoverSurface
        : color.actionQuietSurface,
    borderColor: isFocusVisible ? color.borderFocus : color.borderTransparent,
    outline: "none",
  });
}

function quietButtonStyle(theme: VelaTheme) {
  const color = theme.semantic.color;
  return ({isFocusVisible, isHovered, isPressed}: {
    isFocusVisible: boolean;
    isHovered: boolean;
    isPressed: boolean;
  }): CSSProperties => ({
    ...dateTimeStyles(theme).footerButton,
    ...theme.semantic.motion.transition.control,
    background: isPressed
      ? color.interactivePressedSurface
      : isHovered
        ? color.interactiveHoverSurface
        : color.actionQuietSurface,
    borderColor: isFocusVisible ? color.borderFocus : color.borderTransparent,
    color: color.textPrimary,
    outline: "none",
  });
}

function primaryButtonStyle(theme: VelaTheme) {
  const color = theme.semantic.color;
  return ({isFocusVisible, isHovered, isPressed}: {
    isFocusVisible: boolean;
    isHovered: boolean;
    isPressed: boolean;
  }): CSSProperties => ({
    ...dateTimeStyles(theme).footerButton,
    ...theme.semantic.motion.transition.control,
    background: color.actionPrimarySurface,
    borderColor: isFocusVisible ? color.borderFocus : color.borderTransparent,
    color: color.actionPrimaryText,
    filter: isHovered ? "brightness(0.97)" : "none",
    opacity: isPressed ? theme.semantic.opacity.contentEmphasized : 1,
    outline: "none",
  });
}

function dateTimeStyles(theme: VelaTheme) {
  return {
    calendar: {
    outline: "none",
    } satisfies CSSProperties,
    dialog: {
      outline: "none",
    } satisfies CSSProperties,
    footer: {
      alignItems: "center",
      borderTopStyle: "solid",
      borderTopWidth: theme.semantic.stroke.hairline,
      display: "flex",
      gap: theme.spacing.sm,
      justifyContent: "flex-end",
      marginTop: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
    } satisfies CSSProperties,
    footerButton: {
      ...theme.semantic.typography.bodySmallEmphasis,
      borderStyle: "solid",
      borderWidth: theme.semantic.stroke.hairline,
      borderRadius: theme.semantic.radius.control,
      cursor: "pointer",
      minHeight: theme.recipes.control.height,
      padding: `${theme.spacing.xs}px ${theme.spacing.lg}px`,
    } satisfies CSSProperties,
    iconButton: {
      alignItems: "center",
      borderRadius: theme.semantic.radius.control,
      borderStyle: "solid",
      borderWidth: theme.semantic.stroke.hairline,
      cursor: "pointer",
      display: "flex",
      height: theme.recipes.iconControl.smallSize,
      justifyContent: "center",
      padding: 0,
      width: theme.recipes.iconControl.smallSize,
    } satisfies CSSProperties,
    monthHeader: {
      alignItems: "center",
      display: "flex",
      justifyContent: "space-between",
      marginBottom: theme.spacing.sm,
    } satisfies CSSProperties,
    presetButton: {
      borderRadius: theme.semantic.radius.control,
      borderStyle: "solid",
      borderWidth: theme.semantic.stroke.hairline,
      cursor: "pointer",
      minHeight: theme.recipes.control.height,
      padding: `${theme.spacing.xs}px ${theme.spacing.xs}px`,
    } satisfies CSSProperties,
    presetGrid: {
      display: "grid",
      gap: theme.spacing.xs,
      gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
      marginBottom: theme.spacing.lg,
    } satisfies CSSProperties,
    timeFields: {
      alignItems: "center",
      display: "flex",
      gap: theme.spacing.xs,
    } satisfies CSSProperties,
    timeLabel: {
      ...theme.semantic.typography.bodySmallEmphasis,
      alignItems: "center",
      display: "flex",
      gap: theme.spacing.xs,
    } satisfies CSSProperties,
    timeRow: {
      alignItems: "center",
      borderTopStyle: "solid",
      borderTopWidth: theme.semantic.stroke.hairline,
      display: "flex",
      justifyContent: "space-between",
      marginTop: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
    } satisfies CSSProperties,
    triggerMeta: {
      alignItems: "center",
      display: "flex",
      gap: theme.spacing.sm,
      marginLeft: theme.spacing.lg,
    } satisfies CSSProperties,
  };
}

function cssBoxShadow(shadow: VelaTheme["shadows"]["overlay"]): string {
  return `0 ${shadow.offsetY}px ${shadow.radius}px ${shadow.color}`;
}
