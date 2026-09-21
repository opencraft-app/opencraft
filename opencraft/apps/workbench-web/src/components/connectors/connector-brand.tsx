import { Plug } from "lucide-react";

// Static brand assets only; no dependency on Octop's components or runtime.
const images = import.meta.glob<string>("../../assets/connector-brands/*.{png,svg}", {
  eager: true,
  query: "?url",
  import: "default",
});

export function ConnectorBrand({ id }: { readonly id: string }) {
  const path = `../../assets/connector-brands/${id}`;
  const src = images[`${path}.png`] ?? images[`${path}.svg`];
  return (
    <span className="connector-brand" aria-hidden="true">
      {src ? <img src={src} alt="" draggable={false} /> : <Plug size={22} />}
    </span>
  );
}
