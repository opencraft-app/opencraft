import {readFileSync} from "node:fs";
import {join} from "node:path";

function read(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), "utf8");
}

describe("native workspace remediation", () => {
  it("keeps authentication focused on the account task", () => {
    const source = read("../screens/auth-screen.tsx");

    expect(source).not.toContain("VELA / AGENT NETWORK");
    expect(source).not.toContain("styles.statement");
    expect(source).not.toContain("auth-account-icon");
  });

  it("keeps first workspace setup in one continuous flow", () => {
    const source = read("../screens/first-workspace-screen.tsx");

    expect(source).not.toContain("function Step(");
    expect(source).not.toContain("formPanelElevated");
    expect(source).not.toContain("styles.sequence");
  });

  it("renders route failures as a flat stage state", () => {
    const source = read("route-status-screen.tsx");

    expect(source).not.toContain("styles.card");
    expect(source).not.toContain(">VELA<");
    expect(source).toContain('testID="route-status-surface"');
  });

  it("keeps workspace collection counts in natural language", () => {
    const source = read("../layouts/workspace-shell.tsx");

    expect(source).not.toContain('String(directConversations.length).padStart(2, "0")');
    expect(source).not.toContain('String(visibleMembers.length).padStart(2, "0")');
  });
});
