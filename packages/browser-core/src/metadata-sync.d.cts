export interface BrowserMetadataLeaf { keyRevision: number; hash: string }
export type BrowserMetadataLeaves = Record<string, BrowserMetadataLeaf>;
export const BROWSER_METADATA_FIELDS: readonly string[];
export const PUSH_INLINE_LIMIT: number;
export function sha256(text: string): string;
export function canonical(value: unknown): string;
export function metadataLeafHash(key: string, value: string | undefined, hash?: (text: string) => string): string;
export function metadataRoot(leaves: BrowserMetadataLeaves, hash?: (text: string) => string): string;
export function metadataLeaves(values: Record<string, string> | undefined, keyRevisions: Record<string, number> | undefined, hash?: (text: string) => string): BrowserMetadataLeaves;
export function mergeMetadataValue(field: string, base: string | undefined, local: string | undefined, remote: string | undefined): string | undefined;
