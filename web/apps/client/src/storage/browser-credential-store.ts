import type { CredentialStore } from "@raft-platform/client-core";

interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export class BrowserCredentialStore implements CredentialStore {
  private static readonly refreshTokenKey = "raft.client.refresh-token";
  private exclusiveTail: Promise<void> = Promise.resolve();

  public constructor(private readonly storage: StorageLike) {}

  public async clear(): Promise<void> {
    this.storage.removeItem(BrowserCredentialStore.refreshTokenKey);
  }

  public async loadRefreshToken(): Promise<string | null> {
    return this.storage.getItem(BrowserCredentialStore.refreshTokenKey);
  }

  public async runExclusive<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.exclusiveTail;
    let release!: () => void;
    this.exclusiveTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  public async saveRefreshToken(token: string): Promise<void> {
    this.storage.setItem(BrowserCredentialStore.refreshTokenKey, token);
  }
}
