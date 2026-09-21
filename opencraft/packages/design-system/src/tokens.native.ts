import {
  codexColorTokens,
  codexGeometryTokens,
  codexTypographyTokens,
  frame,
  radii,
  spacing,
} from "./tokens.shared";
import { nativeTypographyTokens } from "./typography/typography.shared";

// Codex owns semantic color roles; iPad owns density, material and navigation
// geometry. Keeping these layers separate prevents the native app from
// becoming a scaled desktop renderer while preserving one visual vocabulary.
export const ipadMetrics = {
  layout: {
    splitBreakpoint: 1000,
    phoneBreakpoint: 700,
    roomyBreakpoint: 1180,
    canvasInset: 12,
    panelGap: 12,
    surfaceRadius: 22,
  },
  toolbar: { height: 56, touchTarget: 44, projectIcon: 32, statusHeight: 32 },
  sidebar: {
    width: 320,
    horizontalInset: 14,
    largeTitleHeight: 62,
    searchHeight: 38,
    actionHeight: 46,
    sectionHeight: 34,
    threadHeight: 56,
    accountHeight: 54,
    selectionRadius: 12,
    groupSeparatorInset: 52,
    avatar: 34,
  },
  control: { icon: 19, iconSmall: 15, statusDot: 6, activityDot: 7, radius: 12 },
  conversation: {
    maximumWidth: 760,
    horizontalInset: 28,
    topInset: 44,
    bottomInset: 36,
    turnGap: 40,
    userBottomGap: 24,
    userBubbleRadius: 16,
    userBubbleCornerRadius: 16,
    userMaximumWidth: "77%" as const,
    toolHeaderHeight: 46,
    toolActionHeight: 44,
    emptyMinimumHeight: 340,
    emptyMaximumWidth: 480,
    suggestionHeight: 48,
    heroIcon: 24,
    userBubbleVerticalInset: 8,
  },
  composer: {
    maximumWidth: 760,
    radius: 24,
    inputMinimumHeight: 44,
    inputMaximumHeight: 240,
    inputHorizontalInset: 18,
    inputTopInset: 15,
    actionRowHeight: 54,
    actionButton: 40,
    sendButton: 40,
    outerBottomInset: 14,
  },
  details: { width: 360, surfaceRadius: 22, fileRowHeight: 46 },
  interaction: { pressedOpacity: 0.58, disabledOpacity: 0.28 },
} as const;

export const ipadTypography = nativeTypographyTokens;

const ipadMaterial = {
  light: {
    canvas: "#f2f2f7",
    sidebar: "rgba(248, 248, 250, 0.88)",
    content: "#ffffff",
    raised: "rgba(255, 255, 255, 0.92)",
    grouped: "rgba(118, 118, 128, 0.08)",
    selected: "rgba(118, 118, 128, 0.14)",
    separator: "rgba(60, 60, 67, 0.13)",
    scrim: "rgba(0, 0, 0, 0.20)",
  },
  dark: {
    canvas: "#000000",
    sidebar: "rgba(28, 28, 30, 0.88)",
    content: "#1c1c1e",
    raised: "rgba(44, 44, 46, 0.92)",
    grouped: "rgba(118, 118, 128, 0.18)",
    selected: "rgba(118, 118, 128, 0.28)",
    separator: "rgba(84, 84, 88, 0.60)",
    scrim: "rgba(0, 0, 0, 0.42)",
  },
} as const;

const ipadShadow = {
  light: {
    prominent: { color: "#000000", opacity: 0.07, radius: 24, offsetY: 4, elevation: 4 },
    composer: { color: "#000000", opacity: 0.07, radius: 16, offsetY: 5, elevation: 4 },
  },
  dark: {
    prominent: { color: "#000000", opacity: 0.24, radius: 22, offsetY: 5, elevation: 6 },
    composer: { color: "#000000", opacity: 0.28, radius: 18, offsetY: 6, elevation: 7 },
  },
} as const;

export const nativeThemes = {
  light: {
    color: codexColorTokens.light,
    geometry: codexGeometryTokens,
    typography: codexTypographyTokens,
    shadow: ipadShadow.light,
    material: ipadMaterial.light,
    metrics: ipadMetrics,
    platformTypography: ipadTypography,
    spacing,
    radii,
    layout: {
      threadContentMaxWidth: frame.threadContentMaxWidth,
      compactBreakpoint: frame.smallBreakpoint,
      wideBreakpoint: frame.tabletBreakpoint,
      rightPanelBreakpoint: 1240,
      rightPanelDefaultOpenBreakpoint: 1280,
    },
  },
  dark: {
    color: codexColorTokens.dark,
    geometry: codexGeometryTokens,
    typography: codexTypographyTokens,
    shadow: ipadShadow.dark,
    material: ipadMaterial.dark,
    metrics: ipadMetrics,
    platformTypography: ipadTypography,
    spacing,
    radii,
    layout: {
      threadContentMaxWidth: frame.threadContentMaxWidth,
      compactBreakpoint: frame.smallBreakpoint,
      wideBreakpoint: frame.tabletBreakpoint,
      rightPanelBreakpoint: 1240,
      rightPanelDefaultOpenBreakpoint: 1280,
    },
  },
} as const;

export const nativeTokens = {
  ...nativeThemes.light,
  themes: nativeThemes,
} as const;
