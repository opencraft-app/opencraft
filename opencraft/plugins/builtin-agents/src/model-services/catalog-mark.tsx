import { brandAssets } from "./brand-assets";
import { resolveBrand } from "./brand-resolution";
import { NeutralBrand, type BrandMarkProps } from "./brand-mark";
const available = new Set(Object.keys(brandAssets));

export default function CatalogMark(props: BrandMarkProps) {
  const brand = resolveBrand(props.kind, props.id, available);
  if (!brand) return <NeutralBrand {...props} />;
  const url = brandAssets[brand as keyof typeof brandAssets];
  return <span className="model-brand-mark__glyph" data-brand-id={brand} style={{ maskImage: `url("${url}")`, WebkitMaskImage: `url("${url}")` }} />;
}
