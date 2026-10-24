import mermaid from "mermaid";
import { prepareMermaidSource } from "@opencraft/chat-render-react";

type RenderRequest = { type: "render"; revision: number; source: string; theme: "light" | "dark"; interactive: boolean };

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(value: string): void };
    __OPENCRAFT_MERMAID_RENDER__?: (value: unknown) => void;
  }
}

function send(value: object): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify(value));
}

function requestOf(value: unknown): RenderRequest | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Partial<RenderRequest>;
  if (candidate.type !== "render" || !Number.isSafeInteger(candidate.revision) || (candidate.revision ?? 0) < 1
    || typeof candidate.source !== "string" || candidate.source.length > 15_000
    || (candidate.theme !== "light" && candidate.theme !== "dark")
    || typeof candidate.interactive !== "boolean") return null;
  return candidate as RenderRequest;
}

let latestRevision = 0;
let pending: RenderRequest | null = null;
let rendering = false;

async function drain(): Promise<void> {
  if (rendering) return;
  rendering = true;
  try {
    while (pending !== null) {
      const request = pending;
      pending = null;
      try {
        const source = prepareMermaidSource(request.source);
        if (!source) throw new Error("Empty diagram");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: request.theme === "dark" ? "dark" : "default",
          maxTextSize: 15_000,
          maxEdges: 500,
          flowchart: { htmlLabels: false },
          class: { htmlLabels: false },
        });
        const result = await mermaid.render(`opencraft-native-mermaid-${request.revision}`, source);
        if (latestRevision !== request.revision) continue;
        const host = document.getElementById("diagram");
        if (!host) throw new Error("Diagram host unavailable");
        host.innerHTML = result.svg;
        const svg = host.querySelector("svg");
        if (!svg) throw new Error("Diagram image unavailable");
        const box = svg.viewBox.baseVal;
        const width = Math.ceil(box.width || svg.getBoundingClientRect().width);
        const height = Math.ceil(box.height || svg.getBoundingClientRect().height);
        if (!(width > 0 && height > 0)) throw new Error("Diagram size unavailable");
        document.documentElement.style.overflow = request.interactive ? "auto" : "hidden";
        document.body.style.overflow = request.interactive ? "auto" : "hidden";
        svg.style.maxWidth = request.interactive ? "none" : "100%";
        svg.style.width = request.interactive ? `${width}px` : "100%";
        svg.style.height = "auto";
        send({ type: "rendered", revision: request.revision, width, height });
      } catch {
        if (latestRevision === request.revision) send({ type: "failed", revision: request.revision });
      }
    }
  } finally {
    rendering = false;
  }
}

window.__OPENCRAFT_MERMAID_RENDER__ = value => {
  const request = requestOf(value);
  if (request === null) return;
  latestRevision = request.revision;
  pending = request;
  void drain();
};
send({ type: "ready" });
