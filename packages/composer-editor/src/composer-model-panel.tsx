import { useLayoutEffect, useRef, type ReactNode } from "react";
import { DiscreteSlider, type DiscreteSliderOption } from "@opencraft/design-system-web/discrete-slider";

/** Open-menu content is loaded independently of the always-visible composer. */
export default function ComposerModelPanel({ efforts, effort, defaultLabel, reasoningLabel, renderHeader, preservesEditorFocus, onEffortChange }: {
  readonly efforts: readonly DiscreteSliderOption[];
  readonly effort: string | null;
  readonly defaultLabel?: string;
  readonly reasoningLabel: string;
  readonly renderHeader: (current?: string) => ReactNode;
  readonly preservesEditorFocus: () => boolean;
  readonly onEffortChange: (value: string) => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = content.current;
    const menu = element?.closest('[role="menu"]');
    // If the keyboard opened before this chunk arrived, the native menu itself
    // holds focus. Hand it to the loaded choices without taking an editor lease.
    if (menu && menu === element?.ownerDocument.activeElement && !preservesEditorFocus()) {
      element.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus({ preventScroll: true });
    }
  }, []);
  return <div ref={content}>
    {efforts.length ? <div role="group" aria-label={reasoningLabel}>
      <DiscreteSlider key={JSON.stringify(efforts.map(option => option.value))} appearance="capsule"
        renderValue={renderHeader} options={efforts} value={effort} label={reasoningLabel} unsetLabel={defaultLabel ?? reasoningLabel}
        preservePointerFocus={preservesEditorFocus} onValueChange={onEffortChange} />
    </div> : renderHeader(defaultLabel)}
  </div>;
}
