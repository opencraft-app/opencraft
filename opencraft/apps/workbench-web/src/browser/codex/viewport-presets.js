// Source-identical viewport constants/helpers from ref/codex/browser/shared/is-adjacent-tab-index.js.

function insetDimensions(e) {
    return {
        width: Math.max(0, e.width - WEBVIEW_PADDING * 2),
        height: Math.max(0, e.height - WEBVIEW_PADDING)
    };
}
function clampPanelWidth__rBr_2f54e(e) {
    return clampDimension(e, 240, MAX_DIMENSION_PRESET);
}
function getDefaultPanelWidth(e) {
    return clampDimension(e, 160, MAX_DIMENSION_HEIGHT);
}
function clampDimension(e, t, n) {
    return Math.min(n, Math.max(t, Math.round(e)));
}
var RESPONSIVE_PRESET_ID;
var MAX_DIMENSION_PRESET;
var MAX_DIMENSION_HEIGHT;
var cBr;
let DEFAULT_DEVICE_PRESET;
var WEBVIEW_PADDING;
var DEVICE_PRESETS;
var DEFAULT_WEBVIEW_STATE;
var initializeBrowserViewportPresets = (()=>{ let state = "uninitialized"; let factory = (()=>{
    RESPONSIVE_PRESET_ID = `responsive`;
    MAX_DIMENSION_PRESET = 4096;
    MAX_DIMENSION_HEIGHT = 4096;
    cBr = `var(--gray-700)`;
    DEFAULT_DEVICE_PRESET = {
        id: RESPONSIVE_PRESET_ID,
        width: 390,
        height: 844
    };
    WEBVIEW_PADDING = 20;
    DEVICE_PRESETS = [
        DEFAULT_DEVICE_PRESET,
        {
            id: `4k`,
            width: 2560,
            height: 1440
        },
        {
            id: `laptop-l`,
            width: 1440,
            height: 900
        },
        {
            id: `laptop`,
            width: 1024,
            height: 768
        },
        {
            id: `surface-pro-7`,
            width: 912,
            height: 1368
        },
        {
            id: `ipad-air`,
            width: 820,
            height: 1180
        },
        {
            id: `ipad-mini`,
            width: 768,
            height: 1024
        },
        {
            id: `surface-duo`,
            width: 540,
            height: 720
        },
        {
            id: `iphone-15-pro-max`,
            width: 430,
            height: 932
        },
        {
            id: `pixel-8`,
            width: 412,
            height: 915
        },
        {
            id: `iphone-15-pro`,
            width: 393,
            height: 852
        },
        {
            id: `samsung-galaxy-s24-ultra`,
            width: 384,
            height: 824
        },
        {
            id: `iphone-se`,
            width: 375,
            height: 667
        }
    ];
    DEFAULT_WEBVIEW_STATE = {
        isEnabled: false,
        presetId: DEFAULT_DEVICE_PRESET.id,
        width: DEFAULT_DEVICE_PRESET.width,
        height: DEFAULT_DEVICE_PRESET.height
    };
}); let value; let failure; return ()=>{ if (state === "failed") throw failure; if (state === "uninitialized") { state = "initializing"; const initialize = factory; factory = undefined; try { value = initialize(0); state = "initialized"; } catch (error) { failure = error; state = "failed"; throw error; } } return value; }; })();
export { DEFAULT_DEVICE_PRESET, DEFAULT_WEBVIEW_STATE, DEVICE_PRESETS, MAX_DIMENSION_HEIGHT, MAX_DIMENSION_PRESET, RESPONSIVE_PRESET_ID, WEBVIEW_PADDING, cBr, clampDimension, clampPanelWidth__rBr_2f54e, getDefaultPanelWidth, initializeBrowserViewportPresets, insetDimensions };
