// prevents Metro from resolving this module back to `tokens.native.ts`.
import {
  opencraftTypographyTokens,
  typographyRegistry,
} from "./typography/typography.shared";

export { opencraftTypographyTokens } from "./typography/typography.shared";
export const spacing = {
  unit: 4,
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
} as const;

export const radii = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 10,
  xl: 12,
  xxl: 16,
  full: 9999,
} as const;

/**
 * Cross-platform menu geometry. The platform overlay owns collision and
 * placement mechanics; product surfaces only choose an anchor alignment.
 */
export const menuGeometry = {
  collisionPadding: 6,
  rootSideOffset: 6,
  submenuSideOffset: 4,
  surfacePadding: 5,
  itemGap: 2,
  itemRadius: radii.md,
  boundedMinimumWidth: 200,
  boundedMaximumWidth: 320,
  listMaximumHeight: 250,
} as const;

/** Active Workbench text: a one-way sweep followed by a brief readable rest. */
export const workingShimmerMotion = {
  firstSweepDelayMs: 600,
  sweepDurationMs: 1_000,
  cycleMs: 1_500,
} as const;

const sidebarListDefaultWidth = 275;
const sidebarListMinimumWidth = 240;
// 44px targets retain about 8px breathing room on either side.
const sidebarIconRailWidth = 60;

export const frame = {
  applicationMenuHeight: 36,
  toolbarHeight: 46,
  paneToolbarHeight: 40,
  sidebarDefaultWidth: sidebarListDefaultWidth,
  sidebarIconRailWidth,
  sidebarUnifiedDefaultWidth: sidebarListDefaultWidth + sidebarIconRailWidth,
  sidebarUnifiedMinWidth: sidebarListMinimumWidth + sidebarIconRailWidth,
  sidebarMinWidth: sidebarListMinimumWidth,
  sidebarMaxWidth: 520,
  /** Mobile drawer keeps full-size controls in a narrower reading column. */
  sidebarMobileWidthRatio: 0.90,
  rightPanelDefaultWidth: 600,
  rightPanelMinWidth: 320,
  rightPanelMaxWidth: 640,
  tabletBreakpoint: 960,
  smallBreakpoint: 720,
  threadContentMaxWidth: 768,
} as const;

/**
 * Platform-neutral typography semantics. Web owns concrete fallback stacks
 * in tokens.web.scss; native uses the platform system face unless a product
 * explicitly loads an equivalent font. Keeping only canonical weights here
 * prevents PingFang, Inter, and Android fallbacks from remapping ad-hoc values.
 */
export const typography = Object.freeze({
  weight: opencraftTypographyTokens.weight,
  tracking: typographyRegistry.tracking,
});

export const lightPalette = {
  backgroundUnder: "#f9f9f9",
  surface: "#ffffff",
  editor: "rgba(237, 237, 237, 0.40)",
  elevated: "rgba(255, 255, 255, 0.96)",
  foreground: "#1a1c1f",
  foregroundSecondary: "rgba(26, 28, 31, 0.70)",
  foregroundTertiary: "rgba(26, 28, 31, 0.50)",
  blue: "#339cff",
  green: "#00a240",
  red: "#e02e2a",
  orange: "#e25507",
} as const;

export const darkPalette = {
  backgroundUnder: "#000000",
  surface: "#181818",
  editor: "#212121",
  elevated: "rgba(33, 33, 33, 0.96)",
  foreground: "#dfdfdf",
  foregroundSecondary: "rgba(255, 255, 255, 0.70)",
  foregroundTertiary: "#8f8f8f",
  blue: "#0285ff",
  green: "#40c977",
  red: "#ff6764",
  orange: "#ff9e6c",
} as const;

export const opencraftDesignTokens = {
  spacing,
  radii,
  typography,
  menu: menuGeometry,
  frame,
  themes: { light: lightPalette, dark: darkPalette },
} as const;

export const grayScale = {
  0: "#ffffff",
  50: "#f9f9f9",
  75: "#f3f3f3",
  100: "#ededed",
  150: "#dfdfdf",
  200: "#cdcdcd",
  300: "#afafaf",
  400: "#8f8f8f",
  500: "#5d5d5d",
  550: "#4f4f4f",
  600: "#414141",
  650: "#393939",
  700: "#303030",
  750: "#282828",
  800: "#212121",
  900: "#181818",
  950: "#131313",
  1000: "#0d0d0d",
} as const;

const lightInk = "26, 28, 31";
const darkInk = "255, 255, 255";

const lightAlpha = {
  2: `rgba(${lightInk}, 0.02)`,
  4: `rgba(${lightInk}, 0.04)`,
  5: `rgba(${lightInk}, 0.05)`,
  6: `rgba(${lightInk}, 0.06)`,
  8: `rgba(${lightInk}, 0.08)`,
  10: `rgba(${lightInk}, 0.10)`,
  12: `rgba(${lightInk}, 0.12)`,
  16: `rgba(${lightInk}, 0.16)`,
  18: `rgba(${lightInk}, 0.18)`,
  20: `rgba(${lightInk}, 0.20)`,
  50: `rgba(${lightInk}, 0.50)`,
  70: `rgba(${lightInk}, 0.70)`,
} as const;

const darkAlpha = {
  2: `rgba(${darkInk}, 0.02)`,
  4: `rgba(${darkInk}, 0.04)`,
  5: `rgba(${darkInk}, 0.05)`,
  6: `rgba(${darkInk}, 0.06)`,
  8: `rgba(${darkInk}, 0.08)`,
  10: `rgba(${darkInk}, 0.10)`,
  12: `rgba(${darkInk}, 0.12)`,
  16: `rgba(${darkInk}, 0.16)`,
  18: `rgba(${darkInk}, 0.18)`,
  20: `rgba(${darkInk}, 0.20)`,
  50: `rgba(${darkInk}, 0.50)`,
  70: `rgba(${darkInk}, 0.70)`,
} as const;

// Semantic values mirror tokens.web.scss. Renderers consume these roles rather
// than rebuilding opacity, hierarchy, or state colors inside components.
export const opencraftColorTokens = {
  light: {
    accent: {
      blue: "#339cff",
      purple: "#924ff7",
      positive: "#00a240",
      negative: "#ba2623",
      warning: "#e25507",
      focusRing: "rgba(51, 156, 255, 0.42)",
    },
    chrome: { close: "#ff5f57", minimize: "#febc2e", expand: "#28c840" },
    text: {
      primary: "#1a1c1f",
      secondary: lightAlpha[70],
      tertiary: lightAlpha[50],
      workingHighlight: "#1a1c1f",
      onAccent: grayScale[0],
    },
    icon: {
      primary: "#1a1c1f",
      secondary: lightAlpha[70],
      tertiary: lightAlpha[50],
    },
    surface: {
      under: grayScale[50],
      sidebar: grayScale[50],
      main: grayScale[0],
      raised: grayScale[0],
      popover: "rgba(255, 255, 255, 0.96)",
      subtle: `rgba(${lightInk}, 0.025)`,
      code: `rgba(${lightInk}, 0.05)`,
      composer: grayScale[75],
      messageUser: lightAlpha[6],
      segmentActive: grayScale[0],
    },
    border: {
      soft: lightAlpha[4],
      subtle: lightAlpha[5],
      default: lightAlpha[8],
      strong: lightAlpha[12],
    },
    button: {
      tertiary: "transparent",
      tertiaryHover: lightAlpha[8],
      tertiaryActive: lightAlpha[16],
      secondary: lightAlpha[6],
      secondaryHover: lightAlpha[10],
      primary: grayScale[1000],
      primaryHover: grayScale[900],
      primaryForeground: grayScale[0],
      inactive: lightAlpha[18],
    },
    alpha: lightAlpha,
  },
  dark: {
    accent: {
      blue: "#339cff",
      purple: "#ad7bf9",
      positive: "#40c977",
      negative: "#fa423e",
      warning: "#ff8549",
      focusRing: "rgba(51, 156, 255, 0.42)",
    },
    chrome: { close: "#ff5f57", minimize: "#febc2e", expand: "#28c840" },
    text: {
      primary: grayScale[150],
      secondary: darkAlpha[70],
      tertiary: darkAlpha[50],
      workingHighlight: grayScale[0],
      onAccent: grayScale[1000],
    },
    icon: {
      primary: grayScale[150],
      secondary: darkAlpha[70],
      tertiary: darkAlpha[50],
    },
    surface: {
      under: "#000000",
      sidebar: "#000000",
      main: grayScale[900],
      raised: grayScale[800],
      popover: "rgba(33, 33, 33, 0.96)",
      subtle: `rgba(${darkInk}, 0.03)`,
      code: "rgba(0, 0, 0, 0.12)",
      composer: grayScale[800],
      messageUser: grayScale[700],
      segmentActive: grayScale[650],
    },
    border: {
      soft: darkAlpha[4],
      subtle: darkAlpha[5],
      default: darkAlpha[8],
      strong: darkAlpha[16],
    },
    button: {
      tertiary: darkAlpha[2],
      tertiaryHover: darkAlpha[6],
      tertiaryActive: darkAlpha[10],
      secondary: darkAlpha[6],
      secondaryHover: darkAlpha[10],
      primary: grayScale[0],
      primaryHover: grayScale[100],
      primaryForeground: grayScale[1000],
      inactive: darkAlpha[18],
    },
    alpha: darkAlpha,
  },
} as const;

export const opencraftGeometryTokens = {
  header: {
    titleMaximumWidth: 420,
    contextInlineGap: 7,
    outerRightInset: 10,
    windowLeadingInset: 13,
  },
  toolbar: {
    applicationMenu: frame.applicationMenuHeight,
    primary: frame.toolbarHeight,
    pane: frame.paneToolbarHeight,
    controlHeight: 32,
    controlRadius: radii.lg,
    controlInlinePadding: spacing[2],
    controlContentGap: 6,
    controlIconSize: 13,
    controlChevronSize: 10,
    controlMaximumWidth: 224,
  },
  sidebar: {
    preferredWidth: frame.sidebarDefaultWidth,
    minimumWidth: frame.sidebarMinWidth,
    maximumWidth: frame.sidebarMaxWidth,
    horizontalInset: spacing[2],
    modeHeaderHeight: 40,
    modeControlHeight: 32,
    actionHeight: 31,
    sectionHeaderHeight: 26,
    threadMinHeight: 38,
    accountHeight: 39,
  },
  rightPanel: {
    preferredWidth: frame.rightPanelDefaultWidth,
    minimumWidth: frame.rightPanelMinWidth,
    maximumWidth: frame.rightPanelMaxWidth,
    fileRowHeight: 36,
  },
  control: {
    chrome: 28,
    button: 30,
    buttonCompact: 28,
    filterHeight: 36,
    filterWidth: 160,
    radius: 7,
    projectIcon: 24,
    status: 24,
    activityDot: 6,
    statusDot: 5,
    trafficLight: 12,
    iconSmall: 13,
    icon: 15,
  },
  menu: {
    itemHeight: 28,
    itemBlockPadding: 5,
  },
  conversation: {
    maximumWidth: frame.threadContentMaxWidth,
    horizontalInset: spacing[6],
    topInset: spacing[8],
    bottomInset: 52,
    turnGap: 36,
    userBottomGap: spacing[6],
    userBubbleRadius: 16,
    userBubbleCornerRadius: 16,
    userMaximumWidth: "77%" as const,
    toolHeaderHeight: 38,
    toolActionHeight: 34,
    emptyMinimumHeight: 280,
    emptyMaximumWidth: 360,
  },
  composer: {
    radius: radii.xxl,
    inputMinimumHeight: 26,
    inputMaximumHeight: 232,
    inputHorizontalInset: 13,
    inputTopInset: 11,
    actionRowHeight: 38,
    sendButton: 28,
  },
  threadPicker: { maximumChipWidth: 210 },
  interaction: {
    pressedOpacity: 0.62,
    disabledOpacity: 0.24,
  },
} as const;

export const opencraftShadowTokens = {
  light: {
    prominent: { color: "#000000", opacity: 0.05, radius: 20, offsetY: 0, elevation: 3 },
    composer: { color: "#000000", opacity: 0.12, radius: 10, offsetY: 4, elevation: 5 },
  },
  dark: {
    prominent: { color: "#000000", opacity: 0.08, radius: 20, offsetY: 0, elevation: 4 },
    composer: { color: "#000000", opacity: 0.24, radius: 11, offsetY: 4, elevation: 6 },
  },
} as const;

/** Artwork scale is a product choice, separate from color and typography. */
export const workbenchIconMetrics = {
  // Shared action artwork and outline navigation use one readable stroke.
  core: { stroke: 2, navigation: 14, settings: 16, panel: 14, work: 15, chrome: 16 },
  classic: { stroke: 2, navigation: 15, settings: 16, panel: 14, work: 15, chrome: 16 },
  navigation: { stroke: 2, selectedStroke: 2.5 },
  coreNavigation: { stroke: 2 },
} as const;
