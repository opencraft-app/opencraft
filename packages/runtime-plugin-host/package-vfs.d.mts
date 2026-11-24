export interface PackageFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export const PACKAGE_MANIFEST: string;
export function packageDigest(bytes: Uint8Array): Promise<string>;
export function encodePackageManifest(files: readonly PackageFile[]): Uint8Array;
export function openPackageVfs(options: {
  readonly sha256: string;
  readFile(path: string, maxBytes: number): Uint8Array | Promise<Uint8Array>;
}): Promise<Readonly<{
  listFiles(): string[];
  readFile(path: string): Uint8Array;
}>>;
