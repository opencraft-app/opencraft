/** Semantic navigation only. External site journeys stay in the system browser. */
export type MobileSurface = "agents" | "account";
export type MobileShellAction = { type: "open-account" } | { type: "back" } | { type: "close-overlay" };
export function mobileShellTransition(_surface: MobileSurface, action: MobileShellAction): MobileSurface {
  return action.type === "open-account" ? "account" : "agents";
}
