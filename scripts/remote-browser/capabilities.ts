import { randomUUID } from 'node:crypto';
import { BROWSER_TOOL_CATALOG, BrowserToolError, executeBrowserTool, type BrowserToolHost, type BrowserToolContext } from '@opencraft/browser-core';
import type { CapabilitySession, CapabilityResult, CapabilityTool, SessionCapabilities } from '@opencraft/session-capabilities';

export interface BrowserExecutionGrant {
  readonly ownerId: string;
  readonly hostId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  /** Synchronous projection check; native liveness is resolved asynchronously. */
  authorize(): void;
}
interface Tab { tabId: string; lease: string; scopeId: string; url: string | null; runtime: string }
interface BrowserServicePort {
  available(): Promise<boolean>;
  conversationTabs(ownerId: string, hostId: string, threadId: string, authorize: () => void): Promise<Tab[]>;
  invokeAutomation(binding: BrowserExecutionGrant & { lease: string; scopeId: string }, method: string, input: Record<string, unknown>, options: { signal: AbortSignal }): Promise<unknown>;
  createTab(binding: BrowserExecutionGrant & { callId: string }, input: { url: string }, options: { signal: AbortSignal }): Promise<unknown>;
  closeTab(binding: BrowserExecutionGrant, input: { tabId: string }, options: { signal: AbortSignal }): Promise<unknown>;
}
export type BrowserGrantResolver = (session: CapabilitySession, invocation: boolean) => Promise<BrowserExecutionGrant>;
const navigation = ['navigate', 'back', 'forward', 'reload', 'stop'];
const actions = ['list_tabs', ...navigation, 'inspect', 'click', 'fill', 'press', 'scroll', 'wait', 'screenshot', 'close'];
const catalog = ['opencraft_browser', 'opencraft_app'].flatMap(name => BROWSER_TOOL_CATALOG.find(namespace => namespace.name === name)!.tools.map(tool => ({ ...tool, namespace: name, flatName: name + '_' + tool.name })));
const tools: readonly CapabilityTool[] = catalog.map(tool => {
  const schema = structuredClone(tool.inputSchema) as Record<string, any>;
  if (tool.name === 'browser_use') schema.properties.action.enum = actions;
  if (tool.name === 'open_in_opencraft') schema.properties.visible = { type: 'boolean', enum: [false], default: false, description: 'Service opens background tabs only. No connected viewer or focus change is required.' };
  return { name: tool.flatName, description: tool.name === 'open_in_opencraft' ? 'Create or recover a background browser tab in this conversation. Returns identity and native activation; does not inspect the page or show a panel.' : tool.description + ' Runs on server browser tabs without a connected viewer.', inputSchema: schema };
});
const denied = (outcome: 'not-dispatched' | 'unknown' = 'not-dispatched') => new BrowserToolError('TAB_ACCESS_DENIED', 'Browser execution authority expired', false, outcome);
const key = (session: CapabilitySession) => JSON.stringify([session.serverId, session.threadId]);
function text(args: Readonly<Record<string, unknown>>, name: string) {
  if (typeof args[name] !== 'string' || !(args[name] as string).trim()) throw new BrowserToolError('INVALID_ARGUMENT', `${name} is required`);
  return (args[name] as string).trim();
}

/** Platform adapter. Engines provide only trusted execution identity and cancel;
 * the browser service retains account, conversation, native page and control.
 */
export class RemoteBrowserCapabilities {
  private closed = false;
  private readonly declarations = new Map<string, BrowserExecutionGrant>();
  private readonly refreshes = new Map<string, symbol>();
  private readonly pendingRefreshes = new Set<Promise<void>>();
  private readonly active = new Map<AbortController, Promise<unknown>>();
  private readonly unregister: () => void;
  constructor(capabilities: SessionCapabilities, private readonly service: BrowserServicePort, private readonly resolve: BrowserGrantResolver) {
    this.unregister = capabilities.register({ id: 'opencraft.browser', refresh: session => {
      const task = this.refresh(session).finally(() => { this.pendingRefreshes.delete(task); });
      this.pendingRefreshes.add(task); return task;
    },
      tools: session => {
        try {
          if (this.closed || !session.execution || !this.declarations.has(key(session))) return [];
          this.declarations.get(key(session))!.authorize(); return tools;
        } catch { return []; }
      }, formatResult: value => value as CapabilityResult,
      call: (session, name, args, signal) => {
        const controller = new AbortController();
        const cancel = () => controller.abort(); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
        const call = this.call(session, name, args, controller).finally(() => { signal.removeEventListener('abort', cancel); this.active.delete(controller); });
        this.active.set(controller, call); return call;
      } });
  }
  private async refresh(session: CapabilitySession) {
    const id = key(session), operation = Symbol(); this.refreshes.set(id, operation); this.declarations.delete(id);
    try {
      if (this.closed || !session.execution || !await this.service.available()) return;
      const grant = await this.resolve(session, false); grant.authorize();
      if (this.closed || this.refreshes.get(id) !== operation) return;
      if (this.declarations.size >= 256) this.declarations.delete(this.declarations.keys().next().value!);
      this.declarations.set(id, grant);
    } catch { /* Ordinary engine execution remains usable without browser authority. */ }
    finally { if (this.refreshes.get(id) === operation) this.refreshes.delete(id); }
  }
  private async call(session: CapabilitySession, name: string, args: unknown, controller: AbortController): Promise<CapabilityResult> {
    if (this.closed) throw denied(); controller.signal.throwIfAborted();
    if (!await this.service.available()) throw new BrowserToolError('CAPABILITY_UNAVAILABLE', 'Bundled browser runtime unavailable', false, 'not-dispatched');
    const tool = catalog.find(tool => tool.flatName === name); if (!tool) throw denied();
    const grant = await this.resolve(session, true);
    if (!grant.turnId || grant.threadId !== session.threadId) throw denied();
    const context: BrowserToolContext = { hostId: grant.hostId, threadId: grant.threadId, turnId: grant.turnId, callId: session.execution?.callId ?? randomUUID() };
    let finished = false, checking: Promise<void> | undefined;
    const validate = () => {
      try { if (this.closed || controller.signal.aborted) throw denied('unknown'); grant.authorize(); }
      catch { throw denied('unknown'); }
    };
    const watcher = setInterval(() => {
      if (checking || finished) return;
      checking = this.resolve(session, true).then(current => {
        if (finished) return;
        if (current.ownerId !== grant.ownerId || current.hostId !== grant.hostId || current.threadId !== grant.threadId || current.turnId !== grant.turnId) throw denied();
        current.authorize();
      }).catch(() => { if (!finished) controller.abort(); }).finally(() => { checking = undefined; });
    }, 500); watcher.unref();
    const host: BrowserToolHost = {
      open: async (_context, args) => {
        if (args.visible !== undefined && args.visible !== false || args.placement !== undefined && args.placement !== 'right')
          throw new BrowserToolError('CAPABILITY_UNAVAILABLE', 'Service browser supports background tabs only', false, 'not-dispatched');
        validate();
        if (args.tab_id !== undefined) {
          const tab = await this.tab(grant, text(args, 'tab_id'), validate);
          await this.invoke({ ...grant, ...tab, authorize: validate }, args.url === undefined ? 'activate' : 'navigate', args.url === undefined ? {} : { url: text(args, 'url') }, { signal: controller.signal });
          return { tabId: tab.tabId, visible: false, placement: 'right', ...(args.url !== undefined ? { navigationAccepted: true } : {}) };
        }
        return this.native(() => this.service.createTab({ ...grant, callId: context.callId, authorize: validate }, { url: text(args, 'url') }, { signal: controller.signal }));
      },
      getTabContext: async (_context, args) => {
        const tab = await this.tab(grant, text(args, 'tab_id'), validate);
        const page = await this.invoke({ ...grant, ...tab, authorize: validate }, 'readContext', {
          includeSelection: args.include_selection !== false, maxInlineChars: args.max_inline_chars ?? 50000,
        }, { signal: controller.signal });
        return { trust: 'untrusted-page-content', tabId: tab.tabId, ...(page as object) };
      },
      browserUse: async (_context, args) => {
        const action = text(args, 'action');
        if (!actions.includes(action)) throw new BrowserToolError('CAPABILITY_UNAVAILABLE', 'Unsupported service browser action');
        validate();
        if (action === 'list_tabs') {
          const tabs = await this.service.conversationTabs(grant.ownerId, grant.hostId, grant.threadId, validate);
          return { tabs: tabs.map(tab => ({ tabId: tab.tabId, url: tab.url, runtime: tab.runtime })) };
        }
        if (action === 'close') return this.native(() => this.service.closeTab({ ...grant, authorize: validate }, { tabId: text(args, 'tab_id') }, { signal: controller.signal }));
        const tab = await this.tab(grant, text(args, 'tab_id'), validate);
        const input: Record<string, unknown> = action === 'navigate' ? { url: text(args, 'url') }
          : action === 'click' || action === 'fill' ? { ref: text(args, 'ref'), expectedRevision: args.expected_revision, ...(action === 'fill' ? { value: args.value } : {}) }
          : action === 'press' ? { key: text(args, 'key') } : action === 'scroll' ? { x: args.x ?? 0, y: args.y ?? 0 }
          : action === 'wait' ? { text: text(args, 'text'), timeoutMs: args.timeout_ms ?? 5000 } : {};
        const result = await this.invoke({ ...grant, ...tab, authorize: validate }, action === 'screenshot' ? 'capture' : action, input, { signal: controller.signal });
        return navigation.includes(action) ? { action, tabId: tab.tabId, accepted: true }
          : action === 'screenshot' ? { screenshot: true, imageUrl: result }
          : action === 'inspect' ? { ...(result as object), tabId: tab.tabId } : { action, tabId: tab.tabId, completed: true };
      },
    };
    try {
      validate();
      const value = args && typeof args === 'object' && !Array.isArray(args) ? structuredClone(args) as Record<string, unknown> : args;
      if (value && typeof value === 'object' && Object.keys(value).some(field => !Object.hasOwn(tool.inputSchema.properties as object, field))) throw new BrowserToolError('INVALID_ARGUMENT', 'Unknown browser argument');
      const result = await executeBrowserTool(host, context, { namespace: tool.namespace, name: tool.name }, value);
      validate();
      return { success: result!.success, contentItems: result!.content.map(item => item.type === 'text'
        ? { type: 'inputText', text: item.text } : { type: 'inputImage', imageUrl: item.imageUrl }) };
    } finally { finished = true; clearInterval(watcher); await checking; }
  }
  private async invoke(...args: Parameters<BrowserServicePort['invokeAutomation']>) {
    return this.native(() => this.service.invokeAutomation(...args));
  }
  private async native(operation: () => Promise<unknown>) {
    try { return await operation(); }
    catch (error) {
      const failure = error as {code?: unknown;message?: unknown;retryable?: unknown;outcome?: unknown};
      if (typeof failure?.code === 'string') throw new BrowserToolError(failure.code, String(failure.message ?? 'Browser operation failed'), failure.retryable === true,
        failure.outcome === 'unknown' || failure.outcome === 'not-dispatched' ? failure.outcome : undefined);
      throw error;
    }
  }
  private async tab(grant: BrowserExecutionGrant, id: string, authorize: () => void) {
    const matches = (await this.service.conversationTabs(grant.ownerId, grant.hostId, grant.threadId, authorize)).filter(tab => tab.tabId === id);
    if (matches.length !== 1) throw new BrowserToolError('TAB_ACCESS_DENIED', 'Browser tab is outside the admitted conversation', false, 'not-dispatched');
    return matches[0]!;
  }
  async close() {
    this.closed = true; this.unregister(); this.declarations.clear(); for (const controller of this.active.keys()) controller.abort();
    await Promise.allSettled([...this.active.values(), ...this.pendingRefreshes]);
  }
}
