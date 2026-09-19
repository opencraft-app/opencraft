import type {
  CompareAndSetPreferenceResult,
  StoredUiPreference,
  UiPreferenceKey,
  UiPreferenceStore,
} from "@opencraft/ui-preferences";

interface DesktopUiPreferencesPort {
  load(key: UiPreferenceKey): Promise<StoredUiPreference | null>;
  compareAndSet(
    key: UiPreferenceKey,
    expectedRevision: number,
    valueJson: string,
  ): Promise<CompareAndSetPreferenceResult>;
  subscribe(listener: (key: UiPreferenceKey) => void): () => void;
}

export function desktopUiPreferencesPort(): DesktopUiPreferencesPort | null {
  return (globalThis as typeof globalThis & {
    opencraftDesktop?: { readonly uiPreferences?: DesktopUiPreferencesPort };
  }).opencraftDesktop?.uiPreferences ?? null;
}

export class DesktopUiPreferenceStore implements UiPreferenceStore {
  constructor(private readonly port: DesktopUiPreferencesPort) {}

  load(key: UiPreferenceKey): Promise<StoredUiPreference | null> {
    return this.port.load(key);
  }

  compareAndSet(
    key: UiPreferenceKey,
    expectedRevision: number,
    valueJson: string,
  ): Promise<CompareAndSetPreferenceResult> {
    return this.port.compareAndSet(key, expectedRevision, valueJson);
  }

  subscribe(listener: (key: UiPreferenceKey) => void): () => void {
    return this.port.subscribe(listener);
  }
}
