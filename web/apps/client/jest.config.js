module.exports = {
  preset: "jest-expo",
  testMatch: ["<rootDir>/src/**/*.test.ts", "<rootDir>/src/**/*.test.tsx"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@raft-platform/client-core$":
      "<rootDir>/../../packages/client-core/src/index.ts",
    "^@/(.*)$": "<rootDir>/src/$1",
    "^lucide-react-native$": "<rootDir>/src/ui/test/lucide-react-native.tsx",
    "^lucide-react-native/icons/(.*)$":
      "<rootDir>/src/ui/test/lucide-icon.tsx",
  },
  setupFiles: [
    "react-native-unistyles/mocks",
    "<rootDir>/src/ui/unistyles.ts",
  ],
  transformIgnorePatterns: [
    "/node_modules/(?!(?:\\.bun/[^/]+/node_modules/)?(?:react-native|@react-native|@react-native-community|expo|@expo|react-navigation|@react-navigation|react-native-unistyles|react-native-nitro-modules|react-native-svg|lucide-react-native))",
  ],
};
