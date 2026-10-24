/** Content-free diagnostics; never include saved profiles, endpoints or credentials. */
export interface BrowserStorageDiagnostics {
  readonly storage: "host-profiles";
  readonly stage: "opening" | "upgrading";
  readonly elapsedMs: number;
  readonly requestedVersion: number;
  readonly oldVersion?: number;
  readonly newVersion?: number | null;
  readonly errorName?: string;
}

/** Startup storage failures are recoverable without deleting browser data. */
export class BrowserStorageError extends Error {
  readonly storageDiagnostics?: BrowserStorageDiagnostics;

  constructor(readonly reason: "blocked" | "timeout" | "unavailable", options?: ErrorOptions & {
    readonly storageDiagnostics?: BrowserStorageDiagnostics;
  }) {
    super(`Browser storage ${reason}`, options);
    this.name = "BrowserStorageError";
    this.storageDiagnostics = options?.storageDiagnostics;
  }
}
