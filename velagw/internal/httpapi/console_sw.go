package httpapi

const consoleServiceWorkerJS = `const CONSOLE_PREFIX = '/_llmgateway_console/';
const clientSets = new Map();

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'llmgateway-console-set' || !data.setId || !event.source || !event.source.id) return;
  clientSets.set(event.source.id, String(data.setId));
});

self.addEventListener('fetch', (event) => {
  event.respondWith(handleConsoleFetch(event));
});

async function handleConsoleFetch(event) {
  try {
    const requestUrl = new URL(event.request.url);
    const pathSet = parseSetId(requestUrl.href);

    if (pathSet) {
      if (event.clientId) clientSets.set(event.clientId, pathSet);
      return fetch(await withSetHeader(event.request, event.request.url, pathSet));
    }

    if (!shouldRewrite(requestUrl.pathname, event.request.mode)) {
      return fetch(event.request);
    }

    const setId = await inferSetId(event);
    if (!setId) {
      console.warn('[llmgateway] service worker could not infer set for request', {
        method: event.request.method,
        url: event.request.url,
        referer: event.request.headers.get('referer') || '',
      });
      return fetch(event.request);
    }

    const rewritten = new URL(event.request.url);
    rewritten.pathname = CONSOLE_PREFIX + encodeURIComponent(setId) + requestUrl.pathname;
    return fetch(await withSetHeader(event.request, rewritten.href, setId));
  } catch (error) {
    console.error('[llmgateway] service worker fetch failed', {
      method: event.request.method,
      url: event.request.url,
      referer: event.request.headers.get('referer') || '',
      error: String(error && error.message ? error.message : error),
    });
    return new Response(JSON.stringify({
      success: false,
      message: 'llmgateway service worker fetch failed: ' + String(error && error.message ? error.message : error),
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function inferSetId(event) {
  if (event.clientId) {
    const client = await clients.get(event.clientId);
    if (client && client.url) {
      const fromClient = parseSetId(client.url);
      if (fromClient) {
        clientSets.set(event.clientId, fromClient);
        return fromClient;
      }
    }
    const remembered = clientSets.get(event.clientId);
    if (remembered) return remembered;
  }

  const referer = event.request.headers.get('referer');
  if (referer) {
    const fromReferer = parseSetId(referer);
    if (fromReferer) return fromReferer;
  }

  return '';
}

function parseSetId(value) {
  try {
    const url = value.startsWith('http') ? new URL(value) : new URL(value, self.location.origin);
    const querySet = url.searchParams.get('llmgateway_console_set');
    if (querySet) return querySet;
    const path = url.pathname;
    const match = path.match(/^\/_llmgateway_console\/([^/]+)(?:\/|$)/);
    return match ? decodeURIComponent(match[1]) : '';
  } catch (_) {
    return '';
  }
}

function shouldRewrite(pathname, mode) {
  if (mode === 'navigate') {
    return !pathname.startsWith('/admin')
      && pathname !== '/console-sw.js'
      && !pathname.startsWith(CONSOLE_PREFIX);
  }
  return pathname.startsWith('/api/')
    || pathname === '/api'
    || pathname.startsWith('/static/')
    || pathname === '/logo.png'
    || pathname === '/favicon.ico'
    || pathname === '/manifest.json'
    || pathname.startsWith('/oauth/');
}

async function withSetHeader(request, url, setId) {
  const headers = new Headers(request.headers);
  headers.set('X-LLMGateway-Set', setId);
  const init = {
    method: request.method,
    headers,
    credentials: request.credentials,
    cache: request.cache,
    redirect: request.redirect,
    referrer: request.referrer,
    integrity: request.integrity,
  };
  if (request.mode !== 'navigate') {
    init.mode = request.mode;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.clone().arrayBuffer();
  }
  return new Request(url, init);
}
`
