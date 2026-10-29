import type { IncomingMessage, ServerResponse } from 'node:http';
import { AccountEnvironment, EnvironmentError } from './account-environment.js';
import { GitVaultError } from './employee-git-vault-store.js';

export interface EnvironmentAccount {
  account: string;
  current(): boolean;
  projects(): Promise<readonly { id: string; name: string }[]>;
}
/** Trusted product ingress owns authentication/admission and supplies the account.
 * No administrator read, account selector, decrypted diagnostic, or value export. */
export class AccountEnvironmentHttp {
  constructor(private readonly environment: AccountEnvironment) {}
  async handle(request: IncomingMessage, response: ServerResponse, identity: EnvironmentAccount): Promise<void> {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    const reply = (status: number, body: unknown) => { if (!response.writableEnded) { response.statusCode = status; response.end(JSON.stringify(body)); } };
    const current = () => identity.current() && request.headers['x-opencraft-account-scope'] === identity.account;
    if (!current()) { reply(401, { error: 'unauthenticated' }); return; }
    if (request.headers['sec-fetch-site'] === 'cross-site') { reply(403, { error: 'forbidden' }); return; }
    if (request.headers.origin !== undefined) {
      try {
        const origin = new URL(String(request.headers.origin));
        if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== request.headers.origin || origin.host !== request.headers.host) throw new Error();
      } catch { reply(403, { error: 'forbidden' }); return; }
    }
    if (!['GET', 'POST'].includes(request.method ?? '')) { response.setHeader('allow', 'GET, POST'); reply(405, { error: 'method_not_allowed' }); return; }
    try {
      const projects = await identity.projects();
      if (!current()) { reply(401, { error: 'unauthenticated' }); return; }
      let input: Record<string, unknown>;
      if (request.method === 'POST') {
        if (request.headers['content-type'] !== 'application/json') { reply(415, { error: 'json_required' }); return; }
        let length = 0; const chunks: Buffer[] = [];
        try {
          for await (const chunk of request) {
            length += Buffer.byteLength(chunk);
            if (length > 131_072) { reply(413, { error: 'too_large' }); return; }
            chunks.push(Buffer.from(chunk));
          }
          const bytes = Buffer.concat(chunks);
          try { input = JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); }
        } finally { for (const chunk of chunks) chunk.fill(0); }
      } else {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if ([...url.searchParams.keys()].some(key => key !== 'projectId') || url.searchParams.getAll('projectId').length > 1) throw new EnvironmentError('invalid');
        input = { projectId: url.searchParams.get('projectId') };
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['projectId', 'revision', 'variables'].includes(key))) throw new EnvironmentError('invalid');
      const projectId = input.projectId;
      if (projectId !== null && (typeof projectId !== 'string' || !projects.some(project => project.id === projectId))) throw new EnvironmentError('invalid');
      if (!current()) { reply(401, { error: 'unauthenticated' }); return; }
      const scope = { projectId: projectId as string | null };
      const result = request.method === 'POST'
        ? this.environment.replace(identity.account, scope, input.revision as number, input.variables)
        : this.environment.list(identity.account, scope);
      reply(200, { ...result, projects });
    } catch (error) {
      if (error instanceof EnvironmentError || error instanceof GitVaultError) reply(error.status, { error: error.code });
      else if (error instanceof SyntaxError) reply(400, { error: 'invalid' });
      else reply(503, { error: 'unavailable' });
    }
  }
}
