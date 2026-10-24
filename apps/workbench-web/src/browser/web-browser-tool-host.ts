import {
  BrowserToolError,
  type BrowserDynamicToolContext,
  type BrowserDynamicToolHost,
} from "@opencraft/browser-appserver";
import { BrowserAutomationError, type BrowserTabId } from "@opencraft/browser-core";
import {
  WebBrowserCapabilityError,
  type WebBrowserPageRuntime,
} from "./web-browser-runtime";
import { BrowserWorkbenchCoordinator } from "./browser-workbench-coordinator";

function stringArgument(args: Readonly<Record<string, unknown>>, name: string, required = false): string | null {
  const value = args[name];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (required) throw new BrowserToolError("INVALID_ARGUMENT", `${name} is required`);
  return null;
}

function numberArgument(args: Readonly<Record<string, unknown>>, name: string, fallback: number): number {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function requiredRevision(args: Readonly<Record<string, unknown>>): number {
  const value = args["expected_revision"];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new BrowserToolError("INVALID_ARGUMENT", "expected_revision must be a non-negative integer from the latest inspect result");
  return value;
}

const asTabId = (value: string) => value as BrowserTabId;

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export class WebBrowserDynamicToolHost implements BrowserDynamicToolHost {
  constructor(
    private readonly pages: WebBrowserPageRuntime,
    private readonly workbench: BrowserWorkbenchCoordinator,
  ) {}

  private threadScope(context: BrowserDynamicToolContext): string {
    return this.workbench.scopeForThread(context);
  }

  private requireOwnedTab(context: BrowserDynamicToolContext, tabId: BrowserTabId) {
    return this.workbench.requireOwnedTab(this.threadScope(context), tabId);
  }

  open(context: BrowserDynamicToolContext, args: Readonly<Record<string, unknown>>): unknown {
    return this.boundary(() => {
      const placement = stringArgument(args, "placement") ?? "right";
      if (placement !== "right")
        throw new BrowserToolError("CAPABILITY_UNAVAILABLE", "The current Web workbench presents browser tabs in the right panel only");
      const requestedId = stringArgument(args, "tab_id");
      const url = stringArgument(args, "url");
      if (requestedId === null && url === null)
        throw new BrowserToolError("INVALID_ARGUMENT", "url or tab_id is required");
      const opened = this.workbench.open(this.threadScope(context), {
        visible: args["visible"] !== false,
        ...(requestedId === null ? {} : { tabId: asTabId(requestedId) }),
        ...(url === null ? {} : { initialUrl: url }),
      });
      if (opened === null) return { opened: false, target: "external-browser", url };
      const page = this.pages.getSnapshot(opened.pageId);
      return {
        opened: true,
        tabId: opened.tabId,
        panelTabId: opened.tab?.id ?? null,
        placement,
        visible: args["visible"] !== false,
        url: page?.navigation.currentUrl ?? url,
      };
    });
  }

  async getTabContext(context: BrowserDynamicToolContext, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.boundary(async () => {
      const tabId = asTabId(stringArgument(args, "tab_id", true)!);
      const { page: snapshot } = this.requireOwnedTab(context, tabId);
      const page = await this.pages.readPageContext(snapshot.id, {
        includeSelection: args["include_selection"] !== false,
        maxInlineChars: numberArgument(args, "max_inline_chars", 50_000),
      });
      const selection = page.selection === null ? "" : `\n  <selection>${escapeXml(page.selection)}</selection>`;
      return [
        '<browser-tab-context trust="untrusted-page-content">',
        `  <tab-id>${escapeXml(tabId)}</tab-id>`,
        `  <revision>${page.revision}</revision>`,
        `  <url>${escapeXml(page.url ?? "")}</url>`,
        `  <title>${escapeXml(page.title)}</title>${selection}`,
        `  <content>${escapeXml(page.content)}</content>`,
        "</browser-tab-context>",
      ].join("\n");
    });
  }

  browserUse(context: BrowserDynamicToolContext, args: Readonly<Record<string, unknown>>): unknown | Promise<unknown> {
    return this.boundary(async () => {
      const action = stringArgument(args, "action", true)!;
      if (action === "list_tabs") {
        return {
          tabs: this.workbench.listForOwner(this.threadScope(context)).map(({ tab, page }) => ({
            tabId: tab.id,
            title: page.title,
            url: page.navigation.currentUrl,
            loading: page.navigation.isLoading,
          })),
        };
      }
      const tabId = asTabId(stringArgument(args, "tab_id", true)!);
      const { page } = this.requireOwnedTab(context, tabId);
      switch (action) {
        case "screenshot": return { screenshot: true, imageUrl: await this.pages.capturePage(page.id) };
        case "close": this.workbench.close(this.threadScope(context), tabId); return { closed: true, tabId };
        case "navigate": {
          const url = this.pages.navigate(page.id, stringArgument(args, "url", true)!);
          if (url === null) return { action, tabId, target: "external-browser", navigated: false };
          return { action, tabId, url };
        }
        case "back": this.pages.goBack(page.id); return { action, tabId };
        case "forward": this.pages.goForward(page.id); return { action, tabId };
        case "reload": this.pages.reload(page.id); return { action, tabId };
        case "stop": this.pages.stop(page.id); return { action, tabId };
        case "inspect": {
          const { pageId: _internalPageId, ...inspection } = await this.pages.inspectPage(page.id);
          return { ...inspection, tabId };
        }
        case "click":
          await this.pages.clickElement(page.id, stringArgument(args, "ref", true)!, requiredRevision(args));
          return { action, tabId, clicked: true };
        case "fill":
          await this.pages.fillElement(page.id, stringArgument(args, "ref", true)!, requiredRevision(args), stringArgument(args, "value") ?? "");
          return { action, tabId, filled: true };
        case "press": await this.pages.pressKey(page.id, stringArgument(args, "key", true)!); return { action, tabId, pressed: true };
        case "scroll": await this.pages.scrollPage(page.id, numberArgument(args, "x", 0), numberArgument(args, "y", 0)); return { action, tabId, scrolled: true };
        case "wait": await this.pages.waitForText(page.id, stringArgument(args, "text", true)!, numberArgument(args, "timeout_ms", 5_000)); return { action, tabId, matched: true };
        default: throw new BrowserToolError("INVALID_ARGUMENT", `Unsupported browser action ${action}`);
      }
    });
  }

  private boundary<T>(operation: () => T): T {
    try {
      const result = operation();
      if (result instanceof Promise)
        return result.catch((error: unknown) => { throw this.normalizeError(error); }) as T;
      return result;
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private normalizeError(error: unknown): Error {
    if (error instanceof BrowserToolError) return error;
    if (error instanceof WebBrowserCapabilityError)
      return new BrowserToolError(error.code, error.message, error.retryable);
    if (error instanceof BrowserAutomationError)
      return new BrowserToolError(error.code, error.message, error.retryable);
    return error instanceof Error ? error : new Error(String(error));
  }
}
