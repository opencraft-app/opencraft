export function mergeBrowserMetadata(key: string, base: string | null, local: string | null, remote: string | null): string | null;
export interface BrowserMetadataRetirement { readonly lease?: string; readonly pageIds: readonly string[]; readonly tabIds: readonly string[] }
export function retireBrowserMetadata(key: string, value: string | null, retirements: readonly BrowserMetadataRetirement[] | BrowserMetadataRetirementLookup): string | null;
export interface BrowserMetadataRetirementLookup { readonly empty?: boolean; readonly pages: { has(id: string): boolean }; readonly tabs: { has(id: string): boolean }; readonly leases: { has(id: string): boolean } }
export interface BrowserMetadataReferences { pages: string[]; tabs: string[]; leases: string[] }
export function browserMetadataReferences(key: string, value: string | null): BrowserMetadataReferences;

export function canonical(value: unknown): string;
export function mergeMetadataValue(field: string, base: string | undefined, local: string | undefined, remote: string | undefined): string | undefined;
