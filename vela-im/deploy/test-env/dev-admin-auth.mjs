#!/usr/bin/env node
// Dev-machine stand-in for ai-gateway's admin token check. gateway-dashboard validates its admin login with
// GET /api/admin/stats; this answers that one path for the configured token. Every other ai-gateway admin path answers
// 404, so pages that need a real AI Gateway show an error instead of fake data. Tokens are never logged.
import {timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';

const [host, port] = (process.env.ADMIN_AUTH_LISTEN ?? '127.0.0.1:18990').split(':');
const token = Buffer.from(readFileSync(process.env.ADMIN_TOKEN_FILE ?? '', 'utf8').trim());
if (token.length < 16) throw new Error('ADMIN_TOKEN_FILE is missing or too short');

const authorized = (header) => {
  const presented = Buffer.from(/^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1] ?? '');
  return presented.length === token.length && timingSafeEqual(presented, token);
};

createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://auth').pathname;
  const reply = (status, body) => {
    res.writeHead(status, {'content-type': 'application/json'});
    res.end(JSON.stringify(body));
  };
  if (!authorized(req.headers.authorization)) return reply(401, {error: 'unauthorized'});
  if (path === '/api/admin/stats') return reply(200, {});
  return reply(404, {error: '开发机没有 AI Gateway，这个页面不可用；请使用「IM 群聊」'});
}).listen(Number(port), host, () => console.log(`dev admin auth on http://${host}:${port}`));
