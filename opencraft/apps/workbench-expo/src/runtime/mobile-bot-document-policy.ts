export type BotDocumentDecision = "initial-document" | "bot-route" | "external" | "blocked";

/** Only the first navigation may establish the bundled HTML document. */
export function classifyBotDocumentNavigation(
  url: string,
  siteOrigin: string,
  initialDocumentPending: boolean,
  isTopFrame: boolean,
): BotDocumentDecision {
  if (!isTopFrame) return "blocked";
  if (initialDocumentPending && (url === "about:blank" || url.startsWith("data:text/html"))) {
    return "initial-document";
  }
  let destination: URL;
  try { destination = new URL(url); }
  catch { return "blocked"; }
  if (destination.origin === siteOrigin) {
    if (initialDocumentPending && destination.pathname === "/" && !destination.search && !destination.hash) {
      return "initial-document";
    }
    if (destination.pathname === "/agents" || destination.pathname.startsWith("/agents/")) {
      return "bot-route";
    }
    // The site root must never replace the bundled Bot document.
    if (destination.pathname === "/") return "blocked";
    return "external";
  }
  return ["https:", "mailto:", "tel:"].includes(destination.protocol) ? "external" : "blocked";
}
