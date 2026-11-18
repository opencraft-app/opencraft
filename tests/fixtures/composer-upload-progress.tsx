import { WebSocketSendProgress } from "@opencraft/appserver-transport-websocket";
import React from "react";
import { createConversationKey } from "@opencraft/chat-core";
import { createComposerController, type ComposerAttachment } from "@opencraft/composer-core";
import { OpenCraftComposer, type AttachmentResolver } from "@opencraft/composer-editor";
import { attachmentPreviewSession } from "../../packages/composer-editor/src/attachment-preview-session";
import * as themes from "@opencraft/design-system/theme-engine";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";
let sequence = 0;
const controller = createComposerController({ type: "existing-thread", key: createConversationKey("local", "upload") }, { now: Date.now, createId: () => "draft-" + ++sequence });
const session = attachmentPreviewSession(controller);
const jobs = new Map<string, { report: Parameters<AttachmentResolver>[3]; finish: (v: ComposerAttachment) => void; fail: (e: Error) => void; pending: ComposerAttachment }>();
const resolver: AttachmentResolver = (file, pending, _signal, report) => new Promise((finish, fail) => jobs.set(file.name, { report, finish, fail, pending }));
const theme = (mode: "light" | "dark", palette: "neutral" | "frost" = "neutral") => {
 document.documentElement.dataset.theme = mode;
 const colors = palette === "frost" ? themes.frostThemePalette : themes.opencraftNeutralThemePalette;
 for (const [key, value] of Object.entries(themes.buildOpenCraftThemeCssProperties(mode, colors[mode]))) document.documentElement.style.setProperty(key, value);
};
theme("light");
Object.assign(window, {
 startSocketUpload: (url: string) => {
   const socket = new WebSocket(url), sender = new WebSocketSendProgress(socket);
   socket.addEventListener("open", () => sender.send("x".repeat(1024 * 1024), undefined, {
     onProgress: p => jobs.get("report.pdf")!.report?.({ loaded: Math.floor(8192 * p.loaded / p.total), total: 8192, source: "sent" }),
   }));
   socket.addEventListener("message", () => {
     const job = jobs.get("report.pdf")!;
     job.finish({ ...job.pending, uri: "file:///ready", lifecycle: "ready" });
     sender.dispose(); socket.close();
   });
   socket.addEventListener("close", () => sender.dispose());
 },
 theme,
 report: (name: string, loaded: number | null, source?: "sent" | "confirmed") => jobs.get(name)!.report?.(loaded === null ? null : { loaded, total: 8192, source }),
 finish: (name: string) => { const job = jobs.get(name)!; job.finish({ ...job.pending, uri: "file:///ready", lifecycle: "ready" }); },
 fail: (name: string) => jobs.get(name)!.fail(new Error("Upload interrupted")),
 add: () => {
   session.addFiles([new File([new Uint8Array(8192)], "report.pdf", { type: "application/pdf" }),
     new File(['<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#487060"/><path d="M0 70L30 20L80 80" fill="#baccca"/></svg>'], "photo.svg", { type: "image/svg+xml" })], resolver);
 },
});
createIntlTestRoot(document.getElementById("root")!).render(
 <main style={{ minHeight: "100dvh", padding: 12, background: "var(--color-background-primary)", color: "var(--color-text)" }}>
  <div style={{ maxWidth: 760, margin: "100px auto", position: "relative" }}>
   <OpenCraftComposer controller={controller} onResolveAttachment={resolver} onSubmit={() => false} />
  </div>
 </main>);
