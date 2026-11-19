import type { EmployeeGitHost } from "../plugins/tencentoa/src/git-credentials-contract";

/** Product presentation adapters. Execution, secrets and writes stay with their existing owners. */
export interface AssetProvider {
  readonly id: string;
  readonly name: string;
  readonly about: "e2bAbout" | "gongfengAbout" | "githubAbout";
  readonly capabilities: readonly ("environments" | "git" | "tools")[];
  readonly editor: "e2b" | "git";
  readonly host?: EmployeeGitHost;
}
export const assetProviders: readonly AssetProvider[] = [
  {
    id: "e2b",
    name: "E2B",
    about: "e2bAbout",
    capabilities: ["environments"],
    editor: "e2b",
  },
  {
    id: "gongfeng",
    name: "Gongfeng",
    about: "gongfengAbout",
    capabilities: ["git", "tools"],
    editor: "git",
    host: "git.woa.com",
  },
  {
    id: "github",
    name: "GitHub",
    about: "githubAbout",
    capabilities: ["git"],
    editor: "git",
    host: "github.com",
  },
];
export const providersFor = (
  capability: AssetProvider["capabilities"][number],
) =>
  assetProviders.filter((provider) =>
    provider.capabilities.includes(capability),
  );
