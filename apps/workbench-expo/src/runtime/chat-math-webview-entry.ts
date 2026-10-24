import katex from "katex";
import "katex/dist/katex.min.css";

type RenderRequest = { type: "render"; revision: number; source: string; theme: "light" | "dark" };

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(value: string): void };
    __OPENCRAFT_MATH_RENDER__?: (value: unknown) => void;
  }
}

function send(value: object): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify(value));
}

function requestOf(value: unknown): RenderRequest | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Partial<RenderRequest>;
  if (candidate.type !== "render" || !Number.isSafeInteger(candidate.revision) || (candidate.revision ?? 0) < 1
    || typeof candidate.source !== "string" || candidate.source.length > 8_000
    || (candidate.theme !== "light" && candidate.theme !== "dark")) return null;
  return candidate as RenderRequest;
}

let latestRevision = 0;
window.__OPENCRAFT_MATH_RENDER__ = async value => {
  const request = requestOf(value);
  if (!request) return;
  latestRevision = request.revision;
  try {
    const host = document.getElementById("math");
    if (!host) throw new Error("Math host unavailable");
    document.documentElement.dataset.theme = request.theme;
    host.innerHTML = katex.renderToString(request.source, {
      displayMode: true,
      throwOnError: false,
      strict: false,
      trust: false,
      output: "htmlAndMathml",
    });
    await document.fonts.ready;
    if (latestRevision !== request.revision) return;
    const width = Math.ceil(host.scrollWidth);
    const height = Math.ceil(host.scrollHeight);
    if (!(width > 0 && height > 0)) throw new Error("Math size unavailable");
    send({ type: "rendered", revision: request.revision, width, height });
  } catch {
    if (latestRevision === request.revision) send({ type: "failed", revision: request.revision });
  }
};
send({ type: "ready" });
