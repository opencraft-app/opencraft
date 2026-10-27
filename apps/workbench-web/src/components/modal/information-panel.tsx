import type { ReactNode } from "react";
import "@opencraft/design-system/information-panel.web";

/** Compact read-only content; ModalSurface owns placement and dismissal. */
export function InformationPanel({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <section className="information-panel">
    <h2>{title}</h2>
    <dl className="information-panel__rows">{children}</dl>
  </section>;
}

export function InformationRow({ icon, label, value, monospace = false, actions }: {
  readonly icon: ReactNode; readonly label: string; readonly value: string;
  readonly monospace?: boolean; readonly actions?: ReactNode;
}) {
  return <div className="information-panel__row">
    <dt><span aria-hidden="true">{icon}</span>{label}</dt>
    <dd data-monospace={monospace || undefined}><span className="information-panel__value">{value}</span>{actions}</dd>
  </div>;
}
