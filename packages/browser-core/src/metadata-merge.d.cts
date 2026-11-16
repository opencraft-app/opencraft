export function mergeBrowserMetadata(key: string, base: string | null, local: string | null, remote: string | null): string | null;
export interface BrowserMetadataRetirement { readonly lease: string; readonly pageIds: readonly string[]; readonly tabIds: readonly string[] }
export function retireBrowserMetadata(key: string, value: string | null, retirements: readonly BrowserMetadataRetirement[]): string | null;
