import { Platform } from "react-native";

export const interfaceFontFamilies = {
  native: "System",
  web: '"PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
} as const;
const interfaceFontFamily = Platform.select({
  default: interfaceFontFamilies.native,
  web: interfaceFontFamilies.web,
});

/**
 * Translucent roles are derived from a base hue rather than re-typed as their
 * own literal, so that recolouring a hue carries its borders, dividers and
 * scrims along with it.
 */
export function withAlpha(color: string, alpha: number): string {
  const channels = Number.parseInt(color.slice(1), 16);
  return `rgba(${(channels >> 16) & 255}, ${(channels >> 8) & 255}, ${channels & 255}, ${alpha})`;
}

/** Primitive tier: the only place a colour may be written as a literal. */
const baseColors = {
  amber50: "#FFF7E6",
  amber500: "#F5A524",
  amber700: "#8A4B08",
  black: "#000000",
  blue50: "#EAF4FF",
  blue100: "#DDEEFF",
  blue200: "#CFE7FF",
  blue500: "#006FEE",
  blue600: "#005BC4",
  blue700: "#004493",
  green50: "#E9F9EF",
  green100: "#E7F7EE",
  green500: "#17C964",
  green600: "#50846B",
  green700: "#0B7138",
  indigo50: "#EEF0FF",
  indigo500: "#6664C9",
  ink900: "#0A0E18",
  neutral100: "#F4F4F5",
  neutral150: "#E9E9EC",
  neutral200: "#E4E4E7",
  neutral300: "#D4D4D8",
  neutral400: "#A1A1AA",
  neutral500: "#71717A",
  neutral700: "#52525B",
  neutral950: "#18181B",
  neutral990: "#09090B",
  orange50: "#FFF0EA",
  orange600: "#B16A4F",
  pink50: "#FFF1F5",
  pink100: "#FDD8E5",
  pink500: "#F31260",
  violet600: "#7828C8",
  white: "#FFFFFF",
} as const;

export const palette = {
  ...baseColors,
  divider: withAlpha(baseColors.neutral950, 0.08),
  transparent: "transparent",
} as const;

/**
 * Three rungs, not two: panes carry a hairline and almost no shadow, floating
 * chrome lifts just enough to read as detached, and only modal layers cast a
 * shadow you actually notice.
 */
const cardShadow = {
  color: withAlpha(palette.black, 0.04),
  offsetY: 1,
  opacity: 1,
  radius: 3,
} as const;
const floatingShadow = {
  color: withAlpha(palette.black, 0.1),
  offsetY: 2,
  opacity: 1,
  radius: 8,
} as const;
const overlayShadow = {
  color: withAlpha(palette.black, 0.18),
  offsetY: 8,
  opacity: 1,
  radius: 24,
} as const;

export const breakpoints = {
  compact: 0,
  medium: 768,
  narrow: 360,
  wide: 1_180,
} as const;

export type DensityMode = "pointer" | "touch";

/**
 * Density tracks the input device, not the viewport. A 1366pt iPad is wide but
 * still needs 44pt targets; a 900pt window on a Mac is narrow but still driven
 * by a mouse. Resolving on width alone gets both cases wrong.
 *
 * Read once at load: pointer hardware does not change mid-session, and the web
 * build is a single-page app, so there is no server render to disagree with.
 */
export function resolveDensityMode(
  platform: typeof Platform.OS,
  matchMedia: ((query: string) => { matches: boolean }) | undefined,
): DensityMode {
  if (platform !== "web") return "touch";
  return matchMedia?.("(pointer: fine)").matches ? "pointer" : "touch";
}

/**
 * Test-only override. The suite has to be able to render both tiers, and the
 * mode is resolved once at import, so there is no hook to flip afterwards.
 */
function densityOverride(): DensityMode | undefined {
  const mode =
    typeof process === "undefined" ? undefined : process.env?.VELA_DENSITY_MODE;
  return mode === "pointer" || mode === "touch" ? mode : undefined;
}

export const densityMode =
  densityOverride() ??
  resolveDensityMode(Platform.OS, globalThis.matchMedia?.bind(globalThis));

/**
 * Motion is resolved the same way and for the same reason: the preference is
 * an OS-level setting that does not change mid-session, and a module constant
 * has no hook to flip afterwards.
 */
export function resolveReducedMotion(
  platform: typeof Platform.OS,
  matchMedia: ((query: string) => { matches: boolean }) | undefined,
): boolean {
  if (platform !== "web") return false;
  return matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function motionOverride(): boolean | undefined {
  const mode =
    typeof process === "undefined" ? undefined : process.env?.VELA_REDUCED_MOTION;
  if (mode === "reduce") return true;
  if (mode === "no-preference") return false;
  return undefined;
}

export const reducedMotion =
  motionOverride() ??
  resolveReducedMotion(Platform.OS, globalThis.matchMedia?.bind(globalThis));

/**
 * Durations are named for what the change means, not how long it takes. Hover
 * and press have to land inside the perceptual window that still reads as
 * "the control responded to me"; anything slower feels laggy rather than
 * animated. Reducing motion collapses the scale to zero rather than removing
 * the transitions, so no consumer has to branch.
 */
export const durationScale = {
  full: {
    feedback: 110,
    reveal: 240,
    settle: 170,
  },
  reduced: {
    feedback: 0,
    reveal: 0,
    settle: 0,
  },
} as const;

export const duration: Record<keyof (typeof durationScale)["full"], number> =
  durationScale[reducedMotion ? "reduced" : "full"];

/**
 * Two curves, both front-loaded. macOS motion starts fast and settles, which
 * is what keeps a 240ms reveal from feeling slow.
 */
export const easing = {
  entrance: "cubic-bezier(0, 0, 0, 1)",
  standard: "cubic-bezier(0.2, 0, 0, 1)",
} as const;

/**
 * The pointer column follows macOS metrics (28-32pt buttons, 44pt two-line
 * rows, 52pt toolbars); the touch column keeps the 44pt minimum target.
 */
export const densityScale = {
  pointer: {
    avatarCompactSize: 28,
    avatarRowSize: 28,
    collectionActionHeight: 36,
    compactComposerMinHeight: 52,
    composerMinHeight: 56,
    composerSuggestionMinHeight: 32,
    composerSurfaceMinHeight: 52,
    composerToolbarMinHeight: 40,
    controlHeight: 30,
    fieldHeight: 32,
    headerActionHeight: 28,
    headerHeight: 52,
    iconControlDenseSize: 28,
    iconControlSmallSize: 30,
    listRowMinHeight: 32,
    managementHeaderHeight: 48,
    memberRowMinHeight: 40,
    messageIndent: 26,
    messageRowGap: 6,
    railWidth: 60,
    shelfRowMinHeight: 44,
    spaceLg: 12,
    spaceMd: 10,
    spaceXl: 18,
    spaceXxl: 24,
    switcherOptionMinHeight: 32,
    switcherRowMinHeight: 36,
    switcherTriggerMinHeight: 48,
    taskCardMinHeight: 48,
  },
  touch: {
    avatarCompactSize: 32,
    avatarRowSize: 36,
    collectionActionHeight: 52,
    compactComposerMinHeight: 64,
    composerMinHeight: 72,
    composerSuggestionMinHeight: 46,
    composerSurfaceMinHeight: 66,
    composerToolbarMinHeight: 52,
    controlHeight: 44,
    fieldHeight: 48,
    headerActionHeight: 44,
    headerHeight: 80,
    iconControlDenseSize: 36,
    iconControlSmallSize: 38,
    listRowMinHeight: 48,
    managementHeaderHeight: 64,
    memberRowMinHeight: 60,
    messageIndent: 30,
    messageRowGap: 10,
    railWidth: 72,
    shelfRowMinHeight: 64,
    spaceLg: 16,
    spaceMd: 12,
    spaceXl: 24,
    spaceXxl: 32,
    switcherOptionMinHeight: 56,
    switcherRowMinHeight: 52,
    switcherTriggerMinHeight: 64,
    taskCardMinHeight: 58,
  },
} as const;

export const density: (typeof densityScale)[DensityMode] =
  densityScale[densityMode];

/**
 * The list shelf between the icon rail and the content, whether it holds
 * conversations or agents. Both areas had settled on 312 independently; naming
 * it keeps them from drifting apart again.
 */
const listPaneWidth = 312;

/**
 * The widest a column of content ever gets, whether it holds a conversation or
 * a detail form. Chat had settled on 760 and management on 960 separately,
 * which is why a single-line name field could stretch to 960px.
 */
const columnMaxWidth = 760;

/**
 * Short standalone copy — a banner, an empty state — reads narrower than a
 * full column. Chat and management had both landed on 560 under two names.
 */
const noticeMaxWidth = 560;

/**
 * Type forks with density too: macOS sets interface body text around 13px
 * where iOS uses 15-17px, so tightening the chrome without tightening the type
 * would leave the two out of proportion.
 */
export const textScale = {
  pointer: {
    avatarLabel: { fontSize: 12, lineHeight: 16 },
    body: { fontSize: 13, lineHeight: 19 },
    bodyCompact: { fontSize: 12, lineHeight: 17 },
    bodySmall: { fontSize: 11, lineHeight: 16 },
    button: { fontSize: 12, lineHeight: 16 },
    compactTitle: { fontSize: 16, lineHeight: 21 },
    composerInput: { fontSize: 13, lineHeight: 18 },
    composerInputCompact: { fontSize: 13, lineHeight: 18 },
    controlGlyph: { fontSize: 15, lineHeight: 19 },
    caption: { fontSize: 10, lineHeight: 14 },
    detailTitle: { fontSize: 22, lineHeight: 28 },
    dialogTitle: { fontSize: 16, lineHeight: 21 },
    lead: { fontSize: 14, lineHeight: 20 },
    message: { fontSize: 13, lineHeight: 19 },
    messageMeta: { fontSize: 11, lineHeight: 15 },
    navigationGlyph: { fontSize: 14, lineHeight: 14 },
    pageTitle: { fontSize: 18, lineHeight: 23 },
    pickerTitle: { fontSize: 19, lineHeight: 24 },
    sectionTitle: { fontSize: 14, lineHeight: 19 },
    serverInitial: { fontSize: 13, lineHeight: 26 },
    workspaceTitle: { fontSize: 14, lineHeight: 19 },
  },
  touch: {
    avatarLabel: { fontSize: 15, lineHeight: 20 },
    body: { fontSize: 14, lineHeight: 21 },
    bodyCompact: { fontSize: 13, lineHeight: 19 },
    bodySmall: { fontSize: 12, lineHeight: 18 },
    button: { fontSize: 13, lineHeight: 18 },
    compactTitle: { fontSize: 19, lineHeight: 24 },
    composerInput: { fontSize: 14, lineHeight: 20 },
    composerInputCompact: { fontSize: 16, lineHeight: 22 },
    controlGlyph: { fontSize: 18, lineHeight: 22 },
    caption: { fontSize: 11, lineHeight: 16 },
    detailTitle: { fontSize: 28, lineHeight: 34 },
    dialogTitle: { fontSize: 20, lineHeight: 26 },
    lead: { fontSize: 16, lineHeight: 24 },
    message: { fontSize: 15, lineHeight: 22 },
    messageMeta: { fontSize: 12, lineHeight: 16 },
    navigationGlyph: { fontSize: 16, lineHeight: 16 },
    pageTitle: { fontSize: 22, lineHeight: 28 },
    pickerTitle: { fontSize: 24, lineHeight: 30 },
    sectionTitle: { fontSize: 17, lineHeight: 22 },
    serverInitial: { fontSize: 15, lineHeight: 32 },
    workspaceTitle: { fontSize: 16, lineHeight: 22 },
  },
} as const;

export const text: (typeof textScale)[DensityMode] = textScale[densityMode];

// The Web workspace frame can restore navigation before content-heavy
// management screens switch from their compact, stacked layouts.
export const workspaceShellWideBreakpoint = 960;

export const velaTheme = {
  semantic: {
    color: {
      actionDangerBorder: palette.pink500,
      actionDangerEmphasisSurface: palette.pink500,
      actionDangerEmphasisText: palette.white,
      actionDisabledSurface: palette.neutral100,
      actionDisabledText: palette.neutral400,
      actionDangerHoverSurface: palette.pink50,
      actionDangerPressedSurface: palette.pink100,
      actionDangerSurface: palette.transparent,
      actionDangerText: palette.pink500,
      actionDangerTonalSurface: palette.pink50,
      actionPrimaryHoverSurface: palette.blue600,
      actionPrimaryPressedSurface: palette.blue700,
      actionPrimarySurface: palette.blue500,
      actionPrimaryText: palette.white,
      actionQuietSurface: palette.neutral100,
      actionSecondaryBorder: withAlpha(palette.neutral950, 0.14),
      actionSecondaryHoverSurface: withAlpha(palette.neutral950, 0.05),
      actionSecondaryPressedSurface: palette.neutral200,
      actionSecondarySurface: palette.white,
      actionSecondaryText: palette.neutral950,
      actionTonalHoverSurface: palette.blue100,
      actionTonalPressedSurface: palette.blue200,
      actionTonalSurface: palette.blue50,
      actionTonalText: palette.blue600,
      avatarAccountSurface: palette.violet600,
      avatarAgentSurface: palette.green500,
      avatarAgentText: palette.neutral950,
      avatarPeerSurface: palette.green100,
      avatarPeerText: palette.green600,
      avatarServerSurface: palette.blue500,
      avatarServerText: palette.white,
      avatarHumanGreenBorder: withAlpha(palette.green600, 0.08),
      avatarHumanGreenSurface: palette.green100,
      avatarHumanGreenText: palette.green600,
      avatarHumanOrangeBorder: withAlpha(palette.orange600, 0.08),
      avatarHumanOrangeSurface: palette.orange50,
      avatarHumanOrangeText: palette.orange600,
      avatarHumanVioletBorder: withAlpha(palette.indigo500, 0.08),
      avatarHumanVioletSurface: palette.indigo50,
      avatarHumanVioletText: palette.indigo500,
      borderAccent: palette.blue500,
      // Line weight carries meaning: a control edge has to describe a shape you
      // can click, a pane boundary divides architecture, and a row rule only
      // separates peers. These were one shared value, which is why controls
      // read as mushy while long lists read as busy.
      borderControl: withAlpha(palette.neutral950, 0.14),
      borderDanger: withAlpha(palette.pink500, 0.18),
      borderDangerStrong: withAlpha(palette.pink500, 0.58),
      borderFocus: withAlpha(palette.blue500, 0.42),
      borderInteractive: withAlpha(palette.blue500, 0.18),
      borderOverlay: withAlpha(palette.neutral950, 0.12),
      borderSelected: withAlpha(palette.blue500, 0.22),
      borderSection: withAlpha(palette.neutral950, 0.12),
      borderTransparent: palette.transparent,
      brandAccent: palette.blue500,
      brandAccentStrong: palette.blue600,
      brandHighlight: withAlpha(palette.violet600, 0.76),
      canvasSurface: palette.white,
      codeSurface: palette.neutral950,
      codeText: palette.white,
      decorativeAccentSurface: palette.blue500,
      fieldPlaceholder: palette.neutral400,
      // Fields read as raised, not inset: on the recessed sidebar a white fill
      // separates the search box from its container, and on white content the
      // hairline border carries the edge.
      fieldSurface: palette.white,
      iconAccent: palette.blue600,
      iconAccentSurface: palette.blue50,
      iconInverse: palette.white,
      iconMuted: palette.neutral500,
      iconPrimary: palette.neutral950,
      iconSecondary: palette.neutral700,
      inverseSurface: palette.neutral950,
      // Hover darkens whatever it lands on rather than painting a fixed grey.
      // An opaque fill silently vanishes the moment its container is recoloured
      // to the same tone, which is exactly what happened on the sidebar.
      interactiveHoverSurface: withAlpha(palette.neutral950, 0.05),
      interactivePressedSurface: palette.neutral200,
      modalBackdrop: withAlpha(palette.neutral990, 0.34),
      // Recession ladder: the rail sits furthest back, the conversation
      // sidebar one step in front of it, and content reads as the lit surface
      // on top. Naming these apart matters because `paneSurface` is also worn
      // by raised panels, which must not follow the sidebar down.
      navigationSurface: palette.neutral150,
      notificationBadgeSurface: palette.blue500,
      notificationBadgeText: palette.white,
      overlayBackdrop: withAlpha(palette.ink900, 0.92),
      overlayControlBorder: withAlpha(palette.white, 0.34),
      overlaySurface: palette.white,
      paneSurface: palette.white,
      progressActiveSurface: palette.blue500,
      progressActiveText: palette.white,
      sectionSurface: palette.white,
      selectionSurface: palette.blue50,
      selectionHoverSurface: palette.blue100,
      selectionPressedSurface: palette.blue200,
      separator: withAlpha(palette.neutral950, 0.06),
      sidebarSurface: palette.neutral100,
      statusDanger: palette.pink500,
      statusDangerDivider: withAlpha(palette.pink500, 0.12),
      statusDangerSurface: palette.pink50,
      statusDangerText: palette.pink500,
      statusNeutral: palette.neutral300,
      statusNeutralSurface: palette.neutral100,
      statusNeutralText: palette.neutral700,
      statusInfo: palette.blue500,
      statusInfoDivider: withAlpha(palette.blue500, 0.14),
      statusInfoSurface: withAlpha(palette.blue500, 0.1),
      statusInfoText: palette.blue600,
      statusPositive: palette.green500,
      statusPositiveDivider: withAlpha(palette.green500, 0.14),
      statusPositiveSurface: palette.green50,
      statusPositiveText: palette.green700,
      statusWarning: palette.amber500,
      statusWarningDivider: withAlpha(palette.amber500, 0.22),
      statusWarningSurface: palette.amber50,
      statusWarningText: palette.amber700,
      surfaceMuted: palette.neutral200,
      surfaceSubtle: withAlpha(palette.neutral950, 0.05),
      surfaceTransparent: palette.transparent,
      textInverse: palette.white,
      textLink: palette.blue600,
      textMuted: palette.neutral500,
      textPrimary: palette.neutral950,
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
      // How long a thing stays put before it goes away. Not a transition
      // length, and previously indistinguishable from one.
      dismissal: {
        focusHighlight: 2_400,
        toast: 8_000,
      },
      duration,
      easing,
      /**
       * Spread onto the base style of anything whose appearance changes on
       * hover, press, focus or selection. The variant style only swaps the
       * value; the transition lives on the base so both directions animate.
       */
      transition: {
        control: {
          transitionDuration: `${duration.feedback}ms`,
          transitionProperty: "background-color, border-color, color, opacity",
          transitionTimingFunction: easing.standard,
        },
        surface: {
          transitionDuration: `${duration.settle}ms`,
          transitionProperty: "background-color, border-color, opacity",
          transitionTimingFunction: easing.standard,
        },
      },
    },
    radius: {
      circle: 9_999,
      compactControl: 8,
      control: 10,
      overlay: 20,
      pane: 0,
      pill: 9_999,
      section: 16,
    },
    stroke: {
      accent: 3,
      hairline: 1,
      statusRing: 2,
    },
    typography: {
      authHeroTitle: {
        fontFamily: interfaceFontFamily,
        fontSize: 44,
        fontWeight: "600",
        letterSpacing: -1.8,
        lineHeight: 50,
      },
      avatarLabel: {
        fontFamily: interfaceFontFamily,
        ...text.avatarLabel,
        fontWeight: "700",
      },
      body: {
        fontFamily: interfaceFontFamily,
        ...text.body,
      },
      bodyCompact: {
        fontFamily: interfaceFontFamily,
        ...text.bodyCompact,
      },
      bodyCompactEmphasis: {
        fontFamily: interfaceFontFamily,
        ...text.bodyCompact,
        fontWeight: "600",
      },
      bodyEmphasis: {
        fontFamily: interfaceFontFamily,
        ...text.body,
        fontWeight: "600",
      },
      button: {
        fontFamily: interfaceFontFamily,
        ...text.button,
        fontWeight: "600",
      },
      bodySmall: {
        fontFamily: interfaceFontFamily,
        ...text.bodySmall,
      },
      bodySmallEmphasis: {
        fontFamily: interfaceFontFamily,
        ...text.bodySmall,
        fontWeight: "600",
      },
      brandGlyph: {
        fontFamily: interfaceFontFamily,
        fontSize: 16,
        fontWeight: "600",
        lineHeight: 42,
      },
      brandMark: {
        fontFamily: interfaceFontFamily,
        fontSize: 11,
        fontWeight: "600",
        letterSpacing: 0.4,
        lineHeight: 16,
      },
      brandMarkCompact: {
        fontFamily: interfaceFontFamily,
        fontSize: 12,
        fontWeight: "600",
        letterSpacing: 0.4,
        lineHeight: 18,
      },
      caption: {
        fontFamily: interfaceFontFamily,
        ...text.caption,
      },
      captionEmphasis: {
        fontFamily: interfaceFontFamily,
        ...text.caption,
        fontWeight: "600",
      },
      composerInput: {
        fontFamily: interfaceFontFamily,
        ...text.composerInput,
      },
      composerInputCompact: {
        fontFamily: interfaceFontFamily,
        ...text.composerInputCompact,
      },
      compactTitle: {
        fontFamily: interfaceFontFamily,
        ...text.compactTitle,
        fontWeight: "600",
      },
      controlGlyph: {
        fontFamily: interfaceFontFamily,
        ...text.controlGlyph,
        fontWeight: "600",
      },
      detailTitle: {
        fontFamily: interfaceFontFamily,
        ...text.detailTitle,
        fontWeight: "600",
      },
      dialogTitle: {
        fontFamily: interfaceFontFamily,
        ...text.dialogTitle,
        fontWeight: "600",
      },
      emptyMetric: {
        fontFamily: interfaceFontFamily,
        fontSize: 72,
        fontWeight: "600",
        lineHeight: 72,
      },
      formMark: {
        fontFamily: interfaceFontFamily,
        fontSize: 24,
        fontWeight: "600",
        lineHeight: 48,
      },
      eyebrow: {
        fontFamily: interfaceFontFamily,
        ...text.caption,
        fontWeight: "600",
        letterSpacing: 0.8,
      },
      label: {
        fontFamily: interfaceFontFamily,
        ...text.bodySmall,
        fontWeight: "600",
      },
      lead: {
        fontFamily: interfaceFontFamily,
        ...text.lead,
      },
      micro: {
        fontFamily: interfaceFontFamily,
        fontSize: 9,
        lineHeight: 13,
      },
      microTracked: {
        fontFamily: interfaceFontFamily,
        fontSize: 9,
        letterSpacing: 0.8,
        lineHeight: 13,
      },
      messageBody: {
        fontFamily: interfaceFontFamily,
        ...text.message,
      },
      messageMeta: {
        fontFamily: interfaceFontFamily,
        ...text.messageMeta,
      },
      messageSender: {
        fontFamily: interfaceFontFamily,
        ...text.message,
        fontWeight: "600",
      },
      meta: {
        fontFamily: interfaceFontFamily,
        ...text.caption,
      },
      navigationGlyph: {
        fontFamily: interfaceFontFamily,
        ...text.navigationGlyph,
      },
      navigationLabel: {
        fontFamily: interfaceFontFamily,
        fontSize: 10,
        lineHeight: 14,
      },
      onboardingTitle: {
        fontFamily: interfaceFontFamily,
        fontSize: 34,
        fontWeight: "600",
        lineHeight: 40,
      },
      overline: {
        fontFamily: interfaceFontFamily,
        fontSize: 10,
        fontWeight: "600",
        letterSpacing: 1.2,
        lineHeight: 14,
      },
      pickerTitle: {
        fontFamily: interfaceFontFamily,
        ...text.pickerTitle,
        fontWeight: "600",
      },
      railLabel: {
        fontFamily: interfaceFontFamily,
        fontSize: 7,
        letterSpacing: 0.4,
        lineHeight: 10,
      },
      pageTitle: {
        fontFamily: interfaceFontFamily,
        ...text.pageTitle,
        fontWeight: "600",
      },
      sectionTitle: {
        fontFamily: interfaceFontFamily,
        ...text.sectionTitle,
        fontWeight: "600",
      },
      serverInitial: {
        fontFamily: interfaceFontFamily,
        ...text.serverInitial,
      },
      stepBadge: {
        fontFamily: interfaceFontFamily,
        fontSize: 10,
        fontWeight: "600",
        lineHeight: 28,
      },
      tooltip: {
        fontFamily: interfaceFontFamily,
        ...text.messageMeta,
        fontWeight: "600",
      },
      workspaceTitle: {
        fontFamily: interfaceFontFamily,
        ...text.workspaceTitle,
        fontWeight: "600",
      },
    },
  },
  recipes: {
    authWorkspace: {
      cardPadding: 40,
      compactPanelMaxWidth: 640,
      controlHeight: 48,
      desktopPadding: 48,
      desktopShellMaxWidth: 1_260,
      heroGap: 64,
      primaryActionHeight: 52,
      sequenceLineHeight: 2,
      sequenceLineMaxWidth: 48,
      setupShellMaxWidth: 1_160,
      statementFootMaxWidth: 370,
      statementMaxWidth: 620,
      statementMinHeight: 550,
    },
    compactWorkspace: {
      bottomNavigationHeight: 68,
      composerMinHeight: density.compactComposerMinHeight,
      listRowMinHeight: density.listRowMinHeight,
      navigationItemMinWidth: 0,
      switcherRowMinHeight: density.switcherRowMinHeight,
    },
    conversationWorkspace: {
      composerAttachmentMaxWidth: 260,
      composerAttachmentMinWidth: 190,
      composerDesktopMaxWidth: 860,
      composerMentionListOffset: 58,
      composerSuggestionMinHeight: density.composerSuggestionMinHeight,
      composerToolbarMinHeight: density.composerToolbarMinHeight,
      channelManagementActionMinWidth: 64,
      channelMemberRowMinHeight: density.memberRowMinHeight,
      compactActionGap: 3,
      composerInputMaxHeight: 112,
      composerSurfaceMinHeight: density.composerSurfaceMinHeight,
      directRowMinHeight: density.shelfRowMinHeight,
      messageActionHorizontalPadding: 6,
      messageIndent: density.messageIndent,
      messageRowGap: density.messageRowGap,
      toastTopInset: 72,
    },
    control: {
      height: density.controlHeight,
      squareSize: density.controlHeight,
    },
    contentMeasure: {
      codeBlockMaxHeight: 180,
      compactMaxWidth: 440,
      messageMaxWidth: columnMaxWidth,
      noticeMaxWidth,
      readingMaxWidth: 520,
    },
    desktopWorkspace: {
      composerHorizontalPadding: 16,
      composerMinHeight: density.composerMinHeight,
      composerVerticalPadding: 12,
      conversationRowMinHeight: density.shelfRowMinHeight,
      headerHeight: density.headerHeight,
      navigationControlSize: density.controlHeight,
      navigationGap: 8,
      navigationTopInset: 12,
      railWidth: density.railWidth,
      sidebarWidth: listPaneWidth,
    },
    iconControl: {
      compactSize: 32,
      denseSize: density.iconControlDenseSize,
      microSize: 28,
      smallSize: density.iconControlSmallSize,
    },
    identity: {
      avatarAccountSize: 52,
      avatarCompactSize: density.avatarCompactSize,
      avatarNavigationSize: 40,
      avatarProminentSize: 38,
      avatarRowSize: density.avatarRowSize,
      brandHighlightOffsetX: -12,
      brandHighlightOffsetY: -14,
      brandHighlightSize: 38,
      brandMarkSize: 46,
      connectionDotSize: 9,
      presenceDotSize: 10,
      statusDotSize: 7,
    },
    emptyState: {
      iconSize: 48,
      loadingMinHeight: 260,
      orbitCoreSize: 10,
      orbitRingSize: 38,
      orbitSize: 56,
      stageMinHeight: 280,
      timelineMinHeight: 300,
      workspaceMinHeight: 360,
    },
    managementWorkspace: {
      actionHeight: density.controlHeight,
      collectionActionHeight: density.collectionActionHeight,
      collectionCompactHeight: 96,
      collectionCompactRowWidth: 220,
      collectionAvatarSize: density.avatarRowSize,
      collectionWidth: listPaneWidth,
      compactPadding: 16,
      compactResourceIconSize: 48,
      contentMaxWidth: columnMaxWidth,
      desktopPadding: 32,
      detailGap: 24,
      emptyStateMaxWidth: noticeMaxWidth,
      fieldCompactWidth: 160,
      fieldHeight: density.fieldHeight,
      formFieldMinWidth: 240,
      formMaxWidth: columnMaxWidth,
      headerActionHeight: density.headerActionHeight,
      headerHeight: density.managementHeaderHeight,
      mediumPadding: 24,
      resourceActionCopyMinWidth: 180,
      resourceActionMinHeight: 72,
      resourceIconSize: 56,
      rowMinHeight: density.shelfRowMinHeight,
      sectionGap: 16,
      sectionPadding: 20,
      switcherMenuMaxHeight: 232,
      switcherOptionMinHeight: density.switcherOptionMinHeight,
      switcherTriggerMinHeight: density.switcherTriggerMinHeight,
      textareaMinHeight: 96,
    },
    resourceIdentity: {
      factMinHeight: 64,
      factMinWidth: 140,
      headerPaddingBottom: 20,
      markSize: 48,
    },
    messageTimeline: {
      attachmentMinWidth: 210,
      deliveryMinHeight: 18,
      imageMaxHeight: 320,
      pointerActionSize: 28,
      taskCardMaxWidth: 540,
      taskCardMinHeight: density.taskCardMinHeight,
      taskCardMinWidth: 240,
      touchActionSize: 32,
    },
    overlay: {
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
    },
    status: {
      badgeMinSize: 18,
      bannerMinHeight: 52,
      chipMinHeight: 28,
      inlineMinHeight: 36,
      notificationBadgeOffset: -6,
      notificationBadgeSize: 22,
      summaryMinHeight: 30,
      toastMinHeight: 48,
    },
    taskWorkspace: {
      compactListMaxHeight: 196,
    },
    terminalPanel: {
      controlMinWidth: 52,
      outputMinHeight: 260,
      panelMinHeight: 480,
      viewportChromeOffset: 184,
    },
  },
  shadows: {
    card: cardShadow,
    floatingControl: floatingShadow,
    overlay: overlayShadow,
  },
  terminal: {
    cssFont: "13px/18px 'Space Mono', ui-monospace, monospace",
    cursor: "#6E9CFF",
    initialRows: 24,
    scrollbackLines: 5_000,
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
  },
  // The three smallest steps sit inside controls, where a pointer needs the
  // same breathing room a finger does; only the container-level gutters fork.
  spacing: {
    xxs: 2,
    xs: 4,
    sm: 8,
    md: density.spaceMd,
    lg: density.spaceLg,
    xl: density.spaceXl,
    xxl: density.spaceXxl,
  },
} as const;

export type VelaTheme = typeof velaTheme;
