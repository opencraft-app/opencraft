export const DEFAULT_WEBVIEW_STATE: { isEnabled: boolean; presetId: string; width: number; height: number };
export const RESPONSIVE_PRESET_ID: string;
export const DEVICE_PRESETS: ReadonlyArray<{ id: string; width: number; height: number }>;
export function initializeBrowserViewportPresets(): void;
export function clampPanelWidth__rBr_2f54e(width: number): number;
export function getDefaultPanelWidth(height: number): number;
