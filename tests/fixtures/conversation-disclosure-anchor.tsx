import { WebConversationViewportOwner, setTimelineDiagnosticObserver } from "@opencraft/timeline-host-web";

// Test-only observer: actual projection, renderer, disclosure and virtualization.
const probe = window as any;
probe.disclosureDiagnostics = [];
const listener = WebConversationViewportOwner.prototype.setMeasurementListener;
WebConversationViewportOwner.prototype.setMeasurementListener = function (next) {
  probe.disclosureOwner = this;
  return listener.call(this, next);
};
if (!new URLSearchParams(location.search).has("diagnosticsOff")) setTimelineDiagnosticObserver(
  (kind, fields) => probe.disclosureDiagnostics.push({ at: performance.now(), kind, fields }),
);
await import("./reasoning-disclosure");
