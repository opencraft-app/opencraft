import type { CredentialStore } from "@vela/client-core";

interface SecureStorageLike {
  deleteItemAsync(key: string): Promise<void>;
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

export class SecureCredentialStore implements CredentialStore {
  private static readonly refreshTokenKey = "vela.client.refresh-token";
  private exclusiveTail: Promise<void> = Promise.resolve();

  public constructor(private readonly storage: SecureStorageLike) {}

  public async clear(): Promise<void> {
    await this.storage.deleteItemAsync(SecureCredentialStore.refreshTokenKey);
  }

  public async loadRefreshToken(): Promise<string | null> {
    return this.storage.getItemAsync(SecureCredentialStore.refreshTokenKey);
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
    await this.storage.setItemAsync(
      SecureCredentialStore.refreshTokenKey,
      token,
    );
  }
}
