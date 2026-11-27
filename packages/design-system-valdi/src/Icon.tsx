import { Component } from "valdi_core/src/Component";
import { systemSemiboldFont } from "valdi_core/src/SystemFont";

export type IconName =
  | "home"
  | "inbox"
  | "gear"
  | "link"
  | "arrowLeft"
  | "chevronLeft"
  | "chevronRight"
  | "chevronUp"
  | "check"
  | "info"
  | "warning"
  | "close"
  | "sparkle"
  | "plus"
  | "minus"
  | "external"
  | "sunDim"
  | "sunMax"
  | "toggle"
  | "slider"
  | "segmented"
  | "textfield"
  | "tabbar"
  | "pagecontrol"
  | "list"
  | "sheet"
  | "server"
  | "laptop"
  | "terminal"
  | "copy"
  | "grid"
  | "search"
  | "bot"
  | "gauge"
  | "chevronDown"
  | "refresh"
  | "user"
  | "chat"
  | "bell"
  | "puzzle"
  | "key"
  | "lock";

type Props = {
  name: IconName;
  size?: number;
  color: string;
};

const paths: Record<IconName, string> = {
  home: '<path d="M4.5 10.5 10.3 5.3a2.6 2.6 0 0 1 3.4 0l5.8 5.2v7a2.5 2.5 0 0 1-2.5 2.5h-3v-6h-4v6H7a2.5 2.5 0 0 1-2.5-2.5v-7Z" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>',
  inbox:
    '<rect x="4" y="5" width="16" height="14" rx="2.75" stroke="black" stroke-width="1.65"/><path d="M4.5 7.5 12 13l7.5-5.5" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>',
  gear: '<path d="M8.93 5.58 Q9.21 5.42 9.34 5.01 L9.82 3.54 Q9.95 3.13 10.69 3.13 L13.31 3.13 Q14.05 3.13 14.18 3.54 L14.66 5.01 Q14.79 5.42 15.07 5.58 L16.03 6.13 Q16.30 6.29 16.73 6.20 L18.23 5.88 Q18.66 5.79 19.02 6.43 L20.33 8.70 Q20.70 9.34 20.41 9.66 L19.39 10.81 Q19.10 11.13 19.10 11.44 L19.10 12.56 Q19.10 12.87 19.39 13.19 L20.41 14.34 Q20.70 14.66 20.33 15.30 L19.02 17.57 Q18.66 18.21 18.23 18.12 L16.73 17.80 Q16.30 17.71 16.03 17.87 L15.07 18.42 Q14.79 18.58 14.66 18.99 L14.18 20.46 Q14.05 20.87 13.31 20.87 L10.69 20.87 Q9.95 20.87 9.82 20.46 L9.34 18.99 Q9.21 18.58 8.93 18.42 L7.97 17.87 Q7.70 17.71 7.27 17.80 L5.77 18.12 Q5.34 18.21 4.98 17.57 L3.67 15.30 Q3.30 14.66 3.59 14.34 L4.61 13.19 Q4.90 12.87 4.90 12.56 L4.90 11.44 Q4.90 11.13 4.61 10.81 L3.59 9.66 Q3.30 9.34 3.67 8.70 L4.98 6.43 Q5.34 5.79 5.77 5.88 L7.27 6.20 Q7.70 6.29 7.97 6.13Z" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.1" stroke="black" stroke-width="1.5"/>',
  link: '<path d="m9.5 8 2.5-2.5a4.25 4.25 0 0 1 6 6L15.5 14M8.5 10 6 12.5a4.25 4.25 0 0 0 6 6l2.5-2.5M9 15l6-6" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>',
  arrowLeft:
    '<path d="M19.5 12h-15m5-5-5 5 5 5" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  chevronLeft:
    '<path d="m15 6-6 6 6 6" stroke="black" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>',
  chevronRight:
    '<path d="m9 6 6 6-6 6" stroke="black" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>',
  chevronUp:
    '<path d="m6 15 6-6 6 6" stroke="black" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>',
  check:
    '<path d="m5 12 4.5 4.5L19 7" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  info: '<circle cx="12" cy="12" r="8" stroke="black" stroke-width="1.65"/><path d="M10.5 11H12v5.5m-1.5 0h3" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="7.5" r="0.8" fill="black"/>',
  warning:
    '<path d="m10.2 5-7 12a2.1 2.1 0 0 0 1.8 3h14a2.1 2.1 0 0 0 1.8-3l-7-12a2.1 2.1 0 0 0-3.6 0Z" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 9v4.5" stroke="black" stroke-width="1.65" stroke-linecap="round"/><circle cx="12" cy="17" r="0.8" fill="black"/>',
  close:
    '<path d="m6 6 12 12M6 18 18 6" stroke="black" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>',
  sparkle:
    '<path d="m11 4 2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6ZM19 3.5v4m-2-2h4" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="black" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>',
  minus: '<path d="M5 12h14" stroke="black" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>',
  external:
    '<path d="M10.5 4.5h-3a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3v-3M13.5 4.5h6v6m0-6L10 14" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>',
  sunDim:
    '<circle cx="12" cy="12" r="3.5" stroke="black" stroke-width="1.65"/><path d="M12 4.5v1.2m0 12.6v1.2M4.5 12h1.2m12.6 0h1.2M6.7 6.7l.8.8m9 9 .8.8m-10.6 0 .8-.8m9-9 .8-.8" stroke="black" stroke-width="1.65" stroke-linecap="round"/>',
  sunMax:
    '<circle cx="12" cy="12" r="4" stroke="black" stroke-width="1.65"/><path d="M12 2.75v2.25m0 14v2.25M2.75 12H5m14 0h2.25M5.45 5.45l1.6 1.6m9.9 9.9 1.6 1.6m-13.1 0 1.6-1.6m9.9-9.9 1.6-1.6" stroke="black" stroke-width="1.65" stroke-linecap="round"/>',
  toggle:
    '<rect x="3.5" y="7" width="17" height="10" rx="5" stroke="black" stroke-width="1.65"/><circle cx="15.5" cy="12" r="2.8" fill="black"/>',
  slider:
    '<path d="M4.5 7.5h3m4 0h8M4.5 16.5h8m4 0h3" stroke="black" stroke-width="1.65" stroke-linecap="round"/><circle cx="9.5" cy="7.5" r="2" stroke="black" stroke-width="1.65"/><circle cx="14.5" cy="16.5" r="2" stroke="black" stroke-width="1.65"/>',
  segmented:
    '<rect x="3.5" y="7" width="17" height="10" rx="4" stroke="black" stroke-width="1.65"/><rect x="5.2" y="8.7" width="7.6" height="6.6" rx="2.5" fill="black"/>',
  textfield:
    '<rect x="3.5" y="6" width="17" height="12" rx="3" stroke="black" stroke-width="1.65"/><path d="M7.5 9.5v5" stroke="black" stroke-width="1.65" stroke-linecap="round"/>',
  tabbar:
    '<rect x="3.5" y="12.5" width="17" height="6.5" rx="3" stroke="black" stroke-width="1.65"/><circle cx="8" cy="15.75" r="1.1" fill="black"/><circle cx="12" cy="15.75" r="1.1" fill="black"/><circle cx="16" cy="15.75" r="1.1" fill="black"/>',
  pagecontrol:
    '<circle cx="6.5" cy="12" r="1.7" fill="black"/><circle cx="12" cy="12" r="1.7" fill="black" opacity="0.4"/><circle cx="17.5" cy="12" r="1.7" fill="black" opacity="0.4"/>',
  list: '<path d="M8.5 6h11M8.5 12h11M8.5 18h11M4.5 6h.1M4.5 12h.1M4.5 18h.1" stroke="black" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>',
  sheet:
    '<rect x="4" y="4.5" width="16" height="15" rx="3" stroke="black" stroke-width="1.65"/><path d="M4 13.5h16" stroke="black" stroke-width="1.65"/>',
  server:
    '<rect x="4.5" y="4.5" width="15" height="6" rx="2" stroke="black" stroke-width="1.65"/><rect x="4.5" y="13.5" width="15" height="6" rx="2" stroke="black" stroke-width="1.65"/><path d="M12 7.5h4m-4 9h4" stroke="black" stroke-width="1.65" stroke-linecap="round"/><circle cx="8" cy="7.5" r="0.8" fill="black"/><circle cx="8" cy="16.5" r="0.8" fill="black"/>',
  laptop:
    '<path d="M5.5 15V6.5A2.5 2.5 0 0 1 8 4h8a2.5 2.5 0 0 1 2.5 2.5V15M4.5 15h15l1 2.5a1.8 1.8 0 0 1-1.7 2.5H5.2a1.8 1.8 0 0 1-1.7-2.5l1-2.5ZM10 17.5h4" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>',
  terminal:
    '<path d="M7.75 4.75h8.5A4.25 4.25 0 0 1 20.5 9v6a4.25 4.25 0 0 1-4.25 4.25h-8.5A4.25 4.25 0 0 1 3.5 15V9a4.25 4.25 0 0 1 4.25-4.25Z" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/><path d="m7.8 9.1 3 2.9-3 2.9M13.6 14.9h2.9" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.75" stroke="black" stroke-width="1.65"/><path d="M15 4H7a3 3 0 0 0-3 3v8" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>',
  grid: '<rect x="4.5" y="4.5" width="6" height="6" rx="1.75" stroke="black" stroke-width="1.65"/><rect x="13.5" y="4.5" width="6" height="6" rx="1.75" stroke="black" stroke-width="1.65"/><rect x="4.5" y="13.5" width="6" height="6" rx="1.75" stroke="black" stroke-width="1.65"/><rect x="13.5" y="13.5" width="6" height="6" rx="1.75" stroke="black" stroke-width="1.65"/>',
  search:
    '<path d="M17.5 10.75a6.75 6.75 0 1 1-13.5 0 6.75 6.75 0 0 1 13.5 0ZM15.5 15.5l5 5" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>',
  bot: '<rect x="4" y="6.5" width="16" height="13" rx="3" stroke="black" stroke-width="1.65"/><path d="M12 3.5v3M9.5 15.5h5" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8.5" cy="11.5" r="0.9" fill="black"/><circle cx="15.5" cy="11.5" r="0.9" fill="black"/>',
  gauge:
    '<path d="M4.5 16.5a7.5 7.5 0 0 1 15 0M12 16.5l3.4-4.3" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>',
  chevronDown:
    '<path d="m6 9 6 6 6-6" stroke="black" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>',
  refresh:
    '<path d="M19 8a8 8 0 0 0-13-2M5 4.5V9h4.5M5 16a8 8 0 0 0 13 2M19 19.5V15h-4.5" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>',
  user: '<circle cx="12" cy="7.5" r="3" stroke="black" stroke-width="1.65"/><path d="M5.5 20v-1a6.5 6.5 0 0 1 13 0v1" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>',
  chat: '<path d="M7.5 18.6 4 20l1.2-4a8 8 0 1 1 2.3 2.6Z" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>',
  bell: '<path d="M7 10a5 5 0 0 1 10 0c0 5 2 5.5 2 7H5c0-1.5 2-2 2-7Zm3 10h4M12 3.5V5" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>',
  puzzle:
    '<rect x="4.5" y="10.5" width="6" height="9" rx="1.75" stroke="black" stroke-width="1.65"/><rect x="4.5" y="4.5" width="6" height="3" rx="1.25" stroke="black" stroke-width="1.65"/><rect x="13.5" y="4.5" width="6" height="9" rx="1.75" stroke="black" stroke-width="1.65"/><rect x="13.5" y="16.5" width="6" height="3" rx="1.25" stroke="black" stroke-width="1.65"/>',
  key: '<circle cx="8" cy="15" r="4.25" stroke="black" stroke-width="1.65"/><path d="M11.1 11.9 19.5 3.5m-2.5 2.5 2.5 2.5M14.5 8.5l2 2" stroke="black" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>',
  lock: '<rect x="5.25" y="10.5" width="13.5" height="9.25" rx="2.75" stroke="black" stroke-width="1.65"/><path d="M8.25 10.5V7.75a3.75 3.75 0 0 1 7.5 0v2.75" stroke="black" stroke-width="1.65" stroke-linecap="round"/>',
};

function svgUri(name: IconName): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">${paths[name]}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const nativeGlyphs: Record<string, string> = {
  home: "\u2302",
  inbox: "\u2709\uFE0E",
  gear: "\u2699\uFE0E",
  link: "\u29C9",
  arrowLeft: "\u2190",
  chevronLeft: "\u2039",
  chevronRight: "\u203A",
  chevronUp: "\u2303",
  check: "\u2713",
  info: "\u24D8",
  warning: "!",
  close: "\u2715",
  sparkle: "\u2726",
  plus: "+",
  minus: "-",
  external: "\u2197",
  sunDim: "\u25D0",
  sunMax: "\u2600\uFE0E",
  server: "\u2630",
  laptop: "\u2328",
  terminal: ">_",
  copy: "\u29C9",
  grid: "\u229E",
  search: "\u2315",
  bot: "\u25C9",
  gauge: "\u25D4",
  chevronDown: "\u2304",
  refresh: "\u21BB",
  user: "\u25CB",
  chat: "\u25EF",
  bell: "\u237E",
  puzzle: "\u2756",
  key: "\u26BF",
  lock: "\u29BF",
};

const isWeb = typeof (globalThis as { document?: unknown }).document !== "undefined";

function renderNativeVector(name: IconName, size: number, color: string): boolean {
  if (name === "minus") {
    <view width={size} height={size} alignItems="center" justifyContent="center" accessibilityNavigation="ignored">
      <view width={Math.max(8, Math.round(size * 0.62))} height={2} borderRadius={1} backgroundColor={color} />
    </view>;
    return true;
  }
  if (name === "plus") {
    const bar = Math.max(8, Math.round(size * 0.62));
    <view width={size} height={size} alignItems="center" justifyContent="center" accessibilityNavigation="ignored">
      <view width={bar} height={2} borderRadius={1} backgroundColor={color} />
      <view position="absolute" width={2} height={bar} borderRadius={1} backgroundColor={color} />
    </view>;
    return true;
  }
  if (name === "link") {
    const ringW = Math.max(9, Math.round(size * 0.54));
    const ringH = Math.max(6, Math.round(size * 0.36));
    <view width={size} height={size} alignItems="center" justifyContent="center" accessibilityNavigation="ignored">
      <view
        position="absolute"
        left={Math.round(size * 0.14)}
        width={ringW}
        height={ringH}
        borderRadius={99}
        borderWidth={1.8}
        borderColor={color}
      />
      <view
        position="absolute"
        right={Math.round(size * 0.14)}
        width={ringW}
        height={ringH}
        borderRadius={99}
        borderWidth={1.8}
        borderColor={color}
      />
    </view>;
    return true;
  }
  if (name === "toggle") {
    <view
      width={size}
      height={Math.round(size * 0.6)}
      borderRadius={99}
      borderWidth={1.6}
      borderColor={color}
      paddingLeft={2}
      paddingRight={2}
      justifyContent="center"
      alignItems="flex-end"
      accessibilityNavigation="ignored"
    >
      <view
        width={Math.max(5, Math.round(size * 0.34))}
        height={Math.max(5, Math.round(size * 0.34))}
        borderRadius={99}
        backgroundColor={color}
      />
    </view>;
    return true;
  }
  if (name === "slider") {
    <view width={size} height={size} justifyContent="center" accessibilityNavigation="ignored">
      <view width="100%" height={2} borderRadius={1} backgroundColor={color} opacity={0.45} />
      <view
        position="absolute"
        left={Math.round(size * 0.48)}
        width={Math.max(6, Math.round(size * 0.36))}
        height={Math.max(6, Math.round(size * 0.36))}
        borderRadius={99}
        backgroundColor={color}
      />
    </view>;
    return true;
  }
  if (name === "segmented") {
    <view
      width={size}
      height={Math.round(size * 0.62)}
      borderRadius={5}
      borderWidth={1.5}
      borderColor={color}
      padding={2}
      flexDirection="row"
      alignItems="center"
      gap={2}
      accessibilityNavigation="ignored"
    >
      <view width="46%" height="100%" borderRadius={3} backgroundColor={color} />
      <view width={1} height="65%" backgroundColor={color} opacity={0.45} />
    </view>;
    return true;
  }
  if (name === "textfield") {
    <view
      width={size}
      height={Math.round(size * 0.7)}
      borderRadius={4}
      borderWidth={1.5}
      borderColor={color}
      paddingLeft={4}
      justifyContent="center"
      accessibilityNavigation="ignored"
    >
      <view width={1.6} height={Math.max(6, Math.round(size * 0.34))} backgroundColor={color} />
    </view>;
    return true;
  }
  if (name === "tabbar") {
    <view
      width={size}
      height={Math.round(size * 0.48)}
      borderRadius={99}
      borderWidth={1.5}
      borderColor={color}
      flexDirection="row"
      alignItems="center"
      justifyContent="space-around"
      paddingLeft={2}
      paddingRight={2}
      accessibilityNavigation="ignored"
    >
      <view width={3} height={3} borderRadius={2} backgroundColor={color} />
      <view width={3} height={3} borderRadius={2} backgroundColor={color} opacity={0.55} />
      <view width={3} height={3} borderRadius={2} backgroundColor={color} opacity={0.55} />
    </view>;
    return true;
  }
  if (name === "pagecontrol") {
    <view
      width={size}
      height={size}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      gap={3}
      accessibilityNavigation="ignored"
    >
      <view width={4} height={4} borderRadius={2} backgroundColor={color} />
      <view width={4} height={4} borderRadius={2} backgroundColor={color} opacity={0.4} />
      <view width={4} height={4} borderRadius={2} backgroundColor={color} opacity={0.4} />
    </view>;
    return true;
  }
  if (name === "list") {
    <view width={size} height={size} justifyContent="center" gap={3} accessibilityNavigation="ignored">
      <view width="100%" height={1.8} borderRadius={1} backgroundColor={color} />
      <view width="100%" height={1.8} borderRadius={1} backgroundColor={color} />
      <view width="70%" height={1.8} borderRadius={1} backgroundColor={color} />
    </view>;
    return true;
  }
  if (name === "sheet") {
    <view
      width={Math.round(size * 0.84)}
      height={Math.round(size * 0.84)}
      borderRadius={4}
      borderWidth={1.5}
      borderColor={color}
      justifyContent="flex-end"
      accessibilityNavigation="ignored"
    >
      <view width="100%" height={1.4} backgroundColor={color} marginBottom={4} />
    </view>;
    return true;
  }
  return false;
}

/** Cross-platform SF-Symbol-proportioned vector icon for Valdi surfaces. */
export class Icon extends Component<Props> {
  onRender(): void {
    const { name, size = 22, color } = this.viewModel;
    if (isWeb) {
      <image
        src={svgUri(name)}
        width={size}
        height={size}
        objectFit="contain"
        tint={color}
        accessibilityNavigation="ignored"
      />;
      return;
    }
    if (renderNativeVector(name, size, color)) return;
    <view width={size} height={size} alignItems="center" justifyContent="center" accessibilityNavigation="ignored">
      <label
        value={nativeGlyphs[name] ?? "\u2022"}
        font={systemSemiboldFont(Math.max(12, Math.round(size * 0.85)))}
        color={color}
        textAlign="center"
      />
    </view>;
  }
}
