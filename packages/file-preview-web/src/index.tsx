import { builtinPreviewAdapters } from "./builtin-adapters";
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
  readonly styles?: string;
  render?(props: {active:boolean;dark:boolean;intl:FilePreviewIntl;download:boolean}): ReactNode;
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
    for (const adapter of builtinPreviewAdapters) this.register(adapter);
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

export const PreviewContext = createContext<FilePreviewService | null>(null);
const PreviewThemeContext=createContext(false);
export function useFilePreviewDark(){return useContext(PreviewThemeContext);}
const noPrepare = async (_signal?:AbortSignal):Promise<void> => {};
const PrepareContext = createContext<(signal?:AbortSignal)=>Promise<void>>(noPrepare);
export function usePrepareFilePreview() { return useContext(PrepareContext); }
const noSubscribe = (): (() => void) => () => undefined;
const noRevision = (): number => 0;
export function useFilePreviewAvailable(name: string): boolean {
  const service = useContext(PreviewContext);
  useSyncExternalStore(service?.subscribeAdapters ?? noSubscribe, service?.getAdapterRevision ?? noRevision, noRevision);
  return service?.supports(name) ?? false;
}
export function FilePreviewProvider({ service, children, prepare, dark = false }: { service: FilePreviewService | null; children: ReactNode; prepare?:(signal?:AbortSignal)=>Promise<void>;dark?:boolean }) {
  return <PreviewContext.Provider value={service}><PrepareContext.Provider value={prepare ?? noPrepare}><PreviewThemeContext.Provider value={dark}>{children}</PreviewThemeContext.Provider></PrepareContext.Provider></PreviewContext.Provider>;
}
export { FilePreviewView } from "./file-preview";
