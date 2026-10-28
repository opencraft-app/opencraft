import "./preview.web.scss";
import { Service, type Context } from "@deepseek-ai/cordis";
import { FilePreviewError, MAX_FILE_PREVIEW_BYTES, PreviewSessionPool, type PreviewLease } from "@opencraft/file-preview-core";
import { createContext, useContext, useEffect, useState, useRef, useSyncExternalStore, useCallback, useMemo, type ReactNode } from "react";
import type { IntlShape } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";

export { FilePreviewError } from "@opencraft/file-preview-core";
export { MAX_FILE_PREVIEW_BYTES } from "@opencraft/file-preview-core";
export { previewLinkTarget, bindPreviewLinks } from "./links";

export type FilePreviewIntl = Pick<IntlShape, "formatMessage" | "formatNumber">;

export interface WebPreviewDocument {
  readonly element: HTMLElement;
  setActive?(active: boolean): void;
  setTheme?(dark: boolean): void;
  setOpenLink?(open: ((url: string) => void) | undefined): void;
  setIntl?(intl: FilePreviewIntl): void;
  subscribeFailure?(listener: (error: unknown) => void): () => void;
  dispose(): void;
}
export interface FilePreviewAdapter {
  readonly id: string;
  readonly extensions: readonly string[];
  open(input: { blob: Blob; name: string; signal: AbortSignal }): Promise<WebPreviewDocument>;
}
export interface FilePreviewInput {
  readonly ownerId: string;
  readonly tabId: string;
  readonly resource: string;
  readonly blob: Blob;
  readonly name: string;
}
export function filePreviewExtension(name: string): string | null {
  const extension = /\.([a-z0-9]+)$/iu.exec(name)?.[1]?.toLowerCase();
  return extension ?? null;
}
export function officeFileKind(name: string): "doc" | "docx" | "pptx" | "xlsx" | "xls" | "xlsm" | null {
  const extension = filePreviewExtension(name);
  return extension === "doc" || extension === "docx" || extension === "pptx" || extension === "xlsx" || extension === "xls" || extension === "xlsm" ? extension : null;
}
declare module "@deepseek-ai/cordis" { interface Context { filePreviews: FilePreviewService } }

/** Trusted built-in boundary; this is not the public third-party Extension ABI. */
export class FilePreviewService extends Service {
  private readonly pool = new PreviewSessionPool<WebPreviewDocument>();
  private readonly revisions = new WeakMap<Blob, number>();
  private nextRevision = 0;
  private adapters = new Map<string, { adapter: FilePreviewAdapter; generation: number }>();
  private nextAdapter = 0;
  private readonly adapterListeners = new Set<() => void>();
  private adapterRevision = 0;
  readonly subscribeAdapters = (listener: () => void): (() => void) => {
    this.adapterListeners.add(listener);
    return () => this.adapterListeners.delete(listener);
  };
  readonly getAdapterRevision = (): number => this.adapterRevision;
  private notifyAdapters(): void {
    this.adapterRevision++;
    for (const listener of this.adapterListeners) listener();
  }
  constructor(ctx: Context) {
    super(ctx, "filePreviews");
    ctx.effect(() => () => { this.pool.dispose(); this.adapters.clear(); this.notifyAdapters(); this.adapterListeners.clear(); });
  }
  register(adapter: FilePreviewAdapter): () => void {
    if (this.adapters.has(adapter.id)) throw new Error("Preview adapter already registered");
    const registration = { adapter, generation: ++this.nextAdapter };
    this.adapters.set(adapter.id, registration);
    this.notifyAdapters();
    return () => {
      if (this.adapters.get(adapter.id) !== registration) return;
      this.adapters.delete(adapter.id);
      this.pool.releaseAdapter(`${adapter.id}:${registration.generation}`);
      this.notifyAdapters();
    };
  }
  acquire(input: FilePreviewInput, attempt = 0): PreviewLease<WebPreviewDocument> {
    const extension = filePreviewExtension(input.name);
    const match = [...this.adapters.values()].find(({ adapter }) => extension && adapter.extensions.includes(extension));
    if (!match) throw new Error("Preview adapter unavailable");
    if (input.blob.size > MAX_FILE_PREVIEW_BYTES) throw new FilePreviewError("too-large");
    let revision = this.revisions.get(input.blob);
    if (revision === undefined) { revision = ++this.nextRevision; this.revisions.set(input.blob, revision); }
    return this.pool.acquire({ ownerId: input.ownerId, tabId: input.tabId, resource: input.resource,
      revision: `${revision}:${attempt}`, adapter: `${match.adapter.id}:${match.generation}` }, input.blob.size,
    signal => match.adapter.open({ blob: input.blob, name: input.name, signal }));
  }
  releaseTab(ownerId: string, tabId: string): void { this.pool.releaseTab(ownerId, tabId); }
  supports(name: string): boolean {
    const extension = filePreviewExtension(name);
    return extension !== null && [...this.adapters.values()].some(({ adapter }) => adapter.extensions.includes(extension));
  }
}

const PreviewContext = createContext<FilePreviewService | null>(null);
const noSubscribe = (): (() => void) => () => undefined;
const noRevision = (): number => 0;
export function useFilePreviewAvailable(name: string): boolean {
  const service = useContext(PreviewContext);
  useSyncExternalStore(service?.subscribeAdapters ?? noSubscribe, service?.getAdapterRevision ?? noRevision, noRevision);
  return service?.supports(name) ?? false;
}
export function FilePreviewProvider({ service, children }: { service: FilePreviewService | null; children: ReactNode }) {
  return <PreviewContext.Provider value={service}>{children}</PreviewContext.Provider>;
}
export function FilePreviewView(props: FilePreviewInput & { active?: boolean; dark: boolean; onOpenLink?(url: string): void; prepare(signal?: AbortSignal): Promise<void> }) {
  const service = useContext(PreviewContext);
  const intl = useIntl();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ request: object; lease?: PreviewLease<WebPreviewDocument>; failure?: unknown } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const { ownerId, tabId, resource, blob, name, prepare } = props;
  const request = useMemo(() => ({}), [service, ownerId, tabId, resource, blob, name, attempt, prepare]);
  const lease = result?.request === request ? result.lease ?? null : null;
  const failed = result?.request === request && result.failure;
  useEffect(() => {
    let active = true;
    let acquired: PreviewLease<WebPreviewDocument> | undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    void prepare(controller.signal).then(() => {
      if (!active) return;
      acquired = service?.acquire({ ownerId, tabId, resource, blob, name }, attempt);
      if (!acquired) throw new Error("Preview service unavailable");
      setResult({ request, lease: acquired });
    }).catch(error => { if (active) setResult({ request, failure: controller.signal.aborted ? new FilePreviewError("timeout") : error }); }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); acquired?.release(); };
  }, [service, ownerId, tabId, resource, blob, name, attempt, prepare, request]);
  const subscribe = useCallback((listener: () => void) => lease?.subscribe(listener) ?? (() => {}), [lease]);
  const getSnapshot = useCallback(() => lease?.getSnapshot() ?? null, [lease]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const document = snapshot?.phase === "ready" ? snapshot.document : null;
  useEffect(() => {
    if (!document || !root.current) return;
    const container = root.current;
    container.replaceChildren(document.element);
    return () => { document.setActive?.(false); document.element.remove(); };
  }, [document]);
  useEffect(() => { document?.setActive?.(props.active !== false); }, [document, props.active]);
  useEffect(() => { document?.setTheme?.(props.dark); }, [document, props.dark]);
  useEffect(() => { document?.setIntl?.(intl); }, [document, intl]);
  useEffect(() => { document?.setOpenLink?.(props.onOpenLink); return () => document?.setOpenLink?.(undefined); }, [document, props.onOpenLink]);
  const reason = snapshot?.phase === "failed" ? snapshot.error : failed;
  const error = failed || snapshot?.phase === "failed" || snapshot?.phase === "released";
  const errorMessage = reason instanceof FilePreviewError ? {
    "too-large": { id: "preview.tooLarge", defaultMessage: "This file is too large to preview (25 MB limit). Download it to view." },
    encrypted: { id: "preview.encrypted", defaultMessage: "Password-protected files cannot be previewed. Download it to open with its password." },
    invalid: { id: "preview.invalid", defaultMessage: "This file is damaged or its contents do not match the format. Download the original to check it." },
    timeout: { id: "preview.timeout", defaultMessage: "Opening took too long. Try again or download the original file." },
    busy: { id: "preview.busy", defaultMessage: "Close another document preview, then try again." },
  }[reason.code] : { id: "office.failed", defaultMessage: "This document could not be displayed. You can download the original file." };
  return <div className="file-preview" data-file-preview-phase={document ? "ready" : error ? "failed" : "opening"}>
    <div ref={root} className="file-preview__document" hidden={!document} />
    {!document ? <div className="workspace-file-viewer__state" role="status">
      <span>{error
        ? intl.formatMessage(errorMessage)
        : intl.formatMessage({ id: "office.loading", defaultMessage: "Opening document…" })}</span>
      {error ? <button type="button" onClick={() => setAttempt(value => value + 1)}>{intl.formatMessage({ id: "common.retry", defaultMessage: "Try again" })}</button> : null}
    </div> : null}
  </div>;
}
