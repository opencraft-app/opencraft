import type { CdpCallOptions, CdpTransport } from "../transport";

type Command = (method: string, params?: Readonly<Record<string, unknown>>, sessionId?: string) => Promise<any>;
interface Events {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}
export interface ElectronCdpContents extends Events {
  isDestroyed(): boolean;
  readonly debugger: Events & {
    isAttached(): boolean;
    attach(version: string): void;
    detach(): void;
    sendCommand: Command;
  };
}
export interface ElectronCdpOwner extends CdpTransport {
  readonly ready: Promise<void>;
  configure<T>(operation: (send: Command) => Promise<T>, options?: CdpCallOptions): Promise<T>;
  targetSessions(): readonly { readonly sessionId: string; readonly targetId?: string }[];
  dispose(): void;
}
export function createElectronCdpOwner(contents: ElectronCdpContents, options?: {
  readonly timeoutMs?: number;
  readonly initializeTarget?: (send: Command, sessionId?: string) => Promise<void>;
  readonly onFailure?: (error: unknown) => void;
}): ElectronCdpOwner;
