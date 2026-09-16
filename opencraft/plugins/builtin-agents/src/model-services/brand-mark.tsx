import { lazy, Suspense, type CSSProperties } from "react";
import { Blocks, Brain } from "lucide-react";
import type { BrandKind } from "./brand-resolution";

export interface BrandMarkProps { kind: BrandKind; id: string; size?: 22 | 24 | 32 }
export function NeutralBrand({ kind, size = 24 }: BrandMarkProps) {
  return kind === "model" ? <Brain size={size} data-brand-id="unknown" /> : <Blocks size={size} data-brand-id="unknown" />;
}
const CatalogMark = lazy(() => import("./catalog-mark").catch(() => ({ default: NeutralBrand })));

/** A stable leading slot shared by provider menus, headings and model rows. */
export function BrandMark({ kind, id, size = 24 }: BrandMarkProps) {
  return <span className="model-brand-mark" aria-hidden="true" data-brand-kind={kind} style={{ "--model-brand-size": `${size}px` } as CSSProperties}>
    <Suspense fallback={<NeutralBrand kind={kind} id={id} size={size} />}><CatalogMark kind={kind} id={id} size={size} /></Suspense>
  </span>;
}
