import type { BrowserToolContext, BrowserToolHost, BrowserToolResult } from "./contract";
import { BrowserToolError } from "./errors";

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

function textResult(value: unknown, success = true): BrowserToolResult {
  return { success, content: [{ type: "text", text: typeof value === "string"
    ? value : JSON.stringify(value) ?? String(value) }] };
}

/** Dispatch shared tool semantics; adapters supply names and trusted context. */
export async function executeBrowserTool(
  host: BrowserToolHost,
  context: BrowserToolContext,
  tool: { readonly namespace: string | null; readonly name: string },
  args: unknown,
): Promise<BrowserToolResult | null> {
  const open = tool.namespace === "opencraft_app" && tool.name === "open_in_opencraft";
  const browser = tool.namespace === "opencraft_browser";
  if (!open && !(browser && ["get_tab_context", "browser_use"].includes(tool.name))) return null;
  const value = record(args);
  if (value === null) return textResult("Browser tool arguments must be an object", false);
  try {
    if (open) return textResult(await host.open(context, value));
    if (tool.name === "get_tab_context") return textResult(await host.getTabContext(context, value));
    const result = await host.browserUse(context, value);
    const image = record(result);
    if (image?.["screenshot"] === true && typeof image["imageUrl"] === "string")
      return { success: true, content: [{ type: "image", imageUrl: image["imageUrl"] }] };
    return textResult(result);
  } catch (error) {
    return textResult({
      code: error instanceof BrowserToolError ? error.code : "BROWSER_TOOL_FAILED",
      message: error instanceof Error ? error.message : String(error),
      retryable: error instanceof BrowserToolError ? error.retryable : false,
      ...(error instanceof BrowserToolError && error.outcome ? { outcome: error.outcome } : {}),
    }, false);
  }
}
