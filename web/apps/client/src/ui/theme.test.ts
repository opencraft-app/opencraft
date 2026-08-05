import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  breakpoints,
  computerSupportStackBreakpoint,
  velaTheme,
} from "./theme";
import { interfaceFontFamilies } from "./tokens";

function runtimeUiFiles(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const path = join(directory, entry);
      return statSync(path).isDirectory() ? runtimeUiFiles(path) : [path];
    })
    .filter((path) => /\.(?:ts|tsx)$/.test(path))
    .filter(
      (path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"),
    );
}

describe("Vela universal theme", () => {
  it("uses the approved HeroUI light semantic tokens", () => {
    expect(velaTheme).not.toHaveProperty("colors");
    expect(velaTheme).not.toHaveProperty("fonts");
    expect(velaTheme).not.toHaveProperty("radii");
    expect(velaTheme).not.toHaveProperty("sizes");
    expect(velaTheme.shadows).toEqual({
      card: {
        color: "rgba(0, 0, 0, 0.04)",
        offsetY: 2,
        opacity: 1,
        radius: 4,
      },
      floatingControl: {
        color: "rgba(0, 0, 0, 0.04)",
        offsetY: 2,
        opacity: 1,
        radius: 4,
      },
      overlay: {
        color: "rgba(24, 24, 27, 0.08)",
        offsetY: 4,
        opacity: 1,
        radius: 16,
      },
    });
    expect(velaTheme.spacing).toEqual({
      xxs: 2,
      xs: 4,
      sm: 8,
      md: 12,
      lg: 16,
      xl: 24,
      xxl: 32,
    });
    expect(velaTheme.terminal).toEqual({
      cssFont: "13px/18px 'Space Mono', ui-monospace, monospace",
      cursor: "#6E9CFF",
      initialRows: 24,
      scrollbackLines: 5000,
      selection: "#006FEE55",
      surface: "#0D1117",
      text: "#E6EDF3",
      textStyle: {
        fontFamily: "'Space Mono', ui-monospace, monospace",
        fontSize: 13,
        lineHeight: 18,
      },
      xtermOptions: {
        fontFamily: "'Space Mono', ui-monospace, monospace",
        fontSize: 13,
      },
    });
    expect(interfaceFontFamilies.native).toBe("System");
    expect(interfaceFontFamilies.web).toContain('"PingFang SC"');
    expect(interfaceFontFamilies.web).toContain("system-ui");
    expect(interfaceFontFamilies.web).toContain("sans-serif");
  });

  it("defines the restrained desktop workspace through semantic roles and one recipe", () => {
    expect(velaTheme.semantic).toEqual({
      color: {
        actionDangerBorder: "#F31260",
        actionDangerEmphasisSurface: "#F31260",
        actionDangerEmphasisText: "#FFFFFF",
        actionDisabledSurface: "#F4F4F5",
        actionDisabledText: "#A1A1AA",
        actionPrimarySurface: "#006FEE",
        actionPrimaryHoverSurface: "#005BC4",
        actionPrimaryPressedSurface: "#004493",
        actionPrimaryText: "#FFFFFF",
        actionDangerSurface: "transparent",
        actionDangerText: "#F31260",
        actionDangerTonalSurface: "#FFF1F5",
        actionSecondaryBorder: "rgba(24, 24, 27, 0.08)",
        actionSecondaryHoverSurface: "#F4F4F5",
        actionSecondaryPressedSurface: "#E4E4E7",
        actionSecondarySurface: "#FFFFFF",
        actionSecondaryText: "#18181B",
        actionQuietSurface: "#F4F4F5",
        actionDangerHoverSurface: "#FFF1F5",
        actionDangerPressedSurface: "#FDD8E5",
        actionTonalSurface: "#EAF4FF",
        actionTonalHoverSurface: "#DDEEFF",
        actionTonalPressedSurface: "#CFE7FF",
        actionTonalText: "#005BC4",
        avatarAccountSurface: "#7828C8",
        avatarAgentSurface: "#17C964",
        avatarAgentText: "#18181B",
        avatarPeerSurface: "#E7F7EE",
        avatarPeerText: "#50846B",
        avatarServerSurface: "#006FEE",
        avatarServerText: "#FFFFFF",
        avatarHumanGreenBorder: "rgba(80, 132, 107, 0.08)",
        avatarHumanGreenSurface: "#E7F7EE",
        avatarHumanGreenText: "#50846B",
        avatarHumanOrangeBorder: "rgba(177, 106, 79, 0.08)",
        avatarHumanOrangeSurface: "#FFF0EA",
        avatarHumanOrangeText: "#B16A4F",
        avatarHumanVioletBorder: "rgba(102, 100, 201, 0.08)",
        avatarHumanVioletSurface: "#EEF0FF",
        avatarHumanVioletText: "#6664C9",
        borderControl: "rgba(24, 24, 27, 0.08)",
        borderDanger: "rgba(243, 18, 96, 0.18)",
        borderDangerStrong: "rgba(243, 18, 96, 0.58)",
        borderAccent: "#006FEE",
        borderInteractive: "rgba(0, 111, 238, 0.18)",
        borderFocus: "rgba(0, 111, 238, 0.42)",
        borderOverlay: "rgba(24, 24, 27, 0.08)",
        borderSelected: "rgba(0, 111, 238, 0.22)",
        borderSection: "rgba(24, 24, 27, 0.08)",
        borderTransparent: "transparent",
        brandAccent: "#006FEE",
        brandAccentStrong: "#005BC4",
        brandHighlight: "rgba(120, 40, 200, 0.76)",
        canvasSurface: "#FFFFFF",
        codeSurface: "#18181B",
        codeText: "#FFFFFF",
        decorativeAccentSurface: "#006FEE",
        fieldPlaceholder: "#A1A1AA",
        fieldSurface: "#F4F4F5",
        iconAccent: "#005BC4",
        iconAccentSurface: "#EAF4FF",
        iconInverse: "#FFFFFF",
        iconMuted: "#71717A",
        iconPrimary: "#18181B",
        iconSecondary: "#52525B",
        inverseSurface: "#18181B",
        interactiveHoverSurface: "#F4F4F5",
        interactivePressedSurface: "#E4E4E7",
        modalBackdrop: "rgba(9, 9, 11, 0.34)",
        navigationSurface: "#F4F4F5",
        notificationBadgeSurface: "#006FEE",
        notificationBadgeText: "#FFFFFF",
        overlaySurface: "#FFFFFF",
        overlayBackdrop: "rgba(10, 14, 24, 0.92)",
        overlayControlBorder: "rgba(255, 255, 255, 0.34)",
        paneSurface: "#FFFFFF",
        progressActiveSurface: "#006FEE",
        progressActiveText: "#FFFFFF",
        sectionSurface: "#FFFFFF",
        separator: "rgba(24, 24, 27, 0.08)",
        selectionSurface: "#EAF4FF",
        selectionHoverSurface: "#DDEEFF",
        selectionPressedSurface: "#CFE7FF",
        statusDanger: "#F31260",
        statusDangerDivider: "rgba(243, 18, 96, 0.12)",
        statusDangerSurface: "#FFF1F5",
        statusDangerText: "#F31260",
        statusNeutral: "#D4D4D8",
        statusNeutralSurface: "#F4F4F5",
        statusNeutralText: "#52525B",
        statusInfo: "#006FEE",
        statusInfoDivider: "rgba(0, 111, 238, 0.14)",
        statusInfoSurface: "#EAF4FF",
        statusInfoText: "#005BC4",
        statusPositive: "#17C964",
        statusPositiveDivider: "rgba(23, 201, 100, 0.14)",
        statusPositiveSurface: "#E9F9EF",
        statusPositiveText: "#0B7138",
        statusWarning: "#F5A524",
        statusWarningDivider: "rgba(245, 165, 36, 0.22)",
        statusWarningSurface: "#FFF7E6",
        statusWarningText: "#8A4B08",
        surfaceMuted: "#E4E4E7",
        surfaceSubtle: "#F4F4F5",
        surfaceTransparent: "transparent",
        textInverse: "#FFFFFF",
        textLink: "#005BC4",
        textMuted: "#71717A",
        textPrimary: "#18181B",
      },
      elevation: {
        overlay: 1,
      },
      interaction: {
        disabledOpacity: 0.5,
        focusRingOffset: 2,
        focusRingWidth: 2,
        hitTargetInset: 6,
        hitTargetInsetCompact: 2,
        longPressDelay: 350,
        minimumTargetSize: 48,
        pressedScale: 0.96,
        pressedScaleSubtle: 0.99,
      },
      icon: {
        size: {
          compact: 14,
          feature: 22,
          hero: 30,
          large: 20,
          medium: 18,
          small: 16,
        },
        stroke: {
          emphasis: 2,
          regular: 1.8,
          strong: 2.2,
        },
      },
      layer: {
        content: 1,
        docked: 30,
        overlay: 40,
        popover: 50,
        modal: 60,
        navigation: 80,
        tooltip: 200,
      },
      opacity: {
        contentEmphasized: 0.82,
        contentMuted: 0.72,
        contentSubtle: 0.62,
        decorativeSoft: 0.55,
        decorativeStrong: 0.88,
        inactive: 0.68,
      },
      motion: {
        focusHighlightDuration: 2400,
        toastDuration: 8000,
      },
      radius: {
        circle: 9999,
        compactControl: 8,
        control: 10,
        overlay: 20,
        pane: 0,
        pill: 9999,
        section: 16,
      },
      stroke: {
        accent: 3,
        hairline: 1,
        statusRing: 2,
      },
      typography: {
        authHeroTitle: {
          fontFamily: expect.anything(),
          fontSize: 44,
          fontWeight: "600",
          letterSpacing: -1.8,
          lineHeight: 50,
        },
        avatarLabel: {
          fontFamily: expect.anything(),
          fontSize: 15,
          fontWeight: "700",
          lineHeight: 20,
        },
        body: {
          fontFamily: expect.anything(),
          fontSize: 14,
          lineHeight: 21,
        },
        bodyCompact: {
          fontFamily: expect.anything(),
          fontSize: 13,
          lineHeight: 19,
        },
        bodyCompactEmphasis: {
          fontFamily: expect.anything(),
          fontSize: 13,
          fontWeight: "600",
          lineHeight: 19,
        },
        bodyEmphasis: {
          fontFamily: expect.anything(),
          fontSize: 14,
          fontWeight: "600",
          lineHeight: 21,
        },
        button: {
          fontFamily: expect.anything(),
          fontSize: 13,
          fontWeight: "600",
          lineHeight: 18,
        },
        bodySmall: {
          fontFamily: expect.anything(),
          fontSize: 12,
          lineHeight: 18,
        },
        bodySmallEmphasis: {
          fontFamily: expect.anything(),
          fontSize: 12,
          fontWeight: "600",
          lineHeight: 18,
        },
        brandGlyph: {
          fontFamily: expect.anything(),
          fontSize: 16,
          fontWeight: "600",
          lineHeight: 42,
        },
        brandMark: {
          fontFamily: expect.anything(),
          fontSize: 11,
          fontWeight: "600",
          letterSpacing: 0.4,
          lineHeight: 16,
        },
        brandMarkCompact: {
          fontFamily: expect.anything(),
          fontSize: 12,
          fontWeight: "600",
          letterSpacing: 0.4,
          lineHeight: 18,
        },
        caption: {
          fontFamily: expect.anything(),
          fontSize: 11,
          lineHeight: 16,
        },
        captionEmphasis: {
          fontFamily: expect.anything(),
          fontSize: 11,
          fontWeight: "600",
          lineHeight: 16,
        },
        composerInput: {
          fontFamily: expect.anything(),
          fontSize: 14,
          lineHeight: 20,
        },
        composerInputCompact: {
          fontFamily: expect.anything(),
          fontSize: 16,
          lineHeight: 22,
        },
        compactTitle: {
          fontFamily: expect.anything(),
          fontSize: 19,
          fontWeight: "600",
          lineHeight: 24,
        },
        controlGlyph: {
          fontFamily: expect.anything(),
          fontSize: 18,
          fontWeight: "600",
          lineHeight: 22,
        },
        detailTitle: {
          fontFamily: expect.anything(),
          fontSize: 28,
          fontWeight: "600",
          lineHeight: 34,
        },
        dialogTitle: {
          fontFamily: expect.anything(),
          fontSize: 20,
          fontWeight: "600",
          lineHeight: 26,
        },
        emptyMetric: {
          fontFamily: expect.anything(),
          fontSize: 72,
          fontWeight: "600",
          lineHeight: 72,
        },
        formMark: {
          fontFamily: expect.anything(),
          fontSize: 24,
          fontWeight: "600",
          lineHeight: 48,
        },
        eyebrow: {
          fontFamily: expect.anything(),
          fontSize: 11,
          fontWeight: "600",
          letterSpacing: 0.8,
          lineHeight: 16,
        },
        label: {
          fontFamily: expect.anything(),
          fontSize: 12,
          fontWeight: "600",
          lineHeight: 18,
        },
        lead: {
          fontFamily: expect.anything(),
          fontSize: 16,
          lineHeight: 24,
        },
        micro: {
          fontFamily: expect.anything(),
          fontSize: 9,
          lineHeight: 13,
        },
        microTracked: {
          fontFamily: expect.anything(),
          fontSize: 9,
          letterSpacing: 0.8,
          lineHeight: 13,
        },
        meta: {
          fontFamily: expect.anything(),
          fontSize: 11,
          lineHeight: 16,
        },
        navigationGlyph: {
          fontFamily: expect.anything(),
          fontSize: 16,
          lineHeight: 16,
        },
        navigationLabel: {
          fontFamily: expect.anything(),
          fontSize: 10,
          lineHeight: 14,
        },
        onboardingTitle: {
          fontFamily: expect.anything(),
          fontSize: 34,
          fontWeight: "600",
          lineHeight: 40,
        },
        overline: {
          fontFamily: expect.anything(),
          fontSize: 10,
          fontWeight: "600",
          letterSpacing: 1.2,
          lineHeight: 14,
        },
        pickerTitle: {
          fontFamily: expect.anything(),
          fontSize: 24,
          fontWeight: "600",
          lineHeight: 30,
        },
        railLabel: {
          fontFamily: expect.anything(),
          fontSize: 7,
          letterSpacing: 0.4,
          lineHeight: 10,
        },
        pageTitle: {
          fontFamily: expect.anything(),
          fontSize: 22,
          fontWeight: "600",
          lineHeight: 28,
        },
        sectionTitle: {
          fontFamily: expect.anything(),
          fontSize: 17,
          fontWeight: "600",
          lineHeight: 22,
        },
        serverInitial: {
          fontFamily: expect.anything(),
          fontSize: 15,
          lineHeight: 32,
        },
        stepBadge: {
          fontFamily: expect.anything(),
          fontSize: 10,
          fontWeight: "600",
          lineHeight: 28,
        },
        messageBody: {
          fontFamily: expect.anything(),
          fontSize: 15,
          lineHeight: 22,
        },
        messageMeta: {
          fontFamily: expect.anything(),
          fontSize: 12,
          lineHeight: 16,
        },
        messageSender: {
          fontFamily: expect.anything(),
          fontSize: 15,
          fontWeight: "600",
          lineHeight: 22,
        },
        tooltip: {
          fontFamily: expect.anything(),
          fontSize: 12,
          fontWeight: "600",
          lineHeight: 16,
        },
        workspaceTitle: {
          fontFamily: expect.anything(),
          fontSize: 16,
          fontWeight: "600",
          lineHeight: 22,
        },
      },
    });
    expect(velaTheme.recipes.desktopWorkspace).toEqual({
      composerHorizontalPadding: 16,
      composerMinHeight: 72,
      composerVerticalPadding: 12,
      conversationRowMinHeight: 56,
      headerHeight: 80,
      navigationControlSize: 44,
      navigationGap: 8,
      navigationTopInset: 12,
      railWidth: 72,
      sidebarWidth: 312,
    });
    expect(velaTheme.recipes.compactWorkspace).toEqual({
      bottomNavigationHeight: 68,
      composerMinHeight: 64,
      listRowMinHeight: 48,
      navigationItemMinWidth: 0,
      switcherRowMinHeight: 52,
    });
    expect(velaTheme.recipes.authWorkspace).toEqual({
      cardPadding: 40,
      compactPanelMaxWidth: 640,
      controlHeight: 48,
      desktopPadding: 48,
      desktopShellMaxWidth: 1260,
      heroGap: 64,
      primaryActionHeight: 52,
      sequenceLineHeight: 2,
      sequenceLineMaxWidth: 48,
      setupShellMaxWidth: 1160,
      statementFootMaxWidth: 370,
      statementMaxWidth: 620,
      statementMinHeight: 550,
    });
    expect(velaTheme.recipes.conversationWorkspace).toEqual({
      channelManagementActionMinWidth: 64,
      channelMemberRowMinHeight: 60,
      compactActionGap: 3,
      composerAttachmentMaxWidth: 260,
      composerAttachmentMinWidth: 190,
      composerDesktopMaxWidth: 860,
      composerInputMaxHeight: 112,
      composerMentionListOffset: 58,
      composerSuggestionMinHeight: 46,
      composerSurfaceMinHeight: 66,
      composerToolbarMinHeight: 52,
      directRowMinHeight: 64,
      messageActionHorizontalPadding: 6,
      messageIndent: 30,
      messageRowGap: 10,
      toastTopInset: 72,
    });
    expect(velaTheme.recipes.control).toEqual({
      height: 44,
      squareSize: 44,
    });
    expect(velaTheme.recipes.contentMeasure).toEqual({
      codeBlockMaxHeight: 180,
      compactMaxWidth: 440,
      messageMaxWidth: 760,
      noticeMaxWidth: 560,
      readingMaxWidth: 520,
    });
    expect(velaTheme.recipes.iconControl).toEqual({
      compactSize: 32,
      denseSize: 36,
      microSize: 28,
      smallSize: 38,
    });
    expect(velaTheme.recipes.identity).toEqual({
      avatarAccountSize: 52,
      avatarCompactSize: 32,
      avatarNavigationSize: 40,
      avatarProminentSize: 38,
      avatarRowSize: 36,
      brandHighlightOffsetX: -12,
      brandHighlightOffsetY: -14,
      brandHighlightSize: 38,
      brandMarkSize: 46,
      connectionDotSize: 9,
      presenceDotSize: 10,
      statusDotSize: 7,
    });
    expect(velaTheme.recipes.emptyState).toEqual({
      iconSize: 48,
      loadingMinHeight: 260,
      orbitCoreSize: 10,
      orbitRingSize: 38,
      orbitSize: 56,
      stageMinHeight: 280,
      timelineMinHeight: 300,
      workspaceMinHeight: 360,
    });
    expect(velaTheme.recipes.managementWorkspace).toEqual({
      actionHeight: 44,
      collectionActionHeight: 52,
      collectionCompactHeight: 96,
      collectionCompactRowWidth: 220,
      collectionAvatarSize: 40,
      collectionWidth: 312,
      compactPadding: 16,
      compactResourceIconSize: 48,
      contentMaxWidth: 960,
      desktopPadding: 32,
      detailGap: 24,
      emptyStateMaxWidth: 560,
      fieldCompactWidth: 160,
      fieldHeight: 48,
      formFieldMinWidth: 240,
      formMaxWidth: 900,
      headerActionHeight: 40,
      headerHeight: 64,
      mediumPadding: 24,
      resourceIconSize: 56,
      resourceActionCopyMinWidth: 180,
      resourceActionMinHeight: 72,
      rowMinHeight: 64,
      sectionGap: 16,
      sectionPadding: 20,
      switcherMenuMaxHeight: 232,
      switcherOptionMinHeight: 56,
      switcherTriggerMinHeight: 64,
      textareaMinHeight: 96,
    });
    expect(velaTheme.recipes.resourceIdentity).toEqual({
      factMinHeight: 64,
      factMinWidth: 140,
      headerPaddingBottom: 20,
      markSize: 48,
    });
    expect(velaTheme.recipes.messageTimeline).toEqual({
      attachmentMinWidth: 210,
      deliveryMinHeight: 18,
      imageMaxHeight: 320,
      pointerActionSize: 28,
      taskCardMaxWidth: 540,
      taskCardMinHeight: 58,
      taskCardMinWidth: 240,
      touchActionSize: 32,
    });
    expect(velaTheme.recipes.overlay).toEqual({
      accountPopoverBottomInset: 4,
      accountPopoverLeftInset: 66,
      accountMenuWidth: 280,
      confirmDialogMaxWidth: 420,
      contextPanelMinWidth: 320,
      contextPanelWidth: 392,
      previewControlInset: 20,
      railTooltipLeftInset: 58,
      railTooltipTopInset: 8,
      searchPanelMaxHeight: 310,
      serverListMaxHeight: 160,
      threadPanelMinWidth: 340,
      threadPanelWidth: 390,
    });
    expect(velaTheme.recipes.status).toEqual({
      badgeMinSize: 18,
      bannerMinHeight: 52,
      chipMinHeight: 28,
      inlineMinHeight: 36,
      notificationBadgeOffset: -6,
      notificationBadgeSize: 22,
      summaryMinHeight: 30,
      toastMinHeight: 48,
    });
    expect(velaTheme.recipes.taskWorkspace).toEqual({
      compactListMaxHeight: 196,
    });
    expect(velaTheme.recipes.terminalPanel).toEqual({
      controlMinWidth: 52,
      outputMinHeight: 260,
      panelMinHeight: 480,
      viewportChromeOffset: 184,
    });
  });

  it("uses the approved content-driven breakpoints", () => {
    expect(breakpoints).toEqual({
      compact: 0,
      medium: 768,
      narrow: 360,
      wide: 1180,
    });
    expect(computerSupportStackBreakpoint).toBe(1080);
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

  it("keeps every runtime UI file behind the semantic token boundary", () => {
    const runtimeFiles = runtimeUiFiles(join(process.cwd(), "src", "ui"))
      .filter((path) => !path.endsWith("tokens.ts"));
    const forbiddenPatterns = [
      /#[0-9a-f]{3,8}/iu,
      /rgba?\(/u,
      /theme\.colors\./u,
      /theme\.fonts\./u,
      /theme\.radii\./u,
      /(?:theme|velaTheme)\.sizes\./u,
      /semantic\.color\.(?:contentSurface|divider)\b/u,
      /"transparent"/u,
      /theme\.sizes\.(?:header|managementHeader)\b/u,
      /borderRadius\s*:\s*[\d_]+/u,
      /(?:border(?:Top|Right|Bottom|Left)?Width)\s*:\s*[1-9][\d_]*\b/u,
      /\bborder\s*:\s*`?1px\b/u,
      /opacity\s*:\s*0\.[0-9]+\b/u,
      /(?:fontFamily|fontSize|fontWeight|letterSpacing|lineHeight)\s*:/u,
      /(?:color\s*:\s*|color=\{)(?:theme|velaTheme)\.semantic\.color\.(?:contentSurface|navigationSurface|selectionSurface)/u,
      /backgroundColor\s*:\s*(?:theme|velaTheme)\.semantic\.color\.(?:textPrimary|textMuted|textInverse|iconPrimary|iconSecondary|iconMuted)/u,
      /\bsize=\{[^}\n]*\b\d+(?:\.\d+)?\b[^}\n]*\}/u,
      /\bstrokeWidth=\{[^}\n]*\b\d+(?:\.\d+)?\b[^}\n]*\}/u,
      /\bzIndex\s*:\s*[\d_]+/u,
      /shadowOpacity\s*:\s*(?:theme|velaTheme)\.semantic\.elevation\.(?:docked|pane|section)/u,
      /shadows\.(?:soft|surface)\b/u,
      /(?:height|minHeight|minWidth|width)\s*:\s*44\b/u,
      /(?:gap|rowGap|columnGap|margin(?:Top|Right|Bottom|Left|Horizontal|Vertical)?|padding(?:Top|Right|Bottom|Left|Horizontal|Vertical)?)\s*:\s*[1-9][\d_]*(?:\.\d+)?\b/u,
      /resolvedViewportWidth\s*[<>]=?\s*[\d_]+/u,
      /\bwidth\s*[<>]=?\s*[\d_]+/u,
      /const\s+[A-Za-z0-9_]*Breakpoint[A-Za-z0-9_]*\s*=\s*[\d_]+/u,
    ];
    const offenders = runtimeFiles.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return forbiddenPatterns.some((pattern) => pattern.test(source))
        ? [path.replace(`${process.cwd()}/`, "")]
        : [];
    });

    expect(offenders).toEqual([]);
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

    expect(messageSource).toContain("semantic.motion.focusHighlightDuration");
    expect(messageSource).not.toContain("2_400");
    expect(shellSource).toContain("semantic.motion.toastDuration");
    expect(shellSource).not.toContain("CHAT_ERROR_TOAST_DURATION_MS");
  });

  it("uses icon semantics instead of brand colors for rendered glyphs", () => {
    const offenders = runtimeUiFiles(join(process.cwd(), "src", "ui"))
      .filter((path) => !path.endsWith("tokens.ts"))
      .filter((path) =>
        /color=\{[\s\S]{0,320}?(?:theme|velaTheme)\.semantic\.color\.brandAccent(?:Strong)?/u.test(
          readFileSync(path, "utf8"),
        ),
      )
      .map((path) => path.replace(`${process.cwd()}/src/ui/`, ""));

    expect(offenders).toEqual([]);
  });

  it("reserves brand colors for identity marks and the visual reference lab", () => {
    const offenders = runtimeUiFiles(join(process.cwd(), "src", "ui"))
      .filter((path) => !path.endsWith("tokens.ts"))
      .filter((path) => !path.endsWith("brand-mark.tsx"))
      .filter((path) => !path.endsWith("style-lab-screen.tsx"))
      .filter((path) => /semantic\.color\.brandAccent(?:Strong)?\b/u.test(readFileSync(path, "utf8")))
      .map((path) => path.replace(`${process.cwd()}/src/ui/`, ""));

    expect(offenders).toEqual([]);
  });

  it("keeps repeated management geometry in the management recipe", () => {
    const managementScreens = [
      "agents-screen.tsx",
      "computers-screen.tsx",
      "members-screen.tsx",
      "tasks-screen.tsx",
    ];
    const duplicatedGeometry = [
      /maxWidth\s*:\s*(?:900|960)\b/u,
      /maxHeight\s*:\s*232\b/u,
      /(?:height|width)\s*:\s*(?:40|48|56|64)\b/u,
      /minWidth\s*:\s*240\b/u,
      /mobileSwitcherButton\s*:\s*\{[\s\S]*?minHeight\s*:\s*64\b/u,
      /mobileSwitcherOption\s*:\s*\{[\s\S]*?minHeight\s*:\s*56\b/u,
    ];
    const offenders = managementScreens.flatMap((relativePath) => {
      const source = readFileSync(
        join(process.cwd(), "src", "ui", "screens", relativePath),
        "utf8",
      );
      return duplicatedGeometry.some((pattern) => pattern.test(source))
        ? [relativePath]
        : [];
    });

    expect(offenders).toEqual([]);
  });

  it("reserves pill radius for status, tags and segmented choices", () => {
    const ordinaryActionStyles: Array<[string, string[]]> = [
      [
        "layouts/workspace-shell.tsx",
        [
          "channelMemberAdd",
          "channelMemberConfirmCancel",
          "channelMemberConfirmSubmit",
          "channelMemberRemove",
          "channelPanelSubmit",
          "directPickerEmptyAction",
          "reconnectButton",
          "searchMore",
          "searchSubmit",
          "sidebarSearchWrap",
        ],
      ],
      ["components/message-composer.tsx", ["mentionButton", "sendButton"]],
      ["components/message-list.tsx", ["loadOlderButton", "retryButton"]],
      ["components/route-status-screen.tsx", ["action"]],
      ["components/terminal-panel.tsx", ["button", "sendButton"]],
      ["components/terminal-panel.web.tsx", ["button"]],
      ["screens/first-workspace-screen.tsx", ["primaryButton"]],
      [
        "screens/style-lab-screen.tsx",
        ["canvasButton", "previewButton", "scenarioButton"],
      ],
    ];
    const offenders = ordinaryActionStyles.flatMap(([relativePath, names]) => {
      const source = readFileSync(
        join(process.cwd(), "src", "ui", relativePath),
        "utf8",
      );
      return names.flatMap((name) => {
        const block = source.match(
          new RegExp(`\\n  ${name}: \\{([\\s\\S]*?)\\n  \\},`),
        )?.[1];
        return block?.includes("semantic.radius.pill")
          ? [`${relativePath}:${name}`]
          : [];
      });
    });

    expect(offenders).toEqual([]);
  });

  it("allows shadows only on overlays, floating controls and account cards", () => {
    const shadowStyles = runtimeUiFiles(join(process.cwd(), "src", "ui"))
      .filter((path) => !path.endsWith("tokens.ts"))
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return Array.from(
          source.matchAll(/\n  ([A-Za-z0-9_]+): \{([\s\S]*?)\n  \},/gu),
        ).flatMap((match) =>
          /shadow(?:Color|Offset|Opacity|Radius)\s*:/u.test(match[2] ?? "")
            ? [
                `${path.replace(`${process.cwd()}/src/ui/`, "")}:${match[1] ?? "unknown"}`,
              ]
            : [],
        );
      })
      .sort();

    expect(shadowStyles).toEqual([
      "components/message-list.tsx:actionRowOpen",
      "components/message-viewport/message-viewport.tsx:newMessages",
      "layouts/workspace-shell.tsx:accountPopover",
      "layouts/workspace-shell.tsx:channelMemberConfirmDialog",
      "layouts/workspace-shell.tsx:railTooltip",
    ]);
  });

  it("does not bypass the HeroUI palette with stale literal colors", () => {
    const staleColors = [
      "#0088F8",
      "#006FCE",
      "#FF3B45",
      "#18B76A",
      "#7C3AED",
      "#ECECEE",
      "#6B6B73",
      "#285dff",
      "#172033",
      "#dfe3ec",
      "#765fed",
      "#f7f8fc",
      "#1C2740",
      "#eaf0ff",
      "#bfd0ff",
      "0, 136, 248",
    ];
    const offenders = runtimeUiFiles(join(process.cwd(), "src", "ui"))
      .filter((path) =>
        staleColors.some((color) => readFileSync(path, "utf8").includes(color)),
      )
      .map((path) => path.replace(`${process.cwd()}/`, ""));

    expect(offenders).toEqual([]);
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
      ["layouts/workspace-shell.tsx", "compactDirectNew", ["actionQuietSurface"]],
      ["layouts/workspace-shell.tsx", "compactLogout", ["actionQuietSurface"]],
      ["layouts/workspace-shell.tsx", "channelInput", ["fieldSurface"]],
      ["layouts/workspace-shell.tsx", "channelManagementButton", ["actionQuietSurface"]],
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

  it("keeps interaction timing, press feedback and hit targets in semantic tokens", () => {
    const forbiddenPatterns = [
      /delayLongPress=\{\d+\}/u,
      /hitSlop=\{\d+\}/u,
      /transform\s*:\s*\[\{\s*scale:\s*0\.[0-9]+\s*\}\]/u,
    ];
    const offenders = runtimeUiFiles(join(process.cwd(), "src", "ui"))
      .filter((path) => !path.endsWith("tokens.ts"))
      .filter((path) => !path.endsWith("style-lab-screen.tsx"))
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return forbiddenPatterns.some((pattern) => pattern.test(source));
      })
      .map((path) => path.replace(`${process.cwd()}/src/ui/`, ""));

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

  it("keeps production layout geometry in semantic recipes", () => {
    const geometryPattern = /\b(?:bottom|gap|height|left|margin(?:Bottom|Horizontal|Left|Right|Top|Vertical)?|maxHeight|maxWidth|minHeight|minWidth|padding(?:Bottom|Horizontal|Left|Right|Top|Vertical)?|right|rowGap|top|width)\s*:\s*[1-9][\d_]*(?:\.\d+)?\b/gu;
    const offenders = runtimeUiFiles(join(process.cwd(), "src", "ui"))
      .filter((path) => !path.endsWith("tokens.ts"))
      .filter((path) => !path.endsWith("style-lab-screen.tsx"))
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return Array.from(source.matchAll(geometryPattern)).map(
          (match) =>
            `${path.replace(`${process.cwd()}/src/ui/`, "")}:${match[0]}`,
        );
      });

    expect(offenders).toEqual([]);
  });

  it("keeps repeated identity, dense-control and content geometry in component recipes", () => {
    const requiredRecipes: Array<[string, string, string[]]> = [
      ["layouts/workspace-shell.tsx", "accountRailButton", ["identity.avatarAccountSize"]],
      ["layouts/workspace-shell.tsx", "directAvatar", ["identity.avatarRowSize"]],
      ["layouts/workspace-shell.tsx", "channelMemberAvatar", ["identity.avatarRowSize"]],
      ["layouts/workspace-shell.tsx", "humanAvatar", ["identity.avatarProminentSize"]],
      ["layouts/workspace-shell.tsx", "humanAvatarStatus", ["identity.presenceDotSize"]],
      ["layouts/workspace-shell.tsx", "serverMark", ["identity.avatarNavigationSize"]],
      ["components/message-list.tsx", "avatar", ["identity.avatarCompactSize"]],
      ["components/message-list.tsx", "avatarCompact", ["identity.avatarRowSize"]],
      ["components/user-picker.tsx", "searchClear", ["iconControl.compactSize"]],
      ["layouts/workspace-shell.tsx", "sidebarActionButton", ["iconControl.microSize"]],
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
      ["layouts/workspace-shell.tsx", "accountPopover", ["overlay.accountMenuWidth"]],
      ["layouts/workspace-shell.tsx", "channelManagementPanel", ["overlay.contextPanelMinWidth", "overlay.contextPanelWidth"]],
      ["layouts/workspace-shell.tsx", "channelMemberConfirmDialog", ["overlay.confirmDialogMaxWidth"]],
      ["layouts/workspace-shell.tsx", "searchPanel", ["overlay.searchPanelMaxHeight"]],
      ["layouts/workspace-shell.tsx", "serverMarksScroller", ["overlay.serverListMaxHeight"]],
      ["layouts/workspace-shell.tsx", "accountStatusDot", ["identity.statusDotSize"]],
      ["layouts/workspace-shell.tsx", "directButton", ["conversationWorkspace.directRowMinHeight"]],
      ["layouts/workspace-shell.tsx", "directButtonSelected", ["conversationWorkspace.directRowMinHeight"]],
      ["layouts/workspace-shell.tsx", "unreadBadge", ["status.badgeMinSize"]],
      ["layouts/workspace-shell.tsx", "channelMemberAdd", ["iconControl.denseSize"]],
      ["layouts/workspace-shell.tsx", "channelMemberConfirmMark", ["emptyState.iconSize"]],
      ["layouts/workspace-shell.tsx", "channelMemberRemove", ["iconControl.denseSize"]],
      ["layouts/workspace-shell.tsx", "channelPanelClose", ["iconControl.smallSize"]],
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
      ["layouts/workspace-shell.tsx", "headerMembersButton", ["iconControl.smallSize"]],
      ["layouts/workspace-shell.tsx", "railNavigationItem", ["identity.avatarAccountSize"]],
      ["layouts/workspace-shell.tsx", "railTooltip", ["iconControl.compactSize"]],
      ["layouts/workspace-shell.tsx", "searchResult", ["managementWorkspace.rowMinHeight"]],
      ["layouts/workspace-shell.tsx", "sidebarHeaderIcon", ["identity.avatarNavigationSize"]],
      ["layouts/workspace-shell.tsx", "sidebarSearchClear", ["iconControl.microSize"]],
      ["layouts/workspace-shell.tsx", "sidebarAddButton", ["iconControl.microSize"]],
      ["layouts/workspace-shell.tsx", "accountLogoutButton", ["control.height"]],
      ["layouts/workspace-shell.tsx", "channelMemberRow", ["conversationWorkspace.channelMemberRowMinHeight"]],
      ["layouts/workspace-shell.tsx", "channelVisibilityButton", ["control.height"]],
      ["layouts/workspace-shell.tsx", "compactChannelButton", ["compactWorkspace.listRowMinHeight"]],
      ["layouts/workspace-shell.tsx", "compactServerButton", ["compactWorkspace.switcherRowMinHeight"]],
      ["layouts/workspace-shell.tsx", "chatErrorToast", ["status.toastMinHeight"]],
      ["layouts/workspace-shell.tsx", "reconnectNotice", ["status.bannerMinHeight"]],
      ["layouts/workspace-shell.tsx", "onlineAgentsBadge", ["status.summaryMinHeight"]],
      ["layouts/workspace-shell.tsx", "searchMore", ["iconControl.denseSize"]],
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

  it("limits literal geometry to documented component-local constraints", () => {
    const remaining = runtimeUiFiles(join(process.cwd(), "src", "ui"))
      .filter((path) => !path.endsWith("tokens.ts"))
      .filter((path) => !path.endsWith("style-lab-screen.tsx"))
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return Array.from(
          source.matchAll(/\n  ([A-Za-z0-9_]+): \{([\s\S]*?)\n  \},/gu),
        ).flatMap((styleMatch) =>
          Array.from(
            (styleMatch[2] ?? "").matchAll(
              /(?:^|\n)\s*(height|maxHeight|maxWidth|minHeight|minWidth|width):\s*([1-9][\d_]*)\b/gu,
            ),
          ).map(
            (dimensionMatch) =>
              `${path.replace(`${process.cwd()}/src/ui/`, "")}:${styleMatch[1]}:${dimensionMatch[1]}:${dimensionMatch[2]}`,
          ),
        );
      })
      .sort();

    expect(remaining).toEqual([]);
  });

  it("does not retain the retired duplicate message presentation in WorkspaceShell", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "ui", "layouts", "workspace-shell.tsx"),
      "utf8",
    );
    const retiredStyles = [
      "attachmentBlock",
      "deliveryStatus",
      "emptyConversation",
      "loadOlderButton",
      "messageAvatar",
      "messageBody",
      "messageQuote",
      "messageScroller",
      "messageText",
      "messages",
      "retryButton",
    ];
    const offenders = retiredStyles.filter((styleName) =>
      new RegExp(`\\n  ${styleName}: \\{`, "u").test(source),
    );

    expect(offenders).toEqual([]);
  });
});
