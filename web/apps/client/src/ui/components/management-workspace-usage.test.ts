import {readFileSync} from "node:fs";
import {join} from "node:path";

const managementScreens = [
  "agents-screen.tsx",
  "computers-screen.tsx",
  "members-screen.tsx",
  "tasks-screen.tsx",
];

describe("management workspace adoption", () => {
  it.each(managementScreens)("keeps %s on the shared workspace shell", (file) => {
    const source = readFileSync(join(__dirname, "..", "screens", file), "utf8");

    expect(source).toContain("<ManagementCollectionPane");
    expect(source).toContain("<ManagementStage");
    expect(source).toContain("<ManagementHeader");
    expect(source).toContain("<CollectionRow");
    expect(source).toContain("<DetailSection");
    expect(source).toContain("<ActionButton");
  });

  it("centralizes empty and status treatments in the semantic component module", () => {
    const moduleSource = readFileSync(
      join(__dirname, "management-workspace.tsx"),
      "utf8",
    );
    const emptySource = readFileSync(
      join(__dirname, "management-empty-state.tsx"),
      "utf8",
    );

    expect(moduleSource).toContain("export function StatusIndicator");
    expect(emptySource).toContain("<InlineEmptyState");
  });

  it.each(managementScreens)(
    "keeps ordinary %s actions on the shared ActionButton",
    (file) => {
      const source = readFileSync(join(__dirname, "..", "screens", file), "utf8");

      expect(source).not.toMatch(/styles\.(?:dangerButton|primaryButton|secondaryButton)/u);
      expect(source).not.toMatch(/\n  (?:dangerButton|primaryButton|secondaryButton): \{/u);
    },
  );

  it.each(managementScreens)(
    "requires every %s action to declare its semantic importance",
    (file) => {
      const source = readFileSync(join(__dirname, "..", "screens", file), "utf8");
      const actions = Array.from(
        source.matchAll(/<ActionButton\b([\s\S]*?)\/>/gu),
      );

      expect(actions.length).toBeGreaterThan(0);
      expect(
        actions.flatMap((match, index) =>
          /\bimportance=/u.test(match[1] ?? "") ? [] : [index],
        ),
      ).toEqual([]);
    },
  );

  it.each(managementScreens)(
    "keeps non-action %s surfaces off action color roles",
    (file) => {
      const source = readFileSync(join(__dirname, "..", "screens", file), "utf8");

      expect(source).not.toMatch(/semantic\.color\.actionTonal(?:Surface|HoverSurface|PressedSurface)/u);
    },
  );

  it.each(["agents-screen.tsx", "computers-screen.tsx", "members-screen.tsx"])(
    "keeps the mobile resource picker in ManagementResourceSwitcher for %s",
    (file) => {
      const source = readFileSync(join(__dirname, "..", "screens", file), "utf8");

      expect(source).toContain("<ManagementResourceSwitcher");
      expect(source).not.toMatch(/\n  mobileSwitcher(?:Button|Menu|Option)?(?:Pressed|Content)?: \{/u);
      expect(source).not.toMatch(/\n  switcherChevronOpen: \{/u);
    },
  );

  it.each(["agents-screen.tsx", "computers-screen.tsx"])(
    "keeps %s collection identity marks in the shared primitive",
    (file) => {
      const source = readFileSync(join(__dirname, "..", "screens", file), "utf8");

      expect(source).toContain("<CollectionIdentityMark");
      expect(source).not.toMatch(/\n  (?:avatar|statusDot|statusDotOnline): \{/u);
    },
  );

  it("keeps Computer enrollment feedback and command output semantic", () => {
    const source = readFileSync(
      join(__dirname, "..", "screens", "computers-screen.tsx"),
      "utf8",
    );

    expect(source).toContain("<NoticeBanner");
    expect(source).toContain("<CodeBlock");
    expect(source).not.toMatch(/\n  (?:registration|script|scriptScroller): \{/u);
  });

  it.each(["agents-screen.tsx", "computers-screen.tsx", "members-screen.tsx"])(
    "keeps the %s resource identity in ResourceIdentityHeader",
    (file) => {
      const source = readFileSync(join(__dirname, "..", "screens", file), "utf8");

      expect(source).toContain("<ResourceIdentityHeader");
      expect(source).not.toMatch(
        /\n  (?:detailTitle(?:Compact|Medium)?|hero|heroAvatar|heroAvatarText|heroCompact|heroCopy|heroIcon(?:Compact|Medium)?|heroIdentity(?:Compact|Wide)?|identityMeta|identitySection|identitySeparator): \{/u,
      );
    },
  );

  it("keeps Agent settings as the single source of runtime configuration", () => {
    const source = readFileSync(
      join(__dirname, "..", "screens", "agents-screen.tsx"),
      "utf8",
    );

    expect(source).not.toContain("<ResourceFactStrip");
    expect(source).not.toContain("agent-fact-strip");
  });

  it("presents Member metadata as native detail rows instead of equal facts", () => {
    const source = readFileSync(
      join(__dirname, "..", "screens", "members-screen.tsx"),
      "utf8",
    );

    expect(source).toContain("<ResourceMetadataList");
    expect(source).not.toContain("<ResourceFactStrip");
  });

  it("keeps task and reminder headings free of dashboard references", () => {
    const source = readFileSync(
      join(__dirname, "..", "screens", "tasks-screen.tsx"),
      "utf8",
    );

    expect(source.match(/<DetailHeading/gu)).toHaveLength(2);
    expect(source).not.toContain("<RecordIdentityHeader");
    expect(source).not.toContain("TASK #");
  });

  it.each(managementScreens)(
    "keeps management forms in shared semantic containers for %s",
    (file) => {
      const source = readFileSync(join(__dirname, "..", "screens", file), "utf8");

      expect(source).toContain("<ManagementForm");
      expect(source).toContain("<ManagementFormActions");
      expect(source).toContain("<ManagementField");
      expect(source).toContain("<ManagementTextInput");
      expect(source).not.toMatch(/\n  form: \{/u);
      expect(source).not.toMatch(/\n  formActions: \{/u);
      expect(source).not.toMatch(/\n  (?:fieldGroup|fieldGroupSmall|fieldLabel|fieldHint|fieldError|input|inputInvalid|smallInput|textarea): \{/u);
    },
  );

  it.each(["agents-screen.tsx", "members-screen.tsx", "tasks-screen.tsx"])(
    "keeps the collection header shared for %s",
    (file) => {
      const source = readFileSync(join(__dirname, "..", "screens", file), "utf8");

      expect(source).toContain("<ManagementCollectionHeader");
      expect(source).not.toMatch(/\n  (?:resourceHeader|sidebarHeader|headerMark): \{/u);
    },
  );

  it.each(managementScreens)(
    "keeps %s detail gutters and canvas rhythm in shared primitives",
    (file) => {
      const source = readFileSync(join(__dirname, "..", "screens", file), "utf8");

      expect(source).toContain("<ManagementDetailScroll");
      expect(source).toContain("<ManagementDetailCanvas");
      expect(source).not.toMatch(/\n  (?:contentCompact|detailCompact|detailMedium|detailScrollerCompact|detailScrollerMedium|memberDetail): \{/u);
    },
  );

  it.each(["agents-screen.tsx", "members-screen.tsx", "tasks-screen.tsx"])(
    "keeps %s domain choices in the shared SelectionButton",
    (file) => {
      const source = readFileSync(join(__dirname, "..", "screens", file), "utf8");

      expect(source).toContain("<SelectionButton");
      expect(source).not.toMatch(/\n  (?:agentChoice|choice|choiceSelected|modeTab|modeTabSelected): \{/u);
    },
  );

  it("uses a native text tab bar for Task and Reminder modes", () => {
    const source = readFileSync(
      join(__dirname, "..", "screens", "tasks-screen.tsx"),
      "utf8",
    );

    expect(source).toContain("<ManagementTabBar");
    expect(source).toContain("<ManagementTab");
  });

  it.each(["agents-screen.tsx", "members-screen.tsx", "tasks-screen.tsx"])(
    "keeps %s collection counts in natural language",
    (file) => {
      const source = readFileSync(join(__dirname, "..", "screens", file), "utf8");

      expect(source).not.toMatch(/\.padStart\(2,\s*["']0["']\)/u);
      expect(source).not.toMatch(/(?:RUNTIMES|TEAM)\s*\//u);
    },
  );

  it.each(["agents-screen.tsx", "tasks-screen.tsx"])(
    "keeps collection footer actions shared for %s",
    (file) => {
      const source = readFileSync(join(__dirname, "..", "screens", file), "utf8");

      expect(source).toContain("<ManagementCollectionFooterAction");
      expect(source).not.toMatch(/\n  sidebar(?:Action|Create): \{/u);
    },
  );
});
