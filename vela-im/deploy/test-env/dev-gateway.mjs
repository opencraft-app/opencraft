#!/usr/bin/env node
// Dev-machine stand-in for LightVela service-gateway on route /v1/collaboration.
// Human requests: the LightVela session token is checked against /auth/profile, then forwarded to collaboration with
// the internal gateway bearer and the trusted X-Lightclaw-User-ID. Bot runtime requests carry their own credentials.
// Client-supplied identity headers are always dropped. Tokens are never logged.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer, request as httpRequest} from 'node:http';

const PREFIX = '/v1/collaboration/';
const HUMAN = /^\/v1\/collaboration\/me(\/|$)/;
const RUNTIME = /^\/v1\/collaboration\/runtime\//;
const USER_ID = /^usr_[A-Za-z0-9_-]{1,60}$/;
const PROFILE_TTL_MS = 60_000;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

const [host, port] = (process.env.GATEWAY_LISTEN ?? '127.0.0.1:18786').split(':');
const upstream = new URL(process.env.COLLABORATION_URL ?? 'http://127.0.0.1:18791');
const authBase = process.env.LIGHTVELA_AUTH_URL ?? 'https://api.lightvela.com';
const gatewayToken = readFileSync(process.env.GATEWAY_TOKEN_FILE ?? '', 'utf8').trim();
if (gatewayToken.length < 16) throw new Error('GATEWAY_TOKEN_FILE is missing or too short');

const profiles = new Map();

async function lightVelaUser(authorization) {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
  if (!token) return null;
  const key = createHash('sha256').update(token).digest('hex');
  const cached = profiles.get(key);
  if (cached && cached.expires > Date.now()) return cached.userID;
  const response = await fetch(new URL('/auth/profile', authBase), {
    headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'},
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    profiles.delete(key);
    return null;
  }
  const userID = (await response.json().catch(() => null))?.user?.id;
  if (typeof userID !== 'string' || !USER_ID.test(userID)) {
    console.error('auth/profile returned a user without a usr_ id');
    return null;
  }
  if (profiles.size > 1000) profiles.clear();
  profiles.set(key, {userID, expires: Date.now() + PROFILE_TTL_MS});
  return userID;
}

function forwardHeaders(incoming) {
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'cookie' || lower.startsWith('x-lightclaw-')) continue;
    headers[lower] = value;
  }
  return headers;
}

function reply(res, status, code, message) {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify({error: {code, message}}));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://gateway');
  if (url.pathname === '/healthz') return reply(res, 200, 'ok', 'ok');
  const human = HUMAN.test(url.pathname);
  if (!human && !RUNTIME.test(url.pathname)) return reply(res, 404, 'not_found', 'route not found');
  const headers = forwardHeaders(req.headers);
  if (human) {
    let userID = null;
    try {
      userID = await lightVelaUser(req.headers.authorization);
    } catch (error) {
      console.error('auth/profile request failed:', error?.message ?? error);
      return reply(res, 502, 'auth_unavailable', 'LightVela auth is unavailable');
    }
    if (!userID) return reply(res, 401, 'unauthenticated', 'LightVela session is invalid');
    headers.authorization = `Bearer ${gatewayToken}`;
    headers['x-lightclaw-user-id'] = userID;
  }
  headers['x-forwarded-for'] = req.socket.remoteAddress ?? '';
  const target = new URL(`/v1/${url.pathname.slice(PREFIX.length)}${url.search}`, upstream);
  const proxied = httpRequest(target, {method: req.method, headers}, (upstreamResponse) => {
    const responseHeaders = forwardHeaders(upstreamResponse.headers);
    res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(res);
  });
  proxied.on('error', (error) => {
    console.error('collaboration request failed:', error.message);
    if (!res.headersSent) reply(res, 502, 'upstream_unavailable', 'collaboration is unavailable');
    else res.destroy();
  });
  req.pipe(proxied);
}).listen(Number(port), host, () => console.log(`dev gateway on http://${host}:${port}${PREFIX} -> ${upstream.origin}/v1/`));
