import type { TatHttpVirtualClient } from "../lib/tat-http-virtual-client";
import { throwIfSignalAborted } from "@opencraft/workbench-runtime";

export interface HermesHostFileMetadata {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymlink: boolean;
  readonly createdAtMs: number;
  readonly modifiedAtMs: number;
}

export interface HermesHostDirectoryEntry {
  readonly fileName: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
}

export interface HermesHostFileSystem {
  readonly codexHome: string;
  getMetadata(path: string, signal?: AbortSignal): Promise<HermesHostFileMetadata>;
  readDirectory(path: string): Promise<{ readonly entries: readonly HermesHostDirectoryEntry[] }>;
  readFile(path: string, signal?: AbortSignal): Promise<{ readonly dataBase64: string }>;
  writeFile(path: string, dataBase64: string): Promise<void>;
  dispose(): void;
}

type JsonHttpClient = Pick<TatHttpVirtualClient, "fetchJson" | "close">;

interface HermesFsListEntry {
  readonly name: string;
  readonly path?: string;
  readonly isDirectory: boolean;
}

interface HermesFsListResponse {
  readonly entries?: readonly HermesFsListEntry[];
  readonly error?: string;
}

interface HermesManagedFileEntry {
  readonly name: string;
  readonly is_directory: boolean;
}

interface HermesManagedFileListResponse {
  readonly entries?: readonly HermesManagedFileEntry[];
}

const encodePath = (path: string) => encodeURIComponent(path);

const parentAndName = (path: string) => {
  const normalized = path.length > 1 ? path.replace(/\/+$/u, "") : path;
  const separator = normalized.lastIndexOf("/");
  return {
    parent: separator <= 0 ? "/" : normalized.slice(0, separator),
    name: normalized.slice(separator + 1),
  };
};

const base64FromDataUrl = (dataUrl: string) => {
  const separator = dataUrl.indexOf(",");
  if (separator < 0 || !/;base64$/iu.test(dataUrl.slice(0, separator))) {
    throw new Error("Hermes file endpoint returned an invalid data URL");
  }
  return dataUrl.slice(separator + 1);
};

/** Host filesystem port backed by Hermes Dashboard's authenticated loopback API. */
export class HermesDashboardFileSystem implements HermesHostFileSystem {
  readonly codexHome: string;

  constructor(
    private readonly client: JsonHttpClient,
    private readonly sessionToken: string,
    hermesUserHome = "/home/agentuser",
  ) {
    const root = hermesUserHome.replace(/\/+$/u, "") || "/";
    this.codexHome = root === "/" ? "/.hermes" : `${root}/.hermes`;
  }

  async getMetadata(path: string, signal?: AbortSignal): Promise<HermesHostFileMetadata> {
    throwIfSignalAborted(signal);
    if (path === "/") return this.metadata(true);
    const { parent, name } = parentAndName(path);
    const entries = (await this.list(parent, signal)).entries ?? [];
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry) throw new Error(`Hermes path does not exist: ${path}`);
    return this.metadata(entry.isDirectory);
  }

  async readDirectory(path: string) {
    const response = await this.list(path);
    if (response.error) throw new Error(`Hermes could not read directory ${path} (${response.error})`);
    return {
      entries: (response.entries ?? []).map((entry) => ({
        fileName: entry.name,
        isDirectory: entry.isDirectory,
        isFile: !entry.isDirectory,
      })),
    };
  }

  async readFile(path: string, signal?: AbortSignal) {
    throwIfSignalAborted(signal);
    try {
      const response = await this.get<{ readonly dataUrl: string }>(
        `/api/fs/read-data-url?path=${encodePath(path)}`,
        signal,
      );
      return { dataBase64: base64FromDataUrl(response.dataUrl) };
    } catch (primaryError) {
      throwIfSignalAborted(signal);
      // Only a missing route warrants trying the older endpoint. An expired
      // read or a transport failure must never start a second download.
      if (!(primaryError instanceof Error) || !/^HTTP (404|405|501):/.test(primaryError.message)) throw primaryError;
      try {
        const response = await this.get<{ readonly data_url: string }>(
          `/api/files/read?path=${encodePath(path)}`,
          signal,
        );
        return { dataBase64: base64FromDataUrl(response.data_url) };
      } catch {
        throw primaryError;
      }
    }
  }

  async writeFile(path: string, dataBase64: string): Promise<void> {
    await this.client.fetchJson("/api/files/upload", {
      method: "POST",
      headers: { "X-Hermes-Session-Token": this.sessionToken },
      json: {
        path,
        data_url: `data:application/octet-stream;base64,${dataBase64}`,
        overwrite: true,
      },
    });
  }

  dispose(): void {
    this.client.close();
  }

  private metadata(isDirectory: boolean): HermesHostFileMetadata {
    return {
      isDirectory,
      isFile: !isDirectory,
      isSymlink: false,
      createdAtMs: 0,
      modifiedAtMs: 0,
    };
  }

  private async list(path: string, signal?: AbortSignal): Promise<HermesFsListResponse> {
    try {
      return await this.get<HermesFsListResponse>(`/api/fs/list?path=${encodePath(path)}`, signal);
    } catch (primaryError) {
      throwIfSignalAborted(signal);
      try {
        const fallback = await this.get<HermesManagedFileListResponse>(
          `/api/files?path=${encodePath(path)}`,
          signal,
        );
        return {
          entries: (fallback.entries ?? []).map((entry) => ({
            name: entry.name,
            isDirectory: entry.is_directory,
          })),
        };
      } catch {
        throw primaryError;
      }
    }
  }

  private get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.client.fetchJson<T>(path, {
      headers: { "X-Hermes-Session-Token": this.sessionToken },
      signal,
    });
  }
}
