/** Semantic navigation only. Gesture progress belongs to the native surface. */
export type MobileSurface = "agents" | "account" | "account-web" | "billing";
export type MobileShellAction =
  | { type: "open-account" }
  | { type: "open-account-web" }
  | { type: "open-billing" }
  | { type: "site-navigation"; destination: "account" | "billing" }
  | { type: "back" }
  | { type: "close-overlay" };

export function mobileShellTransition(surface: MobileSurface, action: MobileShellAction): MobileSurface {
  switch (action.type) {
    case "open-account": return "account";
    case "open-account-web": return "account-web";
    case "open-billing": return "billing";
    case "site-navigation":
      return surface === "account-web" || surface === "billing"
        ? action.destination === "billing" ? "billing" : "account-web"
        : surface;
    case "back": return surface === "agents" ? "agents"
      : surface === "account" ? "agents" : "account";
    case "close-overlay": return "agents";
  }
}
