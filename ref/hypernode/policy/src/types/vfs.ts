export interface VfsMetadata {
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  createdAtMs: number;
  modifiedAtMs: number;
}

export interface VfsDirectoryEntry {
  fileName: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface VfsLookup {
  path: string;
  node: VfsNode;
}

export interface VfsBaseNode {
  createdAtMs: number;
  modifiedAtMs: number;
}

export interface VfsDirectoryNode extends VfsBaseNode {
  type: "directory";
}

export interface VfsFileNode extends VfsBaseNode {
  type: "file";
  data: number[];
}

export type VfsNode = VfsDirectoryNode | VfsFileNode;
export type VfsChangeListener = (paths: string[]) => void;

export interface MemoryVfsPort {
  normalize(path: string): string;
  parent(path: string): string | null;
  basename(path: string): string;
  get(path: string): VfsLookup;
  metadata(path: string): VfsMetadata;
  onChange(listener: VfsChangeListener): () => boolean;
  createDirectory(path: string, recursive?: boolean): void;
  writeFile(path: string, data: ArrayLike<number>): void;
  readFile(path: string): number[];
  readDirectory(path: string): VfsDirectoryEntry[];
  remove(path: string, recursive?: boolean, force?: boolean): void;
  copy(sourcePath: string, destinationPath: string, recursive?: boolean): void;
}
