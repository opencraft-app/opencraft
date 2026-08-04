import {readFileSync} from "node:fs";
import {resolve} from "node:path";

const humanSurfaceFiles = [
  "../application/app-store.ts",
  "../app/(app)/home.tsx",
  "../features/workspace/server-root.tsx",
  "../features/workspace/workspace-conversation-screen.tsx",
  "../ui/components/operation-status-list.tsx",
  "../ui/components/terminal-panel.tsx",
  "../ui/components/terminal-panel.web.tsx",
  "../ui/layouts/workspace-shell.tsx",
  "../ui/screens/auth-screen.tsx",
  "../ui/screens/computers-screen.tsx",
  "../ui/screens/first-workspace-screen.tsx",
];

const forbiddenProductTerms = [
  /腾讯云/u,
  /\bTAT\b/u,
  /\bPTY\b/u,
  /\bRegion\b/u,
  /\bEnrollment\b/u,
  /\bmanaged\b/iu,
  /\bCVM\b/u,
  /\bLighthouse\b/u,
];

describe("Human product boundary", () => {
  it.each(humanSurfaceFiles)("keeps provider terms out of %s", (relativePath) => {
    const source = readFileSync(resolve(__dirname, relativePath), "utf8");

    for (const forbidden of forbiddenProductTerms) {
      expect(source).not.toMatch(forbidden);
    }
  });
});
