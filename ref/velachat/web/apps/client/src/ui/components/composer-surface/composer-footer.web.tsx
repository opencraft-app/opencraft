import type {ViewStyle} from "react-native";

import {ComposerFooterLayout} from "./composer-footer-layout";
import type {ComposerFooterProps} from "./composer-surface.types";

const containerStyle = {
  containerType: "inline-size",
} as ViewStyle;

export function ComposerFooter(props: ComposerFooterProps) {
  return <ComposerFooterLayout {...props} containerStyle={containerStyle} />;
}
