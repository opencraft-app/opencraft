import type { ReactNode } from "react";

/** Above-composer projections share a perimeter; the editor owns the foreground. */
export function ComposerAttachedRail({ children }: { readonly children: ReactNode }) {
  return <div className="opencraft-composer-attached-rail" data-composer-rail-placement="above">{children}</div>;
}
