import parser from "@typescript-eslint/parser";
import compat from "eslint-plugin-compat";
import esx from "eslint-plugin-es-x";
import { fileURLToPath } from "node:url";
import { browserTargets, browserEcmaVersion } from "./browser-compatibility.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export default [
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    languageOptions: { parser, parserOptions: {
      // The actual bundle selects files; this program supplies uniform browser
      // declarations even when a plugin is injected by a downstream build.
      project: "./config/tsconfig.browser-compatibility.json", tsconfigRootDir: root,
    } },
    plugins: { compat, "es-x": esx },
    settings: { browsers: browserTargets, lintAllEsApis: true },
    rules: {
      ...esx.configs[`flat/restrict-to-${browserEcmaVersion}`].rules,
      "compat/compat": "error",
      // compat detects globals, but cannot resolve HTMLElement instance methods.
      // Use existing Radix primitives rather than unguarded native Popover APIs.
      "no-restricted-properties": ["error", ...["showPopover", "hidePopover", "togglePopover"].map(property => ({
        property, message: "Native Popover requires Safari 17. Use the shared Radix primitive or a capability adapter with a tested fallback.",
      })), {
        // compat/compat does not resolve this AbortSignal static for the baseline.
        object: "AbortSignal", property: "any",
        message: "AbortSignal.any requires Safari 17.4. Keep one AbortController with an explicit timer for a single owner, or combineAbortSignals from @opencraft/appserver-client/transport and dispose it at the owning lifecycle boundary.",
      }],
    },
  },
  // This is an injected replay clock, not the experimental window.scheduler.
  { basePath: root, files: ["plugins/bot-chat/src/motion-replay.ts"], settings: { polyfills: ["scheduler"] } },
  { files: ["**/*.{js,mjs,cjs,jsx}"], languageOptions: { parserOptions: { project: null, programs: null } } },
];
