import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Principal} from '@opencraft/identity-core';
export interface RuntimePluginContext {
  readonly hostApi: 1;
  readonly role: 'gateway' | 'execution' | 'hands';
  readonly revision: string;
  readonly packageRoot: string;
  readonly configuration: Readonly<Record<string,unknown>>;
  readonly onFailure: () => void;
  readonly authority?: {
    authenticate(request: IncomingMessage): Principal | null;
    admissionStatus(request: IncomingMessage): number;
  };
}
export interface RuntimePluginService {
  handle?(request: IncomingMessage,response: ServerResponse): Promise<void> | void;
  close(): Promise<void> | void;
}

/** Storage supplies pinned bytes only, not installation authority or an execution target. */
export interface RuntimePluginPackageSource {
  readPackage(selection: {id: string; revision: string}, options: {signal?: AbortSignal}): Promise<{
    manifest: unknown; manifestBytes: Uint8Array; files: Map<string,Uint8Array>;
  }>;
  close?(): Promise<void> | void;
}
