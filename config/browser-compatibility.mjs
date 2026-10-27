// Safari 16.6 is the engine baseline for iPadOS 16.7.x. Keep build and lint
// consumers on this one list; do not replace it with a moving "defaults" query.
export const browserTargets = ["safari 16.6", "ios_saf 16.6-16.7", "chrome 116", "firefox 115"];
export const browserEcmaVersion = "es2023";
