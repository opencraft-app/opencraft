import { createAnnotationOverlay } from "@opencraft/browser-preview-bridge/annotation-overlay";
import { SENSITIVE_CONTROL_PATTERN } from "@opencraft/browser-core";
import { createAnnotationPicker, createAnnotationSelectionRuntime } from "@opencraft/browser-preview-bridge";
import { annotationFrameAgent, type FrameAgentConfig } from "./frame-agent";

/** Expression that installs the agent; usable in a <script> or executeJavaScript. */
export function annotationAgentSource(config: Omit<FrameAgentConfig, "sensitivePattern">): string {
  const full: FrameAgentConfig = { ...config, sensitivePattern: SENSITIVE_CONTROL_PATTERN.source };
  // JSON in a script element: keep "</script>" and similar from closing it.
  const json = JSON.stringify(full).replace(/</g, "\\u003c");
  return `(${annotationFrameAgent.toString()})(window,(${createAnnotationPicker.toString()}),${json},(${createAnnotationOverlay.toString()}),(${createAnnotationSelectionRuntime.toString()}));`;
}

/** Inline <script> that installs the annotation agent in a sandboxed preview. */
export function annotationFrameScript(config: {
  readonly token: string;
  readonly parentOrigin: string;
  readonly previewAllowed?: boolean;
}): string {
  return `<script>${annotationAgentSource({ token: config.token, previewAllowed: config.previewAllowed === true, transport: { kind: "parent", parentOrigin: config.parentOrigin } })}</script>`;
}

/** Inserts the agent right after the CSP meta, before any page script runs. */
export function withAnnotationFrameAgent(documentHtml: string, script: string): string {
  const marker = /<meta http-equiv="Content-Security-Policy"[^>]*>/i.exec(documentHtml);
  if (!marker) return script + documentHtml;
  const end = marker.index + marker[0].length;
  return documentHtml.slice(0, end) + script + documentHtml.slice(end);
}
