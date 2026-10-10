import { Button } from "heroui-native";
import { StyleSheet } from "react-native";
import Svg, { G, Path } from "react-native-svg";
import { nativeTokens } from "@opencraft/design-system/tokens.native";
import { sidebarToggleGlyphs } from "@opencraft/design-system/sidebar-toggle-glyphs";
import { mobileVisualTokens } from "../runtime/mobile-visual-tokens";

/** Desktop glyphs in a native SVG; optical size and touch capacity are distinct. */
export function MobileShellPanelButton({ side, open, label, onPress }: {
  side: "left" | "right"; open: boolean; label: string; onPress: () => void;
}) {
  return <Button variant="ghost" isIconOnly style={styles.button}
    accessibilityLabel={label} accessibilityState={{ expanded: open }} aria-expanded={open} onPress={onPress}>
    <Svg width={sidebarToggleGlyphs.size} height={sidebarToggleGlyphs.size} viewBox={sidebarToggleGlyphs.viewBox}>
      <G transform={side === "right" ? "rotate(180 10 10)" : undefined}>
        <Path key={open ? "visible" : "hidden"} d={open ? sidebarToggleGlyphs.visible : sidebarToggleGlyphs.hidden} fill={mobileVisualTokens.color.icon} />
      </G>
    </Svg>
  </Button>;
}

const styles = StyleSheet.create({
  button: {
    width: nativeTokens.metrics.toolbar.touchTarget,
    minWidth: nativeTokens.metrics.toolbar.touchTarget,
    height: nativeTokens.metrics.toolbar.touchTarget,
    backgroundColor: "transparent",
  },
});
