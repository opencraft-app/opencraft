export const isHermesWebTextResponse = (contentType: string) =>
  contentType.includes("text/html") ||
  contentType.includes("text/css") ||
  contentType.includes("javascript") ||
  contentType.includes("image/svg+xml");

const TAT_HERMES_WEB_HOST_PATTERN = "(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):9119";

const injectHermesProxyRuntime = (html: string, proxyBase: string) => {
  const runtime = `<script>
(() => {
  const base = ${JSON.stringify(`${proxyBase}/`)};
  const absoluteTargetPattern = /^https?:\\/\\/(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):9119(?=\\/|$)/i;
  const rewrite = (value) => {
    if (typeof value !== "string") return value;
    try {
      const parsed = new URL(value, window.location.href);
      if (parsed.pathname.startsWith(base)) return parsed.pathname + parsed.search + parsed.hash;
      if (absoluteTargetPattern.test(value)) {
        return base + parsed.pathname.replace(/^\\//, "") + parsed.search + parsed.hash;
      }
      if (parsed.origin === window.location.origin && parsed.pathname.startsWith("/") && !parsed.pathname.startsWith(base)) {
        return base + parsed.pathname.replace(/^\\//, "") + parsed.search + parsed.hash;
      }
    } catch {
      if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith(base)) {
        return base + value.slice(1);
      }
    }
    return value;
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === "string" || input instanceof URL) return originalFetch(rewrite(String(input)), init);
    if (input instanceof Request) return originalFetch(new Request(rewrite(input.url), input), init);
    return originalFetch(input, init);
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return originalOpen.call(this, method, rewrite(String(url)), ...rest);
  };
  const rewrittenAttributes = new Set(["src", "href", "action"]);
  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const normalizedName = String(name).toLowerCase();
    return originalSetAttribute.call(this, name, rewrittenAttributes.has(normalizedName) ? rewrite(String(value)) : value);
  };
  const patchUrlProperty = (prototype, property) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (!descriptor?.set || !descriptor?.get) return;
    Object.defineProperty(prototype, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        descriptor.set.call(this, rewrite(String(value)));
      },
    });
  };
  patchUrlProperty(HTMLScriptElement.prototype, "src");
  patchUrlProperty(HTMLImageElement.prototype, "src");
  patchUrlProperty(HTMLIFrameElement.prototype, "src");
  patchUrlProperty(HTMLLinkElement.prototype, "href");
  patchUrlProperty(HTMLAnchorElement.prototype, "href");
  patchUrlProperty(HTMLFormElement.prototype, "action");
  const OriginalEventSource = window.EventSource;
  if (OriginalEventSource) {
    window.EventSource = function(url, config) {
      return new OriginalEventSource(rewrite(String(url)), config);
    };
  }
})();
</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `<base href="${proxyBase}/">${runtime}</head>`);
  }
  return `<base href="${proxyBase}/">${runtime}${html}`;
};

export const rewriteHermesWebTextPayload = (text: string, contentType: string, proxyBase: string) => {
  let output = contentType.includes("text/html") ? injectHermesProxyRuntime(text, proxyBase) : text;
  const quotedAbsoluteTarget = new RegExp(`(["'\`])https?://${TAT_HERMES_WEB_HOST_PATTERN}(/[^"'\`\\s<)]*)?`, "gi");
  const bareAbsoluteTarget = new RegExp(`https?://${TAT_HERMES_WEB_HOST_PATTERN}(/[^"'\\s<)]*)?`, "gi");
  output = output
    .replace(quotedAbsoluteTarget, (_match, quote: string, path = "/") => `${quote}${proxyBase}${path}`)
    .replace(bareAbsoluteTarget, (_match, path = "/") => `${proxyBase}${path}`)
    .replace(/(href|src|action)=("|')\/(?!\/|__tat_hermes_proxy\/)/gi, `$1=$2${proxyBase}/`)
    .replace(/url\(\s*\/(?!\/|__tat_hermes_proxy\/)/gi, `url(${proxyBase}/`)
    .replace(/(["'`])\/(api|assets|static|dashboard-plugins|favicon|health|v1)([/"'`?])/gi, `$1${proxyBase}/$2$3`);
  return output;
};
