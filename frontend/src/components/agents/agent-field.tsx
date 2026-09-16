import { useId, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface AgentFieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  required?: boolean;
}

export interface AgentFieldProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  controlId?: string;
  children: (controlProps: AgentFieldControlProps) => ReactNode;
}

export function AgentField({ label, description, error, required, controlId, className, children, ...props }: AgentFieldProps) {
  const generatedId = useId();
  const id = controlId ?? generatedId;
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={cn("min-w-0 space-y-2", className)} {...props}>
      <label htmlFor={id} className="block text-sm font-medium text-[var(--text-primary)]">{label}</label>
      {children({ id, "aria-describedby": [descriptionId, errorId].filter(Boolean).join(" ") || undefined, "aria-invalid": error ? true : undefined, required })}
      {description && <div id={descriptionId} className="text-pretty text-sm leading-6 text-[var(--text-secondary)]">{description}</div>}
      {error && <div id={errorId} role="alert" className="text-pretty text-sm leading-6 text-[var(--danger)]">{error}</div>}
    </div>
  );
}
