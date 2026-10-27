import { useState } from "react";
import { SparklesIcon as Sparkles } from "@opencraft/design-system-web/action-icons";

/** Only explicit web/image metadata is displayable; never reinterpret a Host path as a client file. */
export function skillIconUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/u.test(value)) return value;
  try { const url=new URL(value);return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
}

export function SkillIcon({ source }: { readonly source: unknown }) {
  const url = skillIconUrl(source);
  const [failed, setFailed] = useState<string | null>(null);
  return url && failed !== url
    ? <img src={url} alt="" width={15} height={15} referrerPolicy="no-referrer" onError={()=>setFailed(url)} />
    : <Sparkles size={15} aria-hidden="true" />;
}
