import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";

const srcRoot = join(process.cwd(), "src");
const uiRoot = join(srcRoot, "ui");
const screensRoot = join(uiRoot, "screens");

const managementScreens = [
  "agents-screen.tsx",
  "computers-screen.tsx",
  "members-screen.tsx",
  "server-settings-screen.tsx",
  "tasks-screen.tsx",
];

const collectionScreens = [
  "agents-screen.tsx",
  "computers-screen.tsx",
  "members-screen.tsx",
  "tasks-screen.tsx",
];

function runtimeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return runtimeFiles(path);
    return /\.(?:ts|tsx)$/.test(path) &&
      !path.endsWith(".test.ts") &&
      !path.endsWith(".test.tsx")
      ? [path]
      : [];
  });
}

function relative(path: string): string {
  return path.slice(srcRoot.length + 1);
}

/**
 * Behavior locks: once warlord copies are killed, these patterns must not
 * return. Prefer failing CI over silently drifting back to per-screen forks.
 */
describe("management ownership behavior locks", () => {
  it("routes semantic shell navigation through shared sectionNavigation builders", () => {
    const handCopiedNav = /\["chat"\s*,\s*"聊天"\]/;
    const scanRoots = [
      join(srcRoot, "ui", "screens"),
      join(srcRoot, "ui", "layouts"),
    ];
    const offenders = scanRoots
      .flatMap(runtimeFiles)
      .filter(path => handCopiedNav.test(readFileSync(path, "utf8")))
      .map(relative);

    expect(offenders).toEqual([]);

    for (const name of [
      "agents-screen.tsx",
      "computers-screen.tsx",
      "members-screen.tsx",
      "tasks-screen.tsx",
    ]) {
      const source = readFileSync(join(screensRoot, name), "utf8");
      expect(source).toContain("buildManagementShellModel");
    }

    expect(
      readFileSync(join(uiRoot, "layouts", "workspace-shell-model.ts"), "utf8"),
    ).toContain("buildSectionPresentationNavigation");
  });

  it("routes framed dual-path through ManagementScreenFrame", () => {
    const offenders = managementScreens
      .map(name => join(screensRoot, name))
      .filter(path => {
        const source = readFileSync(path, "utf8");
        return (
          source.includes("<PlatformFrame") ||
          source.includes("workspaceSectionBody(")
        );
      })
      .map(relative);

    expect(offenders).toEqual([]);

    for (const name of managementScreens) {
      expect(readFileSync(join(screensRoot, name), "utf8")).toContain(
        "ManagementScreenFrame",
      );
    }
  });

  it("keeps management screens on the four-part system page grammar", () => {
    for (const name of managementScreens) {
      const source = readFileSync(join(screensRoot, name), "utf8");
      expect(source).toContain("<SystemPage");
      expect(source).not.toMatch(/<ManagementStage(?:\s|>)/u);
      expect(source).not.toMatch(/<ManagementHeader(?:\s|>)/u);
      expect(source).not.toMatch(/<ManagementDetailScroll(?:\s|>)/u);
    }

    for (const name of collectionScreens) {
      const source = readFileSync(join(screensRoot, name), "utf8");
      expect(source).toContain("<SystemRow");
      expect(source).not.toMatch(/<CollectionRow(?:\s|>)/u);
      expect(source).not.toMatch(/<ResourceActionRow(?:\s|>)/u);
      expect(source).toContain("<SystemForm");
      expect(source).not.toMatch(/<ManagementForm(?:\s|>)/u);
    }

    for (const name of [
      "agents-screen.tsx",
      "computers-screen.tsx",
      "members-screen.tsx",
      "tasks-screen.tsx",
    ]) {
      const source = readFileSync(join(screensRoot, name), "utf8");
      expect(source).not.toContain("<DetailSection");
      if (source.includes("-section")) expect(source).toContain("<SystemSection");
    }
  });

  it("puts the collection in the frame nav slot when chrome is wide", () => {
    for (const name of collectionScreens) {
      const source = readFileSync(join(screensRoot, name), "utf8");
      expect(source).toContain("ManagementResourceDirectory");
      // In-stage dual-path body (computers' former warlord) must stay gone.
      expect(source).not.toContain("workspaceBody");
      expect(source).not.toContain("computer-workspace");
      // Wide collection belongs on ManagementScreenFrame.navigation, not a
      // permanent null. Compact still nulls the frame slot.
      expect(source).not.toMatch(
        /<ManagementScreenFrame[\s\S]{0,400}?navigation=\{null\}/,
      );
      // Frame slot is gated on stackedCollection (computers may OR focus modes).
      expect(source).toMatch(
        /stackedCollection(?:\s*\|\|[\s\S]{0,60})?\s*\?\s*null\s*:/,
      );
    }
  });

  it("uses managementSurfaceLayout for collection stacking density", () => {
    for (const name of collectionScreens) {
      const source = readFileSync(join(screensRoot, name), "utf8");
      expect(source).toContain("managementSurfaceLayout");
      expect(source).not.toMatch(
        /import\s*\{\s*layoutMode\s*\}\s*from\s*["']\.\.\/layout-mode["']/,
      );
      expect(source).not.toContain("workspaceShellWideBreakpoint");
    }
  });

  it("keeps owner/admin capability behind memberCanManageServer", () => {
    const inlineRoleGate =
      /role\s*===\s*["']owner["']\s*\|\|[\s\S]{0,80}?role\s*===\s*["']admin["']/;
    const scanRoots = [
      join(srcRoot, "app"),
      join(srcRoot, "features"),
      join(srcRoot, "ui"),
    ];
    const offenders = scanRoots
      .flatMap(runtimeFiles)
      .filter(path => !path.endsWith("resources.ts"))
      .filter(path => inlineRoleGate.test(readFileSync(path, "utf8")))
      .map(relative);

    expect(offenders).toEqual([]);
  });

  it("keeps member role/status labels in member-identity", () => {
    const source = readFileSync(join(screensRoot, "members-screen.tsx"), "utf8");
    expect(source).toMatch(
      /import\s*\{[\s\S]*memberRoleLabel[\s\S]*\}\s*from\s*["']\.\.\/member-identity["']/,
    );
    expect(source).not.toMatch(
      /const\s+memberRoleLabel\s*:\s*Record</,
    );
    expect(source).not.toMatch(
      /const\s+memberImStateLabel\s*:\s*Record</,
    );
    expect(source).not.toMatch(
      /const\s+memberStatusLabel\s*:\s*Record</,
    );
  });

  it("derives section labels from sectionNavigation", () => {
    const styleLab = readFileSync(
      join(screensRoot, "style-lab-screen.tsx"),
      "utf8",
    );
    expect(styleLab).toContain("sectionNavigation");
    expect(styleLab).toContain("label: item.label");
    expect(styleLab).not.toMatch(
      /\{\s*accessibilityLabel:\s*"预览聊天界面",\s*id:\s*"chat",\s*label:\s*"聊天"\s*\}/,
    );

    const expo = readFileSync(
      join(
        srcRoot,
        "features",
        "management",
        "expo-management-route-surface.tsx",
      ),
      "utf8",
    );
    expect(expo).toContain("workspaceSectionLabel");
    expect(expo).not.toMatch(
      /const\s+sectionTitle\s*:\s*Record</,
    );
  });

  it("keeps every management screen on the shared presentation boundary", () => {
    for (const name of managementScreens) {
      const source = readFileSync(join(screensRoot, name), "utf8");
      expect(source).toContain("ManagementPresentation");
      expect(source).toMatch(
        /<ManagementPresentation[\s\S]*?>\s*\{\((?:model|pageModel)\)\s*=>/,
      );
    }
  });

  it("keeps form selection and footer composition in system controls", () => {
    for (const name of collectionScreens) {
      const source = readFileSync(join(screensRoot, name), "utf8");
      expect(source).toContain("ManagementFormFooter");
      expect(source).not.toMatch(/function\s+FormActions\s*\(/);
      expect(source).toContain("form={pageModel.form!}");
    }

    for (const name of [
      "agents-screen.tsx",
      "members-screen.tsx",
      "tasks-screen.tsx",
    ]) {
      const source = readFileSync(join(screensRoot, name), "utf8");
      expect(source).toMatch(/SystemSegmentedControl|SystemSelectField/u);
      expect(source).not.toContain("ManagementChoiceField");
      expect(source).not.toMatch(/function\s+ChoiceRow\s*\(/);
    }
  });

  it("uses shared empty copy for every management resource", () => {
    const expected = {
      "agents-screen.tsx": ["agentEmptyCopy"],
      "computers-screen.tsx": ["computerEmptyCopy", "computerNotFoundCopy"],
      "members-screen.tsx": ["memberEmptyCopy"],
      "tasks-screen.tsx": ["reminderEmptyCopy", "taskEmptyCopy"],
    } as const;
    for (const [name, exports] of Object.entries(expected)) {
      const source = readFileSync(join(screensRoot, name), "utf8");
      for (const exportedName of exports) expect(source).toContain(exportedName);
    }
  });

  it("keeps resource status presentation out of screen implementations", () => {
    const localStatusDeclaration =
      /(?:const|function)\s+(?:agentRuntimeState|computerConnection|taskStatus|reminderStatus)(?:Label|Tone)/;
    const offenders = collectionScreens
      .map(name => join(screensRoot, name))
      .filter(path => localStatusDeclaration.test(readFileSync(path, "utf8")))
      .map(relative);
    expect(offenders).toEqual([]);

    for (const name of ["terminal-panel.tsx", "terminal-panel.web.tsx"]) {
      const source = readFileSync(join(uiRoot, "components", name), "utf8");
      expect(source).toContain("presentation/resources/terminal");
      expect(source).not.toMatch(/const\s+terminalStatusLabel/);
    }
  });

  it("gives the graphical conversation renderer the shared page model", () => {
    const source = readFileSync(
      join(uiRoot, "layouts", "workspace-shell.tsx"),
      "utf8",
    );
    expect(source).toMatch(
      /<ConversationPresentation[\s\S]*?>\s*\{\(pageModel\)\s*=>/,
    );
    expect(source).toContain("pageModel={pageModel}");
    expect(source).toContain('from "./workspace-shell-model"');
    expect(source).not.toContain("function conversationPageModel(");
  });
});
