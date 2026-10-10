import { nativeTokens } from "@opencraft/design-system/tokens.native";

/** LightVela mobile brand accents layered over shared OpenCraft native materials. */
export const mobileVisualTokens = {
  color: {
    canvas: nativeTokens.material.canvas,
    surface: nativeTokens.material.content,
    sidebar: nativeTokens.material.sidebar,
    selected: nativeTokens.material.selected,
    accent: "#6326c9",
    accentBright: "#642dcc",
    accentSoft: "#f4f0fb",
    contentCanvas: "#faf9fc",
    text: "#241a30",
    rowText: "#392f43",
    icon: "#544d5c",
    iconBrandMuted: "#6d5785",
    iconClose: "#54445f",
    iconSoft: "#a89cad",
    label: "#8e809f",
    destructiveIcon: "#9c879f",
    separator: "#e9e5ef",
    statusRunning: "#28a879",
    statusPending: "#eda443",
    statusFailed: "#d9636b",
  },
  drawer: { floatingRadius: 34, floatingScale: 0.97 },
  shell: {
    panelTouchTarget: nativeTokens.metrics.toolbar.touchTarget,
    sidebarWidth: nativeTokens.metrics.sidebar.width,
    minimumContentWidth: 480,
    drawerWidthFraction: 0.86,
    drawerMaximumWidth: 340,
    panelMinimumWidth: 560,
    panelMaximumWidth: 680,
    panelInset: nativeTokens.spacing[6],
  },
} as const;
