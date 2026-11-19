export interface BrowserTabPresentation { readonly version: 1; readonly document: string; readonly revision: string; readonly updatedAt: number; readonly thumbnail: string | null; readonly favicon: string | null; }
export declare const PRESENTATION_VERSION: 1;
export declare const THUMBNAIL_LIMIT: number;
export declare const FAVICON_LIMIT: number;
export declare function readPresentation(value: unknown): BrowserTabPresentation | null;
