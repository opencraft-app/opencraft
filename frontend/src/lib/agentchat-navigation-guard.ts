'use client';

// AgentChat imports third-party side-effect CSS into the current document.
// Once that CSS is injected, Next.js client navigation will keep it alive
// across route changes, so returning to public marketing/docs pages must use a
// full document reload to get a clean stylesheet graph.
let agentChatLoadedInDocument = false;

const PUBLIC_SITE_PATH_PATTERNS = [
  /^\/$/,
  /^\/(?:en-us|zh-cn|zh-sg)\/?$/,
  /^\/changelog\/?$/,
  /^\/docs(?:\/|$)/,
  /^\/about\/?$/,
  /^\/(?:en-us|zh-cn|zh-sg)\/docs(?:\/|$)/,
  /^\/(?:en-us|zh-cn|zh-sg)\/about\/?$/,
] as const;

export function markAgentChatLoadedInDocument() {
  agentChatLoadedInDocument = true;
}

export function hasAgentChatLoadedInDocument() {
  return agentChatLoadedInDocument;
}

export function isPublicSiteDocumentPath(pathname: string) {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return PUBLIC_SITE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function shouldReloadForAgentChatNavigation(href: string) {
  if (!agentChatLoadedInDocument) return false;
  if (typeof window === 'undefined') return false;

  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) return false;

  return isPublicSiteDocumentPath(url.pathname);
}
