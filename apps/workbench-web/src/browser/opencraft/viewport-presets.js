

export let DEFAULT_WEBVIEW_STATE;
export let RESPONSIVE_PRESET_ID;
export let DEVICE_PRESETS;
let initialized = false;

export function initializeBrowserViewportPresets() {
  if (initialized) return;
  RESPONSIVE_PRESET_ID = "responsive";
  DEFAULT_WEBVIEW_STATE = {
    isEnabled: false, presetId: RESPONSIVE_PRESET_ID, width: 390, height: 844,
  };
  // Keep the existing catalog values and order; these are application presets.
  DEVICE_PRESETS = [
    ["responsive", 390, 844],
    ["4k", 2560, 1440],
    ["laptop-l", 1440, 900],
    ["laptop", 1024, 768],
    ["surface-pro-7", 912, 1368],
    ["ipad-air", 820, 1180],
    ["ipad-mini", 768, 1024],
    ["surface-duo", 540, 720],
    ["iphone-15-pro-max", 430, 932],
    ["pixel-8", 412, 915],
    ["iphone-15-pro", 393, 852],
    ["samsung-galaxy-s24-ultra", 384, 824],
    ["iphone-se", 375, 667],
  ].map(([id, width, height]) => ({ id, width, height }));
  initialized = true;
}

function boundedDimension(value, minimum) {
  if (!initialized) return NaN;
  const integer = Math.round(value);
  if (integer < minimum) return minimum;
  return integer > 4096 ? 4096 : integer;
}

export function clampViewportWidth(width) {
  return boundedDimension(width, 240);
}
export function clampViewportHeight(height) {
  return boundedDimension(height, 160);
}
