import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CapabilityError, type CapabilityPhase } from './errors.js';
import type { CapabilitySession, CapabilityTool, CapabilityResult, SessionCapabilityProvider } from './index.js';

export interface McpCredential {
  readonly account: string; readonly revision: number; readonly token: string;
  /** Durable, immutable execution identity. Required when invoking a tool. */
  readonly executionId?: string;
}
export interface AuthenticatedMcpOptions {
  readonly id: string; readonly prefix: string; readonly endpoint: string;
  /** Trusted composition owns employee admission and execution validation. */
  resolve(session: CapabilitySession, invocation: boolean): McpCredential | null;
  readonly fetcher?: typeof fetch;
}
const denied = () => new CapabilityError('capability_not_authorized', 'authorization');
/** An identity/transport bridge, without provider-specific API implementations.
 * Authenticated clients are private to one operation. Never reuse upstream MCP
 * sessions across employees, credential revisions or execution incarnations. */
export class AuthenticatedMcpProvider implements SessionCapabilityProvider {
  readonly id: string;
  private readonly catalogs = new Map<string, readonly CapabilityTool[]>();
  constructor(private readonly options: AuthenticatedMcpOptions) { this.id = options.id; }
  private key(value: McpCredential) { return JSON.stringify([value.account, value.revision]); }
  private credential(session: CapabilitySession, invocation: boolean) {
    const value = this.options.resolve(session, invocation);
    if (!value || invocation && !value.executionId) throw denied();
    return value;
  }
  private sanitize(value: unknown, credential: McpCredential): unknown {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    // Redact reflected header values as well as the exact secret (including a
    // JSON-escaped value). Errors never include transport diagnostics.
    return JSON.parse(serialized.split(JSON.stringify(credential.token).slice(1, -1)).join('[redacted]')
      .split(encodeURIComponent(credential.token)).join('[redacted]'));
  }
  private async use<T>(session: CapabilitySession, invocation: boolean, signal: AbortSignal,
    run: (client: Client, credential: McpCredential, dispatch: () => void) => Promise<T>): Promise<T> {
    const credential = this.credential(session, invocation), abort = new AbortController();
    let phase: CapabilityPhase = invocation ? 'connection' : 'catalog', dispatched = false;
    let revoked: CapabilityError | undefined, upstreamFailure: CapabilityError | undefined;
    const checked = () => {
      signal.throwIfAborted(); abort.signal.throwIfAborted();
      const current = this.credential(session, invocation);
      if (current.account !== credential.account || current.revision !== credential.revision
        || current.executionId !== credential.executionId) throw denied();
    };
    const client = new Client({ name: 'opencraft-host', version: '1' });
    const cancel = () => { abort.abort(); void client.close().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    // Revoke in-flight requests promptly on employee removal, unbinding or a
    // completed/replaced execution. No external write is automatically replayed.
    const watcher = setInterval(() => { try { checked(); } catch (error) {
      if (error instanceof CapabilityError) revoked = error;
      cancel();
    } }, 100);
    watcher.unref();
    const timeout = setTimeout(cancel, 60_000); timeout.unref();
    const fetcher: typeof fetch = async (input, init) => {
      checked();
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.href !== this.options.endpoint) throw denied();
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${credential.token}`);
      const response = await (this.options.fetcher ?? fetch)(input, { ...init, headers, redirect: 'error', signal: abort.signal });
      checked();
      if (!response.ok && (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() === 'POST')
        upstreamFailure = new CapabilityError('capability_upstream_rejected', phase, dispatched ? 'unknown' : 'not_dispatched', response.status);
      return response;
    };
    try {
      checked();
      await client.connect(new StreamableHTTPClientTransport(new URL(this.options.endpoint), { fetch: fetcher }));
      checked();
      const result = await run(client, credential, () => { checked(); phase = 'invocation'; dispatched = true; });
      checked(); return result;
    } catch (cause) {
      const error = revoked ?? upstreamFailure ?? cause;
      const outcome = dispatched ? 'unknown' : 'not_dispatched';
      if (error instanceof CapabilityError) throw new CapabilityError(error.code, error.phase, outcome, error.upstreamStatus);
      throw new CapabilityError(signal.aborted || abort.signal.aborted ? 'capability_cancelled'
        : dispatched ? 'capability_outcome_unknown' : invocation ? 'capability_upstream_unavailable' : 'capability_catalog_unavailable', phase, outcome);
    }
    finally { clearInterval(watcher); clearTimeout(timeout); signal.removeEventListener('abort', cancel); await client.close().catch(() => undefined); }
  }
  tools(session: CapabilitySession): readonly CapabilityTool[] {
    try { return this.catalogs.get(this.key(this.credential(session, false))) ?? []; } catch { return []; }
  }
  async refresh(session: CapabilitySession, signal?: AbortSignal): Promise<void> {
    let credential: McpCredential;
    try { credential = this.credential(session, false); } catch { return; }
    const key = this.key(credential);
    if (this.catalogs.has(key)) return;
    const tools = await this.use(session, false, signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000), async (client, current) => {
      const tools: CapabilityTool[] = [], cursors = new Set<string>(); let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        for (const tool of page.tools) {
          const name = this.options.prefix + tool.name;
          if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(name) || tools.some(t => t.name === name)) throw new CapabilityError('capability_catalog_invalid', 'catalog');
          tools.push(this.sanitize({ name, description: tool.description ?? tool.name, inputSchema: tool.inputSchema, approval: 'preauthorized' }, current) as CapabilityTool);
        }
        cursor = page.nextCursor;
        if (tools.length > 256 || cursor && cursors.has(cursor)) throw new CapabilityError('capability_catalog_invalid', 'catalog');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return tools;
    });
    if (this.catalogs.size >= 256) this.catalogs.delete(this.catalogs.keys().next().value!);
    this.catalogs.set(key, tools);
  }
  async call(session: CapabilitySession, name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    if (!this.tools(session).some(tool => tool.name === name)) throw denied();
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new CapabilityError('capability_invalid_arguments', 'invocation');
    return this.use(session, true, signal, async (client, credential, dispatch) => {
      dispatch();
      return this.sanitize(await client.callTool({
        name: name.slice(this.options.prefix.length), arguments: args as Record<string, unknown>,
      }, undefined, { signal, timeout: 60_000 }), credential);
    });
  }
  formatResult(value: unknown): CapabilityResult {
    const result = value as { isError?: boolean; content?: unknown };
    return { success: result.isError !== true, contentItems: [{ type: 'inputText', text: JSON.stringify(result.content ?? []) }] };
  }
}
