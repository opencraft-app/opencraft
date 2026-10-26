import { ChevronDownIcon, LoadingRingIcon } from "@opencraft/design-system-web/action-icons";
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { forwardRef, useId } from "react";

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export interface SettingsPageHeaderProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
}


/** Route content heading. Settings routes own the viewport; this owns title rhythm only. */
export function SettingsPageHeader({ title, description }: SettingsPageHeaderProps) {
  return (
    <header className="settings-control-page-header">
      <h2 id="settings-content-title">{title}</h2>
      {description === undefined ? null : <p>{description}</p>}
    </header>
  );
}

export interface SettingsSectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly icon?: ReactNode;
}

/** A semantic Settings section. Plugins provide content, never section geometry. */
export function SettingsSection({
  title,
  description,
  action,
  icon,
  children,
  className,
  id,
  ...props
}: SettingsSectionProps) {
  const generatedId = useId();
  const headingId = id ?? `settings-section-${generatedId.replaceAll(":", "")}`;
  return (
    <section
      {...props}
      className={classes("settings-control-section", className)}
      aria-labelledby={headingId}
    >
      <div className="settings-control-section__heading">
        <div className="settings-control-section__copy">
          <h3 id={headingId}>{icon}{title}</h3>
          {description === undefined ? null : <p>{description}</p>}
        </div>
        {action === undefined ? null : <div className="settings-control-section__action">{action}</div>}
      </div>
      {children}
    </section>
  );
}

export interface SettingsGroupProps extends HTMLAttributes<HTMLDivElement> { readonly appearance?: "card" | "plain" }

/** One inset Settings card. Direct child rows receive the shared separator contract. */
export function SettingsGroup({ children, className, appearance = "card", ...props }: SettingsGroupProps) {
  return <div {...props} data-appearance={appearance} className={classes("settings-control-group", className)}>{children}</div>;
}

export interface SettingsRowProps extends HTMLAttributes<HTMLDivElement> {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly htmlFor?: string;
  readonly layout?: "default" | "stacked";
  readonly controlWidth?: "default" | "compact" | "wide";
}

/**
 * Canonical two-cell Settings row. The row owns density and alignment; callers
 * own values and domain behavior.
 */
export function SettingsRow({
  label,
  description,
  htmlFor,
  layout = "default",
  controlWidth = "default",
  children,
  className,
  ...props
}: SettingsRowProps) {
  const title = htmlFor === undefined
    ? <div className="settings-control-row__label">{label}</div>
    : <label className="settings-control-row__label" htmlFor={htmlFor}>{label}</label>;
  return (
    <div
      {...props}
      className={classes(
        "settings-control-row",
        layout === "stacked" && "settings-control-row--stacked",
        className,
      )}
    >
      <div className="settings-control-row__copy">
        {title}
        {description === undefined ? null : <div className="settings-control-row__description">{description}</div>}
      </div>
      <div className={`settings-control-row__value settings-control-row__value--${controlWidth}`}>
        {children}
      </div>
    </div>
  );
}

export interface SettingsListItemProps extends HTMLAttributes<HTMLDivElement> {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly metadata?: ReactNode;
  readonly icon?: ReactNode;
  readonly actions?: ReactNode;
  readonly error?: ReactNode;
}

/**
 * Canonical information row for hosts, plugins, accounts, and other
 * extension-owned records. The shell owns geometry; callers provide only
 * domain content and actions.
 */
export function SettingsListItem({
  label,
  description,
  metadata,
  icon,
  actions,
  error,
  className,
  ...props
}: SettingsListItemProps) {
  return (
    <div {...props} data-has-icon={icon !== undefined} className={classes("settings-control-list-item", className)}>
      {icon === undefined ? null : (
        <span className="settings-control-list-item__icon" aria-hidden="true">{icon}</span>
      )}
      <div className="settings-control-list-item__copy">
        <strong>{label}</strong>
        {description === undefined ? null : <small>{description}</small>}
        {metadata === undefined ? null : <span>{metadata}</span>}
        {error === undefined ? null : <em>{error}</em>}
      </div>
      {actions === undefined ? null : (
        <div className="settings-control-list-item__actions">{actions}</div>
      )}
    </div>
  );
}

export const SettingsTextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function SettingsTextInput({ className, ...props }, ref) {
    return <input {...props} ref={ref} className={classes("settings-control-input", className)} />;
  },
);

export const SettingsSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function SettingsSelect({ className, ...props }, ref) {
    return (
      <span className="settings-control-select-shell">
        <select {...props} ref={ref} className={classes("settings-control-select", className)} />
        <ChevronDownIcon size={16} />
      </span>
    );
  },
);

export interface SegmentedControlOption {
  readonly value: string;
  readonly label: ReactNode;
  readonly disabled?: boolean;
}

export type SettingsSegmentedOption = SegmentedControlOption;

export interface SegmentedControlProps {
  readonly value: string;
  readonly options: readonly SegmentedControlOption[];
  readonly onValueChange: (value: string) => void;
  readonly label: string;
  readonly disabled?: boolean;
  readonly appearance?: "toolbar" | "inset";
  readonly className?: string;
}

/** Shared mutually-exclusive control. Shell and Settings choose appearance, not behavior. */
export function SegmentedControl({
  value,
  options,
  onValueChange,
  label,
  disabled = false,
  appearance = "toolbar",
  className,
}: SegmentedControlProps) {
  const focusValue = options.find(option => option.value === value && !option.disabled)?.value
    ?? options.find(option => !option.disabled)?.value;
  return (
    <div
      className={classes("segmented-control", className)}
      data-appearance={appearance}
      role="radiogroup"
      aria-label={label}
      onKeyDown={event => {
        if (disabled || event.altKey || event.ctrlKey || event.metaKey
          || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        const group = event.currentTarget;
        const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)'));
        const index = buttons.indexOf(group.ownerDocument.activeElement as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        const rtl = group.ownerDocument.defaultView?.getComputedStyle(group).direction === "rtl";
        const previous = event.key === "ArrowUp" || event.key === (rtl ? "ArrowRight" : "ArrowLeft");
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (previous ? -1 : 1) + buttons.length) % buttons.length;
        const target = buttons[next]!;
        target.focus();
        onValueChange(target.dataset.value!);
      }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          data-value={option.value}
          tabIndex={!disabled && focusValue === option.value ? 0 : -1}
          disabled={disabled || option.disabled}
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export type SettingsSegmentedProps = Omit<SegmentedControlProps, "appearance">;

/** Settings-compatible adapter retained for existing extension views. */
export function SettingsSegmented(props: SettingsSegmentedProps) {
  return <SegmentedControl {...props} appearance="inset" className={classes("settings-control-segmented", props.className)} />;
}

export interface SettingsSwitchProps {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly label: string;
  readonly disabled?: boolean;
  readonly title?: string;
}

export function SettingsSwitch({ checked, onCheckedChange, label, disabled = false, title }: SettingsSwitchProps) {
  return (
    <button
      type="button"
      className="settings-control-switch"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    >
      <span aria-hidden="true" />
    </button>
  );
}

export interface SettingsRangeProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> {
  readonly value: number;
  readonly onValueChange: (value: number) => void;
  readonly output?: ReactNode;
}

export function SettingsRange({ value, onValueChange, output = value, className, ...props }: SettingsRangeProps) {
  return (
    <div className={classes("settings-control-range", className)}>
      <input
        {...props}
        type="range"
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.valueAsNumber)}
      />
      <output>{output}</output>
    </div>
  );
}

export interface SettingsNoticeProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: "neutral" | "error" | "success";
}

export function SettingsNotice({ tone = "neutral", className, children, ...props }: SettingsNoticeProps) {
  return (
    <div
      {...props}
      className={classes("settings-control-notice", `settings-control-notice--${tone}`, className)}
      role={tone === "error" ? "alert" : props.role}
    >
      {children}
    </div>
  );
}

export interface SettingsActionsProps extends HTMLAttributes<HTMLDivElement> {
  readonly align?: "start" | "between" | "end";
  readonly wrap?: boolean;
}

export function SettingsActions({ align = "end", wrap = false, className, children, ...props }: SettingsActionsProps) {
  return (
    <div {...props} className={classes("settings-control-actions", `settings-control-actions--${align}`, wrap && 'settings-control-actions--wrap', className)}>
      {children}
    </div>
  );
}

export interface SettingsButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: "primary" | "secondary" | "danger" | "ghost" | "quiet";
  /** Visible progress and duplicate-click prevention; the caller owns the operation. */
  readonly loading?: boolean;
}


export function SettingsButton({ variant = "secondary", className, children, loading = false, disabled, ...props }: SettingsButtonProps) {
  return (
    <button {...props} disabled={disabled || loading} aria-busy={loading || props["aria-busy"]} className={classes("settings-control-button", `settings-control-button--${variant}`, className)}>
      {loading ? <LoadingRingIcon className="settings-control-button__spinner" size={14} /> : null}
      {children}
    </button>
  );
}
