import type { IncomingMessage, ServerResponse } from 'node:http';
import { HandsReviewExecutor } from './hands-client';
import { REVIEW_INPUT_LIMIT, SUPPORT_REVIEW_PATH, reviewAction, type ReviewExecutor } from './contract';
export { SUPPORT_REVIEW_PATH } from './contract';

interface ReviewIdentity { subject: string; loginName: string }
/** Vela plugin owns its route and business contract; Gateway never reads/spawns the worker. */
export class SupportReviewHttp {
  constructor(private readonly executor: ReviewExecutor = new HandsReviewExecutor()) {}
  route(request: IncomingMessage, response: ServerResponse, authority: {
    authenticate(request: IncomingMessage): ReviewIdentity | null;
    isAllowed(request: IncomingMessage): boolean;
  }): boolean {
    if (new URL(request.url ?? '/', 'http://opencraft.invalid').pathname !== SUPPORT_REVIEW_PATH) return false;
    const identity = authority.authenticate(request);
    if (!identity) {
      response.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end('{"error":"unauthenticated"}'); return true;
    }
    void this.handle(request, response, identity, () => authority.authenticate(request)?.subject === identity.subject && authority.isAllowed(request))
      .catch(() => {
        if (!response.destroyed && !response.writableEnded) {
          response.statusCode = 503; response.end(JSON.stringify({ error: request.method === 'POST' ? 'review_operation_result_unknown' : 'review_list_unavailable' }));
        }
      });
    return true;
  }
  async handle(request: IncomingMessage, response: ServerResponse, identity: { loginName: string }, current: () => boolean) {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'private, no-store'); response.setHeader('x-content-type-options', 'nosniff');
    const reply = (status: number, value: unknown) => { if (!response.destroyed && !response.writableEnded) { response.statusCode = status; response.end(JSON.stringify(value)); } };
    if (new URL(request.url ?? '/', 'http://opencraft.invalid').search) return reply(404, { error: 'missing' });
    if (request.method !== 'GET' && request.method !== 'POST') { response.setHeader('allow', 'GET, POST'); return reply(405, { error: 'method_not_allowed' }); }
    if (request.headers['sec-fetch-site'] === 'cross-site') return reply(403, { error: 'forbidden' });
    if (request.headers.origin !== undefined) {
      try {
        const origin = new URL(request.headers.origin);
        if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== request.headers.origin || origin.host !== request.headers.host) throw Error();
      } catch { return reply(403, { error: 'forbidden' }); }
    }
    if (!current()) return reply(403, { error: 'access_revoked' });
    let input: Record<string, unknown> = { action: 'list' };
    if (request.method === 'POST') {
      if (request.headers['x-lightvela-review'] !== '1') return reply(403, { error: 'review_intent_required' });
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const raw of request) { const chunk = Buffer.from(raw); bytes += chunk.length; if (bytes > REVIEW_INPUT_LIMIT) return reply(413, { error: 'request_too_large' }); chunks.push(chunk); }
      try { input = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; }
      catch { return reply(400, { error: 'invalid_json' }); }
      if (!input || typeof input !== 'object' || Array.isArray(input) || !reviewAction(input.action) || input.action === 'list') return reply(400, { error: 'unsupported_action' });
    }
    if (!current()) return reply(403, { error: 'access_revoked' });
    const result = await this.executor.execute({ ...input, action: String(input.action), actor: identity.loginName }, current);
    if (!current()) return reply(403, { error: 'access_revoked_result_not_disclosed' });
    if (!result) return reply(503, { error: request.method === 'POST' ? 'review_operation_result_unknown' : 'review_list_unavailable' });
    reply(result.ok ? 200 : result.error === 'Reviewer access required' ? 403 : 409,
      result.ok ? result.result : { error: result.error });
  }
}
