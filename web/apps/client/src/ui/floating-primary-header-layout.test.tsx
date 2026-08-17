import {readFileSync} from "node:fs";
import {join} from "node:path";

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), "src", "ui", relativePath), "utf8");
}

function styleBlock(text: string, name: string): string {
  return new RegExp(`^ {2}${name}: \\{\\n([\\s\\S]*?)^ {2}\\},$`, "mu")
    .exec(text)?.[1] ?? "";
}

describe("floating primary header ownership", () => {
  it("routes management and conversation headers through one primitive", () => {
    const systemPage = source("patterns/system-page.tsx");
    const workspace = source("layouts/workspace-shell.tsx");

    expect(systemPage).toContain("<SystemFloatingHeader");
    expect(systemPage).toContain('testID="management-primary-header"');
    expect(workspace.match(/<SystemFloatingHeader\b/gu)).toHaveLength(2);
    expect(workspace).toContain('testID="conversation-primary-header"');
    expect(workspace).toContain('testID="compact-primary-header"');
  });

  it("keeps primary header chrome out of layout consumers", () => {
    const management = source("components/management-workspace.styles.ts");
    const workspace = source("layouts/workspace-shell.styles.ts");
    const forbidden = /backgroundColor|borderBottom|boxShadow|shadowColor|paddingHorizontal|backdropFilter/u;

    expect(styleBlock(management, "header")).not.toMatch(forbidden);
    expect(styleBlock(workspace, "messageHeader")).not.toMatch(forbidden);
    expect(styleBlock(workspace, "compactHeader")).not.toMatch(forbidden);
  });

  it("passes viewport layout independently on every SystemPage screen", () => {
    for (const filename of [
      "agents-screen.tsx",
      "computers-screen.tsx",
      "members-screen.tsx",
      "tasks-screen.tsx",
      "server-settings-screen.tsx",
    ]) {
      const screen = source(`screens/${filename}`);
      expect(screen).toMatch(/layoutMode=\{(?:surface\.)?chromeMode\}/u);
    }
  });

  it("keeps conversation top overlays on the MessageStage token", () => {
    const tokens = source("tokens.ts");
    const workspace = source("layouts/workspace-shell.tsx");
    const styles = source("layouts/workspace-shell.styles.ts");
    const island = source("components/operation-status-island.tsx");

    expect(tokens).toContain("stageTopOverlayInset:");
    expect(tokens).not.toContain("toastTopInset:");
    expect(workspace).toContain("conversationWorkspace.stageTopOverlayInset");
    expect(styles).toContain("conversationWorkspace.stageTopOverlayInset");
    expect(island).toContain("topInset={topInset}");
  });
});
