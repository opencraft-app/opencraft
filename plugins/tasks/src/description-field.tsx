import { useId, useRef, useState } from "react";
import { SettingsButton } from "@opencraft/extension-react";

/** Toggling presentation never mutates the task draft. */
export function TaskDescriptionField(props: {
  label: string;
  expandLabel: string;
  collapseLabel: string;
  value: string;
  onChange(value: string): void;
}) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);
  return <div className="tasks-description" data-expanded={expanded || undefined}>
    <div className="tasks-description__heading">
      <label htmlFor={id}>{props.label}</label>
      <SettingsButton type="button" variant="quiet" aria-expanded={expanded} aria-controls={id}
        onClick={() => {
          // Manual resize must not override the explicit size choice.
          if (input.current) input.current.style.height = "";
          setExpanded(value => !value);
        }}>
        {expanded ? props.collapseLabel : props.expandLabel}
      </SettingsButton>
    </div>
    <textarea id={id} ref={input} maxLength={16384} value={props.value}
      onChange={event => props.onChange(event.target.value)} />
  </div>;
}
