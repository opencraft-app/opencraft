export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.origin !== env.PREVIEW_PUBLIC_ORIGIN && url.origin !== env.PREVIEW_CUSTOM_ORIGIN)
      return new Response(null, { status: 404 });
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin) return new Response(null, { status: 403 });

    const target = new URL(env.PREVIEW_TARGET_ORIGIN);
    target.pathname = url.pathname;
    target.search = url.search;
    const forward = new Request(target, request);
    if (origin !== null) forward.headers.set("origin", target.origin);
    const response = await env.PREVIEW_TARGET.fetch(forward);
    const location = response.headers.get("location");
    if (!location || response.status < 300 || response.status >= 400) return response;
    const redirect = new URL(location, target);
    if (redirect.origin !== target.origin || (location.startsWith("/") && !location.startsWith("//"))) return response;
    url.pathname = redirect.pathname;
    url.search = redirect.search;
    url.hash = redirect.hash;
    const headers = new Headers(response.headers);
    headers.set("location", url.href);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
