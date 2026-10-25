import * as Slider from "@radix-ui/react-slider";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { useMotionReduction } from "./use-motion-reduction";
import { selectionMotion } from "@opencraft/design-system/tokens";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface DiscreteSliderOption { readonly value: string; readonly label: string }

/** A single ordered choice. Radix owns capture, snapping, keys and ARIA;
 * preview is local and the consumer receives only completed choices. */
export function DiscreteSlider({ options, value, label, unsetLabel, disabled = false, onValueChange, preservePointerFocus, appearance = "default", renderValue }: {
  readonly renderValue?: (value: string) => ReactNode;
  readonly appearance?: "default" | "capsule";
  readonly options: readonly DiscreteSliderOption[];
  readonly value: string | null;
  readonly label: string;
  readonly unsetLabel: string;
  readonly disabled?: boolean;
  readonly onValueChange: (value: string) => void;
  readonly preservePointerFocus?: () => boolean;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const thumb = useRef<HTMLSpanElement>(null);
  const heldFocus = useRef(false);
  const pointer = useRef<number | null>(null);
  const choiceKey = JSON.stringify(options.map(option => option.value));
  useEffect(() => { setPreview(null); setPressed(false); }, [value, choiceKey, disabled]);
  const selected = options.findIndex(option => option.value === value);
  const index = Math.max(0, Math.min(preview ?? Math.max(0, selected), options.length - 1));
  const current = preview !== null || selected >= 0 ? options[index]?.label : unsetLabel;
  const inactive = disabled || options.length <= 1;
  const fraction = index / Math.max(1, options.length - 1);
  const progress = useMotionValue(fraction);
  const reduced = useMotionReduction();
  const previousChoices = useRef(choiceKey);
  const visualPosition = useTransform(progress, next => `${next * 100}%`);
  const fillWidth = useTransform(progress, next => `calc(${next * 100}% + ${0.5 - next} * var(--size-discrete-slider-thumb))`);
  useLayoutEffect(() => {
    progress.stop();
    const changedChoices = previousChoices.current !== choiceKey;
    previousChoices.current = choiceKey;
    if (reduced || inactive || changedChoices) { progress.jump(fraction); return; }
    const playback = animate(progress, fraction, pressed ? selectionMotion.drag : selectionMotion.settle);
    return () => playback.stop();
  }, [fraction, pressed, reduced, inactive, choiceKey, progress]);
  const restoreFocusability = () => {
    if (heldFocus.current) thumb.current?.setAttribute("tabindex", "0");
    heldFocus.current = false;
  };
  const finishPointer = () => {
    pointer.current = null;
    setPressed(false);
    restoreFocusability();
  };
  if (!options.length) return null;
  return <div className="ui-discrete-slider" data-appearance={appearance} data-pressed={pressed || undefined} data-unset={selected < 0 && preview === null || undefined}>
    <div className="ui-discrete-slider__value" >{renderValue ? renderValue(current ?? unsetLabel) : <span aria-hidden="true">{current}</span>}</div>
    <div className="ui-discrete-slider__surface"><Slider.Root className="ui-discrete-slider__control" min={0} max={Math.max(1, options.length - 1)} step={1}
      value={[index]} disabled={disabled || options.length === 1}
      onPointerDownCapture={event => {
        if (inactive || !event.isPrimary || event.button !== 0) return;
        pointer.current = event.pointerId;
        setPressed(true);
        // A non-focusable span makes Radix's pointer-origin focus a no-op.
        // This preserves an editor lease without blur/refocus or custom gestures.
        heldFocus.current = preservePointerFocus?.() ?? false;
        if (heldFocus.current) thumb.current?.removeAttribute("tabindex");
      }}
      onPointerUp={event => {
        if (pointer.current !== event.pointerId) return;
        finishPointer();
        // Radix commits only a changed numeric value. An explicitly chosen
        // first stop must also commit when this choice was previously unset.
        if (!disabled && options.length > 1 && selected < 0 && preview === null) onValueChange(options[0].value);
      }}
      onPointerCancel={() => { finishPointer(); setPreview(null); }}
      onLostPointerCapture={() => { finishPointer(); setPreview(null); }}
      onKeyDown={event => {
        // Menu roving focus/typeahead must not consume slider adjustment keys.
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) event.stopPropagation();
        if (!disabled && options.length > 1 && selected < 0 && event.key === "Home") onValueChange(options[0].value);
      }}
      onValueChange={([next]) => setPreview(next)}
      onValueCommit={([next]) => {
        const option = options[next];
        if (option && option.value !== value) onValueChange(option.value);
        setPreview(null);
      }}>
      <Slider.Track className="ui-discrete-slider__track">
        {/* Radix bounds the thumb center by its radius, but leaves Range at the
            raw track percentage. Match that inset at every stop, including RTL. */}
        {appearance === "capsule" ? <motion.span className="ui-discrete-slider__range" style={{ width: fillWidth }} /> : <Slider.Range className="ui-discrete-slider__range" style={{
          marginInlineEnd: `calc(${index / Math.max(1, options.length - 1) - 0.5} * var(--size-discrete-slider-thumb))`,
        }} />}
        <span className="ui-discrete-slider__ticks" aria-hidden="true">
          {options.map((option, position) => <span key={option.value} data-filled={position <= index || undefined} title={option.label} />)}
        </span>
      </Slider.Track>
      {appearance === "capsule" ? <span className="ui-discrete-slider__visual-rail" aria-hidden="true">
        <motion.span className="ui-discrete-slider__visual-thumb" style={{ insetInlineStart: visualPosition }}>
          <motion.span className="ui-discrete-slider__knob" initial={false}
            animate={{ scale: reduced || inactive ? 1 : pressed ? selectionMotion.pressedScale : hovered ? selectionMotion.hoveredScale : 1 }}
            transition={reduced ? { duration: 0 } : pressed ? selectionMotion.press : selectionMotion.release} />
        </motion.span>
      </span> : null}
      <Slider.Thumb ref={thumb} className="ui-discrete-slider__thumb" role="slider" aria-label={label}
        onPointerEnter={event => { if (event.pointerType !== "mouse") return; setHovered(true); }} onPointerLeave={() => setHovered(false)}
        aria-disabled={disabled || options.length === 1} aria-valuemax={options.length - 1} aria-valuetext={current} />
    </Slider.Root></div>
    <div className="ui-discrete-slider__limits" aria-hidden="true"><span>{options[0].label}</span><span>{options.length > 1 ? options.at(-1)!.label : null}</span></div>
  </div>;
}
