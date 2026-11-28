import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  HttpBodyTooLarge,
  type HttpExchangeRequest,
  type HttpExchangeResponse,
} from '@opencraft/http-exchange';
import { serveNodeHttpExchange } from '@opencraft/http-exchange/node';
import { EnvironmentError } from './account-environment.js';
import type { EnvironmentScope, EnvironmentView } from './account-environment.js';
import { GitVaultError } from './git-vault-error.js';

export interface EnvironmentAccount {
  account: string;
  current(): boolean;
  projects(): Promise<readonly { id: string; name: string }[]>;
}
/** Metadata-only settings port. A compiled owner may implement it asynchronously;
 * launchEnvironment and decrypted saved values never belong to this interface.
 * Async owners MUST call the original assertCurrent at their actual read/commit
 * boundary AFTER waits, not merely before enqueueing. Cross-thread adapters must
 * carry the original revocable admission, not serialize this callback or mint a
 * replacement proof. A response check alone cannot fence a queued mutation. */
export interface AccountEnvironmentSettingsPort {
  list(account: string, scope: EnvironmentScope, assertCurrent: () => void): EnvironmentView | Promise<EnvironmentView>;
  replace(account: string, scope: EnvironmentScope, revision: number, input: unknown, assertCurrent: () => void): EnvironmentView | Promise<EnvironmentView>;
}

const HEADERS = [
  ['content-type', 'application/json; charset=utf-8'],
  ['cache-control', 'no-store'],
  ['x-content-type-options', 'nosniff'],
] as const;

const jsonReply = (status: number, body: unknown, extraHeaders: readonly (readonly [string, string])[] = []): HttpExchangeResponse => ({
  status,
  headers: [...HEADERS, ...extraHeaders],
  body: JSON.stringify(body),
});

/** Trusted product ingress owns authentication/admission and supplies the account.
 * No administrator read, account selector, decrypted diagnostic, or value export. */
export class AccountEnvironmentHttp {
  constructor(private readonly environment: AccountEnvironmentSettingsPort) {}

  async handleExchange(exchange: HttpExchangeRequest<unknown>, identity: EnvironmentAccount): Promise<HttpExchangeResponse> {
    const account = identity.account;
    const current = () =>
      !exchange.signal.aborted &&
      identity.account === account &&
      identity.current() &&
      exchange.headers['x-opencraft-account-scope'] === account;
    const assertCurrent = () => {
      if (!current()) throw new EnvironmentError('unavailable', 401);
    };
    if (!current()) return jsonReply(401, { error: 'unauthenticated' });
    if (exchange.headers['sec-fetch-site'] === 'cross-site') return jsonReply(403, { error: 'forbidden' });
    if (exchange.headers.origin !== undefined) {
      try {
        const origin = new URL(String(exchange.headers.origin));
        if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== exchange.headers.origin || origin.host !== exchange.headers.host) {
          throw new Error();
        }
      } catch {
        return jsonReply(403, { error: 'forbidden' });
      }
    }
    if (!['GET', 'POST'].includes(exchange.method)) {
      return jsonReply(405, { error: 'method_not_allowed' }, [['allow', 'GET, POST']]);
    }
    try {
      const projects = await identity.projects();
      if (!current()) return jsonReply(401, { error: 'unauthenticated' });
      let input: Record<string, unknown>;
      if (exchange.method === 'POST') {
        if (exchange.headers['content-type'] !== 'application/json') return jsonReply(415, { error: 'json_required' });
        let bytes: Uint8Array | undefined;
        try {
          bytes = await exchange.readBody(131_072);
          input = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        } catch (error) {
          if (error instanceof HttpBodyTooLarge) return jsonReply(413, { error: 'too_large' });
          throw error;
        } finally {
          bytes?.fill(0);
        }
      } else {
        const url = new URL(exchange.path, 'http://localhost');
        if ([...url.searchParams.keys()].some(key => key !== 'projectId') || url.searchParams.getAll('projectId').length > 1) {
          throw new EnvironmentError('invalid');
        }
        input = { projectId: url.searchParams.get('projectId') };
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['projectId', 'revision', 'variables'].includes(key))) {
        throw new EnvironmentError('invalid');
      }
      const projectId = input.projectId;
      if (projectId !== null && (typeof projectId !== 'string' || !projects.some(project => project.id === projectId))) {
        throw new EnvironmentError('invalid');
      }
      if (!current()) return jsonReply(401, { error: 'unauthenticated' });
      const scope = { projectId: projectId as string | null };
      const result = await (exchange.method === 'POST'
        ? this.environment.replace(account, scope, input.revision as number, input.variables, assertCurrent)
        : this.environment.list(account, scope, assertCurrent));
      // An asynchronous owner does not extend the original login's lifetime.
      // A completed mutation is neither replayed nor undone after revocation.
      if (!current()) return jsonReply(401, { error: 'unauthenticated' });
      return jsonReply(200, { ...result, projects });
    } catch (error) {
      if (!current()) return jsonReply(401, { error: 'unauthenticated' });
      if (error instanceof EnvironmentError || error instanceof GitVaultError) return jsonReply(error.status, { error: error.code });
      if (error instanceof SyntaxError) return jsonReply(400, { error: 'invalid' });
      return jsonReply(503, { error: 'unavailable' });
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse, identity: EnvironmentAccount): Promise<void> {
    await serveNodeHttpExchange(request, response, (exchange) => this.handleExchange(exchange, identity));
  }
}
