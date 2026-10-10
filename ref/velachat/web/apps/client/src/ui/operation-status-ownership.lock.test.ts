import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";

describe("Operation status ownership", () => {
  it("allows the low-level details list only inside OperationStatusIsland", () => {
    const uiRoot = join(process.cwd(), "src", "ui");
    const allowed = new Set([
      "components/operation-status-island.tsx",
      "components/operation-status-list.tsx",
    ]);
    const bypasses = readdirSync(uiRoot, {recursive: true, encoding: "utf8"})
      .filter(name => /\.tsx$/u.test(name) && !/\.test\./u.test(name))
      .filter(name => !allowed.has(name))
      .filter(name => readFileSync(join(uiRoot, name), "utf8").includes("OperationStatusList"));

    expect(bypasses).toEqual([]);
  });

  it("keeps the low-level details component out of the public UI barrel", () => {
    const index = readFileSync(join(process.cwd(), "src", "ui", "index.ts"), "utf8");

    expect(index).not.toMatch(/\bOperationStatusList\b/u);
    expect(index).not.toMatch(/\bOperationStatusListProps\b/u);
    expect(index).toContain("OperationStatusIsland");
  });
});
