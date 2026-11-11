import type { ChatMediaDiagnostic } from "@opencraft/chat-render-react";
import { FileBlobNetworkError, FileBlobReadError } from "./blob-files";
import { observeEvent, subscribeObservationEnabled } from "./observability";

/** Only closed diagnostic vocabulary leaves the page; no URLs, paths, alt text or error messages. */
export function mediaDiagnosticFields(event: ChatMediaDiagnostic) {
  const content = event.contentType?.toLowerCase();
  const error = event.error;
  const mediaError = error == null ? "none" : error instanceof FileBlobReadError ? "http"
    : error instanceof TypeError ? "type" : error instanceof DOMException ? (error.name === "AbortError" ? "abort" : "dom")
    : typeof error === "object" && "code" in error ? "rpc" : "other";
  return { kind: "client_signal", clientSignal: "chat_media", measurementScope: "client",
    mediaPhase: event.phase, mediaSource: event.sourceKind, mediaTransport: event.transport, outcome: event.outcome,
    mediaContent: !content ? "unknown" : content.startsWith("image/") ? "image" : content.startsWith("text/html") ? "html" : "other", mediaError,
    ...(event.policy ? { mediaPolicy: event.policy } : {}),
    ...(event.readAttempts === undefined ? {} : { mediaReadAttempts: event.readAttempts }),
    ...(error instanceof FileBlobReadError || error instanceof FileBlobNetworkError ? { mediaReadAttempts: error.attempts } : {}),
    ...(error instanceof FileBlobNetworkError ? { mediaReadPhase: error.phase } : {}),
    ...(event.error instanceof FileBlobReadError ? { mediaHttpStatus: event.error.httpStatus, mediaRedirected: event.error.redirected ? 1 : 0 } : {}),
    ...(typeof event.error === "object" && event.error !== null && "code" in event.error
      && typeof event.error.code === "number" && Number.isSafeInteger(event.error.code)
      && Math.abs(event.error.code) <= 9_999_999_999
      ? { errorCode: `rpc:${event.error.code}` } : {}) };
}

let ready = false;
const early: ChatMediaDiagnostic[] = [];
subscribeObservationEnabled(() => {
  ready = true;
  for (const event of early.splice(0)) observeChatMediaDiagnostic(event);
});

export function observeChatMediaDiagnostic(event: ChatMediaDiagnostic): void {
  if (!ready) { if (early.length < 32) early.push(event); return; }
  // Native message IDs have high entropy. Hash the identity for exact-document
  // correlation; the transport never receives the message ID itself.
  void crypto.subtle.digest("SHA-256", new TextEncoder().encode(event.documentId)).then(digest => {
    const mediaDocumentId = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    observeEvent({ ...mediaDiagnosticFields(event), mediaDocumentId });
  }).catch(() => { /* Diagnostics never change image loading or retry behavior. */ });
}
