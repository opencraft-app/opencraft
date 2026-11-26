import {
  BrowserToolError,
  type BrowserDynamicToolContext,
  type BrowserDynamicToolHost,
} from "@opencraft/browser-appserver";
import { BrowserAutomationError, type BrowserTabId, type BrowserEffectReceipts } from "@opencraft/browser-core";
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
    private readonly receipts?: BrowserEffectReceipts,
    private readonly shouldAutoPresentPanel: () => boolean = () => true,
  ) {}

  private threadScope(context: BrowserDynamicToolContext): string {
    return this.workbench.scopeForThread(context);
  }

  private requireOwnedTab(context: BrowserDynamicToolContext, tabId: BrowserTabId) {
    return this.workbench.requireOwnedTab(this.threadScope(context), tabId);
  }

  open(context: BrowserDynamicToolContext, args: Readonly<Record<string, unknown>>): unknown {
    return this.boundary(() => this.effect(context, args, 'open', () => {
      if (context.signal?.aborted) throw new BrowserToolError('CDP_ABORTED', 'Browser invocation cancelled', false, 'not-dispatched');
      if (args['visible'] !== undefined && typeof args['visible'] !== 'boolean') throw new BrowserToolError('INVALID_ARGUMENT', 'visible must be a boolean', false, 'not-dispatched');
      const visible = args['visible'] === true && this.shouldAutoPresentPanel();
      if (visible && (!this.workbench.canPresentConversation(context) || typeof document !== 'undefined' && document.visibilityState !== 'visible'))
        throw new BrowserToolError('PRESENTATION_UNAVAILABLE', 'No visible Workbench is available for this conversation', false, 'not-dispatched');
      const placement = stringArgument(args, "placement") ?? "right";
      if (placement !== "right")
        throw new BrowserToolError("CAPABILITY_UNAVAILABLE", "The current Web workbench presents browser tabs in the right panel only");
      const requestedId = stringArgument(args, "tab_id");
      const url = stringArgument(args, "url");
      if (requestedId === null && url === null)
        throw new BrowserToolError("INVALID_ARGUMENT", "url or tab_id is required");
      const opened = this.workbench.open(this.threadScope(context), {
        visible,
        ...(requestedId === null ? {} : { tabId: asTabId(requestedId) }),
        ...(url === null ? {} : { initialUrl: url }),
      });
      if (opened === null) return { opened: false, target: "external-browser", url };
      const page = this.pages.getSnapshot(opened.pageId);
      const result = {
        opened: true,
        tabId: opened.tabId,
        panelTabId: opened.tab?.id ?? null,
        placement,
        visible,
        url: page?.navigation.currentUrl ?? url,
      };
      if (!visible) return result;
      return this.workbench.waitForConversationPresentation({ hostId: context.hostId, threadId: context.threadId, tabId: opened.tabId }, context.signal).then(painted => {
        if (!painted) throw new BrowserToolError(context.signal?.aborted ? 'CDP_ABORTED' : 'PRESENTATION_UNAVAILABLE', 'Browser foreground presentation was not confirmed', false, 'unknown');
        return result;
      });
    }));
  }

  async getTabContext(context: BrowserDynamicToolContext, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.boundary(async () => {
      if (context.signal?.aborted) throw new BrowserToolError("CDP_ABORTED", "Browser invocation cancelled", false, "not-dispatched");
      const invocation = context.signal ? { signal: context.signal } : undefined;
      const tabId = asTabId(stringArgument(args, "tab_id", true)!);
      const { page: snapshot } = this.requireOwnedTab(context, tabId);
      const page = await this.pages.readPageContext(snapshot.id, {
        includeSelection: args["include_selection"] !== false,
        maxInlineChars: numberArgument(args, "max_inline_chars", 50_000),
      }, invocation);
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
    const writes = ['navigate', 'back', 'forward', 'reload', 'stop', 'click', 'fill', 'press', 'scroll', 'close'];
    return this.boundary(() => this.effect(context, args, writes.includes(String(args['action'])) ? String(args['action']) : null, async (logicalClose = false) => {
      if (context.signal?.aborted && !logicalClose) throw new BrowserToolError("CDP_ABORTED", "Browser invocation cancelled", false, "not-dispatched");
      const invocation = context.signal ? { signal: context.signal } : undefined;
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
          const { pageId: _internalPageId, ...inspection } = await this.pages.inspectPage(page.id, invocation);
          return { ...inspection, tabId };
        }
        case "click":
          await this.pages.clickElement(page.id, stringArgument(args, "ref", true)!, requiredRevision(args), invocation);
          return { action, tabId, clicked: true };
        case "fill":
          if (typeof args["value"] !== "string") throw new BrowserToolError("INVALID_ARGUMENT", "value must be a string");
          await this.pages.fillElement(page.id, stringArgument(args, "ref", true)!, requiredRevision(args), args["value"], invocation);
          return { action, tabId, filled: true };
        case "press": await this.pages.pressKey(page.id, stringArgument(args, "key", true)!, invocation); return { action, tabId, pressed: true };
        case "scroll": await this.pages.scrollPage(page.id, numberArgument(args, "x", 0), numberArgument(args, "y", 0), invocation); return { action, tabId, scrolled: true };
        case "wait": await this.pages.waitForText(page.id, stringArgument(args, "text", true)!, numberArgument(args, "timeout_ms", 5_000), invocation); return { action, tabId, matched: true };
        default: throw new BrowserToolError("INVALID_ARGUMENT", `Unsupported browser action ${action}`);
      }
    }));
  }

  private effect(context: BrowserDynamicToolContext, args: Readonly<Record<string, unknown>>, action: string | null, dispatch: (logicalClose?: boolean) => unknown | Promise<unknown>): unknown | Promise<unknown> {
    if (!action || !this.receipts) return dispatch();
    const ownerId = this.threadScope(context);
    const check = (outcome: 'not-dispatched' | 'unknown') => {
      if (context.signal?.aborted) throw new BrowserToolError('CDP_ABORTED', 'Browser execution cancelled', false, outcome);
      let active = false;
      try { active = this.threadScope(context) === ownerId; } catch { /* Retired conversation binding. */ }
      if (!active) throw new BrowserToolError('TAB_ACCESS_DENIED', 'Browser execution is no longer active', false, outcome);
    };
    let resource: { tabId: string; pageId: string } | undefined;
    if (action === 'close' && typeof args['tab_id'] === 'string') {
      try { resource = { tabId: args['tab_id'], pageId: this.requireOwnedTab(context, asTabId(args['tab_id'])).page.id }; }
      catch (error) { if (!(error instanceof BrowserToolError) || error.code !== 'TAB_NOT_FOUND') throw error; }
    }
    const request = { ...(resource ? { resource } : {}), ownerId, hostId: context.hostId, threadId: context.threadId, turnId: context.turnId,
      callId: context.callId, action, arguments: structuredClone(args) };
    return (async () => {
      check('not-dispatched');
      const receipt = await this.receipts!.admit(request, { authorize: () => check('not-dispatched') });
      if (receipt.logicalClose) {
        // The Worker has committed logical close + retirement + metadata in
        // one transaction. Native destruction now only cleans up that resource.
        try { await dispatch(true); }
        catch (error) {
          if (!(error instanceof BrowserToolError) || error.code !== 'TAB_NOT_FOUND')
            throw new BrowserToolError('BROWSER_OUTCOME_UNKNOWN', 'Browser was logically closed; native cleanup was not confirmed', false, 'unknown');
        }
        check('unknown');
        return receipt.admitted ? { closed: true, tabId: args['tab_id'] } : receipt.result;
      }
      if (!receipt.admitted) { check('not-dispatched'); return receipt.result; }
      let dispatched = false, result: unknown;
      try {
        check('not-dispatched');
        dispatched = true;
        result = await dispatch();
      } catch (cause) {
        const error = cause as { outcome?: string };
        await this.receipts!.settle(request, !dispatched || error.outcome === 'not-dispatched' ? 'failed' : 'unknown').catch(() => {});
        throw cause;
      }
      try { await this.receipts!.settle(request, 'completed', result); }
      catch { throw new BrowserToolError('BROWSER_OUTCOME_UNKNOWN', 'Browser effect completed without a durable reply; inspect before another input', false, 'unknown'); }
      check('unknown');
      return result;
    })();
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
      return new BrowserToolError(error.code, error.message, error.retryable, error.outcome);
    return error instanceof Error ? error : new Error(String(error));
  }
}
