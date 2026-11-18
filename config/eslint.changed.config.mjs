// ESLint rules for source files a change adds (`npm run lint:changed`).
// Existing files are not linted, so these rules never force a large rewrite.
// Kept out of the repository root so editors do not apply it to older files.
import parser from "@typescript-eslint/parser";
import tseslint from "@typescript-eslint/eslint-plugin";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const lucide = "OpenCraft UI icons use the shared action-icons owners, never Lucide (see AGENTS.md).";

export default [
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    languageOptions: { parser, ecmaVersion: "latest", sourceType: "module" },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-restricted-imports": ["error", { patterns: [{ regex: "^lucide(?:-[\\w-]+)?(?:/.*)?$", message: lucide }] }],
    },
  },
  {
    // Product source is type checked by its workspace project, so promise rules can see types.
    files: ["{apps,packages,plugins}/*/src/**/*.{ts,mts,cts,tsx}"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: root } },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
    },
  },
];
