import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ReactNode } from "react";
import { Platform, View, type StyleProp, type ViewStyle } from "react-native";

/** Native material is an enhancement; unsupported devices retain the same controls. */
export function MobileMaterial({ children, style, backgroundColor }: { children: ReactNode; style?: StyleProp<ViewStyle>; backgroundColor: string }) {
  if (Platform.OS === "ios" && isGlassEffectAPIAvailable() && isLiquidGlassAvailable()) {
    return <GlassView style={style} glassEffectStyle="regular">{children}</GlassView>;
  }
  return <View style={[{ backgroundColor }, style]}>{children}</View>;
}
