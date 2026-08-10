import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";

const serverRoutesRoot = join(
  process.cwd(),
  "src",
  "app",
  "(app)",
  "s",
  "[serverId]",
);

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("server workspace chrome ownership", () => {
  it("keeps ServerRouteBoundary and WorkspaceChrome only in the server layout", () => {
    const files = routeFiles(serverRoutesRoot);
    const layout = join(serverRoutesRoot, "_layout.tsx");
    const computersLayout = join(serverRoutesRoot, "computers", "_layout.tsx");
    expect(files).toContain(layout);
    expect(files).toContain(computersLayout);

    const layoutSource = readFileSync(layout, "utf8");
    expect(layoutSource).toContain("ServerRouteBoundary");
    expect(layoutSource).toContain("WorkspaceChrome");
    expect(layoutSource).toContain("ServerWorkspaceProvider");
    expect(layoutSource).toContain("<Slot");

    const computersLayoutSource = readFileSync(computersLayout, "utf8");
    expect(computersLayoutSource).toContain("ExpoManagementRouteSurface");
    expect(computersLayoutSource).toContain("selectedComputerId");

    const offenders = files
      .filter(path => path !== layout)
      .filter(path => {
        const source = readFileSync(path, "utf8");
        return (
          source.includes("ServerRouteBoundary") ||
          source.includes("WorkspaceChrome") ||
          source.includes("<PlatformFrame")
        );
      })
      .map(path => path.slice(serverRoutesRoot.length + 1));

    expect(offenders).toEqual([]);
  });
});
