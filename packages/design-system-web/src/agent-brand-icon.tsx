import type { CSSProperties } from "react";
import { agentBrandArtwork } from "./agent-brand-artwork";

export type AgentBrand = keyof typeof agentBrandArtwork;

export function AgentBrandIcon({ agent, size = 18 }: { readonly agent: AgentBrand; readonly size?: number }) {
  return <span aria-hidden="true" style={{ display: "inline-block", flexShrink: 0, width: size, height: size,
    background: "currentColor", mask: `url("${agentBrandArtwork[agent]}") center / contain no-repeat`,
    WebkitMask: `url("${agentBrandArtwork[agent]}") center / contain no-repeat`,
  } as CSSProperties} />;
}
