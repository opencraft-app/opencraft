const { getDefaultConfig } = require("expo/metro-config");

// Expo SDK 52+ discovers npm workspaces automatically. Keep this file free of
// watchFolders/nodeModulesPaths overrides so Metro and npm resolve one graph.
module.exports = getDefaultConfig(__dirname);
