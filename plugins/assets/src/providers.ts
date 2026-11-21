/** Trusted presentation metadata; provider registration never grants execution or secret access. */
export interface AssetProvider {
  readonly id: string;
  readonly name: string;
  readonly nameMessage?: { readonly id: string; readonly defaultMessage: string };
  readonly about: { readonly id: string; readonly defaultMessage: string };
  readonly capabilities: readonly ("environments" | "git" | "tools")[];
  readonly editor: "e2b" | "git";
  readonly host?: string;
}
export const e2bAssetProvider: AssetProvider = {
  id: "e2b",
  name: "E2B",
  about: {
    id: "assets.e2bAbout",
    defaultMessage: "Use an E2B connection to create cloud workspaces for your assistant.",
  },
  capabilities: ["environments"],
  editor: "e2b",
};
