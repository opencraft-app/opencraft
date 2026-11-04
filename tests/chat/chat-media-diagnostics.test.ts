import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { ChatMediaDiagnostic } from "@opencraft/chat-render-react";
import { mediaDiagnosticFields } from "../../apps/workbench-web/src/runtime/media-diagnostics";
import { FileBlobNetworkError, FileBlobReadError } from "../../apps/workbench-web/src/runtime/blob-files";
import { sanitizeEvent } from "../../packages/observability-contract/index.mjs";

const sample: ChatMediaDiagnostic = { documentId: "private-message-id", phase: "source", sourceKind: "file", transport: "host", outcome: "failed" };
const complete = (event: ChatMediaDiagnostic) => ({ schemaVersion: 1, component: "web", producerId: "test", eventId: "event", at: Date.now(),
  ...mediaDiagnosticFields(event), mediaDocumentId: createHash("sha256").update(event.documentId).digest("hex") });

test("media diagnostics preserve HTTP and RPC failure facts without exporting private data", () => {
  const error = new FileBlobReadError(403, true);
  const event = complete({ ...sample, error });
  const clean = sanitizeEvent({ ...event, url: "https://private.invalid/?token=secret", path: "/private/file.png", alt: "private text", error: { message: "secret" } });
  assert.equal(clean?.mediaPhase, "source");
  assert.equal(clean?.mediaHttpStatus, 403);
  assert.equal(clean?.mediaError, "http");
  assert.equal(clean?.mediaReadAttempts, 1);
  assert.equal(clean?.mediaRedirected, 1);
  assert.equal(clean?.mediaDocumentId, event.mediaDocumentId);
  assert.equal(sanitizeEvent(complete({ ...sample, contentType: "text/html; private-value" }))?.mediaContent, "html");
  assert.doesNotMatch(JSON.stringify(sanitizeEvent(complete({ ...sample, contentType: "text/html; private-value" }))), /private-value/);
  assert.doesNotMatch(JSON.stringify(clean), /private|secret|File download/);
  assert.equal(sanitizeEvent(complete({ ...sample, error: { code: -32000, message: "private path" } }))?.errorCode, "rpc:-32000");
  assert.equal(sanitizeEvent(complete({ ...sample, error: { code: Number.MAX_SAFE_INTEGER } }))?.errorCode, undefined);
});

test("policy failures, direct decode failures and successful loads remain distinguishable", () => {
  for (const phase of ["policy", "source", "decode"] as const) {
    for (const outcome of ["ok", "failed"] as const) {
      const clean = sanitizeEvent(complete({ ...sample, phase, outcome, transport: "direct", sourceKind: "external" }));
      assert.equal(clean?.mediaPhase, phase);
      assert.equal(clean?.outcome, outcome);
      assert.equal(clean?.mediaSource, "external");
      assert.equal(clean?.mediaTransport, "direct");
    }
  }
  assert.equal(sanitizeEvent({ ...complete(sample), mediaPhase: "private filename" }), null);
  assert.equal(sanitizeEvent(complete({ ...sample, phase: "policy", policy: "csp" }))?.mediaPolicy, "csp");
  assert.equal(sanitizeEvent({ ...complete(sample), mediaPolicy: "private directive" }), null);
  assert.equal(sanitizeEvent({ ...complete(sample), mediaHttpStatus: -1 }), null);
  assert.equal(sanitizeEvent({ ...complete(sample), mediaHttpStatus: 403.5 }), null);
  assert.equal(sanitizeEvent({ ...complete(sample), mediaDocumentId: "/private/file.png" }), null);
  assert.equal(sanitizeEvent(complete({ ...sample, error: new TypeError("private URL") }))?.mediaError, "type");
  assert.equal(sanitizeEvent(complete({ ...sample, error: new DOMException("private path", "AbortError") }))?.mediaError, "abort");
  assert.equal(sanitizeEvent({ ...complete(sample), mediaError: "private error" }), null);
  assert.equal(sanitizeEvent(complete({ ...sample, error: new FileBlobNetworkError("body", 3) }))?.mediaReadPhase, "body");
  assert.equal(sanitizeEvent(complete({ ...sample, readAttempts: 3 }))?.mediaReadAttempts, 3);
  assert.equal(sanitizeEvent(complete({ ...sample, readAttempts: 6 })), null);
});
