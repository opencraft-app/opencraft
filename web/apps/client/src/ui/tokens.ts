import { Platform } from "react-native";

export const interfaceFontFamilies = {
  native: "System",
  // SF / system UI first for chrome metrics; PingFang still covers CJK glyphs.
  web: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", system-ui, "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
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
  // System grouped-background wash (Settings / management stage).
  neutral50: "#F2F2F7",
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
  pink300: "#FF7096",
  pink500: "#F31260",
  pink700: "#A20C40",
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
    avatarNavigationSize: 32,
    avatarRowSize: 28,
    bannerMinHeight: 40,
    collectionActionHeight: 36,
    collectionCompactHeight: 72,
    collectionHeaderMarkSize: 36,
    composerSuggestionMinHeight: 32,
    composerSurfaceMinHeight: 52,
    composerToolbarMinHeight: 40,
    controlHeight: 30,
    factMinHeight: 48,
    fieldHeight: 32,
    headerActionHeight: 28,
    headerHeight: 52,
    iconControlCompactSize: 28,
    iconControlDenseSize: 28,
    iconControlFloatingSize: 36,
    iconControlSmallSize: 30,
    listRowMinHeight: 32,
    memberRowMinHeight: 40,
    messageActionSize: 28,
    messageIndent: 26,
    messageRowGap: 6,
    railBrandMarkSize: 36,
    railWidth: 60,
    resourceActionMinHeight: 52,
    shelfRowMinHeight: 44,
    spaceLg: 12,
    spaceMd: 10,
    spaceXl: 18,
    spaceXxl: 24,
    switcherOptionMinHeight: 32,
    switcherRowMinHeight: 36,
    switcherTriggerMinHeight: 36,
    taskCardMinHeight: 48,
    toastMinHeight: 36,
  },
  touch: {
    avatarCompactSize: 32,
    avatarNavigationSize: 44,
    avatarRowSize: 36,
    bannerMinHeight: 52,
    collectionActionHeight: 52,
    collectionCompactHeight: 96,
    collectionHeaderMarkSize: 48,
    composerSuggestionMinHeight: 46,
    composerSurfaceMinHeight: 66,
    composerToolbarMinHeight: 52,
    controlHeight: 44,
    factMinHeight: 64,
    fieldHeight: 48,
    headerActionHeight: 44,
    headerHeight: 80,
    iconControlCompactSize: 32,
    iconControlDenseSize: 36,
    iconControlFloatingSize: 48,
    iconControlSmallSize: 38,
    listRowMinHeight: 48,
    memberRowMinHeight: 60,
    messageActionSize: 32,
    messageIndent: 30,
    messageRowGap: 10,
    railBrandMarkSize: 48,
    railWidth: 72,
    resourceActionMinHeight: 72,
    shelfRowMinHeight: 64,
    spaceLg: 16,
    spaceMd: 12,
    spaceXl: 24,
    spaceXxl: 32,
    switcherOptionMinHeight: 56,
    switcherRowMinHeight: 52,
    switcherTriggerMinHeight: 56,
    taskCardMinHeight: 58,
    toastMinHeight: 48,
  },
} as const;

/**
 * Interaction chrome follows the input device, not the viewport. A narrow Mac
 * window still has a mouse; a wide tablet still has a finger. Layout compactness
 * is a separate axis (`breakpoints` / width).
 */
export const pointerDensity = densityMode === "pointer";

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

const strokeScale = {
  accent: 3,
  hairline: 1,
  statusRing: 2,
} as const;

function composerSurfaceMetric(
  surfaceMinHeight: number,
  surfaceMaxHeight: number,
  footerInset: number,
  radius: number,
) {
  return {
    editorMaxHeight:
      surfaceMaxHeight -
      density.composerToolbarMinHeight -
      footerInset -
      strokeScale.hairline * 2,
    editorMinHeight:
      surfaceMinHeight -
      density.composerToolbarMinHeight -
      footerInset -
      strokeScale.hairline * 2,
    footerInset,
    radius,
    surfaceMaxHeight,
    surfaceMinHeight,
  } as const;
}

const composerSurfaceMetrics = {
  compact: composerSurfaceMetric(
    pointerDensity ? 84 : 104,
    pointerDensity ? 180 : 208,
    4,
    18,
  ),
  desktop: composerSurfaceMetric(
    pointerDensity ? 112 : 124,
    pointerDensity ? 220 : 240,
    8,
    24,
  ),
  native: composerSurfaceMetric(
    pointerDensity ? 88 : 104,
    pointerDensity ? 180 : 208,
    4,
    18,
  ),
} as const;

// The Web workspace frame can restore navigation before content-heavy
// management screens switch from their compact, stacked layouts.
export const workspaceShellWideBreakpoint = 960;

export const velaLight = {
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
      // Hover deepens a resting control edge without jumping to the focus accent.
      borderFieldHover: withAlpha(palette.neutral950, 0.22),
      borderFocus: withAlpha(palette.blue500, 0.42),
      borderInteractive: withAlpha(palette.blue500, 0.18),
      borderOverlay: withAlpha(palette.neutral950, 0.12),
      borderSelected: withAlpha(palette.neutral950, 0.14),
      borderSection: withAlpha(palette.neutral950, 0.12),
      borderTransparent: palette.transparent,
      brandAccent: palette.blue500,
      brandAccentStrong: palette.blue600,
      brandHighlight: withAlpha(palette.violet600, 0.76),
      canvasSurface: palette.white,
      codeSurface: palette.neutral950,
      codeText: palette.white,
      decorativeAccentSurface: palette.blue500,
      // Quiet Mac-style field focus — a thin halo, not a Material glow ring.
      fieldFocusGlow: withAlpha(palette.blue500, 0.12),
      fieldPlaceholder: palette.neutral400,
      // Hybrid field material: forms on a lit canvas stay raised (white +
      // hairline); directory and member search sit recessed in the sidebar so
      // they read as Mac filter wells rather than Bootstrap boxes.
      fieldSurface: palette.white,
      // 0.08 keeps the well readable on sidebarSurface without tipping into a
      // muddy slab; 0.06 was too close to the pane and still read as "cheap flat".
      fieldSurfaceRecessed: withAlpha(palette.neutral950, 0.08),
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
      // Settings-style page wash behind inset groups (management stage).
      groupedSurface: palette.neutral50,
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
      // Base wash behind frosted rail/sidebar (web vibrancy).
      shellBackdrop: palette.neutral200,
      shellBackdropHighlight: palette.neutral100,
      progressActiveSurface: palette.blue500,
      progressActiveText: palette.white,
      sectionSurface: palette.white,
      // List/rail selection stays cool-neutral (NSTableView), not chat-blue.
      // Opaque so hover/subtle fills remain visible when composited on top.
      selectionSurface: palette.neutral200,
      selectionHoverSurface: palette.neutral300,
      selectionPressedSurface: palette.neutral300,
      separator: withAlpha(palette.neutral950, 0.06),
      sidebarSurface: palette.neutral100,
      statusDanger: palette.pink500,
      statusDangerDivider: withAlpha(palette.pink500, 0.12),
      statusDangerSurface: palette.pink50,
      statusDangerText: palette.pink700,
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
    /**
     * Frosted chrome fills for web. Opaque `navigationSurface` / `sidebarSurface`
     * stay the native and contrast-test sources; `_web` styles composite these
     * translucent fills over `shellBackdrop` with backdrop-filter.
     */
    material: {
      blur: "saturate(180%) blur(20px)",
      composerFill: withAlpha(palette.white, 0.82),
      navigationFill: withAlpha(palette.white, 0.58),
      navigationInactiveFill: withAlpha(palette.white, 0.42),
      sidebarFill: withAlpha(palette.white, 0.66),
    },
    interaction: {
      disabledOpacity: 0.5,
      focusRingOffset: 1,
      focusRingWidth: 1,
      hitTargetInset: 6,
      hitTargetInsetCompact: 2,
      longPressDelay: 350,
      // A floor for the touch scale to clear, not a size to build with. Styles
      // that reached for it stood 48 tall on a desktop where the control scale
      // says 30; they take density.controlHeight or density.fieldHeight now,
      // and this is what those are measured against.
      minimumTargetSize: 44,
      pressedScale: 0.96,
      pressedScaleSubtle: 0.99,
    },
    icon: {
      // Sized to SF Symbol toolbar classes (≈15/17/20), not Lucide defaults.
      size: {
        compact: 13,
        feature: 20,
        hero: 28,
        large: 20,
        medium: 17,
        small: 15,
      },
      stroke: {
        emphasis: 1.75,
        regular: 1.5,
        strong: 2,
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
          transitionProperty:
            "background-color, border-color, box-shadow, color, opacity",
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
      // AppKit-adjacent control corners — 10/16 read as web product kits.
      compactControl: 6,
      control: 7,
      overlay: 14,
      pane: 0,
      pill: 9_999,
      section: 12,
    },
    stroke: strokeScale,
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
        letterSpacing: 0,
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
        letterSpacing: 0.2,
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
      controlHeight: density.fieldHeight,
      desktopPadding: 48,
      desktopShellMaxWidth: 1_260,
      heroGap: 64,
      primaryActionHeight: density.collectionActionHeight,
      sequenceLineHeight: 2,
      sequenceLineMaxWidth: 48,
      setupShellMaxWidth: 1_160,
      statementFootMaxWidth: 370,
      statementMaxWidth: 620,
      statementMinHeight: 550,
    },
    compactWorkspace: {
      bottomNavigationHeight: 68,
      listRowMinHeight: density.listRowMinHeight,
      navigationItemMinWidth: 0,
      switcherRowMinHeight: density.switcherRowMinHeight,
    },
    conversationWorkspace: {
      composerAttachmentMaxWidth: 260,
      composerAttachmentMinWidth: 190,
      composerAttachmentInset: 8,
      composerDesktopMaxWidth: 860,
      composerPrimaryActionSize: pointerDensity ? 32 : 44,
      composerSuggestionMinHeight: density.composerSuggestionMinHeight,
      composerToolbarMinHeight: density.composerToolbarMinHeight,
      channelManagementActionMinWidth: 64,
      channelMemberRowMinHeight: density.memberRowMinHeight,
      compactActionGap: 3,
      composerSurfaceMetrics,
      messageActionHorizontalPadding: 6,
      messageIndent: density.messageIndent,
      messageRowGap: density.messageRowGap,
      // Toast is absolutely placed inside messageStage (header + body).
      toastTopInset: density.headerHeight + density.spaceMd,
    },
    control: {
      fieldHeight: density.fieldHeight,
      height: density.controlHeight,
      // A selectable record in a scrolling shelf: a channel, a direct message,
      // an agent, a computer. The chat sidebar and the management panes each
      // had their own name for this height and a third name sat beside them,
      // all three resolving to the same number and none of them holding the
      // others to it.
      rowHeight: density.shelfRowMinHeight,
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
      composerVerticalPadding: 12,
      headerHeight: density.headerHeight,
      navigationControlSize: density.controlHeight,
      navigationGap: 8,
      navigationTopInset: 12,
      railWidth: density.railWidth,
      sidebarWidth: listPaneWidth,
    },
    iconControl: {
      // Must stay ≤ controlHeight so rail tooltips can vertically center.
      compactSize: density.iconControlCompactSize,
      denseSize: density.iconControlDenseSize,
      // Jump-to-latest / history spinner — free of neighbouring controls, but
      // still an input-device target, so it tracks density rather than a flat 48.
      floatingSize: density.iconControlFloatingSize,
      microSize: 28,
      smallSize: density.iconControlSmallSize,
    },
    identity: {
      // Rail account control — same box as section nav icons.
      avatarAccountSize: density.controlHeight,
      avatarCompactSize: density.avatarCompactSize,
      avatarNavigationSize: density.avatarNavigationSize,
      // Face inside rail account chrome and the account popover. Tracks the
      // row avatar tier so a 30pt pointer button is not stuffed with a 38pt face.
      avatarProminentSize: density.avatarRowSize,
      avatarRowSize: density.avatarRowSize,
      brandHighlightOffsetX: -12,
      brandHighlightOffsetY: -14,
      brandHighlightSize: 38,
      // Rail chrome mark — must clear the header band and sit near nav icons,
      // not borrow the empty-state 48pt hero size.
      brandMarkCompactSize: density.railBrandMarkSize,
      brandMarkSize: density.railBrandMarkSize,
      connectionDotSize: 9,
      presenceDotSize: 10,
      statusDotSize: 7,
    },
    emptyState: {
      iconSize: density.collectionHeaderMarkSize,
      loadingMinHeight: 260,
      orbitCoreSize: 10,
      orbitRingSize: density.avatarNavigationSize,
      orbitSize: density.railBrandMarkSize,
      stageMinHeight: 280,
      timelineMinHeight: 300,
      workspaceMinHeight: 360,
    },
    managementWorkspace: {
      actionHeight: density.controlHeight,
      collectionActionHeight: density.collectionActionHeight,
      collectionCompactHeight: density.collectionCompactHeight,
      collectionCompactRowWidth: 220,
      collectionWidth: listPaneWidth,
      compactPadding: 16,
      compactResourceIconSize: density.collectionHeaderMarkSize,
      contentMaxWidth: columnMaxWidth,
      desktopPadding: 32,
      detailGap: 24,
      emptyStateMaxWidth: noticeMaxWidth,
      fieldCompactWidth: 160,
      formFieldMinWidth: 240,
      formMaxWidth: columnMaxWidth,
      headerActionHeight: density.headerActionHeight,
      headerHeight: density.headerHeight,
      mediumPadding: 24,
      preferenceContentMaxWidth: 780,
      preferenceControlMinWidth: 280,
      preferenceLabelWidth: 180,
      resourceActionCopyMinWidth: 180,
      resourceActionMinHeight: density.resourceActionMinHeight,
      sectionGap: 16,
      sectionPadding: 20,
      switcherMenuMaxHeight: 232,
      switcherOptionMinHeight: density.switcherOptionMinHeight,
      switcherTriggerMinHeight: density.switcherTriggerMinHeight,
      textareaMinHeight: 96,
    },
    resourceIdentity: {
      factMinHeight: density.factMinHeight,
      factMinWidth: 140,
      headerPaddingBottom: 20,
      markSize: density.collectionHeaderMarkSize,
    },
    messageTimeline: {
      // Hit size follows density. Reveal vs long-press is `pointerDensity`.
      actionSize: density.messageActionSize,
      attachmentMinWidth: 210,
      deliveryMinHeight: 18,
      imageMaxHeight: 320,
      taskCardMaxWidth: 540,
      taskCardMinHeight: density.taskCardMinHeight,
      taskCardMinWidth: 240,
    },
    overlay: {
      accountPopoverBottomInset: 4,
      // Sit just past the rail edge so the menu clears the chrome.
      accountPopoverLeftInset: density.railWidth + 6,
      accountMenuWidth: 280,
      // macOS menus are denser than selectable content shelves. Keeping this
      // separate prevents a touch-oriented 64pt shelf row from stretching a
      // pointer menu into a full-height card.
      menuRowHeight: pointerDensity ? 28 : 44,
      confirmDialogMaxWidth: 420,
      contextPanelMinWidth: 320,
      contextPanelWidth: 392,
      previewControlInset: 20,
      // Anchored to the nav control box (same size as the icon button). A
      // leftover 52×52 item + 58/8 insets from the touch-era rail left the
      // pointer tooltip floating between icons and deep into the stage.
      railTooltipLeftInset: density.controlHeight + density.spaceMd,
      railTooltipTopInset: Math.max(
        0,
        Math.round(
          (density.controlHeight - density.iconControlCompactSize) / 2,
        ),
      ),
      searchPanelMaxHeight: 310,
      serverListMaxHeight: 160,
      threadPanelMinWidth: 340,
      threadPanelWidth: 390,
    },
    status: {
      badgeMinSize: 18,
      bannerMinHeight: density.bannerMinHeight,
      chipMinHeight: 28,
      inlineMinHeight: 36,
      notificationBadgeOffset: -6,
      notificationBadgeSize: 22,
      summaryMinHeight: 30,
      toastMinHeight: density.toastMinHeight,
    },
    taskWorkspace: {
      compactListMaxHeight: 196,
    },
    terminalPanel: {
      controlMinWidth: 52,
      outputMinHeight: 260,
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

/**
 * Dark colors are authored by semantic role rather than mechanically inverted.
 * Geometry, typography and behavior stay shared so switching appearance never
 * moves a control or changes its interaction contract.
 */
export const velaDark = {
  ...velaLight,
  semantic: {
    ...velaLight.semantic,
    color: {
      ...velaLight.semantic.color,
      actionDangerHoverSurface: withAlpha(palette.pink500, 0.14),
      actionDangerPressedSurface: withAlpha(palette.pink500, 0.22),
      actionDangerSurface: palette.transparent,
      actionDangerText: palette.pink500,
      actionDangerTonalSurface: withAlpha(palette.pink500, 0.12),
      actionDisabledSurface: palette.neutral950,
      actionDisabledText: palette.neutral500,
      actionPrimaryHoverSurface: palette.blue600,
      actionPrimaryPressedSurface: palette.blue700,
      actionQuietSurface: withAlpha(palette.white, 0.08),
      actionSecondaryHoverSurface: withAlpha(palette.white, 0.08),
      actionSecondaryPressedSurface: palette.neutral700,
      actionSecondarySurface: palette.neutral950,
      actionSecondaryText: palette.neutral100,
      actionTonalHoverSurface: withAlpha(palette.blue500, 0.22),
      actionTonalPressedSurface: withAlpha(palette.blue500, 0.3),
      actionTonalSurface: withAlpha(palette.blue500, 0.14),
      actionTonalText: palette.blue200,
      avatarAgentText: palette.neutral990,
      avatarPeerSurface: withAlpha(palette.green500, 0.18),
      avatarPeerText: palette.green500,
      avatarHumanGreenBorder: withAlpha(palette.green500, 0.2),
      avatarHumanGreenSurface: withAlpha(palette.green500, 0.16),
      avatarHumanGreenText: palette.green500,
      avatarHumanOrangeBorder: withAlpha(palette.amber500, 0.2),
      avatarHumanOrangeSurface: withAlpha(palette.amber500, 0.16),
      avatarHumanOrangeText: palette.amber500,
      avatarHumanVioletBorder: withAlpha(palette.indigo500, 0.28),
      avatarHumanVioletSurface: withAlpha(palette.indigo500, 0.2),
      avatarHumanVioletText: palette.blue200,
      borderControl: withAlpha(palette.white, 0.2),
      borderDanger: withAlpha(palette.pink500, 0.32),
      borderDangerStrong: withAlpha(palette.pink500, 0.7),
      borderFieldHover: withAlpha(palette.white, 0.3),
      borderFocus: withAlpha(palette.blue200, 0.7),
      borderInteractive: withAlpha(palette.blue500, 0.4),
      borderOverlay: withAlpha(palette.white, 0.16),
      borderSelected: withAlpha(palette.white, 0.2),
      borderSection: withAlpha(palette.white, 0.14),
      canvasSurface: palette.neutral950,
      codeSurface: palette.black,
      decorativeAccentSurface: palette.blue500,
      fieldFocusGlow: withAlpha(palette.blue500, 0.28),
      fieldPlaceholder: palette.neutral500,
      fieldSurface: palette.neutral950,
      fieldSurfaceRecessed: withAlpha(palette.black, 0.24),
      groupedSurface: palette.neutral990,
      iconAccent: palette.blue200,
      iconAccentSurface: withAlpha(palette.blue500, 0.16),
      iconMuted: palette.neutral400,
      iconPrimary: palette.neutral100,
      iconSecondary: palette.neutral300,
      interactiveHoverSurface: withAlpha(palette.white, 0.07),
      interactivePressedSurface: withAlpha(palette.white, 0.12),
      modalBackdrop: withAlpha(palette.black, 0.56),
      navigationSurface: palette.black,
      overlayBackdrop: withAlpha(palette.black, 0.94),
      overlaySurface: palette.neutral950,
      paneSurface: palette.neutral950,
      sectionSurface: palette.neutral950,
      selectionSurface: palette.neutral700,
      selectionHoverSurface: withAlpha(palette.white, 0.18),
      selectionPressedSurface: withAlpha(palette.white, 0.22),
      separator: withAlpha(palette.white, 0.08),
      shellBackdrop: palette.black,
      shellBackdropHighlight: palette.neutral950,
      sidebarSurface: palette.neutral990,
      statusDangerDivider: withAlpha(palette.pink500, 0.26),
      statusDangerSurface: withAlpha(palette.pink500, 0.12),
      statusDangerText: palette.pink300,
      statusInfoDivider: withAlpha(palette.blue500, 0.28),
      statusInfoSurface: withAlpha(palette.blue500, 0.14),
      statusInfoText: palette.blue200,
      statusNeutral: palette.neutral500,
      statusNeutralSurface: withAlpha(palette.white, 0.08),
      statusNeutralText: palette.neutral300,
      statusPositiveDivider: withAlpha(palette.green500, 0.28),
      statusPositiveSurface: withAlpha(palette.green500, 0.12),
      statusPositiveText: palette.green500,
      statusWarningDivider: withAlpha(palette.amber500, 0.3),
      statusWarningSurface: withAlpha(palette.amber500, 0.12),
      statusWarningText: palette.amber500,
      surfaceMuted: palette.neutral700,
      surfaceSubtle: withAlpha(palette.white, 0.07),
      textLink: palette.blue200,
      textMuted: palette.neutral400,
      textPrimary: palette.neutral100,
    },
    material: {
      ...velaLight.semantic.material,
      composerFill: withAlpha(palette.neutral990, 0.86),
      navigationFill: withAlpha(palette.black, 0.74),
      navigationInactiveFill: withAlpha(palette.black, 0.56),
      sidebarFill: withAlpha(palette.neutral990, 0.82),
    },
  },
} as const;

/** Backward-compatible light-theme name for static assets and test fixtures. */
export const velaTheme = velaLight;

export type VelaTheme = typeof velaLight | typeof velaDark;
