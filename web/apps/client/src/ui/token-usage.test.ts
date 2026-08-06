import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("Vela token usage", () => {
  it("says a control's state in the dialect the browser reads", () => {
    // react-native-web 0.21 dropped accessibilityState: on the Web it reaches
    // no attribute at all. Jest renders the native tree, so a suite full of
    // accessibilityState assertions stayed green while, in the browser, every
    // selected chip and expanded menu went unannounced — the state was carried
    // by background colour alone. Native still reads accessibilityState, so a
    // control that has one owes the browser an aria- attribute beside it.
    const uiRoot = join(process.cwd(), "src", "ui");
    const sources = readdirSync(uiRoot, {recursive: true, encoding: "utf8"})
      .filter((name) => /\.tsx$/u.test(name) && !/\.test\./u.test(name))
      .map((name) => [name, readFileSync(join(uiRoot, name), "utf8")] as const);

    const unspoken: string[] = [];
    for (const [name, source] of sources) {
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("accessibilityState=")) return;
        if ((lines[index + 1] ?? "").includes("aria-")) return;
        unspoken.push(`${name}:${index + 1}`);
      });
    }

    expect(unspoken).toEqual([]);
  });

  it("installs one branded keyboard focus ring for the Web surface", () => {
    const installerPath = join(process.cwd(), "src", "ui", "focus-ring.web.ts");
    const installerSource = existsSync(installerPath)
      ? readFileSync(installerPath, "utf8")
      : "";
    const entrySource = readFileSync(join(process.cwd(), "index.ts"), "utf8");

    expect(entrySource).toContain('import "./src/ui/focus-ring"');
    expect(installerSource).toContain("semantic.color.borderFocus");
    expect(installerSource).toContain("semantic.interaction.focusRingOffset");
    expect(installerSource).toContain("semantic.interaction.focusRingWidth");
    expect(installerSource).toContain(":focus-visible");
  });

  it("gives a labelled button a surface to stand on", () => {
    // A `quiet` tier drew nothing behind the label, so two peer actions in the
    // same list — "生成安装命令" and "打开终端" — arrived as a button and a run
    // of text. Receding is an icon-only job; `IconActionButton` does it. Every
    // importance a label can wear now paints either a fill or a border.
    const source = readFileSync(
      join(process.cwd(), "src", "ui", "primitives", "action-button.tsx"),
      "utf8",
    );

    expect(source).not.toMatch(/"quiet"|actionQuiet\b/u);

    const tiers = /export type ActionImportance =([^;]*);/u.exec(source)?.[1] ?? "";
    expect(tiers).not.toBe("");
    for (const tier of tiers.match(/"(\w+)"/gu) ?? []) {
      const name = tier.replace(/"/gu, "");
      if (name === "primary") continue; // carries the base fill
      const block =
        new RegExp(
          `^ {2}action${name[0]!.toUpperCase()}${name.slice(1)}: \\{\\n([\\s\\S]*?)^ {2}\\},$`,
          "mu",
        ).exec(source)?.[1] ?? "";
      expect(block).not.toBe("");
      expect(block).toMatch(/backgroundColor|borderColor/u);
      expect(block).not.toContain("surfaceTransparent");
    }
  });

  it("lays every detail section out the one way", () => {
    // Computer alone split its detail into two columns, and it chose to do so
    // by comparing the *viewport* against 1080 — while the panels actually
    // live inside the content column. Once that column settled at 760 the
    // minor panel got 299px and its copy wrapped inside 190px. The split is
    // gone, so nothing should reach for its geometry again.
    const read = (...parts: string[]) =>
      readFileSync(join(process.cwd(), "src", "ui", ...parts), "utf8");

    const management = read("components", "management-workspace.tsx");
    const computers = read("screens", "computers-screen.tsx");

    expect(management).not.toMatch(/detailSectionMajor|detailSectionMinor/);
    expect(management).not.toContain("DetailSectionSpan");
    // A detail column that decides its shape from the viewport is measuring
    // the wrong box; the column it sits in is what constrains it.
    expect(computers).not.toContain("computerSupportStackBreakpoint");

    const supportGrid =
      /^ {2}supportGrid: \{\n([\s\S]*?)^ {2}\},$/mu.exec(computers)?.[1] ?? "";
    expect(supportGrid).not.toBe("");
    expect(supportGrid).not.toContain("flexDirection");
  });

  it("dresses the two list panes as one pane", () => {
    // The chat sidebar and the management collection pane are the same
    // 312pt shelf in the same slot, but they wore different surface roles,
    // so one sat a step deeper than the other and the two areas stopped
    // looking like one product. navigationSurface belongs to the narrow
    // icon rail alone.
    const read = (...parts: string[]) =>
      readFileSync(join(process.cwd(), "src", "ui", ...parts), "utf8");
    const styleOf = (source: string, name: string) =>
      new RegExp(`^ {2}${name}: \\{\\n([\\s\\S]*?)^ {2}\\},$`, "mu").exec(
        source,
      )?.[1] ?? "";

    const shell = read("layouts", "workspace-shell.tsx");
    const management = read("components", "management-workspace.tsx");
    const panes = [
      styleOf(shell, "conversationSidebar"),
      styleOf(management, "collectionPane"),
    ];

    for (const pane of panes) {
      expect(pane).toContain("semantic.color.sidebarSurface");
    }
    expect(styleOf(read("layouts", "app-frame.tsx"), "serverRail")).toContain(
      "semantic.color.navigationSurface",
    );
    expect(management).not.toContain("semantic.color.navigationSurface");
  });

  it("cuts every shelf row to the same selection shape", () => {
    // Channels were square and full-bleed, direct messages were square with a
    // rule under each one, and the management collection was an inset rounded
    // pill. Three treatments of one row, in one shelf.
    const read = (...parts: string[]) =>
      readFileSync(join(process.cwd(), "src", "ui", ...parts), "utf8");
    const styleOf = (source: string, name: string) =>
      new RegExp(`^ {2}${name}: \\{\\n([\\s\\S]*?)^ {2}\\},$`, "mu").exec(
        source,
      )?.[1] ?? "";

    const shell = read("layouts", "workspace-shell.tsx");
    const management = read("components", "management-workspace.tsx");
    const rows = [
      styleOf(shell, "channelButton"),
      styleOf(shell, "channelButtonSelected"),
      styleOf(shell, "directButton"),
      styleOf(shell, "directButtonSelected"),
      styleOf(management, "collectionRow"),
    ];

    for (const row of rows) {
      expect(row).toContain("semantic.radius.compactControl");
      expect(row).not.toMatch(/border(?:Bottom|Top)Width/u);
    }
    for (const list of [styleOf(shell, "channelList"), styleOf(shell, "directList")]) {
      expect(list).toContain("paddingHorizontal: theme.spacing.sm");
    }
  });

  it("sizes a control off the density scale, not the reach floor", () => {
    // minimumTargetSize is a floor — "a finger needs 44pt" — not a measurement
    // — "this control is 44pt". Twenty-one styles read it as the latter and so
    // stood 48 tall at every density, on a desktop whose control scale says 30
    // and whose fields say 32: the choice chips loomed over the Save button
    // beside them, and the terminal's inputs over its own. Heights come from
    // density now; the floor is what density.test.ts measures them against.
    const uiRoot = join(process.cwd(), "src", "ui");
    const misread = readdirSync(uiRoot, {recursive: true, encoding: "utf8"})
      .filter((name) => /\.tsx?$/u.test(name) && !/\.test\.|tokens\.ts$/u.test(name))
      .filter((name) =>
        readFileSync(join(uiRoot, name), "utf8").includes(
          "interaction.minimumTargetSize",
        ),
      );

    expect(misread).toEqual([]);
  });

  it("lets an identity mark's shape say what it stands for", () => {
    // The shape used to say which screen you were on: chat drew people as
    // circles and channels as tiles, management drew people, agents and
    // machines all as the same tile. Round means someone, square means
    // something.
    const management = readFileSync(
      join(process.cwd(), "src", "ui", "components", "management-workspace.tsx"),
      "utf8",
    );
    const styleOf = (name: string) =>
      new RegExp(`^ {2}${name}: \\{\\n([\\s\\S]*?)^ {2}\\},$`, "mu").exec(
        management,
      )?.[1] ?? "";

    for (const someone of [
      "collectionIdentityMarkAgent",
      "collectionIdentityMarkHuman",
    ]) {
      expect(styleOf(someone)).toContain("semantic.radius.circle");
    }
    expect(styleOf("collectionIdentityMark")).not.toContain(
      "semantic.radius.circle",
    );
  });

  it("does not let hand-rolled buttons regrow beside the shared one", () => {
    // The chat shell and the management screens each invented their own
    // vocabulary for the same handful of jobs, which is most of why the two
    // areas stopped looking like one product. `ActionButton` is the single
    // button; this ceiling makes adding a sixteenth local one a decision
    // rather than an accident, and it only moves down.
    const source = readFileSync(
      join(process.cwd(), "src", "ui", "layouts", "workspace-shell.tsx"),
      "utf8",
    );
    const pressableStyles = new Set<string>();
    for (const pressable of source.matchAll(/<Pressable\b[\s\S]{0,700}?\/?>/gu)) {
      for (const reference of pressable[0].matchAll(
        /styles\.([a-zA-Z][a-zA-Z0-9]*)/gu,
      )) {
        pressableStyles.add(reference[1]!);
      }
    }
    const boxed = [...pressableStyles].filter((name) => {
      const block = new RegExp(
        `^ {2}${name}: \\{\\n([\\s\\S]*?)^ {2}\\},$`,
        "mu",
      ).exec(source);
      return block ? /paddingHorizontal|minHeight|height:/u.test(block[1]!) : false;
    });

    // One is left: `sidebarHeader`, the Server switcher. It is pressable, but
    // it is a composite row — mark, name, member count — not a button wearing
    // a label, so folding it into the shared button would misdescribe it.
    //
    // Scope worth knowing: the pattern above stops at the first `>`, so a
    // Pressable that declares an arrow handler before its `style` prop is
    // invisible here. That leaves list rows, rail items and segmented
    // controls out, which suits this assertion — none of them are buttons.
    expect(boxed).toEqual(["sidebarHeader"]);
  });

  it("carries the transition on both halves of every interaction pair", () => {
    // Variant styles replace the base rather than layering over it, so a
    // transition declared only on the base is dropped the moment the element
    // becomes selected. That is exactly how the selected row stayed a hard cut
    // while every other row animated.
    const suffixes = [
      "Selected",
      "Active",
      "Pressed",
      "Hover",
      "Hovered",
      "Focused",
      "Disabled",
    ];
    const files = [
      ["components", "management-workspace.tsx"],
      ["components", "message-composer.tsx"],
      ["components", "message-list.tsx"],
      ["layouts", "workspace-shell.tsx"],
      ["primitives", "action-button.tsx"],
      ["screens", "first-workspace-screen.tsx"],
    ];
    const missing: string[] = [];

    for (const parts of files) {
      const source = readFileSync(join(process.cwd(), "src", "ui", ...parts), "utf8");
      const blocks = new Map<string, string>();
      for (const match of source.matchAll(
        /^ {2}([a-zA-Z][a-zA-Z0-9]*): \{\n([\s\S]*?)^ {2}\},$/gmu,
      )) {
        blocks.set(match[1]!, match[2]!);
      }
      // A variant is not always `base + suffix`: the primary button's states
      // are `actionPrimaryHover`, so an importance word can sit between the
      // two. Matching on bare prefixes instead would drag in neighbours that
      // merely share an opening word, like `image` and `imagePreviewTrigger`.
      const paired = new Set<string>();
      for (const name of blocks.keys()) {
        const suffix = suffixes.find((candidate) => name.endsWith(candidate));
        if (!suffix) continue;
        // The variant always needs the transition, even where its base is
        // named something this rule cannot derive.
        paired.add(name);
        const stem = name.slice(0, -suffix.length);
        const base = blocks.has(stem)
          ? stem
          : [...stem.matchAll(/[A-Z][a-z0-9]*/gu)]
              .map((word) => stem.slice(0, word.index))
              .findLast((candidate) => blocks.has(candidate));
        if (base !== undefined) paired.add(base);
      }

      for (const name of paired) {
        if (!blocks.get(name)!.includes("semantic.motion.transition")) {
          missing.push(`${parts[1]}:${name}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("keeps transient visual timing in semantic motion tokens", () => {
    const messageSource = readFileSync(
      join(process.cwd(), "src", "ui", "components", "message-list.tsx"),
      "utf8",
    );
    const shellSource = readFileSync(
      join(process.cwd(), "src", "ui", "layouts", "workspace-shell.tsx"),
      "utf8",
    );

    expect(messageSource).toContain("semantic.motion.dismissal.focusHighlight");
    expect(messageSource).not.toContain("2_400");
    expect(shellSource).toContain("semantic.motion.dismissal.toast");
    expect(shellSource).not.toContain("CHAT_ERROR_TOAST_DURATION_MS");
  });

  it("keeps controls and feedback on semantic roles instead of brand or layout aliases", () => {
    const requiredRoles: Array<[string, string, string[]]> = [
      ["screens/auth-screen.tsx", "primaryButton", ["actionPrimarySurface"]],
      ["screens/auth-screen.tsx", "primaryButtonText", ["actionPrimaryText"]],
      ["screens/first-workspace-screen.tsx", "primaryButton", ["actionPrimarySurface"]],
      ["screens/first-workspace-screen.tsx", "primaryButtonText", ["actionPrimaryText"]],
      ["components/route-status-screen.tsx", "action", ["actionPrimarySurface"]],
      ["components/route-status-screen.tsx", "actionText", ["actionPrimaryText"]],
      ["components/message-composer.tsx", "sendButton", ["actionPrimarySurface"]],
      ["components/message-composer.tsx", "mentionButton", ["actionSecondarySurface"]],
      ["components/message-composer.tsx", "attachmentPickerButton", ["actionSecondarySurface"]],
      ["components/message-viewport/message-viewport.tsx", "newMessagesBadge", ["notificationBadgeSurface"]],
      ["components/message-viewport/message-viewport.tsx", "newMessagesBadgeText", ["notificationBadgeText"]],
      ["components/thread-panel.tsx", "indexWarning", ["statusWarningSurface", "statusWarningDivider"]],
      ["layouts/workspace-shell.tsx", "reconnectNotice", ["statusInfoSurface", "statusInfoDivider"]],
      ["layouts/workspace-shell.tsx", "unreadBadge", ["statusInfoSurface"]],
      ["layouts/workspace-shell.tsx", "messageHeaderIcon", ["iconAccentSurface"]],
      ["layouts/workspace-shell.tsx", "compactServerInitial", ["avatarServerSurface"]],
      ["layouts/workspace-shell.tsx", "channelMemberConfirmSubmit", ["actionDangerEmphasisSurface"]],
      ["layouts/workspace-shell.tsx", "channelMemberRemove", ["actionDangerTonalSurface"]],
    ];
    const offenders = requiredRoles.flatMap(([relativePath, styleName, roles]) => {
      const source = readFileSync(
        join(process.cwd(), "src", "ui", relativePath),
        "utf8",
      );
      const block = source.match(
        new RegExp(`\\n  ${styleName}: \\{([\\s\\S]*?)\\n  \\},`),
      )?.[1] ?? "";
      return roles.every((role) => block.includes(`semantic.color.${role}`))
        ? []
        : [`${relativePath}:${styleName}`];
    });

    expect(offenders).toEqual([]);
  });

  it("separates quiet actions, fields and disabled feedback from muted content", () => {
    const requiredRoles: Array<[string, string, string[]]> = [
      ["components/operation-status-list.tsx", "button", ["actionQuietSurface"]],
      ["components/thread-panel.tsx", "indexRetry", ["actionQuietSurface"]],
      ["components/terminal-panel.tsx", "button", ["actionQuietSurface"]],
      ["components/terminal-panel.tsx", "controlButton", ["actionQuietSurface"]],
      ["components/terminal-panel.tsx", "input", ["fieldSurface"]],
      ["components/message-list.tsx", "loadOlderButton", ["actionQuietSurface"]],
      ["components/message-composer.tsx", "sendButtonDisabled", ["actionDisabledSurface"]],
      ["layouts/workspace-shell.tsx", "channelInput", ["fieldSurface"]],
      ["layouts/workspace-shell.tsx", "channelVisibilityButton", ["actionQuietSurface"]],
      ["layouts/workspace-shell.tsx", "compactChannelButton", ["actionQuietSurface"]],
      ["layouts/workspace-shell.tsx", "compactServerButton", ["actionQuietSurface"]],
      ["layouts/workspace-shell.tsx", "searchInput", ["fieldSurface"]],
    ];
    const offenders = requiredRoles.flatMap(([relativePath, styleName, roles]) => {
      const source = readFileSync(
        join(process.cwd(), "src", "ui", relativePath),
        "utf8",
      );
      const block = source.match(
        new RegExp(`\\n  ${styleName}: \\{([\\s\\S]*?)\\n  \\},`),
      )?.[1] ?? "";
      return roles.every((role) => block.includes(`semantic.color.${role}`)) &&
        !block.includes("semantic.color.surfaceSubtle")
        ? []
        : [`${relativePath}:${styleName}`];
    });

    expect(offenders).toEqual([]);
  });

  it("keeps non-action accents on content roles instead of action tonal roles", () => {
    const requiredRoles: Array<[string, string, string[]]> = [
      ["layouts/workspace-shell.tsx", "directPickerEmptyIcon", ["iconAccentSurface"]],
      ["components/message-composer.tsx", "mentionButtonSelected", ["selectionSurface"]],
      ["components/message-list.tsx", "emptyOrbit", ["iconAccentSurface"]],
      ["components/message-list.tsx", "historyLoadingIndicator", ["iconAccentSurface"]],
      ["components/message-list.tsx", "messageFocused", ["selectionSurface"]],
      ["components/message-list.tsx", "quote", ["borderAccent"]],
      ["components/message-list.tsx", "reactionActive", ["selectionSurface"]],
      ["components/message-list.tsx", "taskCard", ["surfaceSubtle"]],
    ];
    const offenders = requiredRoles.flatMap(([relativePath, styleName, roles]) => {
      const source = readFileSync(
        join(process.cwd(), "src", "ui", relativePath),
        "utf8",
      );
      const block = source.match(
        new RegExp(`\\n  ${styleName}: \\{([\\s\\S]*?)\\n  \\},`),
      )?.[1] ?? "";
      return roles.every((role) => block.includes(`semantic.color.${role}`)) &&
        !block.includes("semantic.color.actionTonal")
        ? []
        : [`${relativePath}:${styleName}`];
    });
    const messageListSource = readFileSync(
      join(process.cwd(), "src", "ui", "components", "message-list.tsx"),
      "utf8",
    );
    if (/\n  avatarOutgoing: \{/u.test(messageListSource)) {
      offenders.push("components/message-list.tsx:avatarOutgoing");
    }

    expect(offenders).toEqual([]);
  });

  it("keeps static information, badges and commands off selection semantics", () => {
    const requiredRoles: Array<[string, string, string[], string[]]> = [
      ["components/terminal-panel.tsx", "sendButton", ["actionTonalSurface"], ["selectionSurface"]],
      ["layouts/workspace-shell.tsx", "compactPickerButton", ["actionTonalSurface"], ["selectionSurface"]],
      ["layouts/workspace-shell.tsx", "channelMembershipContext", ["statusInfoSurface", "statusInfoDivider"], ["selectionSurface"]],
      ["layouts/workspace-shell.tsx", "channelKindBadge", ["statusInfoSurface"], ["selectionSurface"]],
    ];
    const offenders = requiredRoles.flatMap(
      ([relativePath, styleName, required, forbidden]) => {
        const source = readFileSync(
          join(process.cwd(), "src", "ui", relativePath),
          "utf8",
        );
        const block = source.match(
          new RegExp(`\\n  ${styleName}: \\{([\\s\\S]*?)\\n  \\},`),
        )?.[1] ?? "";
        return required.every((role) => block.includes(`semantic.color.${role}`)) &&
          forbidden.every((role) => !block.includes(`semantic.color.${role}`))
          ? []
          : [`${relativePath}:${styleName}`];
      },
    );

    expect(offenders).toEqual([]);
  });

  it("keeps decorative and badge offsets in identity and status recipes", () => {
    const requiredRecipes: Array<[string, string, string[]]> = [
      ["components/brand-mark.tsx", "highlight", ["identity.brandHighlightOffsetX", "identity.brandHighlightOffsetY"]],
      ["components/message-viewport/message-viewport.tsx", "newMessagesBadge", ["status.notificationBadgeOffset"]],
    ];
    const offenders = requiredRecipes.flatMap(([relativePath, styleName, recipes]) => {
      const source = readFileSync(
        join(process.cwd(), "src", "ui", relativePath),
        "utf8",
      );
      const block = source.match(
        new RegExp(`\\n  ${styleName}: \\{([\\s\\S]*?)\\n  \\},`),
      )?.[1] ?? "";
      return recipes.every((recipe) => block.includes(`recipes.${recipe}`))
        ? []
        : [`${relativePath}:${styleName}`];
    });

    expect(offenders).toEqual([]);
  });

  it("keeps Web terminal layout and warning feedback on semantic tokens", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "ui", "components", "terminal-panel.web.tsx"),
      "utf8",
    );
    const warningBlock = source.match(/\n  warning: \{([\s\S]*?)\n  \},/u)?.[1] ?? "";

    expect(source).not.toContain('padding: "0 16px"');
    expect(source).not.toContain('height: "calc(100dvh - 184px)"');
    expect(source).not.toContain('margin: "clamp(16px, 2vw, 24px)"');
    expect(source).toContain("recipes.terminalPanel.viewportChromeOffset");
    expect(warningBlock).toContain("semantic.color.statusWarningSurface");
    expect(warningBlock).toContain("semantic.color.statusWarningText");
    expect(warningBlock).not.toContain("semantic.color.statusDanger");
  });

  it("keeps repeated identity, dense-control and content geometry in component recipes", () => {
    const requiredRecipes: Array<[string, string, string[]]> = [
      ["layouts/app-frame.tsx", "accountRailButton", ["identity.avatarAccountSize"]],
      ["layouts/workspace-shell.tsx", "directAvatar", ["identity.avatarRowSize"]],
      ["layouts/workspace-shell.tsx", "channelMemberAvatar", ["identity.avatarRowSize"]],
      ["layouts/app-frame.tsx", "humanAvatar", ["identity.avatarProminentSize"]],
      ["layouts/app-frame.tsx", "humanAvatarStatus", ["identity.presenceDotSize"]],
      ["layouts/app-frame.tsx", "serverMark", ["identity.avatarNavigationSize"]],
      ["components/message-list.tsx", "avatar", ["identity.avatarCompactSize"]],
      ["components/message-list.tsx", "avatarCompact", ["identity.avatarRowSize"]],
      ["components/user-picker.tsx", "searchClear", ["iconControl.compactSize"]],
      ["layouts/workspace-shell.tsx", "headerActionButton", ["iconControl.smallSize"]],
      ["components/message-list.tsx", "messageText", ["contentMeasure.messageMaxWidth"]],
      ["components/message-list.tsx", "quote", ["contentMeasure.readingMaxWidth"]],
      ["layouts/workspace-shell.tsx", "chatErrorToast", ["contentMeasure.noticeMaxWidth"]],
    ];
    const offenders = requiredRecipes.flatMap(([relativePath, styleName, recipes]) => {
      const source = readFileSync(
        join(process.cwd(), "src", "ui", relativePath),
        "utf8",
      );
      const block = source.match(
        new RegExp(`\\n  ${styleName}: \\{([\\s\\S]*?)\\n  \\},`),
      )?.[1] ?? "";
      return recipes.every((recipe) => block.includes(`recipes.${recipe}`))
        ? []
        : [`${relativePath}:${styleName}`];
    });

    expect(offenders).toEqual([]);
  });

  it("keeps empty, overlay, status and timeline geometry in semantic recipes", () => {
    const requiredRecipes: Array<[string, string, string[]]> = [
      ["components/management-workspace.tsx", "collectionPaneHorizontal", ["managementWorkspace.collectionCompactHeight"]],
      ["components/management-workspace.tsx", "collectionRowHorizontal", ["managementWorkspace.collectionCompactRowWidth", "managementWorkspace.rowMinHeight"]],
      ["components/management-workspace.tsx", "empty", ["emptyState.stageMinHeight"]],
      ["components/management-workspace.tsx", "emptyCopy", ["contentMeasure.compactMaxWidth"]],
      ["components/management-workspace.tsx", "emptyIcon", ["emptyState.iconSize"]],
      ["components/management-workspace.tsx", "feedback", ["status.inlineMinHeight"]],
      ["components/management-workspace.tsx", "feedbackDot", ["identity.statusDotSize"]],
      ["components/management-workspace.tsx", "resourceActionCopy", ["managementWorkspace.resourceActionCopyMinWidth"]],
      ["components/management-workspace.tsx", "resourceActionRow", ["managementWorkspace.resourceActionMinHeight"]],
      ["components/management-workspace.tsx", "recordIdentityHeader", ["resourceIdentity.headerPaddingBottom"]],
      ["components/management-workspace.tsx", "resourceFact", ["resourceIdentity.factMinHeight", "resourceIdentity.factMinWidth"]],
      ["components/management-workspace.tsx", "resourceIdentityHeader", ["resourceIdentity.headerPaddingBottom"]],
      ["components/management-workspace.tsx", "resourceIdentityMark", ["resourceIdentity.markSize"]],
      ["components/management-workspace.tsx", "status", ["status.chipMinHeight"]],
      ["components/message-list.tsx", "attachment", ["contentMeasure.compactMaxWidth", "messageTimeline.attachmentMinWidth"]],
      ["components/message-list.tsx", "emptyConversation", ["emptyState.timelineMinHeight"]],
      ["components/message-list.tsx", "emptyOrbit", ["emptyState.orbitSize"]],
      ["components/message-list.tsx", "emptyOrbitCore", ["emptyState.orbitCoreSize"]],
      ["components/message-list.tsx", "emptyOrbitRing", ["emptyState.orbitRingSize"]],
      ["components/message-list.tsx", "historyLoading", ["emptyState.loadingMinHeight"]],
      ["components/message-list.tsx", "image", ["messageTimeline.imageMaxHeight"]],
      ["components/message-list.tsx", "moreActionButtonPointer", ["messageTimeline.pointerActionSize"]],
      ["components/message-list.tsx", "moreActionButtonCompact", ["messageTimeline.touchActionSize"]],
      ["components/message-list.tsx", "taskCard", ["messageTimeline.taskCardMaxWidth", "messageTimeline.taskCardMinHeight", "messageTimeline.taskCardMinWidth"]],
      ["layouts/app-frame.tsx", "accountPopover", ["overlay.accountMenuWidth"]],
      ["layouts/workspace-shell.tsx", "channelManagementPanel", ["overlay.contextPanelMinWidth", "overlay.contextPanelWidth"]],
      ["layouts/workspace-shell.tsx", "channelMemberConfirmDialog", ["overlay.confirmDialogMaxWidth"]],
      ["layouts/workspace-shell.tsx", "searchPanel", ["overlay.searchPanelMaxHeight"]],
      ["layouts/app-frame.tsx", "serverMarksScroller", ["overlay.serverListMaxHeight"]],
      ["layouts/app-frame.tsx", "accountStatusDot", ["identity.statusDotSize"]],
      ["layouts/workspace-shell.tsx", "directButton", ["conversationWorkspace.directRowMinHeight"]],
      ["layouts/workspace-shell.tsx", "directButtonSelected", ["conversationWorkspace.directRowMinHeight"]],
      ["layouts/workspace-shell.tsx", "unreadBadge", ["status.badgeMinSize"]],
      ["layouts/workspace-shell.tsx", "channelMemberAdd", ["iconControl.denseSize"]],
      ["layouts/workspace-shell.tsx", "channelMemberConfirmMark", ["emptyState.iconSize"]],
      ["layouts/workspace-shell.tsx", "channelMemberRemove", ["iconControl.denseSize"]],
      ["layouts/workspace-shell.tsx", "channelIcon", ["iconControl.denseSize"]],
      ["layouts/workspace-shell.tsx", "channelKindBadge", ["status.badgeMinSize"]],
      ["layouts/workspace-shell.tsx", "channelTextarea", ["managementWorkspace.textareaMinHeight"]],
      ["layouts/workspace-shell.tsx", "compactDirectorySearchClear", ["iconControl.compactSize"]],
      ["layouts/workspace-shell.tsx", "compactServerInitial", ["identity.avatarCompactSize"]],
      ["layouts/workspace-shell.tsx", "connectionDot", ["identity.connectionDotSize"]],
      ["layouts/workspace-shell.tsx", "chatErrorToastClose", ["iconControl.compactSize"]],
      ["layouts/workspace-shell.tsx", "chatErrorToastIcon", ["iconControl.compactSize"]],
      ["layouts/workspace-shell.tsx", "messageHeaderIcon", ["iconControl.denseSize"]],
      ["layouts/workspace-shell.tsx", "onlineAgentsDot", ["identity.statusDotSize"]],
      ["layouts/app-frame.tsx", "railNavigationItem", ["identity.avatarAccountSize"]],
      ["layouts/app-frame.tsx", "railTooltip", ["iconControl.compactSize"]],
      ["layouts/workspace-shell.tsx", "searchResult", ["managementWorkspace.rowMinHeight"]],
      ["layouts/workspace-shell.tsx", "sidebarHeaderIcon", ["identity.avatarNavigationSize"]],
      ["layouts/workspace-shell.tsx", "sidebarSearchClear", ["iconControl.microSize"]],
      ["layouts/app-frame.tsx", "accountLogoutButton", ["control.height"]],
      ["layouts/workspace-shell.tsx", "channelMemberRow", ["conversationWorkspace.channelMemberRowMinHeight"]],
      ["layouts/workspace-shell.tsx", "channelVisibilityButton", ["control.height"]],
      ["layouts/workspace-shell.tsx", "compactChannelButton", ["compactWorkspace.listRowMinHeight"]],
      ["layouts/workspace-shell.tsx", "compactServerButton", ["compactWorkspace.switcherRowMinHeight"]],
      ["layouts/workspace-shell.tsx", "chatErrorToast", ["status.toastMinHeight"]],
      ["layouts/workspace-shell.tsx", "reconnectNotice", ["status.bannerMinHeight"]],
      ["layouts/workspace-shell.tsx", "onlineAgentsBadge", ["status.summaryMinHeight"]],
      ["screens/auth-screen.tsx", "formPanel", ["contentMeasure.readingMaxWidth"]],
      ["screens/auth-screen.tsx", "input", ["authWorkspace.controlHeight"]],
      ["screens/auth-screen.tsx", "primaryButton", ["authWorkspace.primaryActionHeight"]],
      ["screens/first-workspace-screen.tsx", "copy", ["contentMeasure.readingMaxWidth"]],
      ["screens/first-workspace-screen.tsx", "input", ["authWorkspace.controlHeight"]],
      ["screens/first-workspace-screen.tsx", "primaryButton", ["authWorkspace.primaryActionHeight"]],
      ["screens/first-workspace-screen.tsx", "shell", ["authWorkspace.compactPanelMaxWidth"]],
      ["components/thread-panel.tsx", "panel", ["overlay.threadPanelMinWidth", "overlay.threadPanelWidth"]],
      ["components/message-composer.tsx", "composer", ["conversationWorkspace.composerSurfaceMinHeight"]],
      ["components/message-composer.tsx", "input", ["conversationWorkspace.composerInputMaxHeight"]],
      ["components/terminal-panel.tsx", "controlButton", ["terminalPanel.controlMinWidth"]],
      ["components/terminal-panel.tsx", "output", ["terminalPanel.outputMinHeight"]],
      ["components/terminal-panel.tsx", "outputBody", ["terminalPanel.outputMinHeight"]],
      ["components/terminal-panel.web.tsx", "panel", ["terminalPanel.panelMinHeight"]],
      ["components/operation-status-list.tsx", "list", ["contentMeasure.messageMaxWidth"]],
      ["components/route-status-screen.tsx", "surface", ["contentMeasure.readingMaxWidth"]],
      ["components/message-list.tsx", "loadOlderButton", ["messageTimeline.touchActionSize"]],
      ["components/user-picker.tsx", "sectionEmpty", ["managementWorkspace.rowMinHeight"]],
      ["components/message-viewport/message-viewport.tsx", "newMessagesBadge", ["status.notificationBadgeSize"]],
      ["components/brand-mark.tsx", "highlight", ["identity.brandHighlightSize"]],
      ["components/brand-mark.tsx", "mark", ["identity.brandMarkSize"]],
      ["components/brand-mark.tsx", "markCompact", ["emptyState.iconSize"]],
      ["components/management-workspace.tsx", "codeBlock", ["contentMeasure.codeBlockMaxHeight"]],
      ["components/management-workspace.tsx", "collectionIdentityMark", ["managementWorkspace.collectionAvatarSize"]],
      ["components/management-workspace.tsx", "collectionIdentityPresence", ["identity.presenceDotSize"]],
    ];
    const offenders = requiredRecipes.flatMap(([relativePath, styleName, recipes]) => {
      const source = readFileSync(
        join(process.cwd(), "src", "ui", relativePath),
        "utf8",
      );
      const block = source.match(
        new RegExp(`\\n  ${styleName}: \\{([\\s\\S]*?)\\n  \\},`),
      )?.[1] ?? "";
      return recipes.every((recipe) => block.includes(`recipes.${recipe}`))
        ? []
        : [`${relativePath}:${styleName}`];
    });

    expect(offenders).toEqual([]);
  });
});
